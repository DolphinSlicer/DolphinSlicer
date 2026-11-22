# Running DolphinSlicer on your printer

Use this when your browser can't reach your printer from https://dolphinslicer.app: Firefox,
Safari, or Chrome with the local network permission blocked. Your printer's own web server
serves the app over plain `http://`, on the same address as Mainsail or Fluidd. The app and
Moonraker then share one origin, so the browser needs no special permission and Moonraker
needs no CORS settings.

What works differently over `http://`:
- **Slicing is single-threaded.** Browsers allow the multithreaded engine only on https://
  pages. Plates with many objects slice slower.
- **No Google Drive.** Google signs in only to https:// pages. Your presets and model library
  stay in this browser.

## Build

On any computer with Node.js 22 (the engine files come from the engine build, see
`engine/README.md`):

```sh
cd app
npm ci
npm run build:pi        # writes app/dist-pi/ (about 80 MB, mostly printer profiles)
```

## Install on a Mainsail or Fluidd printer

1. Copy the build to the printer:

   ```sh
   rsync -a --delete app/dist-pi/ pi@printer.local:~/dolphin-slicer/
   ```

2. Add a location to the printer's nginx site (`/etc/nginx/sites-available/mainsail`, or
   `fluidd`), inside the `server { … }` block, next to the existing `location /` block:

   ```nginx
   location /dolphin/ {
       alias /home/pi/dolphin-slicer/;
       # nginx's mime.types has no .mjs (the engine is a JavaScript module).
       types {
           text/html html;
           text/css css;
           application/javascript js mjs;
           application/wasm wasm;
           application/json json map;
           image/svg+xml svg;
       }
       gzip on;
       gzip_types application/javascript application/wasm application/json text/css image/svg+xml;
   }
   ```

   Change `/home/pi` if your user is not `pi`. nginx needs read access to that folder (on
   Raspberry Pi OS: `chmod o+x /home/pi`).

3. Check the config and reload nginx:

   ```sh
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. Open `http://printer.local/dolphin/` (or the printer's IP address). The printer form
   already holds this address: click **Send**, then **Save**.

The Mainsail and Fluidd nginx configs already forward Moonraker's API (`/server/`, `/printer/`,
…) on the same address, which is why no other setup is needed.

## Updating

Build again and repeat step 1. The browser keeps your presets, library and printers.

## Tested

`e2e/pi.spec.ts` runs this setup: nginx with the location above in front of Klipper and
Moonraker (Docker), opened at a non-localhost `http://` address. It checks that the
single-threaded engine slices, the library works, Google Drive is replaced by a note, and G-code
reaches Moonraker. See `app/README.md` (Test) for how to run it.
