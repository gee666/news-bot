import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { jevTemplates } from '../models/templates.js';
import { blockedStoriesCte } from './item-failures.js';
import { hash, type StoryCompletionChecks } from './state.js';

type Checks = Omit<StoryCompletionChecks, 'generationCurrent'>;

export async function storyPostconditions(id: string, settings: AppSettings): Promise<Checks> {
  const story = (await db.query<{ chosen_excerpt: string | null }>('SELECT chosen_excerpt FROM stories WHERE id=$1', [id])).rows[0];
  const input = { story: story?.chosen_excerpt ?? null, interestProfile: settings.interestProfile };
  const rows = await db.query<Checks>(`WITH RECURSIVE ${blockedStoriesCte} SELECT
    s.chosen_excerpt IS NOT NULL AS "representativePresent", s.headline IS NOT NULL AS "headlinePresent",
    s.id::text NOT IN(SELECT id FROM blocked_stories) AS unblocked,
    coalesce((SELECT j.result->>'eligible'='true' FROM judgments j WHERE j.story_id=s.id AND j.stage='eligibility'
      AND j.profile_version=$1 AND j.model_version=$2 AND j.prompt_version=$8
      AND j.result->>'contentVersion'=s.content_version::text AND j.expires_at>now()
      AND j.model_key=$4 AND j.input_hash=$5 ORDER BY j.created_at DESC,j.id DESC LIMIT 1),false) AS "eligibilityCurrent",
    coalesce((NOT s.interest_stale AND s.interest_score IS NOT NULL AND s.profile_version=$1 AND s.model_version=$2
      AND EXISTS(SELECT 1 FROM judgments j WHERE j.story_id=s.id AND j.stage='interest'
        AND j.profile_version=$1 AND j.model_version=$2 AND j.prompt_version=$7
        AND j.model_key=$4 AND j.input_hash=$6 AND j.expires_at>now())),false) AS "rankingCurrent"
    FROM stories s WHERE s.id=$3`, [settings.profileVersion, settings.modelVersion, id,
    `${settings.jevUrl}/${settings.jevModel}`, hash({ ...input, scope: 'story' }), hash(input), jevTemplates.interest.version, jevTemplates.news_eligibility.version]);
  return rows.rows[0] ?? { representativePresent: false, headlinePresent: false, unblocked: false,
    eligibilityCurrent: false, rankingCurrent: false };
}

/** Invalidate only a completed receipt. Keep attempts, output and any provider wait intact. */
export async function invalidateStoryReceipt(batchId: string, storyId: string, name: string): Promise<void> {
  await db.query(`UPDATE stage_state SET status='pending',updated_at=now()
    WHERE batch_id=$1 AND story_id=$2 AND stage=$3 AND status='completed'
      AND (next_retry_at IS NULL OR next_retry_at<=now())`, [batchId, storyId, name]);
}
