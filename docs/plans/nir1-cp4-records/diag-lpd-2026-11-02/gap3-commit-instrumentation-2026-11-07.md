# CP-4 隙間 3 の dev 計装：書き手ごとの commit の記録（LP-D 4）

dev 専用の枝 `claude/cp4-lp-diag` の記録（merge しない枝）。DR-CP4-LAPSE-2（X+ は採らず、
隙間 3 は dev 計装で確かめる）の実装。正式の測定に数えない（DR-CP4-LPD-1 (4)）。
設計草稿 改訂 3 の §9.6 と §11 が正本。

## 1. 段 1：origin/master の取り込み

`origin/master`（`2cb73eec`）を merge で取り込んだ。基点は `8dd7a9c0`。衝突は 5 件。

| file | 解き方 |
| --- | --- |
| `docs/plans/nir1-continuation-2026-10.md`、`docs/plans/nir1-lane-decisions/cq-deferred-decisions.md` | master 側を採用（docs。枝側の追記は master に取り込み済み） |
| `electron/native/grimodex-node/src/nir1_graph_gate_tests.rs`（add/add） | master 側を採用（`wait_until` で窓の終了を待つ版。枝は gate の branch の旧版） |
| `electron/native/grimodex-node/src/nir1_graph_product.rs` | `open_window` の周りの LP-D 3 計装（`cfg(feature = "nir1-graph-eval")`）を残し、製品の行は master と同じ |
| `electron/native/grimodex-node/src/related_scenes/graph.rs` | assemble の後の `lpd.at(...)` 計装（`cfg`）を残した |

取り込み後の試験（すべて通った）：

- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --features nir1-graph-eval --lib nir1_graph`：177 件 pass（5 件 ignored）。
- 同 `--lib nir1_graph_eval -- --test-threads=1`：17 件 pass。
- `cargo test -p grimodex-db --features nir1-graph-eval --lib nir1_lpd_diag`：3 件 pass。

`native-architecture.mjs` は実行していない（dev 枝では落ちてよい。結果は記録しない）。

## 2. 段 2：計装の設計

書き手の thread が、自分の区間（開始と COMMIT の後）を、leaf lock の ring に自分で push する。
新しい thread・timer・待ち・egress は無い。値は closed word と数だけ（識別子・本文・SQL・path・binding・
digest は型として入らない。書き手と操作は enum で、文字列を受け取らない）。

- ring：`grimodex_db::narrative_extraction::nir1_lpd_diag`（`nir1-graph-eval` の下だけ）の
  `CommitRing`（上限 `COMMIT_LOG_CAPACITY = 1024`、超えたら古い順に捨てて `dropped` を数える）。
  lock の中で他の lock を取らない。
- 区間：`CommitSpan::begin(writer, op, conn?)` と `finish(conn?, committed)`。`begin`／`finish` は
  書き手が既に持つ接続の `total_changes()` と `PRAGMA data_version` を複製するだけ（読取専用）。
  `finish` せずに drop した区間（早い return、panic、接続を読まない区間）は outcome `ended`（値なし）。
  読み取りだけの文・batch は `discard` で記録しない。
- 出力：dev 受領書 `nativeReads[].lpd` に `commits`（record の配列）と `commitsDropped` を足した。
  schema は `nir1-lpd-diag/3`。時刻は既存の eval clock（`tStartedNs`／`tEndedNs`）。
  record の key：`seq`、`writer`、`op`、`outcome`、`tStartedNs`、`tEndedNs`、`before`／`after`
  （`totalChanges`、`dataVersion`）、`totalChangesDelta`、`dataVersionDelta`。
- 書き手の接続の `data_version` は、その接続自身の commit では動かず、**別の接続（MCP・別 process・
  worker の接続）の commit で動く**。つまり `dataVersionDelta != 0` の区間は、その区間の間に他の書き手の
  commit があった印になる。
- 接続を読まない区間（`maintenance-cycle`、`dfinal`）は、値が null で時刻だけ。その cycle の中の
  commit は、他の書き手（`freshness-commit`、`audit-append`、`trusted-sql`）の記録に出る。

### 書き手 8 種×観測点（§9.6 の表との対応）

| §9.6 の書き手 | closed word（`writer`／`op`） | 観測点（file） | 区間の取り方 | 接続の値 |
| --- | --- | --- | --- | --- |
| 本文の保存（renderer の `db_execute`／`db_execute_batch`） | `body-save`／`execute`・`batch` | `grimodex-db/src/execute.rs` の `execute_impl`・`execute_batch_tx_impl`（renderer 起点。`lpd_writer`） | ロック取得の後から文／COMMIT の後まで。読み取りは記録しない | あり |
| Chronicle の build の publish | `chronicle-publish`／`publish` | `grimodex-db/src/narrative_extraction/nir1_chronicle_index/publish.rs`（`publish_chronicle_index_build_scoped` の transaction。node の `related_scenes/build.rs` はこの関数を呼ぶので同じ区間） | `BEGIN IMMEDIATE` から COMMIT の後 | あり |
| begin 自身の audit の commit | `audit-append`／`append` | `grimodex-db/src/ai_audit.rs` の `run_ai_audit_immediate_transaction`（audit の append と claim の共通の入口。COMMIT の後に finish） | `BEGIN IMMEDIATE` の前から COMMIT の後 | あり |
| maintenance の接続 | `maintenance-cycle`／`cycle` | `grimodex-node/src/lib.rs` の `run_narrative_maintenance_cycle` の worker（blocking）の入口 | worker の開始から終了（drop） | なし（時刻のみ） |
| MCP の別 process | なし（計装しない） | — | — | `PRAGMA data_version` の差分（registration の `identityDiff`、stampDiff、各 `commits` の `dataVersionDelta`）と既存 tracing の突き合わせ |
| D-final の経路 | `dfinal`／`graph-request` | `grimodex-node/src/nir1_graph_dfinal.rs` の `request_graph`（commit はしない。窓を開かず Freshness を止めない区間の長さを見る） | 要求の開始から return（drop） | なし（時刻のみ） |
| restore 後の Freshness | `freshness-commit`／`reserve`・`publish` | `grimodex-db/src/narrative_extraction/incremental_freshness.rs` の `run_serialized_cycle_with_control` の 2 つの transaction | `BEGIN IMMEDIATE` から COMMIT の後 | あり |
| 起動時の migration・backfill | `migration`／`migrate`・`restore-preflight` | `grimodex-db/src/migrate.rs` の `migrate_impl`（本体は `migrate_impl_inner`） | 呼び出しの前後（`lock_conn` を取り直して値を複製） | あり |
| （表に無い残り）同 process の trusted domain writer の SQL | `trusted-sql`／`execute`・`batch` | `execute.rs`（`TrustedDomainWriter`・`McpGeneric` 起点） | `body-save` と同じ | あり |

8 種の word は `body-save`、`maintenance-cycle`、`freshness-commit`、`chronicle-publish`、`audit-append`、
`dfinal`、`migration`、`trusted-sql`。表の「restore 後の Freshness」は、同じ Freshness の cycle の commit
（`freshness-commit`）で区別しない（restore の直後かどうかは時刻と lifecycle の log で見る）。MCP は
別 process なので word を持たない。`trusted-sql` は、表に無い trusted の書き手（他の domain writer）が
見えなくならないための残り。

### 突き合わせの手順（解析する人向け）

1. `commits` のうち `tStartedNs`〜`tEndedNs` が Graph の窓（`ticket.window`）や join の区間と重なるものを、
   `writer` ごとに数える。
2. 窓の中で registration／stampDiff の `dataVersionDelta` が動いたのに、重なる `commits` が無い（または
   `dataVersionDelta` の動きと合わない）ときは、別 process（MCP）か、計装の無い書き手を疑う。
3. 自然な trace で、Freshness 起因でない無効化の数を、`writer` 別の重なりで分ける（§9.6 の測り方 (3)）。

## 3. 試験

grimodex-db（`--features nir1-graph-eval --lib`）：

- ring の上限と dropped（1024、超過 5 件で oldest の seq が 5）。
- closed word（小文字の kebab だけ。書き手は 8 種で重複なし）。
- 区間の複製（`total_changes` の差 7、`data_version` が読める）、失敗は `failed`、drop は `ended`（値なし）、
  `discard` は記録なし。
- `Database` の入口：trusted の batch・単一文が `trusted-sql`、renderer の batch・単一文が `body-save`
  （変更行数の差で自分の記録を特定）。
- feature の隔離（feature なしでも走る）：db の 5 file の `nir1_lpd_diag` の呼び出しがすべて
  `cfg(feature = "nir1-graph-eval")` の近く（直前 8 行以内）にある。

grimodex-node（`--features nir1-graph-eval --lib`）：

- `logs_json` の `commits`：schema `nir1-lpd-diag/3`、record の key 集合が固定、`writer`／`op`／`outcome`
  が closed word、観測が数か null、`totalChangesDelta`・`dataVersionDelta`、ring が上限で止まり
  `commitsDropped` を数える。
- feature の隔離（feature なしでも走る）：`lib.rs`・`nir1_graph_dfinal.rs` の呼び出しが同じく `cfg` の近く。

## 4. feature の隔離の確認

- `nir1-graph-eval` は `default` に無い（`grimodex-db/Cargo.toml`、`grimodex-node/Cargo.toml`）。
- `cargo check --lib`（feature なし）を grimodex-db と grimodex-node で通した。
- feature なしの `cargo build -p grimodex-db --lib` の成果物（features=`default` だけ）に、`body-save`・
  `chronicle-publish`・`audit-append`・`freshness-commit`・`nir1-lpd-diag`・`NIR1_LPD_REG` の文字列が
  1 つも無い（0 件）。対照として feature あり（`nir1-graph-eval`）の rlib には `body-save` がある。
- 上の 2 つの隔離の試験が feature なしで通る。
- ring・enum・`CommitSpan` は `nir1_lpd_diag`（`#[cfg(feature = "nir1-graph-eval")] pub mod`）の中にあり、
  feature なしでは存在しない。呼び出しは各所で `cfg` を付けた statement で、feature なしでは製品の行が
  従来と同じ（`migrate_impl` は `migrate_impl_inner` を呼ぶだけの別名になる）。

## 5. 変えていないもの・できなかったこと

- 変えていない：契約、閾値、Gold、読み、harness の pin、S2/S4、hook の literal（`FETCH_DEBOUNCE_MS=400`）、
  DR-CQD-GATE §9.3、renderer／Main TS／IPC／preload／N-API の export。egress なし、新 background なし。
- 影響：dev の build では、renderer 起点の SQL（読み取りを含む）ごとにロックの中で `PRAGMA data_version` を
  1 回読む（数十 µs のオーダー。推測）。dev の診断の run でだけ。正式の測定の build には入らない。
- できなかったこと：窓の中で書き手を 1 種類ずつ動かす**注入の表**（§9.6 の (2)）と、実 run での頻度の測定は
  この計装の範囲に含めていない（計装だけ。run は別）。MCP の書き手は計装していない。

## 6. 最終の試験結果

- grimodex-db（`--features nir1-graph-eval --lib lpd`）：18 件 pass（1 件 ignored）。新規 6 件
  （`nir1_lpd_diag` の 5 件と `execute` の 2 件のうち、feature の隔離の 1 件は feature なしでも pass）。
- grimodex-node（`--features nir1-graph-eval --lib lpd_`）：13 件 pass（新規 2 件）。
- grimodex-node `--lib nir1_graph_eval -- --test-threads=1`：17 件 pass。
- feature なし：`lpd_commit_instrumentation_*` の 2 件（db・node）pass。
