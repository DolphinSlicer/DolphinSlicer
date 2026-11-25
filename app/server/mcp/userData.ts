// The user's DolphinSlicer data in Google Drive, as the app's Drive sync keeps it:
//   DolphinSlicer/settings.json         preferences, printer and filament library, the selected presets
//   DolphinSlicer/Presets/<dir>/<name>.json   user presets in desktop's format (dir: machine, filament, process);
//   DolphinSlicer/Presets/<dir>/base/<name>.json   those with no parent (e.g. a printer made with Create Printer)
// A preset saved here reaches the app at its next sync, like one saved on another device.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Drive } from '../../src/drive/api';
import { tree } from '../../src/drive/storage';
import { type PresetJson, type PresetType, TYPE_DIR } from './profiles';

const APP = 'DolphinSlicer',
  PRESETS = 'Presets',
  SETTINGS = 'settings.json';

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
  private settingsChild?: Promise<{ id: string; modifiedTime: string } | undefined>;
  private presetTree?: Promise<{ root: string; folders: Map<string, string>; files: Map<string, string>; latest: string } | null>;

  constructor(token: string) {
    this.drive = new Drive(token);
  }

  private async child(parent: string, name: string, folder: boolean) {
    return (await this.drive.children(parent)).find((f) => f.name === name && f.folder === folder);
  }

  /** The DolphinSlicer folder, or null when Drive sync never ran. */
  appFolder(): Promise<string | null> {
    this.app ??= this.child('root', APP, true).then((f) => f?.id ?? null);
    return this.app;
  }

  private settingsFile() {
    this.settingsChild ??= this.appFolder().then((app) => (app ? this.child(app, SETTINGS, false) : undefined));
    return this.settingsChild;
  }

  async settings(): Promise<SyncedSettings | null> {
    const file = await this.settingsFile();
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

  /**
   * The user preset files ("machine/Name.json" → file id), read as the app's sync reads them:
   * the whole Presets tree, where folders of the same name count as one (Drive allows duplicates,
   * e.g. when two devices first synced at once).
   */
  private tree() {
    this.presetTree ??= (async () => {
      const app = await this.appFolder();
      const root = app && (await this.child(app, PRESETS, true));
      if (!root) return null;
      const t = await tree(this.drive, root.id);
      const latest = t.files.reduce((m, f) => (f.modifiedTime > m ? f.modifiedTime : m), '');
      return { root: root.id, folders: t.folders, files: new Map(t.files.map((f) => [f.path, f.id])), latest };
    })();
    return this.presetTree;
  }

  /** Where desktop keeps a preset: presets with no parent in "base". */
  private static path = (type: PresetType, name: string, base: boolean) => `${TYPE_DIR[type]}/${base ? 'base/' : ''}${name}.json`;

  /** A user preset's file id. */
  private async find(type: PresetType, name: string): Promise<string | undefined> {
    const files = (await this.tree())?.files;
    return files?.get(UserData.path(type, name, false)) ?? files?.get(UserData.path(type, name, true));
  }

  /** When DolphinSlicer last wrote the settings file and any preset file to Drive. */
  async updated(): Promise<{ settings: string | null; presets: string | null }> {
    const [file, tree] = await Promise.all([this.settingsFile(), this.tree()]);
    return { settings: file?.modifiedTime ?? null, presets: tree?.latest || null };
  }

  /** The names of the user's presets by type. */
  async presetNames(): Promise<Record<PresetType, string[]>> {
    const files = [...((await this.tree())?.files.keys() ?? [])];
    const names = (t: PresetType) => {
      const re = new RegExp(`^${TYPE_DIR[t]}/(?:base/)?([^/]+)\\.json$`);
      const found = files.map((p) => re.exec(p)?.[1]).filter((n): n is string => !!n);
      return [...new Set(found)].sort((a, b) => a.localeCompare(b));
    };
    return { printer: names('printer'), filament: names('filament'), print: names('print') };
  }

  /** A user preset's file, or null. */
  async preset(type: PresetType, name: string): Promise<PresetJson | null> {
    const id = await this.find(type, name);
    if (!id) return null;
    try {
      const j = JSON.parse(await this.drive.download(id)) as PresetJson;
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch {
      return null;
    }
  }

  /** Save a user preset file (new, or replacing the one of that name where it is). `base`: it has no parent. */
  async savePreset(type: PresetType, name: string, text: string, base: boolean): Promise<'created' | 'updated'> {
    const existing = await this.find(type, name);
    if (existing) {
      await this.drive.update(existing, text);
      return 'updated';
    }
    const tree = await this.tree();
    let dir = tree?.root ?? (await this.drive.folder((await this.appFolder()) ?? (await this.drive.folder('root', APP)), PRESETS));
    let path = '';
    for (const part of [TYPE_DIR[type], ...(base ? ['base'] : [])]) {
      path = path ? `${path}/${part}` : part;
      dir = tree?.folders.get(path) ?? (await this.drive.folder(dir, part));
    }
    await this.drive.create(dir, `${name}.json`, text);
    this.presetTree = undefined;
    return 'created';
  }
}
