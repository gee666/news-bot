import { db, transaction } from '../db.js';
import { type AppSettings } from '../settings.js';
import { BotApi } from './bot-api.js';
import { renderedMessageSchema } from './full-text.js';
import { contentFingerprint, readMessageFingerprint } from './reconciliation.js';
import { destinationBlocked } from './destination-order.js';
import { locked, publicationSelect, rateLimited, type Publication } from './store.js';

interface NavigationPart {
  slot: string; snapshot_id: string; content: unknown; message_id: string | null; text_part_number: number | null;
  status: string; attempt_count: number; next_retry_at: Date | null;
}

export async function recoverNavigationParts(destinationId: string): Promise<void> {
  await transaction(async client => {
    await client.query(`UPDATE publication_navigation_parts n SET status='unknown',error_code='navigation_restart_unknown'
      FROM publications p WHERE p.id=n.publication_id AND p.destination_id=$1 AND n.status='running'`,[destinationId]);
    await client.query(`UPDATE request_attempts a SET status='unknown',error_code='navigation_restart_unknown',finished_at=now()
      FROM publications p WHERE p.id=a.publication_id AND p.destination_id=$1
      AND a.operation LIKE 'navigation_%' AND a.status='running'`,[destinationId]);
  });
}

async function complete(publication: Publication, part: NavigationPart, messageId: string, attemptId?: string): Promise<void> {
  await transaction(async client => {
    await client.query(`UPDATE publication_navigation_parts SET status='sent',message_id=$3,error_code=NULL,next_retry_at=NULL
      WHERE publication_id=$1 AND slot=$2`,[publication.id,part.slot,messageId]);
    if (attemptId) await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata||$2::jsonb WHERE id=$1`,[attemptId,JSON.stringify({ messageId })]);
    if (part.text_part_number!==null) await client.query(`UPDATE publication_text_parts SET content=$3,snapshot_id=$4
      WHERE publication_id=$1 AND part_number=$2 AND message_id=$5`,
    [publication.id,part.text_part_number,JSON.stringify(part.content),part.snapshot_id,messageId]);
  });
}

/** Reconcile historical edits only. No new footer sends or edits may put links outside the post. */
export async function retryNavigationParts(api: BotApi, settings: AppSettings, destinationId: string, publicationIds?:string[]): Promise<void> {
  if (!settings.publishingEnabled || await destinationBlocked(destinationId)) return;
  const botId = String((await api.identity()).id);
  const rows = await db.query<{ id: string }>(`SELECT p.id FROM publications p WHERE p.destination_id=$1 AND p.bot_id=$2
    AND p.status='published' AND p.pending_snapshot_id IS NULL AND ($3::uuid[] IS NULL OR p.id=ANY($3))
    AND EXISTS(SELECT 1 FROM publication_navigation_parts n WHERE n.publication_id=p.id AND n.snapshot_id=p.snapshot_id
      AND n.status IN ('prepared','retryable','unknown') AND (n.next_retry_at IS NULL OR n.next_retry_at<=now()))`,[destinationId,botId,publicationIds??null]);
  for (const row of rows.rows) {
    if (await rateLimited()) break;
    await locked(`news-bot-publication:${row.id}`,async client => {
      const publication = (await client.query<Publication>(`${publicationSelect} WHERE p.id=$1`,[row.id])).rows[0];
      if (!publication?.message_id || publication.pending_snapshot_id) return;
      const parts = await client.query<NavigationPart>(`SELECT * FROM publication_navigation_parts
        WHERE publication_id=$1 AND snapshot_id=$2 ORDER BY slot`,[row.id,publication.snapshot_id]);
      for (const part of parts.rows) {
        if (part.status==='sent') continue;
        const message = renderedMessageSchema.parse(part.content);
        const operation = `navigation_edit:${part.slot}`;
        if (part.status==='unknown') {
          if (!part.message_id) {
            await client.query(`UPDATE publications SET error_code='publication_navigation_requires_review',updated_at=now() WHERE id=$1`,[row.id]);
            continue;
          }
          const observed = await readMessageFingerprint({ ...publication,message_id:part.message_id }).catch(() => null);
          if (observed!==contentFingerprint(message.plainText,message.links)) return;
          const attempt = (await client.query<{ id: string }>(`SELECT id FROM request_attempts WHERE publication_id=$1
            AND operation=$2 AND status='unknown' ORDER BY dispatched_at DESC LIMIT 1`,[row.id,operation])).rows[0];
          if (attempt) await complete(publication,part,part.message_id,attempt.id);
          continue;
        }
        // Frozen historical plans can add links to a reply even through an edit. Do not execute them.
        await client.query(`UPDATE publications SET error_code='publication_navigation_requires_new_edition',updated_at=now() WHERE id=$1`,[row.id]);
      }
    });
  }
}
