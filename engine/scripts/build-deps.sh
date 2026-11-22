#!/usr/bin/env bash
# Build the WASM dependency set for one variant: ./build-deps.sh st|mt [extra cmake args]
source "$(dirname "$0")/common.sh"
variant="${1:?usage: build-deps.sh st|mt}"; shift || true
case "$variant" in st) threads=OFF;; mt) threads=ON;; *) echo "bad variant"; exit 2;; esac
fetch_orca
ensure_toolchain_image
in_toolchain "
  set -e
  emcmake cmake -S engine/deps -B /work/build-deps-$variant -G Ninja \
    -DWASM_THREADS=$threads -DDEPS_PREFIX=/work/deps-$variant \
    -DDEPS_DOWNLOAD_DIR=/work/dl -DORCA_SOURCE_DIR=/work/orca-src $*
  cmake --build /work/build-deps-$variant -j3 -- -k 0
"
