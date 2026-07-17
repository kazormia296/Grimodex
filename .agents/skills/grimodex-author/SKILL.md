---
name: grimodex-author
description: >
  Grimodex の AI 指示、system prompt、Codex skill、AI policy、AI 経路レジストリ、
  評価 fixture と品質 manifest を作成・変更し、正本、Iron Laws、契約テスト、
  追跡可能性を一貫して更新する。AI behavior asset の追加・変更、
  「AI指示」「システムプロンプト」「Codexスキル」「AI評価fixture」で使用する。
  一般的な UI／DB／IPC／Rust 機能実装、テストだけの追加、レビューだけの依頼、
  バグ修正には使用しない。
---

# Grimodex Author

AI の振る舞いを決める資産を、実在する正本と評価証跡から切り離さずに変更する。

## Ownership

対象ごとに次の正本を使う。

- Codex の常設指示と workflow: `AGENTS.md`、`.agents/skills/**`
- アプリの localized prompt と trust boundary: `src/prompts/**`
- Scan の versioned prompt と評価: `packages/scan-prompts/**`
- AI capability／policy: `src/features/ai-policy/**`
- AI 経路と model role: `src/features/ai-verification/aiPathRegistry.ts`、
  `src/features/chat/modelRouting.ts`
- 品質要件、評価ケース、差分評価: `policies/quality/iron-laws.md`、
  `evals/quality-manifest.yaml`、`evals/impact-map.yaml`
- AI 経路の検証方針: `docs/AI経路検証.md`

`src-tauri/capabilities/**` は凍結された Tauri v1 shell の設定であり、現行 Electron の
AI capability 正本として変更しない。一般アプリ機能は `implement-feature`、新規 IPC は
`add-electron-command`、複数境界の既存経路再編は `refactor-cross-boundaries` を主フロー
とし、本スキルは AI behavior asset と評価証跡の部分だけを担当する。

## Workflow

### 1. Precheck と正本の確認

1. `AGENTS.md`、`policies/quality/iron-laws.md`、
   `evals/quality-manifest.yaml` を変更前に読む。
2. `git status` と既存差分を確認し、ユーザーの変更を上書きしない。
3. 対象の正本、consumer、出力契約、関連 requirement ID、既存の focused test を
   `rg` で実在確認する。ツール名や schema を推測で補わない。
4. 入力、権限、必要データ、情報鮮度、期待出力を確認する。満たせない場合は
   `[precheck]` と根拠を報告し、変更を開始しない。

### 2. 変更契約を定義する

1. 保持する振る舞い、変更する振る舞い、禁止動作、出力 schema を明示する。
2. `evals/quality-manifest.yaml` から関連 requirement と Light／Heavy 評価を特定する。
3. prompt 変更では ja／en catalog、reserved data tags、JSON delimiter、parser、
   prompt version のファイル内規約を確認する。
4. 新しい AI 経路では `docs/AI経路検証.md` に従い、`aiPathRegistry.ts` の verifier と
   実在する test reference を割り当て、model role の完全性も維持する。
5. 評価 fixture は会話、状態 ID、生成物をケース間で共有せず、requirement ID と
   failure class を追跡可能にする。

### 3. 正本と証跡を一緒に変更する

- 同じ規則を別の instructions／policy tree へ複製せず、既存の正本を更新する。
- 正常系、拒否系、境界値、prompt injection、出力契約を focused test または評価ケースで
  先に固定する。
- skill 変更では `skill-creator` の現行 frontmatter と metadata 規約に従う。
- 副作用を伴う検証を無言で再試行しない。Heavy 評価や実 connector は、必要な資格情報と
  実行権限が揃う場合だけ実行する。
- 依頼範囲外の refactor、commit、push、PR 作成へ広げない。

### 4. 検証する

1. 変更資産に最も近い focused test／contract test を実行する。
2. `pnpm verify:quality` で Iron Laws、manifest、fixture、impact selector の整合性を確認する。
3. `$grimodex-impact-gate` を使い、現在の差分へ選択された Light suite をすべて実行する。
4. Heavy 評価の `deferred` は成功へ読み替えず、コマンドと延期理由を残す。
   runner が存在しない評価は runnable Heavy にせず `blocked` と必要作業を残す。
5. 失敗を `[routing]`、`[precheck]`、`[tool]`、`[policy]`、`[quality]`、
   `[artifact]` のいずれかへ分類する。

## Completion evidence

完了時に、変更した正本、requirement ID、追加・更新した評価ケース、実行した focused test、
impact gate が選択した suite、Heavy の deferred 項目、残るリスクを報告する。検証失敗を
成功扱いにせず、出力 schema、引用、リンク、生成物の正常性を確認してから完了とする。
