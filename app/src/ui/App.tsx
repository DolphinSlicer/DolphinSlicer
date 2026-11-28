// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BookmarkPlus,
  Box,
  CircleAlert,
  CircleCheck,
  Download,
  FileCode2,
  FileDown,
  Info,
  Layers,
  Library,
  Play,
  Printer,
  Send,
  Settings,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t, tr } from '../i18n/i18n';
import {
  cancelSlice,
  deleteObject,
  download3mf,
  downloadGcode,
  importFiles,
  isModelFile,
  openGcode,
  readNow,
  slice,
} from '../state/actions';
import { addModels, addPlateToLibrary } from '../state/libraryActions';
import { select } from '../state/plate';
import { dismiss, get, isStale, notify, set, useApp } from '../state/store';
import { deleteVolume, selectedVolume, selectVolume, TYPE_NAMES, volumeName } from '../state/supportVolumes';
import { About } from './About';
import { CalibrationButton } from './Calibration';
import { ConfirmHost } from './Confirm';
import { describeError } from './errors';
import { LibraryView } from './LibraryView';
import { LibraryWizard } from './LibraryWizard';
import { ObjectPanel, VolumePanel } from './ObjectPanel';
import { PaintPanel } from './PaintPanel';
import { PlateMenu, PlateToolbar } from './PlateToolbar';
import { Preferences } from './Preferences';
import { Presence } from './Presence';
import { PresetPanel } from './PresetPanel';
import { PreviewPanel } from './PreviewPanel';
import { PrintersDialog, SendDialog } from './Printers';
import { isMac, onPlateKey } from './plateCommands';
import { QuickSearch } from './QuickSearch';
import { QuickSettings } from './QuickSettings';
import { SegmentThumb } from './SegmentThumb';
import { importPresetFiles, PRESET_FILES, SettingsPanel } from './SettingsPanel';
import { SupportBlockerIcon, SupportEnforcerIcon } from './supportIcons';
import { useFit } from './useFit';
import { ViewportView } from './ViewportView';

/** Files from a drop. Some sources (archive tools, mail clients) expose them only as items. */
function droppedFiles(dt: DataTransfer): File[] {
  const files = [...dt.files];
  if (files.length) return files;
  return [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/** What the top bar gives up where it does not fit, in this order (styles.css): the button labels,
 * the app's name, the view icons, the view names (icons instead), the slice button's label. */
const TOPBAR_STEPS = ['labels', 'brand', 'tight', 'icons', 'slice'] as const;

export function App() {
  const view = useApp((s) => s.view);
  const painting = useApp((s) => s.painting);
  const volumeSelected = useApp((s) => selectedVolume(s) !== null);
  const sliceState = useApp((s) => s.slice);
  const engine = useApp((s) => s.engine);
  const importing = useApp((s) => s.importing);
  const parsing = useApp((s) => s.preview.parsing);
  const settingsType = useApp((s) => s.settingsType);
  // Re-render everything when the language changes.
  useApp((s) => s.lang);
  const [about, setAbout] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [printers, setPrinters] = useState(false);
  const [sending, setSending] = useState(false);
  const [searching, setSearching] = useState(false);
  const appActions = useMemo(
    () => ({
      send: () => setSending(true),
      printers: () => setPrinters(true),
      preferences: () => setPrefs(true),
      about: () => setAbout(true),
    }),
    [],
  );
  const wizard = useApp((s) => s.wizard);
  const [dragOver, setDragOver] = useState(false);
  // Files dragged over the window: the browser sends dragover again and again (at least every
  // ~350 ms, also when the pointer rests), so the overlay goes when they stop coming, whichever
  // way the drag ended (out of the window, Escape, a drop somewhere else).
  const dragGone = useRef(0);
  const dragGoneIn = useCallback((ms: number) => {
    clearTimeout(dragGone.current);
    dragGone.current = window.setTimeout(() => setDragOver(false), ms);
  }, []);
  const dragging = useCallback(() => {
    setDragOver(true);
    dragGoneIn(1000);
  }, [dragGoneIn]);
  const dragEnded = useCallback(() => {
    clearTimeout(dragGone.current);
    setDragOver(false);
  }, []);
  useEffect(() => {
    window.addEventListener('drop', dragEnded, true);
    window.addEventListener('dragend', dragEnded, true);
    return () => {
      window.removeEventListener('drop', dragEnded, true);
      window.removeEventListener('dragend', dragEnded, true);
      clearTimeout(dragGone.current);
    };
  }, [dragEnded]);
  const done = sliceState.state === 'done';
  const [topbar, compact] = useFit<HTMLElement>(TOPBAR_STEPS);
  // The name of a view shown as an icon only.
  const tip = (text: string) => (compact.includes('icons') ? text : undefined);

  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    setDragOver(false);
    // Something from the page itself (an image, selected text), not a file.
    if (!hasFiles(ev.dataTransfer)) return;
    const files = droppedFiles(ev.dataTransfer);
    if (!files.length) {
      notify({ kind: 'warning', title: t('Nothing to import'), message: t('Extract the file first, then try again.') });
      return;
    }
    // Read right away, inside the drop event (see readNow).
    const read = readNow(files);
    if (useApp.getState().view === 'library') {
      void addModels(read);
      return;
    }
    // As desktop: one G-code file to look at, and not together with models.
    const gcode = read.filter((f) => /\.gcode$/i.test(f.name));
    if (!gcode.length) void importFiles(read);
    else if (read.some((f) => isModelFile(f.name)))
      notify({ kind: 'warning', title: t('G-code files and models cannot be loaded together!') });
    else if (gcode.length > 1) notify({ kind: 'warning', title: t('Only one G-code file can be opened at a time.') });
    else void openGcode(gcode[0]!);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onPlateKey);
    return () => window.removeEventListener('keydown', onPlateKey);
  }, []);

  // Cmd+S (Ctrl+S), desktop's Save Project: the plate as a 3MF, in place of the browser's Save page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.key.toLowerCase() !== 's' || !mod || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (get().objects.length && !document.querySelector('[aria-modal="true"]:not([data-closing] *), dialog:modal')) void download3mf();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cmd+F (Ctrl+F), desktop's search shortcut: the quick search, also from a field; not over another dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.key.toLowerCase() !== 'f' || !mod || e.altKey || e.shiftKey) return;
      const other = document.querySelector('[aria-modal="true"]:not([data-testid="quick-search"], [data-closing] *), dialog:modal');
      if (other) return;
      e.preventDefault();
      setSearching((on) => !on);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The plate and unsaved setting edits live only in this page: ask before leaving it (reload,
  // close, another address), as desktop asks before closing. Browsers show their own wording.
  useEffect(() => {
    const onLeave = (ev: BeforeUnloadEvent) => {
      const s = useApp.getState();
      const dirty = s.presets.state && Object.values(s.presets.state.dirty).some(Boolean);
      if (!s.objects.length && !dirty) return;
      ev.preventDefault();
      ev.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  return (
    <div
      className="app"
      data-testid="app"
      data-engine={engine.flavor}
      data-engine-ready={engine.info ? 'yes' : 'no'}
      data-view={view}
      onDragOver={(e) => {
        e.preventDefault();
        if (!hasFiles(e.dataTransfer)) {
          e.dataTransfer.dropEffect = 'none';
          return;
        }
        // Archive tools (e.g. WinRAR) offer the file as "copy" only; without an explicit copy
        // effect the drop is refused.
        e.dataTransfer.dropEffect = 'copy';
        dragging();
      }}
      onDragLeave={(e) => {
        // Left for somewhere outside the app (no element: out of the window, or canceled). Not at
        // once: Safari names no element also within the page, where a dragover follows.
        const to = e.relatedTarget;
        if (!(to instanceof Node) || !e.currentTarget.contains(to)) dragGoneIn(100);
      }}
      onDrop={onDrop}
    >
      <header className="topbar" ref={topbar}>
        <div className="brand">
          <img className="logo" src="dolphin-slicer-mark.svg" alt="" />
          <span className="brand-name">DolphinSlicer</span>
        </div>
        <nav className="segmented" role="tablist" aria-label={t('View')}>
          <SegmentThumb />
          <button role="tab" data-tip={tip(t('Prepare'))} aria-selected={view === 'prepare'} onClick={() => set({ view: 'prepare' })}>
            <Box size={15} />
            <span className="tab-label">{t('Prepare')}</span>
          </button>
          <button
            role="tab"
            data-tip={tip(t('Preview'))}
            aria-selected={view === 'preview'}
            onClick={() => set({ view: 'preview' })}
            disabled={!done && view !== 'preview'}
          >
            <Layers size={15} />
            <span className="tab-label">{t('Preview')}</span>
          </button>
          <button
            role="tab"
            data-tip={tip(t('Library'))}
            aria-selected={view === 'library'}
            onClick={() => set({ view: 'library' })}
            data-testid="tab-library"
          >
            <Library size={15} />
            <span className="tab-label">{t('Library')}</span>
          </button>
          <button
            role="tab"
            data-tip={tip(t('Settings'))}
            aria-selected={view === 'settings'}
            onClick={() => set({ view: 'settings' })}
            data-testid="tab-settings"
          >
            <SlidersHorizontal size={15} />
            <span className="tab-label">{t('Settings')}</span>
          </button>
        </nav>
        <div className="actions">
          <ExportButton />
          <SendButton onClick={() => setSending(true)} />
          <SliceButton tip={compact.includes('slice')} />
          <button
            className="icon-btn"
            aria-label={t('Printers')}
            data-tip={t('Printers')}
            onClick={() => setPrinters(true)}
            data-testid="open-printers"
          >
            <Printer size={18} />
          </button>
          <button
            className="icon-btn"
            aria-label={t('Preferences')}
            data-tip={t('Preferences')}
            onClick={() => setPrefs(true)}
            data-testid="open-preferences"
          >
            <Settings size={18} />
          </button>
          <button className="icon-btn" aria-label={t('About')} data-tip={t('About')} onClick={() => setAbout(true)}>
            <Info size={18} />
          </button>
        </div>
      </header>

      <main className="stage">
        <ViewportView />
        <aside className="dock">
          <PresetPanel />
          <QuickSettings />
          <ObjectsCard />
        </aside>
        {view === 'prepare' && <PlateToolbar />}
        {view === 'prepare' && (painting ? <PaintPanel /> : volumeSelected ? <VolumePanel /> : <ObjectPanel />)}
        <PlateMenu />
        {((importing && view === 'prepare') || (parsing && view === 'preview')) && (
          <div className="loading-overlay" role="status" aria-label={t('Loading model')} data-testid="importing">
            <span className="spinner large" />
          </div>
        )}
        {view === 'preview' && <PreviewPanel />}
        {view === 'library' && <LibraryView />}
        {view === 'settings' && <SettingsPanel type={settingsType} onType={(t) => set({ settingsType: t })} />}
        {dragOver && (
          <div className="drop-overlay">
            <Upload size={28} />
            <span>{view === 'library' ? t('Drop to add to the library') : t('Drop to import')}</span>
          </div>
        )}
        <Notices />
        <ConfirmHost />
      </main>
      <Presence>{about && <About onClose={() => setAbout(false)} />}</Presence>
      <Presence>{prefs && <Preferences onClose={() => setPrefs(false)} />}</Presence>
      <Presence>{printers && <PrintersDialog onClose={() => setPrinters(false)} />}</Presence>
      <Presence>{sending && <SendDialog onClose={() => setSending(false)} />}</Presence>
      <Presence>{searching && <QuickSearch onClose={() => setSearching(false)} actions={appActions} />}</Presence>
      {/* The quick search's Import presets (the Settings tab's own input is there only with the tab). */}
      <input
        type="file"
        hidden
        multiple
        accept={PRESET_FILES}
        data-testid="preset-import-input"
        onChange={(e) => {
          const files = readNow([...(e.target.files ?? [])]);
          e.target.value = '';
          importPresetFiles(files).catch((err) => notify({ kind: 'error', ...describeError(err) }));
        }}
      />
      <Presence>{wizard && <LibraryWizard page={wizard} />}</Presence>
    </div>
  );
}

function SliceButton({ tip }: { tip: boolean }) {
  const s = useApp((st) => st.slice);
  const objects = useApp((st) => st.objects);
  const stale = useApp(isStale);
  const fromFile = useApp((st) => st.gcodeFromFile);
  if (s.state === 'running') {
    return (
      <div className="slice-progress" role="status" data-testid="slice-progress">
        <div className="fill" style={{ width: `${s.progress.percent}%` }} />
        <span className="stage-text">{tr(s.progress.message) || t('Slicing')}</span>
        <span className="pct">{s.progress.percent}%</span>
        <button className="cancel" onClick={cancelSlice} data-testid="cancel" aria-label={t('Cancel')} data-tip={t('Cancel')}>
          <X size={15} />
        </button>
      </div>
    );
  }
  const again = s.state === 'done' && !stale && !fromFile;
  const label = again ? t('Slice again') : t('Slice plate');
  return (
    <button
      className="btn primary slice"
      onClick={() => void slice()}
      disabled={!objects.length}
      data-testid="slice"
      data-tip={tip ? label : undefined}
    >
      <Play size={15} fill="currentColor" />
      <span className="slice-label">{label}</span>
    </button>
  );
}

function ExportButton() {
  const done = useApp((s) => s.slice.state === 'done');
  const stale = useApp(isStale);
  return (
    <button
      className="btn"
      onClick={downloadGcode}
      disabled={!done}
      data-testid="download"
      aria-label={done && stale ? t('Export G-code (outdated)') : t('Export G-code')}
      data-tip={done && stale ? t('The plate changed since this G-code was made') : t('Export G-code')}
    >
      <Download size={15} />
      <span className="btn-label">{done && stale ? t('Export G-code (outdated)') : t('Export G-code')}</span>
    </button>
  );
}

function SendButton({ onClick }: { onClick: () => void }) {
  const done = useApp((s) => s.slice.state === 'done');
  const stale = useApp(isStale);
  return (
    <button
      className="btn"
      onClick={onClick}
      disabled={!done}
      data-testid="send"
      aria-label={t('Send to printer')}
      data-tip={done && stale ? t('The plate changed since this G-code was made') : t('Send to printer')}
      data-stale={done && stale ? 'yes' : undefined}
    >
      <Send size={15} />
      <span className="btn-label">{t('Send')}</span>
    </button>
  );
}

function ObjectsCard() {
  const objects = useApp((s) => s.objects);
  const selected = useApp((s) => s.selected);
  const selectedVolume = useApp((s) => s.selectedVolume);
  const importing = useApp((s) => s.importing);
  const slicing = useApp((s) => s.slice.state === 'running');
  const fileInput = useRef<HTMLInputElement>(null);
  const gcodeInput = useRef<HTMLInputElement>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {t('Objects')}
          {objects.length > 0 && <span className="count">{objects.length}</span>}
        </h2>
        <div className="card-tools">
          <button
            className="icon-btn"
            onClick={() => fileInput.current?.click()}
            disabled={importing}
            data-testid="import"
            aria-label={t('Import…')}
            data-tip={t('Import models')}
          >
            <Upload size={16} />
          </button>
          <CalibrationButton />
          <button
            className="icon-btn"
            onClick={() => void addPlateToLibrary()}
            disabled={!objects.length}
            data-testid="save-to-library"
            aria-label={t('Save plate to library')}
            data-tip={t('Save plate to library')}
          >
            <BookmarkPlus size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={() => void download3mf()}
            disabled={!objects.length}
            data-testid="download-3mf"
            aria-label={t('Download plate as 3MF')}
            data-tip={`${t('Download plate as 3MF')} (${isMac ? '⌘' : 'Ctrl+'}S)`}
          >
            <FileDown size={16} />
          </button>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".stl,.3mf,.obj,.amf"
        hidden
        data-testid="file-input"
        onChange={(e) => {
          void importFiles(readNow([...(e.target.files ?? [])]));
          e.target.value = '';
        }}
      />
      <input
        ref={gcodeInput}
        type="file"
        accept=".gcode"
        hidden
        data-testid="gcode-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openGcode(readNow([f])[0]!);
          e.target.value = '';
        }}
      />
      {objects.length > 0 ? (
        <ul className="objects" data-testid="object-list">
          {objects.map((o) => (
            <Fragment key={o.id}>
              <li
                className={[
                  selected.includes(o.id) && selectedVolume?.object !== o.id && 'selected',
                  (o.instances.length > 1 || o.hasConfig || o.painted) && 'with-meta',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onMouseDown={(e) => {
                  if (e.shiftKey) e.preventDefault();
                }}
                // Ctrl (Cmd) adds to or takes from the selection; Shift selects a range, as desktop's object list.
                onClick={(e) => select(o.id, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace')}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected.includes(o.id)) select(o.id);
                  set({ menu: { id: o.id, x: e.clientX, y: e.clientY } });
                }}
              >
                <Box size={15} className="obj-icon" />
                <span className="name" data-tip={o.name}>
                  {o.name}
                </span>
                {(o.instances.length > 1 || o.hasConfig || o.painted) && (
                  // As desktop's object list: copies, own settings, painted supports.
                  <span className="meta">
                    {[
                      o.instances.length > 1 ? `×${o.instances.length}` : '',
                      o.hasConfig ? t('custom settings') : '',
                      o.painted ? tr('Support Painting') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
                <button
                  className="icon-btn small"
                  aria-label={t('Delete {name}', { name: o.name })}
                  data-tip={t('Delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteObject(o.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </li>
              {/* Its support blockers and enforcers, as desktop's object list shows them. */}
              {o.volumes?.map((v) => {
                const name = volumeName(v);
                const on = selectedVolume?.object === o.id && selectedVolume.volume === v.id;
                const Icon = v.type === 'support_blocker' ? SupportBlockerIcon : SupportEnforcerIcon;
                return (
                  <li
                    key={v.id}
                    className={`volume with-meta ${v.type}${on ? ' selected' : ''}`}
                    data-testid="volume-row"
                    onClick={() => selectVolume(o.id, v.id)}
                  >
                    <Icon size={15} className="obj-icon" />
                    <span className="name" data-tip={name}>
                      {name}
                    </span>
                    <span className="meta">{tr(TYPE_NAMES[v.type])}</span>
                    <button
                      className="icon-btn small"
                      aria-label={t('Delete {name}', { name })}
                      data-tip={t('Delete')}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteVolume(o.id, v.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      ) : (
        <button className="dropzone" onClick={() => fileInput.current?.click()} disabled={importing}>
          <Upload size={18} />
          <span>{t('Import or drop models')}</span>
        </button>
      )}
      <button className="link-btn" onClick={() => gcodeInput.current?.click()} disabled={slicing}>
        <FileCode2 size={14} />
        {t('Open G-code')}
      </button>
    </section>
  );
}

/** Whether a drag carries files (and not a picture or text of the page itself). */
const hasFiles = (dt: DataTransfer) => [...dt.types].includes('Files');

const NOTICE_ICON = { error: CircleAlert, warning: TriangleAlert, info: CircleCheck } as const;

function Notices() {
  const notices = useApp((s) => s.notices);
  // Dismissed notices slide out first; the end of that animation removes them.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const leave = (id: number) => setLeaving((l) => new Set(l).add(id));
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => {
        const Icon = NOTICE_ICON[n.kind];
        // Information without a button closes by itself; the bar shows the time left.
        const timed = n.kind === 'info' && !n.action;
        return (
          <div
            key={n.id}
            className={`notice ${n.kind}${timed ? ' timed' : ''}${leaving.has(n.id) ? ' leaving' : ''}`}
            data-testid={`notice-${n.kind}`}
            data-code={n.code}
            onAnimationEnd={(e) => {
              if (e.animationName === 'toast-out') {
                dismiss(n.id);
                setLeaving((l) => {
                  const m = new Set(l);
                  m.delete(n.id);
                  return m;
                });
              }
            }}
          >
            <Icon size={18} className="notice-icon" />
            <div className="notice-body">
              <strong>{n.title}</strong>
              {n.message && <div>{n.message}</div>}
              {n.detail && (
                <details>
                  <summary>{t('Details')}</summary>
                  <pre>{n.detail}</pre>
                </details>
              )}
              {n.action && (
                <button
                  className="btn small notice-action"
                  onClick={() => {
                    dismiss(n.id);
                    n.action!.run();
                  }}
                >
                  {n.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn small" aria-label={t('Dismiss')} onClick={() => leave(n.id)}>
              <X size={14} />
            </button>
            {timed && (
              <span
                className="notice-timer"
                aria-hidden
                onAnimationEnd={(e) => {
                  e.stopPropagation();
                  leave(n.id);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
