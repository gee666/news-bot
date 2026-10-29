import { constants } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { usageOutboxDirectory, usageRecoveryStatus } from './usage-delivery.js';

const replayStatusSchema = z.object({
  replaying: z.boolean(), lastReplayAt: z.iso.datetime().nullable(),
  lastReplayRecordedRecords: z.number().int().nonnegative(), lastReplayFailed: z.boolean(),
});
export const usageOutboxStatusSchema = z.discriminatedUnion('state', [
  replayStatusSchema.extend({ state: z.literal('ready'), pendingRecords: z.number().int().nonnegative(),
    oldestPendingAt: z.iso.datetime().nullable() }),
  replayStatusSchema.extend({ state: z.literal('missing'), pendingRecords: z.literal(0), oldestPendingAt: z.null() }),
  replayStatusSchema.extend({ state: z.literal('unavailable'), pendingRecords: z.null(), oldestPendingAt: z.null() }),
]);
export type UsageOutboxStatus = z.infer<typeof usageOutboxStatusSchema>;
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Read metadata only. Never return storage paths, filenames, call IDs or queued JSON. */
export async function usageOutboxStatus(): Promise<UsageOutboxStatus> {
  const recovery = usageRecoveryStatus();
  const unavailable: UsageOutboxStatus = { state: 'unavailable', pendingRecords: null,
    oldestPendingAt: null, ...recovery };
  const path = usageOutboxDirectory();
  try {
    const folder = await lstat(path);
    if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077) !== 0) return unavailable;
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    let pendingRecords = 0;
    let oldest: Date | undefined;
    let exhausted=false;
    for (const name of await readdir(path)) {
      const id=name.endsWith('.json.failed') ? name.slice(0,-12) : name.endsWith('.json') ? name.slice(0,-5) : '';
      if (!z.uuid().safeParse(id).success) continue;
      exhausted ||= name.endsWith('.json.failed');
      try {
        const file = await lstat(join(path, name));
        if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) return unavailable;
        await access(join(path, name), constants.R_OK);
        pendingRecords++;
        if (!oldest || file.mtime < oldest) oldest = file.mtime;
      } catch (error) {
        // Recovery may have removed this file after readdir.
        if (!missing(error)) return unavailable;
      }
    }
    return { state: 'ready', pendingRecords, oldestPendingAt: oldest?.toISOString() ?? null, ...recovery,lastReplayFailed:exhausted || recovery.lastReplayFailed };
  } catch (error) {
    return missing(error) ? { ...unavailable, state: 'missing', pendingRecords: 0 } : unavailable;
  }
}
