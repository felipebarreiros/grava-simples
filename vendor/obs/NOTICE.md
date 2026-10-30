This directory contains source from OBS Studio 33.0.1, commit
`65c320b46e1af5c7a555161aea6182cdf7a8c524`:
https://github.com/obsproject/obs-studio/tree/65c320b46e1af5c7a555161aea6182cdf7a8c524

OBS copyright notices remain in the original files. OBS is licensed under
GPL version 2 or any later version; see COPYING. The original vendored OBS
files are unmodified. The browser adapter was created on 2026-10-30 and is
in engine/obs-adapter.c. engine/obs-compressor-dsp.inc contains three unchanged
function bodies extracted from the supplied original compressor-filter.c;
native registration, sidechain and settings were excluded. Its storage and
entry points were adapted in obs-adapter.c on 2026-10-30.

deps/simde contains unmodified SIMDe 0.8.2 headers from commit
`71fd833d9666141edcd1d3c109a80e228303d8d7`:
https://github.com/simd-everywhere/simde/tree/71fd833d9666141edcd1d3c109a80e228303d8d7
SIMDe is MIT licensed; its copyright and license are in deps/simde/COPYING.

The OBS subset build script is scripts/build-obs-wasm.sh. Corresponding source
for the Wasm subset is delivered at /source/obs-wasm-source.tar.gz. The complete
combined application's corresponding source is delivered separately.
