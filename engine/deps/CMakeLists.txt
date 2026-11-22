# WASM dependency superbuild for the OrcaSlicer engine.
#
# Versions and options mirror OrcaSlicer v2.5.0's deps/*.cmake recipes, so the code we compile
# behaves like the desktop build. Every deviation is marked "DEVIATION:" with the reason.
#
# One configure builds one variant into ${DEPS_PREFIX}:
#   -DWASM_THREADS=OFF  single-threaded (no -pthread, serial TBB shim instead of oneTBB)
#   -DWASM_THREADS=ON   multithreaded   (-pthread everywhere, real oneTBB)
# Every static library linked into a shared-memory wasm module must itself be built with
# -pthread (atomics/bulk-memory), so the variants cannot share objects.
#
# Run through engine/scripts/build-deps.sh inside the toolchain container.

cmake_minimum_required(VERSION 3.24)
project(orca_wasm_deps C CXX)

include(ExternalProject)

option(WASM_THREADS "Build the pthread (multithreaded) variant" OFF)
option(DEPS_WITH_OCCT "Build OpenCASCADE (only needed by the STEP module)" OFF)
set(DEPS_PREFIX "" CACHE PATH "Install prefix for this variant")
set(DEPS_DOWNLOAD_DIR "" CACHE PATH "Shared download cache")
set(ORCA_SOURCE_DIR "" CACHE PATH "OrcaSlicer checkout (for in-tree deps: EXPAT, recipe patches)")
foreach(_v DEPS_PREFIX DEPS_DOWNLOAD_DIR ORCA_SOURCE_DIR)
  if(NOT ${_v})
    message(FATAL_ERROR "${_v} must be set")
  endif()
endforeach()

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake (Emscripten toolchain)")
endif()

# Native Wasm exception handling + Wasm SjLj everywhere: mixing EH models fails at link time
# or, worse, makes exceptions abort at run time. (Emscripten 6.0.13 default is the legacy
# Wasm EH encoding, WASM_LEGACY_EXCEPTIONS=1, which all supported browsers implement.)
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

include(ProcessorCount)
ProcessorCount(NPROC)
if(NOT "$ENV{DEPS_JOBS}" STREQUAL "")
  set(NPROC $ENV{DEPS_JOBS})
endif()

set(ORCA_DEPS ${ORCA_SOURCE_DIR}/deps)

# Arguments common to every CMake-based dependency.
set(DEP_CMAKE_ARGS
  -G Ninja
  -DCMAKE_TOOLCHAIN_FILE:FILEPATH=${CMAKE_TOOLCHAIN_FILE}
  -DCMAKE_BUILD_TYPE:STRING=Release
  -DCMAKE_INSTALL_PREFIX:PATH=${DEPS_PREFIX}
  -DCMAKE_PREFIX_PATH:PATH=${DEPS_PREFIX}
  # Emscripten's toolchain roots find_* in its sysroot; add our prefix as a second root so
  # nothing from the host (/usr) can leak in.
  -DCMAKE_FIND_ROOT_PATH:PATH=${DEPS_PREFIX}
  -DCMAKE_POLICY_VERSION_MINIMUM=3.10
  -DBUILD_SHARED_LIBS:BOOL=OFF
  -DCMAKE_POSITION_INDEPENDENT_CODE:BOOL=OFF
  -DCMAKE_C_FLAGS:STRING=${WASM_FLAGS}
  -DCMAKE_CXX_FLAGS:STRING=${WASM_FLAGS}
  -DCMAKE_C_COMPILER_LAUNCHER:STRING=ccache
  -DCMAKE_CXX_COMPILER_LAUNCHER:STRING=ccache
)

function(add_dep name)
  cmake_parse_arguments(A "" "" "CMAKE_ARGS" ${ARGN})
  ExternalProject_Add(dep_${name}
    DOWNLOAD_DIR ${DEPS_DOWNLOAD_DIR}/${name}
    INSTALL_DIR  ${DEPS_PREFIX}
    DOWNLOAD_EXTRACT_TIMESTAMP ON
    CMAKE_ARGS ${DEP_CMAKE_ARGS} ${A_CMAKE_ARGS}
    BUILD_COMMAND   ${CMAKE_COMMAND} --build . -- -j${NPROC}
    INSTALL_COMMAND ${CMAKE_COMMAND} --build . --target install
    ${A_UNPARSED_ARGUMENTS}
  )
endfunction()

# ── zlib 1.2.13 (Orca pin) ─────────────────────────────────────────────────────
add_dep(ZLIB
  URL https://github.com/madler/zlib/archive/refs/tags/v1.2.13.zip
  URL_HASH SHA256=c2856951bbf30e30861ace3765595d86ba13f2cf01279d901f6c62258c57f4ff
  PATCH_COMMAND patch -p1 -i ${ORCA_DEPS}/ZLIB/0001-Respect-BUILD_SHARED_LIBS.patch
  CMAKE_ARGS -DSKIP_INSTALL_FILES=ON
)

# ── libpng 1.6.59 (Orca pin, same symbol prefix) ───────────────────────────────
add_dep(PNG
  URL https://github.com/glennrp/libpng/archive/refs/tags/v1.6.59.zip
  URL_HASH SHA256=6fd97a1e5e2ac55cec0a538a9800a351eb3844086736291844ebd12db72ba433
  DEPENDS dep_ZLIB
  CMAKE_ARGS -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_PREFIX=prusaslicer_ -DPNG_TESTS=OFF
             -DPNG_TOOLS=OFF -DPNG_HARDWARE_OPTIMIZATIONS=OFF
)

# ── libjpeg-turbo 3.2.0 (Orca pin) ─────────────────────────────────────────────
add_dep(JPEG
  URL https://github.com/libjpeg-turbo/libjpeg-turbo/archive/refs/tags/3.2.0.zip
  URL_HASH SHA256=1b4c2cb6cba1ca5e53b9e85eeeab02154cab4b70894c96e97a9c747a26d19d63
  # DEVIATION: no SIMD (no wasm backend in libjpeg-turbo). Output-identical by design.
  CMAKE_ARGS -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DCMAKE_INSTALL_LIBDIR=lib -DWITH_SIMD=OFF
             -DWITH_TURBOJPEG=OFF
)

# ── EXPAT (Orca's in-tree copy) ────────────────────────────────────────────────
add_dep(EXPAT
  SOURCE_DIR ${ORCA_DEPS}/EXPAT/expat
  DOWNLOAD_COMMAND ""
  # Emscripten implements /dev/urandom via crypto.getRandomValues (and getrandom() in Node).
  # Only used to salt expat's hash tables; no effect on parsed output.
  CMAKE_ARGS "-DCMAKE_C_FLAGS:STRING=${WASM_FLAGS} -DXML_DEV_URANDOM"
)

# ── Boost 1.84.0 (Orca pin), CMake build ───────────────────────────────────────
# Only the components libslic3r's find_package(Boost ...) asks for (and their deps).
# Boost.Log ABI: Orca 2.5.0 compiles libslic3r WITHOUT BOOST_LOG_NO_THREADS (OrcaWeb's 2.4.2-era
# build needed it), so Boost.Log is built with its default threading ABI to match.
add_dep(Boost
  URL https://github.com/boostorg/boost/releases/download/boost-1.84.0/boost-1.84.0.tar.gz
  URL_HASH SHA256=4d27e9efed0f6f152dc28db6430b9d3dfb40c0345da7342eaa5a987dde57bd95
  DEPENDS dep_ZLIB
  PATCH_COMMAND patch -p1 -i ${CMAKE_CURRENT_SOURCE_DIR}/../patches/deps/boost/0001-asio-drop-context-coroutine.patch
           COMMAND patch -p1 -i ${CMAKE_CURRENT_SOURCE_DIR}/../patches/deps/boost/0002-interval-wasm-rounding-control.patch
  LIST_SEPARATOR |
  CMAKE_ARGS
    # Orca excludes contract|fiber|numpy|stacktrace|wave|test; we add the ones that cannot
    # target wasm (python/mpi/process/cobalt; context/coroutine need per-arch assembly) and are
    # not used by libslic3r.
    -DBOOST_EXCLUDE_LIBRARIES:STRING=contract|fiber|numpy|stacktrace|wave|test|python|mpi|graph_parallel|process|cobalt|context|coroutine
    -DBOOST_LOCALE_ENABLE_ICU:BOOL=OFF
    -DBOOST_LOCALE_ENABLE_ICONV:BOOL=ON
    -DBOOST_IOSTREAMS_ENABLE_BZIP2:BOOL=OFF
    -DBOOST_IOSTREAMS_ENABLE_ZSTD:BOOL=OFF
    -DBOOST_IOSTREAMS_ENABLE_LZMA:BOOL=OFF
    -DBUILD_TESTING:BOOL=OFF
    "-DCMAKE_CXX_FLAGS:STRING=${WASM_FLAGS} -DBOOST_LOG_WITHOUT_SYSLOG=1"
)

# ── cereal 1.3.0, Qhull 8.0.2, NLopt 2.5.0, libnoise 1.0, Draco 1.5.7 (Orca pins) ──
add_dep(Cereal
  URL https://github.com/USCiLab/cereal/archive/refs/tags/v1.3.0.zip
  URL_HASH SHA256=71642cb54658e98c8f07a0f0d08bf9766f1c3771496936f6014169d3726d9657
  CMAKE_ARGS -DJUST_INSTALL_CEREAL=ON -DSKIP_PERFORMANCE_COMPARISON=ON -DBUILD_TESTS=OFF
)
add_dep(Qhull
  URL https://github.com/qhull/qhull/archive/v8.0.2.zip
  URL_HASH SHA256=a378e9a39e718e289102c20d45632f873bfdc58a7a5f924246ea4b176e185f1e
  CMAKE_ARGS -DINCLUDE_INSTALL_DIR=include -DBUILD_APPLICATIONS=OFF
)
add_dep(NLopt
  URL https://github.com/stevengj/nlopt/archive/v2.5.0.tar.gz
  URL_HASH SHA256=c6dd7a5701fff8ad5ebb45a3dc8e757e61d52658de3918e38bab233e7fd3b4ae
  CMAKE_ARGS -DNLOPT_PYTHON=OFF -DNLOPT_OCTAVE=OFF -DNLOPT_MATLAB=OFF -DNLOPT_GUILE=OFF
             -DNLOPT_SWIG=OFF -DNLOPT_TESTS=OFF
)
add_dep(libnoise
  URL https://github.com/SoftFever/Orca-deps-libnoise/archive/refs/tags/1.0.zip
  URL_HASH SHA256=96ffd6cc47898dd8147aab53d7d1b1911b507d9dbaecd5613ca2649468afd8b6
)
add_dep(Draco
  URL https://github.com/google/draco/archive/refs/tags/1.5.7.zip
  URL_HASH SHA256=27b72ba2d5ff3d0a9814ad40d4cb88f8dc89a35491c0866d952473f8f9416b77
  # Draco has its own Emscripten mode that builds JS decoders; we want the plain C++ library.
  # Its Emscripten check also wants a Python interpreter and $EMSCRIPTEN (set in the image).
  CMAKE_ARGS -DDRACO_JS_GLUE=OFF -DDRACO_WASM=OFF -DDRACO_TESTS=OFF -DPYTHON_EXECUTABLE=/usr/bin/python3
)

# ── GMP 6.3.0 / MPFR 4.2.2 (Orca pins), autotools ──────────────────────────────
set(_gmp_flags "-O2 -DNDEBUG ${WASM_FLAGS}")
ExternalProject_Add(dep_GMP
  URL https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz
      https://github.com/SoftFever/OrcaSlicer_deps/releases/download/gmp-6.3.0/gmp-6.3.0.tar.xz
  URL_HASH SHA256=a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898
  DOWNLOAD_DIR ${DEPS_DOWNLOAD_DIR}/GMP
  DOWNLOAD_EXTRACT_TIMESTAMP ON
  BUILD_IN_SOURCE ON
  PATCH_COMMAND patch -p1 -i ${ORCA_DEPS}/GMP/0001-GMP_GCC15.patch
  # DEVIATION: --disable-assembly (no wasm asm). Generic C limb code gives identical results.
  # gmp_cv_asm_label_suffix is needed because configure's asm probe cannot run under wasm.
  CONFIGURE_COMMAND env gmp_cv_asm_label_suffix=: "CFLAGS=${_gmp_flags}" "CXXFLAGS=${_gmp_flags}"
      emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared --enable-static
      --disable-assembly --enable-cxx --prefix=${DEPS_PREFIX}
  BUILD_COMMAND emmake make -j${NPROC}
  INSTALL_COMMAND make install
)
ExternalProject_Add(dep_MPFR
  URL https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.2.tar.bz2
      https://www.mpfr.org/mpfr-4.2.2/mpfr-4.2.2.tar.bz2
  URL_HASH SHA256=9ad62c7dc910303cd384ff8f1f4767a655124980bb6d8650fe62c815a231bb7b
  DOWNLOAD_DIR ${DEPS_DOWNLOAD_DIR}/MPFR
  DOWNLOAD_EXTRACT_TIMESTAMP ON
  BUILD_IN_SOURCE ON
  DEPENDS dep_GMP
  CONFIGURE_COMMAND env "CFLAGS=${_gmp_flags}"
      emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared --enable-static
      --with-gmp=${DEPS_PREFIX} --prefix=${DEPS_PREFIX}
  BUILD_COMMAND emmake make -j${NPROC}
  INSTALL_COMMAND make install
)

# ── Eigen 5.0.1, CGAL 6.2.1 (Orca pins; header-only) ───────────────────────────
add_dep(Eigen
  URL https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.zip
  URL_HASH SHA256=0dbb1f9e3aaad66f352c03227d8c983f6f0b49e0b07e71a7300f4abcc01aee12
  CMAKE_ARGS -DEIGEN_BUILD_TESTING=OFF -DEIGEN_BUILD_BLAS=OFF -DEIGEN_BUILD_LAPACK=OFF
             -DEIGEN_BUILD_DOC=OFF -DEIGEN_BUILD_PKGCONFIG=OFF -DBUILD_TESTING=OFF
)
add_dep(CGAL
  URL https://github.com/CGAL/cgal/releases/download/v6.2.1/CGAL-6.2.1.zip
  URL_HASH SHA256=eebd737d9b7f0199647ba5c1f9f6c7a3d0651aacef9c2fd4dedc52da6c25edbe
  DEPENDS dep_Boost dep_Eigen dep_GMP dep_MPFR
)

# ── oneTBB (MT only) ───────────────────────────────────────────────────────────
# DEVIATION: Orca pins 2021.5.0, which predates Emscripten support. 2021.13.0 is the
# version OrcaWeb ships successfully under Emscripten pthreads.
if(WASM_THREADS)
  add_dep(TBB
    URL https://github.com/uxlfoundation/oneTBB/archive/refs/tags/v2021.13.0.tar.gz
    URL_HASH SHA256=3ad5dd08954b39d113dc5b3f8a8dc6dc1fd5250032b7c491eb07aed5c94133e1
    PATCH_COMMAND ${CMAKE_COMMAND} -DTBB_SOURCE_DIR=. -P ${CMAKE_CURRENT_SOURCE_DIR}/../patches/deps/onetbb/wasm-exceptions.cmake
    CMAKE_ARGS -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DTBB_STRICT=OFF -DTBB_BUILD_SHARED=OFF
               -DBUILD_SHARED_LIBS=OFF -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON
               -DTBB_ENABLE_IPO=OFF -DTBBMALLOC_BUILD=ON -DTBBMALLOC_PROXY_BUILD=OFF
  )
endif()

# ── OpenCV 4.14.0 (Orca pin), only the modules libslic3r uses ──────────────────
# libslic3r uses cv::Mat, kmeans (core), cvtColor (imgproc), imdecode (imgcodecs, JPEG/PNG).
add_dep(OpenCV
  URL https://github.com/opencv/opencv/archive/refs/tags/4.14.0.tar.gz
  URL_HASH SHA256=ee8fb9b30eb60850431b4656447080e3737b56e45719c92b67f245950609f86e
  DEPENDS dep_JPEG dep_PNG dep_ZLIB
  CMAKE_ARGS
    -DBUILD_LIST=core,imgproc,imgcodecs
    -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF
    -DBUILD_opencv_apps=OFF -DBUILD_JAVA=OFF -DBUILD_opencv_python3=OFF
    -DBUILD_JPEG=OFF -DBUILD_PNG=OFF -DBUILD_ZLIB=OFF -DBUILD_TIFF=OFF -DBUILD_WEBP=OFF
    -DBUILD_OPENEXR=OFF -DBUILD_JASPER=OFF -DBUILD_TBB=OFF -DBUILD_IPP_IW=OFF -DBUILD_ITT=OFF
    -DWITH_JPEG=ON -DWITH_PNG=ON -DWITH_TIFF=OFF -DWITH_WEBP=OFF -DWITH_OPENJPEG=OFF
    -DWITH_JASPER=OFF -DWITH_OPENEXR=OFF -DWITH_AVIF=OFF -DWITH_IMGCODEC_GIF=OFF
    -DWITH_IMGCODEC_HDR=OFF -DWITH_IMGCODEC_SUNRASTER=OFF -DWITH_IMGCODEC_PXM=OFF
    -DWITH_IMGCODEC_PFM=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_OPENCL=OFF -DWITH_CUDA=OFF
    -DWITH_EIGEN=OFF -DWITH_LAPACK=OFF -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_GTK=OFF
    -DWITH_QUIRC=OFF -DWITH_VTK=OFF -DWITH_PROTOBUF=OFF -DWITH_ADE=OFF -DWITH_KLEIDICV=OFF
    -DWITH_PTHREADS_PF=${WASM_THREADS} -DWITH_TBB=OFF -DWITH_OPENMP=OFF
    -DCV_ENABLE_INTRINSICS=OFF -DCPU_BASELINE= -DCPU_DISPATCH=
    -DENABLE_PRECOMPILED_HEADERS=OFF -DOPENCV_GENERATE_PKGCONFIG=OFF
    -DOPENCV_GENERATE_SETUPVARS=OFF -DINSTALL_TESTS=OFF -DCMAKE_INSTALL_LIBDIR=lib
    -DOPENCV_LIB_INSTALL_PATH=lib -DOPENCV_3P_LIB_INSTALL_PATH=lib
)

# ── assimp 5.4.3 (Orca pin for CMake >= 3.22) ──────────────────────────────────
add_dep(Assimp
  URL https://github.com/assimp/assimp/archive/refs/tags/v5.4.3.tar.gz
  URL_HASH SHA256=66dfbaee288f2bc43172440a55d0235dfc7bf885dda6435c038e8000e79582cb
  DEPENDS dep_ZLIB
  CMAKE_ARGS
    -DASSIMP_BUILD_USE_CCACHE=OFF -DASSIMP_BUILD_TESTS=OFF -DASSIMP_BUILD_SAMPLES=OFF
    -DASSIMP_BUILD_ASSIMP_TOOLS=OFF -DASSIMP_INSTALL_PDB=OFF -DASSIMP_NO_EXPORT=ON
    -DASSIMP_BUILD_ALL_IMPORTERS_BY_DEFAULT=OFF -DASSIMP_BUILD_GLTF_IMPORTER=ON
    -DASSIMP_BUILD_OBJ_IMPORTER=ON -DASSIMP_BUILD_FBX_IMPORTER=ON
    # DEVIATION: use our zlib instead of assimp's bundled copy (one zlib in the binary).
    -DASSIMP_BUILD_ZLIB=OFF -DASSIMP_WARNINGS_AS_ERRORS=OFF -DBUILD_WITH_STATIC_CRT=OFF
    -DASSIMP_BUILD_DRACO=OFF -DASSIMP_BUILD_MINIZIP=ON
)

set(_all dep_ZLIB dep_PNG dep_JPEG dep_EXPAT dep_Boost dep_Cereal dep_Qhull dep_NLopt
         dep_libnoise dep_Draco dep_GMP dep_MPFR dep_Eigen dep_CGAL dep_OpenCV dep_Assimp)
if(WASM_THREADS)
  list(APPEND _all dep_TBB)
endif()
add_custom_target(deps ALL DEPENDS ${_all})
