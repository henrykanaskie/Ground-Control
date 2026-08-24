#!/usr/bin/env bash
#
# build-app.sh, assemble GroundControl.app, a real macOS application around the
# dashboard that already lives in this repo.
#
#   ./build-app.sh              build ./GroundControl.app
#   ./build-app.sh --install    build it, then copy it to ~/Applications
#   ./build-app.sh --clean      remove build/ and GroundControl.app, then stop
#
# Nothing here needs sudo, nothing is written outside this repo and
# ~/Applications, and no toolchain beyond what macOS and Xcode already ship:
# swiftc to compile, sips to rasterise the icon, iconutil to pack it.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="GroundControl"
BUNDLE="$REPO/$APP_NAME.app"
BUILD="$REPO/build"
SRC="$REPO/app"

# The application's own runtime files, copied into the bundle so a built app
# keeps working if this folder is moved, renamed or deleted.
PAYLOAD=(server.js lib public package.json)

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
step()  { printf '  \033[38;5;214m›\033[0m %s\n' "$*"; }
note()  { printf '    %s\n' "$*"; }
die()   { printf '\n\033[1;31mbuild-app.sh: %s\033[0m\n\n' "$*" >&2; exit 1; }

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --clean)
      rm -rf "$BUILD" "$BUNDLE"
      bold "Removed build/ and $APP_NAME.app"
      exit 0 ;;
    -h|--help)
      sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown option '$arg' (try --install, --clean or --help)" ;;
  esac
done

# ── prerequisites ────────────────────────────────────────────────────────────

[ "$(uname -s)" = "Darwin" ] || die "this builds a macOS .app; it only runs on macOS."

if ! command -v swiftc >/dev/null 2>&1; then
  die "swiftc was not found.

  GroundControl.app is a native Swift + WKWebView shell, so it needs the Swift
  compiler that ships with Xcode or the Command Line Tools:

      xcode-select --install

  and then run ./build-app.sh again."
fi
command -v sips     >/dev/null 2>&1 || die "sips is missing (it ships with macOS), cannot rasterise the icon."
command -v iconutil >/dev/null 2>&1 || die "iconutil is missing (it ships with macOS), cannot build the .icns."

for f in "$SRC/GroundControl.swift" "$SRC/Info.plist" "$SRC/icon.svg"; do
  [ -f "$f" ] || die "missing source file: ${f#$REPO/}"
done
for p in "${PAYLOAD[@]}"; do
  [ -e "$REPO/$p" ] || die "missing runtime file: $p (run this from a full checkout)"
done

bold ""
bold "Building $APP_NAME.app"
note "$(swiftc --version 2>/dev/null | head -1)"
bold ""

# ── clean slate ──────────────────────────────────────────────────────────────
# Idempotent by demolition: the bundle is rebuilt from scratch every time, so a
# second run can never leave a stale binary or an orphaned resource behind.

rm -rf "$BUNDLE" "$BUILD"
mkdir -p "$BUILD" \
         "$BUNDLE/Contents/MacOS" \
         "$BUNDLE/Contents/Resources"

# ── 1. compile ───────────────────────────────────────────────────────────────

step "Compiling app/GroundControl.swift"
swiftc -O \
  -target "$(uname -m)-apple-macosx12.0" \
  -framework AppKit -framework WebKit \
  -o "$BUNDLE/Contents/MacOS/$APP_NAME" \
  "$SRC/GroundControl.swift" \
  2> "$BUILD/swiftc.log" || {
    cat "$BUILD/swiftc.log" >&2
    die "the Swift compile failed, see the errors above (full log: build/swiftc.log)."
  }
if [ -s "$BUILD/swiftc.log" ]; then
  note "compiler warnings in build/swiftc.log"
fi
chmod +x "$BUNDLE/Contents/MacOS/$APP_NAME"
note "$(du -h "$BUNDLE/Contents/MacOS/$APP_NAME" | cut -f1) binary"

# ── 2. icon ──────────────────────────────────────────────────────────────────
# app/icon.svg → the full iconset ladder → GroundControl.icns. sips reads SVG directly
# on modern macOS, so there is no third-party rasteriser in the loop.

step "Rendering app/icon.svg into the icon ladder"
ICONSET="$BUILD/$APP_NAME.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"

render() {   # render <pixels> <filename>
  sips -s format png -z "$1" "$1" "$SRC/icon.svg" --out "$ICONSET/$2" >/dev/null 2>&1 \
    || die "sips could not rasterise app/icon.svg at ${1}px."
}
for size in 16 32 128 256 512; do
  render "$size"             "icon_${size}x${size}.png"
  render "$((size * 2))"     "icon_${size}x${size}@2x.png"
done
note "$(ls "$ICONSET" | wc -l | tr -d ' ') images, 16px through 1024px"

iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/$APP_NAME.icns" \
  || die "iconutil could not build $APP_NAME.icns from the iconset."
note "Resources/$APP_NAME.icns"

# ── 3. Info.plist ────────────────────────────────────────────────────────────

step "Installing Info.plist"
cp "$SRC/Info.plist" "$BUNDLE/Contents/Info.plist"
plutil -lint "$BUNDLE/Contents/Info.plist" >/dev/null || die "app/Info.plist is not valid."
printf 'APPL????' > "$BUNDLE/Contents/PkgInfo"

# ── 4. runtime payload ───────────────────────────────────────────────────────
# server.js, lib/, public/ and package.json go inside the bundle. The app runs
# the copy in Contents/Resources, never this checkout, so the built app is
# self-contained.

step "Copying the dashboard into Contents/Resources"
for p in "${PAYLOAD[@]}"; do
  rm -rf "${BUNDLE:?}/Contents/Resources/$p"
  cp -R "$REPO/$p" "$BUNDLE/Contents/Resources/$p"
done
# Nothing generated, cached or private belongs in a shipped bundle.
rm -rf "$BUNDLE/Contents/Resources/.forge" \
       "$BUNDLE/Contents/Resources/node_modules"
find "$BUNDLE/Contents/Resources" -name '.DS_Store' -delete 2>/dev/null || true
note "$(printf '%s ' "${PAYLOAD[@]}")- $(du -sh "$BUNDLE/Contents/Resources" | cut -f1) total"

# ── 5. register ──────────────────────────────────────────────────────────────

touch "$BUNDLE"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$BUNDLE" 2>/dev/null || true

bold ""
bold "Built $APP_NAME.app ($(du -sh "$BUNDLE" | cut -f1))"
note "$BUNDLE"

# ── 6. optional install ──────────────────────────────────────────────────────

if [ "$INSTALL" -eq 1 ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  step "Installing to $DEST"
  rm -rf "$DEST/$APP_NAME.app"
  cp -R "$BUNDLE" "$DEST/$APP_NAME.app"
  touch "$DEST/$APP_NAME.app"
  [ -x "$LSREG" ] && "$LSREG" -f "$DEST/$APP_NAME.app" 2>/dev/null || true
  note "$DEST/$APP_NAME.app"
fi

# ── 7. what to expect ────────────────────────────────────────────────────────

cat <<EOF

  This app is unsigned and not notarised, there is no Developer ID here, and
  faking one would be worse than saying so. What that means in practice:

  · Built on this Mac and left here, it carries no quarantine flag, so
    double-clicking it just works. Verified: it opens without a prompt.
  · Move it anywhere that quarantines files (AirDrop, a download, a zip
    pulled off the internet) and Gatekeeper will refuse the first open with
    "Apple could not verify $APP_NAME". Once, on first launch only:

        right-click (or Control-click) $APP_NAME.app  ›  Open  ›  Open

    and every launch after that is an ordinary double-click. If macOS still
    blocks it, System Settings › Privacy & Security has an "Open Anyway"
    button underneath the warning.

  Ground Control runs a Node server behind its window. It finds node by itself, picks
  a free port on every launch, and stops the server when you quit, so it will
  not collide with a \`node server.js\` you started yourself. The server's
  output goes to ~/Library/Logs/GroundControl/server.log.

EOF
