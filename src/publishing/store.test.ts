import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import { mergeSources, prepareDigest, snapshotFor, type StoryContent } from './store.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: mocks.transaction }));
const story: StoryContent = { id: 'story', headline: 'Новость', summary: null, researched: false,
  translated_excerpt: 'Обзор', chosen_excerpt: null, interest_score: 8 };

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.transaction.mockReset().mockImplementation(async (run: (client: Pick<PoolClient,'query'>) => Promise<unknown>) => run({ query: mocks.query }));
});

describe('publication snapshots', () => {
  it('publishes read assessed documents and collected Telegram provenance, never raw anchors', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [
      { source_id: 'mention:public', text: 'Read public post.', name: 'Public', external_id: '1', original_url: 'https://t.me/public/1', connector_type: 'telegram', source_external_id: '-10011', access: 'public', classification: 'relevant' },
      { source_id: 'mention:private', text: 'Read private post.', name: 'Private', external_id: '2', original_url: null, connector_type: 'telegram', source_external_id: '-10022', access: 'restricted', classification: 'relevant' },
    ] }).mockResolvedValueOnce({ rows: [
      { title:'Автор',content:'We released version 2.',url:'https://author.org',primary:true,metadata:{} },
      { title:'Read report',content:'Reporter describes version 2.',url:'https://press.org/report',primary:false,metadata:{} },
    ] });
    const snapshot = await snapshotFor({ query: mocks.query },story);
    expect(snapshot.sources.map(source => source.url)).toEqual(['https://author.org','https://press.org/report','https://t.me/public/1','https://t.me/c/22/2']);
    expect(snapshot.sources[3]?.access).toBe('restricted');
    expect(snapshot.sources.every(source => source.classification === 'relevant')).toBe(true);
    const evidenceQuery = String(mocks.query.mock.calls[1]?.[0]);
    for (const gate of ["e.access='public'", "length(trim(e.content))>0", "se.relevance='relevant'", 'se.verified_at IS NOT NULL', 'se.superseded_at IS NULL']) {
      expect(evidenceQuery).toContain(gate);
    }
    expect(evidenceQuery).not.toContain('anchor_text');
    expect(evidenceQuery).not.toContain('story_merge_evidence');
    expect(mocks.query.mock.calls[0]?.[0]).toContain("src.connector_type='telegram'");
  });

  it('excludes legacy 200 login/load-error shells and uses a title from actual content', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
      { title:'Sign in to GitHub · GitHub',content:'Username Password',url:'https://github.com/login',primary:false,metadata:{} },
      { title:'This page couldn’t load',content:'Reload',url:'https://x.com/account/status/1',primary:false,metadata:{} },
      { title:null,content:'# Original research findings\n\nActual authors report results.',url:'https://author.org/paper',primary:true,metadata:{} },
    ] });
    expect((await snapshotFor({ query: mocks.query },story)).sources).toEqual([
      { label: 'Original research findings', url: 'https://author.org/paper', primary: true, access: 'public', classification: 'relevant' },
    ]);
  });

  it('includes source-only collected reports without claiming the unvisited link is a source', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [
      { source_id: 'report:revision',text: 'Read recap.',name: 'Recaps',external_id: '4',original_url: null,connector_type: 'telegram',source_external_id: '-10044',access: 'restricted',classification: 'relevant' },
    ] });
    expect((await snapshotFor({ query: mocks.query },story)).sources).toEqual([
      { label: 'Recaps · №4',url: 'https://t.me/c/44/4',primary: false,access: 'restricted',classification: 'relevant' },
    ]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain('story_link_sources');
  });

  it('applies current fetched irrelevance without reviving labels from historical snapshots', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
      { title:'Old article',content:'Readable but now unrelated.',url:'https://press.org/old',primary:false,metadata:{} },
    ] }).mockResolvedValueOnce({ rows: [{ url: 'https://press.org/old' }] });
    expect((await snapshotFor({ query: mocks.query },story)).sources).toEqual([]);
    expect(mocks.query.mock.calls[2]?.[0]).not.toContain('mention_links');
  });

  it('orders direct external sources before Telegram and deduplicates atomic labels', () => {
    const base = { primary: false,access: 'unknown' as const,classification: 'relevant' as const };
    const sources = mergeSources([
      { ...base,label: 'Канал',url: 'https://t.me/channel/1' },
      { ...base,label: 'Статья',url: 'https://external.org' },
      { ...base,label: 'Другая подпись',url: 'https://external.org' },
      { ...base,label: 'Статья',url: 'https://external.org' },
    ]);
    expect(sources.map(source => source.url)).toEqual(['https://external.org','https://t.me/channel/1']);
    expect(sources[0]?.label).toBe('Статья / Другая подпись');
  });

  it('merges atomic labels idempotently without splitting slash-containing names', () => {
    const base = { url: 'https://external.org',primary: false,access: 'unknown' as const,classification: 'relevant' as const };
    const raw = [{ ...base,label: 'Research / lab' },{ ...base,label: 'Vendor' }];
    const merged = mergeSources([...raw,{ ...base,label: 'Legacy / opaque' }]);
    expect(merged[0]?.labels).toEqual(['Research / lab','Vendor','Legacy / opaque']);
    expect(mergeSources([...raw,...merged])).toEqual(merged);
    expect(mergeSources(merged)).toEqual(merged);
  });

  it('selects complete stories with current scores and no digest limit under cleanup lock', async () => {
    await prepareDigest(defaultSettings,'-100123');
    expect(mocks.query.mock.calls[0]?.[0]).toContain('news-bot-history');
    const selection = mocks.query.mock.calls.find(call => String(call[0]).includes('SELECT s.* FROM stories s'));
    const select = String(selection?.[0]);
    expect(select).toContain("s.status='completed'");
    expect(select).toContain('NOT s.interest_stale');
    expect(select).toContain('s.profile_version=$3 AND s.model_version=$4');
    expect(select).toContain('s.translated_excerpt IS NOT NULL');
    expect(select).not.toMatch(/\bLIMIT\b/u);
    expect(selection?.[1]).toEqual(['-100123',1,1,1,null,false]);
  });
});
