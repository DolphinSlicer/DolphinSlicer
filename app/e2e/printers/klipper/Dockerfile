# Klipper + Moonraker for e2e tests, with Klipper's Linux-process MCU on a gpio-sim chip instead
# of the simulavr AVR (which can't keep real time on slow or virtualized machines).
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM ghcr.io/mainsail-crew/virtual-klipper-printer:latest
USER root
RUN apt-get update -qq && apt-get install -y -qq make >/dev/null && rm -rf /var/lib/apt/lists/*
USER printer
RUN cd /home/printer/klipper \
 && printf 'CONFIG_LOW_LEVEL_OPTIONS=y\nCONFIG_MACH_LINUX=y\n' > /tmp/linux.config \
 && make KCONFIG_CONFIG=/tmp/linux.config olddefconfig >/dev/null \
 && make KCONFIG_CONFIG=/tmp/linux.config OUT=/tmp/linux-out/ -j"$(nproc)" >/dev/null \
 && cp /tmp/linux-out/klipper.elf /home/printer/klipper-host-mcu \
 && echo 40000 > /home/printer/fake_temp
USER root
RUN sed -i 's#^command=bash -c .sleep 10 && /home/printer/klipper/scripts/avrsim.py.*#command=/home/printer/klipper-host-mcu#' /etc/supervisor/supervisord.conf \
 && grep -q klipper-host-mcu /etc/supervisor/supervisord.conf
COPY printer.cfg /home/printer/example-configs/printer.cfg
COPY moonraker.conf /home/printer/example-configs/moonraker.conf
USER printer
