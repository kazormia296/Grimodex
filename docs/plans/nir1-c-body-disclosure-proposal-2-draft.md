# NIR-1 C-body 契約提案 proposal/2（draft）: Graph が追加する Scene の本文開示と Scene Scope v2

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-c-body-disclosure-proposal/2` |
| contractId | `graph-target-scene-body-disclosure`（新規）、`scope-storage-authority`（proposal/3 の確認済み行への差分。Scene Scope v2 の保存） |
| 起案日と基点 | 2026-10-12。origin/master `a153743b`（Tree `023f6fbc`）。`l6-l9:N` は [L6〜L9 実行計画](nir1-l6-l9-execution-plan.md)、`post-B` は [残工程実装計画](nir1-post-b-execution-plan.md)、`候補` は [Scene 接続候補](nir1-c-scene-connection-candidate.md) の、この commit での行番号と節。コードの行番号も同じ commit のもの |
| 整合を取った文書 | [DSN](nir1-dsn-2026-10.md)（未 commit。sha256 `3dfe1f03…` の版。節で引く）。ただし DSN の §1.5（理由の集合）、§2.3（all-or-nothing の範囲）、§7.2（`GRANT_REQUIRED_COMMANDS`）、§7.3（`BodyDeclaration` の binding と消費する writer）は、この draft の記述と食い違う。この draft を優先し、DSN は確認後に改める（「確認後の記録」）。[K1](nir1-l6-l9-contract-proposal-6-draft.md)（`nir1-l6-l9-contract-proposal/6`。2行とも 2026-10-12 23:58 JST に確認済み。commit `ba7ceb46`、sha256 `5528f4e0…`）。G-01 の fixture `evals/nir1-g01/fixture.v1.json`（sha256 `996ef1c0…`）。SPIKE S1 の報告（2026-10-13、作業記録。下の C14） |
| 確認済み baseline | `nir1-l6-l9-contract-proposal/3#scope-storage-authority`（l6-l9:97、:110-119）。関連する確認済み行: /3 の `caller-profile-egress`、/4 の `typed-revision-material`、/6 の `graph-limited-binding`（K1。/5 の資源の値を改訂した行）と `nir1-defensive-resource-limits`（K1b） |
| 確認を求めるもの | Option B（作者が本文全体を宣言する）の2行。Graph が Related Scenes に追加する Scene の本文を開示する authority と、その宣言を保存する Scene Scope v2 の差分 |
| 変えないもの | Gold、G-01 の fixture v1 と指標、P の固定値、K1 の値、proposal/3〜6 の他の条項、R と R+IR の結果、Graph と local 送信の製品入口（A-1。閉じたまま）。AI 送信、Packing、履歴、export には開示しない |
| /1 の扱い | `nir1-c-body-disclosure-proposal/1`（2026-09-25 の Codex draft、sha256 `904adad5…`）とその確認の記録は、U1 により参照にとどめる。この draft は /1 の文面を使っておらず、/1 の確認をこの draft の根拠にしない |

断りがなければ、コードの場所は `src-tauri/crates/grimodex-db/src/` からの相対パス。

用語: **Graph-only target** は、Graph の path が到達した Entity に pin された Scene のうち、R+IR の結果にないものを指す。Related Scenes の共通追加1枠に入りうる（l6-l9:506、DSN §2.3）。R+IR にすでにある Scene には、この draft の判定を使わない（既存の excerpt と anchor のまま。Graph は path の Evidence を足すだけ）。

## 要点

- 推奨は Option B。作者が Scene の本文全体（title を含む）について開示の宣言をし、Main の一回限りの確認を経て Native が保存する。Graph-only target は、宣言が current で、利用時の判定をすべて通ったときだけ、title、本文の先頭の非空行の excerpt、その anchor への遷移を出す。
- v1 で宣言できる値は G-01 subset（story・auto・phase は independent、reveal は non-secret、POV は independent）だけ。ほかの値は writer が拒否し、reader は unavailable にする。
- 本文は worker ではなく parent が読む。frame の token と宣言の束縛に exact に一致することを確かめてから読み、query ごとに最大1件にする（DSN §2.3）。
- Graph-only の候補が不適格なときは、判定のどこで外れても、上限を超えても、追加1枠を出さないだけにする。R+IR とその path の付加は変えず、renderer へ返す理由は候補がない場合と同じ1つの code にする（DSN §2.3 の all-or-nothing を R+IR の path の付加に限る。K1 の C-body の fail-safe と同じ）。
- veto に使う記録は、target に掛かる secret の foreshadow、target を reveal の Scene に指定したか target に結ばれた secret な Chronicle event、Scene と beat の POV である。
- 宣言は、本文、title、A1、incarnation、workspace のどれかが変わると、束縛の不一致で失効する。timeline、worldline、layer の registry を変えると、project のすべての宣言が失効する。restore、import、Safe Mode からの restore は、Ready の前に宣言を消す。宣言の操作（宣言、取消、クリア）は行の宣言の2列だけを書き、v1 の列（version、token、`updated_at` を含む）を書き換えない。feed も A1 とは別の object kind で書く。このため、承認済みの Revision を巻き込んで失効させず、pending にもせず、Index の Freshness も dirty にしない（C15）。
- 宣言を書く COMMIT の結果が分からなければ、exact な識別子で読み直す。それでも決まらなければ、その workspace での宣言の書込みと開示を再起動まで止める。pending marker は作らない。
- PUB-G までは、宣言の入口（preview、宣言、取消）を Native の gate で閉じる。PUB-G より前に開くのは、評価用の CI seam が有効な起動だけである。この seam の owner token と nonce は秘密ではないので、packaged でない起動で env をそろえた者は、ダイアログなしで宣言を承認できる。これは残余として受け入れる（その者は DB を直接書ける。`graph-target-scene-body-disclosure` の Out-of-scope）。
- G-01 の正例は、この2行に加えて、B の sealed binding を正規の経路で確立できること（計画の B-ROUTE）に依存する。S1 で、製品にその経路がないと分かった（C14）。確立できなければ、宣言があっても G-01 は Hold のまま（候補 :240-241）。
- Option A（fail-closed のまま、G-01 の評価を改訂する）は、Graph の公開を3日前後早めうる。ただし NIR-1 の完了（E）は早まらず、Graph が新しい Scene を見つける機能を失い、評価契約の改訂という別の確認が要る。

## 確認の扱い

- 確認は contractId ごとに、末尾の「確認文」の 1 文で行う（l6-l9:108）。1 文で確認されるのはその contractId の行だけで、もう一方の行や依存する契約は確認されない。
- 2文はどちらも Option B を確認する。Option B の実装には2文とも要る。`scope-storage-authority` だけが確認された場合は CB-1（保存とクリア）だけを始められ、宣言の writer（CB-2）と reader（CB-4）は始めない。
- Option A を選ぶ場合は、どちらの文も出さない。C-body は fail-closed のまま閉じ、G-01 の評価の改訂（指標の変更）を、contractId `g01-eval-revision` の新しい draftRef として観測前に起案して確認する。K6 の draft（`nir1-final-request-eval-proposal/1`）の同じ行は S1 による改訂だけを扱い、指標の変更を含まない。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答は、確認として扱わない。2026-09-25 の確認の記録も、この draft の確認にならない（U1）。
- どちらの行も Graph の製品公開を許可しない。公開には Graph の製品公開条件（A3 + B + C + D2a、l6-l9:431）と Session C-1 の承認が要る。
- この2行の確認は、B-ROUTE（B の build を正規の経路に配線する）と CP-0 の harness（S1 の setup の取り込み、決定論の provider の G-01 の対応表の置き場所）を確認しない。どちらも各レーンで、確認済みの契約の範囲の中で進める（計画は B-ROUTE を proposal/5 と K1 の範囲内として確認不要と判断している）。G-01 の正例はそれらにも依存する（C14）。
- K1 の2行は確認済みである（上の表）。このため、C-body で足す上限の数値は、K1b の規則に従って integrator が実測から選び、PR に記録する（数値ごとの確認は要らない。緩めるには再確認を要する）。この2行の確認は K1 の行を変えない。
- 確認された行は、この draft の bytes の SHA-256 と確認文を台帳に記録する。本文は編集せず、内容を変えるときは新しい draftRef で起案する。

## 根拠: ユーザー決定（逐語）

2026-10-12 のセッションでの回答から、ユーザー自身の文言を写す。「この draft での読み方」は起案者の解釈で、ユーザーの発言ではない。

| ID | 対象 | 回答（逐語） | この draft での読み方 |
| -- | ---- | ------------ | --------------------- |
| U1 | 9/25-26 の承認と WIP | 「使わずに計画し直す」 | /1、その確認の記録、WIP の文面を使わず、最新 master を前提に起案し直す。WIP から移すコードは新しい候補として再試験・再レビューする |
| U2 | 2 MiB／8 ms | 「2MiB/8ms はキツすぎてCodexでは達成できませんでした。何かいい案があれば挑戦してもいいかもしれませんが、現状は達成不可能です。」 | C-body の資源を 2 MiB／8 ms に結び付けない（master にある旧 C-body の draft はこれを前提にしている）。資源は K1 に従う |
| U3 | #610 型の技術委任を NIR-1 の残レーン全体へ広げる（選択肢 1） | 「1でRalphを使ってやるかどうかは任せます。」 | 委任は技術判断に限られる。新しい authority、保存範囲の拡大、新しい信頼境界は委任の外なので、この2行はユーザーの確認を要する |
| U4 | 到達点 | 「merge まで進める」 | C-body を含めて merge まで進める。この2行が確認されなければ、G-01 の正例、PUB-G、E が止まる |
| U6 | 資源契約 | 「防御用の上限だけに簡素化（推奨）」 | C-body で足す上限は、`nir1-defensive-resource-limits`（K1b。確認済み）の規則に従う |

## 前提: 現行のコード（`a153743b`）

| # | 事実 | 根拠 |
| - | ---- | ---- |
| C1 | Graph-only target の本文は開示できない。A1 の binding（`narrative-scene-scope/1`）は timeline、worldline、layer、holder、audience だけを持ち、本文の story、auto、phase、reveal、POV を表す欄がない。`validate_scene_scope` は project の Scope authority、reveal、lifecycle を確かめないと明記している | `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs:84-97`、`narrative_extraction/nir1_graph/scenes.rs:498-562`、l6-l9:28 |
| C2 | v1 の token は A1 の状態、version、updated_at の digest。本文の保存、rename、AI Apply、bulk、順序と story time の操作、Codex の rename の波及、本文版と project snapshot の restore は、同じ transaction で v1 の version と token を進める。backup の restore は DB を丸ごと置き換えるので、v1 も本文も backup の時点の値に戻る | `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs:176-199`、`narrative_extraction/scene_scope.rs:563-610`。呼出し元は下の「失効」の表 |
| C3 | 本文の Source は、key `project:scene:<id>`、revision token `v{version}@{updated_at}`、storage digest、canonical digest、正規化の版、UTF-16 長で表される。上限付きの reader は Electron の Native の build だけにある（feature `native-current-human-capture`） | `narrative_extraction/retrieval_admission/scene_source.rs:14-62`、:63-80 |
| C4 | Graph-only target の excerpt の候補は、canonical な本文の先頭の非空行。G-01 の `g01-mira` の本文は1行なので `[0,78)` になる | `narrative_extraction/nir1_graph/scenes.rs:450-484`、`evals/nir1-g01/fixture.v1.json` |
| C5 | `narrative_scene_scope_bindings` は table 単位で保護され、generic SQL、MCP、renderer からは書けない。A1 の writer は期限なしで DB mutex を待つ（`db.with_conn`） | `policies/narrative/protected-writers.json:469-475`、`narrative_extraction/scene_scope.rs:1173` |
| C6 | LiveBinding の locator は、open の要求の path を Native がそのまま使い、`to_string_lossy` した文字列である。Native は canonicalize しないので、正規の形になるかは呼出し側の path に依存する（struct の comment は canonical と書いている）。workspace ID は `.grimodex/workspace.json` の id で、folder を複写すると同じ値になる。DB file の identity（dev と inode、volume と file index）は process の中の照合だけに使う | `electron/native/grimodex-node/src/workspace_lifecycle_view.rs:1026-1056`、`electron/native/grimodex-node/src/lib.rs:9876-9882`、`open.rs:1073-1082`、`workspace_lifecycle.rs:98-112`、`state.rs:86-111` |
| C7 | worker は本文を読まない。frame（DSN の NQG2 案）は Scene association として scene ID、incarnation、source token、scope token、pin の照合値、path を返す。parent が返却時と click 時に再検証する | DSN §2.1〜§2.3 |
| C8 | project の Scope authority の revision は、tree の各 node の version と updated_at、各 Scene の v1 の version と token を含む digest から作られる。A3 は Revision の Entity の `authorityRevision` がこれと等しいことを要求する。このため、どれか1つの Scene の v1 か tree の node を進めると（本文の保存はどちらも進める）、承認済みの Revision はすべて A3 で stale になる（コードからの導出で、実行では確かめていない） | `narrative_extraction/project_scope_authority.rs:188-212`、:255-263、`narrative_extraction/scene_scope.rs:680-820`、`narrative_extraction/nir1_entity_relation.rs:2353` |
| C9 | secret の判定に使える記録は2種類ある。(1) foreshadow: `foreshadows.secret`（新規の table では既定 1、既存 DB へ足した列では既定 0 なので、legacy の行は secret でない）、旧式の `foreshadows.payoff_scene_id`、`foreshadow_setups.scene_id`、`foreshadow_payoffs.scene_id`。(2) Chronicle event: `events.secret`（既定 0）、`events.reveal_scene_id`（秘密を明かす Scene の作者の指定）、Scene と event を結ぶ `scene_events`。secret な event は、書いている Scene が reveal の Scene より読む順で前の間だけ AI から隠される。reveal の指定がなければ、event を結んだ Scene のうち読む順で最初のものが reveal になる。POV の記録: `tree_nodes.pov_character_id`、保存本文の `sceneBeat` の `pov` 属性と、そこから導いた `scene_beat_pov_cache` | `migrate.rs:540`、:1526-1583、:1689-1690、:1755-1760、:2438-2505、:2522-2533、:3024-、`src/features/chronicle/chronicleSecrecy.ts:8-89`、`scene_body.rs:742-779`、`src/features/editor/sceneBodySnapshot.ts:148-154` |
| C10 | schema の版は 41。G-01 の fixture v1 は「実行結果を見た後に query、corpus、seed、Gold、順序、指標を変えない」と定める | `src-tauri/crates/grimodex-core/src/lib.rs:3`、`evals/nir1-g01/fixture.v1.json` の `observationPolicy` |
| C11 | feed の object kind は閉じた集合で、未知の kind の event は、検証、project の照合、canonical snapshot、Source の対応付けで拒否される。Revision の pending 判定は、検証に通らない event と Source の対応付けの失敗を `PendingUnknown` にする。kind が `scene-scope` か `scope-registry` の event は、内容によらず project の Scope authority の変更として扱われ、`scope-dependency:v1:` に依存する Revision を `PendingRelevantChange` にし、Scope authority の identity を freshness で dirty にする。A1 の writer の feed event は、`scene-scope` の kind で `scopeAuthorityChanged: true` を固定で入れる | `narrative_extraction/change_feed.rs:1699-1708`、:1827-1831、:1958、:3234-3259、`canonical_feed_snapshots.rs:427`、:640、`narrative_extraction/incremental_freshness.rs:3576-3578`、:3602-3633、:3701-3707、:3754-3760、`narrative_extraction/revision_eligibility/pending.rs:79-103`、`narrative_extraction/scene_scope.rs:612-626` |
| C12 | Scene の title は作者のデータで、AI Apply（Scene の作成と title の更新）と Codex の rename の波及でも書き換わる。AI Apply の writer は title が空でないことだけを確かめ、改行、制御文字、長さを制限しない | `domain_writes.rs:43-48`、:5218、:5245-5246、:842-862 |
| C13 | 検索の評価の setup と測定は、standard build（`pnpm napi:build` → `pnpm electron:build`）の receipt を必須にし、その build の製品 Main を起動する。評価に要る差し替えは、製品 Main の中の、env で gate された seam で行う。決定論の provider は packaged でない起動と exact な env の値を要し、maintenance の seam はさらに `CI=true`、owner token、起動ごとの nonce を env で要して、使ったことを Main の receipt に残す。owner token は source にある公開の定数（`c2-5b-product-journey-owner-v1`）との一致を見るだけで、nonce は形式が UUIDv4 なら任意の値でよい。どちらも秘密ではない。P の paired harness は、setup の DB だけを別の path に書き出して開く | `scripts/quality/setup-nir1-retrieval.mjs:66-76`、`scripts/quality/run-nir1-retrieval.mjs:145-172`、`docs/plans/nir1-standard-build-producer.md:3`、`electron/main/productJourneyAi.ts:74-84`、`electron/main/narrativeMaintenanceCiSeam.ts:60-61`、:267-275、:282-348、:369、`scripts/quality/nir1-retrieval/paired.mjs:106-128` |
| C14 | SPIKE S1（2026-10-13、`a153743b`）は、standard build と同じ command の build、pin 済みの model、通常の writer、決定論の provider で G-01 を setup し、R＝R+IR＝`[g01-question]`（共通追加枠は未使用）を実 runtime で観測した。(a) IR の Index は fresh だったが、query との cosine 0.61294 が英語の IR floor 0.66 を下回り、IR は空で、結果の基底は `raw` だった（候補 :233 の「IR は control への付加」とは違う）。(b) B の Graph index を publish する呼出しは試験と診断用のコードにしかなく、製品の経路で B の sealed binding を確立できない（候補 :215-216 の setup を満たせない。計画は B-ROUTE を追加した）。(c) 決定論の provider の対応表は 24 件の corpus だけを読み、本文が一致する Scene にしか答えないので、G-01 の本文には答えない。S1 は setup 専用の Main で import を1つ差し替え、計測には差し替えのない main を使った。(d) S1 の setup では、全 Scene の story_time_order が NULL、POV は未設定で、A1 は初期値（compatibility marker が unknown、registry が空）から明示に設定した。setup の選択（Scope の ref、query の Scene の title など）は観測の前に固定した（S1 の `SETUP_DECISIONS`、preregistration `c6739191…`） | S1 報告 §1〜§5、§8。`policies/narrative/nir1-related-scenes-ranking.json:4`、`electron/native/grimodex-node/src/related_scenes/scoring.rs:79-84`、`src/features/related-scenes/nir1RelatedScenesFusion.ts:26-27`、`narrative_extraction/nir1_entity_relation_index.rs:2335`、`narrative_extraction/nir1_capacity.rs:1084-1119`、`electron/main/productJourneyNir1Ai.ts:1`、:40-41、`scripts/quality/nir1-retrieval/setup-evidence.mjs:96` |
| C15 | v1 の token は、行の `updated_at` を入力に含む（C2）。v1 の binding を読む経路は、行の列から token を計算し直して保存値と照合する。(1) `read_binding_in_tx` は、違えば `NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID` で失敗する。これを通るのは、A1 の reader と writer、`scene-scope` の kind の feed の snapshot（v1 の DTO で、`updatedAt` を含む）、source token の refresh（本文の保存、rename、AI Apply、bulk、順序の操作、本文版と project snapshot の restore が同じ transaction で呼ぶ）、registry の変更（project のすべての binding を読む）、削除した Codex の人物を journal から戻すときの A1 の無効化である。(2) project の Scope authority の digest は、照合に外れた行を `unavailable` の項目に置き換え、照合に通った行は `updatedAt` を含めて入れる。(3) material の Scope の読取は、照合に外れた Scene を unavailable にする。既存の writer は、行を書き換えるときにどれも `updated_at` も書き換える。このため、token を計算し直さずに `updated_at` だけを書き換えると、その Scene の本文の保存、A1 の読み書き、project の registry の変更が失敗し、project の Scope authority の revision が変わる（C8 により承認済みの Revision は A3 で stale になる）。token も計算し直せば、v1 の token を進めたことになる。どちらもコードからの導出で、実行では確かめていない | `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs:84-97`、:176-199（:196）、`narrative_extraction/scene_scope.rs:249-329`（:316-320）、:339-384、:386-393、:563-610（:575-576、:585）、:680-820（:772、:792-807）、:1023-1124（:1066、:1087）、:1178、:1240、:1379-1380、:1419、:1749-1759、`scene_body.rs:802`、`agent_writes.rs:2750-2756` |

## graph-target-scene-body-disclosure（新規）

- Baseline (approved; limited): この contractId に確認済みの行はない。Graph-only target の本文は fail-closed で、l6-l9:28 の HOLD（「作者宣言などの未確定契約は明示確認後」）にある。確認済みで関連する行は、どれも Graph-only target の本文を開示する根拠にならない。/4 `typed-revision-material` が扱うのは path の Entity／Relation と、Codex の名前・要約の Evidence だけである（l6-l9:136）。/3 `scope-storage-authority` は A1 の保存（l6-l9:110-119）、`graph-limited-binding`（/5。資源の値は K1 の /6 で改訂済み）は Graph の binding と資源を扱う。Graph の製品入口は閉じている（A-1）。master にある旧 draft 2 本（`nir1-c-scene-body-disclosure-delta-draft.md`、`nir1-c-target-scene-body-authority-proposal-draft.md`）は確認の対象になったことがなく、論点の参照にとどめる。
- Delta (C-body authority / disclosure / lifecycle; proposal/2 draft): 作者による本文全体の宣言を、Graph-only target の本文を開示する唯一の authority として新しく置く。宣言は、Main の一回限りの確認を経て Native writer だけが保存する（保存は `scope-storage-authority` の行）。利用時は parent の reader が判定する。開示するのは、Related Scenes の共通追加1枠に出す title、本文の先頭の非空行の excerpt、その anchor への遷移だけで、AI 送信、Packing、履歴、export には使わない。v1 で宣言できる値は G-01 subset に限る。返却時と click 時に再検証し、Graph-only の候補の失敗は追加1枠を出さないことだけにとどめる（R+IR とその path の付加は変えない）。PUB-G までは、宣言の入口を Native の gate で閉じる。COMMIT の結果が分からなければ読み直し、決まらなければ再起動まで quarantine する。pending marker は作らない。資源は K1 に従う。詳細は下の節。
- Trusted actors:
  - Native の reader と writer（grimodex-db の Scene Scope の writer と parent の target 本文 reader、grimodex-node の Related Scenes と C-query の製品 owner）。
  - Main（確認ダイアログ、sender と window の束縛、grant の発行）。
  - Main のダイアログを確定した操作者。これを作者とみなし、その宣言を本文全体の分類として信じる。これは新しい信頼仮定で、宣言の内容が真であることは検証しない。
  - 評価用の CI seam が有効な起動では、その起動の env を設定した runner（評価の harness）を、ダイアログを確定する操作者の代わりとみなす。seam が有効になるのは、packaged でない起動で、`CI=true`、owner token、起動ごとの nonce が env にそろったときだけである。ただし owner token は source にある公開の定数で、nonce は形式が UUIDv4 なら任意の値でよいので、どちらも秘密ではない（C13）。これらは誤った起動で偶然に有効になることを防ぐ印にとどまり、認証にはならない。実効的な境界は、packaged でないことと、その起動の env（`CI=true` を含む）を設定できることである。したがって、ここで信じているのは「packaged でない起動の env を設定できる者」で、その残余は下の Out-of-scope の最初の項目に書く。評価では standard build の receipt と組にする（下の「Main の一回限りの確認」）。
  - 既存の authority（live な project Scope authority、A1 の binding、A2／A3、B の seal、workspace の lifecycle Core）と、SQLite の transaction の原子性。
- Untrusted actors:
  - renderer が渡す値のすべて（宣言の値、Scene ID、token、digest、excerpt、eligible の申告、navigation handle の再送、宣言の ID や時刻）。
  - model の出力と、AI Apply が書いた本文。MCP、generic SQL、A1 の保存の経路。
  - worker の frame。NQG2 の association は候補で、parent が確かめるまで信用しない。
  - 次 query 用の cache と、表示中の結果。
  - restore、backup、import で戻ってくる DB の中身（過去の宣言を含む）。workspace の複写や移動、symlink、path の綴りの違い。
  - 派生した記録（`scene_codex_mentions`、`scene_beat_pov_cache`）を、本文の分類を認める根拠に使うこと。
  - lifecycle の edge と COMMIT の時間的な重なり。
- In-scope attacks:
  - renderer、MCP、model、A1 の保存の経路による宣言の偽造。eligible や excerpt の申告。
  - 確認の偽造、再送、別の窓での流用。期限切れ、OCC の変化、digest の不一致のある古い確認の利用。同時に開いた確認の取り違え。
  - title や本文に由来する文字列による、確認のダイアログの文面の偽装（改行、制御文字、双方向の制御、長い title、固定の文言をまねた title）。
  - 評価用の承認の seam を、通常の起動、packaged の起動、renderer から使うこと。PUB-G の前に、通常の起動で宣言の入口（preview、宣言、取消）を使うこと。
  - 宣言の後の変更（本文の編集、AI Apply、bulk、rename、A1 の変更、POV の設定）の後に、古い宣言で開示すること。
  - restore、import、複製、ID の再利用、workspace の複写や移動による宣言の持ち越し。同じ bytes や同じ token（`v{version}@{updated_at}` の ABA）による救済。
  - 片方の列だけの宣言、未知の版、未知の欄、token の不一致など、壊れた宣言の利用。
  - 宣言で A1 を緩めること。unknown、legacy、unresolved を any として扱うこと。reading の順が query と同じか後の Scene の開示。
  - secret の foreshadow、secret な Chronicle event、POV の記録と矛盾する宣言による開示。
  - worker の snapshot と parent の読取の混用（frame の token が古い、pin の移動・削除・再挿入）。path の A3 を target 本文の根拠に流用すること。pin を本文の Evidence として扱うこと。
  - 返却の後、click の前の変更（TOCTOU）。
  - unavailable の理由、event、診断、cache を通じた、target の識別子、本文、候補の有無、veto の種別の漏れ。Graph-only の候補の失敗で Graph の寄与の全体や R+IR の path の付加を変え、それを通じて候補の有無を漏らすこと。excerpt が AI の request、Packing、履歴、export、audit に入ること。
  - COMMIT の結果が不明なときの誤った成功・失敗の判定。COMMIT と lifecycle の edge（restore、切替、shutdown）の競合。
  - 巨大な本文、多数の veto 行、巨大な宣言による OOM やフリーズ。取消の無視。
- Out-of-scope attacks:
  - OS、Main、Native、backend の侵害。同じ OS ユーザー権限で動く悪意ある process による DB の直接編集や、app を起動する env の設定（評価用の seam の有効化を含む）。seam の owner token と nonce は秘密ではないので、packaged でない起動（開発の起動と、評価で standard build を起動する場合）では、env を設定できる者が、PUB-G の前でも宣言の入口の gate を開き（Mandatory defense 10）、ダイアログなしで `BodyDeclaration` を承認できる。これを残余として受け入れる。その者は同じ権限で DB を直接書けるので、seam は新しい能力を与えない。packaged の起動では seam は働かない。
  - app の外での workspace の file の差し替え（同じ path への外部の restore、sync tool による置換）。この場合も宣言は束縛した本文の bytes にだけ当たるので、その範囲で作者の宣言として扱う。
  - 作者の宣言の誤り（本文に実は秘密がある、など）。veto は既知の記録との矛盾だけを拒否する。
  - 宣言した操作者の本人確認。解錠済みの端末で app を操作する人を作者とみなす。
  - 作者がエディタで Scene を開くことや、tree で title を見ること。通常の閲覧は変えない。renderer は project の tree（Scene の ID と title）をすでに持っている。
  - 意味の品質（excerpt が役に立つか）。
  - 処理時間の差（Graph の結果が D の窓に間に合うかどうか）から、Graph-only の候補の有無を推測すること。parent の判定は K1b の上限で有限にするが、時間を一定にはしない。
  - AI 送信、Packing、履歴、export の可否。それぞれの契約で扱い、この行はどれも開かない。
  - v1 で受け付けない値（条件付きの story、auto、phase、reveal の条件、特定の人物の POV）の意味の設計。
- Mandatory defenses:
  1. 開示の根拠は、`scope-storage-authority` の writer が Main の確認を消費して保存した宣言だけにする。renderer の申告、pin、path の A3、Relation の Evidence、本文の一致、派生した記録を根拠にしない。
  2. 開示は下の「開示の範囲」に限る。AI の request、Packing、chat の履歴、export、audit、event、診断、log、次 query 用の cache、永続の記録に、excerpt と判定の結果を載せない。診断に載せてよいのは、target を識別しない Native の allowlist の counter（件数だけ）に限る。excerpt や本文の digest、range、長さ、Scene ID は、Eligible の結果のものも診断に載せない。Eligible の結果の excerpt の digest は request-local な binding にだけ置き、renderer へは「開示の範囲」の値と opaque な handle だけを返す。不適格になった候補（下の「利用時の判定」の手順 4 で本文を読んだ後に外れた場合を含む）については、本文、title、それらの digest、range、長さ、Scene ID を、判定の外へ出さない（Mandatory defense 9 の counter だけを残す）。
  3. 判定は parent が、Related Scenes の participant の新しい read transaction の中で行い、下の「利用時の判定」をすべて満たしたときだけ Eligible にする。R+IR の Scene に付ける path の association で frame の値と parent の読取が食い違えば、DSN §2.3 の all-or-nothing のとおり、その query の Graph の寄与を全体で 0 にする。Graph-only の候補で食い違えば、その候補を採らない。Graph-only の候補についての失敗は、追加1枠を出さないことだけにとどめ、R+IR とその path の付加を変えない。本文の読取は query ごとに最大1件。
  4. v1 で受け付ける値は G-01 subset だけ。ほかの値は writer が拒否し、reader は unavailable にする。reading-before と A1 は宣言で外さない。secret の foreshadow、secret な Chronicle event、POV の記録は veto にする（下の「宣言の値」）。
  5. 返却時と click 時に、新しい read identity で再検証する。古い proof、同じ ID、同じ bytes、cache した digest、似た文字列で救済しない。
  6. 宣言は workspace ID と canonical locator の digest に束縛する（下の「canonical locator」）。どちらかを求められなければ unavailable にする。
  7. 宣言の書込みは、Main の一回限りの確認を writer の前に消費し、有限の待機の中で、宣言、OCC、feed を一つの transaction で書く（`scope-storage-authority` の「writer」）。COMMIT の結果が分からなければ下の「COMMIT の結果が分からないとき」のとおり読み直し、決まらなければ再起動まで quarantine する。暗黙の再試行と pending marker は作らない。COMMIT と lifecycle の edge の順序を固定する方法と、終端の証拠の型は、mutation の前に CB-2 の有限の owner/lifecycle matrix に書く（GDX-PRECHECK-001）。
  8. 上限は K1b（K1 の `nir1-defensive-resource-limits`。確認済み）の規則に従い、allocation の前に検査する。Graph-only の判定の中で超えたら、その query の Graph-only の追加を出さず、R+IR とその path の付加は変えない（K1 の表の C-body の行「その Graph 追加候補を出さない。R+IR の結果はそのまま残る」）。取消を処理の境界で観測し、部分的な結果を出さない。
  9. Related Scenes が renderer へ返す応答と event に出す unavailable の理由は、閉じた集合の code だけにする。Graph-only の追加については、候補がない場合と、候補があっても不適格な場合を区別しない1つの code にまとめる。不適格には、下の「利用時の判定」の手順 3 と 4 のどれに外れた場合も含める（宣言がない、veto、reading、A1、束縛の不一致、quarantine、frame と parent の読取の不一致、pin と path の再検証の失敗、本文の照合の失敗、K1b の上限の超過）。Graph-only の候補についての失敗では、Graph の寄与の全体を 0 にせず、R+IR の path の付加も変えず、Graph 全体の理由 code（DSN §1.5 の案の `invalidated`、`limit` など）も使わない。Graph 全体の理由 code を使うのは、B の seal、R+IR の Scene の path の再検証、worker の状態など、Graph-only の候補に依存しない原因のときだけにする。どの code にも、target の ID、title、件数、本文、veto の種別、宣言の有無を含めない。この区別は Native の診断 counter（allowlist。理由の種別ごとの件数だけを持ち、target の ID、title、digest、range、長さを持たない。renderer への応答と event には載せない）にだけ残す。次の3つは、この集約の対象外で、それぞれ閉じた集合の code にする。宣言の入口が、作者が選んだ Scene について返す拒否の理由（preview と writer）。作者が開いた Scene の宣言の状態を CB-3 の UI に出す読取。click 時に、表示中の Graph-only の行の再検証に失敗して遷移しないときの応答。前の2つは Scene を指定した別の typed な経路で、Graph の到達と宣言の状態を結び付けない。3つ目は、すでに表示した行についての応答なので、候補の有無を新たに漏らさない。
  10. PUB-G までは、宣言の入口と Graph-only の表示を製品で閉じる（A-1）。宣言の入口の gate は Native の中に置き、既定で閉じる。Native の preview（`BodyDeclaration` の grant の preview）、宣言の writer（grant の consume）、取消の writer は、gate が閉じていれば DB を読む前に typed に拒否する。PUB-G より前に gate を開けるのは Main だけで、起動時に評価用の CI seam が有効であることを確かめた場合に限る（下の「Main の一回限りの確認」の gate の条件）。Main は Main 専用の N-API（`NAPI_COMMANDS` に載せない。DSN §7.2）で、その process の間だけ gate を開く。renderer、preload、IPC からは開けない。Main も、gate が閉じていればダイアログを出さずに typed に拒否する。restore、import、Safe Mode からの restore のクリアは入口ではないので、gate によらず働く。PUB-G で開く製品の gate は、PUB-G の承認の範囲で作り、この行は開かない。単体試験は試験 build の入口を使ってよい。standard build で行う評価（G-01 の setup と測定）は、CI seam で gate を開いた起動に限って入口を使い、確認を通す。どちらも renderer と通常の起動からは選べない（post-B §4.4）。
- Acceptance implications:
  - Positive: 下の「G-01 の setup の addendum」のとおりに `g01-mira` を宣言し、B の sealed binding を正規の経路（B-ROUTE）で確立すると、R+IR+Graph が `[g01-question, g01-mira]` になり、`g01-mira` の excerpt が exact な範囲 `[0,78)` で出る。宣言の段は standard build の製品 Main で行い、確認は下の「Main の一回限りの確認」の CI seam で通す。測定に使う workspace で宣言が current であること（workspace ID と canonical locator の digest が宣言の束縛と一致すること）を、Graph arm の最初の query の前に receipt で確かめる（CP-0 と CB-4 の受入れ）。path の Evidence（Relation と Entity）と本文の anchor は、別の Evidence として出る。返却時と click 時の再検証を通る。同じ workspace を閉じて開き直しても（新しい authority instance）、app を再起動しても、宣言は有効なまま。Windows、macOS、Linux のそれぞれで「宣言 → 閉じて開き直す → 有効」が成り立つ（Windows の `\\?\` の形、macOS の `/private` 配下の temp、Linux の symlink 経由の open を含める）。R+IR の membership、順位、excerpt は変わらない（Raw が満杯の場合も、IR が補完済みの場合も、IR が空で結果の基底が Raw だけの場合も。C14）。
  - Negative: 次の場合は、どれも Graph-only の行を出さず、R+IR は変わらない。
    - 宣言がない。片方の列だけがある。未知の版、未知の欄、token の不一致がある。v1 で受け付けない値がある（writer は拒否し、DB に直接入れた場合も reader が拒否する）。
    - A1 が explicit でない、unresolved がある、query と一致しない。reading の順が query と同じか後。
    - secret の foreshadow の setup、payoff、旧式の payoff が target にある。secret な Chronicle event の `reveal_scene_id` が target である。`scene_events` が secret な Chronicle event を target に結んでいる。Scene の POV か beat の POV がある。宣言の後にこれらの記録を target に掛けた場合（既存の foreshadow や event を secret にした場合を含む）も、reader が拒否する。
    - 宣言の後の本文の保存（同じ文字列での再保存を含む）、AI Apply、bulk、順序と story time の操作、rename、Codex の rename の波及、A1 の変更。
    - 本文版、project snapshot、backup の restore、Safe Mode からの restore、import（宣言は Ready の前に消える）。複製、削除と同じ ID での再作成、ごみ箱からの復元。
    - workspace の複写と移動、workspace ID の変更、canonical locator を求められない path。移動した folder を元の path へ戻し、workspace ID も元のままなら、同じ bytes の宣言が再び有効になることを同じ試験で確かめる（下の「失効」）。
    - pin の移動、削除、再挿入。Scene の archive と削除。frame の token と parent の読取の不一致。どれも、Graph-only の候補ならその候補を採らず、R+IR とその path の付加は変わらない（R+IR の Scene の path の association の不一致では、Graph の寄与が全体で 0 になる）。返却の後、click の前の変更（click で遷移しない）。
    - renderer、MCP、model、A1 の保存による偽装。確認の期限切れ（60 秒）、再利用、別の sender か window、OCC の変化、digest の不一致、2件目の同時の確認、lifecycle の edge による取消。
    - 評価用の CI seam を、packaged の起動、`CI` のない起動、owner token の env がないか定数と違う起動、renderer の IPC から使うこと（どれでもダイアログなしの承認ができない）。owner token の照合は誤った起動を防ぐ印で、秘密による認証ではない。packaged でない起動で env をそろえた場合に承認できることは、この負例に含めない（Out-of-scope の残余）。
    - PUB-G の前の通常の起動（CI seam が無効）と packaged の起動で、宣言の入口（preview、宣言の writer、取消）を使うこと。どれも DB を読む前に typed に拒否され、ダイアログは出ない（Mandatory defense 10）。
    - 上限を超える本文、veto 行、宣言（allocation の前に拒否する）。読取の途中の取消（部分的な結果を出さない）。Graph-only の判定の中で超えた場合は、追加1枠だけを出さず、R+IR とその path の付加は変わらない。
    - 制御文字、改行、双方向の制御文字、64 個を超える長さを含む title でも、ダイアログの title は固定のラベルの付いた1行に収まり（置き換えと切り詰めの印が付く）、固定の文字列の行は変わらない。
    - excerpt が AI の request、Packing、履歴、export、audit、event、診断、log に現れないことも確かめる。不適格になった候補（「利用時の判定」の手順 4 で本文を読んだ後に外れた場合を含む）の本文、title、それらの digest、range、長さ、Scene ID が、診断、log、event、Related Scenes の応答に現れないことも確かめる。この照合は文字列だけでなく、digest と range の値でも行う。Related Scenes の応答と event に、候補の有無、veto の種別、宣言の有無、reading、束縛の区別を表す値が現れないことも確かめる。あわせて、候補がない場合、「利用時の判定」の手順 3 と 4 のどこかで不適格になった場合、Graph-only の判定の中で K1b の上限を超えた場合のどれでも、理由の code、Graph の全体の状態、R+IR の path の付加が同じになることを確かめる（Graph の結果が D の窓に間に合う条件で比べる。処理時間の差は Out-of-scope）。
  - Recovery: unavailable の後も R+IR はそのまま残り、次の query は最初から判定する。restore、import、workspace の移動の後は、作者が改めて宣言する。COMMIT の結果が分からないときは、その workspace での宣言の書込みと Graph-only の開示を再起動まで止める。再起動の後は DB の状態だけで判定する（marker はない）。
  - Lane unlocked if confirmed: `scope-storage-authority` の行とあわせて、CB-2（宣言の writer と MG-1 の BodyDeclaration）、CB-3（UI）、CB-4（parent の reader と再検証）、CP-3 の Graph-only 追加1枠、G-01 の正例の測定（CP-4）。どれも通常の依存（DT-1 の seam、CP-1 の NQG2、K1b の規則で integrator が選んで記録した数値）を満たしてから始める。G-01 の正例の測定には、B-ROUTE による B の sealed binding もさらに要る（C14）。Graph の製品公開には、A3 + B + C + D2a と Session C-1 の承認がさらに要る。
- 受入れへの影響（l6-l9:620）:
  - 新しい authority と信頼境界: 作者の本文全体の宣言が新しい authority になる。Main の確認ダイアログと Native writer が新しい境界になる。評価用の CI seam は、ダイアログの代わりに承認できる経路で、packaged でない起動で `CI=true` などの env をそろえたときだけ働く（Mandatory defense 10）。seam の有効化は env の設定だけで決まり、秘密による認証ではない（Trusted actors と Out-of-scope の残余）。renderer は引き続き信用しない。
  - 品質閾値: 変えない。G-01 の Gold、query、corpus、seed、順序、指標、期待値、既存の 24 件、G-02〜G-08 の判定、P、K1 の値はそのまま。G-01 の setup に、観測前に固定する addendum を足す。
  - データの種類と送信先: 送信先は変えない。excerpt は Related Scenes の表示と遷移にだけ使い、AI 送信、Packing、履歴、export に出さない。renderer へ excerpt を返す経路は、D2a の restricted 下の route の区分（K3）に従い、この行はその区分を変えない。
  - 保存範囲: `scope-storage-authority` の差分（宣言と束縛の digest だけ。本文、excerpt、proof は保存しない）。
  - 受入れに加えるもの: 上の正例、負例、復旧。経路ごとの失効の試験（下の「失効」）。3 OS の canonical locator。確認（grant）の試験。ダイアログの title の表示規則の試験。評価用の CI seam が通常の起動と renderer から働かないことの試験。PUB-G の前の通常の起動で宣言の入口（preview、宣言の writer、取消）が typed に拒否される試験。測定に使う workspace で宣言が current であることの照合。COMMIT の結果が不明なときの試験。excerpt がほかの出口に出ないことの試験と、不適格になった候補の本文、title、digest、range、長さ、Scene ID が診断と log に出ないことの試験。renderer へ返す理由の code の粒度の試験。
  - 変えないもの: R と R+IR の結果、既存の Related Scenes の excerpt と anchor、path の A3、A-1、Graph の製品公開条件。
  - 可用性: v1 で開示できるのは、POV を持たず、secret の foreshadow と secret な Chronicle event が掛からず、A1 が explicit な Scene に限る。本文、title、A1 を変えるたび、restore や import のたび、workspace を動かすたびに失効し、作者が改めて宣言する必要がある。timeline、worldline、layer の registry を1つ変えるだけでも、project のすべての Scene の v1 の token が進むので、project 内の宣言がすべて失効する（下の「失効」）。R+IR の Scene の path の再検証が途中で食い違った query では、Graph の寄与が全体で 0 になる。Graph-only の候補の判定が食い違った query では、追加1枠だけが出ない。

### 変更前後

| 項目 | 現行（`a153743b`） | proposal/2（Option B） |
| ---- | ------------------ | ---------------------- |
| Graph-only target の本文 | 開示しない（authority がない。l6-l9:28） | 作者の宣言が current で、利用時の判定をすべて通ったときだけ、excerpt と anchor への遷移を出す |
| Graph-only target の title と locator | 出さない | Eligible のときだけ出す |
| 本文を読む場所 | —（worker は本文を読まない） | parent。frame の token と宣言の束縛に exact に一致したときだけ |
| 宣言の入口 | なし | Main の一回限りの確認 → Native writer。PUB-G までは Native の gate で閉じ、評価用の CI seam が有効な起動でだけ開く |
| AI 送信、Packing、履歴、export | 閉じている | 閉じたまま（この開示を使わない） |
| G-01 | Graph-only の追加ができず HOLD | addendum の setup で、固定 v1 の期待値に届きうる（実測は CP-4。B-ROUTE による B の sealed binding が前提。C14） |

### 開示の範囲（excerpt、anchor、title、locator）

| 項目 | Eligible のとき | Unavailable のとき |
| ---- | --------------- | ------------------ |
| excerpt | canonical な本文の先頭の非空行の exact な文字列と、UTF-16 の range。表示上の折り畳みは、検証した文字列と range を変えない | 出さない |
| anchor への遷移 | click 時の再検証を通ったときだけ、その range へ遷移する | 遷移の handle を出さない |
| title | 宣言で束縛した title（現在の title の digest が宣言と一致するもの） | 出さない |
| locator（Scene ID、遷移の handle、pin の Entity との対応、tree の中の位置） | Scene ID と opaque な handle を出す。pin の対応は path の Evidence の一部として出す | 出さない。件数も出さない |
| path の Evidence | 既存の A2／A3 のとおり、Relation と Entity の Evidence を本文の anchor と分けて出す | Graph の寄与が 0 のときは出さない |
| 理由 | — | 閉じた集合の code だけ。Graph-only の追加については、候補の有無と不適格の理由を区別しない1つの code にし、target を識別する情報を含めない（Mandatory defense 9） |

- この行が扱う開示は、Scene を Graph の結果として query に関係づけて示すことである。tree の表示や、エディタで Scene を開くことは変えない。
- Graph-only の行から、chat の context や Packing へ渡す操作を作らない。
- event には target の情報を載せない。`related-scenes:graph-ready` の payload は projectId だけにする（DSN §3.4）。
- excerpt と本文は cache しない。返却のたびに parent が読み直す。次 query 用の cache（DSN §3.3）が持つのは worker の DTO だけ。
- 原稿そのものの通常の export（本文の書き出し）はこの契約の対象外で、変わらない。

### 宣言の値（v1 は G-01 subset）

宣言の対象は、保存された本文（`tree_nodes.content`）の全体と title。unplaced beats（`unplaced_beats_doc`）とメモは開示しないので、対象に含めない。1回の確認で宣言できるのは1つの Scene だけ。

| 軸 | v1 で受け付ける値 | 作者の宣言の意味 | Native の確認 | v1 で受け付けない値（fail-closed） |
| -- | ----------------- | ---------------- | ------------- | ----------------------------------- |
| reading | （宣言しない） | — | target の reading rank が query より小さいこと。live な project Scope authority から、両方を同じ read の中で導く。等しい、不明、曖昧なら拒否 | 宣言で外すこと |
| story | `independent` | story time の前後に関係なく、本文全体を開示してよい | 宣言を信じる | 特定の Scene より後でだけ開示する、などの条件 |
| auto | `independent` | phase の解決の軸（reading と story）に関係なく開示してよい | 宣言を信じる | 条件付きの値 |
| phase | `independent` | Codex の phase に関係なく開示してよい | 宣言を信じる | phase の集合を条件にすること |
| reveal | `non-secret` | 本文全体に、まだ明かしていない秘密を含まない | veto: 次のどれかがあれば拒否する。secret の foreshadow の setup、payoff、旧式の payoff が target を参照している（abandoned や payoff の確定の有無を問わない）。secret な Chronicle event の `reveal_scene_id` が target である。`scene_events` が secret な Chronicle event を target に結んでいる（reveal が読む順のどこにあるかを問わない。C9） | 明かす foreshadow や event を列挙して条件にすること |
| POV | `independent` | 視点に限られた知識を含まず、どの視点の query にも開示してよい | veto: Scene の POV、保存本文の `sceneBeat` の `pov`、`scene_beat_pov_cache` のどれかがあれば拒否 | 特定の人物の視点に限ること |
| A1（timeline、worldline、layer、holder、audience） | （宣言しない） | — | marker が explicit で、query identity の3軸が exact であること。query と一致すること（`validate_scene_scope`）。宣言で緩めない | — |

- `independent` と `non-secret` は作者の明示の宣言で、未入力や既定値として扱わない。
- veto に使うのは、本文そのものを分類している記録（この Scene に掛かる foreshadow と Chronicle event、この Scene の POV）だけ。Chronicle event の秘匿は、正本の `events` と `scene_events` で確かめ、そこから導いた抽出の Revision は使わない。phase の anchor のように Entity の側を表す記録は、宣言を覆す根拠にしない。記録がないことを、秘密がないことや視点がないことの証明として扱わない。
- veto は writer（宣言の時）と reader（返却時と click 時）の両方で確かめる。宣言の後に foreshadow や Chronicle event を secret にした場合も、target に掛けた場合も、reader が拒否する。
- 受け付けない値の意味を足すときは、新しい draftRef で起案する。

### 利用時の判定（parent で読む）

返却時は、worker の lease を drop した後、Related Scenes の participant の新しい read transaction の中で次の順に行う。DSN §2.3 の順序に従い、Graph-only の候補の失敗の扱いだけを変える（手順の後の「Graph-only の候補についての失敗の扱い」）。

1. B の seal が frame の値と一致することを確かめる（DSN §2.3 の (a)）。一致しなければ、Graph の寄与を全体で 0 にし、手順 2 以降に進まない。
2. R+IR の Scene に付ける path の association を、DSN §2.3 の (b)、(c) で再検証する。どれか1つでも食い違えば、DSN §2.3 の (d) のとおり Graph の寄与を全体で 0 にし、手順 3 に進まない。
3. 共通追加1枠の条件を満たすときだけ、R+IR にない Scene を frame の tuple の順に判定する。条件は、IR が共通追加枠を使っていないこと（kind が `ir` の行がない。IR が空で結果の基底が Raw だけの場合を含む。C14）と、Raw が 8 件未満であること。各 Scene に本文を読まない次の判定を行い、どれかに外れた Scene は採用せず、次の候補へ進む。最初にすべてを通った1件を採用して止める。
   - Scene が同じ project にあり、live で archive されていない。
   - A1 の条件（上の表）と reading-before を満たす。
   - 宣言の2列がそろい、版が既知で、JSON が閉じた型として正しく、token が JSON から計算し直した値と一致する。値が v1 の subset に入る。
   - 宣言の束縛が現在の値と一致する: incarnation、v1 の token、本文の Source の token、title の digest、workspace ID、canonical locator の digest。
   - veto に当たらない（secret の foreshadow、secret な Chronicle event、Scene の POV、`scene_beat_pov_cache`）。
   - その workspace が quarantine 中でない（下の「COMMIT の結果が分からないとき」）。
   - frame の値（incarnation、source token、scope token）が parent の読取と一致する（DSN §2.3 の (c)）。
   - `recheck_scene_pin`（`narrative_extraction/nir1_graph/scenes.rs:288`）が通る（同じく (c)）。pin は locator としてだけ使う。
   - 代表 path の material binding の token が current である（DSN §2.3 の (b)。既存の A2／A3 の revalidate）。path の A3 は query の Scene のものとして扱い、target 本文の根拠に流用しない。
4. 採用した1件の本文を K1b の上限の内で読み、次を確かめる。storage digest、canonical digest、正規化の版、UTF-16 長が宣言の束縛と一致する。保存本文の `sceneBeat` に `pov` の指定がない。本文が空でない。excerpt は canonical な本文の先頭の非空行にする。どれかに外れたら、2件目の本文は読まず、その query の Graph-only の追加を出さない。
5. 結果は `Eligible`（title、excerpt、UTF-16 の range、excerpt の digest、request-local な binding）か `Unavailable`（理由）。request-local な binding は返却と click の照合にだけ使い、永続化しない。renderer には opaque な handle だけを渡す。`Unavailable` の理由は Native の中だけで使い、renderer へは Mandatory defense 9 のとおりにまとめた code だけを返す。

Graph-only の候補についての失敗の扱い:

- その query の Graph-only の追加を出さないことだけにとどめる。手順 3 と 4 のどれに外れた場合も、手順 3 と 4 の中で K1b の上限を超えた場合も同じで、手順 1 と 2 で決まった Graph の全体の状態と R+IR の path の付加は変えない。途中で止めた判定の結果は使わない。
- DSN §2.3 との違い: DSN は、採用した Graph-only の association の (b)、(c) の不一致と本文の token の不一致でも、Graph の寄与を全体で 0 にする。この draft はそれを採らない。全体を 0 にすると、R+IR に path の付加がある query ではそれが消え、ない query では Graph の全体の理由 code が変わるので、Graph-only の候補があったことを renderer が判別できる（Mandatory defense 9）。
- 根拠: K1 で確認された `nir1-defensive-resource-limits` の C-body の行（「その Graph 追加候補を出さない。R+IR の結果はそのまま残る」）と一致する。DSN §2.3 でも、本文を読まない判定で不適格な候補は飛ばすだけで、Graph の寄与を 0 にしない。この draft は、再検証の失敗と上限の超過も、同じ「追加しない」の側に寄せる。
- partial Graph にあたらないこと: worker の列挙は完了しており、R+IR の path の付加は手順 2 で全件を再検証済みなので、`graph-limited-binding` が禁じる partial Graph（列挙を打ち切った結果）にはあたらない。採用する1件は、手順 3 と 4 で parent の現在の読取とすべて照合してから使うので、worker の snapshot と parent の読取を未検証のまま混ぜることにもならない。
- 作業量: pin の再読取、path の再検証、本文以外の判定は、それぞれ frame の件数 N_F（8）以下、本文の読取は1件以下で、DSN §2.3 の見積りの範囲に収まる。

click 時は、navigation handle から新しい read transaction で、その Scene について手順 3 の各項目（共通追加1枠の条件と tuple の順の走査は除く。frame の値の代わりに、返却時の request-local な binding と照合する）と手順 4 をやり直し、excerpt と range が返却時と一致するときだけ遷移する（既存の `nir1_evidence_qualify` を拡張する。DSN §2.3）。一致しなければ遷移しない。宣言の取消やクリアを feed で知らせて表示中の行を消す方法は CP-3 で決めるが、click 時の再検証はそれとは独立に働く。

### Main の一回限りの確認

DSN §7 の共通の grant の上に、種類 `BodyDeclaration` を置く。

- 要件: 有効は 60 秒。同時に1件（process 全体で、種類を問わない）。sender（WebContents）と window に束縛する。u64 の値（lifecycle の revision、authority instance）は Native の中だけに置き、JS を通さない。OCC と digest に束縛する。writer の前に消費し、書込みが失敗しても戻さない。renderer は grant を発行も参照もできない。
- binding: exact な Ready の LiveBinding、lifecycle の revision、workspace ID と canonical locator の digest、project、Scene、incarnation、OCC（v1 の version と、宣言の現在の token か NULL）、本文の Source（token、storage digest、canonical digest、正規化の版、UTF-16 長）、title の digest、宣言の値の digest、ダイアログの表示文の digest。DSN §7.3 の `BodyDeclaration` に、title の digest、storage digest、宣言の現在の token、表示文の digest を足す。消費する writer は、DSN §7.3 の `narrative_scene_scope_update` の分岐ではなく、宣言の入口（`scope-storage-authority` の「writer」）にする。
- ダイアログ:
  - 文面は、Native が作る allowlist の固定の文字列と、Native が整えた title と文字数だけで組む。renderer の文字列と、本文に由来する文字列は使わない。
  - title の表示規則: title は作者のデータで、AI Apply なども書く（C12）。Native が、Unicode の制御文字（Cc）、書式文字（Cf。双方向の制御と幅のない文字を含む）、行と段落の区切り（Zl、Zp）を U+FFFD に置き換え、Unicode のスカラー値で 64 個までに切り詰める（切り詰めたときは固定の印を付ける）。整えた title は、固定のラベルを付けた独立の行に、固定の括弧で囲んで置く。title がほかの文言をまねても、固定の文字列の行は変わらない。
  - 表示する title は、binding の title の digest を計算したのと同じ読取の値から作り、別に読み直さない。表示文の全体（固定の文字列、整えた title、文字数）の digest を binding に入れる。
  - 表示する内容: Scene の title、宣言する値の意味、対象が本文の全体（文字数）と title であること、効果が Related Scenes での excerpt の表示と遷移だけで AI には送らないこと、本文、title、A1 の変更、restore、import、workspace の移動で失効すること、timeline、worldline、layer の registry を変えると project のすべての宣言が失効すること。既定のボタンは取消にする。
- 取り消す契機: ダイアログの取消、sender の破棄と遷移、window の close、lifecycle の edge（TransitionAdmitted、Unavailable、ShutdownRequested）、D2a の epoch の変化、期限切れ。
- 評価の harness（standard build。C13）が宣言する段では、ダイアログの代わりに、製品 Main の中の CI seam が承認してよい。
  - gate: `narrativeMaintenanceCiSeam.ts` と同じ形にする。packaged の起動では無効で、`CI=true`、source の公開の定数と exact に一致する owner token、起動ごとの nonce（UUIDv4）が env にそろったときだけ有効になる。owner token と nonce は秘密ではなく、誤った起動を防ぐ印にとどまる（C13）。実効的な境界は、packaged でないことと env を設定できることである（Trusted actors と Out-of-scope の残余）。seam は Main の中だけで働き、renderer、preload、IPC からは有効にも無効にもできない。通常の起動と packaged の起動では到達できない（post-B §4.4 の「rendererから試験transport、fixture proof、test-only bypassを選択できない」「許可を与える入口は隔離する」）。
  - 範囲: seam が置き換えるのは、ダイアログの表示と押下だけ。承認するのは `BodyDeclaration` だけで、`ProfileActivation` と `LocalSendConsent` は承認しない。Native の preview、issue、consume、writer、期限、同時1件、sender と window の束縛は製品と同じ経路を使う。PUB-G より前に宣言の入口の gate を開くのも、この seam が有効な起動に限る（Mandatory defense 10。A-1）。seam が無効な起動では gate は閉じたままである。
  - 宣言の段に使う Main: standard build の製品 Main（差し替えのない main）を使う。setup のほかの段に、決定論の provider の対応表だけを差し替えた Main（C14 の (c)。S1 の setup 専用の Main）を使う場合も、宣言の段には使わない。
  - 記録: seam を使った事実（seam の版、env の名前、nonce の digest、承認した grant の数と binding の digest）を Main の receipt に書き、宣言した段の receipt（setup か測定）から参照する。
  - 試験: packaged の起動、`CI` のない起動、owner token の env がないか定数と違う起動、renderer の IPC からの要求では seam が働かず、ダイアログなしの承認ができないこと。そのどの起動でも、PUB-G の前は宣言の入口の gate が閉じたままであること。
- 測定の workspace: 宣言は workspace ID と canonical locator に束縛されるので、Graph arm の測定に使う workspace で宣言が current でなければならない。現行の P の paired harness は setup の DB だけを別の path に書き出して開くので（C13）、その方式のままでは、setup で行った宣言は測定の workspace で失効する。次のどちらにするかは、CP-0 が観測の前に決めて addendum に書く。(i) setup の workspace で宣言し、同じ workspace（同じ path と workspace ID）で測る。(ii) 測定に使う workspace を開いた後、Graph arm の最初の query の前に、この節の CI seam を通して宣言する。どちらでも、測定の receipt に、測定に使った workspace の workspace ID と canonical locator の digest と、宣言の token を記録する。Graph arm の最初の query の前に、宣言が current であること（束縛の digest が一致すること）を照合し、一致しなければ測定の前に `[precheck]` で止める（CP-0 と CB-4 の受入れ）。

### COMMIT の結果が分からないとき

- 該当するのは、COMMIT がエラーを返したとき、COMMIT の後に結果を受け取れなかったとき、COMMIT の途中で owner の thread が panic したとき。
- 手順:
  1. writer の接続で rollback を試み、autocommit に戻ったことを確かめる。確かめられなければ、既存の規則どおり接続を quarantine して退役させる。
  2. 有限の待機（K1b）の中で、清潔な接続で新しい read transaction を開き、exact な識別子を読む: request の idempotency の記録（request ID と payload の hash）、change event の UID、その Scene の宣言の token。
  3. 3つとも書込み後の値なら、成功として扱う。3つとも書込み前の値（記録も event もなく、宣言が書込み前の token か NULL）で、手順 1 の rollback を確かめていれば、失敗として扱う。grant は戻さず、作者は新しい確認からやり直す。記録がないことだけで失敗とは判定しない。
  4. それ以外の場合と、読めなかった場合は不明とする。その process の中で、その workspace の宣言と取消の書込みを `restart-required` で拒否し、Graph-only の開示を unavailable にする（quarantine）。原稿の保存などほかの操作は止めない。接続の quarantine の既存の規則は変えない。quarantine は process の再起動で解ける。
- marker: 宣言の書込みの途中を表す永続の marker や意図の記録は作らない。宣言、feed、idempotency の記録は一つの transaction なので、再起動の後の DB は「全部入った」か「何も入っていない」のどちらかになる。どちらも作者が確認した範囲の状態である（入った場合は Main で確認済みの宣言、入らなかった場合は宣言なし）。再起動の後は DB の状態だけで判定する。手順 3 で失敗と判定した後でも、storage の障害の種類によっては、再起動の後の WAL の回復で宣言が現れることがありうる。それも作者が確認した宣言なので、開示の安全性は変わらない（UI は DB の状態をそのまま表示する）。
- COMMIT が戻らない間は、その終端を待つ。shutdown が終わらない場合の終端は、Main の観測予算の後の `exit(1)` で、DSN §1.6 の 4 と同じ。fsync の時間には上限を置けないので、残るリスクとして受け入れる。

### canonical locator

- 目的: 宣言を、宣言した workspace でだけ有効にする。複写や移動の先では有効にしない。
- 計算: workspace が Ready になったとき、Native が workspace の root を OS の canonicalize で解決した path から一度だけ作る。preview、writer、reader は同じ値を使う。LiveBinding の locator（C6）は使わない。
- 規則:
  - symlink は解決する。symlink 経由で開いても同じ値になる。
  - macOS では、`/var` や `/tmp` などは `/private/...` に解決した形を使う。
  - Windows では、OS が返す verbatim の形（`\\?\C:\...`、`\\?\UNC\server\share\...`）をそのまま使い、prefix を足したり外したりしない。大文字と小文字を畳まず、OS が返す形のまま使う。ネットワーク drive も OS が返す canonical な形で比べる。
  - path が Unicode として正しくなければ（lossy な変換が要るなら）unavailable にする。canonicalize が失敗した場合も unavailable にする。どちらの場合も writer は宣言を拒否する。
  - 比較は byte の完全一致で行う。DB に保存するのはドメイン分離した digest で、path の文字列は保存しない。
- 同じ workspace とみなす条件: workspace ID（`.grimodex/workspace.json` の id）と canonical locator の digest が両方一致すること。authority instance、recovery generation、DB file の identity は使わない。前の2つは process ごとに変わり、DB file の identity は backup の restore で変わるため。app の中の restore は宣言を消すので、DB file の identity がなくても宣言は持ち越されない。
- 帰結: folder を複写した先では失効する。移動や名前の変更でも失効し、作者が改めて宣言する。ただし、元の path へ戻し、workspace ID も元のままなら、同じ bytes の宣言は再び有効になる（許容する。下の「失効」）。symlink 経由の open では有効。同じ path でも workspace.json の id が違えば失効する。
- 判定の時点: 失効の判定は、次に Ready になったときに作る locator で行う。open している間の folder の移動や改名は、その間の判定に反映しない（app の外の操作は Out-of-scope）。
- 試験: Windows（verbatim の形）、macOS（`/private` 配下の temp）、Linux（symlink 経由の open と folder の複写）で行う。
  - 大文字と小文字だけが違う綴りの path から同じ folder を開く場合も、macOS（既定の APFS）と Windows（NTFS）で試す。OS の canonicalize が on-disk の綴りを返せば同じ locator になり、宣言は有効のまま。返さなければ別の locator になり、失効する（fail-closed。作者が改めて宣言する）。Linux で大文字と小文字を区別しない directory（ext4 の casefold など）を使う場合も同じ扱いにする。
  - どちらになったかを、OS と版ごとに試験の記録に残す。どちらの結果もこの行に適合する。大文字と小文字を畳む処理は足さない（足すには新しい draftRef が要る）。Positive の「閉じて開き直す → 有効」は、同じ綴りの path で開き直す場合に求める。

### G-01 の setup の addendum

- 対象: `evals/nir1-g01/fixture.v1.json`（`nir1-g01-explicit-pin-design/1`、sha256 `996ef1c0…`）。この file は変えない。
- 足す手順:
  - 宣言: `g01-mira` だけを、通常の宣言の経路（Main の確認 → Native writer）で宣言する。値は v1 の subset（story、auto、phase は `independent`、reveal は `non-secret`、POV は `independent`）で、対象は本文の全体と title。ほかの Scene は宣言しない。
  - 宣言の時期: 候補 §7 の Scene（本文、title、tree の順序）、明示 A1、project の registry を通常の writer で設定し終えた後で、Graph arm の最初の query より前。setup の中で宣言するか、測定に使う workspace を開いた後に宣言するかは、上の「Main の一回限りの確認」の「測定の workspace」の (i)、(ii) のどちらかで、CP-0 が観測の前に決める。確認の通し方（CI seam）と、宣言の段に使う Main も、同じ節のとおり。
  - 宣言の後は、`g01-mira` の本文、title、A1、順序と、project の registry を変えない。宣言は行の v1 の列（`updated_at` を含む）を書き換えないので project の Scope authority の revision を変えず、feed でも Scope authority の変更として扱われず、Index の Freshness も dirty にしない（C8、C11、C15 と `scope-storage-authority` の行）。このため、Entity／Relation の Revision の準備と承認、pin、Chronicle の IR、B の seal は、宣言の前でも後でもよい。
  - B の sealed binding: Graph arm に要る B の sealed binding は、Revision の承認と pin の後に、正規の経路（計画の B-ROUTE が Native／DB の maintenance entry に配線する B の build）で確立する（候補 :215-216）。試験と診断用の publish の呼出し（C14 の (b)）は使わない。正規の経路で確立できなければ、候補 :240-241 のとおり G-01 は v1 期待値未達／Hold で、宣言では解けない。
  - 記録の前提: `g01-mira` には、POV、secret の foreshadow、secret な Chronicle event を設定しない（候補 §7 の「非secret」と同じ）。`g01-mira` の story_time_order は NULL のまま（S1 の setup と同じ。C14 の (d)）。v1 の story は `independent` を宣言するので、story の位置は要らない。POV は、記録があれば veto になるだけで、明示の POV は要らない。reading-before は、fixture の reading order（`g01-mira` は 20、query は 100）を setup が実現した読む順から、live な project Scope authority で導く。
  - R と R+IR の setup は変えない。S1 が観測の前に固定した setup の選択（C14 の (d)。S1 の `SETUP_DECISIONS`）を、CP-0 が S1 の harness と一緒に新しい候補として取り込んで使う。R と R+IR は、その setup で v1 の期待値と一致した。
- 変えないもの: query、corpus（本文と title）、seed、Gold（`g01-mira` = 3）、順序の規則、指標、期待値（R と R+IR は `[g01-question]`、R+IR+Graph は `[g01-question, g01-mira]`、excerpt は `[0,78)`、Recall@8 は 0→1、nDCG@8 は約 0.6309）。S1 で R+IR の IR が空（基底が `raw`）だったこと（C14 の (a)）は、共通追加1枠の条件を変えない（kind が `ir` の行がない）。
- 観測前に一緒に固定する負例（Gold ではなく、診断用の期待値）: 宣言しない場合は R+IR+Graph が R+IR と同じになる。宣言の後に `g01-mira` の本文を同じ文字列で保存し直すと出ない。宣言の後に `g01-mira` の本文版を restore すると（同じ bytes に戻す場合も）出ない。
- 固定の時期と方法: addendum は別の file（例: `evals/nir1-g01/setup-addendum.v1.json`。fixture v1 の sha256 を参照する）にする。G-01 で R+IR+Graph（本文の開示を含む）を観測するどの実行よりも前の commit に入れ、期待値を独立した reviewer が確かめた記録をその commit に束縛する（CP-0 と同じ手順）。quality-manifest と impact-map に分類する。addendum の宣言する Scene と値、期待値、診断用の負例は、この draft だけから決まる。CP-0 が addendum に書き足すのは、宣言の時期（(i) か (ii)）と、B の seal の手順（B-ROUTE の経路の呼び方）だけで、どちらも期待値を変えない。R と R+IR の setup の選択（S1 の `SETUP_DECISIONS`）は harness の側にあり、addendum では変えない。S1 の観測値（R と R+IR の結果、score、association の記録）は、addendum の期待値に使わない。
- S1 では R と R+IR が v1 の期待値と一致した（C14）。G-01 の fixture が改訂された場合（K6 の `g01-eval-revision`）に限り、改訂後の版を参照する addendum の新しい版を、その freeze の前に同じ手順で作る。宣言する Scene（`g01-mira`）と値は変えない。
- Option A を選んだ場合は、addendum を作らない。

### 資源（K1 に従う）

- worker の query: K1 で確認された `graph-limited-binding`（proposal/6）の固定値に従う（read／admission `512`、batch `16x32`、SQL `100,000 VM steps`、result lease `100 ms`、reader／busy wait `0`、2hop／12／144／8、per-Revision preflight `2,097,152 B`）。worker は本文を読まないので、C-body はこの予算を使わず、この行はその値を変えない。frame に載せる association の件数 N_F は 8 である（K1 の Scene 8。K1 は資格判定の前に件数を広げる DSN の逸脱案を採っていないので、DSN の判断 D-08 の既定のまま）。
- 新しい上限（K1b の対象。K1 の表の C-body の行。`nir1-l6-l9-contract-proposal-6-draft.md:155`、commit `ba7ceb46`）: 本文の読取の bytes（storage と canonical。materialize の前に octet_length で検査する）、veto の行の件数（foreshadow と Chronicle event の行。N と N+1）、宣言の JSON の bytes、parent の判定の SQL steps と期限、DB mutex と busy の待ち、writer の操作ごとの期限、COMMIT の結果の読み直しの期限。K1b は確認済みなので、数値は integrator が実測から選び、PR に記録する（数値ごとの確認は要らない）。merge の後に緩めるには、K1b の規則 7 のとおり再確認を要する。宣言の preview と reader は、本文の読取の上限として同じ値を使う（宣言できた本文は読める）。
- この行で固定する値: 確認の期限 60 秒、同時の確認 1件、query ごとの本文の読取 最大1件、excerpt は先頭の非空行だけ。どれも、緩めるには再確認を要する。
- 超えたとき: 本文を読む前の判定（上の手順 3）でも、読んだ後（手順 4）でも、その query の Graph-only の判定をそこで止め、追加1枠を出さない（K1 の表の C-body の行「その Graph 追加候補を出さない。R+IR の結果はそのまま残る」）。R+IR とその path の付加、Graph の全体の状態は変えない（Mandatory defense 9）。手順 1 と 2 の中で超えた場合は、Graph の寄与を全体で 0 にする（`graph-limited-binding` の fail-safe）。writer は typed に失敗し、部分的に書かない。
- P（B=54.2 ms、D=10.84 ms、上限 65.04 ms、T=2144.7 ms）は変えない。parent の判定は Graph の到着の時刻に含まれ、D の窓を過ぎた Graph はその query に混ぜない（post-B §7.2）。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-c-body-disclosure-proposal/2 for contractId graph-target-scene-body-disclosure.`

## scope-storage-authority（proposal/3 への差分: Scene Scope v2）

- Baseline (approved; limited): `nir1-l6-l9-contract-proposal/3#scope-storage-authority`（l6-l9:97、:110-119）。Native が所有する project の registry と、Scene ごとの閉じた binding（A1 の軸、incarnation、互換 marker、principal、OCC の version、source token）を保存し、本文や full closure を複製しない。設定、registry、incarnation の変更は、同じ transaction で依存を失効させる。第二の authority は作らない。clear と undo は旧資格に戻さず、restore は旧資格を復活させない（l6-l9:113、:460-476）。本文の開示に関する欄はない。
- Delta (L6-L9 storage; proposal/2 draft): 既存の Scene ごとの binding の行（`narrative_scene_scope_bindings`）に、作者の本文全体の宣言を表す component を、nullable の2列（宣言の canonical JSON と、その token）として足す。これを Scene Scope v2 と呼ぶ。v1 の binding、reader、token の計算、A1 の保存の payload、project の Scope authority の digest は変えない。宣言、取消、クリアの書込みが変えるのは宣言の2列だけで、行のほかの列（incarnation、marker、A1 の JSON、principal、version、source token、`updated_at`）は byte 同一のまま残す。v1 の version と token を進めず、`updated_at` も書き換えない（`updated_at` は v1 の token の入力で、project の Scope authority の digest にも入る。C15）。宣言の変化は、A1 とは別の object kind の feed event で知らせ、project の Scope authority の変更として扱わない。宣言の token は、宣言の値と、宣言の時点の v1 の token、incarnation、本文の Source、title の digest、workspace の束縛に結び付ける。どれかが変われば不一致で失効する。restore、import、Safe Mode からの restore は宣言を消す。非 NULL にできるのは、Main の確認を消費した宣言の writer だけ。schema の版は merge 時に integrator が採番する（既定は v42）。既存の行は NULL のままにし、backfill しない。第二の table、Source kind、Freshness consumer、本文や excerpt や proof の保存、pending marker は作らない。詳細は下の「保存先」「writer」「失効」。
- Trusted actors: Native の Scene Scope の writer（A1 の保存、source token の refresh、宣言と取消の writer、restore と import のクリア）。migration と schema の contract。既存の project Scope authority と lifecycle。
- Untrusted actors: renderer の payload（A1 の保存に宣言の欄を足すこと、宣言の ID や時刻を渡すことを含む）、generic SQL、MCP、renderer の Drizzle。restore、backup、import、複写で入ってくる DB の中身。宣言の writer を呼べる位置にある、Electron の Native 以外の code（MCP の tool など）。
- In-scope attacks: 許可のない writer による宣言の書込み（generic SQL、MCP、A1 の保存、宣言の writer 以外の Native writer）。restore、import、複製、ID の再利用での宣言の持ち越し。片方の列だけの状態、未知の版、未知の欄。migration による既存の行の昇格や backfill。宣言の変更が feed に残らないこと。同じ request の再送で宣言が二重にできること。取消と再宣言で同じ token に戻ること（ABA。renderer が前の宣言の ID と時刻を送り直すことを含む）。宣言を変えるたびに v1 の token を進めて、無関係な Revision の A3 を stale にすること（C8）。宣言の書込みで行の `updated_at` などの v1 の列を書き換え、v1 の token の照合を壊すこと（C15）。A1 と同じ kind の feed event で宣言を知らせて、Revision の pending 判定や Scope authority の freshness を巻き込むこと（C11）。宣言の feed event で Index（B の Graph index、Chronicle の IR の Index）の Freshness を dirty にし、Graph や IR を unavailable にすること。v1 の意味や token の計算の無断の変更。
- Out-of-scope attacks: proposal/3 と同じ（OS、backend、admin の侵害、作者の secret privilege、Raw search の再設計、外部送信）。加えて、app の外での DB の直接編集と、宣言の内容の真偽。
- Mandatory defenses:
  - 2列はどちらも NULL（宣言なし）か、どちらも非 NULL（宣言あり）。片方だけなら reader は unavailable にし、writer は宣言か取消で上書きする。
  - migration は非昇格にする。既存の行は NULL のままで、何からも宣言を作らない。片方の列だけが入った状態を修復でき、失敗したら rollback して再試行できる。v41 以前の backup を restore できる。
  - 非 NULL にできるのは宣言の writer だけ（Main の確認を消費したもの）。取消の writer と、restore、import、Safe Mode のクリアは NULL にするだけ。ほかの Native writer は2列に触れない。table の保護（C5）を保ち、renderer の Drizzle と generic SQL から書けないことを、schema の contract（Rust だけが書く列）でも固定する。宣言の writer は Electron の Native からだけ呼べるようにし（例: feature gate）、MCP の tool や generic な writer の経路から呼ばないことを試験で固定する。
  - 宣言、取消、クリアは、宣言の状態、feed（change event と narrative change feed）、idempotency の記録を同じ transaction で書く。
  - 宣言、取消、クリアのための書込みは、行の宣言の2列だけを書く（例: `UPDATE narrative_scene_scope_bindings SET <宣言の列> = ?, <token の列> = ? WHERE project_id = ? AND scene_id = ?`）。行のほかの列、特に `updated_at` は byte 同一のまま残す。ほかに書いてよいのは feed と idempotency の記録だけで、`tree_nodes`（version と `updated_at`）、registry、ほかの Scene の行は書かない（書けば、本文の Source の token、tree の generation、project の Scope authority の digest が進む。C8、C15）。既存の writer はどれも行を書き換えるときに `updated_at` も書き換えるが（C15）、宣言の writer はこの慣例に倣わない。宣言の時刻は宣言の JSON の中にだけ置く。本文版と project snapshot の restore のように、同じ transaction の中で既存の writer が v1 の列を進める経路では、v1 の列はその既存の規則のままにし、クリアのための書込みは2列だけを NULL にする。backup の restore（staged DB）と import（取り込む DB）のクリアも、2列だけを NULL にし、v1 の列を書き換えない（token を計算し直さずに書き換えると、その DB の各 Scene で v1 の token の照合が外れる）。CB-1 か CB-2 で v1 の列のどれかを書き換える必要が生じたら、`[precheck]` で止め、新しい draftRef で起案する。
  - feed の event は、`scene-scope` と `scope-registry` のどちらとも別の object kind（名前は U3。例: `scene-body-declaration`。key は Scene ID）にし、structural impact に `scopeAuthorityChanged` を入れない。A1 の writer の feed event（`scene_scope_feed_event`）は流用しない（C11）。
  - この kind を feed の閉じた集合に登録する（event の検証、project の照合、canonical snapshot、Source の対応付け）。Source の対応付けでは、Source を持たない kind として扱う。`event_changes_project_scope_authority` と `affected_source_identities` は、この kind の event を Scope authority の変更にも Source の変更にも数えない。change kind は閉じた集合の値にし、`unknown` にしない。この kind の event だけで、Revision の pending 判定が `PendingUnknown`、`PendingRelevantChange`、`PendingGlobalChange` にならないこと。Index（B の Graph index と Chronicle の IR の Index）の Freshness も dirty にならず、B の sealed binding は current のままであること。
  - feed の before／after の digest は、この kind 用の snapshot（その Scene の宣言の2列。どちらも NULL なら宣言なしを表す固定の値）から計算し、宣言の変化を feed で見落とさない。`scene-scope` の kind の snapshot（`canonical_scene_scope_snapshot`。v1 の DTO）は変えない。
  - OCC は、v1 の version と、宣言の現在の token（または NULL）の組で行う。v1 の列（version、token、`updated_at`）は書き換えない。宣言に依存するのは Graph-only の開示だけで、それは返却時と click 時に宣言を読み直す。Revision、Index、履歴は宣言に依存しないので、宣言の変更で失効させず、pending にもしない（v1 の側は C8、feed の側は上の kind の分離で守る。C11）。
  - v1 の binding（`narrative-scene-scope/1`）、reader、token の計算、A1 の保存の payload（`deny_unknown_fields`）、`scope_extension_digest` は変えない。
  - 宣言の JSON は閉じた型（未知の欄を拒否）で、版付きの識別子と、宣言ごとの ID と、宣言の時刻を持つ。宣言の ID と時刻は、宣言の writer が write transaction の中で生成する（ID は OS の CSPRNG による UUIDv4、時刻は Native の時計）。renderer、preload、Main から受け取らず、宣言の入口の payload はこれらの欄を持たない閉じた型にする（あれば拒否する）。同じ request の再送は idempotency の記録を返すだけで、新しい ID を作らない。このため、取消と再宣言で同じ token に戻らない（UUIDv4 の衝突は無視する）。時刻は表示と記録にだけ使い、順序や認可の判定に使わない。
  - 本文、excerpt、path の proof、grant、判定の結果を保存しない。canonical locator は digest で保存し、path の文字列は保存しない。
  - restore、import、Safe Mode からの restore は、Ready の前に宣言を消す（下の「失効」）。
- Acceptance implications:
  - Positive: 現行の版（41）から次の版への migration で、既存の行は NULL のまま。片方の列の修復と、失敗時の rollback と再試行ができる。宣言は、閉じて開き直した後も残る。宣言と取消では、feed と idempotency の記録が同じ transaction に入り、v1 の version、token、project の Scope authority の revision は変わらない（既存の Revision の A3 は stale にならない）。宣言と取消、backup の restore と import のクリアの前後で、対象の行の宣言の2列以外の列と、対象の Scene の `tree_nodes` の version と `updated_at` を byte で比べて同一である（version と token だけの比較にせず、`updated_at` を含める。本文版と project snapshot の restore では、既存の writer が同じ transaction で v1 の列を進めるので、この比較の対象にしない）。宣言と取消の後に、宣言した Scene について A1 の reader、A1 の保存、本文の保存、rename、project の registry の変更が成功し（`NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID` にならない）、`scope_extension_digest` の値は宣言の前と同じで、その行は `unavailable` の項目にならない。この試験は、宣言の writer に `updated_at` だけを書き換える変異を入れると失敗する（試験がその変化を検出できることを確かめる）。backup の restore と import の後も、その DB の各 Scene で v1 の token の照合が通る。取消の後に同じ値で再宣言すると、本文と束縛が同じでも宣言の ID が変わり、token が前の宣言と違う。宣言と取消の後も、既存の Revision の pending 判定は `Ok` のままで、project の Scope authority の identity は freshness で dirty にならない。B の sealed binding と Chronicle の IR の Index も current のままで、宣言の後に Graph と IR が unavailable にならない（G-01 の addendum で、宣言の時期を B の seal の後にできる根拠）。feed に入るのは新しい kind の event で、`scene-scope` の kind の event は入らない。v41 以前の backup を restore できる。
  - Negative: generic SQL、MCP、renderer の Drizzle、A1 の保存（宣言の欄を足した payload）による書込みを拒否する。A1 の保存はダイアログを起こさず（`GRANT_REQUIRED_COMMANDS` に載らない）、宣言の欄を足した A1 の payload は `deny_unknown_fields` で拒否する。宣言の ID か時刻を含む宣言の payload を拒否する（renderer は ID と時刻を選べない）。片方の列だけ、未知の版、未知の欄は unavailable になる。restore、import、Safe Mode からの restore の後に宣言が残らない（同じ bytes に戻した場合も）。複製、削除と同じ ID での再作成、ごみ箱からの復元で宣言が戻らない。取消の undo で宣言が戻らない。同じ request の再送で宣言が二重にならない。
  - Recovery: 書込みの失敗で部分的な状態を残さない。COMMIT の結果が分からないときは `graph-target-scene-body-disclosure` の行のとおり quarantine し、再起動の後は DB の状態で判定する。restore の後は、作者が改めて宣言する。
  - Lane unlocked if confirmed: CB-1（schema、migration、クリア）。CB-2〜4 は `graph-target-scene-body-disclosure` の行の確認も要る。
- 受入れへの影響（l6-l9:620）:
  - 保存範囲: Scene ごとの行に、作者の宣言と束縛の digest を足す。本文や excerpt は保存しない。データの種類は増える（作者の宣言）が、送信先は増えない。
  - schema: 版が1つ上がる（既定 v42）。schema の contract、版の assert、restore の扱い、protected writers を同じ PR で更新する（計画の merge 列の規則）。
  - 既存のデータ: 既存の行はすべて「宣言なし」になる。v1 の行の意味と、legacy-absent、unknown、explicit の扱いは変えない。
  - 失効の範囲: 宣言の操作は行の v1 の列（token と `updated_at` を含む）を書き換えず、feed も A1 とは別の kind で書くので、宣言のために既存の Revision、Index、履歴が失効することも、pending になることもない。逆に、v1 の token を進める既存の操作（本文の保存、registry の変更など）は宣言を失効させる。
  - 変えないもの: proposal/3 の他の条項、A1 の UI と IPC の v1 の payload。

### 変更前後

| 項目 | proposal/3（確認済み） | proposal/2 |
| ---- | ---------------------- | ---------- |
| Scene ごとの binding | A1 の軸、incarnation、marker、principal、version、source token | v1 はそのまま。宣言の component を nullable の2列で足す |
| v1 の version と token | 設定の変更、本文の保存などで進む | 同じ。宣言、取消、クリアでは進めず、行の v1 の列（`updated_at` を含む）を書き換えない |
| feed | A1 と registry の変更は `scene-scope` と `scope-registry` の kind で書き、project の Scope authority の変更として扱う | 同じ。加えて、宣言、取消、クリアは別の kind で書き、Scope authority の変更として扱わない |
| schema の版 | 41 | 1つ上げる（既定 42） |
| writer | A1 の保存、source token の refresh、restore 系 | 加えて、宣言（Main の確認）、取消、restore と import のクリア |
| 失効 | 設定と本文の変更で token を進め、旧資格を失効させる | 加えて、宣言は束縛の不一致で失効し、restore と import で消える |
| 保存しないもの | 本文、full closure | 加えて、excerpt、path の proof、grant、判定の結果、path の文字列 |

### 保存先

- table: 既存の `narrative_scene_scope_bindings`（`migrate.rs:4068-4099`）。Scene ごとに1行で、Scene の削除で行ごと消える。
- 列: nullable の2列。宣言の canonical JSON と、その token。列の名前と符号化は CB-1 で決める。
- 宣言の JSON に入れるもの:
  - 版付きの識別子（案: `narrative-scene-body-declaration/1`）。宣言ごとの ID（UUIDv4）と、宣言の時刻。どちらも宣言の writer が transaction の中で生成し、renderer、preload、Main の値を使わない（上の Mandatory defenses、下の「writer」の手順 5）。
  - 宣言の値（上の「宣言の値」の表）と、対象（本文の全体と title）。
  - 束縛: project ID、Scene ID、Scene の incarnation、宣言の時点の v1 の token、本文の Source（`project:scene:<id>`、`v{version}@{updated_at}`、storage digest、canonical digest、正規化の版、UTF-16 長）、title の digest、workspace ID、canonical locator の digest。
- token: 宣言の JSON の canonical な形から、ドメイン分離した SHA-256 で計算する。
- 置かないもの: 本文、excerpt、title の文字列、path の proof、grant、判定の結果、path の文字列、宣言の途中を表す marker。第二の table、Source kind、Freshness consumer。

### writer

- 入口: A1 の保存とは別の typed な入口を2つ（宣言と取消）置く。Main が command の名前だけで確認の要否を決められるようにする（DSN §7.2 の `GRANT_REQUIRED_COMMANDS`）。`GRANT_REQUIRED_COMMANDS` に載せるのは宣言の入口だけで、取消の入口（grant を要さない）と A1 の保存（`narrative_scene_scope_update`）は載せない。A1 の保存の payload には宣言の欄を足さない。DSN §7.3 は `BodyDeclaration` を消費する writer を `narrative_scene_scope_update` の本文宣言の分岐としているが、この draft はそれを採らない（A1 の保存はダイアログを起こさず、宣言の欄を足した A1 の payload は拒否する）。DSN は確認後に改める（「確認後の記録」）。新しい入口は D2a の route 台帳で internal に分類し（K3 の区分表に加える）、Native の入口で登録済みの caller と workspace を確かめる。PUB-G までは、宣言の入口の gate（`graph-target-scene-body-disclosure` の Mandatory defense 10）で閉じる。gate が閉じていれば、Main はダイアログを出さず、Native の preview、宣言の writer、取消の writer は DB を読む前に typed に拒否する。
- 宣言の手順:
  1. Main が sender と window を確かめ、Native の preview を呼ぶ。preview は現在の状態を読み（本文の読取は K1b の上限の内）、grant の binding を Native の中に保持する。要求の値が v1 の subset でない、veto（secret の foreshadow、secret な Chronicle event、POV の記録）に当たる、A1 が explicit でない、Scene が archive されている、本文が空か上限を超える、canonical locator を求められない場合は、preview を作らない。
  2. ダイアログで承認されたら grant を発行する。
  3. writer は、transaction を開く前に grant を消費する。失敗しても戻さない。
  4. 有限の待機（K1b）で、ほかの writer と直列になる write transaction（`BEGIN IMMEDIATE` 相当）を開き、grant の binding と現在の状態を照合する。本文の digest は transaction の中で計算し直す。照合するもの: OCC（v1 の version と宣言の token）、incarnation、本文の Source（token と digest）、title の digest、宣言の値の digest、A1 が explicit で解決済みであること、veto、workspace の束縛、lifecycle の revision。一致しなければ拒否する。
  5. 宣言の ID（OS の CSPRNG による UUIDv4）と時刻（Native の時計）を生成して宣言の JSON を組み、token を計算する。宣言の2列、feed（A1 とは別の object kind。上の Mandatory defenses）、idempotency の記録を書き、COMMIT する。行の v1 の列（`updated_at` を含む）は書かない。participant は COMMIT の終端まで保持する。lifecycle の edge と COMMIT の順序を固定する方法は CB-2 で決める（下の「U3 委任で決めること」）。
  6. 終端の証拠（COMMIT の成功、rollback の完了、結果不明からの quarantine）で後始末する。終端の証拠は writer の commit の経路の外では作れない型にする。結果が分からないときは、`graph-target-scene-body-disclosure` の「COMMIT の結果が分からないとき」のとおりに扱う。
- 取消: grant は要さない（開示を狭める方向のため）。宣言の2列だけを NULL にし、OCC と feed を同じ transaction で書く。行の v1 の列は書かない。取消の undo で宣言を戻さない。戻すには新しい確認を要する。
- 待機: 期限なしの DB mutex の待ち（`db.with_conn`、C5）を使わない。上限は K1b に従い、超えたら typed に失敗する。grant は戻さない。
- 再試行: Main も writer も暗黙に再試行しない。同じ request の再送には idempotency の記録を返す。

### 失効

失効には2つの仕組みを使う。

- 不一致による失効: 宣言の束縛のどれかが現在と違えば、reader と UI は失効として扱う。ほかの writer は宣言を消さなくてよい。
  - v1 の token による不一致は戻らない。同じ行の中では v1 の version が単調に増え、本文、title、A1 の変更は同じ transaction で v1 の version を進める（C2）。行が消えれば宣言も消える。このため、これらの変更で失効した宣言が再び一致することはない（DB 全体を戻す経路は、次の明示的なクリアで扱う）。
  - workspace の束縛（workspace ID と canonical locator）による不一致は戻りうる。folder を元の path へ戻すなどして両方が元の値に戻れば、同じ bytes に対する同じ作者の宣言が再び有効になる。これは許容する。判定は、次に Ready になったときの locator で行う（上の「canonical locator」）。
- 明示的なクリア: restore、import、Safe Mode からの restore は、宣言を NULL にする。DB 全体を戻す経路では、宣言、v1、本文がそろって過去の状態に戻るので、不一致だけでは失効しないため。

| 経路 | 例（コード） | 宣言への作用 |
| ---- | ------------ | ------------ |
| 本文の保存（エディタへの AI 出力の適用を含む） | `save_scene_body_bundle`（`scene_body.rs:342`、:802） | v1 の token と本文の Source が変わり、不一致で失効する。同じ文字列での再保存も失効させる |
| AI Apply | `apply_ai_tree_plan`、`undo_ai_tree_plan`（`domain_writes.rs:5180`、:5660） | v1 の token が変わり、失効する |
| bulk、順序と story time の操作 | `chronicle_bulk.rs:911`、`narrative_extraction/temporal_operations.rs:132`、:210、:496、:623、:690 | 同上 |
| rename | `tree_node_patch_with_authority`（`domain_writes.rs:3487`）、Codex の rename の波及（:746） | v1 の token が変わり（title を変えた場合は title の digest も変わり）、失効する |
| A1 と registry の変更 | `update_narrative_scene_scope`（`narrative_extraction/scene_scope.rs:1143`）、`update_narrative_scene_scope_registry`（:1322） | v1 の token が変わり、失効する。registry の変更は、project のすべての Scene の binding を列挙して v1 の version と token を進めるので（:1366-1375、:1410-1433）、timeline、worldline、layer を1つ足すだけでも project 内の宣言がすべて失効する |
| 本文版の restore | `revision_restore.rs:246-276` | 同じ transaction で宣言を NULL にする（同じ bytes に戻す場合も） |
| project snapshot の restore | `project_snapshots.rs:2933-2962` | 同じ transaction で宣言を NULL にする |
| backup の restore、Safe Mode からの restore | `backup_restore.rs:533`（staged DB の install）、:111 | staged DB の宣言の2列だけを NULL にしてから install し（このクリアは v1 の列を書き換えない）、Ready にする。v41 以前の backup も restore できる |
| import | `web_editor_handoff.rs:464` | 取り込む DB の宣言の2列だけを NULL にしてから Ready にする（このクリアは v1 の列を書き換えない）。import した Scene は新しい incarnation になる（l6-l9:471） |
| 複製 | 新しい Scene の作成 | 新しい行になり、宣言を写さない。新しい incarnation（l6-l9:471） |
| 削除、ID の再利用 | `tree_node_delete_with_authority`（`domain_writes.rs:3263`）、FK の cascade | 行ごと消える。再利用した ID は新しい incarnation になる |
| ごみ箱からの復元 | `trash_bin.rs:783` | 宣言は戻らない（削除で行が消えている） |
| 別の workspace | folder の複写、移動、別の path での open | canonical locator の digest が変わり、失効する。symlink 経由の open では変わらない。元の path（同じ workspace ID）へ戻せば再び一致する |
| workspace ID の変更 | `.grimodex/workspace.json` の id の変更 | 失効する |
| 宣言の取消 | 新しい取消の入口 | 宣言の2列を NULL にする（v1 の列は書き換えない） |
| veto の記録の追加（失効ではない） | secret の foreshadow か secret な Chronicle event を target に掛ける、既存の foreshadow や event を secret にする、Scene や beat の POV を設定する | 宣言の束縛は変わらなくても、reader が返却時と click 時に veto で拒否する。記録を外して束縛も一致していれば、同じ bytes の宣言は再び使える |

経路ごとに失効の試験を置く（CB-4。G-01 の addendum の負例を含む）。veto の記録を宣言の後に足す場合と外す場合の試験も置く。この表にない経路でも、本文、title、A1、incarnation、workspace のどれかが変われば、不一致で失効する。新しく本文や Scene を戻す経路を足すときは、明示的なクリアの要否をその PR で判定する。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-c-body-disclosure-proposal/2 for contractId scope-storage-authority.`

## 選択肢と推奨

### Option B（推奨）: 作者が本文全体を宣言する

- 中身はこの draft の2行。Graph は、作者が宣言した Scene に限り、R+IR にない Scene を1件追加できる。
- 新しい信頼仮定は、作者の宣言を本文の分類として信じること。範囲は Related Scenes の表示と遷移に限られ、ほかの出口は開かない。
- 実装は CB-1〜4（schema 1、writer と MG-1、UI、reader と再検証）。

### Option A: fail-closed のまま、G-01 の評価を改訂する

- この draft の2文を出さない。Graph-only target の本文、title、locator は出さない。Graph の寄与は、R+IR の Scene に path の Evidence を付けることだけになり、共通追加1枠は Graph では使わない。
- 固定 v1 の G-01 の期待値（R+IR+Graph = `[g01-question, g01-mira]`、Recall@8 0→1、nDCG@8 約 0.6309）には届かず、G-01 は HOLD のまま残る。Graph の「R+IR に対する事前指定の改善 1 件以上」（l6-l9:560、post-B §7.3）を満たすには、評価の契約を改める必要がある（例: 改善の指標を、R+IR の Scene に付く qualified な path Evidence にする）。post-B §7.1 は、事後に Evidence の追加を検索の改善と読み替えることを禁じている。このためこれは解釈ではなく契約の変更で、`g01-eval-revision` の新しい draftRef として観測前に起案し、独立した期待値の review とユーザーの確認を得る（K6 の /1 の同じ行は、指標を変えない S1 の改訂だけを扱う）。
- 製品では、Graph は R+IR が見つけた Scene に説明（path）を足すだけで、新しい Scene を見つけない。
- CB-1〜3 は不要になり、CB-4 は「Graph-only の枠が閉じていること」の試験に縮んで CP-3a に入る。MG-1 は DA-2（D2a の activation）で、VerifiedWorkspaceBinding は K4 の durable identity で必要になるので、これらの作業は別のレーンへ移るだけで残る。

### 比較

| 観点 | Option B（推奨） | Option A |
| ---- | ---------------- | -------- |
| 製品の挙動 | 宣言した Scene を Graph が追加できる | Graph は path の Evidence を足すだけ |
| 新しい信頼仮定 | 作者の宣言 | なし |
| 保存と schema | nullable の2列（既定 v42） | なし |
| 確認 | この2文 | `g01-eval-revision` の新しい draftRef（評価契約の改訂） |
| G-01 | 固定 v1 のまま、addendum の setup で正例に届きうる（実測は CP-4。B-ROUTE による B の seal が前提） | 固定 v1 は HOLD。改訂した G-case で判定する（B-ROUTE による B の seal が前提なのは同じ） |
| NIR-1 の完了 | 固定の比較で判定できる | 改訂が確認されない限り、Graph の受入れは完了しない |
| PUB-G の目安 | D+20〜25 | D+17〜22（改訂が Session B で確認された場合） |
| E の目安 | D+35〜40 | 同じ（差は 0〜1 日） |
| 主なリスク | 失効が多く可用性が低い（registry の変更で project の宣言がすべて失効する）。Main の確認、lifecycle、3 OS の path の実装 | 改訂が否決されると Graph が完了しない。Graph の価値が下がる |

推奨は Option B。Option A で早まるのは PUB-G だけで、NIR-1 の完了（E）は local 送信の鎖で決まるので早まらない。そのうえ Option A は、Graph の主な価値（R+IR が見つけない Scene の発見）を失い、否決されうる評価契約の改訂に完了を預ける。Option B の新しい信頼仮定は、作者自身の端末で、作者が確認した Scene の表示にだけ働き、失効と veto は fail-closed に倒れる。

### ほかに検討して採らない案

- 既存の記録（foreshadow、Chronicle event、phase、beat の POV、mention）から本文の分類を導く案: 記録が本文の全体を網羅している証明がなく、「記録がない」を「秘密がない」と読めない。
- worker が本文を読み、frame で運ぶ案: 原稿が子 process の pipe を通る新しい経路になり、frame の予算と C-resource の証跡が変わる。parent で exact に照合する方式（DSN §2.3、§2.5）に比べて利点がない。
- pin や Relation の Evidence を本文の開示の根拠にする案: pin は locator で、Relation が本文で成り立つ証拠ではない（候補 §2）。
- excerpt を出さず、title と遷移だけを出す案: title と遷移も Graph の結果としての開示で、同じ authority が要る。遷移すれば本文の全体が表示される。
- Scene ごとの「公開」の flag（本文に束縛しない）: 本文を変えても失効せず、宣言の後に書いた本文まで開示してしまう。
- veto を foreshadow と POV に限り、Chronicle event の秘匿を含めない案: secret な event の reveal の Scene と、event を結んだ Scene は、foreshadow の payoff と同じく、本文が秘密を含むか明かすことを示す記録である（C9）。含めないと、既知の記録と矛盾する `non-secret` の宣言で開示してしまう。含める代わりに、そうした Scene は v1 では宣言できない（可用性が下がる）。
- Graph-only の候補の不一致でも Graph の寄与を全体で 0 にする案（DSN §2.3 の (d) のまま）: 開示の安全性は変わらない（どちらも Graph-only の行を出さない）。しかし、R+IR の path の付加が消えることや Graph の全体の理由 code から、Graph-only の候補があったことを renderer が判別できる。K1 の C-body の fail-safe（「R+IR の結果はそのまま残る」）とも合わない。
- 評価用の CI seam が承認できる宣言を、addendum が固定した値（`g01-mira` の canonical digest と title の digest、宣言の値）に限る案: packaged でない起動で env をそろえた者でも、fixture 以外の Scene は宣言できなくなる。しかし、その者は同じ権限で DB を直接書けるので、悪意のある者に対して守れる範囲は増えない。誤った起動で seam が有効になることは、owner token の env の照合で起こりにくくしてある。この案は Main に評価の fixture の値を持たせ、宣言が要る評価を足すたびに Main を変えることになる。v1 では採らず、残余を Out-of-scope に記録する。
- 宣言を v1 の token ではなく A1 の軸の値に束縛し、registry の変更や順序の操作では失効させない案: 失効は減るが、v1 の token（A1 の状態と registry を含む）とは別の束縛の規則を新しく作ることになり、どの変更が宣言に影響しないかを経路ごとに示す必要がある。v1 では採らず、registry の変更などで失効した宣言は UI で知らせて再宣言を促す（CB-3。下の「U3 委任で決めること」）。

## critical path への影響

前提（計画の目安と同じ）: D は Wave 1 の開始日。Session B は D+3〜5 に返り、K2 を先に出す。merge の列は1本で、1日あたり 3〜6 本。CB-2 は高リスクの PR として、lifecycle とセキュリティの reviewer を2名にする。数値は目安で、実測ではない。

| 段 | Option B（推奨） | Option A |
| -- | ---------------- | -------- |
| 確認 | この2文を Session B で（D+3〜5） | `g01-eval-revision` の新しい draftRef を起案して Session B に入れる。間に合わなければ別の回で +3〜5 日 |
| C-body | LEDGER-1 の後、CB-1 の merge は D+7〜8、CB-2（MG-1 を含む）は D+11〜13、CB-4 は D+14〜17。CB-3 は CB-2 と並行。CB-4 は CB-1 と CP-1 の後に並行して作り、CB-2 の後に merge する | なし |
| G-01 の固定 | addendum を観測前の commit に入れる（0.5 日、並行） | 改訂した fixture、期待値、独立 review を観測前に固定する（1〜2 日、並行） |
| CP-3b | CB-4 の後、D+16〜19 | CP-2a と DA-2 の後、D+13〜17 |
| CP-4 | D+18〜21 | D+15〜19 |
| PUB-G | D+20〜25（計画の目安のまま） | D+17〜22 |
| E | D+35〜40（PUB-L の鎖で決まる） | 同じ |

- 差は PUB-G で3日前後。E は local 送信の鎖（K4、K5 → DF+ → DT-5、HC-1 → DI-1 → DD-1 → PUB-L）で決まるので、Option A でも早まらない。merge の列が数本空く分の差は 0〜1 日にとどまる。
- Option A でも MG-1（DA-2 の ProfileActivation）と VerifiedWorkspaceBinding（K4）は作るので、減る作業は CB-1、CB-3 と、CB-2、CB-4 のうち宣言に固有の部分。
- Option A の評価の改訂が否決されれば、C-product と Graph の受入れは HOLD のままになる。その場合は PUB-G だけでなく、C を条件に含む PUB-L（Packing の製品公開条件、l6-l9:432）と NIR-1 の完了にも届かない。
- Option B の遅れの主な要因は CB-2。K2 が Session B より遅れると、その日数だけ PUB-G が遅れる（計画の最大のリスク）。
- S1 では G-01 の R と R+IR が期待どおりだったので（C14）、「S1 が期待と違えば C-body に投資する前に停止点へ回す」条件は起きていない。一方で、S1 は B の sealed binding を製品の経路で作れないことを見つけ、計画は B-ROUTE（B の build を正規の maintenance の経路に配線する。確認は不要）を CP-4 の前に足した。B-ROUTE は Option A と B のどちらでも CP-4 の前に要るので、両者の差には影響しない。B-ROUTE が遅れれば、どちらの PUB-G も同じだけ遅れる。B-ROUTE で正規の経路を作れなければ、G-01 はどちらの Option でも Hold で、`[precheck]` でユーザーの判断に回す。

## U3 委任で決めること（この draft で固定しないもの）

- 列の名前、JSON の符号化、版付きの識別子の文字列、feed の object kind と op の名前（A1 と別の kind にすることと、Scope authority の変更として扱わないことは固定）、idempotency の domain。宣言、取消、クリアの書込みが宣言の2列だけを書き、行の v1 の列（`updated_at` を含む）を書き換えないことと、宣言の ID と時刻を宣言の writer が生成することは固定する。
- lifecycle の edge と COMMIT の順序を固定する仕組み（seam を使った final-commit reservation など）、fence の順序、終端の証拠の型。CB-2 の有限の owner/lifecycle matrix に書く。仕組みは、通常の participant（原稿の保存や読取）を止めず、COMMIT を lifecycle の lock の中で行わないこと。
- grant の内部 API（DSN §7.2）と、Main での横取りの実装。
- unavailable の理由の code の名前（閉じた集合であること、target を識別しないこと、Graph-only の追加について候補の有無と不適格の理由を区別しないこと、Graph-only の候補の失敗で Graph の全体の理由 code を使わないことは固定）。
- 「利用時の判定」の手順 3 の中の項目の順序（すべてを満たすことと、本文の読取を1件以下にすることは固定）。
- 宣言の入口の gate を開く Main 専用の N-API の名前と形（既定で閉じること、PUB-G の前は CI seam が有効な起動だけで開くこと、renderer、preload、IPC から開けないことは固定）。
- 評価用の CI seam の env の名前、receipt の形。G-01 で宣言を setup で行うか測定の workspace で行うか（上の (i)、(ii)。CP-0 が観測の前に決める）。gate の条件、承認の範囲、宣言の段に使う Main は、上の「Main の一回限りの確認」で固定する。
- module の配置と、UI の配置（CB-3。草案、宣言済み、現在有効の3つを区別して表示する）。registry の変更などで失効した宣言を作者に知らせ、改めて宣言するよう促す表示も候補にする（宣言は Scene ごとに確認を要する）。
- K1b の数値（integrator が実測から選び、PR に記録する）。
- 決めた内容は、mutation の前に PR 本文とレーンの decisions に記録する。この draft の actor、攻撃の範囲、防御、保存の範囲、開示の範囲、受入れを変えることになる場合は `[precheck]` で止め、新しい draftRef で起案する。

## 確認後の記録（この draft の外で行う）

- LEDGER-1: 確認された draft を byte 同一で取り込む。台帳に `graph-target-scene-body-disclosure` の行を加え、`scope-storage-authority` の行に proposal/2 の差分（confirmedRef `nir1-c-body-disclosure-proposal/2#scope-storage-authority`）を加える。どちらにも、この draft の SHA-256 と確認文を記録する。proposal/3 の確認は置き換えない。
- l6-l9:28 の C-body の HOLD の行を更新する。
- master の旧 draft 2本と、2026-09-25 の /1 に superseded の注記をする（G0 の banner とそろえる）。
- DSN §7.3 の `BodyDeclaration` の binding に、title の digest、storage digest、宣言の現在の token、ダイアログの表示文の digest を足す。DSN §7.3 の消費する writer を、`narrative_scene_scope_update` の本文宣言の分岐から、この draft の宣言の入口に改める（取消の入口は grant を要さない）。DSN §7.2 の `GRANT_REQUIRED_COMMANDS` には宣言の入口の command だけを載せ、`narrative_scene_scope_update` は載せない。DSN 側の修正は、`scope-storage-authority` の Negative（A1 の保存はダイアログを起こさず、宣言の欄を足した A1 の payload は `deny_unknown_fields` で拒否する）を満たすこと。DSN §2.3 を、この draft の「利用時の判定」に合わせて改める。(d) の all-or-nothing の範囲を、R+IR の Scene に付ける path の association に限る。Graph-only の候補の (b)、(c) の不一致、本文の照合の失敗、K1b の上限の超過は、追加1枠を出さないことだけにし、Graph の全体の理由 code を使わない。DSN §1.5 の理由の集合に、Graph-only の追加についての1つの code（`graph-target-scene-body-disclosure` の Mandatory defense 9）を加え、返却時の Graph の全体の理由としての `invalidated` と `limit` を、Graph-only の候補に依存しない原因に限る（click 時の遷移の拒否は、同じ Mandatory defense の対象外の項目のとおり）。DSN §7.4 の admission closure の「grant を使う機能の gate」に、宣言の入口の gate（同じ行の Mandatory defense 10）を加える。
- K3 の route の区分表に、宣言と取消の入口を internal として加える。
- 確認されなかった行は、HOLD 表に `[precheck]` として残す。Option A が選ばれた場合は、`g01-eval-revision` の新しい draftRef（指標の変更）を起案する。

## 確認文

確認は contractId ごとに次の 1 文で行う（l6-l9:108）。

- I confirm draftRef nir1-c-body-disclosure-proposal/2 for contractId graph-target-scene-body-disclosure.
- I confirm draftRef nir1-c-body-disclosure-proposal/2 for contractId scope-storage-authority.
