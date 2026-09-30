---
name: review-code
description: >
  指定された Grimodex のコード差分を read-only でレビューし、根拠のあるバグ、
  脆弱性、回帰、検証 gap を報告する。多次元の独立レビューは adversarial-review を使う。
allowed-tools: Read, Grep, Glob, Bash
context: fork
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/review-code/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
