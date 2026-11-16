import { z } from 'zod';
import { db, transaction } from '../db.js';
import { evidenceLinkSql } from '../sources/links.js';
import { generateStructured } from '../models/index.js';
import { jevTemplates } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import { generationClient, recordGenerationFailure, requireInferenceApproval } from './generation-model.js';
import type { StageContext } from './state.js';

const linkSchema = z.object({ id: z.uuid(), url: z.string(), anchor_text: z.string().nullable() });
const decisionSchema = z.object({
  associations: z.array(z.object({ linkId: z.uuid(), targetId: z.uuid(),
    classification: z.enum(['relevant', 'uncertain', 'irrelevant']) }).strict()),
}).strict();

/** Assess this revision's links only against its own extracted news, never the story catalogue. */
export async function classifyItemLinks(revisionId: string, settings: AppSettings, context: StageContext): Promise<void> {
  const mentions = await db.query<{ id: string; text: string }>('SELECT id,text FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal', [revisionId]);
  // Confirmed-empty extraction is final. It cannot contribute links to other stories.
  if (!mentions.rows.length) return;
  const revision = z.object({ original_text: z.string(), access: z.string() }).parse((await db.query(`
    SELECT r.original_text,s.access FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
    JOIN sources s ON s.id=i.source_id WHERE r.id=$1`, [revisionId])).rows[0]);
  const links = z.array(linkSchema).parse((await db.query(
    `SELECT id,url,anchor_text FROM item_links l WHERE revision_id=$1 AND ${evidenceLinkSql} ORDER BY id`, [revisionId])).rows);
  if (!links.length) return;
  await requireInferenceApproval([revision.access], context.id);
  const targetIds = new Set(mentions.rows.map(mention => mention.id));
  const linkIds = new Set(links.map(link => link.id));
  const result = await generateStructured(await generationClient(settings), {
    systemPrompt: jevTemplates.link_relevance.questions.relevance.instructions +
      '\nClassify ALL supplied link/target pairs together. Each target is an extracted news report from this message. ' +
      'Associate a link only with the specific event reported by that target, not other news or background in the message. ' +
      'Return relevant or uncertain pairs only; omitted pairs are irrelevant. Do not infer unseen page contents.',
    prompt: JSON.stringify({ message: revision.original_text, links, targets: mentions.rows }),
    validator: decisionSchema,
    validate: value => value.associations.every(pair => linkIds.has(pair.linkId) && targetIds.has(pair.targetId))
      && new Set(value.associations.map(pair => pair.linkId + ':' + pair.targetId)).size === value.associations.length,
    responseSchema: { name: 'item_news_links', schema: z.toJSONSchema(decisionSchema) },
  }, { operationId: context.id, attempt: context.attempt }, recordGenerationFailure);
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    await client.query('SELECT id FROM source_items WHERE current_revision_id=$1 FOR SHARE', [revisionId]);
    if (!(await client.query('SELECT 1 FROM source_items WHERE current_revision_id=$1', [revisionId])).rows.length) throw new Error('Link source changed');
    for (const mention of mentions.rows) for (const link of links) {
      const classification = result.value.associations.find(pair => pair.linkId===link.id && pair.targetId===mention.id)?.classification ?? 'irrelevant';
      await client.query(`INSERT INTO mention_links(mention_id,link_id,classification,model_version) VALUES($1,$2,$3,$4)
        ON CONFLICT(mention_id,link_id) DO UPDATE SET classification=EXCLUDED.classification,model_version=EXCLUDED.model_version`,
      [mention.id,link.id,classification,settings.modelVersion]);
    }
  });
}
