import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { publisherArticle, type PrimarySourceInput } from './config.js';

export interface PublisherEntry { id: string; url: string; title: string | null; publishedAt: Date | null }
const field = z.union([z.string(), z.object({ '#text': z.string().optional() })]);
function text(input: unknown): string | null {
  const parsed = field.safeParse(input);
  if (!parsed.success) return null;
  const value = typeof parsed.data === 'string' ? parsed.data : parsed.data['#text'] ?? null;
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value?.replace(/&(amp|lt|gt|quot|apos|#x[\da-fA-F]+|#\d+);/gu, (match: string, entity: string) => {
    if (entities[entity]) return entities[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  }) ?? null;
}
export function publisherDate(input: string | null): Date | null {
  if (!input || input.length > 100 || !/\d{4}/u.test(input)
    || !/(?:^\d{4}-\d{2}-\d{2}(?:T|$)|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)/u.test(input)) return null;
  if (/^\d{4}-\d{2}-\d{2}T/u.test(input) && !/(?:Z|[+-]\d{2}:?\d{2})$/u.test(input)) return null;
  const dateOnly = /^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/u.test(input);
  const date = new Date(dateOnly ? input + ' UTC' : input);
  if (Number.isNaN(date.getTime())) return null;
  if (dateOnly) {
    const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(input.slice(0, 3).toLowerCase());
    const day = Number(/\s(\d{1,2})/u.exec(input)?.[1]);
    if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(input) && new Date(input.slice(0, 10)).toISOString().slice(0, 10) !== input.slice(0, 10)) return null;
  return date;
}
const entry = z.object({
  title: z.unknown().optional(), link: z.unknown().optional(), guid: z.unknown().optional(),
  id: z.unknown().optional(), pubDate: z.unknown().optional(), published: z.unknown().optional(),
  date: z.unknown().optional(),
});
const root = z.object({
  rss: z.object({ channel: z.object({ item: z.array(entry).default([]) }) }).optional(),
  feed: z.object({ entry: z.array(entry).default([]) }).optional(),
});
export function parseFeed(xml: string, source: PrimarySourceInput): PublisherEntry[] {
  if (Buffer.byteLength(xml) > 1_000_000 || /<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml) || xml.includes('\0')
    || XMLValidator.validate(xml) !== true) throw new Error('invalid_feed_xml');
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
    parseTagValue: false, processEntities: false, isArray: name => ['item', 'entry'].includes(name) }).parse(xml);
  const doc = root.parse(parsed);
  if (!doc.rss && !doc.feed) throw new Error('unsupported_feed');
  const items = doc.rss?.channel.item ?? doc.feed?.entry ?? [];
  if (items.length > 1000) throw new Error('feed_item_limit');
  const results = new Map<string, PublisherEntry>();
  for (const item of items) {
    let link = text(item.link);
    if (!link) {
      const links = z.array(z.object({ '@_href': z.string(), '@_rel': z.string().optional() }))
        .safeParse(Array.isArray(item.link) ? item.link : [item.link]);
      link = links.success ? links.data.find(value => !value['@_rel'] || value['@_rel'] === 'alternate')?.['@_href'] ?? null : null;
    }
    const url = link ? publisherArticle(link, source) : null;
    if (!url) continue;
    const id = text(item.guid)?.trim() || text(item.id)?.trim() || url;
    if (id.length > 4096) throw new Error('feed_id_limit');
    results.set(id, { id, url, title: text(item.title)?.slice(0, 500) ?? null,
      publishedAt: publisherDate(text(item.pubDate) ?? text(item.published) ?? text(item.date)) });
  }
  return [...results.values()];
}
