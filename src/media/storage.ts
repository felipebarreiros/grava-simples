import type { CapacityInfo, Orientation, RecoveryRecording } from './types';
import { getLocalAccount, scopedStorageName } from '../projects/keys.ts';

const DB_NAME = 'grava-simples-recordings';
const ROOT_NAME = 'grava-simples-recordings';
type Metadata = RecoveryRecording;
type StoredChunk = { id: string; orientation: Orientation; sequence: number; data: Blob };

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('Local storage failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('The local file could not be written.'));
  });
}

async function openDatabase(account = getLocalAccount()): Promise<IDBDatabase> {
  const opening = indexedDB.open(scopedStorageName(DB_NAME, account), 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('sessions', { keyPath: 'id' });
    opening.result.createObjectStore('chunks', { keyPath: ['id', 'orientation', 'sequence'] });
  };
  return request(opening);
}

async function opfsRoot(account = getLocalAccount()): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new Error('OPFS is unavailable.');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(scopedStorageName(ROOT_NAME, account), { create: true });
}

export class RecordingStore {
  readonly id = `recording-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  kind: 'opfs' | 'indexeddb' = 'indexeddb';
  private directory?: FileSystemDirectoryHandle;
  private database?: IDBDatabase;
  private writers: Partial<Record<Orientation, FileSystemWritableFileStream>> = {};
  private sequences: Record<Orientation, number> = { landscape: 0, portrait: 0 };
  private metadata: Metadata;
  private closed = false;
  private account = getLocalAccount();

  constructor(private mimeType: string) {
    this.metadata = { id: this.id, createdAt: Date.now(), completed: false, mimeType, landscapeBytes: 0, portraitBytes: 0 };
  }

  setMimeType(mimeType: string): void {
    this.mimeType = mimeType;
    this.metadata.mimeType = mimeType;
  }

  async open(): Promise<void> {
    try {
      this.directory = await (await opfsRoot(this.account)).getDirectoryHandle(this.id, { create: true });
      for (const orientation of ['landscape', 'portrait'] as const) {
        const file = await this.directory.getFileHandle(orientation, { create: true });
        this.writers[orientation] = await file.createWritable();
      }
      this.kind = 'opfs';
    } catch {
      for (const writer of Object.values(this.writers)) await writer?.abort().catch(() => undefined);
      this.writers = {};
      this.directory = undefined;
      this.database = await openDatabase(this.account);
    }
    await this.saveMetadata();
  }

  async write(orientation: Orientation, data: Blob): Promise<void> {
    if (this.closed) throw new Error('The recording file is already closed.');
    if (this.kind === 'opfs') {
      await this.writers[orientation]!.write(data);
    } else {
      const transaction = this.database!.transaction('chunks', 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore('chunks').put({ id: this.id, orientation, sequence: this.sequences[orientation]++, data } satisfies StoredChunk);
      await done;
    }
    if (orientation === 'landscape') this.metadata.landscapeBytes += data.size;
    else this.metadata.portraitBytes += data.size;
  }

  async finalize(completed: boolean): Promise<Record<Orientation, Blob>> {
    this.closed = true;
    try {
      const closing = await Promise.allSettled(Object.values(this.writers).map(writer => writer!.close()));
      const failure = closing.find(result => result.status === 'rejected');
      this.metadata.completed = completed && !failure;
      await this.saveMetadata();
      if (failure?.status === 'rejected') throw failure.reason;
      const files = await Promise.all((['landscape', 'portrait'] as const).map(async orientation => {
        if (this.kind === 'opfs') {
          const raw = await (await this.directory!.getFileHandle(orientation)).getFile();
          return new Blob([raw], { type: this.mimeType });
        }
        // IndexedDB bounds memory while recording. Exporting joins its persisted chunks.
        const transaction = this.database!.transaction('chunks', 'readonly');
        const chunks = await request(transaction.objectStore('chunks').getAll(IDBKeyRange.bound([this.id, orientation, 0], [this.id, orientation, Number.MAX_SAFE_INTEGER]))) as StoredChunk[];
        return new Blob(chunks.map(chunk => chunk.data), { type: this.mimeType });
      }));
      return { landscape: files[0], portrait: files[1] };
    } finally { this.database?.close(); }
  }

  async abort(): Promise<void> {
    if (this.closed) { this.database?.close(); return; }
    this.closed = true;
    await Promise.allSettled(Object.values(this.writers).map(writer => writer!.close()));
    await this.saveMetadata().catch(() => undefined);
    this.database?.close();
  }

  private async saveMetadata(): Promise<void> {
    if (this.directory) {
      const writer = await (await this.directory.getFileHandle('metadata.json', { create: true })).createWritable();
      await writer.write(JSON.stringify(this.metadata));
      await writer.close();
    } else if (this.database) {
      const transaction = this.database.transaction('sessions', 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore('sessions').put(this.metadata);
      await done;
    }
  }
}

export async function estimateCapacity(storage: 'opfs' | 'indexeddb', videoBitsPerSecond: number): Promise<CapacityInfo> {
  const estimate: StorageEstimate = await navigator.storage?.estimate?.().catch((): StorageEstimate => ({})) ?? {};
  const available = estimate.quota === undefined ? undefined : Math.max(0, estimate.quota - (estimate.usage ?? 0));
  const estimatedBytesPerMinute = (videoBitsPerSecond * 2 + 256_000) * 60 / 8;
  return {
    storage, usage: estimate.usage, quota: estimate.quota, available,
    estimatedBytesPerMinute,
    estimatedMinutes: available === undefined ? undefined : available / estimatedBytesPerMinute,
    persistent: await navigator.storage?.persisted?.().catch(() => false) ?? false,
    note: 'Estimate only; recording duration is not guaranteed. Browsers may limit memory, storage, capture, or background tabs. IndexedDB export joins chunks in memory; OPFS files stay on disk. Crash recovery is not guaranteed.',
  };
}

export async function listRecoverableRecordings(account = getLocalAccount()): Promise<RecoveryRecording[]> {
  const records: RecoveryRecording[] = [];
  try {
    const root = await opfsRoot(account);
    for await (const directory of (root as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (directory.kind !== 'directory') continue;
      try {
        const handle = directory as FileSystemDirectoryHandle;
        const metadata = JSON.parse(await (await (await handle.getFileHandle('metadata.json')).getFile()).text()) as Metadata;
        const files = await Promise.all((['landscape', 'portrait'] as const).map(async name => (await (await handle.getFileHandle(name)).getFile()).size));
        records.push({ ...metadata, landscapeBytes: files[0], portraitBytes: files[1] });
      } catch { /* A partially created directory has no recoverable recording. */ }
    }
  } catch { /* OPFS may be disabled; IndexedDB is still inspected. */ }
  try {
    const database = await openDatabase(account);
    records.push(...await request(database.transaction('sessions', 'readonly').objectStore('sessions').getAll()) as Metadata[]);
    database.close();
  } catch { /* No accessible local database. */ }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

/** Reopen a completed take without keeping its exported Blob in application memory. */
export async function readRecordingFiles(id: string, account = getLocalAccount()): Promise<Record<Orientation, Blob>> {
  try {
    const directory = await (await opfsRoot(account)).getDirectoryHandle(id);
    const metadata = JSON.parse(await (await (await directory.getFileHandle('metadata.json')).getFile()).text()) as Metadata;
    const files = await Promise.all((['landscape', 'portrait'] as const).map(async orientation => {
      const raw = await (await directory.getFileHandle(orientation)).getFile();
      return new Blob([raw], { type: metadata.mimeType });
    }));
    return { landscape: files[0], portrait: files[1] };
  } catch { /* The browser may have used IndexedDB instead of OPFS. */ }

  const database = await openDatabase(account);
  try {
    const metadata = await request(database.transaction('sessions', 'readonly').objectStore('sessions').get(id)) as Metadata | undefined;
    if (!metadata) throw new Error('Este vídeo não está mais disponível neste navegador.');
    const files = await Promise.all((['landscape', 'portrait'] as const).map(async orientation => {
      const chunks = await request(database.transaction('chunks', 'readonly').objectStore('chunks').getAll(IDBKeyRange.bound([id, orientation, 0], [id, orientation, Number.MAX_SAFE_INTEGER]))) as StoredChunk[];
      return new Blob(chunks.map(chunk => chunk.data), { type: metadata.mimeType });
    }));
    if (!files[0].size || !files[1].size) throw new Error('Os arquivos desta gravação não estão mais disponíveis.');
    return { landscape: files[0], portrait: files[1] };
  } finally { database.close(); }
}

/** Delete one take only; other projects and incomplete sessions are preserved. */
export async function deleteRecordingFiles(id: string, account = getLocalAccount()): Promise<void> {
  let root: FileSystemDirectoryHandle | undefined;
  try { root = await opfsRoot(account); } catch { /* IndexedDB is used when OPFS is unavailable. */ }
  if (root) {
    try { await root.removeEntry(id, { recursive: true }); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
  }
  const database = await openDatabase(account);
  try {
    const transaction = database.transaction(['sessions', 'chunks'], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('sessions').delete(id);
    transaction.objectStore('chunks').delete(IDBKeyRange.bound([id, ''], [id, '\uffff', Number.MAX_SAFE_INTEGER]));
    await done;
  } finally { database.close(); }
}

/** Delete only this app's staged files. Call only while no recording is active. */
export async function clearStagedRecordings(): Promise<void> {
  const account = getLocalAccount();
  let opfsFailure: unknown;
  if (navigator.storage?.getDirectory) {
    try {
      await (await navigator.storage.getDirectory()).removeEntry(scopedStorageName(ROOT_NAME, account), { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) opfsFailure = error;
    }
  }
  await new Promise<void>((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(scopedStorageName(DB_NAME, account));
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error ?? new Error('Staged recordings could not be cleared.'));
    deleting.onblocked = () => reject(new Error('Another tab is using staged recordings. Close its recording session and try again.'));
  });
  if (opfsFailure) throw opfsFailure;
}

/** Store an explicit offline copy under the original ID, without touching another account. */
export async function writeRecordingFiles(id: string, files: Record<Orientation, Blob>, account = getLocalAccount()): Promise<void> {
  if (!/^[\w-]{1,128}$/.test(id) || !files.landscape.size || !files.portrait.size) throw new Error('Arquivos da gravação inválidos.');
  const database = await openDatabase(account);
  try {
    const transaction = database.transaction(['sessions', 'chunks'], 'readwrite');
    const committed = transactionDone(transaction);
    transaction.objectStore('sessions').put({ id, createdAt: Date.now(), completed: true, mimeType: files.landscape.type || 'video/webm', landscapeBytes: files.landscape.size, portraitBytes: files.portrait.size } satisfies Metadata);
    transaction.objectStore('chunks').delete(IDBKeyRange.bound([id, ''], [id, '\uffff', Number.MAX_SAFE_INTEGER]));
    for (const orientation of ['landscape', 'portrait'] as const) transaction.objectStore('chunks').put({ id, orientation, sequence: 0, data: files[orientation] } satisfies StoredChunk);
    await committed;
  } finally { database.close(); }
}
