import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { alreadyGenerated, evidenceSnapshotHash } from './generation-store.js';
import { storyInput } from './generation.test-helpers.js';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
beforeEach(() => mocks.query.mockReset().mockResolvedValue({ rows: [] }));

it('treats the hardcoded notice as not generated without querying', async () => {
  const input = storyInput();
  input.story.headline = 'Материалы по новости';
  input.story.summary = 'Краткий пересказ недоступен. Ссылки на материалы ниже.';
  input.story.researched = true;
  expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('treats exact_source_links receipts as not generated even without the notice wording', async () => {
  const input = storyInput();
  input.story.headline = 'Материалы по новости'; input.story.summary = 'Ссылки на материалы'; input.story.researched = true;
  mocks.query.mockResolvedValueOnce({ rows: [{ result: { evidenceContract: {
    verification: { method: 'exact_source_links' },
  } } }] });
  expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
});

it('a failed review still counts as generated and does not trigger endless regeneration', async () => {
  const input = storyInput();
  input.story.headline = 'Acme выпустила обновление'; input.story.summary = 'Исправлена ошибка.'; input.story.researched = true;
  const evidenceSignature = await evidenceSnapshotHash(input.story.id);
  mocks.query.mockResolvedValueOnce({ rows: [{ result: { evidenceSignature,
    review: { supported: false, reason: 'Версия не подтверждена' } } }] });
  expect(await alreadyGenerated(input, defaultSettings)).toBe(true);
});

it('does not reuse an overlong automatic summary from an older generation receipt', async () => {
  const input = storyInput();
  input.story.headline = 'Короткий заголовок'; input.story.summary = 'Я'.repeat(1001); input.story.researched = true;
  expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
  expect(mocks.query).not.toHaveBeenCalled();
});
