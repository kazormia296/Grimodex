# G-04 fixture v2（案 C）独立期待値レビュー

- レビュアー：独立期待値レビュアー（read-only）。fixture の作成者・設計のレビュアーとは別の担当
- 対象：`/home/grimodex/worktrees/Grimodex/claude-g04-v2c/evals/nir1-graph/g04-scope-exact-unknown.v2.json`
  - sha256 `ec5455a991a423e57994c0968fb9ee75cf20acadf6452d5e829216d80a5dbde3`（実物で確かめた。再 probe の dir の `g04-scope-exact-unknown.v2.candidate-bytes.json` と `v2c-probe-out.json` の `fixture.sha256` も同じ値）
- 比べる元：同じ dir の `g04-scope-exact-unknown.v1.json`（凍結済み）
- worktree の HEAD `8187fbfc`。tracked file の差分は 0、untracked は v2 の 1 file だけ（`git status --short --ignored evals scripts`）。repo に一時 file は作っていない
- 導出の作業 file（設計 §2〜§4 を読む前に書いた）：`/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/g04c/derivation-before-design.md`
- 実行した script：同じ dir の `diff.mjs`（構造の差分）と `run-validator.mjs`（`validateGraphCaseFixture`。schema は fixtureId の pattern だけメモリ上で `/[12]$` に緩めた）

## 結論：(a) 受入れ可

期待値を規則だけから導き直し、作成者の値と**全項目で一致**した。P1 と P2 は無い。P3 が 5 件ある（文章の正確さ）。直すのは推奨だが、受入れの条件にはしない。P3 を直すなら、変わるのは `measurementBoundary` の 2 欄と `positive[0].rule` だけである。この 3 つは probe が読まない field（再 probe の README:9）で、期待値も変わらない。

## 1. 構造の差分（手順 1、`diff.mjs` で v1→v2 を比べた完全な一覧）

| path | v1 | v2 |
|---|---|---|
| `fixtureId` | `…/1` | `…/2` |
| `slotClass` | `ir-supplemented` | `supplementable` |
| `scenes[0].body`（rv-match） | "Tally marks covered a wooden post near a jetty." | "Chalk tallies lined a weathered post beside a quiet dock." |
| `scenes[3].body`（rv-unknown） | "Wind tugged at a shutter on an empty inn." | "Rain dripped from the eaves of a silent inn." |
| `scenes[6].role`（lio-landing） | `ir-only` | `answer` |
| `pins` | 6 件 | 5 件（`g04-lio-market`/`g04-lio` を外した。残りは v1 と同じ組） |
| `qualifiedIr` | 2 行 | 1 行（lio-landing の行を外した。control の行は v1 と同じ bytes） |
| `variants[0].description` | 変更 | — |
| `variants[0].preconditions[3]` | `ir-supplement-admission`/variant | `cb4-inputs`/added-scene/`g04-lio-landing` |
| `arms.rPlusIr.sceneIds` | [control, lio-landing] | [control] |
| `arms.rPlusIr.irSupplementSceneId` | lio-landing | null |
| `arms.rPlusIrPlusGraph.appendedSceneId` | null | lio-landing（`sceneIds` は v1 と同じ [control, lio-landing]） |
| `pathAttachments` | 1 件（lio-landing） | [] |
| `addedScene` | null | lio-landing（path、excerpt [0,211)） |
| `blockedCandidates` | 1 件（lio-market、`ir-supplement-used`） | [] |
| `evidence.requirements[4]` | `raw-excerpt-unchanged` | `added-scene-body-anchor` |
| `metrics.rPlusIr` | 0.5／0.4966… | 0／0 |
| `positive` | P1、P2 | P1（expectation と rule を変更）。P2 は削除 |
| `measurementBoundary.graphConnection`、`.rawPrediction` | 変更 | — |

次の field は v1 と同じ bytes であることを `JSON.stringify` の一致で確かめた：`graph`（全体）、`goldDefinition`、`answerEntityIds`、`query`、`scope`、`entities`、`relations`、`revisions`、`setupTimeline`、`negative`、`manualSeed`、`foreshadows`、`mutations`、`eligibleSceneIds`、`caseClass`、`designReferences`、`observationPolicy`、`measurementBoundary` の `contractBaseline`／`runtimeSetup`／`setupOrder`／`goldOrigin`／`setupRefusal`、全 Scene の (id, gold, readingOrder, title)、top-level の key の順。

→ 手順 4 (a)：変更は設計 §2.3（設計文書:74-77）が宣言した集合に収まる。宣言の外の変更は無い。

## 2. 規則からの導出（手順 2。設計 §2〜§4 を読む前）

根拠は README の規則表（README:114-129）と validator（`scripts/quality/nir1-graph/contract.mjs`）。

- **Revision の資格**（contract.mjs:367-405）
  - `g04-r-lio`：rv-match（order 0 < 100）は Scope が既定（explicit、3 軸 exact で query identity と一致、reader／reader）なので資格を得る
  - `g04-r-kit`：`scope-mismatch`（material worldline exact wl-alt、query は wl-main。:385-389）
  - `g04-r-ora`：`scope-unresolved`（:384）
  - `g04-r-tam`：`scope-marker-unknown`（:378-379。override の marker unknown は :319 でそのまま返る）
  - `g04-r-sel`：`holder-not-reader`（:392-393）
  - foreshadow と mutation は空なので、stale と secret の理由は出ない
  - review Scene の**本文はどの規則の入力でもない**。このため除外の理由は v1 と同じになる
- **graph**：適格な Entity は {bren, lio}、適格な Relation は {ferried-lio}。seed の bren は適格（:526）。traverse（:407-437）の結果は nodes [bren@0, lio@1]、edgeIds [ferried-lio]
  - excludedEdges：kit／ora／tam／sel の 4 本は `revision-excluded`（:576-578）
  - excludedEntities：kit／ora／tam／sel は `revision-excluded`、mott は `no-revision`（:616-629）
  - 入力が v1 と同じなので、**`graph` は v1 と同じ bytes であるべき**。v2 は実際に同じ bytes だった
- **Scene への対応付け**（:647-686）
  - 到達した非 seed Entity は lio だけで、その pin は (lio-landing, lio) の 1 件。framePinCount は 1（≤ 8）
  - control の pin（Kit、Ora、Tam、Sel）は未到達 Entity の pin なので候補にならない。N4 の「no path reaches g04-control」は成り立つ
  - 代表 path が複数ある Scene は無い
- **arms**
  - R＝[control]。control は 1 件なので orderPredeclared は true（:1163-1166）
  - ir-only が無いので R+IR＝[control]、irSupplementSceneId は null（:1193-1200）
  - resultKind は記録だけ（README:47）。ir-only が無いので validator は fused を要求しない（:1205）
- **融合**（:694-717）
  - R+IR は 1 件（8 未満）で、irSupplement は null なので、枠は開く
  - 新規の候補は lio-landing だけ（hop 1）。addedScene は lio-landing、path は {bren, [ferried-lio], lio, hop 1}
  - blockedCandidates は []。lio-market に pin が無いので候補にならない
  - R+IR+Graph＝[control, lio-landing]、baseline は rPlusIr
- **pathAttachments**：[]。R+IR の Scene（control）に候補が無い（:687-690）
- **scenesWithoutPath**：[control]（:1396-1402）。**forbiddenSceneIds**：[]（decoy が無い）
- **excerpt**：lio-landing の本文は改行を含まず、UTF-16 で 211。範囲は [0,211)（:1362-1371、README:128 の最初の非空行）。本文は v1 と同じ bytes
- **evidence**
  - Graph が寄与するので、必須 4 種と `added-scene-body-anchor` が要る（:1420-1444）
  - path の付加が 0 件なので、`raw-excerpt-unchanged` は要求されない（:1431-1437）。G-08 graph-recovered（付加 0、追加 1）と同じ形
  - pathEvidenceValidity は 1、assertions は []
- **metrics**：`scoreQuery`（`scripts/quality/nir1-retrieval/contract.mjs`:147-196）の gain は 2^g−1、割引は log2(i+2)
  - relevant は lio-landing（3）と lio-market（2）。IDCG＝7＋3/log2 3＝8.892789
  - R と R+IR：recall 0、nDCG 0
  - R+IR+Graph：recall 1/2＝0.5、DCG＝7/log2 3＝4.416508、nDCG＝0.4966393
  - 非回帰（:1540-1546）は成り立つ。lio-market はどの arm でも返らないので、recall の上限は 0.5
- **preconditions**（:1633-1655）：b-sealed-binding、maintenance-enabled、raw-membership（いずれも variant）と cb4-inputs（added-scene、lio-landing）。ir-only が無いので `ir-supplement-admission` は要らない（宣言すると拒否される）。順は catalog の順（:118-125）
- **slotClass**（:1549-1573）：base の arms から `supplementable` が導かれる

## 3. 作成者の値・設計 §2〜§4 との突き合わせ（手順 3）

- 上の導出と v2 の値は**全項目で一致**した。差は無い
- validator を Node v24.18.0 と、CI と同じ Node v22.23.3 で実行した。v1、v2 とも誤り 0 件。`evaluateGraphCaseVariant` の computed は導出と一致した
- 設計 §4.1 の表（設計文書:133-147）と §4.2 の draft（:154-166）も、私の導出と項目ごとに一致した
- 設計 §2.3 の「variant の中で変える」に `arms.rPlusIrPlusGraph` がある。実際に変わったのは `appendedSceneId` だけで、`sceneIds` は v1 と同じ列だった。設計の記述と矛盾はしない

## 4. 確認項目（手順 4）

- **(a) 変更の範囲**：上の 1 のとおり。宣言の外の変更は無い
- **(b) 候補 #4／#7 の選択**：候補の測定の README:24-34 と `cand.json`（sha256 `5415993a…`）で確かめた
  - 項目 B（rv-match）は #4（0.3908、合格）、#5（0.4357、不合格）、#6（0.4224、合格）。固定の順で最初の合格は #4
  - 項目 C（rv-unknown）は #7（0.4293）、#8、#9 がすべて合格。最初の合格は #7
  - 文字列の sha256 を再計算し、README の値と一致した（`450107ad…`、`3edf6ec7…`）。v2 の本文とも一致した
  - 再 probe の script（`probe-v2c.mjs`、`cd1fd432…`）と確認済みの `probe.mjs`（`8fcc9010…`）の `diff` は 165 行目の構造条件 1 行だけだった
  - 再 probe の生データ（`v2c-probe-out.json`）は対象の sha256 が `ec5455a9…` で、v2 の本文と pool の値が README:16 と合う
- **(c) 語彙の隔離**：`checkLexicalIsolation`（:765-808。title を含む）は誤り 0 件で通った
- **(d) validator**：誤り 0 件（Node 22／24）
- **(e) 閾値・Gold・pool**
  - goldDefinition と各 Scene の gold は v1 と同じ bytes
  - 指標の式と validator は未変更（tracked の差分は 0）
  - δ と floor は fixture に含まれない。紛れ込んだ変更は無い
  - Gold 2 の lio-market は pin を外したので、どの arm でも返らない。Gold の値は変えていないので、これは緩和ではない
- **(f) 文章**：下の P3-1〜P3-5。観測の後に作った版であることと、IR の recall の根拠にならないことは、`rawPrediction` から読める
  - 「CP-3a must also append on a raw R+IR basis」は G-02、G-07、G-08 の `graphConnection` と同じ文で、manifest の `dependencies`（manifest.v1.json:202）の依存を指す。control の IR が floor 未満だと R+IR の kind が raw になるので、CP-3a は raw の基底でも Graph-only の 1 件を足す必要がある、という意味である
  - v2 も、control の IR が probe で 0.6614（floor 0.66 の近く）なので raw になりうる。この文は v2 にも当てはまり、不適切な流用ではない

## 5. 製品の code での確認（手順 5）：review Scene の本文は typed Revision の準備にも Evidence にも入らない

- **setup の順序**（`scripts/quality/nir1-graph-eval/frozen-setup-plan.mjs`）
  - `project` → `scenes`（本文を含む行。:840）→ entities／relations → scope → foreshadows → `pins`（:879）→ seed pin → `maintenance-enabled`（:886）→ setupTimeline の Revision（:955 の author session）の順に進む
  - 本文は Revision の準備より**前**に書かれ、その後は書き換えられない
- **prepare の入力**
  - 引数は {projectId, sceneId, entityIds, relationIds} だけで、本文は渡さない（`frozen-setup-driver.mjs`:1524-1544）
  - IPC 契約も、この 4 つと proposalKey 以外の key を拒否する（`electron/shared/ipcContract.ts`:6878-6897）
- **製品の prepare**（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation.rs` の `build_live_typed_bundle`、:4269-4489）
  - review Scene は Scope の anchor だけに使われる。`reading` は `scene:<id>`、`authority_revision` は Scene Scope projection の token（:4305-4337）
  - Entity の Evidence は Codex の要約か名前で、`source_ref` は `codex:<id>`、範囲は [0, UTF-16 長)（:4412-4428）
  - Relation の Evidence は両端の Entity の Evidence ID（:4453-4474）
  - source basis は Codex の entry と relation、Scope projection だけでできている（:604-674）
- **projection token**（`scene_scope_projection.rs`）
  - module の doc（:9-18）は「bodies, titles or display labels では動かない」と書く
  - closed type の key は authorityRegistry、binding、contractId、projectId、sceneId、sceneIncarnationId、sceneRegistry、scopeGeneration の 8 つだけ（`build_projection` :205-248）
  - 試験 `the_projection_is_a_closed_type_without_body_title_rank_or_project_token`（:616-677）が、`body` と `title` を含まないことを検査している
- **結論**：review Scene の本文は anchor、quote、hash のどれとしても Revision と Evidence に入らない。本文を変えても Graph の入力は変わらない。設計の前提（設計文書:45、§10 の 3）は製品の code で裏付けられた
  - 補足：Graph の Evidence のうち Scene の本文を使うのは、追加 Scene（lio-landing）の `added-scene-body-anchor` だけである。lio-landing の本文は v1 と同じ bytes
  - Graph 側の grep：`nir1_graph.rs` と `nir1_graph/` の下に `content_json`／`FROM scenes` は無い。`nir1_entity_relation_index.rs` にも本文を読む SQL は無い
  - 本文を読むのは C-body の `evaluate_graph_only_scene`（`nir1_graph/scene_disclosure.rs`:332 が `body` module から再 export）だけで、名前のとおり追加 Scene が対象である
  - Evidence は prepare の時点で Codex から確定して保存される。このため、Index や query の側が本文を読んでも、review Scene の本文が Evidence に入る経路にはならない
  - 確かめていないこと：`body` module の中身は、行を追って読んでいない

## 6. 指摘（重大度つき）

P1：無し。P2：無し。

### P3-1 `graphConnection` が、G-04 の中心（Graph DTO による Scope 除外の比較）は C-body に依存しないことを書いていない

- 根拠：v2 の `measurementBoundary.graphConnection`（v2.json:666）は、C-body が Hold の場合について「While that authority is Hold … this case stays Hold」としか書かない。「the Graph DTO and the unchanged R+IR prefix are still compared」は、`cb4-inputs` が成り立たない場合の節にだけある。一方、G-02 の文（g02:519）は「path attachments to existing R+IR Scenes do not depend on it」を持つ。README:215 は「Graph DTO の nodes／edges は、C-body に依存しない」と書き、設計 §5（設計文書:176）も同じ立場である
- 害：G-04 v2 は付加が 0 件なので、C-body に依存しない部分は Graph DTO と R／R+IR だけである。fixture の文だけを読むと、C-body が Hold の間は Scope の除外（N1〜N4）も測れないと誤読しうる
- 提案：「Graph DTO nodes/edges and the unchanged R+IR prefix do not depend on it」を足す
- 再現：`jq -r .measurementBoundary.graphConnection` で v2 と g02 を見比べる

### P3-2 `rawPrediction` の「IR cannot use the shared slot」は、製品の挙動が未確認の経路について言い過ぎ

- 根拠：設計 §3.1（設計文書:93）と §10 の 5（:328）は、「表に無い Scene に製品が IR を作り、それが枠を使う」経路を未確認としている。その場合は `setupRefusal` の「any other R or R+IR difference from the arms is Hold」で Hold になる、と扱っている
- 提案：「is not expected to (no qualified IR outside R; any other R+IR difference is Hold)」のように、構成による宣言だと分かる形にする

### P3-3 観測の後に作った版の開示が、何を観測したかを書いていない

- 根拠：`rawPrediction` は「written after v1's runtime was observed」とだけ書く。設計 §1.3（設計文書:40-42）によれば、観測した内容は 3 つある：IR が lio-landing を採らなかったこと、rv-match が相対救済で R に入ったこと、作成者が diagnosis で Graph の子の要約（辺 0 件）を読んだこと
- 不変の `goldOrigin`（「Predeclared … before any Graph runtime observation」）は Gold についての文で、Gold は v1 のままである（設計文書:79）。このため偽ではない。ただ、v2 の追加の期待値は観測の後に作られている
- 害：fixture の中で自己完結した記録として読むと、IR／Raw／Graph のどれを見たかが分からない
- 提案：少なくとも「IR did not admit lio-landing and rv-match entered R」と書く。Graph の要約を読んだことは freeze 側に書く（設計 §7.3 の `graphOutputUsed: false` の注記）と相互参照する
- 補足：「chosen by a pre-freeze model-only probe」も、正確には「独立の作者が書いた候補から、model-only probe で固定の順の最初の合格を採った」である

### P3-4 `positive[0].rule` の candidate §6 の言い換えが、8 件未満の条件を落としている

- 根拠：接続候補 §6（`docs/plans/nir1-c-scene-connection-candidate.md`:166-167）は「IRが共通追加枠を使っていれば、R+IRが8件未満でも…追加しない」と書く。追加できる条件は README:14 と README:128 で、R+IR が 8 件未満かつ IR の行が無いこと、である
- v2 の rule「IRが共通追加枠を使っていなければGraph-only Sceneを1件追加」は、原文の逆の言い換えで、8 件未満の条件が無い
- 提案：「R+IRが8件未満でIRが共通追加枠を使っていなければ、最小hopのGraph-only Sceneを1件追加」とする。README:128 も併記する

### P3-5 不変の `setupRefusal` の例示に、v2 が宣言しない前提条件（ir-only IR admission）が残る

- 根拠：v2.json:668 の「(such as a Raw membership or an ir-only IR admission …)」。同じ文が G-02、G-07、G-08（ir-only が無い case）にもあるので、共通の定型文である
- 害は小さい：`resolveVariantOutcome`（contract.mjs:1779-1785）は、宣言していない前提条件で blocked にすることを拒否する
- 変えない判断（設計 §2.3）は妥当。記録としてだけ残す

## 7. 参考（指摘ではない）

- control 1 件の補完可能という形は G-01 と同じである（接続候補:233-240 の表）。G-02〜G-08 には前例が無い
- manifest:156（`raw-membership.check` の「the two controls of a supplementable case」）、README:89、README:137（G-04 の pin 2）、README:24 は、v2 を運用する前に文の更新が要る。fixture の外なので、この review の対象外とした。設計 §7.1 は列挙している
- probe は本文だけを埋め込む。Scene の title（rv-unknown は "Empty inn" のまま、本文は "silent inn"）が製品の Raw の dense 文書に入るかどうかは、確かめていない。この点は v1 と同じ方法上の前提で、`raw-membership` の観測で確かめられる

## 8. 読んではいけないものを読んでいないこと

- 次のものは開いていない：contracts の `gold-s5r4-1/`、`traces-*`、`parity-*`、`negatives-*`、`sp-p4-*`、`s6-aggregation-s5r4/`（README と `g04-base-diagnosis.md` を含む）、`s7-report-*`、`lapse-*`、`.artifacts/cp4/`、Graph の DTO、frame、graph arm の受領書、X5 の内訳
- 読んだ contracts の記録は、指定された 2 つの dir（`g04-v2-candidates-2026-11-01/` の README、cand.json、cand-out.json、probe.mjs と、`g04-v2c-reprobe-2026-11-01/` の README、probe-v2c.mjs、v2c-probe-out.json）だけである。これらには Raw と IR の cosine しか無い
- 設計文書は、§2〜§4 を、導出を作業 file に書いた後に読んだ。§1.3 と §5 以降は、突き合わせ（手順 3）の後に読んだ
  - 要点の節（設計文書:8-20）も、§1.3 と同時に、突き合わせの後に読んだ
  - 背景としてタスク文が与えていた事実（v1 の IR が floor 未満）は、最初から知っていた
  - 設計 §1.3 の 3（設計文書:42）には、Graph の出力の二次的な要約が 1 件ある（起案者が diagnosis で読んだ「子の辺は 0 件」）。これは導出を作業 file に書き、突き合わせを終えた後に読んだ。期待値の導出にも判定にも使っていない
- P3 の件数は 5 件（P3-1〜P3-5）。P3-5 は直さなくてよい記録としての指摘で、件数には含めている

## 追記：P3 を直した最終の bytes（sha256 96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1）の確認

**結論：(a) 最終の bytes も受入れ可。**

- **差分**：直す前の bytes（`v2-before-p3.json`、`ec5455a9…`）と構造で比べた（`diff.mjs`）。違う field は `positive[0].rule`、`measurementBoundary.graphConnection`、`measurementBoundary.rawPrediction` の 3 つだけだった。行の `diff` でも違う行は 3 行だけで、ほかの byte は同じである
- **文の内容**
  - 「R+IRが8件未満なら」：README:14、README:128 と validator の slotFree（contract.mjs:694-696）に合う
  - 「Graph DTO comparison does not depend on C-body and is still made」：README:215 と設計 §5 に合う
  - 「IR is not expected to use the shared slot」：構成による予測として書いた正しい表現で、反する結果は `setupRefusal` により Hold になる
  - 括弧の中の観測（v1 の ir-only を IR が採らなかったこと、review Scene 1 件が相対救済で Raw に入ったこと）：Raw と IR の事実である。設計 §2.1 の rv-match の Raw 0.4925 と、候補の README:7 に合う。Graph の出力には触れていない
- **validator**：Node 22.23.3 で誤り 0 件のまま
- P3-3 の補足（「独立の作者の候補から、固定の順の最初の合格を採った」）は文に入っていない。正確さの差は小さいので、直さずに受け入れてよい
