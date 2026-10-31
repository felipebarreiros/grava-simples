import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_REMOTE_URL, localNetworkPermission, parseHelperMessage } from '../src/remote/client.ts';
import { RemoteController } from '../src/remote/controller.ts';

const snapshot = () => ({ projectId: 'project-a', projectName: 'Aula', scenes: [{ id: 'scene-a', name: 'Câmera', items: [{ id: 1, layerId: 'camera', sourceId: 'camera', name: 'Câmera', kind: 'camera', visible: true }] }], sceneId: 'scene-a', microphoneMuted: false, recordState: 'ready', elapsedMs: 0, bytes: 0, fps: 30, ready: true });
const ready = () => ({ type: 'ready', connectionId: 'local-connection-1', addresses: ['192.168.1.42'], port: 4455, password: 'persistent-local-password-1234', phoneConnected: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'condition did not settle') {
  const deadline = Date.now() + 1500;
  while (!check()) { if (Date.now() >= deadline) assert.fail(message); await pause(3); }
}
class Socket {
  readyState = 0; bufferedAmount = 0; sent = []; closes = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  constructor(url) { this.url = url; }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closes++; this.readyState = 3; this.onclose?.({}); }
  request(id, requestType, requestData = {}, expiresAt = Date.now() + 8000) { this.receive({ type: 'request', id, requestType, requestData, expiresAt }); }
  response(id) { return this.sent.find(message => message.type === 'response' && message.id === id); }
}
function fixture(overrides = {}) {
  const sockets = [], states = [];
  const controller = new RemoteController({
    projectId: 'project-a', ownerId: 'user_fixture', getSnapshot: snapshot,
    execute: async () => ({ ok: true }), onChange: state => states.push(state),
    socket: url => { const socket = new Socket(url); sockets.push(socket); return socket; },
    permission: async () => 'granted', intervalMs: 5, reconnectMs: 5,
    ...overrides,
  });
  return { controller, sockets, states, async connect() { await controller.start(); const socket = sockets.at(-1); socket.open(); socket.receive(ready()); return socket; } };
}

test('local permission probes modern names and falls back without inventing permission grants', async () => {
  const names = [];
  assert.equal(await localNetworkPermission({ query: async ({ name }) => { names.push(name); if (name !== 'local-network-access') throw new TypeError('Unsupported'); return { state: 'granted' }; } }), 'granted');
  assert.deepEqual(names, ['loopback-network', 'local-network', 'local-network-access']);
  assert.equal(await localNetworkPermission({ query: async () => { throw new TypeError('Unsupported'); } }), 'unknown');
  assert.equal(await localNetworkPermission({ query: async () => ({ state: 'denied' }) }), 'denied');
});

test('loopback helper messages enforce bounded credentials, LAN addresses and request envelopes', () => {
  assert.deepEqual(parseHelperMessage(JSON.stringify(ready())), ready());
  for (const value of [
    { ...ready(), password: '' }, { ...ready(), addresses: ['127.0.0.1'] },
    { ...ready(), addresses: ['192.168.1.999'] }, { ...ready(), port: 0 },
    { type: 'request', id: 'one', requestType: '../DeleteProject' },
  ]) assert.equal(parseHelperMessage(JSON.stringify(value)), null);
  assert.equal(parseHelperMessage('x'.repeat(65_537)), null);
  assert.equal(parseHelperMessage('not json'), null);
});

test('first local-access prompt requires one click; granted permission reconnects automatically on a later visit', async () => {
  const first = fixture({ permission: async () => 'prompt' });
  try {
    await first.controller.start();
    assert.equal(first.controller.getState().status, 'permission-required');
    assert.equal(first.sockets.length, 0);
    const clicked = first.controller.start(true);
    assert.equal(first.sockets.length, 1, 'socket must open in the original user gesture');
    await clicked;
    first.sockets[0].open(); first.sockets[0].receive(ready());
    assert.equal(first.controller.getState().status, 'connected');
  } finally { first.controller.dispose(); }
  const next = fixture();
  try {
    const socket = await next.connect();
    assert.equal(socket.url, LOCAL_REMOTE_URL);
    assert.deepEqual(socket.sent[0], { type: 'hello', ownerId: 'user_fixture', projectId: 'project-a' });
    assert.ok(socket.sent.some(message => message.type === 'state' && message.snapshot.projectId === 'project-a'));
  } finally { next.controller.dispose(); }
});

test('serialized mutations keep heartbeats and read requests alive during slow recorder finalization', async () => {
  let finish, operations = 0, current = snapshot();
  current = { ...current, recordState: 'recording' };
  const f = fixture({ getSnapshot: () => current, execute: async command => {
    operations++;
    if (command.type === 'stopRecording') return new Promise(resolve => { finish = () => { current = { ...current, recordState: 'ready' }; resolve({ ok: true }); }; });
    return { ok: true };
  } });
  try {
    const socket = await f.connect();
    socket.request('slow-stop', 'StopRecord'); socket.request('slow-stop', 'StopRecord');
    socket.request('stats', 'GetStats');
    await until(() => socket.response('stats') && typeof finish === 'function');
    await until(() => socket.sent.filter(message => message.type === 'state').length >= 5);
    assert.equal(socket.response('slow-stop'), undefined);
    assert.equal(operations, 1);
    finish(); await until(() => socket.response('slow-stop'));
    assert.equal(socket.response('slow-stop').result.requestStatus.result, true);
    socket.request('slow-stop', 'StopRecord');
    await pause(10); assert.equal(operations, 1);
  } finally { f.controller.dispose(); }
});

test('same-connection duplicate mutations cannot replay, while changed request data fails explicitly', async () => {
  let current = snapshot(), operations = 0;
  const f = fixture({ getSnapshot: () => current, execute: async command => {
    operations++; current = { ...current, microphoneMuted: command.muted }; return { ok: true };
  } });
  try {
    const socket = await f.connect();
    socket.request('mute-once', 'SetInputMute', { inputUuid: 'grava-microphone', inputMuted: true });
    await until(() => socket.response('mute-once'));
    socket.request('mute-once', 'SetInputMute', { inputUuid: 'grava-microphone', inputMuted: true });
    socket.request('mute-once', 'SetInputMute', { inputUuid: 'grava-microphone', inputMuted: false });
    await pause(10);
    assert.equal(operations, 1); assert.equal(current.microphoneMuted, true);
    assert.ok(socket.sent.some(message => message.type === 'response' && message.id === 'mute-once' && message.result.requestStatus.code === 400));
    assert.ok(socket.sent.some(message => message.type === 'events' && message.events.some(event => event.eventType === 'InputMuteStateChanged')));
  } finally { f.controller.dispose(); }
});

// Browser-controller stress contract only: the native helper serializes phone
// mutations. Actual helper cancellation is tested with a web-initiated countdown.
test('browser controller priority StopRecord cancels a pending start while reads and request protections stay active', async () => {
  let current = snapshot(), finishStart, actualStarts = 0;
  const operations = [];
  const f = fixture({ getSnapshot: () => current, execute: async command => {
    operations.push(command.type);
    if (command.type === 'startRecording') {
      current = { ...current, ready: false, recordState: 'unavailable', recordingStartPending: true };
      return new Promise(resolve => { finishStart = commit => {
        if (commit) actualStarts++;
        current = { ...current, ready: true, recordState: 'ready', recordingStartPending: false };
        resolve(commit ? { ok: true } : { ok: false, error: 'Cancelled before recording.' });
      }; });
    }
    if (command.type === 'stopRecording') { finishStart(false); return { ok: true }; }
    return { ok: true };
  } });
  try {
    const socket = await f.connect();
    socket.request('countdown-start', 'StartRecord');
    await until(() => typeof finishStart === 'function');
    socket.request('another-start', 'StartRecord');
    socket.request('countdown-stats', 'GetStats');
    socket.request('countdown-status', 'GetRecordStatus');
    await until(() => socket.response('countdown-stats') && socket.response('countdown-status') && socket.response('another-start'));
    assert.equal(socket.response('another-start').result.requestStatus.code, 207);
    assert.equal(socket.response('countdown-status').result.responseData.outputActive, false);
    assert.equal(socket.response('countdown-stats').result.responseData.activeFps, 30);
    await until(() => socket.sent.filter(message => message.type === 'state' && message.snapshot.recordingStartPending).length >= 3);
    socket.request('expired-cancel', 'StopRecord', {}, Date.now() - 1);
    await until(() => socket.response('expired-cancel'));
    assert.match(socket.response('expired-cancel').result.requestStatus.comment, /expired/);
    assert.deepEqual(operations, ['startRecording']);
    socket.request('countdown-cancel', 'StopRecord');
    socket.request('countdown-cancel', 'StopRecord');
    await until(() => socket.response('countdown-cancel') && socket.response('countdown-start'));
    assert.equal(socket.response('countdown-cancel').result.requestStatus.result, true);
    assert.equal(socket.response('countdown-start').result.requestStatus.result, false);
    assert.equal(socket.response('countdown-start').result.requestStatus.code, 701);
    assert.equal(actualStarts, 0);
    assert.deepEqual(operations, ['startRecording', 'stopRecording']);
    assert.equal(current.recordingStartPending, false);
    socket.request('countdown-cancel', 'StopRecord');
    await pause(10);
    assert.deepEqual(operations, ['startRecording', 'stopRecording']);
    assert.equal(socket.sent.some(message => message.type === 'events' && message.events.some(event => event.eventType === 'RecordStateChanged' && event.eventData.outputActive)), false);
  } finally { if (current.recordingStartPending) finishStart?.(false); f.controller.dispose(); }
});

test('a normal StopRecord cannot jump another mutation when no start is pending', async () => {
  let current = { ...snapshot(), recordState: 'recording', ready: false }, finishMute;
  const operations = [];
  const f = fixture({ getSnapshot: () => current, execute: async command => {
    operations.push(command.type);
    if (command.type === 'setMicrophoneMuted') return new Promise(resolve => { finishMute = () => resolve({ ok: true }); });
    if (command.type === 'stopRecording') current = { ...current, recordState: 'ready', ready: true };
    return { ok: true };
  } });
  try {
    const socket = await f.connect();
    socket.request('held-mute', 'SetInputMute', { inputUuid: 'grava-microphone', inputMuted: true });
    await until(() => typeof finishMute === 'function');
    socket.request('ordinary-stop', 'StopRecord');
    socket.request('ordinary-stats', 'GetStats');
    await until(() => socket.response('ordinary-stats'));
    assert.deepEqual(operations, ['setMicrophoneMuted']);
    assert.equal(socket.response('ordinary-stop'), undefined);
    finishMute();
    await until(() => socket.response('ordinary-stop'));
    assert.deepEqual(operations, ['setMicrophoneMuted', 'stopRecording']);
    assert.equal(socket.response('ordinary-stop').result.requestStatus.result, true);
  } finally { finishMute?.(); f.controller.dispose(); }
});

test('helper reconnect retains its pairing password and drops queued work from the lost connection', async () => {
  let finish, operations = 0, current = { ...snapshot(), recordState: 'recording' };
  const f = fixture({ getSnapshot: () => current, execute: async () => { operations++; return new Promise(resolve => { finish = resolve; }); } });
  try {
    const first = await f.connect();
    first.request('old-stop', 'StopRecord'); first.request('old-mute', 'SetInputMute', { inputUuid: 'grava-microphone', inputMuted: true });
    await until(() => typeof finish === 'function');
    first.close(); await until(() => f.sockets.length === 2);
    const second = f.sockets[1]; second.open(); second.receive(ready());
    finish({ ok: true }); await pause(15);
    assert.equal(operations, 1);
    assert.equal(f.controller.getState().pairing.password, ready().password);
    assert.equal(second.sent.some(message => message.type === 'response' && message.id.startsWith('old-')), false);
    assert.equal(current.recordState, 'recording', 'transport failure must not stop capture itself');
  } finally { f.controller.dispose(); }
});

test('permission denial stops retries, and another studio cannot be taken over automatically', async () => {
  const denied = fixture({ permission: async () => 'denied' });
  try {
    await denied.controller.start();
    assert.equal(denied.controller.getState().status, 'permission-denied');
    assert.equal(denied.sockets.length, 0);
  } finally { denied.controller.dispose(); }
  const restricted = fixture({ permission: async () => 'unknown', socket: () => { throw new DOMException('Blocked by browser policy', 'SecurityError'); } });
  try {
    await restricted.controller.start();
    assert.equal(restricted.controller.getState().status, 'permission-denied');
    assert.match(restricted.controller.getState().error, /navegador bloqueou/);
  } finally { restricted.controller.dispose(); }
  const busy = fixture();
  try {
    await busy.controller.start(); const socket = busy.sockets[0]; socket.open();
    socket.receive({ type: 'error', code: 'studio-in-use' });
    await pause(20);
    assert.equal(busy.controller.getState().status, 'in-use'); assert.equal(busy.sockets.length, 1);
  } finally { busy.controller.dispose(); }
});

test('an installed helper discovered after browser startup connects automatically without a new pairing', async () => {
  const f = fixture();
  try {
    await f.controller.start(); f.sockets[0].close();
    await until(() => f.sockets.length === 2);
    assert.ok(f.states.some(state => state.status === 'helper-missing'));
    const later = f.sockets[1]; later.open(); later.receive(ready());
    assert.equal(f.controller.getState().status, 'connected');
    assert.equal(f.controller.getState().pairing.password, ready().password);
  } finally { f.controller.dispose(); }
});

test('a command buffered while the browser was frozen never executes after its helper deadline', async () => {
  let commands = 0;
  const f = fixture({ execute: async () => { commands++; return { ok: true }; } });
  try {
    const socket = await f.connect();
    socket.request('expired-start', 'StartRecord', {}, Date.now() - 1);
    await until(() => socket.response('expired-start'));
    assert.equal(commands, 0);
    assert.equal(socket.response('expired-start').result.requestStatus.result, false);
    assert.match(socket.response('expired-start').result.requestStatus.comment, /expired/);
  } finally { f.controller.dispose(); }
});

test('reset rotates pairing explicitly; local disable/unmount closes only control and ignores late requests', async () => {
  let commands = 0;
  const f = fixture({ execute: async () => { commands++; return { ok: true }; } });
  const socket = await f.connect();
  f.controller.resetPairing(); assert.ok(socket.sent.some(message => message.type === 'reset-pairing'));
  socket.receive({ ...ready(), password: 'rotated-local-password-1234', phoneConnected: false });
  assert.equal(f.controller.getState().pairing.password, 'rotated-local-password-1234');
  f.controller.stop(); socket.request('late-start', 'StartRecord');
  await pause(15);
  assert.equal(f.controller.getState().status, 'idle'); assert.equal(commands, 0); assert.equal(socket.closes, 1);
  f.controller.dispose();
});
