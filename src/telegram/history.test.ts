import { Api } from "telegram";
import { parseID } from "telegram/Utils.js";
import { describe, expect, it, vi } from "vitest";
import { messageItem, TelegramHistory, type HistoryClient } from "./history.js";
import { source } from "./test-fixtures.js";

function message(text: string, date = 1759136400): Api.Message {
  const channelId = parseID("1234");
  if (!channelId) throw new Error("Invalid fixture ID");
  return new Api.Message({ id: 42, date, message: text, peerId: new Api.PeerChannel({ channelId }) });
}

describe("read-only Telegram history", () => {
  it("fetches history with a cutoff and stops at the rolling window, without read/view requests", async () => {
    const cutoff = new Date("2025-09-29T12:00:00Z");
    const since = new Date("2025-09-27T12:00:00Z");
    const iterMessages = vi.fn<HistoryClient["iterMessages"]>().mockImplementation(async function* () {
      yield message("after cutoff", cutoff.getTime() / 1000 + 1);
      yield message("at cutoff", cutoff.getTime() / 1000);
      yield message("at boundary", since.getTime() / 1000);
      yield message("old", since.getTime() / 1000 - 1);
      throw new Error("Reader must have stopped");
    });
    const entries = [];
    for await (const entry of new TelegramHistory({ iterMessages }).recent(source(), since, cutoff)) entries.push(entry);
    expect(entries.map(entry => entry.item?.originalText)).toEqual(["at cutoff", "at boundary"]);
    expect(iterMessages).toHaveBeenCalledOnce();
    expect(iterMessages.mock.calls[0]?.[0]).toBeInstanceOf(Api.InputPeerChannel);
    expect(iterMessages.mock.calls[0]?.[1]).toEqual({ offsetDate: cutoff.getTime() / 1000 + 1 });
  });

  it("uses caption text and hidden links, records edit time and restricted origin", () => {
    const post = message("😀 release");
    post.entities = [new Api.MessageEntityTextUrl({ offset: 3, length: 7, url: "https://example.com/release" })];
    post.editDate = post.date + 60;
    const parsed = messageItem(post, source());
    expect(parsed?.originalUrl).toBe("https://t.me/c/1234/42");
    expect(parsed?.metadata.access).toBe("restricted");
    expect(parsed?.editedAt).toEqual(new Date((post.date + 60) * 1000));
    expect(parsed?.links[0]?.anchorText).toBe("release");
    expect(parsed?.links[0]?.startOffset).toBe(3);
  });

  it("uses public origin URLs when a username is available", () => {
    expect(messageItem(message("text"), source({ metadata: { username: "synthetic", channelId: "1234" } }))?.originalUrl)
      .toBe("https://t.me/synthetic/42");
  });

  it("skips messages without usable text", () => {
    expect(messageItem(message(" \n "), source())).toBeNull();
  });
});
