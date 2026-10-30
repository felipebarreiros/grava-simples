#!/usr/bin/env bash
# Minimal local MP4 export: copy H.264 video, normalize container, encode AAC.
# No external codec libraries. Emscripten4.0.18, FFmpeg5.1.4, LGPL2.1+.
set -euo pipefail
cd "$(dirname "$0")/.."
task_root="$PWD"
compiler="${EMCC:-$task_root/.context/toolchains/emsdk/upstream/emscripten/emcc}"
export PATH="$(dirname "$compiler"):$PATH"
if [[ -d "$task_root/.context/toolchains/libatomic/usr/lib/x86_64-linux-gnu" ]]; then
  export LD_LIBRARY_PATH="$task_root/.context/toolchains/libatomic/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
source_dir="${FFMPEG_SOURCE:-$task_root/.context/research/ffmpeg-export-source}"
if [[ ! -f "$source_dir/configure" ]]; then
  mkdir -p "$(dirname "$source_dir")"
  git clone --depth 1 --branch n5.1.4 https://github.com/FFmpeg/FFmpeg.git "$source_dir"
fi
build_dir="$task_root/.context/build-ffmpeg-export"
mkdir -p "$build_dir" "$task_root/public/export"
cd "$build_dir"
if [[ "${SKIP_CONFIGURE:-0}" != 1 ]]; then
"$source_dir/configure" --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-stripping --disable-programs --disable-doc --disable-debug \
  --disable-runtime-cpudetect --disable-autodetect --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-everything --disable-network --disable-gpl --disable-nonfree --disable-postproc \
  --enable-avcodec --enable-avformat --enable-avfilter --enable-avdevice --enable-swresample --enable-swscale \
  --enable-decoder=opus,aac --enable-encoder=aac --enable-demuxer=mov,matroska --enable-muxer=mp4 \
  --enable-parser=opus,aac,h264 --enable-protocol=file --enable-filter=aresample,aformat,anull \
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
  --extra-cflags='-O3 -Wno-incompatible-function-pointer-types' > configure.log
fi
make -j"${JOBS:-4}" > make.log 2>&1
mkdir -p src
cp -R "$task_root/vendor/export/ffmpegwasm-src/fftools" src/
cp -R "$task_root/vendor/export/ffmpegwasm-src/bind" src/
"$compiler" -O3 -I. -I"$source_dir" -Isrc/fftools \
  src/fftools/cmdutils.c src/fftools/ffmpeg.c src/fftools/ffmpeg_filter.c src/fftools/ffmpeg_hw.c \
  src/fftools/ffmpeg_mux.c src/fftools/ffmpeg_opt.c src/fftools/opt_common.c \
  -Wno-deprecated-declarations -Wno-incompatible-function-pointer-types \
  -Llibavcodec -Llibavdevice -Llibavfilter -Llibavformat -Llibavutil -Llibswresample -Llibswscale \
  -lavdevice -lavfilter -lavformat -lavcodec -lswresample -lswscale -lavutil \
  -sWASM_BIGINT -sMODULARIZE -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH \
  -sEXPORT_NAME=createFFmpegCore -sEXPORT_ES6 -sENVIRONMENT=worker \
  -sEXPORTED_FUNCTIONS="$(node src/bind/ffmpeg/export.js)" \
  -sEXPORTED_RUNTIME_METHODS="$(node src/bind/ffmpeg/export-runtime.js)" \
  -lworkerfs.js --pre-js src/bind/ffmpeg/bind.js \
  -o "$task_root/public/export/ffmpeg-core.js" > link.log 2>&1
cd "$task_root"
cp "$source_dir/COPYING.LGPLv2.1" public/export/COPYING.LGPLv2.1.txt
cp vendor/export/FFMPEGWASM-LICENSE public/export/FFMPEGWASM-LICENSE.txt
node -e 'console.log("Built minimal local AAC export runtime")'
