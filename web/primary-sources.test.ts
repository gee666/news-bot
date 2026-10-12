import { expect, it } from 'vitest';
import { emptySourceDraft, hackerNewsSourceDraft, primarySourceInputSchema, primarySourceSchema, sourceDraft, sourceInput } from './primary-sources';

it('parses mixed valid/invalid views and old cursors without fabricating invalid configuration', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const invalid = { id, kind: 'website', name: 'Legacy', url: null, enabled: true,
    identityLocked: true, configState: 'invalid', errorCode: 'primary_source_invalid_config' };
  const valid = { ...sourceInput(emptySourceDraft), id, configState: 'valid', identityLocked: false,
    cursor: { cutoff: null, completedIds: ['old-id'], unknownIds: [] } };
  const sources = primarySourceSchema.array().parse([valid, invalid]);
  expect(sources[1]).toEqual(invalid);
  expect(sources[0]).toMatchObject({ configState: 'valid',
    cursor: { seen: [], unseenBatches: 0, rechecked: false, completedIds: ['old-id'] } });
  expect(primarySourceSchema.safeParse({ ...invalid, publisher: 'SECRET' }).success).toBe(false);
});

it('starts with conservative defaults and converts controlled path text', () => {
  expect(sourceInput(emptySourceDraft)).toMatchObject({ unknownPublication: 'skip', enabled: true, maxArticles: 3, articleLinkPolicy: 'same_host', articlePathPrefixes: ['/'] });
  expect(sourceInput({ ...emptySourceDraft, articlePathPrefixes: '/news/\n /blog/, /research/ ' }).articlePathPrefixes)
    .toEqual(['/news/', '/blog/', '/research/']);
});
it('keeps aggregator opt-in through API view, edit draft and save payload', () => {
  const source = primarySourceSchema.parse({ ...sourceInput(emptySourceDraft),
    id: '11111111-1111-4111-8111-111111111111', url: 'https://hnrss.org/newest',
    articleLinkPolicy: 'external', cursor: {}, configState: 'valid', identityLocked: false });
  if (source.configState !== 'valid') throw new Error('fixture_invalid');
  expect(sourceInput(sourceDraft(source))).toMatchObject({
    kind: 'feed', url: 'https://hnrss.org/newest', articleLinkPolicy: 'external', articlePathPrefixes: ['/'],
  });
});
it('roundtrips explicit budgets and submission semantics without replacing them with defaults', () => {
  const configuration = { ...sourceInput(emptySourceDraft), maxArticles: 50, backlogLimit: 1000,
    retryDelayMinutes: 720, feedDateRole: 'submission', articleLinkPolicy: 'external', unknownPublication: 'collect_once' };
  const source = primarySourceSchema.parse({ ...configuration,
    id: '11111111-1111-4111-8111-111111111111', configState: 'valid', identityLocked: true,
    cursor: { unknownIds: Array.from({ length: 1000 }, (_, index) => 'undated'+index), backlogOverflow: 7,
      attemptedIds: ['failed'], backlog: [{ id: 'failed', url: 'https://example.org/article', title: null,
        publishedAt: null, discoveredAt: '2026-10-01T12:00:00.000Z', failures: 2,
        nextAttemptAt: '2026-10-01T14:00:00.000Z', lastErrorCode: 'primary_article_restricted_http_403' }] } });
  if (source.configState !== 'valid') throw new Error('fixture_invalid');
  expect(sourceInput(sourceDraft(source))).toEqual(configuration);
  expect(source.cursor.backlog[0]?.lastErrorCode).toBe('primary_article_restricted_http_403');
  expect(primarySourceSchema.safeParse({ ...source, hiddenSetting: 'secret' }).success).toBe(false);
  expect(primarySourceSchema.safeParse({ ...source, cursor: { ...source.cursor, backlogOverflow: -1 } }).success).toBe(false);
  expect(primarySourceSchema.safeParse({ ...source, cursor: { ...source.cursor,
    backlog: [{ ...source.cursor.backlog[0], lastErrorCode: 'password=secret' }] } }).success).toBe(false);
});

it('leaves absent settings absent and only uses the HN preset for an explicitly chosen new draft', () => {
  const legacy = sourceInput(emptySourceDraft);
  for (const key of ['backlogLimit', 'retryDelayMinutes', 'feedDateRole']) expect(legacy).not.toHaveProperty(key);
  const preset = sourceInput(hackerNewsSourceDraft);
  expect(preset).toMatchObject({ maxArticles: 20, backlogLimit: 200, retryDelayMinutes: 60,
    feedDateRole: 'submission', articleLinkPolicy: 'external', unknownPublication: 'collect_once' });
  expect(sourceInput(emptySourceDraft)).toEqual(legacy);
  expect(preset).not.toHaveProperty('collectionCron');
});

it('strictly rejects unsupported settings, invalid limits and website submission/external modes', () => {
  for (const patch of [{ maxArticles: 51 }, { backlogLimit: 0 }, { retryDelayMinutes: 721 },
    { feedDateRole: 'unknown' }, { collectionCron: '* * * * *' }, { cursor: {} },
    { kind: 'website', articleLinkPolicy: 'external' }, { kind: 'website', feedDateRole: 'submission' }]) {
    expect(primarySourceInputSchema.safeParse({ ...sourceInput(emptySourceDraft), ...patch }).success).toBe(false);
  }
});

it('edit/save retains every configuration field and excludes cursor and id', () => {
  const source = primarySourceSchema.parse({ id: '11111111-1111-4111-8111-111111111111', kind: 'website',
    name: 'Publisher', publisher: 'Publisher Inc', url: 'https://example.org/news/',
    articleLinkPolicy: 'same_host', articlePathPrefixes: ['/news/', '/research/'], maxArticles: 2, unknownPublication: 'collect_once',
    configState: 'valid', identityLocked: true,
    enabled: false, cursor: { cutoff: null, completedIds: ['one'], unknownIds: [], seen: [], unseenBatches: 0, rechecked: false } });
  if (source.configState !== 'valid') throw new Error('fixture_invalid');
  const { id, cursor, configState, identityLocked, ...input } = source;
  void id; void cursor; void configState; void identityLocked;
  expect(sourceInput(sourceDraft(source))).toEqual(input);
  expect(sourceInput({ ...sourceDraft(source), enabled: true })).toEqual({ ...input, enabled: true });
});
