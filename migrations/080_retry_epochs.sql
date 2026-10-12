ALTER TABLE stage_state
  ADD COLUMN retry_epoch integer NOT NULL DEFAULT 0 CHECK (retry_epoch >= 0),
  ADD COLUMN retry_epoch_start integer NOT NULL DEFAULT 0 CHECK (retry_epoch_start >= 0 AND retry_epoch_start <= attempts);
ALTER TABLE request_attempts ADD COLUMN retry_epoch integer NOT NULL DEFAULT 0 CHECK (retry_epoch >= 0);

-- Keep stage attempt numbers cumulative while inference gets a fresh, bounded burst budget.
CREATE FUNCTION capture_stage_retry_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lifetime_attempt integer;
  epoch integer;
BEGIN
  IF NEW.stage_id IS NOT NULL THEN
    SELECT attempts,retry_epoch INTO lifetime_attempt,epoch FROM stage_state WHERE id=NEW.stage_id;
    IF FOUND THEN
      NEW.retry_epoch := epoch;
      NEW.response_metadata := NEW.response_metadata || jsonb_build_object('burstAttempt',NEW.attempt_number);
      NEW.attempt_number := greatest(NEW.attempt_number,lifetime_attempt);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_attempt_retry_epoch BEFORE INSERT ON request_attempts
  FOR EACH ROW EXECUTE FUNCTION capture_stage_retry_epoch();
