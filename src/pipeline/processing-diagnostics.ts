import { z } from 'zod';
import { db } from '../db.js';
import { ModelRequestError } from '../models/index.js';
import { EVENT_INTEGRITY_FAILED } from './event-integrity-error.js';

const localCodes = new Map([
  ['Evidence changed during generation', 'evidence_changed_during_generation'],
  ['Story changed during generation', 'story_changed_during_generation'],
  ['Story changed during eligibility judgment', 'story_changed_during_eligibility'],
  ['Story disappeared during refresh', 'story_disappeared_during_refresh'],
  ['Missing representative', 'missing_representative'], ['Story has no mentions', 'missing_mentions'],
  ['Generation result has no matching input', 'generation_input_missing'],
  ['Evidence result failed reference validation', 'evidence_reference_invalid'],
  ['Unknown evidence handle', 'evidence_handle_unknown'],
  ['Verified citations are incomplete', 'citations_incomplete'],
  ['Cannot complete citations for unsupported text', 'citations_unsupported'],
  ['Cannot budget an unscored story', 'story_unscored'],
]);
const declaredCodes = new Set([...localCodes.values(), 'story_completion_invariant', EVENT_INTEGRITY_FAILED]);
const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'ZodError', 'AggregateError', 'DatabaseError', 'StoryIntegrityError', 'error']);
const sqlStates = new Set(['23505', '23503', '23502', '23514', '23P01', '40001', '40P01', '22001', '22P02',
  '22000', '22003', '22007', '22008', '22012', '42703', '42P01', '42804', '42601', '42501', '53300', '53400',
  '57014', '57P01', '57P03', '08006', '25P02', '53100', '53200', '54000', '55000', 'P0001', 'XX000']);
const constraints = new Set(['one_active_batch', 'one_active_embedding_config', 'one_pending_embedding_config',
  'publication_story_destination', 'current_revision_owner', 'stories_pkey', 'stage_state_pkey', 'batch_items_pkey',
  'processing_batches_pkey', 'source_items_pkey', 'item_revisions_pkey', 'evidence_documents_pkey', 'story_evidence_pkey',
  'model_cache_pkey', 'source_items_source_id_external_id_key', 'item_revisions_item_id_revision_number_key',
  'batch_items_batch_id_fkey', 'batch_items_revision_id_fkey', 'story_evidence_story_id_fkey', 'story_evidence_evidence_id_fkey',
  'stage_state_batch_id_revision_id_story_id_stage_key', 'stage_state_check', 'stage_state_batch_id_fkey',
  'stage_state_story_id_fkey', 'stage_state_revision_id_fkey', 'stories_interest_score_check',
  'model_cache_kind_input_hash_model_key_prompt_version_key', 'story_evidence_role_check', 'story_evidence_relevance_check',
  'item_revisions_item_id_content_hash_key', 'story_mentions_revision_id_ordinal_key']);
const pipelineFiles = `batches state stories story-postconditions story-failures processing-settings item-failures eligibility judgments
  generation generation-store generation-freshness generation-model generation-budget generation-verification
  evidence-brief evidence-brief-cache evidence-brief-schema evidence-brief-wire evidence-brief-resolution
  evidence-brief-identity evidence-brief-framing evidence-brief-completeness evidence-brief-verification
  evidence-brief-event-constraints evidence-brief-commercial-terms evidence-brief-measures evidence-brief-quotes
  evidence-brief-disposition evidence-verification-wire research research-fetch research-page research-search
  research-queries research-priority source-links grouping-model
  collection extraction extraction-store extraction-model extraction-boundaries matching historical-input revisions vectors event-integrity-error
  embedding-preparation consolidation consolidation-input consolidation-store operational
  privacy crawler-client processing-slice lease index retention`.split(/\s+/u);
const modelFiles = 'pi pi-runtime pi-failure errors jev embedding http inference structured structured-diagnostics provider-diagnostics'.split(' ');
const publishingFiles = 'ordering reconciliation repair preview store digest bot-api source-relevance delivery preview-sources index maintenance sources render updates'.split(' ');
const files = new Set(['db', 'settings', ...pipelineFiles.map(file => `pipeline/${file}`),
  ...modelFiles.map(file => `models/${file}`), ...publishingFiles.map(file => `publishing/${file}`)]);
const issueCodes = new Set(['invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of',
  'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom']);
const pathFields = new Set(`id storyId revisionId batchId status contentVersion profileVersion modelVersion
  headline summary translatedExcerpt chosen_excerpt content_version interest_score interest_stale
  facts claims nodes edges entities quotes references sources evidence evidenceContract verification supported
  sourceId evidenceId quote text result confidence score eligible version prompt_version input_hash
  fields citations commercialTerms measures subject predicate object value`.split(/\s+/u));
const operations = new Set(['pipeline_digest', 'pipeline_reembedding', 'pipeline_launch']);
const tasks = new Set(['research', 'representative', 'interest', 'story_embedding', 'news-eligibility-v3',
  'count', 'extract', 'item_eligibility', 'links', 'match', 'consolidate', 'source_links', 'reconcile_edit']);

export interface DiagnosticContext {
  scope: 'stage' | 'batch' | 'operation' | 'story';
  batchId?: string | null; storyId?: string | null; revisionId?: string | null;
  stageId?: string | null; task?: string; operation?: string;
}
function property(error: unknown, key: string): unknown {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  try { return Reflect.get(error, key); } catch { return undefined; }
}
function allowed(value: unknown, values: Set<string>): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined;
}
function uuid(value: unknown): string | null {
  const parsed = z.uuid().safeParse(value); return parsed.success ? parsed.data : null;
}
function frames(error: unknown): Array<{ file: string; line: number; column: number }> {
  const stack = property(error, 'stack');
  if (typeof stack !== 'string') return [];
  return stack.slice(0, 16_000).split('\n').slice(1, 25).flatMap(frame => {
    if (!/^\s+at\s/u.test(frame)) return [];
    const match = /\/(src|dist)\/([a-z0-9/-]+)\.(ts|js):([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/u.exec(frame);
    if (!match || !files.has(match[2] ?? '')) return [];
    return [{ file: `${match[1]}/${match[2]}.${match[3]}`, line: Number(match[4]), column: Number(match[5]) }];
  }).slice(0, 8);
}

export function processingDiagnostic(error: unknown) {
  const message = property(error, 'message');
  const code = allowed(property(error, 'code'), declaredCodes)
    ?? (typeof message === 'string' ? localCodes.get(message) : undefined) ?? 'pipeline_failed';
  const issues = error instanceof z.ZodError ? error.issues.slice(0, 12).map(issue => ({
    code: allowed(issue.code, issueCodes) ?? 'unknown',
    path: issue.path.slice(0, 8).map(part => typeof part === 'number' ? '[]' : allowed(part, pathFields) ?? '<redacted>'),
  })) : [];
  return { code, errorName: allowed(property(error, 'name'), errorNames) ?? 'UnknownError',
    sqlState: allowed(property(error, 'code'), sqlStates), constraint: allowed(property(error, 'constraint'), constraints),
    frames: frames(error), issues };
}

/** Internal only. A failed diagnostic write must never replace the original exception. */
export async function recordProcessingDiagnostic(error: unknown, context: DiagnosticContext): Promise<void> {
  try {
    if (error instanceof ModelRequestError) return;
    const safeContext = { scope: context.scope, batchId: uuid(context.batchId), storyId: uuid(context.storyId),
      revisionId: uuid(context.revisionId), stageId: uuid(context.stageId),
      task: allowed(context.task, tasks), operation: allowed(context.operation, operations) };
    const owner = safeContext.stageId ?? safeContext.batchId ?? safeContext.storyId ?? safeContext.operation ?? 'unknown';
    await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key)
      DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [`pipeline_error:${context.scope}:${owner}`,
      JSON.stringify({ at: new Date().toISOString(), context: safeContext, ...processingDiagnostic(error) })]);
  } catch { /* Preserve the processing exception even when storage is unavailable. */ }
}
