import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn<(sql: string, parameters?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(),
  release: vi.fn(),
}));
vi.mock("pg", () => ({
  default: { Pool: class {
    on = vi.fn();
    async connect() { return { query: mocks.query, release: mocks.release }; }
  } },
}));

import { PostgresSourceCollectionStore } from "../sources/collection-store.js";
import { extractLinks } from "../sources/links.js";
import { item, source } from "./test-fixtures.js";

const itemId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const cursor = { lastMessageId: 11, cutoff: "2025-09-29T12:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async sql => {
    if (sql.startsWith("SELECT status")) return { rows: [{ status: "pending" }] };
    if (sql.includes("INSERT INTO source_items")) return { rows: [{ id: itemId, current_revision_id: null }] };
    if (sql.includes("INSERT INTO item_revisions")) return { rows: [{ id: revisionId }] };
    return { rows: [] };
  });
});

describe("revision-aware transactional collection", () => {
  it("saves links and batch membership before advancing cursor in the same transaction", async () => {
    const news = item({ originalText: "read", links: extractLinks("read", [
      { kind: "text-url", offset: 0, length: 4, url: "https://example.com/release" },
    ]) });
    const store = new PostgresSourceCollectionStore();
    expect(await store.commitSource("batch", source(), [news], cursor)).toBe(1);
    const queries = mocks.query.mock.calls.map(call => call[0]);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("FOR UPDATE");
    expect(queries.findIndex(sql => sql.includes("INSERT INTO item_links")))
      .toBeLessThan(queries.findIndex(sql => sql.includes("SET current_revision_id")));
    expect(queries.findIndex(sql => sql.includes("INSERT INTO batch_items")))
      .toBeLessThan(queries.findIndex(sql => sql.includes("SET collection_cursor")));
    expect(queries.at(-1)).toBe("COMMIT");
    const values = mocks.query.mock.calls.find(call => call[0].includes("INSERT INTO item_links"))?.[1];
    expect(values?.slice(0, 5)).toEqual([revisionId, "https://example.com/release", "read", 0, 4]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("does not re-extract links or replay an unchanged revision into a new batch", async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.startsWith("SELECT status")) return { rows: [{ status: "pending" }] };
      if (sql.includes("INSERT INTO source_items")) return { rows: [{ id: itemId, current_revision_id: revisionId }] };
      if (sql.startsWith("SELECT id FROM item_revisions")) return { rows: [{ id: revisionId }] };
      return { rows: [] };
    });
    expect(await new PostgresSourceCollectionStore().commitSource("batch", source(), [item()], cursor)).toBe(0);
    expect(mocks.query.mock.calls.some(call => call[0].includes("INSERT INTO item_links"))).toBe(false);
    expect(mocks.query.mock.calls.some(call => call[0].includes("INSERT INTO batch_items"))).toBe(false);
    expect(mocks.query.mock.calls.some(call => call[0].includes("SET collection_cursor"))).toBe(true);
  });

  it("rolls back items and never advances cursor when link persistence fails", async () => {
    const original = mocks.query.getMockImplementation();
    mocks.query.mockImplementation(async (sql, parameters) => {
      if (sql.includes("INSERT INTO item_links")) throw new Error("Synthetic link failure");
      if (!original) throw new Error("Missing fixture mock");
      return await original(sql, parameters);
    });
    const news = item({ links: extractLinks("https://example.com") });
    await expect(new PostgresSourceCollectionStore().commitSource("batch", source(), [news], cursor)).rejects.toThrow("link failure");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocks.query.mock.calls.some(call => call[0].includes("SET collection_cursor"))).toBe(false);
  });

  it("does not change a completed batch source on resume", async () => {
    mocks.query.mockResolvedValue({ rows: [{ status: "completed" }] });
    expect(await new PostgresSourceCollectionStore().commitSource("batch", source(), [item()], cursor)).toBe(0);
    expect(mocks.query.mock.calls.map(call => call[0])).toHaveLength(3);
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT");
  });
});
