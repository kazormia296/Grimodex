# MP-4（tool 基盤、loop 規則、read tool）の設計と判断の記録

- 状態：**起案（draft）・改訂 2**（2026-11-21 午後。ユーザーの回答 1〜3 と、Opus の独立レビュー〔precheck〕の指摘を反映。第 10 節）。第 8.1 節の「確認要」（Q4・Q5 と条件つき）が未了の間は、該当する PR の編集に入らない（第 7 節）。
  判断を変える場合は、その PR でこの文書を改訂する。
- 親の文書：[Mastra 移行の実装計画](mastra-migration-plan.md)の第 6 節 MP-4、第 7 節 U-4・U-7、第 9 節 R 表。
  [MP-3 の判断](mastra-mp3-decisions.md)（特に DR-MP3-3、24、27、28）、[脅威モデル](mastra-migration-threat-model.md)（T1〜T13、D1〜D16、W1〜W11。T13・D16・W11 は回答 3 で足した）。
- ID：`DR-MP4-n`。PR 本文にも同じ ID と信頼境界を載せる。確認の項目は `C-n`（計画書の `C-1`〔storage〕とは別）と、残る 2 つの確認 `Q4`・`Q5`、未確認の事実は `K-n`。
  改訂 2 で多くの `C-n` を技術判断や回答済みに移した。行き先は第 8.2 節。
- 区別：**決定**・**回答**（ユーザー、2026-11-21。第 1.3 節）、**技術判断**（この lane の判断）、**案**（実測で確定する。外れたら止める）、
  **確認要**（委任の外。ユーザーの回答まで決めない。第 8.1 節）。
- 委任の範囲：AGENTS.md の NIR-1 の事前委任は Mastra の lane に及ばない（[MP-3 の判断](mastra-mp3-decisions.md)の冒頭と同じ）。
  新しい送信先・保存範囲の拡大・閾値（新設を含む）の変更・新しい契約や authority は「確認要」とし、黙って決めない。
- 根拠の書き方：`†` を付けた file:line は、起案時・改訂 1・改訂 2 のいずれかの時にこの worktree（HEAD `8eeb1976`、枝 claude/mastra-mp4-design。コードは origin/master `414ef976` のまま）で開いて確かめた。
  無印は事前調査（Sonnet の調査と反証。誤りを含みうる）による**未再確認**。Mastra の挙動の根拠はすべて dist の読解か
  plain Node の probe で、adapter を通した実測ではない。
- 起案の制約：この文書は read-only の調査から書いた（改訂 1・2 も同じ）。build、試験、Electron、Xvfb は一切実行していない（実行前の未確認として扱う）。改訂 2 で実行したのは JS の `trim` を確かめる `node -e` の 1 行だけ（K-19）。

## 1. 目的と範囲

### 1.1 目的

MP-3 は tool 0・1 step の骨格だった。MP-4 は、main の loop が tool を持ち、legacy の loop 規則（回数・予算・切詰め・上限・abort）と
同値に動く土台を作る。tool は read 系から移す。旗 L は閉のまま。製品の挙動は変えない。

### 1.2 範囲の読み替え（DR-MP4-19 に続く）

- 計画書の MP-4（`mastra-migration-plan.md:357-363`）は manifest の 44 本を Mastra の tool にする。これを**段階**に読み替える。
  - MP-4：データ read（約 21 本）の核を共有 module に出し、main の tool にする。loop 規則を写す。
    main に載せるのは 20 本（M4）。`get_codex_entry` は MP-13 の前に C-6 で決める（残る 1 本）。
  - MP-5：`ask_user`、`get_ui_state`、help 2 本（RPC。DR-MP4-11）、manifest 上は write の UI 系 4 本
    （`run_app_command`、`apply_layout_preset`、`propose_setting_change`、`propose_scene_body`）。計 8 本。
  - MP-6：write 系のうち MP-5 の 4 本を除く 14 本（manifest の write 16 と destructive 2 の計 18 本から 4 本を引く）。
  - `run_research`：MP-4 では移さない（DR-MP4-22）。
  - 内訳の検算（`agent-tool-manifest.json` を集計した）：read 26、write 16、destructive 2 の計 44。
    44 ＝ M4 20 ＋ `get_codex_entry` 1 ＋ MP-5 の 8 ＋ MP-6 の 14 ＋ `run_research` 1。
- MP-4 の間、main の tool は 44 本そろわない。renderer は毎 turn 44 本を宣言する（snapshot。
  `chatTurnPreflight.ts:365-369`、`toolDefinitions.ts:945-947`）ので、**製品の agent-mode turn は 1 本も Mastra に送られない**。
  Mastra に届くのは journey の seam だけ。旗 L が閉のままであることと整合する。
  - 「残りを使う turn は legacy に落とす」は、turn 開始時に model がどの tool を呼ぶか分からないので、
    呼ぶ tool では判定できない。**宣言する tool 集合が main の集合に収まるか**で判定する（DR-MP4-19）。
  - この読み替え自体は決定 2 で承認済み。帰結（製品の turn が MP-4 の間 Mastra に届かない）は**報告のみ**（C-5。第 8.2 節）。

### 1.3 ユーザーの決定と回答（2026-11-21。確定）

| # | 決定 | この文書での扱い |
|---|---|---|
| 1 | turn 開始の wire に `projectId`・`currentSceneId`・`chatMessageId` の 3 欄を 1 回の契約変更で足す。main の検査は形式だけ（非空・turn 内の整合・`"default-project"` の拒否）。書き先は legacy と同じ project の chain（実在確認はしない。Codex app-server と同じ強さ） | DR-MP4-1、2、23。細部は回答 1 で確定 |
| 2 | U-7 は (D) 混合。データ read 約 21 本は核を共有 module に出し、main から既存の `backend.dbExecute` と既存の Native の typed 呼出しで同じ SQL を発行（新しい N-API なし）。`get_ui_state`・`ask_user` は MP-5 の RPC。help 2 本は設計で決める。MP-4 の間は main の tool が 44 本そろわない | DR-MP4-3〜11、19 |
| 3 | U-4(f) は DR-MP3-3 どおり IR を開ける lane へ延期。MP-4 でも chat IR は閉。main の tool に IR を呼ぶ executor が無いことを静的試験で固定する（`chatAgentIr.test.ts:162`†、`:193`† の拡張）。plan・threat-model の記載を揃える（文言は「IR を開ける lane まで閉〔MP-4 を含む〕」） | DR-MP4-21、第 9 節 |
| 回答 1 | `currentSceneId` は `string \| null`。空文字は null に写す。null は legacy どおり年表の secret を「隠す」側（`toolExecutors.ts:549-553`†、`chronicleSecrecy.ts:77`†）。`projectId`・`currentSceneId`・`chatMessageId` は start で 1 回束ね、turn 中は変えない。実在の照合はしない | DR-MP4-1。C-1 は解消 |
| 回答 2 | 4a は 3 欄だけで先に進める。4c の wire（tool の名前、予算と制御 message、窓・出力予約・fallback の system、結果と進捗、C-6 で必要なら `fullyInjectedIds`）は、設計がそろってから 1 回にまとめて別に伺う。契約変更は計 2 回（4a の 3 欄と 4c-1 の wire 一式） | 第 5 節、Q4 |
| 回答 3 | main の DB 直読みは JS の防御で行い、脅威モデルに追記する。防御：送信前の SELECT 検査、marker の事後検出、表の allowlist と IR 非参照の静的試験、read の前後の `assertLive`、caller の timeout（legacy と同じ既存の定数を共有 module に出す。`db_execute`・`fts_search` は 10 秒〔`src/lib/tauri.ts:19`†、`:238`†、`:362-389`†〕、semantic 2 本は 5 分〔`:268-270`†〕）、W の行。残るリスク：unrestricted では Native に read-only の強制が無い。脅威モデル（確定文書）に T13・D16・W11・残るリスクの行と改訂の記録を足した（**反映済み**） | DR-MP4-4、5、第 9.2 節。C-4 は解消 |

### 1.4 範囲外

write 系の tool、capability の発行（MP-6）、memory（MP-7 以降）、main→renderer の RPC（MP-5）、`run_research` の子 loop、
Context Creator、live harness、`browser-mock.ts`、packaged の検査（MP-13）。既存バグ `policyAllowsAgentTool` は #989 で修正済み（DR-MP4-4 の注記、2026-11-22 に確認）なので触らない。

## 2. 信頼境界

- **renderer が得る権限**：新しい IPC は無い（start・cancel は MP-3 の既存）。新しい契約は、**4a の start request の 3 欄（承認済み。回答 1）**と、
  **4c-1 の wire 一式（未承認。Q4）**の計 2 回だけ（回答 2）。
  3 欄は renderer の自己申告で、legacy と同じ強さ。main は形式だけを検査し、強めない。実在も確かめない。
- **新しい契約の候補（未承認。Q4 に一括）**：tools の wire の形（名前の list だけを推奨）、結果と進捗の wire、loop 規則の入力（予算・上限・制御 message 3 本・UI 言語）、
  step ごとの payload 確定の入力（窓・出力予約・fallback の system など）、C-6 で必要なら `fullyInjectedIds`。
  cancel の lane は新しい契約にせず、既存の契約の範囲で決めた（DR-MP4-27）。決めるのは 4c-1 の前。
- **main が新しい呼び手になる**：main が `backend.dbExecute` と Native の typed read（`ftsSearch`、`codexSemanticSearch`、
  `eventsSemanticSearch`、`foreshadowListOpenForContext`）を直接呼ぶ。
  - Native の `db_execute` は呼び手を区別せず、renderer 用の authorizer を掛ける（main 用の `SqlOrigin` は無い）。
    `electron/native/grimodex-node/src/lib.rs:10711-10741`†、`src-tauri/crates/grimodex-db/src/execute.rs:61-86`（未再確認）。read tool の SQL は今も同じ Drizzle のクエリなので、拒否される文の集合は変わらない。
  - JS 側の profile gate（`assertInvoke`、`classifyOwnDataRead`）は main の直呼びでは通らない（`profileEgress.ts:1244-1297`、未再確認）。
    profile は restricted のほかに `unavailable`・`activating` がある。owner は `profileClosed()`（3 状態。`mastraTurnOwner.ts:277-280`†）が真の間は turn を admit せず、
    admit 済みの turn も `assertLive` が閉じる（`:375-378`†）ので、**到達できるのは 3 状態のどれでもない（＝unrestricted）ときだけ**。この不変条件に頼り、JS gate は再現しない。
    read の開始の直前と await の後は `profileClosed()` 全体で再確認する（DR-MP4-5）。
  - unrestricted では Native に read-only の強制も workspace の pin も無い（semantic 系だけが `expectedWorkspacePath` で pin する）。
    補いは JS の adapter の**送信前の検査＋事後検出＋表の allowlist と静的試験＋read の前後の `assertLive`＋caller の timeout**（DR-MP4-4、5。回答 3）。
  - **「main が新しい呼び手になる」ことが新しい authority か**は、決定 2（(D) 混合）に含まれる。脅威モデルの文面は回答 3 で T13・D16・W11・残るリスクとして**反映済み**（第 9.2 節）。
    JS の防御で補う（Native に事前の強制は足さない）。残るリスクは「unrestricted では Native に read-only の強制が無い」こと。
- **送信先・保存範囲**：LLM 送信は引き続き Rust の `send_agent_message`。送信先は利用者が選んだ provider のまま。
  tool 結果が次の send に載る経路は legacy と同じ。保存範囲の拡大は無い。audit の行は legacy と同じ project の chain に入る（決定 1）。
- **秘匿の入力**：hidden Codex と年表 secret の判定は共有 core が持つ。入力（現在の場面、読む順、phase 解像度）は
  wire の `currentSceneId` と main が DB から再構築する値（DR-MP4-8）。形式検査だけの値がネタバレ防止の入力になる点は legacy と同じ強さで、main は強めない。
  **ただし、場面切替後と DB が古い窓では legacy より弱い**。ADR 013 は hidden と年表 secret を「どの経路でも渡さない」としている
  （`docs/adr/013-ai-disclosure-policy.md:9`†）ので、この弱まりは「同値の差の受容」ではなく保護の弱まりとして **Q5** に出す。
- **失効の観測**：main の `assertLive` は forced・user-stop・`profileClosed()`・sender 破棄・identity の 5 条件だけを見る（`mastraTurnOwner.ts:368-390`†）。
  legacy の `shouldAbortTurn` は workspace・project・chat authority に加えて **AI policy の chat トグルとライセンス**も見る（`chatTurnStoreActions.ts:490-498`†）。
  main は project の切替・chat authority の変化・policy・ライセンスを観測できない。複数 step の loop が main に移るので、
  作者が AI を切った後も次の step の send（provider への送信）が renderer の cancel の到達まで続きうる。
  条件ごとの守り方は **DR-MP4-26**（policy は send の直前に main が DB から読んで中断する防御を足す。技術判断）、残る窓の受容は **Q5**。
  この弱まりは legacy より弱い点として、Q5 の回答の後に脅威モデルへ書く（第 9.2 節）。
  なお「S1-B の T3（turn 開始固定）」は NIR-1 の脅威モデルの ID で、この lane の T3（restricted・非 agent chat での memory）とは別。

## 3. 影響マトリクス

### 3.1 層 × 変更

| 層 | 変更 | PR |
|---|---|---|
| renderer | engine 分岐（pure な判定関数＋start 呼出し）、3 欄の組立、default-project では start を呼ばない、gate-closed の記憶、scene write の flush（**Mastra の分岐に入ってからだけ**。DR-MP4-9）、authority の watcher と lease 通知での cancel（DR-MP4-26、29）、pending の start を 1 本に保つこと（DR-MP4-27）、audit export 用の registry への予約・完了（DR-MP4-31）。legacy の呼出し順は変えない | 4c-2（3 欄の型追従は 4a） |
| IPC・wire | `mastraAgentTurnWire.ts` に 3 欄（START_KEYS 7→10）。`tools`・結果・進捗・予算などの形は Q4 | 4a／4c-1 |
| main | owner の Turn に 3 欄を束ねる。sink の projectId・chatMessageId。read port、db adapter、IR を含まない tool の定義 module（DR-MP4-30）、IPC の timeout 定数の共有 module（DR-MP4-4）、rules module、tool の execute wrapper、**adapter の begin の前の注入点（DR-MP3-28 の境界の改訂。DR-MP4-28）**、send の直前の policy 判定（DR-MP4-26） | 4a／4b／4c-1 |
| N-API | **変更なし**（新しい command なし）。既存の `dbExecute` と typed read の run を再利用 | - |
| Rust | **変更なし**（ai_audit は scope 一致を既に照合する。`ai_audit.rs:1784-1797`、未再確認）。試験 fixture のみ：`mastra_wire_parity_tests.rs` に M4 の部分集合（DR-MP4-17） | 4c-1 |
| MCP | 変更なし。standalone MCP は別経路 | - |
| 試験 | wire・owner・gate・journey の fixture、特性試験（legacy と Mastra の両方）、read の fixture 比較、schema の無変形、IR の静的試験 | 全 PR |
| docs | 本文書、plan、threat-model、mp3-decisions の申し送り（第 9 節） | 4a から |
| build・配布物 | tokenizer の wasm と ranks を main に持たせる（配り方の 3 案は DR-MP4-18。技術判断。既存の budget を超えるときだけ C-8）。`main.cjs` か `mastra-agent.cjs`、または bundle の外の file。大きさの変化は未測定。`schema.ts` の移動の場合は品質ゲートの参照先（DR-MP4-3） | 4b（spike）／4c-1 |

### 3.2 経路ごとの行

列は [impact-matrix](../../.agents/skills/refactor-cross-boundaries/references/impact-matrix.md) の template に合わせ、
Owner／Boundary／Consumer は略記する。Status は `unknown` なら実装前に解消する。

| ID | Flow / variant | Owner | Boundary・検証 | Consumer | 保つ不変条件 | Fallback | 検証 | Status |
|---|---|---|---|---|---|---|---|---|
| P1 | start：3 欄が valid、admitted | owner | parser（形式）＋事前検査（default-project） | sink、runtime | 3 欄は start で 1 回束ね turn 中に変えない | - | wire／owner／gate test、journey | planned |
| P2 | start：refused（invalid／unsupported／gate-closed／busy／restricted） | renderer 分岐、owner | typed refusal | legacy | 準備の例外は legacy へ。admit 後の失敗は再送しない | legacy | 分岐の pure 関数 test | planned |
| P3 | main の `dbExecute` read（own-data） | read port | 送信前の検査（SELECT・method・params）、marker 'read' 確認、object の行、throw で fail-closed、`profileClosed()` の 3 状態、caller の timeout（既存の定数。DR-MP4-4） | core | unrestricted だけで動く。SELECT だけ | turn を失敗にする | adapter 単体（Native を呼ばない spy）、実 addon の fixture 比較 | planned（K-6 は unknown） |
| P4 | main の typed read 4 本 | read port | 4 本は名前固定の method（literal key の `NAPI_COMMANDS`。cmd を引数に取らない）、semantic は identity の workspace を pin | core | pin 無しの 2 本は assertLive の前後検査で補う | 同上 | adapter 単体、静的試験、pipeline spec | planned |
| P5 | hidden Codex・年表 secret の入力 | core | `currentSceneId`（project の場面集合に無ければ null と同じ扱い。年表は secret を隠す・Codex は base）、nodes（`project_id` で絞る・archived 除外）、`projects.phase_resolution_mode` を DB から | tool 結果 | fail-closed（不明は隠す）。core の projectId は必須 | - | fixture 比較（解除・secret・XPROJ・他 project の場面・archived） | unknown（K-4、K-5） |
| P6 | 場面本文 read（`get_scene`、`get_thread_scenes`） | core | barrier 無し。start 前の renderer の flush（Mastra の分岐だけ） | tool 結果 | DB に着いた内容だけを読む | - | 特性試験に差を明記 | planned（Q5） |
| P7 | tokenizer の初期化と count | tokenizer port | exact（o200k）。失敗は fail-closed。init は single-flight で、admission の登録の前に await し、その後に `admissionRefusal` を再実行 | rules module | 数え値は legacy と同じ。登録までに await を挟まない | init 失敗は turn を始めない／legacy | 数え値の一致 test、並行 start の test | unknown（K-7） |
| P8 | loop：回数・予算・切詰め | rules module | tool_use を legacy と同じ条件で数える（DR-MP4-12）。25% 切詰め | send、wire | agentLoop.ts の規則 1〜5 と同値 | - | 特性試験（両 engine） | planned（案。DR-MP4-12） |
| P9 | loop：上限到達と制御 message | rules module | 優先順 questions>calls>tokens。上限後に 1 回だけ応答を許す。制御 message は begin の前に入れる（DR-MP4-28） | send | agentLoop.ts:246-249†、:386-406† | - | 特性試験。request.prepared と wire の bytes 一致 | unknown（K-1、K-2）。4c-1 の最初の特性試験の完了が実装の前提 |
| P10 | abort・forced・authority 喪失 | owner、wrapper | execute の先頭と**実行後**の検査、no-op 結果（固定文字列。DR-MP4-14） | 次の send（begin の前の `assertLive`） | 次の LLM 呼出しを止める。実行後に外れたら tokensUsed と record を数えない | - | lifecycle 試験 | unknown（K-3）。4c-1 の最初の特性試験の完了が実装の前提 |
| P11 | 未宣言 tool | wrapper | 宣言集合の外は拒否（throw。error-text の経路。`Error: Tool not available this turn: <name>`、`isError: true`） | send | tool_result を欠落させない | - | 特性試験 | planned（DR-MP4-15。技術判断） |
| P12 | tool schema の送出と入力検証 | adapter、wrapper | 原本の bytes、検証なし・無変形 | Rust、execute | legacy は検証しない | - | schema bytes、無変形 test | planned |
| P13 | audit の chain（project、chatMessageId、parent） | sink | projectId を 1 か所で与える | Native の precondition | scope 一致が構造的に保たれる | - | sink／pipeline spec | planned |
| P14 | 結果と進捗の運搬 | wire | 確認要（Q4） | renderer | `stoppedReason` で「続行」を出す | legacy | 確認後に決める | unknown（Q4）。4c-1 の wire の前提 |
| P15 | engine 分岐 | renderer | 宣言集合 ⊆ main 集合 | owner／legacy | gate-closed は process の間 1 回だけ。`blockIfPolicyOff("chat")` の後ろに分岐が残る | legacy | 分岐 test、閉の特性 test | planned |
| P16 | chat IR | - | main に IR の executor・説明文・IR 定数の分岐が無い | - | IR は閉のまま | - | 静的試験（DR-MP4-21） | planned |
| P17 | `run_research` と子 loop、Context Creator | - | out of scope: DR-MP3-3 | - | - | legacy | - | out of scope: 移さない |
| P18 | write・UI tool | - | out of scope: MP-5、MP-6 | - | - | legacy | - | out of scope: 後続 MP |
| P19 | hermes、添付、public RAG、browser-mock | renderer 分岐 | 当面 legacy | legacy | 挙動を変えない | legacy | 分岐 test | planned（K-9） |
| P20 | step ごとの payload 確定（窓超過の throw、cache の降格）と send ごとの renderer の副作用 | begin の前の注入点（DR-MP4-28）、renderer | 変形と拒否は begin の前。形は Q4（DR-MP4-25） | Rust、renderer | legacy と同値か、受容した差の明記。request.prepared と wire が bytes 一致 | - | 特性試験 | unknown（Q4、K-18） |
| P21 | authority の失効の観測（workspace・project・chat authority・policy・license） | owner、renderer の watcher | DR-MP4-26 の表 | send、tool | 守れない条件は Q5 に載せた窓だけ | cancel | watcher の購読 test、lifecycle 試験 | unknown（Q5、K-17） |
| P22 | cancel の lane、audit export 中の cancel | renderer wrapper、owner | pending の start を 1 本に保つ。export は registry で断る（DR-MP4-27、31）。slot 待ちの残余は K-24 | renderer | Stop が効く | - | lane の test | unknown（K-20、K-22、K-24） |
| P23 | provider 別（anthropic／openai／openrouter、custom endpoint）の tool_use の数え方と usage 合計 | 応答の観測 tap | adapter が provider ごとに `stopReason`・usage を写す。legacy と同じ式で合計 | rules module | provider によって回数・usage が変わらない | - | provider 別の特性試験 | unknown（R-21 と同種） |
| P24 | null・空文字・未指定の意味（`currentSceneId`、`chatSessionId`、tool 入力の null） | parser、core | `currentSceneId` の空文字は null に写す（回答 1）。tool 入力は無変形（DR-MP4-17） | core | null と空を区別しない箇所を作らない | - | wire test、無変形 test | planned |
| P25 | turn 中の設定変更と snapshot 境界（窓、custom context、動的 model 能力、UI 言語） | renderer | turn 開始の snapshot を wire で運ぶ（Q4）。turn 中の変更は反映しない | rules module | legacy も turn 開始に捕捉する値と同じ時点（未再確認） | - | 特性試験に差を明記 | unknown（Q4） |
| P26 | audit chain の永続形式（project chain と workspace chain の旧行の共存） | sink | MP-3 の行は workspace chain、MP-4 の行は project chain。移行はしない | Native | 旧行を書き換えない | - | pipeline spec | planned |
| P27 | main thread の占有（tool の整形・数え、init） | read port、tokenizer | DR-MP4-18 の測定。対策が閾値の新設なら C-16（条件つき） | main 全体 | 他 window の IPC と終了処理を塞がない | - | 4b の spike の測定 | unknown（K-16） |
| P28 | tool の定義の出所と、renderer の snapshot との一致（tools の wire が名前だけのとき） | main の定義 module | IR を含まない共有 module から取る。`toolDefinitions.ts` は main から import しない（DR-MP4-30） | Rust、model | main の定義と renderer の snapshot が bytes で一致（M4 の部分） | - | drift 試験、静的試験 | planned（K-23） |
| P29 | workspace 切替・quiesce と turn（renderer の drain と main の forced の順） | renderer の watcher、owner | lease の通知で cancel（既存の契約）。(b)(c) は不変条件の変更なので C-17（DR-MP4-29） | owner | 切替が turn の終わりまで待たされない（高々 1 send） | forced（main） | lifecycle 試験 | unknown（K-22、K-24） |
| P30 | audit export と Mastra の turn（registry への登録） | renderer（engine 分岐） | start の間 registry に予約・完了を登録（DR-MP4-31） | export boundary | export は AI の実行中なら断る | - | registry の test | planned |

**unknown 行と PR の対応**（実装の前に解消する）：4b は P5（K-4、K-5）、P3（K-6）。**P27（K-16）・P28（K-23）は 2026-11-21 に 4c-1 へ持ち越した**（第 5 節「4b の PR 計画」の 4）。4c-1 は P7（K-7）、P9・P10（K-1〜K-3）、P14・P20・P25（Q4）、P23。4c-2 は P21（Q5、K-17）、P29（K-22）。

### 3.3 lifecycle note（非同期の行）

GDX-PRECHECK-001 の項目（entry、admission closure、pending-start、handle の所有、cancellation、有限の待ち、終了の証跡、error／timeout／onClosed の所有、永続の再起動状態）を、行ごとに書く。

- **P1、P2（start）**：entry は start と cancel の 2 本（MP-3 の既存）。admission closure は gate、quit、profile closed、sender、
  switchDepth、busy、上限（`mastraTurnOwner.ts:551-583`†）。3 欄の検査は admission の前（parser）と事前検査（unsupported）に置き、admission の順は変えない。
  pending-start は MP-3 と同じ。新しい待ち時間は作らない。
- **P3、P4（read の in-flight）**：owner は Turn。read は開始の直前に `profileClosed()`（3 状態）を含む `assertLive` を同期で通し、await の後に `forcedCause` と `assertLive` を再確認して、
  外れたら結果を捨てる。in-flight は send と別の counter で数え、slot の解放と quiesce の待ちに含める（現状は send だけ。`nativeInFlight`）。
  cancel は N-API 呼出しを止められないので、結果を捨てて settle を待つ。待ちは既存の有界の待ちに乗せる：workspace 切替（forced）は `MASTRA_TURN_FORCED_BOUND_MS`＝30,000、
  quit は `MASTRA_TURN_QUIT_BOUND_MS`＝5,000（暫定。`mastraTurnOwner.ts:68-71`†）。caller の timeout は DR-MP4-4（既存の定数）。脅威モデルの W11 に同じ記載がある。
  **これらに乗らない部分は新しい閾値になるので、そのときは C-16（または C-18）で確認**する。終了の証跡は呼出しの返り（settle）で、**slot の計数だけに使い、永続化の終了証跡ではない**（D11 の「`settled()` は証跡にしない」と区別）。
  read は何も永続しないので persisted restart state は無い。error／timeout／onClosed の所有は owner（結果の破棄と turn の abort への合流）。
- **P7（tokenizer の init）**：init の promise は **turn の所有物ではない**（process で 1 本の single-flight）。失敗は保持せず次の呼出しが再試行するが、並行の start は同じ in-flight の promise を共有するので、再試行は 1 回の init に束ねられる（回数は start の回数以下で、ループは無い）。
  init は event loop を塞ぐ（plain Node で約 163 ms。Electron main は未測定）。
  **順序**：`admissionRefusal`（`:551-583`†）の直後に turn を attached／bySession／slots へ同期で登録する構造（`:637-642`† のコメント「From here to the first await nothing else runs」）を壊さない。
  (1) 同期で gate-closed を確かめる（閉なら init を走らせない）、(2) init を await、(3) **await の後に `admissionRefusal` を再実行**、(4) 通れば同期で登録。
  init 中の start は未登録なので slot にも quiesce にも数えられない（待ちを増やさない）。quit・切替が init 中に起きても、(3) で refusal になる。
  失敗は既存の refusal（`unsupported`）で返して legacy に落とす。新しい code は作らない。
  (3) に置けない場合は、登録後の await の中（`:645-679`† の loadRuntime と同じ位置）で行い、失敗は turn の失敗とし legacy へは落とさない（DR-MP4-19 の「admit 後は再送しない」と矛盾させない）。
- **P8、P11（loop の規則・未宣言 tool）**：wrapper と side table（`toolCallId` → name・params・summary・tokensUsed）と turn ごとの cache の寿命は turn。
  破棄は turn の終端、forced、quit のいずれでも owner の turn の終了処理で行う（turn の外に残さない）。
- **P9、P10（loop の終わり方）**：上限到達の後の「最後の 1 応答」と forced の合流先を、特性試験で固定する。**この特性試験の完了を 4c-1 の実装の前提とする**。
- **P14（進捗・結果の運搬）**：進捗は一方向の event で、renderer の喪失時の所有・終了証跡は MP-3 の cancel と同じ。形は Q4 の回答まで未定。
- **P20〜P22**：send ごとの確定は begin の前の注入点の同期の区間で行い、新しい待ちを作らない（形は Q4 の回答後。DR-MP4-28）。watcher の購読は turn の終端で解除する（renderer の leak を作らない）。cancel の lane は DR-MP4-27。
- **P29、P30**：workspace 切替・quiesce と turn の owner の表は DR-MP4-29、audit export の registry は DR-MP4-31。

## 4. 技術判断

### DR-MP4-1 wire の 3 欄と検査（決定・回答 1＋技術判断）

- 決定（2026-11-21）：`projectId`・`currentSceneId`・`chatMessageId` を start request に足す。START_KEYS を 7 から 10 にする。
- 回答 1（2026-11-21 午後）：`currentSceneId` は `string | null`。空文字は null に写す。3 欄は start で 1 回束ね、turn 中は変えない。実在の照合はしない。
- 検査（形式だけ）：
  - `projectId`、`chatMessageId`：非空・trim 済み・200 字以下（既存の `isTrimmedId`。`mastraAgentTurnWire.ts:338-345`†。上限は既存の `MASTRA_AGENT_TURN_ID_UTF16_MAX`＝200†（`:83`）の再利用で新設ではない）。
    Native の要件（非空・前後空白なし。`ai_audit.rs:767-777`†）に対して**同等以上**にする。JS と Rust の `trim` の空白集合は違う（K-19）。
    技術判断：`isTrimmedId` に加えて、**先頭か末尾が Rust の `char::is_whitespace`（Unicode の White_Space。U+0009〜000D、0020、0085、00A0、1680、2000〜200A、2028、2029、202F、205F、3000）に当たる値を invalid にする**。
    Native の判定に合わせる形式検査で、`projectId` については新しい拒否条件ではなく「どうせ Native が audit の begin で拒否する値」を admit の前に落とすだけ（確かめたのは `ai_audit_scope_id` だけ。**`chatMessageId` 側の Native の検査は未確認**で、そちらは新しい拒否になりうる）。実装（4a、`claude/mastra-mp4a-wire` e58a3153）は、値のどこにあっても C0・C1（U+0085 を含む）・U+2028・U+2029・U+FEFF を拒否する。JS と Rust の trim の差（U+0085、U+FEFF）を両方含み、実在の id（UUID）には現れない文字だけを落とす形式検査で、決定 1 の「形式だけ」の範囲の技術判断とする。
    実 addon に通して Native の判定と一致することを 4a の試験で固定する。実在は確かめない。
    `project:<任意の id>` の audit chain が turn ごとに作られうるが、legacy と同じ強さ（決定 1）。
  - `currentSceneId`：`string | null`（回答 1）。非 null なら `isTrimmedId`（空文字は parser が invalid にするので、renderer が null に写してから送る）。legacy は場面なしを許し、`ChatTurnToolScope` も null を許す
    （`chatTurnToolScope.ts:19-23`†）。
    出所：legacy の tool は tree store の `activeSceneId` を live で読み、preflight は chat store の `activeSceneId`（string。空文字がありうる。`chatTurnPreflight.ts:123`）を捕捉する。
    `effectiveSceneId` は `chatScope` が scene 以外で null になる（`:372-374`†）ので、tool が読む値とは別。wire に載せるのは前者（`activeSceneId`。空文字は null に写す）。
  - 新しい issue code は固定文字列で、値を echo しない。禁止 key には足さない。
- 「turn 内の整合」の定義（回答 1 で確定）：3 欄は start で 1 回束ね、sink・tool scope・send args が**同じ値**を使い、turn 中に変えない。
  chatSessionId や messages との照合は含めない。
- **null（場面なし）の意味は、年表と Codex で違う。試験で固定する**：
  - 年表：`chronicleSceneId` が `scope.currentSceneId ?? ""` に写し（`toolExecutors.ts:549-553`†）、`isEventHiddenFromAi` は `!currentSceneId` で secret を隠す（`chronicleSecrecy.ts:77`†）。**secret は隠す側**。
  - Codex：`sceneId` が空・未指定なら `{kind: 'base'}` で解決する（`src/features/codex/context/codexHiddenFromAi.ts:62-63`†、`:109-112`†）。**base で hidden の項目は隠れたまま、phase による解除は掛からない**。
  - `ChatTurnToolScope` のコメント（`chatTurnToolScope.ts:21`†）は「null なら position filter は適用されない」と書くが、年表の実装は上のとおり secret を隠すので**食い違う**。実装の側を試験で固定し、コメントは 4b で直す。
  - 「hidden 側」とひとまとめに書かない（年表は隠す、Codex は base の判定）。project に無い場面 id の Codex 側の解決は未確認（K-20）。
- `"default-project"` の拒否は二層。(a) renderer は `turnProjectId === FALLBACK_PROJECT_ID` なら start を呼ばず legacy。
  (b) main は owner の事前検査（既存の `unsupported` の列）で拒否する。wire file は import を持てない
  （`mastraAgentTurnWire.ts:1-20`、未再確認）ので、owner に literal を置き、`currentProjectAuthority.ts` の値との一致を test で固定する
  （前例：`mastraAgentTurnWire.test.ts:120-128`、未再確認）。parser は形式だけなので invalid、default-project は unsupported。
- 現状：start request は exact 7 key†（`mastraAgentTurnWire.ts:175-196`）で、3 欄はどちらの key 集合にも無い。
- 代案：(i) parser で default-project を invalid にする：wire に literal の複製が要り、「形式だけ」の検査の範囲を超える。退けた。
  (ii) 実在確認：Codex app-server と同じ強さにする決定に反する（回答 1 も実在の照合はしない）。

### DR-MP4-2 owner と sink（技術判断）

- Turn（`mastraTurnOwner.ts:207-232`、未再確認）に 3 欄を `readonly` で束ねる。
- `createMainAgentAuditSink` の `projectId` を `request.projectId` にし、コメント「The wire carries no project」を直す。
  現状は `projectId: null`（workspace chain）†（`mastraTurnOwner.ts:611-617`）。決定 1 で書き先は legacy と同じ project の chain になる。
- Native の scope は `projectId` を 1 か所で与えれば、begin の行と send の `auditContext` の両方に同じ値が使われ、構造的に一致する
  （`agentAuditSink.ts:233-247`、`:292-324`、`agentLanguageModel.ts:450-460`、いずれも未再確認）。追加の cross-check は要らない。
- 4a の範囲では tool 0・1 step のままなので、`parentExecutionId` は null のまま。複数 step（4c-1）では前 step の `executionId` を連鎖させる
  （legacy の `chatTurnStoreActions.ts:1276`、`:1299`。未再確認）。DR-MP3-23 の「parent は null（tool 0）」の改訂は 4c-1（第 9 節）。
- `operationId`：legacy は renderer の turn UUID（＝wire の `turnId`）。sink は自前の UUID。揃えるかは K-8（usage 台帳が鍵にするか未確認）。4c-1 までに決める。
- 現在の `assertLive`† は forced・user-stop・`profileClosed()`・sender 破棄・identity の 5 つだけで、project の失効や policy・license は観測できない。3 欄を足しても増やせない（DR-MP4-26）。
- 代案：workspace chain（`projectId: null`）のまま書く。決定 1（書き先は legacy と同じ project の chain）に反するので退けた。

### DR-MP4-3 共有 core の置き場と ports（技術判断。置き場は案）

- 核：`toolExecutors.ts` の read 部分と `chronicleReadTools.ts` を、**ports を注入する pure な core** に分ける。renderer 版は今の配線、main 版は backend の adapter。
- **core には IR 無しの形だけを置く**。抽出元には `CHAT_AGENT_IR_ENABLED` の分岐が残る（`toolExecutors.ts:55,447,527,668`†。特に `chronicleCandidates` の位置 filter `:447` は scope の有無に関係なく定数だけで掛かる）。
  core がこの定数や `chatAgentIrAvailability`・`chatIrToolResult`・`@/lib/chatIr` を import したまま main に入ると、IR を開ける lane で定数が変わったとき main の結果が黙って変わる。
  core はこれらを import しない（静的試験。DR-MP4-21）。renderer 版（legacy）の IR 分岐は renderer 側の薄い層に残す。
- ports（案）：
  - `db`（sqlite-proxy の adapter。DR-MP4-4）、
  - 現在の場面・project・nodes の読み、phase の読み、本文の読み（barrier の有無は port で分ける）、
  - Native の読み 4 本（`fts`、`codexSemantic`、`eventsSemantic`、`foreshadowOpen`）、
  - `countTokens`、`logger`（`debugLog` は zustand store に依存するので、main では注入する）、UI 言語。
  - cache は port で受ける（DR-MP4-16。turn ごとの instance）。legacy の renderer は module singleton のまま（run_research の子 loop が `runAgentLoop` の毎バッチの reset を通るため。変えない）。
    **〔DR-MP4-37 で改訂〕** cache の port（`CoreToolCache`・`CoreReadPorts.cache`）は削除し、core は年表データの loader port を受ける（cache は実装の裏）。「Context Creator がその reset に依存する」は誤りで、Context Creator の tool は codex 3 本と snippets 1 本で年表の cache を読まない（依存は共通の `runAgentLoop` の毎バッチの reset だけ）。
  - **core の `projectId` は必須**（空なら throw）。`resolveCodexForAi` は projectId が falsy だと project 条件を落とす（`codexHiddenFromAi.ts:84-92`†）ので、port 化で optional のまま残さない（XPROJ）。
- 置き場の候補：
  - **A（第一候補）**：`electron/shared/` に core を置く。条件は import が `./x.js` か外部 package だけで、DOM・Node 固有の API を使わず、
    NodeNext（`electron/tsconfig.json`。lib は ES2023、module は NodeNext†）と bundler の両方で compile できること。src が electron/shared を import する前例は 38 file
    （`toolDefinitions.ts:3-8` ほか）。Drizzle の table 定義が要るので `src/db/schema.ts`（4,425 行）を `electron/shared` 側へ移し、
    `src/db/schema.ts` は re-export にする案。依存は `nowInstantString`（`@/lib/time`。`schema.ts:13`†）だけと読んだが、閉包は未確認（K-10）。
    **品質ゲートが壊れる**：`validate-narrative-writers.mjs:216-228`† は `src/db/schema.ts` の本文を読み、正規表現 `sqliteTable("narrative_…")` で未登録の authority 表を検出する。
    re-export にすると正規表現が何にも一致せず、`existsSync` は通るため、**検出が黙って空になる**。`evals/impact-map.yaml:771`†、`evals/quality-manifest.yaml:1608,1657`† の path trigger も実体が移ると外れる。
    A を採るなら同じ PR で走査対象と path を新しい実体に更新し、移動後も未登録の narrative 表を検出できる負の試験を足す。
  - **A′**：`schema.ts` は src に置いたまま、main が必要な表（read が使う 18＋2 本の表）の定義だけを持つ。二重定義で drift の危険があるので、列の一致を試験で固定する。
  - **A″**：core を 4 つ目の lazy bundle（esbuild の entry の追加）にする。配布物の構成が変わる（既存の budget を超えるときだけ C-8）。
  - B：esbuild に `@/` の alias を足し、src の module を直接 bundle。慣習（electron は src を import しない。`externalMountFs.ts:51`、未再確認）を破り、renderer の store・i18n が閉包に混ざる危険がある。
    esbuild は file ごとに最寄りの tsconfig の paths を使うので、alias の前提の確認も要る。**第一候補ではないが、閉包が大きい場合は比較表で再評価する**。
  - C：main 用に SQL を手書きで再実装。**退ける**。legacy との同値の証明が重く、SQL が二重になる。
- **閉包の見積り**（指摘による。未再確認。read 側 4 file の `@/` import は write 側を除いても約 20 module で、各 module がさらに store や invoke を引く）：
  `chronicle/{chronicleSecrecy,chronicleSnapshot,chronicleTime,resolveSceneAnchor,chronicleReadingPosition}`、
  `codex/{codexHiddenFromAi,phaseResolver,prosemirrorTextExtractor,api}`、`tree/{api,fractionalIndex,treeStore}`、
  `lib/{prosemirror,fts,i18n,debugLog,tauri}`、`semantic-search/api`、`foreshadow/api`。
  `electron/shared` に置く module は `@/` を使えず、NodeNext の `.js` 拡張子規則を満たし、DOM なしの lib で compile できる必要がある。移動量が大きい場合は A″ か B を再評価する。
  4b の最初に import closure を実測して表にし（移す module、分割が要る module、store 依存を port に出す箇所）、置き場を確定する（実測は build が要る。この起案と改訂では未実行）。
- `chronicle/api.ts`、`src/features/codex/phaseApi.ts`、`src/features/codex/detailApi.ts`† は read と write が同居する（store や timelapse を import する）ので、
  read 専用の module に分けてから core が import する。
- A が成り立たなければ、決定 2 の (D) の範囲で置き場だけを見直し、改訂をこの文書に残す。
- **改訂（2026-11-21）：置き場は A に確定**（技術判断。根拠は K-10 の実測。第 5 節「4b の PR 計画」の 1。分割後の pure の下限は 143 module・454 KB、A′ は 23 表、B は electron の NodeNext の tsc で落ちる）。A″（載せ方）は 4c で coldStartMs を測って判断する。
- 既存の `toolExecutors.test.ts` は `@/db/client` と `invoke` を mock している。core 化の後も legacy の結果が変わらないことを、この試験で固定してから進める。
- tool の**定義**（name・description・schema）の出所は core とは別に、IR を含まない共有 module に分ける（DR-MP4-30）。

### DR-MP4-3 追補（MP-4b PR-3b-1 の実装で決めたこと。技術判断。2026-11-22）

`src/db/schema.ts`・`src/lib/time.ts`・`src/lib/temporal.ts` を `electron/shared` へ移す PR-3b-1 の、mutation の前の判断。DR-MP4-3 の「置き場 A（確定）」の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。走査の縮小もしない（下の 4・5 は広げる向き）。手順書の反証（2026-11-21）の直しを取り込んだ。

1. **DR-MP4-3a 置き場：`electron/shared/readDomain/` に `src/` の相対 path を mirror する。** 例：`src/db/schema.ts` → `electron/shared/readDomain/db/schema.ts`。決定文書・計画に置き場名は無く、これが初出の案。理由は、moved 同士の相対 import が拡張子（`.js`）の追加だけで済み、`@/` を機械的に相対へ直せること。flat 等にするなら PR-3b-2 の書換え表が変わる。移動先 path に除外 fragment（`/generated/`・`/fixtures/`・`schema-seed`・`.test.` など）を含めない（`validate-narrative-writers` の走査から黙って外れるため）。
2. **DR-MP4-3b 旧 path は 1 行の `export * from "@/../electron/shared/readDomain/<path>";`。** src に前例があるのは `@/../electron/shared/...` の **import** であり、`export *` の re-export stub は **初出**。`export default` は 3 本のどれにも無い（grep 0）ので `export *` で named export と型が揃う。importer の import 文は変えない。試験は src に残し、stub 越しに実体を検証する。
3. **DR-MP4-3c validator は strict を既定にする。** `validate-narrative-writers` は実体の新 path を読み、`sqliteTable` の一致が 0 なら失敗する（canonical が無い場合も失敗）。旧 path は `export * from "…schema"` の stub のときだけ許す。schema を持たない fixture は `requireSchema: false` を明示して緩める（fixture は試験側の 1 つの helper にまとめる）。緩めて通るのは「schema file が 1 つも無い」場合と、canonical が無く legacy（`src/db/schema.ts`）が `sqliteTable` を持つ旧配置の fixture で、それ以外の file があれば常に検査する（`main()` は緩めないので、実 repo で canonical が無ければ `canonical-missing` で落ちる）（canonical が空、legacy が stub でも schema でもない、stub があるのに canonical が無い、はどれも `requireSchema` に関係なく失敗）。旧 validator は stub＋未登録表の fixture で違反 0 を返した（穴の再現。base の validator で確認）。re-export の辿りは validator に持ち込まない。pin は件数でなく、**移動前の base で実測した表名の集合に対する包含**（表を足しても落ちない。表が減る・消えると落ちる）。
4. **DR-MP4-3d lint の範囲を広げる。** 移した file は `eslint src electron/preload`（と、それに含まれる prettier）の外に出るので、`electron/shared/readDomain` を `lint`／`lint:fix` に足す。同じ理由で `grimodex-boundaries/narrative-maintenance`（renderer と preload に掛かる）の対象にも足す。`package.json` の変更は ci-change-scope の全 lane になる（広がる向きで安全）。
5. **DR-MP4-3e 評価範囲は狭めない。** 新しい schema path を `evals/impact-map.yaml` の `narrative-extraction` に足す（schema の編集で選ばれる suite を、移動前と同じ以上にする）。schema は PR-4 以降で main の read tool（`tool-policy`）の共有基盤にもなるので、`tool-policy` にも足す（選択は移動前の上位集合）。`quality-manifest.yaml` の GDX-NARR-DETAIL-001・GDX-NARR-TEMPORAL-001 の `implementedBy` に新 path を足す（旧 path は stub として残す）。`time.ts`・`temporal.ts` は移動前も rule に当たらず（全 suite）、足さない。他の file を rule に足して全 suite から絞ることはしない。
6. **DR-MP4-3f src だけを歩く gate。** 制御バイト検査（`noControlBytes.test.ts`）は実体が範囲外になるので root に `electron/shared/readDomain` を足す（その root の file 数が 0 より大きいことも検査）。`aiPathRegistry`・`i18n.localeOrder`・`mastraAgentTurn` の走査が探す語（`invoke(`、`addResourceBundle(`、`mastraAgentTurn` の import）は 3 file に無く、影響なし。`validate-native-writer-ownership` は Rust だけで対象外。
7. **PR-3b-2 への持ち越し（下の「DR-MP4-3 追補 2」で完了）：** `toolTurnCache` を移すかの判断、型の切り出し 3 module、`RRF_K`、残りの 21 本。PR-4 で main が schema を値 import するとき、`vi.mock("@/db/schema", partial)`（18 file）は旧 path の stub にだけ掛かる点を再確認する（3b-1 では moved 側の schema の import は無く、seam は 0）。

### DR-MP4-3 追補 2（MP-4b PR-3b-2 の実装で決めたこと。技術判断。2026-11-22）

残りの pure な module を `electron/shared/readDomain/` へ移す PR-3b-2 の、mutation の前の判断。DR-MP4-3 追補（3a〜3f）の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。走査の縮小もしない。手順書の反証（2026-11-21）の直しを取り込んだ。

1. **DR-MP4-3g 移す範囲は 21 本（3b-1 の 3 本と合わせて 24 本）。** `lib/fts`・`lib/prosemirror`・`lib/createResultMetadata`・`lib/nativeMutationMetadata`、`features/tree/{fractionalIndex,treeReadingOrder,types}`、`features/chronicle/{chronicleSecrecy,chronicleSnapshot,chronicleTime,chronicleReform,resolveSceneAnchor}`、`features/codex/context/{codexVisibilityPolicy,resolvedCodexContext,resolveApplicablePhases,sceneTimeIndex}`、`features/codex/{phaseResolver,prosemirrorTextExtractor}`、`features/foreshadow/{deriveLabel,normalizeForeshadowRow,types}`。手順書の表は `tree/types.ts` を落としていたので足した（反証 P3）。**移さないもの：** `toolTurnCache`（移す module のどれからも import されず、module 大域の reset registry を持つ。PR-7 で扱う。反証 P2）、`chronicleReadingPosition`（IR 専用。`chatAgentIrClosure.test`・`toolExecutors.chatIr.test` が path を列挙している）。計画の「26 本」との差は 2 本で、残り 2 本の内訳は資料に無い（実測の入力は 24 本）。PR 本文に 24 本を列挙し、差を明記する。
2. **DR-MP4-3h 型・定数の切り出し。** 手順書の 8 型を 3 module に出す：`eventRows.ts`（`EventRow`・`ParticipantRow`・`SceneEventRow`・`EventRelationRow`。`api.ts` から）、`temporal/types.ts`（`TemporalNodeId`・`StoryCompare`・`StoryRankLayer`・`StoryRankResult`。`nodes.ts` は `../source/digest` を値で import するので丸ごとは移せない）、`tree/types.ts`（丸ごと `git mv`）。`RRF_K` は `chat/rrfK.ts`。元の file は `import type`＋`export type { … } from`（`RRF_K` は `import`＋`export { RRF_K }`）で出し続け、importer の import 文は変えない。新規 3 module には stub を作らない（元から src に無い）。src 側から引く specifier は `@/../electron/shared/readDomain/<path>`（反証 P2。`codexHybridSearch.ts` の import 先もこれ）。`CodexSearchHit` は `codexHybridSearch` を移さないので切り出さない（PR-4／5）。`codexHybridSearch` が定数のためだけに `semanticRecall`（embedding・DB を引く）を import していた辺が切れる。これは**意図した graph の変化**で、実測は PR 本文（初期 graph が raw −17,761、gzip −5,548。`semanticRecall` の chunk が初期 graph から外れる）。
3. **DR-MP4-3i vi.mock の seam。** `vi.mock` は解決後の module id 単位で効くので、旧 path（stub）だけに掛けた mock は、実体側の相対 import（moved→moved）を素通りする。移動後の graph を `vi.mock` と値 import から機械的に歩いて確定した（moved の旧 path を mock する試験 36 本のうち、実体の importer が旧 path の mock 対象を値 import する経路に届くのは 4 本）。**実行される経路は 1 本だけ：** `consistencyPayloadBuilder.test`（`resolvedCodexContext`→`phaseResolver`）。この試験は `mockResolveCodexState` の呼出しを assert しているので、旧 path だけの mock では 10 本が落ちることを確かめた。直しは、同じ factory（`vi.hoisted`）を旧 path と実体 path の両方に掛けること。残り 3 本（`TimelinePanel.test`・`TimelinePanel.inspectorRepro.test`・`foreshadowStore.test`）は経路が**読込みだけ**（`resolveCodexContexts`・`normalizeForeshadowRow` の本体に一時的に throw を入れても通ることを確認）で、mock された関数は非移動側が stub 越しに呼ぶので、試験は変えない。経路なしは `chronicleReadTools.test`・`chronicleToolCache.test`（`resolvedCodexContext` に届かない）、`plotThreadStore.test`・`scanImportOperations.origin.test`（moved の importer に届かない）、`lib/prosemirror`・`prosemirrorTextExtractor`・`normalizeForeshadowRow` の mock（moved の importer が無い）。この仕組み自体は `resolvedCodexContext.seam.test.ts` が固定する（旧 path の mock は素通りし、実体 path の mock だけが moved→moved に届く）。vitest の解決が変わって旧 path の mock が届くようになれば、この試験が落ちる。`vi.mock("@/db/schema", partial)`（18 file）は、moved 側の schema の import が全て type-only なので seam は 0（3b-1 のまま）。
4. **DR-MP4-3j gate の追従と、触れないもの。** (a) `impact-map.yaml` には足さない：21 本は移動前も rule に当たらず全 suite（fail-open）で、足すと全 suite から絞ることになる。新規 3 module は移動前は存在せず、切り出し元（`nodes.ts`・`resolveStoryRanks.ts`・`chronicle/api.ts`・`semanticRecall.ts`）は narrative-extraction・narrative-runtime-authority・ai-audit-runtime・retrieval-grounding に当たっていた（「新規は移動前も rule に当たらず」は不正確）。新 path は全 suite なので、その選択は切り出し元の上位集合で安全側になる。rule に足さないのは DR-MP4-3e の方針どおり。新 path が全 suite のままであることと、旧 path・切り出し元の選択の上位集合であることを `impact-map.test.mjs` で固定する。`quality-manifest.yaml` の `implementedBy` には、移した 21 本は載っていない。型の正本になった新規 2 module（`electron/shared/readDomain/features/narrative-extraction/temporal/types.ts`・`electron/shared/readDomain/features/chronicle/eventRows.ts`）は、GDX-NARR-TEMPORAL-001 の `implementedBy` に足した（DR-MP4-3e が schema の新 path を足した前例に揃え、範囲を広げる向き）。(b) lint・`narrative-maintenance` 境界規則・`noControlBytes` は 3b-1 で `readDomain` 全体を範囲にしてあり、追加は無い（`pnpm lint` は移した file に error 0）。`validate-narrative-writers` の走査 root は `src`・`packages`・`electron` で、`scanned` は 2,499 → 2,523（+24 = stub 21 と新規 3）。(c) S4 が pin する harness（`cp4-harness.ts:64` が `@/features/codex/phaseResolver` を引く）は source 不変で、`runner.mjs`・`k64-runner.mjs`・`trace-runner.mjs` の `harnessFiles` に移した file は無い。renderer の build は `nir1GraphAvailability` の解決後の path だけを差し替える。(d) `experiments/lfm25-encoder-phase0` の `src/lib/prosemirror.ts#prosemirrorToText` の固定参照は壊れない：freeze tool は stub 越しに `tsx` で解決でき（確認済み）、frozen の `sourceHashes`（旧 file の hash）は pattern だけが検査される。再 freeze すると stub の hash になる点だけ記録する（凍結の再実行は予定なし）。(e) `semantic-core` 境界：`nodes.ts`・`resolveStoryRanks.ts` が型だけを `@/../electron/shared/readDomain/…` から import するが、`validate-semantic-core-boundary` は PASS（許可 specifier の改訂は不要）。(f) `chatAgentIrClosure.test` は `electron/` も歩くので移した file も走査され、IR の語は無い。`electron/shared/mastraRead/ports.ts` の `CoreSceneTimeIndex` は同形の別定義のまま（PR-4 で寄せる）。コメントの参照先だけ新 path に直した。
5. **DR-MP4-3k 検証の方法。** renderer は package.json を変えないので、base と head を `--minify false` で build し、chunk の hash・path の region 行・短縮 alias・preload の依存 list を正規化して比べる。main の 3 bundle は esbuild を `write:false` で回して sha256 を比べる。起動 graph は minify ありの build で `perf:budget` を比べる（baseline・allowance・absoluteMax は動かさない）。測定は親 `c8d87705` の上で行い、patch は同一（`git diff c8d87705 b59bd198` と、今の親 `98e10bae`〔#1006 を含む〕の上の `git diff 98e10bae 74fe80cc` が一致）。
6. **残り（記録だけ、コードは変えない）。** 「同期を保つ」の参照先が 1 行の stub を指したまま：`src-tauri/crates/grimodex-db/src/fts.rs:397`、`src-tauri/crates/grimodex-mcp/src/chronicle_snapshot.rs:2`、`src-tauri/crates/grimodex-mcp/src/db.rs:1479`・`:1525`、`src/features/codex/context/fixtures/reading-order-parity.json` の purpose。Rust と fixture の JSON は変えない（`src/features/kouetsu/triage/relativeTime.ts:7` の TS コメントだけは新 path に直した）。

### DR-MP4-4 main の db adapter（技術判断）

- main の read は `backend.dbExecute(sql, params, method, JSON.stringify(turn.identity))` で、identity は **owner が発行した turn の値**（wire 由来にしない）。
  unrestricted では identity は無視され、restricted では Native が登録済み identity を要求して fail-closed になる。前例は `policyAllowsAgentTool`†（`ipc.ts:1042-1069`）。
- 返る文字列は `{rows, __grimodexDbResultKind}` の 2 key（`ipc.ts:1764-1772`†（残り `:1773-1797` と `electron/native/grimodex-node/src/lib.rs:6637-6657` は未再確認））。**行は object（列名→値）**。重複列名は接尾辞で位置を保つ（`execute.rs:1297-1345`、未再確認）。
- adapter（共有 1 本）の規則：
  1. **送信前の検査**（Native を呼ぶ前。外れたら `dbExecute` を呼ばずに throw）：SQL の先頭（前後の空白とコメントを除く）が `SELECT`（**大文字小文字を区別しない**。Drizzle は小文字の `select` を出すはずで、字義どおりに実装すると全 read が落ちる。出力の形は未確認）、method は `all`／`values`、params は配列。
     `get` は許可しない：Drizzle の sqlite-proxy は method `get` の rows を「1 行の平らな配列」として扱う（`node_modules/drizzle-orm/sqlite-proxy/session.js:133-161`†）が、
     renderer の写し（`src/db/client.ts`†。全 method で `rows.map(Object.values)`）は `get` に合わない。read tool は Drizzle の `.get()`／`.run()`／`findFirst` を使わない（7 file〔toolExecutors、chronicleReadTools、chronicle/api、codex/api、tree/api、foreshadow/api、semantic-search/api〕の grep で見つからない†。`.get(` は `Map` のものだけ。閉包全体は未確認）。ヒットしたら `rows[0]` の分岐を足す。
     `get` を許すなら adapter が `rows[0]` の平らな配列を返す分岐を持ち、試験で固定する。
  2. `JSON.parse` し、marker が `'read'` であることを確認する。`'committed-mutation'`、`invalid`、receipt の形は throw（fail-closed）。
     **marker の無い `{"rows":[],"committed":true}`**（reauthorization 失敗時の receipt。`lib.rs:6637-6652`†）も throw として扱う。
  3. `rows` が配列で、各要素が object であることを確認し、`Object.values` で位置対応に直す。
  4. 未知の形は throw。`undefined` で通さない。
  5. marker は main が消費する値で、tool 結果にも model にも出さない。
- **この検査は一層にすぎず、read-only の証明ではない**。SQLite は `WITH … DELETE／UPDATE／INSERT` を許すので、「SELECT／WITH で始まる」ではなく先頭が `SELECT` のものだけを通す（core が `WITH` を使うなら再検討。7 file の grep で `WITH`／`.with(`／`$with` が見つからない†）。
  実行時に組み立てた SQL（model の入力の混入）は先頭の検査だけでは捕まらないので、静的試験（core は Drizzle の select だけを発行し、model の入力から SQL 文字列を作らない）と事後検出（marker）を併用する。
- **既存バグ（触らない）**：`policyAllowsAgentTool` は object の行を配列として読み、`rows[0]` が配列でなければ `first` を undefined にする。
  `parsePolicyAllows` は undefined を true にするので fail-open（`ipc.ts:1064-1068`†、`:989-1000`†）。別 lane で修正中。**（#989 で修正済み。MP-4b PR-1 の時点の base では `aiPolicyColumn` が object の行を読む）**
  新しい reader はこの読み方を踏まず、行は object 前提で書き、policy の欠損は `parseAiPolicy` と同じ「full」の扱いを共有 module で揃える（DR-MP4-26）。
- unrestricted では Native に read-only の強制が無い（`own_data_read` は restricted のみ。`lib.rs:10711-10741`†：unrestricted は `execute_renderer_with_result` で、renderer 用の authorizer のまま書込みも commit される）。
  事前の強制を Native に足すのは新しい契約なので足さない（決定 2、回答 3）。補いは上の送信前の検査＋事後検出＋静的試験＋caller の timeout。残るリスクは脅威モデルに記載済み（T13、D16）。
- main 用の `SqlOrigin` と専用の Native command は足さない（新しい契約）。
- **caller の timeout（P2-2。回答 3）**：main の直呼びの read に caller の timeout が無いと、Native が返らないとき turn が待ち続ける。legacy と同じ既存の定数を使う。
  - 定数は `src/lib/tauri.ts` の `IPC_TIMEOUT_MS`（10,000。`:19`†）と `AI_IPC_TIMEOUT_MS`（300,000。`:55`†）で、どちらも module 内の非 export。**共有 module（例：`electron/shared/` の IPC timeout 定数）に出し、renderer（`tauri.ts`）と main の両方が同じ module から取る**（値は変えない。`tauri.ts` の既存の表の値と一致する試験を足す）。
  - 対応：`db_execute`（SELECT のみ。legacy の `callerTimeoutForCommand` は SELECT/WITH の read に 10 秒。`tauri.ts:382-389`†）と `fts_search`（`:238`†）は 10 秒。`codex_semantic_search`・`events_semantic_search` は 5 分（`:268-269`†）。
  - **`foreshadow_list_open_for_context` は legacy も caller timeout が無い**（`READ_ONLY_COMMAND_TIMEOUTS` に載らない。`:227-270`†。mutation の lane で動く）。main も timeout を付けず、abort との race（cancel・forced で結果を捨てる）と in-flight の計数で有界にする。値を新しく置くなら **C-18**。
  - caller の timeout は Native を止めない（`tauri.ts:56-62`† のコメントと `ipcQueue.ts` の slot の保持と同じ性質）。timeout で結果を捨てて turn を失敗にするが、**in-flight の計数は settle まで残す**（DR-MP4-5 の 4。slot の解放と quiesce の待ちに含める）。

### DR-MP4-4 追補（MP-4b PR-1 の実装で決めたこと。技術判断。2026-11-21）

呼び手のない基盤（timeout 定数、db adapter、typed read 4 本、port の型、静的試験）を置いた PR-1 で、設計に足した判断。新しい契約・authority・送信先・保存範囲・閾値は足していない。

- **第 5 引数（`own_data_read`）は付けない。** restricted の turn を作らない DR-MP4-5 と整合し、unrestricted では無効果（実測）。将来 restricted の turn を許すときに再評価する。試験は `dbExecute` の呼出しが 4 引数であることを固定する（`mastraRead/db.test.ts`、実 addon の spec）。
- **timeout の共有 module**（`electron/shared/ipcCallerTimeouts.ts`。import なし）は、`IPC_TIMEOUT_MS`・`AI_IPC_TIMEOUT_MS` と、main が使う 4 command（`db_execute`・`fts_search`・`codex_semantic_search`・`events_semantic_search`）の対応だけを持つ。command の表ごとは出さない（IR の gate の command 名を main の閉包に入れない）。値は変えない。
  `foreshadow_list_open_for_context` は legacy にも caller timeout が無いので置かない（新しい値は C-18）。
  **対応は同値でなく写し**：legacy の `db_execute` は renderer の判定（SELECT／WITH で始まり、書込み系の語を本文に持たない）を満たす文だけ 10 秒で、満たさない文は timeout なしで待つ。main は送信前の SELECT 検査を通った文だけを送り、常に 10 秒で切る。
- **送信前の検査に足したもの**：複文（末尾の `;` 以外）、comma join、table-valued function、allowlist 外の表、他の schema（`main` 以外）、未終端の文字列・コメント・NUL は、Native を呼ばずに throw する。
  **`from`／`join` の直後の `(` が `select` でないもの**（`from (some_table)`、`from (a, b)`）と、**`(` で始まらない `in`**（`where id in some_table`）も throw する。SQLite はどちらも表名として読む（実 addon で確認：`select … from (labels)` は読める、`… where id in labels` は表として引かれ列数の不一致で落ちる）ので、`from <名前>` だけを読む検査では allowlist の外が見えない。Drizzle はどちらの形も出さない。**これも一層の防御で、read-only の証明ではない**（`WITH … DELETE` は先頭の検査で落とすが、SQLite が受ける副作用のある関数などは捕まらない）。
- **表の allowlist は実行時の検査にした**（`electron/shared/mastraRead/sql.ts`、`tables.ts`）。理由：PR-1 には core が無く、静的試験には走査する SQL が無い。実行時の検査は SQL の組立方（Drizzle か、model の入力の混入か）に依らず効く。Drizzle の `from "t"`／`join "t"` を読み、読めない形は throw（fail closed）。
  core の Drizzle の select を走査する静的試験（DR-MP4-21 の 4）は PR-4。表は 21 本（codex 系 7、tree_nodes・snippets、年表 5、plot_thread 系 3、foreshadow 系 3、projects）。FK の先だけの `chat_sessions`・`chat_messages`・`codex_types` と closed 表・設定は入れない。表の増減は `tables.ts` と `tables.test.ts` の差分として見える。**PR-4 で core が触る 6 表に固定し直した（DR-MP4-32e）。**
- **行の写像**：Native の object の行を `Object.values` で位置対応に直す。**整数様の key（`"0"`、`"12"`）の列がある行は throw**（`Object.values` は整数様 key を先に並べ替え、位置が壊れる。`select 1` の列名が `1` など）。重複列名は Native が `\u0000N` を付けるので全列が残る（実 addon で固定）。`get` と `run` は送らない。
- **typed read**：fts の scope は union の型と実行時の検査の両方。semantic 2 本は `expectedWorkspacePath` を turn の identity の `workspaceId` から渡し、null・空・backend の method なしは Native を呼ばずに throw。legacy が呼出しの後に行う workspace の照合（`SEMANTIC_WORKSPACE_CHANGED`）は、main では turn の `assertLive` の前後の再確認で置き換える。PR-2 は `MainReadHooks`（`assertLive`、`trackInFlight`）に turn の値を渡す。
- **PR-4 への制約（core の Drizzle）**：送信前の検査は Drizzle の select の形だけを通す（字句は SQLite に合わせる：空白は ASCII の 6 文字、非 ASCII は文字列・引用識別子・コメントの外で拒否、placeholder は `?`／`?N` だけ。表の参照は `名前 [as] [別名]` の後ろを join の語・`on`・`using`・句の語・`)`・`;`・文末に限る。`from (` は `( select` の 1 重だけ）。**`.get()`・`findFirst()` は送れない**（method `get` を拒否する。上の「`get` と `run` は送らない」）ので、先頭 1 行は `.limit(1)` と `rows[0]` で読む。`db.$with`／`db.with`（`with` で始まる文）も送れない。実測（Drizzle 0.45.2 の出力 29 形を誤拒否なしで通す）は `sql.drizzle.test.ts`。
- **core の `projectId` は必須**（`assertCoreProjectId`）は core の新 entry だけ。既存の共有関数（`resolveCodexForAi` など）の signature と falsy の挙動は変えない。

### DR-MP4-5 read の時点の規則（技術判断）

- egress は次の send だけで、send は毎回 `assertLive`† を通る。read 自体は何も publish しない。よって read の規則は
  「開始の拒否＋完了後の破棄」で足りる。
  1. 入口を 1 本（turn 付きの read port）に集める。
  2. 開始の直前に `profileClosed()`（restricted／unavailable／activating の 3 状態）を含む `assertLive(turn)`（await を挟まず同期）。
  3. await の後に `forcedCause` と `assertLive`（`profileClosed()` の 3 状態を含む）を再確認し、外れていたら結果を捨てて turn の abort に合流する。workspace 切替は切替の前に `forcedCause` を立てるので、切替をまたいだ read の結果は捨てられる（未再確認）。
  4. in-flight を数え、slot の解放・quiesce・shutdown の待ちに含める（現状 `nativeInFlight` は send のみ）。待ちは `MASTRA_TURN_FORCED_BOUND_MS`（30 秒）と `MASTRA_TURN_QUIT_BOUND_MS`（5 秒）に乗せる（`mastraTurnOwner.ts:68-71`†。新しい値は置かない）。caller の timeout は DR-MP4-4。
- **実装の要点（MP-4b PR-2。技術判断。2026-11-21。呼び手なし）**：owner（`mastraTurnOwner.ts`）が turn の `readHooks(turnId)`（PR-1 の `MainReadHooks`）を返す。`assertLive` は send と同じ `assertLive(turn)`（forced・user-stop・`profileClosed()` の 3 状態・identity・sender）に、終わった turn の拒否（`MASTRA_TURN_READ_AFTER_END`）を足したもの。`trackInFlight` は turn ごとの `readInFlight`（send の `nativeInFlight` とは別）を settle まで数え、slot の解放と `coveredTurns` が両方を見る。
  待ちは、forced（`MASTRA_TURN_FORCED_BOUND_MS`）と quit（`MASTRA_TURN_QUIT_BOUND_MS`）では terminal と read の drain を **1 本の bound** で race する（時間を足さない。新しい値なし）。上限で切っても計数と slot は Native の settle まで残る。
  profile の quiesce（restricted の activation）は owner に timer を持たず、terminal と read の drain を gate の既存の bound（`PROFILE_EGRESS_PARTICIPANT_BOUND_MS`）に任せる。**帰結：settle しない read は restricted の activation を `participant-timeout`（unavailable）で fail closed にする**（settle しない terminal と同じ終わり方）。Native の stop 要求（`abortNativeInFlight`）は「AI の in flight」用なので、read では呼ばない。turn に read は繋いでいない（tool は 0。口は試験からだけ）。
  **持続する帰結**：settle しない read（caller の timeout が無い `foreshadow_list_open_for_context` など）は slot を持ち続け、その後の workspace 切替のたびに 30 秒、quit のたびに 5 秒待たせ、restricted の activation を unavailable で閉じる状態が、Native が settle するまで続く（上限で待ちを切っても計数は残る）。
  **abort と待ちの対象は分ける**：正常に終わった turn（`finished` かつ forced でない）を late な read だけが保つ場合、その turn は待つだけで `forceAbort` しない（terminal は書き済みで、二重に書かず、失敗した append で quiesce を落とさない）。上限で切った待ちの waiter は外す。
  **前提**：試験の harness は send を保留したまま read を重ねるが、製品の loop では tool は直列（`toolCallConcurrency: 1`）で read は send の合間に走る。read と send の重なりで audit と返りがずれるのは harness だけで起きる。
- 既知の限界（decisions と PR 本文に書く）：unrestricted の `fts_search` と `foreshadow_*` は Native に workspace の pin が無い。切替との競合は 3 の再確認で扱う。
- JS gate は再現しない（第 2 節）。不変条件は「`profileClosed()` の 3 状態のどれでもないときだけ read を始め、await の後も再確認する」で、静的試験と lifecycle 試験の対象に 3 状態を含める。
  （「到達できるモードは unrestricted だけ」は restricted だけを見た記述だった。`unavailable` では JS 側の gate の `assertInvoke` が `db_execute` を拒否する〔`profileEgress.ts:1243-1297`、未再確認〕が、main の直呼びはこの gate を通らない。）
- 代案：(i) JS gate（`assertInvoke`、`classifyOwnDataRead`）を main に再現する：到達できる唯一のモード（unrestricted）で no-op、他の 3 状態では turn が閉じるので dead code。退けた。
  (ii) Native に read-only の強制や pin を足す：新しい契約。足さない（回答 3。残るリスクとして脅威モデルに記載）。
  (iii) read の結果を step の境界まで保留する：read 自体は何も publish しないので不要。

### DR-MP4-6 typed read 4 本の呼び方（技術判断）

- read port は **4 本だけを名前固定の method として公開**する（`fts`、`codexSemantic`、`eventsSemantic`、`foreshadowOpen`）。各 method は `NAPI_COMMANDS` の **literal key**
  （`fts_search`、`codex_semantic_search`、`events_semantic_search`、`foreshadow_list_open_for_context`）の `run`（引数検査＋`parseWire`。`ipcContract.ts:9818-9828`†、`:10297-10315`†、`:10357-10375`†、`:10677-10683`†）を呼ぶ薄い wrapper。
  **cmd を引数に取らず、`NAPI_COMMANDS` を動的 key で引かない**。理由：`NAPI_COMMANDS` は全 command（`chat_agent_ir_select`、write 系、`db_execute` を含む）の表で、`chat_agent_ir_select.run` 自体は gate を持たない
  （`ipcContract.ts:9994-10003`†。IR の gate は router の `chatAgentIrGateRefusal`。`ipc.ts:2245`†、`chatAgentIr.ts:22`†）。cmd が変数だと IR の閉鎖の 3 層のうち router の gate を迂回する経路になり、静的試験の「名前の参照禁止」にも掛からない。
- `fts` の `scope` は literal union（`'codex' | 'scenes' | 'snippets'`）にし、`'all'` や任意の文字列を渡せなくする（`fts_search` の `scope` は呼び手の任意の文字列。`ipcContract.ts:9818-9827`†）。
- `run` は型の上で第 3 引数 `deps`（`DispatchDeps`）を取る（`ipcContract.ts:6838-6842`†。「大半のコマンドは backend／args のみで完結し `deps` を使わない」とコメントにある）。
  **4 本の `run` は `(b, a)` の 2 引数だけで `deps` を使わないことを確かめた**（上の 4 つの行番号†）。型を満たすため空の frozen 定数を渡す。それ以外の command には渡さない。
  4 本が将来 `deps` を使うようになったら落ちるよう、静的試験で固定する。
- semantic 系の `expectedWorkspacePath` は `turn.identity.workspaceId`（MP-3 の前例）。fts と foreshadow には pin が無い（DR-MP4-5）。
- 直呼びは `assertInvoke` と `classifyOwnDataRead` を通らず、最終 authority は Native になる。信頼境界として PR 本文に残す（脅威モデルの T13・D16。回答 3）。
- 代案：backend の method の直呼び：引数検査が無くなる。退けた。cmd 文字列で `NAPI_COMMANDS` を引く汎用 port：IR の gate の迂回路になる。退けた。renderer 経由の IPC に戻す案：main から renderer への RPC が要り、MP-5 の契約を先取りする。退けた。

### DR-MP4-7 read tool の分類表（26 本）

manifest の read は 26 本。`READ_ONLY_EXECUTORS` は 24 本†（`toolExecutors.ts:2172-2206`）で、`run_research` と `ask_user` はその外。
(a)＝共有 core＋main の `dbExecute`・既存の Native 呼出しで動く。(b)＝RPC。(c)＝設計判断が要る。依存は事前調査による（未再確認）。

| # | tool | 分類 | 主な依存 | MP-4 での扱い |
|---|---|---|---|---|
| 1 | search_codex | (a) | Drizzle、`fts_search`、`codexSemanticSearch`、`fuseCodexHybrid`、hidden 判定、tokenizer、logger | core。現在の場面は hidden の anchor |
| 2 | search_events | (a) | `eventsSemanticSearch`、年表 cache、読む順、`isEventHiddenFromAi`、現在の場面 | core。IR 版（`searchEventsWithIr`）は使わず plain 版。説明文は DR-MP4-21 |
| 3 | list_codex_by_type | (a) | Drizzle、hidden 判定 | core |
| 4 | get_codex_entry | (c) | Drizzle＋renderer の guard（`fullyInjectedIds`） | **MP-4 の main に載せない**（DR-MP4-10。MP-13 の前に C-6） |
| 5 | list_codex_tags | (a) | Drizzle | core |
| 6 | search_codex_by_tags | (a) | Drizzle、hidden 判定 | core |
| 7 | find_related_entries | (a) | Drizzle、起点の hidden 判定 | core |
| 8 | list_chapters | (a) | Drizzle、`cmpKeys` | core |
| 9 | get_scene | (c) | Drizzle＋本文の read（barrier） | core。barrier は DR-MP4-9 |
| 10 | search_scenes | (a) | `fts_search`、Drizzle。barrier 無し | core |
| 11 | list_plot_threads | (a) | Drizzle、`cmpKeys`、`phaseRank` | core |
| 12 | get_thread_scenes | (c) | Drizzle（XPROJ の段階）＋本文の read（barrier） | core。barrier は DR-MP4-9 |
| 13 | search_snippets | (a) | `fts_search`、Drizzle | core |
| 14 | get_chapter_summaries | (a) | Drizzle | core |
| 15 | list_open_foreshadows | (a) | `foreshadow_list_open_for_context`（secret=0）、組立は純 TS | core |
| 16 | get_foreshadow_detail | (a) | Drizzle（XPROJ）。secret の判定が無い | core。**同値で写し、変えない**（DR-MP4-24） |
| 17 | get_scene_timeline_neighbors | (a) | Drizzle、`cmpKeys` | core |
| 18 | list_events | (a) | 年表 cache、読む順、UI 言語、`visibleEventIds` | core。UI 言語は Q4（wire で運ぶ値） |
| 19 | get_event_detail | (a) | 同上＋複数 Drizzle | core。UI 言語は Q4（wire で運ぶ値） |
| 20 | get_character_timeline | (a) | `visibleEventIds`、`listEventParticipantsForProject` | core |
| 21 | get_chronicle_state | (a) | 参加者・関係・暦、UI 言語 | core。UI 言語は Q4（wire で運ぶ値） |
| 22 | get_app_help_index | (c) | i18n、keybindings、license、OS、help 文書 | RPC（MP-5。DR-MP4-11） |
| 23 | get_app_help | (c) | 同上＋`readUiState`（DOM・layout store） | RPC（MP-5） |
| 24 | get_ui_state | (b) | layout store、DOM | RPC（MP-5） |
| 25 | run_research | (c) | 子 loop、`runAgentLoop`、renderer の store | **移さない**（DR-MP4-22） |
| 26 | ask_user | (b) | pending question、利用者の回答の Promise | RPC（MP-5） |

- 結果：(a) 18 本、(c) のデータ read 3 本（`get_codex_entry`、`get_scene`、`get_thread_scenes`）、help 2 本、(b) 2 本、`run_research`。
  main に載せる集合（M4）は (a) 18 本＋`get_scene`＋`get_thread_scenes` の **20 本**（`get_codex_entry` は C-6 の回答後に 21 本）。
- (a) の 18 本も、現在の場面・`resolutionMode`・tokenizer の 3 点が決まることが前提（DR-MP4-8、18）。
- 4 本の年表 tool と `search_events` の鮮度は DR-MP4-16。

### DR-MP4-8 hidden・年表 secret の入力と、live と turn 固定の差（技術判断。差の受容は Q5）

- 入力は 3 つに分ける。(i) 現在の場面＝wire の `currentSceneId`。legacy は IR 閉の間 scope を作らず、`useTreeStore.activeSceneId` を呼出し時に live で読む
  （`chatAgentToolHandlers.ts:459-480`、未再確認）。wire に載せる値は chat store の `activeSceneId`（preflight が turn 開始に捕捉。空文字は null）で、tree store の mirror（DR-MP4-1）。
  (ii) 読む順と `sceneTimeIndex`＝main が DB の `tree_nodes` から再構築する（純関数。`sceneTimeIndex.ts:37-39`、`:109-134`、未再確認）。
  (iii) `resolutionMode`＝`projects.phase_resolution_mode`（`schema.ts:32`、未再確認）。
- **再構築の範囲**：
  - `tree_nodes` は **`project_id` ＝ wire の `projectId` だけ**を対象にし、**tree store と同じ除外（`archivedAt IS NULL`）**を掛ける。
    別の SELECT を書かず、`listNodes`（`src/features/tree/api.ts:240`†。`isNull(treeNodes.archivedAt)`）と同じ projection・同じ除外を共有 core から使う。
    archived を含めると読む順と hidden 判定が変わる。
  - `currentSceneId` が**その project の場面集合に無ければ null と同じ**扱いにする。null の意味は年表と Codex で違う（DR-MP4-1）：年表は secret を隠す、Codex は base で解決する。
    形式検査だけの値で他 project の場面 id が読む順に混ざると、位置比較が意味を失う。
    legacy の fail-closed（現在の場面が読む順に無ければ年表の secret を隠す。`chronicleSecrecy.ts:77`†）は、読む順が project 内に限られることが前提。他 project の `currentSceneId` を渡す fixture を 4b の試験に入れる。
  - core の `projectId` は必須（空なら throw）。`resolveCodexForAi` の projectId が falsy で project 条件が消える形（`codexHiddenFromAi.ts:84-92`†）を port 化で残さない（DR-MP4-3）。
- **鮮度**：legacy の年表の cache は、events／scene-events／codex 名を batch 内の初回使用時に lazy に読んで共有するが、**読む順は nodes の「参照」をキーにする**ので、tree store が更新されれば batch の途中でも再計算される
  （live。`chronicleToolCache.ts:36-69`†）。main は batch の開始時点の DB で固定する。この差（batch の途中で tree が変わっても main は再計算しない）は Q5(d)。
  **〔PR-7a の実装。DR-MP4-37〕** 読む順と tree state は turn の開始時の 1 本の tree select に固定した（年表用の nodes も同じ行から作る）。events・scene-events・Codex 名の cache は turn の間 `clear()` まで残る（legacy は batch ごとに破棄）ので、turn の途中の event の `secret`・`reveal_scene_id` の変更が見えない窓がある（公開 → secret は見えたまま。Q5 (f)）。
  tree store（メモリ）の更新から DB への永続までの窓（並べ替え・追加の直後）は DB が古くなりうる。DB が古いと**作者の画面とずれる。向きは両方向**（現在の場面を前へ、または reveal／anchor の場面を後ろへ動かした直後は DB が古い main のほうが広く開示し、逆の動かし方なら狭い。追加・削除・`storyTimeOrder` の通常の編集は DB が先なので逆向きの短い窓。**ただし削除の undo は別**：store はメモリの `storyTimeOrder` を戻すが DB の行は NULL で作り直されるので、窓でなく reload まで続く。K-5 の (2)(8)、PR-6 の記録の 6・11）。
  対策は turn 開始前に、`resolutionMode` だけでなく **tree の並びの未保存の変更も flush する**ことと、残る窓を Q5 で受容するかの確認。K-4、K-5。
- (iii) は renderer の store が先で、DB への書込みは debounce の queue（`projectMetadataWriteQueue`）。窓は未測定（K-5）。flush は **Mastra の分岐に入ってからだけ**行う（legacy の開始を遅らせない。legacy の呼出し順は変えない）。
- 差：場面を切り替えない turn では live と固定に差が無い。legacy は場面切替を authority の検査で次の tool 前に abort する経路がある（読みによる推定。K-3）が、
  **scene scope の persisted session では `activeSceneId` の変化だけでは abort せず**（`chatTurnStoreActions.ts:430-433`†。`turnSessionId !== null` なら temporal anchor は同一とみなす）、
  legacy の tool は切替後の場面を live で読む。この条件で場面切替が `activeSessionId` の変化を伴うかは未確認（K-3）。
  main は renderer が cancel しない限り検査が無く、切替後の呼出しは turn 開始の場面で動く。**後ろの場面へ切り替えたなら開示は狭い側、前の場面へ切り替えたなら広い側にずれる**。
  これは「固定が仕様」と決めず、**Q5 の確認まで確定しない**。新しい契約を要さない緩和策は、renderer が場面切替時に Mastra の turn を cancel する（DR-MP4-26 の watcher）こと。
  特性試験の期待に「切替なし＝同値、切替あり＝Q5 の回答どおり」と書き、Q5 の回答まで同値試験の対象から外す（4b はこの差を確定せずに進められる）。
- `buildReadingOrder` の `localeCompare`（ICU）が renderer（Chromium）と main（Node）で同じ並びになるかは未確認（K-4）。fixture 比較に含める。
- fail-closed を保つ（DB に無い id と不明な mode は hidden）。main 用に別実装を作らず、core を共有する。
- 代案：(i) 場面・nodes・mode も wire で運ぶ：新しい契約（回答 2 の 2 回に入っていない）。退けた。(ii) 毎 tool で場面を live に取り直す：main は renderer の現在の場面を知らず、RPC が要る。退けた。

### DR-MP4-9 場面本文の barrier（技術判断。差の受容は Q5）

- `loadSceneContent`／`loadSceneContents` は renderer の module 内の「発行済みで未完の UPDATE」を待ってから SELECT する（`pendingSceneWrites.ts:1-24`、`:150-175`、未再確認）。main からは待てない。
- 窓は狭い：debounce 中の未保存の入力は legacy でも DB に無い。`search_scenes` は legacy でも barrier が無い。chat には turn 開始時の flush も無い。
- 案：(i) turn 開始前に renderer が `awaitAllPendingSceneWrites` を呼んでから start する（**Mastra の分岐に入ってからだけ**。legacy の呼出し順と開始の時刻は変えない。試験で固定する）。(ii) 残る窓は受容し、特性試験に「barrier なし」と明記する。
  turn 中の書込みは守れない（legacy は守る）。Q5 の回答まで、特性試験の期待に「barrier なし」と明記して同値試験の対象から外す。
- 代案：本文 2 本だけ MP-5 の RPC に寄せる：RPC の失敗モードを read に持ち込むので退けた。barrier の待ち集合を main に持たせる：renderer の module の状態を複製する新しい契約になる。退けた。
- 受容する差は **Q5** に載せる。

### DR-MP4-10 `get_codex_entry` の guard（確認要の前提つき）

- renderer の guard が、system prompt に全文を注入済みの id では executor を呼ばず note を返す。`prepared.fullyInjectedIds`（renderer の文脈組立の結果）に依存し、wire の 3 欄に無い。
  main で落とすと結果と `tokensUsed` が legacy と変わる。
- 選択肢：(1) wire に足す（新しい契約）、(2) guard なしで全文を返す（結果と token が変わる）、(3) main の tool 集合から外す。
- 技術判断：**MP-4 では (3)**。挙動を変えず新しい契約も作らない。L を開ける前（MP-13 までに）に (1) か (2) を **C-6** で決める。
  (1) を採る場合の `fullyInjectedIds` は 4c-1 の wire 一式に入れるかどうかを **Q4 で一緒に伺う**（契約変更を計 2 回に保つため。回答 2）。

### DR-MP4-11 help 2 本（技術判断。改訂 2 で確認 C-12 から移した）

- 判断：**RPC（MP-5）に寄せる**。main の tool は MP-4 で help を持たない。
- 根拠：
  - `get_app_help` の panel の詳細が `readUiState`（layout store と DOM）を呼ぶ。同じ turn の UI 操作で値が変わるので、turn 開始の snapshot では同値にならない。
  - 動的な入力が 5 種（UI 言語、keybinding の上書き、license、OS、UI 状態）あり、承認済みの 3 欄を超える値を renderer から運ぶか main が自前で取る必要がある。
  - 実装が約 450 行で renderer の store 4 つに跨る。MP-5 の RPC（`get_ui_state`、`ask_user`）で一本化できる。
- 代案：main 化。辞書 2 本（約 660 KB）と文書（約 36 KB）は静的で bundle できるが、動的入力の取得に新しい契約が要り、bundle と起動への影響が未測定。退けた。
- 影響：計画書 MP-5 の renderer の tool が 6 本から 8 本になる（計画書に反映済み。第 9 節）。MP-5 の契約（U-8）はその PR で確認する。

### DR-MP4-12 loop 規則の写し方（案。4c-1 の最初の特性試験で確定）

- 規則は Mastra を import しない **pure な rules module**（`electron/main/` 側。`countTokens`・制御 message・上限値・`shouldAbort` を注入）に集める。
  Mastra へは次の 5 つの継ぎ目だけで繋ぐ：(1) **応答の観測 tap**（injected send の戻りの後。観測だけで request は変えない）、(2) tool の execute wrapper、(3) `stopWhen`、(4) 有限の `maxSteps`、
  (5) **begin の前の注入点**（request の変形と拒否はすべてここ。DR-MP4-28。Mastra の `prepareStep` は代案）。
  **send の位置（`options.send`）では request を変形も拒否もしない**（audit の begin の後なので、`request.prepared` と実際の送信がずれる。P1-1。DR-MP4-28）。
  closure は runTurn の引数で bundle に渡す（DR-MP3-28 の「runtime に入れるのは Agent・adapter・方針だけ」を保つ）。
- legacy の規則（`agentLoop.ts`。†は 210-250、268-300、312-345、355-375、386-406 を照合）：
  - 回数の既定は 10。メインチャットは窓から 25／16／12／10。tokenBudget は `max(2,000, floor(窓×0.3))`。`ask_user` は別枠 8。
  - 回数は tool_use 1 件ごとに実行前に加算（未宣言も数える。`:272-277`†）。ただし**数えるのは `stopReason` が `tool_use` で、かつ制御 message を挿入済みでない応答の tool_use だけ**
    （`:228-249`。上限後の最後の応答の tool_use と、`stopReason` が `tool_use` でない応答の tool_use block は数えない）。`ask_user` は宣言ゲートより前に別枠で数える。
    上限の判定は**バッチ全体の実行と tool_result の追加の後の 1 回だけ**（バッチの途中では止めない）。判定は `>=`。優先順は questions>calls>tokens†。
  - 上限到達で `{role:'user', content: 制御 message}` を tool_result の後ろに積み、LLM をもう 1 回だけ呼ぶ。その応答が tool_use でも実行せず text で終える†。tools 配列は変えない。
  - 1 件の結果の cap は `max(1, floor(tokenBudget×0.25))`。超えたら `keepChars` で slice し `...[truncated: 元 N tokens]` を付ける。error 文にも掛かる（`Error: ` 前置の後。`:355-375`†）。`totalTokens` は executor が出す**切詰め前**の値の合計（`:325`）。
- 写し方（案）：
  - 回数は応答の観測 tap で Rust 応答の tool_use block を、**上の 2 条件（`stopReason` が `tool_use`、制御 message 挿入前）で**数える（execute 内で数えると、入力検証の失敗と ToolNotFound を取りこぼす）。
    adapter は `stopReason` が `tool_use` でなければ tool-call を出さない（`agentLanguageModel.ts:670-672`）ので、tap の条件と一致させる。進捗の `totalCalls` を legacy と同じ時点で出す特性試験を足す。
    `tokensUsed` は execute wrapper が `toolCallId` の side table に積む。
  - 上限判定は「次の send の直前」（＝前バッチの全 tool の実行後。begin の前の注入点）に行い、legacy の「バッチ後に 1 回」と同じ時点にする。
  - 上限後の最後の応答：Mastra は「上限 step で tool を実行して終わる」ので legacy と違う。実際の停止は `stopWhen`＝「制御 message を挿入済み（begin の前の注入点が立てた flag）」で行う。flag が立った後の tool は wrapper が no-op にする。
  - **`maxSteps` の上限（案）は legacy の最大 send 数から導く**：各 send は応答 1 回で 1 step。tool_use のある応答の batch は `totalCalls` か `userQuestionCalls` を少なくとも 1 増やす。
    上限に達していない batch は高々 `(maxToolCalls−1)＋(maxUserQuestions−1)` 個、上限に達する batch が 1、その後の最後の応答が 1。よって send の総数は **`maxToolCalls＋maxUserQuestions` 以下**
    （token の上限が先に働けばさらに少ない）。この式を `maxSteps` に渡す。前案の「＋2 程度」は根拠が無いので採らない。
    式であって定数を足さないこと、Mastra の step の数え方（最後の応答の step を含むか）で 1 足りるか（K-2）を、特性試験で「`maxSteps` ≧ legacy の最大 send 数」として固定する。
    **技術判断（C-3(c) から移した）**：導出式であって新しい閾値ではない。legacy の停止より先に働かないことを、特性試験で「`maxSteps` ≧ legacy の最大 send 数」として固定する（上限の窓別 25／16／12／10 と questions の別枠 8 の組合せを含む）。K-2 は実測で確かめる。
  - 制御 message の入れ方：`onIterationComplete` の feedback は role が `assistant` で、位置も違う（dist の読解）ので使わない。
    **send tap（`options.send` の位置）で `args.messages` に足す案は採らない**：adapter の順序は `buildAuditRequest` → `audit.begin` → `buildWireArgs` → `audit.dispatched` → `send`（`agentLanguageModel.ts:841-859`†）で、
    sink の `request.prepared` は begin の入力（`agentAuditSink.ts:136-197`†）から作られるので、send の位置で足すと audit に載らない message が wire に載る。
    案は **begin の前の注入点**で `{role:'user', content}` を messages の末尾に足す方式（DR-MP4-28）。`prepareStep` で messageList に足す案は順序の未実測（K-1）。どちらも
    「`request.prepared` の messages・`systemCacheSegments` が wire の args と bytes で一致する」特性試験で確かめて採る。
- **結果の組立表**（renderer が metadata と永続化を組むための各フィールドの出所。legacy の式を写す。4c-1 の wire は Q4 で決める）：

  | フィールド | legacy の出所 | Mastra 経路の出所（案） |
  |---|---|---|
  | `finalText` | 最後の応答の text（abort の位置で空か直前の応答の text） | 応答の観測 tap が最後の応答の text を持つ（Mastra の text 集計とは別。R-20） |
  | 画面の本文（連結 text） | `onTextChunk` を**応答ごと**に区切りなしで連結した値（持続される content） | 応答の観測 tap が応答ごとの text を積んで連結 |
  | `finalThinkingBlocks` | **最後の応答のものだけ** | 応答の観測 tap が最後の応答のものを持つ |
  | `toolCallRecords` | name・params・`resultSummary`（`ToolResult.summary`。throw では `Error: <msg>`、未宣言では `<msg>`）・tokensUsed（未再確認） | wrapper が side table に name・params・summary・tokensUsed を持つ。未宣言の record は Mastra では出ないので wrapper が自前で出す |
  | usage（累計） | 素の応答の合計 | 応答の観測 tap で素の応答から legacy と同じ式で合計（Mastra の usage は別の値） |
  | `stoppedReason` | `aborted`／上限の理由／`completed` | rules module |
  | Stop 時の途中 text（`canFinalizeStoppedAgentTurn`。`chatTurnStoreActions.ts:1371-1376`、未再確認） | stopped として確定できる | Mastra 経路の cancel が途中の text を返す設計は無い。**Q4(d)** に含める |

- **値の出所（確認要 Q4）**：窓は renderer の `effectiveContextWindow`（custom context、endpoint、動的 model 能力を含む）に依存する。
  main が再計算すると registry と aiSettings を main に移す（新しい authority）。renderer が計算済みの値と制御 message 3 本を wire で渡すのは新しい欄（新しい契約）。
  どちらも承認済みの 3 欄の外で、Q4 の一括に含める（推奨：renderer が計算済みの値を渡す）。数値は現行の関数（`getAgentToolCallBudgetForContext`、`getToolTokenBudgetForContext`。`modelLimits.ts:1099-1125`、未再確認）を共有 module に移して両側が同じ関数を使い、**新設も変更もしない**。
  main が値を受けるときの検査の値域は、既存の関数・定数から導けるものだけにする。導けない欄が出たら新設の閾値に当たりうるので Q4 で伺う。
- **MP-2 の特性試験は土台になるが、そのままでは足りない**：scene は A〜J で上限・`ask_user`・未宣言・abort・バッチ途中・上限後の tool_use を含まず、
  Mastra 側は既定の 5 step。`maxToolCalls` を 10 に固定している（`mastraAdapterCharacterization.test.ts`、未再確認）。DR-MP4 の試験（第 6 節）で足す。

### DR-MP4-13 tool 結果の整形（案）

- null→summary（空なら `No result (not found).`）、`JSON.stringify`、error は `Error: ` 前置、25% 切詰めは **execute wrapper の責務**にする。
- **成功は文字列を返す**（adapter は string を `type:'text'`、`isError: false` で運ぶ。`agentLanguageModel.ts:262-291`†）。
- **失敗は wrapper で throw し、adapter の error-text の経路に乗せる**。adapter は `isError` を output の type だけで決める（text は false、error-text だけ true で `Error: ` を前置する。`:262-291`、`:354-372`†）ので、
  失敗を文字列で返すと wire の `tool_result` の `isError` が落ち、legacy（error のある結果は全て `isError: true`。`agentLoop.ts:358-372`†）と bytes が変わる。
  throw する message は「legacy の content（`Error: ${error}` に 25% 切詰めを掛けた後）から先頭の `Error: ` を除いたもの」にする（adapter が前置を戻す）。
  **端**：予算が極小で `keepChars` が前置より短いとき（前置自体が切れる）は再現できない。特性試験で固定するか、adapter に `isError` を運ぶ口を足す（adapter の契約変更なので、足す場合は扱いを明記してこの文書を改訂する）。
  Mastra が throw を error-text にするときの `value` の形（message のまま渡るか）は未確認なので、4c-1 の最初の実測項目に入れる（K-18）。
- authority 喪失の no-op（DR-MP4-14）は throw ではなく通常の結果（何も実行しない）。失敗の throw とは区別する。
- MP-2 の `formatToolResultContent`（試験側の写し）は throw の経路が切詰めを通らない。MP-4 では wrapper が切詰めを掛けてから throw し、巨大な error 文の scene を足す。
- `countTokens` は注入にし、試験は 1 文字＝1 token（legacy の試験と同じ）を使う。切詰めは UTF-16 の code unit で行う（surrogate pair を割りうる。legacy と同じ。変えない）。
- 代案：失敗は throw のまま Mastra の error-text に任せる（wrapper で切詰めない）：error 文が切詰めを通らず、legacy と結果が変わる。退けた。切詰めを adapter に置く：adapter は loop 規則を持たない（DR-MP3-28）。退けた。

### DR-MP4-14 abort・forced・authority 喪失（案）

- legacy は `assertTurnAuthority` の throw が turn を落とす。Mastra は execute の throw を tool error にして loop を続ける。
  wrapper が authority と shouldAbort を execute の**先頭と実行後**で検査する：
  - 先頭：外れたら turn の closed flag（owner の `forceAbort` に繋ぐ）を立てて **no-op**（何も実行しない）を返す。次の send の直前の検査（DR-MP3-27）が次の LLM 呼出しを止める。
  - **実行後**：legacy は tool の実行後に `shouldAbort` を見て、外れていれば結果を積まずに return する。この return は `totalTokens` の加算・`ToolCallRecord` の作成・`onToolComplete` より前にある
    （`agentLoop.ts:316-323`†。`totalCalls` は実行前に加算済み）。よって abort をまたいだ tool は tokensUsed にも record にも数えない。
    wrapper は実行後に `forcedCause`／`assertLive` を再確認し、外れていれば side table に tokensUsed を積まず record も出さない。
  - abort 時の `finalText` と `stoppedReason: 'aborted'`：loop の先頭で外れたら `finalText` は空（`:214-218`†）、tool の実行後なら直前の応答の text（`:316-323`†）。この 2 通りを特性試験に入れる。
- バッチ途中の abort（legacy は tool 1 件ごとに検査し、残りを実行しない）は execute の先頭の検査で写す。Mastra が `abortSignal` をバッチの途中でどう見るかは未読（K-3）。
- **no-op の中身（技術判断。C-4 から移した）**：authority 喪失時に wrapper が返す値は、**固定の文字列定数**（tool の名前・入力・DB の値を一切含めない）にする。
  この値は model に届かない：外れた turn は次の send の直前の `assertLive`（DR-MP3-27）で止まり、begin の前に throw するので、no-op の結果を含む request は Rust にも provider にも出ない（試験で固定する）。
  よって漏れは無く、脅威モデルの改訂も要らない。no-op は throw ではなく通常の結果で、tokensUsed と record に数えない。
- authority の条件ごとの観測と守り方は DR-MP4-26。
- 代案：execute で throw する（Mastra が tool error にして loop を続ける。legacy は turn を落とす）：次の send まで loop が続き、authority を失った turn が余計な結果を作る。退けた。

### DR-MP4-15 未宣言 tool（技術判断：再現する。C-9 から移した）

- legacy：宣言外の tool は executor を呼ばず、`Error: Tool not available this turn: <name>`（content は `Error: ` 前置。`isError: true`）・`tokensUsed` 0 の結果と `ToolCallRecord`（`resultSummary` は前置なしの `Tool not available this turn: <name>`）を作り、回数に数える
  （`agentLoop.ts:281-296`†、`:358-372`†）。
- Mastra の既定は `ToolNotFoundError` で、使える tool の一覧を model に返し、record も `onToolComplete` も出ない（dist の読解）。
- 案：回数は応答の観測 tap で数える（宣言外も数える）。tool map を包んで未宣言名を自前の拒否 tool に流す。拒否 tool は DR-MP4-13 と同じく **throw して error-text の経路に乗せ**、
  wire の `tool_result` を `Error: Tool not available this turn: <name>`・`isError: true` にする。record は wrapper が自前で出す（`resultSummary` は前置なし）。
  **再現する（同値の既定方針）**。再現しない（Mastra の既定を受ける）と、「使える tool の一覧が model に渡る」差を受容することになり、loop 規則の同値の範囲を読み替える。
  **差を受け入れるときだけ**ユーザーに確認する（C-9 は条件つきの記録として第 8.2 節に残す）。

### DR-MP4-16 tool の cache の単位（案）

- `beginAgentToolTurn` は legacy で応答ごと（バッチごと）に module singleton の cache を全破棄する。run_research の子 loop も同じ reset を呼ぶ（親バッチの cache も破棄される）。
- **対象は 2 か所**：`toolTurnCache`／`beginAgentToolTurn` と、`chronicleToolCache.ts` の module singleton（`SharedLoader` の 4 つと `readingOrderSlot`。`registerToolTurnReset` で全破棄される。`chronicleToolCache.ts:19-63`†）。
- main は sender あたり 4、全体 8 の turn を同時に持つ（DR-MP3-4）。cache が singleton のままだと並行 turn が互いの cache を破棄する。さらに、project・場面の違う turn の導出値（読む順など）を共有しうる。
- 案：cache を **turn ごとの instance** にし、batch 境界のリセットも turn 単位にする。reset の登録表も turn 単位にし、読む順など現在の場面・project に依存する導出値を**turn をまたいで共有しない**。
  並行 turn の試験（第 6 節 8）で、互いの cache を壊さないこと、導出値が共有されないことを固定する。
  `run_research` は MP-4 に無いので親子の reset の同値は問題にならない。legacy の renderer は module singleton のまま（core は cache を port で受ける。DR-MP4-3）。
  計画書が MP-4 の範囲に「`beginAgentToolTurn` の turn 単位の分離」を明記している（`mastra-migration-plan.md:367`）ので、新しい判断ではなく範囲内。
  並行 turn で互いの cache を壊さない点は legacy の単一 renderer 前提の外なので、特性試験で「単独の turn は同値」を示し、差として PR 本文に書く。
- 代案：module singleton のまま main に移す：並行 turn が相互に reset し、他 turn の読みが無効化される。退けた。
- Mastra が同一 step の複数 tool call を並列に実行するかは未確認。legacy は直列。`toolCallConcurrency: 1` は固定済み（`agentModelPolicy.ts:30-34`†）。
- **〔PR-7a の実装。DR-MP4-37〕** 年表の cache（events・sceneEvents・codexNames の `SharedLoader` 3 つ）は、main では turn ごとの instance（`createMainChronicleReadContext`）。cache の port（`CoreToolCache`）は使わず、core は loader port を受ける（DR-MP4-37e）。cache の寿命を turn にし、batch 境界ごとの再読込をしない差は **Q5 の窓 (f)**（legacy は batch ごとに破棄するので turn 途中の変更が次の batch に届く）。同値試験の対象から外し、特性試験に期待を明記した。`clear()` の配線は 4c-1。

### DR-MP4-17 tool schema の bytes 一致と入力検証の同値（案）

- legacy の loop は tool 入力を検証しない。検査は「宣言した tool 名か」だけで、`tu.input` はそのまま executor に渡り、executor が緩く読む
  （`agentLoop.ts:315-316`、`toolExecutors.ts` の `String(params.x ?? "")` など、未再確認）。よって同値の基準は「Mastra が何も足さず何も除かない（無検証・無変形）」。
- probe の結果（scratchpad の一時 script。Node 24、自作の fake `LanguageModelV4`、adapter は通していない。合成 schema のみ。残らない）：
  - ai の `jsonSchema(...)` で包む（MP-2 の試験と同じ形）：検証は走らず、不正入力も null も無変形で execute に届く。機構は未確認。
  - 生の JSON Schema：Ajv で検証し、required 欠落・型違い・enum 違反・minimum 違反・文字列化 JSON の配列を拒否し、null の任意項目を除去する。
    検証失敗は throw でなく `{error:true,...}` の JSON が tool 結果になり、adapter は `isError:false` で model に返す（legacy の `Error: ` と食い違う）。
  - 自前の StandardSchema（`validate` は `{value}` を返すだけ、`jsonSchema` は原本）：無検証で、送る schema も原本と bytes 一致。
- 判断（案）：**自前の StandardSchema（検証なし）** を採る。legacy と同値で、拒否の新設も無い。ai の実行時 import を main に持ち込まない（DR-MP3-28）。
  生の JSON Schema を採ると検証の新設（拒否の増加）になるので、**採るなら C-10**（条件つき）。
- Mastra は送出時に schema を書き換える（`$schema`、`additionalProperties:false`）が、adapter が turn 開始 snapshot の原本へ名前で戻すので wire は原本のまま
  （`agentLanguageModel.ts:391-415`、未再確認）。名前が snapshot に無ければ throw する。
- 試験：実際の 44 本のうち M4 の 20 本に不正入力（欠落・型違い・null・文字列化 JSON・extra key）を流し、無変形で execute に届くことを固定する。版を上げると落ちる形にする。
  snapshot は「その turn で宣言する集合」から作る。Rust の wire parity fixture は現在 1〜2 tool（`mastra_wire_parity_tests.rs`、未再確認）なので、M4 の部分集合の fixture を足す。

### DR-MP4-18 tokenizer（技術判断。既存の budget を超えるときだけ確認）

- 事実：`countTokens` は renderer の `contextBuilder.ts` にあり、o200k_base の tiktoken（WASM）を Vite の `?url` と fetch で読む。未 init・失敗なら heuristic（`estimateTokens`）に**無言で**落ちる
  （`contextBuilder.ts:485-545`、`:2319-2354`、未再確認。`:511-516` の `import('tiktoken/lite/tiktoken_bg.wasm?url')` は Vite 専用で、main の bundle にはそのまま使えない）。
  loop は入口で `ensureTokenizer` を待って exact を保証する（`agentLoop.ts:160`、未再確認）。切詰めの位置と予算の到達判定は数え値で決まる。
- probe（plain Node 24、tiktoken の lite を `readFileSync` の bytes で init）：o200k で動く。init 約 163 ms。数え値（o200k 対 heuristic）は日本語 32 対 33、英語 31 対 45（約 45% 過大）、JSON 18 対 19。
  Electron main の値は未測定。
- 判断（技術判断。C-8(a)(c) から移した）：main でも **exact（o200k）** を使う。**heuristic に落とすのは閾値の黙示変更で委任外**。init が失敗したら **fail-closed**（事前検査で `unsupported` を返し、turn を始めず legacy へ落とす。3.3 節の P7。順序は「同期の refusal → init → `admissionRefusal` の再実行 → 登録」）。
  legacy は無言で heuristic に落ちるので、main の方が厳しい差になる。この差は意図的で、PR 本文に書く。
- wasm と ranks は renderer が既に同梱している（`src/features/chat/contextBuilder.ts:509-513`†。`tiktoken/lite/init`、`encoders/o200k_base.json`、`tiktoken_bg.wasm?url`）ので、**保存・送信の範囲の拡大ではなく**、main にも同じ bytes を持たせる配り方の選択（下の 3 案）。
  main が renderer の同梱 asset（hash 付きの名前・asar）を読めるかは未確認（K-7）。
- 置き場：tiktoken の自動 load は `__dirname` と祖先の `node_modules` から wasm を探す。bundle 後の `dist-electron/` には wasm が無く、packaged では `node_modules` が asar に載らない
  （`electron-builder.yml:14-21`、`beforeBuild.mjs`、未再確認）。`__dirname` 探索に頼らず、wasm と ranks を bundle の隣か中に持つ init 経路が要る。
- **bundle の置き先（3 案）**。現行の build は `platform: "node"`・`format: "cjs"` で、loader 指定が無く、external は `electron` と `*.node` だけ、出力は 3 本
  （`main.cjs`、`preload.cjs`、`mastra-agent.cjs`。`electron/scripts/build.mjs:28-36,55-72`†）。**動的 `import()` は同じ `main.cjs` の中の遅延評価になるだけで、wasm（約 1.07 MB）と ranks（約 2.3 MB）が `main.cjs` に入り、ファイルサイズと parse の対象が増える**。
  DR-MP3-29 は literal な `require` を esbuild が bundle してしまうので変数で隠している（`createRequire(変数)`）。
  - (a) `main.cjs` に入れる（遅延評価でも parse・サイズが増える。wasm の loader 設定が要る）。
  - (b) lazy な `mastra-agent.cjs` の側で動かし、`dbExecute` と `countTokens` を注入する。DR-MP3-28 の境界の改訂になる。
  - (c) **bundle の外の file**として `extraResources`／`asarUnpack` で配り、変数経由の `require` 相当で実行時に読む。`main.cjs` を増やさず起動に載らないが、**配布物の構成の変更**（既存の budget を超えるときだけ C-8）。
  - 選び方は **budget の測定の結果を先に取ってから**（metafile、`coldStartMs`、perf budget。build と Electron が必要。未実施）。大きさは測定済みの値だけを書く（`main.cjs`・`mastra-agent.cjs` の現在の大きさは未測定。以前の記載の 3.07 MB と 13.7 MB は根拠が無いので削除した）。
- **budget の停止条件**：既存の budget と ceiling（`perf:budget` の bundle 上限、`coldStartMs` など runtime-performance-budget、`schema.ts` の移動による renderer の起動 graph の ratchet）は**緩めない**。超えたら実装を止めてユーザーに確認する（C-8。条件つき）。
  新しい budget は**新設しない**（新設すると閾値の新設で、C-8(b)。新設しなければ確認は不要）。
- **main thread の占有**（lifecycle の未確認事項。K-16）：tool の実行（SQL 結果の写像、全 node の読む順の構築、`localeCompare`、`JSON.stringify`、`countTokens`）が Electron main の event loop に移る。
  入力は model が決める（prompt injection。T9）ので、巨大な `limit`・配列・大きい結果で main が長く塞がり、全 window の IPC と終了処理（D11、quit の期限）が止まりうる。
  Native 側には SQL の資源上限があるが、JS 側の処理には無い。legacy では renderer の負荷で済んでいた。tokenizer の init（約 163 ms）だけでなく、定常時の占有を 4b の spike で測る。
  対策案（結果の長さの先頭の cap、分割と yield、別 thread）が閾値の新設に当たるなら **C-16**（条件つき）。DR-MP4-17 の「無検証・無変形」とは別の層（入力の検証ではなく実行の分割）の対策として検討する。
- 確認が要るのは、既存の budget・ceiling を超えるとき、または新しい budget を置くとき（C-8。条件つき）だけ。
- 未確認：asar からの読込、Electron main での init 時間と event loop の塞がり、`encode()` が特殊 token 文字列で throw するか（legacy にもある可能性）。

### DR-MP4-19 engine 分岐（技術判断。範囲の読み替えの帰結は報告のみ。C-5）

- 差し替える範囲：MP-3 の DR-MP3-24 は「`sendToLLM` の送るだけを差し替える」としたが、これは tool 0 の前提。MP-4 では `runAgentLoop`（`chatTurnStoreActions.ts:1236-1350`）全体に及ぶ。
  `guardedExecuteTool` の配線（`ask_user`、`run_research`、`fullyInjectedIds` の短絡、assistant 行の確保）も同じ。
- 判定は **pure な関数**に切り出す。**Mastra に送る条件**はすべて満たすとき：
  1. provider が anthropic／openai／openrouter（parser の `provider` と一致）。
  2. `chatSessionId` が確定している。
  3. `turnProjectId` が `"default-project"` でない（DR-MP4-1）。
  4. 宣言する tool 集合が M4 に収まる。製品の agent-mode は 44 本なので **MP-4 の間は常に収まらない**（journey の seam だけ）。
  5. （renderer は profile を判定しない。）`profileClosed()` の 3 状態（restricted／unavailable／activating）は **main の admission の refusal（`restricted` ほか。`mastraTurnOwner.ts:551-583`†）に任せ**、refused は legacy に落ちる。renderer の側の profile の記憶は古くなりうるので条件にしない。
  6. この process で gate-closed を観測していない。
  7. 添付なし、hermes でない、public web search の経路でない（下記）。
  8. この renderer に pending の Mastra start が無い（DR-MP4-27）。
- **legacy に落とす条件**は上のどれかが外れたとき。現状の写像：provider 外は parser の `provider`（invalid）、sessionId 未確定は invalid、restricted は old-external-ai の `D2A_EGRESS_DENIED`（legacy の send も同じ lane なので legacy も拒否される）、
  tools 非空は parser の `tools`（invalid）、messages が「先頭 system 1 件＋user／assistant＋最後 user」でなければ owner の `unsupported`。
- **public web search の経路**（`tools=[]` の RAG。`publicWebSearchPath`）：Mastra へ送れる唯一の現行の形だが、private Agent と public RAG の分離（`agentPrivacy`）を Mastra 側でどう保つかが未設計。
  **当面 legacy に固定する**（技術判断）。
- hermes は Rust 側の独立実装で、adapter が `resolvedToolProtocol: 'hermes'` の turn を扱えるか未確認。添付は agent の message 型が text だけで、他の入口は未調査。どちらも**当面 legacy**（K-9）。
- **policy の分岐の位置**：renderer の engine 分岐は `blockIfPolicyOff("chat")`（turn 開始の AI policy 検査）の**後ろ**に残す。Mastra の分岐に入る前に legacy と同じ位置で検査が通る。turn 中の policy の変化の観測は DR-MP4-26。
- 旗 L が閉の間の保証（性質）：
  - gate-closed の typed refusal を受けたら module 内に記憶し、その process の間は start を呼ばない（gate は launch 固定）。閉の間の追加の呼出しは最大 1 回で、宛先は変わらない。
  - start を呼ぶ前の準備（request の組立、検査）の例外は legacy へ進む。start が admit された後の rejection は legacy に**再送しない**（二重送信防止）。wrapper は「refused は値、それ以外は rethrow」で区別している（`src/lib/mastraAgentTurn.ts:46-58`、未再確認）。
  - 閉の間の request は最大 8M 字が IPC で main に clone されるが、宛先は変わらない。start・cancel は send と同じ mutation の lane。
- 製品の呼び手は現状 0（`startMastraAgentTurn` の呼び手は wrapper と test だけ。未再確認）。legacy の呼出し順の特性が変わらないことを、gate-closed の mock の下で固定する。

### DR-MP4-20 tools の wire・結果と進捗の wire（確認要 Q4）

- tools：MP-3 の wire は「常に空配列」。MP-4 で main が tool を持つなら、名前の list（定義は main が持つ）か、定義ごと運ぶか、別の欄か。
  **推奨は名前の list だけ**（Q4）。定義は main が持つ（出所は DR-MP4-30）。定義ごと運ぶと、renderer が書いた説明文・schema が model に届く。main は**実行時に wire の名前を M4 の凍結集合と照合**し、集合に無い名前は `unsupported` で拒否する
  （静的試験で凍結するだけでなく、実行時の照合も試験で固定する。DR-MP4-21 の 3）。
  DR-MP3-24 は「tools 非空は `unsupported`」と書くが、実装は parser の issue `tools` で invalid（`mastraAgentTurnWire.ts:533-542`、`mastraAgentTurnGate.test.ts:599-614`、未再確認）。文書と実装を 4a で揃える。renderer はどちらでも legacy に落ちる。
- 結果：MP-3 の start 結果は `{status:'completed', turnId, executionId, response}`（1 回分の生の応答）。renderer は `toolCallRecords`、`stoppedReason`（「続行」を出す条件）、累計 usage、`tokensIn`／`tokensOut`、`cost`、`citations`、`finalThinkingBlocks`、進捗（`onProgress`、`onToolComplete`、`onTextChunk`）で metadata と永続化を組む。
  運ぶ口が無い。Mastra の usage は legacy の素の合計と別の値なので、応答の観測 tap で素の応答から legacy と同じ式で合計する。結果の組立表は DR-MP4-12。
- **send ごとの renderer の副作用**（DR-MP4-25）：legacy は send の前後で `retirePriorCapture`、`cancelBeforeTransport`、`notifyAccepted`（`_onAccepted`）、`agent-running` への遷移、`contextTokenCount`／`contextWindowUsage` の更新、入力 token の drift の集計を行う
  （`chatTurnStoreActions.ts:1226-1262`†、`:1305`）。進捗の wire はこれらの運び先も含める。
- **どちらも承認済みの 3 欄の外で、新しい契約**。形は **Q4** の回答後に決める（回答 2：4c-1 の wire 一式として 1 回にまとめて伺う）。それまで 4c-1 の wire は確定しない。

### DR-MP4-21 chat IR を閉じたままにする（決定 3）

- 決定：U-4(f) は IR を開ける lane へ延期。MP-4 でも IR は閉のまま。
- 現状：`chatAgentIr.test.ts:162`† は router が Native の gate を開けないこと、`:193`† は electron・src・packages の非 test の source に `chat-agent-ir` の文字列が無いことを固定する。
  ただし走査は **`"chat-agent-ir"`（ハイフン形）だけ**で、snake_case の command 名（`chat_agent_ir_select`）や動的 key は検出しない（`:178-198`†）。
  `chatAgentIrClosure.test.ts` は `CHAT_AGENT_IR_ENABLED` が `false as const` で 1 回だけ宣言されること等を固定する。
  IR の閉鎖は 3 層（Native の gate、router の `chatAgentIrGateRefusal`〔`ipc.ts:2245`†〕、旗）で、`NAPI_COMMANDS.chat_agent_ir_select.run` 自体は gate を持たない（`ipcContract.ts:9994-10003`†）。
  現状は Native 側の gate が最後に拒否するので未悪用。
- 追加する静的試験（拡張。決定 3「main に IR を呼ぶ executor が無い」を固定する根拠を、名前の不在だけに置かない）：
  1. main の tool 群の module と core が `chatAgentIrSelect`、`chat_agent_ir_select`、`searchEventsWithIr`、`selectChatAgentIr`、`src/lib/chatIr`、**`chatAgentIrAvailability`、`chatAgentIrWire`、`chatIrToolResult`、`@/lib/chatIr`** を import・参照しない。
     `chat_agent_ir_select`／`chatAgentIrSelect` を含む文字列が main の read port と core に無い。
  2. `search_events` の説明文に chronicleIr の読み方（`SEARCH_EVENTS_IR_DESCRIPTION`）を載せない。main の tool 定義は `CHAT_AGENT_IR_ENABLED` の分岐を使わず、子と同じ `SEARCH_EVENTS_DESCRIPTION` を無条件に使う（IR 閉の間は親と子の文字列は同一で bytes は変わらない。`toolDefinitions.ts:65-69`、`:963-975`、未再確認）。
     core には IR 無しの形だけを置く（`CHAT_AGENT_IR_ENABLED` の分岐を持たない。DR-MP4-3）。
  3. main の executor の許可集合は凍結済み（M4）で、write・`ask_user`・`run_research`・ui を含まない。**実行時にも wire の名前を許可集合と照合する**（DR-MP4-20）。
  4. core が参照してよい**表の allowlist**（read の 18＋2 本が実際に使う表）を固定し、外の表は失敗にする。denylist（`chat_agent_ir*`、`narrative_*`、`nir1_*`）では、unrestricted の generic SQL が読める他の表（`ai_audit`、設定、他の chat 履歴など）が将来 core に混ざっても検出されない。
  5. main の read port と core が `NAPI_COMMANDS` を**動的 key で参照しない**（literal key の 4 本だけ。DR-MP4-6）。
  6. main の tool の定義 module（DR-MP4-30）が `toolDefinitions.ts`（`chatAgentIrAvailability`・`chatAgentIrWire` を import する。`:1-12`†）を import しない。IR を含まない共有の定義 module だけを参照する。
- 既存の `chatAgentIr.test.ts:162`、`:193` の形（`includes("chat-agent-ir")` の走査）は、新しい main の module にも自動で掛かる。拡張はこの形に倣い、上の 1・5 は snake_case と動的 key も見る。
- 代案：main に IR の executor を置き実行時の旗で閉じる：旗の誤開放が 1 点の失敗になる。決定 3（延期）にも反する。退けた。
  説明文を旗で分岐する（legacy の形）：main に IR の約束が入る。退けた。

### DR-MP4-22 `run_research`（技術判断）

- DR-MP3-3 どおり MP-4 では移さない。main の tool 集合（M4）に含めない。
- renderer は毎 turn 44 本を宣言するので、「使う turn を legacy に落とす」は宣言集合では判定できない（DR-MP4-19）。MP-4 の間は旗 L が閉で、Mastra に届くのは journey だけ。
- 旗 L を開ける（MP-13）までに、全 tool の扱いを決める。子の tool 集合は `get_ui_state` と help 2 本を含む。将来移すなら、子 loop の予算の導出（親/2、`max(3, …)`、下限 2,000、1 turn に 4 回まで）と audit の `agent_research_subagent` を rules module のパラメータにする（U-4(e)、MP-6 の決定待ち）。
- 代案：MP-4 で子 loop も移す：DR-MP3-3（移さない）に反し、子の tool 集合（`get_ui_state`・help 2 本を含む）が RPC を要る。退けた。

### DR-MP4-23 audit の `chatMessageId`（技術判断）

- legacy でも audit の**行には載らない**。載るのは send の `args` だけ（`chatApi.ts:195`、`:213`、`transportContext.ts:123-215`、未再確認）。用途は capability の発行（`ipc.ts:1572-1599`、未再確認）と書込み tool の provenance。
- owner は `dispatchInvoke` を通らず `backend.sendAgentMessage` を直接呼ぶので、capability の発行は起きない（DR-MP3-5）。
- 判断：3 欄目で sink の handle に `chatMessageId` を持たせ、send の `args` を legacy と同形にする（行の内容は変わらない）。sink の既存 test「`chatMessageId` が request snapshot に入らない」は保つ（`agentAuditSink.test.ts:223-238`、未再確認）。
- MP-6 で capability を main が発行するとき、`chatMessageId` が renderer の自己申告であること（legacy も同じ）を脅威モデルに書く。
- 代案：audit の行にも `chatMessageId` を載せる：legacy の行と形が一致しなくなる。退けた。args にも載せない：legacy の args と差が出て MP-6 の準備にならない。退けた。
- legacy の `chatMessageId` は turn 内で一定である。`assistantMsg` が turn に 1 つで、`chatTurnStoreActions.ts:1188`† と `:1277`† が同じ `assistantMsg.id` を使う。3 欄の「turn 内の整合」の定義（DR-MP4-1）はこの前提に立つ（解消済み）。

### DR-MP4-24 `get_foreshadow_detail` の secret（技術判断。C-11 は別 issue へ）

- `list_open_foreshadows` は `secret=0` で落とすが、`get_foreshadow_detail` は secret の判定が無い（`foreshadow.rs:1644-1651`、`toolExecutors.ts:1533-1628` の grep、未再確認）。非対称。
- MP-4 は同値で写し、**変えない**。PUB-G の方針（hidden と年表 secret は守る）に照らした意図の確認は、MP-4 の確認から外し、**別 issue として親が起票する**（改訂 2。委任の再分類）。挙動の変更は別 lane。
  **既知の非対称が main の新しい経路にも写る**ことを 4b の PR 本文に明記する。**旗 L を開ける前（MP-13）に、その issue の状態を確かめる**（改訂 1 のレビューが ADR 013 を理由に足した条件を、確認ではなく「確かめる」点として残す。issue の解決は条件にしない）。
- 代案：MP-4 で secret を落とす：利用者に見える挙動の変更で、同値の基準に反する。退けた。

### DR-MP4-25 step ごとの payload 確定（確認要 Q4。置き場は begin の前）

- legacy は send ごとに `finalizeChatTurnPayload` を呼ぶ（`chatTurnStoreActions.ts:1226-1262`†）。会話が伸びるたびに、(a) 予算超過で `ContextWindowExceededError` を throw する（`finalizeTurnPayload.ts:373`†）、
  (b) 超過時に cache の配信を plain へ降格する（`cacheDowngradeReason = 'budget'`。`:334`†）、(c) Ollama の窓不足の throw（指摘による。未再確認）。
  send の前後で renderer が `retirePriorCapture`、`cancelBeforeTransport`、`notifyAccepted`、`agent-running` への遷移、`contextTokenCount`／`contextWindowUsage` の更新、入力 token の drift の集計を行う。
  **legacy では finalize が send の前（`chatTurnStoreActions.ts:1232-1243`†）で、audit の begin は `chatApi.sendAgentMessage` の中（`src/features/chat/chatApi.ts:163-216`†）なので、窓超過の throw では audit の行が残らない**。
- Mastra 経路：start request の `systemCacheSegments`／`systemVolatileTail` は全 step で同じ値を送り続け、窓・出力予約・fallback の system の欄は wire に無い（`mastraAgentTurnWire.ts:153-196`、route の key に `contextWindow` も出力の予約も無い）。
  このままでは、25 step・大きい tool 結果の turn で、legacy は型付きの窓超過エラーで止まるが、Mastra は窓超過の request をそのまま送る（降格も無い）。
- **置き場（P1-1。DR-MP4-28）**：この確定（cache の降格・窓超過の throw）は、**send の位置ではなく audit の begin の前**で行う。adapter の順序は begin → dispatched → send（`agentLanguageModel.ts:841-859`†）なので、
  send の位置で降格すると `request.prepared` が降格前の request のまま残り、窓超過を throw すると「dispatched なのに送っていない」行が残って legacy（行なし）と変わる。
  begin の前に throw すれば行は残らず、legacy と同形になる。
- 選択肢（どちらも委任の外。技術判断では決めない）：
  - (i) 窓・出力予約・fallback の system などの欄を wire に足し、main の begin の前の注入点で同じ確定（検査と降格）を行う。新しい契約で、窓と予約の取り扱いが閾値に関わる。共有 module の `finalizeTurnPayload` と tokenizer が main で要る。
  - (ii) この検査と降格が無いことを受容する。tokenizer を heuristic に落とすのと同じ種類の黙示変更に当たるので、黙って決めない。
  - 推奨は (i)（Q4 の一括に含める）。renderer の send ごとの副作用の運び先は進捗の wire（DR-MP4-20）に含める。K-18（MP-3 の start が 1 step の副作用をどう扱ったか）を 4c-1 の最初の実測に入れる。

### DR-MP4-26 authority の失効の観測（技術判断＋確認要 Q5）

legacy の `shouldAbortTurn`（`chatTurnStoreActions.ts:490-498`†、条件は `:423-447`†）の全条件と、Mastra 経路での扱い。main の `assertLive` は forced・user-stop・`profileClosed()`・sender 破棄・identity の 5 条件（`mastraTurnOwner.ts:368-390`†）。

| 条件（legacy） | main が観測できるか | 守り方 |
|---|---|---|
| `sendControl.aborted`、`isCurrentTurn` | user-stop は観測できる（`assertLive`†） | 既存の cancel の契約 |
| quiescence の mutation 不可（`canScheduleQuiescenceMutation`。`quiescenceLease.ts:451-466`†） | **観測できない**。renderer の lease は main に届かず、main の forced は renderer の drain の**後**（`ipc.ts:2445-2451`†）で、drain は start の終了を待つ（`ipcQueue.ts:353-388`†）。以前の「forced で観測するはず」は誤り | renderer が lease の通知で cancel（既存の契約。DR-MP4-29） |
| workspace の切替 | 観測できる（identity。`assertLive`†）。ただし切替の通知は上の理由で遅れる | main（既存）。renderer の lease 通知 cancel で早める |
| project の切替 | **観測できない** | renderer の watcher が cancel |
| chat authority（session、chatScope、scopeAnchorId、thread focus、temporal anchor、preflight authority、route の authority key＝model・endpoint の変更） | **観測できない** | renderer の watcher が cancel |
| **AI policy の chat トグル**（`isAiFeatureBlockedByPolicy("chat")`。作者が AI を切る） | **観測できない**（legacy は `useProjectStore` を見る。`policyGuard.ts:28-35`†）。main は `projects.ai_policy` を DB から読める | **send の直前に main が DB を object の行として読み、chat が切られていれば begin の前に中断する**（技術判断。防御の追加。下記）＋ watcher |
| **ライセンス制限**（`isWriteRestrictedByLicense`） | **観測できない**（main が license の状態を持つかは未確認） | renderer の watcher |

- **watcher**：renderer が上記の条件の変化を購読し、`shouldAbortTurn` が真になったら `cancelMastraAgentTurn` を呼ぶ（既存の cancel の契約。新しい契約は無い）。購読の試験を 4c-2 に入れる。
  cancel は DR-MP4-27 のとおり start と同じ lane で、pending の start を 1 本に保つので通る。
- **policy の読み（技術判断。C-15(a) から移した）**：新しい authority ではなく、main が自分の送信（egress）の直前に作者の設定を確かめる**防御の追加**。
  読み方は `parseAiPolicy` と同じ欠損の扱い（NULL・未設定は full）を共有 module で揃え、`policyAllowsAgentTool` の読み方に依存しない（その読み方は #989 で直っており、今は object の行を読み、読めない形の行では発行しない〔fail closed〕。`ipc.ts:1044-1090`。2026-11-22 に確認）。
  読みは DR-MP4-4 の db adapter（SELECT のみ、object の行）で行い、DR-MP4-5 の規則（開始の直前と await の後の `assertLive`）に従う。永続の窓（store から DB への反映の遅れ）は K-17。
- **残る窓（Q5）**：状態の変化から cancel が main に届くまで、policy の store から DB への永続の窓、license（main が観測できず watcher だけ）、project・chat authority（watcher だけ）。
  legacy より弱い点として Q5 でユーザーに確認し、回答どおり脅威モデルに書く（4c-2）。
  renderer の engine 分岐は `blockIfPolicyOff("chat")` の後ろに残る（DR-MP4-19）。
- 場面の切替も、この watcher で cancel する案を Q5 の緩和に含めた（切替後の固定による開示のずれを避ける）。

### DR-MP4-27 cancel の lane（技術判断。C-14 から移した。MP-3 の申し送りの回収）

- MP-3 の wrapper は「start は turn が終わるまで settle せず、cancel と同じ mutation の lane で 4 本ずつ走る。MP-4 は pending start を 4 未満に保つか、cancel に lane を与える」と明記している
  （`src/lib/mastraAgentTurn.ts:12-17`†）。lane の全体の slot は 4 で（`MAX_CONCURRENT`。`ipcQueue.ts:19`†）、start は turn の間 mutation の 1 slot を占有する。
  同時に数本の start が走ると、cancel と他の mutation（保存など）が通らなくなる。
- **技術判断：(ii) renderer が pending の Mastra start を 1 本に保つ**（engine 分岐の条件 8。DR-MP4-19）。start が 1 本なら、4 本の start が全 slot を占める最悪（cancel が一切通らない）は避けられる。
  **ただし start は turn の間 1 slot を握り続け、read／derived は最大 3 slot まで取れる（`pumpQueue`。`ipcQueue.ts:19-24`†、`:143-150`†）ので、background が 3 本走っている間は cancel と他の mutation は slot 待ちになる**
  （background の slot は caller の timeout では解放されず、settle まで残る。`:98-103`†）。最悪の待ちは background の settle まで。**この待ちの長さは未測定**（K-24）。
  main の sender あたり 4・全体 8 の上限（`mastraTurnOwner.ts:72-74`†）は防御として残す。legacy の chat turn が renderer で同時に 1 本かは未確認（K-20）。
  cancel に別の lane を与える (i) は新しい契約（または command class の変更）なので採らない。
- **audit export 中の cancel（拒否される）**：export の mutation barrier（`sealMutationAdmissionForControlledRead` は audit-export の lease だけが立てる。`quiescenceLease.ts:345-350`†。`ipcQueue.ts:193-195`† で mutation を拒否）が封じるのは、
  export が AI の実行中でないと確かめた**後**（`exportBoundary.ts:185-205`† の `refuseWhileAiRunning` が、lease の前・lease の後・drain の後・strict flush の後に 4 回、seal の前に見る）。
  Mastra の turn を registry に登録すれば（DR-MP4-31）、turn の実行中は export が断られるので、「barrier 中に Stop が効かない」状況は起きない。専用の例外は要らない。
- workspace 切替などの lease では mutation barrier は立たない（上の条件）ので cancel は通る（lease 中に他のゲートで拒否されないかは K-22）。
- DR-MP4-26 の watcher の強さはこの決定に依存する。

### DR-MP4-28 begin の前の注入点（P1-1。DR-MP3-28 の境界の改訂の記録）

- 事実：adapter の model 呼出し（`agentLanguageModel.ts:835-905`† の 1 か所を確認。`doGenerate`／`doStream` の両方に当てはまるかは K-25）の順序は、`restoreTools` → `buildAuditRequest` → `audit.begin` → `buildWireArgs` → `audit.dispatched` → `options.send`（`agentLanguageModel.ts:839-859`†）。
  sink の `request.prepared` は begin の入力（messages・`systemCacheSegments`・`systemVolatileTail`・options・tools。`agentAuditSink.ts:136-197`†）から作る。
  send の失敗は `audit.fail` で閉じる（`:861-877`†）。begin 自体も `assertLive` を通る（`mastraTurnOwner.ts:399-401`†）。
- 帰結：send の位置（`options.send`）で messages を足す・cache を降格する・窓超過で throw すると、(1) audit に載らない message が wire に載る／`request.prepared` が実際の送信とずれる、
  (2) 窓超過の throw は `dispatched` の後なので「dispatched なのに送っていない」行が残る。legacy の finalize は begin の前（DR-MP4-25）で、行は残らない。
- **判断（技術判断）**：request の変形と拒否（制御 message の挿入、cache の降格、窓超過の throw、上限判定）は**すべて audit の begin の前**で行う。候補は 2 つ：
  - **案 A（推奨）**：adapter に、begin の前に呼ぶ注入点（injected の pure な closure。入力は parse 済みの messages と route の options、出力は変形後の値か throw）を足す。adapter は loop 規則を持たず closure を呼ぶだけ。
    DR-MP3-28 は「runtime に入れるのは Agent・adapter・方針だけ」としており、adapter の境界の改訂になるので、**この項を改訂の記録とし、4c-1 の PR 本文に載せる**。closure は main 側の rules module から runTurn の引数で渡す（bundle に closure を入れない）。
  - 案 B：Mastra の `prepareStep` で messageList と providerOptions を変形する。adapter は変えないが、messageList の順序と、`systemCacheSegments`（route の providerOptions）を `prepareStep` から変えられるかが未実測（K-1）。
  - 応答の観測（回数・usage・text の集計と進捗）は send の戻りの後でよい（audit に影響しない）。観測 tap は request を変えない。
- 試験（4c-1）：(1) **`request.prepared` の messages・`systemCacheSegments` が wire の args と bytes で一致**（制御 message あり・cache 降格ありの両方）、(2) begin の前の throw では audit の行が残らない、
  (3) `dispatched` の後に request を変えるコードが無い（静的試験：send の closure は args を変更しない）。
- 代案：send の位置で変形し、sink の snapshot を後から更新する：begin の行は書かれた後で、audit は追記型なので書き換えられない。退けた。

### DR-MP4-29 workspace 切替・quiesce と turn の owner／lifecycle（P1-2）

- **事実（改訂 1 の「未確認（forced で観測するはず）」は誤りだった。直す）**：
  - renderer の workspace 切替は、まず lease を取り（`acquireQuiescenceLease`。通知は `notifyLeaseStateChanged`。`quiescenceLease.ts:253-314`†）、strict quiescence の各段を順に flush する。最後の段 `ipc-actual-tasks` の flush は
    `awaitPendingIpcActualTasks`（`ipcQueue.ts:353-388`†、登録は `:437-441`†）で、**mutation の actual task の終了を期限なしで待つ**。Mastra の start は turn が終わるまで settle しない mutation（`mastraAgentTurn.ts:12-17`†）なので、**turn の終わりまで切替が待たされる**。
  - main の forced（`quiesceForWorkspaceSwitch`）は `open_workspace` の handler の先頭（`ipc.ts:2445-2451`†）で、**renderer の drain の後**。drain が終わる前に main は切替を知らない。
  - legacy の loop は境界ごとに `shouldAbortTurn`（`canScheduleQuiescenceMutation`）で abort するので、drain は高々 1 send を待つ。複数 step で数分続く Mastra の turn は、何もしなければ legacy より大幅に長く待たせる。
  - cancel は mutation で、`ipcQueue.ts:193-195`† の barrier が立つのは audit-export の lease だけ（`quiescenceLease.ts:345-350`†）。workspace 切替などの lease では cancel は拒否されない（lease 中の他のゲートは K-22）。
  - P2-1 のとおり registry に turn を登録すると、`ai-executions` 段の `awaitPendingAiAuditExecutions`（`executionRegistry.ts:117-132`†）も turn の終わりまで待つ（DR-MP4-31）。
- **owner／lifecycle の表**：

  | 経路 | owner | 現状と問題 |
  |---|---|---|
  | start | renderer の wrapper（mutation の 1 slot を turn の間占有） | settle は turn の終わり。timeout なし |
  | cancel | renderer の wrapper（同じ lane） | audit-export の barrier でだけ拒否される |
  | renderer の lease（切替・project 読込・close） | quiescence coordinator | 通知は `subscribeQuiescenceLease`（`:499-503`†）。drain が start を待つ |
  | main の forced | owner（`quiesceForWorkspaceSwitch`） | drain の後。上限は `MASTRA_TURN_FORCED_BOUND_MS`＝30,000 |
  | main の quit | owner（quit finalizer） | `MASTRA_TURN_QUIT_BOUND_MS`＝5,000（暫定。`mastraTurnOwner.ts:68-71`†） |
  | registry（`ai-executions` 段、audit export） | renderer の executionRegistry | Mastra の turn を数えない（DR-MP4-31） |

- **選択肢**：
  - **(a) 推奨：renderer が lease の取得の通知で Mastra の turn を cancel する**。DR-MP4-26 の watcher と同じ仕組み（既存の cancel の契約。新しい契約は無い）で、`quiescence の mutation 不可` を購読する。
    cancel は次の send の前の `assertLive` で効き、進行中の Native の send は止まらない（`ipc.ts:2448-2449`† のコメント）ので、drain は高々 1 send を待つ（**ただし cancel が mutation の slot を得られる前提**。background の read／derived が 3 slot を握っていると settle まで待つ。K-24）。quiescence の不変条件は変えない。
    通知は lease の最初の取得時（`quiescenceLease.ts:312-315`）だけなので、**start の時点で lease が active なら engine 分岐は start しない**（legacy の `canScheduleQuiescenceMutation` と同じ入口。K-22）。
  - (b) start を drain の対象から外し、main の quiesce を先に行う：`awaitPendingIpcActualTasks` の対象の変更で、**quiescence の不変条件の変更**。決定の記録が要り、W の行が動くならユーザー確認（**C-17**）。
  - (c) start を即返し、結果を event で運ぶ：start の意味（MP-3 は「turn が終わるまで settle」）と wire の変更。契約変更が 3 回目になる（回答 2 の 2 回を超える）。quiescence は変わらないが採らない。
  - **推奨は (a)**。(b)(c) は (a) が成り立たないと分かったとき（lease の通知の同期性、cancel の到達が期限内に保てない）だけの代案で、採るなら C-17。
- 試験（4c-2）：lease の取得で cancel が呼ばれる、drain が高々 1 send で終わる、start の時点で lease が active なら start しない、watcher の購読が turn の終端で解除される。

### DR-MP4-30 tool の定義の出所と、renderer の snapshot との一致（P2-3）

- tools の wire を名前だけにするなら（Q4 の推奨）、main が定義（name・description・schema）を持つ。`src/features/chat/agent/toolDefinitions.ts` は `chatAgentIrAvailability`（`CHAT_AGENT_IR_ENABLED`）と
  `chatAgentIrWire` を import する（`:1-12`†）ので、main から import すると DR-MP4-21 の静的試験（IR を import しない）と衝突する。
- 判断（案。4b）：**IR を含まない共有の定義 module**（置き場は core と同じ。DR-MP4-3）に、M4 の 20 本の定義と並べ順の関数（`getDeterministicAgentTools` の name 順と `sortSchemaKeys`。`toolDefinitions.ts:920-946`†）を置く。
  renderer の `toolDefinitions.ts` はそこから import し、IR の部分（`SEARCH_EVENTS_IR_DESCRIPTION` と IR の定数）だけを足す。main は `toolDefinitions.ts` を import しない。
- **drift 試験**（4b と 4c-1）：renderer の snapshot（`getDeterministicAgentTools`。session の snapshot は `chatTurnPreflight.ts:364-370`†）の M4 の部分と、main が組む定義を、`JSON.stringify` の **bytes で比べる**。
  `getDeterministicAgentTools` は `localeCompare` で並べる（`toolDefinitions.ts:933-942`†）。名前は ASCII の snake_case なので Chromium と Node の ICU で同じと見込むが未確認（K-4 と同種）。並びも試験で固定する。
- 古い session の snapshot（`sessionAgentToolsSnapshot` は session の間固定）と main の現行の定義が違う場合：main は名前だけを受け、現行の定義を使う。legacy は session の snapshot を使う。差が出うる（K-23）。受容するかは差が出ると分かった時点で報告する。
- 影響マトリクスの行：P28。

### DR-MP4-31 audit export と Mastra の turn（P2-1）

- 事実：audit export の「AI の実行中なら断る」（DR-AAEX-1）は、`runAiAuditExportBoundary` の `refuseWhileAiRunning`（`exportBoundary.ts:185-205`†）が `hasRunningAiAuditExecutions()`（`executionRegistry.ts:92-99`†）を見る。
  registry は renderer が begin した execution（`reservePendingAiAuditExecution`。`executionRegistry.ts:33-45`†）だけを数え、**Mastra の turn は数えない**（`src/lib/mastraAgentTurn.ts` は registry を参照しない。grep で確認）。
  よって export が turn の途中で通り、barrier を封じた後の drain が turn を待ち、cancel が拒否される。**MP-3c の wrapper から存在する欠落**（製品の呼び手は無く、到達は journey の seam だけ）として記録する。
- 技術判断（新しい契約なし）：renderer の engine 分岐が、start の間 registry に予約・完了を登録する。
  - 鍵は renderer が start の前に知る値（**`turnId`**）。main の `executionId` は step ごとに複数で、完了まで分からない。予約は start の呼出しの前に同期で（`:33-45` の重複 throw を避けるため、turn ごとに新しい `turnId`）。
  - 完了は finally で、`completePendingAiAuditExecution`（成功・失敗とも）か `abandonPendingAiAuditExecution`（refused・start の前の失敗）。解除の漏れは quiescence の `ai-executions` 段と export を永久に塞ぐので、試験で全経路を固定する。
  - 効果：export は turn の実行中は「AI の実行中」で断る。`ai-executions` 段（`executionRegistry.ts:117-132`†）は turn の終わりまで待つが、DR-MP4-29 (a) の cancel が先に出る。
- 置き場は 4c-2（engine 分岐。wrapper は「状態を持たず再試行しない」ままにする）。
- 旧 C-14 の「audit export 中の cancel」はこれで足りる（DR-MP4-27）。

### DR-MP4-32 read core の骨格と B1・B2 の 7 本（MP-4b PR-4。技術判断。2026-11-22）

core の骨格と、B1（`list_codex_tags`・`list_chapters`・`get_chapter_summaries`・`get_scene_timeline_neighbors`）・B2（`list_plot_threads`・`get_thread_scenes`・`get_scene`）を core 経由にする PR-4 の、mutation の前の判断。
DR-MP4-3（置き場 A、ports）・DR-MP4-3 追補・DR-MP4-4 追補の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。tool の定義・schema・結果は 1 byte も変えない（PR-0 の golden が不変であることで示す）。main はまだ core を呼ばない（旗 L は閉）。

1. **DR-MP4-32a 置き場と構成。** core は `electron/shared/readDomain/core/`：`readExecutors.ts`（`createReadExecutors(ctx)`、`CORE_READ_TOOL_NAMES`。凍結した表を返す）、`treeReadTools.ts`（`list_chapters`・`get_chapter_summaries`・`get_scene_timeline_neighbors`・`get_scene`）、`codexTagTools.ts`（`list_codex_tags`）、`plotThreadTools.ts`（`list_plot_threads`・`get_thread_scenes`。`phaseRank`・`normalizePhase`・定数も core へ）、`readContext.ts`（`requireCoreProjectId`）、`toolResult.ts`（`CoreToolResult`）、`sceneBody.ts`（main 用の barrier なしの本文 reader）、`readDb.ts`（`createCoreReadDb`）。ports の型は `electron/shared/mastraRead/ports.ts` のまま。**コピーは残さない**：7 本の本体は `toolExecutors.ts` から消し（約 680 行）、`READ_ONLY_EXECUTORS` の 7 項目は core を呼ぶ薄い executor にした。
2. **DR-MP4-32b ports の改訂。** (i) `getDb()` は raw の statement client（`CoreReadDbClient`）でなく **Drizzle の query builder**（`CoreReadDb` = `SqliteRemoteDatabase<typeof schema>`）を返す。理由：既存の試験（`toolExecutors.test`・`toolExecutors.codexHidden.test`）は `@/db/client` の `db` を chain の mock に差し替えており、core が raw の client から自分で `drizzle()` を作ると、この seam を通らない。renderer は自分の `db` を、main は `createCoreReadDb(createMainReadDb(...))` を渡す（`CoreReadDbClient` は main の adapter の型として残す）。(ii) 本文の port に **`readSceneBodies(ids)`** を足した：`get_thread_scenes` は `loadSceneContents` の一括読み（500 件ごとの `inArray`。barrier は全 id を先に待つ）と、その失敗を握る `.catch(() => new Map())`（握るのは legacy の port の側。(v) 参照）を使うため、1 本の `readSceneBody` では SQL も失敗の扱いも保てない。(iii) B1・B2 が読むのは db・tree の state（project）・本文・`countTokens` だけなので、ctx は `CoreReadContext`（`CoreReadPorts` のその 4 つの Pick）にした。logger・UI 言語・phase・native・cache は、それを読む tool を移す PR が足す（誰も読まない port を renderer に作らせない）。(iv) `CoreSceneTimeIndex` は `SceneTimeIndex` の型 alias にした（DR-MP4-3j(f) の完了。`ports.test.ts` で `toEqualTypeOf`、`TreeNodeData` が `CoreTreeNode` に代入できることも型で固定）。(v) **本文の一括読みの失敗を握るのは legacy の port で、core は握らない（レビュー指摘 P2-2 で修正）。** 初版は core の `get_thread_scenes` が `readSceneBodies(...).catch(() => new Map())` で握っていたが、共有 core にあると main の port の拒否（送信前の検査の `MainReadError`・caller timeout・marker の拒否）まで空の excerpt の成功に化ける。握る処理は `LEGACY_READ_CONTEXT.body.readSceneBodies`（`loadSceneContents(...).catch(() => new Map())`。移す前と同じ式）に移し、core は port の error をそのまま伝える。legacy の結果は不変（golden が無変更で通る。legacy の port が握ることは `toolExecutors.legacyGolden.test.ts` の 1 件で固定）。**PR-8 への制約：main の port を繋ぐとき、一括読みの失敗を握るか（空の excerpt の成功にするか tool の失敗にするか）は main の port が決める。既定は握らない（拒否と caller timeout を成功に化けさせない）。握るなら DR に理由を書く。**
3. **DR-MP4-32c project と引数検査の順序。** core の各 tool は、引数を検査し（`No id provided` など。空の引数は project より先に答える）、次に `requireCoreProjectId(ctx)` で project を **最初の await の前に 1 回だけ**取り（getter の形。以降の query は同じ値を使う）、それから読む。空・空白だけ・非 string は `CoreProjectRequiredError`（`assertCoreProjectId` が投げる class。message は従来のまま）。renderer の薄い層（`toolExecutors.ts` の `coreReadExecutor`）がこの error を捕まえて従来の `No active project`（content は tool ごとの空値。`list_*` は `[]`、`get_scene`・`get_thread_scenes` は `null`、neighbors は `{previous, next, currentSceneStoryTimeLabel}`。毎回新しく作る）を返す。順序（引数の検査が project の検査より先）は core 内の並びで保たれ、golden に case がある。**差（実在しない状態）**：空白だけの projectId は、legacy は `!projectId` を通って検索し（0 行）、core は throw して `No active project` を返す。id は UUID なので到達しない。
4. **DR-MP4-32d legacy の ctx。** `LEGACY_READ_CONTEXT` は live の getter：`getDb: () => db`、`getTreeState: () => useTreeStore.getState()`（store の値をそのまま。nodes を加工しない）、`countTokens: (t) => countTokens(t)`、本文は renderer の `loadSceneContent(s)`（未着の書込みを待つ。`barrier: "pending-writes-awaited"`）。import の束縛は arrow の中で読むので、試験の `vi.mock`（`@/db/client`、`@/features/tree/api` の部分 mock、`useTreeStore` の差し替え）が今までどおり効く。`createReadExecutors` は作る時点で port を何も読まない（試験で固定）。**本文 2 本の barrier は、legacy は今の barrier を保ち、main 用の reader（`createDbSceneBodyReader`）は `barrier: "none"`**（DR-MP4-9。同値試験の対象は「待つべき書込みが無い」ときだけ）。
5. **DR-MP4-32e 表の allowlist を core が触る 6 表に固定し直した（21 → 6）。** `tree_nodes`・`codex_tags`・`codex_entry_tags`・`plot_threads`・`plot_thread_scene_links`・`plot_thread_branches`。`core.static.test.ts` が core の Drizzle の `from`・join を走査し、**`MAIN_READ_TABLES` と一致すること**を固定する（足りなくても余っても落ちる）。後続の PR が tool を移して表が増えるときは、`tables.ts`・`tables.test.ts`・この試験の差分として見える。決定が要る残り：**`withDetails` の経路（`codexHiddenFromAi` が `detailApi`・`phaseApi` を import する）を core に含めるかは PR-5 の前に決める**（7 本は `codexHiddenFromAi` を通らず、codex の entries・details・phases の表を読まないので、PR-4 の allowlist には影響しない）。`tables.test.ts` に「まだ入れない表」（codex_entries・events・snippets・projects ほか 15 表）が allowlist に無い負の試験を足した。`sql.test.ts`・`sql.drizzle.test.ts` は checker の文法試験で、多くの表名を使うため、試験専用の集合（`sql.testSupport.ts` の 21 表）に切り替えた（production の allowlist を狭めても文法の網羅は狭まらない）。`db.test.ts` と pipeline spec の `projects` は `tree_nodes` に差し替えた。
6. **DR-MP4-32f 静的試験。** `electron/shared/readDomain/core/core.static.test.ts`（TypeScript の AST）。(i) import：`electron/shared/readDomain/`（core と PR-3b で移した module）と `ports.ts` が、store（`*Store`）・`invoke`・`tauri`・i18n・React・zustand・jotai・IR（`chatAgentIr*`・`chatIr*`・`chronicleReadingPosition`）・`toolExecutors`・`toolDefinitions`・`ipcContract` を import しない。**許可 package の whitelist**（`drizzle-orm`、`drizzle-orm/sqlite-core`、`drizzle-orm/sqlite-proxy`、`fractional-indexing`、`temporal-polyfill`）と、相対 path が `electron/shared` の中に収まることを要求する（`@/`・`node:`・`electron`・未知の package も落ちる）。static・dynamic import・`require`・`import =`・`import()` 型・re-export を見る。(ii) SQL：**走査の root は `electron/shared/readDomain` 全体**（core と PR-3b で移した pure module。`features/**`・`lib/**`・`db/**` に Drizzle の query は 0 件で、表を名指すのは core だけであることも試験で固定）。core は Drizzle の select だけで、引数なしの `.get()`（`Map.get` は引数があるので除く。引数ありでも receiver が db・getter・builder・db の別名なら落とす。`Promise.all(xs)`・`Object.values(o)`・`Array.from(xs)` は落とさない）・引数ありの `.all(x)`/`.values(x)`（raw statement の形）・db の computed key の呼出し・db の分割代入（メソッドの取り出し）・drizzle-orm の namespace import（`import * as d`）と re-export・`sql` の別名 import・schema の表の別名 import（走査から隠れる）・その file で schema から import していない名前の `from`・`.run`・`.execute`・write・`.transaction`・`.batch`・`findFirst`・`findMany`・`$with`・`with`・`.query`・raw `sql` と「文になっている文字列」を使わない。`from`・join の引数は schema の表の binding でなければ落ちる。(iii) 表の集合が `MAIN_READ_TABLES` と等しい。負の fixture で各違反を落とす。`irClosure.static.test.ts` の走査 root に `electron/shared/readDomain` を足した（IR の語・`src/`・`NAPI_COMMANDS` の規則が core にも及ぶ）。**置き場**：計画の「src に置く」は renderer の module を import する試験の規則で、この試験は file を読むだけで renderer の module を import しないので `electron/shared` に置く（`pnpm test:electron` で走る）。
7. **DR-MP4-32g 同値試験（PR-9 の最初の版）。** `src/features/chat/agent/readCore.mainAdapter.test.ts`：core を **main の実 adapter**（`createMainReadDb`：送信前の検査・6 表の allowlist・行の位置対応）の上で、PR-0 の seed の実 sql.js に当て、golden（未変更の legacy から生成）の 7 本の全 case の結果（name・summary・tokensUsed・content・JSON の bytes）と一致することを見る。backend は sql.js の `db_execute` を Native と同じ wire（object の行＋marker）で包む fake。送った文は全て SELECT（method は all か values）。project が空の case は core が `CoreProjectRequiredError` で止まる。**覆えない範囲**：実 Native（実 addon）の行の返り順・型の返り方、実 addon の `db_execute` の identity の扱い（`mastraMainRead.pipeline.spec.ts` が担当）。実 addon で B1・B2 を回す spec は、この worktree に addon が無く PR 本文に未実行として記す。
8. **DR-MP4-32h gate の追従（範囲は狭めない）。** `evals/impact-map.yaml` の `tool-policy` の paths に、`toolExecutors.ts` から移した core の file を **1 本ずつ明示して**足した（`readExecutors.ts`・`treeReadTools.ts`・`plotThreadTools.ts`・`codexTagTools.ts`・`readContext.ts`・`toolResult.ts` と、その試験 `readExecutors.test.ts`・`core.static.test.ts`）。移した code の編集が選ぶのは `tool-policy` だけだったので、同じ rule に載せる。**初版の `core/**` の glob はやめた（レビュー指摘 P2-1）**：glob だと、移した code ではない main 用の 2 file（`core/sceneBody.ts`＝main 用の本文 reader、`core/readDb.ts`＝main 用の Drizzle wrapper）まで `tool-policy` だけに絞られ、対応する元（`src/features/tree/api.ts` は narrative-semantic-contract を選ぶ、`src/db/client.ts`・`electron/main/mastraRead/db.ts` は全 suite）より狭くなる（DR-MP4-3e に反する）。**選んだのは「列挙」**（2 file を `core/` の外へ動かす案は main の import を変えるので採らない）。`sceneBody.ts`・`readDb.ts` と、後続の PR が足す core の新 file は rule に当たらず全 suite（fail-open）のまま。新 file を `tool-policy` に載せるかは、その file が何の移動先かを見て列挙に足す。`impact-map.test.mjs` は、(1) 列挙した 6 本の選択 ⊇ `toolExecutors.ts` の選択、(2) `sceneBody.ts` の選択 ⊇ `src/features/tree/api.ts` の選択、`readDb.ts` の選択 ⊇ `src/db/client.ts` と `electron/main/mastraRead/db.ts` の選択（どちらも全 suite であることも固定）、(3) core の新 file が全 suite に落ちること、を固定する。tool-policy の Light suite の command に、`toolExecutors.legacyGolden.test.ts`・`readCore.mainAdapter.test.ts`・`core.static.test.ts`・`readExecutors.test.ts`・`tables.test.ts`・`irClosure.static.test.ts` を足した（今まで executor の golden は suite に無かった。**広げる向き**）。`quality-manifest.yaml` は `toolExecutors.ts` を `implementedBy` に持つ GDX-POLICY-001 と GDX-ARTIFACT-001 に core の 8 file を、GDX-TOOL-001 の `lightTests` に上の 6 試験を足した。`mastraRead/` の既存 file（`ports.ts`・`tables.ts`・`sql.ts`）は rule に当てず全 suite のまま（移した code ではなく、足すと全 suite から絞ることになる。DR-MP4-3e の方針）。
9. **DR-MP4-32i 検証の要点。** golden は `CI=true`（書き換えなし）で無変更のまま通る。core の文字列を 1 つ変えると golden が落ちることを確認した（legacy が実際に core を通っている証拠。確認後に戻した）。main の 3 bundle は esbuild を `write:false` で回した sha256 が base と一致する（`mastraRead/` は main の graph に入っていない。`MAIN_READ_TABLES` は bundle に無い）。renderer の bundle と `perf:budget` の差は PR 本文。
10. **残り・持ち越し。** (a) 実 addon の spec（B1・B2 を PR-0 の seed で回す）は PR-9（DR-MP4-33）で実行した。(b) `hidden` を通す tool（PR-5）で `withDetails` の経路と表の増分を決める。(c) `logger`・UI 言語・phase・native・cache の ports は、それを読む tool の PR が足す。**〔PR-7a：UI 言語は年表用の ctx（`CoreChronicleReadContext`）に足した。cache の port は足さず削除した。DR-MP4-37c・37e〕**(d) main の `getTreeState` は turn の値（DR-MP4-8）。PR-4 では main に繋がないので未実装。

### DR-MP4-33 実 addon の同値 spec（MP-4b PR-9。技術判断。2026-11-22）

試験だけの PR（製品のコード 0 行、tool の定義・schema・結果・表の allowlist は不変）。新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。

1. **DR-MP4-33a 置き場。** `electron/main/mastraReadParity.pipeline.spec.ts`（`vitest.electron-native.config.ts` だけが拾う。実 addon が要る）。seed は `src/features/chat/agent/__fixtures__/legacyReadSeed.ts` を **移さず**、electron の spec から相対 path（`../../src/...legacyReadSeed.js`）で import する（data だけで import を持たず、`electron/tsconfig.json` の NodeNext で解決できる。`@` は tsc が解決しない）。golden は `readFileSync` の text で読む（electron の試験が src を text で読む前例：`protocol.test.ts`・`mastraTurnOwner.test.ts`）。複製しないので golden の bytes は動かず、renderer の golden と drift しない。
2. **DR-MP4-33b seed の入れ方。** 実 DB への generic `db_execute` は `projects` の INSERT を `PROTECTED_WRITER_SQL`（writer `project.lifecycle`）で拒む（拒否が正しい）。seed は **workspace を開く前に別 process（`node:sqlite`）で 1 transaction** に入れる（`d2aChatWriters.pipeline.spec.ts` の `writeFromAnotherProcess` の前例）。seed の 4 project は sample workspace の project と並ぶ（読みは project 単位なので、project 条件の欠落があれば見える）。
3. **DR-MP4-33c 同値の範囲。** core の 7 本（B1・B2）を `createCoreReadDb(createMainReadDb(..))` で回し、golden の全 case（name・summary・tokensUsed・content・`JSON.stringify(content)` の bytes）が一致すること、送った文が全て SELECT（method は all か values、identity は 4 番目の引数のみ）、project が空の case は何も送らず `CoreProjectRequiredError` で止まることを見る。tree state は turn の値（project と activeScene のみ。7 本は tree を DB から読む）。**一致した**（sql.js と実 Native の差は 7 本の golden の範囲では出なかった）。golden の 1 文字を変えると落ちることを確認した（確認後に戻した）。
4. **DR-MP4-33d typed read の枠（PR-5・7・8 が足す）。** golden は Native の fts／semantic／foreshadow に当たらない（LIKE の arm、`[]`、Drizzle の分岐）ので、実 addon の結果を **特性として固定** する：fts は `{sourceType, id, title, excerpt}` の配列で project ごとに分かれる。**Native の fts は archived の場面（`n-arch`）も hidden の Codex（`c-secret`）も返す**（絞りは tool 層の仕事。PR-5・8 が core に移すときは tool 側で絞る）。foreshadowOpen は snake_case の `{foreshadows, setups}`、真偽は整数 0/1、時刻は epoch ms。semantic は workspace 不一致を `SEMANTIC_INDEX_WORKSPACE_CHANGED` で拒み、active の workspace では照合の後で止まる（model が無い環境は `embedding model 'ruri-v3-30m' is not installed`、有る環境は配列）。
5. **DR-MP4-33e 持ち越し。** (a) core の文の多くには ORDER BY が無く、結果は core 側の JS の並べ替えに依る（`list_chapters`・`get_chapter_summaries`・`get_scene_timeline_neighbors`・`list_plot_threads`・`get_thread_scenes`）。seed では実 Native と sql.js が一致したが、同じ sort_order の兄弟の間の順（tie）が DB の返り順に依るかは seed では確かめていない。(b) restricted profile（identity の欠落・失効・閉じた表）は本 spec の範囲外。(c) semantic の結果の同値は model のある環境でのみ。

11. **決める点（PR-8 の前。レビュー指摘 P3-3）。** `core/sceneBody.ts`（main 用の本文 reader）の SQL は `tree_nodes` を `id` だけで引き、project の条件が無い。legacy の `loadSceneContent(s)` も同じで回帰ではない（呼び手は先に project で絞った id を渡す）。main の port を繋ぐ PR-8 で、reader に `project_id` を取って条件に足すか（他 project の id を渡されたら `""`／欠落にする）を決める。足すと legacy との結果の差（id が他 project のときだけ）が生じうるので、同値試験の対象と合わせて判断する。

### DR-MP4-34 search_scenes・search_snippets の read core 化（MP-4b PR-5a。技術判断。2026-11-22）

PR-5 の半分（B3 の検索 2 本）を core 経由にする PR-5a の、mutation の前の判断。DR-MP4-3・32・33 の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。tool の定義・schema・結果は 1 byte も変えない（PR-0 の golden が不変であることで示す）。main はまだ core を呼ばない（旗 L は閉）。伏線 2 本（B4）は PR-5b。

1. **DR-MP4-34a PR-5 を 5a と 5b に分ける。** 5a は B3（`search_scenes`・`search_snippets`）、5b は B4（`list_open_foreshadows`・`get_foreshadow_detail`、`foreshadow/api.ts` の read 部分の分離）。B4 は api.ts と既存試験の mock の seam に触れ、B3 と性格が違う。`CoreReadContext`・`CORE_READ_TOOL_NAMES`・`LEGACY_NO_PROJECT_CONTENT`・`tables.ts` と各試験の本数の固定を両方が触るので、**5a を先に merge し、5b は master を取り込んで作る**。
2. **DR-MP4-34b `withDetails` は PR-5 では要らない（DR-MP4-32 の 5 項・10(b) の読み替え）。** DR-MP4-32 は「`hidden` を通す tool（PR-5）で `withDetails` の経路と表の増分を決める」と書いたが、PR-5 の 4 本は `codexHiddenFromAi`・`resolveCodexForAi`・`withDetails` を通らない（`toolExecutors.ts` の 4 本の範囲に参照が無いことを grep で確認）。`withDetails=true` の呼出しは `get_codex_entry` の `resolveCodexTextForAi` だけで、hidden を通す tool は PR-8（`search_codex`・`list_codex_by_type`・`search_codex_by_tags`・`find_related_entries`）。**`withDetails` の経路と Codex 系の表の増分は PR-8 の前に決める**（PR-5 の前、ではなく）。PR-5a の表の増分は `snippets` の 1 表だけ（7 → 8 表）。
3. **DR-MP4-34c ports：`CoreReadContext` に `native` を足す。** `Pick<CoreReadPorts, ...>` に `"native"` を足すと `CoreNativeReads` の 4 本（semantic 2 本・foreshadow を含む）を全て要求してしまうので、`& { readonly native: Pick<CoreNativeReads, "fts"> }` と交差で書く（5b で `"fts" | "foreshadowOpen"`）。誰も読まない port を caller に作らせない（DR-MP4-32b(iii) の方針）。renderer の port は `fts: (args) => invoke("fts_search", args)`（args を加工せず渡す。command・scope・limit は core が決め、`toolExecutors.legacyNativePort.test.ts` の固定は無変更で通る）。`invoke` は arrow の中で読むので `vi.mock("@/lib/tauri")` が効く。main の port は PR-1 の `createMainTypedReads` の `fts`（caller timeout は既存の `fts_search` の 10 秒）で、PR-5a では繋がない。
4. **DR-MP4-34d fts の結果は fail-closed に narrow する（`ftsHitIds`）。** `CoreNativeReads.fts` の戻りは `unknown`。core は、配列でなければ throw、行が object でない・`id` が string でない・`sourceType` が string でないなら**捨てずに throw** する。値が違うだけの行（別の scope の行）は捨てる（browser-mock の fts は scope を無視して全 scope の行を返す。legacy も同じ）。理由：wire の key が変わったときに「0 found」の成功（モデルが信じる結果）にならないようにするため（PR-4 の P2-2 と同じ型）。legacy は非配列で `rows.filter` が `TypeError` になり、id は無検査で `inArray` に渡していた。**有効な wire では結果は同じ**（golden が無変更で通る）。差が出るのは malformed な wire のときの error の message だけ（`TypeError` の文言 → `fts_search: ...`。`executeTool` が `Error: <message>` に包む）。既存試験のうち、`invoke` の mock が既定の undefined を返したまま search 2 本を 3 字以上の query で呼ぶもの、message に依存する assert は、grep と全件の実行で洗った結果、**期待を変えた試験は 0 件**（既存試験は全件が無変更で通る。該当する呼出しが他に無いことまでは grep で確定していない）。`sourceType` の文字列の検査は依頼文の「id が string」より厳しい側（反証の記録の直し）。単体試験は `searchTools.test.ts`。
5. **DR-MP4-34e archived の絞りは core の tool 層。** Native の `fts_search` は archived の場面も hidden の Codex も返す（DR-MP4-33d。実 addon で固定済み）。`search_scenes` の絞り（`archived_at IS NULL`、`node_type='scene'`、`project_id`）は legacy と同じく core の Drizzle の where に置く。FTS の arm は Rust の上限 50 で取り、archived を落として FTS の順に並べ、10 件に切る（#999 の形）。scene 自身の `archived_at` だけを見るので、祖先の folder だけが archived の場面は出る（golden に case がある）。
6. **DR-MP4-34f 共有 helper の置き場。** `core/searchHelpers.ts` に `plainTextExcerpt`・`EXCERPT_MAX_CHARS`（`prosemirrorToText` の import ごと）・`buildLikeOrCondition`・`orderByIds`・`parseTagsCacheNames` を移し、`ftsHitIds` を足した。`core/searchTools.ts` に 2 本の executor。legacy が import し直すのは Codex 系と共有する `buildLikeOrCondition`・`orderByIds`・`parseTagsCacheNames` の 3 つだけで、`plainTextExcerpt`・`EXCERPT_MAX_CHARS`・`prosemirrorToText` の import は legacy から消した（search 2 本だけが使っていた。計画の初版の「Codex 系 4 本も使う」は誤りで反証で訂正）。`sparseSearchIds`（`search_codex` だけが使う）は PR-8 まで legacy に残るので、**core の `fts` port と `sparseSearchIds` の 2 経路が PR-8 まで共存する**（どちらも同じ `fts_search`・同じ引数）。
7. **DR-MP4-34g 表の allowlist は表単位（信頼境界の記録）。** `snippets` を `MAIN_READ_TABLES` に足した（`tables.ts`・`tables.test.ts` の `PINNED`／`NOT_YET`・`core.static.test.ts` の集合の一致）。allowlist は表名だけを検査し（列・where は見ない。`checkReadSql`）、`core.static.test.ts` が守るのは「core の Drizzle が名指す表＝allowlist」で、tool 単位ではない。したがって**main の db 経由の文は `snippets` の全文（content・tags_cache）を読める**。意図した範囲は、renderer の `search_snippets` が既に AI に返す内容（title・tags・200 字の preview）と、renderer が generic な `db_execute` で同じ表を読めること。旗 L が閉なので今は届かない。伏線の表（5b）については 5b の DR で同じ記録を足す（`secret=1` の行と notes）。
8. **DR-MP4-34h main の caller timeout（MP-13 の前の持ち越し。値は変えない）。** main の `db_execute` は送る文すべてに 10 秒の caller timeout を常に掛ける（`MAIN_READ_CALLER_TIMEOUT_MS.db_execute`＝PR-1 で確定済み。新しい値ではない）。renderer の 10 秒は自分の読み取り判定を通った文だけに掛かるので、`search_scenes` の LIKE の arm（全場面の title・content への LIKE、ORDER BY なし）や FTS の arm の最大 50 場面の本文の再取得は、**巨大な原稿では main でだけ打ち切られうる**。結果の bytes は変えない。caller timeout を変えるのは閾値の緩和に当たるので PR-5a では触れない。**旗 L を開ける前（MP-13）に、巨大原稿での実測と値の扱いを決める。**
9. **DR-MP4-34i 残るリスク：typed read の fts は workspace を束縛しない。** semantic 2 本だけが `expectedWorkspacePath` を渡し、`fts` は渡さない（`typed.ts`）。`fts` の結果は id の絞りだけで、その後の `db_execute` は identity つきなので、turn の途中で workspace が切り替わっても別 workspace の行は読めない（project id は UUID）。PR-5a では値を変えない。旗 L の前に、`assertLive` の 3 状態で担保するか、`fts` にも workspace の照合を足すかを PR-8 の前後で決める。
10. **DR-MP4-34j 検証の要点。** golden は `CI=true`（書き換えなし）で無変更のまま通る。`legacyNativePort`・`searchScenesArchived`・`toolExecutors.test.ts` の search 整形 5 件も無変更。main の 3 bundle は esbuild を `write:false` で回した sha256 が base と一致する（`mastraRead/`・`readDomain/core` は main の graph に入っていない）。`readCore.mainAdapter.test.ts`（sql.js 上。fts は golden を作ったのと同じ browser-mock の `fts_search` を JSON 文字列で返す fake backend を `createMainTypedReads` に繋ぐ）と、PR-9 の実 addon spec（`mastraReadParity.pipeline.spec.ts`）に search 2 本を足した。**実 addon の spec の実行は merge の条件**（反証の記録）。**実行の結果と決定（2026-11-22。ユーザー確認済み）**：9 本の golden の 73 case のうち、project なしで core が止まる 10 case を除く 63 case を実 Native で比べると、62 が byte まで一致し、1 case だけ順が食い違った（`search_scenes` の「3 字以上（fts_search の arm）」、query `アリア`：golden＝`[n-s1, n-s3]`、実 FTS5＝`[n-s3, n-s1]`。内容・summary・件数は同じ）。**根拠**：golden は browser-mock の LIKE の走査順で作られ、実 FTS5 の順ではない（browser-mock の fts は scope を無視して LIKE で返す）。製品の legacy の経路も Native の `fts` の順をそのまま使う（`orderByIds`）ので、golden の順は製品の順の oracle ではない。**決定**：spec は、`fts` を通る case（FTS の arm。spy した `fts` が 1 回でも呼ばれた case で判別する。短い語の LIKE-OR・空 query・project なしは `fts` を呼ばない）だけを、「summary・tokensUsed・各行の中身（id で並べ替えた JSON の bytes）が golden と一致し、**並びは同じ case で実 Native の `fts` を直接呼んで得た id の順から archived を落とし 10 件に切ったもの**（試験の中で計算し、決め打ちにしない）と一致する」形で比べる。他の case は今までどおり bytes で比べる。golden は変えない。変異（並びを逆にする・行を 1 つ落とす・中身を 1 文字変える）で、FTS の arm だけに限った変異でもそれぞれ失敗することを確認した。この結果、実 addon の spec は全 file が通る（14/14）。light suite（tool-policy）と GDX-TOOL-001 の `lightTests` に `legacyNativePort`・`searchScenesArchived`・`searchTools.test.ts` を足し、impact-map の列挙に新 core の 3 file を 1 本ずつ足した（広げる向き）。

### DR-MP4-35 list_open_foreshadows・get_foreshadow_detail の read core 化（MP-4b PR-5b。技術判断。2026-11-22）

PR-5 の残り（B4 の伏線 2 本）を core 経由にする PR-5b の、mutation の前の判断。DR-MP4-3・24・32・33・34 の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。tool の定義・schema・結果は 1 byte も変えない（PR-0 の golden が不変であることと、実 addon の同値で示す）。main はまだ core を呼ばない（旗 L は閉）。

1. **DR-MP4-35a seam は案 Y（core が wire を受けて組む）。** core（`core/foreshadowTools.ts`）は `ctx.native.foreshadowOpen({ projectId })` の **wire**（`{foreshadows, setups}`）を受け、`openForeshadowsFromWire` で narrow → `normalizeForeshadowRow`／`normalizeSetupLabelInput` → `buildOpenForeshadowsForContext` と組む。renderer の port は `foreshadow/api.ts` の新しい export **`readOpenForeshadowWire(projectId)`**（Native なら `foreshadow_list_open_for_context` を `{projectId}` だけで 1 回 invoke して戻りをそのまま返す。そうでなければ Drizzle の 2 list を camelCase・boolean・Date のまま返す）。`listOpenForeshadowsForContext`（chat の context 構築・`sceneContextSource` が使う）は `openForeshadowsFromWire(await readOpenForeshadowWire(projectId))` で、シグネチャと戻りは不変。**案 X（狭い port `foreshadow.listOpen`）への退避は要らなかった。** 根拠：(i) 案 Y は Drizzle 分岐の行も normalize を通すので、golden（Drizzle 分岐から生成）が core の組み立てを直接覆う。この変更を入れた時点で golden・`legacyNativePort` が無変更で通り（有効な行では normalize が恒等であることの証拠）、(ii) 移す前の legacy でも通した「実 Native の wire（snake_case・0/1・epoch ms・setups に scene_id なし）から組んだ list_open が golden と byte 一致」の試験（`toolExecutors.legacyNativePort.test.ts` に足した 1 件）が、移した後も同じまま通る。(iii) 組み立てが main と legacy で同じ core の code を通る（案 X はこれが port の実装側に出る）。差が出うる入力（`updatedAt` が null／undefined、`version`・`title` が欠けた行）は有効な行では起きず、`readRows.test.ts` で挙動を固定した（`updatedAt` 欠落はエポック扱いで同順位の最後）。
2. **DR-MP4-35b read 専用 module。** `electron/shared/readDomain/features/foreshadow/readRows.ts`（`normalizeSetupRow`・`normalizeSetupLabelInput`・`SetupLabelInput`・`buildForeshadowsWithLabels`・`OpenForeshadowForContext`・`buildOpenForeshadowsForContext`・新設の `openForeshadowsFromWire`。本体は `api.ts` から移しただけで変えない）と `coerce.ts`（`toDate`・`toNullableDate`・`toBool`。`normalizeForeshadowRow.ts` と `api.ts` に別々にあった同実装を 1 つにした）。I/O（invoke・db）は `api.ts` に残し、`api.ts` は `buildForeshadowsWithLabels` と型を re-export する（既存の `api.*.test.ts` が無変更で通る）。この module は Drizzle を持たない（`core.static.test.ts` が `features/**` の query 0 件を固定）。専用の試験は `readRows.test.ts`（snake_case と camelCase、0/1 と boolean、epoch ms・Date・ISO 文字列、`sceneId` の欠落、`updatedAt` 欠落時の並び、同順位の入力順の維持、orphan を `setupCount` から除く、wire の narrow）。
3. **DR-MP4-35c wire の narrow は fail-closed（反証の記録 P2）。** `foreshadows`・`setups` が配列でなければ throw（`?? []` は使わない。Rust は常に両方を出す）。foreshadow の行は object で `id`・`title` が string でなければ throw。setups の行は object で `foreshadow_id`（または `foreshadowId`）が string でなければ throw。理由：key の変更で「0 open foreshadowing items」の成功や、全件の `setupCount` が 0 になる成功（モデルが信じる結果）にならないように、また object でない行から id・title が空の幻の伏線を作らないため（PR-4 の P2-2、DR-MP4-34d と同じ型）。**有効な wire では結果は同じ**。差が出るのは malformed な wire のときだけで、形で 2 通りに分かれる。(i) `null`／`undefined` の wire は、以前も `TypeError` だったので、変わるのは error の message だけ（→ `foreshadow_list_open_for_context: ...`。`executeTool` が `Error: <message>` に包む）。(ii) `{}` や片方の key を欠く wire は、以前は `?? []` で成功していた（「0 open foreshadowing items」、または全件の `setupCount` が 0）が、今は error になる。`sceneContextSource` では `OPEN_FORESHADOWS_UNAVAILABLE` の warning の診断が足される。(ii) は意図した fail-closed 化（Opus のレビュー P3-2 で記述を直した）。`listOpenForeshadowsForContext` の他の呼び手（`chatContextPreparationComposition.ts`、`sceneContextSource.ts`）も同じ narrow を通る。後者は optional source で失敗は診断つきで継続する。`invokeForeshadowListWithLabels`（`foreshadow_list_with_labels` ほか別の command）は `?? []` のまま触らない。既存試験で `foreshadow_list_open_for_context` の戻りを欠いたまま通すものは、grep（`src`・`electron` 全体で、この command の mock は `api.tauri.test.ts` と `legacyNativePort` の 2 file だけ）と、`api.ts` の import 元の試験（`chat/agent`・`chat/context`・`application/composition`・`foreshadow`・`codex`・`tree`・`trash-bin`・`kouetsu`）の全件の実行で洗った結果 0 件（`api.tauri.test.ts` の wire は id・title・`foreshadow_id` を持つ）。
4. **DR-MP4-35d `readOpenForeshadowWire` の Drizzle 分岐は文と順を保つ。** foreshadows を `project_id`・`payoff_confirmed = false`・`abandoned = false`・`secret = false` で select し、0 件なら setups の select を打たず `{foreshadows: [], setups: []}`、1 件以上なら `inArray` で setups を select する（従来の `listOpenForeshadowsForContext` の文と順のまま）。Native 分岐の invoke は `{projectId}` だけで 1 回。`legacyGolden.test.ts` の「最初の invoke で project を切り替える」試験と `legacyNativePort` の `db_execute` 0 回は無変更で通る。単体の試験は `src/features/chat/agent/readOpenForeshadowWire.test.ts`（secret の絞り、文の数、空のときの early return、Native の invoke 1 回、戻りをそのまま返すこと）。
5. **DR-MP4-35e secret な伏線が list_open_foreshadows に出ないことの固定（反証の記録 P2）。** `secret = 0` の絞りは Native（Rust）の SQL（`foreshadow.rs` の `list_open_for_context`）にあり、wire に secret の列が無いので core は再 filter できない。固定するのは 3 か所：(1) 実 addon の spec（`mastraReadParity.pipeline.spec.ts`）の必須の case：seed の `fs-2` が secret=1・未回収・未放棄であることを spec の中で確かめた上で、実 Native の wire に `fs-2` も `fsu-4` も無く、list_open の結果が golden の第 1 case と byte 一致し `fs-2` を含まず、`get_foreshadow_detail` は `fs-2` を返す（DR-MP4-24 の既存の挙動）こと。(2) `readOpenForeshadowWire` の Drizzle 分岐が `secret = false` を保つこと（`readOpenForeshadowWire.test.ts`。外すと 3 件が落ちる）。(3) **Rust の `list_open_for_context` の secret 除外の単体試験は TS の範囲外。MP-13（旗 L を開ける前）の確認項目として C-11 と並べて載せる。** core の試験（`foreshadowTools.test.ts`）は、core が wire の行を再 filter しない（read が返した行は出す）ことも固定する。
6. **DR-MP4-35f 表の allowlist は表単位（信頼境界の記録）。** `foreshadows`・`foreshadow_setups` を `MAIN_READ_TABLES` に足した（`tables.ts`・`tables.test.ts` の `PINNED`／`NOT_YET`・`core.static.test.ts` の集合の一致。8 → 10 表）。`get_foreshadow_detail` が読む表は `foreshadows`・`foreshadow_setups`・`tree_nodes`（既存）で、`list_open_foreshadows` は Native の typed read で表を名指さない。`foreshadow_codex_links` は 2 本のどれも読まないので入れない（`NOT_YET` に残る）。**allowlist は表名だけを検査し（列・where は見ない）、`core.static.test.ts` が守るのは「core の Drizzle が名指す表＝allowlist」で、tool 単位ではない。したがって main の db 経由の文は、`foreshadows`（`secret = 1` の行と `notes` を含む）と `foreshadow_setups`（secret な伏線の setup の `ai_reasoning`・`ai_rationale`・`from_pos`／`to_pos` を含む全列）の、全 project の全行を読める。** 意図した範囲は、`get_foreshadow_detail` が既に返す内容（secret の伏線の intent・notes・setups）と、renderer が generic な `db_execute` で同じ表を読めること（DR-MP4-34g の `snippets` と同じ）。旗 L が閉なので今は届かない。**MP-13 で C-11 の状態を確かめる。**
7. **DR-MP4-35g get_foreshadow_detail は同値で移す（DR-MP4-24）。** 順序（空 id → project → foreshadow を `id` と `project_id` で select → setups を `tree_nodes` と innerJoin → `payoffSceneId` があれば scene を引く）、全列の `select()`、content の key 順、summary の文字列、secret も notes も返すことを、旧 executor のまま移した。既存の非対称（payoff scene の取得と setups の join が project で絞られない。起点の foreshadow が project で絞られているので到達しない前提）も写した。**DR-MP4-24 の非対称（detail は secret を落とさず、list_open は Native の `secret=0` で落とす）を main の新しい経路にも写す。直さない。** 全列の `select()`（`mechanism`・`codex_link_dirty_at` を含む）と setups の join の順は、実 addon の spec（main の adapter と実 Native）で golden と byte まで一致した。
8. **DR-MP4-35h PR-4 の方針からの外れ（2 件の mock）。** 「既存の試験は mock の seam を保って無変更」（DR-MP4-32b(i)・32d）から、`toolExecutors.test.ts` の list_open の 2 件の mock だけが外れる（`@/features/foreshadow/api` の mock が `listOpenForeshadowsForContext` から `readOpenForeshadowWire` になり、「rows を返す」1 件は wire を渡して結果の各 field〔id・title・intent・loadBearing・setupCount〕と summary を確かめる）。理由：案 Y の port は wire を返すだけで、組み立ては core の仕事になったため。意図（整形の確認、project なしでは API を呼ばない）は保つ。golden・`legacyNativePort`（既存の assert は無変更。足したのは 1 件）・search 整形 5 件・`searchScenesArchived`・`api.*.test.ts` は無変更で通る。`toolExecutors.codexHidden.test.ts`・`toolExecutors.chatIr.test.ts` の factory は list_open を呼ばないので無変更（`readOpenForeshadowWire` を arrow の中で遅延に読むため、factory に無い export は呼ばれたときだけ問題になる）。
9. **DR-MP4-35i 残るリスク（MP-13 の前の持ち越し。値は変えない）。** (a) typed read の `foreshadowOpen` は `fts` と同じく workspace を束縛しない（semantic 2 本だけが `expectedWorkspacePath` を渡す。`typed.ts`）。`foreshadowOpen` の結果は **直接 AI に出る**（`fts` は id の絞りだけで、その後の `db_execute` が identity つき）ので、DR-MP4-34i より重い。turn の途中で workspace が切り替わると、別 workspace の同じ `projectId` に当たりうる（project は UUID で実際の衝突は考えにくい）。旗 L の前に、`assertLive` の 3 状態で担保するか、`foreshadowOpen` にも workspace の照合を足すかを決める。PR-5b では値を変えない。(b) `foreshadowOpen` は renderer も caller timeout を持たないので、main でも `null` のまま（新しい値を置かない。DR-MP4-4）。(c) 実 addon で ORDER BY の無い文（detail の setups の join、list_open の同順位）の返り順が sql.js と同じかは、seed に tie が無いので未確認（DR-MP4-33e(a) と同種）。
10. **DR-MP4-35j gate の追従（範囲は狭めない）。** `evals/impact-map.yaml` の `tool-policy` の paths に `core/foreshadowTools.ts`・`core/foreshadowTools.test.ts`・`features/foreshadow/readRows.test.ts` を 1 本ずつ足した（glob にしない）。**read 専用 module の本体（`readRows.ts`・`coerce.ts`）は rule に載せない**：split 元の `src/features/foreshadow/api.ts` は rule に当たらず全 suite を選ぶので、rule に載せると選択が狭まる（`impact-map.test.mjs` の「created ⊇ splitFrom」が落ちる）。`impact-map.test.mjs` は、新 core の名前を (1) の「toolExecutors 由来」の列に、read module 2 本を `created` に、`api.ts` を `splitFrom` に足した（`moved` は触らない）。tool-policy の Light suite と GDX-TOOL-001 の `lightTests` に `readOpenForeshadowWire.test.ts`・`foreshadowTools.test.ts`・`readRows.test.ts` を足した（広げる向き）。`quality-manifest.yaml` は GDX-POLICY-001 と GDX-ARTIFACT-001 の `implementedBy` に `foreshadowTools.ts`・`readRows.ts` を足した。`api.ts` を触るので PR の impact は全 suite になる（PR 本文に書く）。
11. **DR-MP4-35k 検証の要点。** golden は `CI=true`（書き換えなし）で無変更のまま通る。`legacyNativePort` の既存の assert・`searchScenesArchived`・search 整形 5 件も無変更。main の 3 bundle は esbuild を `write:false` で回した sha256 が base と一致する（`main.cjs` 76fa8082…、`preload.cjs` 27e5476b…、`mastra-agent.cjs` 041f5ac4…）。`readCore.mainAdapter.test.ts`（sql.js 上。`foreshadowListOpenForContext` の fake は Native の SQL と同じ SELECT を打って snake_case・0/1・epoch ms の wire にする）と、実 addon の spec に伏線 2 本を足した。**実 addon の spec（`pnpm napi:build` の後、全 file）は通る。** 11 本の golden の 87 case のうち、project なしで core が止まる 12 case を除く 75 case を実 Native で比べ、伏線 2 本の case はすべて byte まで一致した（fts の arm の並びの比べ方は DR-MP4-34j のまま）。変異で、list_open の整形・`toBool` を弱める・`secret = false` を外す・allowlist から表を外す・core に 11 表目を足す、がそれぞれ失敗することを確認した（確認後に戻した）。

### DR-MP4-36 archived の場面を list_plot_threads・get_thread_scenes の branches・get_foreshadow_detail の setups・payoffScene から外す（ユーザー決定。2026-11-22）

外部 Markdown のマウントで、ファイルの消失・重複により場面が自動で archived（`tree_nodes.archived_at`）になる。#999 で agent の read tool 5 本（DR-MP4-34e ほか）と `get_thread_scenes` の links から外した。その延長として、**ユーザーが 2026-11-22 に決めた**次の 3 か所（と、同じ日に追加で決めた 3a の `payoffScene`）から外す。DR-MP4-32・35 が「直さない」として持ち越した残件の解消であり、tool の定義（name・description・schema）・tool 集合・manifest・注入文言は変えない。結果が変わるのは、archived の場面を指す行があるときだけ。

1. **list_plot_threads の `sceneCount` と `phases`。** links の select に `get_thread_scenes` と同じ leftJoin（`tree_nodes`）と `archived_at IS NULL` を足し、archived の場面の link を数えない。行が無い node の link は従来どおり残す。**`phases` も同じ link から作るので、archived の場面にだけ結ばれた phase は出なくなる**（ユーザーが名指ししたのは `sceneCount`。`phases` だけ残すと `get_thread_scenes`〔links を外すので phase も出ない〕と食い違うため、同じ link の集合から作る形に揃えた）。
2. **get_thread_scenes の `branches`（`atNodeId`）。** archived の場面で分岐・合流する edge は **行ごと除く**（`atNodeId` を null にはしない）。選ばなかった案は「edge を残して `atNodeId` を null にする」。理由：(i) 結果に archived の場面の id を残さない。AI がその id で `get_scene` を呼ぶと Scene not found になる（#999）。links の除外と同じ原則。(ii) `atNodeId` は notNull の列で、今まで結果に必ず string で出ていた。null は AI が見たことのない形で、description を変えられない（変えない）以上、null の意味を伝えられない。除外なら形は変わらない。(iii) プロットの画面（`plotThreadLaneModel`・`sceneThreadTracks`）は store の nodes〔archived を除く〕の位置で edge を描くので、archived の場面の edge は作者にも見えない。`plot_thread_branches` の select に leftJoin と `archived_at IS NULL` を足し、statement の数・順は変えない（thread で絞る filter は従来どおり tool の中）。
3. **get_foreshadow_detail の `setups`（`sceneTitle`）。** archived の場面の setup は **行ごと除く**（`sceneTitle` を null にもしない）。選ばなかった案は「setup を残して `sceneTitle` を null にする」で、理由は 2 と同じ（`sceneId` が残り Scene not found の id を渡す。`sceneTitle` は innerJoin で今まで必ず string）。setups の select に `archived_at IS NULL` を足す（innerJoin のまま。join が行の無い node の setup を落とすのは従来どおり）。summary の `N setup(s)` は除いた後の件数。`orphan` の setup も archived の場面なら出ない（live の場面の orphan は出る）。
   3a. **get_foreshadow_detail の `payoffScene`（ユーザー決定。2026-11-22、3 の続き）。** 回収の場面（`payoff_scene_id`）が archived の場面なら、**`payoffScene` は `null`** にする（`{id, title: null}` にはしない。理由は 2・3 と同じ：`id` が残ると `get_scene` が Scene not found になる id を渡す。`title` は今まで必ず string）。形は「`payoff_scene_id` が無い」「行が無い」ときの今の `null` と同じで、AI が見たことのない形は増えない。payoff scene の select に `archived_at IS NULL` を足した（`id` だけの絞りに足す。join は増やさない。statement の数・順・params は不変）。**AI に渡る summary の文言は変えず、そのまま出す**：summary は `payoffScene` の有無で `planned`／`unset` を決めるので、archived のとき `payoff planned` → `payoff unset` に変わる（`payoffConfirmed` は変えない）。また **`payoffConfirmed` が true で `payoffScene` が null の組**（summary は `payoff confirmed`）も起こりうる。これは、`payoff_scene_id` が NULL の回収済みの伏線（場面の削除で外部キーが `ON DELETE SET NULL` になった場合、回収の場面を設定せずに回収済みにした場合）で今も起こる形と同じで、新しい形ではない（行が無い id を指す状態は、外部キーがあるので通常は起こらない）。この 2 点は文言・schema の変更ではなく、結果の値の変化として受け入れた。seed（`legacyReadSeed.ts`）には、他の golden に波及させないため**新しい伏線 2 本**を足した（既存の `fs-1`・`fs-3` の payoff は動かさない）：`fs-6`（回収予定が `n-arch`・未回収・放棄済み。summary は `payoff unset`。summary の分岐は `abandoned` を見ないので、放棄済みの fs-6 が「未回収で回収先が archived」の分岐を代表する）と `fs-7`（回収済み・回収の場面が `n-arch`。`payoffConfirmed` true・`payoffScene` null・summary は `payoff confirmed`）。どちらも放棄済み／回収済みなので `list_open_foreshadows` の結果・`readOpenForeshadowWire`・他の tool の golden や件数には出ない。変わった golden は `get_foreshadow_detail` の 1 file だけで、既存 case の bytes は不変、足した 2 case（`fs-6`・`fs-7`）が追加された。試験は `foreshadowTools.test.ts`（payoff の statement に `archived_at IS NULL` があること、行が無いときの null・summary の `unset`／`confirmed`、live の payoff は従来どおり）と `readExecutors.test.ts`。`isNull` の条件を外すと statement の試験が落ちることを確かめた（確認後に戻した）。
4. **範囲外として触らないもの。** (b) `list_open_foreshadows` の `setupCount` と、そこから作る label（planned・critical_weak など）は、archived の場面にある orphan でない setup も数える。`get_foreshadow_detail` の `N setup(s)` と `setups` からは消えるので、AI には「list では 3 件、detail では 2 件」と見えうる（**この DR の変更で新しく生じるずれ**。orphan は元から数えない）。数えているのは TS（`features/foreshadow/readRows.ts`）だが、Native の wire（`foreshadow.rs` の `fetch_setup_label_rows`）に `scene_id` が無く、core では絞れない。wire に足すのは Rust なので別 lane（§6.2 の 2）。seed には「archived の場面にある、orphan でない setup」が無く、このずれは golden に現れない。(c) `get_foreshadow_detail` の secret の扱い（DR-MP4-24）は触らない。(d) `readOpenForeshadowWire` の Drizzle 分岐（chat の context 構築が使う）と `list_open_foreshadows` の wire は archived を外さない。(e) 「5. PR-0 の golden で固定した legacy の事実」の「`get_thread_scenes` は `archived_at` で絞らない」は #999 以前の記述で、現在は links を絞る（本 DR で branches も）。(f) standalone MCP の `get_foreshadow_detail`（`src-tauri/crates/grimodex-mcp/src/db.rs`）は archived を外さない（db.rs に archived の語が無い）。agent と MCP で setups・回収の場面が食い違う。MCP は外に出る口なので、挙動の変更を伴う別 lane（§6.2 の 2）で扱う。（旧版は (a) として `get_foreshadow_detail` の `payoffScene` を範囲外に挙げていたが、同日のユーザー決定で 3a として範囲に入れたので、(a) は削除した。）
5. **試験と golden。** seed（`legacyReadSeed.ts`）に、archived の場面 `n-arch` を指す link `l-7`（th-sub、phase climax。`phases` の差が見える）、分岐 `br-2`（th-sub→th-main の merge）、live の場面 `n-s4` の orphan の setup `fsu-6`（fs-1。archived の `fsu-3` が結果から消えても、orphan の case が golden に残る）を足した。golden の `list_plot_threads`・`get_thread_scenes`・`get_foreshadow_detail` の 3 file を作り直した（他の golden は 1 byte も動かない。`list_open_foreshadows` は orphan を数えないので不変）。差分：list の th-main の `sceneCount` 4→3（th-sub は `l-7` を足しても 1 のまま）、`get_foreshadow_detail` の fs-1 は archived の `n-arch` の setup が消え、live の orphan（`n-s4`）が出る（件数 3 のまま）、`get_thread_scenes` の content は不変（足した `br-2`・`l-7` は結果に出ない。足した後に未修正のコードで取ると、`br-2` の edge と th-sub の `sceneCount` 2・climax が出ることを確かめてから修正した）。3a の追加（`fs-6`・`fs-7` と `get_foreshadow_detail` の golden の 2 case）は上の 3a のとおり（上の「3 file」のうち `get_foreshadow_detail` の golden に足された）。core の単体試験は `readExecutors.test.ts`（list の links、`get_thread_scenes` の branches の statement が leftJoin と `archived_at IS NULL` を持つ）と `foreshadowTools.test.ts`（setups の statement）。scripted client は SQL を評価しないので、行の結果は golden（実 sql.js）と実 addon の spec（`mastraReadParity.pipeline.spec.ts`）が固定する。core を元に戻すと 3 件が落ちることを確かめた（3a の分は `isNull` を外すと、statement の試験と golden が落ちる）。**検証（2026-11-22。master `7aa8e5d65`〔#1026〕を取り込んだ head で、親が回した）**：`CI=true vitest --run src/features/chat/agent` が 38 file／875 件（3 skip）、`pnpm test:electron --run electron/shared electron/main/mastraRead` が 33 file／1378 件、tsc 2 つが 0、`pnpm lint` が 0 errors、`pnpm validate:architecture` が 0。実 addon は master の取り込み後に `pnpm napi:build` し直し、`vitest.electron-native.config.ts` が 14 file／86 件で通った（`mastraReadParity.pipeline.spec.ts` は 11 tool の golden の全 case を byte まで比べ、足した case〔fs-6・fs-7 の 2 case〕が自動で加わる）。

### DR-MP4-37 list_events・get_event_detail・get_character_timeline・get_chronicle_state の read core 化（MP-4b PR-7a。技術判断。2026-11-22）

PR-7（B6 年表）の前半を core 経由にする PR-7a の、mutation の前の判断（実装の途中で確定した点を含む）。DR-MP4-3・8・16・24・32・33・34・35 の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。tool の定義・schema・結果は 1 byte も変えない（PR-0 の golden が不変であることと、実 addon の同値で示す）。年表の秘匿判定（`isEventHiddenFromAi`）は今のまま写す（CSR/1 の `events.secret` の廃止は後）。main はまだ core を呼ばない（旗 L は閉）。
**番号について**：DR-MP4-36 は archived の PR（#1027）が使った。PR-7a は 37 を使う。

1. **DR-MP4-37a PR-7 を 7a と 7b に分ける。** 7a は `list_events`・`get_event_detail`・`get_character_timeline`・`get_chronicle_state`。7b は `search_events`（IR 無しの部分）。`search_events` は dense の握りの置き場、scope ありの分岐、hit の素通しなど別の判断が要るので分ける（7b へ持ち越す点は 12。**〔DR-MP4-38 で確定した〕**）。`CORE_READ_TOOL_NAMES`（11 本）と `createReadExecutors` は無変更（年表は別の表と別の factory。2）。
2. **DR-MP4-37b seam は案 A（行を返す loader の port）。** core は `CoreChronicleData`（`getEvents`・`getSceneEvents`・`getCodexNames`・`getReadingOrder`、cache しない `listParticipants`・`listRelations`・`getCalendar`）を受ける。cache は port の実装の裏にある。案 B（PR-4 と同じく core が `ctx.getDb()` の Drizzle で読む）は、`chronicleReadTools.test.ts` の 12 件が `@/features/chronicle/api` の 5 関数・`listCodexMatchTargets`・`treeStore`・`computeGlobalSceneOrder` を mock し、chatIr 系が `./chronicleToolCache` の `getShared*` を差し替えて `@/db/client` を `{ db: {} }` にするので、「無変更で通す」を満たせず退けた（先例は DR-MP4-35a）。
   - **legacy の port**（`src/features/chat/agent/chronicleReadContext.ts`）は、arrow の中で既存の `getShared*`・`chronicle/api`・`getSharedReadingOrder` を呼ぶ（import の束縛は呼ぶときに読むので `vi.mock` が効く。`@/db/client` は import しない）。`listParticipants` は ids が undefined のとき引数 1 つで呼ぶ（`toHaveBeenCalledWith` の固定を保つ）。`chronicleReadTools.ts` は 4 つの export と `CHRONICLE_NO_PROJECT_CONTENT` を保つ薄い層で、`toolExecutors.ts` は無変更。
   - **`chronicle/api.ts` の read 5 関数**（`listEvents`・`listEventParticipantsForProject`・`listSceneEventsForProject`・`getProjectCalendar`・`listEventRelations`）は core の reader（`core/chronicleReaders.ts`）への薄い委譲にした（SQL・order・key は不変。write 側と公開のシグネチャは不変）。golden（実 sql.js）は api.ts 経由でこの SQL を通すので、**golden が覆うのは 5 つの reader の SQL（renderer 側）**。覆わないのは Codex 名の 2 列 select（renderer は `listCodexMatchTargets` の 6 列、main は `id,name`）と、main の adapter・Native 経由の部分。Codex 名の Map が legacy と一致することは `readCore.mainAdapter.test.ts` の 1 件で固定した（全 project の key・値・順。hidden の entry を含む）。
   - **行の正規化の置き場**は `electron/shared/readDomain/features/chronicle/readRows.ts`（`normalizeEvent` と participants・scene-event・relation・calendar の正規化。本体は api.ts から移しただけで変えない。`api.ts` が import し、`normalizeEvent` を re-export する）。計画の第一案の `src/features/chronicle/readRows.ts` は、`core.static.test.ts` が相対 import の `electron/shared` の外への出を禁じるので core から import できない（DR-MP4-35b の先例）。`CalendarRow` 型は `eventRows.ts` に足した。
3. **DR-MP4-37c ctx と factory は年表用に分ける。** `CoreChronicleReadContext`（`getTreeState`・`countTokens`・`getUiLanguage`＋`chronicle`）、`createChronicleReadExecutors(ctx)`、`CHRONICLE_READ_TOOL_NAMES`（4 本）。`CoreReadContext` は広げない。理由：(i) 広げると、それを literal で作る試験すべて（`readExecutors.test.ts`・`searchTools.test.ts`・`foreshadowTools.test.ts`・`readCore.mainAdapter.test.ts`・実 addon の spec）に型の波及がある。(ii) 年表 4 本は db・本文の reader を要らず、年表用の ctx を import する renderer の module が `@/db/client` の実物を読まずに済む（`chronicleReadTools.test.ts` は `@/db/client` を mock しない）。名前の表は `CORE_READ_TOOL_NAMES` とは別。**「全 core tool」を歩く呼び手のうち、`src/features/chat/agent/toolExecutors.ts` の `LEGACY_NO_PROJECT_CONTENT` は `Record<CoreReadToolName, …>`（11 本）のまま変えず、年表 4 本の no-project の content は別の `CHRONICLE_NO_PROJECT_CONTENT`（`chronicleReadTools.ts`。`Record<ChronicleReadToolName, …>`）が持つ。**実 addon の spec（`electron/main/mastraReadParity.pipeline.spec.ts`）と `readCore.mainAdapter.test.ts` は、`CORE_READ_TOOL_NAMES` を歩く describe とは別に、`CHRONICLE_READ_TOOL_NAMES` を歩く describe を持ち、2 つの表が互いに素であることを assert する（1 つのループが両方の表を歩くのではない）。7b が `search_events` を足すときは、年表側に dense の port を足す形になる見込み（7b で決める）。**〔PR-7b：`CoreChronicleReadContext` には足さず、専用の狭い型 `CoreChronicleSearchContext` と別の factory にした。3 つの表は互いに素で合計 16 本。DR-MP4-38b〕**`CoreTreeNode` には年表の 4 欄（`chronicleStartTime`・`chronicleStartMinute`・`chronicleStartGranularity`・`chroniclePrecision`。optional）を足した（`ports.test.ts` の `TreeNodeData` → `CoreTreeNode` の代入確認が互換を守る）。`requireCoreProjectId` の引数は `{getTreeState()}` に広げた（`CoreReadContext` も満たす）。
4. **DR-MP4-37d project の検査が引数より先（DR-MP4-32c と逆の順。逸脱として記録）。** 4 本は legacy で no-project が先（PR-0 の記録：get_event_detail・get_character_timeline・get_chronicle_state・list_events）なので、core も `requireCoreProjectId` を最初に呼ぶ（DR-MP4-32c の「引数が先」は 7 本の元の順で、4 本の元の順は逆）。結果の順序は移す前のまま（golden に case がある）。await の順（events と scene-events と tree state の読み位置、get_chronicle_state の `activeSceneId` は sceneId 省略のときだけ読む）と結果の key 順も保った。`get_chronicle_state` は sceneId を指定したとき `getTreeState` が 2 回、省略したとき 3 回（試験で固定）。**差（実在しない状態）**：DR-MP4-32c が 7 本について記録した「空白だけの projectId の差」は年表 4 本にも当たる（`assertCoreProjectId` は `trim() === ""` で throw、旧実装は `!projectId` だけ〔4 本とも〕。`"   "` は旧実装では読み進めて 0 events や `No chronicle events` を返し、新実装は `No active project` を返す。id は UUID なので到達しない）。
5. **DR-MP4-37e `CoreToolCache` と `CoreReadPorts.cache` を削除した（DR-MP4-3・16 の字面との差）。** `ports.ts` 以外に使う箇所が無かった。`getOrLoad(name, key, load)`（文字列 key の async loader）では、legacy の「nodes の配列の参照を key にする読む順の slot」を表せず、loader が呼び手側の関数であることも要るので、core は cache を持たず loader port を受ける形に改めた（DR-MP4-32b と同種の改訂）。`SharedLoader`（単一 slot・key＝projectId・同一 key は in-flight を共有・失敗は slot を空ける）は pure なので `core/sharedLoader.ts` へ移し、`toolTurnCache.ts` は re-export する（import 元と `toolTurnCache.test.ts` は無変更）。`registerToolTurnReset`・registry は shared に移さない。legacy の `chronicleToolCache.ts`・`toolTurnCache.ts` は module singleton のまま（DR-MP4-16）。**DR-MP4-3 の「run_research の子 loop と Context Creator がその reset に依存する」の訂正**：Context Creator の tool は codex 3 本と snippets 1 本（`contextCreatorApi.ts` の `CREATOR_TOOLS`）で、年表の cache を読まない。依存するのは、共通の `runAgentLoop` が毎バッチ `beginAgentToolTurn()` を呼ぶ挙動だけ。run_research の子 loop は `runAgentLoop` をそのまま起動するので、子のバッチごとに親の cache を破棄する（余分な再ロードだけで stale にならない安全側。DR-MP4-16）。
6. **DR-MP4-37f 表の allowlist を 6 表足した（10 → 16）。** `events`・`event_participants`・`scene_events`・`event_relations`・`project_calendar`・`codex_entries`（`tables.ts`・`tables.test.ts` の `PINNED`／`NOT_YET`・`core.static.test.ts` の集合の一致。表の集合は 16 表と一致することを確認）。`electron/main/mastraRead/db.test.ts` の「拒否される表」の例は `codex_entries` から `codex_entry_phases` に差し替えた（試験の期待を黙って緩めたのでなく、例が足した表に当たらなくなったため。拒否の assert は残る）。
   - **信頼境界（DR-MP4-34g・35f と同型）**：allowlist は表名だけを検査し（列・where は見ない）、`core.static.test.ts` が守るのは「core の Drizzle が名指す表＝allowlist」で、tool 単位ではない。したがって main の db 経由の文は、**全 project の全行・全列**を読める：`events`（`secret` の出来事の `note`・`detail`・`reveal_scene_id` を含む）、`event_participants`・`scene_events`・`event_relations`・`project_calendar`、`codex_entries`（hidden の entry と私的な `notes` を含む全列）。
   - **`codex_entries` の根拠は先例と違う。** 先例は「その tool が既に返す内容」の範囲だが、年表 4 本が `codex_entries` から使うのは `id,name` だけで、hidden な行と私的な `notes` はどの tool も返さない。ここで採る根拠は、(i) renderer が generic な `db_execute` で同じ表を既に読めること、(ii) hidden の判定を通す Codex の tool（PR-8）が同じ表を要ること、(iii) **旗 L を開けるまで（4c-1 の配線まで）main の呼び手は無い**こと（`readCodexNames` は、この PR で main の ctx〔`chronicleMainContext.ts`〕から呼ばれる形になる。到達を止めているのは旗 L と 4c-1 の配線で、PR-8 ではない）。PR-8 も同じ表を要る。名前の reader は `id,name` の 2 列だけ select する（列を絞ることは allowlist では強制できない）。代案の「`codex_entries` は PR-8 で足し、PR-7a では名前の Map を別の経路で供給する」は、PR-8 が同じ表を要るので二度手間になり、main の adapter と実 addon の同値で名前の読みが覆えなくなるので退けた。送信先・保存範囲の拡大は無い。
   - **この表の追加の根拠**：NIR-1 の事前委任（AGENTS.md）は Mastra の lane に及ばないので、根拠にしない（この文書の冒頭の「委任の範囲」と、MP-3 の判断の冒頭と同じ）。根拠は、(a) DR-MP4-32・34・35 の冒頭と同じ基準（新しい契約・authority・送信先・保存範囲・閾値の緩和を伴わない）、(b) 脅威モデルの確定文面が変わらないこと（D16 の (3) は表の名前の一覧でなく「core が参照する表の allowlist」という規則で、表の増減は `tables.ts`・`tables.test.ts` の差分として見える）。**16 表はすべて PR-1（#997）の当初の 21 表の一部**で、DR-MP4-32e（PR-4）が core の触る 6 表に絞った後の再追加である（10 → 16 の 6 表は年表 5 表と `codex_entries`）。
   - **`events` は全列 select（projection にしない）。** projection で `secret`・`reveal_scene_id` を落とす・alias が食い違うと、型検査にも試験にも出ずに全 event が公開になる（fail-open。反証の記録 P2）。order は legacy のまま（`ordinal`、`id` の二段）で、ORDER BY の無い 3 文（participants・scene_events・relations）にも足さない（SQL が変わる。DR-MP4-33e(a)）。`events` の全列の結果が main の 10 秒の caller timeout や size に当たる規模かは未確認（DR-MP4-34h と同種。MP-13 の前の持ち越し）。
7. **DR-MP4-37g main の events は fail-closed に読む（`normalizeEventFailClosed`）。** `secret` が boolean でも 0/1 でもなければ throw、`revealSceneId`（または `reveal_scene_id`）が string でも null でもなければ（キーの欠落は undefined）throw。legacy の `normalizeEvent`・`boolFrom`（欠落・null・想定外の型を false＝公開にする）は変えない。
   - **narrow の限界（親の判断）**：Drizzle の `integer("secret", { mode: "boolean" })` は `Number(v) === 1` で復号する（`node_modules/drizzle-orm/sqlite-core/columns/integer.js` の `SQLiteBoolean.mapFromDriverValue`。`null` は復号されずにそのまま通る）ので、reader の戻りの時点で、DB の生の値が 2 なら `secret = false`、文字列は `"1"` なら `true`、それ以外（`"true"`・`"x"` など）は `false`（公開側）になる（`chronicleReaders.test.ts` が 2・`"x"`・0・1・`"1"` を固定。`"true"` は `Number("true")` が NaN になることからの読みで、試験には無い）。足した narrow が覆うのは、**select から列を落とした場合**（projection・alias の食い違い。行に key が無いので throw する。select に含めたのに driver が値を返さない場合は別。下記）と、Drizzle が変換せずに通す `null`（`secret` は NOT NULL default false なので正常な DB では起きない。renderer の `readEvents` は null を false として読むので、null の行では main が throw し renderer は公開として読む。fail-closed の向きの差）。**保存値そのものの異常（0/1 以外の整数・文字列）は覆えない。** また、select に `secret` を含むのに driver がその値を返さない場合（行の短縮など。値は `undefined`）は、Drizzle が `Number(undefined) === 1`＝`false` に写すので throw しない（試験で実測した。`revealSceneId` は text 列で `undefined` が残るので throw する）。固定の SQL を使う実際の経路では起きない想定で、legacy も同じ読み方（同値）。 renderer（legacy）も同じ読み方なので同値。
   - **この PR では client 層（`CoreReadDbClient` を包んで、events の select の生の値を検査する層）を足さない**（親の判断）。理由：(i) legacy と同値で挙動を変えない、(ii) core の規則（raw `sql` 禁止、DR-MP4-32f）に触れない設計を別に要する、(iii) CSR/1 で `events.secret` の読みをやめる予定。**足す条件：CSR/1 の後に再評価する**（`events.secret` の読みが残るなら、旗 L を開ける前に client 層を検討する）。特性として `chronicleReaders.test.ts` に固定した（初版の記述の「null も false になる」は誤りで、事実のとおり直した）。
   - 小さな不一致：判定は camel の `revealSceneId` を見て、値は camel が null で snake の `reveal_scene_id` が文字列のとき snake を採る。Drizzle の行は camel だけなので実害は無く、実装は直さず試験も固定していない。
8. **DR-MP4-37h main の tree の入力は 1 本の select の上位集合（PR-6 の記録 9 の別瞬間の解消）。** `readTreeRows` は PR-6 の 6 列の上位集合（`title`・`chronicle_start_time`・`chronicle_start_minute`・`chronicle_start_granularity`・`chronicle_precision` を足した）を select し（条件は PR-6 と同じ：`project_id` 一致・`archived_at IS NULL`）、`readChronicleReadInputs` が同じ行から `buildReadInputs` の入力と年表用の nodes（`buildChronicleNodes`）の両方を作る。PR-6 の記録 9 の「2 本の文は 1 つの snapshot ではない」のうち、年表用の nodes を別の select で作る案で起きる**読む順と、場面の title・年表の欄の食い違い（anchor と title が別の瞬間の行から作られる）は、1 本の select にしたので無い**。tree の select と `projects` の mode の select が別の瞬間である点は残る（年表 4 本は mode を使わない）。`readInputs.test.ts`（列の固定）と `src/features/chat/agent/readInputs.parity.test.ts`（renderer の store の node と比べる試験。6 列の期待が上位集合で落ちた）は上位集合に更新した（期待を緩めたのでなく、列が増えた分の更新）。
   - **読む順**：core は `getTreeState().nodes` の配列の参照をそのまま `getReadingOrder(nodes)` に渡し（legacy の memo が外れない。試験で `toBe` の同一参照）、戻りは `new Map(...)` でコピーして `Map` を取る関数へ渡す（型が `ReadonlyMap` と `Map` で食い違う。turn の間で共有しない）。main の `getReadingOrder` は渡された nodes によらず turn の読む順を返す。
9. **DR-MP4-37i main の cache は turn ごとの instance（Q5 待ち）。** `createMainChronicleReadContext`（`core/chronicleMainContext.ts`）が、`SharedLoader` 3 つ（events・sceneEvents・codexNames。key＝projectId）を factory の中で作る。module 大域の状態・registry・`registerToolTurnReset` の import は無い（静的な検査）。並行する 2 turn（同じ project でも）の cache・読む順・project は混ざらない（deferred の loader で交互に動かし、片方の `clear()` の最中も他方の in-flight は他方のデータ。試験）。同一 turn の同時 2 tool は in-flight を 1 つ共有し、失敗は保持せず、`clear()` の後に古い in-flight が slot に戻らない。`clear()` を提供し、各送信の前での配線は 4c-1（旗 L が閉・1 step の route で未使用）。events の reader は `readEventsFailClosed`。
   - **4c-1 への申し送り 1（liveness の検査の置き場）**：cache に当たった読みは、adapter の `assertLive`（`electron/main/mastraRead/db.ts` の文ごとの seam。D16 の (4)・W11）を通らない。今の 4 本は、データを返す経路で必ず cache しない読み（`getCalendar`・`listParticipants`・`listRelations`）を 1 回以上通る（`list_events` は `getCalendar`、`get_event_detail`・`get_character_timeline`・`get_chronicle_state` は `getCalendar` を含む 1 回の `Promise.all`）。ただし `get_event_detail` の `Event not found` と `get_chronicle_state` の `No chronicle events` は cache（events・sceneEvents）だけで返る（データを含まないので漏れにはならない）。**この性質は偶然のもの**で、cache だけで結果を作る tool（7b の `search_events` など）が来ると崩れうる。liveness の検査は 4c-1 で tool の execute の単位に置く。
   - **4c-1 への申し送り 2（`clear()` を呼ぶ時機）**：`clear()` の配線は 4c-1。**tool の実行中には呼ばず、step・送信の境界だけで呼ぶ**。`clear()` の前に渡した promise は古い世代のデータで resolve するので、tool の途中（events と sceneEvents の取得の間）で `clear()` が走ると、世代の違うデータで秘匿を判定しうる（推測。試験では確かめていない。W11 は tool の実行を直列にしているので、境界でだけ呼べば起きない）。
   - **legacy より弱くなる点（同値とは主張しない。Q5 待ち）**：legacy の cache は batch ごとに破棄される（`agentLoop` の毎バッチの `beginAgentToolTurn()`）ので、turn の途中に作者が UI から event の `secret` や `reveal_scene_id` を変えると、次の batch から変更が見える。main の cache は turn の間（`clear()` まで）変更を見ない。**向きは両方**：secret → 公開に変えても隠れたまま（狭い側）、**公開 → secret に変えても見えたまま（ADR 013 に対して広い側。隠すべきものが見える）**。ADR 013（hidden と年表 secret は「どの経路でも渡さない」）に対する保護の弱まりなので、**Q5 の窓として (f) に載せた**（DR-MP4-8 の「鮮度」・DR-MP4-26 の方針）。`chronicleMainContext.test.ts` の専用 describe に、両方向を期待を明記した特性試験として固定した（`clear()` または新しい context が要る）。**どの同値試験の対象にも入れない。** 緩和の候補（Q5 の回答の後に決める。今は入れない）：step ごと・tool call ごとに events・sceneEvents を取り直す、key に version や最大 `updated_at` を含める、各送信の前の `clear()` の配線（4c-1）。Codex 名も同じ寿命（turn の間）。
10. **DR-MP4-37j 既存の挙動 2 点は同値で写し、MP-13 の確認項目に載せる（確認要から技術判断に格下げ）。** (1) **Codex の hidden な entry の名前を 4 本が返す**：`primaryCharacter`・`location`・`participants[].name`・`character`・`codexNames` の名前の Map は hidden の entry も含む（legacy の `listCodexMatchTargets` と同じ。PR-7a の core も同じ）。(2) **`get_chronicle_state` は model の渡す `sceneId` で秘匿判定の位置を決める**：後ろの場面を指定すると、そこまでに開示済みの secret の出来事が見える（golden がこの `sceneId` 優先を固定している）。どちらも DR-MP4-24・35g の `get_foreshadow_detail` と同じ「既存の非対称」で、直さず、新しい経路（main）にも写る。直すのは別 lane（CSR/1 が `events.secret` をやめるまで PR-7 では直さない）。写す前に特性試験 13 件（`toolExecutors.chronicleCharacterization.test.ts` と別 fixture `chronicleCharacterizationSeed.ts`。PR-0 の seed には触れない）を**移す前の legacy で通してから移し、移した後も無変更で通った**。**旗 L を開ける前（MP-13）に、C-19・C-20 の状態を C-11 と並べて確かめる**（第 8.1 節）。issue の起票は親。
11. **DR-MP4-37k main の `activeSceneId` が読む順に無いときの差と、UI 言語。**
    - main の tree state の `activeSceneId` は PR-6 の `ReadInputs.currentSceneId`（live な場面で、読む順に入っているときだけ採り、それ以外は null）。legacy は tree store の `activeSceneId` をそのまま使う。差が出るのは **`get_chronicle_state` を sceneId 省略で呼んだとき**だけ：main は `No sceneId and no active scene` で止まり、legacy は store の値で進む。他の 3 本は `activeSceneId ?? ""`（空は secret を隠す）で、legacy でも読む順に無い場面では secret を隠す（DR-MP4-8）ので結果は変わらない。差は `chronicleMainContext.test.ts` に期待を明記して固定した（同値試験の対象外。fail-closed の側の差）。
    - **UI 言語**：port の型（`getUiLanguage`）と legacy の実装（`i18next.language === "en"` の完全一致だけが en。`"en-US"` や未知の値は ja。特性試験で固定）までを置く。**main の出所は Q4 で未決**（wire で運ぶなら新しい契約）。main の ctx の `getUiLanguage` は必須の引数で既定を持たず、ctx を作った時点では読まない。
12. **DR-MP4-37l 7b と別の担当への申し送り。**
    - 7b（`search_events`。反証の記録の直しで、7b で確定する。**〔DR-MP4-38a〜e で確定した〕**）：(i) 分岐の条件は `!CHAT_AGENT_IR_ENABLED && scope === undefined` のときだけ core（案）、scope があるときは既存の `chronicleCandidates` の経路を残す（定数 false かつ scope ありの既存試験〔`toolExecutors.chatIr.test.ts` の `h.gate.enabled = false` の case〕が通ること。load 時でなく呼出しごとに評価）。(ii) dense の `.catch` の置き場は legacy の port（DR-MP4-32b(v) の型）。main は throw が既定（「model 不在」の型付き kind は `MainReadErrorCode` に無い）で、実 addon の spec の `denseRejects` の case は byte 比較から外して差として記録する。(iii) hidden 判定は `allEvents` に無い hit の id を素通しする（Native が project で絞る前提）。main の cache が turn の間広がるので、取り直すか Q5 の窓として明記するかを決める。(iv) wire の `score` の narrow は number に加えて null を許す案（f32 の NaN・Infinity は null になる）。
    - CSR/1（`events.secret` の廃止）が先に入ると reader の列と `normalizeEvent` が変わる。着手の順序はセッション間の取り決め（handoff）で確かめる。
    - CSR/1 の後の client 層の再評価（7 の末尾）。
13. **DR-MP4-37m gate の追従（範囲は狭めない）。** `evals/impact-map.yaml` の `tool-policy` の paths に、`core/chronicleTools.ts`・`core/chronicleReadExecutors.ts`・`core/sharedLoader.ts`（`toolTurnCache.ts` から移した）と、その試験 `core/chronicleTools.test.ts`・`core/chronicleMainContext.test.ts`・`features/chronicle/readRows.test.ts` を 1 本ずつ足した（glob にしない。DR-MP4-32h・35j と同じ）。**rule に載せない**：`core/chronicleReaders.ts`（`api.ts` 由来）・`core/chronicleMainContext.ts`（main 用）・`features/chronicle/readRows.ts`（split 元の `src/features/chronicle/api.ts` は rule に当たらず全 suite を選ぶので、載せると選択が狭まる）・`chronicleReaders.test.ts`。**載せ方の実際（事実だけ。理由は未確認）**：`chronicleMainContext.test.ts` は rule に載り（`evals/impact-map.yaml`）、`chronicleReaders.test.ts` は載っていない（`readInputs.test.ts` など main 向けの他の試験も rule には無い）。rule に載らない file の変更は全 suite を選ぶので、載せない側は選択を広げる向き。Light suite（`scripts/quality/impact-map.mjs`）・GDX-TOOL-001 の `lightTests`・`impact-map.test.mjs` の一覧には両方が載っている。この 2 本で載せ方が分かれた理由は、コードにも記録にも読み取れなかった。`impact-map.test.mjs` は、新 core の名前を「toolExecutors 由来」の列に、`readRows` を `created` に足した（`splitFrom` の `api.ts` は既存）。tool-policy の Light suite（`scripts/quality/impact-map.mjs` の `LIGHT_SUITE_DEFINITIONS`）と GDX-TOOL-001 の `lightTests` に、`toolExecutors.chronicleCharacterization.test.ts` と electron の 4 試験（`chronicleTools`・`chronicleReaders`・`chronicleMainContext`・`readRows`）を足した（広げる向き）。`quality-manifest.yaml` は GDX-POLICY-001 と GDX-ARTIFACT-001 の `implementedBy` に `chronicleTools.ts`・`chronicleReadExecutors.ts`・`sharedLoader.ts`・`features/chronicle/readRows.ts` を足した（`chronicleReaders.ts`・`chronicleMainContext.ts` は足していない。足すかは親が決める）。`api.ts` を触るので PR の impact は全 suite になる（PR 本文に書く）。`scripts/local-ci-full-workload-allocation.json` の digest の対象（package.json・lock・catalog）は変えていない。
14. **DR-MP4-37n 検証の要点（実行した範囲）。**
    - **実 addon の spec（merge の条件）**：`pnpm napi:build` の後、`vitest.electron-native.config.ts` の全 file が通った（**14 file／89 件**）。`mastraReadParity.pipeline.spec.ts` の単独実行は 12 件が通り、年表 4 本の golden の byte 比較、hidden の名前と scene-own の anchor の実 Native の確認も通った。**ORDER BY の無い文（participants・scene_events・relations）の返り順は PR-0 の golden と byte で一致し、食い違いは起きなかった**（止める事態にならず、spec は緩めていない）。tie の順は seed に無いので未確認（DR-MP4-33e(a) と同種）。
    - golden は `CI=true`（書き換えなし）で無変更。4 本の golden の 44 case の `db_execute` の sql・params・method の列（150 文）が、`api.ts` を委譲にした前後で JSON として完全一致した。`chronicleReadTools.test.ts`・`chronicleToolCache.test`・`toolTurnCache.test`・chatIr 系は無変更で通った。
    - `pnpm test:electron --run electron/shared electron/main/mastraRead`（`core.static.test.ts`・`tables.test.ts` を含む）37 file／1,481 件、`CI=true vitest --run src/features/chat/agent src/features/chronicle` 137 file／2,302 件（5 skip）、`src/application`・`src/features/{map,editor,import,semantic-search,tree}` 487 file／3,991 件が通った。`tsc --noEmit` と `tsc -p electron/tsconfig.json --noEmit` は exit 0、`pnpm lint` は 0 error（既存の jsx-a11y の warning 43）、`pnpm validate:architecture` は exit 0（`api.ts` が `readDomain/core` を import する形は通る。cycle 0）。`node --test scripts/quality/impact-map.test.mjs scripts/ci-change-scope.test.mjs` は 104 件、`scripts/quality/eval-fixtures.mjs` は exit 0。
    - 変異（一時的に実装へ入れて試験が落ちるのを確かめ、戻した。8 種）：Codex 名の `name` 列を落とす、events の project 条件を外す、participants の project 条件を無効化、読む順を空にする、`clear()` を no-op にする、`get_event_detail` の project 判定の順を入れ替える、`readInputsReader` から `chronicle_precision` の列を落とす、main の ctx（`createMainChronicleReadContext`）の events の reader を `readEventsFailClosed` から `readEvents` に差し替える（最後の 1 つは、`chronicleMainContext.test.ts` に足した fail-closed の試験〔`secret` が null、`revealSceneId` が `undefined` の 2 件〕で 2 件落ちる）。レビューの指摘で `chronicleTools.test.ts` に fixture を足し、次の変異が落ちることも確かめた（戻した）：`getCharacterTimeline` の `Math.floor` を `Math.round`（2 件）・`Math.trunc`（1 件）に、birth の `Math.min` を「最後の値」（1 件）・「最初の値」（2 件）に、`cmpKeys` を `localeCompare`（1 件）・数値順（1 件）に、`sceneChronicle` の既定値を granularity `none`→`day`（1 件）・precision `exact`→`approx`（1 件）に。`cmpKeys` の実体は素の文字列比較なので「素の文字列比較にする」変異は等価変異で、`localeCompare` と数値順で確かめた。「`en` を `startsWith` にする」変異は、特性試験の file を明示して 2 回実行し、2 回とも同じ 2 件が落ちた（C1 の最初の 1 回が通った原因は、変異が試験の通る module に入っていなかったなど手順の問題と推測。未確認）。
    - main の 3 bundle（esbuild `write:false` の sha256）の base（2a473ff79 を取り込んだ HEAD の編集前）は `main.cjs` 9efeca2b…、`preload.cjs` 46d054ca…、`mastra-agent.cjs` 041f5ac4…。**編集後の値の取得と一致の確認は merge の条件で、この記録の時点では未取得**（PR 本文に書く）。この base の `main.cjs`・`preload.cjs` の値は DR-MP4-35k の記録（`main.cjs` 76fa8082…、`preload.cjs` 27e5476b…）と違う（`mastra-agent.cjs` 041f5ac4… は同じ）。`git diff --stat bb9ffafd4 2a473ff79 -- electron` は空で、electron 側の差分は無いので、測った worktree の環境（node_modules など）に依存すると推測される（原因は未検証）。**同じ worktree で base と head を比べる限り有効**で、別の worktree の値とは照合しない。`pnpm verify:quality`（Node 22）・`perf:budget`・renderer の bundle の差も未実行。

### DR-MP4-38 search_events（IR なしの部分）の read core 化（MP-4b PR-7b。技術判断。2026-11-23）

PR-7（B6 年表）の後半を core 経由にする PR-7b の、mutation の前の判断。DR-MP4-3・8・16・32・34・37 と Q5 の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない（表の増分なし：`MAIN_READ_TABLES` は 16 表のまま。確定文書〔脅威モデル〕の改訂なし：`events_semantic_search` は D16 (5) の caller timeout の対象と DR-MP4-6 の typed 4 本の範囲に既にある。tool の定義・schema・description の bytes は不変）。renderer の結果は 1 byte も変えない（PR-0 の golden が `CI=true` で無変更、特性試験が移す前の legacy で通って移した後も無変更で通ることで示す）。main はこの core をまだ呼ばない（旗 L は閉）。IR 版（`searchEventsWithIr`・`chronicleCandidates` の位置の filter・`chronicleReadingPosition.ts`）は renderer に残し、core と `ports.ts` には IR の語を書かない。
**番号について**：PR-7b は DR-MP4-38 を使う（PR-8 は 39 以降）。PR を開く直前に `origin/master` の decisions の最大番号を確かめ、衝突したら最後に merge する側が振り直す。この PR の本文中の参照は、この 1 行にある番号だけを一括置換すればよい形にしてある。

1. **DR-MP4-38a 範囲と分岐の条件。** `searchEvents`（`toolExecutors.ts`）の先頭 1 か所で、`!CHAT_AGENT_IR_ENABLED && !scope` のときだけ core（`chronicleSearchExecutor`）へ振る。呼出しごとに評価する（`READ_ONLY_EXECUTORS` が load 時に 1 度作られることと混同しない）。`READ_ONLY_EXECUTORS.search_events` も `searchEventsWithIr` の旗 false の fallback もここを通る。**scope があるときは旗が false でも今までの経路**（`chronicleCandidates`。scope の project・場面で動く。旗 false かつ scope ありの既存試験〔`toolExecutors.chatIr.test.ts` の E10 ほか〕は無変更で通る）。scope を core に振る案（scope から呼出しごとの ctx を作る）は、scope の意味を core に持ち込み IR の閉鎖に近いので採らない（要ユーザー確認の対象）。条件は `scope === undefined` でなく `!scope`（`chronicleProjectId`・`chronicleSceneId` の truthiness と同じ。型は null を許さないが、仮に null が来ても読みと分岐が分かれない。反証 P3-9 を採った）。どちらの経路を通ったかは、core の executor への spy で旗×scope の 4 象限と null、同じ executor で旗を false → true → false と切り替える呼出しごとの評価を固定した（`chronicleSearchPort.test.ts`。結果の byte 一致だけでは経路の取り違えが見えない）。
2. **DR-MP4-38b ctx と factory。** `CoreChronicleSearchContext`（`ports.ts`。`getTreeState`・`countTokens`・`chronicle` の `getEvents`／`getSceneEvents`／`getReadingOrder`・`native.eventsSemantic`）、`createChronicleSearchExecutors(ctx)`、`CHRONICLE_SEARCH_TOOL_NAMES`（1 本）。`CoreChronicleReadContext`（年表 4 本）と `CoreReadContext` は広げない（理由：広げると `chronicleReadContext.ts` が `semantic-search/api`・`debugLog` を import する形になり、`createMainChronicleReadContext` の literal、mainAdapter・実 addon の「年表は 4 本」の assert、`CHRONICLE_NO_PROJECT_CONTENT` に波及する）。**`CORE_READ_TOOL_NAMES`（11）・`CHRONICLE_READ_TOOL_NAMES`（4）・`CHRONICLE_SEARCH_TOOL_NAMES`（1）の 3 つの表は互いに素で、合計 16 本**（`chronicleSearchTools.test.ts`・mainAdapter・実 addon の spec が assert する。DR-MP4-37c の「7b は年表側に dense の port を足す形になる見込み」は、実際は専用の狭い型にした）。core の flow は legacy の順：空の query は `0 events found`（何も読まない・`countTokens` も呼ばない）→ project（`requireCoreProjectId`。**年表 4 本と逆で query が先**）→ limit → dense（`limit` は fetchLimit＝`min(limit×3, 30)`。`limit` が 0 になる 0 < x < 1 でも呼ぶ）→ events → sceneEvents → tree state（nodes と activeSceneId を 1 回・同期で。await の後）→ hidden を先に落としてから `slice(limit)`。`eventSearchLimit`・`eventSearchFetchLimit` は core に 1 つだけ置き、`toolExecutors.ts` の `chronicleCandidates`（IR・scope 経路）も import して使う（単一の出所。反証 P3 の取捨は報告に記録）。renderer の薄い層は `chronicleSearchPort.ts`（core の `chronicleSearchTools.ts` と basename が重ならない別名。反証 P3-8 を採った）。
3. **DR-MP4-38c dense の握りの置き場（legacy の port。core と main は throw）。** `denseEventHitsOrEmpty`（`chronicleSearchPort.ts`）が `eventsSemanticSearch(args).catch(...)` の形で「warn して空」にする唯一の置き場で、`chronicleCandidates` も同じ関数を使う（message・引数は同一。`toolExecutors.ts` に握りの message は残らない。静的に固定）。core が握ると、main の cancel・forced end・caller timeout（`MainReadError("timeout")`）・workspace 不一致（`SEMANTIC_INDEX_WORKSPACE_CHANGED`）が「成功の 0 件」に化ける（DR-MP4-32b(v)・W11 の流儀）ので握らない。**「model 不在」の型付き kind は足さない**（Native に構造化された code が無く〔`runtime.rs` の message 文字列のみ〕、message の分類か N-API／契約の拡張になる＝新しい契約。要ユーザー確認）。帰結：PR-0 の golden の「dense が reject したら空配列に退避する」case は main では tool error（throw）になり、**main では byte 比較しない**（mainAdapter と実 addon は golden の 10 case を case 名→native の表〔`canned`／`empty`／`rejects`／`none`〕で結び、表に無い case は落ちる。`rejects` は throw と「`[]` にならない」を assert する）。renderer の結果は変わらない（legacy の port が握る）。差は MP-13 の C-21 に載せる。
4. **DR-MP4-38d 壊れた wire の narrow と、legacy との差。** core は wire を fail-closed に narrow する：配列でなければ throw、行が object でなければ throw、`eventId`・`title`・`kind` が string でなければ throw、**`score` は number か null**（Rust の `f32` が NaN・Infinity のとき serde_json は null にする。legacy は null をそのまま JSON に出すので、null を throw にすると壊れた wire でない値の差が出る）。余計な key は捨てる（出力は 4 key）。legacy は wire を型だけで信じ、壊れた wire では `hits.filter` の TypeError か欠けた key が落ちるだけだった。実在する Native はこの形を返さない。**差の試験は同値の特性試験と別 file**（`chronicleSearchTools.test.ts` の narrow の describe）に置いた。**もう 1 つの差（37d と同型）**：空白だけの projectId は、legacy は `!projectId` だけなので読み進め、core は `trim() === ""` で `No active project`（falsy の `""`・null・undefined は同じ。core 単体と legacy の特性試験の両方で固定）。id は UUID なので到達しない。
5. **DR-MP4-38e hit の素通しと、main の search の呼出しごとの取り直し。** hit の id が `allEvents` に無いとき、legacy は hidden の対象外として素通しする（Native が `WHERE e.project_id = ?` で project を絞る前提。`events_search.rs`）。PR-0 の golden の S1・XPROJ の case が `x-ev-1` の素通しを固定しているので、**同値で写す**（取り直して落とす〔fail-closed 化〕は、renderer の結果と golden が変わるので採らない。要ユーザー確認）。core 単体に名前つきの試験、変異（「無い id を hidden とみなす」「無い id で events を取り直す」）で固定した。
   - **反証の記録 P1（親の決定 2）**：当初の「main の events cache が turn の間広がる窓は新しい弱さではなく Q5 (f) の一例」は事実に反する。`list_events` などは cache にある行だけを返すので、cache の後に作られた secret event は一覧に出ない（不在が安全側）。`search_events` は hit を hidden の補集合で通すので、**cache に無い id は hidden に入らず、secret event の title が model に出る**（Native の索引は全件を持つ）。つまり不在が fail-open になる**新しい種類の窓**で、legacy は batch ごとの破棄と write tool の `invalidateChronicleToolCache` で持たない。**「新しい弱さではない」は撤回する。**
   - **解（案 (a)）**：main 用の search の ctx（`createMainChronicleSearchContext`。`chronicleMainContext.ts`）は、**`search_events` の呼出しごとに events と scene_events を取り直す**（`SharedLoader` を通さない。events は `readEventsFailClosed`）。core と legacy の挙動は変わらず、golden も無変更。dense が先で events が後なので、index にある event は取り直した events に入る（dense の後・events の読みの前に event が削除された場合は、その hit が素通しになる競合が残る。legacy にも同じ競合があり、cache がある分、legacy の方が広い）。これで「不在が fail-open になる種類の窓は、main の search では呼出しごとの取り直しで作らない」。`chronicleMainContext.test.ts`・mainAdapter・実 addon の spec が、(i) 同一 turn で `list_events` が cache を温めた後でも `search_events` は呼出しごとに読む（SQL の回数）、(ii) cache の後に secret にした／作った event の hit は次の呼出しで落ちる、を固定する。**PR-7a の「同一 turn で `list_events` と `search_events` が events を 1 回だけ読む」とは逆**（この ctx は 4 本の cache と共有しない）。4c-1 の write 後の `clear()` とは別に、search では窓を legacy 並みに閉じる。
   - **素通しの安全性は 2 つに依存する**（反証の記録 P2）：(1) Native が索引を project で絞ること、(2) events が呼出しの時点のものであること。mainAdapter の XPROJ の case は fake が他 project に main の id を返すので素通しで出る（実 Native では出ない）と名前つきの試験で明記し、実 addon の spec が、実 dense が答えるとき全 hit の eventId が当該 project の events に含まれることを outcome 分岐で assert する。
   - CSR/1（`events.secret` の廃止）が入ると hidden の判定ごと消え、この素通しは無くなる。
6. **DR-MP4-38f hidden の算出の集約。** `chronicleTools.ts` に `hiddenEventIds(events, currentSceneId, {readingOrder, sceneEvents})`（純関数）を切り出し、7a の `visibleEventIds` はその補集合にした（7a の試験は無変更で通る）。**主張は「core の hidden 判定を 1 か所に集約する」**で、`isEventHiddenFromAi` を呼ぶのがこの 1 か所だけとは言わない：`projectVisibleChronicle`（`get_chronicle_state` が使う）、renderer に残る `chronicleCandidates`（IR・scope 経路）と `chronicleWriteTools.ts` も呼ぶ（反証 P2-4）。tree state の読み位置は呼び手に残す：`visibleEventIds` は 7a のとおり sceneEvents の await の**前**、`searchEvents` は legacy のとおり events・sceneEvents の await の**後**（2 つの順は逆で、search が `visibleEventIds` を流用すると読み位置が変わる。変異 14 と特性試験の「sceneEvents の最中の切替」で固定）。
7. **DR-MP4-38g main の部品と信頼境界。** 表の増分なし・確定文書の改訂なし（冒頭）。(i) **返却段の filter が main でも唯一の出口の防御**：Native の `events_semantic_search` は索引が全件で、hidden な secret event の title を hit として返す。core は model に返す前に `hiddenEventIds` で落とす。main は `search_events` を core 以外で実装しない。(ii) 空でない query・project ありの呼出しは必ず Native 呼び（`assertLive` が送信前と応答後に走る）を通るので、7a の申し送り 1（cache だけで結果を作る tool は liveness の検査を通らない）は `search_events` では保たれる。**ただし偶然**で、4c-1 は tool の execute の単位に liveness の検査を置く（7a の申し送り 1 のまま）。(iii) dense の失敗は main では throw（38c）。(iv) 送信先・保存範囲の拡大は無い。
   - **4c-1 への申し送り**：(1) dense の握りが無い main の tool error の見え方（UI の文言・retry は Q4 の側）。(2) write tool（`create_event` 等）が main に来るとき、write 後の events cache の無効化（`clear()`）を legacy の `invalidateChronicleToolCache` と同じ位置に置く（`search_events` は 38e で取り直すが、4 本の cache は別）。(3) UI 言語は `search_events` では使わない（`CoreChronicleSearchContext` に `getUiLanguage` は無い）。
8. **DR-MP4-38h 旗 L を開ける前に見せる項目（MP-13。確認ではなく確かめる点）。** **C-21**：model 不在・feature 無効・未 index・workspace 不一致で、`search_events` が legacy では `0 events found`（空）、main では tool error になる（画面で見える差。38c）。**C-22**：hit の素通し。**既存の fail-open の同値の写し**（Native の project 絞りに依存。main は呼出しごとの取り直しで cache の窓を作らない。38e）。
9. **DR-MP4-38i gate の追従と検証の要点。** `evals/impact-map.yaml` の `tool-policy` の paths に `core/chronicleSearchTools.ts` と `core/chronicleSearchTools.test.ts` を 1 本ずつ足した（glob にしない。DR-MP4-37m と同じ）。`chronicleReadExecutors.ts` は載っている（factory をここに足した）。`chronicleMainContext.ts` は rule に載せず全 suite のまま（7a と同じ。search の ctx もここ）。renderer の新 file は `src/features/chat/agent/**` の rule に当たるので追加不要。Light suite（`impact-map.mjs`）・GDX-TOOL-001 の `lightTests`・`impact-map.test.mjs` に、`toolExecutors.searchEventsCharacterization.test.ts`・`chronicleSearchPort.test.ts`・`chronicleSearchTools.test.ts` を足し、GDX-POLICY-001／GDX-ARTIFACT-001 の `implementedBy` に `chronicleSearchTools.ts` を足した（広げる向き。評価範囲は狭めない）。PR の impact は `toolExecutors.ts` を触るが、「全 suite」とは書かず `selectImpact` の実測を PR 本文に書く（反証 P2-6）。chatIr の件数は 110（vitest の実行件数。grep の 78 は `it` の行数）。
   - **検証（実行した範囲。数値は PR 本文）**：特性試験 38 件（commit ①は移す前の legacy で通した。commit ②で、`getState` の mock を呼ぶたびに snapshot を返す形に 1 行強めた〔「tree state を dense の前に読む」変異を捕まえるため。同じ object を返す mock だと見逃す〕。強めた形でも、移す前の legacy で通ることを確かめた）、core 単体、main の ctx、mainAdapter の golden 10 case、実 addon の spec（`vitest.electron-native.config.ts`）、main の 3 bundle の sha256 は base と一致、変異試験は PR 本文に記録。**`verify:quality` と `napi:build` は親が回す。**

### DR-MP4-39 Codex の hidden 判定の入口（MP-4b PR-8a。技術判断。2026-11-23）

PR-8（B5 Codex hidden）の前半の PR-8a の、mutation の前の判断（実装の途中で確定した点を含む）。DR-MP4-3・6・8・32・34・35・37 の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。**tool は 1 本も動かさない**（`search_codex`・`list_codex_by_type`・`search_codex_by_tags`・`find_related_entries` は PR-8b〔DR-MP4-40〕）。tool の定義・schema・結果は 1 byte も変えない（renderer の公開関数のシグネチャと、falsy な `projectId` で project 条件が消える挙動も不変）。main はまだ core を呼ばない（旗 L は閉）。
**番号について**：DR-MP4-38 は PR-7b（別の枝）が使う。PR-8a は 39、PR-8b は 40。年表の lane（CSR/1）は DR-MP4 の連番を取らない。

1. **DR-MP4-39a PR-8 を 8a と 8b に分ける。8c（`CoreChronicleData` に member を足す PR）は作らない。** 8a は判定の入口・port・表・main の組み立てだけで、tool を動かさない。8b が 4 本を core 化する（8b は 8a の merge の後に master を取り込んで作る。`ports.ts`・`tables.ts`・impact-map・試験の本数固定を両方が触る）。分ける理由：allowlist の追加と信頼境界の記録を 4 本の diff から切り離す。共有の呼び手（beat・inline AI・foreshadow・`codexYomi`）の回帰を単独で見られる。CSR/1 の N8 は 8a だけを待てばよい（4 の条件つき）。`CoreChronicleData` への member は、誰も読まない port を作らせない方針（DR-MP4-32b(iii)）の例外になり、ctx を literal で作る試験に波及するので、CSR/1 の PR が member と 2 つの実装（renderer・main）を一緒に足す。8a が置く関数の署名が、そのまま member の署名になる。
2. **DR-MP4-39b 判定の純関数 `decideCodexAiVisibility`。** 置き場は `electron/shared/readDomain/features/codex/context/codexAiVisibility.ts`（`src/features/codex/context/` を mirror。相対 import は `.js` 付き、`@/` 不可）。renderer の `resolveCodexForAi` の後半（anchor の作り方〜`released` の判定）をそのまま移した。renderer の `resolveCodexForAi` は、**DB 読みの 2 select・falsy projectId の分岐・entries 0 件の早期 return・`withDetails` の枝・`usePhaseStore` を読む位置（phases の await の後）を legacy に残し**、判定だけをこの関数に載せ替えた。`CodexTextForAi` の型も純関数側へ移し、renderer の `codexHiddenFromAi.ts` が re-export する（公開 API は不変）。
   - **受入れ：移す前の legacy で通した特性試験 24 件**（`codexHiddenFromAi.characterization.test.ts`。実 sql.js の上。SQL の列〔projectId あり／空・未指定・null、`withContent`、`withDetails` の追加の 2 文、ids 0 件は 0 文、全 id が DB に無ければ phases を読まない〕、store を読む位置、reading・story・auto〔物語時間が揃うとき／揃わないとき〕、base 公開を Phase が hidden にする、base の hidden を Phase が解除する、場面なし・空・空白・読む順に無い id が同じ結果、sceneId の trim、挿入順、`dropCodexHiddenFromAi` の summary の置換、`visibleCodexForAi`）が、載せ替えの後も無変更で通った。既存の `codexHiddenFromAi.test.ts`（5 件。`isCodexContextModeHiddenFromAi` の 1 件を含む）・`toolExecutors.codexHidden.test.ts`（17 件）・`toolExecutors.test.ts` の hybrid 2 件（8a では 4 本は legacy のまま）・`inlineAiContext`・`buildBeatContext`・`useBeatGeneration`・`codexYomi.*`・foreshadow の hidden 関連・PR-0 の golden は無変更で通った。
   - **mock の seam は外れない**：`resolveCodexForAi` の内部（`resolvedCodexContext`・`codexVisibilityPolicy`・`sceneTimeIndex` の src 側の mirror）を `vi.mock` する試験は 0 件（grep で確認）。純関数は readDomain の同じ module を直接 import するだけで、`codexHiddenFromAi` を mock する試験は `resolveCodexForAi` ごと差し替えるので影響しない。
3. **DR-MP4-39c ports。** (i) `CorePhaseState.resolutionMode` を判別型 `CorePhaseResolutionState`（`{kind:"resolved", mode}` か `{kind:"unresolved", reason?}`）に直した（誰も使っていなかった型。`ReadInputMode` が代入できる）。(ii) `CoreCodexData.listPhases(entryIds)`（Phase の行を運ぶ loader port）と `CoreCodexVisibilityPorts`（`getDb`・`getPhaseState`・`codex`）を足した。**Phase を `getDb()` で読まず loader port にした理由**：`toolExecutors.codexHidden.test.ts` は `@/features/codex/phaseApi` を mock し、`@/db/client` を where を解釈しない fake にしている。core が `getDb()` で Phase も読むと Phase の試験が全部落ち、試験の期待を変えることになる（変えない方針）。renderer の port は既存の `listPhasesByEntryIds` を arrow の中で呼ぶ（8b。PR-5b・7a の型）。entries は `getDb()` で読む（列の key 名を legacy と同じ `id`・`summary`・`contextMode`〔`withContent` のとき `content`〕にそろえた）。(iii) `CoreReadContext` は広げない（別の ctx。DR-MP4-37c と同じ理由）。現在の場面と project は呼び手が引数で渡す（新しい場面の port は作らない）。(iv) 入口ごとの project の検査の差：`resolveCodexAiVisibility` は ids が 0 件でも先に project を検査する。`dropHiddenCodexRows` は空の rows では project を検査せず何も読まない（renderer の `dropCodexHiddenFromAi` と同じ形。漏れる向きではない）。8b の呼び手はこの差を前提にする。
   - core の入口は `core/codexVisibility.ts`（`resolveCodexAiVisibility`・`dropHiddenCodexRows`・`listHiddenCodexIds`）、reader は `core/codexReaders.ts`（`readCodexVisibilityEntries`・`readCodexPhases`。legacy と同じ列・同じ条件・同じ並び）、main 用の組み立ては `core/codexMainContext.ts`（`createMainCodexVisibilityPorts({db, inputs})`。turn の `ReadInputs` から `getPhaseState` を作る。module 大域の状態なし。製品の呼び手は無い）。**await の順は legacy と同じ**：entries → phases → その後で `getPhaseState()`（試験で固定）。id は 500 件ごとに分ける（`sceneBody.ts` の `BODY_CHUNK` の先例。500 以下は 1 文で、legacy と同じ文の形）。project の空は `CoreProjectRequiredError`（`resolveCodexForAi` の falsy 分岐は持ち込まない。ids が 0 件でも先に検査する）。失敗は catch しない（tool が失敗し、AI へは何も渡らない）。
4. **DR-MP4-39d `unresolved` は渡された id を全部 hidden にする。** DR-MP4-6 の 3 項・DR-MP4-8 の文面（「unresolved は hidden。base anchor で解決する案は採っていない」）どおりで、純関数の冒頭の分岐（anchor は解決せず、entries を全部 hidden・texts は空）。順序は legacy と同じ（`listPhases` の後で `getPhaseState()` を読み、その後で分岐する。unresolved でも DB の読みを省かない）。**退けた案**：(a) base anchor で解決する（公開 → hidden の Phase を持つ entry が公開のまま残る開示側にずれる。DR-MP4-6 の 3 項が既に退けた。採るなら DR-MP4-8 の変更でユーザー確認）。(b) 「Phase を持つ entry だけ隠し、持たない entry は base の mode で判定」（Phase 0 件の entry は mode に依らず結果が同じなので漏れないが、記録済みの規則より狭く隠す読み替えになる。得るものは `project-missing` のとき〔entries が 0 件〕には何も無い）。
   - **到達性（断定しない）**：`projects.phase_resolution_mode` は `migrate.rs:530-531` の CREATE TABLE で `NOT NULL DEFAULT 'auto' CHECK (IN ('reading','story','auto'))` なので、新しい DB では project 行が無いときだけ unresolved に届く（そのとき project 条件つきの entries の select も 0 件で、legacy の「DB に無い id は hidden」と結果が同じ）。**この CHECK が全ての実 DB にあるかは確かめていない**（旧形の fixture は CHECK を持たない。`migrate.rs:13627`・`:14129`）。ただし unresolved は結果が「隠す」側なので、到達しても漏れる向きではない。null・不明値・空の mode と project 行なしは、`codexVisibility.test.ts`（実 SQLite）と main の adapter の上の試験（project 行が無い入力）で固定した。legacy は unresolved を持たない（store に常に値がある）ので、差は「実在しない状態」だけ。**画面で見える差**は、旗 L が開く前の main でだけ起きる異常時（project 行が無い・mode が取れない）に、Codex の道具が空になること。旗 L を開ける前の確認項目（MP-13）に、C-19・C-20 の隣で載せる。PR-8 の merge の条件にはしない。
   - **K-20 (1) の Codex 側の解消：legacy と同値である**（fail-closed ではない）。現在の場面なし（base anchor）と、読む順に無い場面（`current-scene-missing`）は、Codex では同じ結果になる：どちらも `applicablePhases: []`（`resolveApplicablePhases.ts` の base 分岐と `current-scene-missing` 分岐）で、`resolveCodexState` は base の state を返す。違うのは `fallbackReason` だけで、判定にも texts にも使われない。したがって**現在の場面が読む順に無いと、公開 → hidden の Phase は効かず、base で判定される**（DR-MP4-1 の「Codex は base」）。これは `unresolved` を全 hidden にする規則とは別の向きで、legacy から変えない。年表は逆で、場面が読む順に無ければ secret を隠す（DR-MP4-1）。**K-20 (1) と DR-MP4-6 の記録 3 が名指す `resolveTemporalAnchor` という名前は `src`・`electron` に無い**（anchor の実体は `codexHiddenFromAi.ts` の `sceneId?.trim()` の分岐だった）ので、記載を訂正する。
5. **DR-MP4-39e `getPhaseState` に project の束縛を持たせた（反証 B-1）。** `CorePhaseState.projectId`（任意）に、main は `ReadInputs.projectId` を載せ、renderer の live の store は project を持たないので省く。`resolveCodexAiVisibility`（`dropHiddenCodexRows`・`listHiddenCodexIds` を含む）は、phase state が project を名乗り、それが引数の project と違えば **throw する**（全 hidden にしない）。理由：別 project の `sceneTimeIndex` では Phase の anchor が読む順に無く全部 skip されるので、base が公開で Phase が hidden にする項目が公開のまま通る。呼び手の取り違えの問題で、throw なら tool が失敗するだけで AI へは何も渡らず、黙って隠して不具合を見えなくしない。検査は phase state を読んだ後（await の順を legacy に合わせるため）で、entries が 0 件のときは phase state を読まないので検査も走らない（何も読んでいないので漏れない）。試験：core・main の組み立て・main の adapter・実 addon の spec に別 project の入力を渡す例を置き、検査を外す変異で落ちることを確かめた。
6. **DR-MP4-39f 「Phase 解決つきの hidden id」の port の契約（CSR/1 N8(a) 用）。** 案を 4 つ比べて D4 を採った（CSR/1 の Q4 の案 A・B と衝突しないよう D1〜D4 と呼ぶ）。D1：名前の Map から hidden を除く（`getCodexNames` の置き換え。id が残り、`?? codexId` の fallback が hidden の id を出すので「参照を除く」を満たさない）。D2：project 全体の hidden 集合 `(projectId) => Set`。D3：visible の許可集合。**D4：ids を受ける `(projectId, ids) => Promise<ReadonlySet<string>>`（採用。場面は ctx に固定）。**
   - **D2・D3 を退けた理由（書き直した。反証 B-3）**：年表の tool が除く対象を入力の段で（`projectVisibleChronicle` の前に）判定するなら、判定する id は出力に出る id でなく、project の events・参加者に現れる distinct な Codex id 全部（数百以上になりうる）になる。D2・D3 は毎回 project 全体の entries と全 Phase を読む。D4 は渡した id にだけ読む（呼び手が必要な id だけ渡せる）。D4 でも id が 500 件を超えれば entries と phases の文は複数になる。D3 は「DB に無い id」が visible の集合に入らず隠れる側に落ちるが、legacy の規則（DB に無い id は hidden）は D4 が同じ形で持つ。`unresolved` のとき D4 は渡した id を全部返せる。
   - **契約**：`listHiddenCodexIds(deps, {projectId, entryIds, sceneId}): Promise<ReadonlySet<string>>`。CSR/1 が `CoreChronicleData` に足す member は `listHiddenCodexIds(projectId: string, ids: readonly string[]): Promise<ReadonlySet<string>>`（**場面は引数に取らず、ctx の `getTreeState().activeSceneId` を呼出し時に読む**。`get_chronicle_state` のモデルの `sceneId` を hidden 判定の位置に使わない。型で強制する。main は turn 開始の `ReadInputs.currentSceneId`）。**cache しない**（呼出しごとに entries と phases を読む）。hidden と存在しない id（別 project の id を含む）を区別しない。失敗（reader の throw）はそのまま伝える（年表側で「その参照を除く」にするかは CSR/1 の決定）。
   - **CSR/1 の Q4 は回答済み**（ユーザーが 2026-11-23 に「案 A：場面ごとの hidden の切り替え〔Phase〕まで計算する」と決定。確認 127、年表の lane 経由）。**「CSR/1 は 8a だけを待てばよい」は、この案 A が選ばれた場合の話**で、案 B（場面に依らず、base が hidden かどこかの Phase が hidden の人物を常に外す）なら sceneId を取らない別の純関数が要る。8a が先取りするのは `listHiddenCodexIds` の薄い wrapper とこの契約だけで、`resolveCodexAiVisibility`・`dropHiddenCodexRows` は Q4 と無関係に 8b の 4 本が要る。
   - **共有するのは判定の純関数で、読みの半分（id の重複除去・DB に無い id は hidden・早期 return）は legacy と core の 2 か所に残る。** renderer の年表の配線を core の `listHiddenCodexIds` に寄せる案は採らない（renderer の codex ports は 8b で入るので、「CSR/1 は 8a だけを待てばよい」が崩れる）。ずれは `codexHiddenFromAi.coreParity.test.ts`（renderer の fake db 上で、legacy と core の hidden・texts を挿入順まで比べる。store の 4 種〔reading・story・auto で物語時間が揃う／揃わない〕×場面 8 通り×`withContent`。同順位の Phase を含む）と、main の adapter の上の同値（PR-0 の seed。reading・story・auto×場面 7 通り）が見張る。
   - **CSR/1 への申し送り**：(1) 出す前の Codex id を集めて **tool 呼出しごとに 1 回**呼ぶ（cache しない）。(2) id を集めるのは、枠の取り合いが hidden を含んだまま決まらないよう、`projectVisibleChronicle` の前（入力の段）。(3) 年表の Codex id の fallback（`names.get(id) ?? id`）に hidden の id が出ないよう、「除く」処理は名前の解決より前。(4) `get_character_timeline` の入力 `codexId` が hidden なら、存在しない id と同じ分岐を通す。(5) renderer 側は `resolveCodexForAi` が `@/db/client` を import するので、`chronicleReadContext.ts`（db を import しない方針）からは arrow の中の動的 import にする。(6) 参照を除くとき participants の行を落とすか名前だけか、`primaryCharacter`・`location` を空にするか、reader の失敗の扱いは**画面（チャット）に出る挙動**なので、CSR/1 の起案の確認で一覧にしてユーザーに伺う。
7. **DR-MP4-39g 表の allowlist を 1 表足した（16 → 17）：`codex_entry_phases`。** `tables.ts`・`tables.test.ts` の `PINNED`（`NOT_YET` から外した）・`core.static.test.ts` の集合の一致（reader が `codexEntryPhases` を own name で import して `from` に使う）。足すだけでは `core.static` の「余り」で落ちるので reader とセットで足した。`codex_phase_detail_overrides`・`codex_detail_definitions`・`codex_detail_values` の 3 表は `get_codex_entry`（`withDetails` を使う唯一の tool。legacy に残る）を移す PR まで足さない（`NOT_YET` に残す。負の対照）。`electron/main/mastraRead/db.test.ts` の「拒否される表」の例は `codex_entry_phases` から `codex_detail_values` に差し替えた（試験の期待を緩めたのでなく、例が足した表に当たらなくなっただけ。拒否の assert は残る）。
   - **信頼境界（DR-MP4-34g・35f・37f と同型。確かめた事実だけ）**：allowlist は表名だけを検査し（列・where は見ない）、`core.static.test.ts` が守るのは「core の Drizzle が名指す表＝allowlist」で tool 単位ではない。したがって main の db 経由の文は、**`codex_entry_phases` の全 project の全 Phase の全列**（`summary_override`・`content_override`〔hidden な項目の Phase の私的な本文を含みうる〕・`context_mode_override`・`anchor_node_id`・`label`・`created_at`・`updated_at`・`version`）を読める。reader が実際に使うのは判定と released の置換に要る列だが、列の絞りは allowlist では強制できない。reader は resolver の入力型（`CodexEntryPhase`）に合わせて全列を select する（legacy の `listPhasesByEntryIds` と同じ列・同じ並び）。`codex_entry_phases` は `project_id` 列を持たない（`migrate.rs:906-919`）ので、project の分離は「project 条件つきで取った entry の id だけで引く」ことで守る（reader のコメントに明記。試験で「project 条件のために別 project の entry の id は引かれない」を固定した）。
   - **根拠（NIR-1 の事前委任は使わない）**：(i) PR-1（#997）の当初の 21 表に入っていた（`ce1b621f8:electron/shared/mastraRead/tables.ts`）。PR-4 が core の触る 6 表に絞った後の再追加。(ii) renderer が同じ表を generic な `db_execute` で既に読める（`phaseApi.ts` の `listPhasesByEntryIds`）。Native でも D2a の台帳の外（`D2A_UNLISTED_SCHEMA_TABLES`、`execute.rs:4747`）で、`codex_entries`・`codex_entry_tags` と同じ区分（restricted で止まる区分ではない）。(iii) **旗 L が閉じているので main の呼び手が無い**（`createMainCodexVisibilityPorts` の呼び手は試験だけ）。列ごとの事実（`toolExecutors.ts` の 4 本と `getCodexEntry` の結果の組み立てを読んで確かめた範囲）：`summary_override` は、Phase で解除された項目の summary として Phase 解決後の値で返る（main に載る 4 本〔8b〕と `dropHiddenCodexRows`、legacy の `get_codex_entry`）。**`content_override` は、main に載る 4 本は返さない（4 本の結果は id・name・type・summary だけ）が、legacy に残る `get_codex_entry` は released の項目に Phase 解決後の本文を `body` として返す**（`resolveCodexTextForAi(..., true)`。この tool が main に載るのは MP-13 の前の C-6 の判断の後で、載せるときに再確認する）ので、「どの tool も返さない」とは言えない。`label`・`anchor_node_id`・`context_mode_override`・時刻・version を結果に載せる tool は、読んだ範囲には無かった（全 tool を確かめたのではない）。**「tool が既に返す内容を超えない」とは書かない**（`codex_entries` のときと同じく、表の全列は tool の出力より広い）。`codex_entries` の全列は DR-MP4-37f で記録済みで、範囲は変わらない。
   - **増えないもの**：新しい契約・authority・送信先・保存範囲・閾値の緩和は無い。main の caller timeout（`db_execute` 10 秒）は変えない。tool の定義・schema・結果は不変。
   - **脅威モデル（確定文書）は改訂しない**：T13・D16 の (3) は表名の一覧でなく「core が参照する表の allowlist」という規則で、表の増分は `tables.ts`・`tables.test.ts` の差分として見える運用の範囲（DR-MP4-34g・35f・37f と同じ）。D16 の (4)（read の開始の直前と await の後の `assertLive`）は、判定を cache しない（9）ので、DR-MP4-37i の申し送りは増えない。**§9.2 の「後続（4b）」の行（「262（T4）：read tool の入力は T4 に混ぜない。hidden・年表 secret の入力〔DR-MP4-8〕は上の新しい行で扱う」）は PR-8 では書かない**（脅威モデルの重要な変更は、ユーザーの確認の後。第 7 節）。持ち越し先は 4b の最後の PR、または 4c-2（Q5 の回答の後）。PR-8a は main が hidden の判定を実際に実行できる最初の PR だが、旗 L が閉じており、呼び手は試験だけである。
8. **DR-MP4-39h 持ち越しと、受容する窓。** (1) `core/sceneBody.ts` の project 条件（DR-MP4-32 の 11）と typed read の fts の workspace 照合（DR-MP4-34i）の決定時期を、「PR-8 の前（前後）」から**「main の ctx を最初に繋ぐ 4c-1 の前」へ移す**。技術判断で、旗 L は閉のまま。理由：PR-8 の 4 本は本文 reader を使わず（本文を読むのは `get_scene`・`get_thread_scenes` だけ）、fts の引数を変えるのは typed read の契約を変える新しい契約になる（ユーザー確認の対象）ので PR-8 は変えない（`assertLive` に頼る）。(2) **`storyTimeOrder` の undo の食い違い**（削除の undo の後、store と DB の `storyTimeOrder` が食い違う。DR-MP4-6 の記録の 11）と **turn の途中の `phase_resolution_mode` の変更**は、Q5 (b)(d) の窓として受容を明記し、PR-8a の同値試験の対象外とする（store を通らない。fixture は入れない側を選んだ）。main の入力は DB から turn 開始時に作るので、`story`・`auto` の Phase 解決が legacy と両方向にずれうる。(3) **K-4**（`localeCompare`〔ICU〕が Chromium と Node で同じ並びか）は未確認のまま：Phase の並びは `created_at` → `id.localeCompare`。同順位（同じ時刻・同じ場面）の Phase を fixture に含め、legacy と core が同じ結果になること（renderer の fake db 上）と、実 SQLite・実 addon の上で id の順に並ぶことを固定した。ASCII の id では ICU による差は見込まないが、Chromium との一致は実測していない。(4) legacy の既存の癖（読みによる推定で、試験では再現していない。直さない。別 lane の候補）：`phaseStore` の `resetForProject` が `sceneTimeIndex` を空にして `resolutionMode` を前の値のまま残す。この間は場面が index に無く base 解決になり、Phase が hidden にする項目が出うる。main は DB から turn 開始時に再構築するのでこの窓は無い。(5) hidden 判定の読みの量：渡された id にだけ読む（500 件ごとに複数の文）。main の caller timeout（10 秒）との関係は未実測（MP-13 の前）。
9. **DR-MP4-39i 判定を cache しない。Q5 に新しい窓を足さない。** entries・phases は呼出しごとに DB を読む（legacy と同じ）。turn の間 cache されるのは `ReadInputs`（読む順・`sceneTimeIndex`・`resolutionMode`・`currentSceneId`）だけで、これは DR-MP4-8・Q5 (a)(b)(d)・(5) が既に挙げている窓（場面切替後は turn 開始の場面で固定、DB が古い窓、`storyTimeOrder` の undo の食い違い）。判定を turn の cache に載せる案は、作者が turn の途中で hidden に変えた Codex がその turn の間見え続ける（ADR 013 に対して広い側）ので、Q5 (f) への追加になりユーザー確認が要る。採らない。
10. **DR-MP4-39j gate の追従（範囲は狭めない。広げる向きだけ）。** `codexHiddenFromAi.ts`・`phaseApi.ts`・`tables.ts`・`ports.ts`・新しい readDomain の file は、どの rule にも当たらず全 suite を選ぶ（`selectImpact` の実測）。`evals/impact-map.yaml` の `tool-policy` の paths には**足さない**（分割元が全 suite の file を rule に載せると選択が狭まる）。`codexAiVisibility.ts`・`core/codexVisibility.ts`・`core/codexReaders.ts`・`core/codexMainContext.ts` は fallback のまま。`scripts/quality/impact-map.mjs` の tool-policy の Light suite、GDX-TOOL-001 の `lightTests`、`impact-map.test.mjs` の期待に、8a の新試験（`codexHiddenFromAi.characterization.test.ts`・`codexHiddenFromAi.coreParity.test.ts`・`codexVisibility.test.ts`・`codexMainContext.test.ts`・`codexAiVisibility.test.ts`）と、これまで Light suite に載っていなかった `codexHiddenFromAi.test.ts`・`toolExecutors.codexHidden.test.ts`・`electron/main/mastraRead/db.test.ts` を足した（反証 A の P2-5。`codexHiddenFromAi.ts` の変更は全 suite を選ぶが、各 suite の Light command に同値の根拠の試験が入っていなかった）。`impact-map.test.mjs` は、4 つの新 file が `fallback === true` で、分割元（`codexHiddenFromAi.ts`・`phaseApi.ts`）の選択を下回らないことと、`codexAiVisibility` を `created` に足した。Quick が Light だけを走らせるのか全 vitest を走らせるのかは、この PR では確かめていない（PR 本文に実行した試験を列挙する）。`Cargo.lock`・`package.json`・`product-journey-catalog.mjs` は触らないので workload の digest は不要。
11. **DR-MP4-39k 検証の要点（実行した範囲）。** 実 addon の spec（merge の条件。addon は build 済みで、`napi:build` はしていない）：`vitest.electron-native.config.ts` の全 file が通った（14 file／**93 件**。base は 89 件で、足したのは `codex_entry_phases` の読み、判定、project の束縛、同順位の Phase の 4 件）。entries の select は ORDER BY を持たない（legacy と同じ。DB の返り順は `hidden`・`texts` の挿入順にだけ効き、内容には効かない。実 addon の spec は集合で比べる）。phases の select は `created_at` の順で、resolver が並べ直す（同順位は id）。`CI=true vitest --run src/features/chat/agent src/features/chronicle src/features/codex`（golden は書き換えなし）、`src/features/editor`・`src/features/foreshadow`（共有の呼び手）、`pnpm test:electron --run electron/shared electron/main/mastraRead`（`core.static.test.ts`・`tables.test.ts`・`db.test.ts` が 17 表で通る）、`tsc --noEmit` と `tsc -p electron/tsconfig.json --noEmit` は 0、`pnpm lint` は 0 error、`pnpm validate:architecture`、`impact-map.test.mjs`・`ci-change-scope.test.mjs`・`eval-fixtures.mjs`。main の 3 bundle の sha256（esbuild `write:false`、同じ worktree）は base と一致した（`main.cjs` 9efeca2b…、`preload.cjs` 46d054ca…、`mastra-agent.cjs` 041f5ac4…）。変異（一時的に実装へ入れて試験が落ちるのを確かめ、戻した。20 本）：unresolved を reading に倒す／phases を読まない／entries の project 条件の脱落／phase state の project の検査の削除／phase state を phases より先に読む／id の重複除去の削除／chunk を 1000 にする／`dropHiddenCodexRows` の `"summary" in row` の削除・hidden の判定の削除／`withContent` を常に false／sceneId の trim の削除／released を常に false／phases の条件に余分な id／allowlist から `codex_entry_phases` を外す・core が名指さない表を足す／renderer が store の mode を無視する・store を phases の前に読む／main の組み立てが mode を無視する・unresolved を reading に倒す／実 addon の spec で phases を読まない。`verify:quality`（Node 22）・`perf:budget`・`napi:build` は PR の側の工程（この PR の実装担当は回していない）。

### DR-MP4-41 現在の場面を Phase が解決できないとき（場面なし・読む順に無い）は、Phase が hidden にする Codex を hidden に倒す（ユーザー決定。2026-11-23）

PR-8a の特性試験（`phaseStoreReset.probe.test.ts`。「既知の疑い」）が固定していた fail-open を、ユーザーが 2026-11-23 に決定して直す。最初の決定は「(a)＋(b) を実装する。B（場面なし）は今回の範囲外」だった。**同日の追加決定で、B（場面なし）も範囲に入った**：Q1「場面なし（`sceneId` が null・undefined・空・空白だけ）のときも、(a) と同じ規則で hidden に倒す」、Q3「`codexYomi` は止める（Q1 の規則により、Phase でだけ hidden になる項目の名前・別名を AI に送らなくなる）」、Q2「chat の通常の文脈と地図は別の PR で揃える（この PR では触らない）」。ユーザー決定なので NIR-1 の事前委任は使わない。新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。AI に渡る文言・tool の schema・tool 集合は変えない（**AI に見える項目が減る向きの挙動の変更**は 2 に書く）。
**番号について**：DR-MP4-40 は PR-8b が使う予定なので、この記録は 41 のまま置く（枝は 8a の head から切り、8a の merge の後に、この枝の commit だけを master へ cherry-pick し直す）。

1. **事実（再現済み。`phaseStoreReset.probe.test.ts`）。** renderer の `resolveCodexForAi`（判定の本体は純関数 `decideCodexAiVisibility`）は、現在の場面が `sceneTimeIndex.readingOrder` に無いか場面なしだと、Phase が 1 つも効かない（`resolveApplicablePhases` の `current-scene-missing`、または base の anchor）。そのため「base は公開で、Phase だけが hidden にしている」項目が公開と判定されていた（fail-open）。base が hidden の項目は、Phase が公開にするものも含めて hidden のまま。経路：
   - (A) **場面が与えられているのに index に無い**：archived・trash・削除済みの場面、別 project の古い id、**note・folder を選択中**。最後が最も現実的な経路である：tree で note・folder を選ぶと `selectNode` が `activeSceneId` にその id を入れる（`TreeNodeItem.tsx:278-282`〔folder〕、`treeStore.ts` の `selectNode`〔`activeSceneId=id` を必ずセットする〕・`treeStore.ts:619-622`〔再読込でも note は残る〕）。note・folder は読む順（場面の順）に無いので、`activeSceneId` は非空で読む順に無い id になる。
   - (B) **場面なし**：`activeSceneId` が空、または呼び手が場面を渡さない。インライン AI（Codex・Snippet・年表 event の編集中は場面なし）、`codexYomi`（場面を渡さない）、agent tool（場面が 0 件のとき。根拠は下の「agent tool の場面の出どころ」）が該当する（呼び手の調査は `codex-no-scene-callers-20261123.md`）。**beat は `sceneId` が必須**（`buildBeatContext.ts`、`useBeatGeneration` は `!sceneId` で return）、**foreshadow の提案は `payoffSceneId` が必須**（`foreshadowStore.ts`）、章の監査は場面 0 件で本文が空（`detectRelatedCodex` が `!text.trim()` で return）なので、これらは場面なしでは効かず、(A) 型（読む順に無い場面）としてだけ効く。
   - (C) 実行中の AI 呼び出し（beat・インライン AI・foreshadow・`codexYomi` など）が project の切替をまたぐ（chat は切替で打ち切られる）。
   - (D) `resetForProject` の直後。**tree の切替から reset までの同期区間は、同期のスタックで塞がれていて窓は無い**。
2. **DR-MP4-41a (a)＋Q1：場面を解決できないとき、Phase が hidden にする項目は hidden に倒す。** 「場面を解決できない」＝(A) 場面が与えられている（`sceneId` が trim 後に非空）のに `sceneTimeIndex.readingOrder` にその id が無い、または (B) 場面なし（`sceneId` が null・undefined・空・空白だけ）。そのとき、項目が Phase を 1 つ以上持ち、いずれかの Phase の `contextModeOverride` が非 null で `isCodexContextModeHiddenFromAi`（hidden・不明な mode）に当たれば hidden。base が hidden の項目は今までどおり hidden。Phase を持たない項目・どの Phase も hidden にしない項目（text の override だけ、suppress・mentioned・always、null）は今までどおり（base で公開、texts は base の文）。`resolutionMode` が `unresolved` のときは今までどおり全部 hidden。**場面が index に有るときの結果は 1 ビットも変えない**（`anchorOf` と resolver も変えない）。
   - **置き場は純関数 `decideCodexAiVisibility` の中**（`codexAiVisibility.ts`。判定名は `isSceneUnresolvable`。renderer と read core が同じ関数を呼ぶので、core の入口 `resolveCodexAiVisibility`・`dropHiddenCodexRows`・`listHiddenCodexIds` にも同じ規則が効く）。**resolver 本体（`resolveApplicablePhases`・`resolveCodexContexts`・`resolveCodexState`）は変えない**。これらは MCP・年表・Graph・related-scenes・editor の Phase 表示・Rust の移植元など多くの利用者があり、`current-scene-missing` の「Phase は効かない」という結果は表示・年表の側では正しいので、変えると全利用者に波及する。`decideCodexAiVisibility` の利用者は、renderer の `resolveCodexForAi` と core の `resolveCodexAiVisibility` の 2 か所だけ（grep で確認）。
   - **「Phase が 1 つも効かない」と「項目が Phase を持つ」を区別しない理由**：Phase の anchor が index に無い Phase（dangling。anchor の場面が削除済み）も「hidden にする Phase」に数える。場面が解決できないとき、どの Phase が効くかを判定する手段が無く、保守的に倒すのが決定の趣旨だから（純関数の試験で固定した）。
   - **AI に見える項目が減る場面（具体例。画面で見える挙動の変化）**：
     - (i) **note・folder を選択中**に、agent tool・インライン AI で「base 公開・Phase で hidden」の項目が「見つからない」になる、または AI に渡らなくなる（以前は、その note・folder を選んでいる間も Phase を無視して base で公開と判定され、見つかった）。`activeSceneId` が非空で読む順に無い id になるため、(a) の条件に当たる。
     - (ii) 作者が場面 S を archived にした（trash に入れた）まま、S が選ばれている状態で beat 生成・インライン AI・foreshadow を呼ぶ。「アリア」が n-s2 から hidden になる Phase を持つなら、S が index に無い間はアリアの summary が文脈に入らない（以前は入った）。
     - (iii) 別 project の古い `sceneId` が呼び手に残っている。
     - (iv) `resetForProject` の後、新しい index が入るまでに始まった呼び出し（index が空のまま走る。(b) が先に効くのは、切替をまたいだ呼び出しだけ）。
     - (v) **Q1：場面なしのインライン AI**（Codex・Snippet・年表 event の編集中）と、場面なしの agent tool（起動直後・場面 0 件）で、Phase でだけ hidden になる項目が出なくなる（beat・foreshadow は場面が必須なので (ii) の型でだけ効く）。**agent tool の場面の出どころ（コードで確かめた範囲）**：tool の場面は `toolExecutors.ts` の `chronicleSceneId(scope)` で、scope があれば `scope.currentSceneId ?? ""`、無ければ呼んだ時点の tree store の `activeSceneId ?? ""`。scope は `chatAgentToolHandlers.ts:480` が `currentSceneId: input.currentSceneId || null` で作り（IR が有効なときだけ）、その値は `chatTurnStoreActions.ts:1127` が turn 開始時の `activeSceneId` を渡す。tree store の `activeSceneId` の初期値は `""`（`treeStore.ts:1048`）で、`treeStore.ts:621-623` の再読込は、現在の場面が無ければ最初の場面、場面が 0 件なら `""` にする。したがって場面が 0 件の project（と、tree の読込み前）では、agent tool の場面は空（場面なし）になる。**未確認**：`chatTurnStoreActions.ts` の preflight が `activeSceneId` を tree store のどこから取るか（読んでいない）、「起動直後」に実際に何が起きるか（読込み前に tool が呼ばれる経路があるか）。
     - (vi) **Q3：`codexYomi` の名前・別名**：`listCodexIdsHiddenFromAi` を project だけで（場面なしで）呼ぶので、Phase でだけ hidden になる項目の名前・別名は AI に送られない。(b) も効く。**呼び手・呼び方は変えない**（判定関数側の変更で自然に効く）。`codexYomi.realHidden.test.ts` で、入口（`inferReadings`・`listCodexIdsHiddenFromAi`）を固定した。**画面の表示（Opus レビュー P2-1・P3-2）**：項目の単体推定ボタン（`CodexDetailContent`）は base の mode だけで無効になるので、base が公開で Phase でだけ hidden の項目ではボタンが有効のまま、押すと `inferReadings` が送信前に落として空の結果になり、「AI から有効な読みを取得できませんでした。モデル設定を確認して…」の警告が毎回出てしまう。これを避けるため、**押したときに AI を呼ぶ前に同じ判定（新しい export `listYomiHiddenIds`。`listCodexIdsHiddenFromAi` を project だけで呼ぶ。`inferReadings` の送信前の判定もこれを呼ぶ）で確かめ、hidden なら既存の `codex.readings.estimateHidden`（「AI に秘匿（hidden）の項目は推定できません。読みは手で入力してください。」）を toast に出して AI を呼ばない**（新しい locale キーは作らない。ja・en とも既存）。`inferReadings` の署名・返り値は変えない。一括（`ReadingsBackfillSection`）は、base の mode の判定の後、残りの項目を同じ判定（`listYomiHiddenIds`）にかけ、Phase でだけ hidden の項目を work から除く。除いた結果が空なら `backfillNone`。**判定の分割（採った案）**：renderer の `resolveCodexForAi` は entries の select と `listPhasesByEntryIds` を `inArray(...)` の 1 文で読み、分割しない（500 件の分割は core の入口と `tree/api.ts` の `loadScenesFull` だけ）。SQLite の変数の上限（件数）は**未確認**なので、一括の work 全件を 1 文に渡すと上限を超えうる。そこで `listYomiHiddenIds` の中で id を **500 件ずつに分けて判定し、hidden を合わせて返す**（`loadScenesFull` の先例。どの回の判定が失敗しても全体が `YomiHiddenCheckFailedError`＝fail-closed で、一括は `backfillFailed`・送信なし）。単体は 1 件なので 1 回。判定の projectId は、一括は一覧と同じ `getCurrentProjectId()`、単体は項目の `entry.projectId` を明示して渡す（`inferReadings` の送信前判定は既定の tree store の projectId のまま。旧版と同じ基準）。これで total・進捗の件数が合い、残りが全部該当のときに毎回 0 件の完了になって同じ項目が対象に戻ることが無い（利用者へ伝える文言の追加は無い。既存の「hidden は対象外」と同じ扱い）。ボタンの disabled の判定（base の mode だけ）は変えない。AI に渡るプロンプト・schema・tool 集合は変えない。
     いずれも、Phase で hidden になっている項目が出なくなるだけで、base が公開で Phase を持たない項目は出る。作者が「ある場面から隠す」と指定した項目が、場面を解決できないときに見えなくなる（過剰に隠す）側に倒れる。
3. **DR-MP4-41b (b) renderer の `resolveCodexForAi` が、project の切替をまたいだら全 id を hidden にする。** 関数の冒頭で `usePhaseStore.getState().projectEpoch` を控え、DB の await（entries・phases）の後に store を読む時点で epoch が違えば（`resetForProject` が走った）、渡された id を全部 hidden にして返す（texts は空）。`dropCodexHiddenFromAi`・`visibleCodexForAi`・`visibleCodexIdsForAi`・`listCodexIdsHiddenFromAi` はこの関数を呼ぶので同じ。epoch の控えは `getState()` を 1 回増やす（全 id が DB に無いときも 1 回）。値（index・mode）を読む回数は変わらない。**main 側（core の入口）は対象外**：turn に束ねた `ReadInputs` を使うので、project の切替をまたいで store を読む形が無い。`withDetails` の追加の読み（decision の後の await）の間の切替は検査しない：その時点の判定は切替の前の store と前の project の行で完結しており、返る detailValues も同じ project のもの。chat の context 準備・consistency payload が store を直接読む箇所（`chatContextPreparationComposition.ts`・`consistencyPayloadBuilder.ts`）は `resolveCodexForAi` を経ないので、この DR の範囲外。
4. **残る入口（この DR で直らない。別 PR で揃える。ユーザー決定 Q2）。** 次は別実装・別 PR で、この PR は触らない。
   - chat の通常の文脈：`nonSceneContextSource.ts:605-610`・`sceneContextSource.ts:492`（別実装。codex scope は latest）。
   - 地図の AI 枝：`map/aiBranchContext.ts:61,161`（Phase を見ない）。
   - impact-review（未精査）。
   - standalone MCP（Phase を見ない）。
   - 候補画面（`candidateJudgment.ts` の `judgeCandidates`）：統合者が別 PR #1031 で、base が hidden またはどれかの Phase で hidden の項目を全部除く helper（`listCodexIdsHiddenFromAiInAnyPhase`）により直す。この PR では使わない。
   **同じ turn の中で「tool では見つからないのに、通常の文脈には本文が載る」食い違いが残る**（漏れが増えるわけではない。通常の文脈は今までどおりの挙動）。
   **未確認の既存の窓（この PR 前から。悪化しない）**：`setResolutionMode` と index 再構築の順。
   **範囲外（変えない）**：公開関数のシグネチャ、falsy な `projectId` の挙動、resolver・policy の他の利用者の結果、AI に渡る文言・tool の schema。
5. **main・core の扱い（8b・CSR/1 への申し送り）。** main の `ReadInputs`（`core/readInputs*.ts`）は、読む順に無い `currentSceneId` を null に正規化する（PR-6）。**Q1 の決定により、Codex の判定は、場面なし（null）も読む順に無い id も、Phase が hidden にする項目を hidden に倒す**。したがって main の呼び手が正規化済みの null を渡しても、生の `activeSceneId` を渡しても、Codex の結果は同じになる（当初の「生の `activeSceneId` を渡す必要」は不要になった）。**この PR では `ReadInputs` の契約を変えない**。年表側の `currentSceneId`（null で secret を隠す）にも変更は無い。main の呼び手は今は無い（旗 L は閉）ので、この PR で変わる main の挙動は無い。`readInputs.ts` の `currentSceneId` の注はこの事実に直した（コメントのみ）。
6. **legacy との同値の基準が変わる点（注記）。** DR-MP4-1 の「Codex は base」、DR-MP4-39d の「K-20 (1) の Codex 側の解消：legacy と同値である」の記述のうち、**「現在の場面が読む順に無い、または場面なしのとき、公開 → hidden の Phase は効かず base で判定される」は、この DR で legacy 自体を変えたので、そのケースに限り過去の記述になる**。つまり Codex でも「場面を解決できない」（場面なし・場面が与えられたが読む順に無い）は、年表（場面が読む順に無ければ secret を隠す、DR-MP4-1）と同じ向き（隠す）に揃った。K-20 (1) の他の記述（`resolveTemporalAnchor` という名前が無い等）は変えない。`codexHiddenFromAi.coreParity.test.ts` は legacy と core が同じ純関数を呼ぶので、このケースでも両者は一致する（無変更で通る）。
7. **変えた試験の期待（変わるのは「場面を解決できない（場面なし・index に無い）×Phase-hidden を持つ」の入力と、(b) の epoch の控えの回数だけ）。**
   - `phaseStoreReset.probe.test.ts`：(1) reset の直後（mode＝story）の `basePublicPhaseHidden`（c-aria）が `false`→`true`（hidden）。(2) 同（mode を reading・auto にした 2 回）が `false`→`true`。(3) 同（`setResolutionMode("story")` を足した後）が `false`→`true`。(4) 現在の場面が index に無い（`n-not-in-index`）ときの c-aria の hidden が `false`→`true`。(5) **Q1**：場面なし（null・空・空白だけ・未指定）の判定で、c-aria が公開→hidden（`[baseHidden, baseHiddenPhasePublic]`→3 種全部 hidden）。題名・コメントは「既知の疑い」から「DR-MP4-41 の決定」に直した。足した試験：project の切替をまたぐ（phases の await の最中・entries の await の最中）で全 id hidden、切替が無ければ公開のまま（制御）、切替の後の呼びは (a) に従う。
   - `codexHiddenFromAi.characterization.test.ts`：(6) 「場面なし（null・未指定・空・空白だけ）と、読む順に無い id は base で解決する」を 2 件に分けた後、さらに**場面なしの 4 値の期待を変えた**：hidden が c-released だけ→**c-aria・c-mage・c-released**、texts が 2 件→空（c-aria・c-mage は Phase が hidden にする。Q1）。読む順に無い id（`n-archived`・`no-such-scene`・`n-note`・前後に空白のある id）も同じ期待（(a)）。(7) 「全 id が DB に無いときは store を読まない」の `getState` の呼び出し回数が、0 回→1 回（全 id が無い呼び）、1 回→2 回（c-aria の呼び）：(b) の epoch の控えが関数の冒頭で `getState()` を 1 回呼ぶため。値（index・mode）を読む回は変わらない。足した試験：場面なし・場面が読む順に無いのどちらでも、suppress・always の Phase を持つ項目（c-tower・c-item）は今までどおり（広げない）、場面なし 4 値の `hidden`・`texts` の挿入順（DB に無い id が先、次に DB が返した entry の順。以前の「ソートせず順序を比べる」確認を、場面なしでも守る）。
   - `codexAiVisibility.test.ts`：(8) 「no scene … is the base anchor: no phase applies」の期待を、`hidden`＝`[hid]`・`texts`＝`[pub]`→**`hidden`＝`[hid, pub]`・`texts`＝空**（anchor は base のまま）に変えた（Q1）。(9) 「a scene that is not in the reading order: the anchor is still that scene」に、`pub` が hidden になる assert を足した（(a)）。(10) (a) の block の「no scene is unchanged」を削除し（Q1 で期待が逆になる）、Q1 の block に置き換えた。足した試験：(a) の純関数の 12 件（base 公開×Phase hidden、複数 Phase のうち 1 つが hidden、不明な mode の Phase、base hidden×Phase 公開、Phase なし、Phase が公開・text だけ・null、同じ call の他の項目、reading・story・auto、trim、場面が index に有る〔変わらない〕、index が空、unresolved）、dangling anchor の Phase だけを持つ項目（hidden に数える）、**Q1 の block 5 件**（種別 6 つ×場面なし 4 値、公開のまま残る項目の base の文、全 mode と空の index、unresolved、Phase なしの項目は変わらない）。
   - `codexVisibility.test.ts`（core）：(11) 場面なし 4 値の期待を、`hidden`＝`[hid, rel]`・`texts`＝`[hide-later, pub]`→**`hidden`＝`[hid, hide-later, rel]`・`texts`＝`[pub]`** に変えた（Q1）。足した試験：core の入口（`resolveCodexAiVisibility`・`listHiddenCodexIds`）に (a) と場面なし（`listHiddenCodexIds` を `sceneId: null`）が効くこと。
   - `codexYomi.realHidden.test.ts`（実物の DB 層。`codexYomi` の入口）：(12) 「base が mentioned で Phase の override が hidden でも、`inferReadings` は送る」の期待を、送信 1 回→**送信 0 回・空の結果**に変えた（Q3）。(13) 「`listCodexIdsHiddenFromAi` を `sceneId` なしで呼ぶと base の mode で判定する」の期待を、`[hidden]`→**両方 hidden**（hidden の Phase の `mentioned` 項目も hidden、解除の Phase を持つ base hidden も hidden のまま）に変えた。足した試験：Phase が hidden にしない（suppress の override だけ）項目は、場面を渡さなくても今までどおり送る、`listYomiHiddenIds` の実物の判定（base 公開×Phase hidden と base hidden を返し、公開は返さない）。
   - `CodexDetailContent.test.tsx`・`ReadingsBackfillSection.test.tsx`・`ReadingsBackfillSection.codexHidden.test.tsx`（P2-1）：期待の変更は無い（`codexYomi` の mock に `listYomiHiddenIds` を足しただけ。既定は空の集合）。足した試験：単体推定で Phase でだけ hidden の項目は `estimateHidden` の toast が出て、`inferReadings` が 0 回・「モデル設定」の警告が出ない。一括で Phase でだけ hidden の項目が work から除かれる（`inferReadings` に渡らない・判定は 1 回で全 id）、全部該当なら `backfillNone` で `inferReadings` が 0 回、base hidden だけなら Phase の判定を呼ばない。判定が失敗したとき（`listYomiHiddenIds` が reject）の試験：単体は `estimateFailed` の toast・`inferReadings` が 0 回・ボタンが処理中のままにならない、一括は `backfillFailed`・`inferReadings` が 0 回・実行中の表示が解除される。一括の判定には一覧と同じ projectId が渡ること、`listYomiHiddenIds` が 1,001 件を 500・500・1 に分けて hidden を合わせること・途中の失敗で全体が reject すること（`codexYomi.codexHidden.test.ts`）。変異：単体の事前判定を外す→1 件、一括の除外を外す→2 件、判定の失敗を握りつぶして続行する→単体 1 件・一括 1 件、一括の projectId の明示を外す→1 件が落ちた。
   - 無変更で通ったもの：`codexHiddenFromAi.coreParity.test.ts`（legacy と core の同値）、main の adapter の上の同値（`mastraReadParity.pipeline.spec.ts`。実 addon の spec に含まれる）、`legacyReadGolden` の bytes（書き換えなし）、`toolExecutors.codexHidden.test.ts`・beat・インライン AI・foreshadow の試験。
8. **変異（一時的に実装へ入れて試験が落ちるのを確かめ、戻した。git diff で確認）。** (a)＋Q1 の判定（`isSceneUnresolvable`）を常に false にする：electron 側 13 件・renderer 側 11 件が落ちた。(a) を「Phase を持つ項目を全部 hidden」に広げる（場面なしにも効く）：electron 側 3 件・renderer 側 4 件が落ちた。(b) のガードを外す：probe の 2 件が落ちた。(b) で hidden でなく公開にする：同じ 2 件が落ちた。**Q1 の追加**：場面なしの分岐だけを外す（`isSceneUnresolvable` を「非空かつ index に無い」だけに戻す）：electron 側 5 件・renderer 側 6 件が落ちた。場面なしだけ「Phase を持つ項目を全部 hidden」に広げる：計 5 件が落ちた（electron 側の純関数 2、renderer 側の characterization 2・codexYomi 1）。
9. **検証の要点。** main の 3 bundle の sha256 は、変更の前後で同じ（読み推定の表示の修正の後と、その Opus レビューの P3 の直し（判定の分割・projectId の明示・docs の訂正）の後に、同じ worktree で再計測した（どちらも一致）。`main.cjs` 9efeca2b…、`preload.cjs` 46d054ca…、`mastra-agent.cjs` 041f5ac4…。main はまだ core を呼ばない）。実行したコマンドと結果は、PR 本文と報告に書く。`verify:quality`・`napi:build` は、この枝では回していない（親が回す）。impact-map・quality-manifest は、新しい試験 file を足していないので追従は無い（既存の file に試験を足しただけで、評価範囲は変わらない）。

### DR-MP4-40 search_codex・list_codex_by_type・search_codex_by_tags・find_related_entries の read core 化（MP-4b PR-8b。技術判断。2026-11-23）

PR-8（B5 Codex hidden）の後半の PR-8b の、mutation の前の判断（実装の途中で確定した点を含む）。DR-MP4-3・6・8・32・34・35・37・39・41 の範囲内で、新しい契約・authority・送信先・保存範囲・閾値の緩和は伴わない。tool の定義・schema・結果は 1 byte も変えない（PR-0 の golden 46 case、①の特性試験、送った呼出しの列の fixture が無変更で通る）。main はまだ core を呼ばない（旗 L は閉）。
**番号について**：DR-MP4-41（Phase が解決できないときの Codex の hidden）は 8a の枝から切った別の PR が先に使った。この記録は 8b の番号 40 のまま DR-MP4-41 の直後に置く。PR を作る前に `origin/master` の decisions の最大番号を確かめ、衝突したら最後に merge する側が振り直す。本文中の参照は、この 1 行にある番号だけを一括置換すればよい形にしてある。

1. **DR-MP4-40a 範囲と ctx。** 4 本（`get_codex_entry` は legacy に残る。`withDetails` は入れない。`codex_phase_detail_overrides`・`codex_detail_definitions`・`codex_detail_values` は足さない）。4 つ目の表 `CODEX_READ_TOOL_NAMES`、専用の ctx `CoreCodexReadContext`（`CoreCodexVisibilityPorts`＋`getTreeState`・`countTokens`＋`native.fts`・`native.codexSemantic`）、専用の factory `createCodexReadExecutors`（`CoreReadContext` は広げない。DR-MP4-37c と同じ理由）。4 つの表（`CORE_READ_TOOL_NAMES` 11・`CHRONICLE_READ_TOOL_NAMES` 4・`CHRONICLE_SEARCH_TOOL_NAMES` 1・`CODEX_READ_TOOL_NAMES` 4）は互いに素で合計 20（mainAdapter・実 addon の spec が assert。7b の「3 つの表で 16」の assert は 3 つの表についてはそのまま正しいので残し、8b が 4 つ目を足した合計 20 の assert を別に置いた）。main 用に `createMainCodexReadContext`（`codexMainContext.ts`）：project・現在の場面・phase state を **1 つの `ReadInputs` から束ねる**（反証 B-1。別 project の入力で判定できない形にした。tree state は nodes を持たない：4 本は読まない）。
2. **DR-MP4-40b 4 本の中身と順序は legacy と同じ。** 文字列・key 順・SQL・`tokensUsed` は移したまま。引数の検査（空の query・空の tags・空の id）が project の検査より先で、`list_codex_by_type` は何も検査しない。project は最初の await の前に 1 回。現在の場面は結果を作り終えた後（`search_codex` は dense の後、`find_related_entries` は起点の判定〔起点の select の後〕と結果落とし〔関連の select の後〕の 2 回）。hidden は融合・cut の後に落とす（fts の上位 20 を hidden が食うと 20 件未満になる。legacy と同じ）。**`find_related_entries` は起点が無ければ場面も判定の SQL も読まず `Entry not found`**（反証 B-5。`!source` の短絡を保つ。起点の判定は legacy と同じ `withContent: true`）。判定は 8a の `dropHiddenCodexRows`・`resolveCodexAiVisibility`（renderer と同じ純関数）で、cache しない。
3. **DR-MP4-40c fts の一本化と dense。** `sparseSearchIds`・`SparseSearchHit` を `toolExecutors.ts` から削除し、`ctx.native.fts({projectId, query, scope: "codex", limit: 20})` に寄せた（DR-MP4-34f の 2 経路の共存の解消）。`ftsHitIds` に `"codex"` を足した（fail-closed）。dense は `narrowCodexDenseHits` で narrow する：配列、各行が object で `entryId` が string、`score` が number か **null**（NaN の f32 は wire で null になる。0 として読み、legacy の融合の読み〔`null` の算術と `?? 0`〕と同じ順位になる。反証 A-6。試験で 0 との一致を固定）。**dense の失敗を握るのは renderer の port の中だけ**（`codexReadContext.ts` の `codexSemanticSearch(args).catch(...)`。今と同じ式・同じ warn。core と main は握らない。narrow の失敗は port の外なので握られない）。
   - **実在しない状態の差（DR-MP4-34d と同型。legacy は成功、core は throw）**：fts の戻りが配列でない・行が object でない・`sourceType` か `id` が string でない行（legacy は黙って skip か `TypeError`）、dense の戻りが配列でない・行が object でない・`entryId` が string でない・`score` が number でも null でもない。有効な wire では結果は同じ。洗い出し：`invoke`・`codexSemanticSearch` の mock を持つ試験（`toolExecutors.*.test.ts`・`agentLoop.test.ts`・`transportContext.test.ts` など）を grep し、4 本を呼ぶ試験の mock は `[]` か有効な wire を返す（`src/features/chat/agent` と `src/features/codex/context` の全 file を実行して通った。リポジトリ全体の vitest は回していない）。
4. **DR-MP4-40d 計画に無かった差：DR-MP4-41 (b)（project の切替の epoch の検査）を core へ運ぶ。** (b) は renderer の `resolveCodexForAi` にだけあり（判定の純関数の外）、4 本が core の判定を通ると落ちる。切替をまたぐと、legacy は全部 hidden（空）、core 経由は base 公開で Phase を持たない項目が残る。**`CoreCodexVisibilityPorts` に任意の `getProjectEpoch?: () => number` を足し**、core の `resolveCodexAiVisibility` が最初の読みの前に控え、phase state を読んだ後に比べる（違えば渡された id を全部 hidden・texts は空。legacy と同じ位置・同じ答え）。renderer の ctx だけが渡し（`usePhaseStore` の `projectEpoch`）、main は渡さない（turn に束ねた入力を使う。live の store が無いので挙動不変。DR-MP4-41b が「main は対象外」とした範囲は変わらない）。①の特性試験（判定の entries・phases の読みの最中の切替、find_related の結果判定の最中の切替）が無変更で通り、検査を外す変異で落ちる。tool 自身の DB の読みの最中の切替は判定の前に済むので (b) の対象外で、(a)（index が空）に従う（これも特性試験が固定）。****申し送り**：`getProjectEpoch` は optional なので、将来 renderer の ctx を新しく作るとき（`get_codex_entry` の移設など）は必ず渡す（渡し忘れは型エラーにならない。「renderer の ctx から外す」変異で特性試験 3 件が落ちることで守っている）。この追加は ports.ts の型（任意の member）と core の入口の変更だが、renderer の結果を legacy に保つためで、main の挙動・契約・authority は変わらない**ので技術判断とした。
5. **DR-MP4-40e scope の扱い（renderer の薄い層）。** scope があるとき（`CHAT_AGENT_IR_ENABLED` が false の間は作られないので到達しないが、特性試験が固定する）は、現在の場面を scope の値にした ctx を**呼出しごとに**作る（作るだけでは何も読まない）。**projectId は scope でなく今までどおり store**（legacy の非対称。scope の `currentSceneId` が null なら base）。scope なしは load 時に 1 度作った executor。project が無いときの core の throw は `No active project` の結果（content は 4 本とも `[]`）に戻す。
6. **DR-MP4-40f `toolExecutors.test.ts` の hybrid 2 件の seam を直した（DR-MP4-35h 型の外れ。反証 A-1。期待値は変えていない）。** この 2 件は `codexHiddenFromAi` を素通しに mock していて、4 本が core の判定を通ると seam から外れる（core は `getDb()` と phaseApi の loader から読む）。`@/features/codex/phaseApi` の mock（Phase なし）を足し、DB の行に `contextMode` を持たせ、dense の hit（`e-dense`）も DB の行にした。今の legacy でも通る（①の commit）。同ファイルの他の 4 本を呼ぶ case（XPROJ の 2 つの `it.each`）は変更なしで通る。
7. **DR-MP4-40g 判定を cache しない。Q5 に新しい窓を足さない。** DR-MP4-39i のとおり（4 本も entries・phases を呼出しごとに読む）。
8. **DR-MP4-40h main の dense は握らない。旗 L を開ける前の確認項目 C-23。** main の port は握らない（握ると `MainReadError`〔timeout・workspace・argument・`assertLive`〕まで「0 件」の成功に化け、turn の取消・失効が成功に見える。model 不在は型付き kind が無く message 照合以外に分類手段が無いので、新しい契約になる）。したがって main では model 未導入の環境で `search_codex` が失敗する（legacy は sparse に退避）。分類して握る案は 4c-1 で決める。**既存の oracle（反証 B-10）**：fts は hidden の本文にも当たるので、hidden の本文への検索の命中が件数に出る（20 件未満になる）。PR-8 は同値で写し、直さない（直すなら hidden を SQL に押し込む別 lane）。
9. **DR-MP4-40i 表の増分は無い（17 表のまま）。信頼境界は DR-MP4-39g の範囲から変わらない。** 4 本が読む表は `codex_entries`・`codex_tags`・`codex_entry_tags`・`codex_entry_phases`・`tree_nodes`・`projects`（いずれも allowlist に入済み）。新しい契約・authority・送信先・保存範囲・閾値の緩和は無い。main の caller timeout（`db_execute`・`fts_search`・`codex_semantic_search`）は変えない。確定文書（脅威モデル）は改訂しない。§9.2 の「後続（4b）」の行（hidden・年表 secret の入力）は PR-8 では書かない（DR-MP4-39g のとおり。4b の最後の PR か 4c-2）。
10. **DR-MP4-40j 持ち越しと、受容する窓。** (1) 4 本の ORDER BY なし（`list_codex_by_type`・`search_codex_by_tags`・`find_related_entries`・LIKE の arm）：結果は DB の返り順に依存する（DR-MP4-33e(a) と同型）。**AI に渡る一覧の並びも同じ（統合者の確認を受けて、出力の順の決まり方を tool ごとに確かめた）**：`search_codex` の FTS arm は `orderByIds`（実 fts の返す順）、融合は明示の sort（rrf 降順・score 降順・id）で決まる。しかし **LIKE の arm・`list_codex_by_type`・`search_codex_by_tags`・`find_related_entries` は ORDER BY も明示の sort も無く、SQLite の返り順（plan 次第）で不定**（LIKE の arm と `find_related_entries` は `.limit(20)` なので、20 件を超えると集合も不定）。**legacy も同じ作りで、renderer は実 DB に同じ SQL を送るので、移行の前後で AI に渡る順は変わらない**。golden（sql.js）と実 SQLite で順が違うのは schema・index の違いによる環境差で、AI に渡る順の変化ではない（spec の正規化はそれを golden の側の不定として扱うだけで、core が select の返り順を保つこと〔並べ替えない〕は、tool 自身の select の答えから求めた順との比較で確かめている）。**ORDER BY を足すと移行前と結果が変わる（LIMIT 20 のものは集合も変わる）ので、この PR では足さない。決定的にするなら別の PR（ユーザーの判断）。**実 addon の spec は、FTS の arm は実 fts の直接呼び出しの順、ORDER BY の無い select の行（LIKE の arm・list・tags・find_related）は実 SQLite が返した順、dense の融合は実 SQLite の sparse の行の上の融合の順で比べ、他（name・summary・tokensUsed・各行〔id で並べた JSON〕）は golden と byte で比べる（DR-MP4-40l の「spec の比較の正規化」）。(2) `search_codex` の LIKE arm は `codex_entries` の content にも LIKE をかける。巨大な原稿での結果 size・10 秒の caller timeout は未実測（MP-13 の前）。(3) hidden の判定の読み：渡された行の id にだけ読む（500 件ごとに複数の文）。renderer の経路でも、4 本の結果が 500 件を超えると判定の文が分かれる（legacy は 1 文）。判定は変わらない：Phase は entry ごとにまとめてから使われ、chunk は entry id で切るので、1 つの entry の Phase が chunk をまたがない。(4) K-4（`localeCompare`）は DR-MP4-39h のとおり未確認。(5) typed read の fts の workspace 照合（DR-MP4-34i）と `core/sceneBody.ts` の project 条件は 4c-1 の前（DR-MP4-39h）。
11. **DR-MP4-40k gate の追従（範囲は狭めない。広げる向きだけ）。** `evals/impact-map.yaml` の `tool-policy` の paths に、`core/codexTools.ts`・`core/codexReadExecutors.ts`・`core/codexTools.test.ts` を 1 本ずつ足した（分割元 `toolExecutors.ts` は tool-policy なので選択は下回らない。glob にしない）。`features/chat/agent/codexHybridSearch.ts`（readDomain 側）・`core/codexMainContext.ts`・`core/codexVisibility.ts`・`core/codexReaders.ts`・`mastraRead/ports.ts` は rule に載せず fallback（全 suite）のまま（載せると選択が狭まる）。`scripts/quality/impact-map.mjs` の tool-policy の Light suite・GDX-TOOL-001 の `lightTests` に `toolExecutors.codexCharacterization.test.ts`・`toolExecutors.codexCalls.test.ts`・`core/codexTools.test.ts` を、GDX-POLICY-001 と GDX-ARTIFACT-001 の `implementedBy` に `codexTools.ts`・`codexReadExecutors.ts` を足した。`impact-map.test.mjs` は、`codexTools`・`codexReadExecutors` が分割元 `toolExecutors.ts` の選択を下回らないこと、`features/chat/agent/codexHybridSearch` を `moved` に足したこと（21 → 22。canonical は fallback なので loop は `continue`）、Light suite の期待に新試験を足した。`codexReadExecutors.test.ts` は作らない（executor の表は `codexTools.test.ts` の `createCodexReadExecutors` の describe が覆う）ので列挙しない。`Cargo.lock`・`package.json`・`product-journey-catalog.mjs` は触らない。
12. **DR-MP4-40l 検証の要点（実行した範囲と、していない範囲）。** 実行：①の特性試験 36 件＋呼出しの列 46 case（移す前の legacy で通し、移した後も無変更）、PR-0 の golden・`toolExecutors.codexHidden.test`・`legacyNativePort.test`・`toolExecutors.test`・`codexHybridSearch.test`、core 単体（`codexTools.test` 28・`codexVisibility.test` の epoch 4・`codexMainContext.test` 2）、main の adapter の上の golden の byte 一致と呼出しの列の一致（46 case）、renderer と main の core の同値（golden に無い world 90 組）、`src/features/chat/agent`・`src/features/codex/context`（1147 件）、electron の core・mastraRead（532 件）、`tsc --noEmit`・`tsc -p electron/tsconfig.json --noEmit`・`pnpm lint`（0 error）・`prettier`・`validate:architecture`・`impact-map.test.mjs`・`eval-fixtures`。**変異（一時的に実装へ入れて試験が落ちるのを確かめ、戻した。`git diff` と untracked の sha256 が前後で一致）22 種**：unresolved の fail-open、Phase を読まない、hidden を融合の前に落とす、fts の scope を all、`ftsHitIds` の sourceType 判定の削除、list の project 条件の脱落、判定の entries の project 条件の脱落（A-3 (2)）、LIKE の limit の削除（A-3 (3)）、search_codex の場面を dense の前に読む、find_related の 2 回目の場面を 1 回目で代用、allowlist から `codex_entry_phases` を外す、scope のとき projectId を scope から取る、find_related の `withContent` を外す（A-3 (1)）、tags の `selectDistinct` を `select`（A-3 (4)）、epoch の検査を外す（core・renderer の ctx）、find_related の短絡を外す、core が dense の失敗を握る、dense を narrow しない、renderer の port が dense の失敗を握らない、dense の limit を 20 に、renderer の Phase の loader を空に。すべて落ちた（件数は commit message）。**親が窓の後に実行（数値は PR 本文）**：実 addon の spec（`napi:build` 済み。全 file 107 件。spec の比較の正規化を入れた後）、main の 3 bundle の sha256（base と一致）、実 Chromium の browser suite（635 件）、広い範囲の vitest、`verify:quality`（Node 22。成功）。`perf:budget` は CI。
    - **spec の比較の正規化（実 addon の spec を回して分かった。試験を緩める変更なので範囲と理由を書く）**：ORDER BY の無い select は、sql.js（golden と呼出しの列の fixture を作った環境）と実 SQLite で行の返り順が違う。core と legacy の差ではなく、どちらも同じ実 SQLite の順を受ける。実 addon の spec（`mastraReadParity.pipeline.spec.ts` の PR-8b の describe）は、次の 3 点だけを正規化した。(1) 「送った文」の比較：`cmd`・`sql`・`method`・文の数と順、`in (?, ?, …)` の外の params（project・LIKE のパターン・limit）は今のまま順も含めて完全一致とし、**`in (…)` のリストに当たる params の連続した区間だけを集合として（並べ替えて）比べる**。区間は SQL の `in (` の前の `?` の数（開始）と括弧の中の `?` の数（長さ）から求め、`in (` が複数あれば全部。recorded 側と sent 側の両方に同じ関数（`normalizeInListParams`）をかける。(2) ORDER BY の無い select の結果の順：その tool 自身の select の答え（実 SQLite の順）から求めた id の順（golden の可視 id だけ残す）を期待とする。(3) dense が canned の case の順：実 SQLite の sparse の行に `fuseCodexHybrid` を掛けた順。(2)(3) とも、name・summary・tokensUsed と各行（id で並べた JSON）は golden と byte 一致のまま。変異（in リストの区間の長さを 1 つ減らす／sent 側の id を別の id に替える）で spec が落ちることを確かめた（戻した）。
    - **P3 の取捨（反証 A-7・A-8・A-9、B-7〜B-12）**：A-7（project の束縛）＝main の ctx が同じ `ReadInputs` から束ね、8a の phase state の project の検査が働く。A-8（特性試験に足す）＝(a) tokens が空の分岐は到達できない（trim 後に空でない query は token を 1 つ以上持つ）ので足さない。(b) type の trim・(c) fts が 0 件なら entries を読まない・(d) tags の要素の trim なし／重複を足した。A-9＝(1) `codexHiddenFromAi.test.ts` は 5 件、(2) renderer の ctx は fts の arrow を自前で置く（循環を避ける）、(3) 7b は merge 済みなので、4 つの表の合計 20 の assert を足した、(4) bundle の sha256 は未実行。B-7（base と current-scene-missing は同値）＝DR-MP4-39d のとおり。B-8（unresolved の到達性は断定しない）＝同。B-9（`storyTimeOrder` の undo の食い違い）＝DR-MP4-39h のとおり Q5 (b)(d) の窓で、fixture は入れない。B-11（reader は渡された id にだけ引く）＝8a の reader のコメントと試験のとおり。B-12（件数）＝5 件に直した。
13. **DR-MP4-40m 旗 L を開ける前に見せる項目（MP-13。確認ではなく確かめる点）。C-23**：model 不在・feature 無効・未 index・workspace 不一致で、`search_codex` が legacy では sparse だけで成功、main では tool error になる（画面で見える差。40h）。C-24（既存の oracle）：hidden の本文への検索の命中が結果の件数に出る（40h。新しい経路ではない）。**C-25（既存の性質）**：AI に渡る一覧の並び（LIKE の arm・`list_codex_by_type`・`search_codex_by_tags`・`find_related_entries`）は SQLite の返り順に依存して不定（40j(1)。legacy と同じ。決定的にするのは別の PR）。

### DR-MP4-43 地図の AI 枝（AI Branch の種・Spotlight）は、Phase で hidden になる Codex を送らない（ユーザー決定の実装。技術判断を含む。2026-11-23）

**番号について**：この記録は DR-MP4-43 として置く。chat の通常の文脈・影響確認・MCP の各 lane の DR も、同じ挿入点（DR-MP4-40 の直後、`## 5.` の前）に足す。merge の順に番号と位置を確定し、docs の番号参照はこの見出し・この行・ADR 013 の 2 行に限る（コード・試験の注と commit の題名にも番号があり、一括置換できる）。**DR-MP4-41 の項 4（残る入口の列挙）の「地図の AI 枝」の行は、この PR では書き換えない**（隣接する行を別 lane の PR も直すので競合する。全 lane の merge 後の docs だけの小さな PR で「DR-MP4-43 で済」に直す）。

1. **決定の出所と範囲。** DR-MP4-41 のユーザー決定 Q2（2026-11-23）「chat の通常の文脈と地図は別の PR で揃える」の、地図の側の実装。Phase を解決できない経路（地図は場面を持たない）で、Phase が hidden にする項目を送らない向きに揃える。**送る範囲が狭まる向きだけ**で、新しい契約・authority・送信先・保存範囲・閾値の緩和・IPC の契約の変更は無い。NIR-1 の事前委任は根拠にしていない（この lane は NIR-1 の外）。AI に渡る文言・prompt の形・tool の schema・tool 集合は変えない（`mapAiApi.ts` は 1 文字も変えない。audit 経路 `map_branch` の `sourceRef` がここなので、触ると経路の検証の範囲が動く）。DR-MP4-41 の「Phase を持つ項目を全部 hidden」への広げすぎ（項 8 の変異）は採らず、規則は DR-MP4-41 と同じ集合：**hidden にする Phase を持つ項目だけ**。
2. **直し方（H1）。** 確認時、`generateAiBranchCards` の直前に、DB で `listCodexIdsHiddenFromAiInAnyPhase`（統合者の helper。#1031 の候補画面と同じ）を 1 回呼び、hidden の Codex を種・Spotlight から除く。同期の層（`collectAiBranchSeeds`・`fetchActiveSessionSpotlight` の base の mode の判定）は一層目として残す（hidden の本文がダイアログの state に入らない。既存の試験も変わらない）。**H2（`visibleCodexIdsForAi`）を採らない理由**：DR-MP4-41 の後は結果が同じ集合だが、`phaseStore` の状態に左右され、失敗を握りつぶして空にする（呼び側が失敗を区別できない）。**H3（地図の中で直接 SQL）**：判定の正本が 2 つ目になるので採らない。**送信の判定の時期**は「ダイアログを開く時」でなく確認時（開く時は同期の snapshot と authority を同じ turn で捕捉する既存の設計を崩し、開いてから確認までの Phase の編集に古くなる）。項 6 (a) の注記は、ダイアログを開いたときの別の読み（表示の補助）で、送信の判定を置き換えない（古くなりうるが、送信は確認時の判定が決める）。
3. **場面なしの意味と、増える除外の範囲。** DR-MP4-41 と同じ集合（base が hidden または不明、DB に無い、`authority.projectId` の project でない、どれかの Phase の override が hidden または不明）。**増える除外は「base 公開×Phase が hidden」「DB に無い id（store が古い）」「project が合わない（別 project の pin）」だけ**。base が hidden の項目は今も落ちていて変化なし。suppress（Phase の override が suppress だけの項目を含む）・mentioned は今までどおり送る（全部開示の方針）。
4. **id の運び方。** 局所の型 `AiBranchSeedSource = AiBranchSeed & { codexEntryId?: string }` を `aiBranchContext.ts` に置き、collect と Spotlight が Codex の id を運ぶ。送る直前に剥がして `AiBranchSeed[]` にする（prompt・送信に id は出ない）。id を持たない Codex の種は、由来を確かめられないので送らない。`seeds` と `seedNodeIds` の添字は揃わない（collect が store に無い id を飛ばす）ので、並行する id の配列は採らない。
5. **判定の失敗は送らず中止（ユーザー決定 2026-11-23：判定の読みが失敗したら、生成を始めず、既存の toast で通知する）。** 判定に失敗（DB の読みの reject）したら、送信 0 回で中止し、既存の toast「アイデアの生成に失敗しました」（`map.toast.aiBranchGenerateFailed`）を出す。「Codex だけ落として続ける」は、作者が選んだ種が黙って消え、結果が Codex を踏まえて作られたように見えるので採らない（DR-CJH-3 と同じ）。**画面には原因の説明（description）を出さない**（`AiBranchHiddenCheckFailedError` の message は英語の固定文で、日本語の画面に出さない。原因は debugLog に残る）。判定の失敗の toast には locale のキーを足さない（既存の題名だけの toast）。locale のキーは、項 6 (a) の注記の 1 つだけ足す（`ja.json` は初期 graph に入り、予算が動く。ユーザーが注記を選んだ 2026-11-23。数値は PR 本文）。判定が要るのは、種か pin に Codex が 1 件以上あるときだけ（0 件なら DB を読まず、失敗もしない）。`projectId` が空なら（helper は空だと project で絞らないので）入口で同じ失敗にする。**pin の一覧取得の失敗は従来どおり silent で空**（hidden の判定の失敗とは別）。判定の最中に project が切り替わると、helper は reject でなく全 id を hidden にして返す（`resolveCodexForAi` の epoch の検査）。この場合は、直後の `assertAuthority` が先に失敗するので送信しない（実害なし）。
6. **画面で見える挙動と、残る制限。** (a) **確認ダイアログの種の一覧（chip）には、AI に送られない Codex の chip に「AI には送られません」の注記を出す**（**ユーザー決定 2026-11-23**。当初案は注記なしで、名前が chip に出たまま AI に黙って送られなかった）。注記の対象は、送信時に除かれる Codex の種すべて：Phase で hidden になる項目、base が hidden の項目（今も chip に出て送られない）、DB に無い・別 project の項目。非 Codex の種（メモ・ステッキーなど）は変えない。**注記は表示の補助で、送信を許可・拒否するのは送信時の判定（`runAiBranchGeneration`）だけ**。注記の判定は同じ部品（`findHiddenCodexIds` → `listCodexIdsHiddenFromAiInAnyPhase`）を通り、規則を 2 か所に書かない（`listAiBranchCodexIdsNotSent`）。base が hidden で、同期の層がすでに種から外した項目は DB を読まず即座に注記が出る。それ以外の Codex は、ダイアログが開いたとき（種の一覧が確定したとき）に 1 回だけ DB で判定し、結果が返るまで・判定が失敗したときは注記なし（ダイアログは普通に使え、送信の判定が別に効く）。文言：ja「AI には送られません」、en「Not sent to the AI」（`map.aiNodeDialog.notSentToAi`）。**画面で見える挙動（PR 本文用）**：種の一覧の Codex の chip の右に小さな薄い文字で「AI には送られません」が付く。Phase だけで hidden の項目は、判定が返ってから（通常は一瞬）付く。判定が失敗したら付かないが、送られないことは変わらない。(b) **選んだ種が全部除かれると、種なしで生成する**（中止しない）。(c) **判定が失敗したら、生成を始めず、題名だけの既存の toast が出る**（DB が読めない異常時のみ。送信 0 回）。(d) 作者が Codex を hidden に変えた直後で、地図の store がまだ古い場合も、確認時の DB 判定で落ちる（以前は store の古い mode で渡りえた）。(e) 他の種（scene・note・sticky・snippet・ai_branch）の chip、ダイアログの他の部分、AI に渡る文言、生成されたカードの形は変えない（変わるのは、Codex の chip への注記だけ）。**残る制限**：以前に生成して board に残った ai_branch／sticky の文は、元が hidden の Codex を踏まえていても、種として再び送られうる（作者の board 上の文で、Codex の判定を通らない。ADR 013 の残漏れの範囲）。chat の通常の文脈と、地図の board を chat の文脈に載せる `loadMapBoardMarkdown` は別 lane。
7. **GDX-PRECHECK-001：owner／lifecycle の行列（コードと試験で確かめた事実だけ。実装と変異試験の後に書いた。mutation の前に要る項目で、その順序は守れていない〔記録〕）。** この変更は、外部送信（`map_branch`）の前に非同期の判定（await）を 1 段足す。廃止・追加する subprocess・background は無い。**構造上の保証**：`generateAiBranchCards` の呼び元は `runAiBranchGeneration`（`aiBranchContext.ts`）の 1 か所だけで（import を `src` 全体で数える静的試験で固定）、その関数の中で、同じ async の鎖の判定の後に送る。共有の可変状態は無く、再入した各実行は自分で判定する。

   | # | 経路・状態 | 保証（AI に送られない／送信は 1 回）の根拠 | 試験 |
   | --- | --- | --- | --- |
   | L1 | entry：確認ダイアログの確定 `handleAiBranchConfirm`（唯一の入口）。Spotlight の chat pin は同じ関数の中で取得し、同じ判定に通す | `MapCanvas` は `generateAiBranchCards`・`fetchActiveSessionSpotlight`・`fetchAiBranchProjectContext` を自分では呼ばない。seed・pin の Codex の id を 1 回の判定にまとめ、hidden を除いて id を剥がす | L1（5 件：Phase でだけ hidden・base hidden・解除の Phase・本文だけの項目が落ち、suppress の Phase だけの項目は残る／送信に渡る項目の key／store が古い・DB に無い・別 project／H2 が空でも落ちる／1,001 件の分割） |
   | L2 | 全部の種が除かれる／Codex が 0 件 | 除いた結果が空でも送信は 1 回（種なし）。0 件なら判定を呼ばず、失敗もしない。非 Codex の種は無条件に残り、順序を保つ。id の無い Codex の種は送らない | L2（4 件） |
   | L3 | 判定の失敗（helper の reject、`projectId` が空） | `AiBranchHiddenCheckFailedError` で reject。送信は 0 回。`catch` で握りつぶさない。MapCanvas の catch は題名だけの toast を出し、`finally` で spinner を解除。retry は無い（作者が開き直す） | L3（4 件：seed 経由・pin だけ・pin の一覧取得の失敗は silent・空の `projectId`） |
   | L4 | admission の閉鎖：`assertDialogAuthority`（project・workspace・board の切替の検査） | 判定の後・送信の直前に `assertAuthority` を呼ぶ（以前は context の取得の後と送信の直前の 2 回。取得と判定は 1 つの await 区間になったので 1 回に束ねた）。MapCanvas は非同期の前にも 1 回検査する（既存）。throw したら送信 0 回 | L4（順序が 判定 → 検査 → 送信。throw で送信 0 回） |
   | L5 | 再入：確定の連打（`AINodeDialog` に二重送信の防止は無く、同じ closure が 2 回走りうる）、生成中の再度の AI Branch 起動（`handleOpenAiBranch` は `generatingAiBranch` を見ない） | 実行ごとに自分の判定を持つ。共有状態が無いので、片方の判定の結果をもう片方が使わない。重複した生成は従来からの窓（悪化しない） | L5（2 本を並行に走らせ、判定が返るまで送信 0 回。送信はそれぞれ自分の判定の結果） |
   | L6 | project・画面の切替 | 切替をまたぐと、helper は全 id を hidden にして返すか reject する。いずれにせよ送る前の `assertAuthority` が先に失敗するか、hidden が除かれる。画面を閉じても await は続くが（キャンセルの手段は元から無い）、送信は必ず判定の後 | L6（判定の最中の切替を、flag で模して `assertAuthority` が検出し、送信 0 回。**実物の epoch の検査〔`resolveCodexForAi`〕と実物の `assertAiOperationAuthorityCurrent` は通らない**。epoch の経路は 8a・DR-MP4-41 の試験が固定している） |
   | L7 | 配線（呼び元が判定を通らずに送る形に戻る） | 上の振る舞いの試験が主。補助として、`generateAiBranchCards` を import する非試験の file が `aiBranchContext.ts` だけであること、`MapCanvas` が `runAiBranchGeneration` を呼び、取得を自分で呼ばないことを文字列で照合（`MapCanvas` の描画の試験は無いので補助。落ちたら、判定を通らない経路が生えていないか確かめる） | L7（2 件）。変異 11a・11b で落ちる |
   | L8 | 中止後の状態 | board・Sticky・位置は無変更（`createAiBranch` は呼ばれない）。ダイアログは閉じたまま（確定の時点で閉じる。再試行は開き直し）。spinner は `finally` で解除。履歴（undo）に積まれない | （MapCanvas の描画の試験は無いので、未固定。L3 で送信 0 回を固定） |
   | L9 | 受容する窓 | 判定から送信までの間（数 ms〜数十 ms）に作者が Phase を編集する窓は、chat の通常の経路と同じで受容する。`MapCanvas` の store が古い窓は、確認時の DB 判定で閉じる | — |
   | L10 | pending-start work：判定の await の最中に画面（地図のパネル）を閉じる | 閉じても await は続き、project と closure の board が変わらなければ、判定の後に送信される（既存。キャンセルの手段は元から無い。悪化しない）。送信は 1 回で、判定を通る | —（L5・L6 の範囲） |
   | L11 | active handle ownership | handle を持たない（subprocess・background・timer・listener を足さない）。送信は transport の promise 1 本で、`runAiBranchGeneration` の async の鎖が所有する | —（該当なし） |
   | L12 | actual termination evidence | transport の promise の解決・reject が終了の証跡。判定は DB の読みの promise の解決・reject。kill や close を要する資源が無い | L3（reject で送信 0 回） |
   | L13 | persisted restart state | 無い（判定の結果・中止の状態を保存しない。再起動で持ち越す状態は無い） | —（該当なし） |
| L14 | entry：ダイアログを開いたときの注記の判定（表示の補助。`AINodeDialog` の effect が `listAiBranchCodexIdsNotSent` を呼ぶ）。送信の許可・拒否には関わらない | **start**：種の一覧が確定したとき（ダイアログの mount、または種の一覧の key が変わったとき）に 1 回。同期の層ですでに外れた Codex は DB を読まず即座に注記。**retry**：無い（失敗したら注記なしのまま、作者が開き直す）。**reentrant**：種の一覧が変わる・ダイアログを開き直すと新しい判定を始め、結果は判定した一覧の key と組で持つので、別の一覧の結果は使わない。同じ一覧のままの再描画では呼び直さない。**admission の閉鎖**：古い結果（一覧が変わった・閉じた後）を捨てる（effect の cleanup の flag と key の照合の二重）。送信の admission は L4 のまま、注記の結果は使わない。**キャンセル**：閉じる（unmount）・一覧の変更で結果を捨てる（DB の読みそのものは止められない。有限の読みで handle を持たない）。**失敗の扱い**：注記なし（ダイアログは普通に使え、送信の判定が別に効く）。**persisted state**：無い | L14（`aiBranchContext.realHidden.test.ts` 5 件：実 DB で Phase hidden・base hidden・解除の Phase・公開・suppress・DB に無い・別 project、送信時の判定と同じ結果、chip の meta、0 件・空の projectId・失敗、注記の判定が失敗しても送信の判定が効く／`AINodeDialog.test.tsx` 7 件：注記が出る・出ない chip、判定中、失敗、判定を呼ばない場合、unmount、一覧の変更で古い結果を捨てる、再描画で呼び直さない） |

   「cancellation」：確認前の取り消し（Escape・外側のクリック）は何も起こさない。確認後の生成中の取り消しの手段は元から無い（変えない）。「有限の待ち・error／timeout の所有」：判定は DB の読み（500 件ずつの有限の回数）で、timeout は呼び側の transport に無い（変えない。失敗は reject で終わる）。
8. **変えた試験の期待。** (1) `aiBranchContext.characterization.test.ts`（commit 1 の特性試験）の 3 件：①「Codex の seed」の 4 件の期待に `codexEntryId` を足した（型に新しい項目が増えたため）、②「Spotlight の順序」の Codex の 1 件の期待に `codexEntryId` を足した、③ **穴の期待を反転**：「旧来の合成（collect＋Spotlight＋generate）では、Phase でだけ hidden の項目の名前・概要が AI へ送られる」→「同期の層には残るが、`runAiBranchGeneration` の送信には載らない」（**呼び先も `generateAiBranchCards` の直接の呼びから `runAiBranchGeneration` に替えた**。同期の層の戻り〔Phase でだけ hidden の項目が残る〕の assert は無変更）。(2) `aiBranchContext.codexHidden.test.ts` は無変更で通る。(3) 注記の追加（項 6 (a)）では、既存の試験・期待は 1 件も変えていない（`AINodeDialog.test.tsx` と `aiBranchContext.realHidden.test.ts` に新しい describe を足しただけ。`vi.mock` で `aiBranchContext`・`AINodeDialog` を差し替える試験は無く、browser の試験にも該当は無い）。
9. **変異（一時的に実装へ入れて試験が落ちるのを確かめ、戻した。`cmp` で元と同一を確認）。** 3 file（`aiBranchContext.ts`・`MapCanvas.tsx`・`codexHiddenAnyPhase.ts`）を対象に 17 通り。①seed の除外を外す：9 件が落ちた。②Spotlight の除外を外す：3 件。③判定を base の mode だけに差し替える：11 件。④判定の失敗で続行（fail-open）：2 件。⑤失敗時に種を空にして続行（中止しない）：2 件。⑥`projectId` を helper に渡さない：1 件。⑦`codexEntryId` を剥がさず渡す：1 件。⑧suppress も落とす（同期の層）：2 件。⑨Phase を持つ項目を全部 hidden（helper）：1 件。⑩順序を保たない：3 件。⑪a MapCanvas が `runAiBranchGeneration` を呼ばない：1 件。⑪b MapCanvas が `generateAiBranchCards` を直接 import：1 件。⑫`assertAuthority` を判定の前に移す：2 件。⑬Codex が 0 件でも判定を呼ぶ：1 件。⑭id の無い Codex の種を通す：1 件。⑮空の `projectId` で続行：1 件。⑯seed の id を判定に入れない（pin だけ判定）：8 件。注記の追加の分（4 通り）：⑰chip の DB の判定の結果を使わない（注記が出ない）：4 件。⑱同期の層で外れた chip の注記を外す：2 件。⑲注記の判定を送信時と違う規則（base の mode だけ）にする：8 件。⑳古い結果の key の照合と flag を両方外す：1 件（**どちらか 1 つだけを外すと落ちない**：両方が同じ事象を防ぐ二重の守りで、片方だけでは観測できる差が出ない。unmount 後の state 更新は React 19 では警告も出ないので、unmount の試験は単独では落ちない）。
10. **検証の要点。** main の 3 bundle の sha256 は、変更の前後で同じ（`main.cjs` 9efeca2b…、`preload.cjs` 46d054ca…、`mastra-agent.cjs` 041f5ac4…。renderer だけの変更。注記の追加の後も同じ）。golden の書き換えは無い（地図は agent tool の read を通らない）。実 addon の spec は不要（IPC・main・N-API・Rust を通らない）。impact-map・quality-manifest は追従なし（新しい試験 file は未分類の path で全 suite になる側で、足すと絞ることになるので足さない。`MapCanvas.tsx` は `d2a-profile-egress` の path に在るだけで、その rule は変わらない）。`mastra-mp4-decisions.md` の DR-MP4-41 の項 4 は書き換えない（「番号について」）。
11. **計画との差。** (a) `assertDialogAuthority` は、context の取得の後と送信の直前の 2 回から、判定の後・送信の直前の 1 回（`runAiBranchGeneration` の中、callback で受ける）に束ねた。意味は同じ（非同期の読みの後・送信の前に必ず検査する）。(b) provider の読み（`vs` の組み立て、同期）は、await の前に移った。(c) id を持たない Codex の種は送らない（計画は「無条件に残る」。由来を確かめられない種を fail-closed に倒した）。(d) `aiBranchContext.codexHidden.test.ts` に `codexHiddenAnyPhase` の mock は足さなかった（足さなくても import が通り、期待も変わらない）。(e) 判定の失敗の toast は題名だけ（計画の案 B）。(g) 注記の追加（ユーザー決定 2026-11-23）：当初の計画は注記なし。注記の判定を送信時の判定と同じ部品に通し、ダイアログを開いたときの非同期の読み（L14）を足した。locale の key を 1 つ足した（当初は足さない方針）。(f) 計画の「静的な守り」は補助に降ろし、`generateAiBranchCards` の呼びまでを 1 関数に閉じて、振る舞い（送信の境界）で固定した（反証 P2-4）。

## 5. PR の分け方

旗 L は全 PR で閉のまま。各 PR は独立に merge でき、独立に戻せる。確認待ちの項目を後ろの PR に寄せる。
**4c は 4c-1（main 側）と 4c-2（renderer 側）に分ける**（改訂 2。Opus のレビューの提案を採る）。契約変更は計 2 回：4a の 3 欄（承認済み）と 4c-1 の wire 一式（Q4）。4c-2 は新しい契約を作らない。
**脅威モデルは確定文書**（`mastra-migration-threat-model.md:3`†。変更は新しい確認を要する）なので、
脅威モデルへ書くのは (i) ユーザーが決めた事実（決定 3）と、(ii) ユーザーが回答した確認の内容（回答 3。**反映済み**）だけにする。未回答の判断（Q5 など）は書かない。

### 4a 契約の 3 欄（承認済み。回答済み）

- 範囲：wire の 3 欄（DR-MP4-1。回答 1 のとおり `currentSceneId` は `string | null`）、owner の Turn、sink の projectId と chatMessageId（DR-MP4-2、23）、default-project の拒否、
  形式検査（`isTrimmedId`＋Rust の空白の拒否。K-19）、関連 test の fixture（wire／owner／gate／renderer wrapper／runtime bundle／journey の startRequest と、journey test の「seven keys」の件数。未再確認）、
  decisions の記載（第 9.3 節の 4a の分）。DR-MP3-24 の `unsupported` と `invalid` の食い違いを揃える。
- 脅威モデルと計画書：**決定 2・3 と回答 3 に由来する記載**（U-4(f) の延期、U-7 の決定、MP-4 の範囲の読み替え、R-25、D13、T11 の IR の部分、第 6 節 7、T13・D16・W11）。
  この記載は **2026-11-21 の改訂で先に反映済み**（第 9 節）。Q5 に関わる追記（失効の観測の弱まり）は **4a に入れない**。
- 変えないもの：tool 0・1 step、`parentExecutionId` は null、renderer の分岐は入れない（型の追従だけ）。
- 試験：wire test（key 列挙、issue code、値を echo しない、Native の判定に合わせた空白の拒否を実 addon で固定）、owner test（`projectId === null` の期待を request の値へ）、
  sink／実 addon の pipeline spec（scope が project chain に入ること）、journey。
- **precheck の条件**：回答 1（**済**）。PR 本文に DR-MP4-1・2・23 と信頼境界を書く。journey の catalog 自体を触るなら `workload-allocation.json` の digest も更新し、push 前に `verify:quality`（Node 22。K-12）を通す。Quick。
- **4a は 3 欄をまとめて、回答 1 の後に着手する**（回答済み。部分的に実装しない）。
- 変更後も製品の挙動は不変（旗 L 閉。製品の呼び手は 0）。

### 4b 共有 core と main の read（turn には繋がない）

- 範囲：core と ports（DR-MP4-3）、read 専用への module の分離、main の db adapter（送信前の検査・caller の timeout を含む）と typed read の wrapper（DR-MP4-4〜6）、
  read の時点の規則（DR-MP4-5）、hidden・年表の入力の再構築（DR-MP4-8）、IR の静的試験（DR-MP4-21）、tokenizer の port、**IPC の timeout 定数の共有 module 化**（renderer の値は不変。DR-MP4-4）、
  **IR を含まない tool の定義 module と drift 試験**（DR-MP4-30）。wire は変えない。tool を turn に載せない。
- `schema.ts` を動かす場合は、同じ PR で `validate-narrative-writers`・`impact-map`・`quality-manifest` の参照先を更新し、未登録の narrative 表を検出できる負の試験を足す（DR-MP4-3）。
- tokenizer の実装（wasm の配り方）は **4b に入れない**。4b は port と試験用の数え値（1 文字＝1 token と、renderer の exact）までで、
  実装は 4c-1 で入れる（init の測定と配線の spike は 4b の中で、build が使えるときに行う。配布物は変えない）。
  spike では main thread の占有（init、大きい読みの結果の整形と数え）も測る（DR-MP4-18、K-16）。
  **（2026-11-21：tokenizer の実装と K-16 の spike は 4c-1 へ持ち越す。4b は port の型と試験用の数え値まで。第 5 節「4b の PR 計画」の 4。）**
- 試験：legacy の `toolExecutors.test.ts` が core 化の後も通る（結果が変わらない）。実 addon の pipeline spec（`d2aOwnDataRead.pipeline.spec.ts` の型）で同じ fixture DB を renderer 版（invoke の proxy）と main 版（dbExecute の adapter）で比べる。
  最重要の項目：hidden（phase 解除、released の summary・本文・details）、年表 secret の位置フィルタ、XPROJ、barrier なしの差（Q5 まで同値試験の対象外と注記）、
  **他 project の `currentSceneId` を渡す fixture**（DR-MP4-8）、**場面なし null の年表（secret を隠す）と Codex（base）**（DR-MP4-1）、adapter の送信前の検査（SELECT 以外で Native を呼ばない。spy）、timeout 定数が renderer の表と一致。
- 脅威モデル：回答 3 の分（T13・D16・W11・残るリスク）は**反映済み**。失効の観測の弱まりは Q5 の回答の後に 4c-2 で書く。
- **precheck の条件**：回答 3（**済**）。P2-2（caller の timeout。DR-MP4-4 に設計を書いた。実装と試験が条件）。import 閉包の実測（K-10。**2026-11-21 に実測済み。残る未確認は第 5 節「4b の PR 計画」の 2**）。K-4・K-5。K-6。
  （K-16 の spike と K-23 の確認は 4c-1 へ持ち越した。第 5 節「4b の PR 計画」の 4）
  budget・閾値の測定で既存の ceiling を超えるなら実装を止めて確認する（C-8、C-16。条件つき）。
- merge 条件：Quick、独立レビュー（第 7 節）。`get_foreshadow_detail` の既存の非対称（DR-MP4-24）を PR 本文に書く。P5 の入力（DR-MP4-8）は K-4・K-5 の解消が前提。
- 製品の挙動は不変：main の新しい module はどこからも呼ばれない。

### 4b の PR 計画（2026-11-21、実測の後）

- 出所：4b の実測 workflow（wf_060f17b9-df2。K-10・K-4・K-5・K-6）の統合と、その反証。数と行番号は実測 agent の報告で、この小節の起案では再実行していない
  （†のない数は未再確認）。PR-0 の列に書く legacy の事実だけは、PR-0 の試験を実際に走らせて確かめた。
- 区別：置き場 A の確定と PR の分け方は**技術判断**（確認は報告のみ。ユーザーの確認で止めない）。止めるのは、品質ゲートの走査対象を狭める・閾値を緩める場合だけ。
  新しい送信先・保存範囲の拡大・新しい契約や authority は 4b の範囲に見当たらない。ただし「main の adapter が turn の identity を付けて `backend.dbExecute` を直に呼ぶ」ことは、
  DR-MP4-4・5 で承認済みの authority と同じ経路を user data の表の read へ広げる判断として扱う（`ipc.ts:1064-1082` の policy 判定の SELECT が前例。read 専用・表は allowlist・unrestricted 限定）。

#### 1. 置き場 A の確定（DR-MP4-3 の改訂）

- **決定：A（共有 core と schema を `electron/shared` に置き、`src/db/schema.ts` は re-export にする）。A′ と B は採らない。**
  bundle の載せ方（A″＝4 つ目の lazy bundle）の判断は 4c へ送る。
- 根拠（K-10 の実測）：
  1. 閉包の大きさを決めるのは置き場ではなく「read／write の分割」と「store・invoke・db・i18n・countTokens の port 化」。分割しないと、どの案でも
     610 module・13.5 MB（read 側の直接 import だけの R1）から 705 module・15.6 MB（`toolExecutors` 全体の E1）になる。
     分割後の pure の下限は **143 module・454 KB**（E2）、drizzle の sqlite-proxy を足して 148 module・574 KB（E2A）。
     React・zustand・i18next・@tauri・`lib/tauri`・`db/client` は閉包に入らない。置き場の差は、型検査・品質ゲート・drift の運用コストにだけ出る。
  2. **B は electron の NodeNext の tsc で落ちる**（`electron/tsconfig.json`：NodeNext、paths なし。src の 24 file だけで 38 件）。bundle は通る
     （esbuild は src の file について最寄りの tsconfig の paths で `@/` を解決する）が、electron は現在 src を 1 件も import しておらず、その慣習を破る。
     節約できるのは pure 26 本の path の書換えだけで、分割が要る 11 module は B でも減らない。
  3. **A′ は表が設計書の「18＋2」でなく 23 表**（FK 先を含む。約 32.5 KB。`schema.ts` は 168 KB）。drift 試験の対象が設計より広く、節約は約 113 KB だけ
     （E2A 573,705 → E2Ap 460,944）。temporal-polyfill（約 179〜188 KB）は phaseResolver 経由で残る。
  4. **A は実現できる見込み**。pure 26 本の変更は、`@/` の 19 行と拡張子なしの相対 import の 19 行の機械的な書換えと、型 6 つ
     （`EventRow`、`SceneEventRow`、`TreeNodeData`、`TemporalNodeId`、`StoryCompare`、`StoryRankResult`）の切り出し。
     NodeNext での DOM 型・Node 型の error は 0。`schema.ts` の NodeNext 上の error は `@/lib/time`（`schema.ts:13`）の 1 件だけ。
     src の importer は 157 file（試験込みで 206）だが、re-export にすれば import 文は変えずに済む。
  5. 4b は turn に繋がず core の呼び手は試験だけ。esbuild は entry から辿れる module だけを bundle に入れるので、**4b では main.cjs は増えない**と見込む
     （推論。未ビルド。PR-1 の merge 前に esbuild を `write:false` で再現して差分 0 を確認する）。A の約 +0.63 MB（+20%）が効くのは 4c の接続時で、
     載せ方（main.cjs か A″か）は coldStartMs（上限 4,000 ms）への影響を測ってから 4c で決める。超える見込みなら閾値の緩和・新設になるので、その時に確認する。
- A の代償と対策：
  - 品質ゲートの更新は**緩和でなく走査対象の追従と負の試験の追加**（PR 本文にそう書く）。`validate-narrative-writers.mjs:216-228` は `schema.ts` を読んで
    `sqliteTable("narrative_…")` を数える。実体が無くても `existsSync` は通り、検出が空のまま通る。そこで validator は**実体の新 path を読み、`sqliteTable` の検出が 0 件なら失敗**にする
    （空の検出を許さない）。旧 path は re-export のときだけ許す。ほかに `evals/impact-map.yaml:772`（schema 系の trigger に新 path）、`evals/quality-manifest.yaml:1608,1657`、
    `validate-narrative-writers.test.mjs` が `src/db/schema.ts` を fixture として書き出す箇所（`:342` 付近）の追従が同じ PR に要る（gate の更新は 3 か所でなく、この試験 file を含めて 4 か所）。
  - `schema.ts` が `lib/time`・`lib/temporal` を引くので、この 2 つも移すか相対 import にする。
  - 閉じた narrative 表を含む 143 表が main から import できる状態になる。**表の allowlist 試験**（下の PR-4）と IR の静的試験で抑える。
  - `chronicleReadingPosition.ts` は **IR 専用**（`isEventBeforeOrAtScene`、`passesIrExclusionApproximation`。製品での利用者は `toolExecutors` の IR 近似だけ）なので、
    移動の対象から**外して src に残す**（renderer 層。IR の近似は renderer 層に残すという切り方と一致させる）。移すと、IR の静的試験（DR-MP4-21。`chatAgentIrClosure.test.ts:89-108` が列挙）と
    「近似は `search_events` だけが使う」の走査（`toolExecutors.chatIr.test.ts:1480-1500`。src だけを走査）が、実体の無い re-export stub に対して空のまま通る。
    PR-3b の本文に移す 26 本の一覧を列挙する。
- 決定の種別は決定 2 の (D) の範囲の技術判断。新しい送信先・保存範囲・authority・閾値の緩和を伴わない。

#### 2. 実測の要約（K-10・K-4・K-5・K-6）

- **K-10（import 閉包）**：上の根拠 1〜4。**残る未確認**：型 6 つを実体に差し替えた後の NodeNext の追加 error、分割後の抽出関数そのものの NodeNext の compile、
  `validate:architecture` に electron から src への禁止規則があるかの網羅（`scripts/validate-architecture.mjs` に electron の語は出ないことまで確認。`eslint.config.js` 全体は未精査）、
  esbuild の動的 import が `__esm` で遅延評価されるか。renderer が electron/shared の `.js` 付きの相対 specifier を受けることと、`validate-narrative-writers` が import した識別子名で protected 表を検出し
  module specifier に依らないこと（走査 root に electron を含む）、`schema.contract.test.ts` が `export *` の re-export で通ることは確認した。
- **K-4（読む順・localeCompare）**：Node 24.18.0（ICU 78.3、CLDR 48.0）での実測のみ。UUID 小文字は ja／en／und／de／sv で差 0（200,000 対）。大文字・`_` を含む id は
  `localeCompare` と binary で約 1.5% 異なる。da ロケールだけ "aa" で差が出る（UUID でも 90/50,000）。同順位の id の tie-break にだけ効く。
  phase の並びにも同種の比較が 2 か所ある（`resolveApplicablePhases.ts:87`、`phaseResolver.ts:190`）。Electron の main の既定 locale と Chromium での実測は未確認。
  **tool 定義の並び（DR-MP4-30）：否定側で答えが出た**（2026-11-21、PR-3 のレビュー）。`LC_ALL=cs_CZ.UTF-8` の Node では `localeCompare` の並びが変わり（cs・sk で "ch" が "h" の後ろ）、drift 試験と legacyGolden の 17 件中 6 件が落ちた。
  4c-1 で comparator を固定 locale／code unit にするか（renderer の cs・sk の利用者の bytes が変わるので判断が要る）、locale を変えた試験を足すかを決める。4b（PR-3）は挙動を変えていない。
  **4b では `localeCompare` の tie-break を現状のまま共有する**（変えるなら確認）。Rust の `derive_live_scene_projection` は流用しない（TS と Rust で 11 件中 7 件が異なる）。
- **K-5（store から DB までの窓）**：Q5 の窓は次の 8 つ。止まるのは 4c-2 で、4b は止めない。(1) `resolutionMode` の変更から DB 反映まで（300 ms の trailing debounce。書込み失敗では store が戻らず永続的にずれる。
  `flushProjectMetadataWrites` を turn 前に呼べば窓は消せるが失敗時の扱いの判断が要る）。(2) tree の並べ替え・移動（store が先、直後に DB。`moveTreeNode` に rollback なし。
  **ずれの向きは両方向**。追加・削除・`storyTimeOrder` の通常の編集は DB が先なので逆向きの短い窓。削除の undo は (8)）。(3) 外部プロセスの書込み（750 ms の polling。grid／chronicle bulk の scene 以外の tree 構造変更が store に届く経路は未確認）。
  (4) `activeSceneId` の不一致（active scene の削除・外部の再読込は chat へ publish せず passive effect に頼る）。(5) turn 中の変更（main は batch／turn の開始時点で固定、legacy は live。年表の events・scene-events・Codex 名の cache は main では turn の間残る。DR-MP4-37i、Q5 (f)）。
  (6) `localeCompare` の既定ロケール（上の K-4）。(7) 本文の barrier（`get_scene`・`get_thread_scenes`。DR-MP4-9）。
  (8) **削除の undo（PR-6 のレビュー P2-1。窓でなく reload まで続く）**：store は削除前の `storyTimeOrder`（と chronicle の欄）を戻すが、DB の行は欄なしの INSERT で NULL のまま作り直される。auto の軸の反転と Codex への影響は PR-6 の記録の 11。
  **DR-MP4-8 の「DB が古いと開示側にずれうる」は片方向の記述。移動のずれは両方向**（現在の場面を前へ、または reveal／anchor の場面を後ろへ動かすと DB が古い main のほうが広く開示し、逆なら狭い）と直す。
- **K-6（main の read の閉包）**：main の閉包が触る表は 20（`codex_detail_definitions`、`codex_detail_values`、`codex_phase_detail_overrides`、`foreshadow_codex_links` を含む）。
  - **「main の read 表は全部 internal」は誤り**。foreshadow 系 3 表・plot_thread 系 3 表・typed read 4 本は own-data-read（restricted の分類）。DR-MP4-5 の下（restricted の turn を作らない）では直呼びが JS gate を通らないため実害はない。
    P3 の行と脅威モデルの文言に「internal 前提」があれば直す。**さらに閉包の表のうち 14 表が台帳外（unclassified）で、台帳外の表は read として通る**。DR-MP4-5 が restricted の turn を作らない前提で足りるかは確認が要る。
    restricted（activate 後）に main から `dbExecute` を 4 引数で直に呼んだときの実挙動は実 addon で通していない（ソース読解と既存 spec の前例のみ）。
  - 技術判断：main の `dbExecute` に第 5 引数（own_data_read）を付けない（restricted の turn を作らない DR-MP4-5 と整合し、unrestricted では無効果。将来 restricted を許すときに再評価）。
  - 技術判断：timeout は定数 2 つ（`IPC_TIMEOUT_MS` 10,000、`AI_IPC_TIMEOUT_MS` 300,000）と 4 command の対応だけを shared に出す。表ごと出すと `chat_agent_ir_select` の文字列が main の閉包に入り、DR-MP4-21 の静的走査と衝突する。値は変えない。
    **差を残す**：legacy の `db_execute` は `isReadOnlyDbExecute`（SELECT／WITH で始まり、INSERT・UPDATE・PRAGMA などの語が quoted を除く本文に無い）を満たすときだけ 10 秒で、満たさないと timeout なし。
    main の adapter は送信前の SELECT 検査を通った文だけを 10 秒で扱う。legacy が timeout なしになる境界の文は main では 10 秒で打ち切る。4 command の対応は同値でなく**写し**。
  - 設計書への反映：timeout の根拠行は `:268-270` でなく `:268-269`。

#### 3. 設計書の訂正

| 設計書の記載 | 実測 |
|---|---|
| DR-MP4-3「閉包の見積り約 20 module」 | 直接 import の数としては妥当。推移閉包は 610〜705 module |
| 「src が electron/shared を import する前例 38 file」 | 機械的 grep で 33 file（試験込み 60） |
| A′ の表は「18＋2」 | 23 表（FK 先を含む） |
| `impact-map.yaml:771` | 772 |
| `chatTurnPreflight.ts` の path | `src/application/chat/` が正しい |
| DR-MP4-4「既存バグ：`policyAllowsAgentTool` が object の行を配列として読む」 | 当たらない。#989 で直っており設計書が古い（`aiPolicyColumn` が object 行を読む）。main が identity を付けて `backend.dbExecute` を直に呼ぶ前例は既に `ipc.ts:1064-1082` にある（policy 判定の SELECT） |
| DR-MP4-8「DB が古いと開示側にずれうる」 | 片方向の記述。両方向（K-5 の (2)） |
| IR 分岐の切り出しは 4 行（`:55`、`:447`、`:527`、`:668`） | 足りない。ほかに import の `:50-64`、`:111-113`、`:460-466`、`:702`、`:2570` |
| 「main の read 表は全部 internal」 | 誤り（K-6） |
| DR-MP4-3「core の `projectId` は必須（空なら throw）」と legacy の「No active project を結果で返す」 | 食い違う。**no-project の分岐と引数検査の順序は renderer の薄い層に残し、必須は core の新 entry にだけ課す**。既存の共有関数（`resolveCodexForAi`／`visibleCodexForAi`）のシグネチャと falsy な projectId のときの挙動は変えない |

#### 4. PR の表（PR-0〜PR-9。反証の直しを入れた形）

旗 L は閉のまま、turn に繋がない。同時に出す PR は 2 本まで（セッション間の取り決め）。後続の各 PR の「製品が変わらない」ことは、PR-0 の golden が不変であることで言える。
ただし PR-0 の golden は browser-mock（sql.js）由来で、fts は LIKE の arm、semantic 2 本は `[]`、foreshadow は Drizzle の分岐になる。**Native の fts／typed read の結果の同値は示さず、main 側の同値は PR-9 の実 addon spec の担当**（PR 本文に書く）。

| PR | 範囲 | 試験で閉じる方法 | 前提・止まる点 |
|---|---|---|---|
| PR-0 | **legacy の特性試験（試験だけ。製品のコード 0 行）**。20 本×{行あり、空、no-project、XPROJ、引数検査と no-project の順序}を実 sql.js で golden（content と JSON の bytes）に。legacy が Native へ出す invoke（command・引数・scope）を spy で固定。定義の bytes（44 本、M4 の 20 本、research subset、CREATOR_TOOLS の順、snapshot の並び）。`countTokens` は 1 文字＝1 token に固定。seed は data として再利用できる形（`__fixtures__/legacyReadSeed.ts`） | `toolExecutors.legacyGolden.test.ts`（golden 20 file）、`toolExecutors.legacyNativePort.test.ts`、`toolDefinitions.legacyGolden.test.ts`。golden は未変更の legacy から生成 | 試験だけ（Quick）。新 file は `impact-map.yaml` の tool-policy の paths（`src/features/chat/agent/**`）の下にあるので、選択される requirement・suite は親が確認する。`__fixtures__/` は `ci-change-scope` で Rust・migration の lane を落とさない扱い |
| PR-1 | 基盤（呼び手なし）：timeout 定数の shared module（値不変）、db adapter（送信前に先頭 SELECT を検査、method は all／values のみ、marker は read のみ、整数様 key は throw）、typed read 4 本、port の型（getter 形）、**tokenizer の port の型と試験用の数え値（1 文字＝1 token）**、IR 静的試験の枠（走査対象が空でない assert と負の fixture）、K-6 の実 addon spec 1 本。**semantic 2 本の port は `workspacePath`（turn の identity 由来）を渡し、backend の method が無いときは fail-closed（throw）にする。legacy の事後 identity 照合（`SEMANTIC_WORKSPACE_CHANGED`）は main では `assertLive`（3 状態）で置き換える** | 値の一致（`tauri.electron.test.ts` の 10,000 の pin）、adapter の拒否（`dbExecute` の spy が 0 回）、静的試験、実 addon spec に semantic 2 本の workspace 不一致の拒否 | 実 addon が要る spec は napi build の後。既存の定数以外の値を置かない（C-18）。**merge 前に esbuild を `write:false` で再現して main.cjs の差分 0 を確認** |
| PR-2 | read の lifecycle（DR-MP4-5）：in-flight の計数、`assertLive` の 3 状態、await 後の再確認、quiesce・forced・quit の待ちへの算入 | `mastraTurnOwner.test.ts`。owner（878 行）を触るので単独 review | 既存の bound（5 s、30 s）に乗せ、新しい値を置かない。PR-1 と並行可 |
| PR-3 | IR を含まない定義 module（M4 の 20 本、`SEARCH_EVENTS_DESCRIPTION`、`sortSchemaKeys` と決定的 sort）を `electron/shared` に置き、renderer の `toolDefinitions.ts` は import して IR の部分だけ足す | PR-0 の bytes golden と `toolDefinitions.chatIr.test.ts` の 6 件が不変。drift 試験（bytes と並び）は **src に置く**。IR 静的試験（定義 module が `toolDefinitions.ts` を import しない） | schema に依存しないので置き場の確定を待たずに出せる。**tool の description と schema は AI へ渡す入力（AI behavior asset）なので、grimodex-impact-gate を適用し Quick だけにしない**。新 module を `quality-manifest` の `implementedBy`（GDX-TOOL-001）と `impact-map` の tool-policy の paths に追加（追従）。型は shared に置くか `agentWire.ts:25` の前例（複製＋相互代入試験）に倣う |
| PR-3b | **移設**：pure 26 本（`schema.ts`、`lib/time`・`lib/temporal` を含む。`chronicleReadingPosition` は含めない）を `electron/shared` に移し、旧 path は re-export。`@/` と拡張子の書換え、型 6 つの切り出し、`RRF_K` の別 module 化（`semanticRecall` は re-export）。同じ PR で品質ゲートを更新（上の 1。validator は実体の新 path を読み 0 件で失敗、`validate-narrative-writers.test.mjs` の fixture、impact-map、quality-manifest） | tsc（electron NodeNext）、既存の renderer 試験が無変更で通る、validate-narrative-writers の負の試験（未登録の narrative 表を検出）。**着手前に、移す 26 module を参照する `vi.mock` と `readFileSync` 系の走査を grep で全数にして PR 本文に一覧し、mock が要る箇所は新 path にも掛ける**（移動先の module 同士の相対 import は旧 path の mock を通らず、試験は通るが内部の呼出しが実物になる） | 置き場 A（上の 1）。C-8（起動 graph の ratchet）。設計書にこの PR は無く、PR-4 の前提として追加する。受入れに `inlineAiContext.codexHidden.test`、beat、foreshadow、`contextBuilder` の hidden 関連の既存試験を加える（`phaseResolver`・`sceneTimeIndex`・`resolveApplicablePhases` の呼び手が波及する） |
| PR-4 | core の骨格（ports、`createReadExecutors(ctx)`、legacy 側の ctx＝live getter）＋B1（list_codex_tags、list_chapters、get_chapter_summaries、get_scene_timeline_neighbors）＋B2（list_plot_threads、get_thread_scenes、get_scene）。legacy の re-point は同じ PR で行う（コピーを先に置いて後で切り替える案は約 1,500 行が一時的に二重になるので採らない） | PR-0 の golden が不変、既存の 4 本が無変更で通る（mock の seam を保つ）。**表の allowlist 試験**（K-6 の実測値＝20 表を基準に固定。増減は PR の差分として見える形にし、closed 表を 1 つ足すと落ちる負の fixture を入れる）。「core が store・invoke・tauri・i18n・IR を import しない」静的試験は **src に置く**。**PR-9 の同値 spec（同じ fixture DB を renderer 経路と main の adapter で比べる）の最初の版を受入れに入れる** | PR-3b の後。**着手前に `withDetails` の経路（`codexHiddenFromAi` が `detailApi`・`phaseApi` を import する）を core に含めるか legacy に残すかを決め、allowlist をその値に固定する**。B2 の本文 2 本は barrier なしと明記し、同値試験の対象外（Q5 の後に判断） **〔DR-MP4-32 で改訂：表の allowlist は 20 表でなく core が触る 6 表、静的試験は src でなく `electron/shared/readDomain/core/`、`withDetails` の経路は PR-5 の前に決める（PR-4 では core に含めない）〕** |
| PR-5 | B3（search_scenes、search_snippets）＋B4（list_open_foreshadows、get_foreshadow_detail）。`foreshadow/api.ts` の read 部分を read 専用 module に分ける | PR-0 の golden（Native 経路は覆わない）、typed read の spy（PR-0 の `legacyNativePort` が呼び方の基準）、search 整形 5 件、read 専用 module の単体試験。**PR-9 の実 addon 同値 spec が前提** | `normalizeForeshadowRow` が import する metadata 系（write 側）を外せるかは未確認 **〔DR-MP4-34 で改訂：PR-5 は 5a（B3）と 5b（B4）に分ける。metadata 系は PR-3b-2 で移し済みで外す作業は要らない。実 addon の spec の実行は各 PR の merge の条件。DR-MP4-35：5b は案 Y（core が wire を組む。port は `readOpenForeshadowWire`）で実装、read 専用 module の単体試験は `readRows.test.ts`〕** |
| PR-6 | DR-MP4-8 の入力の再構築：`tree_nodes`（`project_id` 一致、`archived_at IS NULL`、6 列）から readingOrder・sceneTimeIndex、`projects` の resolutionMode。他 project／不明の `currentSceneId` は null 扱い | renderer の `buildReadingOrder`／`buildSceneTimeIndex` との parity、他 project の fixture、`localeCompare` の比較。**mode が null・不明値のときの main の既定（fail-closed か base 解決か）を決めて入れ、legacy の前 project の mode の持ち越し（`projectRuntimeComposition.ts:87-89`。phaseStore の初期値は reading、DB の既定は auto）との差を DR に明記する** | K-4・K-5。Rust の `derive_live_scene_projection` は流用しない |
| PR-7 | B6 年表（list_events、get_event_detail、get_character_timeline、get_chronicle_state、search_events の IR 無しの部分）。`chronicle/api` の read 専用 module と型の分離、`chronicleToolCache`／`toolTurnCache` の turn 単位 instance、UI 言語の port | `chronicleReadTools.test.ts` 12 件と chatIr 110 件が無変更で通る〔**注（2026-11-22）**：`toolExecutors.chatIr.test.ts` 単体の vitest の実行件数は 110（it.each の展開後。PR-7a の worktree で実行して確認）。pr7-plan の反証の記録の 113 は、grep の行数（it・it.each の行。toolExecutors.chatIr が 78）に chatIrToolResult 21・toolDefinitions.chatIr 6・chatIrStatusText 8 を足した合計で、数え方が違う（実行件数の 4 file 合計は 145）〕、並行 turn の cache の試験。**PR-9 が前提** | PR-6 の後 **〔DR-MP4-37 で改訂：PR-7 は 7a（list_events・get_event_detail・get_character_timeline・get_chronicle_state）と 7b（search_events の IR 無しの部分）に分ける。7a の seam は案 A（loader port。core は cache を持たず `CoreToolCache` は削除）、ctx と factory は年表用に別、表は 10 → 16、main の tree の入力は 1 本の select の上位集合、main の cache は turn ごとの instance（寿命は Q5 (f)）。実 addon の spec の実行は merge の条件〕** **〔DR-MP4-38：7b は `search_events` の IR なしの部分（旗 false かつ scope なし）を専用の ctx・factory で core へ。dense の握りは legacy の port、main は throw、main の search は events・scene_events を呼出しごとに取り直す〕** |
| PR-8 | B5 Codex hidden（search_codex、list_codex_by_type、search_codex_by_tags、find_related_entries）。`codexHiddenFromAi` の port 化（sceneTimeIndex・resolutionMode を入力で受ける）、`phaseApi`／`detailApi` の read の分離、hybrid 融合。**既存の公開関数のシグネチャと falsy な projectId の挙動は変えない（projectId 必須は core の新 entry だけ）** | `codexHidden` 17 件と hybrid 2 件が無変更で通る。`inlineAiContext.codexHidden.test`・beat・foreshadow・`contextBuilder` の hidden 関連の既存試験。**PR-9 が前提** | PR-6 の後。`get_codex_entry` は legacy に残り、共有 helper の公開 API を保つ。**〔PR-8a の実装。DR-MP4-39〕** 前半（判定の純関数 `decideCodexAiVisibility`、core の入口、`codex_entry_phases` の 1 表〔16 → 17〕、main の組み立て。tool は動かさない）。**〔PR-8b の実装。DR-MP4-40〕** 4 本の core 化（4 つ目の表 `CODEX_READ_TOOL_NAMES`・専用の ctx と factory、fts は port に一本化、dense の握りは renderer の port・main は throw、DR-MP4-41 (b) の epoch の検査を任意の `getProjectEpoch` で core へ運ぶ、表の増分なし）。**PR-6 からの申し送り（記録の 11・12）：削除の undo 後の `storyTimeOrder` 欠落は PR-6 の parity 試験の範囲外で、main の同値試験でも見えない。PR-8 の fixture に「store と DB の `storyTimeOrder` が食い違う」例を入れるか、Q5 の窓として受容を明記する。mode の入力の select は `listNodes` の projection と別なので、条件の手書きの一致は parity 試験だけが守る** |
| **PR-9（必須。任意でない）** | 実 addon での同値 spec（同じ fixture DB を renderer 経路と main の adapter で比べる）。fixture は PR-0 の `legacyReadSeed.ts` を共用する | `d2aOwnDataRead.pipeline.spec.ts` の型。fts／semantic 2 本の workspace 不一致／foreshadow の Native 分岐を含む | 実 addon の build。**main の経路が legacy と同じ結果を返すことを言える唯一の oracle**。typed read を使う PR-5・7・8 の前提 |

- 順序：PR-0 → PR-3 を先に、PR-1・2 は並行、PR-3b → PR-4（PR-9 の最初の版を含む）→ PR-9 → PR-5、PR-6 → PR-7・8（PR-9 が前提）。
  入力（現在の場面・読む順・resolutionMode）が要らない B1〜B4 の 11 本を先に移し、要る B5・B6 は PR-6 の後に置く。束の分け方は領域名でなく入力の要否。
- 試験の置き場：**renderer の module（`@/…` や src の相対 path）を import する試験（drift 試験、PR-4 の静的試験など）は src に置く**（`vitest.config.ts` が拾う。src から `electron/shared` を import する前例がある）。
  `electron/shared` に置く core の単体試験は**相対 import だけ**にする（`vitest.electron.config.ts` に `@` の alias が無く、include は `electron/{main,preload,shared}/**/*.test.ts` だけ。
  `electron/tsconfig.json` の include は main・preload・shared で、試験 file も NodeNext の tsc に入る）。
- IR の切り方：core は「slice の前の候補の段」（visible、readingOrder、sceneEvents、eventById、currentSceneId、limit）を返し、renderer 層が位置 filter と近似を同じ位置（secrecy の後、slice の前）で掛ける。
  `toolExecutors.chatIr.test.ts` の 110 件を無変更で通すことを受入れの条件にする。〔注：110 は同 file 単体の vitest の実行件数（実測、2026-11-22）。pr7-plan の 113 は grep の行数の合算で、数え方が違う。PR-7a の DR-MP4-37n のとおり、chatIr 系は無変更で通った。〕
- 4b-1／4b-2／4b-3 との対応：4b-1＝PR-0・1・3（PR-2 は別）、4b-2＝PR-3b・4・5（PR-9 を挟む）、4b-3＝PR-6〜8。
- 4c-1 へ持ち越す：**tokenizer の実装と K-16（main thread の占有）の spike、K-23（session の tools snapshot が app の版をまたいで残るか）の確認**。4b の範囲からは外す（この改訂が記録。
  P27・P28 の precheck の条件は 4c-1 に移る）。PR-1 には tokenizer の port の型と試験用の数え値までを入れる。

#### 5. PR-0 の golden で固定した legacy の事実（re-point で変えない）

PR-0 の試験を実際に走らせて確かめた。意図しない挙動に見えても**直さず固定**している（直すのは別の変更）。

- `tree_nodes.node_type` の CHECK は `folder`／`scene`／`note` だけ。`list_chapters` の `["part","chapter","scene"]` は scene しか当たらず、`get_chapter_summaries` の `"chapter"` は**現行 DB では常に 0 件**
  （`0 chapters with scene summaries`）。folder は出ない。
- `list_chapters`・`get_scene`・`search_scenes`（LIKE の arm）・`get_scene_timeline_neighbors`・`get_thread_scenes` は `archived_at` で絞らない（archived の場面が出る・読める）。tree store の `nodes`（`listNodes`）は archived を除く。（#999・DR-MP4-36 で、`get_thread_scenes` の links と branches は絞る形に変わった。PR-0 時点の記録として、この行は残す。）
  PR-6 の「archived 除外」は store 側の投影の話で、tool の SQL の挙動ではない。
- `list_codex_tags` の `usageCount` は hidden の Codex の分も数える。`get_foreshadow_detail` は secret の伏線も返す（DR-MP4-24）。
  `search_events` は dense の hit のうち project の年表に無い event id を hidden 判定の対象にせず素通しする（Native が project で絞る前提）。
- 引数検査と no-project の順序は tool ごとに違う。**引数が先**：search_codex・search_events・search_scenes・search_snippets（空の query）、search_codex_by_tags（空の配列）、find_related_entries・get_scene・get_foreshadow_detail（空の id）、
  get_scene_timeline_neighbors（空の sceneId）、get_thread_scenes（空の threadId）。**no-project が先**：get_event_detail・get_character_timeline・get_chronicle_state・list_events と、引数を検査しない list 系。
- store の読取り位置（試験で固定したもの）：`projectId` は 20 本とも呼出しの冒頭で 1 回（最初の invoke で store の project を切り替えても結果は変わらない）。
  `search_events` の現在の場面と読む順（`nodes`）、`search_codex`・`list_codex_by_type` の hidden 判定の場面は await の後。`list_events` の現在の場面は events の読みの後、`scene_events` の読みの前。
  **固定していない（コードの読みだけ）**：`get_event_detail`・`get_character_timeline`・`get_chronicle_state` の場面・読む順の読取り位置（`get_chronicle_state` は `activeSceneId` を最初の await の前に読み、`nodes` は `Promise.all` の後。
  `get_event_detail` は `nodes` を後でもう 1 回読む）、Codex 側の phase store（`sceneTimeIndex`・`resolutionMode`）の読取り位置。PR-7・8 の着手時に足す。
  **〔PR-7a で固定した（DR-MP4-37）〕** 年表 4 本の store の読取り位置（`get_chronicle_state` は sceneId 指定時に `getTreeState` が 2 回、省略時に 3 回、など）は `toolExecutors.chronicleCharacterization.test.ts`（移す前の legacy で通してから移した）と `chronicleTools.test.ts` で固定した。Codex 側（PR-8）は未固定のまま。
- 並びは `ORDER BY` が無い SELECT（`list_codex_by_type`、`find_related_entries`、`search_codex_by_tags`、LIKE の arm、`get_foreshadow_detail` の setup、`get_thread_scenes` の branch、`list_chapters` の同順位）で
  sql.js の行の返り順に依存する（実 addon では異なりうる）。tree の `sort_order` は同順位が起きないよう main project では全 node 別の値にしてある。
- **覆えない範囲**：`get_chapter_summaries` は現行 DB で常に 0 件なので、章→場面の整形と `list_chapters` の part／chapter の枝は golden を通らない（行ありを作るには CHECK を外した fixture か mock 行が要る）。
  Native 経路の結果、本文の barrier（`awaitPendingSceneContentWrite`）、`get_codex_entry` は範囲外。

#### 6. PR-6 の判断（hidden・年表 secret の入力の再構築。技術判断。2026-11-22）

呼び手なしの PR（main はまだ使わない。製品の挙動は不変）。新しい契約・authority・送信先・保存範囲・閾値の変更は伴わない。

1. **置き場：`electron/shared/readDomain/core/`（`readInputs.ts`＝pure、`readInputsReader.ts`＝Drizzle の select 2 本）。** DR-MP4-3a の「`src/` の相対 path を mirror する」の**最初の例外**：core は `src/` に対応する path が無い新 module。
   PR-4 の core（#1011。master）も同じ `core/` に置くので揃う。`irClosure.static.test.ts` の走査は PR-4 が `electron/shared/readDomain` 全体にしており、`core/` はその内側（合流前の枝では `core` を足していた。範囲を広げる向き。`@/`・store・`invoke`・IR の語は 0。import は相対の `.js` と `drizzle-orm` だけ）。
   renderer の `buildSceneTimeIndex`（内部で `buildReadingOrder`）を**変えずに**呼ぶ。行を `TreeNodeData` の形に写し、読まない欄は中立値にする。Rust の `derive_live_scene_projection` は流用しない（K-4）。
2. **6 列：** `id`・`parent_id`・`node_type`・`sort_order`・`story_time_order`・`archived_at`（2 つの関数が実際に読む列と照合した。`project_id` は SQL の条件で、行には持たない）。
   条件は renderer の `listNodes`（`src/features/tree/api.ts`）と同じ `project_id = ? AND archived_at IS NULL`。pure 側も `archivedAt` を渡して二重に除く。`revision` は store の無効化 counter なので 0 固定。
3. **mode：既定値を置かない。既定は fail-closed（hidden）で、実装は PR-8。** 戻り値は `{kind:"resolved", mode}` か `{kind:"unresolved", reason}`（`project-missing`／`mode-null`／`mode-unknown`）。呼び手が `?? "reading"` と書けない形にした。
   「不明な mode は hidden」は DR-MP4-8 と P5 の行が既に決めている。PR-6 は**隠す実装を持たない**（Codex の hidden 判定の本体と legacy の anchor の作り方〔`resolveTemporalAnchor` という名前は存在せず、実体は `codexHiddenFromAi.ts` の `sceneId?.trim()` の分岐。PR-8a で訂正。DR-MP4-39d〕は PR-8 の範囲で、ここでは読んでいない）。
   PR-8 は `unresolved` を明示的に隠す側へ倒し、fixture（mode が null・不明値・project なし）を入れる。**base anchor で解決する案は採っていない**：phase は `contextModeOverride` で entry の公開状態を上書きでき（`phaseResolver.ts` の `applyPhase`）、公開→hidden の phase を持つ entry は base では公開のまま残るので、開示しうる側になる。
   base を採るなら DR-MP4-8 の変更なので、確認が要る。年表は mode を使わない（読む順と現在の場面だけ。場面が読む順に無ければ secret を隠す）。
4. **現在の場面：** wire の値が**その project の live な scene 行で、かつ読む順（`buildReadingOrder` の key）に入っている**ときだけ採り、それ以外は null。境界は読む順の key で決める（年表の `isEventHiddenFromAi` が `readingOrder.has` で判定するのと同じ物差し）。試験した id：
   他 project の場面（`x-s1`）・存在しない・空文字・archived の場面（`n-arch`）・archived の folder・**行は live だが祖先が archived の場面（`n-s5`）**・folder（`n-ch1`）・note（`n-note1`）・project が無い。
   null を Codex がどう読むか（場面が見つからない id と同値か）は K-20 (1) の未確認のまま、**断定しない**。
5. **legacy との差（mode）。** legacy の出所は `projectStore.ts:435`（開く）と `:582`（戻す）の `applyProjectMetadata(p)` → `projectRuntimeComposition.ts:87-89`：`phaseResolutionMode` が falsy なら store の mode を**変えない**（前 project の値、無ければ phaseStore の初期値 `reading`）。truthy なら不明値でもそのまま入れ、`resolveApplicablePhases` は `auto`／`story` 以外を reading 軸として扱う。
   | DB の値 | legacy | main（この PR の入力） |
   |---|---|---|
   | `reading`／`story`／`auto` | project を開いたとき store へ（その後の設定 UI の変更は debounce 後に DB。Q5 (1)） | 同じ値（resolved） |
   | null・空・不明値 | falsy は前 project の mode が残る。不明値は reading 軸 | unresolved（既定は hidden。実装は PR-8） |
   | project の行が無い | project を開けない | unresolved（`project-missing`） |
   到達性：`projects.phase_resolution_mode` は `NOT NULL DEFAULT 'auto' CHECK (… IN ('reading','story','auto'))`（`migrate.rs:530-531`）で、browser-mock の sql.js も NULL と `'weird'` の UPDATE を拒む（試験で固定）。**よって unresolved は schema の drift か外部 writer のときだけ**で、通常は差が出ない。
   phaseStore の初期値 `reading` と DB の既定 `auto` の差は、project を開くと DB の値が store に入るので通常は出ない（project なしでは main は動かない。projectId 必須）。**黙って前 project の mode を引き継ぐことを main は再現できず、再現しない**。
   ユーザー確認が要る挙動の変更ではない理由：fail-closed は DR-MP4-8 が決定済み、legacy は不変、main は未接続。
6. **ずれの向き：両方向**（DR-MP4-8 の本文の「開示側」は片方向の記述だったので、この PR で直した。K-5 の (2)）。この PR は入力を DB から作るだけで、store との差は作らないが、PR-8 以降の main が DB を読む限り同じ窓が残る（Q5）。
   **「追加・削除・`storyTimeOrder` は DB が先なので短い窓」も削除の undo では不正確**（レビュー P2-1）：窓でなく reload まで続く。原因と影響は下の 11。DR-MP4-8 の本文・K-5 (2)(8)・Q5 (b) を直した。
7. **表の allowlist：`projects` を戻した（PR-4〔#1011〕との合流で）。** PR-4 は `MAIN_READ_TABLES` を 6 表に絞り（`projects` を外した）、`core.static.test.ts` が `readDomain/core/` の Drizzle の select が名指す表の集合と `MAIN_READ_TABLES` の**等しさ**を求める。
   この PR の `readInputsReader.ts` は `tree_nodes` と `projects`（`phase_resolution_mode` だけ）を読むので、`tables.ts` に `projects` を足し（7 表）、`tables.test.ts` の `PINNED` へ入れて `NOT_YET` から外した。範囲を広げる向きの変更で、他の表は動かない。
   parity 試験の client は `MAIN_READ_TABLE_SET` で送信前の検査を通すので、`projects` が外れていれば落ちる（負の対照は変わらない）。
8. **試験：** `readInputs.test.ts`（electron。手書きの行、node:sqlite の実 DB で reader の条件と送信前の検査、同順位の兄弟〔小文字 hex の id だけ。大文字と `_` は locale で並びが変わる〕、行の順序への不変、mode の全分岐）と、`readInputs.parity.test.ts`（src。PR-0 の seed と実 sql.js で、renderer の store の `nodes`・`sceneTimeIndex` と、reader の行の集合・6 列・3 つの map〔挿入順まで〕・数を 5 project〔seed の 4＋同順位の `p-tie`〕で照合）。
   `buildReadingOrder` は両側で同じ関数なので、比べる価値は**行の段**にある。条件を壊す変異（`archived_at` の除外を外す、`project_id` を `id` に替える）が parity 試験で落ちることを確かめた。
   **parity 試験の「store 側」の正確な範囲（レビュー P3-3）：** harness（`legacyReadHarness.testSupport.ts` の `setLegacyReadWorld`）が `listNodes` の結果を `TreeNodeData` へ型変換して `buildSceneTimeIndex` に渡すもので、実際の store の経路（`toNodeData`・`applyTreeHydration`・`recomputeSceneOrder`）は通らない。実質「同じ DB を同じ条件で 2 回読む」比較なので、store だけが持つ差（11 の undo）は見えない。`revision` の比較（0 対 0）は外した：harness が作った値で、実 store では `recomputeSceneOrder` が `revision + 1` するので 1 以上になる（main は 0 固定）。
   reader の送る SQL の列は `readInputs.test.ts` で固定した（tree は 6 列の集合、mode は `select "phase_resolution_mode" from "projects" where` で始まり他の列を含まない。余分な列を足す変異で落ちることを確かめた）。
   **覆わない：** Chromium と Electron main の `localeCompare` の一致（K-4。Node の既定 locale だけ）、実 addon（Native）での同値（PR-9）、DB が古いときの store とのずれ（Q5）。comparator は変えていない（K-4 の方針どおり、変えるなら確認）。
9. **reader の形：** 引数は `CoreReadDb`（PR-4 の `createCoreReadDb(client)` が返す Drizzle db。合流の直しで `drizzle(client)` を直に呼ぶ形から寄せた）。select を `await` で配列として受ける（`.get()`・`findFirst`・`$with` は使わない）。2 本は 1 つの snapshot ではない（tree と mode が別の瞬間のものになりうる）。turn の開始時に読んで固定する（DR-MP4-8、Q5 (5)）。
   reader は `CoreReadContext` の tree state から project を取らず、呼び手が `projectId` を引数で渡す（空は `assertCoreProjectId` で送信前に throw）。main は `createCoreReadDb(checkedClient)` を作って渡す。試験の client も `createCoreReadDb` で包む。
10. **合流の直し（PR-4 の後。2026-11-22）：** 枝は master `3c73d089` の上に作り直した（`claude/mastra-mp4b6-reading-order-v2`）。`irClosure.static.test.ts` の競合は、PR-4 側が走査 directory を `electron/shared/readDomain` 全体へ広げていたので**それを採り**（PR-6 の `readDomain/core` はその内側）、「走査対象の file が入っている」の列に `readInputs.ts`・`readInputsReader.ts` を足した（PR-4 の 5 file は残した）。
    直したのは (a) `projects` を `MAIN_READ_TABLES` へ戻した（上の 7）、(b) reader を `CoreReadDb` を受ける形へ寄せた（上の 9）の 2 点。`impact-map` には rule を足していない：PR-6 の新 file は PR-4 の「core の新 file は fallback（全 suite）」のままで、評価範囲は狭めない。
11. **削除の undo で store と DB が食い違う（Opus のレビュー P2-1。legacy 側の既存の不具合。この PR では直さない）。**
    - 経路：`deleteTreeSubtree`（`src/application/tree/deleteTreeSubtree.ts:184-186`）の undo は、メモリの `deletedNodes`（元の `storyTimeOrder` 付き）を `applyNodes`＋`recomputeSceneOrder` で store に戻す。DB へは `treeStore.ts:1544-1560` の `restorePersisted` が `api.createNode` を呼ぶが、その型（`src/features/tree/api.ts:404-419`）に `storyTimeOrder` が無く、Rust の `tree_node_create` の INSERT（`src-tauri/crates/grimodex-db/src/domain_writes.rs:3339-3342`）にも `story_time_order` が無い。行は NULL で作り直される。chronicle の欄（`chronicle_*`）も同じ。
    - 結果：store は `explicitStoryOrder`・`inheritedStoryOrder`・`scheduledSceneCount` を元の値で持つが、DB から作る main の入力は欠落する。**短い窓でなく reload まで続く。** `isAutoStoryReady` は `scheduledSceneCount`・`liveSceneCount` と `resolvedStoryRanks` で決まるので、auto の軸が project 全体で反転しうる（story 軸が ready／not ready のどちらにもずれ、Codex の phase と hidden が両方向に変わる）。年表の secret の位置は読む順だけを使うので、この経路では動かない（確認は PR-7）。
    - 受入れ：**この PR の parity 試験の範囲外**（上の 8。store の経路を通らない）。K-5 (8)・Q5 (b) に載せ、PR-8 へ申し送る。
    - 根の修正：`tree_node_create` の payload に `storyTimeOrder`・chronicle の欄を足すか、undo が欄を別の更新で戻す。前者は **IPC 契約の変更なのでユーザー確認が要る**。legacy の不具合として**別 lane**で扱う（PR-6 では触らない。製品の挙動は不変）。
12. **projection が `listNodes` と別（Opus のレビュー P3-1）。** DR-MP4-8 は「`listNodes` と同じ projection・同じ除外を共有 core から使う」と書くが、実装は 6 列だけの別の select に同じ条件（`project_id = ? AND archived_at IS NULL`）を手で書いた。理由：`listNodes` は renderer の module（`@/db`）で core から import できず、`treeNodeLiteColumns` は 20 列以上を引く。
    差：(a) 列は 6 対 20 超（読まない欄は中立値）、(b) 条件は同じだが**同じ定義を共有していない**（`listNodes` の条件か列が変わっても reader は変わらない）、(c) `ORDER BY` なし（順序は `buildReadingOrder` が決める）。
    ずれを検出する手段は `readInputs.parity.test.ts` だけで、**seed に依存する**（seed に無い形の行や、`listNodes` 側だけの条件の変更は見えない。上の 8 の変異の確認も seed の範囲）。共有の定義にするなら `listNodes` の条件を module に切り出す変更が要り、legacy の import が動くので PR-6 では採らない。

### 4c-1 loop 規則・tool の接続（main 側。journey の seam だけが届く）

- 範囲：rules module（DR-MP4-12〜16）、**begin の前の注入点**（DR-MP4-28。adapter の境界の改訂を PR 本文に記録）、step ごとの payload 確定（DR-MP4-25）、send の直前の policy 判定（DR-MP4-26）、
  tool の接続（schema は DR-MP4-17）、tools・結果・進捗の wire（DR-MP4-20。Q4）、`maxSteps` の上限（導出式。DR-MP4-12）、tokenizer の実装（DR-MP4-18）、
  main の tool の許可集合（M4 の 20 名）と実行時の名前の照合。
  既存の構造の改訂を含む：
  - `MASTRA_AGENT_TOOL_ALLOWLIST`（MP-3 は空。`agentRuntime.ts:32-45`†）を M4 の 20 名へ。`mastraWorkspaceDisabled` の静的試験と対で固定する。
  - sink の `begin` に親の `executionId` を渡す API（現状は `parentExecutionId: null` 固定。`agentAuditSink.ts:299-302`†）。
  - owner の Turn の `handle`・`response` は 1 回分の欄（`mastraTurnOwner.ts:207-232`）。複数 send にし、start の返り値（`{status:'completed', executionId, response}` の 1 回分）の構造を変える。
    sink の terminal は execution ごとに 1 回（written 集合）なので、完了済みの handle への ambiguous は no-op になる（試験項目）。
- 試験：第 6 節（特性試験、begin の前の bytes 一致、schema bytes、drift 試験、長い履歴）。
- **precheck の条件**：P1-1・P2-3 の反映（本改訂で DR-MP4-28・30 に書いた）、**Q4 の回答**、K-1・K-18 の実測（最初の特性試験）、**改訂後の独立レビュー**（第 7 節）。条件つき確認：C-8、C-10、C-16。
- merge 条件：Q4 の回答、特性試験が両 engine で緑、独立レビューで P2 以上が解消、Quick。
- 製品の挙動は不変：旗 L 閉、renderer の分岐は 4c-2 まで入らない（journey の seam だけが届く）。

### 4c-2 engine 分岐・watcher・quiescence 統合（renderer 側）

- 範囲：renderer の engine 分岐（DR-MP4-19）、authority の watcher（DR-MP4-26）、lease の通知での cancel と start 前の lease 確認（DR-MP4-29）、turn 開始前の flush（DR-MP4-8、9。Mastra の分岐に入ってからだけ）、
  pending の start を 1 本に保つこと（DR-MP4-27）、audit export 用の registry の予約・完了（DR-MP4-31）、send ごとの renderer の副作用の受け側（進捗の wire。DR-MP4-25）、失効の観測の弱まりの脅威モデルへの追記（Q5 の回答どおり）。
- **merge の時期**：宣言する tool 集合が main の集合に収まる MP の直前（MP-4 の間は 44 本の宣言が収まらないので製品には届かない。収まる時期は MP-6 以降で、`run_research` の扱い〔DR-MP4-22〕で決まる）。使われない renderer のコードを先に増やさない。
- **precheck の条件**：P1-2・P2-1 の反映（本改訂で DR-MP4-29・31 に書いた）、**Q5 の回答**、**改訂後の独立レビュー**。条件つき確認：C-17（quiescence の不変条件を変えるとき）。
- merge 条件：Q5 の回答、watcher・lease・registry の試験、独立レビューで P2 以上が解消、Quick。

## 6. 受入れの試験

1. **`agentLoop.test.ts` の特性試験を legacy と Mastra の両方に流す**。`runEngine(engine, options)` の 2 実装（legacy は `runAgentLoop`、Mastra は rules module＋fake send＋Agent）を作り、
   `sendToLLM` の履歴と `executeTool` を共通の記録に繋ぐ。現状は `vi.mock` で `contextBuilder` を差し替え、`runAgentLoop` を直接呼ぶ形（describe 7 群・it 25 件。`agentLoop.test.ts`†）で、engine を引数に取らない。Hermes inbound は adapter の route 外なので移さない。
2. **scene の追加**（MP-2 の A〜J に足す）：上限（calls／tokens／questions）、上限後の tool_use、未宣言 tool、バッチ途中の abort、`ask_user` の別枠、大きい error 結果（失敗＋巨大 error 文）、
   バッチで上限を超える呼出し数、窓別の 25／16／12／10。wire の args を JSON の bytes 一致で比べる。追加：
   - 失敗の結果の wire（`isError: true`、`Error: ` の前置、切詰めの後の形）。極小予算（`keepChars` が前置より短い）の端（DR-MP4-13）。
   - abort の 2 通り（loop の先頭＝`finalText` が空、tool の実行後＝直前の応答の text。tokensUsed と record を数えない。DR-MP4-14）。
   - 数え方：`stopReason` が `tool_use` でない応答、上限後の最後の応答の tool_use block を数えない（DR-MP4-12）。
   - step ごとの payload 確定：窓超過の throw、cache から plain への降格（DR-MP4-25。Q4 の回答に従う）。**begin の前**で行い、throw では audit の行が残らない（DR-MP4-28）。
   - **`request.prepared` の messages・`systemCacheSegments` が wire の args と bytes で一致する**（制御 message あり・降格ありの両方。DR-MP4-28）。
   - `maxSteps` の上限が legacy の最大 send 数以上であること（DR-MP4-12）。
3. **read の fixture 比較**：実 addon の同じ fixture DB で、legacy 版 core と main 版 core の結果を比べる。hidden、年表 secret、XPROJ、barrier なし、object の行の写像（boolean・timestamp・json の列）。他 project の `currentSceneId`、archived の node、DB が古い読む順。
4. **schema bytes**：M4 の部分集合で TS 側と Rust の wire parity。`$schema`／`additionalProperties` が wire に残らないこと。無変形の入力検証（DR-MP4-17）。**main の定義と renderer の snapshot の drift 試験**（bytes 一致。並び順を含む。DR-MP4-30）。
5. **長い履歴・大きい結果**：S6 の未測定。切詰めの比率（`chatAgentToolHandlers.test` の B-T7 の一致固定、未再確認）が main 化後の写しでも保たれること。
6. **静的試験**：IR を閉じたまま（DR-MP4-21）。main の tool の許可集合の凍結と、実行時の wire の名前の照合。read core が SELECT だけ（送信前の検査を含む）。
   core が参照してよい表の allowlist。`NAPI_COMMANDS` を動的 key で引かない。restricted の turn が存在しない。main の定義 module が `toolDefinitions.ts` を import しない（DR-MP4-21 の 6）。IPC の timeout 定数が renderer と main で同じ module。
7. **lifecycle**：read の in-flight の計数、forced と quiesce、tokenizer の init 失敗と single-flight、gate-closed の記憶、admit 後の rejection を再送しないこと。
   `profileClosed()` の 3 状態（restricted／unavailable／activating）、cancel と start の lane（pending の start 1 本。DR-MP4-27）、renderer の watcher が cancel を呼ぶこと（DR-MP4-26）、
   lease の取得で cancel が呼ばれ drain が高々 1 send で終わること（DR-MP4-29）、registry の予約・完了が全経路で解除され、export が turn の実行中は断られること（DR-MP4-31）。
8. **並行 turn**：sender あたり 4・全体 8 の turn で、cache と読む順の導出値が turn をまたいで共有されない（DR-MP4-16）。
9. **同値の例外の明記**：切替あり＝固定（DR-MP4-8。Q5）、barrier なし（DR-MP4-9。Q5）、cache の単位（DR-MP4-16）、年表の cache の寿命＝turn（DR-MP4-37i。Q5 (f)）、`search_events` の dense の失敗は main では throw（DR-MP4-38c。C-21）、`search_codex` の dense の失敗は main では throw（DR-MP4-40h。C-23）、main の `activeSceneId` が読む順に無いときの `get_chronicle_state`（DR-MP4-37k）、tokenizer の fail-closed（DR-MP4-18）。期待に書き、同値試験の対象から外す。場面なし null は年表＝secret を隠す、Codex＝base で解決した上で、**Phase が hidden にする項目は hidden に倒す**（DR-MP4-1 の後に DR-MP4-41 が変えた。場面を解決できない〔場面なし・読む順に無い〕ときも同じ）と固定する。
10. 実行は 4b／4c-1／4c-2 の各 PR で、変更範囲に応じて `pnpm test:electron`、`pnpm exec tsc -p electron/tsconfig.json --noEmit`、`pnpm electron:build`、実 addon の pipeline spec、`pnpm verify:quality`（Node 22）を選ぶ。
    この起案と改訂では**何も実行していない**。

## 7. GDX-PRECHECK-001

[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)：編集の前に入力・権限・新しさを確認する。前提が欠けたら推測せず `[precheck]` で止まる。
脅威モデルの重要な変更は、ユーザーの確認まで書かない。事前委任は NIR-1 の残レーンだけで、Mastra の lane には及ばない。

| 項目 | 内容 |
|---|---|
| 区分 | 長期・高リスク。信頼境界の変更（main が新しい呼び手）と非同期 lifecycle（read の in-flight、tokenizer の init、cancel の lane、workspace 切替と turn）を含む。egress の宛先は変わらない |
| 体制 | integrator 1、実装、候補に触れない独立の受入れレビュー。実装と受入れのレビューは分ける |
| 独立レビュー（この設計文書） | 起案への敵対レビュー（4 観点、2026-11-21。担当は workflow の reviewer）の指摘 47 件（重複を含む）を第 10.1 節のとおり反映した。**Opus の独立レビュー（precheck、2026-11-21 午後）**の指摘を第 10.2 節のとおり反映した。**どちらも受入れの判定ではない**（改訂 2 の再レビューは各 PR の前に行う） |
| 独立レビュー（4a） | 未実施 |
| 独立レビュー（4b） | 未実施 |
| 独立レビュー（4c-1） | 未実施（改訂後の独立レビューが 4c-1 の precheck の条件） |
| 独立レビュー（4c-2） | 未実施（同上） |
| 脅威モデルの確認 | U-1（脅威モデルの確認と凍結）は 2026-11-19 に確定（計画書の U 一覧）。2026-11-21 の決定 3 に由来する IR 延期の記載と、**回答 3（2026-11-21 午後）に由来する T13・D16・W11・残るリスク・改訂の記録**を反映済み。**Q5 に関わる追記は未確認のため書いていない**。確認の記録欄：2026-11-21 午後、回答 3（main の DB 直読みを JS の防御で行い脅威モデルに追記） |
| 候補の台帳 | base／head／tree／clean／receipt／確認済みの脅威モデルの版。各 PR の本文に書く |

`[precheck]` で止める点（PR ごと。各 PR の条件は第 5 節にも書いた）：

- **4a**：回答 1 は**済**。PR 本文に DR-MP4-1・2・23 と信頼境界、journey の catalog の digest（`workload-allocation.json`）、`verify:quality`（Node 22）、Quick。**4a は 3 欄をまとめて、回答 1 の後に着手する（回答済み）**。
- **4b**：回答 3（**済**）、P2-2（caller の timeout。設計は DR-MP4-4）、import 閉包の実測（K-10）、K-4・K-5・K-6。（K-10 は 2026-11-21 に実測済みで残りは第 5 節「4b の PR 計画」の 2。K-16・K-23 は 4c-1 へ持ち越した）
  budget・閾値の測定で既存の ceiling を超えるなら実装を止めて確認する（C-8、C-16。条件つき）。read の timeout に既存の定数以外の値を置くなら C-18。
- **4c-1**：P1-1・P2-3 の反映（DR-MP4-28・30）、**Q4 の回答**、改訂後の独立レビュー。Q4 の回答まで、wire の拡張・rules module・`maxSteps` の上限・begin の前の注入点・tokenizer の同梱・main thread の対策に入らない。C-10 は schema の方式を (C) から変えるときだけ。
- **4c-2**：P1-2・P2-1 の反映（DR-MP4-29・31）、**Q5 の回答**、改訂後の独立レビュー。Q5 の回答まで、engine 分岐・watcher・flush・registry・失効の観測の脅威モデルへの追記に入らない。C-17 は quiescence の不変条件を変えるときだけ。
- **旗 L を開ける前（MP-13）**：C-6（`get_codex_entry`）、U-8（help と UI 系の RPC の契約）。確認ではなく確かめる点：C-11 の別 issue（`get_foreshadow_detail` の非対称）の状態、**並べて C-19（年表 4 本が hidden な Codex の名前を返す）・C-20（`get_chronicle_state` が model の `sceneId` で秘匿位置を決める）の状態**（DR-MP4-37j）、**C-21（dense の失敗が main では tool error）・C-22（hit の素通し。既存の fail-open の同値の写し）**（DR-MP4-38h）、**C-23（`search_codex` の dense の失敗が main では tool error）・C-24（hidden の本文への検索の命中が件数に出る既存の oracle）**（DR-MP4-40h）。**さらに、main の `unresolved`（project 行が無い・mode が取れない異常時に、Codex の hidden 判定が全部 hidden になる。legacy には無い状態）の状態**（DR-MP4-39d）。
- 重いコマンド（build、test、Electron）は、実行前に資源の空きと競合する run を確かめる（[CI runner](../local-ci-runner.md)）。

## 8. ユーザー確認が要る点

改訂 2（2026-11-21 午後）で、委任の再分類により多くの確認を技術判断・報告に移し、残る確認を **Q4・Q5** の 2 つにまとめた。条件がそろったときだけ伺うもの（条件つき）は別に挙げる。

### 8.1 確認要（委任の外。残るもの）

| ID | 内容 | 推奨 | 止まる点 |
|---|---|---|---|
| **Q4** | **4c-1 の wire の契約一式**（C-2＋C-3(a)＋C-13＋C-6(1)。回答 2 の「設計がそろってから 1 回にまとめて」）。含むもの：(a) tools の wire の形、(b) 予算（`tokenBudget`・`maxToolCalls`）と制御 message 3 本・UI 言語、(c) step ごとの payload 確定の入力（窓・出力予約・fallback の system）、(d) 結果と進捗の wire（`toolCallRecords`、`stoppedReason`、累計 usage、`citations`、`finalThinkingBlocks`、連結 text、`onProgress`、send ごとの accepted／finalize の通知、Stop 時の途中 text）、(e) C-6(1) を採るなら `fullyInjectedIds`。main が値を検査するときの値域は既存の関数・定数から導き、導けない欄だけ追加で伺う | (a) 名前の list だけ（定義は main が持つ。DR-MP4-30）、(b)(c) renderer が計算した値を渡す（現行の関数を共有。新設・変更しない）、(d) 結果と進捗の wire を新設、(e) 含める（契約を 2 回に保つ） | 4c-1 |
| **Q5** | **legacy より弱い窓の受容**（C-7＋C-15）。ADR 013（hidden と年表 secret は「どの経路でも渡さない」。`docs/adr/013-ai-disclosure-policy.md:9`†）に対して保護が弱くなる窓：(a) 場面切替後は turn 開始の場面で固定（後ろの場面へ切り替えたなら開示は狭い側、前の場面へなら広い側にずれる）、(b) DB が古い窓（`resolutionMode`、tree の並びの未保存の変更。作者の画面より多くを解除する向きにずれうる。**削除の undo の後は `storyTimeOrder` の欠落が reload まで続き、auto の軸が反転しうる**〔K-5 (8)、PR-6 の記録の 11。根の修正は legacy の別 lane〕）、(c) barrier なし、(d) batch の途中の tree の変更を再計算しない、(e) project・chat authority・policy・license の変化から cancel が届くまで（policy の store から DB への永続の窓を含む。K-17）、**(f) 年表の events・scene-events・Codex 名の cache が turn の間（`clear()` まで）変更を見ない窓（DR-MP4-37i。legacy は batch ごとに破棄する。作者が turn の途中で event の `secret`・`reveal_scene_id` を変えたとき、公開 → secret に変えても main では見えたまま。同値試験の対象外、特性試験に期待を明記）**。**〔PR-7b：`search_events` の hit の素通し（events に無い id は hidden の対象外）は、main の search の ctx が呼出しごとに events・scene_events を取り直すので、この窓に入れない。「この窓の一例で新しい弱さではない」とは書かない（反証 P1。不在が fail-open になる種類の窓は、main の search では呼出しごとの取り直しで作らない）。DR-MP4-38e〕**緩和（新しい契約なし）：turn 開始前の flush、watcher による cancel（場面・project・policy・ライセンス）、send の直前の main の policy 判定（技術判断。DR-MP4-26） | 緩和を入れた上で、残る窓を受容し、脅威モデルに回答どおり書く。特性試験に明記 | 4c-2（4b は差を確定せずに進める） |

**条件つき**（条件がそろったときだけ伺う）：

| ID | 条件 | 止まる点 |
|---|---|---|
| C-8 | tokenizer の配り方の測定で、**既存の perf budget・ceiling を超える**とき、または新しい budget を置くとき。`schema.ts` の移動による renderer の起動 graph の ratchet への影響も同じ。**既存の budget は緩めない** | 4b の測定／4c-1 |
| C-10 | tool の入力検証を生の JSON Schema（Ajv の検証を新設）にするとき。推奨は自前の StandardSchema（検証なし） | 4c-1 |
| C-16 | main thread の占有（K-16）の測定の結果、対策（結果の長さの先頭の cap、分割と yield、別 thread）が閾値の新設に当たるとき | 4c-1 |
| C-17 | workspace 切替と turn の扱いで、**quiescence の不変条件を変える**案（DR-MP4-29 の (b) start を drain の対象から外す、(c) start を即返す）を採るとき。推奨 (a) は不要 | 4c-2 |
| C-18 | read の caller の timeout に、**既存の定数以外の値**を置くとき（例：`foreshadow_list_open_for_context` に新しい上限）。既存の定数（10 秒・5 分）の共有だけなら不要 | 4b |
| C-9 | 未宣言 tool で、Mastra の既定（使える tool の一覧を model に返す）を受け入れるとき。推奨は再現（DR-MP4-15）なので通常は不要 | 4c-1 |

**MP-13（旗 L を開ける前）**：

| ID | 内容 |
|---|---|
| C-6 | `get_codex_entry` の guard：wire に `fullyInjectedIds` を足す／guard なしで全文を返す（結果と token が変わる）／main の集合から外す。MP-4 は外す。(1) の欄は Q4 に含めるかを Q4 で伺う |
| U-8 | MP-5 の UI tool（help 2 本を含む 8 本）の main→renderer の RPC の契約（計画書の U-8） |
| C-19 | **【確かめる点。ユーザー確認は要らない。旗 L を開ける前に見直す】** 年表 4 本が **Codex の hidden な entry の名前を返す**既存の挙動（`primaryCharacter`・`location`・`participants[].name`・`character`・`codexNames`）。MP-4 は同値で写す（DR-MP4-37j）。確認は要らないが、旗 L を開ける前に C-11 と並べて、別 issue の状態を確かめる（確かめる点） |
| C-20 | **【確かめる点。ユーザー確認は要らない。旗 L を開ける前に見直す】** `get_chronicle_state` が **model の渡す `sceneId` で秘匿判定の位置を決める**既存の挙動（後ろの場面を指定すると開示済みの secret の出来事が見える）。MP-4 は同値で写す（DR-MP4-37j）。C-19 と同じく、旗 L の前に C-11 と並べて別 issue の状態を確かめる（CSR/1 が `events.secret` をやめるまで直さない） |
| C-21 | **【確かめる点。ユーザー確認は要らない。旗 L を開ける前に見直す】** `search_events` の dense の失敗（model 不在・feature 無効・未 index・workspace 不一致）が、legacy では `0 events found`（空。renderer の port が握る）、**main では tool error になる**（core と main は握らない。握ると cancel・timeout・workspace 不一致が「0 件」の成功に化ける。「model 不在」の型付き kind は新しい契約になるので足さない）。画面で見える差。UI の文言・retry は Q4 の側（DR-MP4-38c・38g） |
| C-22 | **【確かめる点。ユーザー確認は要らない。旗 L を開ける前に見直す】** `search_events` が、hit の id が年表（events）に無いとき hidden の対象外として**素通しする**既存の fail-open の挙動の同値の写し（PR-0 の golden の S1・XPROJ が固定）。安全性は Native が索引を project で絞ることに依存する。main は呼出しごとに events を取り直すので、cache の窓で秘匿の event の title が出る形にはしない（DR-MP4-38e）。CSR/1（`events.secret` の廃止）で消える |
| C-23 | **【確かめる点。ユーザー確認は要らない。旗 L を開ける前に見直す】** `search_codex` の dense の失敗（model 不在・feature 無効・未 index・workspace 不一致）が、legacy では sparse だけで成功（renderer の port が握る）、**main では tool error になる**（core と main は握らない。握ると cancel・timeout・workspace 不一致が「0 件」の成功に化ける。「model 不在」の型付き kind は新しい契約になるので足さない）。画面で見える差。分類して握る案は 4c-1（DR-MP4-40h） |
| C-24 | **【確かめる点。ユーザー確認は要らない。旗 L を開ける前に見直す】** `search_codex` の fts は hidden の本文にも当たり、hidden を cut の後に落とすので、hidden の本文への検索の命中が結果の件数（20 件未満）に出る既存の oracle の同値の写し。PR-8 は直さない（直すなら hidden を SQL に押し込む別 lane。DR-MP4-40h） |

### 8.2 回答済み・技術判断・報告に移した旧確認（改訂 2）

| 旧 ID | 行き先 | 内容・根拠 |
|---|---|---|
| C-1 | **回答 1（解消）** | (a) `currentSceneId` は `string \| null`、空文字は null。(b) 3 欄を start で 1 回束ねて不変。(c) 形式検査は技術判断：Native の判定と同等以上にし、C0・C1（U+0085）・U+2028・U+2029・U+FEFF を値のどこにあっても拒否する（4a の実装。K-19）。DR-MP4-1 |
| C-2 | Q4 | tools・結果と進捗の wire |
| C-3 | (a)(b) Q4、(c) **技術判断** | (c) `maxSteps` の上限は導出式（`maxToolCalls＋maxUserQuestions`）。特性試験で legacy の最大 send 数以上を固定。DR-MP4-12 |
| C-4 | **決定 2・回答 3（解消）**、no-op の中身は**技術判断** | 「新しい authority か」は決定 2 に含まれ、脅威モデルの文面は回答 3 で反映済み。no-op は固定の文字列定数で model に届かない（DR-MP4-14） |
| C-5 | **報告のみ** | 決定 2 の帰結：MP-4 の間、製品の agent-mode turn は Mastra に届かない（journey の seam だけ）。親への報告で足りる |
| C-6 | MP-13 の前（(1) の欄は Q4 で） | 上の表 |
| C-7 | Q5 | 場面固定・DB の古さ・barrier・batch の再計算 |
| C-8 | (a)(c) **技術判断**、(b) 条件つき | wasm と ranks は renderer が既に同梱（`contextBuilder.ts:509-513`†）。exact を保ち、init 失敗は legacy へ（fail-closed）。budget は新設しない。既存の budget を超えるときだけ伺う（DR-MP4-18） |
| C-9 | **技術判断**（条件つき） | 同値の既定＝再現する。差を受け入れるときだけ確認（DR-MP4-15） |
| C-10 | 条件つき | 上の表 |
| C-11 | **別 issue**（親が起票） | `get_foreshadow_detail` が secret を落とさない既存の非対称。MP-4 は同値で写す（DR-MP4-24）。確認は要らないが、旗 L を開ける前に issue の状態を確かめる（MP-13 の「確かめる点」） |
| C-12 | **技術判断** | help 2 本は MP-5 の RPC に寄せる（DR-MP4-11）。計画書は反映済み |
| C-13 | Q4 | step ごとの payload 確定の入力（DR-MP4-25）。置き場は begin の前（DR-MP4-28） |
| C-14 | **技術判断** | pending の start を 1 本に保つ。export は registry で断る（DR-MP4-27、31） |
| C-15 | (a) **技術判断**、残る窓の受容は Q5 | send の直前に main が DB から policy を読んで中断するのは防御の追加（DR-MP4-26） |
| C-16 | 条件つき | 上の表 |

### 8.3 未確認の事実

| ID | 内容 |
|---|---|
| K-1 | begin の前の注入点（DR-MP4-28 の案 A）で messages の末尾に user message を足したとき、`request.prepared` と wire の bytes が一致すること。案 B（`prepareStep`）で messageList に足した場合の順序と `createdAt` による並べ替え、`prepareStep` から `systemCacheSegments`（providerOptions）を変えられるか |
| K-2 | `maxSteps` の上限（導出式 `maxToolCalls＋maxUserQuestions`）が、Mastra の step の数え方（最後の応答の step を含むか）で legacy の最大 send 数を覆うか。（`stopReason` が `tool_use` でなく tool_use block がある応答は、adapter が tool-call を出さないので問題にならない。`agentLanguageModel.ts:670-672` の読解） |
| K-3 | Mastra の tool 実行が `abortSignal` をバッチの途中でどう見るか。legacy の場面切替が authority の検査で次の tool 前に必ず abort されるか（scene scope の persisted session では `activeSceneId` の変化だけでは abort せず、場面切替が `activeSessionId` の変化を伴うかが未確認）。abort 後の `finalText` と `onTextChunk` |
| K-4 | tree store の nodes と DB の `tree_nodes` の完全一致、`buildReadingOrder` の `localeCompare` の Chromium と Node の差、`sceneTimeIndex` の DB からの再構築（2026-11-21 に実測したが、残る未確認がある。要約と残りは第 5 節「4b の PR 計画」の 2） |
| K-5 | `projectMetadataWriteQueue` の debounce の長さ。`resolutionMode` と tree の並びの store から DB までの窓。chat store と tree store の `activeSceneId` と `projectId` の常時一致（起動直後と project 切替）（2026-11-21 に実測したが、残る未確認がある。要約と残りは第 5 節「4b の PR 計画」の 2） |
| K-6 | 実 addon で main から `dbExecute` に identity を渡したときの挙動（napi が非 enumerable の値を落とすか。MP-3 の K と同種）。全 select（boolean・timestamp・json の列）での renderer 経路との一致。（Drizzle の method `get` の期待形は、`sqlite-proxy/session.js` の読解で「1 行の平らな配列」と確定した。DR-MP4-4）（2026-11-21 に実測したが、残る未確認がある。要約と残りは第 5 節「4b の PR 計画」の 2） |
| K-7 | tokenizer：Electron main での動作・init 時間・event loop の塞がり、asar 内の読込、esbuild への binary の埋込みと main.cjs の parse コスト、`encode()` の特殊 token での挙動、main が renderer の同梱 asset（hash 付きの名前）を読めるか |
| K-8 | sink の `operationId` を turn UUID に揃えたときの影響（usage 台帳の鍵）。（legacy の `chatMessageId` が turn 内で一定かは、`assistantMsg` が turn に 1 つで `:1188`†・`:1277`† が同じ `assistantMsg.id` を使うので**一定と確認した**） |
| K-9 | hermes の turn を adapter が扱えるか。添付つき turn が他の入口で agent 経路に流れないか。public web search 経路の privacy 分離 |
| K-10 | `schema.ts` の import 閉包（静的に数えた一覧は DR-MP4-3）、electron の tsconfig（NodeNext、lib は ES2023）で compile できるか、bundle と起動への影響。（参照する script・test は確認した：`validate-narrative-writers.mjs:216-228`†、`impact-map.yaml:771`†、`quality-manifest.yaml:1608,1657`†）（2026-11-21 に実測したが、残る未確認がある。要約と残りは第 5 節「4b の PR 計画」の 2） |
| K-11 | Mastra の入力検証が実際の 44 本（`ask_user` の入れ子、配列 9・enum 8・minimum 1）で無変形か。ai の `jsonSchema()` が無検証になる機構 |
| K-12 | `product-journey-catalog`／`workload-allocation` の registryDigest が wire と journey script の変更で動くか |
| K-13 | `run_research` を将来 main に移すときの子 loop の置き場（audit の parent の連鎖、usage、進捗） |
| K-14 | 同一 step の複数 tool call を Mastra が並列に実行するか（legacy は直列。`toolCallConcurrency: 1` は固定済み） |
| K-15 | MP-3 の台帳の分類（`get_global_settings`、`get_license_state` の class）。（ADR 013 の原文は `docs/adr/013-ai-disclosure-policy.md:9`† で確認した：hidden と年表 secret は「どの経路でも渡さない」） |
| K-16 | main thread の占有：大きい project での読む順の構築、大きい結果の整形・`JSON.stringify`・`countTokens` が Electron main の event loop を塞ぐ時間。model の入力が決める量（巨大な `limit`、配列）を含む。SQL 側の資源上限（`RENDERER_VDBE_OP_LIMIT` 系）は JS の処理を覆わない |
| K-17 | AI policy の chat トグルの store から DB（`projects.ai_policy`）への永続の窓。legacy は `useProjectStore`（`policyGuard.ts:28-35`†）を見る。main が DB を読む防御（DR-MP4-26）は、この窓の分だけ renderer の判定より遅れる（Q5） |
| K-18 | Mastra が tool の throw を error-text にするときの `value` の形（message のまま渡るか）。MP-3 の start が send ごとの renderer 側の副作用（`retirePriorCapture`、`notifyAccepted`、`agent-running` への遷移、context usage の更新、入力 token の drift の集計）をどう扱っているか（4c-1 の最初の実測） |
| K-19 | 形式検査：JS の `trim` と Rust の `trim` の空白集合の差。**JS 側は `node -e` で確かめた**（U+0085 は `trim` されず、U+FEFF は `trim` される。U+2028・U+00A0 は `trim` される）。Rust 側（`char::is_whitespace` ＝ White_Space。U+0085 を含み U+FEFF を含まない）は言語の仕様による記述で、**実 addon での実測は未実施**（4a の試験で固定する）。ずれた値が admit の後に audit の begin で失敗するか（DR-MP4-1 の形式検査で admit の前に落とす） |
| K-20 | (1) project に無い場面 id を `currentSceneId` に渡したときの Codex 側の解決（年表は secret を隠す。DR-MP4-1、8）。**〔Codex 側は PR-8a で解消：場面なしと同じく base で解決し、legacy と同値。`resolveTemporalAnchor` という名前は存在しない。DR-MP4-39d〕**(2) legacy の chat turn が renderer で同時に 1 本か（pending の Mastra start を 1 本に保てるか。DR-MP4-27） |
| K-21 | `sendAgentMessage` 以外の入口（Codex app-server、CLI）の audit begin と finalize の順序が legacy と同じか（DR-MP4-25 の「窓超過の throw では行が残らない」は chat agent の経路だけ確認した） |
| K-22 | lease の通知（`notifyLeaseStateChanged`。`quiescenceLease.ts:312-315`）が lease の取得と同期に listener を呼ぶか。lease 中に `invoke` の経路で他のゲートが cancel（mutation）を拒否しないか（`ipcQueue.ts:193-195` の barrier は audit-export の lease だけと読んだ）。project 読込・close の lease での cancel の到達 |
| K-23 | session の tools snapshot（`sessionAgentToolsSnapshot`）が app の版をまたいで残るか。残る場合、main の現行の定義との差（DR-MP4-30） |
| K-24 | cancel（mutation）が slot を得るまでの待ち：start が 1 slot を握り、read／derived が 3 slot を握っている間（`ipcQueue.ts:143-150`）。lease の取得は derived の caller を切り離す（`cancelDerivedIpcCallersForLifecycle`）が、native の slot は settle まで残る（`:98-103`）。legacy の loop の abort は slot を要らないので、legacy より遅れうる（DR-MP4-27、29）。最悪の待ちと頻度は未測定 |
| K-25 | `doGenerate` と `doStream` の両方で、`restoreTools` → `buildAuditRequest` → `audit.begin` → `buildWireArgs` → `audit.dispatched` → `send` の順序が同じか（DR-MP4-28 は `:835-905` の 1 か所だけ確認した） |

## 9. 計画書と脅威モデルで直す記載

起案時に `grep -n` で行を確かめた。2026-11-21 の改訂で、**決定 1〜3 に由来する記載**を計画書と脅威モデルに反映した（「反映済み」）。改訂 2（同日午後）で、**回答 3 に由来する脅威モデルの記載（T13・D16・W11・残るリスク・改訂の記録）**と、
C-5・C-12 を技術判断・報告に移したことに伴う計画書の記載を反映し、IR の文言を「IR を開ける lane まで閉（MP-4 を含む）」に揃えた。
行番号は改訂 2 の反映後の `mastra-migration-plan.md`（885 行。改訂 2 の編集は行数を変えない）と `mastra-migration-threat-model.md`（508 行。冒頭に 1 行、T13・D16・W11・残るリスクの行を足した）による。
未回答の確認（Q5 など）に由来する記載は反映していない（「後続」）。

### 9.1 `docs/plans/mastra-migration-plan.md`

| 行 | 現状 | 直す内容 | 状態 |
|---|---|---|---|
| 74 | 「S6 の bytes 比較は spike 基点。MP-2・MP-4 でやり直す」 | MP-4 の再測定が M4 の部分集合であること | 後続（4c-1） |
| 352 | 「chat IR S1 は全 launch で閉。loop が main に移ると受け手が変わる。U-4 で再確認する」 | U-4(f) は IR を開ける lane へ延期。MP-4 でも閉。静的試験で固定 | 反映済み |
| 357-363 | 範囲：manifest の 44 本を Mastra の tool に | **段階に読み替え**：MP-4 は read の M4（20 本。`get_codex_entry` は MP-13 の前に C-6）。MP-5 は `ask_user`・`get_ui_state`・help 2 本・UI 系 4 本の 8 本、MP-6 は残りの write 14 本、`run_research` は移さない。内訳の合計は 44。製品の turn は MP-4 の間 Mastra に届かない。help 2 本は技術判断（C-12 から移した）、帰結は報告のみ（C-5）。計画書の 362・363 に反映済み | 反映済み |
| 367 | 範囲に「`beginAgentToolTurn` の turn 単位の分離」 | DR-MP4-16 の根拠。turn ごとの instance にし、`chronicleToolCache` の singleton と reset の登録表も対象 | 後続（4c-1） |
| 370 | `run_research` の子は `run_research` を持たない、audit は `agent_research_subagent`（U-4(e)） | MP-4 では移さない旨を反映済み。MP-13 までに扱いを決める | 反映済み |
| 374-376 | 「移す方式は未決（U-7）」「`countTokens` が main で動くかは未確認」 | U-7 は (D) 混合で決定。tokenizer は未確認のまま、置き場と配布は DR-MP4-18（技術判断。既存の budget を超えるときだけ C-8）を指す | 反映済み |
| 377 | 「N-API は、read 用の command が要るなら新設」 | 新設しない | 反映済み |
| 378-383 | 条件（特性試験、schema の bytes、入力検証、fixture 比較、長い履歴） | 入力検証の基準を「無検証・無変形」に（DR-MP4-17）。engine を引数にした特性試験（第 6 節）。step ごとの payload 確定（DR-MP4-25）を条件に | 後続（4c-1） |
| 385 | 「確認：U-7」 | U-7 は決定済み。残る確認は第 8.1 節の Q4・Q5（と条件つき）。計画書の 385 に反映済み | 反映済み |
| 163、391、406、645 | MP-5 の UI tool は 6 本（第 3.1 節の表、範囲、write 系 15 本との重なり、U-8） | help 2 本を足して **8 本**（C-12 は技術判断に移した）。163・391・392・406・644・645 に反映済み（改訂 2） | 反映済み |
| 587-588 | U 一覧：U-4（loop 移動の未決一式）、U-7（read tool の main 化の方式） | U-7 は決定済み | 反映済み |
| 637 | 「推奨：main chat だけを先に（Q2）。ただし子 agent の扱いは MP-4 で決める」（(e) の末尾） | 子 agent は MP-4 では移さず、MP-13 までに決める（DR-MP4-22）に読み替え | 後続（4c-1） |
| 638 | 「(f) chat IR S1 の確認済み脅威モデルの再確認」 | 延期（IR を開ける lane） | 反映済み |
| 644 | 「U-7：新しい N-API の read command が要るか。tokenizer の置き場」 | 決定：不要。tokenizer の置き場は DR-MP4-18（測定の後に確定。既存の budget を超えるときだけ C-8） | 反映済み |
| 759 | R-18（tool schema の変形後の入力検証、null・truncation）未測定 | 「legacy は無検証。(C) 方式で無変形。probe 済み（合成 schema のみ）。実 44 本は 4c-1」に更新 | 後続（4c-1） |
| 760 | R-19（loop 規則の同値）未測定 | 写し方（案）と特性試験の追加を記す。Mastra の挙動は 4c-1 の最初の実測で確定 | 後続（4c-1） |
| 766 | R-25（chat IR の脅威モデルが renderer の loop 前提） | 延期（IR を開ける lane）。MP-4 は静的試験で閉を固定 | 反映済み |
| 772 | R-31（tokenizer が main で動くか）未確認 | plain Node の probe で動作（約 163 ms）。Electron main・asar・配布は未確認 | 反映済み（注記のみ。状態は未確認のまま） |

### 9.2 `docs/plans/mastra-migration-threat-model.md`

| 行 | 現状 | 直す内容 | 状態 |
|---|---|---|---|
| 269 | T11：loop が main に移ることで capability と chat IR S1 の脅威モデルの前提が落ちる（MP-3〜MP-6） | IR は「IR を開ける lane まで閉（MP-4 を含む）」。capability は MP-6 のまま | 反映済み（IR の部分だけ） |
| 296 | D13：capability の維持。chat IR S1 の確認済み脅威モデルの再確認（U-4(f)） | (f) を「IR を開ける lane まで閉。MP-4 は静的試験で閉を固定」に | 反映済み |
| 500-501 | 第 6 節 7：新しい `PrePublicationEntry` が新しい authority か。chat IR S1 の再確認（U-4(f)） | (f) を「IR を開ける lane まで閉（MP-4 を含む）」に | 反映済み |
| 271（T13）、299（D16）、438〜（W11）、477（残るリスク） | - | **main の読みの呼び手**（`dbExecute` と typed read を main が直接呼ぶ。JS gate を通らない、Native が最終 authority、unrestricted に Native 側の read-only の強制と pin が無い）。T4 に混ぜず新しい行。防御：送信前の SELECT 検査、marker の事後検出、表の allowlist と IR 非参照の静的試験、read の前後の `assertLive`、caller の timeout（既存の定数）、W11（in-flight の計数。read の `settle` は slot の計数だけで永続化の終了証跡ではない）。残るリスク：unrestricted では Native に read-only の強制が無い | **反映済み**（2026-11-21 午後。回答 3。冒頭に改訂の記録） |
| 新しい行（案） | - | **失効の観測**：main は project・chat authority・AI policy・ライセンスの変化を観測できず、legacy の `shouldAbortTurn` より弱い。守り方と残る窓は Q5 の回答どおり | 後続（4c-2、Q5 の回答の後） |
| 262（T4） | 場面の phase の先の情報の漏れ（memory の phase 先の漏れ。X1・X5・X7） | **read tool の入力は T4 に混ぜない**。hidden・年表 secret の入力（DR-MP4-8）は上の新しい行で扱う | 後続（4b） |
| 267（T9） | tool 結果に混ざる指示文 | MP-4 でも tool 結果は model への入力。wire の経路は legacy と同じ。変更なし（確認のみ） | 後続（4b） |

脅威モデルの ID は、この lane の T1〜T13 と、NIR-1 の S1-B の脅威モデルの T1〜（別の文書）が衝突する。
この文書では「S1-B の T2、T3」と書いたものは NIR-1 側を指し、この lane の T3（restricted・非 agent chat での memory の読み書き）とは別。

### 9.3 `docs/plans/mastra-mp3-decisions.md` への申し送り（この起案の一覧の外。編集は各 PR）

| 行 | 現状 | 直す内容 | PR |
|---|---|---|---|
| 136 | DR-MP3-23：parent は null（tool 0） | 複数 step では前 step の `executionId` を連鎖（4c-1。sink の API と owner の Turn の複数 send 化を含む）。`operationId` の扱い（K-8） | 4c-1 |
| 260-264 | DR-MP3-24：「送るだけ差し替え」「tools 非空は unsupported」 | MP-4 では `runAgentLoop` 全体（step ごとの payload 確定を含む。DR-MP4-25）。tools 非空は実装が invalid なので揃える | 4a |
| 322 | DR-MP3-27：「確認要（MP-4 の前）：wire の projectId」 | **決定済み**（2026-11-21、決定 1）に更新。書き先は project の chain | 4a |
| 340-348 | DR-MP3-28：runtime に入れるのは Agent・adapter・方針だけ | closure は main 側。**adapter に begin の前の注入点を足す境界の改訂（DR-MP4-28）**。tokenizer の置き先を改訂するなら記録（DR-MP4-18） | 4c-1 |
| `agentRuntime.ts:32-45` | `MASTRA_AGENT_TOOL_ALLOWLIST`（空）。DR-MP3-14 の 2 層目 | M4 の 20 名へ（意図した改訂。静的試験と対） | 4c-1 |
| `src/lib/mastraAgentTurn.ts:12-17` | start は turn の間 settle せず、cancel と同じ lane（4 本ずつ）。「MP-4 は pending start を 4 未満に保つか cancel に lane を与える」 | DR-MP4-27（pending の start を 1 本に保つ。技術判断）で回収。registry 未登録の欠落は DR-MP4-31 | 4c-2 |

## 10. レビューの記録

### 10.1 起案への敵対レビュー（改訂 1 に反映）

（この表の `C-n` と「4c」は改訂 1 の時点の呼び方。改訂 2 で行き先が変わったものは第 8.2 節、4c は 4c-1・4c-2 に分けた〔第 5 節〕。）

2026-11-21、起案への敵対レビュー 4 観点（境界と脅威、legacy 同値、委任と契約、事実と実現性）の指摘 47 件（重複を含む）。
指摘をコードで確かめ（†）、重複は 1 行にまとめた。**誤りとして退けた指摘は無い**。一部だけ採った指摘は理由を表に書き、確認に回したものは末尾に挙げる。
「†」は改訂時にこの worktree で開いて確かめた行。無印は指摘の evidence をそのまま写したもので未再確認。

| 指摘（要旨。観点の略号は 境＝境界と脅威、同＝legacy 同値、委＝委任と契約、事＝事実と実現性） | 採否 | 反映先・理由 |
|---|---|---|
| 境・同・委：失効の観測の列挙が project だけ。policy chat トグルとライセンスが抜ける（`shouldAbortTurn`†）。renderer の watcher の責務が無い | 採用 | DR-MP4-26（全条件の表）、C-15、第 2 節、第 5 節 4b、第 9.2 節。policy の永続の窓は K-17 |
| 同：send ごとの `finalizeChatTurnPayload`（窓超過の throw、cache の降格。`finalizeTurnPayload.ts:334,373`†）と renderer の副作用が欠ける | 採用 | DR-MP4-25、C-13、K-18。Ollama の窓不足の throw は指摘のみで未再確認 |
| 同：失敗の結果が wire で `isError: false` になる（adapter は text を isError:false、error-text だけ true。`agentLanguageModel.ts:262-291,354-372`†）。未宣言 tool の文言 | 採用 | DR-MP4-13（失敗は throw して error-text に乗せる）、DR-MP4-15。value の形は K-18 |
| 同：abort が tool の実行後にも立つ（`agentLoop.ts:316-323`†。tokensUsed と record を数えない）。`finalText` が 2 通り | 採用 | DR-MP4-14、第 6 節 2 |
| 同：結果の組立（`finalText`、連結 text、`finalThinkingBlocks`、record の summary、未宣言の record、Stop 時の途中 text） | 採用 | DR-MP4-12 の組立表、C-2(b) |
| 同：cancel が start と同じ lane（`mastraAgentTurn.ts:12-17`†）で、audit export 中は拒否 | 採用 | DR-MP4-27、C-14 |
| 同：読む順は nodes の参照で再計算（live。`chronicleToolCache.ts:36-69`†）、DB 再構築は `archivedAt IS NULL`（`tree/api.ts:240`†） | 採用 | DR-MP4-8、C-7(d) |
| 同：回数の数え方（stopReason が tool_use でない応答、上限後の応答の tool_use を数えない。`agentLoop.ts:228-249,272-277`） | 採用 | DR-MP4-12。K-2 の後半は adapter が tool-call を出さないので外した |
| 同：scene scope の persisted session で legacy は切替後を live に読む（`chatTurnStoreActions.ts:430-433`†） | 採用 | DR-MP4-8、K-3 |
| 境・委・事：`maxSteps` の上限（+2 程度）が新設の閾値で、確認要にも停止点にも無い | 採用 | 導出式（`maxToolCalls＋maxUserQuestions`。`agentLoop.ts` の 1 send 1 step、各 batch が少なくとも 1 件を数える読み）に置換。C-3(c)、4c の停止点、K-2。「+2」は根拠が無いので削除 |
| 境：unrestricted に read-only の実行前の阻止が無い（`lib.rs:10711-10740`†）。事後検出だけでは commit 後 | 一部採用 | DR-MP4-4：送信前の検査を足す。ただし「SELECT／WITH で始まる」は `WITH … DELETE` を許すので採らず、先頭が SELECT のみ。閉包側の `with(`・`$with`・`.get()`・`.run()`・`findFirst` は 7 file の grep で見つからない†（閉包全体は未確認）。検査は一層にすぎず marker の事後検出と併用 |
| 境・事：`NAPI_COMMANDS[cmd].run` を cmd で引くと IR の gate（router。`ipc.ts:2245`†）を迂回できる。`chat_agent_ir_select` の run に gate が無い（`ipcContract.ts:9994-10003`†）。fts の scope は任意の文字列（`:9818-9827`†）。`run` は deps を取る | 採用 | DR-MP4-6（4 本の literal key の wrapper、scope は literal union）、DR-MP4-21（静的試験） |
| 境：ネタバレ防止の入力の範囲と新しさ（project で絞らない、DB が古い、`resolveCodexForAi` の projectId が falsy で条件が消える。`codexHiddenFromAi.ts:84-92`†） | 採用 | DR-MP4-8（`project_id` で絞る、project の外の場面は hidden 側、core の projectId は必須）、C-7(b) |
| 境：main thread の占有（JS 側の処理に上限が無い）。「閾値を新設しない」との整合 | 採用 | 第 3.3 節 P27、DR-MP4-18、C-16、K-16。対策が閾値の新設なら確認 |
| 境・委：4a が確定済みの脅威モデルへ未確認の判断を書く | 採用 | 第 5 節（4a は決定 2・3 由来の記載だけ。C-4・C-15 由来は 4b）、第 9.2 節 |
| 境：core の抽出元に `CHAT_AGENT_IR_ENABLED` の分岐が残る（`toolExecutors.ts:55,447,527,668`†） | 採用 | DR-MP4-3（IR 無しの形だけを置く）、DR-MP4-21 の試験 |
| 境：closed 表の denylist では他の表の混入を捕まえない | 採用 | DR-MP4-21 の試験 4（allowlist） |
| 境・委・事：形式検査（trim の差、制御文字、200 字は決定 1 の文言に無い。`mastraAgentTurnWire.ts:338-345`†、`ai_audit.rs:767-777`†） | 一部採用 | 制御文字の拒否は新しい拒否条件なので C-1(c) に載せた。「整合」を「同等以上」に直し、chain が任意の id で作られうる点を明記（決定 1 の範囲）。JS と Rust の trim の差は未実測（K-19） |
| 境：tools を定義ごと運ぶと renderer の説明文が model に届く。実行時の照合の規則が無い | 採用 | DR-MP4-20、C-2(a)、第 6 節 6 |
| 境：`chronicleToolCache` の module singleton（`chronicleToolCache.ts:19-63`†）と reset の登録表 | 採用 | DR-MP4-16、第 6 節 8 |
| 境・委：「T3」が S1-B の T3 と取れる。T4 への混入。read の settle と D11 | 採用 | 第 2 節、第 9.2 節の注、DR-MP4-5 |
| 境：`get_foreshadow_detail` の非対称を停止点なしで 4b に入れる | 採用 | C-11（旗 L を開ける前の条件）、DR-MP4-24、4b の PR 本文 |
| 同・委：ADR 013 の「どの経路でも渡さない」に対して場面切替後と DB 未反映の窓で保護が弱くなる。C-7 の表現 | 採用 | 第 2 節、DR-MP4-8、C-7（弱まりと明記。代案に watcher の cancel） |
| 委：budget・ceiling を超えたときに緩めない旨が無い | 採用 | DR-MP4-18、C-8、第 7 節 |
| 委：lifecycle note が散文で、P3・P4・P7・P8・P10・P11・P14 の matrix の項目が欠ける。P9・P10 は unknown | 一部採用 | 第 3.3 節を項目別の note に書き換えた。read の待ちの有界の値は実在する値（gate・quit の待ち）に乗るかが未確認なので「乗らない部分は新しい閾値＝C-16」とした。P9・P10 は 4c の最初の特性試験の完了を前提と明記。tokenizer の init を「pending-start として owner に所有させる」案は採らず、`admissionRefusal` の再実行にした（init の promise は process で 1 本で turn の所有物ではなく、init 中の start は未登録なので slot・quiesce の待ちを増やさずに済む。owner に所有させると、登録の原子性〔`:637-642`†〕と quit・切替の待ちの計数の両方を作り直す） |
| 委：「到達できるモードは unrestricted だけ」は `unavailable`・`activating` を無視。`profileClosed()` は 3 状態（`mastraTurnOwner.ts:277-280`†） | 採用 | 第 2 節、DR-MP4-4・5、C-4 |
| 委：4a 脅威モデルの編集と、計画書の読み替えの前倒し。draft の印 | 採用 | 第 5 節、第 9 節（計画書の読み替えは今回反映。脅威モデルは確認済みの事実だけ。draft の印は第 8 節だけに置く） |
| 委：影響マトリクスの網羅性（provider 別、null・空、turn 中の設定変更、audit chain の旧行、unknown 行と PR の対応） | 採用 | 第 3.2 節の P20〜P27 と、unknown 行の対応表 |
| 委：C-5 は決定 2 の帰結で、新しい承認要求ではない | 一部採用 | C-5 を「帰結の確認」に絞り、停止は帰結が決定の含みと違う場合だけにした。ただし「tool を使わない turn は Mastra に届く」読みは宣言集合では判定できないことを残した |
| 委：K-8（`chatMessageId` の一定性）と K-15（ADR 013 の原文）は静的に解消できる | 採用 | K-8（`chatTurnStoreActions.ts:1188,1277`†）、K-15（`013-ai-disclosure-policy.md:9`†）を解消済みに |
| 委：flush を Mastra の分岐だけに置く（legacy の呼出し順を変えない） | 採用 | DR-MP4-8・9、第 3.1 節 |
| 事：`schema.ts` を移すと `validate-narrative-writers.mjs`（`:216-228`†）が空の検出になり、`impact-map.yaml:771`†・`quality-manifest.yaml:1608,1657`† の path が外れる | 採用 | DR-MP4-3（移す場合の更新と負の試験。移さない案を比較に足した）、K-10 |
| 事：core の閉包が過小（read 側だけで多数の module。`electron/tsconfig.json` は NodeNext・lib は ES2023）。`phaseApi`・`detailApi` は `src/features/codex/` | 一部採用 | DR-MP4-3 に静的な一覧を足したが、閉包の数は指摘の値（33 種）をそのまま写したもので未再確認。4b の最初に実測 |
| 事：tokenizer の init を admission の前に置くと登録の原子性が壊れる（`mastraTurnOwner.ts:637-642`†、`:551-583`†） | 採用 | 第 3.3 節 P7（同期の refusal → await → `admissionRefusal` の再実行 → 登録） |
| 事：遅延 import でも単一の `main.cjs` に wasm と ranks が入る（`build.mjs:28-36,55-72`†）。`?url` は Vite 専用 | 採用 | DR-MP4-18（3 案を比較。bundle の外に置いて実行時に読む案を足す） |
| 事：4c の範囲が `MASTRA_AGENT_TOOL_ALLOWLIST`（`agentRuntime.ts:32-45`†）、sink の parent（`agentAuditSink.ts:299-302`†）、owner の Turn の複数 send 化を落としている | 採用 | 第 5 節 4c、第 9.3 節 |
| 事：Drizzle の `get` は 1 行の配列を期待する（`sqlite-proxy/session.js:133-161`†）。renderer の写しは全 method で `rows.map(Object.values)`（`src/db/client.ts`†） | 採用 | DR-MP4-4（許可 method は `all`・`values`）、K-6 |
| 事：legacy の tool は projectId を tree store から live に読む。`currentSceneId` の出所（preflight の `effectiveSceneId` は scope で null になる。`chatTurnPreflight.ts:372-374`†） | 採用 | DR-MP4-1・8、C-1(a)、K-5 |
| 事：行番号・件数のずれ（`isTrimmedId` は `:338-345`†、Native は `electron/native/grimodex-node/src/lib.rs`、`client.ts` は 19 行†、`agentLoop.test.ts` は describe 7・it 25†、計画書の行、Rust の試験 fixture、根拠の無い bundle の大きさ） | 採用 | 各所を現物に直した。bundle の大きさは「未測定」に（DR-MP4-18）。第 3.1 節の Rust の行は「試験 fixture のみ」 |
| 同：maxSteps／cache／flush の補足（P3 の 3 点） | 採用 | DR-MP4-12・16・8（上の各行に統合） |

保留（確認のため）：(1) policy を main が DB から読む案（C-15(a)）は、新しい authority かつ永続の窓があるので、採否をユーザーに出した（C-15、K-17）。
(2) 「step ごとの payload 確定」の再現（C-13）は新しい契約と閾値の扱いを含むので、技術判断では決めずに確認へ出した。

### 10.2 Opus の独立レビュー（precheck、2026-11-21 午後。改訂 2 に反映）

ユーザーの回答 1〜3（第 1.3 節）と合わせて反映した。指摘のコードは改訂 2 の時にこの worktree で開いて確かめた（†）。**実コードで指摘と違った点・追加で見つけた点**は表の後に挙げる。

| 指摘（要旨） | 採否 | 反映先・理由 |
|---|---|---|
| P1-1（4c）：制御 message・cache の降格・窓超過の throw を send tap で行うと、adapter の順序（`agentLanguageModel.ts:841-859`†）のため sink の `request.prepared`（`agentAuditSink.ts:136-197`†）と実際の送信がずれる／dispatched なのに送っていない状態になる | 採用 | DR-MP4-28（変形と拒否はすべて begin の前。注入点は adapter の境界の改訂として記録、案 B は `prepareStep`）。DR-MP4-12・25 と第 3 節の「send tap」を「応答の観測 tap」と「begin の前の注入点」に分けた。試験「`request.prepared` の messages・`systemCacheSegments` が wire の args と bytes で一致」を第 6 節に追加。K-1 を改訂。窓超過の throw は begin の前（legacy も行が残らない。`chatTurnStoreActions.ts:1232-1243`†、`chatApi.ts:163-216`†） |
| P1-2（4c）：renderer の drain（`ipcQueue.ts:353-388`†、`:193-195`†）は start を期限なしで待ち、main の forced は open_workspace の後（`ipc.ts:2445-2451`†）。複数 step の turn では切替が turn の終わりまで待たされる。「未確認（forced で観測するはず）」は誤り | 採用 | DR-MP4-29（owner／lifecycle の表と (a)(b)(c)、推奨 (a)＝lease の通知で cancel）、DR-MP4-26 の表の該当行を訂正。(b)(c) は quiescence の不変条件の変更なので C-17（条件つき）。P29 を影響マトリクスに追加。cancel の拒否は audit-export の lease だけ（`quiescenceLease.ts:345-350`†）と確認 |
| P2-1：audit export の「AI の実行中なら断る」（`executionRegistry.ts:33-45`、`:92-99`、`exportBoundary.ts:185-205`†）が Mastra の turn を数えない | 採用 | DR-MP4-31（start の間 registry に予約・完了。鍵は `turnId`。新しい契約なし。MP-3c から存在する欠落〔到達は journey だけ〕として記録）。C-14 は技術判断に（DR-MP4-27）。P30 を追加 |
| P2-2（4b を止める）：main の直呼びの read に caller の timeout が無い | 採用 | DR-MP4-4（既存の定数を共有 module に出す。`db_execute`・`fts_search` は 10 秒、semantic 2 本は 5 分〔回答 3〕）。4b の precheck の条件。脅威モデルの D16 の (5) |
| P2-3：tools の wire を名前だけにする場合の main 側の定義の出所。`toolDefinitions.ts:1-12`† が IR を import し DR-MP4-21 と衝突 | 採用 | DR-MP4-30（IR を含まない共有の定義 module と、renderer の snapshot〔`getDeterministicAgentTools`、`sortSchemaKeys`、`chatTurnPreflight.ts:364-370`†〕との bytes の drift 試験）。DR-MP4-21 に試験 6、P28、第 6 節 4、4b・4c-1 の範囲 |
| P2-4：第 7 節の 4a の停止点「C-1 が未了なら一部を実装しない」 | 採用 | 「4a は 3 欄をまとめて、回答 1 の後に着手（回答済み）」に直した（第 5 節・第 7 節） |
| P3：K-19（Rust の trim は U+0085 を除き、JS は U+FEFF を除く）を Native の判定に合わせる形式検査として技術判断に | 採用 | DR-MP4-1（C0・C1・U+2028・U+2029・U+FEFF を値のどこにあっても invalid。4a の実装に合わせた）、K-19（JS 側は `node -e` で確認、Rust 側は未実測） |
| P3：DR-MP4-6 の「4 本が deps を使わないか未確認」の解消 | 採用 | `ipcContract.ts:9818-9828`†、`:10297-10315`†、`:10357-10375`†、`:10677-10683`† は `(b, a)` だけ。DR-MP4-6 を訂正し、静的試験で固定 |
| P3：場面なし null の扱いを試験で固定。`ChatTurnToolScope` のコメント（`chatTurnToolScope.ts:21`†）と食い違う。Codex 側は未知の場面は base。「hidden 側」の表現を直す | 一部採用 | DR-MP4-1・8 を訂正（年表＝secret を隠す〔`chronicleSecrecy.ts:77`†〕、Codex＝base〔`codexHiddenFromAi.ts:62-63`、`:109-112`†〕。コメントは 4b で直す）。**project に無い場面 id の Codex 側の解決は読んでいないので K-20 に残した** |
| P3：有界の待ちを `MASTRA_TURN_FORCED_BOUND_MS`＝30,000、`QUIT`＝5,000（`mastraTurnOwner.ts:68-71`†）に乗せる | 採用 | 第 3.3 節、DR-MP4-5、脅威モデルの W11。乗らない部分は C-16・C-18（条件つき） |
| P3：計画書の行番号の食い違い（第 1.2 節 `plan:355-361` と第 9.1 節 359-363） | 採用 | 実際の範囲 `plan:357-363` に揃えた（第 1.2 節、第 9.1 節） |
| P3：DR-MP4-14 の no-op の中身を技術判断に（C-4 から外す） | 採用 | 固定の文字列定数。次の send の前の `assertLive` で止まるので model に届かない（DR-MP4-14） |
| P3：DR-MP4-19 の条件 5（profileClosed）は main の refusal に任せる書き方に | 採用 | DR-MP4-19 の条件 5。条件 8（pending の start 1 本）を追加 |
| 委任の再分類：C-12、C-5（報告のみ）、C-9（同値の既定。差を受け入れるときだけ確認）、C-3(c)（導出式）、C-8(a)(c)、C-14、C-15(a)、C-1(b)(c)、C-4、C-11（別 issue） | 採用 | 第 8.2 節に旧 ID ごとの行き先を表にした。計画書の「未確認。確認 C-12」も直した（`plan:362`、`:363`、`:376`、`:385`、`:392`、`:644`）。C-11 は別 issue（親が起票）にした。旗 L の前の条件は、確認から「issue の状態を確かめる点」に弱めて残した |
| 残る確認を Q4（4c の wire の契約一式）・Q5（legacy より弱い窓の受容）にまとめる。P1-2 で不変条件を変える場合と read の timeout に新しい値を置く場合は確認要。MP-13 の前：C-6、U-8。条件つき：C-8(b)、C-16、C-10 | 採用 | 第 8.1 節（Q4・Q5、条件つき C-8・C-9・C-10・C-16・C-17・C-18、MP-13 前 C-6・U-8）。推奨も書いた |
| PR の分け方：4c を 4c-1（main 側）と 4c-2（renderer 側。宣言する集合が収まる MP の直前）に分ける。各 PR の precheck の条件を第 7 節に | 採用 | 第 5 節・第 7 節 |
| 脅威モデルの IR の文言を「IR を開ける lane まで閉（MP-4 を含む）」に揃える | 採用 | 脅威モデル（T11、D13、第 6 節 7）、第 1.3 節、第 9 節 |

**実コードで指摘と違った点・追加で見つけた点**：

- cancel が拒否されるのは **audit-export の lease が立てる mutation barrier の間だけ**（`quiescenceLease.ts:345-350`† の `reason !== "audit-export"`）。workspace 切替の lease では cancel は拒否されない。DR-MP4-29 の (a) はこの前提に立つ（lease 中の他のゲートは K-22）。
- **`foreshadow_list_open_for_context` には legacy の caller timeout が無い**（`tauri.ts:227-270`†。mutation の lane で動く）。回答 3 の既存の定数は 4 本のうち 3 本だけを覆うので、4 本目は「timeout なし＋abort との race」とし、新しい値を置くなら C-18 にした（DR-MP4-4）。
- registry に turn を登録すると、`ai-executions` 段（`executionRegistry.ts:117-132`†）も turn の終わりまで待つ。DR-MP4-29 (a) の cancel が先に出ることが前提（DR-MP4-31）。
- `foreshadow` 以外でも、`tauri.ts` の `IPC_TIMEOUT_MS`・`AI_IPC_TIMEOUT_MS` は module 内の非 export（`:19`、`:55`）。共有 module への切り出しは renderer の側の変更を伴う（値は不変）。
- 窓超過の throw で audit の行が残らないのは chat agent の経路（`chatApi.sendAgentMessage`）だけ確認した。他の入口は K-21。
