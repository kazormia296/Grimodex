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

公開版 v2.0.10 の DB は `codex_relations` を持ちうる（v2.0.10 のタグの `src-tauri/crates/grimodex-db/src/migrate.rs:1135` に `CREATE TABLE IF NOT EXISTS codex_relations`）。
Gate A2 の公開版 fixture（`grimodex-db/tests/support/release_schema_fixture.rs`）は seed の `scripts/schema-seed-ja.sql` から作る（`:15`）。この seed には `codex_relations` の table が無く（`CREATE TABLE` が 0 件）、fixture は `codex_entries` の行だけを持つ。
したがって、公開版の workspace にある Codex の Relation の行は、今の fixture では覆われていない。

## 2. 移行の証跡

### 2.1 M2-D1 で消す候補は 0 件（DR-M2R-1）

§1.1 のどれも、ADR 005 の 2 つの削除の対象に当たらない。

- `codex_entries.summary` は作者が書く正本で、共通の層から導出できない。
- 3 つの索引（FTS・embedding・言及）は、共通の層の Freshness と対象が違い、重複でない。
- `staleBind` は共有の台帳から作る表示の状態で、独自の store が無い。

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

見直す時期：PUB-G の後か、CP-4 の評価で Graph の経路が役に立つと示されたとき。そのとき A・B を、Graph の経路の実測と比べて改めて決める。B を進めるならユーザーに伺う。

### 3.3 公開版との互換の証跡（DR-M2R-5）

公開版の workspace は `codex_relations` の行を持ちうるのに、Gate A2 の fixture は覆っていない（§1.4）。これは互換の証跡の穴で、**未解決**とする。
M2-D1 の同一性（`codex-relation:{edge_id}`）は Relation の id を使うので、公開版の Relation の行が今の版で読めることの証跡は要る。
直し方（seed を v2.0.10 の migration の結果に合わせて作り直すか、fixture で v2.0.10 の migration を通すか）は、Gate A2 の fixture の持ち主と決める。この版では決めない。

## 4. 7 項目の状態（M2-D1）

| 項目                                 | 状態                                                                                                   | 根拠                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Shared Narrative IR typed payloads   | #1108 の土台（呼び手なし）                                                                             | [同一性の設計](m2-d1-identity-design-draft.md) §2.1・§2.2 |
| Compatibility adapters               | データの移行は不要と判断（同 §2.4）。公開版の Relation の行は fixture で覆われていない（§3.3、未解決） | 同 §2.4                                                   |
| Producer-time Dependency declaration | 宣言を別 file に置いた                                                                                 | 同 §2.3                                                   |
| Review and Projection state mapping  | bundle 単位の Decision を継承                                                                          | 同 §2.5                                                   |
| Structure Health rules               | コードの追加なし                                                                                       | 同 §2.6                                                   |
| Retrieval participation              | Graph の index だけ（閉じている）。新しい経路はこの版で足さない                                        | §3                                                        |
| Migration evidence                   | 消す候補 0 件。証跡の規則を定めた                                                                      | §2                                                        |

どの項目にも「完了」の印は付けない。M2-D1 の受入れは、呼び手と旗を開けるときに改めて行う。

## 5. やらないこと

- 保存物の削除、Chat の文脈の経路の変更、AI への新しい送信、新しい検索の契約、Graph の公開。
