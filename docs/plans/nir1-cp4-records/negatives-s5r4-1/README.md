# ⑤ 診断の負例 K24-G01-N2／N3／N4（S4b''・候補 `86427ee5`、run `neg-n2-s5r4-1`／`neg-n3-s5r4-1`／`neg-n4-s5r4-1`）の記録

2026-11-01（UTC）に integrator が実行した、CP-4 の ⑤ の診断の負例（`--run-kind negative --negative <id>`、G-01/v1 だけ、`d2aMode: restricted`、arm は hybrid と graph）。④ SP-P4（`sp-p4-s5r4-1`、passed）、⑤ trace、parity（`parity-s5r4-1`）、Gold（`gold-s5r4-1`）の後に、同じ候補・同じ S4b'' で、N2 → N3 → N4 の順に取った。**診断であり、case の判定（pass、hold、blocked）に数えない**（`assessment.countsInCaseJudgement: false`）。

## 結果

3 件とも、台帳 `completed`（attempt 1）、`G-01/v1` が `measured`・`valid: true`・`problems` 空、`validation` は `valid: true`（`errors` 空）、診断の評価（`run-report.json` の `variants["G-01/v1"].negative.assessment`）は **`outcome: "established"`**（`reasons` 空、`returnedIn` 空）。

| 診断 | mutation（宣言の後） | 対照 | 評価 | 台帳（開始〜終了、UTC） |
|---|---|---|---|---|
| K24-G01-N2 | `resave-same-body` | `reached`（`decidedAt` 0） | established | 01:27:03Z〜01:28:17Z |
| K24-G01-N3 | `restore-same-bytes-body-version` | `reached`（`decidedAt` 22。上限 60 回、間隔 250 ms の範囲） | established | 01:28:40Z〜01:30:16Z |
| K24-G01-N4 | `restore-different-bytes-body-version` | `reached`（`decidedAt` 0） | established | 01:30:40Z〜01:31:58Z |

- 対照はどれも `status: completed`・`graphOutcome: graph-ready` で、Graph-only の行（`g01-mira` の Scene → pin の Entity、1 hop、edge `delivered-key-to`）が届いた。聞き直しの上限（60 回）と間隔（250 ms）は固定値のとおり。
- measured 30 件（各診断）の観測：親の Graph は `graph-late` 30、A3 は `eligible` 30、`snapshot.usable` 30、IR は `ir-ready` 30（期限切れ 0）。**返却された Scene は 30 件とも `g01-question` だけで、g01-mira が入った sample は 0 件**（3 診断とも。`negative.samples[].returnedSceneIds`、`assessment.returnedIn` 空）。
- 台帳の sha256（開始時は contracts に写した `00582b71`／`896f73ff`／`88a38f18` と同じ → 終了後）：
  - N2 `074d11105f7cfe16af722863c3be5ee6075c09d71258efb79a0d354033e5301c` → `f1dcd79d03996d0141a850d0bc3114de88b07c1224138f5c3bbfa999558cfc50`
  - N3 `2adba90e1e6ad6d5f4cff2cd5e6f6816b20fe3972244a848808bf1f0d4baa741` → `0357c2320737b527e08d1479abafcd35ec7183e1e6245bd55a9bba64b5aa1d9b`
  - N4 `35b977ecc033018fc6d325a651f1e106b6fcd9f932492c1060f29516e1dfbfd9` → `3a2c410c47e13675e6e3ed5f40045ff44eeabee7c5bacc4b85814f3c665e2d01`
- 受領書と run-report の sha256 は `files.sha256`（`<run>.receipt.json`、`<run>.run-report.json`、`<run>.validation.json`）。N3 と N4 の受領書の `priorAttempts.negative` には、それ以前の negative の run が全件載っている。

## 条件

- 候補 `86427ee53a73e669e34631c5774fbd56960ac050`（tree `5ed0204d363c52659dcd072d46ef5c693be0722c`、clean）、`--prep-commit 557e683c…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--keep-test-worktree` は候補の worktree、`--sp-p4-receipt` は `sp-p4-s5r4-1/sp-p4-receipt.json`。標準 build・評価 build・13 setup は `sp-p4-s5r4-1/README.md` のとおり（同じもの）。
- 機械：開始前に `wait-quiet.sh 3` が 3 回連続の静けさを確認した（Gold の終了の約 1 分後）。N3・N4 は前の run の約 20 秒後に続けて開始した（個別の検査は無い）。窓の sampler（約 20 秒間隔）の記録が受領書の `environment.windowSamples` にあり、3 件（3 run）の `windowAssessment` は全件 `clean: true`（違反 0・欠け 0）。sample 12 件で `otherMeasurements` と `buildProcesses` は常に空、`sameWorktreeBuild` は 0 件、`heavySlotsInUse` の最大は 0、lock は常に読めた。1 分 load average の最大は 1.4（run 自身の Electron を含む）、CPU の PSI（some avg10）の最大は 0.24%。`environment.x11` は run の前後で X socket が増減していない（新しい entry 0 件）。
- 後始末（negative の後）：`/tmp/.X11-unix` は X0・X1 のみ、Xvfb と electron（ユーザーの `claude-overlay-p1` を除く）の残りは無かった。trace・parity・Gold の後の個別の確認は、続けて次の run を始めたため行っていない（この確認が最初）。

## 次

- S6 の集計（`selectReceiptsForAggregation` に `s4Commit` を S4b'' だけに限る許可リストを結線し、旧 S4b `b7d74950` と旧 S4b' `9f52e7da` の試行を除く）→ S7。
