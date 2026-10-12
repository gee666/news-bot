import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn<(sql: string, parameters?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(),
  release: vi.fn(),
}));
vi.mock("pg", () => ({
  default: { Pool: class {
    query = mocks.query;
    on = vi.fn();
    async connect() { return { query: mocks.query, release: mocks.release }; }
  } },
}));

import { parseSource, prepareBatchSources, refreshSources } from "./repository.js";

const destination = { channelId: "-1009999", name: "Synthetic destination", inviteUrl: "https://t.me/+synthetic" };
const channel = {
  externalId: "-1001234", name: "Synthetic", originalUrl: null, access: "restricted",
  metadata: { channelId: "1234", accessHash: "5678", username: null },
} satisfies Parameters<typeof refreshSources>[0][number];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("source discovery persistence", () => {
  it("preserves manually disabled sources on rediscovery and marks departures inactive", async () => {
    await refreshSources([channel], destination);
    const queries = mocks.query.mock.calls.map(call => call[0]);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("active=false");
    const upsert = queries.find(sql => sql.includes("INSERT INTO sources"));
    expect(upsert?.split("DO UPDATE")[1]).not.toContain("enabled");
    expect(upsert).toContain("active=true");
    expect(queries.some(sql => sql.includes("DELETE"))).toBe(false);
    expect(queries).toContain("COMMIT");
    expect(mocks.query.mock.calls.find(call => call[0].includes("operational_state"))?.[1])
      .toEqual([JSON.stringify(destination)]);
  });

  it("never registers the destination as an input even if accidentally passed in", async () => {
    await refreshSources([{ ...channel, externalId: destination.channelId }], destination);
    expect(mocks.query.mock.calls.some(call => call[0].includes("INSERT INTO sources"))).toBe(false);
  });

  it("rolls back the refresh if any source fails to save", async () => {
    mocks.query.mockImplementation(async sql => {
      if (sql.includes("INSERT INTO sources")) throw new Error("Synthetic database failure");
      return { rows: [] };
    });
    await expect(refreshSources([channel], destination)).rejects.toThrow("database failure");
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("validates stored source metadata and defaults an empty initial cursor", () => {
    const saved = parseSource({
      id: "11111111-1111-4111-8111-111111111111", external_id: "-1001234", name: "Synthetic",
      access: "restricted", enabled: false, active: true, metadata: {}, collection_cursor: {},
    });
    expect(saved.cursor).toEqual({ lastMessageId: 0, cutoff: null });
    expect(saved.enabled).toBe(false);
    expect(() => parseSource({ ...saved, access: "invalid" })).toThrow();
  });

  it("resumes existing batch membership instead of enrolling newly discovered sources", async () => {
    await prepareBatchSources("11111111-1111-4111-8111-111111111111");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("NOT EXISTS(SELECT 1 FROM batch_sources bs JOIN sources prior");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("prior.connector_type=\x27telegram\x27");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("bs.cursor_before AS collection_cursor");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("bs.status <> 'completed'");
  });
});
