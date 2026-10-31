import { expect, test, type Page } from './fixtures/auth';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectValue } from './helpers';

const evidence = resolve('.context/results/editor-review');
const snapshot = (page: Page): Promise<any> => page.evaluate(() => (window as any).__recorderTest);
const selectedScene = async (page: Page) => {
  const state = await snapshot(page);
  return state.project.scenes.find((scene: any) => scene.id === state.project.selectedSceneId);
};
async function ready(page: Page) {
  await page.goto('/app?test=1', { waitUntil: 'networkidle' });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
}
async function prepare(page: Page) {
  await page.getByTestId('settings-trigger').click();
  await selectValue(page, 'source-mode-select', 'test');
  await selectValue(page, 'resolution-select', '360');
  await selectValue(page, 'fps-select', '30');
  await page.getByTestId('prepare-inputs').click();
  await expect.poll(async () => {
    const state = await snapshot(page);
    expect(state.error).toBeFalsy();
    return state.status;
  }).toBe('ready');
  await expect(page.getByTestId('prepare-inputs')).toBeEnabled();
  await page.keyboard.press('Escape');
}
async function number(page: Page, id: string, value: string) {
  await page.getByTestId(id).fill(value);
  await page.getByTestId(id).press('Enter');
}
async function addText(page: Page) {
  const before = (await selectedScene(page)).appearance.layers.map((layer: any) => layer.id);
  await page.getByTestId('add-source').click();
  await page.getByRole('menuitem', { name: 'Texto', exact: true }).click();
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.length).toBe(before.length + 1);
  const layer = (await selectedScene(page)).appearance.layers.find((item: any) => !before.includes(item.id));
  await page.getByTestId(`layer-select-${layer.id}`).click();
  return layer.id as string;
}
async function coloredPixels(page: Page, orientation: string, color: [number, number, number]) {
  return page.getByTestId(`${orientation}-preview`).evaluate((canvas: HTMLCanvasElement, target) => {
    const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0, sumX = 0, sumY = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (target.every((channel, offset) => Math.abs(image.data[index + offset] - channel) < 12)) {
        count++;
        sumX += (index / 4 % canvas.width) / canvas.width;
        sumY += Math.floor(index / 4 / canvas.width) / canvas.height;
      }
    }
    return { count, x: count ? sumX / count : 0, y: count ? sumY / count : 0 };
  }, color);
}
async function saveResult(page: Page, orientation: string, prefix: string) {
  const output = await page.evaluate(async orientation => {
    const file = (window as any).__recorderTest.result[orientation];
    return { bytes: [...new Uint8Array(await file.blob.arrayBuffer())], mimeType: file.mimeType };
  }, orientation);
  const path = resolve(evidence, `${prefix}-${orientation}.${output.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
  await writeFile(path, new Uint8Array(output.bytes));
  return path;
}
const ffmpeg = () => process.env.FFMPEG ?? resolve('.context/tools/node_modules/ffmpeg-static/ffmpeg');

test('countdown explicitly starts, stays paused after reset, and accepts empty drafts and zero', async ({ page }) => {
  await ready(page);
  await page.getByTestId('scene-countdown').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await expect.poll(async () => (await snapshot(page)).countdown.running).toBe(false);
  await selectValue(page, 'countdown-duration', 'custom');
  await number(page, 'countdown-custom-minutes', '0.15');
  const paused = (await snapshot(page)).countdown.remainingSeconds;
  await page.waitForTimeout(1150);
  expect((await snapshot(page)).countdown.remainingSeconds).toBe(paused);
  await page.getByTestId('countdown-toggle').click();
  await expect.poll(async () => (await snapshot(page)).countdown.remainingSeconds).toBeLessThan(paused);
  await page.getByTestId('countdown-reset').click();
  expect((await snapshot(page)).countdown).toEqual({ remainingSeconds: 9, running: false });
  await page.waitForTimeout(1100);
  expect((await snapshot(page)).countdown.remainingSeconds).toBe(9);
  await page.getByTestId('countdown-custom-minutes').fill('');
  await expect(page.getByTestId('countdown-custom-minutes')).toHaveValue('');
  await page.getByTestId('countdown-custom-minutes').fill('0');
  await page.getByTestId('countdown-custom-minutes').press('Enter');
  expect((await snapshot(page)).countdown).toEqual({ remainingSeconds: 0, running: false });
  await expect(page.getByTestId('countdown-toggle')).toBeDisabled();
  await number(page, 'countdown-custom-minutes', '0.2');
  await page.getByTestId('countdown-custom-minutes').fill('3');
  await page.getByTestId('countdown-custom-minutes').press('Escape');
  await expect(page.getByTestId('countdown-custom-minutes')).toHaveValue('0.2');
  await page.getByTestId('countdown-toggle').click();
  await page.getByTestId('countdown-zero').click();
  expect((await snapshot(page)).countdown).toEqual({ remainingSeconds: 0, running: false });
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'countdown.json'), JSON.stringify(await snapshot(page), null, 2));
});

test('duplicate text layers keep independent content, style and orientation geometry, with keyboard sorting', async ({ page }) => {
  await ready(page);
  await prepare(page);
  const firstId = await addText(page);
  await page.getByTestId('layer-text').fill('LARANJA');
  await number(page, 'layer-font-size', '110');
  await page.getByRole('radio', { name: 'Cor do texto: laranja', exact: true }).click();
  await number(page, 'layer-x', '10');
  await number(page, 'layer-y', '10');
  await number(page, 'layer-width', '70');
  await number(page, 'layer-height', '30');
  const secondId = await addText(page);
  await page.getByTestId('layer-text').fill('VIOLETA');
  await number(page, 'layer-font-size', '88');
  await page.getByRole('radio', { name: 'Cor do texto: violeta', exact: true }).click();
  await number(page, 'layer-x', '10');
  await number(page, 'layer-y', '60');
  await number(page, 'layer-width', '70');
  await number(page, 'layer-height', '30');
  for (const orientation of ['landscape', 'portrait']) {
    await expect.poll(async () => (await coloredPixels(page, orientation, [255, 64, 0])).count).toBeGreaterThan(20);
    await expect.poll(async () => (await coloredPixels(page, orientation, [136, 96, 238])).count).toBeGreaterThan(20);
  }
  await page.getByTestId(`layer-select-${firstId}`).click();
  await expect(page.getByTestId('layer-text')).toHaveValue('LARANJA');
  await expect(page.getByTestId('layer-font-size')).toHaveValue('110');
  await page.getByRole('radio', { name: 'Editar formato vertical', exact: true }).click();
  await number(page, 'layer-x', '20');
  await number(page, 'layer-y', '40');
  await number(page, 'layer-width', '60');
  await number(page, 'layer-height', '20');
  let first = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === firstId);
  expect(first.frames.landscape).toEqual({ x: .1, y: .1, width: .7, height: .3 });
  expect(first.frames.portrait).toEqual({ x: .2, y: .4, width: .6, height: .2 });
  await expect.poll(async () => (await coloredPixels(page, 'landscape', [255, 64, 0])).y).toBeLessThan(.4);
  await expect.poll(async () => (await coloredPixels(page, 'portrait', [255, 64, 0])).y).toBeGreaterThan(.4);
  await page.getByRole('radio', { name: 'Editar formato horizontal', exact: true }).click();
  const body = await page.getByTestId(`canvas-layer-landscape-${firstId}`).boundingBox();
  expect(body).toBeTruthy();
  await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);
  await page.mouse.down();
  await page.mouse.move(body!.x + body!.width / 2 + 20, body!.y + body!.height / 2 - 10, { steps: 7 });
  await page.mouse.up();
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === firstId).frames.landscape.x).toBeGreaterThan(.1);
  const moved = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === firstId).frames.landscape;
  const resize = await page.getByTestId('resize-landscape-se').boundingBox();
  expect(resize).toBeTruthy();
  await page.mouse.move(resize!.x + resize!.width / 2, resize!.y + resize!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize!.x + resize!.width / 2 + 20, resize!.y + resize!.height / 2 + 10, { steps: 7 });
  await page.mouse.up();
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === firstId).frames.landscape.width).toBeGreaterThan(moved.width);
  first = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === firstId);
  expect(first.frames.portrait).toEqual({ x: .2, y: .4, width: .6, height: .2 });
  const before = (await selectedScene(page)).appearance.layers.map((layer: any) => layer.id);
  const handle = page.getByTestId(`layer-drag-${firstId}`);
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: 'Sobre' })).toBeVisible();
  await page.waitForTimeout(180);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.map((layer: any) => layer.id)).not.toEqual(before);
  const second = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === secondId);
  expect(second.text).toBe('VIOLETA');
  expect(second.fontSize).toBe(88);
  expect(second.color).toBe('#8860ee');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, 'independent-text.png'), fullPage: true });
  await page.getByTestId('start-recording').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('recording');
  await page.waitForTimeout(1800);
  await page.getByTestId('stop-recording').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('complete');
  const recordedPixels: any[] = [];
  for (const orientation of ['landscape', 'portrait']) {
    const path = await saveResult(page, orientation, 'independent-text');
    const width = orientation === 'landscape' ? 640 : 360;
    const height = orientation === 'landscape' ? 360 : 640;
    const decoded = spawnSync(ffmpeg(), ['-v', 'error', '-ss', '0.6', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    expect(decoded.status, decoded.stderr.toString()).toBe(0);
    expect(decoded.stdout.length).toBe(width * height * 3);
    let orange = 0, violet = 0, orangeY = 0;
    for (let index = 0; index < decoded.stdout.length; index += 3) {
      const [r, g, b] = decoded.stdout.subarray(index, index + 3);
      if (r > 210 && g > 35 && g < 95 && b < 45) { orange++; orangeY += Math.floor(index / 3 / width) / height; }
      if (r > 100 && r < 175 && g > 55 && g < 140 && b > 190) violet++;
    }
    expect(orange).toBeGreaterThan(20);
    expect(violet).toBeGreaterThan(20);
    const y = orangeY / orange;
    if (orientation === 'landscape') expect(y).toBeLessThan(.4);
    else expect(y).toBeGreaterThan(.4);
    recordedPixels.push({ orientation, orange, violet, orangeY: y, path });
  }
  await writeFile(resolve(evidence, 'recorded-text-pixels.json'), JSON.stringify(recordedPixels, null, 2));
  await page.reload({ waitUntil: 'networkidle' });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
  const restored = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === firstId);
  expect(restored.frames).toEqual(first.frames);
  expect(restored.text).toBe('LARANJA');
});

test('scene mute and gain restore independently while raw signal warns and saved audio respects mute', async ({ page }) => {
  await ready(page);
  await prepare(page);
  await number(page, 'microphone-gain-number', '-6');
  await page.getByTestId('scene-camera-zoom').click();
  await number(page, 'microphone-gain-number', '3');
  await page.getByTestId('microphone-mute').click();
  await page.getByTestId('scene-camera').click();
  await expect(page.getByTestId('microphone-gain-number')).toHaveValue('-6');
  await expect(page.getByTestId('microphone-mute')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('start-recording').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('recording');
  await page.waitForTimeout(1800);
  await page.getByTestId('scene-camera-zoom').click();
  const mutedAt = (await snapshot(page)).metrics.elapsedMs / 1000;
  await expect(page.getByTestId('microphone-gain-number')).toHaveValue('3');
  await expect(page.getByTestId('microphone-mute')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await snapshot(page)).metrics.rawMicLevel).toBeGreaterThan(.01);
  await expect.poll(async () => (await snapshot(page)).metrics.audioLevel).toBeLessThan(.0001);
  await expect(page.getByTestId('muted-speech-alert')).toBeVisible();
  await page.getByTestId('muted-speech-alert').getByRole('button', { name: 'Agora não', exact: true }).click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('muted-speech-alert')).toHaveCount(0);
  const restoredAt = (await snapshot(page)).metrics.elapsedMs / 1000;
  await page.getByTestId('scene-camera').click();
  await page.waitForTimeout(1800);
  await page.getByTestId('stop-recording').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('complete');
  await mkdir(evidence, { recursive: true });
  const audioReport: any[] = [];
  for (const orientation of ['landscape', 'portrait']) {
    const path = await saveResult(page, orientation, 'scene-audio');
    const rms = (start: number) => {
      const decode = spawnSync(ffmpeg(), ['-v', 'error', '-ss', String(start), '-i', path, '-t', '0.45', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
      expect(decode.status, decode.stderr.toString()).toBe(0);
      let energy = 0;
      for (let index = 0; index + 3 < decode.stdout.length; index += 4) energy += decode.stdout.readFloatLE(index) ** 2;
      return Math.sqrt(energy / (decode.stdout.length / 4));
    };
    const audible = rms(.65), muted = rms(mutedAt + .6), restored = rms(restoredAt + .6);
    expect(audible).toBeGreaterThan(.005);
    expect(muted).toBeLessThan(.0001);
    expect(restored).toBeGreaterThan(.005);
    audioReport.push({ orientation, audible, muted, restored, mutedAt, restoredAt, path });
  }
  await writeFile(resolve(evidence, 'scene-audio.json'), JSON.stringify(audioReport, null, 2));
});

test('replacing selected media preserves its sibling, geometry reset and persisted assets', async ({ page }) => {
  await ready(page);
  await prepare(page);
  const image = async (color: string, name: string) => ({ name, mimeType: 'image/png', buffer: Buffer.from(await page.evaluate(async color => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    return [...new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))).arrayBuffer())];
  }, color)) });
  await page.getByTestId('media-file-input').setInputFiles(await image('#10e060', 'Verde.png'));
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.filter((layer: any) => layer.kind === 'screen').length).toBe(1);
  const first = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.kind === 'screen');
  await page.getByTestId(`layer-select-${first.id}`).click();
  await number(page, 'layer-x', '5');
  await number(page, 'layer-y', '5');
  await number(page, 'layer-width', '40');
  await number(page, 'layer-height', '40');
  const originalLandscape = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === first.id).frames.landscape;
  await page.getByRole('radio', { name: 'Editar formato vertical', exact: true }).click();
  await number(page, 'layer-x', '20');
  await page.getByRole('button', { name: 'Restaurar enquadramento', exact: true }).click();
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === first.id).frames?.portrait).toBeUndefined();
  expect((await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === first.id).frames.landscape).toEqual(originalLandscape);
  await page.getByRole('radio', { name: 'Editar formato horizontal', exact: true }).click();
  await page.getByTestId('add-source').click();
  await page.getByRole('menuitem', { name: 'Importar imagem ou vídeo', exact: true }).click();
  await page.getByTestId('media-file-input').setInputFiles(await image('#1260e0', 'Azul.png'));
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.filter((layer: any) => layer.kind === 'screen').length).toBe(2);
  const second = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.kind === 'screen' && layer.id !== first.id);
  await page.getByTestId(`layer-select-${second.id}`).click();
  await number(page, 'layer-x', '50');
  await number(page, 'layer-y', '55');
  await number(page, 'layer-width', '40');
  await number(page, 'layer-height', '40');
  await page.getByTestId(`layer-select-${first.id}`).click();
  await page.getByTestId('replace-layer-source').click();
  const picker = page.getByRole('dialog', { name: 'Conteúdo da camada', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: /^Imagem ou vídeo/ })).toBeVisible();
  await expect(picker.getByRole('button', { name: /^Compartilhar tela/ })).toBeVisible();
  await expect(picker.getByRole('button', { name: /^Câmera/ })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: /^Microfone/ })).toHaveCount(0);
  await expect(picker.locator('.source-options > button')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('replace-layer-source')).toBeFocused();
  await page.getByTestId('replace-layer-source').click();
  await expect(picker).toBeVisible();
  await page.getByTestId('media-file-input').setInputFiles(await image('#e02020', 'Vermelho.png'));
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === first.id).sourceId).not.toBe(first.sourceId);
  const replaced = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === first.id);
  const untouched = (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === second.id);
  expect(untouched.sourceId).toBe(second.sourceId);
  expect(untouched.assetId).toBe(second.assetId);
  expect(replaced.frames.landscape).toEqual(originalLandscape);
  for (const orientation of ['landscape', 'portrait']) {
    await expect.poll(async () => (await coloredPixels(page, orientation, [224, 32, 32])).count).toBeGreaterThan(100);
    await expect.poll(async () => (await coloredPixels(page, orientation, [18, 96, 224])).count).toBeGreaterThan(100);
    expect((await coloredPixels(page, orientation, [16, 224, 96])).count).toBe(0);
  }
  await page.getByTestId('scene-camera-zoom').click();
  await expect.poll(async () => (await coloredPixels(page, 'landscape', [224, 32, 32])).count).toBe(0);
  await page.getByTestId('scene-camera').click();
  await expect.poll(async () => (await coloredPixels(page, 'landscape', [224, 32, 32])).count).toBeGreaterThan(100);
  await page.reload({ waitUntil: 'networkidle' });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
  await prepare(page);
  for (const color of [[224, 32, 32], [18, 96, 224]] as [number, number, number][]) await expect.poll(async () => (await coloredPixels(page, 'landscape', color)).count).toBeGreaterThan(100);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, 'independent-media.png'), fullPage: true });
});

test('scene schematics remain static and collapsed navigation exposes tooltips and project actions', async ({ page }) => {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.drawImage;
    (window as any).__scenePreviewDraws = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      if ((this.canvas as HTMLCanvasElement).dataset?.testid?.startsWith('scene-preview-')) (window as any).__scenePreviewDraws++;
      return (original as any).apply(this, args);
    };
  });
  await ready(page);
  await prepare(page);
  await expect(page.getByTestId('scene-preview-camera').locator('svg')).toHaveCount(1);
  await expect(page.getByTestId('scene-preview-camera').locator('canvas')).toHaveCount(0);
  const markup = await page.getByTestId('scene-preview-countdown').innerHTML();
  await page.waitForTimeout(2200);
  expect(await page.getByTestId('scene-preview-countdown').innerHTML()).toBe(markup);
  expect(await page.evaluate(() => (window as any).__scenePreviewDraws)).toBe(0);
  await page.getByRole('button', { name: 'Recolher menu', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/);
  await expect.poll(async () => (await page.locator('.app-sidebar').boundingBox())!.width).toBeLessThan(100);
  const project = (await snapshot(page)).project;
  const projectButton = page.getByTestId(`project-nav-${project.id}`);
  await projectButton.focus();
  await expect(page.getByRole('tooltip', { name: project.name, exact: true })).toBeVisible();
  await projectButton.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Renomear projeto', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Renomear projeto' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(projectButton).toBeFocused();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, 'collapsed-sidebar.png'), fullPage: true });
});

test('reduced motion preserves switch geometry and nested select dismisses before its dialog', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await prepare(page);
  const shadow = page.getByTestId('camera-shadow');
  const before = await shadow.locator('.ui-switch-thumb').evaluate(element => element.getBoundingClientRect().x);
  await shadow.check();
  const after = await shadow.locator('.ui-switch-thumb').evaluate(element => element.getBoundingClientRect().x);
  expect(after - before).toBeGreaterThan(10);
  await page.getByTestId('settings-trigger').click();
  await page.getByTestId('resolution-select').click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Preferências', exact: true })).toBeVisible();
  await expect(page.getByTestId('resolution-select')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('settings-trigger')).toBeFocused();
});

test('scene microphone device choices restore exact input constraints and incompatible live switches are blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const fixtureIds = ['fixture-mic-a', 'fixture-mic-b'];
    (window as any).__fixtureMicRequests = [];
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [...await enumerate(), ...fixtureIds.map((deviceId, index) => ({
      deviceId, groupId: 'fixture-group', kind: 'audioinput', label: `Microfone de teste ${index + 1}`, toJSON: () => ({}),
    } as MediaDeviceInfo))];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const audio = typeof constraints?.audio === 'object' ? constraints.audio : undefined;
      const selected = typeof audio?.deviceId === 'object' ? audio.deviceId.exact : audio?.deviceId;
      const id = Array.isArray(selected) ? selected[0] : selected;
      if (constraints?.audio) (window as any).__fixtureMicRequests.push(id ?? 'default');
      const next = { ...constraints };
      if (fixtureIds.includes(String(id)) && audio) { const mapped = { ...audio }; delete mapped.deviceId; next.audio = mapped; }
      const stream = await capture(next);
      for (const track of stream.getAudioTracks()) {
        const settings = track.getSettings.bind(track);
        Object.defineProperty(track, 'getSettings', { value: () => ({ ...settings(), deviceId: id ?? 'default' }) });
      }
      return stream;
    };
  });
  await ready(page);
  await prepare(page);
  const chooseMicrophone = async (id: string) => {
    await page.getByRole('button', { name: 'Escolher microfone', exact: true }).click();
    await selectValue(page, 'microphone-device-select', id);
    await page.getByRole('dialog', { name: 'Seu microfone', exact: true }).getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await snapshot(page)).config.microphoneDeviceId).toBe(id);
  };
  await chooseMicrophone('fixture-mic-a');
  await page.getByTestId('scene-camera-zoom').click();
  await expect.poll(async () => (await snapshot(page)).project.selectedSceneId).toBe('camera-zoom');
  await chooseMicrophone('fixture-mic-b');
  await page.getByTestId('scene-camera').click();
  await expect.poll(async () => (await snapshot(page)).project.selectedSceneId).toBe('camera');
  await expect.poll(async () => (await snapshot(page)).config.microphoneDeviceId).toBe('fixture-mic-a');
  expect((await selectedScene(page)).appearance.microphoneDeviceId).toBe('fixture-mic-a');
  const state = await snapshot(page);
  expect(state.project.scenes.find((scene: any) => scene.id === 'camera-zoom').appearance.microphoneDeviceId).toBe('fixture-mic-b');
  const requests = await page.evaluate(() => (window as any).__fixtureMicRequests);
  expect(requests).toEqual(['fixture-mic-a', 'default', 'fixture-mic-b', 'fixture-mic-a']);
  await page.getByTestId('start-recording').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('recording');
  await page.getByTestId('scene-camera-zoom').click();
  expect((await snapshot(page)).project.selectedSceneId).toBe('camera');
  expect((await snapshot(page)).config.microphoneDeviceId).toBe('fixture-mic-a');
  await expect(page.getByRole('alert').filter({ hasText: 'Para trocar os dispositivos desta cena' })).toContainText('só podem ser conectados antes de iniciar uma nova tomada');
  expect(await page.evaluate(() => (window as any).__fixtureMicRequests)).toEqual(requests);
  await page.waitForTimeout(900);
  await page.getByTestId('stop-recording').click();
  await expect.poll(async () => (await snapshot(page)).status).toBe('complete');
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, 'scene-microphone-devices.json'), JSON.stringify({ requests, beforeRecording: state, afterRecording: await snapshot(page) }, null, 2));
});
