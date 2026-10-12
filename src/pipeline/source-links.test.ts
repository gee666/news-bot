import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { associateSourceLinks, sourceLinkState } from './source-links.js';
import { confirmSourceLinks } from './source-links-confirmation.js';
import { pendingSourceMessages, completeSourceMessage } from './source-links-queue.js';
import { jevTemplates } from '../models/templates.js';
import { ModelRequestError, RequestFault, failureMetadata } from '../models/errors.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), event: vi.fn(), privacy: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: async (fn: (client: {query: typeof mocks.query}) => Promise<unknown>) => fn({query:mocks.query}) }));
vi.mock('./consolidation-input.js', async original => ({
  ...await original<typeof import('./consolidation-input.js')>(),eventInput: mocks.event,
}));
vi.mock('./privacy.js', () => ({approveRemoteInput:mocks.privacy}));
vi.mock('./source-links-confirmation.js', async original => ({ ...await original<typeof import('./source-links-confirmation.js')>(),
  SOURCE_CONFIRMATION_VERSION: 'source-link-confirmation-v1',confirmSourceLinks: vi.fn() }));
vi.mock('./source-links-queue.js', () => ({ pendingSourceMessages: vi.fn(), completeSourceMessage: vi.fn() }));
const revision = '11111111-1111-4111-8111-111111111111';
const linkId = '22222222-2222-4222-8222-222222222222';
const first = '33333333-3333-4333-8333-333333333333';
const second = '44444444-4444-4444-8444-444444444444';
const text = 'Все релизы с DevDay: https://openai.com/ru-RU/index/devday-2026-recap/';
const link = {id:linkId,url:'https://openai.com/ru-RU/index/devday-2026-recap/',anchor_text:'Все релизы'};
const judge = vi.fn();
const answer = (value:string) => ({type:'choice',choice:value,probabilities:{[value]:1},confidence:1});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(confirmSourceLinks).mockImplementation(async input => input.candidates.map(candidate => ({
    candidate_id: candidate.candidate_id, verdict: 'relevant', reason: 'Same event',
    source_quote: input.message, story_quote: candidate.story,
  })));
  vi.mocked(pendingSourceMessages).mockResolvedValue([{revision_id:revision,original_text:text,processing_key:'fixture'}]);
  mocks.query.mockImplementation(async (sql:string,args: unknown[] = []) => {
    if(sql.startsWith('SELECT r.id AS'))return {rows:[{ revisionId: args[0],itemId: args[0],textHash: 'text',linksHash: 'links' }]};
    if(sql.startsWith('SELECT r.id'))return {rows:[{revision_id:revision,original_text:text}]};
    if(sql.startsWith('SELECT id,url'))return {rows:[link]};
    if(sql.startsWith('SELECT s.id'))return {rows:[{id:first},{id:second}]};
    if(sql.includes('INSERT INTO story_link_sources'))return {rows:[{story_id:first}]};
    return {rows:[]};
  });
  mocks.event.mockImplementation(async (id:string)=>({id,text:'OpenAI DevDay ' + id,fingerprint:id,
    reports:[{ text:'OpenAI DevDay '+id,sourceUrl:null,links:[] }] }));
  judge.mockImplementation(async (template:string)=>answer(template==='source_link_role'?'source_only':'relevant'));
});
it('accepts the exact official recap as a contribution to two existing stories, never a new story', async () => {
  expect(await associateSourceLinks(defaultSettings,{judgments:{judge}})).toMatchObject({messages:1,compared:2,associated:2});
  expect(confirmSourceLinks).toHaveBeenCalledOnce();
  expect(vi.mocked(confirmSourceLinks).mock.calls[0]?.[0].candidates).toHaveLength(2);
  expect(judge.mock.calls[0]?.[1]).toEqual({message:{text},links:[{url:link.url,anchor:link.anchor_text}]});
  expect(judge.mock.calls[1]?.[1]).toEqual(sourceLinkState(text,link,'OpenAI DevDay '+first));
  expect(mocks.query.mock.calls.filter(call=>call[0].includes('INSERT INTO story_link_sources'))).toHaveLength(2);
  expect(mocks.query.mock.calls.some(call=>/INSERT INTO stories\b|UPDATE story_mentions/u.test(call[0]))).toBe(false);
});
it('preserves caller stage identity and retry attempt for role and relevance judgments', async () => {
  const context = { id: first, batchId: second, attempt: 4 };
  await associateSourceLinks(defaultSettings, { judgments: { judge }, context });
  for (const call of judge.mock.calls) {
    expect(call[2]).toMatchObject({ batchId: context.batchId,attempt: context.attempt });
    expect(String(call[2].id).startsWith(context.id+':')).toBe(true);
  }
});
it.each(['excluded','other'])('does not associate %s source messages with any story', async role => {
  judge.mockResolvedValue(answer(role));
  const result=await associateSourceLinks(defaultSettings,{judgments:{judge}});
  expect(result.excluded).toBe(1);
  expect(judge).toHaveBeenCalledOnce();
  expect(mocks.event).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(call=>call[0].includes('INSERT INTO story_link_sources'))).toBe(false);
});
it('retains uncertain/irrelevant decisions for audit but does not count them as source attachments', async () => {
  judge.mockResolvedValueOnce(answer('source_only')).mockResolvedValueOnce(answer('uncertain')).mockResolvedValueOnce(answer('irrelevant'));
  expect((await associateSourceLinks(defaultSettings,{judgments:{judge}})).associated).toBe(0);
  const writes=mocks.query.mock.calls.filter(call=>call[0].includes('INSERT INTO story_link_sources'));
  expect(writes.map(call=>call[1][2])).toEqual(['uncertain','irrelevant']);
  expect(confirmSourceLinks).not.toHaveBeenCalled();
});
it('requires Pi confirmation of JEV positives and persists negative confirmation only as audit', async () => {
  vi.mocked(confirmSourceLinks).mockImplementation(async input => input.candidates.map((candidate,index) => ({
    candidate_id: candidate.candidate_id, verdict: index === 0 ? 'irrelevant' : 'relevant',
    reason: index === 0 ? 'Different named cloud products' : 'Same named product',
    source_quote: input.message, story_quote: candidate.story,
  })));
  expect((await associateSourceLinks(defaultSettings,{judgments:{judge}})).associated).toBe(1);
  const writes=mocks.query.mock.calls.filter(call=>call[0].includes('INSERT INTO story_link_sources'));
  expect(writes.map(call=>call[1][2])).toEqual(['irrelevant','relevant']);
  expect(writes.every(call=>call[1][5].includes('source-link-confirmation-v1'))).toBe(true);
});
it('does not persist positives or stamp completion when Pi confirmation fails', async () => {
  const error=new Error('provider failure');
  vi.mocked(confirmSourceLinks).mockRejectedValue(error);
  expect(await associateSourceLinks(defaultSettings,{judgments:{judge}})).toMatchObject({ deferred: 1, associated: 0 });
  expect(completeSourceMessage).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(call=>call[0].includes('INSERT INTO story_link_sources'))).toBe(false);
});
it('runs each message through its isolation boundary with the exact message stage context', async () => {
  const good = { revision_id: second, original_text: 'Independent source message', processing_key: 'good' };
  vi.mocked(pendingSourceMessages).mockResolvedValue([
    { revision_id: revision, original_text: text, processing_key: 'bad' }, good,
  ]);
  const failure = new Error('Malformed confirmation');
  vi.mocked(confirmSourceLinks).mockRejectedValueOnce(failure);
  const failed: string[] = [];
  const messageWork = vi.fn(async (message: { revision_id: string }, run: (context: {
    id: string; revisionId: string; storyId: null; batchId: string; attempt: number;
  }) => Promise<void>) => {
    try { await run({ id: message.revision_id, revisionId: message.revision_id, storyId: null, batchId: first, attempt: 3 }); }
    catch (error) { if (error !== failure) throw error; failed.push(message.revision_id); }
  });
  expect(await associateSourceLinks(defaultSettings, { judgments: { judge }, inputBatchId: first, messageWork }))
    .toMatchObject({ messages: 2, associated: 2 });
  expect(failed).toEqual([revision]);
  expect(messageWork).toHaveBeenCalledTimes(2);
  expect(completeSourceMessage).toHaveBeenCalledExactlyOnceWith(good, 'source_only');
  for (const call of judge.mock.calls) {
    expect(call[2]).toMatchObject({ batchId: first,attempt: 3 });
    expect(String(call[2].id).startsWith(String(call[2].revisionId)+':')).toBe(true);
  }
  expect(vi.mocked(pendingSourceMessages).mock.calls[0]?.[3]).toBe(first);
});
it('does not save an association when the current aggregate changes during inference', async () => {
  mocks.event.mockResolvedValueOnce({id:first,text:'Event',fingerprint:'before',reports:[]})
    .mockResolvedValueOnce({id:first,text:'Changed',fingerprint:'after',reports:[]}).mockResolvedValue(null);
  expect((await associateSourceLinks(defaultSettings,{judgments:{judge}})).associated).toBe(0);
  expect(mocks.query.mock.calls.some(call=>call[0].includes('INSERT INTO story_link_sources'))).toBe(false);
});
it('passes complete messages and all links through the default path to Pi', async () => {
  const message = { revision_id: revision, original_text: text.repeat(3000), processing_key: 'fixture' };
  const links = Array.from({ length: 21 }, (_, index) => ({ ...link,
    id: linkId.slice(0, -12) + String(index).padStart(12, '0'), url: `${link.url}?source=${index}` }));
  vi.mocked(confirmSourceLinks).mockImplementation(async input => input.candidates.map(candidate => ({
    candidate_id: candidate.candidate_id, verdict: 'relevant', reason: 'Same event', source_quote: text, story_quote: candidate.story,
  })));
  vi.mocked(pendingSourceMessages).mockResolvedValue([message]);
  const query = mocks.query.getMockImplementation();
  if (!query) throw new Error('Missing query fixture');
  mocks.query.mockImplementation((sql: string, args: unknown[] = []) =>
    sql.startsWith('SELECT id,url') ? Promise.resolve({ rows: links }) : query(sql, args));
  await associateSourceLinks(defaultSettings, { judgments: { judge } });
  expect(judge.mock.calls[0]?.[1]).toEqual({ message: { text: message.original_text },
    links: links.map(value => ({ url: value.url, anchor: value.anchor_text })).sort((a,b) => a.url.localeCompare(b.url)) });
  expect(vi.mocked(confirmSourceLinks).mock.calls[0]?.[0].message).toBe(message.original_text);
  expect(vi.mocked(confirmSourceLinks).mock.calls[0]?.[0].candidates).toHaveLength(42);
  expect(completeSourceMessage).toHaveBeenCalledExactlyOnceWith(message, 'source_only');
});
it('passes a large confirmation candidate to Pi without dropping associations', async () => {
  vi.mocked(confirmSourceLinks).mockImplementation(async input=>input.candidates.map(candidate=>({
    candidate_id:candidate.candidate_id,verdict:'relevant',reason:'Same event',source_quote:input.message,story_quote:'OpenAI DevDay',
  })));
  mocks.event.mockImplementation(async (id: string) => ({ id, fingerprint: id,
    text: id === first ? 'OpenAI DevDay ' + 'x'.repeat(150_000) : 'OpenAI DevDay',
    reports:[{ text:'OpenAI DevDay '+id,sourceUrl:null,links:[] }] }));
  const result = await associateSourceLinks(defaultSettings, { judgments: { judge } });
  expect(result).toMatchObject({ compared: 2, associated: 2 });
  expect(vi.mocked(confirmSourceLinks).mock.calls[0]?.[0].candidates[0]?.story).toBe('OpenAI DevDay ' + 'x'.repeat(150_000));
  expect(vi.mocked(confirmSourceLinks).mock.calls[0]?.[0].candidates.map(candidate => candidate.story_id)).toEqual([first,second]);
  const writes = mocks.query.mock.calls.filter(call => call[0].includes('INSERT INTO story_link_sources'));
  expect(writes).toHaveLength(2);
  expect(completeSourceMessage).toHaveBeenCalledOnce();
});
it('yields before new comparisons and reuses a completed role without recording a failure', async () => {
  const saved = new Map<string, unknown>();
  const query = mocks.query.getMockImplementation(); if (!query) throw new Error('Missing query fixture');
  mocks.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql==='SELECT value FROM operational_state WHERE key=$1') {
      const value = saved.get(String(args[0])); return { rows: value ? [{ value }] : [] };
    }
    if (sql.includes('INSERT INTO operational_state')) saved.set(String(args[0]), JSON.parse(String(args[1])));
    return query(sql,args);
  });
  const previous = process.env.PROCESSING_SLICE_MS;
  process.env.PROCESSING_SLICE_MS = '1000';
  let clock = 0; const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  judge.mockImplementationOnce(async () => { clock = 1001; return answer('source_only'); });
  try {
    await expect(withProcessingSlice(() => associateSourceLinks(defaultSettings, { judgments: { judge } }))).rejects.toBeInstanceOf(ProcessingYield);
    expect(judge).toHaveBeenCalledOnce();
    expect(completeSourceMessage).not.toHaveBeenCalled(); expect(confirmSourceLinks).not.toHaveBeenCalled();
    expect([...saved.keys()].every(key => key.startsWith('source_selection_decision:'))).toBe(true);
    expect(saved.size).toBe(1);
    await withProcessingSlice(() => associateSourceLinks(defaultSettings, { judgments: { judge } }));
    expect(judge.mock.calls.filter(([task]) => task === 'source_link_role')).toHaveLength(1);
    expect(completeSourceMessage).toHaveBeenCalledOnce();
  } finally {
    now.mockRestore();
    if (previous === undefined) delete process.env.PROCESSING_SLICE_MS; else process.env.PROCESSING_SLICE_MS = previous;
  }
});

it('versions link relevance and explicitly rejects shared category words between named products', () => {
  const template = jevTemplates.link_relevance;
  expect(template.version).toBe('link-relevance-v3');
  expect(template.questions.relevance.instructions).toContain('Cloud-branded products');
  expect(template.questions.relevance.instructions).toContain('return irrelevant, NOT uncertain');
  expect(template.questions.relevance.criteria.irrelevant).toContain('generic-topic overlap only');
  expect(template.questions.relevance.instructions).not.toContain('Codex');
  expect(template.questions.relevance.instructions).not.toContain('Yandex');
  expect(Object.isFrozen(template.questions)).toBe(true);
  expect(Object.isFrozen(template.questions.relevance.criteria)).toBe(true);
});
it('isolates one definitively invalid link selection and keeps its backoff across catalogue/model changes', async () => {
  const saved = new Map<string, unknown>();
  const query = mocks.query.getMockImplementation(); if (!query) throw new Error('Missing query fixture');
  mocks.query.mockImplementation(async (sql: string,args: unknown[] = []) => {
    if (sql==='SELECT value FROM operational_state WHERE key=$1') {
      const value = saved.get(String(args[0])); return { rows: value ? [{ value }] : [] };
    }
    if (sql.includes('INSERT INTO operational_state')) saved.set(String(args[0]),JSON.parse(String(args[1])));
    return query(sql,args);
  });
  let badCalls = 0;
  judge.mockImplementation(async (template: string,state: unknown,context: { id: string }) => {
    if (template==='link_relevance' && JSON.stringify(state).includes(first)) {
      badCalls++;
      throw new ModelRequestError(failureMetadata(new RequestFault('invalid_output',{ outcome: 'rejected' }),context.id,'jev',1,1));
    }
    return answer(template==='source_link_role' ? 'source_only' : 'relevant');
  });
  expect(await associateSourceLinks(defaultSettings,{ judgments: { judge } })).toMatchObject({ deferred: 1,associated: 1 });
  expect(mocks.query.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO story_link_sources')).map(([,args])=>args[1])).toEqual([second]);
  expect([...saved.entries()].filter(([key])=>key.startsWith('source_link_deferred:')).map(([,value])=>value))
    .toEqual([expect.objectContaining({ storyId: first,phase: 'relevance',status: 'unresolved' })]);
  await associateSourceLinks({ ...defaultSettings,modelVersion: 2 },{ judgments: { judge } });
  expect(badCalls).toBe(1);
});
it.each(['authentication','timeout','throttled','invalid_output'] as const)('isolates uncertain/provider %s outcomes with automatic retry', async kind => {
  judge.mockImplementation(async (template: string,_state: unknown,context: { id: string }) => {
    if (template==='link_relevance') throw new ModelRequestError(failureMetadata(new RequestFault(kind,{ outcome: 'unknown' }),context.id,'jev',1,1));
    return answer('source_only');
  });
  expect(await associateSourceLinks(defaultSettings,{ judgments: { judge } })).toMatchObject({ deferred: 2, associated: 0 });
  expect(mocks.query.mock.calls.some(([sql,args])=>String(sql).includes('INSERT INTO operational_state')
    && String(args?.[0]).startsWith('source_link_deferred:'))).toBe(true);
});
it('a malformed role retries the source message but still processes the next message without a fake role verdict', async () => {
  const good = { revision_id: second,original_text: 'Independent source',processing_key: 'other' };
  vi.mocked(pendingSourceMessages).mockResolvedValue([{ revision_id: revision,original_text: text,processing_key: 'bad' },good]);
  judge.mockResolvedValueOnce(answer('not-a-role'));
  expect(await associateSourceLinks(defaultSettings,{ judgments: { judge } })).toMatchObject({ deferred: 1,associated: 2 });
  expect(completeSourceMessage).toHaveBeenCalledExactlyOnceWith(good,'source_only');
});
it('uses versioned frozen semantic role instructions, not URL-keyword filters', () => {
  expect(jevTemplates.source_link_role.version).toBe('source-link-role-v1');
  expect(Object.isFrozen(jevTemplates.source_link_role.questions)).toBe(true);
  expect(Object.isFrozen(jevTemplates.source_link_role.questions.role.criteria)).toBe(true);
  expect(Object.isFrozen(jevTemplates.source_link_role.questions.role)).toBe(true);
  expect(jevTemplates.source_link_role.questions.role.instructions).toContain('Все релизы с DevDay');
});
