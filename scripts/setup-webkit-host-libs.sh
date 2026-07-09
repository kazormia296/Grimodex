#!/usr/bin/env bash
# Playwright WebKit (Ubuntu 向けビルド) を Arch 等の非 apt ホストで動かすための
# 互換ライブラリ (libicu74 / libxml2.so.2 / libflite1) を Ubuntu noble の .deb から
# 展開する。sudo 不要・システムには一切触らない。
#
# 展開先: ${XDG_CACHE_HOME:-$HOME/.cache}/grimodex/webkit-host-libs
# vitest.browser.config.ts がこのディレクトリの存在を検出し、WebKit 起動時のみ
# LD_LIBRARY_PATH に追加する。
set -euo pipefail

DEST="${XDG_CACHE_HOME:-$HOME/.cache}/grimodex/webkit-host-libs"
MIRROR="${UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
PACKAGES=(libicu74 libxml2 libflite1)

if command -v apt-get >/dev/null 2>&1; then
  echo "apt 系ホストではこのスクリプトは不要です。代わりに以下を実行してください:"
  echo "  sudo pnpm exec playwright install-deps webkit"
  exit 0
fi

if [[ -e "$DEST/libicudata.so.74" && -e "$DEST/libxml2.so.2" && -e "$DEST/libflite.so.1" ]]; then
  echo "展開済み: $DEST"
  exit 0
fi

command -v bsdtar >/dev/null 2>&1 || {
  echo "bsdtar (libarchive) が必要です" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Ubuntu noble のパッケージ索引を取得中..."
# libicu74 / libxml2 は main、libflite1 は universe にある
: > "$TMP/index"
for dist in noble noble-updates; do
  for comp in main universe; do
    curl -fsSL "$MIRROR/dists/$dist/$comp/binary-amd64/Packages.gz" | gzip -dc >> "$TMP/index"
  done
done

mkdir -p "$DEST"
for pkg in "${PACKAGES[@]}"; do
  # 索引は Package/Filename のレコード列。同名パッケージは後勝ち
  # (noble-updates を後に連結しているので新しい方が採用される)。
  file="$(awk -v p="$pkg" -v RS= -v FS='\n' '
    {
      name = ""; fn = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^Package: /) name = substr($i, 10)
        if ($i ~ /^Filename: /) fn = substr($i, 11)
      }
      if (name == p) last = fn
    }
    END { print last }
  ' "$TMP/index")"
  [[ -n "$file" ]] || {
    echo "パッケージ索引に $pkg が見つかりません" >&2
    exit 1
  }
  echo "取得: $file"
  curl -fsSL "$MIRROR/$file" -o "$TMP/pkg.deb"
  bsdtar -xOf "$TMP/pkg.deb" "data.tar*" | bsdtar -xf - -C "$TMP" "./usr/lib/x86_64-linux-gnu/*"
done

cp -a "$TMP"/usr/lib/x86_64-linux-gnu/. "$DEST"/
echo "展開完了: $DEST"
ls "$DEST"
