-- Existing publications retain their text/reply attachment lifecycle.
ALTER TABLE publications ADD COLUMN delivery_kind text NOT NULL DEFAULT 'text'
  CHECK (delivery_kind IN ('text','album'));
