import cron from 'node-cron';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSettings } from './settings.js';
afterEach(() => vi.useRealTimers());

it.each([
  ['2026-03-28T20:01:00.000Z', '2026-03-29T03:00:00.000Z'],
  ['2026-10-24T19:01:00.000Z', '2026-10-25T04:00:00.000Z'],
  ['2026-06-01T03:01:00.000Z', '2026-06-01T07:00:00.000Z'],
  ['2026-12-01T04:01:00.000Z', '2026-12-01T08:00:00.000Z'],
])('schedules the next Berlin collection after %s at %s', async (now, next) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  const task = cron.schedule(defaultSettings.collectionCron, () => {}, { timezone: defaultSettings.timezone });
  try { expect(task.getNextRun()?.toISOString()).toBe(next); }
  finally { await task.destroy(); }
});

it('uses five local collection times without changing saved schedules', () => {
  expect(defaultSettings.collectionCron).toBe('0 5,9,13,17,21 * * *');
  expect(defaultSettings.timezone).toBe('Europe/Berlin');
});
