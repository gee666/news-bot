import { z } from 'zod';
import { db, transaction } from '../db.js';
import { interestScore } from '../models/jev.js';
import { enqueueReadyStory, ownManualStories } from '../publishing/ready.js';
import { getActiveEmbeddingConfig, type AppSettings } from '../settings.js';
import { researchStory } from './generation.js';
import { generationIsCurrent } from './generation-freshness.js';
import { choice, type Judgments } from './judgments.js';
import { hash, StoryCompletionError, type StageContext } from './state.js';
import { storyPostconditions } from './story-postconditions.js';
import { Vectors } from './vectors.js';
import { assessEligibility, currentDecision } from './eligibility.js';
import { jevTemplates } from '../models/templates.js';
import { blockedStoriesCte } from './item-failures.js';
import { eventInput } from './consolidation-input.js';
import { StoryIntegrityError } from './event-integrity-error.js';
import { checkProcessingSlice } from './processing-slice.js';
import { countStoryOutcome, prepareStoryFailureUpdates, storyWork, type StoryWorkReport } from './story-failures.js';

interface StoryWork { id: string; content_version: number }
interface Candidate extends StoryWork { status: string; interest_stale: boolean; profile_version: number | null; model_version: number | null }
async function needsRefresh(story: Candidate, settings: AppSettings): Promise<boolean> {
  if (story.status !== 'completed' || story.interest_stale || story.profile_version !== settings.profileVersion
    || story.model_version !== settings.modelVersion) return true;
  const aggregate = await eventInput(story.id);
  if (aggregate && aggregate.reports.length > 1) {
    const checked = await db.query(`SELECT 1 FROM judgments WHERE story_id=$1 AND stage='event_group_integrity'
      AND input_hash=$2 AND prompt_version=$3 AND model_version=$4 AND result->>'choice'='coherent' AND expires_at>now()`,
    [story.id, hash({ reports: aggregate.reports }), jevTemplates.event_group_integrity.version, settings.modelVersion]);
    if (!checked.rows.length) return true;
  }
  const checks = await storyPostconditions(story.id, settings);
  return !checks.eligibilityCurrent || !checks.rankingCurrent || !await generationIsCurrent(story.id, settings);
}
export async function selectRepresentative(id: string, judgments: Pick<Judgments, 'judge'>, context: StageContext): Promise<string> {
  const aggregate = await eventInput(id);
  if (!aggregate) throw new Error('Story has no mentions');
  if (aggregate.reports.length > 1) {
    const verdict = z.enum(['coherent', 'mixed']).parse(choice(await judgments.judge('event_group_integrity', {
      reports: aggregate.reports,
    }, context)));
    if (verdict === 'mixed') throw new StoryIntegrityError(id, aggregate.fingerprint);
  }
  let best = aggregate.reports[0]?.text;
  if (!best) throw new Error('Story has no mentions');
  for (const mention of aggregate.reports.slice(1)) {
    if (mention.text === best) continue;
    if (choice(await judgments.judge('representative', {
      story: aggregate.text, left: best, right: mention.text, reports: aggregate.reports,
    }, context)) === 'right') best = mention.text;
  }
  await transaction(async client => {
    await client.query(`SELECT i.id FROM source_items i WHERE EXISTS(SELECT 1 FROM item_revisions r
      JOIN story_mentions m ON m.revision_id=r.id WHERE r.item_id=i.id AND m.story_id=$1) ORDER BY i.id FOR SHARE`, [id]);
    if ((await eventInput(id, client))?.fingerprint !== aggregate.fingerprint) throw new Error('Event input changed during selection');
    const changed = await client.query(`UPDATE stories SET chosen_excerpt=$2,content_version=content_version+1,
      status='processing',interest_stale=true,headline=NULL,summary=NULL,translated_excerpt=NULL,researched=false,updated_at=now()
      WHERE id=$1 AND chosen_excerpt IS DISTINCT FROM $2 RETURNING id`, [id, best]);
    if (changed.rows.length) {
      await client.query('DELETE FROM embeddings WHERE story_id=$1', [id]);
      await client.query('UPDATE story_evidence SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL', [id]);
    }
  });
  return best;
}
export async function rankStory(id: string, settings: AppSettings, judgments: Judgments, context: StageContext): Promise<number> {
  const rows = await db.query<{ chosen_excerpt: string; content_version: number }>('SELECT chosen_excerpt,content_version FROM stories WHERE id=$1', [id]);
  const story = rows.rows[0];
  if (!story?.chosen_excerpt) throw new Error('Missing representative');
  const score = interestScore(await judgments.judge('interest', { story: story.chosen_excerpt, interestProfile: settings.interestProfile }, context));
  await db.query(`UPDATE stories SET interest_score=$2,interest_stale=false,profile_version=$3,model_version=$4,updated_at=now()
    WHERE id=$1 AND content_version=$5`, [id, score, settings.profileVersion, settings.modelVersion, story.content_version]);
  return score;
}
async function refreshEmbedding(id: string, vectors: Vectors, context: StageContext): Promise<boolean> {
  const row = await db.query<{ chosen_excerpt: string }>('SELECT chosen_excerpt FROM stories WHERE id=$1', [id]);
  const excerpt = row.rows[0]?.chosen_excerpt;
  if (!excerpt) throw new Error('Missing representative');
  await vectors.save({ storyId: id }, excerpt, context);
  return true;
}
export async function finishBatchStories(batchId: string, settings: AppSettings, judgments: Judgments, vectors: Vectors,
  onReady?: (id: string) => Promise<void>, storyIds?: readonly string[]): Promise<StoryWorkReport> {
  const result = await db.query<Candidate>(`WITH RECURSIVE ${blockedStoriesCte} SELECT s.id,s.content_version,s.status,s.interest_stale,s.profile_version,s.model_version FROM stories s
    WHERE s.id::text NOT IN(SELECT id FROM blocked_stories) AND s.status IN ('pending','processing','failed','completed') AND EXISTS(SELECT 1 FROM story_mentions current
      JOIN item_revisions cr ON cr.id=current.revision_id JOIN source_items ci ON ci.current_revision_id=cr.id WHERE current.story_id=s.id)
    AND (EXISTS(SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
      JOIN item_revisions br ON br.item_id=r.item_id JOIN batch_items b ON b.revision_id=br.id
      WHERE b.batch_id=$1 AND m.story_id=s.id) OR EXISTS(SELECT 1 FROM stage_state st
      WHERE st.batch_id=$1 AND st.story_id=s.id AND st.stage='extraction_affected') OR (
        EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||$1::text)
        AND EXISTS(SELECT 1 FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
          JOIN batch_items b ON b.revision_id=l.revision_id WHERE b.batch_id=$1 AND sl.story_id=s.id AND sl.classification='relevant')
      )) ORDER BY s.id`, [batchId]);
  const scope = await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [`run_now_batch:${batchId}`]);
  const manual = z.object({ runId: z.uuid().optional(), storyLimit: z.number().int().positive(), storyIds: z.array(z.uuid()).optional() }).safeParse(scope.rows[0]?.value);
  const selectedIds = storyIds === undefined ? null : z.array(z.uuid()).parse(storyIds);
  let candidates = selectedIds ? result.rows.filter(story => selectedIds.includes(story.id)) : result.rows;
  if (manual.success) {
    const runId = manual.data.runId;
    if (runId) await transaction(client => ownManualStories(client, candidates.map(story => story.id), runId, settings));
    const ids = manual.data.storyIds ?? candidates.slice(0, manual.data.storyLimit).map(story => story.id);
    if (!manual.data.storyIds) await transaction(async client => {
      await client.query(`UPDATE operational_state SET value=value||$2::jsonb,updated_at=now() WHERE key=$1`,
        [`run_now_batch:${batchId}`, JSON.stringify({ storyIds: ids, omittedStories: Math.max(0, candidates.length - ids.length) })]);
      // Keep genuinely affected but unselected work for the normal digest schedule.
      await client.query(`INSERT INTO operational_state(key,value)
        SELECT 'digest_refresh:'||id::text,jsonb_build_object('storyId',id) FROM stories WHERE id=ANY($1::uuid[])
        ON CONFLICT(key) DO NOTHING`, [candidates.filter(story => !ids.includes(story.id)).map(story => story.id)]);
    });
    candidates = candidates.filter(story => ids.includes(story.id));
  }
  const report: StoryWorkReport = { completedStories: 0, failedStories: 0, skippedStories: 0 };
  const skipStages = async (id: string): Promise<void> => {
    await db.query(`UPDATE stage_state SET status='skipped',next_retry_at=NULL,updated_at=now()
      WHERE batch_id=$1 AND story_id=$2 AND status IN ('pending','waiting','running')`, [batchId,id]);
  };
  try {
    for (const story of candidates) {
      // A newer completed display supersedes this batch's shared-story work, not its input snapshot.
      if (story.status==='completed' && !story.interest_stale
        && (story.profile_version ?? 0)>=settings.profileVersion && (story.model_version ?? 0)>=settings.modelVersion
        && ((story.profile_version ?? 0)>settings.profileVersion || (story.model_version ?? 0)>settings.modelVersion)) {
        await skipStages(story.id); report.skippedStories++; continue;
      }
      const outcome = await storyWork(story.id, settings, batchId, async () => {
        if (await needsRefresh(story, settings)) return finishStory(story, settings, judgments, vectors, batchId);
        await skipStages(story.id);
        await transaction(client => enqueueReadyStory(client, story.id, settings, batchId));
        return true;
      });
      countStoryOutcome(report, outcome);
      if (outcome === 'completed' && onReady) await onReady(story.id);
    }
  } finally { await prepareStoryFailureUpdates(settings, manual.success ? candidates.map(story => story.id) : undefined, manual.success); }
  return report;
}

async function finishStory(story: StoryWork, settings: AppSettings, judgments: Judgments, vectors: Vectors,
  batchId: string | null): Promise<boolean> {
  const id = story.id;
  await db.query("UPDATE stories SET status='processing' WHERE id=$1", [id]);
  const context: StageContext = { id, attempt: 1, batchId, storyId: id, revisionId: null };
  await selectRepresentative(id, judgments, context);
  if (!await assessEligibility(id, settings, judgments, context)) return false;
  await rankStory(id, settings, judgments, context);
  await refreshEmbedding(id, vectors, context);
  await researchStory(id, settings);
  const checks = { ...await storyPostconditions(id, settings), generationCurrent: await generationIsCurrent(id, settings) };
  if (Object.values(checks).some(value => !value)) throw new StoryCompletionError(id, checks);
  await completeStories([id], settings, batchId);
  const completed = await db.query("SELECT 1 FROM stories WHERE id=$1 AND status='completed'", [id]);
  if (!completed.rows.length) throw new StoryCompletionError(id,
    { ...await storyPostconditions(id, settings), generationCurrent: await generationIsCurrent(id, settings) });
  await db.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${id}`]);
  return true;
}
async function completeStories(ids: string[], settings: AppSettings, batchId: string | null): Promise<void> {
  await transaction(async client => {
    const completed = await client.query<{ id: string }>(`WITH RECURSIVE ${blockedStoriesCte} UPDATE stories SET status='completed',updated_at=now() WHERE id=ANY($1::uuid[])
    AND id::text NOT IN(SELECT id FROM blocked_stories)
    AND headline IS NOT NULL AND chosen_excerpt IS NOT NULL AND interest_score IS NOT NULL
    AND profile_version=$2 AND model_version=$3 AND NOT interest_stale
    AND EXISTS(SELECT 1 FROM judgments j WHERE j.story_id=stories.id AND j.stage='eligibility'
      AND j.prompt_version=$4 AND j.profile_version=$2 AND j.model_version=$3 AND j.expires_at>now()
      AND j.result->>'contentVersion'=stories.content_version::text AND j.result->>'eligible'='true') RETURNING id`,
    [ids, settings.profileVersion, settings.modelVersion, jevTemplates.news_eligibility.version]);
    for (const row of completed.rows) await enqueueReadyStory(client, row.id, settings, batchId);
  });
}
async function pinRefresh(ids: string[]): Promise<void> {
  await transaction(async client => {
    for (const id of ids) {
      await client.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,
        [`digest_refresh:${id}`, JSON.stringify({ storyId: id })]);
      await client.query("UPDATE stories SET status='processing' WHERE id=$1", [id]);
    }
  });
}
export async function refreshDigest(settings: AppSettings, judgments: Judgments, storyIds?: readonly string[]): Promise<StoryWorkReport> {
  const selectedIds = storyIds === undefined ? null : z.array(z.uuid()).max(1000).parse(storyIds);
  await db.query(`DELETE FROM operational_state o WHERE key LIKE 'digest_refresh:%' AND NOT EXISTS(
    SELECT 1 FROM stories s WHERE s.id::text=o.value->>'storyId' AND s.status<>'rejected' AND EXISTS(
      SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
      JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=s.id))`);
  // A scoped replay can yield after merges enqueue refreshes but before its story cap is pinned.
  const result = await db.query<Candidate>(`WITH RECURSIVE ${blockedStoriesCte} SELECT s.id,s.content_version,s.status,s.interest_stale,s.profile_version,s.model_version FROM stories s
    WHERE s.id::text NOT IN(SELECT id FROM blocked_stories)
    AND ($3::uuid[] IS NULL OR s.id=ANY($3))
    AND ($3::uuid[] IS NOT NULL OR NOT EXISTS(SELECT 1 FROM processing_batches batch
      WHERE batch.completed_at IS NULL AND batch.manual_operation_id IS NOT NULL AND (
        EXISTS(SELECT 1 FROM stage_state st WHERE st.batch_id=batch.id AND st.story_id=s.id)
        OR EXISTS(SELECT 1 FROM story_mentions m JOIN batch_items b ON b.revision_id=m.revision_id WHERE b.batch_id=batch.id AND m.story_id=s.id)
        OR EXISTS(SELECT 1 FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
          JOIN batch_items b ON b.revision_id=l.revision_id WHERE b.batch_id=batch.id AND sl.story_id=s.id))))
    AND (s.status IN ('pending','processing','completed','failed')
      OR EXISTS(SELECT 1 FROM operational_state o WHERE o.key='digest_refresh:'||s.id::text)
      OR (s.status='rejected' AND NOT EXISTS(${currentDecision})))
    AND EXISTS(SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
      JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=s.id)
    ORDER BY (coalesce(s.summary,'') LIKE '%Краткий пересказ недоступен%') DESC,
      (SELECT max(i.collected_at) FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id
        WHERE m.story_id=s.id) DESC,s.id`,
    [settings.profileVersion, settings.modelVersion, selectedIds]);
  const report: StoryWorkReport = { completedStories: 0, failedStories: 0, skippedStories: 0 };
  const vectors = new Vectors(await getActiveEmbeddingConfig(), settings);
  try {
    for (const story of result.rows) {
      checkProcessingSlice();
      countStoryOutcome(report, await storyWork(story.id, settings, null, async () => {
        if (!await needsRefresh(story, settings)) return true;
        await pinRefresh([story.id]);
        return finishStory(story, settings, judgments, vectors, null);
      }));
    }
  } finally { await vectors.close(); await prepareStoryFailureUpdates(settings); }
  return report;
}
