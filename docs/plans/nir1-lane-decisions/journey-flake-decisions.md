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

## DR-JF-4 owner／lifecycle の matrix（変わるのは requeue の分類だけ。上限の行は DR-JF-9 で 2 行に分けた）

| 状況                                                               | crate の返り値                            | Native の body                                                                                         | supervised の permit                                              | authority | lifecycle        | 通常の DB             |
| ------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------- | ---------------- | --------------------- |
| 成功（Processed／Idle／Held）                                      | `Ok`                                      | 従来どおり（heartbeat、cutover）                                                                       | `mark_joined`→`release`                                           | 維持      | Ready            | 可                    |
| guard の競合、requeue が `Retryable`                               | `Err(IncrementalFreshnessCycleRequeued)`  | **新**: `Ok(Some({"hasMore":true,"requeued":true,…}))`。heartbeat／cutover はしない                    | `mark_joined`→`release`（**新**。従来は retire→recovery）         | 維持      | Ready            | 可                    |
| guard の競合、requeue が `ContendedRunClosed`（上限、**DR-JF-9**） | `Err(IncrementalFreshnessCycleContended)` | **新**: `Ok(Some({"hasMore":false,"contended":true,"runClosed":true,…}))`。heartbeat／cutover はしない | `mark_joined`→`release`（**新**。DR-JF-9 の前は retire→recovery） | 維持      | Ready            | 可                    |
| 競合以外で requeue が `Terminal`（再試行の上限）                   | 元の `Err`                                | 従来どおり `Err`                                                                                       | 従来どおり retire→`transfer_to_recovery`                          | retire    | RecoveryRequired | `WORKSPACE_SWITCHING` |
| guard の競合、requeue が `NotApplied`（attempt が running でない） | 元の `Err`                                | 従来どおり                                                                                             | 従来どおり recovery                                               | retire    | RecoveryRequired | 拒否                  |
| requeue 自体の失敗（lease lost など）                              | requeue の `Err`                          | 従来どおり                                                                                             | 従来どおり recovery                                               | retire    | RecoveryRequired | 拒否                  |
| evaluation の失敗、lifecycle の停止、他の publish の失敗           | 元の `Err`                                | 従来どおり                                                                                             | 従来どおり recovery                                               | retire    | RecoveryRequired | 拒否                  |
| panic／JoinError                                                   | —                                         | —                                                                                                      | 従来どおり recovery                                               | retire    | RecoveryRequired | 拒否                  |

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

## DR-JF-8 独立レビュー（Opus）の指摘への対応（2026-10-28）

- P2-1（試験の不足）: EDGE の再宣言と producer Epoch の変更を hook で起こし、どちらも型付きの requeue になり、
  次の cycle が同じ range を publish する試験を足した。別の owner が attempt を終えた後の競合（`NotApplied`）は
  requeue にならない（recovery 側に残る）試験も足した。レビュアーの変異 A（EDGE／EPOCH の guard を型の無い
  `anyhow!` に戻す、`NotApplied` を `Retryable` として返す）は、組合せでも各部分の単独でも、対応する試験が落ちる。
- P3-1（context の鎖）: `downcast_ref` は context の鎖を辿るので、分類は最外層の error の型だけを見る
  （`is_publish_guard_race`）。`NEX_DB_TRANSACTION_CLEANUP_UNPROVEN` などの context で包まれた guard の error は、
  従来どおり recovery へ移る。
- P3-2（残余）: 前景の書込みが続き、同じ batch の競合が `MAX_ATTEMPTS_PER_BATCH`（3）回目に達すると、
  従来どおり `NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED` → retire → recovery になり、約 1 s の
  `WORKSPACE_SWITCHING` が起きる。この変更で頻度は下がるが、無くならない。「競合による exhaustion を retire の
  無い terminal にするか」は別の判断として残す（この変更では code を変えない）。**2026-11-08：DR-JF-9 で閉じた**
  （競合による上限は、run を `NEX_INCREMENTAL_FRESHNESS_PUBLISH_CONTENDED` で閉じ、retire しない）。
- P3-3（revalidation の非対称）: requeue の早期 return は `revalidate_narrative_workspace_after_cycle` を通らない。
  workspace の切替と重なると、旧 authority の `projectId`／`runId` と `hasMore: true` が返り、10 ms 後に新しい
  authority で cycle が 1 回走る。requeue は旧 authority に永続化済みで、追加の cycle は新しい authority を読むだけ
  なので無害。成功の経路が切替時に `None` を返すのとは非対称。code のコメントに書いた。
- P3-4（試験の hook の残留）: `publish_race_for_test::arm` は RAII の guard（`ArmedPublishRace`）を返し、Drop で
  hook を必ず消す（試験の panic でも残らない。mutex の poison も無視して消す）。Drop を外す変異は試験が検出する。

## DR-JF-9 publish の guard の競合による上限は、run を閉じて retire しない（2026-11-08。NIR-1 の freshness／lifecycle の委任の範囲）

起案（read-only）は `design-notes/db-connection-2026-11-07/dr-jf-9-draft.md`、原因の調査は同 dir の
`recovery-required-triage.md`。DR-JF-8 の P3-2（残余）を閉じる。ユーザーが NIR-1 の lifecycle の技術判断として
事前に委任した範囲で、integrator が決め、mutation の前にここへ記録した（個別の承認ではない）。

### 不具合（確認済みの事実）

- 保存を約 100 ms より短い間隔で続けると、同じ batch の publish が guard の競合で 3 回続く（`MAX_ATTEMPTS_PER_BATCH`）。
  3 回目は `RETRY_EXHAUSTED`（terminal）になり、cycle は guard の元の `Err` を返す。
- 結果は 2 つ。(1) Native が接続を retire して recovery に進み、約 1 s、すべての DB 操作が拒否される
  （`WORKSPACE_SWITCHING`）。(2) run が `failed`／`terminal_reason_code = NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED`
  になる。cursor は予約を残して lease だけ外し（dead-letter）、予約は `Idle`、選択もこの project を外す。
  契約（`narrative-run-kind-policy` の `cursorAfterExhaustion: reserved-lease-free`／`schedulerAfterExhaustion:
idle-until-new-semantic-epoch`）のとおり、新しい Semantic Epoch まで止まる。recovery は接続を開き直すだけで
  freshness の run には触れないので、書込みが止んでも追いつかない。

### 判断

3 回目の guard の競合では、同じ immediate tx の中で次を行う。

- attempt：`failed`、新しい code `NEX_INCREMENTAL_FRESHNESS_PUBLISH_CONTENDED`、`retry_disposition = 'terminal'`、
  `next_attempt_at = NULL`。task：`failed`。run：`failed`、`terminal_reason_code` も同じ code。
- cursor：lease を外して `last_error` を記録した後、`release_cursor_reservation_in_tx` で予約を **ack せずに**返す
  （`acknowledged_through_sequence` は動かさない。範囲は飛ばさない）。次の tick が新しい run を作り、同じ範囲を
  もう一度評価する（attempt_count は 0 から）。
- crate は型付きの結果 `Err(IncrementalFreshnessCycleContended)` を返す。`…Requeued`（同じ run が同じ範囲を再開する
  という意味を DR-JF-3 で固定）とは別の公開型にする。field は非公開で、tx の commit の後に crate だけが作る。
  Native は `downcast_ref` で型だけを見て分類し、`Ok(Some({"hasMore": false, "contended": true, "runClosed": true,
"projectId", "runId", "throughSequenceInclusive"}))` を返す。supervised の permit は通常どおり
  `mark_joined`→`release` で、retire も recovery もしない。
- 条件は 4 つが揃ったときだけ：`attempt_count >= MAX_ATTEMPTS_PER_BATCH`、`is_publish_guard_race(error)`
  （最外層の型だけ。P3-1 を保つ）、`!batch.idle_checkpoint`、**前景の書込みがあった証拠**（下記）。
- 前景の書込みの証拠（2026-11-08 の独立レビューの major 指摘への対応）：評価の token と publish の token は別の関数なので、
  両者が決定的に食い違う不具合があると、書込みが無くても約 1 s に 1 run が無限に閉じて増える（以前は 3 回で dead-letter
  になって表に出ていた）。数の上限 K（新しい閾値）は置かず、「前景の書込みがあった証拠」を条件にした。
  - 証拠は、その project の Change Feed の head（`MAX(canonical_sequence)`）が、**この attempt を claim した時点**より進んでいること。
    claim の tx で head を読んで `ClaimedBatch.feed_head_at_claim` に持ち、`requeue_after_failure` の tx で今の head と比べる。
    評価は claim の後に始まるので、head が進んでいれば、前景の保存がこの attempt の間に commit されている。
    前景の保存が guard の source を変えるときは、同じ tx で Feed の event も commit するので、本物の競合なら必ず head が進む。
  - 予約（run の作成）時の head でなく attempt ごとの claim 時の head にした理由：run の予約時の値は attempt をまたいで
    持てず（各 attempt は別の cycle で、永続の置き場が要る）、持てたとしても、前の attempt の間の書込みを最後の attempt の
    証拠に数えてしまう。attempt ごとの値は永続化が要らず、証拠がその attempt の窓に限られる。
  - 証拠が無い（head が進んでいない）3 回目の競合は、従来の経路（`RETRY_EXHAUSTED`、retire→recovery、dead-letter）に進む。
    決定的な食い違いは、今と同じく表に出る。
  - **Change Feed を進めない書込み**（producer の edge の宣言のし直し、producer Epoch の変更など）が guard の source を変える
    場合は、証拠が無いので従来の経路に落ちるだけで、DR-JF-9 の前より悪くはならない。
  - 結果として、閉じる run の数は前景の Feed event の数で抑えられる（1 つの run を閉じるには、最後の attempt の間に新しい
    Feed event が 1 つ要る。書込みが無ければ閉じない）。
- `hasMore: false`：競合が続いている証拠なので、既存の idle poll（1 s）まで待つ。保存のたびの wake があれば 10 ms で走る。
  前景との Mutex の取り合いを減らす。正しさは `hasMore: true` でも同じで、違いは負荷だけ。
- 変えないもの：`MAX_ATTEMPTS_PER_BATCH`（3）と scheduler の定数（DR-JF-3 を保つ）。競合以外の terminal
  （評価の失敗、lifecycle の停止、非 guard の publish の失敗、context で包まれた guard）、`NotApplied`、requeue 自体の失敗、
  panic と JoinError は従来どおり元の `Err` で retire→recovery。評価の失敗による枯渇は dead-letter（`RETRY_EXHAUSTED`）のまま。
- 例 (b)（batch をそのまま残す）は採らない：dead-letter のままなら上の止まりと同じで、queued のままなら 4 回目の
  claim を許し `MAX_ATTEMPTS_PER_BATCH` の意味を変える。backoff の導入と tx 内の再評価は統合者の判断で採らない（DR-JF-3）。
- 「前の attempt もすべて競合だったときだけ閉じる」条件は採らない：`RETRYABLE` の code からは前の原因を区別できず、
  混ざった場合も新しい run が 3 回の予算を持ち、決定的な失敗ならそこで dead-letter になるだけで害は無い。

### 信頼境界（脅威モデルの改訂は無い）

- 新しい actor・入口・送信先・権限・保存範囲は無い。分類の根拠は crate の非公開型 `PublishGuardConflict` だけ
  （DR-JF-3 と同じ境界の中）。renderer の入力、IPC、preload、Main の契約には触れない。Main は `hasMore` だけを読み、
  増えた JSON の field は無視する。
- 保存するのは既存の run／task／attempt の行だけで、`error_message` は guard の元の文言（source の identity）。
  今の retryable の attempt と同じで、本文は入らない。
- 動作契約 `narrative-run-kind-policy`（`retryPolicy`）と `narrative-failure-policy` に項目を足す。これは freshness の
  終了処理の技術判断で、NIR-1 の lifecycle の委任の範囲内と考える。閾値・Gold・gate・製品公開・製品認可は変えない。
- 安全性：guard は publish の tx の中で書く前に返り、`with_immediate_transaction` が ROLLBACK する。ROLLBACK が
  証明できないと `NEX_DB_TRANSACTION_CLEANUP_UNPROVEN` で包まれて `is_publish_guard_race` が偽になり、recovery に残る。
  3 回目の後の接続の状態は 1・2 回目と同じ（DR-JF-3 で既に retire していない）。requeue の tx は task の lease を
  `lease_owner` で、cursor を予約の identity で照合する。照合に失敗すると LEASE_LOST／STALE の `Err` になり、
  tx は rollback されて従来どおり recovery に進む。

### owner／lifecycle の matrix（GDX-PRECHECK-001。変わるのは DR-JF-4 の 1 行だけ）

DR-JF-4 の matrix を更新した（上限の行を「競合で上限」と「競合以外で上限」に分けた）。他の行は変わらない。
entry／retry／reentrant の経路は、Native の `run_narrative_freshness_cycle_body` が唯一の製品の呼び出し元で、
scheduler は single-flight。新しい tick は前の cycle が返った後にだけ予約される。

| 段                  | 内容                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| admission           | 通常の permit。閉じ方は変わらない                                                                                            |
| active handle       | crate の cycle が接続を持つ。tx は 1 本（requeue と同じ immediate tx）で commit か rollback                                  |
| 取消・bounded wait  | cycle の control は変えない。tx が失敗すれば従来の `Err`                                                                     |
| 終了の証拠          | tx の commit（run `failed`、cursor の予約が NULL）。型付きの `Err` は commit の後にだけ作る                                  |
| permit              | `mark_joined`→`release`（retire しない）                                                                                     |
| 永続の再起動の状態  | run `failed`／`PUBLISH_CONTENDED`。cursor は予約が無く、`acknowledged` は変わらない。再起動後も次の tick が新しい run を作る |
| 競合以外の terminal | 従来どおり retire→recovery（DR-JF-4 の他の行）                                                                               |

### liveness と行の増え方

- 書込みが続く間：DB の操作は拒否されない。run は、3 回目の attempt の間に Feed が進んだ競合ごとに 1 つ閉じて作り直される。cursor は進まない。遅れは
  読み手に見える（eligibility の pending は cursor と head の差を読む）。古い結果を新しいと偽らない。
- 書込みが止んだ後：guard が食い違うのは、評価の読みから publish の tx までの間に source・edge・producer Epoch が変わった
  ときだけ。止んだ後に評価を始めた attempt は競合せず、publish して cursor を進める。競合以外の失敗が無ければ追いつく。
- 行：1 run あたり run 1・task 1・attempt 3。閉じる run は Feed の head が進んだ競合に限られる（書込みが無ければ閉じず、
  従来の dead-letter に進んで表に出る）ので、閉じた run の数は前景の Feed event の数以下で、change event の増え方の
  定数倍。掃除は project の削除だけ（既存の性質）。
- project の順序（独立レビューの minor 指摘への対応）：予約の選択（`select_next_project` と hold 付きの複製の 2 つ目の問合せ）は、
  project ごとの最古の未処理の連番だけで順位を決めていたので、cursor が遅れている project が毎回先に選ばれ、競合が続く間
  他の project が飢える（以前は dead-letter でその project が選択から外れていた）。順位の先頭に cursor の `updated_at`
  （最後に処理した時刻。cursor が無い project は最優先）を足した。競合で閉じた project は予約の解除で `updated_at` が
  新しくなるので後回しになり、他の project が先に進む。同順位は従来の連番・project id。順位の変更はこの 2 つの問合せだけで、
  active な予約の選択（1 つ目の問合せ）は変えない。
- liveness の capability は作らない（競合が長く続くと cutover の liveness は requeue の時と同じく古いまま。既存の性質）。
- `revalidate_narrative_workspace_after_cycle` を通らない非対称は requeue と同じ（DR-JF-8 の P3-3）。コード中のコメントに書いた。

### 起案の文面とコードの食い違い

- 起案は failure policy の行に `nextAttemptPolicy: release-and-reprocess-under-new-run` を置くとしたが、
  `validate-execution-state-authority.mjs` は「retryable でない項目の `nextAttemptPolicy` は `none`」を要求する
  （C2-01 の不変条件：`next_attempt_at` は retryable のときだけ）。コードを正とし、`backoffPolicy: none`、
  `nextAttemptPolicy: none` にした。「新しい run で再処理する」は run-kind policy の `retryPolicy` 側に書く。

### 追加で調べたこと（実装はしない）

すでに dead-letter になっている project（`terminal_reason_code = NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED`）について。

- 動かし直すべきか：**動かし直すべきだが、この PR では実装しない**。統合者の判断（レビューの推奨どおり）：**M1 を、この PR が
  merge された後の別の PR で入れる。判別は substr の比較か ESCAPE 付きの LIKE で行う（`_` と `%` を含む接頭辞を LIKE の
  ワイルドカードとして誤判定しない）。条件は、最後の attempt が terminal、cursor がその run を予約している、epoch が現行と
  同じ。M2 は採らない。**
  - 理由：原因が前景の書込みとの一時的な競合で、書込みが止んでも追いつかない状態が新しい Epoch（復元・migration など）まで
    続く。release は ack しないので範囲は飛ばさず、新しい run が同じ範囲を計算し直すだけで、データは失われない。
  - 実装しない理由：閉じた run の再開は、`cursorAfterExhaustion`／`schedulerAfterExhaustion` の契約（dead-letter は
    新しい Epoch まで Idle）を変えるか、persist 済みの利用者 DB の行を書き換える（migration）かのどちらかで、
    どちらも製品の挙動と既存データの扱いを変える。
- 見分けられるか：**見分けられる（高い確度）**。
  - 競合による枯渇では、最後の attempt（`retry_disposition = 'terminal'`、`failure_code = RETRY_EXHAUSTED`）の
    `error_message` は guard の元の文言のまま（`requeue_after_failure` が `format!("{error:#}")` を記録する）。
    4 つの guard の文言は、いずれも次の接頭辞で始まる（grep で、他の場所が作る文言ではないことを確認した）。
    `NEX_INCREMENTAL_FRESHNESS_EDGE_CHANGED:`、`NEX_INCREMENTAL_FRESHNESS_SOURCE_CHANGED:`、
    `NEX_INCREMENTAL_FRESHNESS_TYPED_SOURCE_CHANGED:`、`NEX_SEMANTIC_EPOCH_CHANGED:`。
    run の `terminal_reason_code` は `RETRY_EXHAUSTED` だけで、原因の区別が無い。task の `error_message` と
    cursor の `last_error` にも同じ文言が残る。
  - 判別の SQL（案）：`narrative_extraction_runs`（`status = 'failed'` かつ `terminal_reason_code =
'NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED'`、freshness の run kind）→ その task の最後の attempt の
    `error_message` が上の 4 つの接頭辞のどれか。context で包まれた guard（`NEX_DB_TRANSACTION_CLEANUP_UNPROVEN: …`）と、
    interrupted の枯渇（`incremental Freshness worker was interrupted and exhausted its retry budget`）は
    接頭辞が違うので含まれない（保守側）。
  - 限界：前の 2 回が評価の失敗で、最後だけ競合だった run も競合に数える。これは新しい挙動と同じ扱いで（上の「採らない」）、
    再開しても新しい run が決定的な失敗で再び dead-letter になるだけ（有界）。
- 安全な移行の案（どれも別の判断・別の PR）：
  - 案 M1（1 回だけ release する移行）：schema の migration で、上の判別に当たり、cursor がその run の予約を持つ行だけ
    `release_cursor_reservation` と同じ更新（`active_run_id`・`semantic_epoch_id`・`reserved_through_sequence`・lease を
    NULL、`acknowledged` は不変）をする。閉じた run は `failed`／`RETRY_EXHAUSTED` のまま残す（履歴は変えない）。
    契約（`runtime が dead-letter を保持する`）は変えず、既存の DB の状態だけを直す。migration は 1 回だけ走り、
    決定的な失敗の project は新しい run が 1 回だけ再び dead-letter になる。
  - 案 M2（予約時の自己修復。**採らない**）：`reserve_or_resume_batch_in_tx` の dead-letter の分岐で、判別に当たれば `_` の分岐と同じ解除を
    して新しい run を作る。移行が要らず、後から現れた dead-letter も直るが、`select_next_project` の 2 つの SQL も
    同じ判別に揃える必要があり、契約の `schedulerAfterExhaustion` の文言を変える。新しい code が入った後は、
    競合の枯渇はもう dead-letter を作らないので、M2 は既存の行のためだけの恒久の分岐になる。M1 のほうが小さい。
  - 案 M3（何もしない）：新しい Epoch（復元・migration・Epoch の rotation）で回復する。freshness が古いまま残る期間が不定。
  - 採用は M1（別の PR）。判別の条件は、(1) 最後の attempt が `terminal` で上の 4 つの接頭辞の `error_message`、(2) cursor が
    その run を予約している（`active_run_id = run.id`、`reserved_through_sequence` が一致）、(3) 予約の `semantic_epoch_id` が
    project の現行の Epoch と同じ（古い Epoch の予約は既存の経路が解除する）。接頭辞の比較は `substr(error_message, 1, length(prefix)) = prefix`
    か `LIKE prefix || '%' ESCAPE '\\'`。実装の前に、利用者の DB の実数（`RETRY_EXHAUSTED` の freshness run の数と、その判別に当たる数）を
    確かめ、migration の番号と `schema-contract.json` の更新が要ることを見込む。

### M1 の実装（2026-11-08。DR-JF-9 の追補。判断の ID は DR-JF-9 のまま。NIR-1 の freshness／lifecycle の委任の範囲）

上の「追加で調べたこと」で採用した M1 を、#828 の merge（master `5344067d`）の後の別の PR で実装した。#828 は新しい
dead-letter を作らなくしたが、すでに `NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED` で止まった利用者の project は
新しい Semantic Epoch まで止まったままだった。M2（予約時の自己修復）は採らない（上のとおり）。

**判断**

- 置き場：`grimodex-db` の migration（`migrate.rs` の `release_contended_freshness_exhaustions_v45`）。
  **SCHEMA 44→45**。DDL は無く、物理の checkpoint の形は 44 と同じ（`has_current_schema_checkpoint_invariants` の版の固定だけを 45 にした）。
  版を上げる理由：現在の版の open は read-only の fast path で書き込まず、migration は版が上がるときにだけ 1 回走る。
  `schema_data_migrations` の marker は使わない（条件に当たる行が無くなれば 2 回目は何も当たらない冪等な更新で、marker の
  namespace と import の検査を広げないため）。
- 走らせる場所は 2 つで、どちらも `user_version` の stamp と同じ transaction／savepoint の中：
  (1) 直前の版（44）の marker だけを進める finalize（`try_finalize_previous_schema_without_wait`。`BEGIN IMMEDIATE` の中）、
  (2) 完全な migration（`migrate_impl`。C2-ZB の savepoint の中、checkpoint の検査と stamp の前）。**`current < 45` のときだけ**走らせる
  （`migrate_for_restore_preflight`〔force_full〕や、supervisor の「現在版だが invariant が欠けた」経路は 45 の DB でも完全な pass を通り、
  その copy がそのまま live になる。版で絞らないと、45 の build が作った dead-letter まで解く。2026-11-08 のレビューの major 指摘）。
  現在の版（45）の open は、fast path も完全な pass も走らない。45 の build が作る dead-letter（Feed の証拠が無い guard の競合、決定的な食い違い）は表に出たまま残す。
  finalize が他の writer と競合して Busy のときは、`user_version` は 44 のまま、次の open が同じ手順をやり直す（stamp と release は一緒に commit か rollback）。
- 判別の条件（すべて満たすときだけ。レビュー〔Opus〕の注意点どおり）：
  1. cursor が Freshness consumer のもので、run を予約していて（`active_run_id`、`reserved_through_sequence`、`semantic_epoch_id` が非 NULL）、lease が無い。
  2. 予約の Epoch が project の現行の Epoch（`epoch_number` 最大）と同じ。古い Epoch の予約は、既存の予約の経路が解除して再生する。
  3. その run が同じ project・同じ Epoch の `freshness-evaluation` で、`failed`／`terminal_reason_code = RETRY_EXHAUSTED`。
  4. その run の failed task の**最後の attempt**（`attempt_number` 最大）が `failed`／`retry_disposition = 'terminal'`／
     `failure_code = RETRY_EXHAUSTED`、かつ `error_message` が 4 つの guard の文言（`EDGE_CHANGED: `、`SOURCE_CHANGED: `、
     `TYPED_SOURCE_CHANGED: `、`NEX_SEMANTIC_EPOCH_CHANGED: Edge producer Epoch changed before publication`）のどれかで**始まる**。
  比較は `substr(error_message, 1, length(prefix)) = prefix`（`LIKE` は使わない。`_` がワイルドカードで、`LIKE` は ASCII の大文字小文字も区別しない）。
  接頭辞は `incremental_freshness.rs` の定数 `PUBLISH_GUARD_MESSAGE_PREFIXES` で、4 つの guard はその定数から文言を作る
  （migration と guard の文言が食い違わない。文言を変えたら定数が変わり、試験が guard の出力との一致を見る）。
  context で包まれた guard（`NEX_DB_TRANSACTION_CLEANUP_UNPROVEN: …`）、interrupted の枯渇、評価の失敗などの競合以外の dead-letter は接頭辞が違うので残る。
- 更新：条件に当たる cursor の `semantic_epoch_id`・`reserved_through_sequence`・`active_run_id`・`lease_owner`・`lease_expires_at` を NULL にし、
  `updated_at` を今にする（`release_cursor_reservation_in_tx` と同じ。`acknowledged_through_sequence` は動かさないので範囲は飛ばさない。
  `last_error` も残す。DR-JF-9 本体の競合の close と同じ形）。次の tick が新しい run を作り、同じ範囲を計算し直す
  （`updated_at` が新しいので、他の project の後に回る）。**run・task・attempt の行は変えず、terminal のまま残す**。

**変える行の範囲と、戻せないことの影響（利用者の DB の行を書き換える移行）**

- 書くのは `narrative_change_cursors` の、条件に当たる Freshness consumer の行の予約の列（上の 6 列）だけ。
  `narrative_extraction_runs`／`tasks`／`attempts`、Change Feed、dependency edge、本文・Codex・設定など、利用者の著作と
  canonical な状態には一切触れない。cursor の予約は rebuildable な Freshness の作業状態で、解いても失うのは「予約している」という
  事実だけ（run の id と通し番号の範囲は残った run・attempt の行から分かる）。
- migration は解く前の値を別に保存しないので、**この更新を元に戻すことはできない**。戻す必要は無い：解いた状態は
  「その範囲を ack していない、予約の無い cursor」で、通常の運用の状態と同じ。解いた後に決定的な失敗が続く project は、新しい run が
  3 回の attempt の後に再び dead-letter になるだけ（有界で、1 回）。
- 版は 45 に上がるので、45 を stamp した DB を 44 以前の build で開くことはできない（既存の migration と同じ downgrade 非対応）。
  版が 45 未満の backup を restore した DB は、restore の preflight の完全な migration（その copy が live になる）で、もう一度この更新が当たる。
  45 の DB の restore preflight や invariant 修復の完全な pass は解かない（`current < 45` の条件。試験で固定）。
- 限界（上の「見分けられるか」と同じ）：DR-JF-9 の本体が使う「attempt の間に Feed が進んだ」証拠は、過去の行からは再構成できない。
  そのため、guard の文言で終わった dead-letter は、決定的な食い違いのものも解く。再開しても、決定的な失敗なら新しい run が
  3 回で再び dead-letter になる（有界。1 project につき 1 回）。**費用がある**：その再 dead-letter は DR-JF-4 の matrix の
  競合以外の上限の行と同じ retire→recovery で、約 1 s の `WORKSPACE_SWITCHING` による DB 操作の拒否が 1 回起きる。
  前の 2 回が評価の失敗で最後だけ競合だった run も同様。この費用は、解かないまま止まり続けることと比べて許容する（1 回で終わる）。
- 利用者の DB の実数（`RETRY_EXHAUSTED` の freshness run の数と判別に当たる数）は、利用者の DB を読まない方針なので確かめていない。
  代わりに、migration は解いた件数を `tracing`（`narrative.migrate`）に出す。

**信頼境界（脅威モデルの改訂は無い）**

- 新しい actor・入口・送信先・権限・保存範囲は無い。renderer の入力、IPC、preload、Main、N-API の契約は変えない。
  migration は Native が開く自分の workspace の DB だけを読み書きする。秘密・データの送信は無い。
- 動作契約（`narrative-run-kind-policy` の `cursorAfterExhaustion: reserved-lease-free`／`schedulerAfterExhaustion:
  idle-until-new-semantic-epoch`、`narrative-failure-policy`）は変えない。契約が dead-letter を保持する規則は新しい run には
  そのまま適用され、解くのは「契約の前の挙動で作られた、競合が原因の dead-letter」の既存の行だけ。閾値・Gold・gate・製品公開・製品認可・新しい契約の authority は変えない。
- owner／lifecycle：新しい非同期・subprocess・背景の経路は無い。migration は workspace の open の中で同期的に走り、
  transaction（`BEGIN IMMEDIATE` か完全な migration の savepoint）が commit か rollback で閉じる（DR-JF-9 の matrix の「競合以外の terminal」の行と、他の経路は変わらない）。

**試験**（`incremental_freshness.rs` の `contention_release`）：競合が原因の枯渇は解かれ、run・task・attempt が不変で、次の cycle が同じ範囲を追いつく／
4 つの接頭辞のすべて／競合以外（評価の失敗、interrupted、context で包まれた guard、`_` と大文字小文字のワイルドカードの誤一致、
先頭の空白、文中の guard 文言、空・NULL の message）は残る／最後でない attempt の guard 文言は数えない／Epoch が違う・lease あり・
最後の attempt が terminal でない・別の code・別の理由で終わった run・retryable な run・予約を返し済みの run は触らない／
実際の guard（source・edge・producer Epoch）が cycle に保存させた文言が解かれる／
44→45 の marker だけの step と完全な migration の両方で解いて stamp する／stamp が失敗したら release も rollback され、次の open がやり直す／
現在の版の open と、45 の DB の restore preflight の完全な pass は解かない／45 未満の restore preflight は解く。
