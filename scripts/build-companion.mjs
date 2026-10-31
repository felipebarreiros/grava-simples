import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'companion');
const destination = join(root, 'public/companion');
const contextRoot = join(root, '.context');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const airplayBinary = process.env.AIRPLAY_BINARY ? resolve(process.env.AIRPLAY_BINARY) : '';
const airplayBundle = process.env.AIRPLAY_BUNDLE ? resolve(process.env.AIRPLAY_BUNDLE) : '';
const airplayLicense = process.env.AIRPLAY_LICENSE_FILE ? resolve(process.env.AIRPLAY_LICENSE_FILE) : '';
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid application version.');
if (!existsSync(join(sourceRoot, 'go.mod'))) throw new Error('The native companion Go module is missing.');
if (airplayBinary && !existsSync(airplayBinary)) throw new Error(`AIRPLAY_BINARY does not exist: ${airplayBinary}`);
if (airplayBundle && !existsSync(airplayBundle)) throw new Error(`AIRPLAY_BUNDLE does not exist: ${airplayBundle}`);
mkdirSync(destination, { recursive: true });
mkdirSync(contextRoot, { recursive: true });
const work = mkdtempSync(join(contextRoot, 'companion-package-'));
const source = join(work, 'GravaSimples-source');
const binaryDirectory = join(contextRoot, 'companion-build/bin');
mkdirSync(binaryDirectory, { recursive: true });

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source packages cannot contain symbolic links: ${path}`);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
function copy(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  chmodSync(targetPath, statSync(sourcePath).mode & 0o777);
}
function atomicFile(path, bytes) {
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

/** Standard ZIP with fixed timestamps, UTF-8 names, Unix modes and no external archive tool. */
function zip(directory, output) {
  const files = walk(directory), local = [], central = [];
  if (files.length > 65_535) throw new Error('Too many files for the companion ZIP.');
  let offset = 0;
  for (const path of files) {
    const name = Buffer.from(`${basename(directory)}/${relative(directory, path).split('\\').join('/')}`);
    const bytes = readFileSync(path), compressed = deflateRawSync(bytes, { level: 9 });
    const checksum = crc32(bytes), date = (20 << 9) | (1 << 5) | 1; // 2000-01-01, 00:00.
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((0o100000 | (statSync(path).mode & 0o777)) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  atomicFile(output, Buffer.concat([...local, directoryBytes, end]));
}

const readme = `GravaSimples - controle local com OBS Blade
Versao ${version}

INSTALAR UMA VEZ
Extraia este ZIP inteiro. No Mac, abra Install.command. No Windows, abra
Install.cmd. O instalador escolhe Apple Silicon/Intel ou Windows ARM64/x64.
O aplicativo e os instaladores sao nativos; nao e preciso instalar Node,
Go, Docker nem abrir um servidor manualmente.

Quando o pacote inclui o receptor AirPlay, ele aparece como GravaSimples
enquanto o estudio estiver aberto. No iPad, abra Central de Controle >
Espelhar Tela e escolha GravaSimples. Fechar o estudio encerra o receptor.

O pequeno aplicativo fica em segundo plano e inicia quando voce entra no
usuario. Abrir o estudio GravaSimples no Chrome conecta o controle local.
No primeiro uso, o Chrome ou o sistema podem pedir permissao de rede local.
Mantenha o computador e o celular na mesma rede Wi-Fi e use os dados de
conexao apresentados no estudio. Nao encaminhe a porta 4455 no roteador.

INSTALACAO POR USUARIO
Mac: ~/Library/Application Support/GravaSimples e LaunchAgent
~/Library/LaunchAgents/com.gravasimples.companion.plist.
Windows: %LocalAppData%/GravaSimples e inicializacao HKCU/Run.
O pareamento Windows fica em %AppData%/GravaSimples/pairing.json.
Atualizar o aplicativo preserva o pareamento existente.
As configuracoes e gravações do navegador nao sao movidas pelo instalador.

REMOVER
Abra Uninstall.command ou Uninstall.cmd. A inicializacao automatica e o
aplicativo sao removidos. O pareamento so e excluido se voce confirmar.
No Windows os pequenos scripts de desinstalacao podem permanecer na pasta.

APROVACAO DO SISTEMA
Estes pacotes ainda nao possuem assinatura de desenvolvedor/notarizacao.
O macOS pode bloquear o instalador ou executavel; somente prossiga se voce
confiar nesta origem, usando a aprovacao exibida em Privacidade e Seguranca.
O Windows pode apresentar SmartScreen. Instalacao bloqueada por politica de
uma organizacao requer suporte do administrador. Os instaladores nao removem
quarentena, nao desabilitam Gatekeeper e nao criam regras de firewall.
O arquivo .cmd usa uma politica PowerShell apenas para aquele processo;
nao altera a politica do Windows de forma permanente.

CODIGO-FONTE E LICENCAS
GravaSimples: GPL v2 ou posterior; veja COPYING.txt.
Gorilla WebSocket: BSD; veja THIRD-PARTY-NOTICES.txt e source/vendor.
Se o receptor AirPlay estiver incluido, consulte airplay/LICENSE.txt e o
codigo correspondente fornecido na release de origem.
O codigo Go completo e a dependencia vendorizada estao em source/.
Para compilar a partir de source/, use Go 1.26.8 ou posterior:
  go build -mod=vendor -trimpath -buildvcs=false -o gravasimples-companion .
Para reproduzir estes pacotes no repositorio, com Node 24 e Go 1.26.8:
  node scripts/build-companion.mjs

Testes automatizados e compilacao cruzada nao substituem a validacao real
da instalacao, firewall e OBS Blade em cada Mac/Windows/iPhone/Android.
`;

try {
  mkdirSync(source, { recursive: true });
  // Include buildable source only, never a user's pairing/configuration JSON.
  for (const path of walk(sourceRoot)) {
    const name = relative(sourceRoot, path);
    if (/\.go$/.test(name) || ['go.mod', 'go.sum'].includes(name)) copy(path, join(source, name));
  }
  for (const path of walk(join(sourceRoot, 'install'))) copy(path, join(source, 'install', relative(join(sourceRoot, 'install'), path)));
  copy(import.meta.filename, join(source, 'build-tools/build-companion.mjs'));
  const goEnv = { ...process.env, CGO_ENABLED: '0', GOMAXPROCS: '2' };
  await run('go', ['mod', 'vendor'], { cwd: source, env: goEnv, maxBuffer: 2 * 1024 * 1024 });
  copy(join(root, 'COPYING'), join(source, 'COPYING.txt'));
  const gorillaLicense = join(source, 'vendor/github.com/gorilla/websocket/LICENSE');
  if (!existsSync(gorillaLicense)) throw new Error('Gorilla WebSocket license is missing from vendored source.');
  const { stdout: goRoot } = await run('go', ['env', 'GOROOT'], { cwd: source, env: goEnv });
  const goLicense = [join(goRoot.trim(), 'LICENSE'), '/usr/share/licenses/golang/LICENSE'].find(existsSync);
  if (!goLicense) throw new Error('The Go distribution license is missing. Install its license before packaging.');
  const notices = `GravaSimples companion: GPL-2.0-or-later.\n\n=== Gorilla WebSocket (BSD) ===\n${readFileSync(gorillaLicense, 'utf8')}\n\n=== Go runtime (BSD) ===\n${readFileSync(goLicense, 'utf8')}`;
  writeFileSync(join(source, 'THIRD-PARTY-NOTICES.txt'), notices);
  writeFileSync(join(source, 'BUILD.txt'), 'Requires Go 1.26.8 or later.\nRun go build -mod=vendor -trimpath -buildvcs=false -o gravasimples-companion .\nSource is GPL-2.0-or-later; preserve bundled third-party notices.\n');
  zip(source, join(destination, 'companion-source.zip'));

  const targets = [
    { os: 'darwin', arch: 'arm64', name: 'gravasimples-companion-darwin-arm64' },
    { os: 'darwin', arch: 'amd64', name: 'gravasimples-companion-darwin-amd64' },
    { os: 'windows', arch: 'arm64', name: 'GravaSimplesCompanion-windows-arm64.exe' },
    { os: 'windows', arch: 'amd64', name: 'GravaSimplesCompanion-windows-amd64.exe' },
    { os: 'linux', arch: 'amd64', name: 'gravasimples-companion-linux-amd64' },
  ];
  let nextTarget = 0;
  await Promise.all([0, 1].map(async () => {
    while (nextTarget < targets.length) {
      const target = targets[nextTarget++];
      const output = join(binaryDirectory, target.name);
      const ldflags = `-s -w -buildid= -X main.version=${version}${target.os === 'windows' ? ' -H=windowsgui' : ''}`;
      await run('go', ['build', '-p', '2', '-mod=vendor', '-trimpath', '-buildvcs=false', '-ldflags', ldflags, '-o', `${output}.tmp`, '.'], {
        cwd: source, env: { ...goEnv, GOOS: target.os, GOARCH: target.arch }, maxBuffer: 2 * 1024 * 1024,
      });
      renameSync(`${output}.tmp`, output); chmodSync(output, 0o755);
      console.log(`Built ${target.os}/${target.arch}`);
    }
  }));

  const artifacts = [];
  for (const [platform, os, title] of [['macos', 'darwin', 'GravaSimples-macOS'], ['windows', 'windows', 'GravaSimples-Windows']]) {
    const packageDirectory = join(work, title);
    mkdirSync(packageDirectory, { recursive: true });
    for (const file of walk(join(sourceRoot, 'install', platform))) copy(file, join(packageDirectory, basename(file)));
    const binaries = [];
    for (const target of targets.filter(target => target.os === os)) {
      const path = join(binaryDirectory, target.name);
      copy(path, join(packageDirectory, 'binaries', target.name));
      binaries.push({ arch: target.arch, file: `binaries/${target.name}`, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
    const airplayForPlatform = ((platform === 'macos' && os === 'darwin') || (platform === 'windows' && os === 'windows')) && (airplayBinary || airplayBundle);
    if (airplayForPlatform && airplayBundle) {
      cpSync(airplayBundle, join(packageDirectory, 'airplay', basename(airplayBundle)), { recursive: true });
    } else if (airplayForPlatform && airplayBinary) {
      const name = platform === 'windows' ? 'uxplay.exe' : 'uxplay';
      copy(airplayBinary, join(packageDirectory, 'airplay', name));
      if (airplayLicense && existsSync(airplayLicense)) copy(airplayLicense, join(packageDirectory, 'airplay', 'LICENSE.txt'));
    }
    for (const file of walk(source)) copy(file, join(packageDirectory, 'source', relative(source, file)));
    copy(join(root, 'COPYING'), join(packageDirectory, 'COPYING.txt'));
    writeFileSync(join(packageDirectory, 'THIRD-PARTY-NOTICES.txt'), notices);
    writeFileSync(join(packageDirectory, 'LEIA-ME.txt'), readme);
    const filename = `gravasimples-${platform}.zip`, output = join(destination, filename);
    zip(packageDirectory, output);
    const bytes = readFileSync(output);
    artifacts.push({ platform, url: `/companion/${filename}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), binaries, airplay: Boolean(airplayForPlatform) });
  }
  const sourceArchive = readFileSync(join(destination, 'companion-source.zip'));
  const { stdout: goVersion } = await run('go', ['version']);
  atomicFile(join(destination, 'release.json'), `${JSON.stringify({
    version, license: 'GPL-2.0-or-later', signed: false, notarized: false,
    compiler: goVersion.trim(), minimumGoVersion: '1.26.8',
    source: { url: '/companion/companion-source.zip', sha256: createHash('sha256').update(sourceArchive).digest('hex') }, artifacts,
  }, null, 2)}\n`);
  console.log('Packaged native macOS/Windows companions, corresponding source and licenses.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
