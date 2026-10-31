import test from 'node:test';
import assert from 'node:assert/strict';
import { creatorProperties } from '../src/analytics/eventProperties.ts';
import { feedbackState, markRecordingFeedbackEligible, setFeedbackState } from '../src/analytics/feedbackState.ts';

test('operational events reject creator content and invalid counters while retaining safe diagnostics', () => {
  const clean = creatorProperties({
    orientation: 'portrait', format: 'mp4', outcome: 'complete', error_code: 'permission_denied',
    duration_ms: 23.4567, measured_capture_fps: Number.NaN, target_fps: Infinity,
    landscape_frames: -1, file_bytes: 2 ** 50, audio_enabled: true,
    source_kind: 'PRIVATE DEVICE NAME', resolution: '1080',
    transcript: 'Private transcript', projectId: 'private-id', fileName: 'private.mp4',
    deviceId: 'private-device', secret: 'secret', microphone: { label: 'Private name' },
  });
  assert.deepEqual(clean, {
    orientation: 'portrait', format: 'mp4', resolution: '1080', error_code: 'permission_denied', outcome: 'complete',
    audio_enabled: true, duration_ms: 23.46, file_bytes: 2 ** 40,
  });
  assert.doesNotMatch(JSON.stringify(clean), /private|secret|transcript|deviceId/i);
});

test('feedback eligibility is once per account and campaign, survives reload storage and storage failure', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = new Map();
  let notifications = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: () => { notifications++; } } });
  try {
    markRecordingFeedbackEligible('survey-a', 'user-a');
    markRecordingFeedbackEligible('survey-a', 'user-a');
    assert.equal(notifications, 1);
    assert.equal(feedbackState('survey-a', 'user-a'), 'eligible');
    setFeedbackState('survey-a', 'user-a', 'dismissed');
    markRecordingFeedbackEligible('survey-a', 'user-a');
    assert.equal(feedbackState('survey-a', 'user-a'), 'dismissed');
    assert.equal(feedbackState('survey-a', 'user-b'), null);
    assert.equal(feedbackState('survey-b', 'user-a'), null);
    assert.equal([...storage.values()][0], 'dismissed');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Storage blocked'); } });
    assert.doesNotThrow(() => markRecordingFeedbackEligible('survey-storage-failure', 'user-a'));
    setFeedbackState('survey-storage-failure', 'user-a', 'sent');
    markRecordingFeedbackEligible('survey-storage-failure', 'user-a');
    assert.equal(feedbackState('survey-storage-failure', 'user-a'), 'sent');
    assert.equal(notifications, 2);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
  }
});
