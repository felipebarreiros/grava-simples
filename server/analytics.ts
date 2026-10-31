import { PostHog, type Span } from "posthog-node";
import {
  ROOT_CONTEXT,
  SeverityNumber,
  trace,
  type LogRecord,
} from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";

const REQUEST_TIMEOUT_MS = 1200;
const SHUTDOWN_TIMEOUT_MS = 1800;
const SERVICE_NAME = "grava-simples-api";

type Endpoint = "transcriptions" | "transcription-upload" | "transcription-cleanup";
type Operation = "provider_submit" | "provider_poll" | "source_cleanup";
type Failure = "provider_submission_failed" | "provider_poll_failed" | "provider_transcription_failed" | "invalid_transcript" | "source_cleanup_pending";
type BusinessEvent =
  | { event: "transcription_submitted"; status: "queued" | "processing" }
  | { event: "transcription_completed"; outcome: "speech" | "no_speech" }
  | { event: "transcription_cancelled"; previous_status: "uploading" | "submitting" | "queued" | "processing" };
type AnalyticsClient = Pick<PostHog, "capture" | "captureException" | "startSpan" | "shutdown">;
interface LogTransport {
  emit(record: LogRecord): void;
  shutdown(): Promise<void>;
}
interface TelemetryOptions {
  env?: NodeJS.ProcessEnv;
  createClient?: (token: string, host: string, environment: string) => AnalyticsClient;
  createLogs?: (token: string, host: string, environment: string) => LogTransport;
}

function environment(env: NodeJS.ProcessEnv): string {
  return ["production", "preview", "development"].includes(env.VERCEL_ENV || "")
    ? env.VERCEL_ENV!
    : "development";
}

function createClient(token: string, host: string, env: string): AnalyticsClient {
  return new PostHog(token, {
    host,
    flushAt: 20,
    flushInterval: 0,
    requestTimeout: REQUEST_TIMEOUT_MS,
    fetchRetryCount: 0,
    enableLocalEvaluation: false,
    enableExceptionAutocapture: false,
    disableGeoip: true,
    privacyMode: true,
    traces: {
      serviceName: SERVICE_NAME,
      environment: env,
      flushIntervalMs: 30_000,
      maxQueueSize: 20,
      maxLiveSpans: 10,
      maxAttributesPerSpan: 12,
      maxAttributeValueLength: 128,
      // Never retain exception events or arbitrary attributes on API spans.
      beforeSpanSend: (span) => ({
        ...span,
        events: [],
        attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key]) => [
          "http.request.method", "http.response.status_code", "http.route",
          "posthogDistinctId", "sessionId", "operation",
        ].includes(key))),
      }),
    },
  });
}

function createLogs(token: string, host: string, env: string): LogTransport {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": SERVICE_NAME,
      "deployment.environment": env,
    }),
    logRecordLimits: { attributeCountLimit: 12, attributeValueLengthLimit: 128 },
    processors: [new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: `${host}/i/v1/logs`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMillis: REQUEST_TIMEOUT_MS,
      }),
      scheduledDelayMillis: 30_000,
      exportTimeoutMillis: REQUEST_TIMEOUT_MS,
      maxQueueSize: 10,
      maxExportBatchSize: 10,
    })],
  });
  const logger = provider.getLogger(SERVICE_NAME);
  return { emit: (record) => logger.emit(record), shutdown: () => provider.shutdown() };
}

function safely<T>(action: () => T): T | undefined {
  try { return action(); } catch { return undefined; }
}

async function bounded(action: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); }),
    ]);
  } catch {
    // Observability failures never change the transcription operation's result.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failureCategory(status: number): string {
  if (status === 502) return "upstream_failure";
  if (status === 503) return "service_unavailable";
  if (status === 504) return "upstream_timeout";
  return "internal_failure";
}

/**
 * One request owns its queue and awaits export before returning on Vercel.
 * Neither URLs, headers, bodies, original errors nor creator content enter it.
 * Factories allow transport-free tests without a test mode in production.
 */
export function createRequestTelemetry(
  endpoint: Endpoint,
  request: Request,
  options: TelemetryOptions = {},
) {
  const env = options.env ?? process.env;
  const token = env.POSTHOG_PROJECT_TOKEN;
  const host = (env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
  const configured = Boolean(token && ["https://us.i.posthog.com", "https://eu.i.posthog.com"].includes(host));
  const deployment = environment(env);
  const client = configured ? safely(() => (options.createClient ?? createClient)(token!, host, deployment)) : undefined;
  // Logs use an independent OTLP exporter. No process-wide console interception.
  let logs: LogTransport | undefined;
  const method = ["GET", "POST", "DELETE", "OPTIONS"].includes(request.method) ? request.method : "OTHER";
  const route = `/api/${endpoint}`;
  const parent = request.headers.get("traceparent") || undefined;
  const suppliedSession = request.headers.get("x-posthog-session-id") || "";
  const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedSession)
    ? suppliedSession.toLowerCase() : undefined;
  const attributes = {
    "http.request.method": method,
    "http.route": route,
    ...(sessionId ? { sessionId } : {}),
  };
  const span = safely(() => client?.startSpan(`${method} ${route}`, { kind: "server", parent, attributes }));
  const started = performance.now();
  let userId: string | undefined;
  let finished = false;
  let operationFailure: Failure | undefined;
  const correlation = () => {
    const value = safely(() => span?.traceparent());
    const matched = value && /^\w{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
    return matched ? {
      traceId: matched[1], spanId: matched[2], traceFlags: parseInt(matched[3], 16),
    } : undefined;
  };
  return {
    identify(verifiedUserId: string) {
      // The caller supplies only its authenticated Clerk result. The browser's
      // X-POSTHOG-DISTINCT-ID is deliberately not an authority for this value.
      if (/^user_[A-Za-z0-9_-]{1,128}$/.test(verifiedUserId)) {
        userId = verifiedUserId;
        safely(() => span?.setAttribute("posthogDistinctId", userId));
      }
    },
    capture(value: BusinessEvent) {
      if (!userId) return;
      // Explicit reconstruction keeps arbitrary runtime properties out as well
      // as preventing accidental additions through TypeScript call sites.
      const properties: Record<string, string> = { source: "server", provider: "assemblyai", environment: deployment };
      if (value.event === "transcription_submitted" && ["queued", "processing"].includes(value.status)) properties.status = value.status;
      else if (value.event === "transcription_completed" && ["speech", "no_speech"].includes(value.outcome)) properties.outcome = value.outcome;
      else if (value.event === "transcription_cancelled" && ["uploading", "submitting", "queued", "processing"].includes(value.previous_status)) properties.previous_status = value.previous_status;
      else return;
      safely(() => client?.capture({ distinctId: userId, event: value.event, properties, sendFeatureFlags: false }));
    },
    failure(category: Failure) {
      if (["provider_submission_failed", "provider_poll_failed", "provider_transcription_failed", "invalid_transcript", "source_cleanup_pending"].includes(category)) operationFailure ??= category;
    },
    async measure<T>(operation: Operation, action: () => Promise<T>): Promise<T> {
      const child: Span | undefined = safely(() => client?.startSpan(operation, {
        parent: span,
        kind: operation === "source_cleanup" ? "internal" : "client",
        attributes: { operation, ...(userId ? { posthogDistinctId: userId } : {}), ...(sessionId ? { sessionId } : {}) },
      }));
      try {
        const result = await action();
        if (operation === "source_cleanup" && result === false) {
          operationFailure ??= "source_cleanup_pending";
          safely(() => child?.setStatus("error", "source_cleanup_pending"));
        } else safely(() => child?.setStatus("ok"));
        return result;
      } catch (error) {
        operationFailure ??= operation === "provider_submit" ? "provider_submission_failed" : operation === "provider_poll" ? "provider_poll_failed" : "source_cleanup_pending";
        safely(() => child?.setStatus("error", "operation_failed"));
        throw error;
      } finally {
        safely(() => child?.end());
      }
    },
    async finish(status: number) {
      if (finished) return;
      finished = true;
      const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
      const failed = safeStatus >= 500 || Boolean(operationFailure);
      const failure = operationFailure || failureCategory(safeStatus);
      const ids = correlation();
      const common = {
        endpoint,
        method,
        status_code: safeStatus,
        environment: deployment,
        authenticated: Boolean(userId),
        ...(failed ? { failure_category: failure } : {}),
        ...(userId ? { posthogDistinctId: userId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
      if (failed) {
        // Creating a fixed error intentionally discards user input, provider
        // errors and signed media URLs that could occur in an original stack.
        const error = new Error(`Transcription API: ${failure}`);
        error.name = "TranscriptionApiFailure";
        safely(() => client?.captureException(error, userId || "grava-simples-api", {
          ...common,
          ...(ids ? { $trace_id: ids.traceId, $span_id: ids.spanId } : {}),
        }));
      }
      safely(() => {
        span?.setAttribute("http.response.status_code", safeStatus);
        span?.setStatus(failed ? "error" : "ok");
        span?.end();
      });
      if (configured) logs = safely(() => (options.createLogs ?? createLogs)(token!, host, deployment));
      safely(() => logs?.emit({
        body: "transcription_api_request",
        severityNumber: failed ? SeverityNumber.ERROR : safeStatus >= 400 ? SeverityNumber.WARN : SeverityNumber.INFO,
        severityText: failed ? "ERROR" : safeStatus >= 400 ? "WARN" : "INFO",
        attributes: { ...common, duration_ms: Math.max(0, Math.round(performance.now() - started)) },
        ...(ids ? { context: trace.setSpanContext(ROOT_CONTEXT, ids) } : {}),
      }));
      await Promise.all([
        client ? bounded(() => client.shutdown(SHUTDOWN_TIMEOUT_MS)) : Promise.resolve(),
        logs ? bounded(() => logs!.shutdown()) : Promise.resolve(),
      ]);
    },
  };
}

export type RequestTelemetry = ReturnType<typeof createRequestTelemetry>;

export async function observeServerRequest(
  endpoint: Endpoint,
  request: Request,
  action: (telemetry: RequestTelemetry) => Promise<Response>,
): Promise<Response> {
  const telemetry = createRequestTelemetry(endpoint, request);
  let status = 500;
  try {
    const response = await action(telemetry);
    status = response.status;
    return response;
  } finally {
    await telemetry.finish(status);
  }
}
