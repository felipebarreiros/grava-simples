import type { ObsRequestResult } from './protocol';

export const LOCAL_REMOTE_URL = 'ws://127.0.0.1:4455/studio';
export interface LocalAirPlay {
  available: boolean;
  running: boolean;
  name: string;
}
export interface LocalPairing {
  connectionId: string;
  addresses: string[];
  port: number;
  password: string;
  phoneConnected: boolean;
  airplay?: LocalAirPlay;
}
export interface LocalRequest {
  type: 'request';
  id: string;
  expiresAt: number;
  requestType: string;
  requestData?: unknown;
}
export type HelperMessage =
  | ({ type: 'ready' } & LocalPairing)
  | LocalRequest
  | { type: 'phone-status'; connected: boolean }
  | { type: 'error'; code: string; message?: string };
export type RemoteSocket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>;
export type SocketFactory = (url: string) => RemoteSocket;
export type LocalPermission = 'granted' | 'denied' | 'prompt' | 'unknown';
export type LocalResponse = { type: 'response'; id: string; result: ObsRequestResult };

/** Chrome split local access into loopback/local permissions; older versions use one name. */
export async function localNetworkPermission(permissions: Pick<Permissions, 'query'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.permissions): Promise<LocalPermission> {
  if (!permissions?.query) return 'unknown';
  for (const name of ['loopback-network', 'local-network', 'local-network-access']) {
    try {
      const result = await permissions.query({ name } as PermissionDescriptor);
      if (['granted', 'denied', 'prompt'].includes(result.state)) return result.state;
    } catch { /* Unsupported permission names are expected on older browsers. */ }
  }
  return 'unknown';
}

function ipv4(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  return parts.every(part => part >= 0 && part <= 255) && parts[0] !== 0 && parts[0] !== 127 && parts[0] < 224;
}

/** Only the fixed loopback helper can supply pairing data, never URL or storage input. */
export function parseHelperMessage(data: unknown): HelperMessage | null {
  if (typeof data !== 'string' || data.length > 65_536) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  switch (value.type) {
    case 'ready':
      if (typeof value.connectionId !== 'string' || !/^[\w-]{1,128}$/.test(value.connectionId)
        || !Array.isArray(value.addresses) || value.addresses.length > 32 || !value.addresses.every(ipv4)
        || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535
        || typeof value.password !== 'string' || value.password.length < 12 || value.password.length > 256
        || typeof value.phoneConnected !== 'boolean') return null;
      if (value.airplay !== undefined) {
        const airplay = value.airplay as Record<string, unknown>;
        if (!airplay || typeof airplay !== 'object' || typeof airplay.available !== 'boolean'
          || typeof airplay.running !== 'boolean' || typeof airplay.name !== 'string' || airplay.name.length > 80) return null;
      }
      return value as unknown as HelperMessage;
    case 'request':
      if (typeof value.id !== 'string' || !/^[\w:.-]{1,128}$/.test(value.id)
        || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
        || typeof value.requestType !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,80}$/.test(value.requestType)) return null;
      return value as unknown as LocalRequest;
    case 'phone-status': return typeof value.connected === 'boolean' ? value as unknown as HelperMessage : null;
    case 'error': return typeof value.code === 'string' && value.code.length <= 80 ? value as unknown as HelperMessage : null;
    default: return null;
  }
}
