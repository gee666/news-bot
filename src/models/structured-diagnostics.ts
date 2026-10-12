import { z } from 'zod';

export const validationCodeSchema = z.enum(['json', 'schema', 'record_validation', 'unknown_reference',
  'missing_measure', 'missing_primary_measure', 'authority_scope', 'baseline_link', 'percentage_direction',
  'focus_scope', 'citation_scope', 'coverage_measure', 'coverage_missing', 'verification_consistency', 'empty_evidence',
  'verification_story_id', 'verification_verdict', 'verification_headline_scope', 'verification_issue_excerpt',
  'verification_issue_reference', 'verification_coverage_duplicate', 'verification_coverage_count',
  'verification_fact_reference', 'verification_coverage_excerpt', 'verification_omission_reference',
  'focus_story_id', 'focus_reference', 'focus_subject', 'focus_offer', 'historical_expectation', 'event_time_missing', 'event_scope_missing', 'event_uncertainty_missing',
  'extraction_overlap', 'extraction_anchor', 'extraction_coverage', 'extraction_partition', 'empty_extraction_unconfirmed']);
export type ValidationCode = z.infer<typeof validationCodeSchema>;
export const structuredDiagnosticsSchema = z.object({
  schemaBytes: z.number().int().nonnegative(), promptChars: z.number().int().nonnegative(),
  responseChars: z.number().int().nonnegative(), codes: z.array(validationCodeSchema).max(20),
  fields: z.array(z.string().regex(/^(?:[a-z_]+|\d+|\?)(?:\.(?:[a-z_]+|\d+|\?))*$/u).max(100)).max(20),
}).strict();
export type StructuredDiagnostics = z.infer<typeof structuredDiagnosticsSchema>;
const fields = new Set(['story_id', 'subject', 'event', 'kind', 'claims', 'facet', 'key', 'value', 'statement',
  'scope', 'status', 'authority', 'authority_subject', 'reporting_actor', 'required', 'baseline_for', 'references',
  'source_id', 'quote_id', 'headline', 'summary', 'citations', 'field', 'excerpt', 'fact_ids', 'supported', 'issues',
  'coverage', 'omissions', 'fact_id', 'covered', 'excerpt_ref', 'reason', 'evidence_id', 'role',
  'items', 'verdict', 'source_excerpt_id', 'story_excerpt_id', 'events', 'parts', 'context', 'first', 'last', 'omitted', 'id']);
interface IssuePath { path: readonly PropertyKey[]; errors?: readonly (readonly IssuePath[])[] }
export function safeIssuePaths(issues: readonly IssuePath[]): string[] {
  const paths: string[] = [];
  const visit = (nodes: readonly IssuePath[], prefix: readonly PropertyKey[] = [], depth = 0): void => {
    for (const issue of nodes) {
      if (paths.length >= 20) return;
      const path = [...prefix, ...issue.path];
      if (issue.errors && depth < 8) for (const branch of issue.errors) visit(branch, path, depth + 1);
      else paths.push(path.map(key => typeof key === 'number' ? String(key)
        : typeof key === 'string' && fields.has(key) ? key : '?').join('.') || '?');
    }
  };
  visit(issues);
  return [...new Set(paths)];
}
export function safeStructuredDiagnostics(value: unknown): StructuredDiagnostics | undefined {
  const parsed = structuredDiagnosticsSchema.safeParse(value);
  if (!parsed.success || parsed.data.fields.some(path => path.split('.').some(part =>
    part !== '?' && !/^\d+$/u.test(part) && !fields.has(part)))) return undefined;
  return parsed.data;
}
