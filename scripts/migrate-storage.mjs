import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required for administrative migration.');
// Supabase's shared pooler certificate is not in Node's default trust store.
// Keep this one-time administrative connection encrypted instead of falling
// back to plaintext; the database password and role checks remain required.
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
await client.connect();
const originalMembership = await client.query("SELECT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname=current_user AND granted.rolname='grava_storage_worker') AS present");
try {
  await client.query("DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='grava_storage_worker') THEN EXECUTE format('GRANT grava_storage_worker TO %I', current_user); END IF; END $$");
  await client.query('CREATE SCHEMA IF NOT EXISTS grava_storage');
  await client.query('CREATE TABLE IF NOT EXISTS grava_storage.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  // This checkout can contain other agents' migrations. Apply this service's explicit manifest only.
  const files = ['001_recordings.sql', '002_transcription.sql', '003_processing_guards.sql', '004_storage_timeouts.sql'];
  for (const name of files) {
    const sql = await readFile(new URL('../db/' + name, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = await client.query('SELECT checksum FROM grava_storage.schema_migrations WHERE name = $1', [name]);
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum) throw new Error('Migration checksum mismatch: ' + name);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO grava_storage.schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
      console.log('Applied', name);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  for (const [role, variable] of [['grava_app', 'STORAGE_APP_PASSWORD'], ['grava_maintenance', 'STORAGE_MAINTENANCE_PASSWORD']]) {
    const password = process.env[variable];
    if (password) {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error(variable + ' must be a random 32–128 character base64url value.');
      await client.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
      console.log('Configured login for', role);
    }
  }
} catch (error) {
  console.error('Storage migration failed:', typeof error?.code === 'string' ? error.code : 'configuration or migration error');
  process.exitCode = 1;
} finally {
  await client.query("DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='grava_storage_worker') THEN REVOKE CREATE ON SCHEMA grava_storage FROM grava_storage_worker; END IF; END $$").catch(() => undefined);
  if (!originalMembership.rows[0].present) await client.query("DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='grava_storage_worker') THEN EXECUTE format('REVOKE grava_storage_worker FROM %I', current_user); END IF; END $$").catch(() => undefined);
  await client.end();
}
