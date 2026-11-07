# CP-4：Chronicle の publish が親の begin より後になる件（run `lpd-diag-6-3` の 4 件）の dev 調査

dev 専用の枝 `claude/cp4-lp-diag`（merge しない・push しない）の記録。**integrator だけが見る診断で、CP-4 の判定・集計・閾値の選択に使わない**
（DR-CP4-LPD-1 の (4)）。製品のコード・契約・閾値・Gold・S2／S4 は変えていない。追加の run・build・cargo はしていない
（同じ run の出力と code を読むだけ）。前の記録は [lpd-gap3-diag-results-2026-11-07.md](lpd-gap3-diag-results-2026-11-07.md)（§2.3 の (a)）。
ユーザーの決定（2026-11-07）：隙間 3 は「自然な trace では 0、上限は未確認」で閉じ、この件の原因を dev で調べる。

**事実**（記録・code から確かめたもの）・**推論**・**案**を分けて書く。

## 0. 入力

- run：`lpd-diag-6-1`／`-2`／`-3` の `observation.json`（sha256 は前の記録の §0）。
- 集計 script：`.artifacts/cp4/analyze-chronicle-late.mjs`（sha256 `d28259544c86f536eee67bd78da2f83c24598f8082fe33029683d8439071011f`）→ `.artifacts/cp4/gap3/chronicle-late.json`（`a57057b7…7fb1`）。
  前の `analyze-gap3.mjs` と同じく gitignore 対象で、読むだけ。
- 時刻：commit の記録は native の eval clock。renderer の時刻（fetch・通知・保存の確認）は、harness の Native の読みの幅と begin の組の幅の交わり
  （native − renderer。run 3 は 635.15〜640.72 ms、半幅 2.8 ms）の中点で native に移した。以下の「親」は親の fetch の呼出しを native に移した時刻。

## 1. 4 件の並び（事実）

run 3 の counted query の index 53・62・100・132（親の fetch は renderer の seq 56・66・105・138）。時刻は親の呼出しからの ms、`#` は commit の記録の seq。

| | index 53 | index 62 | index 100 | index 132 |
| --- | --- | --- | --- | --- |
| 本文の保存（`body-save` tc1） | #728 −381 | #853 −386 | #1378 −386〜−192（区間 194 ms） | #1820 −382 |
| Freshness の予約（tc9） | #729 −173〜−170 | #854 −206〜−201 | #1379 −191〜−148 | #1821 −247〜−245 |
| Freshness の publish（tc5） | #730 −170〜−169 | #856 −196〜−195 | #1381 −142〜−141 | #1822 −244〜−243 |
| **Chronicle の publish、変更 0（tc0）** | **#731 −166〜−163** | **#855 −199〜−196**（予約と publish の間） | **#1380 −147〜−143** | **#1823 −232〜−227** |
| 親の begin 自身の audit（tc3、tc2） | #732 +7、#733 +22 | #857 +6、#858 +21 | #1382 +7、#1383 +21 | #1824 +5、#1825 +18 |
| 親の fetch の返り（renderer） | +23.7 | +22.1 | +22.1 | +19.5 |
| **Chronicle の publish（tc9）** | **#734 +106〜+111** | **#859 +72〜+77** | **#1384 +128〜+135** | **#1826 +46〜+53** |
| tc0 の終わり → tc9 の終わり | 274 ms | 273 ms | 278 ms | 280 ms |
| `index-ready`（renderer） | +111.0 | +76.9 | +134.3 | +52.4 |
| 取り直しの fetch（renderer）→ 結果 | +521.5 → `graph-ready` | +487.7 → 同 | +540.7 → 同 | +460.1 → 同 |
| 親の結果 | `graph-unavailable:cancelled`、IR `index-unavailable`、`initialSnapshot.indexUsable=false`、開始時の封印は before／after とも Chronicle `dirty`・B clean | 同 | 同 | 同 |

- 4 件とも同じ並び：保存 → Freshness の予約（保存の区間の始まりから 135〜208 ms 後）→ **予約の終わりの 5〜18 ms 後に Chronicle の publish が変更 0 で終わる** →
  **約 250 ms 後**に Chronicle の publish（変更あり）→ `index-ready`。親の begin はその間（保存の約 385 ms 後）に入った。
- 親の begin には native の Graph の記録（`nir1GraphEvalSamples` の record）が無い。取り直しの 4 回には record がある（run 3 の 202 件＝親 197＋取り直し 4＋child 1）。
- **run 1・2 には同じ形が無い**：保存と親の間に、変更 0 の Chronicle の publish が 1 件も無い。変更 0 の publish は run 1／2／3 で 8／8／7 件あり、
  run 1・2 の 16 件と run 3 の 3 件は、すべて保存の 5.0〜5.2 s 後（その cycle の親より後）に起きている。
- 以前の診断 run（`lpd-diag-1`〜`5`、master `8dd7a9c0` 系の build、1,005 件）では、親の begin で `indexUsable=false` は 0 件、開始時の封印の after で Chronicle `dirty` も 0 件。

## 2. publish を起こした契機と、250 ms の遅れ（code と記録）

### 2.1 code（事実）

- 予約：begin の最後で `build::schedule`（`related_scenes/begin.rs`）が呼ばれ、`schedule_with`（`related_scenes/build.rs`）が
  (DB の identity, project, generation) の key で `builds.reserve` する。key が予約済みなら何もしない。予約した task は
  `build_once` を回し続け、結果が `Ready`（publish が新しく使える索引を入れた）なら `related-scenes:index-ready` を emit し、
  **`Ready`・`Retry`・`ReaderRetry`・`Idle` のどれでも `RETRY_DELAY`（250 ms）眠ってから次の `build_once`**。`Stopped` と error だけが task を終える。
  つまり、task は 250 ms ごとに索引の要否を見る常駐の poller になる。
- `build_once`：reader（DR-IRB-3。専用の読取接続、slot 1 本）で prepare → embedding → `publish_chronicle_index_build_with_participant`。
- publish（`nir1_chronicle_index/publish.rs`）：`BEGIN IMMEDIATE` の中で `snapshot_current_with_control`（`nir1_chronicle_index/build.rs:330`）が、
  prepare の時の snapshot と今を比べる。比べるのは、generic freshness の canonical、binding（`Reserved` なら不一致）、prior、semantic epoch、
  eligibility の roster の digest、input guard、言語、**pending feed**（`pending::read(...) != snapshot.feed`）、edge の評価。
  不一致なら transaction は何も書かずに終わり、`NirIndexPublishRead::Stale` → `BuildOutcome::Retry`。
  publish の本体（`publish_chronicle_index_build_in_tx`）は metadata などを必ず書くので、**変更 0 で終わった publish の区間は Stale（か epoch の不一致）の印**になる。
- K の counter（`MAX_CONSECUTIVE_READER_RETRIES = 40`）は reader 起因の `ReaderRetry` だけを数え、`Retry`（Stale）で 0 に戻る。この件には関わらない。
  E7（待つ側の上限）は transition／shutdown の待ちの上限で、未実装（`irb-decisions.md` の DR-IRB-3）。この件には関わらない。

### 2.2 契機の推定（推論。記録と code の突き合わせ）

- 契機の Scene と保存：4 件とも、直前の本文の保存（`body-save` の tc1。trace の編集は query の Scene だけ）で Chronicle が dirty になり、
  常駐の build task の次の poll が prepare した。どの Scene の index build かは計装の範囲外（Chronicle の索引は project 単位）だが、
  この trace で保存するのは query の Scene だけなので、その保存の後の build と読む。
- 1 回目の publish が Stale になった理由：その build の prepare の後・publish の前に、**Freshness の予約（と publish）の commit が入った**。
  記録では、変更 0 の publish は Freshness の予約の終わりの 5〜18 ms 後に終わっている（index 62 は予約と Freshness の publish の間）。
  予約は binding・pending feed を動かすので、`snapshot_current_with_control` が false になる（どの比較で落ちたかは計装していない）。
- 2 回目の publish が遅れた理由：`Retry` の後の **250 ms の `RETRY_DELAY`**。tc0 の終わりから tc9 の終わりまで 273〜280 ms
  ＝250 ms＋次の build（prepare〜publish）約 23〜30 ms。
- ふつうの cycle：保存 → Chronicle の publish は中央値 194〜202 ms（Stale なし）。Freshness の予約は保存から 0〜1,000 ms に一様に散る
  （100 ms 刻みのヒストグラムがほぼ平ら。scheduler の 1 s の idle poll と合う）。Freshness が保存の 300 ms 以内に走った cycle は 1 run に 54〜57 あるが、
  Stale になったのは run 3 の 4 件だけ。**Stale は「Freshness の commit が build の prepare〜publish の間に入る」ときだけ起きる**（推論）。
  その間の長さは計装していない（上の再試行の build は約 23〜30 ms）。

## 3. publish が begin の後に来ると、なぜ表示が欠落するか

### 3.1 製品（code。事実）

1. begin（`related_scenes/begin.rs` の `begin_blocking`）は、最初の読みで `read_chronicle_query_status_with_control` を読み、
   `index_usable` が false なら **IR の operation を作らない**（ticket なし、`ir = unavailable("index-unavailable")`）。
2. Graph は `graph::begin_graph` に lease が無いので `GraphUnavailable::NotRequested` を返し、**owner に触れない**（worker の query も
   eval の sample の record も作られない）。
3. renderer の join（`nir1RelatedScenesGraphJoin.ts` の `publish`）は、`completion.outcome === "ir-unavailable"` を `stopped` とし、
   **`graphOutcome = "graph-unavailable:cancelled"`**。表示は R だけ（`fuseNir1RelatedScenes` に IR unavailable）。
   名前は `cancelled` だが、取消し（`index-ready` による世代の取消し）ではなく、**開始時に Chronicle の索引が使えなかった**ことによる。
4. hook（`useNir1RelatedScenes.ts`）：保存で始まる query の effect は 400 ms の timer（`FETCH_DEBOUNCE_MS`）で begin する。
   その待ちの間に `index-ready` が来れば timer を 400 ms で張り直す（LP-A1、DR-WF-9 の `rearm`）。**ふつうの cycle では
   `index-ready` が保存の約 200 ms 後に来るので timer が張り直され、親は `index-ready` の約 400 ms 後**（renderer で中央値 403 ms）に、
   使える索引で begin する。4 件は `index-ready` が timer の満了（保存の約 400 ms 後）より遅れたので、begin が先に出た。
   begin の後の `index-ready` は通常の refresh になり、400 ms 後の取り直しは `graph-ready`。
- つまり、親の IR／Graph の結果が「古い generation になって join で捨てられた」のではない。**親の begin の時点で IR も Graph も始まっていない**。

### 3.2 harness の規則 (i)（事実と推論）

- 規則の文面（K6/2 の `graph-eval-procedure`。`nir1-final-request-eval-proposal-2-draft.md` 211 行）：
  「Chronicle の Index が止まる間は、融合の規則で Graph も止まる。`graph-eval-procedure` は、これらを失効率の (i)（index の再 build 待ち）として数え、
  承認の失効と分けて記録する」。84 行：「(i) は B の seal によるものと Chronicle の停止によるものに分けて記録する」。
- harness の実装（事実）：`run-sample.mjs` の `snapshotOf` は Chronicle を U の条件に入れない（「P2-4: rule 3 (i) keeps a Chronicle stop in U」）。
  `irOutcomeOf` は `initialSnapshot.indexUsable === false` のとき `index-unavailable`。`join.mjs` の `lapseKind` は、
  `snapshot.usable !== true` か `registration-unavailable` なら `i-b-seal`、次に `irOutcome === "index-unavailable"` なら **`i-chronicle-stop`**。
- 4 件に当てはめると（推論。run 3 は harness の行が作られていない）：開始時の封印は B が before／after とも clean で同じ generation
  （`startSealOf` は `current`）、`indexUsable=false` → **U に入り、(i) の `i-chronicle-stop` として失効率の分子に入る**形。
- ただし今の harness では、**(i) として数えられる前に trace が対応しなくなる**（事実）：`alignSeededBegins`（`trace-record.mjs`）は、
  seed つきの begin の数が native の record の数より多いと「`N seeded begins, M records`」で対応を取りやめ、全行が `rowError` になり、
  受領書は `invalid`（run 3 の受領書の `native.alignment.reason` が「206 seeded begins, 202 records」）。上の 2. のとおり、
  Chronicle が止まった begin は native の record を作らないので、**この形が 1 件でも起きた run は、正式の手順では無効の run になる**（推論。
  dev preview と同じ関数。正式の run で起きた例は無い）。

## 4. 起き方の条件と、正式の候補で起きうるか

### 4.1 条件（推論。記録と code から）

1. Freshness の cycle（1 s の idle poll、位相は一様）の予約・publish の commit が、Chronicle の build の prepare〜publish の間に入る（Stale）。
2. Stale の後の 250 ms の `RETRY_DELAY` で、次の publish が保存の区間の始まりから 435〜521 ms 後になる。
3. hook の timer（保存の約 400 ms 後。`index-ready` で張り直されなかった場合）が、その publish より先に満了して begin する。
- 2 と 3 で、Stale が保存の約 110 ms 後より後に起きればほぼ必ず begin を越える（Stale の時刻＋250＋build 約 25 ms > 約 385 ms）。4 件の Stale は
  保存の区間の始まりから 156〜243 ms 後（index 100 は保存の区間が 194 ms と長い）。
- 頻度：Stale が保存と親の間に起きた cycle は 0／0／4（各 200）。起きた 4 件はすべて begin を越えた。
- body-save の頻度：この trace の保存は cycle に 1 回（tc1 が 200／run）。保存が増えれば build の回数が増え、Stale の機会も増える（推論）。
- K（40）、E7 は関係しない（§2.1）。build の debounce は無い（常駐の poller の 250 ms 間隔が実質の debounce になる）。

### 4.2 run 3 だけに出た理由（未確認）

- run 3 は eval build と smoke の直後で、開始時の 15 分の load が 4.30（run 1・2 は 1.61、1.02）。index 100 では保存の commit に 194 ms かかった。
  load が prepare〜publish の間を長くし、Stale の確率を上げた、という読み（推論。間の長さは計装していない）。
- 以前の診断 run（1,005 件）で 0 件だったことは、build の違い（#815 の reader で prepare が Main の接続から外れた、#807／#810 で prepare が速くなった、
  #802 で窓が 40 ms になった など）でも説明できるし、偶然（0.67% 前後なら 1,005 件で 0 件の確率は約 0.1%）でも説明しきれない。どれかは未確認。

### 4.3 正式の候補で起きうるか（推論）

- 機構は製品のコード（build の常駐の poller と 250 ms の再試行、publish の Stale 判定、Freshness の 1 s の poll、hook の 400 ms の timer）だけで成り立ち、
  dev の計装に依らない。**今の master から作る正式の候補でも起きうる。**
- dev の計装が時刻をずらした可能性：Freshness と Chronicle の publish の区間で `total_changes()` と `PRAGMA data_version` を 2 回ずつ読む（µs のオーダー）、
  renderer 起点の SQL で同じ読みが 1 回。Chronicle の prepare（reader）と embedding には計装が無い。Stale の窓（数十 ms）と 250 ms の構造を変えるほどではないと見るが、
  確率（窓の長さ）への影響は否定できない。
- 正式の測定 s5r6 の候補 `cbf33077` は #815・#802 より前。今の master の候補では、§3.2 のとおり起きれば run が無効になる（その前に手順の新しい版が要る点は
  前の記録の §2.1）。

## 5. 追加の計装・run の要否と、最小の案

機構（§2・§3）は、今の記録と code で説明がつく。**直す方向を選ぶだけなら追加は要らない。** 要るのは「どれくらいの頻度で起きるか」と
「run 3 の load が効いたか」を言いたい場合。

- **案 A（計装なし、run だけ。推奨）**：同じ build（`.node` `8b2b7ae4…`、worker `15e5a189…`）で編集 trace 200 cycles をもう 3 回、静かな状態で
  （前の run の guard と同じ）。`analyze-chronicle-late.mjs` で「保存と親の間の変更 0 の Chronicle の publish」と「親の begin で `indexUsable=false`」を数える。
  所要は約 16 分×3＋確認で約 1 時間。build・cargo は不要。
- **案 B（小さな dev 計装を足す）**：Stale の窓の長さと、Stale の比較の内訳を直接見る場合。(1) `build_once` に区間の記録を足す（closed word で
  `chronicle-build`、開始・prepare の終わり・embedding の終わり・結果〔`ready`／`retry`／`reader-retry`／`idle`／`stopped`〕。既存の ring に入れる）、
  (2) `snapshot_current_with_control` が false を返した比較の名前（closed word。binding／prior／epoch／roster／input-guard／language／feed／edge）、
  (3) begin で `index_usable=false` だった回の印（closed word と時刻だけ）。dev の枝・feature の下だけ。実装と試験で 1〜2 時間、build 約 7 分、run 3 回で約 1 時間。
- 案 C（#815 の前後の A/B）は、直す方向の選択がそれに依るときだけ（build 2 つ、run 6 回で約 3 時間）。今は勧めない。

## 6. 直す方向の候補（製品の変更になるので案だけ）

| 案 | 中身 | 触れるもの | 再測定 |
| --- | --- | --- | --- |
| C1：Stale の後はすぐ取り直す | `BuildOutcome::Retry`（Stale）のときだけ 250 ms を待たずに（または短く）次の `build_once` を回す。連続の Stale には回数の上限 | build の lifecycle（owner／lifecycle の技術判断の範囲の見込み）。DR-IRB-3 の E11 の `RETRY_DELAY` は reader の再試行（K）と同じ定数なので、分けることを DR に書く。契約・閾値・Gold に触れない | 要（製品の変更。§8.2 の手順） |
| C2：Freshness の publish の後に build を起こす | Freshness の cycle の終わりに、常駐の build task を起こす（250 ms の眠りを待たせない）。または build の prepare を Freshness の区間の外に寄せる（gate と同じ考え方） | build と Freshness の lifecycle の順序付け。共有の `grimodex-db` の Freshness 側に通知の口が要る見込み。契約・閾値に触れない見込み（確認が要る） | 要 |
| C3：begin が短く待つ | begin の時点で Chronicle が dirty で、build が走っているなら、上限つき（例：数十 ms）で publish を待ってから snapshot を取る | begin の「待たない」性質、P（D の予算）と T_late、DSN の §3.5 の前提。K6/4 の「許さないもの」（IR の deadline・D′ の状態機械）に近い。**ユーザーの確認が要る見込み** | 要 |
| C4：hook で begin を `index-ready` まで待たせる | 保存の後、Chronicle が dirty の間は begin を出さない | hook の規則（DR-WF-3、DR-WF-9〜11）、K6/4 の hook の規則と `FETCH_DEBOUNCE_MS` の literal の検査（debounce は K6/4 の「許さないもの」）。**確認が要る** | 要 |
| C5：begin の時点の generation を固定する | Chronicle が dirty でも、直前に publish した索引（generation）で IR／Graph を返す | 本文の通常更新で旧 Index の eligibility を失効させる規則（l6-l9:113、:467）。proposal-2 の 101／103 行のとおり、変えるなら確認が要る。**契約の変更（委任の外）** | 要 |
| C6：join で新しい generation を受け入れる | 親の begin の後に来た `index-ready` の結果を、親の表示に合流させる | exact R（DSN §3.1）、最初の表示の窓 D、DR-RSJ-6。親には IR の operation が無いので、実質は取り直し（C4 と同じ型）。**確認が要る** | 要 |
| C7：harness で Chronicle の停止の begin を扱う | native の record の無い begin を、対応を壊さずに (i) `i-chronicle-stop` として数える（今は run が無効になる。§3.2） | harness（S2 の pin、S4 の凍結し直し）。製品は変えない。物差しの緩和ではない（数え方の欠陥の直し）が、手順の改訂なのでユーザーの確認が要る | 手順の新しい版で |

- 閾値・Gold に触れる案は無い。§5 の「採らない案」（緩和）にあたるものも無い。
- 推奨（integrator の意見。判断はユーザー）：まず案 A で頻度を見る。直すなら C1 か C2（契約に触れない見込みで、Stale の後の 250 ms を縮める）が最小。
  C7 は、製品を直すかどうかと別に、正式の手順の新しい版（D＝40 ms）を作るときに一緒に扱うべき欠陥。

## 7. 限界

- Stale の比較のどれが落ちたか、build の prepare〜publish の長さ、build の結果の label は計装していない（変更 0 の publish の区間からの推論）。
- 親の begin の native の時刻は renderer の時刻からの写像（±2.8 ms）。4 件の並びの結論（publish は begin の 46〜135 ms 後）は、この幅より十分大きい。
- 契機の Scene は計装していない（この trace で保存するのは query の Scene だけ）。
- 3 run。run 3 は load が高い状態で走った。dev fixture・dev build で、正式の trace（S4b''''）の拍子とは違う。
- harness の (i) への当てはめは推論（run 3 は行が作られていない）。

## 8. script の sha256

- `.artifacts/cp4/analyze-chronicle-late.mjs`：`d28259544c86f536eee67bd78da2f83c24598f8082fe33029683d8439071011f`
- `.artifacts/cp4/gap3/chronicle-late.json`：`a57057b7a413b936d417132c1519f580f4328bb55f4bd3d600fbd7e6eb817fb1`

## 9. 追記：run 4〜6 の頻度（2026-11-07）

dev 専用・integrator だけが見る。CP-4 の判定・集計・閾値には使わない。製品のコード・run・build・cargo は触っていない（追加の run 4〜6 の出力を読んだだけ）。
§5 の案 A の実施結果。run 4〜6 は同じ build・setup、各 200 cycles（log：`.artifacts/cp4/lpd-diag-6.log`、2026-11-07 00:02〜00:52Z）。

### 9.1 入力と `OFF`（native − renderer の時計の差）

- 求め方（§0 の「harness の読みの幅と begin の組の交わり」の中身。前の記録に式は無かったので、run 1〜3 の値を再現して確かめた）：
  (1) harness の `traceAlignment().clock.readClockMs`（Native の読みの前後の `clockNs` から出す幅）、
  (2) native record と renderer の `related_scenes_begin` の api 行を、`graph-unavailable:cancelled` の fetch を除いて 1 対 1 に組み、
  `hi = min(record.tBeginNs − calledAt)`、`lo = max(record.tReturnedNs − resolvedAt)`（`analyze-gap3.mjs` の `offsetRange`）。**OFF = (1) と (2) の交わり**。
  run 1〜3 は前回の手入力の値と完全に一致した（run 1・2 は (1) が、run 3 は下限が (1)・上限が (2) が決める）。
- 値（ms、半幅 2.6〜2.8）：

| run | OFF 下限 | OFF 上限 | 組の数 | 組から外した cancelled |
| --- | --- | --- | --- | --- |
| 1 | 645.917 | 651.417 | 202 | 0 |
| 2 | 662.060 | 667.571 | 201 | 0 |
| 3 | 635.149 | 640.716 | 202 | 4 |
| 4 | 673.667 | 679.080 | 202 | 6 |
| 5 | 598.760 | 603.949 | 204 | 1 |
| 6 | 627.322 | 632.681 | 201 | 1 |

- script：`.artifacts/cp4/analyze-chronicle-late-1to6.mjs`（`analyze-chronicle-late.mjs` の複製。OFF の手入力を上の計算に置き換え、run 1〜6 を回す。sha256 `188b757e…3222`）→ `gap3/chronicle-late-1to6.json`（`09dd5bbe…effd`）。
  数え上げは `gap3/post-1to6.mjs`（`9669fe5d…695e`）、OFF の確認は `gap3/off-probe.mjs`（`b3cfb4f1…3822`）。いずれも gitignore 対象。
  run 4〜6 の `observation.json` の sha256：`724844b4…e903`／`ab317747…ffca`／`efca3c92…e037`（前 8 桁＋後 4 桁）。
- run 1〜3 の再現：run 3 は 4 件（index 53・62・100・132、前回と同じ）、run 1・2 は 0 件。stale→publish の間隔も 273〜280 ms で一致。

### 9.2 数え方

- (a) = 保存と親の begin の間に、変更 0 の Chronicle の publish（Stale）がある cycle（Stale の終わりが親の呼出し〔native に写像〕より前）。
  保存の約 5 s 後の定期の変更 0 の publish（親より後）は含めない。
- (b) = (a) のうち、変更ありの publish が親の begin より後に終わった cycle（表示が欠落する形）。
- (c) = 親の begin 時の Chronicle の状態：fetch の `initialSnapshot.indexUsable` と開始時の封印の before／after の Chronicle `dirty`。

### 9.3 run ごとの結果

| run | load（15 分平均、開始時） | 親 | (a) | (b) | 親で indexUsable=false | cancelled |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.61 | 200 | 0 | 0 | 0 | 0 |
| 2 | 1.02 | 200 | 0 | 0 | 0 | 0 |
| 3 | 4.30 | 200 | 4 | 4 | 4 | 4 |
| 4 | 0.16 | 200 | 6 | 6 | 6 | 6 |
| 5 | 0.28 | 200 | 1 | 1 | 1 | 1 |
| 6 | 1.73 | 200 | 1 | 1 | 1 | 1 |
| 合計 | | 1,200 | 12 | 12 | 12 | 12 |

- run 4〜6 の 8 件は、run 3 の 4 件と同じ形：保存 → Freshness の予約（保存の 130〜223 ms 後。run 4 index 88 だけ、cycle の中に Freshness の予約〔tc>0〕が見つからず、Stale が保存の 3.6 ms 後。run 3 index 100 と同じく保存の区間が長い cycle）→
  変更 0 の publish → 271〜293 ms 後に変更ありの publish。その間に親の begin。tc0 の終わりから tc9 までの間隔は run 3〜6 の 12 件すべてで 271〜293 ms
  （250 ms の `RETRY_DELAY` ＋ build）。
- (c)：12 件すべてで、親は `indexUsable=false`、封印は before／after とも Chronicle `dirty`（B は clean）、結果は `graph-unavailable:cancelled`（§3.1 の「開始時に Chronicle の索引が使えない」）。
  逆に `indexUsable=false` の親は、(a) 以外では 0 件。つまり OFF に依らない数え方（`indexUsable=false` の fetch の数）も 0／0／4／6／1／1 で同じ。
- 1 件の注意：run 6 index 89 は、Stale の終わり（保存の 392.8 ms 後）が親の呼出し（392.9 ms 後）と OFF の幅（±2.7）の中で入れ替わりうる。
  Freshness の publish に 215 ms かかった cycle（予約 172.8 → 388.3 ms）。親が `indexUsable=false` を見たことは OFF に依らない。
  OFF の中点では Stale の方が 0.1 ms 先で (a) に入るが、厳密に順序を確かめられない。入れない数え方では (a)＝(b)＝11 件（11/1,200）。
- (b) の変更ありの publish は、親の begin の 52.8 ms 以上後（最小は run 3）。

### 9.4 頻度

- 6 run 合計：(b)／親の総数 ＝ 12／1,200 ＝ **1.00%**、Wilson 95% 区間 0.57〜1.74%（run 6 の 1 件を除く 11／1,200 は 0.92%、0.51〜1.63%）。
- run 4〜6 だけ：8／600 ＝ 1.33%（0.68〜2.61%）。run 3〜6：12／800 ＝ 1.50%。run 1・2：0／400（3/n の上限で約 0.75%、Wilson の上限 0.95%）。
- run ごと：0、0、4、6、1、1（各 200）。

### 9.5 負荷との関係

- 開始時の 15 分平均の load と件数：1.61→0、1.02→0、4.30→4、0.16→6、0.28→1、1.73→1。**最も静かだった run 4（0.16。1 分平均 0.01）が最多の 6 件**。
  Spearman の順位相関は −0.15（15 分平均）、−0.48（1 分平均）、−0.15（5 分平均）で、n＝6 のため有意ではないが、「高負荷で増える」向きではない。
- 「負荷が高いときだけ起きる」は否定される（低負荷の run 4・5 で計 7 件）。run 3 の load が効いたという §4.2 の読みも、run 3 だけでは支えられない（run 6 は 5 分平均 2.36 でも 1 件）。
- 一方で「負荷に関係なく一定の割合」とも言い切れない：run ごとの件数は一様でなく（各 run の期待 2 件に対し χ² ＝ 15.0、自由度 5、p ≈ 0.010）、run 1・2 が 0／400、run 3・4 が 10／400。
  run 1・2 に出なかった理由は分からない（偶然なら、率 1% で 400 件に 0 件の確率は約 1.8％。12 件を 1,200 の親に無作為に散らして run 1・2 の 400 件に 0 件の確率は約 0.7％）。
  負荷は開始時の 15 分平均しか記録していない（run 中の load・CPU・ディスク待ちは未記録。run 5・6 の開始時の値には直前の run 自身が含まれる）。

### 9.6 補助：Stale の機会と実現

- 機構（§2.2）では、Freshness の予約が保存の約 125〜225 ms 後に入る cycle で Stale になる。この範囲に予約が入った cycle は run ごとに 13〜21 件（6 run で 102 件）、
  そのうち Stale が起きたのは run 1〜6 で 0／19、0／16、3／16、5／21、1／17、1／13（計 10／102）。run 1・2 は 0／35、run 3〜6 は 10／67（Fisher の片側 p ≈ 0.012）。
  この範囲は 12 件の観測から事後に決めた目安で、範囲の外（run 4 index 88 など）にも 2 件あるため、確率の推定には使わず、「機会の数は run 間でほぼ同じ（Freshness の位相は一様）で、Stale になる割合が run 間で違った」ことの確認にとどめる。

### 9.7 言えること・言えないこと

- 言える：(1) 製品の今の build で、**負荷が低い状態でも**、親の begin が Chronicle の再 publish より先に来て `indexUsable=false`（graph-unavailable:cancelled）になる cycle が起きる（run 4：6／200）。
  (2) 起きた 12 件はすべて §1 と同じ形（Stale → 約 250 ms の遅れ → 変更ありの publish）で、親の begin の時点で開始時の封印が Chronicle `dirty`。
  (3) 合計の頻度は約 1%（95% 区間 0.6〜1.7%）で、前の記録の「0.67% 前後」（§4.2）と矛盾しない。この編集 trace では 1 run（200 親）に平均 2 件、0 件の run もある。
  (4) §3.2 のとおり、この形が 1 件でも起きた run は正式の手順では無効になる（run 3〜6 の `traceAlignment` はすべて aligned=false。206／208／205／202 の begin に対し record 202／202／204／201）。
  率 1% が一定なら、200 cycles の run のうち 1 件以上起きるのは約 87%（1−0.99^200）。実際は 6 run 中 4 run。
- 言えない：(1) run 間のばらつき（run 1・2 の 0 件）の原因。load では説明できず、未記録の要因（run 中の資源、Stale の窓の長さ）は推論にとどまる。
  (2) 窓の長さ・Stale の比較の内訳は計装していない（§7）。(3) 正式の trace（S4b''''）の拍子・master の候補での頻度（dev fixture・dev build の値。#815 以前の run では 1,005 件で 0 件だった点は §4.2 のとおり未解明）。
  (4) 保存が増えたときの頻度の変化。
