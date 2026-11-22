# CP-4 Graph 正式 run（s7r1）の実施記録（2026-11-09。run と receipt の記録まで。S6 の集計・S7 の報告は別）

## 束縛

| 項目 | 値 |
|---|---|
| 契約 K6/6 の凍結 | commit `56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d`、SHA-256 `58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7`（受領書の `head.k66` と一致。script が確認） |
| 契約 K6/5・K6/4・K6/2 | K6/5 `07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f`、K6/4 `5dea38af158283c2a925d68ef0d8b0771c0ea209`、K6/2 `af643a93eeae7f937c9cd5a9dd87a6308c96fab6` |
| S4（7 回目） | S4b `f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b`、freeze record の SHA-256 `5816c315d34130b6089a5a8d388ea3a84a376a577fb512aabf6f3a8628230548`、S2 の SHA-256 `67b78f8d…`（PR #840 を merge commit で取り込んだ master `3f333a83`） |
| 候補 | master `3f333a83554d4dba6c54417d500d3af6f0e985c5`（#840 の merge commit）。許可リストは `(s4Commit, candidate.commit)` の組。worktree は clean な detach（`cp4-formal-k66`）。master の Full 42503346040（`3f333a83`）は success |
| R5 の記録 | 前回の記録を使用。取り直していない |
| 手順の正本 | S2 `observation-prep.v1.json`（frozen）、runner `scripts/quality/nir1-graph-eval/`、手順書 `handoff/nir1-s7r1-runbook-20261109.md`（integrator の引き継ぎ file。contracts の外） |

製品・harness・S2・Gold・fixture・閾値は変えていない。Electron は `scripts/local-ci-xvfb.mjs`（Wayland・D-Bus・proxy の変数を除く）で動かし、`unshare -n` は使っていない。

## 走らせた run（UTC。所要は台帳の startedAt〜finishedAt）

| 順 | run ID | 結果 | 開始〜終了 | 所要 |
|---|---|---|---|---|
| ④ | `sp-p4-s7r1-1` | completed。SP-P4 passed（8 variant すべて差 0、IR の期限切れ 0） | 11-08 17:45:09〜17:46:56 | 1.8 分 |
| ⑤ | `trace-editing-s7r1-1` | completed、受領書 valid | 17:47:49〜17:58:21 | 10.5 分 |
| ⑤ | `trace-browsing-s7r1-1` | completed、受領書 valid | 17:59:13〜18:02:57 | 3.7 分 |
| ⑤ | `parity-s7r1-1` | completed。12 variant すべて valid、problems なし | 18:03:52〜18:11:03 | 7.2 分 |
| ⑤ | **`gold-s7r1-1`（1 回目）** | **stopped**。G-01/v1・G-02/base・G-03/base は measured・valid、4 番目の G-03/frontier-exceeded で `[precheck] V-10: the worker never reached READY`（`frozen-k64-run.mjs`、`OWNER_READY_WAIT_MS` 90 s）。3 variant のみ | 18:11:58〜18:19:27 | 7.5 分 |
| ⑤ | **`gold-s7r1-2`（取り直し）** | completed。13 variant すべて measured・valid、窓 clean、problems なし。13 receipt すべての `priorAttempts.gold` が `gold-s7r1-1` を開示 | 11-08 23:02:45〜23:49:40 | 46.9 分 |
| ⑤ | `neg-n2-s7r1-1` | completed。G-01/v1 measured・valid | 23:50:34〜23:52:54 | 2.3 分 |
| ⑤ | `neg-n3-s7r1-1` | 同上 | 23:53:48〜23:56:07 | 2.3 分 |
| ⑤ | `neg-n4-s7r1-1` | 同上 | 23:57:01〜23:59:27 | 2.4 分 |
| 診断 | `g01-e2e-s7r1-1`（purpose `g01-e2e-diagnostic`、判定に数えない。別 session） | exit 0。**reachedEndToEnd＝true、firstMissing＝null** | 11-09 00:00:17〜00:00:28 | 0.2 分 |

順は S2 の順（④ → trace×2 → parity → Gold → negative×3）で、診断 run は最後。各 run の前に静けさ（連続 3 回）を確認した。台帳の開始時の状態は run の開始直後に push 済み、終了時の状態は `attempts-final-s7r1/`。

## Gold を 2 回走らせた経緯（開示）

1. chain は 1 回目の Gold の停止（18:19:27Z）で最初の失敗として止まった（runbook §7：夜は取り直さず、止める。N2〜N4・G-01 診断は未実施）。
2. 記録 `ee468c48`（Gold の 3 variant、parity、trace、SP-P4、setups）を contracts に写した。**その commit message の「同じ variant は parity では通った」は READY の証拠にならない**（parity は Graph arm を測らない。`frozen-k64-run.mjs:1949`。`readyProbe` は :961-980 で Graph arm のときだけ）。その読みは取り消す。
3. 原因の調査（read-only）と、凍結外の dev fixture（`DEV-SHAPE-G03/frontier-exceeded`。凍結の材料の写しは K6/6 批准 9 により使わない）での再現を行った。dev では 2 回中 1 回、同じ停止（cold DB に `running` の dependency-verify が残る回：Verify の取消しが約 4.7 回/秒・完了 0、Graph の prepare が 5 回失敗して slot が `suspended`）が再現した。dev の結果は判定に数えない。記録は integrator の引き継ぎ file（`s7r1-dev-ready/`、`s7r1-fix-design/`。contracts の外）。
4. ユーザーが 2026-11-09 08:00:12 JST（= 11-08 23:00:12Z。session の記録の timestamp）に「同じ候補で Gold を 1 回だけ取り直し、並行して修正案を設計」を選んだ。chain を 08:02:11 JST に起動し、`gold-s7r1-2` は 23:02:45Z に開始した。**同じ候補・同じ setup（setup の sha256 は同じ）で、製品・harness・閾値・fixture は変えていない**。結果を見て選んだのではなく、1 回目は precheck 停止（測定の判定ではない）。2 回目は 13/13 completed。
5. **2 回目の Gold の判定外 variant `G-03/frontier-exceeded` で、同じ連鎖が起きていた**（Graph arm 35 sample のうち 30 が `registration-unavailable`、23 が `startSlot: suspended`。READY の probe は 1 回。前回 s6r1 は 35 sample すべて `graph-late`・slot empty）。期待は `unavailable: graph-limit-exceeded` で、表示 0 は期待どおりだが理由の種類が違う。pool の 9 variant の slot は全件 empty。S7 報告の 2・6 を参照。
6. V-10 は決定的でなく確率的だった（同じ候補・同じ cold DB で 1 回目は停止、2 回目は通った）。製品の連鎖（維持の Verify の連打 → registration の refused → Graph の slot の Suspended）は dev で再現しており、製品側に残っている。

## 準備（測定の窓の外）

- 標準 build 11-08 17:10〜17:16、評価 build 17:16〜17:21（exit 0）。13 の G-case の setup（G-01/v1、G-02/base、G-03/base・frontier-exceeded、G-04〜G-07/base、G-08 の base-usable・graph-index-unusable・graph-recovered・chronicle-index-unusable・both-indexes-unusable）は 17:22〜17:37 に **すべて setup-complete、再実行なし**。13 件の受領書の sha256 は `setups-s7r1/setup-receipts.sha256` と一致。
- 測定の窓の間、build・試験・他の Electron は走らせていない。dev の再現（上の 3）は 1 回目の Gold の停止の後・2 回目の Gold の前に、別の worktree で行い、2 回目の Gold の窓の間は read-only の調査（読取り）だけだった。

## 置き場

`setups-s7r1/`（eval-build、setups、standard-build の受領書、13 setup receipt の SHA-256）、`sp-p4-s7r1-1/`、`traces-s7r1-1/`、`parity-s7r1-1/`、`gold-s7r1-1/`（1 回目。3 variant）、`gold-s7r1-2/`（取り直し。13 variant）、`negatives-s7r1-1/`、`g01-e2e-s7r1-1/`、`g01-e2e-s7r1-1-report/`、`attempts-final-s7r1/`（9 件）。`setups-s7r1/` と `g01-e2e-s7r1-1-report/` には `files.sha256` が無い（記録の写しの手順が作らない設計の欠け。中身は `.artifacts` と `cmp` で一致、setup は `setup-receipts.sha256` で確認済み）。本文・secret の値は写していない。
