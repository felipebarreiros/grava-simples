import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  ApiError,
  authenticate,
  limitBucket,
} from "../server/transcription/security.ts";
import { webRequest } from "../server/transcription/http.ts";

const origin = "https://studio.example.test";
const issuer = "https://fixture.clerk.accounts.dev";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const env = {
  APP_ORIGINS: origin,
  VITE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("fixture.clerk.accounts.dev$").toString("base64")}`,
  CLERK_JWT_KEY: publicKey,
};

function token(patch = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({
    alg: "RS256",
    typ: "JWT",
    kid: "transcription-fixture",
  });
  const claims = encode({
    v: 2,
    iss: issuer,
    sub: "user_fixture",
    sid: "sess_fixture",
    azp: origin,
    sts: "active",
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...patch,
  });
  const message = `${header}.${claims}`;
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
}
function request(bearer = token(), headers = {}) {
  return new Request(`${origin}/api/transcriptions`, {
    headers: { authorization: `Bearer ${bearer}`, origin, ...headers },
  });
}
const status = (expected) => (error) =>
  error instanceof ApiError && error.status === expected;

test("a real locally signed Clerk session verifies with the trusted public key without network access", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Authentication must not fetch when a JWT key is supplied");
  };
  try {
    assert.deepEqual(await authenticate(request(), env), {
      userId: "user_fixture",
    });
    assert.deepEqual(
      await authenticate(request(), {
        ...env,
        CLERK_SECRET_KEY: "sk_test_fixture",
      }),
      { userId: "user_fixture" },
    );
    assert.deepEqual(
      await authenticate(
        request(token(), { cookie: "__session=invalid" }),
        env,
      ),
      { userId: "user_fixture" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the actual Clerk secret-key authenticateRequest branch verifies route-adapted sessions and rejects invalid claims without network access", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls++;
    throw new Error(
      "The supplied JWT public key must keep session verification local",
    );
  };
  const secretEnv = { ...env, CLERK_SECRET_KEY: "sk_test_fixture" };
  const adapted = (bearer = token(), extraHeaders = {}) =>
    webRequest({
      method: "POST",
      url: "/api/transcriptions?recordingId=recording-fixture",
      headers: {
        authorization: `Bearer ${bearer}`,
        origin,
        cookie: "__session=invalid-cookie",
        ...extraHeaders,
      },
      body: { recordingId: "recording-fixture" },
    });
  try {
    assert.equal(
      new URL(adapted().url).origin,
      "https://transcription.invalid",
    );
    assert.deepEqual(await authenticate(adapted(), secretEnv), {
      userId: "user_fixture",
    });
    const now = Math.floor(Date.now() / 1000);
    for (const invalid of [
      token({ exp: now - 60 }),
      token({ iss: "https://another.clerk.accounts.dev" }),
      token({ azp: "https://evil.example.test" }),
      token({ sts: "pending" }),
      token({ sid: undefined }),
      "invalid.signature.token",
    ])
      await assert.rejects(
        authenticate(adapted(invalid), secretEnv),
        status(401),
      );
    await assert.rejects(
      authenticate(
        adapted(token(), { origin: "https://evil.example.test" }),
        secretEnv,
      ),
      status(403),
    );
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authentication rejects cookie-only and malformed bearer requests before allocating paid resources", async () => {
  await assert.rejects(
    authenticate(
      new Request(`${origin}/api/transcriptions`, {
        headers: { cookie: `__session=${token()}` },
      }),
      env,
    ),
    status(401),
  );
  await assert.rejects(
    authenticate(request("not-a-session"), env),
    status(401),
  );
  await assert.rejects(authenticate(request("one two"), env), status(401));
  await assert.rejects(authenticate(request("one,two"), env), status(401));
});

test("authentication enforces signature, expiry, issuer, authorized party, and completed session", async () => {
  const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  for (const invalid of [
    token({}, otherKeys.privateKey),
    token({ exp: now - 60 }),
    token({ nbf: now + 120 }),
    token({ iss: "https://another.clerk.accounts.dev" }),
    token({ azp: "https://evil.example.test" }),
    token({ azp: undefined }),
    token({ sid: undefined }),
    token({ sts: "pending" }),
    token({ sub: undefined }),
  ]) {
    await assert.rejects(authenticate(request(invalid), env), status(401));
    await assert.rejects(
      authenticate(request(invalid), {
        ...env,
        CLERK_SECRET_KEY: "sk_test_fixture",
      }),
      status(401),
    );
  }
  await assert.rejects(
    authenticate(
      request(token(), { origin: "https://evil.example.test" }),
      env,
    ),
    status(403),
  );
  await assert.rejects(
    authenticate(request(token(), { origin: "null" }), env),
    status(403),
  );
});

test("authentication configuration fails closed and never widens origins to every deployment", async () => {
  await assert.rejects(
    authenticate(request(), { ...env, APP_ORIGINS: "" }),
    status(503),
  );
  await assert.rejects(
    authenticate(request(), { ...env, APP_ORIGINS: "https://*.example.test" }),
    status(503),
  );
  await assert.rejects(
    authenticate(request(), {
      ...env,
      APP_ORIGINS: "https://studio.example.test/path",
    }),
    status(503),
  );
  await assert.rejects(
    authenticate(request(), {
      ...env,
      APP_ORIGINS: "http://studio.example.test",
    }),
    status(503),
  );
  await assert.rejects(
    authenticate(request(), { ...env, CLERK_JWT_KEY: undefined }),
    status(503),
  );
  await assert.rejects(
    authenticate(request(), { ...env, VITE_CLERK_PUBLISHABLE_KEY: "invalid" }),
    status(503),
  );
  await assert.rejects(
    authenticate(request(), {
      ...env,
      VERCEL_URL: "untrusted.vercel.app",
      APP_ORIGINS: undefined,
    }),
    status(503),
  );
  assert.deepEqual(
    await authenticate(request(), {
      ...env,
      APP_ORIGINS: `${origin},http://localhost:5173`,
    }),
    { userId: "user_fixture" },
  );
});

test("shared Redis quotas reject a concurrent burst over the allowed count with Retry-After", async () => {
  const counts = new Map();
  const redis = {
    async eval(script, keys, args) {
      assert.match(script, /redis\.call\('INCR'/);
      assert.match(script, /redis\.call\('EXPIRE'/);
      assert.equal(args[0], 86400);
      const count = (counts.get(keys[0]) ?? 0) + 1;
      counts.set(keys[0], count);
      return [count, 123];
    },
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      limitBucket(redis, "quota:user_one:submit", 6, 86400),
    ),
  );
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    6,
  );
  const rejected = outcomes.filter((item) => item.status === "rejected");
  assert.equal(rejected.length, 4);
  assert.ok(
    rejected.every(
      (item) => item.reason.status === 429 && item.reason.retryAfter === 123,
    ),
  );
  assert.deepEqual(
    await limitBucket(redis, "quota:user_two:submit", 6, 86400),
    { remaining: 5, resetSeconds: 123 },
  );
});

test("Redis outages, invalid responses and invalid quota policy never grant an unmetered request", async () => {
  await assert.rejects(
    limitBucket(
      {
        eval: async () => {
          throw new Error("redis-secret");
        },
      },
      "quota",
      6,
      86400,
    ),
    status(503),
  );
  for (const response of [null, [1], [0, 10], [1, -1], ["1", 10], [1.5, 10]]) {
    await assert.rejects(
      limitBucket({ eval: async () => response }, "quota", 6, 86400),
      status(503),
    );
  }
  await assert.rejects(
    limitBucket({ eval: async () => [1, 10] }, "quota", 0, 86400),
    status(503),
  );
});
