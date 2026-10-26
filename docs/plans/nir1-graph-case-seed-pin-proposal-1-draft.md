# NIR-1 G-case の seed の pin の契約提案 proposal/1（draft）: query の Scene に seed の pin を足す setup の addendum

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

## あなたが決めること（3 行）

- Graph の評価に使う 8 つの場面の組（G-01〜G-08）で、「問いの場面」に、事前に決めてある起点の人物への pin を 1 つずつ足してよいか（選択肢 A。推奨）。凍結したファイルは書き換えず、手順の追加として別のファイルに置く。
- G-01 も同じ扱いにしてよいか（判断 2。推奨は「含める」）。G-01 の元の設計書は「pin は `g01-mira` の 1 つだけ」と書いているので、問いの場面の pin についてだけ、その文の読み替えになる。外すと、評価を始める前の照合が 8 組そろわないので、G-02〜G-08 の Graph の評価も始まらない。
- 足さない場合（選択肢 C）、Graph の評価（CP-4 の Graph の arm）は形の上で合格にならないまま止まる。

推奨のままでよければ、この draft を名指す承認の一言でよい。承認の効力は承認の直後から始まる（条件の成立を待たない）。ただし、足した pin を使う評価の run は、下の「受入れ」の照合と、観測前の commit（独立 reviewer のレビューつき）の後に限る。

## 平文の要約

- 何が起きているか: 製品は、関連場面の一覧で人物関係のグラフ（Graph）をたどる起点（seed）を、「いま開いている場面に付けた pin のうち最初の 1 つ」で決める。評価用の場面の組は、起点の人物を「この人から始める」と別の欄（`manualSeed`）に書いただけで、問いの場面には pin を置いていない。このままでは製品は起点を持たず、Graph を一度も問い合わせない。評価の手順（K6/4。2026-10-26 に確認済み）は「起点は製品の規則で決まる」と定め、評価を始める前に、問いの場面の最初の pin が予定した起点と一致することを確かめるとしている。今は 8 組すべてで一致しないので、Graph の評価は始められない。
- 何をするか（推奨 A）: 評価の準備の手順の中で、問いの場面に、予定した起点の人物への pin を 1 つだけ、製品の画面と同じ書込みの関数（`upsertScenePin`）で足す。凍結したファイル（場面・人物・期待値・手順の文）は 1 byte も変えない。追加の手順は別のファイルに書き、評価の前に独立した reviewer に確かめてもらう。
- 何が変わり、何が変わらないか: 製品のコードを読んだ限り、この pin は、本文で探す検索（Raw）と出来事の索引の検索（IR）の結果・順位を変えない（どちらも pin を読まない）。Graph がたどる人物と、Graph が足す場面の選び方も変えない（起点の人物自身の pin は場面の対応付けに使われない）。変わるのは、製品が起点を見つけて Graph を問い合わせるようになることだけで、これは凍結した期待値がもともと前提にしていたことである。製品のコードは変えない。
- やらない場合: Graph の評価は形の上で始められず、Graph の公開（PUB-G）に要る評価が止まったままになる。

## ユーザーが批准すること

1 回の明示の承認で扱うのは次の 8 点と、各項目が指す節の記述である。範囲の正本はこの一覧で、台帳の `confirmedScope` はこの一覧を指すだけにする。**効力は承認の直後から**で、条件の成立を待つ部分は無い。

1. 選択肢 A: G-case の setup に、「設計」の「seed の pin の段」を足すこと（問いの Scene に、fixture が宣言した manual seed の Entity への pin を 1 つ、製品の renderer の API `upsertScenePin` で書く。`setupOrder` の外の 1 段）。
2. 判断 2: G-01 もこの段の対象に含め、候補 §7 の「唯一の pin」（`docs/plans/nir1-c-scene-connection-candidate.md` の :219-220、:237。`7a10dd11`）を、問いの Scene の seed の pin についてだけ読み替えること（「設計」の「G-01 の読み替え」）。
3. 変えないもの（「前書き」の「変えないもの」）。凍結した bytes、期待値、前提条件、`setupTimeline`、`measurementPoint`、K6/4 の閾値・規則・基準、製品のコード。
4. 段の置き場と記録（「設計」）、受入れの SP-P1〜SP-P5 と SP-N1〜SP-N14、観測前に固定するものと独立 reviewer に見せるもの（「受入れ」）。
5. threat model（「threat model」の節）。新しい actor、受け手、保存先、authority、外への通信を足さないこと。
6. K6/4 の R5 の照合をこの段の後の workspace で行い、match のときだけ K6/4 の判定を始めること（K6/4 の R5 と批准 9 は変えない。この draft は K6/4 のいう「CP-0 の側」の扱いにあたる）。
7. 照合や受入れが通らないとき（SP-N1〜SP-N14）は、この段を使った評価をせず、`[precheck]` で止めて integrator がユーザーに返すこと。特に、pin を足すと R か R+IR が変わることが分かった場合（SP-N7）は、この draft の前提が崩れるので、凍結のやり直し（選択肢 D1）を別の draft で提案する。
8. 許さないもの: この確認による製品のコードの変更。harness が seed を直接渡して判定に使うこと（K6/4 の In-scope attacks の 9）。凍結した file の書換え。query の Scene 以外への pin の追加と、fixture の pin の変更。Graph の公開（PUB-G）と Session C-1 の承認。K6/4、K6/2（`g01-eval-revision`、`graph-eval-procedure`）、K2/4 の行の確認や変更。

注記（批准の対象ではない）: この起案は integrator の指示による。ユーザーがこの問題について選択肢を選んだ記録は無い。選択肢、推奨、G-01 の読み替え、受入れの項目は、起案者が製品のコードと記録を読んで加えたもので、ユーザーの選択を経ていない。

## 前書き

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-graph-case-seed-pin-proposal/1`（略称の案: SP/1） |
| contractId | `graph-case-seed-pin-setup`（新規。理由は下の「系列の判断」） |
| 起案日と基点 | 2026-10-27。コードと master の文書は origin/master `7a10dd11`（#736）で確かめ、行番号はこの commit のもの。台帳 `docs/plans/nir1-l6-l9-execution-plan.md`（以下 l6-l9）、続行計画 `docs/plans/nir1-continuation-2026-10.md`（以下 cont）、K6/4 = `docs/plans/nir1-final-request-eval-proposal-4-draft.md`（SHA-256 `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`。台帳の値と一致することを再計算して確かめた）、K2/4 = `docs/plans/nir1-c-body-disclosure-proposal-4-draft.md`（`efc30cca32f2c91386baf3061836427ae7df3499c18188d31b5e2ba422a2fcfd`。同じく一致）、候補 = `docs/plans/nir1-c-scene-connection-candidate.md`（`ebba78c6…`）。統合 branch `claude/nir1-cp4` の記録 `docs/plans/nir1-lane-decisions/cp4-decisions.md`（以下 cp4）と harness（`scripts/quality/nir1-graph-eval/seed-pin.mjs`、`workspace-db.mjs`、`setup-driver.mjs`）は `cdc54510` で読んだ。どれも master に無い |
| 系列の判断 | 新しい系列にする。(1) K2 系列（K2/4 の setup の addendum）に置かない: K2/4 の 2 行は C-body の authority と宣言の保存で、K2/4 の addendum は「宣言する Scene と値」を K2/4 だけから決め、観測前の commit が書き足せるのは宣言の場所と B の seal の手順だけとしている（K2/4:418）。seed の pin を足すと確認済みの K2/4 の範囲の外になり、K2/5 で確認済みの authority の行を開き直すことになる。G-03〜G-06 は K2/4 の addendum の対象でもない。ただし、凍結した bytes を変えずに `setupOrder` の外に 1 段を足し、観測前の commit で独立 review を受ける形は K2/4（:402-418）から借りる。(2) K6 系列に置かない: K6/4 は R5（K6/4:196）で seed を製品の規則に固定し、批准 9（K6/4:36）で G-case の fixture と setup の変更（seed の pin を含む）を K6/4 の外に置き、「要るなら CP-0 と `g01-eval-revision` の側で扱う」とした。`graph-eval-procedure` の新版（K6/5）は、手順を変える選択肢 B を選ぶ場合だけに要る。`g01-eval-revision`（K6/2。事前の確認だけで `confirmedRef` は none。l6-l9:217）は、G-01 の R と R+IR の観測が期待と違ったときの評価の改訂（区分 1・2）で、G-02〜G-08 を含まず、期待値も指標も変えないこの変更の主題ではない。(3) この変更の主題は、凍結した G-case（`evals/nir1-graph/freeze.v1.json` が束縛する G-01〜G-08）の setup が、fixture の宣言した manual seed を製品の seed の規則でどう実現するかで、K6/4 のいう「CP-0 の側」にあたる。新しい contractId にし、確認済みの行を開き直さない |
| baseline | 確認済みの行は無い。材料の正本は、CP-0（#639）が凍結し CQ-LIM-4（#678）が凍結し直した `freeze.v1.json`（`6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`）と、それが束縛する file（「変えないもの」）、候補 §7（G-01 の設計） |
| 前提 | K6/4 は確認済み（2026-10-26、Session B5。l6-l9:187-197、219）で、凍結（`claude/nir1-contracts` への commit）は未了。R5 の照合（`assertSeedPinsBeforeK64`）は K6/4 の凍結の前の前提（K6/4:196、317）。K2/4 は確認済み（l6-l9:147-152、222-223）で、観測前の commit（K2/4 の addendum）は未作成。CP-4 は dev fixture でだけ実機の予告を取り、凍結した G-case の setup を runner に繋いでいない（cp4:592 DR-CP4-F-9、:594 DR-CP4-F-11 の (3)(4)） |
| 用語 | 「問いの Scene」= fixture の `query.sceneId`（G-02 なら `g02-query`）。「予定の seed」= G-02〜G-08 の `manualSeed.entityId`、G-01 の `entitySeed.id`（`g01-orin`）。「seed の pin」= 問いの Scene から予定の seed への `scene_codex_pins` の行。「製品の seed」= `selectNir1GraphSeed`（renderer）と `read_nir1_graph_seed_in_tx`（Native）が返す値。runtime の ID は writer が発行し、setup の receipt で論理 ID に対応付ける（各 fixture の `measurementBoundary.runtimeSetup`） |
| 変えないもの | `freeze.v1.json` が束縛する file の bytes（G-01 `evals/nir1-g01/fixture.v1.json` `996ef1c0…`、G-02 `c9e9ea0c…`、G-03 `39aec43a…`、G-04 `4d002261…`、G-05 `52c5ac72…`、G-06 `acb55cbd…`、G-07 `385eaa73…`、G-08 `0415561e…`、manifest `6958613f…`、schema `2ffd7591…`、README `fed96a76…`、独立期待値レビュー `188a679a…`。2026-10-27 に `freeze.v1.json` の値と一致することを再計算した）。query、corpus、seed（予定の seed は fixture のまま）、Gold、順序、指標、期待値、前提条件、`setupOrder` の文、`setupTimeline`、`measurementPoint`、variant。K6/4 の値と規則（D 10.84 ms、W_f 100 ms、T_late 100 ms、T_show 2 s、1%、F1〜F7、X1〜X13、R1〜R8、受入れ）。K2/4 の addendum の内容。製品のコード（seed の規則、requalification、Graph の対応付け、Raw と IR）。P、24 件の seed 方針（manifest の `existingRetrievalSeedPolicy`。manual seed なし） |

## 判断を求める点

推奨のまま承認すれば推奨が確認され、推奨と違う選択は新しい draftRef で起案する。

| # | 論点 | 推奨 | 代案 | 批准 |
| - | ---- | ---- | ---- | ---- |
| 1 | seed を製品にどう渡すか | (A) 凍結の bytes を変えず、setup の addendum で問いの Scene に seed の pin を 1 つ足す | (B) harness が fetch の alias で seed を渡す。(C) 何もしない。(D1) fixture を改版して凍結をやり直す。(D2) 製品に manual seed の入口を足す（「選択肢と推奨」） | 1、6、7 |
| 2 | G-01 を含めるか | 含める。候補 §7 の「唯一の pin」（:219-220、:237）は、Graph が Scene に対応付ける pin の数の記述として読み、問いの Scene の seed の pin はそれに数えない（seed 自身の pin は対応付けに使われない。候補:19 と `nir1_graph.rs:2396-2400`） | (a) G-01 を外す: R5 の照合は G-01 で取れないので、K6/4 の判定は G-02〜G-08 も含めて始まらない（K6/4:196 は G-case の各 query の照合を前提にし、`assertSeedPinsBeforeK64` の frozen の plan も G-01〜G-08 のすべてを求める）。G-01 を `g01-eval-revision` の新しい draftRef か G-01 の fixture v2（どちらも未起案）で扱うまで、Graph の評価全体が止まる | 2 |

## 事実（コードと材料の読取。`7a10dd11`）

### (a) seed の導出と、pin が無いときの経路

- renderer: `useNir1RelatedScenes` は、Graph の UI が有効なとき、世代ごとに `selectNir1GraphSeed(projectId, sceneId)` で seed を読み（`useNir1RelatedScenes.ts:247-256`）、seed が null でなければだけ `graphSeedEntityId` を fetch に渡す（:272）。`selectNir1GraphSeed` は、query の Scene の pin を、生きている同じ project の Scene と同じ project の Codex entry に join し、`created_at`、`entry_id` の昇順の最初の 1 件だけを使う。空・空白・200 UTF-16 超は null で、次の pin は試さない（`nir1GraphSeed.ts:19-53`）。子（`graph-ready` の取り直し）も同じ `run` で seed を読み直す。
- fetch: `graphSeedEntityId` は begin の要求にだけ載る（`fetchNir1RelatedScenes.ts:237-244`）。
- Native の begin: seed があるときだけ Graph の要求を owner に渡す。seed が無ければ owner にも応答にも触れない（`related_scenes/begin.rs:151-178`）。
- requalification: Graph の結果を返す前に、Native は query の Scene の最初の pin を同じ規則で読み直し（`read_nir1_graph_seed_in_tx`。`nir1_packing/graph_candidates.rs:222-256`）、Graph を作った seed と違えば `SeedChanged` で落とす（`nir1_graph/related_scenes_requalification.rs:970-976`）。
- `manualSeed` との関係: fixture の `manualSeed`（G-01 は `entitySeed.manualSeed`）は、評価の材料の宣言で、製品には manual seed の入口が無い。製品の seed は pin からだけ決まる。したがって、問いの Scene に pin が無いと、(i) hook の消費者では seed が null で Graph を要求しない（K6/4 の R5 のとおり全件が X7 か X12 で構造上 HOLD）、(ii) harness が seed を直接渡しても、requalification が `SeedChanged` で落とし `invalidated` になる（dev fixture で 4/4。cp4:433 DR-CP4-S1C2-26）。

### (b) pin は Raw と IR を変えるか — 変えない（コードの読取）

- query の文字列は、query の Scene の保存済み本文だけから作る（`fetchNir1RelatedScenes.ts:172-178`）。Native の query の源は `tree_nodes` の `content`、`version`、`updated_at` だけを読む（`grimodex-db/src/narrative_extraction/retrieval_admission/scene_source.rs:14-63`）。
- Raw の dense: 同じ query の embedding で Scene の chunk の索引を引く（`begin.rs:181-187`、216-218。`grimodex-semantic/src/runtime_audited_query.rs:162-224`）。Scene の chunk は `tree_nodes.content` から作る（`grimodex-semantic/src/index.rs:314-328`）。Raw の sparse: `fts_search` の `scenes` は `tree_nodes` の FTS（title と本文）だけを引く（`grimodex-db/src/fts.rs:63-100`、`src/features/chat/semanticRecall.ts:315-328`）。Raw の選択（`selectRelatedPastScenesWithAnchor`）の入力は dense と sparse の結果と Scene の順序で、pin を含まない（`fetchNir1RelatedScenes.ts:191-198`、278-282）。
- IR: Chronicle の Index の snapshot を資格判定して同じ query の vector で採点する（`related_scenes/scoring.rs:4-27`）。pin を読まない。
- `scene_codex_pins` を読む Rust の製品コードは、Graph の Scene の対応付け（`nir1_graph/scenes.rs`、`nir1_graph.rs` の `join_scene_pins`）、seed の読取（`graph_candidates.rs`）、requalification、project snapshot、migration だけで、Raw、IR、Chronicle の Index、Graph の Index の maintenance と B の seal、typed Revision の material には無い（`grep` で確かめた。試験の file を除く）。`upsertScenePin` が同時に書く `scene_codex_mentions`（source `relation`）を読む Rust の製品コードは本文の保存（`scene_body.rs`）だけで、検索の経路には無い。どちらの表にも trigger は無い（`migrate.rs`）。
- 結論: pin の追加は、R と R+IR の membership、順位、共通追加枠を変えない。凍結した期待値の前提（manifest の前提条件 `raw-membership`、`ir-supplement-admission`）も崩さず、再 freeze は要らない。ただしこれはコードの読取で、実測ではない。受入れの SP-P4 と SP-N7 で、pin のある写しと無い写しの R+IR を診断として比べる。
- 間接の違い（pin そのものでなく、seed が付くことによるもの）: seed つきの begin は Graph を要求し、D′ の保留と監査の書込みを足し、合流は Graph を待って D で公開する（K6/4 の「事実」）。R+IR の prefix は融合の規則で保たれる（manifest `runtimeComparison.order`）。これは凍結した期待値が前提にしていた状態で、この draft が新しく持ち込むものではない。seed つきの begin の遅い Raw-ready（cp4:454 の 2/30。原因不明）は P の側の事実で、P は seed の無い 24 件で測る。

### (c) pin は Graph の path と共通追加 1 枠を変えるか — 変えない

- Graph の Scene の対応付けは、hop 1 と hop 2 の到達 Entity の pin だけを列挙する（`rank_reached_entities` は `hop == 1` と `hop == 2` の node だけを取る。`nir1_graph.rs:2349-2384`。`join_scene_pins` の注は "The seed's pins never contribute"。:2396-2400）。seed は hop 0 なので、seed の pin は列挙されず、pin の行の予算（`SceneJoinBudget`）も使わない。先頭 8 件（N_F）、path の付加、共通追加 1 枠の候補は変わらない。
- README の「到達 Entity の pin の総数は 8 以下」（README:136）は hop 1 以上の Entity の pin で（README:127）、seed の pin を数えない。
- 期待値の Graph の DTO（`graph.nodes` の hop 0 の seed、`pathAttachments[].path.seedEntityId`）は、予定の seed から始まる Graph を前提にしている。seed の pin は、この前提を製品に渡すだけである。

### (d) 他の arm への影響

- R と R+IR の arm は、CP-4 では hook を mount せず、seed を渡さない製品の fetch で測る（cp4:585 DR-CP4-F-2）。この経路は pin を読まない。Graph の UI が無効の hook も pin を読まない（`useNir1RelatedScenes.ts:247-249`）。
- manifest の `comparison.sameInputs` は「case のどの arm も同じ query、corpus、manual seed、Scope、sealed setup」とする。seed の pin は case の workspace の setup に入るので、どの arm の workspace にも同じく置く（SP-N10）。
- 24 件の既存の query（manifest `existingRetrievalSeedPolicy`）と P、D-final（K6/3。D-final の診断は G-case の材料を使わない。K6/2 の「D-final での Graph の到達」）には触れない。

### (e) G-01 も同じ問題か — 同じで、加えて設計書の文に当たる

| case | 問いの Scene | 予定の seed | 問いの Scene の pin | 予定の seed への pin（どの Scene にも） | variant |
| ---- | ------------ | ----------- | ------------------- | --------------------------------------- | ------- |
| G-01 | `g01-query` | `g01-orin`（`entitySeed`） | なし | なし | v1 |
| G-02 | `g02-query` | `g02-orla` | なし | なし | base |
| G-03 | `g03-query` | `g03-wren` | なし | なし | base、frontier-exceeded |
| G-04 | `g04-query` | `g04-bren` | なし | なし | base |
| G-05 | `g05-query` | `g05-hale` | なし | なし | base |
| G-06 | `g06-query` | `g06-maro` | なし | なし | base |
| G-07 | `g07-query` | `g07-vesna` | なし | なし | base |
| G-08 | `g08-query` | `g08-odile` | なし | なし | base-usable、graph-index-unusable、graph-recovered、chronicle-index-unusable、both-indexes-unusable |

- G-01 の fixture は `pins` に `g01-mira → g01-mira-entity` の 1 件だけを持つ。候補 §7 は「唯一のpinは `g01-mira → g01-mira-entity`。…他Scene/seedへのpinは作らない。」（:219-220）、「Graph→Scene: 唯一のexplicit pinから`g01-mira`1件」（:237）と書く。seed の pin を足すと、:219-220 の文に字義どおりには当たる。一方、同じ候補の :19 は「seed自身のpinだけではG-01の1-hop寄与にしない」とし、製品でも seed の pin は対応付けに使われない（(c)）ので、:237 の「Graph→Scene」は seed の pin を足しても成り立つ。判断 2 はこの読み替えを求める。
- K6/2 の `g01-eval-revision` の区分 3 の条件「試験経路で `g01-mira` が唯一の pin から対応付かない場合」（K6/2:522 の要旨。候補の行の引用は `a153743b` の :235）も、seed の pin で `g01-mira` の対応付けが変わらないので、この段によって成り立たなくなることは無い（コードの読取）。
- unavailable を期待する variant（G-03 frontier-exceeded、G-08 の 3 つの unusable）も、Graph が要求されて上限超過や Index の状態で unavailable になることが期待の前提なので、seed の pin が要る（pin が無ければ Graph は要求されず、unavailable の原因が違う）。

## 設計

### seed の pin の段（G-01〜G-08 のすべての variant）

- 書くもの: 問いの Scene から予定の seed の Entity（setup の receipt で runtime の ID に対応付けたもの）への pin を 1 つ。書込みは製品の renderer の API `upsertScenePin(sceneId, entryId)`（`src/features/codex/sceneCodexPinsApi.ts:83-105`。UI の store と、fixture の pin を作る setup-driver〔`setup-driver.mjs:347-362`〕と同じ関数）だけで行う。SQL、注入した状態、試験専用の入口は使わない。この関数は `scene_codex_pins` と `scene_codex_mentions`（source `relation`、role `mentioned`）の 2 行を書く。
- 置き場（G-02〜G-08）: `setupOrder` の「foreshadows, foreshadow Codex links and pins」の段の直後、maintenance の有効化と `setupTimeline` の最初の step の前。`setupOrder` の文は書き換えず、この段は `setupOrder` の外の 1 段として addendum が挟む（K2/4:407 の宣言の段と同じ扱い）。`setupTimeline` の step にも `measurementPoint` にも数えない。G-08 の unusable の variant も同じ位置（mutation の前）。
- 置き場（G-01）: 候補 §7 の唯一の pin（`g01-mira`）を通常の writer で作った後、typed Revision の prepare と B の seal の前。
- 数: 問いの Scene の pin は、この 1 つだけにする。問いの Scene 以外の pin と、fixture の `pins` は変えない（足さない、消さない、順序を変えない）。
- workspace: manifest の isolation（case と variant ごとに新しい workspace）のとおり、variant ごとの workspace に 1 回ずつ書く。R、R+IR、R+IR+Graph の arm は同じ setup の workspace を使う（sameInputs）。
- K2/4 の宣言の段との関係: 互いの対象（問いの Scene の pin と、追加 Scene の宣言）が重ならない。宣言の writer は pin を読まず、veto の記録（foreshadow、Chronicle event、POV）に pin は無い（K2/4:409-411）。順序は、seed の pin の段を先にする（宣言の段は K2/4 のとおり pin の段の後で、Graph の arm の最初の query の前）。K2/4 の診断の負例「宣言しない run では R+IR+Graph が R+IR と同じ」（K2/4:416-417）は、seed の pin がある workspace で取ってはじめて Graph が要求された状態の負例になる。
- 記録（setup の receipt）: case と variant、問いの Scene と seed の論理 ID と runtime の ID、書込みの経路（`upsertScenePin`）、pin の `created_at`、段の前後の問いの Scene の pin の集合と workspace の全 pin の集合、段の前後の問いの Scene の `tree_nodes` の `version` と `updated_at`、Scene Scope の binding の v1 の列。

### G-01 の読み替え（判断 2）

候補 §7 の :219-220 の「唯一のpin」「他Scene/seedへのpinは作らない」は、Graph が Scene に対応付ける pin の数を固定する記述として読み、この段の seed の pin（問いの Scene から `g01-orin` への 1 つ）はそれに含めない。:237 の「唯一のexplicit pinから`g01-mira`1件」、Gold、期待値（R と R+IR は `[g01-question]`、R+IR+Graph は `[g01-question, g01-mira]`、excerpt、指標）、`g01-mira` の唯一の pin は変えない。これは `g01-eval-revision` ではない（評価の改訂でも区分の判定でもない）。判断 2 で (a) を選ぶと、G-01 はこの段の対象から外れ、R5 の照合は G-01 で mismatch のままなので、K6/4 の判定は G-02〜G-08 を含めて始まらない（`assertSeedPinsBeforeK64` の frozen の plan は G-01〜G-08 のすべてを求める。`seed-pin.mjs:25-27`、136-141）。

### addendum の file

- 別の file にし、観測前の commit（CP-4。K2/4:100 と同じ commit でよい）が作る。名前と置き場は観測前の commit が決める（例: `evals/nir1-graph/seed-pin-addendum.v1.json`）。`freeze.v1.json` が束縛する file にしない。`freeze.v1.json` の SHA-256 と各 fixture の SHA-256 を参照する。`scripts/quality/nir1-graph/contract.mjs` は `readdir` を使わない（`grep` で確かめた）が、新しい file で `pnpm eval:fixtures` が変わらないことは観測前の commit で確かめる。
- 中身: case と variant ごとに、問いの Scene の論理 ID、予定の seed の論理 ID（fixture の値をそのまま写す。起案者や harness が選ばない）、段の置き場、書込みの経路、受入れの SP-P1〜SP-P5 の確かめ方。K2/4 の宣言の addendum と同じ file に置く場合も、節を分け、K2/4 の内容を変えない。

## 選択肢と推奨

| 選択肢 | 効果 | リスク | 確認済みの条項との整合 | 必要な確認 |
| ------ | ---- | ------ | ---------------------- | ---------- |
| **(A) 推奨**: setup の addendum で問いの Scene に seed の pin を足す | 製品の seed が予定の seed になり、R5 の照合が match になりうる。Graph が要求され、requalification も通る。製品のコードと凍結の bytes は変わらない | pin が R／IR を変えないことはコードの読取で、実測は SP-P4 の診断まで無い。G-01 は候補 §7 の文の読み替えになる。setup の手順が fixture の外にも置かれ、材料が 2 か所になる | K6/4 の R5 をそのまま満たす（R5 は変えない）。K6/4 の批准 9 は「K6/4 の確認による」setup の変更を許さないもので、この draft は K6/4 のいう「CP-0 の側」の別の契約として扱う。K2/4 の addendum の形と同じで、K2/4 の内容に触れない。README の「観測した後に…seed…fixture…を変えない」は、Graph の観測の前の段で、予定の seed を変えないので当たらない（観測の有無は観測前の commit の reviewer が確かめる） | この draft の 1 回の承認 |
| (B) harness が fetch の alias で seed を渡す | 凍結の材料にも setup にも触れない | requalification が query の Scene の pin を読み直して `SeedChanged` で落とすので、製品のコードを変えない限り Graph は届かない（`related_scenes_requalification.rs:970-976`。dev fixture で 4/4。cp4:433）。製品の変更は seed の再検証（DSN §2.3 の返却時の再検証）を弱める | K6/4 の R5（seed は製品の規則で決まる）、In-scope attacks の 9（seed を pin でなく harness から渡す）、批准 9（K6/4 の名での製品の変更）に反する。cp4:585 DR-CP4-F-2 は harness が seed を渡す run を常に preview にした | K6/4 の新しい draftRef（K6/5）と、製品の requalification の変更の契約。採らない |
| (C) 何もしない | 何も変えない | Graph の arm は R5 で止まり、K6/4 の判定が始まらない。G-01 の正例、G-02／G-07／G-08 の追加 Scene、PUB-G に要る CP-4 の Graph の評価が止まる | どの条項にも反しない（K6/4:196 の「取れなければ判定を始めない」のまま） | 確認は要らないが、開示が要る |
| (D1) fixture を改版して凍結をやり直す（各 fixture の `pins` に seed の pin を入れた v2、G-01 の v2） | 材料が 1 か所にまとまる | 9 file と freeze の SHA-256 が変わり、独立期待値レビューと freeze をやり直す（README:211）。G-03 は CQ-LIM-4 で凍結し直した直後。K2/4 の addendum の参照先も変わる（K2/4:419）。日数が増える（未見積） | README の改版の手順に従う。期待値は変えない | 改版の draft と独立レビュー。A で R／IR が変わると分かった場合（SP-N7）の受け皿 |
| (D2) 製品に manual seed の入口を足す | fixture の `manualSeed` をそのまま渡せる | 新しい製品の入口と authority になり、seed の再検証の設計を変える | K6/4 の批准 9、PUB-G の範囲の外。新しい authority は委任の外（GDX-PRECHECK-001） | 新しい契約。採らない |

推奨の理由: A だけが、製品のコード、K6/4 の規則、凍結の bytes をどれも変えずに、K6/4 の R5 の前提を満たす。B は製品の seed の再検証を弱めないと動かない。C は Graph の評価を止めたままにする。D1 は A と同じ効果を、凍結のやり直しという大きい手間で得る。

## threat model（GDX-PRECHECK-001）

この draft は、新しい外への通信、受け手、保存先、authority、subprocess、背景の処理、async の lifecycle を足さない。書くのは評価の workspace の既存の表（`scene_codex_pins`、`scene_codex_mentions`）に、既存の renderer の API で 1 行ずつで、製品の DB の使い方と同じである。新しい契約なので委任の外で、確認されるまで draft とする。

- Trusted actors: 製品の `upsertScenePin`（書込み）と seed の規則（`selectNir1GraphSeed`、`read_nir1_graph_seed_in_tx`、requalification）。凍結した fixture の `manualSeed`／`entitySeed` の値。観測前の commit の addendum と、その独立 reviewer。
- Untrusted actors: harness の setup の手順（pin の宛先・数・時期を誤りうる）、harness が直接渡す seed、setup の receipt の自己申告（DB から読み直して照合する）。
- In-scope attacks: 1. 観測の後に seed を選び直す、または予定と違う Entity に pin を置く。2. 問いの Scene に複数の pin を置き、`created_at` の順で最初の pin を操作する。3. SQL や注入した状態で pin を書き、製品の writer を迂回する。4. 問いの Scene 以外に pin を足す、fixture の pin を変える（Graph の対応付けと期待値が変わる）。5. pin を Graph の arm の workspace にだけ置き、R と R+IR の arm と setup を変える。6. Graph の arm の観測の後に段を足す。7. harness が seed を直接渡した run を判定に使う。8. 段で凍結の bytes、期待値、前提条件、`setupTimeline` を変える。9. variant の一部（unavailable の variant）だけに pin を置く。
- Out-of-scope attacks（残余として開示）: 1. pin が R／IR を変えないことは、診断（SP-P4）の観測とコードの読取に依り、全ての入力で証明してはいない。2. setup の DB を書ける者は pin でも何でも書ける（評価の workspace の外の脅威。既存の評価の前提と同じ）。
- Mandatory defenses: 段と addendum を観測の前に固定し、独立 reviewer のレビューを受ける。受入れの SP-P1〜SP-P5 を各 workspace で確かめ、SP-N1〜SP-N14 を検出する。R5 の照合（`assertSeedPinsBeforeK64`）は DB から pin を読み直して行い（`workspace-db.mjs:169-194`）、receipt の自己申告を使わない。
- Acceptance implications: K6/4 の受入れ、閾値、規則と、凍結した期待値は変えない。この段は、K6/4 の判定が始まるための前提を満たすだけで、PASS の基準を弱めない。

## 受入れ

番号は `SP-` を付ける。

Positive:

- SP-P1: 各 variant の workspace で、問いの Scene の pin はちょうど 1 つで、その entry は予定の seed の runtime の ID、問いの Scene は生きていて、entry は同じ project の Codex entry である。DB から読み直した `productSeedOf` が予定の seed と一致する。
- SP-P2: workspace の全 pin の集合は、fixture の `pins`（runtime の ID に対応付けたもの）と seed の pin 1 つの和に等しい。段の前後で、問いの Scene の `tree_nodes` の `version` と `updated_at`、Scene Scope の binding の v1 の列、tree の順序、registry が変わらない（`upsertScenePin` は `tree_nodes` を書かない。`sceneCodexPinsApi.ts:83-105`）。
- SP-P3: R5 の照合: `assertSeedPinsBeforeK64({ plan: "frozen", cases })`（`seed-pin.mjs:127-155`）が `match` を返す。`cases` は G-01〜G-08 を 1 行ずつで、`expectedSeed` は setup の receipt で予定の seed に対応付けた runtime の ID、pin の行は `readQuerySceneSeedPins` で製品の DB から読んだもの。今の関数は case ごとに 1 行だけを受けるので、variant が複数ある G-03 と G-08 は、variant ごとの workspace の照合（SP-P1）の記録を別に残し、どれか 1 つでも match でなければ全体を match にしない（実装の形は CP-4 が決める）。
- SP-P4: 診断（判定に使わない。Graph の arm を動かさない）: G-02〜G-08 の base（G-08 は base-usable）と G-01 で、seed の pin の段の前の workspace の写しと後の写しで、seed なしの R+IR の arm を同じ手順で測り、R の membership と順位、begin の `denseHits` の Scene の並び、sparse の Scene の並び、R+IR の membership と順位と共通追加枠が一致する。
- SP-P5: Graph の arm の親の begin に `graphSeedEntityId` として予定の seed が載り（hook の消費者の記録。cp4:585 DR-CP4-F-2 の fetch の記録）、requalification が `SeedChanged` で落とした記録が無い。

Negative（どれも、その workspace のこの段を使った評価をしない。`[precheck]` で止める）:

- SP-N1: pin の entry が予定の seed でない（mismatch）。
- SP-N2: 問いの Scene に pin が 2 つ以上ある（`created_at`、`entry_id` の順の最初が予定の seed でも、SP-P1 の「ちょうど 1 つ」に反する）。
- SP-N3: 最初の pin が別の Entity で、2 つ目が予定の seed（mismatch。製品は次の pin を試さない）。
- SP-N4: pin を `upsertScenePin` 以外（SQL、注入、試験専用の入口）で書いた、または書込みの経路の記録が無い。
- SP-N5: 問いの Scene 以外に pin を足した、fixture の pin を変えた（SP-P2 に反する）。
- SP-N6: 段を Graph の arm の最初の観測の後に入れた、または「設計」の置き場と違う位置に入れた。
- SP-N7: SP-P4 の診断で、段の前後の R か R+IR が違う。この draft の前提（(b)）が崩れるので、addendum を使わず、integrator がユーザーに返し、凍結のやり直し（D1）を別の draft で提案する。
- SP-N8: 段が凍結した bytes、期待値、前提条件、`setupTimeline`、`measurementPoint` を変えた（`freeze.v1.json` の SHA-256 の照合が通らない、または addendum の差分の reviewer が検出）。
- SP-N9: 問いの Scene が archive されている、seed の entry が別の project にある、entry の ID が空白か 200 UTF-16 を超える（製品の seed が null）。
- SP-N10: case の arm の間で pin の集合が違う（Graph の arm の workspace にだけ pin がある）。
- SP-N11: unavailable を期待する variant（G-03 frontier-exceeded、G-08 の 3 つの unusable）に pin が無い。
- SP-N12: harness が seed を直接渡した run（`direct-fetch-preview`）を判定に使った（K6/4 の In-scope attacks の 9。cp4:585 DR-CP4-F-2 の検証）。
- SP-N13: R5 の照合を setup の receipt の自己申告で行い、DB から読み直していない。
- SP-N14: 判断 2 で (a)（G-01 を外す）を選んだのに G-01 に pin を置いた、または推奨（含める）を選んだのに G-01 の段が欠けた。

観測前に固定するもの: addendum の file（各 case と variant の問いの Scene と予定の seed、置き場、経路）、参照する `freeze.v1.json` と各 fixture の SHA-256、SP-P1〜SP-P5 の確かめ方と SP-P4 の診断の手順（測る arm、比べる field）、SP-N1〜SP-N14 の検出の方法（CP-4 の合成の記録で検出力を示す）。CP-4 は、合成の記録で SP-N1〜SP-N5、SP-N9〜SP-N13 を期待どおりに分けることを、観測の前に示す。

独立 reviewer に見せるもの: この draft、凍結した fixture と `freeze.v1.json`、addendum、K2/4 の addendum（重ならないことの確認）、(a)〜(c) の根拠のコードの行（`nir1GraphSeed.ts`、`useNir1RelatedScenes.ts:247-272`、`begin.rs:151-218`、`scene_source.rs:14-63`、`fts.rs:63-100`、`scoring.rs:4-27`、`nir1_graph.rs:2349-2400`、`related_scenes_requalification.rs:970-976`、`graph_candidates.rs:222-256`、`sceneCodexPinsApi.ts:83-105`）、`seed-pin.mjs` と `workspace-db.mjs` の照合の関数。reviewer が確かめるのは、予定の seed が fixture の値をそのまま写したこと、pin が R／IR／Graph の対応付けを変えないというコードの読取、段が凍結の bytes と期待値を変えないこと、G-case の Graph の arm の観測がまだ無いこと（cp4 の記録の上では無い。cp4:594 DR-CP4-F-11）。reviewer は G-case の Graph の runtime の出力を見ない。

## 影響が及ぶ既存の契約と台帳の行（どれも消さずに残す）

| 対象 | 行 | 扱い |
| ---- | -- | ---- |
| K6/4 `nir1-final-request-eval-proposal/4#graph-eval-procedure` | l6-l9:187-197、219。K6/4:36（批准 9）、196（R5）、207（In-scope の 9）、292（確かめられなかったこと 8）、302（H4）、317（凍結の順序） | bytes と確認の範囲を変えない。R5 の照合を満たす手段を与えるだけ。批准 9 の「CP-0 の側で扱う」の受け皿がこの draft であることを、確認後の記録の注に書く |
| K6/2 `g01-eval-revision` | l6-l9:217。K6/2:520-603 | 確認せず、変えない。G-01 の seed の pin は評価の改訂ではない。区分 3 の条件（`g01-mira` の唯一の pin からの対応付け）は seed の pin で変わらない |
| K6/2 `graph-eval-procedure`（/2） | l6-l9:218 | 変えない（/4 の読み替えのまま） |
| K2/4 | l6-l9:147-152、222-223。K2/4:386-420（addendum） | 変えない。seed の pin の段は K2/4 の addendum と別の段で、K2/4 の宣言の段の前に置く。同じ観測前の commit に入れてよい |
| CP-0 の凍結 | `freeze.v1.json`（#639、#678） | bytes を変えない。setup の読み方を足すだけ |
| 候補 §7 | :19、:189、:213、:219-220、:237 | 判断 2 を推奨のまま確認すれば、:219-220 を問いの Scene の seed の pin についてだけ読み替える。本文は書き換えない |
| 台帳の CP-4 の行 | l6-l9:561 | 開始条件に「SP/1 の addendum と R5 の照合の match」を足す提案（確認後の記録） |
| 続行計画 | cont:624、626（§10.7 の「G-case の seed の pin の照合」）、cont:649（§11 の K6/4 の残り） | 確認後の記録で、照合の手段がこの draft になったことを足す |
| CP-4 の判断の記録 | cp4:433（DR-CP4-S1C2-26）、585-586（DR-CP4-F-2、F-3）、594（F-11 の (3)） | 変えない。lane の記録として、この draft の確認の後に追記する |

## 確かめられなかったこと

1. pin が R と R+IR を変えないことの実測（SP-P4 の診断はまだ無い）。根拠はコードの読取だけ。
2. 凍結した G-case の setup を実 Electron で作ること（setup-driver は dev fixture だけを扱う。cp4:592、594）。
3. G-case の Graph の arm がこれまで観測されていないこと（cp4 の記録の上では無いが、全ての run を確かめてはいない）。
4. 新しい addendum の file で `pnpm eval:fixtures` が変わらないこと（実行していない）。
5. 候補 §7 の :220「他Scene/seedへのpinは作らない」の起案時の意図（seed の pin を禁じる趣旨か、Graph の対応付けに使う pin を 1 つに限る趣旨か）。記録は見つけていない。
6. `assertSeedPinsBeforeK64` を variant ごとの workspace に当てる形（今の関数は case ごとに 1 行）。
7. seed つきの begin の Raw-ready の遅い外れ値（cp4:454）が G-case で起きる頻度（P の側の事実で、この draft の判定には使わない）。

## 確認の扱い

- 確認は、台帳の Confirmation protocol（l6-l9:262。2026-10-25 の緩和の後）に従い、`nir1-graph-case-seed-pin-proposal/1` と `graph-case-seed-pin-setup` を曖昧さなく特定するユーザーの明示の承認で行う。推奨と違う選択は新しい draftRef で起案する。
- この draft は続行計画 §12.1 の「重要な変更」の暫定の定義には直接当たらない（閾値の緩和でも新しい受け手でもない）が、新しい契約で、凍結した評価の材料の setup と候補 §7 の文の読みを変えるので、GDX-PRECHECK-001 の委任の外（"new contracts or authorities"）として、ユーザーの確認を求める。
- 依存する契約（K6/4、K6/2、K2/4）は確認されず、変わらない。計画への同意、merge の指示、包括的な返答は確認として扱わない。
- 確認を求めるときは、(a)〜(e) の事実の要約と、判断 1 と 2 の推奨を添える。

## 確認後の記録（この draft の外で行う。台帳への取り込みの提案）

- 台帳の補足: 受信の日時、承認の逐語、提示した `draftRef#contractId` と SHA-256、取り込んだ draft の SHA-256。「承認の範囲と効力」（冒頭の 1〜8。承認の直後から効く）と「SP/1 が許さないもの」（批准 8）を書く。
- 確認台帳の行: `graph-case-seed-pin-setup` を新しく足す。confirmedRef は `nir1-graph-case-seed-pin-proposal/1#graph-case-seed-pin-setup`、startStatus は、観測前の commit と R5 の照合の match までは `blocked`。
- K6/4 の注の下に「K6/4 の批准 9 が『CP-0 の側』とした G-case の seed の pin は、SP/1 の addendum で扱う。K6/4 の bytes と R5 は変わらない」を足す。
- l6-l9:561（CP-4）の開始条件に「SP/1 の addendum を観測前の commit に入れ、R5 の照合が match になること」を足す。
- 判断 2 を推奨のまま確認した場合は、候補 §7 の :219-220 の読み替えの注を、候補の文書には書かず台帳の注に置く（候補の本文は変えない）。
- CP-4 の TASK: 「設計」、受入れ、独立 reviewer に見せるものを写す。

## 確認文

contractId の選択: **`graph-case-seed-pin-setup`**（新規）。

- 理由: 「前書き」の「系列の判断」。確認済みの行（K2/4、K6/4）を開き直さず、K6/4 の R5 と批准 9 をそのまま満たす。

承認の例（固定の文でなくてよい。draftRef と contractId を名指すか、integrator が直前に SHA-256 つきで示したこの 1 行への承認の返答であればよい）:

- I confirm draftRef nir1-graph-case-seed-pin-proposal/1 for contractId graph-case-seed-pin-setup.

## この draft の SHA-256 の取り方

この file の SHA-256 は、この file に書くと bytes が変わるので、ここには書かない。commit の後に次で計算し、台帳と提示の問いに書く。

```sh
git show <commit>:docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md | sha256sum
```
