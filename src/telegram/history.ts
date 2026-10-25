import { messageMedia, type TelegramMedia } from "./media.js";
import { Api } from "telegram";
import { parseID } from "telegram/Utils.js";
import { extractLinks, normalizeText, type UrlEntity } from "../sources/links.js";
import { TelegramSetupError } from "./input.js";
import type { CollectedItem, TelegramSource } from "./types.js";

export interface HistoryEntry {
  sequence: number;
  publishedAt: Date;
  editedAt: Date | null;
  item: CollectedItem | null;
}

export interface HistoryReader {
  recent(source: TelegramSource, since: Date, cutoff: Date, limit?: number): AsyncIterable<HistoryEntry>;
}

function peer(source: TelegramSource): Api.InputPeerChannel {
  const { channelId, accessHash } = source.metadata;
  if (typeof channelId !== "string" || !/^\d+$/u.test(channelId) ||
      typeof accessHash !== "string" || !/^-?\d+$/u.test(accessHash)) {
    throw new TelegramSetupError("Channel metadata is missing. Refresh discovery.");
  }
  const id = parseID(channelId);
  const hash = parseID(accessHash);
  if (!id || !hash) throw new TelegramSetupError("Channel metadata is invalid. Refresh discovery.");
  return new Api.InputPeerChannel({ channelId: id, accessHash: hash });
}

export function messageItem(message: Api.Message, source: TelegramSource): CollectedItem | null {
  if (!message.message?.trim()) return null;
  const entities: UrlEntity[] = [];
  for (const entity of message.entities ?? []) {
    if (entity instanceof Api.MessageEntityUrl) {
      entities.push({ kind: "url", offset: entity.offset, length: entity.length });
    } else if (entity instanceof Api.MessageEntityTextUrl) {
      entities.push({ kind: "text-url", offset: entity.offset, length: entity.length, url: entity.url });
    }
  }
  const username = source.metadata.username;
  const channelId = source.metadata.channelId;
  const publicUrl = typeof username === "string" && username
    ? "https://t.me/" + username + "/" + message.id : null;
  const privateUrl = typeof channelId === "string"
    ? "https://t.me/c/" + channelId + "/" + message.id : null;
  return {
    externalId: String(message.id),
    originalText: message.message,
    normalizedText: normalizeText(message.message),
    publishedAt: new Date(message.date * 1000),
    editedAt: message.editDate ? new Date(message.editDate * 1000) : null,
    originalUrl: publicUrl ?? privateUrl,
    links: extractLinks(message.message, entities),
    metadata: { messageId: message.id, access: publicUrl ? "public" : "restricted", hasMedia: !!message.media, media: messageMedia(message, source),
      ...(message.groupedId ? { groupedId: message.groupedId.toString() } : {}) },
  };
}

export interface HistoryClient {
  iterMessages(entity: Api.InputPeerChannel, options: { offsetDate: number; limit?: number }): AsyncIterable<Api.Message>;
}

export class TelegramHistory implements HistoryReader {
  constructor(private readonly client: HistoryClient) {}

  async *recent(source: TelegramSource, since: Date, cutoff: Date, limit?: number): AsyncGenerator<HistoryEntry> {
    // Revisit the rolling window for edits; minId would hide edits behind the cursor.
    // GetHistory does not acknowledge reads or increment message views.
    // Telegram returns album members together in descending history order. Buffer one album so
    // a captioned revision also references uncaptioned siblings, without extra API requests.
    let group: { id: string; entries: HistoryEntry[]; media: TelegramMedia[] } | null = null;
    function flush(): HistoryEntry[] {
      if (!group) return [];
      const entries = group.entries;
      const media = group.media.sort((a, b) => a.telegramMessageId - b.telegramMessageId);
      for (const entry of entries) if (entry.item) entry.item.metadata.media = media;
      group = null;
      return entries;
    }
    for await (const message of this.client.iterMessages(peer(source), {
      offsetDate: Math.floor(cutoff.getTime() / 1000) + 1,
      ...(limit === undefined ? {} : { limit }),
    })) {
      const publishedAt = new Date(message.date * 1000);
      if (publishedAt < since) break;
      if (publishedAt > cutoff) continue;
      const groupedId = message.groupedId?.toString();
      if (group && group.id !== groupedId) yield* flush();
      const entry: HistoryEntry = {
        sequence: message.id, publishedAt,
        editedAt: message.editDate ? new Date(message.editDate * 1000) : null,
        item: messageItem(message, source),
      };
      if (groupedId) {
        group ??= { id: groupedId, entries: [], media: [] };
        group.entries.push(entry);
        // A sibling edited after the snapshot must not leak future media into this revision.
        if (!entry.editedAt || entry.editedAt <= cutoff) group.media.push(...messageMedia(message, source));
      } else yield entry;
    }
    yield* flush();
  }
}
