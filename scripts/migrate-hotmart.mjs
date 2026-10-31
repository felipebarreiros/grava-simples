import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const HOTMART_MIGRATION_NAME = '004_hotmart.sql';

/** Applies only this feature's explicit migration; unrelated agents' SQL is never globbed. */
export async function applyHotmartMigration(client, log = () => {}) {
  const sql = await readFile(new URL('../db/' + HOTMART_MIGRATION_NAME, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('grava-hotmart-migrations',0))");
    const baseline = await client.query("SELECT to_regnamespace('grava_storage') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='grava_app') AS ready");
    if (baseline.rows[0]?.ready !== true) throw new Error('Apply the recording-storage migrations before the Hotmart migration.');
    await client.query('CREATE TABLE IF NOT EXISTS grava_storage.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const prior = await client.query('SELECT checksum FROM grava_storage.schema_migrations WHERE name=$1', [HOTMART_MIGRATION_NAME]);
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum) throw new Error('Migration checksum mismatch: ' + HOTMART_MIGRATION_NAME);
      await client.query('COMMIT');
      return { applied: false, name: HOTMART_MIGRATION_NAME };
    }
    await client.query(sql);
    await client.query('INSERT INTO grava_storage.schema_migrations(name,checksum) VALUES($1,$2)', [HOTMART_MIGRATION_NAME, checksum]);
    await client.query('COMMIT');
    log('Applied ' + HOTMART_MIGRATION_NAME);
    return { applied: true, name: HOTMART_MIGRATION_NAME };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  let client;
  try {
    if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required.');
    client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL, connectionTimeoutMillis: 15_000, statement_timeout: 30_000, application_name: 'grava-hotmart-migration' });
    await client.connect();
    await applyHotmartMigration(client, console.log);
  } catch (error) {
    // Never print a database URL, password, parameters, or the provider's error detail.
    console.error('Hotmart migration failed:', typeof error?.code === 'string' ? error.code : 'configuration or migration error');
    process.exitCode = 1;
  } finally { await client?.end().catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
