import { Api, type TelegramClient, utils } from "telegram";
import { parseID } from "telegram/Utils.js";
import { TelegramSetupError } from "./input.js";
import type { Destination, DiscoveredChannel } from "./types.js";

export const DEFAULT_DESTINATION_INVITE = "https://t.me/+5cDKe78ahR02Y2Ey";

export function inviteHash(inviteUrl: string): string {
  try {
    const url = new URL(inviteUrl);
    const match = /^(?:\/\+|\/joinchat\/)([A-Za-z0-9_-]+)\/?$/u.exec(url.pathname);
    if (url.protocol === "https:" && url.hostname === "t.me" && match?.[1] && !url.search && !url.hash) {
      return match[1];
    }
  } catch { /* Reject malformed configuration without echoing it. */ }
  throw new TelegramSetupError("TELEGRAM_DESTINATION must be a Telegram HTTPS invite link.");
}

export async function resolveDestination(
  client: Pick<TelegramClient, "invoke">,
  inviteUrl = process.env.TELEGRAM_DESTINATION?.trim() || DEFAULT_DESTINATION_INVITE,
): Promise<Destination> {
  const result = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash(inviteUrl) }));
  if ((result instanceof Api.ChatInviteAlready || result instanceof Api.ChatInvitePeek) &&
      result.chat instanceof Api.Channel && result.chat.broadcast && !result.chat.megagroup) {
    return { channelId: utils.getPeerId(result.chat), name: result.chat.title, inviteUrl };
  }
  throw new TelegramSetupError(
    "Telegram did not expose a numeric destination ID. Add this account to the destination yourself, then retry discovery. The app has not joined it.",
  );
}

export function channelDescriptor(entity: Api.TypeChat, destinationId: string): DiscoveredChannel | null {
  if (!(entity instanceof Api.Channel) || !entity.broadcast || entity.megagroup || entity.left ||
      utils.getPeerId(entity) === destinationId) return null;
  if (!entity.accessHash || entity.min) throw new TelegramSetupError("Telegram returned an incomplete channel. Retry discovery.");
  const username = entity.username ?? entity.usernames?.find(value => value.active)?.username ?? null;
  return {
    externalId: utils.getPeerId(entity), name: entity.title,
    originalUrl: username ? "https://t.me/" + username : null,
    access: username ? "public" : "restricted",
    metadata: { channelId: entity.id.toString(), accessHash: entity.accessHash.toString(), username },
  };
}

export async function discoverChannels(
  client: Pick<TelegramClient, "invoke">,
  destinationId: string,
): Promise<DiscoveredChannel[]> {
  const channels = new Map<string, DiscoveredChannel>();
  const hash = parseID("0");
  if (!hash) throw new Error("Invalid dialog hash");
  let offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty();
  let offsetId = 0;
  let offsetDate = 0;
  let excludePinned = false;
  let previousOffset = "";
  while (true) {
    // No folder filter, so archived subscriptions are included. Raw GetDialogs
    // avoids GramJS iterDialogs' unconditional message dump on initialization errors.
    const result = await client.invoke(new Api.messages.GetDialogs({
      offsetPeer, offsetId, offsetDate, excludePinned, limit: 100, hash,
    }));
    if (result instanceof Api.messages.DialogsNotModified) {
      throw new TelegramSetupError("Telegram returned an incomplete dialog list. Retry discovery.");
    }
    const dialogs = result.dialogs.filter((dialog): dialog is Api.Dialog => dialog instanceof Api.Dialog);
    const ids = new Set(dialogs.map(dialog => utils.getPeerId(dialog.peer)));
    for (const entity of result.chats) {
      if (!ids.has(utils.getPeerId(entity))) continue;
      const channel = channelDescriptor(entity, destinationId);
      if (channel) channels.set(channel.externalId, channel);
    }
    if (!(result instanceof Api.messages.DialogsSlice) || !dialogs.length) break;
    const last = dialogs.filter(dialog => !dialog.pinned).at(-1);
    if (!last) throw new TelegramSetupError("Telegram returned an incomplete dialog page. Retry discovery.");
    const lastId = utils.getPeerId(last.peer);
    const entity = [...result.chats, ...result.users].find(entity => utils.getPeerId(entity) === lastId);
    const message = result.messages.find(message =>
      (message instanceof Api.Message || message instanceof Api.MessageService) &&
      message.id === last.topMessage && utils.getPeerId(message.peerId) === lastId,
    );
    if (!entity || !(message instanceof Api.Message || message instanceof Api.MessageService)) {
      throw new TelegramSetupError("Telegram returned an incomplete dialog offset. Retry discovery.");
    }
    const nextOffset = lastId + ":" + message.id;
    if (nextOffset === previousOffset) throw new TelegramSetupError("Telegram dialog pagination stalled. Retry discovery.");
    previousOffset = nextOffset;
    offsetPeer = utils.getInputPeer(entity);
    offsetId = message.id;
    offsetDate = message.date;
    excludePinned = true;
  }
  return [...channels.values()].sort((a, b) => a.name.localeCompare(b.name));
}
