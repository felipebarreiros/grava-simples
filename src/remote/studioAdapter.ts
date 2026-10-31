import type { Project, ProjectScene } from '../projects/store';
import type { SceneLayer, StudioEvent } from '../media/types';
import type { RemoteSnapshot } from './types';

/** Layer reordering must not change the IDs OBS Blade uses for visibility. */
export function remoteItemIds(layers: Pick<SceneLayer, 'id'>[]): Map<string, number> {
  const result = new Map<string, number>(), used = new Set<number>();
  for (const layer of [...layers].sort((a, b) => a.id.localeCompare(b.id))) {
    let hash = 2166136261;
    for (let index = 0; index < layer.id.length; index++) hash = Math.imul(hash ^ layer.id.charCodeAt(index), 16777619);
    let id = (hash >>> 0) % 2147483646 + 1;
    while (used.has(id)) id = id % 2147483646 + 1;
    used.add(id); result.set(layer.id, id);
  }
  return result;
}

export function sceneSourcesReady(scene: ProjectScene, event: StudioEvent | undefined, hasSource: (id: string) => boolean): boolean {
  return (scene.appearance?.layers ?? []).every(layer => {
    if (!layer.visible || (layer.kind !== 'camera' && layer.kind !== 'screen')) return true;
    if (hasSource(layer.sourceId ?? layer.id)) return true;
    // Older projects can still refer to the prepared default inputs directly.
    return !layer.sourceId && !layer.assetId && event?.metrics.sources?.[layer.kind]?.live === true;
  });
}

export function studioRemoteSnapshot(project: Project, event: StudioEvent | undefined, options: {
  available: boolean; busy: boolean; matches: boolean; exporting: boolean; hasSource: (id: string) => boolean;
}): RemoteSnapshot {
  const scene = project.scenes.find(item => item.id === project.selectedSceneId);
  const prepared = event?.state === 'ready' || event?.state === 'complete';
  const ready = options.available && !options.busy && !options.exporting && options.matches && prepared
    && !!scene && sceneSourcesReady(scene, event, options.hasSource);
  const resolution = event?.config?.resolution ?? project.settings.resolution;
  const width = resolution === '4k' ? 3840 : resolution === '1080' ? 1920 : resolution === '720' ? 1280 : 640;
  return {
    projectId: project.id,
    projectName: project.name,
    scenes: project.scenes.map(item => {
      const layers = item.appearance?.layers ?? [], ids = remoteItemIds(layers);
      return { id: item.id, name: item.name, items: layers.map(layer => ({
        id: ids.get(layer.id)!, layerId: layer.id, sourceId: layer.sourceId ?? layer.id,
        name: layer.name, kind: layer.kind, visible: layer.visible,
      })) };
    }),
    sceneId: project.selectedSceneId,
    microphoneMuted: event?.controls.microphoneMuted ?? scene?.appearance?.microphoneMuted ?? false,
    microphoneGainDb: event?.controls.microphoneGainDb ?? scene?.appearance?.microphoneGainDb ?? 0,
    recordState: event?.state === 'recording' ? 'recording' : event?.state === 'stopping' ? 'stopping' : ready ? 'ready' : 'unavailable',
    elapsedMs: event?.metrics.elapsedMs ?? 0,
    bytes: (event?.metrics.bytes.landscape ?? 0) + (event?.metrics.bytes.portrait ?? 0),
    fps: event?.metrics.measuredFps ?? 0,
    ready,
    outputWidth: width, outputHeight: Math.round(width * 9 / 16),
    targetFps: event?.config?.fps ?? project.settings.fps,
  };
}
