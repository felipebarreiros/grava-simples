# Deploying automatic transcription on Vercel

The application uses Vercel Node Functions as an authenticated API and AssemblyAI Universal-2 for hosted inference. Vercel does not load a speech model into each invocation. Temporary recordings upload directly to a **private** Vercel Blob store; Upstash Redis stores account ownership, shared rate limits and job state.

The implementation can be built and tested with provider mocks. A successful local test does not establish live AssemblyAI accuracy, processing time, billing, or production Blob/Clerk configuration. Those require configured service accounts and a deployed smoke test.

`npm run dev` serves the Vite frontend. To run the Node API locally as well, link the Vercel project, pull its development environment, and use `npx vercel dev`. Use the matching local origin in `APP_ORIGINS`. Run `npm run test:transcription` for focused server/client checks and `npx playwright test tests/cloud-transcription.spec.ts tests/recording-detail.spec.ts` against the Vite server for deterministic browser flows.

## Deployment setup

1. Import this repository into Vercel using the Vite preset. The included `vercel.json` builds with `npm run build`, serves `dist/`, and deploys `api/` as Node Functions. Use Node.js 24, matching local validation.
2. Configure the existing Clerk production instance for the deployed application domain. Use the matching frontend publishable key and server verification credential. Do not create a separate Clerk application just for transcription.
3. Add a Vercel Blob store to this Vercel project and choose **Private** access when creating it. Connect it to every deployment environment that will run transcription. The simple configuration uses its server-side `BLOB_READ_WRITE_TOKEN`.
4. Add an Upstash Redis integration/database, then set its REST URL and REST token. The limiter must use this shared database; per-process counters would reset or diverge across serverless instances. Use a separate database or isolated environment credentials for preview/development.
5. Create an AssemblyAI account/API key. Only the backend receives it. Enable billing and provider spend controls appropriate for the intended usage before making transcription available to customers.
6. Set the variables below for the target environment, generate a long random `CRON_SECRET`, and redeploy. Environment changes do not update an existing Vite bundle automatically.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Public browser key for the selected Clerk instance; required at build time. |
| `CLERK_SECRET_KEY` **or** `CLERK_JWT_KEY` | Server-side Clerk session verification. The JWT-key option is Clerk's public verification key; the secret-key option must stay server-side. |
| `CLERK_PUBLISHABLE_KEY` | Optional server-only spelling of the matching publishable key; the backend can also read `VITE_CLERK_PUBLISHABLE_KEY`. |
| `APP_ORIGINS` | Required comma-separated exact application origins, for example `https://grava.example.com,https://grava-simples.vercel.app`. Use scheme and host, without paths or trailing slashes. Explicitly configure approved preview origins; do not allow every `*.vercel.app` origin. |
| `ASSEMBLYAI_API_KEY` | Hosted transcription credential, kept on the server. |
| `ASSEMBLYAI_SPEECH_MODEL` | Optional server-only model override: `universal-2` (default) or `universal-3-5-pro`. |
| `BLOB_READ_WRITE_TOKEN` | Credential for the connected **private** Blob store. |
| `UPSTASH_REDIS_REST_URL` | Shared Redis REST endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | Shared Redis REST credential. |
| `CRON_SECRET` | Authenticates scheduled cleanup requests. Vercel sends it as a bearer token to the configured cron route. |

Except for the deliberately public Clerk publishable key, never prefix service credentials with `VITE_`. Vite exposes variables with that prefix to browser code. Keep real values out of `.env.example`, Git, screenshots and source archives.

## How requests flow

```mermaid
sequenceDiagram
    participant Browser
    participant API as Vercel API
    participant Redis as Upstash Redis
    participant Blob as Private Vercel Blob
    participant ASR as AssemblyAI
    Browser->>API: Clerk bearer token and upload request
    API->>Redis: Check user quota and recording ownership
    API-->>Browser: Restricted upload authorization
    Browser->>Blob: Upload one saved output directly
    Browser->>API: Submit recording ID and uploaded blob URL
    API->>Redis: Validate ownership and reserve job
    API->>ASR: Submit job with temporary private-file access
    ASR-->>API: Durable provider job ID
    API-->>Browser: Queued job
    Browser->>API: Poll status with Clerk token
    API->>ASR: Fetch provider status/result
    API-->>Browser: Real timestamped transcript when ready
```

Only one orientation needs transcription because the two saved videos contain the same session audio. Uploading media directly to Blob avoids Vercel's 4.5 MB Function request-body limit. API requests exchange small authorization and job documents rather than relaying whole recordings. The server permits only media references belonging to the authenticated upload flow, not arbitrary external URLs.

The provider holds the long-running job. Submit and status calls finish promptly rather than keeping a Lambda-style invocation open until speech recognition completes. The 60-second Function setting is a request budget, not a maximum permitted recording duration.

### Endpoint outline

| Endpoint | Role |
| --- | --- |
| `POST /api/transcription-upload` | Vercel Blob SDK upload-authorization protocol, guarded by Clerk and shared quota. |
| `POST /api/transcriptions` | JSON `{ recordingId, blobUrl }`; validates ownership and submits or reuses the recording's job. |
| `GET /api/transcriptions?recordingId=…` | Returns that signed-in user's job status or completed transcript. |
| `DELETE /api/transcriptions?recordingId=…` | Cancels/removes that user's transcription job and its temporary resources. |
| `GET /api/transcription-cleanup` | Scheduled cleanup, authenticated with `CRON_SECRET` rather than a customer session. |

Job knowledge is not authorization: status and cancellation check account ownership independently. Keys and provider responses must not be logged with session tokens, signed media URLs, or recording content.

User endpoints require an explicit Clerk bearer token; a session cookie alone does not authorize them. Status responses include `configured`, `status`, `jobId`, `error`, `noSpeech`, optional `transcript`, and `maxUploadBytes`. Submission returns HTTP 202 with a queued job; cancellation returns an idle state. Word times are normalized from the provider's actual millisecond values to seconds.

## Limits and retention

The initial backend policy allows one media object up to **512 MB** and processes at most **two hours** of source audio. The duration cap is passed to the provider; browser-supplied duration is not trusted as a billing boundary. Default per-user quotas are six upload grants per day, six submissions per day and 60 status requests per minute, with a per-recording lock/idempotency check. A fresh upload authorization also consumes quota, so clients should reuse an existing pending job instead of repeatedly requesting new uploads.

Temporary Blob media and the provider transcript are deleted when processing completes, errors, or is cancelled. Normalized results remain available in Redis for the job's lifetime. AssemblyAI's own raw media handling/retention is governed by its service policy; deleting the transcript is not a promise that every provider backup disappears immediately.

Jobs expire after 24 hours. The configured cleanup job runs daily at **03:00 UTC**, handling at most 50 eligible jobs per invocation. An abandoned upload can therefore remain for approximately 48 hours before its next eligible sweep, and longer if a cleanup attempt fails or cannot finish its bounded batch. Redis cleanup metadata survives for seven days to support retries. The schedule is not an unconditional deletion-time guarantee: keep cron enabled, set its secret, and monitor failures and backlog. Increase cleanup frequency/capacity before a sustained orphan rate approaches that daily batch limit.

Local original recordings remain in the browser's recording store. Transcription introduces temporary cloud media and account-bound job results; it does not make the complete local project catalogue cloud-synchronized.

## Vercel routing and headers

The configuration retains `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for local FFmpeg export. HTML uses `no-cache`; API responses use `no-store`. Real files and Functions resolve before SPA rewrites. Known application/authentication paths fall back to `index.html`; missing API endpoints and missing assets retain a 404 instead of receiving HTML.

Clerk's production domains and assets must work under those final headers. Test redirect-based login and project/recording direct links on the deployed domain. Private Blob uploads and signed provider reads also need deployment-level verification; a static Vite preview alone does not execute the API.

## Why use hosted inference first?

Vercel now supports optional 5 GB Function bundles and extended Pro/Enterprise execution up to 30 minutes; the older universal 250 MB argument is no longer accurate. However, standard CPU/memory allocations and model warmup still make hosted inference the easier first deployment. This implementation needs no self-managed GPU worker or browser model download. [Current Function limits](https://vercel.com/docs/functions/limitations), [large Function beta](https://vercel.com/changelog/vercel-functions-can-now-be-up-to-5-gb-in-package-size), [extended duration](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes)

Universal-2 supports 99 languages including Portuguese and produces actual word timestamps through the asynchronous transcript API. Keep Portuguese/English proper names, code switching, silence and noisy recordings in the live acceptance set. Model choice should follow those recordings rather than a generic accuracy claim. [AssemblyAI model selection](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model), [supported languages](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages), [transcript API](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit)

For alternative providers and the current platform changes, see [the research addendum](VERCEL_TRANSCRIPTION_RESEARCH.md). The provider key, Redis, private Blob store and application-origin configuration must be supplied before this feature can run live.
