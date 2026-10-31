# Publish recordings to Hotmart

The recording page's **Exportar → Enviar para a Hotmart** action opens a publishing dialog. Creators connect their own Hotmart account, choose or create a course and members area, manage modules, and send the selected horizontal or vertical recording as a lesson. The lesson title starts with the recording name; its description is editable. No LLM or AI service is called.

The main form shows the video format, course/module destination, lesson details, and publication choice. Creating a course or members area and managing modules use focused views with a back action; the upload draft is preserved while navigating. All controls inherit the same UI kit and dialog styling as the current studio.

**Connection prerequisite:** Hotmart must register an OIDC client for this application and approve its callback URL. The supplied research session token is not part of the product or its configuration. Hotmart's existing first-party client accepts its own app callback but rejects external callbacks; copying that client ID does not provide third-party login.

Without the server configuration below, the dialog accurately reports that the connection is unavailable. It does not ask creators to paste a token or give this app their Hotmart password.

## Server configuration

Configure these server-only variables along with the existing Clerk verification configuration and restricted `DATABASE_URL`. Never prefix secrets with `VITE_`.

| Variable | Value |
| --- | --- |
| `HOTMART_OIDC_CLIENT_ID` | Registered Hotmart OIDC client ID |
| `HOTMART_OIDC_CLIENT_SECRET` | Registered client secret |
| `HOTMART_OIDC_REDIRECT_URI` | Approved URL, e.g. `https://studio.example/api/hotmart?action=callback` |
| `HOTMART_SESSION_ENCRYPTION_KEY` | Random 32-byte key as 64 hex characters or base64 |
| `HOTMART_OIDC_SCOPES` | Optional approved scopes; default `openid profile email authorities user address offline_access` |
| `APP_ORIGINS` | Exact trusted application origins, including the callback's origin |
| `DATABASE_URL` | Existing restricted `grava_app` connection with owner RLS |

Generate an encryption key with `openssl rand -hex 32`. Keep this key stable across server instances; rotating it disconnects existing sessions. Administrative database credentials belong only to migration tooling.

After applying the recording-storage baseline, apply this feature's separate migration:

```sh
DATABASE_ADMIN_URL='<administrative connection>' node scripts/migrate-hotmart.mjs
```

The runner applies **only** `db/004_hotmart.sql`, verifies its checksum, and leaves unrelated migration files alone. It creates owner-isolated operation receipts for upload state and external-write deduplication. The normal app connection must not own the tables or bypass row security.

Vercel serves `api/hotmart.ts`. Vite serves the same authenticated handler locally, with no login bypass. No extra dependency, AI key, or video-relay server is required for this feature.

## Connection and data flow

1. Clerk authentication authorizes each control request. Connecting starts Hotmart's authorization-code flow with PKCE, state, and nonce. Sign-in uses a same-tab redirect because the studio's cross-origin isolation headers prevent dependable popup communication.
2. Hotmart's ID token is verified against its JWKS, issuer, audience, nonce, and optional access-token hash. Encrypted HttpOnly cookies hold the provider session; they are bound to the originating Clerk user. Provider credentials are not returned to browser JavaScript or stored in recording metadata. Refresh runs on the server if Hotmart issues a refresh token.
3. The browser returns to the same recording and reopens the dialog. Non-sensitive form drafts are scoped to the signed-in user and recording in session storage.
4. Course content uses `course → module → lesson`. A course may belong to a members area. Module creation uses an existing default student class; module ordering excludes extra modules. New products require a description of at least 200 characters and valid Hotmart pricing settings. Course creation remains distinct from Hotmart's approval and activation for sale.
5. The selected video goes through the same compatible MP4 preparation used by downloads. A cloud-only recording is first materialized through the existing private recording cache. Preparation can be interrupted; no download is triggered by publishing.
6. The server initializes private `PAGE_MEDIA` through the current Player API and creates the S3 multipart upload. It signs narrowly scoped part URLs; the browser transfers video bytes directly to Hotmart's S3 bucket. Video bytes never pass through a Vercel Function body. The upload config supports up to 20 GiB; local conversion limits still apply when conversion is needed.
7. The server completes S3 parts and notifies Hotmart in separate recorded steps. The browser polls processing status before asking the server to create a lesson. The uploaded file ID goes in `mediaIdList`; playback media codes are separate identifiers.
8. **Draft is the default.** Publication is a separate operation only when the creator explicitly selected publication in the dialog. The service disables student email notifications for that call. Success links back to the product through Hotmart's own login entry point.

## Retry and interruption behavior

Structural mutations and uploads have durable owner-bound receipts. Retrying an ambiguous request reuses its operation ID. An uploaded video's local receipt includes a digest of its actual contents, so a same-sized edited file cannot accidentally reuse an earlier upload.

Part transfers can retry safely and resume within the browser session. Interrupting stops preparation/transfers/polling and preserves the upload receipt; it does not delete a previously uploaded video or a created lesson. Retrying the same details continues the same job. Jobs are usable for 24 hours, and operation receipts remain for seven days to prevent uncertain writes being silently repeated. A server response that cannot be reconciled requires the creator to inspect Hotmart before starting a different operation.

The server stores S3 state and provider account identity internally; the browser sees an opaque job ID. A job cannot be resumed by another Clerk user or another connected Hotmart account. Atomic state transitions prevent a slow processing poll from replacing a completed result.

## Validation and limits

Automated coverage includes signed OIDC fixtures, session ownership, callback tampering, upload signing, multipart completion, course-context headers, explicit publication, delayed course creation, retry receipts, and native PostgreSQL RLS/concurrency checks. Browser fixtures exercise the publishing interface and actual browser client with controlled provider responses; they do not pretend to establish a real Hotmart login.

A live 3,565-byte private MP4 was initialized, transferred using a presigned S3 part URL, completed, and processed to `READY`. Its details reported `is_public:false`. The test video was then deleted and confirmed `DELETED`. S3 preflight also permits direct cross-origin PUT and exposes ETag. This verifies the media-transfer path with the supplied development session; it does not verify sign-in with a newly registered client or real course/lesson publication.

The earlier legacy upload-start API returned only a file ID and object key, without the media code expected by the current library flow. That initial experiment allocated an incomplete metadata record but uploaded no bytes. The product uses the modern Player upload path instead. The exact current private API and relevant source evidence are recorded in the gitignored `.context/hotmart-api/` research directory.

These publishing endpoints are undocumented first-party APIs. Hotmart may change them or restrict registered-client access. Real course creation, module edits, and student-visible publication still need an account-level acceptance run after registered login is configured. AI title/description suggestions remain deferred; editable metadata is ready for that later work.

Run the focused checks with:

```sh
node --test tests/hotmart-*.test.mjs
npx playwright test tests/hotmart-publish.spec.ts
```

Native database checks in `hotmart-repository.test.mjs` require an isolated `HOTMART_TEST_DATABASE_URL` (see its fixture instructions). Do not point them at a production database.
