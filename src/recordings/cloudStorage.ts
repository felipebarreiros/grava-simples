import { upload } from '@vercel/blob/client';
import type { RecordingFile, RecordingResult, Orientation } from '../media/types';
import { readRecordingFiles, writeRecordingFiles } from '../media/storage';
import type { ProjectTake } from '../projects/store';
import { assertLocalAccount, getLocalAccount } from '../projects/keys';

export type CloudToken = () => Promise<string | null>;
export class CloudStorageError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'CloudStorageError'; }
}
export interface CloudRecording extends Omit<ProjectTake, 'cloud'> {
  localId: string;
  projectName: string;
  status: 'pending' | 'ready';
}
export interface CloudLibrary {
  configured: boolean;
  recordings: CloudRecording[];
  usedBytes: number;
  maxStorageBytes: number;
}
export async function cloudRequest(path: string, getToken: CloudToken, options: RequestInit = {}): Promise<any> {
  const account = getLocalAccount();
  const token = await getToken();
  assertLocalAccount(account);
  if (!account || !token) throw new Error('Entre novamente para acessar suas gravações.');
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` } });
  assertLocalAccount(account);
  const body = await response.json().catch(() => null);
  assertLocalAccount(account);
  if (!response.ok || !body) throw new CloudStorageError(typeof body?.error === 'string' ? body.error : 'Não foi possível acessar as gravações na nuvem.', response.status);
  return body;
}
export async function listCloudRecordings(getToken: CloudToken, signal?: AbortSignal): Promise<CloudLibrary> {
  const account = getLocalAccount();
  let path = '/api/recordings';
  let library: CloudLibrary | null = null;
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const value = await cloudRequest(path, getToken, { signal });
    assertLocalAccount(account);
    if (typeof value.configured !== 'boolean' || !Array.isArray(value.recordings)) throw new Error('A biblioteca na nuvem retornou uma resposta inválida.');
    if (!library) library = { ...value, recordings: [] };
    library!.recordings.push(...value.recordings);
    if (!value.nextCursor) return library!;
    if (typeof value.nextCursor !== 'string' || cursors.has(value.nextCursor)) throw new Error('Não foi possível atualizar toda a biblioteca. Tente novamente.');
    cursors.add(value.nextCursor);
    path = `/api/recordings?cursor=${encodeURIComponent(value.nextCursor)}`;
  }
  throw new Error('A biblioteca é muito grande para atualizar de uma vez. Nenhuma cópia local foi removida.');
}
export async function uploadCloudRecording(take: ProjectTake, projectName: string, getToken: CloudToken, onProgress?: (value: number) => void, signal?: AbortSignal): Promise<CloudRecording> {
  const account = getLocalAccount();
  const files = await readRecordingFiles(take.id, account);
  assertLocalAccount(account);
  const reservation = await cloudRequest('/api/recordings', getToken, { method: 'POST', signal, body: JSON.stringify({ action: 'reserve', take, projectName }) });
  if (reservation.recording.status === 'ready') return reservation.recording;
  // A retry after both uploads succeeded should not transfer the originals again.
  try {
    const existing = await cloudRequest('/api/recordings', getToken, { method: 'POST', signal, body: JSON.stringify({ action: 'finalize', recordingId: reservation.recording.id }) });
    return existing.recording;
  } catch (error) { if (signal?.aborted || getLocalAccount() !== account || !(error instanceof CloudStorageError) || error.status !== 409) throw error; }
  for (const [index, orientation] of (['landscape', 'portrait'] as const).entries()) {
    assertLocalAccount(account);
    const token = await getToken();
    assertLocalAccount(account);
    if (!token) throw new Error('Entre novamente para salvar sua gravação.');
    if (reservation.uploads[orientation]?.uploaded) continue;
    try {
      await upload(reservation.uploads[orientation].pathname, files[orientation], {
        access: 'private', handleUploadUrl: '/api/recordings-upload', headers: { Authorization: `Bearer ${token}` },
        contentType: take[orientation].mimeType.split(';')[0], multipart: true,
        clientPayload: JSON.stringify({ recordingId: reservation.recording.id, orientation }),
        abortSignal: signal,
        onUploadProgress: progress => onProgress?.(Math.round((index * 100 + progress.percentage) / 2)),
      });
    } catch (error) {
      // An interrupted previous attempt may already have committed this exact object.
      if (signal?.aborted || getLocalAccount() !== account) throw error;
      const refreshed = await cloudRequest('/api/recordings', getToken, { method: 'POST', signal, body: JSON.stringify({ action: 'reserve', take, projectName }) });
      if (!refreshed.uploads?.[orientation]?.uploaded) throw error;
    }
  }
  assertLocalAccount(account);
  const completed = await cloudRequest('/api/recordings', getToken, { method: 'POST', signal, body: JSON.stringify({ action: 'finalize', recordingId: reservation.recording.id }) });
  onProgress?.(100);
  return completed.recording;
}
export async function deleteCloudRecording(id: string, getToken: CloudToken): Promise<void> {
  const result = await cloudRequest(`/api/recordings?recordingId=${encodeURIComponent(id)}`, getToken, { method: 'DELETE' });
  if (result.deleted !== true) throw new Error('Não foi possível confirmar a exclusão da cópia na nuvem.');
}
export async function refreshCloudMediaUrl(id: string, orientation: Orientation, getToken: CloudToken): Promise<string> {
  const body = await cloudRequest(`/api/recordings?recordingId=${encodeURIComponent(id)}&orientation=${orientation}`, getToken);
  const url = new URL(body.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.private.blob.vercel-storage.com')) throw new Error('O endereço da gravação é inválido.');
  return url.href;
}
/** Playback streams private signed media; it does not silently cache two complete videos. */
export async function openCloudRecording(take: ProjectTake, getToken: CloudToken): Promise<RecordingResult> {
  if (!take.cloud) throw new Error('Esta gravação ainda não está salva na nuvem.');
  const account = getLocalAccount();
  const urls = await Promise.all((['landscape', 'portrait'] as const).map(orientation => refreshCloudMediaUrl(take.cloud!.id, orientation, getToken)));
  assertLocalAccount(account);
  const file = (orientation: Orientation, index: number): RecordingFile => ({ ...take[orientation], orientation, blob: new Blob([], { type: take[orientation].mimeType }), url: urls[index], durationMs: take.durationMs });
  return { id: take.id, startedAt: take.startedAt, stoppedAt: take.stoppedAt, warnings: take.warnings, landscape: file('landscape', 0), portrait: file('portrait', 1) };
}
/** Only export/transcription/offline download materializes a streamed file. */
export async function materializeRecordingFile(file: RecordingFile, signal?: AbortSignal, cloud?: { id: string; getToken: CloudToken }): Promise<RecordingFile> {
  if (file.blob.size) return file;
  const account = getLocalAccount();
  let response = await fetch(file.url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok && cloud && !signal?.aborted) {
    const renewed = await refreshCloudMediaUrl(cloud.id, file.orientation, cloud.getToken);
    response = await fetch(renewed, { signal, cache: 'no-store', credentials: 'omit' });
  }
  if (!response.ok) throw new Error('Não foi possível baixar o original. Reabra a gravação e tente novamente.');
  const blob = await response.blob();
  assertLocalAccount(account);
  if (blob.size !== file.size) throw new Error('O arquivo recebido está incompleto. Tente novamente.');
  return { ...file, blob };
}
export async function saveOfflineCopy(take: ProjectTake, getToken: CloudToken): Promise<void> {
  const account = getLocalAccount();
  const result = await openCloudRecording(take, getToken);
  const landscape = await materializeRecordingFile(result.landscape);
  const portrait = await materializeRecordingFile(result.portrait);
  assertLocalAccount(account);
  await writeRecordingFiles(take.id, { landscape: landscape.blob, portrait: portrait.blob }, account);
}

export async function getStoredCloudTranscript(id: string, getToken: CloudToken): Promise<{ transcript: import('./transcript').Transcript | null; version: number }> {
  return cloudRequest(`/api/recordings?recordingId=${encodeURIComponent(id)}&transcript=1`, getToken);
}
export async function saveStoredCloudTranscript(id: string, transcript: import('./transcript').Transcript | null, version: number, getToken: CloudToken): Promise<number> {
  const result = await cloudRequest('/api/recordings', getToken, { method: 'POST', body: JSON.stringify({ action: 'transcript', recordingId: id, transcript, expectedVersion: version }) });
  return result.version;
}
