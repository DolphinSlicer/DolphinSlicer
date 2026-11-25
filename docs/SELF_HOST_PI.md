# Running DolphinSlicer on your printer

Use this when your browser can't reach your printer from https://dolphinslicer.app: Firefox,
Safari, or Chrome with the local network permission blocked. Your printer's own web server
serves the app over plain `http://`, on the same address as Mainsail or Fluidd. The app and
Moonraker then share one origin, so the browser needs no special permission and Moonraker
needs no CORS settings.

What works differently over `http://`:
- **Slicing is single-threaded.** Browsers allow the multithreaded engine only on https://
  pages. Plates with many objects slice slower.
- **No Google Drive.** Google signs in only to https:// pages. Store your presets, models and
  settings on the printer instead ([below](#storage-on-the-printer)), so every browser that opens
  DolphinSlicer there shares them. Without it, they stay in each browser.

For a home server instead of the printer, use the [Docker image](SELF_HOST_DOCKER.md).

## Install on a Mainsail or Fluidd printer

1. On the printer (over SSH), download the latest build and unpack it to `~/dolphin-slicer/`:

   ```sh
   cd ~
   wget https://github.com/DolphinSlicer/DolphinSlicer/releases/latest/download/dolphinslicer-pi.zip
   rm -rf dolphin-slicer && unzip -q dolphinslicer-pi.zip && rm dolphinslicer-pi.zip
   ```

   If `unzip` is missing: `sudo apt install unzip`. To use a build of your own instead, see
   [Building it yourself](#building-it-yourself).

2. Add two locations to the printer's nginx site (`/etc/nginx/sites-available/mainsail`, or
   `fluidd`), inside the `server { … }` block, next to the existing `location /` block:

   ```nginx
   # /dolphin without the slash would open Mainsail or Fluidd instead.
   location = /dolphin {
       absolute_redirect off;
       return 301 /dolphin/$is_args$args;
   }
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

## Storage on the printer

With a storage folder on the printer, DolphinSlicer keeps your presets, model library, printers and
settings there instead of only in the browser. Every browser and device that opens
`http://printer.local/dolphin/` then works with the same data, as with Google Drive on
dolphinslicer.app. The app finds the folder by itself: **Preferences** shows **Server storage**
instead of Google Drive.

1. Create the folder, owned by the user nginx runs as (the `user` line in
   `/etc/nginx/nginx.conf`, `www-data` on Raspberry Pi OS):

   ```sh
   sudo install -d -o www-data -g www-data /var/lib/dolphin-slicer
   ```

2. Add another location next to `location /dolphin/`:

   ```nginx
   location /dolphin/storage/ {
       alias /var/lib/dolphin-slicer/;
       # Write files (WebDAV, built into nginx) and list folders as JSON.
       dav_methods PUT DELETE MKCOL;
       create_full_put_path on;
       autoindex on;
       autoindex_format json;
       client_max_body_size 1024m;  # large models
   }
   ```

3. Check the config and reload nginx:

   ```sh
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. Reload DolphinSlicer in the browser. Presets, models and settings already in this browser are
   copied to the printer at the first sync.

The folder holds the same files as the `DolphinSlicer` folder in Google Drive:

| Path | What |
|---|---|
| `DolphinSlicer/Presets/` | your presets, in OrcaSlicer's format (`machine/`, `filament/`, `process/`) |
| `DolphinSlicer/Models/` | the model library: the model files and `library.json` (names, tags, thumbnails) |
| `DolphinSlicer/Conflicts/` | the older version of a preset that was changed on two devices at once |
| `DolphinSlicer/printers.json` | the printers you chose to sync |
| `DolphinSlicer/settings.json` | preferences, your printer and filament list, the selected presets |

Things to know:
- **Anyone who can reach the printer can read and change these files**, as they can use
  Moonraker. Don't make the printer reachable from the internet.
- **Deleting is permanent.** Drive keeps deleted files in its trash; this folder doesn't. Include
  `/var/lib/dolphin-slicer` in your backups.
- Browsers sync when DolphinSlicer starts, after you save or delete a preset or change the library,
  and when you return to the tab. **Preferences → Sync now** syncs at once.

## Updating

Repeat step 1, then reload DolphinSlicer in the browser. The browser and the storage folder keep
your presets, library and printers.

## Building it yourself

On any computer with Node.js 22 (the engine files come from the engine build, see
`engine/README.md`):

```sh
cd app
npm ci
npm run build:pi        # writes app/dist-pi/ (about 120 MB, mostly printer profiles)
rsync -a --delete dist-pi/ pi@printer.local:~/dolphin-slicer/
```

## Tested

`e2e/pi.spec.ts` runs this setup: nginx with the locations above in front of Klipper and
Moonraker (Docker), opened at a non-localhost `http://` address. It checks that the
single-threaded engine slices, the library is stored in the storage folder above, and G-code
reaches Moonraker. See `app/README.md` (Test) for how to run it.
