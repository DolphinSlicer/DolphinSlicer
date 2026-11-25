// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startApp } from './state/actions';
import { initDrive } from './state/driveActions';
import { initModels } from './state/libraryActions';
import { initPrefs } from './state/prefsActions';
import { initPrinters } from './state/printerActions';
import { openQuickLinks } from './state/quickLink';
import { App } from './ui/App';
import { installTooltips } from './ui/tooltip';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource-variable/ibm-plex-sans/wght-italic.css';
import './ui/styles.css';

// The engine starts while the language loads; the UI renders once it is there.
installTooltips();
void startApp();
initDrive();
void initModels();
initPrinters();
void initPrefs().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // "Slice now" links (?model=…), once messages can be shown in the user's language.
  void openQuickLinks();
});
