#!/bin/bash
#
# Prepara le risorse da includere nel bundle .app:
#   - server.js, eiscp.js, public/ e dipendenze di produzione (express)
#   - runtime Node.js ufficiale (arm64 o x64 in base al Mac)
#
# Le risorse finiscono in desktop/src-tauri/resources e sono gitignored:
# vengono rigenerate a ogni build.
#
set -eu

DESKTOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
RES_DIR="$DESKTOP_DIR/src-tauri/resources"
CACHE_DIR="$DESKTOP_DIR/.cache"

NODE_VERSION="${NODE_VERSION:-26.3.1}"

case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) echo "Architettura non supportata: $(uname -m)"; exit 1 ;;
esac

mkdir -p "$CACHE_DIR"

echo "==> Pulizia risorse"
rm -rf "$RES_DIR"
mkdir -p "$RES_DIR/public"

echo "==> Copia server"
cp "$ROOT_DIR/server.js" "$ROOT_DIR/eiscp.js" "$ROOT_DIR/package.json" "$RES_DIR/"
cp "$ROOT_DIR"/public/* "$RES_DIR/public/"

echo "==> Dipendenze di produzione"
if [ -d "$ROOT_DIR/node_modules/express" ]; then
  cp -R "$ROOT_DIR/node_modules" "$RES_DIR/node_modules"
else
  ( cd "$RES_DIR" && npm install --omit=dev --no-audit --no-fund )
fi

echo "==> Runtime Node.js v$NODE_VERSION ($NODE_ARCH)"
TARBALL="$CACHE_DIR/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
if [ ! -f "$TARBALL" ]; then
  curl -fL --retry 3 -o "$TARBALL" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
fi

TMP_EXTRACT="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMP_EXTRACT"
cp "$TMP_EXTRACT/node-v$NODE_VERSION-darwin-$NODE_ARCH/bin/node" "$RES_DIR/node"
rm -rf "$TMP_EXTRACT"
chmod +x "$RES_DIR/node"

# Su Apple Silicon ogni binario deve avere almeno una firma ad-hoc valida.
codesign --force --sign - "$RES_DIR/node" >/dev/null 2>&1 || true

echo "==> Verifica runtime"
"$RES_DIR/node" -v

echo "==> Risorse pronte in $RES_DIR"
du -sh "$RES_DIR"
