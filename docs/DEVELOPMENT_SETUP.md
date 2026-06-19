# 開発環境構築ガイド

> 最終更新: 2026-06-19

## 前提条件

| ソフトウェア | バージョン | 用途 |
|-------------|-----------|------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 最新 | devcontainer実行環境 |
| [VS Code](https://code.visualstudio.com/) | 最新 | エディタ |
| [Dev Containers 拡張](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) | 最新 | VS Code拡張 |

Tauriアプリのウィンドウ表示は WSL2 同梱の WSLg がそのまま処理します。VcXsrv などの X11 サーバーを別途用意する必要はありません。

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
# Tauriアプリを起動（初回はRustコンパイルに数分かかる）
pnpm tauri dev
```

アプリウィンドウが表示されれば環境構築完了です。

---

## よく使うコマンド

| コマンド | 説明 |
|---------|------|
| `pnpm tauri dev` | Tauri開発サーバー起動（フロント + Rust） |
| `pnpm dev` | フロントエンドのみ起動（Vite） |
| `pnpm tauri build` | リリースビルド |
| `pnpm test` | テスト実行（Vitest） |
| `pnpm test --run <path>` | 単体テスト実行 |
| `pnpm lint:fix` | ESLint自動修正 |
| `npx tsc --noEmit` | TypeScript型チェック |
| `cd src-tauri && cargo check` | Rustコンパイルチェック |
| `cd src-tauri && cargo clippy --all-targets` | Rust Lint |
| `cd src-tauri && cargo test` | Rustテスト |

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
├── Dockerfile           # Node.js 20 + Rust + Tauri v2ビルド依存
├── devcontainer.json    # VS Code設定・ボリューム・環境変数
└── init-firewall.sh     # ネットワーク制限（許可リスト方式）
```

### 永続化ボリューム

以下のデータはnamed volumeで永続化され、コンテナ再作成後も保持されます:

| ボリューム | マウント先 | 用途 |
|-----------|-----------|------|
| `grimodex-cargo-registry-*` | `/home/node/.cargo/registry` | Rustクレートキャッシュ |
| `grimodex-cargo-git-*` | `/home/node/.cargo/git` | Cargoのgitチェックアウト |
| `grimodex-target-*` | `/workspace/src-tauri/target` | Rustビルド成果物 |
| `grimodex-node-modules-*` | `/workspace/node_modules` | Node.js依存キャッシュ |
| `grimodex-bashhistory-*` | `/commandhistory` | シェル履歴 |
| `grimodex-claude-config-*` | `/home/node/.claude` | Claude Code設定 |
| `grimodex-codex-config-*` | `/home/node/.codex` | Codex CLI設定 |

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
