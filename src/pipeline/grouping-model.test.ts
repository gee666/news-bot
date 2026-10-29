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
  const key = (inputHash: unknown) => JSON.stringify([inputHash, ...args.slice(1, 3)]);
  if (sql.includes('SELECT input_hash,value')) return { rows: (args[0] as string[])
    .flatMap(input_hash => cache.has(key(input_hash)) ? [{ input_hash, value: cache.get(key(input_hash)) }] : []) };
  const values = args[3] as string[];
  for (const [index, inputHash] of (args[0] as string[]).entries()) cache.set(key(inputHash), JSON.parse(String(values[index])));
  return { rows: [] };
}) } }));
beforeEach(() => { cache.clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
vi.mock('./privacy.js', () => ({ approveRemoteInput: vi.fn() }));
vi.mock('./generation-model.js', () => ({ recordGenerationFailure: vi.fn(), generationError: vi.fn() }));
const context = { id: randomUUID(), attempt: 3, batchId: null, revisionId: null, storyId: null };
function report(text: string, url = 'https://example.org/news'): EventInput {
  return { id: randomUUID(), text, fingerprint: randomUUID(), reports: [{ text, sourceUrl: url, links: [url], publishedAt: '2026-10-26T19:00:00.000Z' }] };
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
  expect(request?.systemPrompt).toContain('One incident affecting several subjects at once');
  expect(request?.systemPrompt).toContain('the partial report is the same event with fewer details');
  expect(request?.systemPrompt).toContain('one specific headline, not joined separate headlines');
  expect(request?.systemPrompt).toContain('Telegram outage worldwide versus Telegram and Max fell synchronously worldwide versus Max also has mass failures, published within hours, are SAME');
  expect(request?.systemPrompt).toContain('Use report publishedAt times');
  expect(request?.systemPrompt).toContain('different days, are separate occurrences unless evidence links them');
  expect(request?.systemPrompt).toContain('Time proximity alone never makes unrelated subjects same');
  expect(request?.systemPrompt).toContain('joining genuinely different developments with and');
});
it('keeps vendor-roundup announcements distinct in the existing grouping prompt without extra calls', async () => {
  const url = 'https://blogs.nvidia.com/blog/local-ai-rtx-spark-laptops-updates-models-agents-games/';
  const incoming = report('S-GAME launches Phantom Blade Zero with NVIDIA graphics support on RTX Spark.', url);
  const candidate = report('Liquid AI releases LFM3 models with local RTX Spark support.', url);
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    expect(request.systemPrompt).toContain('A vendor roundup is a container, not one event');
    expect(request.systemPrompt).toContain('share sourceUrl, publication time, vendor hardware or platform support');
    expect(request.systemPrompt).toContain('Liquid AI releasing LFM3 models versus S-GAME launching Phantom Blade Zero with NVIDIA graphics support are UNRELATED');
    expect(request.systemPrompt).toContain('one shared occurrence, not separate products in a vendor update');
    return modelResult({ matches: [{ storyId: candidate.id, relation: 'unrelated', relatedEvidence: null }] });
  }) };
  expect(await groupReport(incoming, [candidate], defaultSettings, context, generator))
    .toEqual([{ storyId: candidate.id, relation: 'unrelated' }]);
  expect(generator.generate).toHaveBeenCalledOnce();
});
it.each(['same', 'unrelated', 'related'] as const)('requires nullable evidence in the provider schema for %s decisions', async relation => {
  const incoming = report('A discovered a PHP flaw.');
  const candidate = report('B shut down because of the PHP flaw.');
  const evidence = { incomingQuote: incoming.text, candidateQuote: candidate.text, connection: 'The flaw caused the shutdown.' };
  const generator = { supportsNativeSchema: true, generate: vi.fn(async (request: PiRequest) => {
    expect(request.responseSchema).toMatchObject({ name: 'story_grouping', schema: {
      type: 'object', required: ['matches'], additionalProperties: false,
      properties: { matches: { type: 'array', items: {
        type: 'object', required: ['storyId', 'relation', 'relatedEvidence'], additionalProperties: false,
        properties: { relatedEvidence: { anyOf: [
          { type: 'object', required: ['incomingQuote', 'candidateQuote', 'connection'], additionalProperties: false },
          { type: 'null' },
        ] } },
      } } },
    } });
    expect(request.systemPrompt).toContain('Set relatedEvidence to null for same or unrelated');
    return modelResult({ matches: [{ storyId: candidate.id, relation, relatedEvidence: relation === 'related' ? evidence : null }] });
  }) };
  expect(await groupReport(incoming, [candidate], defaultSettings, context, generator)).toEqual([
    { storyId: candidate.id, relation, ...(relation === 'related' ? { relatedEvidence: evidence, relatedPromptVersion: 'duplicate-v6' } : {}) },
  ]);
  expect(generator.generate).toHaveBeenCalledOnce();
});
it.each(['incomingQuote', 'candidateQuote', 'connection'])('still rejects blank related %s locally', async field => {
  const incoming = report('A discovered a PHP flaw.');
  const candidate = report('B shut down because of the PHP flaw.');
  const generator = { generate: vi.fn(async () => modelResult({ matches: [{ storyId: candidate.id, relation: 'related',
    relatedEvidence: { incomingQuote: incoming.text, candidateQuote: candidate.text, connection: 'The flaw caused the shutdown.', [field]: '   ' },
  }] })) };
  await expect(groupReport(incoming, [candidate], defaultSettings, context, generator)).rejects.toThrow();
  expect(generator.generate).toHaveBeenCalledTimes(2);
});
it('rejects invented or repeated IDs rather than attaching reports to an unrelated story', async () => {
  const candidate = report('Release.');
  const generator = { generate: vi.fn().mockResolvedValue(modelResult({ matches: [{ storyId: randomUUID(), relation: 'same' }] })) };
  await expect(groupReport(report('Release.'),[candidate],defaultSettings,context,generator)).rejects.toThrow();
  expect(generator.generate).toHaveBeenCalledTimes(2);
  expect(cache.size).toBe(0);
});
it('uses only the original comparison for related decisions and caches it without a second model call', async () => {
  const incoming=report('OpenAI found a critical PHP flaw.');
  const candidates=[report('Alderon shut down because of that PHP flaw.'),report('A company released unrelated servers.')];
  const matches=candidates.map((candidate,index)=>({storyId:candidate.id,relation:index===0?'related':'unrelated',
    ...(index===0 ? { relatedEvidence: { incomingQuote:incoming.text,candidateQuote:candidate.text,
      connection:'The game shutdown was caused by the discovered PHP vulnerability.' } } : {}) }));
  const generator={generate:vi.fn(async(request:PiRequest)=>{
    expect(request.systemPrompt).toContain('documented cause, consequence, direct response');
    expect(request.systemPrompt).toContain('Shared companies, products, skills, security risks');
    expect(request.systemPrompt).toContain('missing or ambiguous, choose unrelated');
    expect(request.systemPrompt).toContain('General forecasts about an industry');
    expect(request.systemPrompt).toContain('Juxtaposition in one source post');
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
  expect(decisions).toEqual([{ storyId:candidates[0]?.id,relation:'same' }]);
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toEqual(decisions);
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

it.each(['missing', 'invented incoming', 'invented candidate'])('omits related decisions with %s evidence without verification calls', async kind => {
  const incoming = report('A forecast of rising GPU prices.');
  const candidates = [report('An independent model release.'), report('A different event.')];
  const generator = { generate: vi.fn(async () => modelResult({ matches: [
    { storyId:candidates[0]?.id,relation:'related', ...(kind === 'missing' ? {} : { relatedEvidence: {
      incomingQuote:kind === 'invented incoming' ? 'Not in the report' : incoming.text,
      candidateQuote:kind === 'invented candidate' ? 'Not in the report' : candidates[0]?.text,
      connection:'A claimed causal connection',
    } }) }, { storyId:candidates[1]?.id,relation:'unrelated' },
  ] })) };
  const expected = [{ storyId:candidates[1]?.id,relation:'unrelated' }];
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toEqual(expected);
  expect(await groupReport(incoming,candidates,defaultSettings,context,generator)).toEqual(expected);
  expect(generator.generate).toHaveBeenCalledOnce();
  expect(generator.generate.mock.calls[0]).toBeDefined();
});

it('tells the bounded repair which candidate IDs were missing without expanding its source prompt', async () => {
  const incoming = report('Release.');
  const candidates = [report('First report.'), report('Second report.')];
  const matches = candidates.map(candidate => ({ storyId: candidate.id, relation: 'unrelated' }));
  const generate = vi.fn().mockResolvedValueOnce(modelResult({ matches: matches.slice(0, 1) }))
    .mockResolvedValueOnce(modelResult({ matches }));
  expect(await groupReport(incoming, candidates, defaultSettings, context, { generate })).toEqual(matches);
  expect(generate.mock.calls[1]?.[0].prompt).toBe(generate.mock.calls[0]?.[0].prompt);
  expect(generate.mock.calls[1]?.[0].systemPrompt).toContain(`Missing candidate IDs: ${candidates[1]?.id}`);
  expect(generate).toHaveBeenCalledTimes(2);
});


it('reuses chunk-1 pairs after chunk 2 fails and an inserted candidate changes chunk composition', async () => {
  vi.stubEnv('GROUPING_MAX_CANDIDATES', '2');
  const incoming = report('Telegram and Max fell synchronously worldwide');
  const same = report('Telegram outage worldwide');
  const related = report('A response to the Telegram outage');
  const later = report('Max also has mass failures');
  const inserted = report('An independent release');
  const evidence = { incomingQuote: incoming.text, candidateQuote: related.text, connection: 'A response to the outage.' };
  const seen: string[][] = [];
  let fail = true;
  const generator = { generate: vi.fn(async (request: PiRequest) => {
    const chunk = JSON.parse(request.prompt) as { candidates: EventInput[] };
    seen.push(chunk.candidates.map(candidate => candidate.id));
    if (fail && seen.length === 2) { fail = false; throw new Error('network timeout'); }
    return modelResult({ matches: [...chunk.candidates].reverse().map(candidate => ({ storyId: candidate.id,
      relation: candidate.id === same.id && seen.length === 1 || candidate.id === later.id ? 'same'
        : candidate.id === related.id ? 'related' : 'unrelated',
      relatedEvidence: candidate.id === related.id ? evidence : null,
    })) });
  }) };
  await expect(groupReport(incoming, [same, related, later], defaultSettings, context, generator)).rejects.toThrow('network timeout');
  expect(cache.size).toBe(2);
  const ranked = [inserted, same, related, later];
  const expected = [
    { storyId: inserted.id, relation: 'unrelated' },
    { storyId: same.id, relation: 'same' },
    { storyId: related.id, relation: 'related', relatedEvidence: evidence, relatedPromptVersion: 'duplicate-v6' },
  ];
  expect(await groupReport(incoming, ranked, defaultSettings, { ...context, attempt: 4 }, generator)).toEqual(expected);
  expect(seen).toEqual([[same.id, related.id], [later.id], [inserted.id, later.id]]);
  expect(await groupReport(incoming, ranked, defaultSettings, context, generator)).toEqual(expected);
  expect(await groupReport(incoming, [later, same, related, inserted], defaultSettings, context, generator)).toEqual([
    { storyId: later.id, relation: 'same' }, expected[2], expected[0],
  ]);
  expect(generator.generate).toHaveBeenCalledTimes(3);
});

it('invalidates pairs when incoming evidence or source publication times change, but not local receipts', async () => {
  const incoming = report('Telegram outage worldwide');
  const candidate = report('Max also has mass failures');
  const generator = { generate: vi.fn(async () => modelResult({ matches: [{ storyId: candidate.id, relation: 'same' }] })) };
  await groupReport(incoming, [candidate], defaultSettings, context, generator);
  await groupReport({ ...incoming, fingerprint: 'new receipt' }, [{ ...candidate, fingerprint: 'new receipt' }], defaultSettings, context, generator);
  expect(generator.generate).toHaveBeenCalledOnce();
  const changedCandidate = { ...candidate, reports: candidate.reports.map(report => ({ ...report, publishedAt: '2026-10-27T19:00:00.000Z' })) };
  await groupReport(incoming, [changedCandidate], defaultSettings, context, generator);
  expect(generator.generate).toHaveBeenCalledTimes(2);
  const changedIncoming = { ...incoming, reports: incoming.reports.map(report => ({ ...report, text: 'A later outage' })) };
  await groupReport(changedIncoming, [candidate], defaultSettings, context, generator);
  expect(generator.generate).toHaveBeenCalledTimes(3);
});
