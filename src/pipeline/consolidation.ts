import { z } from 'zod';
import { db } from '../db.js';
import { getActiveEmbeddingConfig, type AppSettings } from '../settings.js';
import { Judgments } from './judgments.js';
import { Vectors } from './vectors.js';
import { eventDecisionInput, eventInput } from './consolidation-input.js';
import { mergeStories } from './consolidation-store.js';
import { completeConsolidationIntake, mergeHasIntake, pendingConsolidationIntake } from './consolidation-intake.js';
import { approveRemoteInput } from './privacy.js';
import type { StageContext } from './state.js';
import { checkProcessingSlice, ProcessingYield } from './processing-slice.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';
import { validateStageOutput } from './stage-output-error.js';
import { hash } from './state.js';
import { consolidationDecision, saveConsolidationDecision } from './consolidation-decisions.js';
import { consolidationPairKey, consolidationDeferral, deferConsolidationPair, resolveConsolidationPair } from './consolidation-deferrals.js';

interface Dependencies {
  judgments?: Pick<Judgments, 'judge'>;
  vectors?: Vectors;
  /** Pass the enclosing durable stage or operational-work attempt, never a fresh retry counter. */
  context?: Pick<StageContext, 'id' | 'batchId' | 'attempt'>;
}
export function consolidationContext(storyId: string, context?: Dependencies['context']): StageContext {
  return { id: context?.id ?? storyId, storyId, revisionId: null, batchId: context?.batchId ?? null,
    attempt: z.number().int().positive().parse(context?.attempt ?? 1) };
}

/** Exact current-mention distances, not an ANN shortlist or a stale representative vector. */
export async function consolidationCandidates(id: string, configId: string, settings: AppSettings): Promise<string[]> {
  const result = await db.query<{ id: string }>(`WITH current_mentions AS MATERIALIZED (
    SELECT m.id,m.story_id,m.text,e.embedding FROM story_mentions m
    JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
    JOIN stories s ON s.id=m.story_id
    LEFT JOIN embeddings e ON e.mention_id=m.id AND e.config_id=$2
    WHERE i.retention_at>=now()-$3*interval '1 day' AND s.status<>'rejected'
      AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
  ) SELECT other.story_id AS id FROM current_mentions own CROSS JOIN current_mentions other
    WHERE own.story_id=$1 AND other.story_id<>$1
    GROUP BY other.story_id
    ORDER BY min(own.embedding <=> other.embedding) ASC NULLS LAST,
      max(cardinality(ARRAY(SELECT unnest(tsvector_to_array(to_tsvector('simple',other.text)))
        INTERSECT SELECT unnest(tsvector_to_array(to_tsvector('simple',own.text)))))) DESC,other.story_id
    LIMIT $4`, [id, configId, settings.retentionDays, settings.matchCandidateLimit]);
  return result.rows.map(row => row.id);
}

/** Caller owns news-bot-pipeline. Only unconsumed collected payloads can seed automatic comparisons. */
export async function consolidateStories(settings: AppSettings, dependencies?: Dependencies): Promise<{ examined: number; merged: number; deferred: number }> {
  const result = { examined: 0, merged: 0, deferred: 0 };
  const intake = await pendingConsolidationIntake({ retentionDays: settings.retentionDays,
    ...(dependencies?.context?.batchId ? { batchId: dependencies.context.batchId } : {}) });
  const revisionIds = intake.filter(row => row.novel).map(row => row.revision_id);
  const stories = await db.query<{ id: string }>(`SELECT DISTINCT s.id FROM stories s JOIN story_mentions m ON m.story_id=s.id
    JOIN source_items i ON i.current_revision_id=m.revision_id WHERE m.revision_id=ANY($1::uuid[]) AND s.status<>'rejected'
    AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id) ORDER BY s.id`, [revisionIds]);
  const seeds = stories.rows.map(story => story.id);
  if (!seeds.length) {
    await completeConsolidationIntake(intake);
    return result;
  }
  const judgments = dependencies?.judgments ?? new Judgments(settings);
  const vectors = dependencies?.vectors ?? new Vectors(await getActiveEmbeddingConfig(), settings);
  try {
    const mentions = await db.query<{ id: string; story_id: string; text: string }>(`SELECT m.id,m.story_id,m.text FROM story_mentions m
      JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
      JOIN stories s ON s.id=m.story_id WHERE s.status<>'rejected' AND i.retention_at>=now()-$1*interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      AND m.revision_id=ANY($3::uuid[]) AND m.story_id=ANY($4::uuid[])
      AND NOT EXISTS(SELECT 1 FROM embeddings e WHERE e.mention_id=m.id AND e.config_id=$2)
      ORDER BY m.id`, [settings.retentionDays, vectors.config.id, revisionIds, seeds]);
    for (const mention of mentions.rows) {
      checkProcessingSlice();
      if (await mergeHasIntake([mention.story_id], intake, db.query.bind(db))) {
        try { await vectors.save({ mentionId: mention.id }, mention.text, consolidationContext(mention.story_id, dependencies?.context)); }
        catch (error) {
          if (error instanceof ProcessingYield) throw error;
          await recordProcessingDiagnostic(error, { scope: 'story', storyId: mention.story_id });
        }
      }
    }
    const pending = [...seeds];
    const seen = new Set<string>();
    while (pending.length) {
      checkProcessingSlice();
      const id = pending.shift();
      if (!id) break;
      const left = await eventInput(id);
      if (!left || !await mergeHasIntake([id], intake, db.query.bind(db))) continue;
      for (const candidateId of await consolidationCandidates(id, vectors.config.id, settings)) {
        checkProcessingSlice();
        const right = await eventInput(candidateId);
        if (!right || !await mergeHasIntake([id, candidateId], intake, db.query.bind(db))) continue;
        const pair = [left.fingerprint, right.fingerprint].sort().join(':');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const deferredKey = consolidationPairKey(left,right);
        const deferred = await consolidationDeferral(deferredKey);
        const parent = consolidationContext(id, dependencies?.context);
        const context = { ...parent, attempt: (deferred?.attempts ?? 0)+1, id: `${parent.id}:pair:${hash(eventDecisionInput(left,right))}` };
        if (deferred && (deferred.attempts>=settings.requestMaxAttempts
          || (deferred.next && Date.parse(deferred.next)>Date.now()))) { result.deferred++; continue; }
        let relation = await consolidationDecision(left,right);
        try {
          await approveRemoteInput(settings.jevUrl, context.id, { storyId: id });
          await approveRemoteInput(settings.jevUrl, context.id, { storyId: candidateId });
          if (!relation) {
            checkProcessingSlice();
            relation = validateStageOutput(z.object({ type: z.literal('choice'), choice: z.enum(['same','update','different']) }),
              await judgments.judge('duplicate',eventDecisionInput(left,right),context)).choice;
            await saveConsolidationDecision(left,right,relation,settings);
          }
        }
        catch (error) {
          if (error instanceof ProcessingYield) throw error;
          await deferConsolidationPair(deferredKey,left,right,settings,intake,context,error);
          result.deferred++; continue;
        }
        result.examined++;
        if (relation !== 'same' && relation !== 'update') {
          if (deferred) await resolveConsolidationPair(deferredKey);
          continue;
        }
        const merged = await mergeStories(left, right, left.text === right.text ? 'same' : 'update', intake);
        if (merged) {
          if (deferred) await resolveConsolidationPair(deferredKey);
          result.merged++;
          if (!pending.includes(merged.canonicalId)) pending.push(merged.canonicalId);
          break; // Reload the whole aggregate before considering another sibling.
        }
      }
    }
    await completeConsolidationIntake(intake);
    return result;
  } finally {
    if (!dependencies?.judgments && judgments instanceof Judgments) await judgments.close();
    if (!dependencies?.vectors) await vectors.close();
  }
}
