# Grimodex — AI統合小説執筆エディタ

## プロジェクト概要

Electron + React 19 + TypeScript。TipTapベースのリッチテキストエディタに
AIチャットパネルとCodex/Snippet抽出機能を組み合わせた小説執筆ツール。
**コア体験: AIとのチャットから知識を抽出し、構造化して執筆に活かす。**

現行デスクトップランタイムは Electron。renderer → typed preload IPC → main process →
N-API の順で共有 Rust 実装へ到達する。`src-tauri` 直下の Tauri シェルは v1 互換・
移行確認用に凍結した legacy コードで、新機能の実装先ではない。
`src-tauri/crates/` の共有 crates と standalone MCP は引き続き現役。

## コマンド

- デスクトップ開発: pnpm electron:dev
- フロントのみ: pnpm dev
- ビルド: pnpm electron:build
- パッケージ: pnpm electron:package
- テスト: pnpm test
- テスト(単体): pnpm test --run [ファイルパス]
- Electronテスト: pnpm test:electron --run
- ブラウザテスト: pnpm test:browser（実 Chromium、`*.browser.test.tsx`。flex/grid 実寸など happy-dom で測れない幾何 invariant 用）
- N-APIビルド: pnpm napi:build
- N-APIテスト（上記ビルド後）: pnpm --dir electron/native/grimodex-node test
- Lint: pnpm lint:fix
- 型チェック: npx tsc --noEmit
- Electron型チェック: pnpm exec tsc -p electron/tsconfig.json --noEmit
- N-APIチェック: cargo check --manifest-path electron/native/grimodex-node/Cargo.toml
- 共有Rustチェック: cargo check --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding
- 共有Rust Lint: cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --all-targets --features grimodex-semantic/semantic-embedding
- 共有Rustテスト: cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding（`--workspace --exclude grimodex` 必須。Electron が使う semantic feature を有効にし、凍結した root Tauri package は現行経路の gate に含めない）

## テスト方針

- 通常は happy-dom 単体テスト (`*.test.ts(x)`) で十分。
- **レイアウト / 幾何が絡むバグは browser test 必須** — happy-dom は flex/grid の実寸を計算しないため、`getBoundingClientRect()` で位置や寸法を assert したい場合は `*.browser.test.tsx` を書く。Splitter ヒット領域・region overflow・stripe band ↔ content slot 整列など過去 3 回再発したバグはこのスイートで gate されている（`src/features/layout/layoutInvariants.browser.test.tsx`）。
- レイアウト変更 (CenterStripe / RegionStripe / Splitter / LayoutShell 周辺) を入れたら `pnpm test:browser` も走らせる。
- Splitter は dev 時に `console.warn` でヒット領域 0 化を自前検出する（SplitterHandle 内 assertion、test 環境では無効）。

## コード規約

- ES modules（import/export）、CommonJS禁止
- 2スペースインデント、TypeScript strictモード
- React: 関数コンポーネント + hooks のみ
- 状態管理: グローバル=Zustand、局所=Jotai
- DB操作: Drizzle ORM経由、生SQL禁止
- テスト: Vitest、ソースと同階層に \*.test.ts
- コンポーネント: 1ファイル1コンポーネント、200行超えたら分割
- Rust: unwrap()禁止、thiserror/anyhow使用（詳細は src-tauri-CLAUDE.md）
- アニメ: duration/easing は `src/lib/animation.ts` の `DURATIONS`/`EASINGS`/`VARIANTS` 経由（べた書き禁止、詳細は /polish-motion）
- React/TS詳細は src-CLAUDE.md を参照
- やり取り・設計ドキュメント・実装計画はすべて日本語で書く

## アーキテクチャ原則

- feature-based ディレクトリ構造（src/features/[name]/）
- renderer は Node/Electron/N-API を直接 import せず、`window.grimodex` の typed preload API を使う
- IPC の正本は `electron/shared/ipcContract.ts`。main 側で入力を再検証し、N-API backend を呼ぶ
- Rust ドメイン実装は `src-tauri/crates/`、Electron binding は `electron/native/grimodex-node/` に置く
- SQLite WALモード、FTS5有効
- エディタ: チャプター/シーンごとに独立TipTapインスタンス
- AIチャット: シーンごとに独立した会話履歴を保持
- 帰属追跡: テキスト挿入時にsource metadata（human/ai/unknown）を記録

## Git 運用

- **branch-first 運用**（2026-06-16 に master 直運用を廃止）。master へ直接 commit しない。
  作業は必ずブランチ（`fix/` `feat/` `chore/` など）を切ってから commit する。
  harness 既定の「If on default branch, branch first」をそのまま適用する。
- push は branch + PR。`master` への直 push は `.claude/hooks/block-push-to-main.sh` がハードブロック済み。
- `git add` は `-A` を避け、変更ファイルを明示パスで個別に add する。
- 合成 git コマンド（`git reset --hard` を含む）は権限ダイアログで拒否されやすい。単純コマンドに分割する。
- リリース（/bump-version）・ライセンス更新（/update-licenses）も branch + PR で通す。

## スキル発火条件

| トリガーワード                                 | 発動スキル            | 動作                 |
| ---------------------------------------------- | --------------------- | -------------------- |
| 「調べて」「調査」                             | /explore-codebase     | コード探索           |
| 「実装して」「作って」                         | /implement-feature    | 実装フロー           |
| 「レビュー」                                   | /review-code          | コードレビュー       |
| 「テスト」                                     | /test-feature         | テスト作成・実行     |
| 「デバッグ」「修正」                           | /debug-issue          | デバッグフロー       |
| 「Electronコマンド」「IPC」「invoke」          | /add-electron-command | IPC一括追加          |
| 「アニメ」「トランジション」「動き」「磨いて」 | /polish-motion        | UIモーション規律     |
| 「バージョン上げて」「リリースタグ」           | /bump-version         | 版上げ+commit+tag    |
| 「ライセンス更新」「サードパーティライセンス」 | /update-licenses      | ライセンス一覧再生成 |
| 「PR出して」「プッシュしてマージ」「ship」     | /ship-branch          | push+PR+マージ       |

## Superpowers ワークフローの上書き指示（最優先）

これらは Superpowers のスキル内容より優先する。スキルが「必須」「止まれ」と
言っていても、以下が衝突する場合は以下に従うこと。

### 確認・対話フェーズのバイパス

- brainstorming: 一問一答のインタビューはしない。要件が概ね明確なら
  ブレストを飛ばして直接 plan に進む。どうしても確認が必要な場合は、
  質問を1つずつ出さず、全部まとめて1メッセージで聞く。
- 設計（design）を分割して逐一サインオフを求めない。要点だけ提示して先へ進む。
- writing-plans → executing-plans: 計画ができたら承認を待たずにそのまま実装へ移る。
- 実行は連続して進める。承認待ちでは止まらず、本物のブロッカー
  （取り返しのつかない操作・破壊的変更・認証情報の扱い・本番デプロイ）でのみ停止する。
- requesting/receiving-code-review: レビュー自体は実行してよいが、
  完了後に私の確認待ちで停止しない。指摘があれば自分で修正して続行する。

### 並列をデフォルトに

- 独立したタスクが2つ以上あるときは、デフォルトで
  dispatching-parallel-agents / subagent-driven-development を使い、
  サブエージェントを並列起動して進める。私が「並列で」と言わなくても適用する。
- 並列実行時は using-git-worktrees で worktree を分離してから走らせる。
