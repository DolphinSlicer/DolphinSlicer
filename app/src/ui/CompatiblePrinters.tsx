// The compatible printers of a print or filament preset, as desktop's Dependencies page edits
// them ("All", or a picked list), behind a summary button as the bed settings.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Pencil, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/i18n';
import { printerInLibrary } from '../presets/library';
import { useApp } from '../state/store';
import { Presence } from './Presence';
import { useModal } from './useModal';

type Commit = string | { elements: string[] };

/** The printers to choose from: the user's own and those in the library, plus the ones listed. */
export function usePrinterChoices(listed: string[]): string[] {
  const entries = useApp((s) => s.presets.printers);
  const lib = useApp((s) => s.library);
  return useMemo(() => {
    const shown = entries.filter((e) => e.user || printerInLibrary(lib, e)).map((e) => e.name);
    return [...new Set([...shown, ...listed])].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list doesn't reorder while choosing
  }, [entries, lib]);
}

/** The settings row control: "All" or the printers, and a click picks them. */
export function CompatiblePrintersControl({ value, onCommit }: { value: string[]; onCommit: (v: Commit) => void }) {
  const [open, setOpen] = useState(false);
  const text = value.length ? value.join(', ') : t('All');
  return (
    <>
      <button
        type="button"
        className="bed-summary compatible-summary"
        title={text}
        onClick={() => setOpen(true)}
        data-testid="compatible-edit"
      >
        <span>{text}</span>
        <Pencil size={14} className="edit-icon" />
      </button>
      <Presence>
        {open && (
          <PrinterDialog
            value={value}
            onClose={() => setOpen(false)}
            onApply={(v) => {
              setOpen(false);
              onCommit({ elements: v });
            }}
          />
        )}
      </Presence>
    </>
  );
}

function PrinterDialog({ value, onClose, onApply }: { value: string[]; onClose: () => void; onApply: (v: string[]) => void }) {
  const choices = usePrinterChoices(value);
  // "All" is an empty list: every printer fits, and the condition decides.
  const [all, setAll] = useState(!value.length);
  const [picked, setPicked] = useState<string[]>(value);
  const modal = useModal<HTMLFormElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Desktop takes all of them checked as "All"; here the list stays, so printers added later
  // don't fit by surprise.
  const apply = () => onApply(all ? [] : choices.filter((n) => picked.includes(n)));
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal compatible-dialog"
        role="dialog"
        ref={modal}
        aria-modal="true"
        aria-labelledby="compatible-title"
        data-testid="compatible-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="bed-dialog-head">
          <h2 id="compatible-title">{t('Compatible printers')}</h2>
          <button type="button" className="icon-btn" aria-label={t('Close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="switch-label">
          <input type="checkbox" className="switch" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="compatible-all" />
          {t('All')}
        </label>
        {!all && (
          <ul className="printer-checks" aria-label={t('Select printers')}>
            {choices.map((n) => (
              <li key={n}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(n)}
                    onChange={(e) => setPicked((l) => (e.target.checked ? [...l, n] : l.filter((x) => x !== n)))}
                  />
                  <span>{n}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="bed-form-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!all && !picked.length} data-testid="compatible-apply">
            {t('Apply')}
          </button>
        </div>
      </form>
    </div>
  );
}
