// The app's confirmation dialog, in place of the browser's confirm(): `await ask(message)` shows
// it and resolves to whether the user confirmed. <ConfirmHost /> renders it (once, in App).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { t } from '../i18n/i18n';

export interface AskOptions {
  /** The confirming button's label (default "OK"): the action, e.g. "Delete". */
  confirm?: string;
  /** The action destroys something: the button is red. */
  danger?: boolean;
}
interface Request extends AskOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

let queue: Request[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Ask the user to confirm; one question at a time, in order. */
export function ask(message: string, options: AskOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, message, resolve }];
    emit();
  });
}

function answer(ok: boolean) {
  const [first, ...rest] = queue;
  if (!first) return;
  queue = rest;
  emit();
  first.resolve(ok);
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => queue[0],
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  // A modal <dialog>: in the top layer, the page behind it inert, the focus kept inside.
  useEffect(() => {
    const d = dialog.current;
    if (!req || !d) return;
    const back = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    ok.current?.focus();
    return () => {
      if (d.open) d.close();
      back?.focus?.();
    };
  }, [req]);
  // Shown as last asked while it closes (the close transition, styles.css).
  const last = useRef(req);
  if (req) last.current = req;
  const shown = req ?? last.current;
  if (!shown) return null;
  return (
    <dialog
      ref={dialog}
      className="modal confirm"
      aria-describedby="confirm-message"
      data-testid="confirm"
      // Escape cancels; the other dialogs' Escape handlers must not see it.
      onCancel={(e) => {
        e.preventDefault();
        answer(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          answer(false);
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false);
      }}
    >
      <div className="confirm-body">
        <p id="confirm-message">{shown.message}</p>
        <div className="confirm-actions">
          {/* The action first, then Cancel, as desktop's dialogs (MsgDialog). */}
          <button ref={ok} type="button" className={`btn primary${shown.danger ? ' destructive' : ''}`} onClick={() => answer(true)}>
            {shown.confirm ?? t('OK')}
          </button>
          <button type="button" className="btn ghost" onClick={() => answer(false)}>
            {t('Cancel')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
