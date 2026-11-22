#!/usr/bin/env bash
# Create the patched OrcaSlicer tree used by engine builds:
#   pristine checkout (.work/orca-src @ ORCA_SHA)  +  git am engine/patches/orca/*.patch
# Output: .work/orca-patched (a git repo; one commit per patch, so `git format-patch` can
# regenerate the series after editing).
source "$(dirname "$0")/common.sh"
fetch_orca
dst="$WORK/orca-patched"
shopt -s nullglob
patches=("$ENGINE_DIR"/patches/orca/*.patch)
want="$( { echo "$ORCA_SHA"; (( ${#patches[@]} )) && cat "${patches[@]}"; true; } | sha256sum | cut -c1-16)"
if [[ -f "$dst/.patchset" && "$(cat "$dst/.patchset")" == "$want" && "${FORCE:-0}" != 1 ]]; then
  echo "orca-patched up to date ($want)"; exit 0
fi
if [[ -d "$dst/.git" ]] && [[ -n "$(git -C "$dst" status --porcelain --untracked-files=no)" ]]; then
  echo "refusing to recreate $dst: it has uncommitted edits (commit + git format-patch first)" >&2; exit 1
fi
rm -rf "$dst"
git clone --quiet --shared "$WORK/orca-src" "$dst"
git -C "$dst" checkout --quiet -b wasm "$ORCA_SHA"
if (( ${#patches[@]} )); then
  git -C "$dst" -c user.name=DolphinSlicer -c user.email=build@localhost am --quiet --keep-cr "${patches[@]}"
fi
echo "$want" > "$dst/.patchset"
echo "orca-patched: ${#patches[@]} patches applied on $ORCA_TAG"
