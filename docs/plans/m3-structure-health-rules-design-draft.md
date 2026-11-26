# M3 構造の健全性ルール — 設計草稿（draft）

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `m3-structure-health-rules/1` |
| Status | draft。設計・実装・表示の承認ではない。2026-11-26：伺う点に回答（下の節）。語の一覧は案を作者に示し、確認を待っている |
| 基点 | `origin/master` `8b9bcb3ffcfeb24b9abd6a15cb177f486a629ae7` |
| 表記 | 【コード確認】はこの基点の静的コードで確認。【未確認】は実データ・実行時未確認。【推測】は推測。【起案者案】はユーザー確認が要る。新しい保存、契約・policy、語の表、作者向け文言はすべて確認前の案であり、決定ではない。 |

## 一枚目

**何を作るか**：roadmap の Epic P0-B「Feature rules」6件を、作品内の Codex Entry／Relation の注意事項として点検し、根拠と理由をたどれる Finding にする設計。roadmap 上は Planned。【コード確認：`docs/plans/narrative-semantic-core-roadmap.md` の Epic P0-B】

**作らないもの**：作者の代わりに本文や Codex を直すこと、Domain data を自動削除すること、意味を自動で撤回すること。roadmap は自動削除・撤回を禁じる。警告を成立させるための新しい保存・契約・policy・語彙・表示文言は、確認前に決定しない。

**作者の画面で起きる案**：今の「構造の健全性」は開いた時に一度だけ読み、提案の古さ等を件数で示す読み取り専用パネル。6規則はまだ数えず、行単位の Finding も出さない（`StructureHealthPanel`、`summarizeInbox`、`narrativeMaintenanceInboxList`。基点より後の数え方の変更〔DR-M3-37〕で、画面は集計の読み取り 1 本に置き換わる予定）。起案者案では、各行に対象（項目／関係）、出所、理由、確認できる根拠を示し、押すと根拠を開く。roadmap の操作は、現在／過去の Evidence 確認、Source へ移動、保留・確認済み・却下・再開、再検証／再解釈の依頼、結び付け修正／訂正規則作成、復元できない意味項目の切離し、Merge／Split 影響プレビュー。初版にどこまで含めるかは確認が要る。文言はすべて別途確認する。

**伺う点（選択肢と推奨）**

| 問い | 選択肢 | 推奨 |
| --- | --- | --- |
| 1. 注意事項をどこで見るか | A. 現在の「構造の健全性」に行を追加／B. Work Layer の注意一覧にも出す／C. 両方 | **Aから**。B/C は同じ Finding を二重表示せず扱う契約を決めてから。 |
| 2. 出所が記録から確定できない古い項目 | A. 確実な AI／取込み記録があるものだけ警告／B. 今後の項目に出所の保存を追加 | **Aを先に**。B は新しい保存なので確認後。由来不明を手動作成と決めつけない。 |
| 3. 代名詞や肩書がそのまま正式名になった項目を警告するか（`generic-surface`） | A. 作者が確認する語の表を作る／B. この規則は今は作らない（記録から確かに判定できる材料は、今はほぼ無い） | **B を推奨**。語の表は新しい語彙で、誤検知と保守の範囲を確認してから。 |
| 4. `source-unseen` の「source」 | A. 生成・取込みに使った元資料／B. 物語本文で支える場面／C. 両者を分けて表示 | **Cを推奨**。元資料と物語上の根拠を一つに混ぜない。 |
| 5. chat の AI の道具や取込みで作った項目で、本文に出てこず根拠の記録も無いものを警告するか | A. 警告する（roadmap の定義どおり）／B. 抽出の提案から作った項目だけを対象にする | **A を推奨**。B だと、根拠の無い作り方の項目がかえって対象から外れる。 |

### 2026-11-26 の回答（構造化質問。原文は handoff の `m3-user-answers-20261126f.md`）

| 点 | 回答 | 推奨との違いと、設計に入ること |
| --- | --- | --- |
| 置き場 | 「構造の健全性」の画面と、Work Layer の一覧の両方 | 推奨は画面だけだった。同じ注意を 2 か所に出すので、識別子と作者の処分は 1 つにする【起案者案】 |
| 対象 | AI の道具・取り込み・抽出の提案で作った項目で、本文に出ず根拠の記録も無いものは警告する | 問いの文面で、手で作った項目と作り方の記録が無い古い項目は対象外とした |
| 根拠 | 「元の資料」と「原稿の場面」を分けて見せる | 推奨どおり |
| 一般的な呼び名 | 語の一覧を作る | 推奨は今は作らないだった。一覧は使う前に作者に見せる。判定は正式名が一覧の語とちょうど同じときに限る案【起案者案】 |

### 2026-11-26 の追加の回答（会話の返事と構造化質問。原文は handoff の `m3-user-reply-20261126g.md` と `m3-user-answers-20261126h.md`）

| 点 | 回答 | 設計に入ること |
| --- | --- | --- |
| 番号や記号を付けただけの名前（男A、兵士2 など） | 警告する | 一覧の語に番号や記号だけが付いた形も当てる。形の細部は実装で決める【起案者案】 |
| 説明を付けた呼び方（黒衣の男など） | 今は警告しない | 部分一致はしない |
| 作者が語を足せるか | 作品ごとに足す・外す | 作品の設定として作品のファイルに保存し、案の語を作品で外すこともできる。作品内のスナップショットで戻しても、この設定は戻らない。画面の置き場と文言は未定で、別に伺う |

語の一覧（案 2：日本語 498 語、英語 376 語）は作者に示した。語の内容そのものの確認はまだで、使う前に伺う。「項目の種類に合う分類だけを使う」は起案者の案で、回答ではない。

## 1. 6つの規則

### 共通の対象判定

roadmap では `source-unseen`・`zero-mentions`・`generic-surface` は既定で AI 由来または取込み由来だけが対象。手作りの将来キャラクターを幻覚扱いしない。Chat 作成では `electron/main/ipc.ts::mainOwnedCodexAuthorship`／`bindMainOwnedRichTextFields` が `sourceChatMessageId` を付け、AI authorship span は要約か本文が空でないときだけ付けて、`src-tauri/crates/grimodex-db/src/agent_writes.rs::apply_codex_entry_create_in_tx` が Entry と `authorship_spans` に保存する。手動 API は `surface: "manual"`、空の authorship spans を送る（`src/features/codex/api.ts::createCodexEntry`）。

取込みは `src/features/import/scan/scanImportOperations.ts::importCodex`／`importRelations` が `createCanonicalWriteContext("import")` で書き、権限経路は `src-tauri/crates/grimodex-db/src/agent_writes.rs::canonical_payload_with_derived_authority_context` と `src-tauri/crates/grimodex-db/src/change_events.rs::annotate_authority_event`／`append_change_events_in_tx` で event に記録される。この route は取込み経路の証拠で、元ファイルのどの object に当たるかは、この route だけでは分からない。scan import の Entry は根拠の確からしさ・節の ID・抜粋を `notes` に書くが（`scanImportOperations.ts::importCodex`）、Relation の取込みは根拠を書かない（`importRelations`）。ただし、`import_source_mappings` の表はある一方、現行 scan import の書込みからその表への記録は検索で見つからない。AI／取込みの既存記録が全 Entity・全経路で揃うとは限らない。【未確認】別の AI 経路、旧データ、実データでの網羅率。

### `source-unseen`

- **定義・対象**：AI／取込み由来の Entry に、一致する言及（本文）も有効な Evidence も無い（roadmap の定義）。chat の AI の道具や取込みで作った項目は Evidence の記録を持たないので、言及が無ければ対象にする案（問い 5）。出所を確定できない Entry は自動で警告しない案。
- **必要情報／現状**：Chat 作成の Entry は chat message ID と AI span を持つ。構造抽出の適用先は `narrative_proposal_applications.applied_entity_kind/id` から revision にたどれ、revision は envelope／source basis を持つ（`src-tauri/crates/grimodex-db/src/migrate.rs`、`src-tauri/crates/grimodex-db/src/narrative_extraction/commit.rs`）。`narrative_consumer_freshness` は proposal revision の現行 freshness を持つ。通常の Entry 行には共通 Evidence 列がなく、chat message ID は物語上の根拠を証明しない。
- **引けない場合**：言及の索引が全場面・今の matcher で揃っていなければ未判定にする。取込みの項目が `notes` に持つ抜粋は元資料の記録で、本文の根拠とは扱わない案。元資料との対応を新たに保存するならユーザー確認が要る。
- **誤検知**：要約や一般知識から作られた項目、物語にまだ出ない予定人物を根拠なしと誤る。元資料と本文上の根拠を同じ「source」と数えると判定がぶれる。

### `zero-mentions`

- **定義・対象**：AI／取込み由来の Entry に、今の Mention が一つも無い。手動作成 Entry は既定対象外。
- **必要情報／現状**：`scene_codex_mentions` は本文照合と明示 semantic link を scene／Entry 単位で持つ（`src/features/editor/beat/bodyMentionApi.ts::upsertSceneBodyMentions`）。0件走査済みを含む走査状態と全 scene の版は `src/features/codex/bodyMentionIndexState.ts::recordBodyMentionScans`／`isBodyMentionIndexReady` が照合する。健全性の Native Inbox にこの readiness 判定は接続されていない。
- **引けない場合**：索引未完了・古い場合は「0件」とせず未判定にする案。情報は renderer 側にあり、新しい Native 読取・契約が必要かは確認が要る。新しい保存は現状の走査状態で足りるかを先に評価し、追加するなら確認後。
- **誤検知**：別名漏れ、比喩や表記ゆれ、index 対象外の場面、走査待ちを不在と誤る。索引が全場面・現行 matcher で ready でない限り警告を出さない。

### `ambiguous-identity`

- **定義・対象**：一つの表記が複数 Entry を指す、または有効な訂正規則と食い違う。後者は同定訂正の ADR 015 に依存する。
- **必要情報／現状**：Entry の名前・alias と抽出 proposal の候補は存在し、`src/features/codex/extraction/proposalPlanner.ts::planBindCodexEntityProposals` は未解決・曖昧な binding を blocked proposal として扱う。一方、ADR 015 の訂正規則は Proposed で、保存表・適用中規則は未実装（`docs/adr/015-author-identity-corrections.md`）。
- **引けない場合**：A. 現在の Entry 表記だけの曖昧さを先に扱う／B. ADR 015 の規則保存後まで規則との競合を待つ。**推奨：A/Bを別段階にし、訂正規則との判定は ADR 後。** 新しい照合語彙・Finding 契約は確認後。
- **誤検知**：同じ敬称・肩書きが別人物に使われる、場面ごとに同じ表記の意味が異なる。完全一致と scope の違いを無視して同一人物扱いしない。

### `unsupported-relation`

- **定義・対象**：AI 由来の Relation に、関係そのものを支える有効な Evidence がない。両端の Entry が本文に出るだけでは関係の証拠としない案。
- **必要情報／現状**：`codex_relations.source_map_edge_id` はあるが Relation 共通の Evidence 欄ではない。抽出適用由来なら application → revision envelope にたどれ、current freshness と併せて検査できる場合がある（`src-tauri/crates/grimodex-db/src/migrate.rs`、`src-tauri/crates/grimodex-db/src/narrative_extraction/commit.rs`）。通常の直接作成 Relation はその Evidence を持たない。
- **引けない場合**：A. proposal Evidence と結び付いた Relation だけ評価／B. Relation に Evidence 参照を新規保存。**推奨：A。** B は新しい保存・契約なので確認後。
- **誤検知**：関係が直接引用でなく複数場面から推論される場合、または適用元の履歴が失われた場合。map edge ID だけで証拠が有効と断定しない。

### `generic-surface`

- **定義・対象**：AI／取込み由来の Entry で、一般的な題・代名詞・説明が作者の明示承認なしに canonical name になった場合。
- **必要情報／現状**：`src/features/codex/extraction/proposalPlanner.ts::NAMEABLE_MENTION_FORMS` は `title`／`description` を名前にでき、`planBindCodexEntityProposals` は代名詞・implicit だけの新規作成を抑える。proposal の決定と適用先は保存される（`src-tauri/crates/grimodex-db/src/migrate.rs` の `narrative_proposal_decisions`／`narrative_proposal_applications`）。一般語の判定器はない。決定がその canonical name の明示承認を表すかは未確認。
- **引けない場合**：元の mention form は提案の組み立てに使われるが、保存される提案の payload には残らない。そのため記録だけで判定できる範囲はほぼ無く、語の表（新しい語彙・policy）か、mention form や承認の新しい保存が要る。どちらもユーザー確認が要る。**推奨：この規則は今は作らない（問い 3）。**【2026-11-26 追記：回答は「語の一覧を作る」】
- **誤検知**：一般的な肩書きが固有名として意図される。言語・作品ごとの語感を固定の語表で誤分類する。

### `correction-conflict`

- **定義・対象**：永続的な同定訂正の規則同士が両立しない。互換性のない規則から勝者を推測せず、確認待ちにする案。
- **必要情報／現状**：ADR 015 は immutable revision、scope、5種の規則、同じ優先度の矛盾は unresolved とする案を記すが、Status は Proposed。現行 DB に durable rule revision はない。
- **引けない場合**：A. ADR 015 PR 0 の契約合意と PR 1 の保存後に評価／B. 現在は規則自体を対象外。**推奨：Aの後に実装。** 新しい保存・contract は ADR と合わせて確認後。
- **誤検知**：作品全体と場面ごとの規則は例外関係になり得る。異なる scope の併存を矛盾扱いしない（ADR 015 §4）。

## 2. Finding・Inbox・出所と理由

- **Finding identity の案**：Consumer の `finding_key`（`consumer_kind:consumer_key`）は Freshness 集約の単位で、Feature Finding の恒久 identity と同じものではない（`consumer_identity.rs::consumer_finding_key`、`inbox_read_model.rs::build_maintenance_inbox`）。Feature Finding は rule ID/version と安定した対象で識別し、観測内容が変わった時だけ disposition を再確認する案。`finding_identity.rs::stable_finding_identity`／`material_basis_digest` は再利用候補だが、現 registry は `edge` と `maintenance-work` scope のみを許す（`finding_identity.rs::validate_finding_rule`）。Entry／Relation／複数対象のどれを identity scope にするか、新 scope・field・contract は確認が要る。
- **既存 contract／語彙**：6つの roadmap 名は現行 `policies/narrative/narrative-finding-contract.json` の rule ID・reason code には未登録。同 contract は11 reason codeと2 rulesを定義し、`src-tauri/crates/grimodex-db/src/narrative_extraction/evaluator.rs::FindingReasonCode` と `finding_identity.rs::bundled_finding_rule_registry` が読む。追加時は contract と `policies/narrative/schemas/narrative-finding-contract.schema.json`、Native allowlist／分類を揃える必要がある。新しい rule ID／reason code の対応、Consumer 種別（必要な場合は `policies/narrative/narrative-consumer-contract.json`）、`policies/narrative/` の変更はユーザー確認が要る。Freshness／review state を増やさないなら `policies/narrative/semantic-state-vocabulary.json` は変更不要の案。
- **画面と行**：`src/features/narrative-extraction/maintenance-ui/StructureHealthPanel.tsx::StructureHealthPanel` は現在集計件数のみで、`src/application/narrative-extraction/nativeApi.ts::parseMaintenanceInbox` も entry kind・consumer kind・Freshness だけを取り出す。Work Layer の `src/features/work-layer/AttentionTrayBody.tsx::AttentionTrayBody` は別の finding/title/summary 行を持つ。どちらを正本の一覧にするかは上の問い1で確認。行を足すなら対象、由来、規則が反応した事実、開ける evidence/source、現在の作者判断を含む案。表示文言・新しい語彙・行操作は確認後に決める。
- **roadmap Exit criteria**：【起案者案】① live count は placeholder でなく canonical Consumer Freshness と Finding identity から作る。② Source 編集時は影響を受けた Finding だけ更新。③ 根拠に関係しない再評価では作者の判断を保ち、材料が変わった場合にだけ判断を再確認。④ 各警告に出所と適用理由を示す。③は既存 `material_basis_digest` の考え方と整合するが、Feature Finding への適用契約は確認が要る。
- **Exit criteria ④「警告の出所と理由」**：各自動警告に、AI／取込みの判定根拠、参照できる元資料または Evidence、規則が当たった観測事実を紐付ける。Mention 不在なら索引 ready 状態も根拠に含める。どれかを確かめられなければ警告を成立させず、出所・理由不明を「問題なし」とも扱わない。作者向けの具体文言は確認が要る。

## 3. 依存と PR 分け（起案者案）

1. **この docs PR**：事実、未決点、確認事項をレビューする。動作変更なし。
2. **契約合意 PR**：Feature Finding の identity、理由語、出所・根拠の線引きを確認し、必要な `policies/narrative/` 契約を更新する。新しい保存・語彙は別途明示確認後。
3. **非訂正ルール PR**：確実な provenance／Evidence／mention readiness が取れる規則から Native 評価と Inbox 行を実装する。索引 incomplete はゼロと見なさない。
4. **表示 PR**：確認済みの行・文言・Inbox 操作だけを「構造の健全性」へ接続。Work Layer への重複表示は問い1の回答後。
5. **訂正依存 PR**：ADR 015 は現在 Proposed。先に ADR PR 0（受入れ契約）、次に PR 1（immutable rule／lineage 基盤）を揃える。`ambiguous-identity` の規則競合分と `correction-conflict` はその後に着手し、ADR 015 PR 5「Structure Health と受入れ閉鎖」に統合するか別 PR にするかを重複実装前に決める。ADR 015 の範囲を越える保存拡大・新 authority はこの草稿で決めない。

## 4. 未確認・限界

- 下調べ2本の基点 `4324e3f8…` はこの草稿の `origin/master` と異なるため、由来・Mention・Finding の要点を現 checkout のコードで照合した。報告の静的検索結果すべてを再現したわけではない。
- 実 DB のデータ、全作品での由来記録の網羅率、起動中の画面、ADR 015 の統合後の状態は未確認。build／test／install／network は未実施。
- AI／取込み由来の確定、`source-unseen` の「source」の意味、一般表現の判定、Feature Finding identity／契約、表示場所・文言・操作は未決。誤検知率も未測定。
- roadmap の他の Inbox actions を6規則の初版に含める範囲は未決。ルール適用だけで Domain data の削除・意味の撤回はしない。
