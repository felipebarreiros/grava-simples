import { handleObsRequest, translateEvents, type ObsRequestResult } from './protocol.ts';
import { LOCAL_REMOTE_URL, localNetworkPermission, parseHelperMessage, type LocalPairing, type LocalPermission, type LocalRequest, type RemoteSocket, type SocketFactory } from './client.ts';
import type { RemoteCommand, RemoteCommandResult, RemoteSnapshot } from './types';

export type RemoteStatus = 'idle' | 'permission-required' | 'permission-denied' | 'connecting' | 'helper-missing' | 'waiting' | 'connected' | 'reconnecting' | 'in-use' | 'error';
export interface RemoteControlState { status: RemoteStatus; pairing?: LocalPairing; error?: string }
export interface RemoteControllerOptions {
  projectId: string;
  ownerId: string;
  getSnapshot: () => RemoteSnapshot;
  execute: (command: RemoteCommand) => Promise<RemoteCommandResult>;
  onChange: (state: RemoteControlState) => void;
  socket?: SocketFactory;
  permission?: () => Promise<LocalPermission>;
  intervalMs?: number;
  reconnectMs?: number;
  now?: () => number;
}
interface RequestEntry { fingerprint: string; result?: ObsRequestResult; receivedAt: number; request: LocalRequest }
const MUTATING = new Set(['SetCurrentProgramScene', 'SetSceneItemEnabled', 'SetInputMute', 'StartRecord', 'StopRecord']);
const failed = (comment: string, code = 207): ObsRequestResult => ({ requestStatus: { result: false, code, comment } });

/** Local control only: connection loss never changes capture or replays pending actions. */
export class RemoteController {
  private options: RemoteControllerOptions;
  private state: RemoteControlState = { status: 'idle' };
  private socket?: RemoteSocket;
  private generation = 0;
  private disposed = false;
  private enabled = true;
  private everConnected = false;
  private retries = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private previous?: RemoteSnapshot;
  private requests = new Map<string, RequestEntry>();
  private queue: RequestEntry[] = [];
  private workerGeneration?: number;
  private now: () => number;

  constructor(options: RemoteControllerOptions) { this.options = options; this.now = options.now ?? Date.now; }
  getState(): RemoteControlState { return this.state; }
  private update(patch: Partial<RemoteControlState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.options.onChange(this.state);
  }
  private current(generation: number): boolean {
    return !this.disposed && this.enabled && generation === this.generation && this.options.getSnapshot().projectId === this.options.projectId;
  }

  /** A user gesture opens the socket immediately, allowing the browser's one-time permission prompt. */
  async start(userInitiated = false): Promise<void> {
    if (this.disposed || this.socket) return;
    this.enabled = true;
    const generation = ++this.generation;
    clearTimeout(this.timer); clearTimeout(this.connectTimer);
    if (!userInitiated) {
      const permission = await (this.options.permission ?? localNetworkPermission)();
      if (!this.current(generation)) return;
      if (permission === 'prompt' || permission === 'denied') {
        this.update({ status: permission === 'denied' ? 'permission-denied' : 'permission-required', pairing: undefined, error: undefined });
        return;
      }
    }
    this.connect(generation);
  }
  private connect(generation: number) {
    if (!this.current(generation)) return;
    this.requests.clear(); this.queue = []; this.previous = undefined;
    this.update({ status: this.everConnected ? 'reconnecting' : 'connecting', pairing: undefined, error: undefined });
    let socket: RemoteSocket;
    try { socket = (this.options.socket ?? (url => new WebSocket(url)))(LOCAL_REMOTE_URL); }
    catch (error) {
      if (error instanceof Error && ['SecurityError', 'NotAllowedError'].includes(error.name)) {
        this.update({ status: 'permission-denied', pairing: undefined, error: 'O navegador bloqueou a conexão local. Permita o acesso à rede local ou abra o estúdio no Chrome.' });
      } else void this.disconnected(generation);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (!this.current(generation) || this.socket !== socket) return;
      this.send({ type: 'hello', ownerId: this.options.ownerId, projectId: this.options.projectId });
    };
    socket.onmessage = event => {
      if (!this.current(generation) || this.socket !== socket) return;
      const message = parseHelperMessage(event.data);
      if (!message) { this.update({ status: 'error', pairing: undefined, error: 'O aplicativo de conexão precisa ser atualizado. Baixe a versão abaixo.' }); this.stopSocket(); return; }
      if (message.type === 'ready') {
        clearTimeout(this.connectTimer); this.retries = 0; this.everConnected = true;
        const { type: _type, ...pairing } = message;
        this.update({ status: pairing.phoneConnected ? 'connected' : 'waiting', pairing, error: undefined });
        this.publish(generation);
      } else if (message.type === 'phone-status') {
        if (this.state.pairing) this.update({ status: message.connected ? 'connected' : 'waiting', pairing: { ...this.state.pairing, phoneConnected: message.connected } });
      } else if (message.type === 'request') {
        if (!this.state.pairing) return;
        this.receive(message, generation);
      } else if (message.type === 'error') {
        this.update({ status: message.code === 'studio-in-use' ? 'in-use' : 'error', pairing: undefined,
          error: message.code === 'studio-in-use' ? 'Outro projeto já está conectado neste computador. Feche-o para usar este projeto.' : 'Não foi possível conectar ao aplicativo neste computador.' });
        this.stopSocket();
      }
    };
    socket.onerror = () => { /* Browsers follow transport errors with close, without exposing private details. */ };
    socket.onclose = () => {
      if (!this.current(generation) || this.socket !== socket) return;
      this.socket = undefined;
      void this.disconnected(generation);
    };
    this.connectTimer = setTimeout(() => {
      if (!this.current(generation) || this.socket !== socket) return;
      this.socket = undefined; socket.close();
      void this.disconnected(generation);
    }, 5000);
  }
  private send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 262_144) return false;
    try { this.socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  private publish(generation: number) {
    clearTimeout(this.timer);
    if (!this.current(generation) || !this.state.pairing) return;
    const snapshot = this.options.getSnapshot();
    if (this.send({ type: 'state', snapshot })) {
      if (this.previous) {
        const events = translateEvents(this.previous, snapshot);
        if (events.length) this.send({ type: 'events', events });
      }
      this.previous = structuredClone(snapshot);
    }
    this.timer = setTimeout(() => this.publish(generation), this.options.intervalMs ?? 1000);
  }
  private receive(request: LocalRequest, generation: number) {
    const fingerprint = JSON.stringify([request.requestType, request.requestData ?? {}]);
    const previous = this.requests.get(request.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) this.send({ type: 'response', id: request.id, result: failed('Request ID was reused with different data.', 400) });
      else if (previous.result) this.send({ type: 'response', id: request.id, result: previous.result });
      return;
    }
    if (this.requests.size > 512) {
      for (const [id, entry] of this.requests) if (entry.result) { this.requests.delete(id); if (this.requests.size <= 256) break; }
    }
    if (this.requests.size >= 1024 || (MUTATING.has(request.requestType) && this.queue.length >= 32)) {
      this.send({ type: 'response', id: request.id, result: failed('The studio is busy. Try again.') }); return;
    }
    const entry: RequestEntry = { request, fingerprint, receivedAt: this.now() };
    this.requests.set(request.id, entry);
    if (MUTATING.has(request.requestType)) { this.queue.push(entry); void this.drain(generation); }
    else void this.run(entry, generation);
  }
  private async run(entry: RequestEntry, generation: number) {
    if (!this.current(generation)) return;
    let result: ObsRequestResult;
    if (entry.request.expiresAt <= this.now() || this.now() - entry.receivedAt > 8000) result = failed('The command expired before execution. Try again.');
    else {
      try {
        result = await handleObsRequest(entry.request.requestType, entry.request.requestData ?? {}, this.options.getSnapshot(), async command => {
          if (!this.current(generation)) return { ok: false, error: 'The project was closed.' };
          return this.options.execute(command);
        });
      } catch { result = failed('The studio could not apply this request.'); }
    }
    if (!this.current(generation)) return;
    entry.result = result;
    this.send({ type: 'response', id: entry.request.id, result });
    // Local/remote controls share the same state, and phone updates need not wait a second.
    if (MUTATING.has(entry.request.requestType)) this.publish(generation);
  }
  private async drain(generation: number) {
    if (this.workerGeneration === generation || !this.current(generation)) return;
    this.workerGeneration = generation;
    try { while (this.queue.length && this.current(generation)) await this.run(this.queue.shift()!, generation); }
    finally { if (this.workerGeneration === generation) this.workerGeneration = undefined; }
  }
  private async disconnected(generation: number) {
    clearTimeout(this.timer); clearTimeout(this.connectTimer);
    if (!this.current(generation)) return;
    this.requests.clear(); this.queue = []; this.previous = undefined;
    const permission = await (this.options.permission ?? localNetworkPermission)();
    if (!this.current(generation)) return;
    if (permission === 'denied' || permission === 'prompt') {
      this.update({ status: permission === 'denied' ? 'permission-denied' : 'permission-required', pairing: undefined, error: undefined }); return;
    }
    this.update({ status: this.everConnected ? 'reconnecting' : 'helper-missing', pairing: undefined, error: undefined });
    if (permission === 'unknown' && !this.everConnected) return;
    this.timer = setTimeout(() => { if (this.current(generation)) this.connect(++this.generation); }, Math.min(5000, (this.options.reconnectMs ?? 1000) * 2 ** Math.min(this.retries++, 3)));
  }
  resetPairing(): void {
    if (this.state.pairing) { this.queue = []; this.requests.clear(); this.send({ type: 'reset-pairing' }); }
  }
  private stopSocket() {
    ++this.generation; clearTimeout(this.timer); clearTimeout(this.connectTimer);
    const socket = this.socket; this.socket = undefined; socket?.close();
    this.requests.clear(); this.queue = []; this.previous = undefined;
  }
  stop(): void { this.enabled = false; this.stopSocket(); this.update({ status: 'idle', pairing: undefined, error: undefined }); }
  dispose(): void { this.disposed = true; this.stop(); }
}
