// The highlight of a segmented control (.segmented), which slides to the selected button. Put it
// first inside the control; it follows the button with aria-selected="true".
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useRef } from 'react';

export function SegmentThumb() {
  const thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = thumb.current,
      bar = el?.parentElement;
    if (!el || !bar) return;
    let placed = false;
    const place = () => {
      const sel = bar.querySelector<HTMLElement>(':scope > [aria-selected="true"]');
      if (!sel) {
        el.style.opacity = '0';
        return;
      }
      // No slide from nowhere: the first placement (and one after being hidden) jumps.
      el.classList.toggle('instant', !placed || !sel.offsetWidth);
      el.style.opacity = '1';
      el.style.width = `${sel.offsetWidth}px`;
      el.style.height = `${sel.offsetHeight}px`;
      el.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
      placed = sel.offsetWidth > 0;
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-selected'], childList: true });
    const ro = new ResizeObserver(place);
    ro.observe(bar);
    for (const b of bar.children) ro.observe(b);
    // A group of choices: the arrow keys go to the next one, as with radio buttons.
    const onKey = (e: KeyboardEvent) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step || e.altKey || e.ctrlKey || e.metaKey || bar.getAttribute('role') !== 'radiogroup') return;
      const all = [...bar.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)')];
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const next = all[(at + step + all.length) % all.length]!;
      next.focus();
      next.click();
    };
    bar.addEventListener('keydown', onKey);
    return () => {
      mo.disconnect();
      ro.disconnect();
      bar.removeEventListener('keydown', onKey);
    };
  }, []);
  return <span ref={thumb} className="seg-thumb instant" aria-hidden />;
}
