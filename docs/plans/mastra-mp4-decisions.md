# MP-4（tool 基盤、loop 規則、read tool）の設計と判断の記録

- 状態：**起案（draft）・改訂 1**（2026-11-21。独立レビューの指摘を反映。第 10 節）。第 8 節の「確認要」が未了の間は、該当する PR の編集に入らない（第 7 節）。
  判断を変える場合は、その PR でこの文書を改訂する。
- 親の文書：[Mastra 移行の実装計画](mastra-migration-plan.md)の第 6 節 MP-4、第 7 節 U-4・U-7、第 9 節 R 表。
  [MP-3 の判断](mastra-mp3-decisions.md)（特に DR-MP3-3、24、27、28）、[脅威モデル](mastra-migration-threat-model.md)（T1〜T12、D1〜D15）。
- ID：`DR-MP4-n`。PR 本文にも同じ ID と信頼境界を載せる。確認の項目は `C-n`、未確認の事実は `K-n`。
- 区別：**決定**（ユーザー、2026-11-21）、**技術判断**（この lane の判断）、**案**（実測で確定する。外れたら止める）、
  **確認要**（委任の外。ユーザーの回答まで決めない）。
- 委任の範囲：AGENTS.md の NIR-1 の事前委任は Mastra の lane に及ばない（[MP-3 の判断](mastra-mp3-decisions.md)の冒頭と同じ）。
  新しい送信先・保存範囲の拡大・閾値（新設を含む）の変更・新しい契約や authority は「確認要」とし、黙って決めない。
- 根拠の書き方：`†` を付けた file:line は、起案時と改訂 1 の時にこの worktree（origin/master `414ef976`）で開いて確かめた。
  無印は事前調査（Sonnet の調査と反証。誤りを含みうる）による**未再確認**。Mastra の挙動の根拠はすべて dist の読解か
  plain Node の probe で、adapter を通した実測ではない。
- 起案の制約：この文書は read-only の調査から書いた（改訂 1 も同じ）。build、試験、Electron、Xvfb は一切実行していない（実行前の未確認として扱う）。

## 1. 目的と範囲

### 1.1 目的

MP-3 は tool 0・1 step の骨格だった。MP-4 は、main の loop が tool を持ち、legacy の loop 規則（回数・予算・切詰め・上限・abort）と
同値に動く土台を作る。tool は read 系から移す。旗 L は閉のまま。製品の挙動は変えない。

### 1.2 範囲の読み替え（DR-MP4-19 に続く）

- 計画書の MP-4（`mastra-migration-plan.md:355-361`）は manifest の 44 本を Mastra の tool にする。これを**段階**に読み替える。
  - MP-4：データ read（約 21 本）の核を共有 module に出し、main の tool にする。loop 規則を写す。
    main に載せるのは 20 本（M4）。`get_codex_entry` は C-6 の回答待ちで、残る 1 本。
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
  - この読み替え自体は決定 2 で承認済み。帰結（製品の turn が MP-4 の間 Mastra に届かない）の確認が **C-5**。

### 1.3 ユーザーの決定（2026-11-21。確定）

| # | 決定 | この文書での扱い |
|---|---|---|
| 1 | turn 開始の wire に `projectId`・`currentSceneId`・`chatMessageId` の 3 欄を 1 回の契約変更で足す。main の検査は形式だけ（非空・turn 内の整合・`"default-project"` の拒否）。書き先は legacy と同じ project の chain（実在確認はしない。Codex app-server と同じ強さ） | DR-MP4-1、2、23。細部の 2 点は C-1 |
| 2 | U-7 は (D) 混合。データ read 約 21 本は核を共有 module に出し、main から既存の `backend.dbExecute` と既存の Native の typed 呼出しで同じ SQL を発行（新しい N-API なし）。`get_ui_state`・`ask_user` は MP-5 の RPC。help 2 本は設計で決める。MP-4 の間は main の tool が 44 本そろわない | DR-MP4-3〜11、19 |
| 3 | U-4(f) は DR-MP3-3 どおり IR を開ける lane へ延期。MP-4 でも chat IR は閉。main の tool に IR を呼ぶ executor が無いことを静的試験で固定する（`chatAgentIr.test.ts:162`†、`:193`† の拡張）。plan・threat-model の記載を揃える | DR-MP4-21、第 9 節 |

### 1.4 範囲外

write 系の tool、capability の発行（MP-6）、memory（MP-7 以降）、main→renderer の RPC（MP-5）、`run_research` の子 loop、
Context Creator、live harness、`browser-mock.ts`、packaged の検査（MP-13）。既存バグ `policyAllowsAgentTool` は別 lane で修正中なので触らない（DR-MP4-4）。

## 2. 信頼境界

- **renderer が得る権限**：新しい IPC は無い（start・cancel は MP-3 の既存）。新しい契約は **start request の 3 欄だけ**（承認済み）。
  3 欄は renderer の自己申告で、legacy と同じ強さ。main は形式だけを検査し、強めない。実在も確かめない。
- **新しい契約の候補（未承認。確認要）**：tools の wire の形（名前の list だけを推奨）、結果と進捗の wire、loop 規則の入力（予算・上限・制御 message 3 本）、
  step ごとの payload 確定の入力（窓・出力予約・fallback の system など。C-13）、`fullyInjectedIds`、UI 言語、cancel の lane（C-14）。
  決めるのは 4c の前（C-2、C-3、C-6、C-13、C-14）。
- **main が新しい呼び手になる**：main が `backend.dbExecute` と Native の typed read（`ftsSearch`、`codexSemanticSearch`、
  `eventsSemanticSearch`、`foreshadowListOpenForContext`）を直接呼ぶ。
  - Native の `db_execute` は呼び手を区別せず、renderer 用の authorizer を掛ける（main 用の `SqlOrigin` は無い）。
    `electron/native/grimodex-node/src/lib.rs:10711-10741`†、`src-tauri/crates/grimodex-db/src/execute.rs:61-86`（未再確認）。read tool の SQL は今も同じ Drizzle のクエリなので、拒否される文の集合は変わらない。
  - JS 側の profile gate（`assertInvoke`、`classifyOwnDataRead`）は main の直呼びでは通らない（`profileEgress.ts:1244-1297`、未再確認）。
    profile は restricted のほかに `unavailable`・`activating` がある。owner は `profileClosed()`（3 状態。`mastraTurnOwner.ts:277-280`†）が真の間は turn を admit せず、
    admit 済みの turn も `assertLive` が閉じる（`:375-378`†）ので、**到達できるのは 3 状態のどれでもない（＝unrestricted）ときだけ**。この不変条件に頼り、JS gate は再現しない。
    read の開始の直前と await の後は `profileClosed()` 全体で再確認する（DR-MP4-5）。
  - unrestricted では Native に read-only の強制も workspace の pin も無い（semantic 系だけが `expectedWorkspacePath` で pin する）。
    補いは JS の adapter の**送信前の検査＋事後検出＋静的試験**（DR-MP4-4、5）。
  - **「main が新しい呼び手になる」ことを新しい authority と数えるか**は **確認要 C-4**。脅威モデルへの追記は回答まで書かない。
- **送信先・保存範囲**：LLM 送信は引き続き Rust の `send_agent_message`。送信先は利用者が選んだ provider のまま。
  tool 結果が次の send に載る経路は legacy と同じ。保存範囲の拡大は無い。audit の行は legacy と同じ project の chain に入る（決定 1）。
- **秘匿の入力**：hidden Codex と年表 secret の判定は共有 core が持つ。入力（現在の場面、読む順、phase 解像度）は
  wire の `currentSceneId` と main が DB から再構築する値（DR-MP4-8）。形式検査だけの値がネタバレ防止の入力になる点は legacy と同じ強さで、main は強めない。
  **ただし、場面切替後と DB が古い窓では legacy より弱い**。ADR 013 は hidden と年表 secret を「どの経路でも渡さない」としている
  （`docs/adr/013-ai-disclosure-policy.md:9`†）ので、この弱まりは「同値の差の受容」ではなく保護の弱まりとして **C-7** に出す。
- **失効の観測**：main の `assertLive` は forced・user-stop・`profileClosed()`・sender 破棄・identity の 5 条件だけを見る（`mastraTurnOwner.ts:368-390`†）。
  legacy の `shouldAbortTurn` は workspace・project・chat authority に加えて **AI policy の chat トグルとライセンス**も見る（`chatTurnStoreActions.ts:490-498`†）。
  main は project の切替・chat authority の変化・policy・ライセンスを観測できない。複数 step の loop が main に移るので、
  作者が AI を切った後も次の step の send（provider への送信）が renderer の cancel の到達まで続きうる。
  条件ごとの守り方は **DR-MP4-26**、確認は **C-15**。この弱まりは legacy より弱い点として脅威モデルへ回答後に書く（第 9.2 節）。
  なお「S1-B の T3（turn 開始固定）」は NIR-1 の脅威モデルの ID で、この lane の T3（restricted・非 agent chat での memory）とは別。

## 3. 影響マトリクス

### 3.1 層 × 変更

| 層 | 変更 | PR |
|---|---|---|
| renderer | engine 分岐（pure な判定関数＋start 呼出し）、3 欄の組立、default-project では start を呼ばない、gate-closed の記憶、scene write の flush（**Mastra の分岐に入ってからだけ**。DR-MP4-9）、authority の watcher（DR-MP4-26）。legacy の呼出し順は変えない | 4c（3 欄の型追従は 4a） |
| IPC・wire | `mastraAgentTurnWire.ts` に 3 欄（START_KEYS 7→10）。`tools`・結果の形は C-2 | 4a／4c |
| main | owner の Turn に 3 欄を束ねる。sink の projectId・chatMessageId。read port、db adapter、rules module、tool の execute wrapper | 4a／4b／4c |
| N-API | **変更なし**（新しい command なし）。既存の `dbExecute` と typed read の run を再利用 | - |
| Rust | **変更なし**（ai_audit は scope 一致を既に照合する。`ai_audit.rs:1784-1797`、未再確認）。試験 fixture のみ：`mastra_wire_parity_tests.rs` に M4 の部分集合（DR-MP4-17） | 4c |
| MCP | 変更なし。standalone MCP は別経路 | - |
| 試験 | wire・owner・gate・journey の fixture、特性試験（legacy と Mastra の両方）、read の fixture 比較、schema の無変形、IR の静的試験 | 全 PR |
| docs | 本文書、plan、threat-model、mp3-decisions の申し送り（第 9 節） | 4a から |
| build・配布物 | tokenizer の wasm と ranks の同梱（C-8。3 案は DR-MP4-18）。`main.cjs` か `mastra-agent.cjs`、または bundle の外の file。大きさの変化は未測定。`schema.ts` の移動の場合は品質ゲートの参照先（DR-MP4-3） | 4b |

### 3.2 経路ごとの行

列は [impact-matrix](../../.agents/skills/refactor-cross-boundaries/references/impact-matrix.md) の template に合わせ、
Owner／Boundary／Consumer は略記する。Status は `unknown` なら実装前に解消する。

| ID | Flow / variant | Owner | Boundary・検証 | Consumer | 保つ不変条件 | Fallback | 検証 | Status |
|---|---|---|---|---|---|---|---|---|
| P1 | start：3 欄が valid、admitted | owner | parser（形式）＋事前検査（default-project） | sink、runtime | 3 欄は start で 1 回束ね turn 中に変えない | - | wire／owner／gate test、journey | planned |
| P2 | start：refused（invalid／unsupported／gate-closed／busy／restricted） | renderer 分岐、owner | typed refusal | legacy | 準備の例外は legacy へ。admit 後の失敗は再送しない | legacy | 分岐の pure 関数 test | planned |
| P3 | main の `dbExecute` read（own-data） | read port | 送信前の検査（SELECT・method・params）、marker 'read' 確認、object の行、throw で fail-closed、`profileClosed()` の 3 状態 | core | unrestricted だけで動く。SELECT だけ | turn を失敗にする | adapter 単体（Native を呼ばない spy）、実 addon の fixture 比較 | planned（K-6 は unknown） |
| P4 | main の typed read 4 本 | read port | 4 本は名前固定の method（literal key の `NAPI_COMMANDS`。cmd を引数に取らない）、semantic は identity の workspace を pin | core | pin 無しの 2 本は assertLive の前後検査で補う | 同上 | adapter 単体、静的試験、pipeline spec | planned |
| P5 | hidden Codex・年表 secret の入力 | core | `currentSceneId`（project の場面集合に無ければ hidden 側）、nodes（`project_id` で絞る・archived 除外）、`projects.phase_resolution_mode` を DB から | tool 結果 | fail-closed（不明は隠す）。core の projectId は必須 | - | fixture 比較（解除・secret・XPROJ・他 project の場面・archived） | unknown（K-4、K-5） |
| P6 | 場面本文 read（`get_scene`、`get_thread_scenes`） | core | barrier 無し。start 前の renderer の flush（Mastra の分岐だけ） | tool 結果 | DB に着いた内容だけを読む | - | 特性試験に差を明記 | planned（C-7） |
| P7 | tokenizer の初期化と count | tokenizer port | exact（o200k）。失敗は fail-closed。init は single-flight で、admission の登録の前に await し、その後に `admissionRefusal` を再実行 | rules module | 数え値は legacy と同じ。登録までに await を挟まない | init 失敗は turn を始めない／legacy | 数え値の一致 test、並行 start の test | unknown（K-7） |
| P8 | loop：回数・予算・切詰め | rules module | tool_use を legacy と同じ条件で数える（DR-MP4-12）。25% 切詰め | send、wire | agentLoop.ts の規則 1〜5 と同値 | - | 特性試験（両 engine） | planned（案。DR-MP4-12） |
| P9 | loop：上限到達と制御 message | rules module | 優先順 questions>calls>tokens。上限後に 1 回だけ応答を許す | send | agentLoop.ts:246-249†、:386-406† | - | 特性試験 | unknown（K-1、K-2）。4c の最初の特性試験の完了が実装の前提 |
| P10 | abort・forced・authority 喪失 | owner、wrapper | execute の先頭と**実行後**の検査、no-op 結果 | send tap | 次の LLM 呼出しを止める。実行後に外れたら tokensUsed と record を数えない | - | lifecycle 試験 | unknown（K-3）。4c の最初の特性試験の完了が実装の前提 |
| P11 | 未宣言 tool | wrapper | 宣言集合の外は拒否（throw。error-text の経路。`Error: Tool not available this turn: <name>`、`isError: true`） | send | tool_result を欠落させない | - | 特性試験 | planned（C-9） |
| P12 | tool schema の送出と入力検証 | adapter、wrapper | 原本の bytes、検証なし・無変形 | Rust、execute | legacy は検証しない | - | schema bytes、無変形 test | planned |
| P13 | audit の chain（project、chatMessageId、parent） | sink | projectId を 1 か所で与える | Native の precondition | scope 一致が構造的に保たれる | - | sink／pipeline spec | planned |
| P14 | 結果と進捗の運搬 | wire | 確認要 | renderer | `stoppedReason` で「続行」を出す | legacy | 確認後に決める | unknown（C-2）。4c の wire の前提 |
| P15 | engine 分岐 | renderer | 宣言集合 ⊆ main 集合 | owner／legacy | gate-closed は process の間 1 回だけ。`blockIfPolicyOff("chat")` の後ろに分岐が残る | legacy | 分岐 test、閉の特性 test | planned |
| P16 | chat IR | - | main に IR の executor・説明文・IR 定数の分岐が無い | - | IR は閉のまま | - | 静的試験（DR-MP4-21） | planned |
| P17 | `run_research` と子 loop、Context Creator | - | out of scope: DR-MP3-3 | - | - | legacy | - | out of scope: 移さない |
| P18 | write・UI tool | - | out of scope: MP-5、MP-6 | - | - | legacy | - | out of scope: 後続 MP |
| P19 | hermes、添付、public RAG、browser-mock | renderer 分岐 | 当面 legacy | legacy | 挙動を変えない | legacy | 分岐 test | planned（K-9） |
| P20 | step ごとの payload 確定（窓超過の throw、cache の降格）と send ごとの renderer の副作用 | send tap、renderer | C-13 の回答まで未定（DR-MP4-25） | Rust、renderer | legacy と同値か、受容した差の明記 | - | 特性試験 | unknown（C-13、K-18） |
| P21 | authority の失効の観測（workspace・project・chat authority・policy・license） | owner、renderer の watcher | DR-MP4-26 の表 | send、tool | 守れない条件は C-15 に載せた窓だけ | cancel | watcher の購読 test、lifecycle 試験 | unknown（C-15、K-17） |
| P22 | cancel の lane、audit export 中の cancel | renderer wrapper、owner | C-14 の回答まで未定（DR-MP4-27） | renderer | Stop が効く | - | lane の test | unknown（C-14） |
| P23 | provider 別（anthropic／openai／openrouter、custom endpoint）の tool_use の数え方と usage 合計 | send tap | adapter が provider ごとに `stopReason`・usage を写す。legacy と同じ式で合計 | rules module | provider によって回数・usage が変わらない | - | provider 別の特性試験 | unknown（R-21 と同種） |
| P24 | null・空文字・未指定の意味（`currentSceneId`、`chatSessionId`、tool 入力の null） | parser、core | `currentSceneId` の空文字は null に写す（C-1(a)）。tool 入力は無変形（DR-MP4-17） | core | null と空を区別しない箇所を作らない | - | wire test、無変形 test | planned |
| P25 | turn 中の設定変更と snapshot 境界（窓、custom context、動的 model 能力、UI 言語） | renderer | turn 開始の snapshot を wire で運ぶ（C-3、C-13）。turn 中の変更は反映しない | rules module | legacy も turn 開始に捕捉する値と同じ時点（未再確認） | - | 特性試験に差を明記 | unknown（C-3） |
| P26 | audit chain の永続形式（project chain と workspace chain の旧行の共存） | sink | MP-3 の行は workspace chain、MP-4 の行は project chain。移行はしない | Native | 旧行を書き換えない | - | pipeline spec | planned |
| P27 | main thread の占有（tool の整形・数え、init） | read port、tokenizer | DR-MP4-18 の測定。対策が閾値の新設なら C-16 | main 全体 | 他 window の IPC と終了処理を塞がない | - | 4b の spike の測定 | unknown（K-16） |

**unknown 行と PR の対応**（実装の前に解消する）：4b は P5（K-4、K-5）、P3（K-6）、P27（K-16）。4c は P7（K-7）、P9・P10（K-1〜K-3）、P14（C-2）、P20〜P22・P25（C-13〜C-15、C-3）、P23。

### 3.3 lifecycle note（非同期の行）

GDX-PRECHECK-001 の項目（entry、admission closure、pending-start、handle の所有、cancellation、有限の待ち、終了の証跡、error／timeout／onClosed の所有、永続の再起動状態）を、行ごとに書く。

- **P1、P2（start）**：entry は start と cancel の 2 本（MP-3 の既存）。admission closure は gate、quit、profile closed、sender、
  switchDepth、busy、上限（`mastraTurnOwner.ts:551-583`†）。3 欄の検査は admission の前（parser）と事前検査（unsupported）に置き、admission の順は変えない。
  pending-start は MP-3 と同じ。新しい待ち時間は作らない。
- **P3、P4（read の in-flight）**：owner は Turn。read は開始の直前に `profileClosed()`（3 状態）を含む `assertLive` を同期で通し、await の後に `forcedCause` と `assertLive` を再確認して、
  外れたら結果を捨てる。in-flight は send と別の counter で数え、slot の解放と quiesce の待ちに含める（現状は send だけ。`nativeInFlight`）。
  cancel は N-API 呼出しを止められないので、結果を捨てて settle を待つ。待ちは quit の既存の有界の待ちと gate の待ちに乗せる（値は脅威モデル第 4.3 節の W 表。記号のままで値は未導出＝未確認）。
  **乗らない部分は新しい閾値になるので C-16 で確認**する。終了の証跡は呼出しの返り（settle）で、**slot の計数だけに使い、永続化の終了証跡ではない**（D11 の「`settled()` は証跡にしない」と区別）。
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
- **P9、P10（loop の終わり方）**：上限到達の後の「最後の 1 応答」と forced の合流先を、特性試験で固定する。**この特性試験の完了を 4c の実装の前提とする**。
- **P14（進捗・結果の運搬）**：進捗は一方向の event で、renderer の喪失時の所有・終了証跡は MP-3 の cancel と同じ。形は C-2 の回答まで未定。
- **P20〜P22**：send ごとの確定は send tap の同期の区間で行い、新しい待ちを作らない（C-13 の回答後）。watcher の購読は turn の終端で解除する（renderer の leak を作らない）。cancel の lane は DR-MP4-27。

## 4. 技術判断

### DR-MP4-1 wire の 3 欄と検査（決定＋技術判断）

- 決定（2026-11-21）：`projectId`・`currentSceneId`・`chatMessageId` を start request に足す。START_KEYS を 7 から 10 にする。
- 検査（形式だけ）：
  - `projectId`、`chatMessageId`：非空・trim 済み・200 字以下（既存の `isTrimmedId`。`mastraAgentTurnWire.ts:338-345`†。上限は既存の `MASTRA_AGENT_TURN_ID_UTF16_MAX`＝200†（`:83`）の再利用で新設ではない）。
    Native の要件（非空・前後空白なし。`ai_audit.rs:767-777`†）に対して**同等以上**にする。JS と Rust の `trim` の空白集合は違いうる（K-19。未実測）ので、
    制御文字（C0／C1、U+2028／2029）を invalid にする案を **C-1(c)** に出す。実在は確かめない。
    `project:<任意の id>` の audit chain が turn ごとに作られうるが、legacy と同じ強さ（決定 1）。
  - `currentSceneId`：`string | null`。非 null なら `isTrimmedId`。legacy は場面なしを許し、`ChatTurnToolScope` も null を許す
    （`chatTurnToolScope.ts:19-23`、未再確認）。承認文の「非空」を字義どおりにすると、場面なしの turn が全て legacy に落ちる。**C-1**。
    出所：legacy の tool は tree store の `activeSceneId` を live で読み、preflight は chat store の `activeSceneId`（string。空文字がありうる。`chatTurnPreflight.ts:123`）を捕捉する。
    `effectiveSceneId` は `chatScope` が scene 以外で null になる（`:372-374`†）ので、tool が読む値とは別。wire に載せるのは前者（`activeSceneId`。空文字は null に写す）。
  - 新しい issue code は固定文字列で、値を echo しない。禁止 key には足さない。
- 「turn 内の整合」の定義（案）：3 欄は start で 1 回束ね、sink・tool scope・send args が**同じ値**を使い、turn 中に変えない。
  chatSessionId や messages との照合は含めない。**C-1** で確認する。
- `"default-project"` の拒否は二層。(a) renderer は `turnProjectId === FALLBACK_PROJECT_ID` なら start を呼ばず legacy。
  (b) main は owner の事前検査（既存の `unsupported` の列）で拒否する。wire file は import を持てない
  （`mastraAgentTurnWire.ts:1-20`、未再確認）ので、owner に literal を置き、`currentProjectAuthority.ts` の値との一致を test で固定する
  （前例：`mastraAgentTurnWire.test.ts:120-128`、未再確認）。parser は形式だけなので invalid、default-project は unsupported。
- 現状：start request は exact 7 key†（`mastraAgentTurnWire.ts:175-196`）で、3 欄はどちらの key 集合にも無い。
- 代案：(i) parser で default-project を invalid にする：wire に literal の複製が要り、「形式だけ」の検査の範囲を超える。退けた。
  (ii) 実在確認：Codex app-server と同じ強さにする決定に反する。

### DR-MP4-2 owner と sink（技術判断）

- Turn（`mastraTurnOwner.ts:207-232`、未再確認）に 3 欄を `readonly` で束ねる。
- `createMainAgentAuditSink` の `projectId` を `request.projectId` にし、コメント「The wire carries no project」を直す。
  現状は `projectId: null`（workspace chain）†（`mastraTurnOwner.ts:611-617`）。決定 1 で書き先は legacy と同じ project の chain になる。
- Native の scope は `projectId` を 1 か所で与えれば、begin の行と send の `auditContext` の両方に同じ値が使われ、構造的に一致する
  （`agentAuditSink.ts:233-247`、`:292-324`、`agentLanguageModel.ts:450-460`、いずれも未再確認）。追加の cross-check は要らない。
- 4a の範囲では tool 0・1 step のままなので、`parentExecutionId` は null のまま。複数 step（4c）では前 step の `executionId` を連鎖させる
  （legacy の `chatTurnStoreActions.ts:1276`、`:1299`。未再確認）。DR-MP3-23 の「parent は null（tool 0）」の改訂は 4c（第 9 節）。
- `operationId`：legacy は renderer の turn UUID（＝wire の `turnId`）。sink は自前の UUID。揃えるかは K-8（usage 台帳が鍵にするか未確認）。4c までに決める。
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
  - cache は port で受ける（DR-MP4-16。turn ごとの instance）。legacy の renderer は module singleton のまま（run_research の子 loop と Context Creator がその reset に依存するため。変えない）。
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
  - **A″**：core を 4 つ目の lazy bundle（esbuild の entry の追加）にする。配布物の構成が変わる（C-8 と同じ扱い）。
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
- 既存の `toolExecutors.test.ts` は `@/db/client` と `invoke` を mock している。core 化の後も legacy の結果が変わらないことを、この試験で固定してから進める。

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
  `parsePolicyAllows` は undefined を true にするので fail-open（`ipc.ts:1064-1068`†、`:989-1000`†）。別 lane で修正中。
  新しい reader はこの読み方を踏まず、行は object 前提で書き、policy の欠損は `parseAiPolicy` と同じ「full」の扱いを共有 module で揃える（DR-MP4-26）。
- unrestricted では Native に read-only の強制が無い（`own_data_read` は restricted のみ。`lib.rs:10711-10741`†：unrestricted は `execute_renderer_with_result` で、renderer 用の authorizer のまま書込みも commit される）。
  事前の強制を Native に足すのは新しい契約なので足さない（**C-4**）。補いは上の送信前の検査＋事後検出＋静的試験。
- main 用の `SqlOrigin` と専用の Native command は足さない（新しい契約）。

### DR-MP4-5 read の時点の規則（技術判断）

- egress は次の send だけで、send は毎回 `assertLive`† を通る。read 自体は何も publish しない。よって read の規則は
  「開始の拒否＋完了後の破棄」で足りる。
  1. 入口を 1 本（turn 付きの read port）に集める。
  2. 開始の直前に `profileClosed()`（restricted／unavailable／activating の 3 状態）を含む `assertLive(turn)`（await を挟まず同期）。
  3. await の後に `forcedCause` と `assertLive`（`profileClosed()` の 3 状態を含む）を再確認し、外れていたら結果を捨てて turn の abort に合流する。workspace 切替は切替の前に `forcedCause` を立てるので、切替をまたいだ read の結果は捨てられる（未再確認）。
  4. in-flight を数え、slot の解放・quiesce・shutdown の待ちに含める（現状 `nativeInFlight` は send のみ）。
- 既知の限界（decisions と PR 本文に書く）：unrestricted の `fts_search` と `foreshadow_*` は Native に workspace の pin が無い。切替との競合は 3 の再確認で扱う。
- JS gate は再現しない（第 2 節）。不変条件は「`profileClosed()` の 3 状態のどれでもないときだけ read を始め、await の後も再確認する」で、静的試験と lifecycle 試験の対象に 3 状態を含める。
  （「到達できるモードは unrestricted だけ」は restricted だけを見た記述だった。`unavailable` では JS 側の gate の `assertInvoke` が `db_execute` を拒否する〔`profileEgress.ts:1243-1297`、未再確認〕が、main の直呼びはこの gate を通らない。）
- 代案：(i) JS gate（`assertInvoke`、`classifyOwnDataRead`）を main に再現する：到達できる唯一のモード（unrestricted）で no-op、他の 3 状態では turn が閉じるので dead code。退けた。
  (ii) Native に read-only の強制や pin を足す：新しい契約。既定では足さない（C-4）。
  (iii) read の結果を step の境界まで保留する：read 自体は何も publish しないので不要。

### DR-MP4-6 typed read 4 本の呼び方（技術判断）

- read port は **4 本だけを名前固定の method として公開**する（`fts`、`codexSemantic`、`eventsSemantic`、`foreshadowOpen`）。各 method は `NAPI_COMMANDS` の **literal key**
  （`fts_search`、`codex_semantic_search`、`events_semantic_search`、`foreshadow_list_open_for_context`）の `run`（引数検査＋`parseWire`。`ipcContract.ts:9818-9829`†、`:10297-10316`、`:10677-10684` 未再確認）を呼ぶ薄い wrapper。
  **cmd を引数に取らず、`NAPI_COMMANDS` を動的 key で引かない**。理由：`NAPI_COMMANDS` は全 command（`chat_agent_ir_select`、write 系、`db_execute` を含む）の表で、`chat_agent_ir_select.run` 自体は gate を持たない
  （`ipcContract.ts:9994-10003`†。IR の gate は router の `chatAgentIrGateRefusal`。`ipc.ts:2245`†、`chatAgentIr.ts:22`†）。cmd が変数だと IR の閉鎖の 3 層のうち router の gate を迂回する経路になり、静的試験の「名前の参照禁止」にも掛からない。
- `fts` の `scope` は literal union（`'codex' | 'scenes' | 'snippets'`）にし、`'all'` や任意の文字列を渡せなくする（`fts_search` の `scope` は呼び手の任意の文字列。`ipcContract.ts:9818-9827`†）。
- `run` は第 3 引数 `deps`（`DispatchDeps`）を取る（`ipcContract.ts:6839-6842`、試験は `{} as never` を渡している。いずれも指摘による。未再確認）。4 本が `deps` を使わないことを確かめた上（未確認）で、空の frozen 定数を渡す。それ以外の command には渡さない。
- semantic 系の `expectedWorkspacePath` は `turn.identity.workspaceId`（MP-3 の前例）。fts と foreshadow には pin が無い（DR-MP4-5）。
- 直呼びは `assertInvoke` と `classifyOwnDataRead` を通らず、最終 authority は Native になる。信頼境界として PR 本文に残す（C-4）。
- 代案：backend の method の直呼び：引数検査が無くなる。退けた。cmd 文字列で `NAPI_COMMANDS` を引く汎用 port：IR の gate の迂回路になる。退けた。renderer 経由の IPC に戻す案：main から renderer への RPC が要り、MP-5 の契約を先取りする。退けた。

### DR-MP4-7 read tool の分類表（26 本）

manifest の read は 26 本。`READ_ONLY_EXECUTORS` は 24 本†（`toolExecutors.ts:2172-2206`）で、`run_research` と `ask_user` はその外。
(a)＝共有 core＋main の `dbExecute`・既存の Native 呼出しで動く。(b)＝RPC。(c)＝設計判断が要る。依存は事前調査による（未再確認）。

| # | tool | 分類 | 主な依存 | MP-4 での扱い |
|---|---|---|---|---|
| 1 | search_codex | (a) | Drizzle、`fts_search`、`codexSemanticSearch`、`fuseCodexHybrid`、hidden 判定、tokenizer、logger | core。現在の場面は hidden の anchor |
| 2 | search_events | (a) | `eventsSemanticSearch`、年表 cache、読む順、`isEventHiddenFromAi`、現在の場面 | core。IR 版（`searchEventsWithIr`）は使わず plain 版。説明文は DR-MP4-21 |
| 3 | list_codex_by_type | (a) | Drizzle、hidden 判定 | core |
| 4 | get_codex_entry | (c) | Drizzle＋renderer の guard（`fullyInjectedIds`） | **MP-4 の main に載せない**（DR-MP4-10、C-6） |
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
| 18 | list_events | (a) | 年表 cache、読む順、UI 言語、`visibleEventIds` | core。UI 言語は C-3 |
| 19 | get_event_detail | (a) | 同上＋複数 Drizzle | core。UI 言語は C-3 |
| 20 | get_character_timeline | (a) | `visibleEventIds`、`listEventParticipantsForProject` | core |
| 21 | get_chronicle_state | (a) | 参加者・関係・暦、UI 言語 | core。UI 言語は C-3 |
| 22 | get_app_help_index | (c) | i18n、keybindings、license、OS、help 文書 | RPC（MP-5。DR-MP4-11） |
| 23 | get_app_help | (c) | 同上＋`readUiState`（DOM・layout store） | RPC（MP-5） |
| 24 | get_ui_state | (b) | layout store、DOM | RPC（MP-5） |
| 25 | run_research | (c) | 子 loop、`runAgentLoop`、renderer の store | **移さない**（DR-MP4-22） |
| 26 | ask_user | (b) | pending question、利用者の回答の Promise | RPC（MP-5） |

- 結果：(a) 18 本、(c) のデータ read 3 本（`get_codex_entry`、`get_scene`、`get_thread_scenes`）、help 2 本、(b) 2 本、`run_research`。
  main に載せる集合（M4）は (a) 18 本＋`get_scene`＋`get_thread_scenes` の **20 本**（`get_codex_entry` は C-6 の回答後に 21 本）。
- (a) の 18 本も、現在の場面・`resolutionMode`・tokenizer の 3 点が決まることが前提（DR-MP4-8、18）。
- 4 本の年表 tool と `search_events` の鮮度は DR-MP4-16。

### DR-MP4-8 hidden・年表 secret の入力と、live と turn 固定の差（技術判断。差の受容は C-7）

- 入力は 3 つに分ける。(i) 現在の場面＝wire の `currentSceneId`。legacy は IR 閉の間 scope を作らず、`useTreeStore.activeSceneId` を呼出し時に live で読む
  （`chatAgentToolHandlers.ts:459-480`、未再確認）。wire に載せる値は chat store の `activeSceneId`（preflight が turn 開始に捕捉。空文字は null）で、tree store の mirror（DR-MP4-1）。
  (ii) 読む順と `sceneTimeIndex`＝main が DB の `tree_nodes` から再構築する（純関数。`sceneTimeIndex.ts:37-39`、`:109-134`、未再確認）。
  (iii) `resolutionMode`＝`projects.phase_resolution_mode`（`schema.ts:32`、未再確認）。
- **再構築の範囲**：
  - `tree_nodes` は **`project_id` ＝ wire の `projectId` だけ**を対象にし、**tree store と同じ除外（`archivedAt IS NULL`）**を掛ける。
    別の SELECT を書かず、`listNodes`（`src/features/tree/api.ts:240`†。`isNull(treeNodes.archivedAt)`）と同じ projection・同じ除外を共有 core から使う。
    archived を含めると読む順と hidden 判定が変わる。
  - `currentSceneId` が**その project の場面集合に無ければ null と同じ**（hidden 側）として扱う。形式検査だけの値で他 project の場面 id が読む順に混ざると、位置比較が意味を失う。
    legacy の fail-closed（現在の場面が読む順に無ければ隠す。`chronicleSecrecy.ts:77-87`†）は、読む順が project 内に限られることが前提。他 project の `currentSceneId` を渡す fixture を 4b の試験に入れる。
  - core の `projectId` は必須（空なら throw）。`resolveCodexForAi` の projectId が falsy で project 条件が消える形（`codexHiddenFromAi.ts:84-92`†）を port 化で残さない（DR-MP4-3）。
- **鮮度**：legacy の年表の cache は、events／scene-events／codex 名を batch 内の初回使用時に lazy に読んで共有するが、**読む順は nodes の「参照」をキーにする**ので、tree store が更新されれば batch の途中でも再計算される
  （live。`chronicleToolCache.ts:36-69`†）。main は batch の開始時点の DB で固定する。この差（batch の途中で tree が変わっても main は再計算しない）は C-7(d)。
  tree store（メモリ）の更新から DB への永続までの窓（並べ替え・追加の直後）は DB が古くなりうる。DB が古いと**作者の画面より多くを解除する向きにずれうる**（開示側）。
  対策は turn 開始前に、`resolutionMode` だけでなく **tree の並びの未保存の変更も flush する**ことと、残る窓を C-7(b) で受容するかの確認。K-4、K-5。
- (iii) は renderer の store が先で、DB への書込みは debounce の queue（`projectMetadataWriteQueue`）。窓は未測定（K-5）。flush は **Mastra の分岐に入ってからだけ**行う（legacy の開始を遅らせない。legacy の呼出し順は変えない）。
- 差：場面を切り替えない turn では live と固定に差が無い。legacy は場面切替を authority の検査で次の tool 前に abort する経路がある（読みによる推定。K-3）が、
  **scene scope の persisted session では `activeSceneId` の変化だけでは abort せず**（`chatTurnStoreActions.ts:430-433`†。`turnSessionId !== null` なら temporal anchor は同一とみなす）、
  legacy の tool は切替後の場面を live で読む。この条件で場面切替が `activeSessionId` の変化を伴うかは未確認（K-3）。
  main は renderer が cancel しない限り検査が無く、切替後の呼出しは turn 開始の場面で動く。**後ろの場面へ切り替えたなら開示は狭い側、前の場面へ切り替えたなら広い側にずれる**。
  これは「固定が仕様」と決めず、**C-7 の確認まで確定しない**。新しい契約を要さない緩和策は、renderer が場面切替時に Mastra の turn を cancel する（DR-MP4-26 の watcher）こと。
  特性試験の期待に「切替なし＝同値、切替あり＝C-7 の回答どおり」と書き、同値試験の対象から外す。
- `buildReadingOrder` の `localeCompare`（ICU）が renderer（Chromium）と main（Node）で同じ並びになるかは未確認（K-4）。fixture 比較に含める。
- fail-closed を保つ（DB に無い id と不明な mode は hidden）。main 用に別実装を作らず、core を共有する。
- 代案：(i) 場面・nodes・mode も wire で運ぶ：新しい契約。退けた。(ii) 毎 tool で場面を live に取り直す：main は renderer の現在の場面を知らず、RPC が要る。退けた。

### DR-MP4-9 場面本文の barrier（技術判断。差の受容は C-7）

- `loadSceneContent`／`loadSceneContents` は renderer の module 内の「発行済みで未完の UPDATE」を待ってから SELECT する（`pendingSceneWrites.ts:1-24`、`:150-175`、未再確認）。main からは待てない。
- 窓は狭い：debounce 中の未保存の入力は legacy でも DB に無い。`search_scenes` は legacy でも barrier が無い。chat には turn 開始時の flush も無い。
- 案：(i) turn 開始前に renderer が `awaitAllPendingSceneWrites` を呼んでから start する（**Mastra の分岐に入ってからだけ**。legacy の呼出し順と開始の時刻は変えない。試験で固定する）。(ii) 残る窓は受容し、特性試験に「barrier なし」と明記する。
  turn 中の書込みは守れない（legacy は守る）。
- 代案：本文 2 本だけ MP-5 の RPC に寄せる：RPC の失敗モードを read に持ち込むので退けた。barrier の待ち集合を main に持たせる：renderer の module の状態を複製する新しい契約になる。退けた。
- 受容する差は **C-7** に載せる。

### DR-MP4-10 `get_codex_entry` の guard（確認要の前提つき）

- renderer の guard が、system prompt に全文を注入済みの id では executor を呼ばず note を返す。`prepared.fullyInjectedIds`（renderer の文脈組立の結果）に依存し、wire の 3 欄に無い。
  main で落とすと結果と `tokensUsed` が legacy と変わる。
- 選択肢：(1) wire に足す（新しい契約）、(2) guard なしで全文を返す（結果と token が変わる）、(3) main の tool 集合から外す。
- 技術判断：**MP-4 では (3)**。挙動を変えず新しい契約も作らない。L を開ける前（MP-13 までに）に (1) か (2) を **C-6** で決める。

### DR-MP4-11 help 2 本（技術判断）

- 判断：**RPC（MP-5）に寄せる**。main の tool は MP-4 で help を持たない。
- 根拠：
  - `get_app_help` の panel の詳細が `readUiState`（layout store と DOM）を呼ぶ。同じ turn の UI 操作で値が変わるので、turn 開始の snapshot では同値にならない。
  - 動的な入力が 5 種（UI 言語、keybinding の上書き、license、OS、UI 状態）あり、承認済みの 3 欄を超える値を renderer から運ぶか main が自前で取る必要がある。
  - 実装が約 450 行で renderer の store 4 つに跨る。MP-5 の RPC（`get_ui_state`、`ask_user`）で一本化できる。
- 代案：main 化。辞書 2 本（約 660 KB）と文書（約 36 KB）は静的で bundle できるが、動的入力の取得に新しい契約が要り、bundle と起動への影響が未測定。退けた。
- 影響：計画書 MP-5 の renderer の tool が 6 本から 8 本になる（第 9 節）。MP-5 の契約（U-8）はその PR で確認する。

### DR-MP4-12 loop 規則の写し方（案。4c の最初の特性試験で確定）

- 規則は Mastra を import しない **pure な rules module**（`electron/main/` 側。`countTokens`・制御 message・上限値・`shouldAbort` を注入）に集める。
  Mastra へは次の 5 つの継ぎ目だけで繋ぐ：(1) injected send の tap、(2) tool の execute wrapper、(3) `stopWhen`、(4) 有限の `maxSteps`、(5) `prepareStep`。
  closure は runTurn の引数で bundle に渡す（DR-MP3-28 の「runtime に入れるのは Agent・adapter・方針だけ」を保つ）。
- legacy の規則（`agentLoop.ts`。†は 210-250、268-300、312-345、355-375、386-406 を照合）：
  - 回数の既定は 10。メインチャットは窓から 25／16／12／10。tokenBudget は `max(2,000, floor(窓×0.3))`。`ask_user` は別枠 8。
  - 回数は tool_use 1 件ごとに実行前に加算（未宣言も数える。`:272-277`†）。ただし**数えるのは `stopReason` が `tool_use` で、かつ制御 message を挿入済みでない応答の tool_use だけ**
    （`:228-249`。上限後の最後の応答の tool_use と、`stopReason` が `tool_use` でない応答の tool_use block は数えない）。`ask_user` は宣言ゲートより前に別枠で数える。
    上限の判定は**バッチ全体の実行と tool_result の追加の後の 1 回だけ**（バッチの途中では止めない）。判定は `>=`。優先順は questions>calls>tokens†。
  - 上限到達で `{role:'user', content: 制御 message}` を tool_result の後ろに積み、LLM をもう 1 回だけ呼ぶ。その応答が tool_use でも実行せず text で終える†。tools 配列は変えない。
  - 1 件の結果の cap は `max(1, floor(tokenBudget×0.25))`。超えたら `keepChars` で slice し `...[truncated: 元 N tokens]` を付ける。error 文にも掛かる（`Error: ` 前置の後。`:355-375`†）。`totalTokens` は executor が出す**切詰め前**の値の合計（`:325`）。
- 写し方（案）：
  - 回数は send tap で Rust 応答の tool_use block を、**上の 2 条件（`stopReason` が `tool_use`、制御 message 挿入前）で**数える（execute 内で数えると、入力検証の失敗と ToolNotFound を取りこぼす）。
    adapter は `stopReason` が `tool_use` でなければ tool-call を出さない（`agentLanguageModel.ts:670-672`）ので、tap の条件と一致させる。進捗の `totalCalls` を legacy と同じ時点で出す特性試験を足す。
    `tokensUsed` は execute wrapper が `toolCallId` の side table に積む。
  - 上限判定は「次の send の直前」（＝前バッチの全 tool の実行後）に行い、legacy の「バッチ後に 1 回」と同じ時点にする。
  - 上限後の最後の応答：Mastra は「上限 step で tool を実行して終わる」ので legacy と違う。実際の停止は `stopWhen`＝「制御 message を挿入済み（send tap が立てた flag）」で行う。flag が立った後の tool は wrapper が no-op にする。
  - **`maxSteps` の上限（案）は legacy の最大 send 数から導く**：各 send は応答 1 回で 1 step。tool_use のある応答の batch は `totalCalls` か `userQuestionCalls` を少なくとも 1 増やす。
    上限に達していない batch は高々 `(maxToolCalls−1)＋(maxUserQuestions−1)` 個、上限に達する batch が 1、その後の最後の応答が 1。よって send の総数は **`maxToolCalls＋maxUserQuestions` 以下**
    （token の上限が先に働けばさらに少ない）。この式を `maxSteps` に渡す。前案の「＋2 程度」は根拠が無いので採らない。
    式であって定数を足さないこと、Mastra の step の数え方（最後の応答の step を含むか）で 1 足りるか（K-2）を、特性試験で「`maxSteps` ≧ legacy の最大 send 数」として固定する。
    legacy の停止より先に働かない前提なら新しい閾値ではないと扱うが、有限の上限を新しく渡すので **C-3(c)** に載せ、4c の停止点に入れる。
  - 制御 message の入れ方：`onIterationComplete` の feedback は role が `assistant` で、位置も違う（dist の読解）ので使わない。
    案は send tap が Rust へ渡す直前の `args.messages` の末尾に `{role:'user', content}` を足す方式。`prepareStep` で messageList に足す案は順序の未実測。どちらも bytes 一致の特性試験で確かめて採る（K-1）。
- **結果の組立表**（renderer が metadata と永続化を組むための各フィールドの出所。legacy の式を写す。4c の wire は C-2 で決める）：

  | フィールド | legacy の出所 | Mastra 経路の出所（案） |
  |---|---|---|
  | `finalText` | 最後の応答の text（abort の位置で空か直前の応答の text） | send tap が最後の応答の text を持つ（Mastra の text 集計とは別。R-20） |
  | 画面の本文（連結 text） | `onTextChunk` を**応答ごと**に区切りなしで連結した値（持続される content） | send tap が応答ごとの text を積んで連結 |
  | `finalThinkingBlocks` | **最後の応答のものだけ** | send tap が最後の応答のものを持つ |
  | `toolCallRecords` | name・params・`resultSummary`（`ToolResult.summary`。throw では `Error: <msg>`、未宣言では `<msg>`）・tokensUsed（未再確認） | wrapper が side table に name・params・summary・tokensUsed を持つ。未宣言の record は Mastra では出ないので wrapper が自前で出す |
  | usage（累計） | 素の応答の合計 | send tap で素の応答から legacy と同じ式で合計（Mastra の usage は別の値） |
  | `stoppedReason` | `aborted`／上限の理由／`completed` | rules module |
  | Stop 時の途中 text（`canFinalizeStoppedAgentTurn`。`chatTurnStoreActions.ts:1371-1376`、未再確認） | stopped として確定できる | Mastra 経路の cancel が途中の text を返す設計は無い。**C-2(b)** に含める |

- **値の出所（確認要 C-3）**：窓は renderer の `effectiveContextWindow`（custom context、endpoint、動的 model 能力を含む）に依存する。
  main が再計算すると registry と aiSettings を main に移す（新しい authority）。renderer が計算済みの値と制御 message 3 本を wire で渡すのは新しい欄（新しい契約）。
  どちらも承認済みの 3 欄の外。数値は現行の関数（`getAgentToolCallBudgetForContext`、`getToolTokenBudgetForContext`。`modelLimits.ts:1099-1125`、未再確認）を共有 module に移して両側が同じ関数を使い、**新設も変更もしない**。
  main が値を受けるときの検査の値域は、新設の閾値に当たりうるので C-3 に含める。
- **MP-2 の特性試験は土台になるが、そのままでは足りない**：scene は A〜J で上限・`ask_user`・未宣言・abort・バッチ途中・上限後の tool_use を含まず、
  Mastra 側は既定の 5 step。`maxToolCalls` を 10 に固定している（`mastraAdapterCharacterization.test.ts`、未再確認）。DR-MP4 の試験（第 6 節）で足す。

### DR-MP4-13 tool 結果の整形（案）

- null→summary（空なら `No result (not found).`）、`JSON.stringify`、error は `Error: ` 前置、25% 切詰めは **execute wrapper の責務**にする。
- **成功は文字列を返す**（adapter は string を `type:'text'`、`isError: false` で運ぶ。`agentLanguageModel.ts:262-291`†）。
- **失敗は wrapper で throw し、adapter の error-text の経路に乗せる**。adapter は `isError` を output の type だけで決める（text は false、error-text だけ true で `Error: ` を前置する。`:262-291`、`:354-372`†）ので、
  失敗を文字列で返すと wire の `tool_result` の `isError` が落ち、legacy（error のある結果は全て `isError: true`。`agentLoop.ts:358-372`†）と bytes が変わる。
  throw する message は「legacy の content（`Error: ${error}` に 25% 切詰めを掛けた後）から先頭の `Error: ` を除いたもの」にする（adapter が前置を戻す）。
  **端**：予算が極小で `keepChars` が前置より短いとき（前置自体が切れる）は再現できない。特性試験で固定するか、adapter に `isError` を運ぶ口を足す（adapter の契約変更なので、足す場合は扱いを明記してこの文書を改訂する）。
  Mastra が throw を error-text にするときの `value` の形（message のまま渡るか）は未確認なので、4c の最初の実測項目に入れる（K-18）。
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
- no-op の中身（authority 喪失時に model へ何を返すか）は、漏れの検討が要り、脅威モデルの改訂を伴いうる。**技術判断では決めない**（C-4 に含める）。
- authority の条件ごとの観測と守り方は DR-MP4-26。
- 代案：execute で throw する（Mastra が tool error にして loop を続ける。legacy は turn を落とす）：次の send まで loop が続き、authority を失った turn が余計な結果を作る。退けた。

### DR-MP4-15 未宣言 tool（案。差の受容なら C-9）

- legacy：宣言外の tool は executor を呼ばず、`Error: Tool not available this turn: <name>`（content は `Error: ` 前置。`isError: true`）・`tokensUsed` 0 の結果と `ToolCallRecord`（`resultSummary` は前置なしの `Tool not available this turn: <name>`）を作り、回数に数える
  （`agentLoop.ts:281-296`†、`:358-372`†）。
- Mastra の既定は `ToolNotFoundError` で、使える tool の一覧を model に返し、record も `onToolComplete` も出ない（dist の読解）。
- 案：回数は send tap で数える（宣言外も数える）。tool map を包んで未宣言名を自前の拒否 tool に流す。拒否 tool は DR-MP4-13 と同じく **throw して error-text の経路に乗せ**、
  wire の `tool_result` を `Error: Tool not available this turn: <name>`・`isError: true` にする。record は wrapper が自前で出す（`resultSummary` は前置なし）。
  再現しない（Mastra の既定を受ける）なら、「使える tool の一覧が model に渡る」差を受容することになり、loop 規則の同値の範囲を読み替える。**C-9**。

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

### DR-MP4-17 tool schema の bytes 一致と入力検証の同値（案）

- legacy の loop は tool 入力を検証しない。検査は「宣言した tool 名か」だけで、`tu.input` はそのまま executor に渡り、executor が緩く読む
  （`agentLoop.ts:315-316`、`toolExecutors.ts` の `String(params.x ?? "")` など、未再確認）。よって同値の基準は「Mastra が何も足さず何も除かない（無検証・無変形）」。
- probe の結果（scratchpad の一時 script。Node 24、自作の fake `LanguageModelV4`、adapter は通していない。合成 schema のみ。残らない）：
  - ai の `jsonSchema(...)` で包む（MP-2 の試験と同じ形）：検証は走らず、不正入力も null も無変形で execute に届く。機構は未確認。
  - 生の JSON Schema：Ajv で検証し、required 欠落・型違い・enum 違反・minimum 違反・文字列化 JSON の配列を拒否し、null の任意項目を除去する。
    検証失敗は throw でなく `{error:true,...}` の JSON が tool 結果になり、adapter は `isError:false` で model に返す（legacy の `Error: ` と食い違う）。
  - 自前の StandardSchema（`validate` は `{value}` を返すだけ、`jsonSchema` は原本）：無検証で、送る schema も原本と bytes 一致。
- 判断（案）：**自前の StandardSchema（検証なし）** を採る。legacy と同値で、拒否の新設も無い。ai の実行時 import を main に持ち込まない（DR-MP3-28）。
  生の JSON Schema を採ると検証の新設（拒否の増加）になるので、**採るなら C-10**。
- Mastra は送出時に schema を書き換える（`$schema`、`additionalProperties:false`）が、adapter が turn 開始 snapshot の原本へ名前で戻すので wire は原本のまま
  （`agentLanguageModel.ts:391-415`、未再確認）。名前が snapshot に無ければ throw する。
- 試験：実際の 44 本のうち M4 の 20 本に不正入力（欠落・型違い・null・文字列化 JSON・extra key）を流し、無変形で execute に届くことを固定する。版を上げると落ちる形にする。
  snapshot は「その turn で宣言する集合」から作る。Rust の wire parity fixture は現在 1〜2 tool（`mastra_wire_parity_tests.rs`、未再確認）なので、M4 の部分集合の fixture を足す。

### DR-MP4-18 tokenizer（技術判断＋確認要）

- 事実：`countTokens` は renderer の `contextBuilder.ts` にあり、o200k_base の tiktoken（WASM）を Vite の `?url` と fetch で読む。未 init・失敗なら heuristic（`estimateTokens`）に**無言で**落ちる
  （`contextBuilder.ts:485-545`、`:2319-2354`、未再確認。`:511-516` の `import('tiktoken/lite/tiktoken_bg.wasm?url')` は Vite 専用で、main の bundle にはそのまま使えない）。
  loop は入口で `ensureTokenizer` を待って exact を保証する（`agentLoop.ts:160`、未再確認）。切詰めの位置と予算の到達判定は数え値で決まる。
- probe（plain Node 24、tiktoken の lite を `readFileSync` の bytes で init）：o200k で動く。init 約 163 ms。数え値（o200k 対 heuristic）は日本語 32 対 33、英語 31 対 45（約 45% 過大）、JSON 18 対 19。
  Electron main の値は未測定。
- 判断：main でも **exact（o200k）** を使う。**heuristic に落とすのは閾値の黙示変更で委任外**。init が失敗したら **fail-closed**（事前検査で `unsupported` を返し、turn を始めず legacy へ落とす。3.3 節の P7。順序は「同期の refusal → init → `admissionRefusal` の再実行 → 登録」）。
  legacy は無言で heuristic に落ちるので、main の方が厳しい差になる。この差は意図的で、PR 本文に書く。
- 置き場：tiktoken の自動 load は `__dirname` と祖先の `node_modules` から wasm を探す。bundle 後の `dist-electron/` には wasm が無く、packaged では `node_modules` が asar に載らない
  （`electron-builder.yml:14-21`、`beforeBuild.mjs`、未再確認）。`__dirname` 探索に頼らず、wasm と ranks を bundle の隣か中に持つ init 経路が要る。
- **bundle の置き先（3 案）**。現行の build は `platform: "node"`・`format: "cjs"` で、loader 指定が無く、external は `electron` と `*.node` だけ、出力は 3 本
  （`main.cjs`、`preload.cjs`、`mastra-agent.cjs`。`electron/scripts/build.mjs:28-36,55-72`†）。**動的 `import()` は同じ `main.cjs` の中の遅延評価になるだけで、wasm（約 1.07 MB）と ranks（約 2.3 MB）が `main.cjs` に入り、ファイルサイズと parse の対象が増える**。
  DR-MP3-29 は literal な `require` を esbuild が bundle してしまうので変数で隠している（`createRequire(変数)`）。
  - (a) `main.cjs` に入れる（遅延評価でも parse・サイズが増える。wasm の loader 設定が要る）。
  - (b) lazy な `mastra-agent.cjs` の側で動かし、`dbExecute` と `countTokens` を注入する。DR-MP3-28 の境界の改訂になる。
  - (c) **bundle の外の file**として `extraResources`／`asarUnpack` で配り、変数経由の `require` 相当で実行時に読む。`main.cjs` を増やさず起動に載らないが、**配布物の構成の変更**で、C-8(a) に含める。
  - 選び方は **budget の測定の結果を先に取ってから**（metafile、`coldStartMs`、perf budget。build と Electron が必要。未実施）。大きさは測定済みの値だけを書く（`main.cjs`・`mastra-agent.cjs` の現在の大きさは未測定。以前の記載の 3.07 MB と 13.7 MB は根拠が無いので削除した）。
- **budget の停止条件**：既存の budget と ceiling（`perf:budget` の bundle 上限、`coldStartMs` など runtime-performance-budget、`schema.ts` の移動による renderer の起動 graph の ratchet）は**緩めない**。超えたら実装を止めてユーザーに確認する（C-8）。
  新しい budget の新設は閾値の新設（C-8(b)）。
- **main thread の占有**（lifecycle の未確認事項。K-16）：tool の実行（SQL 結果の写像、全 node の読む順の構築、`localeCompare`、`JSON.stringify`、`countTokens`）が Electron main の event loop に移る。
  入力は model が決める（prompt injection。T9）ので、巨大な `limit`・配列・大きい結果で main が長く塞がり、全 window の IPC と終了処理（D11、quit の期限）が止まりうる。
  Native 側には SQL の資源上限があるが、JS 側の処理には無い。legacy では renderer の負荷で済んでいた。tokenizer の init（約 163 ms）だけでなく、定常時の占有を 4b の spike で測る。
  対策案（結果の長さの先頭の cap、分割と yield、別 thread）が閾値の新設に当たるなら **C-16**。DR-MP4-17 の「無検証・無変形」とは別の層（入力の検証ではなく実行の分割）の対策として検討する。
- 確認要：wasm と ranks を配布物に新たに同梱する（C-8）。main.cjs の byte や init 時間の budget を新設するなら閾値の新設（C-8）。
- 未確認：asar からの読込、Electron main での init 時間と event loop の塞がり、`encode()` が特殊 token 文字列で throw するか（legacy にもある可能性）。

### DR-MP4-19 engine 分岐（技術判断。範囲の読み替えの帰結は C-5）

- 差し替える範囲：MP-3 の DR-MP3-24 は「`sendToLLM` の送るだけを差し替える」としたが、これは tool 0 の前提。MP-4 では `runAgentLoop`（`chatTurnStoreActions.ts:1236-1350`）全体に及ぶ。
  `guardedExecuteTool` の配線（`ask_user`、`run_research`、`fullyInjectedIds` の短絡、assistant 行の確保）も同じ。
- 判定は **pure な関数**に切り出す。**Mastra に送る条件**はすべて満たすとき：
  1. provider が anthropic／openai／openrouter（parser の `provider` と一致）。
  2. `chatSessionId` が確定している。
  3. `turnProjectId` が `"default-project"` でない（DR-MP4-1）。
  4. 宣言する tool 集合が M4 に収まる。製品の agent-mode は 44 本なので **MP-4 の間は常に収まらない**（journey の seam だけ）。
  5. `profileClosed()` の 3 状態（restricted／unavailable／activating）のどれでもない。
  6. この process で gate-closed を観測していない。
  7. 添付なし、hermes でない、public web search の経路でない（下記）。
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

### DR-MP4-20 tools の wire・結果と進捗の wire（確認要）

- tools：MP-3 の wire は「常に空配列」。MP-4 で main が tool を持つなら、名前の list（定義は main が持つ）か、定義ごと運ぶか、別の欄か。
  **推奨は名前の list だけ**（C-2(a)）。定義ごと運ぶと、renderer が書いた説明文・schema が model に届く。main は**実行時に wire の名前を M4 の凍結集合と照合**し、集合に無い名前は `unsupported` で拒否する
  （静的試験で凍結するだけでなく、実行時の照合も試験で固定する。DR-MP4-21 の 3）。
  DR-MP3-24 は「tools 非空は `unsupported`」と書くが、実装は parser の issue `tools` で invalid（`mastraAgentTurnWire.ts:533-542`、`mastraAgentTurnGate.test.ts:599-614`、未再確認）。文書と実装を 4a で揃える。renderer はどちらでも legacy に落ちる。
- 結果：MP-3 の start 結果は `{status:'completed', turnId, executionId, response}`（1 回分の生の応答）。renderer は `toolCallRecords`、`stoppedReason`（「続行」を出す条件）、累計 usage、`tokensIn`／`tokensOut`、`cost`、`citations`、`finalThinkingBlocks`、進捗（`onProgress`、`onToolComplete`、`onTextChunk`）で metadata と永続化を組む。
  運ぶ口が無い。Mastra の usage は legacy の素の合計と別の値なので、send tap で素の応答から legacy と同じ式で合計する。結果の組立表は DR-MP4-12。
- **send ごとの renderer の副作用**（DR-MP4-25）：legacy は send の前後で `retirePriorCapture`、`cancelBeforeTransport`、`notifyAccepted`（`_onAccepted`）、`agent-running` への遷移、`contextTokenCount`／`contextWindowUsage` の更新、入力 token の drift の集計を行う
  （`chatTurnStoreActions.ts:1226-1262`†、`:1305`）。進捗の wire はこれらの運び先も含める。
- **どちらも承認済みの 3 欄の外で、新しい契約**。形は **C-2** の回答後に決める。それまで 4c の wire は確定しない。

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

### DR-MP4-24 `get_foreshadow_detail` の secret（技術判断）

- `list_open_foreshadows` は `secret=0` で落とすが、`get_foreshadow_detail` は secret の判定が無い（`foreshadow.rs:1644-1651`、`toolExecutors.ts:1533-1628` の grep、未再確認）。非対称。
- MP-4 は同値で写し、**変えない**。PUB-G の方針（hidden と年表 secret は守る）に照らした意図の確認だけをユーザーに出す（C-11）。挙動の変更は別 lane。
  **既知の非対称が main の新しい経路にも写る**ことを 4b の PR 本文と脅威モデルの未確認事項に明記し、C-11 の回答を旗 L を開ける前の条件に入れる（停止点は MP-13）。
- 代案：MP-4 で secret を落とす：利用者に見える挙動の変更で、同値の基準に反する。退けた。

### DR-MP4-25 step ごとの payload 確定（確認要 C-13）

- legacy は send ごとに `finalizeChatTurnPayload` を呼ぶ（`chatTurnStoreActions.ts:1226-1262`†）。会話が伸びるたびに、(a) 予算超過で `ContextWindowExceededError` を throw する（`finalizeTurnPayload.ts:373`†）、
  (b) 超過時に cache の配信を plain へ降格する（`cacheDowngradeReason = 'budget'`。`:334`†）、(c) Ollama の窓不足の throw（指摘による。未再確認）。
  send の前後で renderer が `retirePriorCapture`、`cancelBeforeTransport`、`notifyAccepted`、`agent-running` への遷移、`contextTokenCount`／`contextWindowUsage` の更新、入力 token の drift の集計を行う。
- Mastra 経路：start request の `systemCacheSegments`／`systemVolatileTail` は全 step で同じ値を送り続け、窓・出力予約・fallback の system の欄は wire に無い（`mastraAgentTurnWire.ts:153-196`、route の key に `contextWindow` も出力の予約も無い）。
  このままでは、25 step・大きい tool 結果の turn で、legacy は型付きの窓超過エラーで止まるが、Mastra は窓超過の request をそのまま送る（降格も無い）。
- 選択肢（どちらも委任の外。技術判断では決めない）：
  - (i) 窓・出力予約・fallback の system などの欄を wire に足し、main の send tap で同じ確定（検査と降格）を行う。新しい契約で、窓と予約の取り扱いが閾値に関わる。共有 module の `finalizeTurnPayload` と tokenizer が main で要る。
  - (ii) この検査と降格が無いことを受容する。tokenizer を heuristic に落とすのと同じ種類の黙示変更に当たるので、黙って決めない。
  - 推奨は (i)（形は C-2 と一緒に決める）。renderer の send ごとの副作用の運び先は進捗の wire（DR-MP4-20）に含める。K-18（MP-3 の start が 1 step の副作用をどう扱ったか）を 4c の最初の実測に入れる。

### DR-MP4-26 authority の失効の観測（確認要 C-15）

legacy の `shouldAbortTurn`（`chatTurnStoreActions.ts:490-498`†、条件は `:423-447`†）の全条件と、Mastra 経路での扱い（案）。main の `assertLive` は forced・user-stop・`profileClosed()`・sender 破棄・identity の 5 条件（`mastraTurnOwner.ts:368-390`†）。

| 条件（legacy） | main が観測できるか | 守り方（案） |
|---|---|---|
| `sendControl.aborted`、`isCurrentTurn` | user-stop は観測できる（`assertLive`†） | 既存の cancel の契約 |
| quiescence の mutation 不可（`canScheduleQuiescenceMutation`） | 未確認（workspace の切替・quiesce は forced で観測するはず） | 既存の forced |
| workspace の切替 | 観測できる（identity。`assertLive`†） | main（既存） |
| project の切替 | **観測できない** | (b) renderer の watcher が cancel |
| chat authority（session、chatScope、scopeAnchorId、thread focus、temporal anchor、preflight authority、route の authority key＝model・endpoint の変更） | **観測できない** | (b) renderer の watcher が cancel |
| **AI policy の chat トグル**（`isAiFeatureBlockedByPolicy("chat")`。作者が AI を切る） | **観測できない**（legacy は `useProjectStore` を見る。`policyGuard.ts:28-35`†）。main は `projects.ai_policy` を DB から読める | (b) watcher に加え、(a) send の直前に main が DB を object の行として読んで判定する案（C-15。新しい authority。永続の窓は K-17） |
| **ライセンス制限**（`isWriteRestrictedByLicense`） | **観測できない**（main が license の状態を持つかは未確認） | (b) watcher |

- (b)：renderer が上記の条件の変化を購読し、`shouldAbortTurn` が真になったら `cancelMastraAgentTurn` を呼ぶ（既存の cancel の契約。新しい契約は無い）。購読の試験を 4c に入れる。
  watcher の強さは cancel の lane に依存する（DR-MP4-27。start と同じ lane で、audit export 中は拒否される）。
- (a) の policy の読みは、`parseAiPolicy` と同じ欠損の扱い（NULL・未設定は full）を共有 module で揃え、別 lane で修正中の `policyAllowsAgentTool` の読み方（行を配列として読む）に依存しない。
- **残る窓**：状態の変化から cancel が main に届くまで、と、(a) を採らない場合の policy の変化から次の send まで。守れない条件は legacy より弱い点として C-15 でユーザーに確認し、脅威モデルに回答どおり書く（4b）。
  renderer の engine 分岐は `blockIfPolicyOff("chat")` の後ろに残る（DR-MP4-19）。
- 場面の切替も、この watcher で cancel する案を C-7 の代案に載せた（切替後の固定による開示のずれを避ける）。

### DR-MP4-27 cancel の lane（確認要 C-14。MP-3 の申し送りの回収）

- MP-3 の wrapper は「start は turn が終わるまで settle せず、cancel と同じ mutation の lane で 4 本ずつ走る。MP-4 は pending start を 4 未満に保つか、cancel に lane を与える」と明記している
  （`src/lib/mastraAgentTurn.ts:12-17`†）。MP-4 では 1 turn が最大 25 step・数分続くので、同時 turn が数本あれば cancel（Stop）が start の後ろに並びうる。
  audit export の凍結中は cancel も拒否される。legacy の Stop はローカルで即時。
- 選択肢：(i) cancel に別の lane を与える（既存の command class の選択か、新しい契約かは回答後に確認）、(ii) pending の start を 4 未満に固定する（sender あたり 4 との整合を取る）。
  audit export 中の cancel の拒否は「Stop が効かない」になるので、許容するか専用の例外にするかも確認する。
- DR-MP4-26 の watcher の強さがこの決定に依存するので、C-14 と C-15 を合わせて回答してもらう。

## 5. PR の分け方

旗 L は全 PR で閉のまま。各 PR は独立に merge でき、独立に戻せる。確認待ちの項目を後ろの PR に寄せる。
**脅威モデルは確定文書**（`mastra-migration-threat-model.md:3`†。変更は新しい確認を要する）なので、
脅威モデルへ書くのは (i) ユーザーが決めた事実（決定 3）と、(ii) ユーザーが回答した確認の内容だけにする。未回答の判断は書かない。

### 4a 契約の 3 欄（承認済みの 3 欄が中心。細部の C-1 が merge 条件）

- 範囲：wire の 3 欄（DR-MP4-1）、owner の Turn、sink の projectId と chatMessageId（DR-MP4-2、23）、default-project の拒否、
  関連 test の fixture（wire／owner／gate／renderer wrapper／runtime bundle／journey の startRequest と、journey test の「seven keys」の件数。未再確認）、
  decisions の記載（第 9.3 節の 4a の分）。DR-MP3-24 の `unsupported` と `invalid` の食い違いを揃える。
- 脅威モデルと計画書：**決定 2・3 に由来する記載だけ**（U-4(f) の延期、U-7 の決定、MP-4 の範囲の読み替え、R-25、D13、T11 の IR の部分、第 6 節 7）。
  この記載は **2026-11-21 の改訂で先に反映済み**（第 9 節）。C-4・C-15 に関わる追記（main が新しい読みの呼び手になること、失効の観測の弱まり）は **4a に入れない**。
- 変えないもの：tool 0・1 step、`parentExecutionId` は null、renderer の分岐は入れない（型の追従だけ）。
- 試験：wire test（key 列挙、issue code、値を echo しない、制御文字の拒否は C-1 の回答に従う）、owner test（`projectId === null` の期待を request の値へ）、
  sink／実 addon の pipeline spec（scope が project chain に入ること）、journey。
- merge 条件：Quick。journey の catalog 自体を触るなら `workload-allocation.json` の digest も更新し、push 前に `verify:quality`（Node 22。K-12）。C-1 の回答。
- 変更後も製品の挙動は不変（旗 L 閉。製品の呼び手は 0）。

### 4b 共有 core と main の read（turn には繋がない）

- 範囲：core と ports（DR-MP4-3）、read 専用への module の分離、main の db adapter（送信前の検査を含む）と typed read の wrapper（DR-MP4-4〜6）、
  read の時点の規則（DR-MP4-5）、hidden・年表の入力の再構築（DR-MP4-8）、IR の静的試験（DR-MP4-21）、tokenizer の port。wire は変えない。tool を turn に載せない。
- `schema.ts` を動かす場合は、同じ PR で `validate-narrative-writers`・`impact-map`・`quality-manifest` の参照先を更新し、未登録の narrative 表を検出できる負の試験を足す（DR-MP4-3）。
- tokenizer の実装（wasm の同梱）は **4b に入れない**。4b は port と試験用の数え値（1 文字＝1 token と、renderer の exact）までで、
  実装は C-8 の回答後に 4c で入れる（init の測定と配線の spike は 4b の中で、build が使えるときに行う。配布物は変えない）。
  spike では main thread の占有（init、大きい読みの結果の整形と数え）も測る（DR-MP4-18、K-16）。
- 試験：legacy の `toolExecutors.test.ts` が core 化の後も通る（結果が変わらない）。実 addon の pipeline spec（`d2aOwnDataRead.pipeline.spec.ts` の型）で同じ fixture DB を renderer 版（invoke の proxy）と main 版（dbExecute の adapter）で比べる。
  最重要の項目：hidden（phase 解除、released の summary・本文・details）、年表 secret の位置フィルタ、XPROJ、barrier なしの差、
  **他 project の `currentSceneId` を渡す fixture**（DR-MP4-8）、adapter の送信前の検査（SELECT 以外で Native を呼ばない。spy）。
- 脅威モデル：**C-4・C-15 の回答の後にだけ**、「main が新しい読みの呼び手になること」「失効の観測が legacy より弱いこと」を、回答の内容どおりに追記する（第 9.2 節）。
  draft の印は、未回答の間は脅威モデルに書かず、この文書の第 8 節だけに置く。
- merge 条件：**C-4 の回答**、**C-7 の回答**、**C-15 の回答**（脅威モデルの追記の前提）、Quick、独立レビュー（第 7 節）。
  P5 の入力（DR-MP4-8）は K-4・K-5・K-17 の解消が前提。`get_foreshadow_detail` の既存の非対称（DR-MP4-24）を PR 本文に書く。
- 製品の挙動は不変：main の新しい module はどこからも呼ばれない。

### 4c loop 規則・tool の接続・engine 分岐

- 範囲：rules module（DR-MP4-12〜16）、step ごとの payload 確定（DR-MP4-25）、authority の観測（DR-MP4-26）、cancel の lane（DR-MP4-27）、
  tool の接続（schema は DR-MP4-17）、tools・結果・進捗の wire（DR-MP4-20）、renderer の engine 分岐（DR-MP4-19）、
  tokenizer の実装（C-8 回答後）、`maxSteps` の上限（導出式。C-3）。
  既存の構造の改訂を含む：
  - `MASTRA_AGENT_TOOL_ALLOWLIST`（MP-3 は空。`agentRuntime.ts:32-45`†）を M4 の 20 名へ。`mastraWorkspaceDisabled` の静的試験と対で固定する。
  - sink の `begin` に親の `executionId` を渡す API（現状は `parentExecutionId: null` 固定。`agentAuditSink.ts:299-302`†）。
  - owner の Turn の `handle`・`response` は 1 回分の欄（`mastraTurnOwner.ts:207-232`）。複数 send にし、start の返り値（`{status:'completed', executionId, response}` の 1 回分）の構造を変える。
    sink の terminal は execution ごとに 1 回（written 集合）なので、完了済みの handle への ambiguous は no-op になる（試験項目）。
- **C-2、C-3、C-5、C-8、C-9、C-13、C-14、C-15、C-16（と、採るなら C-10）の回答まで [precheck] で止める**（C-15 は 4b の脅威モデルの追記の前提でもある）（第 7 節）。
- 試験：第 6 節。
- merge 条件：確認の回答、特性試験が両 engine で緑、独立レビューで P2 以上が解消、Quick。
- 製品の挙動は不変：旗 L 閉、製品の agent-mode turn は宣言集合が M4 に収まらず legacy のまま（journey の seam だけが届く）。

## 6. 受入れの試験

1. **`agentLoop.test.ts` の特性試験を legacy と Mastra の両方に流す**。`runEngine(engine, options)` の 2 実装（legacy は `runAgentLoop`、Mastra は rules module＋fake send＋Agent）を作り、
   `sendToLLM` の履歴と `executeTool` を共通の記録に繋ぐ。現状は `vi.mock` で `contextBuilder` を差し替え、`runAgentLoop` を直接呼ぶ形（describe 7 群・it 25 件。`agentLoop.test.ts`†）で、engine を引数に取らない。Hermes inbound は adapter の route 外なので移さない。
2. **scene の追加**（MP-2 の A〜J に足す）：上限（calls／tokens／questions）、上限後の tool_use、未宣言 tool、バッチ途中の abort、`ask_user` の別枠、大きい error 結果（失敗＋巨大 error 文）、
   バッチで上限を超える呼出し数、窓別の 25／16／12／10。wire の args を JSON の bytes 一致で比べる。追加：
   - 失敗の結果の wire（`isError: true`、`Error: ` の前置、切詰めの後の形）。極小予算（`keepChars` が前置より短い）の端（DR-MP4-13）。
   - abort の 2 通り（loop の先頭＝`finalText` が空、tool の実行後＝直前の応答の text。tokensUsed と record を数えない。DR-MP4-14）。
   - 数え方：`stopReason` が `tool_use` でない応答、上限後の最後の応答の tool_use block を数えない（DR-MP4-12）。
   - step ごとの payload 確定：窓超過の throw、cache から plain への降格（DR-MP4-25。C-13 の回答に従う）。
   - `maxSteps` の上限が legacy の最大 send 数以上であること（DR-MP4-12）。
3. **read の fixture 比較**：実 addon の同じ fixture DB で、legacy 版 core と main 版 core の結果を比べる。hidden、年表 secret、XPROJ、barrier なし、object の行の写像（boolean・timestamp・json の列）。他 project の `currentSceneId`、archived の node、DB が古い読む順。
4. **schema bytes**：M4 の部分集合で TS 側と Rust の wire parity。`$schema`／`additionalProperties` が wire に残らないこと。無変形の入力検証（DR-MP4-17）。
5. **長い履歴・大きい結果**：S6 の未測定。切詰めの比率（`chatAgentToolHandlers.test` の B-T7 の一致固定、未再確認）が main 化後の写しでも保たれること。
6. **静的試験**：IR を閉じたまま（DR-MP4-21）。main の tool の許可集合の凍結と、実行時の wire の名前の照合。read core が SELECT だけ（送信前の検査を含む）。
   core が参照してよい表の allowlist。`NAPI_COMMANDS` を動的 key で引かない。restricted の turn が存在しない。
7. **lifecycle**：read の in-flight の計数、forced と quiesce、tokenizer の init 失敗と single-flight、gate-closed の記憶、admit 後の rejection を再送しないこと。
   `profileClosed()` の 3 状態（restricted／unavailable／activating）、cancel と start の lane（DR-MP4-27）、renderer の watcher が cancel を呼ぶこと（DR-MP4-26）。
8. **並行 turn**：sender あたり 4・全体 8 の turn で、cache と読む順の導出値が turn をまたいで共有されない（DR-MP4-16）。
9. **同値の例外の明記**：切替あり＝固定（DR-MP4-8。C-7）、barrier なし（DR-MP4-9）、cache の単位（DR-MP4-16）、tokenizer の fail-closed（DR-MP4-18）。期待に書き、同値試験の対象から外す。
10. 実行は 4b／4c の各 PR で、変更範囲に応じて `pnpm test:electron`、`pnpm exec tsc -p electron/tsconfig.json --noEmit`、`pnpm electron:build`、実 addon の pipeline spec、`pnpm verify:quality`（Node 22）を選ぶ。
    この起案と改訂では**何も実行していない**。

## 7. GDX-PRECHECK-001

[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)：編集の前に入力・権限・新しさを確認する。前提が欠けたら推測せず `[precheck]` で止まる。
脅威モデルの重要な変更は、ユーザーの確認まで書かない。事前委任は NIR-1 の残レーンだけで、Mastra の lane には及ばない。

| 項目 | 内容 |
|---|---|
| 区分 | 長期・高リスク。信頼境界の変更（main が新しい呼び手）と非同期 lifecycle（read の in-flight、tokenizer の init、cancel の lane）を含む。egress の宛先は変わらない |
| 体制 | integrator 1、実装、候補に触れない独立の受入れレビュー。実装と受入れのレビューは分ける |
| 独立レビュー（この設計文書） | 起案への敵対レビュー（4 観点、2026-11-21。担当は workflow の reviewer）の指摘 47 件（重複を含む）を第 10 節のとおり反映した。**受入れの判定ではない**（改訂後の再レビューは未実施） |
| 独立レビュー（4a） | 未実施 |
| 独立レビュー（4b） | 未実施 |
| 独立レビュー（4c） | 未実施 |
| 脅威モデルの確認 | U-1（脅威モデルの確認と凍結）は 2026-11-19 に確定（計画書の U 一覧）。2026-11-21 の決定 3 に由来する IR 延期の記載だけを反映済み。**C-4・C-15 に関わる追記は未確認のため書いていない**。確認の記録欄：（空） |
| 候補の台帳 | base／head／tree／clean／receipt／確認済みの脅威モデルの版。各 PR の本文に書く |

`[precheck]` で止める点：

- **4a**：C-1 が未了なら `currentSceneId` の型と「整合」の定義、制御文字の拒否を実装しない。
- **4b**：C-4 が未了なら、core と main の db adapter・typed read の実装に入らない（decisions に境界を書くところまで）。
  C-7 が未了なら、barrier と場面固定の差を特性試験の期待に確定しない。C-15 が未了なら、脅威モデルへ失効の観測を書かない。
  budget・閾値の測定で既存の ceiling を超えるなら実装を止めて確認する（C-8、C-16）。
- **4c**：C-2、C-3、C-5、C-8、C-9、C-13、C-14、C-15、C-16 が未了なら、wire の拡張・rules module・`maxSteps` の上限・engine 分岐・cancel の lane・authority の watcher・tokenizer の同梱・main thread の対策に入らない。C-10 は schema の方式を (C) から変えるときだけ。
- **旗 L を開ける前（MP-13）**：C-6（`get_codex_entry`）、C-11（`get_foreshadow_detail` の secret）、help と UI 系の RPC（U-8、C-12）。
- 重いコマンド（build、test、Electron）は、実行前に資源の空きと競合する run を確かめる（[CI runner](../local-ci-runner.md)）。

## 8. ユーザー確認が要る点

### 8.1 確認要（委任の外）

| ID | 内容 | 推奨 | 止まる点 |
|---|---|---|---|
| C-1 | 3 欄の細部：(a) `currentSceneId` は場面なしを許す（`string \| null`）か。承認文は「非空」で、非空への限定からの変更になる。値の出所（preflight の `activeSceneId`。空文字は null に写す）も確認。(b) 「turn 内の整合」の定義（3 欄を start で 1 回束ねて不変にする、の意でよいか。chatSessionId・messages との照合を含めない）。(c) 形式検査の細部：既存の `isTrimmedId`（trim 済み・200 字以下）を新 3 欄にも適用し、Native の trim と JS の trim の差（未実測）を避けるため制御文字（C0／C1、U+2028／2029）を invalid にしてよいか。長さの上限は決定 1 の文言に無いが、既存の定数の再利用で新しい閾値ではない | (a) null 可、(b) 束ねて不変、(c) 再利用＋制御文字の拒否 | 4a |
| C-2 | 新しい契約：(a) tools の wire の形（**推奨：名前の list だけ。定義は main が持ち、名前が M4 の凍結集合に無ければ unsupported で拒否**）、(b) 結果と進捗の wire（`toolCallRecords`、`stoppedReason`、累計 usage、`citations`、`finalThinkingBlocks`、連結 text、`onProgress`、send ごとの accepted／finalize の通知、Stop 時の途中 text 等）。承認済みの 3 欄の外 | (a) は名前だけ。(b) は回答後に起案 | 4c |
| C-3 | loop 規則の入力：(a) `tokenBudget`・`maxToolCalls`（窓から算出）と制御 message 3 本、UI 言語を wire で渡すか、main が再計算するか。main が値を検査する値域の設定は閾値の新設に当たりうるか。数値は現行の関数のまま変更しない。(b) 上限到達の判定の入力（窓・出力予約）は C-13 と同じ欄。(c) **`maxSteps` の上限**：legacy の最大 send 数から導く式（`maxToolCalls＋maxUserQuestions`。DR-MP4-12）であり、legacy の停止より先に働かないことを特性試験で固定する。これを新しい閾値と数えるか | (a) renderer が計算済みの値を渡す。(c) 導出式であり新設でないと扱い、試験で固定 | 4c |
| C-4 | main が `dbExecute` と typed read の新しい呼び手になること（JS gate を通らない、Native が最終 authority、unrestricted に Native 側の read-only の強制と pin が無い）を新しい authority と数えるか。数えるなら脅威モデルの改訂を確認する。あわせて authority 喪失時に model へ返す内容（DR-MP4-14）。Native に事前の read-only 強制や pin、main 用の `SqlOrigin` を足す案は新しい契約なので既定では足さない。補いは JS の adapter の**送信前の検査＋事後検出＋静的試験**（DR-MP4-4）。失効の観測は C-15 | 送信前の検査＋事後検出＋静的試験で足りる | 4b |
| C-5 | 範囲の読み替えの帰結：決定 2 により MP-4 の間は main の tool が 44 本そろわない。判定は宣言集合の包含になるので、**製品の agent-mode turn は MP-4 の間 1 本も Mastra に届かない**（journey の seam だけ）。「残りを使う turn を legacy に落とす」を、tool を使わない turn は Mastra に届く含みで読む場合は、宣言集合では判定できない（turn の開始時に model がどの tool を呼ぶか分からない）ので、その読みを採らないことの確認。model に見せる tool を減らして収める案は利用者に見える挙動の変更なので採らない | 帰結を承認（新しい承認要求ではなく、決定 2 の帰結の確認） | 4c（帰結が決定の含みと違う場合だけ止める） |
| C-6 | `get_codex_entry` の guard：wire に `fullyInjectedIds` を足す／guard なしで全文を返す（結果と token が変わる）／main の集合から外す。MP-4 は外す | MP-13 までに決める | MP-13 |
| C-7 | 同値の差の受容。**ADR 013（hidden と年表 secret は「どの経路でも渡さない」。`docs/adr/013-ai-disclosure-policy.md:9`†）に対して、legacy より保護が弱くなる窓**を含む：(a) 場面切替後は turn 開始の場面で固定（legacy は authority の検査で abort しうる。後ろの場面へ切り替えた場合は開示が狭い側、**前の場面へ切り替えた場合は開示が広い側**にずれる）、(b) DB が古い窓（`resolutionMode`、tree の並びの未保存の変更。DB が古いと作者の画面より多くを解除する向きにずれうる）、(c) barrier なし（DR-MP4-9）、(d) batch の途中で tree が変わっても main は再計算しない（legacy は nodes の参照が変われば再計算する）。緩和：turn 開始前の flush を Mastra の分岐だけに置く。代案（新しい契約なし）：renderer が場面切替時に Mastra の turn を cancel する（DR-MP4-26 の watcher） | 緩和（flush と watcher）を入れた上で、残る窓を受容。特性試験に明記 | 4b |
| C-8 | tokenizer：(a) wasm（約 1.07 MB）と ranks（約 2.3 MB）を配布物に同梱すること（配り方は DR-MP4-18 の 3 案）、(b) main.cjs の byte・init 時間の budget を新設するか、(c) exact を保ち init 失敗は fail-closed（heuristic に落とさない）でよいか。**既存の perf budget・ceiling は緩めない。超えたら実装を止めてユーザーに確認する**（`schema.ts` の移動による renderer の起動 graph の ratchet への影響も同じ） | (a)(c) 進める。(b) 新設しない。budget は緩めない | 4c（同梱の実装） |
| C-9 | 未宣言 tool：Mastra の既定（使える tool の一覧を model に返し、record と `onToolComplete` が出ない）を受容するか、自前の拒否 tool で legacy と同じ文言（`Error: Tool not available this turn: <name>`、`isError: true`）と record を再現するか | 再現する | 4c |
| C-10 | tool の入力検証：生の JSON Schema（Ajv の検証を新設）にするか。推奨は自前の StandardSchema（検証なし）で、確認は不要の見込み | 検証なし（(C) 方式） | 4c（変えるとき） |
| C-11 | `get_foreshadow_detail` が secret を落とさない既存挙動が、PUB-G の方針として意図どおりか。MP-4 は同値で写し変えない。**4b の PR 本文と脅威モデルの未確認事項に「main の経路にも既存の非対称がある」と書き、回答を旗 L を開ける前の条件に入れる** | 同値で写す | 旗 L を開ける前（MP-13） |
| C-12 | help 2 本を RPC（MP-5）に寄せ、MP-5 の renderer の tool を 6 本から 8 本にする記載の変更（計画書の第 3.1 節の表・MP-5 の範囲・U-8 は、回答後に追従する） | 承認 | MP-5 |
| C-13 | **step ごとの payload 確定**（DR-MP4-25）：legacy は send ごとに窓超過の検査（throw）と cache から plain への降格を行う。Mastra 経路では、(i) 窓・出力予約・fallback の system などの欄を wire に足して main の send tap で同じ確定を行う（新しい契約と閾値の取り扱い）、(ii) この検査と降格が無いことを受容する（長い turn で窓超過の request をそのまま送る。閾値の黙示変更）。どちらも委任の外 | (i)。形は C-2 と一緒に決める | 4c |
| C-14 | **cancel の lane**（DR-MP4-27）：MP-3 の wrapper は start と cancel が同じ mutation の lane（4 本ずつ）で、audit export の凍結中は cancel も拒否される。MP-4 の長い turn で Stop が start の後ろに並びうる。(i) cancel に別の lane を与える（既存の command class の選択か新しい契約かは回答後に確認）、(ii) pending の start を 4 未満に固定する。audit export 中の cancel の拒否（Stop が効かない）を許容するか専用の例外にするか | (ii) と、export 中の拒否は例外を設ける案を比較して回答 | 4c |
| C-15 | **authority の失効の観測**（DR-MP4-26）：legacy の `shouldAbortTurn` の条件のうち main が観測できないもの（project、chat authority、AI policy の chat トグル、ライセンス）を、(a) main が DB を読んで send の直前に判定する（policy のみ。新しい authority）、(b) renderer が状態の変化を購読して cancel を呼ぶ（既存の cancel の契約）のどちらで守るか。守れない条件と残る窓（cancel の到達まで）は legacy より弱い | (b) を基本に、policy だけ (a) を併用する案を回答 | 4b（脅威モデルの追記の前提）／4c |
| C-16 | **main thread の占有**（DR-MP4-18）：tool の実行と tokenizer の数えが Electron main の event loop に移る。測定（4b の spike）の結果、対策（結果の長さの先頭の cap、分割と yield、別 thread）が閾値の新設に当たる場合の確認。当たらない対策だけなら確認は不要 | 測定の後に回答 | 4c |

### 8.2 未確認の事実

| ID | 内容 |
|---|---|
| K-1 | send tap で `args.messages` の末尾に user message を足した wire の bytes。`prepareStep` で messageList に足した場合の順序と `createdAt` による並べ替え |
| K-2 | `maxSteps` の上限（導出式 `maxToolCalls＋maxUserQuestions`）が、Mastra の step の数え方（最後の応答の step を含むか）で legacy の最大 send 数を覆うか。（`stopReason` が `tool_use` でなく tool_use block がある応答は、adapter が tool-call を出さないので問題にならない。`agentLanguageModel.ts:670-672` の読解） |
| K-3 | Mastra の tool 実行が `abortSignal` をバッチの途中でどう見るか。legacy の場面切替が authority の検査で次の tool 前に必ず abort されるか（scene scope の persisted session では `activeSceneId` の変化だけでは abort せず、場面切替が `activeSessionId` の変化を伴うかが未確認）。abort 後の `finalText` と `onTextChunk` |
| K-4 | tree store の nodes と DB の `tree_nodes` の完全一致、`buildReadingOrder` の `localeCompare` の Chromium と Node の差、`sceneTimeIndex` の DB からの再構築 |
| K-5 | `projectMetadataWriteQueue` の debounce の長さ。`resolutionMode` と tree の並びの store から DB までの窓。chat store と tree store の `activeSceneId` と `projectId` の常時一致（起動直後と project 切替） |
| K-6 | 実 addon で main から `dbExecute` に identity を渡したときの挙動（napi が非 enumerable の値を落とすか。MP-3 の K と同種）。全 select（boolean・timestamp・json の列）での renderer 経路との一致。（Drizzle の method `get` の期待形は、`sqlite-proxy/session.js` の読解で「1 行の平らな配列」と確定した。DR-MP4-4） |
| K-7 | tokenizer：Electron main での動作・init 時間・event loop の塞がり、asar 内の読込、esbuild への binary の埋込みと main.cjs の parse コスト、`encode()` の特殊 token での挙動 |
| K-8 | sink の `operationId` を turn UUID に揃えたときの影響（usage 台帳の鍵）。（legacy の `chatMessageId` が turn 内で一定かは、`assistantMsg` が turn に 1 つで `:1188`†・`:1277`† が同じ `assistantMsg.id` を使うので**一定と確認した**） |
| K-9 | hermes の turn を adapter が扱えるか。添付つき turn が他の入口で agent 経路に流れないか。public web search 経路の privacy 分離 |
| K-10 | `schema.ts` の import 閉包（静的に数えた一覧は DR-MP4-3）、electron の tsconfig（NodeNext、lib は ES2023）で compile できるか、bundle と起動への影響。（参照する script・test は確認した：`validate-narrative-writers.mjs:216-228`†、`impact-map.yaml:771`†、`quality-manifest.yaml:1608,1657`†） |
| K-11 | Mastra の入力検証が実際の 44 本（`ask_user` の入れ子、配列 9・enum 8・minimum 1）で無変形か。ai の `jsonSchema()` が無検証になる機構 |
| K-12 | `product-journey-catalog`／`workload-allocation` の registryDigest が wire と journey script の変更で動くか |
| K-13 | `run_research` を将来 main に移すときの子 loop の置き場（audit の parent の連鎖、usage、進捗） |
| K-14 | 同一 step の複数 tool call を Mastra が並列に実行するか（legacy は直列。`toolCallConcurrency: 1` は固定済み） |
| K-15 | MP-3 の台帳の分類（`get_global_settings`、`get_license_state` の class）。（ADR 013 の原文は `docs/adr/013-ai-disclosure-policy.md:9`† で確認した：hidden と年表 secret は「どの経路でも渡さない」） |
| K-16 | main thread の占有：大きい project での読む順の構築、大きい結果の整形・`JSON.stringify`・`countTokens` が Electron main の event loop を塞ぐ時間。model の入力が決める量（巨大な `limit`、配列）を含む。SQL 側の資源上限（`RENDERER_VDBE_OP_LIMIT` 系）は JS の処理を覆わない |
| K-17 | AI policy の chat トグルの store から DB（`projects.ai_policy`）への永続の窓。legacy は `useProjectStore`（`policyGuard.ts:28-35`†）を見る。main が DB を読む案（C-15(a)）は、この窓の分だけ renderer の判定より遅れる |
| K-18 | Mastra が tool の throw を error-text にするときの `value` の形（message のまま渡るか）。MP-3 の start が send ごとの renderer 側の副作用（`retirePriorCapture`、`notifyAccepted`、`agent-running` への遷移、context usage の更新、入力 token の drift の集計）をどう扱っているか（4c の最初の実測） |
| K-19 | 形式検査：JS の `trim` と Rust の `trim` の空白集合の差（U+0085 は Rust の `trim` が除くが JS の `trim` は除かない、という指摘。未実測）。ずれた値が admit の後に audit の begin で失敗するか |

## 9. 計画書と脅威モデルで直す記載

起案時に `grep -n` で行を確かめた。2026-11-21 の改訂で、**決定 1〜3 に由来する記載**を計画書と脅威モデルに反映した（「反映済み」）。
行番号は反映後の `mastra-migration-plan.md`（885 行）と `mastra-migration-threat-model.md`（491 行）による。
未回答の確認（C-4、C-15 など）に由来する記載は反映していない（「後続」）。

### 9.1 `docs/plans/mastra-migration-plan.md`

| 行 | 現状 | 直す内容 | 状態 |
|---|---|---|---|
| 74 | 「S6 の bytes 比較は spike 基点。MP-2・MP-4 でやり直す」 | MP-4 の再測定が M4 の部分集合であること | 後続（4c） |
| 352 | 「chat IR S1 は全 launch で閉。loop が main に移ると受け手が変わる。U-4 で再確認する」 | U-4(f) は IR を開ける lane へ延期。MP-4 でも閉。静的試験で固定 | 反映済み |
| 359-363 | 範囲：manifest の 44 本を Mastra の tool に | **段階に読み替え**：MP-4 は read の M4（20 本。`get_codex_entry` は C-6 待ち）。MP-5 は `ask_user`・`get_ui_state`・help 2 本・UI 系 4 本の 8 本、MP-6 は残りの write 14 本、`run_research` は移さない。内訳の合計は 44。製品の turn は MP-4 の間 Mastra に届かない | 反映済み |
| 367 | 範囲に「`beginAgentToolTurn` の turn 単位の分離」 | DR-MP4-16 の根拠。turn ごとの instance にし、`chronicleToolCache` の singleton と reset の登録表も対象 | 後続（4c） |
| 370 | `run_research` の子は `run_research` を持たない、audit は `agent_research_subagent`（U-4(e)） | MP-4 では移さない旨を反映済み。MP-13 までに扱いを決める | 反映済み |
| 374-376 | 「移す方式は未決（U-7）」「`countTokens` が main で動くかは未確認」 | U-7 は (D) 混合で決定。tokenizer は未確認のまま、置き場と配布は DR-MP4-18・C-8 を指す | 反映済み |
| 377 | 「N-API は、read 用の command が要るなら新設」 | 新設しない | 反映済み |
| 378-383 | 条件（特性試験、schema の bytes、入力検証、fixture 比較、長い履歴） | 入力検証の基準を「無検証・無変形」に（DR-MP4-17）。engine を引数にした特性試験（第 6 節）。step ごとの payload 確定（DR-MP4-25）を条件に | 後続（4c） |
| 385 | 「確認：U-7」 | U-7 は決定済み。確認は第 8 節 | 反映済み |
| 163、391、406、645 | MP-5 の UI tool は 6 本（第 3.1 節の表、範囲、write 系 15 本との重なり、U-8） | help 2 本を足して **8 本**（C-12）。391 に案を注記済み。163・406・645 は C-12 の回答後に追従 | 一部反映済み／後続（MP-5 の前） |
| 587-588 | U 一覧：U-4（loop 移動の未決一式）、U-7（read tool の main 化の方式） | U-7 は決定済み | 反映済み |
| 637 | 「推奨：main chat だけを先に（Q2）。ただし子 agent の扱いは MP-4 で決める」（(e) の末尾） | 子 agent は MP-4 では移さず、MP-13 までに決める（DR-MP4-22）に読み替え | 後続（4c） |
| 638 | 「(f) chat IR S1 の確認済み脅威モデルの再確認」 | 延期（IR を開ける lane） | 反映済み |
| 644 | 「U-7：新しい N-API の read command が要るか。tokenizer の置き場」 | 決定：不要。tokenizer の置き場は DR-MP4-18 | 反映済み |
| 759 | R-18（tool schema の変形後の入力検証、null・truncation）未測定 | 「legacy は無検証。(C) 方式で無変形。probe 済み（合成 schema のみ）。実 44 本は 4c」に更新 | 後続（4c） |
| 760 | R-19（loop 規則の同値）未測定 | 写し方（案）と特性試験の追加を記す。Mastra の挙動は 4c の最初の実測で確定 | 後続（4c） |
| 766 | R-25（chat IR の脅威モデルが renderer の loop 前提） | 延期（IR を開ける lane）。MP-4 は静的試験で閉を固定 | 反映済み |
| 772 | R-31（tokenizer が main で動くか）未確認 | plain Node の probe で動作（約 163 ms）。Electron main・asar・配布は未確認 | 反映済み（注記のみ。状態は未確認のまま） |

### 9.2 `docs/plans/mastra-migration-threat-model.md`

| 行 | 現状 | 直す内容 | 状態 |
|---|---|---|---|
| 268 | T11：loop が main に移ることで capability と chat IR S1 の脅威モデルの前提が落ちる（MP-3〜MP-6） | IR は延期（MP-4 は閉で固定）を反映。capability は MP-6 のまま | 反映済み（IR の部分だけ） |
| 294 | D13：capability の維持。chat IR S1 の確認済み脅威モデルの再確認（U-4(f)） | (f) を「延期。MP-4 は静的試験で閉を固定」に | 反映済み |
| 484 | 第 6 節 7：新しい `PrePublicationEntry` が新しい authority か。chat IR S1 の再確認（U-4(f)） | (f) を延期に | 反映済み |
| 新しい行（案） | - | **main の読みの呼び手**（`dbExecute` と typed read を main が直接呼ぶ。JS gate を通らない、Native が最終 authority、unrestricted に Native 側の read-only の強制と pin が無い、restricted の turn は無い）。T4 に混ぜず新しい行にする。read の `settle` は slot の計数だけに使い、永続化の終了証跡ではない（D11 の「`settled()` は証跡にしない」と区別） | 後続（4b、C-4 の回答の後） |
| 新しい行（案） | - | **失効の観測**：main は project・chat authority・AI policy・ライセンスの変化を観測できず、legacy の `shouldAbortTurn` より弱い。守り方と残る窓は C-15 の回答どおり | 後続（4b、C-15 の回答の後） |
| 261（T4） | 場面の phase の先の情報の漏れ（memory の phase 先の漏れ。X1・X5・X7） | **read tool の入力は T4 に混ぜない**。hidden・年表 secret の入力（DR-MP4-8）は上の新しい行で扱う | 後続（4b） |
| 266（T9） | tool 結果に混ざる指示文 | MP-4 でも tool 結果は model への入力。wire の経路は legacy と同じ。変更なし（確認のみ） | 後続（4b） |

脅威モデルの ID は、この lane の T1〜T12 と、NIR-1 の S1-B の脅威モデルの T1〜（別の文書）が衝突する。
この文書では「S1-B の T2、T3」と書いたものは NIR-1 側を指し、この lane の T3（restricted・非 agent chat での memory の読み書き）とは別。

### 9.3 `docs/plans/mastra-mp3-decisions.md` への申し送り（この起案の一覧の外。編集は各 PR）

| 行 | 現状 | 直す内容 | PR |
|---|---|---|---|
| 136 | DR-MP3-23：parent は null（tool 0） | 複数 step では前 step の `executionId` を連鎖（4c。sink の API と owner の Turn の複数 send 化を含む）。`operationId` の扱い（K-8） | 4c |
| 260-264 | DR-MP3-24：「送るだけ差し替え」「tools 非空は unsupported」 | MP-4 では `runAgentLoop` 全体（step ごとの payload 確定を含む。DR-MP4-25）。tools 非空は実装が invalid なので揃える | 4a |
| 322 | DR-MP3-27：「確認要（MP-4 の前）：wire の projectId」 | **決定済み**（2026-11-21、決定 1）に更新。書き先は project の chain | 4a |
| 340-348 | DR-MP3-28：runtime に入れるのは Agent・adapter・方針だけ | closure は main 側。tokenizer の置き先を改訂するなら記録（DR-MP4-18） | 4c |
| `agentRuntime.ts:32-45` | `MASTRA_AGENT_TOOL_ALLOWLIST`（空）。DR-MP3-14 の 2 層目 | M4 の 20 名へ（意図した改訂。静的試験と対） | 4c |
| `src/lib/mastraAgentTurn.ts:12-17` | start は turn の間 settle せず、cancel と同じ lane（4 本ずつ）。「MP-4 は pending start を 4 未満に保つか cancel に lane を与える」 | DR-MP4-27、C-14 で回収 | 4c |

## 10. レビューの記録

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
