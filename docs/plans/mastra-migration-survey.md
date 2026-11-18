# Mastra 移行の調査（read-only、2026-11-18）

- 状態：調査の記録。spike の前。ユーザーの判断（loop と tool は main、送信は Rust、telemetry は止める、memory を使う、依存を受け入れる）を前提にした。
- 方法：5 観点の並列調査 → 統合 → 点検（workflow `wf_6aa0cac4-7cd`）。点検の訂正は末尾の付録 A。


基点：worktree `/home/grimodex/worktrees/Grimodex/model-caps` の HEAD は 8f63ac8e。origin/master の 01dd6821 の子孫で、docs の commit が 1 件載るだけなのでコードは同じ。
追加で軽く確かめた点は 3 つ。`package.json:173` の `"ai": "^7.0.112"`、electron 43.8.3、`workload-allocation.json` が worktree に無いこと。
`zod` は `package.json` の直接依存に無い。
5 観点の調査は @mastra/core を導入せず読んだだけなので、Mastra 側の実行時挙動は未確認が多い。

## 0. 先に結論

- 「送信は Rust のまま」でも、request の bytes は同じにならない。bytes を決める messages・tool schema・history の組立てが Mastra と memory 側へ移るため。
- 影響は loop と tool の所在だけにとどまらない。次のものが一緒に動く。
  - AI 監査の書き手（今は renderer）。
  - agent authority capability（main 発行、renderer 消費）。
  - chat IR S1 の確認済み脅威モデル（renderer の loop が前提）。
  - profile egress の gate（main が backend を直接呼ぶと素通り）。
  - 品質ゲートの registry と callsite 契約。
- GDX-PRECHECK-001 の `[precheck]` 対象（外部 egress、async lifecycle、security-sensitive）。編集前に threat model と owner／lifecycle matrix が要る。NIR-1 残レーンへの事前委任はこの作業に及ばない。
- ユーザー確認が要る委任外の論点が 3 つある。
  - `ee` ライセンスのコードが配布物に入ること。
  - memory による保存範囲の拡大。
  - 新しい IPC／authority。
- memory 設計の推奨は、実装前の確認事項として扱う。決定済みの「Mastra memory を使う」と食い違う部分は第 2 節に書く。

## 1. 影響マトリクス

調査で見つけた行番号の根拠は、各調査の evidence に従う。

| 層 | 今 | 移行後 | 変える物 | 試験 |
|---|---|---|---|---|
| renderer | `sendMessage`（`src/application/chat/chatTurnStoreActions.ts:238`、約 2,400 行）が準備と `runAgentLoop`（`src/features/chat/agent/agentLoop.ts:144`）を呼ぶ。tool 実行（`toolExecutors.ts`）、ask_user の保留、UI 操作、diff 提示、write 後処理（store 再読込、undo、timelapse、index 予約）もここ。非 stream の invoke。 | UI と対話だけ残す。loop と read／write tool 本体は main。ask_user、UI 操作 3 本、propose_scene_body の accept、設定提案、write 後処理、read-your-writes の flush は renderer 常駐で、main からの要求で動く。 | `sendMessage` の loop 部分、`toolExecutors.ts` の分割（DB 系を main へ、UI 系は残す）、main からの進捗・完了・質問イベントの購読、停止の順序（abort フラグを立ててから resolve、`chatTurnLifecycle.ts:489`）の再設計。呼び出し元は 4 つで、main chat、`run_research` 子 agent、Context Creator、live harness。 | 4 経路の整合、`agentLoop.test`、chat store 系、Stop／セッション切替の孤児化。ブラウザ側 `browser-mock.ts` が `send_agent_message` を実装しているので、残すか決める。 |
| preload・IPC | 一方向の event allowlist のみ（`electron/shared/ipcContract.ts:309-317`）。逆向き RPC は既存に見つかっていない（未確認）。`send_agent_message` は invoke で応答を丸ごと返す。 | 「agent turn の開始・停止」と「main→renderer の要求／応答」が要る。進捗 event の新 channel も要る。 | `ipcContract.ts`（正本）に新 command と channel を追加。renderer は `src/lib/` の wrapper 経由。main で引数を再検証。allowlist と profile gate への分類。 | contract の schema 試験、`allowsBackendEvent` の分類、`AI_TRANSPORT_COMMANDS` 走査（`aiPathRegistry.test.ts:98-110`）。 |
| main | Backend を持つ（`electron/main/backend.ts:46`）。AI 送信は renderer の invoke → `dispatchInvoke` の 1 経路だけ（`ipc.ts:2328-2345`）。key は main が注入（`resolveRequiredAiKeyAndSettings`、`ipcContract.ts:12165`）。main が DB を読む手段はある（`backend.dbExecute`）。 | Mastra の Agent と loop、tool 実行、監査、LanguageModel adapter が main に載る。 | 新しい main モジュール群。`resolveRequiredAiKeyAndSettings`、`requireNativeAiStreamCorrelation`、`requireNativeAiAuditContext`、`parseWire` は未 export なので export 化か再実装。main 内の loop は module 単位の状態（`toolTurnCache`、`chronicleToolCache`、UI 操作上限の計数）を turn 単位に分離する。tokenizer が main で動くかは未確認。 | main の lifecycle 試験（sender 破棄、window close、forceStop）。`electron/main/rendererIsolation.static.test.ts`。 |
| N-API | `send_agent_message`（非 stream、per-request の中止なし。`electron/native/grimodex-node/src/lib.rs:17110-17182`）、stream は text のみ（tool なし）。stream の入力は `(role, content)` の文字列組だけ（`lib.rs:5821`）。送信前に audit の begin 行が無いと拒否（`pin_native_ai_audit_workspace`、`lib.rs:6388`）。 | 変えない案が既存 contract の範囲。adapter は `doGenerate` を実装し、tool ありの `doStream` は応答をまとめて出す擬似 stream にする。本物の tool 付き stream は新設になる。 | 既存 contract のままなら無し。agent の abort 新設は、main 内の AbortSignal で結果を捨てるだけなら不要。通信ごと止めるなら N-API の変更になり、新しい契約扱い。 | 既存の `egress-closure.test.mjs`（8 つの legacy entry が restricted で `D2A_EGRESS_DENIED`）が保つ。 |
| Rust | `grimodex-ai`（`src-tauri/crates/grimodex-ai/src/lib.rs:2941-3073`）。`AgentRequest`／`ChatResponse`（blocks は text／tool_use／thinking＋signature）。cache segments、volatile tail、Hermes／native の tool protocol、web search、citations、cost。 | 変更なし（送信は Rust のまま）。 | 無し。ただし AI SDK の標準 usage／finishReason／toolCall に写せない欄は providerMetadata に載せる。載る範囲は未確認。 | adapter 側の写像試験。Rust 側の既存試験はそのまま。 |
| DB | chat 系 9 本（`chat_sessions`、`chat_messages`、`chat_message_prompts`、`chat_summaries` 等。`migrate.rs`、`src/db/schema.ts`）。SCHEMA_VERSION 46。chat_messages に NIR-1 のトリガーと FK（`nir1_generation_message_versions`、`nir1_chat_input_captures`）。ターン終了時に 1 回だけ永続化、tool 往復は保存しない。 | memory の置き方次第（第 2 節）。正本を chat_* に残すなら、DB への影響は小さい。 | Mastra の table を grimodex.db に置くなら、D2a の PROFILE_EGRESS_TABLES 台帳、schema-contract、backup／restore、Drizzle mirror。別ファイルなら backup／export／project 削除の対象追加。 | `schema_contract`、seed_schema_parity、D2a の schema 完全性。product journey が `chat_messages` を直接読む（`electron/scripts/product-journeys.mjs:2784-3193`）。 |
| 評価・品質 | `aiPathRegistry`（69 経路＋`browser_byok_web`）。`auditOwner: "renderer-agent"` の 4 経路は `chat_agent_main`、`agent_research_subagent`、`context_creator`、`agent_call_limit`。`aiPathRegistry.test.ts:296-336` が renderer の callsite を実ソースで検査。live 検証 `heavy-agent-tool-loop` は `runAgentLoop` を使う（`aiLiveHarness`）。凍結・Gold は loop に依存しない（参照 0 件）。 | registry と callsite 契約が main 側に移る。live 検証は Mastra の loop を通す形に書き直し。凍結・Gold と ir-chat-pilot（`mode=chat`、tool なし）は不変。 | 新しい `AiAuditOwner`、sourceRef、dispatchCall、`rendererOwners` 集合、GDX-ROUTE／AUDIT／TOOL／POLICY／PRECHECK の implementedBy、`impact-map.yaml` の glob（`impact-map.mjs:1395` は未規則の path で全 suite を要求）、product-journey catalog、`aiPathRegistry` 試験。偽 AI（`productJourneyAi.ts:157`）は backend を差し替えるので adapter が同じ backend を呼べば効くが、messages 内のマーカー文字列一致に依存。 | `verify:quality`（Node 22 で）。`aiPathRegistry.test`、`chatApi.audit.test`、`agentToolCall.live.test`（S1／S2／S3）、journey の 2 本（agent-stream-project／workspace-switch）。 |
| egress | renderer の `assertInvoke` は invoke handler からだけ（`ipc.ts:2291`、`:2528`）。`send_agent_message` は `DENIED_COMMANDS` の old-external-ai（`profileEgress.ts:283`）。Native も restricted で拒否（二重防御）。`rendererContainment` は Chromium の default session だけを塞ぐ。main の Node fetch は対象外（`mozkeyInstaller.ts` は実際に Node fetch で GitHub に接続）。 | main の loop が `backend` を直接呼ぶと `assertInvoke` を通らない。Native の拒否で最終的には閉じるが、main 側の参加者登録、反復ごとの再認可、新 channel の分類を新設する。 | `registerMainEgressParticipant`（`index.ts:575-589`）に loop を登録（quiesce 30 秒、forceStop）。`assertPlaintextPublication` 相当の反復ごとの再確認。callerIdentity の発行（sender なしの発行手段は今の仕組みに無い。未確認）。`aiStreamTerminals` 相当の終端。Mastra 側は `MASTRA_TELEMETRY_DISABLED`、`MASTRA_OFFLINE=true`、`MASTRA_DEV`／`MASTRA_AUTO_REFRESH_PROVIDERS` を未設定に固定。 | restricted 切替で in-flight の loop が止まる試験、egress の static 試験、`egress-closure`、main の外向き通信の許可リスト試験。 |

### 経路 70 件の扱い

- loop を通る（4）は、`chat_agent_main`、`agent_research_subagent`、`context_creator`、`agent_call_limit`。
- loop には入らないが準備側で呼ぶ経路がある。`summarization`、`semantic_reranker`、`fts_search`、`semantic_search`。準備を renderer に残すなら不変。
- それ以外は別経路で影響なし。単発 38、streaming 9、post-effect 10、cli 3、embedding 5 など。
- ただし memory が非 agent chat にも及ぶ場合は `chat_stream_non_agent` も動く。これは未決。

### request の bytes が変わりうる箇所（監査・cache に効く）

1. history：今は user／assistant 本文のみで `stripToolProtocol` 済み（`chatTurnStoreActions.ts:1028-1040`）。memory が過去の tool call／result を再現するかは未確認。
2. tool schema：manifest（`agent-tool-manifest.json`、build.rs と共有）をそのまま渡している。Mastra／zod を経由すると key 順序、nullable、description が変わりうる。tools は cache の先頭。
3. `sendAgentMessage` の引数は約 17 個（`systemCacheSegments`、`systemVolatileTail`、`webSearch`、`thinking`／`effort`、`resolvedToolProtocol`、`requestMaxOutputTokens` ほか）。AI SDK の呼び出しにそのまま乗らず、adapter が turn ごとの文脈を別経路で持つ必要がある。
4. 逐次実行：今は 1 件ずつ await（`agentLoop.ts:239-337`）。Mastra の既定が並列かは未確認。write→read の順序、undoId、UI 操作上限の計数が変わりうる。
5. 上限の意味：tool 回数は窓に応じ 25／16／12／10。トークン予算は tool 結果の `tokensUsed` 累積で窓の 30%（下限 2,000）。ask_user は別枠 8。限界では制御メッセージを user として 1 回挿入してもう 1 度だけ応答させる。Mastra の step 上限とは意味が違う。閾値の緩和・黙示変更は委任外なので、定数も挙動も同値に写す設計が要る。
6. tool 結果の整形：`Error:` 接頭辞、1 件が tokenBudget の 25% を超えたら切詰め。
7. thinking の signature：同じ turn 内で tool_use と一緒に戻している（Anthropic）。AI SDK の reasoning の providerMetadata を通して往復させる必要がある。
8. 要約：今は turn 先頭の `maybeRunSummarization` のみ。loop 内に compaction は無い。

## 2. Mastra memory の設計の論点とユーザーへの問い

### 現状（Grimodex 側の事実）

- 9 本の chat 系 table。FTS5 と意味検索（ローカル ONNX、`grimodex-semantic`）、export、独立 MCP、監査（`legacyEvidence`）、timelapse、取り込みがそれぞれ直接読む。
- NIR-1 が `chat_messages` にトリガーと FK を掛けている。`nir1_generation_message_versions`、`nir1_chat_input_captures`、v38〜v41 のトリガー、予約 session id `nir1-local-*`。
- `snippets.source_chat_message_id` などの provenance の FK 先でもある。
- 書込みは restricted profile では typed writer に閉じる。
- 履歴の独自機構（段階要約、`chatRecall`、pin、prompt snapshot）が Mastra の機能と重なる。
- source metadata（human／ai／unknown）は `chat_messages` ではなく `authorship_spans.source` にある。

### Mastra 側（文書と main ブランチの raw ソース。1.83.0 の dist では未確認）

- memory は message history、working memory、semantic recall、Observational Memory の 4 種で、storage が必須。
- table は `mastra_threads`、`mastra_messages`（role は user／assistant のみ、content は JSON）、`mastra_resources` ほか。
- `LibSQLStore` は local file で `journal_mode=WAL`、`busy_timeout`、`synchronous=NORMAL` を自動設定する。`disableInit=true`、`config.client` で挙動を変えられる。
- semantic recall はホスト型 embedder だと本文が外へ出る。FastEmbed のローカル版もある。
- Observational Memory は背景で LLM を呼ぶ。既定 model は `auto`（google/gemini-2.5-flash 等）。観測した message は context から外れる。
- `generateTitle` も LLM call を増やす。
- core は `@mastra/memory` に依存しない。memory は別パッケージで、依存・ライセンス・telemetry は未調査。

### 論点

1. **正本**：`chat_*` を残して Mastra memory は実行時の history 供給だけにする案が、既存契約（NIR-1、FK、journey、export、MCP、監査、timelapse）への影響が最小。
   - Mastra の table を正本にする案は影響が大きく、NIR-1 の capture／version 経路を通らなくなる。
   - 両方に書く案は二重保存になり、削除・再送・A/B 採用の整合が崩れる。
   - 決定済みの「Mastra の memory を使う（会話履歴の保存が変わる）」と矛盾しない範囲かをユーザーに確認する。
2. **保存範囲**：tool call／result、reasoning、attachments、working memory、observation log は、現行（content と metadata の `tool_calls`／`thinking_blocks` のみ）より保存範囲が広がる。AGENTS.md の委任外（保存範囲の拡大）。
3. **schema・置き場**：
   - 別ファイルなら干渉は避けられるが、backup／restore、workspace 移動、project 削除、export の対象に加える必要がある。
   - grimodex.db に置くなら D2a の台帳、Drizzle mirror、FK を張れない問題が出る。別 native ライブラリが同じ WAL ファイルへ writer として入ると、Rust 側の checkpoint／migration／authorizer の制御がずれる。
   - Rust N-API 経由の custom storage adapter という選択肢もある。抽象メソッドの一覧は文書から確認できなかった。
4. **role・形式の写像**：Grimodex は system を含む 3 role、`thinking_blocks`、`tool_calls`、tokens／duration、A/B 採用、挿入／抽出の記録を持つ。往復で欠落しない対応表が要る。
5. **既存履歴**：id を保つか、thread／resource の割当て規則（session id、project id）。resource を project にすると resource スコープの recall が project 内の全会話に効く。
6. **外向き通信**：embedder、Observational Memory、`generateTitle` の model と embedder は、Rust の adapter 経由か、ローカルに限るか。経路が増えると egress が増える。
7. **機能の重複**：段階要約、L5 予算、`chatRecall`、pin、prompt snapshot と Mastra の lastMessages／semantic recall／observational memory が二重になる。
8. **telemetry の範囲**：Mastra の traces は storage の domain の 1 つで、本文を含む span を保存しうる。止める範囲が export だけか保存かは未確認。
9. **スコープ**：memory は agent chat だけか。非 agent chat、cli、codex_app にも及ぶと plain chat の final-request packing の契約が動く。

### ユーザーに伺うべき問い（優先順）

- Q1 正本はどちらか。(A) `chat_*` が正本で Mastra は実行時の供給のみ、(B) Mastra が正本、(C) 併存。A なら既存契約はほぼそのまま。
- Q2 storage は grimodex.db の中か別ファイルか。別ファイルなら backup／export／project 削除に加えるか。
- Q3 working memory と Observational Memory を使うか。使うなら保存範囲の拡大と追加の LLM call を許可するか。
- Q4 semantic recall の embedder はローカル限定か。ホスト型は新しい送信先になる。
- Q5 既存履歴を移行するか。移行するなら thread／resource の割当てと戻し方。
- Q6 tool_use／tool_result の往復を保存するか（今は保存しない）。
- Q7 Mastra の observability（traces）の保存も止めるか。
- Q8 非 agent chat にも memory を及ぼすか。
- Q9 既存の段階要約（`chat_summaries`、`isSummarized`）は残すか、置き換えるか。

## 3. spike の手順

前提：専用の使い捨て枝で行う。`master` に直接 commit／push しない。本実装の設計判断や契約変更はここに含めない。spike の結果は decisions 文書と PR 本文に残す。作業ツリーに `node_modules` の複製を作ってから始める（install で止まる事例があるため）。spike で追加される依存は live 検証の隔離環境でだけ使う。

| 段 | 内容 | 合格条件 |
|---|---|---|
| S0 | 前提の確認 | Electron 43.8.3 が同梱する Node の版が `@mastra/core` の `engines`（`>=22.13.0`）を満たす（未確認）。`zod` の解決（`@mastra/core` は peer で `^3.25.0 \|\| ^4.0.0`、Grimodex は `ai` 経由の zod@4.6.7）を確かめる。 |
| S1 | `@mastra/core@1.83.0` を追加（pnpm、lockfile 固定）。`posthog-node` 他約 30 の推移依存と THIRD_PARTY_LICENSES への影響を記録 | install が通る。ライセンス一覧の差分が確認できる。`ee` ライセンス（下記）の扱いをユーザーに確認するまでは、配布物へ入れる build は作らない。 |
| S2 | CJS の main（`electron/scripts/build.mjs` は esbuild の platform=node／format=cjs で `dist-electron/main.cjs`）で `@mastra/core` を load | `require`／bundle で load でき、起動時に例外が出ない。`import.meta`、`createRequire`、provider-registry の `getPackageRoot` が bundle 後に壊れない。`dist` 構造に依存する書込みが無い。 |
| S3 | telemetry 0 の確認 | `MASTRA_TELEMETRY_DISABLED=1` を `@mastra/core` の import より前に設定。外向き通信を捕捉する環境（隔離 netns ではなく、env proxy は Chromium の辞書取得を止めないので Node 側の `http`／`https`／`fetch` と socket のフック）で、起動〜Agent 実行の間に宛先 0 件。`MASTRA_OFFLINE=true`、`MASTRA_DEV`／`MASTRA_AUTO_REFRESH_PROVIDERS` 未設定。LanguageModel を object で渡し、文字列 model id を使わない（`ModelRouterLanguageModel` を作らない）。license key 環境変数を設定しない。対の確認として `MASTRA_TELEMETRY_DISABLED` なしで通信が出る場合の宛先も記録する。 |
| S4 | Rust を包む LanguageModel adapter の最小形 | specificationVersion `v4`（`ai@7.0.112` の LanguageModelV4 と Mastra の provider-v7 が同じ v4 系）で `doGenerate` のみ実装。N-API の `sendAgentMessage` を 1 回呼び、text と tool_use と usage を AI SDK の型に写す。`doStream` は tool ありなら擬似 stream。fake backend で、Mastra Agent の 1 回の `generate` が成功する。thinking の signature、cache segments、citations の写像可否を記録する（未確認の項目を埋める）。 |
| S5 | tool 1 つを main で実行 | 読み取り専用 tool 1 本（例：Drizzle 非依存で `backend.dbExecute` から読める `get_app_help` 系ではなく、DB 読みの小さい tool）で、tool schema を manifest から生成し、Rust に渡る JSON が現行 `AgentToolDefinition` と同じか diff を取る。逐次実行になる設定を確かめる（並列か未確認）。tool 1 件ぶんの往復（tool_use→tool_result→最終応答）が main 内で閉じる。 |
| S6 | 比較・記録 | 同じ入力で、現行 renderer の loop と spike の request bytes（messages、tools、cache prefix）の差を並べ、第 1 節の 8 点のうち実測できたものを埋める。 |

### 合格にしない条件（その場で止めて報告）

- 通信が 0 件でない、または起動時に registry sync が走る。
- `ee` チャンクが配布物に入ることをユーザーが許可していない。
- Native の拒否（`D2A_EGRESS_DENIED`）に頼らないと restricted で閉じない。

## 4. 調査の間の食い違い・未確認

### 食い違い・注意

1. **`ee` ライセンス**：pkg 調査は、`@mastra/core` のルート import の静的木に `ee`（Mastra Enterprise Edition License）の共有チャンク（`dist/ee-iTj2bRDt-*.js`）が入ると報告した。実行されるのは定数 `MastraFGAPermissions` の参照だけで、FGA／license の処理は fga provider か license key があるときだけ。ee は Production Use に書面契約と key を要し、第三者への配布を禁じる（§3.2、§3.5）。他の 4 調査はこの点に触れていない。esbuild で main.cjs に bundle すると再配布物に入る。ユーザー判断が要る（入らない構成、Production Use に当たらない確認、Mastra への照会）。
2. **telemetry**：pkg 調査は実コードを読んで、PostHog 送信は file-based agent の登録（`trackFeatureUsage`）経路だけで、Agent の通常経路では出ず、`MASTRA_TELEMETRY_DISABLED`（1／true／yes）で止まるとした。eval 調査は「止め方は未確認」としていた。この点は pkg 調査で解決済みとみなす。ただし `posthog-node` は import 時に必ず読み込まれる。外部パッケージ（`@mastra/memory`、deployer、server）側の呼び出しは未確認。
3. **registry の自動取得の条件**：pkg 調査（tarball の実コード）は `MASTRA_DEV` が `true`／`1` または `MASTRA_AUTO_REFRESH_PROVIDERS=true`。eval 調査（上流の WebFetch の二次要約）は「`MASTRA_DEV` が true で `MASTRA_AUTO_REFRESH_PROVIDERS` が false でない場合」。内容は整合する。tarball 側を正とする。
4. **`workload-allocation.json`**：eval 調査は worktree に存在しないと報告し、私の確認でも見つからなかった。auto-memory には「product-journey-catalog.mjs を触ったら `workload-allocation.json` の digest も更新」とある。メインの checkout が古い（auto-memory の注意）ことと関係するか、別の場所にあるか。要確認。
5. **loop の所在**：依頼文や記憶にある `src/features/chat/store.ts` は AI 設定の store で loop ではない。正本は `chatTurnStoreActions.ts` と `agentLoop.ts`。
6. **memory 方針の推奨と決定の関係**：history 調査は「`chat_*` を正本に残す案」を推奨した。ユーザー決定は「Mastra の memory を使う（会話履歴の保存が変わる）」。A 案は後者と矛盾しないが、「保存が変わる」の範囲を超えるなら確認が要る。
7. **egress の境界**：loop 調査は、main が backend を直接呼ぶ既存の AI 送信の呼び出し元は今無いと述べ、eval 調査は main の直呼びは `assertInvoke` を通らないが Native の二重の防御が残るとした。両者は矛盾せず、設計上の穴は「main 側の gate が無い」ことで、Native の拒否で最終的には閉じる。

### 未確認（実測か上流の読みが要る）

- `@mastra/core` 1.83.0 の tool 実行が並列か、memory の既定が過去の tool call／result を再現するか、reasoning の signature が往復するか、`@mastra/memory` の依存・ライセンス・storage の要件、custom MemoryStorage の抽象メソッド。
- Mastra の messages の role に system が入るか（文書は user／assistant の記述のみ）。
- 文書と main ブランチの記述が 1.83.0 固定の dist と同じか（table 定義、LibSQLStore の PRAGMA）。
- AI SDK の LanguageModel V4 に signature つき thinking、cache segments、citations をどこまで載せられるか。`AISDKV7LanguageModel` が期待する stream part の形との適合。
- Electron 43.8.3 同梱の Node の版、bundle の大きさ、ESM-only 依存の CJS 化、native 依存の有無、zod の hoist。
- tokenizer（`countTokens`）が main で動くか。要約の閾値。Context Creator の `CREATOR_TOOLS` の中身。
- main→renderer の request／response 型の呼出しが既存にあるか（`events.ts` を見たかぎり一方向のみ）。
- sender なしの callerIdentity 発行（`profileEgress.issueCallerIdentity` の sender 依存）。
- agent の `stop_reason` の取り得る値（renderer 型は 3 値、Rust は String）。
- Responses API（sakana、openai）の thinking／signature の差（`ai_responses.rs:616-733` は未精読）。
- main の Node fetch が Chromium の proxy／host-resolver の対象外であることの実機確認（設計と静的試験からの読み）。
- dist 内の他の fetch の用途（画像 URL の取得など、model の外へ出る通信）は全経路を追えていない。
- ADR 008／roadmap の「2026-08-19 検証済み」のうち、`requiresUserConfirmation` が runtime で未参照である点以外（AI policy 既定 full など）は再検証していない。
- 評価 harness（CP-4、IR の測定）が `chat_messages` の本体を読むかは、fixture 以外で未確認。

### 設計上、ユーザー確認が要る追加の問い（第 2 節に加えて）

- capability（今は `senderId` 束縛、`ipc.ts:1557-`、`:1644-`）を維持・再設計・廃止のどれにするか。廃止は製品認可の削除で委任外。
- ask_user、propose_scene_body、設定提案、UI 操作 tool は renderer に残して main から RPC するか、loop を一旦終えて再開形にするか。
- 監査（begin／dispatched／complete）を main に移すか。Native は audit の begin 行が無いと送信を拒否する。
- agent 経路を stream にするか（abort の IPC が無い現状のまま非 stream にするか）。
- 文脈の組立（`refreshContextLayers`、`contextBuilder` 2,394 行）は renderer に残すか main へ移すか。
- 4 つの呼び出し元（Context Creator と live harness を含む）を同時に移すか。
- restricted profile で main の loop をどう扱うか（今と同じ拒否のまま、または `nir1_local_generation` の経路）。
- chat IR S1 の確認済み脅威モデルは renderer の loop 前提なので、再確認が要る。
- `requiresUserConfirmation`（destructive 2 本と `apply_ai_tree_plan`）を、移行中に実行時強制へ前倒しするか。現状は policy を通れば即時実行。
- browser runtime（`browser-mock.ts`）の loop を残すか。
- 並列 tool 実行を許すか。逐次維持は Mastra 側で設定できるか未確認。

## 5. 関連ファイル（調査対象、変更なし）

- `/home/grimodex/worktrees/Grimodex/model-caps/src/application/chat/chatTurnStoreActions.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/src/features/chat/agent/agentLoop.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/src/features/chat/agent/toolExecutors.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/src/features/ai-verification/aiPathRegistry.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/electron/main/ipc.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/electron/main/profileEgress.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/electron/shared/ipcContract.ts`
- `/home/grimodex/worktrees/Grimodex/model-caps/electron/scripts/build.mjs`
- `/home/grimodex/worktrees/Grimodex/model-caps/src-tauri/crates/grimodex-ai/src/lib.rs`
- `/home/grimodex/worktrees/Grimodex/model-caps/docs/plans/model-capability-discovery.md`


## 付録 A. 点検の結果（訂正と抜け）

統合文書の点検結果（すべて /home/grimodex/worktrees/Grimodex/model-caps で read-only の読みだけ。Mastra 側の外部主張は取得せず未確認）

## 誤り

- 基点の記述が古い。文書は「HEAD は 8f63ac8e、docs の commit が 1 件」とするが、実際の HEAD は 835c942e。`git log` では 8f63ac8e の上にさらに docs commit が 1 件ある（計 2 件）。01dd6821 は祖先で、差分は `docs/plans/model-capability-discovery.md` の +131 行だけ。コードは同じなので結論には影響しない。
- 行番号のずれが 1 件ある。`profileEgress.ts:283` は `send_chat_message` で、`send_agent_message` の行は `electron/main/profileEgress.ts:286`（`["send_agent_message", "old-external-ai"]`）。
- 引用先の path が不正確。`impact-map.mjs:1395` は `scripts/quality/impact-map.mjs:1395`（`Unclassified paths require all suites`）。`electron/scripts/` には無い。
- `mozkeyInstaller.ts` を「実際に Node fetch で GitHub に接続」とする記述は正確でない。`electron/main/mozkeyInstaller.ts:50,74-79` は注入可能な `fetchImpl`（FetchLike）を使う。host は許可リスト（:16-20）に限る。既定の fetch が何かは未確認。また `fetch(` の直接呼びが grep に出た main ファイルは `updater.ts` だった。main の Node 側通信の実例としては `updater.ts` も挙げるべき。
- `electron/main/` は Mastra 導入後の loop の置き場の隣に既存の AI 関連モジュール（`chatAgentIr.ts`、`nir1LocalGeneration.ts`、`aiStreamTerminals.ts`、`productJourneyAi.ts` ほか）を持つ。第 1 節は「新しい main モジュール群」とだけ書き、既存モジュールとの責務の重なり（特に `aiStreamTerminals` の終端追跡と、新しい agent 用の終端）を示していない。これは誤りというより具体性の不足。

## 抜け

- tool の棚卸しが無い。`agent-tool-manifest.json` は 44 本。うち write 系が多数ある（create_codex_entry、update_codex_entry、create_foreshadow、update_foreshadow、create_snippet、apply_ai_tree_plan、propose_scene_body、create_event／update_event／delete_event、stamp／unstamp_scene_event、set_event_participants、add／remove_event_relation）。文書は「DB 系を main へ」と書くだけで、どの tool が renderer 常駐になるかの一覧が無い。renderer に残るのは次の 6 本。
  - ask_user
  - run_app_command
  - apply_layout_preset
  - propose_setting_change
  - propose_scene_body
  - get_ui_state（`toolExecutors.ts:1774` は `appHelpTools` 経由で UI 状態を読む）
- 第 1 節の「UI 操作 3 本」は具体名が不明。manifest から見ると run_app_command、apply_layout_preset、get_ui_state のはずで、設定提案は別。
- 既存 tool executor が renderer 専用の資源に依存している点が移行の障害として明記されていない。`src/features/chat/agent/toolExecutors.ts` は次を import している。
  - `invoke` from `@/lib/tauri`
  - `db` from `@/db/client`（renderer の Drizzle）
  - `@/features/tree/api`
  - `@/features/semantic-search/api`
  - `countTokens` from `../contextBuilder`
  - `@/lib/prosemirror`
  - `@/features/codex/prosemirrorTextExtractor`
  main 側にはこれらが無く、文書は `backend.dbExecute` で読めると書くだけ。Drizzle クエリの main への移植か書き直し、semantic search（codex_semantic_search／events_semantic_search、:294、:324）の呼び出し経路、`@/` エイリアスと `rendererIsolation.static.test.ts` との関係が抜けている。
- build と packaging が不足している。
  - `electron/scripts/build.mjs:26` は `external: ["electron", "*.node"]`。`@mastra/core` が native addon（例：LibSQL 系）を引くと externalize され、`electron-builder.yml:23-24` の `asarUnpack` は `grimodex-node.node` だけを列挙するので、追加の native は同梱・unpack されない。
  - `packagingConfig.test.ts` が存在する。
  - 文書は「native 依存の有無」を未確認に挙げるが、このパッケージング側の帰結（asarUnpack、electron-builder の files、packagingConfig 試験）に触れていない。
- GDX-PRECHECK-001 の owner／lifecycle 表（`policies/quality/iron-laws.md:90-94`）の必須項目が文書に網羅されていない。要求は、全 entry／start／retry／reentrant、admission closure、pending-start、active handle ownership、cancellation、bounded wait、実際の終了証跡、error／timeout／onClosed の所有、永続 restart state。文書が触れていないのは次の点。
  - app 終了：`index.ts:760` の `will-quit` と quitFinalizer が Native の terminal receipt を待つ既存の栓。新しい loop をここに登録する記述が無い。第 1 節 egress 行の `registerMainEgressParticipant`（`index.ts:575-589`。cli-ai、codex-app-server、vivliostyle の 3 件）だけでは quit 栓の話が出ていない。
  - 再入：同じ session の二重 send、複数 window（`productJourneyMultiWindowAi.ts` が存在）。
  - pending-start：admission 閉鎖時に開始済みで未送信の loop。
  - renderer 喪失：main が renderer に出した ask_user／propose_scene_body の要求が保留中に window close／reload／crash した場合の ownership。第 1 節は sender 破棄に軽く触れるだけ。
  - 永続 restart state：main が落ちたとき途中の tool 書込み（undoId、timelapse、index 予約）と未確定 turn をどう扱うか。Mastra storage の途中状態も含む。
  - 終了証跡：「kill や reject は終了証跡でない」（:93-94）に沿う、loop／Mastra 内部 timer／LibSQL 接続の close 証跡。
- 保存先の抜け。write tool の後処理（store 再読込、undo、timelapse、index 予約）の永続先と、それが main へ移ったときの書き手の一覧がマトリクスに無い。undo 状態の保存先も未記述。
- 外向き通信の抜け。
  - `updater.ts`（main の Node 側通信）が許可リスト試験の対象かどうか。
  - `licenseValidation.ts` は Rust 経由の Polar 通信で別。ここは問題なし。
  - ただし Mastra が引く追加の fetch（画像 URL 取得など）の全経路は未追跡と文書自身が認めている。S3 の宛先 0 件確認は agent 実行区間だけなので、起動から終了までの全区間を測る必要がある。
- chat IR S1 の脅威モデルは `electron/main/chatAgentIr.ts` の `chat_agent_ir_select` が「全 launch で closed」で、renderer の loop が前提になっている。文書は再確認が要ると書くが、loop が main へ移ると「IR を agent に渡す one-shot」の受け手が main の loop 自身になる点（gate の位置関係）が未整理。
- `workload-allocation.json`：worktree に無いことを再確認した（`find` でもヒットせず）。文書の「要確認」のままでよいが、`electron/scripts/product-journey-catalog.mjs` と `product-journeys.mjs` は存在する。journey 触れた場合の digest 更新が要る旨は記憶側の規則で、どこに digest があるかは未確認のまま。
- zod：`package.json` に直接依存は無い（再確認）。文書どおり。

## 確かめて正しかったもの

- `package.json:173` の `"ai": "^7.0.112"`、electron 43.8.3（:237）。
- `chatTurnStoreActions.ts:238`（`sendMessage`）、`agentLoop.ts:144`（`runAgentLoop`）。
- `ipcContract.ts:309-317` は chat／cli／inline-ai の stream event だけの allowlist（一方向）。
- `ipc.ts:2328-2345` の `dispatchInvoke` と `issueAgentAuthorityCapabilities`、`:2291`／`:2528` の `assertInvoke`。
- `ipc.ts:1557`（`issueAgentAuthorityCapabilitiesForSender`）、`:1644`（`consumeAgentAuthorityCapability`）。
- `ipcContract.ts:12165` の `resolveRequiredAiKeyAndSettings`（関数宣言）。
- `backend.ts:46` の `getBackend`。
- `chatTurnLifecycle.ts:489` の `stopGeneration`。
- `agentLoop.ts` の定数：DEFAULT_MAX_TOOL_CALLS=10（:22）、ASK_USER 上限 8（:34）、TOOL_RESULT_TOKEN_CAP_RATIO=0.25（:28）、ask_user は別枠（:270）。逐次実行は :241。
- `modelLimits.ts:904` のトークン予算（窓の 30%、下限 2,000）、:925-926 の窓に応じた tool 回数（25／16 を確認。12／10 の行は未確認）。
- `chatTurnStoreActions.ts:1028-1040` の履歴は user／assistant のみで、assistant は `stripToolProtocol` 済み、system は skip。
- `lib.rs:17110` の `send_agent_message`、`:5821` の `ChatMsgDto`、`:6388` の `pin_native_ai_audit_workspace`（begin 行が無いと拒否）。
- `aiPathRegistry`：id は 70（`browser_byok_web` 含む。:1603）、`auditOwner: "renderer-agent"` は 4 件（:527、542、557、571）。`aiPathRegistry.test.ts:98-110`（AI_TRANSPORT_COMMANDS）と `:296-336` の rendererOwners 集合。
- `SCHEMA_VERSION = 46`（`grimodex-core/src/lib.rs:3`）。
- `index.ts:575-589` の `registerMainEgressParticipant` 3 件（cli-ai、codex-app-server、vivliostyle）。
- `build.mjs`：esbuild の platform=node、format=cjs、`dist-electron/main.cjs`、target=node22。
- `DENIED_COMMANDS` に `send_agent_message` が `old-external-ai` で入っている。
- `productJourneyAi.ts:157` は `sendAgentMessage(args)` で、`electron/main/` にある（`src/` ではない）。偽 AI が backend を差し替えるという記述と整合。
- `electron/main/rendererIsolation.static.test.ts` の存在。
- iron-laws の NIR-1 委任は NIR-1 の残レーン外に及ばない（`iron-laws.md:80`）。保存範囲の拡大・新しい送信先・新しい契約・authority が委任外（:76-79）。文書の前提と一致。

## 未確認のまま（取得・実行が禁止のため）

- `ee` ライセンスチャンク、`MASTRA_*` の環境変数、Mastra memory の table・既定、並列 tool 実行の既定など、`@mastra/core` 1.83.0 の実行時挙動と dist の内容。
- 窓に応じた tool 回数の 12／10 の境界値。
- `mozkeyInstaller.ts` の既定 fetch が何か。