import { JSDOM } from 'jsdom';
import { z } from 'zod';
import type { Nodes } from 'mdast';
import { publicUrl } from '../pipeline/research-fetch.js';
import { markdownTree } from './markdown.js';
import { decorativeImage } from './media-policy.js';

export const webMediaSchema = z.object({ type: z.enum(['image', 'video']), url: z.string().max(4096) });
export type WebMedia = z.infer<typeof webMediaSchema>;
const ancillary = 'nav,header,footer,aside,[role="navigation"],[role="contentinfo"],[itemprop="comment"]';
const ancillaryHeading = /^(?:authors?|contributors?|credits|comments?|discussion|community|related (?:articles|posts|stories)|recommended|share(?: this (?:article|post))?|social(?: links)?)$/iu;

function mediaUrl(value: string, base: string): string | null {
  if (!value.trim() || value.length > 4096) return null;
  try { return publicUrl(new URL(value, base).href).href; } catch { return null; }
}
export function mergeMedia(...groups: readonly (readonly WebMedia[])[]): WebMedia[] {
  return [...new Map(groups.flat().map(media => [media.type + ':' + media.url, media])).values()].slice(0, 100);
}
export function validatedMedia(input: unknown, base: string): WebMedia[] {
  if (!Array.isArray(input)) return [];
  return mergeMedia(input.slice(0, 100).flatMap(value => {
    const result = webMediaSchema.safeParse(value);
    const url = result.success ? mediaUrl(result.data.url, base) : null;
    return result.success && url && (result.data.type !== 'image' || !decorativeImage(url))
      ? [{ type: result.data.type, url }] : [];
  }));
}
function srcset(value: string | null): string | null {
  return value?.split(',').map(part => part.trim().split(/\s+/u)[0]).filter(Boolean).at(-1) ?? null;
}
function imageSource(image: Element): string | null {
  return image.getAttribute('data-src') || image.getAttribute('data-original')
    || srcset(image.getAttribute('data-srcset')) || srcset(image.getAttribute('srcset'))
    || srcset(image.closest('picture')?.querySelector('source[srcset]')?.getAttribute('srcset') ?? null)
    || image.getAttribute('src');
}
function decorative(image: Element): boolean {
  const size = ['width', 'height'].map(name => Number.parseFloat(image.getAttribute(name) ?? ''));
  return size.some(value => value > 0 && value <= 2)
    || decorativeImage(image.getAttribute('class'), image.getAttribute('id'), image.getAttribute('alt'),
      image.getAttribute('title'), imageSource(image))
    || Boolean(image.closest('[class*="author-bio"],[class*="author-card"],[class*="author-info"],'
      + '[class*="avatar"],[class*="site-brand"],[class*="social-share"]'));
}

/** Run on selected content only. Never executes scripts or requests image/video resources. */
export function elementMedia(root: ParentNode, base: string, include: (node: Element) => boolean = () => true): WebMedia[] {
  const media: WebMedia[] = [];
  for (const node of root.querySelectorAll('img,video,video source')) {
    if (node.closest(ancillary) || !include(node)) continue;
    const type = node.tagName === 'IMG' ? 'image' : 'video';
    if (type === 'image' && decorative(node)) continue;
    const raw = type === 'image' ? imageSource(node) : node.getAttribute('src') || node.getAttribute('data-src');
    const url = raw ? mediaUrl(raw, base) : null;
    if (url) media.push({ type, url });
  }
  return mergeMedia(media);
}

/** Keep lazy images and native video destinations through Readability and Markdown conversion. */
export function prepareArticleMedia(root: ParentNode, base: string): void {
  for (const image of root.querySelectorAll('img')) {
    const raw = imageSource(image);
    const url = raw ? mediaUrl(raw, base) : null;
    if (url && !decorative(image)) image.setAttribute('src', url);
    else image.remove();
  }
  for (const video of root.querySelectorAll('video')) {
    const links = video.ownerDocument.createElement('p');
    const sources = [video, ...video.querySelectorAll('source')];
    const media = mergeMedia(sources.flatMap(source => {
      const raw = source.getAttribute('src') || source.getAttribute('data-src');
      const url = raw ? mediaUrl(raw, base) : null;
      return url ? [{ type: 'video' as const, url }] : [];
    }));
    for (const item of media) {
      const link = video.ownerDocument.createElement('a');
      link.href = item.url; link.title = 'video'; link.textContent = 'Video';
      links.append(link, ' ');
    }
    video.replaceWith(links);
  }
}

export function discoverMedia(content: string, base: string, format: 'markdown' | 'html' = 'markdown'): WebMedia[] {
  if (Buffer.byteLength(content) > 5_000_000) return [];
  if (format === 'html') {
    if (!/<(?:img|video|picture)\b/iu.test(content)) return [];
    const dom = new JSDOM(content);
    try { return elementMedia(dom.window.document, base); } finally { dom.window.close(); }
  }
  const tree = markdownTree(content);
  const definitions = new Map<string, string>();
  function define(node: Nodes): void {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node.url);
    if ('children' in node) node.children.forEach(define);
  }
  define(tree);
  const media: WebMedia[] = [];
  function visit(node: Nodes): void {
    const raw = node.type === 'image' || node.type === 'link' ? node.url
      : node.type === 'imageReference' ? definitions.get(node.identifier.toUpperCase()) : undefined;
    const url = raw ? mediaUrl(raw, base) : null;
    if (url) {
      const image = node.type === 'image' || node.type === 'imageReference';
      const video = node.type === 'link' && (node.title === 'video' || /\.(?:mp4|webm|mov|m4v|ogv)$/iu.test(new URL(url).pathname));
      const alt = node.type === 'image' || node.type === 'imageReference' ? node.alt : null;
      if (video || image && !decorativeImage(url, alt, 'title' in node ? node.title : null)) {
        media.push({ type: video ? 'video' : 'image', url });
      }
    }
    if (node.type === 'html') media.push(...discoverMedia(node.value, base, 'html'));
    if ('children' in node) node.children.forEach(visit);
  }
  let ancillaryDepth: number | null = null;
  for (const node of tree.children) {
    if (node.type === 'heading') {
      if (ancillaryDepth !== null && node.depth <= ancillaryDepth) ancillaryDepth = null;
      const heading = node.children.filter(child => child.type === 'text').map(child => child.value).join('');
      if (ancillaryHeading.test(heading.trim())) ancillaryDepth = node.depth;
    }
    if (ancillaryDepth === null) visit(node);
  }
  return mergeMedia(media);
}
