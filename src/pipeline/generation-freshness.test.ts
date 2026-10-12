import { beforeEach, expect, it, vi } from 'vitest';
import { generationIsCurrent } from './generation-freshness.js';
import { defaultSettings } from '../settings.js';
import { storyInput } from './generation.test-helpers.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), load: vi.fn(), current: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./generation-store.js', () => ({ loadStory: mocks.load, alreadyGenerated: mocks.current }));
beforeEach(() => {
  const input = storyInput(3);
  input.story.headline = 'Новость'; input.story.summary = 'Подробности'; input.story.researched = true;
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.load.mockReset().mockResolvedValue(input);
  mocks.current.mockReset().mockResolvedValue(true);
});
it('checks the exact current generator input/output signature', async () => {
  expect(await generationIsCurrent('story', defaultSettings)).toBe(true);
  expect(mocks.current).toHaveBeenCalledWith(expect.anything(), defaultSettings);
  mocks.current.mockResolvedValue(false);
  expect(await generationIsCurrent('story', defaultSettings)).toBe(false);
});
it('rejects an old raw-copy display even at low interest', async () => {
  const input = storyInput(3);
  input.story.headline = 'Old'; input.story.summary = null; input.story.researched = false;
  mocks.load.mockResolvedValue(input);
  expect(await generationIsCurrent('story', defaultSettings)).toBe(false);
  expect(mocks.current).not.toHaveBeenCalled();
});
it('requires a matching research judgment and summary at high interest', async () => {
  const input = storyInput(9);
  input.story.headline = 'Новость'; input.story.summary = 'Подробности'; input.story.researched = true;
  mocks.load.mockResolvedValue(input);
  expect(await generationIsCurrent('story', defaultSettings)).toBe(true);
  expect(mocks.current).toHaveBeenCalledWith(input, defaultSettings);
});
