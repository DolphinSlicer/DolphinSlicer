#!/usr/bin/env bash
# Regenerate engine/patches/orca from the commits in .work/orca-patched, and mark the tree as
# matching the series so prepare-orca.sh does not re-clone it (which would touch every file).
source "$(dirname "$0")/common.sh"
dst="$WORK/orca-patched"
[[ -z "$(git -C "$dst" status --porcelain --untracked-files=no)" ]] || { echo "commit your edits first" >&2; exit 1; }
rm -f "$ENGINE_DIR"/patches/orca/*.patch
git -C "$dst" format-patch --quiet --zero-commit --no-signature -o "$ENGINE_DIR/patches/orca" "$ORCA_SHA"
shopt -s nullglob
patches=("$ENGINE_DIR"/patches/orca/*.patch)
{ echo "$ORCA_SHA"; cat "${patches[@]}"; } | sha256sum | cut -c1-16 > "$dst/.patchset"
echo "exported ${#patches[@]} patches"
