# DolphinSlicer, self-hosted: the app and its storage folder behind nginx (docs/SELF_HOST_DOCKER.md).
# Build context: app/, after `npm run build:docker` (writes dist-docker/).
# SPDX-License-Identifier: AGPL-3.0-or-later
FROM nginx:stable-alpine
COPY docker/default.conf /etc/nginx/conf.d/default.conf
COPY docker/headers.conf /etc/nginx/dolphin-headers.conf
COPY dist-docker/ /usr/share/nginx/html/
# Presets, models, printers and settings (the storage folder).
RUN install -d -o nginx -g nginx /data
VOLUME /data
EXPOSE 80
