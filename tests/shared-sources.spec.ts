import { test, expect, type Page } from './fixtures/auth';
import type { Project } from '../src/projects/store';
import { mkdir } from 'node:fs/promises';

type ProjectSource = { id: string; kind: 'camera' | 'screen' | 'media'; name: string };
type SourceProject = Project & { sources: ProjectSource[] };
type Snapshot = { ready: boolean; status: string; error?: string; project: SourceProject };

const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => (window as any).__recorderTest);
const screenLayer = (project: SourceProject, sceneId: string) =>
  project.scenes.find(scene => scene.id === sceneId)!.appearance!.layers.find(layer => layer.kind === 'screen')!;
const displayRequests = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).__displayCaptureRequests);
const displayTracks = (page: Page): Promise<MediaStreamTrackState[][]> =>
  page.evaluate(() => (window as any).__displayCaptureStreams.map((stream: MediaStream) =>
    stream.getTracks().map(track => track.readyState)));
const cameraCaptures = (page: Page): Promise<Array<{ id: string; state: MediaStreamTrackState }>> =>
  page.evaluate(() => (window as any).__cameraCaptureStreams.flatMap((stream: MediaStream) =>
    stream.getVideoTracks().map(track => ({ id: track.id, state: track.readyState }))));

async function normalStudio(page: Page, autoPreview = true) {
  await page.context().grantPermissions(['camera', 'microphone']);
  await page.addInitScript(autoPreview => {
    const state = window as any;
    state.__displayCaptureRequests = 0;
    state.__displayCaptureStreams = [];
    state.__displayCaptureCanvases = [];
    state.__cameraCaptureStreams = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints);
      state.__cameraCaptureStreams.push(stream);
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const colors = ['#2060e0', '#e03020', '#20b080'];
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 225;
      const paint = canvas.getContext('2d')!;
      paint.fillStyle = colors[state.__displayCaptureRequests % colors.length];
      paint.fillRect(0, 0, canvas.width, canvas.height);
      state.__displayCaptureRequests++;
      const stream = canvas.captureStream(30);
      state.__displayCaptureCanvases.push(canvas);
      state.__displayCaptureStreams.push(stream);
      return stream;
    };
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async descriptor =>
      descriptor.name === 'camera' || descriptor.name === 'microphone'
        ? { state: autoPreview ? 'granted' : 'prompt' } as PermissionStatus
        : query(descriptor);
  }, autoPreview);
  // Seed only ordinary saved settings. Diagnostic media could hide a missing binding.
  await page.goto('/', { waitUntil: 'networkidle' });
  const projectId = await page.evaluate(async () => {
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0];
    project.settings = { ...project.settings, resolution: '360', fps: 30, source: 'camera' };
    store.saveProject(project);
    return project.id;
  });
  await page.goto(`/app#project/${projectId}`, { waitUntil: 'networkidle' });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
  await expect.poll(async () => (await snapshot(page))?.status).toBe(autoPreview ? 'ready' : 'idle');
  expect((await snapshot(page)).error).toBeFalsy();
}

async function switchScene(page: Page, sceneId: string) {
  await page.getByTestId(`scene-${sceneId}`).click();
  await expect.poll(async () => (await snapshot(page)).project.selectedSceneId).toBe(sceneId);
  await expect(page.locator('.scene-inspector')).not.toHaveAttribute('aria-busy', 'true');
}

async function openScreenPicker(page: Page, layerId: string) {
  await page.getByTestId(`layer-select-${layerId}`).click();
  await page.getByTestId('replace-layer-source').click();
  const picker = page.getByRole('dialog', { name: 'Conteúdo da camada', exact: true });
  await expect(picker).toBeVisible();
  return picker;
}

async function shareFirstScreen(page: Page, activateEmptyStage = false) {
  await switchScene(page, 'screen');
  const layer = screenLayer((await snapshot(page)).project, 'screen');
  if (activateEmptyStage) {
    expect(await displayRequests(page)).toBe(0);
    expect(await cameraCaptures(page)).toHaveLength(0);
    await page.getByTestId('activate-camera').click();
  } else {
    const picker = await openScreenPicker(page, layer.id);
    await picker.getByRole('button', { name: /^Compartilhar tela/ }).click();
    await expect(picker).toHaveCount(0);
  }
  await expect.poll(() => displayRequests(page)).toBe(1);
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  const project = (await snapshot(page)).project;
  const sourceId = screenLayer(project, 'screen').sourceId!;
  expect(sourceId).toBeTruthy();
  expect(sourceId).toBe(layer.sourceId);
  expect(project.sources.find(source => source.id === sourceId)?.kind).toBe('screen');
  expect(project.sources.filter(source => source.kind === 'screen')).toHaveLength(1);
  return sourceId;
}

async function expectPixels(page: Page, target: [number, number, number]) {
  for (const orientation of ['landscape', 'portrait']) {
    await expect.poll(() => page.getByTestId(`${orientation}-preview`).evaluate((canvas: HTMLCanvasElement, color) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let matches = 0;
      for (let y = 0; y < canvas.height; y += 4) for (let x = 0; x < canvas.width; x += 4) {
        const offset = (y * canvas.width + x) * 4;
        if (color.every((channel, index) => Math.abs(pixels[offset + index] - channel) < 8)) matches++;
      }
      return matches;
    }, target), { message: `${orientation} renders the selected shared source` }).toBeGreaterThan(80);
  }
}

test('scene templates reuse one display while additional displays remain distinct and all captures close with the project', async ({ page }) => {
  await normalStudio(page, false);
  const firstSource = await shareFirstScreen(page, true);
  await expectPixels(page, [32, 96, 224]);
  await switchScene(page, 'screen-3d');
  expect(screenLayer((await snapshot(page)).project, 'screen-3d').sourceId).toBe(firstSource);
  await expectPixels(page, [32, 96, 224]);
  await switchScene(page, 'screen');
  await expectPixels(page, [32, 96, 224]);
  expect(await displayRequests(page)).toBe(1);
  expect(await displayTracks(page)).toEqual([['live']]);

  const originalLayers = (await snapshot(page)).project.scenes.find(scene => scene.id === 'screen')!.appearance!.layers;
  await page.getByTestId('add-source').click();
  await page.getByRole('menuitem', { name: 'Tela ou mídia', exact: true }).click();
  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /^Compartilhar tela/ }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => displayRequests(page)).toBe(2);
  const project = (await snapshot(page)).project;
  const additionalLayer = project.scenes.find(scene => scene.id === 'screen')!.appearance!.layers.find(layer =>
    layer.kind === 'screen' && !originalLayers.some(original => original.id === layer.id))!;
  expect(additionalLayer.sourceId).toBeTruthy();
  expect(additionalLayer.sourceId).not.toBe(firstSource);
  expect(screenLayer(project, 'screen').sourceId).toBe(firstSource);
  expect(project.sources.filter(source => source.kind === 'screen').map(source => source.id).sort())
    .toEqual([firstSource, additionalLayer.sourceId!].sort());
  await expectPixels(page, [32, 96, 224]);
  await expectPixels(page, [224, 48, 32]);

  await switchScene(page, 'screen-3d');
  const presentationLayer = screenLayer((await snapshot(page)).project, 'screen-3d');
  const beforeFrames = structuredClone(presentationLayer.frames);
  const reusePicker = await openScreenPicker(page, presentationLayer.id);
  await expect(reusePicker.getByText('Fontes do projeto', { exact: true })).toBeVisible();
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({ path: '.context/screenshots/shared-project-sources.png', fullPage: true });
  await reusePicker.getByTestId(`source-use-${additionalLayer.sourceId}`).click();
  await expect(reusePicker).toHaveCount(0);
  await expectPixels(page, [224, 48, 32]);
  expect(screenLayer((await snapshot(page)).project, 'screen-3d').frames).toEqual(beforeFrames);
  expect(screenLayer((await snapshot(page)).project, 'screen').sourceId).toBe(firstSource);
  expect(await displayRequests(page)).toBe(2);

  const restorePicker = await openScreenPicker(page, presentationLayer.id);
  await restorePicker.getByTestId(`source-use-${firstSource}`).click();
  await expect(restorePicker).toHaveCount(0);
  await expectPixels(page, [32, 96, 224]);
  expect(await displayRequests(page)).toBe(2);

  await switchScene(page, 'screen');
  const originalLayer = screenLayer((await snapshot(page)).project, 'screen');
  await page.getByTestId(`layer-select-${originalLayer.id}`).click();
  await page.getByRole('button', { name: 'Remover camada', exact: true }).click();
  await switchScene(page, 'screen-3d');
  await expectPixels(page, [32, 96, 224]);
  expect(await displayTracks(page)).toEqual([['live'], ['live']]);

  await page.getByRole('button', { name: 'Todos os projetos', exact: true }).first().click();
  await expect.poll(() => displayTracks(page)).toEqual([['ended'], ['ended']]);
  await expect.poll(() => page.evaluate(() => (window as any).__cameraCaptureStreams.every((stream: MediaStream) =>
    stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('saved source identities survive reload and reconnecting an offline source updates every referencing scene without extra prompts', async ({ page }) => {
  await normalStudio(page);
  const sourceId = await shareFirstScreen(page);
  await switchScene(page, 'screen-3d');
  const before = (await snapshot(page)).project;
  const source = before.sources.find(candidate => candidate.id === sourceId)!;
  expect(screenLayer(before, 'screen-3d').sourceId).toBe(sourceId);

  await page.reload({ waitUntil: 'networkidle' });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
  await expect.poll(async () => (await snapshot(page))?.status).toBe('ready');
  const restored = (await snapshot(page)).project;
  expect(restored.sources.find(candidate => candidate.id === sourceId)).toEqual(source);
  expect(screenLayer(restored, 'screen').sourceId).toBe(sourceId);
  expect(screenLayer(restored, 'screen-3d').sourceId).toBe(sourceId);
  expect(await displayRequests(page)).toBe(0);

  await switchScene(page, 'screen-3d');
  expect(await displayRequests(page)).toBe(0);
  const picker = await openScreenPicker(page, screenLayer(restored, 'screen-3d').id);
  await picker.getByTestId(`source-use-${sourceId}`).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => displayRequests(page)).toBe(1);
  await expectPixels(page, [32, 96, 224]);
  expect((await snapshot(page)).project.sources.filter(candidate => candidate.kind === 'screen')).toEqual([source]);
  await switchScene(page, 'screen');
  await expectPixels(page, [32, 96, 224]);
  expect(screenLayer((await snapshot(page)).project, 'screen').sourceId).toBe(sourceId);
  expect(await displayRequests(page)).toBe(1);
});

test('adding a second camera creates a distinct capture and existing cameras can be reused across scenes', async ({ page }) => {
  await normalStudio(page);
  const before = (await snapshot(page)).project;
  const originalLayers = before.scenes.find(scene => scene.id === 'camera')!.appearance!.layers;
  const primaryCamera = originalLayers.find(layer => layer.kind === 'camera')!;
  expect(primaryCamera.sourceId).toBeTruthy();
  expect(before.sources.filter(source => source.kind === 'camera')).toHaveLength(1);
  const originalCaptures = await cameraCaptures(page);
  expect(originalCaptures.length).toBeGreaterThan(0);

  await page.getByTestId('add-source').click();
  await page.getByRole('menuitem', { name: 'Câmera', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Sua câmera', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Conectar', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect.poll(async () => (await cameraCaptures(page)).length).toBe(originalCaptures.length + 1);
  const project = (await snapshot(page)).project;
  const addedCamera = project.scenes.find(scene => scene.id === 'camera')!.appearance!.layers.find(layer =>
    layer.kind === 'camera' && !originalLayers.some(original => original.id === layer.id))!;
  expect(addedCamera.sourceId).toBeTruthy();
  expect(addedCamera.sourceId).not.toBe(primaryCamera.sourceId);
  expect(project.sources.filter(source => source.kind === 'camera').map(source => source.id).sort())
    .toEqual([primaryCamera.sourceId!, addedCamera.sourceId!].sort());
  const captures = await cameraCaptures(page);
  expect(captures.every(track => track.state === 'live')).toBe(true);
  expect(new Set(captures.map(track => track.id)).size).toBe(captures.length);

  await switchScene(page, 'camera-zoom');
  const zoomCamera = (await snapshot(page)).project.scenes.find(scene => scene.id === 'camera-zoom')!.appearance!.layers
    .find(layer => layer.kind === 'camera')!;
  expect(zoomCamera.sourceId).toBe(primaryCamera.sourceId);
  expect((await cameraCaptures(page)).length).toBe(captures.length);
  await page.getByTestId(`layer-select-${zoomCamera.id}`).click();
  await page.getByTestId('replace-layer-source').click();
  const reusePicker = page.getByRole('dialog', { name: 'Sua câmera', exact: true });
  await expect(reusePicker).toBeVisible();
  await reusePicker.getByTestId(`source-use-${addedCamera.sourceId}`).click();
  await expect(reusePicker).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).project.scenes.find(scene => scene.id === 'camera-zoom')!.appearance!.layers
    .find(layer => layer.kind === 'camera')!.sourceId).toBe(addedCamera.sourceId);
  expect((await cameraCaptures(page)).length).toBe(captures.length);
  expect((await snapshot(page)).project.scenes.find(scene => scene.id === 'camera')!.appearance!.layers
    .find(layer => layer.id === primaryCamera.id)!.sourceId).toBe(primaryCamera.sourceId);

  // An inactive primary camera ending must not tear down B, or prevent A reconnecting.
  const primaryTrackId = originalCaptures[0].id;
  const secondTrackId = captures.at(-1)!.id;
  await page.evaluate(id => {
    const track = (window as any).__cameraCaptureStreams.flatMap((stream: MediaStream) => stream.getVideoTracks())
      .find((candidate: MediaStreamTrack) => candidate.id === id);
    track.stop();
  }, primaryTrackId);
  expect((await cameraCaptures(page)).find(track => track.id === secondTrackId)?.state).toBe('live');
  await switchScene(page, 'camera');
  await expect.poll(async () => (await snapshot(page)).status).toBe('ready');
  await expect.poll(async () => (await cameraCaptures(page)).length).toBe(captures.length + 1);
  expect((await snapshot(page)).project.scenes.find(scene => scene.id === 'camera')!.appearance!.layers
    .find(layer => layer.id === primaryCamera.id)!.sourceId).toBe(primaryCamera.sourceId);
  expect((await snapshot(page)).project.sources.filter(source => source.kind === 'camera').map(source => source.id).sort())
    .toEqual([primaryCamera.sourceId!, addedCamera.sourceId!].sort());
  expect((await cameraCaptures(page)).find(track => track.id === secondTrackId)?.state).toBe('live');
  await switchScene(page, 'camera-zoom');
  expect((await snapshot(page)).project.scenes.find(scene => scene.id === 'camera-zoom')!.appearance!.layers
    .find(layer => layer.kind === 'camera')!.sourceId).toBe(addedCamera.sourceId);
  expect((await cameraCaptures(page)).length).toBe(captures.length + 1);

  await page.getByRole('button', { name: 'Todos os projetos', exact: true }).first().click();
  await expect.poll(async () => (await cameraCaptures(page)).every(track => track.state === 'ended')).toBe(true);
});

test('legacy projects migrate shared source identities without losing distinct captures or authored scene settings', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const result = await page.evaluate(async () => {
    const store = await import('/src/projects/store.ts');
    const scenes = structuredClone(store.DEFAULT_PROJECT_SCENES);
    for (const scene of scenes) {
      scene.appearance!.cameraDeviceId = scene.id === 'camera-zoom' ? 'device-b' : 'device-a';
      for (const layer of scene.appearance!.layers) delete layer.sourceId;
    }
    const screen = scenes.find(scene => scene.id === 'screen')!;
    const display = screen.appearance!.layers.find(layer => layer.kind === 'screen')!;
    display.sourceId = 'legacy-display-a';
    display.frames = {
      landscape: { x: .05, y: .06, width: .86, height: .69 },
      portrait: { x: .08, y: .12, width: .82, height: .31 },
    };
    const camera = screen.appearance!.layers.find(layer => layer.kind === 'camera')!;
    camera.cameraShape = 'rounded';
    camera.cameraBorderColor = '#ff4000';
    camera.cameraBorderWidth = 4;
    camera.cameraShadow = true;
    camera.frames = { landscape: { x: .64, y: .65, width: .28, height: .28 } };
    const presentation = scenes.find(scene => scene.id === 'screen-3d')!;
    presentation.appearance!.microphoneMuted = true;
    presentation.appearance!.microphoneGainDb = -9;
    presentation.appearance!.microphoneDeviceId = 'microphone-a';
    presentation.appearance!.layers.push({
      id: 'window-custom', kind: 'screen', name: 'Segunda janela', visible: true,
      sourceId: 'legacy-display-b', fit: 'contain',
      frames: { landscape: { x: .1, y: .12, width: .44, height: .33 } },
    }, {
      id: 'title-custom', kind: 'title', name: 'Meu título', visible: true,
      text: 'Meu roteiro continua aqui', fontSize: 58, color: '#f0e0d0', align: 'left',
      frames: {
        landscape: { x: .12, y: .15, width: .5, height: .2 },
        portrait: { x: .08, y: .2, width: .84, height: .12 },
      },
    });
    const project = {
      id: 'legacy-source-project', name: 'Projeto anterior', createdAt: 1, updatedAt: 2,
      scenes, selectedSceneId: 'screen-3d',
      settings: { resolution: '360', fps: 30, source: 'camera', cameraDeviceId: 'device-a' },
    };
    // Persist the old shape directly, so saveProject cannot normalize it first.
    localStorage.setItem('grava-simples-workspace-v1', JSON.stringify({
      version: 1, sceneRevision: 3, activeProjectId: project.id,
      projects: [project], takes: [], legacyRecordingsImported: true,
    }));
    const first = store.loadProjects()[0];
    const second = store.loadProjects()[0];
    return { before: project, first, second };
  });
  const migrated = result.first as SourceProject;
  expect(migrated.selectedSceneId).toBe('screen-3d');
  expect(screenLayer(migrated, 'screen').sourceId).toBe('legacy-display-a');
  expect(screenLayer(migrated, 'screen-3d').sourceId).toBe('legacy-display-a');
  const presentation = migrated.scenes.find(scene => scene.id === 'screen-3d')!.appearance!;
  expect(presentation.layers.find(layer => layer.id === 'window-custom')!.sourceId).toBe('legacy-display-b');
  expect(migrated.sources.filter(source => source.kind === 'screen').map(source => source.id).sort())
    .toEqual(['legacy-display-a', 'legacy-display-b']);

  const cameraIds = Object.fromEntries(migrated.scenes.flatMap(scene => {
    const layer = scene.appearance!.layers.find(candidate => candidate.kind === 'camera');
    return layer ? [[scene.id, layer.sourceId]] : [];
  }));
  expect(cameraIds.camera).toBeTruthy();
  expect(cameraIds.screen).toBe(cameraIds.camera);
  expect(cameraIds['screen-3d']).toBe(cameraIds.camera);
  expect(cameraIds['camera-zoom']).toBeTruthy();
  expect(cameraIds['camera-zoom']).not.toBe(cameraIds.camera);
  expect(migrated.sources.filter(source => source.kind === 'camera')).toHaveLength(2);
  expect(migrated.sources.find(source => source.id === cameraIds.camera)).toMatchObject({ kind: 'camera', deviceId: 'device-a' });
  expect(migrated.sources.find(source => source.id === cameraIds['camera-zoom'])).toMatchObject({ kind: 'camera', deviceId: 'device-b' });

  const beforeScreen = result.before.scenes.find(scene => scene.id === 'screen')!.appearance!;
  const afterScreen = migrated.scenes.find(scene => scene.id === 'screen')!.appearance!;
  expect(afterScreen.layers.find(layer => layer.kind === 'screen')!.frames)
    .toEqual(beforeScreen.layers.find(layer => layer.kind === 'screen')!.frames);
  const beforeCamera = beforeScreen.layers.find(layer => layer.kind === 'camera')!;
  expect(afterScreen.layers.find(layer => layer.kind === 'camera'))
    .toMatchObject(beforeCamera);
  const beforePresentation = result.before.scenes.find(scene => scene.id === 'screen-3d')!.appearance!;
  for (const id of ['window-custom', 'title-custom']) {
    expect(presentation.layers.find(layer => layer.id === id))
      .toEqual(beforePresentation.layers.find(layer => layer.id === id));
  }
  expect(presentation.microphoneMuted).toBe(true);
  expect(presentation.microphoneGainDb).toBe(-9);
  expect(presentation.microphoneDeviceId).toBe('microphone-a');
  expect(result.second).toEqual(result.first);
});
