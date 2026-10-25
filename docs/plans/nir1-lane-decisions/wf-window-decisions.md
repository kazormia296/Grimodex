# WF-WINDOW の委任判断の記録（follow-up の子の Graph の窓 W_f。K6/4 の批准 12）

出所は K6/4（draftRef `nir1-final-request-eval-proposal/4`、contractId `graph-eval-procedure`、draft の SHA-256 `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`。2026-10-26 00:41 JST にユーザーが確認）の批准 12 と、「設計」の「W_f を製品に入れる変更」の節である。基点は統合 branch `claude/nir1-cp4` の `d7521a12` に `origin/master`（`8e93bb31`。RS-JOIN #722、K6/4 の取込み #723 を含む）を merge したもの、branch は `claude/wf-window`。

目的：`graph-ready` を契機にした取り直しの世代（子）の合流にだけ、Graph の成分の窓を D（10.84 ms）から W_f（100 ms）に広げる。子の合流は Graph の到着か W_f の満了まで公開せず、公開は 1 回だけ。その世代の契機の印と、合流に渡した Graph の窓の値を `timing` に出す（評価でだけ読む）。

変えないもの（K6/4 の批准 9）：D の値と最初の表示（親）の合流、IR の deadline（子も D）、debounce、次 query 用の cache、D′ の状態機械、`graph-ready` の通知、IPC の lane、Native（`GRAPH_AWAIT_LIMIT` 2 s と operation の TTL 300 s は W_f より長い）、「遅れた結果は既に描画した join に混ぜない」、鮮度・再検証・監査・保存の契約、閉じた gate（`PRODUCT_GRAPH_PUBLISHED=false`、`NIR1_GRAPH_UI_ENABLED = false as const`、`BODY_DECLARATION_UI_ENABLED=false`、`PROFILE_ACTIVATION_UI_ENABLED = false as const`、`PrePublicationEntry::ProfileActivation`）。

記録の順序：§1〜§3 は製品の編集と変異の前に書いた。§4 は実装後の追記。

## 1. 事実の確認（merge の後の `91497f0f` のコード）

| 事実 | 確認の結果 |
|---|---|
| 合流の窓 | `nir1RelatedScenesGraphJoin.ts` の `awaitNir1RelatedScenesWithGraph` は、IR の deadline（`createNir1RelatedScenesDeadline`、Raw-ready ＋ `RELATED_SCENES_IR_EXTRA_WAIT_MS`）1 つを IR と Graph の両方に使う。timer は deadline で発火し、IR が無ければ IR の timeout、IR が ready なら `graph-late` で公開する。`onGraph` は deadline 以降の Graph を捨てる（:253-257）。公開は `published` の guard で 1 回（:114-116）で、ticket の宣言（`onGraphSettled`）も公開の 1 回だけ |
| 子の世代 | `useNir1RelatedScenes.ts` の query の effect で、`graph-ready` の通知（または fetch 中に来た通知）が `graphReadyRefresh` を立て、query の鍵が前の run と同じとき `byGraphReady` になる（RS-JOIN、DR-RSJ-6）。その effect の最初の `run()` が子の世代。同じ effect の中の IR の timeout の再試行（`run()`）と `recoverRaw`（`run(true)`）は別の契機。index-ready、Graph-only の取消しの refresh、鍵の変化は `byGraphReady` にならない |
| 中断 | session は fetch の `signal` の abort で `stop("cancelled")` し、観測者に知らせる（`nir1RelatedScenesSession.ts:76-78`、109-110）。合流の `subscribeInvalidation` が即座に公開する（cancelled／invalidated）。W_f の待ちの間も同じ |
| Native の上限 | `GRAPH_AWAIT_LIMIT` = 2 s（`electron/native/grimodex-node/src/related_scenes/graph.rs:43`）、operation の TTL = 300 s（`related_scenes.rs:36`）。どちらも W_f（100 ms）より長いので、子が W_f まで待っても Native の待受けは先に `timeout` にならない |
| `timing` の読み手 | `src` の製品のコードで `Nir1RelatedScenesFetchResult.timing` を読むものは無い（書くのは `fetchNir1RelatedScenes.ts` だけ。読むのは試験と `scripts/quality/nir1-graph-eval` の harness） |
| 起動時の JS graph | 4 file は lazy の `SceneContextPanel-*.js` に入る（D の定数の文字列で確かめた）。merge の後の実測は raw 4,250,925、gzip 1,343,311（上限 raw 4,251,000） |

## 2. 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-WF-1 | 2026-10-26 | WF-WINDOW | **定数の置き場所**。`relatedScenesConfig.ts` の D の隣に `RELATED_SCENES_FOLLOW_UP_GRAPH_WINDOW_MS = 100` を置く（K6/4 の判断 2 の推奨でユーザーが確認した値）。D の定数は変えない | renderer の定数だけ | 合流の module に置く（D と離れ、狭めるときに両方を見落とす） | 不要 | 該当なし | — | 記録済み（編集の前） |
| DR-WF-2 | 2026-10-26 | WF-WINDOW | **合流：Graph の成分の窓を IR の deadline と分ける**。`awaitNir1RelatedScenesWithGraph` に任意の `graphWindowMs`（省略時は D）を足す。有限で D 以上でなければ throw（W_f を D より短くしない。狭めるのは K6/4 の「変える点」の 16 の範囲で別に扱う）。IR の deadline は今のまま D の deadline 1 つ（子も D。K6/4 の技術点 3）。timer の的：IR が未着なら IR の deadline（IR の timeout は子でも D で公開し、W_f を待たない）、IR が ready で Graph が未着なら Raw-ready ＋ `graphWindowMs`。`onGraph` は Raw-ready ＋ `graphWindowMs` 以降の Graph を捨てる（親は D のままなので今と同じ）。公開は今の `published` の guard の 1 回だけで、IR が ready でも Graph か窓の満了まで公開しない（二段公開しない）。結果に使った `graphWindowMs` を返す | renderer の待ちの長さだけ。再検証は Native（返却の直前の再確認）と requalification のまま、cache・TTL・宣言の規則は変えない | (a) 子の IR にも W_f を当てる（IR の deadline の緩和。K6/4 の技術点 3 で不採用）、(b) D で R+IR を公開し W_f の内の Graph を後から足す（二段公開。批准 12 で禁止）、(c) deadline の helper を 2 つ作る（IR の completion の owner が 2 つになる） | 不要（批准 12 の範囲） | 該当なし（D・IR の deadline・混ぜない規則を変えない） | §3 の J1 | 記録済み（編集の前） |
| DR-WF-3 | 2026-10-26 | WF-WINDOW | **子の判定**。hook は `byGraphReady` の effect の最初の `run()` にだけ契機 `"graph-ready"` を付け、`fetchRelatedPastScenes` の option `refreshTrigger: "graph-ready"` で渡す。fetch は契機が `"graph-ready"` の query の合流にだけ W_f を渡し、ほかは D を渡す。IR の timeout の再試行、`recoverRaw`、index-ready、取消しの refresh、鍵の変化、最初の mount は契機なし（D）。`graph-ready` 起点の世代がさらに `graph-ready` で取り直す連鎖（DR-RSJ-6 で debounce 400 ms）も契機は `graph-ready` なので W_f を渡す（K6/4 の F4 は「親の次の世代」を観測で求めるので、連鎖の世代は receipt の側で F4 により子から外れる） | renderer の UI の状態だけ | (a) hook が窓の値そのものを渡す（閾値の対応が hook と fetch に分かれる）、(b) 連鎖を D に戻す（契機の印が `graph-ready` なのに窓が D になり、N30 の「印と窓の値」の照合が二通りになる） | 不要 | 該当なし | §3 の H1 | 記録済み（編集の前） |
| DR-WF-4 | 2026-10-26 | WF-WINDOW | **`timing` の契機の印と窓の値**。`Nir1RelatedScenesFetchResult.timing` に `refreshTrigger`（`"graph-ready"` か `null`）と `graphWindowMs`（Graph の合流に渡した値、合流が無い query は `null`）を足す。`fetchNir1RelatedScenes.ts` はすべての出口で両方を書く。型は既存の試験の fixture を変えないため任意（`?`）にする。製品は読まない（§1）。新しい入口・保存先・送信先を作らない | 評価でだけ読む値。外へ出ない | 結果の top level に置く（製品の UI の型に評価の値が混ざる）、Native の begin の記録に足す（Rust の変更になり批准 9 の範囲外） | 不要 | 該当なし | §3 の F1 | 記録済み（編集の前） |

## 3. 影響マトリクスと owner／lifecycle の matrix（GDX-PRECHECK-001。編集と変異の前に記録）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| J1 | Graph つきの合流（親・子・ほかの契機） | `nir1RelatedScenesGraphJoin.ts` | `graphWindowMs`（省略時 D、有限で D 以上）。IR の deadline は D のまま | `fetchNir1RelatedScenes.ts` | 公開 1 回、ticket の宣言 1 回、窓の後の Graph を混ぜない、IR が ready のときだけ Graph を使う、IR の timeout は D で公開 | 省略時は今と同じ（親とほかの契機） | 合流の試験（子の窓・1 回の公開・窓の後を混ぜない・子の IR の timeout は D・親は D・値の検査） | planned |
| F1 | fetch の Graph の合流と `timing` | `fetchNir1RelatedScenes.ts` | option `refreshTrigger` を窓の値に写す（`"graph-ready"` → W_f、ほか → D）。`timing.refreshTrigger`／`timing.graphWindowMs` | hook、評価の harness | 窓の値は 2 つだけ、Graph の合流が無い query は `graphWindowMs: null`、release の順序（宣言の後）は変えない | option なしは今と同じ | fetch の試験（子は W_f の内の Graph を受ける、契機なしは D、unseeded・rawOnly・begin で Graph unavailable は `null`） | planned |
| F2 | Graph なしの合流（unseeded）、rawOnly、早期の出口 | `awaitNir1RelatedScenes.ts`、`fetchNir1RelatedScenes.ts` | 変えない（`timing` の 2 項目だけ書く） | — | IR の D | — | 既存の試験 | planned（`timing` だけ） |
| H1 | hook の世代の契機 | `useNir1RelatedScenes.ts` | `byGraphReady` の effect の最初の `run()` だけ `refreshTrigger: "graph-ready"` | `fetchRelatedPastScenes` | debounce、世代ごとに 1 回の refresh、一覧を保つ（DR-RSJ-6）、再試行・recoverRaw・index-ready・取消しの refresh は契機なし | 契機なしは今と同じ | hook の試験（子だけに印、再試行と index-ready に印なし、子の結果は 1 回で置き換わる） | planned |
| X1 | Native（待受け、cache、TTL、`graph-ready`）、IPC の lane、Main、preload、wire、D′、`awaitNir1RelatedScenes` の IR の deadline、`RelatedScenesSection` | — | 変えない | — | — | — | 既存の試験 | verified unchanged（編集なし） |

lifecycle note：

- J1：入口は `awaitNir1RelatedScenesWithGraph` の 1 箇所。公開の owner は合流の Promise で、`published` の guard が 1 回にする。終わる経路は 6 つ：IR の非 ready（即時）、IR が ready で Graph が既着（即時）、Graph が窓の内に着いて IR が ready（即時）、timer（IR が未着なら IR の deadline で IR の timeout、IR が ready なら窓の満了で `graph-late`）、session の invalidation／cancel（即時）、IR が遅れて着いた（`completeIr` が `timeout`。即時）。**窓の満了と Graph の到着の競合**：どちらも同じ event loop の上で `published` を見るので、先に走ったほうだけが公開する。Graph の到着が窓の時刻以降なら `onGraph` が捨て、timer が `graph-late` で公開する。timer が窓の時刻より早く起きたら張り直す（今の `arm` と同じ）。待ちの上限は W_f（子）か D（ほか）で、Native の `GRAPH_AWAIT_LIMIT`（2 s）より短い。timer は `cleanup` で外す。宣言（`onGraphSettled`）は公開の中の 1 回で、release は宣言が Native に届いた後（`output` の `graphWait.settled()`。変えない）。
- F1：子が W_f まで待つ間、子の session と operation は合流の公開まで生きる（今の D と同じ owner、長さだけ最大 W_f）。abort（場面の移動、unmount）は session の `stop("cancelled")` で合流を即座に公開させる。永続の状態なし。
- H1：保った親の結果と session（`carried`）は、子が公開するまで最大 W_f 長く保たれる。終わる経路は DR-RSJ-6 の 4 つのまま。契機の印は effect の closure の値で、ref を足さない。

## 4. 実装後の追記（2026-10-26）

§3 の J1、F1、F2、H1 は implemented、X1 は verified unchanged（Native、IPC の lane、Main、preload、wire、D′、`awaitNir1RelatedScenes`、`RelatedScenesSection` は編集なし）。

commit（`91497f0f` の上。製品の 2 本は harness の file に依存せず、`git merge-tree --write-tree --merge-base 91497f0f origin/master <commit>` で `origin/master` `8e93bb31` への cherry-pick の衝突 0 を確かめた）：

| commit | 区分 | 内容 |
|---|---|---|
| `feat(nir1): graph-ready の取り直しの合流にだけ Graph の窓 W_f を渡す（K6/4 の批准 12）` | 製品 | DR-WF-1〜4 と試験 |
| `test(nir1): W_f の待ちの分岐と graph-ready の連鎖の印を試験で固める` | 製品（試験だけ） | 独立レビューの P3 の 1・2（DR-WF-6） |
| `test(nir1): H5 の診断で子の契機の印と Graph の窓を読み、W_f の窓で集計する` | harness | DR-WF-7 の測定の読取 |
| この docs の commit | docs | この記録と索引 |

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-WF-5 | 2026-10-26 | WF-WINDOW | **起動時の JS graph の予算**。変更は lazy の `SceneContextPanel-*.js` に入り、初期 graph は raw 4,250,925 → 4,250,925（±0）、gzip 1,343,311 → 1,343,223（上限 raw 4,251,000、gzip 1,350,000）。上限は変えない | — | — | 不要 | 該当なし | — | 記録済み |
| DR-WF-6 | 2026-10-26 | WF-WINDOW | **試験と変異と独立レビュー**。試験は合流 17 件（`nir1RelatedScenesGraphJoin.followUpWindow.test.ts`。値の検査 5 件を含む）、hook 6 件（`useNir1RelatedScenes.followUpWindow.test.tsx`）、fetch 5 件（`fetchRelatedScenes.nir1.test.ts` の末尾）。最初の版（合流 15、hook 5、fetch 5）は変更前のコードで 20 件が落ちた（合流の子の IR の deadline の 2 件、hook の index-ready の件、fetch の W_f の満了と子の IR の deadline の件は、変わらない挙動の characterization として通った）。変異 13 種はすべて落ちた：子に W_f を渡さない（3 件）、親にも渡す（2）、二段公開：timer を D に戻す（5）、ready の IR で即時に公開（19）、W_f の後の Graph を混ぜる（2）、印を全 query に付ける（3）、IR の timeout の再試行が印を継ぐ（1）、Raw の取り直しが印を継ぐ（1）、子に印を付けない（4）、`timing` の印を出さない（2）、子の IR に W_f（4）、`timing` の窓に D を書く（3）、窓の検査を外す（2）。独立レビュー（Opus、read-only）は P0〜P2 なし、P3 が 3 件：(1) 連鎖の印の試験が無い → 試験を足し、印を連鎖の外に絞る変異が落ちることを確かめた、(2) D と W_f の間に unavailable の Graph が届く枝と、abort なしに `isCurrent` だけが外れる枝の試験が無い → 2 件足した（後者は W_f の満了で cancelled を公開し、Graph を使わない。hook の経路はほぼ abort を伴う）、(3) 下の DR-WF-8 | 試験だけ | — | Opus の独立レビュー | 該当なし | — | 記録済み |
| DR-WF-8 | 2026-10-26 | WF-WINDOW | **開示（変えない）**。(a) index-ready と `graph-ready` の 2 つの `setRefresh` が 1 回の描画にまとまると、RS-JOIN の判定（`graphReadyRefresh` と鍵の一致）で `byGraphReady` になり、その query に契機の印と W_f が付く。RS-JOIN からの判定をそのまま使った（この lane で判定を変えると DR-RSJ-6 の一覧を保つ挙動も変わる）。K6/4 の F4 は親と子の間に index-ready が無いことを観測で求めるので、この query は receipt の側で X7 になる。(b) 子で IR が D までに来ず、D の timer の前に Graph が届くと、合流の Graph の outcome は `graph-unavailable:ir-not-ready`（宣言 `unused`）になる（親なら `graph-late`）。どちらも Graph を混ぜず、IR の timeout として扱われる。(c) IR の timeout の再試行の後の `graph-ready` の取り直しは、RS-JOIN の `startedByGraphReady` が effect の単位なので連鎖として扱われ（debounce 400 ms）、印と W_f が付く（wf-after-2 の 1 件で観測） | — | — | 不要 | 該当なし | — | 記録済み |
| DR-WF-7 | 2026-10-26 | WF-WINDOW | **測定（H5 の harness、診断だけ）**。下の表。条件：評価の `.node` は merge の後の `91497f0f` で `eval-native-build.mjs` を通して `.artifacts/cp4/eval-build/` に作った（Rust はこの lane で変えていない）。fixture・setup は RS-JOIN と同じ `dev-setup-1` の写し（cold DB の sha256 `75ffea13…`、seed の pin は harness が測定用の写しに足す）、model は manifest の sha と一致する固定の写し、各 N=30、別の起動。after は HEAD の製品、対照の before は同じ tree・同じ `.node` で製品の 5 file だけを `91497f0f` に戻した build（測定の後に戻した）。RS-JOIN の after の 2 run（`rsj-after-1`・`2`）は別の build なので参考に並べる | 診断だけ | — | 不要 | 該当なし | — | 記録済み |

### 測定の結果（p50／p90／max、子の値は子の Raw-ready から、`t_follow` は親の Raw-ready から、ms）

| 項目 | 参考：RS-JOIN の after（run1；run2） | 対照の before（`wf-before-1`） | after（`wf-after-1`；`wf-after-2`） |
|---|---|---|---|
| 子が Graph を受けて公開した（`graph-ready`） | 2；3（5/60） | 4/30 | **30/30；29/30（59/60）** |
| 子の Graph の到着（wrapper の resolve） | 13.6／14.5／15.5；13.8／14.4／14.9 | 12.8／14.7／18.3 | 14.0／16.5／17.4；13.4／16.3／19.8 |
| 子の窓の判定（その fetch の窓）／D の窓での判定 | — | 4／4 が窓内 | 30／30 が W_f 内（D なら 5）；30／30（D なら 4） |
| 子の公開（子の Raw-ready から） | — | 11.5／11.6／13.5 | 14.2／16.7／17.5；13.4／16.8／19.9 |
| 子の IR の到着 | 6.0／6.5／7.1；5.9／6.4／6.6 | 5.3／6.6／7.3 | 5.0／6.3／6.7；5.3／6.8／14.5 |
| `t_follow`（子の返却） | 44.7／46.7／48.3；45.5／46.8／231.9 | 44.7／48.6／216.7 | 47.8／51.7／270.3；51.3／100.2／240.1 |
| `t_follow`（React の commit、Graph つきの子だけ） | — | p50 42.4、max 46.5（4 件） | p50 48.1、max 270.4（30）；p50 51.5、max 240.3（29） |
| 一覧が読込み中に替わった sample | 0；0 | 0 | 0；0 |
| 子が Graph なしで戻った | 28；27 | 26 | 0；1（子の IR が 14.5 ms で D を超えた IR の timeout。子は D で R だけを公開し、W_f を IR に当てていない） |
| 親の公開（親の Raw-ready からの commit）と親の窓 | — | 11.7／11.9／12.8、窓の値なし（変更前） | 11.6／11.8／11.8；11.8／13.1／15.2。窓 10.84（D）30；30、印なし 30；30 |
| 子の契機の印／窓の値 | — | null／null（変更前） | `graph-ready`／100 が 30；30 |
| 通知の後の公開の数／子の結果の形の数（二段公開の検出） | — | 1（30）／1（30） | 1（30）；1（29）と 3（1）／1（30）；1（30） |
| `t_notice − t_raw_ready` | 16.6／17.6／18.0；16.3／18.4／29.1 | 16.7／19.6／20.9 | 16.2／17.7／28.6；17.8／39.9／47.2 |
| 子の Native の begin／D′ の counter | `Cached` | `pending>cached` 30 | `pending>cached` 30；29（1 件は再試行で `pending>cached>pending>cached`）。`deferredExpired`・`deferredDropped`・`prepareFailures`・`driftAtQuery` 0；0 |
| 親の IR の timeout | 0；0 | 0 | 0；1（親の IR 11.1 ms。親は R だけで `graph-late`、子は Graph を受けた。K6/4 では X11） |
| 監査の行／sample | 10 | 10 | 10；10（再試行の 1 件は 20） |
| 机上の副作用 | — | 非 loopback 0、socket の違反 0、`Dictionaries/` 空、Electron は close で終わり残りなし。prep の間に `/tmp/.X11-unix` の一覧が変わった（別の lane の Xvfb の X2 が消え X3 が出た。持ち主は別の lane の path） | 非 loopback 0、socket の違反 0、`Dictionaries/` 空、X11 の一覧は前後で同じ、残りなし；同じ |

`wf-after-2` の 3 回公開の 1 件：子（印 `graph-ready`、窓 100）の IR が D を超えて IR の timeout → hook の IR の timeout の再試行（印なし、窓 D）が `graph-late` → 2 回目の `graph-ready` の取り直し（連鎖、debounce 400 ms、印 `graph-ready`、窓 100）が Graph を受けた。各 fetch の結果は 1 回ずつ commit され、どの fetch も後から Graph を足していない（結果の形は fetch ごとに 1）。

読み：W_f を子の合流にだけ渡すと、この dev fixture では子の Graph（到着の max 19.8 ms）はすべて W_f（100 ms）の内に入り、子が Graph を受けて公開した割合は 4/30（対照）から 59/60 になった。代わりに子の公開は Graph を待つ分だけ遅れ（子の Raw-ready から p50 11.5 → 13.4〜14.2 ms）、`t_follow` の p50 は 44.7 → 47.8〜51.3 ms（一覧は保たれ、読込み中は 0）。親の窓は D のまま、印は子だけに付いた。G-case（実際の評価の fixture）は測っていない。
