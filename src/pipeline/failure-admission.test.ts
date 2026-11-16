import { beforeEach, expect, it, vi } from 'vitest';
import { extractionImage } from './extraction-image-fixtures.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
import { failureInputBoundary, failureInputsChanged } from './failure-admission.js';

const story = '00000000-0000-4000-8000-000000000001';
const item = '00000000-0000-4000-8000-000000000002';
function report(text: string, hash = 'a'.repeat(64)) {
  return { item_id: item, content_hash: 'collected-image', normalized_text: '', urls: [], valid: true,
    image_evidence: [[{ text, images: [{ ...extractionImage().provenance, sourceSha256: hash }] }]] };
}
beforeEach(() => { mocks.query.mockReset(); });

it('records image-only evidence in the failed-story input boundary', async () => {
  mocks.query.mockResolvedValue({ rows: [report('Chart reports revenue of $5 million.')] });
  const boundary = await failureInputBoundary(story, undefined, true);
  expect(boundary.inputs).toHaveLength(2);
  expect(mocks.query.mock.calls[0]?.[0]).toContain("m.metadata->>'extractionKind'='image'");
});

it('does not reset a failure budget for rewritten image observations but does for different source bytes', async () => {
  mocks.query.mockResolvedValue({ rows: [report('Chart reports revenue of $5 million.')] });
  const baseline = await failureInputBoundary(story);
  mocks.query.mockResolvedValue({ rows: [report('Revenue on the chart is $5 million.')] });
  expect(await failureInputsChanged(story, baseline)).toBe(false);
  mocks.query.mockResolvedValue({ rows: [report('Revenue is $6 million.', 'b'.repeat(64))] });
  expect(await failureInputsChanged(story, baseline)).toBe(true);
});

it('does not treat an empty caption without valid image evidence as meaningful input', async () => {
  mocks.query.mockResolvedValue({ rows: [{ ...report('Chart'), image_evidence: [] }] });
  const baseline = await failureInputBoundary(story);
  expect(await failureInputsChanged(story, baseline)).toBe(false);
});
