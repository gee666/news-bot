import type { BatchStatus } from '../types.js';

export function partialCompletionLabel(failedItems: number): string {
  return `Completed with ${failedItems} withheld ${failedItems === 1 ? 'item' : 'items'}`;
}

export function batchStatusLabel(status: BatchStatus, errorCode: string | null, failedItems: number): string {
  if (status === 'queued') return 'Collected intake queued for processing';
  if (status === 'completed' && errorCode === 'partial_selection_failure') return 'Completed with held comparisons or source links';
  if (status === 'completed' && errorCode === 'partial_source_failure') return 'Completed with incomplete source coverage';
  if (status === 'completed' && errorCode === 'partial_story_failure') return 'Completed with withheld stories';
  return status === 'completed' && errorCode === 'partial_item_failure' ? partialCompletionLabel(failedItems) : status;
}

export function failedStageContext(batchStatus: BatchStatus, completedAt: string | null, errorCode: string | null): string {
  if (batchStatus === 'completed' && errorCode === 'partial_selection_failure') return 'Local aggregate selection failed. Unrelated processing completed.';
  if (batchStatus === 'completed' && errorCode === 'partial_source_failure') return 'Source collection failed. Processing completed with incomplete coverage.';
  if (batchStatus === 'completed' && errorCode === 'partial_story_failure') return 'Withheld story failure. Batch completed with errors.';
  if (batchStatus === 'completed' && errorCode === 'partial_item_failure') return 'Withheld item failure. Batch completed with errors.';
  if (completedAt) return `Historical failed stage record. Batch is now ${batchStatus}.`;
  if (batchStatus === 'failed') return 'Failed stage record. Batch needs attention.';
  return `Recorded failure. Batch is now ${batchStatus}; this record does not imply the whole batch is stopped.`;
}
