# ④ SP-P4 の診断（S4b''・候補 `86427ee5` での試行 1、run `sp-p4-s5r4-1`）の記録

2026-11-01（UTC）に integrator が実行した、CP-4 の ④ SP-P4。S4 は再凍結後の S4b''（`557e683c`）、候補は S4 の再凍結を master に入れた merge commit の `86427ee5`（#770）。**Graph の arm は動かしていない**。台帳の key が (S4b'', `86427ee5`) の新しい組なので、これは**試行 1**（旧 S4b' の下の `sp-p4-s5r3-1` の passed は流用していない。`s4-revocation-9f52e7da-2026-11-01.md` の運用条件 3）。

## 結果

- **status: passed**（`summary.id` SP-P4、`stop: null`、`problems: []`）。比べた 8 variant（G-01/v1、G-02/base、G-03/base、G-04/base、G-05/base、G-06/base、G-07/base、G-08/base-usable）はすべて `same: true`、差異 0。
- 比較の規則・上限・warm-up・measured は前の回までと同じ（`ir-complete-pairs`、側ごとの上限 6、組の上限 6、warm-up 5、measured 30、`attemptLimit` 2、`d2aMode` restricted、`compareBy` logical-id）。S2・S4b''・harness・上限・D は変えていない。8 variant × 2 側 = 16 の attempt はいずれも 1 回で valid（再試行なし）。
- **IR の期限切れは measured 480 件のうち 2 件**（G-04/base の without 側と with 側の各 1 件、どちらも measured の repeat 2。側ごとの上限 6 の範囲内）。measured の残り 478 件は `ir-ready`。warm-up は 80 件のうち 1 件（G-06/base の with 側 repeat 0。warm-up は比べない）。受領書の `stability.irTimeoutExcluded` は G-04/base が 1・1、ほかの 14 側は 0。
- 受領書 `sp-p4-receipt.json` の sha256 `abda45863b9cefd1ec68f49ca7c5bd14413c85fd6460d3d993411ee152575dcd`。

## 台帳と実行

- 台帳 `attempts/sp-p4-s5r4-1.json`: key `sp-p4:557e683ccd884955e220f21bd15119f115995d29:86427ee53a73e669e34631c5774fbd56960ac050`、`attempt: 1`、status `completed`。開始時の sha256 `c499a5acd34574064ed2c778d0309597b2da8db78ed7e5ed9ed2477e37bd33cb`（contracts の `c5b65498`）、終了後 `ec6c5163894b6953d96d1d985cb2a4c72949ad7b633103113635d0b02aac362b`。
- 実行: command 開始 2026-11-01T00:11:23Z（`wait-quiet.sh 3` の静けさの確認の後）、台帳の開始 00:17:26Z、終了 00:19:21Z。

## 候補と準備

- 候補: `86427ee53a73e669e34631c5774fbd56960ac050`（master の merge commit。tree `5ed0204d363c52659dcd072d46ef5c693be0722c`、clean）。master の Full（run `41227253989`、headSha 一致）は success（2026-10-31T18:00:28Z〜18:38:23Z）。
- 標準 build の受領書 sha256 `4ddad0e29cb3d01e284bd4f2fc9a5a75539a2f6f49b51b20a24ec0fe02d32e8e`、評価 build の `eval-build.json` の sha256 `344180689d2cfa3e41c1e4722a90e29952936975bd2c2ade2949fe7559a3ca95`（`status: passed`、`sourceUnchanged: true`）。13 の完全な setup（run 名 `s5r4-*`、2026-10-31T18:07:47Z〜18:18:35Z）は 13/13 `setup-complete`。setup は測定の約 6 時間前に作った（測定の直前ではない）。受領書の sha256 は `setup-receipts.sha256`（SP-P4 が使う 8 variant 分）。

## IR の期限切れ（旧候補の run との比較）

measured 30 件のうち IR が期限切れで外れた数。`-` は without 側、`+` は with 側。

| run | G-01 | G-02 | G-03 | G-04 | G-05 | G-06 | G-07 | G-08 usable |
|---|---|---|---|---|---|---|---|---|
| `sp-p4-s5r3-1`（旧 S4b'、候補 `0b1984dd`、passed） | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| **`sp-p4-s5r4-1`（S4b''、候補 `86427ee5`、passed）** | 0, 0 | 0, 0 | 0, 0 | **1, 1** | 0, 0 | 0, 0 | 0, 0 | 0, 0 |

- `0b1984dd` から `86427ee5` への差（`git diff --name-only`）に、`src-tauri/`・`electron/`・`package.json`・lock の file は無い（Rust と native の IR の経路は同じ）。差は、renderer の UI（`src/features/{layout,chat,editor,matrix,…}`、`src/components/ui/`、`src/locales/`、`src/index.css`、`src/lib/animation.ts`。overlay・menu 系の別の PR）、`scripts/check-performance-budgets.mjs`、`scripts/quality/nir1-graph/observation-prep.mjs`（と test）、harness（`scripts/quality/nir1-graph-eval/**`）、`evals/nir1-graph/**`、docs。renderer の UI の差は SP-P4 の renderer build にも入っているが、IR の期限切れへの影響は測っていない。2 件は上限（6）の範囲内で、C2 には触れていない。
- G-04/base の 2 件が同じ repeat（2）に並んだのは、側の測定が repeat ごとに隣り合うためで、短い一時的な停止の可能性がある。**原因は調べていない**（測定中の process の記録は無い）。判定には影響しない。
- R の membership と順位、denseHits、sparse は、全 variant の全 sample で比べて一致した。
- 測定の間の他の process：この run は窓の sampler を持たない。開始前の `wait-quiet.sh 3` は静けさを確認した（load average 0.01、CPU の PSI 0）。host の I/O 圧力は HDD のため常に高い（some avg10 約 93%）。測定中に integrator は待機のみ（until ループの sleep 15 秒）で、ユーザーには約 80 分のブラウザ等の抑制を依頼済み。

## 次

- ⑤ trace（editing → browsing、`trace-editing-s5r4-1`、`trace-browsing-s5r4-1`、`--procedure-version v1 --procedure-commit 557e683c…`）→ parity → Gold（`--sp-p4-receipt` にこの受領書）→ negative（K24-G01-N2／N3／N4）。
