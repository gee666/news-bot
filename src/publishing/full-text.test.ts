import { describe, expect, it } from 'vitest';
import type { PublicationSnapshot } from '../types.js';
import { renderFullText, withUpdateMarker } from './full-text.js';

const snapshot: PublicationSnapshot = { headline: 'Полная новость <&> 😀', details: 'Полный текст', score: 8, detailsKind: 'summary', sources: [] };

describe('complete publication text', () => {
  it('splits every UTF-16 character without losing text, emoji or HTML escapes', () => {
    const details = 'Факты <&> 😀\n'.repeat(1700);
    const earlier = 'Предыдущие факты 😀\n'.repeat(400);
    const reason = 'Проверить точность формулировок '.repeat(30);
    const parts = renderFullText({ ...snapshot, details, earlier, review: { supported: false, reason } });
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.map(part => part.plainText).join('')).toBe(`••••••••◦◦\n${snapshot.headline}\n\nНовое\n${details}\n\nРанее было опубликовано\n${earlier}\n\nЗаметки проверяющего: ${reason.trim()}`);
    for (const part of parts) {
      expect(part.plainText.length).toBeLessThanOrEqual(4096);
      expect(part.plainText).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      expect(part.text).not.toContain('<&>');
    }
  });

  it('keeps all 230 sources and every previous-publication link across entity-limited parts', () => {
    const sources = Array.from({ length: 230 }, (_, index) => ({ label: `Источник ${index}`, url: `https://example.org/${index}`,
      primary: false, access: 'public' as const, classification: 'relevant' as const, ...(index > 200 ? { previousPublication: true } : {}) }));
    const parts = renderFullText({ ...snapshot, sources });
    const links = parts.flatMap(part => part.links);
    expect(links.map(link => link.url).sort()).toEqual(sources.map(source => source.url).sort());
    for (const part of parts) {
      expect(part.links.length + (part.text.match(/<b>/gu)?.length ?? 0)).toBeLessThanOrEqual(90);
      for (const link of part.links) expect(part.plainText.slice(link.offset,link.offset+link.length)).toMatch(/^Источник \d+$/u);
    }
  });

  it('reserves room for the newest actual URL and does not change the original first part', () => {
    const [first] = renderFullText({ ...snapshot, details: '😀'.repeat(5000) });
    if (!first) throw new Error('First part missing');
    const url = 'https://t.me/c/1234567890/987654321';
    const marked = withUpdateMarker(first,url);
    expect(marked.plainText).toBe(`UPD: ${url}\n\n${first.plainText}`);
    expect(marked.plainText.length).toBeLessThanOrEqual(4096);
    expect(marked.links[0]).toEqual({ offset: 5, length: url.length, url });
  });
});
