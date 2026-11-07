# ⑤ parity（S4b''・候補 `86427ee5`、run `parity-s5r4-1`）の記録

2026-11-01（UTC）に integrator が実行した、CP-4 の ⑤ の parity（`--run-kind parity`、`d2aMode: unrestricted`、arm は hybrid だけ＝R+IR）。**Graph の arm は動かしていない**（全 sample で `graphEnabled: false`）。④ SP-P4 の `sp-p4-s5r4-1`（passed）と ⑤ trace の後に、同じ候補・同じ S4b''（`557e683c`）で取った。

## 結果

- **台帳 `attempts/parity-s5r4-1.json`：status `completed`**（attempt 1）。開始 2026-11-01T00:42:48Z、終了 00:50:11Z（command は 00:42:44Z〜00:50:11Z）。`run-report.json` の `problems` は空。
- 12 variant（G-02/base、G-03/base、G-03/frontier-exceeded、G-04/base、G-05/base、G-06/base、G-07/base、G-08/{base-usable、graph-index-unusable、graph-recovered、chronicle-index-unusable、both-indexes-unusable}）がすべて `measured`・`valid: true`・`blocked`／`error` なし。各 35 sample（warm-up 5、measured 30）、`validation.json` は 12 件とも `{"valid": true, "errors": []}`。
- IR の outcome（measured 360 件）：`ir-ready` 300 件（10 variant × 30）、`index-unavailable` 60 件（G-08/chronicle-index-unusable と G-08/both-indexes-unusable の各 30 件。この 2 variant は Chronicle の Index が使えない構成なので期待どおり）。**IR の期限切れ（`timeout`）は measured で 0 件**。warm-up（60 件）には `timeout` が 2 件（G-04/base と G-07/base に各 1 件。warm-up は比べない）。全 sample の `status` は `completed`。
- 台帳の sha256：開始時 `309ed0b107e69a3ad4b61d9d98c5c9aa73d4e7b63a1c338c5cd86c6d41de47a2`（contracts の `6d01e3cc`）、終了後 `84802f8513e68b1085ca620061b131c2b8b2dfe8192978e1359aead2b55c8778`。`run-report.json` の sha256 `ac320f3f83bd98b086c80b1566e21519da1a59e5ac2bece504548303bdeb6277`。variant ごとの受領書・validation の sha256 は `files.sha256`。

## 条件

- 候補 `86427ee53a73e669e34631c5774fbd56960ac050`（tree `5ed0204d363c52659dcd072d46ef5c693be0722c`、clean）、`--prep-commit 557e683c…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--keep-test-worktree` は候補の worktree。標準 build の受領書・評価 build・13 setup の受領書は `sp-p4-s5r4-1/README.md` と同じ（`setups.json` は台帳に 13 の sha256 として記録）。
- 機械：開始前に `wait-quiet.sh 3` が 3 回連続の静けさを確認した。窓の sampler（約 20 秒間隔）の記録が受領書の `environment.windowSamples` にあり、12 件（12 variant）の `windowAssessment` は全件 `clean: true`（違反 0・欠け 0）。sample 41 件で `otherMeasurements` と `buildProcesses` は常に空、`sameWorktreeBuild` は 0 件、`heavySlotsInUse` の最大は 0、lock は常に読めた。1 分 load average の最大は 3.11（run 自身の Electron を含む）、CPU の PSI（some avg10）の最大は 0.52%。`environment.x11` は run の前後で X socket が増減していない（新しい entry 0 件）。（run の後の Xvfb・electron の残りの確認は、negative の後に行った。`negatives-s5r4-1/README.md`。）
- これは「この候補と S4 commit の完了した parity」の 1 回目。`selectParity` は完了した parity が 2 つ以上あると Gold の比較対象を選ばず `[precheck]` で止まるので、**この候補では parity をもう取らない**。

## 次

- Gold（`--run-kind gold`、13 variant、`--keep-test-worktree` 必須、`--sp-p4-receipt` に `sp-p4-s5r4-1/sp-p4-receipt.json`）→ negative（K24-G01-N2／N3／N4）。
