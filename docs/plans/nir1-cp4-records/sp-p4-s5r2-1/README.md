# ④ SP-P4 の診断（再凍結後の試行 2、run `sp-p4-s5r2-1`）の記録

2026-10-31（UTC）に integrator が実行した、CP-4 の ④ SP-P4 の取り直し（事前登録の 2 回目）。ユーザーが「同じ上限で取り直す」を確認した（`user-confirmation-2026-10-31-sp-p4-retake.md`、`7398dd6a`）。**Graph の arm は動かしていない**。

## 結果

- **status: incomplete（`[precheck]` で停止）**。停止の理由（`stop`）: 「S5-B stable: G-06/base:with-seed-pin-step: 7 of 30 measured samples lost the IR to the deadline, more than 6 (DR-CP4-Q-1 C2); the comparison is not defined」。
- 比べられた variant: G-01/v1、G-02/base、G-03/base、G-04/base、G-05/base はすべて `same: true`、差異 0。G-06/base は without 側が 6 件（上限ちょうど）、with 側が 7 件で上限を超え、比較が定義されず、G-07/base と G-08/base-usable は測っていない。
- **SP-N7 でも passed でもない**。1 回目（`sp-p4-s5r-1`）と同じ種類の停止（C2 の側ごとの上限）。**取り直しは事前登録の 2 回までなので、3 回目は始めていない**。ユーザーに返す（確認の範囲どおり）。
- 台帳 `attempts/sp-p4-s5r2-1.json`: 開始時の sha256 `85645f936a17e53fc65ec89c58a69ee0b13e6f970377ee34c3626291e63c3a01`（contracts の `00e754ee`）、終了後 `9083e2a026dfd8f688e4e0584ed6cca4d556b07780cd1857296625713d44f684`（status `measured-stopped`。候補が違うので key は別で、台帳の file では attempt 1）。
- 実行: command 開始 2026-10-31T05:02:43Z、台帳の開始 05:15:00Z（分岐の setup の後）、終了 05:16:27Z。受領書 `sp-p4-receipt.json` の sha256 `922fef68e8fac63683657b41591a6533542f85de7ab649dd3d0bcc598fe830eb`。

## 候補と規則

- 候補: `ed8e3fb96efede940995e03cfc135f8e2180e6c0`（master の squash 〔#764、DR-CP4-U-1〕。tree `dc91b81cbcfba4f5c98e0465be2102ca9dfbfdf2`、clean）。**1 回目の候補 `94bb9b83` との差は `docs/plans/nir1-lane-decisions/cp4-decisions.md` の 1 行の追加だけ**（`git diff --stat 94bb9b83 ed8e3fb9`）。S4b' `9f52e7da` の admission は同じ記録で通る（`collectObservationPrepFacts`、`readAdmittedObservationPrep` で確認）。
- 標準 build と評価 build は候補で作り直した（標準 build の受領書 sha256 `626cb3179fb1b635aed2a0df1a757773e966efa4eaaa0a50fecaca396082a403`、評価 build の `eval-build.json` の sha256 `9bd00d34471f9c2caf74ababe571da00951aefd710476e93bfdb4e2c0c90d517`、sourceUnchanged true）。13 の完全な setup（run 名 `s5r2-*`）は 13/13 `setup-complete`、maintenance はすべて一度で届いた（`setup-receipts.sha256`）。
- 比較の規則・上限・warm-up・measured は 1 回目と同じ（`ir-complete-pairs`、側ごとの 6、組の 6、warm-up 5、measured 30）。

## IR の期限切れ（3 つの run の比較）

measured 30 件のうち、IR が期限切れで外れた数。`-` は without 側、`+` は with 側。

| run | G-01 | G-02 | G-03 | G-04 | G-05 | G-06 | G-07 | G-08 usable |
|---|---|---|---|---|---|---|---|---|
| `sp-p4-1`（旧 S4b、候補 `5ce12211`、passed） | 0, 1 | 0, 1 | 1, 2 | **5**, 0 | 0, 0 | 0, **5** | 0, 0 | 0, 0 |
| `sp-p4-s5r-1`（試行 1、`94bb9b83`、停止） | 1, 0 | 1, 1 | **7**, 未測定 | 未測定 | 未測定 | 未測定 | 未測定 | 未測定 |
| `sp-p4-s5r2-1`（試行 2、`ed8e3fb9`、停止） | 0, 0 | 1, 0 | 1, 2 | 2, 2 | 1, 0 | **6, 7** | 未測定 | 未測定 |

- 3 つの run の測定済みの側は 33、measured は 990 件、期限切れは 47 件（4.7%）。上限 6 を超えた側は 2 つ（試行 1 の G-03 without、試行 2 の G-06 with）で、ほかに 5 件が 3 側、6 件が 1 側ある。
- **独立な事象（二項分布、率 4.7%）と見ると、1 つの側が 7 件以上になる確率は約 0.04%、16 の側のどこかで上限を超える確率は約 0.7% で、観測（2/33 の側）と合わない**。期限切れは**群れて**起きている（過分散）。試行 2 の G-06 with 側は measured の 20〜23 番が連続し（15、20、21、22、23、26、28 番）、warm-up にも 2 件（1、3 番）ある。試行 1 の G-03 without 側は 2、4、9、15、16、24、27 番で、群れは弱い。
- 期限切れの sample はすべて `outcome: timeout`、`deadlineExceeded: true`、`resultKind: raw`（C1 の条件の形）。R の membership と順位、denseHits、sparse は、比べられたすべての variant で一致した。**seed の pin の段の影響は、比べられた範囲では観測されていない**。
- sample に IR の待ち時間は記録されていない（outcome と deadlineExceeded だけ）。群れの原因（機械の負荷、同じ機械の他の process、製品側の maintenance や DB 接続の競合〔L-27: Verify が約 250 ms ごとに CONNECTION_PREEMPTED〕）は、この記録からは区別できない。

## 同じ機械の他の process

- 試行 2 の開始前、ユーザーの `claude-overlay-p1` で vitest が動いていた（D3 の分類は test）。`wait-quiet.sh` が止まるのを待ち、3 回連続の静けさを確かめてから 05:02:43Z に始めた。同じ `claude-overlay-p1` の `electron:dev`（D3 の分類では測定でも build/test でもない）は測定の間も動いていた。測定の間に他の process が起動したかは、この run が窓の sampler を持たないため記録がない（G-06 の群れの時刻と照合できない）。
