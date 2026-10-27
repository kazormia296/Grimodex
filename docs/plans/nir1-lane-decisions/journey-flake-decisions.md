# journey flake（`nir1-scene-scope-projection-acceptance`）の判断記録

対象は PR CI の `Electron product journeys (shard 6/7)` で、最初の journey
`nir1-scene-scope-projection-acceptance`（`electron/scripts/nir1-scene-scope-projection-product-journey.mjs`）が
落ち、同じ shard の残り 6 本が fail-fast でスキップされる flake。調査は 2026-10-28。
証跡は読むだけで、製品 code は変えていない。

## DR-JF-1 `WORKSPACE_SWITCHING` の失敗は製品の欠陥（[precheck] で停止）

- 観測（#747 の run 40519368093、artifact の `operations.jsonl`・`main-diagnostics.json`・DB 断面）:
  - 失敗は `reopen-anchor-move` の matrix の `story-time-order-roundtrip-stays-invalid` の途中。
    `temporal_scene_patch`（storyOn）の後、2 回目の `temporal_scene_patch`（storyOff、
    14:36:10.968〜10.996Z）と、背景の Incremental Freshness の cycle（run `c8f3e018…`、attempt の
    started 10.981Z）が重なった。
  - DB 断面の `narrative_extraction_attempts` に、その attempt の
    `NEX_INCREMENTAL_FRESHNESS_TYPED_SOURCE_CHANGED: 'project:scene-scope-projection:x14-q1-…' changed after evaluation`
    （`failure_code = NEX_INCREMENTAL_FRESHNESS_RETRYABLE`、`retry_disposition = retryable`）が残る。
    評価は storyOff の前の Scope token を読み、publish の transaction で storyOff の後の token と食い違った。
  - 直後（11.005Z）の Main の stderr に
    `[workspace-lifecycle-diag] {"producer":"freshness","cause":"E","boundary":"handoff","state":"recovery-required","owner":"Maintenance",…}`。
  - journey の次の `db_execute`（11.000〜11.020Z）が `WORKSPACE_SWITCHING` で拒否された。
    次の freshness tick が recovery を reconcile し、12.068Z に新しい run、12.112Z に cursor が 137 まで進んだ
    （拒否の窓はおよそ 1.1 秒）。
  - #749 の run 40503140508 の log も同じ位置（`anchor-archive-roundtrip-stays-invalid` の直後）で同じ
    `workspace-lifecycle-diag`（freshness／E／handoff／recovery-required）を出している。
- 仕組み:
  - `grimodex-db` の `run_serialized_cycle_with_control` は、publish の optimistic guard
    （`NEX_INCREMENTAL_FRESHNESS_SOURCE_CHANGED`／`…_TYPED_SOURCE_CHANGED`／`NEX_SEMANTIC_EPOCH_CHANGED`）
    の食い違いを `requeue_after_failure` で retryable として durable に記録し、そのうえで `Err` を返す。
  - Native の `run_narrative_freshness_cycle_supervised`（`electron/native/grimodex-node/src/lib.rs`）は
    worker の `Err` をすべて「予期しない失敗」として扱い、authority を retire し、permit を recovery へ移す
    （`transfer_to_recovery_diagnosed`）。lifecycle は `RecoveryRequired` になり、
    `resolve_workspace_snapshot` は通常の DB command をすべて `WORKSPACE_SWITCHING` で拒否する。
- 判断: 前景の Scope 系の書込み（temporal／tree／scope の patch）と背景の freshness の publish が数十 ms の窓で
  重なるだけで、接続の retire と workspace 全体の約 1 秒の拒否が起きる。利用者の連続した編集でも起こり得るので、
  journey の待ちの不足ではなく製品の欠陥と判断する。master の Full が通るのは窓に当たらない時間配分のため。
- この依頼の範囲では製品 code（`electron/native`、Rust）を変えないため、ここで [precheck] として止める。

### 選択肢

- A（推奨）: 製品の修正。publish の optimistic guard の食い違いを、crate が retryable として requeue 済みの
  型付きの結果（例えば `IncrementalFreshnessCycleOutcome` の新しい variant、または型付きの error）で返し、
  Native はそれを recovery へ移さず permit を通常どおり release する。文字列の照合で分類しない。
  NIR-1 の lifecycle／owner の判断の委任の範囲内だが、Rust の build と Native の試験が要る。
- B: harness だけの対処。`db_execute` などの helper で `WORKSPACE_SWITCHING` を上限つきで再試行する。
  拒否の窓では全 DB command が落ちるので、`invokeOk` の書込みにも再試行が要り、他の journey の
  switching の検査を覆う恐れがある。欠陥を隠すので単独では勧めない。
- C: journey 側で前景の書込みを freshness の settle の後に限る（storyOff の前に `settleFeed`）。
  CI は安定しやすいが、利用者の欠陥は残り、matrix の他の連続書込みでも同じ窓は開く。A までの暫定に限る。

## DR-JF-2 #748 の `the rejection writes nothing` は別の仕組み（harness の待ちの不足）

- 観測（#748 の run 40501474529 の attempt 1、job 122184506775 の log）: 差分は `runsAll: 90 → 91` だけで、
  `runs`（`default-project`）と `runsForeign` は変わらない。増えた 1 行は 2 つ目の project
  （`createSecondProject` と `treeCreate(second, …)` で作った project）の `narrative_extraction_runs`。
- 仕組み: `runSnapshotChecks` は 2 つ目の project を作った直後に `countRejectionTables` を取る。その project の
  Change Feed を背景の freshness が処理して `freshness-evaluation` の run を作るのが、before と after の間に入った。
  拒否された prepare の書込みではない。workspace の switching とは無関係で、同じ背景 consumer との競合の別の現れ。
- 判断（提案。未実装）: 検査の意味（全 project・全表の件数が変わらない）は保ち、before を取る前に背景の
  consumer を静止させる。2 つの project の `settleFeed`（cursor が head に追いつく）に加え、2 つ目の project の
  現行 epoch の `freshness-evaluation` run がある（idle checkpoint が後から作られない）ことを待つ。
  件数の対象から背景の run を除く案は検査を弱めるので採らない。実 Electron での確認が要るため、
  DR-JF-1 の選択と一緒に進める。

## DR-JF-3 A を採る（2026-10-28、coordinator の決定。NIR-1 の freshness／lifecycle の委任の範囲）

- 範囲: 製品 code は、この欠陥に要る最小限（`grimodex-db` の incremental freshness、Native の freshness cycle の
  body）。新しい送信先、保存範囲の拡大、閾値の緩和、gate の開放、新しい authority は無い。
  `MAX_ATTEMPTS_PER_BATCH`（3）と scheduler の間隔は変えない。
- 信頼境界: 分類の根拠は crate の中の型だけ。publish の 4 つの guard（`…_EDGE_CHANGED`／`…_SOURCE_CHANGED`／
  `…_TYPED_SOURCE_CHANGED`／`NEX_SEMANTIC_EPOCH_CHANGED`）が crate 内の非公開型 `PublishGuardConflict` を作る。
  cycle は、`requeue_after_failure` の transaction が commit して結果が `Retryable` のときに限り、
  公開型 `IncrementalFreshnessCycleRequeued` の `Err` を返す。この型の field は非公開で、構築できるのは
  crate だけ。Native は `downcast_ref` で型を見るだけで、message の文字列では分類しない。
- 型付きの結果を `Err` のままにした理由: cycle は完了していないので、liveness の capability
  （`SuccessfulIncrementalFreshnessCycle`）を作らない契約を保つ。`IncrementalFreshnessCycleOutcome` に
  `Ok` の variant を足すと、liveness の wrapper が requeue された cycle に capability を作ってしまう。
  message は guard の元の文言のまま（既存の文字列の試験とログは変わらない）。

## DR-JF-4 owner／lifecycle の matrix（変わるのは requeue の分類だけ）

| 状況                                                               | crate の返り値                           | Native の body                                                                      | supervised の permit                                      | authority | lifecycle        | 通常の DB             |
| ------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | --------- | ---------------- | --------------------- |
| 成功（Processed／Idle／Held）                                      | `Ok`                                     | 従来どおり（heartbeat、cutover）                                                    | `mark_joined`→`release`                                   | 維持      | Ready            | 可                    |
| guard の競合、requeue が `Retryable`                               | `Err(IncrementalFreshnessCycleRequeued)` | **新**: `Ok(Some({"hasMore":true,"requeued":true,…}))`。heartbeat／cutover はしない | `mark_joined`→`release`（**新**。従来は retire→recovery） | 維持      | Ready            | 可                    |
| guard の競合、requeue が `Terminal`（再試行の上限）                | 元の `Err`                               | 従来どおり `Err`                                                                    | 従来どおり retire→`transfer_to_recovery`                  | retire    | RecoveryRequired | `WORKSPACE_SWITCHING` |
| guard の競合、requeue が `NotApplied`（attempt が running でない） | 元の `Err`                               | 従来どおり                                                                          | 従来どおり recovery                                       | retire    | RecoveryRequired | 拒否                  |
| requeue 自体の失敗（lease lost など）                              | requeue の `Err`                         | 従来どおり                                                                          | 従来どおり recovery                                       | retire    | RecoveryRequired | 拒否                  |
| evaluation の失敗、lifecycle の停止、他の publish の失敗           | 元の `Err`                               | 従来どおり                                                                          | 従来どおり recovery                                       | retire    | RecoveryRequired | 拒否                  |
| panic／JoinError                                                   | —                                        | —                                                                                   | 従来どおり recovery                                       | retire    | RecoveryRequired | 拒否                  |

- `hasMore: true` で Main の scheduler は `BACKLOG_DELAY_MS`（10 ms）後に次の cycle を予約する。次の cycle は
  同じ Run の reservation を `resume_active_batch_in_tx` で再開し、publish して cursor を進める（cursor は止まらない）。
  CI の held-freshness の観測は `quiescenceState` が無い結果を receipt にしない（recovery の結果と同じ扱い）。
- 他の呼び出し元: `run_incremental_freshness_cycle*` の製品の呼び出し元は Native の
  `run_narrative_freshness_cycle_body` だけ（supervised と test 用の inner の両方がここを通る）。
  `narrative_maintenance.rs`、`nir1_prepared_request.rs` と crate 内の呼び出しは試験で、`Err` の Display が
  変わらないので影響しない。Tauri shell と MCP は呼ばない。
- 試験用の seam: `publish_race_for_test`（evaluation の後、publish の transaction の前に 1 回だけ hook を呼ぶ。
  `Database` の address で引く）は `cfg(any(test, feature = "workspace-maintenance-test-support"))` だけで
  compile される。この feature は grimodex-node の dev-dependency でだけ有効で、N-API の build と release には入らない。

## DR-JF-5 代替案 B／C を採らない理由

- B（harness で `WORKSPACE_SWITCHING` を再試行）: 拒否の窓では全 DB command が落ちるので、`invokeOk` の書込みにも
  再試行が要り、他の journey の switching の検査を覆う。利用者の欠陥が残る。coordinator も不採用。
- C（journey で書込みを settle の後に限る）: 利用者の欠陥が残り、journey の並行性の網羅が減る。
- #748 は DR-JF-2 のとおり journey 側で直す。`countRejectionTablesWhenQuiescent` が、関係する project の
  Freshness Feed の settle（cursor が head 以上、active run なし）と、件数が `BACKGROUND_QUIESCENCE_STABLE_MS`
  （2.5 s。scheduler の idle poll 1 s の 2 回分超）変わらないことを待ってから before を取る。比較（全 project・全表）と
  after の取り方は変えない。上限 60 s で待ちきれなければ失敗する（件数を取らない）。

## DR-JF-6 同じ journey の toast の click timeout も harness 側で直す

- 観測: 実機の直す前の確認（disk 上の一時 dir、4 CPU 固定、負荷 2）で 6 回中 5 回、`prepare-ui-input` の
  `detail-tab-details` の click が 30 s の timeout になった。Playwright の call log では、関係を追加した後の
  success toast（sonner、右下、4 s）が pointer event を受けていた。click の再試行で pointer が toast の上に
  留まると sonner は timer を止めるので、toast は消えない。続行計画に記録された同じ journey の flake
  （「トーストが pointer event を奪う click timeout」）と同じ。
- 判断: shard 6 の fail-fast を減らす目的の範囲として、journey 側で直す。click の前に pointer を (0, 0) へ移し、
  `[data-sonner-toast]` が全部消えるのを待つ（上限 `TOAST_CLEAR_TIMEOUT_MS` = 15 s）。click の対象と、その後の
  検査は変えない。製品の toast の表示と時間は変えない。

## DR-JF-7 確認の結果（2026-10-28）

- Rust の決定的な再現（`publish_race_for_test` の hook で、評価と publish の間に前景の書込みを入れる）:
  - 修正前: crate の 3 試験（SOURCE と TYPED_SOURCE の競合、上限到達）が失敗した。TYPED の試験の失敗の文言は CI と
    同じ `NEX_INCREMENTAL_FRESHNESS_TYPED_SOURCE_CHANGED: 'project:scene-scope-projection:…'`。
    Native の 2 試験は `freshness-recovery-required` の結果で失敗した。
  - 修正後: 全部通る。変異（Native の分類の削除、crate の分類の削除、`Retryable` の条件の削除、guard の型の
    条件の削除）は、それぞれ該当の試験が検出した。
- 実 Electron（`scripts/local-ci-xvfb.mjs` を host の namespace で起動。Wayland、D-Bus、proxy の変数は除き、
  `unshare` は使わない。起動前に利用者の X0／X1 以外の Xvfb が無いことを毎回確かめ、timeout は pid 指定）:
  - 修正前（master の `.node` と master の journey）:
    - tmpfs の一時 dir では 13 回とも本体は 29 step 通った。publish の競合は 0 件（DB の断面で数えた）で、
      手元の速さでは窓に当たらない。判定は、この環境の private bus の atspi の警告で落ちたが、これは環境の雑音。
    - disk の一時 dir、4 CPU 固定、負荷 2 では 6 回中 6 回失敗した。5 回は toast の click timeout（DR-JF-6）、
      1 回は #748 と同じ `the rejection writes nothing`（`runsAll` 105→106）。
  - 修正後（修正版の `.node` と修正版の journey）: disk の一時 dir、4 CPU 固定、負荷 2 で **10 回連続で passed**
    （29 step。stderr の判定も clean。1 回 214〜258 s）。
- `WORKSPACE_SWITCHING` そのものは手元の実機で再現できなかった。この経路の確認は Rust の決定的な試験に依る。
- 観測（範囲外）: 手元の 13 回中 3 回、終了中（`Debugger ending` の後）に `automatic-maintenance` の
  handoff が recovery へ移った（直前の attempt は `NEX_VALIDATION_TERMINATED:foreground-preempted`）。
  終了中のため journey は落ちていない。freshness とは別の経路なので、この変更では扱わない。
