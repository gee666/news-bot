import { z } from 'zod';

/** Prompt measurement plus framing reserve, not provider-evaluated usage or evidence of invalid facts. */
export const jevContextBudgetSchema = z.object({ method: z.enum(['autojev_qwen35', 'utf8_upper_bound']),
  promptTokens: z.number().int().nonnegative().max(100_000_000), reservedTokens: z.number().int().min(128).max(4096),
  contextTokens: z.number().int().min(512).max(1_000_000), inputBytes: z.number().int().nonnegative().max(100_000_000) });
export type JevContextBudget = z.infer<typeof jevContextBudgetSchema>;
