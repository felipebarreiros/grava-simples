import type { RemoteCommand, RemoteCommandResult, RemoteSceneItem, RemoteSnapshot } from './types.ts';

export interface ObsRequestResult {
  requestStatus: { result: boolean; code: number; comment?: string };
  responseData?: Record<string, unknown>;
}
export interface ObsEvent {
  eventType: string;
  eventIntent: number;
  eventData: Record<string, unknown>;
}
type Scene = RemoteSnapshot['scenes'][number];
type Dispatch = (command: RemoteCommand) => Promise<RemoteCommandResult>;
type Fields = Record<string, unknown>;

export const MICROPHONE_UUID = 'grava-microphone';
export const MICROPHONE_NAME = 'Microfone';
export const OBS_WEBSOCKET_VERSION = '5.3.0';
/** Advertise only implemented operations. In particular no pause, streaming or screenshots. */
export const AVAILABLE_REQUESTS = [
  'GetVersion', 'GetStats', 'GetRecordDirectory', 'GetVideoSettings',
  'GetSceneCollectionList', 'GetProfileList', 'GetStudioModeEnabled',
  'GetReplayBufferStatus', 'GetVirtualCamStatus', 'GetHotkeyList',
  'GetSceneList', 'GetGroupList', 'GetCurrentProgramScene', 'SetCurrentProgramScene',
  'GetSceneItemList', 'GetSceneItemEnabled', 'SetSceneItemEnabled',
  'GetSceneItemId', 'GetSceneItemPrivateSettings',
  'GetInputList', 'GetInputKindList', 'GetSpecialInputs', 'GetInputMute',
  'SetInputMute', 'GetInputVolume', 'GetInputAudioSyncOffset',
  'GetInputAudioBalance', 'GetInputAudioMonitorType', 'GetSourceActive',
  'GetSourceFilterList', 'GetSceneTransitionList', 'GetCurrentSceneTransition',
  'GetSceneSceneTransitionOverride', 'GetStreamStatus', 'GetRecordStatus',
  'StartRecord', 'StopRecord',
] as const;

class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
const success = (responseData: Fields = {}): ObsRequestResult => ({ requestStatus: { result: true, code: 100 }, responseData });
const failure = (code: number, comment: string): ObsRequestResult => ({ requestStatus: { result: false, code, comment } });
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const isRecording = (state: RemoteSnapshot) => state.recordState === 'recording' || state.recordState === 'stopping';

/** Duplicate author-facing labels must not route an OBS command to the wrong scene. */
function sceneName(state: RemoteSnapshot, scene: Scene): string {
  return state.scenes.some(other => other.id !== scene.id && other.name === scene.name)
    ? `${scene.name} [${scene.id}]` : scene.name;
}
function resolveScene(state: RemoteSnapshot, fields: Fields): Scene {
  const uuid = fields.sceneUuid;
  const name = fields.sceneName;
  if (uuid !== undefined && (typeof uuid !== 'string' || !uuid)) throw new ProtocolError(401, 'sceneUuid must be a nonempty string.');
  if (uuid === undefined && (typeof name !== 'string' || !name)) throw new ProtocolError(300, 'Specify sceneUuid or sceneName.');
  const scene = uuid !== undefined
    ? state.scenes.find(scene => scene.id === uuid)
    : state.scenes.find(scene => sceneName(state, scene) === name);
  if (!scene) throw new ProtocolError(600, 'Scene not found. Refresh the scene list.');
  return scene;
}
function currentScene(state: RemoteSnapshot): Scene {
  const scene = state.scenes.find(scene => scene.id === state.sceneId);
  if (!scene) throw new ProtocolError(207, 'The desktop studio has no active scene.');
  return scene;
}
function itemFor(scene: Scene, fields: Fields): RemoteSceneItem {
  if (!Number.isSafeInteger(fields.sceneItemId) || number(fields.sceneItemId) < 1) throw new ProtocolError(401, 'sceneItemId must be a positive integer.');
  const item = scene.items.find(item => item.id === fields.sceneItemId);
  if (!item) throw new ProtocolError(600, 'Scene item not found. Refresh the source list.');
  return item;
}
interface Input { inputUuid: string; inputName: string; inputKind: string; unversionedInputKind: string }
function sourceUuid(scene: Scene, item: RemoteSceneItem): string {
  return item.sourceId ? `grava-source:${item.sourceId}` : `grava-layer:${scene.id}:${item.layerId}`;
}
function inputs(state: RemoteSnapshot): Input[] {
  const entries = new Map<string, { name: string; kind: string }>();
  for (const scene of state.scenes) for (const item of scene.items) {
    const uuid = sourceUuid(scene, item);
    if (!entries.has(uuid)) entries.set(uuid, { name: item.name, kind: `grava_${item.kind}` });
  }
  const values = [...entries];
  const visual = values.map(([uuid, item]) => ({
    inputUuid: uuid,
    inputName: item.name === MICROPHONE_NAME || values.some(([otherId, other]) => otherId !== uuid && other.name === item.name)
      ? `${item.name} [${uuid}]` : item.name,
    inputKind: item.kind,
    unversionedInputKind: item.kind,
  }));
  return [...visual, { inputUuid: MICROPHONE_UUID, inputName: MICROPHONE_NAME, inputKind: 'grava_microphone', unversionedInputKind: 'grava_microphone' }];
}
function resolveInput(state: RemoteSnapshot, fields: Fields): Input {
  if (fields.inputUuid !== undefined && (typeof fields.inputUuid !== 'string' || !fields.inputUuid)) throw new ProtocolError(401, 'inputUuid must be a nonempty string.');
  if (fields.inputUuid === undefined && (typeof fields.inputName !== 'string' || !fields.inputName)) throw new ProtocolError(300, 'Specify inputUuid or inputName.');
  const input = fields.inputUuid !== undefined
    ? inputs(state).find(input => input.inputUuid === fields.inputUuid)
    : inputs(state).find(input => input.inputName === fields.inputName);
  if (!input) throw new ProtocolError(600, 'Input not found. Refresh the input list.');
  return input;
}
function microphone(state: RemoteSnapshot, fields: Fields): void {
  // Blade intentionally filters 604 from its audio batch before decoding volume/mute fields.
  if (resolveInput(state, fields).inputUuid !== MICROPHONE_UUID) throw new ProtocolError(604, 'This visual source has no remotely controllable audio.');
}
function booleanField(fields: Fields, name: string): boolean {
  if (typeof fields[name] !== 'boolean') throw new ProtocolError(fields[name] === undefined ? 300 : 401, `${name} must be a boolean.`);
  return fields[name];
}
function recordStatus(state: RemoteSnapshot): Fields {
  const active = isRecording(state), duration = active ? Math.floor(number(state.elapsedMs)) : 0;
  const hours = Math.floor(duration / 3_600_000).toString().padStart(2, '0');
  const minutes = Math.floor(duration / 60_000 % 60).toString().padStart(2, '0');
  const seconds = Math.floor(duration / 1000 % 60).toString().padStart(2, '0');
  const milliseconds = (duration % 1000).toString().padStart(3, '0');
  return { outputActive: active, outputPaused: false, outputTimecode: `${hours}:${minutes}:${seconds}.${milliseconds}`, outputDuration: duration, outputBytes: active ? number(state.bytes) : 0 };
}
function sceneItem(state: RemoteSnapshot, scene: Scene, item: RemoteSceneItem, index: number): Fields {
  const input = inputs(state).find(input => input.inputUuid === sourceUuid(scene, item))!;
  return {
    sourceUuid: input.inputUuid, sourceName: input.inputName, sourceType: 'OBS_SOURCE_TYPE_INPUT',
    inputKind: input.inputKind, isGroup: false, sceneItemId: item.id, sceneItemIndex: index,
    sceneItemEnabled: item.visible, sceneItemLocked: false,
    sceneItemBlendMode: 'OBS_BLEND_NORMAL', sceneItemTransform: null,
  };
}
const cutTransition = { transitionName: 'Cut', transitionUuid: 'grava-cut', transitionKind: 'cut_transition', transitionFixed: true, transitionDuration: null, transitionConfigurable: false, transitionSettings: null };

async function execute(state: RemoteSnapshot, command: RemoteCommand, dispatch: Dispatch): Promise<RemoteCommandResult> {
  if (state.recordState === 'unavailable') throw new ProtocolError(207, 'The desktop studio is busy or its sources are unavailable.');
  const result = await dispatch(command);
  if (!result.ok) throw new ProtocolError(701, result.error?.slice(0, 256) || 'The desktop did not confirm this command. Refresh its state before trying again.');
  return result;
}

/** OBS RPC v1 adapter. Only confirmed desktop commands receive successful mutation responses. */
export async function handleObsRequest(
  requestType: string,
  requestData: unknown,
  state: RemoteSnapshot,
  dispatch: Dispatch,
): Promise<ObsRequestResult> {
  try {
    if (requestData !== undefined && (typeof requestData !== 'object' || requestData === null || Array.isArray(requestData))) throw new ProtocolError(301, 'requestData must be an object.');
    const fields = (requestData ?? {}) as Fields;
    if (!AVAILABLE_REQUESTS.includes(requestType as typeof AVAILABLE_REQUESTS[number])) return failure(204, 'This operation is not supported by GravaSimples.');
    // This endpoint represents the paired dual-output session, not additional OBS canvases.
    if (fields.canvasUuid !== undefined) throw new ProtocolError(600, 'Separate OBS canvases are not exposed by this studio.');
    switch (requestType) {
      case 'GetVersion': return success({ obsVersion: '0.4.0', obsWebSocketVersion: OBS_WEBSOCKET_VERSION, rpcVersion: 1, availableRequests: [...AVAILABLE_REQUESTS], supportedImageFormats: [], platform: 'browser', platformDescription: 'GravaSimples browser studio — OBS control compatibility subset' });
      case 'GetStats': return success({
        activeFps: number(state.fps),
        // The browser does not expose system-wide CPU/RAM or OBS encoder counters.
        cpuUsage: 0, memoryUsage: 0, availableDiskSpace: 0, averageFrameRenderTime: 0,
        renderSkippedFrames: 0, renderTotalFrames: 0, outputSkippedFrames: 0, outputTotalFrames: 0,
        webSocketSessionIncomingMessages: 0, webSocketSessionOutgoingMessages: 0,
      });
      case 'GetRecordDirectory': return success({ recordDirectory: 'Gravações neste navegador' });
      case 'GetVideoSettings': return success({ fpsNumerator: state.targetFps || 30, fpsDenominator: 1, baseWidth: state.outputWidth || 1920, baseHeight: state.outputHeight || 1080, outputWidth: state.outputWidth || 1920, outputHeight: state.outputHeight || 1080 });
      case 'GetSceneCollectionList': return success({ currentSceneCollectionName: state.projectName, sceneCollections: [state.projectName] });
      case 'GetProfileList': return success({ currentProfileName: 'Horizontal + vertical', profiles: ['Horizontal + vertical'] });
      case 'GetStudioModeEnabled': return success({ studioModeEnabled: false });
      case 'GetReplayBufferStatus': case 'GetVirtualCamStatus': return success({ outputActive: false });
      case 'GetHotkeyList': return success({ hotkeys: [] });
      case 'GetGroupList': return success({ groups: [] });
      case 'GetSceneList': {
        const current = currentScene(state);
        return success({ currentProgramSceneName: sceneName(state, current), currentProgramSceneUuid: current.id, currentPreviewSceneName: null, currentPreviewSceneUuid: null, scenes: state.scenes.map((scene, index) => ({ sceneIndex: state.scenes.length - 1 - index, sceneName: sceneName(state, scene), sceneUuid: scene.id })) });
      }
      case 'GetCurrentProgramScene': {
        const scene = currentScene(state), name = sceneName(state, scene);
        return success({ sceneName: name, sceneUuid: scene.id, currentProgramSceneName: name, currentProgramSceneUuid: scene.id });
      }
      case 'SetCurrentProgramScene': {
        const scene = resolveScene(state, fields);
        await execute(state, { type: 'selectScene', sceneId: scene.id }, dispatch);
        return success();
      }
      case 'GetSceneItemList': {
        const scene = resolveScene(state, fields);
        return success({ sceneItems: scene.items.map((item, index) => sceneItem(state, scene, item, index)) });
      }
      case 'GetSceneItemId': {
        const scene = resolveScene(state, fields);
        if (typeof fields.sourceName !== 'string' || !fields.sourceName) throw new ProtocolError(300, 'Specify sourceName.');
        if (fields.searchOffset !== undefined && fields.searchOffset !== 0) throw new ProtocolError(402, 'Only searchOffset 0 is supported.');
        const item = scene.items.find(item => sceneItem(state, scene, item, 0).sourceName === fields.sourceName);
        if (!item) throw new ProtocolError(600, 'Source not found in the selected scene.');
        return success({ sceneItemId: item.id });
      }
      case 'GetSceneItemEnabled': case 'SetSceneItemEnabled': case 'GetSceneItemPrivateSettings': {
        const scene = resolveScene(state, fields), item = itemFor(scene, fields);
        if (requestType === 'GetSceneItemPrivateSettings') return success({ sceneItemSettings: {} });
        if (requestType === 'GetSceneItemEnabled') return success({ sceneItemEnabled: item.visible });
        const visible = booleanField(fields, 'sceneItemEnabled');
        await execute(state, { type: 'setSourceVisible', sceneId: scene.id, layerId: item.layerId, visible }, dispatch);
        return success();
      }
      case 'GetInputList': return success({ inputs: inputs(state).filter(input => fields.inputKind === undefined || input.inputKind === fields.inputKind) });
      case 'GetInputKindList': return success({ inputKinds: [...new Set(inputs(state).map(input => input.inputKind))] });
      case 'GetSpecialInputs': return success({ desktop1: null, desktop2: null, mic1: MICROPHONE_NAME, mic2: null, mic3: null, mic4: null });
      case 'GetInputMute': case 'GetInputVolume': case 'GetInputAudioSyncOffset': case 'GetInputAudioBalance': case 'GetInputAudioMonitorType': {
        microphone(state, fields);
        if (requestType === 'GetInputMute') return success({ inputMuted: state.microphoneMuted });
        if (requestType === 'GetInputAudioSyncOffset') return success({ inputAudioSyncOffset: 0 });
        if (requestType === 'GetInputAudioBalance') return success({ inputAudioBalance: 0.5 });
        if (requestType === 'GetInputAudioMonitorType') return success({ monitorType: 'OBS_MONITORING_TYPE_NONE' });
        const db = typeof state.microphoneGainDb === 'number' && Number.isFinite(state.microphoneGainDb) ? state.microphoneGainDb : 0;
        return success({ inputVolumeDb: db, inputVolumeMul: Math.pow(10, db / 20) });
      }
      case 'SetInputMute': {
        microphone(state, fields);
        const muted = booleanField(fields, 'inputMuted');
        await execute(state, { type: 'setMicrophoneMuted', muted }, dispatch);
        return success();
      }
      case 'GetSourceActive': case 'GetSourceFilterList': {
        const source = state.scenes.find(scene => fields.sourceUuid !== undefined ? scene.id === fields.sourceUuid : sceneName(state, scene) === fields.sourceName);
        const input = source ? undefined : resolveInput(state, { inputUuid: fields.sourceUuid, inputName: fields.sourceName });
        if (requestType === 'GetSourceFilterList') return success({ filters: [] });
        const showing = source ? source.id === state.sceneId : input?.inputUuid === MICROPHONE_UUID
          ? state.ready || isRecording(state) : currentScene(state).items.some(item => sourceUuid(currentScene(state), item) === input?.inputUuid && item.visible);
        return success({ videoActive: Boolean(showing), videoShowing: Boolean(showing) });
      }
      case 'GetSceneTransitionList': return success({ currentSceneTransitionName: 'Cut', currentSceneTransitionUuid: 'grava-cut', transitions: [{ ...cutTransition }] });
      case 'GetCurrentSceneTransition': return success({ ...cutTransition });
      case 'GetSceneSceneTransitionOverride': resolveScene(state, fields); return success({ transitionName: null, transitionDuration: null });
      case 'GetStreamStatus': return success({ outputActive: false, outputReconnecting: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 });
      case 'GetRecordStatus': return success(recordStatus(state));
      case 'StartRecord': case 'StopRecord': {
        const active = isRecording(state), start = requestType === 'StartRecord';
        if (requestType === 'StartRecord' && active) throw new ProtocolError(500, 'Both recordings are already running.');
        if (requestType === 'StopRecord' && !active) throw new ProtocolError(501, 'The recording session is not running.');
        if (state.recordState === 'stopping') throw new ProtocolError(207, 'The desktop is finalizing both recordings.');
        if (start && !state.ready) throw new ProtocolError(207, 'Prepare camera, microphone and screen permissions in the desktop studio first.');
        await execute(state, { type: start ? 'startRecording' : 'stopRecording' }, dispatch);
        // A browser has no filesystem output path. Both files remain in its recording library.
        return success(requestType === 'StopRecord' ? { outputPath: '' } : {});
      }
    }
    return failure(204, 'This operation is not supported by GravaSimples.');
  } catch (error) {
    return error instanceof ProtocolError ? failure(error.code, error.message) : failure(702, 'The desktop did not confirm this request. Refresh its state before trying again.');
  }
}

/** Emit only observed desktop changes; an optimistic phone command never invents these events. */
export function translateEvents(previous: RemoteSnapshot, next: RemoteSnapshot): ObsEvent[] {
  const events: ObsEvent[] = [];
  const emit = (eventType: string, eventIntent: number, eventData: Fields) => events.push({ eventType, eventIntent, eventData });
  const structure = (state: RemoteSnapshot) => state.scenes.map(scene => ({ id: scene.id, name: scene.name, items: scene.items.map(item => ({ ...item, visible: undefined })) }));
  if (JSON.stringify(structure(previous)) !== JSON.stringify(structure(next))) {
    emit('SceneListChanged', 4, { scenes: next.scenes.map((scene, index) => ({ sceneName: sceneName(next, scene), sceneUuid: scene.id, sceneIndex: next.scenes.length - 1 - index })) });
    const oldInputs = inputs(previous), newInputs = inputs(next);
    for (const item of oldInputs) if (!newInputs.some(value => value.inputUuid === item.inputUuid)) emit('InputRemoved', 8, { inputUuid: item.inputUuid, inputName: item.inputName });
    for (const item of newInputs) {
      const old = oldInputs.find(value => value.inputUuid === item.inputUuid);
      if (!old) emit('InputCreated', 8, { ...item, inputSettings: {}, defaultInputSettings: {} });
      else if (old.inputName !== item.inputName) emit('InputNameChanged', 8, { inputUuid: item.inputUuid, oldInputName: old.inputName, inputName: item.inputName });
    }
    // Blade refreshes source rows on reindex; additions/removals may leave the scene list itself unchanged.
    for (const scene of next.scenes) {
      const old = previous.scenes.find(value => value.id === scene.id);
      if (JSON.stringify(old?.items.map(item => item.id)) !== JSON.stringify(scene.items.map(item => item.id))) emit('SceneItemListReindexed', 128, { sceneName: sceneName(next, scene), sceneUuid: scene.id, sceneItems: scene.items.map((item, sceneItemIndex) => ({ sceneItemId: item.id, sceneItemIndex })) });
    }
  }
  const current = next.scenes.find(scene => scene.id === next.sceneId);
  const oldCurrent = previous.scenes.find(scene => scene.id === previous.sceneId);
  if (current && (previous.sceneId !== next.sceneId || !oldCurrent || sceneName(previous, oldCurrent) !== sceneName(next, current))) emit('CurrentProgramSceneChanged', 4, { sceneName: sceneName(next, current), sceneUuid: current.id });
  for (const scene of next.scenes) for (const item of scene.items) {
    const old = previous.scenes.find(value => value.id === scene.id)?.items.find(value => value.layerId === item.layerId);
    if (old && old.visible !== item.visible) emit('SceneItemEnableStateChanged', 128, { sceneName: sceneName(next, scene), sceneUuid: scene.id, sceneItemId: item.id, sceneItemEnabled: item.visible });
  }
  if (previous.microphoneMuted !== next.microphoneMuted) emit('InputMuteStateChanged', 8, { inputName: MICROPHONE_NAME, inputUuid: MICROPHONE_UUID, inputMuted: next.microphoneMuted });
  if (previous.microphoneGainDb !== next.microphoneGainDb && next.microphoneGainDb !== undefined) emit('InputVolumeChanged', 8, { inputName: MICROPHONE_NAME, inputUuid: MICROPHONE_UUID, inputVolumeDb: next.microphoneGainDb, inputVolumeMul: Math.pow(10, next.microphoneGainDb / 20) });
  if (previous.recordState !== next.recordState) {
    const active = isRecording(next);
    emit('RecordStateChanged', 64, { outputActive: active, outputState: next.recordState === 'stopping' ? 'OBS_WEBSOCKET_OUTPUT_STOPPING' : active ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED', ...(active ? {} : { outputPath: '' }) });
  }
  return events;
}
