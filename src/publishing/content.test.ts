import { describe, expect, it, vi } from 'vitest';
import type { PublicationSnapshot, PublicationSource } from '../types.js';
import { snapshotFor, type StoryContent } from './content.js';
import { render } from './render.js';

const story: StoryContent = { id: 'story', headline: 'Отчёт OpenAI и сообщение XOR', summary: 'Подробности',
  researched: true, translated_excerpt: null, chosen_excerpt: null, interest_score: 6 };
const reportUrl = 'https://alignment.openai.com/report';
const xorUrl = 'https://t.me/xor_journal/10254';
const otherUrl = 'https://t.me/other/1';
const origin = { source_id: 'mention:xor', text: 'Сообщение XOR', name: 'XOR', external_id: '10254',
  original_url: xorUrl, connector_type: 'telegram', source_external_id: '-10011',
  access: 'public', classification: 'relevant' };
const source = (url: string, primary = false): PublicationSource => ({ url, label: url,
  primary, access: 'public', classification: 'relevant' });
function client(options: { receipt?: object; primary?: string[]; referenced?: string[];
  posts?: { story_id: string; message_id: string; content: PublicationSnapshot }[] } = {}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('WITH source_assignments')) return { rows: [origin, { ...origin, source_id: 'mention:other',
      name: 'Другой канал', original_url: otherUrl, external_id: '1' }] };
    if (sql.includes('SELECT e.title')) return { rows: [{ id: 'evidence', title: 'Отчёт OpenAI', content: 'Actual research findings.',
      url: reportUrl, primary: true, metadata: {} }] };
    if (sql.includes('FROM judgments')) return { rows: [{ result: options.receipt ?? {} }] };
    if (sql.includes('jsonb_array_elements_text')) return { rows: (options.primary ?? []).map(url => ({ url })) };
    if (sql.includes('SELECT DISTINCT l.url')) return { rows: (options.referenced ?? []).map(url => ({ url })) };
    if (sql.includes("key='telegram_destination'")) return { rows: [{ id: '-100123' }] };
    if (sql.includes('publication_thread_edges')) return { rows: (options.posts ?? []).map(post => ({ ...post, destination_id: '-100123' })) };
    return { rows: [] };
  });
  return { query };
}
const post = (id: string, sources: PublicationSource[]) => ({ story_id: id, message_id: id,
  content: { headline: `Новость ${id}`, details: `Сведения ${id}`, score: 6, detailsKind: 'summary' as const, sources } });

describe('generation source selection', () => {
  it('unions receipt and absorbed mention origins without downgrading inventory primary sources', async () => {
    const tweet = 'https://x.com/artist/status/123'; const article = 'https://author.org/story';
    const snapshot = await snapshotFor(client({ receipt: { primarySourceUrls: [tweet] },
      primary: [article], referenced: [tweet, article] }), story);
    expect(snapshot.sources.find(source => source.url === tweet)).toMatchObject({ primary: true, access: 'unknown' });
    expect(snapshot.sources.find(source => source.url === article)?.primary).toBe(true);
    expect(snapshot.sources.find(source => source.url === reportUrl)?.primary).toBe(true);
    expect(snapshot.sources.find(source => source.url === xorUrl)?.primary).toBe(false);
  });
  it('includes every earlier post oldest first, inherits every source and retained previous-publication link', async () => {
    const primary = source('https://author.org/first', true); const secondary = source('https://press.org/second');
    const oldLink: PublicationSource = { ...source('https://t.me/c/123/0'), previousPublication: true };
    const db = client({ receipt: { earlierSummary: 'Сводка всех прежних сообщений' },
      posts: [post('1', [primary]), post('2', [secondary, oldLink]), post(story.id, [])] });
    const snapshot = await snapshotFor(db, story);
    expect(snapshot.earlier).toBe('Сводка всех прежних сообщений');
    expect(snapshot.sources.filter(source => source.previousPublication)).toEqual([
      oldLink,
      { ...source('https://t.me/c/123/1'), label: 'Новость 1', previousPublication: true },
      { ...source('https://t.me/c/123/2'), label: 'Новость 2', previousPublication: true },
    ]);
    expect(snapshot.sources).toContainEqual(primary); expect(snapshot.sources).toContainEqual(secondary);
    expect(snapshot.sources.some(source => source.url === oldLink.url)).toBe(true);
    const call = db.query.mock.calls.find(([sql]) => sql.includes('publication_thread_edges'));
    expect(call?.[0]).toContain('p.destination_id=$2');
    expect(render(snapshot).text).toContain('Предыдущие публикации');
    expect(render(await snapshotFor(client(), story)).text).not.toContain('Предыдущие публикации');
    expect((await snapshotFor(client({ receipt: { earlierSummary: 'Не продолжение' } }), story)).earlier).toBeUndefined();
  });
  it('does not let inherited legacy kinds downgrade a primary document', async () => {
    const snapshot=await snapshotFor(client({posts:[post('1',[{...source(reportUrl),kind:'journalism'}])]}),story);
    expect(snapshot.sources.find(source=>source.url===reportUrl)).toMatchObject({primary:true,kind:'primary'});
  });
  it('keeps all sources beyond ninety, including inherited secondary sources', async () => {
    const inherited = Array.from({ length: 100 }, (_, i) => source(`https://press.org/${i}`));
    const primary = source('https://author.org/first', true);
    const snapshot = await snapshotFor(client({ posts: [post('1', [...inherited, primary])] }), story);
    expect(snapshot.sources).toHaveLength(105);
    expect(snapshot.sources).toContainEqual(primary);
    expect(snapshot.sources.some(source => source.url === xorUrl)).toBe(true);
    expect(snapshot.sources.at(-1)?.previousPublication).toBe(true);
  });
  it.each([{ sourceUrls: [reportUrl] }, { sourceUrls: [xorUrl] }, { sourceUrls: [] },
    { sourceUrls: ['https://unknown.example'] }])('retains every mention when the model selects $sourceUrls', async receipt => {
    const review = { supported: true, reason: 'Уточните формулировку' };
    const snapshot = await snapshotFor(client({ receipt: { ...receipt, review } }), story);
    expect(snapshot.sources).toHaveLength(3);
    expect(snapshot.sources[0]).toMatchObject({ url: reportUrl, primary: true });
    expect(new Set(snapshot.sources.map(source => source.url))).toEqual(new Set([reportUrl, xorUrl, otherUrl]));
    expect(snapshot.review).toEqual(review);
    expect(render(snapshot).links.map(link => link.url)).toEqual(snapshot.sources.map(source => source.url));
  });
});
