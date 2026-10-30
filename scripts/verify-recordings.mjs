#!/usr/bin/env node
/** Independently decode and inspect downloaded recordings. No app code is imported. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function executable(envKey, name, fallback) {
  if (process.env[envKey]) return process.env[envKey]
  const system = spawnSync('which', [name], { encoding: 'utf8' })
  if (system.status === 0) return system.stdout.trim()
  const path = resolve(root, fallback)
  if (existsSync(path)) return path
  throw new Error(`${name} is missing. Set ${envKey}, or install the test tooling described in tests/README.md.`)
}
function run(command, args, binary = false) {
  const result = spawnSync(command, args, { encoding: binary ? undefined : 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`)
  return result
}
const number = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null

/** Combine decoded frame times with the audio clock, so a missing video tail is a gap. */
export function analyzeContinuity(frames, timelineStart, timelineEnd, motionSamples, options = {}) {
  const timestamps = frames.map(frame => frame.timestamp).filter(Number.isFinite).sort((a, b) => a - b)
  const lastFrame = frames.at(-1)
  const first = timestamps[0] ?? timelineEnd
  const last = timestamps.at(-1) ?? timelineStart
  const lastEnd = last + (lastFrame?.duration ?? 0)
  const leadingGapSeconds = Math.max(0, first - timelineStart)
  const trailingGapSeconds = Math.max(0, timelineEnd - lastEnd)
  let maximumInternalFrameGapSeconds = 0
  for (let index = 1; index < timestamps.length; index++) maximumInternalFrameGapSeconds = Math.max(maximumInternalFrameGapSeconds, timestamps[index] - timestamps[index - 1])
  const frameCountsPerSecond = []
  for (let second = 0; timelineStart + second < timelineEnd - 0.0001; second++) {
    const start = timelineStart + second
    const end = Math.min(start + 1, timelineEnd)
    frameCountsPerSecond.push({ second, start, end, decodedFrames: 0, movingTransitions: 0 })
  }
  for (const timestamp of timestamps) {
    const bin = frameCountsPerSecond[Math.floor((timestamp - timelineStart) + 0.000001)]
    if (bin) bin.decodedFrames++
  }
  for (const sample of motionSamples) {
    const bin = frameCountsPerSecond[Math.floor((sample.timeSeconds - timelineStart) + 0.000001)]
    if (bin && sample.moving) bin.movingTransitions++
  }
  const moving = motionSamples.filter(sample => sample.moving)
  const motionGaps = []
  let priorMotion = timelineStart
  for (const sample of moving) { motionGaps.push(Math.max(0, sample.timeSeconds - priorMotion)); priorMotion = sample.timeSeconds }
  motionGaps.push(Math.max(0, timelineEnd - priorMotion))
  const tailStart = Math.max(timelineStart, timelineEnd - (options.tailWindowSeconds ?? 5))
  const tailFrames = timestamps.filter(time => time >= tailStart && time <= timelineEnd)
  const tailMotion = moving.filter(sample => sample.timeSeconds >= tailStart && sample.timeSeconds <= timelineEnd)
  return {
    timelineStart, timelineEnd, firstDecodedTimestamp: first, lastDecodedTimestamp: last, lastFrameEndTimestamp: lastEnd,
    leadingGapSeconds, trailingGapSeconds, maximumInternalFrameGapSeconds,
    maximumFrameGapSeconds: Math.max(leadingGapSeconds, trailingGapSeconds, maximumInternalFrameGapSeconds),
    frameCountsPerSecond, inactiveMotionSeconds: frameCountsPerSecond.filter(bin => bin.end - bin.start > 0.99 && bin.movingTransitions === 0).map(bin => bin.second), minimumFullSecondFrameCount: Math.min(...frameCountsPerSecond.filter(bin => bin.end - bin.start > 0.99).map(bin => bin.decodedFrames)),
    motionSamples: motionSamples.length, movingTransitions: moving.length, maximumStillSeconds: Math.max(...motionGaps),
    lastFiveSeconds: { start: tailStart, end: timelineEnd, decodedFrames: tailFrames.length, movingTransitions: tailMotion.length, lastMovingTimestamp: tailMotion.at(-1)?.timeSeconds ?? null },
  }
}

export function verifyRecording(spec) {
  const path = resolve(spec.path)
  const ffprobe = executable('FFPROBE', 'ffprobe', '.context/tools/node_modules/ffprobe-static/bin/linux/x64/ffprobe')
  const ffmpeg = executable('FFMPEG', 'ffmpeg', '.context/tools/node_modules/ffmpeg-static/ffmpeg')
  const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_packets', '-show_streams', '-show_format', '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels:format=format_name,duration,size:packet=stream_index,pts_time,dts_time,duration_time,size', '-of', 'json', path]).stdout)
  const decoded = JSON.parse(run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_pts_time,pkt_dts_time,pkt_duration_time', '-of', 'json', path]).stdout)
  const decodedFrames = decoded.frames.map(frame => ({ timestamp: number(frame.best_effort_timestamp_time ?? frame.pkt_pts_time ?? frame.pkt_dts_time), duration: number(frame.pkt_duration_time) ?? 0 })).filter(frame => frame.timestamp !== null)
  const failures = []
  const check = (condition, message) => { if (!condition) failures.push(message) }
  const video = probe.streams.find(stream => stream.codec_type === 'video')
  const audio = probe.streams.find(stream => stream.codec_type === 'audio')
  check(Boolean(video), 'No video stream')
  check(Boolean(audio), 'No audio stream')
  if (spec.width) check(video?.width === spec.width, `Expected width ${spec.width}, got ${video?.width}`)
  if (spec.height) check(video?.height === spec.height, `Expected height ${spec.height}, got ${video?.height}`)
  const streams = probe.streams.map(stream => {
    const packets = probe.packets.filter(packet => packet.stream_index === stream.index)
    let prior = -Infinity, backwards = 0, maximumGap = 0, first = Infinity, last = -Infinity
    let previousTime = null
    for (const packet of packets) {
      const timestamp = number(packet.pts_time ?? packet.dts_time)
      const decodeTimestamp = number(packet.dts_time ?? packet.pts_time)
      if (timestamp === null || decodeTimestamp === null) { backwards++; continue }
      if (decodeTimestamp + 0.000001 < prior) backwards++
      prior = decodeTimestamp
      if (previousTime !== null) maximumGap = Math.max(maximumGap, decodeTimestamp - previousTime)
      previousTime = decodeTimestamp
      first = Math.min(first, timestamp)
      last = Math.max(last, timestamp + (number(packet.duration_time) ?? 0))
    }
    const durationSeconds = packets.length ? last - first : 0
    const frameCount = stream.codec_type === 'video' ? decodedFrames.length : null
    const measuredFps = stream.codec_type === 'video' && durationSeconds ? frameCount / durationSeconds : null
    check(packets.length > 0, `${stream.codec_type} has no packets`)
    check(backwards === 0, `${stream.codec_type} has ${backwards} nonmonotonic or missing decode timestamps`)
    if (spec.expectedDurationSec) {
      check(durationSeconds >= spec.expectedDurationSec * (spec.minimumDurationRatio ?? 0.85), `${stream.codec_type} duration ${durationSeconds.toFixed(3)}s is shorter than expected ${spec.expectedDurationSec}s`)
      check(durationSeconds <= spec.expectedDurationSec * 1.4 + 2, `${stream.codec_type} duration ${durationSeconds.toFixed(3)}s is unexpectedly long`)
    }
    if (stream.codec_type === 'video') {
      check(frameCount > 0, 'No independently decoded video frames')
      if (spec.minimumFps) check(measuredFps >= spec.minimumFps, `Measured ${measuredFps?.toFixed(2)} fps is below required ${spec.minimumFps}`)
    }
    return { ...stream, packets: packets.length, decodedFrames: frameCount, firstTimestamp: first, lastTimestamp: last, durationSeconds, measuredFps, maximumGapSeconds: maximumGap, timestampErrors: backwards }
  })
  const timelineStart = Math.min(...streams.map(stream => stream.firstTimestamp))
  const timelineEnd = Math.max(...streams.map(stream => stream.lastTimestamp))
  // Decode every video frame, then sample small grayscale images for a pixel-based motion check.
  // Unlike counting a few different hashes, this detects a static tail containing valid 30fps packets.
  const sampleRate = 4, sampleWidth = 96, sampleHeight = 54, frameBytes = sampleWidth * sampleHeight
  const decode = run(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v:0', '-vf', `fps=${sampleRate},scale=${sampleWidth}:${sampleHeight}:flags=area,format=gray`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], true)
  const sampledFrames = Math.floor(decode.stdout.length / frameBytes)
  const motionSamples = []
  const hashes = new Set()
  for (let index = 0; index < sampledFrames; index++) {
    const current = decode.stdout.subarray(index * frameBytes, (index + 1) * frameBytes)
    hashes.add(createHash('sha256').update(current).digest('hex'))
    if (!index) continue
    const previous = decode.stdout.subarray((index - 1) * frameBytes, index * frameBytes)
    let difference = 0, changedPixels = 0
    for (let pixel = 0; pixel < frameBytes; pixel++) {
      const delta = Math.abs(current[pixel] - previous[pixel])
      difference += delta
      if (delta > 4) changedPixels++
    }
    const meanAbsoluteDifference = difference / frameBytes
    const changedPixelFraction = changedPixels / frameBytes
    motionSamples.push({ timeSeconds: (decodedFrames[0]?.timestamp ?? 0) + index / sampleRate, meanAbsoluteDifference, changedPixelFraction, moving: meanAbsoluteDifference >= (spec.minimumMotionDifference ?? 0.25) && changedPixelFraction >= (spec.minimumChangedPixelFraction ?? 0.02) })
  }
  const continuity = analyzeContinuity(decodedFrames, timelineStart, timelineEnd, motionSamples, spec)
  if (spec.requireDynamic || spec.requireContinuousVideo) {
    check(continuity.maximumFrameGapSeconds <= (spec.maximumVideoGapSec ?? 0.5), `Video freezes or ends early: maximum decoded frame gap ${continuity.maximumFrameGapSeconds.toFixed(3)}s (including audio tail)`)
    check(continuity.inactiveMotionSeconds.length === 0, `Video content is stationary during complete seconds: ${continuity.inactiveMotionSeconds.join(', ')}`)
    check(continuity.maximumStillSeconds <= (spec.maximumStillSeconds ?? 2), `Video content stops moving: longest motion gap ${continuity.maximumStillSeconds.toFixed(3)}s`)
    check(continuity.lastFiveSeconds.movingTransitions >= (spec.minimumTailMotionTransitions ?? 3), `Video is frozen in its final five seconds: ${continuity.lastFiveSeconds.movingTransitions} moving transitions`)
    check(continuity.lastFiveSeconds.decodedFrames >= (spec.minimumTailDecodedFrames ?? 10), `Only ${continuity.lastFiveSeconds.decodedFrames} decoded video frames in the final five seconds`)
  }
  check(decode.stderr.toString().trim().length === 0, `Decoder reported errors: ${decode.stderr.toString().trim()}`)
  let volume = null
  if (audio) {
    const result = run(ffmpeg, ['-hide_banner', '-i', path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
    const mean = result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)
    const max = result.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)
    volume = { meanDb: mean ? Number(mean[1]) : null, maxDb: max ? Number(max[1]) : null }
    if (spec.requireAudible !== false) check(volume.maxDb !== null && volume.maxDb > -50, 'Audio stream contains no audible test signal')
  }
  if (video && audio) {
    const vs = streams.find(stream => stream.codec_type === 'video')
    const as = streams.find(stream => stream.codec_type === 'audio')
    check(Math.abs(vs.durationSeconds - as.durationSeconds) < (spec.maxAvDurationDeltaSec ?? 0.75), `Audio/video duration delta exceeds tolerance: ${Math.abs(vs.durationSeconds - as.durationSeconds).toFixed(3)}s`)
  }
  return { path, bytes: statSync(path).size, format: probe.format, streams, volume, sampledFrames, distinctFrameHashes: hashes.size, continuity, motionSamples, decodeErrors: decode.stderr.toString().trim(), failures, passed: failures.length === 0 }
}

export function verifyRecordings(manifest) {
  const recordings = manifest.recordings.map(verifyRecording)
  return { verifiedAt: new Date().toISOString(), environment: 'Headless Chrome in a Linux VM; functional validation only, not physical hardware qualification.', recordings, passed: recordings.every(recording => recording.passed) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const manifestIndex = args.indexOf('--manifest')
  const outputIndex = args.indexOf('--json')
  const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--json')
  const manifest = manifestIndex >= 0 ? JSON.parse(readFileSync(args[manifestIndex + 1], 'utf8')) : { recordings: positional.map(path => ({ path })) }
  if (!manifest.recordings.length) throw new Error('Usage: node scripts/verify-recordings.mjs --manifest manifest.json [--json report.json]')
  const report = verifyRecordings(manifest)
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], JSON.stringify(report, null, 2) + '\n')
  for (const recording of report.recordings) {
    const video = recording.streams.find(stream => stream.codec_type === 'video')
    const audio = recording.streams.find(stream => stream.codec_type === 'audio')
    console.log(`${recording.passed ? 'PASS' : 'FAIL'} ${recording.path}: ${video?.width}x${video?.height}, ${video?.decodedFrames} decoded frames, ${video?.durationSeconds.toFixed(3)}s, ${video?.measuredFps?.toFixed(2)}fps, max video gap ${recording.continuity.maximumFrameGapSeconds.toFixed(3)}s, tail ${recording.continuity.lastFiveSeconds.decodedFrames} frames/${recording.continuity.lastFiveSeconds.movingTransitions} motion transitions, ${audio?.codec_name} ${audio?.sample_rate}Hz ${audio?.channels}ch, ${recording.bytes} bytes`)
    for (const failure of recording.failures) console.error(`  ${failure}`)
  }
  if (!report.passed) process.exitCode = 1
}
