// Tooltips for elements with a `data-tip` text, in place of the browser's own (`title`), which
// take about a second to show. One element in the top layer, so it shows above dialogs: after a
// short rest of the pointer, at once when moving on from another tooltip, and on keyboard focus.
// SPDX-License-Identifier: AGPL-3.0-or-later
const DELAY = 350;
/** Moving on to another element within this time shows its tooltip at once. */
const WARM = 400;
const GAP = 8,
  EDGE = 6;

let tip: HTMLDivElement | null = null;
let anchor: Element | null = null;
/** The element whose tooltip a click or key closed: not shown again until the pointer leaves it. */
let dismissed: Element | null = null;
/** The element the pointer rests on, its tooltip not shown yet. */
let pending: Element | null = null;
let timer = 0;
let hiddenAt = -Infinity;

function show(el: Element) {
  const text = el.getAttribute('data-tip');
  if (!text || !el.isConnected) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('popover', 'manual');
    document.body.append(tip);
  }
  anchor = el;
  tip.textContent = text;
  tip.lang = el.closest('[lang]')?.getAttribute('lang') ?? '';
  // Again on top of a dialog or list opened since.
  if (tip.matches(':popover-open')) tip.hidePopover();
  tip.showPopover();
  // Below the element, above it without room there; kept inside the window.
  const a = el.getBoundingClientRect(),
    w = tip.offsetWidth,
    h = tip.offsetHeight;
  const vw = document.documentElement.clientWidth,
    vh = document.documentElement.clientHeight;
  const below = a.bottom + GAP + h <= vh - EDGE || a.top - GAP - h < EDGE;
  tip.style.left = `${Math.max(EDGE, Math.min(a.left + a.width / 2 - w / 2, vw - w - EDGE))}px`;
  tip.style.top = `${below ? a.bottom + GAP : a.top - GAP - h}px`;
}

function hide() {
  window.clearTimeout(timer);
  pending = null;
  if (!anchor) return;
  anchor = null;
  hiddenAt = performance.now();
  if (tip?.matches(':popover-open')) tip.hidePopover();
}

const tipped = (t: EventTarget | null) => (t instanceof Element ? t.closest('[data-tip]') : null);

export function installTooltips() {
  // Also on moves: leaving a disabled button gives no pointerover on what comes next.
  const over = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const el = tipped(e.target);
    if (el !== dismissed) dismissed = null;
    if (el === (anchor ?? pending) || (el && el === dismissed)) return;
    hide();
    pending = el;
    if (!el) return;
    if (performance.now() - hiddenAt < WARM) show(el);
    else timer = window.setTimeout(() => show(el), DELAY);
  };
  document.addEventListener('pointerover', over);
  document.addEventListener('pointermove', over);
  document.documentElement.addEventListener('pointerleave', hide);
  document.addEventListener('focusin', (e) => {
    const el = tipped(e.target);
    if (el && el === e.target && el.matches(':focus-visible') && !el.matches('input, textarea')) {
      hide();
      show(el);
    }
  });
  document.addEventListener('focusout', hide);
  const dismiss = () => {
    dismissed = anchor ?? dismissed;
    hide();
    hiddenAt = -Infinity;
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      dismissed = tipped(e.target);
      hide();
      hiddenAt = -Infinity;
    },
    true,
  );
  document.addEventListener('keydown', dismiss, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
