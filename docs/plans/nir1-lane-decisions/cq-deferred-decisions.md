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

### 7.3. 試験と変異

足した試験（owner の試験 module）：`p4_a_demand_made_to_wait_by_a_held_session_is_announced_once_at_its_end`、`p4_the_held_querys_own_stale_answer_is_not_announced`、`n2_a_release_later_than_the_await_limit_is_still_served`、`n3_a_cancellation_during_the_rebuild_window_creates_no_worker`、`i_a_without_s0_a_commit_before_the_query_is_caught_by_the_worker_drift`（S0 欠落 → `stamp_unavailable` → query の前の commit → worker の drift で stale、`drift_at_query=1`）、`a_panic_of_the_held_query_settles_it_once_as_failed`（in-flight で 1 回、`deferred_dropped=0`）、`an_owner_thread_that_ends_while_holding_settles_the_hold_once`（takeover で退役する READY が quarantine → guard が `restart-required` で 1 回、`deferred_dropped=1`）、`a_release_in_another_lifecycle_epoch_is_refused_by_the_release_itself`。N1 と (i-a) の対照 1 に「`finish(Unused)` の後に cache が空、通知なし」を足した。RS の試験の等値の試験は `the_owner_hold_limit_outlasts_a_begin_longer_than_the_await` に替えた。

| 変異（1 つずつ入れて対象の試験を走らせ、sha256 と touch で復元を確かめた） | 結果 |
|---|---|
| MA1 session の終わりの通知を消す | `p4_a_demand_…` が落ちた |
| MA2 終わりに unserved の全部を通知する（自分の stale を含む） | `p4_the_held_querys_own_stale_…` が落ちた |
| MB 期限を 2 s に戻す | `n2_…` と `the_owner_hold_limit_…` が落ちた |
| MC 窓の待ちの cancel の検査を消す | `n3_a_cancellation_during_…`（取消から slot が空くまで 300 ms 未満）が落ちた |
| ME `release_deferred` の epoch の検査を消す | `a_release_in_another_lifecycle_epoch_…` が落ちた |
| MF create の直前の cancel の検査だけを消す | **生き残った**（窓の検査が先に止めるため）。create の直前の検査は、窓の後の admit の間の取消に対する多重の防御で、単独で落とす試験は無い |

### 7.4. 確認だけの項目

- lifecycle P3-1（IR scoring の接続）：begin.rs:190 の `spawn_blocking` で走る `scoring::run` は `db.with_participant_read_transaction`（`narrative_maintenance_connection.rs:1226` → `with_participant_sql_scope_config_with_stop` → `Database::lock_conn_with_check`）を使い、**主接続の mutex と同じ**である（owner の S0／stamp の `try_read_c_query_freshness_stamp` は同じ `db.conn` を `try_lock` する）。IR scoring は Raw-ready と並行に走り、begin の outcome を待たないので、release の後もその読取（資格の確認、title と language の読取、再検証）が続きうる。その間に owner の admit が来ると、try-lock が失敗して `stamp0_missing` になり、その query は stamp の比較をせず（`stamp_unavailable`）worker の registration と query の drift の検査だけが鮮度を守る（偽の fresh にはならない。新しい試験 `i_a_without_s0_…` がこの経路を示す）。影響は owner の側の早い stale の検出が無くなることだけ。頻度は未測定（(ii) で `stamp0Missing` を記録する）。
- lifecycle P3-3（admit の失敗の理由が粗い）：既知。admit が `None` を返すとき（edge、AppState の消失、restricted profile でない、binding の不一致）は、保留の ticket にすべて `invalidated` を返す。今回は直さない。

### 7.5. 検証（最終の内容 `443e782c` に対して）

| コマンド | 結果 |
|---|---|
| `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib -- nir1_graph related_scenes` | 192 passed、0 failed、5 ignored。負荷の下で 2 回続けて green |
| 同 `i_b_the_real_worker -- --ignored`（実 worker） | passed（release 26.6 ms、結果 45.2 ms、`prepareFailures=0`、`driftAtQuery=0`、対照は stale） |
| `cargo clippy … --lib --tests` | 各 commit で警告なし |
| `rustfmt --check`（変更した file） | 新しい差分なし |

未実施：(ii)（実 Electron）、cold start の実測、D-final の待ちの延びの実測、Quick／Full。
