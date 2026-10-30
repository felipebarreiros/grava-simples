import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyRecording } from '../scripts/verify-recordings.mjs';

const destination = resolve('.context/results/scene-compositor');

test('shared scene compositor preserves geometry, layers, countdown and 3D frame budget', { timeout: 240_000 }, async () => {
  await mkdir(destination, { recursive: true });
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.route('**/__scene-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Scene compositor regression</title>' }));
    await page.goto(`http://127.0.0.1:${address.port}/__scene-test`);
    const composition = await page.evaluate(async () => {
      const { SceneCompositor, defaultSceneAppearance, normalizeSceneAppearance, containedRect } = await import('/src/media/SceneCompositor.ts');
      const { loadObsEngine } = await import('/engine/obs-engine.js');
      const engine = await loadObsEngine();
      const compositor = new SceneCompositor();
      const makeCanvas = (width, height, color) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true }); if (color) { context.fillStyle = color; context.fillRect(0, 0, width, height); } return canvas; };
      const camera = { element: makeCanvas(640, 480, '#f59a70'), width: 640, height: 480 };
      const screen = { element: makeCanvas(1280, 720, '#12203e'), width: 1280, height: 720 };
      const canvas = makeCanvas(640, 360), context = canvas.getContext('2d');
      const base = { layout: 'screen', appearance: defaultSceneAppearance('screen'), zoom: 1.6, orientation: 'landscape', remainingSeconds: 9, camera, screen, engine };
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
      compositor.render(context, 640, 360, base);
      const regularCamera = pixel(570, 300);
      const hidden = structuredClone(base.appearance); hidden.layers.find(layer => layer.kind === 'camera').visible = false;
      compositor.render(context, 640, 360, { ...base, appearance: hidden });
      const hiddenCamera = pixel(570, 300);
      const reordered = structuredClone(base.appearance); reordered.layers = [reordered.layers[0], reordered.layers[2], reordered.layers[1]];
      compositor.render(context, 640, 360, { ...base, appearance: reordered });
      const reorderedCamera = pixel(570, 300);
      const circle = { ...base.appearance, cameraShape: 'circle', cameraBorderColor: '#ff4000', cameraBorderWidth: 12, cameraShadow: true };
      compositor.render(context, 640, 360, { ...base, appearance: circle });
      const circlePixels = { corner: pixel(485, 260), center: pixel(550, 300) };
      const panorama = { element: makeCanvas(1000, 100, '#00ff00'), width: 1000, height: 100 };
      const recorded = []; let perspectiveDrawCalls = 0;
      const originalDraw = context.drawImage.bind(context);
      context.drawImage = (...args) => { perspectiveDrawCalls++; if (args[0] === panorama.element) recorded.push({ cropX: args[1], cropY: args[2], cropWidth: args[3], cropHeight: args[4] }); return originalDraw(...args); };
      compositor.render(context, 640, 360, { ...base, layout: 'screen-3d', appearance: defaultSceneAppearance('screen-3d'), screen: panorama });
      context.drawImage = originalDraw;
      const presentationLayouts = ['landscape', 'portrait'].map(orientation => {
        const width = orientation === 'landscape' ? 640 : 360, height = orientation === 'landscape' ? 360 : 640;
        const output = makeCanvas(width, height), outputContext = output.getContext('2d');
        const slide = { element: makeCanvas(640, 480, '#00ff00'), width: 640, height: 480 };
        compositor.render(outputContext, width, height, { ...base, orientation, layout: 'screen-3d', appearance: defaultSceneAppearance('screen-3d'), screen: slide });
        const pixels = outputContext.getImageData(0, 0, width, height).data;
        const columns = new Map();
        for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
          const offset = (y * width + x) * 4;
          if (pixels[offset] < 20 && pixels[offset + 1] > 230 && pixels[offset + 2] < 20) {
            const rows = columns.get(x) ?? []; rows.push(y); columns.set(x, rows);
          }
        }
        const visible = [...columns.keys()];
        const left = columns.get(visible[Math.floor(visible.length * .2)]);
        const right = columns.get(visible[Math.floor(visible.length * .8)]);
        const sample = (x, y) => [...outputContext.getImageData(x, y, 1, 1).data].slice(0, 3);
        return { orientation, width, height, visibleWidth: visible.length, firstColumn: visible[0], lastColumn: visible.at(-1), left: { top: left[0], bottom: left.at(-1), height: left.length }, right: { top: right[0], bottom: right.at(-1), height: right.length }, camera: sample(Math.floor(width * .8), Math.floor(height * .7)) };
      });
      // A horizontal source rule must remain one straight, sharp line after projection.
      const qualitySource = makeCanvas(1000, 750, '#ffffff'), qualitySourceContext = qualitySource.getContext('2d');
      qualitySourceContext.fillStyle = '#000000'; qualitySourceContext.fillRect(0, 172, 1000, 6);
      const qualityCanvas = makeCanvas(1920, 1080), qualityContext = qualityCanvas.getContext('2d');
      compositor.render(qualityContext, 1920, 1080, { ...base, layout: 'screen-3d', appearance: defaultSceneAppearance('screen-3d'), camera: undefined, screen: { element: qualitySource, width: 1000, height: 750 } });
      const qualityPixels = qualityContext.getImageData(0, 0, 1920, 1080).data, whiteColumns = [];
      for (let x = 0; x < 1920; x++) {
        let top = 1080, bottom = -1;
        for (let y = 0; y < 1080; y++) {
          const offset = (y * 1920 + x) * 4;
          if (qualityPixels[offset] > 250 && qualityPixels[offset + 1] > 250 && qualityPixels[offset + 2] > 250) { top = Math.min(top, y); bottom = y; }
        }
        if (bottom > top) whiteColumns.push({ x, top, bottom });
      }
      const linePoints = whiteColumns.slice(Math.floor(whiteColumns.length * .1), Math.floor(whiteColumns.length * .9)).map(({ x, top, bottom }) => {
        let weight = 0, weightedY = 0, weightedYY = 0, maximumDarkness = 0;
        for (let y = Math.ceil(top + (bottom - top) * .15); y <= Math.floor(top + (bottom - top) * .35); y++) {
          const offset = (y * 1920 + x) * 4;
          const darkness = (765 - qualityPixels[offset] - qualityPixels[offset + 1] - qualityPixels[offset + 2]) / 765;
          weight += darkness; weightedY += darkness * (y + .5); weightedYY += darkness * (y + .5) ** 2; maximumDarkness = Math.max(maximumDarkness, darkness);
        }
        return { x, y: weightedY / weight, spread: Math.sqrt(Math.max(0, weightedYY / weight - (weightedY / weight) ** 2)), maximumDarkness };
      });
      const meanX = linePoints.reduce((sum, point) => sum + point.x, 0) / linePoints.length;
      const meanY = linePoints.reduce((sum, point) => sum + point.y, 0) / linePoints.length;
      const slope = linePoints.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / linePoints.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
      const residuals = linePoints.map(point => point.y - (meanY + slope * (point.x - meanX)));
      const quality = {
        columns: linePoints.length,
        rms: Math.sqrt(residuals.reduce((sum, residual) => sum + residual ** 2, 0) / residuals.length),
        maximumJump: Math.max(...linePoints.slice(1).map((point, index) => Math.abs(point.y - linePoints[index].y - slope))),
        maximumSpread: Math.max(...linePoints.map(point => point.spread)),
        minimumContrast: Math.min(...linePoints.map(point => point.maximumDarkness)),
      };
      const normalized = normalizeSceneAppearance('countdown', { countdownSeconds: NaN, cameraBorderWidth: 999, cameraBorderColor: 'url(evil)', layers: [{ id: 'ok', kind: 'timer', visible: false, name: 'Timer' }, { id: 'bad', kind: 'unknown', visible: true }] });
      return { regularCamera, hiddenCamera, reorderedCamera, circlePixels, perspective: recorded, perspectiveDrawCalls, presentationLayouts, quality, contained: containedRect(1000, 100, 0, 0, 100, 100), normalized, defaultCountdown: defaultSceneAppearance('countdown').layers.map(layer => layer.kind) };
    });
    assert.deepEqual(composition.regularCamera, [245, 154, 112]);
    assert.deepEqual(composition.hiddenCamera, [18, 32, 62]);
    assert.deepEqual(composition.reorderedCamera, [18, 32, 62]);
    assert.notDeepEqual(composition.circlePixels.corner, [245, 154, 112]);
    assert.deepEqual(composition.circlePixels.center, [245, 154, 112]);
    assert.ok(composition.perspective.length > 1 && composition.perspective.length <= 64, 'Landscape taper uses bounded image slices');
    assert.equal(composition.perspectiveDrawCalls, composition.perspective.length + 2);
    assert.ok(Math.abs(Math.min(...composition.perspective.map(slice => slice.cropX))) < .001, 'Wide slide includes its left edge');
    assert.ok(Math.abs(Math.max(...composition.perspective.map(slice => slice.cropX + slice.cropWidth)) - 1000) < .001, 'Wide slide includes its right edge');
    assert.ok(composition.perspective.every(slice => slice.cropY === 0 && slice.cropHeight === 100), 'Taper preserves the full height of a wide input');
    const landscape = composition.presentationLayouts.find(output => output.orientation === 'landscape');
    assert.ok(landscape.visibleWidth > landscape.width * .55, 'Landscape slide occupies the large left panel');
    assert.ok(landscape.firstColumn < landscape.width * .05 && landscape.lastColumn < landscape.width * .63, 'Landscape slide stays beside the presenter');
    assert.ok(landscape.right.top - landscape.left.top > 8, 'Landscape top edge tapers down toward the presenter');
    assert.ok(landscape.left.bottom - landscape.right.bottom > 8, 'Landscape bottom edge tapers up toward the presenter');
    assert.ok(landscape.left.height - landscape.right.height > 20, 'Landscape slide has true perspective rather than diagonal roll');
    assert.deepEqual(landscape.camera, [245, 154, 112]);
    const portrait = composition.presentationLayouts.find(output => output.orientation === 'portrait');
    assert.equal(portrait.visibleWidth, portrait.width, 'Portrait slide fills the output width');
    assert.equal(portrait.left.top, 0, 'Portrait slide starts at the top edge');
    assert.equal(portrait.right.top, portrait.left.top, 'Portrait top edge remains flat');
    assert.equal(portrait.right.bottom, portrait.left.bottom, 'Portrait bottom edge remains flat');
    assert.ok(portrait.left.height > portrait.height * .40 && portrait.left.height < portrait.height * .44, 'A 4:3 portrait slide reserves about 40% of the output');
    assert.deepEqual(portrait.camera, [245, 154, 112], 'Portrait camera occupies the area below the slide');
    assert.ok(composition.quality.columns > 800, 'Sharpness fixture samples the full slide width');
    assert.ok(composition.quality.rms < .14, `Projected rule stays straight: ${composition.quality.rms}px RMS error`);
    assert.ok(composition.quality.maximumJump < .45, `Projected rule has no visible strip jumps: ${composition.quality.maximumJump}px`);
    assert.ok(composition.quality.maximumSpread < 2.1, 'Perspective smoothing does not blur the rule');
    assert.ok(composition.quality.minimumContrast > .98, 'Perspective smoothing preserves full line contrast');
    assert.equal(composition.contained.width / composition.contained.height, 10);
    assert.equal(composition.normalized.cameraBorderWidth, 16);
    assert.equal(composition.normalized.cameraBorderColor, '#ffffff');
    assert.equal(composition.normalized.layers.length, 1);
    assert.deepEqual(composition.defaultCountdown, ['background', 'title', 'timer']);
    const performance = await page.evaluate(async () => {
      const { SceneCompositor, defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
      const { loadObsEngine } = await import('/engine/obs-engine.js');
      const engine = await loadObsEngine(); const compositor = new SceneCompositor();
      const make = (width, height) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; };
      const camera = { element: make(640, 480), width: 640, height: 480 }, screen = { element: make(1280, 720), width: 1280, height: 720 };
      const cameraContext = camera.element.getContext('2d', { alpha: false, willReadFrequently: true }); cameraContext.fillStyle = '#f59a70'; cameraContext.fillRect(0, 0, 640, 480);
      const screenContext = screen.element.getContext('2d', { alpha: false, willReadFrequently: true }); screenContext.fillStyle = '#12203e'; screenContext.fillRect(0, 0, 1280, 720);
      const outputs = [make(1920, 1080), make(1080, 1920)]; const contexts = outputs.map(canvas => canvas.getContext('2d', { alpha: false, willReadFrequently: true }));
      const thumbs = [make(240, 135), make(240, 135), make(240, 135), make(240, 135)];
      const layouts = ['camera', 'camera-zoom', 'screen', 'screen-3d'];
      let frame = 0;
      const input = (layout, orientation) => ({ layout, appearance: defaultSceneAppearance(layout), zoom: 1.6, orientation, remainingSeconds: 300, camera, screen, engine });
      const current = layout => { screenContext.fillStyle = frame % 2 ? '#166050' : '#12203e'; screenContext.fillRect(frame++ % 1200, 280, 80, 120); outputs.forEach((canvas, index) => compositor.render(contexts[index], canvas.width, canvas.height, input(layout, index ? 'portrait' : 'landscape'))); };
      // Exact previous hot path, retained here only as a measured regression baseline.
      const previous = () => { screenContext.fillStyle = frame % 2 ? '#166050' : '#12203e'; screenContext.fillRect(frame++ % 1200, 280, 80, 120); outputs.forEach((canvas, index) => {
        const context = contexts[index], width = canvas.width, height = canvas.height;
        const rect = engine.layout({ outputWidth: width, outputHeight: height, sourceWidth: 640, sourceHeight: 480, cameraWidth: 640, cameraHeight: 480, mode: 'camera', orientation: index ? 'portrait' : 'landscape' }).source;
        context.drawImage(camera.element, rect.cropX, rect.cropY, rect.cropWidth, rect.cropHeight, rect.x, rect.y, rect.width, rect.height);
        const pw = width * (index ? 0.78 : 0.48), ph = Math.min(pw * 720 / 1280, height * 0.36), x = width * .045, y = height * .055, inset = ph * .10;
        context.save(); context.beginPath(); context.moveTo(x, y); context.lineTo(x + pw, y + inset); context.lineTo(x + pw, y + ph - inset); context.lineTo(x, y + ph); context.closePath(); context.shadowColor = 'rgba(0,0,0,.55)'; context.shadowBlur = width * .018; context.shadowOffsetY = height * .012; context.fillStyle = '#111111'; context.fill(); context.shadowColor = 'transparent'; context.clip();
        for (let strip = 0; strip < 64; strip++) { const ratio = strip / 64; context.drawImage(screen.element, 1280 * ratio, 0, 1280 / 64 + 1, 720, x + pw * ratio, y + inset * ratio, pw / 64 + 1, ph - 2 * inset * ratio); }
        context.restore();
      }); };
      const average = (callback, samples = 40) => { const flush = () => contexts.forEach(context => context.getImageData(0, 0, 1, 1)); for (let i = 0; i < 4; i++) { callback(); flush(); } const start = performance.now(); for (let i = 0; i < samples; i++) { callback(); flush(); } return (performance.now() - start) / samples; };
      const screenMs = average(() => current('screen'));
      const perspectiveMs = average(() => current('screen-3d'));
      const previousPerspectiveMs = average(previous, 20);
      const thumbnailSetMs = average(() => thumbs.forEach((canvas, index) => compositor.render(canvas.getContext('2d'), 240, 135, input(layouts[index], 'landscape'))), 20);
      return { size: '1920x1080 + 1080x1920', targetFps: 30, targetFrameMs: 1000 / 30, screenMs, perspectiveMs, previousPerspectiveMs, thumbnailSetMs, thumbnailsPerSecond: 1, estimatedThumbnailPercentAt30Fps: thumbnailSetMs / (perspectiveMs * 30) * 100, screenCallsPerOutput: 2, previousCallsPerOutput: 65 };
    });
    await writeFile(resolve(destination, 'composition-and-performance.json'), JSON.stringify({ composition, performance }, null, 2));
    assert.ok(performance.perspectiveMs < performance.previousPerspectiveMs, `Perspective ${performance.perspectiveMs}ms did not improve old path ${performance.previousPerspectiveMs}ms`);
    assert.ok(performance.perspectiveMs <= performance.targetFrameMs, `Perspective composition exceeds30fps budget: ${performance.perspectiveMs}ms`);
    const countdown = await page.evaluate(async () => {
      const { StudioSession } = await import('/src/media/StudioSession.ts');
      const { defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
      const { loadObsEngine } = await import('/engine/obs-engine.js');
      const engine = await loadObsEngine(); const session = new StudioSession({ engine });
      const canvases = { landscape: document.createElement('canvas'), portrait: document.createElement('canvas') };
      session.attachCanvases(canvases);
      const appearance = { ...defaultSceneAppearance('countdown'), productTitle: 'Curso de fotografia', countdownSeconds: 12 };
      const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); let captureRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { captureRequests++; throw new Error('Countdown requested hardware'); };
      try {
        await session.prepare({ source: 'camera', layout: 'countdown', resolution: '360', fps: 30, microphone: false, appearance });
        const paused = session.getSnapshot().countdown;
        await new Promise(resolve => setTimeout(resolve, 1100)); const stillPaused = session.getSnapshot().countdown;
        session.resumeCountdown(); await new Promise(resolve => setTimeout(resolve, 1100)); const resumed = session.getSnapshot().countdown;
        session.resetCountdown(); const reset = session.getSnapshot().countdown;
        session.zeroCountdown(); session.resumeCountdown(); const zero = session.getSnapshot().countdown;
        session.resetCountdown(); session.resumeCountdown();
        const beforeThumbnail = session.getSnapshot(); const thumbnail = document.createElement('canvas'); thumbnail.width = 240; thumbnail.height = 135;
        const thumbnailRendered = session.renderSceneToCanvas(thumbnail, { layout: 'camera-zoom', appearance: defaultSceneAppearance('camera-zoom'), zoom: 2 });
        const afterThumbnail = session.getSnapshot();
        await session.start(); await new Promise(resolve => setTimeout(resolve, 5500)); const result = await session.stop();
        const files = await Promise.all(['landscape', 'portrait'].map(async orientation => ({ orientation, bytes: [...new Uint8Array(await result[orientation].blob.arrayBuffer())], mimeType: result[orientation].mimeType, durationMs: result[orientation].durationMs })));
        return { captureRequests, paused, stillPaused, resumed, reset, zero, thumbnailRendered, thumbnailDidNotMutateConfig: JSON.stringify(beforeThumbnail.config) === JSON.stringify(afterThumbnail.config), files };
      } finally { navigator.mediaDevices.getUserMedia = originalCapture; await session.dispose(); }
    });
    assert.equal(countdown.captureRequests, 0);
    assert.equal(countdown.paused.running, false);
    assert.equal(countdown.stillPaused.remainingSeconds, countdown.paused.remainingSeconds);
    assert.ok(countdown.resumed.remainingSeconds < countdown.paused.remainingSeconds);
    assert.equal(countdown.reset.remainingSeconds, 12);
    assert.equal(countdown.reset.running, false);
    assert.deepEqual(countdown.zero, { remainingSeconds: 0, running: false });
    assert.equal(countdown.thumbnailRendered, true);
    assert.equal(countdown.thumbnailDidNotMutateConfig, true);
    const files = [];
    for (const file of countdown.files) {
      const path = resolve(destination, `countdown-${file.orientation}.mp4`);
      await writeFile(path, new Uint8Array(file.bytes));
      const decoded = verifyRecording({ path, width: file.orientation === 'landscape' ? 640 : 360, height: file.orientation === 'landscape' ? 360 : 640, expectedDurationSec: 5.5, minimumFps: 24, requireAudible: false, minimumChangedPixelFraction: .001, minimumMotionDifference: .02 });
      files.push({ orientation: file.orientation, ...decoded });
      assert.equal(decoded.passed, true, decoded.failures.join('\n'));
      assert.ok(decoded.continuity.maximumFrameGapSeconds <= .5);
      assert.ok(decoded.continuity.movingTransitions >= 4, 'countdown digits did not progress');
      assert.ok(decoded.continuity.lastFiveSeconds.movingTransitions >= 3, 'countdown froze in final five seconds');
    }
    delete countdown.files;
    await writeFile(resolve(destination, 'countdown.json'), JSON.stringify({ countdown, files, passed: true }, null, 2));
    const perspectiveRecording = await page.evaluate(async () => {
      const { StudioSession } = await import('/src/media/StudioSession.ts');
      const { defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
      const { loadObsEngine } = await import('/engine/obs-engine.js');
      const session = new StudioSession({ engine: await loadObsEngine() });
      session.attachCanvases({ landscape: document.createElement('canvas'), portrait: document.createElement('canvas') });
      const layouts = ['camera', 'camera-zoom', 'screen', 'screen-3d'];
      const thumbnails = layouts.map(() => { const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 135; return canvas; });
      let timer, thumbnailFrames = 0;
      try {
        const appearance = defaultSceneAppearance('screen-3d');
        await session.prepare({ source: 'test', layout: 'screen-3d', resolution: '360', fps: 30, appearance });
        const editorBounds = session.getLayerBounds('portrait');
        const customFrames = { camera: { x: .1, y: .55, width: .8, height: .4 }, screen: { x: .05, y: .05, width: .9, height: .35 } };
        const editedAppearance = structuredClone(appearance);
        editedAppearance.layers.forEach(layer => { if (customFrames[layer.id]) layer.frames = { portrait: customFrames[layer.id] }; });
        session.setSceneAppearance(editedAppearance);
        const customBounds = session.getLayerBounds('portrait');
        session.setSceneAppearance(appearance);
        await session.start();
        timer = setInterval(() => layouts.forEach((layout, index) => { session.renderSceneToCanvas(thumbnails[index], { layout, appearance: defaultSceneAppearance(layout), zoom: 1.6 }); thumbnailFrames++; }), 1000);
        await new Promise(resolve => setTimeout(resolve, 8000));
        clearInterval(timer); const result = await session.stop();
        return { thumbnailFrames, editorBounds, customFrames, customBounds, snapshot: session.getSnapshot(), files: await Promise.all(['landscape', 'portrait'].map(async orientation => ({ orientation, bytes: [...new Uint8Array(await result[orientation].blob.arrayBuffer())] }))) };
      } finally { clearInterval(timer); await session.dispose(); }
    });
    assert.ok(Math.abs(perspectiveRecording.editorBounds.screen.height - 360 / (1280 / 720) / 640) < .000001, 'Portrait editor uses the actual screen aspect, not the 4:3 camera aspect');
    assert.ok(Math.abs(perspectiveRecording.editorBounds.camera.y - perspectiveRecording.editorBounds.screen.height) < .000001, 'Portrait camera handles begin exactly below the rendered slide');
    assert.ok(Math.abs(perspectiveRecording.editorBounds.camera.height + perspectiveRecording.editorBounds.camera.y - 1) < .000001, 'Portrait camera handles cover the remaining output');
    assert.deepEqual(perspectiveRecording.customBounds.camera, perspectiveRecording.customFrames.camera, 'Custom portrait camera placement overrides preset defaults');
    assert.deepEqual(perspectiveRecording.customBounds.screen, perspectiveRecording.customFrames.screen, 'Custom portrait slide placement overrides preset defaults');
    const perspectiveFiles = [];
    for (const file of perspectiveRecording.files) {
      const path = resolve(destination, `perspective-${file.orientation}.mp4`); await writeFile(path, new Uint8Array(file.bytes));
      const decoded = verifyRecording({ path, width: file.orientation === 'landscape' ? 640 : 360, height: file.orientation === 'landscape' ? 360 : 640, expectedDurationSec: 8, minimumFps: 24, requireAudible: true, requireContinuousVideo: true });
      perspectiveFiles.push({ orientation: file.orientation, ...decoded }); assert.equal(decoded.passed, true, decoded.failures.join('\n'));
    }
    delete perspectiveRecording.files;
    await writeFile(resolve(destination, 'perspective-recording.json'), JSON.stringify({ ...perspectiveRecording, files: perspectiveFiles, passed: true }, null, 2));
    await browser.close();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--disable-dev-shm-usage'] });
    const normalContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const normalPage = await normalContext.newPage();
    await normalPage.route('**/__scene-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Autoplay policy regression</title>' }));
    await normalPage.goto(`http://127.0.0.1:${address.port}/__scene-test`);
    const cdp = await normalContext.newCDPSession(normalPage);
    const evaluated = await cdp.send('Runtime.evaluate', { userGesture: false, awaitPromise: true, returnByValue: true, expression: '(' + (async () => {
      const { StudioSession } = await import('/src/media/StudioSession.ts'); const { loadObsEngine } = await import('/engine/obs-engine.js'); const { defaultSceneAppearance } = await import('/src/media/SceneCompositor.ts');
      const session = new StudioSession({ engine: await loadObsEngine() });
      const canvases = { landscape: document.createElement('canvas'), portrait: document.createElement('canvas') };
      session.attachCanvases(canvases);
      const activationBefore = navigator.userActivation.hasBeenActive;
      const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const captures = [];
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await originalCapture(constraints); captures.push({ constraints, stream }); return stream; };
      try {
        await Promise.race([session.prepare({ source: 'camera', layout: 'camera', resolution: '360', fps: 30 }), new Promise((_, reject) => setTimeout(() => reject(new Error('Preview blocked on suspended AudioContext')), 12_000))]);
        const preview = { activationBefore, activationAfter: navigator.userActivation.hasBeenActive, state: session.getSnapshot().state, cameraLive: session.getSnapshot().metrics.sources.camera.live };
        const screen = document.createElement('canvas'); screen.width = 1280; screen.height = 720;
        const screenContext = screen.getContext('2d'); screenContext.fillStyle = '#00aaff'; screenContext.fillRect(0, 0, 1280, 720);
        let displayRequests = 0; const display = screen.captureStream(30), displayTrack = display.getVideoTracks()[0];
        navigator.mediaDevices.getDisplayMedia = async () => { displayRequests++; return display; };
        await session.prepare({ source: 'screen', layout: 'screen', resolution: '360', fps: 30, appearance: defaultSceneAppearance('screen') });
        const initialCamera = captures.at(-1).stream.getVideoTracks()[0], microphone = captures.at(-1).stream.getAudioTracks()[0];
        await session.replaceCamera();
        const firstReplacement = { displayRequests, displayLive: displayTrack.readyState, microphoneLive: microphone.readyState, oldCameraStopped: initialCamera.readyState, source: session.getSnapshot().config.source, layout: session.getSnapshot().config.layout, cameraLive: session.getSnapshot().metrics.sources.camera.live, constraints: captures.at(-1).constraints };
        screenContext.fillStyle = '#ff4000'; screenContext.fillRect(0, 0, 1280, 720);
        const blob = await new Promise(resolve => screen.toBlob(resolve, 'image/png'));
        await session.setMediaSource(new File([blob], 'slide.png', { type: 'image/png' }));
        await session.replaceCamera();
        const fileReplacement = { microphoneLive: microphone.readyState, source: session.getSnapshot().config.source, layout: session.getSnapshot().config.layout, sourceLabel: session.getSnapshot().metrics.sources.screen.label, screenPixel: [...canvases.landscape.getContext('2d').getImageData(320, 80, 1, 1).data].slice(0, 3), constraints: captures.at(-1).constraints };
        const heldCamera = captures.at(-1).stream.getVideoTracks()[0];
        await session.replaceMicrophone();
        const microphoneReplacement = { oldMicrophone: microphone.readyState, heldCamera: heldCamera.readyState, newMicrophone: captures.at(-1).stream.getAudioTracks()[0].readyState, constraints: captures.at(-1).constraints, source: session.getSnapshot().config.source, sourceLabel: session.getSnapshot().metrics.sources.screen.label, layout: session.getSnapshot().config.layout };
        return { ...preview, firstReplacement, fileReplacement, microphoneReplacement };
      } finally { await session.dispose(); }
    }).toString() + ')()' });
    assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails));
    const autoplay = evaluated.result.value;
    assert.equal(autoplay.activationBefore, false); assert.equal(autoplay.activationAfter, false); assert.equal(autoplay.state, 'ready'); assert.equal(autoplay.cameraLive, true);
    assert.equal(autoplay.firstReplacement.displayRequests, 1); assert.equal(autoplay.firstReplacement.displayLive, 'live'); assert.equal(autoplay.firstReplacement.microphoneLive, 'live'); assert.equal(autoplay.firstReplacement.oldCameraStopped, 'ended');
    assert.equal(autoplay.firstReplacement.source, 'screen'); assert.equal(autoplay.firstReplacement.layout, 'screen'); assert.equal(autoplay.firstReplacement.cameraLive, true); assert.equal(autoplay.firstReplacement.constraints.audio, false);
    assert.equal(autoplay.fileReplacement.microphoneLive, 'live'); assert.equal(autoplay.fileReplacement.source, 'media'); assert.equal(autoplay.fileReplacement.layout, 'screen'); assert.equal(autoplay.fileReplacement.sourceLabel, 'slide.png'); assert.equal(autoplay.fileReplacement.constraints.audio, false); assert.deepEqual(autoplay.fileReplacement.screenPixel, [255, 64, 0]);
    assert.equal(autoplay.microphoneReplacement.oldMicrophone, 'ended'); assert.equal(autoplay.microphoneReplacement.heldCamera, 'live'); assert.equal(autoplay.microphoneReplacement.newMicrophone, 'live'); assert.equal(autoplay.microphoneReplacement.constraints.video, false); assert.equal(autoplay.microphoneReplacement.source, 'media'); assert.equal(autoplay.microphoneReplacement.sourceLabel, 'slide.png'); assert.equal(autoplay.microphoneReplacement.layout, 'screen');
    await writeFile(resolve(destination, 'autoplay-preview.json'), JSON.stringify(autoplay, null, 2));

  } finally { await browser?.close(); await server.close(); }
});
