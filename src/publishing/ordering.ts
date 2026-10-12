/** Oldest current relevant source date first. Unknown dates use immutable first-collection retention time. */
export function newsOrderTime(storyAlias: 's' | 'news'): string {
  return `coalesce((SELECT coalesce(min(i.published_at),min(i.retention_at)) FROM source_items i
    JOIN item_revisions r ON i.current_revision_id=r.id WHERE r.id IN (
      SELECT m.revision_id FROM story_mentions m WHERE m.story_id=${storyAlias}.id
      UNION SELECT l.revision_id FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
        WHERE sl.story_id=${storyAlias}.id AND sl.classification='relevant'
    )),${storyAlias}.created_at)`;
}
