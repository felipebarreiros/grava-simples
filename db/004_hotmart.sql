-- External mutations require durable receipts across serverless instances.
-- No Hotmart login tokens are stored in this table.
CREATE TABLE IF NOT EXISTS grava_storage.hotmart_operations (
  owner_id text NOT NULL CHECK (owner_id ~ '^user_[A-Za-z0-9_-]{1,200}$'),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  status text NOT NULL CHECK (status IN ('pending', 'done', 'uncertain')),
  result jsonb CHECK (result IS NULL OR pg_column_size(result) <= 262144),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, operation_key)
);
CREATE INDEX IF NOT EXISTS hotmart_operations_expiry ON grava_storage.hotmart_operations(expires_at);
ALTER TABLE grava_storage.hotmart_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE grava_storage.hotmart_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY hotmart_operation_owner ON grava_storage.hotmart_operations TO grava_app
  USING (owner_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('app.user_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON grava_storage.hotmart_operations TO grava_app;
REVOKE ALL ON grava_storage.hotmart_operations FROM PUBLIC;
