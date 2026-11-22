# OrcaSlicer engine → WebAssembly.
#
# Our own top-level CMake: it replaces OrcaSlicer's root CMakeLists.txt (which configures the
# GUI, Python, networking, etc.) with just what libslic3r needs, then adds Orca's own
# deps_src/ and src/libslic3r/ CMake projects unchanged (plus our patch series).
# Global definitions mirror Orca's root CMake for a Linux Release build, so libslic3r compiles
# the same way it does for the desktop app (see "parity" comments).
#
# Configure via engine/scripts/build-engine.sh (inside the toolchain container).

cmake_minimum_required(VERSION 3.24)
project(orca_engine C CXX)

# Orca's version numbers (SoftFever_VERSION, SLIC3R_VERSION, …) feed libslic3r_version.h, which
# ends up in the G-code header and in exported configs.
include(${ORCA_SOURCE_DIR}/version.inc)

option(WASM_THREADS "Multithreaded build (pthreads + oneTBB); OFF = serial TBB shim" OFF)
set(ORCA_SOURCE_DIR "" CACHE PATH "Patched OrcaSlicer source tree")
set(DEPS_PREFIX "" CACHE PATH "Dependency prefix for this variant (engine/deps)")
if(NOT ORCA_SOURCE_DIR OR NOT DEPS_PREFIX)
  message(FATAL_ERROR "ORCA_SOURCE_DIR and DEPS_PREFIX are required")
endif()
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Must match engine/deps (every object in one module shares the EH model and threading ABI).
set(WASM_FLAGS "-fwasm-exceptions -sSUPPORT_LONGJMP=wasm")
if(WASM_THREADS)
  string(APPEND WASM_FLAGS " -pthread")
else()
  # Without -pthread, Emscripten's unistd.h omits _POSIX_THREADS, so Boost.Config never sets
  # BOOST_HAS_PTHREADS (libc++ still makes it set BOOST_HAS_THREADS) and some libraries break,
  # e.g. Boost.Container's thread_mutex falls through to its Windows branch. Emscripten's
  # single-threaded libc provides no-op pthread mutexes, so declare them. Must be identical for
  # deps and engine.
  string(APPEND WASM_FLAGS " -DBOOST_HAS_PTHREADS")
endif()
string(APPEND CMAKE_C_FLAGS " ${WASM_FLAGS}")
string(APPEND CMAKE_CXX_FLAGS " ${WASM_FLAGS}")
# Parity: Orca's Linux build uses the default FP model (no -ffast-math). Clang defaults to
# -ffp-contract=on, which may fuse a*b+c into an FMA where the target has one; wasm has no FMA
# instruction (relaxed-simd is not enabled), so nothing is fused. Stated explicitly anyway.
string(APPEND CMAKE_CXX_FLAGS " -ffp-contract=off")
string(APPEND CMAKE_C_FLAGS " -ffp-contract=off")
# libslic3r is warning-heavy under clang; warnings are not useful here.
add_compile_options(-Wno-everything)

list(PREPEND CMAKE_MODULE_PATH ${ORCA_SOURCE_DIR}/cmake/modules)
list(PREPEND CMAKE_PREFIX_PATH ${DEPS_PREFIX})
list(APPEND CMAKE_FIND_ROOT_PATH ${DEPS_PREFIX})

# ── Global definitions copied from Orca's root CMakeLists.txt (Linux, Release, no GUI) ─────
set(SLIC3R_STATIC 1)
set(SLIC3R_GUI 0)
set(SLIC3R_CAD 0)
set(SLIC3R_PCH 0)
set(SLIC3R_ENC_CHECK OFF CACHE BOOL "" FORCE)
add_compile_definitions("$<IF:$<CONFIG:Debug>,DEBUG,NDEBUG>")
add_compile_definitions(BBL_RELEASE_TO_PUBLIC=1 WXINSPECTOR_DISABLE)
add_definitions(-DwxUSE_UNICODE -D_UNICODE -DUNICODE -DWXINTL_NO_GETTEXT_MACRO -DwxNO_UNSAFE_WXSTRING_CONV)
# Soundness: WebAssembly cannot change the FPU rounding mode (Emscripten's fesetround is a
# no-op), but CGAL's interval filters assume directed rounding unless told otherwise. This makes
# CGAL use its round-to-nearest-safe interval arithmetic. Without it, exact predicates could be
# silently wrong. (Boost.Interval gets a fail-loudly backend: patches/deps/boost/0002.)
add_compile_definitions(CGAL_ALWAYS_ROUND_TO_NEAREST)
# The engine has no OpenCASCADE; STEP import lives in the separate STEP module.
# Option added to libslic3r by patches/orca/0001.
set(SLIC3R_NO_OCCT ON)

set(LIBDIR ${ORCA_SOURCE_DIR}/src)
set(LIBDIR_BIN ${CMAKE_CURRENT_BINARY_DIR}/src)
include_directories(SYSTEM ${LIBDIR})
include_directories(SYSTEM ${LIBDIR_BIN}/dev-utils/platform)
include_directories(SYSTEM ${LIBDIR}/libigl)

# Helpers Orca's root CMake defines for its sub-projects (MSVC-only behaviour → no-ops here).
function(slic3r_remap_configs targets from_Cfg to_Cfg)
endfunction()

# ── Dependencies (installed by engine/deps into DEPS_PREFIX) ─────────────────────────────
set(Boost_USE_STATIC_LIBS ON)
set(Boost_NO_SYSTEM_PATHS TRUE)
if(POLICY CMP0167)
  cmake_policy(SET CMP0167 NEW)
endif()
find_package(Boost 1.83.0 REQUIRED COMPONENTS system filesystem thread log log_setup locale regex
             chrono atomic date_time iostreams program_options nowide)
find_package(Eigen3 5.0.1 REQUIRED)
add_library(boost_libs INTERFACE)
add_library(boost_headeronly INTERFACE)
target_include_directories(boost_headeronly SYSTEM INTERFACE ${Boost_INCLUDE_DIRS})
target_link_libraries(boost_libs INTERFACE boost_headeronly ${Boost_LIBRARIES})

if(WASM_THREADS)
  find_package(TBB CONFIG REQUIRED COMPONENTS tbb tbbmalloc)
else()
  # Serial TBB shim (engine/tbb-serial): header-only, provides TBB::tbb and TBB::tbbmalloc.
  add_library(tbb_serial INTERFACE)
  target_include_directories(tbb_serial SYSTEM INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/tbb-serial/include)
  add_library(TBB::tbb ALIAS tbb_serial)
  add_library(TBB::tbbmalloc ALIAS tbb_serial)
endif()

find_package(ZLIB REQUIRED)
find_package(EXPAT REQUIRED)
find_package(PNG REQUIRED)
find_package(JPEG REQUIRED)
find_package(cereal REQUIRED)
if(NOT TARGET cereal::cereal)
  set_target_properties(cereal PROPERTIES IMPORTED_GLOBAL TRUE)
  add_library(cereal::cereal ALIAS cereal)
else()
  set_target_properties(cereal::cereal PROPERTIES IMPORTED_GLOBAL TRUE)
endif()
find_package(NLopt 1.4 REQUIRED)
find_package(libnoise REQUIRED)
find_package(Draco REQUIRED)

# OpenCV: Orca links the monolithic opencv_world; we build only core/imgproc/imgcodecs.
find_package(OpenCV REQUIRED core imgproc imgcodecs)
add_library(opencv_world INTERFACE)
target_link_libraries(opencv_world INTERFACE opencv_core opencv_imgproc opencv_imgcodecs)

# OpenSSL: libslic3r only uses MD5_* (3MF G-code checksums) — provided by a small shim.
add_library(orca_md5 STATIC ${CMAKE_CURRENT_SOURCE_DIR}/shims/md5.c)
target_include_directories(orca_md5 SYSTEM PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/shims)
add_library(OpenSSL::Crypto ALIAS orca_md5)
# Utils.hpp includes <openssl/md5.h>, and it is included by targets that do not link OpenSSL.
include_directories(SYSTEM ${CMAKE_CURRENT_SOURCE_DIR}/shims)

# ── Orca's own CMake projects ─────────────────────────────────────────────────────────────
add_subdirectory(${ORCA_SOURCE_DIR}/deps_src ${CMAKE_CURRENT_BINARY_DIR}/deps_src EXCLUDE_FROM_ALL)
add_subdirectory(${ORCA_SOURCE_DIR}/src/dev-utils ${CMAKE_CURRENT_BINARY_DIR}/src/dev-utils EXCLUDE_FROM_ALL)
add_subdirectory(${ORCA_SOURCE_DIR}/src/libslic3r ${CMAKE_CURRENT_BINARY_DIR}/src/libslic3r EXCLUDE_FROM_ALL)
# Startup: PrintConfigDef::init_fff_params() (every option definition, one function) runs on
# every engine start. At -O3 it becomes a ~436 KB wasm function that the browser's baseline
# compiler needs ~1 s for, on every page load (it runs once, so it is never cached). -Os keeps
# the inlined helper code out of it.
set_source_files_properties(${ORCA_SOURCE_DIR}/src/libslic3r/PrintConfig.cpp
  DIRECTORY ${ORCA_SOURCE_DIR}/src/libslic3r PROPERTIES COMPILE_OPTIONS "-Os")

# ── Our bridge + the wasm module ──────────────────────────────────────────────────────────
add_subdirectory(bridge)
