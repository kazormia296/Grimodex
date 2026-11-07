# PR #774（`claude/g04-v2c-fixture`、先頭 `0b28c7ba`）の最終関門の独立レビュー（read-only、2026-11-02）

- reviewer：独立の gate reviewer（Claude の agent、read-only）。実装担当・各段階の reviewer の結論は参照したが、判定は実物（git の object、contracts の `git show`、admission の再現）で自分で確かめた。
- 読んでいないもの：測定の受領書（contracts の `gold-s5r4-1/`、`traces-*`、`parity-*`、`negatives-*`、`s6-aggregation-s5r4/`、`s7-report-*`）と `.artifacts/cp4/`。
- 書いたもの：この dir（`…/scratchpad/g04c/gate/`）の `admission-check.mjs`、`admission-check.out`、整形の写し（`s2-fields.json`、`s2-read.md`、`decl.json`、`decl-read.md`、`r5-record.json`、`r5-closure.txt`）、一時 clone `clone/`（検証後に削除）。repo の worktree には file を作っていない（`git status --short` は実行の前後とも空）。

## 結論：**go-with-conditions**（merge してよい。条件は下の 3 つ）

P1 なし。admission は自分の合成の merge で再現できた（項目 1 のすべて）。freeze record・placeholder 20 個・取り直した 2 記録・差分の範囲は実物と一致。開示は概ね事実に合うが、逸脱 (A) の正当化が K6/4 の本文の条項（:196）を見落としており、その点を朝のユーザー確認に正確に提示することを条件にする。

### 条件（merge の後、正式の run ④⑤ の前）

1. **C1（P2-1 の帰結）**：正式の run（④ SP-P4、⑤）は、ユーザーが朝に逸脱 (A) を認めるまで始めない。提示するときは、K6/4 :317 だけでなく **:196（R5 の条項、本文、太字）と批准 9（G-case の setup の変更は CP-0 側）** を引く（下の P2-1）。merge 自体は、異議が出た場合の直し方（β：K6/4 の同じ bytes での凍結し直し → `constants.mjs` → SP-N 取り直し → 5 回目の S4）が merge の有無で変わらないので、止める理由にならない。ただし merge の後は S4b''' が origin/master の祖先になり、admission 上は ④⑤ を走らせられる状態になる。契約は失効の一覧を持たない（DR 残る穴 (a)）ので、「ack まで走らせない」は運用（人の判断）でだけ守られる。
2. **C2（逸脱 (C) の条件）**：S4b''' が hash で引く contracts の `20ccd115`・`56d4ec54`・`e42e9990` は `origin/claude/nir1-contracts` に push 済み（確認済み）。S6／S7 の前にもう一度 `git show <commit>:<path> | sha256sum` で `aef7c0a1…`／`fa04baa4…`／`de0ccae2…` を照合し、contracts の枝が fast-forward だけで進んでいる（`k64-freeze-record.md` の規則）ことを S7 に書く。
3. **C3（運用）**：PR 本文の「運用条件」節に S7 の v1／v2 並置を足す（本文の別節と DR (5) にはある。P3-2）。merge 前に直せるなら直す。直せなくても DR にはあるので merge を止めない。

## 項目 1：admission の再現（最重要）— **再現できた**

手順：`git clone --shared --no-checkout` で `…/gate/clone` を作り、`checkout --detach 8187fbfc`、`merge --no-ff 0b28c7ba` で合成の M＝`c1828047c085c15198802d88542fb19305a74e90`（親 `8187fbfc`、`0b28c7ba`。tree は PR 先頭と同じ）。`refs/remotes/*` を全部消し（元は 382 ref）`refs/remotes/origin/master`＝M だけにし、HEAD＝M。push なし。module は worktree から import、`root` は clone（`admission-check.mjs`、出力 `admission-check.out`）。

- (i) `collectObservationPrepFacts(commit=60bf9dc4, head=M)`：`recordIntroducedByCommit=true`、`onRemoteRef=true`、`ancestorOfCandidateHead=true`、record の sha256 は commit・head とも `f203071ab1c2e628f80de41403b85dcfcabb7cd0a475d143c9bce1e30d3ba3c9`。`assertObservationPrepAdmits` OK、`readAdmittedObservationPrep` OK（S2 は `frozen-before-observation`、sha256 `9cc881ba…`、placeholders `[]`、boundFiles 6、traces 2）。head を PR 先頭 `0b28c7ba` にしても同じ。
- (ii) 旧 S4b `b7d74950`・旧 S4b' `9f52e7da`・旧 S4b'' `557e683c` → いずれも `the observation-prep freeze record differs from the pre-observation commit`。使わない前の版 `c6839a6f`・`2c3a8473` → `not an ancestor of the candidate head`。
- (iii) 失効 `d50b0a48`、S4a''' `02ede6bb`、S2 追補 `daadd9f3`、訂正 `5e0c5f05`、addendum 凍結 `c65e352d`、候補 `179139b4`、manifest `b02a8f14`、DR `0b28c7ba`、M → すべて `did not introduce the freeze record`（M は親 `8187fbfc` が旧 record を持つので parentHas で止まる。`git show 8187fbfc:…/observation-prep-freeze.v1.json | sha256sum`＝`b915ba91…` を実測）。S4b''' を commit に、旧 master `8187fbfc` を head → `not an ancestor`。順序：失効・addendum 凍結・追補・訂正・S4a'''（3 commit）・`fdb1fc9b`・候補・旧 S4b'' はすべて S4b''' の祖先、S4b''' の親は `179139b4` のみ、`60bf9dc4..M` で record を変えた commit は無し。
- (iv) pin：S2（M の bytes）の 32 pin・72 file について、role・commit・check・path 集合が `SOURCE_PINS`（32）と一致、各 file の sha256 が pin の commit・M・S2 の行で同じ、各 file を M で最後に変えた commit（`git log -1 M -- path`）が pin の commit、各 pin の commit が M の祖先。**食い違い 0**。
- (v) `validateNir1ObservationPrep(repoRoot=clone)`：errors 0、formalReady true、placeholders 0。`assertObservationPrepFormal` は head＝M、S4b'''、`b02a8f14`、`0b28c7ba` で `{proceed:true}`。head＝S4a''' `02ede6bb` は「自分を参照」で止まる（DR の記述どおり）。
- 追加：worktree の HEAD で `node --test scripts/quality/nir1-graph/observation-prep.test.mjs` 82/82 pass（S4b''' が frozen の形に戻した試験を含む）。他の試験（125／602／52／23）は再実行していない（PR 本文の主張のまま。確かめていない）。

## 項目 2：freeze record と placeholder 20 個 — 一致

- freeze record（`60bf9dc4`）の `boundFiles` 8 件の sha256：S2 以外の 7 件（setup v2 `fd6b0c3c`、宣言 v2 `bbe3379f`、trace-editing `7e72a040`、trace-browsing `54e5e391`、作者の宣言 `99c6e387`、seed-pin v2 `3e4334cc`、K6/4 手順 v1 `1c2428df`）は S4a''' `02ede6bb` の bytes と一致（S4b'''、PR 先頭でも同じ）。S2 の行は S4b''' が S2 自身を変えるので `02ede6bb` の `722301ad` ではなく frozen の `9cc881ba`（設計どおり。readAdmittedObservationPrep が head の S2 と照合するのはこの値）。`graphCaseFreeze`（freeze.v2 `8958dc73`）、`g01Fixture`（`996ef1c0`）、`k62`（`af643a93`、constants と同じ）も一致。
- S2 の葉の差分（候補 `179139b4` の draft → S4b'''）：placeholder の token は 20 種（`placeholders` 配列の 20 行）。本体側で埋めた葉は 22（trace 2 件の commit・sha256 が `traces[]` と `boundFiles[]` の両方に書かれるため）。埋め値は trace 2・addendum 3・作者の宣言・K6/4 手順 v1 の commit がすべて `02ede6bb`、sha256 は上と同じ；`contracts.k64.freezeCommit`＝`5dea38af`（repo に存在、master の祖先、`constants.mjs` の `K64_FREEZE.freezeCommit` と一致、contracts の `k64-freeze-record.md` と一致）；`contracts.sp1.bytesCommit`＝`cd04629e`（#740、master の祖先）；`d10.g01.da1AcceptanceRecord`＝`none`、`rAndRirMode`＝`unrestricted`；②'＝`20ccd115`、①＝`56d4ec54`。ほかの差は status・review・formal.review・placeholders だけ（135 葉中、placeholder 以外は review の新設と status）。
- contracts の実物：`git show 20ccd115:docs/plans/nir1-cp4-records/sp-synthetic-detection-record.md | sha256sum`＝`aef7c0a187c89ab491bead1d851e91dd5a9d67a293180a180e01aa4adff78e34`、`git show 56d4ec54:…/r5-check-r5-1102/r5-check-record.json`＝`fa04baa444163b89d76beae467120366c5da55ca8e77a827eb597b06ad601f90`。どちらも S2 の記載と一致。両 commit と `e42e9990` ほか S2・PR が引く 19 の contracts commit はすべて `origin/claude/nir1-contracts`（先頭 `56d4ec54`）に含まれる。
- S4b'' と同じ出所の 4 値（`5dea38af`、`cd04629e`、`none`、`unrestricted`）が同じでよい理由：K6/4 の bytes（`d205b35f`、実物の sha256 と一致）と SP/1 の bytes（`8ccdf534`）は変わらず、DA-1 の受入れ記録は無く、`rAndRirModeRule`（none → unrestricted）の入力も変わらない。取り直しの規則（SP-N の 16 file、① の閉包）はこれらに掛からない。成り立つ。

## 項目 3：取り直した記録の有効性 — 成立

- `git diff 179139b4 0b28c7ba --stat`：DR（+11）、freeze record（+26）、S2、`quality-manifest.yaml`（+1）、`observation-prep.test.mjs` の 5 file だけ。SP-N の記録（`20ccd115` 版末尾）の 16 file（13 module＋試験 3 file：`seed-pin-setup.test.mjs`、`seed-pin.test.mjs`、`receipt.test.mjs`）はどれも含まれない。① の閉包（`r5-check-runner.mjs` の静的 import を行頭の `import … from` だけ拾う regex で辿って 42 file。DR は 43 と書く——regex が複数行 import や `export * from` を落とした可能性がある。差分 5 file に harness の module が 1 つも無いので、結論は regex の精度に依らない）も `179139b4..0b28c7ba` で変化なし（`8187fbfc..0b28c7ba` で変わったのは `constants.mjs` と `nir1-graph/contract.mjs` の 2 つ。記録の記載どおり）。
- ①（`r5-check-r5-1102`）：`status=match`、`gate.status=match`、13 行すべて `match`、`mismatch` 0、候補 `179139b4`、runId `8fb525ed…`。受領書 13 件の sha256（`git show 56d4ec54:…receipts/*`）は `gate.rows[].setupReceiptSha256` と全件一致（自分で計算）。`--verify verified:true` は README の記載で、自分では実行していない（Electron を起動しないため）。記録の JSON は fixture v2 の sha256 `96d44ec3` を直接は名指していない（候補の tree で束縛）。
- ②'（SP-N）：記録の冒頭に候補 `179139b4`、tree `2dadf4f6`、45/45・602/602、変異 23 件すべて 1 か所命中・期待どおり（`results-179139b4.json` の verdict）と書かれ、表は 23 件。道具を表から作り直したこと（元と bytes 同一かは未確認）、判断を入れた 2 か所、限界 1〜5 は開示されている。再実行はしていない。

## 項目 4：開示の真実性 — 概ね事実に合う。1 件の不足（P2-1）

- (a) 独立「コード」レビューを「期待値レビュー」と書いていないか：S2 `limits (f)` は「3 つとも独立コードレビュー…で凍結した（独立期待値レビューではない）」と明記。seed-pin v2／setup v2 の `review`、`review.conditions` も同じ。宣言 v2 の `review` は s4pre レビュー（`e42e9990`、sha256 `de0ccae2…` 実物と一致）を K2/4 :418 の記録として束縛し、その項目 3 が導き直しであることを書く。問題なし。
- (b) 観測の数値：S2・作者の宣言には `30/270`（ユーザー確認 `a7027915` の文の引用と明記）、`0.4293`／`0.0007`（凍結前 probe の値。観測ではない）だけ。IR の cosine 0.556、要約 0.649〜0.677 は S2・宣言・addendum・fixture・manifest・README に無い（PR 本文にはある。PR 本文は frozen ではない）。問題なし。
- (c) 推測の標示：`limits (c)` の 1% への影響に〔推測〕、`traceRunnerReadings.limits (1)` に〔推測。確かめていない〕。問題なし。
- (d) PR 本文の主張との照合：独立レビューの種類と回数（期待値 1、規則文 1、コード 3、S4b 前 1）＝contracts の `g04-v2c-*` 7 dir（reprobe を含む）と一致。pin 32・72 file＝実測。変異：S4b 前 29＝s4pre README、B2a 49・B2b-1 約 45＝DR の追記（「個」）。**B1 の 27 は DR・contracts の README に見つけられなかった**（確かめられなかった。P3）。「旧 S4b／S4b'／S4b'' が拒否」「抜け道が止まる」「pin 全件照合 0」＝自分の再現と一致。
- **P2-1（開示の不足）**：`limits (i)`、DR 追記 2 (α)、s4pre レビュー P2-2、PR 本文はいずれも「:317 は見出し『確認後の記録（この draft の外で行う…提案）』(:312) の下の手順の提案で判定の条項ではない」を (α) の根拠にする。しかし K6/4 の **本文** `:196`（「測定の手順の読み替え」節の R5）は太字で「**G-case の各 query の Scene の最初の pin が、事前の期待値の seed と一致することの照合は、この draft の凍結の前の前提である**。取れなければ…K6/4 の判定を始めず、CP-0 の側で扱う」と書き、`:279`（lane 表）「G-case の seed の pin の照合（凍結の前の前提）」、`:292`、`:302` も同じ。つまり「R5 は凍結の前」は提案節だけでなく批准範囲の本文にもある（批准 4「測定の手順の読み替え（R1〜R8）」、批准 6 の (i) が「R1〜R8」を含むと明記。:31、:33）。開示の事実（日時・hash・逸脱であること・未確認）は正確だが、「判定の条項ではない」という正当化は本文を見落としており、朝のユーザー提示でそのまま使うと誤導になる。直し方は条件 C1（S2 は frozen なので S2 自体は直さず、DR 追記・PR 本文・ユーザーへの提示・S7 で :196 と批准 9 を引く。S2 の訂正のために 5 回目の S4 を作る必要はない）。

## 項目 5：差分の範囲 — 想定内

- `git diff --name-only origin/master...HEAD`＝34 file、すべて `docs/`、`evals/`、`scripts/quality/`。`.agents/`、`src/`、`electron/`、`src-tauri/`、`package.json`、lock は 0。`AGENTS.md`、`policies/quality/iron-laws.md`、v1 fixture `g04-scope-exact-unknown.v1.json`、`freeze.v1.json`、addendum v1 ×3、trace 2 file、`evals/nir1-g01/fixture.v1.json`、`k64-procedure.v1.json` は `git diff --quiet origin/master HEAD` で不変。ほかの G-case fixture の変更なし（変わった fixture は v2 の新規だけ）。NC-1／Y-1 に当たる file 名なし。
- fixture v2 sha256＝`96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1`（一致）。数値統計 +6034/−290、3000 行超・binary の追加なし、鍵らしい文字列の grep は 0 件。
- manifest（`quality-manifest.yaml`）の差は v2 の 5 行の追加だけで、`observation-prep-freeze.v1.json` の evidence 行は失効前と同じ位置に戻っている。

## 項目 6：3 つの逸脱の判断

- **(A) K6/4 の順（① を K6/4 凍結 `5dea38af` の後に取り直した）：(b) 条件つきで許容。** 理由：(1) 条項の実質（K6/4 の判定を R5 の match 無しに始めない）は満たす——新しい ① は match で、S4b''' と新 S4 の下のどの gated run よりも前。(2) 批准 9 は G-case の fixture／setup の変更を CP-0 側に送る。CP-0 側で setup が変われば R5 の再照合が K6/4 凍結の後になるのは契約の構造上避けられず、字義を満たすには (β) しかない。(3) (β) は `constants.mjs` → SP-N 再取得 → 5 回目の S4 で、事前登録の時点が観測の後に動く別の弱さを生む。(4) K6/4 の bytes・値・判定は不変。ただし条件：正当化の根拠を :196／批准 9 まで正確に提示し（P2-1）、朝のユーザーの ack を ④⑤ の前に取る。「開示して進める（merge まで）」は妥当——merge は何も走らせず、異議時の直し方は merge の有無で同じ。進めてよくないのは ④⑤。
- **(B) trace 2 file を v1 のまま：(a) 許容（開示で足りる）。** S2 `onFixtureRevision`（S3 レビューの文、ユーザー確認なし）と K6/2 :702（ユーザー確認済み契約。「(iii) では CP-4 の receipt を見た後に trace を作り直さない。作り直せるのは不備…があるときだけ」）が食い違い、契約の方が上位。trace は G-02 の project で動き、`project.setup` が名指す宣言 v1 と runner が読む v2 の G-02 行は JSON で同一（自分で比較：`declarations` の G-02 行は v1＝v2）。seed-pin v2 は参照だけの写し。測定は変わらない。`limits (h)` の開示は事実に合う。
- **(C) `s4StagesRule` (a)（contracts 枝の merge）を満たさない：(b) 条件つきで許容。** 機械の門は祖先関係を見ず（確認：`assertObservationPrepFormal` は S2 の references と pin だけ）、記録は push 済みの `origin/claude/nir1-contracts` に hash＋sha256 で束縛され、自分で照合できた。前例（S4b'' は merge で取り込んだ）と違う点は S2 `review`、`r5Gate` の 2 記録、DR に開示済み。条件は C2（contracts 枝の FF-only の維持と S6／S7 前の再照合）。S2 の規則文 (a) 自体は書き換えていない（frozen）ので、次に S4 を作るときは merge するか規則を改める（P3）。

## 項目 7：運用条件 — 漏れなし

DR-CP4-S4-7 (1)〜(11)＋「S4b''' の結果」：S6 の許可リスト＝S4b''' `60bf9dc4…` のみ (4)、旧 S4b''（`557e683c`）以前の `s4Commit` の受領書の除外 (2)(3)、S7 の v1／v2 並置 (5)、`graphRuntimeObservedBeforeFreeze:false` の字義の注記 (6)、上限 2 の数え直し (7)、merge commit 必須 (8)、`--keep-test-worktree` (9)、gate 候補は S4b''' の子 (10)、K6/4 検出力記録の取り直し (11)。PR 本文の「運用条件」節は (1)(4)(8) だけで、S7 の v1／v2 並置は別節（「重要な判断と開示」）にある（P3-2）。

## 指摘の一覧

| ID | 重大度 | 内容 | 根拠 | 直し方 |
|---|---|---|---|---|
| P2-1 | P2 | 逸脱 (A) の正当化「:317 は提案節で判定の条項ではない」が、K6/4 本文 :196（R5、太字）・:279・:292・:302 の同趣旨の条項を見落とす。開示の事実は正確だが根拠が不完全 | `docs/plans/nir1-final-request-eval-proposal-4-draft.md:196,279,292,302,312,317`；S2 `g04RevisionReadings.limits (i)`；DR 追記 2 (α)；`review-s4pre.md` P2-2 | DR 追記と PR 本文、朝のユーザー提示、S7 で :196 と批准 9 を引き、「本文にもあるが、実質（match の後に判定）は満たし、字義は CP-0 側の改版では構造上満たせない」と書く。S2 は frozen なので直さない（5 回目の S4 は不要）。④⑤ はユーザーの ack の後 |
| P2-2 | P2 | PR 本文「正式の run（④⑤）は merge の後に行う」が、(A) の「異議があれば止める」との関係（ack 前に走らせない）を書いていない | `pr-body.md` 「省略した検証と理由」；S2 `limits (i)` | 運用条件に「④⑤ はユーザーが (A) を認めた後」を足す（条件 C1） |
| P3-1 | P3 | PR 本文の変異件数「B1 27 件」の出所を DR・contracts の README に見つけられなかった（49・約 45・29 は見つかった） | `cp4-decisions.md` 903 行以降、`g04-v2c-b1-code-review-2026-11-01/README.md` | 出所（`review-b1.md` か DR）を PR 本文に添えるか、件数を落とす |
| P3-2 | P3 | PR 本文の「運用条件」節に S7 の v1／v2 並置が無い（別節と DR (5) にはある） | `pr-body.md` | 運用条件節に 1 行足す（条件 C3） |
| P3-3 | P3 | S2 の `r5Gate.rule`／`k64FreezeAfterMatch:true`／`exempt[r5].reason`／`contracts.k64.freezeNote` は「K6/4 の凍結は R5 の match の後」と書いたまま（事実と逆）。`limits (i)` の開示でカバーされ、validator は整合を見ない | S2 `r5Gate`、`contracts.k64` | 次に S2 を改版するときに規則文を事実に合わせる。今回は不要 |
| P3-4 | P3 | seed-pin v2／setup v2 の `review` の「下に書いた」（実際は上）は未修正（DR 残る穴 (f) に開示済み） | `evals/nir1-graph/seed-pin-addendum.v2.json`、`evals/nir1-g01/setup-addendum.v2.json` | 次の改版で直す |
| P3-5 | P3 | ① の閉包の file 数が DR「43」と自分の静的 import の辿り「42」で 1 違う（数え方の差の可能性。結論に影響なし） | `r5-closure.txt` | 次に記録するときに数え方（入口を含むか等）を書く |

## 確かめられなかったこと

- `r5-check-runner.mjs --verify` と SP-N の 23 変異の再実行（Electron／変異 hook の実行は行わない方針）。記録の sha256 と受領書 13 件の照合までは自分で行った。
- Node 24／22 の全試験（125／602／52／23）。`observation-prep.test.mjs` 82/82 だけ worktree で再実行。
- B1 の変異 27 件の記録の所在。
- PR の CI の状態（`gh pr view` で OPEN・MERGEABLE・head `0b28c7ba`・base master は確認。checks は見ていない）。

## 再現手順（要点）

```
G=…/scratchpad/g04c/gate
git clone --shared --no-checkout /home/grimodex/worktrees/Grimodex/claude-g04-v2c $G/clone
cd $G/clone && git checkout --detach 8187fbfc && git -c user.name=x -c user.email=noreply@example.invalid merge --no-ff --no-edit 0b28c7ba
for r in $(git for-each-ref --format='%(refname)' refs/remotes); do git update-ref -d $r; done
git update-ref refs/remotes/origin/master $(git rev-parse HEAD)
eval "$(fnm env --shell bash)"; node $G/admission-check.mjs $G/clone   # 出力は admission-check.out
```
一時 clone はレビューの後に削除した。
