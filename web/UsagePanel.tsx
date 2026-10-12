import { useEffect, useState, type FormEvent } from 'react';
import { usePolledResource } from './use-polled-resource';
import { usageSchema, usageCallsSchema, emptyUsageFilters, usageQuery, usagePageSize, formatCount, formatCost, formatKnownTokens, tokenAccountingNote,
  type Usage, type UsageFilters } from './usage';
import { UsageGroups, UsageHistory, UsageCallRows } from './UsageTables';

export function UsagePanel({ active }: { active: boolean }) {
  const [draft, setDraft] = useState<UsageFilters>({ ...emptyUsageFilters });
  const [filters, setFilters] = useState<UsageFilters>({ ...emptyUsageFilters });
  const [offset, setOffset] = useState(0);
  const summary = usePolledResource(`/usage?${usageQuery(filters)}`, usageSchema, active,
    'Could not load usage totals. The server may not have usage accounting enabled. Last loaded totals, if any, remain visible.');
  const history = usePolledResource(`/usage/calls?${usageQuery(filters, offset)}`, usageCallsSchema, active,
    'Could not load model call history. Last loaded calls, if any, remain visible.');
  const usage = summary.data;
  const calls = history.data;
  const [filterError, setFilterError] = useState('');
  const [options, setOptions] = useState<Usage['options']>({ models: [], providers: [], stages: [] });
  useEffect(() => { if (usage) setOptions(usage.options); }, [usage]);
  const update = <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const apply = (next: UsageFilters) => {
    try { usageQuery(next); }
    catch (error) { setFilterError(error instanceof Error ? error.message : 'Check the date range.'); return; }
    setFilterError(''); setOffset(0); setFilters({ ...next });
  };
  const submit = (event: FormEvent) => { event.preventDefault(); apply(draft); };
  const selectFilter = (key: 'model' | 'provider' | 'stage', label: string, values: string[]) => <label htmlFor={`usage-${key}`}>{label}
    <select id={`usage-${key}`} value={draft[key]} onChange={event => update(key, event.target.value)}>
      <option value="">All {label.toLowerCase()}s</option>{values.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>;
  const totals = usage?.totals;
  const page = (next: number) => setOffset(next);
  const changed = JSON.stringify(draft) !== JSON.stringify(filters);
  return <>
    <section><div className="section-heading"><div><h2>Filter usage</h2><p>Dates use your local time. Time-series buckets use UTC.</p></div>
      <button type="button" className="secondary" disabled={summary.loading && history.loading} onClick={() => { summary.refresh(); history.refresh(); }}>
        {summary.loading && history.loading ? 'Loading...' : 'Refresh usage'}</button></div>
      <form onSubmit={submit} aria-label="Usage filters">
        <div className="filters"><label htmlFor="usage-from">From, inclusive<input id="usage-from" type="datetime-local" value={draft.from}
          onChange={event => update('from', event.target.value)} /></label>
          <label htmlFor="usage-to">To, exclusive<input id="usage-to" type="datetime-local" value={draft.to} onChange={event => update('to', event.target.value)} /></label>
          <label htmlFor="usage-bucket">Time grouping<select id="usage-bucket" value={draft.bucket} onChange={event => update('bucket', event.target.value === 'hour' ? 'hour' : 'day')}>
            <option value="day">Daily</option><option value="hour">Hourly</option></select></label></div>
        <div className="filters">{selectFilter('model', 'Model', options.models)}{selectFilter('provider', 'Provider', options.providers)}{selectFilter('stage', 'Stage', options.stages)}</div>
        {filterError && <p role="alert" className="error">{filterError} Filters were not applied.</p>}
        <div className="actions"><button type="submit">Apply filters</button><button type="button" className="secondary" onClick={() => {
          const next = { ...emptyUsageFilters }; setDraft(next); apply(next);
        }}>Reset filters</button>{changed && <span className="field-hint">Filter changes have not been applied.</span>}</div>
      </form>
    </section>
    <div role="status" className="usage-loading">
      {summary.loading && 'Loading usage totals. '}{history.loading && 'Loading call history. '}
      Each endpoint refreshes 30 seconds after its request finishes while this tab is open. Existing results remain visible during refresh.
    </div>
    {summary.error && <p role="alert" className="error">{summary.error}</p>}
    <p className="inline-note">{usage ? <>Accounting began {new Date(usage.accountingStartedAt).toLocaleString()}. </> : 'Only calls recorded after accounting began are included. '}
      Earlier usage is unavailable. Totals cover the applied filters, not lifetime usage.</p>
    <div className="metrics" aria-label="Usage summary">
      <div className="metric"><span>Dispatched calls</span><strong>{totals ? formatCount(totals.calls) : 'Not loaded'}</strong>
        <small>{totals ? `${formatCount(totals.completedCalls)} completed · ${formatCount(totals.calls - totals.completedCalls)} failed` : 'In the applied filter range'}</small></div>
      <div className="metric"><span>Known tokens</span><strong>{totals ? formatKnownTokens(totals.totalTokens, totals) : 'Not loaded'}</strong>
        <small>{totals ? `${formatCount(totals.calls - totals.unknownUsageCalls)} of ${formatCount(totals.calls)} calls report usage` : 'Unknown usage is not counted'}</small></div>
      <div className="metric"><span>Estimated cost, USD</span><strong>{totals ? formatCost(totals.estimatedCost?.total ?? null) : 'Not loaded'}</strong>
        <small>{totals ? `${formatCount(totals.estimatedCostCalls)} of ${formatCount(totals.calls)} calls have estimates` : 'SDK catalog estimates only'}</small></div>
      <div className="metric"><span>Actual billed cost, USD</span><strong>{totals ? formatCost(totals.actualBilledCost) : 'Not loaded'}</strong>
        <small>{totals ? `${formatCount(totals.actualBilledCostCalls)} of ${formatCount(totals.calls)} calls report billed cost` : 'Only provider-reported amounts'}</small></div>
    </div>
    <p className="accounting-note">Estimates are not bills, especially for Codex OAuth. Missing cost information does not mean free usage.
      {' '}Token sums include only known usage. App-cache hits and preflight failures are not counted. Estimated and billed amounts can cover different calls.</p>
    {totals && <section><h2>Reported tokens & estimated costs</h2><p>{tokenAccountingNote}</p><div className="token-breakdown">
      {([
        ['Uncached input', totals.inputTokens, totals.estimatedCost?.input ?? null],
        ['Output', totals.outputTokens, totals.estimatedCost?.output ?? null],
        ['Cache read', totals.cacheReadTokens, totals.estimatedCost?.cacheRead ?? null],
        ['Cache write', totals.cacheWriteTokens, totals.estimatedCost?.cacheWrite ?? null],
      ] as const).map(([label, tokens, cost]) => <div key={label}><span>{label}</span><strong>{formatKnownTokens(tokens, totals)}</strong><small>{formatCost(cost)} estimated</small></div>)}
    </div><p>{formatCount(totals.unknownUsageCalls)} calls have unknown usage. Estimated costs cover {formatCount(totals.estimatedCostCalls)} of {formatCount(totals.calls)} calls.</p></section>}
    {usage && <><UsageHistory series={usage.series} bucket={filters.bucket} truncated={usage.seriesTruncated} /><UsageGroups groups={usage.groups} /></>}
    <section><div className="section-heading"><h2>Model call history</h2>{calls && <span className="badge">{formatCount(calls.total)} calls</span>}</div>
      {history.error && <p role="alert" className="error">{history.error}</p>}
      {!calls ? <p className="empty-state">{history.loading ? 'Loading call history...' : 'Call history is not available.'}</p> :
        calls.calls.length === 0 ? <p className="empty-state">No calls on this page. Try the previous page or broaden your filters.</p> : <UsageCallRows calls={calls.calls} />}
      <div className="pagination"><button className="secondary" type="button" disabled={history.loading || offset === 0} onClick={() => page(Math.max(0, offset - usagePageSize))}>Previous</button>
        <span>{calls && calls.calls.length > 0 ? `${calls.offset + 1} to ${calls.offset + calls.calls.length} of ${formatCount(calls.total)}` : `Page ${Math.floor(offset / usagePageSize) + 1}`}</span>
        <button className="secondary" type="button" disabled={history.loading || !calls || offset + calls.calls.length >= calls.total} onClick={() => page(offset + usagePageSize)}>Next</button></div>
    </section>
  </>;
}
