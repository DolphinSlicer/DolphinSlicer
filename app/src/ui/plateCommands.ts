// The plate's commands with desktop OrcaSlicer's shortcuts (slic3r/GUI/Shortcuts.cpp), for the
// keyboard, the toolbar over the 3D view and its context menu.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ArrowDownToLine,
  Brush,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eraser,
  Focus,
  LayoutGrid,
  type LucideIcon,
  Redo2,
  Rotate3d,
  Scissors,
  SquareMinus,
  SquarePlus,
  Trash2,
  Undo2,
} from 'lucide-react';
import { t, tr } from '../i18n/i18n';
import { cancelSlice } from '../state/actions';
import { setPaint, stopPainting, togglePainting } from '../state/paintActions';
import {
  addInstance,
  arrangeAll,
  autoOrient,
  clone,
  copy,
  cut,
  deleteAll,
  deleteSelected,
  deselectAll,
  moveSelection,
  paste,
  redo,
  removeInstance,
  rotateSelection,
  selectAll,
  toggleLayOnFace,
  undo,
} from '../state/plate';
import { type AppState, get } from '../state/store';
import { Viewport } from '../view/Viewport';
import { viewport } from './ViewportView';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const CTRL = isMac ? '⌘' : 'Ctrl+';

export interface Command {
  id: string;
  label: () => string;
  /** The shortcut as shown (none: empty). */
  keys: string;
  icon?: LucideIcon;
  enabled: (s: AppState) => boolean;
  run: () => void;
}

const some = (s: AppState) => s.selected.length > 0;
const any = (s: AppState) => s.objects.length > 0;

export const COMMANDS = {
  undo: { id: 'undo', label: () => t('Undo'), keys: `${CTRL}Z`, icon: Undo2, enabled: (s) => s.history.undo, run: undo },
  redo: { id: 'redo', label: () => t('Redo'), keys: `${CTRL}Y`, icon: Redo2, enabled: (s) => s.history.redo, run: redo },
  copy: { id: 'copy', label: () => t('Copy'), keys: `${CTRL}C`, icon: Copy, enabled: some, run: copy },
  cut: { id: 'cut', label: () => t('Cut'), keys: `${CTRL}X`, icon: Scissors, enabled: some, run: cut },
  paste: { id: 'paste', label: () => t('Paste'), keys: `${CTRL}V`, icon: ClipboardPaste, enabled: (s) => s.canPaste, run: paste },
  clone: { id: 'clone', label: () => t('Clone'), keys: `${CTRL}K`, icon: CopyPlus, enabled: some, run: clone },
  addInstance: { id: 'add-instance', label: () => t('Add instance'), keys: '+', icon: SquarePlus, enabled: some, run: addInstance },
  removeInstance: {
    id: 'remove-instance',
    label: () => t('Remove instance'),
    keys: '−',
    icon: SquareMinus,
    enabled: (s) => s.objects.some((o) => s.selected.includes(o.id) && o.instances.length > 1),
    run: removeInstance,
  },
  arrange: {
    id: 'arrange',
    label: () => t('Arrange'),
    keys: 'A',
    icon: LayoutGrid,
    enabled: (s) => any(s) && !s.arranging && !!s.presets.config,
    run: () => void arrangeAll(),
  },
  orient: {
    id: 'orient',
    label: () => t('Auto orient'),
    keys: 'Q',
    icon: Rotate3d,
    enabled: (s) => any(s) && !s.orienting,
    run: () => void autoOrient(),
  },
  layOnFace: {
    id: 'lay-on-face',
    label: () => t('Lay on face'),
    keys: 'F',
    icon: ArrowDownToLine,
    enabled: (s) => s.selected.length === 1 && !s.painting,
    run: () => toggleLayOnFace(),
  },
  supports: {
    id: 'paint-supports',
    label: () => tr('Support Painting'),
    keys: 'L',
    icon: Brush,
    enabled: (s) => s.selected.length === 1,
    run: togglePainting,
  },
  selectAll: { id: 'select-all', label: () => t('Select all'), keys: `${CTRL}A`, enabled: any, run: selectAll },
  delete: { id: 'delete', label: () => t('Delete'), keys: isMac ? '⌫' : 'Del', icon: Trash2, enabled: some, run: deleteSelected },
  deleteAll: { id: 'delete-all', label: () => t('Delete all'), keys: `${CTRL}D`, icon: Eraser, enabled: any, run: deleteAll },
  fitView: { id: 'fit-view', label: () => t('Fit view'), keys: '', icon: Focus, enabled: () => true, run: () => fitView() },
} satisfies Record<string, Command>;

/**
 * Desktop's camera views (MainFrame: Ctrl+0 default, Ctrl+1–6 the sides, Ctrl+7 the plate),
 * on the plain number keys: browsers keep Ctrl (Cmd) with a number for switching tabs.
 */
type View = 'plate' | 'top' | 'bottom' | 'front' | 'rear' | 'left' | 'right';
const view = (v: View) => () => viewport()?.setView(v);
export const VIEWS: Command[] = [
  { id: 'view-default', label: () => t('Default view'), keys: '0', enabled: () => true, run: () => viewport()?.home() },
  { id: 'view-top', label: () => t('Top view'), keys: '1', enabled: () => true, run: view('top') },
  { id: 'view-bottom', label: () => t('Bottom view'), keys: '2', enabled: () => true, run: view('bottom') },
  { id: 'view-front', label: () => t('Front view'), keys: '3', enabled: () => true, run: view('front') },
  { id: 'view-rear', label: () => t('Rear view'), keys: '4', enabled: () => true, run: view('rear') },
  { id: 'view-left', label: () => t('Left view'), keys: '5', enabled: () => true, run: view('left') },
  { id: 'view-right', label: () => t('Right view'), keys: '6', enabled: () => true, run: view('right') },
  { id: 'view-plate', label: () => t('Fit plate'), keys: '7', enabled: () => true, run: () => viewport()?.fitBed() },
];

/** Desktop's "fit camera to scene or selected object": from the front and above, the selection or else the bed. */
function fitView() {
  const vp = viewport();
  if (!vp) return;
  const s = get();
  if (s.view === 'prepare' && s.selected.length) vp.fitObjects(s.selected, Viewport.HOME_DIRECTION);
  else vp.fitBed(Viewport.HOME_DIRECTION);
}

/** The command a key press is for on the Prepare view, if any. */
function commandFor(ev: KeyboardEvent): (() => void) | null {
  const mod = isMac ? ev.metaKey : ev.ctrlKey;
  if (ev.altKey || (isMac && ev.ctrlKey)) return null;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const c = COMMANDS;
  if (mod) {
    if (key === 'z') return ev.shiftKey ? c.redo.run : c.undo.run;
    if (ev.shiftKey) return null;
    return (
      (
        { y: c.redo.run, c: c.copy.run, x: c.cut.run, v: c.paste.run, k: c.clone.run, a: c.selectAll.run, d: c.deleteAll.run } as Record<
          string,
          () => void
        >
      )[key] ?? null
    );
  }
  if (ev.metaKey || ev.ctrlKey) return null;
  // Arrows move by 10 mm, with Shift by 1 mm; Page Up and Down turn by 45°.
  const step = ev.shiftKey ? 1 : 10;
  const move = (
    { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] } as Record<string, [number, number]>
  )[key];
  if (move) return () => moveSelection(...move);
  if (key === 'PageUp') return () => rotateSelection(45);
  if (key === 'PageDown') return () => rotateSelection(-45);
  if (key === '+' || ev.code === 'NumpadAdd' || (key === '=' && !ev.shiftKey)) return c.addInstance.run;
  if (key === '-' || ev.code === 'NumpadSubtract') return c.removeInstance.run;
  if (ev.shiftKey) return null;
  return (
    (
      { delete: c.delete.run, backspace: c.delete.run, a: c.arrange.run, q: c.orient.run, f: c.layOnFace.run, l: c.supports.run } as Record<
        string,
        () => void
      >
    )[key.toLowerCase()] ?? null
  );
}

/** Text fields take every key themselves. */
const TEXT =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Other controls (tabs, lists, sliders, menus) take only the keys that move in or press them. */
const WIDGET =
  'input, [role=combobox], [role=listbox], [role=option], [role=slider], [role=tab], [role=menu], [role=menuitem], [role=radio]';
const WIDGET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ']);

/** The window's key handler: the plate's shortcuts while the Prepare view is shown. */
export function onPlateKey(ev: KeyboardEvent) {
  if (ev.defaultPrevented) return;
  const s = get();
  const target = ev.target as Element | null;
  if (target?.closest?.(TEXT)) return;
  if (WIDGET_KEYS.has(ev.key) && target?.closest?.(WIDGET)) return;
  // A dialog is open over the page.
  if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
  if (ev.key === 'Escape' && s.slice.state === 'running') {
    cancelSlice();
    return;
  }
  if (s.menu) return;
  // Camera views, in the 3D view (Prepare and Preview).
  if ((s.view === 'prepare' || s.view === 'preview') && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
    const v = VIEWS.find((c) => c.keys === ev.key);
    if (v) {
      ev.preventDefault();
      v.run();
      return;
    }
  }
  if (s.view !== 'prepare') return;
  // Painting: its tools (desktop's C, S, F and G); Escape ends it.
  if (s.painting && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const tool = ({ c: 'circle', s: 'sphere', f: 'fill', g: 'gap_fill' } as const)[ev.key.toLowerCase() as 'c' | 's' | 'f' | 'g'];
    if (tool) {
      ev.preventDefault();
      setPaint({ tool });
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      stopPainting();
      return;
    }
  }
  if (ev.key === 'Escape') {
    if (s.layOnFace) toggleLayOnFace(false);
    else if (s.selected.length) deselectAll();
    else return;
    ev.preventDefault();
    return;
  }
  // Copy and cut leave text the user selected on the page to the browser.
  if ((ev.ctrlKey || ev.metaKey) && ['c', 'x'].includes(ev.key.toLowerCase()) && String(window.getSelection() ?? '')) return;
  const run = commandFor(ev);
  if (!run) return;
  ev.preventDefault();
  run();
}
