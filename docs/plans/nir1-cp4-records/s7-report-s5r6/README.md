# S7 報告：CP-4 の Graph arm の評価（S4b''''・候補 `cbf33077`）

2026-11-03（JST）の integrator の報告。測定の記録は同じ `nir1-cp4-records/` の `sp-p4-s5r6-1/`、`traces-s5r6-1/`、`parity-s5r6-1/`、`gold-s5r6-1/`、`negatives-s5r6-1/`、`attempts-final-s5r6/`、`setups-s5r6/`、集計は `s6-aggregation-s5r6/`。前回の報告は `s7-report-s5r5/`（S4b'''・候補 `22b74a25`。HOLD）。ユーザーの確認は `user-confirmation-2026-11-03-formal-remeasure-start.md`（`d9c3da87`）ほか。

## 1. 結論

**事前登録の規則を当てた結果、物差しを超える指標は無く、「どれかが超えたら HOLD」の条件に当たらない。** 規則は、可用性を満たしたと主張することを妨げない。ただし、この主張には 5 の開示（特に K6/4 の読み、観測の後に直した製品と封印の規則、1 回の測定）が付く。前回の HOLD の理由（編集 trace の失効率と窓外率）は、今回は成立しなかった。

| 指標（K6/4 の読み。候補は 3 つの要件を満たす） | 前回（S4b'''・`22b74a25`） | 今回（S4b''''・`cbf33077`） | 物差し |
|---|---|---|---|
| (a) Gold の pool の欠落 | 0／270 | **0／270** | 2 件（floor(0.01×270)） |
| (b) 編集 trace の失効 | 15／201（7.46%。K6/2 の読みは 8） | **0／201（0%）** | 1% |
| (b) 編集 trace の窓外（表示の欠落） | 20／201（U 内 12／193） | **1／201（U 内 1）** | 2 件 |
| (b) 閲覧 trace の失効／欠落 | 0／0 | **0／0** | — |
| ④ SP-P4 | passed | **passed**（差異 0。IR の期限切れ 2／上限 6） | — |
| parity | 12 variant valid | 12 variant valid | — |
| 診断の負例（判定に数えない） | N3 のみ measured。N2・N4 は blocked | **N2・N3・N4 すべて measured・established** | — |

## 2. 測ったもの（すべて S4b''''、候補 `cbf3307739db9310e2e1d65d947a811591fd77f2`、attempt 1、台帳 completed）

| run | 種類 | 時間（UTC。台帳） |
|---|---|---|
| `sp-p4-s5r6-1` | ④ SP-P4 | 06:32〜06:34（約 2 分） |
| `trace-editing-s5r6-1` | ⑤ trace（編集） | 06:35〜06:45（約 10 分） |
| `trace-browsing-s5r6-1` | ⑤ trace（閲覧） | 06:45〜06:49（約 4 分） |
| `parity-s5r6-1` | ⑤ parity | 06:50〜06:57（約 7 分） |
| `gold-s5r6-1` | ⑤ Gold（13 variant） | 06:58〜07:32（約 34 分） |
| `neg-n2／n3／n4-s5r6-1` | ⑤ 診断の負例 | 07:33〜07:38（各約 1.5 分） |

準備（標準 build 約 3 分、評価 build 約 2 分、13 setup 約 14 分）は 06:06〜06:25。各 run の前に静けさを確認し、台帳の開始時の状態は contracts へ写した（`attempts/*-s5r6-1.json`）。K6/4 の検出力の記録は、候補が決まった後・run の前に取り直した（`k64-synthetic-detection-record.md`、contracts `887605c7`。611 件 pass、N1〜N40 の件数は前の版と同じ）。

## 3. ユーザーに決めてほしいこと

規則は HOLD を指さないので、前回のような `[precheck]` の停止ではない。ただし、次はユーザーの判断。

1. **この結果を、CP-4 の Graph arm の評価の結果として確定してよいか**（5 の開示つき）。integrator は確定を宣言しない。
2. **次の lane に進むか**。CP-4 の後に残っているもの（JA の sparse の実装、PUB-G の前提、融合の枠と Raw 偏重の見直し〔別 lane の議論〕など）。この報告は製品の公開（Graph の published 化）を何も決めない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
3. **5 の開示のうち、扱いを決めてほしいもの**：(a) 最終関門の P3（S2 の文面の古い記述）を次の S2 改版まで直さないこと、(b) 1 回の測定の結果をどこまで頼るか（同じ候補・同じ S4 の下の再 run は、台帳の規則〔attempt の上限〕が許す範囲にしか行えない）。

## 4. 規則の読みと分析（S6 の記録 `s6-aggregation-s5r6/README.md`）

- 許可リストは `(s4Commit, candidate)` の組 `(3734e501…, cbf33077…)`。旧 S4b'''・候補 `22b74a25` の run は集計に入れず、この S7 の比較の列に履歴として載せた（前回の S6 と S7 は `s6-aggregation-s5r5/`、`s7-report-s5r5/`）。
- 規則どおり、K6/4 の読み替え（表示の可用性。欠落の許容は floor(0.01×件数)）は、候補が D′・RS-JOIN の hook・W_f を含むときだけ当たる。今回の keep test つきの証拠は `regime: k64`、`notApplied: null`。trace の受領書は K6/2 の読みで記録され、同じ証拠で K6/4 の読みへ再計算した（測定のやり直しではない）。
- 閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読みは変えていない。

## 5. 開示（必須）

1. **観測の後に直した候補での、1 回の測定**。この測定は、前回の HOLD と N2／N4 の blocked を見た後に、製品（LP-A1 `8dd7a9c0`、LP-GATE `2014ac50`）と N2／N4 の封印の規則（DR-CP4-S4-8。案 A′）を直した候補で行った。閾値・期待値・Gold・読みは変えていない。各 run は attempt 1 で、取り直していない。1 回の測定なので、同じ候補での再現性は測っていない（dev の診断では gate を含む build で欠落が 1/603 だった〔dev 専用で CP-4 の結果ではない〕）。
2. **trace の読み**。受領書（K6/2 の読み）は、両 trace とも窓外 201／201（物差しを超える）と記録する。これは Graph の答えが first-render の窓の後に着く設計（`graph-late` 201）による K6/2 の読みの性質で、前回も同じだった。K6/4 の読みへの再計算は、前回と同じ integrator の技術判断。失効率は K6/2 の読みでも 0。
3. **editing の欠落 1 件**：理由は `freshness-stamp-stamp0-missing:clear`（X3 に分類）。どの query かは特定していない（未確認）。q1 の最大は 135.3 ms で `T_late`（100 ms）を超える query が 1 件あるが、同じ query かは未確認。許容は 2 件で、内側。
4. **LP-A1 と LP-GATE の寄与は分けられない**。受領書に LP-GATE の counter は無い。失効が 8→0 になったのは、両方を含む候補の結果。gate が動いた状態は、この測定が最初の正式の観測で、gate の寄与を単独で示すものではない。
5. **N2／N4 の封印の規則**：N2／N4 が blocked になったのを見た後に決めた（ユーザーが案 A′ を認めた。`ac2e93d6`）。本文だけの保存の地点（N2 の mutation、N4 の宣言前の保存）では Freshness の静止を待った後に世代不変も通す。restore の地点（N3、N4 の mutation）は緩めていない。世代不変の分岐の有効性は製品の X1-5 の分類に依り、「B が current」の意味が変わる。今回、N2 と N4 の宣言前の保存は世代不変（`unchanged`）で、N3 と N4 の restore は新しい世代で封印された。N2／N3／N4 は診断で、`countsInCaseJudgement: false`（判定に数えない）。
6. **「開き直しで宣言が失われる」限界**：負例の「`g01-mira` が出ない」は、本文の変更による宣言の失効と、開き直しだけで宣言が消える製品の欠陥とを区別できない（旧規則でも同じ）。ユーザーは限界として開示する扱いを選び、dev の確認（開き直しだけでは宣言は残る。contracts `d58a7cad`。dev fixture、2 run×3 sample、CP-4 に数えない）を許可した。
7. **G-04 v2 は観測の後に作った版**（v1 の欠落が解消した意味ではない）。G-04/base は、v1（S4b''・候補 `86427ee5`）では pool の欠落 30／30、v2 は前回・今回とも 30／30 表示。1% の判定が Graph に有利な向きに動きうる（S2 `g04RevisionReadings.limits (c)`）。
8. **S2 の字義と事実の食い違い**：`graphRuntimeObservedBeforeFreeze: false` は、旧 S4b'''・候補 `22b74a25` の下の run の分だけさらに広がる（作者の宣言に開示）。S4 の凍結は 5 回。
9. **最終関門の P3（PR #779 の本文にも書いた）**：(a) S2 `g04RevisionReadings.limits (i)` が K6/4 本文の :196・:279・:292・:302 と批准 9 を書いていない（`665abc0f` で訂正済み）、(b) 事前レビューの記録は S4b'''' の時点で scratchpad にあり、その後 contracts `f5d5cb16` に置いた、(c) S2 の `r5Gate.rule` ほかの前例から続く文面と `s4StagesRule (h)` の未来形は次の改版で直す、(d) freeze record の SHA-256 は全桁 `e240c99f3f85839819b3e33013ee612db1b0b119efaeab0057d85f7515980202`。
10. **SP-P4 の IR の期限切れ（除外）は 2 件**（上限 6。前回は 0）。
11. 窓の sampler：Gold・parity・negative は全件 clean（違反 0、隙間 0）。SP-P4 と trace は sampler の記録を持たない（設計）。
12. dev の診断 run・dev の予告・dev の確認は CP-4 の結果に数えていない。

## 6. 次

- ユーザーの返答を待つ（3）。
- DR-CP4-S6-3（この S6／S7 の技術判断の記録）と作業記録の 1 行は、docs だけの PR にする（前例 #775）。ユーザーの返答の後に push・PR・merge する。
- 後片付け：候補の worktree `claude-g04-cand`（`.artifacts/cp4/` に約 30 GB 超）、`claude-cp4-s4-5th`、`claude-master-verify`、`claude-cp4-lp-diag`（dev 専用で残す）は、`git status --ignored` を確かめてから。
