# NIR-1 設計案 nir1-proposal-findings-proposal/1（draft）：未 review の提案の食い違いを「気づき」として出す

> **`[precheck]` の draft。ユーザーの確認まで実装しない。** 理由コードの追加と新しい identityScope は migration と契約の変更になるので、文面を見てからの承認が要る（2026-11-10 のユーザーの回答「設計を並行で起こす」）。

| 項目 | 内容 |
| ---- | ---- |
| draftRef#contractId | `nir1-proposal-findings-proposal/1#proposal-discrepancy` |
| Status | draft／未確認。確認されても、閾値・Gold・評価の規則の変更、新しい送信先、製品公開は許可しない |
| 基点 | worktree `unruffled-shamir-d6147f`、master `2caf67a6`。行番号はこの基点で確かめた |
| 前提にする決定（2026-11-10） | 承認と確認の区別は表示しない。AI の振り分けは既定で「見せる提案を選ぶだけ」で、確認の代わりにするのは option。作者に長い文書を読ませない |

用語：**提案**は AI が本文から抽出し、作者の review を待つ変更（今の製品では Chronicle の出来事 `chronicle.create-event@1` が主）。**Finding** は保守の仕組みが出す指摘で、bundled の rule と 3 層の identity を持つ。**気づき**はこの文書で、提案に付ける「見比べてほしい」という印を指す。

## 0. 一枚目：推奨と残る問い

- **推奨 1（今やる）：段 (a) だけを進める。** review の一覧の中で、決定的に検出できる食い違い（§1 の D1〜D3）に印と 1 行の理由を付け、印のある提案を一覧の先頭に寄せる。保存・migration・background・AI の送信のどれも使わない。既存の「重複の可能性」（`probable-duplicate`、`src/features/chronicle/ChronicleProposalCard.tsx:22`、`:43`、`:129`）と同じ形に揃える。D2 は同じ Run の中だけを比べる。実装の前に、評価データで題名の一致が何件当たるかを数える（効果は未証明、§9）。
- **推奨 2（保留）：段 (b) の保存は、提案の安定した identity ができるまで待つ。** 今の Chronicle の提案の key は `${eventId}:${index}` で、`eventId` は毎回 `createId()` で作られる（`src/features/chronicle/chronicleExtractionApi.ts:272-277`、`src/features/chronicle/extraction/proposalPlanner.ts:170`）。このままでは再抽出のたびに別の Finding になり、作者の「見送り」が残らない。
- **推奨 3（保留）：段 (c) の Inbox は P0-B（Live Structure Health）の画面と同時にし、提案どうしの食い違いは Inbox に出さない。** Inbox に出すのは、提案が適用された後も残る「既存データどうし」の食い違いだけにする。
- **推奨 4：AI の判定は今は使わない。** 使う場合も、既定は表示の選択だけにし、承認・却下の代わりにしない。
- 残る問いは §8 の ★1〜★6。

## 1. 何を「食い違い」とするか

判定の列：「決定的」はコードで同じ入力から同じ結果が出る。「AI」は意味の判定が要る。誤検出の見込みはすべて**未測定**（評価データは Codex 0 件・年表が空で、設定・年表との食い違いは数えられない）。

| ID | 食い違い | 判定 | 入力 | 誤検出の見込み（推測） | 作者が取れる操作 |
| -- | -------- | ---- | ---- | ---------------------- | ---------------- |
| D1 | 提案と年表の既存の出来事の題名が一致する | 決定的（既存） | 提案の題名、Run が封じた既存 event の catalog（`existingEventMatcher.ts:6-34`、`:55-60`） | 汎用の題名（「話し合う」など）で出る | 既存の選択肢「同じものとしてスキップ／別Eventとして作成／保留」（`ChronicleProposalCard.tsx:137-139`） |
| D2 | 未 review の提案どうしの題名が一致する（段 (a) では同じ Run の中だけ。review の projection は Run ごと、`chronicleExtractionStore.ts:200-215`。別の Run と比べるには DB の読み出しが要る） | 決定的 | 提案の題名を `sameChronicleEventTitle`（`existingEventMatcher.ts:46-48`）で比べる | D1 と同じ。反復する行為（毎朝の食事）は正当な別の出来事 | 並べて見る／片方を却下／両方承認 |
| D3 | D2 の組で `actuality`（実際に起きた／試みた／阻止された等）が違う | 決定的（D2 の上） | 提案の `actuality`（`proposalPlanner.ts:173`）。値は `eventOccurrence.ts:3-9` | 「試みて失敗し、後で成功」は正当で、矛盾ではない | 並べて見る。どちらも正しいことがある（§5） |
| D4 | 発言・伝聞・回想・夢・仮定の中の出来事 | 決定的（印だけ） | 観測の `assertion.attribution` と `narrativeFrame`（`eventOccurrence.ts:22-31`、6 値）。**提案の payload には無い**（`chronicleEventProposal.ts` と `ChronicleProposalCard.tsx` に参照なし）ので、観測から review の projection へ渡す変更が要る。projection の作り方（renderer だけか IPC を通るか）は未確認なので、段 (a) からは外す | 食い違いそのものではなく「食い違いの元になりやすい」印。語り手の嘘や登場人物の誤認は D1〜D3 の誤検出の最大の源（推測） | 印を見て判断する |
| D5 | 時間の制約の矛盾（負の閉路） | 決定的だが**今は入力が無い** | solver（`temporal/solver/index.ts`、`conflict.ts:4-14`）。提案の時間は未解決の文字列 `temporalExpressions`（`proposalPlanner.ts:185-189`）で、時間の制約の提案（`createTemporalConstraintProposal.ts:6`）を作る本番の経路は TS 側では見つからない（grep で `temporal/operations.ts` だけ）。Rust 側の producer は未確認（永続化は `migrate.rs:2867` から） | — | 制約が作られるようになってから再検討 |
| D6 | 提案の時間表現と既存 event の `startTime`／`endTime` の矛盾 | AI（または時間表現の解決器） | 提案の `temporalExpressions`、catalog の時刻（`existingEventMatcher.ts:14-15`） | 未測定 | 並べて見る |
| D7 | 提案と Codex の設定の矛盾（例：死亡した人物が後で行動する、Phase の範囲外） | AI | 提案、参加者の表記、該当する Codex の Entry／Phase／Detail | 未測定。表記の解決の誤りが混ざる | 並べて見る／Codex を開く |
| D8 | Codex の提案どうし・既存との重複（同じ表記が複数の Entity 等） | 決定的（一部は既存） | `existingRelationMatcher.ts` の `probable-duplicate`（Codex の payload は未読） | 未測定 | 既存の重複の選択肢 |

推奨は、段 (a) で D1〜D3。D4 の印は入力の経路を確かめてからの次の段（(a′)）。D5 は入力ができるまで保留、D6・D7 は AI を使う場合の候補（★2、★4）。

## 2. 段階と、各段が当たる契約・schema

- **(a) review の一覧の中に表示するだけ。** renderer の純関数で、一覧の表示の直前に提案の組を比べる。保存しないので、却下・承認の後や再描画で印は計算し直される。作者の「見送り」は保存しない（必要なら ★6）。当たるのは review の画面（`ChronicleProposalReview.tsx`、`ChronicleProposalCard.tsx`）と store（`chronicleExtractionStore.ts`）だけで、契約・schema・IPC・Rust は変えない。印は 1 行の理由（例「同じ題名の提案が 2 件あり、一方は阻止された出来事です」）に限り、長い説明を出さない。
- **(b) Finding として保存する。** 新しい rule、identityScope、理由コード（§3、§4）。前提が 2 つある：提案の安定した identity（推奨 2）と、保存先の表の形の決定。今の表 `narrative_maintenance_finding_observations` は Freshness の形で、`run_id`、`semantic_epoch_id`、`evidence_freshness_snapshot` が NOT NULL（`src-tauri/crates/grimodex-db/src/migrate.rs:3773-3793`）、契約も `epochBinding: required`（`policies/narrative/narrative-finding-contract.json:19`）。前例として terminal failure の rule は freshness に `unknown` を入れている（`terminal_failure.rs:39`）。
- **(c) Inbox の画面。** read model の `InboxEntryKind` は 2 値（`inbox_read_model.rs:129-132`）、作者の操作は `snoozed`／`dismissed`／`flagged`（`attention.rs:85-96`、`migrate.rs:3816`）。IPC は `narrativeMaintenanceInboxList` などがある（`electron/shared/ipcContract.ts:1218-1221`）が、renderer からの利用は見つからない。`StructureHealthPanel` は `ForeshadowPanel.tsx:466` に置かれているが、件数は `liveCountsAvailable: false` 固定（`structureHealthModel.ts:3`、`:16`）。material basis が変わると作者の見送りが外れる条件は既存の attention 契約にある（`maintenance-attention-contract.json:20`）。

## 3. Finding の 3 層の identity への当てはめ（段 (b) を選ぶ場合）

3 層とは、Finding の同一性（`stable_finding_identity`＝rule・version・identityScope・stableSubject の hash、`finding_identity.rs:320-338`）、観測の digest（`observation_digest`、`:340-367`）、作者の見送りが有効かを決める material basis の digest（`material_basis_digest`、`:369-398`）。

- **新しい identityScope が要る。** 今は `edge` と `maintenance-work` 以外を拒否する（`finding_identity.rs:15-16`、`:159-182`）。提案の組は edge（依存の辺）でも保守の作業でもないので、`proposal-pair`（提案と提案、または提案と既存の 1 件）を足す。
- **rule**：`narrative.proposal-discrepancy` v1（仮名）。
- **stableSubject**：組の 2 つの安定 identity を辞書順に並べた文字列。既存 event が相手なら `existing:<ref>`。提案の安定 identity は、抽出の観測の根拠の fingerprint（`applicationProvenanceKeys`、`existingEventMatcher.ts:17-21`）から作る案がある（推測。未設計）。
- **observationFields**：`stableSubject`、`discrepancyCode`（D1〜D3 などの細目）、`reasonCode`、`subjectRevisionDigest`（比べた 2 つの revision の digest）。
- **materialBasisFields**：`stableSubject`、`discrepancyCode`、`reasonCode`、`comparedFieldsDigest`（比べた欄だけ＝正規化した題名・`actuality`・既存 event の version）。題名以外の編集で見送りが外れないようにする。
- Run・epoch・時刻は digest に入れない。既存の試験の方針と同じ（`finding_identity.rs:512` の試験名）。
- 新しい宣言 field（`discrepancyCode` など）は、Rust の必須 field の表と digest の `match`（`:352-360`、`:381-389` 付近）に足す必要がある。

## 4. 理由コードと schema の変更の一覧（段 (b)・(c)）

理由コードの方式は 2 案。**R0**：既存の 11 値に写す。terminal failure の前例（`terminal_failure.rs:58-72` が `NEX_` の code を既存の理由に写し、細目は failureCode として id と digest に入れる、`finding_observation.rs:172-180`、`:812-830`）。ただし食い違いに意味の合う値が無いので推奨しない。**R1（推奨）**：理由コードを 1 つだけ足し（`proposal-discrepancy`）、細目は `discrepancyCode` として id と digest に入れる。migration は 1 回で、細目を増やしても migration にならない。

| 変更 | 場所 | migration |
| ---- | ---- | --------- |
| rule・理由コードの追加 | `policies/narrative/narrative-finding-contract.json:4-16`、`:22-61` | なし（契約の変更） |
| schema の `oneOf` に枝を足す | `policies/narrative/schemas/narrative-finding-contract.schema.json:31-160` | なし |
| identityScope の定数・検証・必須 field・digest の field | `finding_identity.rs:15-35`、`:159-182`、`:352-360`、`:381-389` | なし |
| `FindingReasonCode` と `as_str`／逆変換 | `evaluator.rs:140-160` 付近 | なし |
| TS の写し `FINDING_REASON_CODE_IDS` | `src/features/narrative-semantic-core/contracts/dependencyRole.ts:86-98` | なし |
| observations 表の `reason_code` の CHECK | `migrate.rs:3780-3783` | **あり**。SQLite は CHECK を変えられないので表の作り直し。SCHEMA_VERSION 46→47（`grimodex-core/src/lib.rs:3`、`:9`） |
| edge state の表の CHECK | `migrate.rs:3724-3727` | 変えない（提案の Finding は edge を持たない） |
| 表の NOT NULL 列（run・epoch・freshness）の扱い | `migrate.rs:3773-3793` | 別表にするなら**あり**。同じ表なら freshness に `unknown`、run・epoch の縛り方は未設計 |
| Drizzle の写し | `src/db/schema.ts:3442-3470` | 列を足す場合だけ |
| SQL policy の表の一覧（中身は表名の列挙） | `electron/main/d2aSqlPolicyFixture.ts:10-25` 付近 | 別表を作る場合に追加が要る見込み（未確認） |
| `InboxEntryKind` の追加と IPC の検証 | `inbox_read_model.rs:129-132`、`ipcContract.ts:1218-1221` 以降の validator | なし（段 (c)） |

AI の判定を保存する場合は、再計算できない値になる。契約の既定は `rebuildable-derived-state`（`narrative-finding-contract.json:18`）で、上書きは terminal の rule だけが持つ（`finding_identity.rs:54-59`）。これも契約の変更になる（★4）。

## 5. ADR 005 の原則との整合（`docs/adr/005-narrative-semantic-core-boundary.md:848-889`）

- **Law 5（矛盾する Assertion の共存）と Non-goal の TMS**：気づきは「見比べる候補」で、どちらが正しいかを決めない。提案を隠さず、承認を止めず、自動で却下しない。
- **Law 9（Dependency の伝播は Freshness だけ）**：気づきは伝播ではなく、retract・merge・delete・Apply を起こさない。
- **Law 3・Law 13（AI は書込みの権限を持たない、確信度は review を迂回しない）**：AI の判定は印と並び順だけに使う。既定で承認・却下の代わりにしない（2026-11-10 の決定と一致）。
- **Law 6（Review state と Freshness 等は別軸）**：気づきは提案の review state を変えない。
- **Law 7（Rejection は永久の否定ではない）**：見送りは material basis が変われば外れる（§3）。
- **同一性の推測**：roadmap の P1-A は、決定的な Core が heuristic で同一性を推測することを禁じている（`narrative-semantic-core-roadmap.md:688`、別 Epic の前提なので類推）。D2・D3 は「同じ出来事らしい」の推測なので、既存の `probable-duplicate` と同じく表示と作者の明示の選択に留め、同一と記録しない。
- **未 review の提案を入力にすること**：提案は authority を持たない。気づきも「review の補助の表示」で、正本のデータの健全性ではない。P0-B の Feature rules は正本の AI 由来の Entry が対象で（roadmap `:647-656`）、この種の rule は無い。段 (b)・(c) は roadmap への追加になる。提案が却下・置換されたら、その Finding は resolved にする。

## 6. AI を使う場合の送信範囲と費用

- 段 (a)・(a′) と D1〜D4 は送信しない。
- AI を使う候補は D6・D7。選択肢は 3 つ。(i) 抽出の request に同居させる：送信先・文脈は抽出と同じで追加の送信はないが、抽出の prompt を変えるので AI 指示の変更として評価の取り直しが要る。(ii) 別の判定の request：同じ provider でも、提案と Codex の該当 Entry を新しく送る範囲が増える。**新しい送信の範囲**なのでユーザーの確認が要る（★4）。(iii) 使わない（推奨）。
- 開示：抽出で Codex を送る範囲は、Codex の Phase とネタバレ防止を引き継ぐ決定がある（2026-11-05、作業記録の memory。repo の中では未確認）。(i)(ii) もそれを超えない。
- 費用：未測定。組の数は提案数の二乗まで増えうるので、同じ参加者の表記や近い Scene で候補を先に絞ることが必須（推測）。
- 背景で回す場合は background の AI になり（今は `backgroundAiEnabled: false`、`structureHealthModel.ts:6`）、`GDX-PRECHECK-001`（`policies/quality/iron-laws.md:57-97`）の owner／lifecycle の表が実装の前に要る。

## 7. 脅威モデル

- 段 (a)：保存・送信・background が無いので、security-sensitive な脅威モデルは不要と提案する（確認はユーザー）。表示する文字列は本文と AI の出力に由来するので、React の通常のエスケープで出し、HTML として描かない。
- 段 (b)・(c)、または AI を使う場合の下書き（**draft**。確認まで固定しない）：
  - 信頼する actor：作者（ローカルの利用者）、main と Native の writer、bundled の契約（workspace のデータで rule の意味を置き換えられない、`finding_identity.rs:1-5`）。
  - 信頼しない actor：AI の出力（提案の題名、判定の理由文）、本文と取り込んだ原稿、renderer からの申告（finding key、digest）。
  - 範囲内の攻撃：本文や提案に埋めた指示で AI の判定を誘導し、気づきを大量に出して review を飽和させる、または隠す。renderer が偽の Finding を書く。気づきが承認・却下・Apply に繋がる経路。
  - 範囲外：OS の管理者、DB ファイルの直接の改ざん、provider の側（既存の扱いと同じ）。
  - 必須の防御：Finding は Native が計算して書き、renderer の申告を信じない。1 Run あたりの件数の上限。AI の理由文は表示だけで操作に繋げない。気づきが review state を変えないことを試験で固定する。未知の rule・scope・理由コードは fail-closed（既存）。
  - 受入れへの影響：新しい identityScope・理由コード・表は契約と migration の変更。誤検出率に閾値を置くなら新しい閾値として確認が要る。

## 8. ユーザーに確認が要る点

- **★1 どの段まで進めるか。** (A) 段 (a) だけ今進め、(b)(c) は前提ができてから〔推奨〕。(B) (a) と (b) を続けて設計。(C) 設計を寝かせる。
- **★2 対象の食い違い。** (A) 段 (a) で D1〜D3、経路を確かめてから D4 の印〔推奨〕。(B) D6・D7 も含める（AI が要る）。(C) D1 の既存の表示だけ。
- **★3 理由コードの方式（段 (b) を選ぶ場合）。** (A) R1：1 つ追加、細目は digest へ〔推奨〕。(B) R0：既存の値に写す。(C) 細目ごとに理由コードを足す（細目の追加のたびに migration）。
- **★4 AI の判定。** (A) 使わない〔推奨〕。(B) 抽出の request に同居（送信先は同じ、評価の取り直しが要る）。(C) 別の判定の request（新しい送信の範囲。AI の判定を保存するなら保存範囲の拡大も）。
- **★5 AI の振り分けとの関係。** (A) 気づきのある提案は振り分けで隠さない〔推奨〕。(B) 振り分けに任せる。
- **★6 作者の「見送り」を残すか。** (A) 段 (a) では残さない。提案どうしの気づきは Inbox に出さない〔推奨〕。(B) 段 (a) でも残す（新しい保存＝段 (b) の前倒し）。

## 9. 未確認の点と限界

- 推奨 1 の効果は未証明。D2・D3 は正規化した題名の完全一致なので、AI が別の Scene で付けた題名が一致する頻度によっては、ほとんど当たらない。段 (a) の最初の手順として、評価データで同じ Run の中の題名の一致を数える。
- 段 (a) の D2 は同じ Run の中だけで、別の Run の提案との比較は扱わない。
- 評価データの数（提案 884 件／551 件、発言・伝聞・回想を含む 190 件／128 件、attempted／prevented 8 件／2 件、major 各 19 件）は前の調査の値で、この文書では数え直していない。
- D1〜D3 の誤検出の頻度、汎用の題名の衝突の頻度は未測定。設定・年表との食い違いは、評価データに Codex と年表が無いので測れない。
- 段 (b) の Finding を、どの Run（抽出の Run か保守の Run か）と epoch に縛るかは未設計。
- `contractStringParity.test.ts` が `FINDING_REASON_CODE_IDS` と JSON の一致を見ているかは未確認。
- `chronicleSceneEventAdapter.ts:228-231` の attribution の許容値は `narrator` と `unknown` だけで、`character:` は `:334` で別に扱われる。D4 の印に使えるかの詳細は未確認。
- Codex の提案（Entity／Relation／Phase／Detail）の payload は読んでいない。D7・D8 の入力は推測を含む。
- 提案の安定 identity を根拠の fingerprint から作れるかは推測で、未設計。
