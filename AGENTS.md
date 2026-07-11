# Grimodex — AI統合小説執筆エディタ

## プロジェクト概要

Electron + React 19 + TypeScript。TipTapベースのリッチテキストエディタに
AIチャットパネルとCodex/Snippet抽出機能を組み合わせた小説執筆ツール。
**コア体験: AIとのチャットから知識を抽出し、構造化して執筆に活かす。**

現行デスクトップランタイムは Electron。renderer は typed preload IPC を介して
main process を呼び、Rust 実装は N-API モジュールと standalone MCP から共有する。
`src-tauri` 直下の Tauri シェルは v1 互換・移行確認用に凍結した legacy コードであり、
新機能の実装先にしない。`src-tauri/crates/` の共有 crates と MCP は引き続き現役。

## コマンド

- デスクトップ開発: pnpm electron:dev
- フロントのみ: pnpm dev
- ビルド: pnpm electron:build
- パッケージ: pnpm electron:package
- テスト: pnpm test
- テスト(単体): pnpm test --run [ファイルパス]
- Electronテスト: pnpm test:electron --run
- N-APIビルド: pnpm napi:build
- N-APIテスト（上記ビルド後）: pnpm --dir electron/native/grimodex-node test
- Lint: pnpm lint:fix
- 型チェック: npx tsc --noEmit
- Electron型チェック: pnpm exec tsc -p electron/tsconfig.json --noEmit
- N-APIチェック: cargo check --manifest-path electron/native/grimodex-node/Cargo.toml
- 共有Rustチェック: cargo check --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding
- 共有Rustテスト: cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding

## GitHub認証（Codex sandbox）

- 通常のユーザー端末では `gh auth status` が成功していても、Codex の sandbox 内では
  OS keyring を参照できず、`The token in default is invalid` と誤判定されることがある。
- sandbox 内の失敗だけを根拠に、ユーザーへ再ログインを依頼したり `gh auth logout` を
  実行したりしない。まず同じ `gh auth status` を `require_escalated` で再実行し、
  sandbox 外の keyring から認証状態を確認する。
- 認証が sandbox 外で成功した場合、keyring／ネットワークを必要とする `gh`・`git`
  操作も、必要な範囲に限定して escalation して続行する。トークン本体は出力しない。
- sandbox 外でも失敗した場合に限り、`gh auth login -h github.com` をユーザーへ案内する。

## コード規約

- ES modules（import/export）、CommonJS禁止
- 2スペースインデント、TypeScript strictモード
- React: 関数コンポーネント + hooks のみ
- 状態管理: グローバル=Zustand、局所=Jotai
- DB操作: Drizzle ORM経由、生SQL禁止
- テスト: Vitest、ソースと同階層に \*.test.ts
- コンポーネント: 1ファイル1コンポーネント、200行超えたら分割
- Rust: unwrap()禁止、thiserror/anyhow使用（共有 crates の詳細は src-tauri-CLAUDE.md）
- アニメ: duration/easing は `src/lib/animation.ts` の `DURATIONS`/`EASINGS`/`VARIANTS` 経由（べた書き禁止、詳細は /polish-motion）
- React/TS詳細は src-CLAUDE.md を参照

## アーキテクチャ原則

- feature-based ディレクトリ構造（src/features/[name]/）
- renderer は Node/Electron/N-API を直接 import せず、`window.grimodex` の typed preload API を使う
- IPC の正本は `electron/shared/ipcContract.ts`。main 側で引数を再検証し、N-API backend を呼ぶ
- Rust のドメイン実装は `src-tauri/crates/` に置き、Electron 用 binding は `electron/native/grimodex-node/` に置く
- SQLite WALモード、FTS5有効
- エディタ: チャプター/シーンごとに独立TipTapインスタンス
- AIチャット: シーンごとに独立した会話履歴を保持
- 帰属追跡: テキスト挿入時にsource metadata（human/ai/unknown）を記録

## スキル発火条件

| トリガーワード                                 | 発動スキル            | 動作             |
| ---------------------------------------------- | --------------------- | ---------------- |
| 「調べて」「調査」                             | /explore-codebase     | コード探索       |
| 「実装して」「作って」                         | /implement-feature    | 実装フロー       |
| 「レビュー」                                   | /review-code          | コードレビュー   |
| 「テスト」                                     | /test-feature         | テスト作成・実行 |
| 「デバッグ」「修正」                           | /debug-issue          | デバッグフロー   |
| 「Electronコマンド」「IPC」「invoke」          | /add-electron-command | IPC一括追加      |
| 「アニメ」「トランジション」「動き」「磨いて」 | /polish-motion        | UIモーション規律 |
