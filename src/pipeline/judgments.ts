import { z } from 'zod';
import { db } from '../db.js';
import { JevClient, type JevAnswer } from '../models/jev.js';
import { ModelRequestError } from '../models/errors.js';
import { jevTemplates, type JevTemplate } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import { hash, recordFailure, type StageContext } from './state.js';
import { approveRemoteInput } from './privacy.js';
import { validateStageOutput } from './stage-output-error.js';
import { checkProcessingSlice } from './processing-slice.js';
import { piJudgment } from './pi-judgment.js';

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type:z.literal('choice'),choice:z.string(),probabilities:z.record(z.string(),z.number()),confidence:z.number() }),
  z.object({ type:z.literal('noul'),noul:z.number() }),
  z.object({ type:z.literal('score'),score:z.number(),probabilities:z.record(z.string(),z.number()),confidence:z.number(),legend:z.record(z.string(),z.string()) }),
]);
export class Judgments {
  private readonly client:JevClient;
  constructor(private readonly settings:AppSettings) {
    this.client=new JevClient({baseUrl:settings.jevUrl,model:settings.jevModel,apiKey:process.env.JEV_API_KEY ?? '',
      timeoutMs:settings.jevTimeoutMs,connectTimeoutMs:settings.connectionTimeoutMs,prefixCache:settings.prefixCacheEnabled,
      requestMaxAttempts:settings.requestMaxAttempts,recordFailure});
  }
  async judge(template:JevTemplate,state:unknown,context:StageContext):Promise<JevAnswer> {
    const inputHash=hash(state);
    let modelKey=`${this.settings.jevUrl}/${this.settings.jevModel}`;
    const version=jevTemplates[template].version;
    let cacheVersion=version+':lossless-context-v1';
    const piKey=`${this.settings.piProvider}/${this.settings.piModel}`;
    const piVersion=version+':pi-context-v1';
    const cached=await db.query<{value:unknown;model_key?:string}>(`SELECT value,model_key FROM model_cache WHERE kind='judgment'
      AND input_hash=$1 AND expires_at>now() AND ((model_key=$2 AND prompt_version=$3) OR (model_key=$4 AND prompt_version=$5))
      ORDER BY (model_key=$2) DESC LIMIT 1`,[inputHash,modelKey,cacheVersion,piKey,piVersion]);
    let answer:JevAnswer;
    if(cached.rows[0]) {
      answer=validateStageOutput(answerSchema,cached.rows[0].value);
      modelKey=cached.rows[0].model_key ?? modelKey;
    } else {
      checkProcessingSlice();
      await approveRemoteInput(this.settings.jevUrl,context.id,context);
      let provider='jev'; let metrics:unknown={}; let durationMs=0;
      try {
        const result=await this.client.judge(template,state,{operationId:context.id,attempt:context.attempt});
        const first=Object.values(result.answers)[0];
        if(!first) throw new Error('Missing judgment');
        answer=first; metrics=result.metrics; durationMs=result.metrics.durationMs ?? 0;
      } catch(error) {
        if(!(error instanceof ModelRequestError) || error.metadata.kind!=='context_limit') throw error;
        const started=Date.now();
        answer=await piJudgment(template,state,this.settings,context);
        modelKey=piKey; cacheVersion=piVersion; provider='pi'; durationMs=Date.now()-started;
      }
      await db.query(`INSERT INTO model_cache(kind,input_hash,model_key,prompt_version,value,expires_at)
        VALUES('judgment',$1,$2,$3,$4,now()+$5*interval '1 day')
        ON CONFLICT(kind,input_hash,model_key,prompt_version) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
      [inputHash,modelKey,cacheVersion,JSON.stringify(answer),this.settings.retentionDays]);
      await db.query(`INSERT INTO request_attempts(stage_id,provider,operation,attempt_number,status,finished_at,response_metadata,dispatched_at)
        VALUES((SELECT id FROM stage_state WHERE id::text=$1),$6,$2,$3,'succeeded',now(),$4,now()-$5*interval '1 millisecond')`,
      [context.id,template,context.attempt,JSON.stringify(metrics),durationMs,provider]);
    }
    await db.query(`INSERT INTO judgments(batch_id,revision_id,story_id,stage,input_hash,model_key,prompt_version,
      profile_version,model_version,result,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11*interval '1 day')`,
    [context.batchId,context.revisionId,context.storyId,template,inputHash,modelKey,version,
      this.settings.profileVersion,this.settings.modelVersion,JSON.stringify(answer),this.settings.retentionDays]);
    return answer;
  }
  close():Promise<void> { return this.client.close(); }
}
export function choice(answer:JevAnswer):string {
  if(answer.type!=='choice') throw new Error('Expected choice judgment');
  return answer.choice;
}
