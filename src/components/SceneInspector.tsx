import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  ImagePlus,
  Mic,
  MicOff,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Timer,
  Trash2,
  Type,
} from "lucide-react";
import { IconButton } from "./StudioUi";
import { Select } from "./Select";
import { Button } from "./ui/button";
import { Input, NumberInput, Textarea } from "./ui/input";
import { Slider } from "./ui/slider";
import { Switch } from "./ui/switch";
import { Tooltip } from "./ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { CountdownDuration } from "./CountdownDuration";
import type { ProjectScene } from "../projects/store";
import type {
  LayerFrame,
  Orientation,
  SceneAppearance,
  SceneLayer,
  StudioControls,
  StudioMetrics,
} from "../media/types";
import { getLayerFontSize, getLayerTextAlign } from "../media/SceneCompositor";
import "./SceneInspector.css";

const palette = [
  { name: "Laranja", color: "#ff4000" },
  { name: "Branco", color: "#f5f3ef" },
  { name: "Carvão", color: "#171717" },
  { name: "Violeta", color: "#8860ee" },
  { name: "Azul", color: "#4b91ff" },
  { name: "Dourado", color: "#efb859" },
];
const layerNames: Record<SceneLayer["kind"], string> = {
  camera: "Câmera",
  screen: "Tela ou mídia",
  background: "Fundo",
  title: "Texto",
  timer: "Contagem regressiva",
};
const LayerIcon = ({
  kind,
  size = 16,
}: {
  kind: SceneLayer["kind"];
  size?: number;
}) =>
  kind === "camera" ? (
    <Camera size={size} />
  ) : kind === "screen" ? (
    <Monitor size={size} />
  ) : kind === "timer" ? (
    <Timer size={size} />
  ) : kind === "title" ? (
    <Type size={size} />
  ) : (
    <ImagePlus size={size} />
  );

function SortableLayer({
  layer,
  selected,
  onSelect,
  onToggle,
  disabled,
}: {
  layer: SceneLayer;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: layer.id, disabled });
  return (
    <div
      ref={setNodeRef}
      className={`layer-row ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-layer-id={layer.id}
    >
      <Button
        variant="ghost"
        size="icon"
        disabled={disabled}
        className="layer-drag-handle"
        aria-label={`Reordenar ${layer.name}`}
        data-testid={`layer-drag-${layer.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={13} />
      </Button>
      <Button
        variant="ghost"
        disabled={disabled}
        className="layer-name"
        aria-pressed={selected}
        onClick={onSelect}
        data-testid={`layer-select-${layer.id}`}
      >
        <LayerIcon kind={layer.kind} />
        <span>{layer.name}</span>
      </Button>
      <IconButton
        label={`${layer.visible ? "Ocultar" : "Mostrar"} ${layer.name.toLowerCase()}`}
        data-testid={`layer-eye-${layer.id}`}
        aria-pressed={layer.visible}
        onClick={onToggle}
      >
        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </IconButton>
    </div>
  );
}
function ColorChoices({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      className="color-palette"
      aria-label={label}
      value={value}
      onValueChange={(next) => { if (next) onChange(next); }}
    >
      {palette.map((swatch) => (
        <ToggleGroupItem
          key={swatch.color}
          value={swatch.color}
          aria-label={`${label}: ${swatch.name.toLowerCase()}`}
          style={{ backgroundColor: swatch.color }}
        >
          {value === swatch.color && <Check size={12} />}
        </ToggleGroupItem>
      ))}
      <label className="custom-color" title="Escolher outra cor">
        <span>+</span>
        <Input
          aria-label={`${label} personalizada`}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </ToggleGroup>
  );
}
export interface SceneInspectorProps {
  scene: ProjectScene;
  appearance: SceneAppearance;
  onChange: (value: SceneAppearance) => void;
  onZoom: (value: number) => void;
  onEditScene: () => void;
  onAddLayer: (kind: SceneLayer["kind"]) => void;
  onRemoveLayer: (id: string) => void;
  onConnect: (kind: "camera" | "screen" | "microphone") => void;
  onImportMedia: (layerId?: string) => void;
  onBackground: (file: File) => void;
  onClearBackground: () => void;
  controls: StudioControls;
  metrics?: StudioMetrics;
  onMute: () => void;
  onGain: (gain: number) => void;
  countdown?: { remainingSeconds: number; running: boolean };
  onResetCountdown: () => void;
  onPauseCountdown: () => void;
  onResumeCountdown: () => void;
  onZeroCountdown?: () => void;
  busy: boolean;
  ready: boolean;
  locked?: boolean;
  selectedLayerId?: string;
  onSelectLayer?: (id: string) => void;
  onLayerChange?: (id: string, patch: Partial<SceneLayer>) => void;
  onReplaceSource?: (id: string) => void;
  onDuplicateLayer?: (id: string) => void;
  orientation?: Orientation;
  onOrientationChange?: (value: Orientation) => void;
  bounds?: Record<string, LayerFrame>;
}
export function SceneInspector({
  scene,
  appearance,
  onChange,
  onZoom,
  onEditScene,
  onAddLayer,
  onRemoveLayer,
  onConnect,
  onImportMedia,
  onBackground,
  onClearBackground,
  controls,
  metrics,
  onMute,
  onGain,
  countdown,
  onResetCountdown,
  onPauseCountdown,
  onResumeCountdown,
  onZeroCountdown,
  busy,
  ready,
  locked = false,
  selectedLayerId,
  onSelectLayer,
  onLayerChange,
  onReplaceSource,
  onDuplicateLayer,
  orientation = "landscape",
  onOrientationChange,
  bounds,
}: SceneInspectorProps) {
  const [addOpen, setAddOpen] = useState(false),
    [localSelected, setLocalSelected] = useState("");
  const backgroundInput = useRef<HTMLInputElement>(null);
  const selected = selectedLayerId ?? localSelected;
  const select = (id: string) => {
    setLocalSelected(id);
    onSelectLayer?.(id);
  };
  useEffect(() => {
    setAddOpen(false);
    if (selectedLayerId === undefined)
      setLocalSelected(
        appearance.layers.find(
          (layer) =>
            layer.kind === (scene.layout === "countdown" ? "timer" : "camera"),
        )?.id ??
          appearance.layers.at(-1)?.id ??
          "",
      );
  }, [scene.id]);
  const selectedLayer = appearance.layers.find(
    (layer) => layer.id === selected,
  );
  const topFirst = [...appearance.layers].reverse();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const patch = (value: Partial<SceneAppearance>) =>
    onChange({ ...appearance, ...value });
  const editLayer = (value: Partial<SceneLayer>) => {
    if (!selectedLayer) return;
    if (onLayerChange) onLayerChange(selectedLayer.id, value);
    else
      patch({
        layers: appearance.layers.map((layer) =>
          layer.id === selectedLayer.id ? { ...layer, ...value } : layer,
        ),
      });
  };
  const toggle = (id: string) =>
    patch({
      layers: appearance.layers.map((layer) =>
        layer.id === id ? { ...layer, visible: !layer.visible } : layer,
      ),
    });
  const move = (id: string, direction: number) => {
    const layers = [...appearance.layers],
      index = layers.findIndex((layer) => layer.id === id),
      target = index + direction;
    if (target < 0 || target >= layers.length) return;
    [layers[index], layers[target]] = [layers[target], layers[index]];
    patch({ layers });
  };
  const dragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = topFirst.findIndex((layer) => layer.id === active.id),
      to = topFirst.findIndex((layer) => layer.id === over.id);
    if (from >= 0 && to >= 0)
      patch({ layers: arrayMove(topFirst, from, to).reverse() });
  };
  const frame = selectedLayer?.frames?.[orientation] ??
    (selectedLayer ? bounds?.[selectedLayer.id] : undefined) ?? {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
  const setFrame = (part: Partial<LayerFrame>) =>
    editLayer({
      frames: {
        ...selectedLayer?.frames,
        [orientation]: { ...frame, ...part },
      },
    });
  const cameraStyle = {
    cameraShape: selectedLayer?.cameraShape ?? appearance.cameraShape,
    cameraShadow: selectedLayer?.cameraShadow ?? appearance.cameraShadow,
    cameraBorderColor:
      selectedLayer?.cameraBorderColor ?? appearance.cameraBorderColor,
    cameraBorderWidth:
      selectedLayer?.cameraBorderWidth ?? appearance.cameraBorderWidth,
  };
  const replaceSource = () => {
    if (!selectedLayer) return;
    if (onReplaceSource) onReplaceSource(selectedLayer.id);
    else if (selectedLayer.kind === "camera") onConnect("camera");
    else onConnect("screen");
  };
  const defaultText = selectedLayer?.text ?? appearance.productTitle;
  return (
    <aside
      className="studio-tools scene-inspector"
      inert={locked || undefined}
      aria-busy={locked || undefined}
      data-locked={locked || undefined}
      aria-label={`Ajustes da cena ${scene.name}`}
    >
      <div className="inspector-heading">
        <div>
          <span>Cena selecionada</span>
          <h2>{scene.name}</h2>
        </div>
        <IconButton
          label="Editar cena selecionada"
          onClick={onEditScene}
          disabled={busy}
        >
          <MoreHorizontal size={18} />
        </IconButton>
      </div>
      <section className="layers-section">
        <div className="section-heading">
          <h2>Camadas</h2>
          <DropdownMenu open={addOpen} onOpenChange={setAddOpen}>
            <DropdownMenuTrigger asChild>
              <IconButton
                label="Adicionar camada"
                data-testid="add-source"
                disabled={busy}
              >
                <Plus size={17} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="layer-source-menu">
              {(["camera", "screen", "background", "title", "timer"] as const).map((kind) => (
                <DropdownMenuItem key={kind} onSelect={() => onAddLayer(kind)}>
                  <LayerIcon kind={kind} />
                  <span>{layerNames[kind]}</span>
                  <Plus size={12} />
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => onImportMedia()}>
                <ImagePlus size={16} />
                <span>Importar imagem ou vídeo</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={dragEnd}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "Pressione espaço para mover a camada. Use as setas para escolher a posição e espaço para soltar. Escape cancela.",
            },
            announcements: {
              onDragStart: ({ active }) =>
                `Movendo ${appearance.layers.find((layer) => layer.id === active.id)?.name ?? "camada"}.`,
              onDragOver: ({ over }) =>
                over
                  ? `Sobre ${appearance.layers.find((layer) => layer.id === over.id)?.name ?? "camada"}.`
                  : "",
              onDragEnd: () => "Ordem das camadas atualizada.",
              onDragCancel: () => "Movimento cancelado.",
            },
          }}
        >
          <SortableContext
            items={topFirst.map((layer) => layer.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="layer-list" data-testid="layer-list">
              {topFirst.map((layer) => (
                <SortableLayer
                  key={layer.id}
                  layer={layer}
                  selected={selected === layer.id}
                  onSelect={() => select(layer.id)}
                  onToggle={() => toggle(layer.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        {selectedLayer && (
          <div className="layer-actions">
            <span>{selectedLayer.name}</span>
            <Tooltip content="Mover para cima" side="top">
              <IconButton
                label="Mover camada para cima"
                disabled={appearance.layers.at(-1)?.id === selected}
                onClick={() => move(selected, 1)}
              >
                <ArrowUp size={13} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Mover para baixo" side="top">
              <IconButton
                label="Mover camada para baixo"
                disabled={appearance.layers[0]?.id === selected}
                onClick={() => move(selected, -1)}
              >
                <ArrowDown size={13} />
              </IconButton>
            </Tooltip>
            {onDuplicateLayer && (
              <IconButton
                label="Duplicar camada"
                onClick={() => onDuplicateLayer(selected)}
              >
                <Copy size={13} />
              </IconButton>
            )}
            <IconButton
              label="Remover camada"
              disabled={busy}
              onClick={() => onRemoveLayer(selected)}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        )}
      </section>
      {selectedLayer && (
        <section className="layer-properties-section">
          <div className="section-heading">
            <h2>{selectedLayer.name}</h2>
          </div>
          <label className="field-label">
            Nome da camada
            <Input
              aria-label="Nome da camada"
              value={selectedLayer.name}
              maxLength={80}
              onChange={(event) => editLayer({ name: event.target.value })}
            />
          </label>
          {(selectedLayer.kind === "camera" ||
            selectedLayer.kind === "screen") && (
            <div className="layer-source-controls">
              <Button
                variant="outline"
                size="sm"
                onClick={replaceSource}
                disabled={busy}
                data-testid="replace-layer-source"
              >
                <LayerIcon kind={selectedLayer.kind} />
                {selectedLayer.kind === "camera"
                  ? "Escolher câmera da cena"
                  : "Trocar tela ou mídia"}
              </Button>
              <label className="field-label">
                Enquadramento
                <Select
                  label="Ajuste da fonte"
                  value={
                    selectedLayer.fit ??
                    (selectedLayer.kind === "camera" ? "cover" : "contain")
                  }
                  onValueChange={(value) =>
                    editLayer({ fit: value as "contain" | "cover" })
                  }
                  options={[
                    { value: "contain", label: "Mostrar por inteiro" },
                    { value: "cover", label: "Preencher o espaço" },
                  ]}
                />
              </label>
            </div>
          )}
          {selectedLayer.kind === "title" && (
            <div className="text-layer-controls">
              <label className="field-label">
                Texto
                <Textarea
                  data-testid="layer-text"
                  aria-label="Texto da camada"
                  value={defaultText}
                  maxLength={400}
                  onChange={(event) => editLayer({ text: event.target.value })}
                />
              </label>
            </div>
          )}
          {selectedLayer.kind === "timer" && (
            <label className="field-label">
              Texto de apoio
              <Input
                aria-label="Texto de apoio da contagem"
                data-testid="timer-caption"
                value={selectedLayer.text ?? ""}
                placeholder="Começamos em"
                maxLength={100}
                onChange={(event) => editLayer({ text: event.target.value })}
              />
            </label>
          )}
          {(selectedLayer.kind === "title" ||
            selectedLayer.kind === "timer") && (
            <>
              <div className="type-control-row">
                <label className="field-label">
                  Tamanho
                  <NumberInput
                    label="Tamanho do texto"
                    data-testid="layer-font-size"
                    min={8}
                    max={512}
                    value={getLayerFontSize(selectedLayer, scene.layout)}
                    onValueChange={(fontSize) => editLayer({ fontSize })}
                  />
                </label>
                <ToggleGroup
                  type="single"
                  className="text-align-buttons"
                  aria-label="Alinhamento do texto"
                  value={getLayerTextAlign(selectedLayer, scene.layout)}
                  onValueChange={(align) => { if (align) editLayer({ align: align as "left" | "center" | "right" }); }}
                >
                  {(["left", "center", "right"] as const).map((align) => (
                    <ToggleGroupItem
                      size="icon"
                      value={align}
                      aria-label={
                        align === "left"
                          ? "Alinhar texto à esquerda"
                          : align === "right"
                            ? "Alinhar texto à direita"
                            : "Centralizar texto"
                      }
                      key={align}
                    >
                      {align === "left" ? (
                        <AlignLeft size={15} />
                      ) : align === "right" ? (
                        <AlignRight size={15} />
                      ) : (
                        <AlignCenter size={15} />
                      )}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <ColorChoices
                label="Cor do texto"
                value={selectedLayer.color ?? "#ffffff"}
                onChange={(color) => editLayer({ color })}
              />
            </>
          )}
          <div className="geometry-heading">
            <h3>Posição e tamanho</h3>
            <ToggleGroup
              type="single"
              className="orientation-switch"
              aria-label="Formato em edição"
              value={orientation}
              onValueChange={(value) => { if (value) onOrientationChange?.(value as Orientation); }}
            >
              <ToggleGroupItem value="landscape" aria-label="Editar formato horizontal">
                <Monitor size={13} />
              </ToggleGroupItem>
              <ToggleGroupItem value="portrait" aria-label="Editar formato vertical">
                <span className="portrait-format-icon" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="layer-geometry-grid">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label className="field-label" key={key}>
                {key === "x"
                  ? "X"
                  : key === "y"
                    ? "Y"
                    : key === "width"
                      ? "Largura"
                      : "Altura"}
                <div className="percent-number">
                  <NumberInput
                    label={`${key === "x" ? "Posição X" : key === "y" ? "Posição Y" : key === "width" ? "Largura" : "Altura"} da camada`}
                    data-testid={`layer-${key}`}
                    value={Math.round(frame[key] * 1000) / 10}
                    min={key === "x" || key === "y" ? -100 : 2}
                    max={key === "x" || key === "y" ? 100 : 200}
                    step={1}
                    onValueChange={(value) => setFrame({ [key]: value / 100 })}
                  />
                  <span>%</span>
                </div>
              </label>
            ))}
          </div>
          <div
            className="layer-alignment"
            role="group"
            aria-label="Posicionar camada"
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label="Posicionar à esquerda"
              onClick={() => setFrame({ x: 0 })}
            >
              Esquerda
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Centralizar camada"
              onClick={() =>
                setFrame({
                  x: (1 - frame.width) / 2,
                  y: (1 - frame.height) / 2,
                })
              }
            >
              Centro
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Posicionar à direita"
              onClick={() => setFrame({ x: 1 - frame.width })}
            >
              Direita
            </Button>
          </div>
          <Button
            className="reset-layer-frame"
            variant="link"
            size="sm"
            onClick={() => {
              if (!selectedLayer) return;
              const frames = { ...selectedLayer.frames };
              delete frames[orientation];
              editLayer({ frames });
            }}
          >
            Restaurar enquadramento
          </Button>
        </section>
      )}
      {scene.layout === "camera-zoom" && (
        <section className="zoom-section">
          <div className="section-heading">
            <h2>Zoom da câmera</h2>
            <output>{(scene.zoom ?? 1.4).toFixed(1)}×</output>
          </div>
          <Slider
            data-testid="camera-zoom"
            label="Zoom da câmera"
            min={1}
            max={2.5}
            step={0.1}
            value={[scene.zoom ?? 1.4]}
            onValueChange={(values) => onZoom(values[0])}
          />
          <div className="range-ends">
            <span>1×</span>
            <span>2,5×</span>
          </div>
        </section>
      )}
      {selectedLayer?.kind === "camera" && (
        <section className="camera-style-section">
          <div className="section-heading">
            <h2>Estilo da câmera</h2>
          </div>
          <ToggleGroup
            type="single"
            className="camera-shapes"
            aria-label="Formato da câmera"
            value={cameraStyle.cameraShape}
            onValueChange={(shape) => { if (shape) editLayer({ cameraShape: shape as "rectangle" | "rounded" | "circle" }); }}
          >
            {(["rectangle", "rounded", "circle"] as const).map((shape) => (
              <ToggleGroupItem
                key={shape}
                value={shape}
                aria-label={
                  shape === "circle"
                    ? "Câmera circular"
                    : shape === "rounded"
                      ? "Câmera com cantos arredondados"
                      : "Câmera retangular"
                }
                data-testid={`camera-shape-${shape}`}
                variant="outline"
              >
                <span className={`shape-sample sample-${shape}`} />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="kit-setting-row">
            <label htmlFor="camera-shadow">Sombra</label>
            <Switch
              id="camera-shadow"
              data-testid="camera-shadow"
              checked={cameraStyle.cameraShadow}
              onCheckedChange={(cameraShadow) => editLayer({ cameraShadow })}
            />
          </div>
          <div className="kit-setting-row">
            <label htmlFor="camera-outline">Contorno</label>
            <Switch
              id="camera-outline"
              data-testid="camera-outline"
              checked={cameraStyle.cameraBorderWidth > 0}
              onCheckedChange={(checked) =>
                editLayer({ cameraBorderWidth: checked ? 4 : 0 })
              }
            />
          </div>
          {cameraStyle.cameraBorderWidth > 0 && (
            <>
              <div className="outline-thickness">
                <label className="field-label">
                  Espessura
                  <NumberInput
                    label="Espessura do contorno"
                    data-testid="camera-outline-width"
                    min={1}
                    max={16}
                    value={cameraStyle.cameraBorderWidth}
                    onValueChange={(cameraBorderWidth) =>
                      editLayer({ cameraBorderWidth })
                    }
                  />
                </label>
                <Slider
                  label="Espessura do contorno"
                  min={1}
                  max={16}
                  step={1}
                  value={[cameraStyle.cameraBorderWidth]}
                  onValueChange={(values) =>
                    editLayer({ cameraBorderWidth: values[0] })
                  }
                />
              </div>
              <ColorChoices
                label="Cor do contorno"
                value={cameraStyle.cameraBorderColor}
                onChange={(cameraBorderColor) =>
                  editLayer({ cameraBorderColor })
                }
              />
            </>
          )}
        </section>
      )}
      {(selectedLayer?.kind === "timer" || scene.layout === "countdown") && (
        <section className="countdown-section">
          <div className="section-heading">
            <h2>Sua estreia</h2>
            <span className="timer-status">
              {countdown?.running
                ? "Em andamento"
                : countdown?.remainingSeconds === 0
                  ? "Zerado"
                  : "Pausado"}
            </span>
          </div>
          <CountdownDuration
            key={scene.id}
            seconds={appearance.countdownSeconds}
            onValueChange={(countdownSeconds) => patch({ countdownSeconds })}
          />
          <div className="countdown-controls">
            <Button
              variant="secondary"
              size="sm"
              data-testid="countdown-toggle"
              disabled={
                appearance.countdownSeconds <= 0 ||
                (!countdown?.running && countdown?.remainingSeconds === 0)
              }
              onClick={
                countdown?.running ? onPauseCountdown : onResumeCountdown
              }
            >
              {countdown?.running ? <Pause size={13} /> : <Play size={13} />}
              {countdown?.running ? "Pausar" : "Começar"}
            </Button>
            <Tooltip content="Voltar à duração inicial, sem começar" side="top">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Reiniciar contagem"
                data-testid="countdown-reset"
                onClick={onResetCountdown}
              >
                <RotateCcw size={15} />
              </Button>
            </Tooltip>
            <Tooltip content="Zerar e pausar" side="top">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Zerar contagem"
                data-testid="countdown-zero"
                onClick={() => {
                  if (onZeroCountdown) onZeroCountdown();
                  else {
                    onPauseCountdown();
                    patch({ countdownSeconds: 0 });
                  }
                }}
              >
                <Square size={13} />
              </Button>
            </Tooltip>
          </div>
        </section>
      )}
      {(scene.layout === "countdown" ||
        selectedLayer?.kind === "background") && (
        <section className="background-section">
          <div className="section-heading">
            <h2>Fundo da cena</h2>
          </div>
          <Input
            ref={backgroundInput}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,image/avif"
            data-testid="countdown-background-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onBackground(file);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            className="background-upload"
            onClick={() => backgroundInput.current?.click()}
            disabled={busy}
          >
            <ImagePlus size={15} />
            {appearance.backgroundAssetId
              ? "Trocar imagem"
              : "Usar minha imagem"}
          </Button>
          {appearance.backgroundAssetId ? (
            <Button variant="link" size="sm" onClick={onClearBackground}>
              Usar fundo do estúdio
            </Button>
          ) : (
            <ToggleGroup
              type="single"
              className="color-palette background-palette"
              aria-label="Cor do fundo"
              value={appearance.backgroundColor}
              onValueChange={(backgroundColor) => { if (backgroundColor) patch({ backgroundColor }); }}
            >
              {[
                "#151515",
                "#37180f",
                "#242036",
                "#172333",
                "#352c19",
                "#232323",
              ].map((color) => (
                <ToggleGroupItem
                  key={color}
                  value={color}
                  style={{ backgroundColor: color }}
                  aria-label={`Fundo ${color}`}
                >
                  {appearance.backgroundColor === color && <Check size={12} />}
                </ToggleGroupItem>
              ))}
              <label className="custom-color" title="Escolher outra cor">
                <span>+</span>
                <Input
                  aria-label="Cor personalizada do fundo"
                  type="color"
                  value={appearance.backgroundColor}
                  onChange={(event) =>
                    patch({ backgroundColor: event.target.value })
                  }
                />
              </label>
            </ToggleGroup>
          )}
        </section>
      )}
      <section className="microphone-section">
        <div className="section-heading">
          <div>
            <h2>Sua voz</h2>
            <span className="scene-audio-hint">Somente nesta cena</span>
          </div>
          <IconButton
            label="Escolher microfone"
            onClick={() => onConnect("microphone")}
            disabled={busy}
          >
            <Settings2 size={15} />
          </IconButton>
        </div>
        <div className="microphone-control">
          <IconButton
            label={
              controls.microphoneMuted
                ? "Ativar microfone"
                : "Silenciar microfone"
            }
            data-testid="microphone-mute"
            aria-pressed={controls.microphoneMuted}
            onClick={onMute}
          >
            {controls.microphoneMuted ? (
              <MicOff size={19} />
            ) : (
              <Mic size={19} />
            )}
          </IconButton>
          <div
            className="simple-meter"
            role="meter"
            aria-label="Nível do microfone"
            aria-valuemin={-60}
            aria-valuemax={0}
            aria-valuenow={Math.max(
              -60,
              Math.min(0, metrics?.audioLevelDb ?? -60),
            )}
          >
            <span
              style={{
                width: `${controls.microphoneMuted ? 0 : Math.max(0, Math.min(100, (((metrics?.audioLevelDb ?? -100) + 60) / 60) * 100))}%`,
              }}
            />
          </div>
        </div>
        <div className="inline-gain">
          <div>
            <label htmlFor="microphone-gain">Volume do microfone</label>
            <span>
              <NumberInput
                data-testid="microphone-gain-number"
                label="Ganho do microfone em decibéis"
                min={-60}
                max={12}
                value={controls.microphoneGainDb}
                onValueChange={onGain}
              />
              dB
            </span>
          </div>
          <Slider
            id="microphone-gain"
            data-testid="microphone-gain"
            label="Ganho do microfone"
            min={-60}
            max={12}
            step={1}
            value={[controls.microphoneGainDb]}
            onValueChange={(values) => onGain(values[0])}
          />
        </div>
      </section>
    </aside>
  );
}
