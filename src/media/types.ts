export type Orientation = 'landscape' | 'portrait';
export type StudioLayout = 'camera' | 'camera-zoom' | 'screen' | 'screen-3d' | 'countdown';
export type SourceKind = 'test' | 'camera' | 'screen' | 'media';
export type Resolution = '360' | 'test' | '720' | '1080' | '4k';
export type SessionState = 'idle' | 'preparing' | 'ready' | 'recording' | 'stopping' | 'complete' | 'error';

export type SceneLayerKind = 'background' | 'camera' | 'screen' | 'title' | 'timer';
export interface LayerFrame { x: number; y: number; width: number; height: number }
export interface SceneLayer {
  id: string;
  kind: SceneLayerKind;
  name: string;
  visible: boolean;
  text?: string;
  /** Logical pixels at a 1080-pixel output short edge. */
  fontSize?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Normalized canvas positions. May extend outside the frame intentionally. */
  frames?: Partial<Record<Orientation, LayerFrame>>;
  sourceId?: string;
  assetId?: string;
  /** Opacity of uploaded visual media over the layers beneath it. */
  opacity?: number;
  fit?: 'contain' | 'cover';
  cameraShape?: 'rectangle' | 'rounded' | 'circle';
  cameraBorderColor?: string;
  cameraBorderWidth?: number;
  cameraShadow?: boolean;
  cameraFade?: boolean;
}
export interface SceneAppearance {
  /** Bottom-to-top paint order. A missing layer is not rendered. */
  layers: SceneLayer[];
  cameraShape: 'rectangle' | 'rounded' | 'circle';
  cameraBorderColor: string;
  cameraBorderWidth: number;
  cameraShadow: boolean;
  cameraFade?: boolean;
  backgroundColor: string;
  backgroundAssetId?: string;
  productTitle: string;
  countdownSeconds: number;
  microphoneMuted: boolean;
  microphoneGainDb: number;
  cameraDeviceId?: string;
  microphoneDeviceId?: string;
}
export interface CountdownStatus {
  remainingSeconds: number;
  running: boolean;
}
export interface ScenePreviewOptions {
  layout: StudioLayout;
  appearance?: Partial<SceneAppearance>;
  zoom?: number;
  orientation?: Orientation;
  now?: number;
  /** Explicit null chooses the generated background. */
  background?: CanvasImageSource | null;
}

export interface DrawRect { x: number; y: number; width: number; height: number; cropX: number; cropY: number; cropWidth: number; cropHeight: number }
export interface LayoutEngine {
  layout(input: {
    outputWidth: number; outputHeight: number; sourceWidth: number; sourceHeight: number;
    cameraWidth: number; cameraHeight: number; mode: 'camera' | 'screen-camera';
    orientation: Orientation;
  }): { source: DrawRect; camera?: DrawRect };
  audioGainDb?(decibels: number): number;
  createCompressorNode?(context: AudioContext): Promise<AudioNode>;
  backend?: string;
}

export interface StudioConfig {
  source: SourceKind;
  /** Stable source identities owned by the legacy/default capture inputs. */
  cameraSourceId?: string;
  screenSourceId?: string;
  resolution: Resolution;
  fps: 30 | 60;
  layout?: StudioLayout;
  /** Center crop for the zoom scene, from 1× to 2.5×. */
  zoom?: number;
  appearance?: SceneAppearance;
  microphone?: boolean;
  cameraDeviceId?: string;
  microphoneDeviceId?: string;
}

export interface CapacityInfo {
  storage: 'opfs' | 'indexeddb';
  usage?: number;
  quota?: number;
  available?: number;
  estimatedBytesPerMinute: number;
  estimatedMinutes?: number;
  persistent: boolean;
  note: string;
}

export interface RecordingFile {
  orientation: Orientation;
  blob: Blob;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  durationMs: number;
}

export interface RecordingResult {
  id: string;
  landscape: RecordingFile;
  portrait: RecordingFile;
  startedAt: number;
  stoppedAt: number;
  warnings: string[];
}

export interface StudioControls {
  cameraZoom: number;
  sourceVisibility: Record<'camera' | 'screen', boolean>;
  microphoneMuted: boolean;
  microphoneGainDb: number;
}

export interface StudioSourceStatus {
  available: boolean;
  live: boolean;
  enabled: boolean;
  visible: boolean;
  settings?: MediaTrackSettings;
  deviceId?: string;
  label?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface StudioMicrophoneStatus {
  available: boolean;
  live: boolean;
  enabled: boolean;
  muted: boolean;
  settings?: MediaTrackSettings;
  deviceId?: string;
  label?: string;
}

export interface StudioMetrics {
  elapsedMs: number;
  frames: Record<Orientation, number>;
  measuredFps: number;
  bytes: Record<Orientation, number>;
  chunks: Record<Orientation, number>;
  pendingWrites: number;
  hidden: boolean;
  audio: boolean;
  /** Microphone RMS after the mute and gain controls, between zero and one. */
  audioLevel: number;
  audioLevelDb: number;
  /** Meter before scene mute/gain. Never routed around the mute gain. */
  rawMicLevel: number;
  rawMicLevelDb: number;
  layerSources?: Record<string, StudioSourceStatus & { kind?: SceneLayerKind }>;
  microphone?: StudioMicrophoneStatus;
  sources?: Record<'camera' | 'screen', StudioSourceStatus>;
  engineBackend: string;
  /** Target/effective video encoder rate in bits per second when recording. */
  videoBitsPerSecond?: number;
  /** Target/effective audio encoder rate in bits per second when recording. */
  audioBitsPerSecond?: number;
  storage?: CapacityInfo;
  mimeType: string;
  warning?: string;
  captureInfo?: {
    sourceKind: SourceKind;
    sourceWidth: number;
    sourceHeight: number;
    sourceFps?: number;
    cameraWidth: number;
    cameraHeight: number;
    cameraFps?: number;
    note: string;
  };
}

export interface StudioEvent {
  state: SessionState;
  controls: StudioControls;
  config?: StudioConfig;
  appearance?: SceneAppearance;
  countdown?: CountdownStatus;
  metrics: StudioMetrics;
  error?: string;
  result?: RecordingResult;
}

export interface StudioOptions {
  engine: LayoutEngine;
  onEvent?: (event: StudioEvent) => void;
}

export interface RecoveryRecording {
  id: string;
  createdAt: number;
  completed: boolean;
  mimeType: string;
  landscapeBytes: number;
  portraitBytes: number;
}
