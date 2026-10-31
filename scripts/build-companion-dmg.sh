#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The macOS DMG builder must run on a Mac."
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="$ROOT/public/companion/gravasimples-macos.zip"
OUTPUT="$ROOT/public/companion/gravasimples-macos.dmg"
if [ ! -f "$ARCHIVE" ]; then
  echo "Missing macOS companion ZIP: $ARCHIVE"
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gravasimples-dmg.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

/usr/bin/unzip -q "$ARCHIVE" -d "$WORK"
SOURCE="$WORK/GravaSimples-macOS"
if [ ! -d "$SOURCE" ]; then
  echo "The companion ZIP has no GravaSimples-macOS directory."
  exit 1
fi

/usr/bin/hdiutil create -quiet -volname "GravaSimples" -srcfolder "$SOURCE" -ov -format UDZO "$OUTPUT"
/usr/bin/shasum -a 256 "$OUTPUT"
