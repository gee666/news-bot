import { db, transaction } from '../db.js';
import { getSettings, type AppSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { renderedMessageSchema } from './full-text.js';
import { contentFingerprint, readMessageFingerprint, sendMetadata } from './reconciliation.js';
import { publicationAdmission } from './freshness.js';
import { telegramTimeouts } from './telegram-transport.js';
import { destinationBlocked } from './destination-order.js';
import { destination, locked, publicationSelect, rateLimited, type Publication } from './store.js';

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

/** Only limit overflow uses replies. Ambiguous sends are never resent; edits reconcile exact fingerprints. */
export async function retryNavigationParts(api: BotApi, settings: AppSettings, destinationId: string, publicationIds?:string[]): Promise<void> {
  if (await destinationBlocked(destinationId)) return;
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
        const operation = `navigation_${part.message_id ? 'edit' : 'send'}:${part.slot}`;
        if (part.status==='unknown') {
          if (!part.message_id) return;
          const observed = await readMessageFingerprint({ ...publication,message_id:part.message_id }).catch(() => null);
          if (observed!==contentFingerprint(message.plainText,message.links)) return;
          const attempt = (await client.query<{ id: string }>(`SELECT id FROM request_attempts WHERE publication_id=$1
            AND operation=$2 AND status='unknown' ORDER BY dispatched_at DESC LIMIT 1`,[row.id,operation])).rows[0];
          if (attempt) await complete(publication,part,part.message_id,attempt.id);
          continue;
        }
        if (!['prepared','retryable'].includes(part.status) || part.next_retry_at && part.next_retry_at>new Date()) return;
        const current = await getSettings();
        if (!current.publishingEnabled || JSON.stringify(current)!==JSON.stringify(settings)
          || await destination()!==destinationId || await rateLimited()) return;
        const attemptId = await transaction(async tx => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
          if (!(await publicationAdmission(tx,publication,settings,'edit',{ navigationSlot:part.slot })).allowed) return null;
          const owner = await tx.query(`SELECT 1 FROM publications p WHERE p.id=$1 AND p.snapshot_id=$2
            AND p.pending_snapshot_id IS NULL AND p.bot_id=$3 AND p.destination_id=$4 AND p.status='published'
            AND NOT EXISTS(SELECT 1 FROM operational_state WHERE key='publication_removal:'||p.id::text)
            AND NOT EXISTS(SELECT 1 FROM publication_replacements WHERE duplicate_publication_id=p.id)
            FOR UPDATE`,[publication.id,part.snapshot_id,botId,destinationId]);
          if (!owner.rows.length || await rateLimited(tx)) return null;
          const claimed = await tx.query(`UPDATE publication_navigation_parts SET status='running',attempt_count=attempt_count+1
            WHERE publication_id=$1 AND slot=$2 AND snapshot_id=$3 AND status IN ('prepared','retryable')
            AND (next_retry_at IS NULL OR next_retry_at<=now()) RETURNING slot`,[publication.id,part.slot,part.snapshot_id]);
          if (!claimed.rows.length) return null;
          return (await tx.query<{ id: string }>(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
            SELECT $1,'telegram-bot',$2,coalesce(max(attempt_number),0)+1,'running',$3 FROM request_attempts WHERE publication_id=$1 RETURNING id`,
          [publication.id,operation,JSON.stringify({ ...sendMetadata(message),snapshotId:part.snapshot_id,messageId:part.message_id,
            replyTo:publication.message_id,botId,requestTimeoutMs:telegramTimeouts().requestMs })])).rows[0]?.id ?? null;
        });
        if (!attemptId) return;
        let messageId: string;
        try {
          if (part.message_id) { await api.edit(destinationId,part.message_id,message); messageId=part.message_id; }
          else messageId=await api.send(destinationId,message,publication.message_id);
        } catch (error) {
          const failure = error instanceof BotError ? error : new BotError('navigation_outcome_unknown','unknown');
          const retryAt = failure.outcome==='retryable' ? new Date(Date.now()+Math.max(failure.retryAfterMs,
            Math.min(settings.retryMaxMs,settings.retryBaseMs*2**Math.min(part.attempt_count,10)))) : null;
          await transaction(async tx => {
            await tx.query(`UPDATE publication_navigation_parts SET status=$3,error_code=$4,next_retry_at=$5
              WHERE publication_id=$1 AND slot=$2`,[publication.id,part.slot,failure.outcome,failure.code,retryAt]);
            await tx.query(`UPDATE request_attempts SET status=$2,error_code=$3,next_retry_at=$4,finished_at=now() WHERE id=$1`,
              [attemptId,failure.outcome,failure.code,retryAt]);
          });
          return;
        }
        await complete(publication,part,messageId,attemptId);
      }
    });
  }
}
