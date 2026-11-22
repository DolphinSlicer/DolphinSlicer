// About dialog: licence and source link (AGPL-3.0 §13: users of a network service get the source).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from 'react';
import { threadSupport } from '../engine/capabilities';
import { t } from '../i18n/i18n';
import { useApp } from '../state/store';
import { useModal } from './useModal';

export function About({ onClose }: { onClose: () => void }) {
  const engine = useApp((s) => s.engine);
  const threads = threadSupport();
  const commit = __APP_COMMIT__;
  const src = __APP_SOURCE_URL__;
  const modal = useModal<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" ref={modal} aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <div className="about-brand">
          <img src="dolphin-slicer-mark.svg" alt="" />
          <h2 id="about-title">DolphinSlicer</h2>
        </div>
        <p>{t('The OrcaSlicer engine, running in your browser. Your models never leave your computer.')}</p>
        <p>
          {t(
            'This program is free software under the GNU Affero General Public License v3.0 or later. You can get its complete source code, including this exact version, here:',
          )}
        </p>
        <p>
          <a href={commit !== 'unknown' ? `${src}/tree/${commit}` : src} target="_blank" rel="noreferrer" data-testid="source-link">
            {src}
          </a>
          <br />
          <span className="muted small">
            {t('Version {version}', { version: commit === 'unknown' ? t('development build') : commit.slice(0, 12) })}
          </span>
        </p>
        <h3>{t('Engine')}</h3>
        <ul className="small">
          <li>{engine.info ?? t('not loaded yet')}</li>
          <li>{engine.flavor === 'mt' ? t('Multithreaded, {cores} logical cores', { cores: threads.cores }) : t('Single-threaded')}</li>
          {engine.reason && <li>{t(engine.reason)}</li>}
        </ul>
        <p className="small muted">
          {t(
            'OrcaSlicer is © its contributors, based on Bambu Studio, PrusaSlicer and Slic3r (AGPL-3.0). See NOTICE in the source for all credits.',
          )}
        </p>
        <p className="small muted">
          <a href="https://github.com/OrcaSlicer/OrcaSlicer" target="_blank" rel="noreferrer">
            OrcaSlicer
          </a>{' '}
          ·{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
            GNU AGPL v3.0
          </a>{' '}
          ·{' '}
          <a href="privacy.html" target="_blank" rel="noreferrer" data-testid="privacy-link">
            {t('Privacy Policy')}
          </a>
        </p>
        <button onClick={onClose} autoFocus>
          {t('Close')}
        </button>
      </div>
    </div>
  );
}
