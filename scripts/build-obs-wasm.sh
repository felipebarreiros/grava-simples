#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -d "$PWD/.context/toolchains/libatomic/usr/lib/x86_64-linux-gnu" ]]; then
  export LD_LIBRARY_PATH="$PWD/.context/toolchains/libatomic/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# Reproducible compiler: Emscripten 4.0.18 (LLVM/Wasm), OBS 33.0.1.
# An installed emcc may be supplied with EMCC. Otherwise bootstrap locally.
if [[ -n "${EMCC:-}" ]]; then
  compiler="$EMCC"
elif command -v emcc >/dev/null 2>&1; then
  compiler="$(command -v emcc)"
else
  sdk="$PWD/.context/toolchains/emsdk"
  if [[ ! -x "$sdk/upstream/emscripten/emcc" ]]; then
    mkdir -p .context/toolchains
    if [[ ! -d "$sdk/.git" ]]; then
      git clone --depth 1 --branch 4.0.18 https://github.com/emscripten-core/emsdk.git "$sdk"
    fi
    "$sdk/emsdk" install 4.0.18
    "$sdk/emsdk" activate 4.0.18
  fi
  compiler="$sdk/upstream/emscripten/emcc"
fi

# The provided minimal Linux sandbox omits Binaryen's libatomic dependency.
# Keep the host untouched: use a pinned, hash-checked local runtime package.
binaryen="$(dirname "$compiler")/../bin/wasm-opt"
if [[ -x "$binaryen" ]] && ! "$binaryen" --version >/dev/null 2>&1; then
  if [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]; then
    atomic_package="$PWD/.context/toolchains/libatomic.deb"
    mkdir -p .context/toolchains
    curl -fLs 'https://deb.debian.org/debian/pool/main/g/gcc-12/libatomic1_12.2.0-14+deb12u1_amd64.deb' -o "$atomic_package"
    python3 - "$atomic_package" <<'PY'
import hashlib, io, sys, tarfile
from pathlib import Path
data = Path(sys.argv[1]).read_bytes()
expected = 'fbd4e154a6b444229ea002cc209df099209c0adc09102e5fd21239a3d2b55e2d'
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit('Unexpected libatomic runtime package hash')
position = 8
while position < len(data):
    name = data[position:position+16].decode().strip().rstrip('/')
    size = int(data[position+48:position+58])
    content = data[position+60:position+60+size]
    if name.startswith('data.tar'):
        with tarfile.open(fileobj=io.BytesIO(content)) as archive:
            archive.extractall('.context/toolchains/libatomic')
    position += 60 + size + size % 2
PY
    export LD_LIBRARY_PATH="$PWD/.context/toolchains/libatomic/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    "$binaryen" --version >/dev/null
  else
    echo 'Binaryen could not start. Install its required host runtime libraries.' >&2
    exit 1
  fi
fi

if [[ "$($compiler --version | head -1)" != *'4.0.18'* ]]; then
  echo 'This build is pinned to Emscripten 4.0.18. Set EMCC to that compiler.' >&2
  exit 1
fi

mkdir -p public/engine public/source
"$compiler" -O3 -msimd128 \
  -Ivendor/obs/libobs -Ivendor/obs/deps/simde \
  engine/obs-adapter.c \
  vendor/obs/libobs/graphics/matrix4.c \
  vendor/obs/libobs/graphics/vec3.c \
  vendor/obs/libobs/graphics/vec4.c \
  vendor/obs/libobs/graphics/quat.c \
  vendor/obs/libobs/graphics/axisang.c \
  --no-entry -s STANDALONE_WASM=1 -s FILESYSTEM=0 \
  -s INITIAL_MEMORY=2097152 -s STACK_SIZE=65536 \
  -s EXPORTED_FUNCTIONS='["_obs_layout","_obs_audio_gain_db","_obs_audio_buffer","_obs_compressor_config","_obs_compressor_process"]' \
  -Wl,--strip-debug -o public/engine/obs-core.wasm

cp engine/obs-audio-worklet.js public/engine/obs-audio-worklet.js
cp vendor/obs/COPYING public/source/OBS-COPYING.txt
# Complete corresponding source for this binary, including all third-party
# headers, adapted DSP, JS host/worklet, build script and notices.
tar --exclude='engine/build-logs' -czf public/source/obs-wasm-source.tar.gz \
  engine vendor/obs scripts/build-obs-wasm.sh scripts/build-obs-wasm.probe.sh
node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = createHash('sha256').update(readFileSync('public/engine/obs-core.wasm')).digest('hex');
const manifest = JSON.parse(readFileSync('engine/capabilities.json', 'utf8'));
manifest.wasmSha256 = hash;
writeFileSync('public/engine/capabilities.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built OBS source subset: ${hash}`);
JS
