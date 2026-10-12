import { createHash } from 'node:crypto';
import cron from 'node-cron';
import { z } from 'zod';
import { transaction } from './db.js';
import type { PoolClient } from 'pg';

export const DEFAULT_INTEREST_PROFILE = 'I want actual AI and technology news, especially LLMs, programming, computer hardware, and developments in the technology industry. Prioritize concrete announcements, releases, findings, and industry events. Exclude educational content, courses, prompt collections, tutorials, and advertisements. I want news, not promotional or instructional material.';

const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTP(S) endpoint without embedded credentials, query or fragment');
const name = z.string().trim().min(1).max(200);
const schedule = z.string().refine(value => cron.validate(value), 'Invalid cron expression');
const timezone = z.string().refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid timezone');
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const settingsSchema = z.object({
  interestProfile: z.string().trim().min(1).max(20_000),
  profileVersion: positiveInteger,
  modelVersion: positiveInteger,
  jevUrl: endpoint,
  jevModel: name,
  embeddingUrl: endpoint,
  embeddingModel: name,
  embeddingDimensions: z.number().int().min(1).max(65_535),
  embeddingInputVersion: name,
  embeddingContextTokens: z.number().int().min(128).max(131_072),
  piProvider: name,
  piModel: name,
  researchThreshold: z.number().int().min(1).max(10),
  minimumPublicationScore: z.number().int().min(1).max(10),
  collectionCron: schedule,
  digestCron: schedule,
  cleanupCron: schedule,
  timezone,
  retentionDays: z.number().int().min(1).max(365),
  publishingEnabled: z.boolean(),
  jevTimeoutMs: z.number().int().min(1_200_000).max(86_400_000),
  embeddingTimeoutMs: z.number().int().min(1_000).max(86_400_000),
  piTimeoutMs: z.number().int().min(1_000).max(86_400_000),
  connectionTimeoutMs: z.number().int().min(100).max(60_000),
  prefixCacheEnabled: z.boolean(),
  collectionWindowHours: z.number().int().min(1).max(48),
  researchMaxPages: z.number().int().min(1).max(20),
  researchMaxSearches: z.number().int().min(0).max(10),
  requestMaxAttempts: z.number().int().min(1).max(20),
  retryBaseMs: z.number().int().min(1_000).max(3_600_000),
  retryMaxMs: z.number().int().min(1_000).max(86_400_000),
}).strict();

export type AppSettings = z.infer<typeof settingsSchema>;
const writableSchema = settingsSchema.omit({ profileVersion: true, modelVersion: true }).partial();
function validateSettings(input: unknown): AppSettings {
  const settings = settingsSchema.parse(input);
  if (settings.retryMaxMs < settings.retryBaseMs) throw new Error('retryMaxMs must be at least retryBaseMs');
  return settings;
}

export const defaultSettings: AppSettings = validateSettings({
  interestProfile: DEFAULT_INTEREST_PROFILE,
  profileVersion: 1,
  modelVersion: 1,
  jevUrl: process.env.JEV_URL ?? 'http://localhost:8765',
  jevModel: process.env.JEV_MODEL ?? 'autojev',
  embeddingUrl: process.env.EMBEDDING_URL ?? 'http://localhost:11434',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'qwen3-embedding:latest',
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 4096),
  embeddingInputVersion: 'mention-v1',
  embeddingContextTokens: 2048,
  piProvider: process.env.NEWS_PI_PROVIDER ?? 'openai-codex',
  piModel: process.env.NEWS_PI_MODEL ?? 'gpt-6-luna',
  researchThreshold: 5,
  minimumPublicationScore: 1,
  collectionCron: '0 5,9,13,17,21 * * *',
  digestCron: '0 */3 * * *',
  cleanupCron: '0 4 * * *',
  timezone: 'Europe/Berlin',
  retentionDays: 14,
  publishingEnabled: false,
  jevTimeoutMs: 1_200_000,
  embeddingTimeoutMs: 600_000,
  piTimeoutMs: 300_000,
  connectionTimeoutMs: 10_000,
  prefixCacheEnabled: true,
  collectionWindowHours: 48,
  researchMaxPages: 5,
  researchMaxSearches: 2,
  requestMaxAttempts: 5,
  retryBaseMs: 30_000,
  retryMaxMs: 3_600_000,
});

const embeddingKeys = [
  'embeddingUrl', 'embeddingModel', 'embeddingDimensions', 'embeddingInputVersion', 'embeddingContextTokens',
] as const;
const modelKeys = [...embeddingKeys, 'jevUrl', 'jevModel', 'piProvider', 'piModel'] as const;

export function embeddingConfigKey(settings: AppSettings): string {
  return createHash('sha256').update(JSON.stringify(embeddingKeys.map(key => settings[key]))).digest('hex');
}

async function configureEmbeddings(client: PoolClient, settings: AppSettings): Promise<void> {
  const key = embeddingConfigKey(settings);
  const current = await client.query<{ config_key: string }>(
    "SELECT config_key FROM embedding_configs WHERE status = 'active' FOR UPDATE",
  );
  await client.query("UPDATE embedding_configs SET status = 'retired' WHERE status = 'pending' AND config_key <> $1", [key]);
  if (current.rows[0]?.config_key === key) return;
  const status = current.rows.length ? 'pending' : 'active';
  await client.query(`INSERT INTO embedding_configs
    (config_key, model, endpoint, dimensions, input_version, context_tokens, status, activated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'active' THEN now() ELSE NULL END)
    ON CONFLICT (config_key) DO UPDATE SET status = EXCLUDED.status, activated_at = EXCLUDED.activated_at`,
  [key, settings.embeddingModel, settings.embeddingUrl, settings.embeddingDimensions,
    settings.embeddingInputVersion, settings.embeddingContextTokens, status]);
}

async function loadSettings(client: PoolClient): Promise<AppSettings> {
  await client.query('INSERT INTO app_settings (id, value) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
    [JSON.stringify(defaultSettings)]);
  const row = await client.query<{ value: unknown }>('SELECT value FROM app_settings WHERE id = 1 FOR UPDATE');
  const settings = validateSettings(row.rows[0]?.value);
  await configureEmbeddings(client, settings);
  return settings;
}

export async function getSettings(): Promise<AppSettings> {
  return transaction(loadSettings);
}

export async function saveSettings(input: unknown): Promise<AppSettings> {
  const patch = writableSchema.parse(input);
  return transaction(async client => {
    const previous = await loadSettings(client);
    const profileChanged = patch.interestProfile !== undefined && patch.interestProfile !== previous.interestProfile;
    const modelChanged = modelKeys.some(key => patch[key] !== undefined && patch[key] !== previous[key]);
    const next = validateSettings({
      ...previous, ...patch,
      profileVersion: previous.profileVersion + Number(profileChanged),
      modelVersion: previous.modelVersion + Number(modelChanged),
    });
    await client.query('UPDATE app_settings SET value = $1, updated_at = now() WHERE id = 1', [JSON.stringify(next)]);
    if (profileChanged || modelChanged) {
      await client.query('UPDATE stories SET interest_stale = true WHERE interest_stale = false');
    }
    await configureEmbeddings(client, next);
    return next;
  });
}

const embeddingConfigSchema = z.object({
  id: z.uuid(),
  config_key: z.string().min(1),
  model: name,
  endpoint,
  dimensions: z.number().int().positive(),
  input_version: name,
  context_tokens: positiveInteger,
});
export type ActiveEmbeddingConfig = z.infer<typeof embeddingConfigSchema>;

/** Retrieval clients must use this configuration, not pending saved model settings. */
export async function getActiveEmbeddingConfig(): Promise<ActiveEmbeddingConfig> {
  return transaction(async client => {
    await loadSettings(client);
    const result = await client.query<{ config: unknown }>(`SELECT jsonb_build_object(
      'id', id, 'config_key', config_key, 'model', model, 'endpoint', endpoint,
      'dimensions', dimensions, 'input_version', input_version, 'context_tokens', context_tokens
    ) AS config FROM embedding_configs WHERE status = 'active'`);
    return embeddingConfigSchema.parse(result.rows[0]?.config);
  });
}

// Explicit allowlist. Never spread an arbitrary stored object into an API response.
export function publicSettings(settings: AppSettings): AppSettings {
  return settingsSchema.parse(Object.fromEntries(
    Object.keys(settingsSchema.shape).map(key => [key, Reflect.get(settings, key)]),
  ));
}

/** Switch retrieval only after every retained, searchable story has a new embedding. */
export async function activateEmbeddingConfig(configId: string): Promise<void> {
  z.uuid().parse(configId);
  await transaction(async client => {
    const settings = await loadSettings(client);
    const config = await client.query<{ config_key: string; status: string }>(
      'SELECT config_key, status FROM embedding_configs WHERE id = $1 FOR UPDATE', [configId],
    );
    const candidate = config.rows[0];
    if (!candidate || candidate.config_key !== embeddingConfigKey(settings)) {
      throw new Error('Embedding configuration does not match saved settings');
    }
    if (candidate.status === 'active') return;
    if (candidate.status !== 'pending') throw new Error('Embedding configuration is not pending');
    const missing = await client.query<{ exists: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM stories s
      WHERE s.status <> 'rejected' AND EXISTS (
        SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id = m.revision_id
        JOIN source_items i ON i.id = r.item_id
        WHERE m.story_id = s.id AND i.retention_at >= now() - ($2 * interval '1 day')
      ) AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.story_id = s.id AND e.config_id = $1)
    ) AS exists`, [configId, settings.retentionDays]);
    if (missing.rows[0]?.exists) throw new Error('Active story corpus needs re-embedding');
    await client.query("UPDATE embedding_configs SET status = 'retired' WHERE status = 'active'");
    await client.query("UPDATE embedding_configs SET status = 'active', activated_at = now() WHERE id = $1", [configId]);
  });
}
