---
name: bump-version
description: >
  Grimodex の Electron バージョン更新とリリース準備を、依頼された段階まで進める。
  tag 作成後の終端は GitHub Draft Release の確認とし、Release は公開しない。
allowed-tools: Read, Edit, Grep, Bash
argument-hint: "[patch|minor|major]  (省略時 patch)"
---

この Claude Code コマンドは [共通 skill](../../../.agents/skills/bump-version/SKILL.md) を読み、
依頼の対象・引数・実行範囲に適用する。補助資料への相対リンクは、共通 skill の所在を基点に参照する。
