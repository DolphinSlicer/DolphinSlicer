#!/usr/bin/env bash
# Real printer servers for e2e/printers.spec.ts, in Docker:
#   Klipper + Moonraker (klipper/Dockerfile)   → :7125
#   OctoPrint with its virtual printer         → :5050
# Klipper runs its Linux-process MCU on simulated GPIO lines (the gpio-sim kernel module, so this
# needs root on Linux): the simulavr AVR of the base image can't keep real time in a VM.
# Then: PRINTER_E2E=1 npx playwright test e2e/printers.spec.ts
# Stop with: docker rm -f ds-klipper ds-octo
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
KEY=DOLPHINTESTKEY0123456789

docker rm -f ds-klipper ds-octo >/dev/null 2>&1 || true

# A simulated GPIO chip with 64 lines for Klipper's host MCU.
if [ ! -d /sys/kernel/config/gpio-sim/dolphin ]; then
  modprobe gpio-sim
  mkdir -p /sys/kernel/config/gpio-sim/dolphin/bank0
  echo 64 > /sys/kernel/config/gpio-sim/dolphin/bank0/num_lines
  echo 1 > /sys/kernel/config/gpio-sim/dolphin/live
fi
CHIP=/dev/$(cat /sys/kernel/config/gpio-sim/dolphin/bank0/chip_name)
docker build -q -t dolphin-test-klipper "$(dirname "$0")/klipper" >/dev/null
# Klipper's config names the chip gpiochip0, whatever it is called on the host.
docker run -d --name ds-klipper --device "$CHIP:/dev/gpiochip0" -p 7125:7125 dolphin-test-klipper >/dev/null
docker exec -u root ds-klipper chmod 666 /dev/gpiochip0

docker run -d --name ds-octo -p 5050:5000 octoprint/octoprint:latest >/dev/null
until docker exec ds-octo test -f /octoprint/octoprint/config.yaml 2>/dev/null; do sleep 1; done
sleep 3
docker exec ds-octo sh -c "
B=/octoprint/octoprint
octoprint --basedir \$B user add admin --password admin --admin >/dev/null 2>&1 || true
for k in server.firstRun server.onlineCheck.enabled server.pluginBlacklist.enabled plugins.tracking.enabled; do octoprint --basedir \$B config set --bool \$k false; done
octoprint --basedir \$B config set --bool api.allowCrossOrigin true
octoprint --basedir \$B config set --bool plugins.virtual_printer.enabled true
octoprint --basedir \$B config set --bool serial.autoconnect true
octoprint --basedir \$B config set serial.port VIRTUAL
octoprint --basedir \$B config set --int serial.baudrate 115200
python3 -c \"
import yaml
p='\$B/users.yaml'; u=yaml.safe_load(open(p)); u['admin']['apikey']='$KEY'; yaml.safe_dump(u, open(p, 'w'))
\""
docker restart ds-octo >/dev/null

echo -n 'waiting for Klipper and OctoPrint'
until curl -sf localhost:7125/server/info | grep -q '"klippy_state":"ready"'; do echo -n .; sleep 2; done
until curl -sf -H "X-Api-Key: $KEY" localhost:5050/api/job | grep -q Operational; do echo -n .; sleep 2; done
echo ' ready'
