# NIR-1 D2b 履歴 authority adapter 提案（draft）

更新日: 2026-09-23

| 項目 | 値 |
|---|---|
| 状態 | 設計下書き。脅威モデル／追加差分は未批准。実装・製品統合・送信を許可しない |
| draftRef | `nir1-d2b-history-authority-proposal/1` |
| 提案contractId | `history-authority-adapter`、`post-b-history-scope-axes`、`history-input-classification`、`artifact-producer-lineage` |
| 引き継ぐconfirmedRef | `nir1-l6-l9-contract-proposal/3#history-reauthorization`、`nir1-l6-l9-contract-proposal/3#native-generation-receipt`。同じscopeを再批准しない |

## 現在の判定

履歴Gateはfail-closedのままにする。pure adapterには9軸を持つ`HistoryTuple`型があるが、DB adapterは現在の各attemptを`tuple: None`として返すため、保存digestだけで過去turnを現在資格へ昇格できない。生成Messageの祖先は同一snapshotのMessageVersion・parent attempt・terminal receiptから追える。Artifactは現在のartifact ID／payload digestしか読めず、producer attempt／receiptは常に`None`なので、その枝は履歴候補から外す。[`nir1_generation_history.rs:120-156,1088-1111`](../../src-tauri/crates/grimodex-db/src/nir1_generation_history.rs) [`nir1_generation.rs:301-312,1382-1456`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs)

この文書は、新しいauthority、schema、consumer、product route、provider、送信権を作成済みとは扱わない。Graph由来の履歴はcurrent sealed Index readerが接続されるまで対象外であり、C-queryを先取りしない。human messageの既存direct-binding経路も、旧・import・restore・display-only履歴を昇格させない。

## 契約境界

確認済み`history-reauthorization`行は、turnごとの`Source`／`Revision`／`Decision`／`Freshness`／`Index`、purpose／input-use／send classification、parent artifact／generation receipt、および`readingOrder`／`storyTime`／`viewpoint`／`knowledgeHolder`／`audience`／`timeline`／`worldline`／`narrativeLayer`／`scene`を要求する。保存tupleは比較anchorに限り、毎turn current authorityで照合する。stale／unknown dependencyはそのchildと全descendantを除き、restore／undoで資格を戻さない。[`nir1-l6-l9-execution-plan.md#history-reauthorization`](nir1-l6-l9-execution-plan.md#history-reauthorization)

post-B §10はさらに`auto`／`phase`／`reveal`も毎turn照合すると記載する。[`nir1-post-b-execution-plan.md:288-312`](nir1-post-b-execution-plan.md) これらは確認済みproposal/3の履歴tupleにある9軸とは別枠で扱う。現在のコードで同等なcurrent query値が揃っていないため、既存のphase/reveal tokenを別軸の値と同一視せず、history gateを通す代替にも使わない。§10の追加軸をconfirmed history contractの必須差分として実装する場合は、差分の明示確認を要する。

post-B §8はD1共通snapshot・候補一括Packing・共有read budgetを要求し、selector budgetとsystem／history／user／context／format／response reserveを含むfinal-request budgetを分ける。[`nir1-post-b-execution-plan.md:208-222`](nir1-post-b-execution-plan.md) §9はD2b-1に最終request後の入力来歴writerを割り当て、payload digestで依存辺を代用しない。[`nir1-post-b-execution-plan.md:224-241`](nir1-post-b-execution-plan.md)

## 現在のsourceと不足

| フィールド／資格 | 現在のtrusted source | 判定 |
|---|---|---|
| project／session／profile／caller epoch／workspace binding／purpose | Native `AttemptBinding`にproject、session、profile、caller、epoch、workspace binding、`Writing`／`Review` purposeがある。Native final coordinatorは非wire型だが、現在はproduction routeから未接続 | 基本identityと粗いpurposeは存在。履歴用tupleとして永続化されず、rendererやcoordinator supplied digestをcurrent authorityにしない。[`nir1_generation.rs:102-130`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs) [`electron/native/grimodex-node/src/nir1_generation.rs:27-48`](../../electron/native/grimodex-node/src/nir1_generation.rs) |
| `Source`／`Revision`／`Decision`／`Freshness` | exact A2 Revision readerはbundle、material basis、live Source、canonical Freshness、Native-only Decisionを確認する。A3 disclosure readerはそのexact Revisionを入口にDecision/Freshnessを再確認する | trusted readerは存在するがhistory snapshot adapterからまだ呼ばれない。Opaque qualification identity/versionだけではcurrent性を証明しない。[`nir1_entity_relation.rs:132-151,1629-1639,2114-2154`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation.rs) |
| `Scope`／scene／`readingOrder`／holder／audience／Timeline／Worldline／layer | A3 query contextはcurrent query scene、reading-order ref、project Scope authorityを読み、scene Scopeのsource token／incarnation／bindingを保持する。明示Scopeならholder／audience／timeline／worldline／layerを返す | same-snapshot current sourceはあるがhistory adapter未接続。LegacyAbsentのfallbackやUnknown／unresolvedを完全なtupleとして扱わない。[`query_context.rs:120-205`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/query_context.rs) [`narrative_scene_scope.rs:82-97`](../../src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs) |
| `storyTime` | query contextは`Unavailable(initial-reading-profile)`を返す | current値なし。欠落を埋めず履歴candidateをunavailableにする。[`query_context.rs:193-196`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/query_context.rs) |
| `viewpoint` | query contextは`NotApplicable(reader-reference-purpose)`を返す | typed N/A stateは存在するが、confirmed history tupleにこのN/Aが適格値かを示すmappingはない。明示されたcontract mappingがない限りcomplete扱いしない。[`query_context.rs:185-188`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/query_context.rs) |
| `auto`／`phase`／`reveal` | per-material `ScopeBinding`にreading／story／auto／phase／reveal／povがある。A3にも`phase_resolution_mode`／`reveal_state_token`がある | per-material bindingはcurrent turn Scopeではない。phase-resolution modeやreveal-state tokenをphase/reveal値と同一視しない。query `auto`のcurrent sourceも確認できない。[`narrative_nir1.rs:147-155`](../../src-tauri/crates/grimodex-core/src/narrative_nir1.rs) [`query_context.rs:181-200`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/query_context.rs) |
| `Index` | A2 Revisionに`eligibility_source`／`index_key` identityはある | sealed current Graph Index generation/Decision/Freshness readerはこのadapter pathにない。Index key identityだけではcurrent `Index` qualificationを満たさない。GraphEvidenceはC-query接続までunavailable。 |
| `D1` selection／budget | Native Packingはselected itemとauthority bindingを返す。pure selectorはselected/omitted IDsとused/remaining token数を返す | 同一snapshotのin-tx helperは存在するが`pub(super)`で、public wrapperは独自transactionを開く。選択結果・selector budgetを保存tupleへ橋渡す同一snapshot adapterがない。D1 budgetはfinal-request budgetではない。[`nir1_packing.rs:266-287,1057-1109,1188-1211`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_packing.rs) [`narrative_nir1.rs:1140-1154`](../../src-tauri/crates/grimodex-core/src/narrative_nir1.rs) |
| purpose／input-use／send classification | `GenerationPurpose::{Writing,Review}`と別の`PackingPurpose`がある。`InputRole`はsystem/user/assistant/contextというprompt位置 | confirmed history rowのinput-use／send classificationを供給するtyped current source／allowlistはこのNIR1 generation pathにない。`InputRole`、PackingPurpose、route labelから推定しない。 |
| Envelope／receipt／Message parent | `StoredAttempt`にbinding、direct inputs、qualifications、terminal receiptがあり、`MessageVersion`にimmutable parent attempt/body digestがある。同一snapshot readerがtyped Message／terminalを読む | Message ancestryのstorage sourceはある。confirmed Envelope/current-turn tuple readerとの対応は未接続。既存attempt/terminal receiptを別のEnvelope authorityと無断で同一視しない。[`nir1_generation.rs:327-358,388-398,1199-1212`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs) |
| Artifact producer attempt／receipt | typed `GenerationHistoryArtifact`にoptional fieldはある | current artifact readerは両方を`None`で返す。artifact row／run_id／payload digest／session／display stateからproducer receiptを推定しない。[`nir1_generation.rs:301-312,1382-1456`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs) |

History inputごとの7 qualification kind（`Source`／`Revision`／`Decision`／`Freshness`／`Index`／`Scope`／`D1`）をexactly onceで要求するpure checkと`QualificationReference` shapeはあるが、stored opaque refをcurrent authorityへ結び付けるvalidatorがない。これは現在の保守的な構造検査であり、すべての非Graph入力にもsealed Graph Indexを要求する契約mappingの証明ではない。confirmed history rowの`Index`は維持しつつ、非Graph入力に対するcurrent authority／typed N/Aの正本mappingは未解決とする。GraphがないことからN/Aを創作したり、逆にhuman／Rawへ新しいGraph依存を課したりせず、解決まではfail-closedを維持する。欠落・重複・unknown・target mismatchはincompleteのままとする。[`nir1_generation_history.rs:40-79`](../../src-tauri/crates/grimodex-db/src/nir1_generation_history.rs) [`nir1_generation.rs:179-201`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs)

## 最小adapter案

### 1. D2b-1 writerがattemptにtupleを固定する

新しいtableより、既存attemptのimmutable `binding_json`にoptional `HistoryTupleV1`を含める案を第一候補にする。`AttemptBinding`は現在粗いScope/material/D1 digestとpurposeを持ち、`create_attempt`はbinding、direct `InputReference`、ordinal付き`QualificationReference`を一つのimmediate transactionで保存する。[`nir1_generation.rs:114-130,640-673`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs)

tupleはD2b-1がPackingと最終request組立て後に、Native current readersが返した参照／値から作る。保存物はimmutable comparison anchorでありcurrent qualificationではない。per-input refsは既存ordinal列を使い、本文・thinking・full closureを複製しない。既存行でtuple fieldがない／`None`の場合はhistory-ineligibleのままとし、restoreで補修・昇格しない。binding JSON追加が既存deserialize compatibilityとsize boundに収まらない場合は、実装前にstorage shape deltaを提示する。

`HistoryTupleV1`はconfirmed nine Scope axesを個別に保持する。post-B §10の`auto`／`phase`／`reveal`は別substructureとして表し、confirmed history rowと混ぜない。purpose、input-use、send classificationはそれぞれ独立fieldにする。`scope_digest`、`d1_digest`、`payload_digest`は短い同一性checkに限り、値・qualification・edgeを復元しない。

### 2. same-snapshot current adapterをtyped reader内に置く

既存`with_generation_history_snapshot`の一回のparticipant-owned read transaction、共有turn budget、cancellation viewを再利用する。`GenerationHistorySnapshotReader`はraw connectionを外へ出さない。その内部に、A2 exact Revision、A3 current disclosure/query Scope、canonical Freshness、current D1 selectionと各input qualificationを呼ぶ、owned typed resultだけを返すnarrow method群を置く。current resultがunavailableならcandidate incomplete。別connection、public per-row wrapper、nested transaction、renderer-provided refsを使わない。[`nir1_generation.rs:1199-1212,1483-1537`](../../src-tauri/crates/grimodex-db/src/nir1_generation.rs)

D1は`read_and_pack_native_a2_context_in_tx`の狭いcrate-private bridgeをD2b-1側が所有し、同じquery・候補pool・snapshotで一度だけPackingする。現public wrapperが別read transactionを開くため、history snapshot callbackからそれを呼ばない。保存するのはD1 ownerのselected target IDs/order、used/remaining、実際に与えたselector budget、authority bindingであり、current final-request budgetと混ぜない。final-request budgetには§8どおりsystem/history/user/context/format/response reserveを別に含める。

外部Native lifecycle state（main-issued caller/profile epoch、workspace binding等）はDB snapshotだけでatomicに守れない。Native ownerがsnapshot前後および既存dispatch/return gateで再検証し、DB transactionがその外部stateまで直列化したとは主張しない。

### 3. parent lineageは記録されたimmutable edgeだけを辿る

Generated MessageはMessageVersionの`parent_attempt_id`、同project/session、body/version digest、成功terminal receiptを照合してからparent attemptのdirect inputsを辿る。Artifactは実際のartifact producer writerがartifact作成確定時にproducer attempt IDとterminal receipt identityを既存保存先へimmutableに記録し、そのwriter-owned transactionでartifact identityへbindできたものだけを対象にする。D2b-2 readerはartifact、attempt、receiptを同じsnapshotで照合する。writer owner／既存保存場所／保持・失効規則が特定されるまでArtifact historyはunsupported。単に型やJSON refへ2 fieldを足すだけではproducer authorityにならない。

同じ全turn budgetをすべてのancestorへ通す。欠損parent、cycle、payload/version/receipt mismatch、current authority unavailable、qualification欠落、budget超過、cancelは契約どおりに扱う。candidate固有の不適格はそのcandidateとdescendantを除外し、独立rootを残せる。current workspace/profile/query Scope失効、turn cancel、最終payload不一致、共有budget／authority read失敗はpartial resultを返さずturn全体を止める。eligibilityは各turnでcurrent readersから再計算し、過去の判定を再利用しない。

**同一transactionでのmutation invalidationは、確認済み`history-reauthorization`の必須要件であり、任意の差分として再確認しない。** 新しい永続invalidation markerという実装方式まで指定されているわけではない。既存Scene Scope writerは同一transaction内でversion／Source tokenとchange-feedを更新し、Human Decision writerもDecision追加とGraph失効を同一transactionで行う。history adapterはこれらmutation-owned identityへ接続し、Source／material／Decision／Scope／receiptの変更、undo／restore／ID再利用後に旧childとdescendantが再適格化されないことを証明する必要がある。後刻の値一致チェックだけでその原子性や非復活を満たしたとは扱わない。既存tokenで証明できない経路はD2bの実装gapとして残し、新しい保存機構が本当に必要な場合だけ、そのwriter・atomicity・restore semanticsと保存差分を別途提示する。現在のread-only adapterはこの要件を完了していない。

## Draft threat model

本節は実装前の確認用で、threat modelをfreezeしない。`nir1-post-b-candidate.md`も、実際のnew authority／trust boundary／acceptance deltaは明示確認までdraftとしている。[`nir1-post-b-candidate.md:13-18`](nir1-post-b-candidate.md)

| 区分 | actors |
|---|---|
| trusted current readers | Native history adapter／generation storage、既存A2 exact Revision reader、A3 current disclosure／Scope reader、既存Freshness、D1 packer、Message／terminal receipt reader。sealed Graph Index readerはC-query完了後のみ |
| trust anchorではないもの | immutable stored tuple、stored qualification refs、attempt ID、digest。これらは比較anchor／lookup keyでありcurrent authorityではない |
| untrusted | renderer history selection／purpose／scope申告、restored/imported ID、stale UI/cache、model/provider output、Artifact rowだけからのproducer claim、未検証のcaller/session/route labels |

**In scope:** cross-project／session／workspace／epoch reuse、stale Source／Revision／Decision／Freshness／Scope／D1、forged digest/tuple/ref、purpose/input-use/send-classification escalation、omitted qualification/ancestor、descendant bypass、restore／ID reuse replay、Artifact producer/receipt mismatch、Graph identityをsealed Indexに見せる、予算／cancel後のpartial qualification。

**Out of scope:** OS／backend compromise、semantic truth、provider/model quality、secret privilege、transport redesign、外部送信認可。本案は送信を許可しない。

**Mandatory defenses:** Native-created immutable refs only、同一snapshot current readers、exact identity/version/context comparison、fieldごとの完全性検査、targetごとに7 qualification kind exactly once、allowlisted current purpose/classification、Message/Artifact recorded lineageのみ、whole-turn shared budget/cancellation、candidate/descendant exclusion、turn-wide authority lossで全体停止、old/import/restore rowsを再qualifyしない、payload digestで依存辺を推定しない。D1/Graph authorityがなければ当該candidateはunavailable。

## Acceptance implications（未実行）

| case | 合格条件 |
|---|---|
| positive | current `Source`／A2 Revision／Decision／Freshness／A3 Scope／sealed Index／D1 authorityに一致する全tupleと7 qualification kindが揃い、同一project内で成功receipt付きMessage chainがcold reopen後も同じeligible input refsを返す。D1 selected/omitted orderとbudget witnessは同じturnのPack結果と一致する。sealed Index readerがない現在は、このpositive pathはunavailableのまま |
| field-by-field rejection | 9 confirmed Scope axesの各mismatch／unknownを別々に除外。`storyTime` unavailableとcontract mappingのない`viewpoint` N/Aはfail-closed。purpose、input-use、send classification、Revision／Decision／Freshness／Scope／D1各refのmismatchも別々に拒否 |
| post-B axes | `auto`／`phase`／`reveal`はapproved tuple contractとcurrent authoritative mappingがある場合のみ個別に照合する。現在のtoken／per-material ScopeBindingを別sourceと同一視してpassさせない |
| missing lineage | missing/duplicate/unknown/target-mismatched qualification、GraphEvidence without sealed Index reader、Artifact without persisted producer+receipt, legacy/restored IDs are unavailable; descendants are excluded while independent complete roots remain |
| integrity | successful Message terminal/body version mismatch、cross-project parent、changed Source/Decision/Freshness/Scope、sibling not in recorded ancestry、attempt/receipt mismatch all reject |
| stop behavior | shared budget exhaustion、cancel、current authority read failure、workspace/profile/query invalidation、final payload mismatchはpartial successを返さない。candidate-local stale branchだけはそのchild/descendantsに限り除外できる |
| publication boundary | tests do not activate Graph/Packing product route or any product send. All send paths remain closed |

この文書では実装もtestも行っていない。実装に進む場合は、各field mismatch、stale authority、branch propagation、same-snapshot、shared budget/cancelを同一候補で受け入れ、Product-send gateを別契約の明示批准前に開かない。

## 実装前に必要な明示確認

proposal/3の確認済み`history-reauthorization`と`native-generation-receipt`を再確認する必要はない。GDX-PRECHECK-001はsecurity-sensitive threat modelをactor、attack scope、mandatory defense、acceptance implicationsの明示確認までdraftに保つよう要求し、post-B計画も新しいauthority／trust boundary／acceptance deltaを既存確認へ暗黙追加しない。[`iron-laws.md#GDX-PRECHECK-001`](../../policies/quality/iron-laws.md#GDX-PRECHECK-001) [`nir1-post-b-execution-plan.md:34-42`](nir1-post-b-execution-plan.md)

実装前に次を個別に閉じる。

1. **Adapter threat model:** 上記actors／trust boundary／attacks／defenses／acceptanceをこのdraftRefで確認する。確認文案: `I confirm draftRef nir1-d2b-history-authority-proposal/1 for contractId history-authority-adapter.`
2. **追加Scope axes:** `auto`／`phase`／`reveal`をhistory eligibilityの必須軸にするなら、proposal/3 history rowへの差分として確認し、同一のexisting Scope authorityから返せる正本を特定する。確認文案: `I confirm draftRef nir1-d2b-history-authority-proposal/1 for contractId post-b-history-scope-axes.` 確認前はこれらを既存9軸に黙って追加せず、§10どおりに必要ならcandidateをunavailableにする。
3. **input-use／send classification:** existing typed sourceとallowlistがある場合だけ接続する。存在しない場合、型・enum・writer・更新／失効semanticsを新設する前に`history-input-classification`差分の明示確認が必要。確認文案: `I confirm draftRef nir1-d2b-history-authority-proposal/1 for contractId history-input-classification.` `InputRole`やpurposeから代用しない。
4. **Artifact producer lineage:** producer writer、既存durable保存先、attempt＋terminal receiptとのimmutable binding、削除／restore／失効動作を特定する。現行schemaのrelationがないままcolumn/refだけ追加して進まない。新しい保存relationを選ぶ場合は`artifact-producer-lineage`の明示確認を得る。確認文案: `I confirm draftRef nir1-d2b-history-authority-proposal/1 for contractId artifact-producer-lineage.`
5. **unavailable Scope values:** `storyTime`の正本と`viewpoint` N/Aがhistory contractを満たす条件を特定する。既存sourceがなければnew authorityを作らずfail-closedを維持し、必要なauthority／contract deltaを別途確認する。

上記exact statementsは各contractIdの批准候補にすぎず、missing source、Artifact relation、post-B axis差分、送信権をまとめて承認したことにはならない。どの差分も記録されるまで、現在Gateとproduct sendはclosedのままとする。
