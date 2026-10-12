export type { TextLink } from "../sources/types.js";
import type { TextLink } from "../sources/types.js";

/** Offsets refer to the original text and use UTF-16 code units. */
export interface CollectedItem {
  externalId: string;
  originalText: string;
  normalizedText: string;
  publishedAt: Date;
  editedAt: Date | null;
  originalUrl: string | null;
  links: TextLink[];
  metadata: Record<string, unknown>;
}

export interface CollectionCursor {
  lastMessageId: number;
  cutoff: string | null;
}

export interface TelegramSource {
  id: string;
  externalId: string;
  name: string;
  access: "public" | "restricted" | "unknown";
  enabled: boolean;
  active: boolean;
  metadata: Record<string, unknown>;
  cursor: CollectionCursor;
}

export interface DiscoveredChannel {
  externalId: string;
  name: string;
  originalUrl: string | null;
  access: "public" | "restricted";
  metadata: { channelId: string; accessHash: string; username: string | null };
}

export interface Destination {
  channelId: string;
  name: string;
  inviteUrl: string;
}
