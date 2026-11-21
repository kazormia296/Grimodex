# NIR-1 D2a 契約提案 proposal/1（draft）: Graph を外部送信の制限（restricted）なしでも使えるようにする

Status: 確認済み（2026-11-20、確認の記録 contracts `11dc9eda`）。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない。内容を変えるときは新しい draftRef にする

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-d2a-graph-unrestricted-proposal/1`（K3/2・K3/3 の連番ではなく、Graph の行だけを改訂する別の系列。K3/2 の Graph の行の改訂で、contractId は同じ） |
| contractId | `caller-profile-egress`（K3/2 `nir1-d2a-activation-proposal/2#caller-profile-egress` の **Graph の行だけ**の改訂） |
| 置き換えるもの | K3/2 の「区分の構成」の表の Graph の行（unrestricted は Graph を出さず `profile-not-restricted`、restricted は二重の gate を確かめてから出す。`docs/plans/nir1-d2a-activation-proposal-2-draft.md:439`、`:449`）。K3/2 のほかの行、K3/3、K5/3 の行は変えない（加算で並ぶ） |
| 確認の記録 | contracts `11dc9eda` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-20-pubg-pivot-confirmations.md` の確認 2。その前の方向の回答は contracts `5e02e4f2` の `user-confirmation-2026-11-19-ai-disclosure-and-pubg-scope.md`（回答 3 と 2026-11-20 未明の追記 1。「案 A で進める」）。どちらも `claude/nir1-contracts` の commit で、この枝は master に merge しないので hash で引く |
| 基点 | 起案時の worktree HEAD `04202c37`（origin/master の子孫）。行番号はこの commit のもの。read-only で、build・test は行っていない。主張には「ファイル:行」、推測は【推測】、読みで確定できないものは【未確認】と書く |
| 草案の作業材料 | `/home/grimodex/fusion-eval-data/design-notes/pubg-pivot-2026-11-19/`（`graph-restricted-draftref-v2.md`、点検 `consistency-check-v2.md`）。contracts の外の材料で、この file が正本 |

## 1. 確認した内容（何を許し、何を許さないか）

確認の問いは、技術語を避けた次の 3 行にまとめた。技術の根拠は §2 以降に置く。

- **許すこと**：外部送信の制限（restricted）を有効にしていない作者にも、関連シーンに Graph の結果を出す（Graph の公開の gate が開いた後）。制限を有効にしているときは、今までどおり外部送信の停止を確かめてから出す。Graph の公開条件から「D2a（制限が前提）」を外す（Graph の機能が D2a を要らなくなるため。D2a は local 生成と、その送信準備の前提としては残る）。
- **許さないこと**：Graph の応答（場面の title、先頭の 1 行、経路の Evidence の文）を、AI への送信、Packing、履歴、書き出し、audit に載せること。新しい送信先、保存範囲の拡大、閾値の変更もできない。Graph の公開（PUB-G、Session C-1）そのものは含まない。
- **条件**：実装の前に、§5 の未確認の点を確かめる。問題があれば、実装を止めて改めて伺う。

回答（2026-11-20）：**確認し、D2a の前提も外す（推奨）**。

## 2. 経緯と前提の訂正

### 2.1 先に直す前提

- 「IR が restricted の間だけ renderer に届く」は合わない。R／IR／A2 の reader は区分 `nir1-publication` で、unrestricted では検査なしで通る（`electron/main/profileEgress.ts:228-236`、`electron/native/grimodex-node/src/publication_guard.rs:1-8`、DSN §4.2 の表 `docs/plans/nir1-dsn-2026-10.md:517`）。
- Native が追加で restricted を要求するのは Graph だけ。要求は 2 つの役割を兼ねている。
  - 「restricted が必須」（今回外すもの）。
  - 「restricted なら停止確認済み」（残すもの。§2.4）。
- したがって「3 か所を削除」とは書かない。3 か所の条件 `restricted && in_flight_stopped` を、`!restricted || in_flight_stopped`（restricted のときだけ停止確認済みを要求）に置き換える。
  - `electron/native/grimodex-node/src/nir1_graph_product.rs:1302-1304`（begin の admit）。
  - 同 :2809（owner thread の `admit`。`PublicationGuard` の下にない）。
  - `electron/native/grimodex-node/src/related_scenes/graph.rs:600-603`（`gate_reason`。呼出しは graph.rs:738、:780、`graph_response.rs:490`、:513）。

### 2.2 系譜（確認できたもの）

| 時期 | 出来事 | 出典 |
| --- | --- | --- |
| 2026-09-12 | L6〜L9 の計画（#571）で D2a を「restricted plaintext 公開の activation 前提」として追加。「Graph は A3＋B＋C＋D2a」 | `docs/plans/narrative-ir-nir1-implementation-plan.md:36`、:47、:512。実行計画の PUB-G の行 `docs/plans/nir1-l6-l9-execution-plan.md:800`、:810 |
| 同 | A8「新しい送信先やデータ分類への送信は未承認。既存の送信同意を新しい IR/Graph 情報の外部送信許可へ自動拡張しない」 | `narrative-ir-nir1-implementation-plan.md:127` |
| 2026-09-13 | R0（#576）。proposal/3 の D2a（profile 全体の local-only、制限は解除しない）をユーザーが確認 | 実行計画の台帳 :374 |
| 2026-10-13 | `GraphUnavailable::ProfileNotRestricted` を C-query の製品 owner（CP-2a、#655）が初めてコードに置く。SB-1（外へ出ない機能は restricted でも開く）は同日 | `nir1-continuation-2026-10.md` の SB-1 |
| 2026-10-17 | K3/2 を Session B1 で確認。「区分の構成」の表に Graph の行：unrestricted は「Graph を出さず `profile-not-restricted`」、restricted は「二重の gate を確かめてから出す」 | `docs/plans/nir1-d2a-activation-proposal-2-draft.md:439`、:449。台帳 `nir1-l6-l9-execution-plan.md:380`。DSN §4.3 `nir1-dsn-2026-10.md:546` |
| 2026-10-23 | CP-3a（#698）が返却時の `gate_reason` を足した（公開は閉じたまま） | `related_scenes/graph.rs:593-604` |

### 2.3 ユーザー決定の有無と起点の推測

- 「Graph を restricted 限定にする」と名指したユーザー決定は、**見つからなかった**。SB-1（O-2）は「外へ出ない機能を restricted でも開く」話で、Graph の mode 条件を扱っていない。
- 2026-11-19 の記録（回答 3）が、この条件を初めてユーザーに示した。「制限なしでも使えるようにしたい」。
- 起点は 2026-09-12 の計画（D2a が Graph の前提、A8）と見ている【推測】。K3/2 の本文に、Graph の行だけ unrestricted で出さない理由は書かれていない（起案時に `二重`、`Graph を出さ` で grep した範囲）。

### 2.4 起案の前に確かめた 2 点（読みの結果）と、読みで見つけた点

#### (a) `PublicationGuard.finish` は Graph の返却を覆うか：覆う（読みで確定。ただし §5 の click handle は未確認）

- `electron/native/grimodex-node/src/lib.rs:13419-13432`（`related_scenes_graph_continue`）：admit → `graph_continue` → `guard.finish` → 返却の順。
- `related_scenes_begin` は `related_scenes/begin.rs:20` で finish し、失敗なら operation を release する。
- Graph の click（`graph_response.rs:483` の `click`）は `nir1_evidence_qualify`（lib.rs:13471-13484）の `finish` の下にある。
- `recheck_publication`（`profile_egress.rs:757-777`）：unrestricted で admit した後に restricted になっていれば、結果を捨てる（「publication completed after profile restriction began」）。restricted で admit した場合は、revocation generation と登録済み identity を再確認する。
- したがって `gate_reason`（graph.rs:600-603）の「restricted が必須」の検査は、**返却時の再確認としては不要**になる。mode をまたぐ守りは `finish` が持つ。`gate_reason` に残すのは「restricted なら停止確認済み」だけ。

#### (b) unrestricted での cache key の意味は壊れないか：壊れない（読みで確定。ただし §5 の activation をまたぐ operation は未確認）

- `CacheKey`（nir1_graph_product.rs:837-844）は `binding`、`caller_epoch`、`project_id`、`query_scene_id`、`seed_entity_id`。`caller_epoch` は `status.caller_epoch`（:1317）。
- unrestricted では `caller_epoch` は定数（新規 profile は 0、`profile_egress.rs` の起動時の gate の Row 1）。first restricted の activation でだけ +1 する（:316-320）。
- よって unrestricted で作った cache entry は、activation の後は key が合わず使われない（`take_usable_cache` :669-690）。「Graph の次 query 用の cache は D2a の epoch の変化で捨てる」（K3/2 :197）は、key の不一致で保たれる。遅れて届いた結果の `store_late_cache`（:699）も旧 epoch の key で入るので、restricted では当たらない。
- cache は caller の identity（sender）では分けていない。これは現行の restricted でも同じで、本件で変わらない。

#### (c) 読みで見つけた、起案に入れる点

1. **「restricted なら停止確認済み」を残す。**
   - unrestricted の `in_flight_stopped` は構成上つねに true（`profile_egress.rs:231-262`。Row 4 は `(false, true)`、Row 1 は `loaded(.., 0, false, false, true)`）。false になるのは restricted の barrier 中だけ（:419-424、:467-481）。
   - owner thread の `admit`（nir1_graph_product.rs:2809）はどの `PublicationGuard` の下にもなく、K3/2 の「activation の完了の前に Graph と生成を作らない」（:162 の Negative (3)、:303、:325）を支えている。ここを外すと、barrier 中に worker が走りうる。
2. **理由コード。** 今は「restricted で停止未確認」も `profile-not-restricted` を返す（graph.rs:600-603、nir1_graph_product.rs:1303-1304）。「restricted が必須」を外すと、この理由は **restricted の barrier 中だけ**になり、名前が合わなくなる。
   - 選択肢は、(i) 既存の別の理由（例 `not-activated`、`warming`）に寄せる、(ii) 新しい理由を wire に足す（`electron/shared/relatedScenesSearchWire.ts:120`、S4 が pin する harness の `scripts/quality/nir1-graph-eval/join.mjs:14` ほか）。
   - draftRef は「restricted で停止未確認のときは Graph を出さず、unrestricted の案内（activation の導線）を出さない」までを書き、理由コードは実装で決める。wire に語を足す場合は、追記か別の確認にする。【未確認】
3. **他に restricted を条件にする所はない（読みで確定）。** `restricted` を `narrative_maintenance.rs`、`electron/main/events.ts`、`relatedScenesSearchAuthority.ts`、`related_scenes/`（test を除く）で引いた。残るのは graph.rs:601 と、`related_scenes/begin.rs:9` のコメントだけ。renderer では `src/features/related-scenes` の `profile-not-restricted` の分岐（`RelatedScenesSection.tsx:116`、`Nir1GraphRelatedScenes.tsx:135-140`、`nir1RelatedScenesGraphJoin.ts:19`、`nir1GraphAvailability.ts:10-11`）だけ。index の構築や ready の通知は restricted を条件にしていない（`nir1_graph_product.rs` の `restricted` は :1303、:2809 の 2 か所のみ）。
4. **公開の gate は変わらない。** Graph は `publication_is_open`（PUB-G の gate。nir1_graph_product.rs:1359）が閉じている間は `NotActivated` のまま（:1298。graph.rs:596-598）。この変更は Graph を公開しない。

### 2.5 整合の点検：「unrestricted で Graph の応答が chat に混ざらない」

#### AI の経路の registry 全体（`src/features/ai-verification/aiPathRegistry.ts`、70 entry。`AI_PATHS` 69＋runtime route 1。起案時は型宣言の 2 行を含めて 72 と数えていた。確認の記録の要旨に件数はない）

- entry の id を全件並べ（chat_agent_main から codex_app_server、local 生成まで）、`graph`、`related`、`関連` で引いた（`captureLevel` の行を除く）。Graph の応答や `nir1GraphApi` を入力にする entry は **0 件**。ヒットは `関連 Entity`（:909、setup 信号の説明）と、semantic の `関連シーン候補のローカル再順位付け`（:1558、:1572。LLM 生成でなく、Graph ではない）だけ。
- **ただし、Graph の owner（Native の product owner）を使う AI の経路が 1 つある。** local 生成の D-final（`nir1_prepared_request.rs:1040-1062` が `request_graph` を呼ぶ。registry の `nir1_local_generation_writing`／`_review`、`:1492` 以降）。入力は ID とトークンだけで、participant read が requalify する（`nir1_graph_dfinal.rs:1-17`）。
  - D-final は自前の gate で **restricted 限定のまま**残る。準備は `with_authorized_preparation`（`profile_egress.rs:702-712`、`state.restricted && state.in_flight_stopped` を要求）を通り、IPC は `nir1-restricted-only`（`profileEgress.ts:257-264`）。owner 側の restricted の要求を外しても、D-final は unrestricted で Graph に届かない（D-final の入口が先に拒否する）。
  - ただし owner の restricted の要求は、D-final への防御の二重目でもあった。外した後は D-final の gate 単独で守る。**受入れに「unrestricted で D-final が Graph の owner に届かない」を足す。**
- 結論：「**renderer に返る Graph の応答を参照する AI の経路は 0**。owner を使う AI の経路は D-final（local 生成）だけで、restricted 限定のまま」。

#### renderer 側（読みで確定）

- `related-scenes` の外から Graph の API を import するのは、UI の `SceneContextPanel.tsx:4`（`RelatedScenesSection`）、`EditorPane.tsx:219-220`（Evidence の遷移）、`useSceneBodyDeclaration.ts:16`（`nir1GraphOnlyRevocation`）だけ。`graphOnly`、`pathAttachments` を `related-scenes` の外で参照するファイルは 0（test を除く）。
- `related-scenes` の中で、`localStorage`／`sessionStorage`／IndexedDB／chat の store に書くコードは 0。DB は Drizzle の seed 候補の**読み**だけ（`nir1GraphSeed.ts:1`、`nir1GraphSeedCandidates.ts:1`）。`src/features/chat` で関連シーンを参照するのは `semanticRecall.ts` だけで、Graph ではない。
- MCP（`src-tauri/crates/grimodex-mcp/src`）に `nir1_graph`、`related_scenes` の参照はない。
- 残余：画面に出た Graph の title や先頭の 1 行を、利用者または乗っ取られた renderer が chat の入力に写せる。これは今の R／IR／本文と同じ形で、K2/4 と K5/3 の B-1 の残余 (3) が受け入れ済み（`nir1-c-body-disclosure-proposal-4-draft.md:210`、:250）。

#### ADR（AI への開示）との関係

Graph の応答（path Evidence、excerpt）は画面だけに使い、AI の送信は元データ（場面本文）を各経路の読み取り口から渡す（ADR 013 の J1）。「Graph の応答を AI に載せない」は経路の契約で、データの秘匿ではない。IR 派生の応答は J1 の「全部開示」の対象外。

## 3. 契約の改訂

### 3.1 contractId `caller-profile-egress` の Graph の行

改訂前（K3/2 `nir1-d2a-activation-proposal-2-draft.md:449`）：unrestricted は「Native は Graph を出さず `profile-not-restricted` を返す」、restricted は「Native が二重の gate を確かめてから Graph を出す」。

改訂後：

- IPC の区分は `nir1-publication` のまま（変えない）。
- Native は、PUB-G の gate が開いていて、かつ「unrestricted、または restricted で停止確認済み」のときに Graph を出す。restricted で停止未確認のときは出さない。
- 返却時は `PublicationGuard.finish`（unrestricted で admit した後に restricted になれば結果を捨てる）と、restricted の再認可が守る。
- Graph の応答は画面（Related Scenes の表示と遷移）だけに使う。AI の送信、Packing、履歴、export、audit に載せない（K2/4 :250 と Mandatory defense 2 のまま）。

### 3.2 改訂が及ぶ箇所（文書）

実装の PR で、新しい draftRef 側から次を改訂する。この draft の取り込みでは、K3/2 の本文の bytes は変えない（台帳に「Graph の行は改訂で置き換え」の注記だけを足す）。

- K3/2：:151（Graph の二重の gate の規則）、:162 の Negative (3) の Graph の部分と (7)「unrestricted で Graph を出さない」、:161 の Positive (1)、:170-174（CP-4 の mode）、:176 の「変えないもの」の Graph の公開条件、:229（PUB-G 以降が止まる理由）、:303、:325（owner を restricted まで `Disabled` にする規則）、:439、:449。
  - :303、:325 は「restricted 向けの Graph の結果を activation の完了の前に返さない（`finish` と owner の `admit`）」に言い換える。「Graph を作らない」は unrestricted では成り立たなくなる。
- T-1（:206、:242）：activation の導線の 2 つのうち、「Graph が `profile-not-restricted` で unavailable のときの案内」は無くなる（Graph 側の案内が消える）。設定の専用の項目と local 生成の案内は残る。
- DSN §4.2（`nir1-dsn-2026-10.md:533`）と §4.3（:546）の Graph の記述、§1.2（owner の key と gate）、§3.3（cache は D2a の epoch で捨てる。key で保たれる、と書く）。
- 実装計画の Graph の公開条件「A3＋B＋C＋D2a」（`narrative-ir-nir1-implementation-plan.md:36`、:47。実行計画 :800、:810 の PUB-G の行）：確認 2 の回答により、D2a を外して「A3＋B＋C」に改める（§3.4）。

### 3.3 変えないもの

- IPC の台帳（`profileEgress.ts:228-264`）と、`nir1-publication`／`nir1-restricted-only` の区分。
- restricted の挙動（R／IR／A2／Graph とも。identity と stop barrier の要求）。
- D-final と local 生成の restricted 限定（`with_authorized_preparation`、`nir1-restricted-only`）。
- 外へ出す経路（旧 AI、CLI、Codex、MCP、外部 URL）の閉鎖。
- 閾値（Gold、P、24 件と G-01〜G-08、K1 の値）、CP-4 の restricted の測定値。
- Graph の公開（PUB-G の gate、Session C-1）。この改訂は公開を認めない。
- Graph の追加の場面の A1 の一致（`nir1_graph/scenes.rs:787-847`）と、path 側の規則（`nir1-c-body-disclosure-proposal/5` の範囲）。
- IR admission と Graph の path 規則（公開の後に見直す）。

### 3.4 公開条件の D2a の扱い：外す（確認 2 で回答済み）

- 案 A が成り立つと、Graph の機能が D2a を必要としなくなる。ユーザーは確認 2 で、Graph の公開条件「A3＋B＋C＋D2a」から D2a を外すことも確認した。
- D2a（activation の UI、DA-2、K3/2 の開示）は、local 生成（PUB-L）と D-final の前提として残る。Graph の公開条件としては要らなくなる。
- この確認は Graph の公開そのものを許可しない。PUB-G の公開の承認（Session C-1）は別に要る。製品の公開の範囲を変える点は、確認 2 で扱った。

### 3.5 受入れ

1. unrestricted でも、PUB-G の gate が開いていれば Graph が出る（`related_scenes_graph_continue` が `path`／`graphOnly` を返す）。gate が閉じている間は `not-activated` のまま。
2. AI 送信、Packing、履歴、export、audit に Graph の応答（excerpt、title、path Evidence の文）が載らない（K2/4 Mandatory defense 2 の試験を unrestricted でも通す）。
3. 新しい送信先がない：IPC の台帳が変わらない（`d2aRouteLedgersForTest` の試験）。renderer の外向き通信の遮断（NC-1／MD-1）は mode を問わない（NC-1 は #683 で master、`rendererContainment` が mode に依らないことの根拠。整合の点検で確認）。
4. unrestricted で D-final と local 生成が Graph の owner に届かない（`nir1-restricted-only` の拒否と `with_authorized_preparation`）。
5. restricted の挙動が変わらない。restricted で停止未確認のときは Graph を出さない（barrier 中、owner の `admit`）。
6. activation をまたぐ：unrestricted で admit した Graph の応答は、activation の後に `finish` が拒否する。cache は `caller_epoch` の不一致で再利用されない。finish 失敗時に click handle が使えない（§5 の 1）。
7. R／IR の parity は変わらない（K3/2 Positive (1)）。

### 3.6 CP-4

- 測定は今まで restricted（`scripts/quality/nir1-graph-eval/trace-runner.mjs:141` の `D2A_MODE = "restricted"`、:848、:857。K6/2 の手順 1）。restricted の測定値は無効にならない。
- **最後の凍結で、unrestricted の Graph の parity を測り足す。** R、R+IR、R+IR+Graph の membership と順位が、同じ fixture（24 件と G-01〜G-08）で restricted と unrestricted で同じであること。**閾値は変えない。** 結果が違えば、改めて確認する。
- Gate の差だけで同じ値になる見込みだが【推測】、測っていない。harness の変更は S4 が pin するため、S4 の枝にまとめ、凍結の前に単独で merge しない。

### 3.7 実装の PR の範囲

- Native の 3 か所（nir1_graph_product.rs:1302-1304、:2809、related_scenes/graph.rs:600-603）。条件を `!restricted || in_flight_stopped` にし、理由コードを実装で決める。
- wire と guidance：`relatedScenesSearchWire.ts:120`、`nir1RelatedScenesGraphJoin.ts:19`、`Nir1GraphRelatedScenes.tsx:135-140`、`RelatedScenesSection.tsx:116`。理由を残すか、足すか、消すか。
- 試験：`nir1_graph_product_tests.rs:440`、:1755、`nir1_graph_eval/tests.rs:301`、`related_scenes/graph_tests.rs:384`、:1634、renderer の `RelatedScenesSection.profileActivation*.test.tsx`、`Nir1GraphRelatedScenes.test.tsx:190`。
- S4 が pin する harness：`scripts/quality/nir1-graph-eval/join.mjs:14`、`followup.test.mjs:1331`、`availability.test.mjs:773`。【推測】どれが pin 対象かは未確認。最後の凍結の枝（S4 の枝）にまとめる。
- 文書（K3/2 と DSN、台帳）は §3.2 のとおり。1〜2 PR。
- `nir1-c-body-disclosure-proposal/5` の PR-1（`scene_disclosure` 側）と、この改訂の Native の PR は別の file だが、同じ gate を触る。merge の順は PR-1 → この PR（実装の PR の DR で決める）。矛盾はない（点検の結果）。

## 4. 変わるものと変わらないものの要点（読み手向け）

- 外すのは Graph の「restricted が必須」だけ。restricted の挙動、D-final、外へ出す経路の閉鎖、閾値は変わらない。
- Graph の応答が AI に渡らないことは、今までどおり経路の契約で守る。新しい送信先はできない。
- 読みで支障は見つかっていない。ただし実装の試験と、最後の凍結での unrestricted の parity の測定の結果が違った場合は、改めて伺う。

## 5. 実装前の確認事項

確認の対象ではなく、実装の PR の前に確かめる技術事項。問題があれば実装を止めて、新しい draftRef で改めて伺う。

1. **finish が失敗した後の click handle の扱い。** `graph_continue` の `value` 構築の途中で `keep_click`（graph_response.rs:468）が click handle を lease に残す。その後 `finish` が失敗（activation の競合）して結果が捨てられるとき、handle が lease に残る（begin.rs:20 のような release はない）。activation は handle を無効化する（`profile_egress.rs:322` の `handles_invalidated`）が、Graph の lease の handle がそれに含まれるかは読みで確かめていない。試験で固定する【未確認】。
2. **cache key**：§2.4 (b) の読みを、unrestricted の Graph の試験で固定する（`caller_epoch` の不一致で再利用されないこと）。
3. **activation をまたぐ operation。** activation の直前に unrestricted で begin した operation を、activation の後に restricted の caller が continue する場合。R／IR の `related_scenes_continue` も同じ形で現行どおりであり、新しい危険は足さない見込みだが【推測】、Graph の ticket でも試験で固定する。
4. **restricted で停止未確認のときの理由コードと、wire の語の扱い**（§2.4 (c) の 2）。
5. **unrestricted の profile が `unavailable`**（`ActivationFailed`、`StateFileUnwritable`）のとき、`gate_reason` はそれを見ない（`ProfileEgressStatus.unavailable_reason` は `profile_egress.rs:1110-1118` にある）。R／IR と同じ扱いでよいか。
6. **S4 が pin する file の範囲**（§3.7）。

## 6. 未確認

- 実行・build・test は行っていない。行番号は起案時の HEAD `04202c37` のもの。
- §5 の 1 から 6。特に finish 失敗時の click handle、activation をまたぐ operation、restricted で停止未確認の理由コード。
- unrestricted の parity は未測定（最後の凍結で測り足す）。
- 「restricted を Graph の条件にした一次の理由」を示す文書とユーザー決定は見つからなかった。起点の推測（2026-09-12 の計画、A8）は【推測】。
- 先行の草案の行番号（`l6-l9:920`、:1035）は照合できず、実行計画 :800、:810 と実装計画 :36、:47 に置き換えた。

## 確認後の記録

確認の記録（contracts `11dc9eda`）の確認 2 の回答は「確認し、D2a の前提も外す（推奨）」。台帳（`nir1-l6-l9-execution-plan.md`）の「2026-11-20補足」にこの draft の行を足した。K3/2、K3/3、K5/3 の本文の bytes は変えない。この確認は Graph の公開（PUB-G、Session C-1）、AI 送信への利用、新しい送信先・保存範囲、閾値の変更、最後の凍結の開始、ADR 013 の Accepted 化を許可しない。
