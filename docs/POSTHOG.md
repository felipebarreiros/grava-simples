# PostHog

GravaSimples has its own project, **700132**, in the **Solid Skill** organization (US region).

- [Analytics dashboard](https://us.posthog.com/project/700132/dashboard/2283930)
- [Errors](https://us.posthog.com/project/700132/error_tracking)
- [Session replay](https://us.posthog.com/project/700132/replay/home)
- [Logs](https://us.posthog.com/project/700132/logs)
- [Tracing](https://us.posthog.com/project/700132/tracing)
- [Self-driving inbox](https://us.posthog.com/project/700132/inbox)

## Instrumentation

The browser loads `posthog-js/full/no-external` asynchronously. Replay, error tracking, logs, tracing headers and Web Vitals are bundled with the application, so the SDK does not need to inject third-party extension scripts. Existing COOP/COEP isolation remains enabled for recording and local export.

`src/analytics/client.ts` initializes the SDK. `AnalyticsBridge` identifies returning and newly signed-in Clerk users by their stable user ID. It resets identity on logout and account changes. Names and email addresses are not supplied. Manual pageviews use fixed route labels; native studio hash navigation is included. Local analytics are disabled unless `VITE_POSTHOG_ENABLED=true`; production and preview deployments collect in the same project, with deployment environment recorded.

Explicit creator events are `project_created`, `recording_started`, `recording_saved`, `recording_opened`, `video_downloaded`, `transcription_requested`, `transcript_corrected`, and `transcript_downloaded`. Properties are limited to orientation and subtitle format. Masked automatic interactions, heatmaps and Web Vitals are also enabled. Survey support is enabled, with no active survey campaign.

`server/analytics.ts` instruments all three transcription endpoints with request spans, provider/cleanup child spans, structured logs and sanitized failures. Authenticated Clerk identity is authoritative; incoming browser distinct-ID headers are not trusted. Validated browser session IDs join request traces to replays. Incoming W3C `traceparent` is continued when supplied. The browser SDK's PostHog headers provide session correlation; it does not create browser OpenTelemetry spans.

Logs use services `grava-simples-web` and `grava-simples-api`. Only purpose-written log records are exported; existing console output is not copied. Server exports are awaited with bounded timeouts, and telemetry failures do not change API results. Persisted server transitions emit `transcription_submitted`, `transcription_completed`, and `transcription_cancelled` once per actual transition.

There are no LLM prompt/completion call sites in this application. AssemblyAI transcription operations have regular spans and lifecycle events; fabricated AI-generation or token-usage events are not emitted.

## Privacy

Replay is enabled at 100% sampling with 30-day retention. Inputs and DOM text/attributes are masked. Video, audio, canvas, images (including SVG images), iframes, CSS image backgrounds, file/hidden inputs and Clerk authentication components are blocked. Canvas pixels, console recording, JSON-LD, network headers and bodies are disabled. PostHog session replay is interface telemetry; it does not upload creators' recorded video or audio.

Before-send filters remove URL queries, fragments, local project/take IDs, DOM text/attributes, referrers, raw exception messages and source context. These filters also cover SDK-generated top-level user properties. JavaScript asset filenames and line/column information remain for source-map symbolication. Replay network/navigation URLs are sanitized separately. Browser error messages are generic; stacks and operation categories support debugging. Server events never include request bodies, tokens, provider responses, transcripts or signed media URLs. Project IP anonymization and browser Do Not Track support are enabled.

## Vercel configuration and source maps

Public variables are `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`, and `VITE_DEPLOYMENT_ENVIRONMENT`. The public token identifies this analytics project and is safe for browser use. It is distinct from the personal API credential.

Server variables are `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. Source-map uploads use `POSTHOG_CLI_TOKEN`, `POSTHOG_CLI_PROJECT_ID=700132`, and `POSTHOG_CLI_HOST=https://us.posthog.com`. The CLI token is stored as a sensitive Vercel variable and never given a `VITE_` prefix. Current account authentication cannot mint a narrower personal key programmatically; an administrator can replace this value with a project-restricted key carrying `error_tracking:write` in PostHog user API-key settings.

Vite generates hidden source maps. `scripts/posthog-sourcemaps.mjs` injects chunk/release IDs, uploads maps during configured Vercel builds, then removes maps from the published assets. Missing upload configuration leaves ordinary local builds usable. The build fails if a configured upload fails, to avoid publishing an untraceable release.

## Self-driving

Five daily product scouts (general, product analytics, logs, APM and Web Vitals) plus operational inbox validation are enabled. Native health, error-created/reopened/spiking and log-alert sources feed the inbox. Scouts can write findings/notebooks; they do not merge code, send Slack messages or invoke webhooks. Existing organization AI approval and plan are unchanged.

The project currently has no GitHub OAuth integration. To let Self-driving propose code changes for this repository, connect `felipebarreiros/grava-simples` through [project integrations](https://us.posthog.com/project/700132/settings/environment-integrations). This cannot be completed with the available personal API-key authentication. Replay Vision scanner creation is not exposed by the available management tools and has not been configured.

## Validation

Node tests exercise URL/content sanitization, identity authority, safe error/log/span payloads and telemetry transport failures. `tests/analytics.spec.ts` runs the real browser SDK against intercepted transports, including replay snapshots, account changes, logs, source URL sanitization and correlation headers. To run it, start a separate Vite server with fake `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST=https://posthog.test`, and `VITE_POSTHOG_ENABLED=true`, then set `ANALYTICS_TEST_ENABLED=true` and `TEST_BASE_URL` for Playwright. It does not send data to PostHog or a transcription provider.
