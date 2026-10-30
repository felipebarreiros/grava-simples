# OBS browser port experiment — 2026-10-30

The running prototype uses a **scoped OBS source subset compiled to WebAssembly**.
It does **not** run libobs, OBS sources/scenes, OBS encoders, or the OBS mixer.
The browser capture, canvas compositor, Web Audio routing, and MediaRecorder
are replacements. The manifest in `capabilities.json` is served with the binary.

## What is running

`scripts/build-obs-wasm.sh` compiles unmodified OBS `matrix4.c`, `vec3.c`,
`vec4.c`, `quat.c`, and `axisang.c` with SIMDe and Emscripten 4.0.18. The
adapter uses OBS's scale/translate/matrix multiply/vector transform to produce
the rectangles used by the actual compositor for both outputs every frame.
Layout policy and crop selection are new adapter code, rather than the full
OBS scene algorithm.

The audio path runs the actual `gain_coefficient`, `analyze_envelope`, and
`process_compression` function bodies from OBS's `compressor-filter.c`, unchanged.
An AudioWorklet copies stream samples through that Wasm DSP, using linked stereo
compression at 4:1, -18 dB threshold, 6 ms attack, 100 ms release, 0 dB gain.
Native sidechain, settings, source registration, and buffer allocation are omitted;
bounded realtime buffers and JS entry points are adapter code. OBS `audio-math.h`
performs the gain conversion. This is a DSP extraction, not an instantiated OBS
filter or a port of the OBS audio graph.

The binary has no imports and exports `obs_layout`, `obs_audio_gain_db`,
`obs_audio_buffer`, `obs_compressor_config`, and `obs_compressor_process` plus
memory/initialization. SIMD-capable WebAssembly and AudioWorklet are required.
There is no silent JS geometry or DSP fallback.

## Genuine full-core boundary attempted

Pinned upstream: OBS 33.0.1, `65c320b46e1af5c7a555161aea6182cdf7a8c524`.
The complete upstream checkout and submodules were used under `.context/research`.
Run `bash scripts/build-obs-wasm.probe.sh` to reproduce the probes. Logs are in
`engine/build-logs/`.

1. Installed Emscripten 4.0.18, CMake 3.31.6, and Ninja 1.11.1.3 locally.
   The host initially had none. Emsdk is pinned to its 4.0.18 tag so it can run
   on the provided Python 3.9 host. This was setup work, not a port blocker.
2. Invoked the real upstream CMake project with Emscripten, Qt frontend,
   scripting, browser, websocket, HEVC, VLC, PulseAudio, and Wayland disabled.
   It selected upstream Linux configuration from the **host** OS. The first
   substantive missing prerequisite was KDE ECM. Built/installed actual ECM
   6.8.0 CMake modules and supplied actual SIMDe 0.8.2 to advance the attempt.
3. The upstream configure then found SIMDe and Threads. It stopped requiring
   **Wasm builds of FFmpeg >= 8.0 avformat/avutil/swscale/swresample**. Host FFmpeg
   binaries would not satisfy this cross-compilation. FFmpeg was not built in
   this bounded experiment. This is an unresolved dependency/setup step, **not
   evidence that libobs cannot run in a browser**. Jansson, zlib, caption,
   and other actual runtime dependencies would also need compatible builds.
4. Independently compiled the **unmodified `libobs/obs-scene.c` successfully**
   into a Wasm object using real OBS headers, actual uthash 2.3.0, libcaption
   headers, and `obsconfig.h` generated from the upstream template. This is
   affirmative evidence that the scene translation unit itself is portable.
5. Attempted to link that object with actual scene API exports. Linking correctly
   reported unresolved real runtime symbols such as `obs`,
   `obs_source_create_canvas`, canvas lifetime APIs, source dimensions,
   graphics, properties/data, signal, and allocator functions. No fake
   implementations or imports were supplied. An isolated object is not libobs.
6. Independently compiled the real native OpenGL and capture translation units.
   `gl-x11-egl.c` stops at `X11/Xlib-xcb.h`; `xshm-input.c` stops at `xcb/randr.h`.
   These header errors are dependency observations, not impossibility proofs.

## Remaining browser adapters, identified from actual code

| Boundary | Actual upstream dependency | Work remaining |
| --- | --- | --- |
| Platform selection | `cmake/common/osconfig.cmake` uses CMAKE_HOST_SYSTEM_NAME and selects Linux | Add an explicit Emscripten target configuration; avoid accidentally inheriting native X11 requirements. |
| Window/graphics integration | `libobs-opengl/gl-x11-egl.c` calls XOpenDisplay; native GL loader/backend is built as a shared library | Browser canvas/context backend, WebGL-compatible effect compilation, texture upload/readback, and graphics lifecycle. |
| Desktop GL operations | `gl-stagesurf.c` uses glGetTexImage; `gl-helpers.c` uses glMapBufferRange | Audit/reimplement readback and buffer staging with WebGL APIs; not demonstrated by the current Canvas host. |
| Capture | `plugins/linux-capture/xshm-input.c` uses xcb_connect; xhelpers.c uses shmget/shmat | Feed MediaDevices frames into an actual asynchronous OBS source; browser permission/device lifecycle integration. |
| Runtime | Source/canvas lifecycle and obs singleton unresolved at scene link | Build/link/init the actual core and callbacks, audio/video thread scheduling, module loading, and source registration. |
| Encoding/output | libobs links FFmpeg; native encoders/muxers/output plugins are separate | Cross-compile needed FFmpeg paths or implement actual OBS encoder/output adapters to WebCodecs, plus muxing. MediaRecorder here bypasses those APIs. |
| Audio | Native mixer/resampling/source callbacks/monitoring | Full browser audio ingress/egress bridge and realtime scheduling; present compressor extraction covers only DSP. |
| Shared libraries/threads | libobs and graphics are SHARED; core uses native threading and dynamic loading | Decide static linkage/side modules and worker model, determine isolation headers and supported synchronization. Not exercised by the single-thread subset. |

No measured full-core performance bottleneck has been established. Browser host
replacements are a prototype scope decision because these integrations remain
unimplemented, not a demonstrated proof that reuse would be too slow. Further
work should begin by building real Wasm FFmpeg prerequisites, adding an explicit
Emscripten platform layer, and preserving source/scene lifecycle before claiming
that libobs is the running engine.

## Reproduction and source delivery

`bash scripts/build-obs-wasm.sh` rebuilds the shipped subset from distributed
source. An external `EMCC` must be version 4.0.18; otherwise the script bootstraps
the pinned SDK under `.context/toolchains/emsdk`. On Linux the SDK's Binaryen
requires the host `libatomic.so.1`. This sandbox lacked it; a local copy from
Debian package `libatomic1_12.2.0-14+deb12u1_amd64.deb` was extracted under
`.context/toolchains/libatomic`, and the script adds that local path when present.
The script bootstraps this hash-checked local runtime automatically if needed
on Linux x86_64. Other hosts should install their normal libatomic package.

`vendor/obs/NOTICE.md` records origin, licenses, modification dates and the DSP
extraction. The exact compiled sources, adapter, host/worklet, third-party
headers, build script and license are packaged at `/source/obs-wasm-source.tar.gz`.
The full combined application's source archive is delivered separately by the
application build. No proprietary/native server component is required.
