import { db } from '../db.js';
import { usageStats, usageCalls } from '../usage/repository.js';
import { getSettings, saveSettings } from '../settings.js';
import { EmbeddingClient, JevClient, PiGenerator, PiOAuth, type PiRuntime } from '../models/index.js';
import { withUserClient } from '../telegram/client.js';
import { discoverChannels, resolveDestination } from '../telegram/discovery.js';
import { listSources, refreshSources } from '../telegram/repository.js';
import type { ApiServices } from './app.js';
import { listPrimarySources, addPrimarySource, editPrimarySource, seedPrimarySources } from '../sources/index.js';
import { Operations, observeCollection, runCollectionOperation, observeDigest, runDigestOperation, type OperationRunner } from './operations.js';
import type { RunNowJob, RunNowOutcome } from '../pipeline/run-now.js';
import { publicationAdmissionDenialSchema } from './contracts.js';

export interface RuntimePipeline {
  start(): Promise<void>;
  stop(): Promise<void>;
  runCollection(): Promise<void>;
  runDigest(): Promise<void>;
  runNow(job: RunNowJob, checkpoint: () => Promise<void>, signal: AbortSignal): Promise<RunNowOutcome>;
  runCleanup(): Promise<void>;
  status(): Promise<unknown>;
}

export function createServices(pipeline: RuntimePipeline, runtime: PiRuntime) {
  const oauth = new PiOAuth(runtime.modelRuntime);
  const runner: OperationRunner = async (operation, recordFailure, signal, checkpoint) => {
    const context = { operationId: operation.id, stage: operation.kind, attempt: operation.attempt, signal };
    if (operation.kind === 'run_now') return pipeline.runNow(operation, checkpoint, signal);
    if (operation.kind === 'collection') return runCollectionOperation(operation, () => pipeline.runCollection());
    if (operation.kind === 'digest') return runDigestOperation(operation, () => pipeline.runDigest());
    if (operation.kind === 'cleanup') return pipeline.runCleanup();
    if (operation.kind === 'refresh_sources') {
      await withUserClient(async client => {
        const destination = await resolveDestination(client);
        await refreshSources(await discoverChannels(client, destination.channelId), destination);
      });
      return;
    }
    const settings = await getSettings();
    if (operation.kind === 'test_pi') {
      await new PiGenerator({ runtime, recordFailure, provider: settings.piProvider,
        model: settings.piModel, timeoutMs: settings.piTimeoutMs,
        requestMaxAttempts: settings.requestMaxAttempts }).test(context);
      return;
    }
    const client = operation.kind === 'test_jev' ? new JevClient({ baseUrl: settings.jevUrl,
      apiKey: process.env.JEV_API_KEY ?? '', model: settings.jevModel, timeoutMs: settings.jevTimeoutMs,
      connectTimeoutMs: settings.connectionTimeoutMs, prefixCache: settings.prefixCacheEnabled,
      requestMaxAttempts: settings.requestMaxAttempts, recordFailure }) :
      new EmbeddingClient({ baseUrl: settings.embeddingUrl, model: settings.embeddingModel,
        dimensions: settings.embeddingDimensions, timeoutMs: settings.embeddingTimeoutMs,
        connectTimeoutMs: settings.connectionTimeoutMs, requestMaxAttempts: settings.requestMaxAttempts, recordFailure });
    try { await client.test(context); } finally { await client.close(); }
  };
  const operations = new Operations(runner,
    operation => operation.kind === 'digest' ? observeDigest(operation) : observeCollection(operation),
  async () => (await getSettings()).requestMaxAttempts);
  const services: ApiServices = {
    usage: usageStats,
    usageCalls,
    primarySources: listPrimarySources,
    addPrimarySource,
    editPrimarySource,
    seedPrimarySources,
    settings: getSettings,
    save: saveSettings,
    sources: async () => (await listSources()).map(source => ({ id: source.id, name: source.name,
      externalId: source.externalId, access: source.access, enabled: source.enabled, active: source.active })),
    toggleSource: async (id, enabled) => {
      const result = await db.query('UPDATE sources SET enabled=$2,updated_at=now() WHERE id=$1 RETURNING id', [id, enabled]);
      return Boolean(result.rowCount);
    },
    status: async () => {
      // Select only operational fields. Never return snapshots, raw source content or connector metadata.
      const [batches, waits, embeddings, publications, readyPublications, digestRecovery, admissionDenials, publicationMaintenance] = await Promise.all([
        db.query(`SELECT b.id,b.status,b.started_at,b.completed_at,b.next_retry_at,b.waiting_reason,
          coalesce(b.error_code,CASE WHEN b.status='completed' AND EXISTS(SELECT 1 FROM batch_sources s
            WHERE s.batch_id=b.id AND s.status='failed') THEN 'partial_source_failure' END) AS error_code,
          (SELECT jsonb_build_object('total',count(*),'completed',count(*) FILTER(WHERE i.status='completed'),
            'rejected',count(*) FILTER(WHERE i.status='rejected'),'failed',count(*) FILTER(WHERE i.status='failed'),
            'pending',count(*) FILTER(WHERE i.status IN ('pending','processing')))
            FROM batch_items i WHERE i.batch_id=b.id) AS item_counts,
          (SELECT jsonb_build_object('total',count(*),'completed',count(*) FILTER(WHERE s.status='completed'),
            'failed',count(*) FILTER(WHERE s.status='failed'),'pending',count(*) FILTER(WHERE s.status='pending'))
            FROM batch_sources s WHERE s.batch_id=b.id) AS source_counts,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',s.source_id,'code',s.error_code) ORDER BY s.source_id),'[]'::jsonb)
            FROM batch_sources s WHERE s.batch_id=b.id AND s.status='failed') AS source_failures
          FROM processing_batches b ORDER BY b.started_at DESC LIMIT 5`),
        db.query(`SELECT s.batch_id,b.status AS batch_status,b.completed_at AS batch_completed_at,b.error_code AS batch_error_code,
          s.stage,s.status,s.next_retry_at,s.waiting_reason,s.error_code,count(*)::int AS count
          FROM stage_state s JOIN processing_batches b ON b.id=s.batch_id
          WHERE s.status IN ('pending','running','waiting','failed')
          GROUP BY s.batch_id,b.status,b.completed_at,b.error_code,s.stage,s.status,s.next_retry_at,s.waiting_reason,s.error_code
          ORDER BY max(s.updated_at) DESC LIMIT 50`),
        db.query('SELECT model,dimensions,input_version,status FROM embedding_configs WHERE status IN (\'active\',\'pending\')'),
        db.query('SELECT status,count(*)::int AS count FROM publications GROUP BY status'),
        db.query('SELECT status,reason,count(*)::int AS count FROM story_publication_ready GROUP BY status,reason ORDER BY status,reason'),
        db.query(`SELECT value->>'phase' AS phase,value->>'code' AS code,value->>'next' AS next_retry_at FROM operational_state WHERE key='pipeline_digest'`),
        db.query(`SELECT value->>'publicationId' AS "publicationId",value->>'snapshotId' AS "snapshotId",
          value->>'operation' AS operation,value->>'reason' AS reason,
          coalesce(value->>'lastSeenAt',value->>'at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS "lastSeenAt",
          coalesce(value->'occurrences','1'::jsonb) AS occurrences
          FROM operational_state WHERE key LIKE 'publication_admission:%' ORDER BY updated_at DESC LIMIT 100`),
        db.query(`SELECT value->>'status' AS phase,coalesce((value->>'attempts')::int,0) AS attempts,
          value->>'errorCode' AS code,value->>'nextRetryAt' AS next_retry_at
          FROM operational_state WHERE key='telegram_publication_maintenance'`),
      ]);
      const publicationAdmissionDenials = admissionDenials.rows.flatMap((row: unknown) => {
        const parsed = publicationAdmissionDenialSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
      return { batches: batches.rows, waits: waits.rows, embeddings: embeddings.rows, publications: publications.rows,
        readyPublications: readyPublications.rows, digestRecovery: digestRecovery.rows[0] ?? null,
        publicationAdmissionDenials,publicationMaintenance:publicationMaintenance.rows[0] ?? null };
    },
    loginStatus: () => oauth.status(),
    loginStart: async () => {
      // Pi may wait for the provider callback. Do not keep a browser HTTP request open.
      void oauth.start().catch(() => { console.error('Pi login could not start.'); });
      return oauth.status();
    },
    loginFinish: (id, redirectUrl) => oauth.finish(id, redirectUrl),
    loginCancel: id => oauth.cancel(id),
    start: (kind, options) => operations.start(kind, options),
    operation: id => operations.get(id),
    operations: () => operations.list(),
  };
  return { services, operations, oauth };
}
