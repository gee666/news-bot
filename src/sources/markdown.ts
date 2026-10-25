import { cleanSourceUrl } from '../source-url.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString } from 'mdast-util-to-string';
import type { Nodes, Root, Definition } from 'mdast';
import type { TextLink } from './types.js';

const parser = unified().use(remarkParse).use(remarkGfm);
export function markdownTree(text: string): Root { return parser.parse(text); }
const ancillaryHeading = /^(?:acknowledg(?:e)?ments?|authors?|contributors?|credits|comments?|discussion|community|related (?:articles|posts|stories)|recommended|share(?: this (?:article|post))?|social(?: links)?)\s*$/iu;
function destination(value: string, baseUrl?: string): string | null {
  try { return cleanSourceUrl(baseUrl ? new URL(value, baseUrl).href : new URL(value).href); } catch { return null; }
}
function visibleText(node: Nodes): string {
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map(visibleText).join('') : '';
}

/** CommonMark/GFM source offsets are JavaScript UTF-16 offsets, not bytes or rendered-text offsets. */
export function extractMarkdownLinks(text: string, baseUrl?: string): TextLink[] {
  const tree = markdownTree(text);
  const definitions = new Map<string, Definition>();
  function define(node: Nodes): void {
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node);
    if ('children' in node) node.children.forEach(define);
  }
  define(tree);
  const links: TextLink[] = [];
  function visit(node: Nodes, ancillary: boolean): void {
    const reference = node.type === 'linkReference' || node.type === 'imageReference'
      ? definitions.get(node.identifier.toUpperCase()) : undefined;
    const raw = node.type === 'link' || node.type === 'image' || node.type === 'definition' ? node.url : reference?.url;
    const url = raw ? destination(raw, baseUrl) : null;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (url && start !== undefined && end !== undefined) {
      const asset = node.type === 'image' || node.type === 'imageReference';
      const emptyAnchor = (node.type === 'link' || node.type === 'linkReference') && !visibleText(node).trim();
      const samePage = baseUrl && new URL(url).hash && url.split('#')[0] === baseUrl.split('#')[0];
      const kind = node.type === 'definition' ? 'definition' : asset ? 'asset' : ancillary || samePage || emptyAnchor ? 'navigation' : 'reference';
      links.push({ url, anchorText: toString(node), startOffset: start, endOffset: end,
        metadata: { hidden: node.type === 'linkReference', format: 'markdown', kind, evidenceEligible: kind === 'reference' && ['http:', 'https:'].includes(new URL(url).protocol) } });
    }
    if ('children' in node) node.children.forEach(child => visit(child, ancillary));
  }
  let ancillaryDepth: number | null = null;
  for (const node of tree.children) {
    if (node.type === 'heading') {
      if (ancillaryDepth !== null && node.depth <= ancillaryDepth) ancillaryDepth = null;
      if (ancillaryHeading.test(toString(node).trim())) ancillaryDepth = node.depth;
    }
    visit(node, ancillaryDepth !== null);
  }
  return links.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
}
