import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { StructuredRequest } from '../models/structured.js';
import { defaultSettings } from '../settings.js';
import type { StageContext } from './state.js';

type Decision = { associations: { linkId: string; targetId: string; classification: 'relevant' | 'uncertain' | 'irrelevant' }[] };
const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(),
  generate: vi.fn<(generator: unknown, request: StructuredRequest<Decision>, context: unknown, failure: unknown) => Promise<{ value: Decision }>>(),
}));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: mocks.transaction }));
vi.mock('../models/index.js', () => ({ generateStructured: mocks.generate }));
vi.mock('./generation-model.js', () => ({ generationClient: vi.fn(), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
import { requireInferenceApproval } from './generation-model.js';
import { classifyItemLinks } from './source-links.js';

const revisionId = randomUUID();
const context: StageContext = { id: randomUUID(), attempt: 1, batchId: null, revisionId, storyId: null };
const mentions = [
  { id: randomUUID(), text: 'Acme released Compiler 2.' },
  { id: randomUUID(), text: 'Beta released Database 3.' },
];
const links = [
  { id: randomUUID(), url: 'https://example.org/compiler-2', anchor_text: 'Compiler 2 announcement' },
  { id: randomUUID(), url: 'https://example.org/channel', anchor_text: 'Subscribe to the channel' },
];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(run => run({ query: mocks.query }));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id,text FROM story_mentions')) return { rows: mentions };
    if (sql.includes('SELECT r.original_text')) return { rows: [{ original_text: 'Two releases. Subscribe below.', access: 'public' }] };
    if (sql.includes('SELECT id,url,anchor_text')) return { rows: links };
    if (sql.includes('SELECT 1 FROM source_items')) return { rows: [{ exists: true }] };
    return { rows: [] };
  });
  mocks.generate.mockResolvedValue({ value: { associations: [] } });
});

it('stops empty extraction before link lookup, privacy approval, inference or any writes', async () => {
  mocks.query.mockResolvedValue({ rows: [] });
  await classifyItemLinks(revisionId, defaultSettings, context);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith(
    'SELECT id,text FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal', [revisionId]);
  expect(requireInferenceApproval).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it('does no model work when extracted news has no evidence links', async () => {
  mocks.query.mockResolvedValueOnce({ rows: mentions })
    .mockResolvedValueOnce({ rows: [{ original_text: 'Release.', access: 'public' }] })
    .mockResolvedValueOnce({ rows: [] });
  await classifyItemLinks(revisionId, defaultSettings, context);
  expect(requireInferenceApproval).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it('classifies links only for this revision\'s extracted reports, persisting omitted pairs as irrelevant', async () => {
  const mention = mentions[0]!, link = links[0]!;
  mocks.generate.mockResolvedValue({ value: { associations: [{ linkId: link.id, targetId: mention.id, classification: 'relevant' }] } });
  await classifyItemLinks(revisionId, defaultSettings, context);

  expect(requireInferenceApproval).toHaveBeenCalledExactlyOnceWith(['public'], context.id);
  expect(mocks.generate).toHaveBeenCalledOnce();
  const request = mocks.generate.mock.calls[0]![1];
  expect(JSON.parse(request.prompt)).toEqual({ message: 'Two releases. Subscribe below.', links, targets: mentions });
  expect(request.systemPrompt).toContain('specific event reported by that target');
  expect(request.systemPrompt).not.toContain('source_only');
  const inserts = mocks.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO mention_links'));
  expect(inserts.map(([, params]) => params)).toEqual(mentions.flatMap(target => links.map(candidate => [
    target.id, candidate.id, target.id === mention.id && candidate.id === link.id ? 'relevant' : 'irrelevant', defaultSettings.modelVersion,
  ])));
  expect(mocks.query.mock.calls.some(([sql]) => /story_link_sources|source_link_processing|operational_state|UPDATE stories/u.test(sql))).toBe(false);
});

it('accepts uncertain attachments without promoting them to relevant', async () => {
  mocks.generate.mockResolvedValue({ value: { associations: [{ linkId: links[0]!.id, targetId: mentions[0]!.id, classification: 'uncertain' }] } });
  await classifyItemLinks(revisionId, defaultSettings, context);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mention_links'),
    [mentions[0]!.id, links[0]!.id, 'uncertain', defaultSettings.modelVersion]);
});

it('rejects foreign link/target IDs and duplicate pairs in model output', async () => {
  await classifyItemLinks(revisionId, defaultSettings, context);
  const request = mocks.generate.mock.calls[0]![1];
  const pair = { linkId: links[0]!.id, targetId: mentions[0]!.id, classification: 'relevant' as const };
  expect(request.validate?.({ associations: [pair] })).toBe(true);
  expect(request.validate?.({ associations: [{ ...pair, targetId: randomUUID() }] })).toBe(false);
  expect(request.validate?.({ associations: [{ ...pair, linkId: randomUUID() }] })).toBe(false);
  expect(request.validate?.({ associations: [pair, pair] })).toBe(false);
});

it('rejects a superseded source before saving mention links', async () => {
  mocks.query.mockResolvedValueOnce({ rows: mentions })
    .mockResolvedValueOnce({ rows: [{ original_text: 'Release.', access: 'public' }] })
    .mockResolvedValueOnce({ rows: links }).mockResolvedValue({ rows: [] });
  await expect(classifyItemLinks(revisionId, defaultSettings, context)).rejects.toThrow('Link source changed');
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO mention_links'))).toBe(false);
});
