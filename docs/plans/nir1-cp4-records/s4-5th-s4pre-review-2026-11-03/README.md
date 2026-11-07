# 5 回目の S4（S4b'''' の前）の独立レビューの記録（2026-11-03。integrator の要旨）

S4b''''（S2 の placeholder を埋めて frozen にする commit）の前の、枝全体の独立レビュー。reviewer は integrator が依頼した別の subagent（Opus、read-only。Graph の runtime を実行せず、測定の受領書を読んでいない）。これは**独立レビュー**で、S3 の独立レビューでも、fixture の独立期待値レビューでも、ユーザーの確認でもない。

| file | SHA-256 | 内容 |
|---|---|---|
| `review-s4pre.md` | `49b41a7fc722ddde8d7f93f6120f12ae697e41887c6320d628c58cda7b018480` | 本文。対象は枝 `claude/cp4-s4-5th` の HEAD `19fbcb83`（基点 master `a1cd6675`）。判定 (b) 修正してから go。P1×1、P2×2、P3×6 |

S2（frozen）の `review.conditions` は、この記録を「integrator の scratchpad の `review-s4pre.md`（SHA-256 `49b41a7f…`）で、contracts に置かれた記録ではない」と書いた（S4b'''' の commit の時点の事実）。**bytes は同じ**のまま、一時的な場所に置いたままにしないよう、この directory に置いた（この commit の時点で contracts の記録になる。S2 の文は S4b'''' の時点の事実として残る）。

## 指摘への対応

| 指摘 | 対応 |
|---|---|
| P1-1（ユーザーへの問いが開いたまま） | ユーザーが「安い代わりの方法を試してもらえますか？」と返答（`55861126`）。dev の確認を行い（`d58a7cad`）、作者の宣言の追補（`ac7e1059`）に記録した。封印の規則、限界として開示する扱い、v3 は変えていない |
| P2-1（R5 の順の開示が古い） | S2 追補 #13（`565a1115`）で `g04RevisionReadings.limits` (i) に `665abc0f`・`ac2e93d6` を足し、`S4:r5-check-record` の `fill` を書き直した。S4b'''' で埋めた |
| P2-2（G-01 v3 の K2/4 :418 の記録） | S4b'''' の S2 の `review.conditions` に書いた |
| P3-1（宣言の addendum v2 :198 が setup addendum の v2 を名指す） | 同じく `review.conditions` に書いた |
| P3-2（SP-N の取り直しの順） | 作者の宣言の追補（`ac7e1059`）と DR-CP4-S4-8 の追記 5 に書いた |
| P3-3（① の閉包の数え方） | 同上（静的 import 42＋dynamic import 1＝43） |
| P3-4〜P3-6 | 機械の門の外の文は S4b'''' の葉の比較で目視、`forbiddenFilesNotRead` は前例どおり、v3 の `reviewPlan` の (i)〜(vi) は凍結済みで直さない（作者の宣言の限界 (4)） |
