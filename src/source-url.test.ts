import { expect, it } from 'vitest';
import { cleanSourceUrl } from './source-url.js';
import { extractLinks } from './sources/links.js';
import { extractMarkdownLinks } from './sources/markdown.js';
import { mergeSources } from './publishing/content.js';
import { visibleSources } from './publishing/sources.js';
import { renderCanonicalText } from './publishing/canonical-text.js';
import { normalizedResearchUrl } from './pipeline/research-priority.js';
const url = 'https://www.reddit.com/r/StableDiffusion/comments/1xdoh8k/i_tested_the_rtx_30series_gpu_unlock_up_to_59/';
const dirty = url + '?solution=old&js_challenge=1&jsc_token=one&jsc_orig_r=&solution=new&jsc_token=two';
const source = (url:string) => ({ url,label:'GPU unlock test',primary:true,access:'public' as const,classification:'relevant' as const });

it('removes every repeated challenge parameter from Reddit permalinks and is idempotent', () => {
  expect(cleanSourceUrl(dirty)).toBe(url);
  expect(cleanSourceUrl(cleanSourceUrl(dirty))).toBe(url);
  expect(normalizedResearchUrl(dirty)).toBe(normalizedResearchUrl(url));
});
it('preserves comment paths, fragments and content options rather than deleting every query', () => {
  const comment=url+'comment123/';
  expect(cleanSourceUrl(comment+'?comment=abc&sort=new&context=3&js_challenge=1&utm_source=share#thread'))
    .toBe(comment+'?comment=abc&sort=new&context=3#thread');
  expect(cleanSourceUrl(url+'?utm_medium=web&share_id=123&rdt=456')).toBe(url);
});
it.each(['https://reddit.com.evil.org/r/a/comments/123/a/?solution=1',
  'https://example.org/api?solution=1&js_challenge=1', 'https://www.reddit.com/search/?q=gpu&solution=1',
  'https://user:password@www.reddit.com/r/a/comments/123/a/?solution=1', 'not a URL'])(
'does not rewrite unrelated/sensitive URLs: %s', value => expect(cleanSourceUrl(value)).toBe(value));
it('cleans Telegram entity, bare and Markdown link destinations while retaining source text offsets', () => {
  const text='Interesting '+dirty;
  const [bare]=extractLinks(text);
  expect(bare?.url).toBe(url);
  expect(text.slice(bare?.startOffset,bare?.endOffset)).toBe(dirty);
  expect(extractLinks('GPU report',[{kind:'text-url',offset:0,length:10,url:dirty}])[0]?.url).toBe(url);
  expect(extractMarkdownLinks(`[GPU report](${dirty})`)[0]?.url).toBe(url);
});
it('deduplicates inherited citation variants and cleans existing snapshots at render time', () => {
  const sources=[source(dirty),source(url+'?solution=other&js_challenge=1'),source(url)];
  expect(mergeSources(sources)).toEqual([source(url)]);
  expect(visibleSources(sources)).toEqual([source(url)]);
  const message=renderCanonicalText({ headline:'GPU unlock',details:'RTX tests.',score:8,detailsKind:'summary',presentationVersion:1,sources });
  expect(message.links.map(link=>link.url)).toEqual([url]);
  expect(message.text).not.toContain('jsc_token');
});
