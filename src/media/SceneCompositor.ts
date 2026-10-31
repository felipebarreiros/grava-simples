import { CountdownPainter } from './CountdownPainter';
import type { LayerFrame, DrawRect, LayoutEngine, Orientation, SceneAppearance, SceneLayer, SceneLayerKind, StudioLayout } from './types';

const layerNames: Record<SceneLayerKind, string> = { background: 'Fundo', camera: 'Câmera', screen: 'Tela ou mídia', title: 'Título', timer: 'Contagem regressiva' };
const kinds = new Set<SceneLayerKind>(['background', 'camera', 'screen', 'title', 'timer']);
const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : fallback;
const finite = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function defaultSceneAppearance(layout: StudioLayout): SceneAppearance {
  const ordered: SceneLayerKind[] = layout === 'countdown' ? ['background', 'title', 'timer'] : layout === 'screen' ? ['background', 'screen', 'camera'] : layout === 'screen-3d' ? ['background', 'camera', 'screen'] : ['background', 'camera'];
  return { layers: ordered.map(kind => ({ id: kind, kind, name: layerNames[kind], visible: true })), cameraShape: 'rectangle', cameraBorderColor: '#ffffff', cameraBorderWidth: 0, cameraShadow: false, backgroundColor: '#080b11', productTitle: 'Algo incrível está chegando', countdownSeconds: 300, microphoneMuted: layout === 'countdown', microphoneGainDb: 0 };
}
export function normalizeSceneAppearance(layout: StudioLayout, input?: Partial<SceneAppearance>): SceneAppearance {
  const defaults = defaultSceneAppearance(layout);
  const seen = new Set<string>();
  const layers: SceneLayer[] = [];
  if (Array.isArray(input?.layers)) for (const entry of input.layers) {
    if (!entry || typeof entry !== 'object' || !kinds.has(entry.kind)) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 120) : entry.kind;
    if (seen.has(id)) continue;
    seen.add(id);
    const frames: SceneLayer['frames'] = {};
    for (const orientation of ['landscape', 'portrait'] as const) {
      const frame = entry.frames?.[orientation];
      if (frame && [frame.x, frame.y, frame.width, frame.height].every(value => typeof value === 'number' && Number.isFinite(value))) frames[orientation] = { x: finite(frame.x, 0, -1, 1), y: finite(frame.y, 0, -1, 1), width: finite(frame.width, 1, .02, 2), height: finite(frame.height, 1, .02, 2) };
    }
    layers.push({
      id, kind: entry.kind, name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : layerNames[entry.kind], visible: entry.visible !== false,
      ...(typeof entry.text === 'string' ? { text: entry.text.slice(0, 500) } : {}),
      ...(typeof entry.fontSize === 'number' && Number.isFinite(entry.fontSize) ? { fontSize: finite(entry.fontSize, 76, 8, 512) } : {}),
      ...(typeof entry.color === 'string' ? { color: color(entry.color, '#ffffff') } : {}),
      ...(entry.align === 'left' || entry.align === 'center' || entry.align === 'right' ? { align: entry.align } : {}),
      ...(Object.keys(frames).length ? { frames } : {}),
      ...(typeof entry.sourceId === 'string' && entry.sourceId ? { sourceId: entry.sourceId.slice(0, 160) } : {}),
      ...(typeof entry.assetId === 'string' && entry.assetId ? { assetId: entry.assetId.slice(0, 160) } : {}),
      ...(entry.fit === 'contain' || entry.fit === 'cover' ? { fit: entry.fit } : {}),
      ...(entry.cameraShape === 'rectangle' || entry.cameraShape === 'rounded' || entry.cameraShape === 'circle' ? { cameraShape: entry.cameraShape } : {}),
      ...(typeof entry.cameraBorderColor === 'string' ? { cameraBorderColor: color(entry.cameraBorderColor, '#ffffff') } : {}),
      ...(typeof entry.cameraBorderWidth === 'number' ? { cameraBorderWidth: finite(entry.cameraBorderWidth, 0, 0, 16) } : {}),
      ...(typeof entry.cameraShadow === 'boolean' ? { cameraShadow: entry.cameraShadow } : {}),
    });
  }
  return {
    ...defaults, layers: Array.isArray(input?.layers) ? layers : defaults.layers,
    cameraShape: input?.cameraShape === 'circle' || input?.cameraShape === 'rounded' ? input.cameraShape : 'rectangle',
    cameraBorderColor: color(input?.cameraBorderColor, defaults.cameraBorderColor),
    cameraBorderWidth: finite(input?.cameraBorderWidth, 0, 0, 16), cameraShadow: input?.cameraShadow === true,
    backgroundColor: color(input?.backgroundColor, defaults.backgroundColor),
    backgroundAssetId: typeof input?.backgroundAssetId === 'string' && input.backgroundAssetId ? input.backgroundAssetId.slice(0, 160) : undefined,
    productTitle: typeof input?.productTitle === 'string' ? input.productTitle.slice(0, 160) : defaults.productTitle,
    countdownSeconds: finite(input?.countdownSeconds, defaults.countdownSeconds, 0, 86_400),
    microphoneMuted: typeof input?.microphoneMuted === 'boolean' ? input.microphoneMuted : defaults.microphoneMuted,
    microphoneGainDb: finite(input?.microphoneGainDb, 0, -60, 12),
    cameraDeviceId: typeof input?.cameraDeviceId === 'string' && input.cameraDeviceId ? input.cameraDeviceId : undefined,
    microphoneDeviceId: typeof input?.microphoneDeviceId === 'string' && input.microphoneDeviceId ? input.microphoneDeviceId : undefined,
  };
}
export interface SceneVisualSource { element: CanvasImageSource; width: number; height: number }
export interface SceneRenderInput {
  /** Both output orientations share a single capture snapshot for this frame. */
  frameId?: number;
  layout: StudioLayout;
  appearance: SceneAppearance;
  zoom: number;
  orientation: Orientation;
  remainingSeconds: number;
  camera?: SceneVisualSource;
  screen?: SceneVisualSource;
  background?: CanvasImageSource | null;
  engine: LayoutEngine;
  layerSources?: Record<string, SceneVisualSource>;
}
export function getLayerFontSize(layer: SceneLayer, layout: StudioLayout): number {
  return layer.fontSize ?? (layer.kind === 'timer' ? layout === 'countdown' ? 208 : 84 : layout === 'countdown' ? 76 : 48);
}
export function getLayerTextAlign(layer: SceneLayer, layout: StudioLayout): 'left' | 'center' | 'right' {
  return layer.align ?? (layout === 'countdown' ? 'center' : layer.kind === 'timer' ? 'right' : 'left');
}
export interface LayerFrameOptions {
  layout: StudioLayout; appearance: SceneAppearance; orientation: Orientation;
  width?: number; height?: number; cameraWidth?: number; cameraHeight?: number; screenWidth?: number; screenHeight?: number;
}
function presentationSplit(options: LayerFrameOptions, width: number, height: number): number {
  return Math.min(.48, width / height * (options.screenHeight || 1080) / (options.screenWidth || 1440));
}
/** Canvas editor boxes and rendered layer positions share this normalized geometry. */
export function getLayerFrame(layer: SceneLayer, options: LayerFrameOptions): LayerFrame {
  const { layout, appearance, orientation } = options;
  const width = options.width ?? (orientation === 'landscape' ? 1920 : 1080), height = options.height ?? (orientation === 'landscape' ? 1080 : 1920);
  const custom = layer.frames?.[orientation];
  let frame: LayerFrame;
  const occurrence = Math.max(0, appearance.layers.filter(item => item.kind === layer.kind).findIndex(item => item.id === layer.id));
  if (custom) frame = { ...custom };
  else if (layer.kind === 'background') frame = { x: 0, y: 0, width: 1, height: 1 };
  else if (layer.kind === 'title') frame = layout === 'countdown' ? { x: .1, y: .2 + occurrence * .12, width: .8, height: .18 } : { x: .06, y: .82 - occurrence * .12, width: .82, height: .14 };
  else if (layer.kind === 'timer') frame = layout === 'countdown' ? { x: .09, y: .43 + occurrence * .2, width: .82, height: .27 } : { x: .72, y: .04 + occurrence * .15, width: .22, height: .13 };
  else if (layer.kind === 'camera') {
    if (!occurrence && layout === 'screen-3d') {
      const split = presentationSplit(options, width, height);
      frame = orientation === 'landscape' ? { x: .48, y: 0, width: .52, height: 1 } : { x: 0, y: split, width: 1, height: 1 - split };
    }
    else if (!occurrence && (layout === 'camera' || layout === 'camera-zoom')) frame = { x: 0, y: 0, width: 1, height: 1 };
    else if (!occurrence && layout === 'screen' && orientation === 'portrait') frame = { x: 0, y: .46, width: 1, height: .54 };
    else if (!occurrence && layout === 'screen') frame = { x: .728, y: .711, width: .25, height: .25 };
    else frame = { x: .05 + (occurrence % 3) * .06, y: .66 - (occurrence % 3) * .05, width: .28, height: Math.min(.28 * width / height * 9 / 16, .3) };
  } else if (layout === 'screen-3d' && !occurrence) {
    if (orientation === 'portrait') frame = { x: 0, y: 0, width: 1, height: presentationSplit(options, width, height) };
    else {
      const rect = containedRect(options.screenWidth || 1440, options.screenHeight || 1080, width * .03, height * .08, width * .58, height * .84);
      frame = { x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height };
    }
  } else if (layout === 'screen' && !occurrence) frame = orientation === 'landscape' ? { x: 0, y: 0, width: 1, height: 1 } : { x: 0, y: .0618, width: 1, height: .3164 };
  else frame = { x: .05 + occurrence * .04, y: .06 + occurrence * .06, width: .62, height: .36 };
  if (layer.kind === 'camera' && (layer.cameraShape ?? appearance.cameraShape) === 'circle') {
    const diameter = Math.min(frame.width * width, frame.height * height);
    frame = { x: frame.x + (frame.width - diameter / width) / 2, y: frame.y + (frame.height - diameter / height) / 2, width: diameter / width, height: diameter / height };
  }
  return frame;
}
export function layerSource(layer: SceneLayer, input: SceneRenderInput): SceneVisualSource | undefined {
  const local = input.layerSources?.[layer.sourceId ?? layer.id] ?? input.layerSources?.[layer.id];
  if (local) return local;
  if (layer.sourceId || layer.assetId) return undefined;
  return layer.kind === 'camera' ? input.camera : layer.kind === 'screen' ? input.screen : undefined;
}
export function resolveLayerBounds(layer: SceneLayer, input: SceneRenderInput, width: number, height: number): DrawRect {
  const source = layerSource(layer, input);
  const screenLayer = input.appearance.layers.find(item => item.kind === 'screen');
  const screen = layer.kind === 'screen' ? source : screenLayer ? layerSource(screenLayer, input) : input.screen;
  const frame = getLayerFrame(layer, { layout: input.layout, appearance: input.appearance, orientation: input.orientation, width, height, cameraWidth: input.camera?.width, cameraHeight: input.camera?.height, screenWidth: screen?.width, screenHeight: screen?.height });
  const x = frame.x * width, y = frame.y * height, boxWidth = frame.width * width, boxHeight = frame.height * height;
  if (!source) return { x, y, width: boxWidth, height: boxHeight, cropX: 0, cropY: 0, cropWidth: boxWidth, cropHeight: boxHeight };
  const fit = layer.kind === 'camera' && (layer.cameraShape ?? input.appearance.cameraShape) === 'circle' ? 'cover' : layer.fit ?? (layer.kind === 'camera' || layer.kind === 'background' ? 'cover' : 'contain');
  let rect: DrawRect;
  if (fit === 'contain') rect = containedRect(source.width, source.height, x, y, boxWidth, boxHeight);
  else {
    const cropped = input.engine.layout({ outputWidth: boxWidth, outputHeight: boxHeight, sourceWidth: source.width, sourceHeight: source.height, cameraWidth: source.width, cameraHeight: source.height, mode: 'camera', orientation: input.orientation }).source;
    rect = { ...cropped, x: x + cropped.x, y: y + cropped.y };
  }
  if (layer.kind === 'camera' && input.layout === 'camera-zoom') {
    const zoom = finite(input.zoom, 1.4, 1, 2.5), cropWidth = rect.cropWidth / zoom, cropHeight = rect.cropHeight / zoom;
    rect = { ...rect, cropWidth, cropHeight, cropX: rect.cropX + (rect.cropWidth - cropWidth) / 2, cropY: rect.cropY + (rect.cropHeight - cropHeight) / 2 };
  }
  return rect;
}

export function containedRect(sourceWidth: number, sourceHeight: number, x: number, y: number, width: number, height: number): DrawRect {
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const fittedWidth = sourceWidth * scale, fittedHeight = sourceHeight * scale;
  return { x: x + (width - fittedWidth) / 2, y: y + (height - fittedHeight) / 2, width: fittedWidth, height: fittedHeight, cropX: 0, cropY: 0, cropWidth: sourceWidth, cropHeight: sourceHeight };
}
type PresentationRect = Pick<DrawRect, 'x' | 'y' | 'width' | 'height'>;
const PRESENTATION_TAPER = .09;
const PRESENTATION_MAX_EDGE_STEP = .6;
/** A slide turns toward the presenter: its far edge is shorter, without roll. */
export function getPresentationQuad({ x, y, width, height }: PresentationRect): [number, number][] {
  return [[x, y], [x + width, y + height * PRESENTATION_TAPER], [x + width, y + height * (1 - PRESENTATION_TAPER)], [x, y + height]];
}
/** Projective source coordinates shared by captured slides and static scene cards. */
export function getPresentationSlices(rect: PresentationRect, overlap = .3) {
  // Keep changes in projected height below a pixel at the actual output size.
  // A fixed strip count creates visible steps in text and rules at 1080p/4K.
  const count = Math.max(32, Math.ceil(rect.height * PRESENTATION_TAPER / PRESENTATION_MAX_EDGE_STEP));
  const farScale = 1 - 2 * PRESENTATION_TAPER;
  const sourceAt = (position: number) => farScale * position / (1 - (1 - farScale) * position);
  return Array.from({ length: count }, (_, index) => {
    const start = index / count, end = Math.min(1, (index + 1) / count + overlap / rect.width);
    const center = (start + end) / 2, inset = rect.height * PRESENTATION_TAPER * center;
    const sourceX = sourceAt(start);
    return { x: rect.x + rect.width * start, y: rect.y + inset, width: rect.width * (end - start), height: rect.height - inset * 2, sourceX, sourceWidth: sourceAt(end) - sourceX };
  });
}
function draw(context: CanvasRenderingContext2D, source: SceneVisualSource, rect: DrawRect) {
  if (![rect.x, rect.y, rect.width, rect.height, rect.cropX, rect.cropY, rect.cropWidth, rect.cropHeight].every(Number.isFinite)) throw new Error('A composição retornou uma posição inválida.');
  if (rect.width > 0 && rect.height > 0 && rect.cropWidth > 0 && rect.cropHeight > 0) context.drawImage(source.element, rect.cropX, rect.cropY, rect.cropWidth, rect.cropHeight, rect.x, rect.y, rect.width, rect.height);
}
function imageSize(image: CanvasImageSource): [number, number] {
  if (image instanceof HTMLVideoElement) return [image.videoWidth, image.videoHeight];
  if (image instanceof HTMLImageElement) return [image.naturalWidth, image.naturalHeight];
  if (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame) return [image.displayWidth, image.displayHeight];
  return [(image as HTMLCanvasElement).width, (image as HTMLCanvasElement).height];
}
function roundedPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, shape: SceneAppearance['cameraShape']) {
  context.beginPath();
  if (shape === 'circle') context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else context.roundRect(x, y, width, height, shape === 'rounded' ? Math.min(width, height) * 0.12 : 0);
}

/** Shared compositor for both encoder canvases and tiny live scene thumbnails. */
export class SceneCompositor {
  private generated = new Map<string, HTMLCanvasElement>();
  private decorations = new Map<string, HTMLCanvasElement>();
  private presentationSlices = new Map<string, ReturnType<typeof getPresentationSlices>>();
  private screenFrames = new WeakMap<HTMLVideoElement, Map<string, { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; frameId?: number }>>();
  private newCanvas(width: number, height: number) { const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(width)); canvas.height = Math.max(1, Math.ceil(height)); return canvas; }
  private cache<T>(map: Map<string, T>, key: string, value: T): T { if (map.size >= 24) map.delete(map.keys().next().value!); map.set(key, value); return value; }
  private countdownPainter = new CountdownPainter();
  render(context: CanvasRenderingContext2D, width: number, height: number, input: SceneRenderInput): void {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    const fullCameraIndex = input.appearance.layers.findIndex(layer => {
      if (!layer.visible || layer.kind !== 'camera' || layer.sourceId || layer.assetId || !layerSource(layer, input) || (layer.cameraShape ?? input.appearance.cameraShape) !== 'rectangle') return false;
      const frame = getLayerFrame(layer, { layout: input.layout, appearance: input.appearance, orientation: input.orientation, width, height });
      return frame.x === 0 && frame.y === 0 && frame.width === 1 && frame.height === 1 && (layer.fit ?? 'cover') === 'cover';
    });
    const first = input.appearance.layers.find(layer => layer.visible);
    const firstFrame = first ? getLayerFrame(first, { layout: input.layout, appearance: input.appearance, orientation: input.orientation, width, height }) : undefined;
    const fullBackground = first?.kind === 'background' && firstFrame?.x === 0 && firstFrame.y === 0 && firstFrame.width === 1 && firstFrame.height === 1;
    if (fullCameraIndex < 0 && !fullBackground) { context.fillStyle = '#080b11'; context.fillRect(0, 0, width, height); }
    try {
      for (let index = 0; index < input.appearance.layers.length; index++) {
        const layer = input.appearance.layers[index]; if (!layer.visible) continue;
        const source = layerSource(layer, input);
        const rect = resolveLayerBounds(layer, input, width, height);
        if (layer.kind === 'background' && !(fullCameraIndex >= 0 && index < fullCameraIndex)) {
          let localBackground = input.layerSources?.[layer.sourceId ?? layer.id] ?? input.layerSources?.[layer.id];
          if (!localBackground && !layer.sourceId && !layer.assetId && input.background) {
            const [imageWidth, imageHeight] = imageSize(input.background);
            if (imageWidth && imageHeight) localBackground = { element: input.background, width: imageWidth, height: imageHeight };
          }
          const frame = getLayerFrame(layer, { layout: input.layout, appearance: input.appearance, orientation: input.orientation, width, height });
          const box = { x: frame.x * width, y: frame.y * height, width: frame.width * width, height: frame.height * height };
          context.save(); context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
          if (localBackground) {
            context.fillStyle = layer.color ?? input.appearance.backgroundColor; context.fillRect(box.x, box.y, box.width, box.height);
            const backgroundRect = resolveLayerBounds(layer, { ...input, layerSources: { ...input.layerSources, [layer.sourceId ?? layer.id]: localBackground } }, width, height);
            draw(context, localBackground, backgroundRect);
            if (input.layout === 'countdown') { context.fillStyle = 'rgba(0,0,0,.34)'; context.fillRect(box.x, box.y, box.width, box.height); }
          } else {
            context.translate(box.x, box.y);
            this.background(context, box.width, box.height, { ...input, background: null, appearance: { ...input.appearance, backgroundColor: layer.color ?? input.appearance.backgroundColor } });
          }
          context.restore();
        }
        if (layer.kind === 'camera' && source) {
          const appearance = { ...input.appearance, cameraShape: layer.cameraShape ?? input.appearance.cameraShape, cameraBorderColor: layer.cameraBorderColor ?? input.appearance.cameraBorderColor, cameraBorderWidth: layer.cameraBorderWidth ?? input.appearance.cameraBorderWidth, cameraShadow: layer.cameraShadow ?? input.appearance.cameraShadow };
          this.camera(context, source, rect, appearance, width, height, true);
        }
        if (layer.kind === 'screen' && source) {
          const frame = this.screenFrame(source, rect, Math.max(width, height), input.frameId);
          if (input.layout === 'screen-3d' && input.orientation === 'landscape') this.perspective(context, frame.source, frame.rect, width, height);
          else draw(context, frame.source, frame.rect);
        }
        const scale = Math.min(width, height) / 1080;
        const style = { fontSize: getLayerFontSize(layer, input.layout) * scale, color: layer.color ?? '#ffffff', align: getLayerTextAlign(layer, input.layout) } as const;
        if (layer.kind === 'title') this.countdownPainter.drawTitle(context, rect, layer.text ?? input.appearance.productTitle, style);
        if (layer.kind === 'timer') this.countdownPainter.drawTimer(context, rect, input.remainingSeconds, { ...style, label: layer.text });
      }
    } finally { context.restore(); }
  }
  private screenFrame(source: SceneVisualSource, rect: DrawRect, maxSize: number, frameId?: number): { source: SceneVisualSource; rect: DrawRect } {
    if (!(source.element instanceof HTMLVideoElement) || rect.cropWidth <= 0 || rect.cropHeight <= 0) return { source, rect };
    const video = source.element;
    let frames = this.screenFrames.get(video);
    if (!frames) { frames = new Map(); this.screenFrames.set(video, frames); }
    const opaque = video.srcObject instanceof MediaStream;
    const key = `${source.width}:${source.height}:${rect.cropX}:${rect.cropY}:${rect.cropWidth}:${rect.cropHeight}:${maxSize}:${opaque}`;
    let frame = frames.get(key);
    if (!frame) {
      const scale = Math.min(1, maxSize / Math.max(rect.cropWidth, rect.cropHeight));
      const canvas = this.newCanvas(rect.cropWidth * scale, rect.cropHeight * scale);
      // Keep captured video on the accelerated path; it is copied once rather
      // than read back or converted again for every perspective strip.
      const context = canvas.getContext('2d', { alpha: !opaque })!;
      context.globalCompositeOperation = 'copy';
      // A few simultaneous crops may share a video. Bound retained full-size
      // surfaces while layers are dragged or resized.
      if (frames.size >= 4) frames.delete(frames.keys().next().value!);
      frame = { canvas, context }; frames.set(key, frame);
    }
    if (frameId === undefined || frame.frameId !== frameId) {
      frame.context.drawImage(video, rect.cropX, rect.cropY, rect.cropWidth, rect.cropHeight, 0, 0, frame.canvas.width, frame.canvas.height);
      frame.frameId = frameId;
    }
    return {
      source: { element: frame.canvas, width: frame.canvas.width, height: frame.canvas.height },
      rect: { ...rect, cropX: 0, cropY: 0, cropWidth: frame.canvas.width, cropHeight: frame.canvas.height },
    };
  }
  private background(context: CanvasRenderingContext2D, width: number, height: number, input: SceneRenderInput) {
    if (input.background) {
      context.fillStyle = input.appearance.backgroundColor; context.fillRect(0, 0, width, height);
      const [imageWidth, imageHeight] = imageSize(input.background);
      if (imageWidth && imageHeight) {
        const scale = Math.max(width / imageWidth, height / imageHeight);
        context.drawImage(input.background, (width - imageWidth * scale) / 2, (height - imageHeight * scale) / 2, imageWidth * scale, imageHeight * scale);
        if (input.layout === 'countdown') { context.fillStyle = 'rgba(0,0,0,.48)'; context.fillRect(0, 0, width, height); }
      }
    } else if (input.layout === 'countdown') {
      this.countdownPainter.background(context, width, height, input.appearance);
    } else { context.fillStyle = input.appearance.backgroundColor; context.fillRect(0, 0, width, height); }
  }
  private camera(context: CanvasRenderingContext2D, source: SceneVisualSource, initial: DrawRect, appearance: SceneAppearance, width: number, height: number, styled: boolean) {
    let rect = initial;
    const shape = styled ? appearance.cameraShape : 'rectangle';
    const border = styled ? appearance.cameraBorderWidth * Math.min(width, height) / 1080 : 0;
    const shadow = styled && appearance.cameraShadow;
    if (shape === 'rectangle' && !border && !shadow) { draw(context, source, rect); return; }
    const margin = Math.max(2, Math.ceil(Math.min(width, height) * 0.025));
    const key = `camera:${Math.ceil(rect.width)}:${Math.ceil(rect.height)}:${shape}:${border}:${appearance.cameraBorderColor}:${shadow}:${margin}`;
    let decoration = this.decorations.get(key);
    if (!decoration) {
      decoration = this.newCanvas(rect.width + margin * 2, rect.height + margin * 2); const cached = decoration.getContext('2d', { willReadFrequently: true })!;
      roundedPath(cached, margin, margin, rect.width, rect.height, shape);
      if (shadow) { cached.shadowColor = 'rgba(0,0,0,.55)'; cached.shadowBlur = margin * 0.7; cached.shadowOffsetY = margin * 0.3; }
      cached.fillStyle = '#171717'; cached.fill();
      this.cache(this.decorations, key, decoration);
    }
    context.drawImage(decoration, rect.x - margin, rect.y - margin);
    context.save(); roundedPath(context, rect.x, rect.y, rect.width, rect.height, shape); context.clip(); draw(context, source, rect); context.restore();
    if (border) { context.save(); roundedPath(context, rect.x, rect.y, rect.width, rect.height, shape); context.lineWidth = border; context.strokeStyle = appearance.cameraBorderColor; context.stroke(); context.restore(); }
  }
  private perspective(context: CanvasRenderingContext2D, source: SceneVisualSource, rect: DrawRect, width: number, height: number) {
    const margin = Math.max(3, Math.ceil(Math.min(width, height) * 0.02));
    const key = `screen:${Math.ceil(rect.width)}:${Math.ceil(rect.height)}:${margin}`;
    let decoration = this.decorations.get(key);
    if (!decoration) {
      decoration = this.newCanvas(rect.width + margin * 3, rect.height + margin * 3); const cached = decoration.getContext('2d', { willReadFrequently: true })!;
      const points = getPresentationQuad({ ...rect, x: margin, y: margin });
      cached.beginPath(); points.forEach(([x, y], index) => index ? cached.lineTo(x, y) : cached.moveTo(x, y)); cached.closePath();
      cached.shadowColor = 'rgba(0,0,0,.55)'; cached.shadowBlur = margin * .6; cached.shadowOffsetY = margin * .2;
      cached.fillStyle = '#111111'; cached.fill(); cached.shadowColor = 'transparent';
      cached.strokeStyle = 'rgba(255,255,255,.2)'; cached.lineWidth = Math.max(1, width / 1920); cached.stroke();
      this.cache(this.decorations, key, decoration);
    }
    context.drawImage(decoration, Math.round(rect.x - margin), Math.round(rect.y - margin));
    context.save();
    context.beginPath(); getPresentationQuad(rect).forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y)); context.closePath(); context.clip();
    // Only landscape needs a warp. Cached geometry and axis-aligned slices
    // avoid a per-frame shadow or a second resampling pass on captured video.
    const sliceKey = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    const slices = this.presentationSlices.get(sliceKey) ?? this.cache(this.presentationSlices, sliceKey, getPresentationSlices(rect));
    for (const slice of slices) {
      context.drawImage(source.element, rect.cropX + rect.cropWidth * slice.sourceX, rect.cropY, rect.cropWidth * slice.sourceWidth, rect.cropHeight, slice.x, slice.y, slice.width, slice.height);
    }
    context.restore();
  }

  clear(): void { this.generated.clear(); this.decorations.clear(); this.presentationSlices.clear(); this.screenFrames = new WeakMap(); this.countdownPainter.clear(); }
}
