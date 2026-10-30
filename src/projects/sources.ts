import { normalizeSceneAppearance } from '../media/SceneCompositor';
import type { SceneLayer } from '../media/types';
import type { ProjectScene } from './store';

/** One capture or imported file, reusable by any number of scene layers. */
export interface ProjectSource {
  id: string;
  kind: 'camera' | 'screen' | 'media';
  name: string;
  deviceId?: string;
  assetId?: string;
  /** The source used when another standard scene is added to the project. */
  primary?: boolean;
}

interface SourceProject {
  scenes: ProjectScene[];
  sources?: ProjectSource[];
  settings?: { cameraDeviceId?: string };
}

const sourceKinds = new Set<ProjectSource['kind']>(['camera', 'screen', 'media']);
const deviceKey = (deviceId?: string) => deviceId || '';

/**
 * Migrate scene-local bindings without merging explicitly different captures.
 * Standard templates share primary inputs; added layers receive distinct inputs.
 * Calling this again retains every assigned identity and source definition.
 */
export function normalizeProjectSources<T extends SourceProject>(project: T): T & { sources: ProjectSource[] } {
  const sources: ProjectSource[] = [];
  const byId = new Map<string, ProjectSource>();
  for (const entry of project.sources ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || !sourceKinds.has(entry.kind) || byId.has(entry.id)) continue;
    const source: ProjectSource = {
      ...entry,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 160) : entry.kind === 'camera' ? 'Câmera' : entry.kind === 'screen' ? 'Tela compartilhada' : 'Mídia',
    };
    sources.push(source);
    byId.set(source.id, source);
  }
  const scenes = project.scenes.map(scene => ({ ...scene, appearance: normalizeSceneAppearance(scene.layout, scene.appearance) }));
  const catalogCamera = sources.find(source => source.kind === 'camera' && source.primary);
  const cameraDevice = (scene: (typeof scenes)[number]) => scene.appearance.cameraDeviceId
    ?? (catalogCamera ? catalogCamera.deviceId : project.settings?.cameraDeviceId);
  const nameFor = (kind: ProjectSource['kind'], primary = false) => primary
    ? kind === 'camera' ? 'Câmera principal' : 'Tela principal'
    : `${kind === 'camera' ? 'Câmera' : kind === 'screen' ? 'Tela' : 'Mídia'} ${sources.filter(source => source.kind === kind).length + 1}`;
  const add = (kind: ProjectSource['kind'], options: Partial<Omit<ProjectSource, 'id' | 'kind'>> = {}, id = `source-${crypto.randomUUID()}`) => {
    const source: ProjectSource = { id, kind, name: nameFor(kind, options.primary), ...options };
    sources.push(source);
    byId.set(id, source);
    return source;
  };

  // Register old explicit identities first, so standard placeholders can reuse an
  // already captured screen rather than creating an unrelated primary screen.
  for (const scene of scenes) for (const layer of scene.appearance.layers) {
    if ((layer.kind !== 'camera' && layer.kind !== 'screen') || !layer.sourceId) continue;
    let source = byId.get(layer.sourceId);
    if (!source) {
      const kind = layer.assetId ? 'media' : layer.kind;
      source = add(kind, {
        name: layer.assetId ? layer.name : nameFor(kind),
        ...(kind === 'camera' && cameraDevice(scene) ? { deviceId: cameraDevice(scene) } : {}),
        ...(layer.assetId ? { assetId: layer.assetId } : {}),
      }, layer.sourceId);
    } else if (layer.assetId && !source.assetId) {
      // A legacy file layer may have reused a previously unconnected placeholder.
      source.kind = 'media';
      source.assetId = layer.assetId;
      delete source.primary;
    }
  }

  const cameras = new Map<string, ProjectSource>();
  const declaredCamera = catalogCamera;
  const preferredDevice = project.settings?.cameraDeviceId ?? declaredCamera?.deviceId;
  let primaryCamera = declaredCamera;
  let primaryScreen = sources.find(source => source.kind === 'screen' && source.primary);
  for (const scene of scenes) for (const layer of scene.appearance.layers) {
    if (layer.id !== layer.kind || !layer.sourceId) continue;
    const source = byId.get(layer.sourceId);
    if (source?.kind === 'camera') {
      const key = deviceKey(source.deviceId);
      if (!cameras.has(key)) cameras.set(key, source);
    } else if (source?.kind === 'screen' && !primaryScreen) primaryScreen = source;
  }
  for (const source of sources) if (source.kind === 'camera' && !cameras.has(deviceKey(source.deviceId))) cameras.set(deviceKey(source.deviceId), source);
  primaryCamera ??= cameras.get(deviceKey(preferredDevice));
  primaryScreen ??= sources.find(source => source.kind === 'screen');

  const bind = (layer: SceneLayer, source: ProjectSource): SceneLayer => ({
    ...layer,
    sourceId: source.id,
    ...(source.kind === 'media' ? { assetId: source.assetId ?? layer.assetId } : {}),
  });
  for (const scene of scenes) scene.appearance.layers = scene.appearance.layers.map(layer => {
    if (layer.kind !== 'camera' && layer.kind !== 'screen') return layer;
    if (layer.sourceId) return bind(layer, byId.get(layer.sourceId)!);
    if (layer.assetId) return bind(layer, add('media', { name: layer.name, assetId: layer.assetId }));
    const standard = layer.id === layer.kind;
    const deviceId = cameraDevice(scene);
    if (standard && layer.kind === 'camera') {
      const key = deviceKey(deviceId);
      let source = cameras.get(key);
      if (!source) {
        source = add('camera', {
          name: nameFor('camera', key === deviceKey(preferredDevice)),
          ...(deviceId ? { deviceId } : {}),
        });
        cameras.set(key, source);
      }
      if (!primaryCamera && key === deviceKey(preferredDevice)) primaryCamera = source;
      return bind(layer, source);
    }
    if (standard && layer.kind === 'screen') {
      primaryScreen ??= add('screen', { name: nameFor('screen', true) });
      return bind(layer, primaryScreen);
    }
    return bind(layer, add(layer.kind, { ...(layer.kind === 'camera' && deviceId ? { deviceId } : {}) }));
  });
  primaryCamera ??= sources.find(source => source.kind === 'camera');
  for (const source of sources) {
    if (source.kind === 'camera' || source.kind === 'screen') {
      if (source === primaryCamera || source === primaryScreen) source.primary = true;
      else delete source.primary;
    }
  }
  return { ...project, scenes, sources };
}
