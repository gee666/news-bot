import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { db } from '../db.js';
import { defaultSettings, getSettings } from '../settings.js';
import { resumePublications } from './digest.js';
import { saveState, state } from './store.js';
import { expirePublicationMedia } from './media-plan.js';
import { BotError } from './bot-api.js';
import { processingDiagnostic } from '../pipeline/processing-diagnostics.js';

const maintenanceBotCodes = new Set(['bot_token_missing_or_invalid', 'telegram_connect_failed', 'telegram_transport_unknown',
  'telegram_response_unknown', 'telegram_identity_invalid', 'telegram_server_unknown', 'telegram_rate_limit']);

export async function startPublicationMaintenance(): Promise<() => Promise<void>> {
  const intervalMs = z.coerce.number().int().min(1000).max(60000).parse(process.env.PUBLICATION_READY_INTERVAL_MS ?? 5000);
  const previous = z.object({ status:z.string(), attempts:z.number().int().nonnegative().default(0),
    nextRetryAt:z.iso.datetime().nullable().optional() }).safeParse(await state('telegram_publication_maintenance'));
  const controller = new AbortController();
  const done = (async () => {
    // Restart is an explicit new worker run; durable publication budgets remain unchanged.
    let attempts = previous.success && previous.data.status !== 'failed' ? previous.data.attempts : 0;
    let waitMs = previous.success && previous.data.nextRetryAt ? Math.max(0,Date.parse(previous.data.nextRetryAt)-Date.now()) : 0;
    let settings = defaultSettings;
    let cleanupAt = 0;
    while (!controller.signal.aborted) {
      if (waitMs>0) { try { await sleep(waitMs,undefined,{signal:controller.signal}); } catch { break; } }
      waitMs=intervalMs;
      let phase: 'media_expiry' | 'settings' | 'resume' = 'media_expiry';
      try {
        if (Date.now() >= cleanupAt) {
          await expirePublicationMedia();
          cleanupAt = Date.now() + 60 * 60 * 1000;
        }
        phase = 'settings';
        settings = await getSettings();
        phase = 'resume';
        await resumePublications(settings);
        await db.query("DELETE FROM operational_state WHERE key='telegram_publication_maintenance'");
        attempts=0;
      }
      catch (error) {
        const { errorName, sqlState, frames } = processingDiagnostic(error);
        const botErrorCode = error instanceof BotError && (maintenanceBotCodes.has(error.code)
          || /^telegram_rejected_[1-5]\d{2}$/u.test(error.code)) ? error.code : undefined;
        const diagnostic = { phase, errorName, sqlState, frames, botErrorCode };
        attempts++;
        const exhausted = attempts>=settings.requestMaxAttempts;
        waitMs=Math.max(error instanceof BotError ? error.retryAfterMs : 0,Math.min(settings.retryMaxMs,settings.retryBaseMs * 2 ** Math.min(attempts-1,10)));
        console.error('Telegram publication maintenance failed.', diagnostic);
        await saveState('telegram_publication_maintenance', { status: exhausted ? 'failed' : 'waiting', attempts, errorCode: 'publication_resume_failed',
          diagnostic, nextRetryAt: exhausted ? null : new Date(Date.now() + waitMs).toISOString() }).catch(() => {});
        if (exhausted) break;
      }
    }
  })();
  return async () => { controller.abort(); await done; };
}
