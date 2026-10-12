import type { PoolClient } from 'pg';
import { snapshotFor, type StoryContent } from './content.js';

/** Preview uses the same current source list as publication. */
export async function expectedSourceUrls(client: Pick<PoolClient, 'query'>, storyId: string, story?: StoryContent): Promise<Set<string>> {
  const current = story ?? (await client.query<StoryContent>('SELECT * FROM stories WHERE id=$1', [storyId])).rows[0];
  if (!current || current.id !== storyId) return new Set();
  return new Set((await snapshotFor(client, current)).sources.map(source => source.url));
}
