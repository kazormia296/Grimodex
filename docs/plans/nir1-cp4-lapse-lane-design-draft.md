# NIR-1 CP-4：編集 trace に残る表示の欠落（失効と窓外）の別 lane の設計案（草稿）

状態：**草稿の改訂 1**。初版（`1297da50`）の独立レビュー（Opus、read-only。判定「修正してから受入れ可」、P1×4、P2×7、P3×6）の指摘を、起案者が一次資料（コードと受領書）で確かめてから反映した（末尾の「改訂の記録」）。ユーザーにはまだ示していない。製品・harness・fixture・S2・S4・閾値・Gold は変えていない（この文書を足しただけ）。
基点：master `22b74a25`。測定は S4b'''（`60bf9dc4`）・候補 `22b74a25`（DR-CP4-S6-2、PR #775）。
方向の確認：ユーザーが 2026-11-02 に S7 の報告へ「それで行きましょう」と返した（contracts `5cefa6da`。報告末尾の見立て〔(A) 案 1：HOLD を受け入れ、残る失効を X1-5 と同じ型の別 lane で設計する〕への同意と読んだ。自由記述で、AskUserQuestion ではない）。**ただし、その報告は「HOLD の理由は編集の失効率の 1 つ」と言っていて不正確だった**（下の要点 1。contracts `5923890c` で訂正）。確認の範囲は**設計の起案と独立レビューまで**。実装・診断 run・再測定は、この設計を示して改めて確認する（契約・authority の改訂が要る案は、新しい draftRef として確認するまで実装に入らない）。
材料：read-only の調査 2 件（調査 A＝begin の前の取消し、調査 B＝follow-up の失効）と、設計草稿の独立レビュー 1 件。いずれも subagent の報告で、起案者が主要なコード位置と受領書の数値を確かめた。記録は scratchpad にあり、リポジトリには入れていない。

## 要点

1. **HOLD の理由は 1 つではなかった。** 編集 trace は K6/4 の読みで 2 つの指標が物差し 1% を超える：失効率 15/201（7.46%）と、窓外率（表示の欠落）20/201、U 内 12/193（6.2%）。2 つは**同じ 20 件**に由来する。うち 15 件が失効、**5 件（親の ticket が `stale` の 4、#139 の 1）は失効に分類されない**。
2. 20 件は **4 つの原因**に分かれる：

   | 線 | 件数 | U 内 | 原因 | 確度 |
   |---|---|---|---|---|
   | LP-A | 8（＋#139 の 1） | 0（＋1） | `index-ready` の通知で、まだ begin を送っていない世代を renderer が取り消す | 経路は確認済み。過剰と判定 |
   | LP-B | 3 | 3 | worker の canonical registration が拒否され、再試行されない | 経路は推論。拒否の分岐は推測 |
   | LP-C | 4 | 4 | child の begin 後の Main 側の再検査が `invalidated` を返す | Main 側までは確認済み。分岐は未確定 |
   | LP-S | 4 | 4 | query の時点で親の ticket が `stale`（identity の drift の系統） | 経路は推論。LP-B と同系統の可能性（推測） |

3. **LP-A は renderer の hook だけの変更**で、契約に触れない。しかし**効果は部分的**：失効率は K6/2 の読みで 8→0、K6/4 の読みで 15→7（3.48%）、窓外率は約 5.5%（U 内 11/201。#139 も直る見込み。未測定）。
4. **LP-B／LP-C／LP-S は、診断（eval build の計装による dev run）が先**。しかも**効果のある直し方は 2 種類しかない**：(ii) worker の再構築の待ち窓と backoff を drift のときだけ免除する（worker 起動の rate limit という**防御の緩和**）、または (iii) registration／requalification の identity を B の入力に絞る（**proof の定義の変更**。契約の改訂で、委任の外）。待ち窓を免除しない再試行は、Graph が T_late（100 ms）を超えて X3 に移るだけで、**表示は増えない**。
5. 3 つの線を全部当てても、LP-S の 4 件が残れば窓外率は 4/201≈2.0% で、**HOLD が残る見込み**がある。「失効の別 lane」は、HOLD を解くための設計とは限らない。ユーザーの判断材料として §6 に出す。
6. 緩和（失効の読みの変更など）は採らない。列挙は §5。

## 1. 事実（測定。S4b'''・候補 `22b74a25`・編集 trace、Q=201、U=193）

| | 件数 | 率 | 内訳 |
|---|---|---|---|
| 失効（K6/2 の読み） | 8 | 3.98% | すべて `cancelledBeforeBegin`（DR-CP4-V-3 の厳しい側の読み） |
| 失効（K6/4 の再計算） | 15 | 7.46% | i-b-seal 11（上の 8 ＋ 親の登録不可 3）＋ iii（child の合流の無効化）4 |
| 窓外（K6/4 の再計算。表示されなかった） | 20 | 9.95%（U 内 12/193＝6.2%） | 失効 15 ＋ 親の ticket が `stale` の 4 ＋ #139 の 1 |

表示されなかった 20 件の内訳（traceIndex）：取消し 8（57・74・96・107・118・155・176・187。U の外）、登録不可 3（14・99・123）、child の無効化 4（95・160・178・190）、`stale` 4（8・26・142・167）、#139。物差しは 1%（Q=201 で 2 件以下、U=193 で 1 件以下）。開始時の B の封印は 201/201 current（X1-5 の効果）。失効 7 件と `stale` 4 件の B は trace 全体で generation 1・dirty false のまま。

## 2. LP-A：`index-ready` で begin の前の世代を取り消す（8 件＋#139）

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
- 失うもの（今の挙動）：1 回の query、約 400 ms の表示の遅れ、Graph の follow-up（親が無いので K6/4 は X12）。

### 2.3 案 LP-A1（推奨）：begin を一度も送っていない世代を、`index-ready` で取り消さない

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
- リスクと試験：
  - `useNir1RelatedScenes.followUpWindow.test.tsx:204`（「index-ready と、通知と同時の tree の変化には印を付けない」）、DR-WF-8 (a)、DR-RSJ-6／DR-WF-3 の鍵の一致の判定と当たる。`graph-ready` の経路は変えず、試験で固定する。keep test（`useNir1RelatedScenes.graphReadyKeep.test.tsx`）は批准 5 (b) の証拠なので、LP-A1 の後も通ること。
  - 追加する試験：通知と seed の読取の解決の**順序 2 通り**で、timer の発火の直後〜begin の前に `index-ready` が来ても、その世代は begin まで進む。`recoverRaw`／listener-unavailable の世代は取り消す（IR が戻る）。begin の後に来たら今どおり取り直す。
  - 判定の誤りは、表示が 1 世代古い index になる。印を `beginRelatedScenes` の直前の同期で立てれば危険な側には倒れない。**この点を独立レビューで最も厚く見る**。
- 触れる契約・authority：IPC 契約、Native、`scope-storage-authority`、保存範囲、送信先のいずれにも触れない見込み。K6/2・K6/4・dsn に「`index-ready` は必ず再 query を起こす」と固定した文言は無い（独立レビューも確認）。**DR-RSJ-6（「index-ready は今までどおり 400 ms」）への追補と、DR-WF-3 への追補（run が始まった後の世代で再 query が起きなくなる。in-flight の印は契機なし）が要る**。製品の変更なので候補の作り直しと再測定が要る（§4）。

### 2.4 案 LP-A2（補助、単独では推奨しない）

`related_scenes/build.rs` の 250 ms の再試行や、build の publish と renderer の `db_execute` の競合を減らす。遅れが起きる率が下がるだけで race は残る。仮説（build の書込みが renderer の読取を一時的に止める）は未確認。

## 3. LP-B／LP-S／LP-C：follow-up の表示の欠落（U 内 11 件）

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

### 3.2 LP-S：親の ticket が `stale`（4 件。traceIndex 8・26・142・167）

- 受領書から：worker は READY まで行った（`preparesReady` が増えた）。4 件とも `freshnessStamp.result` は `stamp0-missing`（`matched: null`）。`serve_query`（`nir1_graph_product.rs` の `match (stamp0, stamp1)`）は両方 Some で違うときだけ `Stale` を返すので、**この 4 件ではその比較は走っていない**（調査 B の最初の読み『stamp0≠stamp1 で Stale』は誤り。診断 run の起案時に起案者が受領書で確認）。なお `stamp0-missing` は編集 trace の 201 件中 187 件に出る（child の 4 件も同じ）ので、識別力は無い。失効には分類されない（「その他」）が、**U 内の表示の欠落**として窓外率に数えられる。
- 推論：比較が走っていないので、`Stale` は worker の query の時点の判定に由来する。`RegistrationDrift`（`nir1_graph.rs:1131-1147`。identity の drift か `NIR1_GRAPH_QUERY_DRIFT`）→ category `Stale`（`worker_frame.rs:614`）の経路がある。LP-B と同じ `data_version` の drift の系統の可能性が高い（推測。受領書からは分岐が決まらない）。「prepare の窓の中の commit」が、登録の窓の後・query の前にずれただけ、という読み。
- 案：LP-B と同じ 4 択（再試行は ≥1 s の待ちを伴うので、免除なしでは表示は増えない）。診断（LP-D）に query の時点の drift を入れる。

### 3.3 LP-C：child の合流の無効化（4 件。traceIndex 95・160・178・190）

- 確認済み：child は `graph-ready` の通知で始まり、Native の cache から `cached` で渡った（worker の Graph は届いていた）。R＋IR は表示された。Graph だけが Main の `graph_continue` の後段で `invalidated`。B は generation 1・clean。
- 強い相関：child の begin の `firstSnapshotElapsedMs` が 4 件だけ 3.85〜7.02 ms（成功 181 件は最大 3.66 ms）。4/4 対 0/181。**因果の向きは未確認**。注：封印の読取（before／after）は親を挟むだけで、after は親の公開の頃なので、「Chronicle の generation は child の間に変わっていない」の証拠としては弱い（P3-3）。
- `invalidated` を返し得る Main の分岐は複数あり（lease〔始めと終わりの 2 か所〕、edge epoch、`current_operation`〔Chronicle に束縛された IR batch の再検証を含む〕、requalification の Dropped、requalification の Err、最後の `current_request`。`related_scenes/graph.rs`）、**どれかは受領書から決まらない**。意図した挙動か過剰かも未判定。
- 案（分岐の確定が先）：
  - LP-C1：requalification の current 性を B の material に限る（X1-5 (a)-1b と同じ考え方）。requalification の規則（CP-3a の K1b、DR-CP3A-27／29）と `typed-revision-material` に触れる。**契約の範囲の確認が要る見込み**。
  - LP-C2：Chronicle に束縛された batch の再検証が、IR の結果を変えない変化で false になっているなら、判定を IR の material の変化に絞る。exact R（DSN §3.1）を崩さない証明が要る。契約の確認が要る見込み。
  - LP-C3（上流）：child の begin の時点で connection を持つ background の処理を特定し、`graph-ready` の follow-up の短い窓（W_f 100 ms）と重ならないよう順序付ける。lifecycle／owner の技術判断の範囲。
- 無効化が**意図した挙動**（Chronicle が実際に変わって IR が古くなった）だった場合は、Graph を止めるのが正しい。その場合は製品を変えず、診断で決める。

## 4. 順序と手順

1. **LP-A1 を先に**：確度が最も高く、renderer だけで、契約に触れない。実装 → hook の試験 → 独立コードレビュー → PR。ただし効果は部分的（失効率 15→7、窓外率は約 5.5% で物差しの外）。
2. **診断（LP-D）**：**dev 専用の未 merge の枝**（DR-CP4-LPD-1。`native-architecture.mjs` が S2 の bytes pin で、eval module の外への hook を許さないため。検査も pin も変えず、master に入れず、正式の候補にしない）で、eval build（`nir1-graph-eval` feature。製品 build に symbol も文字列も無い）に、(a) worker の登録の `Ok(false)` の分岐（上の全部）と query の時点の drift、(b) `await_request` の `Invalidated` の出所、(c) Main の commit の時刻と、child の begin の時点で connection を持つ処理、(d) 製品の `read_seal` と harness の startSeal の差、を記録する計装を足し、dev run（台帳なし、正式の測定に数えない）で LP-B・LP-S・LP-C の分岐を決める。静かなマシンが要る（race の再現のため）。
3. **LP-B／LP-S／LP-C の修正**を、診断の結果に従って。LP-B2（防御の緩和）と LP-B3／LP-C1／LP-C2（契約の改訂）は、ユーザーに確認するまで実装しない。
4. **新しい候補での再測定**：製品を変えるので候補の commit が変わる。admission は機械的には通る（S2 の pin に製品の file が無い。台帳の key は〔候補の commit、S4 の commit、run の種類〕なので、新しい候補では SP-P4 の上限 2 も数え直しになる）。足すべき条件（P2-5）：
   - (a) ⑤ の全部（SP-P4、parity、Gold、N2〜N4、trace 2 本）をやり直す。Gold は同じ候補と S4 の parity を要求する。`22b74a25` の Gold（pool 270/270）は持ち越せず、**Gold が後退する危険**もある。
   - (b) S6 の許可リストは `s4Commit` だけで絞る。同じ S4b''' の下に `22b74a25` と新しい候補の受領書が並ぶので、run の前に**候補の単位の許可リスト**を DR に登録する（「旧新から選ばない」。DR-CP4-S4-7 の運用条件 (2)〜(4)）。
   - (c) 批准 5 の証拠（新しい候補での keep test の run と K6/4 の再計算）と、S4-7 の運用条件 (11)（K6/4 の検出力の記録の取り直し）。
   - (d) N2／N4 は X1-5 の後は同じ理由で blocked になる見込み（ユーザーの判断 (B) と絡む）。
   - (e) S4-7 の運用条件 (1)（`--prep-commit` と失効の commit を祖先に持つ候補）と (10)（S4b''' の子）は、master の子の候補なら満たす。
   - S4 を凍結し直さずに再測定してよいか、観測の後の再測定として何を開示するかは、**ユーザーに確認する**（結論が 5 回目の S4 なら DR-CP4-S4-6 により確認が要る）。再測定の前に、閾値・Gold・読み・harness を変えていないことを DR に書く。
5. 再測定の結果が物差しを超えたまま、または別の失効が現れた場合は、HOLD のまま次の設計に戻る（緩和には進まない）。

## 5. 採らない案（緩和にあたる。列挙のみ）

結果を見た後の読みの変更は閾値の緩和にあたり、ユーザーの明示の判断が要る。この設計では推奨しない。

- 取り消された親を Q から除く（DR-CP4-V-3 の (C)）。
- 最初に begin した再 query を親にする（Q の定義の変更。DR-CP4-V-3 の (R)）。
- `cancelledBeforeBegin` を失効 (i) から外す、または U に入れる読み。
- `parent-ticket-registration-unavailable`／`child-join-invalidated` を失効に数えない（DR-CP4-K64-5 の (B)）、registration-unavailable を「その他」に分類し直す。**窓外率の側にも同じ緩和があり得る**（stale や登録不可を『欠落』に数えない読み）。
- harness が child の Graph の無効化を見たときにもう 1 回 child を出す、または次の操作の前に `index-ready` を待つ。
- D′ の held query の期限や W_f／T_late を延ばす（K6/4 の値の変更）。
- 本文だけの保存で Chronicle の index を dirty にしない・`index-ready` を出さない（Raw／IR は本文に依存するので正しさの変更。X1-5 は Graph(B) の dirty だけを外した）。

## 6. 判断の分担

- **起案者の技術判断（委任の範囲）**：LP-A1 の実装の形、診断の計装の項目、試験の形、LP-B1（免除なしの再試行）の形。
- **ユーザーの確認が要る点**：
  1. この設計の方向（LP-A1 → 診断 → 修正の順）と、実装・診断 run の着手。**LP-A1 だけでは HOLD が解けない**ことと、**3 線を全部当てても LP-S が残れば HOLD が残る見込み**があることを踏まえた判断。
  2. LP-B2（worker 起動の rate limit の免除＝防御の緩和）、LP-B3／LP-C1／LP-C2（契約の改訂）を採る場合。
  3. 再測定の手続き（S4 の扱い、候補の単位の許可リスト。§4 の 4）。
  4. 診断 run をいつ走らせるか（静かなマシン）。
  5. 最終的に物差しを満たせない場合の扱い（HOLD のまま PUB-G を止めるか、別の判断か。緩和はユーザーの明示の判断）。

## 7. 確かめた点・確かめられなかった点

確かめた点（起案者がコードで確認）：hook の `index-ready` の listener（`useNir1RelatedScenes.ts:147-150`）と cleanup の abort、`recoverRaw` が `rawOnly` で begin を送らないこと（`:218-227`、`fetch:164-168`）、fetch の `cancelled` の返却位置と begin の呼出し、`begin.rs:84` が Chronicle の query status を読み `:230` の dense が別であること、emit が publish の後（`build.rs:45-49`）、worker の再構築の最小間隔 1 s・backoff 2 s（`product.rs:93-96`、`:2817-2834`）、worker の登録の拒否（`nir1-c-query-worker.rs:250`、`nir1_graph_product.rs:2786`、`nir1_graph.rs:686` の drift 判定）、再計算の JSON の `outOfWindowExceeds: true`・`outOfWindowU 12`・`lapse.total 15`、台帳の key。K6/4 draft の F4／X7 の文言（`nir1-final-request-eval-proposal-4-draft.md:142,155`）。独立レビューが確かめた点（8 件の時刻と封印、#139、F4 の探索窓、firstSnapshot の相関 4/4 対 0/181、S2 の pin に製品の file が無いこと、K6/2・K6/4・dsn に固定した文言が無いこと）。

確かめられなかった点：
1. 通知→呼出しが 3.4〜4.5 ms に揃う理由（仮説：build の publish が renderer の `db_execute` を一時的に止める）。通知と timer の発火のどちらが先か。LP-A1 の判定はどちらの順でも同じ。
2. 通知の遅れが 250 ms の再試行 1 回分にあたるか。
3. LP-B／LP-S の拒否・drift の分岐、LP-C の `Invalidated` の出所と、意図か過剰か。
4. 製品の `read_seal` と harness の startSeal の差が実際に開いたか。
5. LP-A1 を入れた後の実際の件数（再測定が要る）。取り消されなくなった 8 件が別の失敗に移るか。
6. 3 線を直した後に、別の窓の race が見えるか。

## 改訂の記録

初版（`1297da50`）への独立レビューの指摘と、反映の要点：

- P1-1：LP-A1 の安全性の論拠を差し替え（`index-ready` は Chronicle index の通知で dense とは別。begin の最初の read が `read_chronicle_query_status_with_control`）。「begin の後は公開して 1 回 refresh」の分岐は根拠が無いので最小の形から外した（§2.2、§2.3）。
- P1-2：begin を一度も送らない世代（`recoverRaw`、listener-unavailable）を 3 状態に足した（§2.3）。
- P1-3：LP-B1 の費用を ≥1 s に直し、免除なし（分類の移動だけ）と免除あり（防御の緩和）の 2 案に分けた（§3.1）。
- P1-4：窓外率と `stale` 4 件を事実に足し、LP-S を足した。要点・§4・§6 に「HOLD が残る見込み」を書いた。**起案者の S7 の『理由は 1 つ』も同じ見落としで、contracts `5923890c` で訂正した**。
- P2-1〜P2-7：判定の方法（直前の同期の印）、別の ref、張り直しの範囲、source の literal、再測定の手続き (a)〜(e)、LP-B の分岐の列挙と「確認済み」の降格、LP-B1 が D′ の状態機械に触れること。
- P3：#187 の 452.7 ms、二峰の起点の定義、child の区間の証拠の弱さ、効果を失効率と窓外率で並べる、keep test の維持。
- P3-6（`invalidated` の分岐の数え方）は誤りではないのでそのまま（「複数」と書いた）。
