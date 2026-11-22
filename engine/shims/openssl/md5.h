/* Minimal MD5 for the WASM engine (DolphinSlicer). Replaces OpenSSL's <openssl/md5.h>, which
 * libslic3r uses only for MD5_Init/Update/Final (G-code checksums in 3MF). RFC 1321.
 * SPDX-License-Identifier: AGPL-3.0-or-later */
#ifndef DOLPHIN_SLICER_MD5_SHIM_H
#define DOLPHIN_SLICER_MD5_SHIM_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define MD5_DIGEST_LENGTH 16
typedef struct MD5state_st {
    uint32_t a, b, c, d;
    uint64_t len;          /* total length in bytes */
    unsigned char buf[64];
    size_t num;            /* bytes buffered */
} MD5_CTX;
int MD5_Init(MD5_CTX *c);
int MD5_Update(MD5_CTX *c, const void *data, size_t len);
int MD5_Final(unsigned char *md, MD5_CTX *c);
unsigned char *MD5(const unsigned char *d, size_t n, unsigned char *md);
#ifdef __cplusplus
}
#endif
#endif
