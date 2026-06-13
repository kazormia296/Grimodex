# Grimodex — AI統合小説執筆エディタ

## プロジェクト概要

Tauri v2 + React 19 + TypeScript。TipTapベースのリッチテキストエディタに
AIチャットパネルとCodex/Snippet抽出機能を組み合わせた小説執筆ツール。
**コア体験: AIとのチャットから知識を抽出し、構造化して執筆に活かす。**

## コマンド

- 開発サーバー: pnpm tauri dev
- フロントのみ: pnpm dev
- ビルド: pnpm tauri build
- テスト: pnpm test
- テスト(単体): pnpm test --run [ファイルパス]
- Lint: pnpm lint:fix
- 型チェック: npx tsc --noEmit
- Rustチェック: cd src-tauri && cargo check
- Rust Lint: cd src-tauri && cargo clippy --all-targets
- Rust テスト: cd src-tauri && cargo test

## コード規約

- ES modules（import/export）、CommonJS禁止
- 2スペースインデント、TypeScript strictモード
- React: 関数コンポーネント + hooks のみ
- 状態管理: グローバル=Zustand、局所=Jotai
- DB操作: Drizzle ORM経由、生SQL禁止
- テスト: Vitest、ソースと同階層に \*.test.ts
- コンポーネント: 1ファイル1コンポーネント、200行超えたら分割
- Rust: unwrap()禁止、thiserror/anyhow使用（詳細は src-tauri/AGENTS.md）
- アニメ: duration/easing は `src/lib/animation.ts` の `DURATIONS`/`EASINGS`/`VARIANTS` 経由（べた書き禁止、詳細は /polish-motion）
- React/TS詳細は src/AGENTS.md を参照

## アーキテクチャ原則

- feature-based ディレクトリ構造（src/features/[name]/）
- Tauri Command経由でRust↔JSブリッジ
- SQLite WALモード、FTS5有効
- エディタ: チャプター/シーンごとに独立TipTapインスタンス
- AIチャット: シーンごとに独立した会話履歴を保持
- 帰属追跡: テキスト挿入時にsource metadata（human/ai/unknown）を記録

## スキル発火条件

| トリガーワード              | 発動スキル         | 動作             |
| --------------------------- | ------------------ | ---------------- |
| 「調べて」「調査」          | /explore-codebase  | コード探索       |
| 「実装して」「作って」      | /implement-feature | 実装フロー       |
| 「レビュー」                | /review-code       | コードレビュー   |
| 「テスト」                  | /test-feature      | テスト作成・実行 |
| 「デバッグ」「修正」        | /debug-issue       | デバッグフロー   |
| 「Tauriコマンド」「invoke」 | /add-tauri-command | IPC一括追加      |
| 「アニメ」「トランジション」「動き」「磨いて」 | /polish-motion | UIモーション規律 |

## Compact時の保持事項

変更済みファイル一覧、テスト状態、現フェーズ・タスク番号、
アーキテクチャ決定事項（ARCHITECTURE.md参照）を必ず保持すること。
