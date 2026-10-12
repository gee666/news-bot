import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { connect, request, settingsSchema, sourceSchema, loginSchema, operationSchema, statusSchema, runtimeSchema,
  type Settings, type Source, type Login, type Operation, type OperationKind, type Status } from './api';
import { SourcePanel } from './SourcePanel';
import { applyPanelResult } from './panel-refresh';
import { primarySourceSchema, type PrimarySourceView } from './primary-sources';
import { SettingsForm } from './SettingsForm';
import { StatusPanel, operationLabels } from './StatusPanel';
import { LoginPanel } from './LoginPanel';
import { TelegramSources } from './TelegramSources';
import { Tabs, tabs, type Tab } from './Tabs';
import { UsagePanel } from './UsagePanel';
import { usePolledResource } from './use-polled-resource';
import { runtimeAccess, RuntimeNotice } from './runtime';
import type { RunNowOptions } from '../src/pipeline/run-now-contract.js';

const pageCopy: Record<Tab, { title: string; description: string }> = {
  activity: { title: 'Activity', description: 'Inspect recorded processing, retries and manual actions.' },
  usage: { title: 'Usage & costs', description: 'Track model requests, token usage and recorded costs.' },
  sources: { title: 'News sources', description: 'Choose the channels, feeds and publishers to collect.' },
  settings: { title: 'Settings', description: 'Research limits, your interests and the publishing schedule.' },
  connections: { title: 'Connections', description: 'Configure models, check access and manage your Pi login.' },
};
export function App() {
  const [tab, setTab] = useState<Tab>('activity');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [primarySources, setPrimarySources] = useState<PrimarySourceView[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [login, setLogin] = useState<Login | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const runtime = usePolledResource('/runtime', runtimeSchema, true, 'Could not verify runtime permissions.', 3000);
  const access = runtimeAccess(runtime.data, runtime.error);
  const [busy, setBusy] = useState(false);
  const mutationDisabled = busy || access.mutationsBlocked;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const [loadErrors, setLoadErrors] = useState({ sources: '', primarySources: '', login: '', operations: '', status: '' });
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const refresh = useCallback(async () => {
    const [nextSources, nextLogin, nextOperations, nextStatus, nextPrimarySources] = await Promise.allSettled([
      request('/sources', z.array(sourceSchema)), request('/pi/login', loginSchema),
      request('/operations', z.array(operationSchema)), request('/status', statusSchema),
      request('/primary-sources', z.array(primarySourceSchema)),
    ]);
    setLoadErrors({
      sources: applyPanelResult(nextSources, setSources, 'Telegram sources'),
      primarySources: applyPanelResult(nextPrimarySources, setPrimarySources, 'primary sources'),
      login: applyPanelResult(nextLogin, setLogin, 'Pi login'),
      operations: applyPanelResult(nextOperations, setOperations, 'operations'),
      status: applyPanelResult(nextStatus, setStatus, 'status'),
    });
  }, []);
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const initialize = async () => {
      await connect();
      await Promise.allSettled([
        request('/settings', settingsSchema).then(initial => {
          if (!disposed) { setSettings(initial); setSaved(initial); }
        }).catch(() => { if (!disposed) setError('Could not load settings. Check server availability and reload.'); }),
        refresh(),
      ]);
    };
    void initialize().catch(() => { if (!disposed) setError('Could not connect. Check server availability and reload.'); });
    const timer = setInterval(() => {
      if (disposed || refreshing) return;
      refreshing = true;
      void refresh().catch(() => { if (!disposed) setError('Status polling failed. Check the server or reload the page.'); })
        .finally(() => { refreshing = false; });
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { if (error) errorMessage.current?.focus(); }, [error]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Request failed.');
    } finally { setBusy(false); }
  };
  const mutationAction = async (work: () => Promise<void>) => {
    if (access.mutationsBlocked) return;
    await action(async () => {
      await connect();
      await work();
    });
  };
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(previous => previous ? { ...previous, [key]: value } : previous);
    setNotice('');
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!settings || access.mutationsBlocked) return;
    void mutationAction(async () => {
      const parsed = settingsSchema.safeParse(settings);
      if (!parsed.success) throw new Error('Check the values in Settings and Connections. Numbers must be whole and within the displayed limits.');
      if (settings.retryMaxMs < settings.retryBaseMs) throw new Error('Maximum retry delay must be at least the base retry delay.');
      const next = await request('/settings', settingsSchema, parsed.data, 'PUT');
      setSettings(next); setSaved(next);
      setNotice('Settings saved. Changes apply between batches.');
      await refresh();
    });
  };
  const run = (kind: OperationKind, options?: RunNowOptions) => {
    if (access.mutationsBlocked) return;
    if (kind === 'digest' && !window.confirm('Refresh and publish a digest now, without waiting for the schedule? This can use models, select ready stories and edit messages after story refresh succeeds. It does not replay unpublished history.')) return;
    if (kind === 'run_now' && !window.confirm(`Run a bounded collect, process and publish job? Up to ${options?.publicationLimit ?? 5} new Telegram posts can be sent. Existing posts may also be updated. Saved settings apply.`)) return;
    void mutationAction(async () => {
      const operation = await request('/operations', operationSchema, { kind, ...(kind === 'run_now' ? { options } : {}) });
      setOperations(previous => [operation, ...previous.filter(item => item.id !== operation.id)]);
      setNotice(`${operationLabels[kind]} started. You can keep editing while it runs.`);
    });
  };
  return <main>
    <a className="skip-link" href={`#panel-${tab}`}>Skip to content</a>
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">n</span><div><strong>News bot</strong><span>Private workspace</span></div></div>
      <div className="header-state"><span className={`badge ${access.message ? 'warning' : ''}`}>{access.label}</span>
        <span className="badge">{saved ? saved.publishingEnabled ? 'Publishing setting on' : 'Publishing setting off' : 'Loading settings...'}</span>
        {dirty && <span className="unsaved">Unsaved changes</span>}</div></header>
    <Tabs selected={tab} select={setTab} />
    <RuntimeNotice access={access} />
    <div className="page-heading"><div><h1>{pageCopy[tab].title}</h1><p>{pageCopy[tab].description}</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => { runtime.refresh(); void action(refresh); }}>Refresh status</button></div>
    <div className="feedback" role="status" aria-live="polite">{notice && <p className="notice">{notice}</p>}</div>
    {error && <p ref={errorMessage} tabIndex={-1} role="alert" className="error">{error}</p>}
    {tabs.map(item => <div key={item.id} id={`panel-${item.id}`} role="tabpanel" aria-labelledby={`tab-${item.id}`}
      hidden={tab !== item.id} tabIndex={0}>
      {item.id === 'activity' && <>
        {loadErrors.operations && <p role="alert" className="error">{loadErrors.operations}</p>}
        {loadErrors.status && <p role="alert" className="error">{loadErrors.status}</p>}
        <StatusPanel status={status} operations={operations} run={run} busy={mutationDisabled} />
      </>}
      {item.id === 'usage' && <UsagePanel active={tab === 'usage'} />}
      {item.id === 'sources' && <>
        <TelegramSources sources={sources} loadError={loadErrors.sources} busy={mutationDisabled}
          refreshing={!access.mutationsBlocked && operations.some(operation => operation.kind === 'refresh_sources' && ['queued', 'running', 'waiting'].includes(operation.status))}
          run={() => run('refresh_sources')} action={mutationAction} refresh={refresh} />
        <SourcePanel sources={primarySources} loadError={loadErrors.primarySources} busy={mutationDisabled} action={mutationAction} refresh={refresh} />
      </>}
      {(item.id === 'settings' || item.id === 'connections') && <>
        {!settings ? <section><p>Settings have not loaded yet. If the server is unavailable, reconnect and reload this page.</p>
          <button type="button" className="secondary" onClick={() => window.location.reload()}>Reload workspace</button></section> :
          <form onSubmit={save} onInvalid={event => {
            if (event.target instanceof HTMLElement) { const details = event.target.closest('details'); if (details) details.open = true; }
          }} aria-label={item.id === 'settings' ? 'News settings' : 'Model settings'}>
            <fieldset disabled={mutationDisabled} className="settings-fields">
              <SettingsForm group={item.id} settings={settings} change={change} test={service => run(`test_${service}`)} testDisabled={mutationDisabled || dirty} />
            </fieldset>
            <div className="save"><div><strong>{dirty ? 'You have unsaved changes' : 'Settings are saved'}</strong><span>Settings & connections save together.</span></div>
              <div className="actions"><button className="secondary" type="button" disabled={busy || !dirty} onClick={() => {
                if (window.confirm('Discard all unsaved settings and connection changes?')) { setSettings(saved); setNotice('Changes discarded.'); }
              }}>Discard</button><button type="submit" disabled={mutationDisabled || !dirty}>{busy && !access.mutationsBlocked ? 'Working...' : 'Save settings'}</button></div></div>
          </form>}
        {item.id === 'connections' && <LoginPanel login={login} loadError={loadErrors.login} busy={mutationDisabled} setLogin={setLogin} action={mutationAction} refresh={refresh} />}
      </>}
    </div>)}
    <footer>Private, single-user access. Use localhost or an SSH tunnel. Do not expose this port publicly.</footer>
  </main>;
}
