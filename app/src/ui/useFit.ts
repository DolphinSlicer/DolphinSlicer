// Makes a bar more compact until its content fits: of the given steps, in their order, it puts
// those that help into the bar's data-compact attribute, which the style sheet answers by
// hiding labels and the like. With `center`, the bar's middle part must also stay in the middle
// (a side that outgrows its half would push it aside).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useRef, useState } from 'react';

/** How far the bar's content is from fitting, in pixels: what overflows, and how far its middle part is off center. */
function misfit(el: HTMLElement, center: boolean): number {
  let off = Math.max(0, el.scrollWidth - el.clientWidth);
  const [first, middle, last] = [el.firstElementChild, el.children[1], el.lastElementChild];
  if (center && first && middle && last) {
    const a = first.getBoundingClientRect(),
      m = middle.getBoundingClientRect(),
      b = last.getBoundingClientRect();
    off += Math.abs((m.left + m.right) / 2 - (a.left + b.right) / 2);
  }
  return off > 1 ? off : 0;
}

/** The bar's ref and the steps taken now (space separated). `steps` must stay the same array. */
export function useFit<T extends HTMLElement>(steps: readonly string[], { center = false } = {}): [React.RefObject<T | null>, string] {
  const ref = useRef<T>(null);
  const [taken, setTaken] = useState('');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const on: string[] = [];
      const apply = () => {
        el.dataset.compact = on.join(' ');
      };
      apply();
      // A step that gains nothing is left out (a bar of two rows: one that shortens the other
      // row), and tried again once another one has helped.
      for (let helped = true; helped && misfit(el, center); ) {
        helped = false;
        for (const step of steps) {
          const before = misfit(el, center);
          if (!before) break;
          if (on.includes(step)) continue;
          on.push(step);
          apply();
          if (misfit(el, center) < before) helped = true;
          else {
            on.pop();
            apply();
          }
        }
      }
      setTaken(on.join(' '));
    };
    fit();
    // Its width, and what is in it (another language, a progress bar in place of a button, a
    // longer label): a part can change without the bar's columns changing size.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    const mo = new MutationObserver(fit);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [steps, center]);
  return [ref, taken];
}
