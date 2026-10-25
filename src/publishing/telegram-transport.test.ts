import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from 'undici';
import { isTelegramPreconnectFailure, telegramTimeouts } from './bot-api.js';

beforeEach(() => {
  vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', undefined);
  vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', undefined);
});
afterEach(() => vi.unstubAllEnvs());

function systemError(code: string, syscall?: string): Error {
  return Object.assign(new Error('private transport details'), { code, ...(syscall ? { syscall } : {}) });
}
const fetchFailure = (cause: unknown) => new TypeError('fetch failed', { cause });

describe('Telegram timeout configuration', () => {
  it('defaults to 30 seconds for requests and 5 minutes for uploads', () => {
    expect(telegramTimeouts()).toEqual({ requestMs: 30_000, uploadMs: 300_000 });
  });
  it('reads both validated overrides without caching old environment values', () => {
    vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', ' 45000 ');
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', '600000');
    expect(telegramTimeouts()).toEqual({ requestMs: 45_000, uploadMs: 600_000 });
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', '900000');
    expect(telegramTimeouts().uploadMs).toBe(900_000);
  });
  it('accepts inclusive bounds', () => {
    vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', '1000');
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', '1000');
    expect(telegramTimeouts()).toEqual({ requestMs: 1_000, uploadMs: 1_000 });
    vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', '300000');
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', '900000');
    expect(telegramTimeouts()).toEqual({ requestMs: 300_000, uploadMs: 900_000 });
  });
  it.each(['', ' ', '0', '-1', '999', '1000.5', 'NaN', 'Infinity', '1e4', '0x1000', '123:secret', '999999999999999999999'])(
    'rejects invalid values without echoing them: %j', value => {
      for (const name of ['TELEGRAM_REQUEST_TIMEOUT_MS', 'TELEGRAM_UPLOAD_TIMEOUT_MS']) {
        vi.stubEnv(name, value);
        expect(telegramTimeouts).toThrow(new Error(`${name.toLowerCase()}_invalid`));
        vi.stubEnv(name, undefined);
      }
    });
  it.each([['TELEGRAM_REQUEST_TIMEOUT_MS', '300001'], ['TELEGRAM_UPLOAD_TIMEOUT_MS', '900001']])(
    'rejects values above the bound for %s', (name, value) => {
      vi.stubEnv(name, value);
      expect(telegramTimeouts).toThrow(new Error(`${name.toLowerCase()}_invalid`));
    });
});

describe('proof of a pre-connect failure', () => {
  it.each([
    new errors.ConnectTimeoutError('private connection details'),
    systemError('ENOTFOUND', 'getaddrinfo'), systemError('EAI_AGAIN', 'getaddrinfo'),
    systemError('ECONNREFUSED', 'connect'), systemError('ENETUNREACH', 'connect'),
  ])('recognizes a Node fetch failure with a proven cause: %s', cause => {
    expect(isTelegramPreconnectFailure(fetchFailure(cause))).toBe(true);
  });
  it('checks every address in Node multi-address connect aggregates, including nested aggregates', () => {
    const cause = Object.assign(new AggregateError([
      systemError('ECONNREFUSED', 'connect'),
      new AggregateError([systemError('ENETUNREACH', 'connect')]),
    ]), { code: 'ECONNREFUSED' });
    expect(isTelegramPreconnectFailure(fetchFailure(cause))).toBe(true);
  });
  it.each([
    null, undefined, 'fetch failed', new Error('connect timeout'), new TypeError('fetch failed'),
    systemError('UND_ERR_CONNECT_TIMEOUT'), systemError('ECONNREFUSED', 'connect'),
    fetchFailure(systemError('ECONNREFUSED')),
    fetchFailure(systemError('ENOTFOUND')),
    fetchFailure(systemError('ENETUNREACH', 'write')),
    fetchFailure(systemError('EAI_AGAIN', 'read')),
    fetchFailure({ code: 'ECONNREFUSED', syscall: 'connect' }),
    new Error('fetch failed', { cause: systemError('ECONNREFUSED', 'connect') }),
    new TypeError('request failed', { cause: systemError('ECONNREFUSED', 'connect') }),
    fetchFailure(new Error('wrapper', { cause: systemError('ECONNREFUSED', 'connect') })),
    fetchFailure(Object.assign(systemError('ECONNREFUSED', 'connect'), { cause: systemError('ECONNRESET') })),
    fetchFailure(Object.assign(systemError('ECONNREFUSED', 'connect'), { name: 'AbortError' })),
  ])('does not infer pre-connect from incomplete or non-Node evidence: %s', error => {
    expect(isTelegramPreconnectFailure(error)).toBe(false);
  });
  it.each([
    'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_ABORTED', 'ABORT_ERR',
  ])('keeps %s ambiguous even with a cause', code => {
    expect(isTelegramPreconnectFailure(fetchFailure(systemError(code, 'connect')))).toBe(false);
  });
  it.each([
    new AggregateError([]), new AggregateError([new Error('unknown')]),
    new AggregateError([systemError('ECONNREFUSED', 'connect'), systemError('ECONNRESET')]),
    new AggregateError([systemError('ENETUNREACH', 'connect'), systemError('ETIMEDOUT', 'connect')]),
    Object.assign(new AggregateError([systemError('ECONNREFUSED', 'connect')]), { code: 'ECONNRESET' }),
    Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }),
    Object.assign(new AggregateError([]), { errors: null }),
    Object.assign(new AggregateError([]), { errors: Array(2) }),
  ])('does not trust generic, empty or mixed AggregateError causes: %s', cause => {
    expect(isTelegramPreconnectFailure(fetchFailure(cause))).toBe(false);
  });
  it('does not recurse indefinitely through cyclic aggregates', () => {
    const cause = new AggregateError([]);
    cause.errors.push(cause);
    expect(isTelegramPreconnectFailure(fetchFailure(cause))).toBe(false);
  });
  it.each([new DOMException('private abort', 'AbortError'), new DOMException('private timeout', 'TimeoutError')])(
    'does not infer pre-connect from cancellation: %s', cause => {
      expect(isTelegramPreconnectFailure(cause)).toBe(false);
      expect(isTelegramPreconnectFailure(fetchFailure(cause))).toBe(false);
    });
});
