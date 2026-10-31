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

Creator events cover signup entry, authenticated sessions, studio visits, capture requests/readiness/failures, recording start/completion/failure, local save outcomes, export preparation/failure, requested downloads and transcript actions. Operational properties use a fixed allowlist of categories and bounded numeric counters. Masked automatic interactions, heatmaps and Web Vitals are also enabled.

`signup_viewed` records signup entry and `account_authenticated` records one authenticated Clerk session, deduplicated across page reloads. They do not infer that a returning user created a new account. Capture events use a `stage`; activation funnels select `record_intent`, while source and microphone connections remain separate. `recording_completed` means the recorder finished normally. `recording_saved` includes `outcome=complete` or `outcome=recovered`, so recovered partial files are visible without being counted as complete activation.

`export_prepared` means a usable compatible file is ready. `download_requested` covers original, compatible and repeated download clicks; the browser cannot verify that a user saved a file to disk. The older `video_downloaded` compatibility event remains. `measured_capture_fps` measures rendered canvas cadence over recording duration, not independently decoded video FPS. `capture_below_target` is emitted only for recordings of at least two seconds and means cadence below 80% of the configured target.

## Recording health and product views

- [Recording reliability](https://us.posthog.com/project/700132/dashboard/2284066): seven insights covering recording/save outcomes, capture failures, preparation time, export outcomes/success rate/latency and capture cadence.
- [Creator activation and retention](https://us.posthog.com/project/700132/dashboard/2284068): seven insights covering acquisition, record-intent activation, studio-to-save conversion time, export/download requests, weekly successful creators and weekly retention.
- Behavioral cohorts: activated creators (a complete save in 90 days, `679333`), repeat creators (at least two complete saves in 30 days, `679334`), and at-risk creators (a complete save in 90 days but none in seven days, `679336`). Weekly retention measures return activity separately from taking several recordings in one visit.

Four enabled log alerts detect recording failures, export failures, API errors and low capture cadence. Each requires five matching log records within an hour and has a 60-minute cooldown. Expected permission denials and cancellations remain visible in capture dashboards but do not trigger the recording-failure alarm. Alerts feed the existing Self-driving inbox source; no Slack, email or webhook destination was added. Recording failure counts and recovered saves are shown separately, and export success rate uses terminal prepared/failed outcomes as its denominator.

The views use the new event definitions; older saves without an `outcome` property are not retroactively labelled successful. Production/internal traffic filtering and application rollout flags were left unchanged for this work.

## Creator feedback

The [Portuguese feedback survey](https://us.posthog.com/project/700132/surveys/01a18fa4-1dff-0000-ff0d-b71c893d0ad9) is a launched headless API survey, capped at 100 responses. It asks “O que você queria fazer e não conseguiu?” after a complete local save. `VITE_POSTHOG_CREATOR_SURVEY_ID` selects the campaign.

The app waits at least five seconds and for the studio to be idle with other dialogs closed. The prompt is optional, can be dismissed, and is not shown for recovered files or opted-out analytics. Browser markers are scoped to the account and campaign; native PostHog eligibility excludes responded/dismissed users across devices. SDK-generated internal survey eligibility is active; no application feature rollout flag was introduced.

Only explicit submission sends the response, using the documented `survey sent` event and question-specific response property. `survey shown` and `survey dismissed` carry no answer. The feedback surface is excluded from replay/autocapture, and response text never enters operational logs. Survey responses are intentional product feedback; recorded media and transcript content remain excluded. Loading failures leave recording available and suppress the optional prompt.

`server/analytics.ts` instruments all three transcription endpoints with request spans, provider/cleanup child spans, structured logs and sanitized failures. Authenticated Clerk identity is authoritative; incoming browser distinct-ID headers are not trusted. Validated browser session IDs join request traces to replays. Incoming W3C `traceparent` is continued when supplied. The browser SDK's PostHog headers provide session correlation; it does not create browser OpenTelemetry spans.

Logs use services `grava-simples-web` and `grava-simples-api`. Only purpose-written log records are exported; existing console output is not copied. Server exports are awaited with bounded timeouts, and telemetry failures do not change API results. Persisted server transitions emit `transcription_submitted`, `transcription_completed`, and `transcription_cancelled` once per actual transition.

There are no LLM prompt/completion call sites in this application. AssemblyAI transcription operations have regular spans and lifecycle events; fabricated AI-generation or token-usage events are not emitted.

## Privacy

Replay is enabled at 100% sampling with 30-day retention. Inputs and DOM text/attributes are masked. Video, audio, canvas, images (including SVG images), iframes, CSS image backgrounds, file/hidden inputs and Clerk authentication components are blocked. Canvas pixels, console recording, JSON-LD, network headers and bodies are disabled. PostHog session replay is interface telemetry; it does not upload creators' recorded video or audio.

Before-send filters remove URL queries, fragments, local project/take IDs, DOM text/attributes, referrers, raw exception messages and source context. These filters also cover SDK-generated top-level user properties. JavaScript asset filenames and line/column information remain for source-map symbolication. Replay network/navigation URLs are sanitized separately. Browser error messages are generic; stacks and operation categories support debugging. Server events never include request bodies, tokens, provider responses, transcripts or signed media URLs. Project IP anonymization and browser Do Not Track support are enabled.

## Vercel configuration and source maps

Public variables are `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST`, and `VITE_DEPLOYMENT_ENVIRONMENT`. The public token identifies this analytics project and is safe for browser use. It is distinct from the personal API credential.

`VITE_POSTHOG_CREATOR_SURVEY_ID` is configured for production and preview, referencing the headless creator-feedback campaign.

Server variables are `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. Source-map uploads use `POSTHOG_CLI_TOKEN`, `POSTHOG_CLI_PROJECT_ID=700132`, and `POSTHOG_CLI_HOST=https://us.posthog.com`. The CLI token is stored as a sensitive Vercel variable and never given a `VITE_` prefix. Current account authentication cannot mint a narrower personal key programmatically; an administrator can replace this value with a project-restricted key carrying `error_tracking:write` in PostHog user API-key settings.

Vite generates hidden source maps. `scripts/posthog-sourcemaps.mjs` injects chunk/release IDs, uploads maps during configured Vercel builds, then removes maps from the published assets. Missing upload configuration leaves ordinary local builds usable. The build fails if a configured upload fails, to avoid publishing an untraceable release.

## Self-driving

Five daily product scouts (general, product analytics, logs, APM and Web Vitals) plus operational inbox validation are enabled. Native health, error-created/reopened/spiking and log-alert sources feed the inbox. Scouts can write findings/notebooks; they do not merge code, send Slack messages or invoke webhooks. Existing organization AI approval and plan are unchanged.

The [GitHub integration](https://us.posthog.com/project/700132/settings/environment-integrations) is connected (integration `344224`), reusing the existing installation for `felipebarreiros`. Repository access to `felipebarreiros/grava-simples` was verified. Project steering selects this repository only, with `main` as the base branch. This steering is not a GitHub permission allowlist: the shared installation's existing repository access remains unchanged. No extra implementation repositories are configured.

Self-driving autostart is enabled, with a maximum of five reports per day. Implementations open draft PRs for human review; project instructions prohibit automatic merging, publishing or deployment. Configuration and repository read access were verified; no synthetic implementation task or write-test PR was created.

Three [Replay Vision scanners](https://us.posthog.com/project/700132/replay-vision) are enabled:

| Scanner | Sampling | Hard cap per billing period | Inbox findings |
| --- | --- | --- | --- |
| Broken creator workflows | 25% | 100 credits | Yes |
| Repeated interaction friction (rage clicks) | 50% | 100 credits | Yes |
| Creator session summaries | 5% | 100 credits | No |

The combined scanner cap is 300 credits ($3 at configuration time). The organization budget and plan are unchanged. Filters use sanitized route labels, and prompts respect masked content rather than trying to reconstruct it. Monitor findings feed the native `replay_vision/scanner_finding` source. Estimates initially showed no qualifying traffic, and setup did not trigger paid backfills or on-demand analysis. Scanner creation and settings were verified through supported REST endpoints; those write operations are not exposed in the current CLI tool catalog.

## Validation

Node tests exercise URL/content sanitization, identity authority, safe error/log/span payloads and telemetry transport failures. `tests/analytics.spec.ts` runs the real browser SDK against intercepted transports, including replay snapshots, account changes, logs, source URL sanitization and correlation headers. To run it, start a separate Vite server with fake `VITE_POSTHOG_PROJECT_TOKEN`, `VITE_POSTHOG_HOST=https://posthog.test`, and `VITE_POSTHOG_ENABLED=true`, then set `ANALYTICS_TEST_ENABLED=true` and `TEST_BASE_URL` for Playwright. It does not send data to PostHog or a transcription provider.

Additional creator analytics tests cover safe metric reconstruction, actual capture/save/export success and failures, download request semantics, and the optional feedback lifecycle. Survey tests use the real SDK with intercepted definitions/eligibility/ingestion, so no test responses enter the live campaign.
