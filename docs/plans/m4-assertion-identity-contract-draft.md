# assertionId の安定同一性の契約（起案・未確認、2026-11-24）

状態：**起案**。2026-11-24 にユーザーが方向を確認した（§4.2）。送信の経路は、上限の数などを伺うまで開けない。
背景：M4 の P1-A（増分の再解釈と変更レビュー）は、cross-run の semantic diff に
「必須の安定 `assertionId`、または Producer が宣言する同等の同一性」を前提にしている
（[ロードマップ](narrative-semantic-core-roadmap.md) M4 の Prerequisite contract）。

## 1. 現状（事実）

- 契約は `assertionId` を null 可としている（`grimodex-core/src/narrative_ir.rs` の検証。null か非空文字列）。
- 出している Producer は 0 本。`nir1_entity_relation.rs` は Null を固定で書く。
- 同一性は内容の digest で取っているため、内容が変わると変わる。
- run をまたいで保たれる ID は Finding の `stable_finding_identity`（`finding_identity.rs`）だけ。
- ADR 005 は、必要になった段階で割当て規則を別途決めるとし、Deterministic Core が
  heuristic matching で同一性を捏造することを禁じている。
  [抽出 Artifact 契約](nir-extraction-artifact-contract.md) §4.1 は内容キーを導出元の第一候補とするが、
  cross-run の安定は保証しないと明記している。

## 2. 案

### 案 A：Producer が宣言する同一性（推奨）

- `assertionId` は null 可のまま。代わりに Producer が `identityDeclaration` を宣言する。
  - `kind`: `none`（今の挙動）／`content-keyed`（決定的な内容キー）／`carried-forward`（直前の Revision の ID を引き継ぐ）。
- Core は ID を推測しない。同一性が `none` の family は semantic diff の対象外とし、
  「同一性なし」と表示して「Added／Removed」の対にしない。
- 引き継ぎ（`carried-forward`）は、再解釈の task が「この前の Assertion の更新」という
  入力を持つ場合だけ。AI や作者の指定を根拠にし、Core が似ているかで決めない。
- 利点：既存の保存済みデータを変えない。ADR 005 の原則と整合。family ごとに薄く積める。
- 欠点：`none` の family が残る間は、変更レビューの対象にならない。

### 案 B：全 family で必須化

- すべての Assertion に `assertionId` を要求する。保存済み Proposal への割当てが要り、
  信頼できない割当ては ADR 005 に反する。移行の範囲が大きい。**非推奨**。

## 3. M2-D1 への適用

- Codex Entity／Relation の Producer の宣言は `content-keyed`。キーは Entry の id と関係の種別と端点で、
  表記の言い回し（`predicate`、`quote`）を含めない。
- 互換 adapter は、released workspace の保存済み Artifact を `none` として読み、書き換えない。
- Review／Projection の対応と Structure Health の規則は、この契約が確認された後に別の PR で起案する。

## 4. 伺うこと（個別確認が要るもの）

1. 新しい契約として案 A を採ってよいか（`identityDeclaration` を足す。保存範囲の拡大にあたるか）。
2. 再解釈の自動送信（AI への新しい送信）をするか。しないなら、変更レビューは作者が起こす再解釈に限る。
3. 最初の slice を M2-D1（Codex Entity／Relation）にしてよいか。

### 4.1 問い 2 の回答（2026-11-24、ユーザー原文「cで」）

- 採用：案 c（作者がオンにした場合、または件数・間隔に上限を付けて自動で再解釈を送る）。
- c は AI への新しい送信にあたるため、送信の形を決めるまで実装しない。次を起案して改めて伺う。
  1. 何を送るか：変わった範囲と影響する Consumer の根拠だけ。hidden と年表の秘匿の扱いは既存の規則に従う。
  2. いつ送るか：保存のたびでなく、編集が落ち着いた後にまとめる（間隔の下限）。
  3. 上限：1 回あたりの件数、1 日あたりの件数、費用の上限。超えたら送らず、古い印と手動の入口に戻る。
  4. 同意：既定はオフ。プロジェクト単位でオンにし、オンにした時に送る範囲を見せる。
  5. 止め方：いつでもオフにでき、保留中の task を取り消せる。
  6. 結果の扱い：新しい Revision は変更レビューに積むだけで、Story Bible は書き換えない。
- 手動の入口（案 a）は c の下位の形として必ず残す。

### 4.2 ユーザーの回答（2026-11-24）

- 問い 1：「案A で足す（推奨）」。`identityDeclaration` を新しい契約として足す。
- 問い 3：「M2-D1 から（推奨）」。最初の縦の slice は Codex Entity／Relation。
- 問い 2 の続き：「6点の方向で進める（推奨）」。上限の具体的な数は設計時に提案して再度伺う。

## 5. やらないこと

- Core による同一性の推測、既存 Assertion への遡った ID 付与、閾値の変更、公開。
