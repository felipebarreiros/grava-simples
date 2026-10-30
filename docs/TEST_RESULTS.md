# Recording experiment validation — 2026-10-30

## Recorded-video freeze

The original WebM recording path reproduced a moving preview with frozen/early-ending recorded video and continuing audio. VP8 examples contained only 17–33 decoded video frames over roughly 20 seconds and multi-second trailing video gaps. Automatic canvas capture alone did not resolve that encoder-path failure.

The corrected path prioritizes supported H.264/Opus MP4 encoding and uses automatic `captureStream(fps)`. Browser support is probed using resolution-aware levels; actual codec/container metadata is retained. Tests use the actual UI and production adapters without encoder overrides.

| Check | Result |
| --- | --- |
| Actual Wasm geometry and compressor fixtures | 6 passed |
| Independent freeze-detector fixtures | 3 passed: healthy motion accepted; frozen final six seconds rejected; video ending before audio rejected |
| 20-second dual 1080 synthetic recording | Both files decoded; motion throughout, including final five seconds; maximum frame gaps about 0.159 seconds; audio aligned |
| 20-second dual 1080 camera/microphone adapter recording | Both files decoded; motion throughout; maximum frame gap about 0.216 seconds; audio aligned |
| 90-second dual 1080 synthetic recording | Both files decoded completely; 1322 landscape / 1315 portrait frames; maximum gaps 0.266 / 0.294 seconds; motion in every complete second and in final five seconds; audio aligned |
| Failed encoder construction, interruption, quota, IndexedDB fallback and scoped staging cleanup | 5 checks passed |
| Source downloads and notices | Both archives return actual gzip bytes without erroneous HTTP decompression; GPL and MIT notice routes return successfully |
| Final 0.0.2 frontend smoke check | Two playable five-second H.264/Opus files at 29.96 / 29.79 fps, maximum gaps 0.061 / 0.076 seconds; visible footer and release metadata both report 0.0.2 |

The 90-second test covered the corrected H.264 core bundle `index-BoQtlZeJ.js`, SHA-256 `19f6ce6c681e376867f48317298b86b932142b18b00f8dbec4023ee3f26ca5ce`. Subsequent frontend changes add the visible experiment version, UI start/setup guards and local-staging cleanup; they do not alter the tested media pipeline. The complete final build passed the separate frontend smoke check: `index-2PKB_N8p.js`, SHA-256 `69ad2eb53103250e9c65ef6135afa66b3b3d5c6d533f6e5e3de8bb10596f6e84`.

Motion verification inspects decoded timestamps, maximum gaps including the audio tail, per-second changed-pixel coverage and final-five-second activity. It does not equate a playable first frame or early motion with a healthy complete recording. Generated negative fixtures validate the detector itself. Recorded files also present decoded frames in Chrome and fully decode with FFmpeg.

## Qualification limits

The freeze regression is fixed in these tests. **Sustained dual 1080p30 is not qualified in this Linux VM.** The 90-second H.264 files averaged approximately 14.5 decoded fps; the camera adapter short run averaged approximately 18.7 fps. These are measured limitations, not passes against the 30 fps target. The one-hour benchmark and 4K60 hardware qualification remain outstanding.

Capture tests use generated sources and Chrome fake camera/microphone devices. They exercise real browser APIs, Wasm, audio processing, encoders, muxing, local storage and file playback; they do not qualify physical Mac/Windows cameras, GPUs, drivers or thermals. Detailed source detail and frame-rate semantics remain in the research validation plan.

The runtime is an explicit OBS component subset. Full libobs and desktop plugin compatibility remain unimplemented; see [engine status](../engine/PORT_STATUS.md).

Raw reports, actual recordings and screenshots are under `.context/results/` and `.context/screenshots/`. The browser regression commands, optional performance qualification and independent verifier are documented in [tests/README.md](../tests/README.md).

## Studio interface · 0.1.0

The redesigned full-window studio passed eight browser checks: four viewport layouts (1440×900, 1280×720, 2560×1440, 768×900), actual zoom/source visibility and microphone controls, keyboard/dialog accessibility, and two paired recording regressions. Additional real-browser smoke checks covered scene creation/duplication/deletion/renaming, local persistence, project naming and account preferences.

The 12-second synthetic recording changed between camera, camera zoom and screen while recording. Both downloaded files independently decoded completely with audible Opus, active motion through the final five seconds and no frozen tail. The separate fake-camera/microphone run also passed. Rates were approximately 29.70–29.97 fps for these short 360p checks; this does not change the outstanding sustained 1080p/4K qualification.

A follow-up fixed false sticky low-frame-rate warnings caused by reading frame counts at the 100 ms audio-meter cadence. Audio still refreshes at 100 ms, FPS uses one-second windows, a warning needs three consecutive low windows, and recovery clears that warning without overwriting unrelated errors. Three targeted checks on the final build passed: live media controls, keyboard/dialog behavior and the paired recording regression. Both session/result warnings were empty, final render cadence was 30 fps, and the independently decoded files had a maximum frame gap of 0.074 seconds with active audio and motion.

The final studio runtime is `index-Cmg-ZbO6.js`. Evidence: `.context/results/studio-ui/production-summary.json` and `fps-warning-regression.json`; current screenshots are `.context/screenshots/studio-final.png`, `studio-final-zoom.png` and `studio-final-recordings.png`.


## Projects, simplified studio and compatible downloads · 0.2.0

The frozen production runtime `index-w-PrUNyu.js` (SHA-256 `a86bc402fd3f9cebf81a6d0db4f8753ab9ddc00b18ec7cf1d848d3eadcf6191d`) passed eleven production checks: four viewport layouts, a clean nontechnical customer path, actual zoom/perspective/audio controls, project creation/rename/search/reload isolation, real image import, keyboard/dialog accessibility and two dual-recording regressions. Scene create/duplicate/delete and delete-last-project/recreate edge checks also passed.

The synthetic 360p pair decoded 339/336 frames at approximately 27.33/27.09 fps with maximum gaps 0.112/0.096 seconds. The fake-camera pair decoded 156/153 frames at 18.35/18.0 fps with maximum gaps 0.205 seconds. All files retained active moving tails and audible audio. Recorded outputs reopened as decodable videos after a full page reload. These are short functional checks, not sustained-frame-rate or physical-device qualification.

Four independent storage checks passed for legacy settings migration, OPFS persistence, IndexedDB fallback persistence, and one-time completed-recording import with project isolation. Deleting one project's recordings leaves other projects and unassigned recordings intact.

All ten Node/browser/decoder fixtures passed, including the new local AAC export fixture. That test converted an H.264/Opus fragmented MP4 to H.264/AAC-LC (48 kHz stereo), preserved the compressed video SHA-256 exactly, moved `moov` before `mdat`, independently decoded moving video and audible audio, and made no external network requests. Consumer WhatsApp upload acceptance remains a physical-client check; codec/container verification is automated. See [RECORDING_COMPATIBILITY.md](RECORDING_COMPATIBILITY.md).

Evidence: `.context/results/hotmart-ui/production-summary.json`, `.context/results/hotmart-ui/scene-project-edges.json`, `.context/results/compatible-export/verification.json`, and `.context/results/node-v020.log`. Screenshots are `.context/screenshots/hotmart-studio.png` and `.context/screenshots/hotmart-projects.png`.


The additional production primary-download test passed for both outputs on the same frozen runtime. It recorded camera → zoom → presentation, clicked the actual **Baixar vídeo** buttons and verified both automatic downloads. Landscape/portrait decoded 183/182 frames at 29.89/29.73 fps; maximum gaps were 0.0671/0.0668 seconds. Both converted files had AAC-LC audio, no B-frames, unchanged H.264 bitstreams, ordinary faststart MP4 metadata, moving tails and audible sound. No external network requests occurred. Evidence: `.context/results/hotmart-compatible-download/report.json`; screenshot: `.context/screenshots/hotmart-compatible-download.png`.


## Scene editor and studio polish · 0.3.0

The final production runtime is `index-CoIsr7DE.js`, SHA-256 `6cee749dba084e636503a79b18596296ff4f28c079c5efea3203582c27f68565`. All 23 production checks passed: the prior nine UI checks, ten polish/edge checks, two paired recording regressions, the actual compatible-download flow and the adaptive-thumbnail slowdown check. Coverage includes existing camera-grant reuse with/without a microphone grant; unknown/unsupported grants without unsolicited capture; custom countdown capture layers without auto-prompts; per-scene camera circle/outline/shadow/layer paint order; countdown title/image/duration/pause/reset/persistence; different equal-duration countdown scenes resetting independently; small sampled thumbnails; actual project covers; sidebar context actions/collapse; and Radix menu/modal focus handling.

The final 12-second synthetic 360p pair decoded 367 frames in each output at 29.89/29.88 fps, maximum gaps 0.067/0.065 seconds. The fake camera/microphone pair decoded 245 frames each at 29.67/29.79 fps, maximum gaps 0.068 seconds. Both pairs retained audible audio and moving final tails. Both primary downloads again produced ordinary H.264/AAC faststart MP4 with unchanged compressed video and successful independent decode. These short checks do not qualify sustained 1080p30, one-hour recording or 4K60.

The model suite has eight targeted persistence checks covering old settings/scenes/visibility migration, per-scene appearance isolation, actual 320×180 JPEG covers, stale-cover-save protection, background Blob persistence/shared-reference cleanup, recording restoration and deletion isolation. The independent Select check covers empty device defaults, disabled items, keyboard selection, focus restoration, and first-Escape menu / second-Escape modal behavior.

The compositor suite independently verifies a 10:1 screen input remains 10:1 in the presentation scene with equal X/Y scale, layer visibility/order, actual circle cropping, live countdown pause/resume/reset and real dual countdown recordings. A camera replacement check verifies only the old camera video track ends while microphone/screen/media stay live, without another display picker. A Chrome test without an autoplay override uses CDP `userGesture:false` to confirm a granted camera preview reaches ready without interaction.

Presentation now uses a cached depth frame and undistorted live pixels, replacing 64 live resampling strips. The panel is bounded to 38% of landscape width / 72% of portrait width to leave the presenter prominent. Timing checks compare the same CPU-backed dual1080p canvases with forced readback; their composition-only frame budget excludes capture, encoding and storage and is not an end-to-end performance qualification.

Evidence: `.context/results/studio-polish/final-production.log`, permission/style/countdown/thumbnail JSON files in the same directory, `.context/results/hotmart-compatible-download/report.json`, and `.context/results/scene-compositor/`. Final screenshots are in `.context/screenshots/`.


The adaptive-thumbnail check injects 20 ms of work only into main-output draws, reducing actual measured render cadence to 21.5–22.1 fps. The guard paused all five small preview canvases after 3.77 seconds; their draw counts remained unchanged over a following 1.6-second interval, and recording stopped cleanly. This exercises real render metrics rather than fabricated snapshot values. Evidence: `.context/results/studio-polish/adaptive-thumbnails.json`.


All eleven serial Node/media fixtures passed on the final code (`.context/results/node-v030.log`). The final controlled dual1080p compositor timing was 25.10 ms per frame pair for presentation versus 36.73 ms for the prior strip-warp path; normal camera+screen was 22.02 ms. Four sampled 240×135 scene previews took 0.055 ms per refresh set. Input aspect, unchanged video bitstreams, audible AAC exports, no-gesture autoplay preparation, source-preserving camera replacement, countdown decode and moving presentation recordings all passed. These composition figures are not sustained capture/encoding qualification.

Final screenshot set: `.context/screenshots/studio-polish.png`, `studio-countdown-final.png`, `studio-preferences.png`, `studio-custom-select.png`, and `studio-projects-final.png`.


## Editable layers and independent scene audio · 0.4.0

The reviewed production build `index-Bomc65EU.js` (SHA-256 `c0940f955cdfcd297b8906a1a19d0a6a324f70834561d5b987f0b36324057967`) passed all 22 production regression checks: nineteen UI/permission/scene/persistence checks, paired synthetic and camera/microphone recordings, and both H.264/AAC download actions. The synthetic outputs decoded 367/367 frames at 29.43/29.44 fps with maximum gaps0.118/0.117seconds; camera outputs decoded248/248 at29.72fps, maximumgap0.084seconds, with moving tails and audible audio. These are short360p functional checks.

A final targeted-picker refinement shipped as `index-CLtFqlCX.js`, SHA-256 `2bd3c6e7aab15ea0136a1bd4bf8d597bc164f8ed3b7b6011506351c23ede3be4`. It limits screen/media replacements to file and display choices, clears the target on cancellation, and preserves the prior media engine and stylesheet. The independent reviewer reran the complete media-replacement/assets/framing-reset flow and sidebar/tooltip/modal flow on this final bundle:2/2passed. Its source picker has no irrelevant camera/microphone actions.

The fresh adversarial review covered seven feature flows across the production builds, including actual pointer drag/resize, independent text content/font/color and horizontal/vertical geometry, keyboard dnd-kit order, persistence, source replacement preserving siblings, per-scene mute/gain, sustained-input mute notices, microphone-device constraints, paused/zero countdown controls, reduced-motion geometry, and nested menu/dialog focus. The confirmed focus-restoration issue was fixed and retested, and controls are inert while sources connect. No review findings remain open. Recorded text was independently decoded from both MP4s to verify actual output position/colors; recorded audio RMS was0.04011→0exactly→0.04017 across audible/muted/restored intervals in both orientations. Device tests use two logical IDs mapped to real Chrome fake-microphone streams, validating constraints/state rather than physical hardware.

All thirteen serial Node/media/decoder fixtures passed (`node-v040.log`). New fixtures verify independent media/display bindings across prepare; camera-less media recordings with zero getUserMedia calls; synchronous display chooser invocation; source ownership/removal; full/partial background movement without old pixels; repeated text/geometry; countdown initiallypaused, zero, and resetalwayspaused; raw microphone metering before mute; and both encoded muted tracks decoding to sample peak0. Existing Wasm/DSP, codec-copy/AAC and freeze-detection checks remain in place.

Ten browser persistence checks passed, including revision3 migration of old shared audio into the selected scene, unchanged other-scene defaults/text/geometry, media asset references surviving siblings and cross-project copies, and deletion after the final reference. Static scene diagrams contain SVG rather than capture canvases and remain unchanged while the main output moves; the obsolete live-thumbnail adaptation test was replaced by this stronger no-recurring-work contract.

Evidence: `.context/results/editor-kit/production-summary.json`, `.context/results/editor-review/review.json`, `.context/results/editor-model.log`, `.context/results/layer-engine/`, and `.context/results/node-v040.log`. Showcase screenshots are `.context/screenshots/studio-editor-multiple-layers.png`, `studio-editor-countdown.png`, and `studio-editor-collapsed.png`.

This validation does not claim full libobs/plugin support, physical USB device qualification, sustained dual1080p30/one-hour recording,4K60, or an actual WhatsApp client upload. Imported file media remains visual-only. Changing physical devices during a take is explicitly blocked rather than silently using the wrong device.
