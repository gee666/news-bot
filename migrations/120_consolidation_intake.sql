-- Existing collected revisions are context, not permission for a corpus consolidation replay.
CREATE TABLE consolidation_intake (
  revision_id uuid PRIMARY KEY,
  item_id uuid NOT NULL,
  text_fingerprint text NOT NULL CHECK (text_fingerprint ~ '^[a-f0-9]{64}$'),
  urls text[] NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id,item_id) REFERENCES item_revisions(id,item_id) ON DELETE CASCADE
);
CREATE INDEX consolidation_intake_item ON consolidation_intake(item_id);

INSERT INTO consolidation_intake(revision_id,item_id,text_fingerprint,urls)
SELECT r.id,r.item_id,encode(sha256(convert_to(r.original_text,'UTF8')),'hex'),
  ARRAY(SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=r.id AND l.url ~ '^https?://' ORDER BY l.url)
FROM item_revisions r;
