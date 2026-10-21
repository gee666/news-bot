import { elementMedia } from './media.js';
import type { CleanArticle } from './article.js';
import { articleLink, type ArticleFollowup } from './article-followups.js';

interface PostAddress { id: string; handle: string; url: string }
function address(input: string, base?: string): PostAddress | null {
  try {
    const url = new URL(input, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !['x.com', 'twitter.com'].includes(url.hostname.replace(/^(?:www|mobile)\./u, ''))) return null;
    const match = /^\/([^/]+)\/status\/(\d+)\/?$/u.exec(url.pathname);
    if (!match?.[1] || !match[2]) return null;
    url.search = ''; url.hash = '';
    return { id: match[2], handle: match[1].toLowerCase(), url: url.href };
  } catch { return null; }
}

export function isSocialPost(url: string): boolean { return address(url) !== null; }

function belongsToPost(node: Element, article: Element): boolean {
  if (node.closest('article') !== article
    || node.closest('blockquote, [data-testid="quoteTweet"], [data-quoted-post]')) return false;
  // X also renders quotes as a non-article link container with its own post permalink.
  const container = node.closest('[role="link"]');
  return !container || ![...container.querySelectorAll('a[href]')]
    .some(link => address(link.getAttribute('href') ?? '', 'https://x.com'));
}
function ownLinks(article: Element): Element[] {
  return [...article.querySelectorAll('a[href]')].filter(link => belongsToPost(link, article));
}
function postFollowups(article: Element, base: string): ArticleFollowup[] {
  const links = new Map<string, ArticleFollowup>();
  for (const anchor of ownLinks(article)) {
    // Ignore profile, action and navigation links, even inside the requested article.
    if (!anchor.closest('[data-testid="tweetText"], [data-post-text], [data-testid="card.wrapper"], [data-testid^="card.layout"]')
      || anchor.closest('nav, aside, footer, [role="navigation"], [role="button"]')) continue;
    const link = articleLink(anchor, base);
    if (!link) continue;
    const host = new URL(link.url).hostname.replace(/^(?:www|mobile)\./u, '');
    if (['x.com', 'twitter.com'].includes(host)) continue;
    if (!links.has(link.url)) links.set(link.url, link);
    if (links.size === 2) break;
  }
  return [...links.values()];
}
function postAddress(article: Element, base: string): PostAddress | null {
  for (const link of ownLinks(article)) {
    const post = address(link.getAttribute('href') ?? '', base);
    if (post) return post;
  }
  return address(article.parentElement?.getAttribute('data-href') ?? '', base);
}
function postText(article: Element): string {
  const explicit = article.querySelectorAll('[data-testid="tweetText"], [data-post-text]');
  const elements = explicit.length ? explicit : article.querySelectorAll('div[dir="auto"]');
  return [...elements].filter(node => belongsToPost(node, article))
    .map(node => node.textContent?.trim() ?? '').filter(Boolean).join('\n\n');
}
function author(article: Element, post: PostAddress): string {
  for (const link of ownLinks(article)) {
    try {
      const profile = new URL(link.getAttribute('href') ?? '', post.url);
      if (!['x.com', 'twitter.com'].includes(profile.hostname.replace(/^(?:www|mobile)\./u, ''))) continue;
      const path = profile.pathname.toLowerCase();
      const name = link.textContent?.trim();
      if (path === `/${post.handle}` && name && !name.startsWith('@')) return `${name} (@${post.handle})`;
    } catch { /* Invalid page links cannot establish an author. */ }
  }
  return `@${post.handle}`;
}

/** Read the requested post, not whichever reply Readability selects from a thread. */
export function socialPost(document: Document, url: string): CleanArticle | null {
  const requested = address(url);
  if (!requested) return null;
  const articles = [...document.querySelectorAll('article')];
  const target = articles.find(article => {
    const post = postAddress(article, url);
    return post?.id === requested.id && post.handle === requested.handle;
  });
  if (!target) return null;
  const text = postText(target);
  if (!text) return null;
  const media = elementMedia(target, url, node => belongsToPost(node, target));
  const mediaContent = media.map(item => item.type === 'image' ? `![](${item.url})` : `[Video](${item.url} "video")`).join('\n\n');
  const byline = author(target, requested);
  const followupLinks = postFollowups(target, requested.url);
  // Same-author thread posts supply explicit involved-party context, never a reputation badge.
  const context: string[] = [];
  for (const article of articles) {
    if (context.length >= 2) break;
    const post = postAddress(article, url);
    const related = postText(article);
    if (!post || post.id === requested.id || post.handle !== requested.handle || !related) continue;
    context.push(`## Same-author post read on this page\n\n${post.url}\n\n${related}`);
  }
  const time = [...target.querySelectorAll('time[datetime]')].find(node => node.closest('article') === target)?.getAttribute('datetime') ?? null;
  return { title: `${byline}: ${text.slice(0, 180)}`, byline, publishedAt: time, cleaning: 'social_post',
    media, content: [`# Post by ${byline}`, requested.url, text, mediaContent, ...context].filter(Boolean).join('\n\n'),
    ...(followupLinks.length ? { followupLinks } : {}) };
}
