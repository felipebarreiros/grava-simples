# Initial recording experiment

The user first narrowed implementation to proving two local recordings with a minimal interface. After confirming the recordings worked, they requested the full-window dark studio described in [STUDIO_UI.md](STUDIO_UI.md). OBS Blade compatibility, AirPlay drawing and Parakeet transcription remain deferred.

## Implemented path

Camera/microphone, optionally a shared screen, or generated test inputs → two independently framed canvas outputs → simultaneous recording → incremental local browser staging → playback and separate file downloads.

Actual OBS matrix/vector source compiled to Wasm determines the drawn geometry. Actual OBS compressor DSP runs in a Wasm AudioWorklet on the shared audio path. This preserves selected OBS processing; it does **not** run the libobs source/scene/mixer runtime. The host scene policy, Canvas compositor, capture and encoders are browser replacements. [The full-core probe](../engine/PORT_STATUS.md) records what was attempted and what remains.

The current interface offers three scene presets, source visibility, real microphone controls and device/output settings. Technical diagnostics are tucked into settings. Simple and advanced controls share state as functionality is ported. No complete desktop plugin compatibility is claimed.

## Recorded-video freeze report and fix

The user observed a moving live preview and a frozen recorded image, with audio continuing, while the studio tab stayed visible. Independent output decoding reproduced that failure at 1080p: WebM VP8/VP9 paths delivered far fewer video frames than the preview, sometimes ending video several seconds before audio. This is a recording failure, not a successful 1080p30 qualification.

The corrected adapter uses automatic `canvas.captureStream(fps)` and prioritizes browser-supported H.264/Opus MP4 encoding, with resolution-aware profile levels and actual encoder MIME reporting. Merely replacing manual frame requests did not fix the original WebM encoder throughput problem. The H.264 candidate was independently decoded with moving content through the end, bounded frame gaps and aligned audio/video. Regression tests check per-second motion, final-five-second activity, packet timestamps and trailing gaps; average FPS or a playable first frame alone is insufficient.

Output dimensions/rate remain configurable. Selecting 4K or 60 fps is a request to validate, not evidence of sustained support. A one-hour simultaneous 1080p30 run is the agreed baseline; higher modes through dual 4K60 are hardware-qualified targets rather than mandatory P0 gates. Short functional success and a freeze fix do not themselves qualify those modes.

## Validation layers

- Actual Wasm fixture tests check exports, scene geometry, dB conversion and compressor behavior against independent expected values.
- Browser tests exercise generated inputs and fake-device `getUserMedia` capture through the real production graph. They download both files and independently inspect/decode them with FFmpeg/FFprobe, including active audio and content motion throughout the recording.
- Performance tests report real encoded frame cadence, gaps, A/V timing, queues and memory. FPS qualification remains separate from freeze regression. VM results do not qualify physical Mac/Windows capture or hardware encoding.
- Failed start, encoder construction, capture interruption and storage errors are exercised. Files are finalized where possible, capture resources are released, late encoder callbacks are isolated, and quota errors stop both paths with an explicit error.

Source and test-result references are in [README.md](../README.md) and [tests/README.md](../tests/README.md). Detailed raw browser/media artifacts remain under `.context/results/` and screenshots under `.context/screenshots/`.
