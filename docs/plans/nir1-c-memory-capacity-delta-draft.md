# C-query 同時メモリ容量差分（draft / HOLD）

この文書は容量証明の未完了箇所と検討候補を記録する。既存の確認済み 2 MiB 契約、他の資源値、authority を変更・批准しない。Graph は HOLD とし、製品入口の activation を閉じたままにする。

## 未立証の範囲

[計画 §6.2](nir1-post-b-execution-plan.md#62-資源契約) の 2 MiB は固定済み契約値であり、測定済み結果ではない。同節は query 予算に候補 SQL、A2/A3、JSON、Evidence、path、serialization を含める。

[reader memory ledger](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/memory.rs#L3) は SQLite／serde 内部を測らず、全 live structure が充電されて初めて hard result になると明記する（3–6、36–38行）。[`nir1_graph.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph.rs#L830) の `transient_material_reserve`（8× raw bytes + 4 KiB/row、830–838行）は推定である。候補ページは lengths admission 後に文字列を materialize する（[`candidates.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/candidates.rs#L76) 76–129行、呼出元 `nir1_graph.rs` 903–913行）。これは oversized candidate string の一経路を閉じるもので、全 query の heap 上限証明ではない。

残る具体的な未計上・未証明経路：

- [`input.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/input.rs#L62) は raw length admission 後に `COUNT_SQL` 等の SQLite JSON1 を実行する（62–72、143–175行）。他の disclosure SQL も JSON1 を使う。SQLite JSON parse scratch の per-query aggregate cap は設定されていない。`nir1_graph.rs` 254–261行の `temp_store=MEMORY`、`cache_size=-128`、`mmap_size=0`、`busy_timeout=0` はその cap ではない。
- [`nir1_entity_relation.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation.rs#L1988) の A2 reader は owned payload text から typed payload を parse し、envelope を `serde_json::Value` として保持する（1988–2014行）。2028–2030行の `to_value(payload)` と `to_value(bundle)` は重複 tree を作る。canonical digest（[`canonical_json.rs`](../../src-tauri/crates/grimodex-core/src/canonical_json.rs#L185)、185–206行）は全体の canonical byte buffer と object/string serialization scratch を作る。これらの同時 live bytes は ledger の事前 admission ではない。
- [`nir1_graph.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph.rs#L859) 859–880行と921–925行など、HashMap／BTreeMap／BTreeSet の charge は構造体サイズや係数による見積りで、実際の bucket/node allocation と allocator overhead を示さない。allocator による requested bytes と RSS も別の量である。

従って、現在立証できるのは read/admission 予算や個々に事前 admission した container の論理的上限であり、「SQLite・serde を含む同時 query allocation が 2 MiB 以下」という hard bound ではない。

## 測定で言える範囲

既存 opt-in capacity binary（[`nir1-material-capacity.rs`](../../src-tauri/crates/grimodex-db/src/bin/nir1-material-capacity.rs#L18)）の global allocator は Rust allocator-requested live bytes／highwater を測る実装例だが、現状は C query を実行しない。C 専用 harness で query 前後の snapshot/reset を加える。既存 SQLite `TEMPBUF_SPILL`（[`nir1_capacity_diagnostics.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_diagnostics.rs#L658)）は spill telemetry であり、live JSON parser heap ではない。孤立した単一 query harness で、SQLite `SQLITE_STATUS_MEMORY_USED` highwater（MEMSTATUS が有効なことを確認）と Rust allocator highwater を同じ測定窓で採り、結果を別々に報告する。各 pool の peak の和は、その harness 内で観測した allocator-requested 増分について保守的な上界にできるが、allocator metadata、process RSS、未計測 allocation domain、全入力空間、production 同時実行を証明しない。fixture の成功や観測ピークだけで契約達成とはしない。

測定 fixture は最大 admission bytes／records、最大 disclosure と response、JSON1 malformed/large input、取消・deadline を SQL／JSON parse 各段階で発火させる。query 結果 deadline、cancel request から停止観測まで、rollback／reader cleanup 完了までの時間を分けて記録する。8 ms は期限後に結果を拒否する契約であって、scheduler、SQLite 単一 opcode、allocator、destructor、cleanup の wall-clock 最大値を保証しない。`busy_timeout=0` が示すのは SQLite busy wait の抑制であり、storage I/O や OS scheduling を含む「wait 0」ではない。

## 将来案と確認境界

1. **In-process enforcing allocator:** Rust と SQLite allocation を一つの予算へ接続し、超過を fallible な形で拒否する。Rust global allocator のみでは SQLite C allocation を捕捉しない。SQLite allocator hook は process 初期化時の global 設定であり、複数 workspace／他 connection／query 後まで生きる cache allocation の所有権・並行性を扱う必要がある。単一 query の観測用 instrumentation を hard admission と呼ばない。
2. **Isolated worker:** 専用 process 内で SQLite/Rust allocator を初期化し、2 MiB 制限と bounded IPC を適用する。process 起動・request/response buffer・snapshot binding・cancel/timeout・crash recovery・cleanup 完了・workspace lifecycle を含めて測る。これは接続と lifecycle の境界変更であり、既存 reader に対する無断の実装選択にしない。

どちらの案も着手前に、既存契約の差分として 2 MiB が包含するもの（reader/cache baseline、query transient、returned response lifetime、IPC、allocator metadata、並行 query）と、超過時の失敗／cleanup 条件を明示する。確認済み値そのものを黙って再定義しない。脅威モデルは draft のまま、少なくとも攻撃者と能力（Renderer 入力、改変・破損した保存 JSON、並行 workspace/SQLite 操作、取消反復）、境界（Native reader・SQLite allocator・worker IPC・lifecycle owner）、守る資産（他 DB 作業と workspace responsiveness、partial Graph を返さないこと）、DoS 経路、拒否・解放の受入れ基準を明記して明示確認を得る。確認までは実装方式・新しい allocator authority・process boundary を選ばない。

この draft ではコード、Gold、metrics、2 MiB 契約を変更しない。Graph activation は閉じたままにする。
