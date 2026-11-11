import { z } from 'zod';
import { db } from '../db.js';
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

/** Coverage belongs to the receipt behind the actual posted snapshot, not today's
 * component or another generation with identical wording. Legacy multi-post groups
 * rebuild once; a single post always covers itself. Posted receipts do not expire. */
export async function latestPublishedEditionCovers(posts: readonly ThreadPost[], query = db.query.bind(db)): Promise<boolean> {
  const latest = posts.at(-1);
  if (!latest) return false;
  const required = [...new Set(posts.map(post => post.storyId))].filter(id => id !== latest.storyId);
  if (!required.length) return true;
  const result = await query<{ coverage: unknown }>(`SELECT j.result->'coveredPublishedStoryIds' AS coverage
    FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id
    JOIN judgments j ON j.id=snap.generation_id AND j.stage='generation_research'
    WHERE p.story_id=$1 AND p.destination_id=$2 AND p.message_id=$3 AND p.published_at IS NOT NULL
      AND snap.content->>'headline'=$4 AND snap.content->>'details'=$5
      AND j.result->>'headline'=$4 AND j.result->>'summary'=$5`,
  [latest.storyId, latest.destinationId, latest.messageId, latest.headline, latest.details]);
  const saved = z.array(z.uuid()).safeParse(result.rows[0]?.coverage);
  return saved.success && required.every(id => saved.data.includes(id));
}

/** A new primary or joined publication branch rebuilds from fresh original reads,
 * without discovery page limits. */
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
