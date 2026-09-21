---
name: debug-issue
description: >
  Grimodex の不具合、ランタイム／型エラー、通常の PR／master CI 失敗を
  診断・修正する。Electron release workflow や packaging の失敗は debug-release-ci を使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [bug-description-or-error-message]
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/debug-issue/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
