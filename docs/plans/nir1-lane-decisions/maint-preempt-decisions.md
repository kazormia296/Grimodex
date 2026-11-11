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

- ある work key が preempt された続きの cycle の連続が 3 回までは、今の 10 ms（`NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS`）のまま。
  4 回目の preempt の後からは、既存の `NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS`（1 s）の後に再試行する。
- backoff の間は、その project の work と durable wake を cycle の候補から外す。ほかの project に走れる work があれば、timer は 10 ms のまま（その project は外して走る）。
  backoff の project しか残っていなければ、timer は最も早い `notBefore` に置く。pending か wake が残る限り timer は 1 本だけ張る。
- 回数は次のとき 0 に戻す：その key の成功、preempt 以外の結果（error・interrupted の別理由・workspace の変更など）、binding の変更（key が別になる）、
  quiesce、dispose。not-admitted と delivery の capacity は回数を動かさない（すでに 1 s 待つ。結果が preempt かどうか分からない）。
- 数える単位は受領書の work key。`interruptedMaintenanceWorkToRequeue` が返す interrupted／not-started の canonical な key が、cycle をまたいで同じなら数える。
  同じ cycle で別の work が成功しても、interrupted の key の連続は切れない。follow-up の予算超え（`preempted:true` でも key が毎回進む）は同じ key の繰り返しにならず、4 に届かない。
  受領書がない、または `null`（coverage を証明できない）のときは project 単位（key は `*`）で数える。
- backoff を掛ける単位は project（`scopedWakeKey` ＝ binding と projectId）。preempt の続きは project の durable wake で戻るため。
- preempt の判定は `interruptedCycle` ではなく、Native の結果が `accepted` かつ `preempted === true` のとき。`interruptedCycle` は quiesce・dispose・stop-requested でも立つ。
- 時計は `Date.now()`。残りの待ちは 0〜1 s に clamp し、時計の逆行で長く止まらないようにする。

### 理由（starvation の事実）

product journey `nir1-scene-scope-projection-acceptance` の `settleFeed`（60 s）が揺れて落ちる件（ci 42816284264、Full 42894003764）。診断 DB の
`narrative_extraction_runs` では、dependency-verify の連続区間が約 61 s、Verify の Run が 219〜221 回（cancelled 216〜218。約 218 回の preempt）、
Run の寿命が区間の 92.2% を占め、Run の間の中央値は 21 ms。その区間内の freshness-evaluation の Run は 0 件だった。
maintenance の slot は 1 つで、freshness も同じ `begin_maintenance` を使う。奪い手（harness の poll と renderer の `externalWriteFeed` の 750 ms の poll）が foreground として
取るたびに Verify が preempt され、Main が 10 ms 後に次の cycle を出して slot を塞ぐ。freshness の 1 s ごとの試行が通る確率は 1 回あたり数 %。
admit されれば freshness は 1〜7 ms で完了するので、slot を空ければ通る。

### 変わる点

- preempt が 4 回続いた project の maintenance の試行が、約 4 回/s から約 0.8 回/s になる（freshness が通る隙間ができる）。
- Verify などの再開が最大で約 1 s 遅れる（preempt が 3 回を超えて続いた後、foreground が止まってから）。
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
（回数は Native の結果と受領書だけから決まり、時刻は Main の `Date.now()`）。

### GDX-PRECHECK-001 の owner／lifecycle の表

| 経路・状態 | 修正前 | 修正後 |
|---|---|---|
| preempt の連続が 3 回以下 | 10 ms で再投入 | 同じ |
| 同じ key の連続が 3 回を超える（4 回目の preempt の後） | 10 ms で再投入 | project を 1 s 候補から外す。timer は最も早い `notBefore`（他に走れる project があれば 10 ms） |
| 別 project の work の enqueue・wake（backoff の待ち中） | `timer` があれば何もしない | backoff の timer なら 10 ms に縮める。同じ project の再 enqueue は縮めない |
| 成功・preempt 以外の結果（error・別理由の interrupted・workspace の変更・deferred） | retry の規則どおり | 回数を戻す（retry の規則は変えない） |
| not-admitted・delivery の capacity | 1 s 待つ | 同じ。回数は動かさない |
| binding の変更 | 新しい key | 回数も別 key（引き継がない）。rebind・quiesce で map を空にする |
| dispose・quiesce・workspace の切替 | timer と queue を片付ける | 同じ＋回数の map を空にする。timer は既存の `clearTimer` と `schedule()` の guard（disposed／quiescing）が消す |
| delivery の再試行（`retryableDelivery`、exact replay） | 既存の規則 | backoff を見ない（floor 0）。回数にも入れない |
| 受領書なし・coverage 不明（`null`） | 既存 | project 単位（key `*`）で数える |
| `terminalReceiptFailure` の recovery pump | 既存 | backoff を見ない |

有限性：回数の map は project×binding ごとに高々 1 項目で、quiesce・rebind・dispose で空になる。timer は常に高々 1 本（`schedule` が既存の timer を置き換える）。
60 s の常時 preempt でも cycle の数は `3 + ⌈60 / 1⌉` 程度に有界（試験で下限と上限を固定）。

### 新しい定数

回数 3（`NARRATIVE_MAINTENANCE_PREEMPT_BACKOFF_AFTER`）だけ。遅延は既存の 1 s を使い、新しい時間の値は作らない。
K1b の 5 項目：値＝3（単位は回数）、検査する位置＝Main scheduler の cycle の終わり（preempt の判定の直後）、超えたときの結果＝その project を 1 s 候補から外す（失敗にも停止にもしない）、
実測の条件＝上の starvation の記録（約 218 回/分の preempt、Verify の p50 244 ms）と、PR 本文に書く試験の結果。
既存の閾値（確認台帳の現行閾値、Gold、retry の上限 3 回、DR-MPS-2 の cooldown）の緩和ではない。

### 試験と限界

- 新しい `electron/main/narrativeMaintenance.preemptBackoff.test.ts`（Main の vitest。fake timer）：
  - 2 つの scheduler の模型：maintenance の偽は slot を 240 ms 持って `accepted+preempted` を返し（周期 250 ms）、freshness の偽は 1 s の周期（初回を slot の占有の中に置く）で slot が使用中なら `null`。
    修正の前は 60 s で freshness の Run が 0 件、修正の後は backoff の後 2 tick 以内に 1 件。freshness の試行の回数も数え、0 件が「試行していない」せいでないことを示す。
  - 境界（999／1000 ms）、別 project の割り込みと元の `notBefore` での再開、回数の戻し（成功・preempt 以外・binding の変更・dispose／quiesce）、受領書あり／なしの数え方、60 s の cycle 数の上限と下限。
  - 修正の前に赤くなることを、製品の変更を外して確認する（定数を無限にする変異も確認する）。
- 限界：Main の模型であり、実機の位相は揺れる（実機では確率的）。模型は最悪の位相を決定的に作る。編集 trace（`index-unavailable`、`graph-late`）と a2 型の Gold への影響は未測定
  （DR-MPS-16 の教訓から、Verify と Rebuild の開始が最大 1 s 遅れる）。受領書の work key が wake だけの cycle でも安定して出るか（設計 §6 の 3）は Main の試験では確かめられない
  ので未確認。journey と実機（Xvfb）は走らせていない。

### やらないこと

- C（一定時間譲り続けた maintenance が foreground と同等に取る）：I1 を破る新しい契約で、ユーザーの確認が要る。
- B1（lifecycle core の admission での公平性）・B3（freshness の NotAdmitted を deferred にする）：別 lane。B3 は A′ の A/B で裾が残ったときだけ。
- E（周期の foreground の読みが譲る。renderer の IPC の引数が増える）：別 lane。
- F（Verify の再開可能化）：別 lane（DR-MPS-16 の別 lane。大きい DB の Verify が終わらない問題はこの修正では直らない）。
- D（harness の poll の変更）：単独では採らない。

### DR-CP4-L-27 との関係と、ユーザーの判断

L-27 の「製品側の候補」（連続 N 回目以降は 10 ms でなく `ERROR_RETRY_DELAY` 相当）を実装する lane が、この DR-MP-8。PUB-G の前提 lane の 1 つにあたる。
製品の挙動が変わるので、CP-4 の候補と受領書は旧候補に束縛されたまま。**新しい候補での CP-4 の正式な測り直しをするかどうかは、ユーザーの判断として残す**（この lane では走らせない）。
