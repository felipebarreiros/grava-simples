import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheCandidates, DEFAULT_CACHE_BYTES } from '../src/recordings/cloudCache.ts';
import { setLocalAccount, getLocalAccount, scopedLocalKey, scopedStorageName, assertLocalAccount } from '../src/projects/keys.ts';

test('local data has a separate account namespace and never silently adopts legacy storage', () => {
  setLocalAccount(null);
  assert.equal(scopedLocalKey('workspace'), 'workspace');
  setLocalAccount('user_first');
  assert.equal(scopedLocalKey('workspace'), 'workspace:account:user_first');
  assert.equal(scopedStorageName('files', null), 'files');
  const account = getLocalAccount();
  setLocalAccount('user_second');
  assert.notEqual(scopedLocalKey('workspace'), scopedLocalKey('workspace', account));
  assert.throws(() => assertLocalAccount(account), { name: 'AbortError' });
  assert.throws(() => setLocalAccount('../other-user'));
  setLocalAccount(null);
});

test('cache only evicts complete matching cloud backups, ordered by last access', () => {
  const records = ['old', 'recent', 'local-only', 'pending', 'changed', 'playing'].map((id, i) => ({ id, createdAt: i, landscapeBytes: 40, portraitBytes: 60 }));
  const remote = records.filter(item => item.id !== 'local-only').map(item => ({ localId: item.id, status: item.id === 'pending' ? 'pending' : 'ready', landscape: { size: item.id === 'changed' ? 41 : 40 }, portrait: { size: 60 } }));
  assert.deepEqual(cacheCandidates(records, remote, { old: 10, recent: 100 }, ['playing'], 450), ['old', 'recent']);
  assert.deepEqual(cacheCandidates(records, remote, {}, [], 0), ['old', 'recent', 'playing']);
  assert.equal(DEFAULT_CACHE_BYTES, 1024 ** 3);
});

test('under-budget recordings keep all local copies and no stale receipt grants eviction', () => {
  const records = [{ id: 'original', createdAt: 1, landscapeBytes: 20, portraitBytes: 20 }];
  assert.deepEqual(cacheCandidates(records, [], {}, [], 0), []);
  assert.deepEqual(cacheCandidates(records, [{ localId: 'original', status: 'ready', landscape: { size: 20 }, portrait: { size: 20 } }], {}, [], 40), []);
});
