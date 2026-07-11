---
name: test-feature
description: >
  指定された機能のテストを作成し実行する。
  Use when: 「テストして」「テスト書いて」「カバレッジ足りない」と言われたとき。
  既存コードにテストを追加する場合や、テスト結果の確認に使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
argument-hint: [feature-or-file-path]
---

「$1」のテストを作成・実行してください。

1. 対象コードを読み、テストすべきケースを洗い出す
2. 正常系・異常系・エッジケースをカバーするテストを作成
3. テストファイルはソースと同階層に \*.test.ts として配置
4. Rustコードの場合は共有crateまたはN-API adapter内に `#[cfg(test)]` モジュール
5. `pnpm test` / `pnpm test:electron --run` / 対象crateの `cargo test` を実行し、結果を報告
6. 失敗がある場合、テストコードに問題がないか確認してから修正

カバレッジの観点:

- 主要な分岐がすべてテストされているか
- エラーハンドリングが検証されているか
- Electron IPC境界のallowlist・引数変換・Envelope型安全性
