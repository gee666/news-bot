import { describe, expect, it } from 'vitest';
import { renderCanonicalText, assertCanonicalLinks } from './canonical-text.js';
import { renderFullText } from './full-text.js';
import type { PublicationSnapshot } from '../types.js';
import { fullRepairPlan } from './approval.js';

const snapshot: PublicationSnapshot = { headline:'Новость <&> 😀',details:'Полный текст без сокращения.',score:7,
  detailsKind:'summary',presentationVersion:1,sources:[
    { label:'Документ',url:'https://example.com/a?x=1&y=2',primary:true,access:'public',classification:'relevant' },
    { label:'Прошлая публикация',url:'https://t.me/c/123/1624',primary:false,access:'public',classification:'relevant',previousPublication:true },
    { label:'Связанная новость',url:'https://t.me/c/123/1663',primary:false,access:'public',classification:'relevant',relatedPublication:true },
  ] };
describe('one canonical post with all links', () => {
  it('retains full text, escaped HTML, source/navigation links, and correct UTF-16 offsets', () => {
    const message = renderCanonicalText(snapshot);
    expect(message.plainText).toContain(snapshot.details);
    expect(message.text).toContain('&lt;&amp;&gt;');
    expect(message.links.map(link => link.url)).toEqual(snapshot.sources.map(source => source.url));
    for (const link of message.links) expect(message.plainText.slice(link.offset,link.offset+link.length)).not.toBe('');
  });
  it.each([1024,4096])('accepts exactly %i UTF-16 units, rejects one more without losing links', limit => {
    const short = { ...snapshot,details:'x' };
    const overhead = renderCanonicalText(short,limit).plainText.length-1;
    const exact = { ...short,details:'x'.repeat(limit-overhead) };
    expect(renderCanonicalText(exact,limit).plainText).toHaveLength(limit);
    expect(() => renderCanonicalText({ ...exact,details:exact.details+'😀' },limit)).toThrow('publication_message_too_long');
  });
  it('rejects excessive link entities even when the text is short', () => {
    const sources = Array.from({ length:100 },(_,index) => ({ ...{ label:'x',url:'https://example.com/',primary:true,access:'public' as const,classification:'relevant' as const },label:'x',url:`https://example.com/${index}` }));
    expect(() => renderCanonicalText({ ...snapshot,sources })).toThrow('publication_entity_limit');
  });
  it('caps persisted related links at five without dropping factual links or changing the snapshot', () => {
    const related = Array.from({ length:12 },(_,index) => ({ label:`Related ${index}`,url:`https://t.me/c/123/${index+1}`,
      primary:false,access:'public' as const,classification:'relevant' as const,relatedPublication:true as const }));
    const saved = { ...snapshot,sources:[...snapshot.sources.filter(source => !source.relatedPublication),...related] };
    const message = renderCanonicalText(saved);
    expect(message.links).toHaveLength(7);
    expect(message.links.filter(link => related.some(source => source.url === link.url))).toHaveLength(5);
    expect(saved.sources).toHaveLength(14);
    const sixth = related[5]; if (!sixth) throw new Error('Missing fixture');
    expect(() => assertCanonicalLinks(saved,{ ...message,links:[...message.links,{ url:sixth.url,offset:0,length:1 }] }))
      .toThrow('publication_text_requires_new_edition');
  });
  it('does not treat historical audit-only links as visible sources', () => {
    expect(() => renderCanonicalText({ ...snapshot,sources:[...snapshot.sources,
      { ...{ label:'x',url:'https://example.com/',primary:true,access:'public' as const,classification:'relevant' as const },url:'https://example.com/audit',unverifiedPublication:true }] })).not.toThrow();
  });
  it('rejects a frozen first part that would leave links in a continuation', () => {
    const long = { ...snapshot,details:'Факт. '.repeat(1000) };
    const first = renderFullText(long)[0];
    if (!first) throw new Error('Missing fixture');
    expect(() => assertCanonicalLinks(long,first)).toThrow('publication_text_requires_new_edition');
  });
  it('historical repair plans remain reproducible, but oversized plans are not single-post plans', () => {
    expect(fullRepairPlan({ ...snapshot,details:'Факт. '.repeat(1000) }).length).toBeGreaterThan(1);
  });
});
