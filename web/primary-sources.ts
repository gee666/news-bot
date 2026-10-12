import { z } from 'zod';

export const primarySourceInputSchema = z.object({
  kind: z.enum(['feed', 'website']), name: z.string(), publisher: z.string(), url: z.string(),
  articleLinkPolicy: z.enum(['same_host', 'external']).default('same_host'),
  articlePathPrefixes: z.array(z.string()), maxArticles: z.number().int().min(1).max(50),
  backlogLimit: z.number().int().min(1).max(1000).optional(),
  retryDelayMinutes: z.number().int().min(1).max(720).optional(),
  feedDateRole: z.enum(['publication', 'submission']).optional(),
  unknownPublication: z.enum(['skip', 'collect_once']), enabled: z.boolean(),
}).strict().refine(source => source.kind === 'feed'
  || (source.articleLinkPolicy === 'same_host' && source.feedDateRole !== 'submission'),
{ message: 'External links and submission dates require a feed' });
const validSourceSchema = primarySourceInputSchema.safeExtend({
  id: z.uuid(), configState: z.literal('valid'), identityLocked: z.boolean(),
  cursor: z.object({
    cutoff: z.iso.datetime().nullable().default(null),
    completedIds: z.array(z.string().max(4096)).max(100).default([]),
    unknownIds: z.array(z.string().max(4096)).max(1000).default([]),
    seen: z.array(z.object({ id: z.string().max(4096), checkedAt: z.iso.datetime() })).max(1000).default([]),
    unseenBatches: z.number().int().min(0).max(2).default(0), rechecked: z.boolean().default(false),
    attemptedIds: z.array(z.string().max(4096)).max(100).default([]),
    backlog: z.array(z.object({
      id: z.string().min(1).max(4096), url: z.string().max(4096), title: z.string().max(500).nullable(),
      publishedAt: z.iso.datetime().nullable(), discoveredAt: z.iso.datetime(),
      failures: z.number().int().min(0).max(10).default(0),
      nextAttemptAt: z.iso.datetime().nullable().default(null),
      lastErrorCode: z.string().max(100).regex(/^primary_[a-z0-9_]+$/u).nullable().default(null),
    }).strict()).max(1000).default([]),
    backlogOverflow: z.number().int().min(0).max(1_000_000_000).default(0),
    skippedUnknownIds: z.array(z.string().max(4096)).max(1000).default([]),
    unknownPolicy: z.enum(['skip', 'collect_once']).nullable().default(null),
  }).strict(),
}).strict();
export const primarySourceSchema = z.discriminatedUnion('configState', [
  validSourceSchema,
  z.object({
    id: z.uuid(), kind: z.enum(['feed', 'website']), name: z.string(), url: z.string().nullable(),
    enabled: z.boolean(), identityLocked: z.boolean(), configState: z.literal('invalid'),
    errorCode: z.literal('primary_source_invalid_config'),
  }).strict(),
]);
export type PrimarySource = z.infer<typeof validSourceSchema>;
export type PrimarySourceView = z.infer<typeof primarySourceSchema>;
export type PrimarySourceInput = z.infer<typeof primarySourceInputSchema>;
export type SourceDraft = Omit<PrimarySourceInput, 'articlePathPrefixes'> & { articlePathPrefixes: string };
export const emptySourceDraft: SourceDraft = {
  kind: 'feed', name: '', publisher: '', url: '', articlePathPrefixes: '/',
  articleLinkPolicy: 'same_host', maxArticles: 3, unknownPublication: 'skip', enabled: true,
};
// Only used when the operator starts a new subscription with this preset.
export const hackerNewsSourceDraft: SourceDraft = {
  ...emptySourceDraft, name: 'Hacker News', publisher: 'Hacker News', url: 'https://hnrss.org/newest',
  articleLinkPolicy: 'external', feedDateRole: 'submission', unknownPublication: 'collect_once',
  maxArticles: 20, backlogLimit: 200, retryDelayMinutes: 60,
};
export function sourceDraft(source: PrimarySource): SourceDraft {
  return { kind: source.kind, name: source.name, publisher: source.publisher, url: source.url,
    articleLinkPolicy: source.articleLinkPolicy,
    articlePathPrefixes: source.articlePathPrefixes.join('\n'), maxArticles: source.maxArticles,
    ...(source.backlogLimit === undefined ? {} : { backlogLimit: source.backlogLimit }),
    ...(source.retryDelayMinutes === undefined ? {} : { retryDelayMinutes: source.retryDelayMinutes }),
    ...(source.feedDateRole === undefined ? {} : { feedDateRole: source.feedDateRole }),
    unknownPublication: source.unknownPublication, enabled: source.enabled };
}
export function sourceInput(draft: SourceDraft): PrimarySourceInput {
  return primarySourceInputSchema.parse({ ...draft,
    articlePathPrefixes: draft.articlePathPrefixes.split(/[\n,]/u).map(path => path.trim()).filter(Boolean) });
}
