# S3 の 10 回目の 4 回目の確認（`67cf9453..068cf3a6`。2026-11-16）

**この file の出所**：S3 の独立 reviewer（Claude の agent、Opus 5.5、read-only）の報告である。ユーザーの確認ではない。

## 行ったこと

- repo と fusion-eval-data の file は変えていない。commit、build、run の起動もしていない。
- 一時 file は scratchpad（`/tmp/claude-1000/.../scratchpad/r4/`）にだけ作った。中身は旧新の S2・宣言の JSON の写しと、差分を取る小さな script である。
- 読んだもの：
  - git の object と作業木
  - contracts の bytes（`337ff239` の SHA-256 を計算し直した）
  - dev の受領書・dev-log・patch
  - cold DB（`sqlite3` の `?immutable=1` で読んだ。file には書かない）
- validator は読むだけで実行した（Node 22。前例どおり）。
- 試験の file は回していない。

## 対象

- 枝 `claude/s4-9-pr3`。worktree は `/home/grimodex/worktrees/Grimodex/s4-9-pr3`。
- HEAD は `068cf3a6` で、`origin/claude/s4-9-pr3` と一致する。作業木は clean。
- 範囲の 3 commit：`904d8d2b`（試験）、`2d70fa10`（S2 追補 #21）、`068cf3a6`（DR）。
- 変わった file は 8 つ。pin 対象の harness（`frozen-setup-driver.mjs`、`workspace-db.mjs`、`setup-receipt.mjs`）と判定 3 file は、この範囲では変わっていない（`git diff --stat` は空）。
- 判定 3 file を最後に変えた commit は今も `1dd6fb35f9b1…` である。`K67_QUALITY_VERDICT_V3.implementationCommit`（`observation-prep.mjs:333`）と一致する。

## 盲検

- 今回の依頼文には、builder の結論は入っていなかった。入っていたのは、対象の範囲、file の一覧、前回までの指摘の場所、正本の場所である。DR が約束した「次は結論を渡さない」は、依頼文については守られている。
- ただし確認する対象そのもの（S2、宣言、DR）に builder の結論が書かれている。読んだ順は、コードと実物 → 記述である。

## 判定：**ok-with-notes**（必須 0、推奨 7）

- 3 回目の必須 1 と推奨 1〜5 は、すべて閉じた。
- `setupReadings`、validator、L-24・T-5 の追記、限界 (n)、`reopen.quiesce` は、`frozen-setup-driver.mjs` の実物と合う。
- 残るのは、古い 1 文、束縛の弱さ、記録の細かい不正確さ、開示の一覧の欠け 1 つで、どれも止まる側か開示の質の問題である。
- 黙った緩和は見つからなかった。

---

## 問 1：3 回目の指摘は閉じたか

| 指摘 | 結果 | 根拠 |
|---|---|---|
| 必須 1 `setupReadings`・validator・L-24・T-5 が `39b89bc3` の前のまま | **閉じた** | 下の「必須 1 の照合」 |
| （必須 1 の周辺）`maintenanceStillAt` に quiesce の地点が無い | **新しい問題（小）**。推奨 2 | 問 2 の 2 |
| 推奨 1 開き直しの経路を実機で | **閉じた**（範囲の限界は開示済み） | dev 専用の枝で 2 回通した。受領書と cold DB の実物で数字を確かめた（問 4）。凍結の G-03/frontier-exceeded と、使い切って止まる経路は未通過で、(n) と DR-DBC-7 に書いてある |
| 推奨 2 前回の推奨 6 が実物に無い | **閉じた** | 限界 (h)（`observation-prep.v1.json:468`）に `revision-of-path-unresolved` の hold の文が入った。コードで確かめた：`material-revision.mjs` の `resolveEdge` は hash 2 本の一致を求める。一致しなければ `pairs` が null になり、`quality-evidence-items.mjs:215-217` で hold、`quality-verdict.mjs:246`・`:461-462` で fail。前回の記述は、cp4 の追記 3 の表（`cp4-decisions.md:1671`）と DR-DBC-7（`db-connection-decisions.md:1046`）で「当時の記述として残し、この行が置き換える」と扱った。宣言 `[39]` には括弧書きで訂正を入れた |
| 推奨 3 Index metadata の停止の試験 | **閉じた**（試験は回していない） | `frozen-setup-complete.test.mjs:1386-1417`、fake は `test-support.mjs:1770-1773`。動いたときは `[precheck] S1i maintenance-quiesce` で止まり、`coldDatabase`・`readBack` が無いことを確かめる。動かないときは封印される。quiesce の session は静止していた（running 0）ので、止めたのは metadata だけ、という分離も assert している |
| 推奨 4 dev の記録の誤り | **閉じた** | `setup-quiesce-dev.md` の「測定側」の行が「`maintenanceQuiet` の検査（`fixtureKind === "frozen"` のときだけ）は通っていない。入口の検査は合成の試験でだけ確かめた」に直った |
| 推奨 5 fail→hold の数え方 | **閉じた** | `observation-prep.mjs:2241-2242`、S2 (h)、宣言 `[37]` と `readingsChosenAfterDevObservation[21]`、DR-DBC-7 `:1047`、cp4 追記 3 の表が、どれも「2 点：`db7c1234` の読めない行の hold と `edge-revision-unresolved`。後者は凍結の fixture では到達しない」で揃った。旧い「2 点」の記述は、追記 3 が置き換えると明示している |

### 必須 1 の照合（S2 ↔ validator ↔ 実物）

| 束縛 | S2 | validator | 実物（`frozen-setup-driver.mjs` ほか） |
|---|---|---|---|
| quiesce の枠 | `reopen.quiesce`（`:2302-2316`）：2 回、60 s、`quiesce-<n>`、nonce なし、blocked にしない、尽きたら・metadata が動いたら `[precheck] S1i maintenance-quiesce` | `REOPEN_QUIESCE`（`:1458-1468`）と、それとの完全一致（`:4080-4086`） | `:179-180`、`:2697-2734`。directory は `quiesce-${reopen + 1}`。session は nonce を持たない |
| 開きの合計 | `totalReopenableOpenings` 9 と `totalOpeningsWithQuiesce` 11（`:2299`）。`otherFailures` に別枠の注記（`:2269`） | `REOPEN_TOTAL_WITH_QUIESCE`（`:1469`） | 9＋2 |
| 静止の定義 | `maintenanceStillWhen` に `no-planned-retry`。`plannedRetryWhen`、`plannedRetryGraceMs` 5000（`:2534-2540`） | `:1535-1544` | `maintenanceQuiet`（`workspace-db.mjs:298-307`）と `RETRY_DISPATCH_GRACE_MS = 5_000`（`:213`） |
| cold の running／retry の予定 | `coldDbRunningRuns`・`coldDbRetryPending` が `[precheck] S1i maintenance-quiesce`（`:2553-2554`）。`closedWorkspaceNotQuiet`（`:2549`） | `:1550-1556` | `:2833-2845` |
| 受領書の欄 | `readBack.maintenance` に `retryPending` を足し、acceptance は止める側（`:2417-2420`）。`quiesce` の欄（`:2421-`） | `MAINTENANCE_RECEIPT_FIELDS`（`:1496-1512`）と acceptance の語（`:3845-3852`） | dev の受領書の `quiesce.reopens[]`（`attempt`・`dirLabel`・`before`・`beforeEndedByClose`・`settle`）と `final`（`activity`・`endedByClose`）が、欄の名前と一致した |
| 読み SR-11（開き直し）・SR-14 | `items[10]`（id SR-11）・`items[13]`（id SR-14）が「session の中の待ち切れは開示、最後の session の後と cold は止める」に直った | 語の検査は無い（推奨 4） | 合う |
| L-24・T-5 | 日付つきの追記で「別枠」「止める」を足した。元の文は残した（`cp4-decisions.md:773`・`:1067`） | — | 合う |

- 試験（`observation-prep.test.mjs` の差分）は、上の各値を古い値・別の値に戻す変異を、それぞれ検出することを確かめる形になっている。
  - 例：`coldDbRunningRuns = "disclosed"`、`quiesce.reopens = 3`、`totalOpeningsWithQuiesce = 9`、`readBack.maintenance` の acceptance を旧文に戻す。
- validator（読むだけ、Node 22）：`status: passed`、errors 0、`formalReady` false、placeholder 23。前回と同じ。

## 問 2：食い違う記述・事実と合わない記述

**validator が束縛する読みと実物の食い違いは、見つからなかった。** 残るのは次の細かい点である。

1. **(n) に古い 1 文が残っている**（推奨 1）
   - `observation-prep.v1.json:468` の (n) は、retry の予定の定義について「起動時の復旧が作る行の実物は見ていない〔推測〕」と書いたままである。
   - 同じ (n) の後ろの文は、`qzo1` で実物を見たと書いている（「retryable の Attempt の next_attempt_at は失敗の 1 s 後」）。
   - 実物は確かめた。cold DB の Attempt は `failed／NEX_MAINTENANCE_INTERRUPTED／retryable`、`completed_at 11:28:33.981Z`、`next_attempt_at 11:28:34.981Z` である。同じ `work_key` の run `59fc035b…` は `completed` で、作成は `11:28:34.996Z`。
   - dev の記録は「（下の qzo1 で実物を 1 件見た）」に直っている。S2 の側だけが古い。
2. **`maintenanceStillAt` に quiesce の地点が無い**（推奨 2）
   - S2 `:2533` と validator `:1532-1535` は `["before:measurement-point", "session-end"]` のままである。
   - しかし quiesce の session も maintenance の静止を待つ（`requireQuiet: true`。`frozen-setup-driver.mjs:1661-1675`）。同じ `freshnessSettle.setup.rule`（`:2555`）は、待ちの point に `quiesce` を挙げている。
   - 枠は `reopen.quiesce` が別に束縛しているので、挙動の読み違いにはならない。ただ、一覧が閉じた形で書かれているので、足すか「別枠は reopen.quiesce」と注記するのがよい。
   - 3 回目の確認は、閉じた集合の欠け（`receiptFields` に `quiesce` が無い）を必須に入れた。今回これを推奨にとどめる理由：
     - 当時は、`setupReadings` のどこにも新しい挙動が無く、S2 が古い挙動だけを言っていた。
     - 今回は、quiesce の待ち（60 s、静止の要求）を `reopen.quiesce` と `rule` が持ち、validator が `REOPEN_QUIESCE` で束縛している。欠けているのは一覧 1 つへの名前の追加だけである。
3. **段取りの記述が追補 #20 で止まっている**（推奨 6）
   - `k67Readings.status`（`:466`）は「S2 追補 #20 … 反映の後の確認は S3 がもう 1 回行う」で終わる。
   - `s4StagesRule`（`:1087`）は「S2 追補 #20 の後に S3 の確認をもう 1 回置く」と書く。
   - どちらにも #21 とこの 4 回目の確認が無い。限界 (l) の「S4b の前に残る取り直し」の S3 の記録で閉じる予定と読めるので、今は止めない。
4. **「dev の受領書は通らない」の書き方があいまい**（推奨 7）
   - T-5 の追記（`cp4-decisions.md:1067`、「弾く（dev の受領書は通らない）」）と DR-DBC-7 `:1052` は、「dev の受領書は弾かれる」とも読める。
   - 事実は「dev の受領書はこの検査の対象外」である（`setup-receipt.mjs:280`）。
   - S2 の `receiptFields["readBack.maintenance"].acceptance`、(n) の (3)、宣言 `[37]` の (14) は「測定の入口も弾く」と書き、frozen だけとは書いていない。正式 run は frozen なので、正式 run については事実と合う。
5. **宣言の過去の行の書き換え**（note）
   - `2d70fa10` は、宣言 `revisions[39]`（S2 追補 #20 の行）の本文を書き換えた（括弧書きの訂正）。
   - 一方、試験の注釈は「Earlier rows stay as written (the new rows add, never edit)」（`observation-prep.test.mjs:9029`）と書く。cp4 の追記 3 は、DR の側では旧い行を「当時の記述として残す」方針を採った。
   - `[37]` は S4a の生きた開示の行で、前例でも直している。`[39]` の訂正は誤りを正す向きで、害は無い。ただ方針が 2 通りになっている。
   - `[39]` は 1 か所だけを直した。同じ行の「dev で 1 回確かめた（開き直しの経路は実機では通っていない。…）」は当時のままである。新しい行 `[40]` と `[37]`(14) が「2 回通した」と書くので、事実の取り違えにはならない。ただ「直す」方針なら、ここも同じ扱いになる。
   - DR の側では、DR-DBC-7 `:1038` の「開き直しの経路は実機では通っていない」を、`:1052` が「この確認の前の記述」と明示している。L-27 の行（`cp4-decisions.md:776`）の追記に、古い語は無い。
6. **(n) の中の小見出し**（note）
   - (n) の中に「(a) 1 回目」「(b) 開き直しの経路は…」がある。前からある (a)〜(c)、(1)〜(3) と同じく、限界の項の (a)・(b) と名前がぶつかる。
   - 語の束縛は `includes` なので壊れないが、「限界 (a)」を引くときに紛らわしい。

**setup の読み（開き直し・静止・running の行・retry の予定）について**：上の 1・2 を除けば、S2・宣言・validator・DR・実物の 5 つは合う。

- 開き直し：別枠、2 回、60 s、合計 11。
- 静止：running 0、retry の予定 0、2 回の読みの一致。closed DB の判定では 2 回の読みは要らず、stop が `app.close()` であることを求める。
- running の行：session の中は開示、最後の session の後と cold は止める。
- retry の予定：`next_attempt_at > now − 5 s` で、同じ `work_key` の後の run が無いもの。

## 問 3：新しい名前と緩和の向き

- この範囲で増えた名前：
  - validator：`REOPEN_QUIESCE`、`REOPEN_TOTAL_WITH_QUIESCE`、`MAINTENANCE_RECEIPT_FIELDS`
  - S2：`totalOpeningsWithQuiesce`、`plannedRetryWhen`、`plannedRetryGraceMs`、`closedWorkspaceNotQuiet`、`coldDbRetryPending`
  - fake：`movesIndexOnReopen`
- **新しい hold の code は無い**（`edge-revision-unresolved` は前の範囲）。
- **向きはどれも止まる側か、記述の整合**である。setup の静止は v3・K6/7 の字義の対象ではない。正本は DR-CP4-L-27 とユーザーの回答 `337ff239`（SHA-256 `ad89ebfb…` を計算し直して一致）。回答の範囲（「記録だけ」→「止める」）に収まる。**黙った緩和は無い。**
- 緩む側に読める要素は 1 つだけある。retry の予定の猶予 5 s で、`next_attempt_at` が 5 s より前で dispatch されていない retry は、予定と数えない。
  - これは `39b89bc3` からの既存の挙動で、前回の確認で「偽陰性の向き、小さい」と読んだ。
  - 今回 S2 に数値（5000）で開示された。前より開示は良くなっている。
- **束縛の弱さ**（推奨 3）
  - `plannedRetryGraceMs: 5000` は、harness の定数名 `RETRY_DISPATCH_GRACE_MS`（`workspace-db.mjs:213`）を名指ししていない。値を固定する試験も無い。試験は `RETRY_DISPATCH_GRACE_MS ± 1000` の相対値で使うだけである（`frozen-setup-complete.test.mjs:1504-1506`）。
  - `MAINTENANCE_QUIESCE_*` は試験が 2 と 60000 を固定している（`:1330-1331`）。しかし validator は literal で持ち、pin の bytes と照らさない。
  - literal にした理由は「pin の bytes に無い」（S2 `:2315`、`observation-prep.mjs:1452-1456`）である。これは今の pin（`t3-t5-setup-freshness-settle` が `b0df31f0` を指す）については正しい。S4b の前に pin を取り直すと、新しい bytes にはこの定数があるので、理由は成り立たなくなる。
  - pin を取り直すと bytes は固定されるので、実害は無い。ただ、S2 の値と pin の bytes の値を validator が照らす形（`HARNESS_CONSTANTS` に足す）が、前例の `FRESHNESS_SETTLE_WAIT_MS` と揃う。
- **開示の一覧の欠け**（推奨 5）
  - setup の静止の読み（2 回、60 s、猶予 5 s、cold で止める）は、dev gate の `hd-g03h2` の drift を見た後に置かれた（(n) の本文。ほかの観測をどこまで見たかは〔推測〕で、確かめていない）。
  - 宣言の `readingsChosenAfterDevObservation` の 23 行（0〜22）を全部読んだ。`quiesce`・`337ff239`・`maintenance-quiesce` を含む行は無い。`L-27` を含むのは `index-build-constants`（P-6 の別件）だけである。
  - 前例の `freshness-settle`（9 番）は T-1・T-3・T-5 の待ちの行で、「maintenance の待ち切れは開示」と書いたまま L-27 の「止める」に触れていない（session の中の待ちについては今も正しい）。
  - validator の `READINGS_AFTER_DEV` にも、静止の行は無い。
  - (n) の本文は経緯（「drift_at_query の調査の 1b」）を書いているので、開示が無いわけではない。止まる側の選択なので、偏りの向きは「止まりすぎ」で、緩和ではない。
  - 定数は `39b89bc3` で置き、その後の dev の 3 回（`qz1`・`qzo1`・`qzo2`）を見て変えていない（`git diff --stat 39b89bc3..068cf3a6` は harness の 3 file について空）。

## 問 4：開き直しの実機の記録は、主張している範囲と合うか

**数字と主張の範囲は、実物と合う。** 記録の書き方に、細かい不正確さが 2 つある（推奨 4）。

### 確かめたこと（`setup-quiesce-dev-run/reopen/` の実物）

| 主張 | 実物 |
|---|---|
| `qzo1`：running の dependency-verify 1 行、214 ms で出現 | dev-log：`waitedMs: 214`、`running: 1`、`lastCreatedAt 11:28:29.806Z` |
| 開き直し 1 回、`quiesce-1` は `app.close()`、closeMs 514 | 受領書：`quiesce.reopens.length` 1、session `quiesce-1` の stop は `closed: true, closeMs: 514, signalled: []` |
| 待ち 1,883 ms・8 poll、run 27→28、running 1→0 | `settle.waitedMs 1882.9`、`polls 8`、`maintenance.initial.runs 27`→`final.runs 28`、running 0、`quiet: true` |
| INTERRUPTED と retry と完走、cold の running 0・retryPending 0 | cold DB：`c4c7c12b` failed／INTERRUPTED、Attempt の `next_attempt_at` は失敗の 1.000 s 後、`59fc035b` completed（同じ `work_key`）。`readBack.maintenance` は running 0・retryPending 0 |
| `qzo2`：running は出ず（30 s）、signal だけで開き直し、待ち 0.3 s | dev-log：`waitedMs 30003`、`runningSeen: null`。`settle.waitedMs 271`、polls 2 |
| Index metadata は前後で同じ | dev-log の `indexBefore`／`indexAfter`。b・chronicle とも generation 1、dirty なし、digest 同じ |
| どちらも `setup-complete`、precheck なし | 受領書：`status: setup-complete`、`precheck: null`、errors 空 |
| S4 の枝に dev の仕組みを入れていない、push しない | `git diff 67cf9453..068cf3a6` に hook は無い。`git branch -r --contains 11c12fb9` は空。`ls-remote` にも無い |

- 主張の範囲（dev-shape の preview だけ、凍結の G-03/frontier-exceeded では走らせていない、使い切って止まる経路と will-quit の障壁は未確認）は、S2 (n)、宣言 `[37]`(14)・`[40]`、DR-DBC-7 `:1048-1052`、dev の記録の 5 か所で一致している。
- 主張を広げている所は無い。
- ユーザーの回答の「dev での効果の確認 1 回」は範囲に「含む」と書いていて、上限ではない。追加の 2 回は dev 専用・非判定・可逆で、範囲を越えていない。

### 不正確な点（推奨 4）

1. **run の時点の head**
   - `run-1.out`・`run-2.out` は `head=67cf9453` と出している。run は 11:28:02Z と 11:29:07Z に始まった。
   - `11c12fb9` の commit 時刻は 11:31:29Z（`2026-11-16T20:31:29+09:00`）で、run の後である。つまり run は、`67cf9453` の上の未 commit の作業木で走った。
   - `git diff 67cf9453 11c12fb9` は `dev-hook.patch` と bytes が一致した（`cmp`）。ただし run の時点の作業木が同じだったことは、記録からは証明できない。
   - 記録の「候補：… commit `11c12fb9`」は、「`67cf9453` の作業木に hook を当てて走らせ、後に `11c12fb9` として commit した（patch は同じ bytes）」と書くのが正確である。
2. **受領書の signal の表示**
   - 記録は「SIGKILL（6 pid）」と書く。受領書と dev-log の `signalled[].signal` は、6 つとも `"SIGTERM"` である。
   - 理由：`stopElectron` は残った pid にまず `"SIGTERM"` の名で `kill(pid, signal)` を呼び、それを記録する（`launcher.mjs` の `stopElectron`）。dev の `kill` は引数の signal を捨て、常に SIGKILL を送る（`dev-hook.patch`）。
   - kill した session の stop が `closed: true, closeMs: 0` になる理由は、コードの読みからの推定である〔推測〕。
     - `app.close()` は呼ばれていて（待ちは 1 ms）、`closed` は race の後も書き換わる変数である。process が死んだ後に close の promise が解決して、true になったと読める。
     - `closeMs` は 1 ms の待ちが切れた時点で測っている。
     - `app.close()` がすぐ解決した可能性は消えていない。その場合でも、SIGKILL は残った pid に送られている（`signalled` が 6 つ、`remaining` が空）。
   - harness の `endedByClose` は `signalled` が空でないので false と読み、開き直しに入った。挙動は正しい。
   - 受領書だけを読むと、記録と矛盾して見える。1 行の説明を足すとよい。「app.close() でなく SIGKILL」も、厳密には「`app.close()` を呼んで 1 ms 後に SIGKILL」である。

## 問 5：S4b の前の段取りに進んでよいか

**進んでよい。** 必須は 0 である。推奨のどれも、判定 3 file と harness の bytes を変えない。

**ただし、凍結される file の中の推奨は、S4b の前にしか直せない。**

- 該当するもの：推奨 1・2・5・6 と、推奨 3・7 のうち S2・宣言・validator の部分。
- S4b で凍結した後は、凍結をやり直さないと直せない。
- だから、これらは S4b の前の S2 追補で入れる。入れないものがあれば、入れないことを限界か宣言に開示してから凍結する。
- 凍結の外のもの（推奨 4 の dev の記録、推奨 7 の DR の書き方）は、いつでも直せる。

S4b の前に統合者に渡すこと：

1. **正式の setup が止まりうる危険**（止まる側。進行は止めない）
   - 実機で未通過の形が 2 つ残る。
     - 凍結の G-03/frontier-exceeded で、`app.close()` で閉じた後に running が残る形（s7r1 の実績。前回の確認の問 3）。
     - 開き直しの session の中で Verify が完走せず、2 回を使い切って `[precheck] S1i maintenance-quiesce` で止まる経路。
   - `qzo1` は SIGKILL で残した running で、復旧から完走まで 1.9 s だった。T-5 が記録した「frontier-exceeded では Verify が取消しを繰り返す」形が、quiesce の session の中で起きるかは未確認である。
   - 起きれば正式の setup は fail closed で止まる。誤った結果は出ないが、凍結と run の時間を失う。
2. **master の取り込み（②）の後**
   - 開き直しは、製品の起動時の復旧（`maintenance_runtime.rs` の Interrupted の閉じ方と backoff）に依存している。
   - 取り込みでこの経路の製品コードが変わるなら、④ の開示に足し、開き直しの経路を dev でもう 1 回通すのがよい。限界 (13) の「S3 も見ていない」の範囲に入る。
3. **pin の取り直しのとき**
   - 推奨 3（quiesce の定数と猶予の定数を pin の bytes から読む形）を一緒に入れると、S2 の literal と harness の値の照合が閉じる。
4. **S3 の記録**
   - この file を S3 の記録として限界 (l)・`s4StagesRule` に入れるときに、推奨 6（status と `s4StagesRule` の #21 と 4 回目）を一緒に閉じる。

---

## 必須

なし。

## 推奨

1. **(n) の古い 1 文を直す**
   - 対象：「起動時の復旧が作る行の実物は見ていない〔推測〕」（`observation-prep.v1.json:468`）。
   - 直し方：「`qzo1` で 1 件見た（推測でなくなった）」にする。
2. **`maintenanceStillAt` に `quiesce` を足す**
   - 対象：S2 `:2533`、validator `:1532-1535`。
   - 代わりに「quiesce の地点は `reopen.quiesce` の別枠」と注記してもよい。
3. **新しい定数の束縛**
   - `plannedRetryGraceMs` に `RETRY_DISPATCH_GRACE_MS` の名を添え、試験で 5000 を固定する。
   - pin を取り直すときに、`MAINTENANCE_QUIESCE_REOPENS`・`MAINTENANCE_QUIESCE_WAIT_MS`・`RETRY_DISPATCH_GRACE_MS` を `HARNESS_CONSTANTS`（pin の bytes から読む）へ移す。
   - そのとき S2 `:2315` の「pin の bytes に無い」も直す。
4. **dev の記録の 2 点**（問 4、S4 の外の file）
   - run は `67cf9453` の作業木に hook を当てて走らせ、後に `11c12fb9` として commit した。patch は同じ bytes。
   - 受領書の `signalled` は `SIGTERM` と出るが、実際は SIGKILL。`closed: true, closeMs: 0` の理由も書く。
   - DR-DBC-7 `:1048` の「commit `11c12fb9`」も同じ書き方に揃える。
5. **観測の後に選んだ読みの一覧に、setup の静止の行を足す**
   - 対象：宣言 `readingsChosenAfterDevObservation` と `READINGS_AFTER_DEV`。
   - 書く内容：DR-CP4-L-27 の静止の定数と止め方は `hd-g03h2` の drift を見た後に置いたこと。dev の 3 回の後に値を変えていないこと。向きは止まる側であること。前例は `freshness-settle`。
   - `freshness-settle` の行（9 番）の「maintenance の待ち切れは開示」に、「session の中の待ちについて。最後の session の後と cold は L-27 で止める」と添えてもよい。
6. **段取りの記述の更新**
   - 対象：`k67Readings.status`、`s4StagesRule`。
   - 内容：追補 #21 と、この 4 回目の確認（記録の場所と判定）を足す。S3 の記録の取り込みと一緒に閉じてよい。
7. **書き方の細部**
   - 「dev の受領書は通らない」（`cp4-decisions.md:1067`、`db-connection-decisions.md:1052`）を「dev の受領書はこの検査の対象外」にする。
   - S2 の `readBack.maintenance` の acceptance と (n)(3)・宣言 (14) の「測定の入口も弾く」に「frozen の受領書」を添える。
   - (n) の中の「(a)」「(b)」の小見出しを、限界の項の名前とぶつからない形にする。
   - 宣言の過去の行を直すか残すかの方針を 1 つに揃える（`[39]` は直し、DR は残す）。試験の注釈「never edit」（`observation-prep.test.mjs:9029`）も合わせる。

## 確かめたこと

- 範囲の 3 commit と変更 file 8 つ。HEAD＝`origin/claude/s4-9-pr3`＝`068cf3a6`、作業木が clean であること。
- pin 対象の harness 3 file と判定 3 file が、この範囲で変わっていないこと。`implementationCommit` が `1dd6fb35` と一致すること。
- S2 の JSON の変わった path の全部（18 path）の新旧と、限界の文単位の差分。宣言の変わった行（`[37]`・`[39]`・`[40]`・`readingsChosenAfterDevObservation[21]`）の新旧。
- validator の差分の全体（`REOPEN_QUIESCE`、`MAINTENANCE_RECEIPT_FIELDS`、`FRESHNESS_SETTLE.setup`、`reopenErrors`、`setupReadingErrors`、注釈）と、試験の差分の全体（変異の検出、宣言の行の数）。
- `frozen-setup-driver.mjs`：`:170-180`、`:190-212`、`:1626-1676`（`runQuiesceSession`）、`:2450-2491`、`:2684-2735`、`:2825-2845`。`workspace-db.mjs`：`:50-72`、`:213`、`:286-330`。`setup-receipt.mjs`：`:100-135`。
- quiesce の session の stop が `receipt.sessions` に積まれても、下流（`r5-check-runner.mjs` の `isolationStop`、`setup-receipt.mjs` の `completeSetupProblems`）が誤って止めないこと。見た範囲（`receipt.sessions`・`.sessions` の grep）では、session の一覧を閉じた集合で読む検査は無い。
  - 開き直した受領書が入口を通ることは、合成の試験が確かめている（`frozen-setup-complete.test.mjs:1362-1383`。`quiesce-1` の session の後に `assertCompleteSetupReceipt(sealed)` が通る）。
- `freshnessSettles` の point を閉じた集合で読む下流の検査は、見た範囲では無い（`point: "quiesce"` を足しても壊れない）。
- `setup-receipt.mjs:280`：`maintenanceQuiet` を含む `completeSetupProblems` は、`sealed.fixtureKind === "frozen"` のときだけ当たる（今回 `:276-288` を読んだ）。
- 宣言の `readingsChosenAfterDevObservation` の 23 行の全部。`items[10]`・`items[13]` の id が SR-11・SR-14 であること。
- `git diff --stat 39b89bc3..068cf3a6` が、harness の 3 file について空であること。
- (h) の新しい文：`resolveEdge`（`material-revision.mjs`、quote の hash 2 本の一致）→ `pairs` null → `revision-of-path-unresolved` の hold（`quality-evidence-items.mjs:215-217`）、edge の束縛は `unresolved-edges` と `d-unresolved-edges` で fail（`quality-verdict.mjs:246`・`:461-462`）。
- 試験の fake（`test-support.mjs:1765-1773`）：quiesce の session で `narrative_semantic_index_metadata` の generation を上げる。`readIndexMetadata` が読む表と同じ。
- `K67_LIMIT_WORDS` は 86 語のままで、(h)・(n) の新しい文の語は束縛に入っていないこと。DR はそれを主張していない。
- dev の記録の全文、`dev-hook.patch`、`run-reopen.sh`、`run-1.out`・`run-2.out`、`dev-log-1.jsonl`・`dev-log-2.jsonl`、2 つの受領書の `status`・`quiesce`・`readBack.maintenance`・`sessions[].stop`・`freshnessSettles`、`cold-runs-1.txt`・`cold-runs-2.txt`。cold DB（`qzo1`）の dependency-verify の run と retry の Attempt の行（immutable で読んだ）。
- `11c12fb9` の commit 時刻（11:31:29Z）、`git diff 67cf9453 11c12fb9` と `dev-hook.patch` の bytes の一致、dev の枝が remote に無いこと。
- `launcher.mjs` の `stopElectron`（`67cf9453`）の signal の記録の仕方。
- ユーザーの回答 `337ff239` の全文と SHA-256（`ad89ebfb4d04d324d2b022526f4c7aaa83bb8c12c4f0e8a88de6ecc4083803d1`）。
- DR の差分（cp4 の L-24・T-5 の追記、追記 3、DR-DBC-7 の「S3 10 回目の 3 回目の確認と setup の読みの整合」）。
- validator を読むだけで実行した（Node 22）：`passed`、errors 0、`formalReady` false、placeholder 23。

## 未確認

- **試験は回していない**（前例どおり）。次は作者の申告のままである。
  - DR の「1022 件、pass 1014、fail 8（直す前と同じ名前）」（`cp4-decisions.md:1682`）
  - 新しい試験（推奨 3 の Index metadata の停止、S2 の変異の検出）が実際に通ること
- 凍結の G-03/frontier-exceeded での開き直しの経路（`app.close()` の後に running が残る形）と、2 回を使い切って止まる経路の実機での挙動。
- quiesce の session の中で、T-5 の「Verify が取消しを繰り返す」連鎖が起きるか。
- 製品の will-quit の障壁が、running の maintenance を閉じる時にどう扱うか。`next_attempt_at` が NULL で取り消された run を、次の起動で再 dispatch するか（`retryPending` に数えない偽陰性の可能性）。
- run の時点の dev の作業木が `11c12fb9` と同じだったこと（patch と commit の一致までは確かめた）。
- master と contracts の取り込み、pin の取り直し、検出力の記録、S4b（まだ無い）。
- requalify（`graph_response::assemble`）の全体、品質判定 v3 の §2〜§12 の全文、K6/7 の本文の全文（今回の範囲の論点に要らなかったので読んでいない）。
