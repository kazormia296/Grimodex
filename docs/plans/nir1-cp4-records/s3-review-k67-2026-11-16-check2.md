# S3 の 10 回目の、反映の後の再確認（K6/7、`55885c62..140bdda2`。2026-11-16）

**この file の出所**：S3 の独立 reviewer（Claude の agent、Opus 5.5、read-only）の報告。ユーザーの確認ではない。file の変更・commit・build・run の起動はしていない（書いたのはこの 1 file だけ）。行ったのは、git の object と作業木の読み、contracts の bytes の SHA-256 の再計算、GitHub の activity API の読み取り 2 回、dev gate の受領書の ID の構造の読み（値に v3 は当てていない）、validator の読むだけの実行（前例どおり。試験の file は回していない）。

- **判定：changes-required**（必須 1、推奨 7）
  - 必須の 1 件は、6 commit が入れたものではない（判定 file の `db7c1234` からある性質）。この再確認で、ID が Revision をまたいで重なることが実受領書の形で確かめられ、表に出た。指摘の B1・B2 は、B2-4・B2-5 の残りを除いて閉じている。
- 対象：枝 `claude/s4-9-pr3`（worktree `/home/grimodex/worktrees/Grimodex/s4-9-pr3`、HEAD `140bdda2`。`origin/claude/s4-9-pr3` と一致し、作業木は clean）、`55885c62..140bdda2` の 6 commit（`11d5e430`・`c24337ee`・`3623b00f`・`44595441`・`e03760eb`・`140bdda2`）。
- 正本：S3 の記録（contracts `4aa34626`、SHA-256 `fba38a31…`）、v3（`160f5fa5`、`b6166ed2…`）、確認の記録（`7361041f`、`9173e5e5…`）、`drift-ownerready.md`。

## 問 1：B1・B2 は閉じたか

| 指摘 | 結果 | 根拠 |
|---|---|---|
| B1-1 `7361041f` の反映 | **閉じた** | `observation-prep.v1.json:136-148`（5 行目。commit `7361041f62cf…`、sha256 `9173e5e5…`。sha256 は contracts の bytes から再計算して一致）、`additionalNote`「additional の 5 行」、`observation-prep.mjs:274-283`（`K67_CONFIRMATION_RECORDS.additional` の 5 行目）と `:5508` の誤りの文（five answers）。(l)(3)・fill（`v1.json:934`）・(k)（`:1080`）は「11 file で前回の記録を使う。11 file の外が変わっていたら改めて伺う」になった。`K67_LIMIT_WORDS` に `7361041f`・`11 file の外`。試験は `observation-prep.test.mjs` の additional[4] の sha256・topic の変異と、frozen の scope の `7361041f`。宣言の `k67-harness-and-dev-ab-choices` と DR-DBC-7（`db-connection-decisions.md:950`）にも、問 2 の事実（示さずに伺っていた、再回答、止まる条件）が入った |
| B1-2 path 単位の `hold` | **閉じた**（S3 が示した直し方のとおり）。ただし、同じ箇所に**新しい問題**がある（必須 1） | `quality-evidence-items.mjs:228-238`（`continue` をやめ、読めない Revision を数える）、`:272-282`（読めた Revision のどれにも無く、読めない Revision がある行だけ `evidence-id-in-no-read-revision` の `hold`）、`:283-291`（全部読めていれば従来どおり (ii) の `fail`）。試験は `quality-verdict.test.mjs` の (a)(a2)(b)(c)(c2)(d) と known |
| B1-3 §2.3 の field の読み | **閉じた** | `v1.json:461` の (m)。5 条件は `quality-evidence-items.mjs:482-493` と一致（`sample.irOutcome`・`child.origin`・`sceneId`・`seed`・`queryGeneration` の `<=` で hold）。`fetches[1]`、counter の差を条件にしない理由、名前の対応（`K67_QUALITY_VERDICT_V3`、`--v3-file`・`--v3-commit`・`--impl-commit`、§5 の仮名と実名）も書いてある。`K67_LIMIT_WORDS` に `queryGeneration`・`irOutcome`・`fetches[1]` |
| B2-1 `review.record` | **閉じた** | `observation-prep.mjs:292-296`（`K67_S3_REVIEW`。commit `4aa34626`、sha256 `fba38a31…`。contracts の bytes から再計算して一致。`4aa34626` は `origin/claude/nir1-contracts` の HEAD で、`7361041f` の子）、`:5822-5829`（`:5825`。frozen の `review.record` は `K67_S3_REVIEW.path` を要求）、`k67FormalRows` に追加（`:6744`）、`K66_S3_REVIEW` は `k66FormalRows` に残る（`:6702`）。試験には「9 回目の path では落ちる」がある |
| B2-2 限界 (f) | **閉じた** | `v1.json:461` の (f)：K6/7:225 の申告であること、依頼文は残っていないこと、「起案の経緯」〔:66-68〕に盲検の記述が無いこと、1 回目が読んだ範囲 |
| B2-3 (iii) の根拠と null の書き方 | **閉じた** | DR-DBC-7（`db-connection-decisions.md:1015`）と S2 (h)：根拠は v3:96・:98・:204・:222・:61 に、null は「page が quote・範囲を返さなければ null。製品が必ず返すかは確かめていない」に直った。試験 (c)(d) がある |
| B2-4「観測の後に変えた読み 2 点」 | **不完全**（推奨 1） | 宣言（`revisions[37]` (8)、`k67-quality-verdict-v3-design`）と DR-DBC-7（`:1013`）は「1 点＋fail→hold 2 点」に直った。しかし **`K67_LIMIT_WORDS` の注釈 `observation-prep.mjs:4596`「with the two readings changed after an observation」が残っている**。同じ語は `:2181`（`READINGS_AFTER_DEV` の注釈「観測の後に変えた読み 2 点」）にも残る。追記 1（`cp4-decisions.md:1611`）は「`K67_LIMIT_WORDS` の注釈」も直したと書くので、記録と実物が食い違う |
| B2-5 R-12 の k62 の regime | **不完全**（宣言の側。推奨 2） | S2 (a)（`v1.json:461`）と `K67_LIMIT_WORDS` には入った。S3 の直し方は「(a) と宣言に」だったが、宣言で `k62 の regime` が出るのは `revisions[38]` の報告文「B2-5 R-12 の k62 の regime を (a) に足した」の 1 か所だけ（宣言の全 field を走査）。「判定に届く」の開示の文は、宣言には無い。追記 1 の B2-5 の行（`cp4-decisions.md:1612`）は宣言の側を直したとは書いていないので、記録としては正しい |
| B2-6 drift の調査を S4b の前に | **閉じた**（調査は済み、(k) に書いてある）。ただし結論の文が証拠より広い（問 4、推奨 3） | `v1.json:1080` の (k)、DR-DBC-7 `:962-976`、`drift-ownerready.md` |
| B2-7 run の入口 | **閉じた**（事実を書く方を選んだ） | `v1.json:1080` の (c)：「入口（`admission.mjs` の `readAdmittedObservationPrep`）は前半だけを検査し、`formalReferenceRows`（`k67FormalRows` を含む後半）は呼ばない。CI での担保は S4b で戻す試験」。(k) と DR-CP4-S4-11 に、試験を戻すことと frozen のときは skip を許さないことを書いた。`S4_PROCEDURE_WORDS.c` に `readAdmittedObservationPrep`・`formalReferenceRows` を足した |

B3 も見た。B3-1（宣言の SHA-256 の変遷）、B3-2・B3-3・B3-6・B3-7（S2 の (b)(h)(l)(3) と DR）、B3-4（probe-gc）、B3-5（`observation-prep.test.mjs` の catch：S2 が frozen なら skip せず assert で落ちる。比べる語 `"frozen-before-observation"` は validator の `PREP_FROZEN`〔`observation-prep.mjs:677`〕と同じ）はいずれも反映されている。B3-8 は (k) の「反映の後に再確認を置く」で受けている。この file がその再確認にあたる。

## 問 2：B1-2 の直し方（`evidenceId` による行単位の対応）

### 前提の事実

- **受領書の側には、edge ごとの Revision の対応が残らない**。`material-revision.mjs:260-288` の `resolveEdge` は edge ごとに Revision を推定するが、`observedPath` は `revision|relation` を並べ替えた `pairs` にし（`:282-286`）、hash 化した edge は `relationId` を持たない（`:181-191`）。判定の入力（`quality-verdict-cli.mjs` の `loadExpectations`）にも fixture の relation は入っていない。fixture の relation を入力に足せば、edge と Revision の対応は導ける。
- **製品の Evidence ID は Entity 単位**である：`nir1_entity_relation.rs:4523` `format!("nir1:evidence:codex:{entity_id}")`。dev gate の受領書 `dev-gate3/runs/hd-g03h2.DEV-SHAPE-G03_base.receipt.json` の `evidenceObservation.typedRevisions` は `dvs3-125` に 3 行、`dvs3-126` に 2 行で、計 5 行に対して ID は 4 つ。1 つ（2 hop の中間の Entity）が両方の Revision に出る。ID の構造を見ただけで、値に v3 は当てていない。
- **判定は、重なった ID の 2 本目の読み取り行を一度も見ない**。`quality-evidence-items.mjs:236-237` は path の Revision の行を ID で先勝ちに合成する。Revision の順は、並べ替えた `pairs` から作る `:219-221`。上の受領書の形では、5 本の読み取り行のうち 1 本が判定の外になる。
- **合成の試験の ID は edge ごとに別**である：`quality-verdict.test.mjs:186` `ev-${edge}-${logical}`。新しい試験 (a)〜(d) も既存の試験も、ID が Revision をまたいで重なる製品の形を見ていない。
- 読みの前提：S3 の記録（:60）と、この差分で書かれた DR-DBC-7（`:1016`）は、edge と Revision の対応を v2 C2 の **edge 単位**（v3:87）と読んでいる。以下はこの読みに揃えて答える。

### 新しい問題：全部読めた場合の fail→pass（必須 1）

- 場合：path の Revision が全部読め、2 つの Revision に同じ ID の行がある。
  - 後に並ぶ Revision（R2）の edge の行は、先に並ぶ R1 の行で判定される。
  - R2 の読み取り行だけが違い（範囲・hash が current の text と合わない）、表示した行と R1 の行が current に合うとする。
  - 字義（v3:90 の (i)：`evidenceId` で対応する読み取り済みの行の範囲と hash が、current の text に合う）では、R2 の edge の行は `fail`。
  - 実装は R2 の行を見ないので `pass`。
- 向きは `fail`→`pass`。開示は無い（S2 (h)、DR-DBC-7、宣言のどれにも無い）。S3 は開示の無い `fail`→`hold` を B1 にした。それより緩む向きを、それより軽くは置けない。
- 6 commit が入れたものではない（`db7c1234` からある）。しかし、この差分は DR-DBC-7・S2 (h) に「対応は `evidenceId` で取る」を開示として書いた。その読みが、製品の ID の形では Revision を識別しない。
- 到達（どの fixture・variant で 2 本の行が違いうるか）は確かめていない（未確認）。判定の外になる行がある、という事実だけで指摘は成り立つ。
- S4b の前に決める必要がある。判定 file を直すと `implementationCommit` の取り直しになり、その定数は validator（`observation-prep.mjs:324`）にあるので、S4b の ⑤ より後には変えられない（v3 §10 の 5）。

### (a) fail→hold に緩む読みは残るか

**残る。狭い場合だけで、開示は仕組みの記述にとどまる**（必須 1 と同じ根から出る）。

- 場合：自分の Revision（edge 単位の対応）が読めた edge に、どの読めた Revision にも無い ID の行がある。同時に、同じ path の別の Revision が読めない。
  - 字義：対応する Revision は読めていて、その ID はそこに無い。v3:91 の (ii) が成り立たないので、v3:96 の `fail`。
  - 実装：`:272-282` の `hold`。その edge の (iii)（`:335-340`）も判定しない。
- S3 の直し方は、この行を「(ii) を決められない」として `hold` に置いた（S3 記録 :62）。受領書から edge ごとの対応が取れない以上、E8 の一般則（v3:61）に載せる読みは立つ。ただ、対応は fixture の relation と `pairs` から導けるので、「取れない」のは今の判定の入力の形のせいである。
- 開示：DR-DBC-7（`:1016`）と S2 (h) は「読めた Revision のどれにも無く、読めない Revision があるときだけ hold」と、仕組みを正しく書いている。しかし題は「**字義に合わせて直した**」で、残る差が `fail`→`hold` の向きであることは書いていない。宣言 `revisions[37]` の「fail を hold に動かす読みが 2 点ある：…と、path 単位の hold（…直した）」は、直した後のコードに無い読みを「ある」と数え、今残る差を名指していない。
- **読めない Revision がある場合に限れば、`pass` への漏れは無い**。`typed-revision-not-read` の `hold` が path に必ず積まれ（`:231-234`）、項目は少なくとも `hold` になる。全部読めた場合は、上の必須 1 のとおり漏れうる。

### (b) 字義より厳しくしていないか

**厳しくなる場合がありうる（製品の ID の形のため）。開示は無い**（必須 1 と同じ根）。

- Revision R1 が読めず R2 が読めると、R1 に対応する edge の中間の Entity の行が R2 の行で判定される。
  - R1 と R2 でその Entity の行が違えば、実装は (i) の `fail` を出しうる。
  - 字義（v3:98「対応する typed Revision の行が読めない」）では `hold` である。
- `continue` をやめたことで、読めない Revision を含む path でも `edge-endpoint-missing` の `hold` と、current の text が無いときの `[precheck]`（`:250-254`）が出るようになった。どちらも v3:62・:98 の字義の内側で、厳しすぎではない。

### (c) 新しい hold code は「読みの追加」か

**名前そのものは読みの追加ではない。**

- v3 は hold の条件を文で定めていて、code 名は列挙していない（v3 の本文を grep して 0 件。§2.1 の hold は v3:98 の文）。
- code 名が出てくるのは `quality-evidence-items.mjs` とその試験だけで、schema・allowlist・集計が code を列挙している箇所は無い（`scripts`・`evals` を grep）。
- 問うべきなのは、その条件が v3:98 と E8 に載るかどうか。S3 の読み（(ii) を決められない）では載る。edge 単位の対応から見た残りは、必須 1 で扱う。

## 問 3：`implementationCommit` の取り直し

**v3 §0 と §10 の 3 の手順を満たしている。**

- **判定 3 file を最後に変えた commit**：`git log -1 -- quality-verdict.mjs quality-evidence-items.mjs quality-verdict-cli.mjs` は `11d5e4304885603f92e45c2216eb692b2658637b`。定数 `observation-prep.mjs:324` と一致する。後続の `3623b00f` は `observation-prep.mjs` だけ、`44595441` は試験の file だけを変えていて、3 file には触れていない。
- **remote の時刻**：GitHub の activity（`repos/kazormia296/Grimodex/activity?ref=refs/heads/claude/s4-9-pr3&activity_type=push`）を読み直した。結果は `55885c62→e03760eb` が `2026-11-16T09:47:30Z`、`e03760eb→140bdda2` が `09:47:45Z`、その前は `977d30be→55885c62` の `06:43:41Z`。`11d5e430` の commit の時刻（09:29:18Z）は、前の push より後になる。したがって 09:47:30Z が最初の remote の時刻で、DR（`cp4-decisions.md:1628`）の記載と一致する。`git branch -r --contains 11d5e430` は `origin/claude/s4-9-pr3` だけ。
- **CLI の受け付け**：source `repository-activity` は `REMOTE_TIME_SOURCES`（`quality-verdict-cli.mjs:557`）にある。v3 では実装 commit を枝名で束縛しない（`:703-709`）。commit ごとに最も早い記録が数える（`:633-673`）。「最初の正式 run より前」（`:715-718`）は run の時点の検査で、今は確かめようがない。
- **独立のコードレビュー**：v3 §10 の 3 の順序は「実装 → 独立のコードレビュー → 反映 → push・remote の時刻」。`11d5e430` は、S3 の 10 回目（独立レビュー）の指摘の反映である。反映した差分そのものを読んだのは、push の後のこの再確認だけ。前例（`db7c1234`）と同じ形なので手順の違反ではないが、DR に一言あるとよい（推奨 7）。
- **⑥ の後の修正であること**：変えたのは、読めない Revision の枝だけである。dev gate の g03 は `unavailable=0` だった（S3 記録 :60）ので、この枝は観測では一度も通っていない。「gate の値によらない」の裏づけになる。
- 必須 1 を判定 file の修正で閉じるなら、同じ手順（3 file だけの commit → 定数の取り直し → push と remote の時刻）をもう一度踏む。

## 問 4：黙った緩和と、(n) の開示

- **6 commit が新しく入れた黙った緩和は無い**。
  - 差分の非 test のコードは、`quality-evidence-items.mjs` の上の変更と `observation-prep.mjs` だけ。`observation-prep.mjs` の変更は定数・語・誤りの文の追加と、`review.record` の要求の付け替え（K66→K67。K66 は歴史の行に残る）で、消えた検査は無い。
  - 試験の差分は全部読んだ。消えた assert・緩んだ assert は無く、数の更新（`mutated` 75→82、`K67_LIMIT_WORDS` 64→78、行数 38→39 など）は足した語・行の数と合う（足した語：LIMIT 14、S4 の (c) 2・(k) 5）。
  - 閾値、`K64_VALUES`、Gold、fixture、手順のファイル v2、trace、K6/7 と v3 の bytes は、差分に含まれない（`git diff --stat` の 8 file）。
  - ただし、既存の判定の性質としての fail→pass が表に出た（必須 1）。
- **(n) と 1b は事実で一致する**。
  - 一致した点：running 行を残した写し（cold-workspace）、起動時の復旧の INTERRUPTED、retryable で 1.000 s 後の次の試行、同じ `work_key`、24 個の測定 DB のうち INTERRUPTED は 1 個、`freshnessSettle` は freshness consumer しか見ないこと、静止前に写した理由は未確認、leftover が無くても preempt と即再試行で起こりうること。いずれも `drift-ownerready.md:14`・`:22-24`・`:87-99` と合う。
  - (g) の「有力（消去法、worker 内部の時刻は未取得）」、base 12/12 で S0 が欠落、Fisher p=1.0 も `:13`・`:17`・`:24-25` と合う。
- **結論の文が、証拠より広い**（推奨 3）。
  - 調査が確定したのは、この事象の経路（drift の枝）が Graph を返さないことである。`drift-ownerready.md:16` は「古い Graph が renderer に返った可能性は無い」と書き、`:169` は requalify が worker の見落としを拾うかを「読んでいない」としている。
  - この経路は自分でもコードで確かめた：`nir1_graph_product.rs:2875-2890`（`RegistrationDrift` は `drift_at_query` を数えて `Unavailable` を deliver し、projection を作らない）、`related_scenes/graph.rs:405-407`・`:718-720`（`Unavailable` はそのまま `reply(reason)`）。
  - ところが S2 は (g)（`v1.json:461`）で「古い Graph が renderer に返る経路は無い」、(k)（`:1080`）で「古い Graph を返す経路は無い（コードで確定）」と書き、(n) では「起これば…古い Graph は返らない（コードで確定）」と一般の形で書いている。DR-DBC-7 の `:934`・`:969`・`:974`、追記 1 の `cp4-decisions.md:1613`、宣言の `revisions[37]`・`[38]` も同じ書き方。
  - 宣言は、builder が製品のコードを読んでいないと書いている（`revisions[38]`「drift の結論は調査の記録の引用で、コードは読んでいない」）。
  - 止まる条件（`7361041f`:31「古い Graph を返す経路が見つかったら止まって伺う」）に当たらないという結論は正しい。見つかっていないからである。ただ「無い（確定）」は、確かめた範囲より広い。

## 問 5：反映で生じた不整合

- SHA-256 はすべて再計算と一致した：`K67_S3_REVIEW` の `fba38a31…`（`4aa34626` の bytes）、5 行目の `9173e5e5…`（`7361041f` の bytes）、v3 の `b6166ed2…`。
- 宣言の SHA-256 は `e8198c8c`＝`e481adde…`、`55885c62`＝`e7db45fa…`、`c24337ee` と HEAD＝`e42241c6…`（作業木で計算）。DR-CP4-S4-11 (2)（`cp4-decisions.md:1595`）は「S2 追補 #19 の後もさらに変わる（S4b の値は最後の bytes）」と書き、今の値は書いていない。S4b で取るので欠落ではない。
- 数の文：「four answers」は 0 件になった（`observation-prep.mjs:5508` は five）。残っているのは次のコメントだけ（推奨 1・5）。
  - `observation-prep.mjs:4596`「the two readings changed after an observation」と `:2181`「観測の後に変えた読み 2 点」
  - `observation-prep.mjs:4695` と `observation-prep.test.mjs:8419` の「(a)〜(l)」（今の limits は (n) まである）
- 宣言 `revisions[37]` の「fail を hold に動かす読みが 2 点ある：…path 単位の hold（…直した）」は、直して無くなった読みを数えている（必須 1 の開示で直す）。
- DR-CP4-P-11 の既存の行が残す「回答が 4 つ」「additional 4 行」「(a)〜(l)」は追補 #18 の時点の記述で、#19 の注記（「S2 追補 #19 で 5 行目 `7361041f` を足した」など）が付いている。履歴として読めるので、不整合とはしない。
- remote 時刻の記録の行（`cp4-decisions.md:1628`）は commit を `11d5e430…` と略して書いている。CLI は commit の全 40 桁を要求する（`quality-verdict-cli.mjs:695` の `COMMIT_PATTERN`）。実際の `--remote-time-record` の file は全桁で書く必要がある（推奨 4）。
- validator を今の S2 に当てた結果（読むだけ、Node 22）：`status: passed`、errors 0、`formalReady` false、placeholder 23。S3 の 10 回目の時点と同じ。

## 必須

1. **utf16-range の判定は edge 単位の対応を取っておらず、全部読めた場合に fail→pass が起こりうる（新しい問題。差分の外・既存。今回の事実で判明）**。
   - 事実：製品の Evidence ID は Entity 単位で（`nir1_entity_relation.rs:4523`）、dev gate の受領書では 5 本の読み取り行のうち 1 本が判定の外になる（`quality-evidence-items.mjs:236-237` の先勝ちの合成）。
   - 字義（S3 記録 :60 と DR-DBC-7 `:1016` の edge 単位の読み）から見た差は 3 つある。
     - (i) 全部読めたとき、後に並ぶ Revision の edge の行を、先の Revision の行で判定する：`fail`→`pass` がありうる。開示は無い。
     - (ii) 読めない Revision があるとき、読めた Revision の edge の、どこにも無い ID の行が `hold`：`fail`→`hold`。仕組みは開示されているが、向きの開示は無い。
     - (iii) 読めない Revision の edge の行が、他の Revision の行で判定される：`hold`→`fail` がありうる。開示は無い。
   - 閉じ方は統合者が選ぶ（S4b の前に）。
     - **(A) 字義に寄せる**：fixture の relation を判定の入力に足し、edge→relation→`pairs` の Revision で行を引く。3 file の修正なので、`implementationCommit` を手順どおり取り直す。v2 C2・v3:87 の edge 単位の対応に揃うので、ユーザーの確認は要らない。
     - **(B) 今の読みを残す**：(i)〜(iii) を読みとして DR-DBC-7・S2 (h)・宣言に開示し、ユーザーに確認する（S3 の B1-2 の選択肢 2 の形。v3:226 の手前で）。
   - どちらでも、ID が 2 つの Revision に重なる合成の受領書の変異を試験に足す（今の試験は `quality-verdict.test.mjs:186` で edge ごとに別の ID）。DR-DBC-7 `:1016`・S2 (h) の「字義に合わせて直した」と、宣言 `revisions[37]` の「2 点ある：…path 単位の hold」は、選んだ閉じ方に合わせて書き直す。

## 推奨

1. **B2-4 の残り**：`observation-prep.mjs:4596` と `:2181` のコメントを「観測の後 1 点＋fail→hold 2 点」に直すか、追記 1（`cp4-decisions.md:1611`）から「`K67_LIMIT_WORDS` の注釈」の記載を外す。
2. **B2-5 の宣言の側**：宣言の `revisions[37]` (1) か `revisions[38]` に、「k62 の regime〔candidate の証拠が欠けた summary〕では判定に届く。R1 でない候補には当てはまらない〔推測〕」の文を足す。
3. **drift の結論の文の範囲を絞る（問 4）**：「古い Graph を返す経路は無い（コードで確定）」を、たとえば「この事象の経路（worker の drift の枝）は Graph を返さない（コードで確定）。worker が見落とした場合の requalify は読んでいない」に直す。直す場所は S2 (g)(k)(n)、DR-DBC-7 `:934`・`:969`・`:974`、`cp4-decisions.md:1613`、宣言。`K67_LIMIT_WORDS` の「古い Graph が renderer に返る経路は無い」と `S4_PROCEDURE_WORDS.k` の「古い Graph を返す経路は無い」も、語として束縛されているので一緒に直す。止まる条件に当たらないという結論は変わらない。
4. **remote 時刻の記録の file**：`--remote-time-record` に渡す行は、commit を全 40 桁で書く（`quality-verdict-cli.mjs:695`）。DR の例示は略記なので、写すときに注意する。
5. **古いコメント**：`observation-prep.mjs:4695`、`observation-prep.test.mjs:8419` の「(a)〜(l)」を「(a)〜(n)」に。
6. **差分の外（既存）。開示だけでよい**：
   - 実受領書では、表示側の hash が material の quote と食い違う edge は、C2 の推定で解決しない。`resolveEdge` は hash 2 本の一致を要求する（`material-revision.mjs:262-272`）。そうなると `pairs` が null になり、utf16-range は `revision-of-path-unresolved` の `hold` になる（`quality-evidence-items.mjs:215-217`）。v3:96 の第 2 文（端点の text 由来でない行を含む edge は (i) で `fail`）も、行が 3 本になれば解決しないので `hold` に回る。`44595441` の試験のコメント（a2）もこの性質を書いている。
   - 条件 4 の結果は変わらない。同じ edge は edge の束縛が `fail` にするからである（`quality-verdict.mjs:246` `unresolvedEdges !== 0` → `unresolved-edges`、`:830-835` で問題があれば `fail`）。
   - S2・DR・宣言にこの語も説明も無い（grep で 0 件）ので、S2 (h) に 1 行足すとよい。
7. **v3 §10 の 3 の記録**：`11d5e430` の差分を読んだ独立のレビューは、push の後のこの再確認だけである。この file を、その位置づけで DR に記録する。前例 `db7c1234` と同じ扱いでよい。

## 確かめたこと

- 6 commit の範囲と変更 file（8 file）、commit の順（`cp4-decisions.md:1624` の記載どおり）、HEAD＝`origin/claude/s4-9-pr3`＝`140bdda2`、作業木が clean であること。
- `11d5e430` の判定 file の差分の全体と、今のコード（`quality-evidence-items.mjs:162-344`・`:478-495`）。`observationIndex`（`:162-184`）の `unavailable` の扱い。
- edge の束縛（`quality-verdict.mjs:232-270`・`:712-724`・`:830-840`）。
- v3 の §0（:29-40）、§2.0（:54-63）、§2.1（:65-98）、§2.3（:124-143）、§5（:196-204）、§7（:219-229）、§8 の 1〜3（:231-235）、§10 の 2〜5（:250-253）。v3 に hold code の名前が無いこと。
- contracts の SHA-256（`4aa34626`、`7361041f`、`160f5fa5` の v3）、`7361041f` が `4aa34626` の祖先であること、`4aa34626` が `origin/claude/nir1-contracts` の HEAD であること。
- `7361041f` の確認の記録の全文（問 1 の条件、問 2 の回答と止まる条件）。
- `drift-ownerready.md` の全文と、S2 (g)(n)・DR-DBC-7（`:934`・`:950`・`:962-976`）の突き合わせ。製品コードの drift の枝（`nir1_graph_product.rs:2840-2895`、`related_scenes/graph.rs:398-412`・`:712-762`）。
- S2 の JSON・作者の宣言・`observation-prep.mjs`・`observation-prep.test.mjs`・`quality-verdict.test.mjs` の差分の全体。DR-CP4-P-11／S4-11 の既存 2 行の word-diff と追記 1 の全文。DR-DBC-7 の差分の全体。
- 製品の Evidence ID の作り方（`nir1_entity_relation.rs:4505-4583`）と、dev gate の受領書の ID の重なり（`hd-g03h2`：5 行・4 ID で、1 つが 2 Revision に出る）。
- remote の時刻（GitHub の activity の読み直し）と、CLI の remote 時刻の検査（`quality-verdict-cli.mjs:557`・`:632-725`）。
- validator の読むだけの実行（errors 0、placeholder 23）。

## 未確認

- **試験は回していない**（前例どおり）。DR の「1017 件中 pass 1009・fail 8（`55885c62` の時点と同じ）」「test:quality 714 件・fail 0」「(a) の試験は直す前の実装で落ちることを確かめた」「verify:quality は `e03760eb` の tree で成功」は、作者の申告のまま。
- 必須 1 の (i)(iii) の場合（2 つの qualified な Revision が、同じ Entity に違う行を持つこと）が、どの fixture・variant で起きうるか。
- requalify（`graph_response::assemble`）が worker の見落としを実際に拾うか（調査も読んでいない）。この再確認でも読んでいない。
- 実際の `--remote-time-record` の file の中身（repo に無い。run の時点で渡す）。
- 445 file の製品の変更の中身、pin の取り直し、検出力の記録、master・contracts の取り込み、S4b（いずれもまだ無いか、範囲の外）。
