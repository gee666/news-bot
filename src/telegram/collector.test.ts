import { describe, expect, it, vi } from "vitest";
import { collectSource } from "./collector.js";
import { history, item, source } from "./test-fixtures.js";
import type { CollectionStore } from "./collector.js";

const cutoff = new Date("2025-09-29T12:00:00Z");

describe("batch collection", () => {
  it('caps the descending fetch without advancing over omitted messages', async () => {
    const entries = [15, 14, 13, 12, 11].map(sequence => {
      const news = item({ externalId: String(sequence) });
      return { sequence, publishedAt: news.publishedAt, editedAt: null, item: news };
    });
    const original = history(entries);
    const recent = vi.fn(original.recent);
    const commitSource = vi.fn<CollectionStore['commitSource']>().mockResolvedValue(2);
    await collectSource({ recent }, { commitSource }, 'batch', source(), cutoff, 48, 2);
    expect(recent).toHaveBeenCalledWith(source(), expect.any(Date), cutoff, 2);
    expect(commitSource).toHaveBeenCalledWith('batch', source(), entries.slice(0, 2).map(entry => entry.item), source().cursor);
  });
  it("uses a fixed 48-hour window, defers later messages and edits, and persists cursor after items", async () => {
    const inside = item();
    const boundary = item({ externalId: "9", publishedAt: new Date("2025-09-27T12:00:00Z") });
    const old = item({ publishedAt: new Date("2025-09-27T11:59:59Z") });
    const future = item({ publishedAt: new Date("2025-09-29T12:00:01Z") });
    const edited = item({ editedAt: new Date("2025-09-29T12:00:01Z") });
    const reader = history([
      { sequence: 18, publishedAt: future.publishedAt, editedAt: null, item: future },
      { sequence: 17, publishedAt: edited.publishedAt, editedAt: edited.editedAt, item: edited },
      { sequence: 16, publishedAt: inside.publishedAt, editedAt: null, item: null },
      { sequence: 11, publishedAt: inside.publishedAt, editedAt: null, item: inside },
      { sequence: 9, publishedAt: boundary.publishedAt, editedAt: null, item: boundary },
      { sequence: 8, publishedAt: old.publishedAt, editedAt: null, item: old },
    ]);
    const commitSource = vi.fn<CollectionStore["commitSource"]>().mockResolvedValue(2);
    expect(await collectSource(reader, { commitSource }, "batch", source(), cutoff)).toBe(2);
    expect(commitSource).toHaveBeenCalledOnce();
    expect(commitSource).toHaveBeenCalledWith("batch", source(), [inside, boundary], {
      lastMessageId: 16, cutoff: cutoff.toISOString(),
    });
  });

  it("revisits edits behind the high-water mark", async () => {
    const edited = item({ externalId: "5", editedAt: new Date("2025-09-29T11:00:00Z") });
    const commitSource = vi.fn<CollectionStore["commitSource"]>().mockResolvedValue(1);
    await collectSource(history([{ sequence: 5, publishedAt: edited.publishedAt, editedAt: edited.editedAt, item: edited }]),
      { commitSource }, "batch", source(), cutoff);
    expect(commitSource).toHaveBeenCalledWith("batch", source(), [edited], { lastMessageId: 10, cutoff: cutoff.toISOString() });
  });

  it("never commits or advances a cursor after an interrupted history fetch", async () => {
    const news = item();
    const commitSource = vi.fn<CollectionStore["commitSource"]>();
    await expect(collectSource(history([{ sequence: 11, publishedAt: news.publishedAt, editedAt: null, item: news }], true),
      { commitSource }, "batch", source(), cutoff)).rejects.toThrow("interruption");
    expect(commitSource).not.toHaveBeenCalled();
  });

  it("rejects a collection window exceeding the initial import limit", async () => {
    const commitSource = vi.fn<CollectionStore["commitSource"]>();
    await expect(collectSource(history([]), { commitSource }, "batch", source(), cutoff, 49)).rejects.toThrow();
    expect(commitSource).not.toHaveBeenCalled();
  });
});
