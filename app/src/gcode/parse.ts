// What the app reads from G-code itself: desktop's line types (the preview's roles) and the
// printer a file was sliced for. The preview's moves come from the engine (see preview.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { N_ } from '../i18n/i18n';

/**
 * Feature types, in libvgcode's EGCodeExtrusionRole order (src/libvgcode/include/Types.hpp).
 * Desktop's names; shown translated with tr().
 */
export const ROLES: readonly string[] = [
  N_('Undefined'),
  N_('Inner wall'),
  N_('Outer wall'),
  N_('Overhang wall'),
  N_('Sparse infill'),
  N_('Internal solid infill'),
  N_('Top surface'),
  N_('Ironing'),
  N_('Bridge'),
  N_('Gap infill'),
  N_('Skirt'),
  N_('Support'),
  N_('Support interface'),
  N_('Prime tower'),
  N_('Custom'),
  N_('Bottom surface'),
  N_('Internal Bridge'),
  N_('Brim'),
  N_('Support transition'),
  N_('Multiple'),
];

/** Desktop preview colours (libvgcode DEFAULT_EXTRUSION_ROLES_COLORS), same order as ROLES. */
export const ROLE_COLORS: [number, number, number][] = [
  [230, 179, 179],
  [255, 230, 77],
  [255, 125, 56],
  [31, 31, 255],
  [176, 48, 41],
  [150, 84, 204],
  [240, 64, 64],
  [255, 140, 105],
  [77, 128, 186],
  [255, 255, 255],
  [0, 135, 110],
  [0, 255, 0],
  [0, 128, 0],
  [179, 227, 171],
  [94, 209, 148],
  [102, 92, 199],
  [77, 128, 186],
  [0, 59, 110],
  [0, 64, 0],
  [128, 128, 128],
];

/**
 * The printer preset named in G-code's settings block ("; printer_settings_id = …", as
 * OrcaSlicer, PrusaSlicer and their relatives write it); null when it isn't there.
 */
export function printerSettingsId(text: string): string | null {
  const m = /^; printer_settings_id = (.*?)\r?$/m.exec(text);
  return m?.[1]?.replace(/^"(.*)"$/, '$1').trim() || null;
}
