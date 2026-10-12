import { db } from "../db.js";
import { withUserClient } from "./client.js";
import { collectSource } from "./collector.js";
import { PostgresCollectionStore } from "./collection-store.js";
import { TelegramHistory } from "./history.js";
import { prepareBatchSources } from "./repository.js";

/** The caller creates/resumes the singleton batch and supplies its persisted cutoff. */
export async function collectTelegramBatch(batchId: string, cutoff: Date, windowHours = 48): Promise<number> {
  const sources = await prepareBatchSources(batchId);
  if (!sources.length) return 0;
  return await withUserClient(async client => {
    const reader = new TelegramHistory(client);
    const store = new PostgresCollectionStore();
    let count = 0;
    for (const source of sources) {
      try {
        count += await collectSource(reader, store, batchId, source, cutoff, windowHours);
      } catch (error) {
        await db.query(
          "UPDATE batch_sources SET status='failed',error_code='telegram_collection_failed' WHERE batch_id=$1 AND source_id=$2 AND status <> 'completed'",
          [batchId, source.id],
        );
        throw error;
      }
    }
    return count;
  });
}
