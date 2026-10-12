import { describe, expect, it } from 'vitest';
import { parseFeed, publisherDate } from './feed.js';
import { primarySourceInput, primarySourcePatch, publisherArticle } from './config.js';
import { discoverWebsite, articlePublication } from './website.js';
const source = primarySourceInput.parse({ kind: 'feed', name: 'Publisher', publisher: 'Publisher',
  url: 'https://example.org/feed.xml', articlePathPrefixes: ['/news/'] });
describe('bounded publisher XML', () => {
  it('parses RSS GUID and explicit time, not updated date', () => {
    const entries = parseFeed('<rss><channel><item><title>Release</title><guid isPermaLink="false">stable-1</guid><link>https://example.org/news/release</link><pubDate>Tue, 29 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>', source);
    expect(entries[0]).toMatchObject({ id: 'stable-1', title: 'Release', publishedAt: new Date('2026-09-29T12:00:00Z') });
  });
  it('falls back to the article URL when GUID or Atom ID is empty rather than poisoning the durable cursor', () => {
    expect(parseFeed('<rss><channel><item><guid></guid><link>https://example.org/news/release</link></item></channel></rss>', source)[0]?.id)
      .toBe('https://example.org/news/release');
    expect(parseFeed('<feed><entry><id>  </id><link href="https://example.org/news/release"/></entry></feed>', source)[0]?.id)
      .toBe('https://example.org/news/release');
  });
  it('validates configurable attempt and backlog budgets without relaxing article access', () => {
    expect(primarySourceInput.parse({ ...source, maxArticles: 50, backlogLimit: 1000, retryDelayMinutes: 720 })).toMatchObject({ maxArticles: 50 });
    for (const patch of [{ maxArticles: 51 }, { backlogLimit: 1001 }, { retryDelayMinutes: 0 },
      { kind: 'website', feedDateRole: 'submission' }]) {
      expect(primarySourceInput.safeParse({ ...source, ...patch }).success).toBe(false);
    }
  });
  it('decodes only standard XML scalar references without custom entity expansion', () => {
    const items = parseFeed('<rss><channel><item><link>https://example.org/news/release?a=1&#38;b=2&amp;c=3</link><title>A &amp; B</title></item></channel></rss>', source);
    expect(items[0]?.url).toBe('https://example.org/news/release?a=1&b=2&c=3');
    expect(items[0]?.title).toBe('A & B');
  });
  it('parses Atom alternate links and published, not updated', () => {
    const items = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>stable</id><link rel="self" href="https://example.org/feed"/><link rel="alternate" href="https://example.org/news/release"/><updated>2026-10-01T10:00:00Z</updated><published>2026-09-29T12:00:00Z</published></entry></feed>', source);
    expect(items[0]?.publishedAt?.toISOString()).toBe('2026-09-29T12:00:00.000Z');
    expect(items[0]?.id).toBe('stable');
  });
  it.each(['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', '<rss><channel>', '<!ENTITY x "expansion"><rss/>'])('rejects unsafe XML', xml => {
    expect(() => parseFeed(xml, source)).toThrow();
  });
  it('rejects oversized bodies and cross-publisher links, retains unknown dates', () => {
    expect(() => parseFeed('x'.repeat(1000001), source)).toThrow('invalid_feed_xml');
    expect(parseFeed('<rss><channel><item><link>https://other.org/news/foreign</link></item><item><link>https://example.org/news/unknown</link></item></channel></rss>', source)).toEqual([
      { id: 'https://example.org/news/unknown', url: 'https://example.org/news/unknown', title: null, publishedAt: null },
    ]);
  });
});
it('allows only configured host/path and rejects credentials/private URLs', () => {
  for (const url of ['http://127.0.0.1/news/x', 'https://user:pw@example.org/news/x',
    'https://example.org/not-news/x', 'https://other.org/news/x']) expect(publisherArticle(url, source)).toBeNull();
});
describe('aggregator feed article policy', () => {
  const aggregator = primarySourceInput.parse({ ...source, url: 'https://hnrss.org/newest',
    articlePathPrefixes: ['/'], articleLinkPolicy: 'external' });
  const blocked = [
    'http://127.0.0.1/news/x', 'http://2130706433/news/x', 'http://10.0.0.1/news/x',
    'http://169.254.169.254/news/x', 'http://[::1]/news/x', 'http://[::ffff:127.0.0.1]/news/x',
    'http://localhost/news/x', 'http://service.internal/news/x', 'http://service.local/news/x',
    'https://user:pw@example.org/news/x', 'https://example.org:8080/news/x',
    'file:///etc/passwd', 'javascript:alert(1)',
  ];
  it('keeps mixed same-host and external RSS links only after this feed opts in', () => {
    const urls = ['https://hnrss.org/news/local', 'https://other.org/news/release',
      'https://news.ycombinator.com/item?id=42', ...blocked];
    const xml = '<rss><channel>' + urls.map((url, index) =>
      '<item><guid isPermaLink="false">hn-' + index + '</guid><link>' + url +
      '</link><pubDate>Tue, 29 Sep 2026 12:00:00 GMT</pubDate></item>').join('') + '</channel></rss>';
    expect(parseFeed(xml, { ...aggregator, articleLinkPolicy: 'same_host' }).map(item => item.url)).toEqual([urls[0]]);
    expect(parseFeed(xml, aggregator).map(item => ({ id: item.id, url: item.url }))).toEqual(
      urls.slice(0, 3).map((url, index) => ({ id: 'hn-' + index, url })));
  });
  it('also permits Atom alternate links without relaxing path or feed-self exclusions', () => {
    const xml = '<feed><entry><id>external</id><link rel="alternate" href="https://other.org/news/release"/></entry></feed>';
    expect(parseFeed(xml, aggregator)[0]?.url).toBe('https://other.org/news/release');
    expect(parseFeed(xml, { ...aggregator, articleLinkPolicy: 'same_host' })).toEqual([]);
    expect(publisherArticle('https://other.org/blog/release', { ...aggregator, articlePathPrefixes: ['/news/'] })).toBeNull();
    expect(publisherArticle(aggregator.url, aggregator)).toBeNull();
  });
  it.each(blocked)('still rejects unsafe article URL %s', url => {
    expect(publisherArticle(url, aggregator)).toBeNull();
  });
  it('defaults to same host, rejects invalid policies and forbids website opt-in', () => {
    expect(source.articleLinkPolicy).toBe('same_host');
    expect(primarySourcePatch.parse({ enabled: false })).toEqual({ enabled: false });
    expect(primarySourcePatch.parse({ articleLinkPolicy: 'external' })).toEqual({ articleLinkPolicy: 'external' });
    expect(primarySourceInput.safeParse({ ...source, articleLinkPolicy: 'anything' }).success).toBe(false);
    expect(primarySourceInput.safeParse({ ...aggregator, kind: 'website' }).success).toBe(false);
    expect(publisherArticle('https://other.org/news/release', { ...aggregator, kind: 'website' })).toBeNull();
  });
});
it('discovers date-labelled index links despite HTML label concatenation', () => {
  const items = discoverWebsite('[Release CompanySep 29, 2026](https://example.org/news/release) [Oct 1, 2026Announcements New](https://example.org/news/new)', source);
  expect(items.map(item => item.publishedAt?.toISOString())).toEqual(['2026-09-29T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
});
it('does not infer publisher times from arbitrary/updated/related-card prose', () => {
  expect(articlePublication('# Article\nPublished: September 29, 2026\nbody')).toEqual(new Date('2026-09-29T00:00:00Z'));
  expect(articlePublication('# Article\n## Related articles\nSeptember 29, 2026')).toBeNull();
  expect(articlePublication('# Article\nUpdated September 29, 2026')).toBeNull();
  expect(publisherDate('2026-02-31')).toBeNull();
  expect(publisherDate('today')).toBeNull();
  expect(publisherDate('2026-10-01T12:00:00')).toBeNull();
});
