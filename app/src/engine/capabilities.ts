// Which engine build this browser session can run.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { N_ } from '../i18n/i18n';
import type { EngineFlavor } from './types';

export interface ThreadSupport {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  cores: number;
  /** Why the multithreaded engine is not used, if it is not. */
  reason: string | null;
}

export function threadSupport(): ThreadSupport {
  const isolated = globalThis.crossOriginIsolated === true;
  const sab = typeof SharedArrayBuffer !== 'undefined';
  const cores = navigator.hardwareConcurrency || 1;
  let reason: string | null = null;
  if (!isolated) reason = N_('The page is not cross-origin isolated (COOP/COEP headers missing), so threads are unavailable.');
  else if (!sab) reason = N_('This browser does not provide SharedArrayBuffer.');
  return { crossOriginIsolated: isolated, sharedArrayBuffer: sab, cores, reason };
}

/** `?threads=0` forces the single-threaded engine (debugging, comparisons). */
export function chooseFlavor(search = location.search): EngineFlavor {
  const forced = new URLSearchParams(search).get('threads');
  if (forced === '0') return 'st';
  const t = threadSupport();
  return t.reason === null ? 'mt' : 'st';
}

export const debugMode = () => new URLSearchParams(location.search).has('debug');
