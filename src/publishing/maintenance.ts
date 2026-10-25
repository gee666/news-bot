import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { resumePublications } from './digest.js';
import { saveState } from './store.js';
import { expirePublicationMedia } from './media-plan.js';
import { BotError } from './bot-api.js';
import { processingDiagnostic } from '../pipeline/processing-diagnostics.js';

const maintenanceBotCodes = new Set(['bot_token_missing_or_invalid', 'telegram_connect_failed', 'telegram_transport_unknown',
  'telegram_response_unknown', 'telegram_identity_invalid', 'telegram_server_unknown', 'telegram_rate_limit']);

export async function startPublicationMaintenance(): Promise<() => Promise<void>> {
  const intervalMs = z.coerce.number().int().min(1000).max(60000).parse(process.env.PUBLICATION_READY_INTERVAL_MS ?? 5000);
  const controller = new AbortController();
  const done = (async () => {
    let cleanupAt = 0;
    while (!controller.signal.aborted) {
      let phase: 'media_expiry' | 'settings' | 'resume' = 'media_expiry';
      try {
        if (Date.now() >= cleanupAt) {
          await expirePublicationMedia();
          cleanupAt = Date.now() + 60 * 60 * 1000;
        }
        phase = 'settings';
        const settings = await getSettings();
        phase = 'resume';
        await resumePublications(settings);
        await db.query("DELETE FROM operational_state WHERE key='telegram_publication_maintenance'");
      }
      catch (error) {
        const { errorName, sqlState, frames } = processingDiagnostic(error);
        const botErrorCode = error instanceof BotError && (maintenanceBotCodes.has(error.code)
          || /^telegram_rejected_[1-5]\d{2}$/u.test(error.code)) ? error.code : undefined;
        const diagnostic = { phase, errorName, sqlState, frames, botErrorCode };
        console.error('Telegram publication maintenance failed; retrying on the next maintenance tick.', diagnostic);
        await saveState('telegram_publication_maintenance', { status: 'waiting', errorCode: 'publication_resume_failed',
          diagnostic, nextRetryAt: new Date(Date.now() + intervalMs).toISOString() }).catch(() => {});
      }
      try { await sleep(intervalMs, undefined, { signal: controller.signal }); } catch { break; }
    }
  })();
  return async () => { controller.abort(); await done; };
}
