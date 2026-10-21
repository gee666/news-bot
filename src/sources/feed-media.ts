import { z } from 'zod';
import { discoverMedia, mergeMedia, validatedMedia, type WebMedia } from './media.js';

const object = z.record(z.string(), z.unknown());
export function feedMedia(entry: Record<string, unknown>, base: string, text: (input: unknown) => string | null): WebMedia[] {
  const media: WebMedia[] = [];
  const values = (input: unknown): unknown[] => Array.isArray(input) ? input : [input];
  function attachments(input: unknown, tag: string, depth = 0): void {
    if (depth > 5) return;
    for (const value of values(input)) {
      const parsed = object.safeParse(value);
      if (!parsed.success) continue;
      const item = parsed.data;
      const mime = text(item['@_type']) ?? '';
      const medium = text(item['@_medium']);
      const url = text(item['@_url']) ?? (tag === 'link' && item['@_rel'] === 'enclosure' ? text(item['@_href']) : null);
      const type = /^video\//iu.test(mime) || medium === 'video' ? 'video'
        : /^image\//iu.test(mime) || medium === 'image' || tag === 'thumbnail' ? 'image' : null;
      if (url && type) media.push(...validatedMedia([{ type, url }], base));
      for (const key of ['content', 'thumbnail', 'group', 'enclosure']) if (item[key]) attachments(item[key], key, depth + 1);
    }
  }
  for (const key of ['enclosure', 'content', 'group', 'thumbnail', 'link']) attachments(entry[key], key);
  for (const key of ['encoded', 'content', 'description', 'summary']) {
    for (const value of values(entry[key])) {
      const html = text(value);
      if (html) media.push(...discoverMedia(html, base, 'html'));
    }
  }
  return mergeMedia(media);
}
