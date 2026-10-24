import type { ThreadPost } from './publication-thread.js';

/** Posted facts are editorial input; mutable publication navigation is not. */
export function generationHistory(posts: readonly ThreadPost[]) {
  return posts.map(post => ({ storyId: post.storyId, headline: post.headline, summary: post.details,
    ...(post.earlier ? { earlier: post.earlier } : {}),
    sources: post.sources.filter(source => !source.previousPublication && !source.relatedPublication && !source.unverifiedPublication)
      .map(({ url, primary, kind, classification }) => ({ url, primary, kind, classification }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  }));
}
