# IR の到着の内訳の計測（dev 専用、2026-11-04）

branch `claude/ir-timing-diag`（`4952a215`＋`e0dd24d9`。push しない・製品の修正ではない）に区間の計装（env `GRIMODEX_IR_TIMING_FILE` のときだけ）を入れ、IR の試運転の project（PD 18 Scene・承認 236 件。原本の DB の sha `f560f8aa…` は不変、条件ごとに複製）で、試運転と同じ query（末尾 10 Scene、hybrid）を各条件 300 回呼んだ。LLM への送信 0。記録の原本は `/home/grimodex/fusion-eval-data/ir-timing/`。ここには集計（`*.analysis.txt`）と `explain.txt` を写した（ID・本文なし）。

## 結果（agent の報告。integrator は集計の file の存在だけを確かめた）
- timeout：N=236 で 300/300、N=123 で 300/300、N=65 で 299/300（承認数は rejected を足して変えた。roster 236 と Scene 18 は固定）。
- N=236 の区間（ms、p50／p90）：fetch→Raw 準備 110.9／133.2（query の埋め込み 102.7）、begin 返却→IR 計算の終了 61.5／68.0、qualify 61.0／67.5、完全検査 55.8／61.9、edge 再評価 45.0／50.5（うち scope-dependency 12 本 39.5、eligibility 1 本〔roster の 2 回目〕4.8）、roster の 1 回目 5.0、still_current 3.5、admission の loop 3.6、scope の読込み 2.0、query context 1.5、cosine 0.12。
- 規模の傾き：qualify p50 は N=236 で 61.0、123 で 34.6、65 で 21.4。scope-dependency の edge は 1 本 2.5〜3.3 ms。約 17 ms の固定費（roster の 2 回読み約 10、still_current 3.5、scope 約 2、query context 約 1.5）だけで D を超える。
- EXPLAIN：still_current の 2 本と roster の SQL は index を使う（proposals だけ全件走査、236 行）。SQL は主因ではない。
- 主因（推定を含む）：完全検査が IR の計算のたびに省略されない（begin の検査は省略経路、qualify は 300/300 で外れる）。間の書込みは query の埋め込みの audit の commit だけで、これが読みの同一性を動かしていると推定（直接は未確認）。scope-dependency の edge ごとに `load_sealed_snapshot_document_bindings_in_tx` で封印済み document を読み直す。
- 直す候補（推測）：scope-dependency の解決を検査の中で run ごとに memo（−30 ms 前後）、roster の読みを txn 内で 1 回（−5 ms 前後）。合わせても qualify 約 26 ms で D の約 2.4 倍。D に収めるには audit の commit と検査の順序、または省略経路が効く設計が要る（DR-CP4-V-1 に触れる）。
- 確かめられなかったこと：roster や Scene 数を変えた条件、audit の commit の推定、候補 177 と承認 236 の差の理由、締切で切らない場合の到着と再試行の挙動。
