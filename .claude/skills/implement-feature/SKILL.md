---
name: implement-feature
description: >
  機能を実装する。手順は superpowers の方法論スキルに委譲し、ここでは
  プロジェクト固有の制約と検証だけを足す。
  Use when: 新機能の追加、既存機能の拡張、「実装して」「作って」「追加して」
  と言われたとき。UIコンポーネント、DB操作、Tauri Command追加を含む。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [feature-description]
---

「$1」を実装する。

## 方法論は superpowers に委譲する（薄い独自手順で上書きしないこと）

このスキルは入口にすぎない。各フェーズは対応する superpowers スキルを起動し、
そのまま劣化させずに従う:

1. `superpowers:brainstorming` — 着手前に意図・要件・設計を確定する
2. `superpowers:writing-plans` — 多段タスクなら計画を書く
3. `superpowers:test-driven-development` — 実装前にテストを書く（test-first / red→green）
4. `superpowers:verification-before-completion` — 「完了」と言う前に検証する
5. **実装後は敵対的レビューで壊しにいく** — `/review-code`、または
   `superpowers:requesting-code-review` でレビュアー subagent を派遣する場合は
   vanilla の `code-reviewer.md` ではなく `review-code/adversarial-reviewer.md`
   を使う。Critical→Important の「壊し方」を潰してから完了とする。

## このプロジェクト固有で必ず守ること

- 探索時、Tauri IPC が絡むなら Rust 側とフロント側の両方を確認する。
  IPC コマンド追加なら `/add-tauri-command` の 4 点同時更新に従う。
- 状態管理: グローバル=Zustand / 局所=Jotai。DB は Drizzle 経由（生 SQL 禁止）。
- 検証コマンド（verification-before-completion の証拠として出力を確認する）:
  - `pnpm test`
  - `npx tsc --noEmit`
  - `pnpm lint:fix`
  - Rust 変更時: `cd src-tauri && cargo check --workspace && cargo test --workspace --no-default-features`
  - レイアウト変更時（CenterStripe/RegionStripe/Splitter/LayoutShell 周辺）: `pnpm test:browser`
- コミットは変更ファイルを個別 `git add`（`git add -A` 禁止）。master へ直接 commit せず branch を切り、push は branch + PR（master 直 push は hook でブロック済み）。
