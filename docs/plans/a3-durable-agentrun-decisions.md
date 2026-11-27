# A3：durable な AgentRun と確認待ち、途中からの再開（F0-lite・R1 を含む）の判断記録

- 状態：**草稿・第 2 版（2026-11-27）**。範囲の拡張（第 7 節）と、第 8 節のすり合わせを入れた。改訂版の独立レビューが済むまで、製品コードを変えない（[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)）。
- 担当：A3 の lane（grimodex-59）。統合者「統合」の引き継ぎ（2026-11-27）による。
- 根拠のユーザー決定：
  - 問 10（2026-11-26）：A3 は「新しい lane で実装まで」。
  - 問 11〜13（2026-11-27）と、範囲の拡張の発言、拡張の保存の中身の 4 問（第 7 節）。
  - 記録は `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/`（問 11〜13 は `0de2aed37`）。
- 委任：この lane は NIR-1 の残レーンではないので、AGENTS.md の事前委任は及ばない。
  - 問 10 が委ねた「起案から実装まで」の技術判断は、この文書に記録する。
  - 保存の範囲、新しい authority、DR-MP5-11 と W12 の変更は、第 7 節の回答の範囲の内側でだけ行う。
- 正本：
  - [agent-collaboration-roadmap.md](agent-collaboration-roadmap.md) の F0-lite・R1・A3。
  - [ADR 007](../adr/007-agent-collaboration-execution-boundary.md) §2〜§5。
  - [ADR 008](../adr/008-agent-default-mode-and-write-approval.md) §4・§5。
  - [SessionTasks の判断](session-tasks-decisions-2026-11.md)。
  - [MP-5 の判断](mastra-mp5-decisions.md) の DR-MP5-11、[脅威モデル](mastra-migration-threat-model.md) の W12。

## 1. 範囲

- 含む：
  - F0-lite のうち A3 が使う型：`TransportExecutionHandle`、`AgentRunStatus`、`AgentRunInteractionStatus`、`ExecutionAuthority`、`ProjectionAttachment`。
  - R1：legacy の API と CLI の stream の handle を、detach／cancel／result に分ける。
  - A3：Run と Interaction の durable な記録、中断の検出と回収、起点の会話での再表示。
  - **A3 の拡張（2026-11-27）**：中断した Run を、保存した途中の状態から、読み直しなしで同じ Run として再開する（以下「途中再開」）。
- 途中再開の対象の経路：
  - **legacy の API の agent loop**：画面の agent loop で、今の本番の経路。A3 が持つ。
  - **Mastra の経路**：今は画面からつながっていない。段ごとの message の保存は MP-9 が持ち、A3 は Run・Interaction と再開の判断を持つ（DR-A3-8）。
  - **CLI と Codex App Server**：途中再開しない。中断として記録し、画面には「続けられない」と出す。理由は次のとおり。
    - CLI は provider 側に続きが無い。
    - Codex App Server は、確定した turn の後からしか続けられない設計（`manager.ts:54-57` の pending sentinel）。
- 含まない：
  - R0（CLI の timeout）。A3 の State は「R1 と F0-lite の state contract で Blocked」で、R0 は前提に入らない。
  - A4a 以降（Background Session、UI の全体、hardening）。
  - Gate A（A1・A2。担当は Mastra）。
  - Release B の部分：子の Run、grant の受け渡し、Task の表。
- F0-lite のうち `WorkTaskStatus`・`minimal TaskContractSnapshotV1`・`AnalysisReadBasis*` は、Release B に回す（DR-A3-13）。

## 2. 確かめた事実（基点 origin/master `c063a0803`）

### 2.1 保存と schema

- schema の版は 48（`grimodex-core/src/lib.rs:3`）。
  - 版ごとの migration は、`grimodex-db/src/migrate.rs` の `migrate_impl` に `if current < NN` の区画で足す。
  - CED/1 が 49 を取る。A3 は、merge の直前に、次に空いている番号を確かめて取る（統合者）。
- 今の保存は、完了した turn の分だけ：
  - `chat_messages`：user と assistant の本文。
  - assistant の行の `metadata.tool_calls`：name、params、resultSummary（要約）、tokensUsed。
  - `thinking_blocks`。
  - `chat_message_prompts`：送った system prompt の snapshot。
  - 書くのは画面の Drizzle で、turn の完了の時点（`chatTurnStoreActions.ts:1149-1215`）。
- turn の途中の状態は、どこにも永続化されていない。
  - 対象：AI の出力、tool の結果の本文、未解決の確認待ち、loop の計数。
  - 途中の状態は、memory の Zustand と loop の局所の変数にあるだけ（`chatTurnStoreActions.ts:1077-1095`）。
- `mastra_message_parts` は、tool の結果を sha256 の digest に置き換えて保存する（`mastra_memory.rs:954-1007`）。今は turn の途中には書かない（MP-9 から）。
- AI Audit（`ai_audit_events`）：
  - 追記だけの hash chain で、会話や作品の削除に追随しない（forward-only）。
  - 再開の状態の置き場には使わない。使うと、会話の削除の後も本文が残る。
- 会話の削除は `chat_sessions` の削除で、子の表は FK の cascade で消える（`chat_typed_writes.rs:328,346`）。
- OCC と冪等性の既存の形：
  - OCC：`WHERE id=? AND version=?`（`plot_threads.rs:1502`）。
  - 冪等性：`idempotency_requests` と `run_atomic_create`（`idempotency.rs`）。
- 起動時の回収の前例は `post_effect_runs` だけ（`migrate.rs:8854`）。
- standalone MCP も同じ DB を開く（`grimodex-mcp/src/lib.rs:75` の共有 lease）。
- DB は、アプリの起動時ではなく `open_workspace` で開く（`electron/main/ipc.ts:2533`）。
- dev 版と packaged 版は、単一起動の lock が別（`electron/main/userData.ts:156-166`）。同じ workspace を 2 つの main が開きうる。

### 2.2 経路

- **本番の turn**：画面の `runAgentLoop`（`chatTurnStoreActions.ts:65,968`）が `sendAgentMessage`（`chatApi.ts:164`）を呼ぶ。
- **Mastra の経路**：`startMastraAgentTurn` の呼び手は、試験の外には無い（未接続）。
- **legacy の loop の状態**：
  - messages は純 JSON。
  - `runAgentLoop` の `options.messages` から、途中の会話を渡して入り直す入口がある。
  - 計数を注入・取り出しする継ぎ目は無い。計数は totalCalls、userQuestionCalls、totalTokens、limitMessageInserted、toolCallRecords、citations、cost。
  - 送信・tool 実行・route・abort の closure は、約 2,470 行の send の関数の中にある。
- **保存できる切れ目**は「その step の tool の結果がすべてそろった時点」と、「ask_user の保留の時点」。
  - ask_user の保留の spec（`PendingUserQuestion`）は純 JSON。
  - 同じ batch で先に終わった tool の結果は、局所の配列にある。
- **turn の開始時に一度だけ決まる値**：system prompt、Codex の注入、route、tools、tokenBudget。
- **hidden と Phase の判定**：prompt を組むときと、tool を実行するときの状態で決まる。
- **変更系の tool の冪等性**：`requestId = agent-tool:sha256(tool\0project\0toolCallId)` が決定的で、Rust の `idempotency_requests` で二重にならない。
  - 冪等の台帳が無い tool がある：`run_app_command`、`apply_layout_preset`。
- **capability**：main の memory にあり、TTL 5 分・一回限り。provider の応答の tool_use に結び付く（`agentLoop.ts:271-276`）。再起動で消える。
- **検査の時点**：chat の policy と profile の egress は送信のたび、license は turn の preflight だけ。
- `requiresUserConfirmation` は manifest の宣言だけで、実行時に読む箇所は無い。

### 2.3 合意と材料

- **Mastra の担当（2026-11-27）**：
  - Run の記録は `mastra_*` と別の表に置く。
  - 段ごとの message の正本は MP-9 が持つ。A3 は、未解決の 1 件と再開の判断を持つ。つなぎは `turn_id` と `tool_call_id`。
  - Mastra の suspend／resume と snapshot は使わない。再開は、保存した message の列から新しい `generate()` を呼ぶ形で、未実証。
- **SessionTasks の担当の材料（DR-ST-1、Haiku 5.5、各 3 本）**：
  - 前の回の tool の結果を全部残す形（arm4）は、読み直しを 0 にした。
  - 一方で、検出は 9 件中 3 件（今の方式は 7 件）に下がった。
  - 3 本中 2 本は、入力が約 11 万 token になったところで、thinking だけで上限に達する回を繰り返した。
  - 途中再開は「同じ turn の中」の結果だけを戻すので、arm4（turn をまたいで残す）とは形が違う。それでも測定は入れる（DR-A3-12）。

## 3. 判断（案）

### DR-A3-1 置き場所と authority（問 13、条件つきの承認）

- grimodex-db に新しい module（`agent_runs.rs`）と、表 2 本（`agent_runs`、`agent_run_interactions`）を置く。Run と Interaction、途中再開の状態の唯一の正本にする。
  - 途中再開の状態は、`agent_runs` の列に持つ（DR-A3-4）。表は 2 本のまま。
- D2a closed で、generic SQL を通さない。
  - 書くのは typed N-API（main 専用）だけ。
  - renderer は typed の IPC で読み書きを頼む。main は、行の束縛（DR-A3-5）を照らしてから Native を呼ぶ。
- ADR 003 の手当ても同じ PR に入れる：
  - Drizzle parity の native-only の allowlist。
  - schema-contract の再生成。
  - D2a の台帳の写し（`electron/main/d2aSqlPolicyFixture.ts`）。
  - 件数の試験（`execute.rs`・`own-data-read.test.mjs`）。
  - CI でだけ走る `d2aOwnDataRead.pipeline.spec.ts` を、`napi:build` の後に手元で回す。

### DR-A3-2 Run の列と状態

- **列**：
  - ID：`run_id`（main が発番）、`root_run_id`（v1 では自分）。
  - 対象：`project_id`、`chat_session_id`、`turn_id`、`origin_message_id`（起点の user の行）、`route`（legacy｜mastra｜cli｜codex_app）。
  - model の snapshot：provider の ID と model の ID だけ。API の key と endpoint は保存しない。再開のときは、今の設定から引き直す。
  - 実行の権限：`execution_owner`（DR-A3-5）。
  - 状態：`status`、`terminal_reason`、`interrupt_reason`、`version`（OCC）。
  - 時刻：`activity_at`、`created_at`、`updated_at`。
  - AI Audit とのつなぎ：別の表に持たず、Audit の側の `operation_id` に `run_id` を入れる形で、1 対多をたどる（C7）。実装の前に、Audit の payload の宣言の範囲で入れられるかを確かめる。
  - Release B 用に今は空で置く：`continuation_of`、`task_id`。
- **status は 8 つ**：
  - 非終端の 4 つ：`running`、`waiting_user`、`waiting_approval`、`interrupted`。
  - 終端の 4 つ：`completed`、`failed`、`cancelled`、`discarded`。
  - `interrupted` は**非終端**で、途中再開の候補。作者が捨てると `discarded`。
- **terminal_reason と status の対応**は、CHECK で固定する（C2）：
  - `completed`：`completed`、`limit_tokens`、`output_truncated`、`context_window_exceeded`。
  - `failed`：`provider_error`、`record_failed`、`timeout`。
  - `cancelled`：`user_stop`、`policy_revoked`、`license_restricted`、`permission_denied`、`authority_lost`。
  - `discarded`：`discarded_by_author`、`superseded_by_new_turn`。
- **interrupt_reason**：`app_shutdown`、`renderer_lost`、`workspace_switched`、`resume_blocked`。`resume_blocked` は、再開の検査で止まったときに使う（DR-A3-6）。
- **一回性**：
  - 終端の記録は「非終端であること」と version の両方を条件に、一度だけ（C3）。
  - `activity_at` の更新は version を上げない。

### DR-A3-3 Interaction

- **列**：
  - ID と対象：`interaction_id`、`run_id`、`root_run_id`、`chat_session_id`。
  - 種類：`kind`。
  - 呼出し：`tool_call_id`、`tool_name`、`args_digest`。
  - 中身：`request`（表示文。上限の長さを置く）、`resolution`（作者の回答）。
  - 状態：`status`、`version`。
- **kind**：
  - `user_question`（ask_user）と `approval`。
  - `plan_amendment` と `permission` は、値だけ予約する。
  - Mastra の UI 系 6 本（10 秒）は記録しない（C6）。
- **status**：`pending`、`resolved`、`cancelled`、`expired`、`superseded`。
- **pending の制約**：`root_run_id` ごとに 1 件まで（部分 unique index）。Run の `waiting_*` と Interaction は、同じ tx で変える。
- **resolution の一回性**：OCC と冪等性の key で一度だけ。
- **approval の分担**：列の形は ADR 008 §5 に合わせる。
  - A3 が持つもの：durable な Interaction。
  - Gate A が持つもの：交換の authority。Gate A の承認要求は `interaction_id` を参照する。
  - canonical args などの列は持たず、digest だけを持つ（C8。保存の範囲は表示文と回答に限る）。
  - ADR 008 の状態との対応：
    - approved／rejected → `resolved`。どちらかは resolution に書く。
    - expired → `expired`。
    - superseded → `superseded`。
    - executed は、Gate A の交換の記録の側に置く。

### DR-A3-4 途中再開の状態（checkpoint）

- **置き場所**：`agent_runs` の列 `checkpoint`（JSON）、`checkpoint_step`、`checkpoint_digest`。1 つの Run に 1 つで、切れ目ごとに上書きする。
- **中身**（問「残す中身」の回答による）：
  - その turn の中の、provider に依らない形の message の列：
    - assistant の text・tool_use。
    - thinking と署名。
    - tool_result の本文。
  - loop の計数：totalCalls、userQuestionCalls、totalTokens、limitMessageInserted、toolCallRecords、citations、cost。
  - 未解決の ask_user の spec（あるとき）。
  - 読んだものの basis：tool_result ごとに、読んだ source の種類・ID・版（または内容の hash）。
- **中身に入れないもの**：
  - system prompt、Codex の注入、tools の manifest、route。再開のときに今の状態で組み直す。
  - API の key、endpoint。
  - hidden の項目の本文。tool の実行の時点で除かれるので、tool_result に入らない。
- **書く時点**：
  - その step の tool の結果がすべてそろった時点。
  - ask_user の保留を開いた時点。同じ batch で先に終わった tool の結果も含む。
- **書く経路**：画面の loop が typed の IPC で送り、main が束縛を照らして Native に書く。
  - 書けなかったときは、その Run を途中再開の対象から外す（`resume_blocked` の印）。生成は止めない。
  - 記録の失敗で、作者の作業を止めないため。
- **生成の途中で落ちたとき**：
  - 最後の切れ目から再開し、その切れ目の後の生成をやり直す。
  - 途中まで出ていた出力は失われる。provider への送信と費用は、もう一度かかる。
- **大きさ**：tool の結果の累計は、今の `limit_tokens`（文脈の窓の 30%）の内側にある。checkpoint の上限は、文脈の窓から決める。

### DR-A3-5 実行の権限、束縛、中断の検出と回収

- **execution_owner**：main の起動ごとの ID と、workspace を握った世代。
  - main は、workspace ごとに owner の lock（OS の file lock）を、握っている間ずっと持つ。
  - すべての書込みの CAS に `execution_owner` を入れる（B2）。
- **束縛**（C1）：
  - Run の開始時に、main が sender（webContents）と navigation の世代に束縛する。束縛は memory に持つ。
  - 以後の IPC は、`project_id` と `chat_session_id` を画面から受けず、行から引く。
  - 開始時に、Native が同じ tx で、会話がその project に属することを検査する。
- **同じ起動の中の中断**（B3）：
  - main は、sender の destroyed・render-process-gone・navigation・窓の close と、workspace の切替を見張る。
  - 見張りが当たったら、その Run を `interrupted`（`renderer_lost`／`workspace_switched`）にする。checkpoint は残す。
- **回収**（B1・B2）：
  - main が workspace の DB を開いた後に行う。
  - 対象は、owner の lock が握られていない `execution_owner` を持つ非終端の Run。
  - これを `interrupted`（`app_shutdown`）にする。
  - 生きている別の main の Run は、lock が握られているので触らない。
  - MCP は回収しない。
  - 孤児の `running` を成功として扱わない。
- **削除**（C10）：
  - Run の行は、会話と作品の削除で cascade に消える。
  - 生きている Run の行が消えた後の書込みは、「行が無い」で失敗する。main はその Run の transport を止める。

### DR-A3-6 途中再開の手順

- **きっかけ**（問「きっかけ」の回答）：
  - 作者が、起点の会話で「続ける」を押したとき。
  - または、確認待ちの質問に答えたとき。
  - 起動時に自動では続けない。
- **claim**（B5）：
  - main が、OCC で `interrupted` を `running` に変え、`execution_owner` を今の自分にする。
  - 勝つのは 1 つ。2 つの窓や 2 つの起動が同じ Run を取らない。
  - 回答があるときは、pending の消費と claim を 1 つの tx で、冪等の key つきで行う。
- **再開の前の門**：通常の turn の開始と同じ検査を、今の状態で通す。
  - license、AI policy、profile の egress、route と provider が有効なこと、model が使えること。
  - 通らないときは、`interrupted` のまま `resume_blocked` にし、理由を画面に出す。
- **組み直し**：
  - system prompt と Codex の注入は、今の状態で組み直す。
  - checkpoint の tool_result を、今の状態に照らして選り分ける（問「原稿の変化」の回答）。
    - basis の版と今の版が違う source の結果は外し、「中断の間に変わったため外した」と AI に知らせる。
    - 今 hidden になっている source の結果も外し、「非公開になったため外した」と知らせる。
    - 外した source は、AI が必要なら読み直す。
- **loop に入り直す**：保存した計数を戻す。上限は新しく数え直さない（閾値の緩和にしない）。
- **未解決の 1 件**：
  - ask_user：
    - 同じ Run の続きなので、作者の回答は、元の `tool_call_id` の tool_result として渡す。
    - 質問は、起点の会話に再表示する。
  - 承認：
    - 再開した Run の中で、承認のカードをもう一度出す。
    - main が digest・project・OCC・policy・未使用を確かめ直したうえで、一回限りの capability に交換する（ADR 008 §4、Gate A の交換）。
    - 保存した resolution は、認可の根拠にしない。
- **落ちたときに実行中だった tool**：
  - 読む tool は、同じ `tool_call_id` でもう一度実行する。これは最後の 1 件だけの読み直し。
  - 変更系の tool は、同じ `tool_call_id` の `requestId` で冪等に再実行する。commit 済みなら保存した応答が返る。
  - 冪等の台帳が無い tool（`run_app_command`、`apply_layout_preset`）は再実行しない。AI には「中断で結果が分からない」と返す。
- **capability の発行**：
  - checkpoint の tool_use から、main が capability を発行し直す。これは新しい信頼の境界。
  - 条件：
    - main 自身が書いた checkpoint の行であること。
    - tool_use の引数が `checkpoint_digest` と合うこと。
    - policy を確かめ直すこと。
    - 変更系は、生きた承認を経ること。

### DR-A3-7 保持と削除（問「保持」の回答）

- checkpoint は、Run が `completed`・`failed`・`cancelled`（Stop を含む）になった時点で消す。
- `interrupted` の Run の checkpoint は、期限なしで残す。
  - 作者は、起点の会話の「破棄」で捨てられる。捨てると `discarded`（`discarded_by_author`）になり、checkpoint を消す。
- 同じ会話で作者が新しく送ったとき：
  - その会話の `interrupted` の Run は `discarded`（`superseded_by_new_turn`）にし、checkpoint を消す。
  - 新しい turn の後に古い途中の状態を差し込むと、会話の順序が崩れるため。
  - 画面では、送信の前に「中断した実行は破棄されます」と知らせる。
- 会話と作品の削除では、cascade で消える。
- backup と export に入るかは、実装の前に、今の backup の方式（DB の file を写すか）を確かめて記録する。写すなら入る。

### DR-A3-8 Mastra の経路

- electron/main に `AgentRunRecorder` の port を置く。操作は開始、Interaction の開閉、checkpoint、終端。
- Mastra の担当が、`mastraTurnOwner.ts` から呼ぶ。条件（第 8 節）：
  - 開始の記録は admission の後、audit の begin の前に置く。
  - 失敗は、wire の既存の拒否の理由に写す。
  - 終端は、すべての終わり方で一度だけ記録する。
  - quit の 5 秒の上限の内側に収める。
- 段ごとの message の正本は MP-9（`mastra_message_parts`）が持つ。
  - Mastra の経路の checkpoint は、MP-9 の message への参照（`turn_id`、最後の段）と、未解決の 1 件だけにする。
  - 同じ本文を 2 か所に持たない。
- W12 と DR-MP5-11 の改訂は、Mastra の担当の PR で行う。

### DR-A3-9 live の保留を伸ばさない

- durable な記録は、live な保留の寿命を変えない。
  - `ask_user` の 30 分、書込み行列の枠は今のまま。
  - recorder の書込みが、自分の書込み行列の枠を待たないこと（C11）。
- live の期限が切れた ask_user：
  - Interaction を `expired` にし、Run は `interrupted` にする。
  - 作者は後から「続ける」で答えられる。今は期限で turn を閉じている。
- Stop は `cancelled` で、checkpoint を消す。Stop は「再開しない」という作者の意思だから。

### DR-A3-10 R1

- `chatStreamTransport.ts` と `cliApi.ts` の `cleanup` を、`detach()` と `cancel()` に分ける。
  - `detach()` は、UI への配信を止めるだけ。
  - `cancel()` は、abort を要求する。
  - `result` は、終端で一度だけ resolve する。
- Mastra の turn の handle は、4c-2 の後に、Mastra の担当と範囲を決める。

### DR-A3-11 message の保存との関係（C4）

- 完了した turn の message は、今どおり画面の Drizzle が保存する。
- 終端の CAS に勝った側だけが保存する。
  - 画面は、終端の記録の戻り値が「自分が勝った」ときだけ、完了の保存を進める。
  - Stop と provider の終端が競っても、message は一度だけになる。
- 途中再開で完了した turn は、起点の会話の、元の turn の位置に保存する。

### DR-A3-12 受入れの測定

SessionTasks の材料に対応して、次を受入れの条件に入れる。

- 再開の前後で、文脈の大きさが変わらないこと（同じ turn の中の結果だけを戻すので）。
- 出力の上限で打ち切られた後に、抜けられること（thinking だけの打ち切りを繰り返さないこと）。
- mock の provider で決定的に確かめる。実 API の測定は、Anthropic の API で、別に伺う。

### DR-A3-13 F0-lite の Task の部分は Release B に回す

- DR-ST-9 で、作者が書く目的と条件の欄が外れた。そのため `minimal TaskContractSnapshotV1` は、中身を定め直す必要がある。
- `WorkTaskStatus`・`AnalysisReadBasis*` とともに Release B に回し、roadmap の F0-lite に注記する。
- ただし、DR-A3-4 の「読んだものの basis」は、`AnalysisReadBasisEntryV1` の候補の形として書く。Release B で共通にする。

### DR-A3-14 AWA/1 の承認との関係（B6、統合者に照合を求める）

- 事実：
  - AWA/1 の承認のカード（作者の出来事の更新・削除）は memory だけに置く。
  - AWA/1 には「却下・時間切れは DB の行を足さない」（確認 69）がある。
- 案：
  - AWA/1 の承認は、途中再開の対象の Run の中でだけ `approval` の Interaction として記録する。
  - 実装の前に、統合者に確認 69 との照合を求める。食い違うなら、AWA/1 の承認を記録の対象から外す（再起動の後は、カードを出し直さず中断にする）。

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 場面                     | 持ち主                                            | 受付を閉じる点                                             | 取り消し                                  | 待ちの上限             | 終わった証拠                           | 再起動の後                     |
| ------------------------ | ------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------ |
| Run の開始の記録         | main（port）                                      | admission の後、transport の前。記録できなければ開始しない | なし                                      | 同期                   | 行の作成                               | 回収の対象                     |
| checkpoint の書込み      | 画面の loop → IPC → main                          | 終端の後は拒む。束縛が合わなければ拒む                     | 失敗したら `resume_blocked`、生成は続ける | 同期（枠を待たない）   | 戻り値と `checkpoint_step`             | 残る                           |
| 活動の更新               | main                                              | 終端の後は拒む                                             | なし                                      | なし（間引く）         | なし                                   | —                              |
| Interaction を開く       | 経路の owner（legacy は画面→IPC、Mastra は main） | Run が終端なら拒む。pending は 1 件                        | Stop は `cancelled`、期限は `expired`     | 今の live の期限のまま | 行の状態                               | pending のまま残り、再表示する |
| 回答・承認の受理（live） | 経路の owner、記録は main                         | 受理の前に OCC で pending を消費                           | 二重・遅い回答は拒む                      | 即時                   | 戻り値と行の状態                       | —                              |
| 同じ起動の中の中断       | main の見張り                                     | 当たった時点で `interrupted`                               | —                                         | 即時                   | 行の状態                               | 残る                           |
| 回収                     | main（workspace を開いた後）                      | lock が握られていない owner の行だけ                       | —                                         | 開く処理の中で有限     | 更新した件数                           | —                              |
| 途中再開の claim         | main                                              | OCC で 1 つだけ勝つ                                        | 門で止まれば `resume_blocked`             | 即時                   | 行の `execution_owner` と version      | —                              |
| 終端の記録               | main                                              | 非終端と version の両方を条件に一度だけ                    | —                                         | 同期                   | `terminal_reason` と checkpoint の削除 | —                              |
| 破棄                     | 作者 → main                                       | 非終端の `interrupted` だけ                                | —                                         | 即時                   | `discarded` と checkpoint の削除       | —                              |
| detach（R1）             | 画面の projection                                 | —                                                          | 配信だけ止める                            | 即時                   | なし（実行は続く）                     | —                              |
| cancel（R1）             | main（abort の command）                          | 終端の後は no-op                                           | provider と process の停止                | 既存の SIGTERM→SIGKILL | result の終端                          | —                              |

## 5. 脅威モデルへの影響

- **新しい送信先**：無い。
  - 再開は、Run の snapshot と同じ provider だけに送る。
  - provider が無効になっていれば送らない。
- **保存の範囲の拡大**（第 7 節の回答の範囲）：
  - 確認待ちの表示文と、作者の回答。
  - turn の途中の AI の出力と、tool の結果の本文。作品の本文と Codex の抜粋を含む。
  - `interrupted` の間は、期限なしで残る。
  - hidden の本文は入らない。system prompt と Codex の注入は保存しない。
- **新しい authority**：
  - Run・Interaction・checkpoint の Native の表。
  - checkpoint の tool_use から、main が capability を発行し直す信頼の境界（DR-A3-6）。
  - 保存した resolution は、認可に使わない。
- **送り直しの安全**：
  - 再開の前の門（license、policy、egress、route）を通す。
  - hidden と、版の変わった source の結果は、送る前に外す。
- **W12 と DR-MP5-11**：
  - 「再起動後に復元しない」を「live な保留は伸ばさない。保存した状態から、作者の操作で同じ Run を再開する」に改訂する。
  - 文の変更は、Mastra の担当の PR で行う。
- **ADR 007 §4・§5**：
  - 「v1 は孤児 Run を interrupted へ遷移させ、透明な resume を装わず retry を提供する」に、直列化した continuation の契約を足す追補を、この lane の docs の PR に入れる。
  - §4 の最後の文は、この導入を許している。
- **suspend の snapshot**：Mastra の workflows store は永続化しない（変えない）。

## 6. PR の分け方（案）

1. **docs だけ**：この文書と、ADR 007 の追補。
2. **F0-lite の型と Native**：表・module・N-API・ADR 003 の手当て。閉じたまま、呼び手なし。schema の版を上げる。
3. **R1**：4c-2 の merge の後に、Mastra の担当と範囲を合わせる。
4. **legacy の経路の記録**：開始・終端・Interaction、束縛、同じ起動の中の中断と回収。
5. **legacy の経路の途中再開**：checkpoint、claim、門、選り分け、再表示と「続ける」「破棄」の画面。UI は Claude が持つ。
6. **Mastra の経路の接続**：Mastra の担当が持つ。A3 は port を出す。

roadmap の A3 の出口条件との対応：

- 行が移動と再起動を越えて残る：PR 2・4。
- 孤児の running を成功扱いしない：DR-A3-5。
- pending を起点の会話で再表示する：PR 5。
- 二重回答、Stop と回答、終端と遅い回答で二度 resolve しない：DR-A3-3・DR-A3-6・DR-A3-11。
- 拡張の出口：中断した瞬間の最後の切れ目から、読み直しなしで同じ Run が続く（PR 5、DR-A3-12 の測定）。

## 7. ユーザーに伺う点

1. **保存の範囲。** 確認待ちの表示文（AI が出した質問や承認の対象の要約）と作者の回答を、会話の外の表に残してよいか。
   - 推奨案：表示文と回答を残す。prompt の本文と tool の結果の本文は残さない。会話や作品を削除すれば消える。
   - 代案：表示文だけを残す、または ID と digest だけを残す。
2. **DR-MP5-11 と W12 の変更。** 再起動の後、保留だった質問を起点の会話に再表示してよいか。
   - 推奨案：再表示する。答えると、その回答をもとに続ける新しい実行を作者が始められる。元の実行は「中断」と表示する。
   - 代案：記録として見せるだけで、回答はできない。
3. **新しい authority。** Run と Interaction の新しい表 2 本を正本とし、main だけが書く。

回答の原文は統合者に送り、contracts に記録してもらう。

### 回答（2026-11-27、AskUserQuestion）

- 記録：contracts の問 11〜13（`claude/nir1-contracts` の `0de2aed37`）。
- 問 3 は条件つきの承認で、第 8 節のすり合わせが済むまでは確定扱いにしない。
- schema の版は、CED/1 の 49 の次に空いている番号（見込みは 50）を、merge の直前に確かめて取る。

- 問 1：「表示文と回答を残す (推奨)」。
- 問 2：「再表示して答えられる (推奨)」。
- 問 3：「良いですがadvisorとmastraの担当とすり合わせしてください」。
  - すり合わせの結果は第 8 節に記録する。結果が出るまで、問 3 に依る実装（PR 2 以降）に入らない。

### 範囲の拡張（2026-11-27、ユーザーの発言）

- 経緯：再起動の後に答えても元の作業の途中からは再開しない（新しい実行が会話の履歴から続ける）ことを説明した。そのうえでの発言（原文）：「中断した瞬間の状態から、読み直しなしで続くで行きたいです。A3の範囲を拡張してやりましょう。」
- 位置づけ：方向の決定。問 12 の「新しい実行で続ける」と DR-A3-6 の一部を上書きする。
- 問 11 との食い違い：問 11 では「prompt の本文と tool の結果の本文は残しません」とした。続きから再開するにはその本文を残すことになるので、保存の中身は改めて伺う。
- 残すもの：保存した承認を認可の根拠にしない（再開しても、交換のときに main が確かめ直す）。
- 第 3 節の DR-A3-2・DR-A3-4・DR-A3-6 と第 4 節は、この拡張に合わせて改訂する。改訂が済むまで、PR 2 以降に入らない。

### 拡張の保存の中身（2026-11-27、AskUserQuestion。contracts の問 14〜17）

- 選択肢の全文は contracts に写した。回答は次のとおり。
  - 問 14「残す中身」：「途中の会話を残し、指示文は組み直す (推奨)」。
  - 問 15「保持」：「終わったら消す・中断は期限なし」（推奨の「中断は 30 日」ではない方）。
  - 問 16「きっかけ」：「作者が「続ける」を押したとき (推奨)」。
  - 問 17「原稿の変化」：「変わった分だけ外して知らせる (推奨)」。
- 効力：問 11 の「本文は残さない」は、この範囲で置き換わる（統合者の記録）。
- 統合者の注 1：保持が期限なしなので、作者が消し忘れると、作品の本文の写しが残り続ける。破棄の操作の置き場所と文言は、画面の PR（PR 5）の前にユーザーに見せる。
- 統合者の注 2：問 13 のすり合わせ、ADR 007 §4・§5 の追補、脅威モデルの改訂は、この範囲を含めて行う。

## 8. 問 3 のすり合わせ

### Mastra の担当（grimodex-57、2026-11-27）：大きな異論なし。条件と懸念は次のとおり。

1. **closed の表の追加。**
   - 試験用の台帳の写し（`electron/main/d2aSqlPolicyFixture.ts`）と、件数の試験（`execute.rs`・`own-data-read.test.mjs`）を同時に直す。漏れると、CI でだけ走る `d2aOwnDataRead.pipeline.spec.ts` で master が赤になる（#1175）。
   - `napi:build` の後に `vitest.electron-native.config.ts` を回す。
   - renderer の読みは typed の IPC にし、generic SQL を通さない。
2. **Mastra の経路の port の呼び出し（接続は Mastra の担当の PR）。**
   - 開始の記録は、owner の admission（gate、profile、sender、要求の検査）の後、audit の begin の前に置く。拒否の理由の順番は journey が固定している（#1186・#1193）。
   - 記録の失敗は、wire の既存の拒否の理由（例：`unsupported`）に写す。新しい理由は足さない。
   - 終端の記録は、owner のすべての終わり方（完了、Stop、強制中断〔profile・workspace の切替・quit〕、画面の喪失）で一度だけ呼ぶ。quit の 5 秒の上限の内側に収める。
3. **起動時の回収。**
   - DB は workspace ごとにある。そのため、回収は workspace を握る時点で行う（DR-A3-4 に反映した）。
   - MCP は回収しない。
4. **`waiting_approval` と W12。**
   - `waiting_approval` は合意どおり A3 が持ち、Gate A は `interaction_id` を参照する。
   - W12 と DR-MP5-11 の改訂は、Mastra の担当が port の接続の PR で行い、独立レビューを通す。
   - 再起動の後の回答は、新しい Run の中で受ける（DR-A3-6）。

### advisor（Fable、effort high、read-only、2026-11-27。範囲の拡張の前の版 58c21dcef を点検）

blocker（実装の前に文書を直す）：

- **B1 回収の起点。** DB はアプリの起動時ではなく `open_workspace` で開く（`electron/main/ipc.ts:2533`）。回収は「main がその workspace の DB を開いた後」に置く。Mastra の担当の指摘と同じ（DR-A3-4 に反映済み）。
- **B2 Electron が 2 つ起動している場合。**
  - dev 版と packaged 版は、単一起動の lock が別々で、同じ workspace を開けうる。
  - 「今の起動の ID でない owner」を条件にすると、後から開いた側が、相手の生きた Run を interrupted にしてしまう。
  - 直し方：owner ごとの OS の lock で、相手の起動が生きているかを見る。すべての書込みの CAS に `execution_owner` を入れる。
- **B3 main が生きたまま renderer を失う場合。**
  - reload・render-process-gone・窓の close・navigation・同じ起動の中での workspace の切替について、表に行が無い。
  - Run の開始時に、sender と navigation の世代に束縛する。
- **B4（拡張で形が変わる）再起動の後に答えられるもの。** `approval` の扱い、回答を tool の結果として渡すか、再送信の前の門の 3 条件を書く。
- **B5（拡張で形が変わる）回答の消費と再開の原子性。** 二重回答で再開が 2 本できないよう、pending の CAS と再開の claim を 1 つの tx で、冪等の key つきで行う。
- **B6 AWA/1 の承認との関係。** AWA/1 の承認を Interaction に記録するなら、AWA/1 の R4 と ADR 007／008 の追補を実装より先に改訂する。AWA/1 には「却下・時間切れは DB の行を足さない」という規則（確認 69）があり、これとの食い違いは統合者に照合を求める。

懸念：

- **C1 束縛。** project と session は、renderer から受けずに行から引く。会話がその project に属することを、Native が同じ tx で検査する。`request` には上限の長さを置く。
- **C2 status と terminal_reason の対応表と CHECK。** policy・license の取り消し、permission の境界、timeout、記録の失敗に当たる値を足す。
- **C3 終端の一回性。** 「非終端であること」の検査を必須にする。activity の更新では version を上げない。Run の状態と Interaction は同じ tx で変える。
- **C4 message の二重保存。** message は renderer の Drizzle が別の tx で保存する。終端の CAS の勝者だけが保存するのかを書く。
- **C5 pending の 1 件の制約。** `root_run_id` の列が要る。古い pending を superseded にする規則が無い。
- **C6 kind。** permission 要求が無い。Mastra の UI 系（10 秒）は記録しない。
- **C7 AI Audit とのつなぎ。** Run と `execution_id` は 1 対多なので、1 列では表せない。
- **C8 ApprovalRequest の列。** canonical args などの列は、承認済みの保存の範囲を超える。
- **C9 ADR 003 の手当て。** Drizzle parity、schema-contract、D2a の台帳の写し。
- **C10 削除。** 会話や作品の削除で生きた Run の行が消えたときの扱いと、backup・export に入るかが未回答。
- **C11 記録の失敗。** 開始以外の記録が失敗したときの扱い。recorder の書込みが、自分の書込み行列の枠を待たないこと。

問題なしと判断された点：

- 置き場所と書き手（ADR 007・003 と整合）。
- MCP では回収しないこと。
- 複数の窓（main は 1 つ）。
- DR-A3-5 と DR-MP5-11・W12 の整合。

扱い：B1〜B3・B6・C1〜C11 は、拡張を入れた改訂版に取り込む。B4・B5 は、再開の形に合わせて書き直したうえで、改訂版を再び諮問にかける。
