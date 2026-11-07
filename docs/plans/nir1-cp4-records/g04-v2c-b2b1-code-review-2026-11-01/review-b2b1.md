# G-04 v2c B2b-1 独立コードレビュー（read-only、2026-11-01）

対象：`/home/grimodex/worktrees/Grimodex/claude-g04-v2c`（branch `claude/g04-v2c-fixture`）、`a7679acd..5591f37a`（5 commit、HEAD `5591f37aa2e1f00fb74b789a8618cd9d12228688` を確認）。
測定の受領書（contracts の `gold-s5r4-1/`、`traces-*`、`parity-*`、`negatives-*`、`s6-aggregation-s5r4/`、`s7-report-*`）と `.artifacts/cp4/` は読んでいない。repo は編集していない（終了時の `git status --short` は空）。作業 file はすべて `g04c/` の中に置いた。

## 結論：(b) 修正してから受入れ可

P1 なし。P2 が 1 件、P3 が 5 件。新しい版の 2 文書は「参照と版の欄だけ」の差分で、内容の変更（d）は無い。trace の検査の緩和は最小で、迂回路にはなっていない。残る 24 件は、どれも S2 の pin し直しで直る種類である。ただ、新しい版の 2 文書の `graphRuntimeObservedBeforeAuthoring: false` は、DR-CP4-G4-6 (2) と B2a (1') が採らなかった読み替えと同じ形になっている。凍結の前に integrator が決める必要がある（P2-1）。

---

## 1. 新しい版の 2 文書の差分（葉の比較）

script：`g04c/leafdiff.mjs`（JSON の葉を path ごとに比べる）。出力は `g04c/sp-diff.txt` と `g04c/setup-diff.txt`。

### seed-pin addendum（v1 `cf2330e2…` → v2 `b998056a…`。葉は 256→255、同じ葉 241）

| 分類 | 変わった葉 |
|---|---|
| (a) 参照の更新 | `references.graphCaseFreeze.path`／`.sha256`（freeze.v2、`8958dc73…`。実 file と一致）、`references.fixtures.G-04.path`／`.fixtureId`／`.sha256`（v2、`nir1-g04-scope-exact-unknown/2`、`96d44ec3…`。実 file と一致） |
| (b) それを述べる文 | `purpose`（freeze.v1→freeze.v2 の 1 語）、`acceptance[12].check`（SP-N8。freeze.v1→freeze.v2 の 1 語） |
| (c) 版の管理 | `addendumId` /1→/2、`status` frozen→draft、`review` の 6 葉→null、`supersedes` の 4 葉を追加 |
| (d) それ以外 | **無し** |

`seedPins` は v1 と同一（deepEqual）。`supersedes.commit` `cf1c83e3` の blob の sha256 が `cf2330e2…` であることも確かめた。

### G-01 setup addendum（v1 `ade7c402…` → v2 `9dbc5d6c…`。葉は 254→253、同じ葉 241）

| 分類 | 変わった葉 |
|---|---|
| (a) | `references.graphCaseFreeze.path`／`.sha256` |
| (b) | `references.graphCaseFreeze.note`（v1 の文はそのまま残し、freeze.v2 が G-01 の sha256 を引き継ぐことを述べる 1 文を後ろに足した）、`seedPinStepNote`（seed-pin の path）、`declarationPlace.rule`（宣言の addendum の path、Scene の数 4→5） |
| (c) | `addendumId` /1→/2、`status`、`review`→null、`supersedes` を追加 |
| (d) | **無し** |

**`declarationPlace.rule` の 4→5**：宣言の行・値・選択 (ii) は変わらない。変わったのは、宣言の addendum が宣言する Scene を数えた記述の文だけで、(b) に当たる。導出は正しい。v2 の宣言 Scene は g01-mira（setup v2）、g02-tamsin-first、g04-lio-landing、g07-pell-dock、g08-cass-attic（declaration v2。G-08 の 2 variant は同じ Scene）の 5 件。v1 は g04 を除いた 4 件。根拠はユーザーの確認 `user-confirmation-2026-11-01-g04-v2c-build.md` の質問 3 と「確認の範囲」4（K2/4 の 5 件目、記録は addendum の新しい版に書く）、および範囲 1（addendum の改訂）。確認の範囲に入る。

**v1 の bytes**：`git diff 8187fbfc..HEAD` は、seed-pin v1、setup v1、trace 2 file、S2、S4 freeze 記録、declaration v1、freeze.v1 のどれについても空。fixture v1／v2 にも差分は無い。

**ほかに変わった file（brief に書かれていないもの）**：`declaration-addendum.v2.json` も変わった（`c3207d69…`→`8d6e967e…`）。葉 172 のうち、違うのは `declarationPlace.rule` と `seedPinStepNote` の path の 2 つだけ（`g04c/decl-base.json` との比較で確かめた）。DR には記録がある（:974）。draft の範囲の中の参照の更新なので問題は無い。

### P2-1 `graphRuntimeObservedBeforeAuthoring: false` の読みが、確定済みの判断と食い違う

- 箇所：`evals/nir1-graph/seed-pin-addendum.v2.json:5`、`evals/nir1-g01/setup-addendum.v2.json:5`。判断は `docs/plans/nir1-lane-decisions/cp4-decisions.md:963`（B-1 の 2 段目）。
- 食い違う記録：
  - DR-CP4-G4-6 (2)（`cp4-decisions.md:906`）：「false を『この版の bytes は観測していない』と読み替えるのは field の意味の後付けなので採らない」。
  - B2a (1')（`:941`）：「v2 は Graph runtime が v1 の全 case を観測した後に書いたので false は事実と違う」。宣言の addendum v2 は true にした（`declaration-addendum.v2.json:5`）。
- B2b-1 は v1 の意味を「その addendum の行と規則が観測の前に決まっていた」と言い直した。しかしこの field の定義は repo のどこにも無く（`git grep` は validator と DR にだけ当たる）、確定済みの 2 つの記録はどちらも字義どおり（書いた時点が観測の前か）に読んでいる。新しい版の 2 文書は、2026-11-01 に観測の後に書いた file である。G-04 の行は値こそ v1 と同じだが、fixture v2（観測の後の bytes）から導き直したものと DR 自身が書いている。
- 害：凍結の後、S2 の `boundFiles` が束縛する文書に、字義どおりには事実と違う開示が残る。同じ G4-7 の中で、宣言の addendum v2 だけが true という読みの割れも残る。B2b-1 は integrator に返す点として挙げているので、隠してはいない。それでも、凍結の前に決めないと直せなくなる。
- 直し方（どちらか）：(i) 2 文書を true にする。validator（`seed-pin-addendum.mjs:172-173`、`observation-prep.mjs:1764-1765`）は「true は `supersedes` が v1 を束縛し、v1 との差が参照と版の欄だけのときに限る」とする。この差の条件は試験（`seed-pin-addendum.test.mjs` の B2b-1 試験、`observation-prep.test.mjs` の B2b-1 試験の deepEqual）が既に確かめているので、validator に移せばよい。(ii) false のまま残すなら、integrator が G4-6 (2) の例外として理由を DR に書き、file に「行は v1 の写しで、観測の後に導いた値は無い」ことを述べる欄を足す。(i) を推す。
- 再現：`grep -n graphRuntimeObservedBeforeAuthoring evals/nir1-graph/*.json evals/nir1-g01/*.json`。

---

## 2. trace の検査の緩和（`seedPinAddendumPathNamedByTraceErrors`、`seed-pin-addendum.mjs:38-48`、呼出しは `observation-prep.mjs:2491-2495`）

script：`g04c/mutate.mjs`（メモリ上の変異）と `g04c/filemut.mjs`（HEAD を `git archive` で `g04c/copy` に写し、v1 の bytes を実際に変える）。

- 受けるもの：現行の path、または v1 の path（`ctx.supersededSeedPinAddendumSha256 === cf2330e2…` のときだけ）。完全一致で比べる。
- 落ちることを確かめた変異（trace 2 file の両方で）：v3 の path、`./` つき、末尾の空白、file 名だけ、絶対 path、大文字の `V1`、setup や宣言の addendum の path、null、undefined、数、配列。v1 の path は、ctx の sha が別の値、null、v2 の sha のとき落ちる。
- 実 file の変異：v1 に空白を 1 つ足す、v1 を消す、v1 を v2 の bytes で置き換える、のどれでも、trace 2 件と seed-pin v2 の `supersedes` の 3 件の誤りになる。setup v1 を変えると setup v2 の `supersedes` が落ちる。何も変えないと誤りは 0。
- 現行の path を v1 に戻した新しい版：seed-pin v2 の freeze を v1 に戻す、G-04 を v1 に戻す、v1 をそのまま現行として出す、のどれも落ちる。setup v2 の freeze を v1 に戻す、`seedPinStepNote` を v1 に戻す、v1 をそのまま出す、のどれも落ちる。
- ほかの trace の検査：diff で確かめたところ、置き換えたのは 1 ブロックだけ。変異で `maintenance.gate`、`seed.entityId`、`fixtureSha256`、flag の true が引き続き落ちることも確かめた。
- 迂回路にはなっていない。v1 の bytes は S2 の `boundFiles` から外れるが、その後は validator の定数（`SEED_PIN_ADDENDUM_V1.sha256`）で固定される。

### P3-1 `addendumId` を validator が確かめない

`seed-pin-addendum.mjs` と `setupAddendumErrors` のどちらにも `addendumId` の検査が無い（`grep -n addendumId` は 0 件）。v2 の `addendumId` を `/1` や `/9` にしても誤りは 0（`mutate.mjs` の BAD の 4 行）。値は試験だけが固定している。v1 と同じ id の別の bytes がありうるので、validator で `/2` に固定することを勧める。

### P3-2 `supersedes.commit` は 40 桁の 16 進であることしか見ない

`seed-pin-addendum.mjs:218`、`observation-prep.mjs:1770`。`cf1c83e3` の blob が v1 の sha256 と一致することは手で確かめた（どちらも一致）。formal の gate（git を使う段）で `git show <commit>:<path>` の sha256 を照合すると、記録の欄として閉じる。

---

## 3. SP-N8 の読み替え

矛盾は無い。trace が名指す v1 は freeze.v1 を参照し、freeze.v1 の bytes は不変（`6080530a…`）で、freeze.v2 の `supersedes` が束縛している。trace が使う G-02 の entry は、freeze.v1 と freeze.v2 で同じ bytes である（contract.mjs が確かめる。trace の `fixtureSha256` は現行の freeze と照合する）。v1 の SP-N8 は v1 の freeze に対して成り立ち、v2 の SP-N8 は現行の freeze に対して成り立つ。v1 の内容を validator で検査し直す経路は無くなったが、sha の固定のほうが強い保証なので代わりになる。SP/1 の引用（:43、:46、:54、:95、:123、:133、:170）は実物と一致した。

---

## 4. 残る落ちる 24 件

`node --test scripts/quality/nir1-graph/*.test.mjs`（Node 24.18.0）：122 件中 98 pass、24 fail。出力は `g04c/graph-tap.txt`。

- 誤りの集合（#30、#72、#78、#86、#98、#103、#105、#106、#107。#33 は `[precheck]`）：8 件で、すべて `observation-prep.v1.json` のもの。`references.graphCaseFreeze`、`d1.runs`、`diagnosticRuns` の集合と `K24-G04-N1`、`boundFiles` の集合、v1 の path の 3 行。
- TypeError「Cannot set properties of undefined (setting 'commit')」の 13 件（#31、#32、#44、#45、#47、#48、#49、#50、#66、#67、#69、#74、#82）：`draftOf`（`observation-prep.test.mjs:93-108`）の `boundRow(p, file)` が現行の path の行を見つけられない。原因は S2 の `boundFiles`。
- #59「SP/1: the record binds…」：`observation-prep.test.mjs:1231` が S2 の `boundFiles` に現行の seed-pin の path を求め、S2 は v1 の path を持つ。新しく落ちた理由は S2 の `boundFiles` だと確かめた。
- **基点との比較**：`a7679acd` を `g04c/base` に写して実行した（GIT_DIR は worktree のもの）。119 件中 89 pass、30 fail で DR と一致した。直ったのは 7 件、新しく落ちたのは #59 の 1 件だけで、DR の記述と一致する。悪化はしていない。
- **隠れた誤りの模擬**：`g04c/sim` で S2 だけを手で pin し直した（`boundFiles` の 3 行の path と sha256、freeze の参照、`d1.runs` に G-04/base、`K24-G04-N1` の行）。この状態で `validateNir1ObservationPrep` が返す誤りは `setupReadings.source.pins t14-k64-freeze`（constants.mjs の bytes。B1 の `f3b34eb0`〜`d06f080e` が原因で、B2b-1 ではない）の 1 件だけになった。試験の失敗も、この 1 件と、写しに git が無いための 4 件（#89、#100、#108、#109 の `git show`）だけになった。setup、宣言、seed-pin の addendum と trace に、隠れた誤りは無い。
- `nir1-graph-eval` は 602/602。`node scripts/quality/eval-fixtures.mjs` は exit 1 で、落ちるのは nir1ObservationPrep の上の 8 件だけ（`g04c/evalfix.txt`）。

---

## 5. DR-CP4-G4-7 の B2b-1 の節

- 記述と diff は一致する（変えた葉、sha256、試験の数、直った 7 件と新しく落ちた 1 件、宣言の addendum v2 の sha の変化）。引いている行番号は基点 `a7679acd` のもので、実物と合う（`observation-prep.mjs:2465-2468`、`:1728-1734` 付近、`seed-pin-addendum.mjs:17-18`、`:181-189`、試験の :1212-1218）。
- 除外6項目：該当は無い。「新しい契約・authority」の欄に新しい版の 2 文書を並べたのは、開示を多めにする向きなので害は無い。K2/4 の 5 件目はユーザーの確認済み。
- (B-2)〜(B-6) に飛躍は無い。(B-1) の flag の読みだけが、上の P2-1 のとおり G4-6 (2) と食い違う。

### P3-3 B2a の節の sha256 が古いまま

`cp4-decisions.md:940` は宣言の addendum v2 の sha256 を `c3207d69…` と書いたまま。B2b-1 の節（:974）で変化を書いているので事実は追える。それでも、:940 の行に「B2b-1 で `8d6e967e…` に変わった」という参照を足すと、読み違えが起きにくい。

### P3-4 setup v2 の note の空白

`evals/nir1-g01/setup-addendum.v2.json:32` の「…一致）。 G-04 v2 を…」で、句点の後に半角空白が入っている。見た目だけの問題。

---

## 6. 見落としの検索

- `git grep` の結果：code の定数（`OBSERVATION_PREP_FILES.setupAddendum`、`SEED_PIN_ADDENDUM_PATH`、`S2_FILES.g01Addendum`、`S4_REHEARSAL_FILES`、`admission.test.mjs:1389`）は v2 に向いている。v1 の path は、`SEED_PIN_ADDENDUM_V1`、`SETUP_ADDENDUM_V1`、`supersedes`、frozen の file（v1 自身、trace 2 file、S2、S4 freeze 記録）、過去の設計文書にだけ残る。直すべきなのに漏れた code は無い。harness（`frozen-k64-run.mjs:1635`）は `S2_FILES.g01Addendum`（v2）を読む。v2 の宣言の行は v1 と同じ。
- `quality-manifest.yaml:695-696`、`:707-708`：v1 と v2 が並んでいる。宣言の addendum の並べ方と同じで、`impact-map.yaml:365-366` の glob が覆う。

### P3-5 B2b-2 への申し送りが、S2 に残る v1 の path を列挙しきれていない

S2 で v1 の path を持つ葉は 23 ある（葉を総なめにして数えた）。DR :979 の申し送りに無いのは次のもの。

- **`d1.addenda[0..1]`（`observation-prep.v1.json:57-60`）**：setup v1 と declaration v1 の path を持つ構造化された欄で、validator は照合しない（D1 の検査 `observation-prep.mjs:3542-3553` は choice だけを見る）。文ではないので、明示して v2 に直すか、検査を足すべき。
- `runnerHandoff[20]`（:817。setup v1 の `afterMutationReadings`）。runner に渡す指示の文。
- `diagnosticRuns[8].comparisonRule.switchRule`（:572。seed-pin v1）。
- `diagnosticRuns[4..6].source`（:430、:439、:448。declaration v1）。B2a の範囲だが、同じ pin し直しで扱う。
- `purpose`、`preconditions[3]`、`s4StagesRule`、`references.graphCaseFreeze`（freeze.v1 や S4 freeze 記録の名前。B2a と S4 の範囲）。

なお、「変えていない」と過去の事実を述べる文（例：:2373 の「seed-pin-addendum.v1.json の SP-P4 の check と SP-N7（変えていない）」）は、v1 のままが正しい場合がある。B2b-2 では、葉ごとに「v2 に直す」か「v1 の事実として残す」かを分けて記録することを勧める。

---

## 作業 file（すべて `/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/g04c/` の中）

`leafdiff.mjs`、`sp-diff.txt`、`setup-diff.txt`、`decl-base.json`、`mutate.mjs`、`filemut.mjs`、`sim-patch.mjs`、`graph-tap.txt`、`base-tap.txt`、`sim-tap.txt`、`evalfix.txt`、写し `full/`、`copy/`、`sim/`、`base/`（node_modules は worktree への symlink）。
