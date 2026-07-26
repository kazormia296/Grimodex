---
name: implement-feature
description: >
  機能を実装する。計画→TDD→実装→検証の順で進める。
  Use when: 新機能の追加、既存機能の拡張、「実装して」「作って」「追加して」
  と言われたとき。UIコンポーネント、DB操作、Electron IPC追加を含む。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [feature-description]
---

以下の手順で「$1」を実装してください。

## Phase 1: 探索

1. 関連コードを探索し、影響範囲を把握する
2. 既存のパターン（類似機能の実装方法）を確認する

## Phase 2: TDD（コンテキスト汚染を防ぐ）

3. **テストファイルを先に作成する**
   - 正常系・異常系・エッジケースをカバー
   - 実装の詳細を仮定せず、公開APIの振る舞いをテストする
4. テストが失敗することを確認してコミットする

## Phase 3: 実装

5. テストを通過するよう実装する
6. **実装中にテストファイルを変更しない**

## Phase 4: 検証

7. `pnpm test` で全テスト通過を確認
8. `npx tsc --noEmit` で型チェック通過を確認
9. `pnpm lint:fix` でLint修正
10. Electron変更は `pnpm test:electron --run`、Rust変更は対象crateの `cargo check && cargo test`
11. 変更をコミットする

各ステップの結果を簡潔に報告すること。
