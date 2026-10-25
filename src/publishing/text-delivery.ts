import { db, transaction } from '../db.js';
import { type AppSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { renderedMessageSchema } from './full-text.js';
import { publicationSelect, rateLimited, type Publication } from './store.js';
import { PublicationRenderError, render, type RenderedMessage } from './render.js';
import { contentFingerprint } from './reconciliation.js';
import { destinationBlocked, releaseDestination } from './destination-order.js';
import { assertCanonicalLinks, renderCanonicalText } from './canonical-text.js';

/** Only an unattempted plan can change. Known rejected sends keep their exact frozen text. */
export async function preparePublicationText(publication: Publication): Promise<RenderedMessage> {
  return transaction(async client => {
    const current = (await client.query<Publication>('SELECT * FROM publications WHERE id=$1 FOR UPDATE', [publication.id])).rows[0];
    if (!current || current.status !== 'prepared' || current.snapshot_id !== publication.snapshot_id) throw new BotError('publication_text_plan_changed', 'retryable');
    const attempted = (await client.query(`SELECT 1 FROM request_attempts WHERE publication_id=$1 AND (operation='send' OR operation LIKE 'send_media:%') LIMIT 1`, [publication.id])).rows.length > 0;
    const frozen = (await client.query<{ content: unknown; snapshot_id: string }>(`SELECT content,snapshot_id FROM publication_text_parts
      WHERE publication_id=$1 AND part_number=0`, [publication.id])).rows[0];
    if ((await client.query(`SELECT 1 FROM publication_text_parts WHERE publication_id=$1 AND part_number>0 LIMIT 1`, [publication.id])).rows.length)
      throw new PublicationRenderError('publication_text_requires_new_edition');
    // Reject old shortened or multipart plans if the complete snapshot cannot fit today.
    const canonical = renderCanonicalText(publication.content);
    if (attempted && frozen && frozen.snapshot_id === publication.snapshot_id) {
      const message = renderedMessageSchema.parse(frozen.content);
      assertCanonicalLinks(publication.content, message);
      return message;
    }
    if (attempted) {
      // A pre-migration text send has no parts. Preserve its original renderer and fingerprint.
      if (frozen) throw new BotError('publication_text_plan_changed', 'failed');
      const legacy = render(publication.content);
      const fingerprint = contentFingerprint(legacy.plainText,legacy.links);
      const mismatched = await client.query(`SELECT 1 FROM request_attempts WHERE publication_id=$1 AND operation='send'
        AND response_metadata->>'fingerprint' IS DISTINCT FROM $2 LIMIT 1`, [publication.id,fingerprint]);
      if (mismatched.rows.length) throw new BotError('publication_text_plan_changed', 'failed');
      assertCanonicalLinks(publication.content, legacy);
      return legacy;
    }
    await client.query('DELETE FROM publication_text_parts WHERE publication_id=$1', [publication.id]);
    await client.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content)
      VALUES($1,$2,$3,$4)`, [publication.id,0,publication.snapshot_id,JSON.stringify(canonical)]);
    return canonical;
  });
}

/** Historical continuations remain auditable, but policy forbids any further reply sends. */
export async function deliverPublicationText(publication: Publication, api: BotApi, settings: AppSettings): Promise<boolean> {
  if (!publication.message_id || publication.status !== 'published' || !settings.publishingEnabled) return false;
  if (publication.bot_id !== String((await api.identity()).id)) return false;
  if (await destinationBlocked(publication.destination_id, publication.delivery_kind === 'media_first' ? publication.id : undefined)) return false;
  const pending = await db.query(`SELECT 1 FROM publication_text_parts WHERE publication_id=$1 AND part_number>0 AND status<>'sent' LIMIT 1`, [publication.id]);
  if (pending.rows.length) {
    await db.query(`UPDATE publications SET error_code='publication_text_requires_new_edition',updated_at=now() WHERE id=$1`, [publication.id]);
    return false;
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
