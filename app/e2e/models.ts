// Test models generated in code (binary STL, plain 3MF), so e2e tests need no binary fixtures.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { crc32 } from 'node:zlib';

type Tri = [number[], number[], number[]];

function binaryStl(tris: Tri[]): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12; // normal (0,0,0): recomputed by the loader
    for (const v of t) {
      buf.writeFloatLE(v[0]!, o);
      buf.writeFloatLE(v[1]!, o + 4);
      buf.writeFloatLE(v[2]!, o + 8);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

export function boxStl(sx = 20, sy = 20, sz = 20): Buffer {
  const v = (x: number, y: number, z: number) => [x * sx, y * sy, z * sz];
  const q = (a: number[], b: number[], c: number[], d: number[]): Tri[] => [
    [a, b, c],
    [a, c, d],
  ];
  return binaryStl([
    ...q(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)),
    ...q(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)),
    ...q(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)),
    ...q(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)),
    ...q(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)),
    ...q(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)),
  ]);
}

/** UV sphere with `seg` segments around and `seg/2` rings: about seg² triangles. */
export function sphereStl(r = 40, seg = 256): Buffer {
  const rings = seg / 2;
  const p = (i: number, j: number) => {
    const th = (Math.PI * i) / rings,
      ph = (2 * Math.PI * j) / seg;
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r - r * Math.cos(th)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = p(i, j),
        b = p(i + 1, j),
        c = p(i + 1, j + 1),
        d = p(i, j + 1);
      if (i > 0) tris.push([a, b, d]);
      if (i < rings - 1) tris.push([b, c, d]);
    }
  return binaryStl(tris);
}

/** A plain 3MF (as CAD programs export it: no slicer settings) with a box centered on the origin. */
export function plain3mf(sx = 30, sy = 20, sz = 10): Buffer {
  return plain3mfOf([{ size: [sx, sy, sz] }]);
}

/** A plain 3MF with several boxes, each centered on `at` (the origin when left out). */
export function plain3mfOf(boxes: { size: [number, number, number]; at?: [number, number, number] }[]): Buffer {
  const mesh = ([sx, sy, sz]: [number, number, number]) => {
    const v = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ]
      .map(([x, y, z]) => `<vertex x="${(x! * sx) / 2}" y="${(y! * sy) / 2}" z="${(z! * sz) / 2}"/>`)
      .join('');
    const t = [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ]
      .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
      .join('');
    return `<mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh>`;
  };
  const one = boxes.length === 1;
  const objects = boxes
    .map((b, i) => `<object id="${i + 1}" name="${one ? 'Box' : `Box ${i + 1}`}" type="model">${mesh(b.size)}</object>`)
    .join('');
  const items = boxes
    .map((b, i) => `<item objectid="${i + 1}"${b.at ? ` transform="1 0 0 0 1 0 0 0 1 ${b.at.join(' ')}"` : ''}/>`)
    .join('');
  return storedZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${items}</build></model>`,
  });
}

/**
 * An OrcaSlicer project 3MF (its 3MF writer's layout: an object made of components, their types in
 * Metadata/model_settings.config): a pillar with a slab overhanging both sides, and a support
 * blocker around all of it.
 */
export function projectWithBlocker(): Buffer {
  const box = ([x0, y0, z0]: [number, number, number], [x1, y1, z1]: [number, number, number]) => {
    const v = [z0, z1].flatMap((z) => [y0, y1].flatMap((y) => [x0, x1].map((x) => [x, y, z])));
    const t = [
      [0, 2, 3],
      [0, 3, 1],
      [4, 5, 7],
      [4, 7, 6],
      [0, 1, 5],
      [0, 5, 4],
      [2, 6, 7],
      [2, 7, 3],
      [0, 4, 6],
      [0, 6, 2],
      [1, 3, 7],
      [1, 7, 5],
    ];
    return { v, t };
  };
  const mesh = (boxes: ReturnType<typeof box>[]) => {
    const verts: number[][] = [],
      tris: number[][] = [];
    for (const b of boxes) {
      const o = verts.length;
      verts.push(...b.v);
      tris.push(...b.t.map((t) => t.map((i) => i + o)));
    }
    return `<mesh><vertices>${verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
  };
  const tee = mesh([box([-5, -5, 0], [5, 5, 20]), box([-25, -5, 20], [25, 5, 24])]);
  const blocker = mesh([box([-40, -15, 0], [40, 15, 40])]);
  return storedZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">OrcaSlicer-2.3.0</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources><object id="1" type="model">${tee}</object><object id="2" type="model">${blocker}</object><object id="3" name="tee" type="model"><components><component objectid="1"/><component objectid="2"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>`,
    'Metadata/model_settings.config':
      '<?xml version="1.0" encoding="UTF-8"?><config><object id="3"><metadata key="name" value="tee"/><part id="1" subtype="normal_part"><metadata key="name" value="tee"/></part><part id="2" subtype="support_blocker"><metadata key="name" value="Big blocker"/></part></object></config>',
  });
}

/** A zip archive of uncompressed entries. */
function storedZip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text),
      n = Buffer.from(name),
      crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    local.push(head, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
