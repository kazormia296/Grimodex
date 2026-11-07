# CP-4 品質の判定（手順外の補助の記録）

> この記録は CP-4 の正式の判定（DR-CP4-S6-3 の HOLD）ではなく、それを置き換えない。

対象：S4 `63bc9b90`、候補 `a2309b95`。受領書は書き換えていない。

**全体：hold（failed-required-items、held-required-items）**

## 条件（集計）

| 条件 | 状態 | 根拠 |
|---|---|---|
| G-01 の事前指定改善 | hold | R+IR recall - / nDCG - → Graph recall - / nDCG -、事前指定と一致：- |
| macro 非回帰 | hold | G-case 13 variant：hold（recall - → -、nDCG - → -）。既存 24 件の Graph arm：not-evaluable |
| Hybrid p95 ≤ 94.2 ms | pass | R+IR arm 22.00 ms（n=390）、Graph arm 60.20 ms（n=390）。G-case の母集団で、P の 24 query ではない |
| Evidence 100％ | hold | edge の束縛だけ：hold（9 variant、検査 107 sample、検査できず 163）。残りは not-evaluable |
| 禁止寄与 0 | fail | (a) 禁止 Scene・blocked 候補：fail（違反 30 sample）、(b) 遅れた Graph：pass（違反 0 sample）。(c) は not-evaluable |

## variant ごと

| variant | 改善 | macro（Δrecall／ΔnDCG） | edge の束縛 | 禁止 (a) | 禁止 (b) | 表示（first／follow／なし） | p95 ms R+IR／Graph（開示） |
|---|---|---|---|---|---|---|---|
| G-01/v1 | hold | hold（-／-） | hold | pass | pass | 0／0／30 | 22.0／55.0 |
| G-02/base | n/a | hold（-／-） | pass | pass | pass | 0／24／6 | 132.7／96.2 |
| G-03/base | n/a | hold（-／-） | hold | pass | pass | 0／0／30 | 19.1／177.2 |
| G-03/frontier-exceeded | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 204.7／60.7 |
| G-04/base | n/a | pass（0.500／0.497） | pass | pass | pass | 0／30／0 | 19.0／59.9 |
| G-05/base | n/a | pass（0.000／0.000） | pass | pass | pass | 0／23／7 | 16.6／174.6 |
| G-06/base | n/a | hold（-／-） | hold | pass | pass | 0／0／30 | 20.7／223.7 |
| G-07/base | n/a | pass（1.000／0.500） | pass | pass | pass | 0／30／0 | 17.9／181.4 |
| G-08/base-usable | n/a | hold（-／-） | hold | pass | pass | 0／0／30 | 149.0／55.3 |
| G-08/graph-index-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 18.7／167.3 |
| G-08/graph-recovered | n/a | hold（-／-） | hold | pass | pass | 0／0／30 | 184.7／48.2 |
| G-08/chronicle-index-unusable | n/a | pass（0.000／0.000） | n/a | fail | pass | 0／0／0 | 21.2／22.2 |
| G-08/both-indexes-unusable | n/a | pass（0.000／0.000） | n/a | pass | pass | 0／0／0 | 24.9／21.9 |

## not-evaluable の一覧

- macro-non-regression / existing-24-graph-arm：no-graph-arm-receipt-for-the-existing-24-queries
- evidence-validity / utf16-range：not-in-the-receipt
- evidence-validity / explicit-pin-association：not-in-the-receipt
- evidence-validity / raw-excerpt-unchanged：not-in-the-receipt
- evidence-validity / added-scene-body-anchor：not-in-the-receipt
- forbidden-contribution / c-existing-24-graph-appearance-and-dto：not-in-the-receipt

blocked の判定：ledger。p95 の上限は手順のファイル v2 の B と上限（K6/5。B=54.2、D=40。B は D から逆算しない）の 94.2 ms、百分位 0.95、許容誤差 1e-12。
