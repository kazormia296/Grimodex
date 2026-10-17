# NIR-1 C-query 受入れ台帳（CR-REC、2026-10）

更新日: 2026-10-14（CR-2。G-1〜G-4 に関わる節と、B-ROUTE（#643）の merge で古くなった記述）。2026-10-13 の CR-REC の記入は、ここで触れていない節では変えていない。2026-10-14 の CQ-AVAIL（branch `claude/nir1-cqavail`）の追記は §2.12、§4.1、§8 の最後の行

| 項目 | 値 |
|---|---|
| 状態 | CR-1（#636）は 2026-10-13T14:06:23Z に merge された（squash commit `750741183cf4d75ccf18b3904a5751b762284bda`）。HOLD の解除は有効。CR-2（branch `claude/nir1-cr2`、試験と本台帳の更新）が G-1〜G-4 の試験を足した。G-3 と、G-1／G-2／G-4 の試験を足した部分は充足とする。HOLD のまま残すのは [precheck] の2点（G-1 の B の上限近傍の publish、G-2 の実 worker の正例）で、Scene 8 は CP-1 の受入れに移す（§7）。merge 後の master の Full は実行中（CR-REC の時点の記入） |
| 対象 | C-resource: C-query の functional／resource-safety、100 ms result lease、SQL、cleanup。[L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の残HOLD表にある「C-queryのfunctional/resource-safety・100 ms lease、SQL・cleanup」の行 |
| 契約 | `nir1-l6-l9-contract-proposal/6#graph-limited-binding` と `nir1-l6-l9-contract-proposal/6#nir1-defensive-resource-limits`（どちらも 2026-10-12 に確認済み）。固定値と閾値は変えない |
| 条件の正本 | [post-B §12](nir1-post-b-execution-plan.md#12-必須試験の追跡表) の CQ-1〜3 と [§6.4](nir1-post-b-execution-plan.md#64-受け入れ)、L6〜L9実行計画の proposal/6 節（Acceptance implications）、[C-query 資源・lifecycle 境界](nir1-c-query-memory-enforcement-v1-draft.md) の「維持する機能・workload・認可契約」 |
| 候補 | CR-1（[PR #636](https://github.com/kazormia296/Grimodex/pull/636)、branch `claude/nir1-cres`、merge 済み）。head は §3.1。run は `kazormia296/Grimodex` の GitHub Actions の run ID。CR-2（branch `claude/nir1-cr2`、1 commit）。base は master `87f0da94`（HP-1、#632）で、ローカルの検証は §3.4 |
| 位置づけ | 受入れの記録。契約の批准、閾値の変更、製品公開（Graph、local 送信）の根拠にしない。製品の Graph 入口は閉じたまま（A-1） |
| 残る確認 | CR-2 の PR の最終 head の PR checks の green（CR-2 の充足の条件。§3.4）。merge 後の master の Full（run `38410553482`）は実行中で、結果は master の Full の記録で追う（CR-REC の時点の記入）。[precheck] の2点（§7.1、§7.2）はユーザーの確認を待つ。それ以外の欄は記入済み（§8） |

## 1. 結論と HOLD の扱い

- 本台帳は C-resource の受入れ条件を一つずつ挙げ、CR-1（#636）と CR-2 の試験、lane の run に対応づける（§2）。対応する証跡が無い条件は「未充足」とし、他の証跡で代えていない（§7）。
- 解除する範囲は、§2 で「充足」とした行（CQ-1〜3、RB-3〜RB-7、LC-1〜LC-9、NB-1、PF-1、A-1）と、「一部充足」とした行（RB-1、RB-2、RB-8）のうち試験がある部分である。RB-4 は CR-2 の G-3 の試験で充足になった。
- 残す HOLD は、§7 の [precheck] の2点である。G-1 の B の上限近傍の publish（§7.1）と、G-2 の実 worker の正例（§7.2）で、どちらも対応する試験が無いからではなく、確認済みの契約と実装が食い違うため、試験を足しても通せない。固定値か文言の判断がユーザーに要る。G-4 の Scene 8 は CP-1 の受入れに移す（§7.3）。
- CR-1 の解除の条件は、CR-1（#636）の merge と、最終 head の Quick・PR checks・lane 6本の green で、いずれも満たした（CR-1 の squash commit：750741183cf4d75ccf18b3904a5751b762284bda）。結果は §3.2。U7（2026-10-13 のユーザー決定）により Full は merge 後の master で走らせる。
- CR-2 の解除の条件は、CR-2 の merge と、最終 head の PR checks の green である。CR-2 の試験は共有 Rust の試験で、新しい lane は無い。ローカルの検証は §3.4。
- 製品の Graph 入口は閉じたまま（A-1）。Graph の公開には A3 + B + C + D2a と公開時の承認がさらに要る。local 送信、新しい authority・保存先・送信先、固定値と閾値、確認台帳の各行は変えない。

## 2. 受入れ条件と証跡の対応

### 2.1. 読み方

- 試験のファイルは、特記しない限り `src-tauri/crates/grimodex-db/src/narrative_extraction/` の下にある。`tests.rs`、`oracle_tests.rs`、`candidates.rs`、`input.rs`、`c_query_worker.rs`、`worker_frame.rs`、`memory.rs` は `nir1_graph/` の下の略記である。
- 「（場所）」は、その試験が走る CI を表す。H2 と H3 の結果は §3.3。
  - （共有 Rust）：ignored ではない試験。ordinary CI の `Shared Rust crates` と、Full の rust part（`rust.tests-db-lib`、`rust.tests-db-integrations`）。
  - （既定 worker）：`scripts/nir1-c-query-worker-ci.sh` の既定 mode が走らせる実 worker 試験11件。ordinary CI の `C-query worker`（3 OS）と、Full の cquery part（Linux）。通常 build の worker と、seam 付き build の worker の両方を使う。
  - （lifecycle）（practical）（cancellation）（startup-refusal）（terminal-refusals）（frame-lifecycle）：`ci.yml` を `workflow_dispatch` で起動する opt-in lane（[runbook](../local-ci-runner.md)）。run は §3.2。lifecycle と practical は Linux のみ、ほかは 3 OS（ubuntu／macos／windows）。
  - （native）：ordinary CI の `Electron native` と Full の native part。（vitest）：ordinary CI の `Electron (workflow contract / type-check / test / build)` と Full の native part の `electron.unit`。
- 判定は次の3種類である。
  - 充足：条件に対応する試験があり、その場所の run が green。
  - 一部充足：条件の一部だけ試験がある。足りない部分は §7 に G の番号で記録した。
  - 未充足：対応する試験が無い。
- RB、LC、NB、PF は本台帳の中だけの通し番号で、新しい policy／authority の識別子ではない。
- 試験が走った run の green は、§3.2 と §3.3 の H3（`fbdc8588`、最終 head）の列で確かめた。Full は merge の条件ではなく（U7）、H3 の Full は取り消したので、Full の証跡は H2 の run と、merge 後の master の Full（§3.2）で追う。H2 の列は経過の記録として残す。
- CR-2 の試験は（共有 Rust）の試験で、hosted の run はまだ無い。判定の条件は §3.4 に書いた。CR-1 の run の green では代えていない。
- query の試験が使う経路は二つある。製品の query は worker 経路（`open_for_worker` と `query_for_worker_with_maintenance`）だけである。ordinary reader（`open`、`register_with_control`、`query`）は、試験と `nir1-material-diagnostics` feature の診断用の経路で、製品の経路ではない。CR-2 は ordinary reader を `cfg(any(test, feature = "nir1-material-diagnostics"))` に閉じ、製品 build から外した（D9）。ordinary reader の論理 ledger は、worker の固定 allocator が置き換える一時見積り（raw bytes の 8 倍と、行ごとの 4 KiB）も retained の上限 6,291,456 B に計上するので、worker 経路より厳しい。steps の上限を外した実験（commit した試験ではない）では、600,000 B の候補でも `NIR1_GRAPH_RETAINED_LIMIT` で拒否した。worker 経路はこの計上を省く。そのため RB-2 の正例の証跡には worker 経路の試験を使い、ordinary reader の結果は使わない。
- worker 経路の試験でも、CR-2 の試験は通常の allocator の in-process である。worker binary の固定 allocator で処理できることは示さない。実 worker は、既定 worker と lifecycle などの lane、および G-2 の [precheck]（§7.2）で扱う。

### 2.2. 一覧

| ID | 条件 | 判定 |
|---|---|---|
| CQ-1 | 候補欠落・世代不一致・keyset 飛ばし → 独立正解に一致、または登録／admission の失効から unavailable | 充足 |
| CQ-2 | seed 近傍を固定して無関係な Revision を増やしても、全件 scan・JSON 展開に退行せず、query の資源の内 | 充足 |
| CQ-3 | 非開示 bridge・方向違い・巨大行・上限・取消 → 禁止寄与 0、部分 Graph なし、Raw 非占有、実 cleanup | 充足 |
| RB-1 | Revision の上限（512 records／6,291,456 B）の N／N+1 と正例 | 一部充足（G-1。writer の N／N+1 と上限ちょうどの保存は充足。B の上限近傍の publish は [precheck]） |
| RB-2 | per-Revision preflight（2,097,152 B）の N／N+1 と query 全体の拒否 | 一部充足（G-2。本番の worker 構成の in-process は充足。実 worker の正例は [precheck]） |
| RB-3 | Packing の入力の合計（2 MiB）の typed refusal | 充足 |
| RB-4 | query の上限（read／admission 512、batch 16x32、SQL 100,000 steps、request・frame、後続 bytes、枠の使用中、reader／busy） | 充足（G-3。rollback journal での注入。WAL 固有の busy は対象外） |
| RB-5 | 100 ms result lease（Q512 の admission→lease、期限後の結果の不採用） | 充足 |
| RB-6 | 取消（Rust の境界と SQL step での観測、取消でも部分 Graph なし） | 充足 |
| RB-7 | B whole-set の安全失敗（U6） | 充足（P3 を残す） |
| RB-8 | proposal/5 の正例・負例（proposal/6 は変えない） | 一部充足（G-4。Scene 8 は CP-1 の受入れに移す） |
| LC-1〜LC-9 | lifecycle・cleanup（startup、stalled stdin write、receive、cancel／deadline、workspace switch／Restore／old binding、crash／incomplete／trailing frame、lease と reap の両順序、unproved cleanup、allocation の origin） | 充足 |
| NB-1 | normal-build acceptance（seam を含まない通常 build の worker で実 worker 試験が通る） | 充足 |
| PF-1 | 有限の実用確認（Q512 を30回、maximum fixture を1回） | 充足（最終 head の値は §4） |
| A-1 | 製品 Graph 入口への直接呼出しは拒否されたまま | 充足 |

### 2.3. CQ-1：候補欠落・世代不一致・keyset 飛ばし

条件：独立した canonical 読取の正解経路と一致する。または、登録／admission の失効から unavailable になる。誤った空結果を返さない（post-B §12、§6.4）。

- 独立した正解との一致
  - `nir1_graph/oracle_tests.rs::seed_local_query_matches_explicit_roster_with_keyset_decoys`：seed 上の keyset decoy 31件と、無関係な reverse-index の decoy 513件を置いたうえで、出力の順序、両端点と Evidence、binding の全 field を、事前に固定した canonical projection と比べる（共有 Rust）。
  - `oracle_tests.rs::seed_local_two_hop_query_matches_independent_canonical_projection`：2 hop の経路と Evidence を比べる（共有 Rust）。
  - `tests.rs::registered_graph_preserves_exact_revision_decision_and_evidence`：A3 の開示判定が返す proof の各 token と Evidence に一致する。`registered_graph_preserves_multi_edge_order_and_bindings`：複数 edge の順序と binding を保つ（共有 Rust）。
  - 実 worker の frame を Gold と比べる：`tests.rs::native_worker_returns_fixed_q2_frame_from_real_workspace_owner`（Q2。既定 worker）、`native_worker_returns_canonical_512_a3_eligible_seed_local_graph`（Q512。既定 worker、practical）、`native_worker_practical_retention_q512_30x`（Q512 を30回。practical）。`native_worker_returns_canonical_512_a3_eligible_registry33_seed_local_graph` は registry 33行の fixture で、Gold ではなく frame の各 field を検査する（lifecycle）。
- 候補欠落・世代不一致から unavailable
  - `oracle_tests.rs::sealed_semantic_index_rejects_missing_or_wrong_family_seed_reverse_row`：seed の reverse-index の行が欠落、または family が違うときは、登録の段階で拒否し、`registration-required` の unavailable で Graph を出さない（共有 Rust）。
  - `candidates.rs::complete_source_index_requires_one_proposal_revision_edge_per_entity`、`complete_source_index_rejects_unexpected_proposal_revision_edges`、`complete_source_index_rejects_malformed_revision_payloads`：欠落、重複、想定外、不正な payload を不完全な索引として拒否する（共有 Rust）。
  - `tests.rs::committed_external_write_invalidates_registration_without_partial_output`、`dirty_binding_invalidates_registration_and_cannot_be_registered_again`、`missing_source_or_decision_cannot_reuse_published_binding`：commit 済みの外部 write、dirty、Source・Decision の欠落で `registration-drift` の unavailable になり、再登録できない（共有 Rust）。
- keyset の飛ばし・重複
  - `candidates.rs::source_seek_pages_include_decoys_and_ignore_unrelated_rows`：16件ごとの page で最後まで読むと、decoy を含む35行が重複・欠落なく同じ順序で得られる。他 project の行と、無関係な600行を足しても同じ（共有 Rust）。
  - `nir1_entity_relation.rs::graph_index_keyset_scans_ineligible_pages_past_512_candidates`：B の roster の走査が、512件を超える不適格な候補を越えて、資格のある Revision に届く（共有 Rust）。

判定：充足。

### 2.4. CQ-2：seed 近傍の固定と無関係 Revision の増量

条件：全件 scan・JSON 展開に退行せず、query の資源（100,000 steps）の内に収まる。

- `input.rs::plan_tests::a2_a3_plans_seek_the_seed_revision_without_table_scans_or_temp_sorts`：A2／A3 の SQL 35文（4+10+8+8+5）の EXPLAIN QUERY PLAN が、全件 SCAN、TEMP B-TREE、AUTOMATIC index、Revision の id 以外での JSON 展開を持たない。Decision を読む3文は `idx_narrative_decisions_revision_proposal` で SEARCH する。検出力を示す negative control を4件置く（共有 Rust）。
- `tests.rs::unrelated_payload_revisions_do_not_change_seed_a2_a3_steps_or_admission`：無関係な Revision を 0／600／6,000 件に増やしても、未 decided では steps と admission が完全に一致し、decided でも admission が一致する（共有 Rust）。
- `tests.rs::unrelated_decided_revisions_do_not_change_seed_a2_a3_steps`：decided な無関係 Revision で、600件と 6,000件の steps が一致する。0→600件の差は Decision seek 1本につき最大1 step（A2 は1本、A3 は2本）。B-tree の端の境界によるもので、件数には比例しない（共有 Rust。CR-1 の D7）。
- `tests.rs::measure_seed_a2_a3_wall_with_unrelated_revisions`：wall を測るだけの ignored 試験。wall は assert せず、どの lane にも配線していない（ローカルの計測用）。
- `candidates.rs::source_seek_pages_include_decoys_and_ignore_unrelated_rows`：候補の読取が `idx_narrative_dependency_edges_source` で seek し、TEMP B-TREE を持たない（共有 Rust）。
- `tests.rs::unrelated_reverse_dependencies_do_not_consume_seed_local_budget`：無関係な reverse dependency 513件が seed の予算を消費しない（共有 Rust）。
- schema v42 の index：`migrate.rs::tests::schema_42_shares_the_pinned_decision_index_definition`、`schema_42_does_not_promote_a_41_marker_until_both_decision_indexes_install`、`schema_42_repairs_one_missing_or_wrong_shape_decision_index_alone`、`schema_42_decision_indexes_each_serve_a_lookup_the_other_cannot`、`tests/workspace_migration_supervisor.rs::schema_41_workspace_without_decision_indexes_shadow_migrates_to_42`（共有 Rust）。

計測（PR #636 本文。seed の A2+A3、SQLite progress callback の interval 1。admission は全行で不変。CI の run ではなくローカルの計測）：

| 無関係 Revision | decided | index なし | v42（index あり） |
|---|---|---|---|
| 0 | なし | 7,410 | 7,426 |
| 6,000 | なし | 7,410 | 7,426 |
| 600 | あり | 15,810 | 7,428 |
| 6,000 | あり | 91,410 | 7,428 |

query の上限は 100,000 steps で、変えていない。index なしでは decided な無関係 Revision が 6,000件で 91,410 steps になり、上限に近づく。これが CR-1 の初版で CQ-2 を HOLD として報告した理由（D3）で、CR-1b の schema v42 で閉じた（D6、D7）。

判定：充足。

### 2.5. CQ-3：非開示 bridge・方向違い・巨大行・上限・取消

条件：禁止寄与 0、部分 Graph なし、Raw 非占有、実 cleanup。

- 非開示 bridge：`oracle_tests.rs::ineligible_intermediate_bridges_do_not_reach_an_otherwise_qualified_entity`。未承認と将来 Scope の2種類の bridge で、端点の node も含めて出力に現れず、期待どおりの projection と一致する（共有 Rust）。
- 方向違い：`tests.rs::reverse_traversal_obeys_directed_and_symmetric_relations`。directed では逆向きの edge を辿らず、symmetric では辿る（共有 Rust）。
- 巨大行（allocation と JSON 展開の前に拒否）
  - `input.rs::oversized_documents_abort_before_json_or_related_authority_reads`、`mixed_material_and_decision_bytes_consume_the_callers_budget`、`disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope`、`disclosure_rejects_auxiliary_row_cardinality_before_materialization`、`disclosure_rejects_unbounded_material_phase_rows`（共有 Rust）。
  - `candidates.rs::scalar_preflight_enforces_cumulative_bytes_and_input_bounds`（共有 Rust）。
  - `memory.rs::graph_capacity_accepts_n_and_rejects_n_plus_one`：retained 見積りの論理上限（6,291,456 B）の N／N+1（共有 Rust）。
- 上限：RB-4。取消：RB-6。
- 部分 Graph なし：上限・取消・期限の各試験が、Graph を持たない unavailable を返すことを確かめる（RB-4、RB-5、RB-6、LC-1〜LC-9 の各試験）。
- Raw 非占有
  - `c_query_worker.rs::post_ready_owner_drops_authority_but_keeps_exact_binding_claim_and_region`：READY の後、owner は workspace の authority（DB の接続）を手放し、exact binding の claim・領域・participant だけを保持する（共有 Rust）。
  - `tests.rs::native_worker_returns_fixed_q2_frame_from_real_workspace_owner`：READY の後に owner が Authority の Arc を保持していないことを確かめる（既定 worker）。
  - `tests.rs::worker_reader_uses_one_authority_connection_for_registration_and_query`：worker は借りた1本の専用接続だけを使い、独立に開いた reader での worker の登録・query を `NIR1_GRAPH_WORKER_REQUIRES_BORROWED_CONNECTION` で拒否する（共有 Rust）。
- 実 cleanup：LC-1〜LC-9。

判定：充足。

### 2.6. RB：資源の境界（proposal/6）

#### RB-1：Revision の上限（512 records／6,291,456 B）

条件：513 records と 6,291,457 B の Revision は writer が保存しない。上限の内の Revision は保存と A2 の読取ができ、B の whole-set の内なら B build で publish される。

- B の保存済み成分の guard：`nir1_entity_relation_index.rs::persisted_revision_components_are_guarded_independently`（payload と envelope を別々に、6,291,456 B は通し、6,291,457 B は拒否する）、`nir1_entity_relation.rs::graph_index_rejects_oversized_revision_before_parse_and_reuses_connection`（承認済みの Revision の 6 MiB を超える payload を、parse の前に、typed `CapacityExceeded`（`persisted-revision-component-bytes exceeds 6291456`）で、build、source の読取、complete registration のどれでも拒否し、接続を再利用できる）（共有 Rust）。B-GUARD（2026-10-14）で、この guard は承認済みの Revision にだけ効くようにした。承認されていない Revision（下書き、却下、保留）は、大きさに関わらず roster に入らないので、parse も確保もせずに除いて build を続ける（`nir1_entity_relation_index.rs::oversized_component_refuses_the_build_only_for_an_approved_revision`、`component_exactly_at_the_limit_is_inside_the_guard_whatever_the_approval`、`nir1_entity_relation.rs::graph_index_builds_around_oversized_drafts_and_rejections_until_one_is_approved`、maintenance の経路の `nir1_graph_index_maintenance_tests.rs::oversized_drafts_and_rejections_do_not_stop_the_build`、`oversized_approved_revision_is_a_typed_refusal_until_its_approval_is_cancelled`、`oversized_approved_revision_refuses_the_readers_registration`）。詳しくは §7.1 の「B-GUARD の後」。
- U6 の control：`nir1_entity_relation_index.rs::whole_set_input_limit_refuses_without_replacing_the_sealed_generation` が、payload と envelope がちょうど 6,291,456 B の承認済みの候補を prepare が admit することを確かめる（RB-7）。成分の guard が拒否するのは承認済みの Revision だけ（B-GUARD）なので、候補は proposal の status を `approved` にしてある。guard が上限ちょうどを拒否する off-by-one（`<=` を `<` にする）を入れると、payload だけ、envelope だけ、両方のどれでも、この control が `persisted-revision-component-bytes exceeds 6291456` で失敗する（実測）。上限ちょうどの境界は unit 試験 `component_exactly_at_the_limit_is_inside_the_guard_whatever_the_approval` も押さえる。
- writer の N／N+1（CR-2）：bundle は alice の Evidence を 507 件にして 512 records に合わせ、参照されない Evidence の識別子の padding で counted の bytes を合わせる（padding の 1 B は counted で 1 回だけ数えられる）。
  - `nir1_entity_relation.rs::typed_writer_saves_512_records_at_exactly_6_291_456_input_bytes`：512 records、ちょうど 6,291,456 B の bundle が `validate_entity_relation_bundle` を通り、writer が保存し、承認の後に A2 reader が `Available` で読む（共有 Rust）。
  - `typed_writer_refuses_over_limit_revisions_without_partial_rows`：513 records は `NIR1_ENTITY_RELATION_INPUT_INVALID`（`exceeds the request envelope`）、6,291,457 B は同じコードで `graph input exceeds the request memory envelope` として拒否される。拒否された呼出しの前後で全 table の行数と既存の typed Revision の payload が変わらず、接続は autocommit のままである（共有 Rust）。
- B の publish（CR-2）：`tests.rs::b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses`。counted 2,621,440 B（2.5 MiB）の Revision を保存し、承認して A2 reader で読み、B build が publish する（`read_eligibility_source` の roster にその Revision が入る）。本番の worker 構成の query は、per-Revision preflight（2,097,152 B）がこの Revision で query 全体を拒否する（寄与 0。proposal/6 の「2〜6 MiB の Revision は、保存と A2 の読取はできても、Graph では使えない」）。試験は、A2 の admission がこの Revision を `NIR1_GRAPH_REVISION_INPUT_LIMIT` で拒否することも assert する（G-2 の負例と同じ確認）。この Revision は B の成分 guard の内側にあるだけで、writer の上限の近傍ではない。

判定：一部充足。writer の 512／513 records と 6,291,456／6,291,457 B の N／N+1、上限ちょうどの保存と A2 の読取は充足（CR-2）。B の publish は counted 2,621,440 B までしか確かめていない。上限近傍の正例は、契約の条件と実装が食い違うため、試験を足しても満たせない（[precheck]。G-1、§7.1）。

#### RB-2：per-Revision preflight（2,097,152 B）

条件：2,097,152 B の内の Revision は通常どおり Graph に使われる。2,097,153 B 以上の Revision が seed から辿った候補にあれば、その query 全体を拒否し、Graph の寄与 0 で R+IR に戻る。

- N+1 の拒否：`input.rs::oversized_documents_abort_before_json_or_related_authority_reads`（payload または envelope が `INPUT_BYTES + 1`）、`disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope`（payload_bytes、Scene 本文、phase、scope の内容が `INPUT_BYTES + 1`）（共有 Rust）。累積 bytes は N で通り、N-1 で拒否される。
- 固定値：A2／A3 の preflight の定数は `input.rs` の `INPUT_BYTES = 2 * 1024 * 1024`。CR-1 は変えていない。CR-2 も変えていない。
- N と N+1 の query（CR-2）：本番の worker 構成の in-process で query する。構成は `query_for_worker_with_maintenance_deadline`（maintenance owner、SQL 100,000 steps、期限は試験の慣例の 2 秒。製品の 100 ms の lease は RB-5 で確かめる）である。fixture は seed の Revision と、承認済みの候補 1 件だけにした。承認済みの Revision は 1 件あたり約 33,400 SQL steps を使い、3 件で本番の上限 100,000 に届く（§2.11）。候補は decision 行の padding で A2 の admission をちょうど目標の bytes に合わせる（A2 は decision_json を 1 回数える。Graph の応答には載らない）。padding の量は、別の使い捨て fixture で base と傾きを測って決める。
  - `tests.rs::worker_query_admits_a_candidate_at_exactly_the_per_revision_preflight_limit`：候補の A2 の admission がちょうど 2,097,152 B のとき、query は available で、seed と候補の両方の edge が Graph に入る（共有 Rust）。
  - `query_refuses_the_whole_graph_when_a_candidate_is_one_byte_over`：seed だけの Graph は先に available。候補が 2,097,153 B になると、A2 の admission が `NIR1_GRAPH_REVISION_INPUT_LIMIT` で拒否され、同じ構成の query は全体が unavailable になって Graph と scope_revision を持たない。理由は steps と deadline の artifact ではない（共有 Rust）。
  - G-1 の `b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses`：B が publish した counted 2,621,440 B の Revision を含む query も、同じ構成で全体が拒否される（RB-1）。
- 経路と限界：上の試験は worker 経路で、ordinary reader の結果ではない（§2.1）。通常の allocator の in-process なので、worker binary の固定 allocator（query 4,718,592 B）が N の候補を処理できることは示さない。release の実 worker は、ちょうど N の候補を持つ project の起動時の registration で異常終了した（G-2 の [precheck]、§7.2）。

判定：一部充足。preflight の N／N+1（A2 の admission が 2,097,152 B と一致し、2,097,153 B は `NIR1_GRAPH_REVISION_INPUT_LIMIT`）と、本番の worker 構成（in-process）での query 全体の正例と負例は充足（CR-2）。固定 allocator の実 worker での正例は、確認済みの 2 つの固定値（per-Revision preflight 2,097,152 B と worker の Q arena 4,718,592 B）が両立しないため [precheck]（G-2、§7.2）。

#### RB-3：Packing の入力の合計（2 MiB）

条件：入力の合計が 2 MiB を超えたら、保存サイズにかかわらず準備全体が typed refusal になる。この行は Packing を変えない。

- `nir1_packing_tests.rs::pooled_candidate_bytes_and_items_share_the_existing_envelope`：共有の入力 bytes がちょうど `MAX_PACKING_INPUT_BYTES` で通り、超えると `MAX_PACKING_INPUT_BYTES` で拒否する。item の上限も同じ envelope を共有する（共有 Rust）。
- `nir1_entity_relation.rs::native_a2_budget_rejects_repeated_relation_large_endpoint_evidence`：保存されている Evidence は 600,000 B の1件だが、100本の relation の端点として繰り返し展開した入力の合計が 2 MiB を超え、`MAX_PACKING_INPUT_BYTES` の typed refusal になる。保存サイズではなく、入力の合計で判定する（共有 Rust）。
- `nir1_entity_relation.rs::native_entity_relation_prepare_approve_current_reader_packs_closed_accepted_ir`：512 items まで通り、513 items は `projected item count 513 exceeds MAX_PACKING_ITEMS 512` で adaptation の前に拒否する（共有 Rust）。

判定：充足。CR-1 は Packing を変えていない。

#### RB-4：query の上限

条件：次のどれも、部分 Graph を出さずに unavailable になる。read／admission 512 の超過（513件目）、batch `16x32` を超える候補、SQL 100,000 VM steps の超過、過大な request や frame、後続 bytes、使用中の枠、reader／busy の競合（wait 0）。

- 513件目の record
  - `tests.rs::native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge`：Q512 の fixture に無関係な edge を1本足すと、実 worker が `disclosure-record-limit` で unavailable になり、cleanup を証明してから claim を返す（既定 worker）。
  - `tests.rs::oversized_seed_candidate_set_is_refused_without_partial_graph`（seed 上に513件の decoy）、`oversized_hop1_candidate_set_is_refused_at_a_partial_page_boundary`（hop 1 に600件の decoy。page の途中で上限に達しても残りを調べて拒否する）、`oracle_tests.rs::same_source_stale_reverse_rows_are_budgeted_without_partial_graph`（同じ Source の古い reverse-index 512行）。いずれも `query-budget-or-validation-failed` で Graph を出さない（共有 Rust）。
- batch 16x32：16件ごとの page 読取は `candidates.rs::source_seek_pages_include_decoys_and_ignore_unrelated_rows` が固定し、512行の上限に達する query は上の試験が拒否する。32 page という page 数だけを単独で超える試験は無い（16行ずつの page で、512行の上限が先に効く）。
- SQL 100,000 steps
  - `tests.rs::native_worker_refuses_after_actual_sql_steps_over_cap`：実 worker が実際の SQL steps の超過で unavailable になる。reason は `query-worker-post-stamp-steps-pre-cleanup-work-failed-steps` で、deadline、record-limit、NOMEM、pipe、cleanup 未証明のいずれでもないことを確かめる（既定 worker）。
  - `tests.rs::exhausted_deadline_or_sql_budget_rolls_back_actual_connection`：deadline を0、または steps を0にすると unavailable になり、transaction を残さず、続く query が通る（共有 Rust）。
  - Q512 の試験は `QUERY_SQL_STEPS == 100_000` を assert する（既定 worker、practical）。
- request と frame
  - `tests.rs::native_worker_rejects_request_and_frame_length_n_plus_one`：request が上限+1 B のとき owner が handoff の前に `NIR1_GRAPH_WORKER_REQUEST_LIMIT` で拒否し、frame の長さの宣言が上限+1 のとき body を読まず `NIR1_GRAPH_FRAME_LIMIT` で拒否する（既定 worker）。
  - `c_query_worker.rs::native_region_bounds_request_and_frame`：request と frame の長さの N／N+1 と、capacity の上限（共有 Rust。既定 worker の script も単独で走らせる）。
  - `worker_frame.rs::malformed_child_frame_rejected_before_view`（共有 Rust。既定 worker の script も単独で走らせる）。
- 後続 bytes・不完全な frame：`native_worker_rejects_committed_q2_frame_with_trailing_data`（terminal-refusals）、`native_worker_rejects_complete_q2_frame_with_partial_terminal_marker`（terminal-refusals）、`native_worker_rejects_declared_q2_frame_with_partial_body`（frame-lifecycle）、`c_query_worker.rs::terminal_commit_rejects_missing_partial_wrong_and_trailing_bytes`（共有 Rust）。
- 使用中の枠（待たずに unavailable）
  - `c_query_worker.rs::native_static_slot_is_exclusive_and_resets_after_retirement`：process 全体で枠は1つで、使用中の2つ目の確保は待たずに失敗する（共有 Rust）。
  - `tests.rs::native_worker_crashes_after_q2_ack_before_frame`（`NIR1_GRAPH_WORKER_BUSY`）、`native_worker_quarantines_live_request_writer_after_cleanup_timeout`（`NIR1_GRAPH_WORKER_CAPACITY_BUSY`）（既定 worker）。
- reader の競合：`tests.rs::worker_reader_restore_admitted_during_query_read_refuses_result`（query の SQL 読取の最中に Restore が admit されると結果を拒否し、transaction を残さない）、`committed_external_write_invalidates_registration_without_partial_output`（共有 Rust）。
- SQLITE_BUSY（CR-2）：`tests.rs::busy_database_refuses_both_reader_paths_without_waiting`。fixture を rollback journal（`journal_mode=DELETE`）に切り替え、別接続の `BEGIN EXCLUSIVE` で書込み lock を持たせる。ordinary reader（接続自身の `busy_timeout` 0）と worker 経路（本番の maintenance scope が `busy_timeout` を 0 に上書きするので、本番の設定を通る）のどちらも、1 秒未満で、部分 Graph なしに unavailable を返す。lock を解放すると、両方の経路が available に戻る（共有 Rust）。
  - 範囲：待ち時間の上限（1 秒）が検出するのは、約 0.5 秒以上の `busy_timeout` である。busy の間、query は本体の最初の読取と post-stamp の 2 回 `SQLITE_BUSY` に当たるので、timeout T は約 2T になる。既定の 5 秒（rusqlite）への退行は検出するが、100 ms 程度の短い非 0 の値は通る。
  - 方式と対象外：WAL では、別接続の `BEGIN EXCLUSIVE` は reader を止めず（実験で available、17 ms）、reader の接続がある間は `locking_mode=EXCLUSIVE` の保持者も作れない。そのため rollback journal に切り替えて注入した。WAL にだけある busy の原因（recovery、SQLite 内部の WAL の再試行）は注入していない。

判定：充足。CR-1 で一部充足だった理由（G-3）を CR-2 の試験が埋めた。上の範囲と対象外（WAL 固有の busy）を受け入れた判定である。

#### RB-5：100 ms result lease

条件：Q512 が parent admission から 100 ms の内に valid な result lease を返す（startup と cleanup の待ちは含めない）。100 ms を過ぎた結果は採用しない。

- 正例
  - Q512（charged rows 512）の実 worker：`tests.rs::native_worker_returns_canonical_512_a3_eligible_seed_local_graph`。call と admission→lease が `QUERY_DEADLINE`（100 ms）以下であることを assert し、frame を独立した Gold と比べる（既定 worker、practical）。観測値は §4（約 19〜26 ms）。
  - `tests.rs::production_query_has_an_available_100ms_success_path`：production の reader が 100 ms の内に available を返す（lifecycle。hosted の観測は 4.5〜4.6 ms）。
  - `tests.rs::native_worker_returns_canonical_512_a3_eligible_registry33_seed_local_graph`：registry 33行の fixture で charged rows 512（lifecycle。hosted の観測は H1〜H3 で 8.3〜8.4 ms）。
  - lease を返したときに child がまだ生きている case：`native_worker_reaps_live_committed_child_after_result_lease`（lifecycle。hosted の観測は、lease までの call が H1〜H3 で 7.6〜7.8 ms）。
- 期限後の結果の不採用
  - `c_query_worker.rs::deadline_refusal_identifies_whether_frame_was_validated_in_time`：frame の検証が 100 ms ちょうどなら timely、100 ms + 1 ns なら timely ではない、と分類する（共有 Rust）。
  - `tests.rs::native_worker_refuses_committed_q2_frame_without_eof`：frame と commit は timely に観測したが EOF が無いため、100 ms の境界で lease を出さず、SIGKILL と EOF と reader の join を証明してから claim を返す（frame-lifecycle。Linux のみ）。
  - `tests.rs::native_worker_handles_backpressured_request_writes` の deadline の case：request の書込みが詰まったまま 100 ms を過ぎると `NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`（lifecycle）。
- 固定値：`QUERY_DEADLINE == 100 ms` を Q512 の試験と `fixed_worker_arena_replaces_only_the_transient_reader_reserve` が assert する。CR-1 は変えていない。

判定：充足。

#### RB-6：取消

条件：取消は 1,000 steps ごとと Rust の境界で観測し、取消でも部分 Graph を出さない。

- `tests.rs::native_worker_cancels_after_request_admission_and_retires_before_reloan`：request が admit された後、frame が出る前に呼び出し側が取り消すと、deadline や故障とは別の `NIR1_GRAPH_WORKER_CALLER_CANCELLED` で拒否し、lease を出さず、child の exit・EOF・reader の join を証明してから claim を返す（cancellation。3 OS）。
- `native_worker_handles_backpressured_request_writes` の cancel の case：書込みが詰まっている最中の取消（lifecycle。Linux）。
- `tests.rs::cancellation_is_sticky_and_close_releases_physical_connection_and_participant`：取消は固定され、以後の query は unavailable で、close が接続と participant を解放する（共有 Rust）。
- `tests.rs::worker_registration_observes_cancellation_during_postflight_identity`：登録の最後の確認の最中の取消でも registration を公開しない（共有 Rust）。
- `exhausted_deadline_or_sql_budget_rolls_back_actual_connection`（RB-4）。
- JSON・material の処理中の取消（B 側）：`nir1_entity_relation_index.rs::graph_work_control_cancels_streamed_digest`、`graph_work_control_cancels_long_serialization_and_hash`、`graph_sql_cancellation_clears_the_progress_handler_without_a_build_budget`、`nir1_entity_relation.rs::graph_prepare_cancels_during_native_roster_read_and_reuses_connection`（共有 Rust）。

注：1,000 steps ごとという間隔の値そのものを assert する試験は無い（実装の定数）。取消の観測は、上の試験が取消の結果で確かめる。

判定：充足。

#### RB-7：B whole-set の安全失敗（U6）

条件：成分が 6,291,456 B 以下の Revision で、B の whole-set の上限を超えたときは、typed refusal になり、partial generation を出さず、旧 sealed generation を残し、Graph は R+IR に戻る。

- `nir1_entity_relation_index.rs::whole_set_input_limit_refuses_without_replacing_the_sealed_generation`：実 writer で作った Revision から sealed を publish したあと、payload と envelope がちょうど 6,291,456 B の承認済みの候補（proposal の status は `approved`）を足す。12 MiB のままなら prepare は通る（control。承認済みなので成分の guard が効き、上限ちょうどの off-by-one はここで失敗する）。同じ Revision に 5 MiB の Decision を足して合計だけを 16 MiB 超にすると、payload と envelope はちょうど 6,291,456 B のまま、typed `CapacityExceeded`（`input-bytes exceeds 16777216`）になる。拒否の前に、両方の bytes がちょうど 6,291,456 B であることを assert する。成分の guard（`persisted-revision-component-bytes`）による拒否ではないことを確かめる。binding の読取と Graph 面の7 table が byte 一致のまま registered であり続ける（共有 Rust。CR-1 の D4）。B-GUARD も同じ試験の後段で確かめる：その候補の承認を取り消し（proposal と Decision を `rejected` にする）、payload を 1 B 超（6,291,457 B）にしても、5 MiB の Decision と合わせた合計は whole-set の `input-bytes` で拒否される（未承認の候補の bytes も数える）。Decision だけを縮めて合計を 16 MiB の内に戻すと、成分の guard では拒否されず、候補が除かれて prepare が通る。

判定：充足。独立受入れの P3 が残る：この試験は read transaction 内の prepare（読取専用）の検査で、「R+IR に戻る」ことは確かめていない。製品の B build 経路（prepare から publish までを回す owned maintenance）は、B-ROUTE（#643）で maintenance の経路（work kind `nir1-graph-index-build`）に配線済みである。B-close の数値を超えたときの typed refusal と旧 sealed の維持は、その経路の試験 `nir1_graph_index_maintenance_tests.rs::capacity_n_plus_one_is_refused_without_partial_and_retried_on_change` が確かめている。ただし起動 gate は既定で閉じていて（検証済みの journey seam でだけ開く）、製品の自動実行は PUB-G まで閉じたままである。「R+IR に戻る」ことの製品経路での確認は C-product（CP-1〜CP-4）で行う。

#### RB-8：proposal/5 の正例・負例（proposal/6 は変えない）

- 正例（再 build と cold reopen の後の path と Evidence の一致）
  - 再 build の後：Q512 の試験が index を prepare と publish で作り直したあと、別 process の worker が DB を開き直して返した frame を、独立した Gold と比べる（CQ-1。既定 worker、practical）。
  - B の sealed roster と、cold reopen の後の binding の再検証：`nir1_entity_relation.rs::graph_index_publishes_sealed_roster_and_reopens_complete`（roster の Evidence 2件、edge 4本、generation、dirty が 0）、`graph_index_file_backed_cold_reopen_revalidates_binding`（DB を閉じて開き直しても registered と complete registered で、依存 graph の検証が通る）（共有 Rust）。query の path を cold reopen の後に比べる試験は、この2件には無い。
- stale・dirty・unqualified edge：CQ-1、CQ-3 の試験。allocation の前の拒否：CQ-3。JSON・material の処理中の取消：RB-6。
- wrong／unknown seed、3 hop、Entity 12／edge 展開 144（CR-2）。CR-1 までの C-query の試験は、実在する seed と 2 hop までの正例だけを使い、`seed-not-found` と `hop >= MAX_GRAPH_HOPS` の分岐には試験が無かった。
  - 経路：3 hop と Entity 12／13 の試験は、ordinary reader（`query`）で走査と上限の論理を確かめる試験で、同じ fixture を本番の worker 構成（in-process。`query_for_worker_with_maintenance_deadline`、maintenance owner、SQL 100,000 steps）でも確かめる。worker 構成を足したのは、worker 経路の control（stop と progress の check）にも、多 hop・多 Entity の走査を通すためである。どちらの fixture も承認済み Revision 1 件で、本番の steps の内に収まる。edge 144／145 は steps を外すので ordinary reader だけである。どの試験も通常の allocator の in-process で、worker binary の固定 allocator は通らない（§2.1）。
  - wrong／unknown seed：`tests.rs::unknown_and_foreign_seeds_are_refused_as_seed_not_found_on_both_reader_paths`。存在しない seed と、他 project にだけある seed を、ordinary reader と worker 経路の両方が `seed-not-found` の unavailable にする。登録済みの seed は続けて available を返す（共有 Rust）。
  - 3 hop：`two_hop_limit_stops_before_a_third_hop`。alice→bob→carol→dave の鎖で、alice からは dave（3 hop 目）に届かず、hop は alice 0、bob 1、carol 2、edge は 2 本になる。bob からは dave が 2 hop で入る。同じ hop と edge を、ordinary reader と本番の worker 構成の両方で確かめる（共有 Rust）。
  - Entity 12：`twelve_discovered_entities_are_admitted_and_the_thirteenth_is_refused`。seed を含めて 12 件の Graph（relation 10 本の fan）は、ordinary reader と本番の worker 構成のどちらでも、本番の steps（100,000）の内で available になり、nodes は 12 件である。13 件になる Graph（relation 11 本）は、部分 Graph なしで unavailable になる。ordinary reader は steps の上限を外した（10,000,000）条件でも同じ拒否になるので、steps の artifact ではない。worker 構成の拒否の理由には steps も deadline も含まれない（共有 Rust。別の実験で、ordinary reader の拒否が `NIR1_GRAPH_NODE_LIMIT` によることを確かめた）。
  - edge 展開 144：`one_hundred_forty_four_distinct_edges_are_admitted_and_the_145th_is_refused`。alice→bob の並行 edge 143 本と seed の edge で distinct 144 本の Graph は、steps の上限を外した条件で available（edges 144、nodes 2）。145 本になる Graph は拒否される。本番の steps でも拒否されるが、144 本に届く形は約 247,000 steps を要し、本番では steps が先に効く。そのため 144／145 の意味上の上限は、steps を外した ordinary reader の論理の試験で確かめた（共有 Rust。別の実験で、145 本目の拒否が `NIR1_GRAPH_EDGE_LIMIT` によることを確かめた）。
  - 12 と 144 の読み方：どちらも意味上の上限を確かめる論理の試験で、本番の steps の内で届くかは別である。Entity の多い形（承認済み Revision が複数）では 12 も steps が先に効く（§2.11）。
- Scene 8：CR-2 では試験していない。CP-1 の受入れに移す（G-4、§7.3）。

判定：一部充足。unknown／wrong seed、3 hop、Entity 12／13、edge 144／145 は充足（CR-2）。Scene 8 は CP-1 の受入れで確かめる（G-4）。

### 2.7. LC：lifecycle・cleanup（維持する機能・workload・認可契約）

条件：[C-query 資源・lifecycle 境界](nir1-c-query-memory-enforcement-v1-draft.md) の「維持する機能・workload・認可契約」が挙げる、startup、stalled stdin write、receive、cancel／deadline、workspace switch／Restore／old binding、crash／incomplete／trailing frame、lease と reap の両順序、unproved cleanup、Q／S allocation の origin。child・pipe・claim・reader・workspace protection の唯一の owner が、child の exit、必要な EOF、reader の join の成功を証明してから再利用し、証明できなければ quarantine する。

proposal/6 の Recovery（拒否、取消、期限切れの後に、部分的な結果や generation を残さず、owner が後始末し、証明できなければ quarantine し、次の query は新しく始める）も、この LC-1〜LC-9 で確かめる。「B は次の owned maintenance で sealed head から作り直す」は LC-1〜LC-9 の対象外である。製品の B build 経路は B-ROUTE（#643）で maintenance の経路に配線されたので、その経路の試験（`nir1_graph_index_maintenance_tests.rs`）と C-product で確かめる。起動 gate は既定で閉じていて、製品の自動実行は PUB-G まで閉じている（RB-7）。

OS の範囲：lifecycle lane の14件は Linux のみ。subreaper、SIGSTOP、`/proc`、SIGABRT などの Linux の機能に依る case を含む。3 OS で走るのは、既定 worker 11件と、cancellation、startup-refusal、terminal-refusals、frame-lifecycle の各 lane である。macOS と Windows に、lifecycle lane と同じ case の証跡は無い（frame-lifecycle の missing-EOF も Linux のみ）。

| ID | 項目 | 試験（場所） |
|---|---|---|
| LC-1 | startup | `native_worker_reports_canonical_registration_refusal_before_ready`：登録されていない project で READY の前に固定の拒否理由を返し、cleanup を証明する（startup-refusal。3 OS）。正常な READY は実 worker の全試験が通る |
| LC-2 | stalled stdin write | `native_worker_handles_backpressured_request_writes`（書込みが詰まったまま、取消・deadline・child の exit の3 case。部分書込みで止まり `OWNER_REQUEST` を出さず、writer の join・exit・EOF・reader の join を証明してから claim を返す。lifecycle）、`native_worker_quarantines_live_request_writer_after_cleanup_timeout`（writer が生きたまま cleanup の期限を過ぎると claim・枠・workspace の fence を保持して quarantine する。既定 worker）、`c_query_worker.rs::request_writer_panic_keeps_claim_quarantined_after_handle_consumption`（frame-lifecycle。3 OS） |
| LC-3 | receive | `native_worker_rejects_declared_q2_frame_with_partial_body`（frame-lifecycle）、`native_worker_rejects_complete_q2_frame_with_partial_terminal_marker`、`native_worker_rejects_committed_q2_frame_with_trailing_data`（terminal-refusals）、`native_worker_refuses_committed_q2_frame_without_eof`（frame-lifecycle。Linux）、`native_worker_rejects_request_and_frame_length_n_plus_one`（既定 worker）、`worker_frame.rs::malformed_child_frame_rejected_before_view`、`c_query_worker.rs::terminal_commit_requires_exact_marker_and_eof_without_trailing_data`（共有 Rust） |
| LC-4 | cancel／deadline | RB-5、RB-6 の試験。`c_query_worker.rs::query_polling_accelerates_only_unobserved_exit_after_frame_and_obeys_deadline`（共有 Rust） |
| LC-5 | workspace switch／Restore／old binding | `native_worker_quarantine_blocks_w1_restore_and_retains_shared_lease`（quarantine 中は W1 の Restore の admission が保持され、exclusive を取れず、共有の file lease が残り、Restore の DB I/O が無い。lifecycle。Linux）、`native_worker_cleanup_unproved_without_file_identity_retains_participant_and_blocks_io`（lifecycle。Linux）、`worker_reader_restore_admitted_during_query_read_refuses_result`、`runtime_pause_resume_never_revives_an_old_reader`（共有 Rust） |
| LC-6 | crash／incomplete／trailing frame | `native_worker_crashes_after_q2_ack_before_frame`（admit 済みの child の crash。固定の理由で拒否し、cleanup を証明して同じ authority で再 loan できる。既定 worker）、`native_worker_exits_after_owner_process_dies_after_request_admission`（owner の process が SIGKILL された後、worker が非0 で exit し reap される。lifecycle。Linux）、`native_worker_retires_after_real_child_rust_oom`（SIGABRT を観測し lease なし。lifecycle。Linux）、`native_worker_refuses_after_real_child_sqlite_nomem`（exit code 26、lease なし。lifecycle）、LC-3 の各試験 |
| LC-7 | lease と reap の両順序 | `native_worker_accepts_committed_q2_frame_before_nonzero_exit`（commit の後に child が exit 23 しても受理済みの結果を失効させない。既定 worker）、`native_worker_reaps_live_committed_child_after_result_lease`（lease の返却時に child が生きていて、lease の drop で SIGKILL・exit・EOF・reader の join を観測してから claim を返す。lifecycle。Linux） |
| LC-8 | unproved cleanup | `native_worker_quarantines_when_cleanup_proof_is_unobserved`（cleanup の期限 500 ms を過ぎて quarantine。lifecycle）、`native_worker_quarantines_result_lease_when_exit_proof_transfer_is_unavailable`、`native_worker_quarantines_result_lease_when_reader_join_fails`、`native_worker_quarantines_result_lease_when_reader_completion_exceeds_cleanup_deadline`（いずれも claim・枠・workspace の fence を保持し、同じ workspace の再 loan を `WORKSPACE_SWITCHING` で拒否する。lifecycle。Linux） |
| LC-9 | allocation の origin | `nir1-c-query-worker` の bin の試験 `q_s_origins_no_fallback_failed_realloc_and_zero_live_seal`（既定 worker の script が単独で走らせる） |

判定：充足。lifecycle lane の hosted の観測：Rust OOM の case は SIGABRT を観測し、call から拒否まで 0.39 ms（H2）、0.49 ms（H3）。cleanup 未証明の case の call から error まで約 508〜510 ms（H2、H3。query の期限 100 ms、cleanup の期限 500 ms）。

### 2.8. PF-1：有限の実用確認

条件（post-B §6.4）：同一の Native parent process で Q512 を30回逐次実行し、各回の lease の release と実 worker の reap を次回の前に確認する。既存の maximum fixture を1回実行する。fixture の規模、環境、parent と worker の観測使用量、reap の後の resource を記録する。具体的な retention、継続的な growth、OOM、stall があれば修正する。固定の byte／RSS の閾値は要求せず、全入力の memory 上限や leak 不存在の証明にしない。

- `tests.rs::native_worker_practical_retention_q512_30x` と `native_worker_returns_canonical_512_a3_eligible_seed_local_graph`（practical。Linux のみ）。各回で frame を Gold と比べ、100 ms の内に lease を得て、lease の release の後に exit・EOF・reader の join と claim の再 loan と participant 0 を確かめる。
- 観測値は §4。

判定：充足。具体的な retention、growth、OOM、stall は観測されていない（H1〜H3。値は §4）。

### 2.9. A-1：製品 Graph 入口は閉じたまま

条件：直接 IPC、Native、試験入口、旧 route からの呼出しは未公開機能として拒否される。Graph の公開だけでは送信は 0 のまま。

- `electron/native/grimodex-node/src/nir1_graph_activation_tests.rs::direct_native_graph_requests_cannot_reach_the_unactivated_reader`：Native の `nir1_graph_query` に、試験用の flag や空の payload を含むどの要求を渡しても `NIR1_GRAPH_NOT_ACTIVATED` で拒否する（native）。H3 の ordinary CI では `Electron native` が success（§3.3）。H2 の Full の native part でもこの試験は ok だったが、同じ `cargo test` の別の試験が失敗して part は failure になり、`electron.unit` は fail-fast で走っていない（§3.2、§3.3）。
- `electron/shared/nir1GraphIpcContract.test.ts`（6件）：renderer の IPC から `nir1_graph_query` を呼ぶと `IPC_UNIMPLEMENTED: nir1_graph_query` になり、backend を呼ばない。renderer が資格の metadata を付けた packing の入力も、Native に渡す前に拒否する（vitest）。
- CR-1 は worker、NQG1、閾値、製品の Graph 入口を変えていない。CR-1 の差分に `nir1_graph.rs`、`c_query_worker.rs`、`worker_frame.rs`、worker の bin は含まれない（`git diff` で確認）。製品コードの変更は schema v42 の index 2本と、`input.rs` の SQL 文字列の定数化（同一の文面）だけである。

判定：充足。

### 2.10. NB-1：normal-build acceptance

残HOLD表の「normal-build acceptance」は、seam を含まない通常 build の worker（`nir1-c-query-worker`）で、実 worker 試験が通ること、と読む。この読み方は integrator が確定した。根拠は、`scripts/nir1-c-query-worker-ci.sh` が通常 build の worker と seam build の worker を別の `cargo build` で作り、case ごとに使う worker を分けていること。seam（`nir1-c-query-test-seam` feature）は故障の注入にだけ使い、通常 build には含めない。

- 通常 build の worker で走る試験：`tests.rs::native_worker_returns_fixed_q2_frame_from_real_workspace_owner`、`native_worker_quarantines_live_request_writer_after_cleanup_timeout`、`native_worker_returns_canonical_512_a3_eligible_seed_local_graph`、`native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge`（既定 worker）、`native_worker_reports_canonical_registration_refusal_before_ready`（startup-refusal）、`native_worker_practical_retention_q512_30x`（practical）、lifecycle の5件（`native_worker_exits_after_owner_process_dies_after_request_admission`、`native_worker_quarantines_when_cleanup_proof_is_unobserved`、`native_worker_quarantine_blocks_w1_restore_and_retains_shared_lease`、`native_worker_cleanup_unproved_without_file_identity_retains_participant_and_blocks_io`、`native_worker_returns_canonical_512_a3_eligible_registry33_seed_local_graph`）。
- seam build の worker でしか注入できない故障（commit の後の非0 exit、admit の後の crash、SQL steps の超過、frame の長さの N+1、取消、後続 bytes・不完全な frame・EOF なし、request 書込みの詰まり、OOM・NOMEM、lease の後の cleanup 未証明など）は、seam build の worker で走る。これらは通常 build の worker の挙動の代わりにはならないが、通常 build の worker の機能・lifecycle・資源安全は、上の試験で確かめる。

判定：充足。

### 2.11. 観測した制約（CR-2。判定を変えない記録）

CR-2 の調査と SPIKE（steps の内訳の計測。基点 `a3f705ae` の複製で測り、製品コードは変えていない）で測った、C-query の可用性に関わる制約を記録する。どれも固定値の違反ではない。上限を超えれば部分 Graph を出さずに unavailable になり、安全側に倒れるので、上の判定は変えない。ただし proposal/6 の要点（資源の上限を、壊れたデータや巨大なデータに対する防御に絞る）とは食い違う。小さな正常データで上限に届くからである。proposal/6 の「可用性」は、この制約を挙げていない。受け入れるかどうかには、ユーザーの確認が要る。値は変えていない。

#### SQL steps

- seed だけ（2 Entity、1 relation、承認済み Revision 1 件）で約 33,600 steps。同じ形（2 Entity、1 relation）の承認済み Revision を足すと、1 件あたり約 33,400 steps 増える（2 件で約 67,000、3 件で約 100,400、5 件で約 167,200）。承認済みの Revision が 3 件で、本番の 100,000 steps に届く。2 MiB の decision padding は steps に影響しない。
- 1 つの Revision の relation を増やすと、alice→bob の並行 edge で 48 本が 67,691、96 本が 138,968、144 本が 247,112 steps になる。本番の上限に収まるのは、約 70 本までである。
- 内訳（1 Revision あたり約 33,400 steps）：sqlite_master の全件走査が 28,379 steps（85%）を占める。表の存在を確かめる `table_exists` の SQL が 1 Revision あたり 13 回走り、sqlite_master（672 行。表 202、索引 407、trigger 63。索引なし）の全件走査が 1 回 2,224 steps かかる。Revision の中身の検証ではない。残りは、A2 の preflight（集計 SQL 12 本）1,377、A3 の preflight（15 本）1,342、edge と edge state 571、D1 の declaration 本体 440、Scope authority 384 などである。relation の 2 次の項は、A2 の preflight の relation bytes の SQL 1 本（`input.rs` の `RELATED_BYTES_SQL`）だけで、費用は project の全 relation 数、Revision の relation 数、約 8.3 steps の積になる。
- 値を変えずに steps を減らす最適化を、別のレーンで進めている。T：C-query の read transaction の中だけ、`table_exists` を SQLite の C API（`sqlite3_table_column_metadata`。VM steps 0）に置き換える。J：A2 の relation bytes の SQL を、revision、`json_each`、`codex_relations`（主キー）の JOIN 順に書き換える（数える対の多重集合は同じ）。試作の実測では、Revision 1 件あたりが 33,375 から約 5,000 steps に、relation 144 本が 247,177 から約 52,000 steps になり、応答の JSON は変更前と完全に一致した。Revision の開示確認は縮めていない。この PR では実装しない。
- steps の固定値は変えない。上限を 1,000,000 に上げても、実 worker では relation の多い形が約 40 万〜50 万 steps で 100 ms の lease に先に当たり、seed 形は 512 records に先に当たる（SPIKE の計測）。単独では勧めない。
- 意味上の上限との関係：144 本の並行 edge は約 247,000 steps を要し、本番では steps が先に効く。Entity の多い形（承認済み Revision が複数）では 12 も同じである。G-4 の 12／13 と 144／145 の試験は、steps の上限を外した条件を含む論理の試験である（RB-8）。

#### 現実形の project（SPIKE。[precheck]：ユーザーの判断が要る）

CQ-AVAIL（§2.12）は、このうち records の数え方と版の衝突を、委任の内で直した。以下は CQ-AVAIL の前の観測の記録で、書き換えていない。Entity 12 の上限と、50 場面の主人公級が read／admission の 512 に届くことは、直していない。

- fixture：50 場面（5 章）、主要人物 5 人（主人公は 80% の場面に登場）、脇役 15 人、relation 22 本。場面ごとに登場人物と人物間の relation を、prepare と同じ関数で review して承認した（50 Revision）。主人公は 40 Revision に入り、2 hop で 45 Revision、13 Entity、99 edge に届く。Codex review は Scene Scope を 1 つ選んで prepare を呼ぶので、1 回の review が 1 つの Scene Scope の 1 Revision になり、場面ごとに review すると場面ごとの Revision になる。
- records：A3 の preflight が project 全体の行（tree_nodes、scene binding、registry）を Revision ごとに課金する。場面数を S とすると、1 Revision あたり約 4.2S＋54 records で、read／admission 512 に入る Revision は、S=10 で 4〜5 件、S=20 で 3 件、S=30 で 2 件、S=50 で 1 件になる（推定。S=10 と S=50 は実測と一致した）。50 場面の project では、主人公の query が 2 件目の Revision の A3 preflight で `disclosure-record-limit` になった。
- 版の衝突：場面ごとに review すると、同じ人物の `EntityInput` が場面ごとの `scope.reading` で異なり、`add_node` が別の版として `NIR1_GRAPH_ENDPOINT_VERSION_CONFLICT` で拒否する（10 場面の project で実測。すべての review の Scene Scope を同じ場面にすると、衝突は消える）。
- Entity 12：主人公級は 2 hop で 12 Entity を超える（上の fixture で 13 Entity）。
- 影響：steps の最適化（T、J）や steps の上限を上げることでは解けない。PUB-G の後の現実の project（場面 20 以上、場面ごとの review）では、Graph は unavailable のまま R+IR に戻る。今は Graph の入口が閉じている（A-1）ので、利用者への影響は無い。records の数え方を変えるか、値を変えるか、版をどう扱うかは、確認済みの契約か設計の判断に触れるので、ユーザーの確認が要る。CP-4（G-01〜G-08）の計測には、場面数十・場面ごとの review の現実形の fixture を入れることを勧める。

### 2.12. CQ-AVAIL：現実形の project の可用性（DR-CQA-1〜5）

§2.11 の SPIKE が記録した、場面ごとの review が版の衝突になることと、project 全体の行を Revision ごとに課金して records が尽きることを、委任の内で直した（branch `claude/nir1-cqavail`。base は master `92f9badd`、CQ-OPT の #657 を含む）。確認済みの固定値（512 records、6,291,456 B、2,097,152 B、100,000 steps、100 ms、request・frame の上限）と契約は変えていない。判定（§2.2）、actor、受信先、保存範囲、製品の Graph 入口（A-1）も変えていない。委任判断は次の5点で、判断の記録は実装の前に書いた（DR-CQA-4 と 5 は、レビュー指摘の修正の前に書いた）。

| ID | 判断 | 境界と代替案 |
|---|---|---|
| DR-CQA-1 | Graph の node の同一性から Scope を外し、Scope は binding（Revision）ごとに持つ。Scope 以外の field（Entity ID、type、label、source token、Evidence）が食い違う本当の版の矛盾だけを拒否する。worker の frame を `NQG3` に上げ、node が binding ごとの Scope を運ぶ | A3 は Revision ごとに評価済みで、edge は exact binding を持つ。[post-B §6.3](nir1-post-b-execution-plan.md#63-sceneとevidence) の「複数 Revision の同一実 ID を結合する際も、各 edge／endpoint の exact binding を保持し、矛盾する版を名前一致で統合しない」に合う。代表の版に畳む案は §6.3 に触れるので採らない。何もしない案は、場面ごとの review で中心人物が常に unavailable になるので採らない |
| DR-CQA-2 | node 上限、edge 上限、版の衝突に型付きの理由（`node-limit`、`edge-limit`、`endpoint-version-conflict`）を与える。修飾された Revision が無い seed は、ordinary reader と同じ available の空 Graph（寄与 0）を worker も返す | 拒否の条件は変えない。空 Graph は部分 Graph ではなく、寄与 0 の available である。代替の「空 Graph を typed unavailable に揃える」は、可用性の記録で常に unavailable の状態が増えるので採らない。CP-0 の規則モデルは後者（`seed-not-qualified`）を取る。差と CP-4 の比較の読み方は「G の評価（CP-0）との関係」に記録した |
| DR-CQA-3 | project 単位の読取（Scope authority の tree、Scene binding、registry、projects、最新の Epoch、query Scene、POV）を query で 1 回だけ読み、1 回だけ admit する。Revision に結び付く行は Revision ごとに admit する | 上限の値は変えない。読取を減らさずに課金だけを減らすことはしない。読取の回数（statement）と課金の乗数を対応させる（下の probe の試験）。行の単位の対応は「課金された rows の観測」と「範囲外と残る制約」に記録した。代替の「課金だけ減らす」は閾値の緩和なので採らない |
| DR-CQA-4 | Full の resource-isolation preflight が使う `worker.q512` の reviewed inventory（`scripts/local-ci-full-workload-allocation.json`）を、新しい Q512 fixture（materials 164、registry の参照 5、材料の無い Scene 60）で導き直す。式は pages = 679 + 21×materials + 93×revisions + refs に、材料の無い Scene の項（Scene あたり 20 の table・index の面に 1 page ずつ）を足す。派生する値（fullMemoryRisk の DB の項、その合計、`docs/pr610-full-workload-risk.md` の数値）も合わせる | 見積りを増やす方向だけで（安全側）、送信先、保存範囲、閾値の緩和は無い。dataset は独立 review が前提なので、変更をこの台帳と PR 本文に残す。代替の「式を変えず 4,221 pages にする（Scene の項を足さない）」は、材料の無い Scene 60 の tree と Scene binding の行を見積りから落とすので採らない。journey の inventory（schema baseline + 旧 Q512 の mutation image）は製品 journey の書込みの size class で、C-query の fixture を開かないので、導き直さない |
| DR-CQA-5 | DR-CQA-3 の「読取と課金は 1 対 1」を、読取の回数（statement）の単位に限定する。Scope extension の LEFT JOIN が読む principal の Codex 行（knowledge holder と audience が character の binding あたり最大 2 行）は課金に入っていない。変更前から数えていない既存の会計の穴で、本変更が増やしたものではないので、課金は厳しくせず、残る制約に記録する。課金された rows を製品側で観測する試験に置き換えた | 上限の値は変えない。課金に principal の行を足す案は、課金を厳しくするので委任の範囲に入るが、A3 の SQL（`DISCLOSURE_GLOBAL_ROWS_SQL`）、診断の観測 slot、steps の基準値に波及するので、別の変更にする |

#### 変更の内容

- 版の衝突（R2）：node は Entity ID ごとに 1 つ。同一性は Scope 以外のすべての field で決める（`same_node_identity`）。`Nir1GraphNode` は `bindings[i]` と同じ順・同じ長さの `binding_scopes[i]`（その binding の Revision の Scope）を持ち、`entity` は最初の binding の版である。edge の endpoint の Scope は、edge の binding の Revision のもの（変えていない）。worker の frame は `NQG3`（`NQG1`／`NQG2` は旧版として拒否）で、node は binding ごとに「binding の 9 token と Scope」を運ぶ。Graph の `scope_revision` は optional で、無いときは node と edge が 0 でなければならない。A3 で unavailable になった Revision（query Scene と同じ Scene、またはその後の Scene の review）の binding、Scope、edge は node にも edge にも現れない。同じ人物が query Scene の前後で review されている場合も、前の review の binding だけを持つ（s005 の query で m1〜m5。`a_query_in_the_middle_of_the_novel_binds_only_the_reviews_before_its_scene`。A3 の reading の gate を開く一時的な変異で、この試験が失敗することを確かめた）。
- 内側の上限：新しい数値の上限は足していない。binding 数は既存の `MAX_GRAPH_RECORDS`（512）以下で、frame の全体は `FRAME_BYTES` のまま。binding ごとの Scope の保持量は、node の作成時に `MAX_GRAPH_RECORDS` 個分の `Arc<ScopeBinding>` を予約して課金し、binding を足すたびに Scope の複製を課金する（`admit_retained`）。frame が許す理由の組の allowlist は 686 → 926 通り（原因が 17 → 20 種）になった。node の binding は同じ Revision を 2 度含められない（node あたり 512 以下の比較で parent の `validate` が確かめ、破れた frame を `NIR1_GRAPH_FRAME_NODE_BINDING_DUPLICATE` で拒否する。node あたり 512／513 の境界は `nqg3_node_binding_cap_admits_512_and_refuses_513` が確かめる）。
- 型付きの理由と空 Graph（X2）：`node-limit` と `edge-limit` は category が Limit、`endpoint-version-conflict` は Failed（版の矛盾は上限でも stale でもない一般の失敗）。frame が空 Graph を運べず、worker と ordinary reader の結果が揃わなかったのを、同じ available の空 Graph（Scope revision なし、node と edge が 0）に揃えた。
- project 単位の読取（R1）：`Nir1ProjectReads::load` が、Scope authority の tree、Scene binding、registry、最新の Epoch、story の状態、query Scene と POV を query で 1 回読み、Revision ごとの評価（`evaluate_nir1_entity_relation_disclosure_shared`）は共有を参照する。admit は `preflight_project_reads` が 1 回（tree×2、registry×2、binding×2、projects×1、query Scene×1、POV×1、Epoch×1）、Revision ごとは `preflight_disclosure_revision`（Decision と material の行・bytes）である。数え方の変更は、registry の乗数を「Entity 数＋2」から実際の読取回数の 2 に置き換えただけで、ほかの乗数は旧来のまま。旧来の乗数が実際に読む行を常に覆うとは限らない（principal の Codex 行は数えていない。「範囲外と残る制約」）ので、「保守的な上限」とは言わない。Revision ごとの 2 MiB の preflight は、shared と own の合計が 2 MiB を超えない形で保った。
- 読取と課金の対応：`project_level_reads_are_made_once_and_charged_as_made` が、probe（`nir1_capacity::project_read_probe`）で、各 shared read が 1 回であること、registry が 2 回であること、読取を Revision ごとに戻した対照では Revision の数だけ増えることを確かめる。これは読取の回数（statement）の対応で、行の単位の対応ではない。応答は、44 の形と現実形の project で、読取を Revision ごとにした場合と一致する（`shared_reads_return_the_response_of_reading_per_revision_on_every_shape`、`..._on_a_novel`）。
- 課金された rows の観測：`a_revision_costs_its_own_rows_and_none_of_the_shared_ones` が、query が admit した rows（試験用に `QueryUsage::rows` を記録する）を、2・6・10 Revision の fixture で、保存行の数から数えた値と照合する（ordinary reader と worker の両方）。shared の行は Revision の数に依らず、Revision を足すと、その Revision 自身の行（reverse index 2、A2 5、A3 3）だけが増える。shared の課金を Revision ごとに戻すと、この試験が失敗する（一時的な変異で確認した）。保存行から数える helper の自己照合ではなく、製品の課金を見る。

#### 前後の計測

現実形の project（`tests/cq_avail.rs::measure_novel_project_availability`。章に分けた場面、主要人物 5 人、脇役 15 人、relation 22 本、場面ごとに承認済みの Codex review 1 件）の seed ごとの結果。records は候補 + A2 + shared + A3（Revision 分）、steps は上限を外した replay、production は worker 経路（steps 100,000、records 512）である。期限は負荷に左右されないよう 30 s にして測った。この表の fixture は本文の保存が無い project で、X1（本文の保存での失効。本 lane の外）の影響を含まない。実際の執筆では、別の Scene の本文を保存すると全 Revision が stale になる（現実形の検証の観測：A3 は source-revision-changed になり、B の再 publish の後は available・node 0 になる）ので、表の available は本文の保存が無い間の値であり、実際の可用性はこれより低い。

| project | seed | 変更前 | 変更後 |
|---|---|---|---|
| 10 場面、場面ごとの review | m1 | unavailable（版の衝突）。records 1,071、steps 75,590 | available。records 229（revision 9、shared 79、A3 39）、steps 47,238、node 10、edge 21 |
| 同 | m2 | unavailable。1,067 records、75,514 steps | available。225 records、47,162 steps |
| 同 | m3 | unavailable。1,065 records、75,502 steps | available。223 records、47,150 steps |
| 同 | m5 | unavailable。214 records、14,502 steps | available。100 records（revision 2）、10,755 steps |
| 同 | c01 | unavailable。941 records、67,644 steps | available。199 records（revision 8）、42,806 steps、node 7、edge 14 |
| 10 場面、すべての review を最初の場面 | m1、m2、m3、c01 | `disclosure-record-limit`。1,071、1,067、1,065、941 records | available。229、225、223、199 records |
| 同 | m5 | available。214 records、14,502 steps | available。100 records、10,750 steps |
| 50 場面、場面ごとの review | m5 | `disclosure-record-limit`。2,670 records、142,022 steps | available。344 records（revision 10、shared 239、A3 35）、47,533 steps |
| 同 | m1、m2、m3 | `disclosure-record-limit`。12,520、13,039、12,497 records、688,881、716,307、688,691 steps | `revision-record-limit`。954、967、931 records（revision 45、47、45）、227,787、234,265、227,597 steps |
| 同 | c01 | `disclosure-record-limit`。11,093 records、615,348 steps | `disclosure-record-limit`。827 records（revision 40）、206,619 steps |

`tests/cq_opt.rs` の44応答（shape × lane × variant）は、run 固有の id を除くと40が一致し、差は意図した4つだった：relations-145 の worker が `other` から `edge-limit`、star-11 の worker が `other` から `node-limit`、revisions-10 の reader と worker が `record-limit` から available。steps は全般に減った（seed 5,409 → 5,169、revisions-3 15,406 → 12,274、revisions-5 25,406 → 19,376、relations-144 52,456 → 52,216、star-10 16,399 → 16,162）。

50 場面の主人公級（m1、m2、m3、c01）は、まだ unavailable である。実作業が read／admission の 512 を超えるためで（827〜967 records。主人公が 40〜47 の Revision を辿る）、残る原因は数え方ではなく上限の値になる。値の見直しは proposal/7 の範囲で、本 lane は変えていない。

#### Q512 の fixture

数え方が変わったので、official fixture を作り直した。charged = 候補 2 + A2（2E）+ shared S + Revision（1+E）。

- 以前は registry を（E+2）回課金したので、E=70 で 512 に届いた。今は実際の読取回数の 2 で課金するので、registry の小さい 2 Scene の project で 512 に届く E は 162 になる。この形は、実 worker の call が約 52 ms で（14 run の 420 回：最小 49.3、中央値 51.8、p99 84.1、最大 92.3 ms。ローカルで他 lane の build が並行し、load average は 4〜6）、16 run のうち 2 run で 100 ms の期限を超えた（`NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`）。変更前の fixture の hosted の call（base `92f9badd` の run `38507044912`：ubuntu 18.7 ms、macos 15.3 ms、windows 26.3 ms）より期限の余裕が小さい。期限は確認済みの 100 ms で変えられないので、512 行を Entity の work だけで埋めない形にした。
- `Q512/R2/A3-eligible-shared`：Revision を作る 2 Scene に、材料を持たない Scene 60 を足した 62 Scene の project。E=82（materials 164）、registry 6 行（reference_count を 3 から 5 に）、shared 263（23 + 4×60）、Revision 83。合計 2 + 164 + 263 + 83 = 512。tree と Scene binding の行は Entity の行より安く、同じ 512 行の実 work が小さい。実 worker の call は約 30 ms（§4.1）。
- Q513（無関係な逆引き edge）：候補が 3 行になり、shared までの admitted は 430（3 + 164 + 263）。Revision 分の 83 行は残り 82 行に入らず、実 worker は `disclosure-record-limit` で拒否する。
- `Q512/R1/E144/registry33`（lifecycle lane。旧 ID は `Q512/R1/E12/registry33`）：2 Scene、registry 33 行、E=144（materials 288）、shared 77、Revision 145。合計 2 + 288 + 77 + 145 = 512。Entity の多い形を lifecycle lane に残した。実 worker の call は 44.7〜46.0 ms。
- Full の resource-isolation preflight の reviewed inventory（DR-CQA-4）：`worker.q512` の bytes と basis は fixture の形から導いた page-density の見積りなので、sha256 を付け替えるだけでなく、新しい形で導き直した。pages = 679（official schema DB の baseline）+ 21×materials + 93×revisions + refs + 20×（材料の無い Scene）。旧は 679 + 21×140 + 93 + 3 = 3,715 pages（15,216,640 B）、新は 679 + 21×164 + 93 + 5 + 20×60 = 5,421 pages（db・journal・construction が 22,204,416 B、WAL が 22,335,488 B）。この式は旧の Q2（814 pages）と Q512（3,715 pages）を正確に再現する。Scene の項の 20 は、Scene の行が書く table・index の数で、tree_nodes（table 1、index 7、主キーの autoindex 1）、FTS5 の 2 本（書き込む shadow table が 3 と 4。fixture の project は English なので両方の trigger が動く）、narrative_scene_scope_bindings（table 1、index 2、主キーの autoindex 1）である（schema-contract.json と sqlite_master の数え直し）。実際の DB は 3.5 MB（859 pages）で、この見積りは意図的に広い density の scenario である。派生する値も合わせた：fullMemoryRisk の DB の項（Q2×7 + Q512×3 + C2-ZC）が 287,883,264 → 371,859,456 B、その合計が 13,206,208,512 → 13,290,184,704 B、`docs/pr610-full-workload-risk.md` の式と数値（その sha256 を allocation の sources に反映した）。journey の inventory（33 case。schema baseline + 3,715 pages の Q512 mutation image）は、製品 journey の書込みの size class で、C-query の fixture を開く journey が無いので、導き直していない。`scripts/ci-pause.test.mjs` の `Reviewed worker.q2 and worker.q512 inventories are the page-density scenario of the fixtures they size` が、inventory が script の manifest（materials、revisions）、`Q512_FILLER_SCENES`、reference_count から式で導かれること、risk 文書の記述と合計が一致することを確かめる。次に fixture の形を変えるときは、この試験が先に失敗する。
- 変えた箇所：`nir1_capacity_fixtures.rs`（`Q512_FILLER_SCENES`、reference_count、ID）、`scripts/nir1-c-query-worker-ci.sh`（manifest と grep）、`scripts/local-ci.test.mjs`、`scripts/ci-pause.test.mjs`（manifest の定数、inventory と risk 文書の整合の試験、fullMemoryRisk の合計の定数）、`docs/local-ci-runner.md`、`docs/pr610-full-workload-risk.md`、`scripts/local-ci-full-workload-allocation.json`（`worker.q512` の bytes と basis、fullMemoryRisk の DB の項、sources の sha256）。

#### G の評価（CP-0）との関係

- 規則モデルとの差（DR-CQA-2）：CP-0 で固定した G 評価の規則モデル（`scripts/quality/nir1-graph/contract.mjs` の `evaluateGraphCaseVariant`）は、seed が適格な Revision の Entity に入らないとき、`graph.status=unavailable`、`reasonClass=seed-not-qualified` と計算する。runtime は、ordinary reader も worker も、同じ seed に available で node 0、edge 0（Graph の寄与 0）の空 Graph を返す（本 lane で worker が reader に揃った）。`graph.status` は manifest の比較 field なので、seed が適格でない variant があれば status が食い違う。現行の G-02〜G-08 の variant にそのようなものは無く（下の確認）、比較の結果は変わらない。本 lane は規則モデルも fixture も変えていない。CP-4 で seed が適格でない variant を足すときは、この組（規則モデルの unavailable・`seed-not-qualified`、runtime の available・node 0）を一致とみなす読み替えを観測の前に宣言するか、規則モデルを新しい版の fixture で改めて独立 review を取り直す。観測した後には読み替えない（CP-0 の規則）。どちらにするかは CP-4 の判断で、本 lane は決めない。
- 可用性の記録の数え方：node 0 の available は、Graph が何も寄与していない状態である。seed に適格な Revision が無い query と、X1 の状態（本文の保存の後に B を再 publish した状態）の query は、どちらも available・node 0 を返す。可用性の記録（CP-4）では、node 0 の available を、寄与のある available と分けて数える。分けないと、Graph が何も寄与しない状態が可用と記録される。
- G-02〜G-08 の出力形の確認：`evals/nir1-graph/` は変更していない。12 variant（G-02 が 1、G-03 が 2、G-04〜G-07 が各 1、G-08 が 5）について、規則モデルの `evaluateGraphCaseVariant` が返す `qualifiedRevisions` と各 Revision の `reviewSceneId` を数えた（一時の script。commit していない）。適格な Revision の review Scene は G ごとに 1 つだけである（G-02 は `g02-review`、G-03 は `g03-review`、G-04 は `g04-rv-match` の `g04-r-lio` 1 件、G-05 は `g05-review`、G-06 は `g06-review`、G-07 は `g07-rv-early`、G-08 は `g08-review`）。複数の適格な Revision に入る Entity は、すべて同じ review Scene（同じ Scope）の Revision に入る。したがって node の同一性から Scope を外しても、以前 available だった Graph の node、edge、`qualifiedRevisionIds` は変わらない。`reasonClass` は status だけを比べる（`evals/nir1-graph/README.md` の対象外の節）ので、G-03 の上限 variant の worker の分類が `other`（Failed）から `node-limit`（Limit）に変わっても、比較は同じである。`node --test scripts/quality/nir1-graph/contract.test.mjs` は 23 件が通った。

#### 実 worker での確認

`scripts/nir1-c-query-worker-ci.sh` の全 mode（既定、practical-retention、lifecycle、frame-lifecycle、trailing-data、partial-terminal-marker、caller-cancellation、startup-registration-refusal）をローカル（Linux、release build）で実行して通った。新しい case `cq_avail::native_worker_answers_a_project_reviewed_scene_by_scene` を lifecycle lane に足した（script の case は 16 件から 17 件になった。§3.2 の「14件」は H1〜H3 の時点の数）。この case は、10 場面・場面ごとの review の project をその場で作り、実 worker で seed 3 つ（m1、c01、m5）を問い、Graph が ordinary reader の Graph と一致することを確かめる。call は m1 が 32〜34 ms（node 10、edge 21）、c01 が 30〜36 ms、m5 が 7.7〜9.5 ms で、100 ms の lease の内だった（ローカル、他 lane の build が並行）。レビュー指摘の修正（frame の validate、試験、dataset）の後にも、全 mode を再実行して通った（lifecycle の m1 は call 31.5 ms、node 10、edge 21、binding 26。practical の Q512 は call 約 29 ms）。

#### 範囲外と残る制約

- R3（Entity 12 と edge 144 の意味上の上限。契約で、ユーザーの判断）、X1（本文の保存での失効。X1-1 lane と契約 draft で扱う）、上限の値の見直し（proposal/7）、worker のメモリ（R4。CQ-MEM）は、本 lane で触れていない。この節の可用性の改善の表は本文の保存が無い fixture の値で、X1 の影響を含まない（「前後の計測」）。
- 50 場面の主人公級は、上のとおり 512 に届く。
- 課金に入っていない行（既存の会計の穴。DR-CQA-5）：Scope extension の LEFT JOIN（`scene_scope.rs` の `read_scope_extension`）は、binding の knowledge holder と audience が character のとき、principal の Codex 行を binding あたり最大 2 行読む。`preflight_project_reads` の課金は、この行を数えない。tree の全件 56、binding 50、join で読む tree 50 の project で、どの binding も character の principal を持てば、shared の実際の読取は principal の 100 行を加えて約 256 行になり、課金（tree×2 の 112 と binding×2 の 100）を約 44 行上回る。変更前の A3 の課金も同じ行を数えていないので、本変更が増やした穴ではない。ただし、変更前は shared の行を Revision ごとに課金していたので、Revision が 2 件以上のとき課金が読取を上回っていた。今は shared を 1 回だけ課金するので、この形では旧来の乗数が実際の読取を覆うとは言えない。「読取と課金は 1 対 1」は読取の回数（statement）の単位の主張で、行の単位ではない。課金に principal の行を足すかは別に決める（課金を厳しくする変更だが、A3 の SQL、診断の観測 slot、steps の基準値に波及する）。
- 512 行の実 work が大きい形でも期限に収まることは、lifecycle の `registry33`（E=144）で確かめる。hosted の 3 OS での Q512 の call は、この変更の最初の run で観測して §4.1 に足す（§8）。

## 3. CI 証跡

### 3.1. 候補（head）と merge

| 記号 | head | base | 内容 |
|---|---|---|---|
| H1 | `0c9064a00a57d3e803ff51c8ec50a0bd5688eefe` | `a153743b`（#629） | 初期候補。CR-1、CR-1b（schema v42）、lifecycle lane の core dump 修正（`prlimit`）の3 commit。独立受入れの対象（`0e041537` と `0c9064a0`。§5） |
| H2 | `751dfc6cdbbb4471b395cf021c52c07dc7c54b25` | `5c309447`（#646） | H1 を master に rebase した。3 commit の patch は `git range-diff` で H1 と同一 |
| H3 | `fbdc8588f9fe2e26acaac669c6e6fb86a5361316` | `dabbed14`（#649） | 最終 head。H2 を rebase し（3 commit の patch は同一）、既存の Native 試験の後片付けを直す試験だけの commit を1つ足した（`electron/native/grimodex-node/src/nir1_generation.rs`。製品コードは変えない） |

CR-1（#636）は、H3 を head として、2026-10-13T14:06:23Z に squash merge された。squash commit は `750741183cf4d75ccf18b3904a5751b762284bda`（`75074118`）で、first parent は `dabbed14711561693b0a86de0241873a9beafa04`（H3 の base と一致）、tree は H3 の tree と同一（`4b0ea72e85d6bbbc19e05f4c80d48f456d18585b`）である。

### 3.2. run

| lane／gate | H1（0c9064a0） | H2（751dfc6c） | H3（fbdc8588） |
|---|---|---|---|
| Quick | この head では実行していない | `38390415289` success | `38402057437` success |
| Full | この head では実行していない | `38390418827` **failure**（下の注） | `38402061562` **cancelled**（U7 により merge の条件ではなくなったため、integrator が取り消した） |
| 通常 CI（pull_request） | `38271952062` failure（下の注） | `38390420241` success | `38402054634` success（attempt 2。下の注） |
| lifecycle（Linux） | `38271965901` success | `38390437150` success | `38402066205` success |
| practical（Linux） | `38271969982` success | `38390445007` success | `38402070979` success |
| cancellation（3 OS） | `38271974199` success | `38390453094` success | `38402075857` success |
| startup-refusal（3 OS） | `38271978782` success | `38390461768` success | `38402081595` success |
| terminal-refusals（3 OS） | `38275257462` success | `38390469346` success | `38402086883` success |
| frame-lifecycle（3 OS） | `38275261712` success | `38390477033` success | `38402092799` success |
| merge 後の master の Full | — | — | `38410553482`（base `dabbed14`、head `75074118`。tree は H3 と同一）：実行中（master の Full の記録で追う） |

- 3 OS の lane は、H1、H2、H3 のどの run でも、ubuntu／macos／windows の3 job がすべて success で、対象の step が走ったことを job の step 名で確かめた。lifecycle と practical は ubuntu の1 job（GitHub-hosted の `ubuntu-latest`。Image `ubuntu-24.04`、Version `20261004.327.1`）。lane は `workflow_dispatch` の `ci.yml` で、Full の registry には入らない。
- lifecycle lane の14件は、H1 の run `38271965901`、H2 の run `38390437150`、H3 の run `38402066205` のどれでも、case ごとに `test result: ok. 1 passed; 0 failed;` が出た。
- H1 の通常 CI（`38271952062`）：`C-query worker`（3 OS）、`Shared Rust crates`、`Electron native` は success。failure は `Electron product journeys (persistence / workspace authority)` の1 job だけで、log は `C2-ZC Rust receipt candidate mismatch: resolvedBaseSha`（receipt の base の照合の失敗）。CR-1 の変更に関係する job ではない。H2 の通常 CI では同じ job も success だった。
- H2 の Full（`38390418827`）：full-journeys、full-migration、full-frontend、full-cquery、full-rust、full-runtime は success。full-native が failure で、full-aggregate は skipped。full-native の `Test release-only native features`（`cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration`）は 271 passed、1 failed。失敗した試験は master にある既存の `nir1_generation::tests::recovery_join_coalesces_latest_real_open_only_after_old_worker_completion`（`electron/native/grimodex-node/src/nir1_generation.rs:3987`、`B cleanup: Os { code: 39, kind: DirectoryNotEmpty }`）で、CR-1 の変更とは無関係である。PR #636 本文の原因分析は、実 Open が detached なスレッドで起動する DB 層の自動 maintenance を待たずに fixture を消していた、というもの。H3 の commit で、`shutdown_workspace_lifecycle` で Closed を確かめてから削除するよう直した（試験だけの変更。ローカルでは再現していない頻度の低い失敗）。H2 の通常 CI では、同じ cargo test を実行する `Electron native` が success だった。
- H3 の通常 CI（`38402054634`）：attempt 1 は `Electron (workflow contract / type-check / test / build)` の1 job だけが failure だった。失敗した試験は `scripts/electron-runtime-performance-workflow.test.mjs:449` の `runner sampler owns Playwright-style detached descendants and reaps them`（runner の sampler が起動した detached child の pid ファイルが `ENOENT`。305 pass、1 fail）で、CR-1 の変更とは無関係である。失敗した job を再実行した attempt 2 は、success 26、skipped 2、failure 0 だった。
- U7（2026-10-13 のユーザー決定）により Full は merge の条件ではなくなり、merge 後の master で走らせる。H3 の Full は、merge の条件ではなくなったため、integrator が取り消した。merge 後の master の Full（`38410553482`）は実行中で、結果は master の Full の記録で追う。

### 3.3. 場所ごとの H2 と H3 の結果

| 場所 | 通常 CI（H2 `38390420241`） | 通常 CI（H3 `38402054634`、attempt 2） | Full（H2 `38390418827`） |
|---|---|---|---|
| 共有 Rust | `Shared Rust crates (check / clippy / test)` success | 同左 success | full-rust success（full-migration も success） |
| 既定 worker | `C-query worker`（ubuntu／macos／windows）3 job とも success | 同左 3 job とも success | full-cquery success |
| native | `Electron native (N-API / release features / MCP)` success | 同左 success | full-native **failure**（§3.2 の注。A-1 の試験は ok） |
| vitest | `Electron (workflow contract / type-check / test / build)` success | 同左 success（attempt 1 は無関係な試験で failure。attempt 2 で success） | 未実行（`native.tests` の失敗の後、fail-fast で `electron.unit` は not-run） |

H3 の Full は取り消した（U7）。rust、cquery、native、vitest の Full の証跡は、merge 後の master の Full（`38410553482`）で追う。

### 3.4. CR-2 のローカルの検証

CR-2 の PR はまだ hosted の run を持たない。次はローカルの結果で、CI の証跡ではない。CR-2 の充足の判定は、CR-2 の PR の最終 head で、共有 Rust の試験を走らせる `Shared Rust crates` を含む PR checks が green になることを条件とする。CR-2 の試験は共有 Rust の試験で、新しい lane は無い。

| 項目 | 値 |
|---|---|
| base | master `87f0da94`（HP-1、#632）。旧基点 `fbdc8588`（H3）から、`532fd927`（B-ROUTE、#643）と `809cf7a2`（DT-3、#637）を経て rebase した。`532fd927` への rebase では、CP-1（#641）の試験と `tests.rs` の末尾で衝突した 3 か所を、両方の試験を保ち、重複する補助関数 `Fixture::worker_reader` を CP-1 の版に一本化して解消した。CP-1 の試験は変えていない。`809cf7a2` と `87f0da94` への rebase は衝突しなかった（`87f0da94` までに CP-2a #655、#653、U7 #654、HP-1 #632 が入った。`nir1_graph.rs`、`tests.rs`、`quality-workflow.test.mjs`、実行計画は、別の箇所の変更どうしだった）。CP-2a の製品 owner は worker 経路（`CQueryWorkerOwner`）だけを使い、cfg で閉じた ordinary reader の API を参照しない |
| 試験（nir1_graph） | `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::nir1_graph`：136 passed、0 failed、35 ignored |
| 試験（nir1_entity_relation） | 同じ形で `narrative_extraction::nir1_entity_relation`：92 passed、0 failed、0 ignored |
| clippy | `cargo clippy --manifest-path src-tauri/Cargo.toml -p grimodex-db --all-targets -- -D warnings`：警告 0 |
| 診断 feature の build | `cargo check --manifest-path src-tauri/Cargo.toml -p grimodex-db --features nir1-material-diagnostics --all-targets`：成功。通常 reader を cfg で閉じた後も build できる。警告は feature 付きの dead_code |
| 文書の契約 | `fnm exec --using=22 -- node --test scripts/quality/quality-workflow.test.mjs`：21 件すべて pass |
| verify:quality | `CI=1 fnm exec --using=22 -- pnpm verify:quality`：node 574 件（573 pass、0 fail、1 skipped）と vitest 83 ファイル 760 件がすべて pass。`CI=1` は、`vitest.config.ts` の hosted CI と同じ timeout（30 s）にするために付けた。付けない実行は、負荷の高い共有機で既定の 5 s の timeout を超え、`src/lib/browser-mock.persistence-contract.test.ts` などが失敗した（CR-2 が触れない試験で、単独では pass） |
| 製品コードの変更 | `nir1_graph.rs` の cfg（ordinary reader を製品 build から外す。D9）と、それに伴う import の整理（`OpenFlags` を完全修飾にした）、論理 ledger の位置づけを直すコメント。`memory.rs` は doc、コメント、`expect` の reason だけ。worker、NQG1、閾値、製品の Graph 入口は変えていない |
| 足さなかったもの | 実 worker の N／N+1 の試験は commit していない。lifecycle lane への配線もしていない（赤い lane を足さない）。経緯は §7.2 |
| 実 worker の測定 | release の worker binary を、lifecycle lane と同じ手順（`prlimit` の core 1:1、1 case 1 process）で測った。結果は §7.2。測定の元データは git 管理外のローカルの測定メモ（`cr2-precheck-real-worker-measurements.txt`） |

## 4. practical lane の観測値

lane：`canonical_profile=c-query-practical`（`scripts/nir1-c-query-worker-ci.sh practical-retention`、Linux のみ、`NIR1_C_QUERY_PRACTICAL_OBSERVE=1`）。値は run の log（`gh run view <run> --log`）から転記した。

- admission：親が request を admit してから valid な result lease を得るまで（契約の 100 ms）。call：`query_once` の呼出し全体。
- usage の単位は KiB。組は（VmRSS、VmHWM）。H1 と H2 は、すべての snapshot で両者が一致した。H3 は、parent の run 29 と run 30 の snapshot だけ VmHWM が VmRSS より 84 KiB 高い（28,984）。snapshot は parent と READY の worker のものに限り、query の peak ではない（`snapshots_not_peak=true`）。観測値は閾値、物理メモリの上限、leak 不存在の証明ではない。

| 項目 | H1（0c9064a0）run `38271969982` | H2（751dfc6c）run `38390445007` | H3（fbdc8588）run `38402070979` |
|---|---|---|---|
| fixture | `Q512/R2/A3-eligible-shared`。source 3,284,992 B、materials 140、revisions 1、registry rows 4、charged rows 512。linux／x86_64 | 同左 | 同左 |
| 準備後の preflight | candidate_rows 2、canonical_candidates 1、A2_rows 140、A3_rows 370、admitted 512、attempted 512、first_refusal None | 同左 | 同左 |
| 30回の admission（ms。最小／中央値／最大） | 24.474／25.172／25.763 | 19.435／20.545／22.675 | 14.880／15.391／17.861 |
| 30回の call（ms。最小／中央値／最大） | 24.475／25.173／25.764 | 19.435／20.545／22.676 | 14.881／15.391／17.861 |
| maximum を1回（admission／call。ms） | 25.138／25.139 | 20.519／20.520 | 15.543／15.544 |
| parent の READY 時（KiB） | 29,012〜29,140（run 1 の後は 29,140 で一定） | 28,868〜29,060（run 1 の後は 29,060 で一定） | 28,772〜28,900（run 1 の後は 28,900 で一定。VmHWM は run 29 から 28,984） |
| parent の lease 保持中／retired の後（KiB） | 29,140／29,140 | 29,060／29,060 | 28,900／28,900（VmHWM は run 28 まで 28,900、run 29 と 30 は 28,984） |
| worker の READY 時（KiB） | 8,644〜8,840 | 8,728〜8,920 | 8,740〜8,904 |
| maximum の1回（parent の READY／lease／retired、worker の READY。KiB） | 28,656／28,784／28,784、8,852 | 28,916／29,044／29,044、8,856 | 29,116／29,244／29,244、8,872 |
| 各回の retirement | 30回とも lease_released、exit_eof_all_joins、claim_reloan が true で participants 0 | 同左 | 同左 |
| input の sidecar（wal／shm／journal の bytes。retention と maximum の両方） | 0／32,768／0 | 同左 | 同左 |
| 試験 | `native_worker_practical_retention_q512_30x` ok（2.19 s）、`native_worker_returns_canonical_512_a3_eligible_seed_local_graph` ok（0.19 s） | ok（1.83 s）、ok（0.17 s） | ok（1.37 s）、ok（0.13 s） |

読み方：100 ms の期限に対して、admission の中央値は H1 で約25 ms、H2 で約21 ms、H3 で約15 ms だった。3回の run は同じ fixture と同じ script で、runner が異なり、差の原因は調べていない。parent の VmRSS は、どの run でも run 1 の後で一定だった。H3 の parent の VmHWM は、run 28 の retired 時の snapshot が 28,900 KiB、run 29 の READY 時の snapshot が 28,984 KiB で、上がった時点はその間である。以後は run 30 まで上がらなかった。30回の間に、具体的な retention、継続的な growth、OOM、stall は観測されなかった。

### 4.1. CQ-AVAIL の後の practical lane の観測値（ローカル）

Q512 の fixture が変わった（§2.12）ので、新しい fixture の観測値を別に記録する。上の H1〜H3 は変更前の fixture の hosted の値で、比べられない。値はローカル（Linux x86_64、12 core）で、他 lane の build が並行していて load average は 10〜16 だった。hosted の値ではない。

| 項目 | 値 |
|---|---|
| fixture | `Q512/R2/A3-eligible-shared`。source 3,518,464 B、materials 164、revisions 1、registry rows 6、charged rows 512。linux／x86_64 |
| 準備後の preflight | candidate_rows 2、canonical_candidates 1、A2_rows 164、A3_shared_rows 263、A3_revision_rows 83、admitted 512、first_refusal None |
| 30回 × 15 run の admission（ms。最小／中央値／最大） | 28.657／30.483／56.551 |
| 同 call（ms） | 28.657／30.484／56.552（p95 41.4、p99 44.0。60 ms 超 0 回、100 ms 超 0 回。450 回） |
| maximum を1回（call。ms。15 run） | 29.1〜39.8 |
| parent の READY 時／lease 保持中（KiB。VmRSS と VmHWM は一致） | 30,868〜31,776／31,060〜31,932 |
| worker の READY 時（KiB） | 9,504〜9,720 |
| 各回の retirement | 465 回（30回 × 15 run と maximum の15回）とも lease_released、exit_eof_all_joins、claim_reloan が true で participants 0 |
| input の sidecar（wal／shm／journal の bytes。retention と maximum の両方） | 0／32,768／0 |
| 試験 | `native_worker_practical_retention_q512_30x` ok（3.6 s）、`native_worker_returns_canonical_512_a3_eligible_seed_local_graph` ok（0.3 s） |

読み方：100 ms の期限に対して call の中央値は約 30 ms だった。変更前の fixture の hosted の admission は 15〜25 ms（H1〜H3）。値は閾値、物理メモリの上限、leak 不存在の証明ではない。snapshot は parent と READY の worker のもので、query の peak ではない。

## 5. 独立受入れ

候補を編集しない read-only の受入れ。モデルは `claude-fable-5-1`（effort high）。結果は [PR #636](https://github.com/kazormia296/Grimodex/pull/636) 本文の「独立受入れ」節のとおり。

| 回 | 対象 head | 観点 | 結論 | 指摘 |
|---|---|---|---|---|
| 1 | `0e041537`（CR-1 と CR-1b） | migration（schema v42） | accept | 指摘なし。`schema-contract.json` を独立に再生成して byte 一致を確認した |
| 1 | 同上 | CQ 受入れ | accept | P3 が3件 |
| 1 | 同上 | CI lane（lifecycle lane の配線） | reject | P2 が1件（pipe 型の `core_pattern` では `ulimit -c 0` が効かず、Rust OOM の case が SIGKILL で落ちる）。P3 が1件 |
| 2 | `0c9064a0`（P2 の修正） | CI lane（焦点を絞った再レビュー） | accept | P3 が1件 |

P2 は `prlimit --core=1:1` で修正した（kernel の log `RLIMIT_CORE is set to 1, aborting core` で、worker child まで値が継承されることを確認）。

P3 の扱い：

| P3 | 状態 |
|---|---|
| U6 の試験は prepare 単体の検査で、製品の B build 経路は未配線（指摘の時点） | 残る（RB-7）。B build 経路は B-ROUTE（#643）で maintenance の経路に配線済みで、製品の自動実行は PUB-G まで閉じている。「R+IR に戻る」ことの製品経路での確認は C-product で行う |
| `ordinary_reader_registers_and_queries_fixed_q2_fixture` がどの lane にも配線されていない | 解消。lifecycle lane に配線した（H1 の commit） |
| 許可範囲外の版 assert 2か所（`execute.rs` の試験、`scripts/quality/validate-semantic-core-boundary.{mjs,test.mjs}`）に integrator の確認が要る | 解消。integrator が採用した（D8） |
| `timeout` が発火すると、別 process group の owner-death helper が残る | 残る。失敗経路だけで、lane の失敗という判定は変わらない |
| hard limit が既に 0 の host では `prlimit` が EPERM で失敗し、lane が fail-closed になる | 残る。hosted の ubuntu runner は unlimited なので CI には影響しない |

独立受入れの対象外：H1→H2→H3 の rebase で、受入れ済みの3 commit の patch が `git range-diff` で同一であることを確かめた。H3 で足した後片付けの試験 commit（`nir1_generation.rs`、試験だけ）は、独立受入れを行っていない。integrator が差分を読んで確認した（Native 全体の 272 件 pass、対象の2試験の15回連続 pass、clippy の pass）。merge 後の tree は H3 の tree と同一である（§3.1）。

### 5.1. CR-2 の中間レビュー（独立受入れではない）

CR-2 の試験の commit を、実装とは別の担当が read-only で調べた。実装の報告が挙げた契約との食い違い 4 件（G-1 の B と writer の数え方、ordinary reader と実 worker、SQL steps、Scene 8）も、独立に確かめた。結論は、1 と 3 が一部確認、2 と 4 が確認だった。1 は単位の違いが正しく、約 2 倍は試験形だけの数値だった。3 は拒否そのものが正しく、steps の値は上限ちょうどではなく、影響は報告より大きかった。結果は §2.1、§2.11、§7 に反映した。

試験の commit のレビューの結論は changes で、P2 が 1 件、P3 が 2 件だった。いずれも直して commit に取り込んだ。修正の後の独立受入れ（Fable high）は、この commit の時点では行っていない。

| 指摘 | 内容 | 扱い |
|---|---|---|
| P2 | G-2 の正例と負例（G-1 の C-query の拒否も）が、maintenance owner を通さず steps の上限を 10,000,000 に外した試験専用の経路でだけ確かめられていた。その fixture は本番の steps では unavailable になるので、「2,097,152 B の内の Revision は通常どおり Graph に使われる」ことを本番の構成で示していなかった | 直した。seed と候補 1 件だけの fixture にして、本番の worker 構成（SQL 100,000 steps、maintenance owner）で N が available、N+1 が unavailable になることを確かめる。steps を外す経路は G-4 の 12／13 と 144／145 だけに残し、doc を事実に合わせた |
| P3 | G-1 の B の試験の名前とコメントが、RB-1 の whole-set の条件の正例に読める。実際に効くのは、保存された payload と envelope にかかる成分ごとの guard である | 直した。名前を `b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses` に改めた。効いている条件と、counted 約 3 MiB 以上は成分 guard、上限ちょうどは whole-set で B が拒否することをコメントに書き、roster にその Revision が入る assert を足した。上限近傍の正例は [precheck]（§7.1） |
| P3 | G-3 の待ち時間の上限 1 秒は、約 0.5 秒以上の timeout しか検出しない。方式と範囲が、試験にも台帳にも書かれていなかった | 直した。doc とコメントに、検出できる範囲、rollback journal での注入、WAL 固有の busy が対象外であることを書き、台帳の RB-4 に記録した |

## 6. CR-1 の判断（D1〜D8）

CR-1 の判断は U3 の委任（[作業記録](nir1-continuation-2026-10.md) の §3）に基づく。D1、D2、D6、D7、D8 は PR #636 本文の「判断と信頼境界（U3 委任）」にある。D3〜D5 は PR 本文に個別の ID が無く、CR-1 の作業記録（`claude-nir1-cres` worktree の `.ralph/agent/decisions.md`。git 管理外）の要旨をここに転記する。

| ID | 判断 | 要旨 | 記録先 |
|---|---|---|---|
| D1 | lifecycle lane の形 | 新 mode `lifecycle`、profile `c-query-lifecycle`。Linux のみ。1試験を1 process で走らせる（process 全体の worker 容量を意図的に quarantine する case があるため。1 process にまとめる案は相互干渉で却下）。`--exact` と `test result: ok. 1 passed` の grep で0件実行の green を防ぐ。case ごとに fresh な入力。Full の registry に入れない | PR 本文 |
| D2 | `ci.yml` の範囲 | worker job の profile 追加に加え、canonical job の除外リストにも profile を足した（worker job だけが admit される契約を守る） | PR 本文 |
| D3 | CR-1 の初版での CQ-2 | A2／A3 の SQL 3文が `narrative_proposal_decisions` を全件走査し、decided な無関係 Revision 6,000件で 91,410 steps になる実欠陥を、EXPLAIN の assert と増量試験が検出した。閾値は上げず、index の migration が要るため初版では HOLD として報告し、CR-1b（D6、D7）で閉じた | `.ralph/agent/decisions.md`。内容は PR 本文の CQ-2、schema v42、計測 |
| D4 | U6 の fixture | 実 writer で作った Revision から sealed を publish し、payload と envelope がちょうど 6 MiB の候補1件を足す。12 MiB の control は通り、5 MiB の Decision を足して合計だけを 16 MiB 超にする。B-GUARD の後は候補を承認済みにする（成分の guard が拒否するのは承認済みの Revision だけなので、未承認のままだと control が上限ちょうどの境界を押さえない） | `.ralph/agent/decisions.md`。内容は PR 本文の U6 の安全失敗 |
| D5 | worker build の割り当てと core dump | seam build は commit の後に必ず exit 23 するため、正常な exit を要求する3件（proof unobserved、W1 Restore、file identity）は通常 build の worker に移した。core dump は初版が `ulimit -c 0` だったが、独立受入れの P2 を受けて `prlimit --core=1:1` に変えた | `.ralph/agent/decisions.md`。最終の方式は PR 本文の lifecycle lane の core dump |
| D6 | schema v42 の index | `narrative_proposal_decisions` に `(revision_id, proposal_id)` と `(proposal_id, created_at, id)` の2本。片方だけでは、どちらかの読取が SCAN か TEMP B-TREE に残る。1つの savepoint で作り、checkpoint と user_version の前に置く。失敗したら 41 のままにして次の open で再試行し、片方が欠けたら、その index だけを作り直す | PR 本文 |
| D7 | CQ-2 の受入れ試験の形 | 件数に比例する回帰を検出し、B-tree の端の境界による Decision seek 1本につき最大1 step の差だけを許す。閾値、admission、Gold は変えない | PR 本文 |
| D8 | 許可範囲外の版 assert 2か所 | schema 版の 42 への追従に必要な最小の変更。`execute.rs` の試験と `validate-semantic-core-boundary.{mjs,test.mjs}`。integrator が採用した | PR 本文 |

外部送信、新しい送信先、新しい authority、閾値の変更はない。

### 6.1. CR-2 の判断（D9〜D11）

CR-2 の判断は U3 の委任（[作業記録](nir1-continuation-2026-10.md) の §3）の範囲にある。固定値と閾値は変えていない。

| ID | 判断 | 要旨 |
|---|---|---|
| D9 | 通常 reader を製品 build から外す | `Nir1GraphReader` の `open`、`register_with_control`、`query`、`query_for_worker` と、内部の `ReaderConnection::Owned`、`QueryPath::Reader`、`QueryPath::Worker` を `cfg(any(test, feature = "nir1-material-diagnostics"))` に閉じた。製品の query は worker 経路（`open_for_worker`、`query_for_worker_with_maintenance`）だけである。ordinary reader は論理 ledger に一時見積りも計上するので worker 経路より厳しく、製品の owner（CP-2a）に誤って配線されると、小さな候補でも unavailable になる。厳しくする方向の変更で、閾値は変えない。利用者は試験（`oracle_tests.rs`、`tests.rs`、B-ROUTE の `nir1_graph_index_maintenance_tests.rs`）と、feature 付きの診断（`nir1_graph_memory_diagnostics.rs`）だけで、Native に参照は無い（`nir1_graph_query` は `NIR1_GRAPH_NOT_ACTIVATED` を返すだけ）。pub API が変わる |
| D10 | G-2 の query を本番の worker 構成で確かめる | in-process で `query_for_worker_with_maintenance_deadline`（maintenance owner、SQL 100,000 steps、期限は試験の慣例の 2 秒）を使い、fixture は seed と候補 1 件だけにする。steps の上限を外す経路は G-4 の 12／13 と 144／145 だけに残す。通常の allocator の in-process なので、実 worker の固定 allocator は示さない（G-2 の [precheck]） |
| D11 | G-3 の SQLITE_BUSY の注入方式 | `journal_mode=DELETE` に切り替え、別接続の `BEGIN EXCLUSIVE` で注入する。WAL では別接続の write lock が reader を止めず、reader の接続がある間は `locking_mode=EXCLUSIVE` の保持者を作れないため。WAL 固有の busy は対象外 |

CR-2 も、外部送信、新しい送信先、新しい authority、閾値の変更を含まない。

## 7. G-1〜G-4 の状態と HOLD の扱い

§2 で「一部充足」とした条件の、足りない部分を記録した。いずれも CR-1 の試験では固定されていない境界で、実装の欠陥を見つけたものではなく、対応する試験が無いことの記録だった。探索の範囲は `src-tauri/crates` と `electron/native` の `git grep` で、対応する試験を確認できなかったものを未充足とした。CR-2（branch `claude/nir1-cr2`、試験と本台帳の更新）で試験を足し、worker、NQG1、閾値は変えていない。試験で閉じられた部分は充足とした。閉じられなかった部分は、試験の不足ではなく、確認済みの契約と実装の食い違いなので、[precheck] として HOLD のまま残す。

| ID | 条件（出典） | 証跡（CR-1 まで、CR-2） | 状態 |
|---|---|---|---|
| G-1 | Revision の513 records と 6,291,457 B は writer が保存しない。上限の内の Revision は保存、A2 の読取、B build の publish ができる（RB-1） | CR-1：B の保存済み成分の guard の N／N+1（`persisted_revision_components_are_guarded_independently`）と、承認済みの Revision の 6 MiB 超の payload の拒否（`graph_index_rejects_oversized_revision_before_parse_and_reuses_connection`。B-GUARD で typed `CapacityExceeded` にし、未承認・却下の候補は除くようにした）。CR-2：writer の 512／513 records と 6,291,456／6,291,457 B の N／N+1、上限ちょうどの保存と A2 の読取（`typed_writer_saves_512_records_at_exactly_6_291_456_input_bytes`、`typed_writer_refuses_over_limit_revisions_without_partial_rows`）。counted 2,621,440 B の Revision の B の publish（`b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses`） | 一部充足。writer の N／N+1、上限ちょうどの保存、A2 の読取は充足。B の上限近傍の publish は [precheck]（§7.1）で、HOLD のまま |
| G-2 | per-Revision preflight の 2,097,152 B は通り、2,097,153 B の Revision が候補にあれば query 全体が unavailable になる（RB-2） | CR-1：preflight の N+1 の拒否（A2 の payload と envelope、A3 の payload・本文・phase・scope）。CR-2：本番の worker 構成（in-process。maintenance owner、SQL 100,000 steps）で、ちょうど 2,097,152 B の候補が Graph に使われること（`worker_query_admits_a_candidate_at_exactly_the_per_revision_preflight_limit`）と、2,097,153 B の候補で query 全体が拒否されること（`query_refuses_the_whole_graph_when_a_candidate_is_one_byte_over`） | 一部充足。preflight の N／N+1 と、本番の worker 構成（in-process）での正例と負例は充足。固定 allocator の実 worker での正例は [precheck]（§7.2）で、HOLD のまま |
| G-3 | reader／busy の競合で待たずに unavailable になる（wait 0。RB-4） | CR-1：枠の使用中（`NIR1_GRAPH_WORKER_BUSY`、`NIR1_GRAPH_WORKER_CAPACITY_BUSY`）、Restore の admission、外部 write との競合。CR-2：`busy_database_refuses_both_reader_paths_without_waiting`（rollback journal で別接続の `BEGIN EXCLUSIVE` を注入する。ordinary と worker の両経路が 1 秒未満で、部分 Graph なしに unavailable になり、解放後に回復する） | 充足。rollback journal での注入で、WAL 固有の busy は対象外。待ち時間の上限 1 秒が検出するのは約 0.5 秒以上の timeout（RB-4）。HOLD を解除する |
| G-4 | proposal/5 の負例のうち、wrong／unknown seed、3 hop、Entity 12／edge 展開 144／Scene 8 の上限（RB-8） | CR-1：実在する seed の正例と、2 hop の正例（`seed_local_two_hop_query_matches_independent_canonical_projection`）。CR-2：`unknown_and_foreign_seeds_are_refused_as_seed_not_found_on_both_reader_paths`、`two_hop_limit_stops_before_a_third_hop`、`twelve_discovered_entities_are_admitted_and_the_thirteenth_is_refused`、`one_hundred_forty_four_distinct_edges_are_admitted_and_the_145th_is_refused` | 一部充足。unknown seed、3 hop、Entity 12／13、edge 144／145 は充足（12／13 の拒否と 144／145 は、steps の上限を外した条件を含む論理の試験。144 本に届く形は本番では steps が先に効く。§2.11）。Scene 8 は CP-1 の受入れに移す（§7.3）。Scene 8 以外は HOLD を解除する |

### 7.1. [precheck] G-1：B の上限近傍の publish

条件（proposal/6）：Acceptance の正例「`512 records`／`6,291,456 B` の内の Revision は保存と A2 の読取ができ、B の whole-set の上限の内なら B build で publish される」と、固定値の表「proposal/5 と同じ数え方で `512 records`、`6,291,456 B`。A2 の作成時の検証、A2 の reader、B build の per-Revision admission に使う」。

事実（独立に確かめた。基点 `a3f705ae` の複製で測った。B-ROUTE（#643）は B の guard を変えていない。B の成分 guard の挙動に関する記述は B-GUARD の前のもので、B-GUARD で変えた点はこの節の末尾の「B-GUARD の後」にまとめた）：

- 数え方が違う。writer は bundle の文字列 field の長さの合計（counted）を数え、JSON の記号、field 名、数値、envelope は数えない。A2 reader は保存された bytes を検査しない。B は保存された `payload_json` と `reconciliation_envelope_json` の bytes を読み、whole-set（16 MiB）に計上したうえで、payload と envelope をそれぞれ 6,291,456 B と比べ、超えたら `NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT` で止める。この形は B（#600）から同じで、#610 で共有定数ごと 6 MiB になった。
- 保存された envelope は counted より大きい。envelope は Evidence ごとに evidenceRef（evidence_id の全文）と quote の全文などを持ち、dependencySet も `nir1:evidence:{evidence_id}` として evidence_id をもう 1 度持つ。試験形（参照されない Evidence の evidence_id を伸ばす）では、counted 6,291,456 B の保存は payload 6,328,935 B、envelope 12,774,550 B（約 2.03 倍）になる。counted 3,145,728 B は payload 3,183,207 B、envelope 6,483,094 B で、whole-set の内でも成分 guard が拒否する。counted 2,621,440 B は envelope 5,434,518 B で publish される。製品形（Codex review。quote は summary 全体、evidence_id は固定形式、Entity 255 件）の envelope は約 1.03〜1.06 倍、payload は約 1.02〜1.04 倍である。
- 製品形の単独 Revision で、B が publish できたのは counted 5,423,423 B までだった。5,805,923 B は whole-set（counted の約 3 倍）で、6,188,423 B（writer の上限の内）は成分 guard（payload 6,334,546 B）で拒否された。
- B は Revision を除かず、build 全体を止める。scan は承認状態で絞らず、成分 guard は承認の確認より前にあるので、未承認や却下の候補でも止まる。成分の超過は型の無い失敗（文字列のエラー）で、whole-set の超過は typed な `CapacityExceeded`（`input-bytes exceeds 16777216`）になる。publish の前に失敗するので旧 sealed は残るが、reader の登録は完全な roster を解決し直すので、同じエラーで失敗する。型付き Revision を消す製品の経路は無い（DELETE は project の削除だけ）。
- 製品での起こり方：Revision は Codex の Entity／Relation review の UI から prepare で作られ、選んだ Entity ごとに summary 全体を写す（255 件まで。summary に長さの上限は見当たらない）。止まる大きさは Revision の形で約 2 倍違うので、二つに分ける。
  - 製品形（UI の prepare で作る形）の単独 Revision は、counted 約 5.4〜5.8 MB から whole-set で、約 6.15 MB から成分 guard で止まる（上の測定。5,423,423 B は publish、5,805,923 B は whole-set、6,188,423 B は成分 guard）。製品形は summary が payload、envelope、live Source（Codex の summary）の 3 か所に入るので、whole-set には counted の約 3 倍が計上される。255 件なら 1 件平均約 21〜23 KB（日本語で約 7,000〜7,600 字）の summary か、貼り付けた長文が要る。
  - whole-set は project の current な型付き Revision（未承認・却下を含む）の合計に対する上限でもある。単独では小さい Revision でも、合計が同じ counted 約 5.4〜5.8 MB に届けば、同じ typed な拒否になる（推定。16 MiB を製品形の約 3 倍で割った値で、場面ごとの review で同じ summary を重ねて写した分も数える）。
  - envelope が counted の約 2 倍になる形（試験形）は、counted 約 3 MiB 超で成分 guard が止める。この形は UI の prepare では作れず、bundle を直接渡す create IPC（wrapper はあるが UI は使っていない）でだけ作れる。
  - 普段は稀だが、契約が想定する import や貼り付けでは起こりうる。保存は成功するが、止まる大きさの Revision が 1 件あるだけで、承認前でも却下後でも、project の B build と reader の登録が失敗し、project 全体の Graph が使えなくなる。R+IR は使える。今は Graph の入口が閉じている（A-1）。B の build は B-ROUTE（#643）で maintenance の route に配線されたが、起動 gate は既定で閉じている。影響は PUB-G の後に表に出る。

契約との食い違い：

1. 固定値の表と Acceptance の「同じ数え方」（counted）に対し、B は保存 bytes を成分ごとに数える。同じ Acceptance の「成分がそれぞれ `6,291,456 B` 以下の Revision」は保存成分で書かれていて、契約の中で 2 つの単位が同じものとして扱われている。
2. 「B はその Revision を qualified にせず、完全な roster を作れなければ build 全体を typed refusal にする」「超えたら typed refusal にして旧 sealed generation を残す」に対し、成分の超過は型が無く、qualified にならない未承認や却下の候補でも build 全体を止める。
3. 「可用性」は whole-set による拒否を受け入れているが、writer が受け入れた 1 件（未承認でも）で project 全体が止まり、製品の操作では戻せないことは書いていない。

選択肢（どれも数値、文言、設計のどれかの判断を含む）：

- 1-A（B-GUARD、2026-10-14 に実施。結果は下の「B-GUARD の後」）：B の成分超過を「その Revision を除く」扱いにする。payload を読む前に承認状態を scalar で確かめ、承認されていない候補は大きさに関わらず除いて build を続ける。承認済みで成分を超えるときは build 全体を typed refusal にする。reader の登録にも同じ規則を当てる。数値は変えない。B の経路を直す変更で、U3 の委任の内。ただし「止めるから除くへ」を fail-safe を弱めたと読む余地があるので、判断を残して知らせる。承認済みの大きな Revision と RB-1 の正例の食い違いは残る。
- 1-B：writer に保存形の検査を足す。保存の前に、作った payload_json と envelope_json がそれぞれ 6,291,456 B 以下かを検査し、超えたら typed に拒否する。counted の 6,291,456 B は変えない。確認済みの正例「6,291,456 B の内は保存できる」を形によって破る（試験形で counted 約 3.05 MB 超、製品形で約 6.15 MB 超）ので、再確認が要る。
- 1-C：B の成分 guard を、counted と同じ意味まで上げる。防御上限を緩めるので再確認が要る。1 回に扱う文字列が最大約 13 MB になり、B-close の測定範囲（成分 2 MiB 未満）を外れる。製品形では whole-set で約 5.4 MB 以上が拒否されるので、上限近傍の正例は成り立たない。勧めない。
- 1-D：契約と台帳の文言を実装に合わせる。RB-1 の正例を「counted の上限の内で、保存された payload と envelope がそれぞれ 6,291,456 B 以下、かつ whole-set の内なら publish」に改め、形ごとの実際の上限と、未承認でも project 全体が止まり戻せないことを「可用性」に書く。新しい draftRef の確認が要る。黙って長く止まる害は残るので、1-A と組み合わせる。
- 調査の推奨（未決定）：1-A を B の経路の後続として委任の内で進め、1-B と 1-D の組み合わせをユーザーに確認する。1-C は勧めない。それまで、RB-1／G-1 の B の上限近傍の正例は [precheck] のままにする。CR-2 は B の値も実装も変えていない。

B-GUARD の後（2026-10-14、branch `claude/nir1-bguard`）：選択肢 1-A を実装した。数値、固定値、worker、NQG1 は変えていない。1-B と 1-D は実施していないので、G-1 の B の上限近傍の正例は [precheck] のままである。

- 変更：B の成分 guard（payload と envelope をそれぞれ 6,291,456 B と比べる）を、承認状態で分けた。承認状態は payload を読む前に、proposal の status と最新の Decision から scalar で確かめる（`nir1_entity_relation_index.rs::revision_is_approved`。status が `approved`、または最新の Decision が `approved` のとき承認済みと扱い、二つが食い違うときは承認済みの側に倒す）。
  - 承認されていない Revision（下書き、却下、保留）は、大きさに関わらず roster に入らない。A2 reader は status が `approved` でない Revision を qualified にしない（Graph の経路では下書きの `unreviewed` を読み進めて Draft として返すが、roster には入れない）。成分 guard の位置で、parse も確保もせずに除き、build を続ける。
  - 承認済みで成分を超える Revision は、build 全体を typed `CapacityExceeded` で拒否する。限界の名前は `persisted-revision-component-bytes`。部分 roster は出さず、旧 sealed generation を残す。型の無い `NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT` は無くなった。
  - source の読取は、build、publish 時の再読取、complete registration（`is_complete_registered`、Verify、Rebuild、reader の登録）が同じ関数なので、同じ規則がすべてに当たる。reader の登録が payload を検査する `verify_complete_source_index` は、論理上は status が `approved` の current な Revision だけを対象にし、自前の大きさの検査を持たない。承認済みの判定にこの status を含めてあるので、その Revision は必ず先に成分 guard を通る。ただし、これは論理上の対象である。SQLite は JSON の関数を status や current の絞り込みより先に評価しうるので、下書き、却下、非 current の Revision の payload もこの SQL で解析されうる（in-loop レビューが、同じ index を持つ最小の schema で、EXPLAIN QUERY PLAN と `json_valid` の呼出しの記録から確かめた）。この解析の大きさは成分 guard では区切られない。current な候補の bytes は whole-set の 16 MiB に数えられ、非 current の Revision の解析は B-GUARD の前からある。worker では、解析が arena を超えると NOMEM などで登録が失敗し、Graph は unavailable になる（安全側）。JSON の式を承認状態と current で gate する（`CASE WHEN … THEN r.payload_json ELSE '{}' END` の形）か、結合順を固定する案は、worker の登録時のメモリを扱う後続の lane で検討する。
- whole-set の数え方は変えていない。key、payload、envelope、metadata／Decision の bytes は、scan した候補ごとに、承認状態に関わらず 16 MiB に数える。B-close の定義（[B-close completion evidence](nir1-b-close-completion-2026-09-22.md) の「Admitted Source input per scan」: key、payload、envelope、metadata／Decision、live Source の bytes を materialization の前に数える）に承認の条件は無い。境界の fixture（`nir1_capacity_fixtures.rs::pad_ineligible_source_input`）は、不適格な候補（承認されていない decisionless と rejected を含む）の payload を詰めてちょうど 16 MiB を作る。B-ROUTE の試験（未承認の候補の 16 MiB + 1 が `input-bytes`）も、承認されていない候補を数える前提で書かれている。U6 の試験（`whole_set_input_limit_refuses_without_replacing_the_sealed_generation`）は、候補を承認済みにして、成分の guard の上限ちょうど（6,291,456 B の admit）と、成分がその大きさのままの whole-set だけの拒否を、B-GUARD の前と同じ大きさで確かめる。未承認の候補は成分の guard では除かれるので、候補を未承認のままにすると control が上限ちょうどの境界を押さえなくなる（guard に off-by-one を入れても prepare が通ることを実測した）。そのため、未承認で 1 B 超の候補が除かれながら whole-set には数えられることは、承認を取り消した同じ候補で後段に確かめる（未承認の超過を数える前に除く変異では、この後段が失敗することを実測した）。これらを弱めずに、成分 guard だけを承認状態で分けた。
- maintenance の経路（B-ROUTE、#643）から見た分類：承認済みの超過は `classify_build_failure` の capacity の枝に入り、`Refuse { code: NIR1_GRAPH_CAPACITY_EXCEEDED, limit: persisted-revision-component-bytes }` として記録される（以前は型が無く、文字列の `NIR1_GRAPH_` token から `code: NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT`、limit なしで拒否された）。入力が変わらない間は再 build されず（`RefusedUnchanged`）、承認の取消（approved → rejected。製品の操作）で入力が変わると、次の owned build が publish する。C-query の worker は同じ error を `validation-capacity-exceeded`（上限）に分類する（以前は `other`）。
- 判断の記録（fail-safe を弱めたと読む余地について）：承認済みの Revision は、これまでどおり build 全体を拒否し、部分 roster を出さず、旧 sealed を残す。除くのは、A2 reader が qualified にしない Revision だけである。承認の判定は A2 の必要条件（status が `approved`）を含み、さらに Decision も見て食い違いを承認済みの側に倒すので、roster に入りうる Revision を除くことはない。
- 残る点：
  - whole-set（16 MiB）は未承認・却下の候補の bytes も数える。大きな下書きの合計が 16 MiB を超えると、typed な `input-bytes` で build 全体が拒否される。契約の「可用性」が受け入れる制約の範囲だが、承認の取消では減らない。未承認・却下を whole-set から外すには B-close の Source 入力の定義の変更が要り、再確認が要る。
  - C-query の per-Revision preflight（2,097,152 B）は、seed から辿った候補の行が一つでも超えると query 全体を拒否する。候補の行は seed の Entity の reverse index（`proposal-revision` の edge）から承認状態を問わずに読む。この edge は下書きの作成時から存在し、却下の後も残る。そのため、B の build と登録が戻っても、2 MiB を超える下書きや却下済みの Revision が query の経路上の Entity に触れていれば、その query は `NIR1_GRAPH_REVISION_INPUT_LIMIT` で unavailable のままである（B-GUARD の作業中に、却下済みで 6 MiB 超の payload を持つ Revision で観測した。B-GUARD の試験は query ではなく登録までを確かめる）。契約の文言（proposal/6「seed から辿った候補」と「不適格行も消費する」）に関わるので、C-query の側を直すには確認が要る（[precheck]）。
  - RB-1 の正例（counted の上限近傍の publish）と保存 bytes の単位の食い違いは、1-B／1-D を実施していないので残る。

### 7.2. [precheck] G-2：実 worker での正例

条件（proposal/6）：Acceptance の正例「per-Revision preflight が `2,097,152 B` の内の Revision は、通常どおり Graph に使われる」を、製品の worker binary でも満たす。確認済みの固定値は、per-Revision preflight の `2,097,152 B` と、worker の固定 allocator の query `4,718,592 B`（緩めるには再確認が要る）である。

事実（release の worker binary を、lifecycle lane と同じ手順で測った。fixture は seed の Revision と、承認済みの候補 1 件。A2 は候補を 1 回数え、Graph の応答は載せない）：

- ちょうど N（2,097,152 B）にした候補（decision 行の padding 2,085,131 B）を持つ project で、worker は起動時の registration の最中に SIGABRT した（stderr：`memory allocation of 2085141 bytes failed`）。N+1（2,097,153 B）も同じ（`2085142 bytes`）。owner の prepare は `NIR1_GRAPH_WORKER_EXIT_BEFORE_READY` になる。READY の前に落ちるので、N の正例も N+1 の拒否も、実 worker では確かめられない。
- decision padding を変えた走査（1 case 1 process）：A2 の admission が約 312 KB（padding 300,000）までは、query が成功する（10〜17 ms）。約 412 KB から約 1.61 MB（padding 400,000〜1,600,000）は、registration は通るが query の最中に worker が終了する（`NIR1_GRAPH_WORKER_PIPE_TRUNCATED`）。約 1.7 MB 以上（padding 1,700,000〜2,000,000）は起動時に終了する（`NIR1_GRAPH_WORKER_EXIT_BEFORE_READY`）。閾値は 312 KB と 412 KB の間にあり、2 MiB の preflight の約 15〜20% である。
- payload 側の padding（`evidence_id` を typed writer で伸ばした形。A2 は padding の約 3 倍）：padding 200,000（A2 約 612 KB）で、起動時の registration が SQLite の NOMEM（`NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX`）で失敗する。registration は project 全体なので、該当する Revision が 1 件あるだけで、その project の実 worker は起動できない。（padding 0〜150,000 の拒否は、padding 0 でも起きた別の理由で、その probe の形は調べていない。容量の根拠にしない。）
- メモリの行き先（コードの読み。コピーごとには測っていない）：2.08 MB の `decision_json` の String が、起動時に 4.5 MiB の Q arena に取れない。`read_a3_decision_token` が `decisionJson` を含む `json!` を作り、`canonical_json_digest` が倍々に伸びる String を作る間、A2 の Decision の構造体が同じ String を持つ。
- 通常の allocator の in-process では、同じ fixture が N で available、N+1 で preflight の拒否になる（CR-2 の試験）。

結果は安全側である。worker が異常終了し、Graph は unavailable になり、部分 Graph は出ない。ただし利用者に見えるのは preflight の拒否ではなく worker の異常終了で、registration が project 全体なので、1 件の Revision で project の実 worker が起動しなくなる。

確認済みの 2 つの固定値が両立しないので、値を変えない限り通らない。選択肢（どれも確認済みの値か、大きな変更に触れる）：

- (a) per-Revision preflight を、実 worker が処理できる値まで下げる（decision の形で約 0.3 MB。payload の形ではさらに小さい）。
- (b) worker の Q arena を広げる（allocator の値と memory 需要の再確認）。
- (c) 値を保ったまま、A2／A3 のメモリの増幅（decision_json の複製、`read_a3_decision_token` の `json!`、canonical 文字列の倍々の増加、payload と envelope の Value）を減らす実装の変更。payload の形では 2 MiB に届かない可能性があり、先に測定が要る。
- (d) 両方の値を保ち、RB-2 の正例は実 worker では未達と記録する。worker が異常終了して Graph が unavailable になる fail-safe は保たれるが、利用者に見えるのは preflight の拒否ではない。

決まったら、lifecycle lane の通常 build の区間（registry33 の case の後、seam を足した worker の build の前）に、N と N+1 の実 worker の case を 2 つ足し、`scripts/local-ci-full-workload-allocation.json` の script の sha256 を更新する（先例は CR-1 の `75074118`）。実 worker の試験 2 件の草稿は commit していない。

### 7.3. G-4：Scene 8 は CP-1 の受入れに移す

- CR-2 の基点だった `fbdc8588` では、`MAX_GRAPH_SCENES`（8）の参照が定義の 1 か所だけで、reader の応答に Scene が無かった。Scene join は CP-1（#641、master の `8ff9d559`）で接続された。CR-2 は Scene 8 を試験していない。
- CP-1 の実装は、到達した Entity の pin を、共有の 512 件／6 MiB の予算の内で全件数え、超えたら `NIR1_GRAPH_SCENE_PIN_LIMIT` で拒否する。そのうえで順位順に先頭の 8 Scene を返し、総数を `scene_total` に入れる。つまり 8 件を超える分は打切りで、拒否ではない。CP-1 の試験に、打切りと `scene_total`（`scene_join_truncates_to_eight_and_reports_scene_total`）と、pin の予算の超過での拒否（`graph_with_pin_overflow_is_unavailable_without_partial_graph`）がある。
- 契約の読み方が分かれる。proposal/6 の固定値の表は、seed-local query の行に Scene 8 を含め、超えたときを「同上」（その query 全体を拒否し、部分 Graph を出さない）としている。一方、post-B §6.2 は「返却Scene 8」と書く。Scene 8 を返却数の上限と読めば CP-1 は契約どおりで、超えたら拒否と読めば食い違う。「同上」が Scene 8 にもかかるかは、CP-1 の受入れの記録で明示する。曖昧なら確認に出す。
- C-resource の HOLD からは外し、CP-1（C-product）の受入れで扱う。

### 7.4. HOLD の扱い

- 解除済み：CR-1 の範囲。§1 に挙げた「充足」の行と、「一部充足」の行のうち試験がある部分。条件は、CR-1（#636）の merge と最終 head の Quick・PR checks・lane 6本の green（CR-1 の squash commit：750741183cf4d75ccf18b3904a5751b762284bda）。U7（2026-10-13 のユーザー決定）により Full は merge 後の master で走らせる。
- CR-2 で解除する：G-3 と、G-1、G-2、G-4 のうち試験を足した部分（writer の N／N+1 と上限ちょうどの保存と A2 の読取、preflight の N／N+1 と本番の worker 構成の正例・負例、unknown seed、3 hop、Entity 12、edge 144）。条件は、CR-2 の merge と最終 head の PR checks の green（§3.4）。
- 残す：[precheck] の2点。G-1 の B の上限近傍の publish（§7.1）と、G-2 の実 worker の正例（§7.2）。L6〜L9実行計画の残HOLD表に、別の行として記録した。
- 移す：G-4 の Scene 8。CP-1 の受入れ（§7.3）。
- 変えない：製品の Graph 入口（A-1）。Graph の公開、local 送信、固定値と閾値、確認台帳の各行。K2〜K6 の内容。

## 8. 記入済みの項目と残る確認

| 項目 | 内容 |
|---|---|
| 最終 head の結果 | §3.2、§3.3、§4 の H3 の列に記入した。Quick、PR checks（attempt 2）、lane 6本は success。Full は取り消した（U7） |
| CR-1 の merge | squash commit `750741183cf4d75ccf18b3904a5751b762284bda`、2026-10-13T14:06:23Z（23:06 JST）。first parent は `dabbed14711561693b0a86de0241873a9beafa04` で、候補の base と一致する。tree は H3 の tree と同一（`4b0ea72e85d6bbbc19e05f4c80d48f456d18585b`） |
| merge 後の master の Full | run `38410553482`（base `dabbed14`、head `75074118`）。実行中で、結果は master の Full の記録で追う（CR-REC の時点の記入） |
| H3 の後片付けの試験 commit | integrator が差分を読んで確認した（§5）。独立受入れは行っていない |
| PR 本文の D3〜D5 | §6 の書き方のまま |
| CR-2 の hosted checks | CR-2 の PR の最終 head の PR checks（`Shared Rust crates` を含む）の green。CR-2 の充足の条件（§3.4） |
| CR-2 の中間レビュー | §5.1。P2 が 1 件、P3 が 2 件で、いずれも直した。修正の後の独立受入れは行っていない |
| 残 HOLD | [precheck] の2点：G-1 の B の上限近傍の publish（§7.1）、G-2 の実 worker の正例（§7.2）。ユーザーの確認を待つ。G-3 と、G-1／G-2／G-4 の試験を足した部分は、CR-2 の merge で解除する。G-4 の Scene 8 は CP-1 の受入れに移す（§7.3） |
| 観測した制約 | SQL steps、records、版の衝突、Entity 12（§2.11）。受け入れるかどうかの確認を待つ。records の数え方と版の衝突は CQ-AVAIL（§2.12）が委任の内で直した |
| CQ-AVAIL | 本変更の PR の hosted checks の green。hosted の 3 OS での Q512 の call（新しい fixture。変更前の base は ubuntu 18.7 ms、macos 15.3 ms、windows 26.3 ms）は、最初の run で観測して §4.1 に足す。50 場面の主人公級が 512 に届くことは、上限の値の見直し（proposal/7）に残る（§2.12）。Full workload allocation の `worker.q512` の再導出（DR-CQA-4）は dataset の変更なので、独立 review の対象にする |
