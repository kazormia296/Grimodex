# 開発環境構築ガイド

> 最終更新: 2026-04-02

## 前提条件

| ソフトウェア | バージョン | 用途 |
|-------------|-----------|------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 最新 | devcontainer実行環境 |
| [VS Code](https://code.visualstudio.com/) | 最新 | エディタ |
| [Dev Containers 拡張](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) | 最新 | VS Code拡張 |
| [VcXsrv](https://sourceforge.net/projects/vcxsrv/) | 最新 | X11サーバー（GUI表示用） |

### Docker Desktop の設定

- **Settings > General** で **"Use the WSL 2 based engine"** が有効であること

---

## セットアップ手順

### 1. VcXsrv を起動する

Tauriアプリのウィンドウ表示にはX11サーバーが必要です。

1. XLaunch を起動
2. **Multiple windows** を選択 → Next
3. **Start no client** を選択 → Next
4. **☑ Disable access control** にチェック → Next → Finish

タスクトレイにXアイコンが表示されれば起動完了です。

> **Windows ファイアウォール**: 初回起動時にファイアウォール許可ダイアログが出たら、
> **プライベートネットワーク**を許可してください。

### 2. リポジトリをクローンする

```bash
git clone <repository-url>
```

### 3. VS Code でコンテナを開く

1. VS Code でクローンしたフォルダを開く
2. コマンドパレット（`Ctrl+Shift+P`）→ **Dev Containers: Reopen in Container**
3. 初回ビルドには数分かかります（Rustツールチェーン + npm依存のインストール）

### 4. 起動確認

コンテナ内のターミナルで:

```bash
# X11接続テスト
timeout 3 bash -c 'echo > /dev/tcp/host.docker.internal/6000' \
  && echo "OK: X11 reachable" \
  || echo "NG: X11 unreachable"

# Tauriアプリを起動（初回はRustコンパイルに数分かかる）
npm run tauri dev
```

アプリウィンドウが表示されれば環境構築完了です。

---

## よく使うコマンド

| コマンド | 説明 |
|---------|------|
| `npm run tauri dev` | Tauri開発サーバー起動（フロント + Rust） |
| `npm run dev` | フロントエンドのみ起動（Vite） |
| `npm run tauri build` | リリースビルド |
| `npm test` | テスト実行（Vitest） |
| `npm test -- --run <path>` | 単体テスト実行 |
| `npm run lint:fix` | ESLint自動修正 |
| `npx tsc --noEmit` | TypeScript型チェック |
| `cd src-tauri && cargo check` | Rustコンパイルチェック |
| `cd src-tauri && cargo clippy --all-targets` | Rust Lint |
| `cd src-tauri && cargo test` | Rustテスト |

---

## トラブルシューティング

### X11接続テストで `NG: X11 unreachable` になる

**原因**: コンテナ内のファイアウォールまたはWindows側のファイアウォールがX11通信をブロックしている。

**対処**:
1. VcXsrvがタスクトレイで起動しているか確認
2. Windows Defender ファイアウォール → 受信の規則 で「VcXsrv」がプライベートネットワークで許可されているか確認
3. コンテナ内のファイアウォールを再適用:
   ```bash
   sudo /usr/local/bin/init-firewall.sh
   ```

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

### GTK初期化エラー: `Failed to initialize gtk backend`

**原因**: X11サーバーに接続できていない。上記「X11接続テストで NG になる」の対処を参照。

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
| `grimodex-bashhistory-*` | `/commandhistory` | シェル履歴 |
| `grimodex-claude-config-*` | `/home/node/.claude` | Claude Code設定 |

### ネットワーク制限

コンテナ内のファイアウォールは許可リスト方式で、以下の通信のみ許可しています:

- GitHub（API・Web・Git）
- npm registry
- crates.io / static.crates.io
- Anthropic API
- VS Code Marketplace
- X11（Docker ホストのポート6000）
