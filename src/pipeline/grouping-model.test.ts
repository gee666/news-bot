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
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches: [{ storyId: last.id, relation: 'update' }] })) };
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toEqual([{ storyId: last.id, relation: 'update' }]);
  expect(generator.generate).toHaveBeenCalledOnce();
  const request = generator.generate.mock.calls[0]?.[0];
  expect(JSON.parse(request.prompt)).toEqual({ incoming,candidates });
  expect(request.systemPrompt).toContain('no bridging');
  expect(request.systemPrompt).toContain('downloadable quantized checkpoint');
  expect(request.systemPrompt).toContain('Mere wording changes are same');
});
it('rejects invented or repeated IDs rather than attaching reports to an unrelated story', async () => {
  const candidate = report('Release.');
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches: [{ storyId: randomUUID(), relation: 'same' }] })) };
  await expect(groupReport(report('Release.'),[candidate],defaultSettings,context,generator)).rejects.toThrow();
  expect(generator.generate).toHaveBeenCalledTimes(2);
});
it('does not call a model when no earlier story exists', async () => {
  const generator = { generate: vi.fn() };
  expect(await groupReport(report('New release.'),[],defaultSettings,context,generator)).toEqual([]);
  expect(generator.generate).not.toHaveBeenCalled();
});
