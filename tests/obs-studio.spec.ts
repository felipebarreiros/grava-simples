import { test, expect, type Page } from './fixtures/auth';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

type ObsMessage = { op: number; d: Record<string, any> };
const sha = (text: string) => createHash('sha256').update(text).digest('base64');
const localFfmpeg = resolve('.context/tools/node_modules/ffmpeg-static/ffmpeg');
const localFfprobe = resolve('.context/tools/node_modules/ffprobe-static/bin/linux/x64/ffprobe');
const ffmpeg = process.env.FFMPEG ?? (existsSync(localFfmpeg) ? localFfmpeg : 'ffmpeg');
const ffprobe = process.env.FFPROBE ?? (existsSync(localFfprobe) ? localFfprobe : 'ffprobe');

async function phone(endpoint: string, password: string) {
  const socket = new WebSocket(endpoint), messages: ObsMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  const wait = async (predicate: (message: ObsMessage) => boolean) => {
    await expect.poll(() => messages.some(predicate), { timeout: 45_000 }).toBe(true);
    return messages.find(predicate)!;
  };
  const hello = (await wait(message => message.op === 0)).d;
  socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: sha(sha(password + hello.authentication.salt) + hello.authentication.challenge), eventSubscriptions: 0x7fffffff } }));
  await wait(message => message.op === 2);
  let sequence = 0;
  const connectionId = randomBytes(8).toString('hex');
  return {
    socket,
    async request(requestType: string, requestData: Record<string, unknown> = {}) {
      const requestId = `real-studio-${connectionId}-${++sequence}`;
      socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      return (await wait(message => message.op === 7 && message.d.requestId === requestId)).d;
    },
    async close() { if (socket.readyState === WebSocket.CLOSED) return; const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.close(); await closed; },
  };
}

async function prepare(page: Page) {
  await page.route('**/obs-project-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Fixture</body></html>' }));
  await page.goto('/obs-project-fixture');
  const projectId = await page.evaluate(async () => {
    const keys = await import('/src/projects/keys.ts');
    if ('setLocalAccount' in keys) keys.setLocalAccount('user_fixture');
    const store = await import('/src/projects/store.ts');
    const item = store.loadProjects()[0];
    item.settings.resolution = '360'; item.settings.fps = 30;
    store.saveProject(item); return item.id;
  });
  await page.goto(`/app?test=1#project/${projectId}`);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  await page.evaluate(() => (window as any).__recorderTest.prepare());
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.status)).toBe('ready');
}

test('local Wi-Fi helper automatically connects, controls both recorders and preserves pairing after reload', async ({ page, baseURL }) => {
  const binary = process.env.COMPANION_BINARY ?? resolve('.context/gravasimples-companion-e2e');
  if (!process.env.COMPANION_BINARY) {
    const build = spawnSync('go', ['build', '-trimpath', '-o', binary, '.'], { cwd: resolve('companion'), encoding: 'utf8' });
    expect(build.status, build.error?.message ?? build.stderr).toBe(0);
  }
  const configDirectory = await mkdtemp(resolve(tmpdir(), 'grava-companion-'));
  const helper = spawn(binary, ['--listen', '0.0.0.0:4455', '--config', resolve(configDirectory, 'pairing.json'), '--allow-origin', new URL(baseURL!).origin], { stdio: ['ignore', 'ignore', 'pipe'] });
  let helperLog = '';
  helper.stderr.on('data', data => { helperLog = (helperLog + data.toString()).slice(-4000); });
  const clients: Awaited<ReturnType<typeof phone>>[] = [];
  let hostedRequests = 0;
  await page.route('**/api/remote**', async route => { hostedRequests++; await route.abort(); });
  await page.context().grantPermissions(['local-network-access']);
  try {
    await expect.poll(async () => {
      if (helper.exitCode !== null) throw new Error(helperLog);
      try { return (await page.request.get('http://127.0.0.1:4455/health')).status(); } catch { return 0; }
    }).toBe(200);
    await prepare(page);
    await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Controle pelo celular', exact: true });
    // No per-session activation click: the existing local permission attaches on mount.
    await expect(dialog.getByRole('status')).toContainText('Pronto para conectar o OBS Blade');
    const password = await dialog.getByLabel('Senha do OBS Blade', { exact: true }).inputValue();
    const endpoint = 'ws://127.0.0.1:4455/';
    const first = await phone(endpoint, password); clients.push(first);
    const sceneList = await first.request('GetSceneList');
    expect(sceneList.requestStatus.result).toBe(true);
    const target = sceneList.responseData.scenes.find((scene: any) => scene.sceneUuid === 'camera-zoom');
    expect(target).toBeTruthy();
    const switched = await first.request('SetCurrentProgramScene', { sceneUuid: target.sceneUuid });
    expect(switched.requestStatus.result, JSON.stringify(switched)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.project.selectedSceneId)).toBe('camera-zoom');
    const sources = await first.request('GetSceneItemList', { sceneUuid: target.sceneUuid });
    const camera = sources.responseData.sceneItems.find((item: any) => item.inputKind === 'grava_camera');
    expect(camera).toBeTruthy();
    for (const visible of [false, true]) {
      const changed = await first.request('SetSceneItemEnabled', { sceneUuid: target.sceneUuid, sceneItemId: camera.sceneItemId, sceneItemEnabled: visible });
      expect(changed.requestStatus.result, JSON.stringify(changed)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.project.scenes.find((scene: any) => scene.id === 'camera-zoom').appearance.layers.find((layer: any) => layer.kind === 'camera').visible)).toBe(visible);
    }
    expect((await first.request('SetInputMute', { inputUuid: 'grava-microphone', inputMuted: true })).requestStatus.result).toBe(true);
    expect((await first.request('StartRecord')).requestStatus.result).toBe(true);
    expect((await first.request('StartRecord')).requestStatus.result).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.status)).toBe('recording');
    await first.close();
    // Real control socket loss must leave both local encoders running.
    await page.waitForTimeout(2200);
    expect(await page.evaluate(() => (window as any).__recorderTest.status)).toBe('recording');
    const second = await phone(endpoint, password); clients.push(second);
    const status = await second.request('GetRecordStatus');
    expect(status.responseData.outputActive).toBe(true);
    expect((await second.request('SetInputMute', { inputUuid: 'grava-microphone', inputMuted: false })).requestStatus.result).toBe(true);
    await page.waitForTimeout(2200);
    expect((await second.request('StopRecord')).requestStatus.result).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.status)).toBe('complete');
    expect((await second.request('GetRecordStatus')).responseData.outputActive).toBe(false);

    const directory = resolve('.context/results/obs-blade'); await mkdir(directory, { recursive: true });
    const report: Record<string, unknown> = {};
    for (const orientation of ['landscape', 'portrait']) {
      const bytes = await page.evaluate(async orientation => [...new Uint8Array(await (window as any).__recorderTest.result[orientation].blob.arrayBuffer())], orientation);
      const path = resolve(directory, `${orientation}.mp4`); await writeFile(path, Buffer.from(bytes));
      const probe = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,width,height,nb_read_frames', '-of', 'json', path], { encoding: 'utf8' });
      expect(probe.status, probe.error?.message ?? probe.stderr).toBe(0);
      const info = JSON.parse(probe.stdout), video = info.streams.find((stream: any) => stream.codec_type === 'video');
      expect(Number(info.format.duration)).toBeGreaterThan(3);
      expect(Number(video.nb_read_frames)).toBeGreaterThan(20);
      expect(info.streams.some((stream: any) => stream.codec_type === 'audio')).toBe(true);
      expect(orientation === 'landscape' ? video.width > video.height : video.height > video.width).toBe(true);
      const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
      expect(decoded.status, decoded.error?.message ?? decoded.stderr).toBe(0);
      report[orientation] = info;
    }
    await second.close();
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__recorderTest?.ready))).toBe(true);
    await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Pronto para conectar o OBS Blade');
    await expect(dialog.getByLabel('Senha do OBS Blade', { exact: true })).toHaveValue(password);
    const third = await phone(endpoint, password); clients.push(third);
    expect((await third.request('GetSceneList')).requestStatus.result).toBe(true);
    expect(hostedRequests).toBe(0);
    await writeFile(resolve(directory, 'report.json'), JSON.stringify({ validation: 'local native helper and short synthetic browser recording; not physical iPhone or sustained FPS qualification', hostedRemoteRequests: hostedRequests, pairingSurvivedReload: true, outputs: report }, null, 2));
  } finally {
    for (const client of clients) await client.close();
    if (helper.exitCode === null) {
      const exited = new Promise<void>(resolve => helper.once('exit', () => resolve()));
      helper.kill('SIGTERM'); await exited;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test('local Wi-Fi StopRecord cancels a web-initiated countdown before either real recorder starts', async ({ page, baseURL }) => {
  const binary = process.env.COMPANION_BINARY ?? resolve('.context/gravasimples-companion-e2e');
  if (!process.env.COMPANION_BINARY) {
    const build = spawnSync('go', ['build', '-trimpath', '-o', binary, '.'], { cwd: resolve('companion'), encoding: 'utf8' });
    expect(build.status, build.error?.message ?? build.stderr).toBe(0);
  }
  const configDirectory = await mkdtemp(resolve(tmpdir(), 'grava-countdown-companion-'));
  const helper = spawn(binary, ['--listen', '0.0.0.0:4455', '--config', resolve(configDirectory, 'pairing.json'), '--allow-origin', new URL(baseURL!).origin], { stdio: ['ignore', 'ignore', 'pipe'] });
  let helperLog = '';
  helper.stderr.on('data', data => { helperLog = (helperLog + data.toString()).slice(-4000); });
  const clients: Awaited<ReturnType<typeof phone>>[] = [];
  let hostedRequests = 0;
  await page.addInitScript(() => {
    const NativeRecorder = window.MediaRecorder;
    (window as any).__remoteCountdownRecorderStarts = 0;
    (window as any).__remoteCountdownHeartbeats = 0;
    window.MediaRecorder = class extends NativeRecorder {
      start(timeslice?: number) {
        (window as any).__remoteCountdownRecorderStarts++;
        super.start(timeslice);
      }
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data);
          if (message.type === 'state' && message.snapshot?.recordingStartPending === true)
            (window as any).__remoteCountdownHeartbeats++;
        } catch { /* Only observe actual state publications; preserve transport bytes. */ }
      }
      return send.call(this, data);
    };
  });
  await page.route('**/api/remote**', async route => { hostedRequests++; await route.abort(); });
  await page.route('**/api/recordings*', route => route.fulfill({ json: { configured: false, recordings: [], usedBytes: 0, maxStorageBytes: 0 } }));
  await page.route('**/api/transcriptions*', route => route.fulfill({ json: { configured: false, status: 'idle', maxUploadBytes: 0 } }));
  await page.context().grantPermissions(['local-network-access']);
  try {
    await expect.poll(async () => {
      if (helper.exitCode !== null) throw new Error(helperLog);
      try { return (await page.request.get('http://127.0.0.1:4455/health')).status(); } catch { return 0; }
    }).toBe(200);
    await prepare(page);
    await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Controle pelo celular', exact: true });
    await expect(dialog.getByRole('status')).toContainText('Pronto para conectar o OBS Blade');
    const password = await dialog.getByLabel('Senha do OBS Blade', { exact: true }).inputValue();
    const client = await phone('ws://127.0.0.1:4455/', password); clients.push(client);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The shipped helper keeps phone StartRecord immediate. Only the web
    // Gravar action owns this countdown; the phone may cancel it with StopRecord.
    await page.getByTestId('start-recording').click();
    await expect(page.getByTestId('recording-countdown')).toContainText('3');
    expect(await page.evaluate(() => (window as any).__remoteCountdownRecorderStarts)).toBe(0);
    // This is an actual browser->helper state heartbeat during the web
    // countdown, rather than a fake transport or an optimistic recording state.
    await expect.poll(() => page.evaluate(() => (window as any).__remoteCountdownHeartbeats), { timeout: 2000, intervals: [25, 50, 100] }).toBeGreaterThan(0);
    const stats = await client.request('GetStats');
    expect(stats.requestStatus.result, JSON.stringify(stats)).toBe(true);
    expect(typeof stats.responseData.activeFps).toBe('number');
    expect(await page.evaluate(() => (window as any).__remoteCountdownRecorderStarts)).toBe(0);
    const stopResponse = await client.request('StopRecord');
    expect(stopResponse.requestStatus.result, JSON.stringify(stopResponse)).toBe(true);
    await expect(page.getByTestId('recording-countdown')).toHaveCount(0);
    await page.waitForTimeout(3300);
    expect(await page.evaluate(() => (window as any).__remoteCountdownRecorderStarts)).toBe(0);
    expect(await page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes().length)).toBe(0);
    expect((await client.request('GetRecordStatus')).responseData.outputActive).toBe(false);
    expect(hostedRequests).toBe(0);
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    for (const client of clients) await client.close();
    if (helper.exitCode === null) {
      const exited = new Promise<void>(resolve => helper.once('exit', () => resolve()));
      helper.kill('SIGTERM'); await exited;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
});
