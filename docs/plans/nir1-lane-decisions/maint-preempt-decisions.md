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

## DR-MP-7 独立レビュー（Opus）の指摘への対応（2026-10-28）

- P2-1（commit の後にだけ所有を外す、という不変条件の試験が無い）: crate に試験を足した（Backfill の失敗の先例と同じく、
  hook の中で `(run_id, autocommit, status)` を記録する）。
  - Verify・Rebuild・Backfill の controlled な成功で、hook がちょうど 1 回、`status=completed`・`autocommit=true` で呼ばれる。
  - foreground の hold（Run は running のまま）では 3 つとも hook が呼ばれない（P3-1 の hold の変異も閉じる）。
  - Verify の取消が Run の作成の後に来る場合: Run を閉じられたら、閉じた後（`status≠running`、autocommit）にだけ呼ばれる。
    接続の quarantine で閉じられず deferred の owner に渡したときは呼ばれない。
  - 変異の再実行（`cargo test -p grimodex-db --lib -- restore_rebuild::tests legacy_backfill::tests`）: M1（Verify の解放を
    成功の終端 transaction の前へ）、M3（Verify・Rebuild・Backfill のそれぞれで hold でも解放）、M2a（Verify の制御停止の分岐の
    先頭で解放）が、どれも該当の試験 1 件で落ちた。M2a は、取消で Run を閉じられる場合は段の stop handler が先に Run を閉じて
    いるので観測できず、閉じられない（quarantine）場合の試験で初めて落ちた（足す前は crate と grimodex-node の 709 件をすべて通った）。
- 既存の挙動の所見（この修正の前から。変えていない）: Run の作成の後の取消では、段の stop handler
  （`run_maintenance_graph_phase_for_run`）と adapter の stop handler の両方が `transfer_controlled_maintenance_run_to_owner`
  を呼ぶので、閉じる処理（冪等）と `mark_run_terminalized` が 2 回走る。permit では 2 回目が `InvalidExecutionTransition` に
  なり、返る Err は `NEX_VERIFY_INTERRUPTED_RUN_TERMINALIZE_FAILED` の context を付けた取消になる（所有は 1 回目で外れて
  いるので、finalizer は通常の release を選ぶ）。整理は別の作業とする。
- P3-2（DR-MP-3 の「変わるのは所有の行だけ」の訂正）: `mark_run_terminalized` は `release_project_creation_for_handle` も呼ぶ。
  そのため、その project の作成の予約が外れる時点が、permit の release から「Run の commit の直後」に前へ動く。
  project 単位の破壊的な permit は、その時点から入れる。二重の解放は無い（外した Run は permit の所有の表から消え、
  `complete_execution` は残っている所有の分だけ解放する）。matrix には「project の作成の予約: 修正前は permit の release で解放、
  修正後は commit の直後に解放」の行が加わる。
- P3-3: 修正後の経路 (c) の Err は、その work の Main の再試行回数（`NARRATIVE_MAINTENANCE_MAX_RETRIES`=3、1 s 間隔）を
  消費する。続けて 3 回起きると、完了済みの work に delivery の失敗の受領書が残りうる（まれ。次の cycle は ledger から noop に
  なる）。修正前は同じ場面で workspace 全体が recovery になっていた。
- P3-4: manual の経路（Native の manual maintenance の permit）も同じ adapter を通るので、成功の後に所有が早く外れる。
  成功ならどのみち release するので害は無いが、DR-MP-2 の対象（automatic と manual の両方の permit）に含まれる。

## DR-MP-8 preempt が続く maintenance の project に backoff を入れる（2026-11-11）

DR-MP-3 が「別レーン」とした preempt の連鎖（P-6）と、DR-CP4-L-27 が「製品側の候補（PUB-G の前提）」に回した backoff を受ける lane。
設計の正本は `fusion-eval-data/design-notes/db-connection-2026-11-07/maintenance-starvation-2026-11-11.md` の案 A′（read-only の設計調査。編集・実行なし）。
委任の根拠は DR-MPS-15・16 と同じ読み（integrator の読み。AGENTS.md の NIR-1 の残レーンの worker／owner／lifecycle の技術判断）で、重要な変更
（公開・送信先・保存・閾値の緩和・新しい契約・authority）のどれにも当たらない。難しい判断として read-only の advisor に一度通した。

### 決定

`electron/main/narrativeMaintenance.ts` の scheduler だけで、preempt が続いた project の再試行に backoff を入れる。

- ある project の cycle が foreground に preempt された連続が 3 回までは、今の 10 ms（`NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS`）のまま。
  4 回目の preempt の後からは、既存の `NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS`（1 s）の後に再試行する。
- backoff の間は、その project の work と durable wake を cycle の候補から外す。ほかの project に走れる work があれば、timer は 10 ms のまま（その project は外して走る）。
  backoff の project しか残っていなければ、timer は最も早い `notBefore` に置く。pending か wake が残る限り timer は 1 本だけ張る。
- **数える単位は project（`scopedWakeKey` ＝ binding と projectId）で、project ごとに連続の回数 1 つ**（改訂 1。2026-11-11。最初の版は work key 単位）。
  - Native が `accepted` かつ `preempted === true` を返した cycle は、その cycle が触れた project（batch の work と wake の両方）の回数を 1 増やす。
    受領書が `works=[]`（wake だけの discovery が no-wait の取得で preempt され、何も登録されなかった）でも、受領書が無い・coverage を証明できないときでも数える。
  - 回数を 0 に戻すのは次の 2 つだけ。(1) その cycle の受領書に、その project の **succeeded の work が 1 件以上**ある（進捗。Verify が成功した後の follow-up の discovery が
    preempt された cycle もここに入る）。(2) Native を呼んだ cycle の結果が preempt 以外（成功・error・interrupted の別理由・workspace の変更・deferred など）。
    受領書の `state` では見ない（`works=[]` の succeeded は進捗ではない）。
  - 理由：最初の版は受領書の work key で数えていたので、(a) wake だけで `works=[]` の cycle は「unfinished が空」として回数を消し、この連鎖が backoff に入らなかった
    （Verify 成功後の follow-up discovery の preempt も同じ形）、(b) `*`（受領書なし）と key（受領書あり）が交互に来ると map を作り直して 4 に届かなかった。
    どちらも「preempt された cycle の連続」を 1 つの数に畳めば同時に消える。片方だけ直すともう片方が表に出る。
  - 代償：同じ cycle で別の project の work が成功しても、preempt された project は数える（cycle 単位の `preempted` は project 別ではない）。
    進捗のある project は上の (1) で戻る。follow-up の予算超え（毎回 succeeded の work があり key が進む `preempted:true`）は進捗として数えない（最初の版と同じ結論）。
    最初の版にあった「同じ cycle で別の work が成功しても key の連続は切れない」は、同じ project の別の work が成功すれば戻る（backoff が 1 cycle 後ろにずれる）に変わった。
  - not-admitted と delivery の capacity は回数を動かさない（結果が preempt かどうか分からない）。not-admitted は 10 ms 後、capacity は 1 s 後の exact replay（回数に入れない）で再試行する。
    `begin` が失敗して Native を呼ばなかった cycle（`nativeCallStarted=false`）も動かさない。
- preempt の判定は `interruptedCycle` ではなく、Native の結果が `accepted` かつ `preempted === true` のとき。`interruptedCycle` は quiesce・dispose・stop-requested でも立つ。
- 時計は `Date.now()`。`notBefore` は記録時の `now + 1 s`。読むときに `notBefore - now` が 1 s を超えていたら（時計が戻った）`now + 1 s` に置き直す。
  置き直しだけが「長く止まらない」を保つ（最初の版の clamp は 1 回の待ちを縛るだけで、戻った分だけ全部が backoff の早期 return から 1 s で張り直し続けた）。
  上限：1 s を超える逆行は約 2 s 以内に再開する。1 s 以内の逆行は検出できず、戻った分（< 1 s）だけ余分に待つ。`performance.now()`（単調時計）は採らない
  （vitest の fake timer が `performance` を進めるかに試験が依存し、逆行の早期 return の試験も書きにくい。1 s の backoff には置き直しで足りる）。

### 理由（starvation の事実）

product journey `nir1-scene-scope-projection-acceptance` の `settleFeed`（60 s）が揺れて落ちる件（ci 42816284264、Full 42894003764）。診断 DB の
`narrative_extraction_runs` では、dependency-verify の連続区間が約 61 s、Verify の Run が 219〜221 回（cancelled 216〜218。約 218 回の preempt）、
Run の寿命が区間の 92.2% を占め、Run の間の中央値は 21 ms。その区間内の freshness-evaluation の Run は 0 件だった。
maintenance の slot は 1 つで、freshness も同じ `begin_maintenance` を使う。奪い手（harness の poll と renderer の `externalWriteFeed` の 750 ms の poll）が foreground として
取るたびに Verify が preempt され、Main が 10 ms 後に次の cycle を出して slot を塞ぐ。freshness の 1 s ごとの試行が通る確率は 1 回あたり数 %。
admit されれば freshness は 1〜7 ms で完了するので、slot を空ければ通る。

### 変わる点

- preempt が 4 回続いた project の maintenance の試行が、約 4 回/s から約 0.8 回/s になる（freshness が通る隙間ができる）。
- **Verify などの完了までの期待時間は、foreground の preempt が続く間、最大で約 5 倍に延びうる**（試行あたりの成功率が同じなら、試行が約 4 回/s から約 0.8 回/s に減る分。
  最初の版の「再開が約 1 s 遅れる」は foreground が止まった後の話で、preempt が続く間の話ではなかった）。大きい DB の Verify は #843 の後も 1 回の走査が 10 s を超え、
  取り消されると最初からやり直す（DR-MPS-16 の別 lane）ので、この延びは大きい DB で効く。A/B の主指標に入れる（下の「A/B の gate」）。
- Graph の Index build の wake（DR-BSEAM-1。`requestGraphIndexBuildWakesWithBinding`）も、その project が backoff の間は最大 1 s 遅れる。
- ほかの project の maintenance は、backoff の project を待たずに 10 ms で走れる。
- Verify の cancel と cancelled の Run の増え方が同じ割合で減る。

### 変わらない点

- foreground の優先（db `lib.rs` の no-wait の PREEMPTED と waiter の handoff。I1）、slot の数（I2）、preempt の分類（DR-MP-1〜3。I3）。
- freshness の scheduler と定数（`narrativeFreshness.ts`。DR-JF-3）、coordinator の再発見（`narrativeMaintenanceTriggers.ts`。DR-MPS-2）。再発見は scheduler の候補の除外を通るので backoff を迂回しない。
- IPC、N-API、Rust、renderer、保存、DB。requeue・受領書・delivery の retire の判定。`NARRATIVE_MAINTENANCE_MAX_RETRIES`（preempt は retry を消費しない。回数は別の map）。
- 再試行が `deliveryRetry`（exact replay）と `terminalReceiptFailure` の recovery pump のときは backoff を見ない。
- Verify の正しさ（Verify は run 単位でやり直す。遅らせるだけ）。

### 信頼境界

Main process の中の scheduler の内部状態だけ。新しい入力・送信先・保存・権限・契約はない。renderer／preload／IPC の入力は backoff の回数や時刻に影響しない
（回数は Native の結果と受領書だけから決まり、時刻は Main の `Date.now()`）。試験用の注入 `preemptBackoffAfter`（閾値）は Main の constructor の option だけで、IPC・renderer からは届かない（製品の呼び出し側 `narrativeMaintenanceBootstrap.ts` は渡さない）。

### GDX-PRECHECK-001 の owner／lifecycle の表

| 経路・状態 | 修正前 | 修正後 |
|---|---|---|
| preempt の連続が 3 回以下 | 10 ms で再投入 | 同じ |
| 同じ project の preempt の連続が 3 回を超える（4 回目の preempt の後） | 10 ms で再投入 | project を 1 s 候補から外す。timer は最も早い `notBefore`（他に走れる project があれば 10 ms） |
| 別 project の work の enqueue・wake（backoff の待ち中） | `timer` があれば何もしない | backoff の timer なら 10 ms に縮める。同じ project の再 enqueue は縮めない |
| 成功・preempt 以外の結果（error・別理由の interrupted・workspace の変更・deferred） | retry の規則どおり | 回数を戻す（retry の規則は変えない） |
| not-admitted・delivery の capacity | not-admitted は 10 ms、capacity は 1 s 後の exact replay | 同じ。回数は動かさない |
| binding の変更 | 新しい key | 回数も別 scope（引き継がない）。quiesce・dispose は map を空にし、rebind は元の binding の scope だけ消す |
| dispose・quiesce・workspace の切替 | timer と queue を片付ける | 同じ＋回数の map を空にする。timer は既存の `clearTimer` と `schedule()` の guard（disposed／quiescing）が消す |
| delivery の再試行（`retryableDelivery`、exact replay） | 既存の規則 | backoff を見ない（floor 0）。回数にも入れない |
| 受領書なし・coverage 不明（`null`）・`works=[]` | 既存 | 数える（project 単位の回数 +1。unfinished が空でも数える） |
| preempt なのに unfinished が空（受領書が succeeded の work だけ・wake だけの cycle） | 既存 | succeeded の work がある project は戻す、無ければ数える |
| `begin` が失敗した（`nativeCallStarted=false`） | 既存（retry の規則） | 回数を動かさない |
| attempt guard の無い経路の preempt（Native `lib.rs:7628` の `NEX_MAINTENANCE_CONNECTION_PREEMPTED`。rejection で届く） | error の retry（1 s・retry を消費） | 同じ。preempt 以外の結果として回数を戻す（数えない。すでに 1 s 待つ） |
| 時計が戻る（`notBefore - now` が 1 s 超） | － | `now + 1 s` に置き直す（約 2 s 以内に再開） |
| `terminalReceiptFailure` の recovery pump | 既存 | backoff を見ない |

有限性：回数の map は project×binding ごとに高々 1 項目（整数 2 つ）で、quiesce・dispose で空になり、rebind は元の binding の分を消す。timer は常に高々 1 本（`schedule` が既存の timer を置き換える）。
60 s の常時 preempt でも cycle の数は `3 + ⌈60 / 1⌉` 程度に有界（試験で下限と上限を固定）。

### 新しい定数

回数 3（`NARRATIVE_MAINTENANCE_PREEMPT_BACKOFF_AFTER`）だけ。遅延は既存の 1 s を使い、新しい時間の値は作らない。
K1b の 5 項目：値＝3（単位は回数）、検査する位置＝Main scheduler の cycle の終わり（preempt の判定の直後）、超えたときの結果＝その project を 1 s 候補から外す（失敗にも停止にもしない）、
実測の条件＝上の starvation の記録（約 218 回/分の preempt、Verify の p50 244 ms）と、PR 本文に書く試験の結果。
既存の閾値（確認台帳の現行閾値、Gold、retry の上限 3 回、DR-MPS-2 の cooldown）の緩和ではない。

### 試験と限界

- 新しい `electron/main/narrativeMaintenance.preemptBackoff.test.ts`（Main の vitest。fake timer）。製品が通る「binding・begin・cancel（受領書）→ throw → catch → selective requeue」を模型にした
  `lifecycleBackend` で、次を通す。
  - 2 つの scheduler の模型：maintenance の偽は slot を 240 ms 持って `accepted+preempted` を返し（周期 250 ms）、freshness の偽は 1 s の周期（初回を slot の占有の中に置く）で slot が使用中なら `null`。
    **対照**：閾値を `Infinity` にする注入（`preemptBackoffAfter`）では 60 s で freshness の Run が 0 件、既定では backoff の後 2 tick 以内に 1 件。freshness の試行の回数も数え、0 件が「試行していない」せいでないことを示す。
  - 境界（999／1000 ms）、別 project の割り込みと元の `notBefore` での再開、回数の戻し（成功・preempt 以外・binding の変更・dispose／quiesce）、受領書あり／なしの数え方、60 s の cycle 数の上限と下限。
  - 製品の経路：全部が backoff の間の早期 return、時計の巻き戻し（1.5 s 戻しは約 2 s 以内に再開、0.5 s 戻しは早期 return で残りだけ待つ、進む向きの跳び）、rebind（別 binding の回数は残る）、
    not-admitted・capacity が回数を増やしも戻しもしないこと（時刻の列で固定）、`begin` の失敗、wake だけで受領書が `works=[]` の cycle、work の受領書と空の受領書の交互、Verify 成功後の follow-up discovery の preempt。
  - 変異で赤くなることを確認した：時計の置き直しを clamp だけに戻す（1 件）、rebind が全 scope を消す（1 件）、進捗の判定を崩す（19 件）。
- 限界：Main の模型であり、実機の位相は揺れる（実機では確率的）。模型は最悪の位相を決定的に作る。編集 trace（`index-unavailable`、`graph-late`）と a2 型の Gold への影響、
  journey の restore の後の settle の待ち時間は、この試験では測れない（DR-MPS-16 の教訓から、Verify と Rebuild の開始が最大 1 s 遅れる）。dev の A/B で測った（下の「dev の A/B の結果」）。
  wake だけの cycle で Native が実際に返す受領書の `works`（空か）は Main の試験では確かめられず、模型は「空」と「work あり」の両方を通した（Native 側の実際の形は未確認）。
  この PR の試験では journey と実機（Xvfb）、cargo は走らせていない（実機は dev の A/B で走らせた）。

### やらないこと

- C（一定時間譲り続けた maintenance が foreground と同等に取る）：I1 を破る新しい契約で、ユーザーの確認が要る。
- B1（lifecycle core の admission での公平性）・B3（freshness の NotAdmitted を deferred にする）：別 lane。B3 は A′ の A/B で裾が残ったときだけ。
- E（周期の foreground の読みが譲る。renderer の IPC の引数が増える）：別 lane。
- F（Verify の再開可能化）：別 lane（DR-MPS-16 の別 lane。大きい DB の Verify が終わらない問題はこの修正では直らない）。
- D（harness の poll の変更）：単独では採らない。

### DR-CP4-L-27 との関係と、ユーザーの判断

L-27 の「製品側の候補」（連続 N 回目以降は 10 ms でなく `ERROR_RETRY_DELAY` 相当）を実装する lane が、この DR-MP-8。PUB-G の前提 lane の 1 つにあたる。
製品の挙動が変わるので、CP-4 の候補と受領書は旧候補に束縛されたまま。**新しい候補での CP-4 の正式な測り直しをするかどうかは、ユーザーの判断として残す**（この lane では走らせない）。

### 前の決定との関係（改訂 1。2026-11-11）

- **DR-CP4-S6-4 の (4)**（`cp4-decisions.md`）は、製品の連鎖（L-27 の続き）の別 lane で「(c) 維持の連続 preempt の backoff と (f) Related Scenes の reconciler の no-wait 化を設計し、
  dev の A/B（基準／(c)／(c)+(f)）まで進める」と決めた。主指標は Verify の完了時刻と、sample ごとの registration-unavailable／driftAtQuery。この DR-MP-8 は、その (c) を実装する lane にあたる。
- **DR-MPS-15 の判断 5**（`maint-precutover-stall-decisions.md` :315、代替案 :340）は「(c) は単独では採らない」（Related Scenes の周期処理が 4＋4 回/s で来続ける限り効かないと実測から読んだ）。
- **(f) と (f2) の照合（両方を読んだ結果）**：S6-4 の (f)「reconciler の no-wait 化」は、DR-MPS-15 の判断 1 の (b)「reconciler の timer 由来の tick の `current_operation` を waiter を立てない try 取得にする」
  に**当たる**（contracts 枝の `results.md` §3-3・§5 が、build の polling も要るので (f) を (f2) に改めた、と記録している）。DR-MPS-15 はこれに (a) build の loop の tick の try 取得を足したので、(f) より広い。
  したがって今の master は (f)（正確には (f2)）の腕で、**A′ は (c)+(f) の腕**。「(c) を単独では採らない」には当たらない（(c) は (f2) の上に載り、単独の変更ではない）。
- ただし目的が別：DR-MPS-15 が測った「(c) は不要だった」（`results.md` §6）は Verify の完了の話で、奪い手は Related Scenes の周期処理だった。A′ が守るのは freshness が slot を取れること
  （飢える側が freshness、奪い手が harness の poll と renderer の `externalWriteFeed` の poll）で、(f2) の後でも残る。
- S6-4 の三腕のうち「基準」（#843 の前）と「(c) 単独」は、#843 の revert なしには作れない。A/B は master（(f2)）と A′（(c)+(f2)）の 2 腕で足りる。#843 の前（`4594820d` の親）を足すのは任意。

### A/B の gate と止める線（測る前に書く。2026-11-11）

- **A/B は 2026-11-11 に実施した**（結果は下の「dev の A/B の結果」。この節の線は測る前に書いたまま変えていない）。この PR の試験は Main の模型だけ。**A/B を merge の gate にする**（S6-4 の (4) が (c) を「dev の A/B まで進める」と決めたため）。
  CP-4 の正式の測り直しは別（ユーザーの判断。dev の結果は判定に数えない）。
- 主指標：(1) restore の後の Verify の完了時刻（a2 型の Gold。watcher の `verify` が completed になるまで）、(2) Graph arm の sample ごとの registration-unavailable／driftAtQuery（35 sample）、
  (3) 編集 trace（dev-lantern の `base`、100 サイクル×5 本）の `index-unavailable`／`graph-late`／registration-unavailable、(4) journey の restore の後の settle の待ち時間の分布（p50／p95／最大。
  journey の harness は別で、この A/B の harness では測れない）、(5) freshness-evaluation の Run が Verify の区間に入ること（動機の指標）。
- 基準（master。DR-MPS-15・16 の実測。n が小さい）：Verify は a2 型 3 回とも約 4 s、Graph arm は `limit` 35／35・slot empty（registration-unavailable 0／105）、
  編集 trace は `index-unavailable` 0／505・`graph-late` 2／505・registration-unavailable 1／505。
- **止める線の案（dev の A/B の線。判定の物差しではない。測る前の案で、値は根拠とともに置く）**：次のどれかで merge を止める。
  - a2 型の Gold で、V-10 停止または slot の Suspended が 1 回でも出る（基準は 0／3。n＝3 では中央値より 1 回の失敗を重く見る）。
  - Verify の完了時刻の中央値が基準の 1.5 倍（約 6 s）を超える。根拠：#843 の後は foreground の preempt が開始から約 15 s（22〜31 回）で止むので、A′ が効くのは 4 回目の後の 1 回ほどで、
    Verify の延びは約 1 s（約 25%）の見込み。1.5 倍はそれを許し、最悪の約 5 倍を検出する。
  - Graph arm の registration-unavailable が基準（0／105）より増える。driftAtQuery が基準より増える。
  - 編集 trace の `index-unavailable` が 505 件に 1 件でも出たら本数を足し、2 件（0.4%）以上で止める（既存の物差し 1% を超える手前。DR-MPS-16 の「1 件でも出れば本数を足す」と同じ運用）。
    `graph-late`・registration-unavailable は基準（2／505、1／505）の 2 倍を超えたら止める。
  - journey の restore の後の settle の待ち時間：基準の p50 または p95 の 1.5 倍を超える、または最大が `settleFeed` の 60 s に届く（基準の取り直しが要る）。
- A′ が悪化させる向きを見るための指標であり、改善（freshness の Run が増えること）を測る側は上の (5)。

### 委任（改訂 1）

この lane を「U3 の委任の範囲内」とは断じない。DR-CP4-S6-4 の (4) と同じく、委任の対象レーン（継続計画 §3.1）に維持の coordinator は列挙されておらず、DR-MPS・DR-MP は integrator の読みである。
記録は「DR-MPS と同じ読み＋重要な変更（公開・送信先・保存・閾値・不可逆）のどれにも当たらない」。閾値（回数 3）は新設で、既存の閾値（確認台帳の現行閾値・Gold・retry の上限）の緩和ではない。

### 独立レビュー（Opus、read-only）の指摘への対応（改訂 1。2026-11-11）

- **P1（時計の巻き戻しで止まる）**：`notBefore` を現在の時計へ置き直す（決定の「時計」）。逆行の試験を 3 つ足した。clamp だけの版は 1.5 s の逆行で 2 s 以内に再開できず、試験が赤くなる。
- **P2-a・P3（wake だけの cycle、`*` と受領書の交互）**：数える単位を project 単位の連続の回数 1 つにし、戻すのは「進捗（succeeded の work）」と「preempt 以外の結果」だけにした（決定の「数える単位」）。
- **P2-b（試験が製品の経路を通っていない）**：`lifecycleBackend` で製品の経路を通し、全部 backoff の早期 return・時計・rebind・not-admitted／capacity／begin 失敗・wake だけの cycle の 5 件以上と、閾値 `Infinity` の対照を足した。
- **P2-c（DR の記述）**：Verify の完了の延び（約 5 倍）、前の決定との関係、(f)／(f2) の照合、A/B の未実施と gate、止める線、委任を上に書いた。
- **P3 の個別の扱い**：rebind は元の binding の分だけ消すようにした（対応）。attempt guard の無い経路の preempt（rejection で届く）は数えない（すでに error の retry で 1 s 待ち、lifecycle が有効な製品の経路では attempt guard がある）。
  batch の中で not-started のまま並ぶ後ろの work と、別の scheduler が project を握る場合は、回数（project 単位）にも backoff の判定にも影響しないので対応しない。

### dev の A/B の結果（2026-11-11。dev 専用・判定に数えない）

- 腕：M＝master `8a7f4ceb`（#853）、A＝`8a1bb521`（この枝の改訂 1）。差分は `electron/main/narrativeMaintenance.ts` だけ。定義と止める線は測る前に固定した
  （`fusion-eval-data/design-notes/db-connection-2026-11-07/maint-backoff-ab-2026-11-11/definitions.md`。結果は同じ場所の `results.md`、生データは `raw/`）。
- **止める線には、どれも当たらなかった**（事実）。

| 段 | M | A | 線 |
|---|---|---|---|
| a2 型の Gold（各 3 回）：V-10 停止・slot Suspended | 0／3 | 0／3 | 1 回でも出たら停止 |
| 同：Verify の完了（最初の DB tick から、1 s tick） | 3／4／4 s（中央値 4） | 5／8／4 s（中央値 5） | 中央値 6 s 超で停止 |
| 同：registration-unavailable／driftAtQuery | 0／105、0 | 0／105、0 | 基準より増えたら停止 |
| 編集 trace（dev-lantern `base`、各 5 本）：index-unavailable | 0／505 | 0／505 | 1 件で本数を足す、2 件で停止 |
| 同：graph-late／registration-unavailable | 1／505、0／505 | 2／505、0／505 | 基準（2／505、1／505）の 2 倍超で停止 |
| journey の restore の後の settle（各 10 本）：p50／p95＝最大 | 2.95／5.48 s | 1.63／4.69 s | 1.5 倍超、または最大 60 s で停止 |

- Gold の間の maintenance の cancel の増分は M ＋9〜＋11、A ＋1〜＋5（backoff が動いた間接の証拠）。Verify は A で約 1 s 長い向きで、DR の予測（約 1 s）と同じ向き。ただし n＝3・1 s の精度で、有意とは言えない。
- journey は A の settle が短い向き（並べ替え検定 p≈0.007）だが、対の中で常に M→A の順に流したので順序の効果と分けられない。「悪化させていない」までにとどめる。
- 限界（事実）：a2 型の cold DB は 8 回の setup で 1 つしか得られず、その写しを両腕で 3 回ずつ使った。freshness の Run が Verify の区間に入る動機の指標は、この Gold では両腕とも 0 で観測できなかった。
  journey で「3 回連続の preempt」に届いたかは未確認。編集 trace は小さい fixture で、0／505 の検出力は小さい（95% の上限は約 0.6%）。CI で見えた長い settle（数十秒）は、この局所環境では M でも再現しなかった。
- 運用の逸脱（事実）：origin/master が `adaf28b8` に進み build の祖先の検査が通らないため、`git clone --shared` の clone の中でだけ origin/master を `8a7f4ceb` に置いて worktree を作った（本体の ref は触っていない）。
  journey の harness の FAIL 13／20 本は Main の stderr の `atspi-WARNING` の誤判定で arm と無関係。settle は実測値を使った（`definitions.md` 追記 1。1 組目の値を見た後の追記）。
- 判断（当初）：線に当たらないので merge へ進める。→ 下の「ci.yml の c2-zc journey の失敗」で **merge を止めた**。新しい候補での CP-4 の正式な測り直しは、上のとおりユーザーの判断として残す。

### ci.yml の c2-zc journey の失敗と、merge の停止（2026-11-11）

- 事実：PR #859 の ci.yml run 42972611053（head `5ae14983`）で、product journey `c2-zc-canonical-authority-cutover` が `C2-ZC canonical restore lifecycle settlement`（60 s）で timeout した。落ちた job だけの取り直しは成功。この journey は最近の他の run では落ちていない。
- 事実（診断 DB）：落ちたのは Run の順の assert（`assertC2ZcRestoreLifecycleOrder`、`electron/scripts/c2zc-canonical-product-journey.mjs`）。restore の後の delta が「idle Freshness→Verify→Rebuild→Verify」で、許される「Verify→Rebuild→Verify→Freshness」「Verify→idle Freshness→Rebuild→Verify」のどちらでもない。
  Run は 06:37:31.273 の後に増えず、待てば満たされる状態ではなかった（順が確定して壊れた）。
- 時系列（06:37 台の秒）：Verify #1 30.098–30.113 cancelled、#2 30.121–30.139 cancelled、#3 30.145–31.174 cancelled（いずれも `NEX_MAINTENANCE_CONNECTION_PREEMPTED`）、idle Freshness 31.047–31.049 completed、Verify #4 31.182 completed、Rebuild 31.224、Verify #5 31.239–31.273 completed。
  #1・#2 の cancel は次の cycle の約 8 ms 前に記録されていて、#3 の後の次の cycle までに約 1 s の空白がある。
- 推測：1 s の空白は A′ の backoff（`ERROR_RETRY_DELAY_MS`）と合う。cancelled の Run は 3 本で、4 回目は Run を作らない preempt（wake だけの cycle）なら説明がつく（直接の記録は無い）。
  master にもある 1 s の経路（attempt guard の無い preempt の error の retry）の可能性は排除しきれない。ただし帰属にかかわらず、A′ は「preempt が続く Verify の間に Freshness を通す」設計なので、restore の直後に preempt が 4 回続けば、この順は設計上起こりうる（構造的な衝突）。
- A/B の欠落：dev の A/B は、この journey も restore の後の Run の順も見ていなかった。
- 判断：取り直しは緑だが、確率的な赤を master に入れるので merge しない。PR は Draft に戻した。直し方（journey の順を広げる、A′ を条件付きにする、A′ を止めて B3／D から選び直す）は、受入れの assert か A′ の目的に触れるので、ユーザーに確認する。
  `narrativeMaintenance.ts` を変える場合は `8a1bb521` の A/B は gate として失効し、取り直す A/B では c2-zc の Run の順を止める線に足す。
- 付記：同じ run の Electron runtime performance の赤は 2026-11-10 に master（ci 42820712160）でも出ていて、取り直しで緑。
- 決定（2026-11-11、ユーザーの指示で Fable に相談）：A′ は変えず、journey の順の検査を idle checkpoint に限り広げる（DR-MP-9、#861 で merge、master `58df4e59`）。#859 は master を取り込んだうえで、
  c2-zc の journey を master と A′ で各 20 本流し、Run の順と終状態（marker の時刻、Generic の publisher、cursor）を run ごとに記録してから merge する（merge の gate）。`narrativeMaintenance.ts` は変えないので、`8a1bb521` の A/B は失効しない。

### c2-zc の journey の 20 本の結果（2026-11-11。dev 専用・判定に数えない）

- 腕：M＝master `58df4e59`、A＝この枝 `143031cf`（`58df4e59` の merge）。build receipt の Electron main の sha256 は両腕で違い、A の `main.cjs` にだけ A′ の識別子がある。
  止める線（A に M に無い種類の失敗が 1 本、A の失敗が M より 2 本多い、終状態の異常）は測る前に `definitions.md` に書いた。
- **止める線には当たらなかった。** journey 本体の失敗・timeout は M 0／20、A 0／20。
  harness の FAIL 16／20 本（両腕同数）は Main の stderr の `atspi-WARNING` の誤判定で、全本が restart-persistence の phase まで進み、rendererErrorCount は 0。
- 終状態：marker が全 Run の後、Generic の publisher が Rebuild、cursor が ack 済み、dependency-repair の Run が無い、を両腕とも 20／20 本で満たした（判定点は open 段の settle）。
- open 段の核は全本で Verify→Rebuild→確認 Verify。idle checkpoint が delta の最後でない run は A で 2／20（A-9、A-15）、M で 0／20。
  この 2 本は DR-MP-9 の検査の下で通った。どちらも最後の cancelled の Verify（約 1 s）の間に idle が作られて完了している。A′ による候補外しと合うが、A′ の発動を直接示すログは無い。頻度の差は n が小さく断定しない。
- cancelled の Verify（open 段まで）は M が合計 30（最大 4）、A が 33（最大 3）。この n では増減を言えない。所要時間の中央値は M 26.1 s、A 26.4 s。
- 条件：`CI=true`、Node 22、receipt から MCP の 1 件を除いた写しを渡した（candidate と sha は prepare の値のまま）。watcher（250 ms の read-only reader）の影響は測っていない（両腕同じ）。
- 判断：merge の gate を満たしたので、#859 を merge に進める。
- 生データ：`fusion-eval-data/design-notes/db-connection-2026-11-07/maint-backoff-c2zc-20-2026-11-11/`（`definitions.md`、`results.md`、`run-table.md`、`raw/`）。

## DR-MP-9 C2-ZC の journey の Run の順で、idle checkpoint の位置を問わない（2026-11-11）

- きっかけ: PR #859（DR-MP-8、maintenance の preempt の backoff）の ci.yml run 42972611053 で、
  `c2-zc-canonical-authority-cutover` の journey が、Run の順の検査 `assertC2ZcRestoreLifecycleOrder`
  （`electron/scripts/c2zc-canonical-product-journey.mjs`）の strict の枝で落ちた。観測した delta は
  「idle Freshness → Verify → Rebuild → Verify」。今の検査が許す順は「Verify → Rebuild → 確認 Verify → Freshness」と、
  #600 で足した「Verify → idle Freshness → Rebuild → 確認 Verify」の 2 つだけだった。
  落ちた run の診断 DB の `narrative_extraction_runs` では、idle checkpoint（`fromSequenceExclusive = throughSequenceInclusive = 3`、
  outcome の `kind = current-epoch-idle-checkpoint`）が、preempt された Verify 3 件（`NEX_MAINTENANCE_CONNECTION_PREEMPTED`。
  検査が数えない）の間に commit され、その後に Verify → Rebuild → 確認 Verify が続いていた。
- 根拠（この順は製品の不変条件ではない。製品コードは変えていない）:
  - Rust の `select_idle_checkpoint_project`（`incremental_freshness.rs`）は、Verify が済んだことを条件にしない。
    idle checkpoint は feed の head に cursor が追いついた project に scheduler が打つだけの Freshness の Run で、
    Verify・Rebuild の queue が流れている間にも commit されうる。
  - cutover の readiness（`c2z_preparation.rs`）が見るのは、backfill → Rebuild → Verify だけ。idle checkpoint は見ない。
  - [narrative-c2zc-canonical-cutover-impact-matrix.md](../narrative-c2zc-canonical-cutover-impact-matrix.md) の C2ZC-P11 は、
    idle checkpoint を cutover の証拠でも Generic の publisher でもないとしている（`isC2ZcGenericFreshnessProducer` も
    idle を producer に数えない）。
  - #600 も同じ理由で、idle を Rebuild の前の枠に 1 つだけ許す拡張を一度している。今回はその枠を一般化するだけ。
- 承認（2026-11-11、ユーザー）: 「C2-ZC の journey の Run の順の検査で、idle checkpoint に限り位置を問わないことにします。
  Verify→Rebuild→確認 Verify の順、E1 への束縛、coverage、idle でない Freshness は最後だけ、marker は全 Run の後、は残します。」
  この文言の外には広げない。
- 残す検査（どれも変えない）:
  - 数える Run はちょうど 4 件（Verify／Rebuild／確認 Verify と Freshness 1 件）。全件 completed。
  - Verify → Rebuild → 確認 Verify の順（idle を取り除いた 3 件で見る）。first と confirmation が別の Run。
  - idle でない Freshness は最後の 1 件だけ。先頭・途中に来る順は拒否のまま。
  - Run の timestamp（`createdAt ≤ startedAt ≤ completedAt`、前の Run の `completedAt` ≤ 次の `createdAt`）。位置を問わないのは種類の順だけで、
    Run 同士の重なりは今までどおり拒否する。
  - 全 Run の E1（restore／current Semantic Epoch）への束縛、first／confirmation Verify の report と coverage と Semantic Index の 0 件、
    fixture の Application gap、`expectedRestoreLifecycle`、Rust の Verify outcome との一致。
  - marker は全 Run の最後の完了より後（`marker must be strictly after Freshness completion`。最後の Run が idle のときも同じ）。
- 変わる点: 受入れが受け付ける順が増える。idle checkpoint が、先頭、Verify と Rebuild の間、Rebuild と確認 Verify の間、最後のどこに
  あってもよい。idle でない Freshness が Verify／Rebuild より前に来る順は、拒否のまま。
- 変えない点: 製品コード、fixture、digest（fixture の manifest と、Run の projection の key は触らない）、非 strict の枝。
  非 strict の枝（`expectedRestoreLifecycle` も marker も無いときの寛い検査）は journey からは呼ばれない（journey は常に strict）ので、
  範囲外とし、変えない（承認の文言も strict の検査についてのもの）。
- 試験（`scripts/c2zc-product-journeys.test.mjs`）:
  - 受理: idle が先頭、Verify と Rebuild の間、Rebuild と確認 Verify の間、最後（既存の 1 件〔Rebuild の前〕も残す）。
  - 拒否: idle でない Freshness が先頭・途中、Verify → Rebuild → 確認 Verify の順の崩れ（idle の位置ごと）、Freshness が 2 件、
    marker が Run の前や最後の Run の完了と同時、timestamp の重なり、E1 の束縛違い、coverage 違い。
  - 既存の試験は変えずにすべて通る。落ちた run の診断 DB の Run の列で、広げた検査が受理することを、オフラインの一回きりで確かめた
    （fixture や試験には DB を入れていない）。
- 限界: これは受入れの検査を実機の観測に合わせるだけで、idle の位置が変わった理由（preempt された Verify の再試行の間に
  scheduler の idle checkpoint が先に commit された）を直すものではない。A′（DR-MP-8）が元の 60 s の settle を直すかは、
  実機では未確認のまま。journey が緑になることは、A′ の効果の証拠ではない。
