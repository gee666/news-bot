import { arxivAddress } from '../sources/arxiv-address.js';
import type { ResearchPage } from './research-page.js';

/** One paper, at most two representation reads. Never substitute another revision or call an abstract full text. */
export async function readArxiv(url: string, read: (url: string) => Promise<ResearchPage>, maxRepresentations: 1 | 2 = 2): Promise<ResearchPage | null> {
  const requested = arxivAddress(url);
  if (!requested) return null;
  const suffix = `${requested.id}${requested.version ?? ''}`;
  const citation = `https://arxiv.org/abs/${suffix}`;
  const htmlUrl = `https://arxiv.org/html/${suffix}`;
  const full = await read(htmlUrl);
  const paper = full.metadata.paper;
  if (full.access === 'public' && full.content?.trim() && paper?.extent === 'full_text' && paper.id === requested.id
    && (!requested.version || paper.version === requested.version)) {
    return { ...full, url, canonicalUrl: citation, metadata: { ...full.metadata, readUrl: full.canonicalUrl ?? htmlUrl, representationReads: 1 } };
  }
  if (maxRepresentations === 1) return { ...full, url, canonicalUrl: citation, content: null,
    access: full.access === 'public' ? 'unavailable' : full.access,
    metadata: { ...full.metadata, representationReads: 1, abstractFallbackSkipped: 'page_budget',
      error: full.metadata.error ?? 'arxiv_full_text_unverified' } };
  const abstract = await read(citation);
  const matches = abstract.metadata.paper?.id === requested.id && abstract.metadata.paper.extent === 'abstract'
    && (!requested.version || abstract.metadata.paper.version === requested.version);
  return { ...abstract, url, canonicalUrl: citation, content: matches ? abstract.content : null,
    access: matches || abstract.access !== 'public' ? abstract.access : 'unavailable',
    metadata: { ...abstract.metadata, readUrl: abstract.canonicalUrl ?? citation, representationReads: 2,
      fullTextError: full.metadata.error ?? (full.metadata.status && full.metadata.status !== 200 ? `http_${full.metadata.status}` : 'full_text_unverified'),
      ...(!matches && abstract.access === 'public' ? { error: 'arxiv_abstract_unverified' } : {}) } };
}
