# NIR-1 最終 request 評価の契約提案 proposal/4（draft）: Graph の follow-up の可用性（`graph-ready` による再 query の cache 由来の表示）

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## 平文の要約（判断の前に読む 3 行）

- 利用者に見えるもの: Related Scenes は、まず Graph の無い R+IR の一覧を出す（D′ の下では、Graph が Raw と同時に出ることはまず無い）。十数 ms 後に `graph-ready` が来ると、製品は同じ query を取り直す。RS-JOIN（別 lane。master には未だ無い）の後は、取り直しの間も一覧を保ったまま spinner だけを出し、取り直しが Graph を受ければ、Raw-ready の約 45 ms 後に Graph の根拠と 1 行を伴う一覧に入れ替わる（実測。読込み中の表示は 0 件）。受けなければ、R+IR の一覧がそのまま残る。
- 何を緩めるか（3 点。どれも合格基準の緩和）: (1) K6/2 が定常状態で求める「Raw-ready + 10.84 ms 以内に Graph が届くこと」を、follow-up（通知が T_late 以内、取り直しの表示が T_show 以内）でも満たせるとする。(2) 取り直し（子）の Graph にだけ、D より長い follow-up 専用の窓 W_f を新しく置く（最初の表示の D=10.84 ms は変えない）。(3) 実際の操作の trace（(b)）でも follow-up を数える。D、lease 100 ms、1%、「遅れた結果は既に描画した表示に混ぜない」は変えない。
- 効かない見込みと製品の変更: 今の製品では、子の Graph は子自身の D の窓にほとんど届かない（実測 5/60。子の Graph の到着は子の Raw-ready の後 p50 13.6〜13.8 ms、max 15.5 ms で、Native の DB の直列の仕事だけで D を超える）。W_f を効かせるには、**製品の合流が子にだけ W_f の窓を渡す変更が要る**（この draft の確認の後に別 lane で行う）。G-case（実際の評価の fixture）での子の到着は測っておらず、W_f の内に収まるかは分からない。

要約: (1) 確認するもの — K6/2 の `graph-eval-procedure` に「follow-up の可用性」を定義し、定常状態と trace の可用性を「表示の可用性」（最初の表示の D の窓内か follow-up の成功）で判定する。follow-up の子の Graph には専用の窓 W_f を置く。(2) ユーザーが決める点は 8 つで、技術的な点 3 つは推奨のまま確認してよい（「判断を求める点」）。(3) 最も重い開示: first-render を合否から外すと、(b) を K6/2 のまま読んだ場合、K6/2 の 721 行が D′ の構造上の graph-late を「鮮度」に入れるので (b) が成立しうる。すると 621 行の緩和（編集中の可用性を合否から外す）が、D′ の構造による遅れにまで及ぶ。推奨の判断 8 (ii) はこの連鎖を断つ。(4) (b) を K6/2 のまま残すと、閲覧中の trace の D の窓内はほぼ 0 件で、K6/2 の 619 行の「trace のどれかで Graph が一度も窓内に届かなければ PASS にしない」に当たり、PASS は構造上不可能になる。(5) この緩和は D′ の状態機械を持ち、W_f を製品に入れた候補に限る。(6) 読む順序の案: 平文の要約 →「判断を求める点」→「ユーザーが批准すること」→「設計」→「UX と製品の意味」→「変える点」→ほかは必要に応じて。

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 12 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。**承認の効力は 2 つに分かれる**（批准 6）: (i) の部分は、この承認で**確認**される（`confirmedRef` を持つ）。ほかの部分は、K6/2 の `graph-eval-procedure` と同じく**事前の確認**で、効力の根拠にしない（台帳 206 行の "ratifies nothing" と同じ扱い）。数値と根拠は各節に 1 回だけ書く。

1. 加えるもの: 「設計」の「follow-up の可用性」（測る量 q1〜q4、T_late、W_f、T_show、数える条件 F1〜F7、数えない場合 X1〜X13）と「表示の可用性」とその欠落率（定常状態は全 case の pool、trace は trace ごと）。
2. 判定の置き換え: K6/2 で可用性の合否を述べる「(a)」は表示の可用性の欠落率と読み、first-render の窓外率は記録と開示だけにする（「変える点」の 1〜3）。HOLD の既定は表示の可用性に当てて残す。
3. 品質の測り方: G-01〜G-08 の品質を、窓内の sample と follow-up で表示された sample の表示の結果で測る。
4. 測定の手順の読み替え（R1〜R8）。
5. これが合格基準の緩和にあたること（3 点）: (1) K6/2 が PASS に求める「Raw と同時に Graph が届くこと」を、「`graph-ready` の通知が T_late 以内に届き、その後の製品の再 query で T_show 以内に表示されること」で代替してよいとする（定常状態。「変える点」の 2、3、5、7、8）。(2) 子の Graph の窓を D から W_f に広げる（「変える点」の 17）。W_f は新しい閾値で、値は実測を見た後に選んだ（判断 2）。(3) 判断 8 で (ii) を選べば、実際の操作の trace でも follow-up を数える（「変える点」の 15）。弱める範囲は F1〜F7 を満たす query に限る。D=10.84 ms（最初の表示）、lease 100 ms、1%、「遅れた結果は既に描画した表示に混ぜない」は変えない。判断 8 で (b) を K6/2 のまま残すと、要約の (3) の連鎖が起きうることも、この緩和の帰結として開示する。**この緩和は D′ の状態機械（`begin_deferred` と保留つきの session。DR-CQD-1〜4）を持ち、批准 12 の W_f を製品に入れた候補に限り**、それ以外の候補には当てず、改めて確認を求める。
6. 確認の効力の時点（判断 7）: (i) この承認で確認され、記録の時点から使うもの: 「条件が成立しない場合の CP-4 の可用性」（K6/2 の 612 行）の読み替え（「変える点」の 3）と、その判定に要る定義のすべて、すなわち批准 1、批准 3（その間の CP-4 の G-case の品質を測る sample。K6/2 の手順の 8 は条件の成立の後の手順だが、612 行の判定に品質を測る sample の定義が要るので、同じ規則を (i) で使う）、批准 4、判断 8 の選択、「変える点」の 16 と 17。(ii) 事前の確認にとどまるもの: この行のほかの内容（条件の文、条件の (b) の判定の規則、手順の全体）。条件が成立し、事前登録の凍結の照合の 3 が済み、診断と receipt と照合の結果を添えた改めての確認が記録された後に限って効く。(i) で判定できるのは、批准 12 の製品の変更が入った候補だけで、入る前の候補の CP-4 は (i) の読みでも follow-up が X13 になり、HOLD の見込みが強い。
7. 事前登録と版・draftRef の読み替え（「引き継ぐもの」の 3、「変える点」の 14）: K6/2 の「事前登録の凍結」の 1〜7 を、「この file」をこの draft の bytes と読んで当てる。条件の判定に使う診断と、(i) の読み替えで判定する CP-4 の run は、この draft の凍結の後に始めたものに限り、receipt の先頭にこの draft の凍結の commit と SHA-256 を書く。K6/2 の SHA-256 を先頭に持つ receipt と診断、この draft の「事実」に書いた観測（H5 と RS-JOIN の測定を含む）は、予告として扱う。
8. 変えないもの: 「前書き」の「変えないもの」。(b) の規則は、「変える点」の 15（判断 8）の読み替えのほかは変えない（失効率の定義と物差し 1%、Q と U、trace の密度と長さ、`busy` の区分、記録の読取との重なり、主な理由と分岐）。D-final の READY 待ちと K6/3 の行も変えない。
9. 許さないもの: この確認そのものによる製品のコードの変更（批准 12 の変更は確認の後に別 lane で行う）。批准 12 のほかの製品の変更を K6/4 の名で行うこと（D、IR の deadline、debounce、次 query 用の cache、D′ の状態機械、`graph-ready` の通知、IPC の lane。RS-JOIN の変更は RS-JOIN の lane のもの）。最初の表示の D の拡大。G-case の fixture と setup の変更（seed の pin を含む。要るなら CP-0 と `g01-eval-revision` の側で扱う）。新しい authority・保存先・送信先・製品の入口。Graph の公開（PUB-G）と Session C-1 の承認。条件の成立の判定そのもの。依存する契約と K6/2・K6/3 のほかの行は確認しない。
10. threat model と受入れ: 「threat model」の加算、「受入れ」の K6/4-P1〜P3 と K6/4-N1〜N31、「変える点」の 1〜17、「引き継ぐもの」の節。
11. 確認の前の診断: H5（製品の hook を通した実現可能性の診断）は取られた（「事実」。予告）。確認を求めるときは、その結果と RS-JOIN の測定を添える。
12. 製品の変更の要件（「設計」の「W_f を製品に入れる変更」）: 子（`graph-ready` を契機にした取り直しの世代）の合流にだけ、Graph の成分の窓 W_f を渡す。子の IR の deadline、親の合流、ほかの契機の query は変えない。D の後に届いた Graph を既に公開した合流に混ぜないことと、W_f の後に届いた Graph を子に混ぜないことを保つ。変更は別 lane で、独立レビューと試験を要する。

注記（批准の対象ではない）: 2026-10-25 にユーザーが K6/2 の (a) について「K6/2 は A で」と指示した。A は「再 query の cache 由来の結果も、一定時間内なら可用性に数える定義を持つ新しい K6 の draft を起案する」で、起案の指示であり確認ではない。この起案は選択肢の逐語の問いを見ておらず、integrator の伝える要旨による。W_f、T_late と T_show の値、測る区間、数える条件、品質の扱い、確認の効力の 2 段、(b) の読み替え、製品の変更の要件は、起案者が integrator の指示を受けて加えたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/4` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行と同じ。理由は「確認文」） |
| 起案日と基点 | 2026-10-25。基点は origin/master `bdc892d7`（#717）。行番号（K6/2・K6/3 の本文、`src/`、`electron/native`、台帳 `docs/plans/nir1-l6-l9-execution-plan.md`、続行計画 `docs/plans/nir1-continuation-2026-10.md`、post-B = `docs/plans/nir1-post-b-execution-plan.md`、`docs/plans/nir1-lane-decisions/`）は `bdc892d7` で確かめた。K6/2 が引く post-B:208／214／216 は、`bdc892d7` では 217／223／225 にある。統合 branch の記録は `claude/nir1-cp4` の `docs/plans/nir1-lane-decisions/cp4-decisions.md`（以下 cp4。行番号は、DR-CP4-S1C2-27、28〔434-435 行〕と「H5 の診断の結果」〔470 行から〕は `d7521a12`、それ以外は `be8c14ca` で確かめた。`d7521a12` では 434 行より後が 2 行ずれる）と `scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts`（以下 harness。行番号は `be8c14ca` で確かめた）、RS-JOIN の記録は `claude/nir1-join-opt` の `78916cb1` の `docs/plans/nir1-lane-decisions/rs-join-decisions.md`（以下 rsj）で、どれも master に無い。K6/2 の SHA-256 `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` と K6/3 の `2ae123d2319bb0246045bebc39d2391add15deccfa0aa58d87dbfce3b8ecbf2b` は、台帳の値と一致することを再計算して確かめた |
| baseline | `nir1-final-request-eval-proposal/2#graph-eval-procedure` は確認されていない（2026-10-17 の事前の確認だけで、`confirmedRef` は none。台帳 206 行、223 行）。効いているのは、確認の前から使う規則（凍結した bytes の条件の判定の規則と、612 行の trigger。U3 の委任で、閾値を変えないことを理由に確認を待たずに使う）だけ |
| 前提 | D′（CQ-DEFER、#715）は master にある（`related_scenes/graph.rs:21-24`）。CP-4 は統合 branch で D′ を取り込み、実機の確認 (ii) と H5 を行った（cp4:424-466、cp4（`d7521a12`）:434-435、470-）。RS-JOIN の製品の 4 commit（lane の並行化、Native の起こし、IR を先に、hook の一覧の保持）は `claude/nir1-join-opt` にあり、製品の PR は別途（rsj:57-66）。CP-4 の正式の窓（S5）、条件の判定に使う診断、評価の手順のファイルはまだ無い（`evals/nir1-graph/` は G-case の fixture と freeze だけ） |
| 用語 | first-render の可用性 = K6/2 の (a) の窓内（親の合流が D の窓内に worker の結果を受けること）。follow-up の可用性 = この draft の定義。表示の可用性 = query ごとに、どちらかで Graph が表示されたこと。「親」= 利用者の操作による query、「子」= その世代について製品が `graph-ready` で出す 1 回の再 query。`t_raw_ready` = 親の Raw-ready（K6/2 の手順の 2。renderer の単調 clock）。`t_raw_ready_c` = 子の Raw-ready。`t_notice` = renderer がその project の `graph-ready` を受けた時刻。`t_graph_c` = 子の Graph の continue の答えが renderer に届いた時刻。`t_follow` = 子の fetch の結果の `timing.tReturnMs`（`fetchNir1RelatedScenes.ts:150`。同じ clock。React の commit の時刻も記録する） |
| 変えないもの | 最初の表示の D=10.84 ms（`relatedScenesConfig.ts:7`）、Graph の result lease 100 ms（admission から結果まで。post-B:171、177、223）、K1／proposal/7 の上限、P の B=54.2 ms、上限 65.04 ms（B+D）、T=2144.7 ms（post-B:223）、「既に完了した query へ遅い Graph の結果を混ぜず、次の query で使う」（post-B:217。`nir1RelatedScenesGraphJoin.ts:253-257`）、IR の timeoutRate 1%、子の IR の deadline（子の Raw-ready + D）、失効率の物差し 1%、分母を pool すること、HOLD の既定、事前登録の凍結の規則、試験専用の入口の規則、`graph-ready` の再 query を P・IR・(a)・(b) の分母に入れないこと（手順の 7）、DP-H・DD-1・K6/3 の規則、D-final の Graph の待ち（`nir1_graph_dfinal.rs:53` の 4 s）。T_late、T_show は新しい区間の基準を既存の値で置き、W_f は新しい閾値（判断 2〜4） |

## 判断を求める点

推奨のまま承認すれば推奨が確認され、推奨と違う選択は新しい draftRef で起案する。H5 と RS-JOIN の結果（「事実」）を添えて提示する。

ユーザーの判断が要る点:

| # | 論点 | 推奨 | 代案 | 批准 |
| - | ---- | ---- | ---- | ---- |
| 1 | first-render を合否に残すか（**緩和か、定義の追加か**） | 外す。可用性は表示の可用性の欠落率で判定し、first-render の窓外率は記録と開示だけにする（**合格基準の緩和**。D′ の状態機械を持ち W_f を入れた候補に限る）。ユーザーの A の目的（D′ の下で (a) が構造上 HOLD になること〔cp4:466〕を解く）を果たすのはこの案だけ | (i) 定義の追加だけ（follow-up を記録し、first-render を要件に残す。緩和でないが、D′ の下では HOLD のまま）。(ii) 両方を要件にする（同じく HOLD）。どちらも D′ を外すか合流の経路を短くする大工事を要する（cp4:410-418、DR-CQD-1、DR-RSJ-5、8） | 2、5 |
| 2 | **W_f（子の Graph の窓。新しい閾値）** | **100 ms**（子の `t_raw_ready_c` から `t_graph_c` まで）。新しい閾値を、既存の値（lease の 100 ms）で置く。導出: RS-JOIN の後の子の Graph の到着は p50 13.6／13.8 ms、p90 14.4〜14.5 ms、max 15.5 ms（rsj:79）、RS-JOIN の前は max 24.5 ms（同）。D は p50 で約 3 ms 足りない（rsj:80）。これは dev fixture の値で、G-case は Revision と候補が多く requalification が長くなりうる（DR-CP3A-29 は「候補 8 件・大きい Revision・最大の本文では収まらない見込み」とする）ので、観測の max の 6 倍余りの余裕を取る。子は表示中の一覧を保ったまま待つ（RS-JOIN の hook）ので、W_f の待ちは利用者に空の一覧を見せない。T_show の内に収まる（T_late 100 ms ＋ 通知から子の fetch まで 1.2〜1.4 ms〔rsj:86〕＋ 子の begin ＋ W_f）。`GRAPH_AWAIT_LIMIT`（2 s。Native の待受けの上限）の内側なので Native の変更は要らない。**この値は H5 と RS-JOIN の観測を見た後に選んだ** | (a) 2×D = 21.68 ms（D から導いた新しい数値。RS-JOIN の後の max 15.5 ms を覆うが、RS-JOIN の前の max 24.5 ms は覆わず、G-case の余裕は分からない）。(b) 2 s（`GRAPH_AWAIT_LIMIT`。既存の値で、実質は「Native が待つ間ならいつでも」。T_show が 2 s なので、W_f は T_show に吸収される）。(c) W_f を置かず D のまま（緩和にならないが、今の製品で 5/60、H5 で 6/60 しか届かず、表示の可用性は成り立たない） | 1、5、12 |
| 3 | T_late（Graph の側の遅れ） | `t_notice − t_raw_ready ≤ 100 ms`。新しい区間（Raw-ready から通知まで）の基準を、既存の値（lease の 100 ms）で置く。lease の区間（admission から結果まで）とは違う区間で、値を借りるだけである。観測: H5 で p50 17.0／19.4 ms、max 57.3 ms（cp4:470- の表）、RS-JOIN の後で p50 16.6／16.3 ms、max 29.1 ms（rsj:85）。起点を Raw-ready にするのは、遅い begin は Raw 自体を遅らせる P の側の事象だからで、受渡しを起点にすると D′ の確認 (ii) の 2/30 がそのまま欠落になる（**起点と値は観測を見た後に選んだ**） | 2 s（`GRAPH_AWAIT_LIMIT`）。上限なし（T_show だけで縛る） | 1 |
| 4 | T_show（利用者が Graph を見るまで） | `t_follow − t_raw_ready ≤ 2 s`（既存の値 `GRAPH_AWAIT_LIMIT` を新しい区間に置く）。観測: RS-JOIN の後 p50 44.7／45.5 ms、max 231.9 ms（rsj:87）、RS-JOIN の前（400 ms の debounce あり）p50 約 453 ms、max 1,281.8 ms（子の遅い begin）。2 s はどちらの max も覆う | (b) 和 400 ms（debounce）＋100 ms＋65.04 ms = 565.04 ms: RS-JOIN の後の max 231.9 ms は内側だが、和の根拠の 400 ms の debounce は RS-JOIN の後の `graph-ready` の取り直しには無く（DR-RSJ-6 で 0 ms）、65.04 ms は p95 の上限で sample ごとの上限に使うと 1% と両立しない。(c) 上限を置かず記録だけ | 1、5 |
| 5 | 欠落率の物差し | 1%（IR の timeoutRate、K6/2 の (a) と失効率と同じ）。定常状態は全 case の pool、表示された sample が 1 件もない case と pool が 0 件のときは HOLD。**開示**: pool が 240 件で欠落 2 件までの判定は、真の欠落率が 1% でも PASS の確率は約 57%、2% でも約 14%（二項分布で計算）で、偶然の幅が大きい | 1% より緩い値（閾値の緩和）。case ごとに 1% | 1、2 |
| 6 | G-case の品質を follow-up の表示で測るか | 測る。窓内と同じ規則（同じ case の表示の結果はすべて同じ）に、子の R と IR が親と同じことを加える | 窓内の sample だけ（D′ の下では全 case が HOLD） | 3 |
| 7 | 確認の効力の時点 | 批准 6 の 2 段（(i) は承認から、ほかは条件の成立の後） | 全部を条件の成立の後にする（その間の CP-4 は K6/2 の (a) の trigger のまま、構造上 HOLD） | 6 |
| 8 | (b)（実際の操作の trace）で follow-up を数えるか | **(ii) 数える**（(b) の緩和。「変える点」の 15。W_f も当てる）。理由: (b) を K6/2 のまま残すと、閲覧中の trace の D の窓内はほぼ 0 件で、619 行で PASS は構造上不可能になり、同時に 721 行が D′ の構造上の graph-late を「鮮度」に入れて 621 行の緩和が D′ の構造による遅れに及ぶ連鎖が起きうる。(ii) は D′ の構造上の graph-late を窓外の理由から外し、follow-up が失敗した段の理由で区分して、この連鎖を断つ。編集中の trace は、cq の F10（DR-CQD-8 の他の commit による stale）で follow-up も失敗する見込みで、(ii) でも HOLD か `[precheck]` の見込み | (i) K6/2 のまま（上の不可能と連鎖を残す。開示が要る）。(iii) 狭める（D′ の graph-late を「その他」に入れる。この行は使えず、原因を直すか新しい draftRef。閲覧中の PASS の不可能は残る） | 5、8 |

推奨のまま確認してよい技術的な点:

| # | 論点 | 推奨 | 代案 |
| - | ---- | ---- | ---- |
| T1 | 数える根拠 | 製品の renderer の経路（`useNir1RelatedScenes` を mount した消費者。H5 の `hook-check.mjs` の形）の記録と owner の counter で数え、F4 は観測で確かめる | Native の記録だけで数える（製品の合流の窓を通らない。採らない） |
| T2 | R1 と R4 の待ちの上限 | 手順のファイルで観測の前に固定し、10 s（保留の期限 `DEFERRED_RELEASE_LIMIT`。`nir1_graph_product.rs:78`）を超えない | — |
| T3 | 子の IR の deadline | D のまま（W_f は Graph の成分だけ）。子の IR の到着は RS-JOIN の後 p50 6.0／5.9 ms、max 7.1 ms（rsj:83）で D の内側 | 子の IR にも W_f を当てる（IR の deadline の緩和になり、子の R+IR の公開が遅れる。採らない） |

## 引き継ぐもの

1. K6/2 の `graph-eval-procedure` の行の全文を baseline とし、この draft の「変える点」の表を当てたものを /4 の行の内容とする。表にない K6/2 の記述は変えない。
2. K6/2 の 147 行の規則は確認された行に当たる。/2 の事前の確認は履歴として残り（台帳 206 行は消さない）、条件の成立の後に改めて確認を求めるのは /4 の行になる。
3. 事前登録: K6/2 の「事前登録の凍結」（152-160 行）に従った /2 の凍結の記録（`claude/nir1-contracts`。この起案では記録そのものを確かめていない）は消さずに残す。/4 の凍結は別の新しい commit で行う。K6/2 の 157 行（事前登録の凍結の 4）に従い、/2 の凍結の後にこの起案者が見た観測と、それを見た後に選んだ規則を書く。見た観測: cp4 の DR-CP4-S1C2-15、16、19〜28 と D′ の確認 (ii) と H5 の結果、cq-deferred-decisions.md の §6〜8、rsj の DR-RSJ-1〜9 と測定の結果。それを見た後に選んだ規則: W_f の新設と値 100 ms（子の到着の max 15.5 ms と 24.5 ms、D の超過 p50 約 3 ms）、T_late の起点を Raw-ready にしたことと値 100 ms（受渡しを起点にすると 2/30 が欠落になる観測、`t_notice` の max 57.3 ms）、T_show の 2 s（`t_follow` の max 231.9 ms と 1,281.8 ms）、T3（子の IR の到着）、R1 の前提（DR-CP4-S1C2-23）、F2 の数え方（counter の名前と、`late_cached` と `cache_hits` が 1 回ずつ動く観測、親の Graph の continue が `cancelled` になる観測）、判断 8 の推奨。どれも条件の判定に使える診断ではなく（凍結の commit と SHA-256 を先頭に持たない）、予告として扱う。条件の判定には、/4 の凍結の後に取り直したものだけを使う。
4. K6/2 の事前の確認（台帳 137 行と 206 行）、K6/2 の 2026-10-17 の注と K6/3 の 2026-10-25 の注（台帳 219-220 行）、K6/3 の確認の記録（台帳 175-185 行）は消さない。K6/3 の版の番号の読み替えは `nir1-final-request-packing-eval` の行の話で、この draft は触れない。

## 変える点（K6/2 との関係）

次の表の文だけを置き換える（または足す）。表にない K6/2 の記述は変えない。**2、3、5、7、8、15、17 は /2 の文面より弱い読み**（批准 5）。1 は 2 と 3 に伴う語の読み替え、6、11、16 は狭める防御、4 は手順の読み替え、9、10 は threat model、12 は失効、13、14 は効力と事前登録の扱いである。以下「/4 の変える点 n」と呼ぶ。

| n | 箇所（K6/2 の行） | /2 の文（要旨） | /4 の文 | 理由 |
| - | ---------------- | --------------- | ------- | ---- |
| 1 | 「(a)」を述べるすべての箇所（607、609、612、619、620、729 行を含む） | (a) の窓外率、(a) が基準を満たす／超える／物差しの内側 | 「(a) の窓外率」と「cache 由来の結果は (a) では窓外」は first-render の窓外率と読む（記録と開示）。「(a) が基準を満たす・満たさない・超える・物差しの内側」は表示の可用性の欠落率と読む | 判定の置き換え |
| 2 | 条件の (a)（609 行）と条件の前置き（606 行） | 定常状態の窓外率が 1% 以下。満たさなければ HOLD が既定 | 定常状態の表示の可用性の欠落率が 1% 以下（pool）。満たさなければ HOLD が既定。first-render の窓外率は /2 のまま求めて書く。批准 5 の候補に限る | D′ では (a) が構造上 HOLD |
| 3 | 条件が成立しない場合の CP-4 の可用性（612 行） | (a)、(b) の窓外率、(b) の失効率のどれかが 1% を超えたら HOLD | (a) は表示の可用性の欠落率、(b) の窓外率は 15 の読み。(b) の失効率は /2 のまま。承認から効く（批准 6 の (i)） | trigger の緩和は委任の外 |
| 4 | 手順の 3（695 行）の sample の前 | slot が新しい READY になったことを確かめてから query | R1 | D′ の query は READY を残さない（DR-CQD-4、DR-CP4-S1C2-23） |
| 5 | 手順の 3 と 5（695、705 行）、Mandatory defenses（619 行）の cache 由来の扱い | cache から返った結果は (a) では窓外 | first-render の窓外率では /2 のまま窓外。表示の可用性では、F1〜F7 を満たす子の表示だけを親の follow-up の成功に数える | ユーザーの A |
| 6 | 同上 | （なし） | X1〜X13 を当てる | 別の query の結果の混入を防ぐ |
| 7 | 手順の 8（708 行）、Acceptance implications（620 行） | 品質は窓内の sample で測る。窓内の sample が無い case は HOLD | 品質は表示された sample の表示の結果で測る。表示された sample が無い case と pool が 0 件のときは HOLD | D′ では窓内の sample が無い |
| 8 | 手順の 7（707 行）、(b) の規則の 1（715 行）、In-scope attacks の「event による再 query で率を上げること」（617 行）、Negative の「再 query を数える」（620 行） | 再 query は分母に入れず別に数える。再 query で率を上げることは攻撃、再 query を数えたら PASS にしない | 分母に入れないことは変えない。F1〜F7 を満たす子を親の follow-up として数えることは、617 行と 620 行の再 query の数え方に当たらない。それ以外の再 query は /2 のまま | 子は親の記録としてだけ数える |
| 9 | Untrusted actors（616 行） | 再 query、cache から返った結果は (a) の判定に使わない | first-render については /2 のまま。F1〜F7 を満たす子だけを follow-up の判定に使う | 加算 |
| 10 | In-scope attacks（617 行） | （下の各項は無い） | threat model の In-scope attacks の 1〜14 を加える | 定義の悪用を拒否する |
| 11 | Mandatory defenses（619 行）の記録、(b) の記録（737 行） | sample ごと、trace ごとの記録の項目 | R7 の項目を加える。(b) の記録には query ごとの follow-up の判定と失敗の理由（15 の区分）を加える | 受入れ |
| 12 | 失効（624 行） | 候補、手順・trace・基準のファイル、合流 helper、cache の規則などの変更で失効 | 加えて、W_f の製品の値、`FETCH_DEBOUNCE_MS` と `graph-ready` の取り直しの規則（`useNir1RelatedScenes.ts`）、D′ の状態機械と保留の期限、cache の key と TTL、IPC の lane の規則（`tauri.ts`、`ipcQueue.ts`）、Native の待受け（`related_scenes/graph.rs`）の変更で失効する。批准 5 の候補でないものには 2、3、5、7、8、15、17 を当てない | follow-up の時間と成否を決める |
| 13 | 確認の扱い（140 行）と台帳 206 行の読み | 行の内容は条件の成立と改めての確認の後にだけ効く。612 行は確認の前から使う | 批准 6 の 2 段 | 緩和を委任で使わない |
| 14 | 事前登録の凍結（152-160 行）の「この file」 | K6/2 の bytes | この draft の bytes（/2 の凍結の記録も残す） | 「引き継ぐもの」の 3 |
| 15 | (b) の窓外率と区分（610 行、619 行の「一度も窓内に届かなければ PASS にしない」、629 行の案 A の (b)、716-721 行、737 行。判断 8 で (ii) を選んだ場合） | 窓内は D の窓に合流した query だけ。D′ の構造上の graph-late は「鮮度」 | U のうち、D の窓内か follow-up の成功（F1〜F7。(b) では R1 と R2 を当てず、F2 の推論は親の begin が cache を空にすることに依る）の query を「表示された」とし、窓外率は表示されなかった query の率、619 行の「一度も窓内に」は「一度も表示されなければ」と読む。follow-up の失敗の区分は失敗した段の理由で決める: 親の ticket の `stale`／`warming`／鮮度の stamp の読取の失敗の `busy` は「鮮度」（721 行）、`registration-unavailable`、Chronicle の停止、`invalidated`、A3 の理由は「失効」（719 行）、子の合流の理由は 719-721 行の同じ規則、T_late・W_f・T_show の超過で親の ticket が available だったもの、X2〜X4、X6〜X12 は「その他」。D′ の構造上の graph-late そのものは窓外の理由にしない。失効率（717 行の 3 の (i)〜(iv)）は変えない | 閲覧中の PASS の構造上の不可能と、要約の (3) の連鎖を断つ |
| 16 | 観測の後の変更（617 行の「観測の後に定常状態や trace の定義を変えること」、620 行の Negative の「観測の後に定義を変える」、702 行の「作り直した版は観測の前に再び固定」） | 観測の後に定義を変えることは攻撃で、PASS にしない | T_late、W_f、T_show、F1〜F7、X1〜X13、R1 と R4 の待ちの上限には、観測の後に狭める方向（値を短くする、F の条件や X の項目を足す）の変更だけを許す。手順のファイルの新しい版、独立 reviewer のレビュー、変える前の receipt を残すことを要し、変える前の receipt は判定に使わない。同じ版の書き直しはしない。広げる変更は新しい draftRef でだけ行う | K6/3 の台帳 220 行の (5) と同じ形の狭める防御 |
| 17 | 窓内の判定（手順の 5、705 行）と (b) の規則の 2（716 行）を子に当てる箇所 | 返却時の再検証を通った Graph の結果が `t_raw_ready + D` までに合流したときだけ窓内 | 親（最初の表示）には /2 のまま D を当てる。子の Graph の成分には、子自身の `t_raw_ready_c + W_f` を当てる（F6）。子の IR は `t_raw_ready_c + D` のまま（T3）。W_f の後に届いた子の Graph は子に混ぜない | 子の窓の緩和（批准 5 の (2)） |

## 事実

コードは `bdc892d7` で確かめた。測定は記録にあるものだけを書き、記録に無いものは「未測定」と書く。

- D′ の Graph は常に graph-late: Related Scenes の begin は Graph の需要を保留として owner に渡し、begin 自身の監査の commit が終わった後に release する（`related_scenes/graph.rs:21-24`、DR-CQD-1）。保留つきの session は READY を公開せず、query の後に slot を `empty` に戻す（DR-CQD-4）。理由は、begin の監査の commit が worker の registration と query の `ReadIdentity` の drift として拒否されること（DR-CP4-S1C2-19、20）。
- 合流と宣言: Graph は IR と同じ deadline（`t_raw_ready` + D）で合流し、deadline は延ばさない。deadline の後の Graph は混ぜず、`graph-late` と `unused` の宣言になる（`nir1RelatedScenesGraphJoin.ts:72-77`、92-96、162-165、253-257）。宣言の後の待受けは `cancelled` を答える（`related_scenes/graph.rs:277-278`、659-660）。H5 では親の Graph の continue の答えは 60/60 で `cancelled`（cp4 の H5 の表）。`unused` の ticket の結果が available なら、owner はそれを次 query 用の cache に入れ、project ごとに `graph-ready` を出す（`nir1_graph_product.rs:888-913`、917-946、613-629）。
- cache: 1 件だけで、key は binding、caller の epoch、project、query の Scene、seed。edge の epoch が同じで TTL（既定 30 s。:98）の内だけ使える（:705-711、2688-2696）。begin が cache を見ると、key が合って使えれば取り、key を問わず使えない entry があれば消す（:596-611）。Related Scenes の begin と D-final の begin（`nir1_graph_dfinal.rs:324`）は同じ `admit_and_route` を通る（`nir1_graph_product.rs:1035-1100`）。owner の counter は `begins`、`cache_hits`、`late_cached` などの数だけで、key や ticket の識別子を持たない（:383-398、1055）。
- 再 query（`bdc892d7` の hook）: renderer は `graph-late`、`warming`、`stale`、`busy` の世代について `graph-ready` を 1 回だけ使い（`useNir1RelatedScenes.ts:26-34`、109-121、252-257）、通知の世代が現在の世代でなければ捨てる（:118）。refresh で表示中の結果を消し（`setFetch(null)`、:152-157）、400 ms の後に seed を読み直して新しい begin を出す（:17、:198-204、:286）。IR の timeout の後には別に 400 ms の再試行の timer がある（:265-273）。RS-JOIN の hook（DR-RSJ-6）は、`graph-ready` を起点にした refresh で query の鍵が同じなら表示中の結果と session を次の世代の答えまで保ち（spinner は出す）、最初の取り直しを 0 ms で出す。連鎖の取り直しとほかの契機は 400 ms のまま。
- 子の Graph の経路: 子は cache から `Cached` で受け、IR の到着、`current_operation`、gate、requalification（`assemble`）を経て合流する（`related_scenes/graph.rs:292-294`、601-650）。`bdc892d7` では、renderer の derived の lane（`src/lib/tauri.ts:260-271`、384、同時 1。`src/lib/ipcQueue.ts:23`）で子の Graph の continue が IR の continue の後ろに並ぶ。RS-JOIN は同じ operation の IR の continue と Graph の待受けだけを並行にし（DR-RSJ-2）、Native の待受けを IR の到着で起こし、同じ operation の IR を先に返す（DR-RSJ-3、4）。
- H5（RS-JOIN の前。製品の hook を mount、実 Electron、dev fixture に seed の pin、N=30 を 2 run。DR-CP4-S1C2-27、28、cp4 の H5 の表）: 親は graph-late 60/60、子の begin は `Cached` 60/60。子の合流が自分の D の窓に Graph を届けたのは 0/30 と 6/30。子の Graph の到着は子の Raw-ready から p50 14.7 と 13.2 ms。`t_notice − t_raw_ready` は p50 17.0 と 19.4 ms、max 57.3 ms。`t_follow − t_raw_ready` は p50 453.0 と 453.6 ms、max 1,281.8 ms（子の遅い begin 837.3 ms）。一覧は 60/60 で約 435 ms 読込み中に替わった。子が Graph なしで戻ったのは 30/30 と 24/30 で、その後 2 回目の `graph-ready` は出ず、一覧は Graph の無いまま残った。子の IR の timeout 2 件では hook の再試行が seed つきの begin を出し、graph-late → `graph-ready` → 子を繰り返した。
- RS-JOIN の後（3 run の before と 2 run の after、各 N=30。DR-RSJ-8、9、rsj:76-94）: 子が窓に届いたのは 2/30 と 3/30（5/60。before は 9/90）。子の Graph の到着は p50 13.6／13.8 ms、p90 14.5／14.4 ms、max 15.5／14.9 ms（before は max 24.5 ms まで）。D の超過は p50 3.0／3.1 ms。Graph の continue の queue の待ちは 0.1 ms（before 4.7〜6.2 ms）。子の IR の到着は p50 6.0／5.9 ms、max 7.1／6.6 ms。`t_notice − t_raw_ready` は p50 16.6／16.3 ms、max 18.0／29.1 ms。通知から子の fetch の開始は 1.2／1.4 ms。`t_follow − t_raw_ready` は p50 44.7／45.5 ms、max 48.3／231.9 ms。読込み中に替わった sample は 0。子が Graph なしで戻ったのは 28 と 27。Native の内訳（子、IR の slot が埋まった時点から）: IR の再検証 1.5 ms → Graph の `current_operation` 1.6 ms → `assemble` 6.2〜6.4 ms（p50）が同じ DB の mutex の上で直列に続き、子の Raw-ready から IR の slot まで約 4 ms（推定）。順序の制約を外しても約 12 ms、`current_operation` を省いても約 12.2 ms（どちらも測っていない見積り。DR-RSJ-8）。鮮度と再検証を弱める案（Cached のとき検証を省く、IR の再検証の結論を使い回す）は見送られた（DR-RSJ-5 (b)(d)）。
- 起動直後の最初の seed つきの begin は Graph が `not-requested`（cp4:456）。2 つの表示と 2 s ごとの保存（60 s）では owner が `suspended` に残り、編集を止めた 3 s 後も Graph は戻らなかった（cp4:458。(b) の側の事実）。D-final の READY 待ちの延びは未測定（cp4:462）。
- K6/2 の手順との食い違い（cp4:466）: 手順の「各 sample の前に slot が新しい READY」は D′ で成り立たず、`steadyStateInWindow` は全 sample が窓外、D′ の Graph は再 query（cache 由来）でだけ renderer に届く。

## 設計

### follow-up の可用性

定常状態の対象は K6/2 の (a) と同じ分母の sample（seed がある、Graph が有効、D2a の mode が一致、snapshot が usable、事前の期待値が Graph unavailable でない variant の R+IR+Graph の arm。G-01〜G-08 の各 30 回、warm-up を除く）。trace の対象は判断 8 の (ii) で U の query。

測る量: (q1) `t_notice − t_raw_ready`（通知の遅れ。上限 T_late）。(q2) `t_graph_c − t_raw_ready_c`（子の Graph の到着。上限 W_f）。(q3) `t_follow − t_raw_ready`（利用者が Graph を見るまで。上限 T_show）。(q4) Native の時計の受渡しから決着まで、決着から通知まで、子の内訳（開示だけ）。値は判断 2〜4。

数える条件（すべてを満たす query だけを follow-up の成功とする）:

- F1: 親の IR が ready で、親の合流の outcome が `graph-late`、宣言が `unused`。親の表示に Graph が混ざっていない。
- F2: 親の begin から子の begin の直前までの間に、owner の `begins` の差分がちょうど 1（親）、`late_cached` の差分がちょうど 1。子の begin で `begins` と `cache_hits` がちょうど 1 ずつ増える（定常状態では、R2 で空にした後の sample の全体で `begins` 2、`late_cached` 1、`cache_hits` 1）。**entry が親の ticket のものであることは counter から観測できない**（ID を持たない）。親の begin が cache を見た時点で cache は空になる（:596-611）ので、その後に入った entry は、その間に唯一 begin した親の ticket のものと推論する。親の Graph の continue の答えは製品の経路では `cancelled` になる（「事実」）ので、条件に使わない（記録はする）。
- F3: renderer がその project の `graph-ready` を親の `t_raw_ready` の後に受け、最初の通知が (q1) ≤ T_late。2 回目以降の通知は記録し、それだけでは失敗にしない。
- F4（観測で確かめる）: 親の世代と子の間に `index-ready` が無い、親の IR が ready（IR の timeout の再試行の timer が動いていない）、子の begin が `t_notice` の後で、子の世代は親の次の世代で `graph-ready` を契機にしたもの、F2 の `begins` の差分が成り立つ、子の query の Scene と seed（`selectNir1GraphSeed` の読み直し）が親と同じ。
- F5: 子の begin が `Cached`（F2 の `cache_hits` の増分）。
- F6: 子の合流の outcome が `graph-ready` で、Graph を持つ。子の IR が `t_raw_ready_c + D` までに ready で（T3）、子の Graph が (q2) ≤ W_f で届いた（製品の合流が子に W_f を渡す。批准 12）。「Graph を持つ」は、requalification を通った Graph の結果の edge が 1 件以上あり、事前登録した期待寄与の材料（K6/2 の手順の 4。定常状態では setup で確かめた材料）から寄与があることをいう。
- F7: 子の結果が `completed` で publish され、その世代が現在の世代のまま表示され、(q3) ≤ T_show。

数えない場合（follow-up の失敗。分母から除かない）:

- X1: 親の ticket の結果が `stale`、`busy`、`warming`、`registration-unavailable`、`timeout`、`invalidated` などで、cache に入らなかった。
- X2: cache に入ったが、子の前に TTL が切れた、edge の epoch が進んだ、quarantine で消えた、別の begin（key を問わない。D-final を含む）が子より先に cache を見た。
- X3: `graph-ready` が来ない、または最初の通知が T_late を超えた。
- X4: 子が `Cached` でない、F2 の counter の差分が合わない（`late_cached` の差分が 2 以上、`begins` の差分が多い）。
- X5: 子の合流が `graph-unavailable:<reason>`（requalification の `invalidated`、`SeedChanged` を含む）、子の IR の timeout か unavailable、寄与の空の Graph（F6）。
- X6: 子が `invalidated` か `cancelled` で publish されなかった、世代が変わった（場面の移動を含む）。
- X7: F4 を満たさない（`index-ready`、編集、IR の再試行、harness による query が子になった）。harness が同じ query を繰り返して cache を当てた結果は、どの率にも成功として数えない。
- X8: (q3) が T_show を超えた。
- X9: 子の R または IR の membership と順位が親と違う（品質の判定では FAIL）。比べるのは親の IR が ready の場合だけ。
- X10: R7 の記録のどれかが欠けた、または定常状態で `reachedQuiet: false` だった。
- X11: 親の IR が timeout か unavailable（Graph は ready の IR とだけ使う。`nir1RelatedScenesGraphJoin.ts:174-180`）。
- X12: 親の合流が `graph-unavailable:<reason>` か `cancelled`（`graph-late` でない）の世代だった。
- X13: 子の Graph が W_f の後に届いた（子の合流は `graph-late`）。候補の製品の合流が子に W_f を渡していない場合（批准 12 の変更の前）は、子の窓が D なので、D の後の到着はすべて X13 になる。

遅れた Graph が親の表示に混ざったとき、または W_f の後の Graph が子の表示に混ざったときは、follow-up の成否とは別に、「遅れた結果を混ぜない」の違反として FAIL にする（K6/4-N1、N29）。

### 表示の可用性と物差し

query は、first-render の窓内（K6/2 の手順の 5 のまま、D、worker 由来の結果だけ）か follow-up の成功のどちらかなら「表示された」とする（両方は起きない。窓内なら親は `used` で cache に入らない）。定常状態の欠落率 = 表示されなかった sample の数 / 分母（全 case の pool）。物差しは 1%（判断 5）。pool の件数は事前の期待値で決まり、最大 240（8 case × 30）で、そのとき欠落は 2 件まで。case ごとの値（first-render の窓内、follow-up の成功、X1〜X13 の内訳、q1〜q4 の分布）を receipt に書いて開示し、表示された sample が 1 件もない case と、pool が 0 件のときは HOLD とする。first-render の窓外率は K6/2 の規則のまま receipt に書く。IR の timeoutRate は親の IR の outcome だけで求め（手順の 6）、子の IR の timeout は X5 に数えるが timeoutRate に入れない。

### 品質

G-01〜G-08 の品質（G-01 の事前指定改善、macro 非回帰、Evidence 100%、禁止寄与 0）は、表示された sample の表示の結果（窓内なら親の合流の結果、follow-up なら子の合流の結果）で測り、receipt に「定常状態」と、どちらの表示かを書く。同じ case の表示の結果は、窓内と follow-up を問わず、すべて同じでなければならず、違えば FAIL とする。follow-up の sample では X9 を求める。表示されなかった sample は、R+IR に混ざりなく戻ったこと（親の表示）を確かめる。この規則は、条件が成立しない間の CP-4 でも使う（批准 6 の (i)）。

### W_f を製品に入れる変更（批准 12。この draft の確認の後に別 lane で行う）

- 範囲: `nir1RelatedScenesGraphJoin.ts`（Graph の成分の deadline を IR の deadline と分け、子にだけ `t_raw_ready_c + W_f` を渡せるようにする。親とほかの契機は D のまま）、`fetchNir1RelatedScenes.ts`（その世代が `graph-ready` を契機にした取り直しかを受け、合流に窓を渡す）、`useNir1RelatedScenes.ts`（取り直しの世代を印す。RS-JOIN の hook の上に置く）。Native の待受けの上限 `GRAPH_AWAIT_LIMIT`（2 s）は W_f（100 ms を推奨）より長いので変えない見込み。operation の lease が W_f の間生きていることは、変更の lane で確かめる。
- 保つこと: (1) 親の合流は D で公開し、公開した結果に後から Graph を混ぜない（`nir1RelatedScenesGraphJoin.ts:253-257` の規則）。(2) 子は新しい query で、親の一覧は RS-JOIN の hook が保つだけで、子の結果が公開されたときに置き換わる（既に描画した合流に混ぜるのではない）。(3) W_f の後に届いた子の Graph は子に混ぜず、`graph-late` として扱う。(4) 子の IR の deadline は D のまま（T3）で、IR の timeoutRate と P の分母に子を入れない。(5) 子の `unused` の宣言と、`Cached` の slot を cache に戻さない規則（DR-CP3A-53）は変えない。
- 受入れ（変更の lane で）: 親と子の窓の分離の試験、W_f の後の Graph を混ぜない試験、子でない契機の query が D のままである試験、独立レビュー。値は契約の W_f と一致し、変われば K6/4 の receipt は失効する（「変える点」の 12）。

## UX と製品の意味

- 見え方（RS-JOIN の後。実測）: 親は R+IR を Raw-ready + D（または IR の到着）で表示し、Graph は無い。`graph-ready` の後、section は表示中の一覧を保ったまま spinner を出し、子が Graph を受ければ、Raw-ready の約 45 ms 後（p50）に R+IR+Graph に入れ替わる（R+IR の membership と順位は融合の規則で保たれ〔post-B:215〕、Graph が足すのは既存の Scene への path Evidence と共通追加 1 枠だけ）。読込み中の表示は 0 件だった（rsj:88）。子が Graph を受けなければ、ほぼ同じ R+IR の一覧に入れ替わるだけで、Graph は出ない（今の製品では 55/60）。W_f を入れれば、子の待ちが最大 W_f 延びるが、その間も一覧は保たれる。
- 見え方（`bdc892d7` の hook。H5 の実測）: `graph-ready` のたびに一覧が約 435 ms 読込み中に替わり、子が失敗しても同じように消えて Graph の無い R+IR のまま戻った。一覧を保ったまま取り直す改善は RS-JOIN で実装済み（DR-RSJ-6。製品の PR は別途で、master には未だ無い）。PUB-G の開示（Session C-1）では、どちらの hook の候補かと、この見え方を必須の項目として示す。
- 最初の表示と follow-up の違い: 最初の表示は、Graph を待つ間に利用者へ何も見せられないので、D=10.84 ms の厳しさに意味がある（D は変えない）。follow-up は元の一覧を見せたまま入れ替わるので、W_f の待ちが利用者を待たせる害は小さい（RS-JOIN の hook の候補に限る）。
- 場面の移動: 親の世代の通知は、場面を移ると捨てられ（:118）、移った先の begin が key の違う cache を消す（`nir1_graph_product.rs:605-607`）。cache の TTL の内に表示されうるのは、その場面に留まる場合だけである。
- 間に起きる編集: 親の表示から子までに保存があると、Index の dirty で子の IR と Graph が止まる、requalification が落ちる、tree の変化で新しい世代が始まり親の世代の通知は捨てられる（X5、X6）。どれも (b) の範囲で、判断 8 の (ii) では follow-up の失敗として、失敗した段の理由で区分する。定常状態の run は編集をしない（K6/2 の手順の 3）。
- P の timing: P は親の query で測り、子は P の分母に入れない（手順の 7 のまま）。D′ は Raw を遅らせない（cp4:454）。子は seed つきの世代ごとに begin と監査の書込みを 1 回ずつ足す（監査の行は sample あたり 10 行。rsj:91）。sample は直列にする（R4）。
- 最終 request の Packing（K6/3）: D-final は子を使わず、自分の begin と READY 待ち（4 s の予算）で Graph を受ける（`nir1_graph_dfinal.rs:53`、324）。この draft は D-final にも K6/3 の行にも当たらない。D-final の begin が子より先に cache を見ると follow-up は X2 になる（コードの読取）。

## 測定の手順の読み替え（graph-eval-procedure の手順への加算）

- R1 定常状態の sample の前の前提（K6/2 の手順の 3 の「新しい READY」に替える。DR-CP4-S1C2-23）: (1) slot が `empty`（保留、保留つきの session の `preparing`／`in-use`、`suspended`、`retiring` が無い）、(2) 次 query 用の cache が空（試験専用の入口で空にする）、(3) 前の seed つきの sample の終わりから `rebuild_min_interval`（1 s。`nir1_graph_product.rs:94`）以上。待ちの上限は T2。届かなければ `reachedQuiet: false` を記録して sample を取り、分母から除かず、follow-up の成功にしない（X10）。待つ時間は latency に含めない。
- R2 cache: 定常状態の各 sample の前に空にし、sample の終わりに空であること（子が消費した）を確かめる。残っていたら記録して空にする。trace の run では K6/2 の 704 行のとおり空にしない。
- R3 通知と子の数え方: 親ごとに、`graph-ready` の回数と各 `t_notice`、子の世代と契機（F4 の観測）、owner の counter（`begins`、`cache_hits`、`late_cached`）の親の begin の前と子の begin の後の値を記録する。子は P、IR の timeoutRate、(a) と (b) の分母に入れない。
- R4 sample の独立性と終わり: 定常状態の sample は直列に、R+IR の arm と AB／BA で交互に行う（K6/2 の手順の 2）。sample は、子の publish、`t_raw_ready` + T_show の経過、session の停止のうち最も早いもので終わる。その後の session の release の待ちの上限は T2 と同じく手順のファイルで固定する。harness は sample の間に編集、場面の切替え、別の query、D-final を起こさない。
- R5 製品の経路: 親と子は `useNir1RelatedScenes` を mount した消費者（H5 の `hook-check.mjs` と `cp4-hook-probe.tsx` の形。DR-CP4-S1C2-27）で出す。CP-4 の runner の harness は hook を mount せず、`fetchRelatedPastScenes` を直接呼び、seed を harness が渡す（harness:250-259、642-648）ので、正式の窓でも hook の消費者を使う。低い層の API で continue を直接待つ形は判定に使わない。seed は製品の規則（query の Scene の最初の pin）で決まる。G-case の setup が seed を pin として置いていなければ、この draft はその変更を許さない（批准 9）。
- R6 時計: `t_raw_ready`、`t_notice`、`t_raw_ready_c`、`t_graph_c`、`t_follow` は renderer の同じ単調 clock で取る。Native の時刻は開示だけに使う。
- R7 query ごとの記録（Mandatory defenses への加算）: 親の合流の outcome と宣言、親の IR の outcome、親の Graph の continue の答え、R1 の (1)〜(3) と `reachedQuiet`（定常状態）、R3 の counter と通知の記録、子の世代と F4 の観測、子の begin の種別、子の合流に渡した窓（W_f か D か）、子の IR の到着、`t_graph_c`、子の合流の outcome と理由と requalification の結果と edge の件数と期待寄与、`t_follow` と React の commit の時刻、一覧が読込み中に替わったかとその時間、親と子の R と IR の membership と順位、D′ の counter（`deferredReleased`、`deferredExpired`、`deferredDropped`、`staleReadyRetired`、`prepareFailures`、`driftAtQuery`、`stamp0Missing`）、判定（窓内、follow-up の成功、X1〜X13 のどれか、(b) では 15 の区分）、候補が RS-JOIN と批准 12 の変更を含むか。
- R8 2 つの表示と連続編集: 定常状態の run では行わない。(b) の trace と、cq-deferred-decisions.md §6.8 の 9 の診断の範囲で記録する。

## threat model（K6/2 の `graph-eval-procedure` への加算）

合格基準の緩和なので、確認されるまで draft とする。この draft は新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle を加えない（記録は評価 feature の下の既存の counter と renderer の時刻の読取だけ）。批准 12 の製品の変更は、合流の窓の値だけで、その lane が GDX-PRECHECK-001 の lifecycle の記録を作る。

- Trusted actors（加える）: 製品の `useNir1RelatedScenes` の取り直しの規則と合流 helper（親の D、子の W_f）、owner の `begins`、`cache_hits`、`late_cached` の counter、renderer の単調 clock の時刻。再 query のうち使ってよいのは F4 を満たす子だけで、ほかの再 query は K6/2 の 616 行のとおり Untrusted。
- Untrusted actors（加える）: harness が出す query、`index-ready`・編集・IR の再試行による query、低い層の API の continue の結果、前の sample が残した cache の entry、D-final が見た cache。
- In-scope attacks（加える）: 1. harness が同じ query を出して cache を当て、follow-up に数える。2. 前の sample の遅れた結果、または R2 の後に前の ticket が同じ key で埋めた entry を follow-up に数える。3. 子の合流が `graph-late` か unavailable なのに、Native の `cached` と available で数える。4. T_late、W_f、T_show、F1〜F7、X1〜X13、起点と終点を観測の後に広げる。5. 通知が来なかった、遅れた、`reachedQuiet: false` の sample を分母から除く。6. 子の R や IR が親と違うのに品質を測る。7. 遅れた Graph を親の表示に混ぜて「窓内」と数える。8. follow-up の成功を first-render の窓内として報告する、または first-render の窓外率を開示しない。9. seed を pin でなく harness から渡して製品と違う経路で測る。10. 欠落率を case ごとか pool かで結果を見て選ぶ。11. 寄与の空の Graph を表示の成功と数える。12. D′ の構造上の graph-late を「鮮度」に入れて (b) の条件を成立させる（判断 8 で (ii) を選んだ場合）。13. W_f を親やほかの契機の query に当てる、子の IR の deadline を延ばす、W_f の後の Graph を子に混ぜる。14. 製品の W_f と契約の W_f が違う候補で測る。
- Out-of-scope attacks（残余として開示）: 1. 製品の通常の使用での follow-up（場面の素早い切替え、D-final との cache の取り合い）は定常状態の手順では測らない。2. 同じ project の 2 つの表示が別の Scene を見ていると、通知が project 単位なので、編集が無くても数周往復しうる（推定。未測定）。3. 欠落 2 件までの判定の偶然の幅（判断 5 の開示）。
- Mandatory defenses（加える）: 「設計」と「測定の手順の読み替え」の全部と「変える点」の 16、17。T_late、W_f、T_show、F1〜F7、X1〜X13、R1 と R4 の待ちの上限は、観測の前に、この draft の凍結と手順のファイルの版で固定し、独立 reviewer のレビューを受ける。CP-4 の分類器は、受入れの Negative の合成の記録で検出力を示してから使う。
- Acceptance implications: 「受入れ」の節。品質の条件、IR の timeoutRate、P の Hybrid p95、最初の表示の D、失効率の物差しは変えない。

## 選択肢と推奨

| 論点 | 推奨 | 対案と採らない理由 |
| ---- | ---- | ------------------ |
| D′ の下の (a) の HOLD（ユーザーが A を選んだ論点） | (A) 定義を改める（この draft）。子の窓に W_f を置く | C 案（監査を別 DB に分ける。cp4:414）と合流の経路の短縮: 大工事で、RS-JOIN の後も Native の DB の直列の仕事だけで D を超え、残る手段は `assemble` の分割（db crate の検証の分割。DR-RSJ-5 (c)）か窓の定義の変更（DR-RSJ-8）。最初の表示の D の拡大か 1% の緩和: D は P の固定契約の一部 |
| 終点 | `t_notice`（T_late）、`t_graph_c`（W_f）、`t_follow`（T_show）を合否に使う | 1 つだけ: 通知だけでは表示が遅れても通り、表示だけでは Graph の側の遅れと UI の定数を区別できない |
| 確認の 2 段 | (i) は承認から、ほかは条件の成立の後 | 全部を後にする: CP-4 が構造上 HOLD のまま |

## 受入れ（可用性）

番号は K6/2 と衝突しないよう `K6/4-` を付ける。CP-4 の分類器は、合成の記録（実 run の記録を複製し、通知、counter、子の outcome、時刻を書き換えたもの）で Negative のそれぞれを期待どおりに分けることを、観測の前に示して記録する。

Positive:

- K6/4-P1: F1〜F7 をすべて満たす。follow-up の成功に数え、品質を子の表示で測る。
- K6/4-P2: 親の合流が D の窓内に worker の結果を受けた。first-render の窓内に数え、子は出ない。
- K6/4-P3: 定常状態の pool の欠落率が 1% 以下で、どの case にも表示された sample があり、品質が条件を満たす。first-render の窓外率と follow-up の内訳と q1〜q4 の分布を開示する。

Negative（どれも成功に数えない。分母から除かない）:

- K6/4-N1: 親の表示に D の後の Graph が混ざった（FAIL）。
- K6/4-N2: harness が出した query の cache の hit（X7）。
- K6/4-N3: R2 で空にした後に、前の sample の ticket が同じ key で cache を埋め、子がそれを受けた合成の記録（X4）。
- K6/4-N4: 子の合流が `graph-late`（X13）。
- K6/4-N5: 子の合流が `graph-unavailable:invalidated`（requalification、`SeedChanged`）（X5）。
- K6/4-N6: 子の IR が timeout か unavailable（X5）。
- K6/4-N7: 最初の通知が T_late を超えた（X3）。
- K6/4-N8: 通知が来ない（X3）。
- K6/4-N9: 子が `Cached` でない（X4）。
- K6/4-N10: TTL の切れ、edge の epoch の進み、quarantine、別の begin（D-final を含む）が先に cache を見た後の子（X2）。
- K6/4-N11: 子が `index-ready`、編集、場面の切替え、IR の再試行による query（X7）。
- K6/4-N12: 子の R か IR が親と違う（X9。品質は FAIL）。
- K6/4-N13: 同じ case の表示の結果が sample の間で違う（FAIL）。
- K6/4-N14: 表示された sample が 1 件もない case、pool が 0 件（HOLD）。
- K6/4-N15: R7 の記録が欠けた query（X10）。
- K6/4-N16: 低い層の API の continue だけで判定した receipt。
- K6/4-N17: 観測の後に T_late、W_f、T_show、条件、起点か終点を広げた receipt、または手順のファイルの新しい版とレビューのない変更（「変える点」の 16）。
- K6/4-N18: first-render の窓外率を書いていない receipt。
- K6/4-N19: 親の ticket が `stale` で cache に入らなかった（X1）。
- K6/4-N20: 子が publish されず世代が変わった（X6）。
- K6/4-N21: 欠落率を case ごとか pool かで結果を見て選んだ receipt。
- K6/4-N22: 親の合流が `graph-unavailable:warming`、`stale`、`busy` で refresh した子（X12）。
- K6/4-N23: `late_cached` の差分が 2 以上（X4）。
- K6/4-N24: `reachedQuiet: false` の sample（X10）。
- K6/4-N25: IR の timeout の再試行による子（X7）。
- K6/4-N26: 子の Graph の edge が 0 件か期待寄与が無い（X5）。
- K6/4-N27: (q3) が T_show を超えた（X8）。
- K6/4-N28: 親の IR が timeout の sample（X11）。
- K6/4-N29: W_f の後に届いた子の Graph が子の表示に混ざった（FAIL）。
- K6/4-N30: 製品の W_f が契約の W_f と違う、子の IR の deadline が D より長い、または W_f が親かほかの契機の query に当たった候補の receipt（批准 12 の違反として判定に使わない）。
- K6/4-N31: 子の Graph が W_f の後に届いた（X13）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| W_f の製品の変更（新しい lane） | 批准 12 の変更。この draft の確認の後に行い、独立レビューと試験を要する。RS-JOIN の hook の上に置く |
| RS-JOIN | 製品の PR は別途（この draft の範囲外）。この draft の UX と T_show の観測は RS-JOIN の候補の値で、RS-JOIN の無い候補では T_show の余裕が小さい（H5 の max 1,281.8 ms） |
| CP-4 | hook の消費者（R5）、runner と分類器の変更（R1〜R8、F1〜F7、X1〜X13、K6/4-N1〜N31 の合成の記録）、手順のファイルの新しい版。G-case の seed の pin が要るなら CP-0 の側で扱う |
| PUB-G／Session C-1 | first-render の窓外率、follow-up の内訳、q1〜q4 の分布、W_f、UX（どちらの hook か）、判断 5 の偶然の幅を開示に添える。PUB-G の承認は置き換えない |
| DD-1、DP-H、K6/3 | 影響しない |

## 確かめられなかったこと

1. G-case（CP-0 の凍結した fixture）での子の Graph の到着と W_f の余裕。H5 と RS-JOIN は dev fixture（Graph-only の行を作らない、小さい）で、G-case は Revision と候補が多く requalification が長くなりうる（DR-CP3A-29）。
2. W_f を入れた製品の候補での follow-up の率（批准 12 の変更はまだ無い）。
3. 編集の最中の follow-up（(b) の編集中の trace）。cq の F10 で親も子も stale になる見込み。
4. D-final との競合（D-final の begin が子より先に cache を見る頻度、保留中の D-final の待ちの延び。cp4:462）。
5. 同じ project の 2 つの表示の往復（RS-JOIN の後の hook での回数）。
6. `t_notice` の clock の差: renderer の `t_raw_ready` と Native の Raw-ready の差、`graph-ready` の event が renderer に届くまでの時間の内訳（H5 は「親の結果の返却から通知まで」p50 5.5／7.8 ms を記録したが、Native の時刻との対応は取っていない）。
7. 遅い begin（1,704.6 ms、1,157.0 ms、子の 837.3 ms）の原因と頻度。
8. G-case の seed が query の Scene の pin になっているか（DR-CP4-S1C2-26 は dev fixture だけを確かめた）。
9. 評価の手順のファイルの置き場所と版の名前（master にも統合 branch にも無い）。
10. 判断 8 の (ii) の下での閲覧中の trace の表示の率。

## 引き継ぎ（実装と測定の担当への申し送り。この確認の条件ではない）

- H1 CP-4 の runner: R1 の待ち（DR-CP4-S1C2-23 の `quietAtStart`）、hook の消費者（`hook-check.mjs` の形）、`t_notice`、`t_graph_c`、`t_follow` の timing shim、R7 の記録、合成の記録で K6/4-N1〜N31 を固定する。`steadyStateInWindow` は first-render の記録として残し、表示の可用性の判定を別に足す。
- H2 counter: 評価の JSON に `begins`、`cacheHits`、`lateCached` を、親の前と子の後に読めるように出す（既存の counter。`nir1_graph_product.rs:383-398`）。新しい製品の入口は足さない。
- H3 UI: 一覧を保ったまま取り直す改善は RS-JOIN で実装済み（DR-RSJ-6。製品の PR は別途）。
- H4 seed: dev fixture `dev-lantern.v1` の query の Scene に seed の pin を置くかは integrator の判断（DR-CP4-S1C2-26）。G-case の setup の変更は CP-0 と `g01-eval-revision` の側で扱い、この draft は許さない。
- H5 実現可能性の診断: 取られた（DR-CP4-S1C2-27、28、DR-RSJ-8）。次に要るのは、W_f を入れた候補（批准 12）で、できれば G-case に近い fixture で、子の到着と follow-up の率を見る診断（条件の判定に使わない）。CP-4 の正式の窓の前に取り、W_f の内に収まらない見込みが強ければ integrator に返す。

## 確認の扱い

- 確認は、台帳の Confirmation protocol（2026-10-25 の緩和の後。台帳 247 行）に従い、`nir1-final-request-eval-proposal/4` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。承認の効力は批准 6 の 2 段で、(i) は確認、ほかは事前の確認である。依存する契約、K6/2 と K6/3 のほかの行は確認されない。推奨と違う選択は新しい draftRef で起案する。
- 2026-10-25 の「K6/2 は A で」、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- 確認を求めるときは、H5 と RS-JOIN の結果を添える（批准 11）。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」（(3) 確認済みの閾値・合格基準の緩和）にあたる。`graph-eval-procedure` には確認済みの行が無いが、612 行の trigger と post-B:225 の「品質・可用性・性能を同時に満たす」の読みを弱め、W_f という新しい閾値を置くので、同じく扱う。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足（K6/3 の B4-1 の表と同じ形）: 受信の日時、承認の逐語、提示した `draftRef#contractId` と SHA-256、取り込んだ draft の SHA-256、H5 と RS-JOIN の結果の所在。「承認の範囲と効力」（冒頭の 1〜12 と、批准 6 の (i) と (ii) の分け方）と「K6/4 が許さないもの」（批准 9）の段落を足す。
- 確認台帳の行: `graph-eval-procedure` の /2 の行（206 行）を残し、その下に /4 の行を足す。confirmedRef は「批准 6 の (i) についてだけ `nir1-final-request-eval-proposal/4#graph-eval-procedure`」、行のほかは preConfirmationRef（効力の根拠にしない）と書き分ける。startStatus は `condition-not-met`。
- 台帳の読み替えの注（文案）: 223 行の注の下に「2026-10-25 以降の注（K6/4）: `graph-eval-procedure` の /4 の行は、批准 6 の (i)（条件が成立しない場合の CP-4 の可用性の読み替えと、その判定に要る定義）についてだけ confirmedRef を持つ。行のほかの内容は、条件の成立の後の改めての確認まで効かない（上の注のとおり）。`g01-eval-revision` は変わらない」。206 行の備考の「既存の条件の CP-4 は、K6/2 の『条件が成立しない場合の CP-4 の可用性』に従う」の下に「K6/4 の確認の後は、/4 の『変える点』の 3 の読み（(a) は表示の可用性の欠落率、(b) の窓外率は /4 の 15 の読み）で従う。この読みは D′ の状態機械を持ち、W_f を製品に入れた候補に限る」。K6/2 の 2026-10-17 の注の下に、/4 の「変える点」の 1〜17 を読み替えとして足し、2、3、5、7、8、15、17 が /2 の文面より弱い読みであること、first-render の窓外率を開示し続けることを書く。
- 凍結の順序: integrator は、条件の判定に使う診断を取る最初の run の前、かつ (i) の読み替えで判定する CP-4 の最初の run の前に、この draft の bytes を `claude/nir1-contracts` に commit して push し、K6/2 の「事前登録の凍結」の 1〜7 の記録を作る（批准 7）。(i) で判定する CP-4 の run は、この凍結の後に始めたものに限る。
- W_f の製品の変更の lane と CP-4 の TASK: 「設計」の「W_f を製品に入れる変更」、「測定の手順の読み替え」、「受入れ」と引き継ぎの H1、H2、H4、H5 を写す。
- 確認されなければ、CP-4 の (a) は K6/2 の文のまま D′ の下で構造上 HOLD で、別の案は /5 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行と同じ）。

- 理由: (1) この差分は、K6/2 の `graph-eval-procedure` の可用性の判定と手順の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認（台帳の Confirmation protocol）。

承認の例（固定の文でなくてよい。draftRef と contractId を名指すか、integrator が直前に SHA-256 つきで示したこの 1 行への承認の返答であればよい）:

- I confirm draftRef nir1-final-request-eval-proposal/4 for contractId graph-eval-procedure.
