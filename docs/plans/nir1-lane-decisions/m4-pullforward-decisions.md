# M2〜M4 の前倒し（M2-D1 の同一性）— 判断の記録（DR-M4PF）

この文書は、`identityDeclaration` と object 同一性の宣言を入れる最初の mutation の前後に、判断と信頼境界を残す。
委任の根拠は、ユーザーの決定（contracts `28a831c2c`、`user-confirmation-2026-11-24-m4-pullforward.md`）：M3 と同じ範囲で技術判断を任され、
新しい契約・authority、保存範囲の拡大、AI への新しい送信、閾値の緩和、公開、製品の認可の削除は個別に伺う。

## 出所

| 項目           | 内容                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 設計           | [assertionId の契約案](../m4-assertion-identity-contract-draft.md)、[M2-D1 の設計](../m2-d1-identity-design-draft.md)                                                                 |
| ユーザーの確認 | 契約案 §4.1.1・§4.2（問い 1＝案 A、問い 3＝M2-D1 から、送信の形＝「送信の記録も残す」）。registry の宣言は「推奨どおり」。確認の記録は contracts の追記 1〜3                          |
| 実装           | `38c7ca63b`（identityDeclaration の検証）、`67dbea047`（semantic diff の純粋な計算）、`6f7395e44`（宣言の policy）。いずれも旗は閉じたまま、呼び手なし（diff）、AI への送信の経路なし |

## 判断

- **DR-M4PF-1（契約）**：Assertion に任意の `identityDeclaration`（`none`／`content-keyed`／`carried-forward`）を足す。不在は従来どおり。検証だけで、ID を生成しない。digest は変えない（ユーザー確認：問い 1）。
- **DR-M4PF-2（M2-D1 の同一性の粒度）**：bundle の Assertion は 1 件で `none` のまま。同一性は Entity／Relation の 1 件ごとに、Producer が宣言した Codex の id（`codex:{entity_id}`／`codex-relation:{edge_id}`）で取る。Assertion の分割はしない（保存済み envelope・Decision・index・digest が全部変わるため）。
- **DR-M4PF-3（宣言の置き場）**：registry の中身は maintenance の `producer_generation_set_digest` に入る（`maintenance_contracts.rs:543`）。足すと完了済み run の skip evidence が全部無効になるため、隣の別 file `narrative-object-identity-declarations.json` に置き、producerId で紐づける。registry の SHA-256 は不変。kind の語は `producer-declared-object-key`（契約の `content-keyed`＝内容由来と混ぜない）。
- **DR-M4PF-4（semantic diff）**：identity の文字列の完全一致だけで Added／Removed／Unchanged／ContentChanged に分類する純粋な関数。あいまい一致・正規化・類似度を使わない。重複・空は Err。Codex の Entry が削除・統合されて id が変わる場合は、同一視せず「消えた」と「現れた」の対で出す。
- **DR-M4PF-5（Structure Health）**：revision の内側の規則（重複、Relation の端点）は既存の検証が守っているので足さない。revision をまたぐ規則（説明のない消失）は M4 の diff の段に置く。
- **DR-M4PF-6（自動再解釈の送信の形、ユーザー確認：追記 3）**：既存の手動抽出と同じ request・同じ provider（送信先は増やさない）。hidden の Codex は送らない。きっかけは作者の本文編集だけ。送る対象は保存済みの Build Action が `rebuild-required` の項目だけ。既定オフ・プロジェクト単位でオン・設定は端末側・provider か model を変えたらオフに戻す。送信の記録（時刻・場面・件数、本文なし）を保存する（保存範囲の拡大の確認済み、項目を広げるときは改めて伺う）。**送信の経路は開けていない。**
- **DR-M4PF-7（token の上限）**：1 日の入力 token の上限は新しく設ける上限で、閾値の緩和ではない。数は既存の場面 1 つの抽出の実測の後に決め、ここと PR 本文に残す。経路を開けて作者に出す時期は、その時に改めて伺う。

- **DR-M4PF-8（変更レビューの読み取りと履歴の reader）**：変更レビューは、今の revision（未承認でもよい）と、同じ project の typed lane で時系列が前の承認済み revision を比べる。
  既存の typed revision の reader は source token を live と照合するため、承認後に元の Codex の項目が変わると前の revision が読めず、`content-changed` に到達できない。
  そこで、live の Scope・source token・Freshness の照合を行わず、保存済みの payload の完全性（Decision、束縛、bundle の検証、envelope の digest）だけを確かめる**履歴の reader**を足す。
  承認済みの payload は不変で、比べるのは「承認した時点の姿」と「今の提案」なので、live との照合は要らない。読み取りだけで、保存を変えない。既存の reader は変えない（重複は許し、後で整理する）。
  前の revision だけをこの reader で読み、今の revision は従来の reader（live 照合つき）で読む。

## 信頼境界

- Core は同一性を推測しない。同一性は Producer が宣言した key の完全一致だけ（ADR 005 の「Stable identityがない場合、heuristic matchingでidentityを捏造してはならない」を保つ）。
- 新しい送信先・保存・閾値の緩和・公開・製品認可の削除・新しい authority は、この段階のコードに含まれない（送信の経路と送信の記録の保存は未実装）。
- S4 の pin の閉包（`src/`・`electron/`・`scripts/local-ci*` で止まる）と、触るファイルは重ならない（`observation-prep.mjs:1224-1233`、harness から 0 件の参照）。
