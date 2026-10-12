import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { articleFollowups } from './article-followups.js';

it('uses only bounded real announcement/pricing links, not guessed URLs or advertising anchors', () => {
  const dom = new JSDOM('<a href="/pricing">See full pricing</a><a href="https://issuer.org/release">Read blog</a>'
    + '<a href="/more">Original paper</a><a href="https://max.ru/advert">Мы в Макс</a>');
  try {
    expect(articleFollowups(dom.window.document, 'https://company.org/')).toEqual([
      { url: 'https://company.org/pricing', title: 'See full pricing' },
      { url: 'https://issuer.org/release', title: 'Read blog' },
    ]);
  } finally { dom.window.close(); }
});

it('deduplicates fragment variants without letting duplicate labels take the two slots', () => {
  const dom = new JSDOM('<a href="/report#methods">Original article</a><a href="/report#results">Full article</a>'
    + '<a href="/paper">Original paper</a><a href="/third">Announcement</a>');
  try {
    expect(articleFollowups(dom.window.document, 'https://author.org/')).toEqual([
      { url: 'https://author.org/report', title: 'Original article' },
      { url: 'https://author.org/paper', title: 'Original paper' },
    ]);
  } finally { dom.window.close(); }
});

it('rejects login actions and unsafe schemes even with a plausible link label', () => {
  const dom = new JSDOM('<a href="javascript:alert(1)">Read blog</a><a href="/sign-up?pricing">Pricing</a>'
    + '<a href="https://user:secret@issuer.org/release">Announcement</a>');
  try { expect(articleFollowups(dom.window.document, 'https://company.org/')).toEqual([]); }
  finally { dom.window.close(); }
});
