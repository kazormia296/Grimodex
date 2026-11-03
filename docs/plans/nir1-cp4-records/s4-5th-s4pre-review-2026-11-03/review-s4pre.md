# 5 回目の S4（S4b'''' の前）の独立レビュー（read-only、2026-11-03）

## 対象・読んだもの・実行したこと

- 対象：worktree `/home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th`（branch `claude/cp4-s4-5th`）。HEAD は `19fbcb8366cc63bcd317f465b5cda8e4a1b7f26b`（確認済み）、基点は master `a1cd6675`。範囲は `a1cd6675..HEAD` の 24 commit（`909b71b3` から `19fbcb83` まで）。`git ls-remote origin` の結果、remote の master は `a1cd6675` で、この枝は push されていない。
- 読んだ commit：上の 24 commit すべての差分。前例の `60bf9dc4`（S4b'''）、`179139b4`、`02ede6bb`、`c65e352d`、`cf1c83e3` の該当 file。contracts（`claude-contracts-freeze` の worktree、read-only）では `0423cfe0`（v3 のレビュー記録 3 file）、`ac2e93d6`（ユーザーの確認）、`8edd6496`（SP-N の記録の取り直しの規則と冒頭）、`56d4ec54`（hash だけ）、`5dea38af`・`665abc0f`（題だけ）、前例 `g04-v2c-s4pre-review-2026-11-02/review-s4pre.md` と `g04-v2c-gate-2026-11-02/review-gate.md` の該当行。K2/4 draft は :405-421 を読んだ（編集していない）。
- 読んでいないもの：測定の受領書（`gold-*`、`traces-*`、`negatives-*`、`s6-aggregation-*`、`s7-report-*`、`r5-check-*` の中身。`r5-check-record.json` は `git show | sha256sum` で hash だけを取った）と `.artifacts/`。Graph の runtime、Electron、build は走らせていない。
- 主要 file の SHA-256（HEAD の作業木の bytes）
  - S2 `evals/nir1-graph/observation-prep.v1.json`：`ecbad541f29dda5889bf0053d50523668b7c478aba9a6b1e517c341bf7ba0081`（draft。placeholder は 20 個）
  - v3 `evals/nir1-g01/setup-addendum.v3.json`：`dd1fb8721e5cf084025e22e4912912c5da7685074380cc14d9d824ff57a8082c`。v2 は `fd6b0c3c…84b8`、v1 は `ade7c402…1f46`
  - 作者の宣言：`07279a0e06577b11105c20f7876950a062f9b98931c4d8118f90d2e6c32062bc`
  - `observation-prep.mjs` は `41b201f2…6cef`、`observation-prep.test.mjs` は `0441c8c4…82b8`
  - `g01-negatives.mjs` は `800ba4a4…1a31`、`g01-negative-run.mjs` は `c134e680…6caa`、`g01-negative-preview.mjs` は `1679051d…c749`、`frozen-k64-admission.mjs` は `0723afc8…fd28`、`test-support.mjs` は `7e0342de…05fe`
  - manifest は `6678db99…92f7`、`cp4-decisions.md` は `01a21f0a…edf3`
- 実行したこと（Node 24.18.0。Node 22.23.3 は一部だけ）
  - `node --test --test-reporter=tap` の結果：`scripts/quality/nir1-graph/*.test.mjs` は 128/128（Node 22 でも 128/128）、`observation-prep.test.mjs` 単体は 85/85、`scripts/quality/nir1-graph-eval/*.test.mjs` は 611/611（Node 24 だけ）
  - scratchpad の道具（`s4-5th/rv/tools/`）を使った。どれも worktree の module を import するか git の object を読むだけで、file は書かない。
    - `leafdiff.py`：JSON の葉の比較
    - `pins.mjs`：pin の全件照合と、`assertSourcePins` を HEAD で直接呼ぶこと
    - `closure.mjs`：① の runner の静的 import の解決
    - `decl.mjs`：宣言と `READINGS_AFTER_DEV` の照合、メモリ上の変異 6 件
    - `v3mut.mjs`：v3 のメモリ上の変異 16 件
    - `rehearse.mjs`：S2 の placeholder をメモリ上で埋め、validator と形式の gate の参照の照合を当てること
  - 終了時の `git status --short` は空（下の「再現」に記録）。

## 結論：(b) 修正してから go

P1 は 1 件、P2 は 2 件、P3 は 6 件。

確かめた結果、次の点は事実と合い、緩和も admission で止まる箇所も無い。
- 失効は bytes どおり。
- v3 の凍結は 2 欄だけで、記録の hash は実在する。
- pin は 34 pin・72 path で食い違いが 0。`assertSourcePins` は通る。
- restore の地点は緩めていない（validator が完全一致で止める）。
- S4a'''' は pin の file に触れていない。
- SP-N・①・K6/4 の検出力・K6/4 の凍結・SP/1 は有効なまま。
- 埋め値の予行は、validator の誤り 0、形式の gate の参照の誤り 0。

S4b'''' の前に済ませることは次の 3 つ。
- **P1-1**：ユーザーへの未回答の問い（宣言の喪失の扱いを見直すかどうか）が開いている。返答を待つか、integrator が明示に判断してから凍結する。
- **P2-1**：K6/4 R5 の順について「ユーザーには事前に確認していない」と書いた開示が古いまま S2 に残り、旧 S4b''' の埋め値の文も同じ。
- **P2-2**：G-01 の v3 について、K2/4 :418 の記録がどれかを明示する。

---

## 指摘

### P1-1 ユーザーへの問いが開いたまま、S4b'''' で事前登録を固定することになる（gate）

- 根拠
  - 作者の宣言の `revisions[26]` の (3) は次のように書く。「その後の 2026-11-03 に、ユーザーは integrator に『前に出てた、「開き直しで宣言が失われる」っていうのはどういうことですか？』と自由記述で質問した。integrator は…選択（限界として開示）を見直すかと、dev で開き直しだけの確認をするかを尋ねた。この行を書いた時点で返答は無い」
  - DR-CP4-S4-8 の追記 4（`cp4-decisions.md`、`dr-tail.md` の :111）は「返答の内容によっては、C′（DR-CP4-S4-8 の代替案）の扱いと宣言の限界 (3) の文が変わりうる」と書く。
- 問題
  - ユーザーの確認 `ac2e93d6` の「一括」（4。範囲は merge まで）が覆うのは、当初の選択（限界として開示）で進めることまでである。その後に integrator 自身がユーザーへ投げ、まだ答えの無い設計の問いまでは覆っていない。
  - 返答が C′（開き直しの後に宣言が残ることを確かめる段）なら、harness が変わり、6 回目の凍結のやり直しになる。dev の確認で欠陥が見つかった場合も同じである。
  - S4b'''' が凍結した後は、事前登録を直せない。
- 直し方（分岐ごと。どの分岐でも code の変更は要らない）
  1. 返答が「限界として開示のまま」の場合：S4a'''' の追補（`revisions` の 1 行）で返答を記録し、それから S4b''''。この場合、作者の宣言の sha256（`07279a0e…`）が変わるので、下の表の作者の宣言の commit と sha256 は**追補の後に取り直す**。
  2. 返答が「dev での開き直しだけの確認をする」の場合：harness を変えずに走らせ、結果を DR と宣言の追補に書いてから S4b''''。値は 1 と同じく取り直す。
  3. 返答が「C′ を足す」の場合：止める。harness の変更から凍結の順をやり直す。
  4. 返答が無いまま進める場合：integrator の明示の判断として、DR に「`ac2e93d6` の選択で進め、問いは開いたまま。答えは S7 とユーザー通知に書く」と記録する。この場合、宣言の「この行を書いた時点で返答は無い」は真のままなので、admission の上では許される。ただし既定の道にはしない。

### P2-1 R5 の順の開示が古い（S2 `g04RevisionReadings.limits (i)` と、旧 `S4:r5-check-record` の文）

- 根拠
  - S2 の `g04RevisionReadings.limits` の (i) の末尾は「ユーザーには事前に確認していない。確認済みの契約の順序条項からの逸脱で、ユーザーの異議があれば止める（DR-CP4-S4-7 の追記 2）」。
  - 旧 S4b'''（`60bf9dc4`）の `r5Gate.r5CheckRecord` の埋め値も「ユーザーには事前に確認していない。異議があれば止める」と書き、「integrator の指示で S4b''' を候補 179139b4 の子にした」と書く。
- 事実
  - contracts の `665abc0f`（2026-11-02 06:46 JST。S4b''' の 00:32 の後）は、題が「ユーザーの確認 — K6/4 の R5 の順からの逸脱を認め、開示して正式の測定を始める」。DR-CP4-S6-2 の (8) も「ユーザーが認めた。contracts `665abc0f`」と書く。
  - `ac2e93d6` は再承認である（「同じ逸脱を再承認する (推奨)」）。
  - `665abc0f` は、S2、v3、作者の宣言のどこにも引かれていない（grep で 0 件。`cp4-decisions.md` だけが 1 件）。S2 の (h) は「再承認」と書くので、同じ file の中で (i) と (h) が食い違って読める。
- 影響
  - このまま凍結すると、凍結の時点で偽になった開示（「確認していない」）が事前登録に残る。
  - 機械の門はこの文を見ない。validator が (i) に求めるのは語「ユーザーの異議があれば止める」の存在だけである（`observation-prep.mjs:1720`）。また、旧 S4b''' の SP-N の記録の文をそのまま入れても `observationPrepErrors` は 0 件だった（`rehearse.mjs` の M-old-spn-record-text）。つまり記録の文は手順でしか守られない。
- 直し方
  - S2 の (i) に、「その後、ユーザーが `665abc0f` で認め、`ac2e93d6` で新しい S4b'''' と候補にも再承認した（① の記録 `56d4ec54` をそのまま使い、① の閉包を変えないことが前提）」の 1 文を足す。足すだけなので、語の検査は通る。S4b'''' の葉の差の確認に (i) の 1 葉が加わる。
  - `S4:r5-check-record` の文は、旧文を写さずに書き直す。
    - 「事前に確認していない」の文を外し、`665abc0f`・`ac2e93d6` を書く。
    - 「S4b''' を候補 179139b4 の子にした」は、「① の候補は `179139b4`。新しい候補は `a1cd6675` の子孫の枝の S4b'''' の子で、① の閉包の file は `179139b4` から不変」に置き換える。
    - 「13 の受領書の sha256 が `gate.rows` と一致する（S4b''' で確かめた）」は、S4b'''' でもう一度確かめて書く（このレビューは受領書を開いていない）。
  - 再レビューは要らない。葉の差の目視で足りる。

### P2-2 G-01 の setup addendum v3 について、K2/4 :418 の記録がどれかを書いていない

- 根拠
  - K2/4（`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md`。sha256 `efc30cca…`。最終更新は `a0ce11aa` で、この枝では不変）の :418 は、「期待値を独立した reviewer が確かめた記録をその commit に束縛する」「reviewer が確かめるのは、4 つの Scene が v1 の subset で宣言できること…、宣言の段が freeze 済みの期待値、前提条件、setupTimeline を変えないこと、診断用の負例」「観測前の commit が書き足すのは、宣言の場所（(i) か (ii)）と、B の seal の手順…だけで、どちらも期待値を変えない」と書く。
  - :419 は、改版のときは「同じ手順で」新しい版を作ると書く。
- 事実
  - v1 の review は S3 の 7 回目（`a1fd9f64`、`d0b33ab5…`）で、これが G-01 の :418 の記録である。v2 と v3 の review はどちらも独立コードレビューで、v3 は「S3 の独立レビューでも、fixture の独立期待値レビューでもない」と書く（正直な記述）。
  - v3 のレビューの記録（`review-v3.md`、`89c738f2…`）の §5 は、K2/4 :416・:534 との一致と「B の seal の手順（観測前の commit が書き足す）の範囲の読み」を確かめている。ただし、:418 の 3 点として確かめたとは書いていない。grep で `review-v3.md` に「:418」は 0 件。
  - v3 の変更は、:418 の分類では「B の seal の手順」であり、期待値の側ではない。v3 の review が確かめた readBack（v3 から v2 へ。v2 は v1 の写し）で、宣言の行・値・負例の期待は v1 と同じに保たれる。私も、v3 から v2 への readBack と validator の変異（負例の期待・`declarationValues` を変えると落ちる）で確かめた。したがって実質は満たされている。
  - しかし、凍結される文書のどこにも「G-01 の :418 の記録は v1 の S3 の 7 回目で、v3 の差は :418 の『B の seal の手順』に当たり、その手順は S3 が見ていない」とまとめた文が無い。S2 の `limits (f)` が :418 の束縛を書くのは、宣言の addendum v2 についてだけである。前例の P2-1（束縛した記録が :418 の記録ではない）と同じ型の空白が、G-01 の側に残っている。
- 直し方：S4b'''' で S2 の `review.conditions`（または `s4StagesRule (h)`）に、上の 1 文を足す。v3 の bytes は変えない。

### P3-1 宣言の addendum v2 の :198 は setup addendum の **v2** を名指す（未開示）

- `declaration-addendum.v2.json:198`：「G-01 の addendum（evals/nir1-g01/setup-addendum.v2.json）と同じ選択」。
- v3 の `declarationPlace.choice` は `ii` で同じ値なので、矛盾ではない。ただし S2・v3・作者の宣言のどれもこの点を開示していない。前例の P2-3（trace が古い版を名指す）と同じ型である。
- 直し方：S4b'''' の S2 の `review.conditions` か、宣言の追補に 1 文を足す。

### P3-2 SP-N の取り直しが、DR (5) と `ac2e93d6` の 4 の順（S4b'''' の前の独立レビューの後）より前に行われた

- `8edd6496` の候補は `ddccf426` で、このレビューより前である。
- 今は有効：`git diff --name-only ddccf426..HEAD` の結果は `cp4-decisions.md`、作者の宣言、`observation-prep.mjs`、`observation-prep.test.mjs` の 4 file だけで、規則の 16 file（13 file と試験 3 file）は 1 つも無い。
- このレビューの指摘を直す段（P1-1 の追補、P2-1、P2-2）は、規則の file に触れない。S4b'''' の直前に同じ照合をもう一度行い、順の違いを DR に 1 行書く。

### P3-3 ① の閉包の file の数

- DR-CP4-S4-8 の (6) と `ac2e93d6` は「閉包 43 file」と書く。
- 私が静的 import を解決すると 42 file だった（`closure.mjs`）。dynamic import で読む `electron/scripts/build.mjs` を足すと 43 になる。
- どれも `179139b4..HEAD` で不変（`git diff --name-only` が空）。結論は変わらないが、数え方を記録に書く。

### P3-4 機械の門の外にある文（既知の残る穴の再確認）

メモリ上の変異で、次の書き換えは validator を通った。
- v3 の `limits (iv)` の本文を弱める。
- 作者の宣言から `revisions` の 2026-11-03 の 2 行を消す。
- `graphRuntimeOutputObservedScope` の追記を削る。
- 旧い SP-N の記録の文を入れる。

凍結の後は sha256 の束縛で守られるが、凍結の前の文の正しさは手順でしか守られない（前例の残る穴 (d) と同じ）。S4b'''' の葉の比較で、埋めた文を 1 つずつ目視する。

### P3-5 作者の宣言の `forbiddenFilesNotRead: true` と、`revisions[25]` の「contracts の nir1-cp4-records/ の 5 file を読んだ」

- 字義の上では緊張がある。
- 前例の S4a''' と同じ形で、最終関門もこれを受け入れた。`revisions` の文が読んだ範囲を開示している。前例どおりとして扱う。

### P3-6 v3 の `reviewPlan` が「limits の開示 (i)〜(vi)」と書く（実際は (viii) まで）

- 既知の点で、作者の宣言の限界 (4) に開示されている。凍結済みなので直さない、という判断に同意する。

---

## 確かめたこと（項目ごと）

### 1. 失効（`0d456ee2`）

- `git show --name-status 0d456ee2` の結果は次のとおり。
  - D `observation-prep-freeze.v1.json`
  - M S2、manifest、`observation-prep.test.mjs`
- S2 は `60bf9dc4` で `9cc881ba…` だった。`0d456ee2` で `722301ad7da36661…` になり、`179139b4` の S2 と同じ値である。
- `observation-prep.test.mjs` は `2510f535…` から `f9884557…`（`179139b4` と同じ）に戻った。
- manifest は `0d456ee2^`（`b02a8f14` が行を足した版）の `e6cecc90…` から `6a63c6d0…`（`179139b4` と同じ）に戻った。
- `git diff --stat 179139b4 0d456ee2 -- evals/nir1-graph evals/quality-manifest.yaml scripts/quality/nir1-graph` は空。つまり bytes が完全に一致する。
- 契約（`admission.mjs`、`nir1-graph/contract.mjs`）のほか、`constants.mjs`、`receipt.mjs`、`workspace-db.mjs`、`frozen-setup-driver.mjs` も、`a1cd6675..HEAD` で差分が無い。

### 2. v3 の凍結（`bfc5a609`）

- `38b464ea` から `bfc5a609` への葉の差（312 葉から 317 葉）は、`status`（draft から `frozen-after-independent-review` へ）と、`review`（null から 6 葉の object へ）だけである。
- sha256 の列は記録と一致する。
  - `e112d2dc`：`54b69bc2…`
  - `7b128636`：`5578c526…`
  - `38b464ea`：`cd1358cc…`
  - `bfc5a609` と HEAD：`dd1fb872…`
- 記録の実在：contracts の `0423cfe0` は 2026-11-03 10:37 で、ブランチは detached。次の hash は review の文と一致する。
  - `review-v3.md`：`89c738f2…`
  - `review-v3-recheck.md`：`ba322452…`
  - README：`d93bf53d…`。README の hash は review に書かれていないが、要旨なので必須ではない。
- 判定の文の確認：本レビューの判定は (b)、P2×4、P3×8 で、再確認の判定は (a)、任意の P3×3 である。v3 の review の文と合う。
- 見直していない直し（`38b464ea`）の確認：葉の差は次の 4 つである。
  - `limits[0]`（(i) の括弧）
  - `limits[6]`（(vii) の引用元と評価の語）
  - `freshnessSettle.limit` と `interval` を名前だけにした
  - `limitMs` 60000 と `intervalMs` 250 のキーを足した
  - キーの追加は `sealPoints` の中にあり、validator の `g01SealPoints(c)` が pin した driver の定数と完全一致で照合する（変異「limitMs 120000」は落ちた）。
- review の文は「この 3 件の直しを reviewer は見直していない」と太字で書いている。正直に書かれている。再確認の文書の「キーを変えるなら supersedes.rule と #12 の validator に合わせる」は、`supersedes.rule` が `sealPoints` を丸ごと挙げ、#12 が照合しているので満たされている。

### 3. K2/4 の確認（:410-421）

- K2/4 の draft は sha256 `efc30cca…` で、この枝で不変。編集していない。
- v3 の review の型は v2 と同じ（独立コードレビュー）。最終関門は v2 のこの型を受け入れた（`review-gate.md`:43）。
- v3 の変更は、:418 の分類では「観測前の commit が書き足す B の seal の手順」である。期待値・宣言の値・負例の期待・`declarationValues` は、readBack で v2（と v1）と同じ（P2-2 の「事実」）。束縛の文が無い点だけが P2-2 である。
- 宣言の addendum v2（`bbe3379f…`。最後に変えた commit は `fdb1fc9b`）と seed-pin v2（`3e4334cc…`。同じく `c65e352d`）は、この枝で bytes が不変。seed-pin v2 は setup addendum を名指さない。宣言 v2 は :198 で v2 を名指すが、同じ値である（P3-1）。矛盾は無い。
- quality-manifest：v3 の行を足し、freeze record の行を外した（S4b'''' の後の manifest の commit で戻す）。`impact-map.yaml:365` は `evals/nir1-g01/**` で v3 を含む。

### 4. S2 追補 #12 と validator

- **pin（`pins.mjs`）**
  - `SOURCE_PINS` は 34 pin、S2 の pins も 34 で、順・role・commit・check・paths が一致する。
  - bytes の path は 72。どの path も、pin の commit が HEAD でその path を最後に変えた commit（`git log -1 HEAD -- <path>`）と一致し、`git show <pin>:<path>`、HEAD の bytes、作業木、S2 の行の sha256 が同じである。pin の commit はどれも HEAD の祖先で、同じ path の重複は 0、**食い違いは 0**。
  - 新しい pin は `s4-5-g01-reseal-current`（`f31d99e0`、3 file）と `s4-5-addendum-v3-paths`（`ee43c197`、1 file）。`sp-p4-ir-timeout` と `g4-b2b1-addendum-v2-paths` は ancestor の pin になった（`files: []`）。
- **`assertSourcePins` を HEAD の full sha で直接呼んだ**：34 件、そのうち bytes は 26 件で通った。
- **S4a'''' とその後の commit は pin の file を変えていない**：`8599a51e`、`640743d0`、`e2c23781`、`2cad25f3`、`383133bb`、`bfc5a609`、`0d456ee2`、`38b464ea`、`7b128636` の変更 file に、pin の 72 path は 0 件。
- **`sealPoints`・`records` の完全一致（`v3mut.mjs`）**：次の変異はすべて落ちた。
  - restore の `passes` に `unchanged` を足す
  - restore で静止を待つ
  - restore に N2 の地点を足す
  - `previous-not-dirty` を外す
  - `limitMs` を 120000 にする
  - `records` にキーを足す
  - `reopensMax` 3、`waitMs` 240000、N2 の期待の書き換え、`declarationValues` の書き換え、blocked の reason の追加。これらは readBack の後の v2 との照合で落ちた。
  - `limits` から (viii) を消す
  - status を draft に戻す、review を null にする、supersedes の sha を v1 にする
  - 通ったのは `limits (iv)` の文を弱めた 1 件だけ（P3-4）。
- **restore の地点は `new-generation` だけ**：`g01SealPoints().restore.passes` は `["new-generation"]` で、`freshnessSettle` は `"not-waited"`。実装も同じである。`g01SealBranch` は `allowUnchanged` が false なら A-1 だけ（`g01-negatives.mjs:162-171`）。`runG01NegativeStep` の `bodyOnly` は `spec.mutation === "resave-same-body"` のときだけ（:650、:660）。N4 の宣言の前は wrapper が明示に `allowUnchanged: true` を渡す（`g01-negative-run.mjs:174`）。
- **v3 から v2 への readBack**：`SETUP_V2_COPY.readBack` は status の句と追加の 1 文、3 つの `measurementProcess` の句をそれぞれ 1 回だけ戻し、`rule`・`sealRule`・`measurementPoint`・`reviewPlan` を v2 の値にし、足した 4 キーを消す。base の v3 は誤り 0。
- **v1 の行の復活（gate）**：`supersededReferences` に v1（`cf1c83e3`、`ade7c402…`）の行がある。`rehearse.mjs` の 14 行の参照（v2 は `c65e352d`、v1 3 行は `cf1c83e3`）は、`formalReferenceErrors(head=HEAD)` で 0 件だった。validator も、v1 の作業木の bytes、`SETUP_ADDENDUM_V1_COMMIT`、git の blob を見る。
- `validateNir1ObservationPrep` を HEAD で走らせた結果：passed、誤り 0、formalReady false、placeholder 20。

### 5. S4a''''（`ddccf426..HEAD` の作者の宣言）

- 足した葉は 4 つ。`graphRuntimeOutputObservedScope` の追記 1 節、`revisions[25]`・`[26]`、`readingsChosenAfterDevObservation[13]`（`seal-rule-after-blocked`）。全文を読んだ。
- **(a) 事実でない記述、評価の語、出典のない主張**：次の点は、DR-CP4-S6-2・LPD-1・S4-8 と contracts の題に合う。
  - 数値：失効 8/201・15/201、窓外 20/201、物差し 1%、pool の欠落 0、N3 は established、N2 と N4 は blocked
  - 経緯：LP-A1 #776 `8dd7a9c0`、LP-GATE #777 `2014ac50`、#778 `a1cd6675`、dev の予告の候補 `fcea1624`、4 回のレビューと reviewer の書き分け
  - 評価の語は見当たらない。出典が repo に無い事実（ユーザーの質問）は、出典が無いことを明記している。
  - sha256 は記録どおり：`8599a51e` は `3acd86d7…`、`640743d0` は `07279a0e…`。
- **(b) 開示**
  - DR (8) の 5 項目：X1-5 への依存は (1)、「B が current」の意味の変更は (2)、blocked の後の変更は `seal-rule-after-blocked` の basis、宣言の喪失は (3)、X1-5 の下の前提の記録が無いことは (5)。
  - restore を緩めていないこと：reading と basis に書いてある。
  - 診断 run の件数：第 1・2 回は各 11/201、第 3〜5 回は 1/603、dev 専用。
  - ユーザーの質問と返答待ち：(3)。
  - K6/4 R5 の順の再承認：(6)。
  - 足りないのは、`665abc0f` を引いていないこと（P2-1）と、宣言の addendum v2 の :198（P3-1）。
- **(c) flag**：`graphRuntimeOutputObserved: false` は「S2 の作者（2026-10-27〜10-31 の起草と追補）についての申告」で、その後の読みは revisions、`seal-rule-after-blocked`（「凍結した G-case の Graph の実行出力（N2／N4 の blocked）を見た後の読み」）、v3 の limits (iv) に開示している。前例の S4a''' と同じ形（`8599a51e~1` の文と同じ構文）で、validator は true を拒む（変異「flag true」は落ちる）。整合している。
- **(d) `READINGS_AFTER_DEV`**：validator の 14 件と宣言の 14 件が、順まで同じ。`authorDeclarationErrors` は 0 件。新しい行を抜く、`chosenBy` や `basis` を空にする変異は、それぞれ 1 件の誤りで落ちる。

### 6. 取り直しが要る記録の一覧

| 記録 | 判定 | 根拠 |
|---|---|---|
| SP-N（②'。contracts `8edd6496`、file `5d72cefe…`、候補 `ddccf426`） | **有効**（P3-2 の順の違いを記録） | 規則（`sp-synthetic-detection-record.md`:72）の 13 file と試験 3 file は、`ddccf426..HEAD` で 1 つも変わっていない（`git diff --name-only` は 4 file で、どれも規則の外）。`179139b4..ddccf426` で変わったのは `test-support.mjs` の 1 file だけ |
| ① R5（`56d4ec54`、`r5-check-record.json` `fa04baa4…`、候補 `179139b4`） | **有効**（文は P2-1 で書き直す） | `r5-check-runner.mjs` の静的 import の閉包は 42 file で、dynamic の `electron/scripts/build.mjs` を足すと 43。`179139b4..HEAD` で変更は 0。閉包の中に setup addendum や S2 を読む箇所は無い |
| K6/4 の検出力（`k64-synthetic-detection-record.md`、候補 `86427ee5`） | 規則の上は有効。DR (6) のとおり、候補が決まった後に取り直す | 規則の 5 file（`followup`・`outcome`・`availability`・`window`・`receipt`）は `86427ee5..HEAD` で不変 |
| K6/4 の凍結 `5dea38af` | 有効 | `constants.mjs` の `K64_FREEZE.freezeCommit` は `5dea38af158283c2…` で、K6/4 の draft の sha256 は `d205b35f…`（HEAD でも同じ） |
| SP/1 の bytes `cd04629e` | 有効 | SP/1 の draft の sha256 は `8ccdf534…`。`cd04629e` と HEAD で同じで、最後に変えた commit は `cd04629e` |
| trace 2 件、宣言 v2、seed-pin v2、K6/4 の手順 v1 | 有効 | 下の表のとおり、bytes は旧 S4b''' と同じ |

### 7. S4b'''' の placeholder 20 個の埋め値

S4a'''' の最後の bytes を持つ commit は `640743d0bcd5…`（作者の宣言を最後に変えた commit。19fbcb83 は DR だけ）。前例は、6 file と K6/4 の手順の commit を 1 つ（S4a''' の `02ede6bb`）に揃えた。この表も `640743d0` に揃える。v3 だけを `bfc5a609` にしても、gate は通る。`rehearse.mjs` で、この表の値と旧 S4b''' の review・formal.review を入れた S2 は、`observationPrepErrors` 0、`formalReferenceErrors(head=HEAD)` 0、`sourcePinGitErrors` 0 だった。

**変わるもの**

| token | 候補の値 | 根拠 |
|---|---|---|
| `S4:setup-addendum-commit`／`-sha256` | `640743d0…`（または `bfc5a609…`）／`dd1fb8721e5cf084025e22e4912912c5da7685074380cc14d9d824ff57a8082c` | path は v3（`boundFiles[0].path` は追補 #12 で v3 にした）。v3 を最後に変えた commit は `bfc5a609` |
| `S4:author-declaration-commit`／`-sha256` | `640743d0…`／`07279a0e06577b11105c20f7876950a062f9b98931c4d8118f90d2e6c32062bc`。**P1-1 の分岐 1・2 なら、追補の後に取り直す** | 旧 S4b''' の値は `99c6e387…` |
| `S4:sp-synthetic-detection-record` | contracts `8edd6496…` の `sp-synthetic-detection-record.md`、`5d72cefea1fa98d80253f199e2f8878d10306a742e8cb1e79e05a6df98f00735`、候補 `ddccf4268d57…`（tree `19adb6a0…`）。文は旧文を写さずに書く | 旧 S4b''' の値は `20ccd115`、`aef7c0a1…` |
| `S4:r5-check-record` | 値は旧と同じで、`56d4ec54…` の `r5-check-r5-1102/r5-check-record.json`、`fa04baa444163b89d76beae467120366c5da55ca8e77a827eb597b06ad601f90`、run `8fb525ed…`。**文は P2-1 のとおり書き直す** | DR (6) は「有効のまま」。①の候補（`179139b4`）と新しい候補の関係、`665abc0f`・`ac2e93d6` を書く |

**前回と同じもの**（根拠は、HEAD の bytes が旧 S4b''' の埋め値と同じで、最後に変えた commit が枝より前にあること）

| token | 値 | 根拠 |
|---|---|---|
| `S4:trace-editing-commit`／`-sha256` | `640743d0…`（`02ede6bb` も可）／`7e72a040104dee7a90493ad7a353cfc883f1671197febd1c4f0e34a7dbfcbd0d` | 最後に変えた commit は `cf1c83e3` |
| `S4:trace-browsing-commit`／`-sha256` | 同上／`54e5e39153f4157da5244c1d0dab3b4528c6ab55d692e6a1c19263e44de47347` | 同上 |
| `S4:declaration-addendum-commit`／`-sha256` | 同上／`bbe3379fc519ae4d67fc7b79a6458c46c92efedbd530aa8b788a66a9f3e80699` | 最後に変えた commit は `fdb1fc9b` |
| `S4:seed-pin-addendum-commit`／`-sha256` | 同上／`3e4334cc358070d2dfc963420b748b85334014071a264d34bc2d03ee2c215b1b` | 最後に変えた commit は `c65e352d` |
| `S4:k64-procedure-v1-commit`／`-sha256` | 同上／`1c2428df322fa717d1a3ae5d4c99fb2dbafcbac2c8fb5b4126499dcc36cc0bea` | 最後に変えた commit は `17d9cc09` |
| `S4:k64-freeze-commit` | `5dea38af158283c2a925d68ef0d8b0771c0ea209` | `constants.mjs` と一致。別の値にすると validator が 1 件落とす |
| `S4:sp1-bytes-commit` | `cd04629e5f182abd51ded1af565c169ba919dc34` | SP/1 の sha256 は不変 |
| `S4:da1-acceptance-record`／`S4:g01-r-rir-mode` | `none`／`unrestricted` | この枝は d10 を変えていない（`rAndRirModeRule`） |

**placeholder ではないが、S4b'''' で正しく書く必要があるもの**

- S2 の `status` は `frozen-before-observation`。
- S2 の `review` は S3 の 7 回目（`a1fd9f64`、`d0b33ab5…`）。`conditions` の「その後に変わり S3 が見ていない」の列挙に、次を足す：追補 #11 とその訂正、旧 S4b'''（`60bf9dc4`）、失効 `0d456ee2`、追補 #12（`383133bb`・`2cad25f3`・`e2c23781`）、S4a''''（`8599a51e`・`640743d0`）。あわせて P2-2 の :418 の 1 文、P3-1 の :198 の 1 文を書く。`k64Procedure.formal.review` は前回と同じ。
- freeze record（`observation-prep-freeze.v1.json`）は次のとおり。
  - `graphRuntimeObservedBeforeFreeze: false`（`nir1-retrieval/contract.mjs:473` が false を求める。字義と事実の食い違いは既知で、宣言に開示済み）
  - `k62` は `af643a93`、`4ccca083…`（不変）
  - `graphCaseFreeze` は `freeze.v2.json` の `8958dc73…`（不変）
  - `g01Fixture` は `996ef1c0…`（不変）
  - `boundFiles` の 8 件は、S2（新しい frozen の sha）、**v3 の path（`dd1fb872…`）。v2 ではない**、宣言 v2、trace 2 件、作者の宣言（新しい値）、seed-pin v2、K6/4 の手順 v1。`readS2AtCommit` は `S2_FILES.g01Addendum`（v3）を `readFreezeBoundFile` で読むので、v2 の path を束縛すると admission で止まる。
- manifest の commit（前例は `b02a8f14`）で、GDX-GROUND-001 の evidence に freeze record の行を戻す。

### 8. 範囲と安全

- `git diff --name-only a1cd6675..HEAD` の結果は、`evals/` の 5 file（v3、作者の宣言、freeze record の削除、S2、manifest）、`scripts/quality/` の 11 file、`cp4-decisions.md`、`nir1-continuation-2026-10.md` だけである。製品のコード、`AGENTS.md`、`.agents/`、`policies/`、K6・K2・SP・NC-1・Y-1 の draft、`ipcContract.ts`、契約は含まない。
- harness の定数の値は変わっていない（差分の grep で、`*_MS`・`ATTEMPTS`・`REOPENS` の代入の変更は 0）。閾値・Gold・pool・δ・F6／X5・読み・負例の期待も変わっていない（readBack と変異で確かめた）。
- 新しい送信先、保存範囲の拡大、契約、authority は無い。新しく読むのは feed の読取り（`readFreshnessFeed`。測定の DB の read-only）だけである。
- 「規則の変更は blocked を見た後」であることは、DR・v3 (iv)・宣言のすべてに書かれている。

### 9. DR の記述と実装の一致

照合して一致したもの：
- S2 の sha256：`383133bb` は `b7db200b`、`2cad25f3` は `15410b5b`、`e2c23781` は `ecbad541`。
- `observation-prep.mjs` は `e2c23781` で `71bac435…`。
- 作者の宣言は `3acd86d7` から `07279a0e`。
- v3 の sha256 の列（上の 2.）。
- pin は 34・72。
- 試験の件数：128/128、611/611、85/85 を再現した。

DR の行の形：DR-CP4-S4-8（:875）と P-8（:855）は、見出しの 10 列（ID〜状態）に合う。

数の食い違い：P3-3 の 43／42 だけ。

DR の追記の変異（(a)〜(l)、(p)〜(t)）は、file を書き換えて戻す方式で行われたと書かれている。私はそれを再現せず、メモリ上の変異で代えた（上の 4.）。

### 10. S4b'''' の後の検証 (i)〜(vi) の手順への追加

前例（DR-CP4-S4-7 の「S4b''' の結果」）の手順に、次を足す。

- **合成の M**：今は remote の master が `a1cd6675` のまま（`ls-remote`）。PR の merge の直前に、もう一度確かめる。master が進んでいたら、M をその master と枝の先頭で作り直し、次を実の merge base でやり直す：規則の 16 file、① の閉包、K6/4 の 5 file、pin の 72 path（「M で最後に変えた commit が pin の commit」）。
- **(ii)**：旧 S4b''、旧 S4b'、旧 S4b に加えて、**旧 S4b'''（`60bf9dc4`）**を commit にして head=M とし、「record differs」で止まることを確かめる。
- **(iv)**：「did not introduce」で止まる commit に、次を足す：`0d456ee2`、`bfc5a609`、`e2c23781`、`640743d0`、`19fbcb83`、manifest の commit、M。
- **(iii)**：pin の照合は、M の上で 34 pin・72 path を全件行う。枝の pin（`f31d99e0`、`ee43c197`）と前回の枝の pin が M の祖先であることも見る。
- **束縛の正負**：`readFreezeBoundFile` が v3 の path で通り、`evals/nir1-g01/setup-addendum.v2.json` で「does not bind」で止まることを確かめる。`admitFormalK64Run` の前段の `readS2AtCommit` も M で通ること。
- **試験**：`observation-prep.test.mjs` は lightTest で `test:quality` の外なので、明示に走らせる。走らせる場所は、worktree の HEAD（S4b'''' の子）と、clone の M（`origin/master`＝M）の 2 か所。M では枝の pin が master の祖先として扱われ、pin の試験の target の表の経路が変わる（追記 3 の「想定と違ったこと」）。Node 24 と 22 の両方で走らせる。
  - nir1-graph-eval の 611 件も、Node 22 で走らせる（このレビューでは未実行）。
  - `admission.test.mjs` は、S4b'''' を HEAD にすると P1-1 の 1 件だけが落ちる（既知）。
- **(vi)**：`git diff 640743d0..<枝の先頭> --stat` が、S2、freeze record、manifest の 1 行、`observation-prep.test.mjs`（S4b'''' の試験の名前を直す場合）だけであること。
- **merge の後**：master の上で、`eval-fixtures.mjs` と `observation-prep.test.mjs` をもう一度走らせる。① は製品の標準 build を使うので、候補の製品が ① の `179139b4` の製品と違うことを、S7 と ① の文に書く（前例の補足）。

---

## 未確認（このレビューで確かめていないこと）

- nir1-graph-eval の試験を Node 22 で走らせること。
- 受領書の中身：① の 13 の受領書と `gate.rows` の照合、`results-ddccf426.json`、`r5-check-record.json` の本文。
- `review-v3.md` の本文の主張を、実装の行で再検証すること（§2 の表は読んだ。行番号は HEAD とずれていない範囲で照合した）。
- dev の予告の実行の出力。DR の表だけを読んだ。
- 宣言の喪失の製品の挙動（P1-1 の問いの中身）。
- 製品の writer の veto の実装、Graph runtime の挙動。
- 前の段のレビュー（harness、追補 #12）の記録の本文。DR の要約だけを読んだ。

## 再現

- 道具は scratchpad の `s4-5th/rv/tools/` にある。どれも `eval "$(fnm env --shell bash)"; node <tool>` で走らせる。
  - 葉の比較：`python3 -I rv/tools/leafdiff.py <a> <b> <path> [full]`
  - pin の全件照合と `assertSourcePins`：`node rv/tools/pins.mjs`
  - ① の閉包：`node rv/tools/closure.mjs scripts/quality/nir1-graph-eval/r5-check-runner.mjs 179139b4 list`
  - 宣言と `READINGS_AFTER_DEV`：`node rv/tools/decl.mjs`
  - v3 の変異：`node rv/tools/v3mut.mjs`
  - 埋め値の予行：`node rv/tools/rehearse.mjs 640743d0`
- どの道具も、worktree の validator を import するか、git の object を読むだけで、file は書かない。
- 終了時の `git -C /home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th status --short` は空。
