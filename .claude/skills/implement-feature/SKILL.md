---
name: implement-feature
description: >
  Grimodex の新機能や既存機能の拡張を実装し、要求された振る舞いを検証する。
  不具合修正は debug-issue、AI 指示・skill・評価資産の変更は grimodex-author を使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [feature-description]
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/implement-feature/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
