import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { BotError } from './bot-api.js';

const mocks = vi.hoisted(() => ({ settings: vi.fn(), resume: vi.fn(), expire: vi.fn(), save: vi.fn(), query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../settings.js', async original => ({ ...await original<typeof import('../settings.js')>(), getSettings: mocks.settings }));
vi.mock('./digest.js', () => ({ resumePublications: mocks.resume }));
vi.mock('./media-plan.js', () => ({ expirePublicationMedia: mocks.expire }));
vi.mock('./store.js', () => ({ saveState: mocks.save }));
import { startPublicationMaintenance } from './maintenance.js';

let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PUBLICATION_READY_INTERVAL_MS', '1000');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.settings.mockResolvedValue(defaultSettings);
  mocks.resume.mockResolvedValue(undefined);
  mocks.expire.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(async () => {
  await stop?.(); stop = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it.each([
  ['media_expiry', 'expire'], ['settings', 'settings'], ['resume', 'resume'],
] as const)('records safe SQLSTATE and phase for %s failures', async (phase, method) => {
  const error = Object.assign(new Error('private SQL payload and credentials'), {
    code: '42601', detail: 'private row content', query: 'secret SQL', constraint: 'secret constraint',
  });
  mocks[method].mockRejectedValue(error);
  stop = await startPublicationMaintenance();
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  const diagnostic = { phase, errorName: 'Error', sqlState: '42601', frames: [], botErrorCode: undefined };
  expect(console.error).toHaveBeenCalledWith(
    'Telegram publication maintenance failed; retrying on the next maintenance tick.', diagnostic);
  expect(mocks.save).toHaveBeenCalledWith('telegram_publication_maintenance', {
    status: 'waiting', errorCode: 'publication_resume_failed', diagnostic, nextRetryAt: expect.any(String),
  });
  expect(JSON.stringify([mocks.save.mock.calls, vi.mocked(console.error).mock.calls])).not.toMatch(/private|secret/u);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['telegram_connect_failed', 'telegram_transport_unknown', 'telegram_rejected_401', 'telegram_rate_limit'])(
  'retains allowlisted bot failure label %s', async code => {
    mocks.resume.mockRejectedValue(new BotError(code, 'unknown'));
    stop = await startPublicationMaintenance();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith('telegram_publication_maintenance', expect.objectContaining({
      diagnostic: expect.objectContaining({ phase: 'resume', botErrorCode: code }),
    }));
  });

it('does not log arbitrary exception codes, names, messages or stacks', async () => {
  mocks.resume.mockRejectedValue(Object.assign(new BotError('secret-token', 'failed'), {
    name: 'private-name', stack: 'private-stack', message: 'private-message',
  }));
  stop = await startPublicationMaintenance();
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(JSON.stringify([mocks.save.mock.calls, vi.mocked(console.error).mock.calls])).not.toMatch(/secret|private/u);
  expect(mocks.save).toHaveBeenCalledWith('telegram_publication_maintenance', expect.objectContaining({
    diagnostic: { phase: 'resume', errorName: 'UnknownError', sqlState: undefined, frames: [], botErrorCode: undefined },
  }));
});

it('keeps the diagnostic in logs if saving maintenance state also fails', async () => {
  mocks.resume.mockRejectedValue(new BotError('telegram_transport_unknown', 'unknown'));
  mocks.save.mockRejectedValue(new Error('private connection string'));
  stop = await startPublicationMaintenance();
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(console.error).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('clears stale maintenance errors on a successful tick', async () => {
  stop = await startPublicationMaintenance();
  await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledWith(
    "DELETE FROM operational_state WHERE key='telegram_publication_maintenance'"));
  expect(mocks.resume).toHaveBeenCalledWith(defaultSettings);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
