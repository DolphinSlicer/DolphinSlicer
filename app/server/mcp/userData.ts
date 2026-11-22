// The user's DolphinSlicer data in Google Drive, as the app's Drive sync keeps it:
//   DolphinSlicer/settings.json         preferences, printer and filament library, the selected presets
//   DolphinSlicer/Presets/<dir>/<name>.json   user presets in desktop's format (dir: machine, filament, process)
// A preset saved here reaches the app at its next sync, like one saved on another device.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Drive } from '../../src/drive/api';
import { type PresetJson, type PresetType, TYPE_DIR } from './profiles';

const APP = 'DolphinSlicer',
  PRESETS = 'Presets',
  SETTINGS = 'settings.json',
  FOLDER = 'application/vnd.google-apps.folder';

export interface SyncedSettings {
  library?: { printers?: { vendor: string; model: string; nozzle: string }[]; filaments?: string[] };
  selection?: { vendor?: string; printer?: string; process?: string; filament?: string };
  units?: string;
  currency?: string;
  bedTypes?: Record<string, string>;
}

export class UserData {
  readonly drive: Drive;
  private app?: Promise<string | null>;
  private presetDirs?: Promise<Map<PresetType, { id: string; files: { id: string; name: string }[] }>>;

  constructor(token: string) {
    this.drive = new Drive(token);
  }

  private async child(parent: string, name: string, folder: boolean) {
    return (await this.drive.children(parent)).find((f) => f.name === name && (f.mimeType === FOLDER) === folder);
  }

  /** The DolphinSlicer folder, or null when Drive sync never ran. */
  appFolder(): Promise<string | null> {
    this.app ??= this.child('root', APP, true).then((f) => f?.id ?? null);
    return this.app;
  }

  async settings(): Promise<SyncedSettings | null> {
    const app = await this.appFolder();
    const file = app && (await this.child(app, SETTINGS, false));
    if (!file) return null;
    try {
      const j = JSON.parse(await this.drive.download(file.id)) as { settings?: Record<string, { value?: unknown }> };
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(j.settings ?? {})) out[k] = v?.value;
      return out as SyncedSettings;
    } catch {
      return null;
    }
  }

  /** The user preset files of each type. */
  private dirs() {
    this.presetDirs ??= (async () => {
      const out = new Map<PresetType, { id: string; files: { id: string; name: string }[] }>();
      const app = await this.appFolder();
      const root = app && (await this.child(app, PRESETS, true));
      if (!root) return out;
      const sub = await this.drive.children(root.id);
      await Promise.all(
        (Object.entries(TYPE_DIR) as [PresetType, string][]).map(async ([type, dir]) => {
          const f = sub.find((x) => x.name === dir && x.mimeType === FOLDER);
          if (!f) return;
          const files = (await this.drive.children(f.id)).filter((x) => x.mimeType !== FOLDER && x.name.endsWith('.json'));
          out.set(type, { id: f.id, files: files.map((x) => ({ id: x.id, name: x.name })) });
        }),
      );
      return out;
    })();
    return this.presetDirs;
  }

  /** The names of the user's presets by type. */
  async presetNames(): Promise<Record<PresetType, string[]>> {
    const d = await this.dirs();
    const names = (t: PresetType) => (d.get(t)?.files ?? []).map((f) => f.name.slice(0, -5)).sort((a, b) => a.localeCompare(b));
    return { printer: names('printer'), filament: names('filament'), print: names('print') };
  }

  /** A user preset's file, or null. */
  async preset(type: PresetType, name: string): Promise<PresetJson | null> {
    const f = (await this.dirs()).get(type)?.files.find((x) => x.name === `${name}.json`);
    if (!f) return null;
    try {
      const j = JSON.parse(await this.drive.download(f.id)) as PresetJson;
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch {
      return null;
    }
  }

  /** Save a user preset file (new or replacing the one of that name). */
  async savePreset(type: PresetType, name: string, text: string): Promise<'created' | 'updated'> {
    const existing = (await this.dirs()).get(type)?.files.find((x) => x.name === `${name}.json`);
    if (existing) {
      await this.drive.update(existing.id, text);
      return 'updated';
    }
    const app = (await this.appFolder()) ?? (await this.drive.folder('root', APP));
    const dir = await this.drive.folder(await this.drive.folder(app, PRESETS), TYPE_DIR[type]);
    await this.drive.create(dir, `${name}.json`, text);
    this.presetDirs = undefined;
    return 'created';
  }
}
