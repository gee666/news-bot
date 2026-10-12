import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { consolidateStories } from './consolidation.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), event: vi.fn(), intake: vi.fn(), complete: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./consolidation-input.js', async original => ({
  ...await original<typeof import('./consolidation-input.js')>(), eventInput: mocks.event,
}));
vi.mock('./consolidation-intake.js', () => ({ pendingConsolidationIntake: mocks.intake,
  mergeHasIntake: async () => true, completeConsolidationIntake: mocks.complete }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: async () => {} }));
vi.mock('../settings.js', async original => ({ ...await original<typeof import('../settings.js')>(),
  getActiveEmbeddingConfig: async () => ({ id: 'config' }) }));
vi.mock('./vectors.js', () => ({ Vectors: class { config = { id: 'config' }; async close() {} } }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.intake.mockResolvedValue([{ revision_id: 'revision', novel: true }]);
  mocks.event.mockImplementation(async (id: string) => ({ id, text: id, fingerprint: id,
    reports: [{ text: id, sourceUrl: null, links: [] }] }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('checkpoints a healthy comparison sweep and reuses decisions without deferring the completed pair', async () => {
  const saved = new Map<string, unknown>();
  const ids = ['first', 'second', 'third'];
  mocks.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT DISTINCT s.id')) return { rows: [{ id: ids[0] }] };
    if (sql.startsWith('WITH current_mentions')) return { rows: ids.filter(id => id !== args[0]).map(id => ({ id })) };
    if (sql==='SELECT value FROM operational_state WHERE key=$1') {
      const value = saved.get(String(args[0])); return { rows: value ? [{ value }] : [] };
    }
    if (sql.includes('INSERT INTO operational_state')) saved.set(String(args[0]), JSON.parse(String(args[1])));
    return { rows: [] };
  });
  vi.stubEnv('PROCESSING_SLICE_MS', '1000');
  let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const judge = vi.fn(async () => ({ type: 'choice' as const, choice: 'different', probabilities: {}, confidence: 1 }));
  judge.mockImplementationOnce(async () => {
    clock = 1001; return { type: 'choice', choice: 'different', probabilities: {}, confidence: 1 };
  });
  await expect(withProcessingSlice(() => consolidateStories(defaultSettings, { judgments: { judge } })))
    .rejects.toBeInstanceOf(ProcessingYield);
  expect(judge).toHaveBeenCalledOnce(); expect(saved.size).toBe(1); expect(mocks.complete).not.toHaveBeenCalled();
  expect([...saved.keys()].every(key => key.startsWith('consolidation_decision:'))).toBe(true);
  await withProcessingSlice(() => consolidateStories(defaultSettings, { judgments: { judge } }));
  expect(judge).toHaveBeenCalledTimes(2); expect(mocks.complete).toHaveBeenCalledOnce();
  expect(saved.size).toBe(2);
});
