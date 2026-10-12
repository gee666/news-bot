import { Api, type TelegramClient } from "telegram";
import { parseID } from "telegram/Utils.js";
import { describe, expect, it, vi } from "vitest";
import { channelDescriptor, discoverChannels, inviteHash, resolveDestination } from "./discovery.js";

function bigId(value: string) {
  const parsed = parseID(value);
  if (!parsed) throw new Error("Invalid fixture ID");
  return parsed;
}

function channel(overrides: Partial<ConstructorParameters<typeof Api.Channel>[0]> = {}): Api.Channel {
  return new Api.Channel({
    id: bigId("1234"), accessHash: bigId("5678"), title: "Synthetic", photo: new Api.ChatPhotoEmpty(),
    date: 1, broadcast: true, ...overrides,
  });
}

describe("channel discovery", () => {
  it("resolves only by CheckChatInvite, without joining", async () => {
    const invoke = vi.fn<TelegramClient["invoke"]>().mockResolvedValue(new Api.ChatInviteAlready({ chat: channel() }));
    expect(await resolveDestination({ invoke }, "https://t.me/+synthetic")).toEqual({
      channelId: "-1001234", name: "Synthetic", inviteUrl: "https://t.me/+synthetic",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toBeInstanceOf(Api.messages.CheckChatInvite);
  });

  it("resolves the numeric ID from an API peek without joining or reading history", async () => {
    const invoke = vi.fn<TelegramClient["invoke"]>().mockResolvedValue(new Api.ChatInvitePeek({ chat: channel(), expires: 1 }));
    expect((await resolveDestination({ invoke }, "https://t.me/+synthetic")).channelId).toBe("-1001234");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("refuses discovery if an ordinary invite does not expose a numeric ID", async () => {
    const invoke = vi.fn<TelegramClient["invoke"]>().mockResolvedValue(new Api.ChatInvite({
      title: "Synthetic", photo: new Api.PhotoEmpty({ id: bigId("1") }),
      participantsCount: 1, color: 1, broadcast: true,
    }));
    await expect(resolveDestination({ invoke }, "https://t.me/+synthetic")).rejects.toThrow("has not joined");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("excludes groups, departed channels and the destination", () => {
    expect(channelDescriptor(channel(), "-1001234")).toBeNull();
    expect(channelDescriptor(channel({ megagroup: true }), "-1009999")).toBeNull();
    expect(channelDescriptor(channel({ broadcast: false }), "-1009999")).toBeNull();
    expect(channelDescriptor(channel({ left: true }), "-1009999")).toBeNull();
    expect(channelDescriptor(new Api.ChatEmpty({ id: bigId("1") }), "-1009999")).toBeNull();
  });

  it("stores stable IDs, peer metadata and public access", () => {
    expect(channelDescriptor(channel({ username: "synthetic" }), "-1009999")).toEqual({
      externalId: "-1001234", name: "Synthetic", originalUrl: "https://t.me/synthetic",
      access: "public", metadata: { channelId: "1234", accessHash: "5678", username: "synthetic" },
    });
    expect(channelDescriptor(channel(), "-1009999")?.access).toBe("restricted");
  });

  it("paginates raw subscribed dialogs, includes archived results and ignores non-dialog channels", async () => {
    const first = channel();
    const second = channel({ id: bigId("5678"), title: "Archived synthetic" });
    const unused = channel({ id: bigId("9999"), title: "Not subscribed" });
    const dialog = new Api.Dialog({
      peer: new Api.PeerChannel({ channelId: first.id }), topMessage: 11,
      readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0,
      unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}),
    });
    const archived = new Api.Dialog({
      peer: new Api.PeerChannel({ channelId: second.id }), topMessage: 12,
      readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0,
      unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}), folderId: 1,
    });
    const invoke = vi.fn<TelegramClient["invoke"]>()
      .mockResolvedValueOnce(new Api.messages.DialogsSlice({
        count: 2, dialogs: [dialog], chats: [first, unused], users: [],
        messages: [new Api.Message({ id: 11, date: 1000, message: "Never printed", peerId: dialog.peer })],
      }))
      .mockResolvedValueOnce(new Api.messages.Dialogs({ dialogs: [archived], chats: [second], users: [], messages: [] }));
    const result = await discoverChannels({ invoke }, "-1007777");
    expect(result.map(value => value.externalId).sort()).toEqual(["-1001234", "-1005678"]);
    expect(invoke).toHaveBeenCalledTimes(2);
    const secondRequest = invoke.mock.calls[1]?.[0];
    expect(secondRequest).toBeInstanceOf(Api.messages.GetDialogs);
    if (!(secondRequest instanceof Api.messages.GetDialogs)) throw new Error("Missing request");
    expect(secondRequest.offsetId).toBe(11);
    expect(secondRequest.offsetDate).toBe(1000);
    expect(secondRequest.offsetPeer).toBeInstanceOf(Api.InputPeerChannel);
    expect(secondRequest.folderId).toBeUndefined();
    expect(secondRequest.excludePinned).toBe(true);
  });

  it("validates destination URLs locally and does not echo invalid input", () => {
    expect(inviteHash("https://t.me/joinchat/synthetic")).toBe("synthetic");
    expect(() => inviteHash("https://untrusted.example/+private")).toThrow("Telegram HTTPS");
    expect(() => inviteHash("https://t.me/+synthetic?extra=1")).toThrow();
  });
});
