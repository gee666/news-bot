import { z } from 'zod';
import { db, transaction } from '../db.js';
import { publicationSnapshotSchema } from '../types.js';
import { loadAction, snapshotHash } from './approval.js';
import { CAPTION_LIMIT } from './caption.js';
import { renderedMessageSchema, renderFullText, withUpdateMarker } from './full-text.js';
import { cleanLegacyHeadings, freezeEditedCanonical, renderPublication, withoutUpdateMarker } from './message-render.js';
import { isNavigationSource, navigationOnlyChange } from './navigation.js';
import { stripNavigationTail } from './navigation-tail.js';
import { contentFingerprint, readMessageFingerprint } from './reconciliation.js';
import type { RenderedMessage } from './render.js';
import type { Publication } from './store.js';

// Full repairs own a caption plus a continuation plan and require separate manual reconciliation.
const metadataSchema = z.object({
  snapshotId:z.uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),approvalId:z.uuid().optional(),
  fullContentRepair:z.undefined().optional(),parts:z.undefined().optional(),
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
function append(base: RenderedMessage, tail: RenderedMessage): RenderedMessage {
  return { ...base,text:base.text+tail.text,plainText:base.plainText+tail.plainText,
    links:[...base.links,...tail.links.map(link=>({ ...link,offset:base.plainText.length+link.offset }))] };
}

/** Reconstruct only the pre-v2 navigation presentation, using its frozen factual prefix. */
async function historicalNavigation(publication: Publication): Promise<RenderedMessage | null> {
  const snapshot = publicationSnapshotSchema.parse(publication.content);
  const parts = (await db.query<{ content: unknown; snapshot_content: unknown }>(`SELECT t.content,s.content AS snapshot_content
    FROM publication_text_parts t JOIN publication_snapshots s ON s.id=t.snapshot_id
    WHERE t.publication_id=$1 ORDER BY t.part_number`,[publication.id])).rows;
  const first = parts[0];
  if (!first || snapshot.navigationVersion === 2) return null;
  const sent = publicationSnapshotSchema.parse(first.snapshot_content);
  if (!navigationOnlyChange(sent,snapshot)) return null;
  const originals = parts.map(part=>renderedMessageSchema.parse(part.content));
  const base = originals[0];
  if (!base) return null;
  originals[0] = cleanLegacyHeadings(withoutUpdateMarker(base,sent.updatedTo));
  const sources = [sent,...parts.map(part=>publicationSnapshotSchema.parse(part.snapshot_content))]
    .flatMap(part=>part.sources).filter(isNavigationSource);
  let message = stripNavigationTail(originals,sources)[0];
  if (!message) return null;
  if (!snapshot.navigationOverflow) {
    // Historical audit and confirmed-related groups were separate and had different headings.
    const groups = [
      { kind:'previous',heading:'Предыдущие публикации' },
      { kind:'unverified',heading:'Другие публикации' },
      { kind:'related',heading:'Связанные новости' },
    ];
    for (const group of groups) {
      const selected = snapshot.sources.filter(source => (source.relatedPublication ? 'related'
        : source.unverifiedPublication ? 'unverified' : source.previousPublication ? 'previous' : '') === group.kind);
      if (!selected.length) continue;
      if (parts.length > 1) return null;
      const tail = renderFullText({ ...snapshot,headline:'Links',details:'',earlier:undefined,review:undefined,updatedTo:undefined,
        sources:selected.map(source=>({ ...source,unverifiedPublication:undefined,previousPublication:undefined,relatedPublication:true })) },true);
      const footer = tail[0];
      if (tail.length !== 1 || !footer) return null;
      // Replace the generated heading only, never a matching phrase in the original body or labels.
      const heading = 'Другие публикации';
      const delta = group.heading.length-heading.length;
      message = append(message,{ ...footer,text:footer.text.replace(`<b>${heading}</b>`,`<b>${group.heading}</b>`),
        plainText:'\n\n'+group.heading+footer.plainText.slice(heading.length+2),
        links:footer.links.map(link=>({ ...link,offset:link.offset+delta })) });
    }
  }
  const limit = publication.delivery_kind === 'album' ? CAPTION_LIMIT : 4096;
  if (message.plainText.length > limit || message.links.length+(message.text.match(/<b>/gu)?.length ?? 0)>98) return null;
  if (snapshot.updatedTo && (!snapshot.navigationOverflow || message.plainText.length+`UPD: ${snapshot.updatedTo}\n\n`.length<=limit))
    return withUpdateMarker(message,snapshot.updatedTo,limit);
  return message;
}

async function ordinaryMessage(publication: Publication, expected: string): Promise<RenderedMessage | null> {
  try {
    const current = await renderPublication(publication);
    if (fingerprint(current) === expected) return current;
  } catch { /* A newer renderer may no longer reproduce this historical edit. */ }
  try {
    const historical = await historicalNavigation(publication);
    return historical && fingerprint(historical) === expected ? historical : null;
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
  if (metadata.approvalId) {
    const action = await loadAction(db,metadata.approvalId);
    if (action?.operation === 'edit' && action.fullContentRepair) return false;
  }
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
      || snapshotHash(frozen.content) !== snapshotHash(snapshot.content)) return false;
    if (metadata.approvalId) {
      const action = await loadAction(client,metadata.approvalId);
      if (action?.operation === 'edit' && action.fullContentRepair) return false;
    }
    const changed = await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata||'{"reconciled":true,"previousStatus":"unknown"}'::jsonb
      WHERE id=$1 AND status='unknown' RETURNING id`,[attempt.id]);
    if (changed.rowCount !== 1) return false;
    await client.query(`UPDATE publications SET snapshot_id=$2,pending_snapshot_id=CASE WHEN pending_snapshot_id=$2 THEN NULL ELSE pending_snapshot_id END,
      format_version=1,updated_at=now() WHERE id=$1`,[publication.id,metadata.snapshotId]);
    await freezeEditedCanonical(client,{ ...attemptedPublication,pending_snapshot_id:metadata.snapshotId },message);
    return true;
  });
}
