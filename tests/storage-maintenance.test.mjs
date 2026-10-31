import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStorageMaintenance } from '../server/storage/maintenance.ts';

const secret = 'cron-fixture-secret';
const request = (token = secret, method = 'GET') => new Request('https://studio.test/api/transcription-cleanup', { method, headers: { authorization: `Bearer ${token}` } });

test('cron authentication and method checks precede every global cleanup operation', async () => {
  let called = 0;
  const cleanup = async () => { called++; return { removed: 0, failed: 0 }; };
  for (const [incoming, configuredSecret, status] of [[request('customer-session'), secret, 401], [request(), undefined, 401], [request(secret, 'POST'), secret, 405]]) {
    const response = await handleStorageMaintenance(incoming, { configured: false }, cleanup, configuredSecret);
    assert.equal(response.status, status);
  }
  assert.equal(called, 0);
});

test('durable storage cleanup works independently of an unconfigured speech provider', async () => {
  const response = await handleStorageMaintenance(request(), { configured: false }, async () => ({ removed: 2, failed: 0 }), secret);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { transcription: { configured: false }, recordings: { removed: 2, failed: 0 } });
});

test('cleanup failures remain retryable and do not expose underlying credentials or prevent the other cleanup', async () => {
  let storageCalled = 0;
  const deps = { configured: true, now: Date.now, repository: { due: async () => { throw new Error('PRIVATE postgres://SECRET'); } } };
  const response = await handleStorageMaintenance(request(), deps, async () => { storageCalled++; return { removed: 1, failed: 0 }; }, secret);
  assert.equal(response.status, 503);
  assert.equal(storageCalled, 1);
  assert.doesNotMatch(await response.text(), /PRIVATE|SECRET|postgres/);
  const storageFailure = await handleStorageMaintenance(request(), { configured: false }, async () => { throw new Error('PRIVATE Blob SECRET'); }, secret);
  assert.equal(storageFailure.status, 503);
  assert.doesNotMatch(await storageFailure.text(), /PRIVATE|SECRET|Blob/);
});
