import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db.js';
import { failureMetadata, RequestFault } from '../models/errors.js';
import { recordGenerationFailure, requireInferenceApproval } from './generation-model.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('generation privacy and safe diagnostics', () => {
  it('allows public inference without opt-in and fails closed for missing or unfamiliar access', async () => {
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    await requireInferenceApproval(['public'], 'synthetic-public');
    expect(db.query).not.toHaveBeenCalled();
    await expect(requireInferenceApproval(['future-access-state'], 'synthetic-unknown')).rejects.toMatchObject({
      metadata: { kind: 'invalid_request', outcome: 'not_submitted', retryable: false },
    });
    expect(db.query).toHaveBeenCalledOnce();
  });

  it('persists safe retry/outcome diagnostics and the actual dispatch time, not request bodies', async () => {
    const failure = failureMetadata(new RequestFault('timeout'), 'research:synthetic', 'pi', 2, 1200, 10_000);
    await recordGenerationFailure(failure);
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toEqual([
      'pi', 'research:synthetic', 2, 'unknown', new Date(8800).toISOString(), new Date(10_000).toISOString(),
      failure.nextRetryAt, 'timeout', '{"outcome":"unknown","durationMs":1200}',
    ]);
  });

  it('persists allowlisted stream diagnostics without provider text', async () => {
    const failure = failureMetadata(new RequestFault('transient', { status: 200, outcome: 'unknown',
      providerErrorCode: 'server_error', streamEvent: 'error', transportKind: 'stream_disconnected' }),
      'research:synthetic', 'pi', 1, 901833, 10_000);
    await recordGenerationFailure(failure);
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toContain(
      '{"outcome":"unknown","durationMs":901833,"status":200,"providerErrorCode":"server_error","transportKind":"stream_disconnected","streamEvent":"error"}');
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toContain('transient');
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toContain('unknown');
    expect(failure.nextRetryAt).toBe(new Date(310_000).toISOString());
  });

  it('stores rejected non-retryable privacy failures as correction-required failures', async () => {
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    await expect(requireInferenceApproval(['restricted'], 'research:synthetic')).rejects.toThrow('ALLOW_PRIVATE_INFERENCE=true');
    const parameters = vi.mocked(db.query).mock.calls[0]?.[1];
    expect(parameters).toContain('failed');
    expect(parameters).toContain('invalid_request');
    expect(JSON.stringify(parameters)).not.toContain('Private or unknown source');
  });
});
