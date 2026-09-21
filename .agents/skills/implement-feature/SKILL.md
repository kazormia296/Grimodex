---
name: implement-feature
description: >
  Grimodex の新機能や既存機能の拡張を実装し、要求された振る舞いを検証する。
  不具合修正は debug-issue、AI 指示・skill・評価資産の変更は grimodex-author を使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
---

# Implement Feature

要求された利用者の振る舞いを、既存のアーキテクチャと公開契約に整合する形で実装する。
受入れ条件、影響範囲、維持すべき挙動を明らかにし、作業の規模とリスクに応じて進め方を選ぶ。

## プロジェクト固有の境界

- 新規 Electron IPC コマンドには
  [add-electron-command](../add-electron-command/SKILL.md) を併用する。
- 二つ以上の境界で既存の責務・型・契約を協調変更する部分には
  [refactor-cross-boundaries](../refactor-cross-boundaries/SKILL.md) の影響マトリクスを使う。
- AI behavior asset の変更は [grimodex-author](../grimodex-author/SKILL.md) が担当する。
- 高リスクな変更では編集前に
  [GDX-PRECHECK-001](../../../policies/quality/iron-laws.md#GDX-PRECHECK-001) を適用し、
  対象経路の owner／lifecycle と未確認事項を解消する。
- immutable child／revision や bounded lookup を扱う場合は
  [ID と検索範囲の契約](../../../policies/quality/iron-laws.md#immutable-identity) を守る。

## 振る舞いの検証

テストは公開境界で観測できる結果を検証する。複雑な状態遷移や契約変更では、実装前に期待する
振る舞いをテストで固定するとよい。単純で可逆な変更へ、一律の TDD やテスト追加を要求しない。
既存テストを変更する場合は仕様変更、誤った前提、flaky などの根拠を示し、実装に合わせて弱めない。
レイアウトや幾何は、実寸を計算しない happy-dom ではなく実ブラウザで検証する。

関連テスト、型、lint、Electron／Rust 境界などから、変更範囲とリスクに比例した focused validation を
選んで実行する。commit、Quick／Full、証跡の条件は
[検証と公開範囲](../../../policies/quality/iron-laws.md#agent-validation) に従う。
高リスク候補は [GDX-TRACE-001](../../../policies/quality/iron-laws.md#GDX-TRACE-001) に従って
独立受入れを完了してから freeze する。

完了時は、利用者にとって何が変わったか、受入れ条件をどの検証で確認したか、未検証事項や
制約を報告する。commit や公開は依頼された段階まで進める。
