import { transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { blockedStoriesCte } from './item-failures.js';

/** Caller owns news-bot-pipeline; snapshot creation shares the history lock. */
export async function cleanup(settings: AppSettings): Promise<void> {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    await client.query(`INSERT INTO operational_state(key,value)
      SELECT 'pipeline_pruned_failures',jsonb_build_object('count',count(*),'lastPrunedAt',now()) FROM processing_batches
      WHERE status='failed' AND started_at<now()-$1*interval '1 day' HAVING count(*)>0
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [settings.retentionDays]);
    await client.query(`DELETE FROM processing_batches WHERE status='failed' AND started_at<now()-$1*interval '1 day'`, [settings.retentionDays]);
    // Failed digest work needs manual correction. Abandon its raw-history pin after the retention window.
    await client.query(`WITH abandoned AS (DELETE FROM operational_state o WHERE o.key LIKE 'digest_refresh:%'
      AND o.updated_at<now()-$1*interval '1 day' AND EXISTS(SELECT 1 FROM operational_state d
        WHERE d.key='pipeline_digest' AND d.value->>'phase'='failed') RETURNING value->>'storyId' AS story_id)
      UPDATE stories SET status='failed',interest_stale=true WHERE id::text IN (SELECT story_id FROM abandoned)`, [settings.retentionDays]);
    await client.query(`DELETE FROM operational_state o WHERE key LIKE 'digest_refresh:%'
      AND NOT EXISTS(SELECT 1 FROM stories s WHERE s.id::text=o.value->>'storyId' AND s.status<>'rejected')`);
    await client.query(`CREATE TEMP TABLE pipeline_protected_stories ON COMMIT DROP AS
      SELECT DISTINCT m.story_id AS id FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
        JOIN item_revisions br ON br.item_id=r.item_id JOIN batch_items bi ON bi.revision_id=br.id
        JOIN processing_batches b ON b.id=bi.batch_id WHERE b.completed_at IS NULL AND m.story_id IS NOT NULL
      UNION SELECT sl.story_id FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
        JOIN item_revisions r ON r.id=l.revision_id JOIN item_revisions br ON br.item_id=r.item_id
        JOIN batch_items bi ON bi.revision_id=br.id JOIN processing_batches b ON b.id=bi.batch_id
        WHERE b.completed_at IS NULL
      UNION SELECT st.story_id FROM stage_state st JOIN processing_batches b ON b.id=st.batch_id
        WHERE b.completed_at IS NULL AND st.story_id IS NOT NULL
      UNION SELECT s.id FROM stories s JOIN operational_state o ON o.value->>'storyId'=s.id::text WHERE o.key LIKE 'digest_refresh:%'`);
    await client.query(`DELETE FROM source_items i WHERE i.retention_at<now()-$1*interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM item_revisions r JOIN batch_items bi ON bi.revision_id=r.id
        JOIN processing_batches b ON b.id=bi.batch_id WHERE r.item_id=i.id AND b.completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM story_mentions m JOIN pipeline_protected_stories p ON p.id=m.story_id
        WHERE m.revision_id=i.current_revision_id)
      AND NOT EXISTS(SELECT 1 FROM story_link_sources sl JOIN pipeline_protected_stories p ON p.id=sl.story_id
        JOIN item_links l ON l.id=sl.link_id JOIN item_revisions r ON r.id=l.revision_id
        WHERE r.item_id=i.id)`, [settings.retentionDays]);
    await client.query(`WITH RECURSIVE ${blockedStoriesCte} DELETE FROM stories s WHERE NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.story_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM pipeline_protected_stories p WHERE p.id=s.id)
      AND s.id::text NOT IN(SELECT id FROM blocked_stories)`);
    await client.query(`DELETE FROM evidence_documents e WHERE expires_at<now() AND fetched_at<now()-$1*interval '1 day' AND NOT EXISTS(
      SELECT 1 FROM story_evidence se JOIN pipeline_protected_stories p ON p.id=se.story_id WHERE se.evidence_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM story_merge_evidence archived JOIN pipeline_protected_stories p
        ON p.id=archived.canonical_story_id OR p.id=archived.merged_story_id WHERE archived.evidence_id=e.id)`, [settings.retentionDays]);
    await client.query('DELETE FROM model_cache WHERE expires_at<now()');
    await client.query(`DELETE FROM judgments j WHERE expires_at<now()
      AND NOT EXISTS(SELECT 1 FROM pipeline_protected_stories p WHERE p.id=j.story_id)
      AND NOT EXISTS(SELECT 1 FROM processing_batches b WHERE b.completed_at IS NULL AND b.id=j.batch_id)`);
    await client.query(`DELETE FROM processing_batches WHERE status='completed' AND completed_at<now()-$1*interval '1 day'`, [settings.retentionDays]);
    await client.query(`DELETE FROM request_attempts WHERE stage_id IS NULL AND publication_id IS NULL
      AND finished_at<now()-$1*interval '1 day'`, [settings.retentionDays]);
    await client.query(`DELETE FROM embeddings WHERE config_id IN (SELECT id FROM embedding_configs WHERE status='retired')`);
    await client.query(`DELETE FROM embedding_configs c WHERE status='retired' AND NOT EXISTS
      (SELECT 1 FROM embeddings e WHERE e.config_id=c.id)`);
    await client.query(`DELETE FROM operational_state o WHERE key LIKE 'pipeline_failed_story:%'
      AND NOT EXISTS(SELECT 1 FROM stories s WHERE o.key='pipeline_failed_story:'||s.id::text)`);
    await client.query(`DELETE FROM operational_state o WHERE key LIKE 'pipeline_failed_item:%'
      AND NOT EXISTS(SELECT 1 FROM source_items i WHERE o.key='pipeline_failed_item:'||i.id::text)`);
    await client.query(`DELETE FROM operational_state o WHERE key LIKE 'reprocess_batch:%'
      AND NOT EXISTS(SELECT 1 FROM processing_batches b WHERE o.key='reprocess_batch:'||b.id::text)`);
    await client.query(`DELETE FROM operational_state o WHERE key LIKE 'run_now_batch:%'
      AND NOT EXISTS(SELECT 1 FROM processing_batches b WHERE o.key='run_now_batch:'||b.id::text)`);
    await client.query(`DELETE FROM operational_state o WHERE key LIKE 'run_now_publications:%'
      AND NOT EXISTS(SELECT 1 FROM operational_state w WHERE w.key='web_operation:'||split_part(o.key,':',2))`);
    await client.query(`INSERT INTO operational_state(key,value) VALUES('pipeline_cleanup',jsonb_build_object('completedAt',now()))
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`);
  });
}
