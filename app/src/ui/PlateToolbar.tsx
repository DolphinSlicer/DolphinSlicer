// The plate's toolbar over the 3D view (as desktop's), and its context menu (a right click on an
// object, the plate or the object list). Commands and shortcuts: plateCommands.ts.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n/i18n';
import { type AppState, set, useApp } from '../state/store';
import { COMMANDS, type Command, SUPPORT_MENUS, type Submenu, VIEWS } from './plateCommands';

const C = COMMANDS;
const GROUPS: Command[][] = [
  [C.undo, C.redo],
  [C.arrange, C.orient, C.layOnFace, C.supports],
  [C.addInstance, C.removeInstance, C.clone],
  [C.copy, C.cut, C.paste],
  [C.delete, C.deleteAll],
];

export function PlateToolbar() {
  const s = useApp();
  return (
    <div className="plate-toolbar" role="toolbar" aria-label={t('Plate')} data-testid="plate-toolbar">
      {GROUPS.map((g, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sep" aria-hidden />}
          {g.map((c) => {
            const Icon = c.icon!;
            const tip = c.keys ? `${c.label()} (${c.keys})` : c.label();
            const pressed = c === C.layOnFace ? s.layOnFace : c === C.supports ? !!s.painting : undefined;
            return (
              <button
                key={c.id}
                type="button"
                className={`icon-btn${c === C.delete || c === C.deleteAll ? ' danger' : ''}${pressed ? ' on' : ''}`}
                aria-label={c.label()}
                aria-pressed={pressed}
                aria-keyshortcuts={c.keys || undefined}
                data-tip={tip}
                data-testid={`plate-${c.id}`}
                disabled={!c.enabled(s)}
                onClick={() => c.run()}
              >
                {(c === C.orient && s.orienting) || (c === C.arrange && s.arranging) ? <span className="spinner" /> : <Icon size={17} />}
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

// Fit view frames the selection: on an object's menu (a right click selects the object).
const OBJECT_MENU: (Command | Submenu | null)[] = [
  C.copy,
  C.cut,
  C.paste,
  C.clone,
  null,
  ...SUPPORT_MENUS,
  null,
  C.addInstance,
  C.removeInstance,
  null,
  C.layOnFace,
  C.orient,
  null,
  C.fitView,
  null,
  C.delete,
];
const PLATE_MENU: (Command | Submenu | null)[] = [
  C.paste,
  C.selectAll,
  null,
  C.arrange,
  C.orient,
  null,
  C.undo,
  C.redo,
  null,
  C.deleteAll,
  null,
  ...VIEWS,
];

/** The plate's context menu, while open (state.menu). */
export function PlateMenu() {
  const menu = useApp((s) => s.menu);
  if (!menu) return null;
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menu.id ? OBJECT_MENU : PLATE_MENU}
      label={t('Plate')}
      testid="plate-menu"
      onClose={() => set({ menu: null })}
    />
  );
}

/**
 * A context menu at (x, y), kept inside the window, its first entry focused (the keyboard works
 * in it); a click elsewhere, Escape or Tab closes it.
 */
export function ContextMenu({
  x,
  y,
  items,
  label,
  testid,
  onClose,
}: {
  x: number;
  y: number;
  items: (Command | Submenu | null)[];
  label: string;
  testid: string;
  onClose: () => void;
}) {
  const s = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const openedAt = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    openedAt.current = performance.now();
    const r = el.getBoundingClientRect();
    setAt({ x: Math.max(4, Math.min(x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    if (at) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  const close = onClose;
  const move = (e: React.KeyboardEvent, by: number) => {
    const list = [
      ...ref.current!.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled), :scope > .submenu > button:not(:disabled)'),
    ];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + by + list.length) % list.length]?.focus();
    e.preventDefault();
  };
  return (
    // On Windows the browser's contextmenu event comes after the button is let go, when this menu
    // is already open: that one is the click that opened it, not a click elsewhere.
    <div
      className="menu-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (performance.now() - openedAt.current > 300) close();
      }}
    >
      <div
        ref={ref}
        className="menu"
        role="menu"
        aria-label={label}
        data-testid={testid}
        style={{ left: at?.x ?? x, top: at?.y ?? y, visibility: at ? 'visible' : 'hidden' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            close();
          }
          if (e.key === 'ArrowDown') move(e, 1);
          if (e.key === 'ArrowUp') move(e, -1);
        }}
      >
        {items.map((c, i) =>
          c === null ? (
            <hr key={i} />
          ) : 'items' in c ? (
            <SubmenuItem key={c.id} sub={c} s={s} close={close} />
          ) : (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              disabled={!c.enabled(s)}
              data-testid={`menu-${c.id}`}
              onClick={() => {
                close();
                c.run();
              }}
            >
              {c.icon ? <c.icon size={15} /> : <span />}
              <span>{c.label()}</span>
              <kbd>{c.keys}</kbd>
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** An entry with more beside it: open while pointed at, by a click, or by → (← closes it). */
function SubmenuItem({ sub, s, close }: { sub: Submenu; s: AppState; close: () => void }) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const enabled = sub.enabled(s);
  // Beside the menu, on the left when the right has no room.
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    setLeft(self.current!.getBoundingClientRect().right + el.offsetWidth > innerWidth - 4);
  }, [open]);
  const focusFirst = () => requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
  return (
    <div
      ref={self}
      className="submenu"
      onPointerEnter={() => enabled && setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && enabled && !open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
          focusFirst();
        } else if (e.key === 'ArrowLeft' && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          self.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
        } else if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.current?.contains(document.activeElement)) {
          e.preventDefault();
          e.stopPropagation();
          const all = [...list.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const i = all.indexOf(document.activeElement as HTMLButtonElement);
          all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        data-testid={`menu-${sub.id}`}
        onClick={() => {
          setOpen(true);
          focusFirst();
        }}
      >
        {sub.icon ? <sub.icon size={15} /> : <span />}
        <span>{sub.label()}</span>
        <ChevronRight size={14} className="submenu-arrow" />
      </button>
      {open && (
        <div ref={list} className={`menu submenu-list${left ? ' left' : ''}`} role="menu" aria-label={sub.label()}>
          {sub.items.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              disabled={!c.enabled(s)}
              data-testid={`menu-${c.id}`}
              onClick={() => {
                close();
                c.run();
              }}
            >
              {c.icon ? <c.icon size={15} /> : <span />}
              <span>{c.label()}</span>
              <kbd>{c.keys}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
