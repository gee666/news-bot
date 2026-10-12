import { publisherArticle, type PrimarySourceInput } from './config.js';
import { extractMarkdownLinks } from './markdown.js';
import { publisherDate, type PublisherEntry } from './feed.js';

const monthDate = /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}/u;
export function discoverWebsite(markdown: string, source: PrimarySourceInput): PublisherEntry[] {
  const found = new Map<string, PublisherEntry>();
  for (const link of extractMarkdownLinks(markdown.slice(0, 100_000), source.url)) {
    if (link.metadata.kind === 'asset' || link.metadata.kind === 'definition') continue;
    const url = publisherArticle(link.url, source);
    if (!url) continue;
    const label = link.anchorText;
    const date = /updated|last modified/iu.test(label) ? null
      : publisherDate(monthDate.exec(label)?.[0] ?? /\b\d{4}-\d{2}-\d{2}\b/u.exec(label)?.[0] ?? null);
    const previous = found.get(url);
    if (!previous || (!previous.publishedAt && date)) found.set(url, { id: url, url, title: label.trim(), publishedAt: date });
    if (found.size >= 100) break;
  }
  return [...found.values()];
}

/** Only explicitly labelled article-front-matter dates; never arbitrary related-card dates. */
export function articlePublication(markdown: string): Date | null {
  const front = markdown.slice(0, 2000).split('\n').slice(0, 30);
  const heading = front.findIndex(line => /^#\s/u.test(line));
  if (heading < 0) return null;
  for (const [index, line] of front.entries()) {
    if (/^##\s/u.test(line)) break;
    if (/related|keep reading|more stories/iu.test(line)) break;
    if (!/Published/u.test(line) && Math.abs(index - heading) > 3) continue;
    if (!/^\s*(?:Published(?:\s+on)?\s*:?\s*)?(?:[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\s*$/u.test(line)) continue;
    return publisherDate(line.replace(/^\s*Published(?:\s+on)?\s*:?\s*/u, '').trim());
  }
  return null;
}
