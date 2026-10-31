-- Administrative migration only. Application and cron credentials must be separate.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grava_app') THEN CREATE ROLE grava_app LOGIN NOINHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grava_storage_worker') THEN CREATE ROLE grava_storage_worker NOLOGIN NOINHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grava_maintenance') THEN CREATE ROLE grava_maintenance LOGIN NOINHERIT NOBYPASSRLS; END IF;
END $$;
ALTER ROLE grava_app NOINHERIT NOBYPASSRLS;
ALTER ROLE grava_storage_worker NOLOGIN NOINHERIT NOBYPASSRLS;
ALTER ROLE grava_maintenance NOINHERIT NOBYPASSRLS;
CREATE SCHEMA IF NOT EXISTS grava_storage;
REVOKE ALL ON SCHEMA grava_storage FROM PUBLIC;
GRANT USAGE ON SCHEMA grava_storage TO grava_app, grava_storage_worker, grava_maintenance;

CREATE TABLE IF NOT EXISTS grava_storage.recordings (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL CHECK (owner_id ~ '^user_[A-Za-z0-9_-]{1,200}$'),
  local_id text NOT NULL CHECK (length(local_id) BETWEEN 1 AND 128),
  metadata jsonb NOT NULL CHECK (octet_length(metadata::text) <= 100000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleting')),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0 AND reserved_bytes <= 1073741824),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  transcript jsonb CHECK (transcript IS NULL OR octet_length(transcript::text) <= 3800000),
  transcript_version integer NOT NULL DEFAULT 0 CHECK (transcript_version >= 0),
  UNIQUE (id, owner_id),
  UNIQUE (owner_id, local_id)
);
CREATE TABLE IF NOT EXISTS grava_storage.assets (
  recording_id uuid NOT NULL,
  owner_id text NOT NULL,
  orientation text NOT NULL CHECK (orientation IN ('landscape','portrait')),
  pathname text NOT NULL UNIQUE CHECK (pathname ~ '^recordings/user_[A-Za-z0-9_-]+/[a-f0-9-]{36}/(landscape|portrait)\.(mp4|webm)$'),
  expected_bytes bigint NOT NULL CHECK (expected_bytes > 0 AND expected_bytes <= 536870912),
  content_type text NOT NULL CHECK (content_type IN ('video/mp4','video/webm')),
  CHECK (pathname = 'recordings/' || owner_id || '/' || recording_id::text || '/' || orientation || CASE WHEN content_type = 'video/mp4' THEN '.mp4' ELSE '.webm' END),
  PRIMARY KEY (recording_id, orientation),
  FOREIGN KEY (recording_id, owner_id) REFERENCES grava_storage.recordings(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS recordings_owner_created ON grava_storage.recordings(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recordings_cleanup ON grava_storage.recordings(status, expires_at);
ALTER TABLE grava_storage.recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE grava_storage.recordings FORCE ROW LEVEL SECURITY;
ALTER TABLE grava_storage.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE grava_storage.assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recordings_owner ON grava_storage.recordings;
CREATE POLICY recordings_owner ON grava_storage.recordings TO grava_app
  USING (owner_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), ''));
DROP POLICY IF EXISTS assets_owner ON grava_storage.assets;
CREATE POLICY assets_owner ON grava_storage.assets TO grava_app
  USING (owner_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON grava_storage.recordings, grava_storage.assets TO grava_app;
REVOKE ALL ON grava_storage.recordings, grava_storage.assets FROM PUBLIC;

-- This non-login role can only see rows eligible for removal. Cron's login role
-- receives EXECUTE on the two bounded functions, with no direct table access.
DROP POLICY IF EXISTS recordings_cleanup_worker ON grava_storage.recordings;
CREATE POLICY recordings_cleanup_worker ON grava_storage.recordings TO grava_storage_worker
  USING ((status = 'deleting' AND expires_at <= now()) OR (status = 'pending' AND expires_at + interval '20 minutes' <= now()));
DROP POLICY IF EXISTS assets_cleanup_worker ON grava_storage.assets;
CREATE POLICY assets_cleanup_worker ON grava_storage.assets TO grava_storage_worker
  USING (EXISTS (SELECT 1 FROM grava_storage.recordings r WHERE r.id = recording_id AND r.owner_id = assets.owner_id));
GRANT SELECT, DELETE ON grava_storage.recordings, grava_storage.assets TO grava_storage_worker;
-- A managed Postgres administrator may have CREATEROLE without superuser.
-- It must be able to SET ROLE to the new function owner for ownership transfer.
-- The migration runner removes this temporary membership when it added it.
DO $$ BEGIN EXECUTE format('GRANT grava_storage_worker TO %I', current_user); END $$;
-- Function ownership needs CREATE on its schema during the owner transfer.
GRANT CREATE ON SCHEMA grava_storage TO grava_storage_worker;
CREATE OR REPLACE FUNCTION grava_storage.recording_cleanup_candidates(batch_limit integer DEFAULT 25)
RETURNS TABLE (recording_id uuid, pathnames text[])
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, grava_storage AS $$
  SELECT r.id, ARRAY(SELECT a.pathname FROM grava_storage.assets a WHERE a.recording_id = r.id AND a.owner_id = r.owner_id)
  FROM grava_storage.recordings r
  WHERE (r.status = 'deleting' AND r.expires_at <= now()) OR (r.status = 'pending' AND r.expires_at + interval '20 minutes' <= now())
  ORDER BY r.updated_at ASC LIMIT greatest(1, least(batch_limit, 50))
$$;
ALTER FUNCTION grava_storage.recording_cleanup_candidates(integer) OWNER TO grava_storage_worker;
CREATE OR REPLACE FUNCTION grava_storage.finish_recording_cleanup(recording_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, grava_storage AS $$
  DELETE FROM grava_storage.recordings r WHERE r.id = recording_id
    AND ((r.status = 'deleting' AND r.expires_at <= now()) OR (r.status = 'pending' AND r.expires_at + interval '20 minutes' <= now()))
$$;
ALTER FUNCTION grava_storage.finish_recording_cleanup(uuid) OWNER TO grava_storage_worker;
REVOKE CREATE ON SCHEMA grava_storage FROM grava_storage_worker;
REVOKE ALL ON FUNCTION grava_storage.recording_cleanup_candidates(integer), grava_storage.finish_recording_cleanup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION grava_storage.recording_cleanup_candidates(integer), grava_storage.finish_recording_cleanup(uuid) TO grava_maintenance;
