---
name: grimodex-impact-gate
description: >
  Grimodex の差分品質評価で canonical selector の Light suite を実行し、証跡を報告する。
  AI behavior asset 変更後や明示された commit／PR 前の品質評価に使い、修正・レビュー・公開は担当しない。
---

# Grimodex Impact Gate

差分選択ロジックを再実装せず、canonical command で品質モデルと選択された Light suite を検証する。
コード、テスト、fixture、baseline は編集しない。

## 評価範囲を決める

`git status` で既存差分を把握し、依頼の比較範囲を確認する。
[検証の適用条件](../../../policies/quality/iron-laws.md#agent-validation) と、
`evals/impact-map.yaml`／`evals/quality-manifest.yaml` の関連部分を読む。
実行する command の定義は `package.json` で確認する。

commit／PR を依頼していない調査・レビューだけの作業から本 gate や CI を自動起動しない。
AI behavior asset の変更や明示された差分評価では、次の診断用経路を使える。
commit の依頼だけを理由に本 gate を追加せず、通常の修正は適用条件に従って focused 検証を選ぶ。
比較範囲が不明な場合は推測せず、selector の全 suite fallback または `[precheck]` とする。

## 品質モデルの検証

```bash
pnpm verify:quality
```

呼出元で同じ候補・環境・command の成功が確認済みなら再実行しない。
`verify:quality` と Light suite は同一の検証範囲ではないので、片方の成功を他方の代わりにしない。

## 作業ツリー・限定範囲の Light 評価

PR／release の候補証跡を作らない変更では、Quick を開始せず canonical selector を直接使う。
選択だけの確認は `--run` を付けない。実行時は次を使う。

```bash
pnpm eval:impact -- --run
```

標準の差分収集は branch・staged・unstaged・untracked を含む。依頼がファイル集合を指定する場合だけ
`--changed-file <path>` を各対象に指定し、対象外の既存差分を明記する。
限定範囲の結果はその範囲の診断証拠であり、candidate 全体の Quick／Full receipt としない。
選択済み suite を手作業で減らさず、空差分・取得不能・未分類の全 suite fallback も変更しない。

## PR／release の候補証跡

PR／release の証跡が依頼範囲に含まれ、CI が許可されている場合だけ、focused 検証後の
clean な候補 commit で次を実行する。commit-only や CI 明示除外では開始しない。
事前に [GDX-TRACE-001](../../../policies/quality/iron-laws.md#GDX-TRACE-001) を読み、
base／head を一度だけ解決して Quick と直後の verify に同じ値を渡す。

```bash
candidate_base="$(git rev-parse 'origin/master^{commit}')"
candidate_head="$(git rev-parse 'HEAD^{commit}')"
pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"
```

wrapper が Light suite を実行するため、この経路で `eval:impact -- --run` を別途重ねない。
証跡は `.artifacts/local-ci/quick.json`、選択詳細は `.artifacts/local-ci/impact.json`。
stdout の banner を JSON として扱わない。明示的な比較 ref を使う場合も同じ固定入力を守る。

## 結果の扱い

selected Light suite がすべて成功した場合だけ Light gate の成功とする。
Quick は complete receipt の requested／resolved base・head と現在候補が一致する場合だけ成功とし、
partial `--from`、dry-run、stale receipt は受入れ証拠にしない。
immutable child／revision の評価では
[ID とページネーションの契約](../../../policies/quality/iron-laws.md#immutable-identity) も確認する。

最初の失敗を保存し、失敗分類と suite を報告する。修正は原因に応じて `debug-issue`、
`test-feature`、`grimodex-author` へ渡し、再試行で失敗を隠さない。
Heavy は実行権限・資格情報・環境が揃って実行するまで `deferred`、runner がなければ `blocked`。
どちらも passed に読み替えない。

比較範囲、matched rule／fallback、requirement ID、各 Light 結果、Heavy の command と延期理由、
blocked gap、failure class を報告する。PR 証跡では固定 base／head と runtime も含める。
本 gate は `review-code` の意味的監査や `refactor-cross-boundaries` の影響マトリクスを置き換えない。
