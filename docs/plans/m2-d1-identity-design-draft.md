# M2-D1：Codex Entity／Relation の同一性の設計（起案、2026-11-24）

状態：**起案**。技術判断は NIR-1 と同じ委任の範囲内（[引き継ぎ](m4-assertion-identity-contract-draft.md) §4、ユーザー確認済みの方向）。
前提の契約：[assertionId の契約案](m4-assertion-identity-contract-draft.md)（Assertion の任意の `identityDeclaration`、`38c7ca63b`）。

**確認済みと起案者の読み：** ユーザーが確認済みなのは契約案 §4.2 の 3 点（Assertion への任意の `identityDeclaration`、最初の slice が M2-D1、送信の形の方向）だけ。
§2 の判断（bundle は `none`、object 単位の key）は起案者の技術判断。**宣言を policy に置くこと（§2.3）は、ユーザーが 2026-11-24 に「registry の宣言は推奨どおりでいいです」と確認済み**（contracts の追記 2）。置き場を別 file にした点は、その後の起案者の技術判断。

## 1. 事実（read-only の調査、file:line は 2026-11-24 の origin/master `373c8d4b5` 基点）

- bundle は `EntityRelationBundle`（`narrative_nir1.rs:249`）で、`entities`（`entity_id`＝Codex Entry の id）と
  `relations`（`edge_id`＝Codex Relation の id）を持つ。
- Assertion は **bundle 全体で 1 件**。payload は `bundleDigest` と `revisionId` だけ（`nir1_entity_relation.rs:880-905`）。
- `revisionId`・`proposalSetId`・`proposalId` は作成のたびに `Uuid::new_v4()`（`:1839-1868`）。`bundleDigest` も revisionId を含むので、再抽出で変わる。
- index の roster は Entity／Relation／Evidence ごとに 1 行で、`source_object_identity` は `codex:{entity_id}`／`codex-relation:{edge_id}`
  （`nir1_entity_relation_index.rs:2241-2255`）。この key は Codex の id で、revision をまたいで保たれる。
- `edge_id` は `codex_relations.id`、`entity_id` は `codex_entries.id`（`nir1_entity_relation.rs:4090-4175`）。
  bundle の作成時に Codex に無い Entity／Relation は拒否され（`NIR1_ENTITY_SOURCE_MISSING`／`NIR1_RELATION_SOURCE_MISSING`）、hidden／suppress の Entry は入らない。
  したがってこの lane の項目は必ず既存の Codex id を持つ。まだ Entry でない新規候補は、この lane の対象外（既存の Proposal の経路）で、同一性は `none` と表示する。
- S4 の pin の閉包との照合：eval の閉包は `src/`・`electron/`・`scripts/local-ci*` で止まり（`observation-prep.mjs:1224-1233`）、
  `policies/narrative/`・`maintenance_contracts.rs`・`validate-semantic-core-boundary.mjs` は harness から参照されない（grep で 0 件）。
  この設計が触る 3 か所と `38c7ca63b` の 5 file は pin の閉包に当たらない。
- Decision は revision（＝bundle）単位。roster の全行が同じ `decision_id` を共有し、review DTO に項目ごとの Decision は無い（`:197`、`:348`）。

## 2. 判断

### 2.1 bundle の Assertion は `identityDeclaration: none` のまま、同一性は roster の object 単位に置く（採用）

- bundle の Assertion は「ある時点の抽出結果の束」で、概念として run をまたいで続くものではない。ここに `content-keyed` の ID を付けると、
  1 項目の変更で束の ID が変わるか、逆に無関係な変更が束に埋もれる。
- semantic diff の粒度は Entity／Relation の 1 件ごとで、その key は Producer（Codex の抽出）が既に宣言している Codex id。
  これは「Producer が宣言する同一性」であり、Core の推測ではない（ロードマップ M4 の前提の「equivalent Producer-declared identity」に当たる）。
- 不採用：Assertion を Entity／Relation ごとに分ける案。保存済み envelope・Review の Decision・index の roster・digest の全部が変わり、
  released workspace の互換 adapter の範囲が大きすぎる（薄く積む方針に反する）。

### 2.2 object の同一性の key

- Entity：`codex:{entity_id}`、Relation：`codex-relation:{edge_id}`。既存の `source_object_identity` をそのまま使い、新しい ID を作らない。
- 限界（diff で扱う）：Codex Entry が削除・統合されると id が変わる。Core は同一視しない。diff は「消えた」と「現れた」の対として出し、
  「同一性が失われた」と表示する（作者が統合を宣言する経路は ERM 側。M2-D1 の範囲外）。

### 2.3 Producer の宣言（ユーザー確認済み：「registry の宣言は推奨どおり」）

- 語：Codex の id 由来の同一性を契約の `content-keyed`（内容由来）と呼ばない。policy では `producer-declared-object-key` とする
  （抽出 Artifact 契約 §4.1 の内容キーと混ざるのを避ける）。
- 置き場（実装済み、`6f7395e44`）：宣言は producer registry の隣の別 file `policies/narrative/narrative-object-identity-declarations.json`（schema 付き）に置き、producerId で registry の entry と紐づける。
  registry の entry に足すと、registry 全体が入る maintenance の `producer_generation_set_digest`（`maintenance_contracts.rs:543`）が変わり、完了済み run の skip evidence が全部無効になるため。
  registry の SHA-256 は不変、`narrative_maintenance_contracts` の試験は変わらず通る。
- key の定義：変更レビューの「今」の側は未 review の revision で、roster の行が無いことがある。その場合の key は bundle の `entity_id`／`edge_id`（同じ `codex:`／`codex-relation:` の接頭辞）で定義する。
- 限界（独立レビューの指摘）：この宣言は、今は**挙動を駆動しない**（policy・index・`narrative_change_review.rs`・`nir1_change_review_read.rs` が同じ接頭辞を別々に持ち、試験が結ぶのは policy と index だけ）。
  diff 側が宣言を読む形にするのは、Producer が複数になる段（M2-D2 以降）で扱う。

### 2.4 互換 adapter

- 保存済みの envelope は `identityDeclaration` を持たない（legacy）。adapter は書き換えず、読む側が「宣言なし＝object 単位の同一性は roster から取る」と扱う。
- 既存 workspace の roster は `source_object_identity` を既に持つので、データの移行は不要。

### 2.5 Review／Projection の対応

- Decision は bundle 単位のまま。semantic diff の各項目は「どの revision の、どの object」を指し、Decision は revision の Decision を継承する。
- 項目ごとの Decision は M4 の変更レビューの画面の設計で決める（M2-D1 では足さない）。

### 2.6 Structure Health の規則（2026-11-24 に改訂、2026-11-25 に変更レビューの比較の定義を直した）

- revision の内側の規則は既存の検証が守っているので、新しく足さない：
  - 同じ Entity／Relation の重複：bundle の検証（`narrative_nir1.rs` の「duplicate entity／relation」）と、roster の `NIR1_GRAPH_ROSTER_DUPLICATE_MATERIAL`（`nir1_entity_relation_index.rs:551`）。
  - Relation の端点が同じ bundle に無い：`narrative_nir1.rs` の「endpoint is not present in the same project bundle」。
- revision をまたぐ比較（変更レビュー）：typed revision は場面と選択ごとに別々に作られ、project に承認済みが複数並ぶ（独立レビューの指摘 H1）。
  したがって「直前の承認済み revision」を 1 つ選んで集合の差を取る定義は採らない。**今の bundle の object ごとに、その identity を含む直前の承認済み revision と比べる**（DR-M4PF-9）。
  bundle にあって前に無い object は added、あっても token が違えば content-changed、同じなら unchanged。**`removed` はこの比較では出さない**（選択に含まれなかっただけの object を消失と誤報しないため）。
  元の Codex の項目が無くなった場合は、Freshness の `source-missing` が扱う。
- したがって M2-D1 の Structure Health は、コードの追加なし。

## 3. 決まったこと（旧「次に確かめる／伺うこと」）

1. kind の語は、契約の `content-keyed`（内容由来）と分け、policy では `producer-declared-object-key` とする（技術判断、DR-M4PF-3）。
2. 宣言は別 file に置いた（§2.3）。registry は変えない。

## 4. やらないこと

- Core による同一性の推測、Assertion の分割、既存データの遡った書き換え、AI への送信の経路、Review の Decision の粒度の変更。
