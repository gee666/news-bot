import { describe, expect, it } from 'vitest';
import type { PublicationSnapshot } from '../types.js';
import { escapeHtml, MESSAGE_LIMIT, render, SOURCE_LIMIT } from './render.js';
import { mergeSources } from './store.js';
const snapshot: PublicationSnapshot = {
  headline: 'Компания <AI> выпустила "модель" & SDK', score: 8, details: 'Подробности <b>не разметка</b>',
  detailsKind: 'summary', sources: [{ label: 'Канал <1> · №23', url: 'https://t.me/c/123/23',
    access: 'restricted', primary: false, classification: 'relevant' }],
};
describe('full publication rendering', () => {
  it('shows details, score and sources together with no buttons or marker', () => {
    const message = render(snapshot);
    expect(message.text).toContain(escapeHtml(snapshot.headline));
    expect(message.text.startsWith('••••••••◦◦\n<b>')).toBe(true);
    expect(message.text).not.toMatch(/Интерес|\/10|[▰▱]/u);
    expect(message.text).toContain(escapeHtml(snapshot.details));
    expect(message.text).toContain('href="https://t.me/c/123/23"');
    expect(message.text).toContain('доступ ограничен');
    expect(message.reply_markup.inline_keyboard).toEqual([]);
    expect(message.link_preview_options.is_disabled).toBe(true);
    expect(message.plainText).toBe('••••••••◦◦\n' + snapshot.headline + '\n\n' + snapshot.details + '\n\nВторичные источники\nКанал <1> · №23 · доступ ограничен');
    expect(message.plainText.slice(message.links[0]!.offset,message.links[0]!.offset+message.links[0]!.length)).toBe('Канал <1> · №23 · доступ ограничен');
  });
  it('shows the previous-publication category last, with the channel link', () => {
    const message=render({...snapshot,sources:[{label:'Старая новость',url:'https://t.me/c/4376672811/644',
      primary:false,previousPublication:true,access:'public',classification:'relevant'},...snapshot.sources]});
    expect(message.text).toContain('<b>Предыдущие публикации</b>');
    expect(message.links.at(-1)?.url).toBe('https://t.me/c/4376672811/644');
    expect(message.plainText.indexOf('Предыдущие публикации')).toBeGreaterThan(message.plainText.indexOf('Вторичные источники'));
    expect(render(snapshot).text).not.toContain('Предыдущие публикации');
  });
  it('renders new information and earlier history, with escaped text and correct link offsets', () => {
    const message=render({...snapshot,earlier:'Было <известно> [1]'});
    expect(message.text).toContain('<b>Новое</b>\n'+escapeHtml(snapshot.details));
    expect(message.text).toContain('<b>Ранее было опубликовано</b>\nБыло &lt;известно&gt;');
    const link=message.links[0]!;
    expect(message.plainText.slice(link.offset,link.offset+link.length)).toContain('Канал <1>');
  });
  it('trims earlier history before new information and preserves source links', () => {
    const content={...snapshot,details:'Новые сведения. '.repeat(100),earlier:'Старые сведения. '.repeat(1000)};
    const message=render(content);
    expect(message.plainText.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(message.text).toContain(content.details);
    expect(message.text).not.toContain(content.earlier);
    expect(message.links).toHaveLength(1);
    expect(render({...content,details:'😀'.repeat(5000)}).plainText.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });
  it('counts both follow-up headings against the Telegram entity limit', () => {
    const sources=Array.from({length:97},()=>snapshot.sources[0]!);
    expect(()=>render({...snapshot,sources})).not.toThrow();
    expect(()=>render({...snapshot,sources,earlier:'Прежние сведения'})).toThrow('publication_entity_limit');
  });
  it('renders a clean review with no remark block', () => {
    const message=render({...snapshot,review:{supported:true,reason:''}});
    expect(message.plainText).not.toContain('Заметки проверяющего');
    expect(message.links).toHaveLength(1);
  });
  it('groups primary and secondary sources without conflating fetch and relevance', () => {
    const content: PublicationSnapshot = { ...snapshot,sources: [
      { ...snapshot.sources[0]!, primary: true },
      { label: 'Статья',url: 'https://press.org',primary: false,access: 'unknown',classification: 'relevant' },
      { label: 'Объявление',url: 'https://author.org',primary: true,access: 'public',classification: 'relevant' },
      { label: 'Неясная связь',url: 'https://other.org',primary: false,access: 'unknown',classification: 'uncertain' },
    ] };
    const message = render(content);
    expect(message.links.map(link => link.url)).toEqual(['https://author.org','https://press.org','https://other.org','https://t.me/c/123/23']);
    expect(message.text).toContain('<b>Первоисточники</b>'); expect(message.text).toContain('<b>Вторичные источники</b>');
    expect(message.text).not.toContain('<b>Ссылки</b>'); expect(message.text).not.toContain('<b>Публикации</b>');
    expect(message.text).not.toContain('не проверено'); expect(message.text).not.toContain('Первоисточник не найден');
    expect(message.text).toContain('>Статья</a>'); expect(message.text).toContain('Неясная связь · связь с новостью неясна');
    expect(content.sources[0]?.url).toBe('https://t.me/c/123/23');
    for (const link of message.links) expect(message.plainText.slice(link.offset,link.offset+link.length)).not.toBe('');
    expect(render({ ...content,sources: [content.sources[1]!] }).text).not.toContain('Первоисточники');
  });
  it('includes each group heading in the entity budget', () => {
    const external = { ...snapshot.sources[0]!,url: 'https://example.org',access: 'public' as const };
    const sources = [snapshot.sources[0]!,{ ...external,primary: true },...Array.from({ length: 96 }, () => external)];
    expect(() => render({ ...snapshot,sources })).toThrow('publication_entity_limit');
  });
  it('strips only trailing numeric citation markers and keeps source links and offsets intact', () => {
    const content = { ...snapshot,
      headline: 'Заголовок [3]', details: 'Первый абзац [1, 2]\n\nКод a[1] остается. Модель X[1] тоже.',
      sources: [
        { ...snapshot.sources[0]!, url: 'https://example.org/source?ref=[1]', label: 'Источник [1]', access: 'public' },
      ],
    };
    const message = render(content);
    expect(message.plainText).toContain('Заголовок\n');
    expect(message.plainText).toContain('Первый абзац\n\nКод a[1] остается. Модель X[1] тоже.');
    expect(message.plainText).not.toContain('Первый абзац [1, 2]');
    expect(message.text).toContain('https://example.org/source?ref=[1]');
    expect(message.links.map(link => link.url)).toEqual([content.sources[0]!.url]);
    const link = message.links[0]!;
    expect(message.plainText.slice(link.offset, link.offset + link.length)).toBe('Источник [1]');
  });
  it('counts decoded UTF-16, not encoded HTML or URLs', () => {
    const content = { ...snapshot, details: '<&😀>'.repeat(600), sources: [{ ...snapshot.sources[0]!, url: 'https://example.org/'+'x'.repeat(6000) }] };
    const message = render(content);
    expect(message.text.length).toBeGreaterThan(MESSAGE_LIMIT);
    expect(message.plainText.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(message.text).toContain(content.sources[0]!.url);
  });
  it('compacts labels without dropping links, details, qualifications or stored labels', () => {
    const content = { ...snapshot, sources: Array.from({ length: 50 }, (_, index) => ({ ...snapshot.sources[0]!,
      label: 'Имя '.repeat(50), url: 'https://example.org/'+index, classification: 'uncertain' as const })) };
    const message = render(content);
    expect(message.links).toHaveLength(50);
    for (const source of content.sources) expect(message.text).toContain(source.url);
    expect(message.text).toContain('связь с новостью неясна');
    expect(message.text).toContain(escapeHtml(content.details));
    expect(content.sources[0]!.label).toBe('Имя '.repeat(50));
  });
  it('keeps all 17 direct source targets when mixed external and Telegram labels must compact', () => {
    const sources: PublicationSnapshot['sources'] = Array.from({ length: 15 }, (_, index) => ({
      label: 'Название статьи '.repeat(40),url: 'https://external.org/article/'+index+'?q='+'x'.repeat(500),
      primary: false,access: 'unknown' as const,classification: 'relevant' as const,
    }));
    sources.push(snapshot.sources[0]!,{ ...snapshot.sources[0]!,url: 'https://t.me/public/2',label: 'Другая публикация' });
    const content = { ...snapshot,details: 'Полные подробности. '.repeat(70),sources };
    const message = render(content);
    expect(message.links.map(link => link.url)).toEqual(sources.map(source => source.url));
    expect(message.plainText.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(message.text.length).toBeGreaterThan(MESSAGE_LIMIT);
    for (const source of sources) expect(message.text).toContain(escapeHtml(source.url));
    expect(message.text).toContain(escapeHtml(content.details));
    expect(message.text).not.toContain(escapeHtml(sources[0]!.label));
  });
  it('trims oversized details but still rejects too many Telegram entities', () => {
    const budget = MESSAGE_LIMIT - render({ ...snapshot, details: '' }).plainText.length - 2;
    expect(render({ ...snapshot, details: 'x'.repeat(budget) }).plainText.length).toBe(MESSAGE_LIMIT);
    expect(render({ ...snapshot, details: 'x'.repeat(budget+1) }).plainText.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(render({ ...snapshot, details: '😀'.repeat(Math.floor(budget/2)+1) }).plainText.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(() => render({ ...snapshot, sources: Array.from({ length: SOURCE_LIMIT+1 }, () => snapshot.sources[0]!) })).toThrow('publication_entity_limit');
  });
  it.each([false, true])('renders reviewer notes with supported=%s, retaining links and offsets', supported => {
    const message = render({ ...snapshot, review: { supported, reason: 'Версия <2> не подтверждена\nисточником' } });
    expect(message.plainText).toContain('Заметки проверяющего: Версия <2> не подтверждена источником');
    expect(message.text).toContain('Версия &lt;2&gt; не подтверждена источником');
    expect(message.links[0]?.url).toBe(snapshot.sources[0]?.url);
    const link = message.links[0]!;
    expect(message.plainText.slice(link.offset, link.offset + link.length)).toBe('Канал <1> · №23 · доступ ограничен');
    const content = { ...snapshot, review: { supported, reason: 'Замечание '.repeat(50) } };
    const budget = MESSAGE_LIMIT - render({ ...content, details: '' }).plainText.length - 2;
    expect(render({ ...content, details: 'x'.repeat(budget) }).plainText.length).toBe(MESSAGE_LIMIT);
  });
  it('omits reviewer notes when no review is present', () => {
    expect(render(snapshot).text).not.toContain('Заметки проверяющего:');
  });
  it.each([1, 6, 10])('puts a ten-symbol bar for score %s before the title', score => {
    expect(render({ ...snapshot, score }).plainText.split('\n')[0]).toBe('•'.repeat(score) + '◦'.repeat(10 - score));
  });
  it('deduplicates URLs while preserving every origin label and primary-first order', () => {
    const origin = snapshot.sources[0]!;
    const sources = mergeSources([origin, { ...origin, label: 'Другая подписка · №1' },
      { ...origin, label: 'Первоисточник', url: 'https://example.org', primary: true }]);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.primary).toBe(true);
    expect(sources[1]?.label).toBe('Канал <1> · №23 / Другая подписка · №1');
  });
  it('rejects unsafe URLs and invalid snapshots', () => {
    expect(() => render({ ...snapshot, sources: [{ ...snapshot.sources[0]!, url: 'javascript:alert(1)' }] })).toThrow();
    expect(() => render({ ...snapshot, score: 0 })).toThrow('publication_snapshot_invalid');
  });
});
