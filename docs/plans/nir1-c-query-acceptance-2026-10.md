# NIR-1 C-query 受入れ台帳（CR-REC、2026-10）

更新日: 2026-10-13

| 項目 | 値 |
|---|---|
| 状態 | CR-1（#636）は 2026-10-13T14:06:23Z に merge された（squash commit `750741183cf4d75ccf18b3904a5751b762284bda`）。HOLD の解除は有効。G-1〜G-4 は HOLD のまま（後続は CR-2）。merge 後の master の Full は実行中 |
| 対象 | C-resource: C-query の functional／resource-safety、100 ms result lease、SQL、cleanup。[L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の残HOLD表にある「C-queryのfunctional/resource-safety・100 ms lease、SQL・cleanup」の行 |
| 契約 | `nir1-l6-l9-contract-proposal/6#graph-limited-binding` と `nir1-l6-l9-contract-proposal/6#nir1-defensive-resource-limits`（どちらも 2026-10-12 に確認済み）。固定値と閾値は変えない |
| 条件の正本 | [post-B §12](nir1-post-b-execution-plan.md#12-必須試験の追跡表) の CQ-1〜3 と [§6.4](nir1-post-b-execution-plan.md#64-受け入れ)、L6〜L9実行計画の proposal/6 節（Acceptance implications）、[C-query 資源・lifecycle 境界](nir1-c-query-memory-enforcement-v1-draft.md) の「維持する機能・workload・認可契約」 |
| 候補 | CR-1（[PR #636](https://github.com/kazormia296/Grimodex/pull/636)、branch `claude/nir1-cres`、merge 済み）。head は §3.1。run は `kazormia296/Grimodex` の GitHub Actions の run ID |
| 位置づけ | 受入れの記録。契約の批准、閾値の変更、製品公開（Graph、local 送信）の根拠にしない。製品の Graph 入口は閉じたまま（A-1） |
| 残る確認 | merge 後の master の Full（run `38410553482`）は実行中で、結果は master の Full の記録で追う。それ以外の欄は記入済み（§8） |

## 1. 結論と HOLD の扱い

- 本台帳は C-resource の受入れ条件を一つずつ挙げ、CR-1（#636）の試験と lane の run に対応づける（§2）。対応する証跡が無い条件は「未充足」とし、他の証跡で代えていない（§7）。
- 解除する範囲は、§2 で「充足」とした行（CQ-1〜3、RB-3、RB-5〜RB-7、LC-1〜LC-9、NB-1、PF-1、A-1）と、「一部充足」とした行のうち試験がある部分である。
- 残す HOLD は、「一部充足」の行の足りない部分（§7 の G-1〜G-4）である。どれも CR-1 の試験では固定されていない境界で、後続の CR-2（branch `claude/nir1-cr2`、試験だけの PR、進行中）で足して本台帳に追記してから解除する。
- 解除の条件は、CR-1（#636）の merge と、最終 head の Quick・PR checks・lane 6本の green で、いずれも満たした（CR-1 の squash commit：750741183cf4d75ccf18b3904a5751b762284bda）。結果は §3.2。U7（2026-10-13 のユーザー決定）により Full は merge 後の master で走らせる。
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

### 2.2. 一覧

| ID | 条件 | 判定 |
|---|---|---|
| CQ-1 | 候補欠落・世代不一致・keyset 飛ばし → 独立正解に一致、または登録／admission の失効から unavailable | 充足 |
| CQ-2 | seed 近傍を固定して無関係な Revision を増やしても、全件 scan・JSON 展開に退行せず、query の資源の内 | 充足 |
| CQ-3 | 非開示 bridge・方向違い・巨大行・上限・取消 → 禁止寄与 0、部分 Graph なし、Raw 非占有、実 cleanup | 充足 |
| RB-1 | Revision の上限（512 records／6,291,456 B）の N／N+1 と正例 | 一部充足（G-1） |
| RB-2 | per-Revision preflight（2,097,152 B）の N／N+1 と query 全体の拒否 | 一部充足（G-2） |
| RB-3 | Packing の入力の合計（2 MiB）の typed refusal | 充足 |
| RB-4 | query の上限（read／admission 512、batch 16x32、SQL 100,000 steps、request・frame、後続 bytes、枠の使用中、reader／busy） | 一部充足（G-3） |
| RB-5 | 100 ms result lease（Q512 の admission→lease、期限後の結果の不採用） | 充足 |
| RB-6 | 取消（Rust の境界と SQL step での観測、取消でも部分 Graph なし） | 充足 |
| RB-7 | B whole-set の安全失敗（U6） | 充足（P3 を残す） |
| RB-8 | proposal/5 の正例・負例（proposal/6 は変えない） | 一部充足（G-4） |
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

- B の保存済み成分の guard：`nir1_entity_relation_index.rs::persisted_revision_components_are_guarded_independently`（payload と envelope を別々に、6,291,456 B は通し、6,291,457 B は拒否する）、`nir1_entity_relation.rs::graph_index_rejects_oversized_revision_before_parse_and_reuses_connection`（6 MiB を超える payload を `NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT` で、parse の前に拒否し、接続を再利用できる）（共有 Rust）。
- U6 の control：`nir1_entity_relation_index.rs::whole_set_input_limit_refuses_without_replacing_the_sealed_generation` が、payload と envelope がちょうど 6,291,456 B の候補を prepare が admit することを確かめる（RB-7）。

判定：一部充足。writer の保存拒否（513 records、6,291,457 B）と、上限近傍の有効な Revision の正例には試験が無い（G-1）。

#### RB-2：per-Revision preflight（2,097,152 B）

条件：2,097,152 B の内の Revision は通常どおり Graph に使われる。2,097,153 B 以上の Revision が seed から辿った候補にあれば、その query 全体を拒否し、Graph の寄与 0 で R+IR に戻る。

- N+1 の拒否：`input.rs::oversized_documents_abort_before_json_or_related_authority_reads`（payload または envelope が `INPUT_BYTES + 1`）、`disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope`（payload_bytes、Scene 本文、phase、scope の内容が `INPUT_BYTES + 1`）（共有 Rust）。累積 bytes は N で通り、N-1 で拒否される。
- 固定値：A2／A3 の preflight の定数は `input.rs` の `INPUT_BYTES = 2 * 1024 * 1024`。CR-1 は変えていない。

判定：一部充足。ちょうど 2,097,152 B の Revision が通る試験と、2,097,153 B の Revision が候補にあるとき query 全体が unavailable になる reader／worker レベルの試験は無い（G-2）。

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

判定：一部充足。reader は `busy_timeout` 0 の読取専用接続を開く実装だが、SQLITE_BUSY を注入して待たずに unavailable になることを確かめる試験は無い（G-3）。

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

- `nir1_entity_relation_index.rs::whole_set_input_limit_refuses_without_replacing_the_sealed_generation`：実 writer で作った Revision から sealed を publish したあと、payload と envelope がちょうど 6,291,456 B の候補を足す。12 MiB のままなら prepare は通る（control）。同じ Revision に 5 MiB の Decision を足して合計だけを 16 MiB 超にすると、typed `CapacityExceeded`（`input-bytes exceeds 16777216`）になる。成分の guard（`NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT`）による拒否ではないことを確かめる。binding の読取と Graph 面の7 table が byte 一致のまま registered であり続ける（共有 Rust。CR-1 の D4）。

判定：充足。独立受入れの P3 が残る：この試験は read transaction 内の prepare（読取専用）の検査で、製品の B build 経路（prepare から publish までを回す owned maintenance）はまだ配線されておらず（B-ROUTE）、「R+IR に戻る」ことは確かめていない。製品経路での確認は B-ROUTE と C-product（CP-1〜CP-4）で行う。

#### RB-8：proposal/5 の正例・負例（proposal/6 は変えない）

- 正例（再 build と cold reopen の後の path と Evidence の一致）
  - 再 build の後：Q512 の試験が index を prepare と publish で作り直したあと、別 process の worker が DB を開き直して返した frame を、独立した Gold と比べる（CQ-1。既定 worker、practical）。
  - B の sealed roster と、cold reopen の後の binding の再検証：`nir1_entity_relation.rs::graph_index_publishes_sealed_roster_and_reopens_complete`（roster の Evidence 2件、edge 4本、generation、dirty が 0）、`graph_index_file_backed_cold_reopen_revalidates_binding`（DB を閉じて開き直しても registered と complete registered で、依存 graph の検証が通る）（共有 Rust）。query の path を cold reopen の後に比べる試験は、この2件には無い。
- stale・dirty・unqualified edge：CQ-1、CQ-3 の試験。allocation の前の拒否：CQ-3。JSON・material の処理中の取消：RB-6。
- wrong／unknown seed、3 hop、Entity 12／edge 展開 144／Scene 8 の上限：C-query の試験は、実在する seed と2 hop までの正例だけを使う。実装には `seed-not-found` と `hop >= MAX_GRAPH_HOPS` の分岐があるが、試験が無い（G-4）。

判定：一部充足（G-4）。

### 2.7. LC：lifecycle・cleanup（維持する機能・workload・認可契約）

条件：[C-query 資源・lifecycle 境界](nir1-c-query-memory-enforcement-v1-draft.md) の「維持する機能・workload・認可契約」が挙げる、startup、stalled stdin write、receive、cancel／deadline、workspace switch／Restore／old binding、crash／incomplete／trailing frame、lease と reap の両順序、unproved cleanup、Q／S allocation の origin。child・pipe・claim・reader・workspace protection の唯一の owner が、child の exit、必要な EOF、reader の join の成功を証明してから再利用し、証明できなければ quarantine する。

proposal/6 の Recovery（拒否、取消、期限切れの後に、部分的な結果や generation を残さず、owner が後始末し、証明できなければ quarantine し、次の query は新しく始める）も、この LC-1〜LC-9 で確かめる。「B は次の owned maintenance で sealed head から作り直す」は、製品の B build 経路（B-ROUTE）が配線されてから、製品経路で確かめる（RB-7）。

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
| U6 の試験は prepare 単体の検査で、製品の B build 経路は未配線 | 残る（RB-7。B-ROUTE と C-product で確認する） |
| `ordinary_reader_registers_and_queries_fixed_q2_fixture` がどの lane にも配線されていない | 解消。lifecycle lane に配線した（H1 の commit） |
| 許可範囲外の版 assert 2か所（`execute.rs` の試験、`scripts/quality/validate-semantic-core-boundary.{mjs,test.mjs}`）に integrator の確認が要る | 解消。integrator が採用した（D8） |
| `timeout` が発火すると、別 process group の owner-death helper が残る | 残る。失敗経路だけで、lane の失敗という判定は変わらない |
| hard limit が既に 0 の host では `prlimit` が EPERM で失敗し、lane が fail-closed になる | 残る。hosted の ubuntu runner は unlimited なので CI には影響しない |

独立受入れの対象外：H1→H2→H3 の rebase で、受入れ済みの3 commit の patch が `git range-diff` で同一であることを確かめた。H3 で足した後片付けの試験 commit（`nir1_generation.rs`、試験だけ）は、独立受入れを行っていない。integrator が差分を読んで確認した（Native 全体の 272 件 pass、対象の2試験の15回連続 pass、clippy の pass）。merge 後の tree は H3 の tree と同一である（§3.1）。

## 6. CR-1 の判断（D1〜D8）

CR-1 の判断は U3 の委任（[作業記録](nir1-continuation-2026-10.md) の §3）に基づく。D1、D2、D6、D7、D8 は PR #636 本文の「判断と信頼境界（U3 委任）」にある。D3〜D5 は PR 本文に個別の ID が無く、CR-1 の作業記録（`claude-nir1-cres` worktree の `.ralph/agent/decisions.md`。git 管理外）の要旨をここに転記する。

| ID | 判断 | 要旨 | 記録先 |
|---|---|---|---|
| D1 | lifecycle lane の形 | 新 mode `lifecycle`、profile `c-query-lifecycle`。Linux のみ。1試験を1 process で走らせる（process 全体の worker 容量を意図的に quarantine する case があるため。1 process にまとめる案は相互干渉で却下）。`--exact` と `test result: ok. 1 passed` の grep で0件実行の green を防ぐ。case ごとに fresh な入力。Full の registry に入れない | PR 本文 |
| D2 | `ci.yml` の範囲 | worker job の profile 追加に加え、canonical job の除外リストにも profile を足した（worker job だけが admit される契約を守る） | PR 本文 |
| D3 | CR-1 の初版での CQ-2 | A2／A3 の SQL 3文が `narrative_proposal_decisions` を全件走査し、decided な無関係 Revision 6,000件で 91,410 steps になる実欠陥を、EXPLAIN の assert と増量試験が検出した。閾値は上げず、index の migration が要るため初版では HOLD として報告し、CR-1b（D6、D7）で閉じた | `.ralph/agent/decisions.md`。内容は PR 本文の CQ-2、schema v42、計測 |
| D4 | U6 の fixture | 実 writer で作った Revision から sealed を publish し、payload と envelope がちょうど 6 MiB の候補1件を足す。12 MiB の control は通り、5 MiB の Decision を足して合計だけを 16 MiB 超にする | `.ralph/agent/decisions.md`。内容は PR 本文の U6 の安全失敗 |
| D5 | worker build の割り当てと core dump | seam build は commit の後に必ず exit 23 するため、正常な exit を要求する3件（proof unobserved、W1 Restore、file identity）は通常 build の worker に移した。core dump は初版が `ulimit -c 0` だったが、独立受入れの P2 を受けて `prlimit --core=1:1` に変えた | `.ralph/agent/decisions.md`。最終の方式は PR 本文の lifecycle lane の core dump |
| D6 | schema v42 の index | `narrative_proposal_decisions` に `(revision_id, proposal_id)` と `(proposal_id, created_at, id)` の2本。片方だけでは、どちらかの読取が SCAN か TEMP B-TREE に残る。1つの savepoint で作り、checkpoint と user_version の前に置く。失敗したら 41 のままにして次の open で再試行し、片方が欠けたら、その index だけを作り直す | PR 本文 |
| D7 | CQ-2 の受入れ試験の形 | 件数に比例する回帰を検出し、B-tree の端の境界による Decision seek 1本につき最大1 step の差だけを許す。閾値、admission、Gold は変えない | PR 本文 |
| D8 | 許可範囲外の版 assert 2か所 | schema 版の 42 への追従に必要な最小の変更。`execute.rs` の試験と `validate-semantic-core-boundary.{mjs,test.mjs}`。integrator が採用した | PR 本文 |

外部送信、新しい送信先、新しい authority、閾値の変更はない。

## 7. 未充足と HOLD の扱い

§2 で「一部充足」とした条件の、足りない部分を記録する。いずれも CR-1 の試験では固定されていない境界で、実装の欠陥を見つけたものではなく、対応する試験が無いことの記録である。探索の範囲は `src-tauri/crates` と `electron/native` の `git grep` で、対応する試験を確認できなかったものを未充足とした。後続は CR-2（branch `claude/nir1-cr2`、試験だけの PR、進行中）で、worker、NQG1、閾値は変えず、試験だけを足す。足したら、本台帳の該当行を「充足」に改めて、残 HOLD を解除する。CR-REC（この PR）は docs だけで、試験を足していない。

| ID | 条件（出典） | 現状の証跡 | 不足 |
|---|---|---|---|
| G-1 | Revision の513 records と 6,291,457 B は writer が保存しない。上限の内の Revision は保存、A2 の読取、B build の publish ができる（RB-1） | B の保存済み成分の guard の N／N+1（`persisted_revision_components_are_guarded_independently`）と、6 MiB 超の payload の拒否（`graph_index_rejects_oversized_revision_before_parse_and_reuses_connection`） | writer（`create_nir1_entity_relation_revision` が呼ぶ `validate_entity_relation_bundle`）の 512／513 records と byte の N／N+1 の試験。上限近傍の有効な Revision が保存され、A2 で読め、B build で publish される正例 |
| G-2 | per-Revision preflight の 2,097,152 B は通り、2,097,153 B の Revision が候補にあれば query 全体が unavailable になる（RB-2） | preflight の N+1 の拒否（A2 の payload と envelope、A3 の payload・本文・phase・scope） | ちょうど 2,097,152 B が通る試験。2,097,153 B の Revision を候補に置いて query 全体が unavailable になる reader／worker レベルの試験 |
| G-3 | reader／busy の競合で待たずに unavailable になる（wait 0。RB-4） | 枠の使用中（`NIR1_GRAPH_WORKER_BUSY`、`NIR1_GRAPH_WORKER_CAPACITY_BUSY`）、Restore の admission、外部 write との競合 | 他の接続が書込み lock を持つ状態（SQLITE_BUSY）で、待たずに unavailable になることを確かめる試験 |
| G-4 | proposal/5 の負例のうち、wrong／unknown seed、3 hop、Entity 12／edge 展開 144／Scene 8 の上限（RB-8） | 実在する seed の正例と、2 hop の正例（`seed_local_two_hop_query_matches_independent_canonical_projection`） | unknown／wrong seed が `seed-not-found` で unavailable になる試験。3 hop 目に到達しない試験。12／144／8 の打切りを query で確かめる試験 |

HOLD の扱い：

- 解除済み：§1 に挙げた「充足」の行と、「一部充足」の行のうち試験がある部分。条件は、CR-1（#636）の merge と最終 head の Quick・PR checks・lane 6本の green（CR-1 の squash commit：750741183cf4d75ccf18b3904a5751b762284bda）。U7（2026-10-13 のユーザー決定）により Full は merge 後の master で走らせる。
- 残す：G-1〜G-4。後続は CR-2。L6〜L9実行計画の残HOLD表に、解除済みの行とは別の行として記録した。
- 変えない：製品の Graph 入口（A-1）。Graph の公開、local 送信、固定値と閾値、確認台帳の各行。K2〜K6 の内容。

## 8. 記入済みの項目と残る確認

| 項目 | 内容 |
|---|---|
| 最終 head の結果 | §3.2、§3.3、§4 の H3 の列に記入した。Quick、PR checks（attempt 2）、lane 6本は success。Full は取り消した（U7） |
| CR-1 の merge | squash commit `750741183cf4d75ccf18b3904a5751b762284bda`、2026-10-13T14:06:23Z（23:06 JST）。first parent は `dabbed14711561693b0a86de0241873a9beafa04` で、候補の base と一致する。tree は H3 の tree と同一（`4b0ea72e85d6bbbc19e05f4c80d48f456d18585b`） |
| merge 後の master の Full | run `38410553482`（base `dabbed14`、head `75074118`）。実行中で、結果は master の Full の記録で追う |
| H3 の後片付けの試験 commit | integrator が差分を読んで確認した（§5）。独立受入れは行っていない |
| PR 本文の D3〜D5 | §6 の書き方のまま |
| 残 HOLD（G-1〜G-4） | CR-2（branch `claude/nir1-cr2`、試験だけの PR、進行中）。足したら、本台帳の該当行を「充足」に改めて解除する |
