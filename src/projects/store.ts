import { deleteRecordingFiles, listRecoverableRecordings, readRecordingFiles } from '../media/storage';
import { defaultSceneAppearance, normalizeSceneAppearance } from '../media/SceneCompositor';
import type { RecordingResult, Resolution, SceneAppearance, SourceKind, StudioControls, StudioLayout } from '../media/types';
import { deleteProjectSceneAssets } from './assets';
import { WORKSPACE_STORAGE_KEY } from './keys';
import { createProjectCover } from './thumbnails';
import { normalizeProjectSources, type ProjectSource } from './sources';
import { createRecordingThumbnail, type RecordingThumbnailData } from './recordingThumbnails';
import { deleteTranscript } from '../recordings/transcript';
import { deleteReview } from '../recordings/review';

export interface ProjectScene {
  id: string;
  name: string;
  layout: StudioLayout;
  zoom?: number;
  appearance?: SceneAppearance;
}

export interface ProjectSettings {
  resolution: Resolution;
  fps: 30 | 60;
  source: SourceKind;
  cameraDeviceId?: string;
  microphoneDeviceId?: string;
  controls?: StudioControls;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  scenes: ProjectScene[];
  sources?: ProjectSource[];
  selectedSceneId: string;
  settings: ProjectSettings;
  /** A bounded JPEG of the actual composed output, captured after a real preview/take. */
  cover?: string;
  coverUpdatedAt?: number;
}

export interface ProjectTake {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  /** Actual video frame, captured at 5% where the browser can seek. */
  thumbnail?: string;
  thumbnailAtSeconds?: number;
  warnings: string[];
  landscape: { fileName: string; mimeType: string; size: number };
  portrait: { fileName: string; mimeType: string; size: number };
}

interface Workspace {
  version: 1;
  activeProjectId?: string;
  projects: Project[];
  takes: ProjectTake[];
  legacyRecordingsImported?: boolean;
  sceneRevision?: number;
  sourceRevision?: number;
}

const KEY = WORKSPACE_STORAGE_KEY;
const SCENE_REVISION = 3;
const SOURCE_REVISION = 1;
const LAYOUTS = new Set(['camera', 'camera-zoom', 'screen', 'screen-3d', 'countdown']);

export const DEFAULT_PROJECT_SCENES: ProjectScene[] = [
  { id: 'camera', name: 'Principal', layout: 'camera', appearance: defaultSceneAppearance('camera') },
  { id: 'camera-zoom', name: 'Câmera com zoom', layout: 'camera-zoom', zoom: 1.6, appearance: defaultSceneAppearance('camera-zoom') },
  { id: 'screen', name: 'Câmera + tela', layout: 'screen', appearance: defaultSceneAppearance('screen') },
  { id: 'screen-3d', name: 'Apresentação', layout: 'screen-3d', appearance: defaultSceneAppearance('screen-3d') },
  { id: 'countdown', name: 'Começando em breve', layout: 'countdown', appearance: defaultSceneAppearance('countdown') },
];

const clone = <T,>(value: T): T => structuredClone(value);
const cleanName = (value: string, fallback: string) => value.trim().slice(0, 80) || fallback;

function validScenes(value: unknown): value is ProjectScene[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every(scene => scene && typeof scene.id === 'string' && typeof scene.name === 'string' && LAYOUTS.has(scene.layout)) &&
    new Set(value.map(scene => scene.id)).size === value.length;
}

function newProject(name: string): Project {
  const now = Date.now();
  return normalizeProjectSources<Project>({
    id: `project-${crypto.randomUUID()}`, name: cleanName(name, 'Novo projeto'), createdAt: now, updatedAt: now,
    scenes: clone(DEFAULT_PROJECT_SCENES), selectedSceneId: 'camera',
    settings: { resolution: '1080', fps: 30, source: 'camera' },
  });
}

function normalizedScene(scene: ProjectScene, legacyVisibility?: StudioControls['sourceVisibility']): ProjectScene {
  const appearance = normalizeSceneAppearance(scene.layout, scene.appearance);
  if (!scene.appearance && legacyVisibility) {
    appearance.layers = appearance.layers.map(layer =>
      layer.kind === 'camera' || layer.kind === 'screen'
        ? { ...layer, visible: legacyVisibility[layer.kind] !== false }
        : layer,
    );
  }
  return { ...scene, appearance };
}

function addCountdown(project: Project): void {
  if (project.scenes.some(scene => scene.layout === 'countdown')) return;
  const scene = clone(DEFAULT_PROJECT_SCENES[4]);
  if (project.scenes.some(item => item.id === scene.id)) scene.id = `countdown-${crypto.randomUUID().slice(0, 8)}`;
  project.scenes.push(scene);
}

function read(): Workspace {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const stored = JSON.parse(raw) as Workspace;
    if (stored.version !== 1 || !Array.isArray(stored.projects) || !Array.isArray(stored.takes) ||
      !stored.projects.every(project => typeof project.id === 'string' && typeof project.name === 'string' && validScenes(project.scenes))) {
      throw new Error('Não foi possível abrir os projetos salvos neste navegador.');
    }
    if ((stored.sceneRevision ?? 0) < SCENE_REVISION) {
      for (const project of stored.projects) {
        project.scenes = project.scenes.map(scene => {
          const normalized = normalizedScene(scene, project.settings.controls?.sourceVisibility);
          const legacy = project.settings.controls;
          // Old shared controls describe the scene that was active at migration.
          normalized.appearance = { ...normalized.appearance!,
            microphoneMuted: scene.appearance?.microphoneMuted ?? (scene.id === project.selectedSceneId ? legacy?.microphoneMuted : undefined) ?? normalized.appearance!.microphoneMuted,
            microphoneGainDb: scene.appearance?.microphoneGainDb ?? (scene.id === project.selectedSceneId ? legacy?.microphoneGainDb : undefined) ?? normalized.appearance!.microphoneGainDb,
            cameraDeviceId: scene.appearance?.cameraDeviceId ?? (scene.id === project.selectedSceneId ? project.settings.cameraDeviceId : undefined),
            microphoneDeviceId: scene.appearance?.microphoneDeviceId ?? (scene.id === project.selectedSceneId ? project.settings.microphoneDeviceId : undefined),
          };
          return normalized;
        });
        addCountdown(project);
      }
      stored.sceneRevision = SCENE_REVISION;
      write(stored);
    }
    const normalized = stored.projects.map(project => normalizeProjectSources(project));
    if ((stored.sourceRevision ?? 0) < SOURCE_REVISION || JSON.stringify(normalized) !== JSON.stringify(stored.projects)) {
      stored.projects = normalized;
      stored.sourceRevision = SOURCE_REVISION;
      write(stored);
    }
    return stored;
  }
  const project = newProject(localStorage.getItem('grava-simples-project') || 'Meu primeiro projeto');
  try {
    const legacyScenes: unknown = JSON.parse(localStorage.getItem('grava-simples-scenes') || 'null');
    if (validScenes(legacyScenes)) {
      project.scenes = legacyScenes.map(scene => normalizedScene(scene));
      if (!project.scenes.some(scene => scene.layout === 'screen-3d')) project.scenes.push(clone(DEFAULT_PROJECT_SCENES[3]));
      addCountdown(project);
      project.selectedSceneId = project.scenes[0].id;
    }
  } catch { /* A malformed old scene list does not discard the new project. */ }
  const workspace: Workspace = { version: 1, sceneRevision: SCENE_REVISION, sourceRevision: SOURCE_REVISION, activeProjectId: project.id, projects: [normalizeProjectSources(project)], takes: [] };
  write(workspace);
  return workspace;
}

function write(workspace: Workspace): void {
  try { localStorage.setItem(KEY, JSON.stringify(workspace)); }
  catch { throw new Error('Não foi possível salvar o projeto neste navegador. Verifique o espaço disponível e as permissões de armazenamento.'); }
}

/** Local-first catalogue. Video bytes remain in the existing OPFS/IndexedDB recording store. */
export function loadProjects(): Project[] {
  return clone(read().projects).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createProject(name: string): Project {
  const workspace = read();
  const project = newProject(name);
  workspace.projects.push(project);
  workspace.activeProjectId = project.id;
  write(workspace);
  return clone(project);
}

export function saveProject(project: Project): Project {
  const workspace = read();
  const index = workspace.projects.findIndex(item => item.id === project.id);
  if (index < 0) throw new Error('Este projeto não está mais disponível.');
  if (!validScenes(project.scenes)) throw new Error('O projeto precisa de pelo menos uma cena válida.');
  const previous = workspace.projects[index];
  const updated = clone(normalizeProjectSources({
    ...project, name: cleanName(project.name, 'Novo projeto'), updatedAt: Date.now(), scenes: project.scenes.map(scene => normalizedScene(scene)),
    // Cover captures have their own setter, so an older React project snapshot cannot erase a newer cover.
    cover: previous.cover ?? project.cover, coverUpdatedAt: previous.coverUpdatedAt ?? project.coverUpdatedAt,
  }));
  workspace.projects[index] = updated;
  write(workspace);
  return clone(updated);
}

/** Save only cover fields against the latest catalogue, preserving concurrent scene/settings edits. */
export function captureProjectCover(projectId: string, canvas: HTMLCanvasElement): Project {
  const dataUrl = createProjectCover(canvas);
  const workspace = read();
  const project = workspace.projects.find(item => item.id === projectId);
  if (!project) throw new Error('O projeto desta prévia não está mais disponível.');
  project.cover = dataUrl;
  project.coverUpdatedAt = Date.now();
  write(workspace);
  return clone(project);
}

export function getActiveProjectId(): string | undefined {
  const workspace = read();
  return workspace.projects.some(project => project.id === workspace.activeProjectId) ? workspace.activeProjectId : workspace.projects[0]?.id;
}

export function setActiveProjectId(id: string): void {
  const workspace = read();
  if (!workspace.projects.some(project => project.id === id)) throw new Error('Projeto não encontrado.');
  workspace.activeProjectId = id;
  write(workspace);
}

/** Metadata-only removal. Explicitly use deleteProjectAndRecordings to delete video bytes. */
export function deleteProject(id: string): void {
  const workspace = read();
  if (workspace.takes.some(take => take.projectId === id)) throw new Error('Este projeto contém vídeos. Exclua os vídeos ou use a exclusão de projeto com gravações.');
  workspace.projects = workspace.projects.filter(project => project.id !== id);
  if (workspace.activeProjectId === id) workspace.activeProjectId = workspace.projects[0]?.id;
  write(workspace);
}

export async function deleteProjectAndRecordings(id: string): Promise<void> {
  for (const take of listProjectTakes(id)) await deleteProjectTake(take.id);
  await deleteProjectSceneAssets(id);
  deleteProject(id);
}

export function listProjectTakes(projectId?: string): ProjectTake[] {
  return clone(read().takes.filter(take => !projectId || take.projectId === projectId)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveProjectTake(projectId: string, result: RecordingResult): Promise<ProjectTake> {
  const workspace = read();
  const project = workspace.projects.find(item => item.id === projectId);
  if (!project) throw new Error('O projeto desta gravação não está mais disponível.');
  const existing = workspace.takes.find(take => take.id === result.id);
  if (existing) return clone(existing);
  const take: ProjectTake = {
    id: result.id, projectId, name: `Gravação ${workspace.takes.filter(item => item.projectId === projectId).length + 1}`,
    createdAt: result.startedAt, startedAt: result.startedAt, stoppedAt: result.stoppedAt,
    durationMs: result.landscape.durationMs, warnings: [...result.warnings],
    landscape: { fileName: result.landscape.fileName, mimeType: result.landscape.mimeType, size: result.landscape.size },
    portrait: { fileName: result.portrait.fileName, mimeType: result.portrait.mimeType, size: result.portrait.size },
  };
  workspace.takes.push(take);
  project.updatedAt = Date.now();
  write(workspace);
  // Recording persistence is complete before decoding; a missing decoder or full
  // thumbnail quota must never turn a successfully saved take into a failure.
  try {
    const thumbnail = await createRecordingThumbnail(result.landscape.blob, take.durationMs);
    return saveProjectTakeThumbnail(take.id, thumbnail);
  } catch { return clone(take); }
}

/** Merge only thumbnail fields into the latest catalogue, preserving rename/edit races. */
export function saveProjectTakeThumbnail(id: string, thumbnail: RecordingThumbnailData): ProjectTake {
  if (!thumbnail.thumbnail.startsWith('data:image/jpeg;base64,') || thumbnail.thumbnail.length > 64_000 ||
      !Number.isFinite(thumbnail.thumbnailAtSeconds) || thumbnail.thumbnailAtSeconds < 0)
    throw new Error('A prévia deste vídeo é inválida.');
  const workspace = read();
  const take = workspace.takes.find(item => item.id === id);
  if (!take) throw new Error('Gravação não encontrada.');
  take.thumbnail = thumbnail.thumbnail;
  take.thumbnailAtSeconds = thumbnail.thumbnailAtSeconds;
  write(workspace);
  return clone(take);
}

/** Backfill old takes on demand; one decoder at a time bounds library work. */
let thumbnailQueue: Promise<unknown> = Promise.resolve();
export function ensureProjectTakeThumbnail(take: ProjectTake, signal?: AbortSignal): Promise<RecordingThumbnailData> {
  const job = thumbnailQueue.catch(() => undefined).then(async () => {
    if (signal?.aborted) throw new DOMException('A prévia foi cancelada.', 'AbortError');
    const current = read().takes.find(item => item.id === take.id);
    if (!current) throw new Error('Gravação não encontrada.');
    if (current.thumbnail) return {
      thumbnail: current.thumbnail, thumbnailAtSeconds: current.thumbnailAtSeconds ?? 0,
    };
    const files = await readRecordingFiles(take.id);
    if (signal?.aborted) throw new DOMException('A prévia foi cancelada.', 'AbortError');
    const thumbnail = await createRecordingThumbnail(files.landscape, current.durationMs, signal);
    saveProjectTakeThumbnail(take.id, thumbnail);
    return thumbnail;
  });
  thumbnailQueue = job;
  return job;
}

export function renameProjectTake(id: string, name: string): ProjectTake {
  const workspace = read();
  const take = workspace.takes.find(item => item.id === id);
  if (!take) throw new Error('Gravação não encontrada.');
  take.name = cleanName(name, take.name);
  const project = workspace.projects.find(item => item.id === take.projectId);
  if (project) project.updatedAt = Date.now();
  write(workspace);
  return clone(take);
}

export async function deleteProjectTake(id: string): Promise<void> {
  const workspace = read();
  const take = workspace.takes.find(item => item.id === id);
  if (!take) return;
  await deleteRecordingFiles(id);
  // Re-read after the async file deletion, preserving edits made in the meantime.
  const latest = read();
  latest.takes = latest.takes.filter(item => item.id !== id);
  const project = latest.projects.find(item => item.id === take.projectId);
  if (project) project.updatedAt = Date.now();
  write(latest);
  deleteTranscript(id);
  deleteReview(id);
}

export async function restoreProjectTake(take: ProjectTake): Promise<RecordingResult> {
  const files = await readRecordingFiles(take.id);
  return {
    id: take.id, startedAt: take.startedAt, stoppedAt: take.stoppedAt, warnings: [...take.warnings],
    landscape: { ...take.landscape, orientation: 'landscape', blob: files.landscape, url: URL.createObjectURL(files.landscape), size: files.landscape.size, durationMs: take.durationMs },
    portrait: { ...take.portrait, orientation: 'portrait', blob: files.portrait, url: URL.createObjectURL(files.portrait), size: files.portrait.size, durationMs: take.durationMs },
  };
}

/** Import only complete pre-project takes once, into the original project. No files are moved or deleted. */
export async function importLegacyRecordings(): Promise<number> {
  if (read().legacyRecordingsImported) return 0;
  const records = await listRecoverableRecordings();
  const workspace = read();
  if (workspace.legacyRecordingsImported) return 0;
  const project = workspace.projects.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!project) return 0;
  let imported = 0;
  for (const record of records) {
    if (!record.completed || !record.landscapeBytes || !record.portraitBytes || workspace.takes.some(take => take.id === record.id)) continue;
    const extension = record.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    workspace.takes.push({
      id: record.id, projectId: project.id, name: `Gravação recuperada ${++imported}`,
      createdAt: record.createdAt, startedAt: record.createdAt, stoppedAt: record.createdAt, durationMs: 0, warnings: [],
      landscape: { fileName: `grava-landscape-${record.id}.${extension}`, mimeType: record.mimeType, size: record.landscapeBytes },
      portrait: { fileName: `grava-portrait-${record.id}.${extension}`, mimeType: record.mimeType, size: record.portraitBytes },
    });
  }
  workspace.legacyRecordingsImported = true;
  write(workspace);
  return imported;
}

/** Clear stale catalogue entries after an explicit app-wide local-recording cleanup. */
export function clearProjectTakeIndex(): void {
  const workspace = read();
  const ids = workspace.takes.map(take => take.id);
  workspace.takes = [];
  write(workspace);
  for (const id of ids) { deleteTranscript(id); deleteReview(id); }
}
