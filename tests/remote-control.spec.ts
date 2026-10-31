import { test, expect, type Page } from './fixtures/auth';
import { mkdir } from 'node:fs/promises';

async function seedStudio(page: Page, prepare = false) {
  await page.route('**/remote-project-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Fixture</body></html>' }));
  await page.goto('/remote-project-fixture');
  const id = await page.evaluate(async () => {
    const keys = await import('/src/projects/keys.ts');
    (keys as { setLocalAccount?: (userId: string) => void }).setLocalAccount?.('user_fixture');
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0]; project.settings.resolution = '360'; project.settings.fps = 30;
    store.saveProject(project); return project.id;
  });
  await page.goto(`/app?test=1#project/${id}`);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  if (prepare) {
    await page.evaluate(() => (window as any).__recorderTest.prepare());
    await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.status)).toBe('ready');
  }
  return id;
}

async function helperFixture(page: Page, permission = 'granted', available = true) {
  await page.addInitScript(({ permission, available }) => {
    const NativeSocket = window.WebSocket;
    const fixture: any = (window as any).__localRemoteFixture = {
      permission, available, sockets: [], snapshots: [], responses: {}, events: [], hellos: [], closed: 0,
      password: 'fixture-persistent-password-1234',
      request(id: string, requestType: string, requestData: unknown = {}) {
        this.sockets.at(-1).receive({ type: 'request', id, requestType, requestData, expiresAt: Date.now() + 8000 });
      },
    };
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async (descriptor: PermissionDescriptor) =>
      ['loopback-network', 'local-network', 'local-network-access'].includes(descriptor.name)
        ? { state: fixture.permission, onchange: null } as PermissionStatus : query(descriptor);
    class HelperSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; bufferedAmount = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL, protocols?: string | string[]) {
        if (String(url) !== 'ws://127.0.0.1:4455/studio') return new NativeSocket(url, protocols) as unknown as HelperSocket;
        fixture.sockets.push(this);
        setTimeout(() => {
          if (!fixture.available) { this.close(); return; }
          fixture.permission = 'granted'; this.readyState = 1; this.onopen?.(new Event('open'));
        }, 0);
      }
      receive(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })); }
      send(source: string) {
        const value = JSON.parse(source);
        if (value.type === 'hello') {
          fixture.hellos.push(value);
          this.receive({ type: 'ready', connectionId: `fixture-${fixture.sockets.length}`, addresses: ['192.168.1.42'], port: 4455, password: fixture.password, phoneConnected: true });
        } else if (value.type === 'state') fixture.snapshots.push(value.snapshot);
        else if (value.type === 'response') fixture.responses[value.id] = value.result;
        else if (value.type === 'events') fixture.events.push(...value.events);
        else if (value.type === 'reset-pairing') {
          fixture.password = 'fixture-rotated-password-5678';
          this.receive({ type: 'ready', connectionId: `fixture-${fixture.sockets.length}`, addresses: ['192.168.1.42'], port: 4455, password: fixture.password, phoneConnected: false });
        }
      }
      close() { if (this.readyState === 3) return; this.readyState = 3; fixture.closed++; this.onclose?.(new CloseEvent('close')); }
    }
    window.WebSocket = HelperSocket as unknown as typeof WebSocket;
  }, { permission, available });
}

const request = (page: Page, id: string, requestType: string, requestData: unknown = {}) => page.evaluate(({ id, requestType, requestData }) => (window as any).__localRemoteFixture.request(id, requestType, requestData), { id, requestType, requestData });
const response = (page: Page, id: string) => page.evaluate(id => (window as any).__localRemoteFixture.responses[id], id);

test('installed helper connects automatically, retains pairing on reload and closes only when leaving the project', async ({ page }) => {
  await helperFixture(page); await seedStudio(page);
  await expect.poll(() => page.evaluate(() => (window as any).__localRemoteFixture.hellos.length)).toBe(1);
  await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Controle pelo celular', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'IP do computador', exact: true })).toHaveValue('192.168.1.42');
  await expect(dialog.getByLabel('Porta do OBS Blade')).toHaveValue('4455');
  await expect(dialog.getByLabel('Senha do OBS Blade')).toHaveAttribute('type', 'password');
  await expect(dialog.getByRole('status')).toContainText('Celular conectado pela rede local');
  await mkdir('.context/screenshots', { recursive: true });
  await page.screenshot({ path: '.context/screenshots/remote-control-pairing.png', fullPage: true, animations: 'disabled' });
  const snapshots = await page.evaluate(() => (window as any).__localRemoteFixture.snapshots.length);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__localRemoteFixture.snapshots.length)).toBeGreaterThan(snapshots);
  expect(await page.evaluate(() => (window as any).__localRemoteFixture.closed)).toBe(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__localRemoteFixture.hellos.length)).toBe(1);
  await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(dialog.getByLabel('Senha do OBS Blade')).toHaveValue('fixture-persistent-password-1234');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Todos os projetos', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__localRemoteFixture.closed)).toBe(1);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('fixture-persistent-password-1234');
});

test('local requests control the real scene, visibility and microphone using confirmed responses', async ({ page }) => {
  await helperFixture(page); await seedStudio(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).__localRemoteFixture.snapshots.at(-1)?.ready)).toBe(true);
  await page.evaluate(() => {
    const f = (window as any).__localRemoteFixture;
    f.request('scene', 'SetCurrentProgramScene', { sceneUuid: 'camera-zoom' });
    f.request('same-batch-mute', 'SetInputMute', { inputUuid: 'grava-microphone', inputMuted: true });
  });
  await expect.poll(async () => (await response(page, 'scene'))?.requestStatus.result).toBe(true);
  await expect.poll(async () => (await response(page, 'same-batch-mute'))?.requestStatus.result).toBe(true);
  const sceneMutes = await page.evaluate(() => (window as any).__recorderTest.project.scenes
    .filter((scene: any) => ['camera', 'camera-zoom'].includes(scene.id))
    .map((scene: any) => [scene.id, scene.appearance.microphoneMuted]));
  expect(sceneMutes).toEqual([['camera', false], ['camera-zoom', true]]);
  const camera = await page.evaluate(() => (window as any).__localRemoteFixture.snapshots.at(-1).scenes.find((scene: any) => scene.id === 'camera-zoom').items.find((item: any) => item.kind === 'camera'));
  await request(page, 'hide', 'SetSceneItemEnabled', { sceneUuid: 'camera-zoom', sceneItemId: camera.id, sceneItemEnabled: false });
  await expect.poll(async () => (await response(page, 'hide'))?.requestStatus.result).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.project.scenes.find((scene: any) => scene.id === 'camera-zoom').appearance.layers.find((item: any) => item.kind === 'camera').visible)).toBe(false);
  await request(page, 'missing', 'SetCurrentProgramScene', { sceneUuid: 'no-longer-exists' });
  await expect.poll(async () => (await response(page, 'missing'))?.requestStatus.result).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.project.selectedSceneId)).toBe('camera-zoom');
});

test('first local-network permission is requested by a click and pairing reset changes the helper credentials', async ({ page }) => {
  await helperFixture(page, 'prompt'); await seedStudio(page);
  expect(await page.evaluate(() => (window as any).__localRemoteFixture.sockets.length)).toBe(0);
  await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Controle pelo celular', exact: true });
  await expect(dialog.getByRole('status')).toContainText('Permita a conexão');
  await expect(dialog.getByRole('link', { name: 'Baixar para Mac' })).toHaveAttribute('href', '/companion/gravasimples-macos.dmg');
  await expect(dialog.getByRole('link', { name: 'Baixar para Windows' })).toHaveAttribute('href', '/companion/gravasimples-windows.zip');
  await dialog.getByRole('button', { name: 'Conectar ao computador', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Celular conectado');
  await dialog.getByRole('button', { name: 'Redefinir pareamento', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(dialog.getByLabel('Senha do OBS Blade')).toHaveValue('fixture-rotated-password-5678');
  await expect(dialog.getByRole('status')).toContainText('Pronto para conectar o OBS Blade');
});

test('blocked local access explains recovery and keeps local recording controls usable', async ({ page }) => {
  await helperFixture(page, 'denied'); await seedStudio(page);
  await page.getByRole('button', { name: 'Controle pelo celular', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Controle pelo celular', exact: true });
  await expect(dialog.getByRole('status')).toContainText('Acesso à rede local bloqueado');
  await expect(dialog).toContainText('Nas permissões deste site');
  expect(await page.evaluate(() => (window as any).__localRemoteFixture.sockets.length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('start-recording')).toBeEnabled();
});
