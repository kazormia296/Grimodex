# CP-4：D＝40 ms 用の正式の手順の新版（依頼文の「DR-IRW-3」）と C7 の設計起案（2026-11-07）

**起案だけ**。コード・S2・S4 の凍結・pin・閾値・Gold・fixture・期待値は変えていない。run・build・cargo もしていない。
ユーザーの決定（2026-11-07）：起案を始める。**凍結と再測定の前にユーザーに確認する**。

- 読んだ基点：製品 repo の `origin/master` `1822b192`（#823。`2cb73eec` を含む）。contracts は `claude/nir1-contracts` の `1ee3929a`。
  以下の `file:line` は、断りが無ければ `origin/master` `1822b192` の行。contracts の file は「contracts」と書く。
- 書き方：**事実**（file と記録で確かめたこと）、**推測**（推論。確かめていない）、**文書に無い**（どの記録にも書かれていない）を分ける。

## 0. 呼び名と ID の注意

- 依頼文と `cp4-decisions.md:1364` は、この手順の新版を「DR-IRW-3」と呼ぶ。ただし `irw-decisions.md:26` の **DR-IRW-3 は「この変更が上書きする確認済みの記述」の行で、状態は「記録済み」**。手順の新版を予告しているのは同じ file の §3（`irw-decisions.md:31`）である（事実）。
- この起案は混同を避けるため、判断の ID を新しく振る案を置く（ID の採否は integrator が決める）：
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
| `procedure/k64-procedure.v1.json` の `values.dMs`（`procedure-file.mjs:62-68` が constants と一致を求める） | 10.84 | v1 は残し、`k64-procedure.v2.json` を新しく置く（`observation-prep.v1.json` の `k64Procedure.promotion` の 3 つ目の規則は「同じ版の書き直しはしない」） |
| S2 の `k64Procedure.values.dMs` と `valueReasons.dMs`（`observation-prep.v1.json:337` 付近。理由は「P の固定契約で K6/4 の変えないもの。作者は選んでいない」） | 10.84 | 40。理由は DR-IRW-1 と、§3 の確認の結果 |
| S2 の `registeredForReview` の `BOUNDARY_TOLERANCE_MS` の注記（`observation-prep.v1.json:366-372`。「製品が D = 10.840000000596048 ms で比べる」） | 10.84 の float の差 | 40 での差を書き直す（推測：40 は浮動小数で正確に表せるので差は 0。許容の値 0.01 ms は変えない） |
| `hook-check.mjs:38-40` の注記 | 10.840000000596048 | 注記だけ直す（値は constants から読む） |

D を読むのは constants の 1 箇所だけで、`join.mjs:76`（窓内の判定）、`followup.mjs:497`（親の窓が D であること＝批准 12／N30）、`followup.mjs:699`（子の IR の deadline が D を超えない）、`k64-record.mjs:438`、`run-sample.mjs:433`、`trace-record.mjs:1098`、`procedure-file.mjs:64` は値を import するだけ（事実。`git grep GRAPH_EVAL_D_MS`）。

#### (b) 判定に効くところ（事実と推測）

- K6/4 の下では、first-render の窓外率は記録と開示だけで、合否は「表示の可用性」（D の窓内か follow-up の成功）で決まる（K6/4 の「変える点」1〜3、`nir1-final-request-eval-proposal-4-draft.md:29`〔contracts〕）。D を広げると、親が D の内に Graph に合流する sample が増えうる（推測。DR-IRW-2 は「Graph が最初の表示に入る機会が増える方向」と書く）。
- 推測：親が窓内に合流した sample は follow-up（F1〜F7、親が保留→子が `Cached`）の形にならない。K6/4 は窓内を表示ありと読むので判定の定義は変わらないが、正式の G-case でこの形が多く出るのは初めてになりうる。dev の予行（§4 の 5）で、定常状態の R1〜R4 と F2 の counter の差分の読みが崩れないかを確かめる。
- 子の IR の deadline（子の Raw-ready ＋ D）も 40 ms になる（K6/4:53 の「変えないもの」に入っている。§3 の T-2）。
- 失効率・窓外率・欠落率の物差し（1％、201 件なら許容 2 件）、W_f 100 ms、T_late 100 ms、T_show 2 s、lease 100 ms は変えない。

#### (c) p95 の上限 `B+D`（**閾値の緩和に当たりうる。要確認**）

- 事実：P の retrieval manifest（`evals/nir1-retrieval/manifest.json` の `performance.warm`）は `B = Raw-only p95`、`D = min(100ms, 0.20*B)`、`hybridP95Limit = B+D`。K6/4:53 は「P の B=54.2 ms、上限 65.04 ms（B+D）」を「変えないもの」に、K6/4:210 は「P の Hybrid p95 … は変えない」とする。DR-IRW-3（`irw-decisions.md:26`）は「L0 の P の固定値『D=10.84 ms、上限 65.04 ms』」を上書きすると書くが、**上限が何になるかは文書に無い**。
- 事実：CP-4 の正式の手順（S2）は p95 を判定しない。p95 を当てているのは手順外の補助の記録 DR-CP4-QV-1（`cp4-decisions.md:1338`）だけで、s5r6 では R+IR arm 55.30 ms・Graph arm 31.50 ms、上限 65.04 ms で pass（`:1350`）。
- 事実：QV-1 の `deriveLatencyPolicy`（`scripts/quality/nir1-graph-eval/quality-verdict.mjs:68-93`）は **B を D から逆算する**（`b = dMs / coefficient`）。`GRAPH_EVAL_D_MS` を 40 にすると、そのままでは B＝200 ms、上限＝**240 ms** になる（`quality-verdict-cli.mjs:242` が constants の D を渡す）。これは B の意味（実測の Raw の p95）を壊す大きな緩和で、黙って起きる。
- 選択肢：

| 案 | 上限 | 緩和か | 備考 |
|---|---|---|---|
| L1 | 65.04 ms のまま（B＝54.2、D は P の 10.84） | 緩和でない | P の評価（`scripts/quality/nir1-retrieval`）は今も fixture の B から D＝10.84 を出す（`irw-decisions.md:32`）。製品は IR を最大 40 ms 待つので、R+IR arm の p95 は上がりうる（推測：最大で約 29 ms。s5r6 の余裕は約 10 ms）。QV の結果が hold になりうる |
| L2 | 94.2 ms（B＝54.2 ＋ D＝40） | **緩和**（65.04 → 94.2） | 委任の外。ユーザーの確認が要る |
| L3 | 240 ms（今の code に D＝40 を入れた値） | **大きい緩和** | 推奨しない。B の意味が変わる |

- 推奨（起案者）：L1 を既定にし、QV の code は B を manifest の式から逆算せず、P の確認済みの値（54.2 ms）か P の記録から読むように直す（QV の file は pin の外。§2）。L2 を採るかはユーザーが決める。

### 1.3 C7（Chronicle が止まった begin を対応から外し、(i) として数える）

#### (a) 事実（contracts `diag-lpd-2026-11-02/chronicle-late-publish-2026-11-07.md` の §3.1・§3.2・§9.3）

- begin は最初の読みで Chronicle の `index_usable` が false なら IR の operation を作らず、Graph は lease が無いので `NotRequested` で owner に触れない。**native の eval sample record は作られない**（§3.1 の 1・2）。renderer の結果は `graph-unavailable:cancelled`（名前は cancelled だが、取消しではない。§3.1 の 3）。
- 今の harness は、seed つきの begin の数 N が record の数 M より多いと対応を取りやめ（`trace-record.mjs:635-636`）、全行が defect row（`:1306-1313`）、受領書は invalid になる。S2 の読み TP-1（`observation-prep.v1.json:282`）も「M < N は整列の失敗」と定める。
- dev の 6 run で 12／1,200（1.00％、Wilson 95％ 0.57〜1.74％）。run 3〜6 はすべて aligned=false（206／208／205／202 の begin に対し record 202／202／204／201）。**`indexUsable=false` の親は 12 件すべてで、(a) の形以外では 0 件**。OFF（native と renderer の時計の差）に依らない数え方でも同じ数（§9.3）。
- K6/2 の規則 3：「Chronicle の Index が止まる間は … 失効率の (i)（index の再 build 待ち）として数え、承認の失効と分けて記録する」（contracts `nir1-final-request-eval-proposal-2-draft.md:211`）、「(i) は B の seal によるものと Chronicle の停止によるものに分けて記録する」（同 `:84`）。harness はすでに `irOutcomeOf`（`run-sample.mjs:231-234`）と `lapseKind`（`join.mjs:126-133`）で `i-chronicle-stop` を持ち、`snapshotOf` は Chronicle を U の条件に入れない（`run-sample.mjs:210-224`、P2-4）。**数える側の規則はあるのに、対応の段で run が無効になるので、そこまで届かない**。

#### (b) 規則の案（DR-CP4-C7-1）

1. **外す条件**：trace の seed つきの begin のうち、その begin を出した fetch（`ownerOf`）の結果が `initialSnapshot.indexUsable === false`（厳密に boolean の false）であるもの。値は trace の probe が fetch の結果に残している（`renderer/cp4-k64-probe.tsx:165-170` の `summarize`。`cp4-trace-probe.tsx:27` が import）。
   - `indexUsable` が null・欠落・true の begin は外さない（fail closed。外さなければ今と同じく対応の失敗になる）。
   - `graphOutcome` の `graph-unavailable:cancelled` だけでは外さない（本当の取消し〔`index-ready` の世代の取消し〕は begin が通っていて record がある。推測：§9.1 で OFF の組から cancelled を除いたのは、この 12 件がそれに当たったからで、判定には使えない）。
2. **対応**：外した begin の数を E とし、残りの N−E 件の begin と M 件の record に、今の規則（M＝N の一対一、M＞N の V-2 の末尾除外、V-3 の時計の範囲の交わり、`native.lost`）を**そのまま**当てる。どの検査も弱めない。
3. **行**：外した begin が親のとき、その query は defect row ではなく、record の無い行（`nativeBegin: null`）として作る（DR-CP4-V-3 の `cancelledParentRow`〔`trace-record.mjs:911-1023`〕と同じ型。ただし begin は出ている）。
   - B の状態は開始時の封印で読む（record が無いので `snapshotOf` は既定で usable を返す〔`run-sample.mjs:217-224`〕。trace の行は開始時の封印を併せて求める〔`trace-record.mjs:1423` の `usable: row.snapshot.usable === true && seal.state === "current"`〕）。B が current でなければ規則 3 の順のとおり `i-b-seal` が先（`join.mjs:127-131`）。
   - `irOutcome` は `index-unavailable`。`lapseKind` は `i-chronicle-stop`。Q と U に入り、**失効率の分子に入る**。表示されなかったので、K6/4 の (b) の読み（`followup.mjs:772` の `followUpFailureCategory`）で category `lapse` として**窓外（欠落）にも入る**（事実：`availability.mjs:653-656` の K6/2 の読みでも、窓内でない U の query は category ごとに数えられる）。
   - 子（follow-up の再 query）の begin が外れる場合の分類は**文書に無い**。案：子の begin も同じ条件で対応から外し、follow-up の失敗の段の理由として記録する（分類の段と code は実装の試験で固定し、S3 で確かめる）。
4. **開示**：受領書の `native.alignment` に `excludedChronicleStop`（件数 E、begin の id・seq、fetch の seq、`calledAt`、`graphOutcome`、親か子か）を足す。`lapseIBreakdown`（`trace-record.mjs:1784-1793`）の `i-chronicle-stop` に件数が出る。

#### (c) 誤って外す危険と防ぎ方

| 危険 | 防ぎ方 | 残るもの |
|---|---|---|
| `indexUsable=false` なのに record がある begin を外す（Native の挙動が今の code と違う場合）→ 1 つずれた対応 | (1) 外した後の N−E と M に今の件数の規則を当てる（M＜N−E なら失敗）。(2) V-3 の時計の範囲（組の範囲と Native の読取の範囲の交わり。`trace-record.mjs:599-604`）は 1 つずれた対応を捕まえる（DR-CP4-V-3 の P2-2）。(3) 外した begin の fetch の結果が IR unavailable（理由 index-unavailable）と Graph not-requested 相当であることを整合の検査にし、違えば `[precheck]` | Native の record に「Chronicle が止まった」の印が無いので、record が**無いこと**を直接は確かめられない（限界。印を足すのは Native〔評価 feature〕の変更で、C7 の範囲の外） |
| 別の理由で record が欠けた begin と、外した begin が打ち消し合う | (1) の件数と (2) の時計の範囲。`native.lost` の検査は今のまま | 偶然すべて満たす並びは区別できない（推測：起きにくい） |
| `indexUsable` を読み違える（probe の summarize の変更など） | probe は pin の対象（`s5a-graph-arm-runner` の `renderer/cp4-k64-probe.tsx`）。値の型が boolean でなければ外さない | — |
| 外すことで失効を見えなくする | 外した query は Q・U・失効の分子・欠落の分子に必ず入れ、件数を受領書に出す。合成の記録で検出力を示す（K6/4:209「CP-4 の分類器は、受入れの Negative の合成の記録で検出力を示してから使う」） | — |

試験の案（実装の段で）：外す begin が 0／1／複数、親だけ／子だけ、`indexUsable` が null、外した後に M＜N−E、1 つずれた対応（V-3 で落ちる）、B が dirty で `i-b-seal` が先になる場合、`graph-unavailable:cancelled` だが `indexUsable=true`（外さない）。K6/4 の検出力の記録（contracts `k64-synthetic-detection-record.md`、前回 611 件 pass）は C7 の例を足して取り直す。

#### (d) 緩和か

- 事実：C7 は物差し（1％、2 件）・Q・U・失効の定義を変えない。K6/2 の規則 3 の文面どおりに数えるための直し。
- 推測：今の harness では、この形が 1 件でも起きた run は無効になり、取り直しで「起きなかった run」が選ばれうる（緩い側の偏り）。C7 はその偏りを除き、起きた件を失効と欠落に数える（**厳しい側**）。
- ただし S2 の読み TP-1 の文面を変える手順の改訂なので、ユーザーの確認が要る（contracts `chronicle-late-publish-2026-11-07.md` の §6 の C7 の行と同じ見立て）。

#### (e) C7 だけでは HOLD になりうる（推測。計算）

- dev の頻度（1.00％）が正式の trace でも同じなら、201 件の trace で平均約 2 件。物差しは「2 件を超えたら HOLD」なので、Poisson（λ≈2.0）で 3 件以上の確率は約 33％。失効率と欠落率の両方に入る。s5r6 の欠落 1／201 も足される。
- dev の値は dev fixture・dev build のもので、正式の trace の拍子とは違う（§9.7 の「言えない」の (3)）。C1（製品側の取り直しの短縮）が入れば下がる見込み（推測。C1 の効果は未測定）。
- DR-CP4-LAPSE-3：物差しを満たせないときは HOLD のまま設計に戻り、物差しを緩和しない。C7 を入れて HOLD になっても、物差しは変えない。

### 1.4 G-01 相当（PUB-G #16 の決定 (C)）

- 事実：DR-PUBG-16-1（`cp3a-decisions.md:74`）は案 (C) の第一段＝(A)（dev fixture）で、lease 越しの end-to-end に 3 回到達。contracts `nir1-pubg-records/pubg-16-e2e-2026-11-07/README.md` の「限界」に「G-01 相当の確認は CP-4 の次の正式 run に組み込む（決定 (C)）」。設計起案（contracts `pubg-16-e2e-design-draft.md:31`）は (C) の後続について「正式 run の追加分は別の確認」、問い 3（`:72`）は「CP-4 の次の正式 run に組み込むか、PUB-G の前提と切り離すか」。**問い 3 への回答の記録は文書に無い**。
- 事実：G-01 の正式の受領書には Graph-only の行があるが continue は cancelled（contracts `gold-s5r6-1/G-01_v1.receipt.json:1262`・`:1357`。設計起案 `:23` の引用）。`dprime-check` の `heldSample` は凍結素材を拒む（`admission.mjs:706`。同 `:23`）。
- 組み込む場合に要るもの（推測）：(1) admission に新しい purpose か、凍結素材を許す経路（`admission.mjs` は pin〔`s4-rehearsal-admission`〕。DR-PUBG-16-1 は「新しい purpose を足すと admission の変更になる」と書く）、(2) runner（`pubg16-e2e-run.mjs` は今は pin の閉包の外。正式にするなら `FORMAL_HARNESS_ENTRIES`〔`scripts/quality/nir1-graph/observation-prep.mjs:859-865`〕に入れ、pin する）、(3) click（`nir1_evidence_qualify`）は Native の `keep_click` の entry を作るので、Gold・parity の測定と同じ session に混ぜない（別の診断 run にし、`countsInCaseJudgement: false`）。click が DB に書くかは文書に無い。
- 案：

| 案 | 中身 | 凍結 | 確認 |
|---|---|---|---|
| G-a | 同じ S2 追補 #14・6 回目の凍結に、G-01 の凍結素材での end-to-end を**診断の run**として入れる（判定に数えない。合格基準は到達の有無） | 6 回目の凍結に同梱（凍結は 1 回で済む） | 要（admission の変更、正式 run の追加） |
| G-b | CP-4 から切り離し、PUB-G の lane で別に扱う（G-01 の素材の写しで dev として通す等） | 触れない | 要（決定 (C) の読み替え） |
| G-c | 今回は入れず、次の凍結のときに考える | 触れない | 不要（ただし PUB-G #16 の G-01 相当が残る） |

- 推奨（起案者）：G-a。依頼の背景（S2／S4 の改訂を一度で済ます）と合う。ただし admission の変更は新しい authority に当たりうるので、ユーザーの確認を先に取る。

## 2. 変える file と変えないもの

### 2.1 変える file（実装の段。今回は何も変えていない）

| file | 変える中身 | pin の対象か（事実） | 凍結への影響 |
|---|---|---|---|
| `scripts/quality/nir1-graph-eval/constants.mjs` | `GRAPH_EVAL_D_MS` 40 と注記 | はい（`SOURCE_PINS` の `g4-b1-freeze-v2-constants` `d06f080e`） | pin のし直し |
| `scripts/quality/nir1-graph-eval/procedure/k64-procedure.v2.json`（新規。v1 は残す） | `values.dMs` 40、`review` は S3 の記録 | `observation-prep-freeze.v1.json` の `boundFiles`（今は v1 の sha256 `1c2428df…`） | 束縛のし直し |
| `scripts/quality/nir1-graph-eval/procedure-file.mjs` | §3 の T-1 で (D-a) を採り、DR-IRW の記録を束縛する key を足すなら schema の版を上げる（`TOP_KEYS` が固定。`:53-61`）。(D-b) なら draftRef の照合だけ | `HARNESS_FILES`（`k64-runner.mjs:334-`）に入る。どの pin が持つかは実装の時に `harnessPinOf` で確かめる（文書で確かめていない） | 変えれば pin のし直し |
| `scripts/quality/nir1-graph-eval/trace-record.mjs` | C7（`alignSeededBegins` の前処理、record の無い親・子の行、開示） | はい（`v4-trace-record-requery` `527589b6`） | pin のし直し |
| `scripts/quality/nir1-graph-eval/followup.mjs`・`availability.mjs` | C7 の子の分類を変える場合だけ | `followup.mjs` は pin（`v4-followup-cancelled-match`）。`availability.mjs` は `HARNESS_FILES` に入る | 変えれば pin のし直し |
| `scripts/quality/nir1-graph-eval/hook-check.mjs` | 注記だけ | 診断用（formal の閉包に入るかは実装の時に確かめる） | — |
| `scripts/quality/nir1-graph-eval/quality-verdict.mjs`・`quality-verdict-cli.mjs` | p95 の B の出し方（§1.2 (c)） | **いいえ**（DR-CP4-QV-1：pin 一覧・`HARNESS_FILES`・`FORMAL_HARNESS_ENTRIES` の閉包のどれにも入らない） | なし（手順外の補助） |
| 試験（`trace-record.test.mjs`、`constants`／`procedure-file` の試験、C7 の合成の例） | 追加 | 試験は pin の対象外（`SOURCE_PINS` の注記は非試験の file を持つ） | なし |
| `evals/nir1-graph/observation-prep.v1.json`（S2） | **S2 追補 #14**：`k64Procedure`（values・valueReasons・formal を v2 へ）、TP-1 の読み（C7）、`registeredForReview` の注記、`setupReadings.source.pins` の bytes、開示（観測の後の改訂であること、DR-IRW、C7 を dev の観測で見つけたこと） | S4 の凍結が束縛 | S2 追補 #14 |
| `scripts/quality/nir1-graph/observation-prep.mjs` | `SOURCE_PINS`（上の file を持つ pin の commit）、G-a なら `FORMAL_HARNESS_ENTRIES` | 凍結の検査そのもの | 同上 |
| `evals/nir1-graph/observation-prep-freeze.v1.json` | **6 回目の凍結**（S4a／S4b の新しい版。`boundFiles` の sha256） | — | S4 の 6 回目 |
| G-a の場合：`admission.mjs`（pin `s4-rehearsal-admission`）、`pubg16-e2e-run.mjs`、`renderer/cp4-harness.ts`（pin `s5b-diagnostics-wiring`） | 凍結素材での end-to-end の経路 | はい／いいえ／はい | 同上 |

- 手順の記録：pin は「その file を最後に変えた master の commit」が持つ（`observation-prep.mjs:480-484` の注記）。これまでの S4 の PR は merge commit で取り込み、squash しない（`:581-582`、`:599-600` の注記）。新版も同じにする。
- K6/4 の凍結（`constants.mjs:56-65` の `K64_FREEZE`）は、(D-a) なら変えない。(D-b) なら新しい draftRef の凍結を足す（新しい契約。§3）。

### 2.2 変えないもの

- Gold、G-case の fixture（`evals/nir1-graph/freeze.v2.json`、`evals/nir1-g01/fixture.v1.json`、G-04 v2）、期待値、seed の pin、trace の file（`trace-editing.v1.json`・`trace-browsing.v1.json`）。
- 物差し（1％）、Q と U の定義、失効の読み（K6/2 の読み・K6/4 の読み）、W_f・T_late・T_show・lease・`BOUNDARY_TOLERANCE_MS`、`receipt.mjs`（pin `t14-k64-freeze`）。
- K6/2・K6/4 の bytes（(D-b) を採らない限り）。製品のコード（C1 は別の lane）。
- p95 の上限 65.04 ms（ユーザーが L2 を選ばない限り）。

## 3. 確認済みの契約・規則に触れる点と、確認の要否

AGENTS.md の委任の外：秘密・データの新しい送信先、保存範囲の拡大、**閾値の緩和（確認台帳の現行閾値と Gold の緩和・黙示変更）**、製品公開、製品認可の削除、**新しい契約・authority**。また CP-4 は AGENTS.md が列挙する NIR-1 の残レーン（C-resource ほか）に入っていない（事実）。

| ID | 触れる記述 | 中身 | 確認が要るか（起案者の判定） |
|---|---|---|---|
| T-1 | K6/4:8「最初の表示の待ち時間 10.84 ms は変えない」、:36（許さないもの「最初の表示の D の値の変更」）、:53（変えないもの「D=10.84 ms」）、:184、:210 | CP-4 の判定に D＝40 ms を使う | **要**。DR-IRW-3 はこれらを上書きすると記録したが、ユーザーの回答「変えていいです」は製品の窓の問いへの回答（`irw-decisions.md:3-4`）で、CP-4 の評価の契約にまで及ぶかは明示されていない（文書に無い）。DR-IRW-3 自身も手順の改訂と取り直しは「ユーザーが決める」とする（`:31`） |
| T-2 | K6/4:53「子の IR の deadline（子の Raw-ready + D）」 | 40 ms になる | T-1 と同じ確認に含める |
| T-3 | 確認台帳 `nir1-l6-l9-contract-proposal-7-draft.md:31`「窓外率は … 最終 request の窓（D=10.84 ms。K6/2）」 | 台帳の定義の D が変わる | **要**（台帳の現行閾値の変更。DR-IRW-3 の上書きの列挙〔(1)〜(3)〕に台帳のこの行は無い） |
| T-4 | P の上限 65.04 ms（K6/4:53、:210、`nir1-dsn-2026-10.md:13`、`evals/nir1-graph/README.md:211`） | p95 の上限 | L1（据え置き）なら**不要**。L2・L3 は**要**（緩和） |
| T-5 | S2 の TP-1「M < N は整列の失敗」（`observation-prep.v1.json:282`） | C7 | 緩和ではない（厳しい側。§1.3 (d)）が手順の改訂。ユーザーの決定（凍結の前に確認）どおり**要** |
| T-6 | K6/2 の規則 3 (i)（contracts proposal-2:84、:211） | C7 はこの文面に合わせる | 文面は変えない。**不要** |
| T-7 | K6/4:209（検出力の記録） | C7 の例を足して取り直す | 狭める防御。**不要**（K6/4 の N の番号は増やさず harness の試験として足す） |
| T-8 | K6/4:248 の N17（観測の後に T_late・W_f・T_show・条件・起点か終点を広げた受領書、または手順の file の新しい版とレビューの無い変更） | 手順の v2 | v2 は独立レビュー（S3）と凍結を通す。D は N17 の列挙に無い（事実）が、手順の file の新しい版なのでレビューは必ず通す |
| T-9 | K6/4:307（推奨と違う選択は新しい draftRef で起案する）と台帳の Confirmation protocol（l6-l9:247） | T-1 の形の選択 | (D-a)：DR-IRW-3 の上書きを CP-4 と台帳にも及ぼすことをユーザーが明示に確認し、手順 v2 と S2 に記録を束縛する。(D-b)：K6/4 の D の行だけを変える新しい draftRef（`nir1-final-request-eval-proposal/5`）を起案して確認する（**新しい契約**）。どちらも**要** |
| T-10 | DR-CP4-LAPSE-1・2（追加の正式な再測定はしない。製品を変えるときだけ設計草稿 §8.2 の R0〜R8 で測る） | 再測定 | 製品は変わった（D＝40、C1）。§8.2 の手順に当たるかの照合は**文書に無い**（設計草稿は枝 `claude/cp4-lapse-design` で、この起案では読んでいない）。ユーザーの確認（§4 の 3）に含める |
| T-11 | G-a の admission の変更（凍結素材を end-to-end に使う） | 新しい purpose／経路 | **要**（新しい authority に当たりうる。設計起案 `pubg-16-e2e-design-draft.md:31` も「新しい契約にあたりうる」） |
| T-12 | Gold・fixture・期待値・物差し | 変えない | 不要 |

## 4. 手順

1. **起案**（この file）。
2. **独立レビュー**（read-only。この起案と、§1.2・§1.3 が引く code の行を渡す。結論は渡さない）。
3. **ユーザーの確認**（§5 の問い）。凍結・再測定の前。T-1〜T-5、T-9〜T-11 の答えを記録してから実装に進む。
4. **実装**（harness：D、C7、QV の p95、試験、K6/4 の検出力の記録の取り直し）。製品のコードは変えない。
5. **dev の予行**（CP-4 の結果に数えない。DR-CP4-LPD-1 の (4)）：
   - D＝40 で N-7（`join.mjs:96-101`）と批准 12（`followup.mjs:494-498`）に落ちないこと（dev の診断 run 1・2 が落ちた点の確認）。
   - C7：Chronicle の遅れが起きた dev の run（run 3〜6 と同じ形）で、trace が valid になり `i-chronicle-stop` が件数どおり出ること。外す件数と `indexUsable=false` の fetch の数が一致すること。
   - 親が D の内に合流する G-case の sample の扱い（§1.2 (b)）。
6. **S2 追補 #14**（DR-CP4-P-9）と S3 の独立レビュー。
7. **S4 の 6 回目の凍結**（DR-CP4-S4-9）。S4 の PR は merge commit で取り込む。
8. **候補**：C1 を含む master の commit を推奨（§5 の Q4）。C1 は並行して実装中で、merge の後の master を候補にする。C1 なしで測る場合、C7 によって HOLD になる見込みが約 3 割（§1.3 (e)。推測）あることを事前に開示する。
9. **正式 run**（④ SP-P4、⑤ trace×2・parity・Gold・negative×3。G-a なら G-01 の end-to-end の診断 run を別 session で追加）。許可リストは `(s4Commit, candidate.commit)` の組（DR-CP4-S4-8 の (7)）。
10. **S6 の集計・S7 の報告**。結果を見た後に物差し・読みを変えない（DR-CP4-LAPSE-3）。

### 4.1 大きい DB の計測（並行して dev で実施中）の扱い

- 位置づけ：dev の観測で、integrator だけが見る。CP-4 の判定・集計・閾値の選択には使わない（DR-CP4-LPD-1 の (4)、`cp4-decisions.md:1364`）。
- 使い道（案）：(1) C1 の上限（連続の Stale の回数など）が足りるかの設計の材料、(2) 「build の途中の begin」が残る頻度を見て、C7 が必須であることの根拠を補う、(3) D＝40 ms が大きい DB の IR の到着を覆うか（DR-IRW-1 の根拠は 117 Scene の作品の最大 25.5 ms）の確認。
- 凍結の前に見た結果が手順の選択（C7 の細部、G-01 の扱い、候補の選び方）に効いたら、S2 の開示に「観測の後の選択」として書く（G-04 v2 の `limits` と同じ扱い。`observation-prep.v1.json` の `g04RevisionReadings.limits`）。
- 正式の測定は凍結した小さい fixture で行うので、大きい DB での可用性は測らない（限界として S7 に書く）。
- 推測：大きい DB で IR の到着が 40 ms を超えるなら、D の値の再検討は製品の閾値の問題で（DR-IRW の lane）、この手順の版では扱わない。

## 5. ユーザーに決めてもらう問い

1. **Q1（D＝40 ms を CP-4 に当てる形。T-1〜T-3、T-9）**：(D-a) DR-IRW-3 の上書きが K6/4 と確認台帳（`l6-l9-…-7-draft.md:31`）の D にも及ぶことを明示に確認し、手順 v2 と S2 にその記録を束縛する（起案者の推奨）／(D-b) K6/4 の D の行だけを変える新しい draftRef を起案して確認する／(D-c) CP-4 の取り直しを見送る。
2. **Q2（p95 の上限。T-4）**：L1 65.04 ms のまま（緩和でない。推奨。QV の code の B の逆算を直す）／L2 94.2 ms（緩和）／L3 240 ms（推奨しない）。
3. **Q3（C7。T-5、T-10）**：C7 を S2 追補 #14 に入れてよいか。入れると Chronicle の遅れが失効率と欠落率の両方に数えられ、C1 が無ければ HOLD の見込みが約 3 割（推測）。あわせて、今回の取り直しを LAPSE-2 の「製品を変えるときの測定」として扱ってよいか。
4. **Q4（候補と大きい DB）**：C1 の merge を待ってその master で測る（推奨）か、C1 なしで測るか。大きい DB の計測の結果は設計の材料と開示だけに使い、判定に使わない、でよいか。
5. **Q5（G-01 相当。T-11）**：G-a（同じ凍結に診断 run として入れる。admission の変更を伴う。推奨）／G-b（CP-4 から切り離す）／G-c（今回は入れない）。

## 6. 限界と、確かめていないこと

- C7 の「`indexUsable=false` なら record が無い」は code と dev の 12 件からの読みで、Native の record に印は無い（§1.3 (c)）。
- 子の begin が Chronicle の停止に当たる場合の分類は文書に無く、案だけ（§1.3 (b) の 3）。
- 失効 lane の設計草稿 §8.2（R0〜R8）は読んでいない（T-10）。
- `procedure-file.mjs`・`hook-check.mjs` を持つ pin と、formal の閉包に入るかは実装の時に確かめる（§2.1）。
- 頻度と HOLD の見込みは dev fixture・dev build の値からの推測で、正式の trace と master の候補の頻度ではない。
