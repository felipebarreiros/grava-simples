import test from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import { createRequestTelemetry } from "../server/analytics.ts";

const sessionId = "01977c1f-34ac-7000-8000-123456789abc";
const traceparent = "00-123456789012345678901234567890ab-1234567890abcdef-01";

function fixture({ configured = true, shutdown, headers = {} } = {}) {
  const calls = { captures: [], exceptions: [], spans: [], logs: [], shutdowns: 0, logShutdowns: 0 };
  const client = {
    capture: (message) => calls.captures.push(message),
    captureException: (...args) => calls.exceptions.push(args),
    startSpan: (name, options) => {
      const span = {
        name, options, statuses: [], ended: 0,
        setAttribute(key, value) { options.attributes[key] = value; return this; },
        setStatus(...status) { this.statuses.push(status); return this; },
        traceparent: () => traceparent,
        end() { this.ended++; },
      };
      calls.spans.push(span);
      return span;
    },
    async shutdown(timeout) { calls.shutdowns++; if (shutdown) await shutdown(timeout); },
  };
  const telemetry = createRequestTelemetry("transcriptions", new Request(
    "https://studio.test/api/transcriptions?recordingId=SECRET&token=SECRET#SECRET", {
      method: "POST",
      headers: {
        authorization: "Bearer SECRET",
        "x-posthog-session-id": sessionId,
        "x-posthog-distinct-id": "user_forged",
        traceparent,
        ...headers,
      },
      body: "PRIVATE TRANSCRIPT",
    },
  ), {
    env: configured ? { POSTHOG_PROJECT_TOKEN: "fixture-project-token", POSTHOG_HOST: "https://us.i.posthog.com", VERCEL_ENV: "production" } : {},
    createClient: () => client,
    createLogs: () => ({ emit: (record) => calls.logs.push(record), async shutdown() { calls.logShutdowns++; } }),
  });
  return { telemetry, calls };
}

test("server telemetry is inert when its project token is absent", async () => {
  const { telemetry, calls } = fixture({ configured: false });
  telemetry.identify("user_alice");
  telemetry.capture({ event: "transcription_submitted", status: "queued" });
  assert.equal(await telemetry.measure("provider_submit", async () => "result"), "result");
  await telemetry.finish(200);
  assert.deepEqual(calls, { captures: [], exceptions: [], spans: [], logs: [], shutdowns: 0, logShutdowns: 0 });
});

test("events contain only authenticated identity and allowlisted categorical values", async () => {
  const { telemetry, calls } = fixture();
  telemetry.capture({ event: "transcription_submitted", status: "queued" });
  assert.equal(calls.captures.length, 0);
  telemetry.identify("user_alice");
  telemetry.capture({ event: "transcription_submitted", status: "queued", transcript: "PRIVATE", blobUrl: "SECRET" });
  telemetry.capture({ event: "transcription_completed", outcome: "speech", error: "PRIVATE" });
  telemetry.capture({ event: "transcription_cancelled", previous_status: "processing" });
  telemetry.capture({ event: "arbitrary PRIVATE event", status: "queued" });
  telemetry.capture({ event: "transcription_completed", outcome: "PRIVATE" });
  assert.deepEqual(calls.captures.map(({ distinctId, event, properties }) => ({ distinctId, event, properties })), [
    { distinctId: "user_alice", event: "transcription_submitted", properties: { source: "server", provider: "assemblyai", environment: "production", status: "queued" } },
    { distinctId: "user_alice", event: "transcription_completed", properties: { source: "server", provider: "assemblyai", environment: "production", outcome: "speech" } },
    { distinctId: "user_alice", event: "transcription_cancelled", properties: { source: "server", provider: "assemblyai", environment: "production", previous_status: "processing" } },
  ]);
  await telemetry.finish(202);
  assert.equal(calls.logs[0].attributes.posthogDistinctId, "user_alice");
  assert.equal(calls.logs[0].attributes.sessionId, sessionId);
  assert.equal(calls.spans[0].options.attributes.posthogDistinctId, "user_alice");
  assert.equal(calls.spans[0].options.parent, traceparent);
  const logContext = trace.getSpanContext(calls.logs[0].context);
  assert.equal(logContext.traceId, "123456789012345678901234567890ab");
  assert.equal(logContext.spanId, "1234567890abcdef");
  assert.doesNotMatch(JSON.stringify(calls), /SECRET|PRIVATE|user_forged|authorization|recordingId/);
});

test("request traces and structured logs expose timing/status without raw exceptions or request data", async () => {
  const { telemetry, calls } = fixture();
  telemetry.identify("user_alice");
  const original = new Error("PRIVATE transcript at https://blob.test?SECRET");
  await assert.rejects(telemetry.measure("provider_poll", async () => { throw original; }), error => error === original);
  await telemetry.finish(502);
  await telemetry.finish(502);
  assert.equal(calls.spans.length, 2);
  assert.equal(calls.spans[1].options.parent, calls.spans[0]);
  assert.deepEqual(calls.spans[1].statuses, [["error", "operation_failed"]]);
  assert.equal(calls.spans[1].ended, 1);
  assert.equal(calls.exceptions.length, 1);
  const [error, distinctId, properties] = calls.exceptions[0];
  assert.equal(error.name, "TranscriptionApiFailure");
  assert.equal(error.message, "Transcription API: provider_poll_failed");
  assert.equal(distinctId, "user_alice");
  assert.equal(properties.failure_category, "provider_poll_failed");
  assert.equal(properties.$trace_id, "123456789012345678901234567890ab");
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.logs[0].body, "transcription_api_request");
  assert.equal(calls.logs[0].severityText, "ERROR");
  assert.equal(calls.logs[0].attributes.status_code, 502);
  assert.ok(calls.logs[0].attributes.duration_ms >= 0);
  assert.equal(calls.shutdowns, 1);
  assert.equal(calls.logShutdowns, 1);
  assert.doesNotMatch(error.stack, /PRIVATE|SECRET|blob\.test/);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE|SECRET|blob\.test/);
});

test("expected authorization failures are warnings and invalid correlation IDs are discarded", async () => {
  const { telemetry, calls } = fixture({ headers: { "x-posthog-session-id": "not-a-session PRIVATE" } });
  await telemetry.finish(401);
  assert.equal(calls.exceptions.length, 0);
  assert.equal(calls.logs[0].severityText, "WARN");
  assert.equal(calls.logs[0].attributes.authenticated, false);
  assert.equal(calls.logs[0].attributes.posthogDistinctId, undefined);
  assert.equal(calls.logs[0].attributes.sessionId, undefined);
  assert.equal(calls.spans[0].name, "POST /api/transcriptions");
  assert.equal(calls.spans[0].options.attributes.sessionId, undefined);
});

test("failed provider jobs are visible even when polling returns a successful HTTP response", async () => {
  const { telemetry, calls } = fixture();
  telemetry.identify("user_alice");
  telemetry.failure("invalid_transcript");
  await telemetry.finish(200);
  assert.equal(calls.logs[0].severityText, "ERROR");
  assert.equal(calls.logs[0].attributes.status_code, 200);
  assert.equal(calls.logs[0].attributes.failure_category, "invalid_transcript");
  assert.equal(calls.exceptions[0][0].message, "Transcription API: invalid_transcript");
});

test("failed and stalled exports cannot fail or indefinitely delay API requests", async () => {
  const failed = fixture({ shutdown: async () => { throw new Error("network failure"); } });
  await failed.telemetry.finish(200);
  const stalled = fixture({ shutdown: () => new Promise(() => {}) });
  const started = performance.now();
  await stalled.telemetry.finish(200);
  assert.ok(performance.now() - started < 2800);
  assert.equal(stalled.calls.logShutdowns, 1);
});
