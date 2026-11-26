// End-to-end tests against the production build (vite preview). Every test runs once in Chrome,
// cross-origin isolated (mt, the multithreaded engine). Tests tagged @engine (the slicing paths)
// run again without isolation (st, the single-threaded fallback), and those tagged @browser (files,
// downloads, storage, popovers, dialogs, popups, keys, WebGL) again in Firefox.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// PW_GL_ARGS: extra Chrome flags for the preview benchmark, e.g. to render with Mesa llvmpipe.
/**
 * Tests start with the default printer library already saved, so the first-start wizard does
 * not open (wizard.spec.ts clears it to test that).
 */
const library = (origin: string) => ({
  cookies: [],
  origins: [
    {
      origin,
      localStorage: [
        {
          name: 'dolphin-slicer.library.v1',
          value: JSON.stringify({
            printers: [{ vendor: 'Custom', model: 'Generic Klipper Printer', nozzle: '0.4' }],
            filaments: ['Generic PLA', 'Generic PETG', 'Generic ABS', 'Generic ASA', 'Generic TPU'],
            vendors: [],
          }),
        },
      ],
    },
  ],
});

const chrome = {
  ...devices['Desktop Chrome'],
  channel: process.env.PW_CHANNEL ?? 'chrome',
  launchOptions: { args: process.env.PW_GL_ARGS ? process.env.PW_GL_ARGS.split(' ') : [] },
};

// With PRINTER_E2E=1 (printer servers from e2e/printers/start.sh running):
//   lna: the app over HTTPS on 127.0.0.1:4185, which Chrome is told to treat as a public address,
//        so reaching the printer's private IP goes through Local Network Access as on the web;
//   pi:  the self-hosted build (dist-pi) behind nginx at http://pi.test:8090/dolphin/, next to
//        Moonraker, as on a printer (e2e/printers/pi.sh starts it). Not a secure context.
const ONLY_PRINTER_PROJECTS = [/lna\.spec\.ts/, /pi\.spec\.ts/];
const TLS = 'test-results/tls';
/** The Klipper container's address on the Docker bridge: a private IP, as a printer on the LAN. */
export const KLIPPER_IP = process.env.PRINTER_E2E
  ? (process.env.KLIPPER_IP ??
    execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ds-klipper").toString().trim().split(/\s+/)[0]!)
  : '';
const printerProjects = process.env.PRINTER_E2E
  ? [
      {
        name: 'lna',
        testMatch: /lna\.spec\.ts/,
        use: {
          ...chrome,
          baseURL: 'https://127.0.0.1:4185/',
          ignoreHTTPSErrors: true,
          storageState: library('https://127.0.0.1:4185'),
          launchOptions: {
            args: ['--ip-address-space-overrides=127.0.0.1:4185=public', `--host-resolver-rules=MAP klipper.test ${KLIPPER_IP}`],
          },
        },
      },
      {
        name: 'pi',
        testMatch: /pi\.spec\.ts/,
        use: {
          ...chrome,
          baseURL: 'http://pi.test:8090/dolphin/',
          storageState: library('http://pi.test:8090'),
          launchOptions: { args: ['--host-resolver-rules=MAP pi.test 127.0.0.1'] },
        },
      },
    ]
  : [];
const printerServers = process.env.PRINTER_E2E
  ? [
      {
        command: `mkdir -p ${TLS} && openssl req -x509 -newkey rsa:2048 -nodes -keyout ${TLS}/key.pem -out ${TLS}/cert.pem -days 2 -subj /CN=127.0.0.1 2>/dev/null && npx vite preview --host 127.0.0.1 --port 4185`,
        url: 'https://127.0.0.1:4185/',
        ignoreHTTPSErrors: true,
        reuseExistingServer: true,
        env: { ORCA_COI: '1', GOOGLE_CLIENT_SECRET: '', ORCA_TLS_DIR: TLS },
      },
    ]
  : [];

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  // One test at a time (slicing and the software 3D view need the CPU); split into shards by test,
  // not by file, so the shards take about as long (CI).
  fullyParallel: true,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  // Stable Google Chrome (`npx playwright install chrome`), not the bundled Chromium build:
  // Chromium 156.0.8078.4 (Playwright 1.64) crashes the renderer on a WebAssembly trap that
  // Chrome 157 stable reports as a catchable RuntimeError. PW_CHANNEL=chromium overrides.
  use: { trace: 'retain-on-failure', acceptDownloads: true },
  projects: [
    ...printerProjects,
    {
      name: 'mt',
      testIgnore: ONLY_PRINTER_PROJECTS,
      use: { ...chrome, baseURL: 'http://localhost:4183/', storageState: library('http://localhost:4183') },
      metadata: { flavor: 'mt' },
    },
    {
      name: 'st',
      testIgnore: ONLY_PRINTER_PROJECTS,
      grep: /@engine/,
      use: { ...chrome, baseURL: 'http://localhost:4184/', storageState: library('http://localhost:4184') },
      metadata: { flavor: 'st' },
    },
    {
      name: 'firefox-mt',
      testIgnore: ONLY_PRINTER_PROJECTS,
      grep: /@browser/,
      use: { ...devices['Desktop Firefox'], baseURL: 'http://localhost:4183/', storageState: library('http://localhost:4183') },
      metadata: { flavor: 'mt' },
    },
  ],
  // Own ports, so a running live preview (4173) is never reused; no Google client secret, so the
  // tests get the popup-only sign-in unless they fake the token service.
  webServer: [
    {
      command: 'npx vite preview --port 4183',
      url: 'http://localhost:4183/',
      reuseExistingServer: true,
      env: { ORCA_COI: '1', GOOGLE_CLIENT_SECRET: '' },
    },
    {
      command: 'npx vite preview --port 4184',
      url: 'http://localhost:4184/',
      reuseExistingServer: true,
      env: { ORCA_COI: '0', GOOGLE_CLIENT_SECRET: '' },
    },
    ...printerServers,
  ],
});
