import type {
  CreateHotmartCourseInput, GetHotmartSessionToken, HotmartConnection, HotmartCourse,
  HotmartCourseDetail, HotmartMembership, HotmartModule, HotmartPublishResult,
  HotmartUploadProgress, HotmartVideoInput,
} from './types';

export class HotmartRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}
async function request<T>(getToken: GetHotmartSessionToken, action: string, body?: Record<string, unknown>, signal?: AbortSignal, query: Record<string, string> = {}): Promise<T> {
  signal?.throwIfAborted();
  const token = await getToken();
  signal?.throwIfAborted();
  if (!token) throw new HotmartRequestError('Entre novamente na sua conta para conectar a Hotmart.', 401);
  const url = new URL('/api/hotmart', location.origin);
  url.search = new URLSearchParams({ action, ...query }).toString();
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ action, ...body }) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55000)]) : AbortSignal.timeout(55000),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new HotmartRequestError('A conexão com a Hotmart está indisponível neste servidor.', 503);
  const value = await response.json();
  if (!response.ok) throw new HotmartRequestError(typeof value.error === 'string' ? value.error : 'Não foi possível concluir a operação na Hotmart.', response.status, value.code);
  return value as T;
}
const pendingMutations = new Map<string, string>();
const mutationFlights = new Map<string, Promise<unknown>>();
function localOwner(token: string | null): string {
  if (!token) throw new HotmartRequestError('Entre novamente na sua conta para conectar a Hotmart.', 401);
  try {
    const subject = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
    if (typeof subject === 'string' && /^user_[\w-]+$/.test(subject)) return subject;
  } catch { /* The namespace is not authentication; the server verifies every request. */ }
  // Opaque fixture/session tokens remain isolated from other local sessions as well.
  return `opaque:${token}`;
}
async function digestKey(prefix: string, value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `${prefix}:${Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')}`;
}
function forgetMutation(key: string): void {
  pendingMutations.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Memory still reflects completion. */ }
}
async function withMutationReceipt<T>(
  getToken: GetHotmartSessionToken, action: string, body: Record<string, unknown>, signal: AbortSignal | undefined,
  work: (requestId: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const key = await digestKey('grava-hotmart-mutation-v1', { owner: localOwner(await getToken()), action, body });
  signal?.throwIfAborted();
  const inflight = mutationFlights.get(key);
  if (inflight) return inflight as Promise<T>;
  let requestId = pendingMutations.get(key);
  if (!requestId) {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored && /^[a-f0-9-]{36}$/.test(stored)) requestId = stored;
    } catch { /* In-memory retries still use the same operation. */ }
  }
  requestId ||= crypto.randomUUID();
  pendingMutations.set(key, requestId);
  try { sessionStorage.setItem(key, requestId); } catch { /* Retain the in-memory receipt. */ }
  const operation = (async () => {
    try {
      const value = await work(requestId!);
      forgetMutation(key);
      return value;
    } catch (error) {
      // Provider failures can follow a successful write. Only known pre-write input
      // validation permits a fresh operation; ambiguous failures retain the UUID.
      if (error instanceof HotmartRequestError && error.code === 'invalid_input' && [400, 422].includes(error.status)) forgetMutation(key);
      throw error;
    } finally { mutationFlights.delete(key); }
  })();
  mutationFlights.set(key, operation);
  return operation;
}
const mutation = <T>(getToken: GetHotmartSessionToken, action: string, body: Record<string, unknown>, signal?: AbortSignal) =>
  withMutationReceipt(getToken, action, body, signal, requestId => request<T>(getToken, action, { requestId, ...body }, signal));
export const getHotmartConnection = (token: GetHotmartSessionToken, signal?: AbortSignal) => request<HotmartConnection>(token, 'status', undefined, signal);
export const startHotmartConnection = (token: GetHotmartSessionToken, returnTo = `${location.pathname}${location.search}${location.hash}`) => mutation<{ url: string }>(token, 'connect', { returnTo });
export const disconnectHotmart = (token: GetHotmartSessionToken) => mutation<{ connected: false }>(token, 'disconnect', {});
export const listHotmartCourses = (token: GetHotmartSessionToken, signal?: AbortSignal) => request<HotmartCourse[]>(token, 'courses', undefined, signal);
export const listHotmartMemberships = (token: GetHotmartSessionToken, signal?: AbortSignal) => request<HotmartMembership[]>(token, 'memberships', undefined, signal);
export const createHotmartMembership = (input: { name: string; slug: string }, token: GetHotmartSessionToken, signal?: AbortSignal) => mutation<HotmartMembership>(token, 'membership-create', input, signal);
export const getHotmartCourse = (courseId: string, token: GetHotmartSessionToken, signal?: AbortSignal) => request<HotmartCourseDetail>(token, 'course', undefined, signal, { courseId });
interface PendingCourse { pending: true; requestId: string }
export const createHotmartCourse = (input: CreateHotmartCourseInput, token: GetHotmartSessionToken, signal?: AbortSignal): Promise<HotmartCourse> =>
  withMutationReceipt(token, 'course-create', { input }, signal, async requestId => {
    let result = await request<HotmartCourse | PendingCourse>(token, 'course-create', { input, requestId }, signal);
    const deadline = Date.now() + 2 * 60 * 1000;
    while ('pending' in result && result.pending) {
      if (Date.now() >= deadline) throw new Error('A Hotmart ainda está criando o curso. Tente novamente para consultar o mesmo curso sem criar outro.');
      await wait(3000, signal);
      result = await request<HotmartCourse | PendingCourse>(token, 'course-resolve', { requestId }, signal);
    }
    return result as HotmartCourse;
  });
export const createHotmartModule = (courseId: string, input: { name: string }, token: GetHotmartSessionToken, signal?: AbortSignal) => mutation<HotmartModule>(token, 'module-create', { courseId, ...input }, signal);
export const renameHotmartModule = (courseId: string, moduleId: string, input: { name: string }, token: GetHotmartSessionToken, signal?: AbortSignal) => mutation<HotmartModule>(token, 'module-rename', { courseId, moduleId, ...input }, signal);
export const reorderHotmartModules = (courseId: string, moduleIds: string[], token: GetHotmartSessionToken, signal?: AbortSignal) => mutation<HotmartModule[]>(token, 'module-reorder', { courseId, moduleIds }, signal);

interface Part { partNumber: number; etag: string }
interface UploadJob {
  jobId: string;
  status: 'uploading' | 'processing' | 'ready' | 'completed' | 'aborted';
  partSize: number;
  partCount: number;
  result?: HotmartPublishResult;
}
interface Receipt { requestId: string; jobId?: string; parts: Part[] }
const memory = new Map<string, Receipt>();
function remember(key: string, receipt: Receipt): void {
  memory.set(key, receipt);
  try { sessionStorage.setItem(key, JSON.stringify(receipt)); } catch { /* An in-memory retry still works. */ }
}
function receiptFor(key: string): Receipt {
  const existing = memory.get(key);
  if (existing) return existing;
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (stored && /^[a-f0-9-]{36}$/.test(stored.requestId) && (!stored.jobId || /^[a-f0-9-]{36}$/.test(stored.jobId)) && Array.isArray(stored.parts)) {
      const receipt = { requestId: stored.requestId, jobId: stored.jobId, parts: stored.parts.filter((part: Part) => Number.isSafeInteger(part.partNumber) && typeof part.etag === 'string') };
      memory.set(key, receipt);
      return receipt;
    }
  } catch { /* Invalid or inaccessible session storage is ignored. */ }
  const receipt = { requestId: crypto.randomUUID(), parts: [] };
  remember(key, receipt);
  return receipt;
}
/** Bounded-memory content identity: fixed 8 MiB chunks and a SHA-256 digest tree. */
async function contentFingerprint(blob: Blob, signal?: AbortSignal): Promise<string> {
  const chunkSize = 8 * 1024 * 1024;
  const hashes: Uint8Array[] = [];
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    signal?.throwIfAborted();
    const bytes = await blob.slice(offset, Math.min(offset + chunkSize, blob.size)).arrayBuffer();
    signal?.throwIfAborted();
    hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }
  signal?.throwIfAborted();
  const header = new TextEncoder().encode(`grava-hotmart-content-v1:${blob.size}:${chunkSize}:`);
  const tree = new Uint8Array(header.length + hashes.length * 32);
  tree.set(header);
  hashes.forEach((hash, index) => tree.set(hash, header.length + index * 32));
  const digest = await crypto.subtle.digest('SHA-256', tree);
  signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function receiptKey(input: HotmartVideoInput, getToken: GetHotmartSessionToken, signal?: AbortSignal): Promise<string> {
  const owner = localOwner(await getToken());
  const content = await contentFingerprint(input.file.blob, signal);
  return digestKey('grava-hotmart-upload-v2', { owner, content, recordingId: input.recordingId, courseId: input.courseId, moduleId: input.moduleId, title: input.title, description: input.description, publish: input.publish, orientation: input.file.orientation, size: input.file.blob.size, fileName: input.file.fileName });
}
function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason || new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function putPart(url: string, headers: Record<string, string>, blob: Blob, progress: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    xhr.open('PUT', url);
    xhr.timeout = 180000;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onload = () => {
      cleanup();
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error('A Hotmart não confirmou uma parte do vídeo. Tente novamente para continuar o envio.'));
    };
    xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new Error('A conexão foi interrompida durante o envio. Tente novamente para continuar.')); };
    xhr.onabort = () => { cleanup(); reject(signal?.reason || new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { cleanup(); reject(signal.reason); return; }
    xhr.send(blob);
  });
}

/** Direct resumable S3 part uploads; the app server only handles metadata and signing. */
export async function publishHotmartVideo(
  input: HotmartVideoInput,
  getToken: GetHotmartSessionToken,
  onProgress?: (progress: HotmartUploadProgress) => void,
  signal?: AbortSignal,
): Promise<HotmartPublishResult> {
  const key = await receiptKey(input, getToken, signal);
  const receipt = receiptFor(key);
  let job: UploadJob;
  if (receipt.jobId) job = await request<UploadJob>(getToken, 'upload-status', undefined, signal, { jobId: receipt.jobId });
  else {
    job = await request<UploadJob>(getToken, 'upload-start', {
      requestId: receipt.requestId, courseId: input.courseId, moduleId: input.moduleId,
      title: input.title, description: input.description, publish: input.publish,
      recordingId: input.recordingId, fileName: input.file.fileName, fileSize: input.file.blob.size,
      fileType: input.file.mimeType.split(';')[0], durationSeconds: input.file.durationMs / 1000,
    }, signal);
    receipt.jobId = job.jobId;
    remember(key, receipt);
  }
  if (job.status === 'completed' && job.result) return job.result;
  if (job.status === 'aborted') throw new Error('Este envio foi cancelado. Altere o destino ou os detalhes para iniciar outro envio.');
  if (job.status === 'uploading') {
    const transfers = new AbortController();
    const transferSignal = signal ? AbortSignal.any([signal, transfers.signal]) : transfers.signal;
    const activeBytes = new Map<number, number>();
    let completedBytes = receipt.parts.reduce((sum, part) => sum + Math.min(job.partSize, input.file.blob.size - (part.partNumber - 1) * job.partSize), 0);
    const update = () => onProgress?.({ phase: 'uploading', percentage: Math.min(100, (completedBytes + [...activeBytes.values()].reduce((a, b) => a + b, 0)) / input.file.blob.size * 100) });
    update();
    const pending = Array.from({ length: job.partCount }, (_, index) => index + 1).filter(number => !receipt.parts.some(part => part.partNumber === number));
    // Sequential signing, two concurrent byte transfers, bounded by Hotmart's part layout.
    const worker = async () => {
      while (pending.length) {
        transferSignal.throwIfAborted();
        const partNumber = pending.shift()!;
        const blob = input.file.blob.slice((partNumber - 1) * job.partSize, Math.min(partNumber * job.partSize, input.file.blob.size));
        let etag = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const signed = await request<{ url: string; headers: Record<string, string> }>(getToken, 'upload-sign', { jobId: job.jobId, partNumber }, transferSignal);
            etag = await putPart(signed.url, signed.headers, blob, bytes => { activeBytes.set(partNumber, bytes); update(); }, transferSignal);
            break;
          } catch (error) {
            activeBytes.delete(partNumber); update();
            if (transferSignal.aborted || attempt === 2 || (error instanceof HotmartRequestError && error.status < 500)) throw error;
            await wait(1000 * (attempt + 1), transferSignal);
          }
        }
        activeBytes.delete(partNumber); completedBytes += blob.size;
        receipt.parts.push({ partNumber, etag }); remember(key, receipt); update();
      }
    };
    const workers = [worker(), worker()];
    try { await Promise.all(workers); }
    catch (error) {
      transfers.abort(error);
      // A failed send cannot leave a sibling transfer changing receipts after the
      // caller has shown an error and made retry available again.
      await Promise.allSettled(workers);
      throw error;
    }
    job = await request<UploadJob>(getToken, 'upload-complete', { jobId: job.jobId, parts: receipt.parts.sort((a, b) => a.partNumber - b.partNumber) }, signal);
  }
  const deadline = Date.now() + 15 * 60 * 1000;
  while (job.status === 'processing') {
    onProgress?.({ phase: 'processing', percentage: 100 });
    if (Date.now() > deadline) throw new Error('A Hotmart ainda está processando o vídeo. Tente novamente mais tarde para continuar sem reenviar o arquivo.');
    await wait(3000, signal);
    job = await request<UploadJob>(getToken, 'upload-status', undefined, signal, { jobId: job.jobId });
  }
  if (job.status === 'completed' && job.result) return job.result;
  if (job.status !== 'ready') throw new Error('A Hotmart ainda não confirmou o vídeo. Atualize e tente novamente.');
  signal?.throwIfAborted();
  onProgress?.({ phase: 'creating', percentage: 100 });
  return request<HotmartPublishResult>(getToken, 'lesson-create', { jobId: job.jobId }, signal);
}
