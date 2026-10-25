import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { publicationSnapshotSchema, type PublicationSnapshot, type PublicationSource } from '../types.js';
import { render, withUpdateMarker } from './render.js';
import { normalizeMarkedLists, presentationSourceLabel } from './presentation.js';

const source = (label: string, url: string, flags: Partial<PublicationSource> = {}): PublicationSource => ({
  label, url, primary: false, access: 'public', classification: 'relevant', ...flags,
});
const snapshot: PublicationSnapshot = { presentationVersion: 1, headline: 'Новость', details: 'Факты',
  score: 8, detailsKind: 'summary', sources: [] };

describe('versioned publication presentation', () => {
  it.each([
    ['https://www.github.com/org/repo', 'Проект <AI> & SDK', 'github.com · Проект <AI> & SDK'],
    ['https://news.example.org:8443/story', 'Статья', 'news.example.org · Статья'],
    ['https://example.org/story', 'example.org · Статья', 'example.org · Статья'],
    ['https://www.example.org/story', 'www.example.org · Статья', 'example.org · Статья'],
    ['https://www.example.org/story', 'https://WWW.example.org/ · Статья', 'example.org · Статья'],
    ['https://example.org/story', 'example.org: заголовок', 'example.org · example.org: заголовок'],
    ['https://github.com/org/repo', 'https://github.com/org/repo', 'github.com · org / repo'],
    ['https://github.com/org/repo', 'github.com/org/repo', 'github.com · org / repo'],
    ['https://example.org/', 'https://example.org/', 'example.org'],
    ['https://example.org/%D0%9D%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D1%8C/new-model.html', 'example.org/old-path', 'example.org · Новость / new model'],
    ['https://example.org/%FF', 'https://example.org/%FF', 'example.org · %FF'],
    ['https://t.me/backdoor/32444', 'Бэкдор · №32444', 'Бэкдор · #32444'],
    ['https://telegram.me/backdoor/32444', 'Бэкдор', 'Бэкдор · #32444'],
    ['https://t.me/s/backdoor/32444', 'Бэкдор · #32444', 'Бэкдор · #32444'],
    ['https://t.me/c/123/32444?single', 'Бэкдор · №32444 / Другая подписка · №32444', 'Бэкдор · #32444 / Другая подписка · #32444'],
  ])('formats %s with label %s', (url, label, expected) => {
    const input = source(label, url);
    expect(presentationSourceLabel(input)).toBe(expected);
    expect(presentationSourceLabel({ ...input, label: expected })).toBe(expected);
    expect(input.label).toBe(label);
  });

  it.each(['previousPublication', 'relatedPublication'] as const)('numbers internal %s links without duplicating the prefix', flag => {
    const input = source('Заголовок <2> & SDK', 'https://t.me/c/123/1330', { [flag]: true });
    const label = presentationSourceLabel(input);
    expect(label).toBe('#1330 · Заголовок <2> & SDK');
    expect(presentationSourceLabel({ ...input, label })).toBe(label);
  });

  it.each([
    ['text', (input: PublicationSnapshot) => [render(input)]],
  ] as const)('uses separate bullet lines and exact escaped link offsets in %s', (_name, renderParts) => {
    const input = { ...snapshot, sources: [
      source('Название <AI> & "SDK"', 'https://www.github.com/org/repo?x=1&y=2'),
      source('Бэкдор · №32444', 'https://t.me/backdoor/32444'),
      source('Предыстория', 'https://t.me/c/123/1330', { previousPublication: true }),
    ] };
    const parts = renderParts(input);
    expect(parts).toHaveLength(1);
    const message = parts[0]!;
    expect(message.plainText).toContain('\n🔸 github.com · Название <AI> & "SDK"');
    expect(message.plainText).toContain('\n🔸 Бэкдор · #32444');
    expect(message.plainText).toContain('\n🔸 #1330 · Предыстория');
    expect(message.text).toContain('href="https://www.github.com/org/repo?x=1&amp;y=2"');
    expect(message.text).toContain('Название &lt;AI&gt; &amp; &quot;SDK&quot;');
    expect(new JSDOM(`<body>${message.text}</body>`).window.document.body.textContent).toBe(message.plainText);
    for (const link of message.links) {
      expect(message.plainText.slice(link.offset - 4, link.offset)).toBe('\n🔸 ');
      expect(message.plainText.slice(link.offset, link.offset + link.length)).not.toContain('🔸');
    }
  });

  it('normalizes explicit lists without changing prose, URLs or code', () => {
    const body = '- Первый\n* Второй\n• Третий\n1. Четвёртый\n+ [x] Готово\n🔹 Пятый\n🔸 Уже готово\n\nОбычный факт: A - B.\nhttps://example.org/-/x#anchor\n```txt\n- код\n```\n~~~\n* код\n~~~\n<pre>\n- код\n</pre>\n`многострочный\n- код`\n    - код с отступом\n- `inline`';
    const normalized = normalizeMarkedLists(body);
    expect(normalized).toBe(body.replace('- Первый', '🔸 Первый').replace('* Второй', '🔸 Второй')
      .replace('• Третий', '🔸 Третий').replace('1. Четвёртый', '🔸 Четвёртый')
      .replace('+ [x] Готово', '🔸 Готово').replace('🔹 Пятый', '🔸 Пятый').replace('- `inline`', '🔸 `inline`'));
    expect(normalizeMarkedLists(normalized)).toBe(normalized);
    expect(render({ ...snapshot, details: body }).plainText).toContain(normalized);
    expect(render({ ...snapshot, details: body }).plainText).toContain(normalized);
    expect(render({ ...snapshot, presentationVersion: undefined, details: body }).plainText).toContain(body);
  });

  it('keeps the unversioned default and rejects unsupported presentation versions', () => {
    const legacy = { ...snapshot, presentationVersion: undefined, details: '- Факт', sources: [source('Бэкдор · №32444', 'https://t.me/backdoor/32444')] };
    const expected = '••••••••◦◦\nНовость\n\n- Факт\n\nВторичные источники\nБэкдор · №32444';
    expect(render(legacy).plainText).toBe(expected);
    expect(render(legacy).plainText).toBe(expected);
    expect(publicationSnapshotSchema.parse(legacy).presentationVersion).toBeUndefined();
    expect(publicationSnapshotSchema.safeParse({ ...snapshot, presentationVersion: 2 }).success).toBe(false);
  });

  it('formats a versioned UPD link', () => {
    const base = render(snapshot);
    const url = 'https://t.me/c/123/1330';
    const options = { presentationVersion: 1 as const, headline: 'Новая <версия> & SDK' };
    const marked = withUpdateMarker(base, url, 4096, options);
    expect(marked.plainText).toBe(`UPD:\n🔸 #1330 · Новая <версия> & SDK\n\n${base.plainText}`);
    expect(marked.text).toContain('>#1330 · Новая &lt;версия&gt; &amp; SDK</a>');
    const link = marked.links[0]!;
    expect(marked.plainText.slice(link.offset, link.offset + link.length)).toBe('#1330 · Новая <версия> & SDK');
  });
});
