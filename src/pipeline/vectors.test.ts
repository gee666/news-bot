import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { failureMetadata, ModelRequestError, RequestFault } from '../models/errors.js';
import type { StageContext } from './state.js';
import type { ActiveEmbeddingConfig } from '../settings.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn<(sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  embed: vi.fn<(texts: readonly string[]) => Promise<{ vectors: number[][] }>>(),
  approve: vi.fn(),
  stages: new Map<string, unknown>(),
}));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  embed = mocks.embed;
  close = async (): Promise<void> => {};
} }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: mocks.approve }));
vi.mock('./state.js', () => ({
  hash: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  recordFailure: vi.fn(),
  stage: async (_batch: string, _owner: unknown, name: string, _settings: unknown, _validator: unknown,
    run: (context: StageContext) => Promise<unknown>) => {
    if (!name.startsWith('embed:')) return 'story';
    if (mocks.stages.has(name)) return mocks.stages.get(name);
    const vector = await run(context);
    mocks.stages.set(name, vector);
    return vector;
  },
}));
import { defaultSettings } from '../settings.js';
import { Vectors } from './vectors.js';
import { EMBEDDING_INPUT_VERSION } from './embedding-preparation.js';
import { matchBatch } from './matching.js';

const context: StageContext = { id: 'operation', attempt: 1, batchId: null, revisionId: null, storyId: null };
const config: ActiveEmbeddingConfig = {
  id: '00000000-0000-4000-8000-000000000001', config_key: 'v2-config', model: 'exact-model',
  endpoint: 'http://localhost:11434', dimensions: 3, input_version: EMBEDDING_INPUT_VERSION, context_tokens: 2048,
};
let cache: Map<string, unknown>;
afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  cache = new Map();
  mocks.stages.clear();
  mocks.query.mockReset();
  mocks.embed.mockReset();
  mocks.approve.mockReset();
  mocks.embed.mockImplementation(async texts => ({ vectors: texts.map(() => [1, 0, 0]) }));
  mocks.query.mockImplementation(async (sql, args = []) => {
    const key = JSON.stringify(args.slice(0, 3));
    if (sql.startsWith('SELECT value')) return { rows: cache.has(key) ? [{ value: cache.get(key) }] : [] };
    if (sql.startsWith('INSERT INTO model_cache')) cache.set(key, JSON.parse(String(args[3])));
    if (sql.startsWith('DELETE FROM model_cache')) cache.delete(key);
    return { rows: [] };
  });
});

describe('versioned embedding persistence', () => {
  it('caches leaves and the final vector and reuses them through a new Vectors instance', async () => {
    const text = Array.from({ length: 1000 }, (_, index) => `News 😀 full article ${index}\n\n`).join('');
    const vectors = new Vectors(config, defaultSettings);
    const result = await vectors.save({ mentionId: 'mention' }, text, context);
    expect(result).toEqual([1, 0, 0]);
    expect(mocks.embed.mock.calls.map(([texts]) => texts[0]).join('')).toBe(text);
    expect(mocks.embed.mock.calls.length).toBeGreaterThan(1);
    expect([...cache.values()].filter(value => Array.isArray(value))).toHaveLength(1);
    await vectors.close();
    const count = mocks.embed.mock.calls.length;
    const restarted = new Vectors(config, defaultSettings);
    expect(await restarted.save({ storyId: 'story' }, text, context)).toEqual(result);
    expect(mocks.embed).toHaveBeenCalledTimes(count);
    // Losing only the aggregate still reuses every completed leaf.
    for (const [key, value] of cache) if (Array.isArray(value)) cache.delete(key);
    expect(await restarted.save({ storyId: 'story' }, text, context)).toEqual(result);
    expect(mocks.embed).toHaveBeenCalledTimes(count);
    await restarted.close();
  });

  it('does not retrieve cached embeddings across configs or versions', async () => {
    await new Vectors(config, defaultSettings).save({ mentionId: 'mention' }, 'Release.', context);
    await new Vectors({ ...config, config_key: 'other-endpoint' }, defaultSettings)
      .save({ mentionId: 'mention' }, 'Release.', context);
    await new Vectors({ ...config, config_key: 'v1', input_version: 'mention-v1' }, defaultSettings)
      .save({ mentionId: 'mention' }, 'Release.', context);
    expect(mocks.embed).toHaveBeenCalledTimes(3);
  });

  it('keeps legacy preparation unchanged, including arbitrary existing version tags', async () => {
    const text = 'legacy '.repeat(1500);
    mocks.embed.mockResolvedValue({ vectors: [[2, 0, 0]] });
    for (const version of ['mention-v1', 'existing-custom-tag']) {
      expect(await new Vectors({ ...config, input_version: version, config_key: version }, defaultSettings)
        .save({ mentionId: 'mention' }, text, context)).toEqual([2, 0, 0]);
    }
    expect(mocks.embed.mock.calls.map(([texts]) => texts)).toEqual([[text], [text]]);
  });

  it('does not return the old mention stage vector after switching to the active v2 config', async () => {
    const mention = { id: 'mention', revision_id: 'revision', story_id: null, text: 'News release.' };
    const query = mocks.query.getMockImplementation();
    if (!query) throw new Error('Missing query mock');
    mocks.query.mockImplementation(async (sql, args) => sql.startsWith('SELECT m.id,m.revision_id')
      ? { rows: [mention] } : query(sql, args));
    mocks.stages.set('embed:mention', [9, 9, 9]);
    mocks.stages.set('embed:v1-config:mention', [2, 0, 0]);
    const vectors = new Vectors(config, defaultSettings);
    try { await matchBatch('batch', defaultSettings, vectors); }
    finally { await vectors.close(); }
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.stages.get('embed:v2-config:mention')).toEqual([1, 0, 0]);
    expect(mocks.stages.get('embed:v1-config:mention')).toEqual([2, 0, 0]);
  });

  it('persists a 503 cooldown through restart and resumes once without losing completed leaves', async () => {
    vi.useFakeTimers();
    const text = 'a'.repeat(4096) + 'b'.repeat(100);
    const failure = new ModelRequestError(failureMetadata(new RequestFault('transient', {
      status: 503, outcome: 'unknown',
    }), context.id, 'embedding', 1, 0));
    mocks.embed.mockResolvedValueOnce({ vectors: [[1, 0, 0]] }).mockRejectedValueOnce(failure);
    const settings = { ...defaultSettings, embeddingTimeoutMs: 1_200_000, requestMaxAttempts: 3 };
    const original = new Vectors(config, settings);
    await expect(original.save({ mentionId: 'mention' }, text, context)).rejects.toMatchObject({
      metadata: { retryable: true, nextRetryAt: new Date(Date.now() + 300_000).toISOString() },
    });
    expect([...cache.values()]).toContainEqual(expect.objectContaining({ status: 'failed', attempt: 1 }));
    const submitted = mocks.query.mock.calls.find(([sql, args]) => sql.startsWith('INSERT INTO model_cache')
      && String(args?.[3]).includes('submitted'));
    expect(JSON.parse(String(submitted?.[1]?.[3]))).toMatchObject({ retryAt: Date.now() + 1_500_000 });
    await original.close();
    const restarted = new Vectors(config, settings);
    await expect(restarted.save({ mentionId: 'mention' }, text, { ...context, attempt: 2 }))
      .rejects.toMatchObject({ metadata: { retryable: true } });
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300_000);
    expect(await restarted.save({ mentionId: 'mention' }, text, { ...context, attempt: 2 })).toEqual([1, 0, 0]);
    expect(mocks.embed).toHaveBeenCalledTimes(3);
    expect(mocks.embed).toHaveBeenLastCalledWith(['b'.repeat(100)], { operationId: context.id, attempt: 2 });
    await restarted.save({ mentionId: 'mention' }, text, context);
    expect(mocks.embed).toHaveBeenCalledTimes(3);
    await restarted.close();
  });

  it('requires the fixed model context', () => {
    expect(() => new Vectors({ ...config, context_tokens: 4096 }, defaultSettings)).toThrow('2048');
  });
});
