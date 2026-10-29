import type { Status } from './api';

const date = (value: string) => new Date(value).toLocaleString();
const label = (value: string) => value.replaceAll('_', ' ');
function RecordedTime({ value }: { value: string }) {
  return <time dateTime={value}>{date(value)}</time>;
}

/** Read-only journal views. Recorded phases do not establish live worker state or replay permission. */
export function ReliabilityDiagnostics({ status }: { status: Status }) {
  return <div className="reliability-diagnostics" aria-label="Recorded reliability diagnostics">
    {status.publicationAdmissionDenials !== undefined && <section aria-labelledby="admission-denials-heading">
      <h2 id="admission-denials-heading">Recorded publication admission denials</h2>
      <p>Historical observations, not necessarily active blocks. A later successful delivery does not erase these records. Up to 100 recent records are shown.</p>
      {status.publicationAdmissionDenials.length === 0 ? <p>No recorded admission denials.</p> :
        <ul className="record-list">{status.publicationAdmissionDenials.map((entry, index) => <li key={index}>
          <div className="record-heading"><strong>{label(entry.reason)}</strong><span className="badge">Historical denial</span></div>
          <p>Operation: {entry.operation ?? 'not recorded'} · Observations: {entry.occurrences}</p>
          <p>Last seen <RecordedTime value={entry.lastSeenAt} /></p>
          <p className="record-id">Publication {entry.publicationId}</p><p className="record-id">Snapshot {entry.snapshotId}</p>
        </li>)}</ul>}
    </section>}
    {status.publicationMaintenance && <section aria-labelledby="publication-maintenance-heading">
      <h2 id="publication-maintenance-heading">Publication maintenance</h2>
      <p>Recorded phase: <strong>{status.publicationMaintenance.phase}</strong>. Failed attempts: {status.publicationMaintenance.attempts}.</p>
      {status.publicationMaintenance.phase === 'failed' ? <p className="warning-text">Maintenance stopped after its retry limit. Restart the service to resume this worker. Scheduled and manual digest publishing remain available.</p>
        : status.publicationMaintenance.next_retry_at && <p>Recorded retry <RecordedTime value={status.publicationMaintenance.next_retry_at} /></p>}
    </section>}
    {status.digestRecovery !== undefined && <section aria-labelledby="digest-recovery-heading">
      <h2 id="digest-recovery-heading">Recorded digest recovery</h2>
      <p>Saved recovery state does not prove a worker is running.</p>
      {!status.digestRecovery ? <p>No recorded digest recovery state.</p> : <>
        <p>Recorded phase: <strong>{status.digestRecovery.phase}</strong></p>
        {status.digestRecovery.code && <p className="warning-text">{status.digestRecovery.code}</p>}
        {status.digestRecovery.next_retry_at && <p>Recorded retry <RecordedTime value={status.digestRecovery.next_retry_at} /></p>}
      </>}
    </section>}
  </div>;
}
