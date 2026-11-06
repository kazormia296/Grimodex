# 保守の cutover 前停止（再発見の枯渇）の判断記録

対象は、新しい workspace で project を作った直後から Scene の追加と Chronicle 抽出（書き込み）が続くと、
保守の流れ（Backfill → Verify → Rebuild → C2-ZC cutover）が cutover まで進まず、自力で再開しない不具合。
cutover の marker（`schema_data_migrations` の `narrative-c2-canonical-freshness-v1`）が付かないので、
NIR-1 の chronicle index の build が `is_generic_freshness_canonical=false` で `CanonicalAuthorityUnavailable` になり、
関連場面の IR が使えないまま残る。調査は 2026-11-04。委任の根拠は AGENTS.md の「NIR-1 の残レーン」の
worker／owner／終了処理／lifecycle の技術判断の事前委任（U3）。

## DR-MPS-1 原因：再発見の上限が黙って尽き、枯渇した chain は Freshness の再点火も受け付けない

読んだ経路（すべて `electron/main/`）:

- `narrativeMaintenanceTriggers.ts` の `requestRediscovery` は、再発見が `NARRATIVE_MAINTENANCE_MAX_REDISCOVERY_ATTEMPTS`（3）に
  達すると警告も出さずに return する。保守 cycle が受理されるたびに `narrativeMaintenanceBootstrap.ts` の `onCycleAccepted` がこれを呼ぶ。
- 上限が戻るのは、planner が空を返したときか、返した work の fingerprint が変わったときだけ。
- 書き込みが続くと Verify の証跡は graph state digest の不一致（`NEX_VERIFY_GRAPH_STATE_CHANGED`）で毎回失効し、
  planner は同じ `DesiredWork{Verify, dependency-verify:<epoch>}` を返し続ける。fingerprint が変わらないので、
  最初の発見 1 回＋再発見 3 回の計 4 回で chain が黙って終わる。
- 終わった時点で `lastWakeReason="before-cutover"` が残る（空の discovery のときだけ null に戻る）。
- Freshness は idle poll（1 秒）ごとに cutover を試み、未準備なら `cutoverNotReady` を返す。これは `index.ts` の
  `requestBeforeCutoverPreparation` に届くが、`beforeCutoverChainActive()`（`lastWakeReason==="before-cutover"` だけで true）で捨てられる。
  この「active なら捨てる」は、poll が 1 秒ごとに Verify を回す暴走を防ぐための設計で、既存の試験が意図して固定している。
- 結果、書き込みが止まっても再起動できる経路が workspace の open／epoch-rotated の event しか無く、保守が再開しない。

再現: `electron/main/narrativeMaintenanceTriggers.stall.test.ts`（修正前は「書き込みが止まったあとに再開する」が
`expected 4 to be greater than 4` で落ちる）。DB の写し（失敗 run は Verify が約 330 ms 間隔で 5 回 completed になって止まる、
成功 run は rebuild が走って marker が約 3.5 秒で付く）とも整合する。生きたプロセスの `lastWakeReason` の値は観測しておらず推測。

## DR-MPS-2 修正：枯渇を記録し、backoff 付きで Freshness 由来の再点火だけを許す

変更は `narrativeMaintenanceTriggers.ts` の coordinator だけ。Rust・IPC の契約・閾値は変えない。

- 枯渇の記録: `requestRediscovery` が上限で打ち切るとき、その chain を「枯渇」として記録する
  （時刻、連続回数 k、そのときの fingerprint）。warn を 1 回出す（今は無音）。
- 再点火: `requestBeforeCutoverPreparation`（Freshness の NOT_READY 由来）は、次の 4 条件がすべて成り立つ場合に限り、
  新しい before-cutover chain を始める。(1) 枯渇している、(2) 生きた仕事が無い（timer なし、discovery in-flight なし、
  pendingEvent なし、pendingRetry なし）、(3) cooldown が経過している、(4) higher-value wake（restore／epoch）が active でない。
  cooldown は `min(5 s × 2^(k-1), 60 s)`（k は連続の枯渇回数。1 回目 5 s、2 回目 10 s、…、上限 60 s）。
- 再点火した chain の再発見は、従来どおり最大 3 回。`onCycleAccepted` 由来の `requestRediscovery` の上限は変えない。
- 再点火の枝は fingerprint を保持し、attempts だけを 0 に戻す。k は増やす（戻さない）。
- 停止条件（k と枯渇の記録を戻す）: planner が空を返したとき、または枯渇時と異なる fingerprint の work を受けたとき
  （phase が進んだ）、新しい authority の chain（workspace-opened／restore／epoch／outbox／recovery）が始まったとき。
  cutover が済めば Freshness が NOT_READY を返さなくなり、再点火は起きない。
- cooldown 内の NOT_READY は何も変えない（mutation revision も進めない）。quiescence writer から見た意味は今と同じ。
- 定数の根拠: 再点火 1 回は Verify を最大 4 回走らせる（読み取り中心。前景の書き込みには譲る
  〔`NEX_MAINTENANCE_CONNECTION_PREEMPTED`〕が、譲るたびに cycle が 1 つ無駄になる）。書き込みが止まらない間の頻度を、
  10 分で再点火 15 回未満（discover 60 回以下）に抑える値として基数 5 s・上限 60 s を選んだ。上限を 60 s より長くすると、
  書き込みが止まってから cutover までの待ちが最悪で 60 s を超える。

## DR-MPS-3 信頼境界と lifecycle の matrix

- 新しい送信先・保存範囲・契約・authority は無い。coordinator が持つメモリ上の数値 3 個（時刻、k、fingerprint）を足すだけ。
- 再点火の入口は `requestBeforeCutoverPreparation` で、呼び出し元は `electron/main/index.ts` の Freshness の
  `onCutoverNotReady` だけ（`git grep` で確認）。他の入口（open、epoch、restore）の優先関係は変えない。
- dispose 後は `disposed` で全入口が止まる。chain の世代（`chainGeneration`）が進めば古い timer／discovery は従来どおり捨てられる。

| 状態 | Freshness の NOT_READY | 修正前 | 修正後 |
|---|---|---|---|
| chain が動いている（timer／in-flight／pending） | 来る | 捨てる | 捨てる（変更なし） |
| 発見は済み、受理待ち（attempts < 3、枯渇なし） | 来る | 捨てる | 捨てる（変更なし） |
| 枯渇、cooldown 内 | 来る | 捨てる | 捨てる（mutation も進めない） |
| 枯渇、cooldown 経過 | 来る | 捨てる（永久） | 新しい chain を 1 本始める（k を増やす） |
| restore／epoch の wake が active | 来る | 捨てる | 捨てる（変更なし） |
| cutover 済み | 来ない | － | － |

## DR-MPS-4 代替案

- 案 B（書き込みが静まるまで再発見を数えない）: Freshness の書き込み中の信号を coordinator に新設する。配線が広がり、
  信号が欠けたときの安全側が曖昧で、試験も重い。案 A で足りるので採らない。
- 上限（3）の引き上げ、または無制限化: 書き込みが続く間の Verify の暴走を許す。閾値の緩和でもあるので採らない。
- 枯渇しても cooldown なしで毎 poll に再点火: 1 秒ごとの Verify になる。採らない。

## DR-MPS-5 begin が理由を捨てる件（契約が要るので入れない）

`related_scenes/begin.rs` は `NirIndexUnavailableReason` を一律 `"index-unavailable"` にする。理由を載せるには
`RelatedScenesUnavailableReason`（`electron/shared/relatedScenesSearchWire.ts` の閉じた union）の拡張か field の追加が要り、
main の検証と renderer が共有する型付き IPC の payload を変えるので、新しい契約になる。この lane の委任の外なので入れない。
契約を変えずに main の log へ出す手は、理由が Native から main へ渡らないため Rust 側の変更が要る。今回は含めず、別の小変更として残す。

## DR-MPS-6 実装後の追記（2026-11-04）

- 枯渇の記録は 2 か所で付く。`requestRediscovery` が上限で打ち切るとき（bootstrap の `onCycleAccepted` 由来）と、
  Freshness の NOT_READY が「生きた仕事が無く、attempts が上限」の chain を見つけたとき（最後の受理 cycle が
  `requestRediscovery` を呼ばなかった場合でも詰まらないように）。後者では cooldown がその時点から数え始まる。
- 再点火の枝は `lastDiscoveryFingerprint` を保持する。null に戻すと、再点火後の最初の discovery が「fingerprint が変わった」
  と見なされて k が毎回 1 に戻り、backoff が効かなくなる。
- 試験: `narrativeMaintenanceTriggers.test.ts`（cooldown 内の NOT_READY は何も変えない、5 s・10 s の cooldown 経過で
  再点火、上限 60 s、work の変化と空の結果で k が戻る、restore／epoch の wake を押しのけない）、
  `narrativeMaintenanceTriggers.stall.test.ts`（Freshness と coordinator の実物を配線した再現。書き込みが止まれば cutover まで進む、
  書き込みが止まらない 10 分で discover 52 回〔上限 56〕、書き込みが無ければ従来どおり、cutover 後は discover しない、
  書き込みが止まってから 70 s 以内に cutover）。
- 残る課題: (1) は独立レビューで穴と確認され、DR-MPS-7 で閉じた。(2) begin の理由の wire 化（DR-MPS-5）。(3) 再点火のたびの Verify が前景の書き込みに譲られる頻度の実測は無い。

## DR-MPS-7 独立レビューの反映（2026-11-04）

- 穴（P2 二件、同じ原因）: 再発見を進めるのは `onCycleAccepted` → `requestRediscovery` だけで、cycle が前景の書き込みに譲られる
  〔`NEX_MAINTENANCE_ATTEMPT_CANCELLED`〕、not-admitted、deferred、workspace-unavailable で終わると届かない。そのとき chain は
  attempts < 3 のまま idle になり、枯渇の記録（DR-MPS-6 の 2 経路とも attempts が上限なのを前提）が付かず、再点火した chain も
  同じ状態に入って NOT_READY が永久に無視された。scratch と stall 試験（修正前は落ちる）で確かめた。
- 修正: 枯渇（stalled）の定義を「attempts が上限」から「生きた仕事が無い」に広げた。coordinator に timer／in-flight／pendingEvent／
  pendingRetry が無く、かつ maintenance scheduler が実行中でも retry の timer 待ちでもない（`getQuiescenceState` の
  `inFlight`／`timerScheduled`。取得できなければ idle 扱い）chain を、Freshness の NOT_READY が最初に見た時点で停止と記録し、
  cooldown をその時点から数える。cooldown 経過後の NOT_READY が新しい chain を始める。k は停止のたびに増え、再点火した chain が
  また受理されずに止まっても backoff が伸びる（5→10→…→60 s）。scheduler が実行中の長い cycle（Rebuild 等）の間は停止とは見なさず、
  数え始めもしない。契約・閾値（再発見 3 回）・Rust は変えない。DR-MPS-3 の matrix の「発見は済み、受理待ち」は、
  scheduler が実行中ならそのまま「捨てる」、scheduler も idle なら停止として backoff の対象になる。
- 置き換えた試験: 旧「does not restart an exhausted before-cutover chain from a repeated NOT_READY」（枯渇後は何度 NOT_READY が来ても
  再開しない）は、「…from a NOT_READY inside its backoff」に置き換えた。旧設計の保証（idle poll ごとに Verify が暴走しない）は
  cooldown で保たれる（最短 5 s に 1 回、k が増えて最大 60 s に 1 回、各回は発見＋再発見で最大 4 回）。変わったのは
  「backoff 経過後は再開する」点だけで、これが修正の目的（書き込みが止まれば自力で再開する）。DR-MPS-1 の
  「active なら捨てる」は cooldown 内・scheduler 実行中・higher-value wake active の間は従来どおり。
- 総回数の上限は置かない（採らない案）: 上限で打ち切ると、書き込みが続いたあとに止まった場合に、元の不具合
  （IR が永久に使えない）が再び起きる。停止条件は cutover、planner が空、work の fingerprint の変化、新しい authority の chain。
  進捗のない恒久的な Verify 失敗では、60 s ごとに最大 4 回の discover と cycle が cutover まで続くが、頻度は上限で抑えられる。
  warn は k が上限の cooldown に達した最初の 1 回までとし、その後は間引く。
- fingerprint の前提: k を戻す条件は fingerprint の変化のまま。planner が毎回違う fingerprint を返す場合は、再発見の
  attempts も毎回 0 に戻る（従来からの挙動で、この修正の前から変わらない）。再点火の頻度の下限は、どの場合も 5 s に 1 回。
  DR-MPS-2 の「10 分で再点火 15 回未満」は fingerprint が安定している場合の見積もりである。
- 時計: cooldown は壁時計（`Date.now()`）。時刻が戻った場合は cooldown 無しで再点火せず、起点を現在時刻に取り直して待つ。
- 試験: `narrativeMaintenanceTriggers.test.ts` の DR-MPS-7 の 5 本（attempts==3 で idle の chain の再開、受理されない cycle の再点火と
  backoff の伸び、scheduler 実行中・retry 待ちの間は再点火しない、discovery in-flight の間は cooldown 経過後も generation を進めない、
  時計の逆行）と、`.stall.test.ts` の「cycle が譲られ続ける chain も自力で再開する」。変異（idle の検出の削除、scheduler の判定の削除、
  chainIdle の削除、時計の分岐の削除）で落ちることを確かめた。
- 差分の整理: 前の commit に混ざっていた prettier の整形だけの hunk は戻した（base も整形されておらず、`electron/main` は lint の対象外）。

## DR-MPS-8 原因（2 件目）：成功した Freshness の cycle が、heartbeat の期限切れで recovery に送られる（2026-11-05）

- 症状: PD の評価の本測定（第 4 版）で、Scene を 18〜29 件まとめて足した直後の 10〜35 秒に、
  `[workspace-lifecycle-diag] producer=freshness cause=E boundary=handoff state=recovery-required` が出る（4 回の切り替えのうち 4 回）。
  そのたびに抽出が失敗し、2 回目の後は復帰しないまま run が止まった。
- error の本文（dev 専用の診断の枝で取得。製品には出力先が無い）:
  `NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE: completed Incremental Freshness cycle exceeded its monotonic age bound before heartbeat registration`。
- 機構: `run_incremental_freshness_cycle_with_liveness_capability_and_hold_and_lifecycle_control` は、cycle が返った時点で
  `completed_at` を取る。その後の次の 3 つの合計が `MAX_SCHEDULER_LIVENESS_AGE`（5 s）を超えると、`record_live_scheduler_heartbeat` が拒む。
  - connection epoch の読み取り（`with_conn`）
  - `revalidate_narrative_workspace_after_cycle`
  - heartbeat の project の読み取り（`with_conn`）

  Scene の一括追加と抽出の commit が続くと、接続の待ちで 5 s を超える。
- 不具合の本体: 拒否は正しい（古い cycle は liveness を名乗れない）。しかし native の scheduler が、その拒否を `?` で
  cycle の失敗として返していた。そのため、cycle が commit 済みで authority も無傷なのに、retire と recovery に送っていた。
- 再試行の上限（`MAX_ATTEMPTS_PER_BATCH`）の枯渇は原因ではなかった。本測定の DB では、Freshness の batch は全部 completed で、
  attempt の失敗の記録も無い。

## DR-MPS-9 修正：期限切れの liveness は、その cycle の heartbeat と cutover だけを見送る

- 共有 crate: 期限切れを型 `SchedulerLivenessCycleStale` で返す。文言は従来と同じ。分類は DR-JF-3 と同じく型で行い、文字列では照合しない。
- native（`run_narrative_freshness_cycle_body`）: この型だけを受け止める。その cycle では liveness を作らず、cutover も試みない。
  retire も recovery もせず、通常の結果を返す。次の wake の cycle で、heartbeat と cutover をやり直す。
  - それ以外の heartbeat の失敗は、従来どおり recovery に送る（DATABASE_MISMATCH、SCOPE_MISSING、registry の破損）。
  - 見送った cycle は `cutoverNotReady` を出さない。cutover の後の workspace で、混むたびに保守の chain を起こさないためである。
    cutover の前なら、次の cycle が通常の NOT_READY を出す。
  - CI の hold の結果は、cutover を通っていないことを明示する必要があるので、`cutoverNotReady: true` のままにする。
    見送った cycle では `require_held_cutover_not_ready` は構造上必ず通るので、「Held なのに gate を通った」の検出は次の cycle に移る。
    安全性は、CI の seam が DB から読む quiescence state の marker の判定（`state.marker === null`）が担う。
- 変えないもの:
  - 5 s の上限と、古い cycle を拒む gate（`completed_cycle_capability_expires_before_a_late_heartbeat` はそのまま通る）。
  - IPC、wire、DB の契約。
  - 他の Freshness の失敗の扱い。
- 信頼境界: 新しい送信先・保存範囲・契約・閾値の変更は無い。委任の根拠は U3（NIR-1 の lifecycle の技術判断）。
- 試験:
  - native の `freshness_scheduler_defers_stale_liveness_without_recovery`：post-cycle の hook で 6 s 待たせ、authority が外れず、
    結果を返さない（recovery の結果も `cutoverNotReady` も出さない）ことを確かめる。次の cycle が通常どおり NOT_READY に達することも確かめる。
    分類を外す変異では、recovery の結果が返って落ちる。
  - crate の `narrative_c2zc_liveness_binding` で、型で分類できることを確かめる。

## DR-MPS-10 残る課題（この修正に含めない）

- 2 回目の recovery が戻らない件（**DR-MPS-11 で訂正。戻らないことは観測されていない**）: 本測定では 2 回目の recovery の後、DB 操作が
  `workspace lifecycle has active owners or unacknowledged work` のまま止まった。診断の run（1 回だけ発生）では再現していない。
  - この修正は引き金を消すが、復帰が詰まる機構は未解明のままである。
  - 候補: 失敗した前景の Execution が non-Completed のまま残り、recovery の admit が NotAdmitted を返し続ける。
  - 別の課題として扱う。
- Freshness の error の本文が製品のどこにも残らない件: native に tracing の subscriber が無い。
  値だけの診断（固定の `NEX_` コード）を足すかは、別に判断する。

## DR-MPS-11 訂正：「2 回目の recovery が戻らない」は観測されていない（2026-11-05）

DR-MPS-10 の 1 件目は、停止の時刻を突き合わせると成り立たない。PD の評価の本測定（第 4 版）の 2 作品とも、
2 回目の handoff の 1 秒以内に harness が終了していて、recovery が戻るかどうかは一度も観測されていない。

| 作品 | 2 回目の handoff（`[workspace-lifecycle-diag]`、rev 6、descriptor 2） | 抽出の失敗 | run の終了 |
|---|---|---|---|
| m-ja-2 | 17:04:15.409Z | 位置 89 が 17:04:15.399Z（in-flight の抽出）。位置 90〜117 は約 12 ms 間隔で 350 ms 以内に全部 | 17:04:16Z |
| m-en-1 | 18:11:32.144Z | 位置 37（in-flight）、38〜54 を同様に連続で | 18:11:32Z |

- 機構：harness（`scripts/quality/fusion-slot-eval/ir-renderer.ts` の抽出のループ）は、抽出の IPC の失敗を catch して
  `extraction-failed` と記録し、待たずに次の位置へ進む。recovery の最中の DB 操作は、lifecycle の state が
  RecoveryRequired／Transition の間は participant の拒否として `workspace lifecycle has active owners or unacknowledged work` になる
  （`workspace_lifecycle.rs` の `begin_workspace_participant`）。これは recovery の途中の正常な一時状態で、残りの位置が
  全部これで落ち、その後の IPC の失敗で harness が終了した。
- 1 回目が続けられた理由：in-flight の抽出の失敗が handoff の約 3 秒後に返り（m-ja-2 の位置 60 は 16:34:45.05Z、handoff は 16:34:41.95Z）、
  その間に recovery が済んでいた。2 回目は in-flight の抽出の失敗が handoff と同時に返った。**1 回目と 2 回目の違いは回数ではなく、
  in-flight の抽出の失敗が返った時刻**と読む。revision の算術（rev 3 → 6 がちょうど +3＝admit・activate・次の handoff）も、
  1 回目の recovery が 1 往復で済んだことと合う。診断の run（`diag-freshness-1`、1 回発生）は復帰した。
- 第 4 版の `extraction-failed`（m-ja-2 で 33 件、m-en-1 で 19 件）のうち、m-ja-2 の位置 90〜117 と m-en-1 の位置 38〜54 は
  harness の連続の失敗で、model の出力の失敗ではない（位置 89・37 は recovery で中断された抽出）。
- 読んで確かめた潜在の穴（今回の停止がここを通った証拠は無い）：native の recovery の pump（`reconcile_maintenance_recovery_descriptor`）には、
  値を何も残さずに `Ok(None)` で終わる出口がある（target が無いときの NotAdmitted、authority を開けないときの `Err(_) => {}`、
  process-local の binding が無い descriptor、`Transition` の state での早期の return）。recovery が本当に詰まった場合も、今は区別できない。
- 扱い：DR-MPS-10 の 1 件目は「戻らない」ではなく「**戻るかどうかが観測できない**」に改める。pump の出口に値だけの診断を足すこと、
  2 回続けて recovery しても Ready に戻ることを試験で固定することは、別の PR で判断を記録してから行う。harness の待ちの無さは、
  次の事前登録の版で直す（今の第 5 版の run の道具は凍結のまま）。#801 で引き金（liveness の期限切れの recovery）は消えていて、
  第 5 版の run ではここまで handoff は起きていない。

## DR-MPS-12 Freshness の handoff に固定のコードを 1 つ添える（2026-11-05）

- 事実: Freshness の cycle が失敗して recovery に送られたとき、error の本文は native に tracing の subscriber が無いため
  製品のどこにも残らない（DR-MPS-8 の `NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE` は dev 専用の診断の枝でしか取れなかった）。
  既存の値だけの診断（`[workspace-lifecycle-diag] {json}`）は producer／cause／boundary と lifecycle の値しか持たない。
- 判断: Freshness の「cycle が `Err` を返した」経路（`Ok(Ok(Err(error)))`）の handoff だけに、`code` を 1 つ添える。
  panic／JoinError の経路は本文が無いので `code` を付けない。他の producer の handoff も変えない。
  - `code` は error の Display から、固定の `NEX_` コードだけを取り出した値である。`fixed_code(message)` の規則：
    直前が `[A-Za-z0-9_]` でも path の区切り（`/` と `\`）でもない位置にある最初の `NEX_` から、`[A-Z0-9_]` が続く限りを取る。
    長さ 5〜96 だけ受け付け、それ以外は `None`。prose・小文字・path は通さない。
    コードの直後が英小文字（`NEX_Abc`）なら、途中で切れた値を出さないよう `None`。
  - path の区切りの直後の `NEX_` は受け付けない（`/tmp/NEX_A` は `None`）。利用者が付けた file 名の断片を stderr に出さないためで、
    固定のコードは文の先頭か `(`、`:`、空白の後に現れる。
  - 無いときは key 自体を出さない（`skip_serializing_if`）。既存の record の key の集合は変わらない。
- 信頼境界: 既存の main process の stderr に値だけを書く。本文・path・ID 以外の識別子・prose は出さない。
  `NEX_` コードは `[A-Z0-9_]` だけで `_` でつながるので、product journey の stderr 判定（`\b` 区切りの errors?／failed 等）には当たらない。
  新しい送信先・保存範囲・契約・閾値は無い。委任の根拠は AGENTS.md の NIR-1 の残レーンの lifecycle の技術判断（U3）。
- 変えないもの: handoff の制御の流れ、戻り値、lock の順序、他の producer の record、IPC・wire・DB の契約。
- 試験: `fixed_code` の表（コード付きの本文、`Anyhow(NEX_A_B)`、`xNEX_A`、`nex_a`、`NEX_Abc`、path の直後、97 字、`NEX_` だけ）と、
  `code` 付きの record の key の集合。JS 側は `isMainProcessErrorMessage` が `code` 付きの record で false になること。

## DR-MPS-13 recovery の pump の無言の出口に、値だけの診断を足す（2026-11-05）

- 事実: `reconcile_maintenance_recovery_descriptor`（native の recovery の pump。Freshness の 1 秒 tick が target 無しで呼ぶ）には、
  値を何も残さずに `Ok(None)` で終わる出口が 5 つある。recovery が本当に詰まった場合も、今は他の状態と区別できない。
  - (a) snapshot が RecoveryRequired／Ready／shutdown の Finishing(0) 以外（`Transition` に Recover の ticket が残る孤立もここに落ちる）
  - (b) maintenance descriptor に process-local の binding が無い
  - (c) `open_descriptor_recovery_authority` の失敗（`Err(_) => {}`）
  - (d) `try_begin_recovery_transition_for_workspace` が NotAdmitted（target 無しなら `Ok(None)`）
  - (e) state が RecoveryRequired なのに、選べる descriptor が無い
- 判断: target 無しの呼出しに限り、出口ごとに 1 行を stderr に書く。`producer: "recovery-pump"`、`boundary: "recovery-pump"`、
  `cause: "D"`（deferred。error ではなく「今は進めない」）、`exit` は固定の列挙：
  `transition-pending`（a。Recover の ticket が Maintenance の descriptor を指すときだけ。普通の Open／Restore の Transition では出さない。
  正常に進行中の Recover Transition を並行の pump が観測した場合も 1 行出る。revision ごとに 1 回で害は無い）、
  `binding-unproven`（b）、`authority-unopened`（c。`code` に `fixed_code` を入れる）、`admission-pending`（d）、
  `no-actionable-descriptor`（e。state が RecoveryRequired のときだけ）。lifecycle の値は共有 core の診断（既存の `LifecycleDiagnostic`）を使う。
  pump が見ている descriptor が state の descriptor と違う場合（Ready のまま残る descriptor）は、`descriptorId` と `owner` に pump 側の値を入れる。
- 連打の抑止: pump は 1 秒ごとに呼ばれる。同じ (exit, descriptor, revision) は 1 回だけ出す。
  revision が進むと記憶を捨てる（上限 64 件。超えたら出さない）。Mutex が poison していても操作を変えない。
- 共有 crate の変更: `WorkspaceLifecycleCore::snapshot_with_diagnostic` を `pub(crate)` から `pub` にし、native の adapter から呼べるようにする。
  新しい状態・authority は作らない（既存の読み取りの公開だけ）。
- 信頼境界: 既存の main process の stderr に値だけを書く。出す値は列挙・数値・固定の `NEX_` コードに限る。path・binding・ID の本文・prose は出さない。
  どの値も stderr の error 判定の語（errors?／failed／failure／fatal／panic／exception 等）を `\b` 区切りで含まない。
  新しい送信先・保存範囲・契約・閾値は無い。委任の根拠は U3。
- 変えないもの: pump の制御の流れ、戻り値、lock の順序。診断の取得・書き込みの失敗は無視する。
  lifecycle の lock を握ったまま別の lock を取らない（evidence は出口の直前に別途取る）。target が Some のときは診断を出さない。
- 試験: record の key と値（exit・code）、連打の抑止（同じ組は 1 回、revision が変われば再度、exit や descriptor が違えば別）、
  書き込み先の失敗が操作を変えないこと。JS 側は全 exit の値と code で `isMainProcessErrorMessage` が false になること。

## DR-MPS-14 2 回続けての recovery の試験（2026-11-05）

- 事実: DR-MPS-11 のとおり、2 回目の recovery が戻らないことは観測されていない。「戻る」ことを固定する試験が無い。
  fixture を読んで分かったこと：
  - receipt の slot は 256 件で、2 回分は尽きない。
  - pump の入口は 2 つある。main の N-API（`reconcile_narrative_maintenance_recovery`、target 無し）は、reconcile の前に
    ACK されていない receipt を先頭から replay する（`first_completed_maintenance_recovery_receipt`）。この入口では、
    2 回目の descriptor は main が 1 回目の receipt を ACK するまで取り上げられない（既存の仕様。既存の試験が固定している）。
  - Freshness の tick（`reconcile_maintenance_recovery_with_open_lock`）は replay を通らず、descriptor を直接 reconcile する。
    **Freshness が起こした recovery の 2 回目は、1 回目の receipt が ACK されていなくても進む**。DR-MPS-11 の停止（Freshness 由来の
    handoff の 2 回目）は、この ACK 待ちでは説明されない。
- 判断: 同じ process で maintenance descriptor の recovery を 2 回続けて起こす試験を、入口ごとに 1 本ずつ足す。
  - Freshness の入口（`freshness_pump_recovers_twice_without_an_intervening_ack`）：ACK を挟まずに 2 回とも Ready に戻り、
    unresolved の descriptor が残らず、receipt が 2 件とも main の ACK を待つことを確かめる。
  - main の入口（`two_consecutive_maintenance_recoveries_return_to_ready`）：ACK の扱いを試験の中で明示する。
  1 回目の後に ACK せずに pump を呼ぶと 1 回目の receipt が replay され、2 回目の descriptor が unresolved のまま残ることを確かめる。
  ACK した後の pump で 2 回目が回復し、Ready に戻り、2 つ目の descriptor の id が 1 つ目より大きく、unresolved の descriptor が残らないことを確かめる。
- 残る課題: main の入口では、main が ACK しないまま新しい descriptor が出ると黙って待つ（replay は診断の対象外。
  Freshness の入口は待たない）。この待ちが長引く場合の観測は、
  必要になった時点で別に判断する。
- 信頼境界・変えないもの: 試験だけ。製品のコードは変えない。新しい送信先・保存・契約・閾値は無い。委任の根拠は U3。
