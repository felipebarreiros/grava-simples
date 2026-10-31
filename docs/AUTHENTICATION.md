# Authentication

GravaSimples uses `@clerk/react` with React Router in a client-rendered Vite app. The existing Clerk application is `app_3LQfZXySLRBTrfUH73j0rAU9Wgn`; connecting another checkout should link this application rather than create a new application with `clerk init`.

## Development configuration

Install dependencies with `npm ci`. Either copy `.env.example` to `.env.local` and supply the application's publishable key, or run:

```sh
npx -y clerk@latest auth login
npx -y clerk@latest link --app app_3LQfZXySLRBTrfUH73j0rAU9Wgn
npx -y clerk@latest env pull
npm run dev
```

`VITE_CLERK_PUBLISHABLE_KEY` is the only key consumed by the browser application. The recording-storage and transcription APIs independently verify sessions using `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`, with exact `APP_ORIGINS` and the configured Clerk issuer. Service credentials must never receive the `VITE_` prefix. Local environment files and Clerk link/claim files are excluded from Git and the downloadable source archive. The safe `.env.example` template is included in the source archive.

After changing environment configuration, restart the development server. Without a publishable key, the public home page remains available and application/account routes show an unavailable state; the studio does not become accessible.

## Routes and session behavior

The public home lives at `/`. `/login/*` and `/signup/*` mount Clerk's prebuilt components with path-based routing so verification and OAuth return URLs work when opened directly. `/password-recovery/*` uses Clerk's email-code reset flow, including code verification and a new password. The application's enabled authentication strategies determine whether that recovery method is available. Additional required verification remains with Clerk's sign-in flow.

`/app/*` waits for Clerk to load and confirm authentication before loading or mounting the recording studio. A signed-out visit redirects to `/login` and preserves the requested application destination. The existing `#project/<id>` navigation continues beneath `/app`. The `?test=1` media diagnostic option has no effect on authentication.

`/logout` signs out through Clerk and returns to the public home. A session change unmounts the studio, allowing its existing cleanup to release capture resources. The profile control provides Clerk account management.

Clerk's router callbacks wait for React Router to commit before resolving. Clerk
activates the new session after that promise resolves; resolving earlier can
leave the login page mounted and overwrite the requested project URL. The
password-recovery finalizer uses the same provider navigation bridge.

Clerk consumes development handshake parameters during startup. Guards read the
browser's cleaned location after authentication loads, and the router snapshot
is synchronized after Clerk's native history update. Return URLs retain normal
query parameters and project fragments without copying Clerk transport data.
New handshakes and external authentication destinations use document navigation.

The shared appearance starts from Clerk's dark theme and supplies the neutral,
foreground, input, primary, danger, and focus colors. It applies to the login and
signup forms, account popover, and profile/security dialogs. Scoped field styles
prevent generic studio input rules from overriding Clerk's contrast settings.

The storage and transcription APIs independently verify an explicit Clerk session bearer token. Cookie-only requests, expired or pending sessions, other issuers and unapproved application origins are rejected. Jobs and media upload grants belong to the verified account; browser-supplied user IDs never authorize requests. Supabase Postgres provides atomic shared quotas and forced row-level security. The restricted runtime login binds the verified user ID only inside a transaction; it cannot own tables, bypass RLS or assume a privileged role. Cleanup has a separate execute-only login. Client navigation guards are separate from API authorization. See [storage access controls](CLOUD_STORAGE.md) and [transcription setup](VERCEL_TRANSCRIPTION.md).

## Local projects and recordings

Project catalogues, scene assets, recording bytes, transcripts and markers use account-specific localStorage, IndexedDB and OPFS namespaces. Account changes unmount the studio and asynchronous operations reject cross-account completion. Logging out retains local files, while another account sees its own catalogue. These namespaces do not encrypt data against someone controlling the same browser profile. Old unscoped recordings remain unassigned until the creator explicitly imports them.

Optional cloud backup stores both original orientations in private Vercel Blob and their account-owned metadata in Supabase Postgres. Cloud access requires server authorization; Clerk does not store video files. Local-only recordings and authored scenes remain on the device. Browser cache eviction removes only freshly verified backed-up video copies; see [local and cloud storage](CLOUD_STORAGE.md).

## Hosting

1. Claim/configure the production Clerk instance and its domain in Clerk, and enable the desired sign-in methods there.
2. Set `VITE_CLERK_PUBLISHABLE_KEY` to that instance's production publishable key in the build environment before running `npm run build`.
3. Serve `dist/` with SPA fallback rewrites to `index.html` for `/login/*`, `/signup/*`, `/password-recovery/*`, `/logout`, `/app/*`, and other application paths. Serve real files directly, including `/source/*`, `/engine/*`, `/export/*`, fonts, and bundled assets.
4. Retain `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for cross-origin isolation used by local FFmpeg export. Authentication uses redirect-based OAuth rather than relying on popup opener access. Verify Clerk assets and enabled providers with the final host headers and domain.

Vite's development and preview servers already configure those isolation headers and SPA fallbacks. A static production host needs its own equivalent configuration. Changing a public environment variable after building does not change the bundled application; rebuild to apply a new publishable key.

Serve the HTML with `Cache-Control: no-cache`. If an open tab references a studio
chunk removed by a newer deployment, its loader automatically reloads once to
retrieve the current module graph. Repeated failures show the retry screen;
ordinary application errors and offline sessions do not trigger this recovery.

## Verification

Run `npm run build`, `npm test`, and the Playwright suite against the running app as described in [the test guide](../tests/README.md). Auth checks should cover signed-out access to the studio, public home availability, login/signup/recovery entry points, and the absence of an authentication bypass through media diagnostics. Signed-in checks should verify session persistence, studio entry, and loss of access after logout.

An existing Clerk application requires permission before creating test users. Automated auth-state simulations check route behavior but do not establish that email delivery, social providers, or real credentials work. Verify those with an authorized account in the configured application. Media and storage fixtures can test their modules independently of the account UI.

The opt-in real-SDK suite in `tests/auth-live.spec.ts` verifies fresh login,
handshake cleanup, project URL restoration, logout, rendered control contrast,
profile/security forms, and bounded recovery from retired production chunks.
See the private credential fixture and frozen-build commands in the
[test guide](../tests/README.md). Test transport values and passwords are excluded
from diagnostic attachments, traces, screenshots, and URL assertions.
