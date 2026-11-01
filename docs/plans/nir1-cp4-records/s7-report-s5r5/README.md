# S7 報告：CP-4 の Graph arm の評価（S4b'''・候補 `22b74a25`）

2026-11-02（JST）の integrator の報告。測定の記録は同じ `nir1-cp4-records/` の `sp-p4-s5r5-1/`、`traces-s5r5-1/`、`parity-s5r5-1/`、`gold-s5r5-1/`、`negatives-s5r5-1/`、`attempts-final-s5r5/`、`setups-s5r5/`、集計は `s6-aggregation-s5r5/`。前回の報告は `s7-report-s5r4/`（S4b''・候補 `86427ee5`）。

## 1. 結論

**CP-4 の Graph arm は、可用性を満たしたと主張しない（HOLD）。理由は 1 つに減った：編集中の trace の失効率が物差し 1% を超える**（K6/2 の読み 8/201＝3.98%、K6/4 の読み 15/201＝7.46%）。規則どおり `[precheck]` でユーザーの判断に回る。

前回（S4b''）の理由は 2 つだった（編集の失効 99.5%、Gold の pool の欠落 11.1%）。今回：
1. **編集の失効は 200 件から 8 件（K6/2 の読み）に減った**。開始時の B の封印は 201 件すべて `current`（前回は 200 件が dirty）。X1-5 の効果。残る 8 件はすべて **begin の前に製品が取り消した counted parent**（DR-CP4-V-3 の厳しい側の読み。測定の前に決めた規則）で、B の seal が原因ではない。K6/4 の読みでは、follow-up の失効（親の登録不可 3、child の合流の無効化 4）も加わって 15 件。
2. **Gold の pool の欠落は 0 件（270 件中）**。G-04/base（v2）が 30/30 表示された。**ただし G-04 v2 は観測の後に作り直した版で、v1 の欠落が解消したのではない**（5 の 1）。

## 2. 測ったもの（すべて S4b'''、候補 `22b74a25`、attempt 1）

| 工程 | run | 結果 |
|---|---|---|
| ④ SP-P4 | `sp-p4-s5r5-1` | completed、passed。8 variant 差異 0、IR の期限切れ（除外）0 件（上限 6） |
| ⑤ trace（編集） | `trace-editing-s5r5-1` | completed、受領書 valid。Q=201、U=193、失効 8（K6/2）／15（K6/4 の再計算）。開始時の封印 201/201 current |
| ⑤ trace（閲覧） | `trace-browsing-s5r5-1` | completed、受領書 valid。Q=U=201、失効 0。K6/4 の読みで表示 201/201 |
| ⑤ parity | `parity-s5r5-1` | completed。12 variant valid |
| ⑤ Gold | `gold-s5r5-1` | completed。13 variant valid。pool 270 件で表示 270、欠落 0。G-04/base は 30/30 が `[g04-control, g04-lio-landing]` |
| ⑤ negative | `neg-n3-s5r5-1` | completed、measured・valid |
| ⑤ negative | `neg-n2-s5r5-1`、`neg-n4-s5r5-1` | **stopped（blocked:b-seal-not-published）**。診断で判定に数えないが、記録が揃わない（3 の B） |

旧 S4b／S4b'／S4b'' の下の run は、集計と判定に入れていない。

## 3. ユーザーに決めてほしいこと

**(A) 編集中の失効（`[precheck]`）**

事実：失効の原因は、前回の「B が dirty のまま」ではなくなった。残る 8 件（K6/2 の読み）は begin の前の取消し、K6/4 の読みの 15 件は、それに follow-up の失効 7 件が加わる。

| 案 | 内容 |
|---|---|
| 1 | 事前登録どおり HOLD を受け入れる。残る失効（begin の前の取消し、follow-up の親の登録不可・child の合流の無効化）を、次の改善の対象として別 lane で設計する（X1-5 と同じ型。PUB-G は止まる） |
| 2 | 失効の読みを変える（begin の前の取消しを数えない、など）。**結果を見た後の読みの変更は閾値の緩和にあたるので、あなたの明示の判断が要る**。参考（概算）：begin の前の取消し 8 件を Q から除くと、K6/2 の読みの失効は 0 件になるが、K6/4 の読みでは follow-up の失効 7 件（193 件中 約 3.6%）が残り、なお物差しを超える |
| 3 | HOLD のまま。PUB-G、PUB-L、E が止まる |

**(B) negative N2／N4 の blocked（harness の欠陥。X1-5 との衝突）**

N2（同じ本文の保存し直し）と N4（下書きの保存と復元）は、変異のあと B の**新しい** sealed generation を待つ。X1-5 は本文だけの保存で B を dirty にしないので、B は generation 1・dirty false のままで、新しい seal は来ない（N2 は 3 回の再 open、各 120 秒待ちで同じ）。N3 は影響を受けず valid。診断で判定に数えない。

| 案 | 内容 |
|---|---|
| a | N2／N4 は blocked のまま記録する（X1-5 により負例の前提が成り立たなくなった、という測定の結果として S7 に載せる）。G-01 の本文の開示の無効化の負例は N3 だけが established |
| b | harness を直す（B が clean で generation が変わらないことを sealed と認める）。DR-CP4-S4-6 により、harness の欠陥による観測の後の再凍結は**改めてユーザーの確認が要る**。5 回目の S4（失効、S2 追補、S4a、S4b、PR）と全 run のやり直しになる（S4 の commit が台帳の key に入るため） |

## 4. 規則の読みと分析（S6 の記録 `s6-aggregation-s5r5/README.md`）

前回の S7 の 4 と同じ（trace の記録は K6/2 の読み、K6/4 の読みへ再計算を別に載せる）。

## 5. 開示（必須）

1. **G-04 は観測の後に作り直した版（v2、案 C）**：S4b'' の下の run の結果（IR が採らない、rv-match が相対救済で入る）を知った後に構成を選んだ。IR に依存せず、Graph が Graph-only の Scene を 1 件足す形で、IR の recall の根拠にならない。失った検査：G-04-P2（IR が枠を使った後は Graph が足さない）と G-04 での path 付加の検査。IR補完済みの区分は G-05 だけが支える。pool への影響：v1 では pool の欠落 30 件の唯一の原因だった。**v1 の結果と v2 の結果を並べる**（ユーザー確認済み）：v1（S4b''）は G-04/base が `blocked:raw-membership` で 30/30 欠落（X5。辺 0 件、期待寄与 false）、v2（S4b'''）は 30/30 表示。「失敗した case を外した」のではなく「作り直した」。
2. **`graphRuntimeObservedBeforeFreeze: false` は契約が固定した形の値で、字義と事実が合わない**（freeze record の値。旧 S4b'／S4b''／今回 S4b''' の下で Graph arm が走っていた）。S2 の limits、作者の宣言、DR に開示済み。
3. **S4 の凍結は 4 回**（S4b `b7d74950`、S4b' `9f52e7da`、S4b'' `557e683c`、S4b''' `60bf9dc4`）。4 回目は G-04 v2 の導入のため（ユーザーの確認 `user-confirmation-2026-11-01-g04-v2c-build.md`）。
4. **K6/4 の R5 の順からの逸脱**：① R5 の照合の取り直し（13 variant）を K6/4 の凍結（`5dea38af`）の後に行った。K6/4 の本文 `:196`（太字）・`:279`・`:292`・`:302` が「R5 は凍結の前」を定める。当初の根拠「:317 は提案節」は不完全だった（最終関門の指摘）。実質（R5 の match の後にだけ判定を始める）は満たし、字義は批准 9 により (β) でしか満たせない。**ユーザーが認めた**（`user-confirmation-2026-11-02-k64-r5-order.md`、contracts `665abc0f`）。
5. **trace 2 file は v1 のまま**：S2 の `onFixtureRevision` の文（「trace の新しい版」）と食い違う。K6/2 手順 4（:702）が上位。S2 の limits に開示済み。
6. **contracts の枝は merge していない**：S2 の `s4StagesRule` (a) の「①・②' の記録を S4b の祖先にする」を満たさない。contracts の commit は hash と sha256 で引用する。**S6／S7 の前に contracts の 3 commit の file の sha256 を再照合した（2026-11-02）**：SP-N の記録 `20ccd115` は `aef7c0a1…`（S2 の値と一致）、① の記録 `56d4ec54` の `r5-check-record.json` は `fa04baa4…`（一致）、S4 の前のレビュー `e42e9990` の `review-s4pre.md` は `de0ccae2…`（宣言の addendum v2 の値と一致）。3 commit とも contracts の枝の先頭の祖先。この枝は、この作業の全体を通して force push をしておらず（すべて通常の push。非 fast-forward は GitHub が拒否する）、reflog にも forced update は無い。
7. 取り直した記録：SP-N の合成の検出（contracts `20ccd115`。変異の道具は前の版の scratchpad が失われていたので、表の置換から作り直した）、① R5 の照合（`56d4ec54`、13 variant 全件 match、`--verify` 済み）。
8. **3 つの手順の規則の判断**（DR-CP4-V-3／V-4、B2b-1 の (ii) など）は前回までの報告に同じ。
9. **測定の場所**：ローカルの物理機（ユーザーの確認 `user-confirmation-2026-10-31-measure-locally.md`）。ユーザーは測定の開始の時点で、静かなマシンを前提にしていた。測定の開始は、ユーザーの確認（8 の K6/4 の R5 の順）を得た直後。
10. **窓の sampler**：Gold・parity・negative は記録があり全件 clean。SP-P4 と trace は sampler の記録を持たない。
11. **K6/4 の検出力の記録**：候補 `22b74a25` では、規則の 5 file が `86427ee5..HEAD` で変わっていないので有効（S4b の前のレビューの確認）。運用条件で、候補が決まった後に取り直す予定だったものは**まだ取り直していない**（取り直しが要るかをユーザーと決める）。

## 6. 次

- (A) の案の選択と、(B) の案の選択（あなたの判断）。
- S6／S7 の判断の DR を `cp4-decisions.md` に記録する PR（docs だけ。DR-CP4-S6-2 として）。
- PUB-G の前提の別 lane（before-cutover の連鎖〔P-5〕、preempt された maintenance の再送の backoff〔P-6〕、終了中の recovery、DR-BSEAM-5、DR-JF-8、journeys 8077 の flake）、worktree の片付け（`git status --ignored` の後。`claude-g04-cand` の `.artifacts/cp4/` など）。
