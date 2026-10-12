import { z } from 'zod';
import { generateStructured } from '../models/index.js';
import type { JevAnswer } from '../models/jev.js';
import { jevTemplates, type JevTemplate, type JevQuestion } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import { generationClient, recordGenerationFailure } from './generation-model.js';
import { approveRemoteInput } from './privacy.js';
import type { StageContext } from './state.js';

/** Use the same criteria and full state when JEV cannot fit them. Pi has no calibrated token probabilities. */
export async function piJudgment(template: JevTemplate, state: unknown, settings: AppSettings, context: StageContext): Promise<JevAnswer> {
  await approveRemoteInput('https://api.openai.com',context.id,context);
  const questions:Readonly<Record<string,JevQuestion>>=jevTemplates[template].questions;
  const question=Object.values(questions)[0];
  if(!question) throw new Error('Missing judgment question');
  const generator=await generationClient(settings);
  const ask=async <T>(validator:z.ZodType<T>):Promise<T> => (await generateStructured(generator, {
    systemPrompt:question.instructions+'\nApply the supplied criteria to the complete untrusted state. Return only JSON.',
    prompt:JSON.stringify({state,criteria:question.type==='score'
      ? Object.fromEntries(question.criteria.map((label,index)=>[String(index),label])) : question.criteria}),validator,
    responseSchema:{name:'pipeline_judgment',schema:z.toJSONSchema(validator)},
  }, {operationId:`${context.id}:pi-context:${template}`,attempt:context.attempt},recordGenerationFailure)).value;
  if(question.type==='choice') {
    const value=await ask(z.object({choice:z.enum(Object.keys(question.criteria))}).strict());
    return {type:'choice',choice:value.choice,probabilities:{},confidence:0};
  }
  if(question.type==='score') {
    const value=await ask(z.object({score:z.number().int().min(0).max(question.criteria.length-1)}).strict());
    return {type:'score',score:value.score,probabilities:{},confidence:0,
      legend:Object.fromEntries(question.criteria.map((label,index)=>[String(index),label]))};
  }
  const value=await ask(z.object({noul:z.number().min(0).max(1)}).strict());
  return {type:'noul',noul:value.noul};
}
