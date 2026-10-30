import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/recording-thumbnail-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>Recording thumbnail fixture</body></html>',
  }));
  await page.goto('/recording-thumbnail-fixture');
});

test('recording covers sample actual pixels at five percent and survive rename/reload', async ({ page }) => {
  const result = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const { RecordingStore } = await import('/src/media/storage.ts');
    const project = store.loadProjects()[0];
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    const stopped = new Promise<Blob>(resolve => {
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });
    context.fillStyle = '#ef2222'; context.fillRect(0, 0, 640, 360);
    recorder.start();
    const start = performance.now();
    await new Promise<void>(resolve => {
      const draw = () => {
        const elapsed = performance.now() - start;
        context.fillStyle = elapsed < 100 ? '#ef2222' : '#2266ef';
        context.fillRect(0, 0, 640, 360);
        if (elapsed >= 4000) resolve();
        else requestAnimationFrame(draw);
      };
      draw();
    });
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach(track => track.stop());
    const recording = new RecordingStore('video/webm');
    await recording.open();
    await recording.write('landscape', blob); await recording.write('portrait', blob);
    const files = await recording.finalize(true);
    const file = (orientation: 'landscape' | 'portrait') => ({
      orientation, blob: files[orientation], url: '', fileName: `${orientation}.webm`,
      mimeType: 'video/webm', size: files[orientation].size, durationMs: 4000,
    });
    const take = await store.saveProjectTake(project.id, {
      id: recording.id, landscape: file('landscape'), portrait: file('portrait'),
      startedAt: Date.now() - 4000, stoppedAt: Date.now(), warnings: [],
    });
    const image = new Image();
    image.src = take.thumbnail!;
    await image.decode();
    const sampled = document.createElement('canvas'); sampled.width = 1; sampled.height = 1;
    const ctx = sampled.getContext('2d')!; ctx.drawImage(image, 0, 0, 1, 1);
    const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    store.renameProjectTake(take.id, 'Capa corrigida');
    // Re-saving the thumbnail merges against the current take, preserving its title.
    store.saveProjectTakeThumbnail(take.id, { thumbnail: take.thumbnail!, thumbnailAtSeconds: take.thumbnailAtSeconds! });
    return { id: take.id, width: image.width, height: image.height, length: take.thumbnail!.length,
      at: take.thumbnailAtSeconds, pixel, saved: store.listProjectTakes()[0] };
  });
  expect(result.at).toBeGreaterThanOrEqual(0.15);
  expect(result.at).toBeLessThanOrEqual(0.25);
  expect(result.pixel[2]).toBeGreaterThan(180);
  expect(result.pixel[0]).toBeLessThan(80);
  expect(result.width).toBe(320);
  expect(result.height).toBe(180);
  expect(result.length).toBeLessThan(64_000);
  expect(result.saved.name).toBe('Capa corrigida');
  await page.reload();
  const persisted = await page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes()[0]);
  expect(persisted.thumbnail).toBe(result.saved.thumbnail);
  expect(persisted.thumbnailAtSeconds).toBe(result.at);
});

test('a corrupt video does not prevent recording metadata from saving', async ({ page }) => {
  const result = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0];
    const blob = new Blob(['not a video'], { type: 'video/mp4' });
    const file = (orientation: 'landscape' | 'portrait') => ({ orientation, blob, url: '',
      fileName: `${orientation}.mp4`, mimeType: 'video/mp4', size: blob.size, durationMs: 1000 });
    const take = await store.saveProjectTake(project.id, { id: 'corrupt-thumbnail',
      landscape: file('landscape'), portrait: file('portrait'), startedAt: 1, stoppedAt: 1001, warnings: [] });
    return { take, saved: store.listProjectTakes() };
  });
  expect(result.take.thumbnail).toBeUndefined();
  expect(result.saved.map(take => take.id)).toContain('corrupt-thumbnail');
});
