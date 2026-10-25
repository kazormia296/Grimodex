# NIR-1 最終 request 評価の契約提案 proposal/4（draft）: Graph の follow-up の可用性（`graph-ready` による再 query の cache 由来の表示）

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## 平文の要約（判断の前に読む 3 行）

- 利用者に見えるもの: Related Scenes は、まず Graph の無い R+IR の一覧を出す。数十 ms 後に `graph-ready` が来ると、一覧はいったん「読込み中」に替わり、400 ms の debounce と再 query の後に Graph の根拠と 1 行を伴って戻る（コードの読取。再 query が失敗しても一覧は同じように消えて、Graph の無い R+IR のまま戻る）。Graph が Raw と同時に出ることは、D′ の下ではまず無い。
- 何を緩めるか: K6/2 は定常状態で「Raw と同時（Raw-ready + 10.84 ms 以内）に Graph が届くこと」を 1% の物差しで求める。この draft は、それを「Raw の後 T_late 以内に通知が来て、再 query で T_show 以内に表示されること」でも満たせるとする（**合格基準の緩和**。D、lease、1% の値は変えない）。実際の操作の trace（(b)）でも同じ読みを推奨する（(b) の緩和）。
- 効かない見込み: 再 query の Graph は cache から来ても、再 query 自身の D の窓（10.84 ms）の中で IR の到着、再確認、requalification を終えなければ表示されない。renderer はこれらの IPC を 1 本の lane に直列に並べ、requalification は小さい fixture でも median 6.6 ms かかる。**この定義でも HOLD になる見込みがある**。そこで、確認を求める前に実現可能性の診断（H5）を取ることを、この draft の前提とする。

要約: (1) 確認するもの — K6/2 の `graph-eval-procedure` に「follow-up の可用性」（Raw の表示の後、製品の再 query が、その query 自身の遅れた結果を cache から受けて Graph を表示すること）を定義し、定常状態と trace の可用性を「表示の可用性」（D の窓内か follow-up の成功）で判定する。(2) ユーザーが決める点は 7 つで、技術的な点 2 つは推奨のまま確認してよい（「判断を求める点」）。(3) 最も重い開示: first-render を合否から外すと、(b) を K6/2 のまま読んだ場合でも、K6/2 の 721 行が D′ の構造上の graph-late（開始時の slot が `empty`）を「鮮度」に入れるので (b) が成立しうる。すると 621 行の緩和（編集中の可用性を合否から外す）が、worker の鮮度でなく D′ の構造による遅れにまで及ぶ。推奨の判断 7 (ii) はこの連鎖を断つ（D′ の構造上の graph-late を窓外の理由にしない）。(4) (b) を K6/2 のまま残すと、閲覧中の trace の D の窓内はほぼ 0 件になり、K6/2 の 619 行の「trace のどれかで Graph が一度も窓内に届かなければ PASS にしない」に当たって、PASS は構造上不可能になる。(5) この緩和は D′ の状態機械を持つ候補に限る。D′ を外した候補では改めて確認を求める。(6) 読む順序の案: 平文の要約 →「判断を求める点」→「ユーザーが批准すること」→「設計」→「UX と製品の意味」→「変える点」→ほかは必要に応じて。

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 11 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。**承認の効力は 2 つに分かれる**（批准 6）: (i) の部分（「条件が成立しない間の CP-4 の可用性」の判定）は、この承認で**確認**される（`confirmedRef` を持つ）。ほかの部分は、K6/2 の `graph-eval-procedure` と同じく**事前の確認**で、効力の根拠にしない（台帳 206 行の "ratifies nothing" と同じ扱い）。どの項目が (i) に入るかは批准 6 に書く。数値と根拠は各節に 1 回だけ書く。

1. 加えるもの: 「設計」の「follow-up の可用性」（測る量 q1〜q3、T_late、T_show、数える条件 F1〜F7、数えない場合 X1〜X12）と「表示の可用性」とその欠落率（定常状態は全 case の pool、trace は trace ごと）。
2. 判定の置き換え: K6/2 で可用性の合否を述べる「(a)」は表示の可用性の欠落率と読み、first-render の窓外率は記録と開示だけにする（「変える点」の 1〜3）。HOLD の既定は表示の可用性に当てて残す。
3. 品質の測り方: G-01〜G-08 の品質を、窓内の sample と follow-up で表示された sample の表示の結果で測る（「設計」の「品質」）。
4. 測定の手順の読み替え（R1〜R8）。
5. これが合格基準の緩和にあたること: D=10.84 ms、lease 100 ms、1%、遅れた結果を混ぜない規則は変えないが、K6/2 が PASS に求める「Raw と同時に Graph が届くこと」を、「`graph-ready` の通知が T_late 以内に届き、その後の製品の再 query で T_show 以内に表示されること」で代替してよいとする。弱める範囲は F1〜F7 を満たす query に限る。定常状態（「変える点」の 2、3、5、7、8）と、判断 7 で (ii) を選べば実際の操作の trace（「変える点」の 15）の両方に当たる。判断 7 で (b) を K6/2 のまま残すと、要約の (3) の連鎖（D′ の構造上の graph-late が「鮮度」に入り、621 行の緩和がそれに及ぶ）が起きうることも、この緩和の帰結として開示する。**この緩和は D′ の状態機械（`begin_deferred` と保留つきの session。DR-CQD-1〜4）を持つ候補に限り**、それを持たない候補（D′ を外した、または状態機械を変えた候補）には当てず、改めて確認を求める。
6. 確認の効力の時点（判断 6）: (i) この承認で確認され、記録の時点から使うもの: 「条件が成立しない場合の CP-4 の可用性」（K6/2 の 612 行）の読み替え（「変える点」の 3）と、その判定に要る定義のすべて、すなわち批准 1（表示の可用性、F1〜F7、X1〜X12、T_late、T_show）、批准 3（その間の CP-4 の G-case の品質を測る sample。K6/2 の手順の 8 は条件の成立の後の手順だが、612 行の判定には品質を測る sample の定義が要るので、同じ規則を (i) で使う）、批准 4（R1〜R8）、判断 7 の選択（(b) の窓外率の読み）、「変える点」の 16（観測の後の変更の規則）。(ii) 事前の確認にとどまるもの: この行のほかの内容（条件の文、条件の (b) の判定の規則、手順の全体）。条件が成立し、事前登録の凍結の照合の 3 が済み、診断と receipt と照合の結果を添えた改めての確認が記録された後に限って効く。
7. 事前登録と版・draftRef の読み替え（「引き継ぐもの」の 3、「変える点」の 14）: K6/2 の「事前登録の凍結」の 1〜7 を、「この file」をこの draft の bytes と読んで当てる。条件の判定に使う診断と、(i) の読み替えで判定する CP-4 の run は、この draft の凍結の後に始めたものに限り、receipt の先頭にこの draft の凍結の commit と SHA-256 を書く。K6/2 の SHA-256 を先頭に持つ receipt と診断、この draft の「事実」に書いた観測は、予告として扱う。
8. 変えないもの: 「前書き」の「変えないもの」。(b) の規則は、「変える点」の 15（判断 7）の読み替えのほかは変えない（失効率の定義と物差し 1%、Q と U、trace の密度と長さ、`busy` の区分、記録の読取との重なり、主な理由と分岐）。D-final の READY 待ちと K6/3 の行も変えない。
9. 許さないもの: 製品のコードの変更（Related Scenes の debounce、合流の deadline、次 query 用の cache、D′ の状態機械、`graph-ready` の通知、IPC の lane）、D の拡大と再 query の合流の窓の拡大、G-case の fixture と setup の変更（seed の pin を含む。要るなら CP-0 と `g01-eval-revision` の側で扱う）、新しい authority・保存先・送信先・製品の入口、Graph の公開（PUB-G）と Session C-1 の承認、条件の成立の判定そのもの。依存する契約と K6/2・K6/3 のほかの行は確認しない。
10. threat model と受入れ: 「threat model」の加算、「受入れ」の K6/4-P1〜P3 と K6/4-N1〜N28、「変える点」の 1〜16、「引き継ぐもの」の節。
11. 確認を求める前提: H5 の実現可能性の診断（integrator が別 lane で取る。条件の判定に使わない）を、確認を求める前に取り、その結果を提示に添える。

注記（批准の対象ではない）: 2026-10-25 にユーザーが K6/2 の (a) について「K6/2 は A で」と指示した。A は「再 query の cache 由来の結果も、一定時間内なら可用性に数える定義を持つ新しい K6 の draft を起案する」で、起案の指示であり確認ではない。この起案は選択肢の逐語の問いを見ておらず、integrator の伝える要旨による。T_late と T_show の値、測る区間、数える条件、品質の扱い、確認の効力の 2 段、(b) の読み替え、確認の前の診断は、起案者が加えたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-final-request-eval-proposal/4` |
| contractId | `graph-eval-procedure`（K6/2 の条件付きの行と同じ。理由は「確認文」） |
| 起案日と基点 | 2026-10-25。基点は origin/master `bdc892d7`（#717）。行番号（K6/2・K6/3 の本文、`src/`、`electron/native`、台帳 `docs/plans/nir1-l6-l9-execution-plan.md`、続行計画 `docs/plans/nir1-continuation-2026-10.md`、post-B = `docs/plans/nir1-post-b-execution-plan.md`、`docs/plans/nir1-lane-decisions/`）は `bdc892d7` で確かめた。K6/2 が引く post-B:208／214／216 は、`bdc892d7` では 217／223／225 にある。統合 branch の記録は `claude/nir1-cp4` の `be8c14ca` の `docs/plans/nir1-lane-decisions/cp4-decisions.md`（以下 cp4）と `scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts`（以下 harness）で、master に無い。K6/2 の SHA-256 `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` と K6/3 の `2ae123d2319bb0246045bebc39d2391add15deccfa0aa58d87dbfce3b8ecbf2b` は、台帳の値と一致することを再計算して確かめた |
| baseline | `nir1-final-request-eval-proposal/2#graph-eval-procedure` は確認されていない（2026-10-17 の事前の確認だけで、`confirmedRef` は none。台帳 206 行、223 行）。効いているのは、確認の前から使う規則（凍結した bytes の条件の判定の規則と、612 行の trigger。U3 の委任で、閾値を変えないことを理由に確認を待たずに使う）だけ |
| 前提 | D′（CQ-DEFER、#715）は master にある（`related_scenes/graph.rs:21-24`）。CP-4 は統合 branch で D′ を取り込み、実機の確認 (ii) を行った（cp4:424-466）。CP-4 の正式の窓（S5）、条件の判定に使う診断、評価の手順のファイルはまだ無い（`evals/nir1-graph/` は G-case の fixture と freeze だけ。`bdc892d7` と `be8c14ca` で確かめた） |
| 用語 | first-render の可用性 = K6/2 の (a) の窓内（最初の query の合流が D の窓内に worker の結果を受けること）。follow-up の可用性 = この draft の定義。表示の可用性 = query ごとに、どちらかで Graph が表示されたこと。「親」= 利用者の操作による query、「子」= その世代について製品が `graph-ready` で出す 1 回の再 query。`t_raw_ready` = 親の Raw-ready（K6/2 の手順の 2。renderer の単調 clock）。`t_notice` = renderer がその project の `graph-ready` を受けた時刻。`t_follow` = 子の fetch の結果の `timing.tReturnMs`（`fetchNir1RelatedScenes.ts:150`。同じ clock。React の commit の時刻も取れれば記録する） |
| 変えないもの | D=10.84 ms（`relatedScenesConfig.ts:7`）、Graph の result lease 100 ms（admission から結果まで。post-B:171、177、223）、K1／proposal/7 の上限、P の B=54.2 ms、上限 65.04 ms（B+D）、T=2144.7 ms（post-B:223）、「既に完了した query へ遅い Graph の結果を混ぜず、次の query で使う」（post-B:217。合流は D の後の Graph を混ぜない。`nir1RelatedScenesGraphJoin.ts:253-257`）、IR の timeoutRate 1%、失効率の物差し 1%、分母を pool すること、HOLD の既定、事前登録の凍結の規則、試験専用の入口の規則、`graph-ready` の再 query を P・IR・(a)・(b) の分母に入れないこと（手順の 7）、DP-H・DD-1・K6/3 の規則、D-final の Graph の待ち（`nir1_graph_dfinal.rs:53` の 4 s）。T_late と T_show は新しい区間の基準で、値は既存の値を使う（判断 2、3） |

## 判断を求める点

前提: 確認を求める前に H5 の診断（製品の経路で、子の Graph が子自身の D の窓に届くか）を取り、結果を添える（批准 11）。届かない見込みが強ければ、この draft のまま確認を求めず、integrator に返す。推奨のまま承認すれば推奨が確認され、推奨と違う選択は新しい draftRef で起案する。

ユーザーの判断が要る点:

| # | 論点 | 推奨 | 代案 | 批准 |
| - | ---- | ---- | ---- | ---- |
| 1 | first-render を合否に残すか（**緩和か、定義の追加か**） | 外す。可用性は表示の可用性の欠落率で判定し、first-render の窓外率は記録と開示だけにする（**合格基準の緩和**。D′ の状態機械を持つ候補に限る）。ユーザーの A の目的（D′ の下で (a) が構造上 HOLD になること〔cp4:466〕を解く）を果たすのはこの案だけ | (i) 定義の追加だけ（follow-up を記録し、first-render を要件に残す。緩和でないが、D′ の下では HOLD のまま）。(ii) 両方を要件にする（より厳しい。同じく HOLD）。どちらも D′ を外すか合流の経路を短くする大工事を要する（cp4:410-418、DR-CQD-1） | 2、5 |
| 2 | T_late（Graph の側の遅れ） | `t_notice − t_raw_ready ≤ 100 ms`。新しい区間（Raw-ready から通知まで）の基準を、既存の値（lease の 100 ms）で置く。lease の区間（admission から結果まで）とは違う区間で、同じ値を借りるだけである。起点を Raw-ready にするのは、遅い begin は Raw 自体を遅らせる P の側の事象だからで、受渡しを起点にすると D′ の確認 (ii) の 2/30 がそのまま欠落になる（**この起点と値は (ii) の観測を見た後に選んだ**。「引き継ぐもの」の 3） | 2 s（`GRAPH_AWAIT_LIMIT`。`related_scenes/graph.rs:42`）。上限なし（T_show だけで縛る） | 1 |
| 3 | T_show（利用者が Graph を見るまで） | `t_follow − t_raw_ready ≤ 2 s`。新しい区間の基準を、既存の値（Related Scenes が Graph の ticket を待つ上限 `GRAPH_AWAIT_LIMIT` の 2 s）で置く。debounce の 400 ms、子の begin、子の合流を含む。D′ の確認 (ii) の遅い begin（1,704.6 ms）が子で起きると超えうる（その sample は欠落。遅い begin は P の p95 の側でも問題になる） | (b) コードから導いた和 400 ms（debounce）＋100 ms（T_late）＋65.04 ms（P の上限）= 565.04 ms: 65.04 ms は p95 の上限で、sample ごとの上限に使うと正しい挙動でも最大 5% が超え、1% の物差しと両立しない。debounce は UI の定数で、和の意味が契約にない（推奨の 2 s も、値の出所の区間が T_show の区間と違う点は同じで、同じ基準で評価すれば「既存の値を借りる」以上の根拠は無い）。(c) 上限を置かず記録だけにする（表示がいつまでも遅れても PASS になりうる） | 1、5 |
| 4 | 欠落率の物差し | 1%（IR の timeoutRate、K6/2 の (a) と失効率と同じ）。定常状態は全 case の pool、表示された sample が 1 件もない case は HOLD、pool が 0 件なら HOLD。**開示**: pool が 240 件で欠落 2 件までの点推定の判定は、真の欠落率が 1% でも PASS の確率は約 57%、2% でも約 14%（二項分布で計算）で、偶然の幅が大きい | 1% より緩い値（閾値の緩和）。case ごとに 1%（30 sample で 0 件を求める） | 1、2 |
| 5 | G-case の品質を follow-up の表示で測るか | 測る。窓内と同じ規則（同じ case の表示の結果はすべて同じ）に、子の R と IR が親と同じことを加える | 窓内の sample だけ（D′ の下では全 case が HOLD） | 3 |
| 6 | 確認の効力の時点 | 批准 6 の 2 段（(i) は承認から、ほかは条件の成立の後） | 全部を条件の成立の後にする（その間の CP-4 は K6/2 の (a) の trigger のまま、構造上 HOLD） | 6 |
| 7 | (b)（実際の操作の trace）で follow-up を数えるか | **(ii) 数える**（(b) の緩和。「変える点」の 15）。理由: (b) を K6/2 のまま残すと、閲覧中の trace の D の窓内はほぼ 0 件で、619 行の「一度も窓内に届かなければ PASS にしない」で PASS は構造上不可能になる。同時に、721 行が D′ の構造上の graph-late を「鮮度」に入れ、(b) の条件が成立して 621 行の緩和が D′ の構造による遅れに及ぶ連鎖が起きうる。(ii) は D′ の構造上の graph-late を窓外の理由から外し（follow-up が失敗したときの理由で区分する）、この連鎖を断つ。編集中の trace は、cq の F10（DR-CQD-8 の他の commit による stale）で follow-up も失敗する見込みで、(ii) でも HOLD か `[precheck]` の見込み | (i) K6/2 のまま（上の不可能と連鎖を残す。開示が要る）。(iii) 狭める（D′ の graph-late を「その他」に入れる。(b) の主な理由が「その他」になり、この行は使えず、原因を直すか新しい draftRef。K6/2 の 734 行。閲覧中の PASS の不可能は残る） | 5、8 |

推奨のまま確認してよい技術的な点:

| # | 論点 | 推奨 | 代案 |
| - | ---- | ---- | ---- |
| T1 | 数える根拠 | 製品の renderer の経路（`useNir1RelatedScenes` を mount した消費者）の記録と owner の counter で数え、F4 は観測で確かめる | Native の記録（再 begin が `cached`、continue が available）だけで数える: D′ の確認 (ii) の形（cp4:431、447）で、製品の合流の窓と debounce を通らず、製品が表示しない結果を可用と数えうる。採らない |
| T2 | R1 の待ちの上限 | 手順のファイルで観測の前に固定し、10 s（保留の期限 `DEFERRED_RELEASE_LIMIT`。`nir1_graph_product.rs:78`）を超えない | — |

## 引き継ぐもの

1. K6/2 の `graph-eval-procedure` の行の全文を baseline とし、この draft の「変える点」の表を当てたものを /4 の行の内容とする。表にない K6/2 の記述は変えない。
2. K6/2 の 147 行の規則（後続の draftRef が確認されると先行の行を全体として supersede する）は確認された行に当たる。/2 の事前の確認は履歴として残り（台帳 206 行は消さない）、条件の成立の後に改めて確認を求めるのは /4 の行になる。
3. 事前登録: K6/2 の「事前登録の凍結」（152-160 行）に従った /2 の凍結の記録（`claude/nir1-contracts`。この起案では記録そのものを確かめていない）は消さずに残す。/4 の凍結は別の新しい commit で行う。K6/2 の 157 行（事前登録の凍結の 4。凍結の前に観測を見た後で変えた点を本文に書く）に従い、/2 の凍結の後にこの起案者が見た観測と、それを見た後に選んだ規則を書く。見た観測: cp4 の DR-CP4-S1C2-15、16、19〜26、D′ の確認 (ii) の結果（cp4:437-466）、cq-deferred-decisions.md の §6〜8。それを見た後に選んだ規則: T_late の起点を Raw-ready にしたこと（受渡しを起点にすると 2/30 が欠落になるという観測）と値 100 ms、T_show の 2 s（遅い begin と debounce の記録）、R1 の前提（DR-CP4-S1C2-23）、F2 の数え方（counter の名前と、(ii) で `late_cached` と `cache_hits` が 1 回ずつ動く観測）、判断 7 の推奨（閲覧中の窓内が構造上 0 になる読み）。どれも条件の判定に使える診断ではなく（凍結の commit と SHA-256 を先頭に持たない）、予告として扱う。条件の判定には、/4 の凍結の後に取り直したものだけを使う。
4. K6/2 の事前の確認（台帳 137 行と 206 行）、K6/2 の 2026-10-17 の注と K6/3 の 2026-10-25 の注（台帳 219-220 行）、K6/3 の確認の記録（台帳 175-185 行）は消さない。K6/3 の版の番号の読み替えは `nir1-final-request-packing-eval` の行の話で、この draft は触れない。

## 変える点（K6/2 との関係）

次の表の文だけを置き換える（または足す）。表にない K6/2 の記述は変えない。**2、3、5、7、8、15 は /2 の文面より弱い読み**（批准 5）。1 は 2 と 3 に伴う語の読み替え、6、11、16 は狭める防御、4 は手順の読み替え、9、10 は threat model、12 は失効、13、14 は効力と事前登録の扱いである。以下「/4 の変える点 n」と呼ぶ。

| n | 箇所（K6/2 の行） | /2 の文（要旨） | /4 の文 | 理由 |
| - | ---------------- | --------------- | ------- | ---- |
| 1 | 「(a)」を述べるすべての箇所（607、609、612、619、620、729 行を含む） | (a) の窓外率、(a) が基準を満たす／超える／物差しの内側 | 「(a) の窓外率」と「cache 由来の結果は (a) では窓外」は first-render の窓外率と読む（記録と開示）。「(a) が基準を満たす・満たさない・超える・物差しの内側」は表示の可用性の欠落率と読む | 判定の置き換え（批准 2） |
| 2 | 条件の (a)（609 行）と条件の前置き（606 行） | 定常状態の窓外率（worker 由来の窓内だけ）が 1% 以下。満たさなければ HOLD が既定 | 定常状態の表示の可用性の欠落率が 1% 以下（pool）。満たさなければ HOLD が既定。first-render の窓外率は /2 のまま求めて書く。D′ の状態機械を持たない候補には当てない | D′ では (a) が構造上 HOLD |
| 3 | 条件が成立しない場合の CP-4 の可用性（612 行） | (a)、(b) の窓外率、(b) の失効率のどれかが 1% を超えたら HOLD | (a) は表示の可用性の欠落率、(b) の窓外率は 15 の読み。(b) の失効率は /2 のまま。この読み替えは承認から効く（批准 6 の (i)） | trigger の緩和は委任の外 |
| 4 | 手順の 3（695 行）の sample の前 | slot が新しい READY になったことを確かめてから query | R1 | D′ の query は READY を残さない（DR-CQD-4、DR-CP4-S1C2-23） |
| 5 | 手順の 3 と 5（695、705 行）、Mandatory defenses（619 行）の cache 由来の扱い | cache から返った結果は (a) では窓外 | first-render の窓外率では /2 のまま窓外。表示の可用性では、F1〜F7 を満たす子の表示だけを親の follow-up の成功に数える | ユーザーの A |
| 6 | 同上 | （なし） | X1〜X12 を当てる | 別の query の結果の混入を防ぐ |
| 7 | 手順の 8（708 行）、Acceptance implications（620 行） | 品質は窓内の sample で測る。窓内の sample が無い case は HOLD | 品質は表示された sample の表示の結果で測る。表示された sample が無い case と、pool が 0 件のときは HOLD | D′ では窓内の sample が無い |
| 8 | 手順の 7（707 行）、条件の (b) の規則の 1（715 行）、In-scope attacks の「event による再 query で率を上げること」（617 行）、Negative の「再 query を数える」（620 行） | `graph-ready` の再 query は分母に入れず別に数える。再 query で率を上げることは攻撃、再 query を数えたら PASS にしない | 分母に入れないことは変えない。F1〜F7 を満たす子を親の follow-up として数えることは、617 行と 620 行の再 query の数え方に当たらない。それ以外の再 query（F を満たさないもの、harness が出したもの）は /2 のまま | 子は親の記録としてだけ数える |
| 9 | Untrusted actors（616 行） | `graph-ready` の再 query、cache から返った結果は (a) の判定に使わない | first-render については /2 のまま。F1〜F7 を満たす子だけを follow-up の判定に使う。それ以外の再 query は Untrusted のまま | 加算 |
| 10 | In-scope attacks（617 行） | （下の各項は無い） | threat model の In-scope attacks の 1〜12 を加える | 定義の悪用を拒否する |
| 11 | Mandatory defenses（619 行）の記録、(b) の記録（737 行） | sample ごと、trace ごとの記録の項目 | R7 の項目を加える。(b) の記録には query ごとの follow-up の判定と、follow-up の失敗の理由（15 の区分）を加える | 受入れ |
| 12 | 失効（624 行） | 候補、手順・trace・基準のファイル、合流 helper、cache の規則などの変更で失効 | 加えて、`FETCH_DEBOUNCE_MS`、`graph-ready` の通知と再 query の規則（`useNir1RelatedScenes.ts`）、D′ の状態機械と保留の期限、cache の key と TTL、IPC の lane の規則（`tauri.ts`、`ipcQueue.ts`）の変更で失効する。D′ の状態機械を外すか変えた候補には、2、3、5、7、8、15 を当てない | follow-up の時間と成否を決める |
| 13 | 確認の扱い（140 行）と台帳 206 行の読み | 行の内容は条件の成立と改めての確認の後にだけ効く。612 行は確認の前から使う | 批准 6 の 2 段 | 緩和を委任で使わない |
| 14 | 事前登録の凍結（152-160 行）の「この file」 | K6/2 の bytes | この draft の bytes（/2 の凍結の記録も残す）。receipt の先頭は /4 の凍結の commit と SHA-256 | 「引き継ぐもの」の 3 |
| 15 | (b) の窓外率と区分（610 行、619 行の「trace のどれかで Graph が一度も窓内に届かなければ PASS にしない」、629 行の案 A の (b)、716-721 行、737 行。判断 7 で (ii) を選んだ場合） | 窓内は D の窓に合流した query だけ。D′ の構造上の graph-late（開始時の slot が新しい READY でない）は「鮮度」 | U のうち、D の窓内か follow-up の成功（F1〜F7。(b) では R1 と R2 を当てず、F2 の推論は親の begin が cache を空にすることに依る）の query を「表示された」とし、窓外率は表示されなかった query の率、619 行の「一度も窓内に」は「一度も表示されなければ」と読む。follow-up の失敗の区分は、失敗した段の理由で決める: 親の ticket の `stale`／`warming`／鮮度の stamp の読取の失敗の `busy` は「鮮度」（721 行）、`registration-unavailable`、Chronicle の停止、`invalidated`、A3 の理由は「失効」（719 行）、子の合流の理由は 719-721 行の同じ規則、T_late か T_show の超過で親の ticket が available だったもの、X2〜X4、X6〜X12 は「その他」。D′ の構造上の graph-late そのものは窓外の理由にしない。失効率（717 行の 3 の (i)〜(iv)）は変えない | 閲覧中の PASS の構造上の不可能と、要約の (3) の連鎖を断つ |
| 16 | 観測の後の変更（617 行の「観測の後に定常状態や trace の定義を変えること」、620 行の Negative の「観測の後に定義を変える」、702 行の「作り直した版は観測の前に再び固定」） | 観測の後に定義を変えることは攻撃で、PASS にしない | T_late、T_show、F1〜F7、X1〜X12、R1 の待ちの上限には、観測の後に狭める方向（T_late と T_show を短くする、F の条件や X の項目を足す）の変更だけを許す。手順のファイルの新しい版、独立 reviewer のレビュー、変える前の receipt を残すことを要し、変える前の receipt は判定に使わない。同じ版の書き直しはしない。広げる変更は新しい draftRef でだけ行う | K6/3 の台帳 220 行の (5) と同じ形の狭める防御 |

## 事実

コードは `bdc892d7` で確かめた。測定は記録にあるものだけを書き、記録に無いものは「未測定」と書く。

- D′ の Graph は常に graph-late: Related Scenes の begin は Graph の需要を保留として owner に渡し、begin 自身の監査の commit が終わった後に release する（`related_scenes/graph.rs:21-24`、DR-CQD-1）。保留つきの session は READY を公開せず、query の後に worker を退役させて slot を `empty` に戻す（DR-CQD-4）。理由は、begin の監査の commit（`ai_audit_events` に約 5 行）が worker の registration と query の `ReadIdentity` の drift として拒否されること（DR-CP4-S1C2-19、20。cp4:403-404）。
- 合流と宣言: Graph は IR と同じ deadline（`t_raw_ready` + D）で合流し、deadline は延ばさない。deadline の後の Graph は混ぜず、`graph-late` と `unused` の宣言になる（`nir1RelatedScenesGraphJoin.ts:72-77`、92-96、162-165、253-257）。宣言（settle）の後の待受けは `cancelled` を答える（`related_scenes/graph.rs:277-278`、659-660）ので、製品の経路では親の Graph の continue の答えは、ticket が宣言より後に決まれば `cancelled` になる（コードの読取）。`unused` の ticket の結果が available なら、owner はそれを次 query 用の cache に入れ、project ごとに `graph-ready` を出す（`nir1_graph_product.rs:888-913`、917-946、613-629）。
- cache: 1 件だけで、key は binding、caller の epoch、project、query の Scene、seed。edge の epoch が同じで TTL（既定 30 s。:98）の内だけ使える（:705-711、2688-2696）。begin が cache を見ると、key が合って使えれば取り（cache は空になる）、**key を問わず使えない entry があれば消す**（:596-611）。Related Scenes の begin（`begin_deferred`）と D-final の begin（`nir1_graph_dfinal.rs:324`）は同じ `admit_and_route` を通り（`nir1_graph_product.rs:1035-1100`）、同じ key なら cache を取り、違う key なら消す。owner の counter は `begins`、`cache_hits`、`late_cached` などの数だけで、key や ticket の識別子を持たない（:383-398、1055）。
- 再 query: renderer は `graph-late`、`warming`、`stale`、`busy` の世代について `graph-ready` を 1 回だけ使い（`useNir1RelatedScenes.ts:26-34`、109-121、252-257。DR-CP3A-49）、通知の世代が現在の世代でなければ捨てる（:118）。refresh で effect をやり直し、最初に表示中の結果を消し（`setFetch(null)`、:152-157）、400 ms（`FETCH_DEBOUNCE_MS`、:17、:286）の後に seed を読み直して新しい begin を出す（:198-204）。表示の結果が無い間、section は読込み中の文言を出す（`RelatedScenesSection.tsx:115-122`）。IR の timeout の後には、別に 400 ms の再試行の timer がある（:265-273）。
- 子の Graph の経路: 子は cache から `Cached` で受け、IR の到着、`current_operation`、gate、返却の直前の requalification を経て、子自身の D の窓で合流する（`related_scenes/graph.rs:292-294`、601-650）。renderer は `related_scenes_begin`、`related_scenes_continue`、待受けの形の `related_scenes_graph_continue` を derived の lane に入れ（`src/lib/tauri.ts:260-271`、384）、その lane の同時実行は 1（`src/lib/ipcQueue.ts:23`）なので、子の begin、IR の continue、Graph の continue は 1 本に直列に並ぶ（settle だけは mutation の lane。DR-CP3A-45）。requalification は小さい fixture の release build で median 6.6 ms（DR-CP3A-29）で、D は 10.84 ms。DR-CP3A-53 は、`Cached` の子も再び late になりうること、そのとき cache に戻さず `graph-ready` は出ないことを記録している。**子の Graph が子の D の窓に届くことは構造上かなり厳しい見込み**（推定。未測定）。
- D′ の実機の確認 (ii)（2026-10-25、実 Electron、評価 feature つきの build、dev fixture、N=30、`dprime-check.mjs`、receipt なし。cp4:431、437-458）: 受渡しから Graph の決着まで p50 30.0 ms、max 1,721 ms。最初の begin の ticket と continue は available 30/30。`unused` の settle の後の `graph-ready` は 30/30（settle から p50 0.5 ms）、再 begin は 30/30 で Native の `cached`、その continue は 30/30 で available。`prepareFailures=0`、`driftAtQuery=0`、`deferredReleased=30`、`deferredExpired`／`deferredDropped`／`staleReadyRetired` は 0。`rawReadyElapsedMs`（Native）は seed つき p50 14.70／p90 15.55 ms、seed なし p50 14.32／p90 14.97 ms。遅い begin が 2 件（1,704.6 ms と 1,157.0 ms。原因は未特定）あり、Graph は受渡しから 1,721 ms と 1,173 ms で届いた（記録の値の差で、Raw-ready の 16.4 ms と 16.0 ms 後。p50 同士の差からは、通常の sample でも決着は Raw-ready の十数 ms 後と読めるが、sample ごとの差は記録に無い。推定）。対照（D′ なし）は `prepareFailures` 4、`driftAtQuery` 5、`graph-ready` 2、`cached` 0。`stamp0Missing` は 30/30。seed は測定用の写しにだけ query の Scene の pin として足した（DR-CP4-S1C2-26）。
- (ii) は製品の hook を通っていない: 低い層の renderer API で begin → continue（Native の await の上限 2 s）→ settle → `graph-ready` → 再 begin → continue と進めた（DR-CP4-S1C2-24。cp4:431）。CP-4 の harness も hook を mount せず、`fetchRelatedPastScenes` を直接呼び、seed を harness が渡す（harness:250-259、642-648）。`t_notice`、`t_follow`、子の合流の outcome の記録は無い。
- 起動直後の最初の seed つきの begin は Chronicle の snapshot が usable でなく、Graph は `not-requested`（cp4:456）。2 つの表示と 2 s ごとの保存（60 s）では、registration の拒否が 5 回続いて owner が `suspended` に残り、編集を止めた 3 s 後も Graph は戻らなかった（cp4:458。(b) の側の事実）。D-final の READY 待ちの延びは未測定（cp4:462）。
- K6/2 の手順との食い違い（cp4:466）: 手順の「各 sample の前に slot が新しい READY」は D′ で成り立たず、`steadyStateInWindow` は全 sample が窓外（`not-ready-at-start`）、D′ の Graph は再 query（cache 由来）でだけ renderer に届く。

## 設計

### follow-up の可用性

定常状態の対象は K6/2 の (a) と同じ分母の sample（seed がある、Graph が有効、D2a の mode が一致、snapshot が usable、事前の期待値が Graph unavailable でない variant の R+IR+Graph の arm。G-01〜G-08 の各 30 回、warm-up を除く。K6/2 の手順の 1、2）。trace の対象は判断 7 の (ii) で U の query。

測る量: (q1) `t_notice − t_raw_ready`（Graph の側の遅れ）。(q2) `t_follow − t_raw_ready`（利用者が Graph を見るまで）。(q3) Native の時計の受渡しから決着まで、決着から通知まで（開示だけ）。T_late は (q1) の上限、T_show は (q2) の上限で、値は判断 2 と 3。

数える条件（すべてを満たす query だけを follow-up の成功とする）:

- F1: 親の IR が ready で、親の合流の outcome が `graph-late`、宣言が `unused`。親の表示に Graph が混ざっていない。
- F2: 親の begin から子の begin の直前までの間に、owner の `begins` の差分がちょうど 1（親）、`late_cached` の差分がちょうど 1。子の begin で `begins` と `cache_hits` がちょうど 1 ずつ増える（定常状態では、R2 で空にした後の sample の全体で `begins` 2、`late_cached` 1、`cache_hits` 1）。**entry が親の ticket のものであることは counter から観測できない**（ID を持たない）。親の begin が cache を見た時点で cache は空になる（取られるか消される。:596-611）ので、その後に入った entry は、その間に唯一 begin した親の ticket のものと推論する。親の Graph の continue の答えは、製品の経路では宣言の後に `cancelled` になりうる（「事実」）ので、条件に使わない（記録はする）。
- F3: renderer がその project の `graph-ready` を、親の `t_raw_ready` の後に受け、最初の通知が `t_notice − t_raw_ready ≤ T_late`。2 回目以降の通知は記録し、それだけでは失敗にしない（D′ の保留つきの session の終わりの通知など、正当な通知がありうる）。
- F4（観測で確かめる）: その親の世代と子の間に `index-ready` が無い、親の IR が ready（IR の timeout の再試行の timer が動いていない）、子の begin が `t_notice` の後で、子の世代は親の次の世代、F2 の `begins` の差分が成り立つ、子の query の Scene と seed（`selectNir1GraphSeed` の読み直し）が親と同じ。
- F5: 子の begin が `Cached`（F2 の `cache_hits` の増分）。
- F6: 子の合流の outcome が `graph-ready` で、Graph を持つ。「Graph を持つ」は、返却の直前の requalification を通った Graph の結果の edge が 1 件以上あり、事前登録した期待寄与の材料（K6/2 の手順の 4。定常状態では setup で確かめた材料）から寄与があることをいう。edge が 0 件か期待寄与が無ければ X5。子の IR が ready で、子の `t_raw_ready` + D までに届いたことを含む（D は延ばさない）。
- F7: 子の結果が `completed` で publish され、その世代が現在の世代のまま表示され、`t_follow − t_raw_ready ≤ T_show`。

数えない場合（follow-up の失敗。分母から除かない）:

- X1: 親の ticket の結果が `stale`、`busy`、`warming`、`registration-unavailable`、`timeout`、`invalidated` などで、cache に入らなかった。
- X2: cache に入ったが、子の前に TTL が切れた、edge の epoch が進んだ、quarantine で消えた、別の begin（key を問わない。D-final を含む）が子より先に cache を見た。
- X3: `graph-ready` が来ない、または最初の通知が T_late を超えた。
- X4: 子が `Cached` でない、F2 の counter の差分が合わない（`late_cached` の差分が 2 以上、`begins` の差分が多い）。
- X5: 子の合流が `graph-late`、`graph-unavailable:<reason>`（requalification の `invalidated`、`SeedChanged` を含む）、IR の timeout か unavailable、寄与の空の Graph（F6）。
- X6: 子が `invalidated` か `cancelled` で publish されなかった、世代が変わった（場面の移動を含む）。
- X7: F4 を満たさない（`index-ready`、編集、IR の再試行、harness による query が子になった）。harness が同じ query を繰り返して cache を当てた結果は、どの率にも成功として数えない。
- X8: (q2) が T_show を超えた。
- X9: 子の R または IR の membership と順位が親と違う（定常状態の前提が崩れた。品質の判定では FAIL）。比べるのは F1 で親の IR が ready の場合だけで、親の IR が ready でなければ X11 にする。
- X10: R7 の記録のどれかが欠けた、または定常状態で `reachedQuiet: false` だった。
- X11: 親の IR が timeout か unavailable（Graph は ready の IR とだけ使う。`nir1RelatedScenesGraphJoin.ts:174-180`）。
- X12: 親の合流が `graph-unavailable:<reason>` か `cancelled`（`graph-late` でない）で、`graph-ready` を待たない世代だった。

遅れた Graph が親の表示に混ざったときは、follow-up の成否とは別に、「遅れた結果を混ぜない」の違反として FAIL にする（K6/4-N1）。

### 表示の可用性と物差し

query は、first-render の窓内（K6/2 の手順の 5 のまま、worker 由来の結果だけ）か follow-up の成功のどちらかなら「表示された」とする（両方は起きない。窓内なら親は `used` で cache に入らない）。定常状態の欠落率 = 表示されなかった sample の数 / 分母（全 case の pool）。物差しは 1%（判断 4）。pool の件数は事前の期待値で決まり、最大 240（8 case × 30）で、そのとき欠落は 2 件まで。case ごとの値（first-render の窓内、follow-up の成功、X1〜X12 の内訳、q1〜q3 の分布）を receipt に書いて開示し、表示された sample が 1 件もない case と、pool が 0 件のときは HOLD とする。first-render の窓外率は K6/2 の規則のまま receipt に書く。IR の timeoutRate は親の IR の outcome だけで求め（手順の 6）、子の IR の timeout は X5 に数えるが timeoutRate に入れない。

### 品質

G-01〜G-08 の品質（G-01 の事前指定改善、macro 非回帰、Evidence 100%、禁止寄与 0）は、表示された sample の表示の結果（窓内なら親の合流の結果、follow-up なら子の合流の結果）で測り、receipt に「定常状態」と、どちらの表示かを書く。同じ case の表示の結果は、窓内と follow-up を問わず、すべて同じでなければならず、違えば FAIL とする。follow-up の sample では X9 を求める。表示されなかった sample は、R+IR に混ざりなく戻ったこと（親の表示）を確かめる。この規則は、条件が成立しない間の CP-4 でも使う（批准 6 の (i)）。

## UX と製品の意味（コードの読取による。renderer での実測は無い）

- 見え方: 親は R+IR を Raw-ready + D（または IR の到着）で表示し、Graph は無い。`graph-ready` のたびに、section は表示中の結果を消して読込み中にし（`useNir1RelatedScenes.ts:152-157`、`RelatedScenesSection.tsx:115-122`）、400 ms の debounce と子の begin の後に結果を表示する。子が成功すれば R+IR+Graph（R+IR の membership と順位は融合の規則で保たれ〔post-B:215〕、Graph が足すのは既存の Scene への path Evidence と共通追加 1 枠だけ）、子が失敗しても（X5、X8 など）一覧は同じように消えて、Graph の無い R+IR のまま戻る。利用者には「同じ一覧が約 0.5 秒消えて戻る」形になる見込み（推定。400 ms はコードからの下限）で、「Raw の後に Graph の行が足される」形ではない。一覧を保ったまま取り直す UI の改善（H3）は、別の lane で進める。PUB-G の開示（Session C-1）では、この見え方を必須の項目として示す。
- 場面の移動: 親の世代の通知は、場面を移ると捨てられ（:118）、移った先の begin が key の違う cache を消す（`nir1_graph_product.rs:605-607`）。cache の TTL の内に表示されうるのは、その場面に留まる場合だけである。
- 間に起きる編集: 親の表示から子までに保存があると、(i) Index が dirty になり子の IR が止まって Graph も止まる（X5）、(ii) requalification が落ちる（X5）、(iii) tree の変化で effect が新しい世代を始め、親の世代の通知は捨てられる（X6）。どれも (b) の範囲で、判断 7 の (ii) では follow-up の失敗として、失敗した段の理由で区分する。定常状態の (a) の run は編集をしない（K6/2 の手順の 3。S6）。
- P の timing: P（B、B+D の上限 65.04 ms）は親の query で測り、子は P の分母に入れない（手順の 7 のまま）。D′ は Raw を遅らせない（`rawReadyElapsedMs` の p50 は seed の有無で 0.4〜0.6 ms の差。cp4:454）。子は seed つきの世代ごとに begin と監査の書込みを 1 回ずつ足す（監査の行は sample あたり begin 2 回分で 10 行。cp4:449）。この負荷が P の測定に混ざらないよう、sample は直列にする（R4）。
- 最終 request の Packing（`nir1-final-request-packing-eval`、K6/3）: D-final は子を使わず、自分の begin と READY 待ち（4 s の予算）で Graph を受ける（`nir1_graph_dfinal.rs:53`、324）。この draft は D-final にも K6/3 の行にも当たらない。D-final の begin は同じ admission で cache を見るので、子より先に来ると follow-up は X2 になる（コードの読取。定常状態の手順には D-final が無い）。保留中の D-final の待ちの延びは未測定（cp4:462）。

## 測定の手順の読み替え（graph-eval-procedure の手順への加算）

- R1 定常状態の sample の前の前提（K6/2 の手順の 3 の「新しい READY」に替える。DR-CP4-S1C2-23）: (1) slot が `empty`（保留、保留つきの session の `preparing`／`in-use`、`suspended`、`retiring` が無い）、(2) 次 query 用の cache が空（試験専用の入口で空にする）、(3) 前の seed つきの sample の終わりから `rebuild_min_interval`（1 s。`nir1_graph_product.rs:94`）以上。待ちの上限は T2。届かなければ `reachedQuiet: false` を記録して sample を取り、分母から除かず、follow-up の成功にしない（X10）。待つ時間は latency に含めない。first-render の記録の「開始時の slot の状態」は `empty` などの実際の状態を書く。
- R2 cache: 定常状態の各 sample の前に空にし、sample の終わりに空であること（子が消費した）を確かめる。残っていたら記録して空にする。trace の run では K6/2 の 704 行のとおり空にしない。
- R3 通知と子の数え方: 親ごとに、`graph-ready` の回数と各 `t_notice`、子の世代と契機（F4 の観測）、owner の counter（`begins`、`cache_hits`、`late_cached`）の親の begin の前と子の begin の後の値を記録する。子は P、IR の timeoutRate、(a) と (b) の分母に入れない。
- R4 sample の独立性と終わり: 定常状態の sample は直列に、R+IR の arm と AB／BA で交互に行う（K6/2 の手順の 2）。sample は、子の publish、`t_raw_ready` + T_show の経過、session の停止のうち最も早いもので終わる。その後、session の release を待ち、待ちの上限は T2 と同じく手順のファイルで固定する（10 s を超えない）。harness は sample の間に編集、場面の切替え、別の query、D-final を起こさない。
- R5 製品の経路: 親と子は `useNir1RelatedScenes` を mount した消費者（`RelatedScenesSection` か、同じ hook を通る harness の消費者）で出す。CP-4 の今の harness は hook を mount していない（「事実」）ので、新しい harness の消費者が要る（製品のコードの変更は要らない見込み）。低い層の API で continue を直接待つ形は、follow-up の判定に使わない（Native の値の開示にだけ使う）。seed は製品の規則（query の Scene の最初の pin）で決まる。G-case の setup が seed を pin として置いていなければ、この draft はその変更を許さない（批准 9。CP-0 の凍結と `g01-eval-revision` に波及するので、要るなら CP-0 の側で扱う）。
- R6 時計: `t_raw_ready`、`t_notice`、`t_follow`、子の `t_raw_ready` は renderer の同じ単調 clock で取る。Native の時刻は開示だけに使う。
- R7 query ごとの記録（Mandatory defenses への加算）: 親の合流の outcome と宣言、親の IR の outcome、親の Graph の continue の答え、R1 の (1)〜(3) と `reachedQuiet`（定常状態）、R3 の counter と通知の記録、子の世代と F4 の観測（`index-ready` の有無、IR の再試行の timer の有無、子の begin の時刻）、子の begin の種別、子の合流の outcome と理由と requalification の結果と edge の件数と期待寄与、`t_follow`、親と子の R と IR の membership と順位、D′ の counter（`deferredReleased`、`deferredExpired`、`deferredDropped`、`staleReadyRetired`、`prepareFailures`、`driftAtQuery`、`stamp0Missing`）、判定（窓内、follow-up の成功、X1〜X12 のどれか、(b) では 15 の区分）。
- R8 2 つの表示と連続編集: 定常状態の run では行わない。(b) の trace と、cq-deferred-decisions.md §6.8 の 9 の診断の範囲で記録する。(b) の記録への加算は「変える点」の 11 と 15 による。

## threat model（K6/2 の `graph-eval-procedure` への加算）

合格基準の緩和なので、確認されるまで draft とする。新しい外への通信、保存、authority、subprocess、背景の処理、async の lifecycle は加えない（記録は評価 feature の下の既存の counter と renderer の時刻の読取だけ）。

- Trusted actors（加える）: 製品の `useNir1RelatedScenes` の再 query の規則と合流 helper（子の D の窓）、owner の `begins`、`cache_hits`、`late_cached` の counter、renderer の単調 clock の `t_notice` と `t_follow`。再 query のうち使ってよいのは F4 を満たす子だけで、ほかの再 query は K6/2 の 616 行のとおり Untrusted。
- Untrusted actors（加える）: harness が出す query、`index-ready`・編集・IR の再試行による query、低い層の API の continue の結果、前の sample が残した cache の entry、D-final が見た cache。
- In-scope attacks（加える）: 1. harness が同じ query を出して cache を当て、follow-up に数える。2. 前の sample の遅れた結果、または R2 の後に前の ticket が同じ key で埋めた entry を follow-up に数える。3. 子の合流が `graph-late` か unavailable なのに、Native の `cached` と available で数える。4. T_late、T_show、F1〜F7、X1〜X12、起点と終点を観測の後に広げる。5. 通知が来なかった、遅れた、`reachedQuiet: false` の sample を分母から除く。6. 子の R や IR が親と違うのに品質を測る。7. 遅れた Graph を親の表示に混ぜて「窓内」と数える。8. follow-up の成功を first-render の窓内として報告する、または first-render の窓外率を開示しない。9. seed を pin でなく harness から渡して製品と違う経路で測る。10. 欠落率を case ごとか pool かで結果を見て選ぶ。11. 寄与の空の Graph を表示の成功と数える。12. D′ の構造上の graph-late を「鮮度」に入れて (b) の条件を成立させる（判断 7 で (ii) を選んだ場合）。
- Out-of-scope attacks（残余として開示）: 1. 製品の通常の使用での follow-up（場面の素早い切替え、D-final との cache の取り合い）は定常状態の手順では測らない。2. 子までの間の一覧の消失（UX）は合否に入らない。3. 同じ project の 2 つの表示が別の Scene を見ていると、通知が project 単位なので、編集が無くても数周往復しうる（推定。未測定）。4. 欠落 2 件までの判定の偶然の幅（判断 4 の開示）。
- Mandatory defenses（加える）: 「設計」と「測定の手順の読み替え」の全部と「変える点」の 16。T_late、T_show、F1〜F7、X1〜X12、R1 と R4 の待ちの上限は、観測の前に、この draft の凍結と手順のファイルの版で固定し、独立 reviewer のレビューを受ける。CP-4 の分類器は、受入れの Negative の合成の記録で検出力を示してから使う。
- Acceptance implications: 「受入れ」の節。品質の条件、IR の timeoutRate、P の Hybrid p95、D、失効率の物差しは変えない。変わるのは、可用性を表示の可用性で判定すること、品質を follow-up の表示でも測ること、sample の前の前提、判断 7 の (b) の読みだけ。

## 選択肢と推奨

| 論点 | 推奨 | 対案と採らない理由 |
| ---- | ---- | ------------------ |
| D′ の下の (a) の HOLD（ユーザーが A を選んだ論点） | (A) 定義を改める（この draft） | C 案（監査を別 DB に分ける。cp4:414）と合流の経路の短縮: 大工事で、監査を移しても合流の経路だけで窓を超える見込み（推定。DR-CP3A-53）。D の拡大か 1% の緩和: 閾値の緩和で、D は P の固定契約の一部 |
| 2 つの終点 | `t_notice`（T_late）と `t_follow`（T_show）の両方を合否に使う | 片方だけ: 通知だけでは表示が遅れても通り、表示だけでは Graph の側の遅れと UI の定数を区別できない |
| 確認の 2 段 | (i) は承認から、ほかは条件の成立の後 | 全部を後にする: CP-4 が構造上 HOLD のまま |

## 受入れ（可用性）

番号は K6/2 と衝突しないよう `K6/4-` を付ける。CP-4 の分類器は、合成の記録（実 run の記録を複製し、通知、counter、子の outcome、時刻を書き換えたもの）で Negative のそれぞれを期待どおりに分けることを、観測の前に示して記録する。

Positive:

- K6/4-P1: F1〜F7 をすべて満たす。follow-up の成功に数え、品質を子の表示で測る。
- K6/4-P2: 親の合流が D の窓内に worker の結果を受けた。first-render の窓内に数え、子は出ない。
- K6/4-P3: 定常状態の pool の欠落率が 1% 以下で、どの case にも表示された sample があり、品質が条件を満たす。first-render の窓外率と follow-up の内訳と q1〜q3 の分布を開示する。

Negative（どれも成功に数えない。分母から除かない）:

- K6/4-N1: 親の表示に D の後の Graph が混ざった（FAIL）。
- K6/4-N2: harness が出した query の cache の hit（X7）。
- K6/4-N3: R2 で空にした後に、前の sample の ticket が同じ key で cache を埋め、子がそれを受けた合成の記録（F2 の `begins` の差分で X4）。
- K6/4-N4: 子の合流が `graph-late`（X5）。
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
- K6/4-N17: 観測の後に T_late、T_show、条件、起点か終点を広げた receipt、または手順のファイルの新しい版とレビューのない変更（「変える点」の 16）。
- K6/4-N18: first-render の窓外率を書いていない receipt。
- K6/4-N19: 親の ticket が `stale` で cache に入らなかった（X1）。
- K6/4-N20: 子が publish されず世代が変わった（X6）。
- K6/4-N21: 欠落率を case ごとか pool かで結果を見て選んだ receipt（In-scope attack の 10）。
- K6/4-N22: 親の合流が `graph-unavailable:warming`、`stale`、`busy` で refresh した子（X12。`graph-late` でない世代の子は follow-up に数えない）。
- K6/4-N23: `late_cached` の差分が 2 以上（X4）。
- K6/4-N24: `reachedQuiet: false` の sample（X10）。
- K6/4-N25: IR の timeout の再試行による子（X7）。
- K6/4-N26: 子の Graph の edge が 0 件か期待寄与が無い（X5）。
- K6/4-N27: (q2) が T_show を超えた（X8）。
- K6/4-N28: 親の IR が timeout の sample（X11）。

## 範囲と他の lane への影響

| lane | 影響 |
| ---- | ---- |
| CP-4 | `useNir1RelatedScenes` を mount する新しい harness の消費者（R5）、runner と分類器の変更（R1〜R8、F1〜F7、X1〜X12、K6/4-N1〜N28 の合成の記録）、手順のファイルの新しい版。製品のコードの変更は要らない見込み。G-case の seed の pin が要るなら CP-0 の側で扱う（批准 9） |
| PUB-G／Session C-1 | first-render の窓外率、follow-up の内訳、q1〜q3 の分布、UX（一覧の一時的な消失。必須の開示項目）、判断 4 の偶然の幅を開示に添える。PUB-G の承認は置き換えない |
| DD-1、DP-H、K6/3 | 影響しない |
| D′（CQ-DEFER）、CP-3a／b | 製品のコードは変えない。H3 の UI の改善は別の lane |

## 確かめられなかったこと

1. 製品の経路での follow-up（`t_notice`、`t_follow`、子の合流の outcome）。子の begin、IR の continue、Graph の continue は derived の lane に直列に並び、requalification は小さい fixture でも median 6.6 ms で、D は 10.84 ms なので、子の Graph が子の D の窓に届くことは構造上かなり厳しい見込み（推定）。届かなければ、この定義でも HOLD になる。そのときに子の窓を広げることは D の緩和で、この draft の外（新しい draftRef と確認が要る）。このため確認の前に H5 を取る（批准 11）。
2. 通常の sample での (q1) の分布（十数 ms は Native の時計の p50 同士の差からの推定）。renderer の `t_raw_ready` と Native の Raw-ready の差、`graph-ready` の event が renderer に届くまでの時間。
3. G-case（CP-0 の凍結した fixture）の seed が query の Scene の pin になっているか（DR-CP4-S1C2-26 は dev fixture だけを確かめた）。
4. 遅い begin（1,704.6 ms、1,157.0 ms）の原因と頻度。子で起きた場合の (q2)。
5. D-final の待ちの延び、D-final による cache の取得の頻度、場面の素早い切替えでの rebuild の窓の影響、2 つの表示の往復。
6. 一覧が一度消える UX の実際の見え方（コードの読取だけ）。
7. 評価の手順のファイルの置き場所と版の名前（master にも統合 branch にも無い）。
8. 子の requalification の時間（DR-CP3A-29 の小さい fixture の値だけ）。
9. 判断 7 の (ii) の下での閲覧中の trace の表示の率（測っていない。H5 で併せて見る）。

## 引き継ぎ（実装と測定の担当への申し送り。この確認の条件ではない。H5 だけは確認を求める前提）

- H1 CP-4 の runner: R1 の待ち（DR-CP4-S1C2-23 の `quietAtStart`）、`useNir1RelatedScenes` を mount する消費者、`t_notice` と `t_follow` の timing shim、R7 の記録、合成の記録で K6/4-N1〜N28 を固定する。`steadyStateInWindow` は first-render の記録として残し、表示の可用性の判定を別に足す。
- H2 counter: 評価の JSON に `begins`、`cacheHits`、`lateCached` を、親の前と子の後に読めるように出す（既存の counter。`nir1_graph_product.rs:383-398`）。`deferredReleased` ほか（DR-CQD-9）は統合 branch の評価 hook のまま。新しい製品の入口は足さない。
- H3 UI: 子までの間に一覧を消さない改善（`useNir1RelatedScenes.ts:157` の扱い）を別の lane で進める。Graph の UI は閉じた gate の内側（`isNir1GraphUiEnabled`）なので、PUB-G の前に決める。改善すれば、この draft の失効（「変える点」の 12）に当たる候補になる。
- H4 seed: dev fixture `dev-lantern.v1` の query の Scene に seed の pin を置くかは integrator の判断（DR-CP4-S1C2-26）。G-case の setup の変更は CP-0 と `g01-eval-revision` の側で扱い、この draft は許さない。
- H5 実現可能性の診断（確認を求める前提。integrator が別 lane で取り、条件の判定に使わない）: 製品の経路（R5 の消費者）で、定常状態の形の親と子を N 回出し、子の合流の outcome、(q1)、(q2)、F1〜F7 と X1〜X12 の内訳を見る。閲覧中の trace の形でも数件見る。子が D の窓に届かない見込みが強ければ、確認を求めずに integrator に返す。

## 確認の扱い

- 確認は、台帳の Confirmation protocol（2026-10-25 の緩和の後。台帳 247 行）に従い、`nir1-final-request-eval-proposal/4` と `graph-eval-procedure` を曖昧さなく特定するユーザーの明示の承認で行う。承認の効力は批准 6 の 2 段で、(i) は確認、ほかは事前の確認である。依存する契約、K6/2 と K6/3 のほかの行は確認されない。推奨と違う選択は新しい draftRef で起案する。
- 2026-10-25 の「K6/2 は A で」、計画への同意、merge の指示、包括的な返答は、確認として扱わない。
- 確認を求める前に H5 の結果を添える（批准 11）。
- この draft は合格基準の緩和を含むので、続行計画 §12.1 の「重要な変更」（(3) 確認済みの閾値・合格基準の緩和）にあたる。`graph-eval-procedure` には確認済みの行が無いが、612 行の trigger と post-B:225 の「品質・可用性・性能を同時に満たす」の読みを弱めるので、同じく扱う。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足（K6/3 の B4-1 の表と同じ形）: 受信の日時、承認の逐語、提示した `draftRef#contractId` と SHA-256、取り込んだ draft の SHA-256、H5 の結果の所在。「承認の範囲と効力」（冒頭の 1〜11 と、批准 6 の (i) と (ii) の分け方）と「K6/4 が許さないもの」（批准 9）の段落を足す。
- 確認台帳の行: `graph-eval-procedure` の /2 の行（206 行）を残し、その下に /4 の行を足す。confirmedRef は「批准 6 の (i) についてだけ `nir1-final-request-eval-proposal/4#graph-eval-procedure`」、行のほかは preConfirmationRef（効力の根拠にしない）と書き分ける。startStatus は `condition-not-met`。
- 台帳の読み替えの注（文案）: 223 行の注の下に「2026-10-25 以降の注（K6/4）: `graph-eval-procedure` の /4 の行は、批准 6 の (i)（条件が成立しない場合の CP-4 の可用性の読み替えと、その判定に要る定義）についてだけ confirmedRef を持つ。行のほかの内容は、条件の成立の後の改めての確認まで効かない（上の注のとおり）。`g01-eval-revision` は変わらない」。206 行の備考の「既存の条件の CP-4 は、K6/2 の『条件が成立しない場合の CP-4 の可用性』に従う」の下に「K6/4 の確認の後は、/4 の『変える点』の 3 の読み（(a) は表示の可用性の欠落率、(b) の窓外率は /4 の 15 の読み）で従う。この読みは D′ の状態機械を持つ候補に限る」。K6/2 の 2026-10-17 の注の下に、/4 の「変える点」の 1〜16 を読み替えとして足し、2、3、5、7、8、15 が /2 の文面より弱い読みであること、first-render の窓外率を開示し続けることを書く。
- 凍結の順序: integrator は、条件の判定に使う診断を取る最初の run の前、かつ (i) の読み替えで判定する CP-4 の最初の run の前に、この draft の bytes を `claude/nir1-contracts` に commit して push し、K6/2 の「事前登録の凍結」の 1〜7 の記録を作る（批准 7）。(i) で判定する CP-4 の run は、この凍結の後に始めたものに限る。
- CP-4 の TASK: 「設計」「測定の手順の読み替え」「受入れ」と引き継ぎの H1〜H4 を写す。
- 確認されなければ、CP-4 の (a) は K6/2 の文のまま D′ の下で構造上 HOLD で、別の案は /5 で起案する。

## 確認文

contractId の選択: **`graph-eval-procedure`**（K6/2 の条件付きの行と同じ）。

- 理由: (1) この差分は、K6/2 の `graph-eval-procedure` の可用性の判定と手順の改訂で、新しい契約の主題ではない。(2) 新しい authority、保存先、送信先、製品の入口を加えない。(3) `nir1-final-request-packing-eval`（K6/3 の行）の内容に触れない。(4) 確認は contractId ごとの 1 回の承認（台帳の Confirmation protocol）。

承認の例（固定の文でなくてよい。draftRef と contractId を名指すか、integrator が直前に SHA-256 つきで示したこの 1 行への承認の返答であればよい）:

- I confirm draftRef nir1-final-request-eval-proposal/4 for contractId graph-eval-procedure.
