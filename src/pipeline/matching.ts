import { z } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';

import { hash, stage, type StageContext } from './state.js';
import type { Vectors } from './vectors.js';
import { eventInput, mentionInput, type EventInput, type HistoricalEventRef } from './consolidation-input.js';
import { GROUPING_VERSION, groupReport } from './grouping-model.js';
import { mergeStories } from './consolidation-store.js';
import { historicalEventInput } from './historical-input.js';
import { ProcessingYield } from './processing-slice.js';

export interface Mention { id: string; revision_id: string; text: string; story_id: string | null }
interface Candidate { id: string; text: string; previous_revision_id: string | null; input?: EventInput; history?: HistoricalEventRef }
async function candidates(mention: Mention, vector: number[], vectors: Vectors, settings: AppSettings, batchId: string): Promise<Candidate[]> {
  const result = await db.query<Candidate>(`WITH current_mentions AS MATERIALIZED (
    SELECT m.*,i.original_url,e.embedding FROM story_mentions m
    JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
    LEFT JOIN embeddings e ON e.mention_id=m.id AND e.config_id=$4
    WHERE i.retention_at>=now()-$5*interval '1 day'
  ), recent AS (
    SELECT s.id,string_agg(DISTINCT cm.text,E'\\n\\n' ORDER BY cm.text) AS text,
      min(cm.embedding <=> $1::vector) AS distance,
      max(cardinality(ARRAY(SELECT unnest(tsvector_to_array(to_tsvector('simple',cm.text)))
        INTERSECT SELECT unnest(tsvector_to_array(to_tsvector('simple',$7)))))) AS lexical,
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
      AND s.id IS DISTINCT FROM $8::uuid GROUP BY s.id
    ), available AS (
      SELECT id,text,distance,lexical,shared_link,same_source,1 AS priority,NULL::text AS previous_revision_id
      FROM recent
      UNION ALL SELECT s.id,COALESCE(st.output->>'previousText',s.chosen_excerpt),NULL::float8,0::integer,true,true,0,st.output->>'revisionId'
      FROM stage_state st JOIN stories s ON s.id=st.story_id
      WHERE st.batch_id=$6 AND st.stage='extraction_affected' AND st.output->>'previousText' IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      UNION ALL SELECT s.id,string_agg(m.text,E'\\n\\n' ORDER BY m.id),NULL::float8,0::integer,false,true,0,r.id::text
      FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id JOIN stories s ON s.id=m.story_id
      WHERE r.id=(SELECT previous.id FROM item_revisions previous JOIN item_revisions incoming ON incoming.item_id=previous.item_id
        WHERE incoming.id=$3 AND previous.id<>incoming.id ORDER BY previous.revision_number DESC LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      GROUP BY s.id,r.id
    ) SELECT id,text,previous_revision_id FROM (SELECT DISTINCT ON(id) * FROM available ORDER BY id,priority) candidates
    WHERE ($9::boolean OR NOT EXISTS(SELECT 1 FROM sources private_source
      JOIN source_items private_item ON private_item.source_id=private_source.id
      JOIN item_revisions private_revision ON private_revision.item_id=private_item.id
      LEFT JOIN story_mentions private_mention ON private_mention.revision_id=private_revision.id
      WHERE private_source.access<>'public' AND (private_mention.story_id=candidates.id
        OR private_revision.id::text=candidates.previous_revision_id)))
    ORDER BY priority,shared_link DESC,distance ASC NULLS LAST,lexical DESC,same_source DESC,id`,
  [JSON.stringify(vector), mention.id, mention.revision_id, vectors.config.id, settings.retentionDays, batchId,
    mention.text, mention.story_id, process.env.ALLOW_PRIVATE_INFERENCE==='true']);
  // A prior extraction's text is only a fallback when that group has no current mentions.
  for (const candidate of result.rows) {
    const current = await eventInput(candidate.id);
    if (current) { candidate.text = current.text; candidate.input = current; }
    else if (candidate.previous_revision_id) {
      const history = { revisionId:candidate.previous_revision_id,batchId,text:candidate.text };
      const prior = await historicalEventInput(candidate.id,history);
      if (!prior) throw new Error('Historical event changed during matching');
      candidate.input=prior; candidate.history=history;
    }
  }
  return result.rows;
}

/** Full retained aggregates; Pi has room for more than a vector shortlist. */
export async function retainedStories(settings: AppSettings): Promise<EventInput[]> {
  const rows = await db.query<{ id: string }>(`SELECT s.id FROM stories s WHERE s.status<>'rejected'
    AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
    AND EXISTS(SELECT 1 FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id
      WHERE m.story_id=s.id AND i.retention_at>=now()-$1*interval '1 day')
    AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM story_mentions private_mention
      JOIN item_revisions private_revision ON private_revision.id=private_mention.revision_id
      JOIN source_items private_item ON private_item.id=private_revision.item_id
      JOIN sources private_source ON private_source.id=private_item.source_id
      WHERE private_mention.story_id=s.id AND private_source.access<>'public'))
    ORDER BY s.created_at,s.id`, [settings.retentionDays, process.env.ALLOW_PRIVATE_INFERENCE==='true']);
  const stories: EventInput[] = [];
  for (const row of rows.rows) {
    const story = await eventInput(row.id);
    if (story) stories.push(story);
  }
  return stories;
}

export async function matchBatch(batchId: string, settings: AppSettings, vectors: Vectors,
  mentionIds?: readonly string[]): Promise<void> {
  const selectedIds = mentionIds === undefined ? null : z.array(z.uuid()).parse(mentionIds);
  await db.query(`UPDATE stage_state s SET status='skipped',next_retry_at=NULL,updated_at=now()
    FROM story_mentions m WHERE s.batch_id=$1 AND s.revision_id=m.revision_id AND m.story_id IS NOT NULL
      AND (s.stage LIKE 'embed:%:'||m.id::text OR s.stage LIKE 'match:%:'||m.id::text)
      AND s.status IN ('pending','running','waiting','failed')`, [batchId]);
  const result = await db.query<Mention>(`SELECT m.id,m.revision_id,m.text,m.story_id FROM story_mentions m
    JOIN batch_items b ON b.revision_id=m.revision_id JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE b.batch_id=$1 AND b.status<>'rejected'
    AND m.story_id IS NULL AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window'
    AND ($2::uuid[] IS NULL OR m.id=ANY($2)) ORDER BY i.collected_at DESC,m.created_at,m.id`, [batchId, selectedIds]);
  for (const mention of result.rows) {
    try {
      const vector = await stage(batchId, { revisionId: mention.revision_id }, `embed:${vectors.config.config_key}:${mention.id}`, settings,
        z.array(z.number()), context => vectors.save({ mentionId: mention.id }, mention.text, context));
      await stage(batchId, { revisionId: mention.revision_id }, `match:${GROUPING_VERSION}:${mention.id}`, settings, z.string().uuid(), async context => {
        const saved = await db.query<{ story_id: string | null }>('SELECT story_id FROM story_mentions WHERE id=$1', [mention.id]);
        if (saved.rows[0]?.story_id) return saved.rows[0].story_id;
        const incoming = await mentionInput(mention.id);
        if (!incoming || incoming.text !== mention.text) throw new Error('Mention changed during matching');
        const available = await candidates(mention, vector, vectors, settings, batchId);
        const inputs = available.map(candidate => {
          if (!candidate.input) throw new Error('Story has no matching input');
          return candidate.input;
        });
        const matches = await groupReport(incoming, inputs, settings, context);
        let matched = available.find(candidate => candidate.id === matches[0]?.storyId);
        const relation = matches.some(match => match.relation === 'update') ? 'update' : 'same';
        for (const match of matches.slice(1)) {
          if (!matched) break;
          const left = matched.input;
          const right = inputs.find(input => input.id===match.storyId);
          if (!left || !right) throw new Error('Grouping target changed');
          const rightCandidate=available.find(candidate=>candidate.id===match.storyId);
          const merged = await mergeStories(left, right, 'update', {
            ...(matched.history ? { left:matched.history } : {}),
            ...(rightCandidate?.history ? { right:rightCandidate.history } : {}),
          });
          if (!merged) throw new Error('Grouping target changed');
          matched = { id: merged.canonicalId, text: '', previous_revision_id: null };
          const mergedInput = await eventInput(merged.canonicalId);
          if (!mergedInput) throw new Error('Merged story has no reports');
          matched.input = mergedInput;
          matched.text = mergedInput.text;
        }
        return attach(mention, incoming, vector, matched, relation, vectors, context);
      });
    } catch (error) {
      if (error instanceof ProcessingYield) throw error;
      const saved = await db.query(`SELECT 1 FROM stage_state WHERE batch_id=$1 AND revision_id=$2
        AND stage IN ($3,$4) AND status IN ('waiting','failed') LIMIT 1`,
      [batchId,mention.revision_id,`embed:${vectors.config.config_key}:${mention.id}`,`match:${GROUPING_VERSION}:${mention.id}`]);
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
      || (matched?.input && (matched.history ? await historicalEventInput(matched.id,matched.history,client)
        : await eventInput(matched.id, client))?.fingerprint !== matched.input.fingerprint)) {
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
    await client.query(`UPDATE stories SET status='processing',interest_stale=true,updated_at=now()
      WHERE id=$1 AND status='rejected'`, [storyId]);
    await client.query(`INSERT INTO consolidation_intake(revision_id,item_id,text_fingerprint,urls)
      SELECT r.id,r.item_id,encode(sha256(convert_to(r.original_text,'UTF8')),'hex'),
        ARRAY(SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=r.id ORDER BY l.url)
      FROM item_revisions r WHERE r.id=$1 AND NOT EXISTS(
        SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id IS NULL
          AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window')
      ON CONFLICT(revision_id) DO NOTHING`, [mention.revision_id]);
    if (!matched || relation === 'update') await client.query(`INSERT INTO embeddings(config_id,story_id,input_hash,embedding)
      VALUES($1,$2,$3,$4::vector) ON CONFLICT(config_id,story_id) DO UPDATE SET input_hash=EXCLUDED.input_hash,embedding=EXCLUDED.embedding`,
    [vectors.config.id, storyId, hash([vectors.config.input_version, mention.text]), JSON.stringify(vector)]);
    return storyId;
  });
}
