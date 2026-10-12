import { beforeEach,expect,it,vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { piJudgment } from './pi-judgment.js';
import { modelResult } from './generation.test-helpers.js';
const mocks=vi.hoisted(()=>({generate:vi.fn(),privacy:vi.fn()}));
vi.mock('./generation-model.js',()=>({generationClient:async()=>({generate:mocks.generate}),recordGenerationFailure:vi.fn()}));
vi.mock('./privacy.js',()=>({approveRemoteInput:mocks.privacy}));
const context={id:'fallback',attempt:1,batchId:null,storyId:null,revisionId:null};
beforeEach(()=>vi.clearAllMocks());
it.each([
  {task:'event_group_integrity',value:{choice:'coherent'}},
  {task:'representative',value:{choice:'right'}},
  {task:'news_eligibility',value:{choice:'eligible'}},
  {task:'interest',value:{score:8}},
] as const)('keeps complete state and criteria for $task',async ({task,value})=>{
  const state={story:'Full material. '.repeat(20000)+'END OF MATERIAL',interestProfile:'News'};
  mocks.generate.mockResolvedValue(modelResult(value));
  const answer=await piJudgment(task,state,defaultSettings,context);
  expect(answer.type).toBe(task==='interest'?'score':'choice');
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.generate.mock.calls[0]?.[0].prompt).state).toEqual(state);
  expect(mocks.privacy).toHaveBeenCalledWith('https://api.openai.com',context.id,context);
  expect(mocks.generate.mock.calls[0]?.[1].operationId).toContain(`pi-context:${task}`);
});
it('preserves JEV zero-based interest scores',async ()=>{
  mocks.generate.mockResolvedValue(modelResult({score:0}));
  const answer=await piJudgment('interest',{story:'A'},defaultSettings,context);
  expect(answer).toMatchObject({type:'score',score:0,legend:{0:'No personal interest'}});
  expect(mocks.generate.mock.calls[0]?.[0].responseSchema.schema.properties.score).toMatchObject({minimum:0,maximum:9});
});
it('rejects choices outside the original judgment criteria',async ()=>{
  mocks.generate.mockResolvedValue(modelResult({choice:'invented'}));
  await expect(piJudgment('representative',{left:'A',right:'B'},defaultSettings,context))
    .rejects.toMatchObject({metadata:{kind:'invalid_output'}});
});
