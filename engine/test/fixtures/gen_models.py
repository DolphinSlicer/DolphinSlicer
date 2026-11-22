#!/usr/bin/env python3
"""Generate the reference test meshes as binary STL (all geometry is ours, CC0).

  cube.stl        20 mm calibration cube
  mushroom.stl    10x10x15 column under a 30x30x5 cap: 10 mm overhangs on all sides -> needs support
  cyl.stl         d=16 h=12 cylinder (64 segments)
  wedge.stl       30x15 base, 15 high, sloped 45 deg face
  sphere.stl      UV sphere r=15 (256 segments): many slivers meet at the poles, which exercises
                  Arachne's degenerate cases (see Orca patch 0008)
Usage: gen_models.py OUT_DIR
"""
import math
import struct
import sys
from pathlib import Path


def box(x0, y0, z0, x1, y1, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
         (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return [(v[a], v[b], v[c]) for a, b, c in f]


def cylinder(r, h, n=64):
    tris = []
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0 = (r * math.cos(a0), r * math.sin(a0))
        p1 = (r * math.cos(a1), r * math.sin(a1))
        tris.append(((0, 0, 0), (p1[0], p1[1], 0), (p0[0], p0[1], 0)))
        tris.append(((0, 0, h), (p0[0], p0[1], h), (p1[0], p1[1], h)))
        tris.append(((p0[0], p0[1], 0), (p1[0], p1[1], 0), (p1[0], p1[1], h)))
        tris.append(((p0[0], p0[1], 0), (p1[0], p1[1], h), (p0[0], p0[1], h)))
    return tris


def wedge(w, d, h):
    # Triangular prism along X: profile in YZ is (0,0)-(d,0)-(0,h).
    a, b, c = (0, 0, 0), (0, d, 0), (0, 0, h)
    A, B, C = (w, 0, 0), (w, d, 0), (w, 0, h)
    return [(a, c, b), (A, B, C),                 # end caps
            (a, b, B), (a, B, A),                 # bottom
            (a, A, C), (a, C, c),                 # back (y=0)
            (b, c, C), (b, C, B)]                 # sloped face


def sphere(r, seg=256):
    rings = seg // 2

    def p(i, j):
        th, ph = math.pi * i / rings, 2 * math.pi * j / seg
        return (r * math.sin(th) * math.cos(ph), r * math.sin(th) * math.sin(ph), r - r * math.cos(th))
    tris = []
    for i in range(rings):
        for j in range(seg):
            a, b, c, d = p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)
            if i > 0:
                tris.append((a, b, d))
            if i < rings - 1:
                tris.append((b, c, d))
    return tris


def write_stl(path, tris):
    with open(path, 'wb') as f:
        f.write(b'DolphinSlicer fixture'.ljust(80, b'\0'))
        f.write(struct.pack('<I', len(tris)))
        for t in tris:
            f.write(struct.pack('<3f', 0, 0, 0))
            for p in t:
                f.write(struct.pack('<3f', *p))
            f.write(b'\0\0')


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    write_stl(out / 'cube.stl', box(0, 0, 0, 20, 20, 20))
    write_stl(out / 'mushroom.stl', box(10, 10, 0, 20, 20, 15) + box(0, 0, 15, 30, 30, 20))
    write_stl(out / 'cyl.stl', cylinder(8, 12))
    write_stl(out / 'wedge.stl', wedge(30, 15, 15))
    write_stl(out / 'sphere.stl', sphere(15))


if __name__ == '__main__':
    main()
