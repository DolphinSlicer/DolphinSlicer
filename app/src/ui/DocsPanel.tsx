// A setting's documentation from the OrcaSlicer wiki, beside the settings (over them on narrow
// screens). Opened by clicking a setting's name; links to other wiki pages open here too. A
// setting the wiki doesn't cover shows its description (the tooltip text) instead.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/i18n';
import { type Doc, loadDoc, wikiUrl } from '../settings/docs';

export function DocsPanel({
  path,
  label,
  text,
  onOpen,
  onClose,
}: {
  /** The wiki path ("page#anchor"); empty: no wiki page, show `text`. */
  path: string;
  label: string;
  text?: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<{ path: string; doc?: Doc; failed?: boolean } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    if (!path) {
      setDoc(null);
      return;
    }
    setDoc({ path });
    loadDoc(path).then(
      (d) => {
        if (live) setDoc({ path, doc: d });
      },
      () => {
        if (live) setDoc({ path, failed: true });
      },
    );
    body.current?.scrollTo(0, 0);
    return () => {
      live = false;
    };
  }, [path]);
  // A new setting starts a new history; links within the panel add to it.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  const open = (next: string) => {
    setHistory((h) => [...h, path]);
    onOpen(next);
  };
  const back = () => {
    const prev = history.at(-1);
    if (prev) {
      setHistory((h) => h.slice(0, -1));
      onOpen(prev);
    }
  };
  // The setting's name until its page has loaded (another page's has none of its own yet).
  const title = doc?.doc?.title || (history.length ? '' : label);
  return (
    <aside
      ref={panel}
      className="docs-panel"
      aria-label={title}
      tabIndex={-1}
      data-testid="docs-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        {history.length > 0 && (
          <button type="button" className="icon-btn small" aria-label={t('Back')} data-tip={t('Back')} onClick={back}>
            <ArrowLeft size={15} />
          </button>
        )}
        <h2>{title}</h2>
        {path && (
          <a
            className="icon-btn small"
            href={wikiUrl(path)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('Open in the wiki')}
            data-tip={t('Open in the wiki')}
          >
            <ExternalLink size={15} />
          </a>
        )}
        <button
          type="button"
          className="icon-btn small"
          aria-label={t('Close')}
          data-tip={t('Close')}
          onClick={onClose}
          data-testid="docs-close"
        >
          <X size={15} />
        </button>
      </header>
      <div ref={body} className="docs-body">
        {!path ? (
          <div className="docs-text">
            {(text ?? '').split(/\n{2,}/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        ) : doc?.failed ? (
          <p className="muted">
            {t('Could not load the documentation.')}{' '}
            <a href={wikiUrl(path)} target="_blank" rel="noopener noreferrer">
              {t('Open in the wiki')}
            </a>
          </p>
        ) : !doc?.doc ? (
          <span className="spinner" />
        ) : (
          <div
            className="docs-text"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify (settings/docs.ts)
            dangerouslySetInnerHTML={{ __html: doc.doc.html }}
            onClick={(e) => {
              const a = (e.target as Element).closest('a[data-doc]') as HTMLAnchorElement | null;
              if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
              e.preventDefault();
              open(a.dataset.doc!);
            }}
          />
        )}
      </div>
    </aside>
  );
}
