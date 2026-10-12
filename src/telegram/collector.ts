import type { HistoryReader } from "./history.js";
import type { CollectedItem, CollectionCursor, TelegramSource } from "./types.js";

export interface CollectionStore {
  commitSource(
    batchId: string, source: TelegramSource, items: readonly CollectedItem[], cursor: CollectionCursor,
  ): Promise<number>;
}

/** Save items, links, batch membership and cursor together, only after a complete fetch. */
export async function collectSource(
  reader: HistoryReader,
  store: CollectionStore,
  batchId: string,
  source: TelegramSource,
  cutoff: Date,
  windowHours = 48,
  entryLimit?: number,
): Promise<number> {
  if (!Number.isFinite(cutoff.getTime()) || !Number.isFinite(windowHours) || windowHours <= 0 || windowHours > 48) {
    throw new Error("Collection requires a valid cutoff and a window of at most 48 hours.");
  }
  const since = new Date(cutoff.getTime() - windowHours * 60 * 60 * 1000);
  const items: CollectedItem[] = [];
  let lastMessageId = source.cursor.lastMessageId;
  let inspected = 0;
  for await (const entry of reader.recent(source, since, cutoff, entryLimit)) {
    if (entryLimit !== undefined && inspected++ >= entryLimit) break;
    if (entry.publishedAt < since || entry.publishedAt > cutoff ||
        (entry.editedAt && entry.editedAt > cutoff)) continue;
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) throw new Error("Invalid history sequence.");
    lastMessageId = Math.max(lastMessageId, entry.sequence);
    if (entry.item) items.push(entry.item);
  }
  // A capped descending fetch cannot prove the omitted older messages were visited.
  // Keep the source cursor unchanged; normal collection will still see those messages.
  return await store.commitSource(batchId, source, items, entryLimit === undefined
    ? { lastMessageId, cutoff: cutoff.toISOString() } : source.cursor);
}
