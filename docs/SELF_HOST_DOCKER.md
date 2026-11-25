# Running DolphinSlicer with Docker

The image `ghcr.io/dolphinslicer/dolphinslicer` runs DolphinSlicer on a home server (Unraid,
Synology, Proxmox, a spare Raspberry Pi; amd64 and arm64). It keeps your presets, model library,
printers and settings in a volume on the server, so every browser and device that opens it works
with the same data. To run DolphinSlicer on the printer itself instead, see
[SELF_HOST_PI.md](SELF_HOST_PI.md).

## Start it

```sh
docker run -d --name dolphinslicer --restart unless-stopped \
  -p 8080:80 -v dolphinslicer-data:/data \
  ghcr.io/dolphinslicer/dolphinslicer:latest
```

Or with Docker Compose:

```yaml
services:
  dolphinslicer:
    image: ghcr.io/dolphinslicer/dolphinslicer:latest
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - dolphinslicer-data:/data
volumes:
  dolphinslicer-data:
```

Open `http://<server>:8080`. **Preferences** shows **Server storage**: your data is in the
`/data` volume, laid out as in [Storage on the printer](SELF_HOST_PI.md#storage-on-the-printer).
Include the volume in your backups; deleting there is permanent.

The tags are `latest` and each release's version number, such as `0.2.0`.

## Sending to your printer

DolphinSlicer now runs on a different address than your printer, so the printer has to allow it.
When you add the printer, DolphinSlicer shows what to change:

- **Klipper (Moonraker):** add the address you open DolphinSlicer at to `cors_domains` in
  `moonraker.conf`, then restart Moonraker:

  ```ini
  [authorization]
  cors_domains:
      http://server.local:8080
  ```

- **OctoPrint:** turn on **Settings › API › Allow Cross Origin Resource Sharing (CORS)** and
  restart it.

## http:// or https://

- **Plain `http://` on your network** works in every browser, but slices with the single-threaded
  engine (browsers allow the multithreaded one only on secure pages), so plates with many objects
  slice slower.
- **`https://` through your reverse proxy** (Caddy, Traefik, Nginx Proxy Manager, …) gets the
  multithreaded engine. The image sends the headers it needs; the proxy must pass them on, which
  they do by default. Sending to printers then works as on dolphinslicer.app: in Chrome, allow
  local network access when it asks; Firefox and Safari block https pages from reaching printers
  at `http://` addresses.
- `http://localhost` counts as secure too: the multithreaded engine, on the server itself.

Google Drive is not offered: the server's storage takes its place.

**Anyone who can open DolphinSlicer can read and change its data.** Don't make it reachable from
the internet without a login in front of it.

## Updating

```sh
docker pull ghcr.io/dolphinslicer/dolphinslicer:latest
docker rm -f dolphinslicer   # then start it again as above; the volume keeps your data
```

With Compose: `docker compose pull && docker compose up -d`.

## Building the image yourself

With the engine files from the engine build (`engine/README.md`):

```sh
cd app
npm ci
npm run build:docker    # writes app/dist-docker/
docker build -f docker/Dockerfile -t dolphinslicer .
```
