import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { ApiError } from "../transcription/security.ts";
import {
  HOTMART_FLOW_COOKIE, HOTMART_SESSION_COOKIE,
  hotmartCookie, hotmartEncryptionKey, hotmartSetCookie,
  openHotmartState, sealHotmartState, unsealHotmartState,
} from "./session.ts";

export { disconnectHotmart } from "./session.ts";
const ISSUER = "https://sso.hotmart.com/oidc";
const FLOW_LIFETIME = 10 * 60 * 1000;
const SESSION_LIFETIME = 30 * 86400 * 1000;
const DEFAULT_SCOPES = "openid profile email authorities user address offline_access";
const unavailable = () => new ApiError(503, "A conexão com a Hotmart ainda não está disponível. Tente novamente mais tarde.");
const reconnect = () => new ApiError(401, "Sua conexão com a Hotmart expirou. Conecte sua conta novamente.");

interface Configuration { clientId: string; clientSecret: string; redirectUri: string; scopes: string; }
interface Flow { state: string; verifier: string; nonce: string; returnTo: string; createdAt: number; }
interface StoredSession {
  token: string;
  accessToken: string;
  refreshToken?: string;
  hotmartUserId: string;
  accountName: string;
  email?: string;
  expiresAt: number;
  sessionExpiresAt: number;
  nonce?: string;
}
export interface HotmartSession {
  token: string;
  accountName: string;
  email?: string;
  hotmartUserId: string;
  expiresAt: number;
}
export interface HotmartAuthDependencies { fetch?: typeof globalThis.fetch; now?: () => number; }

function configuration(env: NodeJS.ProcessEnv): Configuration {
  const clientId = env.HOTMART_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.HOTMART_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = env.HOTMART_OIDC_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri || clientId.length > 300 || clientSecret.length > 4096) throw unavailable();
  hotmartEncryptionKey(env);
  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { throw unavailable(); }
  if ((redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))) || redirect.username || redirect.password || redirect.hash || redirect.pathname !== "/api/hotmart") throw unavailable();
  const origins = (env.APP_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!origins.includes(redirect.origin)) throw unavailable();
  const scopes = env.HOTMART_OIDC_SCOPES?.trim() || DEFAULT_SCOPES;
  if (!scopes.split(/\s+/).includes("openid") || scopes.length > 1000 || !/^[\w .:-]+$/.test(scopes)) throw unavailable();
  return { clientId, clientSecret, redirectUri, scopes };
}

export function getHotmartAuthConfiguration(env: NodeJS.ProcessEnv = process.env): { configured: boolean } {
  try { configuration(env); return { configured: true }; } catch { return { configured: false }; }
}

function safeReturnTo(value: string, config: Configuration): string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/app") || value.startsWith("//") || /[\r\n\\]/.test(value)) return "/app";
  const target = new URL(value, new URL(config.redirectUri).origin);
  return target.origin === new URL(config.redirectUri).origin && /^\/app(?:\/|$)/.test(target.pathname) ? `${target.pathname}${target.search}${target.hash}` : "/app";
}

export function beginHotmartLogin(
  ownerId: string,
  returnTo = "/app",
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HotmartAuthDependencies = {},
): { url: string; cookies: string[] } {
  const config = configuration(env);
  const now = (dependencies.now || Date.now)();
  const flow: Flow = {
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    returnTo: safeReturnTo(returnTo, config),
    createdAt: now,
  };
  const sealed = sealHotmartState("oauth", ownerId, flow, now + FLOW_LIFETIME, env);
  const url = new URL(`${ISSUER}/authorize`);
  for (const [key, value] of Object.entries({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "consent",
  })) url.searchParams.set(key, value);
  return { url: url.href, cookies: [hotmartSetCookie(HOTMART_FLOW_COOKIE, sealed, FLOW_LIFETIME / 1000, env)] };
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.length > 128_000) throw reconnect();
  let value;
  try { value = JSON.parse(raw); } catch { throw reconnect(); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw reconnect();
  return value;
}

async function exchange(
  body: URLSearchParams,
  config: Configuration,
  fetcher: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(`${ISSUER}/accessToken`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`,
      },
      body,
    });
  } catch { throw reconnect(); }
  if (!response.ok) throw reconnect();
  return jsonResponse(response);
}

async function verifyIdentity(
  idToken: string,
  accessToken: string,
  config: Configuration,
  fetcher: typeof globalThis.fetch,
  now: number,
  expectedNonce?: string,
  requireNonce = true,
): Promise<Record<string, unknown>> {
  try {
    if (idToken.length > 24_000) throw reconnect();
    const segments = idToken.split(".");
    if (segments.length !== 3 || segments.some(value => !/^[A-Za-z\d_-]+$/.test(value))) throw reconnect();
    const header = JSON.parse(Buffer.from(segments[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString());
    if (header.alg !== "RS256" || (header.kid !== undefined && (typeof header.kid !== "string" || !header.kid || header.kid.length > 300)) || header.crit) throw reconnect();
    const response = await fetcher(`${ISSUER}/jwks`, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
    if (!response.ok) throw reconnect();
    const jwks = await jsonResponse(response);
    const matches = Array.isArray(jwks.keys) && jwks.keys.length <= 32 ? jwks.keys.filter(key => key && typeof key === "object" && (header.kid === undefined || key.kid === header.kid) && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig") && (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify")))) : [];
    // Hotmart issues RS256 tokens without kid and publishes its same public key
    // twice (one entry has kid). Verify eligible keys and deduplicate the actual
    // public material, rather than selecting an arbitrary entry or rejecting it.
    const verifiedKeys = new Set<string>();
    for (const candidate of matches) {
      try {
        const key = createPublicKey({ key: candidate as JsonWebKey, format: "jwk" });
        if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
        if (verify("RSA-SHA256", Buffer.from(`${segments[0]}.${segments[1]}`), key, Buffer.from(segments[2], "base64url"))) verifiedKeys.add(key.export({ type: "spki", format: "der" }).toString("base64"));
      } catch { /* A malformed candidate cannot authorize a token. */ }
    }
    if (verifiedKeys.size !== 1) throw reconnect();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    // Hotmart uses client_id on its signed multi-audience tokens in place of azp.
    // An explicit azp always takes precedence; either supplied party must match.
    const authorizedParty = claims.azp !== undefined ? claims.azp : claims.client_id;
    if (claims.iss !== ISSUER || !audiences.every((audience: unknown) => typeof audience === "string") || !audiences.includes(config.clientId) || (audiences.length > 1 && authorizedParty !== config.clientId) || (claims.azp !== undefined && claims.azp !== config.clientId) || (claims.client_id !== undefined && claims.client_id !== config.clientId) || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 300 || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now || !Number.isSafeInteger(claims.iat) || claims.iat * 1000 > now + 60_000 || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now + 60_000))) throw reconnect();
    if (requireNonce && (typeof claims.nonce !== "string" || !expectedNonce || !equal(claims.nonce, expectedNonce))) throw reconnect();
    if (!requireNonce && claims.nonce !== undefined && (!expectedNonce || typeof claims.nonce !== "string" || !equal(claims.nonce, expectedNonce))) throw reconnect();
    if (claims.at_hash !== undefined) {
      const expected = createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url");
      if (typeof claims.at_hash !== "string" || !equal(claims.at_hash, expected)) throw reconnect();
    }
    return claims;
  } catch { throw reconnect(); }
}

async function storedSession(
  response: Record<string, unknown>, config: Configuration, fetcher: typeof globalThis.fetch,
  now: number, nonce?: string, previous?: StoredSession,
): Promise<StoredSession> {
  if (typeof response.id_token !== "string" || typeof response.access_token !== "string" || response.access_token.length > 16000 || (response.token_type !== undefined && String(response.token_type).toLowerCase() !== "bearer")) throw reconnect();
  const claims = await verifyIdentity(response.id_token, response.access_token, config, fetcher, now, nonce, !previous);
  if (previous && claims.sub !== previous.hotmartUserId) throw reconnect();
  const name = typeof claims.name === "string" ? claims.name : typeof claims.tradeName === "string" ? claims.tradeName : "Conta Hotmart";
  return {
    token: response.id_token,
    accessToken: response.access_token,
    ...(typeof response.refresh_token === "string" ? { refreshToken: response.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}),
    hotmartUserId: claims.sub as string,
    accountName: name.slice(0, 160),
    ...(typeof claims.email === "string" ? { email: claims.email.slice(0, 320) } : {}),
    expiresAt: (claims.exp as number) * 1000,
    sessionExpiresAt: previous?.sessionExpiresAt || now + SESSION_LIFETIME,
    ...(nonce ? { nonce } : {}),
  };
}

function sessionCookie(ownerId: string, session: StoredSession, env: NodeJS.ProcessEnv, now: number): string {
  const deadline = session.refreshToken ? session.sessionExpiresAt : Math.min(session.expiresAt, session.sessionExpiresAt);
  const sealed = sealHotmartState("session", ownerId, session, deadline, env);
  return hotmartSetCookie(HOTMART_SESSION_COOKIE, sealed, (deadline - now) / 1000, env);
}

export async function completeHotmartLogin(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HotmartAuthDependencies = {},
): Promise<{ returnTo: string; cookies: string[]; ownerId: string }> {
  const config = configuration(env);
  const now = (dependencies.now || Date.now)();
  const sealed = hotmartCookie(request, HOTMART_FLOW_COOKIE);
  const decoded = sealed ? unsealHotmartState<Flow>("oauth", sealed, env, now) : null;
  const params = new URL(request.url).searchParams;
  if (!decoded || params.getAll("state").length !== 1 || !equal(params.get("state") || "", decoded.value.state) || now - decoded.value.createdAt > FLOW_LIFETIME || decoded.value.createdAt > now + 60_000) throw reconnect();
  if (params.has("error")) throw new ApiError(400, "A conexão com a Hotmart foi cancelada. Você pode tentar novamente.");
  const code = params.get("code");
  if (!code || code.length > 4096 || params.getAll("code").length !== 1) throw reconnect();
  const fetcher = dependencies.fetch || globalThis.fetch;
  const response = await exchange(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: decoded.value.verifier }), config, fetcher);
  const session = await storedSession(response, config, fetcher, now, decoded.value.nonce);
  return {
    ownerId: decoded.ownerId,
    returnTo: safeReturnTo(decoded.value.returnTo, config),
    cookies: [sessionCookie(decoded.ownerId, session, env, now), hotmartSetCookie(HOTMART_FLOW_COOKIE, "", 0, env)],
  };
}

export async function readHotmartSession(
  request: Request,
  ownerId: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HotmartAuthDependencies = {},
): Promise<{ session: HotmartSession; cookies?: string[] } | null> {
  if (!getHotmartAuthConfiguration(env).configured) return null;
  const now = (dependencies.now || Date.now)();
  const sealed = hotmartCookie(request, HOTMART_SESSION_COOKIE);
  let session = sealed ? openHotmartState<StoredSession>("session", ownerId, sealed, env, now) : null;
  if (!session || typeof session.token !== "string" || typeof session.accountName !== "string" || typeof session.hotmartUserId !== "string" || !Number.isSafeInteger(session.expiresAt) || !Number.isSafeInteger(session.sessionExpiresAt)) return null;
  let cookies: string[] | undefined;
  if (session.expiresAt <= now + 30_000) {
    if (!session.refreshToken || session.sessionExpiresAt <= now) return null;
    const config = configuration(env), fetcher = dependencies.fetch || globalThis.fetch;
    const result = await exchange(new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }), config, fetcher);
    session = await storedSession(result, config, fetcher, now, session.nonce, session);
    cookies = [sessionCookie(ownerId, session, env, now)];
  }
  return { session: { token: session.token, accountName: session.accountName, hotmartUserId: session.hotmartUserId, email: session.email, expiresAt: session.expiresAt }, ...(cookies ? { cookies } : {}) };
}
