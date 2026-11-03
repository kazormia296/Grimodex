> 注（integrator、2026-11-03）：read-only の workflow（調査 2・反証の検証 2・まとめ 1。model は sonnet）の結果。#30（起動時 JS の予算）は、この調査の後に integrator が実測した（`startup-js-budget-gates-true-2026-11-03.md`、contracts `e48e065e`）：PUB-G の 2 定数では raw は増えず上限の内側、D2a の UI の定数を足すと raw が 1,536 超過。下の #30 の「予算超過は避けにくい（推測）」はこの実測で置き換える。ほかの主張は workflow の検証を経た下書き。

# NIR-1 CP-4 の品質判定と PUB-G 不明項目の調査まとめ

## 1. 結論

- CP-4 の品質判定は、今ある s5r6 の記録だけでは完了しません。足りないのは、(1) Evidence 妥当性と禁止寄与の「正式な判定」、(2) P(速度)を契約どおりに測った値、(3) 既存 24 件の Graph 比較です。
- 出せるのは G-01 の改善と macro 非回帰(再計算で 39/39 一致)、禁止 Scene の混入 0(計算済み)、遅れた Graph の混入 0(記録済み)です。Evidence は edge 部分の材料だけがあります。
- P の参考値は 55.3 ms(上限 65.04 ms)です。ただし母集団が契約の P(24 query×720 call)と違うので、合否には使えません。
- PUB-G の不明 7 項目のうち、閉じたのは #7(C-resource G-2)の 1 件です。#45 は事実の面だけ閉じ、承認範囲の判断が残ります。
- 残りは #6 が集計待ち、#11 は P が測定待ち、#15 と #30 が判断と測定待ち、#16 が実機測定待ちです。

## 2. 品質の条件ごとの表

| 条件 | 出せるか | 値・状況 | 根拠 | 閉じるのに要るもの |
|---|---|---|---|---|
| G-01 の改善 | 出せる(再計算) | R+IR 0/0 → Graph 1/0.631 | 受領書から Recall@8／nDCG@8 を再計算し、39/39 が事前の期待値と一致(contracts の recompute-s5r6 README) | 再計算を品質判定の段にするか、integrator が決める(閾値は変えない)。Graph が足した 6 variant はすべて follow-up(子)の表示で、first-render の窓内で表示された sample は 0 件。first-render で測る規則なら別問題になる |
| macro 非回帰 | 出せる(再計算) | macro は R 0、R+IR 0.0385、Graph 0.4615。悪化した variant なし | 同上 | 上と同じ。なお post-B §7.3 は macro を「既存 24 件＋G-01〜G-08」の比較と定めており、24 件の Graph arm は無い(下の「既存 24 件」の行) |
| Evidence 妥当性 100%(定義) | 済み | 定義は fixture 側にある。post-B §7.3 は「100%」とだけ書く | `evals/nir1-graph` の schema、README、manifest | なし |
| Evidence 妥当性 100%(edge の束縛) | 部分的に出せる | Graph が寄与した 9 variant×30＝270 sample で、期待 path と過不足なく一致し、unresolvedEdges=0。負例 N2／N3／N4 も 0 | 受領書の `materialRevision`。両端 Entity、型、向き、両端 quote の sha256 の全一致で解決する | 判定そのものではない。「部分証跡」として別表にし、使うかはユーザーが決める。`requalification: passed` は観測ではなく推論値(`k64-record.mjs:300`)なので、この 270 件の根拠には数えない |
| Evidence 妥当性 100%(残りの要件) | 一部は間接的に出せる、大半は材料なし | G-05 は 30/30 で最新の Revision に解決(古い銅の記述を返さない傍証)。G-03／G-06 の c2 は 2 本の edge が解決済み。G-06 の c4(名前だけの言及)は path に現れない | 受領書に Graph の返却内容(node、edgeIds、pathAttachments、evidence、excerpt)のキーが無い | UTF-16 範囲、pin の直接検査、Raw excerpt 本文の不変、追加 Scene の本文 anchor は、Graph の返却内容を sample ごとに記録する測定が要る。新しい契約にあたりうるのでユーザー確認の対象(推測) |
| click 時の Evidence 検査と判定コード | 正式 run では走っていない | `nir1_evidence_qualify` を呼ぶのは dev 診断(`cp4-harness.ts` の heldSample)だけ。判定関数(`resolveCp4VariantOutcome` など)は正式経路から呼ばれていない | 受領書の `outcome: recorded` は「正式 run として記録した」の意味で、品質の合否ではない。C-query 台帳の CQ-1 は Rust 試験の層の話(行は :50 と §2.3 の :71-73)で、CP-4 の代わりにならない | 受領書を入力に判定関数を offline で呼べるか確かめる(製品は変えない)。click を条件に含めるなら、heldSample 相当を正式経路に足す測定が別に要る |
| 禁止寄与 0(定義) | 済み | 3 つの面に分かれる。(a) 禁止 Scene と blocked 候補、(b) 遅れた Graph、(c) 既存 24 件での Graph の出現 | fixture、post-B §7.2、README :199 | (a)(b)(c) を別々に報告する。受領書の X1〜X13 や F1〜F7 は可用性の失敗区分で、「禁止寄与」と呼ばない |
| 禁止寄与 0:(a) 禁止 Scene・blocked 候補 | 出せる(計算済み) | 混入 0。対応づけできない ID も 0 | gold 13 variant の親と子の表示を論理 ID に直し、fixture と突き合わせた | offline スクリプトとして記録に残す。G-03 base と G-06 は Raw が満杯の設計で Graph が何も足さないため、0 になるのはその帰結でもある(推測) |
| 禁止寄与 0:(b) 遅れた Graph の混入 | 出せる(記録済み) | 0。Graph arm 480 sample の親は `lateGraphInDisplay=false` かつ `publishCount=1`。親の表示は R+IR と 13 variant×30 で一致 | 受領書の k64 ブロック | 「混入 0」とだけ言える。G-03 frontier-exceeded は理由なしの graph-late、G-08 graph-index-unusable は 28 件が registration-unavailable で、不可用の理由の種類まで観測できたわけではない。k64 の `qualityHold:true` は旧 k62 の意味で、品質の合否ではない |
| 禁止寄与 0:G-01 負例 N2／N3／N4 | 出せる(記録済み) | 各 30 sample で edgeCount=0、期待された寄与なし、g01-mira の表示 0/30 | negatives-s5r6-1 の受領書 | 補助証跡として添える(case の合否には数えない診断)。G-02 以降の負例の受領書は無い |
| 禁止寄与 0:既存 24 件の Graph arm、Graph の node／path | 材料なし | s5r6 に 24 件の比較は無い | `paired.mjs` の Graph arm は既定で not-wired(`contract.mjs:315`)で、そのままだと hold になる。DTO の node／path は受領書に無い | 製品の standard-build の受領書と `manualSeed:'none'` で wired にして走らせる測定が要る。DTO の禁止は、Evidence と同じ「返却内容の記録」が前提 |
| P(定義) | 済み | 24 query(ja／en 各 12)×測定 30 回＝720 call。warm-up は 5 回。実 Electron で AB/BA。p95 は nearest-rank。B=54.2、D=10.84、上限 65.04 ms。IR の timeout は 1% 以下 | `evals/nir1-retrieval/manifest.json:130-155`、`paired.mjs:452` | 過去の合格値 60.8 ms(2026-09-13)は R／R+IR だけで、Graph 統合後の合格ではない(出典は l6-l9 plan、contracts :353、master :752) |
| P(参考値) | 計算すれば出せる(合否ではない) | gold の R+IR arm は n=390 で p95=55.3 ms、p50=21.6 ms。65.04 ms 超は 15/390(3.8%)で、許容は 19 件まで、max は 255.8 ms。parity は n=360 で p95=25.4 ms、超過 11。gold の Graph arm は p95=31.5 ms。editing trace は p95=69.3 ms(autosave を含み、P の手順の外) | 受領書の tFetch／tReturn | 「P の合格」と呼ばない。p95 の定義に依存する(線形補間では 42.1 ms と大きく違い、分布は二峰性)ので、定義を添える。120〜260 ms の spike が全 arm にあり、I/O 圧(some avg10)は gold 85.2〜97.4、parity 82.0〜84.7 と高い。windowAssessment は clean だが PSI は判定に入っていない(原因は未確認) |
| P(契約どおりの測定) | 材料なし | 母集団が違い(13 variant の G-case、Raw arm なし)、AB/BA も G-01 と G-08 の一部(chronicle／both-indexes-unusable)は hybrid が常に先 | K6/2 の :620 と :694。受領書の再認可には mode と placedStateFile、note しかなく、時間の内訳が無い | 母集団(G-case を P とみなすか、24 件に Graph arm を載せるか、併用か)をユーザーが決める。24 件に載せる場合は Graph が seed 無しで not-requested になり、Graph の遅延は測れない。閾値(65.04、1%)は動かさない |

## 3. PUB-G の不明 7 項目

| # | 項目 | 状態 | 要点 | 閉じるのに要るもの |
|---|---|---|---|---|
| 7 | C-resource G-2 の HOLD | **閉じた** | 2026-10-18 に CQ-LIM-3 で解消済み(a789039a、#678。master の祖先と確認)。実 worker(16 MiB)の試験で READY を確認 | l6-l9:40 の状態欄が古い「HOLD」のままなので、「解除済み(#678)」に直す。PUB-G の開示に 2 点を書く。(1) A2 bytes が 2,097,152 B を超えると worker は READY にならず Graph は unavailable になる(安全側の動作)。(2) 製品形でちょうど 2,097,152 B の候補は作っておらず、確かめたのは 2,094,880 B まで |
| 45 | pin 自動化の段階 1(#744)は Graph の gate の内側か | 事実は閉じた(承認範囲の判断が残る) | 起点パネルと pin ボタンは `NIR1_GRAPH_UI_ENABLED` が真のときだけ出る。PUB-G で Graph UI を開けると同時に有効になる。保存範囲・送信先・IPC は増えない(DR-SEEDSUG-5)。pin は作者の click だけで、自動書込みはなし。CP-4 の測定は setup の pin で seed を与えており、このパネルの click は測定対象外 | 判断は 2 つ。(1) 承認範囲に起点表示と pin ボタンの機能を明示で含めるか(DR-SEEDSUG-4 は文言の承認だけを書いている)。(2) DR-SEEDSUG-4 と -10 の暫定文言と focus の見直しを PUB-G の文言承認に載せる。補足:このパネルは renderer の定数だけで出る。Native の gate が閉じていても出て、pin を書ける |
| 6 | A3 consumer activation の証跡 | 5 種の理由についてだけ計算すれば出せる。軸の網羅は材料なし | s5r6 の受領書に出る A3 の理由は 5 種だけ(scope-mismatch、reading-before-query、reveal-unavailable、revision-not-human-approved、source-revision-changed)。Rust 側の語彙は約 20 超あり、POV、phase、story-scope、auto-scope、query 軸は受領書に一件も出ない。editing／browsing trace は 201/201 で eligible | 5 種は全受領書(gold、negatives、trace)から集計できる。未演習の軸は、foundation(#598)の Rust 試験で足りるとみなすか、実製品経路で測るかを integrator が決める。測るなら G-case の追加(凍結の変更)になり、別の確認が要る |
| 11 | CP-4 の品質と P | 品質は一部あり、P は材料なし | 上の表のとおり(G-01 改善と macro は再計算で出る。Evidence と禁止寄与は部分。P は参考値のみ) | 上の表の「閉じるのに要るもの」。未測定のまま PASS にしない |
| 15 | CP-4 の候補(cbf33077)から最終候補へ結果を持ち越す規則 | 残り(判断) | 持ち越しを定める明文の規則は見つからない。cbf33077 以降の 4 件(#780〜#784)のうち、評価経路に関わるのは #782(日本語の sparse query)だけ。英語は従来と同じ文字列で、CP-4 の fixture は英語のみ、harness は旧関数を直接呼び続ける。ただしこれは設計文書の「影響なし」という主張で、再測定が不要という規則ではない | 持ち越しの条件を integrator が文書にする(測定経路に触れる変更の一覧と、各変更を「触れない」と示すか「再測定する」かの表)。#782 は英語で不変という主張を試験で確かめるか、日本語の G-case を作るまで開示にとどめるかを選ぶ。P の ja 12 件を測るときは #782 以後の build が要る。PUB-G 最終候補の G-pub(3 OS の packaged smoke)は別に採り直す |
| 16 | DR-CP3A-55:lease 越しの end-to-end(Graph-only の行を `graph_continue` で受け、その handle で `nir1_evidence_qualify` を click) | 材料なし(実機測定が要る) | 通すまで PUB-G を開けない条件。click を呼ぶのは dev の heldSample だけで、dev fixture は Graph-only の行を作らない。s5r6 の gold は親が continue を cancelled にしており、click の流れは無い。CP-3b の試験は Native を mock しているので代わりにならない | 実 Electron(評価 build)で G-01 fixture を使い、seed つき begin → continue が Graph-only の行を返す → qualify → settle → 再 begin(cached) → used の settle を通し、status と reason を記録する。正式な CP-4 の run には数えず、別記録にして DR-CP3A-55 に追記する |
| 30 | 定数を true にしたときの起動時 JS の予算 | 不明のまま(測り方は決まった) | 現在の上限は raw 4,261,500／gzip 1,350,000 で、定数 false の余白は約 79 byte。過去の測定では、基点 16797ce7 で定数 true の raw は 4,251,408(当時の上限を 408 超過)、PR-B の HEAD では 4,252,464(基点より +1,056)。少なくとも +1,464 は増えるので、予算超過は避けにくい(推測)。PUB-G で開ける定数は 3 つ(`NIR1_GRAPH_UI_ENABLED`、`BODY_DECLARATION_UI_ENABLED`、`PROFILE_ACTIVATION_UI_ENABLED`)。`NIR1_LOCAL_GENERATION_UI_ENABLED` は PUB-L なので false のまま | 使い捨て worktree で master の head(21c25c73 以降)の 3 定数を一時的に true にして build し、`pnpm perf:budget` で測る。比べる値は、実効上限、定数 false の実測(#781 は 4,261,421)、過去の true との差。1 つずつ true にして寄与を分け、全部 true の値も取る。超過の判断(lazy 化を先、足りない分だけ最小の緩和を独立 commit)は測定の後 |

## 4. 次の一手

### 読むだけ・文書だけ(並行して進められる)
- l6-l9:40 の状態欄を「解除済み(#678)」に直し、#7 の開示文面(2 点の限界)を用意する。
- #15 の持ち越し規則の草案を書く(変更一覧と「触れない／再測定」の表)。
- #45 の承認範囲の論点(起点表示と pin ボタンを含めるか、暫定文言の扱い)を整理してユーザーに提示する。

### 計算(新しい測定は不要)
- #6:全受領書から A3 の理由を集計し、Rust の語彙との対応表(演習された軸、されていない軸)を作る。
- 受領書を入力に、品質判定の関数(`resolveCp4VariantOutcome` など)を offline で呼べるか確かめる。禁止寄与(a)(b)の計算は同じ script にまとめる。
- P の参考値は p95 の定義(nearest-rank か補間か)を添えて記録する。

### 測定(実機・資源隔離が必要)
- #16:実 Electron で lease 越しの click の end-to-end を通す(正式 run とは別記録)。
- #30:3 定数を true にした build の予算を測る。
- Evidence の残り要件のための「Graph の返却内容の記録」と、既存 24 件の Graph arm(wired)は、新しい契約にあたりうるので、先に確認が要る。
- P を契約どおりに測る場合は、I/O が静かな host で、資源隔離の preflight 済みの状態にする。

### ユーザーの判断
- P の母集団をどうするか(G-case を P とみなす、24 件に Graph arm を載せる、併用)。
- Evidence の「部分証跡」を品質判定に使うか、返却内容の記録を取る測定に進むか。
- A3 の未演習の軸を Rust 試験で足りるとみなすか、実製品経路で測るか。
- #45 の承認範囲と暫定文言の扱い。
- #15 の持ち越し規則の方針と、#782 の扱い(試験で確かめるか、開示にとどめるか)。

## 5. 確かめられなかったこと

- 実行・build・Electron 起動はしておらず、すべて git object と受領書の読取、および集計による。
- Evidence の UTF-16 範囲、pin の直接検査、Raw excerpt 本文の不変、追加 Scene の本文 anchor は、受領書に材料が無く確かめられない。
- 既存 24 件の Graph arm と Graph の node／path の禁止寄与は、記録が無く確かめられない。
- P の tail(120〜260 ms の spike)の原因が I/O 圧によるかは未確認で、推測にとどまる。
- 不可用 variant の理由の種類(graph-limit-exceeded など)は、受領書に現れず観測できていない。
- A3 の未演習の軸が実製品でどう振る舞うかは未確認。
- #30 の定数 true の実測値は無く、超過の見込みは過去の測定からの推測。gzip の取り直しも未実施。
- #16 の click の流れ(Native の lease 側の接着)を実行する試験は、読んだ範囲では見つからなかった。
- 調査した版は origin/master 21c25c73、contracts a22080bd。これ以降の変更は反映していない。