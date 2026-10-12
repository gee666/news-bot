import { z } from 'zod';
import { ModelRequestError } from '../models/errors.js';

/** Only output validation is local. Zod errors inside stage work can indicate broken inputs or code. */
export class StageOutputError extends Error {
  readonly code = 'invalid_output';
  constructor(cause: z.ZodError) {
    super('Stage output failed validation. Correct the input or output contract before retrying.', { cause });
    this.name = 'StageOutputError';
  }
}

export function isOutputFailure(error: unknown): boolean {
  return error instanceof StageOutputError || error instanceof ModelRequestError && error.metadata.kind === 'invalid_output';
}

export function validateStageOutput<T>(validator: z.ZodType<T>, output: unknown): T {
  const parsed = validator.safeParse(output);
  if (!parsed.success) throw new StageOutputError(parsed.error);
  return parsed.data;
}
