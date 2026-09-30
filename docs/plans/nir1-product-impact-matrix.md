# NIR-1 L1–L3 実装前影響マトリクス

2026-09-08。統合計画の L0–L5 継続実装に向けた技術 binding 表。
正本は [統合実装計画](narrative-ir-nir1-implementation-plan.md)。本書はその承認範囲を追加・変更しない。
承認済み plan / threat-model ref と candidate ledger は integrator が管理する。
マトリクス初稿は読み取りのみで作成した。fixture準備は§7、L1 membershipのfocused受入れとL2 canonicalのfocused実装は§8に記録する。

担当は実装者であり、この候補の独立受入れは担当しない。L0の品質manifest固定後にL1を実装し、候補未編集の独立レビューを経た。
L2 canonicalとwhole admission、L3 Indexは境界を分けた小候補として扱う。

## 1. 保持する不変条件

- 標準 planner の `secret:true` を変えず、既存レビュー UI の非秘密化が作る Human child をその child 自身へ明示承認する。
- immutable な root / parent / child を書き換えず、`exact(S1)`、semantic core、Evidence と stage request seals を保持する。
- membership、material disclosure、canonical Freshness、approval、Index state は別判定。membership complete は検索資格を与えない。
- root の限定 recipe replay を引き継ぎ、child の effective material basis と Scope-resolution control 入力を取りこぼさない。
- 古い ancestor の Scope authority token を現在の token へ上書きしない。歴史的な lineage の検証と、選択された current child の現在資格を分離する。
- `proposal-revision` と `semantic-index` は同じ canonical authority を使う。Index の再構築は元 revision の再評価・再承認を代替しない。
- root replay / 診断 policy の既存 opt-in 外部形式と `diagnosticOnly` の意味を維持する。製品が診断 verdict を検索許可に使わない。
- Tauri legacy shell、外部 model/API、全文 closure 保存、未承認の永続化形式には拡張しない。

## 2. 実経路と境界

`planned` はownerと使用する既存契約が確認済み、`unknown` は該当小候補の実装前に技術調査で閉じる項目。
`focused` は記載した狭い境界だけの実装・検証であり、製品・Quick/Full受入れを意味しない。unknownのままactivationへ進まない。

| ID     | Flow / variant                                 | Owner / producer                                                                              | Boundary、正本、検証                                                                                                                       | Consumer / sink                                                                  | 保持する挙動 / fallback                                                                            | 検証                                                                                           | Status                                                                           |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| L1-01  | 通常 AI 抽出から initial V2 revision           | `chronicleExtractionApi.ts` → `extractionCoordinator.ts` → `chronicleV2Production.ts`         | standard `useAi:true`、有効 production marker、ProposalSet / terminal receipts / Adapter                                                   | `finish_task` → `repository.rs`、immutable revision                              | planner secret defaultを保持。V1/receipt不足をV2 completeに昇格しない                              | 通常buildでS1限定抽出、S2がsnapshot/requestに不在、initial secret=true                         | focused: normal UI fixture                                                       |
| L1-02  | 非秘密化による ScopeOverride child             | `ChronicleProposalReview.tsx` → `reviseChronicleProposal` / `recordChronicleProposalRevision` | `nativeApi.ts` → `ipcContract.ts` → preload/main → N-API `narrative_extraction_create_human_derived_revision` → `human_materialization.rs` | child Revision、effective material、D1、V1、canonical Freshness、current pointer | Native classification/CASを保持。同transactionでunreviewed childへ。親承認を継承しない             | UI checkbox、child identity変更、Scope/source/D1の同時公開、CAS rollback                       | focused: normal UI child + membership                                            |
| L1-03  | title/note編集、繰り返すchild連鎖              | 同じ既存C2B writer                                                                            | `human_derivation.rs`、Core changed-path classifier、`human_material_basis.rs`                                                             | projection-only / scope-override child                                           | semantic coreを変えない。projection-onlyでも新revisionには別承認                                   | scope→projection、projection→scope、複数child、同semantic input digest                         | focused: Native child chain membership                                           |
| L1-04  | 明示承認、pre-Apply拒否・保留・撤回            | review UI → `decideChronicleProposal` → `appendHumanDecision`                                 | `narrative_extraction_append_human_decision` → dedicated N-API → `repository.rs:append_decision_on_conn`                                   | Human decision ledger + current status                                           | actor/authorityはbackendで固定。current revision guard。Apply後の新しい撤回操作は作らない          | child承認、旧revision判断拒否、current未承認childは親承認で許可されない                        | focused: normal UI current child approval; withdrawal is L2/L3                   |
| L1-05  | cold reopen / persisted review resume          | `chronicleExtractionApi.ts`、coordinator hydration                                            | `narrative_extraction_get_run_review_bundle`、saved snapshot/artifacts/receipt readers                                                     | current child、root receipts、review表示                                         | 再抽出なし。消えたproofをprocess cacheで補わない                                                   | app終了→別process再開、native DB read、same child/root/seals                                   | focused: separate-process cold fixture                                           |
| L1-06  | current childから材料membership                | 新しいshared typed reader（配置案は§3）                                                       | immutable revision、lineage seals、payload/classifier、effective material/source basis、D1/V1                                              | backend typed complete/incomplete/unsupported/inconsistent result                | rootからchildへ必要材料を追跡。部分材料はcompleteにしない。IO/SQL errorsはerror                    | 正規cold fixture + lineage/control欠落・不整合、既存root negative再利用                        | focused accepted: 15 tests + independent review                                  |
| L1-07  | 既存診断CLI / root golden                      | `material_roster.rs`、`material_roster/{replay,prompt,segments}.rs`                           | opt-in `nir1-material-diagnostics`、`nir1-material-roster` CLI                                                                             | diagnostic report                                                                | 既存root出力・golden・3 digest domains・未知recipe拒否を維持                                       | root replay golden、CLI DB bytes unchanged、default-build boundary                             | focused: root golden + TypeScript replay parity                                  |
| L2-01  | proposal-revision canonical読取                | 新しいconsumer-scoped reader                                                                  | `publish_runtime.rs`、`dependency_edges.rs`、`declaration_storage.rs`、`semantic_epoch.rs`、`incremental_freshness.rs`                     | backend eligibility                                                              | freshセルだけで許可しない。合法runless初期publishを許容し、Application専用readerをID代用しない     | complete edge set/current epoch/digests/evaluation/cursor、stale/unknown/pending拒否           | focused accepted: 17 tests + publisher regression 7 + independent review         |
| L2-02  | S2 query context / whole-material admission    | backend active workspaceとpersisted project/tree、製品A2/A3契約                               | `project_scope_authority.rs`、persisted mode、診断axis parityの再利用、typed state                                                         | historical-reference admission                                                   | S2をsource sceneへ置換しない。全story材料S1<S2、制御入力は許可された用途だけ                       | 同snapshot binding、各typed state、future/secret/exact mismatch、child control分類             | focused: admission15 + Source/context15 + statement1; independent review pending |
| L2-03  | live scheduling / canonical usability          | Native NIR Index runtime owner + canonical consumer owner                                     | explicit running/stopped/paused/restored/rebuild-pending capability、authority ID/generation/instance                                      | return直前のusable判定                                                           | saved freshやauthority IDだけではlivenessを推定しない。5秒cutover heartbeatをquery TTLへ流用しない | 各停止/回復journey、same-transaction suspension、return/click世代照合                          | planned: L3 runtime capability接続と実測待ち                                     |
| L3-01  | eligibility Source登録・digest                 | `source_revision.rs` + producer/source policy                                                 | `nir1-chronicle-eligibility-set`、project sorted current/revision/envelope/Human decision binding                                          | index D1 / canonical invalidation                                                | SourceとConsumerを区別。FreshnessをSourceへ重複保存しない                                          | 空roster、decision-only変更、child supersession、deterministic digest                          | planned                                                                          |
| L3-02  | project Index build / rebuild / publish        | shared `nir1-reviewed-chronicle-v1` producer                                                  | schema、sealed D1、metadata、vector identity、canonical index reader                                                                       | `nir1-reviewed-chronicle:v1` usable generation                                   | metadata key/generation/D1 digest一致。build直前snapshotとpublish CAS。partialはserve不可          | concurrent edits/revoke、failed build、model/serializer mismatch、stale revision+rebuilt index | planned                                                                          |
| L3-03  | source / decision / Scopeのtransaction内無効化 | §5 writer inventory                                                                           | Feed/protected writer/runtime publication、project index suspension                                                                        | old index/results/navigation取消                                                 | project全IR停止→exact Raw fallback。no-op評価で無限rebuildしない                                   | writerごとのmutation・rollback・race・no-op                                                    | unknown: 個別hook位置と全入口を閉じる                                            |
| L3-04  | restore / migration / cold startup             | `backup_restore.rs`、`restore_rebuild.rs`、`migrate.rs`                                       | workspace公開境界、registered producer allowlist                                                                                           | invalid index→rebuild                                                            | 復元cacheからauthority推定禁止。無関係producerのreserved境界維持                                   | 旧schema upgrade、restore中断、source欠落、cold rebuild                                        | planned                                                                          |
| L3-05  | renderer通知 / N-API async scope               | main/preload/event consumers、N-API active workspace                                          | generation/query identity、safe reason code                                                                                                | Related Scenes / Evidence将来経路                                                | full envelope/material rosterをrendererへ返さない。旧workspace応答を破棄                           | async source/project change、replaced request                                                  | unknown: L4担当と通知契約を固定                                                  |
| OUT-01 | MCP / Agentによる新規検索・新規承認endpoint    | shared backendの既存domain writers                                                            | 既存mutation authorityは維持                                                                                                               | 該当なし                                                                         | 初回Related Scenesに新しいMCP検索/承認権限を追加しない。既存source mutationはL3-03対象             | existing writer registry照合                                                                   | out of scope: 新規consumer追加                                                   |
| OUT-02 | Graph / Packing / 他recipe                     | 統合計画L6以降                                                                                | 今回L1–L3では実装しない                                                                                                                    | 将来lane                                                                         | 全体計画の要件として残す                                                                           | L6以降の別小候補                                                                               | out of scope: 現候補                                                             |

## 3. 最小L1候補の設計案

### 型と配置

現在の `material_roster.rs` は `nir1-material-diagnostics` feature内であり、reportに
`diagnostic_only` / `completion_scope` を持つ。製品はこのJSONを資格判定に使わない。
最小候補では、同じreplay実装を共有するprivateなtyped membership coreを設け、既存CLI wrapperはopt-inのままにする。
候補のファイル境界案は `material_membership.rs`、`material_membership/lineage.rs` と既存replay helpers。
新しい製品IPC、Index writer、schema migrationはこのL1候補に含めない。

返すbackend型は selected revision/root identity、検証済みlineage、story-source segments、typed control-source bindings、
completeness verdict/reasonを区別する。membership型には `searchEligible` / `approved` / `fresh` を設けない。
source本文や全authorityはrenderer wireにしない。診断wrapperは既存契約を明示して変換する。
既存rootのgolden/診断出力が変わらないことをcharacterizationで守る。

### 読取順序

1. 呼出側の一つのread transactionでselected revisionをproject/proposal/runへ束縛し、persisted envelope digest、
   `validate_reconciliation_envelope`、proposal payload digest、Evidence bindingを検証する。
2. `revisionBasis.kind=human-derived` をrootまでたどる。各edgeで同project/proposal/run、親revision番号の前進関係、
   expected parent envelope digest、parent assertion digest、root identity、Human actor/surface、adapter ID/versionを照合する。
   visited setでcycleを拒否し、未知derivationと欠けたancestorはcompleteにしない。
3. 実際のparent/child payload差分をCore classifierへ通し、記録されたchanged paths/derivation kindと一致させる。
   semantic coreとEvidence不変を検証し、projection-onlyはScope/materialも不変であることを確認する。
   ScopeOverrideは既存C2B contractで許されたScope/control差分だけとする。
4. childの inherited context entriesをparentのcontext entriesと照合する。`inheritedFromRevisionId`だけを根拠に
   caller-selectedな小さな集合を許可しない。child自身のScope-resolution entriesは別のtyped分類対象とする。
5. 各revisionのeffective material basisと永続SourceBasis、sealed D1、V1投影を照合する。
   `human_material_basis.rs` のprojection/validationを共有し、独立した緩いD1解釈を作らない。
   歴史的ancestorの現在Freshnessは要求しない。selected childの現在Source/FreshnessはL2で別途判定する。
6. 検証済みrootだけを既存request-seal replayへ渡す。限定recipe、必要receipt/accepted plan/artifact/window、
   未選択spanを含む全source segmentの検証はそのまま再利用する。
7. root story材料と各childのeffective material/control bindingを照合してclosureを確定する。
   非Scope依存/必要Source/Evidenceのdrop、未知のmodel-visible追加入力、未分類のcontrolはcompleteにしない。
   中間Scopeの履歴tokenは保存された来歴として保持し、選択childのactive controlをL2へ渡す。

`resolve_live_scope_override_authority` を読取時に呼んで古いchildを作り直す方法は使わない。
writerの現在authority再導出と、readerのimmutable lineage検証は責務が異なる。
読み取り結果をDBへ書かず、現存しない古いauthority payloadを捏造しない。

### Scope controlの分類

対象は既存C2Bの `project-scope-authority` source、`context:chronicle-scope-resolver`、
`dependency:scope-resolution` / `ScopeResolution` / `whole-source` の検証済み結合。
classの意味は統合計画A3どおりidentity/order/digestを資格判定だけに使うことであり、全project authorityへのstatic免除ではない。
既知のproject authority型・writer contractとsource identity/tokenを照合し、story-bearing payloadやmodel-visibleな新入力を
制御情報と付け替えない。新しい分類意味が必要ならintegratorへ差分提案する。

## 4. テスト機構と正規fixture生成案

### 最初の公開境界RED

- 新しいchild readerの公開されるRust境界で、cold DBのScopeOverride childがroot membershipとcontrol bindingを保持することを期待する。
- 現 reader は child の `revisionBasis` にroot用 `taskId/contextSetDigest/finalRequestDigest` を要求して失敗するため、
  root-only制約を示すREDを保存してから実装する。失敗理由を期待値に変えてpassさせない。
- projection-only child、scope→projection連鎖、scope→scope連鎖、historical parentがcurrentでなくても来歴検証できるpositive、
  別project/proposal/run、誤parent/root/digest、
  cycle、changed-path分類不一致、context欠落、Scope control欠落、D1/V1欠落、root未選択span欠落を含める。
- negativeは合成fixtureの使い捨てコピーだけを破損させる。正規positive DBや既存診断証跡は変更しない。
- SQL/I/O failureは通常のunavailable判定へ潰さずerror。全negativeで部分story rosterをcompleteにしない。
- membershipは非current revisionも検証できる。非currentを検索不可にする判定はL2 eligibilityで別に検証する。
- historical Scope更新positive: 正規project Scope writerでancestorのScope token/Freshnessを古くした後、正規ScopeOverrideで新current childを作り、membership completeを確認する。旧tokenは履歴に保持し、ancestorを再Fresh化しない。単にparentが非currentなcaseとは独立して実行する。
- selected child自身を正規source/Scope変更でstaleにした対caseでは、immutable membershipの検証結果とL2の検索不可を別々にassertする。membership検証で現在Freshnessを暗黙要求せず、completeから検索資格を推定しない。

### 正規product fixture

新規の `electron/scripts/nir1-reviewed-child-product-journey.mjs` を候補とする。既存
`product-journey-harness.mjs` / `chronicle-extraction-product-journey.mjs` のlaunch、UI selector、
review bundle helperを再利用し、診断Vite transformは使わない。

1. 新しいisolated workspaceに通常のtree writerでS1 folder/sourceと後続S2を作る。S1本文は既存合成Chronicle fixtureから開始できる。
2. 通常buildと既存local deterministic providerでS1 folderをUI抽出。initial revisionのsecret=trueとroot receiptsを記録する。
3. 各proposalを選択し `chronicle-proposal-secret-input` をoff。保存完了をNative bundleで待ち、current child / unreviewedを確認する。
4. UIからchildを明示承認。parent approvalでは許可されないことを別caseで確認する。
5. applicationを閉じ、別processから同workspaceを再開。child identity、decision、root receipts/artifactsが同じことを確認する。
6. 閉じたDBを新しい出力先へ保存し、DB/build/native/manifest hashと正規操作記録を台帳へ載せる。
   Rust readerはこのclosed copyをread-onlyで開き、実行前後のDB bytes不変を確認する。

この固定response providerは配線・状態遷移の証拠。L0/L4の実local embedding品質比較は別証跡であり、
新しい生成物を旧Adapter診断fixtureと呼ばない。保存済みDBへの直接DMLでchild/decision/sealsを作らない。
小さなRust contract fixtureは既存 `narrative_c2a_persistence.rs` / `narrative_nir0_c2b_material_basis.rs` の
Native writer helperを使えるが、それだけでstandard UI→cold positiveを代替しない。

### 初期focused gate案

L0封印と実装dispatch後、対象境界だけを先に検証する。まだ実行していない。

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --no-default-features --features nir1-material-diagnostics material_roster
cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --test narrative_c2a_persistence --test narrative_nir0_c2b_material_basis
```

新readerのtest target/command、default-build diagnostic boundary、product journey registrationはRED着手時に固定する。
L1のRust/compiler/journey focused passはP1受入れやQuick/Fullを代替しない。完成候補のgateは統合計画に従う。

## 5. L2/L3で閉じるwriter・canonical・Index binding

| 項目                                                 | 現在確認したowner                                                                                                             | 実装前に固定するbinding / acceptance                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| root/append revision                                 | `repository.rs:insert_proposal_seed` / `append_revision_on_conn`                                                              | current roster更新とIndex無効化の同一transaction。CAS rollbackで部分公開なし                                                                   |
| child promotion                                      | `human_materialization.rs:create_human_derived_revision_with_c2b_projection_materialization_in_tx`                            | repository外のcurrent pointer writerも同じhook。standalone C2A childはcurrentを変えず、rosterへ入れない                                        |
| Human/automated decision、combined revise-and-decide | `repository.rs:append_decision_on_conn`、trusted actor別入口                                                                  | actor/authority bindingとlatest decisionの決定順を共通化。Human approval以外を許可へ昇格しない                                                 |
| source forward/undo/redo/import                      | `domain_writes.rs`、`commit.rs`、`undo.rs`、各domain helpers、`change-feed-writers.json`                                      | scene本文/削除/archive/order/mode/Scope controlに関係する全source addressとwriter一覧。対象外は理由付き                                        |
| canonical publication                                | `publish_runtime.rs:publish_complete_runless_freshness_in_tx`、`incremental_freshness.rs`                                     | epoch、complete edge set、producer generation、D1対material、V1 source-identity-set digest、source token、cursor/pendingの各domainを区別       |
| restore/deletion                                     | `backup_restore.rs`、`restore_rebuild.rs`、`domain_writes.rs:project_delete`                                                  | restored workspace公開前のsuspension、project削除後のrebuild禁止、未知producer reserved維持                                                    |
| semantic-index registry                              | `narrative-consumer-contract.json`、`narrative-dependency-producer-registry.json`、`semantic-core-authorities.json`と各schema | A4の一producerだけdeclared化。4面ゼロを要求する既存verify規則をallowlisted producer/generation整合規則へ協調更新                               |
| metadata                                             | `migrate.rs:narrative_semantic_index_metadata`、`semantic_index_diagnostics.rs`                                               | 現在は5 cache fields+project/index key。承認済みproducer/model/serializer identityをどのtyped cache rowへ置くか固定しmigration/restoreと揃える |
| query/publish race                                   | shared Index producer、future typed query                                                                                     | build開始snapshotのepoch/eligibility/dependency/serializer/modelをpublish CASで再確認。commit後の旧generation返却禁止                          |

追加Sourceのdigestにcanonical Freshnessを再格納して循環依存を作らない。
Indexにはrevisionの実source依存とeligibilityを登録し、non-Evidence材料も既存revision評価から脱落させない。
評価済みrowの非意味的timestamp更新だけで無限suspend/rebuildしないことをno-op testで固定する。

## 6. 次のdispatchまでに残す情報

この技術調査時点で新しいpolicy意味や保存範囲拡張の必要性は確定していない。
L1は既存root recipeと既存C2B child semanticsの読取へ限定できる見込み。
Scope controlの具体的分類、child chainのhistorical D1検証、独立root/core移動のAPI形状は小候補のRED前にintegratorと確認する。
これは承認済み作業内の技術調整であり、ユーザーへの診断単位の再開確認ではない。

L0固定後の最初の候補: **通常UIの非秘密化childをcold readerで完全にたどる**。
L2 canonical/admissionとL3 Indexはそのfocused結果を受けて別候補へ進める。

## 7. L1準備: 正規UI child fixtureの実測

2026-09-08。`electron/scripts/nir1-reviewed-child-product-journey.mjs` と検証helper/testを追加し、
既存runtimeの標準 `pnpm napi:build` → `pnpm electron:build` を両方exit 0で完了した。
ビルド前後のtracked source manifestと、fixture実行前後のsource/build artifact hashは一致した。
L1 membership readerのruntime変更、L2資格判定、検索品質受入れはまだ行っていない。

- evidence directory: `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/l1-normal-child/`
- build receipt: `build-20260908/build.json`。新規tree writer seed: `seed-20260908/`。
- 成功run: `run-20260908-3/fixture.json`。cold DB SHA-256: `57a4911287359a9c2ffb975c659ee1884009144d2c9e28fdbfaa18a8e3606567`。
- 2 proposalsともS1だけの標準抽出でsecret=trueのrootを生成。S2 sentinelはsnapshot/request artifactsに存在しない。
- 通常review UI clickでsecret=falseの別Human ScopeOverride childを生成。`unreviewed`・Decisionなしを確認してから、各current childへ明示Human承認。
- child Scopeは`exact(S1)`を保持し、audience/readingOrder/storyTimeは`any`。core digest/Evidenceは同一、Scope/assertion digestは変更。
- 別processのcold reopenでchild/Decision、immutable root/child envelope、stage receipts/artifactsを一致確認。元seed DB hashも保持。
- helper testは5/5。独立したread-only helper reviewerのScope検証不足1件をRED→GREENで修正し、再確認で追加指摘なし。
- run-1のpath末尾正規化エラー、run-2のPlaywright同期`uncheck()`とNative非同期保存の競合はログを保持。通常`click()`後にNativeとUIの完了を待つrunnerへ修正した。

この実測のlocal deterministic providerは状態遷移の配線確認である。実行時のembedding取得/Related Scenes fallback警告は別途残っており、
このfixtureから検索品質、現在のmembership complete、canonical Freshness、検索資格、scheduler livenessの成功を推定しない。

## 8. L1 membership と L2 canonical の focused 実装

L1は `read_revision_material_membership` の共有typed readerを追加し、root replayと各childのimmutable
payload/lineage/effective material/source basis/D1/V1を結合した。currentness・approval・live token comparisonを
membershipへ混入させない。Native current childをsource/Scope変更後にstaleへ更新した対caseでもmembershipはcompleteを保つ。

- L1 focused suite: 15/15。root replay Rust golden 4/4、TypeScript replay parity 1/1。
- L1 manifest: `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/l1-membership/l1-source-evidence-coverage-2.json`
  SHA256 `3b3cbb32cc470705238c73b3cefd0fd4dbd761c8ddf059630c591fa1fcd8a5e7`。独立レビューでhash・coverageを確認済み。
- L2 canonical focused suite: 17/17。既存Application canonical publisher回帰: 7/7。
- L2 manifest: `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/l2-eligibility/l2-canonical-source-evidence.json`
  SHA256 `fb4a27dbf517921419213c65fbd6b7e96b24b18dcf7a0982a3cc092be51acf03`。9 source/test filesの独立レビューを通過。whole admission用の追加exportは次のsnapshotに束縛する。

L2 canonicalは合法runless/current Epoch/all-edge stateとsealed pending Feedを確認する。詳細は
[nir1-canonical-reader-mapping.md](nir1-canonical-reader-mapping.md)。Native transactionと全eventの双方が消された
状態はaudit-only gapだけでは検出できないため、L3で全writerの同一transaction hookとrollback証拠を必須とする。
whole admissionは31-case focused suiteを通過し独立レビュー待ち。runtime capability・Index・Related Scenes・品質/性能/回復の製品受入れは未完である。

### L2 whole admission / Raw Source / query context

`retrieval_admission.rs` とprivate modulesはcurrent revisionのown Human approval、L1 membership一回、
static二contract・限定Scope control、全story材料のreading-before-S2、候補Scope、共有canonical evaluatorを同じread transactionで結合する。
immutable statementはsummary→actuality→attribution→narrativeFrameの四つのstringだけを順序固定JSONへ変換する。
元のowning Runをsnapshotへ保持し、D000001 / anchor-0001等のRun内aliasをglobal Scene IDとして扱わない。

`read_retrieval_scene_source` はsame-projectの実在Scene本文をRaw query用に読み、IRの対応axisやarchive状態によってRawを止めない。
`read_retrieval_query_context` はIR用にlive tree/ScopeとA2のtyped stateを検証する。saved_content_jsonとcanonical_source_textはNative-onlyで、
既存Raw queryのJS conversion/trim/末尾500 UTF16はL0 adapterが前者から同一規則で導出する。後者をRaw queryへ代用しない。
S2 source token/version、storage/canonical digest、normalizer、canonical UTF16長とScope authorityを同一snapshotへ束縛する。

focus: admission15/15、Source/context15/15、ordered statement1/1、shared ADR002 parity1/1。正規24 cold fixtureの336 childrenと
別100-current cold fixtureについてowning Run/envelope/own Decisionを照合し全件Eligible、DB bytes不変を診断確認した。
これは検索ranking品質、Index、runtime、latency/recoveryの受入れではない。

## 9. L3–L5の現在地（2026-09-08）

L3はschema35、登録Source/producer、atomic Index publish、実loaded model/auditへ束縛したvector再利用、
Native workspace/query/世代capabilityと同transaction無効化を実装した。writer照合は
[nir1-index-writer-inventory.md](nir1-index-writer-inventory.md) に129操作と内部publisherを記録する。
同一のimmutable proofとS2に束縛したときだけ返却前の重複検証をまとめ、別query・別世代への資格流用は拒否する。

L4はRawと同じ保存本文・query embeddingを使うNative IPC、admission後のscene fusion、deadline、
失効通知とquery解放後も存続するIndex maintenanceを実装した。L0のGold/floor/fusion/deadlineは変更していない。

L5はRelated Scenesの承認/Freshness表示、元のS2を保持するEvidence identity、click/エディタ適用の二段検証を実装した。
標準Electron UIのcold saved childからS2検索→S1の根拠全文287文字を選択するfocused journeyが通過した。
表示excerptの180文字だけを使わず、実Nativeの再検証が2回実行された。

24問×各arm720回の最初の比較結果は **Hold**。Raw/IR比較中のRaw fallback一致・必須本文保持・Evidence再検証は通過、
combined cold build medianは3,717.8msで固定上限4,289.4ms以内。品質は改善caseなし、英語1問のnDCG低下を確認した。
Hybrid p95は78.2ms（固定上限65.04ms）、IR待機切れ320/720（44.44%）で性能条件も未達だった。
この候補の証跡は `l4-paired-formal-2/receipt.json`。重複検証の修正後は別candidateとして再測定する。

100-current workspaceのqueryをすべて解放してからDecisionを保留へ変えた診断では、追加query/reconcileなしで
index-readyを約1.53秒、資格を再確認するqueryを約1.56秒で確認した。ただし固定queryのIR結果は0件であり、
全mutation class×100回の性能条件やnew-approvalの発見を通過した証跡ではない。

ユーザーの後続指示により作業はprimaryのみ。以前の独立reviewは元のsnapshotの範囲で保持し、
以後の自己検証を独立受入れと呼ばない。L5/P1完了、Quick/Full、PR公開はまだ成立していない。
L6–L9は統合計画に保持し、この変更へ混ぜない。

重複検証を修正した標準build6の再測定 `l4-paired-formal-3/receipt.json` では、
Hybrid p95 48.2ms、IR timeout 7/720（0.9722%）、combined build median 3,483.7msで
固定性能条件を通過した。品質はnDCG 0.891998→0.888629、改善case0のため引き続きHold。
詳細・残る受入れ・A5の未承認の見直し範囲は
[nir1-l5-quality-hold.md](nir1-l5-quality-hold.md) に記録する。

## 2026-09-08 A5候補2の承認後・実装前差分

ユーザー確認済みの差分は [候補2](nir1-a5-candidate-2.md)。脅威モデル `nir1-product-tm/1` の主体・境界は維持する。

| 層                   | 変更                                                                                                      | 維持・focused gate                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Native IR scoring    | 四項目JSONを維持し、IR専用floorをja=0.813/en=0.660へ別policy版で固定                                      | admission前top-K禁止、scene-max/tie/top8、finite境界・unsupported language拒否    |
| renderer融合・表示型 | Raw全順位と各rowを保持、共有IRを添え、最上位IR-onlyを空きがある場合1件だけ追加。RRF scoreを表示型から除去 | exact Raw fallback、Raw8件を減らさない、空Rawでも最大1件、opaque Evidence binding |
| 評価・証跡           | 旧manifest/Gold/予算のhashを維持、追加policyを別hashでbuildと比較receiptへ束縛                            | policy source drift拒否、旧receipt流用禁止、実Electron720call/arm＋5build再測定   |
| 復旧fixture          | 100件の元workloadを保持し、確認済み正例queryだけ別版overlayで固定                                         | 100独立trial/class、COMMIT ack起点、既定terminal、p95 2秒、旧失敗分母を保持       |

本体担当のみというユーザー指定に従う。これらのfocused gateや本体自己点検を独立受入れと呼ばない。

### 100-current UI deadline の因果調査と修正範囲

build9 の24問比較は品質・固定性能条件を通過したが、別の100-current正例UIでは最初のIR表示が待機期限に達した。
mutation前の失敗を `l5-recovery-electron-preflight-1/2` に保持し、Fullや500試行へ進む前に修正する。
計測では同じ照会のcanonical確認を複数回行い、各確認のD1/Source/Edge処理が約7〜12msを占めた。

| 層 | 修正対象 | 維持する証明・focused gate |
| --- | --- | --- |
| 共有DBのD1 reader | 同じ読み取り内で完全一致するselectorの検証計算を一度にまとめる | 全entry/set/head検証・digestを保持。異なるrole/key/digest、破損entryの拒否 |
| 共有DBのSource resolver | 同じSQLのprepareを接続内で再利用 | 毎回のSELECTと現在token照合、SQLエラー、欠落・project不一致を保持 |
| Native IR projection | admission済み全scoreを検査・順位決定後、表示する最大8sceneだけJSON/title/navigationへ展開 | admission前limit禁止、同じscene-max/tie順、返却前canonical確認・Evidence再検証 |

永続DB状態に対する資格判定cacheは追加しない。policy/authority/recipe/受入れ条件は変更しない。
修正後は新標準buildで100-current実UIのfocused検証を先行し、その後に24問比較を再実行する。

追加計測 `l5-ir-profile-2` と実UI `l5-recovery-electron-preflight-3` でも期限超過を確認した。
同一snapshot内の小さな最適化だけでは足りないため、次段では既存private IndexProofに最後の完全検証済みDB状態を保持する。
既存 `SqliteSourceRevision` の接続epoch・total_changes・data_versionにmain/temp schema・user_versionを束縛し、
SQLiteのREAD transactionでのみ保存・再利用する。WRITE transactionの結果はrollback後へ流用しない。
変更時は全canonical検証、毎回のruntime世代・owner・S2・Evidence検証を維持し、永続行やIPCに資格を新設しない。
別接続COMMIT、古いread snapshot、write/savepoint rollback、schema変更、runtime切替をfocused gateに加える。
SQLite状態の根拠: https://www.sqlite.org/c3ref/c_txn_none.html および https://www.sqlite.org/pragma.html#pragma_data_version 。

### 2026-09-08: 復旧preflightで確認した旧rosterのFeed待機

build 11で100件の承認撤回は製品fetch+Evidenceまで1.694秒、新childの通常UI明示承認はmain clockで1.741秒だった。
本文編集は3.549秒で、1.633秒と3.456秒の二度Index-ready通知を観測した。
旧poolの編集されたSourceが次poolから先に除外されるため、次poolだけのpending確認ではそのSourceの未処理Feedを見落とし、
canonical処理の前後で二度構築していた。旧poolの完全な登録済みDependency Edgeに対しても既存pending readerを先に実行する。
これはbuild schedulingの追加precheckであり、現在poolのL1/L2・publication CAS・query qualificationは維持する。

正常なNative source writerでこの状態を作る回帰テストは修正前に失敗し、修正後のIndex 38件は成功した。
テストではpending中に新generationを発行せず、通常canonical処理後に一度だけ正しく除外したgenerationを発行することを確認した。
標準build 12はNative/Electronとも成功し、build前後のsource一致を確認した。品質契約チェックも成功した。
同じ本文編集の実Electron再測定は2.271秒、Index-readyは一度、generation=2、残り99 vector、旧Evidence失効だった。
二重再構築は解消したが、2秒条件は未達。正式100試行は未実施で、build 11のfocused時間も新候補へ流用しない。

読書順変更では既存C2Bの全project Scope authority tokenが変わり、100 current childがすべてstaleになった。
この契約変更は[別のdraft](nir1-scope-dependency-revision-draft.md)として明示確認待ちにした。
本体担当のみの診断であり、独立受入れや正式100試行の合格とは扱わない。

## Scope dependency delta /1 (approved 2026-09-08)

| Flow | Owner / contract | Boundary and sink | Preserved invariant / compatibility | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| New ScopeOverride | Native live Scope projection /1 | sealed Run reference → current tree authority → effective material/sourceBasis → D1/V1 | Replace Scope-only dependencies; retain Evidence and non-Scope roles; new producer generation | C2B normal-operation cases, role collision, atomic CAS | planned |
| Legacy parent and projection-only | Existing material contract + producer generation | stored parent → exact material validation → inherited child | Read legacy without rewriting; projection-only inherits parent contract | old/new coexistence, title/note inheritance | planned |
| Canonical current Source resolution | Native source registry | versioned key → sealed Run/project binding → same-snapshot live projection | No historical success fallback; absent/archived/ambiguous references unavailable | deletion/archive/membership/story ambiguity | planned |
| Canonical Feed selection | Native tree/Feed + incremental freshness | conservatively select bound projection Sources → resolve current token → evaluate edge | Notification breadth independent of stale decision; preserve query context invalidation | unrelated order invariance and source001 crossing S2 | planned |
| Retrieval and lineage | material_membership + disclosure + Index publication | legacy/new control validation → whole-material eligibility → sealed generation → query/UI/navigation | Current whole-material disclosure and each child's Decision remain required | exact remaining roster identities, actual Electron query/UI | planned |
| Restore / rollback / undo / races | existing transaction and recovery owners | versioned source inference, canonical re-evaluation and publication CAS | No partial material/D1/pointer or old permission resurrection | recovery matrix and normal-operation fixtures | planned |
| IPC / model / root replay recipe | existing interfaces | no new renderer verdict or model authority; one-window root recipe unchanged | Two-window recipe expansion outside approved delta | existing boundary tests | out of scope: no wire or recipe expansion |

Performance reuses live authority only within one SQLite snapshot if measured useful. Standard build 12 source-edit focused result (2.2714s) remains a HOLD and cannot serve as formal evidence for this delta. All prior fixtures and receipts are retained.

### Scope delta implementation checkpoint

New source `scope-dependency-projection-v1` uses canonical versioned identity encoding and Native sealed-Run verification. Pure Core projection omits aggregate revisions and unused ranks for non-secret Scope; secret projection includes reveal reading rank and the full resolved/unresolved story value. Missing current references are unavailable Source states, not historical-token fallbacks.
The shared material producer retains ID `proposal-revision-source-basis`, reads legacy generation 1, and pins generation 2 to material containing the new versioned Source. Projection-only retains its parent's basis and therefore generation. Index candidate checks use the same version selector.
Feed selection remains broad for Scope changes; each selected projection is independently resolved. Pending query qualification separately blocks any bound new projection until relevant Feed is processed. Current-context invalidation remains unchanged.
Focused evidence: `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/l5-scope-dependency-focused-1/report.json`. Core invariance/ambiguity tests, C2B atomic writer tests, cold legacy/new membership, canonical eligibility/admission and producer-registry tests passed. Added actual tree-writer/Feed checks cover non-secret reuse, archive rejection, and secret ambiguity introduced by a different Scene. These tests do not establish UI/performance acceptance. Standard build 13 and fresh normal-operation fixtures are next.

### Measured extraction lookup indexes (internal recovery repair)

A read-only release diagnostic of the exact 100-current recovery database measured snapshot replay at 1.55s, including 0.54s in the six accepted-artifact lookups per revision. `EXPLAIN QUERY PLAN` showed scans of Attempts and Artifacts. On a disposable copy, three non-unique lookup indexes reduced identical snapshot replay to 0.68s; all three runs still admitted the same expected count of 99. This is a causal diagnostic, not the fixed 2s UI or formal recovery acceptance. Original fixture and diagnostic instrumentation/restoration receipts are retained under `l5-rebuild-profile-1`, `l5-rebuild-profile-2`, and `l5-rebuild-index-ab-1`.

| Flow | Owner | Change and invariant | Required check |
| --- | --- | --- | --- |
| Accepted Task/Attempt/Artifact reads | SQLite migration | Non-unique indexes on existing lookup keys; identical SELECT and validation semantics, no new authority or stored decisions | current-schema repair, old-schema convergence, original history preservation |
| Schema checkpoint | Core physical schema reader | Missing or malformed indexes trigger the existing idempotent migration; healthy open remains read-only | malformed index repair and second-open no-op |
| Standard Electron recovery | existing runtime | Same whole-material replay and pending/publication guards; no authority caching | new standard build, exact qualified roster, actual query/UI, fixed 2000ms limit |

The new lookup indexes belong to the unpublished schema-35 candidate. They do not expand the root replay recipe or change the approved Scope projection contract.

### Query profile and bounded same-snapshot Source evaluation

Standard build 15 passed the focused schema/Index/lint/quality gates. Its reading-order UI preflights 2–4 stopped before the mutation timer: initial UI IR requests sometimes exceeded the unchanged additional-wait deadline (one driver also hit a virtual-list locator timeout). These receipts are failures, not recovery measurements. A temporary instrumented N-API diagnostic, with source and standard binary restored afterward, measured full query proof checks at 130–160ms. Three sequential query segments each loaded the project Scope authority about 100 times, accounting for about 90ms. Sealed Run binding checks remained about 25ms per 100 inputs. Receipts: `l5-query-profile-2/{summary,query-segments,report}.json`; diagnostic only.

The approved same-SQLite-snapshot reuse is now applied to a bounded edge-evaluation call in query currentness, rebuild publication guards, and publication observations. The batch owns its temporary live authority; it cannot return or retain that authority. Every edge still uses its original owning Run, sealed document binding, current reference validation, read-set token and evaluator. Separate calls—including after writes, rollback, or another snapshot—load authority again. No currentness cache is introduced across changed snapshots; the existing committed-state proof guard and query denominator remain unchanged.

### Measured complete Freshness publication batch

Standard build 16 restored the exact remaining 99 revisions after reading-order change, with old DOM IR removed in 10.4ms, but the actual qualified recovery endpoint was 3438.2ms (fixed 2000ms HOLD). Instrumented recovery profiles 1 and 2 preserve source/binary restoration and the complete UI operation. Profile 2 places about 0.83s in repeated registration verification inside a 0.875s complete runless publication; audit-chain validation is about 56ms and embedding reuse about 4ms. Timers are nested diagnostics, not acceptance receipts.

| Flow | Owner | Change and invariant | Required check |
| --- | --- | --- | --- |
| Complete runless Edge State publication | existing Publish Runtime | Verify target registration, current project-owned epoch, exact stored Consumer Edge ID set and non-empty inputs before the private row loop; avoid repeating the same registration for each row | reject missing, duplicate, foreign and extra edges, invalid registration and foreign epoch before any row write |
| Individual Edge State writer | existing Publish Runtime | Keep individual ownership/target/epoch validation; share only the private SQL and per-row invalidation implementation | existing publisher tests, NIR1 publication and invalidation tests |
| Batch validity | caller transaction | No capability escapes or is cached; the loop writes Edge State only and retains each row's invalidation; D1/Edge identity/epoch are not mutated by the loop | exact committed canonical result and standard UI recovery |

This is an internal implementation of the approved canonical publication contract; actors, defenses, whole-set acceptance, Scope projection and the 2s threshold remain unchanged.

### Native invalidation wakes the existing Freshness scheduler

Standard build 17 reduced the exact reading-order recovery endpoint to 2458.7ms (new UI 2767.9ms), still a HOLD. A transparent external wrapper around the unchanged Native `runNarrativeFreshnessCycle` correlated mutation and scheduler timestamps in the same main-process clock: the cycle started 831.9ms after mutation acknowledgement. Its end-to-end duration also includes DB contention with rebuilding, so it is not attributed entirely to Feed evaluation. Receipt: `l5-recovery-freshness-timing-1/report.json`.

| Flow | Owner | Change and invariant | Required check |
| --- | --- | --- | --- |
| Existing `related-scenes:invalidated` event | Native event bus → main scheduler | Only the already validated Native event requests a coalesced early cycle; no new renderer event, IPC, project selector or Freshness verdict | invalid payload and unrelated event ignored; renderer cannot originate backend event |
| Scheduled and in-flight cycles | existing main Freshness scheduler | Replace idle timer with one early wake; if a cycle is running retain one follow-up and never overlap Native cycles | idle and in-flight coalescing, stopped/disposed behavior, unchanged polling fallback |
| Quiescence observation | existing scheduler receipt owner | Pending wake invalidates the previous idle observation and prevents a next-cycle guard until consumed | no false quiescence during pending wake; full runtime gates remain required |

Native still independently discovers and evaluates the current database, and all existing pending/publication guards remain mandatory. This scheduling change introduces no new trust actor or permission and does not relax recovery acceptance.

## Approved two-window replay delta / 1

User explicitly approved `nir1-two-window-recipe-delta/1`. The existing Native verifier / verified canonical authority remain the authority; renderer, model outputs and persisted claims are not independently trusted. The approved scope adds two-window root replay, normal fixtures, regression and changed-candidate product verification. Repair, nonidentity merge, unknown recipes, three-or-more windows, external transmission and persistence-format changes remain outside this delta. Existing seals, effective material, single-window evidence, Gold, floor, fusion, B/D/T and recovery conditions are preserved.

A reader must not shrink sealed effective material to the windows selected by synthesis. All materials of every necessary request, including unselected windows/spans/context, are retained. Same-Run-only inputs are distinguished by necessary-request and effective-declaration binding, not by proximity or an inferred relevance filter.

| Path | Owner / change | Required invariant and proof |
| --- | --- | --- |
| Root membership | shared DB material_membership_root + material_roster/replay/segments | Accepted Task/Attempt, full necessary request roster, all three original seals, sealed effective declarations; single-window compatibility; missing/ambiguous/inconsistent input never produces smaller complete roster |
| Normal extraction fixture | Existing Chronicle planner/provider and production persistence | Independent TS-produced requests and original persisted seals; actual two-window dependency, including unselected material, rather than hand-authored DB authority |
| Child / canonical / disclosure | Existing typed membership, C2B and current canonical readers | No effective-basis pruning. Future move preserves membership/approval/canonical qualification and causes material-disclosure refusal; demonstrate actual retrieval before move |
| Mixed control / product | Fixed mixed-future-material corpus + actual production query/Evidence | Same post-move Raw/context, allowed candidate remains usable, identity/rank/score/slot/excerpt invariance against allowed-only control |
| Candidate validation | Formal quality/performance/recovery + Quick/verify | New candidate evidence replaces affected receipts; stopped campaigns preserved; no threshold or denominator change |

Two-window replay and its independent TypeScript / Native focused regressions pass. Changed-candidate product verification remains pending. The separate formal recovery UI failure is unattributed until causal evidence is obtained; the null-UI measurement crash is a confirmed harness failure. Neither is counted as successful acceptance.

The normal two-window product preflight exposed a missing integration in the already-approved Scope dependency delta: project Verify treated the new Run-bound Source as Run-independent, passed an empty Run ID, and reported both valid Scope Sources missing. Fix the Verify/rebuild scope selector to pass only the persisted owner that matches the canonical embedded project/Run identity; absent or mismatched provenance remains unresolvable. No canonical marker is written by a fixture shortcut. Normal Verify and scheduler cutover must establish canonical authority before product admission is measured. Regression evidence covers the original false missing-Source result, valid normal Sources, and missing / other-Run owners.
