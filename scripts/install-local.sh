#!/bin/sh
set -eu

# Installs the codex-chatgpt-web CLI/runtime bridge from this repo checkout,
# without downloading a release asset. Mirrors scripts/install.sh, but builds
# and installs from the local working tree instead of a GitHub release.
#
# Usage:
#   ./scripts/install-local.sh [--skip-build] [-- setup-args...]
#
# Env overrides (same names as install.sh):
#   CODEX_CHATGPT_WEB_BIN_DIR   (default: $HOME/.local/bin)
#   CODEX_CHATGPT_WEB_LIB_DIR   (default: $HOME/.local/lib/codex-chatgpt-web)
#   CODEX_CHATGPT_WEB_DOC_DIR   (default: $HOME/.local/share/doc/codex-chatgpt-web)

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
cd "$ROOT"

SKIP_BUILD=0
if [ "${1:-}" = "--skip-build" ]; then
  SKIP_BUILD=1
  shift
fi

BIN_DIR="${CODEX_CHATGPT_WEB_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${CODEX_CHATGPT_WEB_LIB_DIR:-$HOME/.local/lib/codex-chatgpt-web}"
DOC_DIR="${CODEX_CHATGPT_WEB_DOC_DIR:-$HOME/.local/share/doc/codex-chatgpt-web}"
BUILD_DIR="$ROOT/dist/runtime"

if [ "$SKIP_BUILD" -eq 0 ] || [ ! -d "$BUILD_DIR" ]; then
  echo "Building runtime bundle from $ROOT ..." >&2
  bun run build
fi

if [ ! -x "$BUILD_DIR/bin/codex-chatgpt-web" ] || [ ! -x "$BUILD_DIR/runtime/bun" ]; then
  echo "Runtime bundle at $BUILD_DIR is incomplete; run without --skip-build" >&2
  exit 1
fi
if [ ! -f "$BUILD_DIR/manifest.json" ]; then
  echo "Runtime bundle at $BUILD_DIR is missing manifest.json" >&2
  exit 1
fi
VERSION="$(sed -n 's/.*"appVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$BUILD_DIR/manifest.json" | head -n 1)"
if [ -z "$VERSION" ]; then
  echo "Could not read appVersion from $BUILD_DIR/manifest.json" >&2
  exit 1
fi
if [ "$("$BUILD_DIR/bin/codex-chatgpt-web" --version)" != "$VERSION" ]; then
  echo "Built runtime version does not match manifest ($VERSION)" >&2
  exit 1
fi

STAGE_DIR="$LIB_DIR/.stage-$VERSION-$$"
TARGET_DIR="$LIB_DIR/$VERSION"
BACKUP_DIR="$LIB_DIR/.previous-$VERSION-$$"
trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM

mkdir -p "$LIB_DIR" "$BIN_DIR" "$DOC_DIR"
rm -rf "$STAGE_DIR"
cp -R "$BUILD_DIR" "$STAGE_DIR"

if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGE_DIR" "$TARGET_DIR"; then
  if [ -e "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$TARGET_DIR"; fi
  exit 1
fi

ln -sfn "$TARGET_DIR/bin/codex-chatgpt-web" "$BIN_DIR/.codex-chatgpt-web.next"
mv -f "$BIN_DIR/.codex-chatgpt-web.next" "$BIN_DIR/codex-chatgpt-web"
rm -f "$BIN_DIR/codex-chatgpt-web.legacy-standalone"

install -m 0644 "$ROOT/LICENSE" "$DOC_DIR/LICENSE"
install -m 0644 "$ROOT/LICENSES/Bun-1.4.0.md" "$DOC_DIR/Bun-1.4.0.md"
install -m 0644 "$TARGET_DIR/THIRD_PARTY_NOTICES.txt" "$DOC_DIR/THIRD_PARTY_NOTICES.txt"

if [ -e "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi

echo "Installed $TARGET_DIR (from local checkout, version $VERSION)"
if [ "$#" -gt 0 ]; then
  "$TARGET_DIR/bin/codex-chatgpt-web" setup "$@"
  exit 0
fi
echo "Next: $BIN_DIR/codex-chatgpt-web setup --browser-only --acknowledge-unofficial"
