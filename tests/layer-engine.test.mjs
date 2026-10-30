import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { verifyRecording } from '../scripts/verify-recordings.mjs';
const destination = resolve('.context/results/layer-engine');
const ffmpeg = process.env.FFMPEG ?? resolve('.context/tools/node_modules/ffmpeg-static/ffmpeg');

test('independent layers, source ownership, timer controls and pre-mute metering preserve actual outputs', { timeout: 120_000 }, async () => {
  await mkdir(destination, { recursive: true });
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); const address = server.httpServer.address();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.route('**/__layer-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Layer engine regression</title>' }));
    await page.goto(`http://127.0.0.1:${address.port}/__layer-test`);
    const visuals = await page.evaluate(async () => {
      const { StudioSession } = await import('/src/media/StudioSession.ts');
      const { SceneCompositor, defaultSceneAppearance, normalizeSceneAppearance } = await import('/src/media/SceneCompositor.ts');
      const { loadObsEngine } = await import('/engine/obs-engine.js');
      const engine = await loadObsEngine(); const session = new StudioSession({ engine });
      const outputs = { landscape: document.createElement('canvas'), portrait: document.createElement('canvas') }; session.attachCanvases(outputs);
      const solid = (w, h, color) => { const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, w, h); return canvas; };
      const file = async (canvas, name) => new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], name, { type: 'image/png' });
      const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); let hardwareRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { hardwareRequests++; throw new Error('Image-only scene requested a camera'); };
      try {
        const earlyDisplayCanvas = solid(320, 180, '#ffaa00'), earlyDisplayStream = earlyDisplayCanvas.captureStream(30); let earlyDisplayRequests = 0;
        navigator.mediaDevices.getDisplayMedia = async () => { earlyDisplayRequests++; return earlyDisplayStream; };
        const earlyPending = session.captureLayerScreen('early-source'); const earlyChooserImmediate = earlyDisplayRequests === 1; await earlyPending;
        const beforePrepareSource = session.hasLayerSource('early-source');
        await session.setLayerMediaSource('red-source', await file(solid(400, 100, '#ff0000'), 'wide.png'));
        await session.setLayerMediaSource('blue-source', await file(solid(100, 400, '#0000ff'), 'tall.png'));
        let appearance = { ...defaultSceneAppearance('countdown'), countdownSeconds: 0, layers: [
          { id: 'background', kind: 'background', visible: true, name: 'Fundo', color: '#101010' },
          { id: 'red', kind: 'screen', visible: true, name: 'Imagem larga', sourceId: 'red-source', frames: { landscape: { x: .05, y: .05, width: .35, height: .25 }, portrait: { x: .05, y: .1, width: .9, height: .2 } } },
          { id: 'blue', kind: 'screen', visible: true, name: 'Imagem alta', sourceId: 'blue-source', frames: { landscape: { x: .65, y: .6, width: .25, height: .35 }, portrait: { x: .3, y: .55, width: .4, height: .4 } } },
          { id: 'title-a', kind: 'title', visible: true, name: 'Texto A', text: 'Alfa', fontSize: 64, color: '#ffffff', align: 'left', frames: { landscape: { x: .05, y: .35, width: .4, height: .15 } } },
          { id: 'title-b', kind: 'title', visible: true, name: 'Texto B', text: 'Beta', fontSize: 96, color: '#ff4000', align: 'right', frames: { landscape: { x: .45, y: .35, width: .4, height: .15 } } },
        ] };
        await session.prepare({ source: 'camera', layout: 'camera', resolution: '360', fps: 30, microphone: false, appearance });
        const context = outputs.landscape.getContext('2d'), originalDraw = context.drawImage.bind(context), originalText = context.fillText.bind(context);
        const drawn = [], texts = [];
        context.drawImage = (...args) => { if (args[0] instanceof HTMLCanvasElement && ((args[0].width === 400 && args[0].height === 100) || (args[0].width === 100 && args[0].height === 400))) drawn.push({ source: [args[0].width, args[0].height], destination: args.slice(5, 9) }); return originalDraw(...args); };
        context.fillText = (...args) => { if (args[0] === 'Alfa' || args[0] === 'Beta') texts.push({ text: args[0], color: context.fillStyle, font: context.font, x: args[1] }); return originalText(...args); };
        session.setSceneAppearance(appearance);
        const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
        const bothImages = { red: pixel(144, 63), blue: pixel(496, 279) };
        const bounds = session.getLayerBounds('landscape');
        const hidden = structuredClone(appearance); hidden.layers.find(layer => layer.id === 'red').visible = false;
        session.setSceneAppearance(hidden); const hiddenRed = pixel(144, 63), blueWhileRedHidden = pixel(496, 279);
        session.setSceneAppearance(appearance);
        await session.start(); await new Promise(resolve => setTimeout(resolve, 2100)); const mediaResult = await session.stop();
        const mediaFiles = await Promise.all(['landscape', 'portrait'].map(async orientation => ({ orientation, bytes: [...new Uint8Array(await mediaResult[orientation].blob.arrayBuffer())] })));
        const displayCanvas = solid(400, 200, '#00ff00'), displayStream = displayCanvas.captureStream(30); let displayRequests = 0;
        navigator.mediaDevices.getDisplayMedia = async () => { displayRequests++; return displayStream; };
        appearance.layers.push({ id: 'display', kind: 'screen', name: 'Tela independente', visible: true, sourceId: 'display-source', frames: { landscape: { x: .45, y: .05, width: .2, height: .25 } } });
        session.setSceneAppearance(appearance); const capturing = session.captureLayerScreen('display-source'); const chooserInvokedBeforeAwait = displayRequests === 1; await capturing;
        const displayPixel = pixel(352, 63);
        await session.prepare({ source: 'camera', layout: 'countdown', resolution: '360', fps: 30, microphone: false, appearance });
        const survivesPrepare = { red: session.hasLayerSource('red-source'), blue: session.hasLayerSource('blue-source'), display: session.hasLayerSource('display-source'), displayTrack: displayStream.getVideoTracks()[0].readyState, displayRequests, redPixel: pixel(144, 63), bluePixel: pixel(496, 279), greenPixel: pixel(352, 63), statuses: session.getSnapshot().metrics.layerSources };
        const zeroInitial = session.getSnapshot().countdown; session.resumeCountdown(); const resumeZero = session.getSnapshot().countdown;
        session.setSceneAppearance({ ...appearance, countdownSeconds: 5 }); session.resumeCountdown(); await new Promise(resolve => setTimeout(resolve, 1100));
        const running = session.getSnapshot().countdown; session.resetCountdown(); const reset = session.getSnapshot().countdown; await new Promise(resolve => setTimeout(resolve, 1100)); const resetStillPaused = session.getSnapshot().countdown;
        session.resumeCountdown(); session.zeroCountdown(); const zeroed = session.getSnapshot().countdown; session.resetCountdown(); const restoredDuration = session.getSnapshot().countdown;
        session.removeLayerSource('red-source'); const removed = { hasRed: session.hasLayerSource('red-source'), hasBlue: session.hasLayerSource('blue-source'), redPixel: pixel(144, 63), bluePixel: pixel(496, 279) };
        const ghost = document.createElement('canvas'); ghost.width = 100; ghost.height = 100; const ghostContext = ghost.getContext('2d'); ghostContext.fillStyle = '#ff0000'; ghostContext.fillRect(0, 0, 100, 100);
        const compositor = new SceneCompositor(); const partial = { ...defaultSceneAppearance('camera'), layers: [{ id: 'half', kind: 'background', name: 'Half', visible: true, color: '#00ff00', frames: { landscape: { x: 0, y: 0, width: .5, height: 1 } } }] };
        const renderGhost = () => compositor.render(ghostContext, 100, 100, { layout: 'camera', appearance: partial, orientation: 'landscape', zoom: 1, remainingSeconds: 0, engine });
        renderGhost(); const firstGhost = [...ghostContext.getImageData(75, 50, 1, 1).data].slice(0, 3); partial.layers[0].frames.landscape.x = .5; renderGhost(); const movedGhost = [...ghostContext.getImageData(25, 50, 1, 1).data].slice(0, 3);
        return { mediaFiles, earlyChooserImmediate, beforePrepareSource, hardwareRequests, bothImages, hiddenRed, blueWhileRedHidden, bounds, drawn: drawn.slice(0, 2), texts: texts.slice(0, 2), displayPixel, chooserInvokedBeforeAwait, survivesPrepare, zeroInitial, resumeZero, running, reset, resetStillPaused, zeroed, restoredDuration, removed, firstGhost, movedGhost, normalizedLayers: normalizeSceneAppearance('countdown', appearance).layers };
      } finally { navigator.mediaDevices.getUserMedia = originalCapture; await session.dispose(); }
    });
    const normalMediaRecordings = [];
    for (const file of visuals.mediaFiles) {
      const path = resolve(destination, `normal-media-${file.orientation}.mp4`); await writeFile(path, new Uint8Array(file.bytes));
      const decoded = verifyRecording({ path, width: file.orientation === 'landscape' ? 640 : 360, height: file.orientation === 'landscape' ? 360 : 640, expectedDurationSec: 2.1, minimumFps: 24, requireAudible: false });
      assert.equal(decoded.passed, true, decoded.failures.join('\n')); assert.ok(decoded.continuity.maximumFrameGapSeconds <= .5);
      normalMediaRecordings.push(decoded);
    }
    delete visuals.mediaFiles;
    await writeFile(resolve(destination, 'visuals-and-timer.json'), JSON.stringify({ ...visuals, normalMediaRecordings }, null, 2));
    assert.equal(visuals.earlyChooserImmediate, true); assert.equal(visuals.beforePrepareSource, true);
    assert.equal(visuals.hardwareRequests, 0);
    assert.deepEqual(visuals.bothImages, { red: [255, 0, 0], blue: [0, 0, 255] });
    assert.notDeepEqual(visuals.hiddenRed, [255, 0, 0]); assert.deepEqual(visuals.blueWhileRedHidden, [0, 0, 255]);
    assert.deepEqual(visuals.bounds.red, { x: .05, y: .05, width: .35, height: .25 });
    assert.equal(visuals.drawn.length, 2);
    for (const drawn of visuals.drawn) assert.ok(Math.abs(drawn.source[0] / drawn.source[1] - drawn.destination[2] / drawn.destination[3]) < .00001, 'imported media was stretched');
    assert.equal(visuals.texts.length, 2); assert.deepEqual(visuals.texts.map(value => value.text), ['Alfa', 'Beta']); assert.deepEqual(visuals.texts.map(value => value.color), ['#ffffff', '#ff4000']); assert.notEqual(visuals.texts[0].font, visuals.texts[1].font);
    assert.equal(visuals.chooserInvokedBeforeAwait, true); assert.deepEqual(visuals.displayPixel, [0, 255, 0]);
    assert.equal(visuals.survivesPrepare.red, true); assert.equal(visuals.survivesPrepare.blue, true); assert.equal(visuals.survivesPrepare.display, true); assert.equal(visuals.survivesPrepare.displayTrack, 'live'); assert.equal(visuals.survivesPrepare.displayRequests, 1);
    assert.deepEqual(visuals.survivesPrepare.redPixel, [255, 0, 0]); assert.deepEqual(visuals.survivesPrepare.bluePixel, [0, 0, 255]); assert.deepEqual(visuals.survivesPrepare.greenPixel, [0, 255, 0]);
    assert.deepEqual(visuals.zeroInitial, { remainingSeconds: 0, running: false }); assert.deepEqual(visuals.resumeZero, visuals.zeroInitial); assert.equal(visuals.running.running, true); assert.equal(visuals.running.remainingSeconds, 4);
    assert.deepEqual(visuals.reset, { remainingSeconds: 5, running: false }); assert.deepEqual(visuals.resetStillPaused, visuals.reset); assert.deepEqual(visuals.zeroed, { remainingSeconds: 0, running: false }); assert.deepEqual(visuals.restoredDuration, visuals.reset);
    assert.equal(visuals.removed.hasRed, false); assert.equal(visuals.removed.hasBlue, true); assert.notDeepEqual(visuals.removed.redPixel, [255, 0, 0]); assert.deepEqual(visuals.removed.bluePixel, [0, 0, 255]);
    assert.deepEqual(visuals.firstGhost, [8, 11, 17]); assert.deepEqual(visuals.movedGhost, [8, 11, 17]);
    assert.equal(visuals.normalizedLayers.filter(layer => layer.kind === 'title').length, 2); assert.equal(visuals.normalizedLayers.filter(layer => layer.kind === 'screen').length, 3);
    const audio = await page.evaluate(async () => {
      const { StudioSession } = await import('/src/media/StudioSession.ts'); const { defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts'); const { loadObsEngine } = await import('/engine/obs-engine.js');
      const session = new StudioSession({ engine: await loadObsEngine() }); session.attachCanvases({ landscape: document.createElement('canvas'), portrait: document.createElement('canvas') });
      try {
        await session.prepare({ source: 'test', layout: 'camera', resolution: '360', fps: 30, appearance: defaultSceneAppearance('camera') }); await new Promise(resolve => setTimeout(resolve, 250));
        const unmuted = session.getSnapshot(); session.setMicrophoneMuted(true); await new Promise(resolve => setTimeout(resolve, 250)); const muted = session.getSnapshot(); const mutedAppearance = structuredClone(muted.appearance);
        session.setSceneAppearance({ ...defaultSceneAppearance('camera'), microphoneGainDb: -12 }); await new Promise(resolve => setTimeout(resolve, 250)); const quieter = session.getSnapshot();
        session.setSceneAppearance(mutedAppearance); await new Promise(resolve => setTimeout(resolve, 250)); const restored = session.getSnapshot();
        await session.start(); await new Promise(resolve => setTimeout(resolve, 3500)); const result = await session.stop();
        const files = await Promise.all(['landscape', 'portrait'].map(async orientation => ({ orientation, bytes: [...new Uint8Array(await result[orientation].blob.arrayBuffer())] })));
        return { unmuted: { raw: unmuted.metrics.rawMicLevelDb, post: unmuted.metrics.audioLevelDb }, muted: { raw: muted.metrics.rawMicLevelDb, post: muted.metrics.audioLevelDb, appearance: muted.appearance }, quieter: { raw: quieter.metrics.rawMicLevelDb, post: quieter.metrics.audioLevelDb, controls: quieter.controls }, restored: { raw: restored.metrics.rawMicLevelDb, post: restored.metrics.audioLevelDb, controls: restored.controls }, files };
      } finally { await session.dispose(); }
    });
    assert.ok(audio.unmuted.raw > -40 && audio.unmuted.post > -40); assert.ok(audio.muted.raw > -40); assert.equal(audio.muted.post, -100); assert.equal(audio.muted.appearance.microphoneMuted, true);
    assert.ok(audio.quieter.post < audio.quieter.raw - 10 && audio.quieter.post > audio.quieter.raw - 14); assert.equal(audio.quieter.controls.microphoneGainDb, -12); assert.equal(audio.restored.post, -100); assert.equal(audio.restored.controls.microphoneMuted, true);
    const recordings = [];
    for (const file of audio.files) {
      const path = resolve(destination, `muted-${file.orientation}.mp4`); await writeFile(path, new Uint8Array(file.bytes));
      const decoded = verifyRecording({ path, width: file.orientation === 'landscape' ? 640 : 360, height: file.orientation === 'landscape' ? 360 : 640, expectedDurationSec: 3.5, minimumFps: 24, requireAudible: false, requireContinuousVideo: true }); assert.equal(decoded.passed, true, decoded.failures.join('\n'));
      const pcm = spawnSync(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'f32le', '-'], { maxBuffer: 16 * 1024 * 1024 }); assert.equal(pcm.status, 0, String(pcm.stderr));
      let peak = 0; for (let offset = 0; offset + 4 <= pcm.stdout.length; offset += 4) peak = Math.max(peak, Math.abs(pcm.stdout.readFloatLE(offset)));
      assert.ok(peak <= .000001, `muted microphone leaked audio peak ${peak}`); recordings.push({ orientation: file.orientation, peakDecodedSample: peak, ...decoded });
    }
    delete audio.files; await writeFile(resolve(destination, 'mute-and-gain.json'), JSON.stringify({ audio, recordings, passed: true }, null, 2));
  } finally { await browser?.close(); await server.close(); }
});

test('legacy and registered background images move and resize with their own layer frame', { timeout: 30_000 }, async () => {
  await mkdir(destination, { recursive: true });
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen(); const address = server.httpServer.address();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const page = await browser.newPage(); await page.route('**/__background-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Background geometry</title>' }));
    await page.goto(`http://127.0.0.1:${address.port}/__background-test`);
    const result = await page.evaluate(async () => {
      const { SceneCompositor, defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts'); const { loadObsEngine } = await import('/engine/obs-engine.js');
      const engine = await loadObsEngine(), compositor = new SceneCompositor();
      const image = document.createElement('canvas'); image.width = 100; image.height = 100; const source = image.getContext('2d');
      for (const [color, x, y] of [['#ff0000', 0, 0], ['#00ff00', 50, 0], ['#ffff00', 0, 50], ['#0000ff', 50, 50]]) { source.fillStyle = color; source.fillRect(x, y, 50, 50); }
      const output = document.createElement('canvas'); output.width = 100; output.height = 100; const context = output.getContext('2d', { willReadFrequently: true });
      const layer = { id: 'background', kind: 'background', visible: true, name: 'Fundo', frames: { landscape: { x: .5, y: .5, width: .5, height: .5 } } };
      const appearance = { ...defaultSceneAppearance('camera'), layers: [layer] };
      const input = { layout: 'camera', appearance, orientation: 'landscape', zoom: 1, remainingSeconds: 0, background: image, engine };
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
      compositor.render(context, 100, 100, input);
      const legacy = { topLeftOfMovedImage: pixel(62, 62), bottomRightOfMovedImage: pixel(87, 87), outside: pixel(25, 25) };
      compositor.render(context, 100, 100, { ...input, background: null, layerSources: { background: { element: image, width: 100, height: 100 } } });
      const registered = { topLeftOfMovedImage: pixel(62, 62), bottomRightOfMovedImage: pixel(87, 87), outside: pixel(25, 25) };
      layer.frames.landscape.x = 0; layer.frames.landscape.y = 0;
      compositor.render(context, 100, 100, input);
      const movedAgain = { topLeft: pixel(12, 12), bottomRight: pixel(37, 37), oldLocation: pixel(87, 87) };
      return { legacy, registered, movedAgain };
    });
    assert.deepEqual(result.legacy, { topLeftOfMovedImage: [255, 0, 0], bottomRightOfMovedImage: [0, 0, 255], outside: [8, 11, 17] });
    assert.deepEqual(result.registered, result.legacy); assert.deepEqual(result.movedAgain, { topLeft: [255, 0, 0], bottomRight: [0, 0, 255], oldLocation: [8, 11, 17] });
    await writeFile(resolve(destination, 'background-geometry.json'), JSON.stringify({ ...result, passed: true }, null, 2));
  } finally { await browser?.close(); await server.close(); }
});
