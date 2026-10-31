import { assertLocalAccount, getLocalAccount, scopedLocalKey } from '../projects/keys.ts';
import type { CloudRecording } from './cloudStorage';

export const DEFAULT_CACHE_BYTES = 1024 * 1024 * 1024;
const key = () => scopedLocalKey('grava-cloud-cache-access-v1');
export function touchCachedRecording(id: string): void {
  try { const dates = JSON.parse(localStorage.getItem(key()) || '{}'); dates[id] = Date.now(); localStorage.setItem(key(), JSON.stringify(dates)); } catch { /* Eviction falls back to creation dates. */ }
}
export function cacheCandidates(records: Array<{ id: string; createdAt: number; landscapeBytes: number; portraitBytes: number }>, remote: CloudRecording[], access: Record<string, number>, protectedIds: string[], limitBytes: number): string[] {
  let total = records.reduce((sum, item) => sum + item.landscapeBytes + item.portraitBytes, 0);
  const verified = new Map(remote.filter(item => item.status === 'ready').map(item => [item.localId, item]));
  const eligible = records.filter(item => {
    const cloud = verified.get(item.id);
    return cloud && !protectedIds.includes(item.id) && cloud.landscape.size === item.landscapeBytes && cloud.portrait.size === item.portraitBytes;
  }).sort((a, b) => (access[a.id] ?? a.createdAt) - (access[b.id] ?? b.createdAt));
  const result: string[] = [];
  for (const item of eligible) {
    if (total <= limitBytes) break;
    result.push(item.id); total -= item.landscapeBytes + item.portraitBytes;
  }
  return result;
}
/** Call with a fresh authenticated catalogue; a stale local receipt never permits eviction. */
export async function trimCloudCache(remote: CloudRecording[], protectedIds: string[] = []): Promise<string[]> {
  const account = getLocalAccount();
  const { deleteRecordingFiles, listRecoverableRecordings } = await import('../media/storage.ts');
  assertLocalAccount(account);
  const records = await listRecoverableRecordings(account);
  const estimate = await navigator.storage?.estimate?.().catch(() => ({} as StorageEstimate)) ?? {};
  assertLocalAccount(account);
  let dates: Record<string, number> = {};
  try { dates = JSON.parse(localStorage.getItem(key()) || '{}'); } catch { /* Unknown access dates use creation date. */ }
  const quotaBudget = estimate.quota ? Math.floor(estimate.quota * 0.2) : DEFAULT_CACHE_BYTES;
  const recordingBytes = records.reduce((sum, item) => sum + item.landscapeBytes + item.portraitBytes, 0);
  const pressureBudget = estimate.quota && estimate.usage ? Math.max(0, recordingBytes - Math.max(0, estimate.usage - estimate.quota * 0.8)) : DEFAULT_CACHE_BYTES;
  const limit = Math.min(DEFAULT_CACHE_BYTES, quotaBudget, pressureBudget);
  const evicted = cacheCandidates(records, remote, dates, protectedIds, limit);
  for (const id of evicted) { assertLocalAccount(account); await deleteRecordingFiles(id, account); }
  return evicted;
}
export async function removeOfflineCopy(id: string, remote: CloudRecording[]): Promise<void> {
  const account = getLocalAccount();
  const { deleteRecordingFiles, listRecoverableRecordings } = await import('../media/storage.ts');
  assertLocalAccount(account);
  const record = (await listRecoverableRecordings(account)).find(item => item.id === id);
  const cloud = remote.find(item => item.localId === id && item.status === 'ready');
  assertLocalAccount(account);
  if (!record) return;
  if (!cloud || cloud.landscape.size !== record.landscapeBytes || cloud.portrait.size !== record.portraitBytes) throw new Error('Confirme primeiro o backup completo desta gravação.');
  await deleteRecordingFiles(id, account);
}
