# Grimodex ターミナルパネル設計書

## 概要

ターミナルパネルはGrimodex内から直接シェルを実行できる統合ターミナル。VS Code風の操作感で、汎用シェルとしてコマンドライン作業が可能。Claude CodeをMCP連携付きで起動するワンクリックボタンも備え、Grimodexのデータを活用したAIアシスタント体験を提供する。

デフォルト位置: Bottom Dock（非表示）。デフォルトプリセットには含めない（オプトイン機能）。

設計思想: **シンプルな汎用ターミナルとして使え、必要なときにClaude Code + MCP連携で執筆データにアクセスできる。**

---

## パネル構造

ツールバー、タブバー、ターミナルビューポートの3層構成。1つのdockviewパネル内に複数のシェルセッションをタブで管理する（dockviewのタブを汚染しない）。

```
┌──────────────────────────────────────────────────────────────┐
│ A. ツールバー                                                 │
│ Terminal               [Claude Code] [Split] [+]  [🗑] [×]  │
├──────────────────────────────────────────────────────────────┤
│ B. タブバー                                                   │
│ [● zsh ×] [  zsh ×] [  claude ×]                            │
├──────────────────────────────────────────────────────────────┤
│ C. ターミナルビューポート                                       │
│                                                              │
│ ~/my-novel $ ls                                              │
│ grimodex.db  chapters/  notes/                               │
│ ~/my-novel $                                                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## A. ツールバー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Terminal」。左寄せ |
| Claude Code ボタン | MCP設定付きのClaude Codeセッションを新規タブで起動。ラベル: 「Claude Code」 |
| Split ボタン | アクティブセッションを左右分割表示（将来拡張） |
| + ボタン | 新しいシェルセッションを作成 |
| 🗑 (Kill) ボタン | アクティブセッションのプロセスを終了（タブは残り `[terminated]` 表示） |
| × (Close) ボタン | ターミナルパネル自体を非表示にする |

### インタラクション

| 操作 | 動作 |
|------|------|
| Claude Code クリック | MCP設定ファイルの確認・生成 → 新規PTYセッション作成 → `claude` コマンドを自動入力・実行 |
| + クリック | ユーザーのデフォルトシェルで新規セッションを起動。CWDはワークスペースパス |
| 🗑 クリック | アクティブセッションのプロセスを終了。タブに「[terminated]」と表示。パネル再生成なし |
| × クリック | パネルを非表示にする。セッションはバックグラウンドで維持される |

### Claude Code ボタンの有効化条件

以下の両方を満たす場合のみ有効。どちらか欠けている場合は disabled とし、ツールチップで不足を案内する。

1. `grimodex-mcp` バイナリが PATH 上または同梱バンドル内に存在する（Rust 側で起動時に検出）
2. `claude` CLI が PATH 上に存在する（`which claude` / Windows は `where claude` で検出し、結果を Zustand ストアにキャッシュ）

ツールチップ文言例:
- 「grimodex-mcp 未インストール」
- 「Claude Code CLI (`claude`) が見つかりません」

---

## B. タブバー

### 表示要素

パネル内部の独立したタブストリップ。dockviewのパネルタブとは別に管理する。

```
[● zsh ×] [  zsh ×] [  claude ×]
```

| 要素 | 詳細 |
|------|------|
| アクティブインジケーター (●) | アクティブタブに表示。テーマのアクセントカラー |
| セッション名 | シェル名（`zsh`, `bash`, `pwsh`, `powershell`, `cmd` 等）。Claude Codeセッションは `claude` と表示 |
| × ボタン | ホバー時に表示。セッションを終了しタブを閉じる |

### インタラクション

| 操作 | 動作 |
|------|------|
| タブクリック | セッションを切り替え。xterm.jsインスタンスをビューポートに再アタッチ |
| タブの× クリック | セッションをkillしてタブを削除。最後のタブを閉じると空状態（後述）になる |
| タブのドラッグ | タブの並び替え（`@dnd-kit/sortable` を流用） |
| 中クリック | ×と同じ（セッション終了 + タブ削除） |

### 自動タブ作成

パネルを初めて表示した際にセッションが1つもない場合、自動的にデフォルトシェルのセッションを1つ作成する。

### 空状態

全タブを閉じた直後は、ビューポート中央に「新規セッションを開始」CTA を表示する:

```
┌──────────────────────────────────────────┐
│                                          │
│   セッションがありません                    │
│                                          │
│   [ + 新規シェル ]  [ Claude Code ]       │
│                                          │
└──────────────────────────────────────────┘
```

`Enter` キー押下または + ボタンクリックでデフォルトシェルのセッションを起動する。

### 同時セッション数の上限

メモリ肥大を抑えるため、同時セッション数は **最大 20** に制限する。上限到達時に + / Claude Code ボタンを disabled にし、ツールチップで「最大セッション数に到達」と案内する。バックグラウンド（非アクティブ）タブも含め、全 xterm.js インスタンスをメモリ上に保持する。

---

## C. ターミナルビューポート

### 表示要素

xterm.jsによるターミナルエミュレーション領域。アクティブタブのセッション出力を表示する。

| 要素 | 詳細 |
|------|------|
| ターミナル出力 | ANSIエスケープシーケンス対応のフルカラー表示 |
| カーソル | ブロックカーソル（xterm.jsデフォルト） |
| スクロールバック | デフォルト5,000行。設定パネルで変更可能 |
| フォント | Grimodexのエディタフォント設定とは独立。デフォルト: `monospace`, 14px |

### インタラクション

| 操作 | 動作 |
|------|------|
| キー入力 | PTYの標準入力に転送。全てのキー入力がターミナルに送られる（後述のエスケープショートカットを除く） |
| IME 合成中 | xterm.js の `CompositionHelper` に委ねる。変換確定（`compositionend`）時点でまとめて PTY に書き込む。未確定文字列はインライン表示のみで PTY に渡さない |
| テキスト選択 | マウスドラッグで選択。選択中はxterm.jsのselectionスタイルで反転表示 |
| `Ctrl+Shift+C` | 選択テキストをクリップボードにコピー（`Ctrl+C` はSIGINTのためコピーに使えない）。末尾改行は付与しない（VS Code 互換） |
| `Ctrl+Shift+V` | クリップボードの内容をPTYに貼り付け。改行を含む場合は確認モーダルを表示（後述） |
| 右クリック | コンテキストメニュー（後述） |
| スクロール | マウスホイールでスクロールバック表示。新しい出力があれば自動スクロール復帰 |

### 貼り付け時の確認モーダル

クリップボードに改行（`\n` / `\r`）を含むテキストを貼り付けようとした場合、以下のモーダルを表示する（VS Code の「Paste with newlines」相当）。

```
┌─────────────────────────────────────────────┐
│ 貼り付け内容に改行が含まれます               │
│                                             │
│ コマンドが即座に実行される可能性があります。│
│                                             │
│ [ キャンセル ] [ 1 回許可 ] [ 常に許可 ]   │
└─────────────────────────────────────────────┘
```

「常に許可」を選ぶと設定（`terminal.confirmMultilinePaste = false`）に反映される。

### コンテキストメニュー

| メニュー項目 | 動作 |
|-------------|------|
| Copy | 選択テキストをクリップボードにコピー |
| Paste | クリップボードの内容をPTYに貼り付け |
| Select All | バッファ全体を選択 |
| Clear | ターミナルバッファをクリア（`clear` コマンド相当） |

---

## セッション管理

### セッションのライフサイクル

```
[パネル表示] → [セッション生成] → [アクティブ] → [プロセス終了]
                                        ↓                  ↓
                                 [パネル非表示]      [terminated表示]
                                        ↓                  ↓
                                 [バックグラウンド維持]  [タブ手動クローズ]
```

| 状態 | 説明 |
|------|------|
| アクティブ | PTYプロセスが稼働中。入出力が可能 |
| バックグラウンド | パネル非表示だがセッションは存続。xterm.jsインスタンスもメモリ上に保持。パネル再表示で即座に復帰 |
| terminated | プロセスが終了（正常終了 or kill）。タブに「[terminated]」ラベル表示。Enter押下で新規セッションに置き換え、×で削除 |

### セッション起動パラメータ

| パラメータ | デフォルト値 |
|-----------|------------|
| Shell | ユーザーのデフォルトシェル（後述の検出ロジック） |
| CWD | アクティブワークスペースのパス |
| Cols / Rows | xterm.jsの`addon-fit`が計測したサイズ |
| 環境変数 | 親プロセスの環境変数を継承。`TERM=xterm-256color`、`COLORTERM=truecolor` を追加 |

### デフォルトシェルの検出

| OS | 検出順序 |
|----|---------|
| macOS / Linux | `$SHELL` → `/etc/passwd` の user エントリ → `/bin/bash` |
| Windows | `$env:SHELL`（Git Bash 等） → `pwsh.exe`（PATH 解決） → `powershell.exe` → `cmd.exe` |

設定パネルの「ターミナル > シェルパス」で上書き可能。

### セッションの永続性

- **パネル非表示**: セッション維持。バッファもxterm.jsインスタンスに保持される
- **ワークスペース切替**: 稼働中のセッションが存在する場合、確認モーダルを表示（「実行中の N 件のセッションを終了しますか？」）。確定後に全セッションを終了し、新ワークスペースでは空のパネルから開始
- **アプリ終了**: 全セッションのプロセスを終了してクリーンアップ。再起動後のセッション復元は行わない（ターミナルセッションはエフェメラル）

> 実装メモ: アプリ終了時のクリーンアップは Tauri v2 の `RunEvent::ExitRequested` フックで全PTYセッションをkillし、`api.prevent_exit()` せずに通常終了させる。

---

## Tauri Command / Event 契約

PTY は Rust 側で [`portable-pty`](https://crates.io/crates/portable-pty) crate を用いて実装する。`tokio::task` + `mpsc` でバイト列を橋渡しする。

### Commands

```rust
#[tauri::command]
async fn pty_spawn(
    shell: Option<String>,   // None の場合はデフォルトシェル
    args: Vec<String>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    env: HashMap<String, String>,
) -> Result<SessionId, PtyError>;

#[tauri::command]
async fn pty_write(session_id: SessionId, data: Vec<u8>) -> Result<(), PtyError>;

#[tauri::command]
async fn pty_resize(session_id: SessionId, cols: u16, rows: u16) -> Result<(), PtyError>;

#[tauri::command]
async fn pty_kill(session_id: SessionId) -> Result<(), PtyError>;

#[tauri::command]
async fn pty_list() -> Result<Vec<SessionInfo>, PtyError>;

#[tauri::command]
async fn ensure_mcp_config(workspace: PathBuf) -> Result<PathBuf, McpConfigError>;

#[tauri::command]
async fn claude_cli_available() -> Result<bool, ()>;
```

`SessionId = Uuid`、`SessionInfo { id, shell, pid, started_at, state }`。

### Events

| イベント名 | ペイロード | 送信タイミング |
|-----------|-----------|--------------|
| `pty://output/{session_id}` | `{ data: Vec<u8> }` | PTY から stdout/stderr バイトを読み取った時 |
| `pty://exit/{session_id}` | `{ code: Option<i32>, signal: Option<String> }` | プロセス終了時 |

出力イベントは 8 KB or 16 ms のフロー制御（バッチ化）で frontend に送る。

### エラー型

```rust
#[derive(thiserror::Error, Debug, serde::Serialize)]
enum PtyError {
    #[error("session not found")]
    NotFound,
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("write failed: {0}")]
    WriteFailed(String),
    #[error("session limit reached")]
    LimitReached,
}
```

---

## セキュリティ / Capabilities

ターミナルパネルは任意のプロセス起動を伴うため、`tauri.conf.json` の `capabilities` を明示的に宣言する。

| 項目 | 設定 |
|------|------|
| capability ファイル | `src-tauri/capabilities/terminal.json` |
| 許可 Command | 上記 `pty_*` / `ensure_mcp_config` / `claude_cli_available` のみ |
| Window 条件 | `main` ウィンドウに限定 |
| シェル allowlist | 採用しない（ユーザー入力を PTY にパススルーするため無意味） |
| CWD 制約 | 初期 CWD はワークスペース内に強制。PTY 内での `cd` は OS 標準挙動に委ねる |
| サンドボックス | Tauri のプロセス分離は PTY の子プロセスには及ばないことを README に明記 |

---

## リサイズ挙動

```
[パネルリサイズ] → [ResizeObserver発火] → [addon-fit.fit()] → [cols/rows計算] → [pty_resize(sessionId, cols, rows)]
```

- パネルのリサイズ、dockviewの分割変更、ウィンドウリサイズの全てで自動的にPTYサイズを再計算する
- xterm.jsの `addon-fit` がビューポートサイズからcols/rowsを算出し、Rust側の `pty_resize` コマンドでPTYに反映
- デバウンス: ResizeObserver発火後50msのデバウンスで `fit()` を呼ぶ（高頻度リサイズ時のパフォーマンス対策）

---

## テーマ連携

xterm.jsのテーマカラーをGrimodexのカラーテーマから同期する。

| xterm.jsテーマキー | 対応するGrimodexテーマ変数 |
|------------------|------------------------|
| background | `--color-bg-secondary` |
| foreground | `--color-text-primary` |
| cursor | `--color-accent` |
| cursorAccent | `--color-bg-primary` |
| selectionBackground | `--color-accent` を `rgba(r, g, b, 0.3)` に変換して渡す |
| ANSI 16色 (black〜brightWhite) | Grimodexテーマのターミナルカラーパレット |

### テーマ定義の拡張

`src/lib/theme/` 配下のテーマ JSON スキーマに `terminal` ブロックを追加する:

```jsonc
{
  "name": "grim-dark",
  "terminal": {
    "black": "#1e1e1e",
    "red": "#f48771",
    // ... 16 色
    "brightWhite": "#ffffff"
  }
}
```

全プリセットテーマ（grim-dark / grim-light / 他）に 16 色パレットを定義する。未定義テーマは xterm.js のデフォルトにフォールバック。

テーマ切替時は xterm.js の `term.options.theme = {...}` でリアルタイム反映する。

---

## Claude Code連携

### 起動フロー

```
[Claude Codeボタン] → [MCP設定ファイル確認] → [新規PTYセッション] → [`claude` 自動入力]
                              ↓
                      .mcp.json を
                      ワークスペースルートに生成/更新
```

1. ツールバーの「Claude Code」ボタンをクリック
2. `ensure_mcp_config` Tauri コマンドで `<workspace>/.mcp.json` を確認。なければ生成、あればマージ
3. 新規PTYセッションを作成（CWD: ワークスペース、タブ名: `claude`）
4. PTY に `claude\n` を書き込む（Claude Code は同 CWD の `.mcp.json` を自動検知する）

### MCP設定ファイル

ワークスペースルートの `.mcp.json` に grimodex-mcp サーバーの接続情報を記述する。既存のキーは保持し、`mcpServers.grimodex` のみ上書きするマージ方針とする。

```json
{
  "mcpServers": {
    "grimodex": {
      "command": "grimodex-mcp",
      "args": ["--workspace", "<absolute-workspace-path>"],
      "env": {}
    }
  }
}
```

- `<absolute-workspace-path>` は `ensure_mcp_config` に渡されたワークスペースの絶対パス
- `grimodex-mcp` がバンドル内にある場合は `command` を実行ファイルの絶対パスに置き換える
- 生成時は UTF-8 / LF / 末尾改行付きで保存

詳細フォーマットは MCP サーバー設計書（`Grimodex_MCPサーバー設計書.md` §6）に準拠する。

---

## 設定項目

設定パネル（Settingsパネル設計書参照）のターミナルカテゴリに以下を追加。

| 設定項目 | 型 | デフォルト | 説明 |
|---------|-----|----------|------|
| シェルパス | string | "" (自動検出) | 空の場合はデフォルトシェル検出ロジックを使用 |
| シェル引数 | string[] | [] | `pty_spawn` の args に渡す |
| フォントファミリー | string | `monospace` | ターミナルのフォントファミリー |
| フォントサイズ | number | 14 | ターミナルのフォントサイズ (px) |
| スクロールバック行数 | number | 5000 | ターミナルのスクロールバックバッファ行数 |
| 改行ペーストの確認 | boolean | true | 改行を含む貼り付け時に確認モーダルを表示 |

> 実装メモ: 設定項目は Phase 4（ポリッシュ）で対応。Phase 1 ではデフォルト値をハードコードする。

---

## キーボードショートカット

### アプリレベル

| ショートカット | 動作 |
|-------------|------|
| `` Ctrl+Alt+` `` | ターミナルパネルのフォーカス/トグル（VS Code 準拠） |

> 注: `Ctrl+Alt+T` は Linter パネル（`src/features/layout/panelRegions.ts`）に割り当て済みのため使用しない。

### ターミナルフォーカス時

ターミナルにフォーカスがある間、キー入力は全てPTYに転送される。ただし以下のショートカットはアプリが優先してキャプチャする。

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+*` | 全てのアプリレベルショートカット（`Ctrl+Alt+S`, `Ctrl+Alt+C` 等）はターミナルにパススルーされず、アプリ側で処理される |
| `Ctrl+Shift+C` | 選択テキストをクリップボードにコピー |
| `Ctrl+Shift+V` | クリップボードからペースト |

### ターミナルパネル内操作

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Shift+T` | 新規タブ作成 |
| `Ctrl+Shift+W` | アクティブタブを閉じる |
| `Ctrl+Tab` | 次のタブに切り替え |
| `Ctrl+Shift+Tab` | 前のタブに切り替え |

> 実装メモ: xterm.js の `attachCustomKeyEventHandler` でアプリショートカットをインターセプトし、ターミナルへの転送を防ぐ。`Ctrl+Alt+*` は xterm.js がデフォルトでキャプチャしないため、通常は問題ない。

---

## 他パネルとの連携

### → Chat（Claude Code経由）

- ターミナルでClaude Codeを起動し、MCP経由でGrimodexのデータ（Codex、シーン、チャット履歴等）にアクセスできる
- Claude Codeのターミナル出力はそのままxterm.jsに表示される
- MCPサーバー設計書で定義されたツール（`search_codex`, `get_scene_content` 等）がClaude Code内で利用可能

### ← レイアウトシステム

- `` Ctrl+Alt+` `` でトグル表示/非表示
- デフォルト位置は Bottom Dock。Snippets / Attribution / Timeline / Map / Linter とタブ切り替えで共存
- レイアウトプリセットへの保存・復元に対応

---

## 既存設計書・実装との整合

### レイアウト設計書 / `panelRegions.ts`

`src/features/layout/panelRegions.ts` に以下を追加する:

```ts
// PanelId 型（layoutStore.ts）に "terminal" を追加

PANEL_REGION_MAP = {
  ...,
  terminal: "center-bottom",
};

KEYBOARD_SHORTCUT_MAP = {
  ...,
  terminal: "Ctrl+Alt+`",
};

TOGGLEABLE_PANELS = [
  ...,
  // Center-bottom の末尾
  "terminal",
];
```

`src/features/layout/layoutStore.ts` の `PanelId` 型、および dockview 登録ルックアップ（`PanelComponents` 相当）にも `terminal` を追加する。

### 設定パネル設計書

ターミナルカテゴリを設定パネルに追加し、上記「設定項目」表の 6 項目を提供する。

### MCPサーバー設計書

- Claude Code 起動時の MCP 設定ファイルは **`.mcp.json`**（ワークスペースルート）に統一
- `grimodex-mcp` の CLI 引数 `--workspace <PATH>` は必須（MCP サーバー設計書 §6 に準拠）
- `--mcp-config` フラグによる明示指定は行わず、Claude Code の自動検知に委ねる

---

## Phase ロードマップ

| Phase | 含まれる範囲 |
|-------|------------|
| Phase 1 (MVP) | `pty_*` Tauri Commands、PTY spawn / write / resize / kill、xterm.js ビューポート、タブバー、+ / 🗑 / × ボタン、デフォルトシェル検出、リサイズ対応、`` Ctrl+Alt+` `` トグル、`panelRegions.ts` への登録 |
| Phase 2 | テーマ連携（16色パレット、`rgba` 変換）、空状態 UI、`Ctrl+Shift+T/W`、`Ctrl+Tab` 系ショートカット、中クリック、タブドラッグ並び替え、改行ペースト確認モーダル |
| Phase 3 | Claude Code ボタン有効化（grimodex-mcp 検出・`ensure_mcp_config`・`.mcp.json` マージ生成・`claude` 自動入力）、Claude CLI 検出 |
| Phase 4 (ポリッシュ) | 設定パネル連携（シェルパス／フォント／スクロールバック／ペースト確認）、Split ビュー、セッション数上限 UI、IME 挙動の微調整 |

Phase 1 着手前に、`portable-pty` crate の依存追加と `capabilities/terminal.json` の作成を完了させること。
