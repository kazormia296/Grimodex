# 編集中の失効（案 2）の設計の読み取り調査（2026-11-01）

ユーザーの確認「案2:失効の範囲を絞る」（`user-confirmation-2026-11-01-lapse-scope.md`）を受けた、read-only の subagent（Opus）の調査。**subagent の報告は model の出力で、ユーザーの権限を持たない**。「確かめた事実」は integrator が確かめたもの、「subagent の報告」は確かめていないもの。製品の code、文書、閾値、評価の規則は変えていない。

## 結論

**編集 trace の失効 200 件は「承認の失効」ではない。(i) 開始時の B（entity-relation index）の封印が dirty のままであることが原因**。事前登録の案 2 のうち「承認（型付き Revision）の失効を絞る」部分は X1 で実装済みで、本文の保存では A3 は落ちない（受領書で開始時の A3 は 201/201 が eligible、`ii-a3-ineligible-at-start` は 0 件）。したがって、案 2 を「対象 Scene と材料に関係する書込みだけが承認を失効させる」形で進めても、**今回の 200 件は 1 件も減らない**。この trace は query の Scene そのものの本文を編集するので、その絞り方では「関係する書込み」に当たる。

効くのは、事前登録が X1-5 と呼ぶ変更：**Graph の Index（B）を dirty にする event を、B の入力に関わる event に絞る**（本文だけの保存では B を dirty にしない）。これは確認済みの規則 l6-l9:113（本文などの通常更新で旧 Index の eligibility を invalidate する）を変えるので、委任の技術判断ではなく、**確認を要する変更**（K6/2 の #43／#62。新しい draftRef。置き場所は `nir1-scene-scope-projection-proposal/2#scope-storage-authority`〔X1 /2〕）。

## 確かめた事実（integrator）

- 受領書 `trace-editing-s5r4-1`：開始時の A3 は 201 件すべて `eligible: true`。失効の内訳は `i-b-seal` 200、ほかは 0。
- `src-tauri/crates/grimodex-db/src/narrative_extraction/change_feed.rs`（`append_narrative_change_transaction_in_tx` の末尾）：本文の宣言だけの transaction を除く**すべての feed transaction**が `suspend_project_in_tx` を呼ぶ（コメント：C17）。
- `nir1_chronicle_index/invalidate.rs`（`suspend_project_in_tx`）：`narrative_semantic_index_metadata` の `CHRONICLE_INDEX_KEY` と `GRAPH_INDEX_KEY` の**両方**に `dirty_cache_flag=1` を書く。
- K6/2（`docs/plans/nir1-final-request-eval-proposal-2-draft.md` の #43、#60、#62）：X1 が絞るのは型付き Revision の失効だけで、本文の保存は change feed を通って B と Chronicle の Index を dirty にする。X1 の後の編集中の trace の失効率は「(3) の query が出る時点で B と Chronicle が封印し直されているか」で決まる。Graph の Index の dirty を絞る X1-5 は B の seal による (i) が物差しを超えるときに要る。X1-5 だけでは Chronicle の停止による (i) は残る。X1-5 は l6-l9:113 を変えるので、確認を要する変更として示す。

## subagent の報告（integrator は未確認）

- B が戻らない理由：B の再構築の wake 源が `workspace:opened`、restore、epoch の回転の 4 種だけで、本文の保存を契機に B を再構築させる wake が無い（`narrativeMaintenanceTriggers.ts:10-14`、:1065-1072）。製品では B を作らない（B の build は seam が開いたときだけ。`maintenance_runtime.rs:2286-2299`、:3020-3026）。`broute-decisions.md:427-430` に「静止した project で B だけを起こす wake は無い」「wake 源と再構築の頻度は PUB-G で決める」とある。
- Chronicle は query の begin が build を起こし（`related_scenes/build.rs:8-60`）、250 ms ごとに再試行して index-ready を出すので、毎回戻っていた（`i-chronicle-stop` 0）。B にはこれに当たる経路が無い。
- 測定 DB（読取専用）：B は generation 2・dirty=1（`built_at` 00:21:01Z）のまま 00:36:35Z まで、Chronicle は generation 203。dependency-verify の run は 00:21:01Z 以後 1 件も無い。
- 本文の保存は Source token を伝播するだけで Scope 世代を進めない（`scene_body.rs:799-812`）。型付き Revision の Source は codex-entry／codex-relation／scene-scope-projection-v1 の 3 種で本文は入らない（`nir1_entity_relation.rs:995-1033`）。
- prep Main の `context-unavailable` 3 件（DR-BSEAM-5）：prep には seam が無く、エラーが wake に変わらず再試行 3 回で止まった可能性（推測）。measure 側の stderr には出ておらず、今回の (i) の直接の原因ではない。
- 見積り（推測）：X1-5 は draft の起案と確認 → 実装（X1/1 の見積りで 1 日）→ 新しい候補 → CP-4 の測り直し（編集 trace は 1 試行約 15.6 分）。規模は中、PUB-G は数日〜1 週程度遅れる。
- 次の壁（推測）：(i) が消えても、commit のたびに READY の worker が古くなる（`c_query_freshness.rs:8-22` の ReadIdentity は commit ごとに変わる）ので、窓外率は残りうる。主な理由が worker の鮮度に移れば、K6/2 の条件 (b) の道（編集中の可用性を開示に回す）がある。(iii)（返却時の再検証。F10）と Chronicle の停止も残りうる。
- 未確認：Graph の path Evidence や excerpt が本文由来の文字列を開示しないこと、X1-5 の後に Chronicle が毎回間に合うこと、新しい候補で CP-4 のどこまで取り直すか、K6/2 の条件 (b) を X1-5 の後の結果に当てたときの成否、prep Main の失敗が setup の B の seal に影響したか。

## 新しい draftRef（X1 /2）でユーザーに確認すべき論点（subagent の案を integrator が整理）

1. X1-5 の範囲：(a) 本文だけの保存（scene content／sidecar／doc.step）に限る〔推奨：最小で安全〕、(b) X1/1 の Q6 の一覧どおり B の入力の event だけで dirty にする、(c) (b) に加え Freshness 経路の dirty も Index ごとに分ける。
2. 規則の読み方：l6-l9:113 の「通常更新で旧 Index を invalidate」を「B の入力に関わる writer に限る」と読み替える。分類できない event は dirty にする fail-safe を必須にする。
3. wake 源：A. 今回は X1-5 だけ入れ、wake 源は PUB-G で決める〔推奨〕、B. B の入力の書込みの後の B の wake を今足す（lifecycle の技術判断）。
4. Chronicle の側：今どおり保存ごとに dirty にし、要求を契機にした build に任せる〔推奨〕。停止が 0 件だった事実を開示する。
5. 測り直し：凍結済みの trace の file と K6/2／K6/4 の規則のまま、X1-5 を含む新しい候補で取り直す〔推奨〕。範囲（編集 trace だけか CP-4 全体か）を決める。
6. X1-5 の後の見通しの開示：worker の鮮度による窓外が主な理由になった場合は、K6/2 の条件 (b) の道に進む。

## 追記すべきこと（確認の範囲の読み）

ユーザーの確認「案2」は方向の確認で、事前登録の案 2 の文言（対象 Scene と材料に関係する書込みに絞る）と、実際に効く変更（X1-5。B を dirty にする event の絞り込み）は形が違う。ユーザーに、実際の形（X1-5）で進めてよいかを、起案する新しい draftRef の確認で改めて求める。
