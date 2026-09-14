#!/bin/sh
set -eu

# Installs the Codex Web GPT desktop launcher from this repo checkout,
# without downloading a release asset. Mirrors scripts/install-launcher.sh,
# but packages and installs from the local working tree instead of a GitHub
# release. Electron-builder disallows cross-packaging, so this only builds
# for the OS you run it on (macOS -> .app in /Applications, Linux -> AppImage
# + desktop entry). Use install-launcher.ps1 on Windows.
#
# Usage:
#   ./scripts/install-launcher-local.sh [--skip-build]
#
# Env overrides (same names as install-launcher.sh):
#   CODEX_WEB_GPT_APPLICATIONS_DIR  (macOS install dir, default: /Applications)
#   CODEX_WEB_GPT_LIB_DIR           (Linux install dir, default: $HOME/.local/lib/codex-web-gpt)
#   CODEX_WEB_GPT_BIN_DIR           (Linux wrapper dir, default: $HOME/.local/bin)
#   CODEX_CHATGPT_WEB_HOME          (used to detect a running instance, default: $HOME/.codex-chatgpt-web)

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
cd "$ROOT"

SKIP_BUILD=0
if [ "${1:-}" = "--skip-build" ]; then
  SKIP_BUILD=1
fi

OS="$(uname -s)"
MACHINE="$(uname -m)"

case "$OS" in
  Darwin)
    PLATFORM="mac"
    EXTENSION="zip"
    case "$MACHINE" in
      arm64|aarch64) ARCH="arm64" ;;
      x86_64|amd64) ARCH="x64" ;;
      *) echo "Unsupported macOS architecture: $MACHINE" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    PLATFORM="linux"
    EXTENSION="AppImage"
    case "$MACHINE" in
      x86_64|amd64) ARCH="x64" ;;
      *) echo "The packaged Linux launcher currently supports x86_64; detected $MACHINE" >&2; exit 1 ;;
    esac
    ;;
  *) echo "Use install-launcher.ps1 on Windows; unsupported OS: $OS" >&2; exit 1 ;;
esac

ARTIFACTS_DIR="$ROOT/launcher/artifacts"
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/launcher/package.json" | head -n 1)"
if [ -z "$VERSION" ]; then
  echo "Could not read version from launcher/package.json" >&2
  exit 1
fi
ASSET="codex-web-gpt-$VERSION-$PLATFORM-$ARCH.$EXTENSION"

if [ "$SKIP_BUILD" -eq 0 ] || [ ! -f "$ARTIFACTS_DIR/$ASSET" ]; then
  echo "Packaging launcher from $ROOT ..." >&2
  bun run app:package
fi

if [ ! -f "$ARTIFACTS_DIR/$ASSET" ]; then
  echo "Expected packaged artifact not found: $ARTIFACTS_DIR/$ASSET" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-web-gpt-launcher-local.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

if [ "$OS" = "Darwin" ]; then
  INSTALL_DIR="${CODEX_WEB_GPT_APPLICATIONS_DIR:-/Applications}"
  STAGE_DIR="$TEMP_DIR/stage"
  mkdir "$STAGE_DIR"
  ditto -x -k "$ARTIFACTS_DIR/$ASSET" "$STAGE_DIR"
  SOURCE_APP="$STAGE_DIR/Codex Web GPT.app"
  if [ ! -d "$SOURCE_APP" ] || [ ! -x "$SOURCE_APP/Contents/MacOS/Codex Web GPT" ]; then
    echo "Packaged launcher archive is incomplete" >&2
    exit 1
  fi
  if [ ! -w "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/Applications"
    mkdir -p "$INSTALL_DIR"
  fi
  TARGET_APP="$INSTALL_DIR/Codex Web GPT.app"
  if pgrep -x "Codex Web GPT" >/dev/null 2>&1; then
    echo "Quit Codex Web GPT before updating it" >&2
    exit 1
  fi
  BACKUP_APP="$TEMP_DIR/Codex Web GPT.previous.app"
  if [ -e "$TARGET_APP" ]; then mv "$TARGET_APP" "$BACKUP_APP"; fi
  if ! ditto "$SOURCE_APP" "$TARGET_APP"; then
    rm -rf "$TARGET_APP"
    if [ -e "$BACKUP_APP" ]; then mv "$BACKUP_APP" "$TARGET_APP"; fi
    exit 1
  fi
  echo "Installed $TARGET_APP (from local checkout, version $VERSION)"
  open "$TARGET_APP"
  exit 0
fi

LIB_DIR="${CODEX_WEB_GPT_LIB_DIR:-$HOME/.local/lib/codex-web-gpt}"
BIN_DIR="${CODEX_WEB_GPT_BIN_DIR:-$HOME/.local/bin}"
TARGET_DIR="$LIB_DIR/$VERSION"
TARGET="$TARGET_DIR/Codex Web GPT.AppImage"
WRAPPER="$BIN_DIR/codex-web-gpt"
CORE_HOME="${CODEX_CHATGPT_WEB_HOME:-$HOME/.codex-chatgpt-web}"
DESCRIPTOR="$CORE_HOME/runtime/launcher-browser.json"
RUNNING_PID=""
if [ -f "$DESCRIPTOR" ]; then
  RUNNING_PID="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DESCRIPTOR" | head -n 1)"
fi
if { [ -n "$RUNNING_PID" ] && kill -0 "$RUNNING_PID" 2>/dev/null; } \
  || pgrep -f "Codex Web GPT\\.AppImage" >/dev/null 2>&1; then
  echo "Quit Codex Web GPT before updating it" >&2
  exit 1
fi
EXTRACT_DIR="$TEMP_DIR/appimage"
mkdir -p "$EXTRACT_DIR"
chmod 0755 "$ARTIFACTS_DIR/$ASSET"
(
  cd "$EXTRACT_DIR"
  "$ARTIFACTS_DIR/$ASSET" --appimage-extract >/dev/null
)
ICON_SOURCE="$(find "$EXTRACT_DIR/squashfs-root" -type f -path '*/512x512/*' -name '*.png' | sort | head -n 1)"
if [ -z "$ICON_SOURCE" ]; then
  ICON_SOURCE="$(find "$EXTRACT_DIR/squashfs-root" -type f -name '*.png' | sort | head -n 1)"
fi
if [ -z "$ICON_SOURCE" ]; then
  echo "Launcher AppImage does not contain a PNG application icon" >&2
  exit 1
fi
RUNNER_SOURCE="$(find "$EXTRACT_DIR/squashfs-root" -type f -path '*/app.asar.unpacked/assets/linux-appimage-runner.sh' -print -quit)"
if [ -z "$RUNNER_SOURCE" ]; then
  echo "Launcher AppImage does not contain its bounded Linux runner" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$BIN_DIR"
TARGET_NEXT="$TARGET.next.$$"
WRAPPER_NEXT="$WRAPPER.next.$$"
RUNNER="$LIB_DIR/run-appimage"
RUNNER_NEXT="$RUNNER.next.$$"
trap 'rm -rf "$TEMP_DIR"; rm -f "$TARGET_NEXT" "$WRAPPER_NEXT" "$RUNNER_NEXT"' EXIT HUP INT TERM
install -m 0755 "$ARTIFACTS_DIR/$ASSET" "$TARGET_NEXT"
mv -f "$TARGET_NEXT" "$TARGET"
install -m 0755 "$RUNNER_SOURCE" "$RUNNER_NEXT"
mv -f "$RUNNER_NEXT" "$RUNNER"
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
WRAPPER_QUOTED="$(shell_quote "$WRAPPER")"
TARGET_QUOTED="$(shell_quote "$TARGET")"
RUNNER_QUOTED="$(shell_quote "$RUNNER")"
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' 'set -eu'
  printf 'export CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=%s\n' "$WRAPPER_QUOTED"
  printf 'export CODEX_WEB_GPT_APPIMAGE=%s\n' "$TARGET_QUOTED"
  printf 'exec %s %s "$@"\n' "$RUNNER_QUOTED" "$TARGET_QUOTED"
} > "$WRAPPER_NEXT"
chmod 0755 "$WRAPPER_NEXT"
mv -f "$WRAPPER_NEXT" "$WRAPPER"

APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
mkdir -p "$APPLICATIONS_DIR" "$ICON_DIR"
install -m 0644 "$ICON_SOURCE" "$ICON_DIR/codex-web-gpt.png"
DESKTOP_WRAPPER="$(printf '%s' "$WRAPPER" | sed \
  -e 's/\\/\\\\/g' \
  -e 's/"/\\"/g' \
  -e 's/`/\\`/g' \
  -e 's/\$/\\$/g' \
  -e 's/%/%%/g')"
cat > "$APPLICATIONS_DIR/codex-web-gpt.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Codex Web GPT
Comment=ChatGPT Web models inside the native Codex harness
Exec="$DESKTOP_WRAPPER"
Icon=codex-web-gpt
Terminal=false
Categories=Development;
StartupWMClass=codex-web-gpt
EOF
chmod 0644 "$APPLICATIONS_DIR/codex-web-gpt.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi
echo "Installed $TARGET (from local checkout, version $VERSION)"
nohup "$WRAPPER" >/dev/null 2>&1 &
