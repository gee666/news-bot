// Missing flags preserve legacy/Telegram references. Malformed explicit policy is never evidence.
export const evidenceLinkSql = `jsonb_typeof(l.metadata)='object' AND
  (NOT (l.metadata ? 'evidenceEligible') OR l.metadata->'evidenceEligible'='true'::jsonb)`;
