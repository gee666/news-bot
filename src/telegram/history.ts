import { Api } from "telegram";
import { parseID } from "telegram/Utils.js";
import { extractLinks, normalizeText, type UrlEntity } from "./links.js";
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
    metadata: { messageId: message.id, access: publicUrl ? "public" : "restricted", hasMedia: !!message.media },
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
    for await (const message of this.client.iterMessages(peer(source), {
      offsetDate: Math.floor(cutoff.getTime() / 1000) + 1,
      ...(limit === undefined ? {} : { limit }),
    })) {
      const publishedAt = new Date(message.date * 1000);
      if (publishedAt < since) break;
      if (publishedAt > cutoff) continue;
      yield {
        sequence: message.id, publishedAt,
        editedAt: message.editDate ? new Date(message.editDate * 1000) : null,
        item: messageItem(message, source),
      };
    }
  }
}
