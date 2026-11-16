# s7r1 の連鎖：奪い手の計装の基準測定（dev・凍結外 fixture。2026-11-09 12:25〜12:45 JST）

- 候補：計装入りの dev 枝 `claude/dev-s7r1-chain-instr`（origin/master `a52a9344` の上。製品の挙動は変えない。push しない）。fixture は凍結外の `DEV-SHAPE-G03/frontier-exceeded`。cold DB は前回の dev の a1（running の行なし）・a2（running の行あり）の setup を同じ相対 path に写して使用（sha256 は受領書と一致）。**dev の結果は判定に数えない。**
- 実行：Gold を 5 回（a2×3、a1×2）。trace は `/tmp/claude-1000/s7r1-chain/trace-s7r1-chain-<label>/`、集計は scratchpad の `analyze-chain.mjs`・`series-chain.mjs`。

## 1. 結果（事実）

| run | cold DB | Gold の結果 | registration | 維持の preempt | sample（Graph arm 35） |
|---|---|---|---|---|---|
| base-a2-1 | running あり | **V-10 で停止**（約 1.7 分） | 5 回すべて refused（postflight-drift） | 440 回／92 s（約 4.8/s） | なし |
| base-a2-2 | running あり | **V-10 で停止** | 5 回すべて refused | 492 回／93 s | なし |
| base-a2-3 | running あり | measured（V-10 は通過。run 570 s） | 10 回中 postflight-ok 1、refused 9 | 2704 回／612 s（約 4.4/s） | **registration-unavailable 30、startSlot suspended 23**（正式 s7r1 の gold-2 と同じ型） |
| base-a1-1 | running なし | measured（run 122 s） | 36／36 成功 | 7 回 | **`limit` 35／35**、slot empty |
| base-a1-2 | running なし | measured（run 122 s） | 36／36 成功 | 4 回 | **`limit` 35／35**、slot empty |

- **a2 型で正式の連鎖が再現**（V-10 が 3 回中 2 回、通った 1 回も Suspended の連鎖）。a1 型は連鎖が起きない。dev の a1 では期待の理由 `limit` が出る（正式の Gold では未観測）。
- **奪い手（誰が維持を preempt したか。a2-1、`preemptBy`）**：`related-scenes-build` 306（70%）、`related-scenes-reconcile` 101（23%）、その他（`execute.rs:1286` 15、`ai_audit.rs:2434` 6 など）は計 8%。a2-2・a2-3 も同じ傾向（維持の preempt は 4〜5 回/秒）。
- **Related Scenes の foreground 取得は一定**：build 約 4.0 回/秒（`related-scenes-build`）と reconcile 約 4 回/秒（a1・a2 とも。a2-1 の 10 秒刻みの推移で build は 3.8〜4.0 回/秒で一定。reconcile は接続待ちで 0〜1.4 回/秒に落ちる区間がある）。**維持が静かな a1 では preempt が 0（対象が居ない）、Verify が走る a2 では 4〜8 回/秒の foreground が毎回 Verify を取り消す。**
- **維持の commit**：a2 では 5〜13 回/秒（cycle あたり 2 commit が約 9 割。維持自身の取消し・再作成の簿記）。a1 は 1 回/秒前後。
- **registration の refused は 5＋5＋9 回すべて `postflight-drift`**（incomplete・input-limit 等は 0）。窓（BEGIN〜postflight）は SemanticIndex 約 34 ms＋SourceIndex 約 11 ms＝約 46 ms。→ 「drift が原因」は推測でなく実測になった。
- 維持の commit が約 100 ms ごとに入るので、約 46 ms の窓は commit と重なりやすい（a2 の registration 成功は 15 回中 1 回）。

## 2. コードの読み（事実）

- Related Scenes の build は `build::schedule_with` の task が**ループ**で、`Ready`・`Idle`・`Retry` のどの outcome でも `RETRY_DELAY`（250 ms）待って**また `build_once` を呼ぶ**（`Stopped` か reader-retry の上限でだけ止まる。`build.rs` の loop）。task は workspace が失効するまで生き、毎回 `spawn_blocking` で foreground の接続を取る（label `related-scenes-build`）。
- reconciler は live な ticket がある間 250 ms ごとに `reconcile` を呼び、ticket ごとに `current_operation`（foreground の読み）を行う（`relatedScenesReconciler.ts`、`related_scenes.rs:379-399`）。
- 維持は foreground の waiter が居ると、participant check と SQL progress hook で自分を取り消す（`preemptKind`：participant-check 287、sql-progress-hook 140、no-wait 計 13）。

## 3. 読み（推測。確度つき）

1. **Verify が完了しない主因は、Related Scenes の 2 種の周期処理（build の polling 約 4/s と reconcile 約 4/s）が毎回 foreground として維持を取り消すこと**（確度：高。a1 では同じ頻度の取得があっても preempt が 0＝対象が居ないだけ。a2 は取り消しの 92% が Related Scenes）。
2. **(c)（維持側の連続 preempt の backoff）は単独では効かない見込み**（確度：中〜高）。奪い手が 4＋4 回/秒で来続ける限り、維持が次にいつ動いても約 60〜125 ms 以内に取り消される。backoff は維持の commit を減らして drift を減らす副次効果はあるが、Verify の完了には届かない。
3. **(f) は reconcile だけでなく build の polling にも要る**（確度：中〜高）。設計（§2.3）は reconcile だけだったが、実測の主因は build の polling（70%）。
4. **自己維持の循環**：Related Scenes の polling → Verify の取消し（commit）→ drift → registration refused → Graph が Suspended。Verify が終われば commit が止まって通る（a1 の型）。

## 4. 未確認

- Verify の進捗が slice ごとに durable か（取消しの間に進むか）。a2-3 の 570 s でも完了しなかったので、少なくとも「4〜8 回/秒の取消しの下では完了しない」。
- `build_once` が毎回 foreground の接続を取る理由と、それを譲る形にして Related Scenes の鮮度に副作用がないか。
- 製品の通常の操作（Related Scenes を開いている間）でも同じ頻度の polling か（harness では live ticket が残る）。
- `repository.rs:104`（Run の admission の namespace 取得）の waiter 469 回は、待ちが計 49 ms で preempt の原因ではない（preemptBy に出ない）。維持自身の呼び出しかは未確認。

## 5. 次（設計の見直し）

- 候補を「(f2) Related Scenes の polling（build の再試行と reconcile の current_operation）を、接続が使用中なら取り消しを起こさず次の tick に回す形にする」に改める。(c) は単独では採らない。(g) は不要になる見込み。
- dev で A/B：基準（上の 5 回）／(f2)。a2 型 ×3、a1 型 ×1。指標：V-10 の率、Verify の完了時刻、Graph arm の sample の registration-unavailable／suspended、維持の preempt 数と奪い手。

## 6. (f2) の A/B（2026-11-09 13:00〜13:16 JST。worktree `claude-s7r1-chain-f2`、枝 `claude/dev-s7r1-chain-f2` `14474779`、patch `f2.patch`、notes `notes-f2.md`）

(f2)：Related Scenes の周期処理（build の再試行 task と reconcile の `current_operation`）が、接続が使用中なら waiter を立てずに（維持を取り消させずに）その tick を飛ばして次の tick に回す。ユーザー操作の経路（begin・return・click・`continue_query`・`qualify_evidence`）は従来どおり foreground の優先。同じ a1・a2 の cold DB（基準と同じ写し）で Gold を a2×3・a1×1。

| 項目 | 基準 a2（3 回） | (f2) a2（3 回） | (f2) a1（1 回） |
|---|---|---|---|
| V-10 | 2／3 で停止 | **0／3** | 0／1 |
| Graph arm 35 sample | a2-3：registration-unavailable 30・suspended 23 | **`limit` 35／35・slot empty（3 回とも）** | `limit` 35／35 |
| registration | 成功 1／15（refused 14 は全部 postflight-drift） | 成功 36／37（refused 1 も postflight-drift）×3 回 | 36／36 |
| 維持の preempt | 440〜2704 回（約 4.4〜5.3/秒を持続） | **22〜31 回**（開始から約 15 秒の間だけ。以後 0/秒） | 6 回 |
| 残る奪い手 | related-scenes-build 70%・reconcile 23% | reconcile のみ（probe の race の分。build は 0） | 微小 |
| Verify（watcher の `verify`） | completed 9 のまま、cancelled 322→2840、running が残る | **約 3〜4 秒で completed 9→10**（cancelled 322→330）。以後は静止 | 変化なし |
| 維持の commit | 5〜13/秒（持続） | 開始直後 2.3/秒、以後 約 1/秒 | 約 1/秒 |
| 飛ばした tick（`periodicSkips`） | — | 22〜26（128 s の間、すべて Verify の間） | 8 |

- **事実**：(f2) で a2 型の連鎖（V-10・Suspended）が消え、a1 型と同じ結果になった（3／3）。Verify は数秒で完了し、drift の原因（維持の commit の連打）が止まる。
- **効きの機序（読み）**：奪い手の周期処理が維持を取り消さなくなる→Verify が数秒で終わる→commit が止まる→registration が通る。(c)（維持側の backoff）は不要だった（確度：高。(f2) だけで 0／3）。(g) も不要。
- **未確認・限界**：n＝3＋1 で 1 つの cold DB だけ。probe は race があり preempt は 0 にならない（実測 22〜31 回）。維持が長く動き続ける場合の Related Scenes の鮮度の遅れの上限は未測定（`periodicSkips` は 22〜26 で小さい）。skip 経路の unit test は未作成。製品版の設計（skip の上限の有無、probe の API 名、reconcile 以外の周期処理）は未決。dev の fixture（凍結外）で、正式の Gold・凍結 fixture では未測定。
