import { z } from 'zod';

export const MAX_HEADLINE_CHARS = 180;

/** Limit generated news prose, not separately rendered source links or historical posts. */
export function summaryMaxChars(): number {
  return z.coerce.number().int().min(200).max(2000).parse(process.env.NEWS_SUMMARY_MAX_CHARS ?? 1000);
}
