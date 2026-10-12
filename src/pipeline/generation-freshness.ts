import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { alreadyGenerated, loadStory, loadStoryWithQuery } from './generation-store.js';

/** Reuse the generator's exact model/version/input/output contract, not a weaker SQL approximation. */
export async function generationIsCurrent(id: string, settings: AppSettings, query?: typeof db.query, receiptId?: string): Promise<boolean> {
  const input = query ? await loadStoryWithQuery(id,query) : await loadStory(id);
  const score = input.story.interest_score;
  if (score === null || !input.story.headline?.trim()) return false;
  if (!input.story.researched || !input.story.summary?.trim()) return false;
  return query || receiptId ? alreadyGenerated(input,settings,query ?? db.query.bind(db),receiptId)
    : alreadyGenerated(input,settings);
}

