# Projects, scenes, and recording storage

`src/projects/store.ts` stores a versioned project catalogue in the browser's
`grava-simples-workspace-v1:account:<Clerk user ID>` localStorage entry for a signed-in account. Each project owns its scenes,
selected scene, capture settings, and saved take metadata. Recording bytes stay
in the existing OPFS recording directory or IndexedDB chunk store; adding a take
to a project does not copy its video data.

`ProjectScene.appearance` stores ordered layer IDs/kinds/names/visibility,
camera shape/outline/shadow settings, background color and asset reference,
product title, and countdown duration. Scene zoom remains a separate scene field. New **Câmera com zoom** scenes default to 1.4×; explicit saved values, including 1.6×, are preserved.
These are serializable settings; live camera/display grants, timer progress, and
audio/video node state are session resources. Device choices persist, while
browser permissions continue to govern access.

- The original saved project title and scene list migrate into the first project.
- `importLegacyRecordings()` assigns completed pre-project takes to that original
  project once. Incomplete sessions remain available to the technical recovery
  flow and are not silently deleted.
- `saveProjectTake(projectId, result)` saves both output names, sizes, MIME types,
  duration, and recording timestamps after the recording store has finalized.
- `restoreProjectTake(take)` reopens the actual persisted files after a reload and
  creates fresh object URLs. Callers revoke those URLs when closing/replacing the
  restored result.
- `deleteProjectTake(id)` deletes only that take's files and catalogue entry.
  `deleteProjectAndRecordings(id)` applies that operation to that project's takes.
  Metadata-only `deleteProject(id)` rejects projects that still contain videos.
- Scene revision 2 adds serializable appearance/layer settings and the countdown
  template to existing projects once, preserving scene names, selection, settings,
  and takes. Old camera/screen visibility controls become matching layer visibility
  when a scene has no authored appearance. Removing the countdown scene afterward
  does not recreate it.
- `captureProjectCover(projectId, canvas)` saves actual composed pixels as a
  bounded 320×180 JPEG. A later `saveProject` from an older React snapshot retains
  the newer stored cover instead of erasing it. The cover setter merges only its
  own fields into the latest catalogue. `Project.cover` and `coverUpdatedAt` are
  optional: a new project has a placeholder until an actual frame is captured.
  The app refreshes covers periodically during an active preview/take, on take
  completion, and when leaving the studio; it does not persist every video frame.
- App-wide staged-file cleanup must also call `clearProjectTakeIndex()` so the
  library does not retain entries for deleted files.

Sidebar collapse is a separate browser preference in `grava-sidebar-collapsed`;
it does not change project contents. Project metadata stays at workspace format
version 1 with scene revision 3; those migration markers are independent of the
application's 0.3.0 release number.

`src/projects/assets.ts` persists uploaded scene-background images in a separate
IndexedDB database. `saveSceneAsset(projectId, sceneId, blob)` returns an immutable
ID for `SceneAppearance.backgroundAssetId`; `readSceneAsset(id)` reopens that Blob
after a reload. Supported browser image types are limited to 25 MB per upload.
Backgrounds can be shared by duplicate scenes. After saving/removing a scene,
`deleteSceneAssets(projectId, sceneId)` prunes its unreferenced uploads while
retaining images still referenced by another scene. Project deletion cleans up
its background images and preserves images still used by other projects. Immutable
asset IDs avoid rewriting an image used by a duplicate. Deleting the final project
that references a shared image also removes the previously borrowed image.

Local browser persistence is scoped to the origin and signed-in account. Recording bytes, scene assets, transcripts and markers use the same account namespace. Optional cloud recording backup adds an owner-scoped Supabase Postgres catalogue and private Vercel Blob media; scene configuration and its assets remain local. See [cloud storage and cache limits](CLOUD_STORAGE.md). Browser storage quota and data-clearing behavior still apply to local-only files.

Completed output videos and uploaded scene/layer media persist in the account's browser namespace. Camera and display-sharing permissions remain session resources; reconnect screen capture explicitly after reopening. Stored image/video source assets can reopen from their immutable local Blob references.

`tests/projects.spec.ts` exercises migration and independent project settings,
OPFS and IndexedDB file restoration across a real browser reload, per-project
deletion isolation, and one-time legacy recording import.
It also verifies scene-appearance migration, actual cover pixels, stale-state
cover preservation, and durable/shared scene-background images.


## Editor revision3 (application0.4.0)

Scene appearance now owns microphone mute/gain/device choices plus repeated layers, independent text/style, source IDs and per-orientation frames. Migration preserves the old shared audio controls on the scene that was selected; other scenes receive their own defaults. Existing authored layer appearances are preserved, and default scenes are not repeatedly regenerated.

Layer media uses the same immutable asset store as backgrounds (images≤25MB, videos≤256MB). Reference protection includes both backgroundAssetId and every layer.assetId, so shared/duplicated assets survive until the final reference is removed. Source IDs identify runtime decoders/streams and are restored from stored files after reload; display permissions cannot be persisted.

Geometry edits update the live model immediately, debounce storage writes briefly, and flush before navigation/recording or pagehide/beforeunload. Frame resets remove only the chosen output override. Replaced or removed runtime feeds are released only when no saved scene still references their source ID.

## Recording review data

`ProjectTake.thumbnail` and `thumbnailAtSeconds` cache a bounded JPEG decoded from the recording at 5% of its duration, falling back to the first frame. Take metadata is committed before best-effort thumbnail generation. Existing takes are backfilled near the library viewport through one decoder at a time. Decode failures preserve the take and its downloads; thumbnail writes merge into the latest catalogue to preserve concurrent renames.

Generated and previously stored transcripts live separately under account-scoped `grava-simples-transcript-v1:<takeId>` keys. Provider word times remain immutable when text is corrected, and older stored text remains readable. The recording page offers only the application's generated transcript, with TXT/SRT/VTT exports; it has no subtitle-upload interface. The legacy parser remains available for existing data and fixtures. Corrections do not alter video bytes. Timestamped notes live under account-scoped `grava-recording-review-v1:<takeId>` keys. Recording/project deletion and app-wide recording cleanup remove these entries too.

Detail URLs use `#project/<projectId>/recording/<takeId>`. These identify the authenticated account's catalogue entries, not public share links. Finalized cloud metadata can restore those entries on another device. Restoring a take creates fresh object URLs, and closing the recording releases them. Playback requires neither camera permission nor a functioning capture engine.

Opening a recording restores existing local text and checks a cloud transcript snapshot before starting paid work. With no existing transcript, automatic transcription checks service availability and resumes an existing job or uploads one saved format to a separate temporary private Blob store. The account-bound asynchronous job lives in Postgres with forced RLS and atomic quotas. Account-scoped attempt markers prevent repeated automatic submissions; failure or cancellation requires explicit retry, and an in-memory fallback suppresses duplicate effects in the current tab if device storage is unavailable; server ownership, quotas and job idempotency remain authoritative. Completed words and phrase cues are copied into the existing local transcript entry, retaining real source times. Corrections preserve those original words. Approved replacement intent and a small cloud-job receipt persist per account/recording, so reloads apply a requested replacement once while retaining later corrections. Deleting a take/project with a cloud receipt requests remote cancellation/cleanup before removing local media. Scheduled cleanup covers abandoned jobs. These temporary inputs have independent retention from permanent recording backups; see [limits and retention](VERCEL_TRANSCRIPTION.md).

## Durable recording backup and bounded cache

`src/recordings/cloudStorage.ts` uploads both originals after an account-bound server reservation, finalizes only after private-object verification, retrieves paginated catalogue metadata and opens short-lived private media URLs. `ProjectTake.cloud` records a server-confirmed backup, rather than the start of an upload. The library can save one recording, opt into backup of subsequent takes, download an offline copy, or release a verified local copy. Existing recordings are not silently uploaded.

`cloudCache.ts` targets 1 GB of recording cache, reduces that budget under browser quota pressure, and evicts least recently used inactive copies only when a fresh authenticated catalogue confirms ready media with matching landscape and portrait byte counts. Unbacked, active and unverified recordings are preserved; this is not a hard limit on all browser data. Opening cloud-only recordings streams media rather than persistently caching both videos.

Old unscoped recordings remain intact. An explicit browser-locked import copies legacy media and review data into the current account's namespace and records the claim; it never imports another account's scoped files. A later upload remains explicit. Authored scene settings and scene assets stay local, while recording metadata, both outputs and explicitly saved transcript versions can be retrieved across devices. Full API, access-control and cleanup details are in [CLOUD_STORAGE.md](CLOUD_STORAGE.md).
