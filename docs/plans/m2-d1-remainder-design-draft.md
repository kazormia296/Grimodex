# M2-D1 の残り：移行の証跡と Retrieval への参加（起案、2026-11-26）

状態：**起案**。技術判断は M4 の前倒しと同じ委任の範囲内（contracts `user-confirmation-2026-11-24-m4-pullforward.md` の冒頭の表「委任と持ち主」）。
判断の記録は [m2-remainder-decisions.md](nir1-lane-decisions/m2-remainder-decisions.md)（DR-M2R-1〜5）。

**確認済みと起案者の読み：** ユーザーが確認したのは「M2 の残りを別のセッションの担当にする」こと（contracts の追記 13）だけ。
この文書の §2・§3 の結論（消す候補は 0 件、Retrieval の新しい経路はこの版で足さない）は、起案者の技術判断で、**ユーザーの確認の前**。
この 2 項目に「完了」の印は付けない（§4）。

対象は、ロードマップの「Milestone M2」節の「Each wave must provide」の 7 項目のうち、M2-D1（Codex Entity／Relation）で次の 2 つ。

- Retrieval participation where useful.
- Migration evidence before deleting feature-private summaries or Freshness stores.

ほかの 5 項目は [M2-D1 の同一性の設計](m2-d1-identity-design-draft.md)（#1108）が扱う。
D2〜D4 は [D2〜D4 の起案](m2-d2-d4-design-draft.md)（M4 の担当）が扱い、§3.2 の共通の規則を参照する。

## 1. 事実（read-only の調査。基点は origin/master `ada7d3527`）

### 1.1 Codex の feature 側の保存物

| 保存物                                                                              | 中身                                                                                                                                                     | 共通の層との関係                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `codex_entries.summary`                                                             | 作者が書く要約。空欄のときは AI 生成をオンデマンドで行い、結果を欄に入れる（`src/features/codex/components/DetailsTab.tsx:787-821`）                     | 作者が書く正本のデータ。導出物でない                                |
| `codex_fts`／`codex_fts_en`                                                         | `codex_entries` の名前・別名・要約・本文の全文検索の索引。trigger で同期（`migrate.rs:1102-1145`、`:8831-8865`）                                         | IR に転置索引は無い。元データが重なるだけ                           |
| `codex_chunks`                                                                      | 1 項目 1 embedding の索引。`content_hash`・model・次元・chunker version を持つ（`migrate.rs:1991-2009`、`grimodex-semantic/src/codex_index.rs:100-203`） | typed ER の revision は embedding も索引の対象の本文も持たない      |
| `internal.codex.bodyMentionIndex.v2`（`project_settings`）と `scene_codex_mentions` | 本文中の Codex の言及の索引と、その鮮度（matcher の hash、場面ごとの version）（`src/features/codex/bodyMentionIndexState.ts:6-206`）                    | 対象は場面の本文の再走査で、Codex の object の token の鮮度ではない |
| `staleBind`／`staleBindCause`（renderer の store）                                  | 構造の抽出の review の表示用の状態。共有の Decision の台帳から復元（`codexStructureExtractionApi.ts:2988-3014`）                                         | 独自の DB の列は無い。共有の台帳から作る                            |

抽出の途中結果は Codex 専用の table を持たない。共有の `narrative_proposal_sets`／`narrative_proposals`／`narrative_proposal_revisions` に入る（`migrate.rs:2765-2809`）。

feature を横断する旧い dependency の store として `narrative_projection_dependencies`（application ごとの依存、`migrate.rs:3370-3379`）がある。Codex 専用ではなく、今も `incremental_freshness.rs`・`commit.rs` などが読む。registry の `legacy-application-projection-dependency`（`legacy_backfill.rs`）が共通の辺へ写し、片付けの parity の gate は Gate C2 の cutover（`c2z_preparation.rs:792-835`）が持つ。
共通の Freshness は `narrative_dependency_edge_states` と `narrative_consumer_freshness`（`migrate.rs:3705-3748`）。

### 1.2 ADR 005 の「Legacy cleanup」

ADR 005（`docs/adr/005-narrative-semantic-core-boundary.md` の「Legacy cleanup」）が、Parity と Migration Evidence の確認の後に消すとしているのは、次の 2 つ。

- 完全に導出可能になった Feature-private summary
- 重複した Dependency／Freshness Store

同じ節は「Context／Retrieval を Shared Index 経由へ移行」を cleanup の段に置き、「Released Workspace と保存済み Artifact が収束するまで Compatibility Adapter を保持」とする。

### 1.3 製品の検索・文脈の経路が読むもの

| 経路                                 | 読むもの                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic Search（画面）              | 場面の本文の chunk。Codex を返さない（`src/features/semantic-search/api.ts:14-112`）                                                                                                                                                                                                  |
| Related Scenes（通常の経路）         | 場面の本文の dense と FTS。日本語では Codex の名前・別名で sparse の問い合わせを作るだけ（`relatedScenesSparseQuery.ts:11-85`）                                                                                                                                                       |
| Related Scenes（NIR-1 Graph の経路） | 承認済みの typed ER の roster から作る Graph の index（#596、2026-09-17、`nir1_entity_relation_index.rs:1436-1444`、`:2231-2256`）。**閉じている**：`NIR1_GRAPH_UI_ENABLED = false`（`nir1GraphAvailability.ts:18`）、`PRODUCT_GRAPH_PUBLISHED = false`（`nir1_graph_product.rs:64`） |
| Chat の Codex の文脈                 | 変更できる `codex_entries`／`codex_relations`（`nonSceneContextSource.ts:521-610`、`contextBuilder.ts:1421-1500`）。可否は `codexVisibilityPolicy.ts` の contextMode と Phase                                                                                                         |
| Chat の `search_codex` tool          | FTS と `codex_chunks` の融合（`electron/shared/readDomain/core/codexTools.ts:121-210`）                                                                                                                                                                                               |
| MCP の `search_project`              | `codex_entries`／`codex_fts`（`grimodex-mcp/src/tools/search.rs:21-50`）                                                                                                                                                                                                              |

typed ER を読む retrieval は、Graph の index だけ。`nir1_entity_relation_revision_read` 系は review の cold reopen 用で、Graph や AI の経路ではない（`nir1EntityRelationRevisionApi.ts:222-245`）。

### 1.4 公開版との互換

- 公開版 v2.0.10（tag `v2.0.10`、`SCHEMA_VERSION = 2`）の `migrate()` は、開くたびに次の 3 表を無条件に作る（tag の `src-tauri/crates/grimodex-db/src/migrate.rs`）。
  - `codex_relations`：`:1135` で作り、`:1154` の `migrate_codex_relations_source_map_edge_id` が FK を外して作り直す（最終形は `:3001-3026`）。
  - `change_events`：`:1495` で作り、`:1535` で `event_uid` の列を足す。
  - `undo_journal`：`:1604` から呼ぶ `migrate_ai_write_infrastructure` の `:2037`。
- Gate A2 の公開版 fixture（`grimodex-db/tests/support/release_schema_fixture.rs`）は、seed の `scripts/schema-seed-ja.sql`（`:15`）と `ai_audit_events` の DDL から作る。
  この seed は見本データ用の schema の部分集合で（#235 の parity gate は「seed ⊆ migrate」だけを確かめる）、v2.0.10 の物理 schema の全部ではない。
- v2.0.10 の `migrate()` が作り seed に無い表は 29 ある（試験のコードを除いて数えた）。作者のデータを持つ表（`codex_relations`・`change_events`・`undo_journal`・`state_snapshots`・`prose_staging`・`prompt_templates`・`post_effect_*` など）と、作り直せる索引（`*_chunks`・`*_fts_en` など）が混ざる。
- 今の fixture にこれらが無いと、今の `migrate()` は新しい形の空の表を作るだけになる。公開版の古い形の表と作者の行を、今の作り直し（例：今の `migrate.rs:10079` の `codex_relations_new`）が通すかは、通しの試験で確かめられていない。

## 2. 移行の証跡

### 2.1 M2-D1 で消す候補は 0 件（DR-M2R-1）

§1.1 のどれも、ADR 005 の 2 つの削除の対象に当たらない。

- `codex_entries.summary` は作者が書く正本で、共通の層から導出できない。
- 3 つの索引（FTS・embedding・言及）は、共通の層の Freshness と対象が違い、重複でない。
- `staleBind` は共有の台帳から作る表示の状態で、独自の store が無い。
- `narrative_projection_dependencies` は ADR 005 の「重複した Dependency store」の候補になりうるが、Codex 専用でなく全 feature の application にまたがり、片付けは Gate C2 の cutover の範囲にある。M2-D1 の候補には数えない。

したがって M2-D1 では何も消さず、消す前の証跡も出すものが無い。この項目は「対象なし（0 件）」と記録し、「完了」とは書かない。

### 2.2 消す前に出す証跡の規則（全 wave に共通、DR-M2R-2）

D2〜D4 と、後で M2-D1 の保存物を消すことになった場合に適用する。

1. **中身の一致**：データの種類ごとに、古い store の内容と共通の層から導出した内容を、集合か digest で比べる。件数の一致だけでは足りない（前例：`legacy_backfill.rs:1289-1335` の dependency ごとの対応づけ。`:1163-1164`・`:1278-1285` の件数の記録だけでは中身の一致を示さない）。
2. **読み手の切替**：古い store を読む製品の経路が 0 件になったことを示す（静的な走査と試験）。新しい読み手に切り替えた後に確かめる。
3. **互換の保持**：公開版の workspace と保存済みの Artifact が収束するまで、互換 adapter を残す（ADR 005）。公開版との互換の証跡（Gate A2 の fixture に行を足すこと）は、7 項目の「互換 adapter」の証跡として分けて書く。
4. **削除はユーザーに伺う**：証跡が揃っても、消すこと自体は委任の外。消す store・証跡・戻し方を一覧にして伺う。

## 3. Retrieval への参加

### 3.1 今の参加の形（DR-M2R-3）

承認済みの typed ER は、NIR-1 の Graph の index（#596）を通じて Related Scenes の Graph の経路にだけ参加している。
この形は M2-D1 の土台（#1108）より前からあり、#1108 の同一性の宣言には依らない。経路は閉じていて、PUB-G で開く。
したがって「M2-D1 で Retrieval への参加を実装した」とは書かない。

### 3.2 この版では新しい経路を足さない（DR-M2R-4）

「where useful」の判断として、次の 3 案を比べた。

| 案  | 中身                                                     | 当たる確認                                                 | 判断                                                                                  |
| --- | -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A   | 検索結果に「承認済みの typed revision あり」の印を出す   | 新しい lookup と表示の契約（新しい契約）                   | 見送り。役に立つ根拠が無い。作者がこの印で何を判断するかが決まっていない              |
| B   | Chat の Codex の候補を、承認済みの Relation で並べ替える | AI に届く項目が変わりうる（AI への新しい送信に当たりうる） | 見送り。委任の外。ADR 005 は Context／Retrieval の移行を parity の後の cleanup に置く |
| C   | Related Scenes の Graph の経路                           | なし（既にある）                                           | 現状のまま。PUB-G で開く                                                              |

見直す時期：PUB-G の後か、CP-4 の評価で Graph の経路が役に立つと示されたとき。そのとき A を、Graph の経路の実測と比べて改めて決める。

**2026-11-26 のユーザーの回答**（contracts の追記 15）：「案 B も検討する」。B の検討は §3.4。A の見送りと C の現状維持は変えない。

### 3.4 案 B の検討（Chat の Codex の候補を承認済みの typed ER で並べ替える）

**今の Chat の候補の選び方**（read-only の調査、基点 `ada7d3527`）

- 候補は Codex の名前・別名の一致、明示の mention、pin、場面の semantic link、`always` から集め、Codex の id の順に並べる。score は無い（`sceneContextSource.ts:680-735`、`:846-850`、`nonSceneContextSource.ts:701-724`）。
- 件数の上限は無く、token の予算で決まる。場面の L4 は使える量の 20%（`contextBuilder.ts:398-445`）。予算を超えると、同じ優先度の中で配列の先頭から削る（`budgetSelector.ts:42-88`）。L4 の優先度は `always`・pin・関係・通常の mention の順（`contextBuilder.ts:726-755`）。
- 関係の展開は、変更できる `codex_relations` を 1 段・両方向・最大 12 件たどる。展開した項目は本文なしで、名前と関係だけを送る（`relationExpansion.ts:7-91`、`contextBuilder.ts:1421-1446`）。
- 承認済みの typed ER の id の集合を project 全体で返す読み口は無い。既存の `nir1_entity_relation_revision_read` は revision の id を指定して revision 全体を返す review 用で、件数の上限も無い（`ipcContract.ts:888-901`、`:7415-7445`）。

**形の候補**

| 形  | 中身                                                                                         | AI に届くもの                                         | 要るもの                                                                                               |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| B1  | 予算で選び終えた後に、選ばれた L4 の項目だけを「承認済みの版に含まれる項目が先」に並べ替える | 項目の集合は変わらない。prompt の中の順序だけが変わる | 承認済みの Codex の id の集合を返す、上限つきの新しい読み口（IPC・N-API・Rust reader。**新しい契約**） |
| B2  | 予算で選ぶ前に並べ替え、承認済みの項目が予算の境目で残りやすくする                           | 予算を超えたときだけ、届く項目の集合が変わる          | B1 と同じ読み口                                                                                        |
| B3  | 関係の展開の出発点や辺に、承認済みの Relation を使う                                         | 本文なしの項目の集合が変わる                          | B1 と同じ読み口                                                                                        |

**未決の論点**

- 「承認済み」の定義：typed revision は場面と選択ごとに別々に作られ、承認済みが複数並ぶ。どの revision を数えるか、承認の後に Codex の項目が変わった場合（Freshness の `stale`／`source-missing`）を除くかを決める必要がある。
- 役に立つかどうか：typed ER の Entity／Relation は既存の Codex の項目の写しで（Codex に無い項目は拒否される）、新しく足すのは「作者がある場面の抽出で確かめた」という印だけ。今の候補の選び方にこの印が効くかは、測るまで分からない。
- 送信：B1 でも prompt の順序が変わり、B2・B3 は届く項目が変わる。どれも AI への送信の変更にあたるので、実装の前に形と送信をユーザーに伺う。

**起案者の勧め**：B1 を最初の形にし、旗を閉じたまま入れて、既存の評価で順序の効果を測ってから開けるかを決める。新しい読み口は bounded lookup の契約（`policies/quality/iron-laws.md` の immutable identity・bounded lookup）に合わせる。

### 3.5 B1 の旗を開ける前の測定（起案、2026-11-27。**回す前にユーザーに伺う**）

**測ること**：承認済みで今も有効な Codex の項目を L4 の mention の群の先に置くと、AI の答えがその項目を正しく使う率が上がるか。B1 は項目を除かず、全部を送ったまま順序だけを変えるので、「古い版の項目を除けるか」は測る対象ではない。

**既存の部品**（read-only の棚卸し、基点 `18714c8d8`）

- Chat の system prompt を組み立てて答えの質を測る評価は無い。L4 の順序や答えの中の Codex の言及を測る指標も無い。
- 送信の前例：Chronicle の prompt cache の診断（`scripts/quality/chronicle-prompt-cache-diag/`）が、製品の組み立てた request を Anthropic の API に直接送り、token の数を記録する。key は環境変数か製品の保存の key を一時に取り、disk に残さない（`run.mjs:6-43`、`key-source.mjs:83-93`）。
- fixture の候補：`evals/nir1-graph/g05-current-revision-freshness.v1.json` は複数の scene・Codex の項目と、承認済み・古い・未承認・却下の typed revision を持つ（`:27-65`、`:246-294`）。Graph の評価用なので、Chat の builder の入力への変換が要る。

**案**

- 入力：G-05 から作る合成の作品（作者のデータは使わない）。各 case は、同じ選び終えた Codex の集合と user の問いを持ち、正解の Codex の項目（承認済みで今も有効）と、使ってはいけない項目（同じ名前で古い説明など）を決めておく。
- 比べる 2 群：同じ input の `buildSystemPrompt` に、承認済みの集合を渡す／渡さない（旗は閉じたまま、builder への注入だけで作る）。2 群の request が L4 の順序以外で一致することを、送る前に機械で確かめる。
- 指標：答えの中で正解の項目の事実を使った率と、使ってはいけない項目の事実を使った数。固定の名前・事実の一覧で採点し、LLM の judge は使わない。
- 反復：生成のばらつきを見るため、case × 2 群 × 3 回以上（数は下の問いで決める）。送る順は case ごとに入れ替える。
- 費用：送る前に、組み立てた request の token の数を数えて見積もりを出す（単価はモデルで決まるので、この起案では額を書かない）。

**ユーザーに伺うこと（回す前）**

1. 送信先とモデル：既存の前例と同じく Anthropic の API に直接送ってよいか、どのモデルか（反復は安いモデル、区切りは上位のモデル、の既存の方針に合わせるか）。送るのは合成の fixture だけで、作者のデータは送らない。
2. 規模と費用の上限：case の数と反復の回数、1 回の run の費用の上限。
3. 旗を開ける基準：どれだけ改善したら開けるか（あるいは、改善が無ければ B1 を取り下げるか）。

**2026-11-27 のユーザーの回答**（contracts の追記 21）：送信先は Anthropic の API（反復は Haiku、旗を開けるかの区切りの測定だけ Sonnet）。規模は 5 case × 2 群 × 3 回＝30 回の生成、1 回の run の費用の上限は $3（送る前の見積もりが上限を超えるなら送らずに止める）。開ける基準は先に決めず、結果の数字と実例を一覧にして伺う（旗を開けるのは別に伺う）。送るのは合成の fixture だけで、作者のデータは送らない。

**1 回目の測定の結果**（2026-11-27、`claude-haiku-5-5`・effort `low`、5 case × 2 群 × 3 回＝30 回、断り 0 件、実費 約 $0.004。harness は枝 `claude/m2-b1-rank-eval` の `scripts/quality/b1-approved-codex-rank-eval/`）

| 群           | 正解の語が出た | 使ってはいけない語の数 | 排他的な正解（正解の語だけが出た） |
| ------------ | -------------- | ---------------------- | ---------------------------------- |
| 並べ替えなし | 13／15         | 21                     | 0／15                              |
| 並べ替えあり | 13／15         | 16                     | 2／15（2 件とも `old-current`）    |

- AI は、紛らわしい項目が並ぶと、ほぼ必ず候補を全部挙げて答える（「一言で」と頼んでも）。prompt に「どれが承認済みか」の印は無いので、1 つに決めない答え方は妥当とも言える。
- 順序だけで AI がその項目を選ぶ方向に動いたのは 1 case の 2 回だけ。1 case 3 回では偶然の差と区別できない。
- 読み（起案者）：順序だけを変える B1 の効果は、この規模では見えない。

**2 回目の測定（区切り）の結果**（2026-11-27、`claude-sonnet-5-5`・effort `high`、同じ 30 回、断り 0 件、実費 約 $0.10。最初の実行は試験の時間の上限 60 秒で途中で止まり、記録が残らなかったので、上限を 30 分にし送るたびに記録する形に直して回し直した〔`905163442`〕。止まった実行の費用は 30 回ぶんの見積もり 約 $1.25 の内）

| 群           | 正解の語が出た | 使ってはいけない語の数 | 排他的な正解                    |
| ------------ | -------------- | ---------------------- | ------------------------------- |
| 並べ替えなし | 10／15         | 17                     | 0／15                           |
| 並べ替えあり | 12／15         | 15                     | 3／15（3 件とも `old-current`） |

- Haiku と同じく、排他的な正解が増えたのは「旧い設定と今の設定」が並ぶ 1 case だけ（並べ替えありで 3 回とも今の設定だけを答えた）。ほかの 4 case では差が無い。
- **残る制限（side agent の指摘、2026-11-27）**：「今も有効」は承認の時と今とで項目の最終更新の日時（`resolve_typed_source_token` の `codex:<id>@<updated_at>`）が同じこと（DR-M2R-7）なので、要約や別名を少し直しただけで印は消え、抽出し直して承認するまで戻らない。書きながら Codex をよく直す使い方では、印の付く項目がほとんど残らない見込み。今回の fixture は全部の正解の項目に印がある前提で、承認の後に編集された項目を混ぜれば効果はさらに小さく見えるはず。日時でなく中身で比べる形は、共通の Freshness の token の定義に関わり、B1 だけでは決められない。

### 3.3 公開版との互換の証跡（DR-M2R-5）

公開版の workspace は §1.4 の 3 表の行を持ちうるのに、Gate A2 の fixture は覆っていない。M2〜M4 の同一性（`codex-relation:{edge_id}`）は Relation の id を使うので、公開版の Relation の行が今の版で読めることの証跡は要る。

- **3 表**：M2 が別の product PR（枝 `claude/m2-a2-release-fixture`、試験だけ）で、fixture に v2.0.10 の最終形の DDL と作者の行を足し、移行の後に残ることを確かめる（統合者と 2026-11-26 に合意。fixture の持ち主は不在で、最後の変更は #564）。
  - **2026-11-27：#1171 で merge 済み（master `7d46cfbf1`）。** 途中で、undo の行の固定の日付が開き直しの保守の処理の 90 日の保持（`open.rs:718-726` → `lib.rs:785-824`）を過ぎて消える件があった（製品の不具合ではない）。日付の列は「今の 1 日前」にした。
- **残りの 26 表**：この版では覆わない。手写しでなく、tag の crate を実際に動かして `sqlite_master` を取る形が筋。重い作業なので、やるか・誰がやるかは公開の前に決める（**未決**）。

## 4. 7 項目の状態（M2-D1）

| 項目                                 | 状態                                                                                                                                                                                                                | 根拠                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Shared Narrative IR typed payloads   | `EntityRelationBundle`（`narrative_nir1.rs:249`、#572 から）。#1108 は Assertion の任意の `identityDeclaration` の検証を足した（呼び手なし）                                                                        | [同一性の設計](m2-d1-identity-design-draft.md) §1・§2.1 |
| Compatibility adapters               | データの移行は不要と判断（同 §2.4）。公開版の Relation・変更の記録・undo の行は Gate A2 の fixture で覆った（#1171、§3.3）。seed に無い残りの 26 表は未決                                                           | 同 §2.4、§3.3                                           |
| Producer-time Dependency declaration | registry の `nir1-reviewed-entity-relation-v1`（既存）と、版を作る prepare の時に書く proposal-revision の辺（`nir1_entity_relation.rs:1095`、呼び出し `:1949`）。#1108 の同一性の宣言（同 §2.3）は依存の宣言とは別 | registry、`nir1_entity_relation.rs`                     |
| Review and Projection state mapping  | bundle 単位の Decision を継承                                                                                                                                                                                       | 同 §2.5                                                 |
| Structure Health rules               | コードの追加なし                                                                                                                                                                                                    | 同 §2.6                                                 |
| Retrieval participation              | Graph の index だけ（閉じている）。案 A は見送り、案 B は検討中で、形と送信を伺うまで実装しない                                                                                                                     | §3                                                      |
| Migration evidence                   | 消す候補 0 件。証跡の規則を定めた                                                                                                                                                                                   | §2                                                      |

どの項目にも「完了」の印は付けない。M2-D1 の受入れは、呼び手と旗を開けるときに改めて行う。

## 5. やらないこと

- 保存物の削除、Chat の文脈の経路の変更、AI への新しい送信、新しい検索の契約、Graph の公開。
