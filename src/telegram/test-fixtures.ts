import type { CollectedItem, TelegramSource } from "./types.js";
import type { HistoryEntry, HistoryReader } from "./history.js";

// Synthetic fixtures only. Never use live account data in these tests.
export function source(overrides: Partial<TelegramSource> = {}): TelegramSource {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    externalId: "-1001234", name: "Synthetic channel", access: "restricted",
    enabled: true, active: true,
    metadata: { channelId: "1234", accessHash: "123456", username: null },
    cursor: { lastMessageId: 10, cutoff: null }, ...overrides,
  };
}

export function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    externalId: "11", originalText: "Synthetic news", normalizedText: "Synthetic news",
    publishedAt: new Date("2025-09-29T10:00:00Z"), editedAt: null,
    originalUrl: null, links: [], metadata: {}, ...overrides,
  };
}

export function history(entries: readonly HistoryEntry[], fail = false): HistoryReader {
  return {
    async *recent() {
      yield* entries;
      if (fail) throw new Error("Synthetic history interruption");
    },
  };
}
