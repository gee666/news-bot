import { describe, expect, it } from 'vitest';
import type { PublicationSnapshot } from '../types.js';
import { renderFullText, withUpdateMarker } from './full-text.js';
import { fullRepairPlan, fullRepairPlanHash, snapshotHash } from './approval.js';

const snapshot: PublicationSnapshot = { headline: 'Полная новость <&> 😀', details: 'Полный текст', score: 8, detailsKind: 'summary', sources: [] };

describe('complete publication text', () => {
  it('uses all 4096 units for version 1, retaining the old 3968-unit first part for legacy snapshots', () => {
    const content = { ...snapshot, headline: 'Новость', details: 'x'.repeat(10000) };
    const parts = renderFullText({ ...content, presentationVersion: 1 });
    expect(parts[0]?.plainText.length).toBe(4096);
    expect(parts[1]?.plainText.length).toBe(4096);
    expect(parts.map(part => part.plainText).join('')).toBe(`••••••••◦◦\nНовость\n\n${content.details}`);
    expect(renderFullText(content)[0]?.plainText.length).toBe(3968);
    const overhead = renderFullText({ ...content, presentationVersion: 1, details: '' })[0]!.plainText.length + 2;
    const exact = { ...content, presentationVersion: 1, details: 'x'.repeat(4096 - overhead) };
    expect(renderFullText(exact)).toHaveLength(1);
    expect(renderFullText(exact)[0]?.plainText.length).toBe(4096);
    expect(renderFullText({ ...exact, details: exact.details + 'x' }).map(part => part.plainText.length)).toEqual([4096, 1]);
    expect(() => withUpdateMarker(parts[0]!, 'https://t.me/c/123/1330')).toThrow('publication_message_too_long');
  });

  it.each([undefined, 1024])('budgets only an actual versioned update marker with first limit %s', firstLimit => {
    const content = { ...snapshot, presentationVersion: 1, details: 'x'.repeat(10000),
      updatedTo: 'https://t.me/c/123/1330', updatedToHeadline: 'Следующая новость <2>' };
    const parts = renderFullText(content, false, firstLimit);
    expect(parts[0]?.plainText.length).toBe(firstLimit ?? 4096);
    expect(parts[0]?.plainText).toMatch(/^UPD:\n🔸 #1330 · Следующая новость <2>\n\n/u);
    for (const part of parts) expect(part.plainText.length).toBeLessThanOrEqual(4096);
  });

  it.each([1, 2, 3, 4, 5, 6])('keeps source markers with a complete link character when only %s units remain', room => {
    const sources = [{ label: 'Статья 😀', url: 'https://example.org/article', primary: true,
      access: 'public', classification: 'relevant' }];
    const content = { ...snapshot, presentationVersion: 1, sources };
    const overhead = renderFullText({ ...content, details: '' })[0]!.plainText.indexOf('\n🔸 ');
    const parts = renderFullText({ ...content, details: 'x'.repeat(4096 - overhead - 2 - room) });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.plainText).not.toMatch(/🔸\s*$/u);
      for (const link of part.links) expect(part.plainText.slice(link.offset - 4, link.offset)).toBe('\n🔸 ');
    }
    expect(parts.flatMap(part => part.links.map(link => part.plainText.slice(link.offset, link.offset + link.length))).join(''))
      .toBe('example.org · Статья 😀');
  });

  it('starts oversized and entity-limit link fragments with their own marker and preserves all label characters', () => {
    const label = 'Название 😀 '.repeat(1000);
    const sources = Array.from({ length: 100 }, (_, index) => ({ label: index ? `Статья ${index}` : label,
      url: `https://example.org/${index}`, primary: true, access: 'public', classification: 'relevant' }));
    const parts = renderFullText({ ...snapshot, presentationVersion: 1, sources });
    for (const part of parts) {
      expect(part.plainText.length).toBeLessThanOrEqual(4096);
      expect(part.plainText).not.toMatch(/🔸\s*$/u);
      expect(part.links.length + (part.text.match(/<b>/gu)?.length ?? 0)).toBeLessThanOrEqual(90);
      for (const link of part.links) {
        expect(part.plainText.slice(link.offset - 4, link.offset)).toBe('\n🔸 ');
        expect(part.plainText.slice(link.offset, link.offset + link.length)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      }
    }
    const fragments = parts.flatMap(part => part.links.filter(link => link.url === sources[0]!.url)
      .map(link => part.plainText.slice(link.offset, link.offset + link.length)));
    expect(fragments.join('')).toBe('example.org · ' + label.trim());
  });

  it('reproduces frozen legacy full-repair hashes with and without a reviewed caption', () => {
    // Golden hashes checked against the unmodified legacy renderer, not a version-1 reconstruction.
    const legacy: PublicationSnapshot = { headline: 'Новость <AI> & SDK', details: '- Факт 😀\n'.repeat(1700), score: 8, detailsKind: 'summary',
      sources: [{ label: 'Канал · №32444', url: 'https://t.me/channel/32444', access: 'public', primary: false, classification: 'relevant' }] };
    const overview = { ...legacy, details: 'Краткий факт' };
    expect(fullRepairPlanHash(fullRepairPlan(legacy))).toBe('88d8dfa70d75afed38a36bb1b6cf4182bf9b666d7f6762475a2af6d741f6a686');
    expect(fullRepairPlanHash(fullRepairPlan(legacy, { snapshot: overview, snapshotHash: snapshotHash(overview) })))
      .toBe('e4b108948eb23f317dde503f1fcc01657b10a3651194f5b87bdb75be0974f0d4');
  });
  it.each([undefined, 1])('splits every UTF-16 character without losing text, emoji or HTML escapes for version %s', presentationVersion => {
    const details = 'Факты <&> 😀\n'.repeat(1700);
    const earlier = 'Предыдущие факты 😀\n'.repeat(400);
    const reason = 'Проверить точность формулировок '.repeat(30);
    const parts = renderFullText({ ...snapshot, presentationVersion, details, earlier, review: { supported: false, reason } });
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.map(part => part.plainText).join('')).toBe(`••••••••◦◦\n${snapshot.headline}\n\n${details}\n\n${earlier}\n\nЗаметки проверяющего: ${reason.trim()}`);
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
