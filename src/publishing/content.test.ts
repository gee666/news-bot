import { describe, expect, it, vi } from 'vitest';
import { snapshotFor, type StoryContent } from './content.js';
import { render } from './render.js';

const story: StoryContent = { id: 'story', headline: 'Отчёт OpenAI и сообщение XOR', summary: 'Подробности',
  researched: true, translated_excerpt: null, chosen_excerpt: null, interest_score: 6 };
const reportUrl = 'https://alignment.openai.com/misalignment-reports/preparing-for-a-restart-after-reading-slack/';
const xorUrl = 'https://t.me/xor_journal/10254';
const otherUrl = 'https://t.me/other/1';
const origin = { source_id: 'mention:xor', text: 'Сообщение XOR', name: 'XOR', external_id: '10254',
  original_url: xorUrl, connector_type: 'telegram', source_external_id: '-10011',
  access: 'public', classification: 'relevant' };

describe('generation source selection', () => {
  it('lists a collected origin tweet as primary even without readable research evidence',async()=>{
    const tweet='https://x.com/artist/status/123';
    const query=vi.fn().mockResolvedValueOnce({rows:[origin]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{result:{primarySourceUrls:[tweet],review:{supported:true,reason:''}}}]})
      .mockResolvedValueOnce({rows:[{url:tweet}]});
    const snapshot=await snapshotFor({query},story);
    expect(snapshot.sources.find(source=>source.url===tweet)).toMatchObject({primary:true,access:'unknown'});
    expect(snapshot.sources.find(source=>source.url===xorUrl)?.primary).toBe(false);
    expect(render(snapshot).links.some(link=>link.url===tweet)).toBe(true);
  });
  it.each([
    { sourceUrls: [reportUrl] }, { sourceUrls: [xorUrl] }, { sourceUrls: [] },
    { sourceUrls: ['https://unknown.example'] },
  ])(
    'retains every mention when the model selects $sourceUrls', async ({ sourceUrls }) => {
      const review = { supported: true, reason: 'Уточните формулировку' };
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [origin, { ...origin, source_id: 'mention:duplicate' },
          { ...origin, source_id: 'mention:other', name: 'Другой канал', original_url: otherUrl, external_id: '1' }] })
        .mockResolvedValueOnce({ rows: [
          { title: 'Отчёт OpenAI', content: 'Actual research findings.', url: reportUrl, primary: true, metadata: {} },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ result: { sourceUrls, review } }] });
      const snapshot = await snapshotFor({ query }, story);
      expect(snapshot.sources).toHaveLength(3);
      expect(snapshot.sources[0]).toMatchObject({ url: reportUrl, primary: true });
      expect(snapshot.sources.filter(source => source.url === xorUrl)).toHaveLength(1);
      expect(snapshot.sources.find(source => source.url === xorUrl)?.primary).toBe(false);
      expect(new Set(snapshot.sources.map(source => source.url))).toEqual(new Set([reportUrl, xorUrl, otherUrl]));
      expect(snapshot.review).toEqual(review);
      const message = render(snapshot);
      expect(message.text).toContain('href="' + xorUrl + '"');
      expect(message.text.indexOf(xorUrl)).toBeGreaterThan(message.text.indexOf('Вторичные источники'));
      expect(message.links.map(link => link.url)).toEqual(snapshot.sources.map(source => source.url));
    },
  );
});
