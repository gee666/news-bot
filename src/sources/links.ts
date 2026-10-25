import { cleanSourceUrl } from '../source-url.js';
import { createHash } from "node:crypto";
import type { SourceCollectedItem, TextLink } from "./types.js";
import { extractMarkdownLinks, markdownTree } from "./markdown.js";
import type { Nodes } from "mdast";
export { extractMarkdownLinks } from "./markdown.js";

export interface UrlEntity {
  kind: "url" | "text-url";
  offset: number;
  length: number;
  url?: string;
}

function isSpan(text: string, offset: number, length: number): boolean {
  return Number.isInteger(offset) && Number.isInteger(length) &&
    offset >= 0 && length > 0 && offset + length <= text.length;
}

function explicitUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || [...candidate].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return null;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:/iu.test(candidate) ? candidate : "https://" + candidate);
    return cleanSourceUrl(parsed.href);
  } catch { return null; }
}

/** Preserve URL evidence here. Fetching and rendering must enforce their own scheme policy. */
export function extractLinks(text: string, entities: readonly UrlEntity[] = []): TextLink[] {
  const links: TextLink[] = [];
  const occupied: { start: number; end: number }[] = [];
  for (const entity of entities) {
    if (!isSpan(text, entity.offset, entity.length)) continue;
    const anchorText = text.slice(entity.offset, entity.offset + entity.length);
    const url = explicitUrl(entity.kind === "text-url" ? entity.url ?? "" : anchorText);
    occupied.push({ start: entity.offset, end: entity.offset + entity.length });
    if (url) links.push({
      url, anchorText, startOffset: entity.offset, endOffset: entity.offset + entity.length,
      metadata: { hidden: entity.kind === "text-url" },
    });
  }
  const entitySpans = [...occupied];
  for (const link of extractMarkdownLinks(text)) {
    if (entitySpans.some(span => link.startOffset < span.end && link.endOffset > span.start)) continue;
    const plain = text.slice(link.startOffset, link.endOffset) === link.anchorText;
    links.push({ ...link, metadata: plain && link.metadata.kind === "reference" ? { hidden: false } : link.metadata });
    occupied.push({ start: link.startOffset, end: link.endOffset });
  }
  const leaves: { text: string; offset: number }[] = [];
  function collect(node: Nodes): void {
    const offset = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "text" && offset !== undefined && end !== undefined) leaves.push({ text: text.slice(offset, end), offset });
    if ("children" in node) node.children.forEach(collect);
  }
  collect(markdownTree(text));
  // This lexer sees only AST text leaves, never Markdown destinations/images/code.
  const pattern = /(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.)[^\s<>"']+/giu;
  for (const leaf of leaves) for (const match of leaf.text.matchAll(pattern)) {
    const start = leaf.offset + match.index;
    if (occupied.some(span => start < span.end && start + match[0].length > span.start)) continue;
    let anchorText = match[0].replace(/[.,!?;:]+$/u, "");
    // Trim sentence punctuation without discarding balanced URL parentheses.
    while (anchorText.endsWith(")") && (anchorText.match(/\)/gu)?.length ?? 0) >
      (anchorText.match(/\(/gu)?.length ?? 0)) anchorText = anchorText.slice(0, -1);
    const url = explicitUrl(anchorText);
    if (url) links.push({
      url, anchorText, startOffset: start, endOffset: start + anchorText.length,
      metadata: { hidden: false },
    });
  }
  const unique = new Map<string, TextLink>();
  for (const link of links) unique.set(JSON.stringify([link.url, link.startOffset, link.endOffset]), link);
  return [...unique.values()].sort((a, b) => a.startOffset - b.startOffset || a.url.localeCompare(b.url));
}

export function normalizeText(text: string): string { return text.replace(/\r\n?/gu, '\n').trim(); }
export function revisionHash(item: Pick<SourceCollectedItem, 'originalText' | 'links'> & { metadata?: Record<string, unknown> }): string {
  return createHash('sha256').update(JSON.stringify({ text: item.originalText,
    links: item.links.map(link => [link.url, link.anchorText, link.startOffset, link.endOffset,
      ...(link.metadata.format === 'markdown' ? [link.metadata.kind, link.metadata.evidenceEligible] : [])]),
    ...(Array.isArray(item.metadata?.media) && item.metadata.media.length ? { media: item.metadata.media } : {}),
  })).digest('hex');
}

// Missing flags preserve legacy/Telegram references. Malformed explicit policy is never evidence.
export const evidenceLinkSql = `jsonb_typeof(l.metadata)='object' AND
  (NOT (l.metadata ? 'evidenceEligible') OR l.metadata->'evidenceEligible'='true'::jsonb)`;
