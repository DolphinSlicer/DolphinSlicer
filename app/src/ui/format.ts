// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatNumber } from '../state/prefs';
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${formatNumber(v, v < 10 ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(s: number): string {
  s = Math.floor(s); // whole seconds, as desktop and the G-code show them
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
