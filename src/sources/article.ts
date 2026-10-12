import { Readability } from '@mozilla/readability';
import { researchArticle } from './research-article.js';
import { isSocialPost, socialPost } from './social-post.js';
import { removeAnimatedCopies, separateTableBlocks } from './article-dom.js';
import { articleFollowups, type ArticleFollowup } from './article-followups.js';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

const markdown = unified().use(rehypeParse, { fragment: true }).use(rehypeRemark).use(remarkGfm).use(remarkStringify);
export interface CleanArticle {
  content: string; title: string | null; byline: string | null; publishedAt: string | null;
  followupLinks?: ArticleFollowup[];
  cleaning?: 'social_post' | 'arxiv_abstract' | 'arxiv_full_text';
  paper?: { id: string; version: string | null; extent: 'abstract' | 'full_text' };
}

/** Parse only. JSDOM never runs scripts or loads subresources; browser/DNS safety stays in Crawl4AI. */
export function cleanArticle(html: string, url: string): CleanArticle | null {
  if (!html || Buffer.byteLength(html) > 5_000_000) return null;
  const dom = new JSDOM('', { url });
  try {
    // No browsing context: skip stylesheet parsing, but retain inline styles for article selection.
    const document = new dom.window.DOMParser().parseFromString(html, 'text/html');
    if (isSocialPost(url)) return socialPost(document, url);
    const research = researchArticle(document, url, html => String(markdown.processSync(html)).trim());
    if (research) return research;
    const comments = document.createTreeWalker(document, dom.window.NodeFilter.SHOW_COMMENT);
    const nodes: Node[] = [];
    while (comments.nextNode()) nodes.push(comments.currentNode);
    for (const node of nodes) node.parentNode?.removeChild(node);
    for (const node of document.querySelectorAll('nav,footer,aside,[role="navigation"],[role="contentinfo"],[itemprop="comment"],[itemtype$="/Comment"]')) node.remove();
    removeAnimatedCopies(document);
    separateTableBlocks(document);
    const followupLinks = articleFollowups(document, url);
    const article = new Readability(document, { charThreshold: 0, maxElemsToParse: 100_000 }).parse();
    if (!article?.content || !article.textContent?.trim()) return null;
    const content = String(markdown.processSync(article.content)).trim();
    return content ? { content, title: article.title?.trim() || null, byline: article.byline?.trim() || null,
      publishedAt: article.publishedTime || null, ...(followupLinks.length ? { followupLinks } : {}) } : null;
  } catch { return null; }
  finally { dom.window.close(); }
}
