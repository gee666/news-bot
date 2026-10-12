import { z } from 'zod';
import { db, transaction } from '../db.js';
import { readMessageFingerprint } from './reconciliation.js';
import { render } from './render.js';
import { contentFingerprint } from './reconciliation.js';
import type { Publication } from './store.js';

const metadataSchema = z.object({ snapshotId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) });

/** null means no ambiguous delivery exists. An unknown edit is never blindly retried. */
export async function reconcileUnknownEdit(publication: Publication,
  reader: (publication: Publication) => Promise<string | null> = readMessageFingerprint): Promise<boolean | null> {
  const rows = (await db.query<{ id: string; status: string; response_metadata: unknown; next_retry_at: Date | null }>(`
    SELECT id,status,response_metadata,next_retry_at FROM request_attempts WHERE publication_id=$1 AND operation='edit'
      AND status IN ('running','unknown') ORDER BY dispatched_at DESC,id DESC LIMIT 2`, [publication.id])).rows;
  if (!rows.length) return null;
  const attempt = rows[0];
  if (rows.length !== 1 || !attempt || attempt.status !== 'unknown' || attempt.next_retry_at && attempt.next_retry_at > new Date()) return false;
  const metadata = metadataSchema.safeParse(attempt.response_metadata);
  if (!metadata.success || metadata.data.snapshotId !== (publication.pending_snapshot_id ?? publication.snapshot_id)) return false;
  let expected: string;
  try { const message = render(publication.content); expected = contentFingerprint(message.plainText,message.links); }
  catch { return false; }
  if (metadata.data.fingerprint !== expected) return false;
  let observed: string | null;
  try { observed = await reader(publication); } catch { return false; }
  if (observed !== expected) return false;
  return transaction(async client => {
    const current = (await client.query<{ snapshot_id: string; pending_snapshot_id: string | null; message_id: string | null }>(
      'SELECT snapshot_id,pending_snapshot_id,message_id FROM publications WHERE id=$1 FOR UPDATE',[publication.id])).rows[0];
    if (!current || current.message_id !== publication.message_id
      || (current.pending_snapshot_id ?? current.snapshot_id) !== metadata.data.snapshotId) return false;
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata||'{"reconciled":true,"previousStatus":"unknown"}'::jsonb
      WHERE id=$1 AND status='unknown'`, [attempt.id]);
    await client.query(`UPDATE publications SET snapshot_id=$2,pending_snapshot_id=NULL,format_version=1,updated_at=now() WHERE id=$1`,
      [publication.id,metadata.data.snapshotId]);
    return true;
  });
}
