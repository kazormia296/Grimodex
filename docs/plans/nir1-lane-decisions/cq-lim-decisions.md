# CQ-LIM の委任判断の記録（継続計画 §3.2 の形式）

proposal/7（[contract-proposal-7-draft](../nir1-l6-l9-contract-proposal-7-draft.md)。2026-10-17 Session B2 で `graph-limited-binding` の1文が確認済み）の実装レーン。値は確認済みの推奨の組で、この記録は値を決めるものではなく、値を入れるときの実装上の分類と技術判断を残す。

CQ-LIM-1（query の上限の分離と値の変更）の記録を最初に書いた。mutation の前に表を作る手順だったが、使用箇所の分類が grep と試験の失敗で確定する性質だったため、この記録は実装と同じ commit に書いた（mutation の前の記録は作れなかった）。後の subtask（CQ-LIM-2〜4）は、それぞれの mutation の前に行を足す。CQ-LIM-3 の行（DR-CQL-5、6）は、writer の mutation の前に足した。

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQL-1 | 2026-10-17 | CQ-LIM-1 | query 側の records の上限を `grimodex_core::narrative_nir1::MAX_GRAPH_QUERY_RECORDS`（2,048）として足し、`MAX_GRAPH_RECORDS`（512）は Revision 側の名前と値のまま残す。置き場所を core にしたのは、Revision の上限（bundle 検査）と同じ層で対にして読めるようにし、db の `nir1_graph` と frame・projection が同じ定数を import するため。全使用箇所を下の分類表で分けた。A3 の `admit_rows`（`input.rs`）は query の残り（`remaining`）に従い、`remaining.min(MAX_GRAPH_QUERY_RECORDS)` とする。呼出し3か所（A3 の shared、Revision ごと、Revision の追加行）はどれも query の残りの records を渡しており、Revision の 512 を残す案は採らない | 値は draft で確認済み。名前の分離は実装の分類で、数値の緩和ではない。Revision の 512（bundle・writer・A2 の per-Revision）は変えない。他の lane が `MAX_GRAPH_RECORDS` を query の文脈で新たに使うと 512 のままになる（後述の注意） | 既存の名前を query 用に付け替え、Revision 側を別名にする（他の lane の差分と静かに衝突する） | 不要（値は確認済み。分類は実装の委任の範囲） | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-2 | 2026-10-17 | CQ-LIM-1 | `MAX_GRAPH_NODES`＝50、`MAX_GRAPH_EDGES`＝512（`GraphLimits` の既定値と `bounded_graph` の検査が従う）。固定長配列と reserve が従う箇所: `worker_frame.rs` の `NodeTable`（`[&str; 50]`、`[u8; 50]`）、`GraphView::edge_offsets`（`[u32; 512]`＝2 KiB）、`validate_graph` の `[&str; MAX_GRAPH_QUERY_RECORDS]`（約 32 KiB）、`nir1_graph.rs` の Vec の capacity と保持見積り。最大の配列は約 32 KiB で、frame の validate の stack に載る配列の合計も約 36 KiB。worker の thread（既定の stack は 2 MiB 以上）と Native の呼出し thread のどちらでも十分小さい（thread の stack の大きさは変えていない）。node ごとの bindings と scopes の Vec は query の records 分を先取りで計上するので、Entity 50 の最悪で 2,048×16 B×50＝1,638,400 B（peak の台帳 6,291,456 B の 26%）。台帳の値は変えず、超えれば既存の `NIR1_GRAPH_RETAINED_LIMIT` で全体を typed に拒否する | 値は確認済み。peak の台帳、時間 100 ms、2hop、Scene 8、Revision 512 は変えない | 配列を heap にする（stack の懸念が無いので不要） | 不要 | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-3 | 2026-10-17 | CQ-LIM-1 | frame 上限の N の正例（A7）は、frame の層の単体（`encode`／`validate`／projection）で 50 Entity・512 edge の最大の Graph を通し、+1 を `NIR1_GRAPH_FRAME_COUNT` で拒否することで確かめる。frame の全体の大きさ（`FRAME_BYTES`）の最悪値は CQ-LIM-2 で Native 3 MiB に上げるときに実 worker で確かめる（この subtask では `FRAME_BYTES` を変えない）。worker 経路の大きい N の正例は、in-process 等価経路（`worker_reader()` と `query_for_worker_with_maintenance_deadline`）で取る。records・pages・Entity・edge の大きい N の試験は、lease を `LARGE_N_LEASE`（10 s。`tests.rs` の試験内の値で製品の上限ではない）にして取り（`worker_query_large`／`query_large`。records の試験は元から 30 s）、機械の負荷で deadline の拒否に変わらないようにした。N+1 の拒否も同じ lease にする。pass／fail は件数で決まる、製品の `QUERY_DEADLINE`（100 ms）は変えない。実 worker の `#[ignore]` 試験は、Q512 の既存 fixture（hash 束縛。変更なし）に、試験内で disposable copy へ足す decoy 行を載せる形で取る | 新しい上限・時間・件数の数値を足さない | frame の N を実 worker だけで取る（時間が pass／fail に混ざる） | 不要 | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-8 | 2026-10-17 | CQ-LIM-1 | 期待値を変えた既存試験の一覧（上限超過で unavailable だったもの、または上限の値そのものを期待値に持っていたもの）と、変えていないことを確かめた回帰を下に残す | 上限の内で available だった query の node・edge・順序は変わらない | なし | 不要 | 該当なし | 不要 | 記録済み（CQ-LIM-1、2、3 の分。CQ-LIM-4 が追記） |
| DR-CQL-9 | 2026-10-17 | CQ-LIM-1（レビュー指摘の修正） | 改名した worker の負例を CI の script が呼べなくなった問題を、同じ PR の中で直す（上の「CI の配線」）。`--ignored` の filter が 0 件に一致したら script が失敗するようにする。frame の `validate_graph` の binding の重複検査は、借用した id の列を in-place に sort して隣と比べる O(n log n) にした（binding の上限を 512 から 2,048 に上げると、従来の O(n²) の比較は forged frame で node あたり約 10 ms になるため）。割当ては stack の固定長配列のまま（heap を足さない）。`LARGE_N_LEASE` で時間を pass／fail から外す（DR-CQL-3） | 新しい上限・件数の数値なし。hash 束縛の script の変更は sha256 と ci-pause／local-ci の試験を同期 | 名前を元に戻す（試験の意味が変わった改名を隠す）、script 側の変更を次 subtask に送る（その間 CI に穴が残る） | 不要 | 該当なし | 不要 | 記録済み（実装済み） |
| DR-CQL-4 | 2026-10-17 | CQ-LIM-2 | registration の検査は fail-safe（READY にしない typed refusal）に倒す。方式: worker の registration の Revision ごとの長さの SQL（JSON 関数を使わない `octet_length` の和。payload・envelope・metadata〔decision とその付随の行を含む〕。`input.rs` の `LENGTH_SQL` と同じ式）の直後で、B の component guard（payload または envelope が 6,291,456 B 超の Revision。従来どおり承認済みなら `persisted-revision-component-bytes` の capacity 拒否、未承認なら skip）の後ろ、JSON の式と parse の前に、checked arithmetic で A2 admission bytes を数える。component guard を先にしたのは、B-GUARD の現行の扱い（6 MiB 超の承認済み Revision の registration は `validation-capacity-exceeded` の limit 拒否。`oversized_approved_revision_refuses_the_readers_registration`）を変えないため。承認済み（`revision_is_approved`）の Revision が 2,097,152 B（per-Revision preflight。`input.rs` の `INPUT_BYTES` を単一の出所にする）を超えたら、専用の型付きエラー `RegistrationRevisionInputLimit` で registration を止め、worker は専用の marker `NIR1_C_QUERY_STARTUP_REGISTRATION_REVISION_INPUT_LIMIT` を stderr に出して `ExitCode::FAILURE`（exit 1）で終わる。承認されていない Revision は roster に入らない（A2 の reader が Draft として読み、roster は作らない）ので、同じ長さの検査の位置で skip する（B の component guard と同じ扱い）。親は marker を許可リストで受け、`classify_c_query_failure` で既存の `StartupRegistrationRefused`（`registration-unavailable`、backoff に数える）に写す。Native の理由の集合に新しい理由は足さない。B との隔離: 検査は `SourceCapacity` の `registration_a2_limit`（既定 `None`）が `Some` のときだけ効き、`Some` を渡すのは `Nir1GraphReader` の registration（`is_complete_registered_with_scratch` を呼ぶ 1 か所）だけ。B の build・publish・Verify・Rebuild と maintenance の `is_complete_registered_with_control` は `None` を渡し、挙動は変わらない。**効果は P7 案 4 の「止まらない」には届かない（draft が確認済みの fail-safe に倒した）。** 理由: registration は保存済みの index の `source_digest` を、全 qualified Revision の parse 済み bundle から作る roster の digest で再計算して照合し（`graph_source_from_roster`）、`narrative_dependency_edges` の `codex:`／`codex-relation:`／evidence の行を同じ roster と照合する。載せない Revision の roster の行は、その payload を parse しないと作れず、行が欠けると digest が一致せず registration が不成立になる（Revision ごとの部分 digest や「載せない」印を保存するには schema の変更が要り、委任の外）。SQLite の JSON を使わず Rust で S に parse する別経路は、A2 reader の検証（basis と live Source の事前検査）を迂回する別の reader になるため採らない。帯域に注意: A2 が 2,097,152 B を超え、かつ P7 案 3 の Q 16 MiB で登録できたはずの Revision（draft の推定で A2 約 2.7〜2.9 MB まで）も、この fail-safe では READY にならない（案 3 より狭い）。READY にならない代わりに、NOMEM（断片化を含む）の起きる前に、決定的で typed な拒否になり、起動のたびの 5.8 倍の増幅を避ける | 保存した Revision の長さ（untrusted）を JSON の前に数える。保存範囲・schema・IPC・N-API の入口・受信先は変えない。per-Revision preflight 2,097,152 B は変えない | 載せない Revision を除いて READY にする（digest が合わず不成立）、印を保存する（schema 変更）、Rust で S に parse する別経路（reader の検証を迂回）、検査なし（案 3。NOMEM の exit 1 のまま） | 不要（draft が確認済みの fail-safe。方式は委任の内） | 該当なし | **新しい終端 2 つ。DSN §1.3.1 に追記**（下の「owner/lifecycle matrix」） | 記録済み（実装済み） |
| DR-CQL-10 | 2026-10-17 | CQ-LIM-2 | `QUERY_BYTES`＝16 MiB（16,777,216 B）、`PARENT_BYTES`＝3 MiB（3,145,728 B。`FRAME_BYTES` は従来の式で追従）。allocator の静的な footprint の assert、`u32` の assert、試験の 4,718,592 を追従した。`FRAME_BYTES` の実測値と Q の使用量は下の「CQ-LIM-2 の実測」 | 値は draft で確認済み | — | 不要 | 該当なし | 下の matrix の (b) | 記録済み（実装済み） |
| DR-CQL-11 | 2026-10-18 | CQ-LIM-2（レビュー指摘の修正） | 50 場面の主人公級が available であることを通常の試験で固定した（P2）。Revision ごとの 512 records を A2 の preflight にも残した（query-wide の 2,048 に緩んでいた分を戻す。確認済みの値は変えない）。実 worker の複数 payload 形の試験が query の失敗を typed に限る。変更した file の rustfmt。詳細は下の「レビュー指摘の修正（CQ-LIM-2）」 | 値は draft で確認済み。新しい数値なし | — | 不要 | 該当なし | 変更なし（新しい終端なし） | 記録済み（実装済み） |
| DR-CQL-5 | 2026-10-18 | CQ-LIM-3 | RB-1（P7-3）: typed Revision の writer（`nir1_entity_relation.rs` の `create_in_tx`）に、保存する `payload_json` と `reconciliation_envelope_json` をそれぞれ 6,291,456 B（`MAX_GRAPH_INPUT_BYTES`）と比べる検査を足す。検査は DB への最初の INSERT より前（payload は envelope の構築より前、envelope は構築の直後）で、超えたら保存せず typed エラーで拒否する。理由の名前は `NIR1_ENTITY_RELATION_STORED_PAYLOAD_LIMIT` と `NIR1_ENTITY_RELATION_STORED_ENVELOPE_LIMIT`（既存の `NIR1_ENTITY_RELATION_INPUT_INVALID` と同じ「大文字の code + 説明」の形。限界の値と実際の長さを説明に含める）。数値は変えない（counted の 512 records／6,291,456 B の検査は `validate_entity_relation_bundle` に残る）。保存済みのデータと reader は変えない。検査は書込みの前なので、部分的な書込みは残らず、接続は呼出しの前後で autocommit のまま。envelope は同じ counted でも payload の約 2 倍になる形（Evidence の `evidence_id` の padding）があるため、その形では counted 約 3 MiB 超で拒否される。payload だけが超える形（Entity の `label` の padding。envelope に入らない）で payload の検査を独立に確かめる | 保存範囲は狭まる（緩和ではない）。schema・IPC・N-API の入口・受信先は変えない。保存済みの Revision と B-GUARD の成分 guard の扱いは変えない | counted だけを残す（B の成分 guard が保存後に project 全体を止める。台帳 §7.1 の食い違い）、envelope を payload から計算した推定値で比べる（実際の保存 bytes と合わない）、保存後に検査して rollback する（INSERT の費用が無駄になる） | 不要（台帳 §7.1 の選択肢 1-B。ユーザーは Session B2 で proposal/7 の推奨の組を確認済み） | 該当なし | 不要（新しい終端なし。同期の拒否で、非同期・外部送信・subprocess を含まない） | 記録済み（実装済み） |
| DR-CQL-6 | 2026-10-18 | CQ-LIM-3 | 台帳・品質試験の同期の方針: `docs/plans/nir1-l6-l9-execution-plan.md` の proposal/6 の節と `scripts/quality/quality-workflow.test.mjs` の proposal/6 の節を読む assert は履歴を確かめるので残し、proposal/7 の値（records 2,048、pages 128、steps 600,000、Entity 50、edge 512、Q 16 MiB、Native 3 MiB、writer の保存形の検査）を確かめる assert を別に足す。台帳（`nir1-c-query-acceptance-2026-10.md`）は、proposal/6 の時点の記述を履歴として残し、「proposal/7 の後（CQ-LIM）」の節を足して RB-1、RB-2、G-1、G-2 の判定を更新する。G-2 の [precheck] は、CQ-LIM-2 の実 worker の試験が通った事実（下の「CQ-LIM-3 の結果」）に基づいて解除する。G-1 の [precheck] は、writer の検査（1-B）と文言の更新（1-D）を実施したことで、B の上限近傍の publish の食い違いを契約の文言どおりに閉じる | 値は draft で確認済み。新しい数値なし | proposal/6 の節の書き換え（履歴が消える）、未実行の試験を根拠に precheck を解除する | 不要 | 該当なし | 不要 | 記録済み（実装済み） |

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

## CQ-LIM-2 の結果（registration の検査、Q 16 MiB、Native 3 MiB。DR-CQL-4、10）

### registration の検査は fail-safe に倒した（P7 案 4 の効果は未達）

結果: 承認済みの Revision の A2 admission bytes（payload・envelope・metadata の `octet_length` の和）が 2,097,152 B を超える project では、worker は READY にならず、専用の marker で exit 1 する。**「載せない Revision を除いて READY にし、達しない seed は available」という P7 案 4 の効果は得られていない。** draft が確認済みの fail-safe（確かめられなければ READY にしない typed refusal）に倒した。止まる理由にはしていない（schema を足さずに成立する設計がなかったため。理由は DR-CQL-4）。

- 載せない Revision の roster の行は、payload を parse しないと作れない。stored index の `source_digest` と `narrative_dependency_edges` の照合は、全 qualified Revision の roster に対して行うので、1 件欠けると registration が不成立（`Ok(false)`）になる。「載せない」印や Revision ごとの部分 digest の保存は schema の変更（委任の外）。SQLite の JSON を使わず Rust で S に parse する別経路は、A2 reader の事前検査（basis と live Source の長さ）を迂回する別の reader になる。
- 帯域の注意（案 3 より狭い）: A2 が 2,097,152 B を超え、案 3（Q 16 MiB だけ）なら登録できたはずの Revision（R2-5 では counted 690,000〜700,000、registration の使用量 13.4〜13.6 MB で Q の 81%。draft の推定で A2 約 2.7〜2.9 MB まで）は、この fail-safe では READY にならない。その代わり、NOMEM（断片化を含む）の前に決定的で typed な拒否になり、起動のたびの約 5.8 倍の増幅を避ける。案 3 の「止まる境界」は NOMEM の位置（形に依る）から、契約の線（2,097,152 B）に下がった。**この帯域で available を保つには、registration の増幅自体を減らす最適化（draft の対案。proposal/7 では扱わない）か、Revision ごとの印の保存（schema）が要る。proposal/8 の判断。**
- 今回の変更で registration が通らなくなるのは、「承認済み、かつ payload・envelope・metadata の合計が 2,097,152 B 超」の Revision がある project だけ。6 MiB 超の component は B-GUARD の現行の扱い（`validation-capacity-exceeded` の limit 拒否）のまま。未承認の Revision は、大きさに依らず skip する（roster に入らない）。
- 実測の根拠（Q 16 MiB の実 worker）: R2-5 の payload 形で counted 1,000,000 B（registration の count 3,229,622 B）は、新しい marker で READY の前に終わり、NOMEM の marker は出ない（`native_worker_registration_refuses_a_payload_shaped_revision_before_it_runs_out_of_memory`）。変更前（案 3）にこの形が NOMEM になるかは、今回の lane では測っていない（draft の推定）。

### 値と実測（Q 16 MiB、Native 3 MiB）

| 項目 | 値 | 備考 |
|---|---|---|
| `QUERY_BYTES` | 16,777,216 B | 静的な footprint の assert（`WorkerAllocator`）は変更なしで通る |
| `PARENT_BYTES` | 3,145,728 B | `FRAME_BYTES` は従来の式で追従 |
| `FRAME_BYTES`（frame の上限） | 3,129,112 B | `PARENT_BYTES` − 16,616。draft の推定（約 3,129,112 B）と一致 |
| worker の実行ファイル（release、seam なし） | 91,291,080 B | draft の Q 16 MiB の記録（91,414,840 B）と同程度 |
| 最大の counts の frame（50 Entity、512 edge、binding 2,050、短い文字列） | 1,020,638 B | `frame_of_the_largest_counts_fits_the_frame_limit`。frame の上限の 33% |
| frame の上限ちょうど | encode と validate が通り、+1 B は `NIR1_GRAPH_FRAME_LIMIT` | `frame_of_exactly_frame_bytes_is_admitted_and_one_more_byte_is_refused` |
| 製品形の A2 2,097,152 B（decision 形、envelope 形） | 実 worker で available | 既存の `native_worker_uses_a_candidate_*`（変更なし）。B1 |
| 2,097,153 B（decision 形、envelope 形） | 実 worker で READY の後に全体 unavailable | 既存の `native_worker_refuses_the_whole_graph_*`（変更なし）。B9 |
| payload 形 counted 600,000 B（A2 2,034,274 B） | 実 worker で available（seed が payload 形の Revision 自身） | `native_worker_uses_a_payload_shaped_revision_near_the_preflight_limit`。B2。R2-5 の 2,034,294 B と同じ形（差 20 B。原因は未確認） |
| payload 形 2 件追加（各 A2 約 2.03 MB） | 実 worker で READY | `native_worker_registers_multiple_payload_shaped_revisions`。B4。READY の後の query は 100 ms の lease（`NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`）で typed に拒否された。候補は seed と内容が違い（endpoint version conflict）、時間も pass／fail にしない。registration の検証が目的 |
| 製品形 4 件×A2 948,772 B、2 件×A2 2,094,880 B（同じ Entity 12 件）、30 場面（Entity が場面ごとに違う） | 実 worker で READY。seed v00（12 node、11 edge）と x1（2 node、1 edge）に答えた | `native_worker_registers_multiple_product_shaped_revisions`。B3。台帳 §7.2 の未解決（`pm-300000` の断片化）はこの形では再現しなかった |
| 超過 Revision（decision 形 2,097,153 B 相当、payload 形 counted 1,000,000 B） | 実 worker が READY にならず、専用 marker で exit 1。NOMEM の marker なし | B7 の 2 試験 |

### 大 cast と 2000 字の peak と frame（B5。pass／fail は typed 拒否か available のどちらか）

`query_large_cast_with_2000_char_summaries_stays_within_peak_and_frame`（in-process の worker の reader、lease 10 s、50 場面、場面ごとに review）。

| cast | seed | 結果 |
|---|---|---|
| 8+40、2000 字 | m1、m2、c01 | 全体 unavailable（`query-worker-work-other-pre-cleanup-work-failed-other`。peak の台帳 6,291,456 B の拒否。部分 Graph なし） |
| 8+40、2000 字 | m5 | available（7 node、7 edge、binding 30、frame 157,384 B） |
| 12+80、2000 字 | m1、m2、c01 | 全体 unavailable（同上） |
| 12+80、2000 字 | m5 | available（6 node、6 edge、binding 28、frame 136,490 B） |

長い summary では、draft の予告どおり peak の台帳が先に当たる（records や Entity の上限より先）。台帳の値は変えていない。frame の上限は、この組合せでは到達しなかった（available の frame は上限の 5% 以下）。

### frame の上限の N（B6）は単体で取った。実 worker での最悪の frame には届かなかった

TASK の B6 は、records 2,048 の最悪に近い frame を実 worker で取り、到達できなければ `FRAME_BYTES` の N を直接 encode する単体で補い、実 worker での未到達を書くと定める。実 worker で取れた最大の frame は B5 の 157,384 B（上限の 5%）で、1 query が読む行は peak の台帳（6,291,456 B）が先に止めるため、records 2,048 の frame（draft の推定で約 3.14 MB）には届かなかった。frame の上限ちょうどの正例と +1 の拒否は、`frame_of_exactly_frame_bytes_is_admitted_and_one_more_byte_is_refused`（encode と validate）で取った。実 worker が上限を 1 超える長さを宣言したときの終了（SIGABRT ではなく、frame 超過として終わり Graph は unavailable）は、既存の `native_worker_rejects_request_and_frame_length_n_plus_one`（seam の worker）が `FRAME_BYTES` に追従して確かめる（下の「実行した検証」に結果）。

### B8 の対（達しない seed は available）は fail-safe で置き換えた

TASK の B8 は、設計が fail-safe に倒れた場合に「READY にならない」の試験に置き換えると定める。`native_worker_refuses_a_seed_that_reaches_an_unloaded_revision` と `native_worker_answers_a_seed_that_does_not_reach_an_unloaded_revision` は作らず、次で置き換えた: `registration_refuses_an_approved_revision_one_byte_over_the_a2_registration_limit`（in-process。ordinary reader と worker の reader の両方、B は変わらず publish と complete registration が通る）、`registration_refuses_a_payload_shaped_revision_over_the_a2_registration_limit`、`native_worker_registration_does_not_load_a_revision_over_the_preflight_limit`（実 worker）。registration は project 全体なので、どの seed でも READY にならない。

### 期待値を変えた既存試験（DR-CQL-8 への追記。CQ-LIM-2 の分）

| 試験 | 変更 |
|---|---|
| `tests.rs`: `b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses`（G-1。counted 2.6 MB、B が publish、A2 が preflight 超） | 末尾を「worker の reader で query が拒否される」から「worker の registration が専用の型付きエラー（上限 2,097,152 B）で終わる」に改めた。B の publish と A2 の preflight の拒否の assert は変更なし。契約の文言（台帳 §7.1 の 1-B、1-D と G-1）は CQ-LIM-3 で改める |
| `c_query_fixed_allocator.rs`: `q_s_origins_no_fallback_failed_realloc_and_zero_live_seal` | `QUERY_BYTES` の assert を 16,777,216 に。ほかの assert は定数から導出されるので変更なし |
| `c_query_worker.rs`: `failure_classification_covers_every_owner_marker` | 新しい marker の許可リストと分類、forged（余分な文字つき）の marker は許可リストを通らず `WorkerStartup` になることを足した |
| `nir1_graph_product_tests.rs`: `failure_mapping_matches_the_dsn_table` | 新しい marker が `StartupRegistrationRefused` に分類され、`registration-unavailable` で backoff に数えられること、理由の集合が 14 のままであることを足した |

変更なしで通ることを確かめたもの: `oversized_approved_revision_refuses_the_readers_registration`（B-GUARD。6 MiB 超の承認済み Revision の registration の拒否。component guard を先にしたため）、`oversized_drafts_and_rejections_do_not_stop_the_build`、`nir1_graph_index_maintenance` と `nir1_entity_relation_index` と `nir1_capacity` の lib 試験（`narrative_extraction::nir1_` の 366 本、失敗 0）、既存の実 worker の per-Revision preflight の 4 試験（B1、B9）。

新しく足した試験: `registration_admits_an_approved_revision_at_exactly_the_a2_registration_limit`、`registration_refuses_an_approved_revision_one_byte_over_the_a2_registration_limit`、`registration_skips_a_revision_that_is_not_approved_whatever_its_size`、`worker_query_admits_a_payload_shaped_revision_near_the_preflight_limit`、`registration_refuses_a_payload_shaped_revision_over_the_a2_registration_limit`、`worker_registers_projects_of_several_product_shaped_revisions`、`query_large_cast_with_2000_char_summaries_stays_within_peak_and_frame`、`frame_of_exactly_frame_bytes_is_admitted_and_one_more_byte_is_refused`、`frame_of_the_largest_counts_fits_the_frame_limit`、実 worker（`#[ignore]`。lifecycle lane に配線）の `native_worker_registration_does_not_load_a_revision_over_the_preflight_limit`、`native_worker_registration_refuses_a_payload_shaped_revision_before_it_runs_out_of_memory`、`native_worker_uses_a_payload_shaped_revision_near_the_preflight_limit`、`native_worker_registers_multiple_payload_shaped_revisions`、`cq_avail::native_worker_registers_multiple_product_shaped_revisions`。

### 試験の道具の変更

- `NovelShape`（cast と summary の長さ）を `cq_avail.rs` に足し、`novel_fixture` は既定の形（5+15、短い summary）の薄い wrapper にした。既存の試験の fixture は変わらない（`scene_cast`／`novel_relations` は既定の形で従来と同じ値）。
- `Fixture::build_shaped` は payload 形の seed Revision（R2-5）を作る。`with_real_worker` は実 worker の owner の準備と cleanup の証明を共通にした。
- `scripts/nir1-c-query-worker-ci.sh`（hash 束縛）の lifecycle lane に 5 試験を配線し、`scripts/local-ci-full-workload-allocation.json` の sha256 を更新した。`scripts/ci-pause.test.mjs` に、各名前が一度だけ実行され、定義が `#[ignore]` の試験であることの確認を足した。

### 実行した検証（CQ-LIM-2。2026-10-17、Linux、この機）

- `cargo test -p grimodex-db --lib narrative_extraction::nir1_`: 366 passed、0 failed、48 ignored（B の `nir1_graph_index_maintenance`、`nir1_entity_relation_index`、`nir1_capacity` を含む。B の既存試験は変更なしで通る）。
- 実 worker（release、seam なし、`NIR1_C_QUERY_WORKER_BIN`）の `#[ignore]` 試験 9 本: per-Revision preflight の 4 試験（B1、B9。変更なし）と、新しい 5 試験（B2、B3、B4、B7×2）がすべて通った。1 case 1 process（`--exact --test-threads=1`）。
- 実 worker（seam あり、Q2 fixture）: `native_worker_reports_canonical_registration_refusal_before_ready`、`native_worker_returns_fixed_q2_frame_from_real_workspace_owner`、`native_worker_projects_owned_dto_after_lease_drop`、`native_worker_rejects_request_and_frame_length_n_plus_one`（frame 長 3,129,113＝上限＋1 を宣言し、Native は `FRAME_LIMIT` で body を読まずに拒否）、`native_worker_refuses_after_actual_sql_steps_over_cap`、`native_worker_refuses_after_real_child_sqlite_nomem`（exit 26、Q 16 MiB の構成の SQLite の NOMEM が signal でなく exit で終わる）が通った。`native_worker_retires_after_real_child_rust_oom` は `prlimit --core=1:1`（スクリプトの lifecycle lane と同じ前提）で通った。この前提なしでは、host の core dump が SIGABRT の終了を cleanup の deadline の後ろへ遅らせ、SIGKILL で終わる（スクリプトのコメントにある既知の環境依存。Q を 16 MiB にした worker で core dump が重くなる影響があるかは未確認）。
- `cargo test -p grimodex-db --bin nir1-c-query-worker`（allocator の 2 試験）: passed。`cargo test --manifest-path electron/native/grimodex-node/Cargo.toml nir1_graph_product`: 65 passed。
- `cargo clippy -p grimodex-core -p grimodex-db --all-targets -- -D warnings`: warning なし。`cargo fmt --manifest-path src-tauri/Cargo.toml --check`: 差分なし。
- `node --test scripts/ci-pause.test.mjs scripts/local-ci.test.mjs`: 128 本のうち 126 passed。失敗 2 本は、node_modules を root checkout への symlink で用意した環境の都合（`git hash-object -- node_modules` と pnpm パッケージの確認。この変更とは無関係）。`node --test scripts/quality/quality-workflow.test.mjs scripts/quality/impact-map.test.mjs`: 57 passed。
- 未実行（成功扱いにしない）: `scripts/nir1-c-query-worker-ci.sh lifecycle` を通しで実行していない（上の個別実行で、同じ名前・同じ fixture の手順を再現した）。Windows と macOS の worker は測っていない。Q 16 MiB で registration が NOMEM になる形の探索（draft の推定 A2 約 2.7〜2.9 MB）は、registration の検査で到達しなくなったため行っていない。再測（X1-3 の merge 後。lane の外）は integrator が行う。

## レビュー指摘の修正（CQ-LIM-2。DR-CQL-11）

- P2: 50 場面・場面ごと review の主人公級の available を固定する通常の試験を足した。`cq_avail.rs` の `query_fifty_scene_protagonists_are_available_on_the_default_cast`（5+15）、`..._on_the_8_plus_40_cast`、`..._on_the_12_plus_80_cast`。`novel_fixture_shaped(50, 5, ReviewMode::Scene, summary_chars 0)` で、worker の reader（lease 10 s）が m1〜m5 と c01 の全 seed を `available`（node 1 件以上）で返すことを assert する。3 cast を別の試験にしたのは、並列に走らせて 1 本あたりの時間を短くするため（3 本で 33.5 s、compile を除く）。2000 字の組合せは peak の台帳が先に拒否してよいので、`query_large_cast_with_2000_char_summaries_stays_within_peak_and_frame` の緩い assert のまま別に残す。以後 A2／A3 の費用増や保持見積りの変更で主人公級が unavailable に戻ると、この 3 本が落ちる。
- P3（safety）: query-wide の上限を 512 から 2,048 に分けたとき、A2 の `preflight_revision` の行の上限も 2,048 になり、1 件の Revision の行数（entity＋relation＋evidence）が 512 を超えても preflight を通っていた。master では `MAX_GRAPH_RECORDS`（512）が Revision と query の両方を押さえていた。Revision ごとの 512 を `preflight_revision_inner` の中で `remaining_rows.min(MAX_GRAPH_RECORDS)` として戻した（A3 の `admit_rows` は query の残りのまま）。到達できる経路は無かった（writer と bundle の検査と B の roster が先に止める）ので、多層防御の回復で、確認済みの値の変更ではない。N／N+1 の試験 `one_revision_is_held_to_the_revision_record_limit_inside_a_larger_query_budget` を足した（512 行は行の検査を通り、513 行は `NIR1_GRAPH_REVISION_RECORD_LIMIT`）。
- P3（safety）: `native_worker_registers_multiple_payload_shaped_revisions` は query の失敗を握りつぶしていた。READY の後の query の `Err` を `classify_c_query_failure` に通し、`Deadline` か `Unavailable(_)`（閉じた集合）以外なら失敗にした。test の目的は registration の成立と、query が typed に終わること（signal でない）。
- P3（spec、表記）: `worker_frame.rs` の新しい 3 試験の字下げを `mod tests` に揃え、変更した file を `rustfmt --edition 2021` で整えた。`cargo fmt --manifest-path src-tauri/Cargo.toml --check` は root package だけを見るため、変更 file の整形は `rustfmt --check` で確かめる。master で既に差分のある `c_query_worker.rs` の既存部分と `cq_avail.rs` の 1 か所、`nir1_graph_product_tests.rs` は触らなかった（この変更と無関係な整形を混ぜない）。
- P3（spec）実 worker の Entity 50・pages 128 の最大 N（CQ-LIM-1 の引継ぎ）は、**この commit でも試験にしていない**。in-process（システム allocator）で Entity 50、edge 512、pages 128 の N と N+1 を取っているため、Q 16 MiB の固定 arena での node ごとの `Vec::with_capacity(2,048)`×2×50（約 1.6 MB）と frame の encode は、通常の試験では未検証。reviewer が複製した作業木で release の worker（seam なし）に probe を流した結果は次のとおりで、実害は無かった: entities50 と pages128 は (50 node, 49 edge) で answered、entities51 は node-limit、pages129 は candidate-record-limit でともに typed 拒否、いずれも signal 終了なし。edges512／513 は production の lease 100 ms で `NO_TIMELY_FRAME`（時間依存で pass／fail にしない）。lifecycle lane の試験にする場合は `scripts/nir1-c-query-worker-ci.sh`（hash 束縛）の配線が要るので、この修正では足さず、integrator の再測（X1-3 の後）で実 worker の N を取る。
- 試験の追加を除き、registration の方式、marker、matrix、値は変えていない。
- 検証（2026-10-18）: `cargo test -p grimodex-db --lib narrative_extraction::nir1_` 370 passed、0 failed、48 ignored。新しい 50 場面の 3 試験と A2 の 512／513 の試験が通る。実 worker（release、seam なし）の `native_worker_registers_multiple_payload_shaped_revisions`（query は `NO_TIMELY_FRAME`＝Deadline で typed）と `native_worker_registration_does_not_load_a_revision_over_the_preflight_limit` が通る。clippy（core、db、`--all-targets -D warnings`）は warning なし。`rustfmt --check` は変更 file の本変更の hunk で差分なし（残るのは master 既存の `c_query_worker.rs` と `cq_avail.rs` 1 か所）。

## PR 本文と integrator の報告に書くこと（レビューの P3 の記録）

1. P7 案 4 の効果（達しない seed は available）は**未達**で、draft が確認済みの fail-safe（READY にしない typed refusal。exit 1）を採った。これは draft の受入れの正例「A2 超の Revision がある project でも READY、達しない seed は available」を満たさない。PUB-G が「推奨の組が実装済み」と読まないようにする。
2. 案 3 より狭い帯域がある。A2 の admission bytes が 2,097,152 B を超える（例: 2.4 MB。案 3 なら Q 16 MiB に載る payload 形の約 2.7〜2.9 MB までを含む）Revision は、契約の線で止まる。圧縮率は案 3 の確認時の説明と異なる。
3. A2 超の承認済み Revision が 1 件あると、その project の Graph は全 seed で registration-unavailable になる（その Revision に達しない seed も）。
4. 効果を得るには、registration の増幅（SQLite の JSON の中間 buffer）の削減か Revision ごとの印の保存（schema）が要る。proposal/8 の判断。コードの変更は不要。
5. 再測（integrator）は、実 worker で Entity 50・pages 128 の最大 N を取り、RB-1 と 1.5 倍の余裕の判断に上の 1〜4 を併せて見る。

## owner/lifecycle matrix（CQ-LIM-2。DR-CQL-4、10。DSN §1.3.1 と同じ表）

GDX-PRECHECK-001 の全項目を、DSN §1.3 の形式で書く。この matrix は registration の検査の mutation の前に書いた（`QUERY_BYTES`／`PARENT_BYTES` の 2 定数の値の変更だけは、記録の前に入れた）。(a) は新しい終端（READY の前の registration の typed refusal）、(b) は既存の終端（NOMEM の exit 1）を Q 16 MiB の構成で明記したもの。変更の無い項目は「なし」と書く。cp2a／cres の decisions は履歴なので書き換えない。

| 区分 | (a) READY の前の registration の typed refusal | (b) NOMEM の exit 1（Q 16 MiB の構成） | 根拠 |
|---|---|---|---|
| entry | 既存の worker の startup（`prepare` が worker を spawn する経路）の中。承認済み Revision の A2 admission bytes が 2,097,152 B を超えたときだけ入る。新しい entry（IPC、N-API、spawn の経路）はない | 既存の startup の registration の中。SQLite の確保が Q（16 MiB）で失敗したとき。新しい entry はない | `nir1-c-query-worker.rs` の `run`、`nir1_entity_relation_index.rs` の `read_revision_input_stats` |
| start | なし（新しい thread も process も作らない。worker の spawn は既存の owner thread が行う） | なし | DSN §1.3 の start |
| retry | 自動の再試行なし。親は `registration-unavailable` を「数える」失敗（`PrepareFailureEffect::Count`）として backoff（2 s から 60 s、連続失敗で指数）に載せる。同じ保存データなら同じ結果になる（決定的）。保存データが変わるまで成功しない | 同じ。親は `worker-unavailable` として数える | `nir1_graph_product.rs` の `prepare_failure` |
| reentrant | なし（slot は process に 1 つ。DSN §1.3 の reentrant のまま） | なし | DSN §1.3 |
| admission closure | なし（binding の確認、epoch、transition の拒否は既存のまま） | なし | DSN §1.3 |
| pending start | なし。refusal は registration の途中で起き、READY の `R` を書く前に worker が終わる。親の `wait_until_ready` は 30 s、1 ms ごとの binding 確認の中で exit を見て即座に返る（待たない） | なし | `c_query_worker.rs` の `wait_until_ready` |
| active handle | なし。refusal の時点で worker が持つものは、既存の startup と同じ（reader、borrowed connection、shared lease、participant）。`run` が `Err` で戻ると drop され、process が終わる | なし | 同上 |
| cancellation | 既存のまま（registration の maintenance owner の `check`、SQLite の progress callback、1,000 steps ごと）。refusal の前後で取消の観測の頻度は変わらない | 既存のまま | `nir1_graph.rs` の `register_with_worker_maintenance_observed` |
| bounded wait | 新しい待機なし。長さの SQL は Revision あたり 1 回で、既存の `read_revision_input_stats` の最初の SQL の結果を使う（追加の SQL なし）。refusal は JSON の式より前に起きるので、Revision あたりの registration の時間を増やさず、むしろ打ち切る | なし | — |
| 終了の証拠 | worker が exit 1 で終わる（signal ではない）。親は stderr の allowlist の marker（256 B まで）と、child の exit、stdout の EOF、reader の join を既存の `stop_and_reap` で確かめる（DSN §1.3 の「終了の証拠」のまま）。終了を証明できなければ既存の quarantine | 同じ。marker は `NIR1_C_QUERY_REG_NOMEM:<STAGE>`（既存） | `startup_exit_error_from_bytes` |
| error／timeout／onClosed | marker は閉じた一覧（許可リスト）で、自由文字列を親に渡さない。marker は `NIR1_C_QUERY_STARTUP_REGISTRATION_REVISION_INPUT_LIMIT`（新規）。親は `classify_c_query_failure` で `StartupRegistrationRefused`（既存）に写し、Native では `registration-unavailable`（DSN §1.5 の既存の理由）になる。新しい理由は足さない。onClosed（renderer が閉じた）は DSN §1.3 のまま | marker は既存。`classify_c_query_failure` では `WorkerStartup`（`NIR1_GRAPH_WORKER_EXIT_BEFORE_READY`）になり、Native では `worker-unavailable`。Q が 16 MiB になっても、SQLite 側の確保の失敗（枯渇と断片化）は、allocator が null を返し、SQLite が `SQLITE_NOMEM` を返して、exit 1 の typed な終了になる（signal ではない）。Rust 側の Q の確保の失敗は従来どおり abort（SIGABRT）で、親が退役させる（`native_worker_retires_after_real_child_rust_oom`）。この subtask では変えない | `classify_c_query_failure` |
| restart の状態 | 永続化するものはない（process-local）。再起動の後、同じ保存データなら同じ refusal になる。保存の印を作らない（schema は変えない） | 永続化するものはない | DSN §1.3 の restart |

## 期待値を変えた既存試験（DR-CQL-8 への追記。CQ-LIM-3 の分）

writer が保存する payload と envelope を各 6,291,456 B で検査する（RB-1。DR-CQL-5）ことで、counted の上限近傍や envelope が上限を超える形の Revision は保存できなくなった。次の試験の fixture か期待値を、その分だけ変えた。

| 試験 | 変更 |
|---|---|
| `nir1_entity_relation.rs`: `typed_writer_saves_512_records_at_exactly_6_291_456_input_bytes` | `typed_writer_saves_512_records` に改名。512 records の保存と A2 の読取だけを確かめる（padding なし）。counted がちょうど 6,291,456 B の Revision は、保存する payload が counted より大きい（JSON の field 名と記号の分）ため保存できない。この事実を `typed_writer_refuses_the_counted_limit_because_the_stored_payload_is_larger` で確かめる（`validate_entity_relation_bundle` は通り、writer は `NIR1_ENTITY_RELATION_STORED_PAYLOAD_LIMIT` で拒否し、全 table の行数が変わらない）。台帳 §7.1 の 1-B が認めた帰結で、counted の N の「保存できる」が成り立たなくなる |
| `nir1_entity_relation.rs`: `typed_writer_refuses_over_limit_revisions_without_partial_rows` | 変更なし（513 records と counted の 6,291,457 B は、保存形の検査より前の `validate_entity_relation_bundle` が拒否する） |
| `nir1_entity_relation.rs`: `graph_index_builds_around_oversized_drafts_and_rejections_until_one_is_approved` | 却下された Revision の envelope を上限超にする fixture を、counted 3 MiB の bundle（envelope が約 2 倍で上限超）から、通常の Revision の envelope に空白を足す形に変えた。writer は envelope が上限を超える Revision を保存しないので、以前の writer が保存した Revision を表す。envelope の immutability trigger は、その試験の db からだけ外す。判定（roster に入らない、build は続く）は変えていない |
| `nir1_graph_index_maintenance_tests.rs`: `add_revision_with_oversized_envelope` | 同上（同じ手順で envelope を伸ばす）。使わなくなった `bounded_writer_bundle`／`writer_input_bytes` の import を外した |
| `nir1_graph/tests.rs`: `b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses`（counted 2,621,440 B。envelope 約 5.4 MB） | 変更なし。保存形の検査の内側に収まる |
| `scripts/quality/quality-workflow.test.mjs`: 台帳の G-1／G-2 の行の状態の regex | proposal/6 の状態の文面は残し、末尾に proposal/7 の後の状態（CQ-LIM-3、CQ-LIM-2・3）を足した形に合わせた |

新しく足した試験（CQ-LIM-3）: `writer_rejects_a_stored_payload_over_6291456_bytes`、`writer_rejects_a_stored_envelope_over_6291456_bytes`、`writer_stores_a_payload_and_envelope_at_exactly_6291456_bytes`、`typed_writer_refuses_the_counted_limit_because_the_stored_payload_is_larger`（以上 `nir1_entity_relation.rs`）、`b_publishes_a_revision_whose_stored_envelope_is_exactly_the_writer_limit`（`nir1_graph/tests.rs`）、`the proposal/7 graph limits are recorded beside the proposal/6 history and match the code`、`the acceptance ledger and the HOLD table record the proposal/7 outcome without rewriting proposal/6`（`quality-workflow.test.mjs`）。

試験の作り方（RB-1）: 保存する payload だけを上限に合わせる形は、Entity の `label` を伸ばし、同じ長さに Codex の name を更新する（writer は label が live の name と一致することを要求する）。label は envelope に入らないので、payload と envelope を独立に動かせる。envelope を合わせる形は、参照されない Evidence の識別子を伸ばす（envelope に 2 回入る。evidenceRef と dependency の識別子）。2 バイトずつ動くので、奇偶は run の識別子の長さ（envelope に 1 回、payload に 0 回）で合わせる（`envelope_bundle_of`）。envelope の長さは writer と同じ関数で組み立てて数える（`stored_envelope_len`）。

## CQ-LIM-3 の結果（RB-1 の writer の検査と台帳・試験の同期。DR-CQL-5、6）

- 検査の位置: `create_in_tx` の中で、payload_json の構築の直後（envelope の構築と material の読取より前）と、envelope_json の構築の直後。どちらも最初の INSERT より前なので、DB への書込みは無い。`with_immediate_transaction` の中で拒否されるので、接続は呼出しの前後で autocommit のまま（試験で確かめた）。
- 拒否の理由: `NIR1_ENTITY_RELATION_STORED_PAYLOAD_LIMIT`、`NIR1_ENTITY_RELATION_STORED_ENVELOPE_LIMIT`。メッセージは「どの列が何バイトで、上限が 6,291,456 B」。IPC・N-API の理由の写像は足していない（既存の writer の他の拒否と同じく、文字列の code を持つ anyhow のエラー）。
- 上限の値を足していない: 6,291,456 B は既存の `MAX_GRAPH_INPUT_BYTES`（B の成分 guard と同じ定数）。
- G-1 の判定: 充足（台帳 §7.1 の「proposal/7 の後」）。保存する payload が上限ちょうどの形の B の publish は試験していない（B の成分 guard は変えていない。writer の保存と A2 の読取までを試験した）。
- G-2 の判定: [precheck] を解除（台帳 §7.2 の「proposal/7 の後」）。根拠は CQ-LIM-2 の実 worker の試験（decision 形・envelope 形のちょうど N、payload 形の約 2.03 MB、製品形の A2 2,094,880 B の registration の READY）が通ったこと（上の「CQ-LIM-2 の結果」）。製品形でちょうど 2,097,152 B の候補は作っていない（2,272 B 下まで）。registration の検査が fail-safe（P7 案 4 の効果は未達）であることは台帳にも明記した。実 worker の試験は、この subtask では再実行していない（同じ候補・環境・command の成功結果。この subtask の変更は writer の `create_in_tx` と試験だけで、worker の起動・registration・query の経路は変えていない）。
- HOLD の扱い: l6-l9 の残 HOLD 表の G-1／G-2 の行は、実装した事実を足し、HOLD の解除は CQ-LIM の PR の merge（再測の後）による、と書いた。proposal/6 の節の本文と表は書き換えていない（`quality-workflow.test.mjs` の proposal/6 の assert は変更なしで通る）。

### 実行した検証（CQ-LIM-3。2026-10-18、Linux、この機）

- `cargo test -p grimodex-db --lib narrative_extraction::`（ignored を除く）: 1006 件のうち 990 passed、16 failed。16 件は `repair::`（15）と `maintenance_lifecycle::creation_unknown_reopens_exact_committed_rollback_and_partial_tuples`（1）で、すべて SQLite の `disk I/O error`（code 778）。原因はこの機の `/tmp`（tmpfs）の容量制限で、この変更とは無関係。`TMPDIR` を `/home` の下に向けて再実行し、同じ 16 件を含む `repair::`、`maintenance_lifecycle::` と `b_publishes_a_revision*` の 77 件が通った。
- 新しい writer の試験と、変更した既存の writer の試験（`writer_*`、`typed_writer_*`）、`b_publishes_a_revision*`: 8 passed、0 failed（clippy の指摘を直した後に再実行）。
- `cargo clippy -p grimodex-core -p grimodex-db --all-targets -- -D warnings`: warning なし（`is_multiple_of` の指摘を 1 件直した）。`rustfmt --edition 2021 --check`: `nir1_entity_relation.rs` と `nir1_graph_index_maintenance_tests.rs` は差分なし。`nir1_graph/tests.rs` は master 既存の `cq_avail.rs` の 1 か所だけ（この変更と無関係）。
- `node --test scripts/quality/quality-workflow.test.mjs scripts/quality/impact-map.test.mjs scripts/quality/eval-fixtures.test.mjs`: 23 + 45 passed（quality-workflow は新しい 2 試験を含む 23 件）。
- 未実行（成功扱いにしない）: 実 worker の `#[ignore]` 試験（CQ-LIM-2 の結果を根拠にした）。`scripts/nir1-c-query-worker-ci.sh` と dataset／hash に束縛された file は触っていないので、`ci-pause`／`local-ci` の試験は実行していない。`Cargo.lock` は変えていない。
