import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { getSettings } from '../settings.js';
import { resumePublications } from './digest.js';
import { saveState } from './store.js';

export async function startPublicationMaintenance(): Promise<() => Promise<void>> {
  const intervalMs = z.coerce.number().int().min(1000).max(60000).parse(process.env.PUBLICATION_READY_INTERVAL_MS ?? 5000);
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try { await resumePublications(await getSettings()); }
      catch {
        await saveState('telegram_publication_maintenance', { status: 'waiting', errorCode: 'publication_resume_failed',
          nextRetryAt: new Date(Date.now() + intervalMs).toISOString() }).catch(() => {});
      }
      try { await sleep(intervalMs, undefined, { signal: controller.signal }); } catch { break; }
    }
  })();
  return async () => { controller.abort(); await done; };
}
