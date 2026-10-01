#!/usr/bin/env bash
#
# bootstrap-build-env.sh — Grimodex ネイティブ（非 Docker / 非 devcontainer）ビルド環境セットアップ
#
# devcontainer を使わずローカルホスト上で Electron / N-API / 共有 Rust crate を
# 開発できる状態を作る。冪等（再実行しても安全）。対応 OS:
#   - Debian / Ubuntu 系 (apt)
#   - Arch / Manjaro 系 (pacman)
#   - macOS (Homebrew + Xcode CLT)
#
# 実行:
#   bash scripts/bootstrap-build-env.sh            # 依存導入 + pnpm install
#   SKIP_PNPM_INSTALL=1 bash scripts/bootstrap-build-env.sh   # システム依存のみ
#
# 参照: .devcontainer/Dockerfile / .github/workflows/ci.yml と依存リストを一致させている。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[bootstrap] エラー:\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# sudo が必要か判定（root なら不要）
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; else warn "sudo が無いため system パッケージ導入をスキップする可能性があります"; fi
fi

# ---------------------------------------------------------------------------
# 1) OS 別システム依存（Electron runtime + N-API release build）
# ---------------------------------------------------------------------------
install_debian_deps() {
  log "apt: Electron / N-API 依存を導入します"
  $SUDO apt-get update
  local alsa_package="libasound2"
  if apt-cache show libasound2t64 >/dev/null 2>&1; then
    alsa_package="libasound2t64"
  fi
  $SUDO apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    wget \
    file \
    pkg-config \
    libssl-dev \
    libdbus-1-dev \
    libsecret-1-dev \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libxtst6 \
    libgbm1 \
    libnotify4 \
    libatspi2.0-0 \
    "$alsa_package" \
    xdg-utils \
    patchelf \
    fonts-noto-cjk
}

install_arch_deps() {
  # Arch はパッケージを -dev で分割しないため、ヘッダは本体パッケージに含まれる。
  # base-devel に pkgconf(pkg-config) が含まれる。
  log "pacman: Electron / N-API 依存を導入します"
  $SUDO pacman -Sy --needed --noconfirm \
    base-devel \
    curl \
    wget \
    file \
    openssl \
    gtk3 \
    nss \
    alsa-lib \
    libxss \
    libxtst \
    mesa \
    libnotify \
    at-spi2-core \
    libsecret \
    dbus \
    xdg-utils \
    patchelf \
    noto-fonts-cjk
}

install_linux_deps() {
  if have apt-get; then
    install_debian_deps
  elif have pacman; then
    install_arch_deps
  else
    die "対応するパッケージマネージャ(apt-get / pacman)が見つかりません。"
  fi
}

install_macos_deps() {
  if ! xcode-select -p >/dev/null 2>&1; then
    log "Xcode Command Line Tools を導入します（GUI ダイアログが出る場合があります）"
    xcode-select --install || true
  fi
  # Electron は Chromium を同梱するため追加の WebView ライブラリは不要。
  if have brew && ! have pkg-config; then
    log "brew: pkg-config を導入します"
    brew install pkg-config || true
  fi
}

OS="$(uname -s)"
case "$OS" in
  Linux)  install_linux_deps ;;
  Darwin) install_macos_deps ;;
  *) die "未対応の OS: $OS（Windows は WSL2 上の Ubuntu か devcontainer を使ってください）" ;;
esac

# ---------------------------------------------------------------------------
# 2) Rust ツールチェーン（rustup stable + clippy）
# ---------------------------------------------------------------------------
if have cargo && have rustc; then
  log "Rust は導入済み: $(rustc --version)"
else
  log "rustup 経由で Rust stable を導入します"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1090,SC1091
  source "$HOME/.cargo/env"
fi
if have rustup; then
  rustup component add clippy >/dev/null 2>&1 || warn "clippy コンポーネント追加に失敗（既存の可能性あり）"
fi

# ---------------------------------------------------------------------------
# 3) Node / pnpm（packageManager フィールドに従い corepack で固定）
# ---------------------------------------------------------------------------
have node || die "Node.js が見つかりません。Node 22 LTS 以上を導入してから再実行してください（CI は Node 22 を使用）。"
log "Node: $(node --version)"

if ! have corepack; then
  warn "corepack が無いため npm 経由で導入を試みます"
  $SUDO npm install -g corepack || die "corepack を導入できませんでした"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
log "corepack で pnpm を有効化します（package.json の packageManager を使用）"
corepack enable pnpm 2>/dev/null || warn "corepack enable に失敗（PATH に書き込めない場合は 'corepack pnpm ...' を使ってください）"
corepack prepare --activate 2>/dev/null || true

PNPM="pnpm"
have pnpm || PNPM="corepack pnpm"
log "pnpm: $($PNPM --version)"

# ---------------------------------------------------------------------------
# 4) Node 依存インストール
# ---------------------------------------------------------------------------
if [ "${SKIP_PNPM_INSTALL:-0}" = "1" ]; then
  log "SKIP_PNPM_INSTALL=1 のため pnpm install をスキップします"
else
  log "pnpm install --frozen-lockfile を実行します"
  $PNPM install --frozen-lockfile
  # .npmrc disables lifecycle scripts, so install the pinned Electron binary
  # explicitly before any smoke or product journey command launches it.
  node scripts/ensure-electron-binary.mjs
fi

# ---------------------------------------------------------------------------
# 5) 検証コマンド案内
# ---------------------------------------------------------------------------
cat <<'EOF'

[bootstrap] 完了しました。次のコマンドで検証できます:

  # フロントエンド
  pnpm build              # tsc（型チェック） + vite build（本番バンドル）
  pnpm lint               # ESLint
  pnpm test:node --run    # Vitest（node 環境）

  # Electron / N-API
  pnpm napi:build
  pnpm electron:build
  pnpm test:electron --run

  # 共有 Rust crates（凍結した root Tauri shell は除外）
  cargo check --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding
  cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --all-targets --features grimodex-semantic/semantic-embedding -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding

  # 起動 / リリースビルド
  pnpm electron:dev
  pnpm electron:package

EOF
