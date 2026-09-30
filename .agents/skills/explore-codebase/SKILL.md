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

# Explore Codebase

依頼された構造や振る舞いを、実在するコードと仕様を根拠に説明する。コード、設定、Git state は
変更しない。調査・レビューだけの依頼では
[検証と公開範囲](../../../policies/quality/iron-laws.md#agent-validation) に従い、CI を開始しない。

結論に必要な entry point、consumer、データフローと責務を追う。Electron IPC を通る振る舞いは
renderer／preload／main／N-API の関連する境界まで確認する。

報告には、質問への回答、根拠となるファイルと箇所、確認できた事実と未確認事項を含める。
不具合が見つかった場合も、調査の依頼を修正の許可として扱わない。
