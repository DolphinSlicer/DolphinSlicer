// The plate's toolbar over the 3D view (as desktop's), and its context menu (a right click on an
// object, the plate or the object list). Commands and shortcuts: plateCommands.ts.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n/i18n';
import { set, useApp } from '../state/store';
import { COMMANDS, type Command, VIEWS } from './plateCommands';

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
const OBJECT_MENU: (Command | null)[] = [
  C.copy,
  C.cut,
  C.paste,
  C.clone,
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
const PLATE_MENU: (Command | null)[] = [
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

/** The context menu, while open (state.menu). */
export function PlateMenu() {
  const s = useApp();
  const menu = s.menu;
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const openedAt = useRef(0);
  // Inside the window, then the first item focused (so the keyboard works in it).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) {
      setAt(null);
      return;
    }
    openedAt.current = performance.now();
    const r = el.getBoundingClientRect();
    setAt({ x: Math.max(4, Math.min(menu.x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(menu.y, innerHeight - r.height - 4)) });
  }, [menu]);
  useEffect(() => {
    if (at) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  if (!menu) return null;
  const close = () => set({ menu: null });
  const items = menu.id ? OBJECT_MENU : PLATE_MENU;
  const move = (e: React.KeyboardEvent, by: number) => {
    const list = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
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
        aria-label={t('Plate')}
        data-testid="plate-menu"
        style={{ left: at?.x ?? menu.x, top: at?.y ?? menu.y, visibility: at ? 'visible' : 'hidden' }}
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
