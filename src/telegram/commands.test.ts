import { describe, expect, it } from "vitest";
import { smokeOptions, smokeSamples } from "./commands.js";
import { history, item, source } from "./test-fixtures.js";

describe("read-only smoke command", () => {
  it("limits samples and excludes disabled/inactive sources", async () => {
    const news = item();
    const samples = await smokeSamples(
      history([{ sequence: 11, publishedAt: news.publishedAt, editedAt: null, item: news }]),
      [source({ enabled: false }), source({ active: false }), source()],
      smokeOptions([]), new Date("2025-09-29T12:00:00Z"),
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]?.items).toHaveLength(1);
    expect(samples[0]).not.toHaveProperty("accessHash");
    expect(samples[0]).not.toHaveProperty("metadata");
  });

  it("uses source-scoped identity or stable Telegram ID to select a source", async () => {
    const news = item();
    const options = smokeOptions(["--source", "-1001234", "--limit", "1", "--channels", "1"]);
    const samples = await smokeSamples(
      history([
        { sequence: 11, publishedAt: news.publishedAt, editedAt: null, item: news },
        { sequence: 12, publishedAt: news.publishedAt, editedAt: null, item: news },
      ]), [source()], options, new Date("2025-09-29T12:00:00Z"),
    );
    expect(samples[0]?.items).toHaveLength(1);
  });

  it("rejects unsafe limits, duplicate options and missing values", () => {
    expect(() => smokeOptions(["--limit", "0"])).toThrow();
    expect(() => smokeOptions(["--limit", "11"])).toThrow();
    expect(() => smokeOptions(["--source"])).toThrow();
    expect(() => smokeOptions(["--limit", "1", "--limit", "2"])).toThrow();
  });
});
