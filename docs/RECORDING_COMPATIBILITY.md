# Local download compatibility

The original recorder preferred H.264 video with Opus audio in an MP4 container. That plays in the browser but the audio codec is an avoidable source of WhatsApp rejection. WhatsApp's documented video combination is H.264 + AAC, with one audio stream or no audio. A `.mp4` filename alone does not establish compatibility.

The recorder now prefers explicit H.264/AAC MediaRecorder types, retaining the existing H.264/Opus fallback where a browser cannot encode AAC. Chrome 156 on this Linux VM supports H.264/Opus recording but reports AAC unsupported in both MediaRecorder and WebCodecs AudioEncoder. This is a runtime capability decision, not a platform-name assumption.

The main **Baixar vídeo** action calls `prepareCompatibleDownload` after capture has ended. A self-hosted, optional worker:

1. Copies the H.264 video stream without recompressing or changing the picture.
2. Decodes audio and produces a single AAC-LC at 48 kHz stereo stream.
3. Writes ordinary MP4 with its `moov` metadata before `mdat` (faststart), rather than passing the browser's fragmented MP4 directly through.
4. Releases worker memory after producing the download. Files remain in the browser; no recording is uploaded.

The worker is a minimal 1.6 MB FFmpeg 5.1.4 build containing the internal AAC encoder and AAC/Opus decoders. It has no external video encoder libraries. It is loaded on demand, so it does not add recording CPU load. Its corresponding source, binding modifications, and build script are served at `/source/ffmpeg-export-source.tar.gz`, with licenses and provenance in `/export/`. Rebuild using `npm run build:export` after installing Emscripten 4.0.18, GNU make, and Node.

Exports currently accept MP4 inputs up to 256 MB each with a five-minute conversion timeout. They do not transcode WebM video to H.264, resize large videos, or impose WhatsApp Business API limits on consumer clients. Errors preserve the original download in **Outras opções**. WhatsApp client/platform acceptance still needs a physical client check; codec/container verification is covered automatically.

`tests/compatible-export.test.mjs` starts an isolated browser, supplies a fragmented H.264/Opus recording, exercises the actual helper and self-hosted worker, and independently checks AAC-LC, decoded motion/audio, ordinary MP4 metadata order, and unchanged compressed video SHA256. It also verifies AAC preference with feature-detection stubs, including 4K60 profile selection. `tests/compatible-download.spec.ts` exercises both customer download buttons against the running product and verifies the actual dual recordings after scene switches.

References:

- [Meta WhatsApp media reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media/) — primary video codec/container guidance (rate-limited from this VM when researched).
- [Vonage WhatsApp video API documentation](https://developer.vonage.com/en/messages/code-snippets/whatsapp/send-video) — provider documentation explicitly confirms H.264/AAC support.
- [Chromium media muxer source documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/media/muxers/README.md) — MP4 can contain both Opus and AAC; container support does not imply destination compatibility.
- [ffmpeg.wasm architecture](https://ffmpegwasm.netlify.app/docs/overview/) and [licensing FAQ](https://ffmpegwasm.netlify.app/docs/faq/) — local worker execution and minimal custom core support.
