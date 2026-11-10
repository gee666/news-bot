import { expect, it } from 'vitest';
import { ModelAvailability } from './availability.js';
import { infer } from './inference.js';
import { RequestFault } from './errors.js';

it('backs off repeated outages, allows recovery probes, and resets after success', () => {
  const availability = new ModelAvailability();
  let now = 0;
  for (let attempt = 0; attempt < 15; attempt++) {
    const until = availability.failed('jev', 'transient', undefined, now);
    expect(until - now).toBe(Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6)));
    expect(() => availability.check('jev', until - 1)).toThrow();
    expect(() => availability.check('embedding', now)).not.toThrow();
    expect(() => availability.check('jev', until)).not.toThrow();
    now = until;
  }
  availability.succeeded('jev');
  expect(() => availability.check('jev', 0)).not.toThrow();
  expect(availability.failed('jev', 'model_unavailable', undefined, now)).toBe(now + 5000);
});

it('honors provider deadlines and unknown timeout outcomes', () => {
  const availability = new ModelAvailability();
  expect(availability.failed('embedding', 'timeout', undefined, 0)).toBe(300_000);
  expect(availability.failed('jev', 'throttled', 3_600_000, 0)).toBe(3_600_000);
});

it('checks cooldown after the gate so already queued clients cannot flood an offline model', async () => {
  let calls = 0;
  const execute = async () => { calls++; throw new RequestFault('model_unavailable'); };
  const request = (id: string) => infer('jev', 1000, { operationId: id, attempt: 100 }, async () => {}, execute, 1,
    { provider: 'jev', model: 'test', availabilityKey: 'queued-offline-model' });
  const results = await Promise.allSettled([request('a'), request('b'), request('c')]);
  expect(calls).toBe(1);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ metadata: { retryable: true } });
  }
});
