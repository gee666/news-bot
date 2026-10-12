CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE app_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type text NOT NULL CHECK (connector_type IN ('telegram', 'email', 'website', 'feed')),
  external_id text NOT NULL,
  name text NOT NULL,
  original_url text,
  access text NOT NULL DEFAULT 'unknown' CHECK (access IN ('public', 'restricted', 'unknown')),
  enabled boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}',
  collection_cursor jsonb NOT NULL DEFAULT '{}',
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_type, external_id)
);

CREATE TABLE source_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id),
  external_id text NOT NULL,
  original_url text,
  published_at timestamptz,
  collected_at timestamptz NOT NULL DEFAULT now(),
  retention_at timestamptz NOT NULL,
  current_revision_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (source_id, external_id)
);
CREATE INDEX source_items_retention ON source_items(retention_at);

-- Refetches must not extend the history window.
CREATE FUNCTION preserve_item_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.retention_at := COALESCE(NEW.published_at, NEW.collected_at);
  ELSE
    NEW.retention_at := OLD.retention_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER item_retention BEFORE INSERT OR UPDATE ON source_items
FOR EACH ROW EXECUTE FUNCTION preserve_item_retention();

CREATE TABLE item_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  content_hash text NOT NULL,
  original_text text NOT NULL,
  normalized_text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, content_hash),
  UNIQUE (item_id, revision_number),
  UNIQUE (id, item_id)
);
ALTER TABLE source_items ADD CONSTRAINT current_revision_owner
  FOREIGN KEY (current_revision_id, id) REFERENCES item_revisions(id, item_id)
  ON DELETE SET NULL (current_revision_id);

CREATE TABLE item_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES item_revisions(id) ON DELETE CASCADE,
  url text NOT NULL,
  anchor_text text,
  start_offset integer CHECK (start_offset >= 0),
  end_offset integer,
  metadata jsonb NOT NULL DEFAULT '{}',
  CHECK ((start_offset IS NULL AND end_offset IS NULL) OR
         (start_offset IS NOT NULL AND end_offset IS NOT NULL AND end_offset >= start_offset)),
  UNIQUE NULLS NOT DISTINCT (revision_id, url, start_offset, end_offset)
);

CREATE TABLE stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'failed')),
  headline text,
  summary text,
  chosen_excerpt text,
  translated_excerpt text,
  interest_score smallint CHECK (interest_score BETWEEN 1 AND 10),
  interest_stale boolean NOT NULL DEFAULT true,
  profile_version integer,
  model_version integer,
  content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
  meaningful_hash text,
  researched boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stories_digest ON stories(status, interest_stale, interest_score);

CREATE TABLE story_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES item_revisions(id) ON DELETE CASCADE,
  story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
  text text NOT NULL,
  start_offset integer CHECK (start_offset >= 0),
  end_offset integer,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((start_offset IS NULL AND end_offset IS NULL) OR
         (start_offset IS NOT NULL AND end_offset IS NOT NULL AND end_offset >= start_offset)),
  UNIQUE (revision_id, ordinal)
);
CREATE INDEX mentions_story ON story_mentions(story_id);

CREATE TABLE mention_links (
  mention_id uuid NOT NULL REFERENCES story_mentions(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES item_links(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK (classification IN ('relevant', 'irrelevant', 'uncertain')),
  reason text,
  model_version integer,
  PRIMARY KEY (mention_id, link_id)
);
CREATE FUNCTION check_mention_link_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT revision_id FROM story_mentions WHERE id = NEW.mention_id)
     IS DISTINCT FROM (SELECT revision_id FROM item_links WHERE id = NEW.link_id) THEN
    RAISE EXCEPTION 'Mention and link must belong to the same revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mention_link_revision BEFORE INSERT OR UPDATE ON mention_links
FOR EACH ROW EXECUTE FUNCTION check_mention_link_revision();

CREATE TABLE evidence_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  canonical_url text,
  content_hash text,
  title text,
  content text,
  access text NOT NULL DEFAULT 'unknown'
    CHECK (access IN ('public', 'restricted', 'unavailable', 'unknown')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX evidence_expiry ON evidence_documents(expires_at);
CREATE INDEX evidence_url ON evidence_documents(url);

CREATE TABLE story_evidence (
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('primary', 'supporting', 'candidate')),
  assessment text,
  verified_at timestamptz,
  PRIMARY KEY (story_id, evidence_id)
);

CREATE TABLE embedding_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key text NOT NULL UNIQUE,
  model text NOT NULL,
  endpoint text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 65535),
  input_version text NOT NULL,
  context_tokens integer NOT NULL CHECK (context_tokens > 0),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);
CREATE UNIQUE INDEX one_active_embedding_config ON embedding_configs(status) WHERE status = 'active';
CREATE UNIQUE INDEX one_pending_embedding_config ON embedding_configs(status) WHERE status = 'pending';

CREATE TABLE embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES embedding_configs(id) ON DELETE CASCADE,
  mention_id uuid REFERENCES story_mentions(id) ON DELETE CASCADE,
  story_id uuid REFERENCES stories(id) ON DELETE CASCADE,
  input_hash text NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(mention_id, story_id) = 1),
  UNIQUE (config_id, mention_id),
  UNIQUE (config_id, story_id)
);
CREATE FUNCTION check_embedding_dimensions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF vector_dims(NEW.embedding) IS DISTINCT FROM
     (SELECT dimensions FROM embedding_configs WHERE id = NEW.config_id) THEN
    RAISE EXCEPTION 'Embedding dimensions do not match configuration';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER embedding_dimensions BEFORE INSERT OR UPDATE ON embeddings
FOR EACH ROW EXECUTE FUNCTION check_embedding_dimensions();

CREATE TABLE model_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('judgment', 'embedding', 'generation')),
  input_hash text NOT NULL,
  model_key text NOT NULL,
  prompt_version text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (kind, input_hash, model_key, prompt_version)
);
CREATE INDEX model_cache_expiry ON model_cache(expires_at);

CREATE TABLE operational_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
