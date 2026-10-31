# iPad screen mirroring

The local companion owns the AirPlay receiver lifecycle. It starts the receiver only after a GravaSimples studio tab acquires the loopback lease, and stops it when that tab disconnects. The receiver therefore does not advertise a GravaSimples target while the website is closed.

The receiver is a separate process from the Go companion. It opens a native window for the mirrored iPad screen. The browser cannot silently select a native window through `getDisplayMedia`, so the user chooses that window once as the studio's screen source. iPad Notes, whiteboards and other unprotected apps appear as rendered pixels; Apple Pencil events are not exposed as editable input. Protected video can refuse mirroring.

## Runtime

The selected receiver must support AirPlay legacy mirroring on both macOS and Windows, render a native window, and carry its runtime libraries and third-party notices. The current process manager accepts a packaged executable through `--airplay-bin`; the installer places it under the per-user GravaSimples application directory. `AIRPLAY_BINARY` and `AIRPLAY_LICENSE_FILE` are used by `scripts/build-companion.mjs` when producing platform packages.

The current upstream candidate is [UxPlay](https://github.com/FDH2/UxPlay), which supports macOS and Windows and is GPL-3. Its GStreamer runtime must be packaged with the executable; copying only `uxplay` is insufficient. The release job must therefore build and bundle the matching runtime libraries/plugins and corresponding source/notices before publishing an AirPlay-enabled installer.

## Mac distribution

`npm run build:macos-dmg` is macOS-only. It builds the companion package, creates a one-click `GravaSimples Installer.app` inside a DMG, signs the app and DMG with `MACOS_SIGNING_IDENTITY`, and optionally submits/staples the DMG when `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_SPECIFIC_PASSWORD` are present. The installer installs the helper and AirPlay runtime into the current user's Application Support directory and registers the existing user LaunchAgent.

The DMG workflow must be run on a macOS runner with the Developer ID certificate and notarization credentials held in CI secrets. The repository never stores those credentials.
