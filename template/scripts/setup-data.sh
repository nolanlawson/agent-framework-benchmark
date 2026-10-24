#!/usr/bin/env bash
# Downloads pinned snapshots of the PokeAPI data, sprites and cries and lays them out
# under data/ for api/server.mjs. Safe to re-run; does nothing if data/ is complete.
set -euo pipefail

API_DATA_COMMIT=447bd5c378bf87da964bfe4dd7487a7bf1d97cbd
SPRITES_COMMIT=97a7832d307311c0e1c6ea9035308bf80cc94f81
CRIES_COMMIT=b3a9044bb839b5e3152aaa536c7b463a0fcf0140

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.data-cache"
DATA="$ROOT/data"

fetch() { # <repo> <commit> [sparse-checkout patterns...]
  local dir="$CACHE/$1" repo="$1" commit="$2"
  shift 2
  if [ -f "$dir/.done" ]; then return; fi
  rm -rf "$dir" && mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "https://github.com/PokeAPI/$repo.git"
  # Blobless fetch + sparse checkout: a full pack of the sprites repo is too large to
  # download reliably, and most of it (per-game sprites) is not needed.
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$commit"
  if [ $# -gt 0 ]; then git -C "$dir" sparse-checkout set --no-cone "$@"; fi
  git -C "$dir" checkout -q FETCH_HEAD
  touch "$dir/.done"
}

if [ -f "$DATA/.done" ]; then echo "Data already present in $DATA"; exit 0; fi

echo "Fetching PokeAPI snapshots (about 1.7 GB)..."
fetch api-data "$API_DATA_COMMIT"
fetch sprites "$SPRITES_COMMIT" '/sprites/' '!/sprites/pokemon/versions/' '!/sprites/pokemon/other/showdown/'
fetch cries "$CRIES_COMMIT" '/cries/'

rm -rf "$DATA" && mkdir -p "$DATA/media"
mv "$CACHE/sprites/sprites" "$DATA/media/sprites"
mv "$CACHE/cries/cries" "$DATA/media/cries"
node "$ROOT/scripts/scrub-data.mjs" "$CACHE/api-data/data" "$DATA"
touch "$DATA/.done"

rm -rf "$CACHE"
echo "Data ready in $DATA"
