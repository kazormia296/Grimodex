# CP-4 品質の判定（手順外の補助の記録）

対象：S4 `3734e501`、候補 `cbf33077`。受領書は書き換えていない。

**全体：hold（unverified-required-items）**

## 条件（集計）

| 条件 | 状態 | 根拠 |
|---|---|---|
| G-01 の事前指定改善 | pass | R+IR recall 0.0000 / nDCG 0.00000 → Graph recall 1.0000 / nDCG 0.63093、事前指定と一致：true |
| macro 非回帰 | not-evaluable | G-case 13 variant：pass（recall 0.0385 → 0.4615、nDCG 0.03820 → 0.27879）。既存 24 件の Graph arm：not-evaluable |
| Hybrid p95 ≤ 65.04 ms | pass | R+IR arm 55.30 ms（n=390）、Graph arm 31.50 ms（n=390）。G-case の母集団で、P の 24 query ではない |
| Evidence 100％ | not-evaluable | edge の束縛だけ：pass（9 variant、検査 270 sample、検査できず 0）。残りは not-evaluable |
| 禁止寄与 0 | not-evaluable | (a) 禁止 Scene・blocked 候補：pass（違反 0 sample）、(b) 遅れた Graph：pass（違反 0 sample）。(c) は not-evaluable |

## variant ごと

| variant | 改善 | macro（Δrecall／ΔnDCG） | edge の束縛 | 禁止 (a) | 禁止 (b) | 表示（first／follow／なし） | p95 ms R+IR／Graph（開示） |
|---|---|---|---|---|---|---|---|
| G-01/v1 | pass | pass（1.000／0.631） | pass | pass | pass | 0／30／0 | 26.0／32.8 |
| G-02/base | n/a | pass（1.000／0.500） | pass | pass | pass | 0／30／0 | 22.2／184.8 |
| G-03/base | n/a | pass（0.000／0.000） | pass | pass | pass | 0／30／0 | 62.7／233.5 |
| G-03/frontier-exceeded | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 161.8／30.1 |
| G-04/base | n/a | pass（0.500／0.497） | pass | pass | pass | 0／30／0 | 22.7／193.6 |
| G-05/base | n/a | pass（0.000／0.000） | pass | pass | pass | 0／30／0 | 61.9／27.9 |
| G-06/base | n/a | pass（0.000／0.000） | pass | pass | pass | 0／30／0 | 25.2／30.5 |
| G-07/base | n/a | pass（1.000／0.500） | pass | pass | pass | 0／30／0 | 22.9／28.4 |
| G-08/base-usable | n/a | pass（1.000／0.500） | pass | pass | pass | 0／30／0 | 160.3／64.9 |
| G-08/graph-index-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 122.7／28.1 |
| G-08/graph-recovered | n/a | pass（1.000／0.500） | pass | pass | pass | 0／30／0 | 205.3／29.0 |
| G-08/chronicle-index-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 21.4／21.3 |
| G-08/both-indexes-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 20.4／21.5 |

## not-evaluable の一覧

- macro-non-regression / existing-24-graph-arm：no-graph-arm-receipt-for-the-existing-24-queries
- evidence-validity / utf16-range：not-in-the-receipt
- evidence-validity / explicit-pin-association：not-in-the-receipt
- evidence-validity / raw-excerpt-unchanged：not-in-the-receipt
- evidence-validity / added-scene-body-anchor：not-in-the-receipt
- forbidden-contribution / c-existing-24-graph-appearance-and-dto：not-in-the-receipt

blocked の判定：ledger。p95 の上限は manifest の B+D（B=54.2、D=10.84）から 65.04 ms、百分位 0.95、許容誤差 1e-12。
