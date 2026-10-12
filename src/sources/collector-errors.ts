import { ResearchFetchError } from '../pipeline/research-fetch.js';
import type { ResearchPage } from '../pipeline/research-page.js';

type CollectionPhase = 'index' | 'article' | 'store';
const readerCodes = new Set([
  'blocked_url', 'fetch_failed', 'too_large', 'unsupported_content',
  'crawler_not_configured', 'crawler_invalid_endpoint', 'crawler_timeout', 'crawler_failed',
  'crawler_invalid_response', 'crawler_response_too_large', 'crawler_result_mismatch',
  'crawler_restricted', 'crawler_render_failed', 'crawler_empty_content', 'crawler_article_unavailable',
  'restricted_challenge', 'page_load_error', 'article_unavailable',
]);
const parserCodes = new Set(['invalid_feed_xml', 'unsupported_feed', 'feed_item_limit', 'feed_id_limit']);

function readerCode(value: string | undefined): string | undefined {
  return value && (readerCodes.has(value) || /^crawler_http_[1-5]\d{2}$/u.test(value)) ? value : undefined;
}
function httpStatus(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
export interface CollectionDiagnostic {
  phase: CollectionPhase;
  reason: string;
  access?: ResearchPage['access'];
  status?: number;
  readerError?: string;
  crawlerError?: string;
}
export class PrimaryCollectionError extends Error {
  readonly code: string;
  constructor(message: string, readonly diagnostic: CollectionDiagnostic) {
    super(message);
    this.name = 'PrimaryCollectionError';
    this.code = `primary_${diagnostic.phase}_${diagnostic.reason}${diagnostic.status === undefined ? '' : `_http_${diagnostic.status}`}`;
  }
}

export function pageCollectionError(phase: 'index' | 'article', page: ResearchPage,
  fallback: 'empty_content' | 'invalid_canonical' | 'outside_publisher'): PrimaryCollectionError {
  const status = httpStatus(page.metadata.status);
  const error = readerCode(page.metadata.error);
  const crawlerError = readerCode(page.metadata.crawlerError);
  return new PrimaryCollectionError(`${phase}_unavailable`, { phase,
    reason: page.access === 'restricted' ? 'restricted' : error
      ?? (page.access !== 'public' ? page.access : fallback),
    access: page.access, ...(status === undefined ? {} : { status }),
    ...(error ? { readerError: error } : {}),
    ...(crawlerError ? { crawlerError } : {}) });
}
export function collectionError(error: unknown, phase: CollectionPhase): PrimaryCollectionError {
  if (error instanceof PrimaryCollectionError) return error;
  const reason = error instanceof ResearchFetchError ? error.code
    : phase === 'index' && error instanceof Error && parserCodes.has(error.message) ? error.message : 'failed';
  return new PrimaryCollectionError('primary_source_collection_failed', { phase, reason });
}
export function feedCollectionError(status: number, outsidePublisher: boolean): PrimaryCollectionError {
  return new PrimaryCollectionError('feed_unavailable', { phase: 'index',
    reason: outsidePublisher ? 'outside_publisher' : [401, 403].includes(status) ? 'restricted' : 'unavailable',
    ...(httpStatus(status) === undefined ? {} : { status }) });
}
