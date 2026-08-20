# 開発環境構築ガイド

> 最終更新: 2026-08-20

> 推奨は下記の **devcontainer** です。Docker を使わずローカルホストへ直接構築したい場合は
> [ネイティブ（非Docker）セットアップ](#ネイティブ非dockerセットアップ) を参照してください。

## 前提条件

| ソフトウェア                                                                                                  | バージョン | 用途                 |
| ------------------------------------------------------------------------------------------------------------- | ---------- | -------------------- |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/)                                             | 最新       | devcontainer実行環境 |
| [VS Code](https://code.visualstudio.com/)                                                                     | 最新       | エディタ             |
| [Dev Containers 拡張](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) | 最新       | VS Code拡張          |

Electronアプリのウィンドウ表示は WSL2 同梱の WSLg がそのまま処理します。VcXsrv などの X11 サーバーを別途用意する必要はありません。

### Docker Desktop の設定

- **Settings > General** で **"Use the WSL 2 based engine"** が有効であること

---

## セットアップ手順

### 1. リポジトリをクローンする

```bash
git clone <repository-url>
```

### 2. VS Code でコンテナを開く

1. VS Code でクローンしたフォルダを開く
2. コマンドパレット（`Ctrl+Shift+P`）→ **Dev Containers: Reopen in Container**
3. 初回ビルドには数分かかります（Rustツールチェーン + pnpm依存のインストール）

### 3. 起動確認

コンテナ内のターミナルで:

```bash
# 初回のみ（または native Rust 変更後）N-API モジュールをビルド
pnpm napi:build

# Electronアプリを起動
pnpm electron:dev
```

アプリウィンドウが表示されれば環境構築完了です。

---

## ネイティブ（非Docker）セットアップ

Docker / devcontainer を使わず、ローカルホスト上に直接ビルド環境を構築する場合の手順です。
**対応 OS: Debian / Ubuntu（apt）、Arch / Manjaro（pacman）、macOS（Homebrew + Xcode CLT）、Windows 10 / 11（Visual Studio C++ Build Tools + Windows SDK）。**
Linux / macOS ではブートストラップスクリプトを利用できます。Windows ネイティブでは、
下記の専用手順に従い、x64 用の Visual Studio 開発者シェルからビルドしてください。

### 前提

| ソフトウェア | バージョン  | 備考                                                                                        |
| ------------ | ----------- | ------------------------------------------------------------------------------------------- |
| Node.js      | 20 LTS 以上 | CI は Node 20 を使用。pnpm は `packageManager` フィールドに従い corepack が固定             |
| Rust         | stable      | N-API モジュール・共有 crates・MCP のビルドに使用。未導入なら下記スクリプトが rustup で導入 |

### 一撃セットアップ

Linux / macOS では、リポジトリ直下で次を実行すると、OS を判定して Electron / N-API のビルド依存・Rust ツールチェーン・pnpm 依存を導入します（冪等・再実行安全）。Electron は Chromium を同梱するため外部 WebView の開発パッケージは不要です。

```bash
bash scripts/bootstrap-build-env.sh
```

システム依存だけ入れて `pnpm install` を省く場合:

```bash
SKIP_PNPM_INSTALL=1 bash scripts/bootstrap-build-env.sh
```

このスクリプトは Windows ネイティブを対象にしていません。Windows では次の手順を使用してください。

### 手動で入れる場合（Windows ネイティブ）

Windows 10 / 11 上で WSL を介さずに N-API モジュールをビルドする場合は、先に以下を
インストールします。

1. Node.js 20 LTS 以上
2. rustup（既定の `stable-x86_64-pc-windows-msvc` toolchain）
3. Visual Studio Build Tools の **Desktop development with C++** workload
   - MSVC x64 / x86 build tools
   - Windows 10 SDK または Windows 11 SDK

ビルドには、Visual Studio Installer と一緒に導入される **Developer PowerShell for Visual Studio**
（x64 用に初期化したもの）または **x64 Native Tools Command Prompt for Visual Studio** を推奨します。
通常の PowerShell やコマンドプロンプトでは、MSVC や Windows SDK の環境変数が不足することがあります。

特に Git Bash の `/usr/bin/link.exe` は、MSVC linker と同名ですが別のプログラムです。
Git Bash のパスが優先されると Rust / N-API build が誤った `link.exe` を実行するため、
Visual Studio の x64 開発者シェルを使用してください。

Developer PowerShell では、依存をインストールする前に次を確認します。

```powershell
where.exe link.exe
($env:INCLUDE -split ';') | Where-Object { $_ -match '\\VC\\Tools\\MSVC\\.+\\include\\?$' }
($env:LIB -split ';') | Where-Object { $_ -match '\\(ucrt|um)\\x64\\?$' }
```

- `where.exe link.exe` の先頭が
  `...\VC\Tools\MSVC\...\bin\Hostx64\x64\link.exe` であること
- `C:\Program Files\Git\usr\bin\link.exe`（Git Bash の `/usr/bin/link.exe`）が先頭でないこと
- `INCLUDE` の確認結果に MSVC toolset の `VC\Tools\MSVC\...\include` が含まれること
- `LIB` の確認結果に Windows SDK の `ucrt\x64` と `um\x64` が両方含まれること

x64 Native Tools Command Prompt では `where.exe link.exe`、`echo %INCLUDE%`、`echo %LIB%` で同じ内容を確認できます。
不足している場合は Visual Studio Installer で C++ workload と Windows SDK を追加し、
Build Tools を修復してから新しい x64 開発者シェルを開き直してください。

環境が正しいことを確認したら、リポジトリ直下で依存と N-API モジュールをビルドします。

```powershell
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm napi:build
```

### 手動で入れる場合（Ubuntu / Debian）

`scripts/bootstrap-build-env.sh` が導入する内容と同一です。devcontainer と CI は用途に応じてこの一覧の subset を使います:

```bash
sudo apt-get update
ALSA_PACKAGE=libasound2
apt-cache show libasound2t64 >/dev/null 2>&1 && ALSA_PACKAGE=libasound2t64
sudo apt-get install -y --no-install-recommends \
  build-essential curl wget file pkg-config libssl-dev libdbus-1-dev libsecret-1-dev \
  libgtk-3-0 libnss3 libxss1 libxtst6 libgbm1 \
  libnotify4 libatspi2.0-0 libsecret-1-0 "$ALSA_PACKAGE" xdg-utils \
  patchelf fonts-noto-cjk

# Rust（未導入時）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env" && rustup component add clippy

# pnpm（corepack で固定）+ 依存
corepack enable pnpm && pnpm install --frozen-lockfile
```

### 手動で入れる場合（Arch / Manjaro）

Arch はパッケージを `-dev` に分割しないため、N-API の native build に必要なヘッダは `base-devel` などの本体パッケージに含まれます:

```bash
sudo pacman -Sy --needed \
  base-devel curl wget file openssl \
  gtk3 nss alsa-lib libxss libxtst mesa libnotify \
  at-spi2-core libsecret dbus xdg-utils patchelf noto-fonts-cjk

# Rust / pnpm は Debian の項と同じ
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env" && rustup component add clippy
corepack enable pnpm && pnpm install --frozen-lockfile
```

macOS は Electron が Chromium を同梱するため追加の WebView ライブラリは不要で、native build 用の Xcode Command Line Tools（`xcode-select --install`）があれば足ります。

### 検証

```bash
pnpm electron:build   # renderer + main/preload の型チェックと本番バンドル
pnpm lint             # ESLint
pnpm test:node --run  # renderer の Vitest（node）
pnpm test:electron --run
pnpm napi:build       # feature 無しの開発用 .node を用意
pnpm --dir electron/native/grimodex-node test
cargo check --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding
cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding
```

---

## ローカルCI運用

private source repository では、通常のPR、branch push、scheduleからGitHub Actionsの
CI runnerを起動しません。`.github/workflows/ci.yml` は、明示的な手動実行とtag releaseからの
再利用呼び出しだけを受け付けます。

通常の変更確認には、差分に対応するLight suiteだけを実行します。既定では
`origin/master...HEAD`に加えてstaged、unstaged、untrackedの変更も対象です。

```bash
pnpm ci:local:quick

# 比較元を明示する場合
pnpm ci:local:quick -- --base <base-ref> --head HEAD
```

mergeまたはrelease候補を作る前は、ローカルで再現可能なFull CIを実行します。
依存audit、Rust/N-API、Browser/WebGL/Storybook、Electron performance、全product journeyを
含むため、初回は長時間かかります。`uv`、Rust toolchain、`cargo-audit`、Playwrightと
Electronのホスト依存を先に導入してください。

```bash
pnpm ci:local:full

# 失敗を直した後、指定stageから再開する場合
pnpm ci:local:full -- --from security

# profile、stage、release-only項目を確認する場合
pnpm ci:local:list
```

実行結果は`.artifacts/local-ci/<profile>.json`へ保存されます。Linux/macOSでは再現できない
Windows NSISの最終compileだけはrelease-onlyとして明示され、手動Full CIまたはtag releaseで
検証します。現在のprivate repositoryプランでcode scanningを利用できないCodeQLと、手動起動時に
必ずskipされるDependency Review workflowは公開しません。代わりにlocal fullの`security` stageと
既存のlicense contractを使用します。

---

## Electron デスクトップアプリ（サポート対象）

現行のデスクトップランタイムは Electron です。呼び出し境界は次の順です。

1. React renderer は `src/lib/` の facade を呼ぶ
2. sandbox + context isolation を有効にした preload が、型付き `window.grimodex` API だけを公開する
3. Electron main process が IPC allowlist と入力を検証する
4. `electron/native/grimodex-node/` の N-API module が `src-tauri/crates/` の共有 Rust 実装を呼ぶ

`src-tauri` 直下の Tauri app shell は Tauri v1 互換・移行検証用の frozen legacy です。
ファイルは残っていますが、通常の開発起動・リリース・新機能追加には使いません。
`src-tauri/crates/` の共有 crates と standalone MCP は引き続きサポート対象です。

### 前提

- 上記のネイティブセットアップ（Rust + pnpm）が済んでいること。
  Electron は Chromium 同梱のため外部 WebView の開発パッケージは不要です。
- 初回のみ napi ネイティブモジュールのビルドが必要です:

```bash
pnpm napi:build   # electron/native/grimodex-node → grimodex-node.node
```

### 開発起動

```bash
pnpm electron:dev
```

- renderer は Vite（**ポート 1430**）、
  main/preload は esbuild watch で `dist-electron/` へ出力、変更時は Electron が自動再起動します。
- `window.grimodex` は preload だけが公開します。renderer から `electron`、Node API、
  `.node` ファイルを直接 import しないでください。

### 本番経路の確認・スモーク

```bash
pnpm electron:build   # 型チェック + main/preload バンドル + vite build
pnpm electron:start   # ビルド成果物を app:// プロトコルでロードして起動
pnpm electron:smoke   # Playwright _electron スモーク（workspace 作成→執筆→再起動残存）
pnpm test:electron    # electron/ 配下 main プロセスの単体テスト（node 環境）
pnpm --dir electron/native/grimodex-node test  # napi 公開境界 + 実HTTP/SSE E2E
pnpm electron:native:release  # release features 付き N-API + MCP sidecar
pnpm electron:package:dir     # unpacked package を作る
pnpm electron:package         # 現在の OS 向け配布パッケージを作る
```

### 注意

- API キーは Electron main process の `safeStorage` で保管します。renderer や IPC payload に
  平文キーを保持しません。Linux で safeStorage が `basic_text` / `unknown` backend に
  なる環境は安全でないため拒否します。
- release build は初回起動時に既知の Tauri v1 keyring から safeStorage へ best-effort で
  コピーします。legacy 側の資格情報は rollback のため削除しません。
- frozen Tauri shell と同一 workspace を同時に開かないでください。legacy shell は比較・
  移行検証以外では起動しないでください。
- IPC を追加するときは `electron/shared/ipcContract.ts`、main dispatch、preload 公開型、
  N-API binding、境界テストを一組で更新してください。

---

## よく使うコマンド

| コマンド                                                                                                                          | 説明                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm electron:dev`                                                                                                               | Electron開発起動（renderer + main/preload）             |
| `pnpm dev`                                                                                                                        | フロントエンドのみ起動（Vite）                          |
| `pnpm ci:local:quick`                                                                                                             | 差分に対応するローカルLight suite                       |
| `pnpm ci:local:full`                                                                                                              | release-only項目を除くローカルFull CI                   |
| `pnpm ci:local:list`                                                                                                              | ローカルCI profileとstageの一覧                         |
| `pnpm napi:build`                                                                                                                 | Electron用Rust N-APIモジュールをビルド                  |
| `pnpm electron:build`                                                                                                             | Electron本番JavaScriptをビルド                          |
| `pnpm electron:package`                                                                                                           | native release成果物と配布パッケージを作成              |
| `pnpm electron:smoke`                                                                                                             | packaged相当の `app://` 経路をスモークテスト            |
| `pnpm test:electron --run`                                                                                                        | Electron main/preloadテスト                             |
| `pnpm test`                                                                                                                       | テスト実行（Vitest）                                    |
| `pnpm test --run <path>`                                                                                                          | 単体テスト実行                                          |
| `pnpm lint:fix`                                                                                                                   | ESLint自動修正                                          |
| `npx tsc --noEmit`                                                                                                                | TypeScript型チェック                                    |
| `cargo check --manifest-path electron/native/grimodex-node/Cargo.toml`                                                            | N-API Rustコンパイルチェック                            |
| `cargo check --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding` | 共有Rust crates / MCPチェック（frozen Tauri shell除外） |
| `cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding`  | Electron active featuresを含む共有Rustテスト            |

---

## トラブルシューティング

### `cargo` で Permission denied が出る

**原因**: Dockerボリュームがroot所有で作成されている。

**対処**:

```bash
sudo chown -R node:node /home/node/.cargo /workspace/src-tauri/target
```

それでも解決しない場合はボリュームを削除してコンテナをリビルド:

```bash
# VS Code外のターミナルで実行
docker volume ls | grep grimodex
# 該当するボリュームを削除
docker volume rm <volume-name>
```

その後、VS Code で **Dev Containers: Rebuild Container** を実行。

### ファイアウォールスクリプトがハングする

**原因**: 2回目以降の実行時に前回のDROPポリシーが残存し、外部通信がブロックされている。

**対処**: `Ctrl+C` で中断後、スクリプトが最新版か確認:

```bash
# ワークスペースの最新版をコピーして再実行
sudo cp /workspace/.devcontainer/init-firewall.sh /usr/local/bin/init-firewall.sh
sudo chmod +x /usr/local/bin/init-firewall.sh
sudo /usr/local/bin/init-firewall.sh
```

### ロケール警告: `cannot change locale`

コンテナをリビルドしてください。Dockerfileに `ja_JP.UTF-8` ロケールが含まれています。

---

## devcontainer の構成

```
.devcontainer/
├── Dockerfile           # Node.js 20 + Rust + Electron/N-APIビルド依存
├── devcontainer.json    # VS Code設定・ボリューム・環境変数
└── init-firewall.sh     # ネットワーク制限（許可リスト方式）
```

### 永続化ボリューム

以下のデータはnamed volumeで永続化され、コンテナ再作成後も保持されます:

| ボリューム                  | マウント先                    | 用途                     |
| --------------------------- | ----------------------------- | ------------------------ |
| `grimodex-cargo-registry-*` | `/home/node/.cargo/registry`  | Rustクレートキャッシュ   |
| `grimodex-cargo-git-*`      | `/home/node/.cargo/git`       | Cargoのgitチェックアウト |
| `grimodex-target-*`         | `/workspace/src-tauri/target` | Rustビルド成果物         |
| `grimodex-node-modules-*`   | `/workspace/node_modules`     | Node.js依存キャッシュ    |
| `grimodex-bashhistory-*`    | `/commandhistory`             | シェル履歴               |
| `grimodex-claude-config-*`  | `/home/node/.claude`          | Claude Code設定          |
| `grimodex-codex-config-*`   | `/home/node/.codex`           | Codex CLI設定            |

### ネットワーク制限

コンテナ内のファイアウォールは許可リスト方式で、以下の通信のみ許可しています:

一時的に全 outbound を許可する場合:

```bash
sudo /usr/local/bin/init-firewall.sh open
```

再び許可リストを有効化する場合:

```bash
sudo /usr/local/bin/init-firewall.sh
```

許可ドメイン:

以下のドメインがネットワーク許可リストに含まれます。GitHub・CloudFront IP範囲は動的に取得されます:

**(1) Build & Package Managers**

- GitHub（api.github.com、web・git・api IP範囲を動的取得）
- npm registry（registry.npmjs.org）
- crates.io（crates.io、static.crates.io、index.crates.io）
- Rust toolchain（static.rust-lang.org、sh.rustup.rs）

**(2) Build Dependencies**

- lindera.dev（UniDic 辞書）
- cdn.pyke.io（ONNX Runtime prebuilt）
- parcel.pyke.io
- CloudFront（crates.io CDN、IP範囲を動的取得）

**(3) AI APIs**

- Anthropic API（api.anthropic.com）
- OpenAI（auth.openai.com、api.openai.com、chatgpt.com、platform.openai.com）
- OpenRouter（openrouter.ai）

**(4) Infrastructure & Monitoring**

- Hugging Face（huggingface.co、hf.co、cdn-lfs.huggingface.co）
- VS Code Marketplace（marketplace.visualstudio.com、vscode.blob.core.windows.net、update.code.visualstudio.com）
- Sentry（sentry.io）
- Statsig（statsig.anthropic.com、statsig.com）

**(5) Licensing**

- Polar（polar.sh、docs.polar.sh、api.polar.sh）

**(6) Platform Support**

- Apple（support.apple.com、developer.apple.com）
