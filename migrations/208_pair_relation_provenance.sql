-- A relation needs only its pair's fingerprints, not every candidate from the
-- same model request. Repeating the catalogue per pair made reads grow quadratically.
UPDATE story_relations r
SET provenance = jsonb_set(r.provenance, '{candidates}', coalesce((
  SELECT jsonb_agg(candidate)
  FROM jsonb_array_elements(r.provenance->'candidates') AS candidate
  WHERE candidate->>'storyId' IN (r.lower_story_id::text, r.upper_story_id::text)
), '[]'::jsonb))
WHERE jsonb_typeof(r.provenance->'candidates') = 'array'
  AND jsonb_array_length(r.provenance->'candidates') > 1;
