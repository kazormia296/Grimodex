# CQ-DEFER の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

出所は CP-4 の診断（`docs/plans/nir1-lane-decisions/cp4-decisions.md` の DR-CP4-S1C2-19〜22。branch `claude/nir1-cp4`）、integrator の TASK（2026-10-25、設計 D′）、read-only の設計者の検証（2026-10-25）である。基点は `origin/master` `6c7c2d00`。この文書は製品コードの mutation の前に書き、実装後の事実は末尾の「実装後の追記」に足す（前の本文は直さない）。

U3 の委任（継続計画 §3.1）の外に当たる要素は置かない。監査（`grimodex-semantic` の順序と内容）、鮮度の判定（`ReadIdentity`、registration と query の drift の検査）、保存の範囲、確認済みの値（D=10.84 ms、lease 100 ms、K1／proposal/7 の上限、1%）、閉じた gate（`PRODUCT_GRAPH_PUBLISHED=false` ほか）、D-final の経路、`src/` の renderer、IPC／preload／Main は変えない。変えるのは Native の Graph owner の状態機械（async lifecycle）と、Related Scenes の begin がそれを呼ぶ時点だけである。

## 1. TASK の事実の確認（現 master `6c7c2d00` のコードで確かめた）

| 事実 | 確認の結果 |
|---|---|
| begin の順序 | `related_scenes/begin.rs`：`begin_graph`（:165、owner へ渡す。wait 0）→ 監査つきの `prepare_related_scene_query`（:178）→ IR scoring の spawn（:190）→ Raw の `semantic_search_with_query`（:211）→ participant の読取で source の再確認（:233-240）→ outcome の確定（:251）→ `Err` なら operation の release（:252-256）→ `build::schedule`（:257-259）。TASK のとおり |
| begin の commit | `prepare_related_scene_query` の中だけ。`runtime_audited_query.rs:114` の `start_embedding_audit`（`execution.started`、`request.prepared`、`request.dispatched` の 3 行を 1 回の append）と :135 の `dispatch_and_run`（`response.completed`、`execution.succeeded` の 2 行を 1 回の append）。appender は `request.database()`（製品の authority の接続）。IR scoring（`scoring.rs`）、Raw 検索、source の再確認はすべて読取。`build::schedule` は Index が使える間は `rebuild_requested` の読取だけで Idle になり、書くのは Index の再構築が要るとき（編集の後＝F10 の側）だけ。よって outcome が `Ok` に決まった時点で、この begin 自身の commit はすべて終わっており、participant の読取も閉じている |
| `start_session` | 空の slot への需要で、slot の lock の下で owner thread を spawn し、`Preparing` にして `warming`（unserved）を返す。backoff 中は最後の失敗の理由で即答する。TASK のとおり |
| owner の状態機械 | `Empty → Preparing → Ready → InUse → (Rebuild) → Preparing …`、`Retiring`（idle／rekey／edge）、`Suspended`、`Quarantined`、`Closed`。`serve_query` は query の後に必ず `ServeNext::Rebuild`（自動の作り直し）を返す。TASK のとおり |
| 5 回の失敗の規則 | `failures_before_suspend: 5`。`prepare_failure` の `Count`（`StartupRegistrationRefused` を含む）だけが数えられ、5 回続くと `Suspended{ready_generation}`。READY で 0 に戻る。TASK のとおり |
| `deliver`／`finish` | 最初の outcome が勝つ。`Unused` かつ cacheable なら `store_late_cache` → `notify_ready` を 1 回。stale／busy は project を unserved に記録する。`Cancelled` は cancel flag と outcome を立てる。未 finish の `GraphTicket` の Drop は `Cancelled`。TASK のとおり |
| `notify_ready` | READY で `take_unserved(project)` が真なら 1 回（`build_and_serve` の READY の直後）と、late cache の格納のとき。TASK のとおり |
| D-final の READY 待ち | `nir1_graph_dfinal.rs:323-324`（`ready_signal_generation` を読んでから `begin`）と :478（`wait_ready_signal`）。`warming`／`stale` のときだけ待ち、`busy` などは即座に Graph なしで進む。予算 4 s（`GRAPH_WAIT_BUDGET`）。TASK のとおり |
| registration と query の drift | `nir1_graph.rs:604-605,683-688`（registration の前後の `ReadIdentity`）、:1022-1026 と query の前後の比較。owner の stamp（`CQueryFreshnessStamp`）は親の主接続の `ReadIdentity`（`total_changes` を含む）を try-lock で読む。TASK のとおり |
| 評価の診断（`nir1_graph_eval`） | **master には無い**（CP-4 の branch にだけある。`electron/native/grimodex-node/src/nir1_graph_eval/`、feature `nir1-graph-eval`）。調整は DR-CQD-9 |

設計の根本（begin の commit は outcome の確定の前に全部終わる、release の後に始めた prepare は自分の監査と重ならない）は崩れていない。

## 2. 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQD-1 | 2026-10-25 | CQ-DEFER | **D′ を採る**。Related Scenes の begin の Graph 需要を owner の slot に「保留」として置き（`begin_deferred`）、begin 自身の commit がすべて終わった時点（outcome が `Ok` に決まった後、`build::schedule` の前）で release する。release の後に owner thread が rebuild の窓 → admit（stamp0）→ prepare → READY → **すぐその query** を行う。結果は常に graph-late（Raw-ready の後）で、CP-3a／b の cache → `graph-ready` → 再 query（`Cached`）の経路で表示される | actor は同じ process の begin の thread と owner thread だけ。受信先・保存・外向きの通信は増えない（slot が持つのは ID と request の 3 つの文字列、ticket の `Arc` だけ）。受入れは独立 review（lifecycle と safety）と最終受入れ | TASK §1 の案（D 前半＝ack まで遅らせる、D 後半だけ、A／B／C、`data_version` の静止の観測）。理由は TASK §1 のとおりで再検討しない（A／B／C は監査・鮮度・保存の契約に触れる重要な変更） | integrator の TASK と read-only の設計者の検証（2026-10-25） | 該当なし（閾値・契約・保存・gate を変えない） | §3 | 記録済み |
| DR-CQD-2 | 2026-10-25 | 同 | **API**。owner に `begin_deferred(state, query) -> GraphBegin` を足す（D-final は今の `begin` のまま）。admission の検査（seed、長さ、closed、publication、registration、restricted profile、worker、Core の Ready、cache）は `begin` と同じ関数を共有する。`GraphTicket::release_after_own_commits(&self)` と `GraphState::release_after_own_commits()`（`declare` と同じく、GraphState の内側の lock の下では ticket の handle を複製するだけで、lock を外してから owner を呼ぶ）。release の照合は ticket の `Arc` の同一性（`Arc::ptr_eq`）と保留を作ったときの edge epoch。release は wait-free（slot の lock を短く取り、owner thread に `Wake` を `try_send` するだけ） | 別の ticket による release は `Arc` が違うので何もしない。edge／shutdown をまたいだ release は epoch で拒否 | 文字列の照合（ticket の ID）：偽造や再利用に弱い。採らない | 同上 | 該当なし | §3 | 記録済み |
| DR-CQD-3 | 2026-10-25 | 同 | **状態遷移**。新しい phase `Deferred`（保留中：owner thread はあるが worker は無い）を足す。`begin_deferred` は、`Empty`（と、世代が進んだ `Suspended`）では owner thread を spawn して `Deferred` にし、`Pending`（保留の ticket）を返す（`warming` は返さない）。`Ready` で同じ key なら、その READY は release より前に prepare したもの（＝この begin の監査で必ず drift する）なので、query に使わず退役させて `Deferred` にする（`Command::Defer`）。`Ready` で別の key のときは、今の rekey の規則（前の需要から `rebuild_min_interval` が経っていれば奪う、経っていなければ `busy`）を保つ（**TASK からの調整**：TASK は「Empty か Ready なら Pending」とだけ書くが、別の window の直前の需要を奪わないため）。backoff 中は今の `start_session` と同じく最後の失敗の理由で即答する | lock の順序は §3.3 | すべての Ready を奪う案：別の key の需要を 1 s 以内に奪い合う thrash を作る。採らない | 同上 | 該当なし | §3 | 記録済み |
| DR-CQD-4 | 2026-10-25 | 同 | **持たせた session の READY**。release を受けた session は、READY で phase を `Ready` にせず `InUse` にして、すぐ保留の query を処理する（他の需要が間に query を入れない）。この READY では `signal_ready` も unserved への `notify_ready` も出さない（TASK：出すと再 query が cache より先に届いて busy になる）。通知は遅れた結果を cache に入れるときの 1 回だけ。query の後は自動の Rebuild をせず、worker を退役させて `Empty` に戻る（その READY は次の begin の監査で無駄になり、衝突すれば失敗に数えられる）。query の前に ticket が取り消されていたら、query せず退役して `Empty` | D-final の waiter は、持たせた session の終わり（`session_main` の最後の `signal_ready`）で起き、`Empty` に対して自分の session を作る | READY で `Ready` を公開する案：D-final が間に入ると保留の query が busy になる。採らない | 同上 | 該当なし | §3 | 記録済み |
| DR-CQD-5 | 2026-10-25 | 同 | **相互作用**。保留中の ticket の取消（renderer の settle、lease の終わり、begin の `Err`、ticket の Drop）は ticket の cancel flag を立て、owner thread を `Wake` で起こす（ticket の state の lock を外してから slot の lock を取る。入れ子にしない）。owner thread は保留を捨てて `Empty` に戻る。lifecycle の edge と `close()`（shutdown）は保留中の ticket に `invalidated` を返し、prepare しない。保留の期限は 2 s（`GRAPH_AWAIT_LIMIT` と同じ値。owner 側の定数 `DEFERRED_RELEASE_LIMIT`、試験だけ短くできる）で、過ぎたら `timeout` を返して slot を空ける。保留中の 2 件目の Related Scenes の begin は `busy`（unserved）。D-final の begin は、保留中と持たせた session の `Preparing` では今の `Preparing` の規則（同じ key は `warming`、別の key は `busy`）、`InUse` では `busy`。`Suspended`／`Quarantined`／`Closed` の扱いは変えない | 保留の漏れは期限と RAII（DR-CQD-6）で必ず終わる | 期限を置かない案：release を忘れた経路が slot を永久に塞ぐ。採らない | 同上 | 該当なし | §3 | 記録済み |
| DR-CQD-6 | 2026-10-25 | 同 | **begin の release の時点と RAII**。`begin.rs` に guard（`graph::DeferredRelease`）を置く。`begin_graph` の直後に作り、outcome が `Ok` なら `release()`（`build::schedule` の前）、それ以外のどの出口（`Err`、`?` の早期 return、panic の unwind）でも Drop で `cancel()` する。release は participant の読取の外（:233-240 の closure を出た後）でだけ呼ぶ。Main の return-time recheck（`begin()` の `guard.finish`）が失敗したときは、今のとおり operation の release が ticket を取り消す（release の後でも取消は効き、owner は READY の前後で cancel を見て query しない） | — | release を owner の timer で自動にする案：begin の commit の終わりを owner は知らない。採らない | 同上 | 該当なし | §3 | 記録済み |
| DR-CQD-7 | 2026-10-25 | 同 | **5 回の失敗の規則は変えない**。持たせた session の prepare の失敗は今の `prepare_failure` の分類で数える。release の後に起きる registration の拒否は F10（編集の保存、別の window の begin の監査、B の保守）によるもので、従来どおり数え、5 回続けば `Suspended`。自分の監査との衝突は release の後には起きないので数えられなくなる | — | 持たせた session の失敗を数えない案：F10 による連続の失敗が backoff も Suspended も経ずに繰り返される。採らない | 同上 | 該当なし | §3 | 記録済み |
| DR-CQD-8 | 2026-10-25 | 同 | **F10 は残す**。release から query の終わりまで（rebuild の窓の後の約 40〜80 ms＋query）に他の commit があれば、従来どおり `stale`（stamp の不一致または worker の `registration-drift`）／`registration-unavailable` になる。D′ はそれを隠さない（試験 N1） | 鮮度の判定は変えない | — | 同上 | 該当なし | — | 記録済み |
| DR-CQD-9 | 2026-10-25 | 同 | **評価の診断の調整（TASK §3 からの調整）**。`nir1_graph_eval` は master に無いので、この lane は owner の counter（`GraphOwnerDiagnostics`、counter だけで文字列・ID を持たない）に `deferred_released`、`deferred_expired`、`deferred_dropped`（取消／invalidated で release の前に捨てた保留）、`stale_ready_retired` を足すだけにする。CP-4 の評価の JSON（`nir1_graph_eval::diagnostics_json`）への露出と、CP-4 の `slot_kind` の match への `Deferred` の追加は、integrator が統合 branch に取り込むときに行う（統合の注意：CP-4 は `begin` を `admit` で包んで `BeginProbe` を付けているので、`begin_deferred` にも同じ probe が要る。`TicketShared::new` の引数が増える） | counter だけ（post-B §4.4） | — | — | 該当なし | — | 記録済み |
| DR-CQD-10 | 2026-10-25 | 同 | **試験の置き場所と統合試験 (i)**。owner の単体試験は既存の `nir1_graph_product_tests.rs` の子 module（新しい file `nir1_graph_deferred_tests.rs`）に置き、既存の fake worker と fixture を使う。統合試験 (i) は 2 段にする。(i-a) CI で走る段：実 DB（製品の authority の接続）と実際の監査の writer（`grimodex_semantic::audit::SemanticAuditSession`。製品の `prepare_query_with` と同じ 3 行＋2 行の 2 回の append）で begin の commit を起こし、worker は「registration の開始と終了、query の時に自分の接続で `PRAGMA data_version` を比べる」fake（実 worker の検査と同じ形の drift）にする。対照（保留しない `begin`、prepare の最中に同じ commit）は registration が拒否される。(i-b) opt-in（`#[ignore]`、`NIR1_C_QUERY_WORKER_BIN`）の段：DI-1a の reach 試験と同じ実 B の fixture と実 worker で、保留 → 監査の commit（製品の接続と別の接続の両方）→ release → READY → query が available で、対照（READY の後に同じ commit）が stale になる。本物の `prepare_related_scene_query` は embedding の model が要るので通さない。代わりに、fake の commit が本物と同じ順序・同じ writer であることを行の event type の列で確かめ、`begin.rs` の中で release が `prepare_related_scene_query` と participant の読取の後、`build::schedule` の前にあることを source の順序の試験で固定する | 試験だけ。製品の経路に seam を足さない | 実 Electron の (ii) をこの branch で行う案：CP-4 の harness が無い。手順を末尾に書き、integrator が統合 branch で行う | 同上 | 該当なし | — | 記録済み |

## 3. owner／lifecycle matrix（GDX-PRECHECK-001）

### 3.1. phase × event

「RS」は Related Scenes の `begin_deferred`、「DF」は D-final の `begin`。「—」は起きない組合せ。「今のまま」は master の挙動を変えない。

| phase ＼ event | RS の begin | DF の begin | release | declare／cancel（保留の ticket） | lease の失効 | edge | shutdown（`close`） | prepare の成功／拒否 | query の成功／drift | 保留の期限 |
|---|---|---|---|---|---|---|---|---|---|---|
| Empty | thread を spawn → **Deferred**、`Pending`（backoff 中は最後の理由で即答） | 今のまま（spawn → Preparing、`warming`） | 照合する保留が無い：何もしない | — | — | 今のまま | 今のまま（Closed） | — | — | — |
| Deferred（保留中） | `busy`（unserved） | 同じ key は `warming`、別の key は `busy`（unserved） | `Arc` と epoch が一致し未取消・期限内なら released を立てて Wake → owner thread が **Preparing**（rebuild の窓へ）。それ以外は何もしない | 取消：Wake → 保留を捨てて **Empty**（`deferred_dropped`） | lease の終わりは cancel と同じ | Wake → ticket に `invalidated`、**Empty**（`deferred_dropped`） | Wake → ticket に `invalidated`、**Closed** | — | — | ticket に `timeout`、**Empty**（`deferred_expired`） |
| Preparing（持たせた session） | 今の規則（同じ key `warming`／別 `busy`） | 今の規則 | 2 回目：何もしない | flag だけ。READY で見て query せず退役 → **Empty** | 同左 | 今のまま（窓／admit／READY で退役）。ticket に `invalidated` | 今のまま。ticket に `invalidated` | 成功 → **InUse**（Ready を公開しない、通知なし）。拒否 → 今の分類で数え、ticket にその理由、Empty／Suspended | — | — |
| Ready（持たせない session の READY） | 同じ key：worker を退役 → **Deferred**（`stale_ready_retired`）。別の key：今の rekey の規則、奪うなら Deferred | 今のまま（`Pending`、InUse） | — | — | — | 今のまま | 今のまま | — | — | — |
| InUse（持たせた session の query） | `busy` | `busy` | 何もしない | 今のまま（query の cancel） | 同左 | 今のまま（結果を `invalidated`） | 今のまま | — | 成功・drift とも ticket に渡し、**Empty**（自動の Rebuild なし） | — |
| InUse（DF の query） | 今のまま（`busy`） | 今のまま | — | — | — | 今のまま | 今のまま | — | 今のまま（Rebuild） | — |
| Retiring | 今のまま（`busy`） | 今のまま | — | — | — | 今のまま | 今のまま | — | — | — |
| Suspended | 世代が同じなら今のまま（unserved）。進んでいれば Empty として扱う | 今のまま | — | — | — | 今のまま | 今のまま | — | — | — |
| Quarantined | `restart-required` | 今のまま | — | — | — | 今のまま | 今のまま | — | — | — |
| Closed | `invalidated` | 今のまま | 何もしない | — | — | — | — | — | — | — |

不変条件：(1) 保留は高々 1 件で、保留があるとき phase は必ず Deferred、Deferred のとき owner thread は必ず 1 つある。(2) 保留の ticket は、release、取消、edge、shutdown、期限、owner thread の終わり（panic を含む。`SessionGuard` の in-flight）のどれかで必ず 1 回だけ settle する。(3) 持たせた session は READY を公開せず、`notify_ready` を出さない。(4) worker を作るのは release の後だけ（Ready の退役で作り直すのも release の後）。

### 3.2. 入口・待ち・終了の区分（cp2a の matrix の区分）

| 区分 | 変更 |
|---|---|
| entry | `begin_deferred` を足す（admission の検査は `begin` と共有）。D-final の `begin` は変えない |
| start、retry、reentrant | 保留は 1 件。2 件目は `busy`。release は 1 回だけ効く（2 回目、取消の後、期限の後、edge の後は何もしない） |
| cancellation | 取消は ticket の flag と owner thread の Wake。保留を捨てるのは owner thread だけ |
| active handle | 保留中は worker も workspace の pin も持たない（restore の physical exclusion を妨げない） |
| bounded wait | begin と release は wait 0（slot の lock を短く取るだけ、spawn は今の `start_session` と同じく slot の lock の下）。owner thread の保留の待ちは期限 2 s で終わる |
| 終了の証拠 | owner thread の終わりは今の `SessionGuard` と `session_main`（`signal_ready` と queued の settle）。保留の ticket は in-flight として guard に渡すので panic でも `failed` で settle する |
| error、timeout | 保留の期限は `timeout`。release の後の失敗は今の `prepare_failure`／`query_failure` の分類 |
| restart の状態 | process-local のまま。保留は保存しない |

### 3.3. lock の順序

begin の thread（lock なし）→ GraphState の内側の lock（ticket の handle を複製するだけ）→ 外す → owner の slot（leaf として短く）。ticket の取消は ticket の state の lock を外してから slot を取る（`ticket → slot` を入れ子にしない）。owner thread は slot の lock の下で ticket の state の lock を取らない（保留を slot から外してから `deliver` する）。cancel flag は atomic。既存の順序（Core → slot、slot → cache、ticket → cache、unserved は leaf）は変えない。registry の lock の下で operation が drop されると、ticket の Drop → slot になるが、owner は registry を取らないので逆順は無い。

## 4. threat model（技術的。確認済みの actor・防御・受信先の範囲内）

| 脅威 | 防御 |
|---|---|
| 保留の漏れによる DoS（release も取消も来ない begin が slot を塞ぐ） | 期限 2 s（owner thread が自分で `timeout` にして slot を空ける）と、begin の RAII の guard（どの出口でも release か cancel）。ticket の Drop も取消 |
| 別の ticket による release（古い begin、別の window） | `Arc::ptr_eq` の同一性。ID の文字列では照合しない |
| edge や shutdown をまたいだ release（別の workspace の需要で prepare する） | 保留を作ったときの edge epoch と closed を release で検査し、owner thread も edge で保留を捨てる。admit は今のとおり Core の binding、authority、locator を照合する |
| cache の汚染 | cache の key、TTL、edge epoch、quarantine、requalify（DSN §2.3）は変えない。cache に入るのは今と同じ `Unused` の Available だけ |
| deadlock | §3.3 の順序。release は wait-free、owner thread は slot の下で他の lock を待たない |
| 通知の濫用（graph-ready の連打） | 持たせた session は READY で通知しない。通知は late cache の 1 回 |
| 鮮度の隠蔽 | F10 による stale／drift はそのまま返す（DR-CQD-8）。`ReadIdentity` の検査は触らない |
| privacy・保存・外向きの通信 | 増えない。slot が持つのは project／scene／seed の ID と ticket だけで、本文・抜粋・応答を持たない。worker の起動条件（restricted profile、publication の gate）は変えない |

## 5. 時間の見込み（TASK §2.5）

release から Graph が届くまで：rebuild の窓（前の prepare から最大 1 s。初回は 0）＋ prepare 約 33 ms ＋ query（lease 100 ms の内）＋ Native の requalify。常に graph-late。lease 100 ms は parent の受付から有効な結果までで startup を含まない（proposal/7:222）。cache の TTL 30 s で足りる。Raw の時間は変わらない（begin の owner 呼出しは wait 0 のまま、prepare が begin の監査の commit と並ばなくなる分だけわずかに速くなる見込み）。D-final の READY 待ちは、保留中と持たせた session の間は `warming` のまま待ち、その session の終わりで自分の session を作る。最悪は「保留の残り（begin の残りの時間、上限 2 s）＋ 持たせた session（窓 ≤1 s ＋ prepare ＋ query）＋ D-final 自身の窓（≤1 s）＋ prepare ＋ query」で、通常は 4 s の予算に収まるが、保留が期限まで残る病的な場合は D-final が `WaitExpired`（Graph なしで続行、fail-soft）になりうる（未測定。実装後の追記の未検証に残す）。

## 6. 実装後の追記（2026-10-25。上の本文は直さない）

### 6.1. 実装の要点（commit `f899491b`）

- `nir1_graph_product.rs`：`begin_deferred`（admission は `begin` と共有する `admit_and_route`）、`Phase::Deferred`／`GraphSlotKind::Deferred`、`SlotState::deferred`（`DeferredDemand`）、`Command::Defer`、`TicketShared::deferred`（取消で owner thread を起こす）、`GraphTicket::release_after_own_commits` と `GraphTicketRelease`、`Shared::release_deferred`／`wake_deferred`、owner thread の `run_deferred`／`await_release`、`build_and_serve` を `build_worker`（窓・admit・create・prepare・失敗の台帳）と READY の公開に分けた。`SessionGuard` の Drop は、owner thread が保留を残して終わったとき（panic を含む）に `invalidated`（quarantine なら `restart-required`）で settle する（不変条件 (2) の安全網）。counter は `deferred_released`、`deferred_expired`、`deferred_dropped`、`stale_ready_retired`。保留の期限は `DEFERRED_RELEASE_LIMIT`（2 s、`GRAPH_AWAIT_LIMIT` と等しいことを試験で固定）。→ review P2-1 で 10 s の独立した定数に変えた（§7.2）。
- `related_scenes/graph.rs`：`GraphState::start` は `begin_deferred` を呼ぶ。`GraphState::release_after_own_commits`（内側の lock の下では handle を複製するだけ）。RAII の guard `DeferredRelease<T: LeaseEnd>`（`release` で release、Drop で cancel）。
- `related_scenes/begin.rs`：`begin_graph` の直後に guard を作り、outcome が `Ok` なら `release()`、`Err` なら drop（cancel）。`build::schedule` の前。
- D-final の経路（`nir1_graph_dfinal.rs`）、監査、`ReadIdentity`、registration／query の drift の検査、`src/`、IPC／preload／Main、gate、確認済みの値は変えていない。
- 試験（commit `c7c31eaa`）：`nir1_graph_deferred_tests.rs`（owner の試験 module の子）、`related_scenes/graph_tests.rs`（begin と同じ start → release の helper `start_released`、guard の試験）。`nir1_graph_product_tests.rs` は `TicketShared::new` の引数と module の取り込みだけ。`scripts/quality/impact-map.mjs` は全 path を分類した（fallback なし）。新しい試験 file の登録は要らなかった（owner の試験 file と同じく manifest の対象外）。

### 6.2. TASK からの調整（本文 DR-CQD-3、9、10 の再掲と実装で分かったこと）

1. 別の key の READY は rekey の規則のときだけ奪う（DR-CQD-3）。
2. `nir1_graph_eval` は master に無いので counter だけを足した（DR-CQD-9）。
3. 統合試験は (i-a) CI の段と (i-b) opt-in の実 worker の段に分けた（DR-CQD-10）。
4. 持たせた session の prepare の失敗は、保留の ticket にその理由（`registration-unavailable` など）で返す（`Built::Exit(reason)`）。master では warming の後の失敗は誰にも返らなかった。
5. 持たせた session が stale／busy を返すと、`deliver` が今のとおり project を unserved に記録するが、持たせた session は READY で通知しないので、その project への通知は次の D-final 型の READY か遅れた結果の cache まで出ない（TASK の「通知は 1 回だけ」に従った結果。DSN §3.4 (a) の「次の READY で知らせる」は、Related Scenes の需要については late cache の通知で代わる）。

### 6.3. 実行した検証（すべて focused。Quick／Full は走らせていない）

| コマンド | 結果 |
|---|---|
| `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib -- nir1_graph related_scenes`（owner、D-final、reach、RS、新しい試験を含む） | 184 passed、0 failed、5 ignored（opt-in）。負荷の下で 3 回続けて green（最終の内容） |
| 同 `-- i_b_the_real_worker --ignored --nocapture --test-threads=1`（`NIR1_C_QUERY_WORKER_BIN`） | passed（4 回。正しい build の上の最後の 1 回を含む） |
| `cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --lib --tests` | 警告なし |
| `rustfmt --edition 2021 --check`（変更した file） | 新しい差分なし（master に元からある差分は触っていない） |
| `pnpm eval:impact --base origin/master` | 全 path を分類、fallback なし。選ばれた light suite（`nir1-entity-relation-review`、`narrative-runtime`、`narrative-semantic-contract`）と heavy は走らせていない |

`--features nir1-graph-eval` の試験は master に feature が無いので走らせていない（統合 branch で行う）。`grimodex-db` の試験は、この lane が db crate を変えないので走らせていない。

### 6.4. 実測（(i-b)、実 worker、release build の worker と debug build の試験）

- 保留 → 製品の接続と別の接続の監査の commit（各 3＋2 行、推論の代わりに 11 ms）→ release：begin から release まで 26.6〜27.3 ms、begin から結果まで 44.1〜47.6 ms（release から結果まで約 17〜21 ms。初回なので rebuild の窓は 0）。4 回とも `prepareFailures=0`、`driftAtQuery=0`、`stampStale=0`、`preparesReady=1`、available。
- 対照（READY を作ってから同じ commit、その後に query）：4 回とも `stale`（owner の stamp が先に検出：`stampStale=1`、worker の `driftAtQuery=0`）。
- worker の binary は CP-4 の target の release build を scratchpad に複写して使った（sha256 `87a412cf73dfa66c3315472068ef5469eb6c49a6d4d6579b5029e2e524e2d26f`、2026-10-25 14:26 の build）。CP-4 と master の grimodex-db の差は feature の下の `nir1_graph_eval.rs` だけで、worker の source（`bin/`、`nir1_graph*`、`lib.rs`）に差は無い。

### 6.5. 落ちることを確かめた変異（1 つずつ入れて対象の試験を走らせ、sha256 で復元を確かめた）

| 変異 | 落ちた試験 |
|---|---|
| M1 release を監査つきの embedding（begin.rs:178）より前に置く | `begin_releases_the_held_query_after_its_own_commits_and_reads`（source の順序の試験）**だけ**。この変異を動的に検出する試験は無い（本物の `prepare_related_scene_query` を通す試験が無いため）。(i-a) の対照 1 は「commit の前に release した場合の結果」を owner の側で示すもので、begin.rs の変異そのものは走らせていない。動的な検出は (ii) に残す（§6.8 の 7）。（review P2-2 による訂正。2026-10-25） |
| M2 release より前の READY を使い回す（P3） | `p3_a_ready_worker_prepared_before_the_release_is_retired_unqueried` |
| M3 `Ok` の経路で release を忘れる（N3） | `begin_releases_…`（release の呼出しが無い） |
| M4 `Err` で取り消さない（guard の Drop が何もしない、N2） | `a_begin_that_fails_drops_its_hold_and_frees_the_slot_at_once` |
| M5 持たせた session の READY で通知する | `p1_a_held_query_prepares_only_after_its_release_and_is_announced_once` |
| M6 registration の拒否を数えない（N8） | `n8_refusals_after_the_release_still_count_and_suspend_at_five`、(i-a) |
| M7 participant の読取の中で release する | `begin_releases_…`（S0 の欠落は `a_release_inside_an_open_read_shows_as_a_missing_s0_stamp` が counter で示す） |
| M8 release で `Arc` の同一性を見ない | `n7_a_second_release_or_one_after_a_cancellation_does_nothing` |
| M9 保留の取消で owner thread を起こさない | `n3_dropping_an_unreleased_ticket_frees_the_slot_at_once`、`a_begin_that_fails_…`（最初は試験が owner thread の待ちの前に取り消していて生き残った。待ちに入ってから取り消すように直して再確認） |
| M10 保留の期限を見ない | `n3_an_unreleased_hold_expires_and_frees_the_slot` |
| M11 持たせた query の後に作り直して READY を公開する | `p1_…`（作り直しが無いこと） |
| M12 release を待たずに query する | `p1_…`、(i-a) |

注意：最初の変異の script は復元に `shutil.move` を使い、backup の古い mtime のまま戻したので、cargo が最後の変異（M9）の build を使い続けた回が 1 回あった（その回の回帰の 2 件の失敗は M9 の build によるもの）。復元した file を touch して build し直し、回帰・clippy・(i-b) をやり直した（上の結果はやり直した後のもの）。release の epoch の検査（`release_deferred` の `edge_or_closed`）を外す変異は、この時点の試験では落ちなかった（N4 は edge observer の Wake で owner thread が先に `invalidated` にするので、release の側の検査を通らない）。review safety P3-1 を受けて、Wake を送らず epoch だけ進める決定的な試験 `a_release_in_another_lifecycle_epoch_is_refused_by_the_release_itself` を足し、この変異が落ちることを確かめた（§7.3 の ME）。（訂正。2026-10-25）

### 6.6. 試験の競合（product の欠陥ではない）

- `settle_unused_before_the_result_caches_and_announces_the_project_once`：cache は notice の emit より先に埋まるので、cache を待った直後に event を読むと負荷の下で空のことがあった。notice と session の終わりを待つように直した。
- P3 の 2 件：fake の `retire` の counter は `retire` の始めに増え、owner の `stale_ready_retired` は `retire` が返った後に増える。owner の counter を待つように直した。

### 6.7. 未検証・残る risk

- 統合試験 (ii)（実 Electron、seed つきの実際の begin、semantic の埋め込みを含む）は未実施。手順は 6.8。本物の `prepare_related_scene_query` は通していない（model が要る）。fake の commit は製品と同じ writer・同じ順序（event type の列で確認）・同じ接続（authority）で、begin.rs の中の位置は source の順序の試験で固定した。
- 常に graph-late。K6/2 (a) の窓内率は構造的にほぼ全部が窓外（HOLD）。
- D-final の READY 待ち：保留中と持たせた session の間は `warming` のまま待ち、session の終わりの signal で自分の session を作る（P2、N6 で挙動を確認）。最悪の待ち（保留が期限まで残る場合に 4 s の予算を超えうる）は未測定。
- 編集中の保存の頻度による F10、別の window の begin が同時に来る場合、`build::schedule` の Idle の poll（250 ms ごとの読取）が owner の S0／stamp の try-lock と重なる頻度は未測定。
- 持たせた session の stale は project を unserved に残すが、その通知は次の D-final 型の READY か late cache まで出ない（6.2 の 5）。

### 6.8. integrator が統合 branch で行う実機の確認（(ii) の手順）

1. 統合 branch（`claude/nir1-cp4` に本 lane の 3 commit を取り込む）で、CP-4 の `nir1_graph_eval` を合わせる：`slot_name` の match に `GraphSlotKind::Deferred`（例 `"deferred"`）、`diagnostics_json` に `deferredReleased`、`deferredExpired`、`deferredDropped`、`staleReadyRetired`、`begin` と同じ `BeginProbe` を `begin_deferred` にも付ける（CP-4 は `begin` を `admit` で包んでいる）。`TicketShared::new` の引数（`deferred`）と CP-4 の `eval_notes` の初期化を合わせる。
2. CP-4 の runner（`scripts/quality/nir1-graph-eval/runner.mjs`）の sample ごとの `waitReady`（slot が `ready` で `preparesReady` が増えるのを待つ）は、D′ では成り立たない（Related Scenes の query は READY を残さず、slot は query の後に `empty`）。K6/2 の `graph-eval-procedure`（条件付き、未発効）も「各 sample の前に slot が新しい READY になったことを確かめる」と書く。D′ の下で何を前提にするか（slot が `empty` で保留が無いこと、など）は integrator の判断と、必要なら確認の対象（この lane では変えない）。
3. 評価 build の `.node` と dev fixture（`setup-driver.mjs`）で、CP-4 の隔離（`scripts/local-ci-xvfb.mjs`、Wayland／D-Bus 変数の除去）を守って、seed つきの `related_scenes_begin` を N 回（例 30）。各回：`related_scenes_graph_continue` を直接 2 s 待ち、Graph-only の handle があれば `nir1_evidence_qualify` で click、`unused` の settle の後の `graph-ready` で再 query が `Cached` になることを確かめる。
4. 受入れの値：評価の診断で `prepareFailures=0`、`driftAtQuery=0`、`deferredReleased=N`（cache hit の回を除く）、`deferredExpired=0`、worker の stderr に `REGISTRATION_REFUSED` が無いこと。`diag-registration.mjs` の `owner-quiet` の段で、owner の prepare が READY になること。
5. seed あり／なしで `rawReadyElapsedMs` の分布が変わらないこと（Raw の時間は D′ で増えない）。
6. 対照：本 lane の commit を外した build（master の owner）で同じ手順を行い、`prepareFailures>0` または `driftAtQuery>0` になること（DR-CP4-S1C2-19〜22 の再現）。
7. M1 の動的検出（review P2-2）：begin.rs の release を `prepare_related_scene_query` の前に移した build で同じ手順を行い、`prepareFailures>0`（registration の拒否）または `driftAtQuery>0` になること。この lane の試験は M1 を source の順序でしか検出しない。
8. cold start（review P2-1）：起動直後の最初の seed つきの begin（embedding の model の初回ロードを含む）で、begin の受渡しから release までの時間を記録し、2 s を超える場合も保留が `timeout` にならず（`deferredExpired=0`）Graph が届くこと。保留の期限は 10 s（§7.2）。10 s を超える cold start が見つかったら integrator に返す（期限は漏れの上限で、確認済みの値ではない）。
9. 2 つの表示＋連続編集（再 review P2-A）：同じ project を 2 つの Related Scenes の表示が待ち、編集の自動保存を続けた状態で、一定時間（例 60 s）の `graph-ready` の通知の回数、begin の回数、`ai_audit_events` の増分を記録する。編集を止めた後に往復が止まることを確かめる。

### 6.9. 重要な変更への該当

無い。監査（順序と内容）、鮮度の判定（`ReadIdentity`、registration／query の drift）、保存の範囲、security の境界、確認済みの値と閾値、閉じた gate、D-final の経路はどれも変えていない。新しい受信先・保存・authority は無い。6.8 の 2（評価手順の READY の前提）は、手順の文の扱いを決める必要があるかもしれない点として integrator に返す（この lane では手順も runner も変えていない）。

## 7. 独立 review（lifecycle／safety）の指摘への対応（2026-10-25。§6 は 6.5 と 6.8 だけを訂正した）

### 7.1. 修正と commit

| 指摘 | 対応 | commit |
|---|---|---|
| P1-1 保留つき session の間に待たされた需要に通知が来ない | `Session::held`（その間に `warming`／`busy` で待たせた project の一覧。distinct、上限は `MAX_UNSERVED_PROJECTS`）を持たせ、session の終わり（`session_main` の `signal_ready` の後、lock の外）に `take_unserved` して `notify_ready` を 1 回ずつ出す。保留つき query 自身の stale（F10）は一覧に入れない | `ba81edd1` |
| P2-1 保留の期限 | `DEFERRED_RELEASE_LIMIT` を `GRAPH_AWAIT_LIMIT` から切り離し 10 s にした（7.2） | `f99ea7c6` |
| P2-3／safety P3-2 取り消された保留が slot を占める | `wait_rebuild_window` の loop の先頭（各 recv の後）と worker の create の直前で cancel を見て `Built::Exit(Cancelled)`。取消の wake は保留つき session のどの phase でも送る | `0fea9c3d` |
| safety P3-3 begin.rs の comment | closure の `Err`、release の後の `?`（`current_request`、`build::schedule`）、unwind を書き分けた（挙動は不変） | `f32b3362` |
| safety P3-4、lifecycle P3-2、P2-2／safety P3-1 | 試験の補強（7.3） | `443e782c` |
| P2-2／safety P3-1 記録 | §6.5 の M1 行と epoch の検査の記述を訂正、§6.8 に 7（M1 の動的検出）と 8（cold start）を足した | この docs の commit |

### 7.2. 保留の期限（P2-1）と D-final の待ち

保留の期限は begin の受渡しの時刻から数える。begin には上限が無い（cold start は最初の監査の commit の前に embedding の model を読む）ので、10 s は漏れの上限で、遅延の上限ではない（Related Scenes の await の 2 s は begin が返った後に始まるので、両者は別の時計）。試験は「await の 4 倍以上、30 s 以下」と「await を超えて release された保留が提供される」に替えた。

D-final への影響：保留中（と持たせた session の間）に来た D-final の begin は、同じ key なら `warming` で待ち、その session の終わりの signal で自分の session を作る。保留が長い（cold start の begin、または release されず期限まで残る）と、D-final の待ちは延びうる。D-final には 4 s の予算（`GRAPH_WAIT_BUDGET`）があり、超えれば `WaitExpired` で Graph なしで進む（fail-soft。D-final の経路と予算は変えていない）。期限を 10 s にしたことで、release されない保留が D-final の待ちを予算の終わりまで占めうる範囲は広がった（2 s → 10 s）。どちらの場合も D-final は予算で止まる。この頻度は未測定。

既知の制約（再 review P2-A。直さない）：同じ project を 2 つの表示（panel の窓として切り離した Related Scenes など）が待つと、保留された側が stale になり続ける間（編集の自動保存が prepare の窓に入り続ける間）、通知 → 再 query → 保留 → もう一方は busy → session の終わりの通知、が `rebuild_min_interval`＋prepare の周期で往復しうる（1 周ごとに begin が 2 回、監査が 5 行ずつ）。止まる条件は編集が止まること。「自分の stale を除けばループしない」（7.1 の P1-1）は表示が 1 つのときだけ成り立つ。通知に project ごとの間隔の下限を付ける案は採らない：抑止した通知は次の READY まで失われうるが、D′ には自動の Rebuild が無いので、その READY がいつ来るかは決まらない（待たされた表示が Graph を受け取れなくなる）。往復の回数は (ii) で測る（§6.8 の 9）。

### 7.3. 試験と変異

足した試験（owner の試験 module）：`p4_a_demand_made_to_wait_by_a_held_session_is_announced_once_at_its_end`、`p4_the_held_querys_own_stale_answer_is_not_announced`、`n2_a_release_later_than_the_await_limit_is_still_served`、`n3_a_cancellation_during_the_rebuild_window_creates_no_worker`、`i_a_without_s0_a_commit_before_the_query_is_caught_by_the_worker_drift`（S0 欠落 → `stamp_unavailable` → query の前の commit → worker の drift で stale、`drift_at_query=1`）、`a_panic_of_the_held_query_settles_it_once_as_failed`（in-flight で 1 回、`deferred_dropped=0`）、`an_owner_thread_that_ends_while_holding_settles_the_hold_once`（takeover で退役する READY が quarantine → guard が `restart-required` で 1 回、`deferred_dropped=1`）、`a_release_in_another_lifecycle_epoch_is_refused_by_the_release_itself`。N1 と (i-a) の対照 1 に「`finish(Unused)` の後に cache が空、通知なし」を足した。RS の試験の等値の試験は `the_owner_hold_limit_outlasts_a_begin_longer_than_the_await` に替えた。

| 変異（1 つずつ入れて対象の試験を走らせ、sha256 と touch で復元を確かめた） | 結果 |
|---|---|
| MA1 session の終わりの通知を消す | `p4_a_demand_…` が落ちた |
| MA2 終わりに unserved の全部を通知する（自分の stale を含む） | `p4_the_held_querys_own_stale_…` が落ちた |
| MB 期限を 2 s に戻す | `n2_…` と `the_owner_hold_limit_…` が落ちた |
| MC 窓の待ちの cancel の検査を消す | `n3_a_cancellation_during_…`（取消から slot が空くまで 300 ms 未満）が落ちた |
| ME `release_deferred` の epoch の検査を消す | `a_release_in_another_lifecycle_epoch_…` が落ちた |
| MF create の直前の cancel の検査だけを消す | **生き残った**。このとき「窓の検査が先に止めるので冗長」と書いたのは誤り（再 review P3-1 による訂正）。窓が 0 s のとき（前の prepare から 1 s 以上経っている、本番の普通の場合）は、loop の先頭の検査が 1 回通るとすぐ return し、その後（admit の実行中）に来た取消を捕まえるのは create の直前の検査だけで、無いと worker の create と prepare を 1 回無駄に行ってから `run_deferred` で退役させる。冗長ではなく、当時は**試験が無かった**。§8 で admit の hook の試験を足し、この変異が落ちることを確かめた |

### 7.4. 確認だけの項目

- lifecycle P3-1（IR scoring の接続）：begin.rs:190 の `spawn_blocking` で走る `scoring::run` は `db.with_participant_read_transaction`（`narrative_maintenance_connection.rs:1226` → `with_participant_sql_scope_config_with_stop` → `Database::lock_conn_with_check`）を使い、**主接続の mutex と同じ**である（owner の S0／stamp の `try_read_c_query_freshness_stamp` は同じ `db.conn` を `try_lock` する）。IR scoring は Raw-ready と並行に走り、begin の outcome を待たないので、release の後もその読取（資格の確認、title と language の読取、再検証）が続きうる。その間に owner の admit が来ると、try-lock が失敗して `stamp0_missing` になり、その query は stamp の比較をせず（`stamp_unavailable`）worker の registration と query の drift の検査だけが鮮度を守る（偽の fresh にはならない。新しい試験 `i_a_without_s0_…` がこの経路を示す）。影響は owner の側の早い stale の検出が無くなることだけ。頻度は未測定（(ii) で `stamp0Missing` を記録する）。
- lifecycle P3-3（admit の失敗の理由が粗い）：既知。admit が `None` を返すとき（edge、AppState の消失、restricted profile でない、binding の不一致）は、保留の ticket にすべて `invalidated` を返す。今回は直さない。

### 7.5. 検証（最終の内容 `443e782c` に対して）

| コマンド | 結果 |
|---|---|
| `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib -- nir1_graph related_scenes` | 192 passed、0 failed、5 ignored。負荷の下で 2 回続けて green |
| 同 `i_b_the_real_worker -- --ignored`（実 worker） | passed（release 26.6 ms、結果 45.2 ms、`prepareFailures=0`、`driftAtQuery=0`、対照は stale） |
| `cargo clippy … --lib --tests` | 各 commit で警告なし |
| `rustfmt --check`（変更した file） | 新しい差分なし（**誤り**：`nir1_graph_product.rs` に 3 か所の差分が残っていた。再 review の対応で `917218bb` で直した。§8） |

未実施：(ii)（実 Electron）、cold start の実測、D-final の待ちの延びの実測、Quick／Full。


## 8. 独立再 review（「条件つきで可、P1 なし」）の指摘への対応（2026-10-25）

| 指摘 | 対応 | commit |
|---|---|---|
| P3-2 窓の取消の試験が負荷の下で落ちうる（600 ms の窓が先に過ぎる、「300 ms 未満」が壁時計に依存） | 窓を 3 s に広げ、判定を窓の終わり（最初の create の時刻＋窓）との比較にした。窓が開いていることを前提として確かめ、slot が空いた後の create の数を見る（空になるのは session の guard の後なので、それ以上 create は起きない）。後の固定の sleep は消した | `feb5de22` |
| P3-4 notifier の panic で `settle_queued` が走らない | `session_main` で `settle_queued` を通知より先に行う順にした | `5e9fec56` |
| P3-3 lock の外で通知することの試験 | notifier の中から `begin_deferred` を呼ぶ試験 `p4_a_notifier_that_calls_back_into_the_owner_is_answered`。呼出しは別の thread から 2 s の上限つきで待つので、通知が slot の lock の中に移されると試験は止まらずに失敗する（同じ thread で呼ぶと std の Mutex の再入で test の process が止まるため、この形にした） | `2da69ed1` |
| P3-1 create の直前の検査の記録 | §7.3 の MF の行を訂正した。admit の最初の edge の検査の後に試験用（`cfg(test)`）の hook を置き、admit を止めている間に取り消すと worker の create も prepare も起きない試験 `n3_a_cancellation_during_admit_creates_no_worker` を足した | `3340344a` |
| P2-A 2 つの表示の往復 | 直さない。§7.2 に既知の制約として書き、§6.8 の (ii) に 9 を足した | この docs の commit |
| （自己点検）rustfmt | 前回の修正で入った 3 か所（import の順、2 つの式）を rustfmt の形にした。§7.5 の記述を訂正 | `917218bb` |

変異（1 つずつ入れて対象の試験を走らせ、sha256 と touch で復元を確かめた）：

| 変異 | 結果 |
|---|---|
| MN session の終わりの通知を guard の Drop（slot の lock の中）に移す | `p4_a_notifier_…` が落ちた（`blocked`） |
| MF create の直前の cancel の検査を消す | `n3_a_cancellation_during_admit_…` が落ちた（create 1 回） |
| MC 窓の loop の先頭の cancel の検査を消す | 書き直した `n3_a_cancellation_during_the_rebuild_window_…` が落ちた（slot が空くのが窓の終わりの後） |

notifier の panic の順（P3-4）を落とす試験は足していない（順の入替えだけ）。

検証（最終の内容に対して）：`cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib -- nir1_graph related_scenes` を負荷の下（suite の並列実行）で 2 回続けて実行し、2 回とも 194 passed、0 failed、5 ignored（opt-in）。clippy（`--lib --tests`）は各 commit で警告なし。`rustfmt --check` は変更した file で master に元からある差分（`nir1_graph_product.rs` の 13 か所、`nir1_graph_product_tests.rs` の既存の差分）だけ。

未実施：(ii)（実 Electron。§6.8 の 1〜9）、cold start と 2 窓の往復の実測、Quick／Full。

## 9. Graph の窓の gate（CP-4 の失効 lane。2026-11-02。mutation の前に記録）

出所：CP-4 の診断 2 回と背景の commit の調査（contracts `docs/plans/nir1-cp4-records/diag-lpd-2026-11-02/README.md`）。編集 trace の表示の欠落 22/22 件（11＋11）で、D′ の held query の窓（登録、query、token の合流）に incremental Freshness の cycle の commit（予約または publish）が重なっていた。Graph の窓の間、Freshness の commit を止める仕組みは無い。ユーザーは案 2（Graph の窓の間、Freshness の commit を待たせる gate）を選んだ（contracts `docs/plans/nir1-cp4-records/user-confirmation-2026-11-02-lapse-gate-plan2.md`。範囲は設計、独立 review、実装、実装の review、PR まで。契約・authority、IPC 契約、保存範囲、送信先、閾値・Gold・失効の読み、防御の緩和は含まない）。この lane は AGENTS の委任レーンの一覧に名の無い CP-4 の lane で、上のユーザーの確認を第一の根拠とし、その範囲の中の worker／owner／lifecycle の技術判断だけをここに記録する。設計は read-only の 3 案（X：native 側の lease、Y：Main の TS 側の推定、Z：双方向の握手）を比べ、案 X を土台に integrator が修正した。基点は master `8dd7a9c0`、branch `claude/cp4-lp-gate`。file:line は基点のもの。

### 9.1. 着手前の確認（結果）

| 確認 | 結果 |
|---|---|
| (a) 確認台帳と確認済み契約に、Freshness の遅れの上限を閾値として固定したものが無いこと | **無い**。`docs/plans/nir1-continuation-2026-10.md` §1 の U・SB- の行（SB-1〜SB-15、SB-X1Q6、SB-X1A1B）に Freshness の遅れの値は無い。`docs/plans/` と `policies/` を `Freshness`／`鮮度` × `以内｜遅れの上限｜latency｜N ms／秒以内` で grep して、該当は無かった。K6/4 の確認済みの値（T_late 100 ms＝Raw-ready から `graph-ready` の通知まで、W_f 100 ms＝取り直しの Raw-ready から Graph の到着まで、T_show 2 s、1%）はどれも Graph の表示の時間で、Freshness の cycle の時刻ではない。近い数値は `MAX_SCHEDULER_LIVENESS_AGE` 5 s（`c2zc_canonical_cutover.rs`。scheduler の liveness の上限で、遅延の閾値ではない）と、harness の `FRESHNESS_SETTLE_LIMIT_MS` 15 s（`frozen-k64-run.mjs:131`。測定の前の hang guard。DR-CP4-T-1）だけで、どちらも閾値ではない |
| (b) CP-4 の harness と S2 の pin が、Freshness の cycle の回数や時刻を数えていないこと | **数えていない**。`scripts/quality/nir1-graph-eval/` と `scripts/quality/nir1-graph/` が Freshness を読むのは、測定の前の `waitFreshnessSettled`（`frozen-k64-run.mjs:723`、`workspace-db.mjs:170` の `readFreshnessFeed`＝feed の head と cursor の ack の比較。上限 15 s、間隔 100 ms）と、測定点の feed の位置の記録（:828）だけ。`narrative_extraction_runs` の読み、cycle の数、cycle の時刻の判定は無い。`FRESHNESS_REASONS`（`join.mjs:16`。stale／warming）は Graph の ticket の理由で、延期はこの理由を作らない（延期は Freshness の戻り値で、Graph の ticket に出ない）。測定の前は Graph の窓が開いていないので、settle の待ちに gate は効かない。延期は受領書の判定・admission を変えない |
| 製品：`PendingUnknown`（未 ack の 1,024 sequence〔16 page × 64〕／4,096 event。`revision_eligibility/pending.rs:17-19`） | 影響しない見込み【推論】。延期の上限は 1 回の窓で 500 ms、累計の天井 1 s。lease は Related Scenes の held query 1 回につき 1 本で、held query は `rebuild_min_interval`（1 s）ごとに高々 1 回 prepare するので、lease の duty は 1 s に 500 ms 以下。lease の外では今と同じく backlog の 10 ms ごとに 32 sequence（`MAX_CANONICAL_SEQUENCES_PER_BATCH`）を処理する。未 ack が 1,024 を超えるには、今より 1 s 程度長い遅れの間に約 1,000 sequence の書込みが要る。超えても `pending::read` は `PendingUnknown`（閉じる側）で、誤った開示にはならない |
| 製品：B（Chronicle の Index）の qualification と `index-ready` の順序 | 順序は変わらない。遅れうる【確認済み：`nir1_chronicle_index/build.rs:141-145`、:220-223】。B の build は前の pool の入力と新しい入力の両方で `pending::read` が Ok であることを求め、関連する未 ack の変化があれば `PendingChange` → `related_scenes/build.rs:178` の `Retry`（250 ms 後に再試行）になる。だから関連する変化の ack が延期されると、B の publish と `index-ready` はその分（最大で窓 1 つの 500 ms、天井 1 s）遅れうる。`index-ready` は B の publish の直後に同じ loop で出る（`build.rs:44-49`）ので、publish と通知の順序は変わらない。この trace では本文だけの保存は B に無関係（X1-5）で、B は query の約 400 ms 前に終わる（S7 §1）ので影響は無い |
| 製品：T_late（確認済み 100 ms） | 閾値は変えない。Graph が in-flight の Freshness の区間を待つ（上限 100 ms）回は、親の `store_late_cache` → `graph-ready` の通知がその分遅れ、T_late（観測の max 57.3 ms）を超えうる。頻度は「窓の開始時に区間が in-flight」の確率（約 1%）× 区間の残りが長い確率で、0.1% 未満と見込む【推論】。gate が無ければ同じ回は登録の drift で閉じる側に落ちるので、悪くはならない。100 ms は X 案の 300 ms を縮めた integrator の判断（9.2 の GATE-4） |

### 9.2. 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQD-GATE-1 | 2026-11-02 | CP-4 失効 lane（`claude/cp4-lp-gate`） | **置き場所**。新しい module `electron/native/grimodex-node/src/nir1_graph_commit_gate.rs` に `GraphCommitGate`（leaf の `Mutex` 1 つと `Condvar` 1 つ。durable にしない）を置き、Graph の owner の `Shared`（`nir1_graph_product.rs:465`）が `Arc` で持つ。`Nir1GraphProductOwner::commit_gate()` で取り出す。共有の `grimodex-db`、TS の製品コード、`ipcContract.ts`、preload、`index.d.ts`、schema／migration は変えない | actor は同じ process の Freshness の blocking thread と Graph の owner thread と合流の blocking thread だけ。gate が持つのは id、時刻、数だけで、本文・ID・文字列を持たない。renderer からは届かない（gate を触る IPC は無い）。新しい受信先・保存・送信先は無い | 案 Y（Main の TS が IPC の系列から窓を推定する）：窓の頭（prepare の開始）と in-flight の publish を TS から止められず、renderer の振る舞いが変わると黙って効かなくなる。案 Z（握手）：構造は同型で、Graph の待ち 25 ms と「直近」の推定を足す分だけ複雑。どちらも土台にしない（Z の飢え防止だけ GATE-5 で取り込む） | integrator の brief（X を土台にする修正）と、実装前の advisor（2026-11-02。DR の置き場所、印と waiter の扱い、漏れの順序、eval の識別子の注意） | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-2 | 2026-11-02 | 同 | **Freshness の区間は cycle 全体**。`run_narrative_freshness_cycle_supervised`（`lib.rs:7374`）の先頭、recovery の reconcile（:7382-7386）の前で、blocking thread で gate に入る。`Admitted`／`Overridden` なら区間（RAII、`Arc`）を async の stack と 2 つの blocking の closure（reconcile の `run_blocking` :7384、body の `spawn_blocking` :7442）に clone して持ち、どの出口（return、`Err`、panic の unwind、async の task の drop）でも最後の clone の Drop で閉じる。区間の中には予約、評価の中の lease の更新、publish、requeue、heartbeat と cutover、CI の quiescence の読みが全部入る。publish の前に gate を再確認しない（区間が in-flight の間は Graph が lease を取らないので、予約の後に窓は開かない）。`FreshnessLifecycleControl::check` は使わない（その `Err` は recovery への移譲になる） | 延期は DB に触れず、permit も workspace operation も取らない。Freshness の authority、cursor、Run の扱いは変えない | (i) 予約の前と publish の前で 2 回見る（共有の Rust に checkpoint が要り、publish の前で待つと Run と cursor の lease を持ったまま待つ。拡張案 X+ として残す）。(ii) body の先頭に置く（Z。reconcile の commit が gate の外に残る） | 同上 | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-3 | 2026-11-02 | 同 | **Graph の窓の始まり**。`build_worker`（`nir1_graph_product.rs:2163`）の中、`wait_rebuild_window`（:2171-2177）が通った後、`admit`（:2178。stamp0 を読む）の前。`held.is_some()`（D′ の held query。`run_deferred` :2275 から）のときだけ。D′ の保留の間（`await_release` :2312）と rebuild の窓の間は lease を取らない。D-final の `begin`（`build_and_serve`、READY の長い idle）には窓を開かない | owner thread は gate を待つ間、slot・cache・ticket の lock を持たない。gate の待ちは失敗に数えない（`consecutive_failures` に触れない） | 窓を `admit` の後に開く：stamp0 から prepare の開始までの commit を守れない。D-final も覆う：READY の最長 120 s の間 Freshness が止まる | 同上 | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-4 | 2026-11-02 | 同 | **Graph の待ちと、上限を超えたとき（integrator の修正）**。Graph は窓を開く前に、Freshness の区間が in-flight か、Freshness の番（GATE-5 の印）の間は待つ。両方で 1 つの予算 **100 ms**（X 案の 300 ms を縮めた。T_late の余裕を食わないため）。待つ間は Graph の待ち（`graph_waiters`）を立て、Freshness は新しい区間を始めない（印の間を除く）。待ちの刻みは 10 ms で、刻みごとに ticket の取消と edge／close を見る。取消・edge なら lease なしで返り、後の既存の検査で Exit。**予算を超えたら lease を取らずに（窓なしで）進む**（X 案の「上限の後に lease を取る」は採らない）。その窓は今と同じく drift しうる（stamp、worker の drift、requalification の閉じる側の検査は変えない。誤表示にならない） | 鮮度の判定（`ReadIdentity`、stamp、`edge_holds`）は変えない（DR-CQD-8 の F10 の防御と矛盾しない。gate は commit の時機だけを動かす） | 上限の後に lease を取る（X）：後続の Freshness を止めるだけで、in-flight の区間の commit は防げない | 同上 | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-5 | 2026-11-02 | 同 | **Freshness の待ちと飢え防止（Z から取り込む）**。Freshness は有効な lease が 1 本でもあるか、Graph の待ちが立っていれば待つ。1 回の呼出しの中で **250 ms** 待っても入れなければ『延期』を返し、**延期の印（50 ms）**を立てる。印の間は (i) Graph は新しい窓を開かず待つ（GATE-4 の予算の中）、(ii) Freshness の入場は Graph の待ちを無視する（lease が無ければ入る）。印は区間を取ったときに消える。最初に待たされてから累計 **1 s**（天井）で、lease を無視して区間を取る（`overridden`）。lifecycle の停止（`ws.switching`、`workspace_shutdown_requested`、owner の closed）は刻み（10 ms）ごとに見て、すぐ延期で返す（印は立てない） | 延期の上限があるので、gate の bug（放し忘れ）でも Freshness は最大 1 s ごとに進む | 印を置かない（X のまま）：再予約の 10 ms の間に次の窓が開くと、天井まで延期が続きうる。Freshness が lease を待つ間（印の前）も新しい窓を止める（Z の Parked）：brief の範囲の外の追加で、別の query の窓を窓なしにする回が増える。採らない | 同上（advisor の指摘：印の間の Graph の待ちを Freshness の入場の条件に数えると、互いを待って印の 50 ms まで止まる） | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-6 | 2026-11-02 | 同 | **lease の移り方と放す点**。lease は RAII（`WindowLease`。期限 **500 ms**）で、ticket → late cache → child の Cached の合流と move する。放す点（どれも冪等、最初のものが放す）：(a) `TicketShared::deliver`（:917）の `Unavailable`、(b) `finish(Cancelled)`（:946。renderer の cancel、operation の lease の終わり、begin の `Err`、ticket の Drop、`DeferredRelease` の Drop）、(c) `finish(Used)`、(d) `finish(Unused)`／`deliver(Available)` で cache を埋めるときは `store_late_cache`（:637）へ move し `CacheEntry` に入れる（cacheable でなければ Drop。outcome の無い `finish(Unused)` では放さない）、(e) `take_usable_cache`（:611）の hit で projection と一緒に `GraphBegin::Cached(CachedGraph{projection, window})` → `GraphSlot::Cached`（`related_scenes/graph.rs:87`）へ、(f) cache の破棄（quarantine の clear :2032-2036、置換 :643、使えない entry :629-631、quarantine 中の store :640）、(g) 合流の終わり：`await_request`（`graph.rs:660`）の `Claim::Await` の後に Cached の slot の lease を放す guard を置き、`assemble`（:725-733）の直後かそれより前の exit で放す（Pending の slot は (a)〜(d) に任せる）、(h) `GraphState::declare`（:271）が Cached を Settled に置き換えるとき、(i) lifecycle の edge（`GraphEdgeObserver` :1019）と `Shared::close`（:665）で gate の lease を全部無効にして notify、(j) 期限 500 ms で数えなくなる、(k) D-final の `GraphBegin::Cached`（`nir1_graph_dfinal.rs:325`）はその場で放す。**不変条件**：決着した ticket（outcome と disposition の両方がある、または Cancelled）は lease を持たない。`deliver`／`finish` の早期 return（既に決着）でも lease を取り出して放す。窓を付けるとき（`attach_window`）に ticket が既に決着していれば、その場で放す | lease の漏れは期限 500 ms と天井 1 s で無害化される（Freshness が止まるのは最大 500 ms） | lease を await の guard だけで放す（Pending の slot も）：native の合流の後に renderer が unused を出して cache を埋める場合の分け方が要る。採らない | 同上（advisor の指摘：G0 → 格納 → 取消の検査 → Exit の間に `finish(Cancelled)` が先に走る順序で、`deliver` の早期 return が lease を残す） | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-7 | 2026-11-02 | 同 | **延期の戻り値**：`Ok(Some({"hasMore":true,"noWrite":true,"deferred":"graph-window"}))`。`quiescenceState` を含めない（DB を読まない）。TS の製品コードは変えない。根拠【確認済み】：`freshnessCycleObservation`（`electron/main/narrativeFreshness.ts:121-155`）は未知の key を拒まず、`heldProjectId` は null、`cutoverNotReady` は false で検査を通る。`batchHasMore` が true なので次は `BACKLOG_DELAY_MS`（10 ms。:261-263）で、1 s の idle poll（:230）に戻らない。`nextCycleGuardStateDigest` は `hasMore` で null（:292-298）、`getQuiescenceState` の `hasMore` は true になり、CI の静けさは延期の間に成立しない（保守的）。`onCycleCompleted` の observation は TS が固定の key で組み立てる（:302-315）ので `deferred` の key は CI の held writer に届かず、writer は `hasMore !== false` を `null`（記録しない）にする（`narrativeMaintenanceCiSeam.ts:1450-1458`）。既存の requeue の結果（`lib.rs:6242-6251`、`{"hasMore":true,"requeued":true,...}`）と同じ形の拡張。もう 1 つの呼出し元の評価の harness（`nir1_final_request_eval/harness/workspace.rs:762`）は `hasMore` が false になるまで有限回 loop するだけで、D-final の評価で D′ の窓を開かない | IPC 契約の変更ではない（`runNarrativeFreshnessCycle` は main 専用の N-API method で `ipcContract.ts` に無い。JSON の key を 1 つ足すだけ） | `null` を返す：1 s の idle poll に戻る。延期で `cycleGeneration` を進めない TS の整理：本質ではないので入れない | 同上 | 該当なし | 9.3 | 記録済み |
| DR-CQD-GATE-8 | 2026-11-02 | 同 | **counter**：`GraphOwnerDiagnostics` に `gate_deferred`、`gate_waited_admit`、`gate_overridden`、`gate_lease_expired`、`gate_graph_waited`、`gate_graph_wait_expired`、`gate_windows_opened` を足す（counter だけ。文字列・ID なし）。**eval の計装はこの PR に入れない**（`cfg(feature = "nir1-graph-eval")` の hook を足さない。`scripts/quality/nir1-graph-eval/native-architecture.mjs` が eval module の外の hook と識別子〔`_for_eval`、`eval_*`、`BeginProbe` など〕を許さないため。DR-CP4-LPD-1。gate の観測は診断の枝〔dev 専用〕で後から足す） | counter だけ（post-B §4.4） | — | 同上 | 該当なし | — | 記録済み |
| DR-CQD-GATE-9 | 2026-11-02 | 同 | **試験の形**。gate は時計と待ちを trait で注入できる形にし（偽の時計は待ちの代わりに時刻を進める）、状態機械（取る・待つ・上限・延期・印・天井・RAII の放し・期限）を sleep に頼らず決定的に試す。競合の再現は owner の試験 module（`nir1_graph_deferred_tests.rs`）の fake worker と `admit_hook_for_test` で行う。Native の Freshness の試験は gate が supervised の先頭にあるので、`#[cfg(test)] run_narrative_freshness_cycle_inner`（gate を通らない）ではなく `Backend::run_narrative_freshness_cycle`（`lib.rs:1170` の形）を呼ぶ。TS は `narrativeFreshness.test.ts` に延期の結果 → 10 ms の再予約の試験を足す。変異（判定の反転、放し忘れ、上限の除去など）は 1 つずつ入れて落ちることを確かめ、sha256 と touch で戻す（§6.5 の失敗の再発防止） | 試験だけ。製品の経路に seam を足さない（`cfg(test)` の hook は既存のものを使う） | 実 Electron の再現：この branch では走らせない（診断の枝の dev run で確かめる） | 同上 | 該当なし | — | 記録済み |
| DR-CQD-GATE-10 | 2026-11-02 | 同 | **不活性**。Graph が公開されていない間（`PRODUCT_GRAPH_PUBLISHED=false`、`admit_and_route` が slot より前に `NotActivated` で返す :1118-1119）は held query が生まれず、lease は 0 本。Freshness の追加の仕事は cycle ごとの mutex 1 回と空の判定だけで、戻り値と挙動は今と同じ | 製品の挙動は Graph が閉じている間は不変 | — | 同上 | 該当なし | — | 記録済み |

代替案のうち、brief と調査（S7 §4）で比べた残りの 2 つ：(iii-d) **保存の直後に Freshness を起こす（案 1）**：最小だが保存の時機に頼り、保存以外の引き金（別の window、AI の書込み、連続した編集）には効かない。ユーザーは案 2 を選んだ（「2から行きましょう」）。(ii) **token から feed の位置を外す（案 3）**：child の群にしか効かず、A3 の identity、D-final の ref、`edge_holds` の契約の改訂になる（委任の外）。どちらも採らない。

### 9.3. owner／lifecycle matrix（GDX-PRECHECK-001。egress なし、subprocess なし、background／async lifecycle を変える）

| 事象 | Freshness 側 | Graph 側 | gate の状態 |
|---|---|---|---|
| Freshness の cycle の開始 | supervised の先頭で gate に入る。lease も Graph の待ちも無い（印の間は Graph の待ちを数えない）→ 区間を取る | 待っていれば、区間の終わりまで（予算 100 ms） | 区間 1 つ（scheduler は直列） |
| Freshness の延期 | 250 ms 待っても入れない → 延期の JSON、DB に触れない。印 50 ms | 印の間は新しい窓を開かず待つ | 印が立つ。天井の時計（最初に待たされた時刻）は残る |
| Freshness の天井 | 累計 1 s → lease を無視して区間を取る（`overridden`） | その窓は今と同じく drift しうる | 区間と lease が並ぶ（唯一の例外） |
| Freshness の終了 | 区間の最後の clone の Drop（成功、`Err`、panic、JoinError、async の drop）で閉じ、notify | 待っていた Graph が起きる | 区間 0 |
| Freshness が open_lock を待つ（reconcile、revalidate） | 区間を持ったまま待つ | Graph の待ちは 100 ms で切れ、窓なしで進む | — |
| Graph の窓の開き | `build_worker` の rebuild の窓の後、`admit` の前（held だけ）。区間・印が無ければ lease を取る | — | lease +1（期限 500 ms） |
| Graph の窓の閉じ | — | GATE-6 の (a)〜(k) | lease −1 |
| ticket の取消（renderer、lease の終わり、begin の `Err`、Drop） | — | 待ちの間：刻みで見て lease なしで返る。後：`finish(Cancelled)` で放す | lease −1 |
| lifecycle の edge（workspace の切替、restore、unavailable） | `ws.switching` を刻みで見て延期で返す（TS の quiesce は `inFlightCompletion` を待つだけなので、待ちは最大 1 刻み。flag が立つ前に TS が待ち始める順では最大 250 ms） | edge の observer が epoch を進め、gate の lease を全部無効にして notify。owner thread は既存の `edge_or_closed` で exit | lease 0 |
| shutdown（`ShutdownRequested`、`Shared::close`） | `workspace_shutdown_requested` と owner の closed を刻みで見て延期で返す。dispose は `inFlightCompletion` を待つ | closed、epoch +1、gate の lease を全部無効にして notify | lease 0。以後 lease を取らない |
| crash（process ごと） | gate は memory だけ | 同左 | 何も残らない |
| Graph が不活性 | mutex 1 回で区間を取る | held query が生まれない | lease 0 |

不変条件：(1) 区間は高々 1 つ。(2) 区間と有効な lease が同時に立つのは、Freshness が天井で進んだときだけ（Graph は区間が in-flight の間は lease を取らず、予算を超えたときも lease を取らない）。(3) 待ちの向き：区間を持つ Freshness は何も待たない。待つ Freshness は区間を持たない。待つ Graph は窓の lease を持たない。すべての待ちに上限がある。(4) gate の mutex は leaf（中で他の lock を取らず、notifier も呼ばない）。slot・cache・ticket・`GraphInner` のどの lock の下で `WindowLease` を Drop しても順序は破れない。(5) 決着した ticket は lease を持たない。

### 9.4. threat model（技術的。確認済みの actor・防御・受信先の範囲内）

| 脅威 | 防御 |
|---|---|
| lease の漏れによる Freshness の停止（DoS） | lease の期限 500 ms、天井 1 s、RAII（unwind でも Drop）、edge／close での全無効、決着した ticket は lease を持たない |
| Graph の窓の引き延ばし（renderer の往復、連続の query） | lease は held query 1 回につき 1 本で期限 500 ms。renderer の引数は lease の数・期限を変えない（gate に IPC は無い）。天井 1 s で Freshness は進む |
| deadlock | 9.3 の不変条件 (3)(4)。待ちは全部有界 |
| 鮮度の隠蔽 | 鮮度の判定は触らない。上限を超えた窓は今と同じ drift（閉じる側） |
| privacy・保存・外向きの通信 | 増えない。gate は memory の id・時刻・数だけ |

