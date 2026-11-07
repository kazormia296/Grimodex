# S7 報告：CP-4 の Graph arm の評価（S4b''・候補 `86427ee5`）

2026-11-01（UTC）の integrator の報告。測定の記録は同じ `nir1-cp4-records/` の `sp-p4-s5r4-1/`、`traces-s5r4-1/`、`parity-s5r4-1/`、`gold-s5r4-1/`、`negatives-s5r4-1/`、集計は `s6-aggregation-s5r4/`。

## 1. 結論

**CP-4 の Graph arm は、可用性を満たしたと主張しない（HOLD）**。事前登録の物差し（1%）を超えた理由は独立に 2 つ。

1. **編集中の trace の失効率が 99.5%（200/201）**。すべて (i) B の封印（B の index が dirty のまま作り直されない）。事前登録は、この失効率が物差しを超えることを測る前に確定した構造として示しており（承認の失効）、規則どおり `[precheck]` でユーザーの判断に回る。
2. **定常状態（Gold）の pool の欠落率が 11.1%（270 件中 30 件。許容は 2 件）**。欠落 30 件はすべて **G-04/base の 30/30**（X5。子の Graph は `graph-ready` だが辺が 0 件で `expectedContribution` が false のため、寄与の空の Graph〔F6〕として表示に数えられない）。G-04/base は fixture の前提条件 `raw-membership` が成り立たない variant（上の (B)）。残り 8 variant は 240/240 が表示された。

## 2. 測ったもの（すべて S4b''、候補 `86427ee5`、attempt 1、台帳 completed）

| 工程 | run | 結果 |
|---|---|---|
| ④ SP-P4 | `sp-p4-s5r4-1` | passed。8 variant 差異 0、IR の期限切れ measured 480 件中 2 件（上限 6） |
| ⑤ trace（編集） | `trace-editing-s5r4-1` | 受領書 valid。Q=201、U=1、失効 200（99.5%） |
| ⑤ trace（閲覧） | `trace-browsing-s5r4-1` | 受領書 valid。Q=201、U=201、失効 0。K6/4 の読みで表示 201/201 |
| ⑤ parity | `parity-s5r4-1` | completed。12 variant valid、IR の期限切れ 0 |
| ⑤ Gold | `gold-s5r4-1` | completed。13 variant valid、L-27 の無効化なし。graph arm の measured 390 件は `graph-late` 302、`graph-unavailable` 88、`stamp0-missing` 330 |
| ⑤ negative | `neg-n2／n3／n4-s5r4-1` | 3 件とも established（対照 reached、g01-mira は 0/30）。診断で判定に数えない |

旧 S4b／旧 S4b' の下の run は、集計と判定に入れていない。

## 3. ユーザーに決めてほしいこと

**(A) 編集中の失効（事前登録済みの選択肢。`graph-eval-procedure` の「選択肢と推奨（承認の失効が支配的な場合）」）**

| 案 | 内容 |
|---|---|
| 1（事前登録の推奨） | 失効は確定した構造（編集中は書込みごとに承認済みの Revision が失効する）と受け入れる。受け入れるなら、失効率を「開示のみ」にした新しい draftRef で確認する（閾値の緩和にあたるので、あなたの確認が要る）。それまで HOLD のまま |
| 2 | 失効の範囲を、対象 Scene と材料に関係する書込みに絞る。編集中の可用性は上がるが、`scope-storage-authority` の改訂と実装が要り、PUB-G が遅れる |
| 3 | HOLD のまま。PUB-G、PUB-L、E が止まる |

補足：今回の編集 trace では、失効の原因が (i) B の封印（B の index が dirty のまま）で、「承認の失効」とは限らない。B が作り直されない理由は未調査（prep Main の stderr に `discovery failed … context-unavailable` が 3 件。DR-BSEAM-5 は別 lane への報告で未確認）。製品側の不具合なら、案 1〜3 の前に直す余地がある。

**(B) G-04/base の欠落（原因の読み取り調査が済んだ。`s6-aggregation-s5r4/g04-base-diagnosis.md`）**

G-04/base は、fixture が宣言した前提条件 `raw-membership`（観測した R が `arms.raw` と一致）と `ir-supplement-admission` が観測で成り立っていない variant だった（期待の Raw は 1 件、実測は 2 件。期待された `g04-lio-landing` が R+IR に入らない）。fixture の README の規則では `blocked:raw-membership` で、期待値は評価せず、PASS に数えない。K6/4 の可用性の pool は blocked を扱わず、30/30 欠落と数えている。**製品の Graph の欠陥でも、harness の期待寄与の誤りでもない**（subagent の報告。受領書の R／R+IR の構成は integrator が確認。Graph DTO と IR の score は未確認）。現行の規則のままでは HOLD。変えるには、どちらもあなたの確認が要る。

| 案 | 内容 |
|---|---|
| α | README の blocked の規則を可用性の pool にも及ぼし、G-04/base を pool から外す（記録上は `blocked:raw-membership`）。結果を見た後に pool を変える緩和で、K6/4 の In-scope attacks の 5・10 に当たりうる |
| β | G-04 の fixture の新しい版（Raw の予測と IR の改訂、独立期待値レビュー、再凍結、測定のやり直し） |
| 現状 | 何も変えず、可用性は HOLD のまま |

どちらでも、閾値 1% と F6・X5 の定義は変えない前提。

## 4. 規則の読みと分析（S6 の記録 `s6-aggregation-s5r4/README.md`）

- 判定の規則：「条件が成立しない場合の CP-4 の可用性」。(a) の欠落率、(b) の窓外率、(b) の失効率のどれかが 1% を超えたら HOLD。失効率が基準を満たさない trace が 1 つでもあれば `[precheck]`。K6/4 の読み替え（表示の可用性）は、候補が D′・RS-JOIN の hook・W_f を含むときだけ当たる。
- **trace の読み**：受領書に記録された trace の要約は K6/2 の読み。trace-runner が keep test を走らせず、RS-JOIN の hook の証拠が「祖先」だけ（`c7b091da` は squash で祖先でない）になったため。候補は 3 要件を満たす（Gold は同じ keep test の証拠で k64）ので、integrator が keep test つきの証拠で観測済みの query を再計算し、K6/4 の読みを別に載せた（測定のやり直しではない。基準の再現は受領書と完全に一致）。**結論の HOLD は、どちらの読みでも変わらない**。K6/2 の読みでは、閲覧も窓外 201/201（100%）。K6/4 の読みでは、閲覧は表示 201/201、欠落 0。
- `selectReceiptsForAggregation` は trace の受領書 2 件を `runner-is-not-the-k64-hook-consumer` で除く（受領書全体の `runnerKind` が無いため）。`receipt.mjs` は S2 に pin 済みなので変えていない。

## 5. 開示（必須）

1. **`graphRuntimeObservedBeforeFreeze: false` は契約が固定した形の値で、字義と事実が合わない**。freeze record（`557e683c`）の `graphRuntimeObservedBeforeFreeze` は `scripts/quality/nir1-retrieval/contract.mjs:473` が固定する値で、実際には、旧 S4b'（`9f52e7da`）の下で Graph arm（Gold・負例・trace）が走っていた。S2 の limits (3)、作者の宣言、DR-CP4-S4-6 に開示した。今回の判定は S4b'' の下の run だけに基づく。旧 S4b'／旧 S4b の下の観測は判定に入れていない。ただし、同じ候補系で Graph arm を先に見たうえで harness を直し、S4 を再凍結した事実は残る（旧 S4b' の Gold は今回の Gold と同じ傾向：`graph-late` 302、`graph-unavailable` 88、G-04/base 30/30 欠落）。
2. **S4 の凍結は 3 回**（S4b `b7d74950`、S4b' `9f52e7da`、S4b'' `557e683c`）。S4b'' は、旧 S4b' の下の trace が harness の trace の経路の不備で 2 件とも受領書 invalid になったため、あなたの確認「直して凍結し直し、全部やり直す」（2026-10-31）の下で作り直した。
3. **あなたの確認の範囲より広い integrator の技術判断**（DR-CP4-V-2〜V-4、`user-notification-2026-11-01.md`）：取り消された counted parent の扱い（V-3。厳しい側の読み。read-only の advisor に諮った）、cycle end の後の fetch を子にしない（V-4。advisor に諮った）、quote の平文の拒否の guard、窓の外の末尾の Native 記録の除外と独立の時計の同期、F-6 の resolver の配線、`parseArgs` の既定（advisor には諮っていない）。閾値・期待値・Gold・Q と U の定義は変えていない。
4. **測定の場所**：あなたの確認「ローカルで測る」（2026-10-31）。クラウドの事前確認で、クラウドはローカルより時間の揺れが大きいと分かった（`user-confirmation-2026-10-31-measure-locally.md`）。
5. **測定の開始の遅れ**：Full の成功（18:38Z）と準備の完了（18:18Z）の後、integrator が開始の操作をしないまま止まっており、あなたの「始まった？」で 00:11Z に始まった。測定の結果には影響しないが、準備（build と 13 setup）は測定の約 6 時間前に作ったもの。
6. **窓の sampler**：Gold・parity・negative は記録があり全件 clean。SP-P4 と trace は sampler の記録を持たない（trace の `windowAssessment: clean` は sample を入力にしていない）。以前の記録にあった「Gold・parity・negative は窓の sampler を持たない」は誤りで、訂正した（contracts `86372344`）。
7. **editing の開始時の封印の違い**：B の generation は前回（旧 S4b'）は 1 のまま、今回は 1→2。prep Main の `discovery failed` の文言も違う（前回は Chronicle 3 件、今回は editing が Entity/Relation 2 件と Chronicle 1 件、browsing が Entity/Relation 3 件）。原因は調べていない。
8. **K6/4 の検出力の記録**：候補 `86427ee5` で取り直し済み（601 件 pass。contracts `aba74aab`）。

## 6. 次

- (A) の案の選択（あなたの判断）。(B) の読み取り調査（integrator）。
- S6 の分析の判断の DR を `cp4-decisions.md` に記録する PR（docs だけ）。
- PUB-G の前提の別 lane（before-cutover の連鎖〔P-5〕、preempt された maintenance の再送の backoff〔P-6〕、終了中の recovery、DR-BSEAM-5、DR-JF-8、journeys 8077 の flake）と、worktree の片付け（`git status --ignored` の後）。
