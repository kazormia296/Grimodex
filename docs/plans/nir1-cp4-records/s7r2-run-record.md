# CP-4 Graph 正式 run（s7r2）の実施記録（2026-11-15）

この記録は、run と receipt の記録までを扱います。

- S6 の集計：`s6-aggregation-s7r2/`
- 品質判定：`quality-verdict-s7r2-1/`
- S7 の報告（草稿）：`s7-report-s7r2/`

形は `s7r1-run-record.md` に合わせました。下書きは run の前に作り、run の後に結果を埋めました。

## 束縛

| 項目 | 値 |
|---|---|
| 契約 K6/6 の凍結 | commit `56fb4fad2eb1eb2e021dfd121ea073f9d263cb4d`、SHA-256 `58c634fa9b3d76803e486516c0e67444b74d4f5987cd851cd0857a25cc8945e7`。受領書の `head.k66` と一致します（S6 の script が確認）。s7r1 と同じです |
| 契約 K6/5・K6/4・K6/2 | K6/5 `07fc80ec150f4fcab62fc6fce8d9e0d71d33c70f`、K6/4 `5dea38af158283c2a925d68ef0d8b0771c0ea209`、K6/2 `af643a93eeae7f937c9cd5a9dd87a6308c96fab6`。s7r1 と同じです |
| S4（7 回目、**再凍結なし**） | S4b `f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b`（s7r1 と同一）。freeze record の SHA-256 は `5816c315…`、S2（`evals/nir1-graph/observation-prep.v1.json`）の SHA-256 は `67b78f8d…` で、どちらも候補の bytes と一致します |
| 候補 | master `29a120ddd3dd8ec5a43845a76cbda837e9b20f6a`（PR #909 `claude/wal-restart-prepay` の merge commit、tree `97ae2b7a…`）。下の「補足：候補」を参照 |
| R5 の記録 | 前回の記録（`56d4ec54`、確認 `82119012`）を使い、取り直していません。R5 の閉包の 43 file は、S4b `f2f99b13` から差分 0 です。`179139b4` との差分は規則 file の 7 つで、s7r1 と同じです |
| 品質判定 v2 | 確定版 `8b2a5daf…`、実装 `7652a86e…`。remote 時刻の記録は s7r1 と同じ bytes です |
| 手順の正本 | S2 `observation-prep.v1.json`（frozen）、runner `scripts/quality/nir1-graph-eval/`、手順の script 一式 `handoff/s7r2-runbook/`、散文の手順書 `handoff/nir1-s7r1-runbook-20261109.md`。下の「補足：手順の正本」を参照 |
| run 名 | 接尾辞は `s7r2` です。S4 が 7 回目のまま、候補だけが変わるためです（前例：s5r3〜s5r6）。台帳の key は (root, candidate, s4Commit) なので、s7r1 の台帳 9 件はこの run の台帳に出ません |

### 補足：候補

- S4b は候補の祖先です。
- 許可リストは `(f2f99b13…, 29a120dd…)` です（`allow-list-s7r2-s4-f2f99b13-candidate-29a120dd.json`）。
- worktree は clean な detach で、場所は `/home/grimodex/worktrees/Grimodex/cp4-formal-s7r2` です。run の直前に、`HEAD` が候補であることと、`git status --porcelain` が空であることを確かめました。
- master の Full（43697442942）は、候補 `29a120dd` で success でした。Full は待たずに run へ進み、run の後に結果を確かめました。

### 補足：手順の正本

`handoff/s7r2-runbook/` は s7r1-runbook の写しです。変えたのは次の点です。

- run 名、候補、session ID などの置換。
- `v10-check.mjs` の追加。
- `copy-records.sh` の修正。
  - `gold-s7r2-2` は、その dir があるときだけ写します。
  - `setups-s7r2` と `g01-e2e-s7r2-1-report` にも `files.sha256` を作ります。

`handoff/` は integrator の引き継ぎ file で、contracts の外にあります。

## 変えていないもの・変わっているもの

- **変えていないもの**
  - S4b 以降の harness。`scripts/quality/nir1-graph-eval`、`scripts/quality/nir1-graph`、`evals/nir1-graph` は、`f2f99b13` から候補まで差分 0 です。
  - S2、Gold、fixture、閾値。
  - Electron の起動方法。`scripts/local-ci-xvfb.mjs` で動かし、`unshare -n` は使っていません。
- **s7r1 から変わっているもの：製品**
  - 候補は、s7r1 の候補 `3f333a83` から first-parent で 69 commit 進んでいます。内訳は「開示」の 3 にあります。

## 走らせた run（UTC。所要は台帳の startedAt〜finishedAt）

| 順 | run ID | 結果 | 開始〜終了 | 所要 |
|---|---|---|---|---|
| ④ | `sp-p4-s7r2-1` | completed、passed | 09:40:34〜09:42:24 | 1.8 分 |
| ⑤ | `trace-editing-s7r2-1` | completed、valid | 09:43:17〜09:58:50 | 15.6 分 |
| ⑤ | `trace-browsing-s7r2-1` | completed、valid | 09:59:43〜10:04:54 | 5.2 分 |
| ⑤ | `parity-s7r2-1` | completed、12 variant、窓 true | 10:05:48〜10:13:03 | 7.2 分 |
| ⑤ | `gold-s7r2-1` | completed、13 variant、窓 true、problems 空 | 10:13:58〜10:58:26 | 44.5 分 |
| ⑤ | `neg-n2-s7r2-1` | completed、窓 true | 10:59:21〜11:01:44 | 2.4 分 |
| ⑤ | `neg-n3-s7r2-1` | completed、窓 true | 11:02:38〜11:04:59 | 2.3 分 |
| ⑤ | `neg-n4-s7r2-1` | completed、窓 true | 11:05:53〜11:08:21 | 2.5 分 |
| 診断 | `g01-e2e-s7r2-1`（purpose `g01-e2e-diagnostic`。判定に数えない。別 session） | exit 0、end-to-end まで到達 | 11:09:11〜11:09:24（chain の log） | 0.2 分 |

- 順は S2 の順（④ → trace×2 → parity → Gold → negative×3）で、診断 run は最後です。
- chain は 09:33:36Z に起動し、11:09:25Z に `chain done` で終わりました。
- 各 run の前に、chain が静けさを確かめました（`wait-quiet.sh`）。
- 台帳
  - 開始時の状態は、各 run の開始直後に contracts へ push しました（`ce0f6a80`〜`8a5bddce` の 8 commit）。
  - 終了時の状態は `attempts-final-s7r2/` にあります。
  - **台帳は 8 件で、すべて completed です。** 停止も取り直しもありません。trace も attempt 1 で、stall はありません。

## Gold を取り直した経緯

該当しません。`gold-s7r2-1` は 1 回目で completed になりました。13 receipt の `priorAttempts.gold` は、すべて空配列です（S6 の script が確認）。

## 前回 s7r1 の Gold 2 回（開示）

前回は別の候補での試行です。台帳の key が違うので、この run の台帳や受領書には自動では出ません。そのため、ここに書いて開示します。

前回の候補 `3f333a83554d4dba6c54417d500d3af6f0e985c5`（s7r1）では、Gold を 2 回走らせました。

- **1 回目 `gold-s7r1-1`**：2026-11-08T18:11:58Z〜18:19:27Z。status は **stopped** です。4 番目の variant `G-03/frontier-exceeded` で `[precheck] V-10` が出て止まりました。
- **取り直し `gold-s7r1-2`**：11-08 23:02:45Z〜23:49:40Z。13 variant すべてが completed でした。

S6 の `previousCandidateGoldDisclosure` に、前回の 2 つの台帳の status、時刻、sha256 を載せました。S7 の 6 にも再掲します。

### V-10 の予防の確認

setup の後、Gold の前に、`v10-check.mjs` で次の 3 点を確かめました。結果は **13/13 が ok** です。

- `readBack.maintenance.running` が 0。
- seal の maintenanceRuns の合計が 100 未満。
- settle が 5 s 以内で、notquiet のときは 1 s 以内。

### 前回の連鎖は今回は起きなかった

- 前回の `G-03/frontier-exceeded`：Graph arm 35 sample のうち、30 が `registration-unavailable`、23 が `startSlot: suspended` でした。
- 今回の同じ variant：35 sample すべてが `graph-late` で、slot は `empty` でした。**連鎖は起きていません。**

## 準備（測定の窓の外）

- **dev の確認**（凍結外の dev fixture。判定に数えない）
  - 先払いの A/B（`prepay-impl-ab/`、g06 と g03）で、Graph arm の p95 は 84.0 ms から 54.1 ms に下がりました。
  - 75 ms 以上の外れ値は、1 run あたり 2.50 件から 0 件になりました。
  - 参考：s7r1 の p95 の余裕は 1.5 ms でした（92.70 ms／上限 94.2 ms）。
- **build**
  - 標準 build：09:07:03〜09:12:42Z、exit 0。
  - 評価 build：09:12:42〜09:18:05Z、exit 0。
- **13 の G-case の setup**：09:18〜09:32:49Z。
  - 13 件すべてが 1 回で setup-complete になり、再実行はありませんでした。
  - `.artifacts/cp4/abandoned/` は空です。
  - 13 件の受領書の sha256 は `setups-s7r2/setup-receipts.sha256` に記録しました。
- **測定の窓**
  - 窓の間は、build、試験、cargo、vitest、他の Electron、Xvfb、HDD 全体の走査を走らせていません。
  - dev の HDD の測定（prepay-impl-ab）は、PR #909 の merge の前に終わっていました。
  - Desktop セッション（長音符テンプレート追加）には、build の前に窓の予定（約 09:10〜13:30Z）を連絡しました。
  - 窓の後、11:10Z を過ぎてから解除を連絡しました（時刻は session の記録の timestamp による）。

## 置き場

記録は contracts の commit `18b745d5` で、次の dir に置きました。各 dir に `files.sha256` を作りました。

- `setups-s7r2/`
- `sp-p4-s7r2-1/`
- `traces-s7r2-1/`
- `parity-s7r2-1/`
- `gold-s7r2-1/`
- `negatives-s7r2-1/`
- `g01-e2e-s7r2-1/`
- `g01-e2e-s7r2-1-report/`
- `attempts-final-s7r2/`（8 件）

置いた後に、次のことを確かめました。

- `files.sha256` は、全 dir で一致しました。
- Gold の 13 件は、`.artifacts` と byte 一致しました（`cmp`）。
- 台帳の開始時の sha256 は、parity、Gold、N2〜N4 のどれも、受領書の `priorAttempts.thisAttempt.fileSha256AtStart` と一致しました。
- 本文と secret の値は写していません。API key らしい文字列が無いことは `grep` で確かめました。
- 記録の欠けはありません（`records.missing` は空）。

## 開示

### 1. pin の外で、S4b から候補までに差分がある file（10 個）

S2 の pin は 94 件とも一致しています。run-report の `checks.sourcePins` は 45 pin で、S6 の script が 3 点照合します。

pin の外で差分がある file は次の 10 個です。

- `evals/impact-map.yaml`
- `evals/quality-manifest.yaml`
- `scripts/quality/impact-map.mjs`
- `scripts/quality/impact-map.test.mjs`
- `scripts/quality/nir1-packing/final-request/architecture.test.mjs`
- `scripts/quality/quality-workflow.test.mjs`
- `scripts/quality/validate-change-feed-writers.mjs`
- `scripts/quality/validate-narrative-ir-contract.mjs`
- `scripts/quality/validate-semantic-core-boundary.mjs`
- `scripts/quality/validate-semantic-core-boundary.test.mjs`

いずれも harness の外にあり、受領書の測定には入りません。中身の変更は読んでいません。

### 2. WAL の restart の先払い（DR-DBC-6、PR #909）

候補に入った製品変更のうち、測定の経路に直接効くものです。

- **内容**
  - 背景の PASSIVE checkpoint が WAL を全部書き戻した後、背景スレッドが主接続の上で、同じ値の `application_id` を 1 回 commit します。
  - これで、次の前景の commit が払っていた WAL header の fsync を、先に払っておきます。
  - DR-DBC-1 の「背景は何も commit しない」という契約の改訂で、ユーザーが 2026-11-15 に承認しました。
  - maintenance の no-wait guard が生きている間は、先払いを飛ばします。
- **鮮度 stamp への影響**
  - 先払いが主接続の Mutex を握っている間は、鮮度 stamp の `try_lock` が `None` になりえます。
  - **今回の Gold の pool では、stamp の `unavailable` は 0 でした。** 内訳は `stamp0-missing` 266、`fresh` 4 です。
  - `firstRenderNotCountedReasons` は全 variant で空でした（`FR3:stamp-*` は 0）。`contributedNotCounted` も 0 でした。
- **p95**
  - Graph arm の p95 は、92.70 ms から 60.10 ms に下がりました。
  - 上位 20 件は 60.1〜64.1 ms で、75 ms 以上は 0 件です。
  - dev で見た外れ値が消えた形と合います。ただし、正式 run の中で機構は確かめていません。ほかの 68 commit の効果とも切り分けていません。

### 3. 候補に入った製品の変更

s7r1 の候補 `3f333a83` からの 69 commit です（`git log --first-parent --oneline 3f333a83..29a120dd`）。分類は題の趣旨によるもので、PR 本文は読んでいません。

| 分類 | 件数 | PR |
|---|---|---|
| Graph の registration・維持・鮮度・DB 接続・C-query | 15 | #850・#852・#853・#854・#862（DR-GRW-1〜5）、#859（DR-MP-8）、#843（DR-MPS-15）、#846（DR-MPS-16）、#847（DR-DBC-3）、#881（DR-DBC-5）、#909（DR-DBC-6）、#869・#871・#879・#880（DR-CQA-6〜9） |
| Chronicle・Codex・抽出 | 16 | #857・#858・#864・#866・#872・#875・#876・#877・#878・#886・#888・#894・#895・#899・#903・#906 |
| UI・起動 | 4 | #849・#851・#865・#867 |
| 依存 | 3 | #845・#882・#883 |
| 試験・docs | 16 | #844・#848・#861・#838・#842・#855・#856・#860・#863・#868・#870・#873・#874・#885・#887・#892 |
| 未分類（merge commit の題が branch 名だけ） | 15 | #884・#889・#890・#891・#893・#896・#897・#898・#900・#901・#902・#904・#905・#907・#908 |

### 4. s7r1 から引き続く開示

- K6/6 の数え方（R-7）に依存していること。
- 受領書に sample 単位の FR-1〜FR-8 の内訳が無いこと。今回も同じ形で、sample にそれに当たる key はありません。
- trace を K6/4 の読みへ再計算していること。再計算は keep test の証拠に依り、全 run の後に窓の外で実行しました。

### 5. 記録の欠け

ありません。

## DR 追記（cp4-decisions.md）

決定 ID は **DR-CP4-S6-6**（案）です。master の `docs/plans/nir1-lane-decisions/` にある cp4 の決定文書に、docs の PR で載せます。**まだ作成していません。**

載せる中身は次のとおりです。

- 日付、候補 `29a120dd`、S4b `f2f99b13`、run 名 `s7r2`。
- S6 の結果と規則の当てはめ。規則は HOLD を指さず、`[precheck]` にも当たりません。これは integrator の技術判断で、前例は S6-2〜S6-4 です。
- 開示。
- ユーザー本人の確認に残す事項（S7 の 5）。

DR-DBC-6（先払いの実装）とは別の決定です。
