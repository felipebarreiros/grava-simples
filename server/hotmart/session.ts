import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ApiError } from "../transcription/security.ts";

export const HOTMART_SESSION_COOKIE = "grava_hotmart_session";
export const HOTMART_FLOW_COOKIE = "grava_hotmart_oauth";
const MAX_SEALED_BYTES = 24_000;
const MAX_OPEN_BYTES = 64_000;

export function hotmartEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.HOTMART_SESSION_ENCRYPTION_KEY?.trim() || "";
  const key = /^[a-f\d]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : /^[A-Za-z\d+/_=-]{42,48}$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new ApiError(503, "A conexão com a Hotmart ainda não está configurada.");
  return key;
}

/** Purpose separates OAuth, session and upload capsules even though they share a key. */
export function sealHotmartState<T>(
  purpose: string,
  ownerId: string,
  value: T,
  expiresAt: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[a-z][a-z\d_-]{0,63}$/.test(purpose) || !/^user_[\w-]{1,200}$/.test(ownerId) || !Number.isSafeInteger(expiresAt))
    throw new ApiError(400, "Dados de conexão inválidos.");
  const plain = Buffer.from(JSON.stringify({ ownerId, expiresAt, value }));
  if (plain.length > MAX_OPEN_BYTES) throw new ApiError(400, "Os dados de conexão são muito grandes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", hotmartEncryptionKey(env), iv);
  cipher.setAAD(Buffer.from(`grava-hotmart:v1:${purpose}`));
  const encrypted = Buffer.concat([cipher.update(deflateRawSync(plain)), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  if (sealed.length > MAX_SEALED_BYTES) throw new ApiError(400, "Os dados de conexão são muito grandes.");
  return sealed;
}

/** Never returns an unverified/unbound state, including when encrypted data is malformed. */
export function openHotmartState<T>(
  purpose: string,
  ownerId: string,
  sealed: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): T | null {
  const state = unsealHotmartState<T>(purpose, sealed, env, now);
  return state?.ownerId === ownerId ? state.value : null;
}

/** OAuth callback learns the Clerk owner only from authenticated encrypted flow state. */
export function unsealHotmartState<T>(
  purpose: string,
  sealed: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): { ownerId: string; expiresAt: number; value: T } | null {
  if (!/^[a-z][a-z\d_-]{0,63}$/.test(purpose) || typeof sealed !== "string" || sealed.length > MAX_SEALED_BYTES || !/^[A-Za-z\d_-]+$/.test(sealed)) return null;
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", hotmartEncryptionKey(env), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`grava-hotmart:v1:${purpose}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const zipped = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const plain = inflateRawSync(zipped, { maxOutputLength: MAX_OPEN_BYTES });
    const state = JSON.parse(plain.toString("utf8"));
    if (!state || !/^user_[\w-]{1,200}$/.test(state.ownerId) || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= now || !Object.hasOwn(state, "value")) return null;
    return state;
  } catch { return null; }
}

export function hotmartCookie(request: Request, name: string): string | null {
  const pairs = (request.headers.get("cookie") || "").split(";");
  const matching = pairs.filter(pair => pair.trim().startsWith(`${name}=`));
  if (matching.length !== 1) return null;
  const value = matching[0].trim().slice(name.length + 1);
  return /^[A-Za-z\d_-]{1,24000}$/.test(value) ? value : null;
}

export function hotmartSetCookie(name: string, value: string, maxAge: number, env: NodeJS.ProcessEnv = process.env): string {
  // Keep cookies below the common browser 4 KiB bound, including attributes.
  if (!/^[\w-]+$/.test(name) || !/^[A-Za-z\d_-]*$/.test(value) || value.length > 3700)
    throw new ApiError(503, "Não foi possível guardar a conexão com a Hotmart neste navegador.");
  const secure = env.HOTMART_OIDC_REDIRECT_URI?.trim().startsWith("https://") ? "; Secure" : "";
  return `${name}=${value}; Path=/api/hotmart; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure}`;
}

export function disconnectHotmart(env: NodeJS.ProcessEnv = process.env): string[] {
  return [hotmartSetCookie(HOTMART_SESSION_COOKIE, "", 0, env), hotmartSetCookie(HOTMART_FLOW_COOKIE, "", 0, env)];
}
