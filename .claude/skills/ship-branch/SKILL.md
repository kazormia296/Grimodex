---
name: ship-branch
description: >
  Grimodex の clean な commit 済みブランチを、依頼された push、PR、merge の段階まで
  進め、候補 HEAD と検証証跡を照合する。実装変更の commit 作成、version 更新、Release 公開は含めない。
allowed-tools: Bash, Read
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/ship-branch/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
