CREATE TABLE model_usage_accounting (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO model_usage_accounting DEFAULT VALUES;

-- Independent of content retention. No historical backfill can recover unrecorded usage.
CREATE TABLE model_usage_calls (
  id uuid PRIMARY KEY,
  timestamp timestamptz NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  operation_id text,
  stage text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'failed')),
  usage_known boolean NOT NULL,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cache_read_tokens bigint CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0),
  estimated_cost jsonb,
  actual_billed_cost numeric CHECK (actual_billed_cost >= 0),
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  CHECK ((usage_known AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
    AND cache_read_tokens IS NOT NULL AND cache_write_tokens IS NOT NULL AND total_tokens IS NOT NULL)
    OR (NOT usage_known AND input_tokens IS NULL AND output_tokens IS NULL
    AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND total_tokens IS NULL))
);
CREATE INDEX model_usage_calls_time ON model_usage_calls (timestamp DESC, id DESC);
CREATE INDEX model_usage_calls_model_time ON model_usage_calls (model, timestamp);
CREATE INDEX model_usage_calls_provider_time ON model_usage_calls (provider, timestamp);
CREATE INDEX model_usage_calls_stage_time ON model_usage_calls (stage, timestamp);
