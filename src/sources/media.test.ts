import { describe, expect, it } from 'vitest';
import { cleanArticle } from './article.js';
import { discoverMedia, validatedMedia } from './media.js';
import { parseFeed } from './feed.js';
import { primarySourceInput } from './config.js';
import { revisionHash } from './content.js';

const base = 'https://publisher.org/news/release';
const source = primarySourceInput.parse({ kind: 'feed', name: 'Publisher', publisher: 'Publisher',
  url: 'https://publisher.org/feed', articlePathPrefixes: ['/news/'] });
const prose = 'This article describes a newly released model and the benchmark results. '
  + 'It includes detailed measurements, implementation instructions, and reproducible comparisons. '.repeat(5);

describe('content media discovery', () => {
  it('resolves Markdown images and references, native videos and direct video links, deduplicating destinations', () => {
    expect(discoverMedia('![Chart](/chart.png) ![again](/chart.png) ![detail][figure]\n\n'
      + '[figure]: https://cdn.example.org/figure.webp\n\n[Demo](/demo.mp4?token=1)\n\n'
      + '<video src="/stream" controls></video>', base)).toEqual([
      { type: 'image', url: 'https://publisher.org/chart.png' },
      { type: 'image', url: 'https://cdn.example.org/figure.webp' },
      { type: 'video', url: 'https://publisher.org/demo.mp4?token=1' },
      { type: 'video', url: 'https://publisher.org/stream' },
    ]);
  });

  it('ignores definitions, code examples, ancillary sections and unsafe destinations', () => {
    expect(discoverMedia('`![example](/code.png)`\n\n[unused]: /unused.png\n\n'
      + '![bad](javascript:alert) ![local](http://127.0.0.1/a.png) ![inline](data:image/png;base64,AAAA)\n\n'
      + '## Comments\n![avatar](/avatar.jpg)\n\n## Results\n![Chart](/chart.png)', base))
      .toEqual([{ type: 'image', url: 'https://publisher.org/chart.png' }]);
    expect(validatedMedia([{ type: 'audio', url: '/audio' }, { type: 'image', url: 'https://user:pw@site.org/a' },
      { type: 'video', url: '/demo.mp4' }], base)).toEqual([{ type: 'video', url: 'https://publisher.org/demo.mp4' }]);
  });

  it('keeps lazy images and extensionless video sources through article cleaning without collecting page chrome', () => {
    const article = cleanArticle(`<html><body><nav><img src="/nav.jpg"></nav><main><article><h1>Release</h1><p>${prose}</p>
      <picture><source srcset="//cdn.example.org/chart-1.webp 1x, //cdn.example.org/chart-2.webp 2x"><img src="data:image/gif;base64,AAAA" alt="Chart"></picture>
      <img data-src="/lazy.png" src="/placeholder.png"><img width="1" height="1" src="/beacon.gif">
      <img class="author-avatar" src="/author.jpg"><video poster="/poster.jpg"><source src="/stream?id=2" type="video/mp4"></video>
      <p>${prose}</p></article></main><aside><img src="/related.jpg"></aside></body></html>`, base);
    expect(article).not.toBeNull();
    expect(article?.media).toEqual([
      { type: 'image', url: 'https://cdn.example.org/chart-2.webp' },
      { type: 'image', url: 'https://publisher.org/lazy.png' },
      { type: 'video', url: 'https://publisher.org/stream?id=2' },
    ]);
    expect(discoverMedia(article?.content ?? '', base)).toEqual(article?.media);
  });

  it('reads RSS enclosures, media groups and content HTML but not channel logos or audio', () => {
    const entries = parseFeed(`<rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel><image><url>https://publisher.org/logo.jpg</url></image><item><link>${base}</link>
      <enclosure url="/clip.mp4?a=1&amp;b=2" type="video/mp4"/><enclosure url="/podcast.mp3" type="audio/mpeg"/>
      <media:group><media:content url="https://cdn.example.org/full.jpg" medium="image"/><media:thumbnail url="/thumb.jpg"/></media:group>
      <content:encoded><![CDATA[<p>Story</p><img src="/inline.jpg"><video src="/demo.webm"></video>]]></content:encoded>
      </item></channel></rss>`, source);
    expect(entries[0]?.media).toEqual([
      { type: 'video', url: 'https://publisher.org/clip.mp4?a=1&b=2' },
      { type: 'image', url: 'https://cdn.example.org/full.jpg' },
      { type: 'image', url: 'https://publisher.org/thumb.jpg' },
      { type: 'image', url: 'https://publisher.org/inline.jpg' },
      { type: 'video', url: 'https://publisher.org/demo.webm' },
    ]);
  });

  it('reads Atom enclosure links and escaped HTML content without treating alternate links as attachments', () => {
    const entries = parseFeed(`<feed><entry><link rel="alternate" href="${base}"/>
      <link rel="enclosure" href="//cdn.example.org/video.mp4" type="video/mp4"/>
      <content type="html">&lt;img src="/figure.jpg"&gt;</content></entry></feed>`, source);
    expect(entries[0]?.media).toEqual([
      { type: 'video', url: 'https://cdn.example.org/video.mp4' },
      { type: 'image', url: 'https://publisher.org/figure.jpg' },
    ]);
  });

  it('includes media-only edits in revision identity while preserving hashes for legacy empty media', () => {
    const item = { originalText: 'same caption', links: [] };
    expect(revisionHash(item)).toBe(revisionHash({ ...item, metadata: { media: [] } }));
    expect(revisionHash({ ...item, metadata: { media: [{ type: 'image', url: base + '/one.jpg' }] } }))
      .not.toBe(revisionHash({ ...item, metadata: { media: [{ type: 'image', url: base + '/two.jpg' }] } }));
  });
});
