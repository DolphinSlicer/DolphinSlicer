#!/usr/bin/env bash
# The self-hosted build as on a printer: nginx serves dist-pi at /dolphin/ with its storage folder
# and proxies Moonraker's API like Mainsail's nginx config does (docs/SELF_HOST_PI.md), on port 8090.
# Needs dist-pi (npm run build:pi) and the ds-klipper container from start.sh.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
APP=$(cd "$(dirname "$0")/../.." && pwd)
docker network create ds-net >/dev/null 2>&1 || true
docker network connect ds-net ds-klipper >/dev/null 2>&1 || true
docker rm -f ds-pi >/dev/null 2>&1 || true
docker run -d --name ds-pi --network ds-net -p 8090:80 \
  -v "$APP/dist-pi:/home/pi/dolphin-slicer:ro" \
  --tmpfs /var/lib/dolphin-slicer:uid=101,gid=101 \
  -v "$APP/e2e/printers/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
for _ in $(seq 60); do curl -sf localhost:8090/dolphin/ >/dev/null && curl -sf localhost:8090/server/info >/dev/null && break; sleep 1; done
curl -sf localhost:8090/server/info >/dev/null
echo 'pi: http://localhost:8090/dolphin/'
