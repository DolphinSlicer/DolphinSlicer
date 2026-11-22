# Desktop OrcaSlicer CLI, used only to generate reference G-code for engine tests.
# Not part of the shipped app. Base and AppImage are pinned (engine/versions.env).
ARG REF_IMAGE_BASE
FROM ${REF_IMAGE_BASE}
ARG ORCA_APPIMAGE_URL
ARG ORCA_APPIMAGE_SHA256
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl libopengl0 libgl1 libegl1 libglu1-mesa libgtk-3-0t64 libwebkit2gtk-4.1-0 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libsecret-1-0 libxkbcommon0 libsm6 libice6 \
      libmspack0t64 \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/orca.AppImage "$ORCA_APPIMAGE_URL" \
 && echo "$ORCA_APPIMAGE_SHA256  /tmp/orca.AppImage" | sha256sum -c - \
 && chmod +x /tmp/orca.AppImage && cd /opt && /tmp/orca.AppImage --appimage-extract >/dev/null \
 && mv /opt/squashfs-root /opt/orca && rm /tmp/orca.AppImage
ENV LC_ALL=C HOME=/tmp
ENTRYPOINT ["/opt/orca/libexec/orca-slicer-env", "/opt/orca/bin/orca-slicer"]
