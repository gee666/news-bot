import type { PoolClient } from 'pg';
import { transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import type { DeliveryAuthorization } from './approval.js';
import { publicationAdmission, type PublicationAdmission } from './freshness.js';
import type { Publication } from './store.js';

type Operation = 'send' | 'edit';

/** Policy denials are not Telegram attempts and must not change delivery/reconciliation state. */
export async function recordAdmissionDenial(client: Pick<PoolClient, 'query'>, publication: Publication,
  operation: Operation, reason: Extract<PublicationAdmission, { allowed: false }>['reason']): Promise<void> {
  const snapshotId = publication.pending_snapshot_id ?? publication.snapshot_id;
  const recorded = await client.query<{ first_seen: boolean }>(`INSERT INTO operational_state(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=operational_state.value||EXCLUDED.value||jsonb_build_object(
      'at',coalesce(operational_state.value->>'at',EXCLUDED.value->>'at'),
      'occurrences',CASE WHEN operational_state.value->>'occurrences' ~ '^[0-9]{1,8}$'
        THEN least((operational_state.value->>'occurrences')::integer+1,99999999) ELSE 2 END),updated_at=now()
    RETURNING (xmax=0) AS first_seen`,
  [`publication_admission:${publication.id}:${snapshotId}:${reason}`, JSON.stringify({
    publicationId: publication.id, snapshotId, operation, reason, at: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(), occurrences: 1,
  })]);
  if (recorded.rows[0]?.first_seen) console.warn('Publication admission denied', {
    publicationId: publication.id, snapshotId, operation, reason,
  });
}

export async function checkPublicationAdmission(publication: Publication, settings: AppSettings,
  operation: Operation, authorization: DeliveryAuthorization = {}): Promise<PublicationAdmission> {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const admission = await publicationAdmission(client, publication, settings, operation, authorization);
    if (!admission.allowed) await recordAdmissionDenial(client, publication, operation, admission.reason);
    return admission;
  });
}
