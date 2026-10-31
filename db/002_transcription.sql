-- Short-lived processing state shares Postgres with the durable catalogue.
-- The runtime role is deliberately neither an owner nor a BYPASSRLS role.
CREATE TABLE IF NOT EXISTS grava_storage.transcription_jobs (
  owner_id text NOT NULL CHECK (owner_id ~ '^user_[A-Za-z0-9_-]+$'),
  recording_id text NOT NULL CHECK (recording_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  job jsonb,
  expires_at bigint NOT NULL,
  lock_token uuid,
  lock_until timestamptz,
  PRIMARY KEY (owner_id, recording_id),
  CHECK (job IS NULL OR (job->>'userId' = owner_id AND job->>'recordingId' = recording_id)),
  CHECK (job IS NULL OR pg_column_size(job) <= 4200000)
);
CREATE INDEX IF NOT EXISTS transcription_jobs_expiry ON grava_storage.transcription_jobs(expires_at);
ALTER TABLE grava_storage.transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE grava_storage.transcription_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transcription_owner ON grava_storage.transcription_jobs;
CREATE POLICY transcription_owner ON grava_storage.transcription_jobs TO grava_app
  USING (owner_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), ''));
DROP POLICY IF EXISTS transcription_expired_worker ON grava_storage.transcription_jobs;
CREATE POLICY transcription_expired_worker ON grava_storage.transcription_jobs FOR SELECT TO grava_storage_worker
  USING (expires_at <= (extract(epoch FROM clock_timestamp()) * 1000)::bigint);
GRANT SELECT, INSERT, UPDATE, DELETE ON grava_storage.transcription_jobs TO grava_app;
GRANT SELECT ON grava_storage.transcription_jobs TO grava_storage_worker;

CREATE TABLE IF NOT EXISTS grava_storage.rate_buckets (
  owner_id text NOT NULL CHECK (owner_id ~ '^user_[A-Za-z0-9_-]+$'),
  action text NOT NULL CHECK (action IN ('poll','submit','upload','delete')),
  count integer NOT NULL CHECK (count >= 1),
  reset_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id, action)
);
ALTER TABLE grava_storage.rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE grava_storage.rate_buckets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_bucket_owner ON grava_storage.rate_buckets;
CREATE POLICY rate_bucket_owner ON grava_storage.rate_buckets TO grava_app
  USING (owner_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON grava_storage.rate_buckets TO grava_app;

CREATE OR REPLACE FUNCTION grava_storage.due_transcriptions(p_now_ms bigint, p_limit integer)
RETURNS TABLE(owner_id text, recording_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, grava_storage
AS $$
  SELECT j.owner_id, j.recording_id FROM grava_storage.transcription_jobs j
  WHERE j.expires_at <= least(p_now_ms, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    AND (j.lock_until IS NULL OR j.lock_until <= clock_timestamp())
  ORDER BY j.expires_at LIMIT greatest(0, least(p_limit, 50));
$$;
GRANT CREATE ON SCHEMA grava_storage TO grava_storage_worker;
ALTER FUNCTION grava_storage.due_transcriptions(bigint, integer) OWNER TO grava_storage_worker;
REVOKE CREATE ON SCHEMA grava_storage FROM grava_storage_worker;
REVOKE ALL ON FUNCTION grava_storage.due_transcriptions(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION grava_storage.due_transcriptions(bigint, integer) TO grava_maintenance;
