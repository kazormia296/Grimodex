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

- **DR-M4PF-1（契約）**：Assertion に任意の `identityDeclaration`（`none`／`content-keyed`／`carried-forward`）を足す。不在は従来どおり。検証だけで、ID を生成しない。`assertionDigests` の定義域に入れない（宣言の有無で `assertionCoreDigest`・`assertionDigest` は変わらない。宣言を束縛するのは envelope 全体の digest だけ。ユーザー確認：問い 1）。
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

- **DR-M4PF-8 の追補（独立レビューの指摘、2026-11-25）**：履歴 reader は既存の reader より次の 2 点が緩い。(1) `current_revision_id` を要求しない（変更レビューの SQL が current でない revision を選ばないので、この読み取り経由では届かない）、
  (2) material の契約が Superseded の revision も通す（承認時点の姿を読むため）。Decision（人による承認）・restore の epoch・束縛・bundle の検証・envelope と nested digest は、既存の reader と同じ強さ。
  後から hidden／suppress にした Codex の項目の引用（summary の全文）は、読み取りの出口で止める（変更の種類は返し、`evidence` は空にして `evidenceWithheld` を立てる）。AI の経路につなぐ前の条件。
- **DR-M4PF-9（変更レビューの比較の定義）**：typed revision は場面と選択ごとに作られ、project に承認済みが複数並ぶ（独立レビュー H1）。「直前の承認済み revision」を 1 つ選んで集合の差を取る定義は、別の場面の承認を消失と誤報するため採らない。
  今の bundle の object ごとに、その identity を含む直前の承認済み revision（現 epoch、project・typed lane・承認済み、時系列）と比べ、`removed` は出さない。走査は上限つきで、上限で前が見つからない object は `Unresolved`（無いと推測しない）。
- **DR-M4PF-10（保存の境界）**：検証器は `identityDeclaration` を受理する（DR-M4PF-1）が、今の Producer は出さない。宣言つきの envelope が保存の経路で保存され、親から子の revision へ引き継がれる事態を避けるため、
  Producer が宣言を出す段まで、保存の境界（reconciliation envelope の検証）で宣言を拒む。宣言を出す Producer の追加は、この拒否を外す変更と一緒に行う（別の判断）。

- **DR-M4PF-11（IPC `nir1_change_review_read`、2026-11-25。IPC の差分だけの独立レビュー〔Fable、read-only〕の後）**：
  1. 読み取り専用の command を足す（`projectId`・`revisionId`、main と N-API で再検証、`admit/finish_publication_entry`、read transaction）。呼び手なし。
  2. D2a の区分は**変えない**（main の台帳に未登録＝`unclassified`）。restricted／unavailable の profile では main が dispatch の前に拒む。`profileEgress.test.ts` に 1 行足して固定する。呼び手を付ける段の前に区分（`nir1-publication` に載せるか）を決める。載せるのは区分の改訂なので、判断を残す。
  3. main に「旗が閉じている間は拒む」仕組みは置かない。**「旗は閉じたまま」は呼び手が無いという意味で、main の強制ではない**（unrestricted の renderer の script は直接呼べる）。読めるのは作者の指定 project の typed revision の変更レビューで、手本の A2 の read（gate なし）と同格。新しく出るのは、live の検証を通らない過去の承認済み revision の引用（同じ transaction で可視と確かめた identity に限る）、`previousRevisionIds`、`buildAction`、revisionId 指定の Draft。
  4. 呼び手を付ける段（変更レビュー設計 §5 の段 4）の前に決める／足す：`expectedWorkspacePath` の必須化（手本の 2 本と同じ。workspace の切替との交差で別 workspace の結果を表示しうる）、D2a の区分、`src/lib/tauri.ts` の read lane の表への登録、応答の形（手本は `{status, result}`、本 command は平坦）の固定。
  5. **AI の経路につなぐ前の条件**：effective な context mode（Phase の override を含む）の再評価と、object ごとの除外。今の抑止と current の reader は base の `context_mode` だけを見る。

## 脅威モデル（GDX-PRECHECK-001、変更レビューの読み取りの出口。2026-11-25）

委任の範囲：送信先・保存範囲・閾値の変更を含まず、守りを**狭める**側の修正（NIR-1 と同じ委任の範囲内の技術判断）。ユーザーの個別確認は要らない（確認が要る送信の経路は未実装）。

| 項目           | 内容                                                                                                                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 信頼する actor | ローカルの作者（画面の持ち主）。同じ project の DB に保存済みの、人が承認した revision の payload と envelope（束縛と digest の検査を通ったもの）                                                                                                                                                                     |
| 信頼しない入力 | 別 project の行、束縛・digest の検査に通らない payload、承認の後に hidden／suppress にした Codex の項目の本文（引用）を AI・外部へ渡す将来の経路                                                                                                                                                                      |
| 守る資産       | hidden／suppress の Codex の項目の summary 全文（Evidence の引用）。project の境界。保存済みの承認の不変性                                                                                                                                                                                                            |
| 対象の攻撃     | (1) 承認後に hidden にした項目の引用が、読み取りの出口から返り、将来の agent tool・MCP・自動再解釈の request に載る。(2) 別 project の revision・object の読み取り。(3) 破損・改ざんされた payload の読み取り。(4) 同じ引用の Evidence による読み取り全体の失敗（可用性）                                             |
| 対象外         | 作者本人が DB ファイルを直接書き換える攻撃。作者向けの画面で、作者が自分の hidden の項目の存在を知ること（識別子の表示は漏れでない）。AI の経路そのもの（未接続。つなぐ時に別に守りを確かめる）                                                                                                                       |
| 防御           | 読み取りの出口で、live が hidden／suppress（または存在しない）の object の `evidence` を空にして `evidenceWithheld` を立てる。全 SELECT を project_id で縛る。履歴 reader は Decision・epoch・束縛・digest を確かめる。読み取りだけ（書き込み SQL を持たない）。同じ引用の Evidence は多重集合として比べ Err にしない |
| 受入れ（試験） | hidden にした後の evidence が空で `evidenceWithheld`、別 project は読めない、読む前後で行数が変わらない、同じ引用 2 件で Err にならない、走査の上限で Unresolved、有界の lookup の契約                                                                                                                                |

## 信頼境界

- Core は同一性を推測しない。同一性は Producer が宣言した key の完全一致だけ（ADR 005 の「Stable identityがない場合、heuristic matchingでidentityを捏造してはならない」を保つ）。
- 新しい送信先・保存・閾値の緩和・公開・製品認可の削除・新しい authority は、この段階のコードに含まれない（送信の経路と送信の記録の保存は未実装）。検証器が受理する形は `identityDeclaration` の分だけ広がるが、保存の境界で拒む（DR-M4PF-10）。
- S4 の pin の閉包（`src/`・`electron/`・`scripts/local-ci*` で止まる）と、触るファイルは重ならない（`observation-prep.mjs:1224-1233`、harness から 0 件の参照）。

## 脅威モデル（IPC `nir1_change_review_read`、2026-11-25。DR-M4PF-11）

| 項目           | 内容                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 信頼する入力   | main が発行する caller identity（webContents 単位）と、Native の active workspace                                                                                                                                                                                                                                                                         |
| 信頼しない入力 | renderer の `projectId`／`revisionId`（main と N-API で再検証し、SQL で project への所属を確かめる）、renderer が混ぜる `callerIdentity`                                                                                                                                                                                                                  |
| 守る資産       | typed NIR-1 の payload（汎用 SQL では全モードで読めない列）、restricted profile の plaintext の公開、hidden／suppress の Codex を AI へ出さないこと                                                                                                                                                                                                       |
| 対象の攻撃     | renderer 内の任意の script が旗に関係なく直接呼ぶ／restricted や workspace の切替と交差する完了／将来この結果を AI の文脈へ流す変更                                                                                                                                                                                                                       |
| 防御           | 引数の再検証は main と N-API の 2 段。restricted では main が `unclassified` で拒む。Native は開始時と返す直前に admit／finish で確かめる。current の reader は hidden／suppress の Codex を含む revision を丸ごと `current-revision-unavailable` にする。出口の `evidenceWithheld` は多層防御。read transaction の中だけで、送信・書き込み・event はない |
| 受入れ         | 呼び手なし。restricted で拒む試験。D2a の区分と `expectedWorkspacePath` は呼び手を付ける前に決める（DR-M4PF-11 の 4）                                                                                                                                                                                                                                     |
