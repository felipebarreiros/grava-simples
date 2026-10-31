import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticTranscriptionAttempt, claimAutomaticTranscription, markAutomaticTranscription } from '../src/recordings/cloudTranscription.ts';

function deviceStorage({ unavailable = false } = {}) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => { if (unavailable) throw Error('Storage unavailable'); return values.get(key) ?? null; },
    setItem: (key, value) => { if (unavailable) throw Error('Storage unavailable'); values.set(key, value); },
  } });
  return () => { if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else delete globalThis.localStorage; };
}

test('automatic transcription claims once across concurrent effects and stays separate by account and recording', async () => {
  const restore = deviceStorage();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimAutomaticTranscription('user_alice', 'automatic-concurrent')));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(automaticTranscriptionAttempt('user_alice', 'automatic-concurrent'), 'started');
    assert.equal(await claimAutomaticTranscription('user_bob', 'automatic-concurrent'), true);
    assert.equal(await claimAutomaticTranscription('user_alice', 'different-recording'), true);
  } finally { restore(); }
});

test('cancellation and removal survive module reloads and do not silently restart a paid job', async () => {
  const restore = deviceStorage();
  try {
    for (const state of ['cancelled', 'removed']) {
      markAutomaticTranscription('user_alice', state, state);
      const reloaded = await import('../src/recordings/cloudTranscription.ts?automatic-intent-reload=' + state);
      assert.equal(reloaded.automaticTranscriptionAttempt('user_alice', state), state);
      assert.equal(await reloaded.claimAutomaticTranscription('user_alice', state), false);
      reloaded.markAutomaticTranscription('user_alice', state, 'started');
      assert.equal(automaticTranscriptionAttempt('user_alice', state), 'started');
    }
  } finally { restore(); }
});

test('unavailable browser storage still prevents duplicate automatic starts in the current session', async () => {
  const restore = deviceStorage({ unavailable: true });
  try {
    assert.equal(await claimAutomaticTranscription('user_alice', 'storage-unavailable'), true);
    assert.equal(await claimAutomaticTranscription('user_alice', 'storage-unavailable'), false);
    markAutomaticTranscription('user_alice', 'storage-unavailable', 'cancelled');
    assert.equal(automaticTranscriptionAttempt('user_alice', 'storage-unavailable'), 'cancelled');
  } finally { restore(); }
});
