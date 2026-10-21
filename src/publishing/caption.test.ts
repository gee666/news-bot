import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import type { PublicationSnapshot } from '../types.js';
import { CAPTION_LIMIT, renderCaption } from './caption.js';
import { render } from './render.js';
const content: PublicationSnapshot = { headline: 'Компания выпустила модель <AI>', score: 7,
  details: 'Модель работает с изображениями и текстом.', detailsKind: 'summary', sources: [
    { label: 'Официальное объявление', url: 'https://example.org/release', primary: true, access: 'public', classification: 'relevant' },
  ] };

function verifyCaption(snapshot: PublicationSnapshot) {
  const caption = renderCaption(snapshot);
  expect(caption.plainText.length).toBeLessThanOrEqual(CAPTION_LIMIT);
  expect(new JSDOM(`<body>${caption.text}</body>`).window.document.body.textContent).toBe(caption.plainText);
  expect(caption.plainText).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  for (const link of caption.links) {
    expect(caption.plainText.slice(link.offset, link.offset + link.length)).not.toBe('');
    expect(snapshot.sources.some(source => source.url === link.url)).toBe(true);
  }
  return caption;
}

describe('album caption rendering', () => {
  it('renders the topic and text as a single bounded HTML caption', () => {
    const caption = verifyCaption(content);
    expect(caption.text).toContain('<b>Компания выпустила модель &lt;AI&gt;</b>');
    expect(caption.plainText).toContain(content.details);
    expect(caption.links).toHaveLength(1);
  });
  it('shortens long news without cutting HTML entities or source links', () => {
    const snapshot = { ...content, details: 'Факты <новость> & "текст" 😀. '.repeat(1000) };
    const caption = verifyCaption(snapshot);
    expect(caption.plainText).toContain('…');
    expect(caption.text).toContain('https://example.org/release');
    expect(snapshot.details.length).toBeGreaterThan(10000);
  });
  it('bounds all overhead and selects up to three primary-first sources', () => {
    const sources = Array.from({ length: 90 }, (_, index) => ({ ...content.sources[0]!,
      label: 'Очень длинное название <источника> '.repeat(100), url: `https://example.org/${index}`,
      primary: index > 0, classification: 'uncertain' as const, access: 'restricted' as const }));
    const snapshot = { ...content, headline: 'Длинный заголовок 😀 '.repeat(100), details: 'Новые важные сведения. '.repeat(100),
      earlier: 'Предыдущие подробности. '.repeat(100), review: { supported: false, reason: 'Не подтверждено источником. '.repeat(100) }, sources };
    const caption = verifyCaption(snapshot);
    expect(caption.links).toHaveLength(3);
    expect(caption.links[0]?.url).not.toBe(sources[0]?.url);
    expect(caption.plainText).toContain('Новые важные сведения');
    expect(caption.plainText).toContain('Не подтверждено');
    expect(snapshot.sources).toHaveLength(90);
  });
  it('counts decoded text, not escaped HTML or URL length', () => {
    const snapshot = { ...content, details: '<&>'.repeat(2000), sources: [{ ...content.sources[0]!,
      url: 'https://example.org/' + 'x'.repeat(5000) }] };
    expect(verifyCaption(snapshot).text.length).toBeGreaterThan(CAPTION_LIMIT);
  });
  it('leaves text-only rendering at the normal 4096-character budget', () => {
    const snapshot = { ...content, details: 'Подробная новость. '.repeat(150) };
    expect(render(snapshot).plainText.length).toBeGreaterThan(CAPTION_LIMIT);
    verifyCaption(snapshot);
  });
  it('rejects invalid snapshots rather than sending malformed captions', () => {
    expect(() => renderCaption({ ...content, score: 0 })).toThrow('publication_snapshot_invalid');
    expect(() => renderCaption({ ...content, sources: [{ ...content.sources[0], url: 'javascript:alert(1)' }] })).toThrow('publication_snapshot_invalid');
  });
});


it.each([false, true])('does not reapply editorial validation to shortened review text with supported=%s', supported => {
  const snapshot = { ...content, review: { supported, reason: 'API '.repeat(30) + 'не подтверждено' } };
  const caption = verifyCaption(snapshot);
  expect(caption.plainText).toContain('Заметки проверяющего: API');
  expect(caption.plainText).toContain('…');
  expect(snapshot.review.reason).toContain('не подтверждено');
});
