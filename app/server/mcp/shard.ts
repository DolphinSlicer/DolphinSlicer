// The system profiles split by preset name for the MCP server (scripts/bundle-profiles.mjs writes
// them, profiles.ts reads them): profiles/<hash>/presets/<shard>.json holds
// {"<preset name>": {"<vendor>": "<the preset file's text>"}}. A request then reads one small
// file per preset instead of a vendor's whole bundle (up to 6 MB to parse).
// SPDX-License-Identifier: AGPL-3.0-or-later

export const SHARDS = 256;

/** The shard of a preset name (FNV-1a). */
export function presetShard(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHARDS;
}
