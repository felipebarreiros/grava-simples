import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'public/companion');
const source = path => readFileSync(resolve(root, path), 'utf8');
const manifestPath = resolve(directory, 'release.json');
const artifactsAvailable = existsSync(manifestPath);
const archiveEntries = path => execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
const archiveFile = (path, entry) => execFileSync('unzip', ['-p', path, entry], { maxBuffer: 20 * 1024 * 1024 });

test('installers register per-user startup, preserve pairing, and stop only their authenticated helper', () => {
  const mac = source('companion/install/macos/Install.command');
  const win = source('companion/install/windows/Install.ps1');
  assert.match(mac, /AGENT_DIR="\$HOME\/Library\/LaunchAgents"/);
  assert.match(mac, /AGENT_PATH="\$AGENT_DIR\/com\.gravasimples\.companion\.plist"/);
  assert.match(mac, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(mac, /<key>KeepAlive<\/key><true\/>/);
  assert.match(mac, /launchctl bootstrap/);
  assert.match(mac, /sysctl\.proc_translated/);
  assert.match(mac, /--stop --config "\$CONFIG_PATH"/);
  assert.match(win, /GetFolderPath\('LocalApplicationData'\)/);
  assert.match(win, /GetFolderPath\('ApplicationData'\)/);
  assert.match(win, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(win, /Start-Process/);
  assert.match(win, /--stop --config \$configPath/);
  for (const installer of [mac, win]) {
    assert.match(installer, /127\.0\.0\.1:4455\/health/);
    assert.doesNotMatch(installer, /killall|pkill|Stop-Process|Set-ExecutionPolicy|New-NetFirewallRule|netsh\s+advfirewall|spctl|xattr\s+-[a-zA-Z]*[dc]/i);
    assert.doesNotMatch(installer, /(?:Remove-Item|\/bin\/rm)\s+[^\n]*(?:CONFIG_PATH|configPath)/);
  }
  execFileSync('bash', ['-n', resolve(root, 'companion/install/macos/Install.command')]);
  execFileSync('bash', ['-n', resolve(root, 'companion/install/macos/Uninstall.command')]);
});

test('uninstallers remove only their own autostart entry and require explicit pairing deletion', () => {
  const mac = source('companion/install/macos/Uninstall.command');
  const win = source('companion/install/windows/Uninstall.ps1');
  assert.match(mac, /launchctl bootout/);
  assert.match(mac, /Excluir tambem o pareamento salvo\? \[s\/N\]/);
  assert.match(mac, /case "\$answer"/);
  assert.match(win, /param\(\[switch\]\$RemovePairing\)/);
  assert.match(win, /Remove-ItemProperty[^\n]*-Name 'GravaSimplesCompanion'/);
  assert.match(win, /if \(\$RemovePairing\)/);
  for (const uninstaller of [mac, win]) assert.doesNotMatch(uninstaller, /killall|pkill|Stop-Process|HKLM:|sudo|New-NetFirewallRule|Set-ExecutionPolicy/i);
});

test('native ZIP downloads include executable installers, complete source, and third-party licenses', { skip: !artifactsAvailable && 'Run npm run build:companion to verify distributable archives.' }, () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.license, 'GPL-2.0-or-later');
  assert.equal(manifest.minimumGoVersion, '1.26.8');
  assert.equal(manifest.signed, false);
  assert.equal(manifest.notarized, false);
  assert.deepEqual(manifest.artifacts.map(artifact => artifact.platform).sort(), ['macos', 'windows']);
  for (const artifact of manifest.artifacts) {
    const path = resolve(directory, artifact.url.split('/').at(-1));
    const bytes = readFileSync(path);
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    execFileSync('unzip', ['-tqq', path]);
    const entries = archiveEntries(path);
    const folder = artifact.platform === 'macos' ? 'GravaSimples-macOS' : 'GravaSimples-Windows';
    const install = artifact.platform === 'macos' ? 'Install.command' : 'Install.cmd';
    for (const name of [install, 'COPYING.txt', 'THIRD-PARTY-NOTICES.txt', 'LEIA-ME.txt', 'source/main.go', 'source/server.go', 'source/config.go', 'source/go.mod', 'source/go.sum', 'source/vendor/modules.txt', 'source/vendor/github.com/gorilla/websocket/LICENSE']) assert.ok(entries.includes(`${folder}/${name}`), `Missing ${name} in ${artifact.platform}`);
    assert.ok(entries.includes(`${folder}/source/build-tools/build-companion.mjs`));
    assert.doesNotMatch(entries.join('\n'), /(?:^|\/)(?:pairing\.json|\.env(?:\.|$)|auth\.json|node_modules)(?:\/|$)/m);
    assert.match(archiveFile(path, `${folder}/THIRD-PARTY-NOTICES.txt`).toString(), /Gorilla WebSocket \(BSD\)/);
    assert.match(archiveFile(path, `${folder}/THIRD-PARTY-NOTICES.txt`).toString(), /Go runtime \(BSD\)/);
  }
  const sourceArchive = resolve(directory, manifest.source.url.split('/').at(-1));
  assert.equal(createHash('sha256').update(readFileSync(sourceArchive)).digest('hex'), manifest.source.sha256);
  execFileSync('unzip', ['-tqq', sourceArchive]);
  if (manifest.macosDmg) {
    const dmg = resolve(directory, manifest.macosDmg.url.split('/').at(-1));
    const bytes = readFileSync(dmg);
    assert.equal(bytes.length, manifest.macosDmg.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.macosDmg.sha256);
  }
});

test('macOS and Windows artifacts have native arm64/x64 binary headers and Windows GUI subsystem', { skip: !artifactsAvailable && 'Native artifacts are generated by build:companion.' }, () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const artifact of manifest.artifacts) {
    assert.deepEqual(artifact.binaries.map(binary => binary.arch).sort(), ['amd64', 'arm64']);
    const path = resolve(directory, artifact.url.split('/').at(-1));
    const folder = artifact.platform === 'macos' ? 'GravaSimples-macOS' : 'GravaSimples-Windows';
    for (const binary of artifact.binaries) {
      const bytes = archiveFile(path, `${folder}/${binary.file}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), binary.sha256);
      if (artifact.platform === 'macos') {
        assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'Mach-O 64-bit signature');
        assert.equal(bytes.readUInt32LE(4), binary.arch === 'arm64' ? 0x0100000c : 0x01000007, 'Mach-O CPU architecture');
      } else {
        assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
        const pe = bytes.readUInt32LE(0x3c);
        assert.equal(bytes.readUInt32LE(pe), 0x00004550, 'PE signature');
        assert.equal(bytes.readUInt16LE(pe + 4), binary.arch === 'arm64' ? 0xaa64 : 0x8664, 'PE CPU architecture');
        assert.equal(bytes.readUInt16LE(pe + 24 + 68), 2, 'Helper runs as a Windows GUI program without an open terminal');
      }
    }
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    const linux = resolve(root, '.context/companion-build/bin/gravasimples-companion-linux-amd64');
    assert.equal(readFileSync(linux).subarray(0, 4).toString(), '\x7fELF');
    assert.equal(execFileSync(linux, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim(), manifest.version);
  }
});
