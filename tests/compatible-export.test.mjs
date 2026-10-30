import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRecording } from '../scripts/verify-recordings.mjs';

const destination = resolve('.context/results/compatible-export');
const ffmpeg = process.env.FFMPEG ?? resolve('.context/tools/node_modules/ffmpeg-static/ffmpeg');
const ffprobe = process.env.FFPROBE ?? resolve('.context/tools/node_modules/ffprobe-static/bin/linux/x64/ffprobe');
function run(command, args, binary = false) {
  const result = spawnSync(command, args, { encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout;
}
function videoHash(path) {
  return createHash('sha256').update(run(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', '-'], true)).digest('hex');
}
function mp4Boxes(bytes) {
  const result = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    result.push(bytes.toString('ascii', offset + 4, offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return result;
}

test('local sharing export produces AAC MP4, preserves every H264 frame and moves moov before mdat', { timeout: 180_000 }, async () => {
  await mkdir(destination, { recursive: true });
  const input = resolve(destination, 'original-opus.mp4');
  const output = resolve(destination, 'compatible-aac.mp4');
  run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'libopus', '-movflags', '+frag_keyframe+empty_moov', input]);
  const server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.route('**/__export-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local export test</title>' }));
    await page.goto(`http://127.0.0.1:${address.port}/__export-test`);
    const codecs = await page.evaluate(async () => {
      const { chooseRecordingMimeType } = await import('/src/media/StudioSession.ts');
      const original = MediaRecorder.isTypeSupported;
      try {
        MediaRecorder.isTypeSupported = mime => mime.includes('avc1') && (mime.includes('mp4a.40.2') || mime.includes('opus'));
        const aacPreferred = chooseRecordingMimeType({ resolution: '1080', fps: 30 });
        const highResolution = chooseRecordingMimeType({ resolution: '4k', fps: 60 });
        MediaRecorder.isTypeSupported = mime => mime.includes('avc1') && mime.includes('opus');
        const fallback = chooseRecordingMimeType({ resolution: '1080', fps: 30 });
        return { aacPreferred, highResolution, fallback };
      } finally { MediaRecorder.isTypeSupported = original; }
    });
    assert.match(codecs.aacPreferred, /avc1\.42E028,mp4a\.40\.2/);
    assert.match(codecs.highResolution, /avc1\.42E034,mp4a\.40\.2/);
    assert.match(codecs.fallback, /avc1\.42E028,opus/);
    const inputBytes = [...await readFile(input)];
    const converted = await page.evaluate(async bytes => {
      const { prepareCompatibleDownload } = await import('/src/media/compatibleExport.ts');
      const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4;codecs=avc1,opus' });
      const events = [];
      const result = await prepareCompatibleDownload({ orientation: 'landscape', blob, url: URL.createObjectURL(blob), fileName: 'take.mp4', mimeType: blob.type, size: blob.size, durationMs: 4000 }, event => events.push(event));
      const output = { bytes: [...new Uint8Array(await result.blob.arrayBuffer())], mimeType: result.mimeType, fileName: result.fileName, events };
      URL.revokeObjectURL(result.url);
      return output;
    }, inputBytes);
    await writeFile(output, new Uint8Array(converted.bytes));
    assert.ok(requests.every(url => new URL(url).hostname === '127.0.0.1'), 'export made an external network request');
    assert.equal(converted.mimeType, 'video/mp4;codecs=avc1,mp4a.40.2');
    assert.equal(converted.fileName, 'take-compartilhar.mp4');
    assert.equal(converted.events.at(-1).progress, 1);
    const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.profile, 'LC');
    assert.equal(Number(audio.sample_rate), 48000);
    assert.equal(audio.channels, 2);
    assert.equal(videoHash(input), videoHash(output), 'compressed video was changed during audio conversion');
    const boxes = mp4Boxes(await readFile(output));
    assert.ok(boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'), `MP4 top-level boxes: ${boxes}`);
    assert.ok(!boxes.includes('moof'), 'download should be ordinary MP4 rather than fragmented MP4');
    const report = verifyRecording({ path: output, width: 640, height: 360, expectedDurationSec: 4, minimumFps: 29, requireContinuousVideo: true, requireDynamic: true, requireAudible: true });
    assert.equal(report.passed, true, report.failures.join('\n'));
    await writeFile(resolve(destination, 'verification.json'), JSON.stringify({ codec: { video: video.codec_name, pixelFormat: video.pix_fmt, audio: audio.codec_name, profile: audio.profile }, boxes, videoBitstreamPreserved: true, ...report }, null, 2));
  } finally {
    await browser?.close();
    await server.close();
  }
});
