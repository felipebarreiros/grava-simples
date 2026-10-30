import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getLayerFrame } from "../media/SceneCompositor";
import type {
  LayerFrame,
  Orientation,
  SceneAppearance,
  SceneLayer,
} from "../media/types";
import type { ProjectScene } from "../projects/store";
import "./LayerCanvasEditor.css";

export interface LayerCanvasEditorProps {
  scene: ProjectScene;
  appearance: SceneAppearance;
  orientation: Orientation;
  selectedLayerId?: string;
  onSelectLayer: (id: string) => void;
  onLayerChange: (id: string, patch: Partial<SceneLayer>) => void;
  bounds?: Record<string, LayerFrame>;
  disabled?: boolean;
}
type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Drag = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  frame: LayerFrame;
  originalFrame?: LayerFrame;
  handle: Handle;
  element: HTMLElement;
};
type SnapGuide = 0 | 0.5 | 1;
type Draft = {
  id: string;
  frame: LayerFrame;
  guides?: { x?: SnapGuide; y?: SnapGuide };
};
const SNAP_DISTANCE_PX = 6;

// Frame coordinates are normalized; snapping should feel the same in a small
// portrait preview and a large landscape preview, so compare in CSS pixels.
function snapAxis(position: number, size: number, pixels: number) {
  const candidates = [
    { position: (1 - size) / 2, guide: 0.5 },
    { position: 0, guide: 0 },
    { position: 1 - size, guide: 1 },
  ] as const;
  let snapped = position;
  let guide: SnapGuide | undefined;
  let closest = SNAP_DISTANCE_PX;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.position - position) * pixels;
    if (distance <= closest && (guide === undefined || distance < closest)) {
      snapped = candidate.position;
      guide = candidate.guide;
      closest = distance;
    }
  }
  return { position: snapped, guide };
}
const handleLabels: Record<Exclude<Handle, "move">, string> = {
  nw: "canto superior esquerdo",
  n: "borda superior",
  ne: "canto superior direito",
  e: "borda direita",
  se: "canto inferior direito",
  s: "borda inferior",
  sw: "canto inferior esquerdo",
  w: "borda esquerda",
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const bounded = (frame: LayerFrame): LayerFrame => ({
  x: clamp(frame.x, -1, 1),
  y: clamp(frame.y, -1, 1),
  width: clamp(frame.width, 0.02, 2),
  height: clamp(frame.height, 0.02, 2),
});

/** Selection chrome is DOM-only: it is never captured into either recording. */
export function LayerCanvasEditor({
  scene,
  appearance,
  orientation,
  selectedLayerId,
  onSelectLayer,
  onLayerChange,
  bounds,
  disabled = false,
}: LayerCanvasEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    const active = drag.current;
    if (active?.element.hasPointerCapture(active.pointerId))
      active.element.releasePointerCapture(active.pointerId);
    drag.current = null;
    setDraft(null);
  }, [scene.id, orientation, disabled]);
  const currentProps = useRef({ onLayerChange, appearance });
  currentProps.current = { onLayerChange, appearance };
  const frameFor = (layer: SceneLayer) =>
    bounds?.[layer.id] ??
    getLayerFrame(layer, { layout: scene.layout, appearance, orientation });
  const commit = (id: string, frame: LayerFrame) => {
    const layer = currentProps.current.appearance.layers.find(
      (item) => item.id === id,
    );
    if (layer)
      currentProps.current.onLayerChange(id, {
        frames: { ...layer.frames, [orientation]: bounded(frame) },
      });
  };
  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    layer: SceneLayer,
    handle: Handle,
  ) => {
    if (disabled || event.button !== 0 || !container.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onSelectLayer(layer.id);
    const rect = container.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const frame = frameFor(layer);
    drag.current = {
      id: layer.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      frame,
      originalFrame: layer.frames?.[orientation]
        ? { ...layer.frames[orientation] }
        : undefined,
      handle,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ id: layer.id, frame });
  };
  const move = (event: ReactPointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - active.startX) / active.width,
      dy = (event.clientY - active.startY) / active.height;
    const frame = { ...active.frame };
    let guides: Draft["guides"];
    if (active.handle === "move") {
      frame.x += dx;
      frame.y += dy;
      if (!event.altKey) {
        const horizontal = snapAxis(frame.x, frame.width, active.width);
        const vertical = snapAxis(frame.y, frame.height, active.height);
        frame.x = horizontal.position;
        frame.y = vertical.position;
        guides = { x: horizontal.guide, y: vertical.guide };
      }
    } else {
      const west = active.handle.includes("w"),
        east = active.handle.includes("e"),
        north = active.handle.includes("n"),
        south = active.handle.includes("s");
      if (west) {
        frame.x += dx;
        frame.width -= dx;
      }
      if (east) frame.width += dx;
      if (north) {
        frame.y += dy;
        frame.height -= dy;
      }
      if (south) frame.height += dy;
      const layer = currentProps.current.appearance.layers.find(
        (item) => item.id === active.id,
      );
      const circle =
        layer?.kind === "camera" &&
        (layer.cameraShape ?? currentProps.current.appearance.cameraShape) ===
          "circle";
      if (circle || (event.shiftKey && (west || east) && (north || south))) {
        const ratio = active.frame.width / active.frame.height;
        if (west || east) frame.height = Math.max(0.02, frame.width) / ratio;
        else frame.width = Math.max(0.02, frame.height) * ratio;
        if (west) frame.x = active.frame.x + active.frame.width - frame.width;
        else if (!east)
          frame.x = active.frame.x + (active.frame.width - frame.width) / 2;
        if (north)
          frame.y = active.frame.y + active.frame.height - frame.height;
        else if (!south)
          frame.y = active.frame.y + (active.frame.height - frame.height) / 2;
      }
      if (frame.width < 0.02) {
        if (west) frame.x = active.frame.x + active.frame.width - 0.02;
        frame.width = 0.02;
      }
      if (frame.height < 0.02) {
        if (north) frame.y = active.frame.y + active.frame.height - 0.02;
        frame.height = 0.02;
      }
    }
    const next = bounded(frame);
    setDraft({ id: active.id, frame: next, guides });
    commit(active.id, next);
  };
  const finish = (event: ReactPointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.element.hasPointerCapture(event.pointerId))
      active.element.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDraft(null);
  };
  const cancel = (event: ReactPointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const layer = currentProps.current.appearance.layers.find(
      (item) => item.id === active.id,
    );
    if (layer) {
      const frames = { ...layer.frames };
      if (active.originalFrame) frames[orientation] = active.originalFrame;
      else delete frames[orientation];
      currentProps.current.onLayerChange(active.id, { frames });
    }
    finish(event);
  };
  const nudge = (
    event: ReactKeyboardEvent,
    layer: SceneLayer,
    resize = false,
  ) => {
    if (
      disabled ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const frame = { ...frameFor(layer) };
    const pixels = event.shiftKey ? 10 : 1,
      width = orientation === "landscape" ? 1920 : 1080,
      height = orientation === "landscape" ? 1080 : 1920;
    if (event.key === "ArrowLeft") {
      if (resize) frame.width -= pixels / width;
      else frame.x -= pixels / width;
    }
    if (event.key === "ArrowRight") {
      if (resize) frame.width += pixels / width;
      else frame.x += pixels / width;
    }
    if (event.key === "ArrowUp") {
      if (resize) frame.height -= pixels / height;
      else frame.y -= pixels / height;
    }
    if (event.key === "ArrowDown") {
      if (resize) frame.height += pixels / height;
      else frame.y += pixels / height;
    }
    onSelectLayer(layer.id);
    commit(layer.id, frame);
  };
  if (disabled) return null;
  const selectedLayer = appearance.layers.find(
    (layer) => layer.id === selectedLayerId && layer.visible,
  );
  const selectedFrame = selectedLayer
    ? draft?.id === selectedLayer.id
      ? draft.frame
      : frameFor(selectedLayer)
    : undefined;
  return (
    <div
      ref={container}
      className={`layer-canvas-editor ${draft ? "is-dragging" : ""}`}
      data-testid={`canvas-editor-${orientation}`}
      aria-label={`Editar camadas no formato ${orientation === "landscape" ? "horizontal" : "vertical"}`}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancel}
    >
      {appearance.layers
        .filter((layer) => layer.visible)
        .map((layer, index) => {
          const selected = selectedLayerId === layer.id,
            frame = draft?.id === layer.id ? draft.frame : frameFor(layer);
          return (
            <div
              key={layer.id}
              className={`canvas-layer-box ${selected ? "selected" : ""}`}
              data-selected={selected || undefined}
              data-layer-id={layer.id}
              style={{
                left: `${frame.x * 100}%`,
                top: `${frame.y * 100}%`,
                width: `${frame.width * 100}%`,
                height: `${frame.height * 100}%`,
                zIndex: index + 1,
              }}
            >
              <button
                type="button"
                className="canvas-layer-hit"
                aria-label={`Selecionar e mover ${layer.name}`}
                data-testid={`canvas-layer-${orientation}-${layer.id}`}
                onFocus={() => onSelectLayer(layer.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectLayer(layer.id);
                }}
                onPointerDown={(event) => begin(event, layer, "move")}
                onKeyDown={(event) => nudge(event, layer)}
              />
            </div>
          );
        })}
      {selectedLayer && selectedFrame && (
        <div
          className="canvas-layer-box selected canvas-selection-chrome"
          style={{
            left: `${selectedFrame.x * 100}%`,
            top: `${selectedFrame.y * 100}%`,
            width: `${selectedFrame.width * 100}%`,
            height: `${selectedFrame.height * 100}%`,
            zIndex: 200,
          }}
        >
          <button
            type="button"
            className="canvas-layer-label"
            aria-label={`Mover camada selecionada ${selectedLayer.name}`}
            onPointerDown={(event) => begin(event, selectedLayer, "move")}
            onKeyDown={(event) => nudge(event, selectedLayer)}
          >
            {selectedLayer.name}
          </button>
          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map(
            (handle) => (
              <button
                type="button"
                key={handle}
                className={`canvas-resize-handle handle-${handle}`}
                data-testid={`resize-${orientation}-${handle}`}
                aria-label={`Redimensionar ${selectedLayer.name}, ${handleLabels[handle]}`}
                onPointerDown={(event) => begin(event, selectedLayer, handle)}
                onKeyDown={(event) => nudge(event, selectedLayer, true)}
              />
            ),
          )}
        </div>
      )}
      {(["x", "y"] as const).map((axis) => {
        const position = draft?.guides?.[axis];
        if (position === undefined) return null;
        return (
          <div
            key={axis}
            className={`canvas-snap-guide canvas-snap-guide-${axis}`}
            data-testid={`snap-guide-${orientation}-${axis}`}
            data-position={position}
            style={{ [axis === "x" ? "left" : "top"]: `${position * 100}%` }}
            aria-hidden="true"
          >
            {position === 0.5 && <span>Centro</span>}
          </div>
        );
      })}
    </div>
  );
}
