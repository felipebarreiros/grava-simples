import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingVideoBitrate, RECORDING_AUDIO_BITS_PER_SECOND } from '../src/media/recordingProfile.ts';

test('recording targets allocate enough bitrate for each output size and frame rate', () => {
  assert.equal(recordingVideoBitrate({ resolution: '360', fps: 30 }), 2_500_000);
  assert.equal(recordingVideoBitrate({ resolution: '720', fps: 30 }), 8_000_000);
  assert.equal(recordingVideoBitrate({ resolution: '1080', fps: 30 }), 16_000_000);
  assert.equal(recordingVideoBitrate({ resolution: '4k', fps: 30 }), 45_000_000);
  assert.equal(recordingVideoBitrate({ resolution: '1080', fps: 60 }), 24_000_000);
  assert.equal(RECORDING_AUDIO_BITS_PER_SECOND, 192_000);
});
