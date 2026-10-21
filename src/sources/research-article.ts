import { prepareArticleMedia, discoverMedia } from './media.js';
import type { CleanArticle } from './article.js';
import { arxivAddress } from './arxiv-address.js';
import { separateTableBlocks } from './article-dom.js';

/** arXiv's abstract page is the authors' publication, not a publisher's summary. */
export function researchArticle(document: Document, url: string, markdown: (html: string) => string): CleanArticle | null {
  const address = arxivAddress(url);
  if (!address) return null;
  if (address.kind === 'html') {
    const article = document.querySelector('article.ltx_document');
    const title = article?.querySelector('.ltx_title_document')?.textContent?.trim();
    const versionLink = [...document.querySelectorAll('a[href]')].map(link => arxivAddress(link.getAttribute('href') ?? '', url))
      .find(link => link?.kind === 'abs' && link.id === address.id);
    if (!article || !title || !article.querySelector('.ltx_section') || !versionLink?.version
      || (address.version && address.version !== versionLink.version)) return null;
    const authors = [...article.querySelectorAll('.ltx_personname')].map(node => node.textContent?.trim()).filter(Boolean).join(', ') || null;
    for (const node of article.querySelectorAll('script,style,nav,annotation,annotation-xml')) node.remove();
    // Markdown conversion does not retain MathML. Keep its presentation text once, not duplicate TeX annotations.
    for (const math of article.querySelectorAll('math')) math.replaceWith(document.createTextNode(math.textContent?.trim() ?? ''));
    separateTableBlocks(document);
    prepareArticleMedia(article, url);
    const content = markdown(article.outerHTML);
    return content ? { title, media: discoverMedia(content, url), byline: authors, publishedAt: null, content, cleaning: 'arxiv_full_text',
      paper: { id: address.id, version: versionLink.version, extent: 'full_text' } } : null;
  }
  if (address.kind !== 'abs') return null;
  const title = document.querySelector('meta[name="citation_title"]')?.getAttribute('content')?.trim()
    || document.querySelector('h1.title')?.textContent?.replace(/^\s*Title:\s*/u, '').trim();
  const abstract = document.querySelector('blockquote.abstract')?.textContent?.replace(/^\s*Abstract:\s*/u, '').trim();
  if (!title || !abstract) return null;
  const authors = [...document.querySelectorAll('meta[name="citation_author"]')]
    .map(node => node.getAttribute('content')?.trim()).filter(Boolean).join(', ')
    || document.querySelector('.authors')?.textContent?.replace(/^\s*Authors:\s*/u, '').trim() || null;
  const publishedAt = document.querySelector('meta[name="citation_date"]')?.getAttribute('content')?.replaceAll('/', '-') ?? null;
  const declared = arxivAddress(document.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? '');
  const version = declared?.id === address.id ? declared.version : address.version;
  if (address.version && version !== address.version) return null;
  return { title, byline: authors, publishedAt, cleaning: 'arxiv_abstract', paper: { id: address.id, version, extent: 'abstract' },
    content: `# ${title}\n\n${authors ? `Authors: ${authors}\n\n` : ''}## Abstract\n\n${abstract}` };
}
