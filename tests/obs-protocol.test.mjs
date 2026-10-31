import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_REQUESTS, MICROPHONE_NAME, MICROPHONE_UUID, OBS_WEBSOCKET_VERSION, handleObsRequest, translateEvents } from '../src/remote/protocol.ts';

function snapshot(overrides = {}) {
  return {
    projectId: 'project-one', projectName: 'Aulas', sceneId: 'camera',
    scenes: [
      { id: 'camera', name: 'Câmera', items: [
        { id: 11, layerId: 'camera-layer', sourceId: 'camera-feed', name: 'Câmera', kind: 'camera', visible: true },
        { id: 12, layerId: 'title-layer', sourceId: '', name: 'Título', kind: 'title', visible: false },
      ] },
      { id: 'screen', name: 'Tela', items: [
        { id: 31, layerId: 'shared-camera-layer', sourceId: 'camera-feed', name: 'Câmera', kind: 'camera', visible: true },
        { id: 32, layerId: 'screen-layer', sourceId: 'screen-feed', name: 'Tela', kind: 'screen', visible: true },
      ] },
    ],
    microphoneMuted: false, microphoneGainDb: -6, recordState: 'ready',
    elapsedMs: 0, bytes: 0, fps: 29.7, ready: true,
    outputWidth: 1280, outputHeight: 720, targetFps: 30, ...overrides,
  };
}
const noDispatch = async () => { throw new Error('Read must not dispatch'); };
const read = (type, fields, state = snapshot()) => handleObsRequest(type, fields, state, noDispatch);
const successful = result => { assert.equal(result.requestStatus.result, true, JSON.stringify(result)); return result.responseData; };

test('OBS Blade initial dashboard requests all return decodable v5 response fields', async () => {
  const init = [
    'GetVersion', 'GetRecordDirectory', 'GetVideoSettings', 'GetSceneCollectionList',
    'GetProfileList', 'GetStudioModeEnabled', 'GetReplayBufferStatus', 'GetVirtualCamStatus',
    'GetHotkeyList', 'GetSceneList', 'GetInputList', 'GetSpecialInputs', 'GetSceneTransitionList',
  ];
  for (const type of init) successful(await read(type));
  const version = successful(await read('GetVersion'));
  assert.equal(version.rpcVersion, 1);
  assert.equal(version.platform, 'browser');
  assert.equal(version.obsWebSocketVersion.split('.')[0], '5');
  assert.equal(version.obsWebSocketVersion, OBS_WEBSOCKET_VERSION);
  assert.deepEqual(version.availableRequests, [...AVAILABLE_REQUESTS]);
  assert.deepEqual(version.supportedImageFormats, []);
  const sceneList = successful(await read('GetSceneList'));
  assert.equal(sceneList.currentProgramSceneName, 'Câmera');
  assert.equal(sceneList.currentProgramSceneUuid, 'camera');
  assert.equal(sceneList.currentPreviewSceneName, null);
  assert.ok(sceneList.scenes.every(item => typeof item.sceneIndex === 'number' && typeof item.sceneName === 'string' && typeof item.sceneUuid === 'string'));
  const settings = successful(await read('GetVideoSettings'));
  assert.equal(settings.baseWidth, 1280);
  assert.equal(settings.outputHeight, 720);
  assert.equal(settings.fpsNumerator / settings.fpsDenominator, 30);
  assert.equal(successful(await read('GetCurrentSceneTransition')).transitionKind, 'cut_transition');
});

test('recording state is present in Blade’s entire one-second stats recipe', async () => {
  const state = snapshot({ recordState: 'recording', elapsedMs: 3_661_237, bytes: 120_000 });
  const stream = successful(await read('GetStreamStatus', undefined, state));
  const record = successful(await read('GetRecordStatus', undefined, state));
  const stats = successful(await read('GetStats', undefined, state));
  assert.equal(stream.outputActive, false);
  assert.equal(stream.outputTimecode, '00:00:00.000');
  assert.deepEqual(record, { outputActive: true, outputPaused: false, outputTimecode: '01:01:01.237', outputDuration: 3_661_237, outputBytes: 120_000 });
  assert.equal(stats.activeFps, 29.7);
  assert.equal(successful(await read('GetRecordStatus', undefined, snapshot({ recordState: 'stopping' }))).outputActive, true);
  assert.equal(successful(await read('GetRecordStatus')).outputActive, false);
});

test('scene item IDs route visibility to the chosen scene/layer, independent of shared feeds', async () => {
  const commands = [];
  const response = await handleObsRequest('SetSceneItemEnabled', { sceneUuid: 'screen', sceneItemId: 31, sceneItemEnabled: false }, snapshot(), async command => { commands.push(command); return { ok: true }; });
  successful(response);
  assert.deepEqual(commands, [{ type: 'setSourceVisible', sceneId: 'screen', layerId: 'shared-camera-layer', visible: false }]);
  const first = successful(await read('GetSceneItemList', { sceneUuid: 'camera' })).sceneItems[0];
  const reused = successful(await read('GetSceneItemList', { sceneName: 'Tela' })).sceneItems[0];
  assert.equal(first.sourceUuid, reused.sourceUuid);
  assert.equal(first.sourceName, reused.sourceName);
  assert.notEqual(first.sceneItemId, reused.sceneItemId);
  assert.equal(first.sceneItemEnabled, true);
});

test('duplicate scene and input labels receive unambiguous OBS names', async () => {
  const state = snapshot();
  state.scenes[1].name = 'Câmera';
  state.scenes[0].items[1].name = 'Câmera';
  const sceneList = successful(await read('GetSceneList', undefined, state));
  assert.equal(new Set(sceneList.scenes.map(scene => scene.sceneName)).size, 2);
  const inputList = successful(await read('GetInputList', undefined, state)).inputs;
  assert.equal(new Set(inputList.map(input => input.inputName)).size, inputList.length);
  const commands = [];
  successful(await handleObsRequest('SetCurrentProgramScene', { sceneName: sceneList.scenes[1].sceneName }, state, async command => { commands.push(command); return { ok: true }; }));
  assert.deepEqual(commands, [{ type: 'selectScene', sceneId: 'screen' }]);
  assert.equal((await read('GetSceneItemList', { sceneName: 'Câmera' }, state)).requestStatus.code, 600);
});

test('an unknown supplied UUID never falls back to a valid name for another resource', async () => {
  assert.equal((await read('GetSceneItemList', { sceneUuid: 'not-a-scene', sceneName: 'Câmera' })).requestStatus.code, 600);
  assert.equal((await read('GetInputMute', { inputUuid: 'not-an-input', inputName: MICROPHONE_NAME })).requestStatus.code, 600);
});

test('Blade audio initialization excludes visual inputs with its required status 604', async () => {
  const inputList = successful(await read('GetInputList')).inputs;
  assert.equal(inputList.filter(input => input.inputUuid === MICROPHONE_UUID).length, 1);
  assert.equal(inputList.filter(input => input.inputUuid === 'grava-source:camera-feed').length, 1);
  const special = successful(await read('GetSpecialInputs'));
  assert.equal(special.mic1, MICROPHONE_NAME);
  for (const input of inputList) for (const type of ['GetInputVolume', 'GetInputMute', 'GetInputAudioSyncOffset']) {
    const response = await read(type, { inputName: input.inputName });
    if (input.inputUuid === MICROPHONE_UUID) successful(response);
    else assert.equal(response.requestStatus.code, 604, `${type} on visual ${input.inputName} must be excluded by Blade's audio batch parser`);
  }
  const gain = successful(await read('GetInputVolume', { inputUuid: MICROPHONE_UUID }));
  assert.equal(gain.inputVolumeDb, -6);
  assert.equal(gain.inputVolumeMul, 10 ** (-6 / 20));
});

test('explicit mute and unmute are applied to the real scene microphone', async () => {
  const commands = [];
  const dispatch = async command => { commands.push(command); return { ok: true, snapshot: snapshot({ microphoneMuted: command.muted }) }; };
  successful(await handleObsRequest('SetInputMute', { inputName: MICROPHONE_NAME, inputMuted: true }, snapshot(), dispatch));
  successful(await handleObsRequest('SetInputMute', { inputUuid: MICROPHONE_UUID, inputMuted: false }, snapshot({ microphoneMuted: true }), dispatch));
  assert.deepEqual(commands, [{ type: 'setMicrophoneMuted', muted: true }, { type: 'setMicrophoneMuted', muted: false }]);
});

test('mutation success waits for desktop acknowledgment and rejects failed or thrown execution', async () => {
  let confirm;
  const pending = handleObsRequest('SetCurrentProgramScene', { sceneName: 'Tela' }, snapshot(), () => new Promise(resolve => { confirm = resolve; }));
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  confirm({ ok: false, error: 'A fonte não está conectada.' });
  const result = await pending;
  assert.equal(result.requestStatus.result, false);
  assert.equal(result.requestStatus.code, 701);
  assert.equal(result.requestStatus.comment, 'A fonte não está conectada.');
  const crashed = await handleObsRequest('SetCurrentProgramScene', { sceneName: 'Tela' }, snapshot(), async () => { throw Error('SECRET_INTERNAL_DETAILS'); });
  assert.equal(crashed.requestStatus.code, 702);
  assert.doesNotMatch(JSON.stringify(crashed), /SECRET/);
});

test('start/stop each control one paired session and reject duplicate or unprepared actions', async () => {
  const commands = [];
  const dispatch = async command => { commands.push(command); return { ok: true }; };
  successful(await handleObsRequest('StartRecord', undefined, snapshot(), dispatch));
  assert.equal((await handleObsRequest('StartRecord', undefined, snapshot({ recordState: 'recording' }), dispatch)).requestStatus.code, 500);
  assert.equal((await handleObsRequest('StartRecord', undefined, snapshot({ ready: false }), dispatch)).requestStatus.code, 207);
  assert.equal((await handleObsRequest('StopRecord', undefined, snapshot(), dispatch)).requestStatus.code, 501);
  assert.equal((await handleObsRequest('StopRecord', undefined, snapshot({ recordState: 'stopping' }), dispatch)).requestStatus.code, 207);
  const stopped = successful(await handleObsRequest('StopRecord', undefined, snapshot({ recordState: 'recording' }), dispatch));
  assert.equal(stopped.outputPath, '');
  assert.deepEqual(commands, [{ type: 'startRecording' }, { type: 'stopRecording' }]);
});

test('invalid fields and unavailable desktop never dispatch a mutation', async () => {
  const invalid = [
    ['SetSceneItemEnabled', { sceneUuid: 'camera', sceneItemId: 11, sceneItemEnabled: 'false' }, 401],
    ['SetSceneItemEnabled', { sceneUuid: 'camera', sceneItemId: -1, sceneItemEnabled: false }, 401],
    ['SetSceneItemEnabled', { sceneUuid: 'camera', sceneItemId: 99, sceneItemEnabled: false }, 600],
    ['SetInputMute', { inputName: MICROPHONE_NAME }, 300],
    ['SetInputMute', { inputName: MICROPHONE_NAME, inputMuted: 1 }, 401],
    ['GetSceneItemList', [], 301],
    ['GetSceneItemList', { sceneUuid: 'camera', canvasUuid: 'other' }, 600],
  ];
  for (const [type, data, code] of invalid) assert.equal((await read(type, data)).requestStatus.code, code);
  const unavailable = await handleObsRequest('SetCurrentProgramScene', { sceneUuid: 'screen' }, snapshot({ recordState: 'unavailable' }), noDispatch);
  assert.equal(unavailable.requestStatus.code, 207);
});

test('StopRecord cancels a pending start without claiming either output is active', async () => {
  const pending = snapshot({ recordState: 'unavailable', ready: false, recordingStartPending: true });
  const commands = [];
  const dispatch = async command => { commands.push(command); return { ok: true }; };
  assert.equal(successful(await read('GetRecordStatus', undefined, pending)).outputActive, false);
  successful(await handleObsRequest('StopRecord', undefined, pending, dispatch));
  assert.deepEqual(commands, [{ type: 'stopRecording' }]);
  assert.equal((await handleObsRequest('StopRecord', undefined, snapshot({ recordState: 'unavailable', ready: false }), dispatch)).requestStatus.code, 501);
  assert.equal((await handleObsRequest('StartRecord', undefined, snapshot({ recordingStartPending: true }), dispatch)).requestStatus.code, 207);
  assert.equal((await handleObsRequest('SetInputMute', { inputUuid: MICROPHONE_UUID, inputMuted: true }, pending, dispatch)).requestStatus.code, 207);
  assert.equal(commands.length, 1, 'only cancellation may dispatch during a pending start');
  assert.deepEqual(translateEvents(snapshot(), pending), [], 'readiness is not a recording output transition');
  assert.deepEqual(translateEvents(pending, snapshot()), [], 'cancelling before start emits no fake recording event');
});

test('unsupported pause, live, media, preview and full mixer operations are not advertised', async () => {
  for (const type of ['ToggleInputMute', 'ToggleRecord', 'PauseRecord', 'ResumeRecord', 'ToggleRecordPause', 'StartStream', 'GetSourceScreenshot', 'SetInputVolume', 'SetCurrentProfile', 'SetStudioModeEnabled', 'TriggerMediaInputAction']) {
    assert.equal(AVAILABLE_REQUESTS.includes(type), false);
    assert.equal((await read(type)).requestStatus.code, 204);
  }
});

test('the microphone remains reported active while recording even when start readiness is false', async () => {
  const active = successful(await read('GetSourceActive', { sourceUuid: MICROPHONE_UUID }, snapshot({ recordState: 'recording', ready: false })));
  assert.equal(active.videoActive, true);
  assert.equal(active.videoShowing, true);
});

test('desktop changes emit matching OBS events while elapsed time alone emits none', () => {
  const before = snapshot();
  const after = structuredClone(before);
  after.sceneId = 'screen';
  after.scenes[1].items[0].visible = false;
  after.microphoneMuted = true;
  after.recordState = 'recording';
  const events = translateEvents(before, after);
  assert.deepEqual(events.map(event => event.eventType), ['CurrentProgramSceneChanged', 'SceneItemEnableStateChanged', 'InputMuteStateChanged', 'RecordStateChanged']);
  assert.deepEqual(events.map(event => event.eventIntent), [4, 128, 8, 64]);
  assert.equal(events[0].eventData.sceneUuid, 'screen');
  assert.equal(events[1].eventData.sceneItemId, 31);
  assert.equal(events[2].eventData.inputUuid, MICROPHONE_UUID);
  assert.equal(events[3].eventData.outputState, 'OBS_WEBSOCKET_OUTPUT_STARTED');
  assert.deepEqual(translateEvents(before, snapshot({ elapsedMs: 12345, bytes: 1111, fps: 28 })), []);
});

test('source edits and reorderings trigger list refreshes instead of leaving stale phone controls', () => {
  const before = snapshot(), after = structuredClone(before);
  after.scenes[0].items.reverse();
  after.scenes[0].items[0].name = 'Legenda';
  const events = translateEvents(before, after);
  assert.ok(events.some(event => event.eventType === 'SceneListChanged'));
  assert.ok(events.some(event => event.eventType === 'InputNameChanged' && event.eventData.inputName === 'Legenda'));
  assert.ok(events.some(event => event.eventType === 'SceneItemListReindexed' && event.eventData.sceneUuid === 'camera'));
});
