// A dialog that animates out: when it closes, it stays as last shown until its close animation
// (styles.css, .presence[data-closing]) ends, inert meanwhile.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useEffect, useRef, useState } from 'react';

/** Longer than the close animation: the end, should its animationend never come. */
const MAX_MS = 400;

/** Shows `children` while they are set (`{open && <Dialog />}`), and a while longer when they go. */
export function Presence({ children }: { children: ReactNode }) {
  const open = Boolean(children);
  const last = useRef<ReactNode>(null);
  if (open) last.current = children;
  const [closing, setClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  // Opened again while closing: a new one, which takes the focus as any dialog does.
  const [round, setRound] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    setClosing(!open);
    if (open && closing) setRound(round + 1);
  }
  useEffect(() => {
    if (!closing) return;
    const id = setTimeout(() => setClosing(false), MAX_MS);
    return () => clearTimeout(id);
  }, [closing]);
  if (!open && !closing) return null;
  return (
    <div
      key={round}
      className="presence"
      data-closing={closing || undefined}
      inert={closing}
      onAnimationEnd={(e) => {
        if (e.animationName === 'dialog-out') setClosing(false);
      }}
    >
      {last.current}
    </div>
  );
}
