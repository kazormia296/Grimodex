# A3：durable な AgentRun と確認待ち、途中からの再開（F0-lite・R1 を含む）の判断記録

- 状態：**草稿・第 3 版（2026-11-27）**。第 2 版の独立レビュー（Fable の再諮問、4 観点の敵対レビュー）の指摘を入れた（第 8 節）。
  - 第 9 節の「画面で見える挙動」をユーザーに見せるまで、PR 4・5 に入らない。
  - PR 2 の列は、この版で決めた（[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)）。
- 担当：A3 の lane（grimodex-59）。統合者「統合」の引き継ぎ（2026-11-27）による。
- 根拠のユーザー決定：
  - 問 10（2026-11-26）：A3 は「新しい lane で実装まで」。
  - 問 11〜13、範囲の拡張の発言、問 14〜17（2026-11-27、第 7 節）。
  - 記録は `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/`（問 11〜13 は `0de2aed37`）。
- 委任：この lane は NIR-1 の残レーンではないので、AGENTS.md の事前委任は及ばない。
  - 問 10 が委ねた「起案から実装まで」の技術判断は、この文書に記録する。
  - 保存の範囲、新しい authority、DR-MP5-11 と W12 の変更は、第 7 節の回答の範囲の内側でだけ行う。
- 正本：
  - [agent-collaboration-roadmap.md](agent-collaboration-roadmap.md) の F0-lite・R1・A3。
  - [ADR 007](../adr/007-agent-collaboration-execution-boundary.md) §2〜§5。
  - [ADR 008](../adr/008-agent-default-mode-and-write-approval.md) §4・§5。
  - [SessionTasks の判断](session-tasks-decisions-2026-11.md)。
  - [MP-5 の判断](mastra-mp5-decisions.md) の DR-MP5-5・DR-MP5-11、[脅威モデル](mastra-migration-threat-model.md) の W12。

## 1. 範囲

- 含む：
  - F0-lite のうち A3 が使う型（F0-lite-A）：
    - `TransportExecutionHandle`、`AgentRunStatus`、`AgentRunInteractionStatus`、`ExecutionAuthority`、`ProjectionAttachment`。
    - `AnalysisReadBasisEntryV1`。途中再開の選り分けに使うので、Release B に回さない。
  - R1：legacy の API と CLI の stream の handle を、subscribe／unsubscribe／detach／cancel／result に分ける。
  - A3：Run と Interaction の durable な記録、中断の検出と回収、起点の会話での再表示。
  - **A3 の拡張（2026-11-27）**：中断した Run を、保存した途中の状態から、読み直しなしで同じ Run として再開する（以下「途中再開」）。
- 途中再開の対象の経路：
  - **legacy の API の agent loop**：画面の agent loop で、今の本番の経路。A3 が持つ。
  - **Mastra の経路**：今は画面からつながっていない。
    - 段ごとの message の保存は MP-9 が持ち、A3 は Run・Interaction と再開の判断を持つ（DR-A3-8）。
    - MP-9 と再入の実証が済むまでは、中断を記録して「続けられない」と出す。
  - **CLI と Codex App Server**：途中再開しない。中断を `cancelled`（`resume_unsupported`）の終端として記録し、画面には「続けられない」と出す。
    - CLI は provider 側に続きが無い。
    - Codex App Server は、確定した turn の後からしか続けられない設計（`manager.ts:54-57` の pending sentinel）。
- 含まない：
  - R0（CLI の timeout）。A3 の State は「R1 と F0-lite の state contract で Blocked」で、R0 は前提に入らない。
  - A4a 以降（Background Session、UI の全体、hardening）。
  - Gate A（A1・A2。担当は Mastra）。
  - Release B の部分：子の Run、grant の受け渡し、Task の表。
- F0-lite のうち `WorkTaskStatus`・`minimal TaskContractSnapshotV1`（F0-lite-B）は、Release B の lane に回す（DR-A3-13）。

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
  - OCC：`WHERE id=? AND version=?`（`plot_threads.rs:1508`）。
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
- **capability**：main の memory にあり、TTL 5 分・一回限り。main が受けた provider の応答の tool_use だけから発行する（`electron/main/ipc.ts:1657-1723`）。再起動で消える。
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

### 2.4 第 2 版のレビューで確かめた事実

- **作者の発言の行**：user の行は、turn の完了時にだけ保存される（`chatTurnStoreActions.ts:1202-1210`）。中断の間は、DB に作者の発言が無い。
- **確認待ちの期限**：legacy の ask_user には期限が無い（`chatUserQuestionRuntime.ts:18-35`）。30 分の期限は Mastra の経路だけ（`mastraAgentTurnWire.ts:149`）。
- **checkpoint を取れる時点**：
  - assistant の tool_use は、実行の前に memory の conversation に積まれる（`agentLoop.ts:259-270`）。
  - tool_result は、batch が終わってから積まれる（`agentLoop.ts:348-378`）。
  - そのため、今の切れ目では、実行中だった tool_use が残らない。
- **tool_use と tool_result の対**：loop は対を崩さない。欠けると次の API の呼出しが壊れるので、失敗も error の tool_result で埋める（`agentLoop.ts:282-284`）。
- **読んだ版の記録**：`ToolResult` には、読んだ source や版の欄が無い（`agentTypes.ts:161-172`）。検索や一覧の tool は、複数の source を束ねて返す。
- **冪等の再実行で結果が返らない**：
  - codex 系の書込みの指紋には provenance が入る（`agent_writes.rs:1559-1584`）。
  - `mainOwnedProvenanceId` は、発行のたびの乱数（`ipc.ts:1691`）。
  - そのため、再発行した capability で再実行すると hash が合わず、拒否になる（`idempotency.rs:57`）。二重にはならないが、結果も返らない。
- **capability に束ねる値**：`executionId`・`chatMessageId`・`model` を、画面の `auditContext` と引数から取る（`ipc.ts:1646-1655,1695-1712`）。
- **backup**：
  - 自動の backup は `VACUUM INTO` で DB 全体を写す（`grimodex-db/src/lib.rs:715-748`）。
  - 写しの slim が消すのは chunk と FTS だけ（`lib.rs:219-228`）。
  - そのため、途中再開の状態も backup に入る。
- **workspace の lease**：`workspace_lease`（`workspace_lease.rs:61-132`）は shared／exclusive で、握っている相手を区別できない。

## 3. 判断（案）

### DR-A3-1 置き場所と authority（問 13、条件つきの承認）

- grimodex-db に新しい module（`agent_runs.rs`）と、表 2 本（`agent_runs`、`agent_run_interactions`）を置く。Run、Interaction、途中再開の状態の唯一の正本にする。
  - 途中再開の状態と、tool 呼出しの台帳は、`agent_runs` の列に持つ（DR-A3-4）。表は 2 本のまま。
- D2a closed で、generic SQL を通さない。
  - 書くのは typed N-API（main 専用）だけ。
  - renderer は、typed の IPC で読み書きを頼む。main は、行の束縛（DR-A3-5）を照らしてから Native を呼ぶ。
- ADR 003 の手当ても同じ PR に入れる：
  - Drizzle parity の native-only の allowlist。
  - schema-contract の再生成。
  - D2a の台帳の写し（`electron/main/d2aSqlPolicyFixture.ts`）。
  - 件数の試験（`execute.rs`・`own-data-read.test.mjs`）。
  - CI でだけ走る `d2aOwnDataRead.pipeline.spec.ts` を、`napi:build` の後に手元で回す。

### DR-A3-2 Run の列と状態

- **列**：
  - ID：`run_id`（main が発番）、`root_run_id`（v1 では自分）。
  - 対象：`project_id`、`chat_session_id`、`turn_id`、`route`（legacy｜mastra｜cli｜codex_app）。
  - 起点：`origin_user_message_id`。画面が turn の開始時に発番する user の行の ID で、FK にしない（中断の間は行が無いので）。
  - model の snapshot：provider の ID、model の ID、endpoint の識別子（URL の hash）。API の key は保存しない。
  - 実行の権限：`execution_owner`（DR-A3-5）。
  - 状態：`status`、`terminal_reason`、`interrupt_reason`、`resumable`（真偽）、`not_resumable_reason`、`version`（OCC）。
  - 再開の門：`resume_block_detail`、`resume_blocked_at`。門で止まったことは、ここにだけ書く（status と `interrupt_reason` は変えない）。
  - 保存中：`finalizing_target_status`、`finalizing_target_reason`、`origin_assistant_message_id`（DR-A3-11）。
  - 時刻：`activity_at`、`created_at`、`updated_at`。
  - AI Audit とのつなぎ：`audit_execution_ids`（JSON の配列）。
    - Run から AI Audit の `execution_id` を 1 対多で持つ。
    - `ai_audit_events` は変えない。`operation_id` は NOT NULL で、意味も別なので使わない（Fable の K2）。
  - Release B 用に今は空で置く：`continuation_of`、`task_id`。
- **status は 9 つ**：
  - 非終端の 5 つ：`running`、`waiting_user`、`finalizing`、`interrupted`、`waiting_approval`。
    - `waiting_approval` は、承認待ちで止まっている（DR-A3-14）。
  - 終端の 4 つ：`completed`、`failed`、`cancelled`、`discarded`。
  - `interrupted` は非終端で、`resumable` が真なら途中再開の候補になる。
- **`resumable` と `interrupt_reason` は、別の列にする**：
  - `resumable` が偽のとき：途中再開できない。理由は `not_resumable_reason` に書き、画面に出す。
    - `checkpoint_write_failed`、`ledger_write_failed`：途中の状態や台帳を書けなかった。
    - `hidden_source_read`：hidden になった source を読んでいた（DR-A3-6）。
    - `restored_from_copy`：backup などの写しから戻した（DR-A3-7）。
    - `route_unsupported`：Mastra の経路の当面の扱い（DR-A3-8）。
    - 回収では真に戻さない。
  - `interrupt_reason`：なぜ止まったか。再開の門の結果では変えない。
    - `app_shutdown`、`renderer_lost`、`workspace_switched`、`profile_switched`。
    - `question_timeout`（Mastra の質問の 30 分）、`approval_timeout`（Gate A の承認の 30 分）。
    - `copied_snapshot`：写しの中で、非終端の行を中断に倒した（DR-A3-7）。
- **terminal_reason と status の対応**は、CHECK で固定する：
  - `completed`：`completed`、`limit_tokens`、`output_truncated`、`context_window_exceeded`。
  - `failed`：`provider_error`、`record_failed`、`timeout`。
  - `cancelled`：`user_stop`、`policy_revoked`、`license_restricted`、`permission_denied`、`authority_lost`、`resume_unsupported`（CLI・Codex App Server）。
  - `discarded`：`discarded_by_author`、`superseded_by_new_turn`。
- **一回性**：
  - 状態の変更は、「今の status が期待どおり」と version の両方を条件にする。
  - version を上げるのは、状態の変更だけ（Fable の K1）。
    - `activity_at`、台帳、checkpoint の書込みは version を上げない。
    - 台帳と checkpoint の書込みの条件は、`execution_owner` が自分、非終端、`checkpoint_step` が今の値より大きいこと（台帳は `tool_call_id` の重複を拒む）。
    - main の台帳と画面の checkpoint が同じ version を競って、`resumable` が不必要に偽になることを避けるため。
- **会話ごとの active の制約**：
  - `chat_session_id` ごとに、active（`running`・`waiting_user`・`waiting_approval`・`finalizing`）の Run は 1 つまで（部分 unique index）。
    - `waiting_approval` は v1 で使わないが、Gate A で index を作り直さないように、今から入れる（Fable の K3）。
  - 新しい turn の開始と途中再開の claim が競っても、勝つのは 1 つ。

### DR-A3-3 Interaction

- **列**：
  - ID と対象：`interaction_id`、`run_id`、`root_run_id`、`chat_session_id`。
  - 種類：`kind`。
  - 呼出し：`tool_call_id`、`tool_name`、`args_digest`。
  - 中身：`request`（表示文。上限の長さを置く）、`resolution`（作者の回答）。
  - 状態：`status`、`version`。
- **kind**：
  - v1 で使うのは `user_question`（ask_user）と `approval`（DR-A3-14）。
  - `plan_amendment`・`permission` は、値だけ予約する。
  - Mastra の UI 系 6 本（10 秒）は記録しない。
- **status と遷移**：
  - `pending` → `resolved`：作者が答えた。live の回答でも、claim と一緒の回答でもよい。
  - `pending` → `cancelled`：Run が終端（Stop、破棄、`superseded_by_new_turn` を含む）になった。
  - 承認の Interaction では、`resolution` に承認か却下かを書く。
  - `superseded`：承認の対象が変わり、Gate A の交換で確かめ直しに通らなかった。
  - `expired`：Gate A の交換で失効と判定された。live の 30 分の期限そのものでは使わない（DR-A3-14）。
- **期限で閉じない**：
  - Mastra の 30 分の期限が切れても、Interaction は `pending` のままにする。
  - Run は `interrupted`（`question_timeout`）にする。live の保留は今どおり消費し、遅い live の回答は捨てる（DR-MP5-5）。
- **pending の制約**：`root_run_id` ごとに 1 件まで（部分 unique index）。Run の状態と Interaction は、同じ tx で変える。
- **回答の受け口**：main が、live の保留があるかどうかで振り分ける。
  - live の保留があれば、live の回答として受ける。
  - なければ、claim と一緒の回答（DR-A3-6）として受ける。
- **live の回答の後に落ちたとき**：
  - Interaction が `resolved` で、checkpoint の未解決の spec に結果が無いことがある。
  - 再開のときは、`resolution` を元の `tool_call_id` の tool_result として入れる。

### DR-A3-4 途中再開の状態（checkpoint）と tool 呼出しの台帳

- **置き場所**：`agent_runs` の列。1 つの Run に 1 組で、切れ目ごとに上書きする。
  - `checkpoint`（JSON）、`checkpoint_step`、`checkpoint_digest`。
  - `tool_call_ledger`（JSON）。
- **tool 呼出しの台帳**：書き手は main だけ（第 2 版のレビューの N1・F1）。
  - main は、model の応答から tool の呼出しを受け取った時点で、tool_use を台帳に書く。
    - capability の発行の時点には結ばない。Gate A（A2）で発行が「承認が確定した後」に動いても、台帳の時点は動かない（Mastra の担当の指摘、2026-11-27）。
    - Mastra の経路では、owner が tool の呼出しを受け取る所（binding の execute の入口）から、port の台帳の操作を呼ぶ。
  - 書くもの：`tool_call_id`、名前、引数の正規形と digest、`executionId`、`chatMessageId`、`mainOwnedProvenanceId`、model。
  - 状態は 2 つを別に持つ：
    - capability の状態：`not_issued`／`awaiting_approval`／`issued`／`consumed`。
    - 実行の状態：`pending`／`committed`／`failed`。
  - 台帳は、main が見た provider の応答だけから作る。画面から受け取らない。
- **画面から受け取るもの**：
  - tool_result の本文と、その basis。
  - 計数（下記）。
  - main は、tool_result の `tool_call_id` が台帳にあることを確かめてから書く。
- **checkpoint の中身**（問 14 の回答の範囲）：
  - 作者の発言：本文、添付の参照、`mentioned_scene_ids` などの metadata、`createdAt`、`origin_user_message_id`。
    - 中断の間に作者の発言を再表示し、再開で保存するため。
  - その turn の中の、provider に依らない形の message の列：assistant の text・thinking と署名・tool_result の本文。
    - assistant の tool_use は台帳から組む。
  - loop の計数：
    - totalCalls、userQuestionCalls、totalTokens、limitMessageInserted、limitReason。
    - tokensIn と tokensOut。
    - toolCallRecords、citations、cost。
    - 画面に累積している assistant の本文、parentAuditExecutionId、token の drift の合計。
    - checkpoint は、上限の判定の後に書く。
  - 同じ batch の途中で止まっている場合：batch の tool_use の一覧と、先に終わった結果、未解決の ask_user の spec。
  - 読んだものの basis（`AnalysisReadBasisEntryV1`）。tool_result ごとに、読んだ source の種類・ID・版または内容の hash を持つ。
    - 検索と一覧の tool は、結果に載ったすべての source を持つ。
    - get_codex_entry の「注入済み」の stub は、その項目を basis に持つ。
- **中身に入れないもの**：
  - system prompt、Codex の注入、tools の manifest、route。再開のときに今の状態で組み直す。
  - API の key。
- **書く時点**：
  - 応答の直後、tool の実行の前（台帳の書込み）。
  - batch の tool の結果がすべてそろった時点。
  - ask_user の保留を開いた時点。
- **書けなかったとき**：
  - 台帳を書けなければ、その応答の変更系の tool を実行しない。読む tool は実行してよい。Run は `resumable` を偽にする。
    - 台帳の無い変更系の実行は、二重の書込みの元になるため。
  - checkpoint を書けなければ、`resumable` を偽にし、生成は止めない。
- **生成の途中で落ちたとき**：
  - 最後の切れ目から再開し、その後の生成をやり直す。
  - 途中まで出ていた出力は失われ、provider への送信と費用は、もう一度かかる。
- **大きさ**：tool の結果の累計は、今の `limit_tokens`（文脈の窓の 30%）の内側にある。checkpoint の上限は、文脈の窓から決める。

### DR-A3-5 実行の権限、束縛、中断の検出と回収

- **execution_owner**：main の起動ごとの ID（owner ID）。
- **owner の lock**：
  - main は、workspace を開いたら、owner ごとの lock file を握る。置き場所は workspace の `.grimodex/agent-run-owners/<owner ID>.lock`。
  - lock を握るのは Native。既存の `workspace_lease`（`workspace_lease.rs:63・110`）と同じ Rust の std の `File::try_lock` を使い、main の process の中で file を閉じずに持ち続ける。
  - 順序：lock を握る → owner ID を行に書く。手放すのは、自分の Run を interrupted にした後。
  - 同期フォルダの上の workspace で、lock が効かないことがある。
    - 回収は、行の `activity_at` が十分に古い（既定は 24 時間）owner だけに行う。
    - 画面に「中断の検出が遅れることがある」と出す。
    - 孤児の行が active の index を塞いで、その会話で新しい turn を始められなくなることを避けるため。
- **すべての書込みの CAS に `execution_owner` を入れる**（B2）。
- **束縛**：
  - Run の開始と claim のたびに、main が sender（webContents）と navigation の世代に束縛し直す。束縛は memory に持つ。
  - 以後の IPC は、`project_id`・`chat_session_id`・`run_id` を行から引く。画面が送った値は、行と照合して違えば拒む。
  - capability に束ねる `executionId`・`chatMessageId`・`model` は、台帳の値を使う。
  - 開始時に、Native が同じ tx で、会話がその project に属することを検査する。
- **同じ起動の中の中断**：
  - main は、sender の destroyed・render-process-gone・navigation・窓の close と、workspace・profile の切替を見張る。
  - 見張りが当たったら、main の側の provider の transport と、main が実行中の tool を止める。
    - transport の終端を確かめてから、その Run を `interrupted` にする。
    - checkpoint は残す。
  - quit は、5 秒の上限の内側で自分の Run を `interrupted`（`app_shutdown`）にしてから、lock を手放す。
  - 強制中断（profile・workspace の切替・quit）は終端でなく `interrupted` にする。Mastra の担当の条件「終端を一度だけ記録」は、「中断を一度だけ記録」と読み替えて合わせる（第 8 節）。
- **回収**：
  - main が workspace の DB を開いた後に行う。
  - 非終端の行の owner ごとに、その lock を非 blocking で取ってみる。取れた owner は死んでいるので、その非終端の Run を `interrupted`（`app_shutdown`）にする。
  - 生きている別の main の Run は、lock が取れないので触らない。
  - `finalizing` の Run は DR-A3-11 で扱う。
  - MCP は回収しない。孤児の `running` を成功として扱わない。
- **削除**：
  - Run の行は、会話と作品の削除で cascade に消える。
  - 生きている Run の行が消えた後の書込みは、「行が無い」で失敗する。main はその Run の transport を止める。

### DR-A3-6 途中再開の手順

- **きっかけ**（問 16）：
  - 作者が、起点の会話で「続ける」を押したとき。
  - または、確認待ちの質問に答えたとき。
  - 起動時に自動では続けない。
- **門**（claim の前に、状態を変えずに検査する）：
  - license、AI policy、profile の egress、route と provider が有効なこと、model が使えること。
  - endpoint の識別子が snapshot と同じこと。違えば再開しない（送信先を変えないため）。
  - 通らないときは、`resume_block_detail` と `resume_blocked_at` だけを書き、理由を画面に出す。status、`interrupt_reason`、回答は変えない。
- **claim**（門の後に、1 つの tx で行う）：
  - `interrupted` を `running` に変え、`execution_owner` を今の自分にし、sender に束縛し直す。
  - 回答があるときは、pending の消費と回答の記録も同じ tx で行う。
  - 冪等の key は、既存の `idempotency_requests` に置く（domain は `agent_run_claim`、Fable の K4）。
  - 勝つのは 1 つ。2 つの窓や 2 つの起動が、同じ Run を取らない。
- **組み直し**：
  - system prompt と Codex の注入は、今の状態で組み直す。
- **選り分け**（問 17）：checkpoint の結果を、今の状態に照らして選り分ける。
  - **hidden になった source**：その source を読んでいた Run は、途中再開しない。`resumable` を偽にし、「非公開にした項目を読んでいたため続けられない」と出す。
    - 外しても、その後の assistant の text と thinking に内容が写っていて、送り直すと漏れるため（第 2 版のレビューの F4・懸念 6）。
    - 判定には、Phase を含めた今の可視性を使う。
  - **版が変わった source、消えた source、basis の無い結果**：
    - tool_use との対は残し、本文だけを「中断の間に変わったため外した」に置き換える。
    - AI は、必要ならそこだけ読み直す。
  - **注入の集合が変わった場合**：get_codex_entry の「注入済み」の stub も、同じ扱いにする。
- **loop に入り直す**：
  - 保存した計数を戻す。上限は数え直さない（閾値の緩和にしない）。
  - batch の途中なら、残りの tool_use から入り直す。`runAgentLoop` に、この入口を足す（PR 5）。
- **未解決の ask_user**：
  - 同じ Run の続きなので、回答は元の `tool_call_id` の tool_result として渡す。
  - 質問は、起点の会話に再表示する。
- **落ちたときに実行中だった tool**：台帳で `tool_call_id` が分かる。
  - 読む tool は、同じ `tool_call_id` でもう一度実行する。最後の 1 件だけの読み直しになる。
  - 変更系の tool は、Gate A の前は再実行しない（第 2 版のレビューの N4）。
    - 台帳の元の `mainOwnedProvenanceId` と `requestId` で、commit 済みかだけを照会する。
    - 照会の結果（commit 済み／未実行）を、tool_result として AI に返す。
  - 冪等の台帳が無い tool（`run_app_command`、`apply_layout_preset`）も再実行しない。AI には「中断で結果が分からない」と返す。
- **capability の発行**：
  - 再開の後の新しい tool_use は、今どおり、main が受けた provider の応答から発行する。
  - 台帳の tool_use から capability を発行し直す経路は置かない。
    - capability を使うのは、変更系（14 本）と stage（`propose_scene_body`）の tool だけ（`ipc.ts:237-`、`:1663-1670`）。
    - 読む tool は capability を使わないので、台帳の `tool_call_id` でそのまま再実行できる。
  - stage の tool も、変更系と同じく再実行しない。同じ提案を二重に作らないため。台帳で、作られたかだけを照会する。
  - 変更系の承認の後の交換は、Gate A で決める。保存した resolution は、認可の根拠にしない。

### DR-A3-7 保持と削除（問 15）

- checkpoint と台帳は、Run が終端になった時点で消す。終端は `completed`・`failed`・`cancelled`（Stop を含む）・`discarded`。
- `interrupted` の Run の checkpoint は、期限なしで残す。
  - 作者は、起点の会話の「破棄」で捨てられる。捨てると `discarded`（`discarded_by_author`）になり、checkpoint を消す。
  - 破棄の置き場所と文言は、画面の PR の前にユーザーに見せる（第 9 節）。
- 同じ会話で、`interrupted` の Run があるのに新しい turn を始める操作：
  - 対象の操作：送信、再生成、message の削除、会話の消去。
  - 先に確認を出す（「中断した実行を破棄して進めますか」）。
  - 進めたら、新しい turn の開始と同じ tx で、その Run を `discarded`（`superseded_by_new_turn`）にする。preflight で止まったら、破棄も行わない。
  - 再表示した質問に、入力欄から答えた場合：送信でなく回答として扱う（DR-A3-3 の受け口）。
- 会話と作品の削除では、cascade で消える。
- **backup とその他の写し**（問 19）：
  - 対象：アプリが作る DB の写しのすべて。
    - 自動の backup（slim の段）。
    - 復元の前の退避（`backup_restore.rs:434-488`）。
    - migration の前の snapshot（`migration_supervisor.rs:925-944`。今は slim をしない）。
  - 写しでは、次のものを空にする。
    - checkpoint と台帳の列、Interaction の `request` と `resolution`。
    - slim の最後の VACUUM（`lib.rs:277`）の前に置く。そうすれば、本文は物理的にも残らない。
  - 非終端の行は、`interrupted`（`copied_snapshot`）に倒し、`resumable` を偽（`restored_from_copy`）にする。
  - 作者が破棄した後も写しに本文が残ることを防ぎ、保持を問 15 の範囲に収めるため。
  - 写しから戻した中断の実行は「続けられない」になる（第 9 節）。
  - export（作品の書き出し）に Run の表が入るかは、PR 4 の前に確かめる。入るなら、同じく空にする。

### DR-A3-8 Mastra の経路

- electron/main に `AgentRunRecorder` の port を置く。操作は、開始、Interaction の開閉、台帳と checkpoint、中断、終端。
- Mastra の担当が、`mastraTurnOwner.ts` から呼ぶ。条件（第 8 節）：
  - 開始の記録は admission の後、audit の begin の前に置く。
  - 失敗は、wire の既存の拒否の理由に写す。
  - 中断と終端は、すべての終わり方で一度だけ記録する。
  - quit の 5 秒の上限の内側に収める。
- 段ごとの message の正本は MP-9（`mastra_message_parts`）が持つ。
  - Mastra の経路の checkpoint は、MP-9 の message への参照（`turn_id`、最後の段）と、未解決の 1 件だけにする。
  - source の印は、MP-9 の parts が持つ（Mastra の担当）。
- MP-9 と再入の実証が済むまでは、Mastra の Run は `resumable` を偽で記録する。
- W12 と DR-MP5-11 の改訂は、Mastra の担当の PR で行う。

### DR-A3-9 live の保留を伸ばさない

- durable な記録は、live な保留の寿命を変えない。
  - Mastra の `ask_user` の 30 分、書込み行列の枠は今のまま。
  - recorder の書込みが、自分の書込み行列の枠を待たないこと。
- Mastra の期限が切れたら、live の保留は消費し、Run は `interrupted`（`question_timeout`）にする。Interaction は `pending` のまま（DR-A3-3）。
- legacy の ask_user には期限が無いので、今どおり。
- Stop は `cancelled` で、checkpoint を消す。Stop は「再開しない」という作者の意思だから。

### DR-A3-10 R1

- `chatStreamTransport.ts` と `cliApi.ts` の `cleanup` を、5 つの操作に分ける。
  - `subscribe`／`unsubscribe`：1 つの projection の購読者だけに作用する。
  - `detach()`：UI への配信を止めるだけ。
  - `cancel()`：abort を要求する。
  - `result`：終端で一度だけ resolve する。
- Mastra の turn の handle は、4c-2 の後に、Mastra の担当と範囲を決める。

### DR-A3-11 終端と message の保存の順序

- 終端の前に、`finalizing` の段を置く。
  1. 終端の CAS の代わりに `finalizing` を CAS で取る。勝った側だけが進む。checkpoint は残す。
  2. 勝った画面が、Drizzle で完了の message を保存する。
  3. main が、`completed`（または該当の終端）にして、checkpoint と台帳を消す。
- 1 で、予定の終端（`finalizing_target_status`、`finalizing_target_reason`）と、`origin_assistant_message_id` を行に書く（Fable の B1）。
  - Stop も `finalizing` を通る（`chatTurnStoreActions.ts:1153`）。予定の終端が `cancelled`・`user_stop` になる。
- 2 の保存は、id で冪等にする（PR 4）。
  - user の行と assistant の行は、別の step で保存される（`chatTurnPersistence.ts:34-38`）。
  - 保存を同じ id で何度流しても、結果が同じになるようにする。
  - assistant の行は、予約の行（`reserved`）が先にあることがある。完了の判定は、id の有無でなく、予約が外れたことで行う。
- 2 の後・3 の前に落ちたとき、回収が `finalizing` の Run を見つけたら：
  - 両方の行が完了していれば、予定の終端にする。
  - そうでなければ、予定の終端が `completed` 系のときは `interrupted`（`resumable` は真のまま）に戻す。再開は、保存の step からやり直す。
  - 予定の終端が `cancelled` のとき（Stop）は、保存を流し直してから `cancelled` にする。Stop は「再開しない」という作者の意思だから。
- 同じ起動の中で、`finalizing` の間に画面を失ったとき：main の見張りが、回収と同じ判定を行う。
- Stop と provider の終端が競っても、`finalizing` を取れるのは 1 つなので、message は一度だけ保存される。
- 途中再開で完了した turn は、起点の会話の、元の turn の位置に保存する。

### DR-A3-11a PR 4・5 の前に決めること（Fable の第 3 版の懸念）

- 台帳の `mainOwnedProvenanceId`：未発行の行では空にし、発行のときに書き足す。`awaiting_approval` は v1 の予約で、使わない。
- 台帳の `executionId`・`chatMessageId`：今は画面の auditContext から来る（`ipc.ts:1647-1648`）。main がこれを、Run の行と照合してから台帳に書く。
- 「owner は生きているが memory に Run が無い」行：interrupted の書込みに失敗した場合や、同じ起動の中で復元した場合に生じる。main が workspace を開くたびに、自分の owner の行を memory と照らす。
- CLI の Run の回収：`cancelled`（`resume_unsupported`）にする。`interrupted` にはしない。

### DR-A3-12 受入れの測定

SessionTasks の材料に対応して、次を受入れの条件に入れる。

- 再開の前後で、文脈の大きさが変わらないこと（同じ turn の中の結果だけを戻すので）。
- 出力の上限で打ち切られた後に、抜けられること（thinking だけの打ち切りを繰り返さないこと）。
- mock の provider で、決定的に確かめる。実 API の測定は、Anthropic の API で、別に伺う。

### DR-A3-13 F0-lite を A と B に分ける

- F0-lite-A（この lane）：`TransportExecutionHandle`、`AgentRunStatus`、`AgentRunInteractionStatus`、`ExecutionAuthority`、`ProjectionAttachment`、`AnalysisReadBasisEntryV1`。
- F0-lite-B（Release B の lane）：`WorkTaskStatus`、`minimal TaskContractSnapshotV1`、`AnalysisReadBasisV1`（束ねた形）。
  - DR-ST-9 で、作者が書く目的と条件の欄が外れた。そのため `TaskContractSnapshotV1` は、中身を定め直す必要がある。
- roadmap の F0-lite と、Release B の前提（`session-tasks-decisions-2026-11.md:84-85`）の「F0-lite」を、F0-lite-A に読み替える注記を、docs の PR で足す。

### DR-A3-14 承認待ちも記録する（問 22・23）

- 経緯：
  - 第 3 版までは「v1 では承認を記録しない」とした。AWA/1 の「却下・時間切れは DB の行を足さない」と、ADR 007・008 の 2026-11-23 の追補（承認の要求はメモリだけ）に合わせるためだった。
  - Gate A の判断記録（#1201・#1206）が、承認の要求は Release A の A3 の Interaction を参照する形で確定した。そこで、このぶつかりを示して利用者に伺った。
  - 回答：問 22「記録する (推奨)」、問 23「及ぼす (推奨)」（第 7 節）。
- 判断：
  - Gate A で承認が要る書換え系の tool の承認待ちを、`approval` の Interaction として記録する。Run は `waiting_approval` になる。
  - AWA/1 の作者の出来事の更新・削除の承認にも、同じ記録を及ぼす。AWA/1 の追補の改訂は、年表の担当が DR-AWA-2（`claude/awa1-docs`）で行う。
  - 記録するもの：承認の要求、承認、却下、live の期限切れ。中身は、対象の要約と作者の判断。Run の終端で、Interaction の `request` と `resolution` を空にする（DR-A3-7）。
  - 保存した承認は、認可に使わない。
    - 再起動の後は、承認のカードを起点の会話に出し直す。
    - 作者が承認したら、Gate A の交換で main が確かめ直し、一回限りの capability を出す。
    - 交換の状態（capability の発行・消費）は、memory の中だけに置く（Gate A の判断記録の 23 行目）。
  - Gate A の live の 30 分の期限が切れたとき：
    - Interaction は `pending` のままにし、Run を `interrupted`（`approval_timeout`）にする。
    - 作者は、後から「続ける」で承認できる。そのときも、交換で確かめ直す。
  - port：A3 は、承認の Interaction の開閉を port に出す。Gate A の A2 は、承認の要求を開くときと閉じるときに、それを呼ぶ（Mastra の担当）。

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 場面                | 持ち主                                            | 受付を閉じる点                                           | 取り消し                                      | 待ちの上限                          | 終わった証拠                          | 再起動の後                     |
| ------------------- | ------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------------ |
| Run の開始の記録    | main（port）                                      | admission の後、transport の前。active が 1 つあれば拒む | なし                                          | 同期                                | 行の作成                              | 回収の対象                     |
| 台帳の書込み        | main                                              | provider の応答の受信時。書けなければ変更系を実行しない  | —                                             | 同期                                | 台帳の行                              | 残る                           |
| checkpoint の書込み | 画面の loop → IPC → main                          | 終端の後は拒む。束縛や台帳と合わなければ拒む             | 失敗したら `resumable` を偽にし、生成は続ける | 同期（枠を待たない）                | 戻り値と `checkpoint_step`            | 残る                           |
| 活動の更新          | main                                              | 終端の後は拒む                                           | なし                                          | なし（間引く）                      | なし                                  | —                              |
| Interaction を開く  | 経路の owner（legacy は画面→IPC、Mastra は main） | Run が終端なら拒む。pending は 1 件                      | Run の終端で `cancelled`                      | live の期限のまま（legacy は無し）  | 行の状態                              | pending のまま残り、再表示する |
| 回答の受理（live）  | 経路の owner、記録は main                         | 受理の前に OCC で pending を消費                         | 二重・遅い回答は拒む                          | 即時                                | 戻り値と行の状態                      | —                              |
| 同じ起動の中の中断  | main の見張り                                     | 当たった時点で transport と tool を止める                | transport の abort                            | 既存の上限（切替 30 秒、quit 5 秒） | transport の終端の後に `interrupted`  | 残る                           |
| 回収                | main（workspace を開いた後）                      | lock が取れた owner の行だけ                             | —                                             | 開く処理の中で有限                  | 更新した件数                          | —                              |
| 途中再開の門        | main                                              | 状態を変えない                                           | —                                             | 即時                                | 門の結果                              | —                              |
| 途中再開の claim    | main                                              | 門の後、OCC で 1 つだけ勝つ。active が 1 つあれば拒む    | —                                             | 即時                                | 行の `execution_owner` と version     | —                              |
| finalizing と終端   | main と画面                                       | `finalizing` を CAS で 1 つだけ取る                      | —                                             | 同期                                | 保存した message と `terminal_reason` | `finalizing` は回収で判定      |
| 破棄                | 作者 → main                                       | `interrupted` だけ                                       | —                                             | 即時                                | `discarded` と checkpoint の削除      | —                              |
| backup              | main の自動 backup                                | 写しの slim で checkpoint を空にする                     | —                                             | 既存                                | 写しの列が空                          | 戻すと続けられない             |
| detach（R1）        | 画面の projection                                 | —                                                        | 配信だけ止める                                | 即時                                | なし（実行は続く）                    | —                              |
| cancel（R1）        | main（abort の command）                          | 終端の後は no-op                                         | provider と process の停止                    | 既存の SIGTERM→SIGKILL              | result の終端                         | —                              |

## 5. 脅威モデルへの影響

- **新しい送信先**：無い。
  - 再開は、snapshot と同じ provider・endpoint だけに送る。endpoint の識別子が違えば再開しない。
- **保存の範囲の拡大**（第 7 節の回答の範囲）：
  - 確認待ちの表示文と、作者の回答。
  - turn の途中の作者の発言、AI の出力、tool の結果の本文。作品の本文と Codex の抜粋を含む。
  - `interrupted` の間は、期限なしで残る。backup の写しには残さない。
  - system prompt と Codex の注入は保存しない。
  - 書いた時点で hidden のものは入らない。後から hidden にした項目を読んでいた Run は、途中再開しない。
- **新しい authority**：
  - Run・Interaction・checkpoint・台帳の Native の表。
  - 台帳の tool_use から、main が読む tool の capability を発行し直す信頼の境界。
    - 台帳は、main が見た provider の応答だけから作る。
    - 変更系は再実行しない。
  - 保存した resolution は、認可に使わない。
- **送り直しの安全**：門（license、policy、egress、route、endpoint）を通し、選り分けを行ってから送る。
- **W12 と DR-MP5-11**：
  - 「再起動後に復元しない」を、次の文に改訂する。
    - 「live な保留は伸ばさない。保存した状態から、作者の操作で同じ Run を再開する。再開した Run でも、保存した回答や承認を認可には使わない。capability は交換の時点で取り直す（Gate A）」。
  - 文の変更は、Mastra の担当の PR で行う。
- **legacy の経路の脅威モデル**：W12 は Mastra の経路の行。legacy の checkpoint の行は、ADR 007 の追補に書く。
- **ADR の追補**（docs の PR に入れる）：
  - ADR 007 §4・§5：直列化した continuation の契約を足す。§4 の最後の文は、この導入を許している。
  - ADR 008 §4：capability の発行の時点に、「台帳の tool_use から、読む tool の再実行に限って発行し直す」を足す。
- **suspend の snapshot**：Mastra の workflows store は永続化しない（変えない）。

### 5.1 脅威モデルの確定（2026-11-27、AskUserQuestion。GDX-PRECHECK-001）

利用者の回答：「この形で確定 (推奨)」。変えるときは改めて伺う。

- 信頼する：Electron main と Native。DB に書くのは、この 2 つだけ。
- 信頼しない：provider の応答と、画面（renderer）が送る途中の状態。
- 範囲内の攻撃：
  1. 乗っ取られた画面が、provider の出していない書換えを途中の状態に入れ、再開で実行させる。
  2. 中断の間に hidden にした内容が、送り直しで AI に渡る。
  3. 再開で書換えが二重に実行される。
  4. 破棄した本文が、backup などの写しに残る。
  5. 2 つの窓や 2 つの起動が、同じ実行を取り合う。
  6. 再開で、別の送信先に送る。
- 必須の防御：
  - main が provider の応答から書く tool 呼出しの台帳。画面から受けた呼出しには、権限を出さない。
  - hidden を読んだ実行は、再開しない。
  - 実行中だった書換えは、再実行しない。
  - 写しでは、途中の状態を空にする。
  - OCC と owner の lock。
  - 再開の前の門（license・policy・送信先）。
- 範囲外（受け入れる）：
  - DB の file を直接書き換えられる、手元の攻撃者。
  - 乗っ取られた画面が、読む tool の結果を偽ること。今も同じで、書換えの権限にはならない。

## 6. PR の分け方（案）

1. **docs だけ**：
   - この文書。
   - ADR 007・008 の追補。
   - roadmap の注記（F0-lite-A／B、A3 の Interaction contract の読み替え、`AgentRunStatus` の値）。
2. **F0-lite-A の型と Native**：表・module・N-API・ADR 003 の手当て。閉じたまま、呼び手なし。schema の版を上げる。
3. **R1**：4c-2 の merge の後に、Mastra の担当と範囲を合わせる。
4. **legacy の経路の記録**：開始・終端・`finalizing`・Interaction・台帳、束縛、同じ起動の中の中断と回収。
5. **legacy の経路の途中再開**：
   - checkpoint、basis、門、claim、選り分け、`runAgentLoop` の入口。
   - 再表示と「続ける」「破棄」の画面。UI は Claude が持つ。
   - 画面は、第 9 節をユーザーに見せた後に作る。
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

### 承認の記録（2026-11-27、AskUserQuestion。contracts の問 22・23、Gate A の改訂の確認）

- 選択肢の全文は contracts に写した。
- 回答：
  - 問 22「承認の記録」：「記録する (推奨)」。
  - 問 23「AWA/1」：「及ぼす (推奨)」。
- 統合者の注：問 23 の問いの文にある「AWA/1 は確認 69 の…で実装済み」は不正確だった。
  - その文は、確認 69 の原文ではなく、AWA/1 の下書きの推奨の中身にある。
  - AWA/1 の実装は、Native の probe 以降が未着手。
- 関係する直し：
  - Gate A の判断記録の 23 行目と第 4 節（Mastra の担当、#1206）。
  - AWA/1 の ADR の追補の改訂（年表の担当、DR-AWA-2、`88845006e`）。

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

### Mastra の担当の第 2 版の照合（2026-11-27）：大きな食い違いなし

- DR-A3-8 に賛成。前提として、MP-9 の判断記録に次の 3 つを足す（Mastra の担当）。
  - 段ごとの保存：tool の呼び出しと結果の本文を、`mastra_message_parts` に段ごとに残す（問 14 の承認の範囲）。
  - 結果ごとの source の印：場面の revision、Codex の版など。read の core が返す版の値を使う予定で、未設計。
  - 実 Mastra の保存の回数（計画の R-2）：段ごとに確実に残るかを、MP-9 の試験で確かめる。
- DR-A3-9 は DR-MP5-5（期限で保留を消費し、turn を終える）と合う。期限の経路で recorder を呼ぶ接続は、Mastra の側で入れる。
- W12 と DR-MP5-11 の改訂文に、「再開した Run でも、保存した回答や承認を認可には使わない。capability は交換の時点で取り直す（Gate A）」を足す（第 5 節に反映した）。
- 改訂は、Mastra を port につなぐ Mastra の担当の PR で入れる。

### Mastra の担当との MP-9 の合意（2026-11-27、DR-MP9-9、#1202）

- 写しの扱い：backup、復元の前の退避、migration の前の snapshot では、終わっていない Run の途中の段の tool の結果の本文を、MP-9 の側でも空にする（問 19・21）。
- 保持：MP-9 の段ごとの本文は Run の終端まで残し、終端で今どおりの digest に置き換える（DR-MP8-4）。
  - 完了した turn の本文は残さない。問 14・15 の範囲の内側。
  - 置き換えは、A3 の port の終端の記録から呼べる口を MP-9 に置く。

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

### 第 2 版の独立レビュー（2026-11-27）

- 実施したレビューは 2 つ：
  - Fable の再諮問（effort high、read-only）。
  - workflow の 4 観点の敵対レビュー（安全、競争と lifecycle、コードとの実現性、正本との整合）。指摘 32 件をそれぞれ反証にかけ、27 件が残った。
- 第 3 版での扱い（指摘の ID は、レビュー側の ID）：
  - **capability の根**（Fable N1、安全 F1）：
    - main が provider の応答から tool 呼出しの台帳を書き、再発行はその一致に限る（DR-A3-4・DR-A3-6）。
    - 冪等の照会には、元の provenance を使い回す。
  - **実行中の tool が残らない**（Fable N2、競争 F1、実現性 F1）：応答の直後・実行の前に台帳を書く。
  - **起点の発言**（Fable N3、実現性 F2、整合 F8）：作者の発言を checkpoint に入れる。`origin_user_message_id` は FK にしない。
  - **Gate A の前の変更系**（Fable N4、整合 F4）：再実行せず、commit 済みかを照会して AI に知らせる。
  - **期限切れの後の回答**（Fable N5、競争 F3、整合 F6）：Interaction は pending のまま、遷移を定義した（DR-A3-3）。
  - **派生した本文への写り**（安全 F4、Fable 懸念 6）：hidden になった source を読んでいた Run は、途中再開しない。版の変わった結果は、対を残して本文だけ置き換える。
  - **`resume_blocked` の二義**（安全 F6、Fable 懸念 9）：`resumable` と `interrupt_reason` に分けた。
  - **門と消費の順序**（安全 F7、Fable 懸念 10）：門を先にし、状態を変えない。claim の時に束縛し直す。
  - **backup**（安全 F8）：写しで checkpoint を空にする（DR-A3-7）。
  - **message の保存の順序**（競争 F2、Fable 懸念 13）：`finalizing` を置いた（DR-A3-11）。
  - **live の回答の後の中断**（競争 F4）：resolution を tool_result に入れる（DR-A3-3）。
  - **lock の粒度**（競争 F5、Fable 懸念 8）：owner ごとの lock file にした（DR-A3-5）。
  - **中断で transport を止める**（競争 F6）：transport の終端を確かめてから interrupted にする。
  - **強制中断の分類**（競争 F7）：中断（非終端）とし、Mastra の条件を読み替えた。
  - **新しい turn との競争**（競争 F8、Fable 懸念 7）：会話ごとの active を 1 つにし、確認を出し、同じ tx にした。
  - **batch の途中の継ぎ目と計数**（実現性 F3・F4）：checkpoint の中身に足し、PR 5 で loop の入口を足す。
  - **basis**（実現性 F5）：`AnalysisReadBasisEntryV1` を F0-lite-A に入れ、basis の無い結果は外す。
  - **対の維持と注入の stub**（実現性 F6）：置き換えにし、stub も basis に入れた。
  - **束ねる値**（実現性 F7、安全 F3）：台帳の値を使う。
  - **file:line の誤り**（実現性 F8、Fable の「記録の不正確」）：第 2 節を直した。legacy の ask_user に期限が無いことを足した。
  - **承認の記録**（整合 F1、Fable B6）：第 3 版では v1 で記録しないとした。その後、問 22・23 で記録する形に改めた（DR-A3-14）。
  - **roadmap の読み替え**（整合 F7）：F0-lite を A と B に分け、docs の PR に roadmap の注記を入れる。
  - **送信先の変化**（Fable 懸念 11）：endpoint の識別子が違えば再開しない。
  - **ADR 008 の追補**（Fable 懸念 12）：第 5 節に足した。
- Fable の問 3 の判断：
  - PR 1（docs）は、上を入れれば進めてよい。
  - PR 2 は、列に効く点が文書で決まってから。第 3 版で決めた。
  - PR 4・5 は、残りの全部、B6 の照合、ユーザーに見せる点が条件。
- **Mastra の担当の第 3 版の照合（2026-11-27）**：
  - (1) 強制中断を中断として記録すること、(3) 期限切れでも Interaction を pending のままにすること、(4) MP-9 の前は resumable を偽にすることは、合意。
    - Mastra の owner は、「中断の記録」と「終端の記録」を別々の操作として 1 回ずつ呼ぶ。turn と audit は、今どおり終わる。
  - (2) 台帳の時点への異論を受けて、capability の発行の時点でなく、tool の呼出しを受け取った時点に直した（DR-A3-4、ADR 008 の追補 1）。
- 第 8 節の「Mastra の担当」の (4) にある「再起動の後の回答は、新しい Run の中で受ける」は、範囲の拡張で置き換わった。今は、同じ Run の再開の中で受ける。

### 第 3 版の Fable の再確認（2026-11-27、888b20e2e を点検）

- 結論：
  - PR 2 は、列に効く B1・B2 と、K1・K2 を決めれば進めてよい。
  - 台帳の時点の変更（888b20e2e）は、blocker でない。
- 第 3 版の後の直し（この commit）：
  - B1：`finalizing` に予定の終端と assistant の行の id を持たせた。保存は id で冪等にし、回収の判定を定めた（DR-A3-11）。
  - B2：`not_resumable_reason`、`resume_block_detail`、`resume_blocked_at` を足した。門は status と `interrupt_reason` を変えない。写しの中の非終端の行を倒す値を足した。
  - K1：version を上げるのは状態の変更だけにした。
  - K2：AI Audit とのつなぎは `audit_execution_ids` の列にした。
  - K3：`waiting_approval` を active の index に入れた。
  - K4：冪等の key は `idempotency_requests` に置く。
  - PR 4・5 の前の懸念は、DR-A3-11a に書いた。
  - 写しの 2 経路（復元の前の退避、migration の前の snapshot）も、途中の状態を空にする（DR-A3-7）。
  - 同期フォルダの上の回収は、古い行に限った。
  - lock は、Native が Rust の `File::try_lock` で握る。
- ADR の直し：
  - ADR 007 の追補 5 を、経路ごとに書き分けた。
  - ADR 008 の追補は、次のように直した。
    - 台帳から capability を発行し直す経路を置かない（読む tool は capability を使わない）。
    - stage の tool を、変更系と同じ扱いにした。
    - token は保存せず、状態だけを保存する。

## 9. 画面で見える挙動（ユーザーに見せる）

PR 5 の画面を作る前に、次をユーザーに見せる。

1. **中断の表示**：起点の会話に「中断」と、「続ける」「破棄」の操作を出す。破棄の置き場所と文言を見せる（統合者の注 1）。
2. **新しく送るとき**：中断した実行がある会話で、送信・再生成・message の削除・会話の消去をすると、確認が出る。「中断した実行を破棄して進めますか」。
3. **続けられない場合**（「続けられない」とその理由を出す）：
   - 中断の間に hidden にした項目を、その実行が読んでいた。
   - backup、復元の前の退避、migration の前の snapshot から戻した。
   - 途中の状態を書けなかった。
   - CLI、Codex App Server の実行。
   - 当面の Mastra の経路。
4. **再開を止める場合**：再開の門で止まったときは、理由を出す。後で再試行できる。
   - endpoint や model が変わっていた。
   - license、policy、送信先の制限に当たった。
5. **落ちる直前の生成**：途中まで出ていた出力は消え、最後の切れ目からやり直す。provider への送信と費用は、もう一度かかる。
6. **実行中だった変更系の tool**：再実行しない。AI には、commit 済みか未実行かを伝える。`run_app_command` などは「結果が分からない」と伝える。
7. **中断の間に変わった場面や項目**：その結果だけを外して、AI に知らせる。
8. **同期フォルダの上の workspace**：中断の検出が遅れることがある（最長で既定 24 時間）。
9. **承認待ちで中断した実行**（問 22・23）：再開すると、承認のカードを起点の会話に出し直す。承認すると、main が確かめ直してから書き換える。年表の承認のカードも同じ。

### 回答（2026-11-27、AskUserQuestion）

- hidden：「続けられないとする (推奨)」。
- backup：「backup には入れない (推奨)」。
- 新しい送信：「確認してから破棄 (推奨)」。
- 3 点とも第 3 版の設計（DR-A3-6・DR-A3-7）と同じ。
- 破棄の置き場所と文言（1）は、画面の PR の前に、改めて画面の形で見せる。
