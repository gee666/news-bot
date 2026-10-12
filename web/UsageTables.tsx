import { formatCost, formatCount, formatKnownTokens, tokenAccountingNote, type Usage, type UsageCalls } from './usage';

export function UsageGroups({ groups }: { groups: Usage['groups'] }) {
  return <section><h2>Usage by model & stage</h2>
    {groups.length === 0 ? <p className="empty-state">No model calls in this period.</p> :
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Usage by model and stage, horizontally scrollable">
        <table><caption>Only persisted, dispatched calls. Costs cover the calls listed in each cell.</caption>
          <thead><tr><th scope="col">Model / provider</th><th scope="col">Stage</th><th scope="col" className="number">Calls</th>
            <th scope="col" className="number">Known tokens</th><th scope="col" className="number">Estimated USD</th><th scope="col" className="number">Billed USD</th></tr></thead>
          <tbody>{groups.map(group => <tr key={JSON.stringify([group.provider, group.model, group.stage])}>
            <th scope="row">{group.model}<small className="cell-detail">{group.provider}</small></th><td>{group.stage}</td>
            <td className="number">{formatCount(group.totals.calls)}<small className="cell-detail">{formatCount(group.totals.unknownUsageCalls)} unknown usage</small></td>
            <td className="number">{formatKnownTokens(group.totals.totalTokens, group.totals)}</td>
            <td className="number">{formatCost(group.totals.estimatedCost?.total ?? null)}<small className="cell-detail">{formatCount(group.totals.estimatedCostCalls)} of {formatCount(group.totals.calls)} calls</small></td>
            <td className="number">{formatCost(group.totals.actualBilledCost)}<small className="cell-detail">{formatCount(group.totals.actualBilledCostCalls)} of {formatCount(group.totals.calls)} calls</small></td>
          </tr>)}</tbody>
        </table></div>}
  </section>;
}

export function UsageHistory({ series, bucket, truncated }: { series: Usage['series']; bucket: 'hour' | 'day'; truncated: boolean }) {
  const peak = Math.max(1, ...series.map(point => point.totals.totalTokens));
  return <section><h2>Usage over time</h2><p>{bucket === 'day' ? 'Daily' : 'Hourly'} totals in UTC. Empty periods are omitted.</p>
    {truncated && <p role="status" className="inline-note">Showing the latest 1,000 periods. Narrow the date range or choose daily totals for a complete view. Summary totals and model groups still cover the full applied range.</p>}
    {series.length === 0 ? <p className="empty-state">No usage recorded in this period.</p> :
      <div className="table-scroll usage-history" tabIndex={0} role="region" aria-label="Usage over time, scrollable">
        <table><caption>Recorded tokens and cost coverage per UTC period</caption><thead><tr>
          <th scope="col">Period, UTC</th><th scope="col" className="number">Calls</th><th scope="col">Known tokens</th>
          <th scope="col" className="number">Estimated USD</th><th scope="col" className="number">Billed USD</th>
        </tr></thead><tbody>{series.map(point => <tr key={point.timestamp}><th scope="row">
          <time dateTime={point.timestamp}>{point.timestamp.slice(0, bucket === 'day' ? 10 : 16).replace('T', ' ')}</time></th>
          <td className="number">{formatCount(point.totals.calls)}</td><td className="token-bar-cell">{formatKnownTokens(point.totals.totalTokens, point.totals)}
            <div className="token-bar" aria-hidden="true"><span style={{ width: `${point.totals.totalTokens / peak * 100}%` }} /></div>
            <small>{formatCount(point.totals.unknownUsageCalls)} calls with unknown usage</small></td>
          <td className="number">{formatCost(point.totals.estimatedCost?.total ?? null)}<small className="cell-detail">{point.totals.estimatedCostCalls} of {point.totals.calls} calls</small></td>
          <td className="number">{formatCost(point.totals.actualBilledCost)}<small className="cell-detail">{point.totals.actualBilledCostCalls} of {point.totals.calls} calls</small></td>
        </tr>)}</tbody></table></div>}
  </section>;
}

export function UsageCallRows({ calls }: { calls: UsageCalls['calls'] }) {
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="Model call history, horizontally scrollable">
    <table><caption>Newest calls first. Unavailable means the provider did not report usage or cost. {tokenAccountingNote}</caption>
      <thead><tr><th scope="col">Time / model</th><th scope="col">Stage / outcome</th><th scope="col" className="number">Tokens</th>
        <th scope="col" className="number">Estimated USD</th><th scope="col" className="number">Billed USD</th><th scope="col" className="number">Duration</th></tr></thead>
      <tbody>{calls.map(call => <tr key={call.id}><th scope="row"><time dateTime={call.timestamp}>{new Date(call.timestamp).toLocaleString()}</time>
        <small className="cell-detail">{call.model} · {call.provider}</small></th>
        <td>{call.stage}<small className="cell-detail"><span className={`badge ${call.outcome === 'failed' ? 'warning' : 'success'}`}>{call.outcome}</span> · Attempt {call.attempt}</small>
          {call.operationId && <details className="call-details"><summary>Operation ID</summary><small>{call.operationId}</small></details>}</td>
        <td className="number">{formatCount(call.totalTokens)}<small className="cell-detail">Uncached input {formatCount(call.inputTokens)} · Output {formatCount(call.outputTokens)}</small>
          <small className="cell-detail">Cache read {formatCount(call.cacheReadTokens)} · Write {formatCount(call.cacheWriteTokens)}</small>
          {!call.usageKnown && <small className="cell-detail">Usage unknown</small>}</td>
        <td className="number">{formatCost(call.estimatedCost?.total ?? null)}</td><td className="number">{formatCost(call.actualBilledCost)}</td>
        <td className="number">{formatCount(Math.round(call.durationMs))} ms</td>
      </tr>)}</tbody></table>
  </div>;
}
