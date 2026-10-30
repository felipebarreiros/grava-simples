import { test, expect, type Page } from './fixtures/auth'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { selectValue } from './helpers'

const artifacts = resolve('.context/results')

type Snapshot = {
  ready?: boolean
  state?: string
  status?: string
  engine?: { backend?: string; layoutCalls?: number; audioNodes?: number; audioBlocks?: number }
  metrics?: { engineBackend?: string; elapsedMs?: number; measuredFps?: number; frames?: { landscape: number; portrait: number }; pendingWrites?: number; audio?: boolean; bytes?: unknown; chunks?: unknown }
  error?: string
  [key: string]: unknown
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (window as any).__recorderTest
    return typeof hook === 'function' ? hook() : typeof hook?.snapshot === 'function' ? hook.snapshot() : hook
  })
}

async function waitState(page: Page, expected: string) {
  await expect.poll(async () => {
    const value = await snapshot(page)
    if (value?.error) throw new Error(value.error)
    return value?.state ?? value?.status
  }).toBe(expected)
}

async function choose(page: Page, id: string, value: string) {
  if (id === 'scene-select') {
    const scene = page.getByTestId(`scene-${value}`)
    if (await scene.count()) {
      await scene.click()
      return
    }
  }
  const control = page.getByTestId(id)
  const settingsOpened = !await control.isVisible()
  if (settingsOpened) await page.getByTestId('settings-trigger').click()
  await expect(control).toBeVisible()
  await selectValue(page, control, value)
  if (settingsOpened) await page.keyboard.press('Escape')
}

async function recordPair(page: Page, resolution: '360' | '1080' | '4k', fps: 30 | 60, seconds: number, source: 'test' | 'camera' = 'test', purpose: 'motion-regression' | 'performance-qualification' = 'motion-regression') {
  const sourceTag = source === 'camera' ? '-camera' : ''
  const destination = resolve(artifacts, resolution + (fps === 60 ? '-60' : '') + (seconds >= 60 ? `-${purpose === 'performance-qualification' ? 'soak' : 'extended'}-${seconds}s` : '') + (process.env.RECORDING_RUN_NAME ? `-${process.env.RECORDING_RUN_NAME}` : '') + sourceTag)
  await mkdir(destination, { recursive: true })
  await mkdir(resolve('.context/screenshots'), { recursive: true })
  const errors: string[] = []
  const wasmResponses: Promise<{ url: string; status: number; bytes: number; magic: string; sha256: string; exports: string[] }>[] = []
  page.on('response', response => {
    if (/\.wasm(?:\?|$)/.test(response.url())) wasmResponses.push((async () => {
      const body = await response.body()
      const exports = await page.evaluate(async bytes => WebAssembly.Module.exports(await WebAssembly.compile(new Uint8Array(bytes))).map(item => item.name), [...body])
      return { url: response.url(), status: response.status(), bytes: body.byteLength, magic: body.subarray(0, 4).toString('hex'), sha256: createHash('sha256').update(body).digest('hex'), exports }
    })())
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text() + ' (' + message.location().url + ')')
  })
  if (source === 'camera') await page.context().grantPermissions(['camera', 'microphone'])
  await page.goto('/app?test=1', { waitUntil: 'networkidle' })
  await expect.poll(async () => Boolean(await snapshot(page))).toBe(true)
  const wasmEvidence = await Promise.all(wasmResponses)
  expect(wasmEvidence.length).toBeGreaterThan(0)
  expect(wasmEvidence.every(item => item.status === 200 && item.magic === '0061736d')).toBe(true)
  expect(wasmEvidence.some(item => item.exports.includes('obs_layout'))).toBe(true)
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true)
  const applicationVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
  await page.getByTestId('settings-trigger').click()
  await page.getByRole('button', { name: 'Sobre e detalhes técnicos' }).click()
  await expect(page.getByTestId('app-version')).toContainText(applicationVersion)
  await expect(page.getByRole('link', { name: 'Código-fonte e licenças GPL' })).toHaveAttribute('href', '/source/grava-simples-source.tar.gz')
  await page.keyboard.press('Escape')
  const releaseResponse = await page.request.get('/source/release.json')
  expect(releaseResponse.status()).toBe(200)
  const release = await releaseResponse.json()
  expect(release.applicationVersion).toBe(applicationVersion)
  expect(release.wasmSha256).toBe(wasmEvidence[0].sha256)
  const runtimeUrl = await page.locator('script[type=module][src^="/src/main.tsx"], script[type=module][src^="/assets/"]').getAttribute('src')
  expect(runtimeUrl).toBeTruthy()
  const runtimeResponse = await page.request.get(runtimeUrl!)
  expect(runtimeResponse.status()).toBe(200)
  const runtimeBody = await runtimeResponse.body()
  const runtime = { path: runtimeUrl, bytes: runtimeBody.length, sha256: createHash('sha256').update(runtimeBody).digest('hex') }
  const distribution = { applicationVersion, release, runtime, archives: [] as { path: string; status: number; contentType?: string; contentEncoding?: string; bytes: number; magic: string; sha256: string }[], notices: [] as { path: string; status: number; bytes: number }[] }
  for (const path of ['/source/grava-simples-source.tar.gz', '/source/obs-wasm-source.tar.gz']) {
    const response = await page.request.get(path)
    const body = await response.body()
    const headers = response.headers()
    expect(response.status()).toBe(200)
    expect(headers['content-type']).toMatch(/^application\/gzip/)
    expect(headers['content-encoding']).toBeUndefined()
    expect(body.subarray(0, 2).toString('hex')).toBe('1f8b')
    distribution.archives.push({ path, status: response.status(), contentType: headers['content-type'], contentEncoding: headers['content-encoding'], bytes: body.length, magic: body.subarray(0, 2).toString('hex'), sha256: createHash('sha256').update(body).digest('hex') })
  }
  for (const path of ['/source/COPYING.txt', '/source/OBS-COPYING.txt', '/source/THIRD-PARTY-NOTICES.txt']) {
    const response = await page.request.get(path)
    const text = await response.text()
    expect(response.status()).toBe(200)
    expect(text).toContain(path.endsWith('THIRD-PARTY-NOTICES.txt') ? 'MIT License' : 'GNU GENERAL PUBLIC LICENSE')
    distribution.notices.push({ path, status: response.status(), bytes: Buffer.byteLength(text) })
  }
  await writeFile(resolve(destination, 'distribution-checks.json'), JSON.stringify(distribution, null, 2))
  const layoutVectors = await page.evaluate(() => {
    const compute = (window as any).__recorderTest.computeLayout
    const base = { sourceWidth: 1920, sourceHeight: 1080, cameraWidth: 1280, cameraHeight: 720 }
    return {
      landscape: compute({ ...base, outputWidth: 1280, outputHeight: 720, mode: 'screen-camera', orientation: 'landscape' }),
      portrait: compute({ ...base, outputWidth: 720, outputHeight: 1280, mode: 'screen-camera', orientation: 'portrait' }),
      camera: compute({ ...base, outputWidth: 720, outputHeight: 1280, mode: 'camera', orientation: 'portrait' }),
    }
  })
  const near = (actual: Record<string, number>, expected: Record<string, number>) => {
    for (const [name, value] of Object.entries(expected)) expect(actual[name], name).toBeCloseTo(value, 2)
  }
  near(layoutVectors.landscape.source, { x: 0, y: 0, width: 1280, height: 720 })
  near(layoutVectors.landscape.camera, { x: 931.84, y: 511.84, width: 320, height: 180 })
  near(layoutVectors.portrait.source, { x: 0, y: 79.1, width: 720, height: 405 })
  near(layoutVectors.portrait.camera, { x: 0, y: 588.8, width: 720, height: 691.2, cropX: 265, cropY: 0, cropWidth: 750, cropHeight: 720 })
  near(layoutVectors.camera.source, { x: 0, y: 0, width: 720, height: 1280, cropX: 656.25, cropY: 0, cropWidth: 607.5, cropHeight: 1080 })
  await choose(page, 'source-mode-select', source)
  await choose(page, 'resolution-select', resolution)
  await choose(page, 'fps-select', String(fps))
  await choose(page, 'scene-select', source === 'camera' ? 'camera' : 'screen')
  await page.getByTestId('settings-trigger').click()
  await expect(page.getByTestId('prepare-inputs')).toBeEnabled()
  await page.getByTestId('prepare-inputs').click()
  await waitState(page, 'ready')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('start-recording')).toBeEnabled()
  await page.getByTestId('start-recording').click()
  await waitState(page, 'recording')
  const begun = await snapshot(page)
  const started = Date.now()
  const samples: { elapsedSeconds: number; snapshot: Snapshot }[] = []
  const sceneChanges = resolution === '360'
    ? [{ at: seconds * 0.2, scene: 'camera' }, { at: seconds * 0.4, scene: 'camera-zoom' }, { at: seconds * 0.65, scene: 'screen' }]
    : [{ at: Math.min(seconds / 2, 10), scene: 'camera' }]
  const appliedSceneChanges: { elapsedSeconds: number; scene: string }[] = []
  let nextSceneChange = 0
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(Math.min(resolution === '360' ? 2_000 : 5_000, Math.max(50, seconds * 1000 - (Date.now() - started))))
    const elapsedSeconds = (Date.now() - started) / 1000
    if (source === 'test' && sceneChanges[nextSceneChange] && elapsedSeconds >= sceneChanges[nextSceneChange].at) {
      await choose(page, 'scene-select', sceneChanges[nextSceneChange].scene)
      appliedSceneChanges.push({ elapsedSeconds, scene: sceneChanges[nextSceneChange].scene })
      nextSceneChange++
    }
    const value = await snapshot(page)
    samples.push({ elapsedSeconds, snapshot: value })
    // The growing report survives interruption of an extended soak.
    await writeFile(resolve(destination, 'live-metrics.json'), JSON.stringify({ startedAt: new Date(started).toISOString(), samples }, null, 2))
    expect(value.error).toBeFalsy()
    expect(value.state ?? value.status).toBe('recording')
  }
  await page.screenshot({ path: resolve('.context/screenshots', `recording-${resolution}-${fps}${sourceTag}.png`), fullPage: true })
  await page.getByTestId('stop-recording').click()
  await waitState(page, 'complete')
  if (source === 'test') expect(appliedSceneChanges).toHaveLength(sceneChanges.length)
  const ended = await snapshot(page)
  expect(ended.metrics?.audio).toBe(true)
  expect(ended.engine?.audioNodes).toBeGreaterThan(0)
  expect(ended.engine?.audioBlocks).toBeGreaterThan(0)
  expect(ended.metrics?.frames?.landscape).toBeGreaterThan(0)
  expect(ended.metrics?.frames?.portrait).toBeGreaterThan(0)
  const backend = ended.engine?.backend ?? ended.metrics?.engineBackend
  expect(backend).toBe('obs-wasm-subset')
  const calls = Number(ended.engine?.layoutCalls ?? 0) - Number(begun.engine?.layoutCalls ?? 0)
  expect(calls).toBeGreaterThanOrEqual((ended.metrics?.frames?.landscape ?? 0) + (ended.metrics?.frames?.portrait ?? 0) - 4)
  const playback = []
  for (const orientation of ['landscape', 'portrait']) {
    const player = page.getByTestId(`result-${orientation}`)
    const frame = await player.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true
      await element.play()
      const decoded = await new Promise<{ mediaTime: number; presentedFrames: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Result video did not present a decoded frame')), 15_000)
        element.requestVideoFrameCallback((_now, metadata) => { clearTimeout(timer); resolve({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames }) })
      })
      element.pause()
      return { width: element.videoWidth, height: element.videoHeight, readyState: element.readyState, ...decoded }
    })
    expect(frame.presentedFrames).toBeGreaterThan(0)
    expect(frame.readyState).toBeGreaterThanOrEqual(2)
    playback.push({ orientation, ...frame })
  }
  const downloads: { path: string; width: number; height: number; expectedDurationSec: number; minimumFps?: number; requireContinuousVideo: boolean; requireAudible: boolean; requireDynamic: boolean }[] = []
  const sizes = resolution === '360' ? [[640, 360], [360, 640]] : resolution === '1080' ? [[1920, 1080], [1080, 1920]] : [[3840, 2160], [2160, 3840]]
  for (const [index, id] of ['download-landscape', 'download-portrait'].entries()) {
    const original = page.getByTestId(id)
    if (!await original.isVisible()) await original.locator('xpath=..').locator('summary').click()
    const downloading = page.waitForEvent('download')
    await page.getByTestId(id).click()
    const download = await downloading
    const path = resolve(destination, download.suggestedFilename())
    await download.saveAs(path)
    expect(await download.failure()).toBeNull()
    downloads.push({ path, width: sizes[index][0], height: sizes[index][1], expectedDurationSec: seconds, ...(purpose === 'performance-qualification' || resolution === '360' ? { minimumFps: source === 'camera' && resolution === '360' ? 10 : fps * 0.8 } : {}), requireContinuousVideo: true, requireAudible: true, requireDynamic: true })
  }
  expect(downloads[0].path).not.toBe(downloads[1].path)
  const manifest = { purpose, source: source === 'test' ? 'synthetic animated screen and camera with WebAudio tone' : 'real getUserMedia browser adapter with Chrome fake camera and microphone devices', fps, seconds, recordings: downloads }
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(resolve(destination, 'browser-metrics.json'), JSON.stringify({ begun, ended, layoutCallsDuringRecording: calls, appliedSceneChanges, wasmEvidence, layoutVectors, distribution, playback, samples, errors }, null, 2))
  await page.screenshot({ path: resolve('.context/screenshots', `complete-${resolution}-${fps}${sourceTag}.png`), fullPage: true })
  await page.locator('.results').screenshot({ path: resolve('.context/screenshots', 'studio-ui-recordings.png') })
  const verifier = spawnSync(process.execPath, ['scripts/verify-recordings.mjs', '--manifest', resolve(destination, 'manifest.json'), '--json', resolve(destination, 'verification.json')], { encoding: 'utf8', timeout: Math.max(120_000, seconds * 1000) })
  console.log(verifier.stdout)
  expect(verifier.stderr, verifier.stdout).toBe('')
  expect(verifier.status, verifier.stdout + verifier.stderr).toBe(0)
  expect(errors).toEqual([])
  if (resolution === '360' && source === 'test') {
    await expect.poll(async () => ((await snapshot(page)).takes as { id: string }[] | undefined)?.length ?? 0).toBe(1)
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: /^Gravações/ }).click()
    await expect(page.locator('.take-card')).toHaveCount(1)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /^Gravações/ }).click()
    await page.locator('.take-card .take-cover').click()
    await expect(page.getByTestId('recording-detail')).toBeVisible()
    const formats = page.getByRole('tablist', { name: 'Formato do vídeo' })
    for (const [orientation, label] of [['landscape', 'Horizontal'], ['portrait', 'Vertical']] as const) {
      await formats.getByRole('tab', { name: label, exact: true }).click()
      await expect.poll(async () => page.getByTestId(`recording-video-${orientation}`).evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0)
    }
    await writeFile(resolve(destination, 'project-library-reload.json'), JSON.stringify({ passed: true, snapshot: await snapshot(page) }, null, 2))
  }
}

test('two independently playable files, live scene change, actual Wasm, and audible audio at 360p', async ({ page }) => {
  await recordPair(page, '360', 30, Number(process.env.RECORDING_SMOKE_SECONDS ?? 12))
})

test('1080p motion regression: synthetic outputs keep moving through their final five seconds', async ({ page }) => {
  await recordPair(page, '1080', 30, Number(process.env.RECORDING_REGRESSION_SECONDS ?? 20))
})

test('1080p motion regression: camera and microphone outputs keep moving through their final five seconds', async ({ page }) => {
  await recordPair(page, '1080', 30, Number(process.env.RECORDING_REGRESSION_SECONDS ?? 20), 'camera')
})

test('dual1080p30 performance qualification preserves the requested frame-rate threshold', async ({ page }) => {
  test.skip(process.env.RUN_PERFORMANCE_QUALIFICATION !== '1', 'Enable explicitly with RUN_PERFORMANCE_QUALIFICATION=1')
  await recordPair(page, '1080', 30, Number(process.env.RECORDING_SOAK_SECONDS ?? 20), 'test', 'performance-qualification')
})

test('optional 4K60 resource probe', async ({ page }) => {
  test.skip(process.env.RUN_4K_PROBE !== '1', 'Enable explicitly with RUN_4K_PROBE=1')
  await recordPair(page, '4k', 60, 12, 'test', 'performance-qualification')
})

test('camera and microphone adapters produce two playable files using Chrome fake devices', async ({ page }) => {
  await recordPair(page, '360', 30, 8, 'camera')
})
