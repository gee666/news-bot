import { expect, it } from 'vitest';
import { extractLinks } from './links.js';
import { extractMarkdownLinks } from './markdown.js';
import { discoverWebsite } from './website.js';
import { primarySourceInput } from './config.js';

it('parses nested linked images as two real URLs, never a concatenation', () => {
  const text = '😀 [![avatar](https://cdn.example/img.jpg)](https://publisher.example/profile)';
  const links = extractMarkdownLinks(text);
  expect(links.map(link => link.url)).toEqual(['https://publisher.example/profile', 'https://cdn.example/img.jpg']);
  expect(extractLinks(text).map(link => link.url).sort()).toEqual(links.map(link => link.url).sort());
  expect(links.every(link => link.metadata.evidenceEligible === false)).toBe(true);
  expect(links[0]?.startOffset).toBe(3);
  expect(text.slice(links[0]?.startOffset, links[0]?.endOffset)).toBe(text.slice(3));
});
it('resolves reference links, autolinks, GFM bare URLs and keeps duplicate UTF-16 spans', () => {
  const text = '😀 [Code][src] [Code][src] <https://example.org/weights> https://example.org/license\n\n[src]: https://github.com/NVIDIA/structured-data-models "Code"';
  const links = extractMarkdownLinks(text);
  const refs = links.filter(link => link.metadata.evidenceEligible);
  expect(refs.map(link => link.url)).toEqual([
    'https://github.com/NVIDIA/structured-data-models', 'https://github.com/NVIDIA/structured-data-models',
    'https://example.org/weights', 'https://example.org/license',
  ]);
  expect(refs[0]?.startOffset).toBe(3);
  expect(refs[1]?.startOffset).toBe(15);
  expect(text.slice(refs[1]?.startOffset, refs[1]?.endOffset)).toBe('[Code][src]');
  expect(links.find(link => link.metadata.kind === 'definition')?.metadata.evidenceEligible).toBe(false);
});
it('retains social footer and credit links internally without admitting them as evidence', () => {
  const text = '# Release\n[weights](https://publisher.org/weights)\n\n## Share this article\n[Social](https://social.example/share)\n\n## Credits\n[Author](https://publisher.org/person)\n\n## License\n[Terms](https://publisher.org/license)';
  const links = extractMarkdownLinks(text);
  expect(links).toHaveLength(4);
  expect(links.map(link => link.metadata.evidenceEligible)).toEqual([true, false, false, true]);
});
it('discovers nested/card and reference-style links from raw index without article cleaning', () => {
  const source = primarySourceInput.parse({ kind: 'website', name: 'Publisher', publisher: 'Publisher',
    url: 'https://publisher.org/', articlePathPrefixes: ['/news/'] });
  expect(discoverWebsite('[**October 1, 2026 Launch**][article]\n\n[article]: https://publisher.org/news/launch', source)[0])
    .toMatchObject({ url: 'https://publisher.org/news/launch', publishedAt: new Date('2026-10-01T00:00:00Z') });
});
