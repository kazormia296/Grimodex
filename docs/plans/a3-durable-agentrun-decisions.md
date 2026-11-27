# A3：durable な AgentRun と確認待ち（F0-lite・R1 を含む）の判断記録

- 状態：**草稿（2026-11-27）**。第 7 節の問いにユーザーが答えるまで、製品コードを変えない（[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001) の `[precheck]`）。
- 担当：A3 の lane（grimodex-59）。統合者「統合」の引き継ぎ（2026-11-27）による。
- 根拠のユーザー決定：2026-11-26 の統合者の確認の問 10（A3 は「新しい lane で実装まで」。保存の範囲の拡大と DR-MP5-11 の変更は起案の段で伺う）。原文は `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-26-integrator-s11-leftovers.md`。
- 委任：この lane は NIR-1 の残レーンではないので、AGENTS.md の事前委任は及ばない。問 10 が委ねた「起案から実装まで」の技術判断はこの文書に記録し、保存の範囲の拡大、DR-MP5-11 と W12 の変更、新しい authority は第 7 節で伺う。
- 正本：[agent-collaboration-roadmap.md](agent-collaboration-roadmap.md) の F0-lite・R1・A3、[ADR 007](../adr/007-agent-collaboration-execution-boundary.md) §2〜§5、[ADR 008](../adr/008-agent-default-mode-and-write-approval.md) §4・§5、[SessionTasks の判断](session-tasks-decisions-2026-11.md)、[MP-5 の判断](mastra-mp5-decisions.md) の DR-MP5-11、[脅威モデル](mastra-migration-threat-model.md) の W12。

## 1. 範囲

- 含む：
  - F0-lite のうち A3 が使う型：`TransportExecutionHandle`、`AgentRunStatus`、`AgentRunInteractionStatus`、`ExecutionAuthority`、`ProjectionAttachment`。
  - R1：legacy の API と CLI の stream の handle を、detach／cancel／result に分ける。
  - A3：Run と Interaction の durable な記録、起動時の回収、起点の会話での再表示。
- 含まない：
  - R0（CLI の timeout）。A3 の State は「R1 と F0-lite の state contract で Blocked」で、R0 は前提に入らない。
  - A4a 以降（Background Session、UI、hardening）。
  - Gate A（A1・A2。担当は Mastra）。
  - Release B の部分：子の Run、grant の受け渡し、read-set の保存、Task の表。
- F0-lite のうち `WorkTaskStatus`・`minimal TaskContractSnapshotV1`・`AnalysisReadBasis*` は Release B に回す（DR-A3-9）。

## 2. 確かめた事実（基点 origin/master `c063a0803`）

- schema の版は 48（`grimodex-core/src/lib.rs:3`）。版ごとの migration は `grimodex-db/src/migrate.rs` の `migrate_impl` に `if current < NN` の区画で足す。MP-7 の 6 表（`mastra_*`）は 47 で入った。予定では 48 以降を M3 の ERM と年表の CED/1 が取る。
- 実行の状態を持つ可変の記録は無い。AI Audit（`ai_audit_events`）は追記だけの hash chain で、`execution_id`・`operation_id` を持つ（`migrate.rs:2245`）。
- OCC と冪等性は既存の形がある：
  - OCC：`WHERE id=? AND version=?` で版を検査し、違えば印付きのエラーで返す（`plot_threads.rs:1502`）。
  - 冪等性：`idempotency_requests` と `run_atomic_create`（`idempotency.rs`）。
- 起動時の回収の前例は `post_effect_runs` だけ。DB を開くときに `running` を `failed` にする（`migrate.rs:8854`）。
  - standalone MCP も同じ DB を開く（`grimodex-mcp/src/lib.rs:75` の共有 lease）。開くたびに流す形は、生きている Electron の Run を壊しうる。
- 確認待ちの保留は、どの経路もメモリの中だけにある：
  - legacy：renderer の単一の resolver（`chatUserQuestionRuntime.ts:19`）。
  - Mastra：main の `questionsByRequest`（`mastraTurnOwner.ts:556`）。期限は `ask_user` が 30 分、UI 系が 10 秒。
  - ApprovalRequest：AWA/1 もメモリだけに置く（ADR 008 の追補 5）。
- stream の cleanup は abort を兼ねる（`chatStreamTransport.ts:349`、`cliApi.ts:331`）。終端の一回性は renderer の中のフラグで守られている。
- ID は 2 系統：
  - legacy／CLI：`streamId = executionId`（renderer の `randomUUID`）。
  - Mastra：`turnId`（renderer が発番）。
  - Mastra の経路は、まだ chat の store につながっていない（`src/application`・`src/features/chat` に呼び手が無い）。
- Mastra の担当との合意（2026-11-27）：
  - Run の記録は `mastra_*` と別の表・別の module に置く。つなぎは `chatSessionId`・`turnId`。
  - Mastra の保留は A3 の口を Mastra 側から呼ぶ。`mastraTurnOwner.ts`・`mastraAgentTurnGate.ts`・`mastraAgentTurnWire.ts`・`mastraAgentTurnResponder.ts` と W12 は触らない。
  - R1 は 4c-2 の merge の後に、差分の範囲を合わせてから入る。

## 3. 判断（案）

- **DR-A3-1 置き場所と authority（第 7 節の問 3）。**
  - grimodex-db に新しい module（`agent_runs.rs`）と表 2 本（`agent_runs`、`agent_run_interactions`）を置き、Run と Interaction の唯一の正本にする。
  - D2a closed で、generic SQL を通さない。書くのは typed N-API（main 専用）だけ。renderer は IPC 経由で読む。
  - schema の版は空欄にしておき、統合者と決める。
- **DR-A3-2 Run の列。**
  - ID と対象：`run_id`（main が発番）、`project_id`、`chat_session_id`、`turn_id`、`route`（legacy｜cli｜mastra）。
  - model と transport の snapshot：provider と model の ID だけ。prompt は入れない。
  - 実行の権限：`execution_owner`（main の起動ごとの ID）。
  - 状態：`status`、`activity_at`、`terminal_reason`、`version`（OCC）。
  - つなぎ：AI Audit の `execution_id`（transport の履歴は複製しない）。
  - Release B 用に今は空で置く列：`continuation_of`（親の run_id）、`task_id`。
  - status は `running`・`waiting_user`・`waiting_approval`・`completed`・`failed`・`cancelled`・`interrupted` の 7 つ。終端は後ろの 4 つ。
  - terminal_reason は `completed`・`user_stop`・`provider_error`・`context_window_exceeded`・`limit_tokens`・`output_truncated`・`authority_lost`・`renderer_lost`・`app_shutdown`。
  - 終端は一度だけ記録する。2 度目は OCC か状態の検査で拒む（ADR 007 不変条件 7）。
- **DR-A3-3 Interaction の列。**
  - ID と対象：`interaction_id`、`run_id`、`chat_session_id`。
  - 種類：`kind` は `user_question`・`approval`。`plan_amendment` は Release B のために値だけ予約する。
  - 呼出し：`tool_call_id`、`tool_name`、`args_digest`。
  - 中身：`request`（表示文。第 7 節の問 1）、`resolution`（第 7 節の問 1）。
  - 状態：`status`、`version`。status は `pending`・`resolved`・`cancelled`・`expired`・`superseded` の 5 つ。
  - pending は root の Run ごとに 1 件まで（部分 unique index）。resolution は OCC と冪等性の key で一度だけ。
  - `approval` の列の形は ADR 008 §5 の ApprovalRequest に合わせる。分担は Mastra の担当との合意（2026-11-27）による。
    - A3 が持つもの：durable な `waiting_approval` の Interaction（保存、再起動の後の扱い、画面）。
    - Gate A が持つもの：交換の authority（確かめ直し、capability の発行と消費）だけ。Gate A の承認要求は A3 の `interaction_id` を参照する。
    - Gate A の草稿（`claude/gatea-design`、未 merge）では、ApprovalRequest を main の memory に持ち、再起動の後に復元しない（DR-GA-3）。
- **DR-A3-4 起動時の回収。**
  - Electron main が workspace の DB を握る時点で、その DB について回収する。起動の直後に開いた workspace だけでなく、後から開いた workspace と切り替えた先の workspace も含む（Mastra の担当の指摘）。
  - 対象は「今の起動の ID でない `execution_owner`」を持つ `running`・`waiting_*` の Run で、`interrupted`（`app_shutdown`／`renderer_lost`）にする。
  - MCP の起動では回収しない。
  - 回収で Interaction は消さない。pending の扱いは第 7 節の問 2 で決める。
  - 孤児の `running` を成功として扱わない。
- **DR-A3-5 live の保留を伸ばさない。**
  - durable な記録は live な保留の寿命を変えない。`ask_user` の 30 分、UI 系の 10 秒、書込み行列の枠は今のまま。
  - 期限が切れた保留は `expired`、Stop や強制中断で閉じた保留は `cancelled` として記録する。
  - 期限や窓の喪失は、Run の終わった証拠にしない。終わった証拠は start の終端の結果（DR-MP5-11 と同じ）とする。
- **DR-A3-6 再起動の後の承認は、実行の権限に交換しない。**
  - A3 v1 では、保存された `resolution` を capability の根拠にしない。
  - 再起動の後の続きは新しい Run（`continuation_of` つき）とし、承認は main がその Run の中で改めて取る（ADR 008 §4。既発行の capability は延命しない）。
  - 保存した承認を交換する経路は、Gate A と Release B で決める。
- **DR-A3-7 Mastra への口。**
  - electron/main に `AgentRunRecorder` の port を置く。操作は開始の記録、Interaction の開閉、終端の記録。
  - legacy・CLI の経路は A3 が接続する。Mastra の経路は Mastra の担当が `mastraTurnOwner.ts` から呼ぶ。
- **DR-A3-8 R1。**
  - `chatStreamTransport.ts` と `cliApi.ts` の `cleanup` を `detach()`（UI への配信を止めるだけ）と `cancel()`（abort の要求）に分ける。`result` は終端で一度だけ resolve する。
  - Mastra の turn（start が終端まで await する形）の handle は、4c-2 の後に Mastra の担当と決める。
- **DR-A3-9 F0-lite の Task の部分は Release B に回す。**
  - DR-ST-9 で目的と条件の欄が外れたので、`minimal TaskContractSnapshotV1` は中身を定め直す必要がある。
  - `WorkTaskStatus`・`AnalysisReadBasis*` とともに Release B の lane に回し、roadmap の F0-lite に注記する。
- **DR-A3-10 削除。**
  - Run と Interaction は project の削除で消し、`chat_session_id` の会話の削除でも消す（cascade）。
  - AI Audit は今のまま消えない（forward-only）。
  - backup と export に入るかは、第 7 節の問 1 で伺う。

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 場面 | 持ち主 | 受付を閉じる点 | 取り消し | 待ちの上限 | 終わった証拠 | 再起動の後 |
| --- | --- | --- | --- | --- | --- | --- |
| Run の開始の記録 | main（port） | transport の開始の前に記録。記録できなければ開始しない | なし | 同期 | 行の作成 | 回収の対象 |
| 実行中の活動の更新 | main | 終端の記録の後は拒む | なし | なし（間引く） | なし（観測だけ） | — |
| Interaction を開く | 経路の owner（legacy は renderer→IPC、Mastra は main） | Run が終端なら拒む。pending は 1 件 | Stop・強制中断・期限で `cancelled`／`expired` | 今の live の期限のまま | 行の状態 | 問 2 |
| 回答・承認の受理 | 経路の owner（live）、main（記録） | 受理の前に OCC で pending を消費 | 二重・遅い回答は拒む | 即時 | 戻り値と行の状態 | 問 2 |
| 終端の記録 | main | 一度だけ。2 度目は拒む | — | 同期 | 行の terminal_reason | — |
| 起動時の回収 | main の起動 | 前の起動の owner の行だけ | — | 起動処理の中で有限 | 更新した件数 | — |
| detach（R1） | renderer の projection | — | 配信だけ止める | 即時 | なし（実行は続く） | — |
| cancel（R1） | main（abort の command） | 終端の後は no-op | provider と process の停止 | 既存の SIGTERM→SIGKILL | result の終端 | — |

## 5. 脅威モデルへの影響

- 新しい送信先は無い。
- 保存の範囲が広がる：AI が出した質問・承認の対象の表示文と、作者の回答を DB に残す（問 1）。prompt の本文と tool の結果の本文は保存しない。
- W12 の「再起動後に復元しない」を「live な保留は復元しない。記録として表示文を残し、起点の会話で再表示する」に改訂する（問 2。改訂は Mastra の担当と合わせ、文の変更は Mastra の担当の PR で行う）。
- 新しい authority：Run と Interaction の Native の表（問 3）。認可には使わない（DR-A3-6）。
- suspend の snapshot（Mastra の workflows store）は永続化しない（変えない）。

## 6. PR の分け方（案）

1. この文書（docs だけ）。
2. F0-lite の型と、Native の表・module・N-API（閉じたまま、呼び手なし）。schema の版を上げる。
3. R1（4c-2 の merge の後、Mastra の担当と範囲を合わせる）。
4. legacy・CLI の経路の記録、起動時の回収、起点の会話での再表示。
5. Mastra の経路の接続（Mastra の担当が持つ。A3 は port を出す）。

roadmap の A3 の出口条件との対応：

- 行が移動と再起動を越えて残る：PR 2・4。
- 孤児の running を成功扱いしない：DR-A3-4。
- pending を起点の会話で再表示：PR 4（問 2）。
- 二重回答、Stop と回答、終端と遅い回答で二度 resolve しない：DR-A3-3・DR-A3-5。

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

### advisor（read-only）

（記入待ち）
