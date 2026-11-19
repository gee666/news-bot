import { z } from 'zod';
import { db } from '../db.js';
import { JevClient } from '../models/jev.js';
import { jevTemplates } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import type { EventInput } from './consolidation-input.js';
import { groupingState } from './grouping-input.js';
import { isGroupEventInput, matchingInputStoryIds } from './matching-group-input.js';
import { approveRemoteInput } from './privacy.js';
import { checkProcessingSlice } from './processing-slice.js';
import { hash, recordFailure, type StageContext } from './state.js';
import type { StoryRelationDecision } from './story-relations.js';

export const GROUPING_VERSION = 'grouping-jev-v2';
const CACHE_VERSION = `${GROUPING_VERSION}:${jevTemplates.duplicate.version}:group-diagnostics-v1`;
const relationSchema = z.enum(['same', 'related', 'unrelated']);
const probability = z.number().finite().min(0).max(1);
const cachedDecisionSchema = z.object({
  relation: relationSchema, probabilities: z.record(z.string(), probability), confidence: probability,
  model: z.string().min(1), promptVersion: z.string().min(1), inputHash: z.string().min(1),
});
interface GroupingOptions {
  classifier?: Pick<JevClient, 'judge'>;
  stopOnSame?: boolean;
}

/** One JEV classification per uncached pair. No generation, repair or fallback call. */
export async function groupReport(incoming: EventInput, candidates: readonly EventInput[], settings: AppSettings,
  context: StageContext, { classifier, stopOnSame }: GroupingOptions = {}): Promise<StoryRelationDecision[]> {
  if (!candidates.length) return [];
  const modelKey = `${settings.jevUrl}/${settings.jevModel}/${settings.modelVersion}`;
  const cacheVersion = `${CACHE_VERSION}:prefix-${Number(settings.prefixCacheEnabled)}`;
  const incomingHash = hash({ id: incoming.id, reports: incoming.reports });
  const pairs = candidates.map(candidate => ({ candidate, inputHash: hash({ incoming: incomingHash,
    candidate: hash({ id: candidate.id, reports: candidate.reports }) }) }));
  const cached = await db.query<{ input_hash: string; value: unknown }>(`SELECT input_hash,value FROM model_cache
    WHERE kind='judgment' AND input_hash=ANY($1::text[]) AND model_key=$2 AND prompt_version=$3 AND expires_at>now()`,
  [pairs.map(pair => pair.inputHash), modelKey, cacheVersion]);
  const byHash = new Map(cached.rows.map(row => [row.input_hash, row.value]));
  const decisions: StoryRelationDecision[] = [];
  let ownedClient: JevClient | undefined;
  try {
    for (const { candidate, inputHash } of pairs) {
      const saved = cachedDecisionSchema.safeParse(byHash.get(inputHash));
      let relation: z.infer<typeof relationSchema>;
      if (saved.success && saved.data.inputHash === inputHash) relation = saved.data.relation;
      else {
        checkProcessingSlice();
        await approveRemoteInput(settings.jevUrl, context.id, context);
        if (isGroupEventInput(incoming)) {
          for (const storyId of incoming.storyIds) await approveRemoteInput(settings.jevUrl, context.id, { storyId });
        }
        for (const storyId of matchingInputStoryIds(candidate)) {
          await approveRemoteInput(settings.jevUrl, context.id, { storyId });
        }
        if (!classifier && !ownedClient) ownedClient = new JevClient({ baseUrl: settings.jevUrl,
          model: settings.jevModel, apiKey: process.env.JEV_API_KEY ?? '', timeoutMs: settings.jevTimeoutMs,
          connectTimeoutMs: settings.connectionTimeoutMs, prefixCache: settings.prefixCacheEnabled,
          requestMaxAttempts: settings.requestMaxAttempts, recordFailure });
        const client = classifier ?? ownedClient;
        if (!client) throw new Error('Grouping classifier unavailable');
        const result = await client.judge('duplicate', groupingState(incoming, candidate),
          { operationId: context.id, attempt: context.attempt, stage: 'grouping' });
        const answer = result.answers.relation;
        if (answer?.type !== 'choice') throw new Error('Grouping classifier returned no choice');
        relation = relationSchema.parse(answer.choice);
        const diagnostic = cachedDecisionSchema.parse({ relation, probabilities: answer.probabilities,
          confidence: answer.confidence, model: result.model, promptVersion: result.promptVersion, inputHash });
        // Keep the distribution with the verdict so weak or incorrect decisions can be audited.
        // Persist each completed pair before the next call/checkpoint. Never reuse Pi verdicts.
        await db.query(`INSERT INTO model_cache(kind,input_hash,model_key,prompt_version,value,expires_at)
          VALUES('judgment',$1,$2,$3,$4,now()+$5*interval '1 day')
          ON CONFLICT(kind,input_hash,model_key,prompt_version) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
        [inputHash, modelKey, cacheVersion, JSON.stringify(diagnostic), settings.retentionDays]);
      }
      decisions.push({ storyId: candidate.id, relation,
        ...(relation === 'related' ? { relatedPromptVersion: jevTemplates.duplicate.version } : {}) });
      if (stopOnSame && relation === 'same') break;
    }
    return decisions;
  } finally { await ownedClient?.close(); }
}
