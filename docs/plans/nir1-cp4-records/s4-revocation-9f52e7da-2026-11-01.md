# 旧 S4b'（9f52e7da）の失効と、S4b''（557e683c）の運用条件の記録（2026-11-01）

**ユーザーの確認ではない**。integrator（Claude）の運用記録。ユーザーの確認は `user-confirmation-2026-10-31-trace-refreeze.md`（`8913f127`）と `user-confirmation-2026-10-31-measure-locally.md`（`68180464`）。通知は `user-notification-2026-11-01.md`（`a5654a95`、訂正 `acc5ec71`）。前回の失効の記録は `s4-revocation-2026-10-31.md`。

## 1. 失効

- 旧 S4b' `9f52e7da37b84603424d0b7e6ecee8e019d1c7c9`（観測前の freeze record の SHA-256 `fccb6c12…`）は、2026-11-01 に**失効**した。理由は、その下で取った ⑤ の (b) trace が、harness の trace の記録の経路の不備（DR-CP4-V-2〜V-4。`traces-s5r3-1/README.md`、`51874b1a`）で 2 件とも受領書 invalid になったこと。ユーザーは「直して S4 を凍結し直し、全部やり直す」を確認した。
- 新しい観測前の commit（S4b''）：`557e683ccd884955e220f21bd15119f115995d29`（枝 `claude/cp4-s4-refreeze3c`、PR #770。freeze record は同じ path `evals/nir1-graph/observation-prep-freeze.v1.json`、SHA-256 `b915ba91…`、S2 の SHA-256 `8c710b53…`）。失効の commit は `44a32e00`、S2 追補 #10 は `b22ac2b3`（訂正 `6cb7e05c`）、S4a'' は `f7a42789`。PR は **`gh pr merge --merge`** で入れる（squash は不可）。
- 同じ S4 の作り直しで、途中の枝 `claude/cp4-s4-refreeze3`（S4b'' `c6839a6f`）と `claude/cp4-s4-refreeze3b`（S4b'' `2c3a8473`）は使わない。理由はそれぞれ、S2 の limits (2) の「決めた人」の帰属の誤り（独立レビューの P2-1）と、limits (1) の stderr の記述の誤り（integrator の誤記を実物で訂正）。どちらも未 push・未 merge で、監査のために枝だけ残る。

## 2. 旧 S4b'／旧 S4b の下で取った試行（すべて開示に残し、S6 の集計と S7 の判定に入れない）

| S4 | 試行（台帳） | 状態 | 記録 |
|---|---|---|---|
| 旧 S4b `b7d74950` | `sp-p4-1` | passed（候補 `5ce12211`） | `sp-p4-1/` |
| 旧 S4b `b7d74950` | `parity-1` | incomplete-blocked | `parity-1/` |
| 旧 S4b' `9f52e7da` | `sp-p4-s5r-1`（候補 `94bb9b83`） | measured-stopped（C2、G-03/base 7/30） | `1d42959e` |
| 旧 S4b' | `sp-p4-s5r2-1`（候補 `ed8e3fb9`） | measured-stopped（C2、G-06/base 7/30） | `bf9c9260` |
| 旧 S4b' | `sp-p4-s5r3-1`（候補 `0b1984dd`） | completed、SP-P4 passed、IR 期限切れ 0/480 | `9e269c39` |
| 旧 S4b' | `parity-s5r3-1` | completed（12 variant measured・valid） | `62472d4c` |
| 旧 S4b' | `gold-s5r3-1` | completed（13 variant measured・valid） | `7c6d00ee` |
| 旧 S4b' | `neg-n2／n3／n4-s5r3-1` | completed、3 件とも established | `254d86ce` |
| 旧 S4b' | `trace-editing-s5r3-1`、`trace-browsing-s5r3-1` | completed、受領書は invalid | `51874b1a` |

- 旧 S4b' の下では、凍結した G-case の Graph arm を含む run（Gold・負例・trace）が走った。新しい freeze record の `graphRuntimeObservedBeforeFreeze: false` は、契約（`scripts/quality/nir1-retrieval/contract.mjs`）が固定する形の値で、字義と事実が合わない。S2 の limits (3)、作者の宣言、DR-CP4-S4-6 に開示した。**S7 の報告でも必ず書く**。
- 旧 S4b' の下の gold・負例の観測（graph arm の measured 390 件：`stamp0-missing` 329・`graph-late` 302 ほか）は、新しい S4 の結果の選択に使わない。

## 3. 運用条件（DR-CP4-S4-6 と同じ）

1. 正式の run（④ SP-P4、⑤ trace・parity・Gold・negative）は `--prep-commit 557e683ccd884955e220f21bd15119f115995d29`（S4b''）と、失効の commit `44a32e00` を祖先に持つ候補（merge commit で master に入った後の commit）だけで行う。
2. `s4Commit` が `b7d74950` または `9f52e7da` の試行・受領書は、S6 の集計と S7 の判定に**入れない**。S6 の集計を作るときは `selectReceiptsForAggregation` に、`s4Commit` を S4b'' だけに限る**許可リスト**を結線する（拒否リストだけに頼らない）。
3. 試行の台帳（`.artifacts/cp4/attempts/`）の key は S4 の commit を含むので、S4b'' の下の SP-P4 の試行の上限（2）は数え直しになる（ユーザーの「全部やり直す」の確認の範囲）。旧 `sp-p4-s5r3-1` の passed を流用しない。
4. ⑤ の正式の run（parity・Gold・negative）は `--keep-test-worktree <候補の worktree>` を必須とする。trace は `--procedure-version v1 --procedure-commit <S4b''>` を明示してもよい（`parseArgs` は直したが、明示しても同じ値）。測定の順は SP-P4 → trace（editing、browsing）→ parity → Gold → negative（N2、N3、N4）。
5. gate の候補は S4b'' の**子**にする（S4b'' を HEAD にすると落ちる `admission.test.mjs` の P1-1 の 1 件は既知。DR-CP4-S4-3 P3-4）。master に merge commit で入れた後は、HEAD が merge commit なので落ちない。
6. K6/4 の検出力の記録（`k64-synthetic-detection-record.md`）は、`followup.mjs` を変えたので**新しい候補では無効**。候補が決まった後に、その候補で取り直す（S2 には pin されておらず、S2 の pin には響かない。X12 `cancelled-before-begin` は番号を付けない補足の行）。SP の検出力の記録（`sp-synthetic-detection-record.md`、`2d33e6a8`）は有効のまま（取り直しの規則に挙がった file は変わっていない）。
7. 残る穴（運用で閉じる）：旧 S4b' と、失効の commit を含まない候補（例：`0b1984dd`、`a02c9c98`）の組は、admission を今も通る（実際に確かめた）。

## 4. 測定の場所

正式の測定はローカルの物理機で行う（`68180464`）。開始前に、ブラウザなどを控えるようユーザーへ伝える（約 80 分）。クラウドの事前確認の結果（時間の揺れがローカルより大きい等）は同じ記録にある。
