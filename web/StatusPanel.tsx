import { useState } from 'react';
import type { Operation, OperationKind, Status } from './api';
import { batchStatusLabel, failedStageContext } from '../src/http/status-labels.js';
import { RunNowPanel, RunNowResult, type RunAction } from './RunNowPanel';
import { ReliabilityDiagnostics } from './ReliabilityDiagnostics';

export const operationLabels: Record<OperationKind, string> = {
  test_jev: 'JEV test', test_embedding: 'Embedding test', test_pi: 'Pi test',
  run_now: 'Collect & publish now', collection: 'Collect and process now', digest: 'Refresh & publish digest now', cleanup: 'Clean up history now', refresh_sources: 'Refresh subscriptions',
};
const date = (value: string) => new Date(value).toLocaleString();
const tone = (status: string) => ['failed', 'completed_with_errors'].includes(status) ? 'warning' :
  ['completed', 'succeeded'].includes(status) ? 'success' : ['waiting', 'running', 'processing', 'queued', 'collecting'].includes(status) ? 'accent' : '';
const batchLabel = (batch: Status['batches'][number]) => {
  const label = batchStatusLabel(batch.status, batch.error_code, batch.item_counts.failed);
  return (batch.source_counts?.failed ?? 0) > 0 && !label.includes('source coverage')
    ? `${label} · Incomplete source coverage` : label;
};
interface Props { status: Status | null; operations: Operation[]; run: RunAction; busy: boolean }
export function StatusPanel({ status, operations, run, busy }: Props) {
  const [filter, setFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const active = (kind: OperationKind) => operations.some(operation => operation.kind === kind && ['queued', 'running', 'waiting'].includes(operation.status));
  const filtered = operations.filter(operation => (filter === 'all' || operation.status === filter) && (kindFilter === 'all' || operation.kind === kindFilter));
  const newest = status?.batches[0];
  return <>
    <div className="metrics" aria-label="Processing summary">
      <div className="metric"><span>Latest recorded batch</span><strong>{newest ? batchLabel(newest) : status ? 'No batches' : 'Not loaded'}</strong>
        <small>{newest ? date(newest.started_at) : 'Collection & processing'}</small></div>
      <div className="metric"><span>Completed items</span><strong>{newest?.item_counts.completed ?? '—'}</strong><small>In the latest batch</small></div>
      <div className="metric"><span>Pending items</span><strong>{newest?.item_counts.pending ?? '—'}</strong><small>In the latest batch</small></div>
      <div className="metric"><span>Recorded pending operations</span><strong>{operations.filter(operation => ['queued', 'running', 'waiting'].includes(operation.status)).length}</strong><small>Queued, running or waiting records, not runtime permission</small></div>
    </div>
    <RunNowPanel operations={operations} busy={busy} run={run} />
    <section><div className="section-heading"><div><h2>Pipeline controls</h2><p>Manual runs use saved settings. Publication can send real messages.</p></div><span className="badge">Manual actions</span></div>
      <div className="actions">{(['collection', 'digest', 'cleanup'] as const).map(kind =>
        <button key={kind} className={kind === 'collection' ? '' : 'secondary'} type="button" disabled={busy || active(kind)} onClick={() => run(kind)}>
          {active(kind) ? `${operationLabels[kind]} · pending` : operationLabels[kind]}</button>)}</div>
    </section>
    <section><h2>Recorded batches</h2>
      {!status ? <p className="empty-state">Waiting for processing status.</p> : status.batches.length === 0 ? <p className="empty-state">No collection batches have been recorded.</p> :
        <ul className="record-list">{status.batches.map(batch => <li key={batch.id}>
          <div className="record-heading"><time dateTime={batch.started_at}>{date(batch.started_at)}</time>
            <span className={`badge ${batch.item_counts.failed > 0 || (batch.source_counts?.failed ?? 0) > 0 ? 'warning' : tone(batch.status)}`}>{batchLabel(batch)}</span></div>
          <p>{batch.item_counts.total} total · {batch.item_counts.completed} completed · {batch.item_counts.rejected} rejected · {batch.item_counts.failed} withheld · {batch.item_counts.pending} pending</p>
          {batch.item_counts.total > 0 && <progress aria-label={`Finished items for batch ${batch.id}`} max={batch.item_counts.total}
            value={batch.item_counts.completed + batch.item_counts.rejected + batch.item_counts.failed} />}
          {batch.source_counts && <p className={batch.source_counts.failed > 0 ? 'warning-text' : undefined}>
            Sources: {batch.source_counts.total} total · {batch.source_counts.completed} completed · {batch.source_counts.failed} failed · {batch.source_counts.pending} pending
          </p>}
          {(batch.source_failures?.length ?? 0) > 0 && <ul className="source-failures">{batch.source_failures?.map(failure =>
            <li key={failure.sourceId}><span className="record-id">Source {failure.sourceId}</span> · {failure.code ?? 'failure code not recorded'}</li>)}</ul>}
          {batch.waiting_reason && <p>{batch.waiting_reason}</p>}
          {batch.next_retry_at && <p>Next retry {date(batch.next_retry_at)}</p>}
          {batch.error_code && <p className="warning-text">{batch.error_code}</p>}
        </li>)}</ul>}
    </section>
    {status && <>
      <ReliabilityDiagnostics status={status} />
      {status.waits.some(wait => wait.status !== 'failed') && <section><h2>Pending stages & waits</h2><ul className="record-list">
        {status.waits.filter(wait => wait.status !== 'failed').map((wait, index) => <li key={index}>
          <div className="record-heading"><strong>{wait.stage}</strong><span className={`badge ${tone(wait.status)}`}>{wait.status}</span></div>
          <p>{wait.count} items. {wait.waiting_reason ?? wait.error_code}</p>
          {wait.next_retry_at && <p>Retry {date(wait.next_retry_at)}</p>}<small>Batch {wait.batch_id} · {wait.batch_status}</small>
        </li>)}</ul></section>}
      {status.waits.some(wait => wait.status === 'failed') && <details><summary>Failed stage records, retained for audit</summary>
        <ul className="record-list">{status.waits.filter(wait => wait.status === 'failed').map((wait, index) => <li key={index}>
          <strong>{wait.stage}</strong><p>{wait.count} failed items. {wait.error_code} {failedStageContext(wait.batch_status, wait.batch_completed_at, wait.batch_error_code)}</p>
          <small>Batch {wait.batch_id}</small>
        </li>)}</ul></details>}
      <section><h2>Ready publication queue</h2><p>Accepted stories wait for digest selection. Maintenance resumes only previously authorized delivery and edits. New sends and edits pause when publishing is disabled.</p>
        {(status.readyPublications ?? []).length === 0 ? <p>No recorded ready events.</p> : <ul className="record-list">{status.readyPublications?.map((entry, index) =>
          <li key={index}><strong>{entry.status === 'manual' ? 'Manual scope protected' : entry.status === 'prepared' ? 'Handed to delivery' : entry.status}</strong> · {entry.count}
            {entry.reason && <p>{entry.reason.replaceAll('_', ' ')}</p>}</li>)}</ul>}
      </section>
      <section><h2>Corpus & publications</h2>
        {status.embeddings.length === 0 ? <p>No embedding configurations yet.</p> : <ul className="record-list">{status.embeddings.map((embedding, index) => <li key={index}>
          <div className="record-heading"><strong>{embedding.model}</strong><span className="badge">{embedding.status}</span></div>
          <p>{embedding.dimensions} dimensions · {embedding.input_version}</p></li>)}</ul>}
        <p>Publications: {status.publications.map(publication => `${publication.status} ${publication.count}`).join(', ') || 'none'}</p>
      </section>
    </>}
    <section><div className="section-heading"><div><h2>Recorded operations & connection tests</h2><p>Saved statuses and retry details. These records do not indicate that runtime work is enabled.</p></div></div>
      <div className="filters"><label htmlFor="operation-status">Status<select id="operation-status" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All statuses</option>{['queued', 'running', 'waiting', 'succeeded', 'completed_with_errors', 'failed'].map(value =>
          <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
      </select></label><label htmlFor="operation-kind">Action<select id="operation-kind" value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
        <option value="all">All actions</option>{Object.entries(operationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label></div>
      {filtered.length === 0 ? <p className="empty-state">{operations.length === 0 ? 'No operations yet.' : 'No operations match these filters.'}</p> :
        <ul className="record-list operations">{filtered.map(operation => <li key={operation.id}>
          <div className="record-heading"><strong>{operationLabels[operation.kind]}</strong><span className={`badge ${tone(operation.status)}`}>
            {operation.status === 'failed' ? 'Recorded failed attempt' : operation.status.replaceAll('_', ' ')}</span></div>
          <p>{operation.message}</p><RunNowResult operation={operation} /><small>Started {date(operation.createdAt)}</small>
          {operation.batchId && <p className="record-id">Batch {operation.batchId}</p>}
          {operation.nextRetryAt && <p>Next retry {date(operation.nextRetryAt)} · Attempt {operation.attempt}</p>}
          {operation.failure && <p className="warning-text">{operation.failure.kind} · Outcome {operation.failure.outcome}</p>}
        </li>)}</ul>}
    </section>
  </>;
}
