import type { StoryInput } from './generation-store.js';

export function researchMentions(input: StoryInput) {
  return [...input.mentions].sort((left, right) =>
    (Date.parse(left.published_at ?? left.collected_at ?? '') || 0)
      - (Date.parse(right.published_at ?? right.collected_at ?? '') || 0)).map(mention => ({
    id: mention.id, source_name: mention.source_name, connector_type: mention.connector_type, url: mention.original_url,
    published_at: mention.published_at ?? null, collected_at: mention.collected_at ?? null,
    reported_at: mention.published_at ?? mention.collected_at ?? null,
    time_basis: mention.published_at ? 'published' : mention.collected_at ? 'collected' : 'unknown',
    text: mention.text, referent_context: mention.referent_context ?? [],
  }));
}
