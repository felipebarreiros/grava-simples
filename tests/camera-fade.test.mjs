import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

test('presentation camera blends into its background without fading portrait or overriding an explicit off setting', { timeout: 30_000 }, async () => {
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.route('**/__fade-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Camera blend regression</title>' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__fade-test`);
    const result = await page.evaluate(async () => {
      const { SceneCompositor, defaultSceneAppearance, normalizeSceneAppearance } = await import('/src/media/SceneCompositor.ts');
      const { loadObsEngine } = await import('/engine/obs-engine.js');
      const engine = await loadObsEngine(), compositor = new SceneCompositor();
      const cameraCanvas = document.createElement('canvas'); cameraCanvas.width = 640; cameraCanvas.height = 480;
      const cameraContext = cameraCanvas.getContext('2d'); cameraContext.fillStyle = '#f59a70'; cameraContext.fillRect(0, 0, 640, 480);
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d');
      const appearance = defaultSceneAppearance('screen-3d');
      appearance.layers.find(layer => layer.kind === 'screen').visible = false;
      const input = { layout: 'screen-3d', appearance, orientation: 'landscape', zoom: 1, remainingSeconds: 0, engine, camera: { element: cameraCanvas, width: 640, height: 480 } };
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
      compositor.render(context, 640, 360, input);
      const fade = [307, 325, 350, 395].map(x => pixel(x, 30));
      const disabled = structuredClone(appearance); disabled.cameraFade = false;
      compositor.render(context, 640, 360, { ...input, appearance: disabled });
      const off = pixel(307, 30);
      const overridden = structuredClone(appearance); overridden.layers.find(layer => layer.kind === 'camera').cameraFade = false;
      compositor.render(context, 640, 360, { ...input, appearance: normalizeSceneAppearance('screen-3d', overridden) });
      const layerOff = pixel(307, 30);
      canvas.width = 360; canvas.height = 640;
      compositor.render(context, 360, 640, { ...input, orientation: 'portrait' });
      const portrait = pixel(0, 400);
      compositor.clear();
      return { fade, off, layerOff, portrait };
    });
    assert.ok(result.fade[0][0] < 20, `Camera boundary meets the dark background: ${JSON.stringify(result.fade)}`);
    assert.ok(result.fade[0][0] < result.fade[1][0] && result.fade[1][0] < result.fade[2][0] && result.fade[2][0] < result.fade[3][0], 'Camera emerges gradually across the blend');
    assert.deepEqual(result.fade[3], [245, 154, 112], 'Presenter area keeps its original pixels');
    assert.deepEqual(result.off, [245, 154, 112]);
    assert.deepEqual(result.layerOff, result.off, 'An explicit layer override survives normalization');
    assert.deepEqual(result.portrait, [245, 154, 112], 'Portrait remains a clean stacked composition');
  } finally {
    await browser?.close();
    await server.close();
  }
});
