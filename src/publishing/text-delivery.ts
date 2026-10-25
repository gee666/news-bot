import { db, transaction } from '../db.js';
import { getSettings, type AppSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { renderFullText, renderedMessageSchema } from './full-text.js';
import { sendMetadata } from './reconciliation.js';
import { telegramTimeouts } from './telegram-transport.js';
import { destination, publicationSelect, rateLimited, type Publication } from './store.js';
import { render, type RenderedMessage } from './render.js';
import { contentFingerprint } from './reconciliation.js';
import { destinationBlocked, releaseDestination } from './destination-order.js';
import { fullRepairContinuation } from './approval.js';

interface TextPart {
  part_number: number; content: unknown; status: string; attempt_count: number; next_retry_at: Date | null;
}

/** Only an unattempted plan can change. Known rejected sends keep their exact frozen text. */
export async function preparePublicationText(publication: Publication): Promise<RenderedMessage> {
  return transaction(async client => {
    const current = (await client.query<Publication>('SELECT * FROM publications WHERE id=$1 FOR UPDATE', [publication.id])).rows[0];
    if (!current || current.status !== 'prepared' || current.snapshot_id !== publication.snapshot_id) throw new BotError('publication_text_plan_changed', 'retryable');
    const attempted = (await client.query(`SELECT 1 FROM request_attempts WHERE publication_id=$1 AND (operation='send' OR operation LIKE 'send_media:%') LIMIT 1`, [publication.id])).rows.length > 0;
    const frozen = (await client.query<{ content: unknown; snapshot_id: string }>(`SELECT content,snapshot_id FROM publication_text_parts
      WHERE publication_id=$1 AND part_number=0`, [publication.id])).rows[0];
    if (frozen && frozen.snapshot_id === publication.snapshot_id) return renderedMessageSchema.parse(frozen.content);
    if (attempted) {
      // A pre-migration text send has no parts. Preserve its original renderer and fingerprint.
      if (frozen) throw new BotError('publication_text_plan_changed', 'failed');
      const legacy = render(publication.content);
      const fingerprint = contentFingerprint(legacy.plainText,legacy.links);
      const mismatched = await client.query(`SELECT 1 FROM request_attempts WHERE publication_id=$1 AND operation='send'
        AND response_metadata->>'fingerprint' IS DISTINCT FROM $2 LIMIT 1`, [publication.id,fingerprint]);
      if (mismatched.rows.length) throw new BotError('publication_text_plan_changed', 'failed');
      return legacy;
    }
    const parts = renderFullText(publication.content);
    await client.query('DELETE FROM publication_text_parts WHERE publication_id=$1', [publication.id]);
    for (const [number, part] of parts.entries()) await client.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content)
      VALUES($1,$2,$3,$4)`, [publication.id,number,publication.snapshot_id,JSON.stringify(part)]);
    const first = parts[0];
    if (!first) throw new BotError('publication_text_plan_empty', 'failed');
    return first;
  });
}

/** Match media delivery policy: finish already-started frozen work, never send ambiguous parts twice. */
export async function deliverPublicationText(publication: Publication, api: BotApi, settings: AppSettings): Promise<boolean> {
  if (!publication.message_id || publication.status !== 'published') return false;
  if (await destinationBlocked(publication.destination_id, publication.delivery_kind === 'media_first' ? publication.id : undefined)) return false;
  const fullRepairId = publication.delivery_kind === 'album' ? await fullRepairContinuation(db,publication) : null;
  if (publication.delivery_kind === 'album' && !fullRepairId) return false;
  const botId = String((await api.identity()).id);
  if (publication.bot_id !== botId) return false;
  const parts = (await db.query<TextPart>(`SELECT * FROM publication_text_parts WHERE publication_id=$1 AND part_number>0 ORDER BY part_number`, [publication.id])).rows;
  for (const part of parts) {
    if (part.status === 'sent') continue;
    if (!['prepared','retryable'].includes(part.status) || part.next_retry_at && part.next_retry_at > new Date()) return false;
    const current = await getSettings();
    if (!current.publishingEnabled || JSON.stringify(current) !== JSON.stringify(settings)
      || await destination() !== publication.destination_id || await rateLimited()) return false;
    const message = renderedMessageSchema.parse(part.content);
    const operation = `send_part:${part.part_number}`;
    const attemptId = await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
      const owner = await client.query<Publication>(`SELECT p.*,s.content FROM publications p
        JOIN publication_snapshots s ON s.id=p.snapshot_id WHERE p.id=$1 AND p.status='published' AND p.message_id=$2
        AND p.destination_id=$3 AND p.bot_id=$4
        AND NOT EXISTS(SELECT 1 FROM operational_state WHERE key='publication_removal:'||p.id::text)
        AND NOT EXISTS(SELECT 1 FROM publication_replacements WHERE duplicate_publication_id=p.id AND status<>'failed') FOR UPDATE OF p`,
      [publication.id,publication.message_id,publication.destination_id,botId]);
      const owned = owner.rows[0];
      if (await destinationBlocked(publication.destination_id, publication.delivery_kind === 'media_first' ? publication.id : undefined, client)) return null;
      if (!owned || owned.snapshot_id !== publication.snapshot_id || await rateLimited(client)) return null;
      if (owned.delivery_kind === 'album' && (!fullRepairId || await fullRepairContinuation(client,owned) !== fullRepairId)) return null;
      const claimed = await client.query(`UPDATE publication_text_parts SET status='running',attempt_count=attempt_count+1,
        error_code=NULL,next_retry_at=NULL WHERE publication_id=$1 AND part_number=$2 AND status IN ('prepared','retryable')
        AND (next_retry_at IS NULL OR next_retry_at<=now()) RETURNING part_number`, [publication.id,part.part_number]);
      if (!claimed.rows.length) return null;
      return (await client.query<{ id: string }>(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
        SELECT $1,'telegram-bot',$2,coalesce(max(attempt_number),0)+1,'running',$3 FROM request_attempts WHERE publication_id=$1 RETURNING id`,
      [publication.id,operation,JSON.stringify({ ...sendMetadata(message), requestTimeoutMs: telegramTimeouts().requestMs, botId, replyTo: publication.message_id,
        ...(fullRepairId ? { approvalId:fullRepairId,snapshotId:publication.snapshot_id,fullContentRepair:true } : {}) })])).rows[0]?.id ?? null;
    });
    if (!attemptId) return false;
    let messageId: string;
    try { messageId = await api.send(publication.destination_id, message, publication.message_id); }
    catch (error) {
      const failure = error instanceof BotError ? error : new BotError('telegram_text_outcome_unknown','unknown');
      const retryAt = failure.outcome !== 'retryable' ? null : new Date(Date.now() + Math.max(failure.retryAfterMs,
        Math.min(settings.retryMaxMs,settings.retryBaseMs * 2 ** Math.min(part.attempt_count,10))));
      await transaction(async client => {
        await client.query(`UPDATE publication_text_parts SET status=$3,error_code=$4,next_retry_at=$5 WHERE publication_id=$1 AND part_number=$2`,
          [publication.id,part.part_number,failure.outcome,failure.code,retryAt]);
        await client.query(`UPDATE request_attempts SET status=$2,error_code=$3,next_retry_at=$4,finished_at=now() WHERE id=$1`,
          [attemptId,failure.outcome,failure.code,retryAt]);
        await client.query(`UPDATE publications SET error_code=$2,updated_at=now() WHERE id=$1`,
          [publication.id,failure.outcome === 'unknown' ? 'publication_text_requires_review' : `publication_text_${failure.outcome}`]);
      });
      return false;
    }
    await transaction(async client => {
      await client.query(`UPDATE publication_text_parts SET status='sent',message_id=$3,error_code=NULL,next_retry_at=NULL
        WHERE publication_id=$1 AND part_number=$2`, [publication.id,part.part_number,messageId]);
      await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),response_metadata=response_metadata||$2::jsonb WHERE id=$1`,
        [attemptId,JSON.stringify({ messageId })]);
    });
  }
  await transaction(async client => {
    await client.query(`UPDATE publications SET error_code=NULL WHERE id=$1 AND error_code LIKE 'publication_text_%'`, [publication.id]);
    await releaseDestination(publication.id,client);
  });
  return true;
}

export async function recoverPublicationText(destinationId: string, publicationIds?: string[]): Promise<void> {
  await transaction(async client => {
    await client.query(`UPDATE publication_text_parts t SET status='unknown',error_code='publication_text_restart_unknown'
      FROM publications p WHERE p.id=t.publication_id AND p.destination_id=$1 AND ($2::uuid[] IS NULL OR p.id=ANY($2)) AND t.part_number>0 AND t.status='running'`, [destinationId,publicationIds ?? null]);
    await client.query(`UPDATE request_attempts a SET status='unknown',error_code='publication_text_restart_unknown',finished_at=now()
      FROM publications p WHERE p.id=a.publication_id AND p.destination_id=$1 AND ($2::uuid[] IS NULL OR p.id=ANY($2)) AND a.operation LIKE 'send_part:%' AND a.status='running'`, [destinationId,publicationIds ?? null]);
    await client.query(`UPDATE publications p SET error_code='publication_text_requires_review' WHERE p.destination_id=$1 AND ($2::uuid[] IS NULL OR p.id=ANY($2))
      AND EXISTS(SELECT 1 FROM publication_text_parts t WHERE t.publication_id=p.id AND t.status='unknown')`, [destinationId,publicationIds ?? null]);
  });
}

export async function retryPublicationText(api: BotApi, settings: AppSettings, destinationId: string, publicationIds?: string[]): Promise<void> {
  const publications = (await db.query<Publication>(`${publicationSelect} WHERE p.destination_id=$1 AND p.status='published' AND ($2::uuid[] IS NULL OR p.id=ANY($2))
    AND EXISTS(SELECT 1 FROM publication_text_parts t WHERE t.publication_id=p.id AND t.part_number>0 AND t.status IN ('prepared','retryable')
      AND (t.next_retry_at IS NULL OR t.next_retry_at<=now())) ORDER BY p.created_at`, [destinationId,publicationIds ?? null])).rows;
  for (const publication of publications) {
    if (await rateLimited()) break;
    await deliverPublicationText(publication,api,settings);
  }
}
