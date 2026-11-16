# CP-4 品質の判定（手順外の補助の記録）

> この記録は CP-4 の正式の判定（DR-CP4-S6-3 の HOLD）ではなく、それを置き換えない。

対象：S4 `f2f99b13`、候補 `3f333a83`。受領書は書き換えていない。

**全体：hold（unverified-required-items）**

## 条件（集計）

| 条件 | 状態 | 根拠 |
|---|---|---|
| G-01 の事前指定改善 | pass | R+IR recall 0.0000 / nDCG 0.00000 → Graph recall 1.0000 / nDCG 0.63093、事前指定と一致：true |
| macro 非回帰 | not-evaluable | G-case 13 variant：pass（recall 0.0385 → 0.4615、nDCG 0.03820 → 0.27879）。既存 24 件の Graph arm：not-evaluable |
| Hybrid p95 ≤ 94.2 ms | pass | R+IR arm 22.60 ms（n=390）、Graph arm 92.70 ms（n=390）。G-case の母集団で、P の 24 query ではない |
| Evidence 100％ | not-evaluable | edge の束縛だけ：pass（9 variant、検査 270 sample、検査できず 0）、D8 親の合流の寄与：pass。残りは not-evaluable |
| 禁止寄与 0 | not-evaluable | (a) 禁止 Scene・blocked 候補：pass（違反 0 sample）、(b) 遅れた Graph：pass（違反 0 sample）、D3 の index-ready の取り直し：pass。(c) は not-evaluable |

D3 の開示（条件に数えない）：対象の子 30、Graph を出した子 30（edge 30 件）、期待の外の追加 0 件、D2 に残った index-ready の子 0（欠けた条件：なし）。

## variant ごと

| variant | 改善 | macro（Δrecall／ΔnDCG） | edge の束縛 | 禁止 (a) | 禁止 (b) | 表示（first／follow／なし） | p95 ms R+IR／Graph（開示） |
|---|---|---|---|---|---|---|---|
| G-01/v1 | pass | pass（1.000／0.631） | pass | pass | pass | 30／0／0 | 22.2／49.9 |
| G-02/base | n/a | pass（1.000／0.500） | pass | pass | pass | 3／27／0 | 18.7／108.3 |
| G-03/base | n/a | pass（0.000／0.000） | pass | pass | pass | 30／0／0 | 22.4／93.7 |
| G-03/frontier-exceeded | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 36.8／58.4 |
| G-04/base | n/a | pass（0.500／0.497） | pass | pass | pass | 0／30／0 | 18.3／116.5 |
| G-05/base | n/a | pass（0.000／0.000） | pass | pass | pass | 4／26／0 | 17.3／100.3 |
| G-06/base | n/a | pass（0.000／0.000） | pass | pass | pass | 30／0／0 | 21.0／85.0 |
| G-07/base | n/a | pass（1.000／0.500） | pass | pass | pass | 0／30／0 | 18.3／100.8 |
| G-08/base-usable | n/a | pass（1.000／0.500） | pass | pass | pass | 29／1／0 | 19.4／96.0 |
| G-08/graph-index-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 19.0／35.2 |
| G-08/graph-recovered | n/a | pass（1.000／0.500） | pass | pass | pass | 30／0／0 | 18.6／53.9 |
| G-08/chronicle-index-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 21.3／21.2 |
| G-08/both-indexes-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 21.1／21.7 |

## not-evaluable の一覧

- macro-non-regression / existing-24-graph-arm：no-graph-arm-receipt-for-the-existing-24-queries
- evidence-validity / utf16-range：not-in-the-receipt
- evidence-validity / explicit-pin-association：not-in-the-receipt
- evidence-validity / raw-excerpt-unchanged：not-in-the-receipt
- evidence-validity / added-scene-body-anchor：not-in-the-receipt
- forbidden-contribution / c-existing-24-graph-appearance-and-dto：not-in-the-receipt

blocked の判定：ledger。p95 の上限は手順のファイル v2 の B と上限（K6/5。B=54.2、D=40。B は D から逆算しない）の 94.2 ms、百分位 0.95、許容誤差 1e-12。
