---
name: add-electron-command
description: >
  Grimodex に新しい Electron IPC コマンドを追加し、共有契約、main／N-API 実装、
  preload 境界とテストを揃える。既存コマンドの不具合修正は debug-issue を使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [command-name-and-description]
disable-model-invocation: true
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/add-electron-command/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
