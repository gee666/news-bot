import { setTimeout as delay } from 'node:timers/promises';
import { envInteger, fetchPublic, ResearchFetchError, type FetchedResponse } from './research-fetch.js';

/** Retry transport failures and temporary server errors, never permissions, unsafe URLs or size limits. */
export async function readHttp(url: string): Promise<FetchedResponse> {
  const attempts = envInteger('RESEARCH_HTTP_MAX_ATTEMPTS', 2, 3);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchPublic(url);
      if (attempt === attempts || ![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      if (!(error instanceof ResearchFetchError) || error.code !== 'fetch_failed' || attempt === attempts) throw error;
    }
    await delay(Math.min(1000, 250 * attempt));
  }
}
