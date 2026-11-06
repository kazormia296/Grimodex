# IRW の判断の記録（関連場面の IR の窓 D を 10.84 ms から 40 ms に広げる）

出所は PD 評価（`fusion-eval-data/pd-2026-11`、評価の証拠ではなく診断）と、2026-11-05 のユーザーの回答
「変えていいです」（窓の 10.84 ms を変えるかの問いへの回答）。値の選び方はユーザーから委ねられている。
基点は `origin/master` の `44b6c753`、branch は `claude/related-scenes-ir-window`。

これは**閾値の変更（緩和）**で、AGENTS の委任には含まれない。ユーザーの承認に基づいて行う。

## 1. 事実

| 事実 | 確認の結果 |
|---|---|
| D の使われ方 | `relatedScenesConfig.ts` の `RELATED_SCENES_IR_EXTRA_WAIT_MS`。Raw-ready の後に IR を待つ時間で、Graph の最初の表示（親）の合流の窓の既定値も同じ定数（`nir1RelatedScenesGraphJoin.ts`。窓は D 以上でなければ throw） |
| D の由来 | L0 の P の固定値：D = min(100 ms, 0.20 × B)、B = 54.2 ms（試験用の fixture の Raw の warm p95。`scripts/quality/nir1-retrieval/contract.mjs` の `summarizeWarm`） |
| 実際の作品の Raw | PD 評価の日本語（117 Scene）で Raw-ready まで p50 約 185 ms・p90 約 204 ms、英語（54 Scene）で p50 約 64 ms・p90 約 75 ms |
| IR の到着（Raw-ready から） | 測定の済んだ workspace の写しで、窓の後も IR を手放さずに測った（harness の診断の mode、`claude/fusion-slot-ir-eval` の `51f72507`、build-ir-22）。日本語 m-ja-2（117 Scene、290 sample）：p50 18.3 ms、p90 23.1 ms、p99 24.8 ms、最大 25.5 ms。英語 m-en-1（54 Scene、180 sample）：p50 7.4 ms、p99 12.2 ms、最大 12.3 ms |
| 今の D での結果 | 日本語は 290 中 24（8.3%）だけが窓に入る（本測定の m-ja-2 の p75 でも 87 中 72 が時間切れ）。P の IR の timeoutRate の物差し（1% 以下）に大きく外れる |
| 製品の挙動 | 窓が切れると Raw だけを出し、IR の operation を手放す（`fetchNir1RelatedScenes.ts` の `releaseOperation`）。IR が先に届けばその時点で返すので、D は待ちの上限であり、毎回の待ち時間ではない |

## 2. 判断の表

| ID | 日付 | 判断 | 信頼境界 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-IRW-1 | 2026-11-05 | **D を 40 ms の固定値にする**。日本語の最悪値 25.5 ms に約 1.5 倍の余裕。実際の日本語の作品の Raw の p90（約 204 ms）に元の式（0.20 × B）を当てた値（約 40.8 ms）とも合う。100 ms の上限（式の `min(100, …)`、W_f = 100 ms）より下 | renderer の待ちの長さだけ。送信先・保存・契約・Native は変えない | (a) Raw の時間に比例させる（query ごとに 0.20 × Raw。新しい仕組みで、英語の短い Raw では 98.9% に落ちる）、(b) 25〜30 ms（今の作品は覆うが、もっと長い作品や遅い機械で余裕が無い）、(c) 50 ms 以上（日本語の Raw の 0.2 倍を超え、待ちの上限が無駄に長い） | 実装済み |
| DR-IRW-2 | 2026-11-05 | **Graph の最初の表示の窓も同じ定数のまま 40 ms に広がる**。合流は「Graph の窓 ≥ IR の締切」を前提に 1 回だけ公開する作りで、IR だけを 40 ms にして Graph を 10.84 ms に残すと、窓の後に公開する結果から窓の間の Graph を捨てる不自然な形になる。Graph が最初の表示に入る機会が増える方向の変化 | 同上 | 定数を 2 つに分ける（合流の不変条件の変更が要る） | 実装済み |
| DR-IRW-3 | 2026-11-05 | **この変更が上書きする確認済みの記述**（以後は 40 ms が正）。(1) L0 の P の固定値「D=10.84 ms、上限 65.04 ms」（`nir1-dsn-2026-10.md` §3.5 の前提、`nir1-final-request-eval-proposal-*` の「変えないもの」）。(2) K6/4（`nir1-final-request-eval-proposal/4`、2026-10-26 確認）の「最初の表示の D=10.84 ms は変えない」。(3) DR-WF-1 の「D の定数は変えない」。過去の測定の記録（P、CP-4 の S5／S6）は、その時点の候補の記録としてそのまま有効 | — | — | 記録済み |

## 3. 変えないもの

- 送信先、保存、IPC／wire、Native、鮮度・再検証・監査の契約、W_f（100 ms）、Graph の lease、IR の floor と順位付け。
- CP-4 の評価の手順（`scripts/quality/nir1-graph-eval/constants.mjs` の `GRAPH_EVAL_D_MS = 10.84`、凍結した `k64-procedure.v1.json`）。この手順は 10.84 ms の候補に結び付いていて、この変更を含む候補で CP-4 を取り直すときは、手順の新しい版が要る（`followup.mjs` は親の窓が D と一致することを確かめるので、今の版のままでは precheck で止まる）。手順の改訂と CP-4 の取り直しはユーザーが決める。
- P の評価（`scripts/quality/nir1-retrieval`）は D を fixture の B から計算する。製品の定数と比べる箇所は無い。

## 4. 検証

- `vitest run src/features/related-scenes scripts/quality/nir1-graph-eval`：507 passed（6 skipped）。D の時刻を直書きしていた試験（合流・W_f・fetch の 13 件）を、D の値に追随する形に直した。落ちた 2 file（`nir1GraphSeed*.test.ts`）は worktree の `@grimodex/scan-contract` の未 build による読込みの失敗で、変更の前から同じ。
- PD 評価の取り直し（第 5 版の事前登録）で、IR の時間切れが減ることを確かめる。
