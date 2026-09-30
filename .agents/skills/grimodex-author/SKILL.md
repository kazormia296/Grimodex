---
name: grimodex-author
description: >
  Grimodex の AI指示・prompt・skill・AI policy・評価資産を変更し、正本と品質契約を揃える。
  通常の機能実装やレビューだけの依頼には使わない。
---

# Grimodex Author

AI の振る舞いを決める資産と、その requirement・consumer・評価証跡を一緒に更新する。
依頼された対象と既存差分を確認し、変更する振る舞い、保持する契約、完了条件を明らかにする。

## 対象ごとの正本

該当する行の正本と、`evals/quality-manifest.yaml` にある関連 requirement を変更前に読む。
必要な制約は [Iron Laws](../../../policies/quality/iron-laws.md) の該当節で確認する。

- 開発エージェントの常設指示・skill: `AGENTS.md`、`.agents/skills/**`。共通手順を Claude 側へ複製しない
- アプリの localized prompt: `src/prompts/**`。ja／en catalog、reserved data tags、JSON delimiter、parser、prompt version
- Scan の prompt・評価: `packages/scan-prompts/**`。version と評価 fixture
- AI capability・policy: `src/features/ai-policy/**`。入力・権限・出力契約
- AI 経路・model role: `src/features/ai-verification/aiPathRegistry.ts`、`src/features/chat/modelRouting.ts`、`docs/AI経路検証.md`。verifier と実在する test reference
- 品質要件・fixture・差分評価: `policies/quality/iron-laws.md`、`evals/quality-manifest.yaml`、`evals/impact-map.yaml`。requirement ID・failure class・ケース分離

`src-tauri/capabilities/**` は凍結された Tauri v1 shell の設定で、現行 AI capability の正本ではない。
一般アプリ機能は `implement-feature`、新規 IPC は `add-electron-command`、既存経路の境界再編は
`refactor-cross-boundaries` を主フローにし、本スキルは AI behavior asset の部分だけを担当する。

## 指示を設計する

- skill 変更では `skill-creator` の現行規約を使う。description は能力と適用条件を短く表し、
  誤発動しやすい隣接作業との境界だけを加える。
- 常設指示にはプロジェクト固有の境界と必要な参照先を置く。複数モードの詳細は、必要な場合だけ
  読む supporting reference へ分ける。短い skill に形式だけの router を追加しない。
- 成果物と完了条件を中心に書く。固定手順は順序が正しさ・権限・証跡を左右する箇所に残す。
  同じ規則を別の instructions／policy tree へ複製しない。
- 正常系・拒否系・境界値など、変更で失われ得る契約を focused test／評価ケースで確認する。
  prompt injection や出力 schema は該当する境界だけを検証する。
- ツール名・schema・権限・情報鮮度を推測で補わない。不足は `[precheck]` として明示する。
  security-sensitive な変更では編集前に
  [GDX-PRECHECK-001](../../../policies/quality/iron-laws.md#GDX-PRECHECK-001) を適用する。

## 検証と完了

変更した契約に最も近い focused test を実行し、
[grimodex-impact-gate](../grimodex-impact-gate/SKILL.md) で `pnpm verify:quality` と
選択された Light suite の検証をまとめて行う。同じ成功済み command を本スキルから重ねて実行しない。
Heavy の実 connector・資格情報・課金は別の実行範囲とし、未実行を成功扱いしない。

変更した正本、関連 requirement ID、更新した評価、検証結果、Heavy の deferred／blocked と残る制約を報告する。
失敗は `[routing]`、`[precheck]`、`[tool]`、`[policy]`、`[quality]`、`[artifact]` に分類する。
commit／PR／公開の境界は [検証の適用条件](../../../policies/quality/iron-laws.md#agent-validation) に従う。
