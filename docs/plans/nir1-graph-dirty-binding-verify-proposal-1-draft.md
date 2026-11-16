# NIR-1 契約提案 GDV/1（draft）: Verify は、coherent で current でない declared Graph binding を「再構築できるが使えない」として扱い、保守を止めない（`graph-limited-binding` の改訂）

Status: draft／未確認。**改訂 6（最終確認の対象）**。改訂 5 を dev 試作で取り直し（試作 r5。記録 `05-gdv1-dev-results-r5.md`）、Opus の独立レビュー 4（`05-iii-review-opus-4.md`。必須 0・推奨 6・軽微 7）をかけ、両方の結果を本文に反映した（直した節の一覧は §18）。改訂 5 で変えた 3 点（§3.1 の判定の順、§3.2 の下流の gate の検査、§7 の before-cutover の拘束）は、試作 r5 で実装して確かめた。改訂 5 は、改訂 4 にレビュー 3 を反映した版だった（§17）。改訂 4 は、改訂 3 を dev 試作（§10。記録 `05-gdv1-dev-results.md`）にかけた版だった（§16）。試作が実施しなかった項目は、実装の PR の受入れ（§8 の【新規】）で確かめる。確認後は、この bytes の SHA-256 を台帳に記録し、本文は編集しない。この版には自分の SHA-256 を書かない。

- 前の版：
  - 初版 `05-iii-contract-draft.r0.md`（`dd1e8ed4a132a4525c2e00d2cf74b1a2053da899ebd302f28a123209e97f8aea`。(iii) だけの版）
  - 改訂 1 `05-iii-contract-draft.r1.md`（`5d3ed4774f698670b43627fcd9d8c0f6f0d3249aac9de564ef17397bc08c49a6`。3 案の比較の版）
  - 改訂 2 `05-iii-contract-draft.r2.md`（`3cb4212edd032f55cddd6d8db416ee93dc7f93f6afe65b3680461a5dc8d47869`。案 B だけで書き直した版）
  - 改訂 3 `05-iii-contract-draft.r3.md`（`c79acf19c213f8a8cc67b432d1c7be1c280411bf744e70c7aa3ac52639e516d5`。Opus の独立レビュー 2 を反映し、dev 試作にかけた版）
  - 改訂 4 `05-iii-contract-draft.r4.md`（`295057a830ef13643f45a22b4ebd32730d7976efee9c8e8f4c7ed82a3b0edf42`。dev 試作を反映した版）
  - 改訂 5 `05-iii-contract-draft.r5.md`（`dafd1e5a89a9bee66a1d2b41eebbcd839738a93d00098a81a648ccf48cb4f194`。Opus の独立レビュー 3 を反映し、試作 r5 にかけた版）
- 起案日と基点：2026-11-17。行番号は、明記がなければ製品 repo の `cea3988b`（#920）のもの。`l6-l9:N` は `docs/plans/nir1-l6-l9-execution-plan.md`（`cea3988b`）の行番号。「dev 枝」と書いた行番号は、dev 試作の枝 `claude/gdv1-dev`（head `2a01e0cc`、基点 `5eca1074`）のもの。改訂 6 で「dev 枝 `ec550a58`」と書いた行番号は、試作 r5 の head `ec550a58`（`2a01e0cc` の子孫。push していない）のもの。
- 改訂 4 の時点の `origin/master` は `f806138e`（#924、#921、#925）。`git diff --stat 5eca1074 f806138e` で変わったのは、試験（`nir1_entity_relation.rs` の mod 宣言 2 行、`nir1_entity_relation/a3_axis_reason_tests.rs`、`nir1_graph/tests.rs`、`nir1_graph/tests/a3_axes_fail_closed.rs`）と decisions 文書 2 つ（`cp4-decisions.md`、`perf-io-settle-decisions.md`）だけ。根拠にした Rust の本体、policy、l6-l9、B-close、`bseam-decisions.md` は変わっていない【事実】。`nir1_entity_relation.rs` の試験の行は、master では dev 枝より 2 行下がる。
- 改訂 6 で新しく引いた行（`repair.rs:776-792`、`c2z_preparation.rs:1434-1450`、`maintenance_runtime.rs:997-1004`・`:1110-1185` の `complete_foreground_system_work_run`、`:2783-2792` の `validate_live_verify_outcome_rebuild_requirement`、`c2zc_canonical_cutover.rs:238-249`、`restore_rebuild.rs:3521-3546`、`mod.rs:332-343`、`electron/native/grimodex-node/src/lib.rs:10497-10498`・`:10658`、`scripts/c2zc-rust-acceptance-receipt.mjs:127-153`、`evals/impact-map.yaml:902-924`）も、`f806138e` で読んだ行番号【事実】。`origin/master` が `f806138e` から進んだかは、改訂 6 では確かめていない【未確認】。
- 改訂 5 の時点の `origin/master` も `f806138e`。改訂 5 で新しく引いた行（`c2zc_canonical_cutover.rs`、`c2z_preparation.rs`、`repair.rs`、`maintenance_contracts.rs`、`maintenance_runtime.rs` の recovery と discovery の行、`nir1_entity_relation.rs:2766-2777`、`electron/native/grimodex-node/src/lib.rs`）は、`git -C <repo> show f806138e:<path>` で読んだ `f806138e` の行番号【事実】。
- 改訂 3 の時点の `origin/master` は `5eca1074`（#923＝DB 段 1 PR-3、#922＝docs）。改訂の根拠にした箇所が `cea3988b` から変わっていないかを `git diff cea3988b 5eca1074 -- <path>` で確かめた【事実】。
  - **変わっていない（差分 0 行）**：
    - Rust：`restore_rebuild.rs`、`verify_coverage.rs`、`maintenance_runtime.rs`、`maintenance_skip_evidence.rs`、`nir1_entity_relation_index.rs`、`source_revision.rs`、`repair.rs`、`declaration_storage.rs`、`nir1_graph_index_maintenance.rs`、`maintenance_contracts.rs`、`c2z_preparation.rs`、`terminal_failure.rs`、`incremental_freshness.rs`。
    - policy：`policies/narrative/narrative-consumer-contract.json`、`semantic-core-authorities.json`。
    - 文書：`nir1-l6-l9-execution-plan.md`、`nir1-b-close-completion-2026-09-22.md`、`nir1-l6-l9-contract-proposal-7-draft.md`、`nir1-c-query-acceptance-2026-10.md`、`nir1-lane-decisions/graph-registration-window-decisions.md`。
  - **変わった file**：`src-tauri/` で変わったのは 5 file だけ。どれもこの草案の根拠ではない。
    - `lib.rs`：試験用の probe の追加。
    - `nir1_graph.rs`：`c_query_freshness` の mod の削除。
    - `nir1_graph/c_query_freshness.rs`：削除。
    - `nir1_graph/tests/cq_avail.rs`、`src/tests.rs`：試験。
  - 作業記録 `nir1-continuation-2026-10.md` は変わった（17 行）。根拠には使っていない。
  - **時期に関わる変化**：#923 は枝 `claude/s4-9-pr3` の merge（`cc8c69b9`）で、`70a07561`「CP-4 S4b（9 回目）— … frozen-before-observation にし、観測前の freeze record を…導入する」と `a59e7921` を含む【事実：`git log`】。
    - 9 回目の S4 の PR は、`5eca1074` で merge 済みに見える。
    - 選択の段の回答の条件「実装は次の S4 の PR の後」が、これで満たされたかは integrator が確かめる。この版は時期の決定そのものを書き換えない。
    - 本文の「次の S4（9 回目）の PR の merge の後」は、この条件を指す。9 回目の正式 run には GDV/1 は入らない（実装していないため）。
- 経緯：
  - PUB-G #5 の Q1 の回答「(iii) を起案する」（contracts `ed90f78b`）を受けて、(iii) を起案した。
  - Opus の独立レビュー 1（`05-iii-review-opus-1.md`）の後、3 案を比べ直した。
  - 選択の段の回答（contracts `b8a9ea86` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-17-gdv-choice-and-perf-retry.md`）：
    - **案 B（＋案 C）**
    - **実装は次の S4 の PR の後**
    - **契約の改訂（GDV/1）として確認する**
  - この回答は、`ed90f78b` の回答を置き換える（記録自身がそう書く）。**選択の段の記録は確認ではない。**
  - 改訂 2 に、Opus の独立レビュー 2（`05-iii-review-opus-2.md`）。必須 3・推奨 8・軽微 7。改訂 3 で全部に答えた（§15）。
  - 改訂 3 を、dev 試作にかけた（枝 `claude/gdv1-dev`、head `2a01e0cc`、push していない、PR なし。記録 `05-gdv1-dev-results.md`）。T-1〜T-8、T-11、T-12 は合格。改める点が 5 つ出た。改訂 4 で反映した（§16）。
  - 改訂 4 に、Opus の独立レビュー 3（`05-iii-review-opus-3.md`）。必須 2・推奨 6・軽微 5。改訂 5 で答えた（§17）。
  - 改訂 5 を、dev 試作で取り直した（試作 r5。同じ枝、head `ec550a58`、push していない、PR なし。記録 `05-gdv1-dev-results-r5.md`）。改める点が 8 つ出た。並行して、改訂 5 に Opus の独立レビュー 4（`05-iii-review-opus-4.md`）。必須 0・推奨 6・軽微 7。改訂 6 で両方に答えた（§18）。
- 記法：
  - 【事実】：この起案で読んだもの（file:line つき）。改訂 3・4 で自分で読み直したものも含む。【事実：dev 枝】は、dev 枝の差分を起案者が `git diff`／worktree で読んだもの。
  - 【レビュー 1】：Opus のレビュー 1 が読んだもので、起案者は読み直していないもの。
  - 【レビュー 2】：Opus のレビュー 2 が読んだもので、起案者は読み直していないもの。
  - 【レビュー 3】：Opus のレビュー 3 が読んだもので、起案者は読み直していないもの。起案者が読み直した行は【事実】と書く。
  - 【レビュー 4】：Opus のレビュー 4 が読んだもので、起案者は読み直していないもの。起案者が読み直した行は【事実】と書く。
  - 【V0】：V0 の試験の観測（合成データ、`05-v0.md`）。
  - 【試作 T-n】：dev 試作の観測（合成データ、`05-gdv1-dev-results.md`）。起案者は試験を実行しておらず、記録を読んだ。
  - 【試作 r5 T-n】：試作 r5 の観測（合成データ、`05-gdv1-dev-results-r5.md`）。読み方は【試作 T-n】と同じ。試験が値を assert したものと、出力の記録だけのものは、各所で書き分ける。
  - 試作 r5 の fixture の注：前の試作（`05-gdv1-dev-results.md`）の fixture は、すべて cutover の marker がある DB だった（共通の fixture が marker を書く）【試作 r5】。そのため、【試作 T-n】の「Idle に達した」は、marker がある DB での観測である。marker が無い DB の観測は【試作 r5 T-n】だけで、同じ fixture の marker の行を消して作った近似の形（Revision と Freshness の行は marker がある状態で書かれている）。
  - 【推測】：読みからの推論。
  - 【未確認】：確かめていないもの。
  - 起案者はコードと試験を実行していない（read-only の起案）。実行は dev 試作が行った。
- 呼び方：
  - 「B」：whole-project の Graph Index build。
  - 「binding」：B が publish した Graph の面（metadata、D1 head、V1 の edge、canonical Freshness の 4 面）。
  - 「current でない」：構造は coherent だが、dirty であるか Freshness が current でないこと（§3.1 で定義する）。
  - 「次の S4」：9 回目の S4（その PR は #923 で merge 済みに見える。上の「時期に関わる変化」）。
  - 「S-1〜S-5」：§2.2 の表の 5 か所。

## 0. 最終確認で決めること（要点）

- **何を解くか**：
  - B の binding がある project で容量を超え、B の再構築が拒否されると、binding が dirty のまま残る。
  - すると Verify がその Graph を manual の defect として扱うか、Graph の Source を全部読もうとして容量で落ちる。その project の自動の保守（依存検証とその先の連鎖）が止まり、自動では戻らない【V0】。
  - Verify が通っても、その先の Rebuild-Derived が同じ Source を読んで容量で落ちる経路がある（S-5、レビュー 2 の M-1）。
  - B は製品で公開していないので、今の利用者への影響は無い。
- **新しい読み**：
  - Verify と、その完了証跡の digest と、Rebuild-Derived の V2 shadow は、**coherent で current でない declared Graph binding** を、consumer contract（`narrative-consumer-contract.json:69`）がすでに書いているとおり「recognized unavailable（rebuildable-not-query-usable）」として扱う。
  - その Graph の edge を、unresolvable や Source の欠落の検査の対象にせず、Graph の Source（whole-project の eligibility）を読まない。
  - 「coherent」は、reader の構造の読み（`read_internal(…, true, true, …)`）と同じ条件で決める。eligibility は読まない（§3.1）。
  - binding は消さない。Graph は B が再 publish するまで unavailable のまま（R+IR に戻る。今と同じ）。
- **変えないもの**：
  - データの書込み、writer、D1、generation、l6-l9:506（成功時だけ sealed head を更新）、B-close の数値と句、policy の file、閾値、Gold、評価の手順（K6/7、S2、harness）、UI。
  - 推奨の K-2 (b) では、Verify の契約の座標（`VERIFY_CONTRACT_VERSION` を含む）も変えない（§3.3）。
- **緩和は 9 つ**（§5。GDV-R1〜R9）。改訂 2 の 7 つに、改訂 3 で Rebuild の V2 shadow（GDV-R8）と、Repair の seal ほか下流の gate（GDV-R9）を足した。**改訂 4 で緩和の数は増やさない。** 試作で分かった事実で、GDV-R1・R3・R4 の開示を改めた（下の「開示が変わる点」）。**改訂 5 でも 9 つのまま**：GDV-R1・R4 の改訂 4 の追記（今の epoch が無い形）を削り（レビュー 3 の M-1）、GDV-R9 を狭めた（M-2。Repair の seal と C2Z の readiness は閉じたまま）。**改訂 6 でも 9 つのまま**：GDV-R9 の「開く」に、foreground の Verify の完了（skip の証跡の seal の 3 つ目の位置）を名指しした。同じ種類の緩和なので、数は増えない（レビュー 4 の m-4）。
- **足す名前**（改訂 6 で決めた。レビュー 4 の R-3）：Repair の拒否の code `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE` と、C2Z の readiness の Verify の gate の reason `verify-graph-recognized-unavailable`（cutover の `NEX_C2ZC_CUTOVER_NOT_READY` の message にも出る）。ほかに、本文に既にある report の欄 `consumersExcludedNotCurrent`、S-4 の印 `{"status":"recognized-unavailable"}`、shadow の diagnostics の code `NEX_V2_SHADOW_REBUILD_RECOGNIZED_UNAVAILABLE`。reader の理由の集合と画面の文言は変えない（§3.2、§11）。
- **K-2（座標）は 2 案を本文に書き、(b)「上げない」を推奨する**（§3.3）。最終確認の質問で、(a)「`VERIFY_CONTRACT_VERSION` を `"10"` に上げる」を選べる（§11）。(b) の byte 互換は試作で確かめた。(a) は試作していない。
- **案 C**（main 由来の durable な work より先に B の判定を通す）は、委任の内の lifecycle の技術判断として DR に残す（§7）。**改訂 6**：試作の形の案 C は、main が RebuildDerived の work を渡す形で、全部の wake の後も Graph の publish を 1 回多く残した（費用。§5、§7）。DR では、試作の形のまま費用を開示する、範囲を狭める、やめる、の 3 つから選ぶ。どれを選んでも契約の文（§3）と止まらないことは変わらない（案 C が無くても止まらない）。
- **実装の時期**：次の S4（9 回目）の PR の merge の後（選択の段の回答）。9 回目の正式 run には入らない。
- **dev 試作の結果**（§10）：
  - 動機の形（V0 の (b)）の binding は、reader の構造の読みで `Registered{dirty:true}` になり、helper は recognized not-current とした（T-1 (0)）。製品の経路の wake は Err を返さず、Idle に達した。digest の側の失敗も避けられた（T-1、T-2）。
  - Rebuild の V2 shadow の失敗は、S-5 がなければ実際に起き、S-5 で避けられた（T-11）。
  - K-2 (b) の byte 互換は成り立った（T-5）。推奨は (b) のまま。
  - 案 A に戻す材料は出なかった。
- **試作 r5 の結果**（改訂 6。§10.4）：
  - 改訂 5 の 3 点を実装した head で、動機の形は marker がある DB でも無い DB でも、製品の経路の wake#1 で Idle に達した。Finding は 0、Err は 0【試作 r5 T-1】。
  - marker が無い DB では、Graph は publish されうる（gate を開けた起動で）。(x) の検査が cutover を止め、marker は書かれない。Run の数は増え続けない（8 round の観測）。(x) の検査を外した (y) では、同じ形で cutover が成功した【試作 r5 T-1】。
  - (x) の検査は、Repair の seal を `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE` で拒み、C2Z の Verify の gate を reason `verify-graph-recognized-unavailable` で `Blocked` にした（試験が code と reason を assert）。current な Graph でも、別の理由（制御なしの digest の `context-unavailable`）で閉じている【試作 r5 T-7】。
  - 案 C の余分な publish は、順序の違いではなく総数の差として残った【試作 r5 T-3】。
  - `semantic-graph-requires-repair` の Finding は、dev の経路ではどの形でも作れなかった【試作 r5】。
- **開示が変わる点**（改訂 4。§5 と §11 に名指しする。改訂 5・6 で直した点には「改訂 5」「改訂 6」と書く）：
  - 改訂の前に Verify が容量で failed になって止まった project は、GDV/1 の後も、**同じ Semantic Epoch の間は自動では戻らない**（T-9 (ii)。範囲は改訂 5 で限った）。
  - **改訂 5**：今の Semantic Epoch が無い形は、recognized not-current に入れず、今のまま full validation に渡す（§3.1。レビュー 3 の M-1）。改訂 4 の開示「B が直さない not-current の形」は無くなる。
  - Edge State が stale か別の epoch の形は、current と分類されて manual のまま。**B も直さない**（`Skip{BindingCurrent}`。T-6 (4)）。残る止まり。
  - B-ROUTE の main の wake（DR-BSEAM-1 (b)）の前提「制御なしの planner は sealed な binding で `context-unavailable` になる」が、not-current の binding では成り立たなくなる。GDV-R3。
  - **改訂 6**：試作の形の案 C は、seam の下で main が RebuildDerived の work を渡す形で、**全部の wake の後も** Graph の publish を 1 回多く残す（generation 3。案 C なしは 2。build の起動の総数は 3 回と 1 回）。main が Verify の work を渡す形では差が無い【試作 r5 T-3】。§5、§7。
  - **改訂 5**：作り直し待ちの Graph がある project でも、**Repair の seal と C2Z の readiness は今どおり閉じたまま**にする。C2-ZC の不可逆な cutover は C2Z の readiness を先に要るので、これも閉じたまま（§3.2、GDV-R9。レビュー 3 の M-2 の (x)）。current な Graph でも、これらは今、制御なしの読みが `context-unavailable` になって閉じている。両方の状態で閉じる形にそろえる。**改訂 6**：閉じる理由の code は状態で違う（not-current は (x) の code・reason、current は `context-unavailable`）【試作 r5 T-7】。
  - **改訂 6**：cutover の前の DB（marker なし）で作り直し待ちの Graph があると、cutover は進まない。自動の保守は Idle に達し、Run の数は増え続けない【試作 r5 T-1】。改訂 5 の「この形での Idle は主張しない」は取り消す。
- **既存の試験 3 件**が、dirty な Graph の旧い扱いを assert していて落ちる。実装の PR で書き換える（§8）。
- **試作で実施しなかった項目**は、実装の PR の受入れ（§8）に回す。§8 のどれかが通らず本文と食い違えば、実装を止め、版を改めて改めて確認を伺う（§1.3）。

## 1. 確認の扱い

### 1.1 draftRef と contractId

- draftRef：`nir1-graph-dirty-binding-verify-proposal/1`（略称 GDV/1）。名前は master（`cea3988b`）と contracts で未使用【事実：`git grep`】。
  - 新しい family にする理由は 2 つ。
  - `nir1-l6-l9-contract-proposal/8` という名前は、proposal/7 と CQ-LIM の文書が、条件付きの予告や未決の論点に使っている（`nir1-l6-l9-contract-proposal-7-draft.md:93,111,118`、`nir1-c-query-acceptance-2026-10.md:705,865,868`）。
  - 同じ contractId に新しい family を使う前例が、SDEF/1 と K2/4 の B2-2 にある。
- contractId：`graph-limited-binding`。改訂するのは、Graph の binding を Verify、full-set validation、Rebuild の V2 shadow がどう扱うかの句（§3.2）。
- 確認の範囲は、ちょうど 1 つの `draftRef#contractId`（`nir1-graph-dirty-binding-verify-proposal/1#graph-limited-binding`）。K-2 の 2 案は、この 1 つの確認の中の選択肢として扱う（§11）。
- consumer contract と POL-SC の宣言は変えない（§4）。既存の文が、この読みの根拠になる。実装で文の追加が要ると分かれば、最終確認の前に版を改め、別の確認の要否を integrator が判断して記録する。

### 1.2 台帳の行とその位置（確認の後の記録。この draft の外で行う）

| 場所 | 改訂 |
|---|---|
| 「契約別の確認台帳」の補足（l6-l9:121-437） | 新しい補足「2026-11-xx補足（GDV/1）」と行 `GDV/1-1` を、その時点の最後の補足の後、`### R0 security contract proposal (draft)` の前に足す。今の最後の補足は DMS/1（l6-l9:345-351）で、見出しは :438。/5・/6・/7 の行と記録は消さず、置き換えない（加算で並ぶ） |
| 契約の一覧表（l6-l9:359-） | `graph-limited-binding` の行を、:388（/7）の下に 1 行足す。confirmedRef は `nir1-graph-dirty-binding-verify-proposal/1#graph-limited-binding`。confirmedScope は §3 の範囲、GDV-R1〜R9、K-2 で選ばれた案 |
| `#### graph-limited-binding` 節（l6-l9:478-549） | 本文は確認時点の履歴として残す（K1 の前例）。「Outside-initial-build full-roster validation」の節（l6-l9:510-516）と Mandatory defenses の行（:488）の直後に「履歴の注：GDV/1 で追補。正本は下の GDV/1 の節」を足す |
| 新しい節 `#### graph-limited-binding (GDV/1 confirmed contract)` | proposal/6 の節（:551-）の /7 の追記の後に置く。中身は §3（新しい読み）、§5（緩和）、§6（threat model）、§8（受入れ） |
| 作業記録（`nir1-continuation-2026-10.md`） | 確認の記録の ID と記録先、DR（案 C を含む）の ID を 1 行 |

- 台帳の `graph-limited-binding` の行は、B2-3（proposal/7、l6-l9:153）が最後【事実】。

### 1.3 段取り

1. 改訂 3（済み）。
2. **確認の前の非判定の dev 試作**（§10。凍結の外、dev 枝、push しない）（済み）。結果で本文と食い違った 5 点を、改訂 4 で直した（§16）。
   - digest か Rebuild の側の失敗は避けられた。案 A に戻す必要は出なかった。
   - K-2 (b) の byte 互換は成り立った。推奨は (b) のまま。
   - 改訂 4 に Opus の独立レビュー 3 をかけ、改訂 5 で反映した（§17）。
   - 改訂 5 の 3 点（判定の順、下流の gate の検査、before-cutover の拘束）を試作 r5 で実装して取り直した（済み）。改める点 8 つと、Opus の独立レビュー 4 を、この改訂 6 で反映した（§18）。
3. **最終確認**（1 問、§11）。対象はこの改訂 6。質問の文は、draftRef、contractId、この版の SHA-256 を名指す。K-2 の案は選択肢で選ぶ。
4. 確認の記録（contracts に `user-confirmation-2026-11-xx-gdv1-graph-limited-binding.md`。選ばれた K-2 の案を書く）→ 台帳の PR（draft を byte 同一で取り込み、`sha256sum` の一致を確かめる）→ 実装の PR（次の S4 の PR の merge の後）。
5. **実装の PR の受入れ（§8）**で、試作が実施しなかった項目（§10.3）を確かめる。
   - §8 のどれかが通らず、§3・§5 の文（緩和・開示・残る止まり）と食い違えば、実装の PR を止める。版を改め（新しい版の bytes と SHA-256）、改めて確認を伺う。確認された bytes は直さない。
   - 食い違わない不合格（試験の作り方の誤りなど）は、実装の PR の中で直し、PR 本文に書く。

### 1.4 委任との関係

- 契約の改訂として確認する（選択の段の回答）。理由は、Verify の挙動を変え、検査の対象を減らす緩和があるため。
- 確認された後の実装の細部（判定の helper の置き場所、試験の形）は、C-product レーンの委任の内の技術判断として DR-PUBG-5-n に残す。改訂 6 で、外から見える名前（report の欄、S-4 の印、shadow の diagnostics の code、(x) の拒否の code と reason）は本文で決めた（§0 の「足す名前」）。内部の分類の名前（`NoCurrentEpoch` など）は実装の判断に残す。範囲は §3 の内に限り、§3.3 の K-4（置き場所の拘束）と、選ばれた K-2 の案の拘束を守る。
- 案 C は、委任の内の lifecycle の技術判断（§7）。
- `discover_all` の Err の封じ込めは、この契約と別に、委任の内の技術判断で扱う（#5 の Q1 の回答）。
- 委任の外のもの（閾値の緩和、新しい送信先、保存範囲の拡大、製品の公開、認可の削除、新しい authority）は、この改訂に入れていない。GDV-R9（下流の gate）は、改訂 5 で狭めた（Repair の seal と C2Z の readiness は閉じたまま）。位置づけは §5 の GDV-R9 に書く。

## 2. 今の読みと事実

### 2.1 確認済みの文と宣言

- consumer contract（`narrative-consumer-contract.json:69`、`semantic-index` の notes）【事実】：
  - 「Unknown or incoherent identities have no Narrative dependency authority claim…their non-zero footprint is manual-terminal and never a Rebuild-Derived target.」
  - 「**A recognized dirty, pending, paused, or cold NIR-1 index is rebuildable but not query usable** until the canonical evaluator and current Native proof qualify it.」
- POL-SC の Graph の declaredBinding（`semantic-core-authorities.json:155-181`）【事実】：
  - `recognizedUnavailable: "rebuildable-not-query-usable"`
  - `queryUsability: "canonical-fresh-and-clean-current-native-proof"`
  - `unknownOrIncoherentBinding: "manual-terminal"`
- 台帳は、consumer contract の宣言済み binding を、`graph-limited-binding` と並ぶ承認済みの baseline に挙げる（l6-l9:482）【事実】。
- l6-l9 の `graph-limited-binding`（proposal/5 の確認済み）：
  - Mandatory defenses（l6-l9:488）「dirty／unknown／digest mismatchはwhole-Graph unavailable」。
  - Outside-initial-build full-set validation（:495）。「Source re-resolution、is_complete_registered／complete registration／coverage verification…」を owner の build-resource contract に束縛する。同じ行に「cancel／timeout／closedはwhole attemptをterminateし、missing Source、per-edge diagnostic、successful verificationへcoerceしない」【事実】。
  - full-roster validation の節（:510-516）：
    - :513「Source re-resolution: …current Sourceを再解決し、unowned／unbounded full-roster scanを開始しない」。
    - :514「complete registration/coverage verification (`is_complete_registered`): 同じowned validation attemptで全件registration／coverageを検証し、unowned／unbounded full-roster scanを開始しない」【事実】。

### 2.2 今のコードの読み（食い違い）

consumer contract は dirty を「再構築できるが使えない」と書くが、今の保守は dirty な binding も full validation と Source の解決にかけ、通らなければ manual に倒すか、容量で落ちる。

**読んで分かった箇所は次の 5 か所。網羅は主張しない**（改訂 2 は 4 か所と言い切り、S-5 を落とした）。網羅の確認は、経路の列挙ではなく、連鎖が端まで進むことを試作 T-1・T-11 で確かめる形で行う。

| # | 場所 | 今の挙動 |
|---|---|---|
| S-1 | Verify の分類（`restore_rebuild.rs:5465-5492`） | reserved な semantic-index の consumer は、`is_complete_registered_with_control` が true のときだけ declared と読む。false なら、その consumer の edge を全部 `edge_ids_with_unresolvable_consumer_scope` に入れる【事実】 |
| S-2 | Verify の edge ごとの Source の検査（`:5494-5528`） | declared の consumer の edge ごとに `edge_source_is_missing_with_control` を呼ぶ。edge の形の検査（malformed、`:5496-5500`）は declared かどうかによらず全 edge に行う【事実】 |
| S-3 | semantic index の footprint の検査（`verify_coverage.rs:442-562`） | 4 面の件数から、`is_complete_registered…` が true の binding の分だけを引く（`:513-535`）。残りが 0 でなければ、incomplete に `reserved-consumer-kind-footprint` を入れる（`:547-560`）【事実】 |
| S-4 | Verify の完了証跡の digest（`durable_graph_state_digest_with_control`、`restore_rebuild.rs:2589-2598` → `_within_capacity` `:2600-`） | project の全部の edge について、`durable_edge_resolution_input_with_control`（`:5349-5420`）で Source の今の状態を解決し（`:2653-2688`）、`edgeResolutionInputs` として digest に入れる【事実】 |
| S-5 | Rebuild-Derived の V2 shadow（`verify_v2_shadow_for_rebuild_in_tx_with_control`、`restore_rebuild.rs:1729-1884`。呼出しは保守 cycle の `:1313-1320` と graph control の `:2044-2046`） | project の D1 head を `consumer_kind` で絞らずに全部回る（`declaration_storage.rs:199-216`）。entry ごとに `rebuild_source_change_class_from_source_with_control` → `resolve_current_source_state_with_control` で Source を解決する（`restore_rebuild.rs:1799-1807`、`:1901-1942`）。validation-terminated の Err は、そのまま Rebuild の Err になる（`:1785-1787`、`:1952`）【事実】 |

- S-4 の digest には、edge の解決のほかに、binding の identity の面がすでに入っている【事実】。
  - edge の行（`:2628-2651`）、edge state（`:2690-2711`）、Consumer Freshness（`:2712-2736`）。
  - semantic index の metadata（`index_key`、`generation`、`built_at`、`source_digest`、`dependency_set_digest`、`dirty_cache_flag`。`:3127-3148`）。
  - D1 の set・entry・head（`:3149-3203`）。
- `is_complete_registered_with_control` は、dirty を見る前に full eligibility を読む（`nir1_entity_relation_index.rs:2687-2702`）【事実】。dirty でも、候補が 2,064 件を超えれば容量で落ちる。
- Graph の D1 entry と V1 の edge には、eligibility の Source（`project:nir1-entity-relation-eligibility:{project}`）が必ず入る【事実】。
  - build は `source_key(project)` を source の集合に入れる（`nir1_entity_relation_index.rs:2951-2955`）。
  - publish は edge の列から D1 の declaration を作る（`:3104-3113`）。
  - reader はこの entry があることを `Registered` の要件にしている（`:2533-2539`）。
- `infer_source_kind` は、この identity を `nir1_entity_relation_index::SOURCE_KIND` に写す（`restore_rebuild.rs:455-456`）【事実】。
- その解決は `resolve_source_revision_with_control_and_reads` の eligibility の分岐（`source_revision.rs:268-290`）に届き、whole-project の eligibility を読む【事実】。
  - 制御なし（`allows_full_eligibility` が false）なら `ContextUnavailable` で終わる（`:269-274`）。
  - 制御付きでも、候補の超過で容量の Err になる【レビュー 2：`nir1_entity_relation_index.rs:1318-1323`、`:2153-2167`】。その理由の `CapacityExceeded` は `ValidationTerminationReason` の 1 つ（`source_revision.rs:91-100`）【事実】。そのため `is_validation_terminated` に当たり、S-5 の `:1952` では `ComponentUnavailable` に握りつぶされず、Err のまま返る。
  - 試作で、S-1〜S-4 だけを入れた build（S-5 なし）を動機の形で回すと、`semantic-index-rebuild` の Run が `capacity-exceeded: NIR1_GRAPH_CAPACITY_EXCEEDED: candidate-rows exceeds 2064` で failed になり、その後は Rebuild を繰り返さず止まった（Finding 1 件、Idle に達しない）【試作 T-11】。Err が discovery と cycle のどちらで返ったかは試験の helper が区別しておらず、failed の Run の message からの読み【推測】。
- **V0 の (b) の失敗の場所**は S-4 だった：main の制御なしの discovery → `validate_discovered_verify_outcome` → `validate_graph_state_digest_with_control` → `durable_graph_state_digest_with_control`（`maintenance_runtime.rs:2558-2569,2732-2760`）【V0 と事実】。binding の状態に関係なく、Graph の edge がある限り読む。
- **S-5 は今は表に出ない**。dirty な binding では Verify（S-1 か S-4）が先に落ちて、Rebuild に届かないから【レビュー 2、推測】。GDV/1 が Verify を通すと、初めてこの経路に届く。
  - V2 shadow の結果は永続しない。`RebuildDerivedStateSummary` の `v2_shadow` は `#[serde(skip)]` で、in-process の呼出し元にだけ返る（`restore_rebuild.rs:1150-1154`）。集計は捨てられる（`:1873-1879`）【事実】。
  - Rebuild の consumer ごとの loop は、reserved な semantic-index を飛ばす（`:1338-1341`）。V2 shadow には、その除外が無い【事実】。
- B-ROUTE の設計は、「Verify は、未検証の declared binding の edge を全部 manual の defect にする」ことを前提に、B が Verify より先に直す（preempt）。該当の注は `nir1_graph_index_maintenance.rs:579-584` と `maintenance_runtime.rs:2349-2356`（`discover_cycle_work` の doc）【事実】。
- **B-ROUTE の main の wake（DR-BSEAM-1 (b)）**【事実：`maintenance_runtime.rs:2311-2346`（`5eca1074` と dev 枝で同じ行）、`docs/plans/nir1-lane-decisions/bseam-decisions.md:10`】：
  - main の discovery（`discover_maintenance_project_for_main`）は、制御なしの durable planner（`discover_durable_maintenance_work_with_coordinates`）の答えを返す。
  - seam の下で、planner が `context-unavailable` で落ちたら `GraphIndexBuildWake` に変える（`:2338-2345`）。planner が `Ok(None)` でも `GraphIndexBuildWake`（`:2336`）。`Ok(Some(work))` なら `Work` を返す（`:2335`）。
  - DR-BSEAM-1 (b) は、「sealed な Graph（と Chronicle）の binding があると、制御なしの planner は Verify の再利用の判定で eligibility を読み、`context-unavailable` で落ちる」を原因として記録し、B-ROUTE はちょうどそれを wake に変える。
  - GDV/1 の後、recognized not-current の Graph の binding だけを持つ project では、制御なしの planner は落ちずに `Ok` を返す【試作 T-1・T-8・T-10】。current な Graph の binding と Chronicle の binding では、今のまま `context-unavailable` で落ちる【試作 T-2 (5)】。
  - そのため not-current の binding では、main は `Work(Verify)` か、（durable chain に work が無ければ）今と同じ `GraphIndexBuildWake` を返す。`Work(Verify)` のとき、B の判定は cycle の中に移る（案 C、または cycle の最後の rediscovery）【試作 T-3】。§5 GDV-R3、§7。

### 2.3 止まり方（V0）

- binding が dirty で B が `RefusedUnchanged` のとき、Verify は容量で failed になり（S-1 か S-4）、`ManualIntervention` の Finding が出る。その project の自動の保守が止まる【V0】。
- 候補の超過では、main の制御なしの discovery が、S-4 の中で `context-unavailable` の Err を返し続ける【V0】。
  - これは V0 の条件での観測。gate が開いていて reason が before-cutover でないときは、`GraphIndexBuildWake` に変わる【レビュー 2：`maintenance_runtime.rs:2291-2298`、`:2338-2345`】。
- **binding が無い project では、同じ超過でも Idle**【V0 の対照】。Graph の edge も D1 head も無いので、S-1〜S-5 のどれも Graph を読まない。
- 容量以外の拒否（期限、契約の code）でも、dirty な binding のまま `RefusedUnchanged` になれば、S-1 で manual の分岐（`semantic-graph-requires-repair`）に入る【事実：`maintenance_runtime.rs:2636-2665`】。期限の拒否で dirty のまま残る形は、試作で GDV/1 の後に止まらないことを確かめた【試作 T-4】。変更の前の build での期限の形は実行していない。
  - 改訂 6：ただし、sealed な Graph の binding を持つ project では、この Finding は dev の経路（製品の discovery、制御つきの wake、制御つきの Verify の cycle）のどれでも作れなかった。制御なしの digest が `context-unavailable` の Err を先に返し、Finding の projection に届かないため【試作 r5：current と分類される形 2 つと incoherent の形 4 つ。Verify は completed で、Graph の edge は unresolvable に入った】。作れなかったことは、実際の DB でこの Finding が生じないことまでは示さない【未確認】。
- **Verify が failed になった後**：
  - 試作で、変更の前の build で Verify が容量で failed（Finding 1 件）になった DB を、変更の後の build で開いて wake を重ねた。discovery は毎回 `Work(Verify)` を返し、cycle は Accepted だが、新しい Run は作られなかった（Run の数も Finding も変わらない）【試作 T-9 (ii)】。
  - 機構の読み：cycle は work ごとに recovery の判定（`decide_run_recovery_for_epoch`、`maintenance_runtime.rs:4697-`）を通す。retryable でない分類の failed の Run には `RecoveryAction::ManualIntervention` を返し、cycle はその work を noop で閉じる（`:3329-3344`）【事実：`5eca1074` の行】。
  - 改訂 5：T-9 (ii) の経路がこの分岐であることを、コードで確かめた【事実：`f806138e`】。failed の message の先頭の code は `NEX_VALIDATION_TERMINATED`（`explicit_failure_code`、`:4258-4262`）。この code は retryable の一覧（`classify_failure`、`:4278-4292`）に無いので、`retryable=false` になり、`ManualIntervention` が返る（`:4740-4745`）。message が `NEX_VALIDATION_TERMINATED:capacity-exceeded…` で始まることは、試作の記録による【試作 T-9】。
  - この判定は、work と epoch で引いた ledger の上で行う【レビュー 3：`read_run_ledger_for_epoch`。起案者は読み直していない】。Verify の work key は `dependency-verify:{epoch}` で、契約の版を含まない（`c2zc_canonical_cutover.rs:266`、`terminal_failure.rs:338`）【事実】。したがって「自動では戻らない」は、**同じ Semantic Epoch の間**のこと。restore などで epoch が変われば、新しい work の ledger になる【推測。試していない】。
- 試作で、変更の前の build で Verify が completed・non-clean の形を作ったが、`semantic-graph-requires-repair` の Finding は作れなかった（cycle が `context-unavailable` の Err で終わった）【試作 T-9 (i)】。

### 2.4 順序（案 C の理由）

- 制御付きの cycle の discovery（`discover_cycle_work`、`maintenance_runtime.rs:2357-2400`）は B を先に判定する【事実】。
- しかし cycle は、request に work があれば `discover_cycle_work` を呼ばず、その work を B の判定なしに dispatch する【事実：`:3045-3058`】。
- main の制御なしの discovery は、durable の Work を B の wake より先に返す（`:2335`）【事実】。そのため、main が返した Verify や RebuildDerived が B より先に走りうる【V0：`05-v0.md:29,31`】。

### 2.5 Verify の再利用と契約の座標【事実。ただし断りのあるものを除く】

- 完了済みの clean な Verify の再利用（`evaluate_completed_run_skip_with_control`、`maintenance_skip_evidence.rs:345-605`）は、skip の証跡の値の一致だけでは決まらない。
  - 証跡の値：契約の座標の 5 つ（`graph_contract_digest`、`rule_registry_digest`、`producer_generation_set_digest`、`rebuild_contract_version`、`run_kind_contract_version`）と、データの CAS の `graph_state_digest`。証跡の struct は 11 の field を持つ【レビュー 2：`:55-80`】。
  - そのうえで、次の (a)〜(d) を順に要求する。
    - (a) 保存された report が、今の型 `DependencyGraphVerifyReport` に deserialize できる（`:538-544`、`successful_outcome_digest` `:1091-`）。
    - (b) `is_clean()`（`:545`）。
    - (c) `graph_state_digest` の一致（`:554-564`）と、`validate_report_rebuild_required_with_control`（`:565-578`）。
    - (d) **Verify を今その場でやり直し、serialize した report の digest が、保存された `report_digest` と byte で一致する**（`live_verify_report_matches_sealed_with_control`、`:579-589` → `:727-756`）。
- report の型には `#[serde(default)]` が無い（`restore_rebuild.rs:2314-2316`。`:4899-4900` の注「none is `#[serde(default)]`」）。
- 契約の座標は、`current_maintenance_coordinates`（`maintenance_contracts.rs:490-541`）だけからは作られていない。
  - `graph_contract_digest`、`rule_registry_digest`、`producer_generation_set_digest` は、`current_maintenance_coordinates` が明示した値から作る。
  - `run_kind_contract_version` は、手で上げる定数 `VERIFY_CONTRACT_VERSION = "9"`（`restore_rebuild.rs:4903`、`maintenance_skip_evidence.rs:38`、`:970-974`）。
  - `rebuild_contract_version` も定数 `REBUILD_CONTRACT_VERSION`【レビュー 2】。
- `VERIFY_CONTRACT_VERSION` の上げ方の規則（`restore_rebuild.rs:4856-4858`）：「`DependencyGraphVerifyReport` の形か、その背後の検査の集合が、**古い保存済みの report から Repair plan を seal するのが危うくなる形で**変わったら上げる」。
- **Verify の分類の規則（S-1〜S-3）と digest の計算（S-4）のコードは、座標の材料に入っていない**。コードを変えても座標は自動では変わらない。上げるかどうかは、上の規則に照らした判断になる（§3.3 K-2）。
- `graph_state_digest` はデータの CAS なので、S-4 の計算が変われば、その計算が効く project だけで値が変わる。ただし、top-level の key を足すと、binding の無い project でも値が変わる【レビュー 2、推測】。

### 2.6 dev 試作で分かったこと（要点。詳細は §10）

- **判定の表**【試作 T-6。19 形。SQL で直接作った形で、epoch の欠落と別 epoch の Edge State は `PRAGMA foreign_keys=OFF` で作った】：
  - helper の incoherent と reader の `Reserved` は、全形で一致した。
  - helper の recognized not-current の形（dirty、Freshness が stale、`build_action` が `rebuild-required`、Freshness の epoch が別、今の epoch なし）では、`is_complete_registered` は全部 false だった。
  - そのうち B の hint が build を返したのは 4 形（`Build{BindingDirty}`／`Build{NotCurrent}`）。**今の epoch なしだけ `Skip{NoEpoch}`**（B はこの形を直さない）。
  - 改訂 5：今の epoch なしの形は、本文では recognized not-current から外し、今のまま full validation に渡す（§3.1）。そうすると、残る not-current の 4 形は、どれも B の hint が build になる。試作の helper は dirty を epoch より先に見る（dev `nir1_entity_relation_index.rs:2645-2648`）ので、改訂 5 の順（epoch を先に見る）とは違う。
  - 改訂 6：試作 r5 で改訂 5 の順を実装し、21 形（今の epoch なしを dirty=0・1 の 2 形に分けた）で確かめた。全形が適用されたことを assert した。recognized not-current の形はどれも B の hint が `Build` だった（dirty は `Build{Rebuild, BindingDirty}`、ほか 3 形は `Build{Rebuild, NotCurrent}`）。今の epoch なしの 2 形は、helper が `NoCurrentEpoch`（「今のまま」）、`is_complete_registered` が `Ok(false)`（容量の Err ではない）、B の hint が `Skip{NoEpoch}` だった【試作 r5 T-6】。
  - current と分類され `is_complete_registered` が false の形は 2 つ：**Edge State が stale**、**Edge State の epoch が別**。どちらも B の hint は `Skip{BindingCurrent}`（B も直さない）。
  - metadata の `source_digest` を書き換えた形（試作の形 19）は、1 段目で `Reserved`（incoherent）になった。理由は、eligibility の edge の token と `source_digest` の一致の検査（`nir1_entity_relation_index.rs:2541-2566`）に当たるためと読む【推測】。§5 の「残る止まり」に挙げていた source digest のずれのうち、eligibility の今の Source とのずれ（`nir1_entity_relation_index.rs:2703-2705`）と、edge と Source の不一致（`:2707-2709`）は作っていない。D1 head の `Corrupt` も作っていない。
  - reader が `Reserved` なのに B の hint が `Skip{BindingCurrent}` の incoherent の形が 4 つある（D1 の entry 0 件、V1 の edge の減少、read set の非正規形、eligibility の token の不一致）。GDV/1 の前からの挙動で、GDV/1 は変えない。
- **Edge State を書く経路**：Graph の edge の Edge State を書くのは B の publish だけ、という読み（incremental Freshness と Rebuild の consumer の loop は reserved な semantic-index を飛ばす）。正当な書込みで dirty を立てずに Edge State が stale／別 epoch になる経路は見つかっていない【試作 T-6 (4)：コードの読み。書込みの経路の動的な確認はしていない】。
- **順序（案 C）**【試作 T-3】：案 C の有り無しのどちらでも止まらない。案 C ありでは、main が RebuildDerived の work を渡す形で、最初の cycle の中で、Graph の build の起動が 3 回、publish が 1 回余分に増えた（generation 3。案 C なしでは 2）。余分な publish の原因は特定していない【未確認】。この数は試験が assert しておらず（出力の記録だけ）、その後の wake の generation も記録していない。案 C なしでも後の wake でもう一度 publish していれば、差は総数ではなく順序の違いになる【未確認。レビュー 3 の R-2】。
  - 改訂 6：試作 r5 で、全部の wake の後の generation も記録した。RebuildDerived を渡す形では、案 C ありが 3、なしが 2 のままで、build の起動の総数は 3 回と 1 回だった。**差は順序の違いではなく、publish が 1 回多く残る総数の差**だった。Verify を渡す形では差が無かった（どちらも generation 2、起動 1 回）。2 cycle 目以降は、どの形も起動なしで generation は変わらない【試作 r5 T-3。1 つの fixture と 6 wake の観測。試験は値を assert しておらず、出力の記録】。原因は特定していない【推測：案 C の先頭の build の後に Rebuild が Graph の入力を変え、B がもう一度直す】。
- **既存の試験**【試作 T-10】：全件の run（`4677649d`。2772 passed、3 failed、65 ignored）で、dirty な Graph の旧い扱いを assert する 3 件だけが落ちた（§8）。改訂 6：試作 r5 の head `ec550a58` の全件（2,852 件。2,783 passed、3 failed、66 ignored）でも、落ちたのは同じ 3 件だけだった【試作 r5】。
- **helper の実装**【事実：dev 枝】：`nir1_entity_relation_index.rs` の `pub(crate) classify_graph_binding_with_control`。`user_version < 35` は binding なし、autocommit の connection では自分の transaction を開く（`is_registered_with_control` と同じ）。2 段目は、dirty でない、今の epoch がある、Freshness の行が `evidence_freshness = fresh` かつ `build_action = none` かつ epoch が一致、の 3 つ。

## 3. 変える点（新しい読み）

### 3.1 判定（1 つの helper）

- reserved な semantic-index の consumer のうち Graph の binding（`INDEX_KEY`）を、次の 2 段で 3 つに分ける。**full eligibility は、どの制御の下でも読まない。**
- **1 段目（構造）**：reader と同じ構造の読み `read_internal(conn, project, true, true, Some(control))` を使う（`read_with_control`、`nir1_entity_relation_index.rs:2277-2283` と同じ。`is_registered_with_control` `:2583-2604` も同じ読み）【事実】。
  - これは `read_internal_bounded`（`:2385-2576`）の全部の条件を見る。
    - metadata の行、producer、generation（`:2445-2457`）。
    - D1 の entry の全件の読みと、entry が空でないこと（`:2414-2415`、`:2454`）。
    - D1 head の version（`:2458-2470`）。
    - Freshness の行と、その digest と V1 の今の dependency digest の一致（`:2471-2506`。引数が `true, true` なので、dirty でも一致が要る。`:2497`）。
    - 全 entry が `ranking-only`／`whole-source` で重複しないこと（`:2511-2523`）。
    - V1 と D1 の tuple の一致、eligibility の entry があること（`:2533-2540`）。
    - edge ごとの read set の正規形と、eligibility の edge の token が `source_digest` と一致すること（`:2541-2566`）。
  - 結果：
    - `Missing` → binding なし（今のまま）。
    - `Reserved` → **incoherent／unknown**（今のまま manual-terminal）。
    - `Registered{dirty, …}` → 2 段目へ。
- **2 段目（current か）**：`is_complete_registered` の条件のうち、**eligibility を読まない**ものだけを、次の**順**で見る【事実：`:2670-2782`】。改訂 3 は「B が直す対象になるもの」と書いたが、試作で、今の epoch なしの形は B が直さないと分かった。改訂 5 で、その形を not-current から外した（下の「今の epoch が無い形」）。
  1. **今の Semantic Epoch がある**（`:2692-2694`）。無ければ、dirty かどうかによらず **今のまま**（full validation に渡す）。2 と 3 は見ない。試作 r5 は、この形を別の値 `NoCurrentEpoch` として返し、呼出し元は current と同じに扱った【事実：dev 枝 `ec550a58` の `nir1_entity_relation_index.rs:2621`、`:2653`】。値の名前は実装の判断に残す（§1.4）。
  2. Freshness の行が `evidence_freshness = fresh`・`build_action = none` で、`semantic_epoch_id` が今の epoch（`:2737-2743`）。
  3. dirty でない（`:2781`）。
  - 1 が成り立ち、2 か 3 のどれかが成り立たない → **recognized not-current**。
    - このとき full validation（`is_complete_registered`）の結果は、eligibility を読む前から false に決まっている。省くのは「結果の決まった高い読み」で、容量の Err だけが消える【事実：上の行。レビュー 2 の R-2】。
  - 全部成り立つ → **current**。S-1〜S-5 は今のまま full validation と Source の解決を行う（eligibility に依る `:2696-2709` を含む）。
  - 試作の helper は同じ 3 つで実装したが、dirty を epoch より先に見ていた（dev `nir1_entity_relation_index.rs:2645-2648`）【事実：dev 枝】。改訂 5 の順（epoch を先に見る）は、試作 r5 で実装した。動機の形（V0 の (b)）は、この順でも recognized not-current になった【試作 r5 T-1 (0)】。21 形の分類と B の hint は §2.6【試作 r5 T-6】。
  - 2 段目の条件は `is_complete_registered` の条件の部分集合で、`canonical_instant` の 2 つと dependency digest の一致（`:2733-2753`）は見ない。見ない分は current の側に倒れ、full validation で false になる（安全側）【レビュー 3 の軽微】。
  - Edge State の古さ（`:2756-2779`）と source digest のずれ（`:2703-2705`）は、2 段目に入れない。
    - Edge State が stale か別の epoch の形では、B の hint は `Skip{BindingCurrent}` で、B は直さない【試作 T-6 (4)】。2 段目に入れれば、B が直さない形を期限なしに対象外にする。
    - source digest のずれは eligibility を読まないと分からない（`:2696-2709`）ので、2 段目に入れられない。
    - これらは current と分類され、今のまま full validation で false → manual になる（§5「残る止まり」）。
  - **今の epoch が無い形**（改訂 5 で扱いを変えた。レビュー 3 の M-1）：recognized not-current に入れず、**今のまま full validation に渡す**。改訂 4 は not-current に置いていた。
    - full validation は、`:2692-2694` の epoch の判定で、eligibility を読む前に false を返す【事実】。そのため、この形では S-1・S-3 で容量の Err は起きない。S-4・S-5 は今どおり Source を解決する（今の挙動のまま）。
    - epoch が無い間は、durable の discovery は Backfill（backfill の wake のとき）か `None` を返し、Verify も Rebuild も返さない（`maintenance_runtime.rs:2493-2507`）【事実】。S-1〜S-5 の結果が Run に届く経路は見つからない。例外は、epoch を消す前から pending／running の Run（`:2489-2491` で、epoch の判定より先に返る）で、極端な外部編集の形【未確認】。
    - 正当な書込みでは、この形は作れない読み【レビュー 3：`narrative_consumer_freshness.semantic_epoch_id` は `NOT NULL REFERENCES narrative_semantic_epochs(id)`、接続は `foreign_keys=ON`、製品のコードに epoch の DELETE は無い】。試作は `PRAGMA foreign_keys=OFF` で作った。
    - 改訂 4 の理由「current か incoherent に置くと manual に戻るだけ」は成り立たなかった。epoch が無い間は Verify も Rebuild も dispatch されないので、戻る止まりがもともと無い【レビュー 3 の M-1】。
    - not-current に置くと、consumer contract :69 の「rebuildable」に当たらない形（B が `Skip{NoEpoch}` で直さない）を rebuildable として扱うことになる。今のまま渡せば、緩和も開示も要らず、「not-current なら B の hint は build」も保たれる。
    - epoch が作られた後は、recognized not-current になり、B の hint は build になる。改訂 5 は `Build{NotCurrent}` を見込んだが、観測は `Build{Rebuild, BindingDirty}` だった。dirty=0 から始めた形でも同じだった【試作 r5 T-6：epoch は `create_epoch_in_tx` で作った。Backfill の実際の run ではない】。epoch の作成が binding を dirty にしている可能性があるが、dirty の値は取り出していない【未確認】。reason は違っても build を返すので、「not-current なら B の hint は build」は保たれる。
- 3 つの分類：

| 分類 | 条件 | 扱い |
|---|---|---|
| **今のまま**（current と、今の epoch が無い形） | 1 段目が `Registered`、2 段目が全部成り立つ（current）。または、1 段目が `Registered` で今の epoch が無い | 今のまま。S-1〜S-5 で full validation と Source の解決を行う（cold reopen を含む） |
| **recognized not-current**（新しい扱い） | 1 段目が `Registered`、今の epoch があり、2 段目の 2 か 3 が成り立たない | §3.2 |
| **incoherent／unknown**（今のまま） | 1 段目が `Reserved` | 今のまま。manual-terminal |

- 改訂 5：§4 以降で「current な binding」「current と分類」と書くところは、表の「今のまま」の行（今の epoch が無い形を含む）の扱いを指す。

- この helper は、reader の登録（`is_complete_registered…`）を置き換えない。reader は今のまま full validation で決める。
- helper の結果は、どの呼出しでも、その関数の connection・transaction の中で取り直す。Verify の結果を Rebuild に持ち越すような、transaction をまたぐ使い回しはしない（K-4）。
- Chronicle の binding（`nir1-reviewed-chronicle:v1`）は、この判定の対象にしない（§4）。

### 3.2 recognized not-current の扱い

- **S-1（分類）**：その consumer の edge を、unresolvable にしない。**S-1〜S-3 の検査の対象外**にする（決めた点 K-1）。
  - `total_edges` の数え方、edge の形の検査（malformed、`:5496-5500`）、duplicate の 2 つの検査（`duplicate_edge_keys`、`duplicate_edge_ids_to_deactivate`、`:5588-`）は、今のまま Graph の edge も含める。
  - report には、対象外にした consumer の key と edge の件数を出す（新しい欄。置き場所と serialize の拘束は K-2 の案に従う）。保存先は Verify の Run の outcome の JSON で、今の保存範囲の内。
  - `checkCoverage` の object（`restore_rebuild.rs:3636-3645`）は変えない。`complete: true` は「検査の catalogue が揃っている」の意味で、この Run が Graph を検査したことを意味しない（GDV-R1 に開示）。
- **S-2（Source の検査）**：その consumer の edge の Source を解決しない（S-1 で対象外なので通らない）。
- **S-3（footprint）**：recognized not-current の binding の 4 面の件数を、current の binding と同じく「宣言済み」として引く。宣言済みでない footprint（incoherent）は、今のまま残る。
  - `verify_coverage.rs:427-428` の注（「a dirty or otherwise stale binding remains visible as incomplete evidence」）は、この改訂で反転する。注を書き直す（GDV-R7）。
- **S-4（digest）**：その consumer の Graph の edge について、`durable_edge_resolution_input_with_control` の中で Source を解決しない（`:5370-5382` の `resolve_current_source_state_with_control` を呼ばない）。
  - その edge の `edgeResolutionInputs` の要素は、`resolvedSource` だけを固定の印（例 `{"status":"recognized-unavailable"}`）に置き換える。ほかの key はそのまま。
  - 印は、今の計算（`durable_resolved_source_value`）が作りえない値にする。試作の読みでは、今の計算が作る status は `usable`／`stale`／`missing`／`error` と `unsupported`（`durable_edge_resolution_input_with_control`）で、印と重ならない【試作 T-2 (4)：コードの読み】。改訂 6：試作 r5 で単体試験を足した。`durable_resolved_source_value` が作る status は `error`・`missing`・`stale`・`usable` の 4 つ（4 通りの入力で確認）で、`unsupported` を足した 5 つのどれとも印は重ならない【試作 r5 T-2 (4)。assert あり】。
  - **改訂 6：印は (x) の片側を支える（レビュー 4 の R-1）**。下流の gate の不変条件（下）に書く。印を外す実装の変更（たとえば Graph の edge を digest から抜く形や、印を今の計算が作りうる値にする形）は、(x) を壊す。そのため、印が今の計算の作りうる値と重ならないことと、not-current の Graph の edge が必ず印に置き換わることは、実装の拘束とする（§8）。
  - 試作では、helper を digest 1 回につき、Graph の edge を最初に見たときに 1 回だけ呼んだ【事実：dev 枝】。
  - **top-level の key は足さない。** binding の identity（metadata の generation・`dirty_cache_flag`・`built_at`・digest、D1 の set・head、Consumer Freshness）は、すでに digest に入っている（§2.2）。改訂 2 の「identity を digest に入れる」は取り消す。
  - その結果、digest の値が変わるのは、recognized not-current の Graph の binding を持つ project だけ。binding の無い project と current な binding の project では、byte で同じ【試作 T-5：binding なし、current な binding、Chronicle だけの 3 つの fixture で、制御なし・制御つきの digest が前後で byte 同一。ただし current な binding の制御なしの digest は、前後とも同じ `context-unavailable` の Err（T-2 (5)）】。
- **S-5（Rebuild の V2 shadow）**：`verify_v2_shadow_for_rebuild_in_tx_with_control` の head の loop で、recognized not-current の Graph の D1 head（`semantic-index`／Graph の `INDEX_KEY`）を飛ばす。その entry の Source を解決しない。
  - 判定は、shadow の transaction の中で §3.1 の helper を呼び直して決める。
  - 飛ばしたことは、shadow の diagnostics に code だけで残す（例 `NEX_V2_SHADOW_REBUILD_RECOGNIZED_UNAVAILABLE:semantic-index:{key}`）。V2 shadow の要約は永続しない（`#[serde(skip)]`）ので、保存されるものは変わらない【事実：§2.2】。
  - 試作では、この形で Rebuild-Derived が completed になり、連鎖が製品の経路で Idle に達した【試作 T-11：Graph 以外の Edge State を 1 行消す形と、Semantic Epoch を回す形の 2 つ】。
  - current と incoherent の Graph の head、Chronicle の head は、今のまま解決する。Chronicle の head も同じ shadow で自分の eligibility を読む【レビュー 2】が、Chronicle は改訂の対象外（§4）。
- **下流の gate（改訂 5。GDV-R9 の (x)。レビュー 3 の M-2）**：recognized not-current の Graph を対象外にした report（対象外の欄が空でないもの）からは、次の 2 つを通さない。current な Graph の binding で今閉じているのと同じく、閉じたままにする。
  - **Repair の plan の seal**（`seal_repair_plan`、`repair.rs:573-`）。検査は `load_sealable_verify_result`（`:648-`）の中、footprint の検査（`validate_reserved_semantic_index_footprint`、`:788`）の直後に置き、対象外の欄が空でなければ **`NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`** で拒否する（改訂 6 で名前を決めた。レビュー 4 の R-3）。apply の中の re-seal（`revalidate_plan_in_tx` `:521`・`:538`、`seal_plan_matching_digest` `:1141`・`:1154`。IPC は `lib.rs:16194`）も `seal_repair_plan` を通るので、同じ検査に掛かる【レビュー 4 の m-1】。
  - **C2Z の readiness の Verify の gate**（`inspect_verify_gate`、`c2z_preparation.rs:1311-`）。検査は制御なしの digest の検査（`:1436-1446`）の後、`:1448` の `is_clean` の判定の前に置き【レビュー 4 の m-2。位置は `f806138e` で読んだ】、対象外の欄が空でなければ `Blocked`、reason **`verify-graph-recognized-unavailable`** にする（改訂 6 で名前を決めた）。
  - 2 つの名前は、試作 r5 が使った名前をそのまま採る【事実：dev 枝 `ec550a58` の `repair.rs:800`、`c2z_preparation.rs:1454`】。ほかの契約（`policies/`、`src/`、`electron/`、`scripts/`）は、Repair と C2Z の拒否の code・reason を列挙していない【レビュー 4：`git grep`。改訂 6 で、起案者も `f806138e` のこの 4 つを `NEX_REPAIR_VERIFY_`・`verify-report-not-clean`・`verify-graph-state-invalid` で grep し、当たりは 0 件だった】。そのため、足しても外の契約や座標とは食い違わない（§11 の「変えないもの」は、この 2 つを足すものとして名指す）。
  - **C2-ZC の不可逆な cutover** は、marker を書く前に `readiness.ready` を要る（`c2zc_canonical_cutover.rs:239-249`。readiness は `c2z_preparation.rs:799` で上の Verify の gate を通る）【事実】。そのため、上の gate が閉じれば cutover も閉じる。cutover の Err の message は `NEX_C2ZC_CUTOVER_NOT_READY: ` に readiness の reasons を `,` でつないだもので（`:242-248`）【事実】、試作 r5 では `verify:verify-graph-recognized-unavailable` だけが残った【試作 r5 T-1】。製品の scheduler は、この `NEX_C2ZC_CUTOVER_NOT_READY` を想定内として扱い、次の wake で試し直す（`electron/native/grimodex-node/src/lib.rs:7072-7125`）【事実】。`c2zc_canonical_cutover.rs` は変えない。
    - main 側（改訂 6。レビュー 4 の R-6）：Rust の結果の `cutoverNotReady` が立つと、main は `requestBeforeCutoverPreparation` を呼び（`electron/main/narrativeFreshness.ts:245-249`、`electron/main/index.ts:609-611`）、chain を 1 本だけ生かし、使い切った chain は DR-MPS-2 の backoff の後で起こし直す（`electron/main/narrativeMaintenanceTriggers.ts:1089-1120`）【レビュー 4】。
    - 改訂 5 は、この経路を「current な Graph の今と同じ経路」と書いたが、正確ではなかった。**同じなのは cutover の側だけ**（どちらも `NEX_C2ZC_CUTOVER_NOT_READY` で進まない）。before-cutover の連鎖の側は違う【試作 r5 T-1。レビュー 4 の R-6】。
      - current な Graph（今も改訂の後も）：before-cutover の wake の discovery が、毎回 `context-unavailable` の Err を返す。cycle は起きず、Run は増えない。cutover の理由は `verify-graph-state-invalid: NEX_VALIDATION_TERMINATED:context-unavailable…`。
      - not-current な Graph（改訂の後）：最初の round で before-cutover の wake が Verify を返し、cycle は `[verify, rebuild, verify]`（Run +3）。次の round からは discovery が `None`（Err なし）で、Run は増えない。cutover の理由は `verify-graph-recognized-unavailable` だけ。
      - 違いは (x) が作るものではなく、GDV-R3 の変更（制御なしの digest が `Ok` になる）の結果である。
    - 試作 r5 の cutover の loop（製品の freshness scheduler と同じ [incremental cycle → heartbeat → cutover → NOT_READY なら before-cutover の wake → cycle] を 1 round として 8 round）では、not-current・marker なしの形で、Run は 5 → 8 で止まり、Err 0、Finding 0、marker は書かれなかった【試作 r5 T-1。出力の記録で、試験は値を assert していない。marker なしの形は近似（冒頭の記法の注）。main 側の backoff は Rust の試験では回していない】。
  - 閉じる場所は、この 2 か所だけ。次は閉じない。
    - 制御なしの digest（S-4）。ここを閉じ直すと、V0 の (b) の失敗点（main の制御なしの discovery）に戻る。
    - `evaluate_completed_run_skip`（skip の証跡の評価）。cycle の回復の分岐（`maintenance_runtime.rs:3254`）と共用で、連鎖に要る。
    - skip の証跡の seal と、`semantic-graph-requires-repair` の Finding の解消。連鎖と回復に要る（GDV-R9 に残る緩和）。
    - **foreground の Verify の完了**（改訂 6 で名指し。レビュー 4 の m-4）：`complete_foreground_system_work_run`（`maintenance_runtime.rs:997-`。製品は `lib.rs:10658`、napi の `release_narrative_maintenance_foreground_barrier` `:10497-10498` の中）。Verify の outcome を `validate_live_verify_outcome_rebuild_requirement`（呼出しは `:1118`。本体 `:2783-` は `:2792` で制御なしの `validate_graph_state_digest` を呼ぶ）で制御なしの digest に照らし、clean なら skip の証跡を seal する（`:1165` の `persist_completed_run_skip_evidence_in_tx`）【事実】。not-current の間は、この digest の検査も `Ok` になり、完了と seal が通る。skip の証跡の seal（GDV-R9）の 3 つ目の位置で、同じ種類の緩和である。連鎖の完了の経路なので閉じない。
  - 判定は、sealed な report の欄を読むだけで、Graph を読み直さない。report は `reportDigest` と outcome の digest で封じられ、`graphStateDigest` は今その場の値と比べられる（Repair は `repair.rs:779-787`、C2Z は `c2z_preparation.rs:1436-1446`）【事実】。そのため、欄が空でない clean な report が今の digest と一致するのは、Verify の後も Graph が同じ not-current の identity のままのとき。B が再 publish すれば digest が外れ、Verify のやり直しの後は欄が空になる。
  - **不変条件（改訂 6。レビュー 4 の R-1）**：(x) は、対象外の欄と、S-4 の印による digest の不一致の **2 つ**で閉じる。
    - 欄が空の report が not-current の間に通らないのは、欄ではなく digest の不一致による。Graph が current の間（または binding が無い間）に封じた clean な report は欄が空で、その後に binding が not-current に変わると、(x) の欄の検査は素通りする。この report を止めるのは、`graphStateDigest` の不一致だけである（Repair は `validate_graph_state_digest` の `NEX_VERIFY_GRAPH_STATE_CHANGED` を `?` でそのまま返す。`repair.rs:787`、`restore_rebuild.rs:3545`。C2Z は reason `verify-graph-state-invalid: NEX_VERIFY_GRAPH_STATE_CHANGED…`。`c2z_preparation.rs:1436-1446`）【事実】。
    - 不一致は必ず起きる読み：digest は全 edge の解決の入力を含み、not-current では Graph の edge の `resolvedSource` が印に置き換わる。Graph の eligibility の edge は必ずあり、`infer_source_kind` が `Some` を返すので、置き換えは必ず起き、current の間の digest と必ず食い違う【レビュー 4 の R-1：`restore_rebuild.rs:2600-2700`、`:455-456`、`nir1_entity_relation_index.rs:404-406`】。改訂の前の古い report（欄が無い）も、同じ理由で not-current の間は通らない（§3.3 (b) の 3）。
    - そのため、S-4 の印を外す変更は (x) を壊す（S-4 の拘束。上）。
    - この形（current で封じた後に dirty にする）は試作していない。試作 r5 の cutover の loop の最初の round で、Verify の gate が `NEX_VERIFY_GRAPH_STATE_CHANGED` になったのは、binding の無い状態から not-current に変わった形の部分的な裏付けにとどまる【試作 r5 T-1】。§8 の【新規】で確かめる。
  - 対象外が無い report では、この検査は何もしない。binding の無い project と current な binding の project の挙動は変わらない（current では、この検査より前に、制御なしの digest が今どおり `context-unavailable` になる）。欄が空の report（binding なし、current な binding、Chronicle だけ）の Repair の seal と C2Z の readiness が変更の前と同じであることは、試作 r5 の head でも baseline の写しとの比較で確かめた【試作 r5 T-7（`gdv1_t5_readers_match_baseline`）】。
  - 試作 r5 で (x) を実装して確かめた【試作 r5 T-7。試験が code と reason を assert】。
    - not-current：`seal_repair_plan` は `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE` で拒まれた。C2Z の Verify の gate は `Blocked / ["verify-graph-recognized-unavailable"]`（`report_clean=true`）で、project と workspace の readiness は ready にならなかった。
    - current：`seal_repair_plan` は `NEX_VALIDATION_TERMINATED:context-unavailable`、C2Z の Verify の gate は `verify-graph-state-invalid: NEX_VALIDATION_TERMINATED:context-unavailable…` で閉じていた。**両方の状態で閉じ、閉じる理由の code が違う。**
    - 欄が空の report（binding なし）：`seal_repair_plan` は `Ok`、C2Z の Verify の gate は `Passed`（今のまま）。
    - (x) が cutover を止めていることの対照：同じ cutover の loop で、`repair.rs` と `c2z_preparation.rs` だけを (y) の形に戻すと、marker なしの not-current の形で、2 round 目に cutover が成功し、marker が書かれた。(x) の head では書かれない【試作 r5 T-1】。
- **current への戻り方**：B が再 publish して dirty が 0 になり、Freshness が fresh になると、その binding は current の分類に戻り、S-1〜S-5 は今のまま full validation を行う。
  - metadata と Freshness の行が変わるので、digest も変わる。完了済みの Verify は再利用されず、やり直す。
- **ほかの consumer**：Chronicle の binding は、この改訂の対象にしない（§4）。

### 3.3 決めた点（起案者・統合者）

- **K-1：対象外にする（incomplete にしない）**。
  - incomplete にすると、Verify の report が incomplete だけのとき、discovery は `Ok(None)` で待つ（`maintenance_runtime.rs:2627-2634`）【事実】。
  - そうなると、その project の Graph 以外の Rebuild-Derived も待つことになり、止まりの形が変わるだけになる。
  - report は、S-1〜S-3 の検査では、Graph 以外の consumer で決まる。duplicate と malformed の検査は Graph の edge も見る（§3.2）。

- **K-2：Verify の契約の座標（`VERIFY_CONTRACT_VERSION`）。2 案を本文に書き、(b) を推奨する。**
  - どちらの案でも、§3.2 の S-4 の文（top-level の key を足さない）は同じ。両案の差は、版の定数と、report の欄の serialize の形と、開示だけ。
  - **(b) 上げない（推奨）**。次の 4 つを実装の拘束とし、これを満たす形だけを承認の範囲にする。
    1. report の新しい欄は `#[serde(default, skip_serializing_if = "Vec::is_empty")]` にする。
       - 古い report は deserialize でき（欄が無い＝何も対象外にしていない。旧い規則は対象外を作らないので、これは旧い report の事実と一致する）、対象外が無い project では serialize の結果が byte で同じになる。
       - `restore_rebuild.rs:4899-4900` の注（none is `#[serde(default)]`）を、この 1 欄の例外とその理由に書き直す。
       - outcome 直下に置く案はとらない。report の中に置けば、(d) の live のやり直しと Repair の seal が、同じ report の digest で欄も確かめるため。
    2. S-4 は、recognized not-current の Graph の edge の `resolvedSource` だけを置き換える。top-level の key は足さない（§3.2）。
    3. `VERIFY_CONTRACT_VERSION` と `REBUILD_CONTRACT_VERSION` を変えない。理由は、`:4856-4858` の規則の条件に当たらないこと。
       - 規則の条件は「古い保存済み report から Repair を seal するのが危うくなる」こと。
       - 旧い規則の report は、新しい規則より厳しい。dirty な Graph の binding は unresolvable で、clean にならず、footprint も残る。
       - 新しい規則で結果が変わるのは、recognized not-current の binding を持つ project だけ。そこでは S-4 で `graph_state_digest` が必ず変わる（印が旧い計算で作れない値のため）。よって、古い report はどの読み手でも CAS で拒まれ、新しい規則のもとで seal に使われない【推測。読み手ごとの拒否は、試作では main の discovery と製品の経路のやり直しで確かめた（T-1・T-5・T-9）。Repair の seal と C2Z の readiness が not-current の古い report を拒むことは、個別には試していない】。
       - 同じ build の読み手（main の discovery、cycle の skip 判定、Repair の seal、C2Z の readiness）は、どれも `graph_state_digest` を今その場で計算し直して比べる【事実：`maintenance_skip_evidence.rs:554-564`、`repair.rs:787`。C2Z は【レビュー 2：`c2z_preparation.rs:1425-1452`】】。
       - 古い build に戻した場合（downgrade）も、新しい規則の report を持つ not-current な project では、古い S-4 の digest が一致しないか、制御なしで eligibility を読んで `ContextUnavailable` になるので、seal されない【推測。downgrade は試作していない】。
       - 試作では、recognized not-current の形（3 つ）で digest が変わり、Verify がやり直しになった【試作 T-5・T-9】。
       - 改訂 5：新しい規則の report でも、対象外の欄が空でなければ、Repair の seal と C2Z の readiness は通らない（§3.2 の下流の gate）。そのため、この 2 つの読み手では、古い report か新しい report かによらず、not-current の Graph がある間は seal も readiness も開かない。
       - 改訂 6：このうち古い report（欄が無い）を止めるのは、欄の検査ではなく S-4 の印による digest の不一致である（§3.2 の不変条件。レビュー 4 の R-1）。(b) の推奨と (x) は、同じ印に乗っている。
    4. binding の無い project と current な binding の project で、`serde_json::to_value(report)` と `durable_graph_state_digest` が、変更の前後で byte で同じであること（§8）。試作で成り立った【試作 T-5】。
  - **(a) 上げる**。`VERIFY_CONTRACT_VERSION` を `"10"` に上げ、`:4860-` の履歴の注に「10：recognized not-current の Graph の binding を対象外にする」を足す。
    - 拘束 1 の serialize の形は同じでよい（上げるので byte 互換は要らないが、同じ形にして差を減らす）。拘束 2 は同じ。拘束 3・4 は要らない。
    - 開示：全利用者の全 project で、完了済みの Verify が 1 回やり直しになる（`run_kind_contract_version` の不一致で、skip の判定が rerun を返す）。
    - 開示：進行中の Verify の結果からは、版が合わないので Repair を seal できない（`:4897-4902` の注のとおり）。やり直しの後は seal できる。
    - 開示：評価の DB も全部やり直しになる。10 回目以降の CP-4 の run の最初の maintenance の時刻が変わりうる（§9）。
    - **(a) は試作していない。** 上の開示はコードの読み【推測】。とくに、改訂の前に Verify が容量で failed になった project（§5）が、版の不一致でやり直しになるかは【未確認】（recovery の判定が版の違う work を別の work と見るかに依る）。改訂 5：Verify の work key は `dependency-verify:{epoch}` で版を含まず、ledger は work と epoch で引かれる（§2.3）ので、(a) でも同じ epoch の間は戻らない見込み【推測：コードの読み。試していない】。
  - **(b) を推奨する理由**：版の規則の条件に当たらず、新しい規則で結果が変わる project では CAS が必ず外れるので、全利用者の全 project の再実行を払う理由がない。
  - **(a) の利点**（質問で選べるように書く）：
    - byte 互換を恒久の実装の拘束にしない。
    - v9 の clean が「Graph を検査した」と「Graph を対象外にした」の 2 つの意味を持たない（版の番号で区別できる）。
    - これまでも版は 1→3→…→9 と上げてきた。その費用（1 回の再実行）は、既に払ってきた種類のもの。
  - 改訂 3 は「T-5 で (b) の拘束 4 が成り立たなければ、推奨を (a) に改める」とした。T-5 で拘束 4 は成り立ったので、推奨は (b) のまま【試作 T-5】。

- **K-3：recognized not-current の判定は、canonical な値（metadata、D1 の set・head、V1 の edge、canonical Freshness、Semantic Epoch）だけを使う**。process-local の B の記録や reader の登録の状態は使わない。

- **K-4：判定と S-4 の変更の置き場所**（レビュー 2 の R-7）。
  - S-1〜S-3 の判定は、`verify_narrative_dependency_graph_for_project_with_control_within_capacity`（`restore_rebuild.rs:5455-`）と `verify_semantic_index_checks_with_control`（`verify_coverage.rs:442-`）の内側で行う。
  - S-4 は、`durable_graph_state_digest_with_control_within_capacity`（`restore_rebuild.rs:2600-`）か `durable_edge_resolution_input_with_control`（`:5349-`）の内側で行う。
  - S-5 は、`verify_v2_shadow_for_rebuild_in_tx_with_control`（`:1729-`）の内側で行う。
  - 外側の呼出し元（skip 判定、Repair、C2Z、terminal_failure、main の discovery）では行わない。すべての呼出し元がこの内側の関数を通るので、1 か所で全部に効く【レビュー 2 の「確認済み」の呼出し元の一覧】。
  - 例外（改訂 5）：§3.2 の下流の gate の検査は、外側の 2 か所（`seal_repair_plan` の中の `load_sealable_verify_result`、`inspect_verify_gate`）に置く。これは分類（helper）ではなく、sealed な report の対象外の欄を読むだけの検査で、Graph を読まない。ほかの外側の呼出し元（foreground の Verify の完了を含む）には置かない（§3.2 の「閉じない」）。
  - helper 自体は、`read_internal` が private なので、`nir1_entity_relation_index.rs` に `pub(crate)` の関数として置く（変える file が 1 つ増える。§9）。試作もこの形で置いた【事実：dev 枝】。

## 4. 変えないもの

- **データと書き手**：GDV/1 の中でのデータの書込みは無い。writer、D1、generation、B の route、B の process-local の記録、l6-l9:506（成功時だけ sealed head を更新）、:505、:542、:496、:1037。
  - 改訂 5：破壊的な経路（Repair）の seal に届く状態は増やさない。作り直し待ちの Graph がある間も、Repair の seal と C2Z の readiness（その先の C2-ZC の cutover）は閉じたまま（§3.2、GDV-R9）。
- **B-close**：数値（候補 2,064 件、保存 edge 8,193 行、600,000,000 counts、180 s ほか）と、句「Graph publication keeps its previous generation on refusal」（`nir1-b-close-completion-2026-09-22.md:46-47`）。
- **policy の file**：consumer contract、POL-SC（とその schema）、producer registry。どれも変えない。
  - したがって `producer_generation_set_digest` も変わらない。
  - consumer contract :69 と POL-SC の `recognizedUnavailable` は、この読みの根拠としてそのまま使う。
- **Verify の契約の座標**：`graph_contract_digest`、`rule_registry_digest`、`producer_generation_set_digest`、`REBUILD_CONTRACT_VERSION` は、どちらの案でも変えない。`VERIFY_CONTRACT_VERSION` は、K-2 (b) なら変えず、(a) なら `"10"` に上げる。
- **current な binding と incoherent な binding の扱い**：
  - current：S-1〜S-5 の full validation と Source の解決（cold reopen を含む）。今の epoch が無い形も同じ（§3.1）。
    - ただし、helper の 1 段目の構造の読みが足される。nested の読みは外側の capacity の budget（600,000,000 counts）を継承する（`nir1_entity_relation_index.rs:2365-2367`）ので、上限の近くの current な binding では、今より早く容量の Err になりうる。上限は §6.2 の「二重の読み」の開示のとおり【レビュー 3 の軽微】。
  - incoherent：manual-terminal と `semantic-graph-requires-repair`。改訂 6：試作 r5 では、incoherent の形でも Verify は completed になり、Graph の edge は unresolvable に入った。ただし、制御なしの digest が先に `context-unavailable` を返すので、dev の経路ではこの Finding まで届かなかった（§2.3）【試作 r5】。どちらも GDV/1 が変えない経路で、今のままと読む【推測：変更の前の build との比較は未実施。§8】。
- **保存の超過**：`preflight_stored_graph_capacity`（Verify、digest、V2 shadow、reader の前）は今のまま、先に走る。`stored-*` の超過は破損の印で、今のまま止まる（manual-terminal の趣旨）。
- **l6-l9:495 の coerce の句**：GDV/1 は、試みた検証を成功に倒すのではなく、結果の決まった検証を始めないので、この句に触れない【推測】。cancel／timeout／closed は今のまま attempt を terminate する。
- **reader**：登録、query、理由の集合（`GraphUnavailable` の 14 個、renderer の `NIR1_GRAPH_UNAVAILABLE_REASONS`）、文言、UI（U1）。Graph は dirty の間、今と同じく unavailable で、R+IR に戻る。
- **ほかの binding**：Chronicle の binding と DR-BSEAM-5 の件。
- **incremental Freshness**：reserved な semantic-index の edge を飛ばす（`incremental_freshness.rs:2502-2507`）【レビュー 2】。incremental の V2 shadow は D1 head を回る（`:2940-2943`）が、entry ごとの Source の解決はしない【試作 T-12：動機の形で `evaluate_v2_shadow` を 3 つの選択の範囲（Graph の 4 つの source identity、`ComponentSchemaGlobal`、`ProjectResetGlobal`）で直接呼び、Err にならず、`run_incremental_freshness_cycle` は Idle。`incremental_freshness.rs` に Source の解決の呼出しは無い（`git grep`）。実際の Scene の編集の cycle は未実施（§8）】。S-6 は要らない。
- **閾値・Gold・評価の手順**：K6/7 の行、手順のファイル、Gold・G-case の fixture と pool、S2、harness。
- **#5 の判断**：DR-PUBG-5-1〜12。`PRODUCT_GRAPH_PUBLISHED` は false のまま。`native-architecture.mjs` には触れない（`lib.rs`・`nir1_graph_product.rs` を変えない）。
- **保存と送信**：DB の schema、新しい保存範囲、新しい送信先、Inbox の行。

## 5. 緩和の一覧

番号は、既存の RB-1（proposal/7）、R-1〜R-13（K6）、改訂 1 の GBR-B1〜B4 と重ならないよう、`GDV-R` を使う。改訂 1 の GBR-B1〜B4 は、GDV-R1〜R4 に当たる。改訂 3 で GDV-R8・R9 を足した。

改訂 4 では緩和を増やさない。試作で新しく対象外になる検査は出なかった（今の epoch が無い形は、改訂 3 の 2 段目の条件ですでに recognized not-current だった）。試作で分かった事実で、GDV-R1・R3・R4 の「緩む面」の開示を改めた（各行の「改訂 4」の印）。

改訂 5 でも数は 9 つのまま。増やした緩和は無い（レビュー 3）。
- GDV-R1・R4 の改訂 4 の追記（今の epoch が無い形）を削った。その形は今のまま full validation に渡す（§3.1。M-1）。
- GDV-R9 を狭めた。Repair の seal、C2Z の readiness、その先の C2-ZC の cutover は閉じたまま。開くのは skip の証跡の seal と Finding の解消だけ（§3.2。M-2 の (x)）。
- 各行の「改訂 5」の印のところを直した。

改訂 6 でも数は 9 つのまま。増やした緩和は無い（レビュー 4 の §4）。
- GDV-R9 の「開く」に、foreground の Verify の完了（`complete_foreground_system_work_run`）を名指しした。skip の証跡の seal の 3 つ目の位置で、同じ種類の緩和なので数は変わらない（レビュー 4 の m-4）。
- 試作 r5 の事実で、GDV-R2・R3・R4・R9 の開示を改めた（各行の「改訂 6」の印）。

| # | 項目 | 今 | 新 | 緩む面と根拠 |
|---|---|---|---|---|
| GDV-R1 | Verify の検査の対象（S-1・S-2） | dirty な Graph の binding の edge も、unresolvable と Source の欠落の検査にかける。通らなければ manual | recognized not-current の間は、その Graph の edge を S-1〜S-3 の検査の対象外にする（malformed と duplicate は今のまま） | 検査の対象が減る。Graph の edge の unresolvable と Source の欠落は、その間は見ない。Verify と B が共有する full-set の上限（候補 2,064 件など）も、その間は Graph の面にかからない（B-close の「SQL per full-set attempt … shared prepare→publish and nested Verify/Rebuild validation」`nir1-b-close-completion-2026-09-22.md:39` と「Verify/Rebuild share a synchronous attempt budget」`:47-48` の共有の外に、その間だけ Graph の面が出る。句は変えない。§4）【レビュー 3 の軽微】。保存の超過の前検査は残る。**期間に上限は無い**：gate が閉じた起動（製品の既定。評価の DB の写しや restore を開いた場合）では B が走らず、候補の超過のように入力の大きさで B が拒否される場合は、利用者が入力を減らすまで続く（レビュー 2 の R-4）。gate が閉じた DB で対象外が続くことは試作で確かめた【試作 T-8】。**改訂 5**：改訂 4 の追記（今の epoch が無い形も対象外になる）は削った。その形は今のまま full validation に渡す（§3.1）。`checkCoverage` の `complete: true` は変わらない（§3.2）。consumer contract :69 には合う |
| GDV-R2 | 失敗の見え方 | dirty のまま B が拒否し続けると、`semantic-graph-requires-repair` か Verify の失敗の Finding が出る（durable） | Finding は出ない。B の拒否は process-local の記録と debug log（code と limit だけ）に残る。Verify の report の対象外の欄に、Graph の key と件数が出る | 容量の超過は、Finding としては durable に残らない。Q3 の回答（画面では知らせず、開示だけ）にはそろうが、今の「止まって Finding が出る」より見えにくい。**改訂 6**：「今」のうち、V0 で出たのは Verify の失敗の Finding。`semantic-graph-requires-repair` は、sealed な Graph の binding を持つ project では、dev の経路のどれでも作れなかった（制御なしの digest が先に Err。§2.3）【試作 r5】。生じないとまでは言えない【未確認】 |
| GDV-R3 | Verify の outcome の読みと、B-ROUTE の設計の前提 | 「Verify は、未検証の declared binding の edge を全部 manual の defect にする」（`nir1_graph_index_maintenance.rs:579-584` の注、`maintenance_runtime.rs:2349-2356` の doc「Verify treats a non-validated declared binding as a manual defect」）。B の preempt はこの前提で置かれている。**main の wake（DR-BSEAM-1 (b)）は、「制御なしの durable planner は sealed な binding を判定できず `context-unavailable` で落ちる」を前提に、それを `GraphIndexBuildWake` に変える**（§2.2） | dirty の間は manual にしない。preempt は残す（B が Verify より先に直すのは、効率のため）。**改訂 4**：recognized not-current の binding では、制御なしの planner が落ちずに `Ok` を返し、main は `Work(Verify)` か（work が無ければ今と同じ）`GraphIndexBuildWake` を返す。B の判定は cycle の中に移る（案 C を採ればその先頭で、採らなければ cycle の最後の rediscovery で。§7。改訂 6 で、案 C をやめる選択肢に合わせて書き直した）。書き直す注は 2 つ（試作で書き直した）に、`discover_maintenance_project_for_main` の doc（`maintenance_runtime.rs:2311-2325`）と試験の注（`nir1_graph_index_maintenance_tests.rs:2194-2196`）を足して 4 つ。DR-BSEAM-1 の記録（`bseam-decisions.md`）にも、GDV/1 の後の前提の変化を注として足す。**改訂 5**：DR-BSEAM-3（`bseam-decisions.md:12`）と DR-BSEAM-6 (3)（`:15`）も、書き換える試験 1 の assert（discovery が `GraphIndexBuildWake`、制御なしの判定が `context-unavailable`）を根拠に書いている【レビュー 3 の R-5】。この 2 つにも同じ注を足す | Verify の結果の意味が変わる。確認済みの句ではなく、設計の前提・DR の前提とコードの注の変更。案 C が無くても、B は cycle の最後の rediscovery で判定され、止まらない【試作 T-3】。current と Chronicle の binding の wake は今のまま【試作 T-2 (5)】。座標は K-2 の案に従う |
| GDV-R4 | 構造の読みによる判定（§3.1） | Graph の binding の扱いは、full validation（`is_complete_registered…`）で決まる | current でないことを、reader の構造の読み（`read_internal(…, true, true, …)`）と、Freshness・epoch・dirty の行で決め、full eligibility を読まない | 構造の条件は reader の `Reserved` と同じなので、incoherent を recognized と誤認しない【試作 T-6 (1)：19 形で一致。D1 head の `Corrupt` は作っていない。helper の 1 段目と reader は同じ `read_internal(…, true, true, …)` を呼ぶので、この一致は作りから決まる。独立の証拠ではなく、回帰の試験として読む【レビュー 3 の軽微】】。**改訂 5**：改訂 4 の追記（「今の epoch がある」は B が直す条件と一致しない）は削った。今の epoch が無い形は、2 段目の最初に見て、今のまま full validation に渡す（§3.1）。そのため、recognized not-current の形はどれも、B の hint が build になる見込み【試作 T-6 (3) の 4 形と、この順の読み。順は §8 で確かめる】。**改訂 6**：試作 r5 で、この順を実装した 21 形で確かめた。not-current の形はどれも `Build`（dirty は `BindingDirty`、ほかは `NotCurrent`）、今の epoch なしは「今のまま」で `Skip{NoEpoch}`【試作 r5 T-6】。ただし、hint が build でも、入力が大きすぎれば B は拒否し続ける（動機の形。GDV-R1）。「build になる」は「B の対象になる」で、「B が直す」ではない（レビュー 4 の R-5）。recognized not-current の binding では `is_complete_registered` の全体（eligibility に依る検査と Edge State の検査を含む）を始めないが、2 段目が成り立たないので、その結果は読む前から false に決まっている。Graph の全 edge の Source の検査と解決を省く面は GDV-R1・R5・R6 |
| GDV-R5 | 完了証跡の digest（S-4）が覆う範囲 | Graph の edge の Source（eligibility を含む）の今の状態が、digest に入る | recognized not-current の間は、Graph の edge の Source を解決せず、`resolvedSource` を固定の印にする。identity の面（metadata、D1、Freshness）は今のまま入る | Verify の再利用の CAS が、その間の Graph の Source の変化を見ない。Verify はその間 Graph を対象外にするので、report の中身とは整合する【推測】。B が再 publish すれば metadata と Freshness が変わり、CAS が外れる |
| GDV-R6 | **「Source の再解決」と「完全登録の検証」を、結果の決まった binding では始めない**（l6-l9:495、:513、:514） | 確認済みの句は、Source の再解決（:513）と `is_complete_registered`（:514）を、owned な full validation で行うと書く。Verify と digest は dirty な binding にもこれを行う | recognized not-current の binding には、Verify・digest・V2 shadow の中では、この 2 つを始めない | 確認済みの句の読み替えではなく、その句が律する validation を、結果が false に決まった binding では始めないこと。失う情報は無く、消えるのは容量の Err だけ（§3.1）。実質の緩和は、false の帰結を unresolvable から「対象外」に変えること（GDV-R1）で、この行はそれと重なる。新しい unowned scan は足さない（読みを減らすだけ）。:495 の coerce の句には触れない（§4）。reader の登録と current の binding では、今のまま行う |
| GDV-R7 | footprint の検査（S-3） | 4 面の件数から引けるのは、full validation を通った binding の分だけ | recognized not-current の binding の分も引く。`verify_coverage.rs:427-428` の注を反転して書き直す | 宣言済みとして数える範囲が広がる。incoherent な footprint は今のまま残る。下流の gate への効き方は GDV-R9 |
| GDV-R8 | Rebuild-Derived の V2 shadow の観測（S-5） | project の全部の D1 head の entry の Source を解決する。Graph の eligibility の解決が容量で落ちれば、Rebuild の Run が失敗で終わる | recognized not-current の Graph の D1 head を飛ばし、diagnostics に code だけを残す | 非 authoritative な観測（永続しない。`#[serde(skip)]`）から Graph が外れる。V2 の D1 の defect をその間は観測しない。Rebuild の consumer ごとの loop は、もともと semantic-index を飛ばしている（`:1338-1341`） |
| GDV-R9 | **下流の gate**（skip の証跡の seal と Finding の解消。Repair の seal、C2Z の readiness、C2-ZC の cutover は閉じたまま） | （改訂 5 で直した）dirty な binding では footprint が残るので、report は clean にならない。さらに、制御なしの digest が eligibility を読むので（`repair.rs:787`、`c2z_preparation.rs:1436-1446`）、sealed な Graph の binding を持つ project では、**binding の状態によらず**（current な binding でも）、Repair の plan の seal（`repair.rs:788-792` → `validate_reserved_semantic_index_footprint`）と C2Z の readiness は閉じている【試作の baseline `b2-current.readers.json`：current な binding で、Repair の seal は `context-unavailable`、C2Z の readiness は `Blocked`】。C2-ZC の cutover も readiness を要るので閉じている。skip の証跡の seal、`semantic-graph-requires-repair` の解消も、clean を要件にしているので dirty な binding では通らない | recognized not-current の project でも、report が clean になりうる。そのとき skip の証跡の seal（【レビュー 2：`restore_rebuild.rs:3843`、`:4769`】）と Finding の解消（`maintenance_runtime.rs:2640-2642` の注）が通るようになる。**改訂 5**：Repair の plan の seal と C2Z の readiness は、対象外の欄が空でない report からは通さない（§3.2 の下流の gate）。C2-ZC の不可逆な cutover（`c2zc_canonical_cutover.rs:220-296`）は readiness を先に要るので、これも閉じたまま。改訂 4 は、これらも開いていた。current な binding と同じく閉じる形にそろえる。**改訂 6**：skip の証跡の seal は 3 か所で開く（Verify の Run の legacy と controlled、foreground の Verify の完了 `maintenance_runtime.rs:1118`・`:1165`、製品は `lib.rs:10658`）。閉じる 2 か所の拒否は、Repair が `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`、C2Z が reason `verify-graph-recognized-unavailable`【試作 r5 T-7】。欄が空の古い report は、S-4 の印による digest の不一致で閉じる（§3.2 の不変条件） | （改訂 5 で狭めた）開くのは、連鎖に要る skip の証跡の seal と Finding の解消だけ。破壊的な writer（Repair）と不可逆な cutover には、作り直し待ちの Graph の間は届かない（今と同じ）。そのため、開く条件が健全さと逆になる非対称（current な Graph では閉じ、not-current では開く）は、この 3 つでは起きない。discovery と cycle の skip 判定は、not-current では `Ok`、current では今どおり `context-unavailable` で、ここには非対称が残る（GDV-R3。連鎖を止めないための変更そのもの）。Verify の outcome の 4 つの検査（`validate_canonical_verify_outcome_digest`、`validate_verify_check_coverage`、`validate_report_rebuild_required_with_control`、`validate_phase_success_outcome`）は、対象外の欄のある outcome を通す【試作 T-7】。改訂 4 の (y)（開く形）の根拠と T-7 の Repair の plan の観測は §13 に移した |

- **GDV-R9 の位置づけ（改訂 5 で改めた。レビュー 3 の M-2）**：
  - 2 案をコードで比べた。
    - (x) 狭める：作り直し待ちの Graph がある間も、Repair の seal と C2Z の readiness を閉じたままにする。current な Graph と同じ扱い。
    - (y) 開く（改訂 4 の形）：そのうえで、非対称と C2-ZC の cutover への届き方を開示する。
  - **(x) を選んだ**。理由は 2 つ。
    1. **cutover に届かないことを、コードで確かめられなかった。**（改訂 6：試作 r5 で、届くことが分かった。cutover の前の DB（marker なしの近似の形）で、gate を開けた起動では not-current の Graph が publish され、(y) の形では 2 round 目に cutover が成功して marker が書かれた。(x) の head では書かれない【試作 r5 T-1】。理由 1 は「確かめられなかった」から「(y) では届くと確かめた」に強まった。）
       - cutover は、marker が無い間、製品の scheduler の wake のたびに自動で試される（`electron/native/grimodex-node/src/lib.rs:7072-7125`）【事実】。
       - cutover は、marker を書く前に readiness（C2Z の Verify の gate を含む）と、project ごとの制御なしの skip 判定を要る（`c2zc_canonical_cutover.rs:239-288`）【事実】。(y) では、not-current の project でこの 2 つが通りうる。
       - B の判定（`read_build_hint`、`nir1_graph_index_maintenance.rs:267-290`、`:509-530`）と Graph の publish（`nir1_entity_relation_index.rs` に cutover の参照が無い）は、cutover の marker を見ない【事実】。cutover の前は、Revision ごとの canonical Freshness が読めず（`nir1_entity_relation.rs:1578-1584`、`:2766-2777` の `canonical-freshness-unavailable`）、Graph の候補は 0 件になる読み【推測】。それでも eligibility の edge は必ず入る（`nir1_entity_relation_index.rs:2951-2955`）ので、cutover の前に binding が publish されうるかは、端まで読めていない【未確認】。改訂 6：試作 r5 で、marker なしの形でも Graph は publish された（generation 1。edge は eligibility の 1 本だけ。marker ありの形は 4 本）【試作 r5 T-1：marker の行を消した近似の形】。
       - 製品の既定（gate が閉じている）では binding が無いので当たらない。gate を開けた評価や開発の DB だけの話。
       - 依頼の規則（確かめられなければ (x)）に従い、(x) にした。
    2. **(x) でも、動機の形（V0 の (b)）の止まりは解ける読み**【コードの読み】。改訂 6：試作 r5 で、(x) を入れた head で解けた（marker あり・なしの両方で、製品の経路の wake#1 で Idle、Finding 0、Err 0）【試作 r5 T-1】。
       - 閉じる 2 か所は、自動の連鎖の経路に無い。`seal_repair_plan` の製品の呼出しは、IPC の seal（`lib.rs:16167`）と apply の中の re-seal（`lib.rs:16194` → `repair.rs:538`、`:1154`）で、どれも手動【レビュー 4 の m-1】。`inspect_verify_gate` は、cutover の readiness（`c2z_preparation.rs:799` ← `:781` ← `c2zc_canonical_cutover.rs:153` ← `:239`）からだけ呼ばれる。`inspect_workspace_cutover_readiness_with_liveness`（`mod.rs:343`）と `inspect_project_cutover_readiness`・`inspect_workspace_cutover_readiness`（`mod.rs:332-333`）は公開されているが、製品の呼出しは `cut_over_workspace_freshness` の中の `:239` だけ【事実：`git grep`。試験の module を除く。`mod.rs:332-333` は改訂 6 で読んだ。レビュー 4 の m-6】。
       - 連鎖（main の discovery → Verify → Rebuild-Derived → Verify → Idle）は、skip の証跡と制御なしの digest を使うが、どちらも (x) で変えない。
       - cutover の済んだ DB（V0 の (b) の形を含む評価の DB）では、cutover は marker を見て早く返り（`c2zc_canonical_cutover.rs:225-232`）、readiness を読まない。
       - cutover の前の DB で not-current の Graph がある形では、cutover は `NEX_C2ZC_CUTOVER_NOT_READY` で進まない。Rust の scheduler はこれを想定内として扱う（`lib.rs:7105-7117`）【事実】。改訂 6：main 側は before-cutover の準備を起こす【レビュー 4 の R-6】。cutover の側は current な Graph の今と同じだが、before-cutover の連鎖の側は同じ経路ではない（§3.2。current は毎回 Err、not-current は 1 回の Verify の後 `None`）。この形でも、自動の保守は Idle に達し、Run の数は増え続けない【試作 r5 T-1】。改訂 5 の「この形での Idle は主張しない」は取り消す。
       - 前の試作の T-1・T-11 は (y) の形で、marker がある DB で Idle に達した。試作 r5 で、(x) の head で取り直し、marker の有る形でも無い形でも Idle に達した【試作 r5 T-1・T-11】。
  - (x) で残る緩和は、skip の証跡の seal と Finding の解消だけ。どちらも連鎖を止めないための変更そのもので、破壊的でも不可逆でもない。製品の認可や新しい authority ではない。名指しの緩和として最終確認に出せば足りると判断した。
  - (y) は §13 に置いた。(y) に戻すなら、開示（非対称と cutover への届き方）が要る。改訂 6：cutover の前の DB で binding が publish されうること、(y) では cutover に届くことは、試作 r5 で分かった（上の理由 1）。
  - 最終確認で「承認しない」を選んで (y) などの別案を求めることはできる。

緩和ではないが開示するもの：
- **残る止まり**：
  - current な binding（cold reopen の後を含む）で、Verify 自身の full validation が容量で落ちる場合（期限など負荷の拒否を含む）。今の挙動と同じ。
    - 改訂 6（レビュー 4 の m-7）：helper の 1 段目の構造の読みが外側の capacity の budget を使うので、上限の近くの current な binding では、今より早く容量の Err になりうる（§4、§6.2 の「二重の読み」）。緩和ではないが、止まり方が少し早まりうる。
  - current と分類されるが full validation が false になる形。今のまま unresolvable → manual。**B もこれらを直さない**。
    - **Edge State が stale か別の epoch**（`:2756-2779`）：試作で、current と分類され、`is_complete_registered` が false、B の hint は `Skip{BindingCurrent}` だった【試作 T-6 (4)】。正当な書込みで dirty を立てずにこの形になる経路は見つかっていない（Graph の edge の Edge State を書くのは B の publish だけ、という読み）【試作 T-6 (4)：コードの読み。動的な確認はしていない】。
    - eligibility の今の Source との source digest のずれ（`nir1_entity_relation_index.rs:2703-2705`）と、edge と Source の不一致（`:2707-2709`）：試作で作っていない【未確認】（§8）。
    - metadata の `source_digest` を書き換えた形は、current ではなく incoherent（`Reserved`）になった【試作 T-6 (1)】。manual のままなのは同じ。
  - 保存の超過（破損の印）。試作で、保存 edge 8,194 行の形は GDV/1 の後も止まった【試作 T-1 の補足】。
  - 既に止まっている project のうち、Verify が容量で failed になった形（下の 2 点目）。
  - current な binding では、制御なしの digest の経路（cycle の回復の分岐 `maintenance_runtime.rs:3254`、Finding の projection `terminal_failure.rs:947` など）が eligibility の Source を解決するので、`ContextUnavailable` になる。試作で、変更の前も後も同じ Err だった（Chronicle の binding も同じ）【試作 T-2 (5)】。GDV/1 の前からある挙動で、GDV/1 は変えない。
  - **改訂 5**：作り直し待ちの Graph がある間は、Repair の plan を seal できず、C2Z の readiness も通らない。current な Graph の binding でも、制御なしの digest が `context-unavailable` になるので、今も閉じている（上の行）。つまり、sealed な Graph の binding を持つ project では、binding の状態によらず、今も改訂の後も、この 2 つは閉じている（§3.2、GDV-R9）。
    - cutover の前の DB（marker なし）で、作り直し待ちの Graph があり B が拒否し続ける形では、cutover が進まない。期間に上限は無い（B が直すか、入力が減るまで）。current な Graph の binding を持つ cutover の前の DB でも、今同じく進まない。gate を開けた起動の DB だけの形。改訂 6：cutover の前の DB にも binding は publish されうる。この形でも、自動の保守（durable な連鎖と before-cutover の連鎖）は Idle に達し、Run は増え続けない。止まるのは cutover だけ【試作 r5 T-1：marker の行を消した近似の形、8 round の観測】。
- **今の epoch が無い形**（改訂 5 で直した）：recognized not-current に入れず、今のまま full validation に渡す。epoch が無い間は Verify も Rebuild も dispatch されないので、止まりも緩和も生じない（§3.1）。改訂 4 の開示「B が直さない not-current の形」は無くなった。
- **既に止まっている project**（この改訂の前に止まった project。製品の build で作った DB には B の binding が無いので、対象は、評価や開発で gate を開けた起動で作った DB と、その写し・restore を製品の build で開いたものだけ。改訂 5 で範囲を直した。レビュー 3 の R-4）。止まり方で 2 つに分かれる（レビュー 2 の R-3）。試作の結果（T-9）で書き直した。
  - **Verify は completed で non-clean の形：自動で戻る**【試作 T-9 (i)】。
    - 保存された `graphStateDigest` は、古い S-4 で作られている。改訂の後の S-4 では値が変わるので、`validate_discovered_verify_outcome` が失敗し【レビュー 2：`restore_rebuild.rs:3541-3546`】、`Err(_) => verify_work`（`maintenance_runtime.rs:2570`）で Verify がやり直しになる。
    - 試作では、製品の経路の最初の wake で Verify がやり直され、completed になり、次の wake から Idle だった。
    - ただし試作は、`semantic-graph-requires-repair` の Finding がある形を作れなかった（Finding 0 の形だけ）。新しい Verify が clean なら Finding が解消される（`:2640-2642` の注）ことは【未確認】（§8）。改訂 6：試作 r5 でも、dev の経路ではどの形でもこの Finding を作れなかった（§2.3）。この Finding を持つ DB が実際に生じるかは【未確認】。§8 では、Finding を SQL か直接の projection で作った形で解消を確かめる。
  - **Verify が容量で failed（Finding 1 件）の形：GDV/1 の後も、同じ Semantic Epoch の間は自動では戻らない**【試作 T-9 (ii)】。
    - discovery は毎回 `Work(Verify)` を返す（`latest.status != "completed"`、`:2552-2553`）が、cycle は新しい Run を作らない。Run の数も Finding も変わらない。
    - 機構は、recovery の判定が retryable でない failed の Run に `ManualIntervention` を返し、cycle がその work を noop で閉じる分岐（§2.3）。改訂 5 で【事実】に上げた（`NEX_VALIDATION_TERMINATED` は retryable の一覧に無い）。
    - 範囲は同じ Semantic Epoch の間。Verify の work key は epoch を含み版を含まないので、restore などで epoch が変われば新しい work になる【推測。試していない】（§2.3）。
    - GDV/1 は、この形の自動の回復を足さない。足すと terminal failure の lifecycle（自動の保守が止まる条件）を変えることになり、この改訂の範囲（Verify と Rebuild の観測の読み）の外になる。
    - 戻すには、人がその failed の Run／Finding を扱う道が要る。既存の Maintenance Inbox の扱いでこの形が戻るかは【未確認】。
    - 対象は、評価や開発で gate を開けた起動で、改訂の前に止まった DB と、その写し・restore だけ。その写しを製品の build で開いても、gate が閉じていても、この止まりは残る（Verify の work は durable の discovery から出るため）。製品の build で作った DB と、改訂の後に作る評価の DB には当たらない【製品の build が Graph の binding を作らないことは【レビュー 3】のコードの読み（publish の試験の外の呼出し元は、seam の gate で閉じる B と、既定で無効な diagnostics の feature だけ）。改訂の後に failed にならないことは【推測】】。
  - K-2 (a) を選んだ場合は試作していない。completed・non-clean の形は版の不一致でもやり直しになる見込み。failed の形は、work key が版を含まないので、(a) でも同じ epoch の間は戻らない見込み【推測】（§3.3）。
- **digest の値が変わる project**：
  - K-2 (b)：更新の時点で recognized not-current の Graph の binding を持つ project だけ。`graph_state_digest` の値が変わり、完了済みの Verify が 1 回やり直しになる。全 project ではない【試作 T-5】。
  - K-2 (a)：全 project で 1 回やり直しになる（§3.3）。試作していない。
- **report の形**：Verify の report に「対象外にした consumer」の欄（試作の名前は `consumers_excluded_not_current`、JSON では `consumersExcludedNotCurrent`）が増える（§3.2）。対象外が無い project では、K-2 (b) の拘束 1 により serialize されない。Verify の outcome の検査と Repair の seal は、この欄のある outcome を通した【試作 T-7。(y) の形の観測】。改訂 5 では、Repair の seal と C2Z の readiness は、この欄が空でない outcome を拒む（§3.2）。Verify の outcome の 4 つの検査は今のまま通す。改訂 6：試作 r5 で、4 つの検査は通り、Repair の seal と C2Z の readiness は拒んだ【試作 r5 T-7】。欄の名前は `consumersExcludedNotCurrent` に決めた（§0 の「足す名前」）。
- **案 C の費用**（改訂 4。改訂 6 で試作 r5 の数に改めた）：DR が選びうる形のうち、費用が最大の試作の形で開示する。
  - seam の下で、main が RebuildDerived の work を渡す形では、**全部の wake の後も** Graph の publish が 1 回多く残る（generation 3。案 C なしは 2）。Graph の build の起動の総数は 3 回（案 C なしは 1 回）【試作 r5 T-3 (b)】。改訂 5 が書いた「案 C なしでも後の wake で publish していれば、差は順序の違いになる」には当たらなかった。
  - main が Verify の work を渡す形では、差が無い（どちらも generation 2、起動 1 回。違うのは順序だけ）【試作 r5 T-3 (a)】。
  - 1 回の publish は、Graph の whole-project の build 1 回ぶんの読みと書込み（B-close の上限の内）。大きい形では 1 回の build が長い（§9）。
  - 範囲：1 つの fixture、6 wake の観測で、試験は値を assert していない（出力の記録）。原因は特定していない【推測：案 C の先頭の build の後に Rebuild が Graph の入力を変え、B がもう一度直す】。前の試作の T-11b の seam の形でも、起動順に graph-build が 3 回出ている（`05-gdv1-dev-results.md` の T-11 (2)）。
  - 案 C を狭めるかやめれば、この費用は減るか無くなる見込み（§7 の DR。狭めた形は試作していない【推測】。やめた形の数は、上の「案 C なし」の列）。
  - 製品の既定（gate が閉じている）では案 C は SQL を読まないので当たらない。§7。
  - `validate_phase_success_outcome`（`maintenance_runtime.rs:826-942`）は、名前を挙げた key を読む形で、未知の key を列挙して拒む処理は見当たらない【事実：grep の範囲】。
  - `checkCoverage` は compiled の catalogue と完全一致を要求する（`restore_rebuild.rs:3651-3664`）ので、ここには何も足さない。

## 6. threat model と lifecycle

### 6.1 threat model の差分（proposal/5・/6 の actor・防御・受入れを保持）

- **Trusted**：Verify・digest・Rebuild の既存の owner（maintenance の owned attempt、その connection、hook、transaction）。canonical な metadata、D1 の set・head、V1 の edge、canonical Freshness、Semantic Epoch。
- **Untrusted**：
  - renderer：Verify の分類を直接は動かせない。dirty にするのは既存の writer だけ。
  - 保存データの大きさ（import、restore、外部編集）。
  - DB の外部編集：metadata の `dirty_cache_flag` を 1 にするか、Freshness の行を stale にすれば、その間の Graph の検査を省かせられる。
- **In-scope attacks**
  - (A1) 外部編集で dirty の印を立てて（または Freshness を stale にして）、Graph の edge の検査を省かせる。
    - Graph は query に使われなくなる（dirty は whole-Graph unavailable）。
    - gate が開いた起動では、B は dirty を見て再 build し、再 publish で dirty を 0 にする。そのとき full validation に戻る。
    - **期間に上限は無い**。gate が閉じた起動（製品の既定）では B が走らないので、その DB では対象外が続く。入力の大きさで B が拒否される場合も続く（GDV-R1）。
    - 検査を省いた間も、Graph 以外の consumer の検査と、Graph の edge の malformed・duplicate の検査は変わらない。
    - DB の外部編集は proposal/6 で untrusted の入力に入っているが、DB を書ける actor は、ほかの方法でも Verify の入力を変えられる（今と同じ）。
  - (A2) helper の読みと reader の読みの食い違い：Verify が recognized not-current と読み、reader が current と読む状態。
    - helper の 1 段目は reader と同じ `read_internal(…, true, true, …)` を呼ぶので、同じ snapshot では構造の判定は食い違わない【事実：dev 枝。試作 T-6 (1)】。
    - 2 段目の条件（Freshness・epoch・dirty）は `is_complete_registered` の部分集合なので、helper が current でないとする binding を、reader が current とすることは無い【試作 T-6 (2)：5 形で `is_complete_registered` は全部 false】。部分集合の範囲：2 段目は `canonical_instant` の 2 つと dependency digest の一致（`:2733-2753`）を見ない。見ない分は「今のまま」の側に倒れ、full validation で決まる（§3.1）。
    - 別の snapshot の間の変化は、今の CAS（`graph_state_digest`）と reader の drift の検査で扱う。
  - (A3) incoherent な binding を recognized と誤認する。1 段目が reader の `Reserved` と同じ条件なので、`Reserved` の形は manual のまま【分類の一致は試作 T-6 (1)、試作 r5 T-6 の 21 形】。改訂 6：incoherent の形で Verify を回すと、Graph の edge は unresolvable に入った。`semantic-graph-requires-repair` の Finding までは、制御なしの digest の Err が先に返るので dev の経路では届かなかった【試作 r5】。変更の前の build と同じ結果になることの比較は §8 の【新規】。改訂 2 の「PK・EXISTS だけの安い読み」では、この防御が成り立たなかった（レビュー 2 の M-3）。
  - (A4) recognized not-current の状態を作ってから、Repair を seal させるか、C2Z の readiness を通して C2-ZC の不可逆な cutover を進めさせる（GDV-R9。cutover は改訂 5 で足した。レビュー 3 の M-2）。
    - 改訂 5 の防御：対象外の欄が空でない report からは、Repair の seal と C2Z の readiness を通さない（§3.2 の下流の gate）。cutover は readiness を先に要るので、これも進まない。current な Graph の binding で今閉じているのと同じ。
    - 欄は sealed な report の中にあり、`reportDigest` と outcome の digest で封じられる。欄を消すと digest が外れる。digest を作り直すには Verify の結果を書き換える必要があり、DB を書ける actor（A1 と同じ）に当たる。
    - 改訂 6（レビュー 4 の R-1）：欄が空の report（current の間に封じたもの、改訂の前のもの）を not-current の間に使わせる形は、S-4 の印による `graphStateDigest` の不一致で閉じる（§3.2 の不変条件）。そのため、防御は欄の検査と S-4 の印の 2 つに乗る。印を外す変更は、この防御を壊す。
    - 改訂 6：試作 r5 で、not-current の report の Repair の seal と C2Z の readiness が (x) の code・reason で拒まれ、cutover が進まないことを確かめた【試作 r5 T-1・T-7】。
    - 改訂 4 の防御（参考）：Repair は手動の操作で、自動の経路ではない。Repair の対象は report の一覧で、対象外の Graph の edge は duplicate のほかに入らない【試作 T-7：plan は edge 0 件。(y) の形】。duplicate は UNIQUE 制約で DB が作らせない【試作 T-7】。
  - (A5) は改訂 5 で削った。今の epoch が無い形は、今のまま full validation に渡すので、検査を省かせる形にならない（§3.1。レビュー 3 の M-1）。
- **Out-of-scope**：OS／backend の侵害、同じ OS ユーザーの悪意あるプロセス、意味の品質（proposal/6 と同じ）。
- **Mandatory defenses**：
  - 判定は canonical な値だけを使う（K-3）。
  - 構造の判定は reader と同じ読みを使う（§3.1）。
  - incoherent／unknown は manual-terminal のまま。
  - 保存の超過の前検査を先に保つ。
  - current の binding は今のまま full validation。
  - 判定は、どの制御の下でも full eligibility を読まない。
  - 改訂 5：作り直し待ちの Graph を対象外にした report からは、Repair の seal と C2Z の readiness を通さない（cutover も進まない）。
  - 改訂 6：S-4 の印は、今の計算が作りうる値と重ならず、not-current の Graph の edge では必ず置き換わる（§3.2）。
  - 新しい書込み・保存先・送信先は無い。
- **受入れ（製品の既定）**：`PRODUCT_GRAPH_PUBLISHED` が false の間、製品の DB には Graph の binding が無い。
  - そのため、新しい判定は 1 段目の `Missing` で終わる。読みは、保存の上限の前検査（`nir1_entity_relation_index.rs:2393`）、metadata の PK の読み、D1 head の読み、residue の EXISTS 2 つ（`:2394-2433`）【事実】。
  - S-3 の 4 回の COUNT（`verify_coverage.rs:451-487`【レビュー 2】）は今も行っているもので、増えるのは helper の読みだけ。
  - report と digest は byte で変わらない【試作 T-5・T-8：binding なしと Chronicle だけの fixture で byte 同一】。

### 6.2 lifecycle

- 新しい owner、entry、timer、子 process、永続する状態は無い。
- 判定（§3.1）は、Verify・digest・V2 shadow を呼ぶ既存の呼出しの中で、同じ connection・read transaction・connection-level の progress hook（1,000 VM steps ごと）の下で行う。
  - nested な読みは outer の hook を継承し、install／overwrite／reset しない（proposal/5 の共通規則）。
  - `read_internal` は capacity scope を作るが、nested のときは外側の budget を継承する（`nir1_entity_relation_index.rs:2365-2367` の注）【事実】。
  - cancel、timeout、closed は今の attempt と同じ終わり方。
- **呼出し元には、制御付きと制御なしの両方がある**（レビュー 2 の R-5）。
  - 制御なし（`NeverStopGraphWorkControl`、`allows_full_eligibility == false`）の経路の例【レビュー 2】：
    - `evaluate_completed_run_skip`（`maintenance_skip_evidence.rs:337-342`。呼出しは `maintenance_runtime.rs:3254`、`c2zc_canonical_cutover.rs:278`）
    - `maintenance_skip_evidence.rs:686`、`:690`
    - `terminal_failure.rs:946-947`
    - `restore_rebuild.rs:3521-3528`（呼出しは `repair.rs:787`、`c2z_preparation.rs:1436`、`maintenance_runtime.rs:2792`）
    - main の discovery（`maintenance_runtime.rs:2206-2222`）
  - **判定は、制御付きでも制御なしでも、eligibility を読まない。** helper の読みは `read_internal` と Freshness・epoch の行だけで、Source の解決を含まない【事実：dev 枝】。制御なしで、dirty の binding の digest が `Ok` になり、dirty の間に候補を足しても値が変わらなかった【試作 T-2】。
- **費用**（改訂 2 の「4 面の PK・EXISTS だけ増える」を取り消す。レビュー 2 の M-3）：
  - binding の無い project：helper の読みは §6.1 の受入れの 4 つだけ。
  - binding のある project：
    - 1 段目は、D1 の entry の全件と V1 の Graph の edge の全件の読みと、dependency digest の計算を行う。上限は保存の上限（edge 8,193 行など、`preflight_stored_graph_capacity` の内）。
    - 2 段目は、Freshness の行と epoch の行の PK の読み。
  - current な binding：S-1 の `is_complete_registered` が同じ構造の読みを繰り返す。そのため、Verify の 1 回の attempt で構造の読みが二重になる。S-3 と S-4、Verify と同じ attempt の digest でも、helper を呼ぶ回数だけ増える。
    - helper の結果を同じ transaction の中で使い回して二重を減らすのは、実装の判断に任せる（K-4 の範囲の内）。
    - 二重の上限は、保存の上限の読みを helper の呼出しの回数ぶん、と開示する。
  - recognized not-current な binding：S-1・S-2・S-4・S-5 の eligibility の読み（whole-project）が無くなるので、全体の読みは減る。
  - 試作の S-4 は、helper を digest 1 回につき最大 1 回（Graph の edge があるときだけ）呼んだ【事実：dev 枝】。時間の計測は試作していない。
- **案 C の lifecycle**（§7）：cycle の request に work があるとき、cycle の中で project ごとに 1 回 `plan_graph_index_build` を呼ぶ【事実：dev 枝】。新しい owner・entry・timer は無い。判定の Err は `?` で cycle の Err になる【事実：dev 枝】。gate が閉じていれば SQL を読まずに返る（§7）。
- **quarantine との関係**：
  - workspace の connection の quarantine（cleanup の失敗で unusable）と、C-query worker の quarantine は変えない。
  - binding を「隔離」（残したまま隠す）する新しい状態は作らない。既存の「recognized unavailable」の文を Verify と Rebuild の観測に当てるだけ。

## 7. 案 C（委任の内の DR として扱う）

- 中身：B の gate が開いている project で、Graph の binding が current でないときは、main 由来の durable の work を dispatch する前に、cycle が B の判定（preempt）を通す（§2.4）。
- 目的：B-ROUTE の設計の文「stale な binding は、durable な連鎖より先に、自分の producer が直す」（`maintenance_runtime.rs:2349-2356` の注）を、main 由来の work にも当てる。
  - GDV/1 の下では、Verify や RebuildDerived が先に走っても止まらない【試作 T-3】。
  - それでも、B が直してから Verify が full validation で確かめる順を保つ。
- 契約の文は変えない。DR-PUBG-5-n（decisions）に、owner／lifecycle と信頼境界を残し、作業記録に索引する。
- 製品の既定（gate が閉じている）では、判定は SQL を読まずに `Skip{GateClosed}` を返す（`nir1_graph_index_maintenance.rs:520-521`）【事実】。そのため、挙動は変わらない。
- **試作の形**【事実：dev 枝 `4677649d`】：`run_system_work_cycle_with_nir1_graph_runtime` で、request に work があるとき、その work の project ごとに 1 回 `plan_graph_index_build` を呼び、`preempts_durable_chain()` なら Graph の build を work の先頭に足す。main の discovery は変えていない。
- **試作の結果**【試作 T-3】：
  - 案 C が無くても、Verify と Rebuild-Derived は止まらない（B は cycle の最後の rediscovery で判定される）。案 C は止まりを解くためには要らず、B を先に置く順の保ち方である。
  - 案 C ありでは、B の判定が main 由来の work より先に立った。
  - **main が RebuildDerived の work を渡す形では、最初の cycle の中で、Graph の build の起動が 1 回から 3 回に増え、publish が 1 回増えた**（generation 2 → 3）。原因は特定していない【未確認】。推測：先に B が publish した後、Rebuild-Derived が Graph の入力を変え、B がもう一度直す【推測】。
  - 改訂 5：この数は試験が assert しておらず、出力の記録だけ。その後の wake を含めた総数は記録していない。案 C なしでも後の wake でもう一度 publish していれば、差は総数ではなく順序の違いになる【未確認。レビュー 3 の R-2】。§8 で、最初の cycle の後と全部の wake の後の generation を両方 assert する。
- **試作 r5 の結果**（改訂 6）【試作 r5 T-3。1 つの fixture と 6 wake の観測。試験は generation の値を assert しておらず、出力の記録】：

| 形 | 案 C | 最初の cycle の起動順 | 最初の cycle の後の generation | 全部の wake の後の generation | graph-build の起動の総数 |
|---|---|---|---|---|---|
| (a) main が Verify を渡す | あり（試作の形） | `[graph-build, verify, verify]` | 2 | 2 | 1 |
| (a) | なし | `[verify, graph-build, verify]` | 2 | 2 | 1 |
| (b) main が RebuildDerived を渡す | あり（試作の形） | `[graph-build, rebuild, verify, graph-build, graph-build, verify]` | 3 | 3 | 3 |
| (b) | なし | `[rebuild, graph-build, verify]` | 2 | 2 | 1 |

  - 2 cycle 目以降は、どの形も起動なしで generation は変わらない。
  - **(b) の差は順序の違いではなく、総数の差**として残った。改訂 5 の「順序の違いになる」場合には当たらない。原因は特定していない【推測：案 C の先頭の build の後に Rebuild が Graph の入力を変え、B がもう一度直す】。
  - (a) は総数が同じで、違うのは順序だけ（案 C ありは B が Verify より先）。
- **DR-BSEAM-1 (b) との関係**（改訂 4。改訂 6 で書き直した）：not-current の binding では、main は `Work(Verify)` を返すようになる（§2.2、GDV-R3）。そのため、B の判定は main の wake ではなく cycle の中に移る。案 C を採れば cycle の先頭で、採らなければ cycle の最後の rediscovery で判定される。どちらでも止まらない【試作 T-3、試作 r5 T-3】。
- **DR で決めること**（委任の内。契約の文 §3 はどれでも変わらない）：
  - **案 C の範囲（改訂 6 で、やめる選択肢を足した）**。次の 3 つから選ぶ。
    - **C-1 試作の形のまま**（work の種類によらず先に判定する）。費用は §5 の「案 C の費用」のとおりで、(b) の形で publish が 1 回多く残る。根拠の数は上の表の「あり」の行。
    - **C-2 狭める**：Verify の item の前だけで判定し、RebuildDerived の item の前では判定しない。(a) では試作の形と同じ判定なので、上の表の (a)「あり」の行（総数の差なし、B が先）に当たる見込み。(b) では案 C なしと同じ判定なので、(b)「なし」の行（起動 1、generation 2）に当たる見込み【推測：狭めた形は試作していない。数は上の表の行を当てはめた読み】。
    - **C-3 やめる**：main 由来の work の前では B を判定しない（今の挙動のまま。§2.4）。B は cycle の最後の rediscovery で判定され、止まらない。数は上の表の「なし」の 2 行。B-ROUTE の設計の文「stale な binding は、durable な連鎖より先に、自分の producer が直す」（`maintenance_runtime.rs:2349-2356` の注）は、main 由来の work には当たらないまま残る（今も当たっていない）。
    - **起案者の推奨は C-2**（改訂 5 の推奨「C-1 のまま費用を開示」を改めた）。理由：余分な publish が出たのは (b) の形だけで、(a) の形には総数の差が無く、B を Verify より先に置く順（Verify が作り直した後の Graph を full validation で確かめる順）は (a) の形で保てるため。根拠の数は上の表の (a)「あり」と (b)「なし」の行で、C-2 そのものの数ではない。
    - C-2 か C-3 を選ぶなら、実装の PR で T-3 の 2 形を、選んだ形で取り直す。受入れは、止まらないこと（製品の経路で Idle）、(b) の形の全部の wake の後の generation と graph-build の起動の総数が案 C なしと同じこと、C-2 では (a) の形で B の判定が Verify より先に立つこと（§8）。C-2 が通らなければ C-3 にする（どちらも委任の内）。
    - C-1 を選ぶなら、§5 の費用の開示をそのまま DR と PR 本文に書く。
  - 判定の Err（`?` で cycle の Err になる）を、cycle を止める Err として扱ってよいか。試作は、判定が Err を返す形を試していない【未確認】。request に複数の project の work があるとき、ある project の判定の Err が、ほかの project の work まで止める（試作の形は cycle 全体の Err）【レビュー 3 の R-1】。この影響の範囲も DR で決める。
- **拘束（改訂 5。DR の選択肢ではない。レビュー 3 の R-1）**：案 C は、request の item の reasons の**どれか**が `before-cutover` か `before-cutover-follow-up` なら、その project を判定しない。
  - 理由：「gated route は C2-ZC の BeforeCutover の流れを判定しない」は、既に記録された不変条件である（`maintenance_runtime.rs:2291-2297` の `nir1_graph_index_build_wakes_main_discovery`、`nir1_graph_index_maintenance.rs:509-530` の `judge_graph_index_build` の doc と `:529` の Skip【事実】。DR-BSEAM-2（`bseam-decisions.md:11`）【レビュー 3】）。改訂 4 はこれを「判定しても C2-ZC の流れを壊さない」と並べて DR の選択肢に残していたが、記録済みの不変条件を DR で外す余地になるので、改訂 5 で拘束にした。
  - §7 の「main 由来の durable の work」は、字面では before-cutover の work も含む。request は `before-cutover` の reason を持てる（main から拒まれるのは follow-up の reason だけ。`maintenance_runtime.rs:1418-1424`）【事実】。
  - item の reason は複数ありうる。`maintenance_rediscovery_reason` は、Verify の item で follow-up を返すほかは先頭の reason を返す（`:2715-2730`）【事実】。そのため、先頭の reason だけでなく、reasons のどれかで判定する。
  - 試作の形（reason を `"durable-wake"` に固定）は、この拘束を満たさない【事実：dev 枝】。差し込みの位置では `item.reasons` が取れる（`DesiredWork.reasons`）ので、実装できる【レビュー 3 の R-1】。§8 で試す。
  - 改訂 6：試作 r5 で実装して確かめた【試作 r5 T-3。陽性対照と対で一致。試験は 1 つの assert と出力の記録】。
    - Verify の item の `[workspace-opened]`（陽性対照）：案 C ありで最初の起動が `graph-build`。
    - `[workspace-opened, before-cutover]` と `[before-cutover]`：案 C あり・なしとも `[verify, rebuild, verify]` で、graph-build の起動なし。
    - **`[before-cutover-follow-up]` は、request の preflight が拒む**（`NEX_MAINTENANCE_INVALID_REQUEST: C2-ZC follow-up reason is Rust-internal`。`maintenance_runtime.rs:1418-1424`）。cycle に届かないので、request から渡す試験は作れない。拘束の follow-up の側は、Rust の内部で follow-up の reason が item に入る場合に備えた防御として残す。follow-up の経路そのもの（`before-cutover` の Verify の後に Rust が内部の reason で Rebuild を挙げる）は、試作 r5 の T-11 で通った。
    - RebuildDerived の item の `[workspace-opened, before-cutover]` では、案 C は先頭で判定しなかった（最初の起動は `rebuild`）。ただし、cycle の最後の rediscovery は先頭の reason（`workspace-opened`）で B を判定し、最後に graph-build が起動した（`[rebuild, graph-build, verify]`）。拘束が止めるのは案 C の判定だけで、cycle の最後の rediscovery（`maintenance_rediscovery_reason` が先頭の reason を返す。`:2715-2730`）は止めない。
    - この最後の起動は、案 C の無い build でも起きる既存の挙動と読む【推測：この reasons の組の案 C なしの対照は記録に無い。案 C なしの (b) の行の起動順 `[rebuild, graph-build, verify]` と同じ形】。reasons が混ざった item で、先頭が before-cutover でないときに B を判定することが、既存の不変条件（gated route は BeforeCutover の流れを判定しない）に当たるかは、DR で扱う論点として残す。GDV/1 と案 C は、この rediscovery を変えない。
- seam の下の評価では、maintenance の順序が変わりうる。merge の時期は GDV/1 の実装と同じ（次の S4 の PR の後）。
- main の discovery が `capacity-exceeded` の Err を返す形（保存の超過）では cycle が始まらない。これは保存の超過（破損の印）なので、GDV/1 でも止まりとして残す。`discover_all` の封じ込めは別の DR で扱う。
- `maintenance_runtime.rs` は、9 回目の S4 の作者の宣言（`evals/nir1-graph/observation-prep-author-declaration.v1.json:165`。読んだ file の SHA-256 の記録、scope「journey seam の gate と CI config」、source `7a10dd11`）に載っている【事実：`5eca1074`】。案 C でこの file が変わると、次の S4 の作者は読み直して開示する必要がある【推測】。

## 8. 受入れ（実装の PR で示すもの）

- dev 試作の試験（`gdv1_*`、`gdv1r5_*`、`gdv1_dev_support.rs` ほか）は dev 専用で merge しない。実装の PR は、下の受入れを製品の試験として書き直す。印【試作済み】は dev 試作（前の試作か試作 r5）で合格したもの（実装の PR で取り直す）、【新規】は試作が実施しなかったもの（§10.3）。改訂 6 で、試作 r5 で合格した行を【試作済み】に改めた。試作で出力の記録だけだった値（試験が assert していないもの）は、実装の PR で assert にする。
- **拒否の試験の書き方**（改訂 6。レビュー 4 の R-2）：拒否を確かめる行は、拒否が起きたことだけでなく、**拒否の理由の code か reason まで assert** する。readiness にはほかに 6 つの gate と scheduler の liveness が、Repair には多数の前提の検査があり、拒否の有無だけでは、ほかの gate で落ちても合格してしまうため。あわせて、同じ fixture で検査の対象だけを変えた対照（欄を空にした形など）が通ることも示す。
- **Positive**
  - 【試作済み】V0 の (b) の形（候補 2,065 件、binding が dirty、B が `RefusedUnchanged`）で、製品の経路と seam の wake を 6 回重ねる。
    - binding が、reader の構造の読みで `Registered{dirty:true}`（helper で recognized not-current）になる。
    - main の discovery が Err を返さない。
    - Verify は completed（clean。Graph は対象外の欄に出る）。
    - Finding は増えない。
    - 製品の経路（gate なし）では、durable な連鎖は先に進み、Idle に達する。seam の wake では、durable な連鎖が終わった後も `GraphIndexBuildWake` が続く（B は `RefusedUnchanged` のままで、新しい Run は作られない）。どちらも Run の数は有界。
    - 【試作済み】（改訂 6。試作 r5 T-1）改訂 5 の 3 点（判定の順、下流の gate の検査、before-cutover の拘束）を入れた head で、この形を **marker のある DB と無い DB の両方**で取り直し、どちらも製品の経路の wake#1 で Idle、Finding 0、Err 0 になる。T-11 の 2 形も同じ head で取り直す【試作 r5 T-11】。
  - 同じ形で、Graph 以外の consumer に `rebuild_required = true` が立つ場合も、Rebuild-Derived が completed になり、製品の経路で連鎖が Idle に達する（S-5）。
    - 【試作済み】Graph 以外の Edge State を 1 行消す形、Semantic Epoch を回す形。
    - 【試作済み】（改訂 6。試作 r5 T-11）`latest_completed_rebuild` が current でない形（wake#0 が `Work(Verify, reasons=["before-cutover"])`、cycle は `[verify, rebuild, verify]`）と、completed な Rebuild の outcome が current でなくなった形（wake#0 が `Work(RebuildDerived, reasons=["before-cutover"])`、cycle は `[rebuild, verify]`）。marker の有無の両方で、以降は discovery が `None`、Err 0、Finding 0。before-cutover の follow-up は、前者の cycle の Rust の内部の経路として通る（request から follow-up を渡す形は preflight が拒むので作らない。§7）。
    - 【新規】`latest_completed_rebuild` を current でなくした形の seam あり。
  - B が再 publish すると、次の Verify は Graph を full validation で確かめ、完了証跡の digest は新しい metadata・Freshness の値で作られる。【試作済み】は、再 publish の後の Verify の対象外の欄が空になったこと（T-9 (i)・T-11 の seam の形）と、metadata・Freshness を変えると digest が変わること（T-2）まで。【新規】再 publish の後の Verify が Graph の edge を full validation で確かめた（unresolvable と Source の検査に Graph の edge が入る）ことを直接 assert する。
  - 期限の拒否（`elapsed_deadline…` の形）で dirty のまま残っても止まらない。【試作済み】Verify（T-4）。【試作済み】（改訂 6。試作 r5 T-4。assert あり）同じ形で `rebuild_required = true` を立てても、wake#0 の cycle が `[verify, rebuild, verify]`、Rebuild は completed、以降 Idle。
  - 【新規】incremental Freshness を、実際の Scene の編集の change feed で回しても、eligibility の Source を解決せず、Err にならない（T-12 は probe での直接呼出しだった）。
  - 【新規】（改訂 6 で書き換えた）`semantic-graph-requires-repair` の Finding がある completed・non-clean の形を、改訂の後の build で開くと、Verify がやり直しになり、clean なら Finding が解消される。Finding は SQL か直接の projection で作る。dev の経路（製品の discovery、制御つきの wake、制御つきの Verify の cycle）では、この Finding はどの形でも作れなかった【試作 r5】ので、製品の経路で作る形は求めない。
  - 【試作済み】（改訂 6 で書き換えた。試作 r5 T-6）今の epoch が無い形で binding を持つ project：dirty=0 と dirty=1 の両方で、helper は「今のまま」（試作の値は `NoCurrentEpoch`）を返し、`is_complete_registered` は `Ok(false)`（容量の Err にならない）、B の hint は `Skip{NoEpoch}`。epoch が作られた後は、helper が recognized not-current を返し、B の hint は build を返す。**reason は `Build{Rebuild, BindingDirty}`**（改訂 5 の見込み `Build{NotCurrent}` ではない。dirty=0 から始めても同じ）。受入れは「build を返す」までとし、reason は記録する。
    - 【新規】epoch を `create_epoch_in_tx` の代用ではなく、Backfill の実際の run で作った形で同じことを確かめ、epoch の作成の後の `dirty_cache_flag` の値を記録する。
- **Negative**
  - incoherent な binding（`Reserved` に当たる形）は、今のまま止まる。【試作済み】は分類まで（helper の incoherent と reader の `Reserved` が一致。前の試作 T-6 (1) の 19 形、試作 r5 T-6 の 21 形）と、Verify の report（試作 r5：形 14・16・19・11 で Verify は completed、Graph の edge が unresolvable に入る。出力の記録）。【新規】（改訂 6 で書き換えた）incoherent の形の Verify の report、main の discovery の結果、Finding の有無が、変更の前の build と同じであることを assert する。dev の経路では `semantic-graph-requires-repair` の Finding まで届かなかった（制御なしの digest の `context-unavailable` が先に返る。§2.3）ので、「Finding まで通る」は受入れにしない。D1 head の `Corrupt` の形も加える。
  - 【試作済み】保存の超過（V0 の (a)）は、今のまま止まる。
  - current な binding では、S-1〜S-5 の結果が今と同じ。【試作済み】S-1〜S-4（report と digest が前後で byte 同一、T-5）。S-5 は、current な Graph の head を飛ばさず診断の行が出ないことまで【試作 r5（同じ build の中の比較）】。【新規】S-5 の結果（current な Graph の head での Rebuild の V2 shadow の要約）が、変更の前の build と同じ。
  - 【新規】current と分類されて full validation が false になる形のうち、試作で作っていない 2 つ（eligibility の今の Source との source digest のずれ、edge と Source の不一致）で、今のまま manual になる（§5 の「残る止まり」）。形 17・18（Edge State が stale／別 epoch）は、試作 r5 で Verify が completed、Graph の edge が unresolvable に入り、manual の側のままだった【試作 r5。出力の記録】。変更の前の build との比較は【新規】。
  - 【試作済み】判定は full eligibility を読まない（制御なしで呼んでも `ContextUnavailable` にならない）。
  - 【試作済み】（改訂 5。試作 r5 T-6。assert あり）helper が recognized not-current とする形では、どれも、gate を開けた B の hint が build を返す。21 形の全部が適用されたことを assert し、SQL を適用できなかった形を黙って飛ばさない。helper と reader の一致は作りから決まるので、回帰の試験として残す【レビュー 3 の軽微】。
  - 【試作済み】（改訂 5。レビュー 3 の R-6。試作 r5。assert あり）not-current の Graph の head を飛ばした V2 shadow の要約は、Graph の head が最初から無い DB の要約と、diagnostics の 1 行（`NEX_V2_SHADOW_REBUILD_RECOGNIZED_UNAVAILABLE:semantic-index:…`）を除いて同じ（`active_head_count`、`declaration_count`、`evaluated_declaration_count`、ほかの diagnostics）。【新規】同じ比較を、変更の前の build の要約と行う（試作 r5 は同じ build の中の比較で代えた）。
  - 【試作済み】（改訂 6。試作 r5 T-2 (4)。assert あり）S-4 の印（`{"status":"recognized-unavailable"}`）が、今の計算の作る 5 つの status と重ならないことの単体試験。
  - **（改訂 6 で書き換えた。GDV-R9 の (x)。レビュー 4 の R-2）対象外の欄が空でない clean な report について**。どの行も、拒否の理由の code か reason を assert する：
    - 【試作済み】（試作 r5 T-7。assert あり）Repair の plan の seal が **`NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`** で拒否される。apply の re-seal の経路でも同じ code で拒否されることは【新規】。
    - 【試作済み】（試作 r5 T-7。assert あり）C2Z の readiness の Verify の gate が `Blocked`、reasons がちょうど **`["verify-graph-recognized-unavailable"]`** で、`report_clean=true`。project と workspace の readiness が ready にならない。
    - 【試作済み】（試作 r5 T-1。出力の記録）cutover の前の DB（marker なし）で、`cut_over_workspace_freshness` が `NEX_C2ZC_CUTOVER_NOT_READY` を返し、marker を書かない。最後の round では、readiness のほかの gate（rebuild、phase、parity、active）が `Passed` で、Verify の gate だけが `Blocked / ["verify-graph-recognized-unavailable"]`。【新規】これを assert にし、cutover の Err の message が `verify-graph-recognized-unavailable` を含むこと、同じ fixture で制御なしの `evaluate_completed_run_skip` が Skip を返すこと（readiness の (x) が唯一の関門であること）も assert する【レビュー 4 の R-2】。
    - 【試作済み】（試作 r5 T-1。出力の記録）同じ形で (x) の検査だけを外した (y) の build では、2 round 目に cutover が成功し marker が書かれる。【新規】実装の PR では、同じ fixture で欄を空にした対照（または検査を外した対照）が通ることを、拒否の行と対で示す。
    - 【試作済み】（試作 r5 T-1。marker ありの形 D）cutover の済んだ DB では、marker を見て今どおり返る。
    - 【試作済み】（試作 r5 T-1）skip の証跡の評価と main の discovery と cycle は今のまま通り、連鎖は marker の有無によらず製品の経路の wake#1 で Idle に達する（上の Positive と同じ run）。marker の無い DB では、cutover だけが進まない。【新規】cutover の loop で Run の数が増え続けないこと（後の round で Run が増えない。試作 r5 は 8 round で 5 → 8 で止まった。値そのものは assert しない）と、before-cutover の discovery が最初の cycle の後は `None` であることを assert する。
    - 【試作済み】（試作 r5 T-7。baseline の写しとの比較）対象外の欄が空の report（binding なし、current な binding、Chronicle だけ）では、Repair の seal と C2Z の readiness の結果が変更の前と同じ。
    - 【試作済み】（前の試作。(y) の形の観測。試作 r5 T-7 で取り直し）Verify の outcome の 4 つの検査は、対象外の欄のある outcome を通す。前の試作で Repair の seal を開いた形では、plan は Graph の edge を含まなかった。(x) では seal そのものが拒否されるので、この観測は参考に留める。
  - 【新規】（改訂 6。レビュー 4 の R-1）**current で封じた report の後で not-current になる形**：Graph が current の間に clean な Verify を封じ（欄は空）、その後に binding を dirty にする。Repair の seal は `NEX_VERIFY_GRAPH_STATE_CHANGED` で、C2Z の Verify の gate は `verify-graph-state-invalid: NEX_VERIFY_GRAPH_STATE_CHANGED…` で拒まれ、cutover は進まない（§3.2 の不変条件）。binding が無い状態で封じた report から not-current に変わる形も同じ（試作 r5 の cutover の loop の最初の round の `NEX_VERIFY_GRAPH_STATE_CHANGED` は、この形の部分的な裏付け）。
  - 【新規】（改訂 6。レビュー 4 の m-4）foreground の Verify の完了（`complete_foreground_system_work_run`）：not-current の Graph の clean な outcome で完了が通り、skip の証跡が seal される（GDV-R9 の「開く」）。current な Graph では、今どおり制御なしの digest の Err で完了が通らない見込み【推測：`maintenance_runtime.rs:1118` の読み。試していない】。結果が変更の前の build と同じであることを記録する。
  - 【試作済み・記録】改訂の前に Verify が容量で failed になった形は、改訂の後も、同じ Semantic Epoch の間は自動では戻らない（§5 の開示どおり）。
- **座標と byte 互換**（K-2 の選ばれた案による）：
  - 共通：`current_maintenance_coordinates()` の 3 つの digest と `REBUILD_CONTRACT_VERSION` が、変更の前と同じ【試作済み】。
  - (b) のとき：
    - `VERIFY_CONTRACT_VERSION` が `"9"` のまま【試作済み】。
    - binding の無い fixture、current な binding の fixture、Chronicle の binding だけの fixture で、`serde_json::to_value(report)` と `durable_graph_state_digest` が変更の前後で byte 同一（Err になる読みは、前後で同じ Err）【試作済み】。
    - 変更の前の build で sealed した outcome を、5 つの読み手（main の discovery、制御付き・制御なしの cycle の skip 判定、Repair の seal、C2Z の readiness）に通した結果が、変更の前後で同じ。clean な outcome では、やり直しにも拒否にもならない。current な binding の制御なしの読み手は、前後とも `context-unavailable`（GDV/1 の前からの挙動）【試作済み：binding なしと current な binding の fixture】。
      - 改訂 5 の断り（レビュー 3 の R-3）：current な binding の fixture では、5 つのうち 4 つ（discovery、制御なしの skip、Repair の seal、C2Z の readiness）が前後とも同じ Err か `Blocked`（discovery・制御なしの skip・Repair の seal は `context-unavailable`、C2Z の readiness は `Blocked`）で、制御なしの digest も前後とも Err だった。中身のある結果どうしの一致は、制御つきの skip（`ForegroundValidationControl` の代用）の 1 つだけ。binding なしの fixture では、5 つとも中身のある結果で一致した。report の比較は `serde_json::Value` の等価で、digest は文字列の一致。
    - 【新規】Chronicle の binding だけの fixture で、今の契約の clean な outcome を持つもの（試作の写しは `GraphContractMismatch` の outcome で、この確認ができなかった）。
    - 【新規】制御付きの skip 判定を、`ForegroundValidationControl` の代用ではなく、cycle の制御で通す。
  - (a) のとき（試作していない。全部【新規】）：
    - `VERIFY_CONTRACT_VERSION` が `"10"`。
    - 変更の前の build で sealed した outcome は、1 回だけやり直しになり、その後は skip される。
    - 改訂の前に Verify が容量で failed になった形が、版の不一致で戻るかを記録する（§5）。
- **案 C**（DR の形による）：
  - 【試作済み】main が Verify の work を渡す形と RebuildDerived の work を渡す形で、止まらず、B の判定が先に立つ。余分な build の回数を記録する。
    - 【試作済み・記録】（改訂 5。レビュー 3 の R-2。試作 r5 T-3）案 C の有り無しの両方で、最初の cycle の後の generation と、全部の wake の後の generation を記録した（§7 の表。(b) の形は 3 対 2）。試験は値を assert していない。【新規】実装の PR では、DR で選んだ形で、この 2 つの generation と graph-build の起動の総数を assert する。C-2 か C-3 なら、(b) の形で案 C なしと同じ（generation 2、起動 1）こと、C-2 なら (a) の形で B が Verify より先に立つことを受入れにする（§7）。C-1 なら、(b) の形の値を、開示した値を上限として assert する（generation は 3 以下、起動は 3 回以下）。原因が未特定で 1 つの fixture の観測なので、値そのものの一致は求めない（開示より少なければ合格）。
  - 【試作済み】（改訂 5 で拘束にした。§7。試作 r5 T-3）request の item の reasons のどれかが `before-cutover` の work では、案 C がその project を判定しない（`[before-cutover]` と `[workspace-opened, before-cutover]` で graph-build の起動が先頭に立たない。陽性対照の `[workspace-opened]` では立つ）。【新規】これを陽性対照と対の assert にする。`before-cutover-follow-up` は request の preflight が拒むので、request から渡す試験は置かない（拘束の実装は follow-up も含める）。reasons が混ざった RebuildDerived の item で cycle の最後の rediscovery が B を起動すること（§7）は、記録に留める。
- **既存の試験**：
  - B-ROUTE、BSEAM、#5、Verify、maintenance、V2 shadow（`restore_rebuild.rs:6875-6935`）の既存の試験は、次の 3 件を除いて、無変更で通る【試作済み：`4677649d` の全件の run で 2772 passed、落ちたのは次の 3 件だけ】。
  - **書き換える試験**（行は dev 枝。master では `nir1_entity_relation.rs` が 2 行下がる。PR 本文に一覧する）：
    1. `nir1_graph_index_maintenance::tests::b_route_wake_rebuilds_a_graph_made_stale_by_a_retired_revision`（`nir1_graph_index_maintenance_tests.rs:2162-`、assert は `:2208`）：制御なしの planner が `context-unavailable` で落ちることを `expect_err` で assert する（DR-BSEAM-1 (b)）。書き換え：not-current の binding では planner が `Ok` を返し、main が `Work(Verify)`（または `GraphIndexBuildWake`）を返すこと。main の discovery の値の assert（今は `GraphIndexBuildWake`）も、GDV/1 の後の値に合わせる。再 publish の後の状態（generation 2・dirty 0・`is_complete_registered` が true・B の hint が `Skip{BindingCurrent}`）の assert は今のまま。試験の注（`:2194-2196`）も書き直す。この試験の assert を根拠にした DR の記録（DR-BSEAM-1 (b)、DR-BSEAM-3、DR-BSEAM-6 (3)）に、GDV/1 の後の前提の変化を注として足す（改訂 5。GDV-R3）。
    2. `nir1_entity_relation::tests::graph_index_dirty_keeps_generation_and_invalidates_usability`（`nir1_entity_relation.rs:9477-`、assert は `:9523` 付近）：「dirty な Graph は Verify の coverage に incomplete として見え続ける」を assert する。書き換え：coverage の検査は consistent（宣言済みとして引く。GDV-R7）、Verify の report の対象外の欄に Graph の key と件数が出る、Graph の edge は unresolvable に入らない。「Verify に見え続ける」は、対象外の欄で保つ。generation を保つことと、reader の usability が無効になることの assert は今のまま。
    3. `nir1_entity_relation::tests::graph_index_real_source_and_scope_writers_dirty_and_reject_old_snapshot`（`:9581-`。helper `assert_graph_verify_reports_dirty` `:11165-`）：同じ書き換えを helper に入れる。
  - 書き換えは、この 3 件の「dirty な Graph の旧い扱い」の assert に限る。ほかの assert を弱めない。
  - 【新規】書き換えた後の head で、`cargo test -p grimodex-db --lib` の全件を取り直す。試作 r5 の head `ec550a58` の全件（2,852 件）は、2,783 passed・3 failed・66 ignored で、落ちたのは上の 3 件だけだった【試作 r5】。改訂 5 の 3 点で新しく落ちた既存の試験は無い。
  - clippy：
    - 【試作済み】（試作 r5）CI の形（`cargo clippy -p grimodex-db --all-targets -- -D warnings`）と、Native の形（`electron/native/grimodex-node` の `--features licensing,legacy-keyring-migration`）は exit 0。実装の head で取り直す。
    - （改訂 6 で書き換えた）`--features nir1-material-diagnostics` 付きは、試作 r5 で exit 101 だった。指摘は GDV/1 が変えていない 3 file（`nir1_graph.rs`、`nir1_graph/input.rs`、`nir1_graph_memory_diagnostics.rs`）だけで、基点でも通らない見込み【推測：基点では走らせていない】。受入れは「基点と同じ指摘だけで、GDV/1 が変える file に指摘が無い」に改める。【新規】基点で同じ command を走らせ、指摘の一覧が同じことを確かめる。基点で通るなら、改訂 5 までの受入れ（exit 0）に戻す。この feature 付きの clippy は CI の `ci.yml` の command に入っていない【試作 r5 の記録】ので、CI の閾値には当たらない（§18）。
  - 【新規】`validate-semantic-core-boundary.mjs` が通る（試作は `node_modules` が無く未実施）。`validate-native-writer-ownership.mjs` は試作と試作 r5 で通った（`ok (active=79, scanned=430)`。r5 は `repair.rs` を変えた head）が、実装の head で取り直す。
  - `native-architecture.mjs` は変えずに通る。
  - 【試作済み】（改訂 5。試作 r5）`repair.rs`・`c2z_preparation.rs`・`maintenance_runtime.rs`・`c2zc_canonical_cutover.rs` の既存の試験が無変更で通る。【新規】C2-ZC の Rust の受入れの freeze gate（`c2-zc-readiness-corruption-fail-closed` を含む）の receipt を、実装の head で取る（§9。試作 r5 は receipt を取っていない）。
- **§8 が通らないとき**：§1.3 の 5。§3・§5 の文と食い違えば、実装の PR を止め、版を改めて改めて確認を伺う。

## 9. 評価への影響

- **実装の時期**：次の S4（9 回目）の PR の merge の後（選択の段の回答）。
  - その PR は #923 で merge 済みに見える（冒頭の「時期に関わる変化」）。条件が満たされたかは integrator が確かめる。
  - 9 回目の正式 run の候補には入らず、その run は GDV/1 なしの挙動を測る。
  - 測った候補と公開する候補の差は、PUB-G #15（候補の同一性。Q7「次の S4 の run を正とする」）で扱う。
- **S2・harness・K6/7**：変えない。
  - B の判定の code も Verify の report の新しい欄も、scripts・evals・electron から参照されていない【事実：B の判定の code は `git grep` で該当なし。Verify の report の新しい欄は今は無い】。
  - evals・scripts・electron が Verify の outcome の report の欄を読む箇所は、`git grep "unresolvable\|semantic-graph-requires-repair"` では見つからなかった（electron の語は別の意味）【試作 T-10。grep の語の範囲での確認】。
- **CP-4 の数え方**：reader の理由と Graph の可用性は変わらない（dirty の間は今と同じく unavailable）。first-render や窓外の数え方に効く経路は無い【推測】。
- **CP-4 の run の中の maintenance**：
  - seam の下で Graph の binding が dirty の間、Verify と Rebuild-Derived は止まらず、durable な連鎖が進む。案 C を採れば（DR の C-1・C-2）、B の判定が main 由来の work（C-2 では Verify の work だけ）より先に立つ。
  - そのため、10 回目以降の run では、maintenance の時刻と DB の取り合いが変わりうる。
  - R1022＋2,000 場面の形で、index の build が 180 s の期限で落ちる記録がある（`graph-registration-window-decisions.md:735`。precheck の引用で【未確認】）。大きい形の run では、dirty の間の Verify と Rebuild の挙動の差が出うる。
  - 試作の形の案 C（C-1）は、seam の下で main が RebuildDerived の work を渡す形で、Graph の publish を 1 回多く残す（全部の wake の後も generation 3 対 2、build の起動 3 回対 1 回。§5、§7【試作 r5 T-3】）。大きい形では 1 回の build が長いので、run の中の maintenance の時間が延びうる【推測】。C-2・C-3 では、この増加は無い見込み【推測】。
  - 改訂の前の build で Verify が容量で failed になった評価の DB を、改訂の後も使い続けると、同じ Semantic Epoch の間は自動では戻らない（§5）。評価の run が DB を新しく作る形なら当たらない【推測】。
  - 改訂 5：作り直し待ちの Graph がある間は、Repair の seal と C2Z の readiness が閉じたまま（今の current な Graph と同じ）。評価の DB は cutover の済んだ形なので、cutover の挙動は変わらない【推測：評価の DB が cutover の後に作られる読み。`nir1_capacity_fixtures.rs:442` などの fixture は marker を書く】。改訂 6：capacity の fixture が marker を書くことは【レビュー 4：`nir1_capacity_fixtures.rs:442`】。CP-4 の評価の DB が marker を持つかは【未確認】。marker の無い DB でも、自動の保守は Idle に達し、止まるのは cutover だけ【試作 r5 T-1】。
- **Verify の再利用**：
  - K-2 (b)：更新の時点で recognized not-current の binding を持つ評価の DB は、digest の値が変わって、完了済みの Verify が 1 回やり直しになる。
  - K-2 (a)：評価の DB は全部、1 回やり直しになる。
- **pin と作者の宣言**：
  - GDV/1 が変える Rust の file は、`restore_rebuild.rs`、`verify_coverage.rs`、`nir1_entity_relation_index.rs`（helper。K-4）。案 C は `maintenance_runtime.rs` を変える。
  - 改訂 5 で、`repair.rs`（`seal_repair_plan`）と `c2z_preparation.rs`（`inspect_verify_gate`）が加わる（§3.2 の下流の gate）。
    - この 2 つは、Verify の契約の座標の材料に入っていない【事実：`maintenance_contracts.rs:40-100`、`:240-300` が source を読む file は `repository.rs`、`legacy_backfill.rs`、`c2zc_canonical_cutover.rs`、`nir1_chronicle_index/publish.rs`、`nir1_entity_relation_index.rs` の 5 つで、読むのは writer の symbol があるかだけ】。そのため、K-2 (b) の拘束 3・4（座標と版を変えない）とは矛盾しない。試作も `nir1_entity_relation_index.rs` を変えて座標が同じだった【試作 T-5】。
    - （改訂 6 で因果を直した。レビュー 4 の R-4）`c2z_preparation.rs` は、C2-ZC の Rust の受入れの freeze gate（`scripts/c2zc-rust-acceptance-receipt.mjs:127-152` の `c2-zc-readiness-corruption-fail-closed`、`evals/impact-map.yaml:902-924` で `requiresReceipt: true`）の source に名指されている【事実：行は改訂 6 で読み直した】。ただし gate の `source` は試験の置き場で、発火の条件ではない読み。この gate の群は impact-map の unit `narrative-maintenance-product-journeys`（`evals/impact-map.yaml:797-`）にあり、unit の paths に `src-tauri/crates/grimodex-db/src/narrative_extraction/**`（`:823`）が入っている【レビュー 4】。そのため、GDV/1 の実装の PR は、`restore_rebuild.rs` などの `narrative_extraction/**` を変えるだけで、既にこの unit に当たる（receipt が要る）読み。`c2z_preparation.rs` の変更は、その gate の試験の file を変えるだけで、改訂 5 で増えた義務ではない。local-ci が stage を選ぶ条件の細部は【未確認】。receipt は実装の head で取る（§8 の「既存の試験」）。
    - `repair.rs` は `validate-native-writer-ownership.mjs` に載っている（下）。`c2z_preparation.rs` は、`scripts/quality/impact-map.test.mjs`、`scripts/local-ci.test.mjs`、`scripts/c2zc-renderer-mcp-dml-denial.test.mjs` にも名がある【事実：`git grep`】。
  - 最近の正式 run（s7r2）の pin には、`restore_rebuild.rs`、`verify_coverage.rs`、`maintenance_runtime.rs` は入っていない【レビュー 1：pin 45 件、73 file】。`nir1_entity_relation_index.rs` が入っているかは【未確認】。
  - `5eca1074` の `evals/` と `scripts/quality/` を `git grep` すると、次のとおり【事実】。
    - `maintenance_runtime.rs` は、9 回目の作者の宣言（§7）に読んだ file として載っている。
    - `restore_rebuild.rs` は `evals/impact-map.yaml`・`evals/quality-manifest.yaml` に載っている。
    - `nir1_entity_relation_index.rs`・`verify_coverage.rs`・`repair.rs` は、`scripts/quality/validate-native-writer-ownership.mjs`・`validate-semantic-core-boundary.mjs` に載っている。
    - `validate-native-writer-ownership.mjs` は試作の枝で通った。`validate-semantic-core-boundary.mjs` は試作で未実施【試作 T-10】。§8 で実装の head で取る。
  - 9 回目の S4 は凍結済み（#923）なので、GDV/1 と案 C の変更は 9 回目の pin・宣言には入らない。10 回目以降の S4 で、作者が読み直して開示する（S4 の pin を単独で変えない）。
- **製品の wake の下の効果**：Q2b の回答どおり、CP-4 では測らず、dev の journey（凍結の外）で確かめる。

## 10. 最終確認の前の dev 試作（凍結の外、dev 枝、push しない、判定外）

- 実施した（2026-11-17）。枝 `claude/gdv1-dev`（基点 `5eca1074`、head `2a01e0cc`、push していない、PR なし）。worktree `/home/grimodex/worktrees/Grimodex/gdv1-dev`。記録は `/home/grimodex/fusion-eval-data/pubg-a/05-gdv1-dev-results.md`（改訂 3 の予定の `05-gdv1-proto.md` ではない）。
- §10.1 は改訂 3 の計画（合格の条件）をそのまま残す。結果は §10.2、試作が実施しなかった項目とその扱いは §10.3。
- 改訂 6：改訂 5 の 3 点を入れて取り直した（試作 r5。2026-11-17。同じ枝、head `ec550a58`、push していない、PR なし。記録 `/home/grimodex/fusion-eval-data/pubg-a/05-gdv1-dev-results-r5.md`）。結果は §10.4。§10.1・§10.2 は前の試作の記録として書き換えない。§10.3 の「扱い」の列は、試作 r5 の結果で改めた。
- §10.2 の T-1・T-3・T-11 の「Idle に達した」は、marker がある DB での観測である（冒頭の記法の注）。

### 10.1 計画（改訂 3 のまま）

- 置き場所：V0 と同じ形の dev 枝（例 `claude/gdv1-dev`。origin/master から作る。push しない）。
- 試験の置き場所：
  - B の形の試験は `nir1_graph_index_maintenance_tests.rs` の末尾。V0 の `v0_probe_candidates`、`v0_probe_edges`、`v0_probe_nobind_candidates` と、既存の `capacity_n_plus_one_is_refused_without_partial_and_retried_on_change` の fixture を借りる。
  - Verify・digest・V2 shadow の単体の試験は、`restore_rebuild.rs`／`verify_coverage.rs` の試験 module。
- 実行：`cargo test -p grimodex-db --lib <filter> -- --nocapture --test-threads=1`（`CARGO_TARGET_DIR=/home/grimodex/cargo-targets/gdv1`）。clippy は `--features nir1-material-diagnostics` を含む。
- 結果の記録：`/home/grimodex/fusion-eval-data/pubg-a/05-gdv1-proto.md`（contracts の外）。

| # | 確かめること | 試験の形 | 合格の条件（本文と合わなければ版を改める） |
|---|---|---|---|
| T-1 | **digest の側の失敗（V0 の (b)）を避けられるか** | V0 の `v0_probe_candidates` を GDV/1 の試作の上で走らせる。候補 2,065 件、binding が dirty、B を 1 回 dispatch して `Refused`。その後、main の制御なしの discovery（`discover_maintenance_project_for_main`、seam なしと seam あり）と制御付きの cycle を、wake ごとに 6 回 | (0) 前提：その binding が `read_internal(…, true, true, …)` で `Registered{dirty:true}` になり、helper が recognized not-current とする（`Reserved` なら GDV/1 は動機の形を解けないので、版を改める）。(1) 6 回とも discovery が Err を返さない。(2) Verify の Run が completed で、report の対象外の欄に Graph の key。(3) Finding が 0。(4) 連鎖が Idle に達する。(5) V0 の対照（binding なし）と同じく Run が無駄に増えない |
| T-2 | S-4 の digest が full eligibility を読まない | `durable_graph_state_digest_with_control` を、`allows_full_eligibility` が false の control で、recognized not-current の binding を持つ project に呼ぶ。あわせて current な binding で、制御なしの digest を呼ぶ | (1) `ContextUnavailable` にならない。(2) 値は metadata・D1・Freshness を変えると変わり、dirty の間に候補を足しても変わらない（GDV-R5）。(3) current な binding では今と同じ値。(4) 印（`resolvedSource`）が、今の `durable_resolved_source_value` の作りうる値と重ならない。(5) current な binding の制御なしの呼出しが `ContextUnavailable` になるかを記録する（GDV/1 の前からの挙動。なるなら §5 の「残る止まり」の記述を確かめる） |
| T-3 | 順序（案 C の要否と効果） | main が Verify の Work を返す形（V0 の `05-v0.md:29,31`）と、main が RebuildDerived の Work を返す形を、案 C の有り無しの 2 通りで走らせる | 案 C なしでも Verify と Rebuild-Derived は止まらない（GDV/1 の効果）。案 C ありでは、B の判定がそれらより先に立つ |
| T-4 | 期限の拒否でも止まらない | 既存の `elapsed_deadline_is_a_typed_refusal_that_keeps_the_sealed_generation`（`_tests.rs:1425-1449`）の形で、dirty のまま `RefusedUnchanged` にしてから Verify を回す | Verify が completed で、`semantic-graph-requires-repair` が出ない |
| T-5 | **K-2 の検証**（(b) の byte 互換と、全 project のやり直しが起きないこと） | (1) `current_maintenance_coordinates()` の値と 2 つの版の定数を、変更の前の master の値（試験の中で固定値として比べる）と比べる。(2) binding なし、current な binding、Chronicle の binding だけの 3 つの fixture で、`serde_json::to_value(report)` と `durable_graph_state_digest` の JSON を変更の前後で比べる。(3) 変更の前の build で sealed した clean な outcome を持つ DB を、変更の後の build で開き、main の discovery（`validate_discovered_verify_outcome`）、制御付き（`maintenance_runtime.rs:2588`）と制御なし（`:3254`）の skip 判定、Repair の seal（`repair.rs:760-800`）、C2Z の readiness（`c2z_preparation.rs:1425-1452`）に通す | (b)：(1) 3 つの digest と 2 つの版がすべて一致。(2) 3 つの fixture で byte 同一。(3) 5 つの読み手のどれでもやり直しも拒否も起きない。recognized not-current の形だけが digest の変化でやり直す。どれかが成り立たなければ、推奨を (a) に改めて版を改める。(a)：版だけが `"10"`。(3) の discovery と skip 判定は 1 回だけやり直しを返し、Repair の seal と C2Z の readiness は、やり直しが終わるまで古い outcome を拒む |
| T-6 | helper と reader の一致、coherent の条件 | 4 面の形を列挙する。dirty=0／1、Freshness が fresh／stale／別の epoch／行なし、今の epoch なし、D1 head の有無と `Corrupt`、producer の不一致、entry 0 件、metadata だけ、edge だけ、D1 の entry と V1 の tuple の不一致、`dirty=0` で Freshness の digest が不一致、`dirty=1` で Freshness の digest が不一致、eligibility の token の不一致、read set が非正規形。加えて、current と分類されて full validation が false になる形（source digest のずれ、edge と Source の不一致、Edge State が古い）。§3.1 の helper、`read_internal_bounded`、`is_complete_registered`、B の hint（`nir1_graph_index_maintenance.rs:267-400`）の結果を表にする | (1) helper が incoherent とする形と、reader が `Reserved` とする形が一致する。(2) helper が recognized not-current とする形では、`is_complete_registered` が（eligibility の読みが通る大きさで）false。(3) helper が recognized not-current とする形では、gate を開けた B の hint が build の wake を返す（Skip にならない）。(4) current と分類されて full validation が false になる形について、正当な書込みで dirty を立てずにその形になる経路があるかを記録し、あれば §5 の「残る止まり」に書く |
| T-7 | report の新しい欄と、outcome の検査、Repair の seal | 対象外の欄を持つ report で、`validate_canonical_verify_outcome_digest`、`validate_verify_check_coverage`、`validate_report_rebuild_required_with_control`、`validate_phase_success_outcome`（`maintenance_runtime.rs:826-942`）、Repair の seal（`repair.rs:760-800`）を通す。Repair の plan を作る | 5 つとも通る（通らなければ、欄の形か検査の改訂を本文に足す）。Repair の plan が、Graph の edge を duplicate のほかに含まない（GDV-R9） |
| T-8 | 製品の既定（Graph の binding なし）で挙動が変わらない。gate が閉じた DB の扱い | (1) binding の無い project（V0 の `v0_probe_nobind_candidates`）と、Chronicle の binding だけを持つ project で、Verify の report と digest を変更の前後で比べる。(2) gate を閉じた起動で、recognized not-current の Graph の binding を持つ DB（評価の DB の写しの形）を開き、wake を重ねる | (1) report と digest の値が同じ。(2) Verify は Graph を対象外にして completed、B は走らず、reader は Graph を unavailable とする。対象外が続くことを記録する（GDV-R1 の「期間に上限は無い」の確認） |
| T-9 | 既に止まっている project（開示の確認） | 変更の前の build で、(i) Verify が completed・non-clean（`semantic-graph-requires-repair`）の形と、(ii) Verify が容量で failed（`ManualIntervention`）の形を作り、変更の後の build で開いて wake を重ねる | 両方について、新しい Verify の Run が作られるか、止まったままかを記録する（どちらでも §5 の開示に結果を書く）。(i) は自動で戻る見込み |
| T-10 | 既存の試験と参照 | grimodex-db の Verify・maintenance・B・graph_index_dirty・V2 shadow（`restore_rebuild.rs:6875-6935`）の試験を全部走らせる。`git grep` で、dirty な semantic-index の consumer に unresolvable や manual を assert する試験と、evals・scripts が Verify の outcome を読む箇所を一覧する。`validate-native-writer-ownership.mjs`、`validate-semantic-core-boundary.mjs` を走らせる | 落ちる試験は、dirty な Graph の binding の扱いを assert するものだけ。その一覧を本文の受入れ（§8）に書く。2 つの検査器が通る |
| T-11 | **Rebuild-Derived の V2 shadow（S-5）**（レビュー 2 の M-1） | T-1 の形（候補 2,065 件、binding が dirty、B が `RefusedUnchanged`）で、Graph 以外の consumer に `rebuild_required = true` を立てる（Semantic Epoch を回す。`latest_completed_rebuild` を current でなくする。before-cutover の follow-up）。S-5 の有り無しの 2 通りで走らせる | S-5 ありでは、Rebuild-Derived が completed になり、shadow が Graph の eligibility を解決せず、連鎖が Idle に達する。S-5 なしでは、Rebuild の Run が容量の Err で終わることを確かめ、その後に Rebuild を繰り返すか terminal failure で止まるかを記録する（M-1 の 6 の未確認） |
| T-12 | incremental Freshness の V2 shadow | T-1 の形で、Scene の編集と、`ComponentSchemaGlobal`／`ProjectResetGlobal` の選択の範囲（`incremental_freshness.rs:2940-2943`）の 2 通りの incremental Freshness を回す。`git grep` で、incremental の経路から eligibility の Source を解決する呼出しが別 module に無いかを一覧する | eligibility の Source を解決しない。Err にならない。解決する経路があれば、S-6 として本文に足して版を改める |

- 不合格のときの扱い：
  - T-1、T-2、T-11、T-12 のどれかが通らない（eligibility を読む経路が別にある、など）。その経路を本文に足せるなら足して版を改める。足せない場合は、選択の段の記録のとおり、案 A に戻して改めて伺う。
  - T-1 の (0) か T-6 の (1) が通らない（動機の形が `Reserved` になる、または helper と reader が食い違う）。§3.1 の判定を改めて版を改める。直せなければ案 A に戻して伺う。
  - T-5 の (b) が通らない。K-2 の推奨を (a) に改め、全 project で Verify のやり直しが起きることを、最終確認の文の推奨の側に書く。
  - T-7 の Repair の plan が Graph の edge を含む。GDV-R9 を「gate を閉じたままにする」代案（§13）に改めて版を改める。
- この 4 つの不合格の扱いには、どれも当たらなかった（§10.2）。

### 10.2 結果（T ごと）

- 実行：`src-tauri/` で `CARGO_TARGET_DIR=/home/grimodex/cargo-targets/gdv1 cargo test -p grimodex-db --lib <filter> -- --nocapture --test-threads=1`。変更の前の build の写しは `/home/grimodex/cargo-targets/gdv1-baseline/`（`VACUUM INTO` の DB と、report・digest・5 つの読み手の結果の JSON）。
- 実装の要点：helper（§2.6）、S-1〜S-5、report の欄 `consumers_excluded_not_current`（`#[serde(default, skip_serializing_if = "Vec::is_empty")]`、`is_clean` には入れない）、K-2 (b)（版の定数は `"9"`・`"1"` のまま）、案 C（§7）。草案どおりに実装できなかった箇所は無い。注の書き直し 4 か所（K-2 (b) の拘束 1、GDV-R3 の 2 つ、GDV-R7）は `2a01e0cc` で行った。

| # | 結果 | 要点 | 本文への反映 |
|---|---|---|---|
| T-1 | 合格 | (0) 動機の形は `Registered{dirty:true, generation:1, head_version:1}`、helper は recognized not-current。(1)〜(5) 製品の経路の wake#0 は `Work(Verify)`（digest が変わったため）、以降 Idle。Verify は completed・clean、対象外の欄に Graph（edgeCount 4）、unresolvable と missing は空。Finding 0。Run は 5 → 6。seam の wake は `GraphIndexBuildWake` が続き、B は Run を作らない。binding は dirty のまま残る。対照（binding なし）は 4 回とも Idle。保存 edge 8,194 行の形は今のまま止まる | §0、§2.6、§3.2、§5、§8 |
| T-2 | 合格（(4) は読み） | 制御なしで dirty の binding の digest が Ok。候補を足しても不変、metadata・Freshness を変えると変わる。印は今の status と重ならない（読み、単体試験なし）。current な binding の制御なしの digest は前後とも `context-unavailable`（Chronicle も同じ） | §3.2、§5「残る止まり」、§8【新規】 |
| T-3 | 合格 | 案 C の有り無しのどちらでも止まらない。案 C ありで B が先に立つ。RebuildDerived の形で案 C は build の起動を 1 → 3 回、publish を 1 回増やした（generation 3） | §2.6、§5、§7、§11 |
| T-4 | 合格 | 期限の拒否で dirty のまま残っても、wake#0 で Verify、以降 Idle。`semantic-graph-requires-repair` は出ない | §2.3 |
| T-5 | 合格 | 座標の 3 つの digest と 2 つの版が同一。3 つの fixture で report と digest が byte 同一。5 つの読み手の結果が前後で同一（binding なし・current な binding。制御付きの skip は `ForegroundValidationControl` で代用）。Chronicle の fixture は写しの outcome が `GraphContractMismatch` で、clean な outcome の確認はできなかった。not-current の形では digest が変わってやり直し。**(b) の推奨は変えない** | §3.2、§3.3、§5、§8 |
| T-6 | 合格。(3) に 1 件の不一致、(4) に 2 件の記録 | (1) 19 形で helper の incoherent と reader の `Reserved` が一致。(2) not-current の 5 形で `is_complete_registered` は全部 false。(3) 今の epoch なしだけ B の hint が `Skip{NoEpoch}`。(4) Edge State が stale／別 epoch は current と分類され、B の hint は `Skip{BindingCurrent}`。正当な書込みの経路は見つからない（読み）。作っていない形：D1 head の `Corrupt`、edge と Source の不一致 | §2.6、§3.1、§5（GDV-R1・R4、残る止まり）、§6.1、§8 |
| T-7 | 合格 | 対象外の欄のある outcome が 5 つの検査を通る。Repair の plan は edge 0 件。Graph の edge の複製は UNIQUE で拒まれる。GDV-R9 の代案に改める必要は無い | §5 GDV-R9、§6.1 |
| T-8 | 合格 | (1) binding なしと Chronicle だけで byte 同一。(2) gate を閉じて not-current の DB を開くと、wake#0 で Verify（対象外あり）、以降 Idle。B は走らず、reader は Graph を unavailable とし、対象外が続く。変更の前の build では毎回 `context-unavailable` | §5 GDV-R1、§6.1 |
| T-9 | 記録 | (i) completed・non-clean の形（Finding 0）は、変更の後の build で自動で戻る。(ii) 容量で failed の形（Finding 1）は、discovery が `Work(Verify)` を返しても新しい Run が作られず、**自動では戻らない**。Finding がある (i) の形は作れなかった | §2.3、§5、§8、§11 |
| T-10 | 一部未実施。既存の試験 3 件が落ちる | モジュール別の run は、`nir1_graph_index_maintenance` の 1 件を除いて通る。全件の run（`4677649d`）は 2772 passed・3 failed・65 ignored で、落ちたのは dirty な Graph の旧い扱いを assert する 3 件だけ。`validate-native-writer-ownership.mjs` は通った | §2.2（DR-BSEAM-1 (b)）、§5 GDV-R3、§8、§9 |
| T-11 | 合格（4 形のうち 2 形） | S-5 なしでは Rebuild が容量の Err で failed になり、繰り返さず止まる（Idle に達しない）。S-5 ありでは、Edge State を 1 行消す形と Semantic Epoch を回す形の両方で、Rebuild が completed、製品の経路で Idle、Err 0・Finding 0。S-6 の候補は出なかった | §2.2、§3.2、§8 |
| T-12 | 合格（probe で代替） | 3 つの選択の範囲で incremental の V2 shadow を直接呼び、Err にならない。`incremental_freshness.rs` に Source の解決の呼出しは無い。S-6 は要らない | §4、§8 |

### 10.3 試作で実施しなかった項目と、その扱い

| 項目 | 扱い | 理由 |
|---|---|---|
| T-10：clippy（`--features nir1-material-diagnostics` を含む） | §8 に回す。**改訂 6**：試作 r5 で CI の形と Native の形は exit 0。feature 付きは、GDV/1 が変えない 3 file の既存の指摘で exit 101。§8 で基点と比べる | 静的な検査で、契約の読み（§3）を変えない。実装の head で取るのが正しい |
| T-10：`validate-semantic-core-boundary.mjs` | §8 に回す（試作 r5 でも未実施） | worktree に `node_modules` が無かった。policy の file は変えない（§4）ので、落ちれば実装の置き場所の問題で、契約の文とは食い違わない見込み【推測】。食い違えば §1.3 の 5 |
| T-10：注の書き直しと `gdv1_t11b` の後の全件の run | **改訂 6：試作 r5 で実施**（`ec550a58`。落ちたのは書き換える 3 件だけ）。書き換えた後の全件は §8 | 最後の全件は `4677649d`。その後はコメントと dev の試験の追加だけ |
| T-11：`latest_completed_rebuild` を current でなくする形、before-cutover の follow-up | **改訂 6：試作 r5 で実施**（合格。§10.4）。seam ありの形は §8 に回す | S-5 は `rebuild_required` が立った理由によらず、同じ V2 shadow の head の loop で効く読み【推測】。試作の 2 形が同じ経路を通った。before-cutover は案 C の reason の扱い（§7）とあわせて確かめる |
| T-12：実際の Scene の編集の cycle | §8 に回す（試作 r5 でも probe のまま） | `incremental_freshness.rs` に Source の解決の呼出しが無いことは `git grep` で確かめた。cycle を通す形は製品の試験で足す |
| T-5：Chronicle の binding だけで、今の契約の clean な outcome を持つ fixture | §8 に回す（試作 r5 でも未実施） | byte 同一は確かめた。読み手の結果は、Chronicle を変えない（§4）ので変わらない見込み【推測】 |
| T-5：制御付きの skip 判定を cycle の制御で | §8 に回す（試作 r5 でも代用のまま） | 代用の `ForegroundValidationControl` で結果は同一だった |
| T-6：D1 head の `Corrupt`、edge と Source の不一致、eligibility の今の Source との source digest のずれ | §8 に回す（試作 r5 でも作っていない） | 1 段目・full validation の今のコードの経路で決まり、GDV/1 の helper の分類はこれらで current か incoherent になる読み【推測】 |
| T-6 (3)：今の epoch が無い形が正当な書込みで起きるか、Backfill の後に B が直すか | **改訂 6：試作 r5 で一部実施**。epoch なしの 2 形は「今のまま」、epoch を作った後は B の hint が `Build{Rebuild, BindingDirty}`（`create_epoch_in_tx` で代用）。Backfill の実際の run は §8 に回す | 開示（GDV-R1・R4）は試作の事実で書いた。起きる経路があれば記録する。**改訂 5**：この形は今のまま full validation に渡すことにし、開示を削った（§3.1）。§8 では、判定の順（epoch を先に見る）と、Backfill の後の B の hint を確かめる |
| （改訂 5）判定の順（epoch を dirty より先に見る）と、下流の gate の (x) の検査 | **改訂 6：試作 r5 で実施**（合格。§10.4）。前後の build の比較が要る行は §8 に回す | レビュー 3 の後に本文で決めた。試作の helper は dirty を先に見て、gate は開いていた（(y)）。T-1・T-11 を (x) の head で取り直す |
| T-2 (4)：印の単体試験 | **改訂 6：試作 r5 で実施**（合格） | 読みでは重ならない |
| T-9 (i)：`semantic-graph-requires-repair` の Finding がある形 | §8 に回す。**改訂 6**：試作 r5 でも、dev の経路ではどの形でも作れなかった。§8 では SQL か直接の projection で作る | Finding の解消は今のコードの経路（GDV/1 は変えない）。dev では Finding を作れなかった |
| （改訂 6）current で封じた report の後で not-current になる形、foreground の Verify の完了、apply の re-seal | §8 に回す | レビュー 4 の R-1・m-4・m-1 で本文に足した。試作 r5 は実施していない |
| K-2 (a) の挙動（版の不一致でのやり直し、failed の形） | (a) が選ばれた場合だけ §8 に回す | (b) を推奨し、(a) は試作していないことを §3.3・§11 に書いた |
| 時間の費用（helper の読み、案 C の判定、余分な build） | ここで足りると判断（計測しない） | 読みの上限は保存の上限の内（§6.2）。製品の既定（binding なし・gate 閉）では増えるのは helper の 1 段目の数回の読みだけ。seam の下の差は CP-4 の run の外の dev の journey で見る（Q2b） |

### 10.4 試作 r5 の結果（改訂 6 で足した）

- 実行：`src-tauri/` で `CARGO_TARGET_DIR=/home/grimodex/cargo-targets/gdv1 CARGO_BUILD_JOBS=4 cargo test -p grimodex-db --lib <filter> -- --nocapture --test-threads=1`。試験の置き場所は `nir1_graph_index_maintenance_tests.rs` の末尾（`gdv1r5_*` が新規、`gdv1_t6`・`gdv1_t7` は書き換え）と、`restore_rebuild.rs` の末尾。
- 実装した 3 点（草案どおりに実装できなかった箇所は無い）：判定の順（epoch を先に見る。無ければ `NoCurrentEpoch`）、(x) の検査（`repair.rs`、`c2z_preparation.rs`）、案 C の before-cutover の拘束（`maintenance_runtime.rs`）。
- marker が無い形は、共通の fixture の最後で marker の行を消して作った近似（冒頭の記法の注）。
- 「assert」は試験が値を assert したもの、「記録」は出力の記録だけのもの。

| # | 結果 | 要点 | 本文への反映 |
|---|---|---|---|
| T-1 | 合格（assert と記録） | marker あり・なしの両方で、binding は `Registered{dirty:true}`、helper は recognized not-current（assert）。製品の経路の wake#0 は `Work(Verify)`、wake#1 以降は Idle、Run 5 → 6、Finding 0、Err 0。marker なしの形でも Graph は publish された（edge は eligibility の 1 本）。cutover の loop（8 round、記録）：not-current・marker なしでは、round#0 に `[verify, rebuild, verify]`、round#1 から before-cutover の discovery が `None`、cutover は毎回 NOT_READY（理由は `verify:verify-graph-recognized-unavailable` だけ）、Run 5 → 8、marker は書かれない。current な Graph・marker なしでは、before-cutover の wake が毎回 `context-unavailable` の Err。(y) に戻した対照では round#1 で cutover が成功し、marker が書かれた。marker ありでは cutover は marker を見て早く返る | §0、§3.2、§5（GDV-R9 の位置づけ、残る止まり）、§6.1、§8、§9、§11、§13 |
| T-2 | 合格（(4) は assert） | 印は `durable_resolved_source_value` の 4 つの status と `unsupported` のどれとも重ならない。(1)〜(3)・(5) は取り直しで合格 | §3.2、§8 |
| T-3 | 合格（拘束は assert と記録、generation は記録） | §7 の表。RebuildDerived を渡す形で、案 C ありは全部の wake の後も generation 3（なしは 2）、起動 3 回（なしは 1 回）。Verify を渡す形は差なし。拘束は陽性対照と対で一致。`before-cutover-follow-up` は request の preflight が拒む。reasons が混ざった RebuildDerived の item では、cycle の最後の rediscovery が B を起動する | §0、§2.6、§5、§7、§8、§9、§11 |
| T-4 | 合格（assert） | 期限の拒否で dirty のまま `rebuild_required` を立てた形：wake#0 の cycle は `[verify, rebuild, verify]`、以降 Idle、Rebuild は completed、Err 0、Finding 0 | §8 |
| T-6 | 合格（assert） | 21 形すべてに適用。helper の incoherent と reader の `Reserved` は一致。not-current の形はどれも B の hint が `Build`。今の epoch なしの 2 形は `NoCurrentEpoch`・`Ok(false)`・`Skip{NoEpoch}`。epoch を作った後は `Build{Rebuild, BindingDirty}`（草案の見込み `Build{NotCurrent}` と違う） | §2.6、§3.1、§5 GDV-R4、§8 |
| T-7 | 合格（assert） | not-current：Repair の seal は `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`、C2Z の Verify の gate は `Blocked / ["verify-graph-recognized-unavailable"]`。current：seal は `NEX_VALIDATION_TERMINATED:context-unavailable`、gate は `verify-graph-state-invalid: …context-unavailable`。欄が空（binding なし）は seal `Ok`、gate `Passed`。欄が空の report の読み手の結果は baseline と同じ | §0、§3.2、§5 GDV-R9、§6.1、§8 |
| T-8・T-9・T-12 | 取り直しで合格 | 前の試作と同じ結果。T-9 (ii) の容量で failed の形は、今も自動では戻らない | （変更なし） |
| T-11 | 合格（assert と記録） | 前の 2 形は取り直しで合格。新規 2 形（`latest_completed_rebuild` が current でない、completed な Rebuild の outcome が current でない）は marker の有無の両方で合格。S-5 の要約は、Graph の head が無い DB と diagnostics の 1 行を除いて同じ（assert。同じ build の中の比較） | §8 |
| Verify の形と Finding | 記録 | current と分類される形 2 つと incoherent の形 4 つで、Verify は completed、Graph の edge は unresolvable に入った。`semantic-graph-requires-repair` の Finding は、どの形でも dev の経路では作れなかった（制御なしの digest の `context-unavailable` が先に返る） | §2.3、§4、§5、§6.1、§8 |
| 全件・clippy・検査器 | 記録 | 全件 2,852 件で 2,783 passed・3 failed（書き換える 3 件）・66 ignored。clippy は CI の形と Native の形が exit 0、`nir1-material-diagnostics` 付きは GDV/1 が変えない 3 file の既存の指摘で exit 101。`validate-native-writer-ownership.mjs` は ok。`validate-semantic-core-boundary.mjs` は未実施 | §2.6、§8 |

- 試作 r5 が実施しなかった項目は、§10.3 の「扱い」の列と §8 の【新規】のとおり。

## 11. 最終確認の質問文の案（AskUserQuestion、1 問）

- **問い**：GDV/1（draftRef `nir1-graph-dirty-binding-verify-proposal/1`、contractId `graph-limited-binding`、改訂 6。この版の SHA-256（確認のときに統合者が埋める））を、この版のとおりに承認しますか。K-2（依存検証の契約の版を上げるか）は、選択肢で選んでください。
- **説明**（質問の文に書く）：
  - **何の改訂か**：Graph を持つ project で、作り直しが断られて Graph が「作り直し待ち」のまま残っても、依存検証とその先の再構築が止まらないようにします。
    - 依存検証と再構築は、作り直し待ちの Graph を「再構築できるが使えない」（consumer contract の既存の文）として扱います。検査の対象から外し、Graph の全体の Source も読みません。
    - 作り直し待ちかどうかは、Graph を読む側と同じ構造の検査で決めます。
    - Graph は消さず、作り直されるまで今と同じく使われません（関連場面は R+IR で出ます）。
  - **緩和（9 つ）**：
    - GDV-R1：作り直し待ちの間、依存検証が Graph を検査しない。期間に上限はありません（作り直しが走らない起動や、入力が大きすぎる間は続きます）。今の Semantic Epoch が無い形は、作り直し待ちとは読まず、今のまま検査に渡します。
    - GDV-R2：容量の超過が Finding として残らない。
    - GDV-R3：依存検証の結果の意味と、B の設計の前提が変わる。作り直し待ちの Graph では、main の起こし方（DR-BSEAM-1 (b)）の前提「制御なしの判定は失敗する」が成り立たなくなり、B の判定は cycle の中（案 C を採ればその先頭、採らなければ最後）に移ります。どちらでも止まらないことは試作で確かめました。
    - GDV-R4：作り直し待ちかどうかを、全体の Source を読まずに決める。作り直し待ちと読む形は、どれも作り直し（B）の対象になる形です（試作 r5 の 21 形で確認）。ただし、入力が大きすぎれば作り直しは断られ、待ちが続きます（GDV-R1）。
    - GDV-R5：依存検証の再利用の判定が、その間の Graph の Source の変化を見ない。
    - GDV-R6：確認済みの句の「Source の再解決」と「登録の全件の検証」を、結果が決まっている Graph では始めない。
    - GDV-R7：footprint の検査で、作り直し待ちの Graph を宣言済みに数える。
    - GDV-R8：再構築の付随の観測（保存されない）から、作り直し待ちの Graph を外す。
    - GDV-R9：作り直し待ちの Graph がある project でも、依存検証が clean になりうるので、その結果の再利用の記録（自動の保守の経路と、foreground の依存検証の完了の経路）と、Finding の解消が通るようになる。
    - 改訂 4〜6 で緩和の数は増えていません（9 つのまま。改訂 6 は、GDV-R9 の「再利用の記録」の位置に foreground の依存検証の完了を名指ししただけです）。
  - **(x) で閉じたままにするもの**（GDV-R9 の外。作り直し待ちの Graph がある間）：
    - 手動の Repair の確定（確定と、適用の中の再確定）。
    - C2-ZC の切り替えの準備の判定（C2Z の readiness）と、その先の不可逆な切り替え（cutover）。
    - 使われている（current な）Graph でも、これらは今閉じています（理由は別の失敗）。両方の状態で閉じる形にそろえます。
    - 試作 r5 で、閉じない形（(y)）では、切り替えの前の DB（marker の行を消した近似の形）で切り替えが実際に進むことが分かりました。(x) では進みません。そのような DB でも、自動の保守は止まらず Idle に達し、止まるのは切り替えだけです。
  - **足す code・reason**（改訂 6 で名前を決めました）：
    - Repair の拒否の code `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`。
    - C2Z の readiness の reason `verify-graph-recognized-unavailable`。切り替えの `NEX_C2ZC_CUTOVER_NOT_READY` の message にも出ます。
    - ほかに、本文に既にある report の欄 `consumersExcludedNotCurrent`、digest の印 `recognized-unavailable`、保存されない観測の code `NEX_V2_SHADOW_REBUILD_RECOGNIZED_UNAVAILABLE`。
    - `policies/`・`src/`・`electron/`・`scripts/` には、Repair と C2Z の拒否の code・reason を列挙する所がありません（`f806138e` で既存の code・reason を grep した範囲）。
  - **変えないもの**：データの書込み、書き手、D1、generation、「成功したときだけ Graph を差し替える」の句、B-close の数値と句、policy の file、閾値、Gold、評価の手順、画面。新しい保存先・送信先は足しません。Graph を読む側の理由の集合と画面の文言も変えません（足すのは上の名前だけです）。
  - **K-2 の 2 案**：
    - (b) 上げない（推奨）。新しい規則で結果が変わる project では、完了済みの証跡の照合が必ず外れるので、古い結果が新しい規則のもとで使われることはありません。全 project での依存検証のやり直しは起きません。そのかわり、他の project の結果を byte で同じに保つことを、実装の拘束にします。この byte 互換は試作で確かめました。
    - (a) 上げる。全利用者の全 project で、依存検証が 1 回やり直しになります。進行中の依存検証の結果からは、やり直しまで Repair を確定できません。かわりに byte 互換の拘束は要らず、版の番号で新旧の意味を分けられます。(a) は試作していません（挙動はコードの読みです）。
  - **私が決めた点**：
    - K-1：対象外にする（待たせない）。
    - K-3：判定は canonical な値だけを使う。
    - K-4：判定は内側の関数に置き、全部の呼出し元に効かせる。例外として、GDV-R9 で閉じる 2 か所（Repair の確定、C2Z の readiness）は、保存された結果の欄を読むだけの検査を外側に置きます。
    - 案 C：B の判定を、main から渡された作業より先に通す。委任の内の判断として DR に記録します（選択肢には入れません）。
      - **費用**（試作の形。DR が選びうる中で最大）：評価の起動（seam の下）で main が再構築の作業を渡す形では、Graph の作り直しの publish が、全部の wake の後も 1 回多く残りました（作り直しの起動は 3 回対 1 回）。依存検証の作業を渡す形では差がありませんでした。1 つの試験の形・6 回の wake の観測で、原因は特定していません。製品の既定（作り直しの経路が閉じている）では当たりません。
      - DR では、試作の形のまま費用を開示する、依存検証の作業の前だけに狭める、やめる、の 3 つから選びます。私の推奨は「狭める」です（費用が出た形を外し、B を依存検証より先に置く順は残せる見込み。狭めた形は試作していないので、実装の PR で数を確かめます）。案 C をやめても止まりません。
      - C2-ZC の切り替えの前の流れ（before-cutover）の作業では、案 C は B を判定しません（既に記録された不変条件で、DR の選択肢にしません。試作 r5 で確認）。
  - **残る止まり**：
    - 使われている（current な）Graph の検証が容量で落ちる場合。判定の読みが足されるので、上限の近くでは今より少し早く落ちることがあります。
    - 構造は揃っていても current な Graph の Source がずれている形。Graph の edge の状態（Edge State）が古いか別の epoch の形も、ここに入り、B も直しません。正当な書込みでこの形になる経路は、読みでは見つかっていません。
    - 保存の超過（破損の印）。
    - 作り直し待ちの Graph がある間は、上の (x) のとおり、手動の Repair を確定できず、C2Z の readiness も通らず、切り替えの前の DB では切り替えも進みません。
    - **容量で failed は自動では戻りません**：この改訂の前に依存検証が容量で failed になって止まった project は、この改訂の後も、**同じ Semantic Epoch の間は自動では戻りません**（試作で確認。仕組みはコードで確認）。人の手の扱いが要ります。対象は、評価や開発で作り直しの経路を開けた起動で作った DB と、その写し・restore だけです（その写しを製品の build で開いても残ります）。製品の build で作った DB には当たらない見込みです。依存検証が completed・non-clean で止まった形は、自動で戻りました。
  - **試作で確かめたこと**（dev 枝、push なし、判定外。改訂 6 は 2 回目の試作 r5 の結果を含みます）：
    - 動機の形（候補 2,065 件、作り直しが断られた Graph）は作り直し待ちと読まれ、依存検証は Graph を対象外にして completed になり、止まらず Idle に達しました。Finding は出ません。改訂 5 の 3 点を入れた形で、切り替えの済んだ DB と、切り替えの前の DB の両方で確かめました。
    - その先の再構築も止まりません（再構築の 4 形。S-5 が無いと実際に容量で落ちることも確かめました）。
    - (x) は、Repair の確定と C2Z の readiness を、上の code・reason で拒みました。
    - K-2 (b) の byte 互換（座標、report、digest）が成り立ち、5 つの読み手の結果も前後で同じでした。ただし、使われている（current な）Graph の project では、5 つのうち 4 つが前後とも同じ失敗で、中身のある結果どうしの一致は 1 つだけです。
    - 既存の試験のうち、作り直し待ちの Graph の旧い扱いを確かめる 3 件だけが落ちます。実装の PR で書き換えます。
  - **試作で確かめていないこと**（実装の PR の受入れで確かめ、本文と食い違えば実装を止めて改めて伺います）：
    - 境界の検査器 1 つ、Scene の編集の実際の cycle、K-2 (a)、ほか（§10.3）。
    - 狭めた案 C の数。
    - `semantic-graph-requires-repair` の Finding の解消。dev の経路ではこの Finding をどの形でも作れなかったので、試験では直接作ります。
    - 使われている間に確定した依存検証の結果が、作り直し待ちに変わった後に使われないこと（digest の印で閉じる読み）。
  - **時期**：実装は次の S4（9 回目）の PR の merge の後（#923 がその PR に当たり、条件が満たされたかの確認の結果。確認のときに統合者が埋める）。9 回目の正式 run は GDV/1 なしで測り、候補の差は PUB-G #15 で扱います。
  - これは製品の公開・PUB-G の承認ではありません。
- **選択肢**：
  - 「承認する（K-2 は (b)）」（推奨。版を上げない。全 project での依存検証のやり直しを避けられ、byte 互換も試作で確かめたため）
  - 「承認する（K-2 は (a)）」（版を上げる。版の番号で新旧を分け、byte 互換の拘束を避ける。全 project で依存検証が 1 回やり直しになる。(a) は試作していない）
  - 「承認しない」（#5 は (i) 開示のまま。PUB-G の開示の文案に止まり方を載せる。別の案は新しい draftRef で起案する）
- 3 つの選択肢のどれでも、確認の対象の bytes は同じ（両案を本文に書いてある）。選ばれた K-2 の案は確認の記録に書く。
- 改訂 5：GDV-R9 は (x)（閉じたまま）の 1 案だけを本文に書いた。(x) でも動機の形の止まりが解ける読みなので、(x)／(y) を選択肢に足さない。3 択（K-2 の (b) で承認／(a) で承認／承認しない）のまま。(y)（開く形）を求める場合は「承認しない」を選び、新しい版で伺う。
- 改訂 6：(x) で止まりが解けることは試作 r5 で確かめた。案 C の範囲は DR（委任の内）で決めるので、選択肢に足さない。3 択のまま。

## 12. 確認後の記録（この draft の外。台帳への取り込みの提案）

- 補足「2026-11-xx補足（GDV/1）」に書くこと：
  - 経緯（V0、#5 の Q1 の回答 `ed90f78b`、Opus レビュー 1、選択の段 `b8a9ea86`、Opus レビュー 2、改訂 3、dev 試作（`claude/gdv1-dev` `2a01e0cc`、push なし）、改訂 4、Opus レビュー 3、改訂 5、試作 r5（同じ枝 `ec550a58`、push なし）、Opus レビュー 4、改訂 6、最終確認）。
  - 案 C の DR で選んだ形（C-1〜C-3）と、その数の受入れ（§7、§8）。
  - dev 試作で分かった開示の変更（§0 の「開示が変わる点」）と、§8 に回した項目（§10.3）。
  - 確認の記録と、選ばれた K-2 の案。
  - byte 同一の取り込みと SHA-256 の一致。
  - 緩和 GDV-R1〜R9 の名指し。
  - 「この確認は PUB-G・Graph の公開・新しい authority・保存先・送信先を許可しない。policy の file を変えない。Verify の契約の座標は、選ばれた K-2 の案のとおり（(b) なら変えない、(a) なら `VERIFY_CONTRACT_VERSION` だけを `"10"` に上げる）」。
- 行 `GDV/1-1`：`nir1-graph-dirty-binding-verify-proposal/1#graph-limited-binding`（GDV/1。/7 と同じ contractId の新しい family。dirty な declared Graph binding を、Verify と Rebuild の観測が recognized unavailable として扱う）。取り込んだ draft は `nir1-graph-dirty-binding-verify-proposal-1-draft.md`、SHA-256 は確認された版の値。
- 契約の一覧表に `graph-limited-binding` の行を 1 行足す。
- 確認されなければ、#5 は (i)（開示）のままで、PUB-G の開示の文案に止まり方を載せる（DR-PUBG-5-12）。案 C は、確認の結果によらず DR として残す（時期は同じ）。

## 13. 選ばれなかった案（短く）

- **(iii)**：容量の拒否で binding を退かせる（4 面を消す）。
  - 期限の拒否まで覆える。
  - その代わり、失敗の経路での削除、D1 の head の削除、B-close と l6-l9 の句の読み替え、writer と宣言の変更、使われている binding の喪失（cold reopen）が要る。緩和は最大 14。
  - 選択の段で選ばれなかった。
- **案 A**：(iii) を、入力の大きさの拒否と dirty／not current の binding に狭めたもの。
  - 緩和は 12。期限の拒否では止まりが残る。
  - 選ばれなかったが、§10 の T-1・T-2・T-11・T-12 が通らず GDV/1 が成り立たないときの戻り先（選択の段の記録のとおり）。試作でこの 4 つは通ったので、戻る材料は出なかった。
- **判定を PK・EXISTS だけの安い読みにする形**（改訂 2）：incoherent を recognized と誤認するので取り下げた（レビュー 2 の M-3）。
- **GDV-R9 の (y)（下流の gate を開く形。改訂 4 の形）**：改訂 5 では選ばない。改訂 4 では「Repair の gate を閉じたままにする代案」をこの節に置いていたが、改訂 5 でそちら（(x)）を本文にした（§5 の GDV-R9 の位置づけ。レビュー 3 の M-2）。
  - (y) は、作り直し待ちの Graph の project でだけ Repair の seal、C2Z の readiness、C2-ZC の不可逆な cutover の Verify の証跡の検査が通る形で、開く条件が健全さと逆になる（current な Graph では閉じたまま）。
  - 改訂 4 が (y) を選んだ根拠（参考）：Repair は破壊的な writer（duplicate の edge を hard DELETE し、その SQL は consumer の種類で絞らない【レビュー 2：`restore_rebuild.rs:5800-5815` 付近】）だが、自動の経路ではない（`maintenance_runtime.rs:2581-2584` の注）。Repair が対象にする edge は report の一覧から作られ、対象外の Graph の edge は載らない。duplicate は UNIQUE index で起きない想定【レビュー 2】。試作で、Repair の seal を開いた形では plan は `change_count = 0`・edge 0 件で、Graph の edge の複製の INSERT は UNIQUE 制約で拒まれた【試作 T-7】。この根拠は Repair だけのもので、cutover を覆わなかった。
  - cutover の前の DB に Graph の binding が在りうるかを、コードで確かめられなかった（§5）。改訂 6：試作 r5 で、在りうること（gate を開けた起動で publish される）と、(y) では not-current の形で cutover が実際に成功し marker が書かれることが分かった【試作 r5 T-1】。
  - (y) に戻すなら、非対称と、cutover の前の DB で不可逆な cutover に届くこと（試作 r5 で観測）を §5 と §11 に名指しし、新しい版で伺う。
- **今の epoch が無い形を recognized not-current に置く形**（改訂 4 の形）：改訂 5 では選ばない（§3.1。レビュー 3 の M-1）。consumer contract の「rebuildable」に当たらない形を対象外にし、緩和と開示を増やすだけで、動機の形には要らない。
- **今の epoch が無い形を incoherent に置く形**：reader の `Reserved` との一致（T-6 (1)）が崩れるので選ばない。
- **Edge State の古さを 2 段目に入れる形**：B が直さない（`Skip{BindingCurrent}`）形を期限なしに対象外にするので選ばない（§3.1）。
- **GDV/1 の中で、容量で failed になった Verify を自動で回復させる形**（改訂 4）：terminal failure の lifecycle を変えるので、この改訂の範囲の外。選ばない（§5）。
- **対象外の集計を outcome 直下に置く形**：K-2 (b) の拘束 1 で、report の中に置く形を選んだ（§3.3）。
- 詳しい比較は、改訂 1（`05-iii-contract-draft.r1.md` の §3）にある。この版の bytes には残さない。

## 14. Opus レビュー 1 の指摘のうち、この版に当たるもの

- **M-1（順序）**：§2.4 と案 C（§7）、試作 T-3。
- **M-2（cold reopen）**：消さないので当たらない。current な binding は今のまま full validation で扱う（§3.1）。
- **M-3（producer の座標）**：registry を変えない（§4）。座標全体の扱いは K-2 と T-5。
- **M-4・M-5（確認済みの句、D1）**：l6-l9:506 などと B-close の句は変えず、D1 も変えない。確認済みの句に関わるのは GDV-R6 だけで、名指した。
- **M-6（試験）**：T-10 で一覧を作り、§8 に書く。
- **M-7（問いの束ね）**：選択の段で、案・時期・確認の要否を別々に伺った（`b8a9ea86`）。最終確認は 1 問（K-2 は選択肢）。
- **推奨 R-8（理由が `stale` から始まる）、R-12（評価の書き方）、R-13（案の比較）**：§9、§13 に入れた。
- **R-1〜R-7・R-9〜R-11**：(iii)・案 A の書込みと writer に関わるもので、この版には当たらない（書込みが無い）。

## 15. Opus レビュー 2 の指摘への対応

### 必須

- **M-1（Rebuild-Derived の V2 shadow）**：直した。
  - S-5 を足した（§2.2 の表、§3.2）。緩和 GDV-R8（§5）。
  - §2.2 の「4 か所」の言い切りを、「読んで分かった箇所、網羅は主張しない」に改めた。
  - 試作に T-11 を足した。M-1 の 1〜5 と、6 の未確認（繰り返すか terminal か）の記録。T-1 は Idle までを合格の条件にした。
  - §8 Positive に「`rebuild_required = true` のときも Rebuild-Derived が完了する」を足した。
  - Chronicle の head は対象外と一行書いた（§3.2）。
  - レビュー 2 の未確認（incremental Freshness の V2 shadow）は T-12 にした。
  - V2 shadow の要約が永続しないこと（`#[serde(skip)]`、`restore_rebuild.rs:1150-1154`）を、起案者が読んで【事実】にした。
- **M-2（K-2 の根拠）**：直した。2 案を本文に完全に書き、(b) を推奨した。
  - 書き換えた節：§2.5（再利用の (a)〜(d)、座標が `current_maintenance_coordinates` だけでないこと、版の規則）、§3.3 K-2（両案の拘束と開示、推奨の理由、(a) の利点）、§3.2 S-4（identity の追加を取り消し、`resolvedSource` だけを置き換え、top-level の key を足さない）、§4、§5（digest の値が変わる project）、§8（両案の座標と byte 互換、5 つの読み手）、§9、T-5、§11（K-2 を選択肢にした）、§12。
  - 推奨の理由：版の規則の条件（古い report から Repair を seal するのが危うくなる）に当たらず、新しい規則で結果が変わる project では CAS が必ず外れるので、全 project の再実行を払う理由がない。
  - S-4 の digest の扱いは、両案で同じ文にした。
  - report の欄は、report の中に `#[serde(default, skip_serializing_if = "Vec::is_empty")]` で置く（outcome 直下の形は §13）。
- **M-3（判定の読み）**：直した。
  - §3.1 を、reader の構造の読み `read_internal(…, true, true, …)` と、Freshness・epoch・dirty の 2 段目で書き直した。「PK・EXISTS・件数の読みだけ」を消した。
  - §6.2 の費用を直した（D1 と V1 の全件の読み、dependency digest、current な binding での二重）。§6.1 の受入れの読みも直した。
  - T-6 の列挙に、レビュー 2 の 5 形と R-6 の 3 形を足した。合格の条件に、B の hint が wake を返すことを足した。
  - 動機の形（V0 の (b)）が `Registered{dirty:true}` になる前提を、T-1 の (0) と §0 に明記した（`dirty=1` でも Freshness の digest の一致が要るため。`:2497`）。

### 推奨

- **R-1（Repair の seal の gate）**：採る。GDV-R9 として §5 に名指しした。C2Z の readiness、skip の証跡の seal、Finding の解消も同じ行に入れた。
  - `verify_coverage.rs:427-428` の注の反転は GDV-R7 に書いた。
  - threat model に A4 を足した。T-7 に Repair の plan の確認を足した。
  - gate を閉じる代案は §13 に置いた。
- **R-2（GDV-R6 の名前と説明）**：採る。
  - 名前を「Source の再解決と完全登録の検証を、結果の決まった binding では始めない」にした。
  - :513 と :514 の両方を入れ、GDV-R1 との重なりと、:495 の coerce の句に触れないこと（§4）を書いた。
- **R-3（既に止まっている project）**：採る。§5 の開示を 2 つの形に分け、T-9 で両方を確かめる。
- **R-4（期間の上限）**：採る。GDV-R1、§6.1 A1、§11 に「期間に上限は無い」を書き、T-8 に gate が閉じた DB の形を足した。
- **R-5（制御なしの呼出し元）**：採る。§6.2 に制御なしの経路を挙げ、「制御付きでも制御なしでも、判定は eligibility を読まない」と書いた。current な binding の既存の `ContextUnavailable` の可能性は、§5 の「残る止まり」と T-2 の (5) に入れた。
- **R-6（current と分類されて完全な登録でない形）**：採る。§3.1、§5 の「残る止まり」、T-6 の (4) に入れた。
- **R-7（置き場所）**：採る。§3.3 に K-4 として書いた。
- **R-8（試作の不足）**：採る。
  - T-7 に `validate_phase_success_outcome` と Repair の seal を足した。
  - T-3 に RebuildDerived の Work の形を足した。
  - T-10 に V2 shadow の試験と 2 つの検査器を足した。
- 採らなかった推奨は無い。

### 軽微

- §2.3 の `context-unavailable` の観測：V0 の条件での観測だと書き、`GraphIndexBuildWake` に変わる条件を添えた（§2.3）。
- §2.4 の `:3045-3058`：起案者が読み直し、【事実】に上げた。
- S-3 の範囲を `verify_coverage.rs:442-562` に直した。S-4 には、identity の面（`:2690-2736`、`:3127-3203`）がすでに入っていることを書いた（§2.2）。
- §2.5 の「6 つの値」：証跡の field の数と、再利用の (a)〜(d) を書いた。
- §6.1 の受入れの「4 回の COUNT」：S-3 が今も行っている読みで、増えるのは helper の読みだけ、と直した。
- K-1 の「report は Graph 以外の consumer で決まる」：「S-1〜S-3 の検査では」に狭め、duplicate と malformed が Graph の edge も見ることを書いた（§3.2、§3.3）。
- GDV-R3 で書き直す注に、`maintenance_runtime.rs:2349-2356` の doc を足した（§2.2、§5）。

## 16. dev 試作の反映（改訂 4）

入力：`05-gdv1-dev-results.md` の「草案の版を改める必要がある点」と、統合者が挙げた改める点 5 つ。

### 16.1 改める点 5 つ

| # | 改める点 | 契約の文をどう変えたか | 直した節 |
|---|---|---|---|
| 1 | **T-9 (ii)**：容量で failed になった Verify は、自動では戻らない | §5 の「既に止まっている project」を、試作の結果で書き直した。completed・non-clean の形は自動で戻る（Finding がある形は未確認）。容量で failed の形は**自動では戻らない**と確定し、機構の読み（recovery の `ManualIntervention` の分岐）は【推測】とした。GDV/1 は自動の回復を足さない（terminal failure の lifecycle を変えるため、範囲の外）。人の手の道が既存の Inbox で足りるかは【未確認】。K-2 (a) の下での挙動は【未確認】。開示の変更で、緩和は増えない | §0、§2.3、§3.3 (a)、§5、§8、§9、§10.2、§11「残る止まり」、§13 |
| 2 | **T-6 (3)・(4)**：今の epoch なしは `Skip{NoEpoch}`。Edge State が stale／別 epoch は current で manual のまま | helper の条件は試作のまま変えない（今の epoch なしは not-current のまま。current か incoherent に置くと manual に戻るだけのため）。§3.1 の「B が直す対象になるもの」を「eligibility を読まないもの」に直し、今の epoch なしの形を名指しした。GDV-R1・R4 の「緩む面」に開示を足した。Edge State の 2 形は §3.1 の【未確認】を試作の事実（`Skip{BindingCurrent}`）に替え、2 段目に入れない理由にした。§5「残る止まり」に、B も直さないことと、正当な書込みの経路が読みでは見つからないことを書いた。source digest のずれのうち metadata を書き換えた形は incoherent だったので書き分けた | §0、§2.6、§3.1、§5（GDV-R1、R4、残る止まり）、§6.1 (A2・A3・A5)、§8、§11（GDV-R1、R4、残る止まり）、§13 |
| 3 | **既存の試験 3 件**が、dirty な Graph の旧い扱いを assert していて落ちる | §8 の「既存の試験」に 3 件の名前、行（dev 枝）、書き換えの中身を書いた。「Verify に見え続ける」は対象外の欄で保ち、ほかの assert を弱めない。全件の run・clippy・検査器の取り直しを §8 に足した | §0、§2.6、§8、§10.2、§11 |
| 4 | **案 C** が build を 1 回増やす場合がある（試作では起動 1 → 3 回、publish +1） | §7 に試作の形・結果・推測の原因を書いた。案 C は止まりを解くためには要らないこと（案 C なしでも止まらない）を書いた。範囲を狭めるかは委任の内の DR で決める（起案者の推奨は試作の形のまま費用を開示）。あわせて、試作の形は reason を `"durable-wake"` に固定していて before-cutover の除外が効かないことを、DR で決める点と §8 の【新規】にした。§5 と §11 に費用を開示した。契約の文（§3）は変えない | §2.6、§5「案 C の費用」、§6.2、§7、§8、§9、§11「私が決めた点」 |
| 5 | **DR-BSEAM-1 (b)** の前提が、not-current の binding では変わる | §2.2 に main の discovery の事実（`maintenance_runtime.rs:2311-2346`）と、GDV/1 の後の変化（not-current では planner が Ok、main は `Work(Verify)` か `GraphIndexBuildWake`）を書いた。GDV-R3 の「今」と「新」と「緩む面」に名指しし、書き直す注を 2 つから 4 つにした（main の discovery の doc、試験の注）。`bseam-decisions.md` に注を足すことも書いた。B を先に置く役目は案 C に移る。開示の変更で、緩和は増えない | §0、§2.2、§5 GDV-R3、§7、§8（書き換える試験 1）、§11（GDV-R3） |

### 16.2 そのほかに直した点

- Status、前の版の一覧（改訂 3 と SHA-256）、`origin/master` の現在（`f806138e`）と根拠の file が変わっていないことの確認、記法【試作 T-n】【事実：dev 枝】を足した（冒頭）。
- §1.3 の段取りを、済んだ段と、§8 が通らないときの扱い（実装を止め、版を改めて改めて伺う）に直した。
- §8 の (b) の「5 つの読み手でやり直しにも拒否にもならない」を、「前後で同じ。clean な outcome ではやり直しも拒否も無い。current な binding の制御なしの読み手は前後とも `context-unavailable`」に直した。改訂 3 の文は、current な binding の fixture では変更の前から成り立っていなかった。
- §8 の Positive の「Idle に達する」を、製品の経路（Idle）と seam の wake（`GraphIndexBuildWake` が続き、Run は増えない）に書き分けた。
- K-2 (a) を試作していないことを、§0・§3.3・§5・§8・§11 に書いた。
- 試作で確かめた【推測】と【未確認】を、【試作 T-n】に替えた（§2.2、§3.2、§3.3、§4、§5、§6.1、§6.2、§7、§9）。試作で確かめていないものは【推測】【未確認】のまま残した。
- §10 を、計画（改訂 3 のまま、§10.1）、結果（§10.2）、実施しなかった項目と扱い（§10.3）に分けた。
- §8 の各行に【試作済み】【新規】の印を付け、試作の記録より広く読める行（incoherent の Finding、期限の拒否での Rebuild、current な binding の S-5、再 publish の後の full validation）は、試作済みの範囲と【新規】に分けた。
- §4 の incremental Freshness の行を T-12 の結果に、§12 の経緯に dev 試作と改訂 4 を足した。
- §11 の質問文の SHA-256 を「この版の SHA-256（確認のときに統合者が埋める）」にし、試作の結果と、試作で確かめていないことを書いた。3 択は変えない。

### 16.3 委任の外のもの

- 改訂 4 で、閾値の緩和、新しい送信先、保存範囲の拡大、製品の公開、認可の削除、新しい authority は足していない。
- 新しい「要確認」は無い。改める点 5 つは、どれも既存の緩和（GDV-R1・R3・R4）の開示の追加、開示の確定（既に止まっている project）、委任の内の DR（案 C）、試験の書き換えで扱えた。
- 容量で failed になった project の自動の回復は、要るように見えうるが、この改訂には入れず開示に留めた（§5、§13）。入れるなら terminal failure の lifecycle の変更で、別の判断になる。

## 17. Opus レビュー 3 の反映（改訂 5）

入力：`05-iii-review-opus-3.md`（必須 2・推奨 6・軽微 5）。改訂 5 で新しく引いたコードの行は、起案者が `f806138e` で読んだ（冒頭）。改訂 5 の 2 点（判定の順、下流の gate の検査）は試作しておらず、§8 の【新規】に回した。§10.1・§10.2・§16 は、試作と改訂 4 の記録として書き換えず、差はこの節と各所の「改訂 5」の注で示す。§10.1 の不合格の扱いの「GDV-R9 を「gate を閉じたままにする」代案（§13）に改める」は、改訂 5 では本文（(x)）になっており、§13 には逆に (y) を置いた。

### 17.1 必須

| # | 指摘 | 扱い | 直した節 |
|---|---|---|---|
| M-1 | 「今の Semantic Epoch が無い形」を recognized not-current に入れる根拠が成り立たない | **採る**。この形を not-current から外し、今どおり full validation に渡す。2 段目の最初に epoch を見て、無ければ dirty かどうかによらず「今のまま」にする（`is_complete_registered` は `:2692-2694` で eligibility を読む前に false）。改訂 4 の理由（manual に戻るだけ）は、epoch が無い間は Verify も Rebuild も dispatch されない（`maintenance_runtime.rs:2493-2507`）ので成り立たなかった。GDV-R1・R4 の改訂 4 の追記、A5、§8 の【新規】の旧い行、§11 の 2 か所、§13 の行を削るか書き換えた。T-6 (3) の合格の条件は「not-current の全部の形で B の hint が build」に戻した。試作の helper は dirty を先に見るので、順の変更を §8 の【新規】にした。分類の名前は「current」から「今のまま（current と、今の epoch が無い形）」に改めた | §0、§2.6、§3.1、§4、§5（前文、GDV-R1、R4、今の epoch が無い形）、§6.1（A2、A5）、§8、§10.3、§11（GDV-R1、R4）、§13 |
| M-2 | GDV-R9 の不足：下流の gate が、current では閉じ、not-current でだけ開く（非対称）。C2-ZC の不可逆な cutover も名指されていない | **採る。(x)（閉じたまま）を本文にした**。比べた結果は §5 の「GDV-R9 の位置づけ」。到達性：cutover は marker が無い間、製品の scheduler の wake ごとに自動で試され（`lib.rs:7072-7125`）、readiness と制御なしの skip 判定を要る（`c2zc_canonical_cutover.rs:239-288`）。B の判定と Graph の publish は marker を見ない。cutover の前の DB に binding が publish されうるかは、端まで読めなかった【未確認】。規則に従い (x) にした。(x) の検査は `seal_repair_plan` と `inspect_verify_gate` の 2 か所だけで、対象外の欄が空でない report を拒む。cutover は readiness を経て推移的に閉じる。制御なしの digest、`evaluate_completed_run_skip`、skip の証跡の seal、Finding の解消は閉じない（連鎖に要る）。動機の形の止まりが解けるか：閉じる 2 か所は自動の連鎖の経路に無い（`seal_repair_plan` は IPC の手動の呼出しだけ、`inspect_verify_gate` は cutover の readiness からだけ）ので、解ける読み【コードの読み】。§8 で T-1・T-11 を (x) の head で取り直す。座標：`repair.rs`・`c2z_preparation.rs` は座標の材料に入っていない（`maintenance_contracts.rs`）ので、K-2 (b) と矛盾しない。GDV-R9 の「今」を、current な binding でも閉じている形に直した | §0、§1.4、§3.2（下流の gate）、§3.3（K-2 (b) 3、K-4）、§4、§5（GDV-R9、位置づけ、残る止まり、report の形）、§6.1（A4、Mandatory defenses）、§8、§9、§10.3、§11（GDV-R9、K-4、残る止まり、T-7）、§13 |

- (x) で動機の形の止まりが解けない場合に §11 で両案を選べる形にする指示には、当たらなかった（解ける読みのため）。§11 は 3 択のまま。§8 の取り直しで解けなければ、§1.3 の 5 のとおり実装を止め、版を改めて伺う。

### 17.2 推奨

| # | 指摘 | 扱い | 直した節 |
|---|---|---|---|
| R-1 | 案 C の reason：before-cutover の除外を、DR の選択肢ではなく拘束として書く | **採る**。§7 に拘束「reasons の**どれか**が `before-cutover`／`before-cutover-follow-up` なら判定しない」を書き、根拠の既存の不変条件を引いた。§8 はこの拘束の試験だけにした。判定の Err が request の別の project の work まで止める点を、DR の論点に足した | §7、§8、§11（案 C） |
| R-2 | 「起動 1→3 回、publish +1」は最初の cycle の中だけの観測で、assert も無い | **採る**。§0、§2.6、§5、§7、§9、§11 で「最初の cycle の中で」と限り、総数は記録していないと書いた。§8 に、最初の cycle の後と全部の wake の後の generation を両方 assert する行を足した。T-11b の graph-build 3 回も §5 に書いた | §0、§2.6、§5、§7、§8、§9、§11 |
| R-3 | T-5 の「5 つの読み手も前後で同じ」に、current な Graph では 4 つが前後とも Err／Blocked だという断りが無い | **採る**。内訳（current では 4 つが同じ Err／`Blocked`、中身のある一致は制御つきの skip の 1 つ、binding なしでは 5 つとも中身のある一致）を §8 と §11 に書いた。M-2 の非対称の開示（§5 GDV-R9）とつないだ | §8、§11 |
| R-4 | 「製品の DB には当たらない」は seam で作った DB の写しには言えない。T-9 (ii) の機構は【事実】に上げられる | **採る**。範囲を「評価や開発で gate を開けた起動で作った DB と、その写し・restore（製品の build で開いても残る）」に直した。機構は起案者が `f806138e` で読み直して【事実】に上げた。「自動では戻らない」は同じ Semantic Epoch の間と限った。K-2 (a) でも戻らない見込みを【推測】として書いた | §0、§2.3、§3.3 (a)、§5、§9、§11 |
| R-5 | DR-BSEAM-3 と -6 (3) も、書き換える試験 1 の assert を根拠にしている | **採る**。GDV-R3 と §8 の書き換える試験 1 に、両方へ注を足すことを書いた | §5 GDV-R3、§8 |
| R-6 | S-5 が Graph の head だけを飛ばし、ほかの head の評価を変えないことを受入れで assert する | **採る**。§8 Negative に【新規】を足した | §8 |

- 採らなかった推奨は無い。

### 17.3 軽微

| 指摘 | 扱い |
|---|---|
| T-6 の「19 形で一致」は作りから自明で、SQL を適用できない形は黙って飛ぶ | 採る。GDV-R4 と §8 に、回帰の試験として読むこと、全形の適用を assert することを書いた |
| B-close の共有の句を GDV-R1 に引く | 採る。GDV-R1 に 2 つの句を【レビュー 3】の引用として書いた（起案者は B-close の該当行を読み直していない） |
| current な binding で、helper の 1 段目が外側の budget を使う | 採る。§4 に書き、§6.2 の「二重の読み」とつないだ |
| 2 段目の「部分集合」の範囲（`canonical_instant` と dependency digest を見ない） | 採る。§3.1 と §6.1 A2 に書いた |
| S-5 の shadow が `with_immediate_transaction` の中で走ること | 採らない。レビュー自身が問題なしとしており、本文の文と矛盾しないため |

### 17.4 委任の外のもの

- 改訂 5 で、閾値の緩和、新しい送信先、保存範囲の拡大、製品の公開、認可の削除、新しい authority は足していない。M-1 と M-2 は、どちらも緩和を狭める向きの変更（今どおりに戻す）である。
- 新しい「要確認」は無い。
  - (x) の検査を `repair.rs` と `c2z_preparation.rs` に置くことは、新しい authority ではなく、既存の gate を今どおり閉じたままにする検査である。
  - `c2z_preparation.rs` の変更で C2-ZC の freeze gate の receipt が要る見込みは、品質の手順の話で、委任の外の判断ではない（§9）。

## 18. 試作 r5 とレビュー 4 の反映（改訂 6）

入力：`05-gdv1-dev-results-r5.md` の「草案を改める必要がある点」8 つと、`05-iii-review-opus-4.md`（必須 0・推奨 6・軽微 7）。改訂 6 で新しく引いたコードの行は、起案者が `f806138e` か dev 枝 `ec550a58` で読んだ（冒頭）。§10.1・§10.2・§14〜§17 は、前の試作と前の改訂の記録として書き換えず、差はこの節と各所の「改訂 6」の注で示す。§17.4 の「`c2z_preparation.rs` の変更で receipt が要る見込み」の因果は、§9 で改めた（レビュー 4 の R-4）。

### 18.1 試作 r5 の改める点 8 つ

| # | 改める点 | 契約の文をどう変えたか | 直した節 |
|---|---|---|---|
| 1 | 前の試作の T-1・T-11・T-3 は marker のある DB だった。marker の無い DB でも Idle に達し、Graph は publish されうる | 記法に fixture の注を足した。「marker の無い DB では Idle を主張しない」を取り消し、自動の保守は Idle に達して止まるのは cutover だけ、Run は増え続けない（8 round の観測）と書いた。「cutover の前の DB に binding が publish されうるか【未確認】」を、試作 r5 の事実（近似の形）に替えた | 冒頭、§0、§3.2、§5（位置づけ、残る止まり）、§8、§9、§10、§11、§13 |
| 2 | 「current な Graph の今と同じ経路」は、cutover が進まない点だけで一致する | §3.2 と §5 の位置づけを「cutover の側は同じ、before-cutover の連鎖の側は違う（current は毎回 Err、not-current は 1 回の Verify の後 `None`）。理由の文字列も違う」に書き直した（レビュー 4 の R-6 と同じ） | §3.2、§5 |
| 3 | (x) が cutover を止めていることを、(y) の対照で確かめた | §3.2 に対照の結果を書き、§5 の (x) を選んだ理由 1 を「(y) では届くと確かめた」に強めた | §3.2、§5、§13 |
| 4 | 案 C の余分な publish は、順序の違いではなく総数の差（generation 3 対 2、起動 3 対 1） | §5 の「案 C の費用」を全部の wake の後の数に改め、DR が選びうる最大の費用として開示した。§7 に表と、DR の 3 つの選択肢（C-1 試作の形、C-2 狭める、C-3 やめる）を書き、起案者の推奨を C-1 から C-2 に改めた。GDV-R3 と §7 の DR-BSEAM の文を、案 C をやめても成り立つ形にした | §0、§2.6、§5、§7、§8、§9、§11 |
| 5 | `before-cutover-follow-up` は request の preflight が拒む。reasons が混ざった RebuildDerived の item では、cycle の最後の rediscovery が B を起動する | §7 の拘束に試作の結果を書き、follow-up を request で渡す試験を §8 から外した（拘束の実装は follow-up を含めたまま）。最後の rediscovery の起動は既存の挙動と読む【推測】とし、DR の論点に残した | §7、§8 |
| 6 | epoch を作った後の B の hint は `Build{Rebuild, BindingDirty}`（見込みは `Build{NotCurrent}`） | §3.1 の見込みを観測に替え、§8 の受入れを「build を返す」までにし、reason は記録にした。Backfill の実際の run と `dirty_cache_flag` の値は【新規】 | §2.6、§3.1、§5 GDV-R4、§8 |
| 7 | `semantic-graph-requires-repair` の Finding は、dev の経路のどの形でも作れなかった | 「生じない」とは書かず、【未確認】のままにした。§8 の incoherent の行を「Finding まで通る」から「変更の前の build と同じ結果」に改め、解消の行は Finding を SQL か直接の projection で作る形にした。GDV-R2 の「今」と §2.3・§4・§6.1 A3 に注を足した | §2.3、§4、§5（GDV-R2、既に止まっている project）、§6.1、§8、§10.3、§11 |
| 8 | (x) の拒否の code と reason、新しい分類の名前が本文に無い | Repair の code `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE` と C2Z の reason `verify-graph-recognized-unavailable` を本文で決めた（試作 r5 の名前）。`NoCurrentEpoch` は内部の値として実装の判断に残した。§1.4 の DR の範囲から「report の欄の名前」を外した | §0、§1.4、§3.1、§3.2、§5 GDV-R9、§8、§11 |

### 18.2 レビュー 4 の推奨

| # | 指摘 | 扱い | 直した節 |
|---|---|---|---|
| R-1 | (x) の片側（欄が空の report）は、S-4 の印による digest の不一致に依る | **採る**。§3.2 に不変条件と、印を外す変更が (x) を壊すことを書き、印の 2 つの性質を実装の拘束にした。§3.3 (b)、§6.1 A4、Mandatory defenses にもつないだ。§8 に「current で封じた後で not-current になる形」を【新規】で足した。Repair の不一致の code は `NEX_VERIFY_GRAPH_STATE_CHANGED`（`restore_rebuild.rs:3545`）と `f806138e` で読んで書いた | §3.2、§3.3、§6.1、§8 |
| R-2 | §8 の拒否の試験が、ほかの gate で落ちても合格する | **採る**。§8 に書き方の規則（理由の code・reason まで assert し、対照と対で示す）を足し、(x) の各行に code・reason を書いた。cutover の行には、message に reason を含むことと、同じ fixture で制御なしの `evaluate_completed_run_skip` が Skip を返すことの assert を足した | §8 |
| R-3 | §11 の「新しい理由・文言は足しません」と、(x) の code・reason が食い違う | **採る（案の 1 つ目）**。§3.2 に名前を決め、§11 の文を「保存先・送信先は足さない。理由の集合と画面の文言は変えない。足すのは名指しした名前だけ」に改めた。2 つ目の案（既存の code・reason の使い回し）は採らない。R-2 の理由での assert が弱くなるため | §0、§3.2、§11 |
| R-4 | §9 の receipt の因果と行番号 | **採る**。§9 を「`narrative_extraction/**` を変えるので既に unit に当たる。`c2z_preparation.rs` は gate の試験の file を変えるだけ」に改め、行番号を `:127-152`・`:902-924` に直した（起案者が読み直した）。local-ci の stage の選び方は【未確認】のまま | §9 |
| R-5 | §11 の GDV-R4「どれも B が直す形」は本文より強い | **採る**。§11 を「作り直し（B）の対象になる形。入力が大きすぎれば断られ、待ちが続く」に改め、GDV-R4 にも同じ断りを書いた | §5 GDV-R4、§11 |
| R-6 | 「current な Graph の今と同じ経路」は不正確。main 側は事実に上げられる | **採る**。試作 r5 の 2 点目と合わせて §3.2・§5 を書き直し、main 側の扱いを【レビュー 4】として書いた（【推測】を外した） | §3.2、§5 |

- 採らなかった推奨は無い（R-3 の 2 つ目の案だけ、上の理由で採らない）。

### 18.3 レビュー 4 の軽微

| # | 指摘 | 扱い |
|---|---|---|
| m-1 | `seal_repair_plan` の製品の呼出しに apply の re-seal が落ちている。検査の置き場は `load_sealable_verify_result` と書く | 採る。§3.2、§5 の位置づけ (2)、K-4 に書き、§8 に apply の経路の【新規】を足した |
| m-2 | C2Z の検査の位置を「`:1446` の後、`:1448` の前」と特定する | 採る。§3.2 に書いた（`f806138e` で読み直した） |
| m-3 | 改訂 5 で試作していないものは 3 点（before-cutover の拘束を含む） | 採る。Status と §1.3 で 3 点と書いた。3 点とも試作 r5 で実装して確かめた |
| m-4 | foreground の Verify の完了の gate が名指されていない | 採る。§3.2 の「閉じない」、GDV-R9、§5 の前文、§8 の【新規】、§11 に名指しした。skip の証跡の seal の 3 つ目の位置で、数は 9 のまま |
| m-5 | dev 枝の T-7 は `plan?` のままで (x) の下では落ちる見込み | 採る（試作 r5 が済ませた）。T-7 は (x) の期待値に書き換えられ、code と reason を assert して合格した。本文は §3.2・§10.4 を試作 r5 の結果に改めた |
| m-6 | `inspect_project_cutover_readiness`・`inspect_workspace_cutover_readiness`（`mod.rs:332-333`）も公開されている | 採る。§5 の位置づけ (2) に名指しした（起案者が読み直した） |
| m-7 | §4 の「上限の近くで今より早く容量の Err」が §11 に無い | 採る。§5 の「残る止まり」と §11 の「残る止まり」に 1 行足した |

- 採らなかった軽微は無い。
- レビュー 4 の「未確認」のうち、staging の project（`is_scan_staging_project_in_tx`）に Graph の binding がありうるかは採らない。改訂の前後で扱いが同じで、GDV/1 の範囲の外のため。

### 18.4 そのほかに直した点

- Status、前の版の一覧（改訂 5 と SHA-256）、dev 枝 `ec550a58` の行番号の扱い、改訂 6 で読んだ行、経緯、記法（【レビュー 4】、【試作 r5 T-n】、fixture の注）を足した（冒頭）。
- §0 に、足す名前、試作 r5 の結果、案 C の DR の選択肢を足した。
- §10 に §10.4（試作 r5 の結果）を足し、§10.3 の「扱い」の列を改めた。
- §8 の各行の印を、試作 r5 の結果で改めた。試験が値を assert せず出力の記録だけだった値（T-3 の generation、cutover の loop、Verify の形）は【試作済み・記録】か「出力の記録」と書き、実装の PR で assert にする。
- §8 の clippy の行：`--features nir1-material-diagnostics` 付きの受入れを、改訂 5 の「通る」から「基点と同じ指摘だけで、GDV/1 が変える file に指摘が無い」に改めた。指摘は GDV/1 が変えていない 3 file の既存のもので、基点でも通らない見込み【推測】。この command は CI（`ci.yml`）の command に入っておらず、確認台帳の閾値でも Gold でもない。そのため、委任の外の「閾値の緩和」には当たらないと判断した。基点で通ると分かれば、改訂 5 の受入れに戻す（§8）。
- §8 で、試作 r5 の観測の値（案 C の C-1 の generation と起動の数、cutover の loop の Run の数）は、値そのものではなく開示の上限か「増え続けない」を assert の対象にした。原因が未特定で 1 つの fixture の観測なので、開示より良い結果で実装が止まらないようにするため。
- §11 の質問文を改訂 6 に合わせた。選択肢の文言を「承認する（K-2 は (b)）」「承認する（K-2 は (a)）」「承認しない」にした。3 択は変えない。

### 18.5 委任の外のもの

- 改訂 6 で、閾値の緩和、新しい送信先、保存範囲の拡大、製品の公開、認可の削除、新しい authority は足していない。
- 新しい「要確認」は無い。
  - 足す code と reason は、既存の 2 つの gate を今どおり閉じたままにする検査の拒否の名前で、新しい authority でも送信先でもない。外の契約はこれらを列挙していない【レビュー 4】。
  - 案 C の範囲（C-1〜C-3）は、委任の内の lifecycle の技術判断（§1.4、§7）。どれを選んでも、契約の文（§3）と緩和の数は変わらない。
  - foreground の Verify の完了は、既存の緩和（GDV-R9 の skip の証跡の seal）の位置の名指しで、緩和を増やさない。
  - clippy の受入れの書き換えは、上の 18.4 のとおり、確認台帳の閾値と Gold の外。
