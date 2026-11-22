# Engine build toolchain. Pinned by digest for reproducibility.
# emsdk 6.0.13 (2026-10-19).
FROM emscripten/emsdk:6.0.13@sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ninja-build ccache autoconf automake libtool m4 texinfo patch pkg-config xz-utils unzip bzip2 \
 && rm -rf /var/lib/apt/lists/*

# libc++ std::sort → libstdc++-compatible tie order (see the patch header). Applied to the libc++
# sources and to the prebuilt sysroot copy of the headers.
COPY libcxx-stdcxx-sort.patch /tmp/
RUN cd /emsdk/upstream/emscripten/system/lib/libcxx/include && patch -p1 < /tmp/libcxx-stdcxx-sort.patch \
 && cd /emsdk/upstream/emscripten/cache/sysroot/include/c++/v1 && patch -p1 < /tmp/libcxx-stdcxx-sort.patch

# A newer CMake than Ubuntu 24.04's 3.28 is not required; Orca needs >= 3.13.
ENV EMSCRIPTEN=/emsdk/upstream/emscripten \
    CCACHE_DIR=/work/ccache \
    EM_CACHE=/work/emcache \
    CCACHE_MAXSIZE=20G
WORKDIR /src
