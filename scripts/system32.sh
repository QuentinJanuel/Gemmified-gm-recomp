#!/bin/sh
# Fills system32/ with the redistributable Windows DLLs games may need but do not ship (C/C++
# runtimes, the shader compiler, D3DX 9, msacm32, and what they import), from WineHQ's own
# 32-bit build of Wine 11.0, via upstream's web/tools/system32.sh. LGPL-2.1-or-later: the
# licence and where the source is go beside them. Needs curl, ar, tar, python3 and objcopy
# (llvm-objcopy does), and runs only when system32/ is missing.
# `system32.sh source` instead downloads and checks Wine's source tarball into the current
# directory and prints its name: CI publishes it beside each release's zip.
set -e
wine=11.0
deb=wine-stable-i386_$wine.0.0~trixie-1_i386.deb
sha=e35945ec82884b1f420bcf6e7e60410d3c826375464f559b76dc47b27fcf8da6
src=wine-$wine.tar.xz
# WineHQ's own, from https://dl.winehq.org/wine/source/11.0/sha512sums.asc
srcsha=a2c3db14f8cf0d19927466805c8f17c68ee7e93d1196d1162dd2279af497c21ec611a63f7a9de59953bbdfdb44c87d7bf55373c6533224a5d54e434c29428d1b
srcurl=https://dl.winehq.org/wine/source/$wine/$src
if [ "$1" = source ]; then
  curl -sfL -o "$src" "$srcurl"
  echo "$srcsha  $src" | shasum -a 512 -c - > /dev/null || { rm -f "$src"; exit 1; }
  echo "$src"
  exit 0
fi
here=$(cd "$(dirname "$0")/.." && pwd)
out=$here/system32
[ -d "$out" ] && exit 0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -sfL -o "$tmp/$deb" "https://dl.winehq.org/wine-builds/debian/pool/main/w/wine/$deb"
echo "$sha  $tmp/$deb" | shasum -a 256 -c - > /dev/null
(cd "$tmp" && ar x "$deb" && mkdir x && tar -xf data.tar.* -C x)
for f in COPYING.LIB LICENSE; do curl -sfL -o "$tmp/$f" "https://gitlab.winehq.org/wine/wine/-/raw/wine-$wine/$f"; done
echo "e237fa56668030e928551ddd60f05df5fe957f75eab874bbd017e085ed722e7c  $tmp/COPYING.LIB" | shasum -a 256 -c - > /dev/null
echo "ae025f125a5d639f0f7abe5146efa1e3d7453cc10b744b2910806fa3f46626ef  $tmp/LICENSE" | shasum -a 256 -c - > /dev/null
rm -rf "$here/web/public/system32"
sh "$here/web/tools/system32.sh" "$tmp/x/opt/wine-stable/lib/wine/i386-windows"
mv "$here/web/public/system32" "$tmp/system32"
cp "$tmp/COPYING.LIB" "$tmp/LICENSE" "$tmp/system32/"
cat > "$tmp/system32/README" <<TXT
These DLLs are Wine $wine (https://www.winehq.org/), as built by WineHQ
($deb), with their debug sections stripped.
They are licensed under the GNU Lesser General Public License 2.1 or later
(COPYING.LIB; copyright notice in LICENSE). Their source code, $src, is published
beside this build: https://gemmified-gm-recomp.dappermink.me/<version>/$src, where
<version> is this build's (the folder its gm-recomp-<version>.zip is in), and at
$srcurl
TXT
mv "$tmp/system32" "$out"
echo "system32/: $(ls "$out" | grep -c '\.dll$') DLLs, $(du -sh "$out" | cut -f1)"
