#!/usr/bin/env bash
# Build the engine for one variant: ./build-engine.sh st|mt [target]
source "$(dirname "$0")/common.sh"
variant="${1:?usage: build-engine.sh st|mt [target]}"; target="${2:-all}"
case "$variant" in st) threads=OFF;; mt) threads=ON;; *) echo "bad variant"; exit 2;; esac
"$ENGINE_DIR/scripts/prepare-orca.sh"
ensure_toolchain_image
in_toolchain "
  set -e
  emcmake cmake -S engine -B /work/build-engine-$variant -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DWASM_THREADS=$threads -DORCA_SOURCE_DIR=/work/orca-patched -DDEPS_PREFIX=/work/deps-$variant \
    -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache
  cmake --build /work/build-engine-$variant --target $target -- -k 0 -j\${ENGINE_JOBS:-6}
"
