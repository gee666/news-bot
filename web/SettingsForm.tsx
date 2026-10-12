import type { Settings } from './api';

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type TextKey = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];
interface Props {
  settings: Settings;
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  test: (service: 'jev' | 'embedding' | 'pi') => void;
  testDisabled: boolean;
  group: 'settings' | 'connections';
}

export function SettingsForm({ settings, change, test, testDisabled, group }: Props) {
  const input = (key: TextKey, label: string, type = 'text') => <label htmlFor={key}>{label}<input id={key} type={type}
    value={settings[key]} onChange={event => change(key, event.target.value)} required /></label>;
  const numeric = (key: NumericKey, label: string, min: number, max: number, hint?: string) => <label htmlFor={key}>{label}
    <input id={key} type="number" min={min} max={max} step="1" value={Number.isFinite(settings[key]) ? settings[key] : ''}
      aria-describedby={hint ? `${key}-hint` : undefined} onChange={event => change(key, event.target.valueAsNumber)} required />
    {hint && <span className="field-hint" id={`${key}-hint`}>{hint}</span>}</label>;
  if (group === 'connections') return <>
    <section><div className="section-heading"><div><h2>Scoring model</h2><p>JEV scores and matches incoming news.</p></div><span className="badge">JEV</span></div>
      <div className="grid">{input('jevUrl', 'JEV endpoint URL', 'url')}{input('jevModel', 'JEV model')}</div>
      <button type="button" disabled={testDisabled} onClick={() => test('jev')}>Test JEV connection</button>
    </section>
    <section><h2>Embedding model</h2><p>Search and story matching use this vector configuration.</p>
      <div className="grid">{input('embeddingUrl', 'Embedding endpoint URL', 'url')}{input('embeddingModel', 'Embedding model')}
        {numeric('embeddingDimensions', 'Embedding dimensions', 1, 65535)}{input('embeddingInputVersion', 'Embedding input version')}
        {numeric('embeddingContextTokens', 'Embedding context tokens', 128, 131072)}</div>
      <p>Changed embeddings stay pending until the active corpus has been re-embedded. Vectors from different configurations are never mixed.</p>
      <button type="button" disabled={testDisabled} onClick={() => test('embedding')}>Test embedding connection</button>
    </section>
    <section><h2>Writing model</h2>
      <div className="grid"><label htmlFor="piProvider">Pi provider<select id="piProvider" value={settings.piProvider}
        onChange={event => change('piProvider', event.target.value)}>
        <option value="openai-codex">OpenAI Codex OAuth</option>
        {settings.piProvider !== 'openai-codex' && <option value={settings.piProvider}>{settings.piProvider}, unsupported in V1</option>}
      </select></label><label htmlFor="piModel">Pi model<input id="piModel" list="pi-models" value={settings.piModel} required
        onChange={event => change('piModel', event.target.value)} />
        <datalist id="pi-models"><option value="gpt-6-luna" /></datalist></label></div>
      <button type="button" disabled={testDisabled} onClick={() => test('pi')}>Test Pi connection</button>
      <p>Tests use saved settings and share the pipeline's one-request model limiter. Save changes before testing.</p>
    </section>
  </>;
  return <>
    <section><div className="section-heading"><div><h2>Research & publication</h2><p>Choose which events get web research and which stories can publish.</p></div><span className="badge accent">Scores 1 to 10</span></div>
      <div className="grid">
        {numeric('researchThreshold', 'Research threshold', 1, 10, 'Search for events with a score at or above this value. Default for new installations: 5.')}
        {numeric('minimumPublicationScore', 'Minimum publication score', 1, 10, '1 allows all eligible news. Research and publication thresholds are separate.')}
        {numeric('researchMaxSearches', 'Maximum searches per event', 0, 10, '0 disables web searches. Allowed range: 0 to 10.')}
        {numeric('researchMaxPages', 'Research page limit', 1, 20, 'Maximum pages to read during research. Allowed range: 1 to 20.')}
      </div>
      <p className="inline-note">Current rule: {settings.researchMaxSearches === 0 ? 'web searches are disabled.' :
        `events scoring ${Number.isFinite(settings.researchThreshold) ? settings.researchThreshold : '?'} or higher can use up to ${Number.isFinite(settings.researchMaxSearches) ? settings.researchMaxSearches : '?'} searches.`}</p>
    </section>
    <section><h2>Your interests</h2>
      <label htmlFor="interestProfile">Interest profile<textarea id="interestProfile" rows={6} maxLength={20000} required
        value={settings.interestProfile} onChange={event => change('interestProfile', event.target.value)} /></label>
      <p>Changing the profile marks old scores stale. Accepted current stories wait for the next digest. Old failed and legacy stories stay held unless genuine inputs change.</p>
    </section>
    <section><h2>Schedules & retention</h2>
      <div className="grid">{input('collectionCron', 'Collection cron')}{input('digestCron', 'Digest publishing cron')}
        {input('cleanupCron', 'Cleanup cron')}
        <label htmlFor="timezone">Timezone<input id="timezone" list="timezones" value={settings.timezone} required onChange={event => change('timezone', event.target.value)} />
          <datalist id="timezones"><option value="Europe/Berlin">Berlin, CEST in summer and CET in winter</option><option value="Etc/GMT-2">UTC+02:00, fixed, no daylight saving</option><option value="UTC" /></datalist></label>
        {numeric('retentionDays', 'History retention in days', 1, 365)}</div>
      <p>Recommended collection: 0 5,9,13,17,21 * * * in Europe/Berlin, at 05:00, 09:00, 13:00, 17:00 and 21:00 local time. Berlin follows daylight saving, not a fixed CEST offset.</p>
      <p>Accepted current stories enter a durable queue and wait for digest selection after consolidation and refresh. The default digest cron is 0 */3 * * *, every three hours in the saved timezone. Maintenance checks every five seconds only to resume previously authorized delivery, reconciliation and edits. Collect & publish now can publish within its cap without waiting for the digest.</p>
      <p>{settings.timezone === 'Etc/GMT-2' ? 'UTC+02:00, fixed offset without daylight saving.' : `Timezone: ${settings.timezone}.`}
        {' '}New schedules apply between batches. Published posts and their saved sources survive history cleanup.</p>
      <label className="checkbox"><input type="checkbox" checked={settings.publishingEnabled}
        onChange={event => change('publishingEnabled', event.target.checked)} />Enable publishing</label>
      <p>Disable publishing to pause new sends and edits, including manual runs. Collection and processing continue. Keep publishing disabled until bot send/edit verification succeeds. Startup hold stops all operational work.</p>
    </section>
    <details><summary>Advanced processing settings</summary><div className="grid">
      {numeric('jevTimeoutMs', 'JEV deadline in milliseconds', 1200000, 86400000)}
      {numeric('embeddingTimeoutMs', 'Embedding deadline in milliseconds', 1000, 86400000)}
      {numeric('piTimeoutMs', 'Pi deadline in milliseconds', 1000, 86400000)}
      {numeric('connectionTimeoutMs', 'Connection deadline in milliseconds', 100, 60000)}
      {numeric('collectionWindowHours', 'Collection window in hours', 1, 48)}
      {numeric('matchCandidateLimit', 'Match candidate limit', 1, 100)}
      {numeric('headlineBatchSize', 'Headlines per request', 1, 10)}
      {numeric('requestMaxAttempts', 'Request attempt limit', 1, 20)}
      {numeric('retryBaseMs', 'Retry base delay in milliseconds', 1000, 3600000)}
      {numeric('retryMaxMs', 'Retry maximum delay in milliseconds', 1000, 86400000)}
    </div><label className="checkbox"><input type="checkbox" checked={settings.prefixCacheEnabled}
      onChange={event => change('prefixCacheEnabled', event.target.checked)} />Enable JEV prefix caching</label></details>
  </>;
}
