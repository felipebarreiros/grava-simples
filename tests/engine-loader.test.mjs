import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wasm = await readFile(new URL('../public/engine/obs-core.wasm', import.meta.url));
const capabilities = JSON.parse(await readFile(new URL('../public/engine/capabilities.json', import.meta.url), 'utf8'));
const WASM_PATH = '/engine/obs-core.wasm';
const MANIFEST_PATH = '/engine/capabilities.json';
const originalFetch = globalThis.fetch;
let serial = 0;

async function freshLoader(t, fetch) {
  globalThis.fetch = fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return (await import(`../engine/obs-engine.js?loader-test=${serial++}`)).loadObsEngine;
}
const binaryResponse = () => new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
const manifestResponse = () => Response.json(capabilities);

test('transient deployment and server responses recover with bounded asset retries', async t => {
  for (const status of [404, 408, 429, 500, 503]) {
    let wasmRequests = 0, manifestRequests = 0;
    const caches = [];
    const load = await freshLoader(t, async (path, options) => {
      if (path === MANIFEST_PATH) { manifestRequests++; return manifestResponse(); }
      assert.equal(path, WASM_PATH);
      caches.push(options.cache);
      return ++wasmRequests === 1 ? new Response(null, { status }) : binaryResponse();
    });
    const engine = await load();
    assert.equal(engine.backend, 'obs-wasm-subset');
    assert.ok(Math.abs(engine.audioGainDb(-6) - 10 ** (-6 / 20)) < 0.000001);
    assert.equal(wasmRequests, 2, `HTTP ${status} should recover on the second attempt`);
    assert.equal(manifestRequests, 1);
    assert.deepEqual(caches, ['default', 'reload']);
  }
});

test('temporary network failures retry and initialize the actual Wasm engine', async t => {
  let requests = 0;
  const load = await freshLoader(t, async path => {
    if (path === MANIFEST_PATH) return manifestResponse();
    if (++requests < 3) throw new TypeError('Failed to fetch');
    return binaryResponse();
  });
  const engine = await load();
  assert.equal(requests, 3);
  assert.equal(engine.audioGainDb(0), 1);
});

test('retry exhaustion includes asset diagnostics and a later call can recover', async t => {
  let requests = 0, available = false;
  const load = await freshLoader(t, async path => {
    if (path === MANIFEST_PATH) return manifestResponse();
    requests++;
    return available ? binaryResponse() : new Response(null, { status: 503 });
  });
  const initial = load();
  assert.strictEqual(load(), initial, 'concurrent failed loads share the pending request');
  await assert.rejects(initial, error => {
    assert.equal(error.name, 'ObsEngineAssetError');
    assert.equal(error.status, 503);
    assert.equal(error.assetPath, WASM_PATH);
    assert.equal(error.retryable, true);
    assert.match(error.message, /HTTP 503/);
    assert.ok(error.message.includes(WASM_PATH));
    return true;
  });
  assert.equal(requests, 3, 'automatic retries must stop');
  available = true;
  const engine = await load();
  assert.equal(requests, 4, 'a manual retry must make a fresh request');
  assert.equal(engine.audioGainDb(0), 1);
  assert.strictEqual(await load(), engine, 'a successful engine remains cached');
  assert.equal(requests, 4);
});

test('authorization failures are reported immediately and never automatically retried', async t => {
  for (const status of [401, 403]) {
    let requests = 0;
    const load = await freshLoader(t, async path => {
      if (path === MANIFEST_PATH) return manifestResponse();
      requests++;
      return new Response(null, { status });
    });
    await assert.rejects(load(), error => {
      assert.equal(error.status, status);
      assert.equal(error.assetPath, WASM_PATH);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('concurrent callers share one initialization and reuse the successful instance', async t => {
  let release, wasmRequests = 0, manifestRequests = 0;
  const load = await freshLoader(t, async path => {
    if (path === MANIFEST_PATH) { manifestRequests++; return manifestResponse(); }
    wasmRequests++;
    return new Promise(resolve => { release = resolve; });
  });
  const first = load(), second = load();
  assert.strictEqual(first, second);
  assert.equal(wasmRequests, 1);
  assert.equal(manifestRequests, 1);
  release(binaryResponse());
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.strictEqual(await load(), a);
  assert.equal(wasmRequests, 1);
  assert.equal(manifestRequests, 1);
});

test('manifest failures include the manifest path and do not retry invalid JSON', async t => {
  let requests = 0;
  const load = await freshLoader(t, async path => {
    if (path === WASM_PATH) return binaryResponse();
    requests++;
    return new Response('<html>not a manifest</html>', { headers: { 'Content-Type': 'text/html' } });
  });
  await assert.rejects(load(), error => {
    assert.equal(error.assetPath, MANIFEST_PATH);
    assert.equal(error.status, 200);
    assert.equal(error.retryable, false);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  assert.equal(requests, 1);
});

test('invalid Wasm is not retried automatically and cannot poison the next initialization', async t => {
  let valid = false, requests = 0;
  const load = await freshLoader(t, async path => {
    if (path === MANIFEST_PATH) return manifestResponse();
    requests++;
    return valid ? binaryResponse() : new Response('not WebAssembly');
  });
  await assert.rejects(load(), WebAssembly.CompileError);
  assert.equal(requests, 1);
  valid = true;
  assert.equal((await load()).audioGainDb(0), 1);
  assert.equal(requests, 2);
});
