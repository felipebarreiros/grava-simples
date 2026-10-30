# Vercel transcription options — 2026-10-30

## Recommended first deployment

Use short Vercel Node Functions for authentication, upload authorization, submission and polling. Let a hosted speech provider own inference. For ordinary long recordings, AssemblyAI's asynchronous API is the simplest durable path: submit a private media URL, receive a job ID, and poll later. This is an engineering recommendation, not a measured quality or latency claim.

Upload one output directly from the browser to private Blob storage. Give the provider temporary read access to that exact object. Keep provider credentials, ownership checks and distributed rate limits in the Vercel API. This avoids downloading a model onto the customer's device or keeping a Vercel invocation alive while a provider job runs.

## Current Vercel limits

Functions still have a 4.5 MB request/response payload limit. Standard memory/CPU is 2 GB/1 vCPU; Pro/Enterprise can use 4 GB/2 vCPU. Hobby Fluid invocations have a 300-second maximum. [Function limits](https://vercel.com/docs/functions/limitations)

Older claims that a 250 MB bundle universally rules out large models are stale. Since June 2026, the large-functions beta supports bundles up to 5 GB; existing projects can opt in with `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`. Pro/Enterprise also have an extended-duration beta up to 1,800 seconds with Fluid Compute. These allowances do not demonstrate that a particular ASR model has acceptable CPU performance or memory use. [Large functions](https://vercel.com/changelog/vercel-functions-can-now-be-up-to-5-gb-in-package-size), [extended duration](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes)

Private Blob became generally available with signed URLs in June 2026. Narrow, expiring GET access can let a provider read one private object without putting the app Function in the media data path. Check the installed SDK's actual exports when selecting its API. Browser multipart uploads are the appropriate path for media exceeding Function payload limits. [Private Blob GA](https://vercel.com/changelog/vercel-private-blob-is-now-generally-available), [client uploads](https://vercel.com/docs/vercel-blob/client-upload)

`waitUntil()` extends an invocation's lifecycle; it is not a durable queue and does not escape `maxDuration`. An asynchronous provider job avoids requiring it merely to wait for transcription. [Functions helper API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)

## Provider tradeoffs

| Provider | Relevant capabilities | Practical implication |
| --- | --- | --- |
| AssemblyAI | Asynchronous submission and status API; true word start/end times; sentence and subtitle endpoints. Universal-2 supports 99 languages including Portuguese; current Universal-3.5 Pro explicitly supports Brazilian Portuguese. | Best fit for long recordings and reload-safe jobs with simple Vercel orchestration. Pin the chosen model instead of relying on an evolving default. |
| Groq Whisper | `whisper-large-v3-turbo`, multilingual input, real word/segment timestamps via `verbose_json`, remote URL or media file input. Current limits: 25 MB free, 100 MB developer tier. Listed Turbo inference price: $0.04 per audio hour. | Very inexpensive bounded-file alternative, but longer videos need audio extraction/chunking and the endpoint is synchronous. Storage, transfer and Vercel costs are additional. |
| Deepgram Nova-3 | Portuguese, remote media URL, word timings, asynchronous callback delivery. | Strong option, but callback authentication and durable result storage add setup compared with provider status polling. |
| OpenAI | The current transcription guide recommends `gpt-transcribe`; legacy `whisper-1` word-timestamp examples remain documented, with that API model scheduled to shut down February 26, 2027. Files have a 25 MB limit. | Avoid choosing the deprecated OpenAI endpoint as the foundation of a new word-editing workflow. Groq's hosted Whisper service is separate from this API lifecycle. |

Sources: [AssemblyAI submission](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit), [model selection](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model), [languages](https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages), [word timings](https://support.assemblyai.com/articles/6819078983-does-your-api-return-timestamps-for-individual-words), [Groq speech](https://console.groq.com/docs/speech-to-text), [Deepgram models](https://developers.deepgram.com/docs/models-languages-overview), [callbacks](https://developers.deepgram.com/docs/callback/), [OpenAI transcription](https://developers.openai.com/api/docs/guides/speech-to-text).

## Minimal application contract

1. Authenticate the Clerk session before minting an upload token. Bind its path and maximum byte count to that user and a server-generated upload/job identifier.
2. Upload directly to private object storage. Submit a reference to the app API; do not accept arbitrary external URLs.
3. Verify uploaded-object ownership and size. Enforce per-user request, concurrent-job and daily-usage limits atomically in shared storage; an in-memory counter cannot enforce them across serverless instances. Cap provider processing duration server-side rather than trusting the browser's duration field.
4. Submit the provider job and store an ownership mapping. A client's knowledge of a provider job ID must not grant access to it. Return the app job ID immediately.
5. Poll through an authenticated, rate-limited app endpoint. Normalize real provider word times and derive display cues. Preserve model/provenance and empty-speech results.
6. Delete temporary media and provider records according to an explicit retention policy. Include incomplete-upload cleanup; successful-client polling alone is insufficient because tabs can close.

The current app's browser take IDs and browser persistence do not establish server-side account ownership. This contract deliberately introduces that boundary without requiring cloud synchronization for all recordings.
