import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const binary = await readFile(new URL('../public/engine/obs-core.wasm', import.meta.url))
const module = await WebAssembly.compile(binary)
async function engine() {
  const { exports } = await WebAssembly.instantiate(module, {})
  exports._initialize?.()
  return exports
}
function near(actual, expected, tolerance = 0.001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`)
}
function rect(wasm, values) {
  return [...new Float32Array(wasm.memory.buffer, wasm.obs_layout(...values), 16)]
}

test('the distributed Wasm module exposes layout and actual compressor DSP without native imports', () => {
  assert.equal(binary.subarray(0, 4).toString('hex'), '0061736d')
  assert.deepEqual(WebAssembly.Module.imports(module), [])
  const exported = new Set(WebAssembly.Module.exports(module).map(value => value.name))
  for (const name of ['obs_layout', 'obs_audio_gain_db', 'obs_audio_buffer', 'obs_compressor_config', 'obs_compressor_process']) assert.ok(exported.has(name), name)
})

test('Wasm landscape/portrait layouts preserve independent framing and camera crop', async () => {
  const wasm = await engine()
  const landscape = rect(wasm, [1280, 720, 1920, 1080, 1280, 720, 1, 0])
  const landscapeExpected = [0, 0, 1280, 720, 0, 0, 1920, 1080, 931.84, 511.84, 320, 180, 0, 0, 1280, 720]
  landscapeExpected.forEach((value, index) => near(landscape[index], value))
  const portrait = rect(wasm, [720, 1280, 1920, 1080, 1280, 720, 1, 1])
  const portraitExpected = [0, 79.1, 720, 405, 0, 0, 1920, 1080, 0, 588.8, 720, 691.2, 265, 0, 750, 720]
  portraitExpected.forEach((value, index) => near(portrait[index], value))
  const camera = rect(wasm, [720, 1280, 1920, 1080, 1280, 720, 0, 1])
  const cameraExpected = [0, 0, 720, 1280, 656.25, 0, 607.5, 1080, 0, 0, 0, 0, 0, 0, 0, 0]
  cameraExpected.forEach((value, index) => near(camera[index], value))
})

test('OBS Wasm dB conversion matches analytic amplitude factors', async () => {
  const wasm = await engine()
  for (const db of [-24, -6, 0, 6]) near(wasm.obs_audio_gain_db(db), 10 ** (db / 20), 0.000001)
})

test('compressor silence is finite and 1:1 ratio preserves positive and negative samples', async () => {
  const wasm = await engine()
  wasm.obs_compressor_config(0, 48000, 1, 4, -18, 6, 100, 0)
  const buffer = new Float32Array(wasm.memory.buffer, wasm.obs_audio_buffer(0), 4096)
  wasm.obs_compressor_process(0, 128)
  assert.ok(buffer.subarray(0, 128).every(value => value === 0))
  wasm.obs_compressor_config(0, 48000, 1, 1, -18, 6, 100, 0)
  for (let index = 0; index < 128; index++) buffer[index] = index % 2 ? -0.8 : 0.8
  const input = [...buffer.subarray(0, 128)]
  wasm.obs_compressor_process(0, 128)
  input.forEach((value, index) => near(buffer[index], value, 0.000001))
})

test('compressor attack converges to the expected 4:1 transfer function with linked stereo gain', async () => {
  const wasm = await engine()
  wasm.obs_compressor_config(0, 48000, 2, 4, -18, 6, 100, 0)
  const buffer = new Float32Array(wasm.memory.buffer, wasm.obs_audio_buffer(0), 4096)
  const expected = 0.8 * 10 ** ((1 - 1 / 4) * (-18 - 20 * Math.log10(0.8)) / 20)
  let first = 0
  for (let block = 0; block < 10; block++) {
    buffer.fill(0.8, 0, 2048)
    buffer.fill(0.4, 2048, 4096)
    wasm.obs_compressor_process(0, 2048)
    if (!block) first = buffer[0]
  }
  near(first, 0.8)
  near(buffer[2047], expected)
  near(buffer[4095], expected / 2)
  assert.ok(first > buffer[2047], 'Attack should reduce gain over time')
  assert.ok(buffer.every(Number.isFinite))
})

test('compressor slots keep separate state and invalid slots do not corrupt audio', async () => {
  const wasm = await engine()
  assert.equal(wasm.obs_audio_buffer(-1), 0)
  assert.equal(wasm.obs_audio_buffer(8), 0)
  wasm.obs_compressor_config(1, 48000, 1, 1, -18, 6, 100, -6)
  const buffer = new Float32Array(wasm.memory.buffer, wasm.obs_audio_buffer(1), 4096)
  buffer.fill(0.4, 0, 128)
  wasm.obs_compressor_process(-1, 128)
  wasm.obs_compressor_process(8, 128)
  near(buffer[0], 0.4)
  wasm.obs_compressor_process(1, 128)
  near(buffer[0], 0.4 * 10 ** (-6 / 20))
})
