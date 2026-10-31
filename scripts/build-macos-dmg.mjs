import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform !== 'darwin') throw new Error('The macOS DMG must be built on a macOS runner.');
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.MACOS_DMG_OUTPUT ?? join(root, 'dist/GravaSimples-macOS.dmg'));
const identity = process.env.MACOS_SIGNING_IDENTITY;
const shouldNotarize = Boolean(process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD);
if (!identity) throw new Error('Set MACOS_SIGNING_IDENTITY to a Developer ID Application identity.');
const temporary = mkdtempSync(join(tmpdir(), 'grava-dmg-'));
const packageRoot = join(temporary, 'package');
const extracted = join(temporary, 'extracted');
const app = join(packageRoot, 'GravaSimples Installer.app');
const resources = join(app, 'Contents', 'Resources');
const executable = join(app, 'Contents', 'MacOS', 'GravaSimples Installer');
const info = join(app, 'Contents', 'Info.plist');
const sourceZip = join(root, 'public/companion/gravasimples-macos.zip');

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

try {
  mkdirSync(resolve(output, '..'), { recursive: true });
  run('npm', ['run', 'build:companion']);
  if (!existsSync(sourceZip)) throw new Error(`Missing ${sourceZip}`);
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(extracted, { recursive: true });
  run('ditto', ['-x', '-k', sourceZip, extracted]);
  const payload = join(extracted, 'GravaSimples-macOS');
  if (!existsSync(payload)) throw new Error('The companion archive has no macOS payload.');
  mkdirSync(resources, { recursive: true });
  cpSync(payload, join(resources, 'payload'), { recursive: true });
  writeFileSync(info, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>GravaSimples Installer</string>
<key>CFBundleExecutable</key><string>GravaSimples Installer</string>
<key>CFBundleIdentifier</key><string>com.gravasimples.installer</string>
<key>CFBundleName</key><string>GravaSimples Installer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
`);
  writeFileSync(executable, `#!/bin/bash
set -euo pipefail
payload="$(cd "$(dirname "$0")/../Resources/payload" && pwd)"
if /bin/bash "$payload/Install.command" >/tmp/gravasimples-install.log 2>&1; then
  /usr/bin/osascript -e 'display dialog "GravaSimples foi instalado e inicia automaticamente quando você entra neste Mac." buttons {"OK"} with title "GravaSimples"'
else
  detail="$(/usr/bin/tail -c 1800 /tmp/gravasimples-install.log 2>/dev/null || true)"
  /usr/bin/osascript -e 'display dialog "Não foi possível concluir a instalação. Consulte o log em /tmp/gravasimples-install.log." buttons {"OK"} with title "GravaSimples" with icon stop'
  printf '%s\\n' "$detail" >&2
  exit 1
fi
`);
  chmodSync(executable, 0o755);
  run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, '--deep', app]);
  const staging = join(temporary, 'dmg');
  mkdirSync(staging, { recursive: true });
  cpSync(app, join(staging, 'GravaSimples Installer.app'), { recursive: true });
  writeFileSync(join(staging, 'LEIA-ME.txt'), 'Abra GravaSimples Installer.app para instalar o controle local.\nO receptor AirPlay aparece somente enquanto o estúdio estiver aberto.\n');
  const raw = `${output}.unsigned.dmg`;
  run('hdiutil', ['create', '-volname', 'GravaSimples', '-srcfolder', staging, '-format', 'UDZO', '-ov', raw]);
  run('codesign', ['--force', '--timestamp', '--sign', identity, raw]);
  if (shouldNotarize) {
    run('xcrun', ['notarytool', 'submit', raw, '--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD, '--wait']);
    run('xcrun', ['stapler', 'staple', raw]);
  }
  run('mv', [raw, output]);
  run('codesign', ['--verify', '--verbose=2', output]);
  console.log(`Created ${output}${shouldNotarize ? ' (notarized)' : ' (signed; notarization credentials were not supplied)'}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
