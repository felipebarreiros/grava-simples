import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/react';
import { Cloud, CloudDownload, CloudUpload, HardDrive, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { claimLegacyRecordings, hasUnclaimedLegacyRecordings, mergeCloudRecordings, type Project, type ProjectTake } from '../projects/store';
import { assertLocalAccount, getLocalAccount, scopedLocalKey } from '../projects/keys';
import { listRecoverableRecordings } from '../media/storage';
import { listCloudRecordings, saveOfflineCopy, uploadCloudRecording, getStoredCloudTranscript, saveStoredCloudTranscript, type CloudLibrary } from '../recordings/cloudStorage';
import { removeOfflineCopy, trimCloudCache, touchCachedRecording } from '../recordings/cloudCache';
import { loadTranscript } from '../recordings/transcript';
import './CloudRecordingStorage.css';

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
const text = (error: unknown) => error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.';
export function useCloudRecordingLibrary(takes: ProjectTake[], projects: Project[], protectedIds: string[], busy: boolean, onChange: () => void) {
  const { getToken, userId } = useAuth();
  const token = useRef(getToken); token.current = getToken;
  const change = useRef(onChange); change.current = onChange;
  const live = useRef(true);
  const working = useRef(new Set<string>());
  const automaticAttempts = useRef(new Set<string>());
  const [library, setLibrary] = useState<CloudLibrary | null>(null);
  const [localIds, setLocalIds] = useState<string[]>([]);
  const [localBytes, setLocalBytes] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [operations, setOperations] = useState<Record<string, string>>({});
  const [legacy, setLegacy] = useState(hasUnclaimedLegacyRecordings);
  const [autoSince, setAutoSince] = useState(() => Number(localStorage.getItem(scopedLocalKey('grava-cloud-auto-backup-v1'))) || 0);
  const protectedRef = useRef(protectedIds); protectedRef.current = protectedIds;
  const busyRef = useRef(busy); busyRef.current = busy;
  const mountedAccount = useRef(getLocalAccount());
  function valid() { return live.current && getLocalAccount() === mountedAccount.current; }
  async function refreshLocal() {
    const items = await listRecoverableRecordings(mountedAccount.current);
    if (!valid()) return;
    setLocalIds(items.map(item => item.id));
    setLocalBytes(items.reduce((sum, item) => sum + item.landscapeBytes + item.portraitBytes, 0));
  }
  async function refresh(signal?: AbortSignal, trim = false) {
    if (!valid() || !userId) return;
    setLoading(true);
    try {
      const remote = await listCloudRecordings(() => token.current(), signal);
      if (!valid()) return;
      setLibrary(remote);
      if (remote.configured) {
        mergeCloudRecordings(remote.recordings);
        change.current();
        if (trim && !busyRef.current) await trimCloudCache(remote.recordings, protectedRef.current);
      }
      await refreshLocal();
    } catch (failure) { if (valid() && !signal?.aborted) setError(text(failure)); }
    finally { if (valid()) setLoading(false); }
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void refresh(controller.signal, true);
    return () => { live.current = false; controller.abort(); };
  }, [userId]);
  useEffect(() => { void refreshLocal(); }, [takes]);
  async function operation(id: string, label: string, work: () => Promise<void>) {
    if (working.current.has(id) || !valid()) return;
    working.current.add(id); setOperations(previous => ({ ...previous, [id]: label })); setError('');
    try { await work(); if (valid()) await refresh(undefined, true); }
    catch (failure) { if (valid()) setError(text(failure)); }
    finally { working.current.delete(id); if (valid()) setOperations(previous => { const next = { ...previous }; delete next[id]; return next; }); }
  }
  async function uploadTake(take: ProjectTake) {
    const project = projects.find(item => item.id === take.projectId);
    await operation(take.id, 'Enviando…', async () => {
      const saved = await uploadCloudRecording(take, project?.name ?? 'Meu projeto', () => token.current(), percentage => {
        if (valid()) setOperations(previous => ({ ...previous, [take.id]: `Enviando ${percentage}%` }));
      });
      if (!valid()) return;
      mergeCloudRecordings([saved]); change.current();
      const transcript = loadTranscript(take.id);
      if (transcript) {
        const remote = await getStoredCloudTranscript(saved.id, () => token.current());
        if (!remote.transcript && remote.version === 0) await saveStoredCloudTranscript(saved.id, transcript, 0, () => token.current());
      }
    });
  }
  useEffect(() => {
    if (!autoSince || !library?.configured || busy) return;
    const next = takes.find(take => !take.cloud && take.createdAt >= autoSince && localIds.includes(take.id) && !working.current.has(take.id) && !automaticAttempts.current.has(take.id));
    if (next) { automaticAttempts.current.add(next.id); void uploadTake(next); }
  }, [takes, localIds, autoSince, library?.configured, busy]);
  function setAutomatic(enabled: boolean) {
    const value = enabled ? Date.now() : 0;
    localStorage.setItem(scopedLocalKey('grava-cloud-auto-backup-v1'), String(value)); setAutoSince(value);
  }
  async function offline(take: ProjectTake) {
    await operation(take.id, 'Baixando cópia…', async () => { await saveOfflineCopy(take, () => token.current()); if (valid()) touchCachedRecording(take.id); });
  }
  async function removeLocal(take: ProjectTake) {
    await operation(take.id, 'Liberando espaço…', async () => {
      const fresh = await listCloudRecordings(() => token.current());
      if (!valid()) return;
      await removeOfflineCopy(take.id, fresh.recordings);
    });
  }
  async function importLegacy() {
    await operation('legacy', 'Importando…', async () => { await claimLegacyRecordings(); if (valid()) { setLegacy(hasUnclaimedLegacyRecordings()); change.current(); } });
  }
  return { library, localIds, localBytes, error, loading, operations, autoSince, refresh, uploadTake, offline, removeLocal, importLegacy, legacy, setAutomatic, busy, protectedIds };
}
export type CloudLibraryModel = ReturnType<typeof useCloudRecordingLibrary>;
export function CloudRecordingStorage({ model }: { model: CloudLibraryModel }) {
  return <section className="cloud-storage" aria-label="Armazenamento das gravações" data-testid="cloud-storage">
    <div className="cloud-storage-summary"><Cloud size={17} /><span>{model.library?.configured ? `Nuvem: ${size(model.library.usedBytes)} de ${size(model.library.maxStorageBytes)}` : model.loading ? 'Conectando sua biblioteca…' : 'Backup na nuvem indisponível'}</span><span><HardDrive size={15} /> Neste navegador: {size(model.localBytes)}</span><Button variant="ghost" size="sm" disabled={model.loading || model.busy} onClick={() => void model.refresh(undefined, true)} aria-label="Atualizar biblioteca na nuvem"><RefreshCw size={14} /></Button></div>
    {model.library?.configured && <label className="cloud-auto"><input type="checkbox" checked={Boolean(model.autoSince)} disabled={model.busy} onChange={event => model.setAutomatic(event.target.checked)} /> Fazer backup automático das próximas gravações</label>}
    <p className="cloud-storage-note">Cópias com backup confirmado podem sair do cache ao atingir 1 GB ou quando faltar espaço. Originais sem backup são preservados.</p>
    {model.legacy && <div className="cloud-legacy"><p>Há gravações anteriores neste navegador. Importe-as apenas se forem suas; elas não serão enviadas automaticamente.</p><Button variant="outline" size="sm" disabled={model.busy || Boolean(model.operations.legacy)} onClick={() => void model.importLegacy()}>{model.operations.legacy || 'Importar minhas gravações deste navegador'}</Button></div>}
    {model.error && <p className="cloud-storage-error" role="alert">{model.error}</p>}
  </section>;
}
export function CloudRecordingActions({ take, model }: { take: ProjectTake; model: CloudLibraryModel }) {
  const local = model.localIds.includes(take.id);
  const label = model.operations[take.id];
  return <div className="cloud-recording-actions" data-testid={`cloud-actions-${take.id}`}>
    <span>{take.cloud ? local ? 'Neste dispositivo + nuvem' : 'Na nuvem' : 'Somente neste dispositivo'}</span>
    {label ? <span role="status"><LoaderCircle size={13} className="spin" />{label}</span> : <>
      {!take.cloud && model.library?.configured && <Button variant="ghost" size="sm" disabled={model.busy || !local} onClick={() => void model.uploadTake(take)}><CloudUpload size={14} />Salvar na nuvem</Button>}
      {take.cloud && !local && <Button variant="ghost" size="sm" disabled={model.busy} onClick={() => void model.offline(take)}><CloudDownload size={14} />Baixar cópia local</Button>}
      {take.cloud && local && <Button variant="ghost" size="sm" disabled={model.busy || model.protectedIds.includes(take.id)} onClick={() => void model.removeLocal(take)}>Liberar cópia local</Button>}
    </>}
  </div>;
}
