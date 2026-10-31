import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { storagePool, withUser, withMaintenance } from '../server/storage/database.ts';
import { postgresRecordings } from '../server/storage/repository.ts';
import { postgresQuota, postgresRepository } from '../server/transcription/postgres.ts';
import { setLocalAccount, scopedLocalKey } from '../src/projects/keys.ts';
import { loadTranscript, saveTranscript, deleteTranscript } from '../src/recordings/transcript.ts';
import { loadReview, saveReview, deleteReview } from '../src/recordings/review.ts';

function fakeConnection({ safe = true, rollbackFails = false } = {}) {
  const queries = [], releases = [];
  const connection = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (/FROM pg_roles/.test(sql)) return { rows: [{ safe }] };
      if (sql === 'ROLLBACK' && rollbackFails) throw Error('Connection lost');
      return { rows: [], rowCount: 0 };
    },
    release(destroy) { releases.push(destroy); },
  };
  const url = `postgresql://grava_app@localhost:1/security_${randomUUID()}`;
  const pool = storagePool(url);
  pool.connect = async () => connection;
  return { connection, queries, releases, url, close: () => pool.end() };
}

test('database requests verify the restricted role and bind identity only inside the transaction', async () => {
  const fake = fakeConnection();
  try {
    const value = await withUser('user_alice', async client => {
      assert.equal(client, fake.connection);
      assert.deepEqual(fake.queries.at(-1).parameters, ['user_alice']);
      await client.query('SELECT $1::text', ['private user content']);
      return 'saved';
    }, { DATABASE_URL: fake.url });
    assert.equal(value, 'saved');
    assert.equal(fake.queries[0].sql, 'BEGIN');
    assert.match(fake.queries[1].sql, /NOT rolbypassrls/);
    assert.ok(fake.queries.some(({ sql }) => sql === 'SET LOCAL row_security = on'));
    assert.ok(fake.queries.some(({ sql, parameters }) => sql === "SELECT set_config('app.user_id', $1, true)" && parameters[0] === 'user_alice'));
    assert.equal(fake.queries.at(-1).sql, 'COMMIT');
    assert.equal(fake.releases.length, 1);
  } finally { await fake.close(); }
});

test('an administrator connection cannot execute application or maintenance callbacks', async () => {
  for (const kind of ['application', 'maintenance']) {
    const fake = fakeConnection({ safe: false });
    let invoked = false;
    try {
      const fn = async () => { invoked = true; };
      await assert.rejects(kind === 'application'
        ? withUser('user_alice', fn, { DATABASE_URL: fake.url })
        : withMaintenance(fn, { GRAVA_MAINTENANCE_URL: fake.url }), error => error.status === 503);
      assert.equal(invoked, false);
      assert.equal(fake.releases.length, 1);
      if (kind === 'application') {
        assert.equal(fake.queries.at(-1).sql, 'ROLLBACK');
        assert.ok(!fake.queries.some(({ sql }) => sql.includes('set_config')));
      }
    } finally { await fake.close(); }
  }
});

test('failed transactions roll back and a failed rollback destroys the pooled connection', async () => {
  for (const rollbackFails of [false, true]) {
    const fake = fakeConnection({ rollbackFails });
    const expected = Error('Recording write failed');
    try {
      await assert.rejects(withUser('user_alice', async () => { throw expected; }, { DATABASE_URL: fake.url }), error => error === expected);
      assert.equal(fake.queries.at(-1).sql, 'ROLLBACK');
      assert.equal(fake.releases.length, 1);
      if (rollbackFails) assert.equal(fake.releases[0], true);
      else assert.notEqual(fake.releases[0], true);
    } finally { await fake.close(); }
  }
});

test('local transcripts and markers stay separate across account switches and legacy data remains unclaimed', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  } });
  const transcript = text => ({ version: 1, sourceName: 'fixture.vtt', importedAt: 1, updatedAt: 1, cues: [{ id: 'cue', start: 0, end: 1, text }] });
  const review = text => ({ version: 1, markers: [{ id: 'marker', time: 0.5, text }] });
  try {
    setLocalAccount(null);
    saveTranscript('same-local-id', transcript('Unclaimed legacy'));
    saveReview('same-local-id', review('Unclaimed marker'));
    setLocalAccount('user_alice');
    assert.equal(loadTranscript('same-local-id'), null);
    assert.deepEqual(loadReview('same-local-id').markers, []);
    saveTranscript('same-local-id', transcript('Alice private words'));
    saveReview('same-local-id', review('Alice private marker'));
    setLocalAccount('user_bob');
    assert.equal(loadTranscript('same-local-id'), null);
    assert.deepEqual(loadReview('same-local-id').markers, []);
    saveTranscript('same-local-id', transcript('Bob private words'));
    saveReview('same-local-id', review('Bob private marker'));
    deleteTranscript('same-local-id');
    deleteReview('same-local-id');
    setLocalAccount('user_alice');
    assert.equal(loadTranscript('same-local-id').cues[0].text, 'Alice private words');
    assert.equal(loadReview('same-local-id').markers[0].text, 'Alice private marker');
    assert.ok(values.has(scopedLocalKey('grava-simples-transcript-v1:same-local-id')));
    setLocalAccount(null);
    assert.equal(loadTranscript('same-local-id').cues[0].text, 'Unclaimed legacy');
    assert.equal(loadReview('same-local-id').markers[0].text, 'Unclaimed marker');
  } finally {
    setLocalAccount(null);
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

// Explicitly opt in against an ephemeral local database with migrations applied.
// This never uses the application's production DATABASE_URL or administrative key.
test('native Postgres RLS prevents two users reading, changing, deleting, or attaching each other\'s assets', { skip: !process.env.STORAGE_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.STORAGE_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'RLS test requires an ephemeral local database');
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const runtime = new URL(url);
  runtime.username = 'grava_app';
  runtime.password = '';
  const env = { DATABASE_URL: runtime.toString() };
  const maintenance = new URL(url);
  maintenance.username = 'grava_maintenance';
  maintenance.password = '';
  const alice = `user_alice_${randomUUID().replaceAll('-', '')}`, bob = `user_bob_${randomUUID().replaceAll('-', '')}`;
  const quotaOwner = `user_quota_${randomUUID().replaceAll('-', '')}`;
  const paginationOwner = `user_pages_${randomUUID().replaceAll('-', '')}`;
  const aliceId = randomUUID(), bobId = randomUUID();
  const insert = (client, id, owner) => client.query("INSERT INTO grava_storage.recordings(id,owner_id,local_id,metadata,reserved_bytes) VALUES($1,$2,'shared-local-id','{}',100)", [id, owner]);
  try {
    await withUser(alice, client => insert(client, aliceId, alice), env);
    await withUser(bob, client => insert(client, bobId, bob), env);
    for (const [owner, ownId, otherId] of [[alice, aliceId, bobId], [bob, bobId, aliceId]]) {
      await withUser(owner, async client => {
        const visible = await client.query('SELECT id FROM grava_storage.recordings WHERE id = ANY($1::uuid[])', [[aliceId, bobId]]);
        assert.deepEqual(visible.rows.map(row => row.id), [ownId]);
        assert.equal((await client.query("UPDATE grava_storage.recordings SET status='deleting' WHERE id=$1", [otherId])).rowCount, 0);
        assert.equal((await client.query('DELETE FROM grava_storage.recordings WHERE id=$1', [otherId])).rowCount, 0);
        assert.equal((await client.query('SELECT * FROM grava_storage.assets WHERE recording_id=$1', [otherId])).rowCount, 0);
      }, env);
    }
    await assert.rejects(withUser(alice, client => insert(client, randomUUID(), bob), env), error => error.code === '42501');
    await assert.rejects(withUser(alice, client => client.query('UPDATE grava_storage.recordings SET owner_id=$1 WHERE id=$2', [bob, aliceId]), env), error => error.code === '42501');
    await assert.rejects(withUser(bob, client => client.query("INSERT INTO grava_storage.assets(recording_id,owner_id,orientation,pathname,expected_bytes,content_type) VALUES($1,$2,'landscape',$3,100,'video/mp4')", [aliceId, bob, `recordings/${bob}/${aliceId}/landscape.mp4`]), env), error => error.code === '23503');
    await assert.rejects(withUser(alice, client => client.query('ALTER TABLE grava_storage.recordings DISABLE ROW LEVEL SECURITY'), env), error => error.code === '42501');
    await assert.rejects(withUser(alice, async client => {
      await client.query('SET LOCAL row_security = off');
      await client.query('SELECT * FROM grava_storage.recordings');
    }, env), error => error.code === '42501');
    // Simultaneous reservations cannot each observe the same spare capacity.
    const repository = postgresRecordings(env);
    const makeTake = index => ({
      id: `quota-${index}`, projectId: 'quota-project', projectName: 'Quota fixture', name: 'Quota fixture',
      createdAt: 1, startedAt: 1, stoppedAt: 2, durationMs: 1, warnings: [],
      landscape: { fileName: 'landscape.mp4', size: 512 * 1024 * 1024, mimeType: 'video/mp4' },
      portrait: { fileName: 'portrait.mp4', size: 512 * 1024 * 1024, mimeType: 'video/mp4' },
    });
    const reserved = await Promise.allSettled(Array.from({ length: 11 }, (_, index) => repository.reserve(quotaOwner, makeTake(index))));
    assert.equal(reserved.filter(value => value.status === 'fulfilled').length, 10);
    assert.equal(reserved.filter(value => value.status === 'rejected' && value.reason.status === 413).length, 1);
    await withUser(paginationOwner, client => client.query("INSERT INTO grava_storage.recordings(id,owner_id,local_id,metadata,reserved_bytes,created_at) SELECT gen_random_uuid(),$1,'page-'||index,'{}',100,'2026-01-01T00:00:00.123456Z' FROM generate_series(1,26) AS index", [paginationOwner]), env);
    const firstPage = await repository.list(paginationOwner);
    assert.equal(firstPage.recordings.length, 25);
    assert.ok(firstPage.nextCursor);
    const secondPage = await repository.list(paginationOwner, firstPage.nextCursor);
    assert.equal(secondPage.recordings.length, 1);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(new Set([...firstPage.recordings, ...secondPage.recordings].map(row => row.id)).size, 26, 'pagination retains timestamp microseconds with neither missing nor repeated recordings');
    // Quotas are atomic and independent for different authenticated accounts.
    const submissions = await Promise.allSettled(Array.from({ length: 7 }, () => postgresQuota(alice, 'submit', env)));
    assert.equal(submissions.filter(value => value.status === 'fulfilled').length, 6);
    assert.equal(submissions.filter(value => value.status === 'rejected' && value.reason.status === 429).length, 1);
    await postgresQuota(bob, 'submit', env);
    await withUser(bob, async client => {
      const ownBuckets = await client.query('SELECT owner_id FROM grava_storage.rate_buckets');
      assert.deepEqual(ownBuckets.rows.map(row => row.owner_id), [bob]);
      assert.equal((await client.query('DELETE FROM grava_storage.rate_buckets WHERE owner_id=$1', [alice])).rowCount, 0);
    }, env);
    // Processing locks and cleanup use the same tenant isolation as recordings.
    const jobs = postgresRepository({ ...env, GRAVA_MAINTENANCE_URL: maintenance.toString() });
    const attempts = await Promise.all(Array.from({ length: 7 }, () => jobs.acquire(alice, 'shared-job-id')));
    const winners = attempts.filter(Boolean);
    assert.equal(winners.length, 1, 'only one concurrent caller owns the processing lock');
    await jobs.release(alice, 'shared-job-id', randomUUID());
    await jobs.release(bob, 'shared-job-id', winners[0]);
    assert.equal(await jobs.acquire(alice, 'shared-job-id'), null, 'wrong token or another owner cannot release the lock');
    await jobs.release(alice, 'shared-job-id', winners[0]);
    const replacementLock = await jobs.acquire(alice, 'shared-job-id');
    assert.ok(replacementLock);
    assert.notEqual(replacementLock, winners[0]);
    await jobs.release(alice, 'shared-job-id', winners[0]);
    assert.equal(await jobs.acquire(alice, 'shared-job-id'), null, 'a stale owner cannot release a newer lock');
    const job = (owner, expiresAt) => ({ userId: owner, recordingId: 'shared-job-id', status: 'uploading', pathname: 'fixture-only', blobPaths: [], providerIds: [], createdAt: 1, updatedAt: 1, expiresAt });
    await jobs.save(job(alice, Date.now() - 1000));
    await jobs.save(job(bob, Date.now() + 60_000));
    assert.deepEqual(await jobs.due(Date.now() + 86400000, 50), [], 'cleanup cannot select locked or future jobs, even with a caller-supplied future time');
    await jobs.release(alice, 'shared-job-id', replacementLock);
    assert.deepEqual(await jobs.due(Date.now() + 86400000, 50), [{ userId: alice, recordingId: 'shared-job-id' }]);
    await withUser(bob, async client => {
      assert.deepEqual((await client.query("SELECT owner_id FROM grava_storage.transcription_jobs WHERE recording_id='shared-job-id'")).rows.map(row => row.owner_id), [bob]);
      assert.equal((await client.query('DELETE FROM grava_storage.transcription_jobs WHERE owner_id=$1', [alice])).rowCount, 0);
    }, env);
    for (const malformed of [{ recordingId: 'missing-owner' }, { userId: bob, recordingId: 'wrong-owner' }]) {
      await assert.rejects(withUser(alice, client => client.query('INSERT INTO grava_storage.transcription_jobs(owner_id,recording_id,job,expires_at) VALUES($1,$2,$3,1)', [alice, malformed.recordingId, malformed]), env), error => error.code === '23514');
    }
    const connection = await storagePool(runtime.toString()).connect();
    try {
      assert.equal((await connection.query('SELECT * FROM grava_storage.recordings WHERE id = ANY($1::uuid[])', [[aliceId, bobId]])).rowCount, 0, 'no tenant context survives commit or rollback');
      await assert.rejects(connection.query('SET ROLE grava_storage_worker'), error => error.code === '42501');
    } finally { connection.release(); }
    await withMaintenance(async client => {
      await assert.rejects(client.query('SELECT * FROM grava_storage.recordings'), error => error.code === '42501');
      await assert.rejects(client.query('SELECT * FROM grava_storage.transcription_jobs'), error => error.code === '42501');
      assert.ok(Array.isArray((await client.query('SELECT * FROM grava_storage.recording_cleanup_candidates(50)')).rows));
    }, { GRAVA_MAINTENANCE_URL: maintenance.toString() });
    const cleanupRows = [
      { id: randomUUID(), status: 'ready', expires: "now()-interval '1 day'", eligible: false },
      { id: randomUUID(), status: 'pending', expires: "now()-interval '5 minutes'", eligible: false },
      { id: randomUUID(), status: 'pending', expires: "now()-interval '30 minutes'", eligible: true },
      { id: randomUUID(), status: 'deleting', expires: "now()+interval '5 minutes'", eligible: false },
      { id: randomUUID(), status: 'deleting', expires: "now()-interval '1 minute'", eligible: true },
    ];
    for (const row of cleanupRows) await admin.query(`INSERT INTO grava_storage.recordings(id,owner_id,local_id,metadata,reserved_bytes,status,expires_at) VALUES($1,$2,$3,'{}',100,$4,${row.expires})`, [row.id, alice, row.id, row.status]);
    await withMaintenance(async client => {
      const candidates = await client.query('SELECT * FROM grava_storage.recording_cleanup_candidates(50)');
      for (const row of cleanupRows) assert.equal(candidates.rows.some(item => item.recording_id === row.id), row.eligible);
      for (const row of cleanupRows) await client.query('SELECT grava_storage.finish_recording_cleanup($1)', [row.id]);
    }, { GRAVA_MAINTENANCE_URL: maintenance.toString() });
    const afterCleanup = await admin.query('SELECT id FROM grava_storage.recordings WHERE id=ANY($1::uuid[])', [cleanupRows.map(row => row.id)]);
    assert.deepEqual(afterCleanup.rows.map(row => row.id).sort(), cleanupRows.filter(row => !row.eligible).map(row => row.id).sort(), 'cleanup cannot delete live recordings or assets inside the outstanding-upload grace period');
  } finally {
    await admin.query('DELETE FROM grava_storage.recordings WHERE owner_id = ANY($1::text[])', [[alice, bob, quotaOwner, paginationOwner]]);
    await admin.query('DELETE FROM grava_storage.rate_buckets WHERE owner_id = ANY($1::text[])', [[alice, bob]]);
    await admin.query('DELETE FROM grava_storage.transcription_jobs WHERE owner_id = ANY($1::text[])', [[alice, bob]]);
    await admin.end();
    await storagePool(runtime.toString()).end();
    await storagePool(maintenance.toString()).end();
  }
});
