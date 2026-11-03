import { describe, expect, it, vi } from 'vitest';
import { admitPublicationInputs } from './input-admission.js';
import { novelPublicationInputs, publicationBoundarySchema, publicationInputBoundary, publicationTextTokens,
  reportBoundary, type PublicationBoundary } from './input-evidence.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
const now = Date.parse('2026-11-03T08:00:00Z');
const item = '5df47752-f683-478b-9875-7874456046bb';
const other = '2ce4573a-7ba0-47c1-a803-55ac532418ae';
const empty: PublicationBoundary = { version: 'publication-input-v2', inputs: [] };
function report(itemId = item, text = 'Original report', sourceTime = '2026-11-03T07:00:00Z',
  revisionTime = sourceTime, urls: string[] = [], contentHash = 'original',
  collected?: { text?: string; urls?: string[] }) {
  return reportBoundary([{ item_id: itemId, text, source_time: sourceTime,
    revision_time: revisionTime, content_hash: contentHash, urls,
    collected_text: collected?.text, collected_urls: collected?.urls }]);
}
const combine = (...reports: PublicationBoundary[]): PublicationBoundary => ({
  version: 'publication-input-v2', inputs: reports.flatMap(report => report.inputs),
});
const policy = (current: PublicationBoundary, baseline = empty, window = 48, verifiable = true) =>
  admitPublicationInputs(current, baseline, baseline.inputs.length > 0, verifiable, window, now);

describe('publication input policy', () => {
  it('rejects the unchanged Oct 21 report even if regenerated on Nov 3', () => {
    const old = report(item, 'Original report', '2026-10-21T13:20:40Z');
    expect(policy(old)).toEqual({ allowed: false, reason: 'stale_source_input' });
    expect(policy(old, old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('uses the configurable collection window, including the exact boundary', () => {
    const input = report(item, 'Report', '2026-11-01T08:00:00Z');
    expect(policy(input, empty, 48)).toEqual({ allowed: true });
    expect(policy(input, empty, 24)).toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('ignores parser hash churn, removals and URL ordering', () => {
    const old = report(item, 'Report', undefined, undefined, ['https://example.org/a', 'https://example.org/b']);
    const metadataEdit = report(item, 'Report', undefined, undefined,
      ['https://example.org/b', 'https://example.org/a'], 'new-parser-hash');
    expect(novelPublicationInputs(metadataEdit, old)).toEqual([]);
    expect(policy(metadataEdit, old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(policy(report(item, 'Report'), old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(policy(empty, old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it.each(['Model released', 'released', 'Model'])('rejects deletion-only text revision %s', text => {
    const old = report(item, 'Model released with open weights', '2026-10-21T13:20:40Z');
    expect(policy(report(item, text, '2026-10-21T13:20:40Z', '2026-11-03T07:00:00Z'), old))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it.each(['**MODEL**   released!', '# Model released', 'Model\n\nreleased', 'Model  \nreleased', 'Model\nreleased',
    'Model<br>released', 'Model<br />released', '<p>Model</p><p>released</p>', '`Model` released', 'Model, released.'])(
    'rejects formatting-only revision %s', text => {
      const old = report(item, 'Model released');
      expect(policy(report(item, text), old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    });
  it('compares split/merged extracted reports as the same scoped coverage', () => {
    const split = combine(report(item, 'A report'), report(item, 'B report'));
    const merged = report(item, 'A report B report');
    expect(policy(merged, split)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(policy(split, merged)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(policy(report(item, 'B report A report'), split)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(policy(combine(report(item, 'B report'), report(item, 'A report')), split))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not confuse a new token or extra token multiplicity with deletion', () => {
    const old = report(item, 'Report from orbit');
    expect(policy(report(item, 'Report from lunar orbit'), old)).toEqual({ allowed: true });
    expect(policy(report(item, 'Report from orbit orbit'), old)).toEqual({ allowed: true });
  });
  it('deduplicates the same text across earlier editions when counting covered tokens', () => {
    const old = report(item, 'Report from orbit');
    expect(policy(report(item, 'Report from orbit orbit'), combine(old, old))).toEqual({ allowed: true });
  });
  it('allows a genuinely new relevant-source report without changing the generated headline', () => {
    const baseline = report();
    expect(policy(combine(baseline, report(other)), baseline)).toEqual({ allowed: true });
  });
  it.each(['text', 'url'] as const)('allows a recent meaningful %s edit to a previously published old primary', kind => {
    const old = report(item, 'Old primary', '2026-10-21T13:20:40Z');
    const edited = report(item, kind === 'text' ? 'Old primary with new results' : 'Old primary',
      '2026-10-21T13:20:40Z', '2026-11-03T07:00:00Z', kind === 'url' ? ['https://example.org/new-results'] : []);
    expect(policy(edited, old)).toEqual({ allowed: true });
  });
  it.each([['1.5', '15'], ['15', '1.5'], ['10', '20']] as const)('allows a proven number replacement %s to %s', (before, after) => {
    const old = report(item, `Cost ${before} million`, '2026-10-21T13:20:40Z');
    expect(policy(report(item, `Cost ${after} million`, '2026-10-21T13:20:40Z', '2026-11-03T07:00:00Z'), old))
      .toEqual({ allowed: true });
    expect(publicationTextTokens(`Cost ${before} million`)).not.toEqual(publicationTextTokens(`Cost ${after} million`));
  });
  it('does not authorize URL changes which were not classified relevant to this story', () => {
    const old = report(item, 'See [report](https://example.org/old) and https://unrelated.example/old');
    const edited = report(item, 'See [report](https://example.org/new) and https://unrelated.example/new');
    expect(policy(edited, old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('source-only coverage contains relevant URLs, not the report parent text', () => {
    const old = report(item, '', undefined, undefined, ['https://example.org/relevant']);
    expect(old.inputs.map(input => input.payload)).toEqual([{ kind: 'url', url: 'https://example.org/relevant' }]);
    const metadataEdit = report(item, '', undefined, undefined, ['https://example.org/relevant'], 'changed-parent');
    expect(policy(metadataEdit, old)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(policy(report(item, '', undefined, undefined,
      ['https://example.org/relevant', 'https://example.org/new-relevant']), old)).toEqual({ allowed: true });
  });
  it('does not turn re-extraction of existing raw text into new coverage', () => {
    const raw = 'Alpha released. Beta costs 10 million.';
    const baseline = report(item, 'Alpha released', undefined, undefined, [], 'immutable', { text: raw });
    const expanded = report(item, 'Alpha released. Beta costs 10 million.', undefined, undefined, [], 'immutable', { text: raw });
    expect(policy(expanded, baseline)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    const metadataOnly = report(item, 'Beta costs 10 million', undefined, undefined, [], 'metadata-revision', { text: raw });
    expect(policy(metadataOnly, baseline)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not turn classification of a previously collected URL into new input', () => {
    const url = 'https://example.org/known';
    const baseline = report(item, 'Alpha released', undefined, undefined, [], 'immutable', { urls: [url] });
    const classified = report(item, 'Alpha released', undefined, undefined, [url], 'immutable', { urls: [url] });
    expect(policy(classified, baseline)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not let an unrelated parent edit authorize old newly extracted story content', () => {
    const baseline = report(item, 'Alpha released', undefined, undefined, [], 'old',
      { text: 'Alpha released. Beta costs 10 million.' });
    const unrelated = report(item, 'Alpha released. Beta costs 10 million.', undefined, undefined, [], 'new',
      { text: 'Alpha released. Beta costs 10 million. Gamma launched.' });
    expect(policy(unrelated, baseline)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not let a real parent edit authorize unchanged scoped coverage', () => {
    const baseline = report(item, 'Alpha released', undefined, undefined, [], 'old', { text: 'Alpha released. Beta costs 10.' });
    const unrelated = report(item, 'Alpha released', undefined, undefined, [], 'new', { text: 'Alpha released. Beta costs 20.' });
    expect(policy(unrelated, baseline)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('allows a scoped update proven by newly collected text in an old primary', () => {
    const baseline = report(item, 'Alpha costs 10', '2026-10-21T13:20:40Z', undefined, [], 'old',
      { text: 'Alpha costs 10. Beta unchanged.' });
    const update = report(item, 'Alpha costs 20', '2026-10-21T13:20:40Z', '2026-11-03T07:00:00Z', [], 'new',
      { text: 'Alpha costs 20. Beta unchanged.' });
    expect(policy(update, baseline)).toEqual({ allowed: true });
  });
  it('allows a new relevant hidden URL when the collected URL inventory actually changes', () => {
    const baseline = report(item, 'Alpha released', undefined, undefined, [], 'old', { urls: [] });
    const update = report(item, 'Alpha released', undefined, undefined, ['https://example.org/new'], 'new',
      { text: 'Alpha released', urls: ['https://example.org/new'] });
    expect(policy(update, baseline)).toEqual({ allowed: true });
  });
  it('does not use a recent revision timestamp for a newly attached old article', () => {
    const baseline = report();
    const oldAddition = report(other, 'Newly attached old article', '2026-10-21T13:20:40Z', '2026-11-03T07:00:00Z');
    expect(policy(combine(baseline, oldAddition), baseline)).toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('does not let inherited recent input mask stale novelty', () => {
    const baseline = report();
    const oldAddition = report(other, 'Old article', '2026-10-21T13:20:40Z');
    expect(policy(combine(baseline, oldAddition), baseline)).toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('fails closed if a sent edition has no durable input baseline', () => {
    expect(admitPublicationInputs(report(), empty, true, false, 48, now))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
  });
  it('rejects v1 hash-only baselines and persists normalized scoped payloads in v2', () => {
    expect(publicationBoundarySchema.safeParse({ version: 'publication-input-v1', inputs: [] }).success).toBe(false);
    const next = report(item, '**Model** 1.5 released');
    expect(publicationBoundarySchema.parse(next).inputs[0]?.payload)
      .toEqual({ kind: 'text', tokens: ['model', '1.5', 'released'] });
    expect(JSON.stringify(next)).not.toContain('contentFingerprint');
  });
  it('selects extracted mention text and only story-relevant links, never parent report payloads', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ item_id: item, content_hash: 'parent-revision', text: 'Alpha released',
      source_time: new Date(now), revision_time: new Date(now), urls: ['https://example.org/alpha'] }] });
    const boundary = await publicationInputBoundary(other);
    expect(boundary.inputs.map(input => input.payload)).toEqual([
      { kind: 'text', tokens: ['alpha', 'released'] }, { kind: 'url', url: 'https://example.org/alpha' },
    ]);
    const sql = String(mocks.query.mock.calls.at(-1)?.[0]);
    expect(sql).toContain('SELECT m.revision_id,m.text');
    expect(sql).toContain("ml.classification='relevant'");
    expect(sql).toContain("sl.story_id=$1 AND sl.classification='relevant'");
    expect(sql).not.toContain('r.normalized_text,');
    expect(sql).not.toContain('r.original_text');
  });
});
