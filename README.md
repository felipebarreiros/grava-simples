# GravaSimples studio

A browser recording studio producing landscape and portrait video files from the same session, saved locally first with optional private cloud backup. The Hotmart/Launchpad-inspired interface fills the window with warm dark surfaces, orange actions, projects, linked previews, and scene controls. A public home page introduces the product; Clerk authentication is required to open the studio. Automatic transcription uses an optional authenticated Vercel API. OBS Blade phone control connects over local Wi-Fi through the installed Mac/Windows companion; AirPlay and rendered video cuts remain deferred.

## OBS Blade phone control

Install the local companion once on Mac or Windows and allow the browser to connect to this computer. Opening the studio then attaches automatically. Configure the existing OBS Blade app with the computer’s Wi-Fi IP, port and persistent password under **Celular**. Control scenes, individual layer visibility, microphone mute, and start/stop of both recordings. No remote-control Vercel API, Redis, extension or cloud relay is used. Prepare camera/screen permissions on the computer first. The computer keeps recording if the phone disconnects. See [installation, pairing and validation](docs/OBS_BLADE.md).

## Recording review

The **Gravações** library shows a still from 5% of each saved video, with a first-frame fallback. Opening a take leads to a recording page: timed transcript on the left, video on the right. Horizontal and vertical playback share the playhead, speed and transcript. The page supports seeking, playback speed, fullscreen, timestamped notes, renaming, and local downloads. A recording URL reopens the take after a reload; an account's finalized cloud library is also available on another device.

Import an SRT or WebVTT file (up to 5 MB) to search speech, click a passage to seek, follow the active passage, correct its text, and download TXT/SRT/VTT. Imported cue timing is preserved; text corrections affect captions, while video downloads retain the original recording. Transcripts, corrections and markers save in the account's browser workspace. Cloud-backed takes can additionally save versioned transcript snapshots; markers remain local. Importing subtitles does not upload media or download a speech model.

When the cloud service is configured, **Gerar transcrição** uploads one format to private Vercel Blob and starts an AssemblyAI Universal-2 job through Clerk-authenticated Vercel Functions. The page follows the job across navigation/reload and saves its real word timestamps for click-to-seek playback. Corrections remain separate from source word alignment. The API uses Supabase Postgres for forced row-level security, atomic rate limits, owner-scoped job state and cleanup, with a two-hour/512 MB input policy. Imported subtitles remain available independently.

See [Vercel deployment and transcription setup](docs/VERCEL_TRANSCRIPTION.md) for the temporary private Blob store, restricted Postgres connections, provider key and server-only environment variables. No speech model runs in the browser or is bundled with the Functions. Reversible word cuts with rendered video export remain the next editing phase. The [product and architecture research](docs/RECORDINGS_RESEARCH.md) includes Riverside references and creator priorities; the [Vercel research addendum](docs/VERCEL_TRANSCRIPTION_RESEARCH.md) explains the hosted-model choice.

## Scene editor · 0.4.0

The Portuguese workspace keeps project navigation, two output previews, a scene strip, and a scene-aware inspector. Standard controls share shadcn/ui-derived component structure, Radix behavior and charcoal/orange CSS tokens; dnd-kit supplies accessible pointer/keyboard layer ordering. See [the style guide](docs/STYLE_GUIDE.md) and [component provenance](vendor/ui/README.md).

- Scene-specific microphone mute, gain and microphone choices. Switching scenes restores their audio settings. Camera identities and physical device choices belong to reusable project sources. Changing physical devices during a take is blocked with an explanation; configure the devices before recording.
- Multiple camera, screen/media, text, timer and background layers. Each layer has its own visibility, paint order, text/style and normalized position/size for **horizontal** and **vertical** output. Drag/resize in the real output preview or edit values in the inspector. Camera shapes, border color/thickness and shadows are layer properties.
- Reusable project sources: the standard camera scenes share one camera, and **Câmera + tela** and **Apresentação** share one screen input. Choose an existing entry under **Fontes do projeto** to reuse it without another browser chooser. Add another camera, screen/window or media file to create a distinct source; choosing a different source changes only the selected layer's binding. Reconnecting an offline source retains its identity and updates every scene using it. Uploaded images/videos persist locally; display sharing needs an explicit reconnect after reopening. Imported file videos remain visual-only/muted.
- A dedicated countdown design with cached artwork and responsive typography. It starts paused, accepts zero and clearable numeric drafts; **Reiniciar** restores the configured duration while paused; **Zerar** stops at zero. **Começar** is the explicit start action.
- Static SVG scene thumbnails combine the original orange recording mascot in a charcoal/orange studio, ivory editorial screen graphics and a matching countdown backdrop. They reflect layer visibility, order, frames, camera shapes/borders, zoom and text styling without live sampling, capture requests or a ticking thumbnail timer. The mascot artwork is limited to scene cards; live previews, recordings and real composed project covers keep their actual sources.
- A local, sustained pre-mute signal warning offers unmute/dismiss with a cooldown. This is an input-level heuristic, not speech recognition; the raw meter never bypasses mute into a recording.
- Sidebar width transitions preserve icon rhythm, collapsed hover/focus tooltips name the actions, and project three-dot/right-click actions remain available. The redundant storage caption is removed.

Project files and layers save in this browser. Images up to25MB and videos up to256MB can be stored as local layer assets. Recording and ordinary downloads process locally; requesting automatic transcription sends one saved format to the configured cloud service. The standard download stays H.264/AAC MP4, prepared locally; original files remain available. See [storage](docs/PROJECT_STORAGE.md), [layer contracts](docs/LAYER_COMPOSITOR.md), and [download compatibility](docs/RECORDING_COMPATIBILITY.md).

## Engine status

**This is a partial OBS port, not a running libobs engine.** The recorded video geometry uses actual OBS matrix/vector source compiled to WebAssembly. The audio path runs the extracted OBS compressor DSP in a Wasm AudioWorklet. Browser APIs provide capture, Canvas composition, audio routing, and MediaRecorder encoding/muxing. New host code implements scene appearance, layers, countdowns, and coordination of the two files.

The full Qt-free libobs build was attempted. After resolving ECM/SIMDe prerequisites, upstream configuration requires Wasm FFmpeg 8 libraries. Unmodified `obs-scene.c` compiled to a Wasm object, but the actual scene APIs still need the remaining source/canvas/graphics/runtime implementation. This documents outstanding integration work. See [engine/PORT_STATUS.md](engine/PORT_STATUS.md) for commands, results, and remaining adapters.

## Run

Node.js 24 is used in this workspace. Generated Wasm assets are included, so the compiler is not needed to run the app.

```sh
npm ci
cp .env.example .env.local
```

Set `VITE_CLERK_PUBLISHABLE_KEY` in `.env.local` to the publishable key from the selected Clerk application's API keys page. This React app uses only a publishable key; do not add a secret key to browser configuration. Alternatively, connect the existing application and pull the development environment with the CLI:

```sh
npx -y clerk@latest auth login
npx -y clerk@latest link --app app_3LQfZXySLRBTrfUH73j0rAU9Wgn
npx -y clerk@latest env pull
```

Then start the app:

```sh
npm run dev
```

Open `http://localhost:5173`, then create an account or sign in to enter your workspace. Camera and screen capture require HTTPS or localhost. The Conductor preview supplies HTTPS.

1. Create or open a project. Existing camera grants can restore the preview; otherwise use **Ativar câmera**.
2. Choose a scene and use **Camadas → +** to add visual elements or connect sources. Adjust that scene in the inspector.
3. Click **Gravar**, switch prepared scenes or adjust zoom during the take, then click **Parar**.
4. Play/download both formats. The project's **Gravações** tab reopens saved takes after a refresh.

The default profile is 1080p/30; 720p is available in preferences. H.264/AAC is preferred when supported; H.264/Opus remains the capture fallback on this Linux Chrome VM and is converted for the standard download. Automatic canvas capture preserves the prior video-freeze fix. The compositor caches decorative artwork and avoids repeated transformations of live screen pixels, but this does not qualify sustained 1080p30, one-hour recording, or 4K60. 4K and 60 fps remain experimental. See [test results](docs/TEST_RESULTS.md) for measured coverage and limits.

**Salvar na nuvem** backs up both original outputs to private Vercel Blob, with an account-owned Supabase Postgres catalogue. Automatic backup is opt-in for subsequent recordings. The recording cache targets 1 GB and removes only inactive local copies whose complete cloud backup and byte counts were freshly verified. Unbacked originals are preserved even above that target. Scene settings, uploaded scene assets and markers remain local; clearing site data removes local-only files. See [cloud storage, access controls and provisioning status](docs/CLOUD_STORAGE.md). Capture permissions, background execution, storage quota, and actual encoded cadence depend on the browser and machine.

## Authentication

| Route | Behavior |
| --- | --- |
| `/` | Public product home page. |
| `/login/*` | Clerk sign-in, verification, and social sign-in callbacks. |
| `/signup/*` | Clerk registration and verification. |
| `/password-recovery/*` | Email-code password recovery. |
| `/logout` | End the current Clerk session and return home. |
| `/app/*` | Recording studio; requires a loaded, authenticated session. Project links retain `#project/<id>`. |

Clerk Dashboard settings determine which sign-in methods and social providers are available. Email/password recovery requires email and password authentication to be enabled for that application. The studio is lazy-loaded after authentication; `?test=1` enables media diagnostics only and does not grant access.

Authentication protects studio entry and the APIs. Local catalogues, recordings, scene assets, transcripts and markers are separated by account. Old unscoped recordings require an explicit import and are not uploaded automatically. Cloud backup shares finalized recordings across devices for the same account; complete editable studio projects are not synchronized.

Production hosting must rewrite application routes to `index.html` while serving existing assets and source downloads normally. Set `VITE_CLERK_PUBLISHABLE_KEY` in the build environment before `npm run build`; Vite embeds public configuration at build time. Use the production publishable key for the production Clerk instance and configure that instance for the deployed domain. Preserve the cross-origin isolation headers required for local video export. See [authentication setup and deployment](docs/AUTHENTICATION.md).

## Build and validate

```sh
npm run build
npm run preview
npm test
npm run test:integration
```

Browser tests use installed Chrome (`CHROME_PATH` can override it), with FFmpeg/FFprobe checking decoded recording output. Product tests target the running app at `http://127.0.0.1:5173` or `TEST_BASE_URL`. The isolated project-store tests import source modules and require the Vite development server. See [tests/README.md](tests/README.md). Synthetic-browser and compositor benchmarks do not qualify physical Mac/Windows capture or hardware encoding.

To rebuild the actual OBS components:

```sh
npm run build:engine
```

The script pins Emscripten 4.0.18 and bootstraps it under `.context/toolchains` if needed. It compiles the distributed sources and repackages matching binary/source metadata. `scripts/build-obs-wasm.probe.sh` reproduces the separate full-core probes.

The production build serves the complete experiment source at `/source/grava-simples-source.tar.gz`, OBS component source at `/source/obs-wasm-source.tar.gz`, the minimal FFmpeg export core source at `/source/ffmpeg-export-source.tar.gz`, license text, and third-party notices under `/source/`. The app and OBS-derived components use GPL v2-or-later; original notices and dependency licenses are preserved. No OBS endorsement is implied.
