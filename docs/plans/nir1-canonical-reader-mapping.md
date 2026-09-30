# NIR-1 L2 canonical reader の現行コード対応

2026-09-08。L1実装laneとは別の技術mapping。正本は
`narrative-ir-nir1-implementation-plan.md` §L2。末尾にcanonical readerのfocused実装証跡を記録する。
whole admission、Index activation、scheduler稼働の受入れは別の未完境界である。

## Consumer-scoped reader

| 検証対象 | field / 現行reader | proposal-revision側の扱い |
| --- | --- | --- |
| identity | `narrative_proposal_revisions.id/proposal_id` → `narrative_proposals.proposal_set_id` → `narrative_proposal_sets.project_id/run_id`。`consumer_identity.rs:231` | `(project_id,'proposal-revision',revision_id)`で読む。revision keyからRunを推定しない。current pointerとapprovalはL2の別資格判定であり、historical lineage membershipの前提にしない |
| canonical authority | `schema_data_migrations` marker `narrative-c2-canonical-freshness-v1` / contract 1。`c2zc_canonical_cutover.rs:624 is_generic_freshness_canonical` | markerはactivationのみ。実時間livenessの代用にしない。legacy Application mirrorをfallbackにしない |
| 現在Epoch | `semantic_epoch.rs:76 get_current_epoch`。`narrative_semantic_epochs(project_id)`の最大`epoch_number`の`id` | selected consumer rowと全edge stateをこのIDへ照合。historical ancestorの現在Epoch/Freshnessはmembership検証で要求しない |
| canonical row | `narrative_consumer_freshness`: `evidence_freshness,build_action,semantic_epoch_id,last_evaluated_run_id,dependency_set_digest,updated_at` | 新しいnarrow readerが必要。利用には`fresh/none`、current epoch、非NULL digest、下記集合・state整合を確認する。保存rowだけの表示reader `inbox_read_model.rs:153`を資格readerにしない |
| immutable材料 | `human_material_basis.rs:733 validate_human_material_parent_bundle` | parsed effectiveMaterialBasisの各digest、persisted `narrative_revision_source_basis`のordinal/kind/key/token/observedAt完全一致、同project/revision/run/envelopeを照合。writer専用のlive Scope再解決・current parent CASはreaderへ移植しない |
| sealed D1 | `declaration_storage.rs:497 read_active_dependency_declaration_set_in_tx`。heads/sets/entriesの存在、sealed state、head/set authority、canonical selectors、entry key/selector digest、set digestを検証 | public Option readerはMissing/Corruptを併合するため、同一connectionのtyped readを使う。さらに`human_material_basis.rs:649 validate_active_parent_d1`相当でNative producer `proposal-revision-source-basis`、generation、material dependency role/selectorの完全一致を確認 |
| V1完全集合 | `dependency_edges.rs:591 find_edges_by_consumer`。`id,project_id,consumer_kind,consumer_key,source_object_identity,read_set_json,owning_run_id,generated_by_transaction_id` | `human_material_basis.rs:968 project_v1_expectations`と同module `validate_v1_parent_edges`で、sourceごとに一つ・正しいowning Run・one-token read-set・missing/extraなしを検証。D1とV1は同一digestとして比較しない |
| V1 digest | `dependency_edges.rs:543 consumer_dependency_set_digest` | canonical rowのdigestと再計算値を照合。これはsource identity集合のみで、token/state/role/selectorのdigestではない。空集合digestとNULLも別物。非空材料への欠損edgeは上記完全集合で捕捉する |
| stored edge evaluation | `publish_runtime.rs:478 worst_edge_state_for_consumer`。declared edgesをLEFT JOINし、`narrative_dependency_edge_states.evaluated_at_epoch_id`がcurrentのstateを読む | current state欠落はUnknown/Manual。`evidence_freshness/reason_code/build_action`をtyped解析し、全edge集約とcanonical rowを照合する。fresh文字列だけでは通さない |
| live source comparison | `restore_rebuild.rs:575 evaluate_edge_from_db` → `build_edge_comparison_input` → `source_revision.rs:80 resolve_current_source_state` → pure `evaluator.rs:298 evaluate_edge` | source存在/usable/token一致を読み取り専用で検査できる。SQL/I/Oはerrorのまま。ただしこのbaselineはFeed由来のnormalizer/component/range情報を持たず、stored stateやpending Feedを置換しない。既存read-set first-token readerだけでは余剰tokenを拒否しないためV1完全検証も必要 |
| 合法runless | `repository.rs:4767`と`human_materialization.rs:695` → `publish_runtime.rs:331 publish_complete_runless_freshness_in_tx` | root/child保存時に全非空edgeを評価し、stored/provided edge ID完全一致、current project Epoch、全stateとconsumer rowを同一transactionで公開。`last_evaluated_run_id=NULL`のfresh/noneは正当。NULLを一律拒否したりrun IDを捏造しない |
| Run付き評価 | `c2zc_canonical_cutover.rs:438 validate_current_evaluation_run_reference` | helperはprivateかつApplication命名だが、Some(runId)のpublisher型の条件はconsumer-neutralに分離して共有する候補。same project/current Epoch/completed、incrementalの正規consumer ID、idle-checkpoint拒否、rebuildの完全maintenance lifecycleを確認。Applicationの存在JOINとrunless制約は共有しない |
| D2 shadow | `incremental_freshness.rs:2464 evaluate_v2_shadow`、`:2762`、`:2854` | 現在は診断shadow。D1 driftでshadowを捨ててもV1 publicationは続く。D2の結果を第二Freshness authorityへ昇格させない |

`canonical_application_freshness` (`c2zc_canonical_cutover.rs:290`) はApplication存在をJOINし、
runlessをUnknown/Manualだけに制限する。proposal-revision IDをこのAPIに代入してはいけない。
Application reader自身もpending Feedや現在scheduler稼働を確認していない。

## Feedとschedulerの実前提

| 対象 | field / reader | 解釈 |
| --- | --- | --- |
| shared cursor | `cursor_reservation.rs:44`、`narrative_change_cursors(project_id,consumer_id='narrative-incremental-freshness/v1')` | revision個別cursorは存在しない。`acknowledged_through_sequence,reserved_through_sequence,active_run_id,lease_owner,lease_expires_at,semantic_epoch_id,last_error,updated_at`を読む |
| ACK | `incremental_freshness.rs:2862`、`cursor_reservation.rs:318` | canonical publicationとACKは同一transaction。ACK後はreservationのEpoch/Run/lease/errorがNULL。idle cursorの`semantic_epoch_id=NULL`をepoch不一致と誤判定しない |
| pending events | `change_feed.rs:1978 get_changes_since` | 同projectかつ`canonical_sequence > ack`でtransactionと結合し、同sequenceを全件読む。headはproject MAX(sequence)。head-ackはevent件数ではない |
| relevant source | `incremental_freshness.rs:2009` selection、`:3284 source_identities_for_event` | source identityを導出してV1 reverse lookup。scene/folderの親・順序・archive等は`project:scope-authority:<projectId>`にも影響。reader独自に簡略化しない。指定revisionのrelevant pendingだけを返す既存public readerはない |
| global pending | `incremental_freshness.rs:3786` | full-rebuild schema change / restore / Epoch resetはproject全edgeを対象。selected revisionの直接source ID不一致を理由に無視しない |
| maintenance setting | `narrative_runtime_policy.rs:141 maintenance_enabled` | maintenance preview/domain mutation用。incremental Freshness停止flagではない。現経路にpersisted paused flagは見つからない |
| scheduler capability | `electron/main/index.ts:476`、`narrativeFreshness.ts:294` | Native method欠落、dispose/quitで停止。workspace未open/切替中/SafeModeはN-API `lib.rs:2613`でcycle None。CI `narrativeMaintenanceCiSeam.ts:188`のexact-owner setup/freshness disabled seamはテスト専用 |
| live receipt | `incremental_freshness.rs:306`、N-API `lib.rs:2649`、`c2zc_canonical_cutover.rs:110` | 成功cycle capability→active workspace再確認→process-local heartbeat。cutover用はauthority/generation/connection epochへ結合し5秒有効。completed DB Runやmarkerとは別物 |

現状、scheduler停止は保存freshを自動失効させない。cold snapshot一致、Feed整合、processの稼働、検索資格は分けて報告する。
提案するL2 narrow readerは同一read transactionでselected revision/D1/V1/current epoch/row/state/source/pendingを検証する。
L3のmutation時project IR停止・publish CAS・query response世代照合と接続して返却時のraceを閉じる。

残る技術決定は、Related Scenesへ適用するlive capabilityの形、consumer-scoped pending helperの公開範囲、
cutover未完/停止時の製品fallbackをどのownerが返すかである。cutover専用の全project rebuild/verify/5秒receipt一式を
queryごとへ移す理由は現コードからは得られない。L1はこの決定とruntimeを混在させない。

## L2 独立レビューで具体化した条件

- `worst_edge_state_for_consumer` は Freshness の severity だけで同率の先頭を選ぶ。
  集約が `fresh/none` でも後続の `fresh/revalidate-exact` を除外できないため、selected revision の
  全 stored edge を直接 current epoch / fresh / build action none / reason なしと照合した後に、
  集約と canonical row の整合を確認する。集約 policy 自体をこの lane で変更しない。
- 同じ read snapshot で cursor ACK と確定 Feed head を固定し、sequence 単位のページを head まで
  走査完了したときだけ pending なしと判断する。上限到達、未知 event、ACK > head は typed unknown、
  SQL/I/O は error とする。既存 `affected_source_identities` と `requires_full_graph_evaluation` の
  selection を共有し、deleted catalog や folder subtree の Scope 影響も保持する。
- edge の `owning_run_id` は sealed Source 解決用の proposal-set Run であり、必ずしも現在 Epoch の
  Run ではない。正規 child と rebuild は古い owner を保ったまま現在 Epoch で評価されうる。
  canonical row / 全 edge evaluation に current Epoch を要求し、Some の評価 publisher Run は
  別に検証する。old owner + current evaluation は positive、missing / cross-project owner は negative。
- L3 へ渡す snapshot identity は workspace path / DB connection epoch に加え、Native authority の
  ID / generation / instance を固定する。N-API の既存 capture を使い、同 connection transaction から
  return / click 時まで世代を照合する。query ごとの heartbeat 5秒 TTL は追加しない。

2026-09-08 時点の合意は、saved fresh の無変更 snapshot を heartbeat 不在だけで失効させず、
writer → scheduler → included/excluded と固定回復時間の product journey で runtime liveness を別に証明する。

## L2 新 module の実装境界案

公開 Rust reader は `read_revision_retrieval_eligibility(conn, project, revision, query_scene_id)` とし、
caller-owned read transaction を必須にする。`RevisionEligibilityRead::Eligible` は sealed selected
revision と query Scene、current Epoch、V1 digest、D1 head、cursor ACK / head、current decision ID の
同一 snapshot 結合を返す。`Unavailable` は missing / stale / pending / unsupported / binding-invalid を
区別できる enum reason を返し、SQL/I/O を通常の unavailable に丸めない。N-API authority の
ID / generation / instance はこの DB module の外側で capture し、L3 の response 世代照合へ渡す。

実装は `revision_eligibility.rs` と、その配下の canonical Freshness / pending Feed / disclosure の
private module に分ける。承認判定や canonical reader は L1 membership report の JSON に依存しない。
L1 の typed reader を同 transaction 内で実行し、selected payload / Envelope を再び永続行へ結合する。
candidate が current であり、その revision 自身への latest Human decision が exact project/proposal/revision
authority を持つことを確認する。親への承認は継承しない。

新規 reader が共用する既存 helper の可視性変更は、L1 lane review と標準 build が完了してから行う。

| helper | 変更案 | 共有する理由 |
| --- | --- | --- |
| `c2zc_canonical_cutover::validate_current_evaluation_run_reference` | application 名の診断ラベルを consumer-neutral にした private helper を共有 | Some 評価 publisher の厳密な completed/current Epoch/incremental-or-rebuild lifecycle。runless 制限は共有しない |
| `incremental_freshness::affected_source_identities` | crate 内 read helper から呼べる範囲へ公開 | catalog / source / project Scope の selection を scheduler と一致させる |
| `incremental_freshness::requires_full_graph_evaluation` | crate 内 read helper から呼べる範囲へ公開 | full rebuild / restore / epoch reset pending を見落とさない |
| `disclosure_precheck/scene_axis.rs` | 同じソースを typed product reader から利用 | ADR-002 scene-anchor axis の既存 parity を保つ。story axis を新規許可しない |
| `mod.rs` | 新 module と Rust 型のみを export | L1 freeze 中は変更しない。新 IPC / schema / index はこの lane に入れない |

通常 UI cold fixture の保存状態は、2026-09-08 の read-only 確認で canonical marker contract 1、
current Epoch 1件、ACK=head=3、両 Human child の canonical row と全3 edge が current Epoch の
`fresh/none/reason=NULL`、runless publication だった。query mode は auto、owning interpretation Run は
completed。この fixture は reader の cold positive に直接使え、保存行を作り直す必要はない。

| L2 focused case | 検証する差分 |
| --- | --- |
| normal approved child / S2 | membership、approval、material / Scope、runless fresh、ACK=head の全 AND |
| unapproved Native projection child | membership complete でも自分の decision 不在で不可。approved parent で代用しない |
| historical noncurrent parent | membership complete でも current pointer 不一致で不可 |
| source / Scope の正規変更直後 | same snapshot の live token / relevant pending で不可。保存 fresh だけで通さない |
| 全 edge / canonical row | 後続 edge の fresh/revalidate-exact、reason、old Epoch、missing state、digest mismatch は不可 |
| D1 / V1 | L1 の完全集合に加えて current canonical digest / state と照合。D1 と V1 digest は混同しない |
| pending Feed | ACK/head の固定、relevant/global は不可、走査済み unrelated のみなら許可。上限到達/未知 event/ACK>head は unknown |
| old owning Run / current evaluation | owner Epoch の古さだけでは拒否しない。missing/cross-project owner と評価 publisher corruption は拒否 |
| candidate Scope / materials | secret、S1=S2、future material、unresolved/exact mismatch、未知 contract/control は不可 |
| cold / idle scheduler | 同じ確定 snapshot は heartbeat 不在だけで失効しない。runtime scheduler の速度・停止・回復は別 journey |

## L2 canonical reader focused snapshot

2026-09-08、`revision_eligibility.rs` とprivate `freshness` / `pending` / `pending_seals` を実装した。
公開APIは `read_revision_canonical_freshness`。caller-owned read transaction内でL1のtyped membershipを
検証し、上記canonical row・全edge・current Source・pending Feedを結合する。
内部合成関数は同じmembershipを再利用でき、後続whole admissionでroot replayを二重実行しない。

pendingはshared cursorのACKと、Native eventおよびtransactionの最大sequenceから得たheadを固定する。
64 sequence × 最大16page、event総数4096以内でheadまで全件確認し、Native transactionとcanonical eventの
project/UID/sequence/metadata、ordinal完全性、既存producerのpayload digestを照合する。
general `change_events` のaudit-only gap自体は欠損証拠にしない。transactionだけの欠落はorphan eventを残した
private copyで、複数eventの末尾欠落は正規Native two-event transactionのseal不一致で検証した。
Native transactionと全eventの双方を丸ごと消した状態は、この二つのledgerだけではaudit-only gapと区別できない。
そのwriter漏れ・rollback境界はL3の同一transaction hookと独立受入れで閉じる。

- 新canonical suite: 17/17 pass、既存Application canonical publisher回帰: 7/7 pass。
- frozen source manifest: `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/l2-eligibility/l2-canonical-source-evidence.json`
  SHA256 `fb4a27dbf517921419213c65fbd6b7e96b24b18dcf7a0982a3cc092be51acf03`。
- 通常UI cold childの合法runless Freshness、無関係pendingの許可、relevant/global/unknown/予算超過の拒否を含む。
- これはapproval・material disclosure・Index・runtime liveness・Quick/Full・製品受入れの証拠ではない。

次のwhole-admission readerは初期A2の全fieldをtyped stateで返す。audienceはreader、viewpointと
knowledgeHolderはreader-reference用途のnot-applicable、Timeline/Worldline/layerは現在のpersisted query Sceneに
束縛したidentityが無いためunavailable。候補anyは許可できるが、unresolvedや未対応のexactをanyへ変換しない。
secretは初回不可。static二contractの内容・版・digest照合と、C2B Scope-resolutionの限定された制御用途を
別々に確認し、全story-bearing sourceについてstrict reading-before-S2を維持する。

## L2 whole admission のfocused実装

`retrieval_admission.rs` は同一read transactionでtyped query context/current own Human decisionを読み、
L1 membershipを一度だけ実行して共有 `revision_eligibility::freshness::read` へ渡す。
canonical public readerを再度呼んでmembershipを重複replayしない。
新APIは `read_revision_retrieval_eligibility`、`read_retrieval_query_context`、`read_retrieval_scene_source`。

Raw SourceはIR eligibilityと独立であり、同project実在Sceneの保存本文をarchive/story/unknown modeでも返す。
IR contextはarchive・unsupported effective storyを拒否する。保存本文とEvidence用canonical本文は別のNative-only fieldで、
既存Raw queryのJS conversion/trim/500 UTF16へcanonical本文を代用しない。
正規WAL read snapshotを保持したまま別connectionのNative body/order/mode commitを行い、元snapshotは古い三者を一貫して保持し、
次のtransactionだけが更新された三者を見ることを検証した。

全候補材料はsourceKeyからlive Sceneへ写像する。snapshot documentRefはD000001等のRun内aliasであり、
Scene refと直接比較しない。Evidenceは同じverified material内のdocumentRefへ結合し、snapshotにoriginal owning Runを保持する。
31-case focused suiteと共有ADR002 parityを通過。正規24/336件と別100-current cold fixtureの全件について
revision/owningRun/envelope/own Decision一致とDB bytes不変を確認した。Index/実検索/runtimeへの接続は後続L3/L4である。
