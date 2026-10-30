import test from "node:test";
import assert from "node:assert/strict";
import {
  getCloudTranscription,
  deleteCloudTranscription,
  TranscriptionRequestError,
  rememberCloudTranscription,
  hasCloudTranscription,
  approveCloudReplacement,
  shouldReplaceCloudTranscript,
  clearCloudReplacement,
} from "../src/recordings/cloudTranscription.ts";
import {
  parseCloudTranscript,
  saveTranscript,
  loadTranscript,
  updateTranscriptCue,
} from "../src/recordings/transcript.ts";

const automatic = {
  version: 1,
  origin: "automatic",
  provider: "assemblyai",
  sourceName: "Transcrição automática",
  importedAt: 1,
  updatedAt: 1,
  cues: [{ id: "cue-1", start: 0.125, end: 1.875, text: "Olá criadores." }],
  words: [
    { id: "word-1", text: "Olá", start: 0.125, end: 0.6 },
    { id: "word-2", text: "criadores.", start: 0.95, end: 1.875 },
  ],
};

test("cloud reads use fresh bearer tokens and preserve real word times through corrections and local reload", async () => {
  const previousFetch = globalThis.fetch,
    previousStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
  });
  let tokens = 0;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "DELETE")
      return Response.json({
        configured: true,
        status: "idle",
        maxUploadBytes: 100,
      });
    return Response.json({
      configured: true,
      status: "completed",
      maxUploadBytes: 100,
      transcript: automatic,
    });
  };
  try {
    const getToken = async () => `session-${++tokens}`;
    const state = await getCloudTranscription("recording-1", getToken);
    await getCloudTranscription("recording-1", getToken);
    assert.equal(tokens, 2);
    assert.equal(calls[0].options.headers.Authorization, "Bearer session-1");
    assert.equal(calls[1].options.headers.Authorization, "Bearer session-2");
    assert.equal(calls[0].options.cache, "no-store");
    assert.deepEqual(state.transcript.words, automatic.words);
    const corrected = updateTranscriptCue(
      state.transcript,
      "cue-1",
      "Olá, comunidade.",
    );
    saveTranscript("recording-1", corrected);
    assert.deepEqual(loadTranscript("recording-1").words, automatic.words);
    assert.equal(
      loadTranscript("recording-1").cues[0].originalText,
      automatic.cues[0].text,
    );
    rememberCloudTranscription("user_a", "recording-1");
    assert.equal(hasCloudTranscription("user_a", "recording-1"), true);
    assert.equal(hasCloudTranscription("user_b", "recording-1"), false);
    await deleteCloudTranscription(
      "recording-1",
      getToken,
      undefined,
      "user_a",
    );
    assert.equal(calls.at(-1).options.method, "DELETE");
    assert.equal(hasCloudTranscription("user_a", "recording-1"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage)
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
  }
});

function withStorage() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  };
}

test("approved replacement survives local reloads, scopes the new job and preserves old corrections until it matches", () => {
  const restore = withStorage();
  try {
    const corrected = updateTranscriptCue(
      automatic,
      "cue-1",
      "Olá, comunidade.",
    );
    saveTranscript("recording-1", corrected);
    assert.equal(
      shouldReplaceCloudTranscript("user_a", "recording-1", "new-job"),
      false,
    );
    approveCloudReplacement("user_a", "recording-1");
    assert.equal(
      shouldReplaceCloudTranscript("user_a", "recording-1", "new-job"),
      true,
    );
    assert.equal(
      shouldReplaceCloudTranscript("user_b", "recording-1", "new-job"),
      false,
    );
    approveCloudReplacement("user_a", "recording-1", "new-job");
    assert.equal(
      shouldReplaceCloudTranscript("user_a", "recording-1", "old-job"),
      false,
    );
    assert.equal(
      loadTranscript("recording-1").cues[0].text,
      "Olá, comunidade.",
    );
    assert.equal(
      shouldReplaceCloudTranscript("user_a", "recording-1", "new-job"),
      true,
    );
    saveTranscript("recording-1", automatic);
    clearCloudReplacement("user_a", "recording-1");
    const final = updateTranscriptCue(
      loadTranscript("recording-1"),
      "cue-1",
      "Correção da nova transcrição.",
    );
    saveTranscript("recording-1", final);
    assert.equal(
      shouldReplaceCloudTranscript("user_a", "recording-1", "new-job"),
      false,
    );
    assert.equal(
      loadTranscript("recording-1").cues[0].text,
      "Correção da nova transcrição.",
    );
    assert.deepEqual(loadTranscript("recording-1").words, automatic.words);
  } finally {
    restore();
  }
});

test("deletion requires confirmed JSON idle state; unavailable routes preserve receipts and replacement intent", async () => {
  const restore = withStorage(),
    previousFetch = globalThis.fetch;
  try {
    for (const response of [
      new Response("Missing", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      }),
      new Response("SPA fallback", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
      Response.json({
        configured: true,
        status: "completed",
        maxUploadBytes: 100,
      }),
      Response.json({ configured: false, status: "idle", maxUploadBytes: 100 }),
    ]) {
      rememberCloudTranscription("user_a", "one");
      approveCloudReplacement("user_a", "one", "job-1");
      globalThis.fetch = async () => response;
      await assert.rejects(
        deleteCloudTranscription(
          "one",
          async () => "session",
          undefined,
          "user_a",
        ),
      );
      assert.equal(hasCloudTranscription("user_a", "one"), true);
      assert.equal(
        shouldReplaceCloudTranscript("user_a", "one", "job-1"),
        true,
      );
    }
    globalThis.fetch = async () =>
      Response.json({
        configured: true,
        status: "idle",
        maxUploadBytes: 100,
        cleanupPending: true,
      });
    await deleteCloudTranscription(
      "one",
      async () => "session",
      undefined,
      "user_a",
    );
    assert.equal(hasCloudTranscription("user_a", "one"), false);
    assert.equal(shouldReplaceCloudTranscript("user_a", "one", "job-1"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("deletion retries transient job locks with fresh tokens but remains bounded and honors cancellation", async () => {
  const restore = withStorage(),
    previousFetch = globalThis.fetch;
  let requests = 0,
    tokens = 0;
  try {
    rememberCloudTranscription("user_a", "one");
    approveCloudReplacement("user_a", "one", "job-1");
    globalThis.fetch = async (_url, options) => {
      requests++;
      assert.equal(options.headers.Authorization, `Bearer session-${requests}`);
      return requests < 3
        ? Response.json(
            { error: "Busy" },
            { status: 409, headers: { "Retry-After": "0" } },
          )
        : Response.json({
            configured: true,
            status: "idle",
            maxUploadBytes: 100,
          });
    };
    await deleteCloudTranscription(
      "one",
      async () => `session-${++tokens}`,
      undefined,
      "user_a",
    );
    assert.equal(requests, 3);
    assert.equal(tokens, 3);
    assert.equal(hasCloudTranscription("user_a", "one"), false);
    requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json(
        { error: "Busy" },
        { status: 409, headers: { "Retry-After": "0" } },
      );
    };
    await assert.rejects(
      deleteCloudTranscription("one", async () => "session"),
      (error) => error.status === 409,
    );
    assert.equal(requests, 4);
    requests = 0;
    const controller = new AbortController();
    globalThis.fetch = async () => {
      requests++;
      controller.abort();
      return Response.json(
        { error: "Busy" },
        { status: 409, headers: { "Retry-After": "3" } },
      );
    };
    await assert.rejects(
      deleteCloudTranscription("one", async () => "session", controller.signal),
      (error) => error.name === "AbortError",
    );
    assert.equal(requests, 1);
    requests = 0;
    await assert.rejects(
      deleteCloudTranscription("one", async () => "session", controller.signal),
      (error) => error.name === "AbortError",
    );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("signed-out and quota errors do not pretend to return a transcript; HTML means no deployed API", async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("SPA fallback", {
      headers: { "content-type": "text/html" },
    });
  };
  try {
    await assert.rejects(
      getCloudTranscription("one", async () => null),
      (error) =>
        error instanceof TranscriptionRequestError && error.status === 401,
    );
    assert.equal(requests, 0);
    assert.equal(
      (await getCloudTranscription("one", async () => "session")).configured,
      false,
    );
    globalThis.fetch = async () =>
      Response.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": "42" } },
      );
    await assert.rejects(
      getCloudTranscription("one", async () => "session"),
      (error) => error.status === 429 && error.retryAfter === 42,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("untrusted word alignments are rejected instead of becoming clickable source times", () => {
  assert.deepEqual(parseCloudTranscript(automatic).words, automatic.words);
  for (const words of [
    [{ ...automatic.words[0], start: -1 }],
    [{ ...automatic.words[0], end: 0.01 }],
    [automatic.words[1], automatic.words[0]],
    [{ ...automatic.words[0], text: "" }],
  ]) {
    assert.throws(
      () => parseCloudTranscript({ ...automatic, words }),
      /inválida/,
    );
  }
  assert.throws(
    () => parseCloudTranscript({ ...automatic, origin: "import" }),
    /inválida/,
  );
});
