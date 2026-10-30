import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRecording } from '../scripts/verify-recordings.mjs'

const ffmpeg = process.env.FFMPEG ?? resolve('.context/tools/node_modules/ffmpeg-static/ffmpeg')
function fixture(name, sourceSeconds, tailSeconds = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), 'recording-freeze-'))
  const path = resolve(directory, name + '.webm')
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${sourceSeconds}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12']
  if (tailSeconds) args.push('-vf', `tpad=stop_mode=clone:stop_duration=${tailSeconds}`)
  args.push('-t', '12', '-c:v', 'libvpx', '-g', '30', '-b:v', '150k', '-c:a', 'libopus', path)
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return { path, directory }
}
const spec = path => ({ path, width: 160, height: 90, expectedDurationSec: 12, minimumFps: 24, requireAudible: true, requireDynamic: true })

test('continuous moving video stays active through the final five seconds', () => {
  const file = fixture('healthy', 12)
  try {
    const report = verifyRecording(spec(file.path))
    assert.equal(report.passed, true, report.failures.join('\n'))
    assert.ok(report.continuity.maximumFrameGapSeconds < 0.05)
    assert.ok(report.continuity.lastFiveSeconds.decodedFrames >= 145)
    assert.ok(report.continuity.lastFiveSeconds.movingTransitions >= 15)
    assert.ok(report.continuity.frameCountsPerSecond.filter(bin => bin.end - bin.start > 0.99).every(bin => bin.decodedFrames >= 29))
  } finally { rmSync(file.directory, { recursive: true, force: true }) }
})

test('a 30fps file with a frozen six-second tail fails despite good average FPS and many earlier moving frames', () => {
  const file = fixture('frozen-tail', 6, 6)
  try {
    const report = verifyRecording(spec(file.path))
    const video = report.streams.find(stream => stream.codec_type === 'video')
    assert.ok(video.measuredFps >= 29)
    assert.ok(report.distinctFrameHashes > 3)
    assert.ok(report.continuity.maximumFrameGapSeconds < 0.05)
    assert.equal(report.passed, false)
    assert.ok(report.continuity.lastFiveSeconds.decodedFrames >= 145)
    assert.equal(report.continuity.lastFiveSeconds.movingTransitions, 0)
    assert.ok(report.failures.some(message => message.includes('content stops moving')))
    assert.ok(report.failures.some(message => message.includes('frozen in its final five seconds')))
  } finally { rmSync(file.directory, { recursive: true, force: true }) }
})

test('video ending six seconds before continuing audio fails decoded-timeline and tail-frame checks', () => {
  const file = fixture('missing-tail', 6)
  try {
    const report = verifyRecording(spec(file.path))
    assert.equal(report.passed, false)
    assert.ok(report.continuity.trailingGapSeconds >= 5.9)
    assert.equal(report.continuity.lastFiveSeconds.decodedFrames, 0)
    assert.ok(report.failures.some(message => message.includes('including audio tail')))
    assert.ok(report.failures.some(message => message.includes('final five seconds')))
  } finally { rmSync(file.directory, { recursive: true, force: true }) }
})
