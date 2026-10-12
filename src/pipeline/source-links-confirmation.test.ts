import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { ModelRequestError } from '../models/index.js';
import { failureMetadata, RequestFault } from '../models/errors.js';
import { modelResult } from './generation.test-helpers.js';
import type { PiRequest } from '../models/index.js';
import { sourceInputFromRequest, sourceWireVerdicts } from './source-links.test-helpers.js';
import { confirmSourceLinks, validSourceVerdicts, type SourceConfirmationInput, type SourceVerdict } from './source-links-confirmation.js';
const mocks=vi.hoisted(()=>({query:vi.fn(),privacy:vi.fn(),failure:vi.fn()}));
vi.mock('../db.js',()=>({db:{query:mocks.query}}));
vi.mock('./privacy.js',()=>({approveRemoteInput:mocks.privacy}));
vi.mock('./state.js',async original=>({...await original<typeof import('./state.js')>(),recordFailure:mocks.failure}));
const context={id:'11111111-1111-4111-8111-111111111111',revisionId:'22222222-2222-4222-8222-222222222222',
  storyId:null,batchId:null,attempt:4};
const input:SourceConfirmationInput={revision_id:context.revisionId,message:'Yandex Cloud выложил дайджест. В локальном контуре можно развернуть Stackland.',candidates:[
  {candidate_id:'cloud',story_id:'33333333-3333-4333-8333-333333333333',link_id:'link',url:'https://yandex.cloud/ru/blog/digest-scale-2026',anchor:'дайджест',story:'Codex Cloud сохраняет сессию при закрытии ноутбука.'},
  {candidate_id:'stack',story_id:'44444444-4444-4444-8444-444444444444',link_id:'link',url:'https://yandex.cloud/ru/blog/digest-scale-2026',anchor:'дайджест',story:'Обновленная Stackland создаёт платформу данных в закрытом контуре.'},
]};
const verdicts:SourceVerdict[]=[
  {candidate_id:'cloud',verdict:'irrelevant',reason:'Разные продукты. Общее слово Cloud не связывает их.',source_quote:'Yandex Cloud выложил дайджест.',story_quote:'Codex Cloud сохраняет сессию при закрытии ноутбука.'},
  {candidate_id:'stack',verdict:'relevant',reason:'Источник прямо называет Stackland.',source_quote:'В локальном контуре можно развернуть Stackland.',story_quote:'Обновленная Stackland создаёт платформу данных в закрытом контуре.'},
];
const generate=vi.fn();
beforeEach(()=>{vi.resetAllMocks();mocks.query.mockResolvedValue({rows:[]});
  generate.mockImplementation(async (request: PiRequest) => modelResult(sourceWireVerdicts(request,verdicts)));});
it('checks a source message in one batch and retains only grounded positive verdicts',async()=>{
  expect(await confirmSourceLinks(input,defaultSettings,context,{generate})).toEqual(verdicts);
  expect(generate).toHaveBeenCalledOnce();
  expect(sourceInputFromRequest(generate.mock.calls[0]?.[0])).toEqual(input);
  expect(generate.mock.calls[0]?.[1]).toEqual({operationId:context.id,attempt:4});
  expect(generate.mock.calls[0]?.[0].systemPrompt).toContain('A shared word such as Cloud');
  expect(mocks.query.mock.calls.filter(call=>call[0].includes('INSERT INTO model_cache'))).toHaveLength(1);
  expect(mocks.query.mock.calls.filter(call=>call[0].includes('INSERT INTO judgments'))).toHaveLength(1);
});
it('allows an official recap to support an API explicitly attached to the same event',async()=>{
  const recap:SourceConfirmationInput={...input,message:'Все релизы OpenAI DevDay: https://openai.com/recap',candidates:[{
    candidate_id:'api',story_id:input.candidates[0]!.story_id,link_id:'link',url:'https://openai.com/recap',anchor:'Все релизы',
    story:'На OpenAI DevDay представили Decisions API для классификации запросов.',
  }]};
  const result:SourceVerdict={candidate_id:'api',verdict:'relevant',reason:'Один явно названный DevDay.',source_quote:recap.message,story_quote:recap.candidates[0]!.story};
  generate.mockImplementation(async (request: PiRequest) => modelResult(sourceWireVerdicts(request,[result])));
  expect(await confirmSourceLinks(recap,defaultSettings,context,{generate})).toEqual([result]);
});
it('validates complete IDs and exact quotes with one structured-output repair',async()=>{
  expect(validSourceVerdicts(input,[verdicts[0]!])).toBe(false);
  expect(validSourceVerdicts(input,[verdicts[0]!,verdicts[0]!])).toBe(false);
  expect(validSourceVerdicts(input,[{...verdicts[0]!,candidate_id:'extra'},verdicts[1]!])).toBe(false);
  expect(validSourceVerdicts(input,[{...verdicts[0]!,source_quote:'OpenAI DevDay'},verdicts[1]!])).toBe(false);
  generate.mockImplementationOnce(async (request: PiRequest) => modelResult(sourceWireVerdicts(request,[verdicts[0]!])));
  await confirmSourceLinks(input,defaultSettings,context,{generate});
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1]?.[1]).toEqual({operationId:context.id+':repair',attempt:4});
});
it('fails closed after an invalid repair and records the caller stage/attempt',async()=>{
  generate.mockImplementation(async (request: PiRequest) => {
    const value=sourceWireVerdicts(request,verdicts);
    value.items.cloud!.story_excerpt_id='invented';
    return modelResult(value);
  });
  await expect(confirmSourceLinks(input,defaultSettings,context,{generate})).rejects.toMatchObject({metadata:{kind:'invalid_output',attempt:4}});
  expect(mocks.failure).toHaveBeenCalledWith(expect.objectContaining({operationId:context.id,attempt:4,
    validation:expect.objectContaining({codes:['schema'],fields:['items.?.story_excerpt_id']})}));
  expect(mocks.query.mock.calls.some(call=>call[0].includes('INSERT'))).toBe(false);
});
it('rejects uncitable stories before inference without dropping the candidate',async()=>{
  const uncitable={...input,candidates:[{...input.candidates[0]!,story:' \n'}]};
  await expect(confirmSourceLinks(uncitable,defaultSettings,context,{generate})).rejects.toMatchObject({
    metadata:{kind:'invalid_request',outcome:'not_submitted',attempt:4},
  });
  expect(generate).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(call=>call[0].includes('INSERT'))).toBe(false);
});
it('ignores an ungrounded cached result and persists only locally resolved exact evidence',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{value:{items:[{...verdicts[0],story_quote:'invented'},verdicts[1]]}}]});
  expect(await confirmSourceLinks(input,defaultSettings,context,{generate})).toEqual(verdicts);
  expect(generate).toHaveBeenCalledOnce();
  const writes=mocks.query.mock.calls.filter(call=>call[0].includes('INSERT INTO model_cache'));
  expect(JSON.parse(writes[0]?.[1][3])).toEqual({items:verdicts});
  expect(writes[0]?.[1][2]).toBe('source-link-confirmation-v2');
});
it('validates and reuses a durable cached result without inference',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{value:{items:verdicts}}]});
  expect(await confirmSourceLinks(input,defaultSettings,context,{generate})).toEqual(verdicts);
  expect(generate).not.toHaveBeenCalled();
  expect(mocks.privacy).toHaveBeenCalledTimes(2);
});
it('fingerprints the full input and model configuration',async()=>{
  await confirmSourceLinks(input,defaultSettings,context,{generate});
  await confirmSourceLinks({...input,message:input.message+' Дополнение.'},defaultSettings,context,{generate});
  await confirmSourceLinks(input,{...defaultSettings,piModel:'another-model'},context,{generate});
  const keys=mocks.query.mock.calls.filter(call=>call[0].startsWith('SELECT value')).map(call=>call[1][0]);
  expect(new Set(keys).size).toBe(3);
});
it.each(['throttled','authentication'] as const)('propagates %s without hidden retry or persistence',async kind=>{
  const error=new ModelRequestError(failureMetadata(new RequestFault(kind),context.id,'pi',4,0));
  generate.mockRejectedValue(error);
  await expect(confirmSourceLinks(input,defaultSettings,context,{generate})).rejects.toBe(error);
  expect(generate).toHaveBeenCalledOnce();
  expect(mocks.query.mock.calls.some(call=>call[0].includes('INSERT'))).toBe(false);
});
it('withholds only a definitively invalid confirmation chunk and continues independent chunks', async () => {
  const many: SourceConfirmationInput = { ...input,candidates: Array.from({ length: 25 },(_,index)=>({
    ...input.candidates[0]!,candidate_id: 'p'+index,story: 'Product '+ 'x'.repeat(6000),
  })) };
  generate.mockImplementation(async (request: PiRequest) => {
    const supplied = sourceInputFromRequest(request);
    if (supplied.candidates[0]?.candidate_id==='p0') return modelResult({});
    return modelResult(sourceWireVerdicts(request,supplied.candidates.map(candidate=>({ candidate_id: candidate.candidate_id,
      verdict: 'relevant',reason: 'Supplied context',source_quote: 'Yandex Cloud',story_quote: 'Product' }))));
  });
  const failures: string[] = [];
  const before = vi.fn();
  const result = await confirmSourceLinks(many,defaultSettings,context,{ generate },async chunk=>{
    failures.push(...chunk.candidates.map(candidate=>candidate.candidate_id)); return true;
  },before);
  expect(failures).toHaveLength(10); expect(result).toHaveLength(15);
  expect(result.every(verdict=>!failures.includes(verdict.candidate_id))).toBe(true);
  expect(before).toHaveBeenCalledTimes(3);
  expect(new Set(before.mock.calls.map(([,context])=>context.id)).size).toBe(3);
  expect(generate).toHaveBeenCalledTimes(4);
});
it('passes complete large input to Pi without dropping candidate IDs',async()=>{
  const large={...input,message:input.message+'\n'+'x'.repeat(120001)};
  await confirmSourceLinks(large,defaultSettings,context,{generate});
  expect(sourceInputFromRequest(generate.mock.calls[0]?.[0])).toEqual(large);
  expect(generate).toHaveBeenCalledOnce();
});
