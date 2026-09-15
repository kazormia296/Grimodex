---
name: review-code
description: >
  直近の変更をレビューする。バグ・セキュリティ・テスト不足のみ報告。
  Use when: 「レビューして」「チェックして」「問題ないか見て」と言われたとき。
  コミット前の品質チェック、Phase完了時の確認に使う。
allowed-tools: Read, Grep, Glob, Bash
context: fork
---

レビュー対象を working tree、staged diff、exact commit、または明示した range／base のいずれかに固定し、
read-only でレビューしてください。適用対象の変更だけを確認し、候補へ編集を加えない。review-only はそれ自体ではCIを開始しない。
candidate-untouched independent acceptance reviewer は、候補のファイル、receipt、または意味を変更してはならない。

関連する変更に限り、次の lifecycle checklist を確認する:

- external egress／subprocess／background／async lifecycle なら、全 entry/start/retry/reentrant、admission closure、
  pending-start、active handle owner、cancellation、bounded wait、close/exit/terminal receipt による実終了証拠、
  error/timeout/onClosed owner、persisted restart state。
- 終了主張は実際の終了証拠で裏付ける。kill request、error event、rejected promiseだけでは証拠としない。

その他の確認観点:

- セキュリティ脆弱性（APIキー漏洩、SQLインジェクション、XSS）
- 欠落しているエラーハンドリング
- テストカバレッジの不足
- TipTap拡張の既知パターン違反
- Electron IPC: allowlist漏れ、引数未検証、Envelope破壊、preload越しの過剰権限
- Rust所有権: 不要な.clone()、Arc<T>で解決すべき箇所

P0〜P3のactionableなfindingだけを、対象箇所、影響、再現または根拠、推奨修正とともに報告する。
スタイルの指摘や一般論は報告しない。
