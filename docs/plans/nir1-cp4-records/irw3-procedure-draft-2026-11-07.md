# CP-4：D＝40 ms 用の正式の手順の新版（依頼文の「DR-IRW-3」）と C7 の設計起案（2026-11-07）

**起案だけ**。コード・S2・S4 の凍結・pin・閾値・Gold・fixture・期待値は変えていない。run・build・cargo もしていない。
ユーザーの決定（2026-11-07）：起案を始める。**凍結と再測定の前にユーザーに確認する**。

## 改訂の履歴

| 版 | 日付 | 中身 |
|---|---|---|
| 改訂 1 | 2026-11-07 | 最初の起案（contracts `3c9a15bd`） |
| 改訂 2 | 2026-11-07 | Opus の敵対的レビュー（P1×2、P2×6、P3×3）を反映。(1) D＝40 ms は CP-4 の合格基準の**緩和**と明記し、変える点 16・K6/4:36・S2 の promotion の規則・台帳の行を引いた。Q1 の既定を (D-b)（新しい draftRef＋台帳の行）に改め、(D-a) でも draftRef／contractId を名指す protocol の形で台帳に記録するとした。T-8 を直した。確認台帳の所在を `nir1-l6-l9-execution-plan.md:257` に訂正した（改訂 1 は `nir1-l6-l9-contract-proposal-7-draft.md:31` を台帳と書いていた。後者は確認済みの契約の定義の行）。(2) HOLD の見込みを、欠落率に既存の欠落が足される点と頻度の幅を入れて約 3〜7 割の幅に直した。(3) p95 の上限：65.04 ms は DR-IRW-3 が上書きの対象に挙げていて据え置く「現行値」が無いこと、Graph arm も 40 ms の窓で変わることを書き、両 arm で書き直した。(4) C7 の外す条件に `querySupported===true` と IR の理由 `index-unavailable` を足し、Graph の値を `graph-unavailable:cancelled` に固定した。(5) E＞0 なら読取の時計の範囲を必須にした。(6) C7 の両面（整列の防御を緩め、数える側を厳しくする）を書いた。(7) 新版は LAPSE-2 の測定（§8.2 の R1）に当たらないとし、Q3 を新しい手順として問う形にした。(8) 変える file の漏れを足し、版の上げ方を draft-3 → S3 → v2 にした。(9)〜(11) G-a の保存範囲の未確認、数えない fetch の begin の扱い、C1（PR #824）入りの dev run と大きい DB の限界を足した |
| 改訂 3 | 2026-11-07 | Fable の最終 pass（P1×2、P2×5、P3×3）を反映。(1) HOLD の見込みに欠落率の上側を入れ、「中心で約 6 割、幅 3〜9 割（既存の欠落が出なければ 1〜7 割）」に直した。(2) C7 を入れない側の帰結（1％ 一定なら 200 cycle の run が無効になる確率 約 87％）を §1.3 (d) と Q3 に足した。(3) Q1 の各案の帰結を書いた。(4) L1 の「根拠が残っていない」を「製品側の記述だけ上書き。P の評価では今も計算値」に直し、Q2 に p95 は正式の合否に入らないことを添えた。(5) T-10・Q3 を「LAPSE-2 が許す唯一の経路 R0〜R8 の R1 を満たせないので例外を求める」に直し、C1 入りの候補は製品を変えた候補であることを書いた。(6) Q4 に C1 を進める決定の出典を足した。(7) 各問に所要の目安を足した（§5.1）。(8) 台帳 :536、残レーン外で委任が無いこと、`K64_FREEZE` の置換と `receipt.mjs` の確認を足した |

- 読んだ基点：製品 repo の `1822b192`（#823）を `git show 1822b192:<path>` で読んだ。contracts は `claude/nir1-contracts`。
  以下の `file:line` は、断りが無ければ `1822b192` の行。contracts の file は「contracts」と書く。
- 書き方：**事実**（file と記録で確かめたこと）、**推測**（推論。確かめていない）、**文書に無い**（どの記録にも書かれていない）を分ける。

## 0. 呼び名と ID の注意

- 依頼文と `cp4-decisions.md:1364` は、この手順の新版を「DR-IRW-3」と呼ぶ。ただし `irw-decisions.md:26` の **DR-IRW-3 は「この変更が上書きする確認済みの記述」の行で、状態は「記録済み」**。手順の新版を予告しているのは同じ file の §3（`irw-decisions.md:31`）である（事実）。
- 混同を避けるため、判断の ID を新しく振る案を置く（採否は integrator が決める）：
  - DR-CP4-P-9：S2 追補 #14（D＝40 ms、C7、必要なら G-01 相当）。最新の追補は #13（`565a1115`）、最新の P は P-8（事実）。
  - DR-CP4-S4-9：S4 の 6 回目の凍結（S4b → b′ → b″ → b‴ → b'''' の 5 回。`cp4-decisions.md:1254` の (7)「S4 の凍結は 5 回」）。
  - DR-CP4-C7-1：C7 の規則そのもの。
- 依頼文は `alignSeededBegins` を `followup.mjs` にあると書くが、定義は `scripts/quality/nir1-graph-eval/trace-record.mjs:605`（事実）。`followup.mjs` にあるのは D の検査（`:494-498`、`:697-701`）。

## 1. 目的と範囲

### 1.1 目的

1. CP-4 の正式の手順（S2〔`evals/nir1-graph/observation-prep.v1.json`〕、凍結 S4b'''' `3734e501`）を、製品の D＝40 ms（DR-IRW-1・2、#802）に合わせる。今の手順は D＝10.84 ms に結び付いていて、D＝40 ms の候補では測れない（事実：`irw-decisions.md:31`。dev の診断 run 1・2 は集計の段の `[precheck]`〔N-7 の疑い。`join.mjs:96-101`〕で止まった）。
2. C7：Chronicle の Index が使えない begin（native の record を作らない）があると trace の対応が壊れて run ごと無効になる欠陥を直し、K6/2 の規則 3 の (i) のとおり `i-chronicle-stop` として数える。
3. G-01 相当（PUB-G #16、決定 (C)）を次の正式 run に組み込むかを決める材料を出す。

### 1.2 D＝40 ms への追随

#### (a) 変わる箇所（事実）

| 箇所 | 今 | 新版の案 |
|---|---|---|
| `scripts/quality/nir1-graph-eval/constants.mjs:9-10` の `GRAPH_EVAL_D_MS` と注記（「D = min(100 ms, 0.20 * B), B = 54.2 ms. Confirmed; never recomputed.」） | 10.84 | 40。注記は「DR-IRW-1 の固定値。式からは導かない」に直す |
| 手順の file（`procedure/k64-procedure.v1.json` の `values.dMs`。`procedure-file.mjs:62-68` が constants と一致を求める） | 10.84 | v1 は残す。S2 の promotion の規則（`observation-prep.v1.json:362-364`）のとおり **draft-3 を置き → S3 の独立レビュー → v2** の順で上げる（同じ版の書き直しはしない） |
| S2 の `k64Procedure.values.dMs` と `valueReasons.dMs`（`observation-prep.v1.json:337` 付近。理由は「P の固定契約で K6/4 の変えないもの。作者は選んでいない」） | 10.84 | 40。理由は DR-IRW-1 と、§3 の確認の結果 |
| S2 の `registeredForReview` の `BOUNDARY_TOLERANCE_MS` の注記（`observation-prep.v1.json:366-372`。「製品が D = 10.840000000596048 ms で比べる」） | 10.84 の float の差 | 40 での差に書き直す（推測：40 は浮動小数で正確に表せるので差は 0。許容の値 0.01 ms は変えない） |
| `hook-check.mjs:38-40` の注記 | 10.840000000596048 | 注記だけ直す（値は constants から読む） |

D を読むのは constants の 1 箇所だけで、`join.mjs:76`（窓内の判定）、`followup.mjs:497`（親の窓が D であること＝批准 12／N30）、`followup.mjs:699`（子の IR の deadline が D を超えない）、`k64-record.mjs:438`、`run-sample.mjs:433`、`trace-record.mjs:1098`、`procedure-file.mjs:64` は値を import するだけ（事実）。手順の版の名前を直書きしている箇所は §2.1 に挙げた。

#### (b) **D＝40 ms は CP-4 の合格基準の緩和に当たる**（事実と判定）

- `join.mjs:76` の窓内の判定 `arrivedAt ≤ t_raw_ready + D` で D を広げると、**窓内に数える側が広がる**。K6/4 の下では表示の可用性＝「D の窓内か follow-up の成功」なので、表示ありに数える経路が広がる（K6/4 の「変える点」1〜3、contracts `nir1-final-request-eval-proposal-4-draft.md:29`）。子の IR の deadline（子の Raw-ready ＋ D。K6/4:53 の「変えないもの」）も 40 ms に広がる。
- 確認済みの手順はこの種の変更を次のように縛る（事実）：
  - K6/4 は確認台帳の確認済みの行（`docs/plans/nir1-l6-l9-execution-plan.md:257`、confirmedRef `nir1-final-request-eval-proposal/4#graph-eval-procedure`）。
  - K6/4 の「変える点」16（proposal-4:110）：観測の後の変更は T_late・W_f・T_show・F1〜F7・X1〜X13・R1／R4 の待ちを**狭める方向だけ**、「**広げる変更は新しい draftRef でだけ行う**」。
  - K6/4:36（許さないもの）：「最初の表示の D の値の変更」。K6/4:8・:53・:184・:210 も D＝10.84 ms を変えないとする。
  - S2 の promotion の規則（`observation-prep.v1.json:364`）：「観測の後の変更は、狭める方向だけを新しい版とレビューで許す（K6/4 変える点 16）」。
  - 確認台帳には DR-IRW が反映されていない（事実：`nir1-l6-l9-execution-plan.md` に DR-IRW の言及は無く、`:437`・`:536`・`:768`・`:781` は P の D＝10.84 ms・上限 65.04 ms を維持すると書く。`:536` は P の値について「これらを変えるには、従来どおり個別の確認を要する」）。
- 判定：D は「変える点」16 の列挙（T_late ほか）には名指しされていないが、窓内を広げる変更で、K6/4:36 が D の変更そのものを許さない。したがって **CP-4 に D＝40 ms を当てることは、確認済みの合格基準の緩和で、委任の外**。DR-IRW（製品の閾値の緩和、ユーザー承認）は製品の窓についての承認で、CP-4 の評価の契約と台帳まで及ぶかは記録されていない（文書に無い。`irw-decisions.md:3-4`・`:31`）。
- 推測：親が D の内に合流する sample が増え、follow-up（F1〜F7、親が保留→子が `Cached`）の形にならない sample が正式の G-case で初めて多く出うる。K6/4 は窓内を表示ありと読むので定義は変わらないが、dev の予行（§4 の 5）で R1〜R4 と F2 の counter の差分の読みが崩れないかを確かめる。
- 変えないもの：失効率・窓外率・欠落率の物差し（1％、201 件なら許容 2 件）、W_f 100 ms、T_late 100 ms、T_show 2 s、lease 100 ms。

#### (c) p95 の上限 `B+D`（**上限を決める記録が無い。要確認**）

- 事実：P の retrieval manifest（`evals/nir1-retrieval/manifest.json` の `performance.warm`）は `B = Raw-only p95`、`D = min(100ms, 0.20*B)`、`hybridP95Limit = B+D`。K6/4:53 は「P の B=54.2 ms、上限 65.04 ms（B+D）」を、K6/4:210 は「P の Hybrid p95」を変えないとする。
- 事実：DR-IRW-3（`irw-decisions.md:26`）は「L0 の P の固定値『D=10.84 ms、**上限 65.04 ms**』」を上書きの対象に挙げる。**上書きの後の上限は書かれていない**（文書に無い）。したがって 65.04 ms を「据え置く現行値」とは言えない。
- 事実：CP-4 の正式の手順（S2）は p95 を判定しない。p95 を当てているのは手順外の補助の記録 DR-CP4-QV-1（`cp4-decisions.md:1338`）だけで、**Graph arm と R+IR arm の両方**が上限以下のときだけ pass（同 `:1343` の定義の要点）。s5r6 は R+IR arm 55.30 ms・Graph arm 31.50 ms、上限 65.04 ms で pass（`:1350`）。
- 事実：QV-1 の `deriveLatencyPolicy`（`quality-verdict.mjs:68-93`）は **B を D から逆算する**（`b = dMs / coefficient`）。`GRAPH_EVAL_D_MS` を 40 にすると、そのままでは B＝200 ms、上限＝**240 ms** になる（`quality-verdict-cli.mjs:242`）。B の意味（実測の Raw の p95）を壊す大きな緩和が黙って起きる。
- 推測：両 arm とも D＝40 ms で上がりうる。R+IR arm は IR を最大 40 ms 待つ（最大で約 29 ms 増）。Graph arm も、親の合流の窓が 40 ms に広がる（DR-IRW-2）ので、Graph を待って返す sample が増えれば親の `tReturn` が延びる。s5r6 の余裕は R+IR arm で約 10 ms。
- 選択肢：

| 案 | 上限 | 性質 | 備考 |
|---|---|---|---|
| L1 | 65.04 ms（B＝54.2、D は旧の 10.84） | 前の確認済みの値と同じ。DR-IRW-3 が上書きしたのは製品側の記述だけで、P の評価（`scripts/quality/nir1-retrieval`）は今も fixture の B から D＝10.84・上限 65.04 ms を計算する（`irw-decisions.md:32`「製品の定数と比べる箇所は無い」）。P の評価では今も現行の計算値 | 製品が許された待ち（40 ms）を使うと、両 arm とも落ちうる**厳しい側の値**。QV が hold になりうる |
| L2 | 94.2 ms（B＝54.2 ＋ D＝40） | manifest の式に B の確認済みの値と新しい D を入れた値。前の確認済みの値（65.04）より**緩い** | 委任の外。ユーザーの確認が要る |
| L3 | 240 ms（今の code に D＝40 を入れた値） | **大きい緩和** | 推奨しない。B の意味が変わる |

- 起案者は推奨を置かない（L1 は P の評価の計算値と同じだが、製品の待ちに対しては厳しい値。L2 は緩和）。p95 は CP-4 の正式の合否に入らず、手順外の補助の記録 QV-1 だけが使う。どの案でも、QV の code は B を manifest の式から逆算せず、P の確認済みの値（54.2 ms）を読むように直す（QV の file は pin の外。§2）。

### 1.3 C7（Chronicle が止まった begin を対応から外し、(i) として数える）

#### (a) 事実（contracts `diag-lpd-2026-11-02/chronicle-late-publish-2026-11-07.md` の §3.1・§3.2・§9.3 と code）

- begin は最初の読みで snapshot が使えなければ IR の operation（ticket）を作らない。IR の理由は、profile が supported なら `index-unavailable`、`NirQueryStatusRead::Unavailable` なら `unsupported-query`（`electron/native/grimodex-node/src/related_scenes/begin.rs:103-120`）。Graph は lease が無いと `begin_graph` が owner に触れない（`begin.rs:156-175`）。**native の eval sample record は作られない**。renderer の結果は `graph-unavailable:cancelled`（名前は cancelled だが、取消しではない。§3.1 の 3）。
- `index_usable` が false になる理由は Chronicle の publish の遅れに限らない。proof が current でない理由（runtime の epoch、Freshness が canonical でない、binding の dirty、roster など。`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index/canonical.rs:56-120`）のどれでも立つ（事実）。
- 今の harness は、seed つきの begin の数 N が record の数 M より多いと対応を取りやめ（`trace-record.mjs:635-636`）、全行が defect row（`:1306-1313`）、受領書は invalid になる。S2 の読み TP-1（`observation-prep.v1.json:282`）も「M < N は整列の失敗」と定める。
- dev の 6 run で 12／1,200（1.00％、Wilson 95％ 0.57〜1.74％）。run 3〜6 はすべて aligned=false（206／208／205／202 の begin に対し record 202／202／204／201）。`indexUsable=false` の親は 12 件すべてで、(a) の形以外では 0 件。OFF（native と renderer の時計の差）に依らない数え方でも同じ数（§9.3）。
- K6/2 の規則 3：「Chronicle の Index が止まる間は … 失効率の (i)（index の再 build 待ち）として数え、承認の失効と分けて記録する」（contracts `nir1-final-request-eval-proposal-2-draft.md:211`）、「(i) は B の seal によるものと Chronicle の停止によるものに分けて記録する」（同 `:84`）。harness はすでに `irOutcomeOf`（`run-sample.mjs:231-234`）と `lapseKind`（`join.mjs:126-133`）で `i-chronicle-stop` を持ち、`snapshotOf` は Chronicle を U の条件に入れない（`run-sample.mjs:210-224`、P2-4）。**数える側の規則はあるのに、対応の段で run が無効になるので、そこまで届かない**。

#### (b) 規則の案（DR-CP4-C7-1）

1. **外す条件**（すべてを満たす begin だけ）：trace の seed つきの begin で、その begin を出した fetch（`ownerOf`）の結果が
   - `initialSnapshot.indexUsable === false`（厳密に boolean の false）、
   - `initialSnapshot.querySupported === true`（`unsupported-query` を外さない）、
   - IR が unavailable で理由が `index-unavailable`（probe の `irStatus`・`irReason`。`renderer/cp4-k64-probe.tsx` の `summarize` が残す。`cp4-trace-probe.tsx:27` が import）、
   - `graphOutcome === "graph-unavailable:cancelled"`。
   どれかが欠落・null・違う値なら外さない（fail closed。外さなければ今と同じく対応の失敗になる）。
   - `graph-unavailable:cancelled` だけでは外さない（本当の取消し〔`index-ready` の世代の取消し〕は begin が通っていて record がある）。
   - ticket が `capacity` で作られなかった begin（`begin.rs:145`、IR の理由 `capacity`）も record を作らない見込み（推測）だが、外す条件に入らない。起きれば今どおり対応の失敗になる（fail closed）。
2. **数える範囲**：外した begin の Chronicle の停止の理由（epoch、Freshness、binding、roster、publish の遅れ）は renderer の値からは区別できない。K6/2 の規則 3 は「Chronicle の Index が止まる間」を理由で分けないので、どの理由でも (i) の `i-chronicle-stop` に数える。理由が区別できないことを開示する。
3. **対応**：外した begin の数を E とし、残りの N−E 件の begin と M 件の record に、今の規則（M＝N の一対一、M＞N の V-2 の末尾除外、V-3 の時計の範囲の交わり、`native.lost`）を**そのまま**当てる。さらに **E＞0 のときは、Native の読取の時計の範囲（`readClock`）を必須にする**。今の code は M＝N のとき読取の範囲が分かる場合だけ時計の検査を走らせる（`trace-record.mjs:638`）が、E＞0 で読取の範囲が求められなければ整列の失敗にする（fail closed）。
4. **行**：外した begin が counted query の親のとき、その query は defect row ではなく、record の無い行（`nativeBegin: null`）として作る（DR-CP4-V-3 の `cancelledParentRow`〔`trace-record.mjs:911-1023`〕と同じ型。ただし begin は出ている）。
   - B の状態は開始時の封印で読む（record が無いので `snapshotOf` は既定で usable を返す〔`run-sample.mjs:217-224`〕。trace の行は開始時の封印を併せて求める〔`trace-record.mjs:1423` の `usable: row.snapshot.usable === true && seal.state === "current"`〕）。B が current でなければ規則 3 の順のとおり `i-b-seal` が先（`join.mjs:127-131`）。
   - `irOutcome` は `index-unavailable`、`lapseKind` は `i-chronicle-stop`。Q と U に入り、**失効率の分子に入る**。表示されなかったので、K6/4 の (b) の読み（`followup.mjs:772` の `followUpFailureCategory`）で category `lapse` として**欠落（窓外）にも入る**（`availability.mjs:653-656` の K6/2 の読みでも、窓内でない U の query は category ごとに数えられる）。
   - 子（follow-up の再 query）の begin が外れる場合の分類は**文書に無い**。案：子の begin も同じ条件で対応から外し、follow-up の失敗の段の理由として記録する（分類の段と code は実装の試験で固定し、S3 で確かめる）。
5. **数えない fetch の begin**：`alignSeededBegins` は counted query の親・子に限らず、seed つきの fetch の begin をすべて対応の列に入れる（`trace-record.mjs:607-610`）。requery（`trace-record.mjs:941`）、混在の窓の fetch、cycle の終わりの後の fetch（DR-CP4-V-4）の begin が外す条件を満たせば、同じく対応から外す（外さないと 1 つずれる）。これらは Q・U・失効・欠落に入れない（もともと counted query ではない）。開示には「counted でない」と印を付ける。V-4 の開示と混在の検査（`requeryAfterCycleEndOf` など）は今どおり。
6. **開示**：受領書の `native.alignment` に `excludedChronicleStop`（件数 E、begin の id・seq、fetch の seq、`calledAt`、`graphOutcome`、`irReason`、counted の親か子か counted でないか）を足す。`lapseIBreakdown`（`trace-record.mjs:1784-1793`）の `i-chronicle-stop` に件数が出る。

#### (c) 誤って外す危険と防ぎ方

| 危険 | 防ぎ方 | 残るもの |
|---|---|---|
| `indexUsable=false` なのに record がある begin を外す（Native の挙動が今の code と違う場合）→ 1 つずれた対応 | (1) 外した後の N−E と M に今の件数の規則を当てる（M＜N−E なら失敗）。(2) V-3 の時計の範囲（組の範囲と Native の読取の範囲の交わり。`trace-record.mjs:599-604`）は 1 つずれた対応を捕まえる（DR-CP4-V-3 の P2-2）。E＞0 では読取の範囲を必須にする（(b) の 3）。(3) 外す begin の renderer の値を `graph-unavailable:cancelled`・`index-unavailable`・`querySupported===true` に固定する（(b) の 1） | Native の record に「Chronicle が止まった」の印が無いので、record が**無いこと**を直接は確かめられない（限界。印を足すのは Native〔評価 feature〕の変更で、C7 の範囲の外） |
| Graph の欠陥を Chronicle の停止として隠す | Graph は lease（＝IR の ticket）が無いと `begin_graph` が owner に触れない（`begin.rs:156-175`）。外す begin は ticket が無い begin だけなので、Graph が走って失敗した begin を外す経路は見当たらない（事実：code の読み） | — |
| 別の理由で record が欠けた begin と、外した begin が打ち消し合う | (1) の件数と (2) の時計の範囲。`native.lost` の検査は今のまま | 偶然すべて満たす並びは区別できない（推測：起きにくい） |
| `indexUsable` などを読み違える（probe の summarize の変更など） | probe は pin の対象（`s5a-graph-arm-runner` の `renderer/cp4-k64-probe.tsx`）。型が違えば外さない | — |
| 外すことで失効を見えなくする | counted の query は Q・U・失効の分子・欠落の分子に必ず入れ、件数を受領書に出す。合成の記録で検出力を示す（K6/4:209「CP-4 の分類器は、受入れの Negative の合成の記録で検出力を示してから使う」） | — |

試験の案（実装の段で）：外す begin が 0／1／複数、親だけ／子だけ／counted でない fetch だけ、`indexUsable` が null、`querySupported=false`（外さない）、IR の理由が `capacity`（外さない）、外した後に M＜N−E、E＞0 で読取の範囲が無い（失敗）、1 つずれた対応（V-3 で落ちる）、B が dirty で `i-b-seal` が先になる場合、`graph-unavailable:cancelled` だが `indexUsable=true`（外さない）。K6/4 の検出力の記録（contracts `k64-synthetic-detection-record.md`、前回 611 件 pass）は C7 の例を足して取り直す。

#### (d) C7 の両面

- **緩める面**：TP-1 は「M < N は整列の失敗」で、record の数が足りない trace を丸ごと無効にする fail closed な防御である。C7 は条件つきでこの防御を緩め、record の無い begin を残したまま対応を取る。誤って外したときの害（1 つずれた対応）は (c) の防御で抑えるが、record が無いことを直接は確かめられない。
- **厳しくする面**：今は、この形が 1 件でも起きた run は無効になり、取り直しで「起きなかった run」が選ばれうる（推測：緩い側の偏り）。C7 はその偏りを除き、起きた件を失効と欠落に数える。物差し（1％、2 件）・Q・U・失効の定義は変えず、K6/2 の規則 3 の文面どおりに数える。
- **C7 を入れない場合の帰結**（推測。計算）：頻度が 1％ で一定なら、200 cycle の trace の run に 1 件以上起きて無効になる確率は 1−0.99^200≈**約 87％**（有効な run は約 13％）。取り直しを繰り返すことになり、残るのは「起きなかった run」だけで、その選び方そのものが緩い側の偏りになる。dev では 6 run 中 4 run が無効だった（contracts `chronicle-late-publish-2026-11-07.md` §9.7）。
- どちらにせよ S2 の読み TP-1 の文面を変える手順の改訂なので、ユーザーの確認が要る（contracts `chronicle-late-publish-2026-11-07.md` の §6 の C7 の行と同じ見立て）。

#### (e) C7 を入れると HOLD になりうる（推測。計算）

- 前提：dev の頻度（12／1,200）が正式の trace でも同じで、件数が Poisson に従う。物差しは「201 件で 2 件を超えたら HOLD」。C7 で数えた件は失効率と欠落率の**両方**に入る。

| 前提 | 失効率で HOLD（3 件以上） | 欠落率で HOLD |
|---|---|---|
| 頻度 1.00％（λ≈2.01） | 約 33％（P(X≥3)＝0.326） | s5r6 の欠落 1 件が再び出るなら、あと 2 件で HOLD：約 60％（P(X≥2)＝0.597）。既存の欠落を平均 1 件として Poisson(3.01) で見ると約 58％ |
| Wilson の上限 1.74％（λ≈3.50） | 約 68％ | 既存の欠落 1 件があれば約 86％（P(X≥2)＝0.864） |
| Wilson の下限 0.57％（λ≈1.15） | 約 11％ | 既存の欠落 1 件があれば約 32％（P(X≥2)＝0.319） |

- まとめ：C1 が無ければ、どちらかの指標で HOLD になる見込みは**中心で約 6 割、幅 3〜9 割**（s5r6 の欠落 1 件のような既存の欠落が出なければ、失効率と同じく 1〜7 割）。dev の値は dev fixture・dev build のもので、正式の trace の拍子とは違う（§9.7 の「言えない」の (3)）。C1 が入れば下がる見込み（推測。C1 の効果は未測定。§4 の 5）。
- DR-CP4-LAPSE-3：物差しを満たせないときは HOLD のまま設計に戻り、物差しを緩和しない。C7 を入れて HOLD になっても、物差しは変えない。

### 1.4 G-01 相当（PUB-G #16 の決定 (C)）

- 事実：DR-PUBG-16-1（`cp3a-decisions.md:74`）は案 (C) の第一段＝(A)（dev fixture）で、lease 越しの end-to-end に 3 回到達。contracts `nir1-pubg-records/pubg-16-e2e-2026-11-07/README.md` の「限界」に「G-01 相当の確認は CP-4 の次の正式 run に組み込む（決定 (C)）」。設計起案（contracts `pubg-16-e2e-design-draft.md:31`）は (C) の後続について「正式 run の追加分は別の確認」、問い 3（`:72`）は「CP-4 の次の正式 run に組み込むか、PUB-G の前提と切り離すか」。**問い 3 への回答の記録は文書に無い**。
- 事実：G-01 の正式の受領書には Graph-only の行があるが continue は cancelled（contracts `gold-s5r6-1/G-01_v1.receipt.json:1262`・`:1357`。設計起案 `:23` の引用）。`dprime-check` の `heldSample` は凍結素材を拒む（`admission.mjs:706`。同 `:23`）。
- 組み込む場合に要るもの（推測）：(1) admission に新しい purpose か、凍結素材を許す経路（`admission.mjs` は pin〔`s4-rehearsal-admission`〕。DR-PUBG-16-1 は「新しい purpose を足すと admission の変更になる」と書く）、(2) runner（`pubg16-e2e-run.mjs` は今は pin の閉包の外。正式にするなら `FORMAL_HARNESS_ENTRIES`〔`scripts/quality/nir1-graph/observation-prep.mjs:859-865`〕に入れ、pin する）、(3) click（`nir1_evidence_qualify`）は Native の `keep_click` の entry を作るので、Gold・parity の測定と同じ session に混ぜない（別の診断 run にし、`countsInCaseJudgement: false`）。
- **未確認の点**：click の `keep_click` が DB に書くか（memory だけか）は文書に無い。DB に書くなら、正式の run の workspace に新しい種類の行が残り、**保存範囲の拡大**（委任の外）の候補になる。G-a を選ぶ前に read-only で確かめる。
- 案：

| 案 | 中身 | 凍結 | 確認 |
|---|---|---|---|
| G-a | 同じ S2 追補 #14・6 回目の凍結に、G-01 の凍結素材での end-to-end を**診断の run**として入れる（判定に数えない。合格基準は到達の有無） | 6 回目の凍結に同梱（凍結は 1 回で済む） | 要（admission の変更＝新しい authority の候補、正式 run の追加、`keep_click` が DB に書くなら保存範囲） |
| G-b | CP-4 から切り離し、PUB-G の lane で別に扱う（G-01 の素材の写しで dev として通す等） | 触れない | 要（決定 (C) の読み替え） |
| G-c | 今回は入れず、次の凍結のときに考える | 触れない | 不要（ただし PUB-G #16 の G-01 相当が残る） |

- 起案者の見立て：凍結を 1 回で済ます点では G-a が有利。ただし admission の変更と `keep_click` の書込み先が未確認で、手順の改訂の範囲が広がる（レビューと確認の負担が増える）。G-b・G-c は CP-4 の改訂を D と C7 に絞れる。**推奨は置かず、`keep_click` の書込み先を確かめてからユーザーが選ぶ**。

## 2. 変える file と変えないもの

### 2.1 変える file（実装の段。今回は何も変えていない）

| file | 変える中身 | pin の対象か（事実） | 凍結への影響 |
|---|---|---|---|
| `scripts/quality/nir1-graph-eval/constants.mjs` | `GRAPH_EVAL_D_MS` 40 と注記 | はい（`SOURCE_PINS` の `g4-b1-freeze-v2-constants` `d06f080e`） | pin のし直し |
| `scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-3.json` → `k64-procedure.v2.json`（新規。v1・draft-2 は残す） | `values.dMs` 40、`review` は S3 の記録 | `observation-prep-freeze.v1.json` の `boundFiles`（今は v1 の sha256 `1c2428df…`） | 束縛のし直し |
| `scripts/quality/nir1-graph-eval/frozen-k64-admission.mjs:46` | `FORMAL_PROCEDURE_VERSION = "v1"` → `"v2"` | はい（S2 追補 #12 で移った pin。`observation-prep.mjs:645-` の注記） | pin のし直し |
| `scripts/quality/nir1-graph-eval/procedure-file.mjs` | (D-b) なら contract の draftRef・sha256 の照合先を新しい draftRef にする。(D-a) で DR-IRW の記録を束縛する key を足すなら schema の版を上げる（`TOP_KEYS` が固定。`:53-61`） | `HARNESS_FILES`（`k64-runner.mjs:334-`）に入る。どの pin が持つかは実装の時に `harnessPinOf` で確かめる | 変えれば pin のし直し |
| `scripts/quality/nir1-graph-eval/constants.mjs:56-65` の `K64_FREEZE` | (D-b) なら新しい draftRef（`/5`）の凍結（path・sha256・draftRef・confirmedCommit・freezeCommit）を足すか置き換える。`receipt.mjs`（pin `t14-k64-freeze`）は `K64_FREEZE` を import する側なので、置換しても `receipt.mjs` の bytes を変えずに済むかは実装の時に確かめる（変えるなら pin のし直し） | 同上（constants.mjs） | 同上 |
| `scripts/quality/nir1-graph-eval/trace-record.mjs` | C7（`alignSeededBegins` の前処理、record の無い親・子の行、数えない fetch の begin、開示） | はい（`v4-trace-record-requery` `527589b6`） | pin のし直し |
| `scripts/quality/nir1-graph-eval/followup.mjs`・`availability.mjs` | C7 の子の分類を変える場合だけ | `followup.mjs` は pin（`v4-followup-cancelled-match`）。`availability.mjs` は `HARNESS_FILES` に入る | 変えれば pin のし直し |
| `scripts/quality/nir1-graph-eval/hook-check.mjs` | 注記だけ | 診断用（formal の閉包に入るかは実装の時に確かめる） | — |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs`・`quality-verdict-cli.mjs` | p95 の B の出し方（§1.2 (c)）、`quality-verdict-cli.mjs:37-38` の `PROCEDURE_FILE`（v1 の path を直書き）と `:253` の D の照合 | **いいえ**（DR-CP4-QV-1：pin 一覧・`HARNESS_FILES`・`FORMAL_HARNESS_ENTRIES` の閉包のどれにも入らない） | なし（手順外の補助） |
| 試験（`trace-record.test.mjs`、constants・procedure-file・frozen-k64-admission の試験、C7 の合成の例） | 追加・更新 | 試験は pin の対象外（`SOURCE_PINS` は非試験の file を持つ） | なし |
| `evals/nir1-graph/observation-prep.v1.json`（S2） | **S2 追補 #14**：`k64Procedure`（draft-3・values・valueReasons・formal を v2 へ）、TP-1 の読み（C7）、`registeredForReview` の注記、`setupReadings.source.pins` の bytes、開示（観測の後の改訂で緩和を含むこと、DR-IRW と §3 の確認、C7 を dev の観測で見つけたこと） | S4 の凍結が束縛 | S2 追補 #14 |
| `scripts/quality/nir1-graph/observation-prep.mjs` | `SOURCE_PINS`（上の file を持つ pin の commit）、`:393` の `PROCEDURE_V1`（v1 の path）、`:1548-1549` の placeholder（`k64-procedure-v1-commit`・`k64-procedure-v1-sha256`）を v2 へ、G-a なら `FORMAL_HARNESS_ENTRIES` | 凍結の検査そのもの | 同上 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | **6 回目の凍結**（S4a／S4b の新しい版。`boundFiles` の sha256） | — | S4 の 6 回目 |
| (D-b) の場合：contracts に新しい draftRef の文書と凍結の記録、確認台帳 `nir1-l6-l9-execution-plan.md` に行を足す | 契約と台帳 | — | 凍結の順序は K6/4:317 と同じ形 |
| G-a の場合：`admission.mjs`（pin `s4-rehearsal-admission`）、`pubg16-e2e-run.mjs`、`renderer/cp4-harness.ts`（pin `s5b-diagnostics-wiring`） | 凍結素材での end-to-end の経路 | はい／いいえ／はい | 同上 |

- 手順の記録：pin は「その file を最後に変えた master の commit」が持つ（`observation-prep.mjs:480-484` の注記）。これまでの S4 の PR は merge commit で取り込み、squash しない（`:581-582`、`:599-600` の注記）。新版も同じにする。
- `v1` を直書きしている箇所は上の 4 つ（`frozen-k64-admission.mjs:46`、`observation-prep.mjs:393`・`:1548-1549`、`quality-verdict-cli.mjs:37-38`）を確かめた。実装の段で `git grep "k64-procedure.v1\|\"v1\""` で漏れを確かめる。

### 2.2 変えないもの

- Gold、G-case の fixture（`evals/nir1-graph/freeze.v2.json`、`evals/nir1-g01/fixture.v1.json`、G-04 v2）、期待値、seed の pin、trace の file（`trace-editing.v1.json`・`trace-browsing.v1.json`）。
- 物差し（1％）、Q と U の定義、失効の読み（K6/2 の読み・K6/4 の読み）、W_f・T_late・T_show・lease・`BOUNDARY_TOLERANCE_MS`、`receipt.mjs`（pin `t14-k64-freeze`）。
- K6/2・K6/4 の bytes（(D-b) は K6/4 を書き換えず、新しい draftRef を足す）。製品のコード（C1 は別の lane）。
- p95 の上限は、ユーザーが §1.2 (c) で選ぶまで決めない。

## 3. 確認済みの契約・規則に触れる点と、確認の要否

AGENTS.md の委任の外：秘密・データの新しい送信先、**保存範囲の拡大**、**閾値の緩和（確認台帳の現行閾値と Gold の緩和・黙示変更）**、製品公開、製品認可の削除、**新しい契約・authority**。また CP-4 は AGENTS.md が列挙する NIR-1 の残レーン（C-resource ほか）に入っていない（事実）ので、技術判断の事前委任も無い。下の表で「不要」とした T-6・T-7・T-12 は、委任ではなく、ユーザーの指示（2026-10-25「確認は重要な変更だけ」）に依る判定である。台帳は P の値（B=54.2 ms、D=10.84 ms、上限 65.04 ms）について「これらを変えるには、従来どおり個別の確認を要する」と書く（`nir1-l6-l9-execution-plan.md:536`。T-1・T-3・T-4 の根拠）。

| ID | 触れる記述 | 中身 | 確認が要るか（起案者の判定） |
|---|---|---|---|
| T-1 | K6/4:8、:36（許さないもの「最初の表示の D の値の変更」）、:53、:184、:210。確認台帳 `nir1-l6-l9-execution-plan.md:257`（K6/4 の確認済みの行） | CP-4 の判定に D＝40 ms を使う | **要。合格基準の緩和**（§1.2 (b)）。DR-IRW-3 は上書きを記録したが、ユーザーの回答は製品の窓への回答で、CP-4 の契約と台帳に及ぶかは記録されていない |
| T-2 | K6/4:53「子の IR の deadline（子の Raw-ready + D）」 | 40 ms になる | T-1 と同じ確認に含める（緩和） |
| T-3 | 確認済みの契約の定義 `nir1-l6-l9-contract-proposal-7-draft.md:31`（「窓外率は … 最終 request の窓（D=10.84 ms。K6/2）」）と、台帳の P の行（`nir1-l6-l9-execution-plan.md:437`・`:536`・`:768`・`:781`） | 定義の D と台帳の P の値が変わる | **要**（確認台帳の現行閾値の変更。DR-IRW-3 の上書きの列挙〔(1)〜(3)〕にこれらの行は無く、台帳にも DR-IRW の記録が無い） |
| T-4 | P の上限 65.04 ms（K6/4:53、:210、`nir1-dsn-2026-10.md:13`、`evals/nir1-graph/README.md:211`、`irw-decisions.md:26` の上書き） | p95 の上限 | **要**。上書きの後の値が決まっていない。L2・L3 は前の確認済みの値より緩い（緩和）。L1 も根拠を新しく決めることになる |
| T-5 | S2 の TP-1「M < N は整列の失敗」（`observation-prep.v1.json:282`） | C7 | **要**（整列の防御を緩め、数える側を厳しくする手順の改訂。§1.3 (d)。ユーザーの決定どおり凍結の前に確認） |
| T-6 | K6/2 の規則 3 (i)（contracts proposal-2:84、:211） | C7 はこの文面に合わせる | 文面は変えない。不要 |
| T-7 | K6/4:209（検出力の記録） | C7 の例を足して取り直す | 狭める防御。不要（K6/4 の N の番号は増やさず harness の試験として足す） |
| T-8 | K6/4 の「変える点」16（proposal-4:110。広げる変更は新しい draftRef でだけ）、K6/4:248 の N17、S2 の promotion の規則（`observation-prep.v1.json:364`。観測の後の変更は狭める方向だけ） | 手順の v2 は観測の後の、窓を広げる変更 | **要**。改訂 1 の「D は N17 の列挙に無い」は過小評価だった。D は名指しされていないが、変える点 16 と S2 の規則は「広げる変更」を新しい draftRef に限り、K6/4:36 は D の変更を許さない。したがって手順の新しい版とレビューだけでは足りず、T-9 の契約の手続きが要る |
| T-9 | K6/4:307（推奨と違う選択は新しい draftRef で起案する）、台帳の Confirmation protocol（l6-l9:247）、K6/4:315-317（台帳の行と凍結の順序） | T-1・T-8 の形 | **要**。**既定は (D-b)**：K6/4 の D（と子の IR の deadline）の行だけを変える新しい draftRef（例 `nir1-final-request-eval-proposal/5#graph-eval-procedure`）を起案し、draftRef と contractId を名指すユーザーの明示の承認で確認し、台帳 `nir1-l6-l9-execution-plan.md` に行を足す（**新しい契約**）。代案 (D-a)：DR-IRW-3 の上書きを CP-4 にも及ぼす確認を取るが、その場合も protocol の形（`nir1-final-request-eval-proposal/4#graph-eval-procedure` と DR-IRW-1〜3 を名指す承認の逐語、日時、範囲）で台帳に記録する。どちらも、記録の前に S2 追補・凍結に進まない |
| T-10 | DR-CP4-LAPSE-1・2（追加の正式な再測定はしない。製品を変えるときだけ設計草稿 §8.2 の R0〜R8 で測る） | 再測定 | **要（例外）**。LAPSE-2 が追加の正式な再測定に許す唯一の経路は §8.2 の R0〜R8 で、その R1 は「再測定の前に、閾値・Gold・pool・δ・F6／X5・読み・契約・S4 を変えていない」を DR に書くことを求める（事実：設計草稿 `4b78099a`）。新版は読み〔TP-1〕・契約〔D〕・S4 を変えるので R1 を満たせない。したがって LAPSE-2 の例外をユーザーに求める。なお C1 入りの候補は「製品を変えた候補」で、LAPSE-2 の「製品を変えるとき」には当たる（R1 を満たせない点は変わらない） |
| T-11 | G-a の admission の変更（凍結素材を end-to-end に使う）と click の書込み | 新しい purpose／経路、`keep_click` の書込み先 | **要**（新しい authority の候補。DB に書くなら保存範囲の拡大の候補。設計起案 `pubg-16-e2e-design-draft.md:31` も「新しい契約にあたりうる」） |
| T-12 | Gold・fixture・期待値・物差し | 変えない | 不要 |

## 4. 手順

1. **起案**（この file。改訂 2）。
2. **独立レビュー**（read-only。この起案と、§1.2・§1.3 が引く code の行を渡す。結論は渡さない）。改訂 1 には Opus の敵対的レビューが済み（改訂の履歴）。改訂 2 の再レビューの要否は integrator が決める。
3. **ユーザーの確認**（§5 の問い）。凍結・再測定の前。T-1〜T-5、T-8〜T-11 の答えを記録してから実装に進む。(D-b) なら新しい draftRef の起案・確認・台帳の行・凍結をここに挟む。
4. **実装**（harness：D、C7、QV の p95、手順の draft-3、版の直書きの箇所、試験、K6/4 の検出力の記録の取り直し）。製品のコードは変えない。
5. **dev の予行**（CP-4 の結果に数えない。DR-CP4-LPD-1 の (4)）：
   - D＝40 で N-7（`join.mjs:96-101`）と批准 12（`followup.mjs:494-498`）に落ちないこと（dev の診断 run 1・2 が落ちた点の確認）。
   - C7：Chronicle の遅れが起きた dev の run（run 3〜6 と同じ形）で、trace が valid になり `i-chronicle-stop` が件数どおり出ること。外す件数と、外す条件を満たす fetch の数が一致すること。
   - **C1 入りの dev の run**：C1（PR #824。実装済み、Opus の受入れ可）を含む build で、凍結の前に編集 trace を数回走らせ、Chronicle の停止の頻度が下がるかを見る（C1 の効果は未測定）。結果は設計の材料と開示だけに使い、判定・閾値に使わない。
   - 親が D の内に合流する G-case の sample の扱い（§1.2 (b)）。
6. **S2 追補 #14**（DR-CP4-P-9）と S3 の独立レビュー（手順の draft-3 を含む）。レビューの後に v2 を置く。
7. **S4 の 6 回目の凍結**（DR-CP4-S4-9）。S4 の PR は merge commit で取り込む。
8. **候補**：C1 を含む master の commit を推奨（§5 の Q4）。C1 なしで測る場合、C7 によって HOLD になる見込みが中心で約 6 割、幅 3〜9 割（§1.3 (e)。推測）あることを事前に開示する。C1 ありでも効果は未測定なので、見込みの数字は置かない。
9. **正式 run**（④ SP-P4、⑤ trace×2・parity・Gold・negative×3。G-a なら G-01 の end-to-end の診断 run を別 session で追加）。許可リストは `(s4Commit, candidate.commit)` の組（DR-CP4-S4-8 の (7)）。
10. **S6 の集計・S7 の報告**。結果を見た後に物差し・読みを変えない（DR-CP4-LAPSE-3）。

### 4.1 大きい DB の計測（dev で準備中）の扱い

- 位置づけ：dev の観測で、integrator だけが見る。CP-4 の判定・集計・閾値の選択には使わない（DR-CP4-LPD-1 の (4)、`cp4-decisions.md:1364`）。
- 使い道（案）：(1) C1 の上限（連続の Stale の回数など）が足りるかの設計の材料、(2) build の途中の begin が残る頻度を見て、C7 が必須であることの根拠を補う、(3) D＝40 ms が大きい DB の IR の到着を覆うか（DR-IRW-1 の根拠は 117 Scene の作品の最大 25.5 ms）の確認。
- 凍結の前に見た結果が手順の選択（C7 の細部、G-01 の扱い、候補の選び方）に効いたら、S2 の開示に「観測の後の選択」として書く（G-04 v2 の `limits` と同じ扱い。`observation-prep.v1.json` の `g04RevisionReadings.limits`）。
- 正式の測定は凍結した小さい fixture で行うので、大きい DB での可用性は測らない（限界として S7 に書く）。
- 推測：大きい DB では build が長く、保存のたびに build の途中で begin が出る機会が増えるので、**構造上 (i) の `i-chronicle-stop` が失効の主な理由になりうる**。C1 は Stale の後の待ちを縮めるが、build そのものの長さは縮めない。大きい DB での可用性は、今回の手順の版では測れない限界として書く。
- 推測：大きい DB で IR の到着が 40 ms を超えるなら、D の値の再検討は製品の閾値の問題で（DR-IRW の lane）、この手順の版では扱わない。

## 5. ユーザーに決めてもらう問い

1. **Q1（D＝40 ms を CP-4 に当てる形。T-1〜T-3、T-8、T-9。合格基準の緩和）**：(D-b) K6/4 の D（と子の IR の deadline）の行だけを変える新しい draftRef を起案し、draftRef／contractId を名指す承認で確認し、台帳に行を足す（**既定**）／(D-a) DR-IRW-3 の上書きを CP-4 にも及ぼす確認を取り、protocol の形で台帳に記録する／(D-c) CP-4 の取り直しを見送る。各案の帰結：(D-b) は K6/4 と並ぶ新しい契約の行ができ、手順の file が新しい draftRef の sha256 を照合する。(D-a) は K6/4 の本文（D=10.84）と手順の値（40）が食い違ったまま台帳の注記で橋渡しすることになり、`procedure-file.mjs:62-68` は K6/4 の sha256 しか照合しないので、この食い違いは機械では検出されない。(D-c) は DR-CP4-S6-3 の結果のまま CP-4 の取り直しが止まり、D＝40 ms と C1 を含む候補での可用性の記録が無いので、それを要する PUB-G の前提も先へ進まない（推測）。
2. **Q2（p95 の上限。T-4）**：DR-IRW-3 が 65.04 ms を上書きの対象にしていて、上書きの後の値が決まっていない。L1 65.04 ms（両 arm とも製品の許された待ちで落ちうる厳しい値）／L2 94.2 ms（緩和）／L3 240 ms（推奨しない）。起案者は推奨を置かない。p95 は CP-4 の正式の合否に入らず、手順外の補助の記録 QV-1 だけが使う。
3. **Q3（C7 と測定の位置づけ。T-5、T-10）**：C7 を S2 追補 #14 に入れてよいか（整列の防御を緩め、数える側を厳しくする。C1 が無ければ HOLD の見込みは中心で約 6 割、幅 3〜9 割〔既存の欠落が出なければ 1〜7 割〕）。入れない場合、頻度 1％ 一定なら 200 cycle の run が無効になる確率は約 87％ で、取り直しの繰返しと「起きなかった run」を選ぶ偏りが残る。あわせて、LAPSE-2 が許す唯一の経路 R0〜R8 の R1 を新版は満たせないので、LAPSE-2 の例外として正式の測定を始めてよいか（C1 入りの候補は製品を変えた候補）。
4. **Q4（候補と dev の材料）**：C1 を進めることはユーザーが決めている（PR #824 の本文「ユーザーの決定（2026-11-07）：C1 を進める」）。C1（PR #824）の merge を待ってその master で測る（推奨）か、C1 なしで測るか。凍結の前に C1 入りの dev の run を置くこと、大きい DB の計測の結果を設計の材料と開示だけに使い判定に使わないこと、でよいか。
5. **Q5（G-01 相当。T-11）**：G-a（同じ凍結に診断 run として入れる。admission の変更、`keep_click` の書込み先の確認が先）／G-b（CP-4 から切り離す）／G-c（今回は入れない）。起案者は推奨を置かない。

### 5.1 所要の目安（各問の選択に効く）

- 凍結 1 回（どの案でも要る）：S2 追補 #14 ＋ S3 の独立レビュー ＋ S4 の 6 回目の凍結 ＋ K6/4 の検出力の記録の取り直し ＋ 正式 run 8 件。run 8 件の実行は s5r6 の実績で約 72 分（2026-11-03 06:26〜07:38 UTC。`cp4-decisions.md:1254`）。その前の標準 build・評価 build・13 setup の時間は含まない（同じ行）。
- Q1 の (D-b)：上に加えて、新しい draftRef の起案・独立レビュー・draftRef／contractId を名指す承認・台帳の行・contracts の凍結（K6/4:315-317 と同じ形）。(D-a) は承認と台帳の記録だけ加わる。(D-c) は何も加わらない。
- Q5 の G-a：上に加えて、admission と runner の変更・その試験とレビュー、`keep_click` の書込み先の read-only の確認、正式 run に診断 run 1 本。
- Q4：C1 の merge を待つ時間と、C1 入りの dev の run（編集 trace 1 本は約 16 分。contracts `chronicle-late-publish-2026-11-07.md` §5 の案 A の見積り）。

## 6. 限界と、確かめていないこと

- C7 の「外す条件を満たす begin には record が無い」は code（`begin.rs:103-175`）と dev の 12 件からの読みで、Native の record に印は無い（§1.3 (c)）。
- 外した begin の Chronicle の停止の理由（epoch・Freshness・binding・roster・publish の遅れ）は renderer の値から区別できない（§1.3 (b) の 2）。
- 子の begin が Chronicle の停止に当たる場合の分類は文書に無く、案だけ（§1.3 (b) の 4）。
- `capacity` で ticket が作られない begin の record の有無は確かめていない（推測で「無い」。外さないので fail closed）。
- `keep_click` が DB に書くかは確かめていない（§1.4）。
- `procedure-file.mjs`・`hook-check.mjs` を持つ pin と、formal の閉包に入るかは実装の時に確かめる（§2.1）。
- 頻度と HOLD の見込みは dev fixture・dev build の値からの推測で、正式の trace と master の候補の頻度ではない。C1 の効果は未測定。

## ユーザーの決定（2026-11-07。AskUserQuestion で 1 回。改訂 3 の問いへの回答）

- **問 1（D の当て方）**：**新しい契約を起案（正規）**。D の行だけを変えた新しい draftRef を起案し、レビュー・承認を経て台帳に記録する。D＝40 は CP-4 の合格基準の緩和に当たることを了解の上での選択。
- **問 2（p95 の上限）**：**94.2 ms（Raw 54.2 ＋ 新しい D 40。同じ式）**。補助記録 QV-1 の上限の緩和に当たることを了解の上での選択。code が D から逆算して 240 ms になる点は直す。
- **問 3（C7）**：**入れる。LAPSE-2 の例外も了解**。外す条件は絞る（`querySupported===true` かつ IR の理由 `index-unavailable`、renderer の値 `graph-unavailable:cancelled`）。E＞0 なら読取の時計の範囲を必須にする。
- **問 5（G-01 相当）**：**今回の凍結に同梱**。素材の受入れ規則（admission）の変更が要り、click（`keep_click`）が DB に書くかを先に確かめる（書くなら保存範囲の拡大としてユーザーの確認が要る）。
- **問 4（候補）**は問わなかった。起案の既定（C1〔PR #824、ユーザーの決定で進める〕の merge を待ち、C1 入りの master を候補にする。凍結の前の C1 入りの dev run と大きい DB の計測は材料と開示だけに使い、判定に使わない）で進める。

### 追記：click（`keep_click`）が DB に書くかの調査（2026-11-07、read-only。HEAD は `c09643f7`、`1822b192` はその祖先）

- **DB には書かない。** renderer の `invoke("nir1_evidence_qualify")`（`nir1RelatedScenesApi.ts:67`）→ main は Native へ渡すだけ（`ipcContract.ts:9882-9895`）→ Native（`lib.rs:13093-13108` → `related_scenes.rs:399-412` → `graph_response.rs:483-523` の `click`）。DB への接触は 2 か所でどちらも read tx（`related_scenes.rs:181` の `with_participant_read_transaction`、`graph_response.rs:549` → `related_scenes_requalification.rs:419-428` の `with_participant_read_transaction_bounded`）。呼ばれる grimodex-db の関数に、試験以外の INSERT／UPDATE／DELETE／execute は無く、audit・ai_audit_events への書込みも無い。
- 保持はメモリだけ：`GraphInner.click`（`graph.rs:63-67`。binding・path の識別子と token・scene_id。本文・抜粋・path の文字列は持たない。1 件で `keep_click` が上書き）。寿命は lease と同じ（TTL 300 s、`related_scenes.rs:36`）。ほかは process-local の counter と runtime の状態だけ。
- harness は DB ではなく JSON に書く（`cp4-harness.ts:718-722` の `{status, reason, ms}` → report の JSON。receipt には書かない）。
- **よって G-01 相当の同梱は保存範囲の拡大に当たらない。** 残る委任の外は admission の変更（新しい authority に当たりうる）で、S2 追補 #14 の確認に含める。
