import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';
import { jevTemplates } from '../models/templates.js';
import { publicationThreadEdges } from './generation-context.js';

export type StoryRelation = 'same' | 'related' | 'unrelated';
export interface StoryRelationDecision {
  storyId: string; relation: StoryRelation; relatedPromptVersion?: string;
  relatedEvidence?: { incomingQuote: string; candidateQuote: string; connection: string };
}

const sameEdges = `same_edges(a,b) AS (
  SELECT lower_story_id,upper_story_id FROM story_relations
    WHERE relation='same' AND provenance->>'quarantined' IS DISTINCT FROM 'true'
  UNION SELECT story_id,previous_story_id FROM publication_thread_edges
)`;

async function sameComponent(storyId: string, client: Pick<PoolClient, 'query'>, userOnly = false): Promise<string[]> {
  const result = await client.query<{ id: string }>(`WITH RECURSIVE ${publicationThreadEdges}, ${sameEdges}, component(id) AS (
    SELECT $1::uuid UNION SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END FROM component c
    JOIN ${userOnly ? `(SELECT lower_story_id AS a,upper_story_id AS b FROM story_relations WHERE relation='same'
      AND provenance->>'origin'='user' AND provenance->>'quarantined' IS DISTINCT FROM 'true')` : 'same_edges'} e
      ON e.a=c.id OR e.b=c.id
  ) SELECT id FROM component`, [storyId]);
  return result.rows.map(row => row.id);
}

/** Explicit classifications only. Omitted candidates never erase relationships.
 * User decisions win. Fingerprints must be checked by the caller under source locks.
 * Returns accepted decisions; a conflicting same decision must not merge or create a thread. */
export async function recordStoryRelations(storyId: string, decisions: readonly StoryRelationDecision[],
  classifierVersion: string, provenance: Readonly<Record<string, unknown>>,
  client?: Pick<PoolClient, 'query'>): Promise<StoryRelationDecision[]> {
  if (!client) return transaction(connection => recordStoryRelations(storyId, decisions, classifierVersion, provenance, connection));
  await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
  const accepted: StoryRelationDecision[] = [];
  for (const decision of decisions) {
    if (storyId === decision.storyId) continue;
    const previous = (await client.query<{ relation: StoryRelation; provenance: Record<string, unknown> }>(
      `SELECT relation,provenance FROM story_relations WHERE lower_story_id=least($1::uuid,$2::uuid)
        AND upper_story_id=greatest($1::uuid,$2::uuid) FOR UPDATE`, [storyId, decision.storyId])).rows[0];
    if (previous?.provenance.origin === 'user' && provenance.origin !== 'user') {
      if (previous.relation === decision.relation && previous.provenance.quarantined !== true) accepted.push(decision);
      continue;
    }
    // Duplicate coverage may omit the original report's causal context. It cannot
    // erase an existing related link without comparing the full owned aggregate.
    if (previous?.relation === 'related' && decision.relation === 'unrelated' && provenance.scope === 'mention') continue;
    const left = await sameComponent(storyId, client);
    if (decision.relation === 'same') {
      const component = [...new Set([...left, ...await sameComponent(decision.storyId, client)])];
      const conflicts = await client.query(`SELECT 1 FROM story_relations
        WHERE lower_story_id=ANY($1::uuid[]) AND upper_story_id=ANY($1::uuid[]) AND relation<>'same'
          AND NOT (lower_story_id=least($2::uuid,$3::uuid) AND upper_story_id=greatest($2::uuid,$3::uuid)) LIMIT 1`,
      [component, storyId, decision.storyId]);
      if (conflicts.rows.length) continue;
    } else if (left.includes(decision.storyId)) {
      // Automated classifications cannot contradict an authoritative same path.
      if (provenance.origin !== 'user' && (await sameComponent(storyId, client, true)).includes(decision.storyId)) continue;
      // Do not choose an arbitrary path through a contradictory component. Retain the
      // old decisions for audit, but require fresh classification before using them again.
      await client.query(`UPDATE story_relations SET provenance=provenance||jsonb_build_object(
          'quarantined',true,'quarantineReason','conflicting_non_same','quarantineVersion',$2::text)
        WHERE relation='same' AND lower_story_id=ANY($1::uuid[]) AND upper_story_id=ANY($1::uuid[])
          AND ($3::boolean OR provenance->>'origin' IS DISTINCT FROM 'user')`, [left, classifierVersion, provenance.origin === 'user']);
      await client.query(`UPDATE story_publication_threads SET classification_version=NULL
        WHERE story_id=ANY($1::uuid[]) AND previous_story_id=ANY($1::uuid[])`, [left]);
    }
    // Each row describes one pair, not a copy of the entire grouping catalogue.
    // Complete grouping inputs/results already belong to the model cache.
    const pairProvenance = { ...provenance };
    if (Array.isArray(pairProvenance.candidates)) {
      pairProvenance.candidates = pairProvenance.candidates.filter((candidate: unknown) =>
        typeof candidate === 'object' && candidate !== null && 'storyId' in candidate
        && (candidate.storyId === storyId || candidate.storyId === decision.storyId));
    }
    await client.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version,provenance)
      VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),$3,$4,$5)
      ON CONFLICT(lower_story_id,upper_story_id) DO UPDATE SET relation=EXCLUDED.relation,
        classifier_version=EXCLUDED.classifier_version,provenance=EXCLUDED.provenance,classified_at=now()`,
    [storyId, decision.storyId, decision.relation, classifierVersion, JSON.stringify({ ...pairProvenance,...(decision.relation === 'related' && decision.relatedPromptVersion
      ? { relatedPromptVersion:decision.relatedPromptVersion } : {}),
      ...(decision.relation === 'related' && decision.relatedEvidence ? { relatedEvidence:decision.relatedEvidence } : {}) })]);
    accepted.push(decision);
  }
  return accepted;
}

/** Both directions, inherited through verified same editions/merges only.
 * Reads IDs, never copies related reports, evidence, sources or media into a story. */
export async function relatedStoryIds(storyId: string, query = db.query.bind(db)): Promise<string[]> {
  const result = await query<{ id: string }>(`WITH RECURSIVE ${publicationThreadEdges}, ${sameEdges}, same_component(id) AS (
      SELECT $1::uuid UNION SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END
      FROM same_component c JOIN same_edges e ON e.a=c.id OR e.b=c.id
    ), related_roots(id) AS (
      SELECT CASE WHEN r.lower_story_id=c.id THEN r.upper_story_id ELSE r.lower_story_id END
      FROM same_component c JOIN story_relations r ON r.lower_story_id=c.id OR r.upper_story_id=c.id
      WHERE r.relation='related' AND r.provenance->>'quarantined' IS DISTINCT FROM 'true'
        AND (r.provenance->>'origin'='user' OR r.provenance->>'relatedPromptVersion'='${jevTemplates.duplicate.version}')
    ), related_component(id) AS (
      SELECT id FROM related_roots UNION SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END
      FROM related_component c JOIN same_edges e ON e.a=c.id OR e.b=c.id
    ), excluded_roots(id) AS (
      SELECT CASE WHEN r.lower_story_id=c.id THEN r.upper_story_id ELSE r.lower_story_id END
      FROM same_component c JOIN story_relations r ON r.lower_story_id=c.id OR r.upper_story_id=c.id
      WHERE r.relation='unrelated' AND r.provenance->>'quarantined' IS DISTINCT FROM 'true'
    ), excluded_component(id) AS (
      SELECT id FROM excluded_roots UNION SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END
      FROM excluded_component c JOIN same_edges e ON e.a=c.id OR e.b=c.id
    ) SELECT id FROM related_component WHERE id NOT IN(SELECT id FROM same_component)
      AND id NOT IN(SELECT id FROM excluded_component)
      ORDER BY id`, [storyId]);
  return result.rows.map(row => row.id);
}
