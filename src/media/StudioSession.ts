import { RecordingStore, estimateCapacity } from './storage';
import { LocalMediaSource } from './LocalMediaSource';
import { defaultSceneAppearance, normalizeSceneAppearance, getLayerFrame, SceneCompositor, type SceneVisualSource } from './SceneCompositor';
import type { LayoutEngine, Orientation, RecordingResult, SessionState, StudioConfig, StudioControls, StudioEvent, StudioLayout, StudioMetrics, StudioOptions, StudioSourceStatus, SceneAppearance, ScenePreviewOptions, CountdownStatus, LayerFrame, SceneLayer } from './types';

const ORIENTATIONS = ['landscape', 'portrait'] as const;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const LOW_FPS_WARNING = 'A gravação está com menos quadros que o esperado. Reduza a resolução ou os quadros por segundo na próxima gravação.';
const BACKGROUND_WARNING = 'Esta aba está em segundo plano. O navegador pode reduzir ou pausar vídeo e áudio; acompanhe os quadros por segundo.';
const MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/mp4',
  'video/webm',
];

type LayerInput = { element: HTMLVideoElement | HTMLCanvasElement; name: string; kind: 'camera' | 'screen' | 'media'; media?: LocalMediaSource; stream?: MediaStream; audioGain?: GainNode; audioSource?: MediaStreamAudioSourceNode };

type RecorderPath = {
  recorder: MediaRecorder;
  stream: MediaStream;
  track: CanvasCaptureMediaStreamTrack;
  stopped: Promise<void>;
  resolveStopped: () => void;
};

export function chooseRecordingMimeType(config?: Pick<StudioConfig, 'resolution' | 'fps'>): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable. Open this page in desktop Chrome or Edge.');
  const level = config?.resolution === '4k' ? (config.fps === 60 ? '34' : '33') : config?.fps === 60 ? '2A' : '28';
  const candidates = [
    `video/mp4;codecs=avc1.42E0${level},mp4a.40.2`,
    'video/mp4;codecs=avc1,mp4a.40.2',
    `video/mp4;codecs=avc1.42E0${level},opus`,
    'video/mp4;codecs=avc1,opus',
    ...MIME_TYPES,
  ];
  const selected = candidates.find(mime => MediaRecorder.isTypeSupported(mime));
  if (!selected) throw new Error('This browser has no supported recording format.');
  return selected;
}

export function recordingDimensions(resolution: StudioConfig['resolution']): { landscape: [number, number]; portrait: [number, number] } {
  const long = resolution === '4k' ? 3840 : resolution === '1080' ? 1920 : resolution === '720' ? 1280 : 640;
  const short = long * 9 / 16;
  return { landscape: [long, short], portrait: [short, long] };
}

function displayVideoConstraints(config?: Pick<StudioConfig, 'resolution' | 'fps'>): MediaTrackConstraints {
  // Bound the long edge while preserving wide, square and portrait displays.
  // Sharing a Retina display should not decode native 4K/5K at 60 fps for a
  // 1080p30 recording. Display selection still belongs to the browser chooser.
  const limit = recordingDimensions(config?.resolution ?? '1080').landscape[0];
  const fps = config?.fps ?? 30;
  return { width: { ideal: limit, max: limit }, height: { ideal: limit, max: limit }, frameRate: { ideal: fps, max: fps } };
}

async function constrainDisplayStream(stream: MediaStream, config?: Pick<StudioConfig, 'resolution' | 'fps'>): Promise<void> {
  const limit = recordingDimensions(config?.resolution ?? '1080').landscape[0];
  const fps = config?.fps ?? 30;
  for (const track of stream.getVideoTracks()) {
    const settings = track.getSettings();
    const previous = track.getConstraints();
    const boundsChanged = ([previous.width, previous.height, previous.frameRate] as const).some((value, index) =>
      typeof value === 'object' && value.max !== undefined && value.max !== (index === 2 ? fps : limit));
    if (!boundsChanged && (settings.width ?? 0) <= limit && (settings.height ?? 0) <= limit && (settings.frameRate ?? 0) <= fps) continue;
    // Some display implementations ignore constraints in the initial request.
    // Keep a successfully selected source usable if it cannot scale in capture.
    await track.applyConstraints(displayVideoConstraints(config)).catch(() => undefined);
  }
}

function readableError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Permita o acesso à câmera e ao microfone para começar. Se estiver compartilhando, escolha uma tela ou janela.';
    if (error.name === 'NotFoundError') return 'Nenhuma câmera ou microfone foi encontrado. Conecte um dispositivo e tente novamente.';
    if (error.name === 'NotReadableError') return 'Capture could not start. Check whether another app is using the device.';
    if (error.name === 'QuotaExceededError') return 'Local storage is full. Both recordings were stopped.';
  }
  return error instanceof Error ? error.message : String(error);
}

export class StudioSession {
  private readonly engine: LayoutEngine;
  private readonly listeners = new Set<(event: StudioEvent) => void>();
  private canvases?: Record<Orientation, HTMLCanvasElement>;
  private contexts?: Record<Orientation, CanvasRenderingContext2D>;
  private state: SessionState = 'idle';
  private config?: StudioConfig;
  private preferredLayout?: StudioLayout;
  private sceneAppearance = defaultSceneAppearance('camera');
  private appearanceExplicit = false;
  private compositor = new SceneCompositor();
  private sceneBackground?: ImageBitmap;
  private sceneBackgroundAssetId?: string;
  private sceneBackgroundLoad = 0;
  private countdownRemainingMs = 300_000;
  private countdownStartedAt?: number;
  private controls: StudioControls = { cameraZoom: 1.4, sourceVisibility: { camera: true, screen: true }, microphoneMuted: false, microphoneGainDb: 0 };
  private error?: string;
  private result?: RecordingResult;
  private metrics: StudioMetrics = {
    elapsedMs: 0, frames: { landscape: 0, portrait: 0 }, measuredFps: 0,
    bytes: { landscape: 0, portrait: 0 }, chunks: { landscape: 0, portrait: 0 },
    pendingWrites: 0, hidden: false, audio: false, audioLevel: 0, audioLevelDb: -100, rawMicLevel: 0, rawMicLevelDb: -100, engineBackend: 'obs-wasm-subset', mimeType: '',
  };
  private capturedStreams: MediaStream[] = [];
  private videos: HTMLVideoElement[] = [];
  private source?: HTMLVideoElement | HTMLCanvasElement;
  private localMedia?: LocalMediaSource;
  private camera?: HTMLVideoElement | HTMLCanvasElement;
  private cameraSourceId?: string;
  private screenSourceId?: string;
  private testContexts?: { screen: CanvasRenderingContext2D; camera: CanvasRenderingContext2D };
  private audioContext?: AudioContext;
  private audioDestination?: MediaStreamAudioDestinationNode;
  private microphoneStream?: MediaStream;
  private microphoneInput?: MediaStreamAudioSourceNode;
  private rawMicrophoneAnalyser?: AnalyserNode;
  private rawMicrophoneSamples?: Float32Array<ArrayBuffer>;
  private audioMix?: AudioNode;
  private layerInputs = new Map<string, LayerInput>();
  private layerLoads = new Map<string, number>();
  private microphoneGain?: GainNode;
  private microphoneAnalyser?: AnalyserNode;
  private microphoneSamples?: Float32Array<ArrayBuffer>;
  private audioNodes: AudioNode[] = [];
  private oscillator?: OscillatorNode;
  private paths: Partial<Record<Orientation, RecorderPath>> = {};
  private outputStreams: MediaStream[] = [];
  private store?: RecordingStore;
  private writes: Record<Orientation, Promise<void>> = { landscape: Promise.resolve(), portrait: Promise.resolve() };
  private pendingBytes = 0;
  private writeError?: unknown;
  private recordingError?: unknown;
  private stopPromise?: Promise<RecordingResult>;
  private startedAt = 0;
  private startedPerformance = 0;
  private lastDraw = 0;
  private nextDrawAt = 0;
  private renderStart = 0;
  private renderFrameId = 0;
  private liveScreenPreview = false;
  private lastMetricTime = 0;
  private metricFrameBaseline = 0;
  private lowFpsWindows = 0;
  private animationFrame?: number;
  private renderTimer?: ReturnType<typeof setInterval>;
  private metricTimer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private preparing = false;
  private starting = false;

  constructor(options: StudioOptions) {
    if (!options.engine || typeof options.engine.layout !== 'function') throw new Error('The OBS Wasm engine is required to compose the outputs.');
    this.engine = options.engine;
    this.metrics.engineBackend = options.engine.backend ?? 'obs-wasm-subset';
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  attachCanvases(canvases: Record<Orientation, HTMLCanvasElement>): void {
    if (this.state === 'recording' || this.state === 'stopping') throw new Error('Output canvases cannot change during recording.');
    this.canvases = canvases;
    // These canvases consume live video and feed captureStream(), without
    // JavaScript pixel reads. Let the browser retain its accelerated path.
    const landscape = canvases.landscape.getContext('2d', { alpha: false });
    const portrait = canvases.portrait.getContext('2d', { alpha: false });
    if (!landscape || !portrait) throw new Error('Canvas 2D is unavailable.');
    this.contexts = { landscape, portrait };
  }

  subscribe(listener: (event: StudioEvent) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): StudioEvent {
    return {
      state: this.state, config: this.config ? { ...this.config, appearance: this.cloneAppearance() } : undefined, appearance: this.cloneAppearance(), countdown: this.getCountdownStatus(), error: this.error, result: this.result,
      controls: { ...this.controls, sourceVisibility: { ...this.controls.sourceVisibility } },
      metrics: {
        ...this.metrics, layerSources: this.metrics.layerSources ? Object.fromEntries(Object.entries(this.metrics.layerSources).map(([id, value]) => [id, { ...value }])) : undefined, frames: { ...this.metrics.frames }, bytes: { ...this.metrics.bytes }, chunks: { ...this.metrics.chunks },
        microphone: this.metrics.microphone ? { ...this.metrics.microphone, settings: this.metrics.microphone.settings ? { ...this.metrics.microphone.settings } : undefined } : undefined,
        sources: this.metrics.sources ? {
          camera: { ...this.metrics.sources.camera, settings: this.metrics.sources.camera.settings ? { ...this.metrics.sources.camera.settings } : undefined },
          screen: { ...this.metrics.sources.screen, settings: this.metrics.sources.screen.settings ? { ...this.metrics.sources.screen.settings } : undefined },
        } : undefined,
      },
    };
  }

  async getAvailableDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return navigator.mediaDevices.enumerateDevices();
  }

  async prepare(config: StudioConfig): Promise<void> {
    if (this.disposed) throw new Error('This session is already closed.');
    if (this.preparing || this.starting || this.state === 'recording' || this.state === 'stopping') throw new Error('Wait for the current recording to finish.');
    if (!this.canvases || !this.contexts) throw new Error('Attach both output canvases before preparing capture.');
    this.preparing = true;
    this.error = undefined;
    this.state = 'preparing';
    this.emit();
    this.releaseSources();
    this.revokeResult();
    const layout = config.layout ?? this.preferredLayout ?? (config.source === 'camera' ? 'camera' : 'screen');
    this.controls.cameraZoom = Math.min(2.5, Math.max(1, Number.isFinite(config.zoom) ? config.zoom! : this.controls.cameraZoom));
    this.config = { ...config, zoom: this.controls.cameraZoom, layout };
    // Aliases name the pixels captured by this preparation. Scene changes must
    // never retarget an existing camera or screen to a different source ID.
    this.cameraSourceId = config.cameraSourceId;
    this.screenSourceId = config.screenSourceId;
    this.sceneAppearance = normalizeSceneAppearance(this.config.layout!, config.appearance ?? (this.appearanceExplicit ? this.sceneAppearance : undefined));
    this.appearanceExplicit = !!config.appearance;
    this.syncLayerVisibility();
    this.controls.microphoneMuted = this.sceneAppearance.microphoneMuted;
    this.controls.microphoneGainDb = this.sceneAppearance.microphoneGainDb;
    this.config.appearance = this.sceneAppearance;
    this.countdownRemainingMs = this.sceneAppearance.countdownSeconds * 1000;
    this.countdownStartedAt = undefined;
    this.metrics = {
      elapsedMs: 0, frames: { landscape: 0, portrait: 0 }, measuredFps: 0,
      bytes: { landscape: 0, portrait: 0 }, chunks: { landscape: 0, portrait: 0 },
      pendingWrites: 0, hidden: document.hidden, audio: false, audioLevel: 0, audioLevelDb: -100, rawMicLevel: 0, rawMicLevelDb: -100,
      engineBackend: this.engine.backend ?? 'obs-wasm-subset', mimeType: '',
    };
    try {
      for (const id of [this.cameraSourceId, this.screenSourceId]) {
        if (!id) continue;
        const entry = this.layerInputs.get(id);
        if (!entry?.stream || entry.stream.getVideoTracks().some(track => track.readyState === 'live')) continue;
        // A dead primary capture must not shadow its freshly prepared alias.
        this.layerLoads.set(id, (this.layerLoads.get(id) ?? 0) + 1);
        this.disposeLayerInput(entry); this.layerInputs.delete(id);
      }
      this.metrics.mimeType = chooseRecordingMimeType(config);
      const dimensions = recordingDimensions(config.resolution);
      for (const orientation of ORIENTATIONS) {
        this.canvases[orientation].width = dimensions[orientation][0];
        this.canvases[orientation].height = dimensions[orientation][1];
      }
      this.audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      // Invoke screen selection in the original click's activation window,
      // before permissions or loading the audio worklet can consume it.
      const needsCamera = this.sceneAppearance.layers.some(layer => layer.kind === 'camera' && layer.visible && !layer.assetId && (!layer.sourceId || layer.sourceId === this.cameraSourceId && !this.layerInputs.has(layer.sourceId)));
      const needsScreen = this.sceneAppearance.layers.some(layer => layer.kind === 'screen' && layer.visible && !layer.assetId && (!layer.sourceId || layer.sourceId === this.screenSourceId && !this.layerInputs.has(layer.sourceId)));
      const displayPromise = config.source === 'screen' && needsScreen
        ? navigator.mediaDevices.getDisplayMedia({ video: displayVideoConstraints(config), audio: true })
        : undefined;
      if (displayPromise) {
        const display = await displayPromise;
        this.assertSessionOpen(display);
        this.capturedStreams.push(display);
        await constrainDisplayStream(display, config);
        this.assertSessionOpen(display);
        this.source = await this.videoFor(display);
      }
      for (const entry of this.layerInputs.values()) {
        if (entry.kind === 'screen' && entry.stream?.getVideoTracks().some(track => track.readyState === 'live')) await constrainDisplayStream(entry.stream, config);
      }
      this.assertSessionOpen();
      // Permission-granted refreshes can still lack browser audio activation.
      // Preview must become ready while suspended; start() resumes from Record.
      void this.audioContext.resume().catch(() => undefined);
      this.audioDestination = this.audioContext.createMediaStreamDestination();
      const gain = this.audioContext.createGain();
      gain.gain.value = this.engine.audioGainDb?.(0) ?? 1;
      gain.connect(this.audioDestination);
      const mix = this.engine.createCompressorNode ? await this.engine.createCompressorNode(this.audioContext) : this.audioContext.createGain();
      this.assertSessionOpen();
      mix.connect(gain);
      this.audioMix = mix;
      this.audioNodes.push(mix, gain);
      this.microphoneGain = this.audioContext.createGain();
      this.rawMicrophoneAnalyser = this.audioContext.createAnalyser();
      this.rawMicrophoneAnalyser.fftSize = 1024;
      this.rawMicrophoneSamples = new Float32Array(this.rawMicrophoneAnalyser.fftSize);
      this.rawMicrophoneAnalyser.connect(this.microphoneGain);
      this.audioNodes.push(this.rawMicrophoneAnalyser);
      this.microphoneAnalyser = this.audioContext.createAnalyser();
      this.microphoneAnalyser.fftSize = 1024;
      this.microphoneSamples = new Float32Array(this.microphoneAnalyser.fftSize);
      this.microphoneGain.connect(this.microphoneAnalyser);
      this.microphoneAnalyser.connect(mix);
      this.audioNodes.push(this.microphoneGain, this.microphoneAnalyser);
      this.applyMicrophoneGain();
      if (config.source === 'test') this.prepareTestSource(mix);
      else {
        if (!needsCamera) await this.prepareCountdownAudio(config);
        else await this.prepareDevices(config, mix);
        if (config.source === 'media') {
          if (!this.localMedia) throw new Error('Escolha uma imagem ou vídeo antes de conectar esta fonte.');
          await this.localMedia.play();
          this.source = this.localMedia.element;
        }
      }
      if (this.disposed) throw new Error('Preparation was cancelled.');
      this.assertCaptureLive();
      const dimensionsOf = (source: HTMLVideoElement | HTMLCanvasElement | undefined) => source instanceof HTMLVideoElement ? [source.videoWidth, source.videoHeight] : source ? [source.width, source.height] : [0, 0];
      const [sourceWidth, sourceHeight] = dimensionsOf(this.source!);
      const [cameraWidth, cameraHeight] = dimensionsOf(this.camera!);
      const settingsOf = (source: HTMLVideoElement | HTMLCanvasElement | undefined) => source instanceof HTMLVideoElement && source.srcObject instanceof MediaStream ? source.srcObject.getVideoTracks()[0]?.getSettings() : undefined;
      this.metrics.captureInfo = {
        sourceKind: config.source, sourceWidth, sourceHeight, cameraWidth, cameraHeight,
        sourceFps: settingsOf(this.source!)?.frameRate, cameraFps: settingsOf(this.camera!)?.frameRate,
        note: 'Output size is independent of capture detail. Lower-resolution inputs are scaled; actual recording frame rate depends on this computer.',
      };
      this.metrics.audio = this.audioDestination.stream.getAudioTracks().length > 0;
      this.connectLayerAudio();
      this.updateLayerActivity();
      this.updateSourceStatus();
      this.renderStart = performance.now();
      this.lastDraw = 0;
      this.nextDrawAt = 0;
      this.render(performance.now(), true);
      if (this.error) throw new Error(this.error);
      this.startRendering();
      this.state = 'ready';
      this.emit();
    } catch (error) {
      this.releaseSources();
      this.state = 'error';
      this.error = readableError(error);
      this.emit();
      throw error;
    } finally { this.preparing = false; }
  }

  setLayout(layout: StudioLayout): void {
    const previous = this.config?.layout ?? this.preferredLayout;
    this.preferredLayout = layout;
    if (!this.appearanceExplicit) this.sceneAppearance = defaultSceneAppearance(layout);
    this.syncLayerVisibility();
    this.updateLayerActivity();
    this.updateSourceStatus();
    if (previous !== layout && layout === 'countdown') {
      this.countdownRemainingMs = this.sceneAppearance.countdownSeconds * 1000;
      this.countdownStartedAt = undefined;
    }
    if (previous === 'countdown' && layout !== 'countdown') this.pauseCountdown(false);
    if (this.config && !this.preparing) {
      this.config.layout = layout;
      this.config.appearance = this.sceneAppearance;
      this.render(performance.now(), true);
    }
    this.emit();
  }

  setSceneAppearance(appearance: Partial<SceneAppearance>): void {
    const oldDuration = this.sceneAppearance.countdownSeconds;
    this.sceneAppearance = normalizeSceneAppearance(this.config?.layout ?? this.preferredLayout ?? 'camera', appearance);
    this.appearanceExplicit = true;
    this.controls.microphoneMuted = this.sceneAppearance.microphoneMuted;
    this.controls.microphoneGainDb = this.sceneAppearance.microphoneGainDb;
    this.applyMicrophoneGain();
    this.syncLayerVisibility();
    this.updateLayerActivity();
    this.updateSourceStatus();
    if (this.config) this.config.appearance = this.sceneAppearance;
    if (oldDuration !== this.sceneAppearance.countdownSeconds) {
      this.countdownRemainingMs = this.sceneAppearance.countdownSeconds * 1000;
      this.countdownStartedAt = undefined;
    }
    this.render(performance.now(), true); this.emit();
  }

  async setSceneBackground(blob?: Blob, assetId?: string): Promise<void> {
    const generation = ++this.sceneBackgroundLoad;
    const bitmap = blob ? await createImageBitmap(blob) : undefined;
    if (this.disposed || generation !== this.sceneBackgroundLoad) { bitmap?.close(); return; }
    this.sceneBackground?.close(); this.sceneBackground = bitmap; this.sceneBackgroundAssetId = assetId;
    this.render(performance.now(), true); this.emit();
  }

  resetCountdown(): void {
    this.countdownRemainingMs = this.sceneAppearance.countdownSeconds * 1000;
    this.countdownStartedAt = undefined;
    this.render(performance.now(), true); this.emit();
  }
  zeroCountdown(): void {
    this.countdownRemainingMs = 0; this.countdownStartedAt = undefined;
    this.render(performance.now(), true); this.emit();
  }
  pauseCountdown(emit = true): void {
    this.countdownRemainingMs = this.countdownMilliseconds(performance.now()); this.countdownStartedAt = undefined;
    if (emit) { this.render(performance.now(), true); this.emit(); }
  }
  resumeCountdown(): void {
    if (this.countdownMilliseconds(performance.now()) <= 0) { this.countdownStartedAt = undefined; this.emit(); return; }
    if (this.countdownStartedAt === undefined) this.countdownStartedAt = performance.now();
    this.render(performance.now(), true); this.emit();
  }
  private countdownMilliseconds(now: number): number {
    return Math.max(0, this.countdownRemainingMs - (this.countdownStartedAt === undefined ? 0 : Math.max(0, now - this.countdownStartedAt)));
  }
  private getCountdownStatus(now = performance.now()): CountdownStatus {
    const remaining = this.countdownMilliseconds(now);
    return { remainingSeconds: Math.ceil(remaining / 1000), running: this.countdownStartedAt !== undefined && remaining > 0 };
  }
  private cloneAppearance(): SceneAppearance { return { ...this.sceneAppearance, layers: this.sceneAppearance.layers.map(layer => ({ ...layer, frames: layer.frames ? Object.fromEntries(Object.entries(layer.frames).map(([orientation, frame]) => [orientation, { ...frame }])) : undefined })) }; }
  private syncLayerVisibility(): void {
    for (const kind of ['camera', 'screen'] as const) this.controls.sourceVisibility[kind] = this.sceneAppearance.layers.some(layer => layer.kind === kind && layer.visible);
  }
  private visual(source: HTMLVideoElement | HTMLCanvasElement | undefined): SceneVisualSource | undefined {
    if (!source) return undefined;
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    return width && height ? { element: source, width, height } : undefined;
  }
  renderSceneToCanvas(canvas: HTMLCanvasElement, options: ScenePreviewOptions): boolean {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return false;
    const camera = this.visual(this.camera);
    const screen = this.config?.source !== 'camera' ? this.visual(this.source) : undefined;
    const layerSources = this.layerVisuals();
    if (options.layout !== 'countdown' && !camera && !screen && !Object.keys(layerSources).length && !options.appearance?.layers?.some(layer => layer.visible && (layer.kind === 'title' || layer.kind === 'timer' || layer.kind === 'background'))) return false;
    const appearance = normalizeSceneAppearance(options.layout, options.appearance);
    const activeBackground = appearance.backgroundAssetId === this.sceneBackgroundAssetId ? this.sceneBackground : undefined;
    this.compositor.render(context, canvas.width, canvas.height, {
      layout: options.layout, appearance, zoom: options.zoom ?? 1.4,
      orientation: options.orientation ?? (canvas.width >= canvas.height ? 'landscape' : 'portrait'),
      remainingSeconds: options.layout === 'countdown' && this.config?.layout === 'countdown' ? this.getCountdownStatus(options.now).remainingSeconds : appearance.countdownSeconds,
      camera, screen, layerSources, background: options.background === undefined ? activeBackground : options.background, engine: this.engine,
    });
    return true;
  }

  private registryKey(id: string): string {
    const layer = this.sceneAppearance.layers.find(layer => layer.id === id || layer.sourceId === id);
    return layer?.sourceId ?? id;
  }
  private layerVisuals(): Record<string, SceneVisualSource> {
    const result: Record<string, SceneVisualSource> = {};
    if (this.cameraSourceId && this.getSourceStatus(this.cameraSourceId)?.live) {
      const visual = this.visual(this.camera); if (visual) result[this.cameraSourceId] = visual;
    }
    if (this.screenSourceId && this.config?.source !== 'camera' && this.getSourceStatus(this.screenSourceId)?.live) {
      const visual = this.visual(this.source); if (visual) result[this.screenSourceId] = visual;
    }
    for (const [id, entry] of this.layerInputs) { const visual = this.visual(entry.element); if (visual && (!entry.stream || entry.stream.getVideoTracks().some(track => track.readyState === 'live'))) result[id] = visual; }
    return result;
  }
  private inputStatus(source: HTMLVideoElement | HTMLCanvasElement | undefined, visible: boolean, label?: string): StudioSourceStatus {
    const track = source instanceof HTMLVideoElement && source.srcObject instanceof MediaStream ? source.srcObject.getVideoTracks()[0] : undefined;
    const settings = track?.getSettings(), visual = this.visual(source);
    const available = !!visual;
    return {
      available, live: available && (!track || track.readyState === 'live'), enabled: available && (track?.enabled ?? true), visible,
      label: available ? label ?? track?.label : undefined,
      settings, deviceId: settings?.deviceId, width: settings?.width ?? visual?.width, height: settings?.height ?? visual?.height, frameRate: settings?.frameRate,
    };
  }
  /** A project source remains inspectable while another scene is selected. */
  getSourceStatus(id: string): StudioSourceStatus | undefined {
    const key = this.registryKey(id), entry = this.layerInputs.get(key);
    if (entry) return this.inputStatus(entry.element, this.isLayerActive(key), entry.name);
    if (key === this.cameraSourceId) return this.inputStatus(this.camera, this.isLayerActive(key), this.camera instanceof HTMLCanvasElement ? 'Generated camera' : undefined);
    if (key === this.screenSourceId) return this.inputStatus(this.config?.source !== 'camera' ? this.source : undefined, this.isLayerActive(key), this.config?.source === 'media' ? this.localMedia?.name : this.source instanceof HTMLCanvasElement ? 'Generated screen' : undefined);
    return undefined;
  }
  hasLayerSource(id: string): boolean {
    const status = this.getSourceStatus(id);
    if (status) return status.live;
    const layer = this.sceneAppearance.layers.find(layer => layer.id === id || layer.sourceId === id);
    if (!layer || layer.sourceId || layer.assetId) return false;
    return layer.kind === 'camera' ? this.inputStatus(this.camera, layer.visible).live : layer.kind === 'screen' ? this.config?.source !== 'camera' && this.inputStatus(this.source, layer.visible).live : false;
  }
  getLayerBounds(orientation: Orientation): Record<string, LayerFrame> {
    const width = this.canvases?.[orientation].width || (orientation === 'landscape' ? 1920 : 1080);
    const height = this.canvases?.[orientation].height || (orientation === 'landscape' ? 1080 : 1920);
    const camera = this.visual(this.camera), screen = this.visual(this.source), local = this.layerVisuals();
    const screenLayer = this.sceneAppearance.layers.find(layer => layer.kind === 'screen');
    const presentationScreen = screenLayer ? local[screenLayer.sourceId ?? screenLayer.id] ?? (!screenLayer.sourceId && !screenLayer.assetId ? screen : undefined) : screen;
    return Object.fromEntries(this.sceneAppearance.layers.map(layer => {
      const source = local[layer.sourceId ?? layer.id];
      const layerScreen = layer.kind === 'screen' ? source ?? presentationScreen : presentationScreen;
      return [layer.id, getLayerFrame(layer, { layout: this.config?.layout ?? this.preferredLayout ?? 'camera', appearance: this.sceneAppearance, orientation, width, height, cameraWidth: source?.width ?? camera?.width, cameraHeight: source?.height ?? camera?.height, screenWidth: layerScreen?.width, screenHeight: layerScreen?.height })];
    }));
  }
  private isLayerActive(key: string): boolean { return this.sceneAppearance.layers.some(layer => layer.visible && (layer.sourceId ?? layer.id) === key); }
  private isLegacyInputActive(kind: 'camera' | 'screen'): boolean {
    const id = kind === 'camera' ? this.cameraSourceId : this.screenSourceId;
    if (!id) return true;
    const unbound = this.sceneAppearance.layers.some(layer => layer.visible && layer.kind === kind && !layer.sourceId && !layer.assetId);
    return unbound || !this.layerInputs.has(id) && this.isLayerActive(id);
  }
  private isCapturedTrackActive(stream: MediaStream, track: MediaStreamTrack): boolean {
    if (track.kind === 'audio' && stream === this.microphoneStream) return true;
    const camera = this.camera instanceof HTMLVideoElement ? this.camera.srcObject : undefined;
    return this.isLegacyInputActive(track.kind === 'video' && stream === camera ? 'camera' : 'screen');
  }
  private disposeLayerInput(entry: LayerInput): void {
    entry.audioSource?.disconnect(); entry.audioGain?.disconnect();
    entry.stream?.getTracks().forEach(track => track.stop());
    if (entry.media) entry.media.dispose();
    else if (entry.element instanceof HTMLVideoElement) { entry.element.pause(); entry.element.srcObject = null; }
  }
  private releaseLegacyInput(key: string): void {
    if (key === this.cameraSourceId && this.camera) {
      const camera = this.camera;
      if (camera instanceof HTMLVideoElement && camera.srcObject instanceof MediaStream) {
        const stream = camera.srcObject;
        // The original camera stream may also own the microphone. Replacing
        // its visual source must preserve that microphone and audio routing.
        for (const track of stream.getVideoTracks()) { stream.removeTrack(track); track.stop(); }
        if (!stream.getTracks().length) this.capturedStreams = this.capturedStreams.filter(value => value !== stream);
      }
      if (camera instanceof HTMLVideoElement) { camera.pause(); camera.srcObject = null; this.videos = this.videos.filter(value => value !== camera); }
      if (this.source === camera) this.source = undefined;
      this.camera = undefined;
    }
    if (key === this.screenSourceId && this.config?.source !== 'camera' && this.source) {
      const source = this.source;
      if (source instanceof HTMLVideoElement && source.srcObject instanceof MediaStream) {
        const stream = source.srcObject;
        stream.getTracks().forEach(track => track.stop());
        this.capturedStreams = this.capturedStreams.filter(value => value !== stream);
      }
      if (source instanceof HTMLVideoElement) { source.pause(); source.srcObject = null; this.videos = this.videos.filter(value => value !== source); }
      this.source = undefined;
    }
  }
  removeLayerSource(id: string): void {
    const key = this.registryKey(id); this.layerLoads.set(key, (this.layerLoads.get(key) ?? 0) + 1);
    const entry = this.layerInputs.get(key); if (entry) this.disposeLayerInput(entry);
    this.releaseLegacyInput(key);
    this.layerInputs.delete(key); this.updateSourceStatus(); this.render(performance.now(), true); this.emit();
  }
  async setLayerMediaSource(id: string, file: File): Promise<void> {
    if (this.disposed || this.preparing || this.state === 'stopping') throw new Error('Aguarde o estúdio terminar de conectar as fontes.');
    const key = this.registryKey(id), generation = (this.layerLoads.get(key) ?? 0) + 1; this.layerLoads.set(key, generation);
    const media = await LocalMediaSource.open(file);
    if (this.disposed || this.layerLoads.get(key) !== generation) { media.dispose(); return; }
    const previous = this.layerInputs.get(key);
    this.layerInputs.set(key, { element: media.element, media, name: file.name, kind: 'media' });
    if (previous) this.disposeLayerInput(previous);
    this.updateLayerActivity(); this.updateSourceStatus(); this.render(performance.now(), true); this.emit();
  }
  async captureLayerScreen(id: string): Promise<void> {
    if (this.disposed || this.preparing || this.state === 'stopping') throw new Error('Aguarde o estúdio terminar de conectar as fontes.');
    const key = this.registryKey(id), generation = (this.layerLoads.get(key) ?? 0) + 1; this.layerLoads.set(key, generation);
    // Invoke the display chooser immediately in the original click activation.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: displayVideoConstraints(this.config), audio: true });
    try {
      this.assertSessionOpen(stream);
      await constrainDisplayStream(stream, this.config);
      this.assertSessionOpen(stream);
      const video = await this.videoFor(stream, false);
      if (this.disposed || this.layerLoads.get(key) !== generation) { stream.getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null; return; }
      const previous = this.layerInputs.get(key);
      this.layerInputs.set(key, { element: video, stream, name: stream.getVideoTracks()[0]?.label || 'Tela compartilhada', kind: 'screen' });
      if (previous) this.disposeLayerInput(previous);
      this.releaseLegacyInput(key);
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (this.layerInputs.get(key)?.stream !== stream) return;
        if (this.state === 'recording' && this.isLayerActive(key)) this.failDuringRecording(new Error('Uma tela compartilhada desta cena foi encerrada. As duas gravações foram interrompidas.'));
        this.updateSourceStatus(); this.emit();
      });
      this.connectLayerAudio(); this.updateLayerActivity(); this.updateSourceStatus(); this.render(performance.now(), true); this.emit();
    } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  }
  async captureLayerCamera(id: string, deviceId?: string): Promise<void> {
    if (this.disposed || this.preparing || this.state === 'stopping') throw new Error('Aguarde o estúdio terminar de conectar as fontes.');
    const key = this.registryKey(id), generation = (this.layerLoads.get(key) ?? 0) + 1; this.layerLoads.set(key, generation);
    const [width, height] = recordingDimensions(this.config?.resolution ?? '1080').landscape;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: this.config?.fps ?? 30 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      audio: false,
    });
    try {
      this.assertSessionOpen(stream);
      const video = await this.videoFor(stream, false);
      if (this.disposed || this.layerLoads.get(key) !== generation) { stream.getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null; return; }
      const previous = this.layerInputs.get(key);
      this.layerInputs.set(key, { element: video, stream, name: stream.getVideoTracks()[0]?.label || 'Câmera', kind: 'camera' });
      if (previous) this.disposeLayerInput(previous);
      this.releaseLegacyInput(key);
      if (this.config && key === this.config.cameraSourceId) this.config.cameraDeviceId = deviceId;
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
        if (this.layerInputs.get(key)?.stream !== stream) return;
        if (this.state === 'recording' && this.isLayerActive(key)) this.failDuringRecording(new Error('Uma câmera desta cena foi desconectada. As duas gravações foram interrompidas.'));
        this.updateSourceStatus(); this.emit();
      });
      this.updateLayerActivity(); this.updateSourceStatus(); this.render(performance.now(), true); this.emit();
    } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  }
  private connectLayerAudio(): void {
    if (!this.audioContext || !this.audioMix) return;
    for (const entry of this.layerInputs.values()) {
      if (entry.audioSource || !entry.stream?.getAudioTracks().some(track => track.readyState === 'live')) continue;
      const source = this.audioContext.createMediaStreamSource(new MediaStream(entry.stream.getAudioTracks()));
      const gain = this.audioContext.createGain(); source.connect(gain); gain.connect(this.audioMix);
      entry.audioSource = source; entry.audioGain = gain;
    }
  }
  private updateLayerActivity(): void {
    for (const [key, entry] of this.layerInputs) {
      const active = this.isLayerActive(key);
      if (entry.element instanceof HTMLVideoElement) {
        if (active) void entry.element.play().catch(() => undefined);
        else entry.element.pause();
      }
      if (entry.audioGain && this.audioContext) entry.audioGain.gain.setValueAtTime(active ? 1 : 0, this.audioContext.currentTime);
    }
  }

  /** Change only the camera, retaining display/file capture and microphone audio. */
  async replaceCamera(deviceId?: string): Promise<void> {
    if (this.disposed || !this.config || !this.audioContext) throw new Error('Conecte as fontes antes de trocar a câmera.');
    if (this.preparing || this.starting || this.state === 'recording' || this.state === 'stopping') throw new Error('Aguarde a conexão ou finalize a gravação antes de trocar a câmera.');
    const previousState = this.state;
    const previousCamera = this.camera;
    const previousStream = previousCamera instanceof HTMLVideoElement && previousCamera.srcObject instanceof MediaStream ? previousCamera.srcObject : undefined;
    this.preparing = true; this.state = 'preparing'; this.emit();
    let stream: MediaStream | undefined;
    try {
      const [width, height] = recordingDimensions(this.config.resolution).landscape;
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: this.config.fps }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false });
      this.assertSessionOpen(stream);
      const camera = await this.videoFor(stream);
      if (this.disposed) throw new Error('O estúdio foi fechado.');
      this.camera = camera;
      if (this.source === previousCamera || this.config.source === 'camera') this.source = camera;
      this.capturedStreams.push(stream);
      if (previousStream) {
        // Keep the microphone track and its existing WebAudio routing alive.
        // Remove stopped video tracks so later liveness checks see only inputs
        // still owned by this session.
        for (const track of previousStream.getVideoTracks()) { previousStream.removeTrack(track); track.stop(); }
        if (!previousStream.getTracks().length) this.capturedStreams = this.capturedStreams.filter(value => value !== previousStream);
      }
      if (previousCamera instanceof HTMLVideoElement) {
        previousCamera.pause(); previousCamera.srcObject = null;
        this.videos = this.videos.filter(value => value !== previousCamera);
      }
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
        if (this.isLegacyInputActive('camera')) {
          if (this.state === 'recording') this.failDuringRecording(new Error('A câmera foi desconectada. As duas gravações foram interrompidas.'));
          else if (this.state === 'ready' || this.state === 'complete') { this.state = 'error'; this.error = 'A câmera foi desconectada. Conecte-a novamente.'; }
        }
        this.updateSourceStatus(); this.emit();
      });
      this.config.cameraDeviceId = deviceId; this.sceneAppearance.cameraDeviceId = deviceId;
      const settings = stream.getVideoTracks()[0]?.getSettings();
      const primary = this.visual(this.source);
      this.metrics.captureInfo = { ...this.metrics.captureInfo!, sourceKind: this.config.source, sourceWidth: primary?.width ?? 0, sourceHeight: primary?.height ?? 0, cameraWidth: camera.videoWidth, cameraHeight: camera.videoHeight, cameraFps: settings?.frameRate };
      this.state = previousState === 'complete' ? 'complete' : 'ready';
      this.updateSourceStatus(); this.render(performance.now(), true); this.emit();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      this.state = previousState; this.emit();
      throw new Error(readableError(error), { cause: error });
    } finally { this.preparing = false; }
  }

  async replaceMicrophone(deviceId?: string): Promise<void> {
    if (this.disposed || !this.config || !this.audioContext) throw new Error('Conecte as fontes antes de trocar o microfone.');
    if (this.preparing || this.starting || this.state === 'recording' || this.state === 'stopping') throw new Error('Aguarde a conexão ou finalize a gravação antes de trocar o microfone.');
    const previousState = this.state, previous = this.microphoneStream;
    this.preparing = true; this.state = 'preparing'; this.emit();
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
      if (this.disposed) throw new Error('O estúdio foi fechado.');
      this.microphoneInput?.disconnect(); this.microphoneInput = undefined;
      this.microphoneStream = stream; this.capturedStreams.push(stream);
      this.connectAudio(stream, this.microphoneGain!);
      if (previous) {
        for (const track of previous.getAudioTracks()) { previous.removeTrack(track); track.stop(); }
        if (!previous.getTracks().length) this.capturedStreams = this.capturedStreams.filter(value => value !== previous);
      }
      this.config.microphone = true; this.config.microphoneDeviceId = deviceId; this.sceneAppearance.microphoneDeviceId = deviceId;
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => { if (this.state === 'recording') this.failDuringRecording(new Error('O microfone foi desconectado. As duas gravações foram interrompidas.')); this.updateSourceStatus(); this.emit(); });
      this.applyMicrophoneGain(); this.updateAudioLevel(); this.state = previousState === 'complete' ? 'complete' : 'ready'; this.updateSourceStatus(); this.emit();
    } catch (error) { stream?.getTracks().forEach(track => track.stop()); this.state = previousState; this.emit(); throw new Error(readableError(error), { cause: error }); }
    finally { this.preparing = false; }
  }

  async setMediaSource(file: File): Promise<void> {
    if (this.preparing || this.starting || this.state === 'recording' || this.state === 'stopping') throw new Error('Finalize a gravação antes de adicionar uma mídia.');
    const media = await LocalMediaSource.open(file);
    if (this.disposed) { media.dispose(); throw new Error('O estúdio foi fechado.'); }
    this.localMedia?.dispose();
    this.localMedia = media;
    if (this.config) {
      // Stop an old display capture when replacing it with a local visual file.
      const cameraStream = this.camera instanceof HTMLVideoElement ? this.camera.srcObject : undefined;
      this.capturedStreams = this.capturedStreams.filter(stream => {
        if (stream === cameraStream || stream === this.microphoneStream) return true;
        stream.getTracks().forEach(track => track.stop()); return false;
      });
      this.source = media.element;
      this.config.source = 'media';
      this.metrics.captureInfo = { ...this.metrics.captureInfo!, sourceKind: 'media', sourceWidth: media.width, sourceHeight: media.height };
      this.updateSourceStatus();
      this.render(performance.now(), true);
    }
    this.emit();
  }

  clearMediaSource(): void {
    if (this.preparing || this.starting || this.state === 'recording' || this.state === 'stopping') throw new Error('Aguarde a conexão ou finalize a gravação antes de remover uma mídia.');
    if (this.config?.source === 'media') {
      this.source = this.camera;
      this.config.source = 'camera';
      if (this.config.layout === 'screen' || this.config.layout === 'screen-3d') this.config.layout = 'camera';
    }
    this.localMedia?.dispose(); this.localMedia = undefined;
    this.updateSourceStatus(); this.render(performance.now(), true); this.emit();
  }

  setCameraZoom(value: number): void {
    if (!Number.isFinite(value)) return;
    this.controls.cameraZoom = Math.min(2.5, Math.max(1, value));
    if (this.config) this.config.zoom = this.controls.cameraZoom;
    this.render(performance.now(), true);
    this.emit();
  }

  setSourceVisible(source: 'camera' | 'screen', visible: boolean): void {
    const layers = this.sceneAppearance.layers.filter(layer => layer.kind === source);
    if (layers.length) layers.forEach(layer => { layer.visible = visible; });
    else if (visible) this.sceneAppearance.layers.push({ id: source, kind: source, name: source === 'camera' ? 'Câmera' : 'Tela ou mídia', visible: true });
    this.syncLayerVisibility();
    this.updateLayerActivity();
    if (this.config) this.config.appearance = this.sceneAppearance;
    this.updateSourceStatus();
    this.render(performance.now(), true);
    this.emit();
  }

  setMicrophoneMuted(muted: boolean): void {
    this.controls.microphoneMuted = muted;
    this.sceneAppearance.microphoneMuted = muted;
    this.applyMicrophoneGain();
    this.updateSourceStatus();
    this.updateAudioLevel();
    this.emit();
  }

  setMicrophoneGain(decibels: number): void {
    if (!Number.isFinite(decibels)) return;
    this.controls.microphoneGainDb = Math.min(12, Math.max(-60, decibels));
    this.sceneAppearance.microphoneGainDb = this.controls.microphoneGainDb;
    this.applyMicrophoneGain();
    this.updateAudioLevel();
    this.emit();
  }

  async start(): Promise<void> {
    if (this.starting) throw new Error('Recording is already starting.');
    if (this.state !== 'ready' && this.state !== 'complete') throw new Error('Prepare the sources before recording.');
    if (!this.canvases || !this.audioContext || !this.audioDestination) throw new Error('Capture is not prepared.');
    this.assertCaptureLive();
    this.starting = true;
    this.revokeResult();
    this.error = undefined;
    this.writeError = undefined;
    this.recordingError = undefined;
    this.stopPromise = undefined;
    this.paths = {};
    this.writes = { landscape: Promise.resolve(), portrait: Promise.resolve() };
    this.pendingBytes = 0;
    this.metrics.bytes = { landscape: 0, portrait: 0 };
    this.metrics.chunks = { landscape: 0, portrait: 0 };
    this.metrics.frames = { landscape: 0, portrait: 0 };
    this.metrics.elapsedMs = 0;
    this.metrics.measuredFps = 0;
    this.metrics.hidden = document.hidden;
    this.metrics.warning = document.hidden ? BACKGROUND_WARNING : undefined;
    this.lowFpsWindows = 0;
    this.metrics.mimeType = chooseRecordingMimeType(this.config);
    try {
      await this.audioContext.resume();
      this.store = new RecordingStore(this.metrics.mimeType);
      await this.store.open();
      const bitrate = this.videoBitrate();
      this.metrics.storage = await estimateCapacity(this.store.kind, bitrate);
      // The idle preview may use smaller canvases. Paint a complete frame at
      // the selected recording size before either captureStream is created.
      this.render(performance.now(), true);
      if (this.error) throw new Error(this.error);
      for (const orientation of ORIENTATIONS) {
        // Let the browser's capture clock deliver changed canvas frames. A
        // zero-rate stream driven by requestFrame can stall its video encoder
        // while the independent audio clock keeps running.
        const stream = this.canvases[orientation].captureStream(this.config!.fps);
        this.outputStreams.push(stream);
        const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
        if (!track) throw new Error('The video output could not be captured.');
        for (const audio of this.audioDestination.stream.getAudioTracks()) stream.addTrack(audio.clone());
        const recorder = new MediaRecorder(stream, { mimeType: this.metrics.mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128_000 });
        let resolveStopped!: () => void;
        const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
        recorder.onstart = () => {
          this.metrics.mimeType = recorder.mimeType || this.metrics.mimeType;
          this.store!.setMimeType(this.metrics.mimeType);
        };
        recorder.ondataavailable = event => {
          if (!event.data.size) return;
          // Browsers may select a different AVC profile/level than requested.
          // A stopped recorder may revert its MIME to the requested profile.
          const activeMime = recorder.state === 'inactive' ? this.metrics.mimeType : recorder.mimeType;
          this.metrics.mimeType = event.data.type.includes('codecs=') ? event.data.type : activeMime || event.data.type || this.metrics.mimeType;
          this.store!.setMimeType(this.metrics.mimeType);
          this.queueChunk(orientation, event.data);
        };
        recorder.onstop = () => resolveStopped();
        recorder.onerror = event => this.failDuringRecording((event as Event & { error?: DOMException }).error ?? new Error('The encoder stopped recording.'));
        this.paths[orientation] = { recorder, stream, track: stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack, stopped, resolveStopped };
      }
      this.startedAt = Date.now();
      this.startedPerformance = performance.now();
      this.lastMetricTime = this.startedPerformance;
      this.metricFrameBaseline = 0;
      // Both encoders receive independently composed canvases and the same
      // WebAudio clock; capture frame rate is declared to each browser encoder.
      for (const orientation of ORIENTATIONS) this.paths[orientation]!.recorder.start(1000);
      this.state = 'recording';
      this.render(performance.now(), true);
      this.emit();
    } catch (error) {
      for (const path of Object.values(this.paths)) {
        if (path?.recorder.state !== 'inactive') path?.recorder.stop();
        else path?.resolveStopped();
      }
      await this.waitForRecordersStopped(5000).catch(() => undefined);
      await Promise.all(Object.values(this.writes));
      await this.store?.abort();
      this.releaseOutputTracks();
      this.state = 'error';
      this.error = readableError(error);
      this.emit();
      throw error;
    } finally { this.starting = false; }
  }

  stop(): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state !== 'recording') return this.result ? Promise.resolve(this.result) : Promise.reject(new Error('No recording is in progress.'));
    this.state = 'stopping';
    const stoppedAt = Date.now();
    const durationMs = performance.now() - this.startedPerformance;
    this.metrics.elapsedMs = durationMs;
    this.emit();
    this.stopPromise = this.finishRecording(stoppedAt, durationMs);
    return this.stopPromise;
  }

  clearResult(): void {
    if (this.preparing || this.starting || this.state === 'recording' || this.state === 'stopping') throw new Error('Stop recording before clearing its files.');
    this.revokeResult();
    if (this.state === 'complete') this.state = 'ready';
    this.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.state === 'recording' || this.state === 'stopping') await this.stop().catch(() => undefined);
    this.releaseSources();
    this.localMedia?.dispose(); this.localMedia = undefined;
    for (const key of [...this.layerInputs.keys()]) this.removeLayerSource(key);
    this.sceneBackgroundLoad++; this.sceneBackground?.close(); this.sceneBackground = undefined; this.compositor.clear();
    this.revokeResult();
    this.listeners.clear();
  }

  private async finishRecording(stoppedAt: number, durationMs: number): Promise<RecordingResult> {
    try {
      for (const orientation of ORIENTATIONS) {
        const recorder = this.paths[orientation]?.recorder;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      }
      await this.waitForRecordersStopped(15000);
      await Promise.all(Object.values(this.writes));
      const interruption = this.writeError ?? this.recordingError;
      const files = await this.store!.finalize(!interruption);
      if (!files.landscape.size || !files.portrait.size) throw interruption ?? new Error('The browser did not produce data for both outputs.');
      const extension = this.metrics.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      const makeFile = (orientation: Orientation) => ({
        orientation, blob: files[orientation], url: URL.createObjectURL(files[orientation]),
        fileName: `grava-${orientation}-${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}.${extension}`,
        mimeType: this.metrics.mimeType, size: files[orientation].size, durationMs,
      });
      this.result = { id: this.store!.id, landscape: makeFile('landscape'), portrait: makeFile('portrait'), startedAt: this.startedAt, stoppedAt, warnings: [] };
      if (this.metrics.warning) this.result.warnings.push(this.metrics.warning);
      if (interruption) this.result.warnings.push(readableError(interruption));
      this.state = interruption ? 'error' : 'complete';
      this.error = interruption ? readableError(interruption) : undefined;
      this.emit();
      return this.result;
    } catch (error) {
      await this.store?.abort().catch(() => undefined);
      this.state = 'error';
      this.error = readableError(this.writeError ?? this.recordingError ?? error);
      this.emit();
      throw new Error(this.error, { cause: error });
    } finally {
      this.releaseOutputTracks();
      // Keep recording dimensions until the encoders and their writes have
      // finished; only then resume the bounded live preview.
      if (!this.disposed) this.render(performance.now(), true);
    }
  }

  private queueChunk(orientation: Orientation, data: Blob): void {
    this.pendingBytes += data.size;
    this.metrics.pendingWrites++;
    this.metrics.chunks[orientation]++;
    this.writes[orientation] = this.writes[orientation].then(async () => {
      if (this.writeError) return;
      await this.store!.write(orientation, data);
      this.metrics.bytes[orientation] += data.size;
    }).catch(error => {
      this.writeError ??= error;
      this.failDuringRecording(error);
    }).finally(() => {
      this.pendingBytes -= data.size;
      this.metrics.pendingWrites--;
      this.emit();
    });
    if (this.pendingBytes > MAX_PENDING_BYTES) this.failDuringRecording(new Error('Storage could not keep up. Both outputs stopped to limit memory use.'));
  }

  private failDuringRecording(error: unknown): void {
    this.recordingError ??= error;
    this.error = readableError(error);
    this.metrics.warning = this.error;
    this.emit();
    if (this.state === 'recording') void this.stop().catch(() => undefined);
  }

  private async prepareCountdownAudio(config: StudioConfig): Promise<void> {
    if (config.microphone === false) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(config.microphoneDeviceId ? { deviceId: { exact: config.microphoneDeviceId } } : {}) } });
    this.assertSessionOpen(stream);
    this.capturedStreams.push(stream); this.microphoneStream = stream; this.connectAudio(stream, this.microphoneGain!);
    for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (this.state === 'recording') this.failDuringRecording(new Error('O microfone foi desconectado. As duas gravações foram interrompidas.')); });
  }

  private async prepareDevices(config: StudioConfig, mix: AudioNode): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Capture requires desktop Chrome/Edge over HTTPS or localhost.');
    const [captureWidth, captureHeight] = recordingDimensions(config.resolution).landscape;
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: config.fps }, ...(config.cameraDeviceId ? { deviceId: { exact: config.cameraDeviceId } } : {}) },
      audio: config.microphone === false ? false : {
        echoCancellation: true, noiseSuppression: true, autoGainControl: false,
        ...(config.microphoneDeviceId ? { deviceId: { exact: config.microphoneDeviceId } } : {}),
      },
    });
    this.assertSessionOpen(cameraStream);
    this.capturedStreams.push(cameraStream);
    this.microphoneStream = cameraStream;
    this.camera = await this.videoFor(cameraStream);
    this.connectAudio(cameraStream, this.microphoneGain!);
    if (config.source === 'screen') {
      const display = this.capturedStreams.find(stream => stream !== cameraStream)!;
      this.connectAudio(display, mix);
    } else this.source = this.camera;
    for (const stream of this.capturedStreams) {
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        const source = track.kind === 'audio' ? 'An audio input' : 'A video source';
        if (this.isCapturedTrackActive(stream, track)) {
          if (this.state === 'recording') this.failDuringRecording(new Error(`${source} ended. Both outputs were stopped.`));
          else if (this.state === 'ready' || this.state === 'complete') { this.error = `${source} ended. Prepare capture again.`; this.state = 'error'; }
        }
        this.updateSourceStatus(); this.emit();
      });
      for (const track of stream.getAudioTracks()) {
        const warning = 'An audio input is temporarily muted by the device or browser. Check your microphone and screen audio.';
        track.addEventListener('mute', () => {
          if (this.state === 'recording') { this.metrics.warning = warning; this.emit(); }
        });
        track.addEventListener('unmute', () => {
          if (this.metrics.warning === warning) { this.metrics.warning = undefined; this.emit(); }
        });
      }
    }
  }

  private connectAudio(stream: MediaStream, mix: AudioNode): void {
    if (!stream.getAudioTracks().length) return;
    const source = this.audioContext!.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    if (mix === this.microphoneGain && this.rawMicrophoneAnalyser) { source.connect(this.rawMicrophoneAnalyser); this.microphoneInput = source; }
    else source.connect(mix);
    this.audioNodes.push(source);
  }

  private async videoFor(stream: MediaStream, ownedGlobal = true): Promise<HTMLVideoElement> {
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    if (ownedGlobal) this.videos.push(video);
    await video.play();
    if (!video.videoWidth) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The video source did not respond.')), 10000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    return video;
  }

  private assertSessionOpen(stream?: MediaStream): void {
    if (!this.disposed) return;
    stream?.getTracks().forEach(track => track.stop());
    throw new Error('O estúdio foi fechado.');
  }

  private prepareTestSource(mix: AudioNode): void {
    const screen = document.createElement('canvas');
    screen.width = 1280; screen.height = 720;
    const camera = document.createElement('canvas');
    camera.width = 640; camera.height = 480;
    this.source = screen;
    this.camera = camera;
    const screenContext = screen.getContext('2d', { alpha: false, willReadFrequently: true });
    const cameraContext = camera.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!screenContext || !cameraContext) throw new Error('Test source canvases could not be created.');
    this.testContexts = { screen: screenContext, camera: cameraContext };
    const oscillator = this.audioContext!.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 440;
    const volume = this.audioContext!.createGain();
    volume.gain.value = 0.08;
    oscillator.connect(volume);
    volume.connect(this.rawMicrophoneAnalyser ?? this.microphoneGain ?? mix);
    oscillator.start();
    this.oscillator = oscillator;
    this.audioNodes.push(oscillator, volume);
  }

  private applyMicrophoneGain(): void {
    if (!this.microphoneGain) return;
    const enabled = !this.controls.microphoneMuted && this.config?.microphone !== false;
    const value = enabled ? this.engine.audioGainDb?.(this.controls.microphoneGainDb) ?? Math.pow(10, this.controls.microphoneGainDb / 20) : 0;
    // This gain affects only microphone audio. Shared system audio keeps its
    // own route into the OBS compressor and both independent recording paths.
    this.microphoneGain.gain.setValueAtTime(value, this.audioContext!.currentTime);
  }

  private updateAudioLevel(): void {
    const read = (analyser: AnalyserNode | undefined, samples: Float32Array<ArrayBuffer> | undefined) => {
      if (!analyser || !samples) return { level: 0, db: -100 };
      analyser.getFloatTimeDomainData(samples); let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const level = Math.sqrt(energy / samples.length);
      return { level: Math.min(1, level), db: Math.max(-100, 20 * Math.log10(Math.max(level, .00001))) };
    };
    const raw = read(this.rawMicrophoneAnalyser, this.rawMicrophoneSamples);
    this.metrics.rawMicLevel = raw.level; this.metrics.rawMicLevelDb = raw.db;
    const post = this.controls.microphoneMuted || this.config?.microphone === false ? { level: 0, db: -100 } : read(this.microphoneAnalyser, this.microphoneSamples);
    this.metrics.audioLevel = post.level; this.metrics.audioLevelDb = post.db;
  }

  private updateSourceStatus(): void {
    const camera = this.inputStatus(this.camera, this.controls.sourceVisibility.camera, this.camera instanceof HTMLCanvasElement ? 'Generated camera' : undefined);
    const screen = this.inputStatus(this.config?.source !== 'camera' ? this.source : undefined, this.controls.sourceVisibility.screen, this.config?.source === 'media' ? this.localMedia?.name ?? 'Mídia local' : this.source instanceof HTMLCanvasElement ? 'Generated screen' : undefined);
    this.metrics.sources = { camera, screen };
    const layerSources: NonNullable<StudioMetrics['layerSources']> = {};
    for (const [id, entry] of this.layerInputs) {
      const value = this.getSourceStatus(id);
      if (value) layerSources[id] = { ...value, kind: entry.kind === 'camera' ? 'camera' : 'screen' };
    }
    for (const [id, kind] of [[this.cameraSourceId, 'camera'], [this.screenSourceId, 'screen']] as const) {
      if (!id || layerSources[id]) continue;
      const value = this.getSourceStatus(id);
      if (value) layerSources[id] = { ...value, kind };
    }
    for (const layer of this.sceneAppearance.layers) {
      if (layer.kind !== 'camera' && layer.kind !== 'screen') continue;
      const key = layer.sourceId ?? layer.id, source = this.getSourceStatus(key);
      const value = source
        ? { ...source, visible: layer.visible, kind: layer.kind }
        : layer.sourceId || layer.assetId
          ? { available: false, live: false, enabled: false, visible: layer.visible, kind: layer.kind }
          : { ...this.metrics.sources[layer.kind], visible: layer.visible, kind: layer.kind };
      layerSources[layer.id] = value;
      if (layer.sourceId) layerSources[key] = source ? { ...source, kind: layer.kind } : value;
    }
    // Legacy callers inspect one status per kind. Report the active bound input
    // rather than an unrelated global camera or previously selected display.
    for (const kind of ['camera', 'screen'] as const) {
      const layer = this.sceneAppearance.layers.find(layer => layer.kind === kind && layer.visible);
      if (layer && (layer.sourceId || layer.assetId)) this.metrics.sources[kind] = { ...layerSources[layer.id] };
    }
    this.metrics.layerSources = layerSources;
    const microphone = this.microphoneStream?.getAudioTracks()[0];
    const settings = microphone?.getSettings();
    const generated = !!this.oscillator && this.config?.microphone !== false;
    this.metrics.microphone = {
      available: !!microphone || generated,
      live: generated || microphone?.readyState === 'live',
      enabled: generated || !!microphone?.enabled,
      muted: this.controls.microphoneMuted || this.config?.microphone === false || !!microphone && (!microphone.enabled || microphone.muted),
      settings, deviceId: settings?.deviceId,
      label: microphone?.label ?? (generated ? 'Generated 440 Hz tone' : undefined),
    };
  }

  private startRendering(): void {
    const frame = (time: number) => {
      this.render(time);
      this.animationFrame = requestAnimationFrame(frame);
    };
    this.animationFrame = requestAnimationFrame(frame);
    // Background tabs may suppress rAF. This is a best effort watchdog, not a
    // promise that browsers can sustain the requested frame rate when hidden.
    this.renderTimer = setInterval(() => this.render(performance.now()), 1000 / this.config!.fps);
    this.metricTimer = setInterval(() => {
      const now = performance.now();
      const wasHidden = this.metrics.hidden;
      this.metrics.hidden = document.hidden;
      this.updateSourceStatus();
      this.updateAudioLevel();
      if (this.state === 'recording') {
        this.metrics.elapsedMs = now - this.startedPerformance;
        // Meter updates stay responsive, while FPS uses a full second of
        // frames so individual timer/rAF phases do not create false warnings.
        if (wasHidden && !document.hidden) {
          this.lastMetricTime = now;
          this.metricFrameBaseline = this.metrics.frames.landscape;
          this.lowFpsWindows = 0;
        }
        const interval = now - this.lastMetricTime;
        if (document.hidden) {
          this.lowFpsWindows = 0;
          if (!this.metrics.warning || this.metrics.warning === LOW_FPS_WARNING || this.metrics.warning === BACKGROUND_WARNING) this.metrics.warning = BACKGROUND_WARNING;
        } else if (this.metrics.warning === BACKGROUND_WARNING) this.metrics.warning = undefined;
        if (interval >= 1000) {
          this.metrics.measuredFps = (this.metrics.frames.landscape - this.metricFrameBaseline) * 1000 / interval;
          this.lastMetricTime = now;
          this.metricFrameBaseline = this.metrics.frames.landscape;
          if (!document.hidden && this.metrics.measuredFps < this.config!.fps * 0.7) {
            this.lowFpsWindows++;
            if (this.lowFpsWindows >= 3 && (!this.metrics.warning || this.metrics.warning === LOW_FPS_WARNING)) this.metrics.warning = LOW_FPS_WARNING;
          } else {
            this.lowFpsWindows = 0;
            if (this.metrics.warning === LOW_FPS_WARNING) this.metrics.warning = undefined;
          }
        }
      }
      this.emit();
    }, 100);
  }

  private recordingOutputActive(): boolean {
    return this.starting || this.state === 'recording' || this.state === 'stopping' || !!this.paths.landscape || !!this.paths.portrait || this.outputStreams.length > 0;
  }

  private syncOutputSize(screen: SceneVisualSource | undefined, layerSources: Record<string, SceneVisualSource>): void {
    if (!this.config || !this.canvases) return;
    const liveScreen = this.sceneAppearance.layers.some(layer => {
      if (layer.kind !== 'screen' || !layer.visible) return false;
      const source = layerSources[layer.sourceId ?? layer.id] ?? layerSources[layer.id] ?? (!layer.sourceId && !layer.assetId ? screen : undefined);
      const element = source?.element;
      return element instanceof HTMLVideoElement && element.srcObject instanceof MediaStream && element.srcObject.getVideoTracks().some(track => track.readyState === 'live');
    });
    this.liveScreenPreview = liveScreen && !this.recordingOutputActive();
    const selected = recordingDimensions(this.config.resolution);
    const dimensions = this.liveScreenPreview && selected.landscape[0] > 1280 ? recordingDimensions('720') : selected;
    for (const orientation of ORIENTATIONS) {
      const canvas = this.canvases[orientation], [width, height] = dimensions[orientation];
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
  }

  private render(now: number, force = false): void {
    if (!this.contexts || !this.canvases || !this.config) return;
    const fps = this.liveScreenPreview && !this.recordingOutputActive() ? Math.min(30, this.config.fps) : this.config.fps;
    const frameDuration = 1000 / fps;
    if (!force && now + 1 < this.nextDrawAt) return;
    this.nextDrawAt = force || now - this.nextDrawAt > frameDuration ? now + frameDuration : this.nextDrawAt + frameDuration;
    this.lastDraw = now;
    if (this.config.source === 'test' && this.testContexts) this.drawTestSources((now - this.renderStart) / 1000);
    const camera = this.visual(this.camera), screen = this.config.source !== 'camera' ? this.visual(this.source) : undefined;
    const layout = this.config.layout ?? 'camera';
    const layerSources = this.layerVisuals();
    this.syncOutputSize(screen, layerSources);
    const frameId = ++this.renderFrameId;
    try {
      for (const orientation of ORIENTATIONS) {
        const canvas = this.canvases[orientation];
        this.compositor.render(this.contexts[orientation], canvas.width, canvas.height, {
          layout, appearance: this.sceneAppearance, zoom: this.controls.cameraZoom, orientation,
          remainingSeconds: this.getCountdownStatus(now).remainingSeconds, camera, screen, layerSources, frameId,
          background: this.sceneAppearance.backgroundAssetId === this.sceneBackgroundAssetId ? this.sceneBackground : undefined,
          engine: this.engine,
        });
        if (this.state === 'recording') this.metrics.frames[orientation]++;
      }
    } catch (error) {
      if (this.state === 'recording') this.failDuringRecording(error);
      else { this.error = readableError(error); this.state = 'error'; this.emit(); }
    }
  }

  private drawTestSources(seconds: number): void {
    const context = this.testContexts!.screen;
    context.fillStyle = '#12203e'; context.fillRect(0, 0, 1280, 720);
    for (let x = 0; x < 1280; x += 80) { context.fillStyle = x % 160 ? '#152b50' : '#18335d'; context.fillRect(x, 0, 40, 720); }
    context.fillStyle = '#48dfb5'; context.fillRect((seconds * 170) % 1400 - 120, 280, 120, 200);
    context.fillStyle = '#f6f8ff'; context.font = 'bold 58px sans-serif'; context.fillText('SCREEN TEST', 72, 124);
    context.font = '40px monospace'; context.fillText(`${seconds.toFixed(2)} s`, 76, 200);
    context.font = '24px sans-serif'; context.fillText('Moving picture + 440 Hz tone • generated locally', 72, 650);
    const portrait = this.testContexts!.camera;
    portrait.fillStyle = '#702d64'; portrait.fillRect(0, 0, 640, 480);
    portrait.fillStyle = '#f59a70'; portrait.beginPath(); portrait.arc(320 + Math.sin(seconds) * 90, 200, 95, 0, Math.PI * 2); portrait.fill();
    portrait.fillStyle = '#ffddb9'; portrait.beginPath(); portrait.arc(292 + Math.sin(seconds) * 90, 180, 10, 0, Math.PI * 2); portrait.arc(347 + Math.sin(seconds) * 90, 180, 10, 0, Math.PI * 2); portrait.fill();
    portrait.fillStyle = '#f8e7f4'; portrait.font = 'bold 38px sans-serif'; portrait.textAlign = 'center'; portrait.fillText('CAMERA TEST', 320, 382);
    portrait.font = '26px monospace'; portrait.fillText(`${seconds.toFixed(2)} s`, 320, 430);
  }

  private videoBitrate(): number {
    const base = this.config!.resolution === '4k' ? 32_000_000 : this.config!.resolution === '1080' ? 10_000_000 : this.config!.resolution === '720' ? 5_000_000 : 1_400_000;
    return base * (this.config!.fps === 60 ? 1.5 : 1);
  }

  private releaseOutputTracks(): void {
    for (const path of Object.values(this.paths)) {
      if (!path) continue;
      path.recorder.ondataavailable = null;
      path.recorder.onstart = null;
      path.recorder.onerror = null;
      path.recorder.onstop = null;
    }
    for (const stream of this.outputStreams) stream.getTracks().forEach(track => track.stop());
    this.outputStreams = [];
    this.paths = {};
  }

  private assertCaptureLive(): void {
    if (this.capturedStreams.some(stream => stream.getTracks().some(track => track.readyState !== 'live' && this.isCapturedTrackActive(stream, track)))) throw new Error('A capture input ended. Prepare capture again.');
    for (const [key, entry] of this.layerInputs) if (this.isLayerActive(key) && entry.stream?.getVideoTracks().some(track => track.readyState !== 'live')) throw new Error(entry.kind === 'camera' ? 'Uma câmera desta cena foi desconectada. Conecte-a novamente.' : 'Uma tela desta cena foi encerrada. Compartilhe-a novamente.');
  }

  private async waitForRecordersStopped(timeoutMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(Object.values(this.paths).map(path => path!.stopped)),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The encoder timed out while finalizing the files.')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timeout); }
  }

  private releaseSources(): void {
    cancelAnimationFrame(this.animationFrame ?? 0);
    clearInterval(this.renderTimer);
    clearInterval(this.metricTimer);
    this.animationFrame = undefined;
    this.renderTimer = undefined;
    this.metricTimer = undefined;
    this.releaseOutputTracks();
    this.capturedStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    this.capturedStreams = [];
    this.videos.forEach(video => { video.pause(); video.srcObject = null; });
    this.videos = [];
    try { this.oscillator?.stop(); } catch { /* Already stopped. */ }
    this.oscillator = undefined;
    this.audioNodes.forEach(node => node.disconnect());
    this.audioNodes = [];
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;
    this.audioDestination = undefined;
    this.audioMix = undefined;
    this.microphoneInput = undefined;
    this.rawMicrophoneAnalyser = undefined; this.rawMicrophoneSamples = undefined;
    for (const entry of this.layerInputs.values()) { entry.audioSource?.disconnect(); entry.audioGain?.disconnect(); entry.audioSource = undefined; entry.audioGain = undefined; }
    this.microphoneStream = undefined;
    this.microphoneGain = undefined;
    this.microphoneAnalyser = undefined;
    this.microphoneSamples = undefined;
    this.localMedia?.pause();
    this.source = undefined;
    this.camera = undefined;
    this.cameraSourceId = undefined;
    this.screenSourceId = undefined;
    this.testContexts = undefined;
    this.liveScreenPreview = false;
    this.metrics.audioLevel = 0;
    this.metrics.audioLevelDb = -100; this.metrics.rawMicLevel = 0; this.metrics.rawMicLevelDb = -100;
    this.updateSourceStatus();
  }

  private revokeResult(): void {
    if (this.result) ORIENTATIONS.forEach(orientation => URL.revokeObjectURL(this.result![orientation].url));
    this.result = undefined;
  }

  private emit(): void {
    const event = this.getSnapshot();
    for (const listener of this.listeners) { try { listener(event); } catch (error) { console.error('Studio event listener failed', error); } }
  }
}

export default StudioSession;
