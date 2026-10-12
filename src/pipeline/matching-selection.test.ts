import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { matchBatch } from './matching.js';
import { Judgments } from './judgments.js';
import { Vectors } from './vectors.js';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: vi.fn() }));
it('bounds a reviewed matching correction to explicit mentions without changing normal batch selection', async () => {
  const judgments = new Judgments(defaultSettings);
  const vectors = new Vectors({ id: randomUUID(), config_key: 'selection-test', model: defaultSettings.embeddingModel,
    endpoint: defaultSettings.embeddingUrl, dimensions: defaultSettings.embeddingDimensions,
    input_version: 'mention-chunks-v2', context_tokens: 2048 }, defaultSettings);
  const batch = randomUUID(); const mention = randomUUID();
  try {
    await matchBatch(batch, defaultSettings, judgments, vectors, [mention]);
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([batch, [mention]]);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('m.id=ANY($2)');
    await matchBatch(batch, defaultSettings, judgments, vectors, []);
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([batch, []]);
    await matchBatch(batch, defaultSettings, judgments, vectors);
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([batch, null]);
    const calls = mocks.query.mock.calls.length;
    await expect(matchBatch(batch, defaultSettings, judgments, vectors, ['invalid'])).rejects.toThrow();
    expect(mocks.query).toHaveBeenCalledTimes(calls);
  } finally { await judgments.close(); await vectors.close(); }
});
