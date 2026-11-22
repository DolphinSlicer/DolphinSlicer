// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { dispositionName, fileNameFor, parseQuickLinks, sniffExtension } from '../src/state/quickLink';

const binaryStl = (n = 1) => {
  const b = new ArrayBuffer(84 + 50 * n);
  new DataView(b).setUint32(80, n, true);
  return b;
};
const text = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('slice-now links', () => {
  it('reads model and name parameters, http(s) only', () => {
    expect(
      parseQuickLinks(
        '?model=https%3A%2F%2Fa.test%2Fx.stl&model=http://b.test/y&name=&name=Y.3mf&model=javascript:alert(1)&model=file:///etc/passwd',
      ),
    ).toEqual([{ url: 'https://a.test/x.stl' }, { url: 'http://b.test/y', name: 'Y.3mf' }]);
    expect(parseQuickLinks('?foo=1')).toEqual([]);
  });
  it('reads Content-Disposition file names', () => {
    expect(dispositionName('attachment; filename="Benchy.stl"')).toBe('Benchy.stl');
    expect(dispositionName('attachment; filename*=UTF-8\'\'W%C3%BCrfel.3mf; filename="x"')).toBe('Würfel.3mf');
    expect(dispositionName(null)).toBeNull();
  });
  it('recognizes model files by their content', () => {
    expect(sniffExtension(binaryStl(3))).toBe('stl');
    expect(sniffExtension(text('solid cube\n facet normal 0 0 1\n'))).toBe('stl');
    expect(sniffExtension(text('PK\u0003\u0004rest'))).toBe('3mf');
    expect(sniffExtension(text('# made by x\nv 0 0 0\nv 1 0 0\nf 1 2 3\n'))).toBe('obj');
    expect(sniffExtension(text('<?xml version="1.0"?><amf unit="mm">'))).toBe('amf');
    expect(sniffExtension(text('<html><body>Login</body></html>'))).toBeNull();
  });
  it('names the file: name parameter, then Content-Disposition, then the path, then the content', () => {
    const stl = binaryStl();
    expect(fileNameFor({ url: 'https://a.test/dl?id=1', name: 'Mine.stl' }, 'attachment; filename="x.3mf"', stl)).toBe('Mine.stl');
    expect(fileNameFor({ url: 'https://a.test/dl?id=1' }, 'attachment; filename="x.3mf"', stl)).toBe('x.3mf');
    expect(fileNameFor({ url: 'https://a.test/files/My%20part.STL' }, null, stl)).toBe('My part.STL');
    // A lone "%" is no escape: it stays, the escapes around it are decoded.
    expect(fileNameFor({ url: 'https://a.test/files/100%25%20final.stl' }, null, stl)).toBe('100% final.stl');
    expect(fileNameFor({ url: 'https://a.test/files/50%.stl' }, null, stl)).toBe('50%.stl');
    expect(fileNameFor({ url: 'https://a.test/download' }, null, stl)).toBe('download.stl');
    expect(fileNameFor({ url: 'https://a.test/download' }, null, text('<html>'))).toBeNull();
  });
});
