// Global operator new/delete for the engine.
//
// Emscripten 6.0.13's mimalloc (-sMALLOC=mimalloc, multithreaded build) overrides operator new
// with mi_new, which calls abort() when an allocation fails instead of throwing std::bad_alloc
// (its system-library build has no exceptions). An out-of-memory slice then kills the whole
// module. These replacements allocate with malloc (mimalloc or dlmalloc, unchanged) and throw
// std::bad_alloc on failure, so the slice ends with ORCA_OOM like any other error.
// SPDX-License-Identifier: AGPL-3.0-or-later
#include <cstdlib>
#include <new>

namespace {
void *alloc_or_throw(std::size_t n)
{
    if (n == 0) n = 1;
    if (void *p = std::malloc(n)) return p;
    throw std::bad_alloc();
}
void *aligned_or_throw(std::size_t n, std::align_val_t al)
{
    std::size_t a = static_cast<std::size_t>(al);
    if (a < sizeof(void *)) a = sizeof(void *);
    if (n == 0) n = 1;
    void *p = nullptr;
    if (posix_memalign(&p, a, n) == 0 && p) return p;
    throw std::bad_alloc();
}
} // namespace

// Only the throwing forms are replaced. mimalloc's alloc.o already defines the nothrow and
// aligned-delete forms (a second definition would not link), and those need no change.
void *operator new(std::size_t n) { return alloc_or_throw(n); }
void *operator new[](std::size_t n) { return alloc_or_throw(n); }
void *operator new(std::size_t n, std::align_val_t a) { return aligned_or_throw(n, a); }
void *operator new[](std::size_t n, std::align_val_t a) { return aligned_or_throw(n, a); }
void operator delete(void *p) noexcept { std::free(p); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete(void *p, std::size_t) noexcept { std::free(p); }
void operator delete[](void *p, std::size_t) noexcept { std::free(p); }
