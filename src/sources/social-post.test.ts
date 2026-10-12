import { expect, it } from 'vitest';
import { cleanArticle } from './article.js';

function post(id: string, handle: string, text: string, nested = ''): string {
  return `<div data-href="/${handle}/status/${id}"><article><a href="/${handle}">${handle}</a><a href="/${handle}">@${handle}</a>`
    + `<div dir="auto">${text}</div>${nested}<a href="/${handle}/status/${id}"><time datetime="2026-10-02T18:04:12Z">Oct 2</time></a></article></div>`;
}

it('isolates the requested incident post and separately labels read same-author involvement context', () => {
  const html = post('101', 'announcer', 'The model downloaded another bot.', post('103', 'announcer', 'Live now: our bots are racing.'))
    + post('102', 'announcer', "I am rolling back the model's code.")
    + post('104', 'outsider', 'A much longer unrelated opinion about different competition rules and unverified rumors.');
  const article = cleanArticle(html, 'https://x.com/announcer/status/101');
  expect(article).toMatchObject({ byline: 'announcer (@announcer)', publishedAt: '2026-10-02T18:04:12Z' });
  expect(article?.content).toContain('The model downloaded another bot.');
  expect(article?.content).toContain('Same-author post read on this page');
  expect(article?.content).toContain("I am rolling back the model's code.");
  expect(article?.content).not.toContain('unverified rumors');
});

it('reads the requested rollback rather than its longer parent announcement', () => {
  const article = cleanArticle(post('101', 'announcer', 'A long parent announcement with quite different claims.')
    + post('102', 'announcer', 'I rolled back my experiment.'), 'https://x.com/announcer/status/102');
  expect(article?.title).toContain('I rolled back my experiment.');
  expect(article?.content?.indexOf('I rolled back my experiment.')).toBeLessThan(article?.content?.indexOf('A long parent') ?? 0);
});

it('never substitutes another thread post or metadata-only preview for a missing requested post', () => {
  expect(cleanArticle('<title>Announcement preview</title>' + post('101', 'announcer', 'Another readable post.'),
    'https://x.com/announcer/status/999')).toBeNull();
  expect(cleanArticle(post('101', 'someoneelse', 'Readable claim.'), 'https://x.com/announcer/status/101')).toBeNull();
});

it('does not borrow a nested quoted post timestamp or author', () => {
  const html = '<article><a href="/announcer">Actual author</a><div data-testid="tweetText">Actual announcement.</div>'
    + post('103', 'outsider', 'Quoted third-party text.') + '<a href="/announcer/status/101">Own permalink</a></article>';
  expect(cleanArticle(html, 'https://twitter.com/announcer/status/101')).toMatchObject({
    byline: 'Actual author (@announcer)', publishedAt: null });
});

it('collects bounded requested-post text and card links, not replies, quotes or navigation', () => {
  const html = '<nav><a href="https://nav.org/">Original article</a></nav><article>'
    + '<a href="/reporter/status/101">Permalink</a>'
    + '<div data-testid="tweetText">Our story <a href="https://author.org/report#details">Read it</a></div>'
    + '<div data-testid="quoteTweet"><div data-testid="tweetText"><a href="https://quote.org/report">Quote</a></div></div>'
    + '<div role="link"><a href="/other/status/104">Quoted post</a><div data-testid="tweetText"><a href="https://quote.org/other">Other quote</a></div></div>'
    + '<div data-testid="card.wrapper"><a href="https://author.org/report">Duplicate</a>'
    + '<a href="https://author.org/method">Methods</a><a href="https://author.org/third">Third</a></div>'
    + '<a href="https://profile.org/">Author profile</a></article>'
    + post('102', 'reporter', '<a href="https://context.org/">Same-author context link</a>')
    + post('103', 'reply', '<a href="https://reply.org/">Reply article</a>');
  const article = cleanArticle(html, 'https://x.com/reporter/status/101');
  expect(article?.followupLinks).toEqual([
    { url: 'https://author.org/report', title: 'Read it' },
    { url: 'https://author.org/method', title: 'Methods' },
  ]);
  expect(article?.content).not.toContain('Other quote');
});

it('rejects unsafe and action links while preserving actual shortened outbound links', () => {
  const html = '<article><a href="/reporter/status/101">Post</a><div data-testid="tweetText">Report'
    + '<a href="javascript:alert(1)">Bad</a><a href="https://user:secret@author.org/report">Credentials</a>'
    + '<a href="https://author.org/sign-in">Login</a><a href="/reporter">Profile</a>'
    + '<a href="https://twitter.com/share?url=https://author.org">Share</a>'
    + '<a href="https://t.co/actual">author.org/report</a></div>'
    + '<nav><div data-testid="card.wrapper"><a href="https://nav.org/">Nav card</a></div></nav></article>';
  expect(cleanArticle(html, 'https://x.com/reporter/status/101')?.followupLinks).toEqual([
    { url: 'https://t.co/actual', title: 'author.org/report' },
  ]);
});

it('does not invent candidates from card metadata, bare text or missing post text', () => {
  const metadata = '<meta property="og:url" content="https://author.org/report">';
  expect(cleanArticle(metadata + post('101', 'reporter', 'Read https://author.org/report'),
    'https://x.com/reporter/status/101')?.followupLinks).toBeUndefined();
  expect(cleanArticle('<article><a href="/reporter/status/101">Post</a>'
    + '<div data-testid="card.wrapper"><a href="https://author.org/report">Card only</a></div></article>',
  'https://x.com/reporter/status/101')).toBeNull();
});

it('keeps actual official product documentation primary-compatible without requiring a dated announcement', () => {
  const article = cleanArticle('<title>Bento editor</title><main><h1>Bento</h1><p>Our open-source editor fits in one HTML file. '
    + 'It supports offline editing, JSON documents and encrypted collaboration.</p></main>', 'https://bento.page/');
  expect(article?.content).toContain('one HTML file');
  expect(article?.content).toContain('encrypted collaboration');
});
