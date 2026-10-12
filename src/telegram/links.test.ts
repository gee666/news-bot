import { describe, expect, it } from "vitest";
import { extractLinks, normalizeText, revisionHash } from "./links.js";

describe("link extraction", () => {
  it("keeps hidden URL anchors in Telegram UTF-16 units after emoji", () => {
    const text = "😀 Read the announcement";
    const links = extractLinks(text, [{ kind: "text-url", offset: 8, length: 16, url: "https://example.com/release" }]);
    expect(links).toEqual([{
      url: "https://example.com/release", anchorText: "the announcement",
      startOffset: 8, endOffset: 24, metadata: { hidden: true },
    }]);
  });

  it("extracts plain entity URLs and omitted explicit URLs without overlap", () => {
    const text = "https://example.com/a and https://other.example/b.";
    const links = extractLinks(text, [{ kind: "url", offset: 0, length: 21 }]);
    expect(links).toHaveLength(2);
    expect(links[1]?.url).toBe("https://other.example/b");
    expect(links[1]?.anchorText).toBe("https://other.example/b");
    expect(links[1]?.startOffset).toBe(26);
    expect(links[1]?.endOffset).toBe(49);
  });

  it("preserves repeated destinations at distinct spans", () => {
    const links = extractLinks("one two", [
      { kind: "text-url", offset: 0, length: 3, url: "https://example.com" },
      { kind: "text-url", offset: 4, length: 3, url: "https://example.com" },
    ]);
    expect(links).toHaveLength(2);
    expect(links.map(link => link.startOffset)).toEqual([0, 4]);
  });

  it("keeps balanced URL parentheses and strips sentence punctuation", () => {
    expect(extractLinks("(https://example.com/a_(b)).")[0]?.url).toBe("https://example.com/a_(b)");
  });

  it("preserves non-HTTP evidence without fetching or deciding whether it is safe to render", () => {
    const links = extractLinks("download ftp://example.com/file and anchor", [
      { kind: "text-url", offset: 36, length: 6, url: "tg://resolve?domain=synthetic" },
    ]);
    expect(links.map(link => link.url)).toEqual(["ftp://example.com/file", "tg://resolve?domain=synthetic"]);
  });

  it("rejects invalid spans and malformed destinations", () => {
    expect(extractLinks("anchor", [
      { kind: "text-url", offset: -1, length: 3, url: "https://example.com" },
      { kind: "text-url", offset: 0, length: 99, url: "https://example.com" },
      { kind: "text-url", offset: 0, length: 6, url: "https:// bad" },
    ])).toEqual([]);
  });

  it("hashes hidden-target edits and text edits, not timestamps", () => {
    const first = { originalText: "read", links: extractLinks("read", [{ kind: "text-url", offset: 0, length: 4, url: "https://example.com/a" }]) };
    const changed = { originalText: "read", links: extractLinks("read", [{ kind: "text-url", offset: 0, length: 4, url: "https://example.com/b" }]) };
    expect(revisionHash(first)).not.toBe(revisionHash(changed));
    expect(revisionHash(first)).toBe(revisionHash(first));
    expect(normalizeText("  line\r\nnext\r  ")).toBe("line\nnext");
  });
});
