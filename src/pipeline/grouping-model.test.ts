import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { PiRequest } from '../models/pi.js';
import { groupingChunks, groupingPrompt } from './grouping-budget.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';
import { groupReport } from './grouping-model.js';
import { defaultSettings } from '../settings.js';
import { modelResult } from './generation.test-helpers.js';
import type { EventInput } from './consolidation-input.js';
const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../db.js', () => ({ db: { query: vi.fn(async (sql: string, args: unknown[]) => {
  const key = JSON.stringify(args.slice(0, 3));
  if (sql.includes('SELECT value')) return { rows: cache.has(key) ? [{ value: cache.get(key) }] : [] };
  cache.set(key, JSON.parse(String(args[3])));
  return { rows: [] };
}) } }));
beforeEach(() => { cache.clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
vi.mock('./privacy.js', () => ({ approveRemoteInput: vi.fn() }));
vi.mock('./generation-model.js', () => ({ recordGenerationFailure: vi.fn(), generationError: vi.fn() }));
const context = { id: randomUUID(), attempt: 3, batchId: null, revisionId: null, storyId: null };
function report(text: string, url = 'https://example.org/news'): EventInput {
  return { id: randomUUID(), text, fingerprint: randomUUID(), reports: [{ text, sourceUrl: url, links: [url] }] };
}
it('compares every retained group in bounded requests with complete report provenance', async () => {
  const incoming = report('Compiler 2 is now available for $40.');
  const candidates = Array.from({ length: 30 }, (_, index) => report(`Report ${index}. ` + 'Detail. '.repeat(1500)));
  const last = candidates.at(-1);
  if (!last) throw new Error('Missing fixture');
  const seen: Array<Pick<EventInput, 'id' | 'reports'>> = [];
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    expect(Buffer.byteLength(request.prompt)).toBeLessThanOrEqual(98_304);
    const chunk = JSON.parse(request.prompt) as { incoming: EventInput; candidates: EventInput[] };
    expect(chunk.incoming).toEqual({ id: incoming.id, reports: incoming.reports });
    seen.push(...chunk.candidates);
    return modelResult({ matches: chunk.candidates.map(candidate => ({ storyId: candidate.id,
      relation: candidate.id === last.id ? 'same' : 'unrelated' })) });
  }) };
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toContainEqual({ storyId: last.id, relation: 'same' });
  expect(seen).toEqual(candidates.map(({ id, reports }) => ({ id, reports })));
  expect(generator.generate.mock.calls.length).toBeGreaterThan(1);
  const request = generator.generate.mock.calls[0]?.[0];
  expect(request?.systemPrompt).toContain('no bridging');
  expect(request?.systemPrompt).toContain('downloadable quantized checkpoint');
  expect(request?.systemPrompt).toContain('same SPECIFIC headline');
});
it('rejects invented or repeated IDs rather than attaching reports to an unrelated story', async () => {
  const candidate = report('Release.');
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches: [{ storyId: randomUUID(), relation: 'same' }] })) };
  await expect(groupReport(report('Release.'),[candidate],defaultSettings,context,generator)).rejects.toThrow();
  expect(generator.generate).toHaveBeenCalledTimes(2);
});
it('uses only the original comparison for related decisions and caches it without a second model call', async () => {
  const incoming=report('OpenAI found a critical PHP flaw.');
  const candidates=[report('Alderon shut down because of that PHP flaw.'),report('A company released unrelated servers.')];
  const matches=candidates.map((candidate,index)=>({storyId:candidate.id,relation:index===0?'related':'unrelated'}));
  const generator={generate:vi.fn(async(request:PiRequest)=>{
    expect(request.systemPrompt).toContain('documented cause, consequence, direct response');
    expect(request.systemPrompt).toContain('Shared companies, products, skills, security risks');
    expect(request.systemPrompt).toContain('missing or ambiguous, choose unrelated');
    return modelResult({matches});
  })};
  const decisions=await groupReport(incoming,candidates,defaultSettings,context,generator);
  expect(decisions).toEqual([{...matches[0],relatedPromptVersion:'duplicate-v6'},matches[1]]);
  expect(generator.generate).toHaveBeenCalledOnce();
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toEqual(decisions);
  expect(generator.generate).toHaveBeenCalledOnce();
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

it('budgets UTF-8 bytes and candidate count without truncation or omissions', () => {
  const incoming = report('Новость');
  const candidates = Array.from({ length: 5 }, () => report('Я'.repeat(1000)));
  const bytes = Buffer.byteLength(groupingPrompt(incoming, candidates.slice(0, 2)));
  const chunks = groupingChunks(incoming, candidates, { maxBytes: bytes, maxCandidates: 2 });
  expect(chunks.map(chunk => chunk.length)).toEqual([2, 2, 1]);
  expect(chunks.flat()).toEqual(candidates);
  for (const chunk of chunks) expect(Buffer.byteLength(groupingPrompt(incoming, chunk))).toBeLessThanOrEqual(bytes);
  expect(() => groupingChunks(incoming, candidates, { maxBytes: 100, maxCandidates: 2 })).toThrow('complete story pair');
});
it('reuses completed chunks after a checkpoint without spending another model call', async () => {
  vi.stubEnv('GROUPING_MAX_CANDIDATES', '1');
  vi.stubEnv('PROCESSING_SLICE_MS', '1000');
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const incoming = report('Release');
  const candidates = [report('One'), report('Two')];
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    clock += 1001;
    const chunk = JSON.parse(request.prompt) as { candidates: EventInput[] };
    return modelResult({ matches: chunk.candidates.map(candidate => ({ storyId: candidate.id, relation: 'unrelated' })) });
  }) };
  await expect(withProcessingSlice(() => groupReport(incoming,candidates,defaultSettings,context,generator))).rejects.toBeInstanceOf(ProcessingYield);
  expect(generator.generate).toHaveBeenCalledTimes(1);
  expect(await withProcessingSlice(() => groupReport(incoming,candidates,defaultSettings,context,generator))).toHaveLength(2);
  expect(generator.generate).toHaveBeenCalledTimes(2);
  await groupReport(incoming,candidates,defaultSettings,context,generator);
  expect(generator.generate).toHaveBeenCalledTimes(2);
  await groupReport(incoming,candidates,{ ...defaultSettings, modelVersion: defaultSettings.modelVersion + 1 },context,generator);
  expect(generator.generate).toHaveBeenCalledTimes(4);
});
it('does not cache incomplete classifications or reuse changed evidence', async () => {
  const incoming = report('Release');
  const candidates = [report('One')];
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    const chunk = JSON.parse(request.prompt) as { candidates: EventInput[] };
    return modelResult({ matches: chunk.candidates.map(candidate => ({ storyId: candidate.id, relation: 'unrelated' })) });
  }) };
  await groupReport(incoming,candidates,defaultSettings,context,generator);
  const first = candidates[0];
  if (!first) throw new Error('Missing fixture');
  await groupReport(incoming,[{ ...first, reports: [{ text: 'Changed evidence', sourceUrl: 'https://example.org/news', links: [] }] }],defaultSettings,context,generator);
  expect(generator.generate).toHaveBeenCalledTimes(2);
  for (const key of cache.keys()) cache.set(key, { matches: [] });
  await groupReport(incoming,candidates,defaultSettings,context,generator);
  expect(generator.generate).toHaveBeenCalledTimes(3);
});
it.each([1, 2])('attaches only to the highest-ranked same candidate with chunk size %i', async size => {
  vi.stubEnv('GROUPING_MAX_CANDIDATES', String(size));
  const incoming = report('Broad recap');
  const candidates = [report('A discovered a bug'), report('B shut down a game'), report('Other release')];
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    const chunk = JSON.parse(request.prompt) as { incoming: EventInput; candidates: EventInput[] };
    expect(chunk.incoming.id).toBe(incoming.id);
    return modelResult({ matches: [...chunk.candidates].reverse().map(candidate => ({ storyId: candidate.id, relation: 'same' })) });
  }) };
  const decisions = await groupReport(incoming,candidates,defaultSettings,context,generator);
  expect(decisions.filter(decision => decision.relation === 'same')).toEqual([{ storyId: candidates[0]?.id, relation: 'same' }]);
  expect(decisions.filter(decision => decision.relation === 'related')).toEqual(candidates.slice(1).map(candidate => ({
    storyId: candidate.id, relation: 'related', relatedPromptVersion: 'duplicate-v6',
  })));
  expect(generator.generate).toHaveBeenCalledTimes(Math.ceil(candidates.length / size));
});
it('bounds repair evidence without appending an oversized invalid response', async () => {
  const incoming = report('Release');
  const candidates = [report('One')];
  let calls = 0;
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    expect(request.prompt).toBe(groupingPrompt(incoming, candidates));
    calls++;
    return modelResult(calls === 1 ? 'x'.repeat(200_000)
      : { matches: candidates.map(candidate => ({ storyId: candidate.id, relation: 'unrelated' })) });
  }) };
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toHaveLength(1);
  expect(generator.generate).toHaveBeenCalledTimes(2);
});
it('preserves all 703 candidates in a multi-megabyte retained catalogue', async () => {
  const incoming = report('Current release');
  const candidates = Array.from({ length: 703 }, (_, index) => report(`Story ${index}. ` + 'Я'.repeat(1500)));
  const seen: string[] = [];
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    expect(Buffer.byteLength(request.prompt)).toBeLessThanOrEqual(98_304);
    const chunk = JSON.parse(request.prompt) as { candidates: EventInput[] };
    expect(chunk.candidates.length).toBeLessThanOrEqual(32);
    seen.push(...chunk.candidates.map(candidate => candidate.id));
    return modelResult({ matches: chunk.candidates.map(candidate => ({ storyId: candidate.id, relation: 'unrelated' })) });
  }) };
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toHaveLength(703);
  expect(seen).toEqual(candidates.map(candidate => candidate.id));
});
