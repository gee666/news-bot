import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanArticle } from './article.js';

const url = 'https://publisher.org/news/release';
const html = `<html><head><title>Release</title>
  <base href="https://publisher.org/resources/">
  <meta name="author" content="Publisher author">
  <meta property="article:published_time" content="2026-10-01T12:00:00Z">
  </head><body><main><article><h1>Release</h1>
  <p>Today we released an open model with downloadable weights, reproducible code and a complete benchmark report.
  It is available commercially under an explicit license, with clear comparisons and documented limitations.</p>
  <p style="display:none">HIDDEN_CLAIM_MARKER</p>
  <h2>Numbers</h2><table><tr><th>Price</th><th>Speed</th></tr><tr><td>$500</td><td>25x</td></tr></table>
  <p><a href="weights">Weights</a> and <a href="/license">License</a> document the released model and its availability.</p>
  <p>The documentation includes the literal text &lt;style&gt; and &lt;/style&gt;, which must remain in the article.</p>
  </article></main></body></html>`;

// These trigger jsdom diagnostics when parsed in a browsing context.
const styles = '<style>} a { color: red ! }</style><style>@import url("http://[");</style>';
afterEach(() => vi.restoreAllMocks());

it('reproduces CSS diagnostics in ordinary jsdom without changing its error reporting', () => {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(styles, { url, virtualConsole });
  try {
    expect(errors.some(error => error.message === 'Could not parse CSS stylesheet')).toBe(true);
    expect(errors.some(error => error.message.startsWith('Could not parse CSS @import URL'))).toBe(true);
  } finally { dom.window.close(); }
});

it('skips head and body stylesheets while preserving article structure, metadata, URLs and inline visibility', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const expected = cleanArticle(html, url);
  const styled = html.replace('</head>', `${styles}<style>article { display: none }</style></head>`)
    .replace('</article>', `${styles}</article>`);
  expect(cleanArticle(styled, url)).toEqual(expected);
  expect(expected).toMatchObject({ title: 'Release', byline: 'Publisher author', publishedAt: '2026-10-01T12:00:00Z' });
  expect(expected?.content).toContain('## Numbers');
  expect(expected?.content).toContain('$500');
  expect(expected?.content).toContain('25x');
  expect(expected?.content).toContain('https://publisher.org/resources/weights');
  expect(expected?.content).toContain('https://publisher.org/license');
  expect(expected?.content).toContain('<style>');
  expect(expected?.content).not.toContain('HIDDEN_CLAIM_MARKER');
  expect(error).not.toHaveBeenCalled();
});

it.each([
  {
    url: 'https://arxiv.org/abs/2609.16247',
    html: '<head><meta name="citation_title" content="Original research"><meta name="citation_author" content="Researcher"></head>'
      + '<blockquote class="abstract">Abstract:We measured the effect and report the limitations.</blockquote>',
    cleaning: 'arxiv_abstract',
  },
  {
    url: 'https://x.com/announcer/status/101',
    html: '<article><a href="/announcer/status/101">Post</a><div data-testid="tweetText">Our original announcement.</div></article>',
    cleaning: 'social_post',
  },
])('skips stylesheets for the $cleaning extraction path', fixture => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const expected = cleanArticle(fixture.html, fixture.url);
  expect(expected?.cleaning).toBe(fixture.cleaning);
  expect(cleanArticle(styles + fixture.html + styles, fixture.url)).toEqual(expected);
  expect(error).not.toHaveBeenCalled();
});

it('keeps scripts inert and does not suppress unrelated jsdom errors or invalid URL failures', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(cleanArticle(html.replace('</head>', '<script>console.error("SCRIPT_RAN")</script></head>'), url))
    .toEqual(cleanArticle(html, url));
  expect(error).not.toHaveBeenCalled();
  expect(() => cleanArticle(html, 'not a URL')).toThrow(TypeError);

  const dom = new JSDOM('');
  try {
    dom.window.alert('Unsupported operation');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Not implemented'));
  } finally { dom.window.close(); }
});
