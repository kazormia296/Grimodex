# 自動 maintenance の「前景に奪われた後の recovery」の判断記録

対象は、自動の narrative maintenance（durable chain の cycle：Backfill → dependency-verify → semantic-index-rebuild）が
前景の作業と重なった後に、workspace の authority が retire されて `recovery-required` に移り、以後の DB command が
`NIR1_MAINTENANCE_CONNECTION_UNUSABLE: retired for exact lifecycle recovery` や `WORKSPACE_SWITCHING` で拒否される事象。
調査は 2026-10-28。前例は #752（DR-JF-1〜8、freshness の publish の競合を型付きの requeue にした修正）。

## DR-MP-1 原因：前景の preempt の分類ではなく、commit 済みの Run の所有が残ること

- 読んだ経路（`electron/native/grimodex-node/src/lib.rs` の `run_narrative_maintenance_cycle`、
  `finalize_automatic_maintenance_permit`、crate の `maintenance_runtime.rs`、`restore_rebuild.rs`、`legacy_backfill.rs`）:
  - preempt（`NEX_MAINTENANCE_CONNECTION_PREEMPTED`／`NEX_VALIDATION_TERMINATED:foreground-preempted`）は、
    cycle のどこで起きても deferred になる。adapter の dispatch 中なら crate が `mark_deferred` して
    `accepted(hasMore=true)` を返す。それ以外（discovery、Native の後処理）でも、worker の最後の分類
    （`is_narrative_maintenance_preemption` → `{"status":"accepted","hasMore":true,"preempted":true}`）が
    permit の finalizer より前に `Ok` へ変える。preempt で recovery へ行く経路は、cleanup の失敗
    （`NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED`／`…_UNUSABLE` が同じ chain にある）だけで、これは仕様どおり。
  - 一方、preempt 以外の「普通の失敗」（Main の取消、lifecycle の停止、SQL の失敗など）は、
    `automatic_maintenance_error_releases_normally` の 4 条件（Error 分類、attempt の cleanup が clean、接続が再利用可能、
    **permit に Run の所有が残っていない**）がそろうときだけ通常の release になり、そろわなければ retire と recovery。
  - adapter（Backfill／Verify／Rebuild）は Run の作成時に `attach_run` で permit に所有を付けるが、
    **成功の終端 transaction の commit の後に `mark_run_terminalized` を呼んでいない**（呼ぶのは失敗の記録と取消の移譲だけ）。
    そのため、同じ cycle で Run が completed になった後に普通の失敗が起きると、DB では終わっている Run の所有が残り、
    supervisor は clean な接続を retire して `RecoveryRequired` を publish する。
- 証拠との対応（下の表）。3 件の automatic-maintenance の handoff はどれも `cause:"E"`（普通の失敗、panic ではない）で、
  直前に同じ process の dependency-verify が completed になっている（170〜220 ms 前）。Raw の再構築が受けた理由の文字列が
  `retired for exact lifecycle recovery`（接続の health は最初の理由を保つ）なので、retire の前に接続は quarantine されていない。
  つまり 4 条件のうち欠けたのは Run の所有の条件である。

| 経路 | 例 | 分類 | 結果（修正前） | 証拠 |
|---|---|---|---|---|
| (a) dispatch 中の preempt | Verify の phase が no-wait で接続を取れない | 型付きでない文字列の分類（chain） | crate が `mark_deferred`、`accepted(hasMore)`。recovery なし | P-6（696 回の cancel の暴走。deferred のまま） |
| (b) discovery／Native 後処理の preempt | commit 後の follow-up discovery が接続を取れない | 同上。worker の最後で `Ok(accepted, preempted)` | permit は release。recovery なし | 試験 `verify_commit_then_foreground_owner_requeues_without_recovery` |
| (c) commit 後の普通の失敗 | Main の quiesce による取消（workspace 切替・終了）、lifecycle の停止、SQL などの失敗 | preempt でない Err | **Run の所有が残るので retire と recovery** | 証拠 1（S5-A dev、2 回）、証拠 2（journey の終了中、13 回中 3 回） |
| (d) cleanup の失敗 | rollback や設定の復元の失敗 | `…_CLEANUP_FAILED` を含む | retire と recovery（正しい） | なし |
| (e) freshness の publish の競合 | 前景の Scope 書込みと publish の重なり | producer は freshness | #752 前は recovery。#752 で型付きの requeue に修正済み | 証拠 3（#744 の CI、`producer:"freshness"`） |

- 証拠ごとの所見:
  - 証拠 1（`claude-s5a/.artifacts/cp4/s5a-dev-held`、`s5a-dev-held2`）: Main の stderr に
    `{"producer":"automatic-maintenance","cause":"E","boundary":"handoff","state":"recovery-required"}`。DB の断面では
    held2 で 19:27:38.878〜.949 の Verify が `NEX_MAINTENANCE_CONNECTION_PREEMPTED` で cancelled（経路 (a)、deferred）、
    次の Verify が 38.958〜39.270 に completed、handoff が 39.490。held も 59.731 の completed の 179 ms 後に handoff。
    Raw の再構築の audit の append が 2 回とも `retired for exact lifecycle recovery` で落ちた（被害側）。
    普通の失敗そのものの文言は記録に残っていない（Native の `tracing` は stderr に出ない）。oneshot 系の
    （chronicle-index-unusable）は handoff なし。
  - 証拠 2（`claude-journey-flake/.artifacts/gjf/runs/before-pin4/iter-5`）: `electron-close` が 15:52:18.432 に始まり、
    Verify が 18.709 に completed、handoff が 18.881（`shutdownRequested:false`）。Main の `dispose` は
    `quiesceForWorkspaceSwitch` で active attempt を `workspace-generation-changed` で取り消すので、経路 (c) の取消。
    直前の Verify の `foreground-preempted` は経路 (a) で、handoff の原因ではない。
  - 証拠 3（run 40467621947 の attempt 1、job 122069235653）: `[workspace-lifecycle-diag]` は 2 回とも
    `producer:"freshness"`。automatic maintenance の経路ではなく、#752 の対象（その時点の base は #752 の前）。
- 判断: 製品の欠陥。経路 (c) は利用者の操作（workspace の切替、アプリの終了）でも起きる。前景の作業と重なった
  後の普通の失敗でも起きる（S5-A の dev で 2 回）。
- 未確定: S5-A の 2 件で、commit の後に起きた普通の失敗が何だったか（取消でも終了でもない）。記録に文言が無い。
  preempt なら worker が `Ok` に変えるので recovery にはならず、cleanup の失敗なら接続の理由が `retired …` にならない。
  残る候補は preempt でない普通の失敗で、この修正で recovery にならず Main の再試行へ回る。S5-A の実機の確認は DR-MP-6。

## DR-MP-2 修正：commit した Run の所有を commit の直後に外す（型付きの post-commit hook）

- 方針: 分類は変えない（preempt は従来どおり deferred、本当の失敗は従来どおり recovery の判定へ）。
  変えるのは「commit 済みの Run を permit が所有し続ける」ことだけ。既にある lifecycle の型
  （`MaintenanceCycleControl::mark_run_terminalized` → `MaintenancePermit::mark_run_terminalized`）を、
  失敗の記録と取消の移譲に加えて、成功の終端 transaction の commit の後にも呼ぶ。文字列では判断しない。
- crate（`grimodex-db`）:
  - `restore_rebuild::release_committed_run_ownership(control, run_id)` を足す（hook が無ければ何もしない）。
  - Verify と Rebuild: 成功の終端 transaction が commit した分岐でだけ `success_committed` を立て、
    `execution` が `Ok` のときに hook を呼ぶ。foreground の hold（Run は running のまま）の分岐では立てない。
  - Backfill: 成功の finalize（`transform_result` が `Ok` で foreground の hold でない）の後に hook を呼ぶ。
  - hook の失敗（lifecycle の `InvalidExecutionTransition` など）は cycle の失敗として返す。所有は残るので
    recovery の判定は fail-closed のまま。
- Native と Main は変えない。IPC、N-API、保存範囲、送信先、authority は増えない。
- 試験用の seam: `maintenance_runtime::post_commit_race_for_test`（adapter の commit の後、follow-up discovery の前に
  1 回だけ hook を呼ぶ。`Database` の address で引く。hook は副作用か普通の失敗を返せる）は
  `cfg(any(test, feature = "workspace-maintenance-test-support"))` だけで compile される。この feature は
  grimodex-node の dev-dependency でだけ有効で、N-API の build と release には入らない（DR-JF-4 の seam と同じ形）。

## DR-MP-3 lifecycle の matrix（変わるのは「commit 済みの Run の所有」の行だけ）

| 状況 | crate の返り値 | permit の Run の所有 | finalizer | authority | lifecycle | 通常の DB |
|---|---|---|---|---|---|---|
| 成功（Accepted／Coalesced） | `Ok` | 修正前: 残る／**修正後: 外れる** | `mark_joined`→`release`（変化なし） | 維持 | Ready | 可 |
| preempt（どこでも。cleanup は clean） | `Err(preempt)` か `Ok(accepted)` | 残っても無関係 | worker が `Ok(accepted, preempted)` にし `release`（変化なし） | 維持 | Ready | 可 |
| commit 後の普通の失敗・取消（cleanup は clean） | `Err` | 修正前: 残る／**修正後: 外れる** | 修正前: retire→`transfer_to_recovery`／**修正後: `release`、元の Err を Main へ** | 修正前: retire／**修正後: 維持** | 修正前: RecoveryRequired／**修正後: Ready** | 修正前: 拒否／**修正後: 可** |
| Run の作成後・commit 前の普通の失敗 | `Err` | 失敗の記録が commit したら外れる（従来どおり） | 従来どおり | 従来どおり | 従来どおり | 従来どおり |
| 作成の commit が不明（CreationUnknown）、終端の記録の失敗 | `Err` | 残る | retire→recovery（従来どおり） | retire | RecoveryRequired | 拒否 |
| cleanup の失敗、接続の quarantine | `Err` | 問わない | retire→recovery（従来どおり） | retire | RecoveryRequired | 拒否 |
| foreground の hold（product journey の seam） | `Ok(deferred)` | 残る（running のまま） | 従来どおり | 維持 | Ready | 可 |
| panic／JoinError | — | 問わない | retire→recovery（従来どおり） | retire | RecoveryRequired | 拒否 |

- 上限・liveness: preempt が続く場合の扱い（P-6 の 50 ms ごとの preempt と `BACKLOG_DELAY_MS`=10 による cancel の繰り返し）は
  経路 (a) で、この修正では変えない（backoff は別レーン）。修正後の経路 (c) は Main の既存の有界な再試行
  （delivery の再試行と失敗の受領書）に入る。次の cycle は durable な ledger（completed の Run）から次の phase を決める。
  修正前はこの再試行の前に workspace 全体が recovery の reconcile 待ちになっていた。
- shutdown／workspace 切替との競合: Main の quiesce は取消を出し、Native の `Err(取消)` を受けて attempt の receipt を読む
  （`cancellationRequestedBeforeFailure`）。修正前は recovery の descriptor ができ、`drainRecovery` が後始末していた。
  修正後は descriptor ができず、切替の前の reconcile が空になる。lifecycle の停止（`NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED`）
  で抜けた場合も、Run は completed で所有が無いので通常の release になり、transition の drain を妨げない。
- 信頼境界: 判断の材料は lifecycle の core の所有の表（process-local の型）と、crate の中で commit の成否が分かる分岐だけ。
  renderer や Main の入力、エラーの文字列は使わない。

## DR-MP-4 代替案

- A（採用）: commit 済みの Run の所有を外す（DR-MP-2）。既存の lifecycle の型で閉じ、release の 4 条件の意味を変えない。
- B: commit 後の普通の失敗を preempt と同じく deferred に読み替える。取消やバグの失敗まで requeue になり、Main の有界な
  再試行と失敗の受領書を迂回する。分類を広げるので採らない。
- C: `automatic_maintenance_error_releases_normally` で「所有はあるが Run は DB で completed」を読みに行く。finalizer で
  接続を取る（前景が来ていれば待つか失敗する）ことになり、Join の後の判定が DB の状態に依存する。採らない。
- D（harness 側だけ）: S5-A の variant を `scheduler-disabled-for-launch` で測り開示する。製品の欠陥が残るので単独では採らない。
  修正の後も S5-A が同じ handoff を見るなら、別の経路として調べ直す。

## DR-MP-5 確認の結果（2026-10-28）

- 決定的な再現（`electron/native/grimodex-node/src/lib.rs` の `narrative_maintenance_post_commit_tests`。
  `post_commit_race_for_test` で adapter の commit の直後に事象を入れる）:
  - 修正前（commit ac0cb133）: Verify・Backfill・Verify→Rebuild の commit 後の普通の失敗と、Verify の後の Main の取消の
    4 件が失敗した。どれも次の DB command が `NIR1_MAINTENANCE_CONNECTION_UNUSABLE: retired for exact lifecycle recovery`
    で落ちた（S5-A の Raw の再構築と同じ文言）。commit 後の前景の接続の占有（経路 (b)）は修正前から requeue で通る。
  - 修正後: 5 件とも通る。
  - 変異: Verify・Rebuild・Backfill の各 `release_committed_run_ownership` を 1 つずつ外すと、それぞれ該当の試験が落ちた
    （Verify は 3 件、Rebuild は 1 件、Backfill は 1 件）。foreground の hold の分岐で所有を外す変異を検出する試験は無い
    （hold は product journey の seam だけで、hold の後に普通の失敗が来る経路は試験していない）。
- 検証: `cargo test --lib`（grimodex-node、709 passed）、`cargo test -p grimodex-db --lib narrative_extraction`（1143 passed）、
  `cargo +1.99.0 clippy`（grimodex-node は `--all-targets --features licensing,legacy-keyring-migration`、
  grimodex-db は `-p grimodex-db --all-targets`、どちらも `-D warnings`）、
  `node scripts/quality/nir1-graph-eval/native-architecture.mjs` と その node 試験（26 passed）、
  `vitest --config vitest.electron.config.ts` の `narrativeMaintenance*.test.ts`（139 passed）。rustfmt の差分は増やしていない
  （触った file はもとから rustfmt の差分がある）。実 Electron と product journey は実行していない。

## DR-MP-6 利用者への影響と残る確認

- 影響（推測を含む）:
  - 条件は「自動 maintenance の 1 つの cycle で Run が completed になり、cycle が終わるまでの間（観測では 170〜220 ms）に
    preempt でない失敗か取消が起きる」こと。durable chain が動くのは workspace を開いた後、Semantic Epoch の変化、
    durable wake のときで、cycle は 1 回 0.3〜1 s 程度（観測値）。
  - workspace の切替とアプリの終了: Main の quiesce の取消が窓に当たると起きる（journey の終了で 13 回中 3 回。
    journey は終了の直前まで maintenance が忙しいので、通常の利用ではこれより少ないと推測）。終了では process が終わるので
    実害は小さく、切替では reconcile が 1 回増える。利用者に DB の拒否は見えにくい。
  - 普通に使っている最中（S5-A の型）: 開いた直後に Verify が走り、その直後に何かの失敗が起きると、接続が retire され、
    その時点で走っていた前景の操作（S5-A では Raw の再構築）が失敗し、次の maintenance の cycle が recovery を reconcile するまで
    （#752 の観測では約 1 秒）通常の DB command が拒否される。頻度は失敗の種類が未確定のため見積もれない。
    S5-A の dev では graph-index-unusable の 2 回とも起き、他の variant（oneshot 系など）では起きていない。
- 残る確認:
  - S5-A の handoff の普通の失敗の正体（DR-MP-1 の未確定）。修正版の `.node` で S5-A の dev（graph-index-unusable）を
    もう一度測り、handoff が消えることを確かめる。消えなければ attempt の cleanup の受領書の側（`cleanup_reusable`）を調べる。
    失敗の文言を診断に残す変更は、保存・出力の範囲に触れるのでこの修正には含めない。
  - P-6 の preempt の暴走（経路 (a)、backoff なし）は別レーン。
  - PR の CI: Shared Rust crates（3 OS）、Native の development／release の build と test、Electron product journeys
    （impact map は `narrative-maintenance-product-journeys` と `narrative-runtime` を選ぶ）。c-query-lifecycle は
    impact map が選ばない（query の lifecycle は変えていない）。
