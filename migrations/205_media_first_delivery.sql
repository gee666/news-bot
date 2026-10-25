-- Existing kinds and frozen plans are not rewritten. Only stamped, unattempted
-- snapshots opt into media-first delivery in the planner.
ALTER TABLE publications DROP CONSTRAINT publications_delivery_kind_check;
ALTER TABLE publications ADD CONSTRAINT publications_delivery_kind_check
  CHECK (delivery_kind IN ('text','album','media_first'));

-- A reservation survives crashes, rejected requests and ambiguous outcomes.
-- Release requires the canonical text receipt and every text continuation.
CREATE TABLE publication_destination_reservations (
  destination_id text PRIMARY KEY,
  publication_id uuid NOT NULL UNIQUE REFERENCES publications(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
