import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cleanArticle } from './article.js';
import { toString } from 'mdast-util-to-string';
import { markdownTree, extractMarkdownLinks } from './markdown.js';

const url = 'https://publisher.org/news/release';
it('keeps main prose, headings, numeric table rows and direct source links, removes thread/navigation/promo', () => {
  const html = `<html><head><title>Release</title><meta name="author" content="Publisher author"><meta property="article:published_time" content="2026-10-01T12:00:00Z"></head><body>
    <nav><a href="/profile">Profile</a></nav><main><article>
    <h1>Release</h1><p>Today we released an open model. It is available commercially under an explicit license.
    The release provides reproducible code, downloadable weights and a complete benchmark report with clear comparisons.</p>
    <h2>Numbers</h2><table><thead><tr><th>Price</th><th>Speed</th><th>Tokens</th></tr></thead>
    <tbody><tr><td>$500</td><td>25x</td><td>300</td></tr><tr><td>$200</td><td>10x</td><td>200</td></tr></tbody></table>
    <p><a href="https://github.com/vendor/model">Code</a>, <a href="/weights">Weights</a>,
    <a href="/license">License</a>. These original sources document the released model and its availability.</p>
    <div itemprop="comment"><a href="/person"><img src="/avatar.jpg"></a><p>COMMENT_THREAD_MARKER</p></div>
    </article><aside><h2>Related stories</h2><a href="/promotion">PROMOTION_MARKER</a></aside></main>
    <footer><a href="/social">SOCIAL_MARKER</a></footer></body></html>`;
  const article = cleanArticle(html, url);
  expect(article?.content).toContain('Numbers');
  for (const token of ['$500', '25x', '300', '$200', '10x']) expect(article?.content).toContain(token);
  expect(article?.content).not.toMatch(/COMMENT_THREAD|PROMOTION_MARKER|SOCIAL_MARKER|avatar.jpg/u);
  expect(extractMarkdownLinks(article?.content ?? '', url).filter(link => link.metadata.evidenceEligible).map(link => link.url))
    .toEqual(['https://github.com/vendor/model', 'https://publisher.org/weights', 'https://publisher.org/license']);
  expect(article?.byline).toBe('Publisher author');
  expect(article?.publishedAt).toBe('2026-10-01T12:00:00Z');
});
it('cleans actual rendered Hugging Face Kumo HTML, retaining original code, weights and license', () => {
  const actualUrl = 'https://huggingface.co/blog/nvidia/kumo-tabular';
  const html = readFileSync(new URL('./fixtures/hf-kumo-rendered.html', import.meta.url), 'utf8');
  const article = cleanArticle(html, actualUrl);
  const headings = markdownTree(article?.content ?? '').children.filter(node => node.type === 'heading').map(node => toString(node));
  expect(headings).toContain('Performance');
  expect(headings).toContain('Limitations');
  expect(headings).not.toContain('Community');
  const references = extractMarkdownLinks(article?.content ?? '', actualUrl).filter(link => link.metadata.evidenceEligible);
  const urls = new Set(references.map(link => link.url));
  expect(urls.has('https://github.com/NVIDIA/structured-data-models')).toBe(true);
  expect(urls.has('https://huggingface.co/nvidia/Kumo-Tabular')).toBe(true);
  expect(urls.has('https://openmdw.ai/license/1-1/')).toBe(true);
  expect([...urls].some(value => value.includes('cdn-avatars') || value.includes(')]('))).toBe(false);
  expect(urls.size).toBeLessThan(15);
});

it('returns no article for empty HTML and bounds untrusted input', () => {
  expect(cleanArticle('', url)).toBeNull();
  expect(cleanArticle('x'.repeat(5_000_001), url)).toBeNull();
});
