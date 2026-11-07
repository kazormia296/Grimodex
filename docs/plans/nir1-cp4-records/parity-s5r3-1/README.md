# ⑤ parity（新候補 `0b1984dd`、run `parity-s5r3-1`）の記録

2026-10-31（UTC）に integrator が実行した、CP-4 の ⑤ の parity（`--run-kind parity`、`d2aMode: unrestricted`、arm は hybrid だけ＝R+IR）。**Graph の arm は動かしていない**（`graphEnabled: false`）。④ SP-P4 の `sp-p4-s5r3-1`（passed）の後に、同じ候補・同じ S4b' で取った。

## 結果

- **台帳 `attempts/parity-s5r3-1.json`: status `completed`**。開始 2026-10-31T11:19:42Z、終了 11:26:59Z（command は 11:19:39Z〜11:26:59Z）。`run-report.json` の `problems` は空。
- 12 variant（G-02/base、G-03/base、G-03/frontier-exceeded、G-04/base、G-05/base、G-06/base、G-07/base、G-08/{base-usable、graph-index-unusable、graph-recovered、chronicle-index-unusable、both-indexes-unusable}）がすべて `measured`・`valid: true`・`errors` 空・verdict `recorded`。各 35 sample（warm-up 5、measured 30）、`graphSampleCount` 0、`requeryCount` 0。G-01 は parity の対象外（`parityVariantKeys`）。
- **前回の parity-1（旧 S4b `b7d74950`、候補 `5ce12211`、`incomplete-blocked`）で blocked だった G-08/graph-index-unusable も、今回は測れた**（再凍結の T-3：Freshness の settle で解消）。blocked の variant は無い。
- IR の outcome（measured 360 件）: `ir-ready` 300 件（10 variant × 30）、`index-unavailable` 60 件（G-08/chronicle-index-unusable と G-08/both-indexes-unusable の各 30 件。この 2 variant は Chronicle の Index が使えない構成なので期待どおり）。**IR の期限切れ（`timeout`）は 0 件**。warm-up を含む全 sample の `status` は `completed`。
- 台帳の sha256: 開始時 `5fee346700b8b0f7e5956d90849432b2738c670222c8d0734d3a920c3a03b72b`（contracts の `acfc76cc`）、終了後 `571b249746cc0c190a5f863f444c710c700d4f39ae490c3d98a247f5cbc94560`。`run-report.json` の sha256 `307f0e56f7f4876e97f3b37a89d00c5537d4816b3eaa6c002e11a8ca365f9281`。variant ごとの受領書の sha256 は `receipts.sha256`（受領書と validation は `<variant>.receipt.json`／`<variant>.validation.json` で、`validation` はすべて `valid: true`、`errors` 空）。

## 条件

- 候補 `0b1984dd68ec132aea394664e2ba61759e1e2830`（tree `900ba98bd43b38fb668df1f557276b789d3ed13b`、clean）、`--prep-commit 9f52e7da37b84603424d0b7e6ecee8e019d1c7c9`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--keep-test-worktree` は候補の worktree。標準 build の受領書・評価 build・13 setup の受領書は `sp-p4-s5r3-1/README.md` のとおり（同じもの）。
- 機械：開始前に `wait-quiet.sh` が 3 回連続の静けさを確認し、ユーザーはブラウザを閉じていた。この run は窓の sampler を持たず、測定中の他の process の記録は無い。run の後に `/tmp/.X11-unix` は X0・X1 のみ、Xvfb の残りは無い。
- これは「この候補と S4 commit の完了した parity」の 1 回目。`selectParity` は完了した parity が 2 つ以上あると Gold の比較対象を選ばず `[precheck]` で止まるので、**この候補では parity をもう取らない**。

## 次

- Gold（`--run-kind gold`、13 variant、`--keep-test-worktree` 必須、`--sp-p4-receipt` に `sp-p4-s5r3-1/sp-p4-receipt.json`）。G-03 frontier／G-04／G-07 の Gold は L-27 で `started without a usable snapshot` により無効になりうる（Gold の試行を見込む）。

## 訂正（2026-11-01、integrator）

- 「条件」の節の「この run は窓の sampler を持たない（持たず）」は誤りだった。この記録の受領書（このディレクトリの `*.receipt.json`）には窓の sampler の記録がある。窓の sampler（約 20 秒間隔）の記録が受領書の `environment.windowSamples` にあり、12 件（12 variant）の `windowAssessment` は全件 `clean: true`（違反 0・欠け 0）。sample 40 件で `otherMeasurements` と `buildProcesses` は常に空、`sameWorktreeBuild` は 0 件、`heavySlotsInUse` の最大は 0、lock は常に読めた。1 分 load average の最大は 2.76（run 自身の Electron を含む）、CPU の PSI（some avg10）の最大は 0.6%。`environment.x11` は run の前後で X socket が増減していない（新しい entry 0 件）。旧 S4b' の下の記録で、S6 の集計と S7 の判定には入れない（`s4-revocation-9f52e7da-2026-11-01.md`）。
