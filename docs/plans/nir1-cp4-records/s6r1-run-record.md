# CP-4 Graph 正式 run（s6r1）の実施記録（2026-11-07。run と receipt の記録まで。S6 の集計・S7 の報告は含まない）

## 束縛

| 項目 | 値 |
|---|---|
| 契約 K6/5 の凍結 | commit `07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f`、SHA-256 `1ad1088498e43dc3cd0deb1b7d74f18396eb3c07d4bd3834a8787de30ecd24a7`（`nir1-final-request-eval-proposal/5#graph-eval-procedure`。D＝40 ms、Hybrid p95 上限 94.2 ms、T_late 100 ms）。受領書の `head.k65` と一致 |
| 契約 K6/4 の凍結 | commit `5dea38af158283c2a925d68ef0d8b0771c0ea209`、SHA-256 `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`（K6/5-N3。受領書の `head.k64` と一致） |
| S4（6 回目） | S4b `63bc9b903d5b7dbba3533ea32da9bdd7fe649861`、freeze record の SHA-256 `315d611382c5a563f93ffbe6d40d65c52057e9eeaa0a13ee550c2712a8cc6b12`（PR #827 を merge commit で取り込んだ master `a2309b95`） |
| 候補 | master `a2309b953873063b97b58942d42fa34d1bfbfc95`（C1＝#824 を含む）。許可リストは `(s4Commit, candidate.commit)` の組。worktree は clean な detach（`cp4-formal-k65`） |
| K6/2 の凍結 | `af643a93eeae7f937c9cd5a9dd87a6308c96fab6` |
| R5 の記録 | 前回の `56d4ec54`（ユーザーの確認 `6b47c177`・`0600ec04`）を使用。取り直していない |
| 手順の正本 | S2 `observation-prep.v1.json`（frozen）、手順のファイル v2、runner `scripts/quality/nir1-graph-eval/`、DR-CP4-S4-9。前回（s5r6）の runbook の run 名・S4・候補の sha を替え、`--k65-commit` を足し、trace の `--procedure-version v1` を外して使用（既定は v2・prep commit） |

製品・harness・S2・Gold・fixture・閾値は変えていない。Electron は `scripts/local-ci-xvfb.mjs`（Wayland・D-Bus・proxy の変数を除く）で動かし、`unshare -n` は使っていない。

## 走らせた run（UTC。所要は台帳の startedAt〜finishedAt）

| 順 | run ID | 結果 | 開始〜終了 | 所要 |
|---|---|---|---|---|
| ④ | `sp-p4-s6r1-1` | completed。SP-P4 passed（8 variant すべて差 0、problems なし） | 11:11:41〜11:13:40 | 2.0 分 |
| ⑤ | `trace-editing-s6r1-1` | completed、受領書 valid | 11:14:32〜11:25:26 | 10.9 分 |
| ⑤ | `trace-browsing-s6r1-1` | completed、受領書 valid | 11:25:47〜11:29:36 | 3.8 分 |
| ⑤ | `parity-s6r1-1` | completed。12 variant すべて validation valid、problems なし | 11:30:50〜11:38:09 | 7.3 分 |
| ⑤ | `gold-s6r1-1` | completed。13 variant すべて validation valid、problems なし | 11:39:03〜12:19:36 | 40.5 分 |
| ⑤ | `neg-n2-s6r1-1` | completed。G-01/v1 measured・valid（70 sample）、verdict は recorded | 12:20:30〜12:22:50 | 2.3 分 |
| ⑤ | `neg-n3-s6r1-1` | 同上 | 12:23:14〜12:25:34 | 2.3 分 |
| ⑤ | `neg-n4-s6r1-1` | 同上 | 12:25:58〜12:28:23 | 2.4 分 |
| 診断 | `g01-e2e-s6r1-1`（`pubg16-e2e-run.mjs --mode g01-frozen`、purpose `g01-e2e-diagnostic`、判定に数えない。Gold・parity と別 session） | exit 0。**reachedEndToEnd＝true、firstMissing＝null**。lease 証拠は continue（Graph-only）・click（keep_click）・requery cached・requery continue available・used settle がすべて true。quietAtStart＝true、sessionProblems なし | 12:28:50〜12:29:33 | 約 1 分 |

順は S2 の順（④ → trace×2 → parity → Gold → negative×3）で、診断 run は最後。各 run の前に静けさ（連続 3 回）を確認した。台帳（`attempts/`）の開始時の状態は run の開始直後に push 済み（DR-CP4-N-14 (5)）、終了時の状態は `attempts-final-s6r1/`。

## 準備（測定の窓の外）

- 標準 build 10:16〜10:22、評価 build 10:22〜10:27（exit 0）。13 の G-case の setup（G-01/v1、G-02/base、G-03/base・frontier-exceeded、G-04〜G-07/base、G-08 の base-usable・graph-index-unusable・graph-recovered・chronicle-index-unusable・both-indexes-unusable）は setup-complete。
- **setup の再実行（開示）**：G-05/base の setup は 2 回、`setup-with-problems`（`X11 entries present before changed or vanished`：1 回目 X3、2 回目 X99）で止まった。原因は同じ session の別 lane（chat の IR の pilot の抽出。`extract-all.sh` と `xvfb-run` の Electron）が、setup の最中に別の Xvfb を起動・終了したこと。測定ではなく setup の段で、pilot の終了を待った後に 3 回目で setup-complete になった。失敗した 2 回の receipt は worktree の `.artifacts/cp4/abandoned/` に退避（`s6r1-g-05-base-x3-pilot-xvfb`、`s6r1-g-05-base-x99-pilot-xvfb-try2`。contracts には含めない）。以後の setup（G-05〜G-08）は再実行の run 名が同じ `s6r1-…`。G-01〜G-04 の setup は 1 回で通った。
- 待ち時間：pilot・Electron の終了を待った合計は約 24 分（setup の前 781 秒、再実行の前 361 秒＋345 秒）。3 時間の上限には届いていない。測定の窓（11:05〜12:30）の間、build・試験・他の Electron は走らせていない（chain の静けさの確認は、本来の D3 の判定に加えて pilot・Xvfb・electron の process も見た）。

## 置き場

`setups-s6r1/`（eval-build、setups、standard-build の受領書、13 setup receipt の SHA-256）、`sp-p4-s6r1-1/`、`traces-s6r1-1/`、`parity-s6r1-1/`、`gold-s6r1-1/`、`negatives-s6r1-1/`、`g01-e2e-s6r1-1/`、`attempts-final-s6r1/`。各 dir に `files.sha256`。本文・secret の値は写していない。
