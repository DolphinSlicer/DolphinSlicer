// SPDX-License-Identifier: AGPL-3.0-or-later

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { authService } from './server/vitePlugin';

// Cross-origin isolation (COOP/COEP) enables SharedArrayBuffer and with it the multithreaded
// engine. ORCA_COI=0 serves without it, which is how the single-threaded fallback is tested.
// Production headers live in public/_headers (Cloudflare Pages).
const coi = process.env.ORCA_COI !== '0';
const headers = coi ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : {};

const allowedHosts = ['.dolphinslicer.app'];

// ORCA_TLS_DIR=<dir with key.pem and cert.pem>: serve the preview over HTTPS (the Local Network
// Access e2e test needs a secure page that Chrome treats as public).
const tlsDir = process.env.ORCA_TLS_DIR;
const https = tlsDir ? { key: readFileSync(`${tlsDir}/key.pem`), cert: readFileSync(`${tlsDir}/cert.pem`) } : undefined;

function git(cmd: string, fallback: string) {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

export default defineConfig({
  plugins: [react(), authService(fileURLToPath(new URL('.', import.meta.url)))],
  define: {
    __APP_COMMIT__: JSON.stringify(process.env.ORCA_APP_COMMIT ?? git('rev-parse HEAD', 'unknown')),
    __APP_SOURCE_URL__: JSON.stringify(process.env.ORCA_SOURCE_URL ?? 'https://github.com/DolphinSlicer/DolphinSlicer'),
  },
  worker: { format: 'es' },
  // Host names the dev/preview servers answer to besides localhost (Vite rejects others).
  server: { headers, port: 5173, strictPort: true, allowedHosts },
  preview: { headers, port: Number(process.env.PORT ?? 4173), strictPort: true, allowedHosts, ...(https ? { https } : {}) },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
