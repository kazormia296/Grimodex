# S3 の 10 回目の 3 回目の確認（`140bdda2..67cf9453`。2026-11-16）

**この file の出所**：S3 の独立 reviewer（Claude の agent、Opus 5.5、read-only）の報告である。ユーザーの確認ではない。

- file の変更、commit、build、run の起動はしていない。書いたのはこの 1 file だけ。
- 行ったこと：
  - git の object と作業木を読んだ。
  - contracts の bytes の SHA-256 を計算し直した。
  - GitHub の activity API を 1 回読んだ。
  - dev の受領書は、ID の構造と `fixtureKind`・`quiesce`・`readBack.maintenance` だけを読んだ。値に v3 は当てていない。
  - validator を読むだけで実行した（Node 22。前例どおり）。
  - 試験の file は回していない。
- 対象：枝 `claude/s4-9-pr3`（worktree `/home/grimodex/worktrees/Grimodex/s4-9-pr3`）。
  - HEAD は `67cf9453` で、`origin/claude/s4-9-pr3` と一致する。作業木は clean。
  - 範囲の 6 commit：`1dd6fb35`・`1fc90060`・`39b89bc3`・`5f00507c`・`19c6113c`・`67cf9453`。
- **盲検の限界**：依頼文には、builder の結論（案 (A) を選んだこと、edge 単位にしたこと）が書かれていた。v3 §10 の 3 は「起案者の結論は渡さない」としている。そのためこの確認は完全な盲検ではない。コードは独立に読んで判断した。

## 判定：**changes-required**（必須 1、推奨 5）

- 前回の必須 1（edge 単位の対応）は**閉じた**。推奨 1〜5 と 7 も閉じた。
- 新しい必須 1 は、`39b89bc3`（setup の静止）が束縛済みの S2 の setup の読みを古いまま残している件である。
  - 対象は 4 つ：開き直しの閉じた集合、静止の定義、`readBack.maintenance` の受け入れ、cold の running の扱い。
  - 向きは止まる場合が増える側で、ユーザーの回答 `337ff239` の範囲にある。黙った緩和ではない。
  - ただし、凍結される S2 の中で限界 (n) と `setupReadings` が食い違う。
- 推奨 6（前回）は、記録が「直した」と書くが、実物に無い。

---

## 問 1：必須 1 は閉じたか

**閉じた。(i)〜(iii) の 3 つの差は、すべて無くなった。**

- 今のコード（`quality-evidence-items.mjs:219-282`）の動き：
  - path の `pairs` から `relation → revision` を作る（`:227-233`）。
  - 各 edge について、向きつきの論理の端点が fixture の relation（`relationEndpoints`）と一致する pair を引く（`:260-269`）。
  - **その Revision の行だけ**で (i)〜(iii) を判定する（`:279-282`、`:299`）。
- 3 つの差の確認：
  - (i) fail→pass：edge は自分の Revision の行で引かれる（`:282`・`:299`）。先勝ちの合成（旧 `rows` の Map）は消えた。**閉じた**。
  - (ii) fail→hold：自分の Revision が読めて ID が無ければ、他の Revision が読めるかどうかに関係なく `fail`（`evidence-id-not-in-revision`、`:300-307`）。旧 `evidence-id-in-no-read-revision` の枝は削除された（`1dd6fb35` の差分）。**閉じた**。
  - (iii) hold→fail：自分の Revision が読めない edge は判定しない（`:281` の `continue`）。`typed-revision-not-read` の hold は path の Revision ごとに積まれる（`:237-241`）。**閉じた**。
- 入力の側（`quality-verdict-cli.mjs:184-199`・`:228`・`:285`）：
  - `relationEndpointsOf` は `fixture.relations` と G-01 の `fixture.relation` を読み、`[fromEntityId, toEntityId]` を返す。
  - 凍結 setup の plan が relation を作る `relationRowsOf`（`frozen-setup-plan.mjs:723-744`）と同じ行・同じ field である。
  - `resolveEdge` が照合する material の `from`／`to`（`material-revision.mjs:51-57`・`:108-110`）とも同じ出所。
  - 受領書の値は使っていない（v3 §2.0 の「期待は fixture から導く」に合う）。

### `edge-revision-unresolved` の向き

- **前の実装との比較**：
  - `11d5e430` でも `db7c1234` でも、こうした edge は path の全 Revision を合成した行で (i)〜(iii) を判定していた。結果は `pass` にも `fail` にもなりえた。
  - 新しい実装は `hold` にする（`:270-277`）。
  - **原理上の向きは「判定（pass・fail）→ hold」で、fail→hold を含む緩む向き**である。
- **ただし、凍結の 13 variant の整合した受領書では到達しない**。理由：
  1. `pairs` が null でないのは、path の全 edge が `resolveEdge` を通ったときだけである（`material-revision.mjs:282-286`）。`resolveEdge` は runtime の `from`・`to`・型・向き・quote 2 本の一致を要求する（`:262-272`）。だから各 edge の relation の向きつきの端点は、その edge の端点と等しい。
  2. 表示側の edge（`evidence`）と material の path（`paths`）は、probe の同じ応答 `row.value` から作られる（`renderer/cp4-k64-probe.tsx:479-481`、`evidence-fields.mjs:45-56` の `hashEdges` と `material-revision.mjs:181-191` は同じ `edge.from.entityId`／`edge.to.entityId`）。
  3. g02〜g08 と G-01 の fixture のどれにも、向きつきの端点が同じ relation は 2 本無い。全 relation を列挙して確かめた。
  4. 論理と runtime の対応は 1 対 1 で、違えば `[precheck]`（`quality-evidence-items.mjs:57-66`・`:81-88`）。
  - したがって候補が 0 本・2 本以上になるのは、受領書が内部で食い違うときだけである。たとえば試験 `reversed` は、表示側の edge だけを逆向きにしている。
- **字義との関係**：
  - v3:62 は「入力の誤り…は `[precheck]`。`hold` にしない」としている。内部で食い違う受領書を入力の誤りと読めば `[precheck]` の方が字義に近い。
  - 一方で、既存の `revision-of-path-unresolved`（`pairs` が null）の `hold` と同じ扱いにした、という読みも立つ。
  - 到達しないので結果は変わらない。開示（S2 (h)、宣言 `revisions[37]` の「残る差」）もある。**指摘にはしない**（確かめたことに記録する）。
- 細かい点：候補は relation の本数で数える（`carriers.length !== 1`）。同じ Revision の 2 本の relation が同じ向きの端点を持つと、Revision が一意でも `hold` になる。これも fixture には無い。

### 試験は製品の Evidence ID を再現しているか

- **再現している**（`quality-verdict.test.mjs` の新しい試験。`1fc90060`）。
  - G-03/base の 2 hop で、`evidenceId` を `nir1:evidence:codex:${entity}` に置き換える。表示側と読み取り側の両方を置き換えている。
  - 中間の Entity `ivy` の ID が 2 つの Revision に出ることを `holders.length === 2` で assert している。
  - (i) 後の Revision の行だけが違う → `fail`。先の Revision の行が違う → `fail`。
  - (ii) 自分の Revision から ID を除き、別の Revision を読めなくする → `fail`、`typed-revision-not-read` も出る。
  - (iii) 自分の Revision を読めなくし、表示した行を別の hash にする → `hold`、fail は無し。
  - 自分だけが読めない場合 → `hold`。向きが違う場合 → `edge-revision-unresolved`。
- 形の違い（note）：
  - 合成は relation ごとに別の Revision（`rev-of-${edge}`、`quality-verdict.test.mjs:204-216`）にしている。
  - 凍結の G-03/base と G-06/base の 2 hop は、2 本の relation が **1 つの Revision** に入る（`g03-r-path`、`g06-r-path`）。製品の形では、中間の Entity の行が 1 本の 3 行になる。
  - この形の合成は無いが、新しい実装では 2 本の edge が同じ Revision の行を引くだけで、分岐は増えない。
- **前回の未確認「どの variant で (i)(iii) が起きうるか」が閉じた**：
  - 13 variant の期待する path を列挙した。2 hop 以上は G-03/base と G-06/base だけで、どちらも 1 つの Revision に収まる。ほかは 1 hop。
  - したがって前の実装の差は、期待の path では起きなかった。起きうるのは期待の外の path（edge の束縛が `fail` にする）か、dev-shape の形（dev gate の `hd-g03h2`）に限られる。
  - 直しは字義に合わせるもので、凍結の範囲での実害は無かった、という裏づけになる。

## 問 2：推奨 1〜7

| 推奨 | 結果 | 根拠 |
|---|---|---|
| 1 B2-4 の残り | **閉じた** | `observation-prep.mjs:4607-4608`（「the one reading changed after an observation (and the fail→hold readings)」）、`:2193`（「観測の後に変えた読み 1 点＋fail→hold 2 点」）。数え方の細かい揺れが残る（推奨 5） |
| 2 B2-5 の宣言の側 | **閉じた** | 宣言 `revisions[37].reason` に「R-12 は k62 の regime〔candidate の証拠が欠けた summary〕では判定に届く（k67Readings.limits (a)。S3 10 回目の B2-5）。R1 でない候補には当てはまらない〔推測〕」 |
| 3 drift の結論の範囲 | **閉じた** | S2 (g)(k)(n)（`observation-prep.v1.json:468`）、`s4StagesRule`（`:1087`）、DR-DBC-7、追記 1、宣言 `[37]`・`[38]` が「drift の枝は Graph を返さない（コードで確定）。worker が見落としたときの requalify は読んでいない。古い Graph を返す経路は見つかっていない」に直った。`K67_LIMIT_WORDS`・`S4_PROCEDURE_WORDS.k` の語も置き換わった（`observation-prep.mjs:4683-4684`・`:1272`）。対象の file 全体で「経路は無い」を grep すると、残りは無関係な DR-CP4-V-4（`cp4-decisions.md:1073`）だけ |
| 4 remote 時刻の 40 桁 | **閉じた** | `cp4-decisions.md:1657` の `--remote-time-record` の行は `1dd6fb35f9b11816f2a90903b07afc0e83279166` を全桁で書いている |
| 5 「(a)〜(l)」 | **閉じた** | `observation-prep.mjs:4715`、`observation-prep.test.mjs:8430` が「(a)〜(n)」 |
| 6 hash が食い違う edge の `hold`（既存）の開示 | **閉じていない**（推奨 2） | DR-DBC-7 `db-connection-decisions.md:1028` は「S2 の限界 (h) に 1 行足した」、追記 2 の表 `cp4-decisions.md:1646` は「S2 の限界 (h) と DR-DBC-7 に開示した」と書く。しかし S2 にも宣言にも該当する文が無い（`revision-of-path-unresolved`・「解決しない」・「hash 2 本」・`unresolved-edges` の grep は S2 と宣言で 0 件）。宣言 `revisions[39]` は推奨 6 を「引けない edge の hold の開示」と書き、別物に読み替えている。前回の B2-4 と同じ「記録と実物の食い違い」 |
| 7 `11d5e430` の独立レビューの位置づけ | **閉じた** | DR-DBC-7 `:1027`、追記 2 `cp4-decisions.md:1634`。どちらも「今回の新しい実装 commit（`1dd6fb35`）は、次の S3 の確認で見る」と書く。この file がそれにあたる（問 5） |

## 問 3：setup の静止（`39b89bc3`）

### 設計どおりか

**おおむね設計どおり**（案 B を主、最後の枝に案 A の stop、測定の入口に案 C）。設計との違いが 1 つある。

- **違い（note）**：
  - 設計の案 B は「セッションを閉じる前に、maintenance の静止を**必須**にする」だった（`setup-quiesce-design.md` の案 B）。
  - 実装は session の中の待ちを変えていない。`settleFreshness` は `requireQuiet` を渡さないので、従来どおり Freshness だけで `settled` が決まる（`frozen-setup-driver.mjs:193-212`）。
  - その代わり、**最後の session を閉じた後の DB** を読み、静止していなければ step の無い quiesce の session で開き直す（`:2690-2734`）。
  - 写す時点の状態を保証する点では同じ効果である。DR-DBC-7 と S2 (n) は実装の側を正しく書いている。
- **Index metadata を動かさない検査**：
  - 開き直しの前の閉じた DB の `readIndexMetadata`（index ごとの `generation`・`dirty_cache_flag`・digest・producer。`workspace-db.mjs:55-72`）と、開き直しの後の同じ読みを比べる。違えば `[precheck] S1i maintenance-quiesce`（`frozen-setup-driver.mjs:2697`・`:2725-2734`）。
  - 比べるのは開き直しの前の DB で、測定点の probe の値ではない。ただ、開き直しの前の DB は測定点の後の閉じた状態なので、「測定点が probe したもの」の代わりとして足りる。
  - **この停止の試験は無い**（`39b89bc3` の試験に、Index metadata が動いて止まる例が無い。推奨 3）。
- **signal で終わった session の扱い**：
  - `endedByClose` は `evidence.stop.closed !== false` かつ `signalled` が空（`:2693-2695`）。stop の形は `session.mjs:439` の `evidence.stop = stopElectron(...)`、`launcher.mjs:516-564` の `{closed, closeMs, signalled, remaining}` と合う。
  - quiesce の session の stop も `receipt.sessions` に積まれ（`:2489`）、次の判定は quiesce の stop を見る。最後まで signal なら止まる。試験もある（`frozen-setup-complete.test.mjs` の「signal で終わった最後の session は…」）。
- **retry の予定の SQL**（`workspace-db.mjs:259-281`）：
  - 条件：`failed` かつ `retryable` で、`next_attempt_at > now − 5 s`、`work_key` があり、同じ `work_key` の後の run が無い。
  - 製品の書き方と合う：
    - 起動時の復旧は `running` を `fail_maintenance_run_in_tx(Interrupted)` で閉じる（`maintenance_runtime.rs:5010-5018`）。
    - その中で `next_attempt_at` を失敗時刻＋backoff（1 s／2 s／4 s。`maintenance_runtime.rs:4339`・`:5081-5087`）にし、形式は `%Y-%m-%dT%H:%M:%S%.3fZ`（`maintenance_lifecycle.rs:1946-1966`）。
    - この形式は JS の `toISOString()` と同じで、文字列の比較が時刻の比較になる。
    - preempt の取消しは `next_attempt_at = NULL`（`:1836-1843`）なので数えない。即再試行の隙は、2 回の読みの run 数・最新 `created_at` の比較で捕まえる。
    - backoff は最大 4 s なので、正常に dispatch されれば `NOT EXISTS` が、されなくても猶予 5 s の後に外れる。待ちが 60 s で尽きる形にはならない。
  - surface で絞っていないので、Freshness の Attempt も数える。
    - Freshness は失敗時刻を `next_attempt_at` に書き（`incremental_freshness.rs:2106`・`:2123`・`:3715-3742`）、run は `work_key` を持つ（`:1663`・`:1765`）。
    - 同じ run の中で再試行されると、最長 5 s「予定あり」と読まれる。待ちが伸びるだけで、止まりはしない。
  - `incremental_freshness.rs:864-865` の `datetime('now')`（空白区切りの形式）は、同じ日付なら ISO より小さいので数えない。偽陰性の向きで、偽陽性ではない。
- **測定の入口の fail-closed**：
  - `assertCompleteSetupReceipt` は、`readBack.maintenance` が無い、`running`・`retryPending` が 0 でない（`null` を含む）受領書を `maintenanceQuiet` の problem で弾く（`setup-receipt.mjs:92-99`・`:138-144`・`:280-286`）。
  - ただし `fixtureKind === "frozen"` のときだけである（`:280`）。
  - 正式の入口はすべてこれを通る：`frozen-k64-run.mjs:288-292`、trace の `trace-frozen.mjs:124-128`（`setup-complete` のとき。blocked の記録は workspace を使わない）、`seed-pin.mjs:202`。
  - `loadSetupReceipt` だけで入るのは、dev の経路の `k64-runner.mjs:627` と `trace-runner.mjs:1038` だけである。正式 run は frozen なので、入口は効く。
  - **dev の記録 `setup-quiesce-dev.md` の「k64 は cold を `assertCompleteSetupReceipt`（新しい `maintenanceQuiet` の検査を含む）で受け付け」は事実と合わない**。dev の受領書は `fixture.kind = "dev"` で、この検査を通らない。入口の検査を確かめたのは合成の試験だけである（推奨 4）。
  - cold の読み返しでも止める（`frozen-setup-driver.mjs:2833-2845`）。

### 偽陽性（正式 run を不当に止める誤検出）の恐れ

- **静止している workspace を止める経路は、見た範囲では小さい**。
  - signal：`fusion-eval-data` の受領書 279 個で `signalled` はすべて空、非空は 0 個。dev の確認でも 0。
  - retry の予定：上のとおり、最長でも数 s で外れる。
- **残る恐れは開き直しの経路そのもので、実機では一度も通っていない**（`setup-quiesce-dev.md`「開き直しの経路は実機では通っていない」）。
  - (1) quiesce の session は、query の Scene を active にして workspace を開く（`frozen-setup-driver.mjs:1655-1659`）。
    - 開いた renderer が関連の照会を出して C を作る、または Verify を preempt するなら、2 つのことが起こりうる。静止しない。あるいは Index metadata が動いて止まる。
    - T-5 は「C の build の照会そのものが Verify を奪う」と記録している（`cp4-decisions.md:1067`）。
    - 開いただけで照会が出るかは読んでいない（未確認）。
  - (2) **直近の正式 run の凍結の setup で、cold に running が残っている**。
    - 正式 run s7r1 の完全な setup の受領書 29 個（worktree `cp4-formal-k66` の `.artifacts/cp4/s7r1-*`）を読んだ。`readBack.maintenance.running` が 0 でないのは `s7r1-g-03-frontier-exceeded` の 1 個（`running: 1`、run 409 本）だった。
    - この setup の 3 session は、すべて `app.close()` で閉じている（`closed: true`、signal 0）。signal で終わったから残ったのではない。
    - 古い backup（`worktree-artifacts-backup-20261105`）の凍結の受領書 187 個では、`sp-p4-s5r-1` の G-07/base（without-seed-pin-step）の 1 個。
    - 2026-10-31 の T-5 の記録（`cp4-decisions.md:1067`）も、凍結の cold DB の G-04/base と G-07/base に `dependency-verify` の running が残ったと書く。同じ行の `t3r-*` は dev の通し稽古。
    - 今の harness では、少なくとも G-03/frontier-exceeded の正式の setup は、実機で未通過の開き直しの経路に入る見込みが高い。
    - T-5 は、frontier-exceeded では Verify が取消しを繰り返すと記録している（測定の process で 2294 件・約 9 分）。開き直しの session の中で Verify が完走しなければ、setup は止まる。
    - 止まるのはユーザーが選んだ結果（「それでも静止しなければ止める」）で、誤検出ではない。ただ、正式の setup が通らなくなる恐れとして、S4b の前に確かめるべき事実である。
  - 推奨 1 として、S4b の前に開き直しの経路を実機で 1 回通すこと（G-03/frontier-exceeded に相当する dev の run）を挙げる。
- **閾値の緩和は無い**。
  - 変わったのは止まる条件の追加：cold の running／retryPending、`maintenance-quiesce`、入口の `maintenanceQuiet`。
  - 置き換わった試験は「Verify が上限までに終わらなければ先へ進む（止めない）」の 1 件だけで、止まる試験に置き換わった（試験の差分の `-` 行を読んだ）。
  - `maintenanceQuiet` に retry の予定を足したので、setup の measurement-point の前と session-end の待ちは長くなりうる。上限（60 s）と `settled` の決め方は変わらない。
  - 測定の process の待ち（T-1）には `readActivity` を足していない。
  - 閾値（D 40 ms・B 54.2 ms・上限 94.2 ms・T_late・1％・2 件）、`K64_VALUES`、Gold、fixture は差分に無い。

## 問 4：開示の書き換え

### S2 (n)(h)(g)、`s4StagesRule` (k)、宣言、DR-CP4-L-27、DR-CP4-S4-11（追記 2）、DR-DBC-7

- **(h)**：edge 単位の対応、`relationEndpoints`、`edge-revision-unresolved`、(i)〜(iii) の 3 つの差の向きが、実装と合う（`observation-prep.v1.json:468`）。
  - 宣言 `[37]` の「残る差は、Revision を引けない edge の hold」は正しい。到達しないことは書いていない（note。書けば強い開示になる）。
  - 推奨 6 の文は無い（問 2）。
- **(g)(k)**：推奨 3 のとおり絞られた。事実と合う。
- **(n)**：手順（開き直し 2 回・各 60 s・`maintenance-quiesce`・cold の読み返し・入口）と、dev の確認（開き直し 0 回・待ちの最長 1.1 s・running 0。開き直しの経路は実機で未通過）は、コードと dev の記録に合う。
  - 「retry の予定…起動時の復旧が作る行の実物は見ていない〔推測〕」の推測は、問 3 の製品コードの読みで裏づけられる。
  - ただし (n) は「静止の定義が変わった」ことを書いていない。その結果、S2 の中の別の束縛と食い違う（必須 1）。
- **DR-CP4-L-27**（`cp4-decisions.md:776` の追記）、**追記 2**、**DR-DBC-7 の「setup の静止」**：ユーザーの回答の範囲（`337ff239`:16-17、「記録だけ」→「止める」と dev の 1 回）と合う。
  - 回答 :15「閾値の緩和ではなく、止まる場合が増える」と、`39b89bc3` の向きも一致する。
  - 黙った緩和は無い。
  - DR-DBC-7 の「設計の『次の S4（8 回目）』は誤記で 9 回目」も事実と合う。
- **食い違い（必須 1）**：開き直しと静止の**正本の読み**が `39b89bc3` の前のまま残っている。限界 (n) と `s4StagesRule` だけが新しい挙動を書いている。

| 束縛 | 今の記述 | `39b89bc3` の後の実物 |
|---|---|---|
| `setupReadings.reopen`（`observation-prep.v1.json:2239`・`:2269`・`:2298`）と validator の `REOPEN_TRIGGERS`・`REOPEN_TOTAL = 9`（`observation-prep.mjs:1421-1451`）、DR-CP4-L-24（`cp4-decisions.md:773`、「開き直しの正本…契機は次の 3 つだけ（閉じた集合）…これ以外の失敗は開き直さない…合計の上限は 9 回の開き」）、読み「開き直し（閉じた集合）」（`observation-prep.v1.json:1832-1833`） | 契機 3 つ、合計 9 回 | 4 つ目の開き直し（quiesce、最大 2 回、`quiesce-n` の directory）が加わり、合計 11 回 |
| `setupReadings.freshnessSettle.setup.maintenanceStillWhen`（`:2506`）と validator（`observation-prep.mjs:1498-1501`）、SR-14 の読み（`:1852` 以下「status running の行が無く、run の件数と最新の created_at が…同じ」） | running 0 と 2 回の読みの一致 | retry の予定 0 も要る（`workspace-db.mjs:298-308`） |
| `freshnessSettle.setup.coldDbRunningRuns: "disclosed"`（`:2521`）と validator（`observation-prep.mjs:1507`）、同じ `rule` の「cold DB の running の行も開示するだけ」 | 開示 | 止める（`frozen-setup-driver.mjs:2838-2845`） |
| `receiptFields["readBack.maintenance"]`（`:2401-2403`）：fields `runs`・`lastCreatedAt`・`running`、acceptance「開示（running の run が残っても止めない）」 | 開示 | `retryPending` が増え、止める。測定の入口も弾く |
| 受領書の欄の閉じた集合（`receiptFields`） | `quiesce` が無い | `receipt.quiesce`（`reopens`・`final`）が増えた |
| DR-CP4-T-5（`cp4-decisions.md:1067`）「maintenance の待ち切れは止めずに開示…cold DB の running の行も `readBack.maintenance` に開示するだけ」 | 開示 | cold の running は止める（待ち切れの開示は session の中では残る） |

- 向きはすべて止まる側で、`337ff239` の範囲にある。
- しかし凍結される S2 は、限界 (n) で「止める」と言い、`setupReadings` で「止めない・閉じた 3 つ・9 回」と言うことになる。
- validator は古い側を束縛している。今の S2 は `status: passed` なので、validator はこの食い違いを捕まえていない。

### 束縛の整合

- `337ff239` の SHA-256：contracts の bytes から計算し直して `ad89ebfb4d04d324d2b022526f4c7aaa83bb8c12c4f0e8a88de6ecc4083803d1`。次の 3 か所と一致する。
  - `K67_CONFIRMATION_RECORDS.additional[5]`（`observation-prep.mjs:284-292`）
  - S2 の `additional[5].sha256`
  - DR-DBC-7・L-27 の記載
- 6 行目の topic・`additionalNote`（6 行）・`intoReview`（6 行）・validator の誤りの文（six answers、`observation-prep.mjs:5528`）は、互いに合う。
- `K67_LIMIT_WORDS` は 86 語で、すべて `k67Readings.limits` に在る。
- `S4_PROCEDURE_WORDS` は (a)〜(k) の 11 群・計 84 語で、すべて `s4StagesRule` に在る（(k) 22 語を含む）。DR の「86 語」「84 語」と一致する。
- validator（読むだけ、Node 22）：`status: passed`、errors 0、`formalReady` false、placeholder 23。前回と同じ。
- pin：`test-support.mjs` は `HARNESS_FILES` に入らない（`k64-runner.mjs` の一覧には `workspace-db.mjs`・`frozen-setup-driver.mjs`・`setup-receipt.mjs` だけ）。DR の「pin から外れた 3 file」と合う。

## 問 5：v3 §0・§10 の 3

- **判定 3 file を最後に変えた commit**：`git log -1 -- quality-verdict.mjs quality-evidence-items.mjs quality-verdict-cli.mjs` は `1dd6fb35f9b11816f2a90903b07afc0e83279166`。
  - `K67_QUALITY_VERDICT_V3.implementationCommit`（`observation-prep.mjs:333`）と一致する。
  - `5f00507c` は `observation-prep.mjs` の 1 行だけを変えている。
- **remote の時刻**：GitHub の activity を読み直した。
  - `140bdda2→5f00507c` が `2026-11-16T10:33:19Z`、`5f00507c→67cf9453` が `10:54:04Z`。
  - その前は `e03760eb→140bdda2` の `09:47:45Z`。
  - `1dd6fb35` の commit の時刻は 10:17:06Z で、09:47:45Z の push より後、10:33:19Z の push の範囲に入る。最初の remote の時刻は 10:33:19Z で、DR（`cp4-decisions.md:1657`）と一致する。
  - `git branch -r --contains 1dd6fb35` は `origin/claude/s4-9-pr3` だけ。
  - 「最初の正式 run より前」は run の時点の検査なので、今は確かめようがない。
- **独立レビューの記録の形**：
  - この確認が、`1dd6fb35` の差分を読んだ独立のコードレビューにあたる。v3 §10 の 3 の順（実装 → レビュー → 反映 → push）に対して、push が先である。前例 `db7c1234`・`11d5e430` と同じ形で、手順の違反とはしない。
  - DR は「次の S3 の確認で見る」と書いた（`cp4-decisions.md:1634`、DR-DBC-7 `:1027`）。この file をその位置づけで記録する行は、まだ無い（統合者の後続作業）。
  - 盲検の限界（冒頭）も、その記録に添える。
  - 必須 1・推奨はどれも判定 3 file を変えない。`implementationCommit` の取り直しは要らない。ただし `edge-revision-unresolved` を `[precheck]` に変えることを選ぶなら、取り直しが要る。

---

## 必須

1. **S2 の setup の読みと DR-CP4-L-24・T-5 を、`39b89bc3` の後の挙動に合わせる（または「L-27 の静止が L-24・T-5 のこの点を上書きする」と明示する）。**
   - 事実：限界 (n) と `s4StagesRule` は「静止しなければ開き直し、尽きたら止める」と書く。一方 `setupReadings` は古いまま残っている（問 4 の表）。
     - `reopen` は閉じた 3 つ・合計 9 回。
     - `freshnessSettle.setup` は静止を running と run 数で定義し、cold の running は `disclosed`。
     - `receiptFields["readBack.maintenance"]` は「running の run が残っても止めない」で、`quiesce` の欄が無い。
     - validator の定数（`REOPEN_TRIGGERS`・`REOPEN_TOTAL`・`coldDbRunningRuns`・`maintenanceStillWhen`・`RECEIPT_FIELDS`）も同じく古い。
   - 向き：止まる側で、`337ff239` の範囲内。黙った緩和ではない。ただ、凍結される S2 が自分の中で食い違い、正本（L-24「開き直しの正本」）が実物と違うことを言う。
   - 直し方の例：
     - `reopen` に quiesce の契機を足す（または `closedSet` の注記で L-27 の別枠と書く）。
     - `maintenanceStillWhen` に `no-planned-retry` を足す。
     - `coldDbRunningRuns` と `readBack.maintenance` の acceptance を `[precheck] S1i maintenance-quiesce` にする。
     - `receiptFields` に `quiesce` と `retryPending` を足す。
     - validator の定数を揃える。
     - L-24・T-5 の行に追記する。
   - S4b の前に必要。S2 追補で閉じられる。判定 3 file には触れない。
   - 予定済みの作業には含まれない：
     - 限界 (l) の「S4b の前に残る取り直し」は、bytes の pin、検出力の記録、R5 の記録、S3 の記録、取り込みの開示である。`setupReadings` の読みの書き換えは無い（(l) にも `s4StagesRule` にも `setupReadings`・SR-14・L-24・T-5 の語は無い）。
     - 上の validator の定数は SHA の pin ではない。pin を取り直しても変わらない。

## 推奨

1. **開き直しの経路を実機で 1 回通す**（S4b の前に）。
   - 開き直しの経路はどの実機の run も通っていない。
   - 直近の正式 run s7r1 では、G-03/frontier-exceeded の cold に running が 1 件残っていた（3 session とも `app.close()` で閉じた。問 3）。古い凍結の G-07/base と、T-5 の G-04/base・G-07/base にも同じ実績がある。
   - 開き直しで静止するかで、正式の setup が通るかが決まる。G-03/frontier-exceeded に相当する dev の run で次を確かめるとよい。
     - quiesce の session が Verify を完走させること。
     - 開くだけで照会が出て Index metadata が動かないこと。
   - 結果の数（開き直しの回数、待ち、止まったか）を (n) に足す。
2. **推奨 6（前回）の実物**：S2 の限界 (h) に「表示側の hash が material の quote と食い違う edge は `resolveEdge`（hash 2 本の一致）で解決せず、`pairs` が null で `revision-of-path-unresolved` の `hold`。v3:96 の第 2 文の行が 3 本になる場合も同じ。条件 4 は edge の束縛の `unresolved-edges` で `fail`」の 1 行を足す。
   - あるいは DR-DBC-7 `:1028` と追記 2 `cp4-decisions.md:1646` の「S2 の限界 (h) に足した」を外す。
   - 宣言 `revisions[39]` の推奨 6 の読み替え（「引けない edge の hold の開示」）も直す。
3. **Index metadata の停止の試験を足す**。開き直しで `readIndexMetadata` が変わる fake を作り、`[precheck] S1i maintenance-quiesce` で止まり、cold DB を作らないことを確かめる。今は試験が無い。
4. **dev の記録 `setup-quiesce-dev.md` の「`assertCompleteSetupReceipt`（新しい `maintenanceQuiet` の検査を含む）で受け付け」を直す**。
   - dev の受領書は `fixture.kind = "dev"` で、この検査を通らない（`setup-receipt.mjs:280`、`frozen-k64-run.mjs:288-292`）。
   - (n)・DR-DBC-7 は入口の検査を dev で確かめたとは書いていないので、記録は外の file だけ。
   - 書き方の例：「入口の検査は合成の試験でだけ確かめた」。
5. **fail→hold の数え方を揃える（小）**。
   - `observation-prep.mjs:2193` と DR-CP4-P-11 追記 1・2 は「fail→hold 2 点」と書く。2 点目は `11d5e430` の path 単位の hold で、今は無い。
   - 宣言 `[37]` は「1 点＋残る差 `edge-revision-unresolved`」と書く。
   - 今の 2 点目が `edge-revision-unresolved` であることを 1 か所で明示し、到達しない（凍結の fixture では候補が必ず 1 本）ことを (h) か宣言に添えるとよい。

## 確かめたこと

- 6 commit の範囲と変更 file（15 file）、commit の順、HEAD＝`origin/claude/s4-9-pr3`＝`67cf9453`、作業木が clean であること。
- `1dd6fb35` の差分の全体と、今の `utf16RangeSample`（`quality-evidence-items.mjs:186-361`）・`observationIndex`（`:162-184`）・`idMapsOf`（`:57-113`）・`sideOf`（`:123-141`）。
- `relationEndpointsOf`（`quality-verdict-cli.mjs:184-199`）と `relationRowsOf`（`frozen-setup-plan.mjs:723-744`）、`typedRevisionMaterials`・`expectedMaterialPaths`・`resolveEdge`（`material-revision.mjs:39-172`・`:239-290`）、`hashGraphPaths`・`hashEdges`・`hashGraphEvidence` と probe の `row.value`（`cp4-k64-probe.tsx:479-481`）。
- 全凍結 fixture の relation の向きつきの端点（重複 0）と、13 variant の期待する path の Revision（2 hop は G-03/base・G-06/base の 1 Revision だけ）。
- `1fc90060` の試験の差分の全体と、合成の受領書の作り方（`quality-verdict.test.mjs:175-260`）。
- dev gate の受領書 `hd-g03h2` の ID の構造（`dvs3-125` 3 行、`dvs3-126` 2 行。1 つの ID が両方に出る）。
- v3 の §0（:29-40）、§1（:42-50）、§2.0（:54-63）、§2.1（:65-98）、§10（:247-256）。
- `39b89bc3` の差分の全体：`workspace-db.mjs`、`frozen-setup-driver.mjs`、`setup-receipt.mjs`、`test-support.mjs`、試験 2 file。消えた試験の行も読んだ。
- `session.mjs:425-460`、`launcher.mjs:511-564`、`frozen-setup-driver.mjs:2440-2560`・`:2684-2845`・`frozen-k64-run.mjs:278-300`。
- 製品の Rust：
  - `maintenance_lifecycle.rs:1800-1990`（preempt の取消し、完了、失敗と backoff の `next_attempt_at` の形式）
  - `maintenance_runtime.rs:4339`・`:4995-5045`・`:5081-5087`（起動時の復旧、backoff）
  - `incremental_freshness.rs:850-870`・`:2095-2130`・`:3705-3745`・`:1663`（Freshness の `next_attempt_at` と `work_key`）
  - `migrate.rs:6393-6394`（列）
- 設計 `setup-quiesce-design.md` と dev の記録 `setup-quiesce-dev.md` の全文。dev の受領書の `fixture.kind`・`quiesce`・`readBack.maintenance`。
- `fusion-eval-data` の受領書の `signalled`（空 279 個、非空 0 個）。
- 完全な setup の受領書の `readBack.maintenance.running`：
  - s7r1 は凍結 29 個のうち 0 でないのが 1 個（G-03/frontier-exceeded）。
  - backup の凍結は 187 個のうち 1 個（`sp-p4-s5r-1` の G-07/base）。
  - `fusion-eval-data` の dev は 28 個のうち 3 個。
- 正式の入口（`frozen-k64-run.mjs`・`trace-frozen.mjs`・`seed-pin.mjs`）がすべて `assertCompleteSetupReceipt` を通ること。
- ユーザーの回答 `337ff239` の全文と SHA-256。
- S2 の JSON・宣言の文単位の差分の全体。`observation-prep.mjs` の差分の全体。DR-CP4-P-11／S4-11 の追記 2・L-27 の追記・DR-DBC-7 の差分（語単位）。L-24・T-5 の行。
- `K67_LIMIT_WORDS`（86 語）・`S4_PROCEDURE_WORDS`（84 語）が S2 に在ること。validator の読むだけの実行。
- remote の時刻（GitHub の activity）と、`implementationCommit` の一致。

## 未確認

- **試験は回していない**（前例どおり）。次は作者の申告のままである。
  - DR の「1021 件中 pass 1013・fail 8（前回と同じ名前）」
  - 「直す前の実装で 4 つとも食い違う」
  - 「verify:quality は `19c6113c` の tree で成功」
- quiesce の session で、開いた renderer が関連の照会を出すか。出すなら Verify の preempt や C の build が起きるか（開き直しの経路の偽陽性）。
- 製品の will-quit の障壁が、閉じる時に running の maintenance をどう閉じるか。また、`next_attempt_at` が NULL で取り消された run を次の起動で再 dispatch するか（`retryPending` に数えない偽陰性の可能性）。
- 起動時の復旧が実際に作る Attempt の行の実物（コードの読みだけ）。
- requalify（`graph_response::assemble`）が worker の見落としを拾うか（S2 も読んでいないと書いている）。
- 445 file の製品の変更、pin の取り直し、検出力の記録、S4b（いずれもまだ無いか、範囲の外）。
