import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { ModelRequestError, type ModelFailure } from '../models/index.js';
import { failureResponseMetadata } from '../models/errors.js';
import type { AppSettings } from '../settings.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';
import { checkProcessingSlice, processingSliceMs, ProcessingYield } from './processing-slice.js';
import { StoryIntegrityError } from './event-integrity-error.js';
import { StageOutputError, validateStageOutput } from './stage-output-error.js';

export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface StageContext { id: string; attempt: number; batchId: string | null; revisionId: string | null; storyId: string | null }
const stageSchema = z.object({ id: z.uuid(), status: z.enum(['pending','running','waiting','completed','failed','skipped']),
  attempts: z.number().int().nonnegative(), output: z.unknown(), next_retry_at: z.date().nullable(), error_code: z.string().nullable().default(null) });
export class Waiting extends Error {}
export class FailedStageError extends Error {
  constructor(readonly code: string) { super('Stage retry limit reached.'); }
}
export interface StoryCompletionChecks {
  generationCurrent: boolean; eligibilityCurrent: boolean; rankingCurrent: boolean;
  representativePresent: boolean; headlinePresent: boolean; unblocked: boolean;
}
export class StoryCompletionError extends Error {
  readonly code = 'story_completion_invariant';
  constructor(readonly storyId: string, readonly checks: StoryCompletionChecks) {
    super(`Story completion invariant failed: ${JSON.stringify({ storyId, checks })}`);
  }
}

export async function recordFailure(failure: ModelFailure): Promise<void> {
  await db.query(`INSERT INTO request_attempts (stage_id,provider,operation,attempt_number,status,
    dispatched_at,finished_at,next_retry_at,error_code,response_metadata)
    VALUES ((SELECT id FROM stage_state WHERE id::text=$1),$2,$1,$3,$4,$5,$6,$7,$8,$9)`,
  [failure.operationId, failure.service, failure.attempt,
    failure.outcome === 'unknown' ? 'unknown' : failure.retryable ? 'retryable' : 'failed',
    new Date(Date.parse(failure.failedAt) - failure.durationMs), failure.failedAt, failure.nextRetryAt, failure.kind,
    JSON.stringify(failureResponseMetadata(failure))]);
}

export function retryDecision(error: unknown, attempt: number, settings: AppSettings): { next: Date | null; code: string; unknown: boolean; reason: string } {
  const delay = Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.max(0, attempt - 1));
  const model = error instanceof ModelRequestError ? error.metadata : null;
  const known = error instanceof StageOutputError || error instanceof StoryCompletionError || error instanceof StoryIntegrityError;
  const permanent = model && ['authentication','model_unavailable','invalid_request','context_limit','cancelled','unknown'].includes(model.kind);
  return {
    next: !permanent && attempt < settings.requestMaxAttempts && !(error instanceof FailedStageError)
      ? new Date(Math.max(Date.now() + delay, Date.parse(model?.nextRetryAt ?? '') || 0)) : null,
    code: model?.kind ?? (known || error instanceof FailedStageError ? error.code : 'pipeline_failed'),
    unknown: model?.outcome === 'unknown',
    reason: model?.message ?? (known ? error.message : 'Processing failed.'),
  };
}

export async function stage<T>(batchId: string, owner: { revisionId: string },
  name: string, settings: AppSettings, validator: z.ZodType<T>, run: (context: StageContext) => Promise<T>): Promise<T> {
  const { revisionId } = owner;
  const storyId = null;
  await db.query(`INSERT INTO stage_state(batch_id,revision_id,story_id,stage) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [batchId, revisionId, storyId, name]);
  const selected = await db.query(`SELECT id,status,attempts,output,next_retry_at,error_code FROM stage_state
    WHERE batch_id=$1 AND revision_id IS NOT DISTINCT FROM $2::uuid AND story_id IS NOT DISTINCT FROM $3::uuid AND stage=$4`,
  [batchId, revisionId, storyId, name]);
  let saved = stageSchema.parse(selected.rows[0]);
  // A revision can belong to several collection snapshots. They share one retry
  // budget and inference receipt rather than buying fresh attempts per batch.
  // Reconciliation reads mutable story state, so it must run for each snapshot.
  if (name!=='reconcile_edit' && saved.status!=='completed') {
    const previous = await db.query(`SELECT id,status,attempts,output,next_retry_at,error_code FROM stage_state
      WHERE revision_id=$1 AND stage=$2 AND batch_id<>$3 AND status IN ('completed','waiting','failed')
      ORDER BY (status='completed') DESC,attempts DESC,updated_at DESC LIMIT 1`, [revisionId,name,batchId]);
    const receipt = previous.rows.length ? stageSchema.parse(previous.rows[0]) : undefined;
    if (receipt && (receipt.status==='completed' || receipt.attempts>saved.attempts || (saved.status==='pending' && saved.attempts===0))) {
      saved = { ...saved, status: receipt.status, attempts: Math.max(saved.attempts,receipt.attempts),
        output: receipt.output, next_retry_at: receipt.next_retry_at, error_code: receipt.error_code };
      await db.query(`UPDATE stage_state SET status=$2,attempts=$3,output=$4,next_retry_at=$5,error_code=$6,updated_at=now()
        WHERE id=$1`, [saved.id,saved.status,saved.attempts,JSON.stringify(saved.output),saved.next_retry_at,saved.error_code]);
    }
  }
  if (saved.status === 'completed') {
    try { return validateStageOutput(validator, saved.output); }
    catch (error) {
      await saveStageFailure(error, saved.id, saved.attempts + 1, { batchId, storyId, revisionId, task: name.split(':')[0] ?? '' }, settings);
      throw error;
    }
  }
  if (saved.next_retry_at && saved.next_retry_at.getTime() > Date.now()) throw new Waiting('Waiting for saved retry time');
  if (saved.status === 'failed') throw new FailedStageError(saved.error_code ?? 'pipeline_failed');
  checkProcessingSlice();
  const context = { id: saved.id, attempt: saved.attempts + 1, batchId, revisionId, storyId };
  await db.query(`UPDATE stage_state SET status='running',started_at=now(),updated_at=now() WHERE id=$1`, [saved.id]);
  try {
    const output = validateStageOutput(validator, await run(context));
    await db.query(`UPDATE stage_state SET status='completed',output=$2,completed_at=now(),updated_at=now(),
      next_retry_at=NULL,waiting_reason=NULL,error_code=NULL,outcome_unknown=false WHERE id=$1`, [saved.id, JSON.stringify(output)]);
    return output;
  } catch (error) {
    if (error instanceof ProcessingYield) {
      // A long comparison keeps its receipts but yields its place to ready siblings.
      await db.query(`UPDATE stage_state SET status='waiting',next_retry_at=now()+$2*interval '1 millisecond',
        error_code=NULL,waiting_reason='Processing checkpoint reached.',updated_at=now() WHERE id=$1`,
      [saved.id, Math.max(settings.retryBaseMs, processingSliceMs())]);
    } else {
      await saveStageFailure(error, saved.id, context.attempt, { batchId, storyId, revisionId, task: name.split(':')[0] ?? '' }, settings);
    }
    throw error;
  }
}

async function saveStageFailure(error: unknown, stageId: string, attempt: number,
  owner: { batchId: string; storyId: string | null; revisionId: string | null; task: string }, settings: AppSettings): Promise<void> {
  await recordProcessingDiagnostic(error instanceof StageOutputError ? error.cause : error, { scope: 'stage', ...owner, stageId });
  const failure = retryDecision(error, attempt, settings);
  await db.query(`UPDATE stage_state SET attempts=attempts+1,status=$2,next_retry_at=$3,error_code=$4,outcome_unknown=$5,
    waiting_reason=$6,updated_at=now() WHERE id=$1`,
  [stageId, failure.next ? 'waiting' : 'failed', failure.next, failure.code, failure.unknown, failure.reason]);
}
