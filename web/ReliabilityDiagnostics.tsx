import type { Status } from './api';

const date = (value: string) => new Date(value).toLocaleString();
const label = (value: string) => value.replaceAll('_', ' ');
function RecordedTime({ value }: { value: string }) {
  return <time dateTime={value}>{date(value)}</time>;
}

/** Read-only journal views. Recorded phases do not establish live worker state or replay permission. */
export function ReliabilityDiagnostics({ status }: { status: Status }) {
  const unresolved = status.aggregateSelections?.filter(entry => entry.status === 'unresolved') ?? [];
  const resolved = status.aggregateSelections?.filter(entry => entry.status === 'resolved') ?? [];
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
    {status.digestRecovery !== undefined && <section aria-labelledby="digest-recovery-heading">
      <h2 id="digest-recovery-heading">Recorded digest recovery</h2>
      <p>Saved recovery state does not prove a worker is running.</p>
      {!status.digestRecovery ? <p>No recorded digest recovery state.</p> : <>
        <p>Recorded phase: <strong>{status.digestRecovery.phase}</strong></p>
        {status.digestRecovery.failure_phase && <p>Failure phase: {label(status.digestRecovery.failure_phase)}</p>}
        {status.digestRecovery.code && <p className="warning-text">{status.digestRecovery.code}</p>}
        {status.digestRecovery.next_retry_at && <p>Recorded retry <RecordedTime value={status.digestRecovery.next_retry_at} /></p>}
      </>}
    </section>}
    {status.aggregateSelections !== undefined && <section aria-labelledby="aggregate-selections-heading">
      <h2 id="aggregate-selections-heading">Unresolved aggregate selections</h2>
      <p>{unresolved.length} unresolved records. Failed comparisons and source-link decisions retry automatically. They do not withhold healthy stories.</p>
      {unresolved.length === 0 ? <p>No unresolved selection records.</p> : <ul className="record-list">{unresolved.map(entry => <li key={entry.key}>
        <div className="record-heading"><strong>{entry.phase ? `Source link ${label(entry.phase)}` : 'Consolidation comparison'}</strong>
          <span className="badge warning">Recorded unresolved</span></div>
        {entry.story_id && <p className="record-id">Story {entry.story_id}</p>}
        {entry.left_id && <p className="record-id">Left story {entry.left_id}</p>}
        {entry.right_id && <p className="record-id">Right story {entry.right_id}</p>}
        <p>Updated <RecordedTime value={entry.updated_at} /></p><small className="record-id">Record {entry.key}</small>
      </li>)}</ul>}
      {resolved.length > 0 && <details><summary>{resolved.length} resolved selection records, retained for audit</summary>
        <ul className="record-list">{resolved.map(entry => <li key={entry.key}>
          <p className="record-id">Record {entry.key}</p><p>Resolved record updated <RecordedTime value={entry.updated_at} /></p>
        </li>)}</ul></details>}
    </section>}
  </div>;
}
