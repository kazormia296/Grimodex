# 伏線の「AI にこの伏線を見せない」の廃止（FSR/1）の実装の判断の記録

- 起案：`docs/plans/nir1-foreshadow-secret-ai-side-retire-proposal-1-draft.md`（FSR/1。ユーザー確認 102・105・118〜120・123・129・130。記録は contracts の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`）。
- 方針：伏線の `secret` を、**AI への渡し方についてだけ**やめる。未回収・未放棄の伏線は全部 AI に渡す。列と既存の値は残す。関連する過去シーンの判定（A3）・本文の宣言の veto・作者向けの警告（目のアイコン）は、列を読み続ける。製品の変更は最後の凍結の前に master に入れ、**公開版（release）には、全部（F1・F2・F3・F9・F10）が入った後に、F7 の測定の結果をユーザーに見せてから出す**。
- 担当：grimodex-23。実装は PR を分ける：F1（この版）→ F3・F2（同じ release。F2 は F3 より先に出さない）→ F9（回収済みの一覧）→ F10（省いたときの 1 行）。

## 1. この PR の範囲：F1（渡し方）

**入れる**：未回収の伏線の一覧から `secret` の条件を外す 5 か所と、それに合わせた試験・golden・説明文・設計書。
**入れない**：`create_foreshadow`・`update_foreshadow` の `secret` の引数と既定（ON）、画面のチェック（F2）、書き口の既定の変更（F3）、列の DEFAULT、undo／trash の既定、回収済みの一覧（F9）、省いたときの 1 行（F10）、関連する過去シーンの判定・本文の宣言の veto・目のアイコン、`events.secret`（CSR/1）。

### DR-FSR-1　未回収の伏線の一覧から、`secret` の条件を外す（F1）

- 外した所：Native `foreshadow.rs` の `list_open_for_context`（`WHERE project_id = ? AND payoff_confirmed = 0 AND abandoned = 0`）、renderer の in-browser 枝（`src/features/foreshadow/api.ts` の `readOpenForeshadowWire`）、MCP `db.rs` の `list_open_foreshadows`、MCP `tools/context.rs` の `get_writing_context`（今の場面の仕込み・回収の 2 本と、全体の未回収）。**この 5 か所で、チャットの自動の文脈（「### 未回収の伏線」）、アプリ内の `list_open_foreshadows`（core は Native の wire を使う）、MCP の `list_open_foreshadows` と `get_writing_context` が揃う。**
- 残す条件：`project_id`・`payoff_confirmed = 0`・`abandoned = 0`（MCP の今の場面の仕込みは `s.is_orphan = 0` も）。**回収済みと放棄は、今までどおり、自動の一覧にも、指定なしの道具にも含めない**（確認 102 の文は「未回収の伏線を全部」）。形（題・意図・状態の印・重要度・仕込みの件数）と、枠（約 1000 token。超えると critical だけ）は変えない（超えて省いたときの 1 行は F10）。
- **アプリ内の今の場面の伏線（`foreshadow.rs` の scene の関連）と、`get_foreshadow_detail` は、元から `secret` を見ない（変えない）。** MCP の `get_writing_context` だけが、今の場面の伏線を `secret` で除いていた食い違いは、解消した（アプリ内と揃う）。
- core `electron/shared/readDomain/core/foreshadowTools.ts` の本体のコードは変えない（注とコメントだけ）。wire に `secret` の列は無いので、core はもともと再び絞らない。DR-MP4-24（Mastra の「list は `secret = 0`、detail は判定なし。非対称。MP-4 は同値で写し、変えない」）は、**この非対称を解消する側に変わった**。固定していた試験・golden・Native の SQL の写し（`readCore.mainAdapter.test.ts`）を直した。Mastra の担当（grimodex-32）には、PR で中身（list の第 1 case に `secret = 1` の伏線 `fs-2` が入ること）を見てもらう。

## 2. 残る制限（F1 の後。F1 だけでは公開しない）

起案の §3 の 1〜4 のとおり（どれも、ユーザーに伝えた上で確認済み）。この PR に特有の点：

- **この PR の後も、`create_foreshadow` の既定は ON のまま**（F3 で OFF にする）。AI が作る伏線は、`secret = 1` で保存されるが、AI への渡し方では、もう効かない。`create_foreshadow` の説明は「secret items are hidden from list_open_foreshadows and AI context …」と言っており、**この PR の後は偽り**になる。F3 で、道具の定義から `secret` を消すときに直す（AI 指示の資産。`grimodex-author` の品質ゲートを通す別の PR）。
- 画面のチェック「AI にこの伏線を見せない（ネタバレ防止）」は、F2 まで残る。ON にしても、AI への渡し方には効かない。**公開版には、F1・F2・F3 が全部入った後でだけ出す**。
- 題・意図・メモの文中の hidden の名前は、判定できず、そのまま渡る（起案の §3 の 2。確認 120 (a)）。
- 実 addon（`mastraReadParity.pipeline.spec.ts`）は、hosted の `electron-native` が最終の確認。

## 3. 検証

F1 の PR の本文（#1093）に書いた。

## 4. この PR の範囲：F3（書き口と既定。2026-11-24）

**入れる**：新しい伏線の既定を OFF（`secret = 0`）にそろえる（確認 105）、AI・MCP が伏線の `secret` を書けない（確認 118）。**入れない**：画面の編集ダイアログのチェック（F2。別の PR。F3 と同じ release に入れ、F3 より先に出さない）、回収済みの一覧（F9）、省いたときの 1 行（F10）、列の DEFAULT、関連する過去シーンの判定（A3）・本文の宣言の veto・作者向けの警告（目のアイコン。列を読み続ける）、年表の `events.secret`（CSR/1）。

### DR-FSR-2　新しい伏線は印なし。AI・MCP は `secret` を書けない（F3）

- **既定を OFF にそろえた**（`secret` の鍵が無い値だけに効く。鍵が有る値は今までどおり）：undo の再適用 4 か所（`grimodex-core` の `undo_journal.rs`。INSERT 側 2・UPDATE 側 2。`unwrap_or(1)` → `unwrap_or(0)`。列導入前の伏線は migration で 0 になったので、0 が当時の値と合う）、ゴミ箱の復元（`trash_bin.rs`）、Native `foreshadow_create` の payload の serde の既定、renderer の `agent-writes/foreshadow.ts`・`createForeshadow`・ゴミ箱の restorer・browser-mock の 2 か所、main の既定の表（create の `secret: false`）。**main と renderer の既定は同じ PR で同時に変えた**（`agentMutationProjectionMatches` は、省かれた欄の既定を main が埋めて renderer の payload と一致を見る。片方だけだと、`secret` を省いた `create_foreshadow` が capability を得られない）。
- **列の DEFAULT は変えない**（`migrate.rs`・`schema-seed-ja.sql`・`schema.ts`・`schema-contract.json`・`seed_schema_parity.rs`）。書き口が値を必ず渡すので DEFAULT が効くのは、列を省いた生 SQL（開発用・試験）と、`secret` の鍵が無い古いスナップショットの復元だけで、変えても効くのは新しく作る DB だけ。規則を少なく保つ（技術判断。R3）。
- **線引き**：

| 入口 | `secret = true` を書けるか |
| --- | --- |
| 画面の作成・スニペット | 欄が無い（false） |
| 画面の編集（`foreshadow_update`） | F2 までチェックで書ける（F2 で消す） |
| アプリ内 AI の `create_foreshadow` | **書けない**。`true` は廃止を述べて拒む。`false`・省略は通す（`secret: false`） |
| アプリ内 AI の `update_foreshadow` | **書けない**。`secret` の鍵は `true` も `false` も廃止を述べて拒む |
| MCP の `create_foreshadow`／`update_foreshadow` | 同じ。`secret` は schema から隠し（serde は読む）、create の `true`・update のどの値も `invalid_params`（update は `no fields provided` の検査より前） |
| 共有 Rust の `agent_foreshadow_create／update_with_context_impl`（関門。R15） | AI の surface（`manual`・`import` 以外）は書けない（create の `true`、update の `Some(_)`）。書く前・冪等の再送の検査より前に拒む |
| `foreshadow_create`（人間の書き口。評価の書き口。`createForeshadow` の型の `secret` の欄を残す） | 書ける（値を受けて保存。確認 105 の条件） |
| undo・redo・復元・スナップショット・書き出し・import | 値を運ぶだけ |

- **update の `false` を黙って捨てない理由**：Native への payload は `secret: null`、モデルの入力は `secret: false` が present なので、投影の照合が一致せず、更新全体が理由の分からない失敗になる。通すと、AI が既存の印を作者に見えないまま外せる（確認 118 は「外すことだけ、AI に残す」を選ばなかった）。create の `true` を拒むのは、印が AI への渡し方に効かなくなり、関連する過去シーンの判定（A3）にだけ効くので、AI が付けた印が作者に見えないまま積もるのを止めるため。
- **main の 3 つの表（モデルの表・実効の表・既定の表）は `secret` の鍵を残す**（モデルに見える schema から消しただけ。受け口を残さないと、過去の会話の履歴の `secret` つきの呼び出しをモデルが真似たとき、欄に無い鍵で入力が不正になり、理由の分からない失敗になる）。説明つきのエラーは renderer の実行側が先に返し、main の検査（`electron/shared/agentForeshadowSecretWritePolicy.ts`。capability の発行側は不正な入力を黙って `continue` するので、説明を返せない）は背後の防御（Mastra の MP-6 が再利用できる純粋な関数）。
- 結果の `secret`（`create_foreshadow` の `{ id, title, secret }` と summary の「(secret)」、MCP の `CreateForeshadowResult`）は外した（常に false で意味が無い）。道具の定義・MCP の説明・設計書の「secret items are hidden …」を直した。
- **MCP の update の `secret: null` は省略と同じに読まれる**（`Option<bool>` は `null` と欠落を区別しない。`secret` の値は変わらない。年表の `update_event` と同じ扱い。独立レビューの P2。doc コメントに明記）。
- **抽出の commit**（`foreshadow_operations.rs`・`commit.rs`）は、提案の JSON の `secret` をそのまま保存するが、製品に伏線の提案を op に compile する層が無く、`true` が入る経路は無い。規則は足さない（R17。将来その層を足すときは、その層で `secret` を `false` に固定する）。

### 残る制限（F3 の後）

- 画面の編集ダイアログのチェックは、F2 まで残る（ON にしても、AI への渡し方には効かない）。**公開版（release）には、F1・F2・F3・F9・F10 が全部入った後に、F7 の測定の結果をユーザーに見せてから出す。**
- 既存の `secret = 1` の伏線は、値が残り、A3 と本文の宣言の veto だけが読み続ける（確認 129）。画面から外せない（F2 の後）。
- 実 addon の spec・`electron/native/grimodex-node/test/agent-writes.test.mjs` は、hosted の `electron-native` が最終の確認。

## 5. この PR の範囲：F9（回収済みの一覧。2026-11-24）

**入れる**：アプリ内と MCP の `list_open_foreshadows` に、回収済みを求めたときだけ返す指定を足す（確認 119）。**入れない**：自動の一覧（チャットの文脈。未回収だけのまま）、省いたときの 1 行（F10）、Native の SQL・IPC の契約・napi・`profileEgress.ts`、`secret`（F1・F3 で済み）。

### DR-FSR-3　`list_open_foreshadows` に `includeSettled`（MCP は `include_settled`）を足す（F9）

- **形**：新しい道具は足さず、今ある道具に任意の引数を足す（確認 119 の (1)(2)）。省略・`false`・`undefined` は今までどおり（未回収・未放棄だけ。結果の形・summary・`tokensUsed`・golden を変えない）。`true` のとき、未回収・未放棄に加えて、**未放棄の回収済み**（`payoff_confirmed = 1`）を返し、回収済みの行だけ `settled: true` を付ける。**放棄は含めない**（確認 119 の (3)）。`secret` では絞らない。`"true"`・`1`・`null`・配列は、説明つきで拒む（アプリ内）。
- **Native の契約を足さない（B 案。技術判断）**：回収済みを返す読みを新しく作らず、既存の `foreshadow_list_with_labels`（人間用の全件の読み。`OWN_DATA_READ_COMMANDS` に登録済み）の wire を使い、**core で放棄を落とし、最小の射影**（`id, title, intent, loadBearing, setupCount`＋`settled`）にする。wire は `notes`・`secret`・`payoff_scene_id`・setup の `scene_id` を持つので、結果に出さない（試験で固定）。A 案（`foreshadow_list_open_for_context` に引数を足す）は、IPC・napi・生成される d.ts・Rust・凍結中の Tauri shell を 1 PR で変える（Tauri shell は新機能の置き場にしない）ので採らない。
- **port は別メソッド**（Mastra の担当〔grimodex-32〕の推奨）：`CoreNativeReads.foreshadowOpen` に引数を足さず、`foreshadowListWithLabels` を足す。`foreshadowOpen` が 2 つの Native command・2 つの wire・2 つの timeout 方針を持つと、`mastraReadParity.pipeline.spec.ts` が `foreshadowOpen` の wire を Native と byte で固定している意味が濁る。`foreshadowOpen` とその wire・golden は 1 byte も変えない。`typed.ts` の adapter は `foreshadow_list_with_labels` を `{ projectId }` で、`timeoutMs: null`（`foreshadowOpen` と同じ DR-MP4-4 の方針）で呼ぶ。DR-MP4-24 の非対称の解消（DR-FSR-1）の続き。
- **並び**：未回収の行は今までどおりの順（loadBearing の優先度 → updatedAt の新しい順）で先に、回収済みの行はその後に（同じ比較）。summary：`N foreshadowing items (M settled)`（指定なしは `N open foreshadowing items` のまま）。
- **二 engine の同値**：renderer の legacy executor と main の core が、同じ固定入力で同じ結果（content・summary・`settled`）を返すことを試験で固定した（`readCore.mainAdapter.test.ts`）。renderer の in-browser（Drizzle）の枝は、Native の wire と同じ形を返す。
- **MCP**：`include_settled: Option<bool>`（snake_case。省略・`false` は今までどおり）。`settled: Option<bool>` は `skip_serializing_if` で、`true` のときの回収済みの行にだけ出る。`version`・`derivedLabel` は維持する。`get_writing_context` の結果は変えない（`false` で呼ぶ）。登録された道具の `inputSchema` に `include_settled` が出ることを試験で固定した。
- **JSON の `null`**：MCP の `include_settled: null` は省略と同じに読まれる（`Option<bool>`）。アプリ内は `null` を拒む（`typeof` の検査）。

### 残る制限（F9）

- **`setupCount` の数え方が、アプリ内と MCP で違う**（F9 の前からの差）：アプリ内は orphan でない setup を数え、archived の場面の setup も含む（Native の wire に `scene_id` が無く、core で絞れない）。MCP は archived の場面の setup を除く。回収済みの行でも同じ差が見える。AI には「同じ伏線の件数が道具によって違う」と見えうる。
- アプリ内の `includeSettled: true` の結果には、派生ラベル（`derivedLabel`）が無い（指定なしのアプリ内の結果にも無い。道具の定義文が「derived lifecycle labels」と言う既存の不一致は、この PR では直さない）。MCP は `derivedLabel` を返す（意図的な差）。
- 実 addon の spec（`mastraReadParity.pipeline.spec.ts`）は、hosted の `electron-native` が最終の確認。
- **公開版（release）には、F2・F10 が入った後に、F7 の測定の結果をユーザーに見せてから出す。**
