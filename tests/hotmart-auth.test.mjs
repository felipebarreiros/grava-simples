import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  beginHotmartLogin, completeHotmartLogin, getHotmartAuthConfiguration,
  readHotmartSession, disconnectHotmart,
} from "../server/hotmart/auth.ts";
import { sealHotmartState, openHotmartState, hotmartCookie, hotmartSetCookie } from "../server/hotmart/session.ts";
import { ApiError } from "../server/transcription/security.ts";

const now = 1_800_000_000_000;
const issuer = "https://sso.hotmart.com/oidc";
const owner = "user_alice";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "hotmart-fixture", use: "sig", alg: "RS256" };
const env = {
  APP_ORIGINS: "https://studio.example.test",
  HOTMART_OIDC_CLIENT_ID: "registered-client",
  HOTMART_OIDC_CLIENT_SECRET: "server-secret",
  HOTMART_OIDC_REDIRECT_URI: "https://studio.example.test/api/hotmart?action=callback",
  HOTMART_SESSION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const status = expected => error => error instanceof ApiError && error.status === expected;
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(nonce, patch = {}, privateKey = keys.privateKey, headerPatch = {}) {
  const header = encode({ alg: "RS256", kid: jwk.kid, ...headerPatch });
  const body = encode({ iss: issuer, aud: env.HOTMART_OIDC_CLIENT_ID, sub: "123456", name: "Creator", email: "creator@example.test", nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, ...patch });
  const message = `${header}.${body}`;
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
}
function fixture(overrides = {}) {
  const begin = beginHotmartLogin(owner, "/app?source=recording#project/project-1/recording/take-1", env, { now: () => now });
  const url = new URL(begin.url);
  const callback = new URL(env.HOTMART_OIDC_REDIRECT_URI);
  callback.searchParams.set("state", url.searchParams.get("state"));
  callback.searchParams.set("code", "one-use-code");
  const token = jwt(url.searchParams.get("nonce"), overrides.claims || {}, overrides.privateKey, overrides.header || {});
  const calls = [];
  const dependencies = {
    now: () => now,
    fetch: async (requested, options) => {
      calls.push({ url: requested, options });
      if (requested === `${issuer}/jwks`) return Response.json({ keys: overrides.jwks || [jwk] });
      assert.equal(requested, `${issuer}/accessToken`);
      assert.equal(options.redirect, "error");
      assert.match(options.headers.Authorization, /^Basic /);
      const body = options.body;
      assert.equal(body.get("code"), "one-use-code");
      assert.equal(body.get("redirect_uri"), env.HOTMART_OIDC_REDIRECT_URI);
      assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), url.searchParams.get("code_challenge"));
      return Response.json({ access_token: "access-fixture", token_type: "Bearer", id_token: token, refresh_token: "refresh-fixture", ...overrides.tokens });
    },
  };
  const request = new Request(callback, { headers: { cookie: begin.cookies[0].split(";")[0] } });
  return { begin, url, callback, request, token, calls, dependencies };
}

 test("connection is gated on a registered OAuth client, allowed callback and encryption configuration", () => {
  assert.deepEqual(getHotmartAuthConfiguration({}), { configured: false });
  assert.deepEqual(getHotmartAuthConfiguration(env), { configured: true });
  for (const patch of [
    { HOTMART_OIDC_CLIENT_SECRET: "" },
    { HOTMART_SESSION_ENCRYPTION_KEY: "short" },
    { HOTMART_OIDC_REDIRECT_URI: "https://evil.test/api/hotmart" },
    { HOTMART_OIDC_REDIRECT_URI: "https://studio.example.test/app" },
    { HOTMART_OIDC_REDIRECT_URI: "http://studio.example.test/api/hotmart" },
    { HOTMART_OIDC_SCOPES: "profile email" },
  ]) assert.deepEqual(getHotmartAuthConfiguration({ ...env, ...patch }), { configured: false });
});

test("login uses same-tab authorization-code PKCE and an encrypted HttpOnly state cookie", () => {
  const f = fixture();
  assert.equal(f.url.origin, "https://sso.hotmart.com");
  assert.equal(f.url.searchParams.get("response_type"), "code");
  assert.equal(f.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(f.url.searchParams.get("client_id"), env.HOTMART_OIDC_CLIENT_ID);
  assert.equal(f.url.searchParams.has("client_secret"), false);
  assert.match(f.begin.cookies[0], /HttpOnly; SameSite=Lax/);
  assert.match(f.begin.cookies[0], /; Secure$/);
  assert.equal(f.begin.cookies[0].includes("user_alice"), false);
});

test("valid callback verifies signature/issuer/audience/nonce then connects only its original Clerk owner", async () => {
  const f = fixture();
  const complete = await completeHotmartLogin(f.request, env, f.dependencies);
  assert.equal(complete.ownerId, owner);
  assert.equal(complete.returnTo, "/app?source=recording#project/project-1/recording/take-1");
  assert.equal(f.calls.length, 2);
  assert.equal(complete.cookies.some(cookie => cookie.includes("grava_hotmart_oauth=;") && cookie.includes("Max-Age=0")), true);
  const request = new Request("https://studio.example.test/api/hotmart", { headers: { cookie: complete.cookies[0].split(";")[0] } });
  const connected = await readHotmartSession(request, owner, env, { now: () => now, fetch: () => assert.fail("live session must not renew") });
  assert.equal(connected.session.token, f.token);
  assert.equal(connected.session.accountName, "Creator");
  assert.equal(connected.session.hotmartUserId, "123456");
  assert.equal(await readHotmartSession(request, "user_bob", env, { now: () => now }), null);
  assert.equal(complete.cookies[0].includes(f.token), false);
});

test("callback rejects missing, duplicated, tampered or expired state before sending any credentials", async () => {
  const f = fixture();
  const cookie = f.begin.cookies[0].split(";")[0];
  const request = (url = f.callback, header = cookie) => new Request(url, { headers: { cookie: header } });
  const bad = new URL(f.callback); bad.searchParams.set("state", "attacker");
  const duplicate = new URL(f.callback); duplicate.searchParams.append("state", duplicate.searchParams.get("state"));
  for (const r of [request(bad), request(duplicate), request(f.callback, ""), request(f.callback, `${cookie}; ${cookie}`), request(f.callback, cookie.slice(0, -3) + "xxx")]) {
    await assert.rejects(completeHotmartLogin(r, env, f.dependencies), status(401));
  }
  await assert.rejects(completeHotmartLogin(f.request, env, { ...f.dependencies, now: () => now + 11 * 60_000 }), status(401));
  assert.equal(f.calls.length, 0);
});

test("provider-denied login is handled without exchanging a code or reflecting provider error text", async () => {
  const f = fixture();
  const denied = new URL(f.callback);
  denied.searchParams.set("error", "access_denied");
  denied.searchParams.set("error_description", "sensitive-provider-diagnostic");
  await assert.rejects(completeHotmartLogin(new Request(denied, { headers: { cookie: f.begin.cookies[0].split(";")[0] } }), env, f.dependencies), error => error.status === 400 && !error.message.includes("sensitive"));
  assert.equal(f.calls.length, 0);
});

test("callback rejects correctly signed tokens for another issuer, audience, nonce or access token", async () => {
  const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const override of [
    { claims: { iss: "https://evil.test" } },
    { claims: { aud: "other-client" } },
    { claims: { nonce: "wrong-nonce" } },
    { claims: { exp: Math.floor(now / 1000) - 1 } },
    { claims: { at_hash: "wrong-access-token-hash" } },
    { claims: { aud: [env.HOTMART_OIDC_CLIENT_ID, "other-client"] } },
    { privateKey: otherKeys.privateKey },
    { jwks: [] },
  ]) {
    const f = fixture(override);
    await assert.rejects(completeHotmartLogin(f.request, env, f.dependencies), status(401));
  }
});

test("Hotmart-shaped no-kid multi-audience JWT verifies against duplicated public keys using its signed client_id", async () => {
  const withoutKid = { ...jwk }; delete withoutKid.kid;
  const f = fixture({
    header: { kid: undefined, typ: "JWT" },
    claims: { aud: ["legacy-hotmart-client", env.HOTMART_OIDC_CLIENT_ID], client_id: env.HOTMART_OIDC_CLIENT_ID },
    jwks: [withoutKid, jwk],
  });
  const complete = await completeHotmartLogin(f.request, env, f.dependencies);
  assert.equal(complete.ownerId, owner);
  const request = new Request("https://studio.example.test/api/hotmart", { headers: { cookie: complete.cookies[0].split(";")[0] } });
  assert.equal((await readHotmartSession(request, owner, env, { now: () => now })).session.hotmartUserId, "123456");
});

test("no-kid JWT selects its cryptographically verified RSA key and rejects wrong keys, key IDs and authorized parties", async () => {
  const unrelated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const unrelatedJwk = { ...unrelated.publicKey.export({ format: "jwk" }), kid: "other-signing-key", use: "sig", alg: "RS256" };
  const accepted = fixture({ header: { kid: undefined }, jwks: [unrelatedJwk, jwk] });
  assert.equal((await completeHotmartLogin(accepted.request, env, accepted.dependencies)).ownerId, owner);
  for (const override of [
    { header: { kid: undefined }, jwks: [unrelatedJwk] },
    { header: { kid: "wrong-key-id" } },
    { header: { kid: null } },
    { header: { kid: undefined }, claims: { aud: [env.HOTMART_OIDC_CLIENT_ID, "other"], client_id: "wrong-client" } },
    { header: { kid: undefined }, claims: { aud: [env.HOTMART_OIDC_CLIENT_ID, "other"], client_id: env.HOTMART_OIDC_CLIENT_ID, azp: "wrong-client" } },
    { claims: { azp: env.HOTMART_OIDC_CLIENT_ID, client_id: "wrong-client" } },
    { claims: { client_id: "wrong-client" } },
  ]) {
    const f = fixture(override);
    await assert.rejects(completeHotmartLogin(f.request, env, f.dependencies), status(401));
  }
});

test("encrypted capsules enforce owner, purpose, expiry and integrity", () => {
  const sealed = sealHotmartState("upload", owner, { objectKey: "private/path", fileId: 15 }, now + 1000, env);
  assert.deepEqual(openHotmartState("upload", owner, sealed, env, now), { objectKey: "private/path", fileId: 15 });
  assert.equal(openHotmartState("upload", "user_bob", sealed, env, now), null);
  assert.equal(openHotmartState("session", owner, sealed, env, now), null);
  assert.equal(openHotmartState("upload", owner, sealed, env, now + 1000), null);
  assert.equal(openHotmartState("upload", owner, sealed.slice(0, -3) + "xxx", env, now), null);
  assert.equal(openHotmartState("upload", owner, sealed, { ...env, HOTMART_SESSION_ENCRYPTION_KEY: randomBytes(32).toString("hex") }, now), null);
  assert.throws(() => hotmartSetCookie("invalid;name", "token", 60, env), status(503));
  assert.throws(() => hotmartSetCookie("session", "x".repeat(3800), 60, env), status(503));
});

test("near-expired sessions refresh on the server and preserve owner and Hotmart identity", async () => {
  const f = fixture();
  const complete = await completeHotmartLogin(f.request, env, f.dependencies);
  const request = new Request("https://studio.example.test/api/hotmart", { headers: { cookie: complete.cookies[0].split(";")[0] } });
  const future = now + 3590_000;
  const nonce = f.url.searchParams.get("nonce");
  const refreshedToken = jwt(nonce, { iat: Math.floor(future / 1000), exp: Math.floor(future / 1000) + 3600 });
  const dependencies = {
    now: () => future,
    fetch: async (url, options) => {
      if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      assert.equal(options.body.get("grant_type"), "refresh_token");
      assert.equal(options.body.get("refresh_token"), "refresh-fixture");
      return Response.json({ access_token: "new-access", id_token: refreshedToken, refresh_token: "rotated-refresh" });
    },
  };
  const refreshed = await readHotmartSession(request, owner, env, dependencies);
  assert.equal(refreshed.session.token, refreshedToken);
  assert.equal(refreshed.cookies.length, 1);
  const switched = jwt(nonce, { sub: "attacker-account", iat: Math.floor(future / 1000), exp: Math.floor(future / 1000) + 3600 });
  await assert.rejects(readHotmartSession(request, owner, env, { ...dependencies, fetch: async url => url.endsWith("/jwks") ? Response.json({ keys: [jwk] }) : Response.json({ access_token: "new-access", id_token: switched }) }), status(401));
});

test("return path is constrained to the app and disconnect clears both HttpOnly cookies", () => {
  for (const returnTo of ["https://evil.test", "//evil.test", "/app-evil", "/app\\evil", "/app\r\nLocation:evil"]) {
    const login = beginHotmartLogin(owner, returnTo, env, { now: () => now });
    const cookie = login.cookies[0].split(";")[0];
    assert.equal(hotmartCookie(new Request("https://studio.example.test/api/hotmart", { headers: { cookie } }), "grava_hotmart_oauth") !== null, true);
  }
  const cookies = disconnectHotmart(env);
  assert.equal(cookies.length, 2);
  assert.equal(cookies.every(cookie => /Max-Age=0/.test(cookie) && /HttpOnly/.test(cookie)), true);
});
