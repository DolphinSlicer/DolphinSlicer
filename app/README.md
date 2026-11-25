# DolphinSlicer — web app

The browser UI around the OrcaSlicer WebAssembly engine (`../engine`). Static site, no backend.

## Develop

```sh
# once: build the engine (see ../engine/README.md); at least the single-threaded build
../engine/scripts/build-engine.sh st
../engine/scripts/build-engine.sh mt      # optional, used when the page is cross-origin isolated

npm ci
npm run dev        # copies engine + profiles into public/, starts Vite with COOP/COEP headers
```

`ORCA_COI=0 npm run dev` serves without COOP/COEP, which forces the single-threaded engine;
`?threads=0` in the URL does the same for one page.

## Test

```sh
npm test                 # unit tests (Vitest)
npm run lint             # Biome: lint, format and import order, as CI checks them
npm run check            # Biome: format and apply the safe fixes
npm run build            # assets + typecheck + production build + 25 MiB per-file check
npm run build:app        # typecheck + production build, without the engine (as CI does)
npm run e2e              # Playwright: Chromium, multithreaded (port 4183) and single-threaded (4184)
BENCH_GCODE=big.gcode npx playwright test bench --project=mt    # preview benchmark (opt-in)
```

Printers (opt-in; Linux with Docker, as root for the simulated GPIO chip):

```sh
e2e/printers/start.sh           # Klipper + Moonraker on :7125, OctoPrint on :5050 (Docker)
npm run build:pi && e2e/printers/pi.sh   # the self-hosted build behind nginx on :8090
PRINTER_E2E=1 npx playwright test printers lna pi --project=mt --project=lna --project=pi
docker rm -f ds-klipper ds-octo ds-pi   # stop them
```

`printers` sends and controls prints on both servers, `lna` checks Chrome's Local Network Access
(the app on HTTPS at an address Chrome treats as public, the printer on a private IP), `pi` runs
the self-hosted build over plain HTTP.

Debug hooks (only with `?debug`): `reserveHeapMB=<n>` makes the worker hold back that much wasm
heap before slicing, to test out-of-memory handling.

## Layout

| Path | What |
|---|---|
| `src/engine/` | `SliceBackend` interface, worker protocol, the engine worker, `WasmWorkerBackend`, COI detection |
| `src/state/` | zustand store and actions (import, presets, layout, slice, download) |
| `src/model/bed.ts` | bed from config, placement and arrange (pure, unit-tested) |
| `src/presets/` | profile manifest and lazily fetched vendor bundles |
| `src/gcode/` | the preview's segments from the engine's moves (and their worker), desktop's color views |
| `src/library/` | model library: storage (IndexedDB), thumbnails, Drive sync |
| `src/drive/` | sync of presets, library, printers and settings with Google Drive or a self-hosted server's storage folder (`server.ts`) |
| `src/printers/` | Moonraker and OctoPrint connectors, local network access |
| `src/view/` | three.js viewport and the instanced G-code renderer |
| `src/ui/` | React components |
| `scripts/` | copy the engine, bundle OrcaSlicer's profiles, check the dist |
| `public/_headers` | Cloudflare Pages headers (COOP/COEP, caching) |
| `server/`, `functions/` | Google sign-in token service and MCP server (Pages Functions; also in `vite dev`/`preview`) |

## Deploy

`npm run build` produces `dist/`, a static site. `npm run build:pi` produces `dist-pi/`, the
build to serve from a printer over plain HTTP (`docs/SELF_HOST_PI.md`), and `npm run build:docker`
produces `dist-docker/` for the Docker image (`docker/Dockerfile`, `docs/SELF_HOST_DOCKER.md`).
Each release attaches `dolphinslicer-pi.zip` and pushes the image (`release-assets.yml`). On Cloudflare Pages, `public/_headers` sets
cross-origin isolation, so the multithreaded engine is used. Hosts that can't set headers (e.g.
GitHub Pages) get the single-threaded engine (a service-worker shim is planned).

### Google Drive sign-in

Without a server, Google sign-in lasts an hour at a time. The token service (`server/googleAuth.ts`)
keeps users signed in. It needs the OAuth client's secret:

- **Cloudflare Pages:** set the project root to `app/` (so `functions/` is deployed) and add the
  secret: `npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name <project>`.
- **`vite dev` / `vite preview`:** put `GOOGLE_CLIENT_SECRET=…` in `app/.dev.vars` (gitignored)
  or the environment.
- **Google Cloud console:** add `https://<host>/api/auth/callback` to the client's authorized
  redirect URIs (keep `https://<host>/oauth.html` for the popup-only fallback), and set the
  OAuth consent screen to *In production*: in *Testing*, Google expires refresh tokens after 7
  days.

Without the secret, `/api/auth` is not served and the app falls back to the popup-only sign-in.

### MCP server

`server/mcp/` is an MCP server for AI assistants at `/mcp` ([docs/MCP.md](../docs/MCP.md)). It
signs users in through Google with the same OAuth client and callback as the token service, so
it needs nothing beyond the secret.
