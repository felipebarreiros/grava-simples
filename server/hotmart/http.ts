import { HotmartError, type HotmartDependencies } from './types.ts';

export const HOTMART_HOSTS = new Set([
  'api-product.vulcano.hotmart.com',
  'api-content-platform-space-gateway.cp.hotmart.com',
  'api-club-content.cb.hotmart.com',
  'api-club-file.cb.hotmart.com',
  'api-club-upload.cb.hotmart.com',
  'api-gateway.play.hotmart.com',
  'api-vlc.hotmart.com',
]);
export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function id(value: unknown, label = 'identificador'): string {
  const result = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) throw new HotmartError(400, 'invalid_input', `Confira o ${label}.`);
  return result;
}
export function productId(value: unknown): string {
  const result = String(value ?? '');
  if (!/^[1-9][0-9]{0,15}$/.test(result)) throw new HotmartError(400, 'invalid_input', 'Selecione um curso válido.');
  return result;
}
/** Provider contract failures must never be classified as retryable user input. */
export function providerId(value: unknown): string {
  try { return id(value); }
  catch { throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart retornou um identificador inesperado. Confira o conteúdo na Hotmart antes de tentar novamente.'); }
}
export function providerProductId(value: unknown): string {
  try { return productId(value); }
  catch { throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart retornou um curso inesperado. Confira sua lista de cursos antes de tentar novamente.'); }
}
export function providerArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart retornou uma lista inesperada. Atualize a estrutura antes de tentar novamente.');
  return value;
}
export function text(value: unknown, label: string, max = 200, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new HotmartError(400, 'invalid_input', `${label} deve ter entre ${min} e ${max} caracteres.`);
  }
  return value.trim();
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export class HotmartClient {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  private readonly token: string;
  constructor(token: string, deps: HotmartDependencies = {}) {
    if (!token || /[\r\n]/.test(token)) throw new HotmartError(401, 'hotmart_disconnected', 'Conecte sua conta Hotmart.');
    this.token = token;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  async response(url: string, init: RequestInit = {}, context?: { productId?: string; subdomain?: string }): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !HOTMART_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
      throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart retornou uma configuração inesperada.');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('Accept', 'application/json');
    headers.set('Origin', 'https://app.hotmart.com');
    headers.set('Referer', 'https://app.hotmart.com/');
    if (context?.productId) headers.set('x-product-id', productId(context.productId));
    if (context?.subdomain) headers.set('Club', id(context.subdomain, 'subdomínio'));
    let response: Response;
    try {
      response = await this.fetch(url, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(25000) });
    } catch {
      throw new HotmartError(502, 'hotmart_unreachable', 'Não foi possível confirmar a resposta da Hotmart. Atualize a estrutura antes de tentar novamente.');
    }
    if (!response.ok) {
      if (response.status === 401) throw new HotmartError(401, 'hotmart_expired', 'Sua conexão com a Hotmart expirou. Conecte novamente.');
      if (response.status === 403) throw new HotmartError(403, 'hotmart_forbidden', 'Sua conta Hotmart não tem permissão para esta ação.');
      if (response.status === 404) throw new HotmartError(404, 'hotmart_not_found', 'O curso ou conteúdo não está mais disponível na Hotmart.');
      if (response.status === 429) throw new HotmartError(429, 'hotmart_rate_limited', 'A Hotmart recebeu muitas solicitações. Aguarde um momento.');
      throw new HotmartError(response.status >= 500 ? 502 : 422, 'hotmart_rejected', 'A Hotmart não aceitou esta ação. Confira os dados e as configurações do curso.');
    }
    return response;
  }
  async json(url: string, init: RequestInit = {}, context?: { productId?: string; subdomain?: string }): Promise<unknown> {
    const response = await this.response(url, init, context);
    if (response.status === 204) return null;
    const body = await response.text();
    if (!body) return null;
    if (body.length > 4_000_000) throw new HotmartError(502, 'invalid_provider_response', 'A resposta da Hotmart excedeu o limite esperado.');
    try { return JSON.parse(body); }
    catch { throw new HotmartError(502, 'invalid_provider_response', 'A Hotmart retornou uma resposta inesperada.'); }
  }
  async send(url: string, method: 'POST' | 'PUT', body: unknown, context?: { productId?: string; subdomain?: string }): Promise<unknown> {
    return this.json(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, context);
  }
}
