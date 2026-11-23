// A dialog's keyboard focus: put into the dialog when it opens, kept inside it (Tab goes round),
// and given back to where it was when the dialog closes.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from 'react';

/** The dialogs open now, the topmost last. */
const open: HTMLElement[] = [];
/** What had the focus lately, the latest last: a dialog's own field may take it before the dialog
 * gets to look. */
const trail: HTMLElement[] = [];
document.addEventListener(
  'focusin',
  (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    trail.push(e.target);
    if (trail.length > 4) trail.shift();
  },
  true,
);

/** The ref for the dialog's element. */
export function useModal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const back = [...trail].reverse().find((x) => !el.contains(x)) ?? null;
    open.push(el);
    // Unless a field of the dialog took the focus already.
    if (!el.contains(document.activeElement)) {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      // Not below another dialog, nor closing (Presence); a confirmation (a modal <dialog>) keeps the focus by itself.
      if (e.key !== 'Tab' || open[open.length - 1] !== el || el.closest('[inert]') || document.querySelector('dialog:modal')) return;
      const items = [...el.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter(
        (x) => x.tabIndex >= 0 && !x.matches(':disabled') && x.getClientRects().length > 0,
      );
      const first = items[0],
        last = items[items.length - 1];
      const at = document.activeElement;
      const inside = at !== el && el.contains(at);
      if (!first || !last) e.preventDefault();
      else if (!inside || at === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      open.splice(open.indexOf(el), 1);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
