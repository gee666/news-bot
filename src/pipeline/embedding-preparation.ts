import { z } from 'zod';
import { failureMetadata, ModelRequestError, RequestFault } from '../models/errors.js';
import type { StageContext } from './state.js';

export const EMBEDDING_INPUT_VERSION = 'mention-chunks-v2';
// Byte bounds are deterministic, not a tokenizer estimate. Explicit provider refusals can split further.
export const EMBEDDING_CHUNK_BYTES = 4096;
const MAX_SPLIT_DEPTH = 12;
export const EMBEDDING_UNKNOWN_COOLDOWN_MS = 300_000;
export interface EmbeddingRetryPolicy { timeoutMs: number; requestMaxAttempts: number }
const defaultRetryPolicy: EmbeddingRetryPolicy = { timeoutMs: 600_000, requestMaxAttempts: 5 };

export function embeddingChunks(text: string, maxBytes = EMBEDDING_CHUNK_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('Chunk bound must be at least four bytes');
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    let paragraphEnd = start;
    for (const character of text.slice(start)) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += character.length;
      if (character === '\n' && text[end - 2] === '\n') paragraphEnd = end;
    }
    if (end < text.length && paragraphEnd > start) end = paragraphEnd;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export interface WeightedEmbedding { vector: number[]; bytes: number }
export function normalizedMean(leaves: readonly WeightedEmbedding[], dimensions: number): number[] {
  const validator = z.array(z.number().finite()).length(dimensions);
  if (!leaves.length) throw new Error('No embedding chunks');
  const total = leaves.reduce((sum, leaf) => sum + leaf.bytes, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('Invalid embedding weight');
  const scale = leaves.reduce((largest, leaf) => {
    validator.parse(leaf.vector);
    if (!Number.isFinite(leaf.bytes) || leaf.bytes <= 0) throw new Error('Invalid embedding weight');
    return leaf.vector.reduce((max, value) => Math.max(max, Math.abs(value)), largest);
  }, 0);
  if (!scale) throw new Error('Zero embedding vector');
  const mean = Array.from({ length: dimensions }, (_, index) => leaves.reduce(
    (sum, leaf) => sum + ((leaf.vector[index] ?? 0) / scale) * (leaf.bytes / total), 0));
  const norm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || !norm) throw new Error('Zero embedding mean');
  return validator.parse(mean.map(value => value / norm));
}

const chunkRecordSchema = z.discriminatedUnion('status', [
  // Older markers have no deadline. On first read, start a conservative recovery window.
  z.object({ status: z.literal('submitted'), attempt: z.number().int().positive().optional(),
    retryAt: z.number().finite().nonnegative().optional() }),
  z.object({ status: z.literal('failed'), attempt: z.number().int().positive(),
    retryAt: z.number().finite().nonnegative(), retryable: z.boolean(),
    kind: z.enum(['authentication', 'model_unavailable', 'invalid_request', 'context_limit',
      'throttled', 'transient', 'timeout', 'cancelled', 'invalid_output', 'unknown']),
    outcome: z.enum(['not_submitted', 'rejected', 'unknown']) }),
  z.object({ status: z.literal('split') }),
  z.object({ status: z.literal('completed'), vector: z.array(z.number().finite()) }),
]);
export type ChunkRecord = z.infer<typeof chunkRecordSchema>;
export interface ChunkEmbeddingStore {
  read(text: string): Promise<unknown | undefined>;
  write(text: string, value: ChunkRecord): Promise<void>;
  remove(text: string): Promise<void>;
}

/** Persist deadlines and attempts before dispatch. Recovery waits without holding an inference slot. */
export async function prepareEmbedding(text: string, dimensions: number, context: StageContext,
  store: ChunkEmbeddingStore, embed: (text: string, attempt: number) => Promise<number[]>,
  policy: EmbeddingRetryPolicy = defaultRetryPolicy): Promise<number[]> {
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0
    || !Number.isSafeInteger(policy.requestMaxAttempts) || policy.requestMaxAttempts <= 0) {
    throw new Error('Invalid embedding retry policy');
  }
  const validator = z.array(z.number().finite()).length(dimensions);
  const leaves: WeightedEmbedding[] = [];
  const visit = async (chunk: string, depth: number): Promise<void> => {
    const saved = await store.read(chunk);
    const record = saved === undefined ? undefined : chunkRecordSchema.parse(saved);
    if (record?.status === 'completed') {
      leaves.push({ vector: validator.parse(record.vector), bytes: Buffer.byteLength(chunk, 'utf8') });
      return;
    }
    let attempt = context.attempt;
    if (record?.status === 'submitted' || record?.status === 'failed') {
      const previousAttempt = record.attempt ?? 1;
      const retryAt = record.retryAt ?? Date.now() + policy.timeoutMs + EMBEDDING_UNKNOWN_COOLDOWN_MS;
      if (record.status === 'submitted' && record.retryAt === undefined) {
        await store.write(chunk, { status: 'submitted', attempt: previousAttempt, retryAt });
      }
      attempt = Math.max(attempt, previousAttempt + 1);
      const retryable = attempt <= policy.requestMaxAttempts
        && (record.status === 'submitted' || record.retryable);
      if (!retryable || Date.now() < retryAt) {
        const metadata = failureMetadata(new RequestFault(record.status === 'failed' ? record.kind : 'timeout', {
          outcome: record.status === 'failed' ? record.outcome : 'unknown',
        }), context.id, 'embedding', context.attempt, 0);
        throw new ModelRequestError({ ...metadata, retryable,
          nextRetryAt: retryable ? new Date(retryAt).toISOString() : null });
      }
    }
    if (record?.status !== 'split') {
      if (attempt > policy.requestMaxAttempts) {
        throw new ModelRequestError({ ...failureMetadata(new RequestFault('transient', { outcome: 'not_submitted' }),
          context.id, 'embedding', context.attempt, 0), retryable: false, nextRetryAt: null });
      }
      await store.write(chunk, { status: 'submitted', attempt,
        retryAt: Date.now() + policy.timeoutMs + EMBEDDING_UNKNOWN_COOLDOWN_MS });
      let vector: number[];
      try { vector = validator.parse(await embed(chunk, attempt)); }
      catch (error) {
        if (!(error instanceof ModelRequestError)) throw error;
        const failure = error.metadata;
        if (failure.kind !== 'context_limit' || failure.outcome !== 'rejected') {
          if (failure.outcome !== 'unknown' && !failure.retryable) {
            await store.remove(chunk);
            throw error;
          }
          const retryAt = Math.max(Date.now() + (failure.outcome === 'unknown' ? EMBEDDING_UNKNOWN_COOLDOWN_MS : 0),
            Date.parse(failure.nextRetryAt ?? '') || 0);
          const retryable = failure.retryable && attempt < policy.requestMaxAttempts;
          await store.write(chunk, { status: 'failed', attempt, retryAt, retryable,
            kind: failure.kind, outcome: failure.outcome });
          throw new ModelRequestError({ ...failure, retryable,
            nextRetryAt: retryable ? new Date(retryAt).toISOString() : null });
        }
        await store.write(chunk, { status: 'split' });
        return split(chunk, depth);
      }
      await store.write(chunk, { status: 'completed', vector });
      leaves.push({ vector, bytes: Buffer.byteLength(chunk, 'utf8') });
      return;
    }
    await split(chunk, depth);
  };
  const split = async (chunk: string, depth: number): Promise<void> => {
    if (depth >= MAX_SPLIT_DEPTH) throw new Error('Embedding chunk split limit reached');
    const bound = Math.max(4, Math.floor(Buffer.byteLength(chunk, 'utf8') / 2));
    const children = embeddingChunks(chunk, bound);
    if (children.length < 2) throw new Error('Embedding context rejected an indivisible chunk');
    for (const child of children) await visit(child, depth + 1);
  };
  for (const chunk of embeddingChunks(text)) await visit(chunk, 0);
  return normalizedMean(leaves, dimensions);
}
