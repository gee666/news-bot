import { z } from 'zod';

export type ConnectorType = 'telegram' | 'email' | 'website' | 'feed';
export type AccessStatus = 'public' | 'restricted' | 'unknown';
export type StoryStatus = 'pending' | 'processing' | 'completed' | 'rejected' | 'failed';
export type BatchStatus = 'queued' | 'collecting' | 'processing' | 'waiting' | 'completed' | 'failed';
export type StageStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';
export type LinkClassification = 'relevant' | 'irrelevant' | 'uncertain';
export type PublicationStatus = 'prepared' | 'sending' | 'published' | 'uncertain' | 'failed';

export const sourceAuthorityKindSchema = z.enum(['primary', 'journalism', 'discovery']);
export type SourceAuthorityKind = z.infer<typeof sourceAuthorityKindSchema>;
export const sourceAuthorityRanks: Readonly<Record<SourceAuthorityKind, number>> = { primary: 0, journalism: 1, discovery: 2 };
export const generationReviewSchema = z.object({
  supported: z.boolean(), reason: z.union([z.literal(''), z.string().trim().min(1).regex(/[А-Яа-яЁё]/u)]),
}).strict().refine(review => review.supported || review.reason.length > 0);
export type GenerationReview = z.infer<typeof generationReviewSchema>;

export const publicationSourceSchema = z.object({
  label: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1).optional(),
  url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  access: z.enum(['public', 'restricted', 'unavailable', 'unknown']),
  primary: z.boolean(),
  previousPublication: z.literal(true).optional(),
  kind: sourceAuthorityKindSchema.optional(),
  classification: z.enum(['relevant', 'uncertain']),
}).strict().transform(source => source.kind ? { ...source, primary: source.kind === 'primary' } : source);

export const publicationSnapshotSchema = z.object({
  headline: z.string().min(1),
  score: z.number().int().min(1).max(10),
  details: z.string(),
  /** Combined summary of earlier posts in a follow-up thread; details then hold only the new information. */
  earlier: z.string().min(1).optional(),
  detailsKind: z.enum(['summary', 'excerpt']),
  sources: z.array(publicationSourceSchema),
  review: generationReviewSchema.optional(),
  updatedTo: z.string().regex(/^https:\/\/t\.me\/c\/\d+\/[1-9]\d*$/u).optional(),
}).strict();

export type PublicationSource = z.infer<typeof publicationSourceSchema>;
export type PublicationSnapshot = z.infer<typeof publicationSnapshotSchema>;
