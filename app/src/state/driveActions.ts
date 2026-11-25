// Sync of the user presets, the model library, the printers chosen for it and the app's settings
// with Google Drive, or with the storage folder of a self-hosted server when it has one (always
// on, no sign-in): connecting, syncing and when to sync (start-up, after a preset is saved,
// deleted or imported, and when the tab comes back into view).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthExpired, Drive } from '../drive/api';
import {
  type DriveAccount,
  loadAccount,
  probeService,
  refreshToken,
  revoke,
  SignInError,
  saveAccount,
  signIn,
  tokenValid,
} from '../drive/auth';
import { findServerStorage, ServerFolder } from '../drive/server';
import type { RemoteStore } from '../drive/storage';
import { type SyncState, syncFiles } from '../drive/sync';
import { t } from '../i18n/i18n';
import { loadUserStore, onUserFilesSaved } from '../presets/userStore';
import { describeError } from '../ui/errors';
import { editedPresetFiles, reloadUserPresets } from './actions';
import { syncModels } from './libraryActions';
import { syncPrinters } from './printerActions';
import { onSettingChange } from './settingsMeta';
import { syncSettings } from './settingsSync';
import { type DriveUi, get, notify, set, useApp } from './store';

const STATE_KEY = 'dolphin-slicer.drive.sync.v1';

/** The server's storage folder, when the app is self-hosted with one: then used instead of Drive. */
let server: ServerFolder | null = null;

/** `email`: whose state it is (the Google account, or "server:" and the storage folder's URL). */
function loadState(email: string): SyncState {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as { email: string; state: SyncState } | null;
    if (v?.email === email) return v.state;
  } catch {
    /* start over */
  }
  return { files: {} };
}
function saveState(email: string, state: SyncState | null) {
  try {
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify({ email, state }));
    else localStorage.removeItem(STATE_KEY);
  } catch {
    /* the next sync compares contents again */
  }
}

const setDrive = (d: Partial<DriveUi>) => set((s) => ({ drive: { ...s.drive, ...d } }));

let expiredNoticeShown = false;
function expired() {
  setDrive({ status: 'expired' });
  if (expiredNoticeShown) return;
  expiredNoticeShown = true;
  notify({
    kind: 'info',
    title: t('Google Drive'),
    message: t('Sign in again to sync your presets and models.'),
    action: { label: t('Sign in'), run: () => void connectDrive() },
  });
}

let pending: AbortController | null = null;

/** Stop waiting for the sign-in popup. The page cannot see whether the popup was closed. */
export function cancelSignIn() {
  pending?.abort();
}

/**
 * Sign in (a popup; call from a click) and sync. Also used to sign in again after an hour.
 * Clicking again while a sign-in is pending starts over (e.g. after closing the popup).
 */
export async function connectDrive() {
  pending?.abort();
  const ctrl = (pending = new AbortController());
  const prev = loadAccount();
  setDrive({ status: 'signing-in', message: undefined });
  try {
    const { token, expires } = await signIn(prev?.email, ctrl.signal);
    const email = await new Drive(token).email();
    saveAccount({ email, token, expires });
    if (prev?.email && prev.email !== email) saveState(prev.email, null);
    expiredNoticeShown = false;
    pending = null;
    setDrive({ email, status: 'idle' });
    await syncDrive();
  } catch (e) {
    // A newer attempt took over: leave the state to it.
    if (pending !== ctrl) return;
    setDrive({ status: prev ? 'expired' : 'off', email: prev?.email ?? null });
    if (ctrl.signal.aborted) return;
    if (e instanceof SignInError) notify({ kind: 'warning', title: t('Google Drive'), message: t(e.message) });
    else notify({ kind: 'error', ...describeError(e), title: t('Google Drive') });
  }
}

/** Stop syncing. Presets stay on this device and in Drive. */
export async function disconnectDrive() {
  const a = loadAccount();
  saveAccount(null);
  if (a) {
    saveState(a.email, null);
    void revoke(a.token);
  }
  setDrive({ email: null, status: 'off', lastSync: undefined, message: undefined, waiting: undefined });
}

let running: Promise<void> | null = null;
let again = false;
/** Sync now (or right after the sync that is running). */
export function syncDrive(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** An access token for the account: the stored one while valid, else a new one from the token service. */
async function accessToken(a: DriveAccount, renew = false): Promise<string | null> {
  if (!renew && tokenValid(a)) return a.token;
  const t = await refreshToken();
  if (!t) return null;
  saveAccount({ ...a, ...t });
  return t.token;
}

async function syncOnce() {
  const a = server ? null : loadAccount();
  if (!server && !a) return;
  // The engine's preset bundle must be loaded: pulled presets are loaded into it.
  if (get().presets.status !== 'ready') {
    if (a && !tokenValid(a) && !(await probeService())) expired();
    return;
  }
  setDrive({ status: 'syncing', message: undefined });
  try {
    let remote: RemoteStore;
    if (server) remote = server;
    else {
      const token = await accessToken(a!);
      if (!token) {
        expired();
        return;
      }
      remote = new Drive(token);
    }
    const key = server ? `server:${server.base}` : a!.email;
    const store = await loadUserStore();
    // The files of presets with unsaved edits wait; the others are loaded, keeping those edits.
    const edited = editedPresetFiles(store.files);
    const sync = async (d: RemoteStore) => {
      const r = await syncFiles(d, store.files, store.mtimes, loadState(key), (p) => !edited.has(p));
      await syncModels(d);
      await syncPrinters(d);
      return r;
    };
    let r: Awaited<ReturnType<typeof sync>>;
    try {
      r = await sync(remote);
    } catch (e) {
      // Rejected before its time (e.g. revoked and granted again): renew once.
      if (!(e instanceof AuthExpired) || !a) throw e;
      const token = await accessToken(a, true);
      if (!token) {
        expired();
        return;
      }
      remote = new Drive(token);
      r = await sync(remote);
    }
    saveState(key, r.state);
    if (r.files) await reloadUserPresets(r.files, r.mtimes);
    // After the presets: the selected ones may have just come from the other devices.
    await syncSettings(remote);
    if (r.conflicts.length) {
      const names = r.conflicts
        .filter((p) => p.endsWith('.json'))
        .map((p) =>
          p
            .split('/')
            .pop()!
            .replace(/\.json$/, ''),
        )
        .join(', ');
      notify({
        kind: 'warning',
        title: t('Changed on two devices'),
        message: server
          ? t('Kept the newer version of: {names}. The other one is in the Conflicts folder on the server.', { names })
          : t('Kept the newer version of: {names}. The other one is in the Conflicts folder in Google Drive.', { names }),
      });
    }
    setDrive({ status: 'idle', lastSync: Date.now(), waiting: r.waiting });
  } catch (e) {
    if (e instanceof AuthExpired) {
      expired();
      return;
    }
    setDrive({ status: 'error', message: describeError(e).message });
  }
}

let debounce = 0;
/** Whether this device syncs (signed in to Drive, or self-hosted with storage). */
export function syncing(): boolean {
  return !!server || !!loadAccount();
}

/** Sync soon (after a change), if signed in. */
export function requestSync(delay = 800) {
  if (!syncing()) return;
  clearTimeout(debounce);
  debounce = window.setTimeout(() => void syncDrive(), delay);
}

/**
 * Where the synced files are: the server's storage, or Drive with a valid access token (renewed
 * through the token service if needed); null when signed out.
 */
export async function remoteStore(): Promise<RemoteStore | null> {
  if (server) return server;
  const a = loadAccount();
  if (!a) return null;
  const token = await accessToken(a);
  if (!token) expired();
  return token ? new Drive(token) : null;
}

/** Restore the account, or find the server's storage, and sync when it makes sense. Call once at start. */
export function initDrive() {
  if (window.isSecureContext) {
    const a = loadAccount();
    // With the token service an expired token is renewed at the first sync, without asking.
    if (a) setDrive({ email: a.email, status: 'idle' });
    void probeService();
  }
  void findServerStorage().then((base) => {
    if (base) {
      server = new ServerFolder(base);
      setDrive({ server: true, email: null, status: 'idle' });
    } else if (!window.isSecureContext) return;
    start();
  });
}

function start() {
  // First sync once the presets are loaded.
  const first = () => {
    if (get().presets.status !== 'ready') return false;
    unsub();
    void syncDrive();
    return true;
  };
  const unsub = useApp.subscribe(first);
  first();
  onUserFilesSaved(() => requestSync());
  // Settings change in small steps (a preset picked, then another): synced once they settle.
  onSettingChange(() => requestSync(3000));
  document.addEventListener('visibilitychange', () => {
    const d = get().drive;
    if (document.visibilityState === 'visible' && (d.email || d.server) && d.status === 'idle' && Date.now() - (d.lastSync ?? 0) > 60_000)
      void syncDrive();
  });
}
