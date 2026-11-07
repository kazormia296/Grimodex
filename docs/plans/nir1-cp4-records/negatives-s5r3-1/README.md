# ⑤ 診断の負例 K24-G01-N2／N3／N4（新候補 `0b1984dd`、run `neg-n2-s5r3-1`／`neg-n3-s5r3-1`／`neg-n4-s5r3-1`）の記録

2026-10-31（UTC）に integrator が実行した、CP-4 の ⑤ の診断の負例（`--run-kind negative --negative <id>`、G-01/v1 だけ、`d2aMode: restricted`、arm は hybrid と graph）。④ SP-P4（`sp-p4-s5r3-1`、passed）、⑤ parity（`parity-s5r3-1`）、Gold（`gold-s5r3-1`）の後に、同じ候補・同じ S4b' で、N2 → N3 → N4 の順に取った。**診断であり、case の判定（pass、hold、blocked）に数えない**（`assessment.countsInCaseJudgement: false`、S2 の `diagnosticRule`）。

## 結果

3 件とも、台帳 `completed`、`G-01/v1` が `measured`・`valid: true`・`problems` 空、`validation` は `valid: true`（`errors` 空）、診断の評価（`run-report.json` の `variants["G-01/v1"].negative.assessment`）は **`outcome: "established"`**（`reasons` 空、`returnedIn` 空）。

| 診断 | mutation（宣言の後） | 期待（addendum） | 対照 | 評価 | 台帳（開始〜終了、UTC） |
|---|---|---|---|---|---|
| K24-G01-N2 | `resave-same-body` | g01-mira は R+IR+Graph に返らない（宣言は本文 Source の token の前進で失効する） | `reached`（2 回目の聞き直しで決まった） | established | 12:08:05Z〜12:09:21Z |
| K24-G01-N3 | `restore-same-bytes-body-version` | 同上（app の中の restore は宣言を消す） | `reached`（17 回目で決まった。上限 60 回、間隔 250 ms の範囲） | established | 12:09:44Z〜12:11:14Z |
| K24-G01-N4 | `restore-different-bytes-body-version` | 同上（restore は宣言を消し、本文も宣言の束縛と違う） | `reached`（2 回目の聞き直しで決まった） | established | 12:11:38Z〜12:12:58Z |

- 対照はどれも `graph-ready` で、Graph-only の行（`g01-mira` の Scene → pin の Entity、1 hop、edge `delivered-key-to`）が届いた。聞き直しの上限（60 回）と間隔（250 ms）は固定値のとおり（`assertG01RetryFixed`）。
- measured 30 件（各診断）の観測：親の Graph は `graph-late` 30、子（follow-up）は `graph-ready` 30、A3 は `eligible` 30、`snapshot.usable` 30、IR は `ir-ready` 30（期限切れ 0）。**返却された Scene に g01-mira が入った sample は 0 件**（親の最終 0／子の最終 0／Raw 0。3 診断とも）。
- 台帳の sha256（開始時は contracts に写した `0c888867`／`966c83d1`／`5726f54b` と同じ、終了後）：
  - N2 `a4653746bfbedad04507b617af180945692437085973c3e754a272dbec721003` → `1f134ffc1148aaf84a633668c175f9d99dd0f219ed303d552b99260d5acb5ae5`
  - N3 `d765bfae07cf3aa3a7401794d719de9aafb31ac0843482403b24f756b8e35235` → `50de38aec54e5a9d1ffd05c9056a1a9167a11030c722c0aae27bab584da7c892`
  - N4 `f7f638de3475a897e752aa65b8ba287fe2d88a52482202ee932ff717a97b8e83` → `191ec3f8bafada1d1d000693de28b50ec3377f1b66eb4547e898bf1a7d3dfe3b`
- 受領書と run-report の sha256 は `files.sha256`（`<run>.receipt.json`、`<run>.run-report.json`、`<run>.validation.json`）。N3 と N4 の受領書の `priorAttempts.negative` には、それ以前の negative の run が全件載っている。

## 条件

- 候補 `0b1984dd68ec132aea394664e2ba61759e1e2830`（tree `900ba98b…`、clean）、`--prep-commit 9f52e7da…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--keep-test-worktree` は候補の worktree、`--sp-p4-receipt` は `sp-p4-s5r3-1/sp-p4-receipt.json`。標準 build・評価 build・13 setup は `sp-p4-s5r3-1/README.md` のとおり（同じもの）。
- 機械：開始前に `wait-quiet.sh` が 3 回連続の静けさを確認し、3 件は続けて走らせた。ユーザーはブラウザを閉じていた。この run は窓の sampler を持たない。run の後に `/tmp/.X11-unix` は X0・X1 のみ、Xvfb の残りは無い。

## 次

- trace（`trace-editing.v1.json`、`trace-browsing.v1.json`）→ S6 の集計（`selectReceiptsForAggregation`、`s4Commit=b7d74950` の受領書を除く）→ S7。

## 訂正（2026-11-01、integrator）

- 「条件」の節の「この run は窓の sampler を持たない（持たず）」は誤りだった。この記録の受領書（このディレクトリの `*.receipt.json`）には窓の sampler の記録がある。窓の sampler（約 20 秒間隔）の記録が受領書の `environment.windowSamples` にあり、3 件（3 run）の `windowAssessment` は全件 `clean: true`（違反 0・欠け 0）。sample 12 件で `otherMeasurements` と `buildProcesses` は常に空、`sameWorktreeBuild` は 0 件、`heavySlotsInUse` の最大は 0、lock は常に読めた。1 分 load average の最大は 0.87（run 自身の Electron を含む）、CPU の PSI（some avg10）の最大は 0.15%。`environment.x11` は run の前後で X socket が増減していない（新しい entry 0 件）。旧 S4b' の下の記録で、S6 の集計と S7 の判定には入れない（`s4-revocation-9f52e7da-2026-11-01.md`）。
