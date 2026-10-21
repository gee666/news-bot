import { webMediaSchema } from './media.js';
import { z } from 'zod';
import { publicUrl, resolvePublicAddress } from '../pipeline/research-fetch.js';

const prefix = z.string().min(1).max(200).regex(/^\/[a-zA-Z0-9/_-]*$/u)
  .refine(value => value.endsWith('/'), 'Article path prefixes must end with /');
const sourceConfig = z.object({
  kind: z.enum(['feed', 'website']), name: z.string().trim().min(1).max(200),
  url: z.string().max(4096), publisher: z.string().trim().min(1).max(200),
  articlePathPrefixes: z.array(prefix).min(1).max(10),
  articleLinkPolicy: z.enum(['same_host', 'external']).default('same_host'),
  maxArticles: z.number().int().min(1).max(50).default(3),
  backlogLimit: z.number().int().min(1).max(1000).optional(),
  retryDelayMinutes: z.number().int().min(1).max(720).optional(),
  feedDateRole: z.enum(['publication', 'submission']).optional(),
  unknownPublication: z.enum(['skip', 'collect_once']).default('skip'),
  enabled: z.boolean().default(true),
}).strict();
export const primarySourceInput = sourceConfig
  .refine(source => source.kind === 'feed' || source.articleLinkPolicy === 'same_host',
    { message: 'External article links are only allowed for feeds', path: ['articleLinkPolicy'] })
  .refine(source => source.kind === 'feed' || source.feedDateRole !== 'submission',
    { message: 'Submission dates are only supported for feeds', path: ['feedDateRole'] });
export const primarySourcePatch = sourceConfig.partial().extend({
  articleLinkPolicy: primarySourceInput.shape.articleLinkPolicy.removeDefault().optional(),
  maxArticles: primarySourceInput.shape.maxArticles.removeDefault().optional(),
  unknownPublication: primarySourceInput.shape.unknownPublication.removeDefault().optional(),
  enabled: primarySourceInput.shape.enabled.removeDefault().optional(),
});
export type PrimarySourceInput = z.infer<typeof primarySourceInput>;
export const publisherBacklogEntrySchema = z.object({
  id: z.string().min(1).max(4096), url: z.string().max(4096), title: z.string().max(500).nullable(),
  publishedAt: z.string().datetime().nullable(), discoveredAt: z.string().datetime(),
  media: z.array(webMediaSchema).max(100).optional(),
  failures: z.number().int().min(0).max(10).default(0),
  nextAttemptAt: z.string().datetime().nullable().default(null),
  lastErrorCode: z.string().max(100).regex(/^primary_[a-z0-9_]+$/u).nullable().default(null),
});
export type PublisherBacklogEntry = z.infer<typeof publisherBacklogEntrySchema>;
export const primaryCursorSchema = z.object({
  cutoff: z.string().datetime().nullable().default(null),
  completedIds: z.array(z.string().max(4096)).max(100).default([]),
  unknownIds: z.array(z.string().max(4096)).max(1000).default([]),
  seen: z.array(z.object({ id: z.string().max(4096), checkedAt: z.string().datetime() })).max(1000).default([]),
  unseenBatches: z.number().int().min(0).max(2).default(0),
  rechecked: z.boolean().default(false),
  attemptedIds: z.array(z.string().max(4096)).max(100).default([]),
  backlog: z.array(publisherBacklogEntrySchema).max(1000).default([]),
  backlogOverflow: z.number().int().min(0).max(1_000_000_000).default(0),
  skippedUnknownIds: z.array(z.string().max(4096)).max(1000).default([]),
  unknownPolicy: z.enum(['skip', 'collect_once']).nullable().default(null),
});
export type PrimaryCursor = z.infer<typeof primaryCursorSchema>;
export interface PrimarySource extends PrimarySourceInput {
  id: string; cursor: z.input<typeof primaryCursorSchema>; configVersion?: number;
}

export async function validatePrimarySource(input: unknown): Promise<PrimarySourceInput> {
  const parsed = primarySourceInput.parse(input);
  const url = publicUrl(parsed.url);
  await resolvePublicAddress(url.hostname);
  return { ...parsed, url: url.href };
}
export function publisherArticle(input: string, source: PrimarySourceInput): string | null {
  try {
    const url = publicUrl(new URL(input, source.url).href);
    const origin = new URL(source.url);
    const allowedHost = url.hostname === origin.hostname
      || (source.kind === 'feed' && source.articleLinkPolicy === 'external');
    return allowedHost && source.articlePathPrefixes.some(path => url.pathname.startsWith(path))
      && url.href !== source.url ? url.href : null;
  } catch { return null; }
}
