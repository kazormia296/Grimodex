---
name: review-code
description: >
  指定された Grimodex のコード差分を read-only でレビューし、根拠のあるバグ、
  脆弱性、回帰、検証 gap を報告する。多次元の独立レビューは adversarial-review を使う。
allowed-tools: Read, Grep, Glob, Bash
context: fork
---

# Review Code

対象を working tree、staged diff、exact commit、または指定された range／base に固定し、
read-only でレビューする。依頼に多次元の独立検証が含まれる場合は
[adversarial-review](../adversarial-review/SKILL.md) を使う。

差分から到達する失敗条件と利用者への影響を確認する。Grimodex では、変更が関わる場合に
次の境界を確認する。

- Electron IPC の allowlist、引数検証、Envelope、preload の権限。
- TipTap の文書保持、帰属情報、失敗時の本文保全。
- immutable child／revision と bounded lookup の
  [ID・検索範囲の契約](../../../policies/quality/iron-laws.md#immutable-identity)。
- external egress／subprocess／background／async lifecycle の所有権、終了証拠、再入経路。
  詳細は [GDX-PRECHECK-001](../../../policies/quality/iron-laws.md#GDX-PRECHECK-001) を参照する。

P0〜P3 の actionable な finding を、最小のコード位置、具体的な失敗条件、根拠、影響、修正方針と
ともに報告する。テスト不足は実際の失敗を見逃す検証 gap として説明できる場合に限り報告し、
スタイルや好みだけの指摘は含めない。finding がなければその旨と検証できなかった範囲を記す。

レビュー依頼だけでは編集や CI を開始しない。
[検証と公開範囲](../../../policies/quality/iron-laws.md#agent-validation) と、該当する場合は
[GDX-TRACE-001](../../../policies/quality/iron-laws.md#GDX-TRACE-001) の独立受入れ規律に従う。
candidate-untouched independent acceptance reviewer は、候補のファイル、receipt、意味を変更しない。
