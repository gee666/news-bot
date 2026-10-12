import { z } from 'zod';
import { db, transaction } from '../db.js';
import { jevTemplates } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import { choice, type Judgments } from './judgments.js';
import { hash, type StageContext } from './state.js';
import { blockedStoriesCte } from './item-failures.js';

const version = jevTemplates.news_eligibility.version;
// Query parameters $1/$2 are the current profile/model versions; caller aliases stories as s.
export const currentDecision = `SELECT 1 FROM judgments j WHERE j.story_id=s.id AND j.stage='eligibility'
  AND j.prompt_version='${version}' AND j.profile_version=$1 AND j.model_version=$2
  AND j.result->>'contentVersion'=s.content_version::text AND j.expires_at>now()`;

export async function assessEligibility(id: string, settings: AppSettings, judgments: Pick<Judgments, 'judge'>, context: StageContext): Promise<boolean> {
  const result = await db.query('SELECT chosen_excerpt,content_version FROM stories WHERE id=$1', [id]);
  const story = z.object({ chosen_excerpt: z.string().min(1), content_version: z.number().int() }).parse(result.rows[0]);
  const state = { story: story.chosen_excerpt, interestProfile: settings.interestProfile, scope: 'story' };
  const eligible = choice(await judgments.judge('news_eligibility', state, context)) === 'eligible';
  await transaction(async client => {
    const current = await client.query(`SELECT id FROM stories WHERE id=$1 AND content_version=$2 AND chosen_excerpt=$3 FOR UPDATE`,
      [id, story.content_version, story.chosen_excerpt]);
    if (!current.rows.length) throw new Error('Story changed during eligibility judgment');
    await client.query(`INSERT INTO judgments(story_id,batch_id,stage,input_hash,model_key,prompt_version,
      profile_version,model_version,result,expires_at) VALUES($1,$2,'eligibility',$3,$4,$5,$6,$7,$8,now()+$9*interval '1 day')`,
    [id, context.batchId, hash(state), `${settings.jevUrl}/${settings.jevModel}`, version, settings.profileVersion, settings.modelVersion,
      JSON.stringify({ eligible, contentVersion: story.content_version }), settings.retentionDays]);
    if (!eligible) {
      await client.query(`UPDATE stories SET status='rejected',interest_score=NULL,interest_stale=false,profile_version=$2,
        model_version=$3,headline=NULL,summary=NULL,translated_excerpt=NULL,researched=false,updated_at=now() WHERE id=$1`,
      [id, settings.profileVersion, settings.modelVersion]);
      await client.query('UPDATE story_evidence SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL', [id]);
      await client.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${id}`]);
    } else {
      // Current completed stories keep their existing score and generated display unchanged.
      await client.query(`UPDATE stories SET status='processing',interest_stale=true WHERE id=$1 AND status='rejected'`, [id]);
      await client.query(`INSERT INTO operational_state(key,value) SELECT $1,$2::jsonb WHERE EXISTS(
        SELECT 1 FROM stories WHERE id=$3 AND status='processing') AND $4::uuid IS NULL ON CONFLICT(key) DO NOTHING`,
      [`digest_refresh:${id}`, JSON.stringify({ storyId: id }), id, context.batchId]);
    }
  });
  return eligible;
}

/** Also called after lease contention/failure, so historical unassessed ads cannot bypass refresh. */
export async function guardDigestEligibility(settings: AppSettings, storyIds?: string[]): Promise<void> {
  await db.query(`WITH RECURSIVE ${blockedStoriesCte} UPDATE stories s SET interest_stale=true WHERE status='completed'
    AND ($3::uuid[] IS NULL OR s.id=ANY($3)) AND
    (s.id::text IN(SELECT id FROM blocked_stories) OR NOT EXISTS(${currentDecision} AND j.result->>'eligible'='true'))`, [settings.profileVersion, settings.modelVersion, storyIds ?? null]);
}
