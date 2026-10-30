import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = process.env.FFMPEG_SOURCE ?? resolve(root, '.context/research/ffmpeg-export-source');
const staging = mkdtempSync(resolve(tmpdir(), 'grava-export-source-'));
try {
  mkdirSync(resolve(staging, 'FFmpeg'));
  execFileSync('git', ['archive', '--format=tar', '--output', resolve(staging, 'ffmpeg.tar'), '4729204c17f756e186d622060088371d10b34f7e'], { cwd: source });
  execFileSync('tar', ['-xf', resolve(staging, 'ffmpeg.tar'), '-C', resolve(staging, 'FFmpeg')]);
  rmSync(resolve(staging, 'ffmpeg.tar'));
  mkdirSync(resolve(staging, 'scripts'));
  mkdirSync(resolve(staging, 'vendor'));
  cpSync(resolve(root, 'vendor/export'), resolve(staging, 'vendor/export'), { recursive: true });
  cpSync(resolve(root, 'scripts/build-export-wasm.sh'), resolve(staging, 'scripts/build-export-wasm.sh'));
  writeFileSync(resolve(staging, 'README.md'), `# GravaSimples local MP4 export corresponding source\n\nFFmpeg n5.1.4, commit 4729204c17f756e186d622060088371d10b34f7e.\nThe FFmpeg CLI modifications and JS bindings come from ffmpegwasm/ffmpeg.wasm v0.12.10, commit c3a763857c5e615ae8674715ad5e4f63ff469e9d, in vendor/export.\nNo external codec libraries; runtime is LGPL2.1-or-later.\n\nInstall Emscripten4.0.18, Node, GNU make and a shell, then run:\n\n\`\`\`sh\nFFMPEG_SOURCE="$PWD/FFmpeg" EMCC=/path/to/emsdk/upstream/emscripten/emcc bash scripts/build-export-wasm.sh\n\`\`\`\n\nThe output in public/export is the same optional worker core used by the application. Replace these JS/Wasm files to use a modified runtime. The application does not verify or lock their signatures.\n`);
  const destination = resolve(root, 'public/source');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-czf', resolve(destination, 'ffmpeg-export-source.tar.gz'), 'FFmpeg', 'vendor', 'scripts', 'README.md'], { cwd: staging });
  const wasm = readFileSync(resolve(root, 'public/export/ffmpeg-core.wasm'));
  writeFileSync(resolve(root, 'public/export/provenance.json'), JSON.stringify({ name: 'grava-simples-aac-export', ffmpegVersion: '5.1.4', ffmpegCommit: '4729204c17f756e186d622060088371d10b34f7e', ffmpegWasmCommit: 'c3a763857c5e615ae8674715ad5e4f63ff469e9d', license: 'LGPL-2.1-or-later', emscriptenVersion: '4.0.18', codecs: { copy: 'h264', decode: ['aac', 'opus'], encode: ['aac'] }, source: '/source/ffmpeg-export-source.tar.gz', wasmSha256: createHash('sha256').update(wasm).digest('hex') }, null, 2) + '\n');
  console.log('Packaged matching AAC export runtime source and build scripts.');
} finally { rmSync(staging, { recursive: true, force: true }); }
