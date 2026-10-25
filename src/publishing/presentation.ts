import type { PublicationSource } from '../types.js';

export const LIST_MARKER = '🔸 ';

function telegramPost(url: URL): string | undefined {
  if (!['t.me', 'telegram.me'].includes(url.hostname.replace(/^www\./u, ''))) return undefined;
  return /^\/(?:s\/)?(?:c\/\d+|[\w]+)\/([1-9]\d*)\/?$/u.exec(url.pathname)?.[1];
}

function readablePath(url: URL): string {
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Retain malformed percent escapes verbatim. */ }
  return path.replace(/\.[a-z\d]{1,5}$/iu, '').split('/').filter(Boolean).join(' / ').replace(/[-_]+/gu, ' ');
}

/** Labels change only at presentation time; frozen source provenance stays untouched. */
export function presentationSourceLabel(source: PublicationSource): string {
  const url = new URL(source.url);
  const post = telegramPost(url);
  const label = source.label.replace(/\s+/gu, ' ').trim();
  if (post && (source.previousPublication || source.relatedPublication)) {
    const headline = label.replace(new RegExp(`^[#№]\\s*${post}\\s*·\\s*`, 'u'), '');
    return `#${post} · ${headline}`;
  }
  if (['t.me', 'telegram.me'].includes(url.hostname.replace(/^www\./u, ''))) {
    const title = label.replace(/№\s*(\d+)/gu, '#$1');
    return post && !/(?:#|№)\s*\d+/u.test(title) ? `${title} · #${post}` : title;
  }
  const domain = url.hostname.replace(/^www\./u, '');
  // An already formatted label must not accumulate another domain on every render.
  const separator = label.indexOf(' · ');
  const prefix = label.slice(0, separator).replace(/^https?:\/\//iu, '').replace(/^www\./iu, '').replace(/\/$/u, '').toLowerCase();
  if (separator >= 0 && prefix === domain) return `${domain} · ${label.slice(separator + 3)}`;
  const addressLabel = label.replace(/^https?:\/\//iu, '').replace(/^www\./iu, '');
  if (addressLabel === domain || addressLabel.startsWith(domain + '/')
    || addressLabel.startsWith(domain) && /^:[0-9]+(?:\/|$)/u.test(addressLabel.slice(domain.length))) {
    // Old fallback labels may contain only a URL. Do not present a URL as an article title.
    const title = readablePath(url);
    return title ? `${domain} · ${title}` : domain;
  }
  return `${domain} · ${label}`;
}

/** Normalize explicit list markers, not punctuation inside prose, URLs or code. */
export function normalizeMarkedLists(text: string): string {
  let fence: { character: string; length: number } | undefined;
  let htmlCode = false;
  let inlineTicks = 0;
  return text.split('\n').map(line => {
    const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter && !inlineTicks && !htmlCode) {
      if (!fence) fence = { character: delimiter[0]!, length: delimiter.length };
      else if (delimiter[0] === fence.character && delimiter.length >= fence.length && /^\s*[`~]+\s*$/u.test(line)) fence = undefined;
      return line;
    }
    if (fence) return line;
    const protectedStart = htmlCode || inlineTicks > 0 || /^(?: {4}|\t)/u.test(line);
    const result = protectedStart ? line : line.replace(
      /^(\s*)(?:[-+*–—•◦▪▫‣⁃●○◆◇►▸▶🔹🔸]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(?=\S)/u,
      `$1${LIST_MARKER}`,
    );
    for (const token of line.matchAll(/<\/?(?:pre|code)\b[^>]*>|`+/giu)) {
      if (token[0].startsWith('<')) htmlCode = !token[0].startsWith('</');
      else if (!htmlCode) {
        if (!inlineTicks) inlineTicks = token[0].length;
        else if (inlineTicks === token[0].length) inlineTicks = 0;
      }
    }
    return result;
  }).join('\n');
}
