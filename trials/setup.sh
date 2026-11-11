#!/usr/bin/env bash
# Prepare a fresh, non-workspace trial from already-built public packages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# != 1 || ! -d "$1" ]]; then
  echo "Usage: bash trials/setup.sh <existing-new-trial-directory>" >&2
  exit 1
fi
TRIAL="$(cd "$1" && pwd)"
# Refuse to overwrite an existing trial or its evidence.
for file in package.json tsconfig.json vitest.config.ts node_modules; do
  if [[ -e "$TRIAL/$file" || -L "$TRIAL/$file" ]]; then
    echo "Refusing to overwrite $TRIAL/$file" >&2
    exit 1
  fi
done
for package in core sqlite; do
  if [[ ! -f "$ROOT/packages/$package/dist/index.d.ts" ]]; then
    echo "Build packages first: missing packages/$package/dist/index.d.ts" >&2
    exit 1
  fi
done
mkdir -p "$TRIAL/node_modules/@triplex-build" "$TRIAL/node_modules/@types" "$TRIAL/src" "$TRIAL/test"
ln -s "$ROOT/packages/core" "$TRIAL/node_modules/@triplex-build/triplex"
ln -s "$ROOT/packages/sqlite" "$TRIAL/node_modules/@triplex-build/triplex-sqlite"
# One Effect copy, shared with core, to preserve service identity.
ln -s "$ROOT/packages/core/node_modules/effect" "$TRIAL/node_modules/effect"
ln -s "$ROOT/node_modules/vitest" "$TRIAL/node_modules/vitest"
ln -s "$ROOT/node_modules/@types/node" "$TRIAL/node_modules/@types/node"
printf '%s\n' '{ "private": true, "type": "module" }' > "$TRIAL/package.json"
cat > "$TRIAL/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["node"], "lib": ["ES2024"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
JSON
cat > "$TRIAL/vitest.config.ts" <<'TS'
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
TS
printf 'Prepared %s from built packages in %s\n' "$TRIAL" "$ROOT"
