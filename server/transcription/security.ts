import { createClerkClient, verifyToken } from "@clerk/backend";

export class ApiError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const unavailable = () =>
  new ApiError(503, "A transcrição não está configurada neste servidor.");

function exactOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.hostname.includes("*") ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw unavailable();
    return url.origin;
  } catch {
    throw unavailable();
  }
}

function trustedIssuer(publishableKey: string, override?: string): string {
  if (override) {
    const issuer = exactOrigin(override);
    if (!issuer.startsWith("https://")) throw unavailable();
    return issuer;
  }
  const match = /^pk_(?:live|test)_([A-Za-z0-9_=-]+)$/.exec(publishableKey);
  if (!match) throw unavailable();
  const host = Buffer.from(match[1], "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
    !host.includes(".") ||
    host.includes("..")
  )
    throw unavailable();
  const issuer = exactOrigin(`https://${host}`);
  if (new URL(issuer).host !== host.toLowerCase()) throw unavailable();
  return issuer;
}

/** Verify the browser's signed Clerk session. Cookies and client-supplied user IDs are never authority. */
export async function authenticate(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ userId: string }> {
  const header = request.headers.get("authorization");
  const bearer = header && /^Bearer ([^\s,]+)$/i.exec(header);
  if (!bearer || bearer[1].length > 32_768)
    throw new ApiError(
      401,
      "Entre na sua conta para transcrever esta gravação.",
    );
  const publishableKey =
    env.CLERK_PUBLISHABLE_KEY || env.VITE_CLERK_PUBLISHABLE_KEY;
  if (
    !publishableKey ||
    (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) ||
    !env.APP_ORIGINS?.trim()
  )
    throw unavailable();
  const authorizedParties = env.APP_ORIGINS.split(",").map((origin) =>
    exactOrigin(origin.trim()),
  );
  if (!authorizedParties.length) throw unavailable();
  const issuer = trustedIssuer(publishableKey, env.CLERK_ISSUER);
  const origin = request.headers.get("origin");
  if (origin && !authorizedParties.includes(origin))
    throw new ApiError(403, "Esta origem não tem acesso à transcrição.");

  let client: ReturnType<typeof createClerkClient> | undefined;
  try {
    if (env.CLERK_SECRET_KEY)
      client = createClerkClient({
        publishableKey,
        secretKey: env.CLERK_SECRET_KEY,
        jwtKey: env.CLERK_JWT_KEY?.replace(/\\n/g, "\n"),
        telemetry: { disabled: true },
      });
  } catch {
    throw unavailable();
  }

  try {
    let claims;
    if (client) {
      // Removing cookies ensures this API cannot silently fall back to cookie authentication.
      const verifiedRequest = new Request(request.url, {
        headers: { authorization: `Bearer ${bearer[1]}` },
      });
      const state = await client.authenticateRequest(verifiedRequest, {
        acceptsToken: "session_token",
        authorizedParties,
        issuer,
      });
      if (!state.isAuthenticated || state.tokenType !== "session_token")
        throw new Error("Unauthenticated session");
      const auth = state.toAuth({ treatPendingAsSignedOut: true });
      if (!auth?.isAuthenticated) throw new Error("Pending session");
      claims = auth.sessionClaims;
    } else {
      // SDK 3.x authenticateRequest requires a secret even with jwtKey. Its
      // networkless verifier supports public-key-only deployments; enforce the
      // session-only and pending-session rules explicitly for that path.
      claims = await verifyToken(bearer[1], {
        jwtKey: env.CLERK_JWT_KEY!.replace(/\\n/g, "\n"),
        authorizedParties,
        issuer,
      });
    }
    if (
      !claims ||
      typeof claims.sub !== "string" ||
      !/^user_[\w-]+$/.test(claims.sub) ||
      typeof claims.sid !== "string" ||
      !/^sess_[\w-]+$/.test(claims.sid) ||
      (claims.sts !== undefined && claims.sts !== "active") ||
      typeof claims.azp !== "string" ||
      !authorizedParties.includes(claims.azp) ||
      claims.iss !== issuer
    )
      throw new Error("Invalid session claims");
    return { userId: claims.sub };
  } catch {
    throw new ApiError(
      401,
      "Sua sessão não pôde ser confirmada. Entre novamente para transcrever.",
    );
  }
}

export interface RateLimitRedis {
  eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown>;
}

// INCR and expiry share one Redis operation across all Vercel instances.
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/** Fixed windows begin at the first request. Failure never grants an unmetered request. */
export async function limitBucket(
  redis: RateLimitRedis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ remaining: number; resetSeconds: number }> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1_000_000 ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 31 * 86400
  )
    throw unavailable();
  let result: unknown;
  try {
    result = await redis.eval(RATE_LIMIT_SCRIPT, [key], [windowSeconds]);
  } catch {
    throw new ApiError(
      503,
      "Não foi possível verificar o limite de transcrições. Tente novamente em instantes.",
    );
  }
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    !Number.isSafeInteger(result[0]) ||
    result[0] < 1 ||
    !Number.isSafeInteger(result[1]) ||
    result[1] < 0
  ) {
    throw new ApiError(
      503,
      "Não foi possível verificar o limite de transcrições. Tente novamente em instantes.",
    );
  }
  const [count, ttl] = result as [number, number];
  if (count > limit)
    throw new ApiError(
      429,
      "Limite de transcrições atingido. Tente novamente mais tarde.",
      Math.max(1, ttl),
    );
  return { remaining: limit - count, resetSeconds: Math.max(1, ttl) };
}
