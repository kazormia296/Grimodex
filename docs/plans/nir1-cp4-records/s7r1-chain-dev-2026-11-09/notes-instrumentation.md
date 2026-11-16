# s7r1 連鎖の dev 計装（4 項目）の記録

- worktree: `/home/grimodex/worktrees/Grimodex/claude-s7r1-chain-instr`（origin/master `862b3aa7`）。変更は未 commit。
- patch: `instrumentation.patch`（`git diff` ＋ 新規 `dev_trace.rs` を `git diff --no-index` で追記。index は触っていない）。適用は `git apply`。
- **dev 専用。merge しない。** build（標準・評価）は走らせていない。

## 1. 仕組み（共通）

- 新規 `src-tauri/crates/grimodex-db/src/dev_trace.rs`（`pub mod dev_trace;` は `lib.rs`）。
- env `GDX_DEV_TRACE_DIR` が無ければ全関数が何もしない。ある場合は `<dir>/trace-<pid>.jsonl` へ 1 行 1 write（O_APPEND、fsync なし）。
- 全行の共通 field: `kind`、`pid`、`t_ms`（その process が最初に trace を使ってからの単調 ms）、`wall`（UTC ISO、ms）。
- main process と worker process は pid が別なので file も別。worker の pid は `reg_*` の行の file 名で分かる。
- worker は `env_clear()` されるので、`c_query_worker.rs` の `configure_worker_process` で `GDX_DEV_TRACE_DIR` だけ転送した（env が無ければ従来どおり）。これは製品 file の plain code で eval の cfg ではない。
- `agg` 行：1 秒ごと（main process 内の thread `gdx-dev-trace`。最初の waiter／preempt／cycle で起動）。**累積値**なので、区間は差を取る。

## 2. 項目ごと

### 項目 1：registration の段と refused の内訳（worker process）

- file／行（patch 適用後）:
  - `nir1_graph.rs`：`set_registration_stage`（約 243〜）が段ごとに `reg_stage`。`register_with_control_observed` の各 refused 点に `reg_refused`。
  - `bin/nir1-c-query-worker.rs`：`run()` の先頭で `dev_trace::init()`。
- 行の種類と field:
  - `reg_stage`：`stage` ∈ Setup／PreflightIdentity／OwnerSetup／BeginSnapshot／PinnedIdentity／SemanticIndex／SourceIndex／Seal／PostflightIdentity。段の所要は隣り合う行の `t_ms` の差。
  - `reg_refused`：`reason` ∈
    - `preflight-drift-err`（preflight の unpinned 読みが None。Err になる）
    - `pinned-drift-err`（BEGIN 後の読みが before と違う。Err。`before`／`pinned` に ReadIdentity の Debug 文字列）
    - `nonpositive-rowid`
    - `semantic-index-incomplete`
    - `source-index-incomplete`
    - `seal-none`
    - `postflight-drift`（`Ok(false)` ＝ registration-unavailable。`before`／`current` に Debug 文字列。どの field が動いたかはこの 2 つの比較で読む）
  - `reg_err`：closure が Err で終わった。`error` に chain（400 文字まで）。input-limit（`NIR1_GRAPH_REGISTRATION_REVISION_INPUT_LIMIT`）や SQLite error はここに出る。
  - `reg_postflight_ok`：postflight 通過（`sealPresent`）。
- 読み方：1 回の registration は `reg_stage Setup` で始まり、`reg_refused`／`reg_err`／`reg_postflight_ok` のいずれかで終わる。postflight-drift なら、その直前の `reg_stage` の `t_ms` の差が窓の長さ（BEGIN〜postflight）。
- 追加の注意：worker は固定 allocator と「scratch が live で残らない」seal を持つ。trace の永続 state（file handle）は `init()` で scratch scope の前に作る。`emit` は一時的な alloc だけ（stage の emit は scratch scope の外）。

### 項目 2：commit gate の counters（eval module）

- `electron/native/grimodex-node/src/nir1_graph_eval/mod.rs` の `diagnostics_json` に `"gate"` object を追加。
- field：`deferred`、`waitedAdmit`、`overridden`、`stopped`、`leaseExpired`、`windowsOpened`、`graphWaited`、`graphWaitExpired`（`GateCounters` の全 field）。
- eval の cfg を足していない（既存の eval module の既存関数の JSON に field を足しただけ）。`#[napi]` の追加なし。

### 項目 3：foreground の waiter の出所と preempt

- `lib.rs`（db）：`ForegroundConnectionWaiter` に `trace_id` を持たせ、`new` で `dev_trace::waiter_enter()`、`Drop` で `waiter_exit`。`new` の signature は不変。製品の唯一の foreground 経路（`lock_conn_with_check`）の waiter はこれで全部拾う（ほかの `new` は試験だけ）。
- label の決め方：thread-local の `dev_trace::label("…")`（明示）を優先。無ければ `caller:<file>:<line>`（`#[track_caller]` で得た、外側の最初の非 track_caller の呼出し位置）。release は `strip = "symbols"` なので backtrace は使わない（入れていない）。
  - 明示 label を付けた箇所：
    - `related_scenes.rs` の `reconcile` → `related-scenes-reconcile`
    - `related_scenes.rs` の `continue_query` の blocking closure → `related-scenes-continue/current-operation`
    - `related_scenes/build.rs` の build の blocking closure → `related-scenes-build`（begin の scoring と reconcile の schedule の build の両方）
    - native `lib.rs` の `run_narrative_freshness_cycle_body` → `freshness-cycle-body`、`_inner` → `freshness-cycle-inner`
  - `#[track_caller]` を付けた関数：db `lib.rs` の `ForegroundConnectionWaiter::new`、`lock_conn`、`lock_conn_with_check`、`with_conn`、`with_read_transaction`。`narrative_maintenance_connection.rs` の `with_participant_sql_scope`／`_read_transaction`／`_read_transaction_control`／`_bounded`／`_bounded_in`／`_sql_scope_config`／`_sql_scope_fenced`。ほかの経路（`lock_conn` を直接呼ぶ fts／execute／migrate など）は、その呼出し行が label になる。
  - 【推測】`with_conn` の呼出し側（約 2,600 箇所）の位置が label になるので、renderer 由来の DB 操作は caller の file:line で区別できる。ただし中間の関数が `#[track_caller]` でなければ、そこで止まる。
- preempt の記録点（`note_preempt(kind)`）：
  - `no-wait/waiter-owns-handoff`、`no-wait/connection-busy`、`no-wait/waiter-arrived`（db `lib.rs` の `lock_conn_with_check`）
  - `participant-check/foreground-waiting`（`narrative_maintenance_connection.rs` の check）
  - `sql-progress-hook/foreground-waiting`（同 progress hook）
  - `graph-finalization-reservation`、`graph-build-judgement-no-wait`（`nir1_graph_index_maintenance.rs`）
  - `maintenance_runtime.rs` の discovery／recovery 系の PREEMPTED 文言（2196、2266、5048 など）と、SQL progress callback（`narrative_maintenance_connection.rs` の `progress_callback`。reason が分からず hot）は**入れていない**。
- `agg` の field：
  - `waiterLabels`：label → `arrivals`、`waitMsTotal`、`waitMsMax`（waiter が立ってから接続を取るまで）
  - `activeWaiters`
  - `preemptsTotal`、`preemptKind`（kind → 回数）
  - `preemptBy`（`<kind>|<そのとき立っていた waiter の label>` → 回数）
  - `preemptLastAcquirer`（waiter が 0 のとき〔= mutex が使用中の busy〕、`<kind>|<直前に接続を取った foreground の label>`）
- 読み方：`preemptBy` の label が preempt を起こした foreground。busy は「mutex を持っている側」を直接は分からず、直前の取得者から推測するだけ（推測）。

### 項目 4：維持の 1 cycle あたりの commit 数

- 選んだ方法：db の `background_checkpoint.rs` の `wal_hook`（WAL に書いた commit ごとに SQLite が呼ぶ。既存）の先頭で atomic を 1 加算（`dev_trace::note_commit`）。native の `run_narrative_maintenance_cycle` の先頭に RAII の `CycleGuard::begin()` を置き、drop（どの return でも）で cycle 前後の差を集計。
- 理由：`total_changes` は commit ではなく行の変更数で、1 commit が複数行を変える。別接続の `data_version` watcher は 100 ms 内の複数 commit を 1 に潰す。`wal_hook` なら commit ごとに数えられ、atomic 1 回で hot path に重い処理がない。commit_hook は既存の他用途と衝突しうるので避けた。
- `cycle` 行：cycle ごとに 1 行（`ms`、`commits`、`preempted`、`startedWallApprox`、共通の `wall`＝終了時刻）。cycle の外（DB の lock の外）で書く。1 秒あたり最大 100 行程度。
- `agg` の field：`commits`（累積）、`cycles`、`cyclesWithPreempt`（cycle の間に preempt が 1 件以上）、`cycleCommitSum`、`cycleCommitMax`、`cycleCommitHist`（9 要素。添字 0〜7 は commit 数、8 は 8 以上）、`cycleMsMax`。
- 限界（事実）：cycle の間に foreground の commit が入れば同じ counter に数えられる。cycle が重なれば混ざる。`wal_hook` を持つのは本体の Database 接続（WAL のとき）だけ。

## 3. 測定を乱しうる点

- waiter の出入りごとに Mutex（`INNER`）と String の alloc（env が有効なときだけ）。`waiter_enter` は count の `fetch_add` の**前**に呼ぶので、waiter の公開中に trace の処理は走らない。ただし `waiter_exit` は count の `fetch_sub` の後。接続の取得の待ちを µs 級で遅らせる**推測**。
- worker process は `init()` で emit 専用になる（flusher の thread・map・waiter／preempt／cycle の記録は動かない）。worker が追加の thread・heap を持つのは `emit` の一時 alloc だけ。
- `emit` は 1 行ごとの `write` syscall（worker では約 10 行／registration、main では agg 1 行／秒と waiter_sample）。fsync なし。
- `wal_hook` に atomic 1 加算（env なしでも走る。1 命令級）。
- `CycleGuard` は env が有効なときだけ Instant と atomic を読む。

## 4. 検証（最終版の patch に対して）

- `heavy.sh cargo check -p grimodex-db --lib --manifest-path src-tauri/Cargo.toml` → 終了コード 0。
- `heavy.sh cargo check --manifest-path src-tauri/Cargo.toml -p grimodex-db --bins`、および `--bin nir1-c-query-worker` → 終了コード 0。
- `cd electron/native/grimodex-node && heavy.sh cargo check --lib --features nir1-graph-eval` → 終了コード 0（1 分 58 秒。eval の feature 付き）。
- warning は出ていない（ログに `^warning` なし）。
- `node scripts/quality/nir1-graph-eval/native-architecture.mjs`（source だけを読む検査。build 不要）→ 終了コード 0、`native architecture ok`。**事実。**
- `git apply --check -R instrumentation.patch`（worktree で）→ 終了コード 0。
- 走らせていないもの：標準 build、評価 build、admission の他の段（pin の bytes 照合は harness 側を変えていないので対象外のはず）、Rust の試験（`cargo test`）、`pnpm` の検査。

## 5. 未確認・既知の穴

- （解消）`native-architecture.mjs` は通った（上記）。
- 【未確認】worker の `env_clear` 後に転送した env で、worker が実際に file を書けること（実行していない）。worker の cwd は worker の置き場所で、trace dir が絶対 path でなければ別の場所に作られる。**`GDX_DEV_TRACE_DIR` は絶対 path にする。**
- 【未確認】worker の固定 allocator の下で `emit`（String・serde_json・chrono の一時 alloc）が OOM や scratch の seal を乱さないこと。emit は `is_complete_registered_with_scratch` などの scratch scope の**中**からは呼んでいない（コードの読み。stage の emit は scope の外）。file handle は `init()` で scope の前に作る。worker が READY にならなくなったら、この計装が原因の可能性がある（`reg_*` の最後の行と worker の stderr marker を比べる）。worker に fd 数・thread 数を数える invariant があるかは、`nir1-c-query-worker.rs` を grep して `/proc/self/fd`・`/proc/self/task` が無いことだけ確認した（`nir1-c-query-linux-probe.rs` は読んでいない）。
- 【未確認】`wal_hook` が測定中の Database 接続に設定されていること（`background_checkpoint` が Started になる条件：WAL・書込み可）。`commits` が 0 のままなら、設定されていない。
- 【未確認】既存の試験への影響：`c_query_worker.rs` の env 転送は env 未設定では何もしないので、worker の env を数える試験があっても変わらないはず。試験は走らせていない。
- 【既知の限界】busy の preempt の「mutex を持つ側」は直接測れない。begin の scoring の waiter は label が無い。維持の run を奪った foreground の同定は「preempt 時点で立っていた waiter」に限る。
- harness（`frozen-k64-run.mjs` の readyProbe）側の診断の取り出しは触っていない。前回の `instrumentation.patch` の readyProbe の計装と併用すると、`nir1GraphEvalDiagnostics` に `gate` が入る。

## 6. 追記（読み方の注意）

- `preemptsTotal` は過大計上しうる：1 回の中断で `sql-progress-hook` と `participant-check` の両方が数えられることがある。取消し率は DB の cancelled 行の数と照合する。
- process をまたぐ整列は `wall` で行う（`t_ms` は process ごとの起点）。worker の `postflight-drift` の `wall` を main の `cycle` 行の `wall`／`ms` と並べると、どの cycle の commit が窓に入ったかが推定できる（推測の手段）。
- 行番号（patch 適用後、概数）：db `lib.rs` の waiter 約 102〜130、preempt 約 447〜480。`nir1_graph.rs` の `set_registration_stage` 約 243、registration 本体約 590〜750。`background_checkpoint.rs` の `wal_hook` 先頭約 229。`narrative_maintenance_connection.rs` の preempt 約 610、約 1058。native `lib.rs` の label 約 6870、約 7168、`CycleGuard` 約 8853。`nir1_graph_eval/mod.rs` の `diagnostics_json` 内 `"gate"`。正確な位置は patch の hunk を見る。
