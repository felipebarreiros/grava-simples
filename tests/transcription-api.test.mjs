import test from "node:test";
import assert from "node:assert/strict";
import {
  grantUpload,
  handleTranscriptions,
} from "../server/transcription/service.ts";
import { handleCleanup } from "../server/transcription/cleanup.ts";
import { normalizeTranscript } from "../server/transcription/normalize.ts";
import { ApiError } from "../server/transcription/security.ts";
import {
  MAX_UPLOAD_BYTES,
  JOB_LIFETIME_MS,
} from "../server/transcription/types.ts";

const id = "recording-fixture";
const pathname =
  "transcriptions/user_alice/recording-fixture/upload-1234567890123456.mp4";
const blobUrl = `https://fixture.private.blob.vercel-storage.com/${pathname}`;
const request = (method = "GET", body, query = id) =>
  new Request(`https://studio.test/api/transcriptions?recordingId=${query}`, {
    method,
    headers: {
      Authorization: "Bearer fixture",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function fixture() {
  let now = 1_800_000_000_000;
  const rows = new Map(),
    locks = new Map(),
    calls = {
      head: [],
      sign: [],
      submitted: [],
      polled: [],
      deletedBlobs: [],
      deletedProviders: [],
      quota: [],
    };
  const key = (userId, recordingId) => `${userId}:${recordingId}`;
  const repository = {
    get: async (userId, recordingId) =>
      structuredClone(rows.get(key(userId, recordingId)) ?? null),
    save: async (job) => {
      rows.set(key(job.userId, job.recordingId), structuredClone(job));
    },
    acquire: async (userId, recordingId) => {
      const name = key(userId, recordingId);
      if (locks.has(name)) return null;
      locks.set(name, "lock");
      return "lock";
    },
    release: async (userId, recordingId) => {
      locks.delete(key(userId, recordingId));
    },
    due: async (until, limit) =>
      [...rows.values()]
        .filter((job) => job.expiresAt <= until)
        .slice(0, limit)
        .map(({ userId, recordingId }) => ({ userId, recordingId })),
    remove: async (userId, recordingId) => {
      rows.delete(key(userId, recordingId));
    },
  };
  const deps = {
    configured: true,
    authenticate: async () => ({ userId: "user_alice" }),
    quota: async (userId, action) => {
      calls.quota.push({ userId, action });
    },
    repository,
    blob: {
      head: async (path) => {
        calls.head.push(path);
        return {
          pathname: path,
          url: blobUrl,
          size: 1024,
          contentType: "video/mp4",
        };
      },
      signedGet: async (path) => {
        calls.sign.push(path);
        return "https://private.test/single-file?scoped-secret";
      },
      delete: async (paths) => {
        calls.deletedBlobs.push(...paths);
      },
    },
    provider: {
      submit: async (url) => {
        calls.submitted.push(url);
        return { id: "provider-job-1", status: "queued" };
      },
      get: async (providerId) => {
        calls.polled.push(providerId);
        return {
          id: providerId,
          status: "completed",
          text: "Olá, mundo!",
          language_code: "pt",
          words: [
            { text: "Olá,", start: 500, end: 1000 },
            { text: "mundo!", start: 1200, end: 1800 },
          ],
        };
      },
      delete: async (providerId) => {
        calls.deletedProviders.push(providerId);
      },
    },
    now: () => now,
  };
  return {
    deps,
    rows,
    locks,
    calls,
    setNow: (next) => {
      now = next;
    },
    async grant() {
      return grantUpload(
        deps,
        "user_alice",
        pathname,
        JSON.stringify({ recordingId: id }),
      );
    },
  };
}

test("API rejects unauthenticated requests and reports missing configuration only after authentication", async () => {
  const f = fixture();
  f.deps.authenticate = async () => {
    throw new ApiError(401, "Entre na sua conta.");
  };
  f.deps.configured = false;
  assert.equal((await handleTranscriptions(request(), f.deps)).status, 401);
  assert.equal(f.calls.quota.length, 0);
  f.deps.authenticate = async () => ({ userId: "user_alice" });
  const response = await handleTranscriptions(request(), f.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: false,
    status: "idle",
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxAudioSeconds: 7200,
  });
  assert.equal(
    (
      await handleTranscriptions(
        request("POST", { recordingId: id, blobUrl }),
        f.deps,
      )
    ).status,
    503,
  );
});

test("upload grants bind exact authenticated owner, recording and path; retry reuses one quota slot", async () => {
  const f = fixture();
  await assert.rejects(
    grantUpload(
      f.deps,
      "user_bob",
      pathname,
      JSON.stringify({ recordingId: id }),
    ),
    (error) => error.status === 403,
  );
  await assert.rejects(
    grantUpload(
      f.deps,
      "user_alice",
      pathname.replace(".mp4", "/../other.mp4"),
      JSON.stringify({ recordingId: id }),
    ),
    (error) => error.status === 403,
  );
  const token = await f.grant();
  assert.equal(token.maximumSizeInBytes, 512 * 1024 * 1024);
  assert.equal(token.addRandomSuffix, false);
  assert.equal(token.allowOverwrite, false);
  assert.deepEqual(token.allowedContentTypes.includes("video/mp4"), true);
  assert.equal(token.validUntil, f.deps.now() + 15 * 60 * 1000);
  await f.grant();
  assert.equal(
    f.calls.quota.filter((call) => call.action === "upload").length,
    1,
  );
});

test("submission rejects arbitrary URLs, wrong store, excess sizes, invalid types and invalid recording IDs", async () => {
  const f = fixture();
  await f.grant();
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    blobUrl.replace("fixture.private", "other.private"),
    blobUrl + "?download=1",
  ]) {
    const response = await handleTranscriptions(
      request("POST", { recordingId: id, blobUrl: url }),
      f.deps,
    );
    assert.equal(response.status, 403);
  }
  assert.equal(f.calls.submitted.length, 0);
  assert.ok(f.calls.head.every((path) => path === pathname));
  f.deps.blob.head = async () => ({
    pathname,
    url: blobUrl,
    size: MAX_UPLOAD_BYTES + 1,
    contentType: "video/mp4",
  });
  assert.equal(
    (
      await handleTranscriptions(
        request("POST", { recordingId: id, blobUrl }),
        f.deps,
      )
    ).status,
    413,
  );
  f.deps.blob.head = async () => ({
    pathname,
    url: blobUrl,
    size: 100,
    contentType: "text/html",
  });
  assert.equal(
    (
      await handleTranscriptions(
        request("POST", { recordingId: id, blobUrl }),
        f.deps,
      )
    ).status,
    415,
  );
  assert.equal(
    (await handleTranscriptions(request("GET", undefined, "../victim"), f.deps))
      .status,
    400,
  );
});

test("submission is idempotent and another account cannot read, delete or submit its recording", async () => {
  const f = fixture();
  await f.grant();
  const first = await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  assert.equal(first.status, 202);
  assert.equal((await first.json()).status, "queued");
  const second = await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  assert.equal(second.status, 202);
  assert.equal(f.calls.submitted.length, 1);
  assert.equal(
    f.calls.quota.filter((call) => call.action === "submit").length,
    1,
  );
  f.deps.authenticate = async () => ({ userId: "user_bob" });
  assert.equal(
    (await (await handleTranscriptions(request(), f.deps)).json()).status,
    "idle",
  );
  assert.equal(
    (
      await handleTranscriptions(
        request("POST", { recordingId: id, blobUrl }),
        f.deps,
      )
    ).status,
    400,
  );
  await handleTranscriptions(request("DELETE"), f.deps);
  assert.equal(f.calls.deletedProviders.length, 0);
  assert.ok(await f.deps.repository.get("user_alice", id));
});

test("real words are returned with source times, cached across polls, and source cleanup failures do not hide results", async () => {
  const f = fixture();
  await f.grant();
  await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  f.deps.blob.delete = async () => {
    throw new Error("temporary");
  };
  const response = await handleTranscriptions(request(), f.deps);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "completed");
  assert.equal(result.transcript.origin, "automatic");
  assert.equal(result.transcript.provider, "assemblyai");
  assert.equal(result.transcript.language, "pt");
  assert.deepEqual(result.transcript.words, [
    { id: "word-1", text: "Olá,", start: 0.5, end: 1 },
    { id: "word-2", text: "mundo!", start: 1.2, end: 1.8 },
  ]);
  assert.deepEqual(result.transcript.cues, [
    { id: "cue-1", text: "Olá, mundo!", start: 0.5, end: 1.8 },
  ]);
  assert.equal(
    (await (await handleTranscriptions(request(), f.deps)).json()).status,
    "completed",
  );
  assert.equal(f.calls.polled.length, 1);
  assert.deepEqual(f.calls.deletedProviders, ["provider-job-1"]);
  assert.ok(!JSON.stringify(result).includes("scoped-secret"));
});

test("silent audio completes explicitly without fabricating speech; invalid provider timing fails closed", async () => {
  const f = fixture();
  await f.grant();
  await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  f.deps.provider.get = async () => ({
    id: "provider-job-1",
    status: "completed",
    text: "",
    words: [],
  });
  const silent = await (await handleTranscriptions(request(), f.deps)).json();
  assert.equal(silent.noSpeech, true);
  assert.equal(silent.transcript, undefined);
  assert.equal(silent.status, "completed");
  assert.throws(
    () =>
      normalizeTranscript(
        {
          id: "bad",
          status: "completed",
          words: [{ text: "wrong", start: 2000, end: 1000 }],
        },
        f.deps.now(),
      ),
    (error) => error.status === 502,
  );
  assert.throws(
    () =>
      normalizeTranscript(
        { id: "bad", status: "completed", words: [], text: "Untimed words" },
        f.deps.now(),
      ),
    (error) => error.status === 502,
  );
});

test("distributed quota denial returns Retry-After; storage failures never submit unmetered jobs", async () => {
  const f = fixture();
  await f.grant();
  f.deps.quota = async () => {
    throw new ApiError(429, "Limite atingido.", 60);
  };
  let response = await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(f.calls.submitted.length, 0);
  f.deps.quota = async () => {
    throw new Error("Redis unavailable");
  };
  response = await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  assert.equal(response.status, 503);
  assert.equal(f.calls.submitted.length, 0);
  f.deps.quota = async () => {};
  f.locks.set(`user_alice:${id}`, "busy");
  response = await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  assert.equal(response.status, 409);
});

test("owner cancellation removes cached text and cleans sources; daily cleanup retries and expires abandoned jobs", async () => {
  const f = fixture();
  await f.grant();
  await handleTranscriptions(
    request("POST", { recordingId: id, blobUrl }),
    f.deps,
  );
  const cancelled = await (
    await handleTranscriptions(request("DELETE"), f.deps)
  ).json();
  assert.equal(cancelled.status, "idle");
  assert.equal(cancelled.cleanupPending, false);
  assert.deepEqual(f.calls.deletedBlobs, [pathname]);
  assert.deepEqual(f.calls.deletedProviders, ["provider-job-1"]);
  const stored = await f.deps.repository.get("user_alice", id);
  assert.equal(stored.status, "deleted");
  assert.equal(stored.transcript, undefined);
  assert.equal(
    (
      await handleCleanup(
        new Request("https://studio.test/api/transcription-cleanup"),
        f.deps,
        "cron-secret",
      )
    ).status,
    401,
  );
  f.setNow(f.deps.now() + JOB_LIFETIME_MS + 1);
  f.deps.blob.delete = async () => {
    throw new Error("temporary");
  };
  const cron = () =>
    new Request("https://studio.test/api/transcription-cleanup", {
      headers: { Authorization: "Bearer cron-secret" },
    });
  assert.equal(
    (await handleCleanup(cron(), f.deps, "cron-secret")).status,
    503,
  );
  assert.ok(await f.deps.repository.get("user_alice", id));
  f.deps.blob.delete = async () => {};
  assert.equal(
    (await handleCleanup(cron(), f.deps, "cron-secret")).status,
    200,
  );
  assert.equal(await f.deps.repository.get("user_alice", id), null);
});

test('normalization bounds UTF-8 response size and cue text while retaining original word timing', () => {
  const word = 'é'.repeat(600);
  const source = { id: 'long', status: 'completed', words: Array.from({ length: 25 }, (_, index) => ({ text: word, start: index * 10, end: index * 10 + 5 })) };
  const normalized = normalizeTranscript(source, Date.now());
  assert.ok(normalized.transcript.cues.every(cue => cue.text.length < 10_000));
  assert.equal(normalized.transcript.words.at(-1).start, 0.24);
  const excessive = { ...source, words: Array.from({ length: 2500 }, (_, index) => ({ text: word, start: index * 10, end: index * 10 + 5 })) };
  assert.throws(() => normalizeTranscript(excessive, Date.now()), error => error.status === 502);
});
