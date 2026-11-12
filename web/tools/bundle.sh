#!/bin/sh
# Collects what a site needs to embed the player (web/src/player.mjs) into one directory:
# the page modules, the two browser builds, the site's translation profiles and the system
# DLLs games may need (tools/system32.sh). The files
# find each other by relative paths, so the directory can be served under any path.
#   web/tools/bundle.sh <out dir>
# SKIP_BUILD=1 uses the builds already in target/; SOUNDFONT=<file.sf2> adds a General
# MIDI SoundFont (Cloudflare Pages takes files up to 25 MB).
set -e
out=$1
[ -n "$out" ] || { echo "usage: $0 <out dir>" >&2; exit 2; }
here=$(cd "$(dirname "$0")/../.." && pwd)
cargo=${CARGO:-cargo}
if [ -z "$SKIP_BUILD" ]; then
  for spec in web:wasm webimport:wasm-import; do
    CARGO_PROFILE_RELEASE_DEBUG=0 $cargo +nightly build --release --target wasm32-unknown-unknown \
      -p "${spec%%:*}" --target-dir "$here/target/${spec#*:}" --manifest-path "$here/Cargo.toml"
  done
fi
rm -rf "$out"
mkdir -p "$out/src" "$out/runtime" "$out/import" "$out/profiles" "$out/system32"
cp "$here"/web/src/*.mjs "$here"/web/src/*.js "$out/src/"
cp "$here/target/wasm/wasm32-unknown-unknown/release/web.wasm" "$out/runtime/"
cp "$here/target/wasm-import/wasm32-unknown-unknown/release/webimport.wasm" "$out/import/"
cp "$here"/web/public/profiles/*.bin "$out/profiles/" 2>/dev/null || true
if ls "$here"/web/public/system32/*.dll > /dev/null 2>&1; then
  cp "$here"/web/public/system32/*.dll "$out/system32/"
else
  echo "warning: no system DLLs (run web/tools/system32.sh): games that need one will not import" >&2
fi
[ -n "$SOUNDFONT" ] && cp "$SOUNDFONT" "$out/soundfont.sf2"
cp "$here/LICENSE" "$out/LICENSE"
cat > "$out/NOTICE" <<'EOF'
gm-recomp player bundle (https://github.com/KurathSec/gm-recomp), MIT license (LICENSE).
system32/: Wine's i386 PE builds of redistributable runtime DLLs (https://www.winehq.org/),
LGPL-2.1-or-later; source at https://gitlab.winehq.org/wine/wine.
EOF
git -C "$here" rev-parse --short HEAD > "$out/VERSION" 2>/dev/null || true
echo "bundle in $out: $(du -sh "$out" | cut -f1)"
