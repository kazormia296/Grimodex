---
name: debug-issue
description: >
  Grimodex の不具合、ランタイム／型エラー、通常の PR／master CI 失敗を
  診断・修正する。Electron release workflow や packaging の失敗は debug-release-ci を使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
---

# Debug Issue

観測された失敗の原因を、再現条件とコード上の根拠で特定し、依頼された範囲で修正する。
調査だけの依頼では編集せず、原因、影響、修正方針を報告する。

## 境界と修正範囲

- Electron IPC に関わる場合は renderer／preload／main／N-API のうち、失敗が通る境界を追う。
  複数境界の既存契約を協調変更する部分には
  [refactor-cross-boundaries](../refactor-cross-boundaries/SKILL.md) の影響マトリクスを使う。
- Electron release workflow、tag build、署名、公証、installer migration、artifact publish の
  失敗は、version を変えず [debug-release-ci](../debug-release-ci/SKILL.md) を使う。
- 原因未確定の runtime failure は環境や製品へ帰属させず、失敗時の証拠と未確認事項を残す。
  高リスクな修正では編集前に
  [GDX-PRECHECK-001](../../../policies/quality/iron-laws.md#GDX-PRECHECK-001) を適用する。

## 検証と完了

修正前に失敗条件を固定し、修正後に同じ条件で期待する振る舞いを確認する。回帰テストは
実際の不具合を検出できる場合に追加し、実装に合わせて既存の期待値を弱めない。
レイアウトや幾何の検証には実ブラウザを使う。happy-dom は flex／grid の実寸を計算しない。

変更範囲とリスクに比例した focused validation を選ぶ。commit、Quick／Full、証跡の条件は
[検証と公開範囲](../../../policies/quality/iron-laws.md#agent-validation)、高リスク候補の独立受入れと
freeze は [GDX-TRACE-001](../../../policies/quality/iron-laws.md#GDX-TRACE-001) に従う。
原因、変更内容、再現条件の検証結果、残る制約を報告する。
