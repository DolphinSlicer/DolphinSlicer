// Preferences: theme, language, currency and units. Changes apply right away.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Cloud, Monitor, Moon, RefreshCw, Sun } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { bcp47, LANGUAGES, type Language, matchLanguage, nativeName, t } from '../i18n/i18n';
import { cancelSignIn, connectDrive, disconnectDrive, syncDrive } from '../state/driveActions';
import type { Theme, Units } from '../state/prefs';
import { updatePrefs } from '../state/prefsActions';
import { useApp } from '../state/store';
import { SegmentThumb } from './SegmentThumb';
import { Select } from './Select';
import { useModal } from './useModal';

function currencies(lang: string): [code: string, name: string][] {
  const codes = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : ['USD', 'EUR', 'GBP', 'JPY', 'CNY'];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([lang], { type: 'currency' });
  } catch {
    /* codes only */
  }
  return codes.map((c): [string, string] => [c, names?.of(c) ?? c]).sort((a, b) => a[1].localeCompare(b[1], lang));
}

export function Preferences({ onClose }: { onClose: () => void }) {
  const prefs = useApp((s) => s.prefs);
  const lang = bcp47(useApp((s) => s.lang));
  const list = useMemo(() => currencies(lang), [lang]);
  const auto = matchLanguage(navigator.languages);
  const themes: [Theme, string, typeof Sun][] = [
    ['system', t('System'), Monitor],
    ['light', t('Light'), Sun],
    ['dark', t('Dark'), Moon],
  ];
  const units: [Units, string][] = [
    ['metric', t('Metric')],
    ['imperial', t('Imperial')],
  ];
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
      <div
        className="modal prefs"
        role="dialog"
        ref={modal}
        aria-modal="true"
        aria-labelledby="prefs-title"
        onClick={(e) => e.stopPropagation()}
        data-testid="preferences"
      >
        <h2 id="prefs-title">{t('Preferences')}</h2>
        <div className="prefs-grid">
          <span className="caption" id="pref-theme">
            {t('Appearance')}
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="pref-theme">
            <SegmentThumb />
            {themes.map(([v, label, Icon]) => (
              <button
                key={v}
                role="radio"
                aria-checked={prefs.theme === v}
                aria-selected={prefs.theme === v}
                onClick={() => void updatePrefs({ theme: v })}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>

          <span className="caption" id="pref-language">
            {t('Language')}
          </span>
          <Select
            aria-labelledby="pref-language"
            value={prefs.language}
            data-testid="pref-language"
            onChange={(v) => void updatePrefs({ language: v as Language | 'auto' })}
            items={[
              { value: 'auto', label: t('Automatic ({language})', { language: nativeName(auto) }) },
              ...LANGUAGES.map((l) => ({ value: l, label: nativeName(l), lang: bcp47(l) })),
            ]}
          />

          <span className="caption" id="pref-currency">
            {t('Currency')}
          </span>
          <Select
            aria-labelledby="pref-currency"
            value={prefs.currency}
            data-testid="pref-currency"
            onChange={(v) => void updatePrefs({ currency: v })}
            items={[
              ...(list.some(([c]) => c === prefs.currency) ? [] : [{ value: prefs.currency, label: prefs.currency }]),
              ...list.map(([c, name]) => ({ value: c, label: `${name} (${c})` })),
            ]}
          />

          <span className="caption" id="pref-units">
            {t('Units')}
          </span>
          <div>
            <div className="segmented" role="radiogroup" aria-labelledby="pref-units">
              <SegmentThumb />
              {units.map(([v, label]) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={prefs.units === v}
                  aria-selected={prefs.units === v}
                  onClick={() => void updatePrefs({ units: v })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DriveSection
          close={
            <button className="btn close" onClick={onClose} autoFocus>
              {t('Close')}
            </button>
          }
        />
      </div>
    </div>
  );
}

/** The Drive settings; `close` (the dialog's Close button) ends its row of buttons. */
function DriveSection({ close }: { close: React.ReactNode }) {
  const d = useApp((s) => s.drive);
  const lang = bcp47(useApp((s) => s.lang));
  const busy = d.status === 'syncing';
  const signingIn = d.status === 'signing-in';
  let status: string;
  if (d.status === 'signing-in') status = '';
  else if (d.status === 'syncing') status = t('Syncing…');
  else if (d.status === 'expired') status = t('Sign in again to sync your presets and models.');
  else if (d.status === 'error') status = t('Sync failed: {message}', { message: d.message ?? '' });
  else if (d.waiting) status = t('Save or discard your changes to get the presets from Drive.');
  else if (d.lastSync)
    status = t('Synced at {time}', { time: new Date(d.lastSync).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) });
  else status = '';
  return (
    <section className="prefs-drive" data-testid="drive">
      <h3>
        <Cloud size={14} />
        {t('Google Drive')}
      </h3>
      {!window.isSecureContext ? (
        // Google signs in only to https:// pages (the self-hosted build is served over http://).
        <>
          <p className="muted small" data-testid="drive-insecure">
            {t('Google Drive works when DolphinSlicer is opened over https://.')}
          </p>
          <div className="prefs-row">{close}</div>
        </>
      ) : !d.email ? (
        <>
          <p className="muted small">
            {t(
              'Keep your presets, models and settings in your Google Drive and use them on all your devices. DolphinSlicer can only see the files it creates.',
            )}
          </p>
          <div className="prefs-row">
            <button className="btn" onClick={() => void connectDrive()} data-testid="drive-connect">
              {t('Connect Google Drive')}
            </button>
            {signingIn && <SignInWait />}
            {close}
          </div>
        </>
      ) : (
        <>
          <p className="small">{t('Connected as {email}', { email: d.email })}</p>
          {status && (
            <p className={`small ${d.status === 'error' ? 'error' : 'muted'}`} data-testid="drive-status">
              {status}
            </p>
          )}
          <div className="prefs-row">
            {d.status === 'expired' || signingIn ? (
              <button className="btn primary" onClick={() => void connectDrive()} data-testid="drive-signin">
                {t('Sign in')}
              </button>
            ) : (
              <button className="btn" onClick={() => void syncDrive()} disabled={busy} data-testid="drive-sync">
                <RefreshCw size={14} />
                {t('Sync now')}
              </button>
            )}
            {signingIn ? (
              <SignInWait />
            ) : (
              <button className="btn ghost" onClick={() => void disconnectDrive()} disabled={busy} data-testid="drive-disconnect">
                {t('Disconnect')}
              </button>
            )}
            {close}
          </div>
        </>
      )}
    </section>
  );
}

/** While the sign-in popup is open: its status, and a way out if it was closed. */
function SignInWait() {
  return (
    <span className="signin-wait muted small" data-testid="drive-waiting">
      <span className="spinner" />
      {t('Waiting for Google…')}
      <button className="link-btn" onClick={cancelSignIn} data-testid="drive-cancel">
        {t('Cancel')}
      </button>
    </span>
  );
}
