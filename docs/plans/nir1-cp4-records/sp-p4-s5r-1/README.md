# ④ SP-P4 の診断（再凍結後の試行 1、run `sp-p4-s5r-1`）の記録

2026-10-31（UTC）に integrator が実行した、CP-4 の ④ SP-P4 の診断。再凍結後の S4b'（`9f52e7da37b84603424d0b7e6ecee8e019d1c7c9`）と、新しい S5 の候補（`94bb9b83384c911b827673f72e527fe880ac3261`、tree `1887601bd241fcbe1671e82dbbc0e0372483101e`、clean）での最初の実行。**Graph の arm は動かしていない**。

## 結果

- **status: incomplete（`[precheck]` で停止）**。停止の理由（`stop`）: 「S5-B stable: G-03/base:without-seed-pin-step: 7 of 30 measured samples lost the IR to the deadline, more than 6 (DR-CP4-Q-1 C2); the comparison is not defined」。
- 比べられた variant は G-01/v1 と G-02/base だけで、どちらも `same: true`、差異 0。G-03/base は without 側の測定が上限（側ごとの 6）を超え、比較が定義されず、残りの variant（G-03 の with 側〜G-08）は測っていない。
- **これは SP-N7 ではない**（段の前後の R／R+IR の違いは観測していない）。passed にも数えない。S2 の規則（`diagnosticRuns[SP-P4].comparisonRule` (4)）は、この停止を「SP-N7 にも passed にも数えず、integrator がユーザーに返す」とする。
- 台帳 `attempts/sp-p4-s5r-1.json`: 開始時の sha256 `0c6bb04b69ae9968a72b62f7b05735039cd4aa27a39481a622b696affd17551e`（contracts の `d89413d7`）、終了後 `4aea09cdeae2e2af40cc595f02f63d408d5aa3801a41081245e3cb64457cef8e`（status **`measured-stopped`**、attempt 1、key `sp-p4:9f52e7da…:94bb9b83…`）。この key の SP-P4 は、台帳（`frozenAttemptLedger`）の規則で、run 名を変えても**もう始められない**（同じ identity の 2 回目は `[precheck]`）。
- 実行: command 開始 2026-10-31T04:00:33Z、台帳の開始 04:08:50Z（分岐の setup の後）、終了 04:09:32Z。

## IR の期限切れ（今回と前回 `sp-p4-1` の比較。前回は S4b `b7d74950`・候補 `5ce12211` で passed）

measured 30 件のうち、IR が期限切れで外れた数（without / with）:

| variant | 今回 | 前回 |
|---|---|---|
| G-01/v1 | 1 / 0 | 0 / 1 |
| G-02/base | 1 / 1 | 0 / 1 |
| G-03/base | **7** / （未測定） | 1 / 2 |
| G-04/base | （未測定） | 5 / 0 |
| G-06/base | （未測定） | 0 / 5 |

- 今回の 7 は warm-up の 1 件を含まない。期限切れの sample はすべて `outcome: timeout`、`deadlineExceeded: true`、`resultKind: raw`（C1 の条件の形）。
- 期限切れの率は dev の観測（2/35＝約 6%）と前回（約 5%）に対し、今回の G-03 without 側は 23%。**原因は確定していない**（IR の deadline は製品側の時間で、機械の負荷と相関しうる。測定の間、ユーザーの `claude-overlay-p1` の `electron:dev` が同じ機械で動いていた。harness の D3 の分類〔`window.mjs classifyProcess`〕は build／test／他の測定とみなさず、窓の違反は出ていない）。

## 同じ run の他の記録

- 台帳以外の file: `sp-p4-receipt.json`（sha256 `f126468b9fd73bd826d799330c3ded327bd52aa11ca69494317623df8a3ee85a`）、`run-report.json`、`head.json`。
- 候補の setup（13 variant の完全な setup、run 名 `s5r-*`）は 13/13 `setup-complete`。G-05/base の author session だけ最初の maintenance 試行が canonical cutover marker に届かず（180 s）、harness の開き直しで 2 回目に届いた（製品側の before-cutover の連鎖の既知の揺れ、P-5。受領書の `maintenanceAttempts` に開示）。
