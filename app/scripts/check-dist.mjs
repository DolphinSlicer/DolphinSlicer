// Fail the build if any deployed file exceeds the Cloudflare Pages per-file limit (25 MiB).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LIMIT = 25 * 1024 * 1024;
const dist = resolve(import.meta.dirname, '../dist');
let total = 0,
  biggest = ['', 0],
  bad = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n),
      s = statSync(p);
    if (s.isDirectory()) walk(p);
    else {
      total += s.size;
      if (s.size > biggest[1]) biggest = [p, s.size];
      if (s.size > LIMIT) bad.push(p);
    }
  }
})(dist);
console.log(
  `check-dist: ${(total / 2 ** 20).toFixed(1)} MiB total, largest ${biggest[0].slice(dist.length + 1)} ${(biggest[1] / 2 ** 20).toFixed(1)} MiB`,
);
if (bad.length) {
  console.error(`check-dist: over 25 MiB: ${bad.join(', ')}`);
  process.exit(1);
}
