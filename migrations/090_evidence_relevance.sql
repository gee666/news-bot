-- Authority and relevance answer different per-story questions.
ALTER TABLE story_evidence ADD COLUMN relevance text NOT NULL DEFAULT 'uncertain'
  CHECK (relevance IN ('relevant','irrelevant','uncertain'));
ALTER TABLE story_evidence ADD COLUMN assessed_at timestamptz;
ALTER TABLE story_merge_evidence ADD COLUMN relevance text NOT NULL DEFAULT 'uncertain'
  CHECK (relevance IN ('relevant','irrelevant','uncertain'));
ALTER TABLE story_merge_evidence ADD COLUMN assessed_at timestamptz;

-- Do not interpret legacy free-text reasons as relevance decisions.
UPDATE story_evidence SET relevance=CASE WHEN role IN ('primary','supporting') THEN 'relevant' ELSE 'uncertain' END,
  assessed_at=verified_at;
UPDATE story_merge_evidence SET relevance=CASE WHEN role IN ('primary','supporting') THEN 'relevant' ELSE 'uncertain' END,
  assessed_at=verified_at;
