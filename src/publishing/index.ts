import { z } from 'zod';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { publicationSnapshotSchema } from '../types.js';
import { BotApi } from './bot-api.js';
import { editPublication, reconcile, sendPrepared } from './delivery.js';
import { recoverSends } from './digest.js';
import { destination, locked, publicationSelect, rateLimited, saveState, state, testPublication, type Publication } from './store.js';

export { publishDigest, resumePublications } from './digest.js';

export { startPublicationMaintenance } from './maintenance.js';
export { repairExistingPublications } from './repair.js';
export { previewPublicationRepair } from './preview.js';

/** Explicit invocation authorizes one labeled test send and edit on the resolved target. */
export async function verifyBot(): Promise<{ verified: boolean; destinationId: string; messageId: string | null }> {
  return locked('news-bot-digest', async () => {
    const destinationId = await destination();
    const api = new BotApi();
    const bot = await api.identity();
    const settings = await getSettings();
    await saveState('bot_verified',{ verified: false, destinationId, botId: bot.id });
    await recoverSends(destinationId);
    const previous = z.object({ publicationId: z.string(), destinationId: z.string(), botId: z.number() }).safeParse(await state('bot_verification_test'));
    let publication: Publication | undefined;
    if (previous.success && previous.data.destinationId === destinationId && previous.data.botId === bot.id) {
      publication = (await db.query<Publication>(`${publicationSelect} WHERE p.id=$1`, [previous.data.publicationId])).rows[0];
    }
    if (!publication) {
      publication = await testPublication(destinationId);
      await saveState('bot_verification_test',{ publicationId: publication.id, destinationId, botId: bot.id });
    }
    publicationSnapshotSchema.parse(publication.content);
    if (publication.status === 'uncertain') {
      if (!await reconcile(publication,settings)) return { verified: false, destinationId, messageId: null };
      publication = (await db.query<Publication>(`${publicationSelect} WHERE p.id=$1`, [publication.id])).rows[0];
      if (!publication) throw new Error('Verification publication missing');
    }
    if (publication.status === 'failed' || publication.next_retry_at && publication.next_retry_at > new Date() || await rateLimited()) {
      return { verified: false, destinationId, messageId: publication.message_id };
    }
    if (publication.status === 'prepared') {
      publication.message_id = await sendPrepared(publication,api,settings,{ verificationTest: true });
      if (!publication.message_id) return { verified: false, destinationId, messageId: null };
      publication.status = 'published';
    }
    const verified = await locked(`news-bot-publication:${publication.id}`, () => editPublication(publication,api,settings,{ verificationTest: true }));
    await saveState('bot_verified',{ verified, destinationId, botId: bot.id, checkedAt: new Date().toISOString() });
    return { verified, destinationId, messageId: publication.message_id };
  });
}
