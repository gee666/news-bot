import { z } from 'zod';
import { db, transaction } from '../db.js';
import { publicationSnapshotSchema } from '../types.js';
import { renderPublication } from './render.js';
import { contentFingerprint, readMessageFingerprint } from './reconciliation.js';
import type { RenderedMessage } from './render.js';
import type { Publication } from './store.js';

const metadataSchema = z.object({
  snapshotId:z.uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),
});
interface EditAttempt { id: string; status: string; response_metadata: unknown; next_retry_at: Date | null }
interface AttemptedSnapshot { content: unknown; story_id: string | null; publication_story_id: string | null; canonical_story_id: string | null }
const attemptsQuery = `SELECT id,status,response_metadata,next_retry_at FROM request_attempts
  WHERE publication_id=$1 AND provider='telegram-bot' AND operation='edit' AND status IN ('running','unknown')
  ORDER BY dispatched_at DESC,id DESC LIMIT 2`;
const snapshotQuery = `SELECT snap.content,snap.story_id,p.story_id AS publication_story_id,
  coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) AS canonical_story_id
  FROM publication_snapshots snap JOIN publications p ON p.id=$2
  LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
  LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id WHERE snap.id=$1`;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const fingerprint = (message: RenderedMessage): string => contentFingerprint(message.plainText,message.links);
const ready = (attempt: EditAttempt): boolean => attempt.status === 'unknown' && (!attempt.next_retry_at || attempt.next_retry_at <= new Date());
function ownedSnapshot(snapshot: AttemptedSnapshot, publication: Publication, id: string): boolean {
  if (snapshot.story_id === null) return snapshot.publication_story_id === null && snapshot.canonical_story_id === null
    && (id === publication.snapshot_id || id === publication.pending_snapshot_id);
  return snapshot.story_id === snapshot.publication_story_id || snapshot.story_id === snapshot.canonical_story_id;
}
async function ordinaryMessage(publication: Publication, expected: string): Promise<RenderedMessage | null> {
  try {
    const message = renderPublication(publication);
    return fingerprint(message) === expected ? message : null;
  } catch { return null; }
}

/** null means no ambiguous delivery exists. Reconciliation observes one recorded request; it never sends. */
export async function reconcileUnknownEdit(publication: Publication,
  reader: (publication: Publication) => Promise<string | null> = readMessageFingerprint): Promise<boolean | null> {
  const rows = (await db.query<EditAttempt>(attemptsQuery,[publication.id])).rows;
  if (!rows.length) return null;
  const attempt = rows[0];
  if (rows.length !== 1 || !attempt || !ready(attempt) || publication.status !== 'published' || !publication.message_id) return false;
  const parsed = metadataSchema.safeParse(attempt.response_metadata);
  if (!parsed.success) return false;
  const metadata = parsed.data;
  const snapshot = (await db.query<AttemptedSnapshot>(snapshotQuery,[metadata.snapshotId,publication.id])).rows[0];
  if (!snapshot || !ownedSnapshot(snapshot,publication,metadata.snapshotId) || !publicationSnapshotSchema.safeParse(snapshot.content).success) return false;
  const attemptedPublication = { ...publication,content:snapshot.content };
  const message = await ordinaryMessage(attemptedPublication,metadata.fingerprint);
  if (!message) return false;
  let observed: string | null;
  try { observed = await reader(publication); } catch { return false; }
  if (observed !== metadata.fingerprint) return false;
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const current = (await client.query<Publication>('SELECT * FROM publications WHERE id=$1 FOR UPDATE',[publication.id])).rows[0];
    if (!current || current.status !== 'published' || current.message_id !== publication.message_id
      || current.destination_id !== publication.destination_id || current.bot_id !== publication.bot_id || current.story_id !== publication.story_id
      || current.delivery_kind !== publication.delivery_kind || current.media_snapshot_id !== publication.media_snapshot_id
      || current.snapshot_id !== publication.snapshot_id || current.pending_snapshot_id !== publication.pending_snapshot_id) return false;
    const locked = (await client.query<EditAttempt>(attemptsQuery+' FOR UPDATE',[publication.id])).rows;
    if (locked.length !== 1 || locked[0]?.id !== attempt.id || !ready(locked[0]) || !same(locked[0].response_metadata,attempt.response_metadata)) return false;
    const frozen = (await client.query<AttemptedSnapshot>(snapshotQuery+' FOR SHARE OF snap',[metadata.snapshotId,publication.id])).rows[0];
    if (!frozen || !ownedSnapshot(frozen,current,metadata.snapshotId) || !publicationSnapshotSchema.safeParse(frozen.content).success
      || !same(frozen.content,snapshot.content)) return false;
    const changed = await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata||'{"reconciled":true,"previousStatus":"unknown"}'::jsonb
      WHERE id=$1 AND status='unknown' RETURNING id`,[attempt.id]);
    if (changed.rowCount !== 1) return false;
    await client.query(`UPDATE publications SET snapshot_id=$2,pending_snapshot_id=CASE WHEN pending_snapshot_id=$2 THEN NULL ELSE pending_snapshot_id END,
      format_version=1,updated_at=now() WHERE id=$1`,[publication.id,metadata.snapshotId]);
    return true;
  });
}
