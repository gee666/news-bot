-- One-time recovery of the old disabled-search profile. Do not replace the user's profile or versions.
-- Other thresholds and nonzero search budgets remain explicit operator choices.
UPDATE app_settings SET value = value || jsonb_build_object(
  'researchMaxSearches', 2,
  'researchThreshold', CASE WHEN value->'researchThreshold' = '7'::jsonb THEN '5'::jsonb
    ELSE value->'researchThreshold' END
), updated_at = now()
WHERE value->'researchMaxSearches' = '0'::jsonb;
