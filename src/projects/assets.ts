import { scopedStorageName, WORKSPACE_STORAGE_KEY } from './keys';

const DB_NAME = 'grava-simples-scene-assets';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

interface SceneAsset {
  id: string;
  projectId: string;
  sceneId: string;
  createdAt: number;
  blob: Blob;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('Não foi possível acessar as imagens deste projeto.'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Não foi possível salvar a imagem neste navegador.'));
  });
}

async function open(name: string): Promise<IDBDatabase> {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore('assets', { keyPath: 'id' });
    store.createIndex('project', 'projectId');
    store.createIndex('scene', ['projectId', 'sceneId']);
  };
  return request(opening);
}

/** Immutable asset IDs allow duplicated scenes to safely share the same image. */
export async function saveSceneAsset(projectId: string, sceneId: string, blob: Blob): Promise<string> {
  if (!projectId || !sceneId) throw new Error('Escolha um projeto e uma cena antes de adicionar a imagem.');
  const video = blob.type.startsWith('video/');
  if (!IMAGE_TYPES.has(blob.type) && !video) throw new Error('Escolha uma imagem ou um arquivo de vídeo.');
  if (!blob.size || blob.size > (video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) throw new Error(video ? 'Escolha um vídeo de até 256 MB.' : 'Escolha uma imagem de até 25 MB.');
  const database = await open(scopedStorageName(DB_NAME));
  try {
    const transaction = database.transaction('assets', 'readwrite');
    const committed = done(transaction);
    const asset: SceneAsset = { id: `scene-asset-${crypto.randomUUID()}`, projectId, sceneId, createdAt: Date.now(), blob };
    transaction.objectStore('assets').put(asset);
    await committed;
    return asset.id;
  } finally { database.close(); }
}

export async function readSceneAsset(assetId: string): Promise<Blob | undefined> {
  const database = await open(scopedStorageName(DB_NAME));
  try {
    const asset = await request(database.transaction('assets', 'readonly').objectStore('assets').get(assetId)) as SceneAsset | undefined;
    return asset?.blob;
  } finally { database.close(); }
}

/** Keep shared assets alive when a duplicate scene still uses the original image. */
function projectAssetReferences(workspaceKey = WORKSPACE_STORAGE_KEY): { id: string; assets: string[] }[] {
  const raw = localStorage.getItem(workspaceKey);
  if (!raw) return [];
  const workspace = JSON.parse(raw) as { projects: { id: string; sources?: { assetId?: string }[]; scenes: { appearance?: { backgroundAssetId?: string; layers?: {assetId?:string}[] } }[] }[] };
  return workspace.projects.map(project => ({ id: project.id, assets: [
    ...(project.sources?.flatMap(source => source.assetId ? [source.assetId] : []) ?? []),
    ...project.scenes.flatMap(scene => [...(scene.appearance?.backgroundAssetId ? [scene.appearance.backgroundAssetId] : []), ...(scene.appearance?.layers?.flatMap(layer => layer.assetId ? [layer.assetId] : []) ?? [])]),
  ] }));
}

function referencedAssets(excludeProjectId?: string, workspaceKey = WORKSPACE_STORAGE_KEY): Set<string> {
  const ids = new Set<string>();
  for (const project of projectAssetReferences(workspaceKey)) {
    if (project.id === excludeProjectId) continue;
    for (const id of project.assets) ids.add(id);
  }
  return ids;
}

async function removeAssets(select: (store: IDBObjectStore) => IDBRequest<SceneAsset[]>, excludeProjectId?: string, include: (asset: SceneAsset) => boolean = () => true): Promise<void> {
  // Capture both namespaces before the first await. An account change cannot
  // make an old deletion inspect another account's current project references.
  const workspaceKey = WORKSPACE_STORAGE_KEY;
  const database = await open(scopedStorageName(DB_NAME));
  try {
    const assets = await request(select(database.transaction('assets', 'readonly').objectStore('assets')));
    const protectedIds = referencedAssets(excludeProjectId, workspaceKey);
    const transaction = database.transaction('assets', 'readwrite');
    const committed = done(transaction);
    for (const asset of assets) if (include(asset) && !protectedIds.has(asset.id)) transaction.objectStore('assets').delete(asset.id);
    await committed;
  } finally { database.close(); }
}

/** Removes this image only after it is no longer referenced by any saved scene. */
export async function deleteSceneAsset(assetId: string): Promise<void> {
  const workspaceKey = WORKSPACE_STORAGE_KEY;
  const database = await open(scopedStorageName(DB_NAME));
  try {
    if (referencedAssets(undefined, workspaceKey).has(assetId)) return;
    const transaction = database.transaction('assets', 'readwrite');
    const committed = done(transaction);
    transaction.objectStore('assets').delete(assetId);
    await committed;
  } finally { database.close(); }
}

/** Call after saving/removing a scene; currently referenced backgrounds are retained. */
export async function deleteSceneAssets(projectId: string, sceneId: string): Promise<void> {
  await removeAssets(store => store.index('scene').getAll([projectId, sceneId]));
}

/** Project deletion may remove its own references, while preserving cross-project copies. */
export async function deleteProjectSceneAssets(projectId: string): Promise<void> {
  const borrowedIds = new Set(projectAssetReferences().find(project => project.id === projectId)?.assets ?? []);
  // Include borrowed images so deleting the last project that references a shared
  // background also cleans it up even if the original owner was already deleted.
  await removeAssets(store => store.getAll(), projectId, asset => asset.projectId === projectId || borrowedIds.has(asset.id));
}
