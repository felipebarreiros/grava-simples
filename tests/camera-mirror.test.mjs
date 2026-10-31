import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

async function withBrowser(callback) {
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/__camera-mirror-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Camera mirroring regression</title>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__camera-mirror-test`);
    await page.mouse.click(10, 10);
    return await callback(page);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const near = (actual, expected) => actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8);
const mirrored = pair => near(pair.left, [0, 0, 255]) && near(pair.right, [255, 0, 0]);
const readable = pair => near(pair.left, [255, 0, 0]) && near(pair.right, [0, 0, 255]);

test('live cameras follow movement in both mobile outputs and thumbnails while uploaded media keeps its orientation', { timeout: 60_000 }, async () => {
  const result = await withBrowser(page => page.evaluate(async () => {
    const { StudioSession } = await import('/src/media/StudioSession.ts');
    const { defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
    const { loadObsEngine } = await import('/engine/obs-engine.js');
    const session = new StudioSession({ engine: await loadObsEngine() });
    const outputs = { landscape: document.createElement('canvas'), portrait: document.createElement('canvas') };
    session.attachCanvases(outputs);
    const source = document.createElement('canvas'); source.width = 640; source.height = 480;
    const sourceContext = source.getContext('2d');
    const paint = () => {
      sourceContext.fillStyle = '#ff0000'; sourceContext.fillRect(0, 0, 320, 480);
      sourceContext.fillStyle = '#0000ff'; sourceContext.fillRect(320, 0, 320, 480);
    };
    paint();
    const streams = [], requests = [];
    // Every newly attached stream receives fresh frames, even when the fixture
    // pixels are static. Assertions wait on decoded output rather than a delay.
    const delivery = setInterval(() => { paint(); streams.forEach(stream => stream.getVideoTracks()[0]?.requestFrame?.()); }, 30);
    const originalCapture = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async options => {
      requests.push(options);
      const stream = source.captureStream(30); streams.push(stream); return stream;
    };
    const pair = canvas => {
      const context = canvas.getContext('2d');
      const pixel = x => [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1).data].slice(0, 3);
      return { left: pixel(.25), right: pixel(.75) };
    };
    const colors = () => Object.fromEntries(Object.entries(outputs).map(([orientation, canvas]) => [orientation, pair(canvas)]));
    const waitForPixels = async reversed => {
      const start = performance.now();
      const near = (actual, expected) => actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8);
      while (performance.now() - start < 6000) {
        const samples = colors();
        if (Object.values(samples).every(value => near(value.left, reversed ? [0, 0, 255] : [255, 0, 0]) && near(value.right, reversed ? [255, 0, 0] : [0, 0, 255]))) return samples;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error(`Camera pixels did not acquire the requested orientation: ${JSON.stringify(colors())}`);
    };
    const appearance = defaultSceneAppearance('camera');
    appearance.layers.find(layer => layer.kind === 'camera').sourceId = 'primary-camera';
    try {
      await session.prepare({ source: 'camera', cameraSourceId: 'primary-camera', layout: 'camera', resolution: '360', fps: 30, microphone: false, appearance });
      const primary = await waitForPixels(true);
      const thumbnails = Object.fromEntries(['landscape', 'portrait'].map(orientation => {
        const canvas = document.createElement('canvas'); canvas.width = orientation === 'landscape' ? 240 : 135; canvas.height = orientation === 'landscape' ? 135 : 240;
        const rendered = session.renderSceneToCanvas(canvas, { layout: 'camera', appearance, orientation });
        return [orientation, { rendered, ...pair(canvas) }];
      }));
      await session.replaceCamera('replacement-camera');
      const replaced = await waitForPixels(true);
      const extraAppearance = structuredClone(appearance);
      extraAppearance.layers.find(layer => layer.kind === 'camera').sourceId = 'extra-camera';
      session.setSceneAppearance(extraAppearance);
      await session.captureLayerCamera('extra-camera');
      const extra = await waitForPixels(true);
      const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
      await session.setLayerMediaSource('extra-camera', new File([blob], 'asymmetric-image.png', { type: 'image/png' }));
      const uploaded = await waitForPixels(false);
      return { primary, thumbnails, replaced, extra, uploaded, requests };
    } finally {
      clearInterval(delivery);
      navigator.mediaDevices.getUserMedia = originalCapture;
      await session.dispose(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    }
  }));
  for (const group of ['primary', 'replaced', 'extra']) for (const [orientation, pixels] of Object.entries(result[group])) {
    assert.ok(mirrored(pixels), `${group} camera is mirrored in ${orientation}: ${JSON.stringify(pixels)}`);
  }
  for (const [orientation, pixels] of Object.entries(result.thumbnails)) {
    assert.equal(pixels.rendered, true);
    assert.ok(mirrored(pixels), `${orientation} thumbnail follows the live camera`);
  }
  for (const [orientation, pixels] of Object.entries(result.uploaded)) assert.ok(readable(pixels), `An image assigned to a camera layer keeps its original orientation in ${orientation}`);
  assert.equal(result.requests.length, 3, 'Preparation, camera replacement and extra camera each request their own capture');
  assert.ok(result.requests.every(options => options.audio === false), 'The visual regression does not request a microphone');
});

test('mirroring preserves camera crops and shapes without flipping the screen or moving the presentation fade', { timeout: 30_000 }, async () => {
  const result = await withBrowser(page => page.evaluate(async () => {
    const { SceneCompositor, defaultSceneAppearance, resolveLayerBounds } = await import('/src/media/SceneCompositor.ts');
    const { loadObsEngine } = await import('/engine/obs-engine.js');
    const engine = await loadObsEngine(), compositor = new SceneCompositor();
    const source = document.createElement('canvas'); source.width = 640; source.height = 480;
    const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#ff0000'; sourceContext.fillRect(0, 0, 320, 480); sourceContext.fillStyle = '#0000ff'; sourceContext.fillRect(320, 0, 320, 480);
    const camera = { element: source, width: 640, height: 480, mirrorX: true };
    const screen = { element: source, width: 640, height: 480 };
    const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
    const shapes = [];
    for (const orientation of ['landscape', 'portrait']) for (const shape of ['rectangle', 'rounded', 'circle']) {
      const canvas = document.createElement('canvas'); canvas.width = orientation === 'landscape' ? 640 : 360; canvas.height = orientation === 'landscape' ? 360 : 640;
      const context = canvas.getContext('2d'), appearance = defaultSceneAppearance('camera');
      appearance.cameraShape = shape; appearance.cameraBorderWidth = shape === 'rectangle' ? 0 : 8; appearance.cameraShadow = shape !== 'rectangle';
      const layer = appearance.layers.find(layer => layer.kind === 'camera');
      layer.frames = { [orientation]: { x: .2, y: .2, width: .6, height: .6 } };
      const input = { layout: 'camera', appearance, orientation, zoom: 1.6, remainingSeconds: 0, camera, engine };
      const rect = resolveLayerBounds(layer, input, canvas.width, canvas.height);
      let sourceReads = 0; const originalDraw = context.drawImage.bind(context);
      context.drawImage = (...args) => { if (args[0] === source) sourceReads++; return originalDraw(...args); };
      compositor.render(context, canvas.width, canvas.height, input);
      shapes.push({ orientation, shape, sourceReads, left: pixel(canvas, rect.x + rect.width * .25, rect.y + rect.height / 2), right: pixel(canvas, rect.x + rect.width * .75, rect.y + rect.height / 2), outside: pixel(canvas, 0, 0) });
    }
    const presentation = {};
    for (const orientation of ['landscape', 'portrait']) {
      const canvas = document.createElement('canvas'); canvas.width = orientation === 'landscape' ? 640 : 360; canvas.height = orientation === 'landscape' ? 360 : 640;
      const appearance = defaultSceneAppearance('screen-3d');
      compositor.render(canvas.getContext('2d'), canvas.width, canvas.height, { layout: 'screen-3d', appearance, orientation, zoom: 1, remainingSeconds: 0, camera, screen, engine });
      presentation[orientation] = orientation === 'landscape'
        ? { screen: { left: pixel(canvas, 80, 120), right: pixel(canvas, 330, 120) }, camera: { left: pixel(canvas, 430, 20), right: pixel(canvas, 600, 20) }, fade: [307, 325, 350, 395].map(x => pixel(canvas, x, 20)[2]) }
        : { screen: { left: pixel(canvas, 90, 100), right: pixel(canvas, 270, 100) }, camera: { left: pixel(canvas, 90, 500), right: pixel(canvas, 270, 500) } };
    }
    compositor.clear(); return { shapes, presentation };
  }));
  for (const shape of result.shapes) {
    assert.ok(mirrored(shape), `${shape.shape} camera mirrors its cropped source in ${shape.orientation}: ${JSON.stringify(shape)}`);
    assert.equal(shape.sourceReads, 1, 'Mirroring does not add another camera copy');
    assert.deepEqual(shape.outside, [8, 11, 17], 'Camera transforms do not move the surrounding composition');
  }
  for (const [orientation, composition] of Object.entries(result.presentation)) {
    assert.ok(readable(composition.screen), `The ${orientation} presentation slide retains its reading direction`);
    assert.ok(mirrored(composition.camera), `The ${orientation} presentation camera is mirrored independently`);
  }
  const fade = result.presentation.landscape.fade;
  assert.ok(fade[0] < 25 && fade[0] < fade[1] && fade[1] < fade[2] && fade[2] < fade[3], `The fade still blends the left camera edge: ${JSON.stringify(fade)}`);
});
