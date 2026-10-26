import { z } from 'zod';
import { db, transaction } from '../db.js';
import { evidenceLinkSql } from '../sources/links.js';
import { generateStructured } from '../models/index.js';
import { jevTemplates } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import { generationClient, recordGenerationFailure, requireInferenceApproval } from './generation-model.js';
import { eventInput } from './consolidation-input.js';
import { retainedStories } from './matching.js';
import { approveRemoteInput } from './privacy.js';
import { hash, stage, type StageContext } from './state.js';
import { itemWork } from './item-failures.js';
import { eventSemanticHash } from './consolidation-input.js';
import { unpublished } from './generation-store.js';

const LINK_VERSION = 'item-links-v1';
const sourceStageName = (catalogue:string,settings:AppSettings) => `source_links:${LINK_VERSION}:${catalogue}:m${settings.modelVersion}`;

/** Revisit source-only references when new stories arrive, without a second queue or retry tracker. */
export async function associateSourceLinks(settings: AppSettings): Promise<void> {
  // Reclassifying every recap against the changing catalogue is optional enrichment.
  // Finish unextracted intake first instead of competing with it on every recovery sweep.
  const intake = await db.query<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM batch_items b
    JOIN processing_batches p ON p.id=b.batch_id JOIN item_revisions r ON r.id=b.revision_id
    JOIN source_items i ON i.current_revision_id=r.id
    WHERE b.status IN ('pending','processing') AND p.completed_at IS NULL
      AND b.disposition_reason IS DISTINCT FROM 'outside_collection_window'
      AND NOT (r.metadata ? 'pipelineExtraction')) AS pending`);
  if (intake.rows[0]?.pending) return;
  const catalogue = eventSemanticHash(...await retainedStories(settings));
  const rows = await db.query<{ revision_id: string; batch_id: string }>(`SELECT r.id AS revision_id,
    (SELECT b.batch_id FROM batch_items b JOIN processing_batches p ON p.id=b.batch_id
      WHERE b.revision_id=r.id ORDER BY p.started_at DESC LIMIT 1) AS batch_id
    FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
    WHERE i.retention_at>=now()-$1*interval '1 day' AND r.metadata->'pipelineExtraction'='[]'::jsonb
      AND EXISTS(SELECT 1 FROM item_links l WHERE l.revision_id=r.id AND ${evidenceLinkSql})
      AND EXISTS(SELECT 1 FROM batch_items b WHERE b.revision_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM batch_items b JOIN processing_batches p ON p.id=b.batch_id
        WHERE b.revision_id=r.id AND p.manual_operation_id IS NOT NULL AND p.completed_at IS NULL)
    ORDER BY i.collected_at DESC,r.id`, [settings.retentionDays]);
  for (const row of rows.rows) {
    const name=sourceStageName(catalogue,settings);
    await db.query(`UPDATE stage_state SET status='skipped',next_retry_at=NULL,updated_at=now()
      WHERE revision_id=$1 AND stage LIKE 'source_links:${LINK_VERSION}:%' AND stage<>$2
        AND status IN ('pending','running','waiting','failed')`, [row.revision_id,name]);
    const active=await db.query<{processing_key:string}>('SELECT processing_key FROM source_link_processing WHERE revision_id=$1',[row.revision_id]);
    if (active.rows[0]?.processing_key===name) {
      // Associations may commit before stage acknowledgement, or via ordinary item processing.
      await db.query(`UPDATE stage_state SET status='completed',output='true'::jsonb,completed_at=now(),
        next_retry_at=NULL,error_code=NULL,waiting_reason=NULL,outcome_unknown=false,updated_at=now()
        WHERE revision_id=$1 AND stage=$2 AND status IN ('pending','running','waiting','failed')`, [row.revision_id,name]);
      continue;
    }
    // A/B/A catalogue changes must apply A again, not trust an overwritten boolean receipt.
    await db.query(`UPDATE stage_state SET status='pending',output=NULL,completed_at=NULL,updated_at=now()
      WHERE revision_id=$1 AND stage=$2 AND status='completed'`, [row.revision_id,name]);
    await itemWork(row.batch_id,row.revision_id,new Set(), async () => {
      await stage(row.batch_id,{ revisionId: row.revision_id },name,settings,z.boolean(),async context => {
        await classifyItemLinks(row.revision_id,settings,context); return true;
      });
    });
  }
}

const linkSchema = z.object({ id: z.uuid(), url: z.string(), anchor_text: z.string().nullable() });
const decisionSchema = z.object({
  associations: z.array(z.object({ linkId: z.uuid(), targetId: z.uuid(),
    classification: z.enum(['relevant', 'uncertain', 'irrelevant']) }).strict()),
}).strict();

/** A link is a research candidate, never proof of authority or unseen page contents. */
export async function classifyItemLinks(revisionId: string, settings: AppSettings, context: StageContext): Promise<void> {
  const revision = z.object({ original_text: z.string(), access: z.string() }).parse((await db.query(`
    SELECT r.original_text,s.access FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
    JOIN sources s ON s.id=i.source_id WHERE r.id=$1`, [revisionId])).rows[0]);
  const links = z.array(linkSchema).parse((await db.query(
    `SELECT id,url,anchor_text FROM item_links l WHERE revision_id=$1 AND ${evidenceLinkSql} ORDER BY id`, [revisionId])).rows);
  if (!links.length) return;
  await requireInferenceApproval([revision.access], context.id);
  const mentions = await db.query<{ id: string; text: string }>('SELECT id,text FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal', [revisionId]);
  const sourceOnly = !mentions.rows.length;
  const stories = sourceOnly ? await retainedStories(settings) : [];
  for (const story of stories) await approveRemoteInput('https://api.openai.com', context.id, { storyId: story.id });
  const targets = sourceOnly ? stories.map(story => ({ id: story.id, reports: story.reports })) : mentions.rows;
  const targetIds = new Set(targets.map(target => target.id));
  const linkIds = new Set(links.map(link => link.id));
  const result = targets.length ? await generateStructured(await generationClient(settings), {
    systemPrompt: jevTemplates.link_relevance.questions.relevance.instructions +
      '\nClassify ALL supplied link/target pairs together. For an item without extracted news, associate only source references allowed by this rule: ' +
      jevTemplates.source_link_role.questions.role.instructions +
      '\nReturn relevant or uncertain pairs only; omitted pairs are irrelevant. Do not infer unseen page contents. A recap may support several distinct products without merging their stories.',
    prompt: JSON.stringify({ message: revision.original_text, sourceOnly, links, targets }),
    validator: decisionSchema,
    validate: value => value.associations.every(pair => linkIds.has(pair.linkId) && targetIds.has(pair.targetId))
      && new Set(value.associations.map(pair => pair.linkId + ':' + pair.targetId)).size === value.associations.length,
    responseSchema: { name: 'item_source_links', schema: z.toJSONSchema(decisionSchema) },
  }, { operationId: context.id, attempt: context.attempt }, recordGenerationFailure) : { value:{associations:[]} };
  await transaction(async client => {
    await client.query('SELECT id FROM source_items WHERE current_revision_id=$1 FOR SHARE', [revisionId]);
    if (!(await client.query('SELECT 1 FROM source_items WHERE current_revision_id=$1', [revisionId])).rows.length) throw new Error('Link source changed');
    for (const story of stories) {
      if ((await eventInput(story.id,client))?.fingerprint !== story.fingerprint) throw new Error('Link target changed');
    }
    if (sourceOnly) {
      await client.query(`INSERT INTO source_link_processing(revision_id,processing_key,role)
        VALUES($1,$2,'source_only') ON CONFLICT(revision_id) DO UPDATE SET processing_key=EXCLUDED.processing_key,
          role=EXCLUDED.role,processed_at=now()`, [revisionId,sourceStageName(eventSemanticHash(...stories),settings)]);
      const previous = await client.query<{ link_id: string; story_id: string; classification: string }>(`SELECT sl.link_id,sl.story_id,sl.classification
        FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id WHERE l.revision_id=$1`, [revisionId]);
      const oldPairs = new Map(previous.rows.map(pair => [`${pair.link_id}:${pair.story_id}`, pair]));
      const nextPairs = new Map(result.value.associations.map(pair => [`${pair.linkId}:${pair.targetId}`, pair]));
      const changed = new Set<string>();
      for (const [key, pair] of oldPairs) {
        if ((nextPairs.get(key)?.classification === 'relevant') !== (pair.classification === 'relevant')) changed.add(pair.story_id);
      }
      await client.query(`DELETE FROM story_link_sources sl USING item_links l
        WHERE sl.link_id=l.id AND l.revision_id=$1`, [revisionId]);
      for (const pair of result.value.associations) {
        await client.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [pair.linkId,pair.targetId,pair.classification,
        `${settings.piProvider}/${settings.piModel}`, settings.modelVersion,LINK_VERSION,hash({ revisionId,pair })]);
        if ((oldPairs.get(`${pair.linkId}:${pair.targetId}`)?.classification === 'relevant') !== (pair.classification === 'relevant')) changed.add(pair.targetId);
      }
      if (changed.size) {
        await client.query(`UPDATE stories s SET interest_stale=true,updated_at=now() WHERE id=ANY($1::uuid[]) AND ${unpublished('s')}`, [[...changed]]);
        await client.query(`INSERT INTO operational_state(key,value)
          SELECT 'digest_refresh:'||id::text,jsonb_build_object('storyId',id) FROM stories WHERE id=ANY($1::uuid[])
          ON CONFLICT(key) DO NOTHING`, [[...changed]]);
      }
    } else {
      for (const mention of mentions.rows) for (const link of links) {
        const classification = result.value.associations.find(pair => pair.linkId===link.id && pair.targetId===mention.id)?.classification ?? 'irrelevant';
        await client.query(`INSERT INTO mention_links(mention_id,link_id,classification,model_version) VALUES($1,$2,$3,$4)
          ON CONFLICT(mention_id,link_id) DO UPDATE SET classification=EXCLUDED.classification,model_version=EXCLUDED.model_version`,
        [mention.id,link.id,classification,settings.modelVersion]);
      }
    }
  });
}
