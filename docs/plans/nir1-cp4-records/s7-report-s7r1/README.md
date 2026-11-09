# S7 報告（草稿）：CP-4 の Graph arm の評価（S4b f2f99b13・候補 `3f333a83`・K6/6）

2026-11-09（JST）の integrator の報告の草稿。**ユーザーの受入れは未了**（結果が何でも「受入れ済み」とは書かない）。測定の記録は同じ `nir1-cp4-records/` の `sp-p4-s7r1-1/`、`traces-s7r1-1/`、`parity-s7r1-1/`、`gold-s7r1-1/`（1 回目。停止）、`gold-s7r1-2/`（取り直し）、`negatives-s7r1-1/`、`g01-e2e-s7r1-1/`、`attempts-final-s7r1/`、`setups-s7r1/`、実施記録は `s7r1-run-record.md`、集計は `s6-aggregation-s7r1/`、品質の判定（補助）は `quality-verdict-s7r1-1/`。前回の報告は `s7-report-s6r1/`（S4b `63bc9b90`・候補 `a2309b95`・K6/5。HOLD）。

## 1. 結論

**事前登録の規則を当てた結果、HOLD にも `[precheck]` にも当たらない（Gold の定常状態の pool：欠落 0／270、許容 2 件）。ただし「CP-4 の Graph arm の可用性を満たした」と言い切る前に、下の 3 の条件を読むこと。** 受入れは 2 つに分ける：(1) 規則の当てはめ結果の記録（integrator の技術判断。前例 DR-CP4-S6-2・S6-3。**記録済み**）、(2) K6/2 の 621 行の「受入れへの影響」（Lane unlocked、編集中の可用性を合否から外す緩和の発効）と「可用性を満たした」の確定（K6/6 の批准 7 (ii)・9 により事前の確認にとどまる。**ユーザー本人の 1 行確認に残す**。5 参照）。 s6r1 の HOLD（欠落 163／270）は、K6/4 の R1 の下で first-render が構造的に数えられない契約の食い違いによるもので、K6/6 が first-render の数え方（R-6：準備の句、R-7：鮮度の印の句）を直した。この run はその K6/6 の下の 1 回目の正式の測定。

| 指標（K6/4 の読み） | 前回（s6r1・K6/5） | 今回（s7r1・K6/6） | 物差し |
|---|---|---|---|
| (a) Gold の pool の欠落 | 163／270（表示 107） | **0／270（表示 270：first-render 156、follow-up 114）** | 2 件（floor(0.01×270)） |
| 表示 0／30 の variant | 5 | **0** | K6/4:167 |
| `contributedNotCounted`（窓内に合流して Graph が寄与したのに first-render の条件を欠く親） | — | **0** | 0（K6/6 の追加。超えると品質 FAIL） |
| (b) 編集 trace の失効 | 1／201（0.50%。`i-b-seal`） | 1／201（0.4975%。`i-chronicle-stop`＝C7 が正式 run で初めて働いた） | 1%（内側） |
| (b) 編集 trace の窓外 | 1／201 | 1／201 | 2 件（内側） |
| (b) 閲覧 trace | 失効 0・欠落 0 | 失効 0・窓外 0（表示 201） | — |
| q1 の max（editing／browsing） | 56.9／98.6 ms | 50.7／83.1 ms | `T_late` 100 ms（内側） |
| ④ SP-P4／parity | passed／12 variant valid | passed（差異 0、IR 期限切れ 0）／12 variant valid | — |
| 診断の負例 N2／N3／N4（判定に数えない） | すべて measured・established | すべて measured・valid・established | — |
| 品質の判定（補助） | hold（failed-required-items、held-required-items） | **hold（unverified-required-items）**。fail・hold の条件は無く、受領書に無い項目が not-evaluable | — |
| Hybrid p95（R+IR arm／Graph arm、上限 94.2 ms） | 22.00／60.20 ms | 22.60／**92.70 ms**（**余裕 1.5 ms**） | pass |
| **規則が指す先** | HOLD に当たる | **HOLD に当たらない** | — |

**2 回目の Gold の中で、V-10 の根の連鎖が実際に起きていた（判定外の variant）。** `G-03/frontier-exceeded`（pool に入らない variant）の Graph arm 35 sample のうち 30 が `graph-unavailable: registration-unavailable`、23 が `startSlot.kind: suspended`（`gold-s7r1-2/G-03_frontier-exceeded.receipt.json` の `samples`。独立レビューの集計では measured 30 のうち 28 で、warmup を含めるかで数が違う）。READY の probe は 1 回で通っていた（`ownerReady.probes` 1）。前回 s6r1 の同じ variant は Graph arm 35 sample すべて `graph-late`・slot empty だった。この variant の期待は `unavailable: graph-limit-exceeded`（fixture `evals/nir1-graph/g03-bounded-two-hop.v1.json`）で、表示 0 は期待どおりだが、**理由の種類が期待と違う**（品質判定は `expectedGraph === "unavailable"` だけを見て reasonClass を見ない。`quality-verdict.mjs:519`）。pool の 9 variant の slot は全件 empty で、波及は無かった。つまり 1 回目の V-10 の停止は取り直しで避けられたが、**同じ連鎖（Verify の連打 → registration の refused → Suspended）は 2 回目でも判定外の variant の中で起きている**。

## 2. 測ったもの（S4b `f2f99b13e18bcf4dd84ff6778de56189a3e1ef9b`、候補 `3f333a83554d4dba6c54417d500d3af6f0e985c5`、台帳 9 件）

SP-P4（1.8 分）、trace editing（10.5 分）・browsing（3.7 分）、parity（7.2 分）、**Gold は 2 回**（1 回目 `gold-s7r1-1` は G-03/frontier-exceeded の `[precheck] V-10` で stopped、7.5 分。**取り直し `gold-s7r1-2` は 13 variant すべて completed、46.9 分**）、N2／N3／N4（各 2.3〜2.4 分）、G-01 の e2e 診断。時刻と経緯は `s7r1-run-record.md`。台帳 9 件はすべて `(f2f99b13…, 3f333a83…)`、受領書 31 件はすべて K6/6 の束縛に一致（script が確認）。集計の対象は completed の 8 件で、1 回目の Gold は集計に数えず開示する。

## 3. 言えること、言えないこと

**言えること**

- K6/6 の数え方の下で、Gold の定常状態の pool 270 sample はすべて表示があり（first-render 156、follow-up 114）、欠落は 0、`contributedNotCounted` も 0。9 variant のどれも表示 0 ではない。
- trace：editing の失効は 1／201（0.4975%）、窓外は 1／201 で、どちらも物差しの内側。browsing は失効 0・窓外 0。`T_late`（100 ms）の超過は無い。C7（Chronicle の停止を失効に数える）が正式 run で初めて働いた（外した begin が editing に 1 件、`conditionFetches` 1 と一致）。
- SP-P4 passed、parity 12 variant valid、N2〜N4 は measured・valid・established、G-01 の診断は `reachedEndToEnd: true`。品質の判定（補助）の G-01 の事前指定改善・macro 非回帰（G-case 13 variant）・Hybrid p95・edge の束縛・禁止寄与の (a)(b) はすべて pass。
- 取り直し前後の差：1 回目の 3 variant（G-01、G-02、G-03/base）と 2 回目の同じ 3 variant の数値は S6 README 5 に並べてある。G-02/base の first／follow が 9／21 と 3／27 で違うが、表示は同じ 30。

**言えないこと・読み方の条件**

- **この「欠落 0」は K6/6 の数え方に依存する。** 鮮度の印（stamp）は pool 270 のうち 269 が `stamp0-missing` で、K6/6 の R-7 はこれを数える。**K6/2 の字義のまま読むと、窓外は 270／270 で今回も HOLD に当たる**（受領書の `steadyStateCase.outOfWindow`。K6/4 批准 2 以降は窓外率が物差しではない）。`stamp0-missing` が 269 になる原因は、K6/6 の「確かめられなかったこと 1」のまま未解明。K6/6 の窓外率（114／270＝42.2%）は開示だけで物差しではない。この読みの変更（R-6・R-7）が緩和に当たる点は K6/6 の確認で開示済み（ユーザーの確認 `1e6ede44`・`e704f28f` と K6/6 の批准）。
- **Gold を 2 回走らせた**。1 回目は precheck 停止で判定ではない。2 回目は同じ候補・同じ setup で通った。結果を選んだのではないが、同じ候補で 1 回目は停止・2 回目は完了だった事実は変わらない。V-10 は確率的で、製品の連鎖が残っている（下の 6）。**同じ候補での再現性は、2 回目の Gold を 1 回測っただけ**。
- Graph arm の p95 は 92.70 ms で、上限 94.2 ms との余裕は 1.5 ms。前回の 60.20 ms から上がった。variant 別の p95（開示）は G-04/base 116.5、G-02/base 108.3、G-07/base 100.8、G-05/base 100.3 ms が 94.2 ms を超える（判定は G-case 全体の p95）。Graph の結果が窓内に届く sample が増えたことと合う読みだが、機構は確かめていない。
- **`G-03/frontier-exceeded` が期待の理由（`graph-limit-exceeded`）で unavailable になったかは言えない。** 受領書は validation valid だが、Suspended の連鎖で unavailable になっており、frontier の上限の機構が測れたとは言えない。**ただしこれは今回固有ではない**：この variant は s5r5・s5r6・s6r1 の正式 Gold でも Graph arm 35／35 が `graph-late`（slot empty）で、期待の理由（製品の reason 語彙では `limit`）は一度も観測されていない（今回の 2 回目も 13 variant で `limit` は 0）。この variant の設計上の限界（D＝40 ms の窓内に探索が終わらず、`limit` を返す前に窓外になる）と読める。fixture の `reasonClass: "graph-limit-exceeded"` は製品・harness の語彙と対応づけが無く、品質判定は `expectedGraph === "unavailable"` だけを見る（`quality-verdict.mjs:519`）。機構そのものは Rust の unit test（`nir1_graph/tests.rs` の `graph_entities_at_50_is_available`、`graph_entities_at_51_refuses_the_whole_graph`、`two_hop_limit_stops_before_a_third_hop`）で検査済み。製品経路で上限超過の Graph を全体拒否する端から端の検査は Gold に無く、PUB-G の前提に載せる。この variant は pool に入らず（`inPool: false`）、欠落 0 の結論には効かない。
- 品質の判定（補助）は hold（unverified-required-items）。既存 24 件の Graph arm の受領書が無い、evidence の 4 項目と禁止寄与の (c) が受領書に無い、で not-evaluable。品質の「Recall・nDCG の改善」を 24 件の P についても言うことはできない。
- 製品の退行が無いこと。受領書の範囲の形跡で、証明ではない。
- 欠落 0 になった機構（なぜ数え方の変更で 0 になったかの因果）。K6/6 の条件（FR-1〜FR-8）は S6 では受領書の値を読んだだけだが、**独立レビュー（Fable）が sample の原記録から FR-1〜FR-8 を当て直し、合流 156 件すべて通過・receipt の `firstRender` と全 variant 一致した**。ただし、K6/6 の変える点 7（R7：sample ごとに FR-1〜FR-8 のどれを満たしたかの記録）に対し、受領書には variant 集計の `firstRenderNotCountedBy／Reasons` だけで **sample 単位の内訳が無い**（`availability.mjs:200-219`）。判定には効かないが、契約の記録の要求との食い違いとして 6 に開示する。
- editing の失効 1 件（`i-chronicle-stop`）の原因は、C7 の分類のとおり Chronicle の停止。それ以上は未確認。

## 4. 前回（s6r1）との比較

| 指標 | s6r1（K6/5） | s7r1（K6/6） |
|---|---|---|
| Gold の pool の欠落／表示 | 163／107 | 0／270 |
| Gold の窓内に合流した親の数 | 163／270 | 156／270（ほぼ同じ。差は製品の挙動より K6/6 の数え方の改訂 R-6・R-7 による、と読める） |
| editing の first-render／follow-up（K6/4 の読み） | 32／168 | 23／177 |
| browsing の first-render／follow-up | 2／199 | 3／198 |
| editing の失効の分類 | `i-b-seal` | `i-chronicle-stop`（C7） |
| K6/2 の読みの窓外（editing／browsing） | 169／199 | 178／198（受領書そのまま。K6/4 の読みへの再計算の理由は前回と同じ） |
| q1 の max（editing／browsing） | 56.9／98.6 ms | 50.7／83.1 ms |
| 品質の判定（補助）の全体 | hold（failed-required-items、held-required-items） | hold（unverified-required-items） |

前回と違い、Graph が窓内に合流した親の sample は定常状態で first-render に数えられ、欠落が 0 になった。**これは契約の数え方を変えた結果で、pool の窓内の合流数（163→156）に限れば製品の挙動はほぼ同じ**。ただし判定外の `G-03/frontier-exceeded` では、前回は無かった Suspended の連鎖が 2 回目に起きている（結論の直後の段落）。

## 5. 決めたことと、ユーザーに残すこと

ユーザーは 2026-11-09T00:50:59Z（09:50:59 JST。session の記録の timestamp）に「Fable に相談して決めてください」と、次の判断を integrator に委任した。独立した 2 人の助言者（Fable、read-only）に相談して、次のように決めた（助言者の確度と根拠は 6 の 15）。

**決めた（integrator。判断記録は DR-CP4-S6-4 に追記する docs PR）**

1. **規則の当てはめ結果「HOLD にも `[precheck]` にも当たらない」を記録する**（技術判断。前例 S6-2・S6-3）。受入れの効力（下の 6 の (1)）は含まない。
2. **Gold の 2 回目（`gold-s7r1-2`）を集計に使い、1 回目を開示に回す**。訂正：**S2 の `attemptRule`（`observation-prep.v1.json` の `diagnosticRuns[9]`）は SP-P4 の取り直しの規則で、Gold の回数上限ではない**（本文の草稿は「attemptRule で使い切り」と書いたが誤り）。Gold の事前登録上の規則は「同じ候補・S4 の Gold の試行を全件 `priorAttempts.gold` に開示する」（S2、DR-CP4-N-14 (2)、`frozen-k64-run.mjs:1681-1703`）で、上限は無い。runbook §7 は取り直しをユーザーの判断事項とし、ユーザーが 1 回だけと決めた（運用上の上限。前例 U-1 と同型）。1 回目は precheck 停止で完了結果が無く、「結果を見て選び分ける」（K6/2 の In-scope attack）の対象が無い。13 receipt すべてが前の試行を開示している。
3. **`G-03/frontier-exceeded` は判定外として、開示して受け入れる**。この variant だけの取り直し（3 回目の Gold）は、完了結果がある状態での再試行で K6/2 の攻撃面に入るので採らない。連鎖を直した新しい候補での取り直しは、CP-4 の結論に効かず `limit` が出る保証も無いので今は採らない。frontier の上限の端から端の検査を PUB-G の前提に 1 項目として載せる（凍結外の dev fixture か integration で）。
4. **製品の連鎖（L-27 の続き）は DB 接続の根本改善の段 1 に吸収されない**（段 1 の失効の定義は「どの commit でも」を保ち、Verify の取消しの commit で同じ refused になる）。別の lane で、(c) 維持の連続 preempt の backoff と (f) Related Scenes の reconciler の no-wait 化を、**まず奪い手の特定の計装→設計→dev の A/B（基準／(c)／(c)+(f)。主指標は Verify の完了時刻と sample ごとの registration-unavailable／driftAtQuery）まで**進める。(a′)（refused を drift と incomplete に分け drift では Suspended にしない）は段 1 の PR-2（同じ関数 `nir1_graph.rs:604-688`）に同梱する。この lane を「U3 の委任の範囲内」とは断じない（委任の対象レーンに維持の coordinator は無く、DR-MPS は integrator の読み。記録は「DR-MPS と同じ読み＋重要な変更のどれにも当たらない」）。
5. **#838**（Quality の rust-cache。承認済み）は Gold の測定が済んだので、今進める。

**ユーザー本人に残す（1 回に束ねる）**

6. (1) **K6/2 の 621 行の受入れへの影響の発効（Lane unlocked、編集中の可用性を合否から外す緩和）と、「CP-4 の Graph arm は可用性を満たした」の確定**を、この結果（規則は HOLD に当たらない。ただし K6/6 の数え方に依存し、K6/2 の字義では HOLD）で行ってよいか。契約が「事前の確認にとどまる」と明記した部分で、委任はこれを上書きしない。(2) **品質判定の not-evaluable（既存 24 件の Graph arm の受領書、evidence の 4 項目、禁止寄与の (c)）を PUB-G の前に測るか**（PUB-G の合格基準＝前提一覧 #11 に触れる）：(i) 8 回目の S4 で受領書の形を広げて測る（DB 段 1 の PR-3 の S4 再凍結と束ねて S4 を 1 回で済ませる。推奨）、(ii) 開示して受け入れる。(3) **(g)**（LP-GATE を維持の cycle にも広げる。LP-GATE 案 2 の範囲の拡大）：dev で (c)+(f) が足りないと分かったときだけ、1 行確認の後に着手する。(4) **製品の連鎖を直した新しい候補での正式の取り直し**（やるなら。前例 DR-CP4-V-1 では、製品変更の候補の SP-P4 を新しい試行 1 と読んだ）。

**確認済み（2026-11-09T03:10:38Z、12:10:38 JST。AskUserQuestion の回答。原文は `user-confirmation-2026-11-09-s7r1-acceptance.md`）**

- 上の 6 の (1)：**「確定する（推奨）」**。K6/2:621 の受入れへの影響の発効（Lane unlocked など）と「CP-4 の Graph arm は可用性を満たした」は、ユーザーが確定した。K6/6 の数え方に依存すること、K6/2 の字義では HOLD、p95 の余裕 1.5 ms は開示として残る（6 を参照）。製品の公開・PUB-G の承認ではない。
- 上の 6 の (2)：**「8 回目の S4 で測る（推奨）」**。DB 接続の根本改善・段 1 の PR-3 の S4 再凍結と束ね、追加の S4 は増やさない。今始める承認ではなく、S4 の再凍結は PR-3 の段で別に進める。
- 残り：(3) (g) は dev の A/B で足りないと分かったときの 1 行確認、(4) 新しい候補での正式の取り直しは製品の連鎖を直した後の判断（どちらも未確認）。

## 6. 開示（必須）

1. **K6/6 の下の 1 回目の正式の測定**。first-render の数え方の改訂（R-6：準備の句、R-7：鮮度の印の句）を含む契約の下で測った。K6/6 の起案の前に s6r1 の結果を見ていたこと、S4 の 7 回目の経緯、dev の予行は S2・DR-CP4-P-10／S4-10 に開示済み。**s6r1 の受領書は K6/6 の判定に使っていない**。品質判定 v2 の D2・D3 は v1 に対する緩和（ユーザーの問 2）、C5 の前半の字義からの除外、C3 は入れなかった、は S2 `limits` (h) と v2 の凍結記録に開示済み。
2. **Gold の 2 回**（`s7r1-run-record.md`）。1 回目の `[precheck] V-10` の停止の理由、dev の再現（凍結外の fixture。凍結の材料の写しは K6/6 批准 9 により使っていない）、ユーザーの決定の時刻、2 回目の完了。2 回目の run は前の Gold 試行を開示している（13 receipt）。**ユーザーが取り直しを決めた時点で、1 回目の 3 variant の数値を見ていたか**：session の記録（18:19Z〜23:00:12Z の assistant の文と AskUserQuestion 5 件）に 1 回目の 3 variant の数値（欠落 0、表示 30、9／21 など）は無く、質問文は停止の事実と dev の再現だけだった（独立レビューの確認）。**記録 `ee468c48` の commit message の「同じ variant は parity では通った」は誤解を招く（parity は Graph arm を測らない）。その読みは取り消す**。
3. **欠落 0 は K6/6 の数え方に依存する**（3 の最初の項目）。K6/2 の字義では HOLD。
4. **trace の読み**。受領書（K6/2 の読み）は窓外 editing 178／201、browsing 198／201（物差しを超える）と記録する。これは K6/2 の読みの性質で、前回も同じ型。K6/4 の読みへの再計算は前回と同じ integrator の技術判断。再計算は keep test の証拠（8 件 pass）に依る。基準の再現（`recompute-trace-base`）は記録済み要約と完全一致した。JSON に写した証拠だけから K6/4 の読みが再現するかは未確認（keep test の再実行が要る）。
5. **K6/4 の N1 は 3 件**（記録の本文の 8 行目、DR の ⑤、contracts `259ec9bf` の message が 2 件と書いたのは誤り）。K6/4-N1 の検出力の記録は 3 件で読む（開示済み。記録は書き換えていない）。
6. **R5 の再利用の確認は閉包 7 file の変更だけを示していた**（`user-confirmation-2026-11-08-k66-r5-reuse.md`。#828〜#831 の製品変更は示していない。S2:951 に S3 B2-3 として開示済み）。候補 `3f333a83` には、R5 の記録の後に merge した製品変更（#829・#830・#831・#832・#839 など。integrator の調査文書の候補一覧）が含まれる。S4b の後に製品は変えていない（候補は S4b を master に merge commit で取り込んだ commit）。**#839（owner の Suspended の復帰の配線。復帰は 1 回だけ。CP2a-D47〜D49）は s6r1 の候補 `a2309b95` に無く、s7r1 の候補にある**（`git log --first-parent 179139b4..3f333a83`）。Suspended の連鎖に直結する変更だが、2 回目の Gold で Suspended が起きたこととの関係は未確認。
7. **G-01 の診断は判定外**（`countsInCaseJudgement: false`、別 session）。`reachedEndToEnd: true`、`firstMissing: null`。
8. **品質の判定は補助**で、S6 の規則を置き換えない。Graph arm の p95 の余裕は 1.5 ms（92.70／94.2 ms）。p95 は nearest-rank（ceil(0.95n)）で、線形補間なら 89.2 ms。上位 20 件が 92.7〜116.5 ms に密集しているので、1 件の揺れで上限を超えうる（再現性で余裕は容易に消える）。品質判定 JSON の `firstFormalRun.atUtc`（17:38:52Z）は SP-P4 receipt の `head.runStartedAtUtc`（admission の後）で、この README・run record の 17:45:09Z（台帳。setup の後）と別の時刻。
9. **記録の欠け**：`setups-s7r1/` と `g01-e2e-s7r1-1-report/` に `files.sha256` が無い（記録の写しの手順の欠け。`cmp` と `setup-receipts.sha256` で確認済み）。`ee468c48` の `negatives-s7r1-1/files.sha256` は空だった（negative 未実施のため。今回の commit で更新）。
10. **integrator の記録の時刻の訂正**：引き継ぎ file の見出しの時刻（07:00〜09:30）は時計を読まない推定で不正確だった。実測は引き継ぎ file の訂正に記載（ユーザーの決定の時刻は session の記録の timestamp）。
11. **S6 の script の直し**：集計 script の runId の正規表現の誤りで 1 回目の実行が `[precheck]` に落ち、直して再実行した（データの問題ではない。2 回実行して byte 一致）。
12. 窓：Gold（`gold-s7r1-2`）・parity・negative は全 variant で窓 true（chain の check で確認。sampler の違反・隙間の個別の数は S6 の `runs` を参照）。SP-P4 と trace は sampler の記録を持たない（設計）。
13. dev の診断 run（a1・a2）・dev の予告・dev の確認は CP-4 の結果に数えていない。
14. この報告は製品の公開（Graph の published 化）を何も決めない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
15. **委任と助言者**：ユーザーの委任の原文は「Fable に相談して決めてください」（2026-11-09T00:50:59Z）。独立した 2 人の助言者（Fable、read-only。1 人目：受入れ・Gold の 2 回目・`G-03/frontier-exceeded`、2 人目：製品の連鎖の lane・#838・not-evaluable）が、それぞれ契約・receipt・コードを自分で読んで助言した（確度は 1 人目：D1 中〜高、D2 高、D3 中〜高。2 人目：D4 の「吸収されない」が高、lane の選択が中、#838 が高、not-evaluable が中）。助言者は互いに相談していない。決めたことの責任は integrator にある。
16. **Gold の 2 回目の使用の根拠の訂正**：草稿の初版は「S2 の attemptRule で 1 回使い切っている」と書いたが、attemptRule は SP-P4 の規則（5 の 2）。本文を直した。ユーザーの決定の時刻（08:00:12 JST）は session の記録の timestamp に依る（助言者の 1 人はこの記録を読んでいない）。

## 7. 次

1. ユーザーの 1 行確認：(1)(2) は 2026-11-09T03:10:38Z に確認済み（5 の「確認済み」）。残りは (3) (g)・(4) 新しい候補での取り直し（dev の A/B の後）。
2. DR-CP4-S6-4（判断記録）の docs PR と #838 の merge（integrator が進行中）。
3. 製品の連鎖の lane（5 の 4）：奪い手の特定の計装→設計→dev A/B。記録先は DR-CP4-S6-4 と decisions 文書（GDX-PRECHECK-001 の判断・信頼境界・owner／lifecycle matrix を、mutation の前に残す）。
4. PUB-G の前提一覧（前提 #5・#24 に、維持の Verify の連打→refused→Suspended を足す。#11 の充足の形。frontier の端から端の検査）。
5. DB 接続の段 1、chat の IR（承認済みの順。実装は PUB-G の後）。
