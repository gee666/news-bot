import { expect, it } from 'vitest';
import { defaultSettings } from '../settings.js';
import { collectionFailure } from './collection.js';
it('retains provider flood wait and bounded connection retries', () => {
  expect(collectionFailure(new Error('FLOOD_WAIT_3600'), 100, defaultSettings).next?.getTime())
    .toBeGreaterThanOrEqual(Date.now() + 3_599_000);
  expect(collectionFailure(new Error('ECONNRESET'), 1, defaultSettings).next).toBeInstanceOf(Date);
  expect(collectionFailure(new Error('ECONNRESET'), defaultSettings.requestMaxAttempts, defaultSettings).next).toBeNull();
});
it('does not retain connector error bodies or retry authentication indefinitely', () => {
  const result = collectionFailure(new Error('AUTH_KEY_UNREGISTERED secret-body'), 1, defaultSettings);
  expect(result.next).toBeNull();
  expect(JSON.stringify(result)).not.toContain('secret-body');
});
