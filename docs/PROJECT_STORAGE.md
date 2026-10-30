# Local projects, scenes, and recording library · 0.3.0

`src/projects/store.ts` stores a versioned project catalogue in the browser's
`grava-simples-workspace-v1` localStorage entry. Each project owns its scenes,
selected scene, capture settings, and saved take metadata. Recording bytes stay
in the existing OPFS recording directory or IndexedDB chunk store; adding a take
to a project does not copy its video data.

`ProjectScene.appearance` stores ordered layer IDs/kinds/names/visibility,
camera shape/outline/shadow settings, background color and asset reference,
product title, and countdown duration. Scene zoom remains a separate scene field.
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
version 1 with scene revision 2; those migration markers are independent of the
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

This is local browser persistence, scoped to the application's origin. It does
not add account storage, cloud synchronization, or a server database. The existing
browser storage quota and browser data-clearing behavior apply.

Completed output videos and uploaded scene backgrounds persist. Live capture
permissions and imported screen/media-source images/videos are session resources;
those input files must be selected again after reopening the project or reloading
the page. The scene-background uploader is separate and retains its image Blob.

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

Imported timed transcripts live separately under `grava-simples-transcript-v1:<takeId>`. They retain imported cue times, source filename, corrected text, and the original wording of corrected cues. `src/recordings/transcript.ts` validates SRT/WebVTT input and exports TXT/SRT/VTT. Corrections do not alter video bytes. Timestamped notes live under `grava-recording-review-v1:<takeId>`. Recording/project deletion and app-wide recording cleanup remove these entries too.

Detail URLs use `#project/<projectId>/recording/<takeId>`. These identify local catalogue entries, not remotely shareable recordings. Restoring a take creates fresh object URLs, and closing the recording releases them. Playback requires neither camera permission nor a functioning capture engine.

Automatic transcription optionally uploads one saved format to private Blob and stores an account-bound asynchronous job in Redis. Completed words and phrase cues are copied into the existing local transcript entry, retaining real source times. Corrections preserve those original words. Approved replacement intent and a small cloud-job receipt persist per account/recording, so reloads apply a requested replacement once while retaining later corrections. Deleting a take/project with a cloud receipt requests remote cancellation/cleanup before removing local media. Scheduled cleanup covers abandoned jobs. This adds temporary cloud media and job results, rather than cloud synchronization of the local catalogue; see [limits and retention](VERCEL_TRANSCRIPTION.md).
