# Recordings: product direction and transcription architecture

Research checked against primary sources on 2026-10-30. Feature proposals below
are recommendations, not claims that the application already implements them.

Implementation update: the Vercel release now includes an authenticated asynchronous transcription API using AssemblyAI Universal-2, private Blob and shared Postgres limits. This original analysis describes the earlier local-only baseline and editing roadmap. See [deployment instructions](VERCEL_TRANSCRIPTION.md) and [current platform/provider research](VERCEL_TRANSCRIPTION_RESEARCH.md) for the implemented cloud approach. Rendered media cuts remain future work.

## Recommended direction

Build a recording workspace around a transcript on the left and the real video
on the right. Start with reliable playback, recognizable thumbnails, searchable
timed text, and original downloads. Add reversible media cuts after timestamp
quality and export behavior have been validated. Keep a recording's horizontal
and vertical outputs together because they are two versions of the same take.

Use server processing for the first automatic Parakeet integration. Keep local
playback and project metadata independent of that service. An optional native
local transcription companion is a plausible later offering; a large model
download should not be a prerequisite for opening recordings.

## What exists in this repository

The application is a React/Vite browser app. The recording catalogue lives in
localStorage (`src/projects/store.ts`); video bytes live in OPFS or IndexedDB
(`src/media/storage.ts`). Clerk provides authentication, but this repository has
no transcription endpoint, durable job queue, media upload service, cloud
recording storage, or GPU worker. Login does not currently make a local recording
available to another device.

The current compatible download worker (`src/media/compatibleExport.ts`) copies
H.264 video and converts audio to AAC. It accepts MP4 input with a 256 MB local
limit. That path is not an arbitrary-precision cut renderer. Reliable cuts across
non-keyframe positions need a separate export implementation and validation.

Therefore the interface can progress now without implying that automatic
transcription or rendered word-based edits already exist. Imported timed
transcripts are a useful bridge, provided their true timing granularity is clear.

## Riverside: patterns worth adapting

Riverside's current walkthrough connects a video canvas, transcript and timeline.
Its transcript can select a passage for removal or keep only that passage;
restoration and undo preserve the original. Timeline handles refine cuts, while
transcript search locates passages. The same walkthrough includes optional pause
and filler removal, aspect-ratio versions, and export. These patterns support a
small editing workspace without requiring its whole toolset. [Official editor
walkthrough](https://riverside.com/university-videos/editor-clips-walkthrough)

Its help documentation makes removal visible as struck-through text, and
distinguishes deleting media from muting speech. That visible history is useful
for creators comparing a draft to the source. [Remove a word or phrase](https://support.riverside.com/hc/en-us/articles/14488573075741-Remove-a-word-or-phrase-from-the-recording)

Correcting transcript spelling is a separate action from removing media. Adopt
that separation explicitly: fixing a name must not alter what the speaker said
in the video. [Correct transcript and caption text](https://support.riverside.com/hc/en-us/articles/13327985961885-Correct-the-transcript-and-caption-text)

These observations come from Riverside's published documentation and walkthrough,
not an authenticated inspection of a customer's private editor. The priorities
below are product judgments inferred from the recording workflow, rather than
claims from user interviews or a statistically representative creator survey.

## Creator jobs and page content

| Job | Recommended content or control | Why it matters |
| --- | --- | --- |
| Recognize the correct take | Actual frame, recording title, date, duration, project, small video badge | Creators often have several similar takes; a generic icon cannot distinguish them. |
| Check the recording | Large playable video, scrubber, elapsed/total time, volume, speed, horizontal/vertical switch | Reviewing should work before any transcription is ready. |
| Find a moment | Transcript search, result count, timestamps, click-to-seek, active passage | Reading and searching are faster than scrubbing a long tutorial or conversation. |
| Understand transcript status | Clear empty, importing/uploading, queued, processing, ready and failed states | A blank pane should never suggest that speech was lost. |
| Fix transcription | Edit text separately, preserve source timing, save state | Names, specialist terms, and Portuguese/English code switching need correction. |
| Make a rough cut | Select a timed passage, remove/restore, undo/redo, compare original | First and last false starts are common practical edits. |
| Publish elsewhere | Original downloads, later edited video, TXT and timed-caption export | Creators need usable assets, not just an in-app preview. |
| Reuse a good passage | Mark a highlight, keep selected range, later name and export a clip | One long recording can feed several shorter pieces. |
| Trust saved work | Visible saved/error state and recovery after reload | Losing a rough cut is more costly than an extra click. |

Avoid overwhelming the first page with stock media, generative chat, advanced
color controls, or publishing integrations. Those features do not unblock the
core review-and-trim journey.

### Library thumbnails

Sample the actual recording at 5% of its duration, bounded away from its end.
This is a practical heuristic, not a guarantee of a meaningful frame. Countdown
intros, slides and black frames can still occur at 5%. If seeking fails or
duration is unavailable, try the first decodable frame; if decoding fails, retain
an honest video placeholder. Later, let a creator choose the cover frame.

Cache a bounded JPEG separately from full video data. Generate lazily, limit
concurrent decoders, revoke object URLs and release video resources. Older takes
can acquire thumbnails when opened or when their card enters view. A thumbnail
failure should not prevent playback or download.

### Detail layout and behavior

Use a compact top bar with back navigation, title, save state and download. Below
it, give the transcript a readable width and the video the remaining space.
Keep playback controls next to the video; preserve playback position when
switching output orientation. A small timeline below the split view can grow
into an editing surface later. On narrow screens stack video and transcript;
ensure neither requires horizontal scrolling to read.

Transcript rows should show time and readable paragraphs. A word-highlight mode
can follow playback once real word alignment exists. Keyboard navigation and
clear focus states matter as much as pointer selection. Do not auto-scroll away
from someone who is searching or correcting earlier text; offer a follow-playback
control instead.

Do not invent speech for untranscribed recordings. An import action and a clear
empty state are preferable to a sample transcript that appears to describe the
customer's video. Silent recordings should have a successful no-speech state.

## Parakeet TDT 0.6B v3: verified facts

The model has 600 million parameters, supports 25 languages including English and
Portuguese, automatically recognizes the spoken language, and returns punctuation,
capitalization and word/segment timestamps. Its documented input is mono 16 kHz
WAV/FLAC. NVIDIA documents NeMo Python inference, long-audio attention settings,
and a native C++ option. The model card lists a 2 GB loading minimum, not a
production capacity guarantee; longer audio needs more memory. The checkpoint
uses CC BY 4.0 terms. [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)

The official repository currently lists a 2.51 GB `.nemo` checkpoint, a separate
2.51 GB `safetensors` checkpoint, and a 714 MB Q8 GGUF alternative. These are
alternative artifacts, not a requirement to download the entire repository. The
“0.6B” name is not a 600 MB download size. [Official model files](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/tree/main)

NVIDIA's NIM support matrix includes v3 as `type=multi`, offline inference,
with a listed batch profile around 14 GB GPU memory. NIM's documented hardware
floor is an NVIDIA GPU with 16 GB VRAM and compute capability at least 8.0.
These are NIM container requirements; they should not be presented as the
minimum for every possible Parakeet runtime. The language table labels
Portuguese as `pt-PT`, so Brazilian Portuguese quality deserves its own test
set. [NIM support matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html)

NVIDIA's official native runtime supports Parakeet v3 and provides native
CPU/GPU backends, a CLI, HTTP server and C ABI. It is a concrete route for an
optional desktop companion. Native support does not establish that the existing
React browser app can execute the same model directly. [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp)

## Where transcription should run

| Option | Advantages | Costs and missing work | Recommendation |
| --- | --- | --- | --- |
| Server worker | Consistent runtime, reusable loaded model, no customer model download, predictable job handling | Audio upload, service operation, queue, retention policy, access control, per-minute compute cost | First automatic transcription release. |
| Directly in browser | Can keep audio on the device and avoid inference service bills | Runtime/model conversion work, large download and cache, memory/device variation, background tab interruption, warmup | Prototype against target browsers before committing product support. |
| Native local companion | Real local CPU/GPU inference path; reusable model cache | App installation, updates, localhost integration and support across operating systems | Optional later privacy/offline path. |

This recommendation is an engineering judgment based on the current repository,
artifact sizes and available official runtimes. It is not a measured benchmark
of this application. Do not quote generic model throughput as an end-to-end
promise: upload, decoding, resampling, cold starts and concurrency also count.

### Proposed server contract

1. The creator requests transcription and sees that audio will be sent for
   processing. Local preview continues to work.
2. Extract one audio track from the take, not both orientation videos. Resample
   to mono 16 kHz in bounded chunks. If extraction on the customer device is too
   expensive, evaluate uploading the smaller source video with a clear size limit.
3. Create an authenticated job tied to account, recording and audio fingerprint;
   upload to temporary object storage with resumable/retry behavior.
4. A durable queue dispatches a worker that loads a pinned model revision once.
   Process long files in bounded sections, offset timestamps to source time,
   resolve overlap and preserve exact word order.
5. Return normalized words `{ id, text, startMs, endMs }`, segments, language,
   duration, model revision and status. Preserve actual confidence only if the
   chosen runtime supplies it; do not synthesize confidence values.
6. Save results separately from source media. Allow polling/retry and cancellation.
   Deleting a recording should also remove its remote transcript/audio job data.

Keep provider credentials on the server. Authentication must check recording/job
ownership on every operation. Set an explicit temporary-audio retention window
and expose the resulting behavior at upload time. These are necessary parts of
introducing a cloud feature to today's local storage model.

Estimate cost from measured worker seconds per audio hour, expected utilization,
idle time, storage and transfer. Benchmark cold and warm runs at the intended
concurrency before choosing a hosting plan or promising a transcription quota.

## Editing architecture and timing limits

Maintain source media immutably and store an edit decision list of source-time
intervals. Apply the same intervals to horizontal and vertical outputs. Derive
edited duration and transcript from that list. This makes undo, reload, original
downloads and repeated export much simpler than modifying source files.

Timed captions from SRT/VTT generally identify phrase intervals. Do not divide a
caption evenly into words and describe that as measured word alignment. Such
imports can provide segment navigation and segment cuts; precise word cuts need
real ASR/alignment timestamps. Plain text has no timing and can support notes or
search only after alignment.

Source playback and an edited preview are different states. A preview can skip
removed source intervals, but the exported file must render those same decisions
or be clearly labeled as the original. Fine cuts need padding/refinement to
avoid clipped consonants and audible clicks. Muting speech should preserve
video timing; cutting should shorten both video and audio.

Speaker labels need a diarization or separate-track pipeline; multilingual ASR
alone does not establish reliable speaker attribution. The current application
records composed outputs, so it cannot promise isolated speaker camera editing
from those files alone.

## Delivery phases and acceptance criteria

| Phase | Deliverable | Release check |
| --- | --- | --- |
| 1: recording review | Real thumbnail, detail page, player, output switch, local transcript import/navigation/correction, TXT/SRT/VTT export, markers, honest empty/error states, originals | Open a stored take after reload; seek using real timestamps; handle missing files and silent/short recordings. |
| 2: automatic transcripts | Authenticated upload/job service and pinned Parakeet worker; word timestamps; retries; reuse caption exports | Benchmark Portuguese and English, code switching, noise, proper names, 5/30/120-minute files, cold starts and concurrent jobs. |
| 3: light editing | Persisted interval edits, word/segment selection, remove/restore, undo/redo, trimmed preview, rendered edited download | Reload restores edits; both orientations stay in sync; exported audio/video match preview; originals remain recoverable. |
| 4: repurposing | Named clips, captions, cover selection, optional suggested pauses/fillers and highlights | Suggestions are reviewable; cut boundaries sound natural; multiple exports preserve individual clip settings. |

Before phase 2 implementation, settle the hosting account/budget, audio retention,
and whether cloud transcription is opt-in or part of the normal account flow.
Before phase 3 release, choose a renderer and establish duration/file-size limits
with real recordings. A transcript panel and an interval model are useful
foundations, but neither alone constitutes a complete text-based video editor.
