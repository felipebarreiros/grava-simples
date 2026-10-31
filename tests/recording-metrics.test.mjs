import test from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedRecordingOperation, recordingFailureCode, recordingFileProperties,
  recordingSettings, recordingSummary,
} from '../src/analytics/recordingMetrics.ts';

test('browser failures are categorized through wrapped causes without exposing messages or device identity', () => {
  for (const [name, code] of [
    ['NotAllowedError', 'permission_denied'], ['SecurityError', 'permission_denied'],
    ['NotFoundError', 'device_not_found'], ['NotReadableError', 'device_unavailable'],
    ['OverconstrainedError', 'constraints_unsupported'], ['NotSupportedError', 'unsupported_browser'],
    ['QuotaExceededError', 'storage_full'], ['InvalidStateError', 'invalid_state'],
    ['AbortError', 'aborted'], ['TimeoutError', 'timeout'],
  ]) {
    const original = new DOMException('PRIVATE camera name and token=SECRET', name);
    const wrapped = new Error('PRIVATE path /recordings/SECRET', { cause: new Error('localized failure', { cause: original }) });
    assert.equal(recordingFailureCode(wrapped), code);
  }
  const cycle = { name: 'UnknownError', message: 'SECRET' };
  cycle.cause = cycle;
  assert.equal(recordingFailureCode(cycle), 'unknown');
  assert.equal(recordingFailureCode('NotAllowedError SECRET'), 'unknown');
  assert.equal(recordingFailureCode(Object.defineProperty({}, 'name', { get() { throw Error('SECRET'); } })), 'unknown');
});

test('recording analytics reconstruct only safe settings and finite bounded media counters', () => {
  const config = {
    source: 'camera', resolution: '1080', fps: 30, microphone: true,
    cameraDeviceId: 'SECRET', microphoneDeviceId: 'PRIVATE',
    appearance: { productTitle: 'PRIVATE title', layers: [{ text: 'PRIVATE transcript' }] },
  };
  assert.deepEqual(recordingSettings(config), {
    source_kind: 'camera', resolution: '1080', target_fps: 30, microphone_enabled: true,
  });
  assert.deepEqual(recordingSettings({ source: 'PRIVATE', resolution: 'SECRET', fps: Infinity }), {});
  const summary = recordingSummary({
    config,
    metrics: {
      elapsedMs: 10_000, frames: { landscape: 200, portrait: 198 },
      measuredFps: 30, bytes: { landscape: 10, portrait: 20 }, audio: true,
      microphone: { deviceId: 'SECRET', label: 'PRIVATE' },
    },
    result: { landscape: { durationMs: 10_000, size: 120_000, url: 'blob:SECRET', fileName: 'PRIVATE.mp4' }, portrait: { size: 100_000 } },
  });
  assert.equal(summary.measured_capture_fps, 20);
  assert.equal(summary.capture_below_target, true);
  assert.equal(summary.recording_duration_ms, 10_000);
  assert.equal(summary.landscape_bytes, 120_000);
  assert.equal(summary.portrait_frames, 198);
  assert.equal(summary.audio_enabled, true);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|SECRET|blob:|deviceId|label|productTitle|transcript/);
});

test('invalid metrics and very short captures never manufacture valid performance samples', () => {
  const metrics = {
    elapsedMs: 0, frames: { landscape: -1, portrait: Infinity },
    measuredFps: 30, bytes: { landscape: NaN, portrait: -5 }, audio: false,
  };
  let summary = recordingSummary({ config: { fps: 30 }, metrics });
  assert.equal(summary.measured_capture_fps, undefined);
  assert.equal(summary.landscape_frames, undefined);
  assert.equal(summary.portrait_bytes, undefined);
  assert.equal('capture_below_target' in summary, false);
  summary = recordingSummary({ config: { fps: 30 }, metrics: { ...metrics, elapsedMs: 500, frames: { landscape: 1, portrait: 1 } } });
  assert.equal(summary.measured_capture_fps, 2);
  assert.equal('capture_below_target' in summary, false);
  assert.equal(elapsedRecordingOperation(10, 11.7), 2);
  assert.equal(elapsedRecordingOperation(10, 9), 0);
  assert.equal(elapsedRecordingOperation(0, Infinity), 0);
});

test('download metadata distinguishes preparation from a requested download without exporting filenames', () => {
  const properties = recordingFileProperties({ orientation: 'portrait', mimeType: 'video/mp4;codecs=avc1', size: 12345, durationMs: 1234.4, fileName: 'PRIVATE.mp4', url: 'blob:SECRET' });
  assert.deepEqual(properties, { orientation: 'portrait', format: 'mp4', file_bytes: 12345, recording_duration_ms: 1234 });
  assert.doesNotMatch(JSON.stringify(properties), /PRIVATE|SECRET|fileName|url/);
  assert.equal(recordingFileProperties({ orientation: 'landscape', mimeType: 'video/webm', size: Infinity, durationMs: -1 }).file_bytes, undefined);
});
