import { z } from 'zod';
import { evidenceLinkSql } from '../sources/link-policy.js';
import { db, transaction } from '../db.js';
import { jevTemplates } from '../models/templates.js';
import type { AppSettings } from '../settings.js';
import { Judgments } from './judgments.js';
import { confirmSourceLinks, SOURCE_CONFIRMATION_VERSION, type SourceConfirmationInput } from './source-links-confirmation.js';
import { eventInput, type EventInput } from './consolidation-input.js';
import { approveRemoteInput } from './privacy.js';
import { hash, type StageContext } from './state.js';
import { checkProcessingSlice, ProcessingYield } from './processing-slice.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';
import { validateStageOutput } from './stage-output-error.js';
import { sourceSelectionScope, sourceSelection, sourceSelectionDeferred, deferSourceSelection,
  resolveSourceSelection, type SourceSelection } from './source-links-deferrals.js';
import { sourceRoleDecision, sourceRelevanceDecision, sourceConfirmationDecision,saveSourceRole,saveSourceRelevance,
  saveSourceConfirmation,type RelevanceDecision,type ConfirmationDecision } from './source-links-decisions.js';
import { pendingSourceMessages, completeSourceMessage, type SourceMessage } from './source-links-queue.js';
const linkSchema = z.object({ id: z.uuid(), url: z.string(), anchor_text: z.string().nullable() });
const classificationSchema = z.enum(['relevant', 'uncertain', 'irrelevant']);
export const SOURCE_MESSAGES_PER_PASS = 50;
const limitsSchema = z.object({ maxMessages: z.number().int().min(1).max(500).default(SOURCE_MESSAGES_PER_PASS) });
interface Dependencies {
  judgments?: Pick<Judgments, 'judge'>;
  context?: Pick<StageContext, 'id' | 'batchId' | 'attempt'>;
  limits?: Partial<z.infer<typeof limitsSchema>>;
  inputBatchId?: string;
  messageWork?: (message: SourceMessage, run: (context: StageContext) => Promise<void>) => Promise<void>;
}
export function sourceLinkState(message: string, link: { url: string; anchor_text: string | null }, story: string) {
  return { story, link: link.url, anchor: link.anchor_text ?? '', surroundingText: message };
}
/** Caller holds pipeline lease. No extraction, story creation, merging, fetch or web search. */
export async function associateSourceLinks(settings: AppSettings, dependencies: Dependencies = {}) {
  const limits = limitsSchema.parse(dependencies.limits ?? {});
  const judgments = dependencies.judgments ?? new Judgments(settings);
  const result = { messages: 0, excluded: 0, compared: 0, associated: 0, deferred: 0 };
  const promptVersion = [jevTemplates.source_link_role.version, jevTemplates.link_relevance.version, SOURCE_CONFIRMATION_VERSION].join(':');
  try {
    for (const message of await pendingSourceMessages(settings, promptVersion, limits, dependencies.inputBatchId)) {
      checkProcessingSlice();
      result.messages++;
      const processMessage = async (context: StageContext): Promise<void> => {
        const links = z.array(linkSchema).parse((await db.query(
          `SELECT id,url,anchor_text FROM item_links l WHERE revision_id=$1 AND ${evidenceLinkSql} ORDER BY id`, [message.revision_id])).rows);
        const roleState = { message: { text: message.original_text },links: [...links]
          .sort((a,b)=>a.url.localeCompare(b.url) || (a.anchor_text ?? '').localeCompare(b.anchor_text ?? ''))
          .map(link=>({ url: link.url,anchor: link.anchor_text })) };
        const scope = await sourceSelectionScope(message.revision_id);
        const roleSelection = sourceSelection(scope,roleState);
        if (await sourceSelectionDeferred(roleSelection,settings)) { result.deferred++; return; }
        const existing = await db.query<{ id: string }>(`SELECT DISTINCT s.id FROM story_link_sources sl
          JOIN item_links l ON l.id=sl.link_id JOIN stories s ON s.id=sl.story_id
          WHERE l.revision_id=$1 AND s.status<>'rejected'
            AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
          UNION SELECT (value->>'storyId')::uuid FROM operational_state WHERE key LIKE 'source_link_deferred:%'
            AND value->'scope'->>'itemId'=$2 AND value->>'phase'='role' AND value->>'storyId' IS NOT NULL`, [message.revision_id,scope.itemId]);
        let role: 'source_only'|'excluded'|'other';
        try {
          const saved = await sourceRoleDecision(roleSelection);
          if (!saved) checkProcessingSlice();
          role = saved?.role ?? validateStageOutput(z.object({ type: z.literal('choice'), choice: z.enum(['source_only','excluded','other']) }),
            await judgments.judge('source_link_role',roleState,{ ...context,id: `${context.id}:role:${hash([scope.itemId,roleSelection.inputHash])}` })).choice;
          if (!saved) await saveSourceRole(roleSelection,role,settings,promptVersion);
        } catch (error) {
          if (error instanceof ProcessingYield) throw error;
          // Capture dependencies before removing unconfirmed associations.
          for (const { id } of existing.rows) {
            const aggregate = await eventInput(id);
            if (aggregate) await deferSourceSelection(sourceSelection(scope,roleState,aggregate),'role',error,settings);
          }
          await deferSourceSelection(roleSelection,'role',error,settings); result.deferred++; return;
        }
        await resolveSourceSelection(roleSelection.key);
        await db.query(`UPDATE operational_state SET value=value||'{"status":"resolved"}'::jsonb,updated_at=now()
          WHERE key LIKE 'source_link_deferred:%' AND value->>'phase'='role' AND value->'scope'->>'itemId'=$1
            AND value->'scope'->>'textHash'=$2 AND value->'scope'->>'linksHash'=$3`,[scope.itemId,scope.textHash,scope.linksHash]);
        if (role !== 'source_only') {
          result.excluded++;
          await db.query(`WITH removed AS (DELETE FROM story_link_sources sl USING item_links l
            WHERE sl.link_id=l.id AND l.revision_id=$1 RETURNING sl.story_id)
            UPDATE stories SET interest_stale=true,updated_at=now() WHERE id IN(SELECT story_id FROM removed)`, [message.revision_id]);
          await completeSourceMessage(message,role === 'excluded' ? 'excluded' : 'other'); return;
        }
        const candidates = await db.query<{ id: string }>(`SELECT s.id FROM stories s
          JOIN story_mentions m ON m.story_id=s.id JOIN item_revisions r ON r.id=m.revision_id
          JOIN source_items i ON i.current_revision_id=r.id
          WHERE s.status<>'rejected' AND i.retention_at>=now()-$1*interval '1 day'
            AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
          GROUP BY s.id ORDER BY max(cardinality(ARRAY(SELECT unnest(tsvector_to_array(to_tsvector('simple',m.text)))
            INTERSECT SELECT unnest(tsvector_to_array(to_tsvector('simple',$2)))))) DESC,
            max(i.retention_at) DESC,s.id LIMIT $3`, [settings.retentionDays,message.original_text,settings.matchCandidateLimit]);
        const decisions: Array<{ aggregate: EventInput; link: z.infer<typeof linkSchema>; selection: SourceSelection;
          state: ReturnType<typeof sourceLinkState>; classification: z.infer<typeof classificationSchema>; relevance: RelevanceDecision }>  = [];
        for (const id of new Set([...existing.rows,...candidates.rows].map(row => row.id))) {
          checkProcessingSlice();
          const aggregate = await eventInput(id);
          if (!aggregate) continue;
          for (const link of links) {
            checkProcessingSlice();
            const state = sourceLinkState(message.original_text,link,aggregate.text);
            const selection = sourceSelection(scope,{ state,reports: aggregate.reports },aggregate,link);
            const selectedContext = { ...context,storyId: id,id: `${context.id}:link:${hash([scope.itemId,selection.storyId,selection.inputHash])}` };
            if (await sourceSelectionDeferred(selection,settings)) { result.deferred++; continue; }
            await approveRemoteInput(settings.jevUrl,selectedContext.id,{ storyId: id,revisionId: message.revision_id });
            try {
              const saved = await sourceRelevanceDecision(selection);
              if (!saved) checkProcessingSlice();
              const relevance = saved ?? await saveSourceRelevance(selection,validateStageOutput(
                z.object({ type: z.literal('choice'),choice: classificationSchema }),await judgments.judge('link_relevance',state,selectedContext)).choice,
              settings,promptVersion);
              result.compared++; decisions.push({ aggregate,link,state,selection,classification: relevance.classification,relevance });
            } catch (error) {
              if (error instanceof ProcessingYield) throw error;
              await deferSourceSelection(selection,'relevance',error,settings); result.deferred++;
            }
          }
        }
        const positive = decisions.filter(decision => decision.classification === 'relevant')
          .sort((a,b) => a.link.id.localeCompare(b.link.id) || a.aggregate.id.localeCompare(b.aggregate.id));
        const confirmationInput: SourceConfirmationInput = { revision_id: message.revision_id,message: message.original_text,
          candidates: positive.map(({ aggregate,link }) => ({ candidate_id: `${link.id}:${aggregate.id}`,story_id: aggregate.id,
            link_id: link.id,url: link.url,anchor: link.anchor_text ?? '',story: aggregate.text })) };
        const unavailable = new Set<string>();
        const confirmations = new Map<string,ConfirmationDecision>();
        for (const candidate of confirmationInput.candidates) {
          const decision = positive.find(value=>`${value.link.id}:${value.aggregate.id}`===candidate.candidate_id);
          if (!decision) throw new Error('Unknown confirmation selection');
          await approveRemoteInput('https://api.openai.com',context.id,{ revisionId: message.revision_id,storyId: candidate.story_id });
          const saved = await sourceConfirmationDecision(decision.selection,{ ...confirmationInput,candidates: [candidate] });
          if (saved) confirmations.set(candidate.candidate_id,saved);
        }
        confirmationInput.candidates = confirmationInput.candidates.filter(candidate=>!confirmations.has(candidate.candidate_id));
        const fresh = confirmationInput.candidates.length ? await confirmSourceLinks(confirmationInput,settings,context,undefined,
          async (chunk,error) => {
            if (error instanceof ProcessingYield) throw error;
            for (const candidate of chunk.candidates) {
              const decision = positive.find(value => `${value.link.id}:${value.aggregate.id}` === candidate.candidate_id);
              if (!decision) throw new Error('Unknown source confirmation selection');
              await deferSourceSelection(decision.selection,'confirmation',error,settings);
              unavailable.add(candidate.candidate_id); result.deferred++;
            }
            return true;
          },undefined,async (chunk,proofs) => {
            for (const proof of proofs) {
              const candidate = chunk.candidates.find(candidate=>candidate.candidate_id===proof.candidate_id);
              const decision = positive.find(value=>`${value.link.id}:${value.aggregate.id}`===proof.candidate_id);
              if (!candidate || !decision) throw new Error('Unknown confirmed selection');
              confirmations.set(proof.candidate_id,await saveSourceConfirmation(decision.selection,{ ...chunk,candidates: [candidate] },proof,settings,promptVersion));
            }
          }) : [];
        for (const proof of fresh) if (!confirmations.has(proof.candidate_id)) {
          const candidate = confirmationInput.candidates.find(candidate=>candidate.candidate_id===proof.candidate_id);
          const decision = positive.find(value=>`${value.link.id}:${value.aggregate.id}`===proof.candidate_id);
          if (!candidate || !decision) throw new Error('Unknown confirmed selection');
          confirmations.set(proof.candidate_id,await saveSourceConfirmation(decision.selection,{ ...confirmationInput,candidates: [candidate] },proof,settings,promptVersion));
        }
        for (const { aggregate,link,state,selection,classification: proposed,relevance } of decisions) {
          if (unavailable.has(`${link.id}:${aggregate.id}`)) continue;
          const confirmation = confirmations.get(`${link.id}:${aggregate.id}`);
          if (proposed === 'relevant' && !confirmation) throw new Error('Missing source confirmation');
          const classification = confirmation?.proof.verdict ?? proposed;
          const binding = confirmation ?? relevance;
          const modelKey = binding.modelKey;
          const changed = await transaction(async client => {
            if ((await eventInput(aggregate.id,client))?.fingerprint !== aggregate.fingerprint) return false;
            const saved = await client.query(`INSERT INTO story_link_sources
              (link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
              SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM source_items WHERE current_revision_id=$8)
                AND NOT EXISTS(SELECT 1 FROM story_merges WHERE merged_story_id=$2)
              ON CONFLICT(link_id,story_id) DO UPDATE SET classification=EXCLUDED.classification,model_key=EXCLUDED.model_key,
                model_version=EXCLUDED.model_version,prompt_version=EXCLUDED.prompt_version,input_hash=EXCLUDED.input_hash,assessed_at=now()
              WHERE story_link_sources.input_hash<>EXCLUDED.input_hash OR story_link_sources.classification<>EXCLUDED.classification
                OR story_link_sources.model_key<>EXCLUDED.model_key OR story_link_sources.model_version<>EXCLUDED.model_version
                OR story_link_sources.prompt_version<>EXCLUDED.prompt_version RETURNING story_id`,
            [link.id,aggregate.id,classification,modelKey,binding.modelVersion,binding.promptVersion,hash({ state,confirmation: confirmation?.proof }),message.revision_id]);
            await client.query(`UPDATE operational_state SET value=value||'{"status":"resolved"}'::jsonb,updated_at=now() WHERE key=$1`, [selection.key]);
            if (!saved.rows.length) return false;
            await client.query('UPDATE stories SET interest_stale=true,updated_at=now() WHERE id=$1',[aggregate.id]); return true;
          });
          if (changed && classification === 'relevant') result.associated++;
        }
        await completeSourceMessage(message,'source_only');
      };
      if (dependencies.messageWork) await dependencies.messageWork(message,processMessage);
      else {
        try { await processMessage({ id: message.revision_id,revisionId: message.revision_id,storyId: null,batchId: null,attempt: 1,...dependencies.context }); }
        catch (error) {
          if (error instanceof ProcessingYield) throw error;
          await recordProcessingDiagnostic(error, { scope: 'stage', revisionId: message.revision_id });
          await deferSourceSelection(sourceSelection(await sourceSelectionScope(message.revision_id), { message: message.original_text }),
            'role', error, settings);
          result.deferred++;
        }
      }
    }
    return result;
  } finally { if (!dependencies.judgments && judgments instanceof Judgments) await judgments.close(); }
}
