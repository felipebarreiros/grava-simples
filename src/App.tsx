import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { UserButton, useAuth } from "@clerk/react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  FileVideo,
  Flame,
  Folder,
  FolderOpen,
  ImagePlus,
  Info,
  Layers,
  LayoutGrid,
  LoaderCircle,
  Mic,
  MicOff,
  Monitor,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Smartphone,
  Square,
  Trash2,
  Video,
  X,
  ZoomIn,
} from "lucide-react";
import { loadObsEngine, type ObsEngine } from "../engine/obs-engine.js";
import { version } from "../package.json";
import { StudioSession } from "./media/StudioSession";
import { IconButton, Modal } from "./components/StudioUi";
import { Select } from "./components/Select";
import { ScenePreview } from "./components/ScenePreview";
import { SourceLibrary } from "./components/SourceLibrary";
import { SceneInspector } from "./components/SceneInspector";
import { LayerCanvasEditor } from "./components/LayerCanvasEditor";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { AlertDialog } from "./components/ui/alert-dialog";
import { ProjectContextMenu, ProjectDropdownMenu } from "./components/ProjectMenu";
import { Tooltip } from "./components/ui/tooltip";
import { Tabs, TabsContent } from "./components/ui/tabs";
import { ProjectBreadcrumbs } from "./components/ProjectBreadcrumbs";
import { MuteNotice } from "./components/MuteNotice";
import { GlobalSearch, type SearchResult } from "./components/GlobalSearch";
import { RecordingDetail } from "./components/RecordingDetail";
import { RecordingThumbnail } from "./components/RecordingThumbnail";
import { deleteCloudTranscription, hasCloudTranscription } from './recordings/cloudTranscription';
import {
  defaultSceneAppearance,
  normalizeSceneAppearance,
  getLayerFrame,
} from "./media/SceneCompositor";
import {
  saveSceneAsset,
  readSceneAsset,
  deleteSceneAssets,
} from "./projects/assets";
import {
  DEFAULT_PROJECT_SCENES,
  captureProjectCover,
  createProject,
  deleteProjectAndRecordings,
  getActiveProjectId,
  importLegacyRecordings,
  listProjectTakes,
  loadProjects,
  renameProjectTake,
  restoreProjectTake,
  saveProject,
  saveProjectTake,
  setActiveProjectId,
  deleteProjectTake,
  type Project,
  type ProjectScene,
  type ProjectTake,
} from "./projects/store";
import { normalizeProjectSources, type ProjectSource } from "./projects/sources";
import type {
  LayoutEngine,
  RecordingFile,
  RecordingResult,
  Resolution,
  SourceKind,
  StudioConfig,
  StudioControls,
  StudioEvent,
  StudioLayout,
  SceneAppearance,
  SceneLayer,
  Orientation,
  LayerFrame,
} from "./media/types";

declare global {
  interface Window {
    __recorderTest?: Record<string, unknown>;
  }
}
const diagnostic = new URLSearchParams(location.search).has("test");
const defaultControls: StudioControls = {
  sourceVisibility: { camera: true, screen: true },
  microphoneMuted: false,
  microphoneGainDb: 0,
  cameraZoom: 1.6,
};
const isScreen = (layout: StudioLayout) =>
  layout === "screen" || layout === "screen-3d";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const time = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
const bytes = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;
const date = (stamp: number) =>
  new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(
    stamp,
  );
const layouts: { value: StudioLayout; name: string; description: string }[] = [
  {
    value: "countdown",
    name: "Contagem regressiva",
    description: "Prepare o público para a sua estreia",
  },
  { value: "camera", name: "Principal", description: "Você em tela cheia" },
  {
    value: "camera-zoom",
    name: "Câmera com zoom",
    description: "Um enquadramento mais próximo",
  },
  {
    value: "screen",
    name: "Câmera + tela",
    description: "Sua tela com você no canto",
  },
  {
    value: "screen-3d",
    name: "Apresentação",
    description: "Você em destaque e a tela em perspectiva",
  },
];

const emptyProject: Project = {
  id: "",
  name: "",
  createdAt: 0,
  updatedAt: 0,
  scenes: DEFAULT_PROJECT_SCENES,
  selectedSceneId: "camera",
  settings: { resolution: "1080", fps: 30, source: "camera" },
};
function reopenProject(project: Project): Project {
  if (project.settings.source !== "media") return project;
  // A file picker grant lasts for this session; recording files remain durable.
  const camera =
    project.scenes.find((item) => !isScreen(item.layout)) ??
    DEFAULT_PROJECT_SCENES[0];
  return {
    ...project,
    scenes: project.scenes.some((item) => item.id === camera.id)
      ? project.scenes
      : [camera, ...project.scenes],
    selectedSceneId: camera.id,
    settings: { ...project.settings, source: "camera" },
  };
}
export default function App() {
  const { getToken, userId } = useAuth();
  const [{ hashProjectId, hashTakeId }] = useState(() => {
    const segments = location.hash.split("/");
    return { hashProjectId: segments[0] === "#project" ? segments[1] : "", hashTakeId: segments[0] === "#project" && segments[2] === "recording" ? segments[3] : "" };
  });
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [project, setProject] = useState<Project>(() => {
    const items = loadProjects();
    return reopenProject(
      items.find((item) => item.id === hashProjectId) ??
        items.find((item) => item.id === getActiveProjectId()) ??
        items[0] ??
        emptyProject,
    );
  });
  const [page, setPage] = useState<"projects" | "studio" | "recording">(
    hashTakeId ? "recording" : (diagnostic && projects.length > 0) ||
      projects.some((item) => item.id === hashProjectId)
      ? "studio"
      : "projects",
  );
  const [tab, setTab] = useState<"studio" | "recordings">("studio");
  const currentPage = useRef(page);
  currentPage.current = page;
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("grava-sidebar-collapsed") === "true",
  );
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [editorOrientation, setEditorOrientation] =
    useState<Orientation>("landscape");
  const [sourceLayerId, setSourceLayerId] = useState<string | null>(null);
  const [muteNotice, setMuteNotice] = useState(false);
  const muteSignal = useRef({ key: "", since: 0, lastNotice: 0 });
  const layerRestoreToken = useRef(0);
  const restoredLayerAssets = useRef(new Set<string>());
  const ownedLayerSources = useRef(new Set<string>());
  const autoAttempt = useRef("");
  const requestedScene = useRef("");
  const preparationLock = useRef(false);
  const appliedSceneKey = useRef("");
  const backgroundBusy = useRef(false);
  const coverTimes = useRef<Record<string, number>>({});
  const projectSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const [takes, setTakes] = useState<ProjectTake[]>(() => listProjectTakes());
  const [snapshot, setSnapshot] = useState<StudioEvent | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [engineLoadAttempt, setEngineLoadAttempt] = useState(0);
  const [engineLoadError, setEngineLoadError] = useState("");
  const [engineLoading, setEngineLoading] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [sourcePicker, setSourcePicker] = useState<
    "choose" | "camera" | "microphone" | null
  >(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraDraft, setCameraDraft] = useState("");
  const [mediaName, setMediaName] = useState("");
  const mediaInput = useRef<HTMLInputElement>(null);
  const [sceneEditor, setSceneEditor] = useState<ProjectScene | null>(null);
  const [projectEditor, setProjectEditor] = useState<{
    id?: string;
    name: string;
  } | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [activeTakeId, setActiveTakeId] = useState(hashTakeId);
  const openingTake = useRef(false);
  const restoredInitialTake = useRef(false);
  const recordingNavigation = useRef<() => void>(() => {});
  const [takeEditor, setTakeEditor] = useState<ProjectTake | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: "project"; project: Project } | { kind: "recording"; take: ProjectTake } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [downloadState, setDownloadState] = useState<
    Record<
      string,
      { busy?: boolean; label?: string; error?: string; file?: RecordingFile }
    >
  >({});
  const [testSource, setTestSource] = useState<SourceKind>(
    diagnostic ? "test" : "camera",
  );
  const landscape = useRef<HTMLCanvasElement>(null);
  const portrait = useRef<HTMLCanvasElement>(null);
  const session = useRef<StudioSession | null>(null);
  const engine = useRef<ObsEngine | null>(null);
  const calls = useRef(0);
  const currentProject = useRef(project);
  const recordingProject = useRef(project?.id);
  const lastResult = useRef("");
  const restoredUrls = useRef<string[]>([]);
  const exportUrls = useRef<string[]>([]);
  const exporting = Object.values(downloadState).some((item) => item.busy);
  currentProject.current = project;
  const scene =
    project?.scenes.find((item) => item.id === project.selectedSceneId) ??
    project?.scenes[0];
  const appearance = useMemo(
    () =>
      normalizeSceneAppearance(scene?.layout ?? "camera", scene?.appearance),
    [scene],
  );
  const settings = project?.settings ?? {
    resolution: "1080" as Resolution,
    fps: 30 as const,
    source: "camera" as SourceKind,
  };
  const state = snapshot?.state ?? "idle";
  const recording = state === "recording";
  const transitioning =
    working || state === "preparing" || state === "stopping";
  const busy = recording || transitioning;
  const preview = ["ready", "recording", "stopping", "complete"].includes(
    state,
  );
  const controls: StudioControls = {
    ...(snapshot?.controls ?? defaultControls),
    microphoneMuted: appearance.microphoneMuted,
    microphoneGainDb: appearance.microphoneGainDb,
  };
  const metrics = snapshot?.metrics;
  const projectSources = project.sources ?? [];
  const primaryCamera = projectSources.find(item => item.kind === "camera" && item.primary)
    ?? projectSources.find(item => item.kind === "camera");
  const primaryScreen = projectSources.find(item => item.kind === "screen" && item.primary)
    ?? projectSources.find(item => item.kind === "screen");
  const pickerLayer = appearance.layers.find(layer => layer.id === sourceLayerId);
  const compatibleSources = projectSources.filter(item =>
    sourcePicker === "camera" || pickerLayer?.kind === "camera" ? item.kind === "camera"
      : pickerLayer?.kind === "screen" ? item.kind !== "camera" : true,
  );
  const source = diagnostic
    ? testSource
    : settings.source === "test" || (settings.source === "media" && !mediaName)
      ? "camera"
      : settings.source;
  const config: StudioConfig = {
    ...settings,
    cameraDeviceId: primaryCamera?.deviceId,
    cameraSourceId: primaryCamera?.id,
    screenSourceId: primaryScreen?.id,
    microphoneDeviceId: appearance.microphoneDeviceId || undefined,
    source,
    layout: scene?.layout ?? "camera",
    zoom: scene?.zoom ?? 1.6,
    microphone:
      scene?.layout !== "countdown" ||
      metrics?.microphone?.live === true ||
      snapshot?.config?.microphone === true,
    appearance,
  };
  if (diagnostic && settings.resolution === "1080" && !snapshot)
    config.resolution = "360";
  const matches =
    snapshot?.config?.source === config.source &&
    snapshot.config.resolution === config.resolution &&
    snapshot.config.fps === config.fps &&
    snapshot.config.cameraDeviceId === config.cameraDeviceId &&
    snapshot.config.microphoneDeviceId === config.microphoneDeviceId &&
    snapshot.config.microphone === config.microphone;
  const projectTakes = takes.filter((item) => item.projectId === project?.id);
  const activeTake = takes.find((item) => item.id === activeTakeId);

  function refresh() {
    setProjects(loadProjects());
    setTakes(listProjectTakes());
  }
  function flushPendingProject() {
    if (!projectSaveTimer.current) return;
    clearTimeout(projectSaveTimer.current);
    projectSaveTimer.current = undefined;
    if (currentProject.current.id) {
      try {
        const saved = saveProject(currentProject.current);
        currentProject.current = saved;
        setProject(saved);
        setProjects(loadProjects());
      } catch (failure) {
        setError(message(failure));
      }
    }
  }
  function update(next: Project) {
    clearTimeout(projectSaveTimer.current);
    projectSaveTimer.current = undefined;
    try {
      const saved = saveProject(next);
      currentProject.current = saved;
      setProject(saved);
      setProjects(loadProjects());
    } catch (failure) {
      setError(message(failure));
    }
  }
  function changeSettings(patch: Partial<Project["settings"]>) {
    if (project)
      update({ ...project, settings: { ...project.settings, ...patch } });
  }
  function installSession(raw: ObsEngine) {
    const wrapped: LayoutEngine = {
      ...raw,
      layout(input) {
        calls.current++;
        return raw.layout(input);
      },
      audioGainDb: raw.audioGainDb.bind(raw),
      createCompressorNode: raw.createCompressorNode.bind(raw),
    };
    const studio = new StudioSession({
      engine: wrapped,
      onEvent(event) {
        setSnapshot(event);
        const activeId = currentProject.current.id;
        if (
          activeId &&
          ["ready", "recording", "complete"].includes(event.state) &&
          landscape.current &&
          (Date.now() - (coverTimes.current[activeId] ?? 0) > 30000 ||
            (event.state === "complete" &&
              event.result?.id !== lastResult.current))
        ) {
          coverTimes.current[activeId] = Date.now();
          try {
            const saved = captureProjectCover(activeId, landscape.current);
            setProject((current) =>
              current.id === activeId
                ? {
                    ...current,
                    cover: saved.cover,
                    coverUpdatedAt: saved.coverUpdatedAt,
                  }
                : current,
            );
            setProjects(loadProjects());
          } catch {
            /* Capture stays available if a cover cannot be cached. */
          }
        }
        if (event.result && event.result.id !== lastResult.current) {
          lastResult.current = event.result.id;
          setResult(event.result);
          setResultOpen(true);
          void saveProjectTake(recordingProject.current, event.result)
            .then(refresh)
            .catch((failure) =>
              setError(
                `O vídeo foi gravado, mas não entrou no projeto: ${message(failure)}`,
              ),
            );
        }
      },
    });
    studio.attachCanvases({
      landscape: landscape.current!,
      portrait: portrait.current!,
    });
    session.current = studio;
  }
  useEffect(() => {
    if (sourcePicker !== "camera") return;
    const layer = appearance.layers.find(item => item.id === sourceLayerId);
    const bound = project.sources?.find(item => item.id === layer?.sourceId);
    setCameraDraft(bound?.deviceId ?? "");
  }, [sourcePicker, sourceLayerId]);
  useEffect(() => {
    let cancelled = false;
    setEngineLoading(true);
    loadObsEngine()
      .then((raw) => {
        if (cancelled) return;
        engine.current = raw;
        if (currentPage.current !== "recording" && !openingTake.current) installSession(raw);
        setEngineLoadError("");
        setEngineReady(true);
      })
      .catch((failure) => {
        if (cancelled) return;
        console.error("Falha ao carregar o mecanismo do estúdio:", failure);
        setEngineLoadError(
          "Não conseguimos carregar o estúdio. Tente novamente ou atualize a página.",
        );
      })
      .finally(() => {
        if (!cancelled) setEngineLoading(false);
      });
    return () => { cancelled = true; };
  }, [engineLoadAttempt]);
  useEffect(() => {
    let cancelled = false;
    void importLegacyRecordings()
      .then(() => { if (!cancelled) refresh(); })
      .catch((failure) => { if (!cancelled) setError(message(failure)); });
    return () => {
      cancelled = true;
      const studio = session.current;
      session.current = null;
      layerRestoreToken.current++;
      void studio?.dispose();
      for (const url of [...restoredUrls.current, ...exportUrls.current])
        URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    setSelectedLayerId("");
  }, [project.id, scene.id]);
  useEffect(() => {
    setSelectedLayerId((current) =>
      appearance.layers.some((layer) => layer.id === current)
        ? current
        : "",
    );
  }, [appearance.layers.map((layer) => layer.id).join("|")]);
  useEffect(() => {
    if (!selectedLayerId) return;
    const clear = () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(
        ".layer-canvas-editor, .layer-properties-section",
      )) focused.blur();
      setSelectedLayerId("");
    };
    const outside = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      // Layer controls and their portaled menus remain part of the edit.
      if (event.target.closest(
        '.canvas-layer-box, .scene-inspector, .output-format-button, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]',
      )) return;
      clear();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], .layer-canvas-editor.is-dragging, .layer-row.dragging') ||
        (event.target instanceof Element && event.target.closest(
          'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="slider"]',
        ))) return;
      clear();
    };
    // Pointer-down avoids clearing selection when a drag finishes off-canvas.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [selectedLayerId]);
  useEffect(() => {
    const key = `${project.id}/${scene.id}`;
    const signal = muteSignal.current;
    if (signal.key !== key) {
      signal.key = key;
      signal.since = 0;
      signal.lastNotice = 0;
      setMuteNotice(false);
    }
    if (
      !appearance.microphoneMuted ||
      !metrics?.microphone?.live ||
      page !== "studio" ||
      tab !== "studio" ||
      document.hidden
    ) {
      signal.since = 0;
      if (!appearance.microphoneMuted) setMuteNotice(false);
      return;
    }
    const now = performance.now();
    if ((metrics.rawMicLevelDb ?? -100) > -38) {
      if (!signal.since) signal.since = now;
      if (
        now - signal.since > 1200 &&
        (!signal.lastNotice || now - signal.lastNotice > 30000)
      ) {
        signal.lastNotice = now;
        setMuteNotice(true);
      }
    } else signal.since = 0;
  }, [
    project.id,
    scene.id,
    appearance.microphoneMuted,
    metrics,
    metrics?.rawMicLevelDb,
    metrics?.microphone?.live,
    page,
    tab,
  ]);
  useEffect(() => {
    if (!engineReady || page !== "studio" || !project.id || transitioning || recording) return;
    const token = ++layerRestoreToken.current;
    const studio = session.current;
    void (async () => {
      for (const source of project.sources ?? []) {
          if (
            !source.assetId ||
            restoredLayerAssets.current.has(source.id)
          )
            continue;
          const blob = await readSceneAsset(source.assetId);
          if (token !== layerRestoreToken.current || studio !== session.current)
            return;
          if (blob) {
            await studio?.setLayerMediaSource(
              source.id,
              new File([blob], source.name, { type: blob.type }),
            );
            if (token !== layerRestoreToken.current || studio !== session.current)
              return;
            restoredLayerAssets.current.add(source.id);
            ownedLayerSources.current.add(source.id);
          }
      }
    })().catch((failure) => {
      if (token === layerRestoreToken.current && studio === session.current)
        setError(message(failure));
    });
    return () => {
      layerRestoreToken.current++;
    };
  }, [
    engineReady,
    page,
    transitioning,
    recording,
    project.id,
    project.sources?.map(source => `${source.id}:${source.assetId}`).join("|"),
    project.scenes
      .map((item) =>
        item.appearance?.layers
          .map((layer) => `${layer.sourceId}:${layer.assetId}`)
          .join(","),
      )
      .join("|"),
  ]);
  useEffect(() => {
    const flush = () => flushPendingProject();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);
  useEffect(() => {
    const used = new Set(
      [...(project.sources?.map(source => source.id) ?? []), ...project.scenes.flatMap(
        (item) =>
          item.appearance?.layers.flatMap((layer) =>
            layer.sourceId ? [layer.sourceId] : [],
          ) ?? [],
      )],
    );
    for (const key of ownedLayerSources.current)
      if (!used.has(key)) {
        session.current?.removeLayerSource(key);
        ownedLayerSources.current.delete(key);
        restoredLayerAssets.current.delete(key);
      }
  }, [
    project.id,
    project.sources?.map(source => source.id).join("|"),
    project.scenes
      .map((item) =>
        item.appearance?.layers.map((layer) => layer.sourceId).join(","),
      )
      .join("|"),
  ]);
  useEffect(() => {
    localStorage.setItem("grava-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (!engineReady || page !== "studio" || !scene) return;
    const sceneKey = `${project.id}/${scene.id}`;
    const changed = appliedSceneKey.current !== sceneKey;
    appliedSceneKey.current = sceneKey;
    session.current?.setLayout(scene.layout);
    session.current?.setSceneAppearance(appearance);
    session.current?.setCameraZoom(scene.zoom ?? 1.6);
    if (changed && scene.layout === "countdown")
      session.current?.resetCountdown();
  }, [engineReady, page, project.id, scene, appearance]);
  useEffect(() => {
    if (page !== "studio") return;
    let cancelled = false;
    const id = appearance.backgroundAssetId;
    void (async () => {
      const blob = id ? await readSceneAsset(id) : undefined;
      if (!cancelled) await session.current?.setSceneBackground(blob, id);
    })().catch((failure) => {
      if (!cancelled) setError(message(failure));
    });
    return () => {
      cancelled = true;
    };
  }, [page, project.id, scene?.id, appearance.backgroundAssetId, engineReady]);
  useEffect(() => {
    if (
      diagnostic ||
      !engineReady ||
      page !== "studio" ||
      tab !== "studio" ||
      preview ||
      busy ||
      !project.id ||
      autoAttempt.current === project.id
    )
      return;
    const id = project.id;
    autoAttempt.current = id;
    let cancelled = false;
    void (async () => {
      if (
        scene.layout === "countdown" &&
        !appearance.layers.some(
          (layer) =>
            layer.visible &&
            (layer.kind === "camera" || layer.kind === "screen"),
        )
      ) {
        if (!cancelled)
          await prepare({ ...config, source: "camera", microphone: false });
        return;
      }
      if (!navigator.permissions?.query) return;
      const camera = await navigator.permissions.query({
        name: "camera" as PermissionName,
      });
      if (
        camera.state !== "granted" ||
        cancelled ||
        currentProject.current.id !== id
      )
        return;
      const microphone = await navigator.permissions
        .query({ name: "microphone" as PermissionName })
        .catch(() => null);
      if (cancelled || currentProject.current.id !== id) return;
      // Reuse grants without opening an unsolicited screen picker or mic prompt.
      const target = isScreen(scene.layout) && requestedScene.current !== `${id}/${scene.id}`
        ? (project.scenes.find(
            (item) => item.layout === "camera" || item.layout === "camera-zoom",
          ) ?? {
            ...DEFAULT_PROJECT_SCENES[0],
            id: `camera-${crypto.randomUUID().slice(0, 8)}`,
          })
        : scene;
      const targetAppearance = normalizeSceneAppearance(
        target.layout,
        target.appearance,
      );
      const ok = await prepare({
        ...config,
        source: "camera",
        layout: target.layout,
        appearance: targetAppearance,
        microphone: microphone?.state === "granted",
      });
      if (
        ok &&
        !cancelled &&
        (target.id !== scene.id ||
          currentProject.current.settings.source !== "camera")
      )
        update({
          ...currentProject.current,
          selectedSceneId: target.id,
          scenes: currentProject.current.scenes.some(
            (item) => item.id === target.id,
          )
            ? currentProject.current.scenes
            : [...currentProject.current.scenes, target],
          settings: { ...currentProject.current.settings, source: "camera" },
        });
    })().catch(() => {
      /* Permission-denied/unsupported browsers retain the explicit start action. */
    });
    return () => {
      cancelled = true;
    };
  }, [engineReady, page, tab, project.id]);
  function changeAppearance(next: SceneAppearance) {
    if (transitioning) return;
    const owner = currentProject.current;
    const changed = normalizeProjectSources({
      ...owner,
      scenes: owner.scenes.map((item) =>
        item.id === scene.id ? { ...item, appearance: next } : item,
      ),
    });
    const visual = changed.scenes.find(item => item.id === scene.id)?.appearance;
    if (visual) session.current?.setSceneAppearance(visual);
    currentProject.current = changed;
    setProject(changed);
    setProjects((items) =>
      items.map((item) => (item.id === changed.id ? changed : item)),
    );
    clearTimeout(projectSaveTimer.current);
    projectSaveTimer.current = setTimeout(flushPendingProject, 180);
  }
  async function setBackground(file?: File) {
    if (busy || backgroundBusy.current) return;
    flushPendingProject();
    const projectId = project.id,
      sceneId = scene.id,
      studio = session.current;
    backgroundBusy.current = true;
    setWorking(true);
    setError("");
    try {
      if (file) {
        if (file.size > 25 * 1024 * 1024)
          throw new Error("Escolha uma imagem de até 25 MB.");
        const decoded = await createImageBitmap(file);
        decoded.close();
      }
      const assetId = file
        ? await saveSceneAsset(projectId, sceneId, file)
        : undefined;
      const latest = loadProjects().find((item) => item.id === projectId);
      const target = latest?.scenes.find((item) => item.id === sceneId);
      if (!latest || !target) {
        await deleteSceneAssets(projectId, sceneId);
        return;
      }
      const nextAppearance = {
        ...normalizeSceneAppearance(target.layout, target.appearance),
        backgroundAssetId: assetId,
      };
      const saved = saveProject({
        ...latest,
        scenes: latest.scenes.map((item) =>
          item.id === sceneId ? { ...item, appearance: nextAppearance } : item,
        ),
      });
      if (currentProject.current.id === projectId) {
        currentProject.current = saved;
        setProject(saved);
      }
      setProjects(loadProjects());
      if (
        currentProject.current.id === projectId &&
        currentProject.current.selectedSceneId === sceneId &&
        session.current === studio
      ) {
        studio?.setSceneAppearance(nextAppearance);
        await studio?.setSceneBackground(file, assetId);
      }
      await deleteSceneAssets(projectId, sceneId);
    } catch (failure) {
      setError(message(failure));
      void deleteSceneAssets(projectId, sceneId).catch(() => {});
    } finally {
      backgroundBusy.current = false;
      setWorking(false);
    }
  }
  function addLayer(kind: SceneLayer["kind"]) {
    const names = {
      background: "Fundo",
      camera: "Câmera",
      screen: "Tela ou mídia",
      title: "Nome do produto",
      timer: "Contagem regressiva",
    };
    const layers = [...appearance.layers];
    const next = {
      id: `${kind}-${crypto.randomUUID().slice(0, 8)}`,
      kind,
      name: `${names[kind]}${appearance.layers.some((layer) => layer.kind === kind) ? ` ${appearance.layers.filter((layer) => layer.kind === kind).length + 1}` : ""}`,
      visible: true,
      ...(kind === "title"
        ? {
            text: "Seu texto aqui",
            fontSize: 64,
            color: "#f5f3ef",
            align: "center" as const,
          }
        : {}),
    };
    const firstText = layers.findIndex(
      (layer) => layer.kind === "title" || layer.kind === "timer",
    );
    if (kind === "background") layers.unshift(next);
    else if (firstText >= 0 && (kind === "camera" || kind === "screen"))
      layers.splice(firstText, 0, next);
    else layers.push(next);
    changeAppearance({ ...appearance, layers });
    setSelectedLayerId(next.id);
    if (kind === "camera" || kind === "screen") {
      setSourceLayerId(next.id);
      setSourcePicker(kind === "camera" ? "camera" : "choose");
    }
  }
  async function closeProjectSession() {
    const studio = session.current;
    session.current = null;
    layerRestoreToken.current++;
    autoAttempt.current = "";
    preparationLock.current = false;
    appliedSceneKey.current = "";
    restoredLayerAssets.current.clear();
    ownedLayerSources.current.clear();
    requestedScene.current = "";
    setSnapshot(null);
    setResult(null);
    setResultOpen(false);
    setActiveTakeId("");
    setMediaName("");
    setSourcePicker(null);
    setMuteNotice(false);
    lastResult.current = "";
    for (const url of [...restoredUrls.current, ...exportUrls.current]) URL.revokeObjectURL(url);
    restoredUrls.current = [];
    exportUrls.current = [];
    await studio?.dispose();
  }
  async function openProject(item: Project, selectedSceneId?: string) {
    if (busy) return;
    flushPendingProject();
    item = loadProjects().find((project) => project.id === item.id) ?? item;
    if (project?.id !== item.id || page !== "studio" || !session.current) {
      item = reopenProject(item);
      if (selectedSceneId && item.scenes.some((scene) => scene.id === selectedSceneId))
        item = { ...item, selectedSceneId };
      setWorking(true);
      try {
        await closeProjectSession();
        requestedScene.current = selectedSceneId ? `${item.id}/${selectedSceneId}` : "";
        if (engine.current) installSession(engine.current);
        currentProject.current = item;
        setProject(item);
        setActiveProjectId(item.id);
        setTestSource(diagnostic ? "test" : "camera");
      } catch (failure) {
        setError(message(failure));
      } finally {
        setWorking(false);
      }
    }
    setPage("studio");
    setTab("studio");
    setSidebarOpen(false);
    setError("");
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#project/${item.id}`,
    );
  }
  async function allProjects() {
    if (busy) return;
    flushPendingProject();
    if (preview && project.id && landscape.current) {
      try {
        const saved = captureProjectCover(project.id, landscape.current);
        setProject((current) => ({
          ...current,
          cover: saved.cover,
          coverUpdatedAt: saved.coverUpdatedAt,
        }));
        setProjects(loadProjects());
      } catch {
        /* A cached cover is optional. */
      }
    }
    setWorking(true);
    try {
      await closeProjectSession();
      setPage("projects");
      setSidebarOpen(false);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setWorking(false);
    }
  }
  async function prepare(next = config): Promise<boolean> {
    if (!session.current || busy || preparationLock.current) return false;
    const studio = session.current;
    preparationLock.current = true;
    setWorking(true);
    setError("");
    try {
      await studio.prepare(next);
      if (studio !== session.current) return false;
      studio.setCameraZoom(next.zoom ?? 1.6);
      studio.setSceneAppearance(next.appearance ?? appearance);
      const available = await studio.getAvailableDevices();
      if (studio !== session.current) return false;
      setDevices(available);
      return true;
    } catch (failure) {
      if (studio === session.current) setError(message(failure));
      return false;
    } finally {
      if (studio === session.current) {
        preparationLock.current = false;
        setWorking(false);
      }
    }
  }
  async function start() {
    if (!session.current || busy || !project) return;
    setWorking(true);
    setError("");
    recordingProject.current = project.id;
    try {
      await session.current.start();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setWorking(false);
    }
  }
  async function stop() {
    try {
      return await session.current!.stop();
    } catch (failure) {
      setError(message(failure));
      throw failure;
    }
  }
  async function recordAction() {
    flushPendingProject();
    if (recording) {
      await stop().catch(() => {});
      return;
    }
    const missing = appearance.layers.find(layer => {
      if (!layer.visible || (layer.kind !== "screen" && layer.kind !== "camera")) return false;
      // Preparation can acquire the primary camera; additional sources need an explicit connection.
      if (layer.kind === "camera" && layer.sourceId === primaryCamera?.id) return false;
      return !(session.current?.hasLayerSource(layer.sourceId ?? layer.id)
        || (!layer.sourceId && !layer.assetId && metrics?.sources?.[layer.kind].live));
    });
    if (missing) {
      setSelectedLayerId(missing.id);
      setSourceLayerId(missing.id);
      setSourcePicker(missing.kind === "camera" ? "camera" : "choose");
      return;
    }
    const missingPrimaryCamera = appearance.layers.some(layer => layer.visible && layer.kind === "camera"
      && layer.sourceId === primaryCamera?.id
      && !session.current?.hasLayerSource(layer.sourceId ?? layer.id));
    if (!preview || !matches || missingPrimaryCamera) {
      if (
        !(await prepare({
          ...config,
          source: diagnostic ? testSource : "camera",
        }))
      )
        return;
    }
    await start();
  }
  function targetVisualLayer(
    requested: string | null,
    alwaysNew = false,
    kind: "camera" | "screen" = "screen",
  ): SceneLayer {
    const current = currentProject.current.scenes.find(item => item.id === scene.id) ?? scene;
    const visual = normalizeSceneAppearance(current.layout, current.appearance);
    return (requested ? visual.layers.find(layer => layer.id === requested && layer.kind === kind)
      : !alwaysNew ? visual.layers.find(layer => layer.kind === kind && layer.id === kind)
        ?? visual.layers.find(layer => layer.kind === kind) : undefined) ?? {
      id: `${kind}-${crypto.randomUUID().slice(0, 8)}`,
      kind, name: kind === "camera" ? "Câmera" : "Tela ou mídia",
      visible: true, fit: kind === "camera" ? "cover" : "contain",
    };
  }
  function saveLayerBinding(
    layer: SceneLayer,
    sourceId: string,
    assetId?: string,
    name?: string,
    definition?: ProjectSource,
  ) {
    const owner = currentProject.current;
    const current = owner.scenes.find(item => item.id === scene.id);
    if (!current) return false;
    const visual = normalizeSceneAppearance(current.layout, current.appearance);
    const existing = owner.sources?.find(item => item.id === sourceId);
    const source: ProjectSource = definition ?? {
      ...existing, id: sourceId,
      kind: layer.kind === "camera" ? "camera" : assetId ? "media" : "screen",
      name: existing?.name ?? name ?? (layer.kind === "camera" ? "Câmera" : "Tela compartilhada"),
      assetId,
    };
    const bound = {
      ...layer, sourceId, assetId: source.assetId, visible: true,
      name: name && /^(Tela|Mídia|Imagem)/.test(layer.name) ? name : layer.name,
    };
    const layers = visual.layers.some(item => item.id === layer.id)
      ? visual.layers.map(item => item.id === layer.id ? bound : item) : [...visual.layers, bound];
    update({
      ...owner,
      sources: existing ? owner.sources!.map(item => item.id === sourceId ? source : item)
        : [...(owner.sources ?? []), source],
      scenes: owner.scenes.map(item => item.id === current.id ? { ...item, appearance: { ...visual, layers } } : item),
    });
    const saved = currentProject.current.scenes.find(item => item.id === current.id)?.appearance;
    if (!saved?.layers.some(item => item.id === layer.id && item.sourceId === sourceId)) return false;
    session.current?.setSceneAppearance(saved);
    setSelectedLayerId(layer.id);
    return true;
  }
  async function attachProjectSource(source: ProjectSource, layer: SceneLayer) {
    const studio = session.current;
    if (!studio || busy) return;
    const ownerId = currentProject.current.id, sceneId = scene.id;
    const alreadyConnected = studio.hasLayerSource(source.id);
    setWorking(true);
    setError("");
    try {
      if (!alreadyConnected) {
        if (source.kind === "screen") await studio.captureLayerScreen(source.id);
        else if (source.kind === "camera") await studio.captureLayerCamera(source.id, source.deviceId);
        else {
          const blob = source.assetId ? await readSceneAsset(source.assetId) : undefined;
          if (!blob) throw new Error("Este arquivo não está mais disponível. Escolha o arquivo novamente.");
          await studio.setLayerMediaSource(source.id, new File([blob], source.name, { type: blob.type }));
        }
      }
      if (studio !== session.current || currentProject.current.id !== ownerId
        || currentProject.current.selectedSceneId !== sceneId) {
        if (!alreadyConnected) studio.removeLayerSource(source.id);
        return;
      }
      ownedLayerSources.current.add(source.id);
      if (!saveLayerBinding(layer, source.id, source.assetId, undefined, source)) {
        if (!alreadyConnected) studio.removeLayerSource(source.id);
        return;
      }
      if (source.kind === "camera") setDevices(await studio.getAvailableDevices());
      setSourcePicker(null);
      setSourceLayerId(null);
    } catch (failure) {
      if (studio === session.current) setError(message(failure));
      return;
    } finally {
      if (studio === session.current) setWorking(false);
    }
    if (!preview && studio === session.current)
      await prepare({
        ...config, source: diagnostic ? testSource : "camera",
        appearance: normalizeSceneAppearance(scene.layout,
          currentProject.current.scenes.find(item => item.id === sceneId)?.appearance),
      });
  }
  async function useProjectSource(source: ProjectSource) {
    const layer = targetVisualLayer(sourceLayerId, !sourceLayerId,
      source.kind === "camera" ? "camera" : "screen");
    await attachProjectSource(source, layer);
  }
  async function connect(next: SourceKind, deviceId?: string, requested = sourceLayerId) {
    if (!session.current || busy || (next !== "screen" && next !== "camera")) return;
    const kind = next;
    const layer = targetVisualLayer(requested, kind === "screen" && !requested, kind);
    const current = currentProject.current.sources?.find(item => item.id === layer.sourceId && item.kind === kind);
    // Reconnect an offline source in place; another live capture is a distinct source.
    const reuse = current && !session.current.hasLayerSource(current.id) ? current : undefined;
    const source: ProjectSource = {
      ...reuse,
      id: reuse?.id ?? `source-${crypto.randomUUID()}`,
      kind,
      name: reuse?.name ?? `${kind === "camera" ? "Câmera" : "Tela"} ${(currentProject.current.sources?.filter(item => item.kind === kind).length ?? 0) + 1}`,
      ...(kind === "camera" ? { deviceId: deviceId ?? current?.deviceId ?? undefined } : {}),
    };
    await attachProjectSource(source, layer);
  }
  async function activateSceneSource() {
    const kind = isScreen(scene.layout) ? "screen" : "camera";
    const layer = targetVisualLayer(null, false, kind);
    const bound = currentProject.current.sources?.find(source => source.id === layer.sourceId);
    if (bound) await attachProjectSource(bound, layer);
    else await connect(kind, undefined, layer.id);
  }
  async function connectMicrophone() {
    if (!session.current || busy) return;
    setWorking(true);
    setError("");
    try {
      if (preview)
        await session.current.replaceMicrophone(appearance.microphoneDeviceId);
      else {
        setWorking(false);
        if (!(await prepare({ ...config, microphone: true }))) return;
      }
      setSourcePicker(null);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setWorking(false);
    }
  }
  async function chooseScene(id: string) {
    if (transitioning) return false;
    const next = currentProject.current.scenes.find((item) => item.id === id);
    if (!next) return false;
    const visual = normalizeSceneAppearance(next.layout, next.appearance);
    setError("");
    const currentConfig = session.current?.getSnapshot().config;
    const usesLegacyCamera = visual.layers.some(layer => layer.visible && layer.kind === "camera" && !layer.sourceId);
    const deviceChange =
      !!currentConfig &&
      ((usesLegacyCamera && (currentConfig.cameraDeviceId ?? "") !== (visual.cameraDeviceId ?? "")) ||
        (currentConfig.microphoneDeviceId ?? "") !==
          (visual.microphoneDeviceId ?? ""));
    if (recording && deviceChange) {
      setError(
        "Para trocar os dispositivos desta cena, pare a gravação e conecte a câmera e o microfone.",
      );
      return false;
    }
    if (preview && deviceChange && session.current) {
      setWorking(true);
      let cameraChanged = false,
        microphoneChanged = false;
      try {
        if (
          usesLegacyCamera && (currentConfig?.cameraDeviceId ?? "") !==
          (visual.cameraDeviceId ?? "")
        ) {
          await session.current.replaceCamera(visual.cameraDeviceId);
          cameraChanged = true;
        }
        if (
          (currentConfig?.microphoneDeviceId ?? "") !==
          (visual.microphoneDeviceId ?? "")
        ) {
          await session.current.replaceMicrophone(visual.microphoneDeviceId);
          microphoneChanged = true;
        }
      } catch (failure) {
        if (cameraChanged)
          await session.current
            .replaceCamera(currentConfig?.cameraDeviceId)
            .catch(() => {});
        if (microphoneChanged)
          await session.current
            .replaceMicrophone(currentConfig?.microphoneDeviceId)
            .catch(() => {});
        setError(message(failure));
        return false;
      } finally {
        setWorking(false);
      }
    }
    if (
      preview &&
      visual.layers.some(
        (layer) =>
          layer.visible &&
          layer.kind === "camera" &&
          (!layer.sourceId || layer.sourceId === primaryCamera?.id) &&
          !session.current?.hasLayerSource(layer.sourceId ?? layer.id) &&
          !layer.assetId,
      )
    ) {
      if (recording) {
        setError("Conecte a câmera desta cena antes de começar a gravação.");
        return false;
      }
      if (
        !(await prepare({
          ...config,
          source: diagnostic ? testSource : "camera",
          layout: next.layout,
          appearance: visual,
          cameraDeviceId: visual.cameraDeviceId,
          microphoneDeviceId: visual.microphoneDeviceId,
          microphone: true,
        }))
      )
        return false;
    }
    if (
      !preview &&
      next.layout === "countdown" &&
      !visual.layers.some((layer) => layer.visible && layer.kind === "camera")
    ) {
      if (
        !(await prepare({
          ...config,
          source: diagnostic ? testSource : "camera",
          layout: next.layout,
          appearance: visual,
          microphone: false,
        }))
      )
        return false;
    } else {
      session.current?.setLayout(next.layout);
      session.current?.setSceneAppearance(visual);
      session.current?.setCameraZoom(next.zoom ?? 1.6);
    }
    update({ ...currentProject.current, selectedSceneId: id });
    setMuteNotice(false);
    return true;
  }
  async function addMedia(file: File) {
    if (!session.current || busy) return;
    const ownerId = project.id,
      sceneId = scene.id,
      studio = session.current;
    const layer = targetVisualLayer(sourceLayerId, true),
      sourceId = `source-${crypto.randomUUID()}`;
    setWorking(true);
    setError("");
    try {
      await studio.setLayerMediaSource(sourceId, file);
      const assetId = await saveSceneAsset(ownerId, sceneId, file);
      if (
        currentProject.current.id !== ownerId ||
        currentProject.current.selectedSceneId !== sceneId
      ) {
        studio.removeLayerSource(sourceId);
        return;
      }
      restoredLayerAssets.current.add(sourceId);
      ownedLayerSources.current.add(sourceId);
      saveLayerBinding(layer, sourceId, assetId, file.name);
      setSourcePicker(null);
      setSourceLayerId(null);
      await deleteSceneAssets(ownerId, sceneId);
    } catch (failure) {
      setError(message(failure));
      studio.removeLayerSource(sourceId);
    } finally {
      setWorking(false);
    }
    if (!preview)
      await prepare({
        ...config,
        source: diagnostic ? testSource : "camera",
        appearance: normalizeSceneAppearance(
          scene.layout,
          currentProject.current.scenes.find((item) => item.id === sceneId)
            ?.appearance,
        ),
      });
  }
  function zoom(value: number) {
    if (transitioning) return;
    session.current?.setCameraZoom(value);
    update({
      ...project,
      scenes: project.scenes.map((item) =>
        item.id === scene.id ? { ...item, zoom: value } : item,
      ),
    });
  }
  function setControl(patch: Partial<StudioControls>) {
    changeAppearance({
      ...appearance,
      ...(patch.microphoneMuted !== undefined
        ? { microphoneMuted: patch.microphoneMuted }
        : {}),
      ...(patch.microphoneGainDb !== undefined
        ? { microphoneGainDb: patch.microphoneGainDb }
        : {}),
    });
  }
  async function mute() {
    if (!metrics?.microphone?.live && preview && !busy) {
      if (await prepare({ ...config, microphone: true }))
        changeAppearance({ ...appearance, microphoneMuted: false });
      return;
    }
    setControl({ microphoneMuted: !appearance.microphoneMuted });
  }
  function updateLayer(id: string, patch: Partial<SceneLayer>) {
    const current = currentProject.current.scenes.find(
      (item) => item.id === scene.id,
    );
    if (!current) return;
    const visual = normalizeSceneAppearance(current.layout, current.appearance);
    changeAppearance({
      ...visual,
      layers: visual.layers.map((layer) =>
        layer.id === id
          ? {
              ...layer,
              ...patch,
              ...(patch.frames ? { frames: patch.frames } : {}),
            }
          : layer,
      ),
    });
  }
  function removeLayer(id: string) {
    const removed = appearance.layers.find((layer) => layer.id === id);
    changeAppearance({
      ...appearance,
      layers: appearance.layers.filter((layer) => layer.id !== id),
    });
    if (
      removed?.sourceId &&
      !currentProject.current.sources?.some(source => source.id === removed.sourceId) &&
      !currentProject.current.scenes.some((item) =>
        item.appearance?.layers.some(
          (layer) => layer.sourceId === removed.sourceId,
        ),
      )
    )
      session.current?.removeLayerSource(removed.sourceId);
    flushPendingProject();
    void deleteSceneAssets(project.id, scene.id).catch(() => {});
  }
  function duplicateLayer(id: string) {
    const original = appearance.layers.find((layer) => layer.id === id);
    if (!original) return;
    const clone = {
      ...structuredClone(original),
      id: `${original.kind}-${crypto.randomUUID().slice(0, 8)}`,
      name: `${original.name} (cópia)`,
    };
    const frame = getLayerFrame(original, {
      layout: scene.layout,
      appearance,
      orientation: editorOrientation,
    });
    clone.frames = {
      ...clone.frames,
      [editorOrientation]: { ...frame, x: frame.x + 0.025, y: frame.y + 0.025 },
    };
    changeAppearance({ ...appearance, layers: [...appearance.layers, clone] });
    setSelectedLayerId(clone.id);
  }
  function replaceLayerSource(id: string) {
    const layer = appearance.layers.find((item) => item.id === id);
    if (!layer) return;
    setSelectedLayerId(id);
    setSourceLayerId(id);
    setSourcePicker(layer.kind === "camera" ? "camera" : "choose");
  }
  function dismissMuteNotice() {
    setMuteNotice(false);
    muteSignal.current.lastNotice = performance.now();
  }

  function openSearch() {
    setSearchOpen(true);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.repeat
      )
        return;
      if (!searchOpen && document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]'))
        return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [searchOpen]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        page !== "studio" ||
        tab !== "studio" ||
        settingsOpen ||
        sourcePicker ||
        sceneEditor ||
        resultOpen ||
        projectEditor ||
        deleteTarget ||
        searchOpen ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target as HTMLElement)?.closest(
          "input,select,textarea,[contenteditable],[role=combobox],[role=listbox],[role=option],[role=slider],[role=menu]",
        )
      )
        return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < 9 && project?.scenes[index]) {
        event.preventDefault();
        void chooseScene(project.scenes[index].id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    window.__recorderTest = {
      ready: engineReady,
      status: state,
      config: snapshot?.config,
      controls,
      countdown: snapshot?.countdown,
      thumbnailMode: "static",
      selectedLayerId,
      editorOrientation,
      engine: {
        backend: engine.current?.backend ?? "loading",
        layoutCalls: calls.current,
        audioNodes: engine.current?.stats.audioNodes ?? 0,
        audioBlocks: engine.current?.stats.audioBlocks ?? 0,
      },
      outputs: [
        {
          name: "landscape",
          width: landscape.current?.width,
          height: landscape.current?.height,
          fps: config.fps,
        },
        {
          name: "portrait",
          width: portrait.current?.width,
          height: portrait.current?.height,
          fps: config.fps,
        },
      ],
      metrics: {
        ...metrics,
        frameCount: metrics?.frames,
        elapsedMs: metrics?.elapsedMs ?? 0,
      },
      error: engineLoadError || error || snapshot?.error,
      prepare: (next?: StudioConfig) =>
        session.current!.prepare(next ?? config),
      start,
      stop,
      setScene: (next: string) =>
        chooseScene(
          project.scenes.find(
            (item) =>
              item.layout === (next === "screen-camera" ? "screen" : next),
          )?.id ?? scene.id,
        ),
      computeLayout: (input: Parameters<ObsEngine["layout"]>[0]) =>
        engine.current!.layout(input),
      result,
      project,
      projects,
      takes,
      version,
    };
  });

  async function saveProjectForm(event: FormEvent) {
    event.preventDefault();
    if (!projectEditor?.name.trim() || busy) return;
    try {
      if (projectEditor.id) {
        const item = projects.find((item) => item.id === projectEditor.id)!;
        const saved = saveProject({ ...item, name: projectEditor.name });
        if (item.id === project?.id) {
          setProject(saved);
          currentProject.current = saved;
        }
        refresh();
      } else {
        const item = createProject(projectEditor.name);
        refresh();
        await openProject(item);
      }
      setProjectEditor(null);
    } catch (failure) {
      setError(message(failure));
    }
  }
  async function confirmDelete() {
    if (!deleteTarget || deleting || busy) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === "project") {
        const id = deleteTarget.project.id;
        for (const take of listProjectTakes(id)) {
          if (userId && hasCloudTranscription(userId, take.id)) await deleteCloudTranscription(take.id, getToken, undefined, userId);
        }
        await closeProjectSession();
        await deleteProjectAndRecordings(id);
        const items = loadProjects();
        if (id === project?.id) {
          setProject(items[0] ?? emptyProject);
          currentProject.current = items[0] ?? emptyProject;
        }
        setProjectEditor(null);
        setPage("projects");
        history.replaceState(null, "", `${location.pathname}${location.search}`);
      } else {
        if (userId && hasCloudTranscription(userId, deleteTarget.take.id)) await deleteCloudTranscription(deleteTarget.take.id, getToken, undefined, userId);
        await deleteProjectTake(deleteTarget.take.id);
        setTakeEditor(null);
        if (deleteTarget.take.id === activeTakeId) await closeRecording();
      }
      refresh();
      setDeleteTarget(null);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setDeleting(false);
    }
  }
  async function saveScene(event: FormEvent) {
    event.preventDefault();
    if (!sceneEditor?.name.trim() || busy) return;
    const existing = project.scenes.some((item) => item.id === sceneEditor.id);
    const next = {
      ...sceneEditor,
      name: sceneEditor.name.trim(),
      appearance: normalizeSceneAppearance(
        sceneEditor.layout,
        sceneEditor.appearance,
      ),
    };
    if (
      next.id === scene.id &&
      preview &&
      next.appearance.layers.some(
        (layer) => layer.kind === "camera" && layer.visible,
      ) &&
      !metrics?.sources?.camera.live &&
      !isScreen(next.layout)
    ) {
      if (
        !(await prepare({
          ...config,
          source: diagnostic ? testSource : "camera",
          layout: next.layout,
          appearance: next.appearance,
          microphone: next.layout !== "countdown",
        }))
      )
        return;
    }
    if (
      next.id === scene.id &&
      isScreen(next.layout) &&
      preview &&
      !metrics?.sources?.screen.live
    ) {
      if (
        !(await prepare({
          ...config,
          source: diagnostic ? testSource : "screen",
          layout: next.layout,
          appearance: next.appearance,
        }))
      )
        return;
    }
    if (next.id === scene.id) {
      session.current?.setLayout(next.layout);
      session.current?.setSceneAppearance(next.appearance);
      session.current?.setCameraZoom(next.zoom ?? 1.6);
    }
    if (
      !existing &&
      next.layout === "countdown" &&
      !preview &&
      !(await prepare({
        ...config,
        layout: "countdown",
        source: "camera",
        appearance: next.appearance,
        microphone: false,
      }))
    )
      return;
    update({
      ...project,
      selectedSceneId: existing ? project.selectedSceneId : next.id,
      scenes: existing
        ? project.scenes.map((item) => (item.id === next.id ? next : item))
        : [...project.scenes, next],
      settings:
        next.id === scene.id && isScreen(next.layout)
          ? {
              ...settings,
              source:
                session.current?.getSnapshot().config?.source ??
                (mediaName ? "media" : "screen"),
            }
          : !existing && isScreen(next.layout) && !metrics?.sources?.screen.live
            ? { ...settings, source: "screen" }
            : settings,
    });
    setSceneEditor(null);
  }
  async function removeScene() {
    if (!sceneEditor || busy || project.scenes.length <= 1) return;
    const remaining = project.scenes.filter(
      (item) => item.id !== sceneEditor.id,
    );
    if (scene.id === sceneEditor.id && !(await chooseScene(remaining[0].id)))
      return;
    update({ ...currentProject.current, scenes: remaining });
    void deleteSceneAssets(project.id, sceneEditor.id).catch(() => {});
    setSceneEditor(null);
  }
  async function openTake(take: ProjectTake, replace = false) {
    if (busy || exporting || openingTake.current) return;
    openingTake.current = true;
    currentPage.current = "recording";
    setPage("recording");
    setWorking(true);
    setError("");
    try {
      flushPendingProject();
      const owner = loadProjects().find((item) => item.id === take.projectId);
      if (!owner) throw new Error("O projeto desta gravação não está mais disponível.");
      await closeProjectSession();
      setDownloadState({});
      const restored = await restoreProjectTake(take);
      restoredUrls.current = [restored.landscape.url, restored.portrait.url];
      currentProject.current = owner;
      setProject(owner);
      setTakes(listProjectTakes());
      setActiveProjectId(owner.id);
      setResult(restored);
      setActiveTakeId(take.id);
      setResultOpen(false);
      setPage("recording");
      setTab("recordings");
      setSidebarOpen(false);
      const destination = `${location.pathname}${location.search}#project/${owner.id}/recording/${take.id}`;
      if (replace) history.replaceState(null, "", destination);
      else if (`${location.pathname}${location.search}${location.hash}` !== destination) history.pushState(null, "", destination);
    } catch (failure) {
      setError(`Não foi possível abrir a gravação: ${message(failure)}`);
      setPage("studio");
      setTab("recordings");
      history.replaceState(null, "", `${location.pathname}${location.search}#project/${currentProject.current.id}`);
      if (engine.current && !session.current) installSession(engine.current);
    } finally {
      openingTake.current = false;
      setWorking(false);
    }
  }
  async function closeRecording() {
    if (exporting || openingTake.current) return;
    await openProject(currentProject.current);
    setTab("recordings");
  }
  useEffect(() => {
    if (restoredInitialTake.current) return;
    restoredInitialTake.current = true;
    if (!hashTakeId) return;
    const take = listProjectTakes().find((item) => item.id === hashTakeId && item.projectId === hashProjectId);
    if (take) void openTake(take, true);
    else {
      setError("Esta gravação não está disponível neste navegador.");
      setPage("studio");
      setTab("recordings");
      history.replaceState(null, "", `${location.pathname}${location.search}#project/${project.id}`);
    }
  }, []);
  recordingNavigation.current = () => {
    const segments = location.hash.split("/");
    if (segments[0] === "#project" && segments[2] === "recording" && segments[3]) {
      if (page === "recording" && activeTakeId === segments[3]) return;
      const take = listProjectTakes().find((item) => item.id === segments[3] && item.projectId === segments[1]);
      if (take) void openTake(take, true);
      else {
        const owner = loadProjects().find((item) => item.id === segments[1]);
        if (owner) void openProject(owner).then(() => {
          setTab("recordings");
          setError("Esta gravação não está disponível neste navegador.");
        });
        else void allProjects();
      }
    } else if (page === "recording") {
      const owner = loadProjects().find((item) => item.id === segments[1]);
      if (owner) void openProject(owner).then(() => setTab("recordings"));
      else void allProjects();
    }
  };
  useEffect(() => {
    const navigateRecording = () => recordingNavigation.current();
    window.addEventListener("popstate", navigateRecording);
    return () => {
      window.removeEventListener("popstate", navigateRecording);
    };
  }, []);
  async function compatible(file: RecordingFile) {
    const key = `${result!.id}-${file.orientation}`;
    if (downloadState[key]?.busy) return;
    setDownloadState((current) => ({
      ...current,
      [key]: { busy: true, label: "Preparando…" },
    }));
    try {
      const { prepareCompatibleDownload } =
        await import("./media/compatibleExport");
      const converted = await prepareCompatibleDownload(file, (progress) =>
        setDownloadState((current) => ({
          ...current,
          [key]: {
            busy: true,
            label:
              progress.phase === "loading"
                ? "Preparando exportação…"
                : `Preparando vídeo${progress.progress === undefined ? "…" : ` · ${Math.round(progress.progress * 100)}%`}`,
          },
        })),
      );
      exportUrls.current.push(converted.url);
      setDownloadState((current) => ({
        ...current,
        [key]: { file: converted },
      }));
      const anchor = document.createElement("a");
      anchor.href = converted.url;
      anchor.download = converted.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (failure) {
      setDownloadState((current) => ({
        ...current,
        [key]: { error: message(failure) },
      }));
    }
  }
  async function selectSearchResult(result: SearchResult) {
    if (busy || exporting) return;
    setSearchOpen(false);
    if (result.type === "recording") {
      await openTake(result.take);
      return;
    }
    if (result.type === "scene") {
      if (
        result.project.id === currentProject.current.id &&
        page === "studio" &&
        session.current
      ) {
        if (await chooseScene(result.scene.id))
          await openProject(currentProject.current);
      } else {
        flushPendingProject();
        try {
          const target = saveProject({
            ...result.project,
            selectedSceneId: result.scene.id,
          });
          refresh();
          await openProject(target, result.scene.id);
        } catch (failure) {
          setError(message(failure));
        }
      }
      return;
    }
    await openProject(result.project);
  }

  const mainError = engineLoadError || error || snapshot?.error;
  const recordButton = (
    <Button
      variant="ghost"
      className={`button primary record-button ${recording ? "recording" : ""}`}
      data-testid={recording ? "stop-recording" : "start-recording"}
      disabled={!engineReady || transitioning || exporting}
      aria-label={state === "stopping" ? "Salvando…" : working ? "Preparando…" : recording ? "Parar gravação" : "Gravar"}
      title={recording ? "Parar gravação" : "Gravar"}
      onClick={() => void recordAction()}
    >
      {transitioning ? (
        <LoaderCircle className="spin" size={16} />
      ) : recording ? (
        <Square fill="currentColor" size={13} />
      ) : (
        <span className="record-dot" />
      )}
      <span className="record-label">
        {state === "stopping"
          ? "Salvando…"
          : working
            ? "Preparando…"
            : recording
              ? "Parar"
              : "Gravar"}
      </span>
      {recording && (
        <span className="record-elapsed">{time(metrics?.elapsedMs ?? 0)}</span>
      )}
    </Button>
  );

  return (
    <div
      className={`app-shell ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <Input
        ref={mediaInput}
        type="file"
        hidden
        data-testid="media-file-input"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void addMedia(file);
        }}
      />
      <aside className="app-sidebar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            allProjects();
          }}
        >
          <Flame size={27} fill="currentColor" />
          <strong>
            grava <span>simples</span>
          </strong>
        </a>
        <nav className="primary-nav">
          <Tooltip content="Todos os projetos">
            <Button
              variant="ghost"
              aria-label="Todos os projetos"
              className={page === "projects" ? "active" : ""}
              onClick={allProjects}
              disabled={busy}
            >
              <LayoutGrid size={18} />
              <span className="nav-label">Todos os projetos</span>
            </Button>
          </Tooltip>
          <Tooltip content="Buscar · ⌘K / Ctrl+K">
            <Button
              variant="ghost"
              aria-label="Buscar"
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              onClick={openSearch}
            >
              <Search size={18} />
              <span className="nav-label">Buscar</span>
            </Button>
          </Tooltip>
        </nav>
        <div className="sidebar-section-heading">
          <span>Projetos</span>
          <IconButton
            label="Novo projeto"
            disabled={busy}
            onClick={() => setProjectEditor({ name: "" })}
          >
            <Plus size={17} />
          </IconButton>
        </div>
        <nav className="project-nav">
          {projects.map((item) => (
            <ProjectContextMenu
              key={item.id}
              name={item.name}
              disabled={busy}
              onOpen={() => void openProject(item)}
              onEdit={() => setProjectEditor({ id: item.id, name: item.name })}
              onDelete={() => setDeleteTarget({ kind: "project", project: item })}
            >
            <div
              className={`project-nav-row ${page !== "projects" && project.id === item.id ? "active" : ""}`}
            >
              <Tooltip content={item.name}>
                <Button
                  variant="ghost"
                  aria-label={item.name}
                  data-testid={`project-nav-${item.id}`}
                  disabled={busy}
                  onClick={() => void openProject(item)}
                >
                  <span className="project-dot" />
                  <span>{item.name}</span>
                </Button>
              </Tooltip>
              <ProjectDropdownMenu
                name={item.name}
                disabled={busy}
                onOpen={() => void openProject(item)}
                onEdit={() => setProjectEditor({ id: item.id, name: item.name })}
                onDelete={() => setDeleteTarget({ kind: "project", project: item })}
              >
                <IconButton
                  className="project-nav-more"
                  label={`Opções do projeto ${item.name}`}
                  disabled={busy}
                >
                  <MoreHorizontal size={15} />
                </IconButton>
              </ProjectDropdownMenu>
            </div>
            </ProjectContextMenu>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Tooltip
            content={sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
          >
            <Button
              variant="ghost"
              className="sidebar-collapse"
              aria-label={sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={17} />
              ) : (
                <PanelLeftClose size={17} />
              )}
              <span className="nav-label">
                {sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
              </span>
            </Button>
          </Tooltip>
          <Tooltip content="Preferências">
            <Button
              variant="ghost"
              className="sidebar-preferences"
              aria-label="Preferências"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={17} />
              <span className="nav-label">Preferências</span>
            </Button>
          </Tooltip>
        </div>
      </aside>
      {sidebarOpen && (
        <Button
          variant="ghost"
          className="sidebar-scrim"
          aria-label="Fechar navegação"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Tabs
        asChild
        value={tab}
        onValueChange={(value) => {
          if (page === "recording") void closeRecording().then(() => setTab(value as "studio" | "recordings"));
          else setTab(value as "studio" | "recordings");
        }}
      >
        <main className="workspace">
          <header className="workspace-header">
            <IconButton
              label="Abrir navegação"
              className="mobile-menu"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Layers size={20} />
            </IconButton>
            {page !== "projects" && project.id ? (
              <ProjectBreadcrumbs
                key={project.id}
                projectId={project.id}
                projectName={project.name}
                recordingsCount={projectTakes.length}
                busy={busy}
                onAllProjects={allProjects}
                onEdit={() => setProjectEditor({ id: project.id, name: project.name })}
                onRecordings={page === "recording" ? () => void closeRecording() : undefined}
              />
            ) : (
              <div className="workspace-title">
                <LayoutGrid size={18} />
                <span>Meu espaço</span>
              </div>
            )}
            <div className="header-actions">
              {page === "studio" && tab === "studio" && recordButton}
              <IconButton
                label="Buscar"
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                onClick={openSearch}
              >
                <Search size={18} />
              </IconButton>
              <IconButton
                label="Configurações"
                data-testid="settings-trigger"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={19} />
              </IconButton>
              <div className="account-wrap">
                <UserButton />
              </div>
            </div>
          </header>
          {mainError && (
            <div className="error-banner" role="alert">
              <Info size={16} />
              <span>{mainError}</span>
              {engineLoadError ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="retry-engine-load"
                  disabled={engineLoading}
                  onClick={() => {
                    setEngineLoading(true);
                    setEngineLoadAttempt((attempt) => attempt + 1);
                  }}
                >
                  {engineLoading ? "Carregando…" : "Tentar novamente"}
                </Button>
              ) : (
                <IconButton label="Fechar aviso" onClick={() => setError("")}>
                  <X size={15} />
                </IconButton>
              )}
            </div>
          )}
          {page === "recording" && (activeTake && result ? (
            <RecordingDetail
              key={activeTake.id}
              take={activeTake}
              projectName={project.name}
              result={result}
              downloads={downloadState}
              onBack={() => void closeRecording()}
              onRename={() => setTakeEditor(activeTake)}
              onDownload={(file) => void compatible(file)}
            />
          ) : <div className="empty-library" role="status">Abrindo gravação…</div>)}
          <section className="projects-page" hidden={page !== "projects"}>
            <div className="page-heading">
              <div>
                <h1>Suas ideias, em cena.</h1>
                <p>Um projeto para cada história que você quer contar.</p>
              </div>
              <Button
                variant="ghost"
                className="button primary"
                onClick={() => setProjectEditor({ name: "" })}
              >
                <Plus size={17} />
                Novo projeto
              </Button>
            </div>
            <div className="project-list-toolbar">
              <h2>
                Seus projetos <span>{projects.length}</span>
              </h2>
              <Button
                variant="ghost"
                className="global-search-trigger"
                aria-label="Buscar em tudo"
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                onClick={openSearch}
              >
                <Search size={16} />
                <span>Buscar em tudo…</span>
                <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} K</kbd>
              </Button>
            </div>
            <div className="project-grid">
              {projects.map((item, index) => {
                const count = takes.filter(
                  (take) => take.projectId === item.id,
                ).length;
                return (
                  <ProjectContextMenu
                    key={item.id}
                    name={item.name}
                    disabled={busy}
                    onOpen={() => void openProject(item)}
                    onEdit={() => setProjectEditor({ id: item.id, name: item.name })}
                    onDelete={() => setDeleteTarget({ kind: "project", project: item })}
                  >
                  <article
                    className="project-card"
                    data-testid="project-card"
                  >
                    <Button
                      variant="ghost"
                      className={`project-cover cover-${index % 3}`}
                      aria-label={`Abrir projeto ${item.name}`}
                      onClick={() => void openProject(item)}
                    >
                      {item.cover && (
                        <img
                          className="project-cover-image"
                          src={item.cover}
                          alt={`Prévia de ${item.name}`}
                        />
                      )}
                      <div
                        className={`cover-frame ${item.cover ? "cover-frame-hidden" : ""}`}
                      >
                        <Video size={34} strokeWidth={1.3} />
                        <span className="cover-record" />
                      </div>
                      <span className="open-project">
                        Abrir estúdio
                        <ArrowRight size={15} />
                      </span>
                    </Button>
                    <div className="project-card-content">
                      <Button
                        variant="ghost"
                        onClick={() => void openProject(item)}
                      >
                        <h3>{item.name}</h3>
                        <span>
                          {count
                            ? `${count} ${count === 1 ? "gravação" : "gravações"}`
                            : "Pronto para a primeira gravação"}{" "}
                          · {date(item.updatedAt)}
                        </span>
                      </Button>
                      <ProjectDropdownMenu
                        name={item.name}
                        disabled={busy}
                        onOpen={() => void openProject(item)}
                        onEdit={() => setProjectEditor({ id: item.id, name: item.name })}
                        onDelete={() => setDeleteTarget({ kind: "project", project: item })}
                      >
                        <IconButton label={`Opções do projeto ${item.name}`} disabled={busy}>
                          <MoreHorizontal size={18} />
                        </IconButton>
                      </ProjectDropdownMenu>
                    </div>
                  </article>
                  </ProjectContextMenu>
                );
              })}
              <Button
                variant="ghost"
                className="new-project-card"
                onClick={() => setProjectEditor({ name: "" })}
              >
                <span>
                  <Plus size={25} />
                </span>
                Novo projeto
              </Button>
            </div>
          </section>
          <div
            className="project-workspace"
            hidden={page !== "studio" || !project.id}
          >
            <TabsContent value="studio" forceMount asChild>
              <div className="studio-layout" hidden={tab !== "studio"}>
                <div className="studio-main">
                  <div className="preview-stage">
                    <div className="preview-surface">
                      <div className="preview-pair">
                        <figure
                          className="landscape-output"
                          data-editing={editorOrientation === "landscape"}
                          aria-labelledby="landscape-output-label"
                        >
                          <figcaption id="landscape-output-label" className="output-format-label">
                            <Button
                              variant="ghost"
                              className="output-format-button"
                              aria-label="Selecionar formato horizontal"
                              aria-pressed={editorOrientation === "landscape"}
                              onClick={() => setEditorOrientation("landscape")}
                            >
                              <Monitor size={15} aria-hidden="true" />
                              <span>Horizontal</span>
                              <span className="output-aspect-ratio">16:9</span>
                            </Button>
                          </figcaption>
                          <div className="video-frame landscape-frame">
                            <canvas
                              ref={landscape}
                              data-testid="landscape-preview"
                              width={640}
                              height={360}
                            />
                            {preview && (
                              <LayerCanvasEditor
                                scene={scene}
                                appearance={appearance}
                                orientation="landscape"
                                selectedLayerId={
                                  editorOrientation === "landscape"
                                    ? selectedLayerId
                                    : undefined
                                }
                                onSelectLayer={(id) => {
                                  setEditorOrientation("landscape");
                                  setSelectedLayerId(id);
                                }}
                                onLayerChange={updateLayer}
                                disabled={transitioning}
                                bounds={
                                  session.current?.getLayerBounds("landscape") ??
                                  Object.fromEntries(
                                    appearance.layers.map((layer) => [
                                      layer.id,
                                      getLayerFrame(layer, {
                                        layout: scene.layout,
                                        appearance,
                                        orientation: "landscape",
                                        width: landscape.current?.width,
                                        height: landscape.current?.height,
                                        cameraWidth:
                                          metrics?.captureInfo?.cameraWidth,
                                        cameraHeight:
                                          metrics?.captureInfo?.cameraHeight,
                                        screenWidth:
                                          metrics?.captureInfo?.sourceWidth,
                                        screenHeight:
                                          metrics?.captureInfo?.sourceHeight,
                                      }),
                                    ]),
                                  )
                                }
                              />
                            )}

                            {!preview && (
                              <div className="empty-stage">
                                <span className="empty-camera">
                                  <Camera size={31} strokeWidth={1.5} />
                                </span>
                                <h1>É a sua hora de brilhar.</h1>
                                <p>Sua ideia merece ganhar o mundo.</p>
                                <Button
                                  variant="ghost"
                                  className="button primary"
                                  disabled={!engineReady || busy}
                                  data-testid="activate-camera"
                                  onClick={() => void activateSceneSource()}
                                >
                                  <Camera size={16} />
                                  {working
                                    ? "Conectando…"
                                    : isScreen(scene?.layout ?? "camera")
                                      ? "Conectar câmera e tela"
                                      : "Ativar câmera"}
                                </Button>
                              </div>
                            )}
                            {recording && (
                              <span className="rec-badge">
                                <i />
                                REC · {time(metrics?.elapsedMs ?? 0)}
                              </span>
                            )}
                          </div>
                        </figure>
                        <figure
                          className="portrait-output"
                          data-editing={editorOrientation === "portrait"}
                          aria-labelledby="portrait-output-label"
                        >
                          <figcaption id="portrait-output-label" className="output-format-label">
                            <Button
                              variant="ghost"
                              className="output-format-button"
                              aria-label="Selecionar formato vertical"
                              aria-pressed={editorOrientation === "portrait"}
                              onClick={() => setEditorOrientation("portrait")}
                            >
                              <Smartphone size={15} aria-hidden="true" />
                              <span>Vertical</span>
                              <span className="output-aspect-ratio">9:16</span>
                            </Button>
                          </figcaption>
                          <div className="video-frame portrait-frame">
                            <canvas
                              ref={portrait}
                              data-testid="portrait-preview"
                              width={360}
                              height={640}
                            />
                            {preview && (
                              <LayerCanvasEditor
                                scene={scene}
                                appearance={appearance}
                                orientation="portrait"
                                selectedLayerId={
                                  editorOrientation === "portrait"
                                    ? selectedLayerId
                                    : undefined
                                }
                                onSelectLayer={(id) => {
                                  setEditorOrientation("portrait");
                                  setSelectedLayerId(id);
                                }}
                                onLayerChange={updateLayer}
                                disabled={transitioning}
                                bounds={
                                  session.current?.getLayerBounds("portrait") ??
                                  Object.fromEntries(
                                    appearance.layers.map((layer) => [
                                      layer.id,
                                      getLayerFrame(layer, {
                                        layout: scene.layout,
                                        appearance,
                                        orientation: "portrait",
                                        width: portrait.current?.width,
                                        height: portrait.current?.height,
                                        cameraWidth:
                                          metrics?.captureInfo?.cameraWidth,
                                        cameraHeight:
                                          metrics?.captureInfo?.cameraHeight,
                                        screenWidth:
                                          metrics?.captureInfo?.sourceWidth,
                                        screenHeight:
                                          metrics?.captureInfo?.sourceHeight,
                                      }),
                                    ]),
                                  )
                                }
                              />
                            )}

                            {!preview && (
                              <div className="empty-portrait">
                                <Smartphone size={25} strokeWidth={1.4} />
                              </div>
                            )}
                          </div>
                        </figure>
                      </div>
                    </div>
                    {preview && selectedLayerId && (
                      <p className="canvas-workspace-hint">
                        <span>Arraste para alinhar às bordas ou ao centro.</span>
                      <span><kbd>Alt / Option</kbd> para mover livremente</span>
                      </p>
                    )}
                  </div>
                  <section className="scenes-section">
                    <div className="section-heading">
                      <h2>Cenas</h2>
                      <IconButton
                        label="Adicionar cena"
                        disabled={busy || project?.scenes.length >= 20}
                        onClick={() =>
                          setSceneEditor({
                            id: `scene-${crypto.randomUUID().slice(0, 8)}`,
                            name: "Nova cena",
                            layout: "camera",
                          })
                        }
                      >
                        <Plus size={17} />
                      </IconButton>
                    </div>
                    <div className="scene-list">
                      {project?.scenes.map((item, index) => (
                        <div
                          className={`scene-item ${scene?.id === item.id ? "selected" : ""}`}
                          key={item.id}
                        >
                          <Button
                            variant="ghost"
                            className="scene-choice"
                            data-testid={`scene-${item.id}`}
                            aria-pressed={scene?.id === item.id}
                            disabled={transitioning}
                            onClick={() => void chooseScene(item.id)}
                          >
                            <ScenePreview scene={item} />
                            <span>{item.name}</span>
                            <kbd>{index + 1}</kbd>
                          </Button>
                          <IconButton
                            className="scene-more"
                            label={`Editar cena ${item.name}`}
                            disabled={busy}
                            onClick={() => setSceneEditor({ ...item })}
                          >
                            <MoreHorizontal size={15} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
                <SceneInspector
                  scene={scene}
                  appearance={appearance}
                  onChange={changeAppearance}
                  onZoom={zoom}
                  onEditScene={() => setSceneEditor({ ...scene })}
                  onAddLayer={addLayer}
                  onRemoveLayer={removeLayer}
                  selectedLayerId={selectedLayerId}
                  onSelectLayer={setSelectedLayerId}
                  onLayerChange={updateLayer}
                  onDuplicateLayer={duplicateLayer}
                  onReplaceSource={replaceLayerSource}
                  orientation={editorOrientation}
                  onOrientationChange={setEditorOrientation}
                  bounds={
                    session.current?.getLayerBounds(editorOrientation) ??
                    Object.fromEntries(
                      appearance.layers.map((layer) => [
                        layer.id,
                        getLayerFrame(layer, {
                          layout: scene.layout,
                          appearance,
                          orientation: editorOrientation,
                          width:
                            editorOrientation === "landscape"
                              ? landscape.current?.width
                              : portrait.current?.width,
                          height:
                            editorOrientation === "landscape"
                              ? landscape.current?.height
                              : portrait.current?.height,
                        }),
                      ]),
                    )
                  }
                  onConnect={(kind) => {
                  setSourceLayerId(kind === "microphone" ? null
                    : appearance.layers.find(layer => layer.id === selectedLayerId && layer.kind === kind)?.id
                      ?? appearance.layers.find(layer => layer.kind === kind)?.id ?? null);
                    setSourcePicker(kind === "screen" ? "choose" : kind);
                  }}
                  onImportMedia={(id) => {
                    setSourceLayerId(id ?? null);
                    mediaInput.current?.click();
                  }}
                  onBackground={(file) => void setBackground(file)}
                  onClearBackground={() => void setBackground()}
                  controls={controls}
                  metrics={metrics}
                  onMute={mute}
                  onGain={(gain) => setControl({ microphoneGainDb: gain })}
                  countdown={snapshot?.countdown}
                  onResetCountdown={() => session.current?.resetCountdown()}
                  onZeroCountdown={() => session.current?.zeroCountdown()}
                  onPauseCountdown={() => session.current?.pauseCountdown()}
                  onResumeCountdown={() => session.current?.resumeCountdown()}
                  busy={busy}
                  locked={transitioning}
                  ready={engineReady}
                />
              </div>
            </TabsContent>
            <TabsContent value="recordings" forceMount asChild>
              <section className="recordings-page" hidden={tab !== "recordings"}>
                <div className="recordings-heading">
                  <div>
                    <h1>Suas gravações</h1>
                    <p>As ideias que já saíram do papel.</p>
                  </div>
                  <Button
                    variant="ghost"
                    className="button primary"
                    onClick={() => setTab("studio")}
                  >
                    <Plus size={16} />
                    Nova gravação
                  </Button>
                </div>
                {!projectTakes.length ? (
                  <div className="empty-library">
                    <span>
                      <Clapperboard size={35} strokeWidth={1.3} />
                    </span>
                    <h2>Sua primeira gravação vem aí.</h2>
                    <p>Os vídeos deste projeto vão ficar aqui.</p>
                    <Button
                      variant="ghost"
                      className="button secondary"
                      onClick={() => setTab("studio")}
                    >
                      Ir para o estúdio
                      <ArrowRight size={15} />
                    </Button>
                  </div>
                ) : (
                  <div className="take-grid">
                    {projectTakes.map((take) => (
                      <article className="take-card" key={take.id}>
                        <Button
                          variant="ghost"
                          className="take-cover"
                          onClick={() => void openTake(take)}
                          aria-label={`Abrir ${take.name}`}
                        >
                          <RecordingThumbnail take={take} />
                          <span>{time(take.durationMs)}</span>
                        </Button>
                        <div className="take-details">
                          <Button
                            variant="ghost"
                            onClick={() => void openTake(take)}
                          >
                            <h3>{take.name}</h3>
                            <span>
                              {date(take.createdAt)} · Horizontal + vertical
                            </span>
                          </Button>
                          <IconButton
                            label={`Editar ${take.name}`}
                            onClick={() => setTakeEditor(take)}
                          >
                            <MoreHorizontal size={18} />
                          </IconButton>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </TabsContent>
          </div>
        </main>
      </Tabs>
      {searchOpen && (
        <GlobalSearch
          projects={projects}
          takes={takes}
          onClose={() => setSearchOpen(false)}
          onSelect={(result) => void selectSearchResult(result)}
          navigationDisabled={busy || exporting}
        />
      )}
      {muteNotice && (
        <MuteNotice
          onUnmute={() => {
            changeAppearance({ ...appearance, microphoneMuted: false });
            dismissMuteNotice();
          }}
          onDismiss={dismissMuteNotice}
        />
      )}
      {settingsOpen && (
        <Modal title="Preferências" onClose={() => setSettingsOpen(false)}>
          <section className="settings-section">
            <h3>Qualidade da gravação</h3>
            <p>Já deixamos tudo pronto. Ajuste se precisar.</p>
            <div className="two-fields">
              <label className="field-label">
                Resolução
                <Select
                  label="Resolução"
                  data-testid="resolution-select"
                  value={settings.resolution}
                  disabled={busy}
                  onValueChange={(value) =>
                    changeSettings({ resolution: value as Resolution })
                  }
                  options={[
                    ...(diagnostic
                      ? [{ value: "360", label: "360p · teste" }]
                      : []),
                    { value: "720", label: "HD · 720p" },
                    { value: "1080", label: "Full HD · 1080p" },
                    { value: "4k", label: "4K · experimental" },
                  ]}
                />
              </label>
              <label className="field-label">
                Quadros por segundo
                <Select
                  label="Quadros por segundo"
                  data-testid="fps-select"
                  value={String(settings.fps)}
                  disabled={busy}
                  onValueChange={(value) =>
                    changeSettings({ fps: Number(value) as 30 | 60 })
                  }
                  options={[
                    { value: "30", label: "30 fps" },
                    { value: "60", label: "60 fps · experimental" },
                  ]}
                />
              </label>
            </div>
            <p className="hint">
              4K e 60 fps dependem do desempenho do seu dispositivo.
            </p>
          </section>
          <section className="settings-section">
            <Button
              variant="ghost"
              className="technical-toggle"
              aria-expanded={technicalOpen}
              onClick={() => setTechnicalOpen(!technicalOpen)}
            >
              Sobre e detalhes técnicos
              <ChevronDown size={14} />
            </Button>
            {technicalOpen && (
              <div className="technical-details">
                <p data-testid="app-version">GravaSimples {version}</p>
                <p>
                  Componentes OBS em WebAssembly. Captura e gravação usam APIs
                  do navegador; o runtime libobs completo e plugins de desktop
                  ainda não estão disponíveis.
                </p>
                <dl>
                  <div>
                    <dt>Formato</dt>
                    <dd>{metrics?.mimeType || "Automático"}</dd>
                  </div>
                  <div>
                    <dt>Renderização</dt>
                    <dd>{(metrics?.measuredFps ?? 0).toFixed(1)} fps</dd>
                  </div>
                  <div>
                    <dt>Armazenamento</dt>
                    <dd>{metrics?.storage?.storage ?? "Local"}</dd>
                  </div>
                </dl>
                {metrics?.warning && <p>{metrics.warning}</p>}
                <p>
                  Projetos e vídeos ficam neste navegador. Baixe uma cópia para
                  guardar fora dele.
                </p>
                <a href="/source/grava-simples-source.tar.gz" download>
                  Código-fonte e licenças GPL
                </a>
              </div>
            )}
          </section>
          {diagnostic && (
            <section className="settings-section diagnostic-controls">
              <h3>Diagnóstico interno</h3>
              <label className="field-label">
                Fonte de teste
                <Select
                  label="Fonte de teste"
                  data-testid="source-mode-select"
                  value={testSource}
                  onValueChange={(value) => setTestSource(value as SourceKind)}
                  options={[
                    { value: "test", label: "Demonstração" },
                    { value: "camera", label: "Câmera" },
                    { value: "screen", label: "Tela" },
                  ]}
                />
              </label>
              <Button
                variant="ghost"
                className="button secondary"
                data-testid="prepare-inputs"
                disabled={busy}
                onClick={() => void prepare()}
              >
                Conectar fontes de teste
              </Button>
            </section>
          )}
        </Modal>
      )}
      {sourcePicker && (
        <Modal
          title={
            sourcePicker === "choose"
              ? sourceLayerId
                ? "Conteúdo da camada"
                : "Adicionar fonte"
              : sourcePicker === "camera"
                ? "Sua câmera"
                : "Seu microfone"
          }
          description={
            sourcePicker === "choose"
              ? sourceLayerId
                ? "Escolha uma fonte do projeto ou adicione outra."
                : "O que você quer trazer para a gravação?"
              : undefined
          }
          onClose={() => {
            setSourcePicker(null);
            setSourceLayerId(null);
          }}
        >
          {sourcePicker !== "microphone" && (
            <SourceLibrary sources={compatibleSources} selectedId={pickerLayer?.sourceId}
              isConnected={id => session.current?.hasLayerSource(id) ?? false}
              onUse={source => void useProjectSource(source)} disabled={busy} />
          )}
          {sourcePicker === "choose" ? (
            <div className="source-options">
              <Button
                variant="ghost"
                onClick={() => mediaInput.current?.click()}
              >
                <ImagePlus size={23} />
                <span>
                  <strong>Imagem ou vídeo</strong>
                  <small>Um arquivo do seu dispositivo · vídeo sem áudio</small>
                </span>
                <ChevronRight size={17} />
              </Button>
              {!sourceLayerId && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => addLayer("camera")}
                  >
                    <Camera size={23} />
                    <span>
                      <strong>Câmera</strong>
                      <small>Conecte ou escolha uma câmera</small>
                    </span>
                    <ChevronRight size={17} />
                  </Button>
                </>
              )}
              <Button variant="ghost" onClick={() => void connect("screen")}>
                <Monitor size={23} />
                <span>
                  <strong>Compartilhar tela</strong>
                  <small>Uma janela, aba ou a tela inteira</small>
                </span>
                <ChevronRight size={17} />
              </Button>
              {!sourceLayerId && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => setSourcePicker("microphone")}
                  >
                    <Mic size={23} />
                    <span>
                      <strong>Microfone</strong>
                      <small>Escolha de onde vem sua voz</small>
                    </span>
                    <ChevronRight size={17} />
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="device-picker">
              <label className="field-label">
                {sourcePicker === "camera" ? "Câmera" : "Microfone"}
                <Select
                  label={sourcePicker === "camera" ? "Câmera" : "Microfone"}
                  data-testid={
                    sourcePicker === "camera"
                      ? "camera-device-select"
                      : "microphone-device-select"
                  }
                  value={
                    sourcePicker === "camera"
                      ? cameraDraft
                      : (appearance.microphoneDeviceId ?? "")
                  }
                  disabled={busy}
                  onValueChange={(value) =>
                    sourcePicker === "camera" ? setCameraDraft(value) : changeAppearance({
                      ...appearance,
                      microphoneDeviceId: value || undefined,
                    })
                  }
                  options={[
                    {
                      value: "",
                      label:
                        sourcePicker === "camera"
                          ? "Câmera padrão"
                          : "Microfone padrão",
                    },
                    ...devices
                      .filter(
                        (device) =>
                          device.kind ===
                          (sourcePicker === "camera"
                            ? "videoinput"
                            : "audioinput"),
                      )
                      .map((device, index) => ({
                        value: device.deviceId,
                        label: device.label || `Dispositivo ${index + 1}`,
                      })),
                  ]}
                />
              </label>
              <p className="hint">
                Conecte para liberar o acesso e ver os dispositivos disponíveis.
              </p>
              <Button
                variant="ghost"
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void (sourcePicker === "camera"
                    ? connect("camera", cameraDraft)
                    : connectMicrophone())
                }
              >
                {working ? "Conectando…" : "Conectar"}
                <ArrowRight size={15} />
              </Button>
            </div>
          )}
        </Modal>
      )}
      {projectEditor && (
        <Modal
          title={projectEditor.id ? "Renomear projeto" : "Novo projeto"}
          onClose={() => setProjectEditor(null)}
        >
          <form className="editor-form" onSubmit={saveProjectForm}>
            <label className="field-label">
              Nome do projeto
              <Input
                autoFocus
                required
                maxLength={80}
                value={projectEditor.name}
                placeholder="Ex.: Meu próximo curso"
                onChange={(event) =>
                  setProjectEditor({
                    ...projectEditor,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <div className="form-actions">
              {projectEditor.id && (
                <Button
                  variant="ghost"
                  type="button"
                  className="button danger subtle"
                  disabled={busy}
                  onClick={() => {
                    const item = projects.find((item) => item.id === projectEditor.id);
                    if (item) setDeleteTarget({ kind: "project", project: item });
                  }}
                >
                  <Trash2 size={15} />
                  Excluir projeto
                </Button>
              )}
              <Button
                variant="ghost"
                className="button primary"
                type="submit"
                disabled={!projectEditor.name.trim()}
              >
                {projectEditor.id ? "Salvar" : "Criar projeto"}
                <ArrowRight size={15} />
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {sceneEditor && (
        <Modal
          title={
            project.scenes.some((item) => item.id === sceneEditor.id)
              ? "Editar cena"
              : "Nova cena"
          }
          onClose={() => setSceneEditor(null)}
        >
          <form className="editor-form" onSubmit={saveScene}>
            <label className="field-label">
              Nome da cena
              <Input
                required
                maxLength={48}
                value={sceneEditor.name}
                onChange={(event) =>
                  setSceneEditor({ ...sceneEditor, name: event.target.value })
                }
              />
            </label>
            <label className="field-label">
              Enquadramento
              <Select
                label="Enquadramento"
                value={sceneEditor.layout}
                onValueChange={(value) =>
                  setSceneEditor({
                    ...sceneEditor,
                    layout: value as StudioLayout,
                    appearance: defaultSceneAppearance(value as StudioLayout),
                  })
                }
                options={layouts.map((item) => ({
                  value: item.value,
                  label: item.name,
                }))}
              />
            </label>
            <p className="hint">
              {
                layouts.find((item) => item.value === sceneEditor.layout)
                  ?.description
              }
            </p>
            <div className="form-actions">
              {project.scenes.some((item) => item.id === sceneEditor.id) && (
                <>
                  <IconButton
                    label="Excluir cena"
                    disabled={project.scenes.length <= 1}
                    onClick={() => void removeScene()}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                  <Button
                    variant="ghost"
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      update({
                        ...project,
                        scenes: [
                          ...project.scenes,
                          {
                            ...sceneEditor,
                            id: `scene-${crypto.randomUUID().slice(0, 8)}`,
                            name: `${sceneEditor.name} (cópia)`,
                          },
                        ],
                      });
                      setSceneEditor(null);
                    }}
                  >
                    <Copy size={15} />
                    Duplicar
                  </Button>
                </>
              )}
              <Button variant="ghost" className="button primary" type="submit">
                Salvar cena
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {takeEditor && (
        <Modal title="Editar gravação" onClose={() => setTakeEditor(null)}>
          <form
            className="editor-form"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                renameProjectTake(takeEditor.id, takeEditor.name);
                refresh();
                setTakeEditor(null);
              } catch (failure) {
                setError(message(failure));
              }
            }}
          >
            <label className="field-label">
              Nome da gravação
              <Input
                required
                maxLength={80}
                value={takeEditor.name}
                onChange={(event) =>
                  setTakeEditor({ ...takeEditor, name: event.target.value })
                }
              />
            </label>
            <div className="form-actions">
              <Button
                variant="ghost"
                type="button"
                className="button danger subtle"
                disabled={busy}
                onClick={() => setDeleteTarget({ kind: "recording", take: takeEditor })}
              >
                <Trash2 size={15} />
                Excluir
              </Button>
              <Button variant="ghost" className="button primary" type="submit">
                Salvar
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {deleteTarget && (
        <AlertDialog
          title={deleteTarget.kind === "project" ? "Excluir projeto?" : "Excluir gravação?"}
          description={deleteTarget.kind === "project"
            ? `O projeto “${deleteTarget.project.name}” e suas gravações serão excluídos deste navegador. Essa ação não pode ser desfeita.`
            : `A gravação “${deleteTarget.take.name}” será excluída deste navegador. Essa ação não pode ser desfeita.`}
          actionLabel={deleteTarget.kind === "project" ? "Excluir projeto" : "Excluir gravação"}
          pending={deleting}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {resultOpen && result && (
        <Modal
          title="Pronto. Sua ideia virou vídeo."
          description="Os dois formatos estão salvos neste projeto."
          wide
          className="recordings-modal"
          onClose={() => setResultOpen(false)}
        >
          <section className="results" data-testid="recording-results">
            <Button variant="secondary" className="open-recording-detail" onClick={() => {
              const take = listProjectTakes().find((item) => item.id === result.id);
              if (take) void openTake(take);
              else setError("A gravação ainda está sendo salva. Tente novamente em instantes.");
            }}><FileText size={16} />Abrir gravação e transcrição<ArrowRight size={15} /></Button>
            <div className="recording-files">
              {(["landscape", "portrait"] as const).map((orientation) => {
                const file = result[orientation];
                const download = downloadState[`${result.id}-${orientation}`];
                return (
                  <article key={orientation}>
                    <h3>
                      {orientation === "landscape" ? (
                        <Monitor size={16} />
                      ) : (
                        <Smartphone size={16} />
                      )}
                      {orientation === "landscape" ? "Horizontal" : "Vertical"}
                    </h3>
                    <video
                      src={file.url}
                      controls
                      playsInline
                      preload="metadata"
                      data-testid={`result-${orientation}`}
                    />
                    <div className="file-information">
                      {time(file.durationMs)} · {bytes(file.size)}
                    </div>
                    {download?.file ? (
                      <a
                        className="button primary"
                        href={download.file.url}
                        download={download.file.fileName}
                        data-testid={`download-compatible-${orientation}`}
                      >
                        <Download size={16} />
                        Baixar vídeo
                      </a>
                    ) : (
                      <Button
                        variant="ghost"
                        className="button primary"
                        disabled={download?.busy}
                        onClick={() => void compatible(file)}
                      >
                        {download?.busy ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <Download size={16} />
                        )}
                        {download?.busy ? download.label : "Baixar vídeo"}
                      </Button>
                    )}
                    <details className="original-download">
                      <summary>Outras opções</summary>
                      <a
                        className="button secondary"
                        href={file.url}
                        download={file.fileName}
                        data-testid={`download-${orientation}`}
                      >
                        <Download size={16} />
                        Baixar original
                      </a>
                    </details>
                    {download?.error && (
                      <p className="download-error" role="alert">
                        {download.error}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="download-note">
              A versão compatível é preparada no seu dispositivo. Seu vídeo não
              é enviado a um servidor.
            </p>
            {result.warnings.length > 0 && (
              <details className="recording-notes">
                <summary>Detalhes da gravação</summary>
                {result.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </details>
            )}
          </section>
        </Modal>
      )}
    </div>
  );
}
