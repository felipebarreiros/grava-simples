#!/usr/bin/env bash
# Reproduce the exploratory full-libobs boundary, separately from shipped subset.
set -euo pipefail
cd "$(dirname "$0")/.."
obs_commit=65c320b46e1af5c7a555161aea6182cdf7a8c524
obs_source="$PWD/.context/research/obs-studio"
mkdir -p .context/research .context/toolchains engine/build-logs
if [[ ! -d "$obs_source/.git" ]]; then
  git clone --depth 1 --branch 33.0.1 https://github.com/obsproject/obs-studio.git "$obs_source"
fi
if [[ "$(git -C "$obs_source" rev-parse HEAD)" != "$obs_commit" ]]; then
  echo "Expected pinned OBS commit $obs_commit" >&2
  exit 1
fi
git -C "$obs_source" submodule update --init --recursive

# Bootstrap the same compiler as the working subset.
bash scripts/build-obs-wasm.sh
export PATH="$PWD/.context/toolchains/python/cmake/data/bin:$PWD/.context/toolchains/python/bin:$PATH"
if ! command -v cmake >/dev/null 2>&1 || ! command -v ninja >/dev/null 2>&1; then
  python3 -m pip install --target .context/toolchains/python cmake==3.31.6 ninja==1.11.1.3
fi
export LD_LIBRARY_PATH="$PWD/.context/toolchains/libatomic/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
emcc="${EMCC:-$PWD/.context/toolchains/emsdk/upstream/emscripten/emcc}"
emcmake="$(dirname "$emcc")/emcmake"

if [[ ! -d .context/toolchains/ecm ]]; then
  curl -fLs https://download.kde.org/stable/frameworks/6.8/extra-cmake-modules-6.8.0.tar.xz -o .context/toolchains/ecm.tar.xz
  mkdir -p .context/toolchains/ecm
  tar -xf .context/toolchains/ecm.tar.xz -C .context/toolchains/ecm --strip-components=1
fi
"$emcmake" cmake -S .context/toolchains/ecm -B .context/toolchains/ecm-build-wasm -G Ninja \
  -DBUILD_TESTING=OFF -DBUILD_HTML_DOCS=OFF -DBUILD_MAN_DOCS=OFF -DBUILD_QTHELP_DOCS=OFF \
  -DCMAKE_INSTALL_PREFIX="$PWD/.context/toolchains/ecm-install" > engine/build-logs/ecm-configure.log 2>&1
cmake --install .context/toolchains/ecm-build-wasm > engine/build-logs/ecm-install.log 2>&1

set +e
"$emcmake" cmake -S "$obs_source" -B .context/build-obs-full-wasm -G Ninja \
  -DENABLE_FRONTEND=OFF -DENABLE_SCRIPTING=OFF -DENABLE_BROWSER=OFF -DENABLE_WEBSOCKET=OFF \
  -DENABLE_HEVC=OFF -DENABLE_VLC=OFF -DENABLE_PULSEAUDIO=OFF -DENABLE_WAYLAND=OFF \
  -DECM_DIR="$PWD/.context/toolchains/ecm-install/share/ECM/cmake" \
  -DSIMDe_INCLUDE_DIR="$PWD/vendor/obs/deps/simde" > engine/build-logs/libobs-configure-ecm.log 2>&1
configure_status=$?
set -e
echo "Full upstream configure exit status: $configure_status (see engine/build-logs/libobs-configure-ecm.log)"

# Probe unmodified scene compilation without stubbing any OBS API.
mkdir -p .context/toolchains/uthash .context/build-obs-scene-probe/config
curl -fLs https://raw.githubusercontent.com/troydhanson/uthash/v2.3.0/src/uthash.h -o .context/toolchains/uthash/uthash.h
cat > .context/build-obs-scene-probe/configure.cmake <<'CMAKE'
set(OBS_RELEASE_CANDIDATE 0)
set(OBS_BETA 0)
configure_file("${OBS_SOURCE}/libobs/obsconfig.h.in" "${OUTPUT}/obsconfig.h" @ONLY)
CMAKE
cmake -DOBS_SOURCE="$obs_source" -DOUTPUT="$PWD/.context/build-obs-scene-probe/config" \
  -P .context/build-obs-scene-probe/configure.cmake
"$emcc" -msimd128 -O2 -c -I"$obs_source/libobs" -Ivendor/obs/deps/simde \
  -I"$obs_source/deps/libcaption" -I.context/toolchains/uthash -I.context/build-obs-scene-probe/config \
  "$obs_source/libobs/obs-scene.c" -o .context/obs-scene-probe.o > engine/build-logs/scene-core-probe.log 2>&1
echo 'Unmodified obs-scene.c compiled successfully to a Wasm object.'

# These intentionally keep native backends intact, exposing missing integration.
set +e
"$emcc" .context/obs-scene-probe.o --no-entry -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS='["_obs_scene_create","_obs_sceneitem_set_pos","_obs_sceneitem_get_draw_transform"]' \
  -Wl,--error-limit=0 -o .context/obs-scene-link-probe.wasm > engine/build-logs/scene-link-probe.log 2>&1
echo "Scene-only link exit status: $? (expected unresolved actual OBS runtime; no stubs supplied)."
"$emcc" -msimd128 -fsyntax-only -I"$obs_source/libobs" -Ivendor/obs/deps/simde \
  -I"$obs_source/deps/glad/include" "$obs_source/libobs-opengl/gl-x11-egl.c" \
  > engine/build-logs/opengl-platform-probe.log 2>&1
echo "Native OpenGL platform probe exit status: $?"
"$emcc" -msimd128 -fsyntax-only -I"$obs_source/libobs" -Ivendor/obs/deps/simde \
  "$obs_source/plugins/linux-capture/xshm-input.c" > engine/build-logs/capture-platform-probe.log 2>&1
echo "Native capture platform probe exit status: $?"
exit 0
