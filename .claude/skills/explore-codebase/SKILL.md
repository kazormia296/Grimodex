---
name: explore-codebase
description: >
  Grimodex の構造、実装、データフロー、境界の振る舞いを、コード変更なしで調査する。
  実装や修正も依頼されている場合は、その作業の skill を主フローにする。
allowed-tools: Read, Grep, Glob
argument-hint: [exploration-target]
context: fork
agent: Explore
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/explore-codebase/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
