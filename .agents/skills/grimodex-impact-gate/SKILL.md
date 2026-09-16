---
name: grimodex-impact-gate
description: >
  Grimodex の Git 差分から関連 requirement と Light 評価 suite を選択し、
  canonical quality workflow を読み取り専用で実行して証跡を報告する。
  「差分評価」「品質ゲート」「impact gate」、commit／PR 前の検証、
  grimodex-author 後の評価で使用する。テスト作成、失敗修正、意味的コードレビュー、
  commit、push、merge には使用しない。
---

# Grimodex Impact Gate

差分選択ロジックを再実装せず、repository の canonical command を実行する薄い gate として
振る舞う。コード、テスト、fixture、baseline は編集しない。

## Preflight

1. `AGENTS.md`、`policies/quality/iron-laws.md`、`evals/impact-map.yaml`、
   `evals/quality-manifest.yaml` を読む。
2. `git status` で staged、unstaged、untracked の状態を確認する。
3. `package.json` に `verify:quality`、`ci:local:quick`、`ci:local:verify` が実在することを確認する。
4. PR／commit 間を評価する場合は base と head を実在確認する。比較範囲を確定できない
   場合は推測せず、全 suite fallback または `[precheck]` として扱う。

## Execute the canonical gates

1. 品質モデルと selector 自体を先に検証する。

   ```bash
   pnpm verify:quality
   ```

2. PR／releaseの証跡が依頼範囲に含まれ、CIが許可されている場合は、focused検証後のcleanな候補commitを対象に、
   local CI wrapperから選択されたLight suiteを実行する。`candidate_base`／`candidate_head`は候補HEADの後に一度だけ解決し、
   Quickと直後のverifyへ同じ値を渡す。commit-onlyまたはCI明示除外の作業ではQuickを開始せず、commit／PRが依頼されていない調査・レビューではcommitを作らず、
   CIも開始せず、working treeの選択・実行は診断専用として扱う。
   wrapperが内部で`pnpm eval:impact`を呼ぶため、差分選択ロジックを別経路で再実装しない。

   ```bash
   candidate_base="$(git rev-parse 'origin/master^{commit}')"
   candidate_head="$(git rev-parse 'HEAD^{commit}')"
   pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
   ```

3. 明示的な比較範囲が必要な場合は、検証済みのrefを`candidate_base`／`candidate_head`へ一度だけ代入し、以後は再解決・再代入しない。

   ```bash
   pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
   ```

4. 実行直後に同じrefでreceiptを検証する。途中で差分やHEADが変わったreceiptを成功証跡にしない。

   ```bash
   pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"
   ```

   machine-readable evidenceの正本は`.artifacts/local-ci/quick.json`、選択suiteの詳細は
   `.artifacts/local-ci/impact.json`とする。stdoutのbannerをJSONとして扱わない。

`evals/impact-map.yaml` の rule を手作業で再判定したり、選択 suite を減らしたりしない。
selector が複数 rule の suite を合算し、未分類 path、空差分、取得不能な差分を安全側の
全 suite fallback として扱う。untracked file も評価対象から除外しない。

## Interpret results

- 全ての selected Light suite が成功した場合だけ Light gate を成功とする。
- receiptが`complete`で、requested／resolved base・headと現在candidateが一致する場合だけ
  Quick gateを成功とする。`--from`、`--dry-run`、stale receiptは成功証跡ではない。
- Heavy evaluation は実 connector、資格情報、課金、環境分離を必要とするため、通常は
  `deferred` evidence としてコマンドと理由を報告する。deferred／skipped を passed としない。
- 実行可能な runner 自体がない評価は `blocked` gap として必要作業を報告し、Heavy の
  runnable command や成功へ読み替えない。
- diff fallback が発生した場合は、原因と全 suite が選ばれたことを明示する。
- immutable child／revisionを扱う差分では、復元・Decision・再読取・表示・receiptのIDが同一で、親`runId`だけで
  再選択していないこと、操作対象外のDecisionが不変であることを確認する。bounded lookupはlimit後の一覧だけで
  不存在と判定せず、mockでlimit・順序・cursorとN/N+1境界を再現する。
- command が失敗した場合は最初の失敗を保持し、再試行で隠さない。失敗分類と該当 suite を
  報告して停止する。
- 本スキル内で production code、テスト、fixture、manifest、impact map を修正しない。
  修正依頼は原因に応じて `debug-issue`、`test-feature`、`grimodex-author` へ渡す。
- 本スキルは `review-code` の意味的監査や `refactor-cross-boundaries` の実行経路
  impact matrix を置き換えない。

## Report

次を一つの結果として報告する。

- 比較範囲と changed files
- requested／resolved base・head SHA と Node／platform runtime
- matched rule と fallback の有無
- affected requirement ID
- selected Light suite と各終了結果
- Heavy evaluation の deferred command と理由
- blocked evaluation の理由と runner 化に必要な作業
- failure class、既知の gap、次に必要な担当 skill

証跡のいずれかが欠ける場合は完了扱いにしない。
