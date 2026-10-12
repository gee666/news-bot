-- Fence publisher checkpoints taken before a subscription configuration edit.
ALTER TABLE sources ADD COLUMN collection_config_version integer NOT NULL DEFAULT 1
  CHECK (collection_config_version >= 1);
