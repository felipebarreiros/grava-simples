# Recording storage: local and cloud

Recordings are saved locally first. With the cloud service connected, **Salvar na nuvem** backs up both landscape and portrait originals to a private Vercel Blob store. The library shows **Somente neste dispositivo**, **Neste dispositivo + nuvem**, or **Na nuvem**. **Fazer backup automático das próximas gravações** is an account-specific opt-in; older recordings require an explicit upload.

Supabase Postgres stores the account-owned catalogue, asset reservations, transcript snapshots, processing jobs and atomic rate limits. Vercel Functions authenticate Clerk sessions before accessing that database. Neither recordings nor transcription need Redis. The separate remote-control feature can still use Redis.

## What is synchronized

A finalized backup contains both output files, their bounded metadata, the actual video thumbnail, and the project name/ID used to group recordings. Opening the same account on another device fetches that library and streams private media using short-lived URLs. Playback does not download two complete files into the persistent device cache. **Baixar cópia local** explicitly stores originals for offline use; export and transcription can temporarily materialize the required file.

An existing transcript is included after the first backup when the cloud transcript is empty. The review page retrieves a cloud transcript when no local transcript exists. Later corrections use **Salvar transcrição na nuvem**; version checks reject concurrent changes instead of overwriting another device's version. Local wording is preserved on a conflict. Transcript snapshots accept at most 3.8 MB.

Authored scene configuration, uploaded scene assets and timestamped markers remain local. A project recreated from a remote recording starts with default scene configuration. This is recording backup, rather than synchronization of the complete editable studio workspace.

## Local cache and old recordings

Project catalogues, OPFS/IndexedDB recording bytes, scene assets, transcripts and review notes use separate account namespaces. Async operations retain the account that started them and reject work after an account switch. Logging out retains files without exposing them in another account's normal library. Browser namespaces are application isolation, not encryption against someone controlling the browser profile or its developer tools.

Old unscoped recordings are left untouched. **Importar minhas gravações deste navegador** explicitly claims and copies the legacy recording library into the current account's local workspace; it does not upload old recordings automatically. A browser lock coordinates claims across tabs. Source originals survive a failed import.

The recording cache targets **1 GB**, reduced when that exceeds 20% of the browser quota or the origin is under storage pressure. It removes least recently used local video copies only when a fresh authenticated cloud catalogue confirms a ready backup and both file byte counts match. Active/open recordings are protected. A stale local cloud receipt, incomplete upload or unavailable service never authorizes eviction. **Liberar cópia local** makes the same fresh check.

Unbacked originals are preserved even when the cache target is exceeded. The target is therefore not a strict limit on all site storage; scene assets and other origin data also consume space. Download or explicitly delete unbacked media when space is low. Clearing site data removes local-only files. Automatic browser storage eviction remains outside the application's control.

## API and limits

| Request | Behavior |
| --- | --- |
| `GET /api/recordings` | Account-owned catalogue, 25 records per page; follow `nextCursor`. |
| `POST /api/recordings` with `action: "reserve"` | Validate take metadata and atomically reserve bytes for both orientations. |
| `POST /api/recordings-upload` | Clerk-authenticated Vercel Blob client-upload token protocol. |
| `POST /api/recordings` with `action: "finalize"` | HEAD-check exact private paths, content types and byte counts before marking ready. |
| `GET /api/recordings?recordingId=…&orientation=…` | Verify ownership and issue an exact-object read URL lasting ten minutes. |
| `GET /api/recordings?recordingId=…&transcript=1` | Return the saved transcript and its version. |
| `POST /api/recordings` with `action: "transcript"` | Save a validated snapshot using `expectedVersion`. |
| `DELETE /api/recordings?recordingId=…` | Hide the recording, remove its objects, and retain retryable deletion state. |

Each orientation is limited to **512 MB**. An account can reserve at most **10 GB** or **1,000 recordings**, including pending/deleting reservations. An advisory transaction lock serializes reservations for the account, preventing concurrent requests from overspending that allowance. API limits are 120 requests/minute, 30 reservations/hour and 60 upload grants/hour per account.

Uploads go directly from the browser to Blob, avoiding large video bodies in Functions. Upload grants are restricted to a server-created account/recording/orientation path, expected content type and byte ceiling; they expire within fifteen minutes and do not permit overwrites. Failed uploads can retry existing reservations. The original files remain local until independently eligible for cache removal.

Deleting marks metadata unavailable before object removal. Tombstones retain quota until previous upload grants have expired, with at least twenty minutes of grace; scheduled cleanup repeats physical deletion before releasing the reservation. Expired pending uploads also receive a twenty-minute grace period. The daily cleanup route considers at most 25 eligible recording rows per invocation with a bounded execution budget. Failed or backlogged cleanup can retain objects and reserved bytes longer. Signed read URLs are bearer capabilities until expiry; deleting an entry prevents new URLs but is not an instantaneous revocation guarantee for an already issued URL or cached response.

## Database access controls

All user tables in the private `grava_storage` schema have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. `grava_app` is a non-owner login with `NOINHERIT`, `NOBYPASSRLS`, no role memberships and no administrative privileges. Runtime checks reject an accidental owner/admin connection.

Each request verifies the Clerk bearer token and exact approved origin, opens a transaction, sets `app.user_id` locally from the verified identity, performs parameterized queries, then commits or rolls back. Policies apply both `USING` and `WITH CHECK` ownership conditions. Composite foreign keys prevent assets from attaching to another owner's recording, and path constraints bind each asset to its owner, server UUID and orientation. Transaction-local identity does not persist when a pooled connection is reused; a failed rollback destroys that connection.

`grava_maintenance` has no direct application-table access. It can execute only bounded cleanup functions owned by the non-login `grava_storage_worker` role. Those functions have fixed search paths, no public execute grant, and RLS access limited to eligible expired/deleting rows. The cron HTTP route also requires `CRON_SECRET`. Keep this schema outside Supabase's exposed Data API schemas; no browser Supabase client, anonymous key or service-role key is needed. See [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Provisioning and secrets

Use a dedicated Supabase project connected through Vercel, plus separate **private** Blob stores for durable originals and temporary transcription input. The server variables are:

| Variable | Scope |
| --- | --- |
| `DATABASE_URL` | Supabase pooled connection for `grava_app`. |
| `GRAVA_MAINTENANCE_URL` | Separate pooled connection for `grava_maintenance`. |
| `RECORDINGS_BLOB_READ_WRITE_TOKEN` | Permanent recording store only. |
| `BLOB_READ_WRITE_TOKEN` | Temporary transcription-input store only. |
| `ASSEMBLYAI_API_KEY` | Hosted transcription provider only. |
| `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`, `APP_ORIGINS` | Verified account sessions and exact allowed origins. |
| `CRON_SECRET` | Scheduled cleanup authorization. |

Apply `node scripts/migrate-storage.mjs` once with a separately supplied `DATABASE_ADMIN_URL`. The migration runner uses an explicit manifest of this service's SQL files and records checksums; it does not execute other features' migrations. `STORAGE_APP_PASSWORD` and `STORAGE_MAINTENANCE_PASSWORD` can set randomly generated 32–128 character base64url passwords for the restricted logins. The runner temporarily grants the migration administrator membership needed to transfer function ownership and removes that membership if it added it.

Do not deploy `DATABASE_ADMIN_URL` or migration passwords as runtime variables. Use the Supabase transaction pooler for serverless requests; custom login usernames have the form `grava_app.<project-ref>` or `grava_maintenance.<project-ref>`, while SQL `current_user` remains the corresponding role. Obtain the exact host/port from the project's connection panel. The administrative migration uses a direct or session-pooler connection. See [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

Store real credentials as sensitive server-only Vercel environment variables. Never use a `VITE_` prefix for them, commit them, add them to source archives or print them in diagnostics. `.env.example` contains names and empty values only. Keep preview and production resources separate; connecting an integration does not itself apply migrations or create the restricted login URLs.

## Verification status

The implementation has real PostgreSQL tests for two-account isolation, forced RLS, rejected administrator credentials, concurrent quotas, processing locks, cleanup restrictions and pagination. A fresh migration was also tested under a non-superuser administrator. Browser tests exercise account separation, backup controls and cache behavior with controlled transports.

Private Blob stores and a provider credential have been provisioned. At this change's implementation stage, the Supabase connection credentials had not yet synchronized into the application environment. A real hosted-provider smoke test uploaded a generated 14-second Portuguese clip to the temporary private Blob store, verified unsigned access was denied, and received 29 words with valid provider timestamps. The temporary file and provider transcript were deleted afterward. A production API recording upload and cross-device playback still require the Supabase credentials and migrations; local tests and this provider-only check do not establish that complete deployed flow.
