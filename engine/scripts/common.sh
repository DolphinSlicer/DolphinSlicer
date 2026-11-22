# Shared helpers for engine scripts. Source, don't execute.
set -euo pipefail
ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ENGINE_DIR/.." && pwd)"
# shellcheck source=../versions.env
source "$ENGINE_DIR/versions.env"
WORK="${ORCA_WORK:-$REPO_DIR/.work}"
mkdir -p "$WORK"/{dl,ccache,emcache}

# Fetch the pinned OrcaSlicer source (pristine) once; patched copies are made per build.
fetch_orca() {
  local dst="$WORK/orca-src"
  if [[ ! -d "$dst/.git" ]]; then
    git clone --quiet --depth 1 --branch "$ORCA_TAG" "$ORCA_REPO" "$dst"
  fi
  local sha; sha="$(git -C "$dst" rev-parse HEAD)"
  [[ "$sha" == "$ORCA_SHA" ]] || { echo "Orca SHA mismatch: $sha != $ORCA_SHA" >&2; exit 1; }
}

ensure_toolchain_image() {
  docker image inspect "$TOOLCHAIN_IMAGE" >/dev/null 2>&1 || docker build -t "$TOOLCHAIN_IMAGE" "$ENGINE_DIR/docker"
}

# Run a command in the toolchain container. Repo at /src, work dir at /work.
in_toolchain() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/work \
    -e DEPS_JOBS="${DEPS_JOBS:-}" -e ENGINE_JOBS="${ENGINE_JOBS:-}" \
    -v "$REPO_DIR:/src" -v "$WORK:/work" -w /src "$TOOLCHAIN_IMAGE" bash -c "$*"
}
