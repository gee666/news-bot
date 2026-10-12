import { afterEach, describe, expect, it, vi } from 'vitest';
import { failureMetadata, ModelRequestError, RequestFault, type ModelFailure } from '../models/errors.js';
import { embeddingChunks, EMBEDDING_CHUNK_BYTES, EMBEDDING_UNKNOWN_COOLDOWN_MS, normalizedMean, prepareEmbedding,
  type ChunkRecord, type ChunkEmbeddingStore } from './embedding-preparation.js';

const context = { id: 'operation', attempt: 1, batchId: null, revisionId: null, storyId: null };
afterEach(() => { vi.useRealTimers(); });
function memoryStore(): ChunkEmbeddingStore {
  const records = new Map<string, ChunkRecord>();
  return {
    read: async text => records.get(text),
    write: async (text, record) => { records.set(text, record); },
    remove: async text => { records.delete(text); },
  };
}
function refusal(kind: ModelFailure['kind'], outcome: ModelFailure['outcome']): ModelRequestError {
  return new ModelRequestError(failureMetadata(new RequestFault(kind, { outcome }), 'operation', 'embedding', 1, 0));
}

describe('whole-text embedding preparation', () => {
  it.each(['Release news. '.repeat(1800), 'Новость 🧑🏽‍💻 日本語\n\n'.repeat(1400)])(
    'covers every byte of long articles without breaking Unicode', text => {
      const chunks = embeddingChunks(text);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('')).toBe(text);
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(Buffer.from(text));
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(EMBEDDING_CHUNK_BYTES);
        expect(Buffer.from(chunk).toString('utf8')).toBe(chunk);
      }
      expect(embeddingChunks(text)).toEqual(chunks);
    });

  it('prefers paragraph ends and preserves their separators and whitespace', () => {
    const text = ' abc\n\ndefghijklm ';
    expect(embeddingChunks(text, 12)).toEqual([' abc\n\n', 'defghijklm ']);
    expect(embeddingChunks('😀😀😀', 4)).toEqual(['😀', '😀', '😀']);
    expect(() => embeddingChunks(text, 3)).toThrow();
  });

  it('normalizes the byte-length-weighted mean without changing dimensions', () => {
    const vector = normalizedMean([{ vector: [1, 0, 0], bytes: 3 }, { vector: [0, 1, 0], bytes: 4 }], 3);
    expect(vector).toHaveLength(3);
    expect(vector[0]).toBeCloseTo(0.6);
    expect(vector[1]).toBeCloseTo(0.8);
    expect(vector[2]).toBe(0);
    expect(Math.hypot(...vector)).toBeCloseTo(1);
    for (const value of normalizedMean([{ vector: [Number.MAX_VALUE, Number.MAX_VALUE], bytes: 1 }], 2)) {
      expect(value).toBeCloseTo(Math.SQRT1_2);
    }
  });

  it('rejects nonfinite, wrong-dimensional and zero means', () => {
    expect(() => normalizedMean([{ vector: [NaN, 1], bytes: 1 }], 2)).toThrow();
    expect(() => normalizedMean([{ vector: [1], bytes: 1 }], 2)).toThrow();
    expect(() => normalizedMean([{ vector: [0, 0], bytes: 1 }], 2)).toThrow();
    expect(() => normalizedMean([{ vector: [1, 0], bytes: 1 }, { vector: [-1, 0], bytes: 1 }], 2)).toThrow();
  });

  it('recursively splits only explicit rejected context limits, retaining all bytes', async () => {
    const store = memoryStore();
    const accepted: string[] = [];
    const text = Array.from({ length: 500 }, (_, index) => `Релиз😀 announcement ${index}\n\n`).join('');
    const embed = vi.fn(async (chunk: string) => {
      if (Buffer.byteLength(chunk) > 600) throw refusal('context_limit', 'rejected');
      accepted.push(chunk);
      return [1, 0, 0];
    });
    expect(await prepareEmbedding(text, 3, context, store, embed)).toEqual([1, 0, 0]);
    expect(accepted.join('')).toBe(text);
    const count = embed.mock.calls.length;
    expect(await prepareEmbedding(text, 3, context, store, embed)).toEqual([1, 0, 0]);
    expect(embed).toHaveBeenCalledTimes(count);
  });

  it.each([
    ['context_limit', 'unknown'], ['context_limit', 'not_submitted'],
    ['timeout', 'unknown'], ['authentication', 'rejected'], ['invalid_output', 'unknown'],
  ] satisfies [ModelFailure['kind'], ModelFailure['outcome']][])(
    'does not split %s with %s outcome', async (kind, outcome) => {
      const store = memoryStore();
      const error = refusal(kind, outcome);
      const embed = vi.fn(async () => { throw error; });
      await expect(prepareEmbedding('A full news article.', 2, context, store, embed))
        .rejects.toMatchObject({ metadata: { kind, outcome } });
      expect(embed).toHaveBeenCalledTimes(1);
      if (outcome === 'unknown') {
        await expect(prepareEmbedding('A full news article.', 2, context, store, embed))
          .rejects.toMatchObject({ metadata: { outcome: 'unknown', retryable: kind === 'timeout' } });
        expect(embed).toHaveBeenCalledTimes(1);
      }
    });

  it('reuses completed leaves and split decisions after a partial failure and restart', async () => {
    const store = memoryStore();
    const text = 'a'.repeat(2000) + 'b'.repeat(2000);
    const embed = vi.fn(async (chunk: string) => {
      if (chunk.length > 2000) throw refusal('context_limit', 'rejected');
      if (chunk.startsWith('b')) throw refusal('authentication', 'rejected');
      return [1, 0];
    });
    await expect(prepareEmbedding(text, 2, context, store, embed)).rejects.toBeInstanceOf(ModelRequestError);
    const resumed = vi.fn(async () => [0, 1]);
    for (const value of await prepareEmbedding(text, 2, context, store, resumed)) {
      expect(value).toBeCloseTo(Math.SQRT1_2);
    }
    expect(resumed.mock.calls).toHaveLength(1);
  });

  it('bounds recursion when the provider rejects even the smallest chunk', async () => {
    const embed = vi.fn(async () => { throw refusal('context_limit', 'rejected'); });
    await expect(prepareEmbedding('😀😀', 2, context, memoryStore(), embed)).rejects.toThrow('indivisible');
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it.each([5_000, 600_000])('recovers an unknown 503 after cooldown and provider retry time %i', async delay => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = memoryStore();
    const failure = new ModelRequestError(failureMetadata(new RequestFault('transient', {
      status: 503, outcome: 'unknown', retryAt: Date.now() + delay,
    }), context.id, 'embedding', 1, 0));
    const embed = vi.fn<(text: string, attempt: number) => Promise<number[]>>(async () => [1, 0]);
    embed.mockRejectedValueOnce(failure);
    const retryAt = Date.now() + Math.max(delay, EMBEDDING_UNKNOWN_COOLDOWN_MS);
    await expect(prepareEmbedding('News', 2, context, store, embed))
      .rejects.toMatchObject({ metadata: { retryable: true, nextRetryAt: new Date(retryAt).toISOString() } });
    expect(await store.read('News')).toMatchObject({ status: 'failed', kind: 'transient', attempt: 1, retryAt });
    vi.setSystemTime(retryAt - 1);
    await expect(prepareEmbedding('News', 2, { ...context, attempt: 2 }, store, embed))
      .rejects.toMatchObject({ metadata: { retryable: true } });
    expect(embed).toHaveBeenCalledTimes(1);
    vi.setSystemTime(retryAt);
    expect(await prepareEmbedding('News', 2, { ...context, attempt: 2 }, store, embed)).toEqual([1, 0]);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenLastCalledWith('News', 2);
    await prepareEmbedding('News', 2, context, store, embed);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('does not immediately resubmit unknown timeouts and keeps completed leaves on recovery', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const text = 'a'.repeat(4096) + 'b'.repeat(100);
    const embed = vi.fn<(text: string, attempt: number) => Promise<number[]>>(async () => [1, 0]);
    embed.mockResolvedValueOnce([1, 0]).mockRejectedValueOnce(refusal('timeout', 'unknown'));
    await expect(prepareEmbedding(text, 2, context, store, embed)).rejects.toBeInstanceOf(ModelRequestError);
    await expect(prepareEmbedding(text, 2, { ...context, attempt: 2 }, store, embed)).rejects.toBeInstanceOf(ModelRequestError);
    expect(embed).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(EMBEDDING_UNKNOWN_COOLDOWN_MS);
    expect(await prepareEmbedding(text, 2, { ...context, attempt: 2 }, store, embed)).toEqual([1, 0]);
    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed).toHaveBeenLastCalledWith('b'.repeat(100), 2);
  });

  it('bounds shared chunk recovery even when a new caller keeps supplying attempt one', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const embed = vi.fn<(text: string, attempt: number) => Promise<number[]>>(async () => { throw refusal('transient', 'unknown'); });
    const policy = { timeoutMs: 600_000, requestMaxAttempts: 2 };
    await expect(prepareEmbedding('News', 2, context, store, embed, policy)).rejects.toBeInstanceOf(ModelRequestError);
    vi.advanceTimersByTime(EMBEDDING_UNKNOWN_COOLDOWN_MS);
    await expect(prepareEmbedding('News', 2, context, store, embed, policy))
      .rejects.toMatchObject({ metadata: { retryable: false, nextRetryAt: null } });
    vi.advanceTimersByTime(10_000_000);
    await expect(prepareEmbedding('News', 2, context, store, embed, policy))
      .rejects.toMatchObject({ metadata: { retryable: false } });
    expect(embed.mock.calls.map(([, attempt]) => attempt)).toEqual([1, 2]);
  });

  it('honors the cumulative caller attempt budget before submitting a new leaf', async () => {
    const embed = vi.fn(async () => [1, 0]);
    await expect(prepareEmbedding('News', 2, { ...context, attempt: 6 }, memoryStore(), embed))
      .rejects.toMatchObject({ metadata: { retryable: false } });
    expect(embed).not.toHaveBeenCalled();
  });

  it('recovers crash markers only after the request deadline plus cooldown', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const retryAt = Date.now() + 1_200_000 + EMBEDDING_UNKNOWN_COOLDOWN_MS;
    await store.write('News', { status: 'submitted', attempt: 2, retryAt });
    const embed = vi.fn<(text: string, attempt: number) => Promise<number[]>>(async () => [1, 0]);
    vi.setSystemTime(retryAt - 1);
    await expect(prepareEmbedding('News', 2, context, store, embed))
      .rejects.toMatchObject({ metadata: { outcome: 'unknown', retryable: true, nextRetryAt: new Date(retryAt).toISOString() } });
    expect(embed).not.toHaveBeenCalled();
    vi.setSystemTime(retryAt);
    expect(await prepareEmbedding('News', 2, context, store, embed)).toEqual([1, 0]);
    expect(embed).toHaveBeenCalledExactlyOnceWith('News', 3);
  });

  it('upgrades legacy crash markers without resetting their recovery deadline on each read', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    await store.write('News', { status: 'submitted' });
    const embed = vi.fn(async () => [1, 0]);
    await expect(prepareEmbedding('News', 2, context, store, embed)).rejects.toMatchObject({ metadata: { outcome: 'unknown' } });
    expect(embed).not.toHaveBeenCalled();
    const retryAt = Date.now() + 600_000 + EMBEDDING_UNKNOWN_COOLDOWN_MS;
    expect(await store.read('News')).toMatchObject({ status: 'submitted', retryAt });
    vi.setSystemTime(retryAt - 1);
    await expect(prepareEmbedding('News', 2, context, store, embed)).rejects.toBeInstanceOf(ModelRequestError);
    expect(await store.read('News')).toMatchObject({ retryAt });
    vi.setSystemTime(retryAt);
    expect(await prepareEmbedding('News', 2, context, store, embed)).toEqual([1, 0]);
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
