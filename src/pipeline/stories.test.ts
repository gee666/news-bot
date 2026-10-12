import { beforeEach, expect, it, vi } from 'vitest';
import { selectRepresentative, storyStageName } from './stories.js';
import { defaultSettings } from '../settings.js';
import { GENERATION_VERSION } from './generation-store.js';
import { jevTemplates } from '../models/templates.js';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
const context = { id: 'story', attempt: 1, batchId: null, revisionId: null, storyId: 'story' };
const rows = (texts: string[]) => texts.map((text, index) => ({ id: `${index}`, revision_id: `r${index}`, text,
  source_url: `https://example.org/${index}`, links: [] }));
beforeEach(() => { mocks.query.mockReset().mockResolvedValue({ rows: [] }); });
it('versions all downstream stages with the event integrity input contract', () => {
  const story = { id: 'story', content_version: 3 };
  const suffix = `${jevTemplates.representative.version}:${jevTemplates.event_group_integrity.version}:v3:p1:m1`;
  for (const task of ['representative', 'interest', 'story_embedding']) expect(storyStageName(story, task, defaultSettings)).toBe(`${task}:${suffix}`);
  expect(storyStageName(story, 'research', defaultSettings)).toBe(`research:${GENERATION_VERSION}:${suffix}`);
});
it('checks the whole group before selecting and invalidates display and rank when selection changes', async () => {
  const mentions = rows(['API launched.', 'Acme launched an API for routing, with confidence scores.']);
  mocks.query.mockResolvedValueOnce({ rows: mentions }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: mentions }).mockResolvedValueOnce({ rows: [{ id: 'story' }] });
  const judge = { judge: vi.fn().mockResolvedValueOnce({ type: 'choice', choice: 'coherent', probabilities: {}, confidence: 1 })
    .mockResolvedValueOnce({ type: 'choice', choice: 'right', probabilities: {}, confidence: 1 }) };
  expect(await selectRepresentative('story', judge, context)).toContain('confidence scores');
  expect(judge.judge.mock.calls[0]?.[0]).toBe('event_group_integrity');
  expect(judge.judge.mock.calls[1]?.[1]).toMatchObject({ story: mentions.map(row => row.text).join('\n\n') });
  expect(mocks.query.mock.calls[3]?.[0]).toContain('content_version=content_version+1');
  expect(mocks.query.mock.calls[3]?.[0]).toContain('interest_stale=true,headline=NULL,summary=NULL');
  expect(mocks.query.mock.calls[4]?.[0]).toBe('DELETE FROM embeddings WHERE story_id=$1');
  expect(mocks.query.mock.calls[5]?.[0]).toBe('UPDATE story_evidence SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL');
});
it('does not invalidate cached work when the selected excerpt is unchanged', async () => {
  const mentions = rows(['Acme released compiler 2.']);
  mocks.query.mockResolvedValueOnce({ rows: mentions }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: mentions });
  const judge = { judge: vi.fn() };
  await selectRepresentative('story', judge, context);
  expect(judge.judge).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledTimes(4);
  expect(mocks.query.mock.calls[3]?.[0]).toContain('chosen_excerpt IS DISTINCT FROM $2');
});
it('rejects mixed hosted service and downloadable checkpoint reports before choosing a misleading excerpt', async () => {
  mocks.query.mockResolvedValueOnce({ rows: rows(['abliteration.ai offers a paid GLM-5.3 API.', 'Infatoshi released GLM-5.3 UNCENSORED EXL3.']) });
  const judge = { judge: vi.fn().mockResolvedValue({ type: 'choice', choice: 'mixed', probabilities: {}, confidence: 1 }) };
  await expect(selectRepresentative('story', judge, context)).rejects.toThrow('unconnected event reports');
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(mocks.query).toHaveBeenCalledTimes(1);
});
it('refuses to commit a selection after a collector edit changes the current reports', async () => {
  mocks.query.mockResolvedValueOnce({ rows: rows(['Acme release.']) }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: rows(['Corrected release.']) });
  await expect(selectRepresentative('story', { judge: vi.fn() }, context)).rejects.toThrow('changed during selection');
  expect(mocks.query).toHaveBeenCalledTimes(3);
});
