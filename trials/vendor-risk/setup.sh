#!/usr/bin/env bash
# Link the locally built Triplex packages into this (non-workspace) trial directory.
# trials/ is not in pnpm-workspace.yaml, so `@triplex-build/*` cannot be resolved otherwise.
# Prerequisite (from repo root): pnpm install --frozen-lockfile &&
#   pnpm turbo run build --filter=@triplex-build/triplex-sqlite... --filter=@triplex-build/triplex-cli...
set -euo pipefail
cd "$(dirname "$0")"
ROOT=../..
mkdir -p node_modules/@triplex-build
ln -sfn ../../$ROOT/packages/core node_modules/@triplex-build/triplex
ln -sfn ../../$ROOT/packages/sqlite node_modules/@triplex-build/triplex-sqlite
# Use the exact effect copy core resolves, so service tags are shared (see docs/troubleshooting.md).
ln -sfn ../$ROOT/packages/core/node_modules/effect node_modules/effect
ls -l node_modules node_modules/@triplex-build
