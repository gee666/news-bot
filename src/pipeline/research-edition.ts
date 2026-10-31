import type { TextGenerator } from '../models/index.js';
import type { AppSettings } from '../settings.js';
import { generationHash, saveEvidence, type Evidence, type StoryInput } from './generation-store.js';
import { fetchPage } from './research-page.js';
import { normalizedResearchUrl } from './research-priority.js';
import { reassessEvidence } from './research.js';
import { arxivAddress } from '../sources/arxiv-address.js';
import { readFailure } from '../sources/read-quality.js';
import { ResearchFetchError } from './research-fetch.js';
import type { ThreadPost } from './publication-thread.js';

/** Redirect aliases refer to one source, not a new primary publication. */
export function editionPrimaries(posts: readonly ThreadPost[], previous: readonly Evidence[], origins: readonly string[]) {
  const retained = [...new Set([
    ...posts.flatMap(post => post.sources.filter(source => source.primary || source.kind === 'primary')
      .filter(source => !source.previousPublication && !source.relatedPublication && !source.unverifiedPublication).map(source => source.url)),
    ...previous.filter(doc => doc.role === 'primary' && doc.relevance === 'relevant').map(doc => doc.canonical_url ?? doc.url),
  ])];
  const known = new Set(retained.map(normalizedResearchUrl));
  for (const doc of previous) {
    if ([doc.url, doc.canonical_url].some(url => url && known.has(normalizedResearchUrl(url)))) {
      known.add(normalizedResearchUrl(doc.url));
      if (doc.canonical_url) known.add(normalizedResearchUrl(doc.canonical_url));
      const paper = doc.metadata?.paper;
      const citation = arxivAddress(doc.canonical_url ?? doc.url);
      if (paper?.version && /^v\d+$/u.test(paper.version) && citation?.id === paper.id
        && (!citation.version || citation.version === paper.version)) {
        known.add(`https://arxiv.org/abs/${paper.id}${paper.version}`);
      }
    }
  }
  const added = origins.filter(url => !known.has(normalizedResearchUrl(url)));
  const urls = new Map([...retained, ...added].map(url => [normalizedResearchUrl(url), url]));
  return { added, urls: [...urls.values()] };
}

/** A new primary rebuilds the edition from fresh original reads, without discovery page limits. */
export async function readEditionPrimaries(input: StoryInput, urls: readonly string[], settings: AppSettings,
  generator: TextGenerator): Promise<Evidence[]> {
  const hash = `${generationHash(input, settings)}:edition-primary-v1`;
  const documents: Evidence[] = [];
  for (const url of urls) {
    const page = await fetchPage(url);
    const saved = await saveEvidence(input.story.id, page, settings, hash);
    if (saved.access !== 'public' || !saved.content?.trim()
      || readFailure(saved.title, saved.content, saved.canonical_url ?? saved.url, saved.metadata)) {
      throw new ResearchFetchError('fetch_failed');
    }
    documents.push(await reassessEvidence(input, saved, generator, settings));
  }
  return documents;
}
