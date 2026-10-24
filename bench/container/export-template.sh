#!/usr/bin/env bash
# Copies template/ into <dest> as a fresh git repo with a single commit, without data,
# node_modules or anything else generated. This is the repo each agent starts from.
#
# Usage: bench/agent/export-template.sh <dest>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:?usage: export-template.sh <dest>}"

rm -rf "$DEST"
mkdir -p "$DEST"
# Only files tracked in the harness repo, so ignored and generated files never leak in.
git -C "$ROOT" ls-files -z template | while IFS= read -r -d '' f; do
  mkdir -p "$DEST/$(dirname "${f#template/}")"
  cp "$ROOT/$f" "$DEST/${f#template/}"
done
chmod +x "$DEST"/scripts/*.sh

git -C "$DEST" init -q -b main
git -C "$DEST" add -A
git -C "$DEST" -c user.name=bench -c user.email=bench@localhost commit -q -m "Initial commit"
echo "Exported template to $DEST"
