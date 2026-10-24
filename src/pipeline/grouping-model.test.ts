import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { groupReport } from './grouping-model.js';
import { defaultSettings } from '../settings.js';
import { modelResult } from './generation.test-helpers.js';
import type { EventInput } from './consolidation-input.js';
vi.mock('./privacy.js', () => ({ approveRemoteInput: vi.fn() }));
vi.mock('./generation-model.js', () => ({ recordGenerationFailure: vi.fn() }));
const context = { id: randomUUID(), attempt: 3, batchId: null, revisionId: null, storyId: null };
function report(text: string, url = 'https://example.org/news'): EventInput {
  return { id: randomUUID(), text, fingerprint: randomUUID(), reports: [{ text, sourceUrl: url, links: [url] }] };
}
it('compares all groups once with complete report provenance, even beyond the old shortlist and JEV context', async () => {
  const incoming = report('Compiler 2 is now available for $40.');
  const candidates = Array.from({ length: 30 }, (_, index) => report(`Report ${index}. ` + 'Detail. '.repeat(5000)));
  const last = candidates.at(-1);
  if (!last) throw new Error('Missing fixture');
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches: candidates.map(candidate => ({ storyId: candidate.id, relation: candidate.id === last.id ? 'same' : 'unrelated' })) })) };
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toContainEqual({ storyId: last.id, relation: 'same' });
  expect(generator.generate).toHaveBeenCalledOnce();
  const request = generator.generate.mock.calls[0]?.[0];
  expect(JSON.parse(request.prompt)).toEqual({ incoming,candidates });
  expect(request.systemPrompt).toContain('no bridging');
  expect(request.systemPrompt).toContain('downloadable quantized checkpoint');
  expect(request.systemPrompt).toContain('same SPECIFIC headline');
});
it('rejects invented or repeated IDs rather than attaching reports to an unrelated story', async () => {
  const candidate = report('Release.');
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches: [{ storyId: randomUUID(), relation: 'same' }] })) };
  await expect(groupReport(report('Release.'),[candidate],defaultSettings,context,generator)).rejects.toThrow();
  expect(generator.generate).toHaveBeenCalledTimes(2);
});
it('classifies discovery, consequence and unrelated news in the existing single question', async () => {
  const candidates = [report('OpenAI discovered a PHP vulnerability.'), report('Alderon shut down its game because of the PHP flaw.'), report('Acme released a compiler.')];
  const matches = candidates.map((candidate, index) => ({ storyId: candidate.id, relation: ['same','related','unrelated'][index] }));
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches })) };
  expect(await groupReport(report('OpenAI model found a vulnerability in PHP.'), candidates, defaultSettings, context, generator)).toEqual(matches);
  expect(generator.generate).toHaveBeenCalledOnce();
  expect(generator.generate.mock.calls[0]?.[0].systemPrompt).toContain('RELATED, not SAME');
});
it.each(['missing','repeated','retired update'])('rejects %s candidate classifications rather than guessing unrelated', async kind => {
  const candidates = [report('Release.'), report('Other release.')];
  const matches = kind === 'missing' ? [{ storyId: candidates[0]?.id, relation: 'same' }]
    : kind === 'repeated' ? candidates.map(() => ({ storyId: candidates[0]?.id, relation: 'same' }))
    : candidates.map(candidate => ({ storyId: candidate.id, relation: 'update' }));
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches })) };
  await expect(groupReport(report('Release.'), candidates, defaultSettings, context, generator)).rejects.toThrow();
});
it('does not call a model when no earlier story exists', async () => {
  const generator = { generate: vi.fn() };
  expect(await groupReport(report('New release.'),[],defaultSettings,context,generator)).toEqual([]);
  expect(generator.generate).not.toHaveBeenCalled();
});
