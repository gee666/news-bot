import { useState } from 'react';
import type { Operation, OperationKind } from './api';
import { runNowOptionsSchema, type RunNowOptions } from '../src/pipeline/run-now-contract.js';

export type RunAction = (kind: OperationKind, options?: RunNowOptions) => void;
const fields = [
  ['publicationLimit', 'New posts', 10], ['sourceLimit', 'Sources', 10],
  ['inputLimit', 'Input entries', 50], ['storyLimit', 'Stories to prepare', 10],
] as const;
export function RunNowPanel({ operations, busy, run }: { operations: Operation[]; busy: boolean; run: RunAction }) {
  const [options, setOptions] = useState(() => runNowOptionsSchema.parse({}));
  const active = operations.some(operation => operation.kind === 'run_now' && ['queued', 'running', 'waiting'].includes(operation.status));
  return <section className="run-now"><div className="section-heading"><div><h2>Collect & publish now</h2>
    <p>A small run using saved settings. Each accepted story can publish as soon as it is ready, within this run's cap.</p></div><span className="badge accent">Bounded run</span></div>
    <form onSubmit={event => { event.preventDefault(); if (!busy && !active) run('run_now', runNowOptionsSchema.parse(options)); }}>
      <fieldset disabled={busy || active} className="settings-fields">
        <div className="filters"><label htmlFor="run-now-mode">Input<select id="run-now-mode" value={options.mode}
          onChange={event => setOptions(previous => ({ ...previous, mode: event.target.value === 'collected' ? 'collected' : 'collect' }))}>
          <option value="collect">Collect a small sample</option><option value="collected">Use fresh collected inputs only</option>
        </select></label>{fields.map(([key, label, max]) => <label key={key} htmlFor={`run-now-${key}`}>{label}
          <input id={`run-now-${key}`} type="number" min="1" max={max} required value={options[key]}
            onChange={event => setOptions(previous => ({ ...previous, [key]: event.target.valueAsNumber }))} />
        </label>)}</div>
        <p className="warning-text">This can send real Telegram messages. Existing posts may be updated separately. Publication must be enabled and the bot verified.</p>
        <p>Input entries are a total fetch budget, split across selected sources, not a promise of new articles. Repeated content does not count as a new revision. Telegram takes the newest entries; publisher collection keeps its normal unseen-first order. Omitted entries stay available to normal collection.</p>
        <p>Collected-only mode takes fresh pending revisions that have never started processing. It does not retry failed items, replay old stories, release legacy holds, or bypass provider cooldowns. Research can still take several minutes.</p>
        <button type="submit" disabled={busy || active}>{active ? 'Collect & publish now · pending' : 'Collect & publish now'}</button>
      </fieldset>
    </form>
  </section>;
}

export function RunNowResult({ operation }: { operation: Operation }) {
  const progress = operation.runNow;
  if (!progress) return null;
  return <div className="run-now-result" aria-live="polite">
    <p><strong>Stage: {progress.stage}</strong> · {progress.options.mode === 'collected' ? 'Collected inputs' : 'Small collection'} · New post limit {progress.options.publicationLimit}</p>
    <ol className="run-stages" aria-label="Manual run stages">{['collecting', 'processing', 'publishing', 'finished'].map(stage =>
      <li key={stage} className={stage === progress.stage ? 'accent' : ''} aria-current={stage === progress.stage ? 'step' : undefined}>{stage}</li>)}</ol>
    <p>{progress.sources} sources selected · {progress.inputs} new revisions · {progress.processed} completed inputs · {progress.rejected} rejected · {progress.failed} failed</p>
    <p>{progress.stories} selected stories · {progress.published} new posts · {progress.updated} existing posts updated</p>
    {Object.keys(progress.reasons).length > 0 && <ul aria-label="Withheld and waiting reasons">{Object.entries(progress.reasons).map(([reason, count]) =>
      <li key={reason}>{reason.replaceAll('_', ' ')}: {count}</li>)}</ul>}
    <small>Limits apply to this run only. Rejected inputs, withheld stories and delivery reasons are separate counts and may overlap.</small>
  </div>;
}
