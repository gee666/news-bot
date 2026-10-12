import { useState } from 'react';
import { z } from 'zod';
import { request, type Source } from './api';

interface Props {
  sources: Source[];
  loadError: string;
  busy: boolean;
  refreshing: boolean;
  run(): void;
  action(work: () => Promise<void>): Promise<void>;
  refresh(): Promise<void>;
}
export function TelegramSources({ sources, loadError, busy, refreshing, run, action, refresh }: Props) {
  const [query, setQuery] = useState('');
  const filtered = sources.filter(source => `${source.name} ${source.externalId}`.toLowerCase().includes(query.toLowerCase()));
  return <section><div className="section-heading"><div><h2>Telegram channels</h2><p>{sources.filter(source => source.enabled && source.active).length} active channels enabled</p></div>
    <button type="button" disabled={busy || refreshing} onClick={run}>{refreshing ? 'Subscription refresh pending...' : 'Refresh subscriptions'}</button></div>
    {loadError && <p role="alert" className="error">{loadError}</p>}
    <p>Refresh preserves disabled sources. Departed channels remain listed as inactive.</p>
    {sources.length > 0 && <label className="filter-search" htmlFor="channel-search">Find a channel<input id="channel-search" type="search"
      placeholder="Name or channel ID" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    {sources.length === 0 ? <p className="empty-state">No channels discovered. Complete Telegram login in the terminal, then refresh subscriptions.</p> :
      filtered.length === 0 ? <p className="empty-state">No channels match this search.</p> :
      <ul className="sources">{filtered.map(source => <li key={source.id}><div>
        <label className="checkbox"><input type="checkbox" checked={source.enabled} disabled={busy} onChange={event => {
          const enabled = event.target.checked;
          void action(async () => {
            await request(`/sources/${source.id}`, z.object({ id: z.uuid(), enabled: z.boolean() }), { enabled }, 'PATCH');
            await refresh();
          });
        }} />{source.name}</label><span>{source.externalId} · {source.access}</span></div>
        <span className={`badge ${source.active ? 'success' : ''}`}>{source.active ? 'Active' : 'Inactive'}</span></li>)}</ul>}
  </section>;
}
