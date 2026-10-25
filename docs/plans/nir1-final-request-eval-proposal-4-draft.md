# NIR-1 最終 request 評価の契約提案 proposal/4（draft）: Graph の follow-up の可用性（`graph-ready` による再 query の cache 由来の表示）

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

要約: (1) 確認するもの — K6/2 の `graph-eval-procedure` に、「first-render の可用性」（K6/2 の (a)。D の窓内率。文はそのまま残す）とは別に「follow-up の可用性」（Raw の表示の後、`graph-ready` による製品の再 query が、その sample 自身の遅れた結果を cache から受けて Graph を表示すること）を定義し、定常状態の可用性を両者の和（「表示の可用性」）の欠落率 1% で判定する。(2) ユーザーが決める点は 7 つ（「判断を求める点」の表）。(3) 最も重い開示: first-render の PASS を要件から外すこと（判断を求める点 1 の推奨）は、D・lease・1% の値を変えないが、K6/2 の「(a) が基準を満たさなければ HOLD」を置き換えるので**合格基準の緩和**（重要な変更）にあたる（批准 5）。推奨と違い first-render を要件に残すなら、緩和にはならないが、D′ の下では (a) が構造上 HOLD のまま何も解けない。(4) 製品の再 query の合流が自分の D の窓に Graph を届けるかは**測っていない**（D′ の確認は Native の continue を直接 2 s 待った。「確かめられなかったこと」の 1）。届かなければ、この定義でも HOLD になる。(5) 読む順序の案: 「判断を求める点」→「ユーザーが批准すること」→「設計」の follow-up の定義→「UX と製品の意味」→「変える点」の表→ほかは必要に応じて。

## ユーザーが批准すること

1 回の明示の承認で批准するのは、次の 10 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。一覧にないものは批准しない。数値と根拠は各節に 1 回だけ書き、ここには再掲しない。判断が要る値と選択は「判断を求める点」にまとめた。

1. 加えるもの: 「設計」の「follow-up の可用性」（測る量、T_late、数える条件 F1〜F7、数えない場合 X1〜X10）と「表示の可用性」（sample ごとに first-render の窓内か follow-up の成功のどちらかで Graph が表示されたこと）とその欠落率。
2. 判定の置き換え: K6/2 の条件の (a)、Mandatory defenses と Acceptance implications の「(a) が基準を満たさなければ HOLD」、手順の 8 の「窓内の sample が1件もない case は HOLD」、「条件が成立しない場合の CP-4 の可用性」の (a) の trigger を、表示の可用性の欠落率（1%、全 case の pool）で読む。first-render の窓外率（K6/2 の (a) の値）は、K6/2 の規則のまま求めて receipt に書き、開示するが、合否に使わない（判断を求める点 1 の推奨）。HOLD の既定は表示の可用性に当てて残す。
3. 品質の測り方の拡張: G-01〜G-08 の品質を、窓内の sample に加えて follow-up で表示された sample の表示の結果でも測る（「設計」の「品質」）。
4. 測定の手順の読み替え（「測定の手順の読み替え」の R1〜R8。sample の前の前提、cache の初期化、`graph-ready` の通知の数え方、sample の独立性、製品の renderer の経路で測ること）。
5. これが合格基準の緩和にあたること: D=10.84 ms、lease 100 ms、1%、遅れた結果を混ぜない規則は変えないが、K6/2 が PASS に求める「Raw と同時に Graph が届くこと」（定常状態の窓内率）を、「Raw の後 T_late 以内に Graph が届き、製品が表示すること」で代替してよいとする。弱める範囲は「設計」の F1〜F7 を満たす sample に限る。K6/2 の 621 行の「受入れへの影響」の緩和（編集中の可用性を合否から外す）とは別の、定常状態についての緩和である。
6. 確認の効力の時点（判断を求める点 6 の推奨）: (i) 2 の「条件が成立しない場合の CP-4 の可用性」の読み替えは、K6/2 では確認を待たずに使う trigger（612 行）だが、緩和を含むので U3 の委任では使えない。この読み替えは、この draft の確認が記録された時点から使う。(ii) この行のほかの内容は、K6/2 と同じく、条件が成立し、判定に使った診断と receipt の照合が済み、それらを添えた改めての確認が記録された後に限って効く（この確認はその部分については事前の確認）。
7. 事前登録と版・draftRef の読み替え（「引き継ぐもの」の 3、「変える点」の 13）: K6/2 の「事前登録の凍結」の 1〜7 を、「この file」をこの draft の bytes と読んで当てる。条件の判定に使う診断は、この draft の凍結の後に取り、receipt の先頭にこの draft の凍結の commit と SHA-256 を書く。K6/2 の SHA-256 を先頭に持つ receipt と診断、この draft の「事実」に書いた観測は、予告として扱う。
8. 変えないもの: 「前書き」の「変えないもの」の列挙。特に (b)（実際の操作の trace）の規則（K6/2 の 610 行と「条件の (b) の判定の規則」の 1〜8）、失効率の物差し 1%、D-final の READY 待ち、K6/3 の行。
9. 許さないもの: 製品のコードの変更（Related Scenes の debounce、合流の deadline、次 query 用の cache、D′ の状態機械、`graph-ready` の通知）、D の拡大と再 query の合流の窓の拡大、新しい authority・保存先・送信先・製品の入口、Graph の公開（PUB-G）と Session C-1 の承認、条件の成立の判定そのもの。依存する契約と K6/2・K6/3 のほかの行は確認しない。
10. threat model と受入れ: 「threat model」の加算、「受入れ」の K6/4-P1〜P3 と K6/4-N1〜N18、「変える点」の 1〜13、「引き継ぐもの」の節。

注記（批准の対象ではない）: 2026-10-25 にユーザーが K6/2 の (a) について「K6/2 は A で」と指示した。A は「再 query の cache 由来の結果も、一定時間内なら可用性に数える定義を持つ新しい K6 の draft を起案する」で、起案の指示であり確認ではない。この起案は選択肢の逐語の問いを見ておらず、integrator の伝える要旨による。T_late の値、測る区間、数える条件、品質の扱い、確認の効力の 2 段、(b) の開示は、起案者が加えたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/4` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行と同じ。理由は「確認文」） |
| 起案日と基点 | 2026-10-25。基点は origin/master `bdc892d7`（#717）。行番号（K6/2・K6/3 の本文、`src/`、`electron/native`、台帳、続行計画、`nir1-lane-decisions/`）は `bdc892d7` で確かめた。統合 branch の記録は `claude/nir1-cp4` の `be8c14ca` の `docs/plans/nir1-lane-decisions/cp4-decisions.md`（以下 cp4）で、master に無い。K6/2 の bytes の SHA-256 `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` と K6/3 の `2ae123d2319bb0246045bebc39d2391add15deccfa0aa58d87dbfce3b8ecbf2b` は、台帳の値と一致することを再計算して確かめた |
| baseline | `nir1-final-request-eval-proposal/2#graph-eval-procedure` は**確認されていない**（2026-10-17 の事前の確認だけで、`confirmedRef` は none。台帳 206 行、223 行）。行は `condition-not-met` で、内容は効いていない。効いているのは、確認の前から使う規則（凍結した bytes の条件の判定の規則と、612 行の「条件が成立しない場合の CP-4 の可用性」。U3 の委任の trigger）だけ |
| 前提 | D′（CQ-DEFER、#715）は master にある（`related_scenes/graph.rs:21-24`）。CP-4 は統合 branch で D′ を取り込み、実機の確認 (ii) を行った（cp4:424-466）。CP-4 の正式の窓（S5）、条件の判定に使う診断、評価の手順のファイルはどれもまだ無い（`evals/nir1-graph/` は G-case の fixture と freeze だけ。`bdc892d7` と `be8c14ca` で確かめた） |
| 用語 | first-render の可用性 = K6/2 の (a)（最初の query の合流が D の窓内に worker の結果を受けること）。follow-up の可用性 = この draft の定義。表示の可用性 = sample ごとに、どちらかで Graph が表示されたこと。`t_raw_ready` = 最初の query の Raw-ready（K6/2 の手順の 2。renderer の単調 clock）。`t_notice` = renderer が、その project の `graph-ready` を受けた時刻（同じ clock）。`t_follow` = 製品の再 query の合流が結果を出した時刻（`publishedAtMs`。同じ clock） |
| 変えないもの | D=10.84 ms（`relatedScenesConfig.ts:7`）、Graph の result lease 100 ms、K1／proposal/7 の上限、P の B=54.2 ms、D、上限 65.04 ms（B+D）、T=2144.7 ms（post-B:223）、「既に完了した query へ遅い Graph の結果を混ぜず、次の query で使う」（post-B:217。合流は D の後の Graph を混ぜない。`nir1RelatedScenesGraphJoin.ts:253-257`）、IR の timeoutRate 1%、失効率の物差し 1%、(b) の規則（K6/2 の 610 行、704 行、711-737 行）、分母を全 case の pool とすること、HOLD の既定、事前登録の凍結の規則、試験専用の入口の規則、`graph-ready` の再 query を P・IR・(a)・(b) の分母に入れないこと（手順の 7）、DP-H・DD-1・K6/3（`nir1-final-request-packing-eval` の行）の規則、D-final の Graph の待ち（`nir1_graph_dfinal.rs:53` の 4 s）。新しい数値の上限は置かない（T_late は既存の値を使う。判断を求める点 2） |

## 判断を求める点

推奨のまま承認すれば推奨が確認され、推奨と違う選択は新しい draftRef で起案する。

| # | 論点 | 推奨 | 代案 | 批准の番号 |
| - | ---- | ---- | ---- | ---------- |
| 1 | first-render の PASS を要件に残すか（**緩和か、定義の追加か**） | 外す。定常状態の可用性は表示の可用性の欠落率で判定し、first-render の窓外率は記録と開示だけにする（**合格基準の緩和**。D、lease、1% は不変）。ユーザーの A の指示の目的（D′ の下で (a) が構造上 HOLD になることを解く）を果たすのはこの案だけ | (i) 定義の追加だけ: follow-up を記録し、first-render の (a) を PASS の要件に残す（緩和でない。D′ の下では (a) が構造上 HOLD のまま。cp4:466 の (2)）。(ii) 両方を要件にする（より厳しい。同じく HOLD）。どちらも D′ を外すか合流の経路を短くする大工事を要する（cp4:410-418 の案 B・C と DR-CQD-1 の代替案） | 2、5 |
| 2 | T_late の値と測る区間 | `t_notice − t_raw_ready ≤ 100 ms`（Graph の result lease の値を使う）に加え、再 query の合流が自分の D の窓で Graph を受けること（F6。D は不変）。表示の遅れ `t_follow − t_raw_ready` は記録して分布を開示し、合否に使わない | (a) 表示の時刻で測り `t_follow − t_raw_ready ≤ 2 s`（`GRAPH_AWAIT_LIMIT`。`related_scenes/graph.rs:42`）。(b) 次 query 用の cache の TTL 30 s（`nir1_graph_product.rs:98`。cache が生きる間は数える。最も緩い）。(c) 表示の時刻で、lease 100 ms＋debounce 400 ms＋P の上限 65.04 ms を足した値（既存の値の和だが、debounce は UI の定数で、和の意味が契約にない） | 1 |
| 3 | 表示の可用性の欠落率の物差し | 1%（IR の timeoutRate、K6/2 の (a) と失効率と同じ。新しい数値を作らない）。全 case の pool で判定し、case ごとの値を開示し、表示された sample が 1 件もない case は HOLD | 1% より緩い値（閾値の緩和で、新しい draftRef と確認が要る）。case ごとに 1%（K6/2 の分母の選択肢の案 2 と同じく、30 sample で 0 件を求める） | 1、2 |
| 4 | 数える条件 | 製品の renderer の経路（`useNir1RelatedScenes` の 1 世代 1 回の再 query）で、その sample 自身の遅れた結果が cache に入り（F2）、再 query が `Cached` でそれを受け（F5）、再 query の合流が `graph-ready` で表示した（F6）ときだけ数える | Native の記録（再 begin が `cached`、continue が available）だけで数える: D′ の確認 (ii) の形（cp4:431、447）で、製品の合流の D の窓と debounce を通らず、製品が表示しない結果を可用と数えうる。採らない | 1、4 |
| 5 | G-case の品質を follow-up の表示で測るか | 測る。窓内と同じ規則（同じ case の表示の結果はすべて同じ。違えば FAIL）に、再 query の R と IR が最初の query と同じことを加える | 窓内の sample だけで測る（D′ の下では全 case が「窓内の sample なし」で HOLD。K6/2 の手順の 8） | 3 |
| 6 | 確認の効力の時点 | CP-4 の trigger（612 行）の読み替えはこの draft の確認で効き、行のほかは条件の成立と改めての確認の後に効く（批准 6） | 全部を条件の成立の後にする: 条件が成立しない間の CP-4 は K6/2 の (a) の trigger のまま、構造上 HOLD | 6 |
| 7 | (b) の区分 4 と D′ の graph-late | (b) の文と区分は変えない。D′ の下では、開始時の slot が `empty` の graph-late が区分 4 の「鮮度」（「開始時の slot が新しい READY でなかった graph-late」。K6/2 の 721 行）に入ることを開示し、(b) の記録に follow-up の成否を足す（記録と開示だけ） | (i) D′ の構造上の graph-late を「その他」に入れる（狭める。(b) の主な理由が「その他」になり、この行は使えず原因を直すか新しい draftRef。K6/2 の 734 行）。(ii) (b) でも follow-up を窓内に数える（(b) の緩和。編集中の Graph は F10 で stale が主になる見込み〔DR-CQD-8〕なので、効果は小さい見込み） | 8 |

## 引き継ぐもの

1. K6/2 の `graph-eval-procedure` の行の全文を baseline とし、この draft の「変える点」の表を当てたものを /4 の行の内容とする。表にない K6/2 の記述（(b)、失効率、trace の密度と長さ、`busy` の区分、記録の読取との重なり、凍結、保存先、writer、失効、選択肢の表）は変えない。
2. K6/2 の 147 行の規則（同じ contractId の後続の draftRef が確認されると、先行の行を全体として supersede する）は、確認された行にだけ当たる。`graph-eval-procedure` の /2 は事前の確認だけで confirmedRef を持たないので、この draft が確認されても /2 の事前の確認は履歴として残り（台帳 206 行は消さない）、条件の成立の後に改めて確認を求めるのは /4 の行になる。/2 の行のまま改めての確認を求めることはしない（/4 が確認された場合）。
3. 事前登録: K6/2 の「事前登録の凍結」（152-160 行）に従った /2 の凍結の記録（`claude/nir1-contracts`。この起案では記録そのものを確かめていない）は消さずに残す。/4 の凍結は別の新しい commit で、K6/2 の「事前登録の凍結」の 1〜3 のとおり行う。K6/2 の 159 行（/1 からの引継ぎ）と同じく、/2 の凍結の後にこの起案者が見た観測は、この draft の「事実」の節に書いたもの（cp4 の DR-CP4-S1C2-15、16、19〜26 と D′ の確認 (ii) の結果、cq-deferred-decisions.md の §6〜8）で、どれも条件の判定に使える診断ではなく（凍結の commit と SHA-256 を先頭に持たない）、予告として扱う。条件の判定には、/4 の凍結の後に取り直したものだけを使う。
4. K6/2 の事前の確認（2026-10-17、台帳 137 行と 206 行）、K6/2 の 2026-10-17 の注と K6/3 の 2026-10-25 の注（台帳 219-220 行）、K6/3 の確認の記録（台帳 175-185 行）は消さない。K6/3 が読み替えた版の番号（DP-H の置換版を版2、DD-1 の版を版3）は `nir1-final-request-packing-eval` の行の話で、この draft は触れない。

## 変える点（K6/2 との関係）

次の表の文だけを置き換える（または足す）。表にない K6/2 の記述は変えない。**1、2、4、6 は /2 の文面より弱い読み**（批准 5）、5、8〜11 は狭める防御か具体化、3 と 7 は手順の読み替え、12 と 13 は効力と事前登録の扱いである。以下「/4 の変える点 n」と呼ぶ。

| n | 箇所（K6/2 の行） | /2 の文（要旨） | /4 の文 | 理由 |
| - | ---------------- | --------------- | ------- | ---- |
| 1 | 条件の (a)（609 行）と条件の前置き（606 行） | 定常状態の窓外率（worker 由来の窓内だけ）が 1% 以下。満たさなければ HOLD が既定で、この行は使わない | 定常状態の**表示の可用性の欠落率**が 1% 以下（pool）。満たさなければ HOLD が既定。first-render の窓外率は /2 のまま求めて receipt に書き、開示する（判断を求める点 1） | D′ では (a) が構造上 HOLD（cp4:466） |
| 2 | 条件が成立しない場合の CP-4 の可用性（612 行） | (a)、(b) の窓外率、(b) の失効率のどれかが 1% を超えたら HOLD | (a) を表示の可用性の欠落率と読む。(b) の 2 つの率は /2 のまま。この読み替えはこの draft の確認から効く（批准 6） | trigger の緩和は委任の外 |
| 3 | 手順の 3（695 行）の sample の前 | slot が新しい READY になったことを確かめてから query | 「測定の手順の読み替え」の R1（slot が `empty`、保留が無い、cache が空、前の seed つきの sample の終わりから 1 s 以上） | D′ の query は READY を残さない（DR-CQD-4、DR-CP4-S1C2-23） |
| 4 | 手順の 3 と 5（695、705 行）、Mandatory defenses（619 行）の cache 由来の扱い | cache から返った結果は (a) では窓外に数える | first-render の窓外率では /2 のまま窓外に数える。表示の可用性では、F1〜F7 を満たす cache 由来の再 query の表示だけを follow-up の成功に数える | ユーザーの A |
| 5 | 同上 | （なし） | 数えない場合 X1〜X10 を当てる。特に、cache を空にした後にその sample 自身の ticket が入れた entry 以外の cache の hit は数えない | 前の sample の遅れた結果の混入を防ぐ |
| 6 | 手順の 8（708 行）、Acceptance implications（620 行） | 品質は窓内の sample で測る。窓内の sample が無い case は HOLD | 品質は窓内か follow-up で表示された sample の表示の結果で測る。表示された sample が無い case は HOLD（判断を求める点 5） | D′ では窓内の sample が無い |
| 7 | 手順の 7（707 行）、条件の (b) の規則の 1（715 行） | `graph-ready` の再 query は P、IR、(a)、(b) の分母に入れず別に数える | 変えない。再 query は分母に入れず、その親の sample の follow-up の記録としてだけ数える（R3） | — |
| 8 | Untrusted actors（616 行） | `graph-ready` の再 query、cache から返った結果は (a) の窓内の判定に使わない | first-render については /2 のまま。follow-up は、製品が自分で出した 1 世代 1 回の再 query と、その sample の late cache の hit に限って使う（F3〜F5） | 加算 |
| 9 | In-scope attacks（617 行） | （下の各項は無い） | threat model の In-scope attacks の 1〜10 を加える | 定義の悪用を拒否する |
| 10 | Mandatory defenses（619 行）の記録 | sample ごとの記録の項目 | 「測定の手順の読み替え」の R7 の項目を加える | 受入れ |
| 11 | 失効（624 行） | 候補、手順・trace・基準のファイル、合流 helper、cache の規則などの変更で失効 | 加えて、`FETCH_DEBOUNCE_MS`、`graph-ready` の通知と再 query の規則（`useNir1RelatedScenes.ts`）、D′ の状態機械と保留の期限、cache の key と TTL の変更で失効する | follow-up の時間と成否を決める |
| 12 | 確認の扱い（140 行）と台帳の 206 行の読み | 行の内容は条件の成立と改めての確認の後にだけ効く。612 行は確認の前から使う | 批准 6 の 2 段 | 緩和を委任で使わない |
| 13 | 事前登録の凍結（152-160 行）の「この file」 | K6/2 の bytes | この draft の bytes（K6/2 の bytes の凍結の記録も残す）。receipt の先頭は /4 の凍結の commit と SHA-256 | 「引き継ぐもの」の 3 |

## 事実

コードは `bdc892d7` で確かめた。測定は記録にあるものだけを書き、記録に無いものは「未測定」と書く。

- D′ の Graph は常に graph-late: Related Scenes の begin は Graph の需要を保留として owner に渡し、begin 自身の監査の commit が終わった後に release する（`related_scenes/graph.rs:21-24`、DR-CQD-1）。保留つきの session は READY を公開せず、query の後に worker を退役させて slot を `empty` に戻す（DR-CQD-4）。理由は、begin の監査の commit（`ai_audit_events` に約 5 行）が worker の registration と query の `ReadIdentity`（`data_version`、`total_changes`）の drift として拒否されること（DR-CP4-S1C2-19、20。cp4:403-404）。
- 合流: Graph は IR と同じ deadline（`t_raw_ready` + D）で合流し、deadline は延ばさない。deadline の後に届いた Graph は混ぜず、`graph-late` と `unused` の宣言になる（`nir1RelatedScenesGraphJoin.ts:72-77`、92-96、162-165、253-257）。`unused` で ticket の結果が available なら、owner は次 query 用の cache に入れて project ごとに `graph-ready` を 1 回出す（`nir1_graph_product.rs:888-913`、917-946、613-629）。cache は 1 件だけで、key は binding、caller の epoch、project、query の Scene、seed で、edge の epoch が同じで TTL（既定 30 s。:98）の内だけ使え、使うと空になる（:587-611、705-711、2688-2696）。begin と D-final の begin は同じ admission で cache を取る（:1035-1100、`nir1_graph_dfinal.rs:324`）。
- 再 query: renderer は `graph-late`、`warming`、`stale`、`busy` の結果の世代について `graph-ready` を 1 回だけ使い（`useNir1RelatedScenes.ts:26-34`、109-121、252-257。DR-CP3A-49）、refresh で effect をやり直す。effect は最初に表示中の結果を消し（`setFetch(null)`、:152-157）、400 ms（`FETCH_DEBOUNCE_MS`、:17、:286）の後に seed を読み直して新しい begin を出す（:198-204）。表示の結果が無い間、section は読込み中の文言を出す（`RelatedScenesSection.tsx:115-122`）。再 query の Graph は cache から `Cached` で受け、IR の到着、`current_operation`、gate、返却の直前の requalification を経て、その再 query 自身の D の窓で合流する（`related_scenes/graph.rs:292-294`、601-650）。DR-CP3A-53 は、`Cached` の再 query も再検証のために再び late になりうること、その場合 cache に戻さず `graph-ready` は出ないことを記録している。
- D′ の実機の確認 (ii)（2026-10-25、実 Electron、評価 feature つきの build、dev fixture、N=30、`dprime-check.mjs`、receipt なし。cp4:431、437-458）: 受渡しから Graph の決着まで p50 30.0 ms、max 1,721 ms。最初の begin の ticket と continue は available 30/30。`unused` の settle の後の `graph-ready` は 30/30（settle から p50 0.5 ms）、再 begin は 30/30 で Native の `cached`、その continue は 30/30 で available。`prepareFailures=0`、`driftAtQuery=0`、`deferredReleased=30`、`deferredExpired`／`deferredDropped`／`staleReadyRetired` は 0。`rawReadyElapsedMs`（Native）は seed つき p50 14.70／p90 15.55 ms、seed なし p50 14.32／p90 14.97 ms。遅い begin が 2 件（1,704.6 ms と 1,157.0 ms。原因は未特定）あり、Graph は受渡しから 1,721 ms と 1,173 ms で届いた（記録の値の差で、その 2 件の Graph は Raw-ready の 16.4 ms と 16.0 ms 後。p50 同士の差からは、通常の sample でも決着は Raw-ready の十数 ms 後と読めるが、sample ごとの差は記録に無い。推定）。対照（D′ なし）は `prepareFailures` 4、`driftAtQuery` 5、`graph-ready` 2、`cached` 0。`stamp0Missing` は 30/30（DR-CQD の §7.4 の IR scoring の読取との重なりと見られる）。dev fixture は Graph-only の行を作らず click の経路は通っていない。seed は測定用の写しにだけ query の Scene の pin として足した（DR-CP4-S1C2-26）。
- **(ii) は renderer の合流を通っていない**: 各回は低い層の renderer API で begin → continue（Native の await の上限 2 s）→ settle → `graph-ready` → 再 begin → continue と進めた（DR-CP4-S1C2-24。cp4:431）。製品の `useNir1RelatedScenes` の debounce、再 query の合流の D の窓、表示は測っていない。`t_notice`、`t_follow`、再 query の合流の outcome の記録は無い。
- 起動直後の最初の seed つきの begin は Chronicle の snapshot が usable でなく、Graph は `not-requested`（cp4:456）。2 つの表示と 2 s ごとの保存（60 s）では、registration の拒否が 5 回続いて owner が `suspended` に残り、編集を止めた 3 s 後も Graph は戻らなかった（cp4:458。(b) の側の事実）。
- D-final の READY 待ちの延びは未測定（cp4:462）。D-final は `warming` と `stale` のときだけ 4 s の予算で待つ（`nir1_graph_dfinal.rs:53`。DR-CQD の §1 の表）。
- K6/2 の手順との食い違い（cp4:466）: 手順の「各 sample の前に slot が新しい READY」は D′ で成り立たず、`steadyStateInWindow` は全 sample が窓外（`not-ready-at-start`）、D′ の Graph は再 query（cache 由来）でだけ renderer に届く。

## 設計

### follow-up の可用性

測る対象は、K6/2 の (a) と同じ分母の sample（seed がある、Graph が有効、D2a の mode が一致、snapshot が usable、事前の期待値が Graph unavailable でない variant の R+IR+Graph の arm。G-01〜G-08 の各 30 回、warm-up を除く。K6/2 の手順の 1、2）。sample の最初の query を「親」、`graph-ready` による製品の再 query を「子」と呼ぶ。

測る量: (q1) `t_notice − t_raw_ready`（Graph の側の遅れ。合否に使う）。(q2) `t_follow − t_raw_ready`（利用者が Graph を見るまでの遅れ。記録と開示）。(q3) Native の時計の受渡しから決着まで、決着から通知まで（開示だけ）。起点を Raw-ready にするのは、遅い begin は Raw そのものを遅らせる P の側の事象で、上の 2 件でも Graph は Raw-ready の十数 ms 後に届いたためである（受渡しから測れば、2/30 の遅い begin がそのまま欠落になる）。

T_late（推奨）: (q1) ≤ 100 ms。根拠: (1) Graph の query の result lease の確認済みの値（post-B:223。proposal/7 の P7-1）を使い、新しい数値を作らない。(2) D′ の決着は Raw-ready の十数 ms 後、通知は決着の p50 0.5 ms 後（推定と記録）で、余裕がある。(3) (q1) は debounce（400 ms の UI の定数）と子の begin の時間を含まない。子の Graph は子自身の D の窓（F6）で、子の R と IR は P の側で縛られるので、T_late は Graph の遅れだけを測る。(4) 100 ms を超えるのは、rebuild の窓（前の prepare から `rebuild_min_interval` 1 s 未満。`nir1_graph_product.rs:94`）、backoff、registration の拒否などで、どれも Graph の可用性の欠落として数えるべきものである。定常状態の手順は前の sample から 1 s 以上空ける（R1）ので、rebuild の窓は通常 0 になる。製品の通常の使用（場面の素早い切替え）では T_late を超えても cache の TTL の内なら表示されうるので、この基準は製品の挙動より厳しい（開示する）。

数える条件（すべてを満たす sample だけを follow-up の成功とする）:

- F1: 親の合流の outcome が `graph-late` で、宣言が `unused`（製品の挙動）。親の表示に Graph が混ざっていない。
- F2: 親の ticket の結果が available で、owner がそれを cache に入れた（その sample の間に `late_cached` が 1 増え、入れた entry の key が親の query の key）。
- F3: renderer がその project の `graph-ready` を、その sample の間にちょうど 1 回受け、`t_notice − t_raw_ready ≤ T_late`。
- F4: 子は、製品の `useNir1RelatedScenes` が親の世代について出した 1 回の再 query で、harness が出した query、`index-ready` や編集や場面の切替えによる query ではない。子の query の Scene と seed（`selectNir1GraphSeed` の読み直し）は親と同じ。
- F5: 子の begin が `Cached` で（その sample の間に `cache_hits` が 1 増える）、受けたのは F2 で入った entry（cache は sample の前に空で、その間に別の entry が入っていない）。
- F6: 子の合流の outcome が `graph-ready` で Graph を持つ（子の IR が ready で、`current_operation` と requalification を通り、子の `t_raw_ready` + D までに届いた。D は延ばさない）。
- F7: 子の結果が表示された（`completed` で publish され、その世代が現在の世代のまま）。`t_follow` を記録する。

数えない場合（follow-up の失敗。分母から除かない）:

- X1: 親の ticket の結果が `stale`、`busy`、`warming`、`registration-unavailable`、`timeout`、`invalidated` などで、cache に入らなかった。
- X2: cache に入ったが、子の前に TTL が切れた、edge の epoch が進んだ、quarantine で消えた、別の begin（D-final を含む）に取られた。
- X3: `graph-ready` が来ない、T_late を超えた、2 回以上来た（その sample は失敗として数え、2 回目以降の理由を記録する）。
- X4: 子が `Cached` でない（worker の query になった）か、F2 と別の entry を受けた（前の sample の遅れた結果を含む）。
- X5: 子の合流が `graph-late`（再び遅れた）、`graph-unavailable:<reason>`（requalification の `invalidated`、`SeedChanged` を含む）、IR の timeout か unavailable（`graph-unavailable:ir-not-ready`、Chronicle の停止による `cancelled`）。
- X6: 子が `invalidated` か `cancelled` で publish されなかった、世代が変わった。
- X7: 子が製品の再 query でない（F4 を満たさない）。harness が同じ query を繰り返して cache を当てた結果は、どの率にも成功として数えない。
- X8: 親の表示に遅れた Graph が混ざった（これは follow-up の失敗ではなく、「遅れた結果を混ぜない」の違反として FAIL。K6/4-N1）。
- X9: 子の R または IR が親と違う（定常状態の前提が崩れた。品質の判定では FAIL。R5）。
- X10: sample の記録（R7）のどれかが欠けた。欠けた sample は失敗として数え、理由を記録する。

### 表示の可用性と物差し

sample は、first-render の窓内（K6/2 の手順の 5 のまま、worker 由来の結果だけ）か follow-up の成功のどちらかなら「表示された」とする（両方は起きない。窓内なら親は `used` で cache に入らない）。表示の可用性の欠落率 = 表示されなかった sample の数 / 分母（全 case の pool）。物差しは 1%（判断を求める点 3）。pool の件数は事前の期待値で決まり、最大 240（8 case × 30）で、そのとき欠落は 2 件まで。case ごとの値（first-render の窓内、follow-up の成功、失敗の理由 X1〜X10 の内訳）も receipt に書いて開示し、表示された sample が 1 件もない case は HOLD とする。first-render の窓外率は K6/2 の規則のまま receipt に書く。IR の timeoutRate は親の IR の outcome だけで求め（K6/2 の手順の 6）、子の IR の timeout は X5 に数えるが timeoutRate に入れない。

### 品質

G-01〜G-08 の品質（G-01 の事前指定改善、macro 非回帰、Evidence 100%、禁止寄与 0）は、表示された sample の表示の結果（窓内の sample では親の合流の結果、follow-up の sample では子の合流の結果）で測り、receipt に「定常状態」と、どちらの表示かを書く。同じ case の表示の結果は、窓内と follow-up を問わず、すべて同じでなければならず、違えば FAIL とする。follow-up の sample では、子の R と IR の membership と順位が親と同じことも求める（X9）。表示されなかった sample は、R+IR に混ざりなく戻ったこと（親の表示）を確かめる。

## UX と製品の意味（コードの読取による。renderer での実測は無い）

- 見え方: 親は R+IR を Raw-ready + D（または IR の到着）で表示し、Graph は無い。`graph-ready` の後、section は表示中の結果を消して読込み中にし（`useNir1RelatedScenes.ts:152-157`、`RelatedScenesSection.tsx:115-122`）、400 ms の debounce と子の begin の後に R+IR+Graph を表示する。R+IR の membership と順位は融合の規則で保たれ（post-B:215）、Graph が足すのは既存の Scene への path Evidence と共通追加 1 枠だけなので、利用者には「同じ一覧が一度消えて、Graph の根拠と 1 行を伴って戻る」形になる見込み（推定）。「Raw の後に Graph の行が足される」形ではない。(q2) は 400 ms 以上（debounce による。コードからの下限）。一覧が一度消えることを避ける UI の変更（再 query の間も前の行を残すなど）は、この draft の範囲外で、別の lane で扱う（申し送り H3）。
- 間に起きる編集: 親の表示から子までに編集の保存があると、(i) Index が dirty になり子の IR が止まって Graph も止まる（X5）、(ii) requalification が落ちる（X5）、(iii) tree の変化で effect が新しい世代を始め、親の世代の `graph-ready` は捨てられる（X6。新しい世代の query が cache を受けて D の窓に合流すれば、(b) の規則の 2 で窓内に数える。follow-up ではない）。どれも (b) の範囲で、この draft は (b) を変えない（判断を求める点 7）。定常状態の (a) の run は編集をしない（K6/2 の手順の 3。S6）。
- P の timing: P（B、B+D の上限 65.04 ms）は親の query で測り、子は P の分母に入れない（K6/2 の手順の 7 のまま）。D′ は Raw を遅らせない（`rawReadyElapsedMs` の p50 は seed の有無で 0.4〜0.6 ms の差。cp4:454）。子は seed つきの世代ごとに begin と監査の書込みを 1 回ずつ足す（監査の行は sample あたり begin 2 回分で 10 行。cp4:449）。この負荷が P の測定に混ざらないよう、sample は直列にする（R4）。
- 最終 request の Packing（`nir1-final-request-packing-eval`、K6/3）: D-final は Related Scenes の再 query を使わず、自分の begin と READY 待ち（4 s の予算）で Graph を受ける（`nir1_graph_dfinal.rs:53`、324）。この draft は D-final にも K6/3 の行にも当たらない。ただし、D-final の begin は同じ admission で cache を取るので、同じ key の D-final が子より先に来ると follow-up は X2 になる（推定。定常状態の手順には D-final が無い）。保留中の D-final の待ちの延びは未測定（cp4:462）。

## 測定の手順の読み替え（graph-eval-procedure の手順への加算）

- R1 sample の前の前提（K6/2 の手順の 3 の「新しい READY」に替える。DR-CP4-S1C2-23）: (1) slot が `empty`（保留、保留つきの session の `preparing`／`in-use`、`suspended`、`retiring` が無い）、(2) 次 query 用の cache が空（試験専用の入口で空にする）、(3) 前の seed つきの sample の終わり（その子の publish か失敗の確定）から `rebuild_min_interval`（1 s）以上。待ちは有界で、上限は観測の前に手順のファイルに書く（推奨は保留の期限と同じ 10 s。`nir1_graph_product.rs:78`）。届かなければ `reachedQuiet: false` を記録して sample を取り、分母から除かない。待つ時間は latency に含めない。first-render の記録の「開始時の slot の状態」は `empty` を記録する（K6/2 の区分の「新しい READY」とは書かない）。
- R2 cache: 各 sample の前に空にし、sample の終わりに空であること（子が消費した）を確かめる。残っていたら記録して空にする（その sample は X4 か X7 の疑いとして理由を書く）。
- R3 通知と子の数え方: sample の間のその project の `graph-ready` の回数、各 `t_notice`、子の世代、子の begin の Native の記録（`cache_hits`、`late_cached` の差分）を記録する。子は P、IR の timeoutRate、(a) と (b) の分母に入れない（手順の 7 のまま）。
- R4 sample の独立性: sample は直列に、R+IR の arm と AB／BA で交互に行う（K6/2 の手順の 2）。sample は子の publish か失敗の確定（T_late を過ぎても通知が無い、子が publish された、session が止まった）で終わり、session を release する。harness は sample の間に編集、場面の切替え、別の query、D-final を起こさない。
- R5 製品の経路: 親と子は製品の renderer の経路（`useNir1RelatedScenes` と `RelatedScenesSection`、または同じ hook を通る harness の消費者）で出す。低い層の API で continue を直接待つ形（`dprime-check.mjs`）は、follow-up の判定に使わない（Native の値の開示にだけ使う）。seed は製品の規則（query の Scene の最初の pin）で決まるので、G-case の setup は seed を query の Scene の pin として置く（DR-CP4-S1C2-26。harness が `graphSeedEntityId` を直接渡すと子の requalification が `SeedChanged` になる）。
- R6 時計: `t_raw_ready`、`t_notice`、`t_follow`、子の `t_raw_ready` は renderer の同じ単調 clock で取る。Native の時刻は開示だけに使う。
- R7 sample ごとの記録（Mandatory defenses への加算）: 親の合流の outcome と宣言、親の ticket の outcome、R1 の (1)〜(3) と `reachedQuiet`、`late_cached` と `cache_hits` の差分、`graph-ready` の回数と各時刻、子の世代と契機、子の begin の種別（`Cached` か）、子の合流の outcome と理由と requalification の結果、`t_follow`、親と子の R と IR の membership と順位、D′ の counter（`deferredReleased`、`deferredExpired`、`deferredDropped`、`staleReadyRetired`、`prepareFailures`、`driftAtQuery`、`stamp0Missing`）、判定（窓内、follow-up の成功、X1〜X10 のどれか）。
- R8 2 つの表示と連続編集: (a) の run では行わない。(b) の trace と、K6/2 の「選択肢と推奨」の外の診断（cq-deferred-decisions.md §6.8 の 9）の範囲で、(b) の規則のまま記録する。(b) の記録には、各 query の follow-up の成否（F1〜F7 の判定）を足して開示する（合否に使わない。判断を求める点 7）。

## threat model（K6/2 の `graph-eval-procedure` への加算）

合格基準の緩和なので、確認されるまで draft とする。新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle は加えない（記録は評価 feature の下の既存の counter と renderer の時刻の読取だけ）。

- Trusted actors（加える）: 製品の `useNir1RelatedScenes` の再 query の規則と合流 helper（子の D の窓）、owner の `late_cached` と `cache_hits` の counter、renderer の単調 clock の `t_notice` と `t_follow`。
- Untrusted actors（加える）: harness が出す query、`index-ready` や編集による query、低い層の API の continue の結果、前の sample が残した cache の entry、D-final が取った cache。
- In-scope attacks（加える）: 1. harness が同じ query を出して cache を当て、follow-up に数える。2. 前の sample の遅れた結果（空にしなかった cache）を follow-up に数える。3. 子の合流が `graph-late` か unavailable なのに、Native の `cached` と available で数える。4. T_late、F1〜F7、X1〜X10、起点と終点を観測の後に結果に合わせて変える（広げる）。5. 通知が来なかった、遅れた、2 回来た sample を分母から除く。6. 子の R や IR が親と違うのに品質を測る。7. 遅れた Graph を親の表示に混ぜて「窓内」と数える。8. follow-up の成功を first-render の窓内として報告する、または first-render の窓外率を開示しない。9. seed を pin でなく harness から渡して製品と違う経路で測る。10. 欠落率を case ごとか pool かで結果を見て選ぶ。
- Out-of-scope attacks（残余として開示）: 1. 製品の通常の使用での follow-up（場面の素早い切替え、D-final との cache の取り合い、2 つの表示）は定常状態の手順では測らない。2. 子までの間の一覧の消失（UX）は合否に入らない。3. (b) の D′ の graph-late の区分（判断を求める点 7）。
- Mandatory defenses（加える）: 「設計」と「測定の手順の読み替え」の全部。T_late、F1〜F7、X1〜X10、R1 の待ちの上限は、観測の前に、この draft の凍結と手順のファイルの版で固定し、独立 reviewer のレビューを受ける。観測の後に変えてよいのは狭める方向（T_late を短くする、条件を足す）だけで、手順のファイルの新しい版、独立 reviewer のレビュー、変える前の receipt を残すことを要し、変える前の receipt は条件の判定に使わない。広げる変更は新しい draftRef でだけ行う。同じ版のファイルを書き直さない（K6/2 の手順の 4 の「作り直した版は観測の前に再び固定し、それまでの版と receipt はすべて残す」に従う）。
- Acceptance implications: 「受入れ」の節。品質の条件、IR の timeoutRate、P の Hybrid p95、D、失効率の物差し、(b) の規則は変えない。変わるのは、定常状態の可用性を表示の可用性で判定すること、品質を follow-up の表示でも測ること、sample の前の前提だけ。

## 選択肢と推奨

| 論点 | 推奨 | 対案と採らない理由 |
| ---- | ---- | ------------------ |
| D′ の下の (a) の HOLD（ユーザーが A を選んだ論点） | (A) 定義を改める（この draft） | C 案（監査を別 DB に分ける。cp4:414）と合流の経路の短縮: 大工事で、監査を移しても合流の経路（IR の到着待ち → `current_operation` → 再検証）だけで窓を超える見込み（推定。DR-CP3A-53）。D の拡大か 1% の緩和: 閾値の緩和で、D は P の固定契約の一部 |
| 終点 | `t_notice`（Graph の側）を合否に、`t_follow`（表示）を開示に | 表示を合否に使う: debounce（UI の定数）と子の Raw の時間が Graph の基準に入り、UI の変更で基準の意味が変わる（判断を求める点 2 の代案 (a)） |
| 確認の 2 段 | trigger はこの確認から、行のほかは条件の成立の後 | 全部を後にする: CP-4 が構造上 HOLD のまま |

## 受入れ（定常状態の可用性）

番号は K6/2 と衝突しないよう `K6/4-` を付ける。CP-4 の分類器は、合成の記録（実 run の記録を複製し、通知、cache の counter、子の outcome を書き換えたもの）で Negative のそれぞれを期待どおりに分けることを、観測の前に示して記録する。

Positive:

- K6/4-P1: 親が `graph-late`／`unused`、`late_cached` が 1 増え、通知が 1 回で `t_notice − t_raw_ready ≤ T_late`、子が製品の再 query で `Cached`（`cache_hits` が 1 増え）、子の合流が `graph-ready`、子の R と IR が親と同じ。follow-up の成功に数え、品質を子の表示で測る。
- K6/4-P2: 親の合流が D の窓内に worker の結果を受けた（D′ を外した build などで起きうる）。first-render の窓内に数え、子は出ない。
- K6/4-P3: pool の欠落率が 1% 以下で、どの case にも表示された sample があり、品質が条件を満たす。first-render の窓外率と follow-up の内訳を開示する。

Negative（どれも PASS にしない。率の上では失敗に数え、分母から除かない）:

- K6/4-N1: 親の表示に D の後の Graph が混ざった（「遅れた結果を混ぜない」の違反として FAIL）。
- K6/4-N2: harness が出した query の cache の hit。
- K6/4-N3: 前の sample の entry の hit（R2 の空にする操作を省いた合成の記録）。
- K6/4-N4: 子の合流が `graph-late`。
- K6/4-N5: 子の合流が `graph-unavailable:invalidated`（requalification、`SeedChanged`）。
- K6/4-N6: 子の IR が timeout か unavailable。
- K6/4-N7: `t_notice − t_raw_ready > T_late`。
- K6/4-N8: 通知が来ない、または 2 回以上。
- K6/4-N9: 子が `Cached` でない。
- K6/4-N10: cache の TTL の切れ、edge の epoch の進み、quarantine、D-final による取得の後の子。
- K6/4-N11: 子が `index-ready`、編集、場面の切替えによる query。
- K6/4-N12: 子の R か IR が親と違う（品質は FAIL）。
- K6/4-N13: 同じ case の表示の結果が sample の間で違う（FAIL）。
- K6/4-N14: 表示された sample が 1 件もない case（HOLD）。
- K6/4-N15: R7 の記録が欠けた sample。
- K6/4-N16: 低い層の API の continue だけで判定した receipt。
- K6/4-N17: 観測の後に T_late、条件、起点か終点を広げた receipt、または手順のファイルの新しい版とレビューのない変更。
- K6/4-N18: first-render の窓外率を書いていない receipt。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 | runner と分類器の変更（R1〜R8、F1〜F7、X1〜X10、K6/4-N1〜N18 の合成の記録）、手順のファイルの新しい版、G-case の setup の seed の pin。条件が成立しない間の CP-4 は、この draft の確認の後、表示の可用性で trigger を判定する |
| PUB-G／Session C-1 | first-render の窓外率、follow-up の内訳、(q2) の分布、UX（一覧の一時的な消失）を開示に添える。PUB-G の承認は置き換えない |
| DD-1、DP-H、K6/3 | 影響しない |
| D′（CQ-DEFER）、CP-3a／b | 製品のコードは変えない。H3 の UI の変更は別の lane |

## 確かめられなかったこと

1. 製品の renderer の経路での follow-up（`t_notice`、`t_follow`、子の合流の outcome）。D′ の確認 (ii) は低い層の API で continue を直接待ったので、子の Graph が子自身の D の窓に届くかは分からない。DR-CP3A-53 は再び late になりうるとしている。届かなければ、この定義でも表示の可用性は HOLD になる。そのときに子の窓を広げることは D の緩和で、この draft の外（新しい draftRef と確認が要る）。
2. 通常の sample での `t_notice − t_raw_ready` の分布（sample ごとの差は記録に無い。十数 ms は Native の時計の p50 同士の差からの推定）。renderer の `t_raw_ready` と Native の Raw-ready の差、`graph-ready` の event が renderer に届くまでの時間も測っていない。
3. G-case（CP-0 の凍結した fixture）の seed が query の Scene の pin になっているか（DR-CP4-S1C2-26 は dev fixture だけを確かめた）。
4. 遅い begin（1,704.6 ms、1,157.0 ms）の原因と頻度。子で起きた場合の (q2)。
5. D-final の待ちの延び、D-final による cache の取得の頻度、場面の素早い切替えでの rebuild の窓の影響。
6. 一覧が一度消える UX の実際の見え方（コードの読取だけ）。
7. 評価の手順のファイルの置き場所と版の名前（master にも統合 branch にも無い）。
8. 子の requalification の時間（DR-CP3A-29 の小さい fixture の release の median 6.6 ms だけ）。

## 引き継ぎ（実装と測定の担当への申し送り。この確認の条件ではない）

- H1 CP-4 の runner: sample の前の待ちを R1 にする（DR-CP4-S1C2-23 の `quietAtStart` は (1)〜(3) を持つ）。sample を製品の hook の経路で回し、`t_notice` と `t_follow` を timing shim で取り、R7 を記録する。`steadyStateInWindow` は first-render の記録として残し、表示の可用性の判定を別に足す。合成の記録で K6/4-N1〜N18 を固定する。
- H2 D′ の counter: 評価の JSON に `lateCached`、`cacheHits` の sample ごとの差分を出す（既存の counter。`nir1_graph_product.rs:385`、398）。`deferredReleased` ほか（DR-CQD-9）は統合 branch の評価 hook のまま。新しい製品の入口は足さない。
- H3 UI: 子までの間に一覧を消さない変更（`useNir1RelatedScenes.ts:157` の扱い）を検討する別の lane。Graph の UI は閉じた gate の内側（`isNir1GraphUiEnabled`）なので、PUB-G の前に決めればよい。この draft の基準は今のコードの挙動で測る。
- H4 dev fixture と G-case の seed: dev fixture `dev-lantern.v1` の query の Scene に seed の pin を置く（fixture の sha と setup が変わるので integrator の判断。DR-CP4-S1C2-26）。G-case は setup で pin を置くかを観測の前に確かめる。
- H5 最初に取るもの: この draft の凍結の後、条件の判定に使わない診断として、製品の経路の follow-up（確かめられなかったことの 1、2）を取り、子が D の窓に届くかを見る。届かない見込みが強ければ、CP-4 の正式の窓の前に integrator に返す。

## 確認の扱い

- 確認は、台帳の Confirmation protocol（2026-10-25 の緩和の後。台帳 247 行）に従い、`nir1-final-request-eval-proposal/4` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。確認されるのは冒頭の 1〜10 だけで、依存する契約、K6/2 と K6/3 のほかの行は確認されない。推奨と違う選択は新しい draftRef で起案する。
- 2026-10-25 の「K6/2 は A で」、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- 批准 6 のとおり、確認は 2 段の効力を持つ: CP-4 の trigger の読み替えはこの確認から使い、行のほかの内容は、条件が成立し、照合の 3 が済み、診断と receipt と照合の結果を添えた改めての確認が記録された後に限って効く。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」（(3) 確認済みの閾値・合格基準の緩和）にあたる。`graph-eval-procedure` には確認済みの行が無いが、612 行の trigger と post-B:225 の「品質・可用性・性能を同時に満たす」の読みを弱めるので、同じく扱う。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足（K6/3 の B4-1 の表と同じ形）: 受信の日時、承認の逐語、提示した `draftRef#contractId` と SHA-256、取り込んだ draft の SHA-256。「1 回の承認の範囲」（冒頭の 1〜10）と「K6/4 が許さないもの」（批准 9）の段落を足す。
- 確認台帳の行: `graph-eval-procedure` の /2 の行（206 行）を残し、その下に /4 の行を足す。confirmedRef は「CP-4 の trigger の読み替え（批准 6 の (i)）についてだけ `nir1-final-request-eval-proposal/4#graph-eval-procedure`。行のほかは事前の確認（preConfirmationRef）で、条件の成立の後に改めて確認されたときに批准される」と書き分ける。startStatus は `condition-not-met`。
- 台帳の注記: K6/2 の 2026-10-17 の注の下に、/4 の「変える点」の 1〜13 を読み替えとして足し、1、2、4、6 が /2 の文面より弱い読みであること、first-render の窓外率を開示し続けることを書く。
- 凍結: integrator は、条件の判定に使う診断を取る最初の run の前に、この draft の bytes を `claude/nir1-contracts` に commit して push し、K6/2 の「事前登録の凍結」の 1〜7 の記録を作る（批准 7）。
- CP-4 の TASK: 「設計」「測定の手順の読み替え」「受入れ」と引き継ぎの H1〜H5 を写す。
- 確認されなければ、CP-4 の (a) は K6/2 の文のまま D′ の下で構造上 HOLD で、別の案は /5 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行と同じ）。

- 理由: (1) この差分は、K6/2 の `graph-eval-procedure` の可用性の判定と手順の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認（台帳の Confirmation protocol）。

承認の例（固定の文でなくてよい。draftRef と contractId を名指すか、integrator が直前に SHA-256 つきで示したこの 1 行への承認の返答であればよい）:

- I confirm draftRef nir1-final-request-eval-proposal/4 for contractId graph-eval-procedure.
