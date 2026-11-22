# Patch index

All changes to third-party source, one concern per patch. Orca patches are `git format-patch`
files applied with `git am` by `engine/scripts/prepare-orca.sh` onto the pinned tag
(`engine/versions.env`). Dependency patches are applied by the superbuild (`engine/deps`).

To edit the Orca series:
1. Run `engine/scripts/prepare-orca.sh`.
2. Edit and commit in `.work/orca-patched`.
3. Run `engine/scripts/export-orca-patches.sh`.

## OrcaSlicer v2.5.0 (`engine/patches/orca/`)

| # | Patch | Why | Upstreamable | Credit |
|---|-------|-----|--------------|--------|
| 0001 | libslic3r: optional OpenCASCADE (`SLIC3R_NO_OCCT`) | Build libslic3r without OCCT. STEP import moves to a separate lazily loaded module. | Yes (opt-in) | — |
| 0002 | Platform: recognise Emscripten/WebAssembly | `detect_platform()` hit a `static_assert` on unknown platforms. Reports `Unknown`. | Yes | Same idea as OrcaWeb `apply.py` §5 |
| 0003 | SLA/Hollowing: build without OpenVDB (`SLIC3R_NO_OPENVDB`) | `Hollowing.cpp` is always compiled but needs OpenVDB. SLA hollowing now raises an error instead; FFF is unaffected. | Yes | OrcaWeb replaced the whole file with stubs; ours is a guarded patch |
| 0004 | Thread: no thread names under Emscripten | Emscripten has no `pthread_setname_np`/`getname_np`, which broke the link. Naming is diagnostics only. | Yes | Same issue as OrcaWeb `apply.py` §8g |
| 0005 | Use portable random distributions so seeded results match on all platforms | `std::` distributions and `std::shuffle` are implementation-defined. Mirrored monotonic fill, different seam samples and decimation order. Adds `PortableRandom.hpp` (exact libstdc++ algorithms). | Yes | — |
| 0006 | BridgeDetector: order tied bridge directions the same on all platforms | `std::sort` tie order is implementation-defined. Adds `PortableSort.hpp` (exact libstdc++ introsort). | Yes | — |
| 0007 | detect_bridging_direction: platform-independent order of candidate directions | `unordered_map` iteration order picked the bridge direction on ties. Adds `PortableHashOrder.hpp` (exact libstdc++ order for `double` keys). | Yes (a plain deterministic tie-break may suit upstream better) | — |
| 0008 | Arachne: `interpolate()` must not depend on the width of `size_t` | `coord_t(v.size() - 1)` on an empty vector is −1 with a 64-bit `size_t` but 2³²−1 on wasm32, so `SkeletalTrapezoidation::interpolate` indexed far out of bounds ("memory access out of bounds" on a finely tessellated sphere). Convert before subtracting; 64-bit behaviour unchanged. Regression fixture: `sphere`. | Yes (32-bit portability) | OrcaWeb `apply.py` §8d guards the same spot with an `empty()` check |
| 0009 | Model: no backup manager in the destructor under Emscripten | A model that was given a backup folder (3MF import) hands its removal to the autosave manager in `~Model()`, which starts a thread. When the 3MF reader throws on a cut-off file, that happens while the exception unwinds; the destructor threw and the engine terminated instead of reporting the file. Under Emscripten the folder is removed directly. | No (WebAssembly only) | — |

## Dependencies (`engine/patches/deps/`)

| Dep | Patch | Why | Credit |
|-----|-------|-----|--------|
| Boost 1.84.0 | `boost/0001-asio-drop-context-coroutine.patch` | Boost.Context has no wasm backend. Asio's CMake links it although libslic3r only uses one Beast base64 header. | — |
| Boost 1.84.0 | `boost/0002-interval-wasm-rounding-control.patch` | WebAssembly has no rounding-mode control. Boost.Interval gets a backend that aborts on directed rounding instead of failing to compile or being silently unsound. See also `CGAL_ALWAYS_ROUND_TO_NEAREST`. | — |
| oneTBB 2021.13.0 | `onetbb/wasm-exceptions.cmake` (CMake script, unmodified) | oneTBB's Emscripten profile forces legacy JS exceptions. We need native Wasm EH. | OrcaWeb (AGPL-3.0) @60a09e0 |

## Toolchain (`engine/docker/`)

| Patch | Why |
|-------|-----|
| `libcxx-stdcxx-sort.patch` | Makes libc++'s `std::sort` order equal elements exactly like libstdc++, so WebAssembly output matches the Linux desktop app. Verified under wasm against the libstdc++ order. |

## Non-patch source substitutes

| Path | Replaces | Why |
|------|----------|-----|
| `engine/shims/openssl/md5.h`, `md5.c` | OpenSSL `MD5_*` | libslic3r uses OpenSSL only for 3MF G-code MD5s. Tested against the RFC 1321 vectors. |
| `engine/tbb-serial/` | oneTBB (single-threaded build only) | Serial implementation of the TBB API subset libslic3r uses. |
