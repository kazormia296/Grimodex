# ユーザーの回答の記録：5 回目の S4 の後の正式な再測定の開始（2026-11-03）

5 回目の S4（PR #779、merge commit `cbf3307739db9310e2e1d65d947a811591fd77f2`。S4b'''' `3734e501`）が master に入った後に、integrator が出した確認（AskUserQuestion 1 問）への回答。前の確認は `user-confirmation-2026-11-03-remeasure-plan.md`（`c7f02c7e`、訂正 `68953a67`）と `user-confirmation-2026-11-03-s4-5th-design.md`（`ac2e93d6`）。前の確認は「正式の再測定の実行は S4 の後に別に確認する」としていた。

## 提示した事実

- 5 回目の S4 は merge commit で master に入った（`^1` が `a1cd6675`、`^2` が `5409d24b`）。本物の master で S4b'''' の admission が通ること（`assertObservationPrepAdmits`、`readAdmittedObservationPrep`、pin 34 個、G-01 は v3 の path で束縛）と、試験（`observation-prep.test.mjs` 85、nir1-graph 128、eval 611、eval-fixtures exit 0）を integrator が確かめた。
- 手順案：候補は master `cbf33077`（S4b'''' の子孫）。K6/4 の検出力の記録の取り直し（ユーザー回答済み）の後に、正式の run（SP-P4、trace 2 件、parity、Gold、negative 3 件。N2／N4 を含む）。台帳の key は（候補, S4b'''', run の種類）。S6 の許可リストは（S4, 候補）の組で絞り、旧 S4b'''・候補 `22b74a25` の run は集計に入れず S7 に履歴として並べる。約 1 時間強の見込み（前回の台帳より）。実行中はマシンを使えない。閾値・Gold・読みは変えず、物差しを超えても緩めずそのまま報告する。
- 未観測：Gold が悪くなる危険、gate（LP-GATE）が動いた状態の効果は、正式の run でしか見えない。

## 回答（AskUserQuestion。選択肢の原文）

| 問 | 回答 |
|---|---|
| 再測定 | **「今から始める (推奨)」** |

選択肢の他の 2 つは「時刻を指定して始める」「まだ始めない」だった。

- 日時：2026-11-03（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲（integrator の読み）

1. **正式の再測定の実行を認める**。範囲は、K6/4 の検出力の記録の取り直し、正式の run 8 件（④ SP-P4、⑤ trace×2・parity・Gold・negative×3）、S6 の集計と S7 の報告まで。候補は master `cbf33077`。
2. **変えないもの**：閾値、Gold、pool、δ、F6／X5、読み、契約、S4b''''（`3734e501`）。結果が物差しを超えても緩めず、そのまま報告する。HOLD のままなら、次の判断をユーザーに相談する。
3. **含まれないもの**：S4 の再凍結（6 回目）、製品コードの追加の修正（失効の残る隙間への対応など）、閾値・Gold・読みの変更、契約・authority の改訂、製品公開。これらが要る場合は、実装に入らず新しい確認に回す。
4. 実行中のマシンの静けさは、実行前に確認する（静けさの確認に通らなければ run を始めず、理由を報告して時刻を相談する）。
5. 台帳の上限（SP-P4 の試行 2 回など）は、既存の規則どおり。run が失敗した場合の取り直しは、規則が許す範囲に限る。許さない場合は止まって報告する。
