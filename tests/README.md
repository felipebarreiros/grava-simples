These tests run the real UI in installed Google Chrome and save both actual downloads. Independent FFprobe/FFmpeg analysis checks A/V streams, dimensions, decode timestamps, decoded frame counts, complete-file decoding, audible audio and continuous motion. It checks every complete second, the largest decoded-frame gap including the trailing audio interval, and movement/decoded frames in the final five seconds. Both result players must also present a decoded frame in Chrome.

Browser checks verify the delivered Wasm binary and exports, deterministic layout vectors, per-frame Wasm calls, actual compressor worklet processing, source archive MIME/headers/gzip bytes, and GPL/MIT notice downloads. The Node suite runs serially to keep browser timing checks isolated. It includes six Wasm/DSP fixtures, local AAC export, the shared compositor/countdown/aspect-ratio/performance checks, and three real video fixtures: healthy motion, valid 30 fps video with a frozen tail, and video ending while audio continues.

Install the independent tools outside the app dependency tree:

```
npm install --prefix .context/tools --no-audit --no-fund ffmpeg-static@5.2.0 ffprobe-static@3.1.0
```

System `ffmpeg` and `ffprobe` are preferred when available; otherwise the verifier uses those local binaries. `FFMPEG` and `FFPROBE` override discovery. Run `npm test` for the Wasm/DSP, decoder and local AAC-export fixtures.

Run the deterministic application suite against the Vite development server:

```
npm run dev
TEST_BASE_URL=http://127.0.0.1:5173 npx playwright test
```

The authentication and studio specs replace the Clerk SDK dependency **inside the Playwright browser** with `tests/fixtures/clerk.tsx`. Studio regressions receive a signed-in test session; authentication specs also exercise signed-out, loading, recovery and logout states. The fixture models Clerk's navigation-commit promise before publishing an active session, including recovery navigation after its page unmounts. The real application routes, lazy studio import and media engine still run. The fixture refuses a production bundle, never contacts Clerk, and creates no Clerk users. Application code has no test authentication bypass: `?test=1` only selects diagnostic media controls and still requires authentication.

These tests verify the application's handling of Clerk state. They do not qualify Clerk-hosted login, OAuth, email delivery, or real session issuance. Verify those separately against the development Clerk instance using an existing authorized test account and [Clerk's Playwright helpers](https://clerk.com/docs/guides/development/testing/playwright/overview). Keep secret keys and persisted authenticated browser state private. A frozen production build requires a real authenticated browser session; the mocked suite deliberately fails with an explanatory error when pointed at a production preview.

The live integration suite uses the installed Clerk SDK and real development-instance sessions. Supply an authorized, temporary test user whose email contains `+clerk_test`, a Clerk testing token, and the instance's public frontend API hostname in a private JSON file:

```json
{"email":"user+clerk_test@example.com","password":"a-private-test-password","testingToken":"a-private-development-testing-token","frontendApiUrl":"your-instance.clerk.accounts.dev"}
```

Create and delete that temporary user outside the test runner. The suite never creates users; it revokes each session during teardown. Keep the fixture out of source control and source archives, and remove it after testing. Environment variables `CLERK_TEST_EMAIL`, `CLERK_TEST_PASSWORD`, `CLERK_TESTING_TOKEN` and `CLERK_FAPI` can supply the same values without a fixture file.

Run against a frozen production build on HTTPS or localhost. Keep its output
directory unchanged until the suite finishes; concurrent rebuilds remove old
content-hashed chunks. For example, use a dedicated build and preview port:

```sh
npx tsc --noEmit
npx vite build --outDir .context/auth-tests-dist
npx vite preview --outDir .context/auth-tests-dist --host 127.0.0.1 --port 5193
```

In a second terminal, run the suite with private development credentials:

```sh
CLERK_TEST_CREDENTIALS_PATH=/private/path/test-user.json CLERK_TEST_BASE_URL=http://127.0.0.1:5193 npm run test:auth:live
```

`auth-live.spec.ts` exercises the actual email/password UI from a fresh browser context, optional development email verification, immediate protected deep-link restoration without a manual refresh, clean post-login URLs, logout, and the real account menu/profile/security controls. It opens name and password editing panels and cancels without saving. It checks rendered text and placeholder contrast at rest, on hover and with keyboard focus, including enabled primary actions. Entry-handshake cases use synthetic fixture values; real session transport credentials are never copied into test source. Separate production cases intercept only the studio chunk download: a temporary failure recovers automatically with the project fragment intact, while a permanent failure stops after one retry and shows a recovery action. Its session helper uses Clerk's supported `@clerk/testing` package, never an SDK replacement. The live suite skips in ordinary runs without explicit credentials. It disables traces, videos and automatic screenshots because Clerk transport URLs can contain session credentials; assertions expose transport parameter names without their values. The JSON report and contrast attachments are under `.context/results/auth-live-*`.

`auth-navigation.test.mjs` checks browser versus SPA navigation, push/replace semantics, fresh Clerk transport handling and safe application return destinations with synthetic fixtures. The mocked loading regression simulates Clerk removing transport through native `history.replaceState` before its hooks resolve, ensuring React Router's stale location cannot leak transport into a login return URL.

Avoid editing source files while timed recordings run: Vite hot reload can interrupt a recording.

The default browser suite records four sessions: 12 seconds at 640×360 / 360×640 with generated inputs; 20 seconds at 1920×1080 / 1080×1920 with generated inputs; 20 seconds at 1080p through camera/microphone adapters; and 8 seconds through those adapters at 360p. The 360p generated recording switches through camera, camera zoom and screen scenes during capture. Camera tests use Chrome fake devices and permissions to exercise `getUserMedia`; they do not qualify physical hardware. The two1080p motion regressions load the ordinary application URL and use its actual default encoder selection.

The studio UI checks use generated sources at 360p and exercise project persistence, media import, adjustable zoom, perspective composition and a clean customer path. They capture 1440×900, 1280×720, 2560×1440 and 768×900 layouts, check desktop page overflow, compare actual canvas pixels for camera zoom and source visibility in both formats, and inspect the real post-gain audio meter while muting and changing gain. Keyboard checks cover all four scene shortcuts, dialog focus containment, Escape and focus restoration. Run these separately with `npx playwright test tests/studio-ui.spec.ts`.

Run only the two 1080p freeze regressions:

```
TEST_BASE_URL=http://127.0.0.1:5173 npx playwright test -g '1080p motion regression'
```

Set `RECORDING_REGRESSION_SECONDS=90` to extend either motion regression. For example:

```
TEST_BASE_URL=http://127.0.0.1:5173 RECORDING_REGRESSION_SECONDS=90 npx playwright test -g '1080p motion regression: synthetic'
```

Continuous-motion checks do not claim 30 fps qualification. Encoded FPS remains visible in all reports. The separate performance test enforces at least 24 fps for a requested 30 fps, plus the same motion and A/V checks; that threshold has not been lowered. Enable it explicitly:

```
TEST_BASE_URL=http://127.0.0.1:5173 RUN_PERFORMANCE_QUALIFICATION=1 npx playwright test -g 'performance qualification'
```

Set `RECORDING_SOAK_SECONDS=3600` with that performance test for the one-hour baseline. Set `RUN_4K_PROBE=1` to enable the additional short 4K60 qualification probe. The 360p checks retain their previous minimum FPS criteria; the fake camera adapter case requires 10 fps because fake devices can have their own rate limit. A failed short prerequisite does not establish a successful one-hour baseline.

Reports/recordings are in `.context/results`; screenshots are in `.context/screenshots`. `RECORDING_RUN_NAME` labels artifact directories. To independently recheck saved files: `node scripts/verify-recordings.mjs --manifest .context/results/360/manifest.json --json .context/results/360/verification.json`. `CHROME_DISABLE_GPU=1` supports software-rendering diagnostics. Timed checks disable tracing to avoid screenshot overhead; opt in with `RECORDING_TRACE=1` for debugging.

Results describe a Linux VM and headless browser. Physical workstation capture, hardware encoding, sustained 1080p30 and 4K60 require their own qualification.

Recording review checks: `npx playwright test tests/recording-detail.spec.ts tests/recording-thumbnails.spec.ts`. They verify actual frame pixels at 5%, persisted covers, caption import/search/correction/export, synchronized orientation switching, markers, detail reload and browser history, original downloads, deletion cleanup, and mobile overflow. Detail tests generate a small local H.264/AAC fixture with the same FFmpeg tool above; its subtitles are explicitly imported test data. `node --test tests/transcript.test.mjs` checks parsing, invalid timestamps, real timing preservation, storage failures, and caption round trips. None of these tests establish automatic speech recognition or rendered video-cut support.

Cloud transcription: `npm run test:transcription` runs API/domain, actual signed Clerk JWT verification, shared quota, client transport and persistence checks. `npx playwright test tests/cloud-transcription.spec.ts tests/recording-detail.spec.ts tests/global-search.spec.ts` exercises the authenticated upload/job UI with explicitly mocked cloud transports. Generation and replacement continue across navigation/reload, corrections survive a completed job reread, and cancellation invalidates late responses. Private production uploads, provider billing/accuracy and deployed cron operation require a configured Vercel smoke test; see [setup](../docs/VERCEL_TRANSCRIPTION.md). The default auth fixture supplies an unavailable transcription API so ordinary browser tests never trigger paid inference.

Project persistence tests use real OPFS and the IndexedDB fallback and verify isolation, legacy migration and reopening recording blobs. `tests/compatible-download.spec.ts` validates the actual primary download for both formats against H.264/AAC, moving/audible decode and ordinary MP4 metadata. The default download processes locally; the original test recording remains available through Outras opções.


The project-model tests import development modules and run separately against the development server:

```sh
TEST_BASE_URL=http://127.0.0.1:5173 npx playwright test tests/projects.spec.ts
```

The 0.3 studio polish checks exercise permission-aware camera restoration without unsolicited prompts, per-scene layers/framing/order, countdown title/background/timer persistence, sampled live thumbnails, real project covers, sidebar collapse and context actions. Default camera permission absence and already-granted camera/microphone combinations are separate cases. The shared compositor fixture also starts Chrome without an autoplay override and uses a CDP evaluation with userGesture:false to verify preview initialization independently of browser test activation.

The compositor timing fixture compares the old live perspective strips against the current cached-frame/blit path using the same CPU-backed canvases and forced readback. It checks the 33.3 ms composition budget for dual1080p, but that excludes the full capture/encoding/storage workload and does not qualify sustained1080p30. Run performance checks without other browser/capture workloads competing for CPU. Node tests use `--test-concurrency=1` for that reason.


The 0.4 editor replaces sampled live scene thumbnails with static SVG diagrams. The old adaptive-thumbnail slowdown test was removed because thumbnails no longer have a render loop to pause. The current static-diagram check instead verifies unchanged SVG markup and zero thumbnail canvas draws while the main preview remains active; paired recording and independent decoder checks continue to enforce the media path.
