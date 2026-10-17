# CQ-LIM の委任判断の記録（継続計画 §3.2 の形式）

proposal/7（[contract-proposal-7-draft](../nir1-l6-l9-contract-proposal-7-draft.md)。2026-10-17 Session B2 で `graph-limited-binding` の1文が確認済み）の実装レーン。値は確認済みの推奨の組で、この記録は値を決めるものではなく、値を入れるときの実装上の分類と技術判断を残す。

CQ-LIM-1（query の上限の分離と値の変更）の記録を最初に書いた。mutation の前に表を作る手順だったが、使用箇所の分類が grep と試験の失敗で確定する性質だったため、この記録は実装と同じ commit に書いた（mutation の前の記録は作れなかった）。後の subtask（CQ-LIM-2〜4）は、それぞれの mutation の前に行を足す。

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQL-1 | 2026-10-17 | CQ-LIM-1 | query 側の records の上限を `grimodex_core::narrative_nir1::MAX_GRAPH_QUERY_RECORDS`（2,048）として足し、`MAX_GRAPH_RECORDS`（512）は Revision 側の名前と値のまま残す。置き場所を core にしたのは、Revision の上限（bundle 検査）と同じ層で対にして読めるようにし、db の `nir1_graph` と frame・projection が同じ定数を import するため。全使用箇所を下の分類表で分けた。A3 の `admit_rows`（`input.rs`）は query の残り（`remaining`）に従い、`remaining.min(MAX_GRAPH_QUERY_RECORDS)` とする。呼出し3か所（A3 の shared、Revision ごと、Revision の追加行）はどれも query の残りの records を渡しており、Revision の 512 を残す案は採らない | 値は draft で確認済み。名前の分離は実装の分類で、数値の緩和ではない。Revision の 512（bundle・writer・A2 の per-Revision）は変えない。他の lane が `MAX_GRAPH_RECORDS` を query の文脈で新たに使うと 512 のままになる（後述の注意） | 既存の名前を query 用に付け替え、Revision 側を別名にする（他の lane の差分と静かに衝突する） | 不要（値は確認済み。分類は実装の委任の範囲） | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-2 | 2026-10-17 | CQ-LIM-1 | `MAX_GRAPH_NODES`＝50、`MAX_GRAPH_EDGES`＝512（`GraphLimits` の既定値と `bounded_graph` の検査が従う）。固定長配列と reserve が従う箇所: `worker_frame.rs` の `NodeTable`（`[&str; 50]`、`[u8; 50]`）、`GraphView::edge_offsets`（`[u32; 512]`＝2 KiB）、`validate_graph` の `[&str; MAX_GRAPH_QUERY_RECORDS]`（約 32 KiB）、`nir1_graph.rs` の Vec の capacity と保持見積り。最大の配列は約 32 KiB で、frame の validate の stack に載る配列の合計も約 36 KiB。worker の thread（既定の stack は 2 MiB 以上）と Native の呼出し thread のどちらでも十分小さい（thread の stack の大きさは変えていない）。node ごとの bindings と scopes の Vec は query の records 分を先取りで計上するので、Entity 50 の最悪で 2,048×16 B×50＝1,638,400 B（peak の台帳 6,291,456 B の 26%）。台帳の値は変えず、超えれば既存の `NIR1_GRAPH_RETAINED_LIMIT` で全体を typed に拒否する | 値は確認済み。peak の台帳、時間 100 ms、2hop、Scene 8、Revision 512 は変えない | 配列を heap にする（stack の懸念が無いので不要） | 不要 | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-3 | 2026-10-17 | CQ-LIM-1 | frame 上限の N の正例（A7）は、frame の層の単体（`encode`／`validate`／projection）で 50 Entity・512 edge の最大の Graph を通し、+1 を `NIR1_GRAPH_FRAME_COUNT` で拒否することで確かめる。frame の全体の大きさ（`FRAME_BYTES`）の最悪値は CQ-LIM-2 で Native 3 MiB に上げるときに実 worker で確かめる（この subtask では `FRAME_BYTES` を変えない）。worker 経路の大きい N の正例は、in-process 等価経路（`worker_reader()` と `query_for_worker_with_maintenance_deadline`）で取る。records・pages・Entity・edge の大きい N の試験は、lease を `LARGE_N_LEASE`（10 s。`tests.rs` の試験内の値で製品の上限ではない）にして取り（`worker_query_large`／`query_large`。records の試験は元から 30 s）、機械の負荷で deadline の拒否に変わらないようにした。N+1 の拒否も同じ lease にする。pass／fail は件数で決まる、製品の `QUERY_DEADLINE`（100 ms）は変えない。実 worker の `#[ignore]` 試験は、Q512 の既存 fixture（hash 束縛。変更なし）に、試験内で disposable copy へ足す decoy 行を載せる形で取る | 新しい上限・時間・件数の数値を足さない | frame の N を実 worker だけで取る（時間が pass／fail に混ざる） | 不要 | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-8 | 2026-10-17 | CQ-LIM-1 | 期待値を変えた既存試験の一覧（上限超過で unavailable だったもの、または上限の値そのものを期待値に持っていたもの）と、変えていないことを確かめた回帰を下に残す | 上限の内で available だった query の node・edge・順序は変わらない | なし | 不要 | 該当なし | 不要 | 記録済み（CQ-LIM-1 の分。後の subtask が追記） |
| DR-CQL-9 | 2026-10-17 | CQ-LIM-1（レビュー指摘の修正） | 改名した worker の負例を CI の script が呼べなくなった問題を、同じ PR の中で直す（上の「CI の配線」）。`--ignored` の filter が 0 件に一致したら script が失敗するようにする。frame の `validate_graph` の binding の重複検査は、借用した id の列を in-place に sort して隣と比べる O(n log n) にした（binding の上限を 512 から 2,048 に上げると、従来の O(n²) の比較は forged frame で node あたり約 10 ms になるため）。割当ては stack の固定長配列のまま（heap を足さない）。`LARGE_N_LEASE` で時間を pass／fail から外す（DR-CQL-3） | 新しい上限・件数の数値なし。hash 束縛の script の変更は sha256 と ci-pause／local-ci の試験を同期 | 名前を元に戻す（試験の意味が変わった改名を隠す）、script 側の変更を次 subtask に送る（その間 CI に穴が残る） | 不要 | 該当なし | 不要 | 記録済み（実装済み） |

## MAX_GRAPH_RECORDS の使用箇所の分類（DR-CQL-1）

`a0ce11aa` の worktree での全使用箇所。「Revision」は 1 つの保存済み Revision の中の records の上限（512 のまま）、「query」は 1 query が Revision・Scope・Scene の行を合わせて読む総数の上限（2,048）。

| 場所 | 数えるもの | 分類 | 理由 |
|---|---|---|---|
| `grimodex-core/src/narrative_nir1.rs` の bundle 検査（entities、relations、record_count） | 1 Revision の object、relation、revision、Evidence の行 | Revision（512） | writer と bundle の上限 |
| `nir1_entity_relation.rs`（`:3855`、`:3944`） | 1 Revision の entity_ids + relation の行 | Revision（512） | typed Revision の admission |
| `nir1_entity_relation_index.rs:57`（`REVISION_RECORD_ADMISSION`） | B の build が 1 Revision で許す records | Revision（512） | B は変えない（U6） |
| `nir1_graph.rs`（`QueryUsage::admit`、`:1799`・`:2382` の records 判定、`page_limit`、各 preflight の `remaining`、`SceneJoinBudget::new`） | query が admit した行の合計 | query（2,048） | 全 Revision と project 共有の行の合計 |
| `nir1_graph.rs`（`revision_capacity`、node ごとの bindings と scopes の Vec capacity、その保持見積り） | query が評価する Revision の数の上限、node が持つ binding の数の上限 | query（2,048） | 1 Revision は最低 1 行を admit するので、評価する Revision の数と 1 node の binding の数は query の records を超えない |
| `nir1_graph/input.rs:324`（`admit_rows`） | A2・A3 の追加行の合計の上限 | query（2,048。`remaining` が先に効く） | 呼出し3か所とも query の残りを渡す |
| `nir1_graph/worker_frame.rs`: `node()` の `bindings.len()`、`run(.., MAX_GRAPH_QUERY_RECORDS, node_binding)`、`validate_graph` の `revisions` 表、`scene_total`（encode と validate） | node の binding の数、Scene の総数 | query（2,048） | binding は query の Revision ごと、Scene の総数は query が数える pin の行 |
| `nir1_graph/worker_frame.rs`: `entity()` の `evidence.len()`、`relation()` の `evidence_ids.len()`、`run(.., MAX_GRAPH_RECORDS, evidence)`、`run(.., MAX_GRAPH_RECORDS, text)` | 1 Entity の Evidence、1 Relation の evidence_ids | Revision（512） | Entity は 1 Revision の bundle から来て（bundle 検査で Evidence は 512 以下）、複数の Revision にまたがって増えない。draft が「frame と projection の検査を query の値に追従」と書くのは records の総数と binding の数で、1 Entity の Evidence ではない。512 のままでも forged の frame を同じ強さで拒否する |
| `nir1_graph/worker_projection.rs`: `binding_count()` | node の binding の数 | query（2,048） | 上と同じ |
| `nir1_graph/worker_projection.rs`: `evidence_count()`、`evidence_id_count()` | 1 Entity・Relation の Evidence | Revision（512） | 上と同じ |
| 試験（`tests.rs`、`tests/cq_avail.rs`、`tests/cq_opt.rs`、`oracle_tests.rs`、`input.rs`、`worker_frame.rs`） | query の残りを渡す引数、decoy の数、binding の数 | query（2,048）。Revision の 512 を確かめる assert は `MAX_GRAPH_RECORDS` のまま | 各試験の意味に合わせた |

注意: 後に merge される lane（X1-3、CB-1〜4、DF+ など）が query の records を数える新しい箇所に `MAX_GRAPH_RECORDS` を使うと、512 のままになる。rebase で `MAX_GRAPH_RECORDS` の新しい使用箇所を grep し、query の文脈なら `MAX_GRAPH_QUERY_RECORDS` に直す。

## 値の変更（確認済み）

| 定数 | 旧 | 新 | 場所 |
|---|---|---|---|
| `MAX_GRAPH_QUERY_RECORDS`（新設） | 512（`MAX_GRAPH_RECORDS` と同一だった） | 2,048 | `grimodex-core::narrative_nir1` |
| `MAX_GRAPH_RECORDS`（Revision） | 512 | 512（変更なし） | 同上 |
| `QUERY_MAX_PAGES` | 32 | 128（1 page 16 件のまま） | `nir1_graph.rs` |
| `QUERY_SQL_STEPS` | 100,000 | 600,000（取消の確認は 1,000 steps ごとのまま） | 同上 |
| `MAX_GRAPH_NODES` | 12 | 50 | core |
| `MAX_GRAPH_EDGES` | 144 | 512 | core |
| 2hop、Scene 8、時間 100 ms、peak 6,291,456 B、入力 6,291,456 B | — | 変更なし | — |

## 期待値を変えた既存試験（DR-CQL-8）

上限を超えて unavailable だったもの、または上限の値を期待値に持っていたもの。

| 試験 | 変更 |
|---|---|
| `tests.rs`: `twelve_discovered_entities_are_admitted_and_the_thirteenth_is_refused` | `graph_entities_at_50_is_available`／`graph_entities_at_51_refuses_the_whole_graph` に分けた（star 10／11 → 48／49。N は production の step と worker で available、N+1 は uncapped step と worker で全体 unavailable） |
| `tests.rs`: `one_hundred_forty_four_distinct_edges_are_admitted_and_the_145th_is_refused` | `graph_edges_at_512_is_available`／`graph_edges_at_513_refuses_the_whole_graph` に分けた。1 Revision は 507 Relation までなので、Revision 1 本（507 edge）＋ 1 edge ずつの承認済み Revision で 512／513 を作る。worker の reader で取る（ordinary reader は下の理由で別） |
| `tests.rs`: `unrelated_reverse_dependencies_do_not_consume_seed_local_budget`、`oversized_seed_candidate_set_is_refused_without_partial_graph`、`oversized_hop1_candidate_set_is_refused_at_a_partial_page_boundary` | decoy 513／513／600 を `MAX_GRAPH_QUERY_RECORDS` + 1／+ 1／+ 88 に |
| `tests.rs`: `scene_join_*`、`graph_with_pin_overflow_*`、`fixed_worker_arena_*`、`seed_a2_a3_usage` など | `MAX_GRAPH_RECORDS`／`QUERY_MAX_PAGES` の参照を query の定数へ。`fixed_worker_arena_*` は 512／100,000 の assert を 2,048／600,000 に |
| `tests.rs`: Q512／canonical の worker 試験 3 本と `native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge` | fixture が charge する 512 行は「former limit」ではなく Revision 512 形の通常の query になった。charge は定数 `CANONICAL_CHARGED_ROWS`（512）で確かめる。Q513 は 513 行では refusal しなくなったので、`native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` に改め、decoy 行を 1,537 件（512 + 1,537＝2,049）disposable copy に足す。fixture ファイルと capacity fixtures は変えない |
| `tests/cq_avail.rs`: `the_record_budget_admits_512_and_refuses_513_*` | `query_records_at_2048_is_available`／`query_records_at_2049_refuses_the_whole_graph` に分けた（worker の reader のみ） |
| `tests/cq_avail.rs`: `shared_reads_return_the_response_of_reading_per_revision_on_every_shape`、`every_response_survives_the_worker_frame_unchanged` | shapes の数をハードコードの 44 から導出に変えた。`every_response_*` は edge の限界の worker 理由を `edges-513` の shape が引き続き満たす |
| `tests/cq_opt.rs`: shapes | `relations-145`（旧 edge-limit）は `graph(2, 145)`、`star-11`（旧 node-limit）は `graph(13, 12)` の available に。`edges-513`（edge-limit）、`star-48`（`graph(50, 49)`）、`star-49`（node-limit）を足した。`query_steps_stay_far_below_the_budget_*` は 600,000 の assert |
| `nir1_capacity.rs`: `fixed_graph_sql_budget_admits_100000_steps_and_refuses_100001` | `..._admits_600000_steps_and_refuses_600001`。1 行 23 steps＋17、padding 文 1 本目 9・以後 4 から、26,082 行と padding 23 本で 600,000 steps ちょうど |
| `oracle_tests.rs` | unrelated decoy を `MAX_GRAPH_QUERY_RECORDS` + 1、same-source stale rows を `MAX_GRAPH_QUERY_RECORDS` に。step は `QUERY_SQL_STEPS` |
| `worker_frame.rs`: `nqg3_node_binding_cap_*`、Scene の `total over 512` | binding の cap の N／N+1 を 2,048／2,049、Scene の総数を 2,048 に。`nqg3_graph_counts_admit_50_nodes_and_512_edges_and_refuse_51_and_513` を足した |
| `input.rs` の disclosure 試験 | 追加行の数を 2,048 超に（`MAX_GRAPH_QUERY_RECORDS / 2` と `MAX_GRAPH_QUERY_RECORDS`） |

新しく足した試験: `query_pages_at_128_is_available`、`query_pages_at_129_refuses_the_whole_graph`（pages だけが先に当たる fixture。seed の reverse-index の list が `16 × 79 − 1` 行で pages 128、+1 行で 129）、`query_retained_reservation_at_2048_stays_within_the_peak_ledger`、core の `graph_query_limits_are_distinct_from_the_revision_record_limit`、`bounded_graph_admits_50_nodes_and_512_edges_and_refuses_beyond`、`a_bundle_of_513_records_is_refused_although_a_query_may_read_2048`。

Revision の 512 の既存試験（bundle の N／N+1、writer の `bounded_writer_bundle`、B の成分 guard、`REVISION_RECORD_ADMISSION`）は変更なしで通る。

## 試験の取り方の注意

- ordinary reader（非 product の `Nir1GraphReader::query`）は、一時的な複製の見積り（生 bytes の 8 倍 + 1 行 4 KiB）を peak の台帳に先取りで載せる。この見積りだけで、records 2,048 の手前（約 1,500 行）や 507 Relation の Revision で 6,291,456 B を超え、ordinary reader は先に拒否する。ordinary reader は製品の経路ではない（製品は worker で、worker は固定の arena がこの見積りを置き換える）ので、見積りの係数は変えず、records と edge の N の試験は worker の reader（`worker_reader()`）で取る。
- pages は、台帳の通り「全 page を読み切っても行が残らなければ拒否しない」（page 128 に達した後の has-more の probe が空なら通る）。そのため pages の N+1 は、129 ページ目を要する実際の行がある状態で作る。

## CI の配線（対応済み）

`scripts/nir1-c-query-worker-ci.sh`（hash 束縛）は、改名前の `native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge` を名前で実行していた。改名後は該当する試験が無く `cargo test` が 0 本で成功するため、2,049 行の worker の拒否の試験が CI で実行されなかった。レビューの指摘を受け、同じ PR の中で次を行った（DR-CQL-9）。

- script の呼出しを `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` に直した。`scripts/ci-pause.test.mjs`、`scripts/local-ci.test.mjs`、`docs/plans/nir1-c-query-acceptance-2026-10.md` の旧名も新名にした。
- `--ignored` の実 worker 試験の全 17 呼出しの出力を `ignored_log` に tee し、直後に `assert_ignored_test_ran`（`test result: ok. N passed; 0 failed;` で N が 1 以上）を置いた。名前の filter が何にも一致しない場合は `0 passed` で cargo が成功するため、script が失敗する。lifecycle の `run_lifecycle_case` は元から同じ確認を持つ。
- `scripts/ci-pause.test.mjs` の mock cargo は、各 `test` 呼出しで `1 passed` を出し、環境変数 `MOCK_ZERO_TESTS=1` では `0 passed` を出す。既定と全 opt-in lane が 0 件で失敗する（exit 1、fixture の cleanup が残らない）負例を足した。
- `scripts/local-ci-full-workload-allocation.json` の `scripts/nir1-c-query-worker-ci.sh` の sha256 を更新した。

## 後続 subtask への引継ぎ（レビューの P3 のうち、この commit で扱わなかったもの）

- 実 worker の arena（`QUERY_BYTES` 4,718,592 B）は CQ-LIM-1 では変えていない。node ごとの bindings／scopes の Vec は `with_capacity(2,048)` で約 32 KiB を実際に確保するので、Entity 50 で 1.6 MB（arena の約 35%）になる。論理の台帳（6,291,456 B）は arena を守らない。CQ-LIM-2 で Q を 16 MiB にするときに、50 Entity・2,048 records の実 worker の正例（SIGABRT でなく available か typed unavailable）を足し、結果を記録する。CQ-LIM-1 を単独で build／release しない。
- 記録を実装と同じ commit に書いた手順の逸脱は、PR 本文に書く（integrator）。CQ-LIM-2〜4 は mutation の前に行を足す。

## レビュー指摘の修正（clippy と試験の固定）

- `Entity 50/51` の試験が `query_large` に移ったあとで呼出しが 0 件になったテスト用ヘルパー `query_with_steps`（`nir1_graph/tests.rs`）を削除した（dead_code で `cargo clippy -p grimodex-core -p grimodex-db --all-targets -- -D warnings` が赤になっていた）。`#[expect(dead_code)]` は使わない。`UNCAPPED_SQL_STEPS` は `query_large` の呼出しが使うので残し、comment を実際の使用に合わせた。clippy は同じ command で再実行し、warning／error なしで通った。
- `shared_reads_return_the_response_of_reading_per_revision_on_every_shape` に `SHAPES_COUNT`（15）を足した。比較件数の期待値は `shapes()` 由来のままで、shape の脱落は個数の固定で検出する。shape を足す・消すときはこの定数を意図して更新する。
- 索引 README の cq-lim の行を「DR-CQL-1〜3、8、9」に直した。
