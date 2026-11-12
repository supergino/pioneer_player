#!/bin/bash
#
# Build completa dell'app macOS: prepara le risorse e lancia Tauri.
# Risultato: desktop/src-tauri/target/release/bundle/macos/Pioneer Controller.app
#
set -eu

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$DESKTOP_DIR"

if [ ! -d node_modules/@tauri-apps/cli ]; then
  echo "==> Installazione Tauri CLI"
  npm install --no-audit --no-fund
fi

bash scripts/prepare-resources.sh
npx tauri build
