# Release B（SessionTasks）の設計（起案）

- 状態：**起案（draft）**。第 10 節の回答があるまで、どの判断も確定しない。実装はしない。
- 基点：`origin/master` `3a0505d5c`。この PR は文書だけを変える。
- 根拠：[SessionTasks の判断記録](session-tasks-decisions-2026-11.md)（DR-ST-3〜11）、ADR 007・008・012・013、[A3 の判断記録](a3-durable-agentrun-decisions.md)、[Gate A の判断記録](gate-a-write-safety-decisions.md)、[Roadmap の Release B](agent-collaboration-roadmap.md#release-b--sessiontasks-minimal)。
- 担当（DR-ST-11）：設計の起案まで。実装の担当は起案の後に決める。

## 1. 範囲

- 含む：手順（SessionTask）の保存と状態、AI が手順を書く tool、完了の判定、Task Grant（承認した範囲）、止まったときと続行の扱い、chat の画面、旗を開けるまでの段。
- 含まない：実装。ADR・脅威モデルの本文の改訂（第 8 節に列挙だけする）。
- 他の担当が持つもの：Gate A の A1・A2 と A4（Mastra）、A3 の Run・Interaction・途中再開、MP-9。
- 作らないもの：Project 全体の task 管理画面、作者が書く目的と条件の欄（DR-ST-9）、Project 側の Work への昇格。
- 到達点（DR-ST-11）：旗を開けて製品で使える所まで。

## 2. 確かめた事実

- master に `WorkTask`／`WorkPlan` の型や表は無い（`src`・`electron`・`src-tauri/crates` の grep で 0 件）。`agent_runs` の表も無い（A3 の実装は未 merge）。
- ADR 008 の権限の層は、AgentPreference → AiPolicy → **Task Grant** → ApprovalRequest → 一回限りの Capability。`mutate / task-scope` は承認済みの Task Grant の範囲なら実行でき、`destructive` は毎回の承認。
- Gate A の判断：Task Grant が入るまで `mutate/task-scope` も個別の承認（DR-GA-2）。承認の要求を作る時点で入力の digest と base version を固定する（DR-GA-3）。利用者への問いは「まとめて任せる承認は Release B で入ります」と説明した上で回答を得た（同 第 7 節の問 1）。
- 現行の Mastra の経路は、書き込みの base version を実行のときに読み直す（Gate A の判断記録 第 2 節）。
- 保存まわり（基点で確認）：
  - DB の schema は 48（定数は `src-tauri/crates/grimodex-core/src/lib.rs`、DDL は `grimodex-db/src/migrate.rs`）。
  - D2a の表の台帳は 95 表（closed 37、read-open 58）で、件数を試験が固定する。新しい表は台帳と Electron 側の fixture の両方に足す。
  - `chat_sessions` は project の削除で cascade、`chat_messages` は会話の削除で cascade。
  - 自動の backup の slim が消すのは chunk と FTS だけ。復元の前の退避と migration の前の snapshot は DB 全体の写し。
  - 作品の ZIP の書き出しは、会話を表ごとに明示して書く。新しい表は自動では入らない。
  - 作品のスナップショットの復元は、会話の表を消さない。
- tool と画面（基点で確認）：
  - tool は manifest で 44 本（read 26）。legacy の定義も 44 本、Mastra の経路は 43 本（read 21、画面操作 7、書き込み 15）。
  - 承認なしで状態を変える tool の前例は画面とレイアウトの操作で、DB の状態を書く tool の前例としては弱い。
  - 帯の置き場所の候補は、`ChatPanel` の `ContextBar` の直後。`ChatPanel` は起動時の chunk に入らず、配置されていれば idle で先読みされる。
- 止まったときの今の挙動（**legacy の agent loop**。Mastra の経路は確かめていない）：
  - tool の結果の予算は、model の文脈の窓の 30%（最低 2,000 token）。
  - `limit_tokens`・`limit_calls` では、最後の応答を 1 回求めて止まり、「続行」を出す。回数の上限は窓に応じて 10・12・16・25。
  - 保存するのは本文と、tool の呼出しの要約。tool の結果の本文は会話に保存しない。
  - 「続行」は新しい指示を送る。tool の呼出しと結果は、次の turn に戻らない。
  - 文脈の超過は送信の失敗になる。本文が DB に残るのは、assistant の行を先に予約した場合だけ。
- A3 の判断：
  - `agent_runs` に、Release B 用の `continuation_of`・`task_id` を空で置く（DR-A3-2）。
  - 会話ごとの active な Run（`running`・`waiting_user`・`waiting_approval`・`finalizing`）は 1 つまで（同）。
  - 子の Run、grant の受け渡し、Task の表は Release B の部分（第 1 節）。
  - 保存した承認は認可に使わない（DR-A3-14）。
  - Mastra の経路の Run は、MP-9 と再入の実証まで途中再開できない（DR-A3-8）。

## 3. 仮置き（前提の実装が無いので、決定の文だけに依る）

| 番号 | 仮置き | 依る先 | 違った場合に変わる所 |
| --- | --- | --- | --- |
| K1 | 承認は main が要求を作り、確定の後に一回限りの Capability に交換する | DR-GA-3 | DR-RB-6 の検査の置き場所 |
| K2 | 承認待ちと質問は A3 の Interaction、Run は `task_id` を持つ | DR-A3-2・3・14 | 手順と「待ち」の結び方 |
| K3 | tool の分類（`effect`／`approvalMode`）は Gate A の A1 | DR-GA-2 | DR-RB-4 の分類 |
| K4 | 履歴と再開は MP-9 の message が正本 | DR-A3-8 | 再起動をまたぐ確認待ちが使える時期 |
| K5 | AI の利用方針が壊れていたら書き込みを止める A4 が、A2 の前に入る | DR-ST-11 | Grant の下の policy の検査 |
| K6 | schema の版の番号は決めない（A3 の PR などと競合しうる） | — | 実装の PR で割り当てる |

## 4. 判断（案）

### DR-RB-1 置き場所と authority

- grimodex-db に表 3 本を置く。名前は仮。
  - `session_work_plans`：`plan_id`、`project_id`、`chat_session_id`、`status`（`active`｜`closed`）、`version`、時刻。
  - `session_work_tasks`：`task_id`、`plan_id`、`project_id`、`position`、`title`、`criterion`（任意）、`expects_write`、`status`、`status_reason`、`done_by`（`agent`｜`author`）、`version`、時刻。
  - `session_work_task_links`：`task_id`、`kind`（`agent_run`｜`ai_audit_execution`｜`chat_message`｜`tool_call`）、`ref_id`、`effect`、`outcome`、時刻。本文を持たない。
- 唯一の正本は Native の SQLite（ADR 007 §2・§4）。会話の表への FK だけを持ち、作品の表への FK は持たない。書くのは typed N-API（main 専用）だけで、generic SQL は通さない（A3 の DR-A3-1 と同じ形）。Mastra の thread metadata には置かない。
- 会話ごとに `active` な plan は 1 つ。単発の質問では plan を作らない。作るのは、複数の手順、受け入れ条件、複数の書き換え、承認待ち、サブエージェント、会話をまたぐ継続、作者の明示のどれかがあるとき（Write-Safety Roadmap の Gate C の引き継ぎ事項）。
- Project 側の Work（ADR 012）はこの表に載せない。将来 Project 側の型を作るときに、型の対応を決める。
- すべての手順が `done` か `cancelled` になった plan は、main が自動で閉じる。作者の片付けを要らなくするため。
- 未完了の手順が残る plan は自動では閉じない。作者は 1 回の操作で plan ごと閉じられる。放置した plan に新しい依頼の手順が混ざることは残る（出口条件「恒常的な手作業の片付けを要らない」に対する残り）。

**保存する内容と削除**（保存の範囲の拡大。第 10 節で伺う）

- 保存する：手順の短い題（上限 200 字）、条件（任意、上限 500 字）、状態と理由の短い文、順序、版、時刻、参照の ID。
- 保存しない：作品の本文、tool の結果、承認の中身、Task Grant（DR-RB-6）。
- 題と条件は AI が書く文なので、作品の内容（人物名や展開）が写りうる。
- 会話と project の削除で cascade。
- 写し（案）：自動の backup、復元の前の退避、migration の前の snapshot には、会話の message と同じく残り、復元すれば戻る。ZIP の書き出しには v1 では入れない（会話の message は書き出すので、ここは違う）。
- 作品のスナップショットを復元しても、手順は戻らない。`done` の手順の書き換えが作品に無い状態になりうる。画面は「適用した」と「今の作品にある」を分けて書く（ADR 007 の不変条件 15）。

### DR-RB-2 状態と、誰が変えられるか

状態（`WorkTaskStatus`）：`ready`、`in_progress`、`blocked`、`review`、`done`、`cancelled`。

| 遷移 | AI | 作者 |
| --- | --- | --- |
| 手順の追加・並べ替え | できる | できる |
| `ready` ⇄ `in_progress`、→ `blocked`・`review` | できる | できる |
| → `done` | DR-RB-3 の条件を満たすときだけ | できる |
| `done` → 戻す | できない | できる |
| → `cancelled` | `criterion` が無く `expects_write` が偽の手順だけ | できる |
| `cancelled` → 戻す | できない | できる |
| `title`・`criterion` の書き換え、手順の削除 | できない | できる |
| `expects_write` を真から偽に | できない | できる |

- AI が自分の条件を弱められないこと（ADR 007 の不変条件 12）は、この表を main が強制して守る。AI の申告や prompt の指示に頼らない。
- 作者が手で `done` にする操作は、書き換えの承認ではなく、何も書き換えない。画面は「作者が完了にした」と分けて出す（`done_by`）。
- `criterion` を書けるのは、手順を作るときの AI と、作者の編集。
- `in_progress` は plan の中で 1 つまで。tool の呼出しを手順に結び付けるため。
- すべての更新は `version` を条件にする。古い版の更新は拒む（Roadmap の出口条件）。
- 承認待ち・質問待ちは、手順に別の状態として持たない。A3 の Interaction から導いて表示する。

### DR-RB-3 完了の判定（DR-ST-3 の実装の形）

「書き換えを伴う手順」を、AI の申告だけで決めない。

- main は、tool の呼出しを受け取った時点で `in_progress` の手順に結び付けて `links` に書く。`effect` は manifest から取る。
- 結び付いた呼出しに `mutate`・`destructive` があれば、main が `expects_write` を真にする。
- AI が `done` にできる条件：
  - `expects_write` が偽。
  - `expects_write` が真なら、結び付いた書き換えが 1 件以上確定していて、承認待ちや結果不明の呼出しが残っていない。
- `stage`（提案）だけで終わった手順は `review`。作者が提案を適用したら、main が `done` にする（適用の経路に手順の参照を通す）。
- 拒否・失敗した書き換えしか無い手順は `done` にできない。
- 限界：手順に結び付けずに行われた書き換えは、この判定に出ない。その書き換えも承認の仕組み（DR-GA-3、DR-RB-6）は通る。

### DR-RB-4 AI の tool

| 名前（仮） | 内容 | 分類 |
| --- | --- | --- |
| `get_session_plan` | 今の plan と手順を返す | `read / none` |
| `update_session_plan` | 手順の追加・並べ替え・状態の変更（DR-RB-2 の範囲） | `stage / none`（作品の正本は変えない） |
| `request_task_grant` | これから行う書き換えの範囲を示して、作者の承認を求める | 承認の要求を作るだけ |

- 使えるのは親の turn の agent だけ。子（sub-agent）には渡さない（ADR 007 の不変条件 14）。
- 経路は Mastra の経路だけ（43 本が 46 本になる）。legacy の経路には足さない（前提に MP-6・MP-9 があるため。起案者の読み）。
- plan の内容は、毎 turn の自動の注入にしない。AI は `get_session_plan` で読む。active な plan がある会話では、「未完了の手順がある」の 1 行だけを案内に足す。DR-ST-9 の「要約から独立して注入する Task Contract は作らない」に合わせるため。
- 分類の名前と扱いは、Gate A の A1 と合わせる（K3）。

### DR-RB-5 F0-lite-B の 3 つの型

- `WorkTaskStatus`：DR-RB-2 の 6 値。
- `TaskContractSnapshotV1`：`{ schemaVersion: 1, planId, taskId, taskVersion, title, criterion?, expectsWrite }`。DR-ST-9 の後は、目的や制約の欄を持たない。承認の要求と完了の判定が「どの版の手順か」を固定するための内部の写しで、AI に毎 turn 送らない。
- `AnalysisReadBasisV1`：`{ consistencyModel: "capture-on-first-read", runId, entries: AnalysisReadBasisEntryV1[] }`。Entry は A3 の型を束ねるだけ。DR-RB-6 の版の照合に使う。

### DR-RB-6 Task Grant

- 対象は `mutate / task-scope` の tool だけ。`destructive` は対象にしない。
- 範囲：plan、project、会話、操作（tool の名前）、対象。対象は、更新なら AI が挙げた項目の ID の一覧、作成なら項目の種類。
- 付与：AI が `request_task_grant` で範囲を示し、作者がカードで承認する。承認の仕組みは Gate A と同じ（DR-GA-3）。範囲を広げるのは新しい承認（ADR 007 §6）。
- 実行のとき、main が呼出しごとに照らす：plan が active、project・会話・操作・対象が範囲の中、AI の利用方針、取り消されていないこと。そのうえで一回限りの Capability を出す。外れたら個別の承認に回す。
- 版：更新の base は「この Run で AI が最後に読んだ版」（`AnalysisReadBasisV1`）。読んでいない対象や、読んだ後に版が変わった対象は、個別の承認に回す。作者が見ないまま、並行の編集を上書きしないため。
- 失効：作者の取り消し、Stop、plan の終了、AI の利用方針の変更、project・workspace・profile の切替、アプリの終了。
- 保持：**main の memory だけに置く**。再起動の後は効かず、同じ範囲を示して承認し直す（DR-A3-14「保存した承認は認可に使わない」に合わせる）。何を承認したかの記録は `links` に残すが、認可に使わない。
- 範囲の中では、回数の区切りで止めない（Roadmap の出口条件）。書き換えは今の Undo で戻せる形で行い、画面に件数を出す。

### DR-RB-7 止まったときと続行（DR-ST-5 の条件 2）

- 回数の上限の撤廃は、停止が効く経路から（DR-ST-5 の条件 1）。
- `limit_tokens`：今の形（最後の応答を 1 回求めて止まり、「続行」）を保つ。AI が自分で要約して回り続ける形は作らない（案）。
- 文脈の超過：それまでの本文と手順の状態を必ず残す。assistant の行を先に予約する形にそろえる（案）。
- 止まっても `in_progress` の手順はそのままにする。完了や取り消しに倒さない。
- 続行は、手順の ID と状態を持ち越す。読んだ本文を全部持ち越す形は採らない（DR-ST-1）。何を読んだかは ID と版だけを渡す。持ち越す形の本体は MP-9。
- Mastra の経路の今の挙動を確かめてから、実装の PR で形を決める（第 9 節）。

### DR-RB-8 承認待ちとほかの手順（v1）

- v1 は子の Run を作らない。承認や質問を待つ間は、Run 全体が止まる。
- 理由：A3 は会話ごとの active な Run を 1 つに固定した（DR-A3-2）。ほかの手順を進めるには、子の Run と、その制約の変更が要る。
- 影響：画面の試作で見せた「1 つが承認待ちでも、ほかの手順は進む」は、v1 では起きない。Task Grant の範囲の中の書き換えは、そもそも待たない。

### DR-RB-9 画面

- chat の中に手順の帯を置く：今の手順、`done` の数と全体、確認待ち、`done` を戻す操作、承認した範囲の表示と取り消し。
- 進み具合と実行の telemetry は分けて表示する（Roadmap の UI）。
- 置き場所の候補は `ContextBar` の直後（会話をスクロールしても残る）。`ChatPanel` の chunk に入れ、起動時の読み込みに足さない。store や型の静的な import で起動時の JS が増える分は実測する。上限の緩和は A1 と 4c-2 に限られる（contracts の問 28）ので、超える場合は伺う。
- 見た目は試作を元に、実装の担当が詰める。

### DR-RB-10 旗と、開けるまでの段

旗は `sessionTasks.enabled`（Roadmap の flag の方針）。到達点は目標で、旗を開ける許可ではない（**統合者の読み**。利用者の言葉ではない）。

1. 前提：Gate A の A1・A2 と A4、A3、MP-6、MP-9。Mastra の旗 L は A2 の完了の前に開けない。
2. 保存と main の規則（旗は閉）。
3. AI の tool（旗は閉。合成の作品で確かめる）。
4. Task Grant（旗は閉）。
5. 画面。
6. 旗を開ける前に個別に確認する：送信の形、開示と同意、保持、削除のときの消去、公開。

脅威モデル（第 6 節）の確認は、これとは別に、実装の前に伺う（GDX-PRECHECK-001）。実 API の測定（DR-ST-8）をどの段で行うかは未確認（第 9 節）。

## 5. owner と lifecycle（GDX-PRECHECK-001）

| 経路 | owner | 始まり | 停止・失効 | 失敗と再起動 |
| --- | --- | --- | --- | --- |
| plan・手順の書込み | main（typed N-API） | tool の呼出し、作者の操作 | Stop の後の tool の書込みは拒む | 版が違えば拒む。書けなければ AI に失敗を返し、手順の表示は前の状態のまま |
| 呼出しと手順の結び付け | main の turn owner | 呼出しを受け取った時点 | turn の終端 | 書けない場合は、その手順を AI が `done` にできない |
| Task Grant | main（memory） | 作者の承認 | DR-RB-6 の失効 | 再起動で消える。復元しない |
| 帯の表示 | renderer | 会話を開く | 会話の切替で取り直す | 読めなければ帯を出さず、理由を出す |

## 6. 脅威モデルへの影響（draft。利用者の確認までは確定しない）

- 信頼する：作者の操作、main、Native の DB の authority。
- 信頼しない：AI の出力（作品の本文や外部の内容に仕込まれた指示を含む）、renderer からの認可の主張、保存した手順の文（後の turn で指示として扱わない）。
- 対象の攻撃と防御：

| 攻撃 | 防御 |
| --- | --- |
| AI が条件を緩める、手順を消して完了に見せる | DR-RB-2 を main が強制 |
| 書き換えていないのに「適用した」と完了にする | DR-RB-3 |
| 仕込まれた指示が広い Grant を求める | 付与は作者の承認だけ。範囲はカードに列挙。`destructive` は対象外 |
| Grant の下で、作者の並行の編集を上書きする | 読んだ版との照合（DR-RB-6） |
| 手順の文を介した持続的な指示の注入 | 自動の注入をしない。長さの上限。tool の結果はデータとして扱う |
| renderer や generic SQL からの書換え | typed の経路だけ、D2a の台帳に追加 |

- 対象外：OS の層の改ざん、写しのファイルを直接書き換える攻撃者。
- 受入れ（負の試験）：条件の緩和、古い版の更新、範囲の外の呼出し、失効した Grant、別 project・別会話、子の agent からの呼出しが、それぞれ拒まれる。

## 7. PR の分け方（案。実装の担当が決める）

1. 表と typed N-API、削除と写しの扱い。
2. main の規則と tool 2 本（`get_session_plan`・`update_session_plan`）。
3. `request_task_grant` と Grant の検査。
4. 画面。
5. 旗を開ける段（個別の確認の後）。

## 8. 改訂が要る文書（この PR では改訂しない）

- ADR 007：SessionTask の型と、`TaskContractSnapshotV1` の中身。
- ADR 008：内部の状態を書く tool の分類、Task Grant の中身と保持。
- Roadmap：Release B の段と、子の Run を v1 に含めないこと。
- Mastra の脅威モデル：新しい tool と Grant の行。
- `agent-tool-manifest.json` の分類の規則（Gate A の A1 の後）。

## 9. 未確認

- 実 API の測定の API キーの置き場所と費用の上限、旗 L を使う測定の順番（DR-ST-8、判断記録の第 9 節）。
- Mastra の経路で `limit_tokens`・文脈の超過に当たったときの今の挙動。
- tool を足すときの評価 fixture の入れ先。SessionTasks の case はまだ無い。
- `title`・`criterion` に写った、後で hidden にした項目の名前の扱い。会話の履歴が同じ場合にどう扱っているかも、確かめていない。
- Release B を作った後の振り返り（Decision Gate A の問い）の時期と方法。

## 10. 利用者に伺う点

| 番号 | 点 | 起案者の推奨 | 本文 |
| --- | --- | --- | --- |
| U1 | 手順の保存の中身と、写しの扱い（保存の範囲の拡大） | 短い題・条件・状態・順序・参照の ID を保存し、写しには会話と同じく残す | DR-RB-1 |
| U2 | Task Grant の範囲の区切り（新しい authority） | 計画 × 操作 × 挙げた項目。削除は含めない | DR-RB-6 |
| U3 | Task Grant を再起動の後も効かせるか | 効かせない（memory だけ） | DR-RB-6 |
| U4 | AI の tool 3 本、経路、確認の有無 | Mastra の経路だけ。手順の書き込みは確認なし | DR-RB-4 |
| U5 | 次の公開の版に含めるか（凍結の対象） | 含めない | DR-RB-10 |
| U6 | 承認待ちの間に、ほかの手順を進めるか（試作との違い） | v1 は進めない | DR-RB-8 |
| U7 | `limit_tokens`・文脈の超過で止まったときの扱い（DR-ST-5 の条件 2） | 本文と手順を残して「続行」を出す | DR-RB-7 |

回答は、問いと選んだ選択肢の原文をここに写す（未回答）。
