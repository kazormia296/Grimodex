# NIR-1 CP-4：編集 trace に残る表示の欠落（失効と窓外）の別 lane の設計案（草稿）

状態：**草稿の改訂 2**（2026-11-03）。改訂 1（`5d68cadc`、`d81a5ae7`）の後に起きたこと（LP-A1 の merge、診断 run 3 回、背景の commit の調査、gate の実装と PR）を反映した（末尾の「改訂の記録」）。改訂 1 は未 push だが、その存在と「診断の前の版」であることはユーザーに示してある（contracts `02a8555a` の「提示した事実」）。この文書は製品・harness・fixture・S2・S4・閾値・Gold を変えない（docs だけ）。
基点：master `8dd7a9c0`（PR #776＝LP-A1 を含む。この branch へは `74e3b361` で merge）。§1 の測定は S4b'''（`60bf9dc4`）・候補 `22b74a25`（DR-CP4-S6-2、PR #775）。§2・§3 の file:line は、断りの無いかぎり改訂 1 の基点 `22b74a25` のもの（LP-A1 で `useNir1RelatedScenes.ts` の行は動いた）。
**HOLD は変わっていない。** 正式の再測定はしていない（§4）。

方向の確認（contracts の記録。「案 N」は記録ごとに別物を指すので、内容と hash を添える）：

| 記録 | 経路 | 内容 |
|---|---|---|
| `5cefa6da` | 自由記述「それで行きましょう」 | S7 の報告への返答。(A)＝HOLD を受け入れ、残る失効を別 lane で設計する、(B)＝N2／N4 は blocked のまま記録する。読みの変更・harness の修正・5 回目の S4 は選ばれていない。報告の「HOLD の理由は 1 つ」は不正確で、`5923890c` で訂正 |
| `74822833` | AskUserQuestion「対象を広げて設計を進める (推奨)」 | 訂正の後の確認。stale 4 と #139 を対象に含める。renderer の hook の直し（LP-A1）と、診断の計装（eval build の中だけ）まで |
| `8529e5b3` | AskUserQuestion「診断は走らせず、先に直し方の方向を話し合う」 | 診断 run を保留 |
| `814f5dc8` | 自由記述「案1で進めてください」 | ここでの案 1＝登録の identity を B の入力に絞る（LP-B3。契約の改訂）。範囲は新しい契約案の起案と独立レビューまで。**契約案は起案していない**（次の確認で前提が変わった） |
| `681e1cac` | AskUserQuestion「先に診断 run で原因を決める (推奨)」 | 診断 run を先に行い、契約案の要否は結果の後に再判断する |
| `b14a92d6` | 自由記述「2から行きましょう」 | ここでの案 2＝Graph の窓の間、背景の Freshness の commit を待たせる gate（LP-GATE）。範囲は設計・独立レビュー・実装・実装のレビュー・PR まで |
| `fd764de5` | 自由記述「mergeしていいよ」 | PR #777 の merge（通常の merge の条件つき） |
| `02a8555a` | AskUserQuestion（4 問、すべて推奨） | dev run をあと 2 回、N2／N4 は再測定の手順案に両方を並べてから選ぶ、この docs の PR は改訂 2 を足して merge まで、K6/4 の検出力の記録は新しい候補が決まったら取り直す |

材料：改訂 1 までの read-only の調査 2 件と独立レビュー 1 件（scratchpad。リポジトリに入れていない）。改訂 2 で足したもの：診断 run 3 回の記録（contracts `docs/plans/nir1-cp4-records/diag-lpd-2026-11-02/README.md`。第 1 回 `230e90da`、第 2 回 `dc3d3b98`、背景の commit の調査 `77c7eed2`、第 3 回 `f273a83c`）、調査の本文（scratchpad の `lapse-lane/survey/s7-background-commits.md`。リポジトリに入れていない）、gate の判断（`claude/cp4-lp-gate` の `docs/plans/nir1-lane-decisions/cq-deferred-decisions.md` §9）。

## 要点

1. **HOLD の理由は 2 つの指標**（改訂 1 から変わらない）。編集 trace は K6/4 の読みで、失効率 15/201（7.46%）と窓外率（表示の欠落）20/201、U 内 12/193（6.2%）が物差し 1% を超えた。2 つは**同じ 20 件**に由来する（失効 15、失効に数えない 5＝親の ticket が `stale` の 4 と #139）。
2. 20 件の内訳（正式の run。§1）：

   | 線 | 件数 | U 内 | 原因（改訂 2 の時点） | 状態 |
   |---|---|---|---|---|
   | LP-A | 8（＋#139 の 1） | 0（＋1） | `index-ready` の通知で、まだ begin を送っていない世代を renderer が取り消す | **LP-A1 を merge 済み**（PR #776、`8dd7a9c0`）。dev の 3 回で `cancelledBeforeBegin` 0 |
   | LP-B | 3 | 3 | 登録の post-flight の identity の drift（`postflight-identity-drift`） | dev で分岐を確認。**gate に統合** |
   | LP-S | 4 | 4 | query の時点の drift（`worker-registration-drift`） | dev で分岐を確認（第 1 回の 2 件）。**gate に統合** |
   | LP-C | 4 | 4 | child の合流の `edge-holds-false`。`freshness-token` だけが不一致 | dev で分岐を確認。**gate に統合** |

   正式の run は計装していないので、正式の 11 件（LP-B・LP-S・LP-C）が dev と同じ分岐かは**推論**（受領書の形が同じ。§3.0）。

3. **原因は 1 つの上流に絞れた**（dev の診断 2 回と時刻の突き合わせ）：欠落 22/22 件（第 1・2 回の 11＋11）で、Graph の窓（登録・query・child の合流の token）に incremental Freshness の cycle の commit（予約か publish）が重なっていた。直接の計装ではなく、時刻の写像（±5 ms）による状況証拠。
4. そこで **LP-B／LP-S／LP-C の個別の直しは採らず、共通の gate（LP-GATE）で扱う**ことになった（ユーザーの確認 `b14a92d6`）。gate は、Graph の窓の間、Freshness の cycle を native の lease で待たせ、上限で延期する。契約・IPC・閾値・Gold・読みは変えない。PR #777（**OPEN**、head `e7d6fe4a`、merge は `fd764de5` の条件つきで許可済み）。個別案の評価は §3.1〜3.3 に「なぜ採らなかったか」として残す。
5. **dev の第 3〜5 回**（gate を取り込んだ同じ dev build で 3 回、dev 専用・**CP-4 の結果ではない**）で、表示の欠落は 11/201（第 1・2 回の各回、5.5%）→ **0／1／0 /201（3 回で 1/603＝0.17%）**。1 件は第 4 回の child の合流の無効化で、gate の設計に書いた『残る隙間』の 1 番（Graph の待ちが上限 100 ms で尽きて窓なしで進み、`freshness-token` が動いた。§3.5）。603 件から言える本当の割合の 95% 上限は約 0.8%（片側。両側なら約 0.9%。おおよその見積もり）で、物差し 1% を下回るが余裕は小さい。dev の結果で、正式の候補での割合は再測定まで分からない。
6. **残る隙間**がある（§3.5）：窓を開くときに Freshness の区間が in-flight で 100 ms を超える場合、child の合流が lease の期限 500 ms を超える場合、Freshness 以外の commit（保存・audit・D-final など。F10 の一般形）。stale と #139 は dev で 0 だったが、正式の測定では未確認。
7. **正式の再測定はしていない。** 再測定の実行、S4 の扱い、候補単位の S6 の許可リスト、Gold の後退の危険、N2／N4 の扱いは、手順案を示してユーザーに確認する（§4、§6）。緩和（失効の読みの変更など）は採らない。列挙は §5。

## 1. 事実（測定。S4b'''・候補 `22b74a25`・編集 trace、Q=201、U=193）

| | 件数 | 率 | 内訳 |
|---|---|---|---|
| 失効（K6/2 の読み） | 8 | 3.98% | すべて `cancelledBeforeBegin`（DR-CP4-V-3 の厳しい側の読み） |
| 失効（K6/4 の再計算） | 15 | 7.46% | i-b-seal 11（上の 8 ＋ 親の登録不可 3）＋ iii（child の合流の無効化）4 |
| 窓外（K6/4 の再計算。表示されなかった） | 20 | 9.95%（U 内 12/193＝6.2%） | 失効 15 ＋ 親の ticket が `stale` の 4 ＋ #139 の 1 |

表示されなかった 20 件の内訳（traceIndex）：取消し 8（57・74・96・107・118・155・176・187。U の外）、登録不可 3（14・99・123）、child の無効化 4（95・160・178・190）、`stale` 4（8・26・142・167）、#139。物差しは 1%（Q=201 で 2 件以下、U=193 で 1 件以下）。開始時の B の封印は 201/201 current（X1-5 の効果）。失効 7 件と `stale` 4 件の B は trace 全体で generation 1・dirty false のまま。

この節は改訂 2 でも変えていない（正式の測定はこの 1 回だけ）。

## 2. LP-A：`index-ready` で begin の前の世代を取り消す（8 件＋#139）

**改訂 2 の注**：LP-A1（§2.3 の最小の形）は PR #776 で master に merge 済み（`8dd7a9c0`。判断は DR-WF-9〜11〔`wf-window-decisions.md` §5〕と DR-RSJ-6 への追補〔`rs-join-decisions.md` §6〕）。dev の診断 3 回で `cancelledBeforeBegin` 0、`index-ready` 起因の再 query 0（contracts の README の第 1〜3 回）。**正式の候補での効果（§2.3 の見込み）は未測定**。§2.1〜2.4 の本文は改訂 1 のまま残す。

### 2.1 機構（確認済み）

- 8 件は同じ形：`related-scenes:index-ready` の通知の 3.4〜4.5 ms 後に親の fetch が呼ばれ、1.1〜1.4 ms（2 件は約 40 ms）で `cancelled`（`rawStatus: not-started`、begin の API 行なし）。約 404 ms 後（#187 だけ 452.7 ms）に同じ鍵の再 query が出て、begin・公開・`graph-ready` の子まで完走する。8 件とも開始時の封印は `current`、A3 は eligible。編集の向きは関係しない。
- 前の正式の run（#48・#72・#200）と dev の稽古（4 件）にも同じ 1 ms 幅の署名が記録されている（DR-CP4-V-3）。3 回の run で再現する系統的な race。
- 通知の遅れは二峰（起点を封印の読取の開始にすると、150〜250 ms が 149 件、400〜666 ms が 9 件。起点を終了にすると件数が少し動く）。遅い 9 件は tree の更新から 400 ms の timer の発火より後になり、`run()` の開始〜begin の前の窓に落ちる。**9 件目は #139**（通知の 0.1 ms **後**に fetch の呼出し＝通知は begin の前。begin の IPC が 63.6 ms かかって begin した後に、描画の commit の cleanup で取り消された。K6/2 は「その他」、K6/4 は X11）。
- 正常な cycle でも、通知は debounce を張り直している（182 件が直前の通知から 390〜420 ms 後に出る）。通知が最初の timer の発火より前に来るので無害。
- 取消しの経路：
  1. `useNir1RelatedScenes.ts:147-150`：`index-ready` の listener が状態を見ずに `setRefresh`。
  2. `:355-358`：effect の cleanup が `abort.abort()`。
  3. `fetchNir1RelatedScenes.ts` の `stopIfContextChanged()` が `cancelled` を返し、begin（237 付近）に届かない。

### 2.2 判定：過剰（範囲は狭い）。安全性の論拠（レビュー P1-1 で差し替え）

- `index-ready` での再 query 自体は意図した挙動（#567。dsn §3.4）。過剰なのは「まだ begin を送っていない世代を捨てる」部分。
- **`index-ready` は Chronicle（NIR）index が使えるようになった通知**で、`build_once` が publish の commit を終えて `Ready` を返した後に emit する（`related_scenes/build.rs:45-49`、`:146-296`）。dense の検索（`begin.rs:230`、場面の embedding の index）とは別の index で、この通知とは関係しない。
- 取り消さなくても古い結果が出ない理由：begin は Main が IPC を受けた後、最初の participant read transaction で `read_chronicle_query_status_with_control`（`begin.rs:84`）を読み、`originalSnapshotUsable` と IR の operation の `original` snapshot を決める。publish の commit → emit → renderer の順なので、renderer が通知を処理した後に呼んだ begin は commit 済みの index を見る。publish より前に読んだ begin は `index-unavailable` になり、古い IR は出ない（IR が出ないだけ）。begin の前に走る sparse（FTS）の検索は `index-ready` の対象ではない。
- 失うもの（LP-A1 の前の挙動）：1 回の query、約 400 ms の表示の遅れ、Graph の follow-up（親が無いので K6/4 は X12）。

### 2.3 案 LP-A1（推奨。**PR #776 で merge 済み**）：begin を一度も送っていない世代を、`index-ready` で取り消さない

**最小の形を先に取る**。初版の「begin を送った後は公開してから 1 回 refresh」の分岐は、今は abort している世代を**表示する**ように変えるので、根拠が足りない（レビュー P1-1）。8 件はすべて begin の前なので、**この分岐は後の段（必要が測定で示されたとき）に回す**。**#139 も、通知が fetch の呼出しの前（＝begin の前）に来ているので、この形で取り消されなくなる見込み**（未測定。初版は『直らない』と書いたが、独立コードレビューの指摘で取り違えと分かった。hold は `run()` の開始から掛かるので、通知が seed の読取中に来ても掛かる）。

- 変更箇所：`src/features/related-scenes/useNir1RelatedScenes.ts` だけ。`index-ready` の listener を、React の state を通さず同期で判定する。世代を 3 種に分ける（P1-2）：
  1. **begin を送る世代で、まだ送っていない**（timer の待ち、または `run()` の開始〜begin の前の in-flight）：取り消さない。これから送る begin は通知の後になる。
  2. **begin を送った後の世代**：今どおり（`setRefresh`＝取り消して取り直す）。
  3. **begin を一度も送らない世代**（`recoverRaw` の `run(true)`〔`hook:218-227`、`rawOnly`〕と、listener の登録に失敗した経路〔`fetch:209-212`〕）：今どおり `setRefresh`。通知を捨てると、IR が次の契機まで戻らない（liveness の後退）。
  - 表示済み（idle）：今どおり `setRefresh`。
- 「begin を送ったか」の判定（P2-1）：callback を fetch に渡し、**`beginRelatedScenes(...)`（`fetch:237`）を呼ぶ直前に、同じ task の中で同期で印を立てる**。`.then` や `await` の後で立てない（危険な側＝実際は通知より前に送っていたのに「前」と見る、の誤判定が起きうる）。`invoke` は `enqueueIpc` を通る（`src/lib/tauri.ts`）ので実際の送信は呼出しより遅れうるが、安全な側（後に送る）にしか倒れない。`session.readinessRevision` を比べる案は使わない（session は fetch の中で作られ、hook から見えない。listener の登録は非同期で、登録前の通知を落とす）。
- 印は **`graphReadyDuringFetch` とは別の ref** にする（P2-2）。DR-WF-3 は `index-ready` を「契機なし」と定め、`graphReadyRefresh` は一覧の保持（DR-RSJ-6）と W_f の印に直結する。
- **debounce の張り直し**（P2-3）：張り直しは、**契機なし・rawOnly でない通常の 400 ms の timer に限る**。子の 0 ms の timer（`byGraphReady && !chained`、契機 `graph-ready`・W_f・carried の一覧）と `recoverRaw` の timer、IR timeout の再試行の timer（`:325-333`）は今どおり `setRefresh` に落とす（ref で張り直すと `index-ready` が張り直した query に `refreshTrigger: "graph-ready"` と W_f が付き、carried の一覧が残って DR-WF-3／DR-RSJ-6 と食い違う）。DR-WF-8 (a)（2 つの `setRefresh` が 1 回の描画にまとまると `byGraphReady`）の合流の順 2 通りを試験で固定する。
- **hook の source の literal を変えない**（P2-4）：`scripts/quality/nir1-graph/observation-prep.mjs:2342-2373` は hook の source に `const FETCH_DEBOUNCE_MS = (\d+);`（値 400）と `byGraphReady && !chained ? 0 : FETCH_DEBOUNCE_MS` が含まれることを検査する（trace file の `productTriggers`）。変えると trace file の作り直し・観測前の再固定になる。試験か lint で守る。
- 効果の見込み（失効率と窓外率を並べて書く。P3-4）：
  - 失効率：K6/2 の読みで 8→0。K6/4 の読みで 15→7（7/201＝3.48%）。
  - 窓外率：8 件が U に入って表示され、#139 も直る見込みなので、表示されない全体は 20→11、U 内は 11/201＝約 5.5%（U が 193→201 に増える）。**物差しを超えたまま**。
  - 分類が移るだけの部分：通知が親の `[tFetch, begin]` の間に来る場合、失効 (i)／X12 から X7（その他）に移る（`followup.mjs:585-594`）。8 件と #139 は通知が `tFetch` より前なので移らない。
  - 取り消されなくなった 8 件が別の follow-up の失敗（X1／X5 など）に移る率は、正常な query の基準率（約 7/193）なら 0〜1 件。
  - **改訂 2 の注**：dev の第 1・2 回（LP-A1 を含み gate を含まない build）は、表示の欠落が 11/201（5.5%）で、上の「20→11、約 5.5%」の見込みと件数は同じ。ただし dev fixture は S4b''' の凍結 trace と同じではなく、11 件の内訳も正式の run と違う（child 8 件。§3.0）。正式の候補での値ではない。
- リスクと試験：
  - `useNir1RelatedScenes.followUpWindow.test.tsx:204`（「index-ready と、通知と同時の tree の変化には印を付けない」）、DR-WF-8 (a)、DR-RSJ-6／DR-WF-3 の鍵の一致の判定と当たる。`graph-ready` の経路は変えず、試験で固定する。keep test（`useNir1RelatedScenes.graphReadyKeep.test.tsx`）は批准 5 (b) の証拠なので、LP-A1 の後も通ること。
  - 追加する試験：通知と seed の読取の解決の**順序 2 通り**で、timer の発火の直後〜begin の前に `index-ready` が来ても、その世代は begin まで進む。`recoverRaw`／listener-unavailable の世代は取り消す（IR が戻る）。begin の後に来たら今どおり取り直す。
  - 判定の誤りは、表示が 1 世代古い index になる。印を `beginRelatedScenes` の直前の同期で立てれば危険な側には倒れない。**この点を独立レビューで最も厚く見る**。
- 触れる契約・authority：IPC 契約、Native、`scope-storage-authority`、保存範囲、送信先のいずれにも触れない見込み。K6/2・K6/4・dsn に「`index-ready` は必ず再 query を起こす」と固定した文言は無い（独立レビューも確認）。**DR-RSJ-6（「index-ready は今までどおり 400 ms」）への追補と、DR-WF-3 への追補（run が始まった後の世代で再 query が起きなくなる。in-flight の印は契機なし）が要る**（改訂 2 の注：PR #776 で DR-WF-9〜11 と DR-RSJ-6 への追補として記録された）。製品の変更なので候補の作り直しと再測定が要る（§4）。

### 2.4 案 LP-A2（補助、単独では推奨しない）

`related_scenes/build.rs` の 250 ms の再試行や、build の publish と renderer の `db_execute` の競合を減らす。遅れが起きる率が下がるだけで race は残る。仮説（build の書込みが renderer の読取を一時的に止める）は未確認。改訂 2 の時点でも採っていない（dev で `cancelledBeforeBegin` が 0 になり、必要が示されていない）。

## 3. LP-B／LP-S／LP-C：follow-up の表示の欠落（U 内 11 件）と、共通の gate（LP-GATE）

改訂 1 は、3 つの線を別々の原因として扱い、診断の後に線ごとに直す計画だった。診断で**共通の上流**が分かったので、**個別の直しは gate に統合した**（§3.4）。§3.1〜3.3 は改訂 1 の評価を残し、各節の末尾に診断の結果と「なぜ採らなかったか」を足した。

### 3.0 原因の確定（改訂 2 で追加）

出所は contracts の `diag-lpd-2026-11-02/README.md`（第 1・2 回と、背景の commit の調査）と、調査の本文（scratchpad の `lapse-lane/survey/s7-background-commits.md`）。診断は dev 専用の merge しない枝 `claude/cp4-lp-diag`（DR-CP4-LPD-1）で、**正式の測定に数えない**。

| 区分（Q=201） | 正式の run（§1） | dev 第 1 回 | dev 第 2 回 |
|---|---|---|---|
| begin の前の取消し | 8 | 0 | 0 |
| 親の登録不可 | 3 | 1 | 3 |
| 親の ticket が `stale` | 4 | 2 | 0 |
| child の合流の無効化 | 4 | 8 | 8 |
| 表示されなかった合計 | 20（#139 を含む） | 11 | 11 |

- **事実（dev の計装による直接の記録）**：
  - 親の登録不可は全件 `registration.branch = postflight-identity-drift`、`inner = null`、`dataVersionDelta 1`、`totalChangesDelta 0`（第 1 回 1 件、第 2 回 3 件）。登録の snapshot の中の検証は通っていて、別の接続の commit が 1 回入っただけで拒否された。
  - `stale`（第 1 回の 2 件）は `query.result = worker-registration-drift`、`stampDiff = null`（`serve_query` の stamp0≠stamp1 の比較は走っていない）。
  - child の無効化は、第 2 回の 8 件が全件 `stage = edge-holds-false`、`tokenMismatch = ["freshness-token"]` のみ（第 2 回の計装で分岐を区別した。第 1 回の 8 件は `assemble-unavailable`／`dropped: path-not-current` まで）。
- **状況証拠（時刻の写像 ±5 ms。直接の計装ではない）**：欠落 22/22 件（11＋11）で、Graph の窓に incremental Freshness の cycle の commit が重なっていた。child の 16/16 で publish（cursor の ack）が token の窓〔worker の query の開始→合流の終わり〕の中、成功した 378 件では 0 件。親の登録不可 4/4 で予約か publish の commit が登録の窓の中（ただし窓に commit が入っても通った件が 7 件あり、必要条件にとどまる）。stale 2/2 で予約の commit が query の窓の中。`freshness_token` で動いた成分は `feed_acknowledged_through_sequence` だけ。
- **見積もり（推論）**：Freshness の scheduler は 1 s の idle poll（`electron/main/narrativeFreshness.ts:14-17`）で、保存との位相はほぼ一様。幅 W ms の窓に当たる確率は約 W/1000。token の窓（約 40 ms）→ 約 4.0%＝8.0/201（実測 8、8）。登録＋query の窓 → 約 1.4〜2.2%（実測 3、3）。正式の run の child 4 件は、この見積もり（約 8）より少ない。差の理由は未確認（fixture の違いなど）。
- **推論（未確認）**：正式の run の 11 件（登録不可 3、stale 4、child 4）も同じ上流による。正式の run は計装していないので、分岐の直接の証拠は無い。受領書の形（登録不可は `RegistrationUnavailable`、stale は `stamp0-missing` で比較が走っていない、child は Main の後段の `invalidated`）が dev と合う、という読み。
- **仕組みの欠落（調査の確認）**：Graph の query の窓の間、背景の Freshness の commit を止める仕組みは無かった（前景の preempt は maintenance の接続が Main の mutex を譲るだけ、D′ は begin 自身の audit の commit の後まで待つだけ、Freshness の quiesce は workspace の切替専用）。X1 /3 の F10 と D2b の XF-9 が、X1 の外に残る問題として予告していたもの。

### 3.1 LP-B：親の登録不可（3 件。traceIndex 14・99・123）

- 経路（コードと受領書からの**推論**。P2-6）：D′ の held query の release 後の worker の prepare が `StartupRegistrationRefused`（worker bin `nir1-c-query-worker.rs:250`、分類 `c_query_worker.rs:3008-3011`）で失敗し、`prepare_failure`（`electron/native/grimodex-node/src/nir1_graph_product.rs:2786`）が `(RegistrationUnavailable, Count)` を返す。根拠は、次の query の `preparesReady` が増えていないこと（14→14、98→98、121→121）、settle が 34.7〜39.1 ms で成功 185 件の最小 41.16 ms より早いこと、`prepare_failure` のこの分岐だけが `RegistrationUnavailable` を作ること。**受領書の counter は child の無い行では窓が親の begin の返却で閉じる**ので、`prepareFailures 0` は根拠にならない（直接の確認ではない）。
- 拒否の分岐は**推測**：最有力は post-flight の identity drift（`nir1_graph.rs:686-687`。`ReadIdentity` が DB 全体の `data_version` を含む）。B の入力に触れない commit（Chronicle の publish、Freshness、audit）でも拒否になる。ほかに、no-wait の maintenance の接続が取れない（worker 自身の `Database` の mutex の自己競合）、rowid・登録済み index・source index が完全でない、`read_seal` が None（製品の述語は consumer freshness を含み、harness の startSeal は `dirty_cache_flag` だけを読む）、`REVISION_INPUT_LIMIT` がある。**診断はこれらを全部区別する**。
- 判定：分岐が drift なら**過剰**（X1-5 と同じ型）。
- **再試行の費用（P1-3）**：owner 側で `build_worker` をもう一度呼ぶと、`wait_rebuild_window`（`product.rs:2163-2175`、`:2400-2438`）が `last_prepare_started + rebuild_min_interval`（既定 **1 s**、`:93-96`、`:2817-2834`）を待つ。`StartupRegistrationRefused` は `PrepareFailureEffect::Count`（`:2786-2789`）なので backoff（2 s）も付く。再試行の Graph は親の Raw-ready から 1〜2 s 後になり、T_late（100 ms）を超えて X3 になる。
- 案：
  - **LP-B1（免除なしの再試行）**：drift のときだけ登録を最大 2 回やり直す。**表示は増えず、失効 3 件が「その他」3 件に移るだけ**。効果を「失効率の低下」として報告すると、測定の分類だけを動かした変更に見える。**採るなら効果の報告を『分類の移動』と明記する**。D′ の状態機械の変更にあたる（P2-7。`run_deferred` は query の後に worker を retire して rebuild しない設計）ので、別 lane で、DR-CQD の追補を付け、K6/4 の『許さないもの』（D′ の状態機械の変更を K6/4 の名で行わない。draft-4 :36）に当たらないことを書く。
  - **LP-B2（防御の緩和を伴う再試行）**：drift のときだけ待ち窓と backoff を免除する。表示まで直る可能性がある。**worker の起動の rate limit（防御）の緩和**なので、DR と threat model に理由（drift は worker の不良ではない、上限 2 回で起動の嵐にならない、など）を書き、**防御の変更として、ユーザーに確認する**。
  - **LP-B3（proof の定義の変更）**：登録の identity を DB 全体の `data_version` ではなく B の入力に絞る。再試行の遅れが無い。漏れると古い proof で query する（X1-5 の網羅と同じ難しさ）。`scope-storage-authority` と C-query の registration の契約の改訂が要り、**委任の外**。新しい draftRef としてユーザーに確認する。
  - LP-B4：drift による prepare 失敗を backoff に数えない（`BindingLost` と同じ扱い）。trace の 3 件は直接減らない。
- **診断の結果（改訂 2）**：分岐は `postflight-identity-drift`（dev の 4/4。§3.0）。上の「最有力」が dev で確認された。drift を起こした commit は、時刻の突き合わせでは Freshness の予約か publish（状況証拠）。
- **なぜ採らなかったか（改訂 2）**：
  - LP-B1：免除しない再試行は、worker の再構築の待ち（≥1 s）で T_late を超えるので、**表示は増えず分類が移るだけ**（上の費用の指摘）。gate は drift そのものを起こさないので、再試行が要らない。
  - LP-B2：防御（worker の起動の rate limit）の緩和で、委任の外。gate は防御を変えずに同じ群に効く見込み。
  - LP-B3：proof の定義の変更で、契約の改訂（委任の外）。ユーザーは一度これを選んだ（`814f5dc8`。契約案の起案と独立レビューまで）が、診断を先にする確認（`681e1cac`）の後、gate の選択（`b14a92d6`）で契約案は起案していない。また、調査では child の群（§3.3）に効かない（`ReadIdentity` は `related_scenes/` に出てこない）。
  - LP-B4：trace の件数を直接減らさない。

### 3.2 LP-S：親の ticket が `stale`（4 件。traceIndex 8・26・142・167）

- 受領書から：worker は READY まで行った（`preparesReady` が増えた）。4 件とも `freshnessStamp.result` は `stamp0-missing`（`matched: null`）。`serve_query`（`nir1_graph_product.rs` の `match (stamp0, stamp1)`）は両方 Some で違うときだけ `Stale` を返すので、**この 4 件ではその比較は走っていない**（調査 B の最初の読み『stamp0≠stamp1 で Stale』は誤り。診断 run の起案時に起案者が受領書で確認）。なお `stamp0-missing` は編集 trace の 201 件中 187 件に出る（child の 4 件も同じ）ので、識別力は無い。失効には分類されない（「その他」）が、**U 内の表示の欠落**として窓外率に数えられる。
- 推論：比較が走っていないので、`Stale` は worker の query の時点の判定に由来する。`RegistrationDrift`（`nir1_graph.rs:1131-1147`。identity の drift か `NIR1_GRAPH_QUERY_DRIFT`）→ category `Stale`（`worker_frame.rs:614`）の経路がある。LP-B と同じ `data_version` の drift の系統の可能性が高い（推測。受領書からは分岐が決まらない）。「prepare の窓の中の commit」が、登録の窓の後・query の前にずれただけ、という読み。
- 案：LP-B と同じ 4 択（再試行は ≥1 s の待ちを伴うので、免除なしでは表示は増えない）。診断（LP-D）に query の時点の drift を入れる。
- **診断の結果（改訂 2）**：dev 第 1 回の 2 件は `worker-registration-drift`、`stampDiff = null`（比較は走っていない）。上の推論（query の時点の drift。LP-B と同じ系統）と合う。予約の commit が query の窓（約 5 ms）の中にあった（2/2。状況証拠）。dev 第 2・3 回は 0 件。正式の run の 4 件が同じ分岐かは推論（§3.0）。
- **なぜ採らなかったか（改訂 2）**：LP-B と同じ理由（免除しない再試行は T_late を超える、免除は防御の緩和、identity の絞り込みは契約の改訂）。gate は query の窓も lease で覆う（§3.4）。

### 3.3 LP-C：child の合流の無効化（4 件。traceIndex 95・160・178・190）

- 確認済み：child は `graph-ready` の通知で始まり、Native の cache から `cached` で渡った（worker の Graph は届いていた）。R＋IR は表示された。Graph だけが Main の `graph_continue` の後段で `invalidated`。B は generation 1・clean。
- 強い相関：child の begin の `firstSnapshotElapsedMs` が 4 件だけ 3.85〜7.02 ms（成功 181 件は最大 3.66 ms）。4/4 対 0/181。**因果の向きは未確認**。注：封印の読取（before／after）は親を挟むだけで、after は親の公開の頃なので、「Chronicle の generation は child の間に変わっていない」の証拠としては弱い（P3-3）。
- `invalidated` を返し得る Main の分岐は複数あり（lease〔始めと終わりの 2 か所〕、edge epoch、`current_operation`〔Chronicle に束縛された IR batch の再検証を含む〕、requalification の Dropped、requalification の Err、最後の `current_request`。`related_scenes/graph.rs`）、**どれかは受領書から決まらない**。意図した挙動か過剰かも未判定。
- 案（分岐の確定が先）：
  - LP-C1：requalification の current 性を B の material に限る（X1-5 (a)-1b と同じ考え方）。requalification の規則（CP-3a の K1b、DR-CP3A-27／29）と `typed-revision-material` に触れる。**契約の範囲の確認が要る見込み**。
  - LP-C2：Chronicle に束縛された batch の再検証が、IR の結果を変えない変化で false になっているなら、判定を IR の material の変化に絞る。exact R（DSN §3.1）を崩さない証明が要る。契約の確認が要る見込み。
  - LP-C3（上流）：child の begin の時点で connection を持つ background の処理を特定し、`graph-ready` の follow-up の短い窓（W_f 100 ms）と重ならないよう順序付ける。lifecycle／owner の技術判断の範囲。
- 無効化が**意図した挙動**（Chronicle が実際に変わって IR が古くなった）だった場合は、Graph を止めるのが正しい。その場合は製品を変えず、診断で決める。
- **診断の結果（改訂 2）**：dev 第 2 回の 8/8 件で、requalification の `attach_paths` の `edge_holds` が false（`stage = edge-holds-false`）、不一致は `freshness-token` だけ（第 1 回の 8 件は `path-not-current` までで、分岐を区別していない）。`freshness_token`（`Nir1EntityRelationFreshness` の digest）で動いた成分は `feed_acknowledged_through_sequence` だけで、worker の snapshot（ack＝N−1）と合流の live の読み（ack＝N）の差。Chronicle が変わって IR が古くなったのではない（上の「意図した挙動」には当たらない。B と無関係な成分だけが動いた）。上流は Freshness の publish（cursor の ack）の commit（16/16 対 0/378。状況証拠）。
- **なぜ採らなかったか（改訂 2）**：
  - LP-C1／LP-C2：requalification の規則・exact R に触れ、契約の確認が要る（委任の外）。調査の候補 (ii)「`freshness_token` から feed の位置を外す」も同じ型で、child の群にしか効かず、A3 の identity、D-final の ref、`edge_holds` の契約を変える。採らない。
  - LP-C3（上流の順序付け）：これが gate の考え方そのもの。child の合流だけでなく親の登録・query の窓も同じ上流なので、**3 群をまとめて gate で覆う**形にした（§3.4）。

### 3.4 LP-GATE：Graph の窓の間、Freshness の cycle を待たせる native の lease（改訂 2 で追加）

- 選択の経緯：調査の直し方の候補を、ユーザーに 3 つ示した（`b14a92d6` の「提示した事実」）。(iii-d) 保存の直後に Freshness を起こす（最小・保存の時機に頼り、保存以外の引き金〔別の window、AI の書込み、連続した編集〕には効かない）、gate（引き金を問わず仕組みで保証）、token から feed の位置を外す（契約の改訂）。ユーザーは gate を選んだ（「2から行きましょう」）。(iii-d) と token の案は採らない（DR-CQD-GATE §9.2 の末尾）。
- 実装：PR #777（branch `claude/cp4-lp-gate`、head `e7d6fe4a`、基点 master `8dd7a9c0`。**OPEN**）。判断は `docs/plans/nir1-lane-decisions/cq-deferred-decisions.md` の §9（DR-CQD-GATE-1〜10）。owner／lifecycle の matrix は §9.3、技術的な threat model は §9.4、実装後の追記は §9.5、独立レビューへの対応は §9.6。
- 何をするか（§9.2 の要約）：
  - 置き場所（GATE-1）：native の新しい module `electron/native/grimodex-node/src/nir1_graph_commit_gate.rs` の `GraphCommitGate`（memory だけ。durable にしない）。共有の `grimodex-db`、TS の製品コード、`ipcContract.ts`、preload、schema／migration は変えない。
  - Freshness の区間（GATE-2）：`run_narrative_freshness_cycle_supervised` の先頭で gate に入り、cycle 全体（予約、評価、publish、requeue など）を 1 つの区間にする。
  - Graph の窓（GATE-3）：`build_worker` の中、`wait_rebuild_window` の後・`admit`（stamp0 を読む）の前で、D′ の held query のときだけ lease を取る。D-final の begin には窓を開かない。
  - Graph の待ち（GATE-4）：Freshness の区間が in-flight なら、最大 **100 ms** 待つ。超えたら lease を取らずに（窓なしで）進む。鮮度の判定（`ReadIdentity`、stamp、`edge_holds`）は変えない。
  - Freshness の待ち（GATE-5）：lease があれば待ち、1 回の呼出しで **250 ms** 入れなければ延期し、延期の印（**50 ms**）を立てる。累計 **1 s** の天井で lease を無視して進む（`overridden`）。
  - lease の運び（GATE-6）：期限 **500 ms**。ticket → late cache → child の Cached の合流へ移り、合流の `assemble` の直後などで放す。
  - 延期の戻り値（GATE-7）は既存の `hasMore` の形。counter（GATE-8）は `GraphOwnerDiagnostics.gate`。試験の形（GATE-9）。Graph が公開されていない間は不活性（GATE-10。`PRODUCT_GRAPH_PUBLISHED=false` で lease 0 本）。
- 委任と除外：ユーザーの確認 `b14a92d6` の範囲の中の worker／owner／lifecycle の技術判断。契約・authority、IPC 契約、保存範囲、送信先、閾値・Gold・失効の読み、防御の緩和は含まない（§9.2 の「除外6項目への該当」はすべて「該当なし」）。merge は `fd764de5` の条件つき（新しい head で canonical Quick と `ci.yml` が成功、master の Full が赤でない、未解決のレビューなし、`--match-head-commit` の squash）。
- 効果の見込み（実装の前。推論）：この trace の欠落は 3 群とも Freshness の commit と重なっていたので、dev で 11 → 0〜2 件／run（§9.5 の「未検証・残る risk」と contracts の README 第 3 回の仮説）。
- **dev の第 3 回の実測**（run `lpd-diag-3`。2026-11-03 00:02〜00:12 JST。診断の枝 `claude/cp4-lp-diag` の HEAD `2e1c8815`＝LP-A1 を含む master `8dd7a9c0`＋診断の計装＋gate `59c5415e` の取込み〔`b828fa26`〕＋gate の counter の出力。**N=1・dev fixture・dev 専用で、CP-4 の結果ではない**。PR #777 の head は試験と DR だけの 2 commit〔`f0519ace`、`e7d6fe4a`〕が後に入ったが、製品コードは `59c5415e` と同じ）：

  | 区分（Q=201） | 第 1 回 | 第 2 回 | 第 3 回（gate） |
  |---|---|---|---|
  | 親の ticket が available | 198 | 198 | 201 |
  | 親の ticket の失敗（登録不可、stale） | 3 | 3 | 0 |
  | child の合流が available | 190 | 190 | 201 |
  | child の合流の無効化 | 8 | 8 | 0 |
  | 表示されなかった合計 | 11（5.5%） | 11（5.5%） | 0（0%） |

  gate の counter（run 全体の累計）：`windowsOpened` 201、`graphWaited` 8、`graphWaitExpired` 0、`waitedAdmit` 13、`deferred` 0、`overridden` 0、`stopped` 0、`leaseExpired` 0。窓の outcome は `gate-opened` 193、`gate-opened-after-wait` 8。

- 第 3 回の副作用（README の数値）：ticket の発行から settle までの p50 は 33.2／33.3／33.5 ms（第 1／2／3 回）で変わらない。150 ms 超の件数は 7／6／4。この遅い群（ticket の発行から prepare の開始まで約 140〜390 ms）は **gate の前の第 1・2 回にもあった**。ただし **max は 322.5 ms（第 2 回）→ 414.6 ms（第 3 回）に伸びた**。第 3 回の遅い 4 件はすべて `gate-opened-after-wait` で、Graph の待ち（上限 100 ms）が足された分と読める（推論）。遅い群の原因は未調査。窓の長さ（lease を持っていた時間）は p50 0.0 ms、p99 9.9 ms、max 48.0 ms。
- 読み方（第 3 回の時点）：前の 2 回の割合（約 5.5%）が続くと仮定すると、201 件で 0 件の確率は約 1e-5 で、偶然とは読みにくい（README）。一方、1 回の 0/201 から言える本当の割合の 95% 上限は約 1.5%（3/201）で、物差し 1% より上を排除できなかった。そこで同じ build でもう 2 回回した（下）。

**第 4・5 回（同じ build。README の第 4・5 回、contracts `83dc4e3d`）**：

  | 区分 | 第 3 回 | 第 4 回 | 第 5 回 | gate の 3 回 | （参考）gate なしの第 1・2 回 |
  |---|---|---|---|---|---|
  | 親の ticket の失敗 | 0 | 0 | 0 | 0 | 6 |
  | child の合流の無効化 | 0 | **1** | 0 | **1** | 16 |
  | 表示されなかった合計 | 0 | **1** | 0 | **1／603（0.17%）** | 22／402（5.47%） |

  - gate の counter：第 4 回は `graphWaited` 5、**`graphWaitExpired` 1**、**`leaseExpired` 2**、`waitedAdmit` 10。第 5 回は `graphWaited` 2、`waitedAdmit` 7、そのほかは 0。`deferred`／`overridden`／`stopped` は 3 回とも 0。
  - **第 4 回の 1 件（ticket seq 385）**：Graph の待ちが 100 ms で尽きて（`gate-wait-expired`）窓なしで進み、child の合流が `tokenMismatch = ["freshness-token"]` だけで `edge-holds-false`（feed の head＝ack＝212。第 2 回の child の 8 件と同じ形）。窓を開く時点で Freshness の区間が in-flight で、残りが 100 ms を超えた回があった、と読める【推論】。これは §3.5 の 1 番で、T_late を守るために待ちを 100 ms に切った設計の**予定された代償**。
  - **`leaseExpired` 2（第 4 回 seq 27・93）**：child の合流の開始が settle の約 836 ms／749 ms 後で lease の期限 500 ms を超えた（§3.5 の 2 番）。2 件とも合流は成功した。
  - ticket の settle の p50 は 33.5／33.1／33.4 ms（第 3／4／5 回）で変わらない。150 ms 超の遅い群は第 5 回に 4 件あり、**4 件とも gate の待ちを伴わない**。遅い群は gate の待ちだけでは説明できない（原因は未調査）。
  - 603 件から言える本当の割合の 95% 上限は約 0.8%（片側。Clopper–Pearson。おおよその見積もり）。**『解決した』『正式な測定で通る』とは言えない**（dev fixture、計装の入った build、3 回）。

### 3.5 残る隙間（改訂 2 で追加）

gate が覆わない、または dev の第 3 回で起きなかっただけのもの。

1. **窓を開くときに Freshness の区間が in-flight で、残りが 100 ms を超える場合**：Graph は窓なしで進み、今と同じく drift しうる（閉じる側。誤表示にはならない）。**第 3・5 回は `graphWaitExpired` 0 だったが、第 4 回で 1 回起きた**（ticket seq 385。child の合流が `freshness-token` の不一致で無効化され、表示の欠落 1 件。603 件中 1 件）。拡張案 X+（publish の前の checkpoint）は採っていない（GATE-2 の代替案）。
2. **child の合流が lease の期限 500 ms を超える場合**：lease は数えられなくなり、Freshness が入りうる。第 3・5 回は `leaseExpired` 0、第 4 回は 2（合流の開始が settle の約 836 ms／749 ms 後。2 件とも合流は成功）。
3. **Freshness 以外の commit**（保存、Chronicle の build、別の begin の audit、maintenance、MCP の別 process、D-final の経路の窓）：gate は同じ process の Freshness の commit だけを守る。F10 の一般形は残る（§9.5 の「未検証・残る risk」）。
4. **天井（1 s）で Freshness が lease を無視して進んだ回**：その窓は今と同じく drift しうる。第 3〜5 回は `overridden` 0。
5. **T_late への影響**：Graph の待ち（上限 100 ms）が当たった回は、親の `graph-ready` の通知がその分遅れる。頻度は 0.1% 未満と見込む（GATE の §9.1。推論）。正式の測定では未確認。
6. **stale 4 と #139**：dev の第 3〜5 回では 0（第 3 回の導き方：親の ticket 201/201 available、child の合流 201/201 available、`graph-ready` 201 の総数から導いた 0。#139 型の区分は README に無い）。正式の測定では未確認。
7. run ごとの揺れ、dev fixture と S4b''' の凍結 trace の違い、計装の入った build と正式の候補の bytes の違い（DR-CP4-LPD-1 の限界）。

## 4. 順序と手順

**改訂 2 の現在地**：改訂 1 の手順 1（LP-A1）と 2（診断）は済んだ。手順 3 は「個別の修正」ではなく gate になった（§3.4）。

1. **LP-A1**：済み（PR #776、`8dd7a9c0`）。
2. **診断（LP-D）**：第 1〜3 回は済み（dev 専用の枝 `claude/cp4-lp-diag`。DR-CP4-LPD-1。台帳なし、正式の測定に数えない）。改訂 1 の計装の項目 (a)〜(d) のうち、(a) 登録の分岐と query の時点の drift、(b) `Invalidated` の出所は決まった（§3.0）。(c) Main の commit の時刻は DB の timestamp との突き合わせ（±5 ms）で補った。(d) 製品の `read_seal` と harness の startSeal の差は、登録の拒否が `inner = null`・`seal = null` の post-flight の drift だったので主因ではないと読む（推論）。
3. **gate（LP-GATE）**：PR #777 を merge する（`fd764de5` の条件つきで許可済み。条件を満たさなければ merge せずに報告）。
4. **master の Full**：gate の merge の後、master の canonical Full を回して結果を見る（`fd764de5` の読みの 3 で、通常の検証に含まれる）。
5. **dev run の追加 2 回**（第 4・5 回。`02a8555a`）：済み。同じ build で `lpd-diag-4`、`lpd-diag-5`。dev 専用・正式の測定に数えない。結果は §3.4（603 件で欠落 1。第 4 回の 1 件は『残る隙間』の 1 番）。
6. **正式な再測定の手順案をユーザーに出す**（`02a8555a` の 1：結果を報告した後に手順案を出す。**再測定の実行は含まれない**）。手順案に書くこと：
   - (a) 新しい候補（gate と LP-A1 を含む master）で ⑤ の全部（SP-P4、parity、Gold、N2〜N4、trace 2 本）をやり直す。Gold は同じ候補と S4 の parity を要求する。`22b74a25` の Gold（pool 270/270）は持ち越せず、**Gold が後退する危険**もある。
   - (b) S6 の許可リストは `s4Commit` だけで絞る。同じ S4b''' の下に `22b74a25` と新しい候補の受領書が並ぶので、run の前に**候補の単位の許可リスト**を DR に登録する（「旧新から選ばない」。DR-CP4-S4-7 の運用条件 (2)〜(4)）。
   - (c) 批准 5 の証拠（新しい候補での keep test の run と K6/4 の再計算）と、S4-7 の運用条件 (11)（K6/4 の検出力の記録の取り直し）。取り直しの時期は `02a8555a` の 4 で「新しい候補が決まったら、再測定の前に」と回答済み。今の記録（候補 `86427ee5`、601 件 pass、contracts `aba74aab`）は持ち越さない。
   - (d) N2／N4：X1-5 の後は blocked（X1-5 の「本文だけの保存で B を dirty にしない」効果と、負例の harness の前提の衝突）。手順案に「blocked のまま」と「道具を直して測る（5 回目の S4。DR-CP4-S4-6 により実行前に再確認）」の両方の手順・費用・危険を並べる（`02a8555a` の 2）。**どちらにするかは選ばれていない。**
   - (e) S4-7 の運用条件 (1)（`--prep-commit` と失効の commit を祖先に持つ候補）と (10)（S4b''' の子）は、master の子の候補なら満たす。
   - (f) S4 を凍結し直さずに再測定してよいか、観測の後の再測定として何を開示するか。再測定の前に、閾値・Gold・読み・harness を変えていないことを DR に書く。
7. **ユーザーの確認が要る**：再測定の実行、S4 の扱い、候補単位の許可リスト、N2／N4 の選択、K6/4 の記録の取り直しの実行。**どれも決まっていない。**
8. 再測定の結果が物差しを超えたまま、または別の失効が現れた場合は、HOLD のまま次の設計に戻る（緩和には進まない）。§3.5 の隙間が候補になる。

## 5. 採らない案（緩和にあたる。列挙のみ）

結果を見た後の読みの変更は閾値の緩和にあたり、ユーザーの明示の判断が要る。この設計では推奨しない（改訂 2 でも変えない）。

- 取り消された親を Q から除く（DR-CP4-V-3 の (C)）。
- 最初に begin した再 query を親にする（Q の定義の変更。DR-CP4-V-3 の (R)）。
- `cancelledBeforeBegin` を失効 (i) から外す、または U に入れる読み。
- `parent-ticket-registration-unavailable`／`child-join-invalidated` を失効に数えない（DR-CP4-K64-5 の (B)）、registration-unavailable を「その他」に分類し直す。**窓外率の側にも同じ緩和があり得る**（stale や登録不可を『欠落』に数えない読み）。
- harness が child の Graph の無効化を見たときにもう 1 回 child を出す、または次の操作の前に `index-ready` を待つ。
- D′ の held query の期限や W_f／T_late を延ばす（K6/4 の値の変更）。
- 本文だけの保存で Chronicle の index を dirty にしない・`index-ready` を出さない（Raw／IR は本文に依存するので正しさの変更。X1-5 は Graph(B) の dirty だけを外した）。
- dev の診断の結果（第 3 回の 0/201 を含む）を、正式の測定の代わりに数える、または集計・閾値の選択に使う（DR-CP4-LPD-1 (4) に反する）。

緩和ではないが採らなかった直し方（LP-B1〜B4、LP-C1〜C3、(iii-d)、token から feed の位置を外す案）は、§3.1〜3.4 に理由を書いた。

## 6. 判断の分担

- **起案者・integrator の技術判断（委任・確認の範囲）**：LP-A1 の実装の形（済み）、診断の計装の項目（済み）、gate の設計と実装（DR-CQD-GATE-1〜10。`b14a92d6` の範囲）、試験の形。
- **ユーザーの確認が済んだ点**（記録は冒頭の表）：別 lane の方向と対象（`5cefa6da`、`74822833`）、診断 run を先に行うこと（`681e1cac`）、gate を選ぶこと（`b14a92d6`）、PR #777 の merge（`fd764de5`）、dev run をあと 2 回・N2／N4 は手順案に並べる・この docs の PR は merge まで・K6/4 の記録は候補が決まったら取り直す（`02a8555a`）。
- **ユーザーの確認が要る点**（未確認）：
  1. 正式の再測定の実行と手順（S4 の扱い、候補の単位の許可リスト、開示。§4 の 6・7）。
  2. N2／N4 を blocked のままにするか、5 回目の S4 で道具を直して測るか（手順案で両方を示してから）。
  3. K6/4 の検出力の記録の取り直しの実行（時期の方針は回答済み）。
  4. LP-B2（防御の緩和）、LP-B3／LP-C1／LP-C2・token の案（契約の改訂）を、今後もし採る場合。
  5. 最終的に物差しを満たせない場合の扱い（HOLD のまま PUB-G を止めるか、別の判断か。緩和はユーザーの明示の判断）。

## 7. 確かめた点・確かめられなかった点

**事実（改訂 1 で起案者がコードで確認。基点 `22b74a25`）**：hook の `index-ready` の listener（`useNir1RelatedScenes.ts:147-150`）と cleanup の abort、`recoverRaw` が `rawOnly` で begin を送らないこと（`:218-227`、`fetch:164-168`）、fetch の `cancelled` の返却位置と begin の呼出し、`begin.rs:84` が Chronicle の query status を読み `:230` の dense が別であること、emit が publish の後（`build.rs:45-49`）、worker の再構築の最小間隔 1 s・backoff 2 s（`product.rs:93-96`、`:2817-2834`）、worker の登録の拒否（`nir1-c-query-worker.rs:250`、`nir1_graph_product.rs:2786`、`nir1_graph.rs:686` の drift 判定）、再計算の JSON の `outOfWindowExceeds: true`・`outOfWindowU 12`・`lapse.total 15`、台帳の key。K6/4 draft の F4／X7 の文言（`nir1-final-request-eval-proposal-4-draft.md:142,155`）。独立レビューが確かめた点（8 件の時刻と封印、#139、F4 の探索窓、firstSnapshot の相関 4/4 対 0/181、S2 の pin に製品の file が無いこと、K6/2・K6/4・dsn に固定した文言が無いこと）。

**事実（改訂 2 で起案者が突き合わせた）**：PR #776 は MERGED（merge commit `8dd7a9c0`）、PR #775 は MERGED、PR #777 は OPEN（head `e7d6fe4a`、branch `claude/cp4-lp-gate`）。診断の枝の HEAD `2e1c8815` は gate `59c5415e` を `b828fa26` で取り込み、`lpd.rs` の schema を `nir1-lpd-diag/1` → `nir1-lpd-diag/2` にした。gate の branch で `59c5415e` の後は `f0519ace`（試験）と `e7d6fe4a`（DR）だけ。§3.0・§3.4 の数値（件数、counter、p50・150 ms 超・max、窓の長さ）は contracts の `diag-lpd-2026-11-02/README.md`（`f273a83c` の時点）の表と一致。DR-CQD-GATE-1〜10 と §9.3／§9.4 の位置は gate の branch の `cq-deferred-decisions.md` で確認。冒頭の表の記録の hash と原文は contracts の各 `user-confirmation-*.md` で確認。

**仮説・推論（確かめていない）**：

1. 正式の run の 11 件（登録不可 3、stale 4、child 4）が dev と同じ上流（Freshness の commit）による（受領書の形が合う、という推論。§3.0）。
2. 22/22 の重なりは時刻の写像（±5 ms）による状況証拠で、直接の計装ではない。登録の窓の commit は必要条件で十分条件ではない（4/11）。
3. 第 3 回の max の伸び（322.5 → 414.6 ms）は Graph の待ちが足された分（推論）。遅い群（約 140〜390 ms）の原因は未調査（Freshness の cycle が長く続いた後に Graph の読みが始まる群、という推測が README にある）。
4. gate による T_late の超過の頻度は 0.1% 未満（GATE の §9.1 の推論）。

**確かめられなかった点**：

1. 第 3〜5 回の合計 1/603 は **dev の 3 回の結果**（dev fixture、計装の入った build）。run ごとの揺れは 0／1／0 と小さく見えるが、正式の候補では未確認。
2. 正式の候補（gate と LP-A1 を含む master）での表示の欠落の件数。正式の再測定はしていない。
3. §3.5 の隙間（区間の in-flight が 100 ms を超える、合流が 500 ms を超える、Freshness 以外の commit、天井）が正式の測定で現れるか。
4. stale 4 と #139 が正式の測定で 0 になるか。
5. 新しい候補での Gold（後退の危険）、N2／N4（blocked）、K6/4 の検出力の記録。
6. 改訂 1 の確かめられなかった点のうち、通知→呼出しが 3.4〜4.5 ms に揃う理由、通知の遅れが 250 ms の再試行 1 回分にあたるか、は未調査のまま（LP-A1 の判定はどちらでも同じ）。

## 改訂の記録

初版（`1297da50`）への独立レビューの指摘と、反映の要点（改訂 1、`5d68cadc`）：

- P1-1：LP-A1 の安全性の論拠を差し替え（`index-ready` は Chronicle index の通知で dense とは別。begin の最初の read が `read_chronicle_query_status_with_control`）。「begin の後は公開して 1 回 refresh」の分岐は根拠が無いので最小の形から外した（§2.2、§2.3）。
- P1-2：begin を一度も送らない世代（`recoverRaw`、listener-unavailable）を 3 状態に足した（§2.3）。
- P1-3：LP-B1 の費用を ≥1 s に直し、免除なし（分類の移動だけ）と免除あり（防御の緩和）の 2 案に分けた（§3.1）。
- P1-4：窓外率と `stale` 4 件を事実に足し、LP-S を足した。要点・§4・§6 に「HOLD が残る見込み」を書いた。**起案者の S7 の『理由は 1 つ』も同じ見落としで、contracts `5923890c` で訂正した**。
- P2-1〜P2-7：判定の方法（直前の同期の印）、別の ref、張り直しの範囲、source の literal、再測定の手続き (a)〜(e)、LP-B の分岐の列挙と「確認済み」の降格、LP-B1 が D′ の状態機械に触れること。
- P3：#187 の 452.7 ms、二峰の起点の定義、child の区間の証拠の弱さ、効果を失効率と窓外率で並べる、keep test の維持。
- P3-6（`invalidated` の分岐の数え方）は誤りではないのでそのまま（「複数」と書いた）。
- 追補（`d81a5ae7`）：#139 は通知が begin の前なので LP-A1 の最小の形で直る見込み、に直した。

改訂 2（2026-11-03）：

- 冒頭：状態・基点（master `8dd7a9c0`）を更新し、ユーザーの確認の連鎖を表にした（「案 N」が記録ごとに別物を指すので、内容と hash を添えた）。
- 要点：現在地（LP-A1 の merge、原因の確定、gate、dev の診断 3 回、未了のもの）で書き直した。
- §1：変えていない。§2：LP-A1 が merge 済みであることと、dev の `cancelledBeforeBegin` 0 の注を足した（本文は改訂 1 のまま）。
- §3：3.0（原因の確定）、3.4（LP-GATE）、3.5（残る隙間）を足した。3.1〜3.3 は改訂 1 の評価を残し、「診断の結果」と「なぜ採らなかったか」を足した（個別の直しは gate に統合）。
- §4：現在地に合わせた（gate の merge → master の Full → dev run の追加 2 回 → 正式な再測定の手順案）。再測定の実行・S4・N2／N4・K6/4 の記録の取り直しはユーザーの確認が要る、と明記した。
- §5：緩和の列挙に「dev の診断を正式の測定の代わりに数える」を足した。§6：確認済みと未確認を分けた。§7：事実・推論・未確認を分けて更新した。
- 追補（診断 第 4・5 回の後）：§要点の 5、§3.4（第 4・5 回の表と読み）、§3.5（1 番が 1 回、2 番が 2 回起きた）、§4 の 5、§7 を、同じ build の 603 件（欠落 1）に更新した。第 4 回の 1 件は gate の設計に書いた『残る隙間』の 1 番で、設計の予定された代償。
- 契約・閾値・Gold・読み・harness は変えていない。
