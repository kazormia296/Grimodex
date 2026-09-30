---
name: test-feature
description: >
  Grimodex の指定機能に対するテスト追加・実行、または既存テスト結果の確認を行う。
  実行だけの依頼では、テスト追加や製品コードの修正まで範囲を広げない。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
argument-hint: [feature-or-file-path]
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/test-feature/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
