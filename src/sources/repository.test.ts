import { beforeEach, expect, it, vi } from 'vitest';
import { addPrimarySource, editPrimarySource, listPrimarySources, parsePrimarySource, preparePrimarySources, seedPrimarySources } from './repository.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), lookup: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
const id = '11111111-1111-4111-8111-111111111111';
const row = { id, connector_type: 'feed', name: 'Publisher', original_url: 'https://example.org/feed', enabled: true,
  metadata: { publisher: 'Publisher', articlePathPrefixes: ['/news/'], maxArticles: 2, unknownPublication: 'skip' }, collection_cursor: {} };
const input = { kind: 'feed', name: 'Publisher', url: row.original_url, publisher: 'Publisher', articlePathPrefixes: ['/news/'], maxArticles: 2 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  mocks.query.mockResolvedValue({ rows: [row] });
});
it.each(['http://127.0.0.1/feed', 'https://u:secret@example.org/feed', 'http://localhost/feed'])('rejects unsafe subscription %s without writes', async url => {
  await expect(addPrimarySource({ ...input, url })).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
});
it('rejects mixed DNS and unknown input properties', async () => {
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await expect(addPrimarySource(input)).rejects.toThrow('blocked_url');
  await expect(addPrimarySource({ ...input, primary: true })).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
});
it('lists valid and invalid rows without exposing malformed metadata or credential URLs', async () => {
  mocks.query.mockResolvedValue({ rows: [row, { ...row, original_url: 'https://user:secret@example.org/feed',
    metadata: { secret: 'do-not-return' } }] });
  const sources = await listPrimarySources();
  expect(sources.map(source => source.configState)).toEqual(['valid', 'invalid']);
  expect(sources[1]).toMatchObject({ url: null, errorCode: 'primary_source_invalid_config' });
  expect(JSON.stringify(sources)).not.toContain('secret');
  expect(JSON.stringify(sources)).not.toContain('do-not-return');
});
it('disables an invalid source without parsing other rows or resolving DNS', async () => {
  const invalid = { ...row, metadata: {} };
  mocks.query.mockResolvedValueOnce({ rows: [invalid] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [{ ...invalid, enabled: false }] });
  expect(await editPrimarySource(id, { enabled: false })).toMatchObject({ configState: 'invalid', enabled: false });
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[0]?.[0]).toContain('WHERE id=$1');
});
it.each([{ url: 'https://example.org/feed-b' }, { kind: 'website' }, { url: 'https://example.org/feed/' }])(
  'rejects identity edits after ingestion %j without updates', async patch => {
    mocks.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ has_items: true }] });
    await expect(editPrimarySource(id, patch)).rejects.toThrow('primary_source_identity_locked');
    expect(mocks.query.mock.calls.every(call => call[0].startsWith('SELECT'))).toBe(true);
  });
it('rejects enabling or changing malformed configuration rather than replacing it', async () => {
  mocks.query.mockResolvedValue({ rows: [{ ...row, metadata: {} }] });
  await expect(editPrimarySource(id, { enabled: true })).rejects.toThrow('primary_source_invalid_config');
  await expect(editPrimarySource(id, { enabled: false, name: 'Replaced' })).rejects.toThrow('primary_source_invalid_config');
});

it('enabled-only edit keeps existing configuration and cursor', async () => {
  await editPrimarySource(id, { enabled: false });
  const values = mocks.query.mock.calls.find(call => call[0].startsWith('UPDATE sources'))?.[1];
  expect(values?.[4]).toBe(false);
  expect(values?.[6]).toBe(false);
  expect(JSON.parse(values?.[5] ?? '{}')).toMatchObject({ maxArticles: 2, unknownPublication: 'skip', publisher: 'Publisher' });
});
it('defaults legacy rows to same-host policy and marks malformed opt-in configuration invalid', async () => {
  expect(parsePrimarySource(row).articleLinkPolicy).toBe('same_host');
  mocks.query.mockResolvedValue({ rows: [row,
    { ...row, metadata: { ...row.metadata, articleLinkPolicy: 'unknown' } },
    { ...row, connector_type: 'website', metadata: { ...row.metadata, articleLinkPolicy: 'external' } },
  ] });
  expect((await listPrimarySources()).map(source => source.configState)).toEqual(['valid', 'invalid', 'invalid']);
});
it('persists opt-in on only the selected feed without resetting its progress or identity lock', async () => {
  const hn = { ...row, name: 'Hacker News', original_url: 'https://hnrss.org/newest',
    collection_cursor: { completedIds: ['previous'] } };
  const opted = { ...hn, metadata: { ...hn.metadata, articleLinkPolicy: 'external', articlePathPrefixes: ['/'] } };
  mocks.query.mockResolvedValueOnce({ rows: [hn] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [opted] });
  expect(await editPrimarySource(id, { articleLinkPolicy: 'external', articlePathPrefixes: ['/'] })).toMatchObject({
    id, configState: 'valid', articleLinkPolicy: 'external', articlePathPrefixes: ['/'],
    identityLocked: true, cursor: { completedIds: ['previous'] },
  });
  const values = mocks.query.mock.calls[2]?.[1];
  expect(values?.[0]).toBe(id);
  expect(values?.[6]).toBe(false);
  expect(JSON.parse(values?.[5] ?? '{}')).toMatchObject({
    articleLinkPolicy: 'external', publisherIdentityLocked: true,
  });
  mocks.query.mockClear();
  mocks.query.mockResolvedValueOnce({ rows: [opted] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [{ ...opted, enabled: false }] });
  await editPrimarySource(id, { enabled: false });
  expect(JSON.parse(mocks.query.mock.calls[2]?.[1]?.[5] ?? '{}').articleLinkPolicy).toBe('external');
  mocks.query.mockResolvedValue({ rows: [opted] });
  expect((await preparePrimarySources(id))[0]?.articleLinkPolicy).toBe('external');
});
it('rejects website opt-in without writes and still validates subscription DNS for feed opt-in', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ ...row, connector_type: 'website' }] })
    .mockResolvedValueOnce({ rows: [{ has_items: false }] });
  await expect(editPrimarySource(id, { articleLinkPolicy: 'external' })).rejects.toThrow();
  expect(mocks.query.mock.calls.every(call => call[0].startsWith('SELECT'))).toBe(true);
  mocks.query.mockClear();
  mocks.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
  await expect(addPrimarySource({ ...input, articleLinkPolicy: 'external' })).rejects.toThrow('blocked_url');
  expect(mocks.query).not.toHaveBeenCalled();
});
it('preserves configurable source budgets and retry settings through unrelated edits', async () => {
  const configured = { ...row, metadata: { ...row.metadata, maxArticles: 30, backlogLimit: 500,
    retryDelayMinutes: 120, feedDateRole: 'submission' } };
  mocks.query.mockResolvedValue({ rows: [configured] });
  expect(parsePrimarySource(configured)).toMatchObject({ maxArticles: 30, backlogLimit: 500,
    retryDelayMinutes: 120, feedDateRole: 'submission' });
  await editPrimarySource(id, { name: 'Renamed' });
  const values = mocks.query.mock.calls.find(call => call[0].startsWith('UPDATE sources'))?.[1];
  expect(JSON.parse(values?.[5] ?? '{}')).toMatchObject(configured.metadata);
});

it('recovers legacy skipped IDs on skip to collect_once without replaying collected undated IDs', async () => {
  const legacy = { ...row, collection_cursor: { cutoff: '2026-10-01T12:00:00.000Z',
    completedIds: ['skipped', 'collected'], unknownIds: ['skipped', 'collected'],
    seen: ['skipped', 'collected'].map(id => ({ id, checkedAt: '2026-10-01T12:00:00.000Z' })) } };
  const batchId = '22222222-2222-4222-8222-222222222222';
  mocks.query.mockResolvedValueOnce({ rows: [legacy] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [{ batch_id: batchId, cursor: legacy.collection_cursor }] })
    .mockResolvedValueOnce({ rows: [{ external_id: 'collected' }] })
    .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
  await editPrimarySource(id, { unknownPublication: 'collect_once' });
  const batchUpdate = mocks.query.mock.calls.find(call => call[0].startsWith('UPDATE batch_sources'));
  const sourceUpdate = mocks.query.mock.calls.find(call => call[0].startsWith('UPDATE sources'));
  expect(JSON.parse(batchUpdate?.[1]?.[2] ?? '{}')).toMatchObject({ unknownIds: ['collected'],
    completedIds: ['collected'], skippedUnknownIds: [], unknownPolicy: 'collect_once',
    seen: [{ id: 'collected', checkedAt: '2026-10-01T12:00:00.000Z' }] });
  expect(JSON.parse(sourceUpdate?.[1]?.[7] ?? '{}')).toEqual(JSON.parse(batchUpdate?.[1]?.[2] ?? '{}'));
  expect(mocks.query.mock.calls.some(call => /DELETE|UPDATE source_items|UPDATE item_revisions/u.test(call[0]))).toBe(false);
});

it('source URL changes reset cursor but not source UUID', async () => {
  await editPrimarySource(id, { url: 'https://example.org/new-feed' });
  const values = mocks.query.mock.calls.find(call => call[0].startsWith('UPDATE sources'))?.[1];
  expect(values?.[0]).toBe(id); expect(values?.[6]).toBe(true);
});
it('seeds no more than five verified sources without overwriting user disable/configuration', async () => {
  await seedPrimarySources();
  const inserts = mocks.query.mock.calls.filter(call => call[0].includes('INSERT INTO sources'));
  expect(inserts).toHaveLength(5);
  expect(inserts.every(call => call[0].includes('DO NOTHING'))).toBe(true);
});
it('isolates malformed publisher configuration without losing valid sources or rewriting item progress', async () => {
  const invalidId = '22222222-2222-4222-8222-222222222222';
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
    { ...row, id: invalidId, original_url: null, metadata: {},
      collection_cursor: { completedIds: ['already-saved'] } }, row,
  ] }).mockResolvedValue({ rows: [] });
  const sources = await preparePrimarySources(id);
  expect(sources.map(source => source.id)).toEqual([id]);
  const failure = mocks.query.mock.calls[2];
  expect(failure?.[1]).toEqual([id, invalidId]);
  expect(failure?.[0]).toContain("error_code='primary_source_invalid_config'");
  expect(failure?.[0]).not.toMatch(/cursor|source_items|batch_items/u);
});

it('resumes partial cursor progress and does not replay completed sources', async () => {
  await preparePrimarySources(id);
  const sql = mocks.query.mock.calls[1]?.[0];
  expect(sql).toContain('COALESCE(bs.cursor_after,bs.cursor_before)');
  expect(sql).toContain("bs.status <> 'completed'");
});
