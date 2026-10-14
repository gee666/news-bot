import {beforeEach,expect,it,vi} from 'vitest';
import {classifySourceOrigins} from './source-origins.js';
import {modelResult,storyInput,evidenceDocument} from './generation.test-helpers.js';
vi.mock('./generation-model.js',()=>({recordGenerationFailure:vi.fn()}));
const generate=vi.fn();
beforeEach(()=>vi.clearAllMocks());
it('classifies the referenced original tweet without granting its relaying channel primary status',async()=>{
  const input=storyInput(6); const tweet='https://x.com/artist/status/123';
  input.mentions[0]!.source_name='Relay channel'; input.mentions[0]!.original_url='https://t.me/relay/1';
  input.links=[{url:tweet,classification:'relevant'}];
  generate.mockResolvedValue(modelResult({primary_urls:[tweet]}));
  expect(await classifySourceOrigins(input,[],{generate})).toEqual([tweet]);
  const request=generate.mock.calls[0]?.[0];
  expect(request.systemPrompt).toContain('Origin is NOT independent factual verification');
  expect(request.systemPrompt).toContain('Do not label every tweet');
});
it('retains the full read origin text and rejects invented origin URLs',async()=>{
  const input=storyInput(6); const doc={...evidenceDocument(),content:'Source facts. '.repeat(10000)};
  generate.mockResolvedValue(modelResult({primary_urls:['https://invented.org/']}));
  await expect(classifySourceOrigins(input,[doc],{generate})).rejects.toMatchObject({metadata:{kind:'invalid_output'}});
  expect(generate.mock.calls[0]?.[0].prompt).toContain(doc.content);
});
