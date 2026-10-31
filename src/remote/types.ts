/** Small control-plane snapshot. Never includes captured media or account tokens. */
export interface RemoteSceneItem {
  /** Stable positive OBS scene-item ID within its scene. */
  id: number;
  layerId: string;
  sourceId: string;
  name: string;
  kind: string;
  visible: boolean;
}

export interface RemoteSnapshot {
  projectId: string;
  projectName: string;
  scenes: { id: string; name: string; items: RemoteSceneItem[] }[];
  sceneId: string;
  microphoneMuted: boolean;
  microphoneGainDb?: number;
  recordState: 'ready' | 'recording' | 'stopping' | 'unavailable';
  /** A cancellable preparation/countdown; neither output is recording yet. */
  recordingStartPending?: boolean;
  elapsedMs: number;
  bytes: number;
  fps: number;
  ready: boolean;
  outputWidth?: number;
  outputHeight?: number;
  targetFps?: number;
}

export type RemoteCommand =
  | { type: 'selectScene'; sceneId: string }
  | { type: 'setSourceVisible'; sceneId: string; layerId: string; visible: boolean }
  | { type: 'setMicrophoneMuted'; muted: boolean }
  | { type: 'startRecording' }
  | { type: 'stopRecording' };

export interface RemoteCommandResult {
  ok: boolean;
  error?: string;
  snapshot?: RemoteSnapshot;
}
