import type { PoolClient } from 'pg';
import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { generationThread } from '../pipeline/generation-context.js';
import { stalePrimaryEvent } from './event-dates.js';
import { novelPublicationInputs, publicationBoundarySchema, publicationInputBoundary, type PublicationBoundary } from './input-evidence.js';
export { publicationInputBoundary } from './input-evidence.js';

export type InputAdmission = { allowed: true } | { allowed: false;
  reason: 'stale_source_input' | 'no_new_source_input' | 'publication_input_unverifiable' };

/** Only a new preparation can establish provenance. Reuse requires an existing modern boundary. */
export async function recordPublicationInputs(client: Pick<PoolClient, 'query'>, publicationId: string, storyId: string,
  options: { newPreparation?: boolean } = {}): Promise<void> {
  const key = `publication_input:${publicationId}`;
  const previous = (await client.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1 FOR UPDATE', [key])).rows[0];
  const saved = publicationBoundarySchema.safeParse(previous?.value);
  if (!options.newPreparation && (!saved.success || !saved.data.inputs.length || saved.data.primaryEventDates === undefined)) return;
  const boundary = await publicationInputBoundary(storyId, client.query.bind(client));
  await client.query(`INSERT INTO operational_state(key,value) SELECT $1,$2::jsonb
    WHERE EXISTS(SELECT 1 FROM publications p WHERE p.id=$3 AND p.status='prepared'
      AND p.message_id IS NULL AND p.published_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=$3)
      AND NOT EXISTS(SELECT 1 FROM publication_destination_reservations r WHERE r.publication_id=$3)
      AND NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=$3)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
  [key, JSON.stringify(boundary), publicationId]);
}

export async function publishedInputBoundary(storyId: string, destinationId: string, query = db.query.bind(db)):
Promise<{ published: boolean; boundary: PublicationBoundary; verifiable: boolean }> {
  const publications = await query(`${generationThread} SELECT o.value AS boundary
    FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
    LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    LEFT JOIN operational_state o ON o.key='publication_input:'||p.id::text
    WHERE coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) IN(SELECT id FROM generation_story_ids)
      AND p.destination_id=$2 AND p.message_id IS NOT NULL AND (p.status='published' OR p.published_at IS NOT NULL)
    ORDER BY p.published_at,p.id`, [storyId, destinationId]);
  const parsed = z.array(z.object({ boundary: z.unknown() })).parse(publications.rows);
  const boundary: PublicationBoundary = { version: 'publication-input-v2', inputs: [] };
  for (const post of parsed) {
    const saved = publicationBoundarySchema.safeParse(post.boundary);
    if (!saved.success || !saved.data.inputs.length) {
      return { published: true, boundary: { version: 'publication-input-v2', inputs: [] }, verifiable: false };
    }
    boundary.inputs.push(...saved.data.inputs);
  }
  return { published: parsed.length > 0, boundary, verifiable: true };
}

/** Dispatch requires the boundary saved at preparation. Never adopt today's inputs for an old queue row. */
export async function preparedPublicationInputs(publicationId: string, query = db.query.bind(db)): Promise<PublicationBoundary | null> {
  const row = (await query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1',
    [`publication_input:${publicationId}`])).rows[0];
  const saved = publicationBoundarySchema.safeParse(row?.value);
  return saved.success && saved.data.inputs.length && saved.data.primaryEventDates !== undefined ? saved.data : null;
}

export async function publicationInputAdmission(storyId: string, destinationId: string, settings: AppSettings,
  query = db.query.bind(db), options: { storyIds?: string[]; boundary?: PublicationBoundary } = {}): Promise<InputAdmission> {
  const boundaries = options.boundary ? [options.boundary] : await Promise.all(
    [...new Set([storyId, ...(options.storyIds ?? [])])].map(id => publicationInputBoundary(id, query)));
  const current = options.boundary ?? { version: 'publication-input-v2' as const,
    inputs: boundaries.flatMap(boundary => boundary.inputs),
    primaryEventDates: boundaries.flatMap(boundary => boundary.primaryEventDates ?? []) };
  const prior = await publishedInputBoundary(storyId, destinationId, query);
  return admitPublicationInputs(current, prior.boundary, prior.published, prior.verifiable, settings.collectionWindowHours);
}

export function admitPublicationInputs(current: PublicationBoundary, baseline: PublicationBoundary, published: boolean,
  verifiable: boolean, windowHours: number, now = Date.now()): InputAdmission {
  if (current.primaryEventDates === undefined || published && !verifiable) return { allowed: false, reason: 'publication_input_unverifiable' };
  const novel = novelPublicationInputs(current, baseline);
  if (published && !novel.length) return { allowed: false, reason: 'no_new_source_input' };
  const cutoff = now - windowHours * 3_600_000;
  if (stalePrimaryEvent(current.primaryEventDates, windowHours, now)) return { allowed: false, reason: 'stale_source_input' };
  const publishedItems = new Set(baseline.inputs.map(input => input.itemId));
  // V2 novelty requires added scoped payload backed by a real collected-text/URL addition.
  // Only a previously published item may use revision time; an old newly attached report cannot.
  return novel.some(input => Date.parse(input.sourceTime) >= cutoff || publishedItems.has(input.itemId)
    && input.revisionTime !== undefined && Date.parse(input.revisionTime) >= cutoff)
    ? { allowed: true } : { allowed: false, reason: 'stale_source_input' };
}
