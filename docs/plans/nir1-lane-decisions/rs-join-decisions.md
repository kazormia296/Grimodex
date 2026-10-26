# RS-JOIN の委任判断の記録（Related Scenes の子の合流の短縮）

出所は CP-4 の H5 の診断（`cp4-decisions.md` の DR-CP4-S1C2-27・28 と「H5 の診断の結果」）と、続行計画 DR-CP3A-53・55 が挙げた手段（`current_operation` と検証を 1 本にする、Revision の評価の共有、検証の前倒し）である。基点は統合 branch `claude/nir1-cp4` の `d7521a12`、branch は `claude/nir1-join-opt`。

目的：D（子の Raw-ready ＋ 10.84 ms）と lease の 100 ms を緩めずに、`graph-ready` の後の再 query（子）が自分の D の窓に Graph を届ける割合を上げ、Graph 付きの一覧が出るまでの「読込み中」をなくす。契約・閾値・鮮度の安全性は変えない実装の最適化に限る。

変えないもの：D=10.84 ms、lease 100 ms、1%、P の B と B+D の上限、D′ の挙動（`begin_deferred`、release、`Cached`）、「遅れた結果は既に描画した join に混ぜない」（`nir1RelatedScenesGraphJoin.ts` の `onGraph`）、Native の再検証の中身（`current_operation`、gate、`assemble`、返却の直前の再確認、`keep_click`）、監査・保存の範囲、閉じた gate（`PRODUCT_GRAPH_PUBLISHED=false`、`NIR1_GRAPH_UI_ENABLED = false as const`、`BODY_DECLARATION_UI_ENABLED=false`、`PROFILE_ACTIVATION_UI_ENABLED = false as const`、`PrePublicationEntry::ProfileActivation`）、IPC の入口・wire・Main の route。

記録の順序：DR-RSJ-2（lane）は renderer の編集の後、commit の前にこの文書へ書いた（変異の前に書く規則から外れた。開示する）。DR-RSJ-3・4（Native の待受け）はこの文書を書いてから編集した。

## 1. 事実の確認（`d7521a12` のコード）

| 事実 | 確認の結果 |
|---|---|
| 子の Graph の continue が IR の後ろに並ぶ理由 | `src/lib/tauri.ts` の `DERIVED_INDEX_COMMANDS` に `related_scenes_continue` と `related_scenes_graph_continue`（待受けの形）が入り、`src/lib/ipcQueue.ts` の `MAX_CONCURRENT_DERIVED = 1` で 1 本ずつ走る。IR の continue は begin の直後（sparse の前）に出て、Graph の待受けは Raw-ready に出るので、Graph は IR の応答まで transport に出ない（H5 の内訳 1 と一致） |
| `MAX_CONCURRENT_DERIVED = 1` の理由 | 再構築できる索引の仕事（`semantic_reindex_all` など）が background の 3 枠を使い切らないため（`ipcQueue.ts` の注記）。DR-CP3A-45 は「2 にする」案を、全 derived の資源の方針が変わり待受けと次の待受けが並走するとして却下した。settle は args で mutation lane に振り分け済み（DR-CP3A-45） |
| Native の Graph の待受けは IR を内部で待つ | `related_scenes/graph.rs` の `await_graph`：ticket の outcome が available でも `lease.ir == Available` になるまで回る。IR の応答は begin の scoring の thread が `lease.data.result` に入れる（`begin.rs`）。renderer の IR の continue の到着には依存しない。よって Graph の待受けを IR の continue と並行に出しても待ち合いの循環は無い（IR の continue は `completed` の `Notify` を待ち、Graph の待受けは result を見る） |
| IR だけを待つ間の待ち方 | `Cached` の slot（子）か、ticket が済んだ後に IR だけが無いとき、`std::thread::sleep(GRAPH_WAIT_STEP = 25 ms)`。並行に出すだけでは、IR が届いてから最大 25 ms 気付かず、今より遅くなる |
| DB の接続 | `current_operation`（participant の read transaction）と `assemble`（`with_graph_requalification_read`）は同じ `Database` の process 内の mutex を取る。IR の continue の `current_operation` も同じ。並行にしても DB の仕事は直列になる |
| Chronicle の検証の再利用 | db crate の `proof_current_with_control`（`nir1_chronicle_index/canonical.rs`）は `ReadIdentity` が同じなら前の検証の結論を使う（`validated_read`）。IR の continue の直後の Graph の `current_operation` は、DB が変わっていなければこの cache に当たる |
| hook の「読込み中」 | `useNir1RelatedScenes.ts` の query の effect は、refresh のたびに `setFetch(null)` をし、`FETCH_DEBOUNCE_MS = 400` の後に再 query する。前の結果の session は effect の cleanup で release する |

## 2. 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-RSJ-1 | 2026-10-25 | RS-JOIN（harness） | **計測の probe**。評価専用の `nir1-graph-eval` feature の下だけで、IR の continue と Graph の待受けの段の時刻（`ir-set`、`ir-enter`、`ir-current-start/end`、`g-enter`、`g-await-end`、`g-current-end`、`g-assemble-end`、`g-return`）を eval の時計で記録し、`nir1GraphEvalSamples` の `join` に出す。lease の番地を小さい番号に替え、ticket・binding・本文を持たない。`hook-check.mjs` が子の内訳を集計する。製品の commit とは別の commit にし、製品の commit はこれに依存しない | 評価の build だけ。受信先・保存なし | Rust の計測なしで推定する（H5 の内訳 3 が未測定のまま） | 不要 | 該当なし | 不要（同期の記録だけ） | 記録済み |
| DR-RSJ-2 | 2026-10-25 | RS-JOIN | **lane：同じ operation の IR の continue と Graph の待受けだけを並行にする**。`enqueueIpc` に任意の `pair`（文字列）を足す。`pumpQueue` は、derived の枠（1）が埋まっていても、走っている唯一の derived の item と同じ `pair` を持つ item を 1 つだけ入れる（`activeDerivedCount === MAX_CONCURRENT_DERIVED` かつ同じ pair の active がある時。よって derived は最大 2、増えるのは 1 つだけ）。`pair` を付けるのは Electron の `invoke` の `derivedPairForCommand` だけで、`related_scenes_continue` と `related_scenes_graph_continue` の `operationTicket`。settle の形は mutation lane のまま（pair は使われない）。`MAX_CONCURRENT`（4）と background（3）の上限、derived の admission barrier、lifecycle の caller の切離し、audit export の待ちは変えない。順序：IR の continue が先に出る（begin の直後）ことは変わらず、Graph の待受けはその間に出る。IR の continue が終わった後は待受けが枠を持ち続け、ほかの derived は今までどおり待つ | renderer の資源の選択だけ。Main と Native の検証、wire、入口は変わらない | `MAX_CONCURRENT_DERIVED = 2`（全 derived の方針が変わる。DR-CP3A-45 で却下済み）、待受けを read lane に移す（lifecycle の切離しの意味と 3 枠の共有が変わる）、新しい category（`ipcQueue.ts` の不変条件が増える）、Graph を IR より先に出す（Raw R が Raw-ready まで無い） | 不要（実装の資源の選択） | 該当なし | §3 の L1 | 記録済み |
| DR-RSJ-3 | 2026-10-25 | RS-JOIN | **Native：IR の到着で Graph の待受けを起こす**。operation に `IrJoin`（`Mutex` の世代と `Condvar`）を足し、begin の scoring の thread が IR の応答を slot に入れた直後に世代を進めて `notify_all` する。`await_graph` の「IR だけを待つ」枝は `sleep(step)` の代わりに、世代が変わるか `step` が過ぎるまで待つ。step（25 ms）ごとの宣言・lease・owner・epoch の確認はそのまま（起きるのが早くなるだけで、確認の間隔の上限は変わらない）。ticket を待つ枝（`waiter.wait_timeout`）は変えない | 同じ process の thread だけ。外向きの通信・保存なし | 待受けを async にして `completed` の `Notify` を待つ（ticket の waiter が同期で、待受けの形が大きく変わる）、step を 1 ms にする（polling で thread を起こし続ける） | 不要 | 該当なし | §3 の N1 | 記録済み（編集の前） |
| DR-RSJ-4 | 2026-10-25 | RS-JOIN | **Native：IR を先に**。同じ operation の IR の continue が Native の中で走っている間（`continue_query` の入口から、`current_operation` を終えて返るまで。RAII の guard で数える）、Graph の待受けはその IR を「まだ届いていない」（`Pending`）と見て待つ。`Unavailable` は隠さない（Chronicle が止まれば Graph も即座に止まる）。理由：lane を並行にすると、IR の slot が埋まった瞬間に IR の continue の `current_operation` と Graph の `current_operation`＋`assemble` が DB の mutex を取り合い、IR の応答が Graph の検証の分だけ遅れうる。IR が D に遅れれば R だけに縮退する（IR の可用性の悪化）。IR の continue が Graph の検証より後に Native に届く場合はこの順序は保てない（測定では IR の continue は Raw-ready の前に出る） | 同上 | 順序を付けない（IR の timeout が増えうる）、IR の continue の検証の結果を Graph が使う（下の DR-RSJ-5） | 不要 | 該当なし | §3 の N2 | 記録済み（編集の前） |
| DR-RSJ-5 | 2026-10-25 | RS-JOIN | **見送り**。(a) `current_operation` と `assemble` を並行にする：同じ DB の mutex で直列になり、IR の continue も遅らせる。(b) IR の continue の `current_operation` の結論を Graph が使い回す：Graph の検証の時点が前に動き、鮮度の窓が `assemble` の分だけ広がる（弱める変更）。Chronicle の proof の部分は db crate の `ReadIdentity` の cache が既に同じ snapshot の再検証を省いている。(c) 検証の前倒し（IR の到着の前に `assemble` を始める）：`assemble` は IR の応答から表示の Scene の集合と共通の 1 枠を作る（`graph_response::compose`）ので、IR の前には始められない。IR に依存しない部分（seed・seal・path の読直し）と依存する部分に requalification を分け、2 つの snapshot を `ReadIdentity` で結ぶ案は db crate の検証の中身を変えるので、この lane では行わない（K6/4 の判断の入力として残す）。(d) `Cached` の slot で検証を省く：worker の結果は信頼しない設計（`graph_response.rs` の冒頭）で、省くと再検証が弱まる | — | — | 不要 | (b)(d) は弱める変更なので行わない | 不要 | 記録済み |
| DR-RSJ-6 | 2026-10-25 | RS-JOIN | **hook の UX**。`graph-ready` を起点にした refresh で、query の鍵（enabled、Scene、tree の nodes、mode、project、workspace、open revision、listening）が前の run と同じなら、表示中の結果を `setFetch(null)` で消さずに保ち（spinner は出す）、その session と invalidation の購読も次の世代が答えを出す（公開、失敗、取消し、invalidated）まで持ち続ける。保った結果の session が invalidated になれば、その時点で一覧を下げる（今までの `recoverRaw` と同じく古い結果を出さない）。次の世代が `completed` 以外で終われば一覧を下げる（今までと同じ見え方）。debounce：`graph-ready` 起点の最初の refresh は 0 ms で出す。`graph-ready` 起点の世代がさらに `graph-ready` で refresh する時（連鎖）は 400 ms の debounce を保つ。ほかの契機（Scene・tree の変更、index-ready、取消しの refresh、IR の timeout の再試行）は今までどおり 400 ms。子が Graph なしで戻った場合：子の R+IR をそのまま表示し、それ以上待たない（`Cached` の slot の `unused` は cache に戻らず通知が出ないので、世代ごとに 1 回の refresh の規則のまま）。P2-A（同じ project の 2 つの表示の往復）：往復は `graph-ready` 起点の連鎖なので debounce は残り、周期は変わらない。連鎖の外の契機 1 回につき、最初の 1 回だけが 400 ms 早くなる（begin の回数は増えない） | renderer の UI の状態だけ。保つのは同じ query の、まだ invalidated でない結果だけ | 一覧を保つが session は今までどおり release する（Evidence の click が効かず、invalidation の監視も外れる）、debounce を全部外す（P2-A の往復が速くなる） | 不要 | 該当なし | §3 の L2 | 記録済み |

## 3. owner／lifecycle の matrix（GDX-PRECHECK-001。変異の前に記録）

影響マトリクス（`.agents/skills/refactor-cross-boundaries` の形）：

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| L1 | renderer の derived lane（IR の continue＋Graph の待受け） | `tauri.ts` の `invoke`（Electron） | `enqueueIpc(..., "derived", pair)`。pair は ticket | `ipcQueue.ts` の `pumpQueue` | derived は最大 2（pair の時だけ）、FIFO、barrier、lifecycle の切離し、audit export の待ち | Tauri（frozen legacy）と browser mock は pair なし（今までどおり直列） | `ipcQueue.test.ts`（pair の 2 件）、`nir1RelatedScenesGraphQueue.test.ts`（実物の `tauri.ts` を通す 2 件） | planned |
| L2 | hook の `graph-ready` の refresh | `useNir1RelatedScenes.ts` | 表示中の結果と session を次の世代まで保つ。invalidated で下げる | `RelatedScenesSection` | 古い結果を出さない、世代ごとに 1 回の refresh、P2-A の連鎖の debounce | ほかの契機は今までどおり | `useNir1RelatedScenes.graphReadyKeep.test.tsx`（7 件）と既存の hook の試験 | planned |
| N1 | Native の Graph の待受けの「IR だけを待つ」枝 | `graph.rs` の `await_graph` | `IrJoin` の世代の変化か step で起きる | `await_request` | 宣言・lease・owner・epoch・IR の `Unavailable` の確認は毎回、step の上限 25 ms、全体の上限 2 s | ticket を待つ枝は不変 | `graph_tests.rs` に IR の到着で起きる試験 | planned |
| N2 | 同じ operation の IR の continue と Graph の待受けの順序 | `related_scenes.rs` の `continue_query`、`graph.rs` の `lease_probe` | IR の continue が走る間、Graph は IR を `Pending` と見る | `await_graph` | IR の応答の時刻を Graph の検証が遅らせない、`Unavailable` は隠さない | IR の continue が無い時は今までどおり | `graph_tests.rs` に guard の間は待ち、外れると起きる試験と、`Unavailable` を隠さない試験 | planned |
| X1 | Main の route、preload、wire、`assemble` の中身、settle、release、D′ | — | 変えない | — | — | — | 既存の試験 | verified unchanged（編集なし） |

lifecycle note：

- L1：入口は `invoke` の 1 箇所。pair の item も derived なので admission barrier（`acquireIpcDerivedAdmissionBarrier`）で拒否され、`cancelDerivedIpcCallersForLifecycle` で caller が切り離され（active の集合に入る）、実の task は settle まで枠を持つ。audit export の `awaitPendingIpcActualTasksForAuditExport` は全 task を待つ。timeout は今までどおり caller だけを settle する。再入：同じ pair の 3 本目は入らない（試験で固定）。永続の再起動状態なし。
- L2：保った session の owner は hook（`carried`）。終わる経路は 4 つ：次の世代の答え（then の先頭）、その世代の catch、`recoverRaw`、unmount（query の effect の後に宣言した effect の cleanup）。effect の cleanup はいつも前の `carried` を release してから新しく持つ（同時に 2 つは持たない）。保った session の invalidation の購読は保った時に張り直し、下げる時に外す。永続の状態なし。
- N1：待つのは `spawn_blocking` の thread（今までと同じ 1 本）。`Condvar::wait_timeout_while` の上限は step で、全体は `GRAPH_AWAIT_LIMIT`（2 s）。起こすのは scoring の thread の 1 回（成功と失敗の両方の後）。起こし損ねても step で戻る（今までの上限と同じ）。
- N2：数えるのは `continue_query` の guard（入口で +1、Drop で −1 と通知）。`?` の早期の return、`invalidate` の後の return、panic の unwind でも Drop が走る。IR の continue は response が入るか lease が切れるまで待ち、`current_operation` を終えて返るので、Graph の待ちは IR の continue の終わりで有界。最悪でも `GRAPH_AWAIT_LIMIT` で `timeout`（今までの IR を待つ上限と同じ）。

## 4. 実装後の追記（2026-10-25）

§3 の L1、L2、N1、N2 は implemented、X1 は verified unchanged（Main、preload、wire、`assemble` の中身、settle、release、D′ は編集なし）。

commit（`d7521a12` の上。製品の 4 本は harness の file に依存せず、`origin/master` `e68aa45c` に対して `git merge-tree` で cherry-pick の衝突 0 を確かめた。hook の commit は単独でも衝突 0）：

| commit | 区分 | 内容 |
|---|---|---|
| `perf(nir1): 同じ operation の IR の continue と Graph の待受けを並行に通す` | 製品 | DR-RSJ-2 |
| `chore(perf): RS-JOIN の lane の規則の分だけ起動時 JS graph の上限を上げる` | 製品（予算） | raw 4,250,669 → 4,250,910（+241）。絶対上限 4,250,700 → 4,251,000。gzip は上限の内側 |
| `perf(nir1): Graph の待受けを IR の到着で起こし、同じ operation の IR を先に返す` | 製品 | DR-RSJ-3、4 |
| `perf(nir1): graph-ready の取り直しで表示中の一覧を保ち、debounce を待たない` | 製品 | DR-RSJ-6 |
| `test(nir1): RS-JOIN の H5 の診断に Native の合流の時刻を足す` | harness | DR-RSJ-1 |
| この docs の commit | docs | この記録と索引 |

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-RSJ-7 | 2026-10-25 | RS-JOIN | **試験と変異**。renderer：`ipcQueue.test.ts` に pair の 2 件（同じ pair の 1 つだけが入る、pair の無い item と別の pair は待つ、3 本目は待つ、IR の後も待受けが枠を持つ／lifecycle の切離しで pair の caller も切れ、実の task は settle まで枠を持つ）、`nir1RelatedScenesGraphQueue.test.ts`（実物の `tauri.ts`・`ipcQueue`・API を通す。同じ ticket の待受けだけが t=5 ms に出る、別の operation の待受けと次の begin は FIFO で後、既存の DR-CP3A-45 の試験の「待受けは t=30 ms」を t=5 ms に改めた）、`useNir1RelatedScenes.graphReadyKeep.test.tsx` の 7 件（保つ・0 ms で出す・session を答えまで持つ、保った結果の invalidation で下げる、failed／cancelled で下げる、子が Graph なしなら保ち連鎖は 400 ms、tree の変更と同時なら保たない、unmount で release）。変更前の hook で 7 件のうち 6 件が落ち、tree の変更の件（変わらない挙動の characterization）は通る。変異：pair の個数の条件を外す → 1 件落ちる、`tauri.ts` の pair を null にする → 2 件落ちる、連鎖の debounce を外す → 1 件、invalidation で下げない → 1 件、query の鍵の比較を外す → 1 件。Native：`graph_tests.rs` に 4 件（IR の到着で起きる、同じ operation の IR の continue の間は待ち抜けると起きる、`Unavailable` を隠さない、数の入れ子）。変異：起こしを sleep に戻す → 2 件落ちる（step 10 s の試験が上限 5 s を超える）、`ir_for_graph` の隠しを外す → 2 件落ちる。begin の scoring の thread の `notify` は実の Operation（Chronicle の proof）が要り unit 試験が無い（H5 の実機の測定で、子の `g-await-end` が `ir-current-end` の 0.0〜0.1 ms 後であることで確かめた） | 試験だけ | — | 不要 | 該当なし | — | 記録済み |
| DR-RSJ-8 | 2026-10-25 | RS-JOIN | **測定の結果：子が窓に届く割合は上がらない（構造による）。UX は大きく良くなる**。下の表。Native の内訳（子、IR の scoring が slot に入れた時＝0）：Graph の待受けは IR より 3.9〜4.0 ms 早く Native に着いて待ち（並行化は効いている）、IR の continue の Chronicle の再検証 1.5 ms、Graph の `current_operation` 1.6 ms、`assemble` 6.2〜6.4 ms（p50）が同じ DB の mutex で直列に続く。子の Raw-ready から IR の slot まで約 4 ms あり（Graph の到着 13.6 ms から Native の `g-assemble-end` 9.4 ms と返りを引いた推定）、Graph の到着は 4＋1.5＋1.6＋6.3＋返りの IPC ≒ 13.6 ms で、D（10.84 ms）を p50 で約 3 ms 超える。見積もり（測っていない）：IR を先にする順序（DR-RSJ-4）を外しても（Graph の再検証が IR の再検証と mutex を取り合う）約 12 ms、Graph の `current_operation` を丸ごと省いても約 12.2 ms で、どれも窓に入らない。窓に入れる唯一の残りの手段は `assemble` の IR に依存しない部分を IR の到着の前に行うこと（DR-RSJ-5 (c)。db crate の検証の分割と 2 つの snapshot の `ReadIdentity` の照合が要る）か、D・窓の定義の変更（確認済みの閾値の変更で、委任の外）。lane と Native の変更は p50 を変えないが、子の Graph の到着の p90／max を 15.6〜17.5／17.3〜24.5 ms から 14.4〜14.5／14.9〜15.5 ms に、子の IR の到着の p90 を 7.0〜8.5 から 6.4〜6.5 ms に詰めた（3 run と 2 run の比較で、run の間の分散は推定していない） | 診断だけ | — | integrator に返す | 該当なし（閾値・定義を変えない） | — | 記録済み |
| DR-RSJ-9 | 2026-10-25 | RS-JOIN | **測定の条件**。評価の `.node` は `eval-native-build.mjs` を通さずに同じ command（`napi build --release --features nir1-graph-eval --js false`）で `.artifacts/cp4/rsj-build-{before,after}/` に作った（`eval-native-build.mjs` は `origin/master` が HEAD の ancestor であることを求め、`origin/master` が `d7521a12` より進んでいたため拒否した。branch の基点は変えない）。worker は統合 branch の評価 build（`ed84c0a5…`）を写した（db crate は変えていない）。before の `.node` は probe の初版（op の番号を lease の番地で振った版。親と子が同じ番地を使い、Native の内訳は混ざって使えない）で、before の Native の内訳は無い（renderer の側の値と H5 の 2 run を使う）。after の `.node` は probe の現行版。after の 2 run の renderer は hook の commit の deps の追加（`dropCarried`、安定した参照で挙動は同じ）の前の版。fixture・setup・手順は H5 と同じ（`dev-setup-1` の写し、各 N=30、別の起動） | 診断だけ | — | 不要 | 該当なし | — | 記録済み |

### 測定の結果（before：H5 の `h5-hook-1`・`h5-hook-2`（統合 branch）と `rsj-before-1`、after：`rsj-after-1`・`rsj-after-2`。p50／p90／max、Raw-ready からの ms）

| 項目 | before（run1；run2；run3） | after（run1；run2） |
|---|---|---|
| 子が自分の D の窓に Graph を届けた（`graph-ready`） | 0；6；3（9/90。wrapper の到着が窓の中は 1；6；3） | 2；3（5/60） |
| 子の Graph の到着（子の Raw-ready から） | 14.7／17.5／24.5；13.2／15.6／17.3；13.5／16.8／22.9 | 13.6／14.5／15.5；13.8／14.4／14.9 |
| D の超過（p50） | 4.0；2.9；2.8 | 3.0；3.1 |
| 内訳：Graph の continue の queue の待ち | 6.2；4.7；5.1 | 0.1；0.1 |
| 内訳：Graph の continue の transport | 8.5；7.9；8.4 | 13.4；13.6（IR を待つ時間を含む） |
| 内訳：子の IR の到着 | 6.2／8.5／12.7；4.7／7.0／9.8；5.2／8.3／17.0 | 6.0／6.5／7.1；5.9／6.4／6.6 |
| Native（after、IR の slot から）：IR の再検証／Graph の `current_operation`／`assemble` | 未測定（before の probe は使えない） | 1.5／1.6／6.2；1.5／1.6／6.4 |
| `t_notice − t_raw_ready` | 17.0／26.0／57.3；19.4／23.5／37.8；21.4／46.3／49.3 | 16.6／17.6／18.0；16.3／18.4／29.1 |
| 通知から子の fetch の開始 | 404.7；404.8；404.1 | 1.2；1.4 |
| `t_follow − t_raw_ready`（子の `tReturnMs`） | 453.0／491.2／520.0；453.6／465.3／1,281.8；456.0／500.2／710.3 | 44.7／46.7／48.3；45.5／46.8／231.9 |
| 一覧が読込み中に替わった sample／読込み中の時間 | 30；30；30／435.1；434.3；435.6 | 0；0／なし（親の R+IR を表示したまま、spinner だけ） |
| 子が Graph なしで戻った件数 | 30；24；27 | 28；27 |
| 子の IR の timeout | 2；0；2 | 0；0 |
| 監査の行／sample | 10（IR の timeout の再試行の sample は 20〜30） | 10 |
| 机上の副作用 | — | 非 loopback の試み 0、socket の違反 0、`Dictionaries/` は空、Electron は close で終わり残りなし。`rsj-before-1` の check の session で `/tmp/.X11-unix` の一覧が変わった（別の lane の Xvfb の X2 が測定の間に消えた。自分の X0／X1 の前後は同じ） |

読み：after の Graph 付きの一覧（窓に届いた 5 件）は Raw-ready の約 45 ms 後に出る（before の約 453 ms）。窓に届かなかった子は、親とほぼ同じ R+IR の一覧を保ったまま入れ替わるだけで、読込み中の表示は無い。K6/4 への含意（候補で確認ではない）：A の定義（子が自分の D の窓に Graph を届ける）のままでは、この fixture の Native の DB の直列の仕事（IR の slot の後 約 9.3 ms）だけで D を超えるので、F6 は製品の経路で満たされない見込みが強い。T_show（表示までの上限）は after の max 231.9 ms で、2 s と 565.04 ms の候補の内側。

## 5. 独立レビューの P3 の修正（2026-10-25。P0／P1／P2 なし）

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-RSJ-10 | 2026-10-25 | RS-JOIN／review | **P3-2**：取り直しの fetch が reject した時の catch の `dropCarried()` に試験を足した（`drops the kept result when the refresh rejects`。外す変異で落ちる）。`recoverRaw` の `dropCarried()` は、呼び元 2 つ（then の invalidated、公開した世代の invalidation の購読）がどちらもその世代の答えの後で、保った結果は既に下がっているので消し、理由を comment に書いた。**P3-3**：pair の規則に「走っている item と command が異なる」を足した（同じ ticket の IR と IR、Graph と Graph は組まない）。試験 `never runs two items of the same command and pair together`（条件を外す変異で落ちる）。**P3-1**：`lease_probe` を `LeaseEnd`（`ir_state`、`ir_join`）で汎用化し、FakeOperation の lease で IR の continue の間だけ Pending と見る試験を足した（`ir_for_graph` を外す変異で落ちる）。`continue_query` の `join.enter()`、scoring の thread の `join.notify()`、`await_request` が `Some(&lease.data.join)` を渡す配線は実の Operation（Chronicle の proof）が要るので unit 試験を足さず、H5 の実機の計測で代替する（after の 2 run で、子の `g-enter` が `ir-set` の 3.9〜4.0 ms 前、`g-await-end` が `ir-current-end` の 0.0〜0.1 ms 後）。これらを外すと性能（待受けの起き方と順序）だけが落ち、正しさは Graph 自身の再検証（`current_operation`、gate、`assemble`、返却の直前の再確認）が保つ。**P3-4**：予算を最終の HEAD（この修正の後）で `pnpm build` から測り直した：raw 4,250,925（基点 4,250,669 から +256。上限 4,251,000 まで 75 byte）、gzip 1,343,172（上限の内側）。予算の commit の本文の +241／余白 90 は hook の commit より前の dist の値で、P3-3 の条件の分（+15）を含まない | renderer の UI 状態と資源の選択、試験だけ | — | 独立レビュー | 該当なし | §3 の L1、L2、N2（変更なし） | 記録済み |
