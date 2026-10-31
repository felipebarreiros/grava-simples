# Application, API and recording storage

Keep the browser application and authenticated API in this repository and deploy them as one Vercel project. Supabase Postgres supplies durable metadata and account isolation; private Vercel Blob stores media. AssemblyAI handles asynchronous transcription. Recording storage and transcription do not need a separate repository or Redis service.

## Implemented boundaries

| Component | Responsibility |
| --- | --- |
| `src/` | Local capture, account-scoped device storage, recording review and optional cloud backup. |
| `api/`, `server/storage/`, `server/transcription/` | Clerk authorization, ownership, quotas, upload grants, finalization, temporary playback access and cleanup. |
| Supabase Postgres | Recording/asset catalogue, transcript versions, transient processing state and atomic request limits. |
| Durable private Blob store | Both original output orientations. |
| Separate temporary private Blob store | One input for a transcription job, with an independent cleanup lifetime. |
| AssemblyAI | Long-running speech recognition and actual word timestamps. |

Vercel Functions exchange small authorization and job documents; the browser uploads video directly to Blob after authorization. A server-generated recording UUID and verified Clerk identity determine ownership. Local IDs, object paths and provider job IDs are not authorization. The catalogue reservation serializes account byte usage before granting uploads, and finalization checks the actual private objects before declaring a backup ready.

Supabase is used through restricted Postgres logins, not a browser service-role key. All user tables live in an unexposed `grava_storage` schema with forced RLS. Application requests bind the verified account transaction-locally; an independent cleanup login can execute only bounded maintenance functions. See [storage access controls and setup](CLOUD_STORAGE.md).

## Local and cloud behavior

Recording remains local first. Creators can back up individual takes or opt into automatic backup of subsequent recordings. Both independent landscape and portrait files are preserved; the portrait composition cannot be reconstructed by cropping the landscape output. One orientation is sufficient for transcription because the source audio timeline is shared.

The authenticated remote library restores recording metadata on another device and streams its private media. An explicit offline action downloads originals. The local recording cache targets 1 GB, adapts to origin storage pressure and evicts only inactive files whose complete cloud backup and matching byte counts were freshly verified. Unbacked recordings are preserved even if the cache target is exceeded.

Local project settings, scene assets, transcripts and review notes are namespaced by account. Old unscoped recordings require an explicit device import; sign-in does not silently assign them to the current account. Authored scene settings, media inputs and markers are not yet synchronized. Cloud-backed transcript snapshots have an explicit save action and optimistic versions.

## Independent lifetimes

Permanent media uses `RECORDINGS_BLOB_READ_WRITE_TOKEN`; temporary transcription media uses `BLOB_READ_WRITE_TOKEN`. These credentials must reference different private stores. Transcription cleanup must never delete permanent originals.

A recording deletion hides metadata before removing objects. A retained tombstone allows retries and protects against uploads completing under an outstanding grant. Scheduled cleanup repeats deletion after the grace period, then releases the reservation. Provider jobs expire logically after 24 hours and retain cleanup state until removal succeeds. Daily bounded sweeps can accumulate a backlog; monitor failures and increase capacity before promising a deletion deadline. See [recording cleanup](CLOUD_STORAGE.md) and [transcription retention](VERCEL_TRANSCRIPTION.md).

## Deployment and validation

Configure service credentials as server-only sensitive Vercel variables. Apply migrations through a separately supplied administrative database URL, then deploy only restricted runtime and cleanup URLs. Preview must have isolated resources rather than inheriting production ownership or cleanup authority.

Private stores and a provider credential have been provisioned. At implementation time, the connected Supabase project's database credentials had not yet synchronized into the application environment. The code and native PostgreSQL isolation tests do not establish production upload, playback or transcription success. Finish migration/credential setup, then verify both output files from another browser, cross-account denial, interrupted-upload retry, transcript retrieval and deletion against the deployed service.

## Later service extraction

Keep expensive rendering or a GPU worker separate when its runtime or scaling requires it. It can still deploy from this repository with a queue and explicit source/output references. Vercel supports multiple projects from one repository, so an independent runtime does not itself require a second repository. [Vercel monorepos](https://vercel.com/docs/monorepos)

Rendered word-based video cuts, share links and complete studio-workspace synchronization remain future work.
