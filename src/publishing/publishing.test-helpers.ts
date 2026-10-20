import type { AppSettings } from '../settings.js';
import type { PublicationSource } from '../types.js';
export const fixtureSource: PublicationSource = { url: 'https://fixture.example/announcement', label: 'Fixture announcement',
  primary: true, kind: 'primary', access: 'public', classification: 'relevant' };

/** Offline generation receipts for tests that change a story's inputs or output. */
export async function acceptFixtureStories(settings: AppSettings, storyIds?: string[]): Promise<void> {
  const { db } = await import('../db.js');
  const { loadStory, saveGenerations } = await import('../pipeline/generation-store.js');
  const rows = (await db.query<{ id: string }>("SELECT id FROM stories WHERE status='completed' AND headline IS NOT NULL AND summary IS NOT NULL AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY id", [storyIds ?? null])).rows;
  for (const { id } of rows) {
    const input = await loadStory(id);
    if (!input.story.headline || !input.story.summary) throw new Error('Incomplete fixture output');
    await saveGenerations([input], [{ id, headline: input.story.headline, summary: input.story.summary,
      translatedExcerpt: input.story.translated_excerpt,
      review: { supported: true, reason: 'Существенных ошибок не найдено' },
    }], settings);
  }
}
