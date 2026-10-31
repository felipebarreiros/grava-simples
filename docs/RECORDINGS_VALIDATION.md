# Recording review validation — 2026-10-30

The production build and TypeScript check pass. Chrome development-server checks use the repository's deterministic Clerk fixture, not a production authentication bypass.

Twenty browser checks passed across `recording-detail.spec.ts`, `recording-thumbnails.spec.ts`, `global-search.spec.ts`, and `projects.spec.ts`. They cover real 5% frame pixels, corrupt-thumbnail fallback, storage isolation, reload and browser history, imported caption timing/search/corrections/export, orientation playback, original and compatible downloads, markers, deletion cleanup, and mobile overflow. Direct-link review also works with capture permissions unavailable and the capture Wasm request failing. Missing local media returns to the library. The screenshot videos and captions are test fixtures; no speech recognition was run.

All six transcript unit tests pass. The broader Node run passed 32 of 34 checks; its layer-rendering/frame-rate check passed when rerun alone. The existing compositor benchmark still failed an isolated run: the measured perspective path took 45.71 ms against 39.60 ms for its comparison path. This is not a qualified 30 fps capture environment.

The real 360p recording smoke test generated independently playable landscape and portrait MP4 files with audible Opus audio and continuing visual motion. Its verification still failed: measured rates were 6.64 and 6.44 fps against the required 24 fps, with maximum video gaps of 0.575 and 0.766 seconds. Thresholds were preserved. Reports are in `.context/results/360/verification.json`; this run does not establish capture performance or successful one-hour recording. A test-helper race that could leave Preferences open after selecting an unchanged value was corrected by waiting for the select menu to dismiss.

Automatic Parakeet inference, diarization, word alignment, rendered media cuts, production cloud jobs, and physical-device compatibility were not implemented or qualified by these checks. See [the research and delivery plan](RECORDINGS_RESEARCH.md).

## Vercel transcription implementation

The subsequent Vercel integration adds a Clerk-authenticated API, owner-bound private Blob upload grants, shared Postgres quotas, asynchronous AssemblyAI jobs and actual provider word timestamps. Focused server tests use both real locally signed JWTs and injected provider/storage dependencies. Browser fixtures exercise automatic generation, cancellation, quota errors, navigation/reload, approved transcript replacement and word seeking. They simulate provider output and do not establish live ASR quality or paid service configuration. See [deployment setup](VERCEL_TRANSCRIPTION.md) and run `npm run test:transcription` for current focused coverage. Rendered media cuts remain outside this implementation; capture/compositor performance findings above are unchanged.
