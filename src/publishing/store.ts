import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { newsOrderTime } from './ordering.js';
import { publicationSnapshotSchema,type PublicationSnapshot } from '../types.js';
import { eligible, snapshotFor, type StoryContent } from './content.js';
import { generationIsCurrent } from '../pipeline/generation-freshness.js';
export { eligible, snapshotFor, mergeSources, type StoryContent } from './content.js';

export interface Publication {
  id: string; story_id: string | null; destination_id: string; message_id: string | null;
  snapshot_id: string; pending_snapshot_id: string | null; format_version: number; bot_id: string | null;
  status: 'prepared' | 'sending' | 'published' | 'uncertain' | 'failed';
  attempt_count: number; created_at: Date; next_retry_at: Date | null; content: unknown;
  media_status?: 'none' | 'pending' | 'complete' | 'failed' | 'unknown'; media_snapshot_id?: string | null;
}
export const publicationSelect = `SELECT p.*, s.content FROM publications p
  JOIN publication_snapshots s ON s.id = p.snapshot_id`;
export const publicationEditSelect = `SELECT p.*, s.content FROM publications p
  JOIN publication_snapshots s ON s.id = coalesce(p.pending_snapshot_id,p.snapshot_id)`;
// Retryable sends are definitely unsent only after Telegram's explicit 429 rejection.
export const unsafeSendAttempt = `(a.status IN ('running','unknown','succeeded')
  OR (a.status='retryable' AND a.error_code IS DISTINCT FROM 'telegram_rate_limit')
  OR coalesce(a.error_code,'') LIKE '%unknown%')`;
export async function supersedeAttempts(client: Pick<PoolClient,'query'>, ids: string[], operation: 'send' | 'edit'): Promise<void> {
  if (!ids.length) return;
  // Cancel logical retries without erasing Telegram's bot-wide cooldown.
  await client.query(`UPDATE request_attempts SET status='failed',finished_at=now(),
    response_metadata=response_metadata || jsonb_build_object('superseded',true,'previousErrorCode',error_code),
    error_code=CASE WHEN error_code='telegram_rate_limit' AND next_retry_at>now() THEN error_code ELSE $3 END,
    next_retry_at=CASE WHEN error_code='telegram_rate_limit' AND next_retry_at>now() THEN next_retry_at ELSE NULL END
    WHERE publication_id=ANY($1::uuid[]) AND operation=$2 AND status IN ('running','unknown','retryable')
      AND ($2<>'edit' OR status='retryable')`,
  [ids,operation,operation === 'edit' ? 'edit_superseded' : 'publication_superseded']);
}

const destinationSchema = z.object({ channelId: z.string().regex(/^-100\d+$/u) });
export async function destination(): Promise<string> {
  const row = (await db.query<{ value: unknown }>("SELECT value FROM operational_state WHERE key = 'telegram_destination'")).rows[0];
  const value = destinationSchema.safeParse(row?.value);
  if (!value.success) throw new Error('Discover and resolve the numeric Telegram destination first');
  return value.data.channelId;
}
export async function rateLimited(client: Pick<PoolClient, 'query'> = db): Promise<boolean> {
  const row = (await client.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM request_attempts
    WHERE provider='telegram-bot' AND error_code='telegram_rate_limit' AND next_retry_at>now())
    OR EXISTS(SELECT 1 FROM publication_media_batches WHERE error_code='telegram_rate_limit' AND next_retry_at>now()) AS waiting`)).rows[0];
  return row?.waiting ?? false;
}
export async function state(key: string): Promise<unknown> {
  return (await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key = $1', [key])).rows[0]?.value;
}
export async function saveState(key: string, value: unknown): Promise<void> {
  await db.query(`INSERT INTO operational_state (key,value) VALUES ($1,$2)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key, JSON.stringify(value)]);
}

export async function locked<T>(name: string, run: (client: PoolClient) => Promise<T>, pool: Pool = db): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
    return await run(client);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); } finally { client.release(); }
  }
}

export async function tryLocked(name: string, run: () => Promise<void>): Promise<void> {
  const client = await db.connect();
  let acquired = false;
  try {
    acquired = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [name])).rows[0]?.acquired ?? false;
    if (acquired) await run();
  } finally {
    try { if (acquired) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); } finally { client.release(); }
  }
}

/** Caller holds the digest lease. Never adopt an attempt that may have reached Telegram. */
export async function adoptPreparedPublications(settings: AppSettings, destinationId: string): Promise<void> {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const candidates = await client.query<StoryContent & { publication_id: string }>(`SELECT s.*,p.id AS publication_id
      FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
      LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
      JOIN stories s ON s.id=coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)
      WHERE p.destination_id=$1 AND p.status='prepared' AND p.message_id IS NULL
        AND p.story_id IS DISTINCT FROM s.id AND ${eligible}
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='send'
          AND ${unsafeSendAttempt})
      ORDER BY s.id,p.created_at,p.id FOR UPDATE OF p,s`,
    [destinationId,settings.minimumPublicationScore,settings.profileVersion,settings.modelVersion]);
    for (const story of candidates.rows) {
      if (!await generationIsCurrent(story.id, settings, client.query.bind(client))) continue;
      const owner = (await client.query<{ id: string }>(`SELECT p.id FROM publications p
        LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
        WHERE p.destination_id=$1 AND p.id<>$2 AND coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=$3
          AND (p.story_id=$3 OR p.status IN ('sending','uncertain','published') OR p.message_id IS NOT NULL
            OR EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='send'
              AND ${unsafeSendAttempt}))
        LIMIT 1 FOR UPDATE OF p`, [destinationId,story.publication_id,story.id])).rows[0];
      if (owner) {
        await supersedeAttempts(client,[story.publication_id],'send');
        await client.query(`UPDATE publications SET status='failed',error_code='publication_superseded',next_retry_at=NULL,
          pending_snapshot_id=NULL,updated_at=now() WHERE id=$1`, [story.publication_id]);
        continue;
      }
      const content = await snapshotFor(client,story);
      const snapshot = (await client.query<{ id: string }>(`INSERT INTO publication_snapshots(story_id,content)
        VALUES($1,$2) RETURNING id`, [story.id,JSON.stringify(content)])).rows[0];
      if (!snapshot) throw new Error('Adopted snapshot insert failed');
      await client.query(`UPDATE publications SET story_id=$1,snapshot_id=$2,pending_snapshot_id=NULL,
        error_code=NULL,updated_at=now() WHERE id=$3`, [story.id,snapshot.id,story.publication_id]);
    }
  });
}

export async function prepareDigest(settings: AppSettings, destinationId: string,
  scope?: { storyIds: string[] } | { runId: string; storyIds: string[]; limit: number; botId: number }): Promise<string[]> {
  const manual = scope && 'runId' in scope ? scope : undefined;
  if (!scope) await adoptPreparedPublications(settings,destinationId);
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    let ids: string[] = [];
    let limit = manual?.limit ?? Infinity;
    if (manual) {
      const previous = await client.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1 FOR UPDATE', [`run_now_publications:${manual.runId}`]);
      if (previous.rows[0]) {
        const saved = z.object({ ids: z.array(z.uuid()), destinationId: z.string(), botId: z.number(), limit: z.number().int().positive().optional() }).parse(previous.rows[0].value);
        if (saved.destinationId !== destinationId || saved.botId !== manual.botId) throw new Error('Manual publication binding changed');
        ids = saved.ids; limit = saved.limit ?? manual.limit;
      }
    }
    const stories = await client.query<StoryContent>(`SELECT s.* FROM stories s WHERE ${eligible}
      AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
        LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
        WHERE coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=s.id AND p.destination_id=$1)
      AND ($5::uuid[] IS NULL OR s.id=ANY($5))
      AND ($6 OR NOT EXISTS(SELECT 1 FROM story_publication_ready ready WHERE ready.story_id=s.id AND ready.manual_operation_id IS NOT NULL))
      ORDER BY ${newsOrderTime('s')},s.id FOR UPDATE OF s`, [destinationId,settings.minimumPublicationScore,settings.profileVersion,settings.modelVersion,scope?.storyIds ?? null,Boolean(manual)]);
    const capacity = Math.max(0, limit - ids.length);
    for (const story of stories.rows) {
      if (ids.length >= limit) break;
      if (!await generationIsCurrent(story.id, settings, client.query.bind(client))) continue;
      const content = await snapshotFor(client, story);
      const snapshot = (await client.query<{ id: string }>('INSERT INTO publication_snapshots(story_id,content) VALUES ($1,$2) RETURNING id',
        [story.id, JSON.stringify(content)])).rows[0];
      if (!snapshot) throw new Error('Snapshot insert failed');
      const inserted = await client.query<{ id: string }>(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [story.id,snapshot.id,destinationId,manual ? String(manual.botId) : null]);
      ids.push(z.uuid().parse(inserted.rows[0]?.id));
    }
    if (manual) await client.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key)
      DO UPDATE SET value=operational_state.value||EXCLUDED.value,updated_at=now()`,
      [`run_now_publications:${manual.runId}`, JSON.stringify({ ids, destinationId, botId: manual.botId, limit,
        omitted: Math.max(0, stories.rows.length - capacity) })]);
    return ids;
  });
}

// Recheck versions and replace an unsent snapshot when a prepared send was delayed.
export async function refreshPrepared(publication: Publication, settings: AppSettings): Promise<PublicationSnapshot | null> {
  if (!publication.story_id) return null;
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const story = (await client.query<StoryContent>(`SELECT s.* FROM stories s WHERE ${eligible} AND $1::text IS NOT NULL AND s.id=$5 FOR UPDATE`,
      [publication.destination_id,settings.minimumPublicationScore,settings.profileVersion,settings.modelVersion,publication.story_id])).rows[0];
    if (!story || !await generationIsCurrent(story.id, settings, client.query.bind(client))) return null;
    const current = (await client.query<Publication & { snapshot_story_id:string | null }>(`SELECT p.*,snap.content,snap.story_id AS snapshot_story_id
      FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id WHERE p.id=$1 FOR UPDATE OF p`,[publication.id])).rows[0];
    if (!current || current.status !== 'prepared' || current.message_id || current.pending_snapshot_id
      || current.snapshot_id !== publication.snapshot_id || current.story_id !== story.id || current.destination_id !== publication.destination_id) return null;
    const content = await snapshotFor(client,story);
    const previous = publicationSnapshotSchema.safeParse(current.content);
    if (previous.success && JSON.stringify(previous.data) === JSON.stringify(content) && current.snapshot_story_id === story.id) return content;
    const snapshot = (await client.query<{ id:string }>('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
      [story.id,JSON.stringify(content)])).rows[0];
    if (!snapshot) throw new Error('Prepared snapshot insert failed');
    await client.query('UPDATE publications SET snapshot_id=$1,updated_at=now() WHERE id=$2',[snapshot.id,publication.id]);
    return content;
  });
}

export async function testPublication(destinationId: string): Promise<Publication> {
  return transaction(async client => {
    const content: PublicationSnapshot = { headline: 'Тест бота. Проверка публикации и редактирования.', score: 1,
      details: 'Это технический тест, а не новость. Редактирование сообщения работает.', detailsKind: 'summary', sources: [] };
    const snapshot = (await client.query<{ id: string }>('INSERT INTO publication_snapshots(content) VALUES ($1) RETURNING id', [JSON.stringify(content)])).rows[0];
    if (!snapshot) throw new Error('Test snapshot insert failed');
    const publication = (await client.query<{ id: string }>(`INSERT INTO publications(snapshot_id,destination_id)
      VALUES ($1,$2) RETURNING id`, [snapshot.id,destinationId])).rows[0];
    if (!publication) throw new Error('Test publication insert failed');
    const row = (await client.query<Publication>(`${publicationSelect} WHERE p.id=$1`, [publication.id])).rows[0];
    if (!row) throw new Error('Test publication not found');
    return row;
  });
}
