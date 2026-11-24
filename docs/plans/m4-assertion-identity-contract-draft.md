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

## 3. M2-D1 への適用（2026-11-24 に改訂。[M2-D1 の設計](m2-d1-identity-design-draft.md) が正本）

- D1 の bundle の Assertion は「ある時点の抽出結果の束」で、run をまたいで続く概念ではない。宣言は `none`（`assertionId` は null のまま）。
  先の版が書いた「D1 の Producer は `content-keyed`」は撤回する（bundle に内容キーを付けると、1 項目の変更で束の ID が変わる）。
- semantic diff の粒度は Entity／Relation の 1 件ごと。key は Producer（Codex の抽出）が宣言する Codex の id（`codex:{entity_id}`／`codex-relation:{edge_id}`）で、
  Core の推測ではない。この宣言を policy に置く点は、§4 の問い 1 の回答の外にある新しい契約面だったが、ユーザーが「registry の宣言は推奨どおりでいいです」と確認済み（2026-11-24、contracts の追記 2）。置き場は producer registry の隣の別 file（registry の digest を動かさないため、[M2-D1 の設計](m2-d1-identity-design-draft.md) §2.3）。
- 互換 adapter は、released workspace の保存済み Artifact を `none` として読み、書き換えない。
- Review／Projection の対応と Structure Health の規則は、設計文書に従って別の commit で起案する。

## 4. 伺うこと（個別確認が要るもの）

1. 新しい契約として案 A を採ってよいか（`identityDeclaration` を足す。保存範囲の拡大にあたるか）。
2. 再解釈の自動送信（AI への新しい送信）をするか。しないなら、変更レビューは作者が起こす再解釈に限る。
3. 最初の slice を M2-D1（Codex Entity／Relation）にしてよいか。

### 4.1 問い 2 の回答（2026-11-24、ユーザー原文「cで」）と、送信の形の案（advisor の意見、提案であって決定ではない）

- 採用：案 c。AI への新しい送信にあたるため、下の形をユーザーが確認するまで、送信の経路は開けない（旗を閉じた実装と docs は進める）。
- **送る中身**：同じ domain の既存の手動抽出と同じ request（同じ provider・同じ単位）を使う。新しいのは「きっかけ」だけ。
  送信先は増やさず、抽出用の provider が未設定なら何もしない。「変わった範囲だけ」の payload を新設する場合は、既存の抽出の単位を確かめて合わせる。
- **秘匿**：守る印は Codex の hidden だけ（hidden の読みはボタンでも送らない、#998）。先の版にあった「年表の秘匿」は CSR/1 で廃止方針に変わったため外す（23 に最新を確かめる）。
- **送る対象の絞り込み（2026-11-24 にユーザーが「それでいきましょう」と確認）**：きっかけの後に AI へ送るのは、保存済みの Build Action（ADR 005 の Semantic Build Graph、
  `evaluator.rs` の `evaluate_edge` が決め、`publish_runtime.rs` が辺と Consumer の state に保存する）が **`rebuild-required`** の項目だけ。
  `revalidate-exact`・`reanchor-candidate`・`resolve-only`・`recompile-only`・`refresh-available`・`none`・`manual` は AI へ送らない（決定的な再確認・再計算か、作者の手動の入口）。
  `rebuild-required` は、token も digest も合わず Read Set が Source と重なり、安い回復の道が無い場合だけ付く（`evaluator.rs:404-418`）。
  これで「内容が前回と同じなら送らない」の条件は、Build Action の判定に含まれる。同じ判定は ADR 005 の「伝播の禁止」（自動の撤回・merge・Apply をしない）とも矛盾しない。
- **きっかけ**：作者による本文の編集だけ。変更レビューの適用・取り込み・スナップショットの復元で付いた古い印では送らない（連鎖と一斉送信の防止）。
- **上限（起点の提案。実測の前の値）**：
  - 場面の内容 token が前回の送信時と同じなら送らない（必須）。
  - 場面を離れた時、または無編集 10 分。同じ場面は 30 分に 1 回まで。
  - 1 回 3 場面まで、プロジェクトごとに 1 日 20 回まで。
  - 費用は 1 日の入力 token で持つ（既存の場面 1 つの抽出の実測 token に回数の上限を掛けて決める）。金額は、能力表に単価がある場合だけ表示する。
  - 超過・失敗時は送らず、古い印と手動の入口に戻す。再試行は 1 回まで、繰り越しなし。
- **同意**：既定オフ、プロジェクト単位でオン。設定は端末側に持ち、プロジェクトの DB に入れない（他の端末・取り込みで勝手に送り始めない）。
  provider か model を変えたらオフに戻す。オンの間は表示を出し、オフにしても送信済みの分は取り消せないと書く。
- **記録**：送信の記録（時刻・場面・件数、本文なし）を残す場合は保存範囲の拡大にあたるので、同じ問いに入れて伺う。
- 手動の入口（案 a）は c の下位の形として必ず残す。

### 4.1.1 送信の形の確認（2026-11-24、ユーザー回答の原文：「送信の記録も残す」）

- 質問は 4.1 の形を 1 問にまとめたもので、選択肢は「この形で進める（推奨）」／「送信の記録も残す」／「上限の数を変える」／「自動送信はやめて手動だけにする」。
- 回答は「送信の記録も残す」。4.1 の形に加え、送信の記録（時刻・場面・件数、本文なし）を保存する。保存範囲の拡大もこの回答で確認済み。
- 残る：1 日の入力 token の上限の数は、既存の場面 1 つの抽出の実測の後に決める（技術判断の範囲）。送信の経路は、その数が決まり、旗を閉じた実装の検証が済むまで開けない。
- 公開の時の開示と、設定画面の文言は別に確認する。

### 4.2 ユーザーの回答（2026-11-24）

- 問い 1：「案A で足す（推奨）」。`identityDeclaration` を新しい契約として足す。
- 問い 3：「M2-D1 から（推奨）」。最初の縦の slice は Codex Entity／Relation。
- 問い 2 の続き：「6点の方向で進める（推奨）」。上限の具体的な数は設計時に提案して再度伺う。

## 5. やらないこと

- Core による同一性の推測、既存 Assertion への遡った ID 付与、閾値の変更、公開。
