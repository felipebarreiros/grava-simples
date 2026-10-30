import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'public/source');
mkdirSync(destination, { recursive: true });
const license = readFileSync(resolve(root, 'vendor/obs/COPYING'), 'utf8');
writeFileSync(resolve(root, 'COPYING'), license);
writeFileSync(resolve(destination, 'COPYING.txt'), license);
const notices = ['GravaSimples recording experiment\n\nApplication and OBS-derived code: GPL version 2 or later. See COPYING.txt.\nOBS source provenance and adaptation details: vendor/obs/NOTICE.md in the source archive.\n'];
for (const dependency of ['react', 'react-dom', 'scheduler', 'lucide-react', 'clsx']) {
  const path = resolve(root, `node_modules/${dependency}/LICENSE`);
  if (existsSync(path)) notices.push(`\n=== ${dependency} ===\n${readFileSync(path, 'utf8')}`);
}
for (const scope of ['@radix-ui', '@floating-ui', '@dnd-kit', '@clerk', '@upstash', '@vercel']) {
  const directory = resolve(root, 'node_modules', scope);
  if (existsSync(directory)) for (const dependency of readdirSync(directory)) {
    const path = resolve(directory, dependency, 'LICENSE');
    if (existsSync(path)) notices.push(`\n=== ${scope}/${dependency} ===\n${readFileSync(path, 'utf8')}`);
  }
}
for (const dependency of ['aria-hidden', 'react-remove-scroll', 'react-remove-scroll-bar', 'react-style-singleton', 'use-sidecar', 'use-callback-ref', 'get-nonce', 'detect-node-es', 'tslib', 'react-router', 'react-router-dom']) {
  const directory = resolve(root, 'node_modules', dependency);
  if (!existsSync(directory)) continue;
  const license = readdirSync(directory).find(name => /^licen[cs]e(?:\.|$)/i.test(name));
  if (license) notices.push(`\n=== ${dependency} ===\n${readFileSync(resolve(directory, license), 'utf8')}`);
}
const shadcnLicense = resolve(root, 'vendor/ui/SHADCN-LICENSE.txt');
if (existsSync(shadcnLicense)) notices.push(`\n=== shadcn/ui component sources (MIT, CSS adaptation) ===\n${readFileSync(shadcnLicense, 'utf8')}`);
const simdeLicense = resolve(root, 'vendor/obs/deps/simde/COPYING');
if (existsSync(simdeLicense)) notices.push(`\n=== SIMDe ===\n${readFileSync(simdeLicense, 'utf8')}`);
const fontLicense = resolve(root, 'public/fonts/OFL-DM-Sans.txt');
if (existsSync(fontLicense)) notices.push(`\n=== DM Sans (SIL Open Font License) ===\n${readFileSync(fontLicense, 'utf8')}`);
const exportLicense = resolve(root, 'public/export/COPYING.LGPLv2.1.txt');
if (existsSync(exportLicense)) notices.push(`\n=== FFmpeg minimal local AAC export (LGPL2.1-or-later) ===\nCorresponding source: /source/ffmpeg-export-source.tar.gz\n${readFileSync(exportLicense, 'utf8')}`);
const exportWrapperLicense = resolve(root, 'vendor/export/FFMPEGWASM-LICENSE');
if (existsSync(exportWrapperLicense)) notices.push(`\n=== ffmpeg.wasm wrapper (MIT) ===\n${readFileSync(exportWrapperLicense, 'utf8')}`);
writeFileSync(resolve(destination, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const entries = ['COPYING', 'README.md', '.env.example', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.server.json', 'vercel.json', 'vite.config.ts', 'playwright.config.ts', 'src', 'api', 'server', 'engine', 'vendor', 'scripts', 'tests', 'docs', 'public/engine', 'public/export', 'public/source/ffmpeg-export-source.tar.gz', 'public/fonts', 'public/scenes', 'public/favicon.svg', 'public/source/THIRD-PARTY-NOTICES.txt'].filter(entry => existsSync(resolve(root, entry)));
const archive = resolve(destination, 'grava-simples-source.tar.gz');
execFileSync('tar', ['--exclude=engine/build-logs', '--exclude=*.webm', '--exclude=*.mp4', '-czf', archive + '.tmp', ...entries], { cwd: root });
renameSync(archive + '.tmp', archive);
const hash = createHash('sha256').update(readFileSync(resolve(root, 'public/engine/obs-core.wasm'))).digest('hex');
writeFileSync(resolve(destination, 'release.json'), JSON.stringify({
  application: 'grava-simples-experiment',
  applicationVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  obsVersion: '33.0.1',
  obsCommit: '65c320b46e1af5c7a555161aea6182cdf7a8c524',
  license: 'GPL-2.0-or-later',
  engine: 'obs-wasm-subset',
  fullLibobsRuntime: false,
  wasmSha256: hash,
  sourceArchive: '/source/grava-simples-source.tar.gz',
  notices: '/source/THIRD-PARTY-NOTICES.txt',
}, null, 2) + '\n');
console.log('Packaged version-matched application and OBS component sources.');
