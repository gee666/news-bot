import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { publishDigest } from '../publishing/index.js';
import { processBatch } from './batches.js';
import { requestScheduledIntake, drainScheduledIntake } from './scheduled-intake.js';
import { Judgments } from './judgments.js';
import { cleanup } from './retention.js';
import { refreshDigest } from './stories.js';
import { OperationalDeferred, operationalWork, saveOperational, type DigestPhase } from './operational.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';
import { reembedPending } from './vectors.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';
import { withLease } from './lease.js';
import { consolidateStories } from './consolidation.js';
import { associateSourceLinks, SOURCE_MESSAGES_PER_PASS } from './source-links.js';
import { runNow, type RunNowJob, type RunNowOutcome } from './run-now.js';

export interface Pipeline {
  start(): Promise<void>;
  stop(): Promise<void>;
  runCollection(): Promise<void>;
  runDigest(): Promise<void>;
  runNow(job: RunNowJob, checkpoint: () => Promise<void>, signal: AbortSignal): Promise<RunNowOutcome>;
  runCleanup(): Promise<void>;
  status(): Promise<unknown>;
}
export { withLease } from './lease.js';
export async function createPipeline(): Promise<Pipeline> {
  let running = false;
  let refreshing = false;
  let recovering = false;
  let scheduleKey = '';
  let tasks: ScheduledTask[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(job: () => Promise<T>): Promise<T> => {
    const promise = job().finally(() => { inflight.delete(promise); });
    inflight.add(promise);
    return promise;
  };
  const background = async (job: () => Promise<void>) => {
    try { await job(); } catch (error) {
      await recordProcessingDiagnostic(error, { scope: 'operation', operation: 'pipeline_launch' });
      await saveOperational('pipeline_last_error', { code: 'pipeline_failed', at: new Date().toISOString() }).catch(() => {});
    }
  };
  // node-cron awaits this promise before releasing its noOverlap guard.
  const launch = (job: () => Promise<void>): Promise<void> => track(() => background(job));
  const collection = async (manual: boolean, recoverOnly = false, slot?: Date) => {
    if (slot) await requestScheduledIntake(slot);
    await withLease('news-bot-pipeline', async () => {
      await drainScheduledIntake();
      await processBatch(manual, slot ? true : recoverOnly);
      const active = await db.query("SELECT 1 FROM processing_batches WHERE status IN ('queued','collecting','processing','waiting','failed') AND completed_at IS NULL LIMIT 1");
      if (active.rows.length) return;
      const settings = await getSettings();
      const pending = await db.query("SELECT 1 FROM embedding_configs WHERE status='pending'");
      if (pending.rows.length) await operationalWork('pipeline_reembedding', settings, manual,
        attempt => reembedPending(settings, attempt));
    });
  };
  const digest = async (manual = false) => {
    await withLease('news-bot-digest-refresh', async () => {
      const settings = await getSettings();
      let phase: DigestPhase = 'consolidation';
      await operationalWork('pipeline_digest', settings, manual, async attempt => {
        const judgments = new Judgments(settings);
        try {
          let deferredSelections = 0;
          let partial = false;
          const runPhase = async <T>(name: DigestPhase, work: () => Promise<T>): Promise<T | undefined> => {
            phase = name;
            let result: T | undefined;
            try {
              const held = await withLease('news-bot-pipeline', () => withProcessingSlice(async () => { result = await work(); }));
              if (!held) partial = true;
            } catch (error) {
              if (!(error instanceof ProcessingYield)) throw error;
              partial = true;
            }
            return result;
          };
          const context = { id: 'pipeline_digest', batchId: null, attempt };
          const intake = await db.query(`SELECT 1 FROM batch_items b JOIN processing_batches p ON p.id=b.batch_id
            WHERE p.completed_at IS NULL AND b.status IN ('pending','processing') LIMIT 1`);
          // Historical link enrichment must not consume the dispatch budget needed by new intake.
          if (manual || !intake.rows.length) {
            const comparisons = await runPhase('consolidation', () => consolidateStories(settings, { judgments, context }));
            deferredSelections += comparisons?.deferred ?? 0;
            const links = await runPhase('source_links', () => associateSourceLinks(settings, { judgments, context }));
            deferredSelections += links?.deferred ?? 0;
            if (links && links.messages >= SOURCE_MESSAGES_PER_PASS) partial = true;
          }
          const report = await runPhase('story_refresh', () => refreshDigest(settings, judgments));
          // Ready-event selection and final delivery already check each story's exact freshness.
          // Unrelated retained history must not hold publication or the processor lease.
          phase = 'publication';
          await publishDigest(settings);
          if (partial) throw new OperationalDeferred('Partial digest sweep. Saved work will resume after the checkpoint.');
          return report ? { ...report,deferredSelections } : undefined;
        } finally { await judgments.close(); }
      }, () => phase);
    });
  };
  const runCleanup = async () => { await withLease('news-bot-pipeline', async () => cleanup(await getSettings())); };
  const recover = async () => {
    if (!running || recovering) return;
    recovering = true;
    try {
      // Competing callbacks on the same cadence let even idle collection inspections starve digest.
      // One turn each per sweep prevents that race without giving digest permanent priority.
      await background(() => collection(false, true));
      if (!running) return;
      await background(async () => {
        const due = await db.query(`SELECT 1 FROM operational_state WHERE
          (key='pipeline_digest' AND (value->>'phase'='running' OR (value->>'next')::timestamptz<=now()))
          OR (key LIKE 'pipeline_failed_story:%' AND (value->>'next')::timestamptz<=now())
          OR key LIKE 'digest_refresh:%'
          OR (key LIKE 'consolidation_deferred:%' AND value->>'status'='unresolved' AND (value->>'next')::timestamptz<=now())
          OR (key LIKE 'source_link_deferred:%' AND value->>'status'='unresolved' AND (value->>'next')::timestamptz<=now()) LIMIT 1`);
        if (due.rows.length) await digest();
      });
    } finally { recovering = false; }
  };
  async function configure(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const settings = await getSettings();
      const key = JSON.stringify([settings.collectionCron, settings.digestCron, settings.cleanupCron, settings.timezone]);
      if (key !== scheduleKey && running) {
        await Promise.all(tasks.map(task => task.destroy()));
        const options = { timezone: settings.timezone, noOverlap: true };
        tasks = [
          cron.schedule(settings.collectionCron, context => launch(() => collection(false, true, context.date)), options),
          cron.schedule(settings.digestCron, () => launch(digest), options),
          cron.schedule(settings.cleanupCron, () => launch(runCleanup), options),
        ];
        scheduleKey = key;
      }
    } finally { refreshing = false; }
  }
  return {
    async start() {
      if (running) return;
      running = true;
      await configure();
      void launch(recover);
      timer = setInterval(() => {
        void launch(configure);
        void launch(recover);
      }, 15_000);
      timer.unref();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      await Promise.all(tasks.map(task => task.destroy()));
      tasks = [];
      scheduleKey = '';
      await Promise.allSettled([...inflight]);
    },
    runCollection: () => track(() => collection(true)), runDigest: () => track(() => digest(true)),
    runNow: (job, checkpoint, signal) => track(() => runNow(job, checkpoint, signal)),
    runCleanup: () => track(runCleanup),
    async status() {
      const batches = await db.query(`SELECT b.id,b.status,b.cutoff_at,b.started_at,b.completed_at,b.next_retry_at,b.waiting_reason,
        coalesce(b.error_code,CASE WHEN b.status='completed' AND EXISTS(SELECT 1 FROM batch_sources s
          WHERE s.batch_id=b.id AND s.status='failed') THEN 'partial_source_failure' END) AS error_code,
        (SELECT jsonb_build_object('total',count(*),'completed',count(*) FILTER(WHERE i.status='completed'),
          'rejected',count(*) FILTER(WHERE i.status='rejected'),'failed',count(*) FILTER(WHERE i.status='failed'),
          'pending',count(*) FILTER(WHERE i.status IN ('pending','processing'))) FROM batch_items i WHERE i.batch_id=b.id) AS item_counts,
        (SELECT jsonb_build_object('total',count(*),'completed',count(*) FILTER(WHERE s.status='completed'),
          'failed',count(*) FILTER(WHERE s.status='failed'),'pending',count(*) FILTER(WHERE s.status='pending'))
          FROM batch_sources s WHERE s.batch_id=b.id) AS source_counts,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',s.source_id,'code',s.error_code) ORDER BY s.source_id),'[]'::jsonb)
          FROM batch_sources s WHERE s.batch_id=b.id AND s.status='failed') AS source_failures
        FROM processing_batches b ORDER BY b.started_at DESC LIMIT 10`);
      const stages = await db.query(`SELECT id,batch_id,revision_id,story_id,stage,status,attempts,retry_epoch,retry_epoch_start,next_retry_at,waiting_reason,error_code,outcome_unknown
        FROM stage_state WHERE status IN ('running','waiting','failed') ORDER BY updated_at DESC LIMIT 100`);
      const operations = await db.query("SELECT key,value,updated_at FROM operational_state WHERE key LIKE 'pipeline_%' AND NOT starts_with(key,'pipeline_error:')");
      const selections = await db.query(`SELECT key,value->>'status' AS status,value->>'phase' AS phase,
        value->>'storyId' AS story_id,value->>'leftId' AS left_id,value->>'rightId' AS right_id,updated_at
        FROM operational_state WHERE key LIKE 'consolidation_deferred:%' OR key LIKE 'source_link_deferred:%'
        ORDER BY updated_at DESC LIMIT 100`);
      return { running, batches: batches.rows, stages: stages.rows, operations: operations.rows, aggregateSelections: selections.rows };
    },
  };
}
