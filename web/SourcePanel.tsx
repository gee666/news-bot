import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { request } from './api';
import { emptySourceDraft, hackerNewsSourceDraft, primarySourceSchema, sourceDraft, sourceInput,
  type PrimarySource, type PrimarySourceView, type SourceDraft } from './primary-sources';

interface Props {
  sources: PrimarySourceView[];
  loadError: string;
  busy: boolean;
  action(work: () => Promise<void>): Promise<void>;
  refresh(): Promise<void>;
}

function CollectionProgress({ source }: { source: PrimarySource }) {
  const { cursor } = source;
  const failed = cursor.backlog.filter(entry => entry.failures > 0);
  const retry = failed.map(entry => entry.nextAttemptAt).filter(time => time !== null).sort()[0];
  const codes = [...new Set(failed.flatMap(entry => entry.lastErrorCode ? [entry.lastErrorCode] : []))];
  return <>
    <span>Last collection checkpoint: {cursor.cutoff ? new Date(cursor.cutoff).toLocaleString() : 'Not collected yet'}.
      {' '}Checks: {cursor.attemptedIds.length} attempted, {cursor.completedIds.length} completed.
      {' '}Undated: {cursor.unknownIds.length} {cursor.unknownPolicy === null ? 'legacy IDs' : 'collected once'},
      {' '}{cursor.skippedUnknownIds.length} skipped.</span>
    <span>Saved backlog: {cursor.backlog.length}/{source.backlogLimit ?? 200} entries.
      {' '}{failed.length} unresolved reads. Overflow drops: {cursor.backlogOverflow}.</span>
    {failed.length > 0 && <span className="error">{codes.slice(0, 5).join(', ') || 'Reserved or interrupted article read'}.
      {codes.length > 5 && ' More failures are retained in the backlog.'}
      {retry && <> Earliest retry cutoff: {new Date(retry).toLocaleString()}.</>}
      {' '}Retries require a later scheduled cutoff; saved items remain available.</span>}
  </>;
}

export function SourcePanel({ sources, loadError, busy, action, refresh }: Props) {
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const filtered = sources.filter(source => (kind === 'all' || source.kind === kind) &&
    `${source.name} ${source.url ?? ''} ${source.configState === 'valid' ? source.publisher : ''}`.toLowerCase().includes(query.toLowerCase()));
  const identityLocked = sources.some(source => source.id === editingId && source.identityLocked);
  const change = <K extends keyof SourceDraft>(key: K, value: SourceDraft[K]) => {
    setDraft(previous => previous ? { ...previous, [key]: value } : previous);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    void action(async () => {
      await request(editingId ? `/primary-sources/${editingId}` : '/primary-sources', primarySourceSchema,
        sourceInput(draft), editingId ? 'PATCH' : 'POST');
      setDraft(null); setEditingId(null);
      await refresh();
    });
  };
  return <section><h2>Primary sources</h2>
    {loadError && <p role="alert" className="error">{loadError}</p>}
    <p>Feeds and publisher websites use the collection schedule. Unknown publication dates are skipped by default.</p>
    <div className="actions">
      <button type="button" disabled={busy || draft !== null} onClick={() => {
        setEditingId(null); setDraft({ ...emptySourceDraft });
      }}>Add source</button>
      <button type="button" disabled={busy || draft !== null} onClick={() => {
        setEditingId(null); setDraft({ ...hackerNewsSourceDraft });
      }}>Add Hacker News preset</button>
      <button type="button" disabled={busy} onClick={() => { void action(async () => {
        await request('/primary-sources/seed', z.array(primarySourceSchema), {});
        await refresh();
      }); }}>Add recommended sources</button>
    </div>
    <p>Recommended: OpenAI, Anthropic, Google AI, NVIDIA and Hugging Face. Adding them again preserves saved settings and disabled sources.
      The Hacker News preset is a new draft only; review its external-link, undated-article and budget choices before saving.</p>
    {sources.length > 0 && <div className="filters"><label htmlFor="publisher-search">Find a source<input id="publisher-search" type="search"
      placeholder="Name, publisher or URL" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label htmlFor="source-kind">Source type<select id="source-kind" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="all">All types</option><option value="feed">Feeds</option><option value="website">Websites</option></select></label></div>}
    {sources.length === 0 ? <p className="empty-state">No primary sources added.</p> : filtered.length === 0 ? <p className="empty-state">No sources match these filters.</p> :
      <ul className="sources">{filtered.map(source => source.configState === 'invalid' ?
      <li key={source.id}>
        <label className="checkbox"><input type="checkbox" checked={source.enabled} disabled={busy || !source.enabled}
          onChange={() => { void action(async () => {
            await request(`/primary-sources/${source.id}`, primarySourceSchema, { enabled: false }, 'PATCH');
            await refresh();
          }); }} />{source.name}</label>
        <span>{source.kind} · Needs configuration. {source.enabled ? 'Disable this source.' : 'Disabled.'}
          {' '}Add a replacement source; the old source and its history will be preserved.</span>
        {source.url && <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>}
      </li> : <li key={source.id}>
        <label className="checkbox"><input type="checkbox" checked={source.enabled} disabled={busy}
          onChange={event => { const enabled = event.target.checked; void action(async () => {
            await request(`/primary-sources/${source.id}`, primarySourceSchema, { enabled }, 'PATCH');
            await refresh();
          }); }} />{source.name}</label>
        <span>{source.publisher} · {source.kind} · {source.maxArticles} article attempts per cutoff · {source.unknownPublication}
          {' '}· Retry base: {source.retryDelayMinutes ?? 60} minutes
          {source.kind === 'feed' && <> · Feed dates: {source.feedDateRole ?? 'publication'}</>}</span>
        <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
        <CollectionProgress source={source} />
        <button className="secondary" type="button" disabled={busy || draft !== null} aria-label={`Edit ${source.name}`} onClick={() => {
          setEditingId(source.id); setDraft(sourceDraft(source));
        }}>Edit</button>
      </li>)}</ul>}
    {draft && <form onSubmit={save}>
      <h3>{editingId ? 'Edit source' : 'Add source'}</h3>
      {identityLocked && <p>This source has collection history. Kind and URL cannot change.
        Add a replacement source and disable the old one to preserve its history.</p>}
      <fieldset disabled={busy}>
        <div className="grid">
          <label>Kind<select disabled={identityLocked} value={draft.kind} onChange={event => {
            const nextKind = event.target.value === 'feed' ? 'feed' : 'website';
            setDraft(previous => previous ? { ...previous, kind: nextKind,
              articleLinkPolicy: nextKind === 'website' ? 'same_host' : previous.articleLinkPolicy,
              feedDateRole: nextKind === 'website' && previous.feedDateRole === 'submission' ? 'publication' : previous.feedDateRole } : previous);
          }}>
            <option value="feed">Feed</option><option value="website">Website</option>
          </select></label>
          <label>Name<input autoFocus required maxLength={200} value={draft.name} onChange={event => change('name', event.target.value)} /></label>
          <label>Publisher<input required maxLength={200} value={draft.publisher} onChange={event => change('publisher', event.target.value)} /></label>
          <label>URL<input disabled={identityLocked} type="url" required maxLength={4096} value={draft.url} onChange={event => change('url', event.target.value)} /></label>
          <label>Maximum article attempts<input id="source-max-articles" type="number" required min={1} max={50} step={1}
            value={Number.isFinite(draft.maxArticles) ? draft.maxArticles : ''}
            onChange={event => change('maxArticles', event.target.valueAsNumber)} /></label>
          <label>Backlog limit<input id="source-backlog-limit" type="number" min={1} max={1000} step={1} placeholder="Default: 200"
            value={draft.backlogLimit ?? ''} onChange={event => change('backlogLimit', event.target.value === '' ? undefined : event.target.valueAsNumber)} /></label>
          <label>Retry base delay, minutes<input id="source-retry-delay" type="number" min={1} max={720} step={1} placeholder="Default: 60"
            value={draft.retryDelayMinutes ?? ''} onChange={event => change('retryDelayMinutes', event.target.value === '' ? undefined : event.target.valueAsNumber)} /></label>
          <label>Feed date meaning<select id="source-feed-date-role" disabled={draft.kind !== 'feed'} value={draft.feedDateRole ?? 'publication'}
            onChange={event => change('feedDateRole', event.target.value === 'submission' ? 'submission' : 'publication')}>
            <option value="publication">Publisher publication</option><option value="submission">Aggregator submission</option>
          </select></label>
          <label>Article links<select disabled={draft.kind !== 'feed'} value={draft.articleLinkPolicy}
            onChange={event => change('articleLinkPolicy', event.target.value === 'external' ? 'external' : 'same_host')}>
            <option value="same_host">Same host only</option><option value="external">Allow external articles from this feed</option>
          </select></label>
          <label>Unknown publication date<select value={draft.unknownPublication}
            onChange={event => change('unknownPublication', event.target.value === 'skip' ? 'skip' : 'collect_once')}>
            <option value="skip">Skip</option><option value="collect_once">Collect once</option>
          </select></label>
        </div>
        {editingId && <p>Blank backlog or retry fields leave saved settings unchanged.
          Enter 200 and 60 explicitly to restore their defaults.</p>}
        <p>Budgets count failed reads too. Saved discoveries survive feed rotation within the collection window,
          but overflow, expiry and entries missed between polls can still lose coverage. Retry delays double up to 12 hours.
          Submission dates, such as Hacker News timestamps, do not make old articles newly published.
          Collect once keeps undated publication timestamps null. These settings do not change the collection schedule.</p>
        <label>Article path prefixes<textarea required rows={3} value={draft.articlePathPrefixes}
          onChange={event => change('articlePathPrefixes', event.target.value)} /></label>
        <p>One slash-terminated path per line, such as /news/. These prefixes also apply to redirected articles.
          Same host only is the default. Allow external links only for a trusted aggregator feed, such as Hacker News.
          Use / to allow any article path. Private network URLs remain blocked.</p>
        <label className="checkbox"><input type="checkbox" checked={draft.enabled}
          onChange={event => change('enabled', event.target.checked)} />Enabled</label>
        <div className="actions"><button type="submit">Save source</button>
          <button className="secondary" type="button" onClick={() => { setDraft(null); setEditingId(null); }}>Cancel</button></div>
      </fieldset>
    </form>}
  </section>;
}
