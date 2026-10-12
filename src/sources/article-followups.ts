export interface ArticleFollowup { url: string; title: string }
const originalLabel = /(?:read (?:the )?blog|(?:full|original) (?:paper|article)|(?:full )?pricing|release notes|announcement|html \(experimental\)|полная статья|первоисточник|цены)/iu;

/** Parse a candidate only; public-network checks still run when research fetches it. */
export function articleLink(anchor: Element, base: string): ArticleFollowup | null {
  try {
    const url = new URL(anchor.getAttribute('href') ?? '', base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096
      || /\/(?:login|sign-?in|sign-?up|register)(?:\/|$)/iu.test(url.pathname)) return null;
    url.hash = '';
    if (url.href === new URL(base).href) return null;
    const title = anchor.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
    return { url: url.href, title: title.slice(0, 200) };
  } catch { return null; }
}

/** Actual document links are discovery candidates, not confirmation of anything behind the link. */
export function articleFollowups(document: Document, base: string): ArticleFollowup[] {
  const links = new Map<string, ArticleFollowup>();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!originalLabel.test(anchor.textContent?.replace(/\s+/gu, ' ').trim() ?? '')) continue;
    const link = articleLink(anchor, base);
    if (link && !links.has(link.url)) links.set(link.url, link);
    if (links.size === 2) break;
  }
  return [...links.values()];
}
