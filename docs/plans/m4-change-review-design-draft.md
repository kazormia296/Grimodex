# M4 変更レビューの設計（起案・未確認、2026-11-25）

状態：**起案**。技術判断は NIR-1 と同じ委任の範囲内で、**確認済みと起案者の読みを分けて書く**。
前提：[assertionId の契約案](m4-assertion-identity-contract-draft.md)、[M2-D1 の同一性の設計](m2-d1-identity-design-draft.md)、
ロードマップ M4 の Epic P1-A（変更レビュー）、c7 の [Work Layer の最初の版の設計](work-layer-live-first-slice-design-draft.md) §4（置き場の整理）。

## 1. 現状（事実）

- `src/features/work-layer/ChangeReview.tsx`（159 行）と `ChangeReviewDiff.tsx` などは **UI の試作**（「UI PREVIEW」「NOT SAVED」の印つき）。
  V1／V2 の値は文字列の直書き（`ChangeReviewDiff.tsx`、タイトル「脱獄」など）で、実データには接続していない。
- c7 の最初の版（Work Layer の live 接続）は、変更レビューを**作らないもの**に挙げ、M4 の `ChangeReview` と重なる点として置き場の整理を残している（その設計 §2.5・§4）。
- 実データ側：Decision は revision（＝bundle）単位。項目ごとの Decision は無い（`nir1_entity_relation.rs:197`、review DTO に項目ごとの Decision 無し）。
- 同一性：M2-D1 の設計で、Entity／Relation は Codex の id（`codex:{id}`／`codex-relation:{id}`）で Producer が宣言し、
  semantic diff の純粋な計算（`narrative_identity_diff.rs`）は完全一致だけで Added／Removed／Unchanged／ContentChanged に分類する（呼び手なし）。
- 増分の経路：C2-1 は Freshness と Build Action を決めて保存する（`evaluator.rs`、`publish_runtime.rs`）。再解釈の送信の経路は未実装。

## 2. 置き場の整理（c7 の #1091 §4 への提案）

- **Work Layer の持ち物**：変更レビューの画面の外枠（トレイ、遷移、フォーカス、見本の印の出し分け）。`ChangeReview.tsx` の置き場はここのまま。
- **M4 の持ち物**：変更レビューの**データ**。読み取りの port（`ChangeReviewReader`、attention の port とは別）と、diff の計算、各項目の説明の材料。
- **境界**：Work Layer は `ChangeReviewItem`（§3）の一覧だけを受け取る。Work Layer の最初の版は変更レビューを触らず、M4 の live 接続が入る時に
  見本の印（`ChangeReview.test.tsx:102` が assert する印）を live の時だけ外す（c7 の設計 §2.2 の出し分けと同じ形）。
- **提案の読み取りの共通化**（23 の RD3・W2 B）は、両者が読む形が固まってから。M4 側は共通化を待たず、reader の中で閉じる。

### 2.1 接続点（c7 の連絡、2026-11-25。c7 の実装の事実で、起案者は未確認）

c7 は §2 の線引きを「c7 側の実装と食い違わない」と回答した。M4 の live 接続が入る時に触れる点（c7 の言）：

1. **見本の印の出し分け**：merge 済みの `useWorkLayerProvenance()`（`"preview"|"live"`、#1097）。出所の唯一の判定は `WorkLayerContext` の `port.kind === "live"`。
2. **入口と guard**：c7 の P3〜P5 は live の面を「トレイの Attention の行だけ」にしており、`WorkLayerSurface` は live で `tray-attention` 以外の mode を描かない。
   変更レビューを live に出す時は、この guard を `change-review`（とそこへ入る経路）で緩める。入口は live の行の `open`（`WorkLayerOpenSurface`、今は `"structure-extract-review"` だけ）に
   新しい surface 名を足し、live の port の `openSurface` に結ぶ。work-layer は features/codex 等を import しない（外の画面は port が持つ）。
3. **件数**：live の行は `WorkLayerLiveEntry`（id は今 `"codex-candidates" | "stale-proposals"`）。変更レビューの件数を足すなら id を足す。
   C2（根拠が古くなった提案）と二重に数える可能性は、#1091 §2.4 のとおり、足す版で規則が要る（数え方の正本は 23 と相談）。
4. **起動時の graph の予算**：`perf:budget` の余裕は raw 約 1.5 KB（P3〜P5 の合計で約 +4.6 KB）。live の code は動的 import の内側に置き（`workLayerLiveBundleGuard.test.ts` が静的 import と旗の guard の外の動的 import を落とす）、
   `ja.json` への文字列の追加は最小限にする（起動 graph に入る）。
5. **土台**：P5 は `WorkPulse`・`TaskTray`・`AttentionTrayBody`・`TaskTrayFooter`・`WorkLayerSurface`・`WorkLayerContext`・`types.ts` を触り、`ChangeReview.tsx` は触らない。
   M4 の renderer の実装は、P3〜P5 が merge された後の master を土台にする（c7 が merge を知らせる）。
6. **文言**：Pulse の「＋」・行の文言・出さない面はユーザー確認済み（contracts の M3 確認記録の追記 26・27）。変更レビューの作者に見える文言は M4 側で別に伺う。

これにより、実装の段（§5）の 4（renderer）は **P3〜P5 の merge の後**に回す。段 1〜3（Rust と IPC）は待たずに進められる。

## 3. ChangeReviewItem（画面が受け取る 1 件）

ロードマップの表示項目を、実際に取れるものに対応づける（**起案者の読み**）：

| 表示                                   | 取れる元                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 変更の種類                             | 今の bundle の object ごとに、その identity を含む直前の承認済み revision と比べる（Added＝追加、ContentChanged＝改訂、Unchanged＝影響なし、Unresolved＝走査の上限で前が見つからず判定できない）。**Removed は出さない**（選択に含まれなかっただけの object を消失と誤報しないため。元の Codex の項目の消失は Freshness の `source-missing` が扱う）。Evidence の移動・喪失は `(source_ref, quote)` の完全一致で取り、Relation は `evidence_ids` のみで本文が無いので比べない |
| 前の承認／保留の値、新しい提案         | object ごとの直前の承認済み revision（履歴 reader で承認時点の姿を読む）と、今の revision の同じ object                                                                                                                                                                                                                                                                                                                                                                       |
| 原因の本文                             | 新しい Evidence の `quote` と本文の範囲                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Review・Freshness・Projection の状態   | Decision（revision 単位）、Freshness／Build Action（保存済み）、Projection の状態                                                                                                                                                                                                                                                                                                                                                                                             |
| 影響する下流                           | 逆引きの依存辺（`narrative_dependency_edges`）                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 適用／却下／保留／編集／この根拠は無視 | revision 単位の Decision で実現できる範囲だけ（§4）                                                                                                                                                                                                                                                                                                                                                                                                                           |

最初の版で扱う種類：追加・消失・改訂・影響なし、Evidence の移動・喪失。**後に回す**：Scope の変更、矛盾の導入、置換、撤回の提案
（それぞれ別の材料が要る。無理に最初の版に入れない）。「作者が起こす再解釈の結果」だけを扱う（送信の経路が閉じている間は手動）。

## 4. Review と Projection の対応

- **項目ごとの適用・却下は、今の Decision の粒度（revision 単位）では実現できない**。項目ごとにするには、revision を分けて新しい Proposal Revision を作る
  （受け入れた項目だけを含む）か、Decision に項目の粒度を足す必要があり、どちらも**新しい契約**になる。ユーザーに伺う（§6）。
- 最初の版の案：変更レビューは**読み取り**で、項目は全部見せるが、操作は「この revision を適用／却下／保留」（既存の Decision）だけ。
  「編集」「この根拠は無視」「correction-rule の作成」は出さない（correction-rule は ERM が棚上げ中で、最初の版から外すとユーザーが決定済み）。
- Projection の状態：変更レビューで適用しても Story Bible を黙って書き換えない（M4 の約束）。適用は既存の Apply の経路を通る。

## 5. 実装の段（旗は閉じたまま、小さい commit、依存順）

1. Rust：今の bundle の object 一覧と、object ごとの直前の承認済み revision の一覧から `IdentityDiffObject` を作る読み取り（純粋な変換）と、Evidence の移動・喪失の比較（純粋な計算）。呼び手なし。
2. Rust：`ChangeReviewReader` の read（DB を読む。Decision・Freshness・Build Action・下流の逆引きを付ける）。読み取りだけで、保存しない。
3. IPC：読み取り専用の typed command（`electron/shared/ipcContract.ts` が正本。[add-electron-command](../../.agents/skills/add-electron-command/SKILL.md)）。旗が閉じている間は renderer から呼ばれない。
4. renderer：`ChangeReviewItem` を受け取る live 経路を `ChangeReview.tsx` に足す（見本の経路は残す。印の出し分けは c7 の設計に合わせる）。**UI の実装は Claude が持つ**（ユーザー 11-24、c7 経由の伝聞）。
5. 公開の時に旗を開ける（別の明示の指示）。

### 5.1 段 2 で分かったことと、独立レビューでの修正（2026-11-25）

- 既存の typed revision の reader は、revision の source token を live の source と照合する。承認後に元の Codex の項目が変わると前の revision は読めなくなる。
  対応として、live の Scope・source token・Freshness を照合しない**履歴の reader**を足した（`e6d727719`、DR-M4PF-8）。
- 独立レビュー（Fable、read-only）の指摘 H1：typed revision は場面と選択ごとに別々に作られ、project に承認済みが複数並ぶ。
  「直前の承認済み revision」を project の typed lane から 1 つ選ぶ定義は、別の場面の承認を「消えた」と誤報する。
  **今の bundle の object ごとに、その identity を含む直前の承認済み revision と比べる**定義に改め、`removed` は出さない（DR-M4PF-9）。
  走査は上限つきで、上限で打ち切って前が見つからない object は `Unresolved` とし、「無い」と推測しない（有界の lookup の契約）。
- 読めない理由は enum にして区別する（今の revision が読めない／前の revision の破損）。復元の後の最初の revision は、旧 epoch の承認済みを SQL で除外して「初回」として読む。
- 後から hidden／suppress にした Codex の項目は、変更の種類だけ返し、Evidence の引用は返さない（DR-M4PF-8 の追補。AI の経路につなぐ前の守り）。
- 実装の現状：Decision は `review_status` のみ、Freshness は consumer の点引き、下流の逆引きは別関数（`nir1_change_review_downstream.rs`）で未接続（選んだ項目ごとにカーソルで引く）。

## 6. ユーザーに伺うこと（束ねて）

1. 項目ごとの適用・却下を最初の版に入れるか（新しい契約＝revision の分割、または Decision の粒度の拡張が要る）。推奨：入れない（revision 単位で始める）。
2. 画面の見た目・文言（UI は Claude が持つが、作者に見える変化なので出す前に伺う）。

## 7. やらないこと

- 旗を開ける、AI への送信の経路を開ける、Story Bible の自動書き換え、correction-rule、Scope／矛盾／置換／撤回の種類（最初の版）。
