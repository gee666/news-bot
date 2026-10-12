import { useState } from 'react';
import { z } from 'zod';
import { request, loginSchema, type Login } from './api';

interface Props {
  login: Login | null;
  loadError: string;
  busy: boolean;
  setLogin(login: Login): void;
  action(work: () => Promise<void>): Promise<void>;
  refresh(): Promise<void>;
}
export function LoginPanel({ login, loadError, busy, setLogin, action, refresh }: Props) {
  const [redirectUrl, setRedirectUrl] = useState('');
  const active = login?.login && ['starting', 'awaiting_redirect', 'exchanging'].includes(login.login.phase);
  return <section><div className="section-heading"><h2>Pi login</h2>
    <span className={`badge ${login?.connected ? 'success' : ''}`}>{login ? login.connected ? 'Login stored' : 'Not connected' : 'Not loaded'}</span></div>
    {loadError && <p role="alert" className="error">{loadError}</p>}
    <p>{login?.connected ? 'OpenAI Codex OAuth login is stored. Test Pi to check live access.' : 'Connect OpenAI Codex to use the writing model.'}</p>
    <button type="button" disabled={busy || Boolean(active)} onClick={() => { void action(async () => {
      setLogin(await request('/pi/login', loginSchema, {}));
    }); }}>Log in with OpenAI Codex</button>
    {login?.login && <>
      <p>Login: {login.login.phase}. {login.login.message} Expires {new Date(login.login.expiresAt).toLocaleString()}.</p>
      {login.login.authorizationUrl && <p>{busy ? 'Provider authorization is unavailable while changes are disabled.' :
        <a href={login.login.authorizationUrl} target="_blank" rel="noreferrer">Open provider authorization page</a>}</p>}
      {login.login.phase === 'awaiting_redirect' && <form onSubmit={event => {
        event.preventDefault();
        const id = login.login?.id;
        if (id) void action(async () => {
          setLogin(await request('/pi/redirect', loginSchema, { id, redirectUrl }));
          setRedirectUrl('');
        });
      }}>
        <label htmlFor="redirect-url">Paste complete redirect URL<input id="redirect-url" disabled={busy} type="url" required autoComplete="off" spellCheck={false}
          value={redirectUrl} onChange={event => setRedirectUrl(event.target.value)} aria-describedby="redirect-help" /></label>
        <p id="redirect-help">If the callback cannot reach the container, copy the entire browser redirect URL, including code and state. It is never logged or saved as a setting.</p>
        <button disabled={busy} type="submit">Complete login</button>
      </form>}
      {active && <button className="secondary" type="button" disabled={busy} onClick={() => { const id = login.login?.id;
        if (id) void action(async () => { await request('/pi/cancel', z.null(), { id }); setRedirectUrl(''); await refresh(); });
      }}>Cancel login</button>}
    </>}
  </section>;
}
