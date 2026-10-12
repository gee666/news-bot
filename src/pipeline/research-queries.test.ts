import { expect, it, vi } from 'vitest';
import { planResearchQueries } from './research-queries.js';
import { storyInput, modelResult } from './generation.test-helpers.js';
vi.mock('./generation-model.js', () => ({ recordGenerationFailure: vi.fn() }));
it('deduplicates compact queries and supplies same-event context', async () => {
  const input = storyInput();
  input.mentions[0]!.referent_context = ['GPT-6 Cyber'];
  const generate = vi.fn().mockResolvedValue(modelResult({ queries: ['GPT-6 Cyber DevDay', 'GPT-6 Cyber DevDay'] }));
  expect(await planResearchQueries(input, { generate })).toEqual(['GPT-6 Cyber DevDay']);
  expect(JSON.parse(generate.mock.calls[0]![0].prompt).referents).toEqual(['GPT-6 Cyber']);
});
it('rejects paragraphs and limits attempts to one repair', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult({ queries: ['word '.repeat(20).trim()] }));
  await expect(planResearchQueries(storyInput(), { generate })).rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
  expect(generate).toHaveBeenCalledTimes(2);
});
it('allows no identifiable query without inventing an issuer', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult({ queries: [] }));
  expect(await planResearchQueries(storyInput(), { generate })).toEqual([]);
});
