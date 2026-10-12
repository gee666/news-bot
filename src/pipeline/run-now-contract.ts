import { z } from 'zod';

export const runNowOptionsSchema = z.object({
  mode: z.enum(['collect', 'collected']).default('collect'),
  publicationLimit: z.number().int().min(1).max(10).default(5),
  sourceLimit: z.number().int().min(1).max(10).default(3),
  inputLimit: z.number().int().min(1).max(50).default(20),
  storyLimit: z.number().int().min(1).max(10).default(5),
}).strict();
export type RunNowOptions = z.infer<typeof runNowOptionsSchema>;
export const runNowProgressSchema = z.object({
  options: runNowOptionsSchema,
  stage: z.enum(['queued', 'collecting', 'processing', 'publishing', 'finished']),
  sources: z.number().int().nonnegative().default(0),
  inputs: z.number().int().nonnegative().default(0),
  processed: z.number().int().nonnegative().default(0),
  rejected: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  stories: z.number().int().nonnegative().default(0),
  published: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0),
  reasons: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type RunNowProgress = z.infer<typeof runNowProgressSchema>;
