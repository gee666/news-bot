import { z } from 'zod';
import { publicUrl } from '../pipeline/research-fetch.js';
import { primarySourceInput, primaryCursorSchema } from './config.js';

export const primarySourceViewSchema = z.discriminatedUnion('configState', [
  primarySourceInput.safeExtend({ id: z.uuid(), cursor: primaryCursorSchema,
    configState: z.literal('valid'), identityLocked: z.boolean() }).strict(),
  z.object({ id: z.uuid(), kind: z.enum(['feed', 'website']), name: z.string(),
    url: z.string().nullable(), enabled: z.boolean(), identityLocked: z.boolean(),
    configState: z.literal('invalid'), errorCode: z.literal('primary_source_invalid_config') }).strict(),
]);
export type PrimarySourceView = z.infer<typeof primarySourceViewSchema>;
export const sourceIdentitySchema = z.object({ id: z.uuid(), connector_type: z.enum(['feed', 'website']),
  name: z.string(), original_url: z.string().nullable(), enabled: z.boolean() });
export function safeSourceUrl(input: string | null): string | null {
  if (!input) return null;
  try { return publicUrl(input).href; } catch { return null; }
}
