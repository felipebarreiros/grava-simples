import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postgresHotmartOperations } from '../server/hotmart/repository.ts';
import { storagePool, withUser } from '../server/storage/database.ts';
import { applyHotmartMigration, HOTMART_MIGRATION_NAME } from '../scripts/migrate-hotmart.mjs';

const sql = await readFile(new URL('../db/004_hotmart.sql', import.meta.url), 'utf8');
const checksum = createHash('sha256').update(sql).digest('hex');
function migrationFixture({ ready = true, prior, failure = false } = {}) {
  const queries = [];
  return { queries, client: { async query(statement, parameters) {
    queries.push({ statement, parameters });
    if (statement.includes(' AS ready')) return { rows: [{ ready }], rowCount: 1 };
    if (statement.startsWith('SELECT checksum')) return { rows: prior ? [{ checksum: prior }] : [], rowCount: prior ? 1 : 0 };
    if (statement === sql && failure) throw Object.assign(new Error('Fixture SQL failure'), { code: '42501' });
    return { rows: [], rowCount: 0 };
  } } };
}

test('Hotmart migration applies only its explicit file inside a locked checksum-tracked transaction', async () => {
  const fixture = migrationFixture();
  const result = await applyHotmartMigration(fixture.client);
  assert.deepEqual(result, { applied: true, name: '004_hotmart.sql' });
  assert.equal(HOTMART_MIGRATION_NAME, '004_hotmart.sql');
  assert.equal(fixture.queries[0].statement, 'BEGIN');
  assert.match(fixture.queries[1].statement, /pg_advisory_xact_lock/);
  assert.equal(fixture.queries.filter(item => item.statement === sql).length, 1);
  const receipt = fixture.queries.find(item => item.statement.startsWith('INSERT INTO grava_storage.schema_migrations'));
  assert.deepEqual(receipt.parameters, ['004_hotmart.sql', checksum]);
  assert.equal(fixture.queries.at(-1).statement, 'COMMIT');
  assert.equal(fixture.queries.some(item => /ALTER ROLE|GRANT grava_storage_worker/.test(item.statement)), false);
});

test('Hotmart migration skips unchanged SQL and rolls back changed, missing-baseline or failed migrations', async () => {
  const existing = migrationFixture({ prior: checksum });
  assert.equal((await applyHotmartMigration(existing.client)).applied, false);
  assert.equal(existing.queries.some(item => item.statement === sql), false);
  for (const options of [{ prior: 'changed-checksum' }, { ready: false }, { failure: true }]) {
    const fixture = migrationFixture(options);
    await assert.rejects(applyHotmartMigration(fixture.client));
    assert.equal(fixture.queries.at(-1).statement, 'ROLLBACK');
    assert.equal(fixture.queries.some(item => item.statement.startsWith('INSERT INTO grava_storage.schema_migrations')), false);
  }
});

test('missing durable storage or an invalid owner fails before invoking an external write', async () => {
  let calls = 0;
  const repository = postgresHotmartOperations({});
  await assert.rejects(repository.once('user_alice', 'key', 'lesson', {}, async () => { calls++; }), error => error.status === 503);
  await assert.rejects(repository.once('unverified-owner', 'key', 'lesson', {}, async () => { calls++; }), error => error.status === 401);
  assert.equal(calls, 0);
});

// Opt in only against an ephemeral local Postgres; never borrow DATABASE_URL.
test('native PostgreSQL enforces owner isolation and durable at-most-once Hotmart writes', { skip: !process.env.HOTMART_TEST_DATABASE_URL }, async t => {
  const adminUrl = new URL(process.env.HOTMART_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname), 'test database must be local and ephemeral');
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.username = 'grava_app'; runtimeUrl.password = '';
  const env = { DATABASE_URL: runtimeUrl.toString() };
  const ownerA = `user_a_${randomUUID().replaceAll('-', '')}`, ownerB = `user_b_${randomUUID().replaceAll('-', '')}`;
  const repository = postgresHotmartOperations(env);
  try {
    await t.test('duplicate completed requests return the original result and never repeat provider work', async () => {
      let calls = 0;
      const work = async () => ({ pageId: `page-${++calls}` });
      assert.deepEqual(await repository.once(ownerA, 'create-lesson', 'lesson', { title: 'Lesson' }, work), { pageId: 'page-1' });
      assert.deepEqual(await repository.once(ownerA, 'create-lesson', 'lesson', { title: 'Lesson' }, work), { pageId: 'page-1' });
      assert.equal(calls, 1);
      assert.deepEqual(await repository.get(ownerA, 'create-lesson'), { pageId: 'page-1' });
      await assert.rejects(repository.once(ownerA, 'create-lesson', 'lesson', { title: 'Changed' }, work), error => error.status === 409);
      await assert.rejects(repository.once(ownerA, 'create-lesson', 'different-action', { title: 'Lesson' }, work), error => error.status === 409);
      assert.equal(calls, 1);
    });
    await t.test('the same operation key belongs to independent owners and RLS denies cross-owner read/update/delete', async () => {
      assert.equal(await repository.get(ownerB, 'create-lesson'), null);
      await assert.rejects(repository.update(ownerB, 'create-lesson', { pageId: 'stolen' }), error => error.status === 404);
      assert.deepEqual(await repository.once(ownerB, 'create-lesson', 'lesson', { title: 'Lesson' }, async () => ({ pageId: 'bob-page' })), { pageId: 'bob-page' });
      assert.deepEqual(await repository.get(ownerA, 'create-lesson'), { pageId: 'page-1' });
      await withUser(ownerB, async client => {
        assert.equal((await client.query('SELECT * FROM grava_storage.hotmart_operations WHERE owner_id=$1', [ownerA])).rowCount, 0);
        assert.equal((await client.query("UPDATE grava_storage.hotmart_operations SET status='uncertain' WHERE owner_id=$1", [ownerA])).rowCount, 0);
        assert.equal((await client.query('DELETE FROM grava_storage.hotmart_operations WHERE owner_id=$1', [ownerA])).rowCount, 0);
        await assert.rejects(client.query("INSERT INTO grava_storage.hotmart_operations(owner_id,operation_key,action,fingerprint,status) VALUES($1,'forged','lesson',$2,'pending')", [ownerA, 'a'.repeat(64)]), error => error.code === '42501');
      }, env).catch(error => { if (error.code !== '25P02') throw error; });
    });
    await t.test('simultaneous duplicate invocation observes the committed pending receipt without a second provider call', async () => {
      let began, release;
      const started = new Promise(resolve => { began = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let calls = 0;
      const first = repository.once(ownerA, 'concurrent', 'upload', { file: 'same' }, async () => { calls++; began(); await gate; return { fileId: 'one' }; });
      await started;
      try {
        await assert.rejects(repository.once(ownerA, 'concurrent', 'upload', { file: 'same' }, async () => { calls++; return { fileId: 'two' }; }), error => error.status === 409);
        assert.equal(calls, 1);
      } finally { release(); }
      assert.deepEqual(await first, { fileId: 'one' });
      assert.deepEqual(await repository.once(ownerA, 'concurrent', 'upload', { file: 'same' }, async () => assert.fail('must return cached receipt')), { fileId: 'one' });
    });
    await t.test('ambiguous failures persist uncertainty and cannot automatically repeat an external mutation', async () => {
      let calls = 0;
      const failure = new Error('Provider timed out after accepting a write');
      await assert.rejects(repository.once(ownerA, 'uncertain', 'module', { name: 'Module' }, async () => { calls++; throw failure; }), error => error === failure);
      assert.equal((await admin.query('SELECT status FROM grava_storage.hotmart_operations WHERE owner_id=$1 AND operation_key=$2', [ownerA, 'uncertain'])).rows[0].status, 'uncertain');
      await assert.rejects(repository.once(ownerA, 'uncertain', 'module', { name: 'Module' }, async () => { calls++; return {}; }), error => error.status === 409);
      assert.equal(calls, 1);
    });
    await t.test('an accepted provider write with a failed receipt save becomes uncertain and cannot be repeated', async () => {
      let calls = 0;
      await assert.rejects(repository.once(ownerA, 'save-failure', 'lesson', { name: 'Large response' }, async () => {
        calls++;
        return { providerAccepted: true, data: randomBytes(270_000).toString('hex') };
      }), error => error.code === '23514');
      assert.equal((await admin.query('SELECT status FROM grava_storage.hotmart_operations WHERE owner_id=$1 AND operation_key=$2', [ownerA, 'save-failure'])).rows[0].status, 'uncertain');
      await assert.rejects(repository.once(ownerA, 'save-failure', 'lesson', { name: 'Large response' }, async () => { calls++; return {}; }), error => error.status === 409);
      assert.equal(calls, 1);
    });
    await t.test('a stale processing poll cannot downgrade a completed upload or remove its lesson result', async () => {
      const key = 'conditional-status';
      await repository.once(ownerA, key, 'upload', { file: 'video' }, async () => ({ status: 'processing', fileId: 'file-1' }));
      const stalePoll = await repository.get(ownerA, key);
      await repository.update(ownerA, key, { ...stalePoll, status: 'ready' }, 'processing');
      assert.equal((await repository.get(ownerA, key)).status, 'ready', 'the expected transition is allowed');
      const completed = { status: 'completed', fileId: 'file-1', result: { lessonId: 'lesson-final', published: false } };
      await repository.update(ownerA, key, completed, 'ready');
      await repository.update(ownerA, key, { ...stalePoll, status: 'ready' }, 'processing');
      assert.deepEqual(await repository.get(ownerA, key), completed, 'late processing->ready update preserves completion and its result');
      await repository.update(ownerB, key, { status: 'ready' }, 'processing');
      assert.equal(await repository.get(ownerB, key), null, 'a conditional update cannot create or access another owner receipt');
      assert.deepEqual(await repository.get(ownerA, key), completed);
    });
    await t.test('expired receipts cannot be replayed, read, or updated, and no tenant survives pooled transactions', async () => {
      await repository.once(ownerA, 'expired', 'lesson', { name: 'Lesson' }, async () => ({ pageId: 'expired-page' }));
      await admin.query("UPDATE grava_storage.hotmart_operations SET expires_at=now()-interval '1 second' WHERE owner_id=$1 AND operation_key='expired'", [ownerA]);
      await assert.rejects(repository.once(ownerA, 'expired', 'lesson', { name: 'Lesson' }, async () => assert.fail('expired receipts never repeat writes')), error => error.status === 410);
      assert.equal(await repository.get(ownerA, 'expired'), null);
      await assert.rejects(repository.update(ownerA, 'expired', { pageId: 'edited' }), error => error.status === 404);
      await repository.update(ownerA, 'create-lesson', { pageId: 'updated-own-page' });
      assert.deepEqual(await repository.get(ownerA, 'create-lesson'), { pageId: 'updated-own-page' });
      assert.deepEqual(await repository.get(ownerB, 'create-lesson'), { pageId: 'bob-page' });
      const connection = await storagePool(runtimeUrl.toString()).connect();
      try { assert.equal((await connection.query('SELECT * FROM grava_storage.hotmart_operations')).rowCount, 0); }
      finally { connection.release(); }
    });
  } finally {
    await admin.query('DELETE FROM grava_storage.hotmart_operations WHERE owner_id=ANY($1::text[])', [[ownerA, ownerB]]);
    await admin.end();
    await storagePool(runtimeUrl.toString()).end();
  }
});
