# Write-Safety A4（AI ポリシー parse）の判断記録

- 状態：**確定**（2026-11-28。脅威モデルは contracts の問 37「この範囲で確定」、停止の表示は問 36）。持ち主と判断は Mastra の lane、実装は M3。
- 基点：`463df3cb5`（起案の時点）。実装は A4 の PR で行う。
- 前提：ADR 008 §9・Invariant 11、Write-Safety Roadmap A4、Gate A DR-GA-3・DR-GA-5。

## 1. 範囲

Roadmap A4 の `projects.ai_policy` の parse を `valid / missing / invalid` に分け、破損値や読み込み異常が AI の書き込み許可へ変換されないようにする。対象は Renderer の共通 parse・機能ゲート・設定表示、Agent の main 権限発行、Hermes の会話ゲート、Rust の MCP 書き込みゲート、および同じ列を読む関連経路との整合である。

ADR 008 §9 のとおり、`invalid` でも Chat と読み取りは許可し得るが、`bodyWrite / structureWrite / knowledgeWrite` は false とし、UI に破損警告を表示する。A2 の承認時 policy 再検証は A4 の fail-closed 化に依存する（DR-GA-3）。A4 は A2 の承認・Capability 交換を再設計せず、別レーンとして扱う（DR-GA-5）。

## 2. 確かめた事実

- **Renderer parse・設定・機能ゲート。** `parseAiPolicy()` は null／空文字、不正 JSON、未知 preset、必須 toggle 欠落で全許可の `DEFAULT_AI_POLICY` を返す。必須 toggle は `Boolean()` 変換され、型違いでも true になり得る。`structureWrite` と `knowledgeWrite` の欠落は preset から補完される（[parse.ts:25-63](../../src/features/ai-policy/parse.ts:25)）。既定値自体は全許可（[types.ts:35-44](../../src/features/ai-policy/types.ts:35)）。機能ゲートは project 未取得時にも同 parser を使い（[policyGuard.ts:24-34](../../src/features/ai-policy/policyGuard.ts:24)、呼出例 [chatStore.ts:113](../../src/features/chat/chatStore.ts:113)）、設定画面も parse 結果を読む（[AiProjectSettings.tsx:46-49](../../src/features/settings/categories/AiProjectSettings.tsx:46)）。
- **新規 project の既定。** Drizzle schema と migration は新規／import project の既定を `custom` とし、自律的な `structureWrite`・`knowledgeWrite` を false にする（[schema.ts:37-47](../../src/db/schema.ts:37)、[migrate.rs:1721-1732](../../src-tauri/crates/grimodex-db/src/migrate.rs:1721)）。これは現在の parse fallback 全許可とは別の値である。`electron/shared` に独立した AiPolicy parser は見当たらず、確認した範囲は DB schema のみ（[schema.ts:37-47](../../electron/shared/readDomain/db/schema.ts:37)）。
- **Agent main の権限発行。** main parser は null／undefined を許可する。JSON 内に対象 toggle が boolean であれば、preset や他の必須項目を検査せずその値を採用するため、部分 JSON でも true が許可される（[ipc.ts:1029-1075](../../electron/main/ipc.ts:1029)）。DB 応答の行なし・読めない行形状は拒否する（[ipc.ts:1104-1130](../../electron/main/ipc.ts:1104)）。この判定は権限発行時に使われる（[ipc.ts:1674-1686](../../electron/main/ipc.ts:1674)）。
- **Hermes 会話ゲート。** chat 専用判定は null／undefined／空文字を許可する一方、不正 JSON、preset・必須欄・行形状の不正は拒否する（[mastraChatPolicy.ts:14-53](../../electron/main/mastraChatPolicy.ts:14)）。各送信前に main が DB を読み直してこの判定を行う（[mastraTurnOwner.ts:830-856](../../electron/main/mastraTurnOwner.ts:830)）。Hermes/native の書き込み tool は別途 Agent main の権限発行ゲートを通る。
- **Rust 共通 parser・MCP。** Rust の共通 parser は不正 JSON、未知 preset、必須キー欠落を `full` として成功扱いにする（[policy.rs:81-127](../../src-tauri/crates/grimodex-core/src/policy.rs:81)）。行なし／NULL／空文字も `full` となる（[policy.rs:129-141](../../src-tauri/crates/grimodex-core/src/policy.rs:129)）。MCP は書き込み tool 呼出しごとに policy を reload し（[server.rs:161-167](../../src-tauri/crates/grimodex-mcp/src/server.rs:161)）、例として scene body 提案は `body_write` を確認する（[scene.rs:163-180](../../src-tauri/crates/grimodex-mcp/src/tools/scene.rs:163)）。既存 toggle の型違いと SQL 読み込み失敗はエラーで拒否される。
- **既に fail-closed の関連経路。** NIR-1 local send は parse エラーや欠損 toggle を拒否し、`None` のみ既定許可する（[nir1_local_send_policy.rs:167-219](../../src-tauri/crates/grimodex-core/src/nir1_local_send_policy.rs:167)、[nir1_local_send_policy.rs:223-253](../../src-tauri/crates/grimodex-core/src/nir1_local_send_policy.rs:223)）。DB 読込エラーは未コミットとして送信を拒む（[project_ai_policy.rs:39-66](../../src-tauri/crates/grimodex-db/src/nir1_generation/project_ai_policy.rs:39)）。
- **正本の要求。** ADR 008 §9 は missing と invalid の区別、missing で製品既定値を使うこと、invalid で書き込み三軸を false にし UI に停止表示することを定める（[ADR 008 §9:187-203](../../docs/adr/008-agent-default-mode-and-write-approval.md:187)）。Invariant 11 は parse 失敗を fail-closed にする（[ADR 008:227-246](../../docs/adr/008-agent-default-mode-and-write-approval.md:227)）。Roadmap A4 は三状態と invalid 時の警告を掲げる（[Roadmap:111-115](agent-auto-write-safety-roadmap.md:111)）。

## 3. 判断案

- **DR-A4-1 三状態と適用値（技術判断）。**
  - `valid`：JSON の object で、`preset` が既知の値、`toggles` の `chat`・`bodyWrite`・`analysis` が boolean。`structureWrite`・`knowledgeWrite` が無い値は、今の画面側と main がともに行っている preset からの補い（named preset はその値、custom は false）をしたうえで `valid` とする。この 2 欄は 2026-06 に足したもので、列の既定値は既存の行に遡らないため（`migrate.rs` の `projects.ai_policy` の追加の comment）。この 2 欄があるのに boolean でない値は `invalid`。
  - `missing`：SQL の NULL だけ。列は `NOT NULL` なので実データでは起こらない前提。値は新規の作品の既定（custom、直接の書込みの 2 軸は false）とする。今の main と画面側は NULL を全許可にしているので、厳しい側に変わる。
  - `invalid`：空の文字列、JSON の不正、object でない値、未知の `preset`、上の必須欄の欠落や型の違い。`invalid` の effective policy は書込みの 3 軸（`bodyWrite`・`structureWrite`・`knowledgeWrite`）を false にする。会話と分析は、今の画面側の parser が読む値のままにする（必須の 3 欄がそろう形は `Boolean()` した値、そろわない形・未知の preset・JSON の不正・空は今どおり可）。読めた `false` を可にしない（Chat と読み取りを許してよいという ADR 008 §9 の範囲内で、今より緩めない。2026-11-28、M3 の指摘で訂正）。
- **DR-A4-2 全実行経路の一致。** TypeScript の画面側、Electron main、Rust の共通 parser（MCP）は同じ分類と同じ書込みの結果を出す。既存の TS／Rust の decision-vector の fixture に DR-A4-1 の例を足して揃える。画面側は機能の門と設定画面で同じ分類を使い、`invalid` を全許可として見せない。main は対象の toggle の boolean だけで許さず、DR-A4-1 の構造を確かめる（今より厳しくなる側だけ）。MCP は `invalid` を `full` にせず拒む。
- **DR-A4-3 読み込み失敗。** DB 呼出し失敗、応答 JSON の不正、対象の作品の行が無い、行の形の不正は「未設定」とみなさず書込みを拒む。MCP の `load_policy` は今、行なし・NULL・空文字をすべて `full` にしている（行なしと NULL を区別していない）ので、拒むのは新しい変更で、`load_policy` は行なし（拒む）と NULL（`missing`）を区別する。main／Hermes／NIR-1 の既存の拒否は保つ。画面側の作品が未取得・欠損の間は全許可に落とさず、書込みを止める。MCP が拒むときは固定の文で理由を返す。
- **DR-A4-4 A2 との順序。** Gate A DR-GA-3 の承認時再検証を A4 の完成後に接続する。A4 の実装・負試験が完了するまで、A2 の policy 再検証完了や flag L 解放を主張しない（DR-GA-5）。

- **DR-A4-5 状態と経路の表。** 書込みは ADR 008 §9 のとおりにし、どの経路も今より緩めない。

| 状態 | 書込みの 3 軸（全経路） | 会話・分析（画面側の門） | 会話（main の Mastra の門） |
| --- | --- | --- | --- |
| `valid` | 設定どおり | 設定どおり | 設定どおり |
| `missing`（NULL） | 新規の作品の既定（`bodyWrite` だけ可） | 可 | 可（今どおり） |
| `invalid`（空文字を含む） | 不可 | 今の parser の値のまま（読めない形は可） | 今どおり拒む（空文字は新しく拒む） |
| 行なし・読込み失敗 | 拒む | 書込みだけ止める | 拒む |

注（2026-11-28、A4 の 2 本目の前半 #1223）：実装では、main の会話の門は、必須の 3 欄がそろって `chat` が true でも、ほかの欄の型が違えば拒む。表の「今どおり拒む」より厳しい側で、Mastra の経路（旗 L の内側）だけに効く。

今の製品の経路では、壊れた作品でも会話は続き、書込みを止めた時点で会話と設定画面に出す（問 36）。Mastra の経路は旗 L の内側なので、会話ごと拒んだ画面に何を出すかは旗 L を開ける前に決める（未確認）。main の会話の門を「通す」に変えるのは緩めになるので、今はしない。

## 4. owner と lifecycle

各実行主体が policy を使う直前に読み、読み込み主体がエラーを成功値へ変換しない。Renderer は project store の同期 cache を使う既存経路を踏襲し、値が未取得なら許可を出さない。Agent main は capability 発行・承認再検証時に DB 値を読む権限 owner とする。MCP は既存どおり各書き込み呼出しで reload する。Rust 共通 parser は分類と評価を担い、I/O エラーは呼出元へ返す。Hermes chat と NIR-1 local send の既存の main／Rust 読み込み owner を維持する。

保存値が `invalid` になった場合は、該当する新しい書き込みを止め、修復・再保存後の次の判定で有効値を再評価する。承認待ちの要求が古い policy 判定を保持しないよう、DR-GA-3 に従って承認時に main が最新値を再検証する。停止・再開・再起動の新しい状態保存機構は追加しない。

## 5. 影響と PR の分け方（小さい順）

| 順 | 到達先 | 目的 |
| --- | --- | --- |
| 1 | TS/Rust decision vector と既存 parser のテスト（`parse.test.ts`、`policyDecisionVector.test.ts`、Rust `policy.rs` tests） | valid／missing／invalid の共通例と境界ケースを固定する |
| 2 | Rust `grimodex-core::policy` と MCP 各書き込み経路 | invalid／行なし／NULL の成功値 full fallback を除く |
| 3 | Renderer `parseAiPolicy`、`policyGuard`、AI 設定画面 | 状態型の導入、invalid 時の書き込み停止・警告表示 |
| 4 | Electron main Agent gate と Hermes chat gate | 全体構造検証・欠損の統一、読み込み失敗の拒否を維持 |
| 5 | 経路横断の最終確認、Gate A の A2 承認時 policy 再検証 | 全 caller が同じ契約を満たすことを確認 |

PR は既存の所有境界に従って分割し、各段階で fail-open の旧経路が残る場合は A4 完了と扱わない。範囲にない `db_execute` 等の一般 SQL 呼出しを全て policy enforcement 対象に拡張するかは、未確認の迂回経路調査後に別途決める。

## 6. 脅威モデル（確定、2026-11-28、contracts の問 37）

- **守ること：** 方針の設定が壊れている・読めない作品では、アプリ内の AI と外部の AI（MCP）の書込み（本文・構成・資料）を許さない。壊れた値を「すべて許可」と読まない。
- **信用しないもの：** 壊れた・書き換えられた保存値と、画面側の申告。DB の読込み失敗と不正な行は拒む。各経路は値を自分で確かめ、画面の表示だけを authority にしない。
- **受け入れる残り：** 壊れていても会話と分析は今どおり使える（会話を off にしていた作品でも通る）。画面側が乗っ取られた場合と、方針を確かめていない入口を新しく塞ぐことは対象外。
- **見える変化：** 今は、設定が壊れていても、作品が見つからないときや設定が空でも、MCP の書込みが通るが、これを止める。
- 新しい actor、データの送信先、保存の範囲、製品の認可は足さない。
- 範囲を広げる・狭める・残りが変わる場合は、利用者に改めて確認する。

## 7. 利用者に確認した点

回答（2026-11-28。脅威モデルは問 37、停止の表示は問 36）。問 36：「設定と会話の両方」。AI の設定画面と、書込みを止めた会話の両方に「AI ポリシーが壊れているため書き込みを停止した」と出し、設定画面で方針を選び直すと直る。画面の実装は UI の担当の作法（共有の定数と文言の規約）に従う。壊れた方針の作品で書込みを止めること自体は ADR 008 §9 の定め。

値の分類（DR-A4-1・2）は技術判断。今の製品より書込みが広がる変更は含まない。

## 8. 採らなかった案

- 欠けた欄があれば一律に `invalid` とする：2 軸を足す前の作品の書込みが止まる。
- invalid を既定の全許可へ変換する：ADR 008 §9 と Invariant 11 に反し、保存値の破損が無承認書き込みへ昇格する。
- main で対象 toggle だけを読む：別必須欄の欠落・未知 preset を見落とし、Renderer／Rust と違う判断をする。
- NULL、欠損行、読み込み失敗をひとまとめにして許可する：データとして明示された未設定と、ポリシー状態を確認できない障害を区別できない。
- A4 を A2 に同時に混ぜ、部分完了のまま承認時再検証を有効化する：DR-GA-3・5 が示す依存順を崩す。

## 9. 未確認

- 事前の事実調査で確かめた範囲の外にある、一般の `db_execute` 等を含む AI 書き込み経路全体の網羅性は確認していない。
- 既存の作品に、`invalid` に当たる値（空の文字列、壊れた JSON など）が実際にどれだけあるかは未確認。
- Renderer の project 未取得中に書き込み可能な全 choke point、設定画面で破損値を編集・修復できる既存 UI の有無、警告を表示する既存実装は未確認。
- 共通 fixture が全 TS／Rust／main／MCP の境界で直接利用可能か、MCP 各 tool の個別試験範囲、全経路の A4 受入れ試験は未確認。今回はコード・試験を変更・実行していない。
