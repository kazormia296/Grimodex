---
name: test-feature
description: >
  既存コードにテストを追加・実行する（test-after）。新規実装の test-first は
  superpowers:test-driven-development / implement-feature 側で行う。
  Use when: 「テストして」「テスト書いて」「カバレッジ足りない」と言われたとき。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
argument-hint: [feature-or-file-path]
---

「$1」のテストを作成・実行する。

## まず使い分け

- これから実装する機能のテスト → `superpowers:test-driven-development`（test-first）に従う。本スキルは使わない。
- 既存コードへのカバレッジ追加（test-after） → 以下に従う。

## 手順（既存コードのカバレッジ追加）

1. 対象コードを読み、正常系・異常系・エッジケース・主要分岐・エラーハンドリングを洗い出す
2. テストは Vitest でソースと同階層に `*.test.ts(x)`。Rust は `src-tauri` 内 `#[cfg(test)]` モジュール
3. レイアウト/幾何の assert は happy-dom 不可（flex/grid 実寸を計算しない）→ `*.browser.test.tsx` を書く
4. Tauri IPC 境界は型安全性も検証する
5. `pnpm test` /（Rust）`cd src-tauri && cargo test --workspace --no-default-features` を実行し結果を報告
6. 失敗時はまずテストコード側の誤りを疑ってから直す
