#!/usr/bin/env bash
# Checks that our libstdc++-compatibility helpers really reproduce libstdc++:
#  - native g++ (libstdc++): Portable*.hpp must match the real std:: behaviour;
#  - wasm (patched libc++): std::sort must match libstdc++ order (via PortableSort.hpp).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../../.." && pwd)"
inc="$root/.work/orca-patched/src/libslic3r"
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
for t in portable_random_test portable_sort_test portable_hash_order_test; do
  g++ -std=c++17 -O2 -I"$inc" "$here/$t.cpp" -o "$out/$t" && "$out/$t"
done
source "$root/engine/versions.env"
docker run --rm -v "$here:/t:ro" -v "$inc:/inc:ro" -v "$out:/o" -w /o "$TOOLCHAIN_IMAGE" \
  bash -c 'em++ -std=c++17 -O2 -I/inc /t/libcxx_sort_test.cpp -o libcxx_sort_test.js && node libcxx_sort_test.js'
