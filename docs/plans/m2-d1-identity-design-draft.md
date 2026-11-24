# M2-D1：Codex Entity／Relation の同一性の設計（起案、2026-11-24）

状態：**起案**。技術判断は NIR-1 と同じ委任の範囲内（[引き継ぎ](m4-assertion-identity-contract-draft.md) §4、ユーザー確認済みの方向）。
前提の契約：[assertionId の契約案](m4-assertion-identity-contract-draft.md)（Assertion の任意の `identityDeclaration`、`38c7ca63b`）。

**確認済みと起案者の読み：** ユーザーが確認済みなのは契約案 §4.2 の 3 点（Assertion への任意の `identityDeclaration`、最初の slice が M2-D1、送信の形の方向）だけ。
§2 の判断（bundle は `none`、object 単位の key、registry への宣言）は起案者の技術判断で、registry の宣言は新しい契約面として次の伺いに束ねる。

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

### 2.3 Producer の宣言

- producer registry の `nir1-reviewed-entity-relation-v1` に、同一性の宣言を足す：粒度＝object、key＝`source_object_identity`、kind＝`content-keyed` 相当
  （Codex id 由来。内容 digest ではない点を明記し、名称は実装時に `producer-keyed` へ改める余地を残す。契約側の kind の語は §3 の問いで決める）。
- registry の schema は `additionalProperties: false` で厳密（semantic-index の entry は 2 つの const に完全一致）。
  宣言を足すには schema、Rust の `maintenance_contracts.rs`、TS の `validate-semantic-core-boundary.mjs` の 3 か所を揃える。

### 2.4 互換 adapter

- 保存済みの envelope は `identityDeclaration` を持たない（legacy）。adapter は書き換えず、読む側が「宣言なし＝object 単位の同一性は roster から取る」と扱う。
- 既存 workspace の roster は `source_object_identity` を既に持つので、データの移行は不要。

### 2.5 Review／Projection の対応

- Decision は bundle 単位のまま。semantic diff の各項目は「どの revision の、どの object」を指し、Decision は revision の Decision を継承する。
- 項目ごとの Decision は M4 の変更レビューの画面の設計で決める（M2-D1 では足さない）。

### 2.6 Structure Health の規則（最初の版）

- 同じ `source_object_identity` が 1 つの revision の roster に 2 回出たら異常。
- Relation の端点（`from_entity_id`／`to_entity_id`）が同じ revision の Entity に無ければ異常。
- いずれも既存の検証と重ならないかを実装前に確かめる。

## 3. 次に確かめる／伺うこと

1. §2.3 の kind の語：契約の `content-keyed`（内容由来）と、Codex id 由来の同一性を同じ語で呼ぶか。呼ぶなら契約側の定義を「Producer が宣言した key」に広げる。
   技術判断の範囲内なので、実装時に契約案へ反映し、PR 本文に残す。
2. registry の宣言を足す作業は 3 か所に跨るため、実装は 1 commit で揃えて検証する。

## 4. やらないこと

- Core による同一性の推測、Assertion の分割、既存データの遡った書き換え、AI への送信の経路、Review の Decision の粒度の変更。
