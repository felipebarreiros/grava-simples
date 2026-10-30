import { test, expect } from './fixtures/auth';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyRecording } from '../scripts/verify-recordings.mjs';
import { selectValue } from './helpers';

const destination = resolve('.context/results/hotmart-compatible-download');
const ffmpeg = process.env.FFMPEG ?? resolve('.context/tools/node_modules/ffmpeg-static/ffmpeg');
const ffprobe = process.env.FFPROBE ?? resolve('.context/tools/node_modules/ffprobe-static/bin/linux/x64/ffprobe');
function run(command: string, args: string[], binary = false) {
  const result = spawnSync(command, args, { encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, String(result.stderr)).toBe(0);
  return result.stdout;
}
function videoHash(path: string) {
  return createHash('sha256').update(run(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', '-'], true)).digest('hex');
}
function boxes(bytes: Buffer) {
  const names: string[] = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset); names.push(bytes.toString('ascii', offset + 4, offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return names;
}

test('customer download buttons prepare both real recorded outputs as local H264/AAC faststart MP4', async ({ page, baseURL }) => {
  await mkdir(destination, { recursive: true });
  await mkdir(resolve('.context/screenshots'), { recursive: true });
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app?test=1', { waitUntil: 'networkidle' });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__recorderTest?.ready))).toBe(true);
  await page.getByTestId('settings-trigger').click();
  await selectValue(page, 'source-mode-select', 'test');
  await selectValue(page, 'resolution-select', '360');
  await selectValue(page, 'fps-select', '30');
  await page.getByTestId('prepare-inputs').click();
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.status)).toBe('ready');
  await page.keyboard.press('Escape');
  await page.getByTestId('start-recording').click();
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.status)).toBe('recording');
  await page.waitForTimeout(1700);
  await page.getByTestId('scene-camera-zoom').click();
  await page.waitForTimeout(1700);
  // Keep the animated fixture visible for the codec check. Perspective
  // occlusion and moving recordings are covered by scene-compositor tests.
  await page.getByTestId('scene-screen').click();
  await page.waitForTimeout(2400);
  await page.getByTestId('stop-recording').click();
  await expect(page.getByTestId('recording-results')).toBeVisible();
  const runtime = await page.locator('script[type=module][src^="/src/main.tsx"], script[type=module][src^="/assets/"]').getAttribute('src');
  const report: unknown[] = [];
  for (const [index, orientation] of ['landscape', 'portrait'].entries()) {
    const original = await page.evaluate(async value => {
      const file = (window as any).__recorderTest.result[value];
      return { bytes: [...new Uint8Array(await file.blob.arrayBuffer())], durationMs: file.durationMs, mimeType: file.mimeType };
    }, orientation);
    const originalPath = resolve(destination, `original-${orientation}.mp4`);
    await writeFile(originalPath, new Uint8Array(original.bytes));
    const article = page.getByTestId(`result-${orientation}`).locator('..');
    const downloadReady = page.waitForEvent('download', { timeout: 90_000 });
    await article.getByRole('button', { name: 'Baixar vídeo', exact: true }).click();
    const download = await downloadReady;
    const path = resolve(destination, download.suggestedFilename());
    await download.saveAs(path);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/-compartilhar\.mp4$/);
    await expect(article.getByTestId(`download-compatible-${orientation}`)).toBeVisible();
    const probe = JSON.parse(String(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path])));
    const video = probe.streams.find((stream: any) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream: any) => stream.codec_type === 'audio');
    expect(video.codec_name).toBe('h264');
    expect(['yuv420p', 'yuvj420p']).toContain(video.pix_fmt);
    expect(video.has_b_frames).toBe(0);
    expect(audio.codec_name).toBe('aac');
    expect(audio.profile).toBe('LC');
    expect(videoHash(originalPath)).toBe(videoHash(path));
    const topLevelBoxes = boxes(await readFile(path));
    expect(topLevelBoxes.indexOf('moov')).toBeLessThan(topLevelBoxes.indexOf('mdat'));
    expect(topLevelBoxes).not.toContain('moof');
    const decoded = verifyRecording({ path, width: index ? 360 : 640, height: index ? 640 : 360, expectedDurationSec: original.durationMs / 1000, requireContinuousVideo: true, requireDynamic: true, requireAudible: true });
    expect(decoded.passed, decoded.failures.join('\n')).toBe(true);
    report.push({ orientation, mimeType: original.mimeType, videoProfile: video.profile, pixelFormat: video.pix_fmt, audioCodec: audio.codec_name, boxes: topLevelBoxes, videoBitstreamPreserved: true, decoded });
  }
  expect(errors).toEqual([]);
  // This suite mocks Clerk in its browser fixture. All recording and export
  // requests must stay local; real Clerk authentication makes separate requests.
  expect(requests.every(url => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
  await page.screenshot({ path: resolve('.context/screenshots/hotmart-compatible-download.png'), fullPage: true });
  await writeFile(resolve(destination, 'report.json'), JSON.stringify({ passed: true, outputs: report, externalRequests: [], applicationVersion: await page.evaluate(() => (window as any).__recorderTest.version), runtime }, null, 2));
});
