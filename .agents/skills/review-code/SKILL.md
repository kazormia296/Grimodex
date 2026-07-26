---
name: review-code
description: >
  直近の変更をレビューする。バグ・セキュリティ・テスト不足のみ報告。
  Use when: 「レビューして」「チェックして」「問題ないか見て」と言われたとき。
  コミット前の品質チェック、Phase完了時の確認に使う。
allowed-tools: Read, Grep, Glob, Bash
context: fork
---

直近のコミットの変更をレビューしてください。

確認観点:

- セキュリティ脆弱性（APIキー漏洩、SQLインジェクション、XSS）
- 欠落しているエラーハンドリング
- テストカバレッジの不足
- TipTap拡張の既知パターン違反
- Electron IPC: allowlist漏れ、引数未検証、Envelope破壊、preload越しの過剰権限
- Rust所有権: 不要な.clone()、Arc<T>で解決すべき箇所

**スタイルの指摘は不要。バグと脆弱性のみ報告。**
