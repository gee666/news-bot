import { z } from 'zod';
import { db } from '../db.js';
import { JevClient } from '../models/jev.js';
import { jevTemplates } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import type { EventInput } from './consolidation-input.js';
import { groupingState } from './grouping-input.js';
import { approveRemoteInput } from './privacy.js';
import { checkProcessingSlice } from './processing-slice.js';
import { hash, recordFailure, type StageContext } from './state.js';
import type { StoryRelationDecision } from './story-relations.js';

export const GROUPING_VERSION = 'grouping-jev-v1';
const CACHE_VERSION = `${GROUPING_VERSION}:${jevTemplates.duplicate.version}:lossless-context-v1`;
const relationSchema = z.enum(['same', 'related', 'unrelated']);
type Classifier = Pick<JevClient, 'judge'>;

/** One JEV classification per uncached pair. No generation, repair or fallback call. */
export async function groupReport(incoming: EventInput, candidates: readonly EventInput[], settings: AppSettings,
  context: StageContext, classifier?: Classifier): Promise<StoryRelationDecision[]> {
  if (!candidates.length) return [];
  const modelKey = `${settings.jevUrl}/${settings.jevModel}/${settings.modelVersion}`;
  const incomingHash = hash({ id: incoming.id, reports: incoming.reports });
  const pairs = candidates.map(candidate => ({ candidate, inputHash: hash({ incoming: incomingHash,
    candidate: hash({ id: candidate.id, reports: candidate.reports }) }) }));
  const cached = await db.query<{ input_hash: string; value: unknown }>(`SELECT input_hash,value FROM model_cache
    WHERE kind='judgment' AND input_hash=ANY($1::text[]) AND model_key=$2 AND prompt_version=$3 AND expires_at>now()`,
  [pairs.map(pair => pair.inputHash), modelKey, CACHE_VERSION]);
  const byHash = new Map(cached.rows.map(row => [row.input_hash, row.value]));
  const decisions: StoryRelationDecision[] = [];
  let ownedClient: JevClient | undefined;
  let firstSame = false;
  try {
    for (const { candidate, inputHash } of pairs) {
      const saved = relationSchema.safeParse(byHash.get(inputHash));
      let relation: z.infer<typeof relationSchema>;
      if (saved.success) relation = saved.data;
      else {
        checkProcessingSlice();
        await approveRemoteInput(settings.jevUrl, context.id, context);
        await approveRemoteInput(settings.jevUrl, context.id, { storyId: candidate.id });
        if (!classifier && !ownedClient) ownedClient = new JevClient({ baseUrl: settings.jevUrl,
          model: settings.jevModel, apiKey: process.env.JEV_API_KEY ?? '', timeoutMs: settings.jevTimeoutMs,
          connectTimeoutMs: settings.connectionTimeoutMs, prefixCache: settings.prefixCacheEnabled,
          requestMaxAttempts: settings.requestMaxAttempts, recordFailure });
        const client = classifier ?? ownedClient;
        if (!client) throw new Error('Grouping classifier unavailable');
        const result = await client.judge('duplicate', groupingState(incoming, candidate),
          { operationId: context.id, attempt: context.attempt, stage: 'grouping' });
        const answer = result.answers.relation;
        relation = relationSchema.parse(answer?.type === 'choice' ? answer.choice : undefined);
        // Persist each completed pair before the next call/checkpoint. Never reuse Pi verdicts.
        await db.query(`INSERT INTO model_cache(kind,input_hash,model_key,prompt_version,value,expires_at)
          VALUES('judgment',$1,$2,$3,$4,now()+$5*interval '1 day')
          ON CONFLICT(kind,input_hash,model_key,prompt_version) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
        [inputHash, modelKey, CACHE_VERSION, JSON.stringify(relation), settings.retentionDays]);
      }
      if (relation === 'same') {
        if (firstSame) continue;
        firstSame = true;
      }
      decisions.push({ storyId: candidate.id, relation,
        ...(relation === 'related' ? { relatedPromptVersion: jevTemplates.duplicate.version } : {}) });
    }
    return decisions;
  } finally { await ownedClient?.close(); }
}
