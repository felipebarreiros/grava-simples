import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const destination = resolve('.context/results/live-screen');
const ffprobe = process.env.FFPROBE ?? resolve('.context/tools/node_modules/ffprobe-static/bin/linux/x64/ffprobe');

async function withBrowser(callback) {
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.route('**/__live-screen-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Live screen regression</title>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__live-screen-test`);
    return await callback(page);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test('a shared live video is copied once per output pair and advances without mixing crops or sources', { timeout: 60_000 }, async () => {
  const result = await withBrowser(page => page.evaluate(async () => {
    const { SceneCompositor, defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
    const { loadObsEngine } = await import('/engine/obs-engine.js');
    const engine = await loadObsEngine(), compositor = new SceneCompositor();
    const streams = [], videos = [], copies = [];
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    const make = (width, height) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; };
    const sourceCanvas = make(3840, 2160), sourceContext = sourceCanvas.getContext('2d');
    const paintHalves = () => { sourceContext.fillStyle = '#ff0000'; sourceContext.fillRect(0, 0, 1920, 2160); sourceContext.fillStyle = '#0000ff'; sourceContext.fillRect(1920, 0, 1920, 2160); };
    const live = async canvas => {
      const stream = canvas.captureStream(30), video = document.createElement('video');
      streams.push(stream); videos.push(video); video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      return { element: video, width: video.videoWidth, height: video.videoHeight };
    };
    const nextFrame = (video, paint) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Live display did not deliver its changed frame.')), 5000);
      let delivered = 0;
      const changed = () => {
        if (++delivered === 2) { clearTimeout(timeout); resolve(); return; }
        video.requestVideoFrameCallback(changed);
        paint(); video.srcObject.getVideoTracks()[0].requestFrame?.();
      };
      // A frame already queued by play() can arrive before the newly painted one.
      video.requestVideoFrameCallback(changed);
      paint();
      video.srcObject.getVideoTracks()[0].requestFrame?.();
    });
    const outputs = { landscape: make(640, 360), portrait: make(360, 640) };
    const appearance = defaultSceneAppearance('screen-3d');
    appearance.layers = appearance.layers.filter(layer => layer.kind !== 'camera');
    const pair = (screen, frameId, localAppearance = appearance, layerSources) => {
      for (const orientation of ['landscape', 'portrait']) {
        const canvas = outputs[orientation];
        compositor.render(canvas.getContext('2d'), canvas.width, canvas.height, { layout: 'screen-3d', appearance: localAppearance, orientation, zoom: 1, remainingSeconds: 0, engine, screen, frameId, layerSources });
      }
    };
    const pixel = (orientation, x, y) => [...outputs[orientation].getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
    const colors = () => ({ landscapeLeft: pixel('landscape', 100, 126), landscapeRight: pixel('landscape', 320, 126), portraitLeft: pixel('portrait', 70, 55), portraitRight: pixel('portrait', 290, 55) });
    try {
      paintHalves();
      const screen = await live(sourceCanvas);
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (videos.includes(args[0])) copies.push({ video: videos.indexOf(args[0]), crop: args.slice(1, 5), stage: [this.canvas.width, this.canvas.height] });
        return originalDraw.apply(this, args);
      };
      pair(screen, 1);
      const first = { copies: copies.length, colors: colors(), stage: copies[0].stage };
      await nextFrame(screen.element, () => { sourceContext.fillStyle = '#00ff00'; sourceContext.fillRect(0, 0, 3840, 2160); });
      pair(screen, 1);
      const sameFrame = { copies: copies.length, colors: colors() };
      pair(screen, 2);
      const advanced = { copies: copies.length, colors: colors() };

      const secondCanvas = make(640, 480), secondContext = secondCanvas.getContext('2d');
      secondContext.fillStyle = '#ff00ff'; secondContext.fillRect(0, 0, 640, 480);
      const replacement = await live(secondCanvas);
      const bound = structuredClone(appearance); bound.layers.find(layer => layer.kind === 'screen').sourceId = 'shared-display';
      pair(undefined, 3, bound, { 'shared-display': screen });
      const beforeReplacement = colors();
      pair(undefined, 3, bound, { 'shared-display': replacement });
      const replaced = { colors: colors(), copies: copies.filter(copy => copy.video === 1).length };

      await nextFrame(screen.element, paintHalves);
      const cropped = structuredClone(appearance);
      cropped.layers = [cropped.layers[0],
        { id: 'tall', kind: 'screen', name: 'Narrow crop', visible: true, sourceId: 'shared-display', fit: 'cover', frames: { landscape: { x: .03, y: .05, width: .2, height: .8 } } },
        { id: 'wide', kind: 'screen', name: 'Wide crop', visible: true, sourceId: 'shared-display', fit: 'cover', frames: { landscape: { x: .35, y: .15, width: .5, height: .1 } } },
      ];
      const beforeCropCopies = copies.length;
      compositor.render(outputs.landscape.getContext('2d'), 640, 360, { layout: 'screen-3d', appearance: cropped, orientation: 'landscape', zoom: 1, remainingSeconds: 0, engine, frameId: 4, layerSources: { 'shared-display': screen } });
      return { first, sameFrame, advanced, beforeReplacement, replaced, cropCopies: copies.slice(beforeCropCopies) };
    } finally {
      CanvasRenderingContext2D.prototype.drawImage = originalDraw;
      compositor.clear(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); videos.forEach(video => { video.pause(); video.srcObject = null; });
    }
  }));
  const near = (actual, expected) => actual.every((channel, index) => Math.abs(channel - expected[index]) <= 8);
  assert.equal(result.first.copies, 1, 'Both orientations share one video conversion');
  assert.ok(Math.max(...result.first.stage) <= 640, 'A retina display is staged only at the output resolution');
  assert.ok(Math.abs(result.first.stage[0] / result.first.stage[1] - 16 / 9) < .01, 'Staging preserves the source aspect ratio');
  assert.ok(near(result.first.colors.landscapeLeft, [255, 0, 0]) && near(result.first.colors.landscapeRight, [0, 0, 255]));
  assert.ok(near(result.first.colors.portraitLeft, [255, 0, 0]) && near(result.first.colors.portraitRight, [0, 0, 255]));
  assert.equal(result.sameFrame.copies, 1, 'Repeated use of one compositor frame keeps its snapshot');
  assert.deepEqual(result.sameFrame.colors, result.first.colors);
  assert.equal(result.advanced.copies, 2, 'A subsequent frame copies the changed live video');
  assert.ok(Object.values(result.advanced.colors).every(color => near(color, [0, 255, 0])));
  assert.ok(Object.values(result.beforeReplacement).every(color => near(color, [0, 255, 0])));
  assert.equal(result.replaced.copies, 1, 'A replacement video has its own frame cache');
  assert.ok(Object.values(result.replaced.colors).every(color => near(color, [255, 0, 255])));
  assert.equal(result.cropCopies.length, 2, 'Different crops of the same live input stay independent');
  assert.notDeepEqual(result.cropCopies[0].crop, result.cropCopies[1].crop);
  for (const copy of result.cropCopies) {
    assert.ok(Math.max(...copy.stage) <= 640);
    assert.ok(Math.abs(copy.stage[0] / copy.stage[1] - copy.crop[2] / copy.crop[3]) < .015, 'Each cropped stage retains its aspect ratio');
  }
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, 'live-frame-cache.json'), JSON.stringify(result, null, 2));
});

test('live display preview is bounded while recording retains the selected full resolution', { timeout: 60_000 }, async () => {
  const result = await withBrowser(page => page.evaluate(async () => {
    const { StudioSession } = await import('/src/media/StudioSession.ts');
    const { defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
    const { loadObsEngine } = await import('/engine/obs-engine.js');
    const session = new StudioSession({ engine: await loadObsEngine() });
    const outputs = { landscape: document.createElement('canvas'), portrait: document.createElement('canvas') };
    session.attachCanvases(outputs);
    const dimensions = () => Object.fromEntries(Object.entries(outputs).map(([orientation, canvas]) => [orientation, [canvas.width, canvas.height]]));
    const attributes = Object.values(outputs).map(canvas => canvas.getContext('2d').getContextAttributes());
    const displayCanvas = document.createElement('canvas'); displayCanvas.width = 1280; displayCanvas.height = 720;
    const displayContext = displayCanvas.getContext('2d'); displayContext.fillStyle = '#2461c8'; displayContext.fillRect(0, 0, 1280, 720);
    const chooserOptions = [], captures = [], streams = [];
    const originalDisplay = navigator.mediaDevices.getDisplayMedia, originalCamera = navigator.mediaDevices.getUserMedia;
    const originalCapture = HTMLCanvasElement.prototype.captureStream;
    let hardwareRequests = 0, frame = 0;
    const animate = setInterval(() => { displayContext.fillStyle = frame++ % 2 ? '#00dd66' : '#ffbb00'; displayContext.fillRect(frame % 600, 100, 100, 100); }, 30);
    navigator.mediaDevices.getDisplayMedia = async options => { chooserOptions.push(options); const stream = originalCapture.call(displayCanvas, 30); streams.push(stream); return stream; };
    navigator.mediaDevices.getUserMedia = async () => { hardwareRequests++; throw new Error('Screen-only scene requested camera or microphone'); };
    HTMLCanvasElement.prototype.captureStream = function (fps) {
      if (Object.values(outputs).includes(this)) captures.push({ dimensions: [this.width, this.height], fps });
      return originalCapture.call(this, fps);
    };
    try {
      const appearance = defaultSceneAppearance('screen-3d'); appearance.layers = appearance.layers.filter(layer => layer.kind !== 'camera');
      await session.prepare({ source: 'screen', layout: 'screen-3d', resolution: '1080', fps: 30, microphone: false, appearance });
      const preview = dimensions();
      const pending = session.captureLayerScreen('second-display');
      const chooserImmediate = chooserOptions.length === 2;
      await pending;
      await session.start();
      const recording = dimensions();
      await new Promise(resolve => setTimeout(resolve, 1100));
      const files = await session.stop();
      return { attributes, chooserOptions, chooserImmediate, hardwareRequests, preview, recording, afterStop: dimensions(), captures, config: session.getSnapshot().config, files: await Promise.all(['landscape', 'portrait'].map(async orientation => ({ orientation, bytes: [...new Uint8Array(await files[orientation].blob.arrayBuffer())] }))) };
    } finally {
      clearInterval(animate); HTMLCanvasElement.prototype.captureStream = originalCapture;
      navigator.mediaDevices.getDisplayMedia = originalDisplay; navigator.mediaDevices.getUserMedia = originalCamera;
      await session.dispose(); streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    }
  }));
  assert.ok(result.attributes.every(attributes => attributes.willReadFrequently === false), 'Output contexts retain the accelerated drawing preference');
  assert.equal(result.chooserImmediate, true, 'Adding a display invokes the chooser in the original action');
  assert.equal(result.hardwareRequests, 0);
  assert.equal(result.chooserOptions.length, 2);
  for (const options of result.chooserOptions) {
    assert.equal(options.video.width.ideal, 1920);
    assert.equal(options.video.height.ideal, 1920);
    assert.equal(options.video.width.max, 1920);
    assert.equal(options.video.height.max, 1920);
    assert.equal(options.video.frameRate.ideal, 30);
    assert.equal(options.video.frameRate.max, 30);
  }
  assert.deepEqual(result.preview, { landscape: [1280, 720], portrait: [720, 1280] });
  assert.deepEqual(result.recording, { landscape: [1920, 1080], portrait: [1080, 1920] });
  assert.deepEqual(result.captures, [{ dimensions: [1920, 1080], fps: 30 }, { dimensions: [1080, 1920], fps: 30 }]);
  assert.deepEqual(result.afterStop, result.preview);
  assert.equal(result.config.resolution, '1080');
  assert.equal(result.config.fps, 30);
  await mkdir(destination, { recursive: true });
  const decoded = [];
  for (const file of result.files) {
    const path = resolve(destination, `${file.orientation}.mp4`);
    await writeFile(path, new Uint8Array(file.bytes));
    const probe = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.deepEqual([stream.width, stream.height], file.orientation === 'landscape' ? [1920, 1080] : [1080, 1920]);
    decoded.push({ orientation: file.orientation, width: stream.width, height: stream.height, bytes: file.bytes.length });
  }
  delete result.files;
  await writeFile(resolve(destination, 'preview-recording-resolution.json'), JSON.stringify({ ...result, decoded }, null, 2));
});
