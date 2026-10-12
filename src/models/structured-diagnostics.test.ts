import { expect, it } from 'vitest';
import { safeIssuePaths, safeStructuredDiagnostics } from './structured-diagnostics.js';

it('names source-link citation fields without exposing candidate IDs or evidence', () => {
  const fields = safeIssuePaths([
    { path: ['items', 'PRIVATE_CANDIDATE_ID', 'source_excerpt_id'] },
    { path: ['items', 'PRIVATE_CANDIDATE_ID', 'story_excerpt_id'] },
    { path: ['PRIVATE_EVIDENCE', 'PRIVATE_QUOTATION'] },
  ]);
  expect(fields).toEqual(['items.?.source_excerpt_id', 'items.?.story_excerpt_id', '?.?']);
  const diagnostics = { schemaBytes: 100, promptChars: 200, responseChars: 300, codes: ['schema'], fields };
  expect(safeStructuredDiagnostics(diagnostics)).toEqual(diagnostics);
  expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
  expect(safeStructuredDiagnostics({ ...diagnostics, fields: ['items.private_candidate.story_excerpt_id'] })).toBeUndefined();
});

it('keeps extraction failure categories and fields without retaining coordinate values or source text', () => {
  const fields = safeIssuePaths([
    { path: ['events', 0, 'parts', 0, 'first'] },
    { path: ['omitted', 0, 'PRIVATE_COORDINATE'] },
  ]);
  expect(fields).toEqual(['events.0.parts.0.first', 'omitted.0.?']);
  const diagnostics = { schemaBytes: 200, promptChars: 500, responseChars: 100,
    codes: ['extraction_overlap', 'extraction_anchor', 'extraction_coverage', 'extraction_partition', 'empty_extraction_unconfirmed'], fields };
  expect(safeStructuredDiagnostics(diagnostics)).toEqual(diagnostics);
  expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
});
