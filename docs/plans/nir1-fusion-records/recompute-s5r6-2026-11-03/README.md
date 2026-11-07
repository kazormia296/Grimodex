# CP-4 s5r6 の受領書からの品質の再計算（2026-11-03）

> 注（integrator）：ユーザーの依頼（contracts `f31bdce6`）。新しい測定はしていない。2 つの agent（workflow、model は sonnet）が独立に script を書いて計算し、3 つ目の agent が突き合わせた。integrator は calc-b の script を再実行し、39 行すべて `match=True`（不一致 0）であること、指標の定義が `origin/master:scripts/quality/nir1-retrieval/contract.mjs` の `scoreQuery`（gain 2^grade−1、割引 log2(i+2)）と同じであることを確かめた。**訂正**：下の本文の「P（precision 系）」は誤り。CP-4 の品質の条件の P は Hybrid の p95 ≤ 65.04 ms（時間）で、この再計算の範囲外。**この結果は品質の合否の判定ではない**（判定の段の置き場はユーザーが決める）。script は `scripts/`、各 agent の出力は `calc-*`。script の中の作業 path は scratchpad のもの。

## 1. 結論

- 2 人の計算は 13 variant × 3 arm の 39 行すべてで一致し、fixture の事前の期待値とも 39/39 で一致した。calc-a と calc-b の script を再実行し、calc-a は `metricMatch True` が 39 行、calc-b は `match=True` が 39 行だった。
- macro（13 variant の単純平均）は、R が Recall@8 0.0000／nDCG@8 0.0000、R+IR が 0.0385／0.0382、R+IR+Graph が 0.4615（=6/13）／0.2788（=3.6242/13）。
- R+IR が R に足したのは G-05 だけで、0 から 0.5／0.4966 になった。
- Graph が R+IR に足したのは G-01、G-02、G-04、G-07、G-08 の base-usable と graph-recovered の 6 variant。全部 follow-up の child の表示で、first-render の窓内で表示された sample は 0 件。
- 悪化した variant はない。G-03 の 2 variant、G-05、G-06、G-08 の unusable 3 variant では Graph は何も足さなかった。この結果は、fixture の事前の期待値どおり。

## 2. 表（macro は 13 variant の単純平均。各 variant は measured の 30 sample が 1 通りで、ばらつきなし）

| variant | R（Recall／nDCG） | R+IR | R+IR+Graph | 期待値と一致 | R+IR+Graph の最終一覧 |
|---|---|---|---|---|---|
| G-01/v1 | 0／0 | 0／0 | 1／0.63093 | 一致 | question, mira |
| G-02/base | 0／0 | 0／0 | 1／0.5 | 一致 | attach, probe, tamsin-first |
| G-03/base | 0／0 | 0／0 | 0／0 | 一致 | c4,c3,c2,c1,c7,c6,c5,c8（R と同一） |
| G-03/frontier-exceeded | 0／0 | 0／0 | 0／0 | 一致 | 同上（child なし、親の一覧） |
| G-04/base（fixture v2） | 0／0 | 0／0 | 0.5／0.49664 | 一致 | control, lio-landing |
| G-05/base | 0／0 | 0.5／0.49664 | 0.5／0.49664 | 一致 | control, xan-watch（R+IR と同一） |
| G-06/base | 0／0 | 0／0 | 0／0 | 一致 | c1,c7,c2,c5,c6,c4,c8,c3（R と同一） |
| G-07/base | 0／0 | 0／0 | 1／0.5 | 一致 | attach, probe, pell-dock |
| G-08/base-usable | 0／0 | 0／0 | 1／0.5 | 一致 | control, attach, cass-attic |
| G-08/graph-index-unusable | 0／0 | 0／0 | 0／0 | 一致 | control, attach |
| G-08/graph-recovered | 0／0 | 0／0 | 1／0.5 | 一致 | control, attach, cass-attic |
| G-08/chronicle-index-unusable | 0／0 | 0／0 | 0／0 | 一致 | control, attach |
| G-08/both-indexes-unusable | 0／0 | 0／0 | 0／0 | 一致 | control, attach |
| **macro（13）** | **0／0** | **0.0385／0.0382** | **0.4615／0.2788** | 全 39 行一致 | |

- R と R+IR の最終一覧は、G-05 の R+IR（control に xan-watch が加わる）以外は同一だった。G-02、G-07 では R の並びが fixture の列と逆だが、Gold 0 の Scene だけなので指標に影響しない。
- 別の平均として、8 variant（G-01、G-02〜G-07 の base、G-08 の base-usable）だけで平均すると、R は 0／0、R+IR は 0.0625／0.0621、R+IR+Graph は 0.625／0.3905 になる（calc-a の算出で、`recompute.py` の値から検算した）。
- sample の一覧のばらつきは、全 variant・全 arm で 1 通り × 30 だった。
- Graph の表示の由来は、follow-up の child が 7 variant × 30、親の一覧のままが 4 variant × 30（G-03 frontier-exceeded、G-08 の graph-index-unusable、chronicle-index-unusable、both-indexes-unusable）。親の一覧のままの 4 variant のうち、G-03 frontier-exceeded と G-08 graph-index-unusable は child なし、G-08 の chronicle-index-unusable と both-indexes-unusable は child が公開されたが `graph-late` だった。
- G-03/base の child も `graph-ready` で表示されたが、R と同一の 8 件で何も足さなかった。G-06 も同じ。

## 3. 2 人の計算の食い違いと決め方

指標の食い違いはなかった。差は次の 3 点で、どれも指標に影響しない。

- **G-01 R+IR+Graph の nDCG**：calc-a は 0.6309297535714575、calc-b は ...574 で、最下位 1 ulp の差。fixture の期待値は ...574。浮動小数の計算順の差で、許容誤差 1e-12（K6/2 の判断）の内側なので一致とした。
- **「表示された最終の一覧」の規則**：calc-a は、child の `publishCount>=1` かつ `completion=completed` なら child を採る。calc-b は、`joined`、または child が `graph-ready` かつ `currentAtDisplay` かつ completed のときだけ child を採り、それ以外は親を採る。両者が分かれるのは G-08 の chronicle-index-unusable と both-indexes-unusable の 2 variant で、child は公開済みだが `graph-late` だった。calc-a は child の一覧、calc-b は親の一覧を採った。2 つの一覧は同一なので、結果は変わらない。K6/4 の「表示された sample」を、Graph が寄与して表示された sample と読むなら、calc-b の読みが近い。
- **R+IR の取り方**：calc-a は hybrid arm に displayed 規則を当て、calc-b は hybrid arm の `finalSceneIds` を使う。calc-b は graph arm の親の `finalSceneIds` と全 variant で一致することも確認している。結果は同じ。

## 4. 使った定義と出典

- 両者とも `origin/master:scripts/quality/nir1-retrieval/contract.mjs` の `scoreQuery`（147〜183 行）を再実装した。`evals/nir1-graph/README.md` が metrics を「既存の `scoreQuery` と同じ」と指定している。
- 定義は次のとおり。
  - Recall@8 は、Gold>0 かつ eligible の Scene のうち、一覧に入った数の割合。
  - nDCG@8 は、gain を 2^grade−1、割引を log2(i+2)（i は 0 始まり）として DCG を求め、理想 DCG（Gold>0 の等級を降順に並べた上位 8 件）で割った値。
  - 順序は常に使う。`orderPredeclared=false` の arm は全要素が Gold 0 なので、指標は順序に依存しない（README の記述）。比較するのは membership だけ。
  - 許容誤差は 1e-12。
- 依頼文の「gain＝等級（線形）」は採らなかった。repo の定義が 2^g−1 で、fixture の期待値もその式で書かれているため。線形にすると G-04 と G-05 の nDCG は 0.4966 ではなく 0.4441 になる。他の variant は Gold が 3 だけなので値は変わらない。
- 材料は、受領書が `a22080bd:docs/plans/nir1-cp4-records/gold-s5r6-1/`、fixture が `origin/master` の `evals/nir1-g01/fixture.v1.json` と `evals/nir1-graph/g0*`（G-04 は v2）。Scene の ID は受領書の `settings.setupReceipt.logicalToRuntime.scenes` の逆引きで直した。未対応は 0 件。
- warmup は除き、measured の hybrid／graph 各 30 sample を使った。

## 5. この結果で言えないことと、確かめられなかったこと

**言えないこと**

- Gold は Graph に有利に設計した fixture なので、この数値は一般的な検索品質ではない。fixture どおりに動いたことの確認にとどまる。
- Evidence 100%、禁止寄与 0、path Evidence の妥当性、Graph DTO の nodes／edges は、Recall と nDCG の外なので計算していない。
- P（precision 系）は受領書から出せない。
- Graph が足したのは、後ろに 1 件追加した分と順位の押し上げだけ。Raw が 8 件満杯の G-03、G-06 では何も足せない。これは fixture の設計どおり。
- G-04 は v2 を使った。v2 は IR に補完させない構成なので、R+IR が R と同じ（v1 では R+IR で 0.5 になった）。
- G-05 は IR 補完済みの区分なので、Graph の増分は 0 になる。

**確かめられなかったこと**

- 前提条件（`cb4-inputs`、`ir-supplement-admission`、`index-state-holding`）の判定記録は見ていない。受領書の verdict は全 variant で `outcome=recorded`、validation は valid だった。
- G-08 の unusable 3 variant で、index が宣言どおり unusable に保たれていたかは確かめていない。表示の一覧が R+IR と同一だったことだけを確認した。
- 「表示」の判定規則は、両者とも受領書の欄と K6/4 の文面から自分で組んだもので、harness の実コード（k64 の displayed 判定）とは突き合わせていない。ただし、k64 の集計（displayed=30、followUp=30、firstRender=0）とは件数が合う。
- setup 受領書の原本は git object から読めなかった。ID の対応は、gold 受領書に写された `logicalToRuntime` から作った。`parity-s5r6-1` は読んでいない。

作業用の script と結果は `/tmp/claude-1000/-home-grimodex-Grimodex/95714916-8eb0-4faa-91aa-eba95e1428fb/scratchpad/recompute/` の下にある。reconcile では、`calc-a/recompute.py` と `calc-b/recompute.py` を再実行し、出力を同 `ra.txt` と `rb.txt` に保存した。