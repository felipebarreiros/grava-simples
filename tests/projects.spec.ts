import { expect, test } from '@playwright/test';

// Exercise the real browser stores without the application's startup import
// concurrently writing to the deliberately reseeded test catalogue.
test.beforeEach(async ({ page }) => {
  await page.route('**/projects-storage-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>Project storage fixture</body></html>',
  }));
});

test('projects migrate old scenes and keep settings independent after reload', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const before = await page.evaluate(async () => {
    localStorage.clear();
    localStorage.setItem('grava-simples-project', 'Curso antigo');
    localStorage.setItem('grava-simples-scenes', JSON.stringify([{ id: 'old-camera', name: 'Minha câmera', layout: 'camera' }]));
    const store = await import('/src/projects/store.ts');
    const first = store.loadProjects()[0];
    first.settings = { resolution: '720', fps: 60, source: 'camera' };
    first.scenes[0].name = 'Cena do curso';
    store.saveProject(first);
    const second = store.createProject('Novo curso');
    second.scenes[1].zoom = 1.25;
    store.saveProject(second);
    return { first, second, active: store.getActiveProjectId() };
  });
  expect(before.first.name).toBe('Curso antigo');
  expect(before.first.scenes.map(scene => scene.layout)).toEqual(['camera', 'screen-3d', 'countdown']);
  expect(before.second.scenes).toHaveLength(5);
  expect(before.active).toBe(before.second.id);

  await page.reload();
  const after = await page.evaluate(async () => {
    const store = await import('/src/projects/store.ts');
    return { projects: store.loadProjects(), active: store.getActiveProjectId() };
  });
  const first = after.projects.find(project => project.id === before.first.id)!;
  const second = after.projects.find(project => project.id === before.second.id)!;
  expect(first.name).toBe('Curso antigo');
  expect(first.settings).toEqual({ resolution: '720', fps: 60, source: 'camera' });
  expect(first.scenes[0].name).toBe('Cena do curso');
  expect(second.settings.resolution).toBe('1080');
  expect(second.scenes[1].zoom).toBe(1.25);
  expect(after.active).toBe(second.id);
});

test('presentation fade defaults to on and preserves scene and camera overrides after reload', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const before = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const cameraOverride = store.createProject('Borda da câmera');
    const cameraScene = cameraOverride.scenes.find(scene => scene.layout === 'screen-3d')!;
    const defaults = { presentation: cameraScene.appearance!.cameraFade, camera: cameraOverride.scenes.find(scene => scene.layout === 'camera')!.appearance!.cameraFade };
    cameraScene.appearance!.layers.find(layer => layer.kind === 'camera')!.cameraFade = false;
    store.saveProject(cameraOverride);
    const sceneOverride = store.createProject('Borda da cena');
    sceneOverride.scenes.find(scene => scene.layout === 'screen-3d')!.appearance!.cameraFade = false;
    store.saveProject(sceneOverride);
    const fresh = store.createProject('Nova apresentação');
    return { defaults, cameraId: cameraOverride.id, sceneId: sceneOverride.id, freshId: fresh.id };
  });
  expect(before.defaults).toEqual({ presentation: true, camera: false });
  await page.reload();
  const after = await page.evaluate(async () => {
    const store = await import('/src/projects/store.ts');
    return store.loadProjects().map(project => {
      const appearance = project.scenes.find(scene => scene.layout === 'screen-3d')!.appearance!;
      return { id: project.id, sceneFade: appearance.cameraFade, cameraFade: appearance.layers.find(layer => layer.kind === 'camera')!.cameraFade };
    });
  });
  expect(after.find(project => project.id === before.cameraId)).toMatchObject({ sceneFade: true, cameraFade: false });
  expect(after.find(project => project.id === before.sceneId)).toMatchObject({ sceneFade: false });
  expect(after.find(project => project.id === before.freshId)).toMatchObject({ sceneFade: true });
});

for (const backend of ['opfs', 'indexeddb'] as const) {
  test(`${backend} recordings reopen after reload and deleting a project preserves other videos`, async ({ page }) => {
    await page.goto('/projects-storage-fixture');
    const before = await page.evaluate(async backend => {
      localStorage.clear();
      const projects = await import('/src/projects/store.ts');
      const storage = await import('/src/media/storage.ts');
      const first = projects.loadProjects()[0];
      const second = projects.createProject('Outro projeto');
      const original = navigator.storage.getDirectory.bind(navigator.storage);
      if (backend === 'indexeddb') Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: async () => { throw new Error('Test IndexedDB fallback'); } });
      async function persist(projectId?: string) {
        const recording = new storage.RecordingStore('video/mp4');
        await recording.open();
        await recording.write('landscape', new Blob(['landscape-chunk-one|']));
        await recording.write('landscape', new Blob(['chunk-two']));
        await recording.write('portrait', new Blob(['portrait-take']));
        const files = await recording.finalize(true);
        const makeFile = (orientation: 'landscape' | 'portrait') => ({ orientation, blob: files[orientation], url: URL.createObjectURL(files[orientation]), fileName: `${orientation}.mp4`, mimeType: 'video/mp4', size: files[orientation].size, durationMs: 12500 });
        if (projectId) await projects.saveProjectTake(projectId, { id: recording.id, landscape: makeFile('landscape'), portrait: makeFile('portrait'), startedAt: 1000, stoppedAt: 13500, warnings: [] });
        return { id: recording.id, backend: recording.kind };
      }
      const one = await persist(first.id);
      const two = await persist(second.id);
      const unassigned = await persist();
      Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: original });
      return { firstId: first.id, secondId: second.id, one, two, unassigned };
    }, backend);
    expect(before.one.backend).toBe(backend);
    expect(before.two.backend).toBe(backend);

    await page.reload();
    const after = await page.evaluate(async before => {
      const projects = await import('/src/projects/store.ts');
      const storage = await import('/src/media/storage.ts');
      const take = projects.listProjectTakes(before.firstId)[0];
      const restored = await projects.restoreProjectTake(take);
      const firstText = await restored.landscape.blob.text();
      const portraitText = await restored.portrait.blob.text();
      projects.renameProjectTake(take.id, 'Aula de abertura');
      const renamed = projects.listProjectTakes(before.firstId)[0].name;
      await projects.deleteProjectAndRecordings(before.firstId);
      const otherTake = projects.listProjectTakes(before.secondId)[0];
      const secondText = await (await projects.restoreProjectTake(otherTake)).landscape.blob.text();
      const unassignedText = await (await storage.readRecordingFiles(before.unassigned.id)).portrait.text();
      const recoverable = await storage.listRecoverableRecordings();
      return { firstText, portraitText, secondText, unassignedText, renamed, durationMs: take.durationMs, projects: projects.loadProjects().map(project => project.id), recoverable: recoverable.map(item => item.id) };
    }, before);
    expect(after.firstText).toBe('landscape-chunk-one|chunk-two');
    expect(after.portraitText).toBe('portrait-take');
    expect(after.secondText).toBe(after.firstText);
    expect(after.unassignedText).toBe('portrait-take');
    expect(after.durationMs).toBe(12500);
    expect(after.renamed).toBe('Aula de abertura');
    expect(after.projects).toEqual([before.secondId]);
    expect(after.recoverable).toContain(before.two.id);
    expect(after.recoverable).toContain(before.unassigned.id);
    expect(after.recoverable).not.toContain(before.one.id);
  });
}

test('legacy import assigns only completed videos to the original project once', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const state = await page.evaluate(async () => {
    localStorage.clear();
    const projects = await import('/src/projects/store.ts');
    const storage = await import('/src/media/storage.ts');
    const first = projects.loadProjects()[0];
    const completed = new storage.RecordingStore('video/mp4');
    await completed.open();
    await completed.write('landscape', new Blob(['old-landscape']));
    await completed.write('portrait', new Blob(['old-portrait']));
    await completed.finalize(true);
    const incomplete = new storage.RecordingStore('video/mp4');
    await incomplete.open();
    await incomplete.write('landscape', new Blob(['unfinished']));
    await incomplete.abort();
    const second = projects.createProject('Projeto mais recente');
    const imported = await projects.importLegacyRecordings();
    const importedAgain = await projects.importLegacyRecordings();
    const takes = projects.listProjectTakes(first.id);
    const restored = await projects.restoreProjectTake(takes[0]);
    return { imported, importedAgain, firstId: first.id, completedId: completed.id, takes, secondTakes: projects.listProjectTakes(second.id), text: await restored.landscape.blob.text(), recoverable: (await storage.listRecoverableRecordings()).map(item => item.id), incompleteId: incomplete.id };
  });
  expect(state.imported).toBe(1);
  expect(state.importedAgain).toBe(0);
  expect(state.takes).toHaveLength(1);
  expect(state.takes[0].id).toBe(state.completedId);
  expect(state.takes[0].projectId).toBe(state.firstId);
  expect(state.secondTakes).toEqual([]);
  expect(state.text).toBe('old-landscape');
  expect(state.recoverable).toContain(state.incompleteId);
});

test('existing projects gain scene appearance and countdown once without losing settings or takes', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const before = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0];
    project.name = 'Projeto existente';
    project.selectedSceneId = 'camera-zoom';
    project.scenes = project.scenes.filter(scene => scene.layout !== 'countdown').map(({ appearance, ...scene }) => scene);
    project.settings = { resolution: '720', fps: 60, source: 'camera', controls: { cameraZoom: 1.6, sourceVisibility: { camera: false, screen: true }, microphoneMuted: true, microphoneGainDb: -6 } };
    const legacy = { version: 1, activeProjectId: project.id, projects: [project], takes: [{ id: 'existing-video', projectId: project.id, name: 'Vídeo anterior', createdAt: 1, startedAt: 1, stoppedAt: 2, durationMs: 1, warnings: [], landscape: { fileName: 'old.mp4', mimeType: 'video/mp4', size: 100 }, portrait: { fileName: 'old-vertical.mp4', mimeType: 'video/mp4', size: 50 } }], legacyRecordingsImported: true };
    localStorage.setItem('grava-simples-workspace-v1', JSON.stringify(legacy));
    const migrated = store.loadProjects()[0];
    const takes = store.listProjectTakes(project.id);
    // A user may remove the new template; migration must not keep recreating it.
    store.saveProject({ ...migrated, scenes: migrated.scenes.filter(scene => scene.layout !== 'countdown') });
    return { migrated, takes, afterRemoval: store.loadProjects()[0] };
  });
  expect(before.migrated.name).toBe('Projeto existente');
  expect(before.migrated.selectedSceneId).toBe('camera-zoom');
  expect(before.migrated.settings.resolution).toBe('720');
  expect(before.migrated.settings.fps).toBe(60);
  expect(before.migrated.settings.controls?.microphoneMuted).toBe(true);
  expect(before.migrated.scenes.find(scene => scene.layout === 'camera')?.appearance?.layers.find(layer => layer.kind === 'camera')?.visible).toBe(false);
  expect(before.migrated.scenes).toHaveLength(5);
  expect(before.migrated.scenes.every(scene => Array.isArray(scene.appearance?.layers))).toBe(true);
  expect(before.takes[0].name).toBe('Vídeo anterior');
  expect(before.afterRemoval.scenes).toHaveLength(4);
  await page.reload();
  expect(await page.evaluate(async () => (await import('/src/projects/store.ts')).loadProjects()[0].scenes.some(scene => scene.layout === 'countdown'))).toBe(false);
});

test('project covers preserve actual pixels and survive stale project edits', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const state = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0];
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f00000'; context.fillRect(0, 0, 640, 720);
    context.fillStyle = '#0010f0'; context.fillRect(640, 0, 640, 720);
    const updated = store.captureProjectCover(project.id, canvas);
    store.saveProject({ ...project, name: 'Nome editado depois da capa' });
    const saved = store.loadProjects()[0];
    const bitmap = await createImageBitmap(await (await fetch(saved.cover!)).blob());
    const restored = document.createElement('canvas'); restored.width = bitmap.width; restored.height = bitmap.height;
    const pixels = restored.getContext('2d')!; pixels.drawImage(bitmap, 0, 0);
    return { cover: saved.cover, timestamp: saved.coverUpdatedAt, updatedCover: updated.cover, name: saved.name, width: bitmap.width, height: bitmap.height, left: [...pixels.getImageData(80, 90, 1, 1).data], right: [...pixels.getImageData(240, 90, 1, 1).data] };
  });
  expect(state.cover).toBe(state.updatedCover);
  expect(state.cover!.length).toBeLessThanOrEqual(64000);
  expect(state.timestamp).toBeGreaterThan(0);
  expect(state.name).toBe('Nome editado depois da capa');
  expect([state.width, state.height]).toEqual([320, 180]);
  expect(state.left[0]).toBeGreaterThan(220); expect(state.left[2]).toBeLessThan(25);
  expect(state.right[2]).toBeGreaterThan(220); expect(state.right[0]).toBeLessThan(25);
  await page.reload();
  expect(await page.evaluate(async () => (await import('/src/projects/store.ts')).loadProjects()[0].cover)).toBe(state.cover);
});

test('scene background images survive reload and shared images survive scene deletion', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const before = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const assets = await import('/src/projects/assets.ts');
    const project = store.loadProjects()[0];
    const second = store.createProject('Outro projeto com imagem');
    const image = document.createElement('canvas'); image.width = 64; image.height = 64;
    image.getContext('2d')!.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>(resolve => image.toBlob(blob => resolve(blob!), 'image/png'));
    const id = await assets.saveSceneAsset(project.id, 'countdown', blob);
    const otherId = await assets.saveSceneAsset(second.id, 'countdown', blob);
    project.scenes.find(scene => scene.id === 'countdown')!.appearance!.backgroundAssetId = id;
    const duplicate = structuredClone(project.scenes.find(scene => scene.id === 'countdown')!);
    duplicate.id = 'countdown-copy'; duplicate.name = 'Cópia com a mesma imagem'; project.scenes.push(duplicate);
    second.scenes.find(scene => scene.id === 'countdown')!.appearance!.backgroundAssetId = otherId;
    store.saveProject(project); store.saveProject(second);
    return { projectId: project.id, otherProjectId: second.id, id, otherId, size: blob.size };
  });
  await page.reload();
  const after = await page.evaluate(async before => {
    const store = await import('/src/projects/store.ts');
    const assets = await import('/src/projects/assets.ts');
    const restored = await assets.readSceneAsset(before.id);
    const project = store.loadProjects().find(project => project.id === before.projectId)!;
    project.scenes = project.scenes.filter(scene => scene.id !== 'countdown');
    store.saveProject(project);
    await assets.deleteSceneAssets(project.id, 'countdown');
    const shared = await assets.readSceneAsset(before.id);
    await store.deleteProjectAndRecordings(project.id);
    const deleted = await assets.readSceneAsset(before.id);
    const other = await assets.readSceneAsset(before.otherId);
    return { restoredSize: restored?.size, restoredType: restored?.type, sharedSize: shared?.size, deleted: !deleted, otherSize: other?.size };
  }, before);
  expect(after.restoredSize).toBe(before.size);
  expect(after.restoredType).toBe('image/png');
  expect(after.sharedSize).toBe(before.size);
  expect(after.deleted).toBe(true);
  expect(after.otherSize).toBe(before.size);
});

test('a background shared across projects is deleted only after its final project is removed', async ({ page }) => {
  await page.goto('/projects-storage-fixture');
  const state = await page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const assets = await import('/src/projects/assets.ts');
    const first = store.loadProjects()[0];
    const second = store.createProject('Projeto com fundo compartilhado');
    const image = document.createElement('canvas'); image.width = 8; image.height = 8;
    const blob = await new Promise<Blob>(resolve => image.toBlob(blob => resolve(blob!), 'image/png'));
    const id = await assets.saveSceneAsset(first.id, 'countdown', blob);
    first.scenes.find(scene => scene.id === 'countdown')!.appearance!.backgroundAssetId = id;
    second.scenes.find(scene => scene.id === 'countdown')!.appearance!.backgroundAssetId = id;
    store.saveProject(first); store.saveProject(second);
    await store.deleteProjectAndRecordings(first.id);
    const retained = Boolean(await assets.readSceneAsset(id));
    await store.deleteProjectAndRecordings(second.id);
    return { retained, deletedAfterFinalProject: !(await assets.readSceneAsset(id)) };
  });
  expect(state.retained).toBe(true);
  expect(state.deletedAfterFinalProject).toBe(true);
});

test('legacy shared audio migrates to the selected scene while other scenes keep independent defaults', async ({page}) => {
  await page.goto('/projects-storage-fixture');
  const result=await page.evaluate(async()=>{
    localStorage.clear();const store=await import('/src/projects/store.ts');const project=store.loadProjects()[0];
    project.selectedSceneId='countdown';project.settings.controls={cameraZoom:1.6,sourceVisibility:{camera:true,screen:true},microphoneMuted:true,microphoneGainDb:-9};
    project.settings.microphoneDeviceId='legacy-mic';
    for(const scene of project.scenes){if(scene.appearance){delete (scene.appearance as any).microphoneMuted;delete (scene.appearance as any).microphoneGainDb;}}
    const title=project.scenes.find(scene=>scene.id==='countdown')!.appearance!.layers.find(layer=>layer.kind==='title')!;title.text='Minha estreia';title.frames={portrait:{x:.12,y:.25,width:.7,height:.2}};
    localStorage.setItem('grava-simples-workspace-v1',JSON.stringify({version:1,sceneRevision:2,projects:[project],takes:[],activeProjectId:project.id}));
    const migrated=store.loadProjects()[0];return {camera:migrated.scenes.find(scene=>scene.id==='camera')!.appearance,countdown:migrated.scenes.find(scene=>scene.id==='countdown')!.appearance};
  });
  expect(result.countdown?.microphoneMuted).toBe(true);expect(result.countdown?.microphoneGainDb).toBe(-9);expect(result.countdown?.microphoneDeviceId).toBe('legacy-mic');
  expect(result.camera?.microphoneMuted).toBe(false);expect(result.camera?.microphoneGainDb).toBe(0);expect(result.camera?.microphoneDeviceId).toBeUndefined();
  expect(result.countdown?.layers.find(layer=>layer.kind==='title')?.text).toBe('Minha estreia');expect(result.countdown?.layers.find(layer=>layer.kind==='title')?.frames?.portrait?.y).toBe(.25);
});

test('layer media asset survives sibling and cross-project references until its last reference is removed', async ({page})=>{
  await page.goto('/projects-storage-fixture');
  const result=await page.evaluate(async()=>{
    localStorage.clear();const store=await import('/src/projects/store.ts');const assets=await import('/src/projects/assets.ts');
    const first=store.loadProjects()[0],second=store.createProject('Outra edição');const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
    const assetId=await assets.saveSceneAsset(first.id,'camera',blob);
    const make=(id:string)=>({id,kind:'screen' as const,name:'Imagem',visible:true,sourceId:`source-${id}`,assetId});
    first.scenes[0].appearance!.layers.push(make('one'),make('two'));second.scenes[0].appearance!.layers.push(make('three'));store.saveProject(first);store.saveProject(second);
    first.scenes[0].appearance!.layers=first.scenes[0].appearance!.layers.filter(layer=>layer.id!=='one');store.saveProject(first);await assets.deleteSceneAssets(first.id,'camera');const siblingRetained=!!await assets.readSceneAsset(assetId);
    await store.deleteProjectAndRecordings(first.id);const otherProjectRetained=!!await assets.readSceneAsset(assetId);await store.deleteProjectAndRecordings(second.id);
    return{siblingRetained,otherProjectRetained,deleted:!await assets.readSceneAsset(assetId)};
  });
  expect(result).toEqual({siblingRetained:true,otherProjectRetained:true,deleted:true});
});
