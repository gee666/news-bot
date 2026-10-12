import { z } from 'zod';
import { evidenceLinkSql } from '../sources/link-policy.js';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { generationClient, recordGenerationFailure, requireInferenceApproval } from './generation-model.js';
import { choice, type Judgments } from './judgments.js';
import { jevTemplates } from '../models/templates.js';
import { hash, stage, type StageContext } from './state.js';

import { applyExtraction, committedExtraction, EXTRACTION_VERSION, eventsSchema, eventText, eventSpans, validSpans, type Span, type ExtractedEvent } from './extraction-store.js';
import { extractWithGenerator } from './extraction-fallback.js';
import { StageOutputError, validateStageOutput } from './stage-output-error.js';
import { existingItemFailures, itemWork } from './item-failures.js';
export { validSpans } from './extraction-store.js';
export function deterministicSpans(text: string, count: string): Span[] {
  if (count === 'none') return [];
  if (count === '1') return text.trim() ? [{ start: text.search(/\S/u), end: text.trimEnd().length }] : [];
  const spans: Span[] = [];
  for (const match of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/gu)) {
    const start = match.index + match[0].search(/\S/u);
    const end = match.index + match[0].trimEnd().length;
    if (end > start) spans.push({ start, end });
  }
  return spans;
}
/** Formatting cannot prove event boundaries. Multiline or multi-event inputs require semantic extraction. */
export function deterministicEligible(text: string, count: string, spans: readonly Span[]): boolean {
  return count === '1' && spans.length === 1 && !/[\r\n]/u.test(text.trim()) && validSpans(text, spans)
    && spans[0]?.start === text.search(/\S/u) && spans[0]?.end === text.trimEnd().length;
}
const revisionSchema = z.object({ id: z.uuid(), original_text: z.string(), access: z.string() });
const eligibilityAnswerSchema = z.object({ type: z.literal('choice'), choice: z.enum(['eligible', 'rejected']) });
const admissionAnswerSchema = z.object({ type: z.literal('choice'), choice: z.enum(['extractable', 'not_extractable']) });
const eventRoleAnswerSchema = z.object({ type: z.literal('choice'), choice: z.enum(['current', 'background']) });
export async function extractBatch(batchId: string, settings: AppSettings, judgments: Judgments,
  onExtracted?: (revisionId: string) => Promise<void>): Promise<void> {
  await db.query(`UPDATE batch_items b SET status='failed',disposition_reason='superseded_revision'
    FROM item_revisions r JOIN source_items i ON i.id=r.item_id
    WHERE b.batch_id=$1 AND b.revision_id=r.id AND i.current_revision_id IS DISTINCT FROM r.id
      AND b.status IN ('pending','processing')`, [batchId]);
  await db.query(`UPDATE stage_state s SET status='skipped',next_retry_at=NULL,updated_at=now()
    FROM item_revisions r JOIN source_items i ON i.id=r.item_id
    WHERE s.batch_id=$1 AND s.revision_id=r.id AND i.current_revision_id IS DISTINCT FROM r.id
      AND s.status IN ('pending','waiting','running')`, [batchId]);
  const result = await db.query(`SELECT r.id,r.original_text,s.access FROM batch_items b JOIN item_revisions r ON r.id=b.revision_id
    JOIN source_items i ON i.id=r.item_id JOIN sources s ON s.id=i.source_id WHERE b.batch_id=$1 AND i.current_revision_id=r.id
    ORDER BY b.created_at,r.id`, [batchId]);
  const failed = await existingItemFailures(batchId);
  for (const r of z.array(revisionSchema).parse(result.rows)) {
    await itemWork(batchId, r.id, failed, async () => {
      const committed = await committedExtraction(r.id);
      if (committed !== null) {
        await applyExtraction(batchId, r.id, r.original_text, committed);
        await db.query(`UPDATE stage_state SET status='skipped',next_retry_at=NULL,updated_at=now()
          WHERE batch_id=$1 AND revision_id=$2 AND status IN ('pending','waiting','running','failed')
            AND (stage='count' OR stage LIKE 'item_eligibility:%' OR stage LIKE 'extract:%' OR stage LIKE 'validate_split:%')`, [batchId,r.id]);
      } else {
        const noNews = await stage(batchId, { revisionId: r.id },
          `item_eligibility:${jevTemplates.news_eligibility.version}:p${settings.profileVersion}:m${settings.modelVersion}`,
          settings, z.boolean(), async context => !await messageHasEligibleNews(r.original_text, judgments, context, settings));
        if (noNews) {
          await stage(batchId, { revisionId: r.id }, `extract:${EXTRACTION_VERSION}`, settings, eventsSchema, async () => {
            await applyExtraction(batchId, r.id, r.original_text, []); return [];
          });
        } else {
          const count = await stage(batchId, { revisionId: r.id }, 'count', settings, z.string(), async context =>
            choice(await judgments.judge('story_count', { message: { text: r.original_text } }, context)));
          const spans = deterministicSpans(r.original_text, count);
          const accepted = deterministicEligible(r.original_text, count, spans) && await stage(batchId, { revisionId: r.id },
            `validate_split:${EXTRACTION_VERSION}`, settings, z.boolean(), async context => {
              const answer = await judgments.judge('split_validation', { message: { text: r.original_text },
                proposedSpans: spans.map(s => ({ ...s, text: r.original_text.slice(s.start, s.end) })) }, context);
              return answer.type === 'noul' && answer.noul >= 0.8;
            });
          await stage(batchId, { revisionId: r.id }, `extract:${EXTRACTION_VERSION}`, settings, eventsSchema, async context => {
            const proposed = accepted ? spans.map(span => ({ parts: [span], context: [] }))
              : await fallback(r.original_text, r.access, settings, context, judgments);
            const events = await currentSourceEvents(r.original_text, proposed, judgments, context);
            await applyExtraction(batchId, r.id, r.original_text, events);
            return events;
          });
        }
      }
      await stage(batchId, { revisionId: r.id }, `links:${EXTRACTION_VERSION}`, settings, z.boolean(), async context => {
        const mentions = await db.query<{ id: string; text: string }>('SELECT id,text FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal', [r.id]);
        const links = await db.query<{ id: string; url: string; anchor_text: string | null }>(
          `SELECT id,url,anchor_text FROM item_links l WHERE revision_id=$1 AND ${evidenceLinkSql} ORDER BY id`, [r.id]);
        for (const m of mentions.rows) for (const link of links.rows) {
          const relevance = choice(await judgments.judge('link_relevance', { story: m.text, link: link.url,
            anchor: link.anchor_text, surroundingText: r.original_text }, context));
          await db.query(`INSERT INTO mention_links(mention_id,link_id,classification,model_version)
            VALUES($1,$2,$3,$4) ON CONFLICT(mention_id,link_id) DO UPDATE SET classification=EXCLUDED.classification,model_version=EXCLUDED.model_version`,
          [m.id, link.id, relevance, settings.modelVersion]);
        }
        return true;
      });
    });
    // Match and generate this item's successful output before dispatching its next sibling.
    if (!failed.has(r.id) && onExtracted) await onExtracted(r.id);
  }
}
/** Standalone eligibility cannot distinguish today's news from an article's historical comparison. */
export async function currentSourceEvents(text: string, events: ExtractedEvent[], judgments: Pick<Judgments, 'judge'>,
  context: StageContext): Promise<ExtractedEvent[]> {
  const current: ExtractedEvent[] = [];
  for (const event of events) {
    const role = eventRoleAnswerSchema.safeParse(await judgments.judge('extraction_event_role', {
      // eventText already includes every selected part and context span. Repeating them can exhaust JEV's context.
      sourceText: text, candidate: eventText(text, event),
    }, context));
    if (!role.success) {
      const error = new StageOutputError(role.error);
      error.message = 'Invalid source event role';
      throw error;
    }
    if (role.data.choice === 'current') current.push(event);
  }
  return current;
}
export async function messageHasEligibleNews(text: string, judgments: Pick<Judgments, 'judge'>, context: StageContext, settings: AppSettings): Promise<boolean> {
  const verdict = validateStageOutput(eligibilityAnswerSchema, await judgments.judge('news_eligibility',
    { story: text, interestProfile: settings.interestProfile, scope: 'message' }, context)).choice;
  return verdict === 'eligible';
}
export async function confirmNoNews(text: string, judgments: Pick<Judgments, 'judge'>, context: StageContext, settings: AppSettings): Promise<boolean> {
  if (!await messageHasEligibleNews(text, judgments, context, settings)) return true;
  // Eligibility can mistake a navigation caption for a recap. Require identifiable facts before inventing an event.
  const verdict = validateStageOutput(admissionAnswerSchema, await judgments.judge('extraction_admission',
    { message: { text }, interestProfile: settings.interestProfile }, context)).choice;
  return verdict === 'not_extractable';
}
/** Verify source-selected candidates independently without proposing any new source boundaries. */
export async function confirmCandidatePartition(text: string, events: ExtractedEvent[], judgments: Pick<Judgments, 'judge'>,
  context: StageContext, settings: AppSettings): Promise<ExtractedEvent[] | false> {
  if (!events.length || !eventsSchema.safeParse(events).success
    || !events.every(event => validSpans(text, eventSpans(event)))
    || !validSpans(text, events.flatMap(event => event.parts).sort((left, right) => left.start - right.start))) return false;
  const accepted: ExtractedEvent[] = [];
  for (const event of events) {
    const candidate = eventText(text, event);
    const eligible = validateStageOutput(eligibilityAnswerSchema, await judgments.judge('news_eligibility', {
      story: candidate, interestProfile: settings.interestProfile, scope: 'story',
    }, context)).choice;
    if (eligible !== 'eligible') continue;
    // Validate the whole assembled candidate, not a bounding span that could swallow a different
    // event between nonadjacent parts. Original-source role checks still run before commit.
    const coherent = await judgments.judge('split_validation', { message: { text: candidate },
      proposedSpans: [{ start: 0, end: candidate.length, text: candidate }],
    }, context);
    if (!(coherent.type === 'noul' && coherent.noul >= 0.8)) return false;
    accepted.push(event);
  }
  return accepted.length ? accepted : false;
}
async function fallback(text: string, access: string, settings: AppSettings, context: StageContext, judgments: Judgments): Promise<ExtractedEvent[]> {
  await requireInferenceApproval([access], context.id);
  const result = await extractWithGenerator(text, await generationClient(settings),
    { operationId: context.id, attempt: context.attempt }, recordGenerationFailure, () => confirmNoNews(text, judgments, context, settings),
    events => confirmCandidatePartition(text, events, judgments, context, settings), settings.interestProfile);
  await db.query(`INSERT INTO judgments(batch_id,revision_id,stage,input_hash,model_key,prompt_version,profile_version,model_version,result,expires_at)
    VALUES($1,$2,'extraction_resolution',$3,$4,$5,$6,$7,$8,now()+$9*interval '1 day')`,
  [context.batchId, context.revisionId, hash(text), `${settings.piProvider}/${settings.piModel}`, `${EXTRACTION_VERSION}:review-resolution-v2`,
    settings.profileVersion, settings.modelVersion, JSON.stringify({ resolution: result.resolution, eventCount: result.events.length }), settings.retentionDays]);
  return result.events;
}
