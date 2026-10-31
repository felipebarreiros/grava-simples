# OBS Blade control over local Wi-Fi

OBS Blade talks directly to a small native companion on the recording computer. The studio tab connects to that companion through loopback. All remote-control traffic stays on the computer and its local network; there is no remote-control API, Redis database or hosted relay. The website itself, authentication and optional recording storage remain hosted as before.

```text
iPhone / Android OBS Blade → same Wi-Fi → local companion ↔ studio browser tab
```

## One-time computer setup

Open **Celular** in the studio header and download the companion for **Mac** or **Windows**. Each ZIP includes the native executables, an installer and an uninstaller. No Node.js, Go, Docker, terminal commands or cloud settings are needed on the recording computer.

- **macOS:** extract the ZIP and open `Install.command`. The installer selects Apple Silicon or Intel, installs into the current user's Application Support directory, registers a user LaunchAgent and starts the companion. The installer opens Terminal to display its result; you do not type commands.
- **Windows:** extract the ZIP and open `Install.cmd`. It selects ARM64 or x64, installs into the current user's Local AppData directory, registers startup under that user's Run key and starts the companion. The installer uses the bundled PowerShell script without changing the machine's execution policy.

These development packages are unsigned. macOS Gatekeeper or Windows SmartScreen may require explicit approval before running them; no signing/notarization certificate has been configured. The installers do not remove quarantine flags, weaken global security policy or silently add firewall rules. Allow the helper on your **private/local network** if the operating system asks. School/corporate network isolation or firewall policy can still prevent phone-to-computer connections.

Allow the site's **local network / apps on this device** permission when Chrome asks. This one-time browser permission connects the website to the installed companion. After permission is granted, reopening the studio reconnects automatically. A blocked permission shows instructions to re-enable it in site settings; a missing companion shows download/install actions. See [Chrome Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access).

The helper starts at login on both platforms. No Chrome extension or Chrome Web Store installation is required. Initial qualification targets current desktop Chrome on Mac and Windows; other browsers must be tested separately.

## Pair OBS Blade once

1. Put the phone and computer on the same Wi-Fi network.
2. Open a project and prepare its camera/screen permissions on the computer.
3. Open **Celular**. The panel shows a local IP, port (normally `4455`) and password. If multiple local IPs are listed, choose the one reachable on the phone's Wi-Fi.
4. In OBS Blade, add a manual **IP** connection using those values. This is a local `ws://` connection; do not select secure `wss://`.
5. Save the connection in OBS Blade. Opening the studio later makes that saved connection available again without creating another password.

The companion keeps the pairing password in a private configuration file for the OS user. The browser holds it only in memory. A page reload or helper restart preserves the password. Changing the signed-in account or choosing **Redefinir pareamento** rotates it and disconnects previously paired phones. A router/address change may require updating the saved IP; it does not require another password unless pairing was reset.

Closing the panel preserves control. **Desconectar deste projeto** disables control for that open tab. Closing/leaving the studio releases its connection and disconnects the phone; the helper remains ready for the next studio tab. Only one project/tab can control a helper at a time, so opening another tab cannot silently steal the active recording.

## Supported controls

- Change the active scene.
- Show/hide individual layers, including repeated layers using the same capture source.
- Mute/unmute the active scene microphone.
- Start/stop **both** local recordings as one session.
- Read confirmed scene/input/recording state, with corresponding OBS events.

Capture permissions and physical device choices must be prepared on the computer. A remote command cannot grant a browser camera/screen permission. Phone or companion connection loss never calls the recording stop method. Reconnect to inspect the actual state before retrying an action.

Remote preview, recording pause, livestreaming, full source audio mixing, remote markers and an iPhone camera feed remain separate features. Unsupported requests return explicit OBS protocol errors. Browser render FPS is available; zero system CPU/RAM/disk and OBS encoder counters are placeholders, not performance qualification.

## Architecture and security

`companion/` is a small Go executable built for macOS ARM64/Intel and Windows ARM64/x64. It listens on local port `4455`. The phone endpoint `/` accepts private-network/loopback peers and performs standard OBS v5 challenge/password authentication. The browser endpoint `/studio` accepts only a loopback peer and an exact approved studio Origin. Arbitrary websites and LAN devices cannot obtain pairing credentials through that endpoint.

The browser runs the shared pure OBS protocol adapter in `src/remote/protocol.ts` and applies commands through the existing studio operations. Video, audio, captions and account session tokens are not sent to the helper. Private config defaults to `~/Library/Application Support/GravaSimples/pairing.json` on Mac and `%APPDATA%/GravaSimples/pairing.json` on Windows. Upgrade preserves that file; the uninstaller preserves pairing unless the user explicitly chooses otherwise.

Messages, pending requests and mutation receipts are bounded. Each forwarded request has an absolute execution deadline so a delayed message cannot start a recording after a frozen browser recovers. Recording finalization may complete after that execution deadline if it began on time. Requests succeed only after the browser confirms them. Phone reconnects reuse cached mutation results rather than replaying old recording commands; replacing/losing the desktop connection invalidates old pending requests.

The helper uses ping/pong liveness and checks browser state freshness. Local browser heartbeats continue during slow recording start/stop. There are no server credentials or Vercel environment variables to configure for this feature.

The helper's loopback Origin check trusts the first-party studio application. Its owner ID scopes local pairing behavior, not cloud authorization; no cloud reads/writes are authorized by that local ID.

Protocol references: [OBS WebSocket v5](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md), [OBS Blade](https://github.com/Kounex/obs_blade). Compatibility research used Blade source commit `418eb3ad2ca9c72622a936803a33c841c06a4927`.

## Build and validation

Developers need Go matching `companion/go.mod` to build the helper. End users do not.

```sh
npm run build:companion
npm run test:companion
node --test tests/obs-protocol.test.mjs tests/remote-client.test.mjs tests/remote-studio.test.mjs
# With Vite running; this test also needs the Go toolchain and independent FFmpeg tools:
npx playwright test tests/remote-control.spec.ts tests/obs-studio.spec.ts
```

`public/companion/` contains both installer ZIPs, a corresponding-source ZIP and a release manifest. Source and dependency licenses are included. GitHub Actions exercises native helper tests and executable startup on macOS, Windows and Linux. Cross-compiling alone does not count as a successful native test.

Browser integration exercises the actual native helper, automatic attachment, OBS authentication/commands, connection loss/recovery during a take, unchanged pairing after reload and independent decoding of both recorded files. Unit tests cover permission gating, origins, persistent pairing/account rotation, one active tab, deadlines, bounded queues and unsupported capabilities.

These checks do not establish physical iPhone/Android pairing on the user's Wi-Fi, browser-downloaded unsigned installer acceptance, sustained recording frame rate or one-hour recording qualification. Record those acceptance results before closing issue #8 completely.
