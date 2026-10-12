import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppSettings } from '../settings.js';
import { publicationSnapshotSchema } from '../types.js';
import type { BotApi } from './bot-api.js';
import { editPublication } from './delivery.js';
import { render } from './render.js';
import { locked, publicationSelect, rateLimited, type Publication } from './store.js';

export const verifiedBotSchema = z.object({ verified: z.literal(true), destinationId: z.string(), botId: z.number().int().positive() });
const testIdentitySchema = z.object({ publicationId: z.uuid(), destinationId: z.string(), botId: z.number().int().positive() });

/** A null story ID alone never identifies a test: retained news also has null IDs. */
export async function trackedVerificationTest(client: Pick<PoolClient,'query'>, destinationId: string, botId: string): Promise<Publication> {
  const value = (await client.query<{ value: unknown }>("SELECT value FROM operational_state WHERE key='bot_verification_test'")).rows[0]?.value;
  const test = testIdentitySchema.parse(value);
  if (test.destinationId !== destinationId || String(test.botId) !== botId) throw new Error('verification_test_identity_mismatch');
  const publication = (await client.query<Publication>(`${publicationSelect} WHERE p.id=$1 AND p.destination_id=$2
    AND p.bot_id=$3 AND p.status='published' AND p.message_id IS NOT NULL AND p.story_id IS NULL
    AND p.pending_snapshot_id IS NULL AND NOT EXISTS(SELECT 1 FROM story_publication_aliases pa WHERE pa.publication_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id)`,
  [test.publicationId,destinationId,botId])).rows[0];
  if (!publication) throw new Error('verification_test_not_owned_published_test');
  const snapshot = publicationSnapshotSchema.parse(publication.content);
  if (snapshot.sources.length) throw new Error('verification_test_has_unexpected_sources');
  render(snapshot);
  return publication;
}

export async function repairEditBlocked(client: Pick<PoolClient,'query'>, publicationId: string, snapshotId: string): Promise<boolean> {
  return (await client.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM request_attempts
    WHERE publication_id=$1 AND operation='edit' AND (status IN ('running','unknown')
      OR (response_metadata->>'snapshotId'=$2 AND (status='failed' AND error_code IS DISTINCT FROM 'edit_superseded' OR next_retry_at>now())))) AS blocked`,
  [publicationId,snapshotId])).rows[0]?.blocked ?? false;
}

/** Edit only the registered existing verification message. No creation, deletion or model calls. */
export async function editVerificationTest(api: BotApi, settings: AppSettings, destinationId: string, botId: string,
  publicationId: string): Promise<boolean> {
  return locked(`news-bot-publication:${publicationId}`, async client => {
    const publication = await trackedVerificationTest(client,destinationId,botId);
    if (publication.id !== publicationId) throw new Error('verification_test_registration_changed');
    if (await rateLimited(client)) return false;
    return !await repairEditBlocked(client,publication.id,publication.snapshot_id) && await editPublication(publication,api,settings,{ verificationTest: true });
  });
}
