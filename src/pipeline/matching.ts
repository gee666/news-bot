import { z } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { choice, type Judgments } from './judgments.js';
import { hash, stage, type StageContext } from './state.js';
import type { Vectors } from './vectors.js';
import { approveRemoteInput } from './privacy.js';
import { eventDecisionInput, eventInput, mentionInput, type EventInput } from './consolidation-input.js';
import { jevTemplates } from '../models/templates.js';
import { ProcessingYield } from './processing-slice.js';

export interface Mention { id: string; revision_id: string; text: string; story_id: string | null }
interface Candidate { id: string; text: string; previous_revision_id: string | null; input?: EventInput }
export async function candidates(mention: Mention, vector: number[], vectors: Vectors, settings: AppSettings, batchId: string): Promise<Candidate[]> {
  const result = await db.query<Candidate>(`WITH current_mentions AS MATERIALIZED (
    SELECT m.*,i.original_url,e.embedding FROM story_mentions m
    JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
    LEFT JOIN embeddings e ON e.mention_id=m.id AND e.config_id=$4
    WHERE i.retention_at>=now()-$5*interval '1 day'
  ), recent AS (
    SELECT s.id,string_agg(DISTINCT cm.text,E'\\n\\n' ORDER BY cm.text) AS text,
      min(cm.embedding <=> $1::vector) AS distance,
      max(cardinality(ARRAY(SELECT unnest(tsvector_to_array(to_tsvector('simple',cm.text)))
        INTERSECT SELECT unnest(tsvector_to_array(to_tsvector('simple',$8)))))) AS lexical,
      EXISTS(SELECT 1 FROM story_mentions other JOIN mention_links oml ON oml.mention_id=other.id
        JOIN item_links ol ON ol.id=oml.link_id JOIN item_links il ON il.url=ol.url
        JOIN mention_links iml ON iml.link_id=il.id
        WHERE other.story_id=s.id AND other.id IN (SELECT id FROM current_mentions)
          AND iml.mention_id=$2 AND iml.classification='relevant' AND oml.classification='relevant') AS shared_link,
      EXISTS(SELECT 1 FROM story_mentions other JOIN item_revisions orev ON orev.id=other.revision_id
        JOIN source_items oi ON oi.id=orev.item_id JOIN item_revisions ir ON ir.id=$3
        JOIN source_items ii ON ii.id=ir.item_id WHERE other.story_id=s.id AND other.id IN (SELECT id FROM current_mentions)
          AND oi.original_url IS NOT NULL AND oi.original_url=ii.original_url) AS same_source
    FROM stories s JOIN current_mentions cm ON cm.story_id=s.id
    WHERE s.status<>'rejected' AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      AND s.id IS DISTINCT FROM $9::uuid GROUP BY s.id
    ), available AS (
      SELECT id,text,distance,lexical,shared_link,same_source,1 AS priority,NULL::text AS previous_revision_id
      FROM recent
      UNION ALL SELECT s.id,COALESCE(st.output->>'previousText',s.chosen_excerpt),NULL::float8,0::integer,true,true,0,st.output->>'revisionId'
      FROM stage_state st JOIN stories s ON s.id=st.story_id
      WHERE st.batch_id=$7 AND st.stage='extraction_affected' AND st.output->>'previousText' IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      UNION ALL SELECT s.id,string_agg(m.text,E'\\n\\n' ORDER BY m.id),NULL::float8,0::integer,false,true,0,r.id::text
      FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id JOIN stories s ON s.id=m.story_id
      WHERE r.id=(SELECT previous.id FROM item_revisions previous JOIN item_revisions incoming ON incoming.item_id=previous.item_id
        WHERE incoming.id=$3 AND previous.id<>incoming.id ORDER BY previous.revision_number DESC LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      GROUP BY s.id,r.id
    ) SELECT id,text,previous_revision_id FROM (SELECT DISTINCT ON(id) * FROM available ORDER BY id,priority) candidates
    ORDER BY priority,shared_link DESC,distance ASC NULLS LAST,lexical DESC,same_source DESC,id LIMIT $6`,
  [JSON.stringify(vector), mention.id, mention.revision_id, vectors.config.id, settings.retentionDays, settings.matchCandidateLimit, batchId,
    mention.text, mention.story_id]);
  // A prior extraction's text is only a fallback when that group has no current mentions.
  for (const candidate of result.rows) {
    const current = await eventInput(candidate.id);
    if (current) { candidate.text = current.text; candidate.input = current; }
  }
  return result.rows;
}

export async function matchBatch(batchId: string, settings: AppSettings, judgments: Judgments, vectors: Vectors,
  mentionIds?: readonly string[]): Promise<void> {
  const selectedIds = mentionIds === undefined ? null : z.array(z.uuid()).max(1000).parse(mentionIds);
  await db.query(`UPDATE stage_state s SET status='skipped',next_retry_at=NULL,updated_at=now()
    FROM story_mentions m WHERE s.batch_id=$1 AND s.revision_id=m.revision_id AND m.story_id IS NOT NULL
      AND (s.stage LIKE 'embed:%:'||m.id::text OR s.stage LIKE 'match:%:'||m.id::text)
      AND s.status IN ('pending','running','waiting','failed')`, [batchId]);
  const result = await db.query<Mention>(`SELECT m.id,m.revision_id,m.text,m.story_id FROM story_mentions m
    JOIN batch_items b ON b.revision_id=m.revision_id JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE b.batch_id=$1 AND b.status NOT IN ('rejected','failed')
    AND m.story_id IS NULL
    AND ($2::uuid[] IS NULL OR m.id=ANY($2)) ORDER BY i.collected_at DESC,m.created_at,m.id`, [batchId, selectedIds]);
  for (const mention of result.rows) {
    try {
      const vector = await stage(batchId, { revisionId: mention.revision_id }, `embed:${vectors.config.config_key}:${mention.id}`, settings,
        z.array(z.number()), context => vectors.save({ mentionId: mention.id }, mention.text, context));
      await stage(batchId, { revisionId: mention.revision_id }, `match:${jevTemplates.duplicate.version}:${mention.id}`, settings, z.string().uuid(), async context => {
        const saved = await db.query<{ story_id: string | null }>('SELECT story_id FROM story_mentions WHERE id=$1', [mention.id]);
        if (saved.rows[0]?.story_id) return saved.rows[0].story_id;
        const incoming = await mentionInput(mention.id);
        if (!incoming || incoming.text !== mention.text) throw new Error('Mention changed during matching');
        let matched: Candidate | undefined;
        let relation = 'different';
        for (const candidate of await candidates(mention, vector, vectors, settings, batchId)) {
          await approveRemoteInput(settings.jevUrl, context.id, { storyId: candidate.id, revisionId: candidate.previous_revision_id });
          const candidateInput = candidate.input ?? { id: candidate.id, text: candidate.text, fingerprint: '',
            reports: [{ text: candidate.text, sourceUrl: null, links: [] }] };
          relation = choice(await judgments.judge('duplicate', eventDecisionInput(incoming, candidateInput), context));
          if (relation === 'same' || relation === 'update') {
            matched = candidate;
            // Identity and freshness are separate: extra claims invalidate generated content.
            relation = candidate.text === mention.text ? 'same' : 'update';
            break;
          }
        }
        return attach(mention, incoming, vector, matched, relation, vectors, context);
      });
    } catch (error) {
      if (error instanceof ProcessingYield) throw error;
      const saved = await db.query(`SELECT 1 FROM stage_state WHERE batch_id=$1 AND revision_id=$2
        AND stage IN ($3,$4) AND status IN ('waiting','failed') LIMIT 1`,
      [batchId,mention.revision_id,`embed:${vectors.config.config_key}:${mention.id}`,`match:${jevTemplates.duplicate.version}:${mention.id}`]);
      if (!saved.rows.length) throw error;
    }
  }
}

async function attach(mention: Mention, incoming: EventInput, vector: number[], matched: Candidate | undefined, relation: string,
  vectors: Vectors, context: StageContext): Promise<string> {
  return transaction(async client => {
    // Keep collection edits from retiring either source while committing a model decision.
    await client.query(`SELECT i.id FROM source_items i WHERE i.id IN(
      SELECT r.item_id FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id
      WHERE m.id=$1 OR m.story_id=$2) ORDER BY i.id FOR SHARE`, [mention.id, matched?.id ?? null]);
    if ((await mentionInput(mention.id, client))?.fingerprint !== incoming.fingerprint
      || (matched?.input && (await eventInput(matched.id, client))?.fingerprint !== matched.input.fingerprint)) {
      throw new Error('Event input changed during matching');
    }
    let storyId = matched?.id;
    if (!storyId) {
      const created = await client.query<{ id: string }>(`INSERT INTO stories(status,chosen_excerpt,meaningful_hash)
        VALUES('processing',$1,$2) RETURNING id`, [mention.text, hash(mention.text)]);
      storyId = z.uuid().parse(created.rows[0]?.id);
    } else if (relation === 'update') {
      await client.query(`UPDATE stories SET status='processing',content_version=content_version+1,meaningful_hash=$2,
        chosen_excerpt=$3,headline=NULL,summary=NULL,translated_excerpt=NULL,researched=false,interest_stale=true,updated_at=now() WHERE id=$1`,
      [storyId, hash([matched?.text, mention.text]), mention.text]);
      // Preserve evidence associations; research freshness checks reassess them for the new input.
    }
    await client.query('UPDATE story_mentions SET story_id=$2,metadata=metadata || $3::jsonb WHERE id=$1',
      [mention.id, storyId, JSON.stringify({ relation, batchId: context.batchId })]);
    if (!matched || relation === 'update') await client.query(`INSERT INTO embeddings(config_id,story_id,input_hash,embedding)
      VALUES($1,$2,$3,$4::vector) ON CONFLICT(config_id,story_id) DO UPDATE SET input_hash=EXCLUDED.input_hash,embedding=EXCLUDED.embedding`,
    [vectors.config.id, storyId, hash([vectors.config.input_version, mention.text]), JSON.stringify(vector)]);
    return storyId;
  });
}
