# M3 構造健全性 Finding 契約案

> 状態：【起案者案】作者への確認材料。実装・契約・表示の決定ではない。
> 前提：`docs/plans/m3-structure-health-rules-design-draft.md` の「2026-11-26 の回答」「追加の回答」を維持する。注意は「構造の健全性」と Work Layer の両方に出し、元の資料と原稿の場面は分けて示す。AI の道具・取込み・抽出で作られ、本文に出ず根拠も無い項目は警告する。一般呼称の語一覧は作者確認後に使い、番号だけの名前は警告、説明つきは今は警告しない。

## 1. 今の取り決め

`policies/narrative/narrative-finding-contract.json` は各 rule に `ruleId`・`version`・`identityScope`・`observationFields`・`materialBasisFields` を持たせ、scope は `edge` と `maintenance-work` の2種、reason code は11種、unknown は `fail-closed` とする。2つの登録 rule は `narrative.consumer-freshness` と `narrative.maintenance-contract-failure`。

`policies/narrative/schemas/narrative-finding-contract.schema.json` の `rules.items.oneOf` もこの2 scope のみを許す。Native の `finding_identity.rs::validate_finding_rule` がscope・field allowlist・保存クラス・writer authorityを検証し、`bundled_finding_rule_registry` が埋込み契約を読む。`stable_finding_identity` は rule ID・version・scope・stable subject からIDを作り、`material_basis_digest` は rule ID・version・scope・`material_basis_fields` の一覧と、宣言した field の値をハッシュにする（`finding_identity.rs` の 389〜395 行あたり）。Run ID・時刻は入らない。`evaluator.rs::FindingReasonCode::{as_str,try_from}` がreason codeを列挙し、未知値を拒む。

## 2. 6規則の案

以下はすべて【起案者案】。`evidenceDetailDigest` の中身は構造化してハッシュ化し、元資料と原稿場面を別の要素に保つ。Run ID・時刻・表示場所は含めない。現在の Native 入力にも同名fieldはあるが、新scopeで使うには schema と `validate_finding_rule` の許可field追加が要る。

### `source-unseen`

| 項目 | 【起案者案】 |
| --- | --- |
| `ruleId` | `narrative.health.source-unseen` |
| `identityScope` | 新scope `entry`。対象となる1つの Entry を1件とする。stable subject は `entry:<entry-id>`。 |
| `observationFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest` |
| `materialBasisFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest`。digest内に由来、元資料Evidence、原稿場面Evidence、本文Mentionを別々に記録する。 |
| reason code | `source-material-missing`／`scene-support-missing`／`source-and-scene-support-missing`。個別欠落も警告にする場合の候補。どちらの欠落を発火条件にするか【未決】。 |

### `zero-mentions`

| 項目 | 【起案者案】 |
| --- | --- |
| `ruleId` | `narrative.health.zero-mentions` |
| `identityScope` | `entry`。1つの Entry を1件とする。 |
| `observationFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest` |
| `materialBasisFields` | 同じfield。digestは由来、全対象場面の走査完了、matcher基準、Mention集合を含む。未完了・古い索引ではFindingを出さない（`src/features/codex/bodyMentionIndexState.ts::isBodyMentionIndexReady` は既存ready判定）。 |
| reason code | `mention-absent-after-ready-scan`。有効な元資料EvidenceがあるEntryにも単独で警告するか【未決】。 |

### `generic-surface`

| 項目 | 【起案者案】 |
| --- | --- |
| `ruleId` | `narrative.health.generic-surface` |
| `identityScope` | `entry`。1つの Entry を1件とする。 |
| `observationFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest` |
| `materialBasisFields` | 同じfield。digestはcanonical name、作者確認済み語一覧の一致語と版、承認状態を含む。説明つき語句は部分一致させない。 |
| reason code | `generic-term-exact-match`／`generic-term-numbered-match`。語一覧の内容は作者確認前に使わない。 |

### `ambiguous-identity`

| 項目 | 【起案者案】 |
| --- | --- |
| `ruleId` | `narrative.health.ambiguous-identity` |
| `identityScope` | 新scope `entry-surface`。正規化した1つの表記とその候補Entry集合を1件とする。stable subject は `surface:<normalizer>:<表記>`。Entryペアごとに分ける案も【未決】。 |
| `observationFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest` |
| `materialBasisFields` | 同じfield。digestは正規化基準と候補Entry集合を含む。 |
| reason code | `surface-matches-multiple-entries`／`surface-conflicts-with-correction`。訂正規則との競合はADR 015後。 |

### `unsupported-relation`

| 項目 | 【起案者案】 |
| --- | --- |
| `ruleId` | `narrative.health.unsupported-relation` |
| `identityScope` | 新scope `relation`。1つのRelationを1件とする。stable subject は `relation:<relation-id>`。 |
| `observationFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest` |
| `materialBasisFields` | 同じfield。digestはRelationの型・両端・由来、元資料Evidence、原稿場面Evidenceを分けて含む。両端EntryのMentionだけではRelationの根拠としない。 |
| reason code | `relation-source-evidence-missing`／`relation-scene-evidence-missing`。適用元proposalのEvidenceだけで評価する案と、新しいRelation Evidenceを保存する案が【未決】。前者を推奨。 |

### `correction-conflict`

| 項目 | 【起案者案】 |
| --- | --- |
| `ruleId` | `narrative.health.correction-conflict` |
| `identityScope` | 新scope `correction-rule-pair`。矛盾する不変訂正ruleの1組を1件とする。stable subject はソートしたrule identityの組。 |
| `observationFields` | `stableSubject`, `reasonCode`, `evidenceDetailDigest` |
| `materialBasisFields` | 同じfield。digestは両ruleのrevision・scope・priority・outcomeを含む。ADR 015の保存・適用基盤後に限る。 |
| reason code | `same-priority-opposed-outcome`／`overlapping-scope-incompatible-outcome`。ADR 015 §4の優先scope例外は競合に数えない。 |

## 3. 共通にする点

- 2画面は同じFindingを表示し、画面別IDを作らない。`finding_identity.rs::stable_finding_identity` はrule ID・version・scope・stable subjectをIDに含めるため、Entry／Relation／表記集合のstable subjectを正本にする。`narrative-consumer-contract.json` の `finding_key` は現在 `{consumerKind}:{consumerKey}` 形式であり、このFinding IDとの接続方法は【未決】。新しいConsumerとして扱うなら同契約の分類も要る。
- Attentionは既存の `material-basis-digest-match` 条件を使い、材料が変わらない再評価では作者の処分を保ち、関係する材料が変わった時だけ再確認に戻す案。`finding_identity.rs::material_basis_digest` はRun ID・Epoch・時刻を除外し、`maintenance-attention-contract.json` はFinding Observation更新やEpoch変更でAttentionを変えない。
- `docs/adr/015-author-identity-corrections.md` はProposed。訂正ruleとの競合を扱う `ambiguous-identity` と `correction-conflict` は、PR 0（受入れ契約）・PR 1（immutable rule／lineage基盤と適用）の後に実装し、PR 5でStructure Healthの受入れを閉じる案。`ambiguous-identity` の単純な同表記・複数Entry検出だけを先行させるかは【未決】。

## 4. 実装時に変える候補

- 必須候補：`policies/narrative/narrative-finding-contract.json`（6 ruleとreason code）、`policies/narrative/schemas/narrative-finding-contract.schema.json`（新scope・field allowlist）、`finding_identity.rs::{validate_finding_rule,ObservationDigestInput,MaterialBasisInput,observation_digest,material_basis_digest}`（scopeとdigest材料）、`evaluator.rs::FindingReasonCode::{enum,as_str,try_from}`（Native allowlist）。
- 条件付き：`policies/narrative/narrative-consumer-contract.json` は新Consumer kindやConsumer key方式を採る時だけ変更。Attentionのidentity・処分条件を変えるなら `maintenance-attention-contract.json` も変更。
- 原則不要：`semantic-state-vocabulary.json` はFreshness／review stateを増やさない限り変更不要。reason codeは既に `narrative-finding-contract.json` が正本で、`narrative-dependency-role-registry.json` も同契約を参照する。ADR 015本文は本案で変更しない。

## 5. 作者に伺う形

| 問い | 選択肢 | 推奨と理由 |
| --- | --- | --- |
| 1. `source-unseen` と `zero-mentions` が同じEntryに当たる時、何を1件と数えるか | A. 本文に出ず、元資料・場面の根拠も無いEntryを1件にする／B. 元資料と場面の欠落を別々の注意にする／C. 根拠の有無に関係なくMention 0件を別に数える | **A**。回答済みの「本文に出ず根拠も無い」を保ち、二重注意を避ける。 |
| 2. 曖昧な同表記は何を1件と数えるか | A. 表記1つと候補Entry集合／B. Entryの組ごと／C. 候補Entryごと | **A**。候補が増減しても同じ表記の注意と処分を追える。 |
| 3. （伺わない。既定済み）却下・保留した注意をいつ再確認に戻すか | A. 関係するEvidence・Mention・候補集合などの材料が変わった時／B. 評価のたび／C. 作者が手動で再開した時だけ | **A**。無関係な再評価を除き、根拠が実質的に変わった時だけ再確認できる。 |

### 2026-11-27 の回答（構造化質問。原文は handoff の `m3-user-answers-20261127j.md`）

| 問い | 回答 | 設計に入ること |
| --- | --- | --- |
| 本文に出ず根拠も無い AI・取込みの項目の注意は何件か | 項目ごとに 1 件（推奨） | `source-unseen` と `zero-mentions` が同じ Entry に当たるときは 1 件にまとめる。元の資料と原稿の場面の根拠は、中身で分けて見せる。reason code の分け方は実装 PR で示す【起案者案】 |
| 同じ表記の曖昧さは何を 1 件と数えるか | 表記ごとに 1 件（推奨） | stable subject は正規化した表記と、当たる Entry の集合。集合が増減したら material basis が変わり、却下した注意も戻る |
| 語の一覧 | 案 2 をこのまま使う（推奨） | `generic-surface` の判定に使う。作品ごとに足す・外す画面の置き場と文言は別に伺う |

注意を戻す条件（無関係な再評価では処分を保ち、根拠が実質的に変わったときだけ戻す）は、roadmap の P0-B の受入れ条件と #1142 の試験で既に決まっているので、改めて伺っていない。

