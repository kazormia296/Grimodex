# Write-Safety Gate A（A1・A2）の判断記録（起案）

- 状態：**確認済み（2026-11-27、第 7 節の 4 問）**。**起案（draft）**。第 7 節の回答まで確定しない。
- 基点：`b991907b9`。変更対象は本書のみ。実装・脅威モデル本文は変更しない。
- 前提：Write-Safety Roadmap Gate A、ADR 008、SessionTasks DR-ST-4・6、Mastra MP-6、AWA/1、Release A の A3（durable AgentRun）。
- 合意（2026-11-27）：Gate A は Release B（SessionTasks）の前提。Mastra の担当は MP-6 の後に続けて持つ。Release A の A3 は「中断した瞬間の状態から、読み直しなしで続く」までを担う。Gate A の承認要求は Release A の A3 の durable `waiting_approval` Interaction を参照し、Gate A は承認と Capability の交換 authority を持つ。

## 1. 範囲

Roadmap Gate A の A1（tool の効果・承認方式の分類）と A2（main の承認検証と Capability 発行時点）を設計する。現行は変更系 15 tool すべてに応答時 Capability が出る。Gate A 後は、正規状態への各変更を executor と main の両方で個別承認なしに実行できないことを境界とする。stage の提案作成は自動のまま、accept だけ承認する（Roadmap の A3）。

Gate A は Roadmap の A3（stage の分離）・A4（AI policy parse の fail-closed 化）を含めない。MCP の AWA/1-2 も対象外。Gate C の Task Grant 永続化・範囲編集、Gate B の Agent Auto 化、製品公開も含めない。Task Grant が導入されるまでは `mutate/task-scope` も個別承認とする。

## 2. 確かめた事実

- ADR 008 §3〜5 は `effect`／`approvalMode`、承認要求、Capability 交換の境界を定める。特に Invariants 2〜4 は、`mutate` の無承認実行を禁じ、`destructive` の毎回の個別承認と、承認確定後の Capability 発行を要求する。Roadmap はこの境界の変更前に ADR 008 を amend する（保守規則 3、:254）。
- SessionTasks DR-ST-4（[判断記録:51-64](session-tasks-decisions-2026-11.md)）は、この ADR 008 の承認境界を使う。Task Grant は Gate C／Release B に置く。
- 現行 manifest の `requiresUserConfirmation` は宣言だけで、実行時に読む箇所がない。Rust `build.rs` (:63) は宣言の整合性を検査するだけ。main は応答を受けた時点で変更系 15 tool すべてに Capability を出している（`electron/main/ipc.ts:237-286`）。内訳には `delete_event` と `remove_event_relation` の削除 2 本も含む。Gate A 後は、作品内容への各変更を 1 件ずつ承認するまで実行しない。
- 発行関数 `issueAgentAuthorityCapabilitiesForSender` は `ipc.ts:1637-1724`、one-shot 消費関数は `:1727-1775`。issuer は legacy invoke と Mastra turn loop の共有関数（`:2516`）で、消費経路（`:2090`）も共有される。現行の製品経路は legacy invoke である。Mastra 側では `update_codex_entry` 等の base version を書き込み実行時に読み直す（`mastraTurnOwner.ts:1569-1606`）。承認の要求を作る時点で版を固定しなければ、承認後の変更を見落とす。
- Capability の現行 TTL は 5 分（`ipc.ts:231`）。承認待ちは ADR 008 §5 の `expired` として扱い、推奨 30 分で失効させる（`ask_user` と同じ）。待機中も main turn と書込み行列の枠を保持する（脅威モデル:452）。
- Manifest の画面操作 3 本（`run_app_command`、`apply_layout_preset`、`propose_setting_change`。:45-47）は作品内容を変えないため、承認なしを推奨する。`propose_scene_body` は stage として提案作成まで自動、正規状態への適用は別の承認。
- AWA/1（[提案書](nir1-agent-event-write-approval-proposal-1-draft.md) :284-299）は、main が要求を作り、承認が確定するまで Capability を出さず、確定後に束縛を検査して one-shot Capability に交換する経路を記録している。Gate A ではこの交換境界を参照し、対象を 15 tool に広げる。AWA/1-2 の MCP 経路は含めない。
- Release A の A3（`docs/plans/a3-durable-agentrun-decisions.md`）は `waiting_approval` Interaction の durable な実体と再開を担う。Gate A は Interaction の `interaction_id` を参照し、交換時に承認・引数・project・版・policy を確かめ直して Capability を発行／消費する。保存された承認だけを信頼しない。交換状態（capability の発行・消費）は memory の中だけに持つ。承認の要求と判断（承認・却下・時間切れ）は Release A の A3 の Interaction（kind=approval、Run は waiting_approval）に durable に残し、Run の終端で消える。再起動の後は Release A の A3 から要求を出し直し、交換し直す。保存した承認はそのまま使わない（2026-11-27 の利用者の決定、contracts の問 22。作者の出来事の承認 AWA/1 にも及ぼす＝問 23）。従来案の「再起動後に復元しない」は、この境界に改める。
- MP-6 の [DR-MP6-1・5](mastra-mp6-decisions.md) は、既存の Capability issuer／consumer と束縛を維持し、`requiresUserConfirmation` の確認時点を前倒ししない。したがって Gate A の発行時点変更を先に実装し、その後に MP-6 を接続する。flag L は A2 完了前に開けない。

## 3. 判断（案）

- **DR-GA-1 Gate と順序。** Roadmap の Gate A を Release B の前提とする。A1 の分類、A2 の main enforcement を分け、MP-6 は A2 の後に接続する。Decision Gate A（SessionTasks DR-ST-6 が指す判断点）と Roadmap の Gate A は別の名称として扱う。
- **DR-GA-2 A1 の分類。** Roadmap の `read | stage | mutate | destructive` と `none | task-scope | always` を採る。`mutate/task-scope` は Task Grant が無い間は毎回個別承認。`destructive/always` は Grant に関わらず毎回個別承認。未知値・分類不整合は fail-closed。旧 `requiresUserConfirmation` は全 tool の移行と確認が済むまで残す。
- **DR-GA-3 A2 の発行・交換。** `mutate`／`destructive` の応答時には実行 Capability を発行せず、main が Release A の A3 Interaction を参照する承認要求を作る。要求を作る時点で入力 digest と base version を固定する。承認時に main が digest、project、OCC／base version、未使用状態を再検証し、policy の再検証は A4 の fail-closed 化に依存する。全条件が一致したときだけ既存束縛を保った one-shot Capability に交換する。renderer executor も承認前 dispatch を拒む。二重回答・失効・不一致は fail-closed。
- **DR-GA-4 Mastra 承認の候補。** UI のカードを同じにして、Mastra の `requireApproval` を停止・再開部品として使う案を問う。main の承認検証と Capability を置き換えない。`resumeData`、モデルの `approved`、再開時に保存された承認を authority にしない。Stop 後に suspend／snapshot が止まりきらない点は未解決で、採用前の条件として残す。AWA/1 の main 経路と比較して選ぶ（第 7 節 Q3）。Mastra を選ぶ場合に限り W12 と DR-MP5-7 の改訂を別途確認する。
- **DR-GA-5 Roadmap の A3・A4 との境界。** Roadmap の A3 は stage の自動提案と accept 承認を分ける作業、A4 は不正 AI policy を fail-closed にする作業として別に扱う（Roadmap exit criteria 3・6）。A2 の承認時 policy 再検証は A4 に依存する。これらを A2 に混ぜず、flag L を先に開けない。
- **DR-GA-6 A1 の manifest の値と割り当て（2026-11-28、技術判断）。** 値は DR-GA-2 のとおり ADR 008 §3 の語を使う。画面の操作の 3 本（`run_app_command`・`apply_layout_preset`・`propose_setting_change`）だけは、第 7 節の問 2 を表すために `ui`／`none` を足す（ADR 008 の 2026-11-28 の追補。3 本の名指しに限る）。割り当て（44 本）：読み取り 26 本は `read`／`none`、`propose_scene_body` は `stage`／`none`、削除の 2 本は `destructive`／`always`、残る変更系 12 本は `mutate`／`task-scope`（Task Grant が無い間は毎回個別承認。DR-GA-2）、画面の操作 3 本は `ui`／`none`。A1 は挙動を変えない。
- **DR-GA-7 承認の Interaction の形（2026-11-28、Release A の A3 の担当とのすり合わせ。確定済みの判断の範囲内）。**
  - 開くとき：Run の `running` → `waiting_approval` と、`pending`（`kind=approval`）の作成を同じ transaction で行う。`pending` は `root_run_id` ごとに 1 件なので、A2 は承認の要る tool を直列に開く（2 件目は `AGENT_RUN_PENDING_INTERACTION_EXISTS` で拒まれる）。
  - 呼ぶ順：交換の確かめ直し → `approved` の記録 → 台帳に発行を記録（失敗したら Capability を使わない）→ 使う → 実行の状態を記録。台帳の `requestId` は保存せず、tool・project・toolCallId から再計算する。
  - 保存した resolution は認可に使わない。`approved` の記録の後に落ちた呼出しは、resolution を tool_result に入れ直さず、commit 済みかの照会だけにする（DR-A3-6）。
  - 却下は固定の文を tool_result で返して続ける。resolution は `approved`／`rejected` の 2 値。ADR 008 の `executed` は台帳（Capability の消費・実行）が、`expired`・`superseded` は status が持つ。
  - A3 は対象の版を保存しない。版の保存は保存の追加なので、A2 の設計で利用者に伺う。保存しない場合、再起動の後はカードを今の状態から組み直し、「要求の時点から変わっていないか」は確かめられない（DR-GA-3 との差として A2 で扱う）。
  - Mastra の Run は `resumable` が偽の間（DR-A3-8）、再起動の後の出し直しは使えない。`approval_timeout` で中断した Run の `pending` は、破棄か `superseded_by_new_turn` で `cancelled` になる。

## 4. owner／lifecycle（GDX-PRECHECK-001）

| 経路 | owner／開始 | 停止・失効 | error／再開・終端 |
| --- | --- | --- | --- |
| turn／tool 応答 | main turn owner。応答時に要求だけを作り、Capability は出さない | Stop・権限失効で未承認要求を閉じ、新規 dispatch を拒む。承認待ちの上限は 30 分 | 交換状態は memory の中だけで、再起動で復元しない。承認の要求と判断は Release A の A3 の Interaction に残り、再起動の後はそこから出し直して交換し直す（問 22） |
| 承認・Capability 交換 | main owner が Release A の A3 `interaction_id`、sender／turn／toolCall、要求作成時の digest・base version を束縛 | 承認の時点で digest・project・OCC／版・policy・未使用性を再検証。失効、不一致、二重回答を拒否。一度だけ消費 | issuer の失敗は fail-closed。Native dispatch 後の cancellation／終端 receipt は MP-6 の確認対象 |
| Mastra suspend／resume | 採用する場合も Mastra runtime は停止・再開のみ、認可と保留は main owner | Stop で suspend／snapshot が有限に閉じる証拠は未確認 | 条件を満たせなければ Mastra 組込み承認を採らない |

承認待ちの上限は推奨値。待機中に turn と書込み行列の枠を保持するため、30 分の待ちと既存の停止上限との整合を実装時に確認する。

## 5. 影響と順序

| レーン | 主な到達先 |
| --- | --- |
| A1 | `agent-tool-manifest.json`、`src/features/chat/agent/toolManifest.ts` と executor、Rust `grimodex-ai/build.rs`、manifest parity／build 検査 |
| A2 | `electron/main/ipc.ts` の issuer／consumer、承認要求と one-shot 交換、`electron/main/mastraTurnOwner.ts`、executor／UI、main・executor の負試験 |
| MP-6 接続 | Mastra write definitions／turn owner、承認・停止・再開の lifecycle。DR-MP6-1・5 を保ち、Gate A 完了後に接続 |
| Roadmap の A3・A4 | 別レーン。Roadmap exit criteria 3・6 を満たす。A2 の policy 再検証は A4 完了後 |

## 6. 脅威モデルへの影響（案）

- ADR 008 §3〜5 と Invariants 2〜4 を Gate A の基準にする。これから外れる分類、承認時点、Capability 交換が必要と分かった場合は実装前に ADR 008 を amend する（Roadmap:254）。
- Mastra の組込み承認を採る場合は、W12 の対象を MP-5 UI 問い合わせから MP-6 write へ明確に分け、main が authority を保持する例外と、`resumeData`／model input を信頼しない規則を追記する。これは Q3 で Mastra を選ぶ場合だけ確認する。
- Gate A は MCP（AWA/1-2）へ広げない。新しい保存先・送信先は提案しない。

## 7. 利用者に確認する点

回答（2026-11-27、利用者）：問1＝1 件ずつ承認（Release B まで。削除は毎回）。問2＝画面の操作（UI 系の 3 本）は承認なしのまま。問3＝作者の出来事の承認（AWA/1）と同じ仕組み（W12 は変えない）。問4＝30 分で取り消す。


以下の推奨は草稿であり、回答までは確定しない。

1. **AI が Codex の項目や出来事を作る・直すとき、今は確認なしで実行されます。この変更の後は、1 件ずつ承認を押すまで実行しません（削除は毎回確認）。まとめて任せる承認は Release B で入ります。それまでの間、どちらにしますか。** ①1 件ずつ承認（推奨） ②まとめて任せる承認を先に作る。
2. **レイアウト切替など画面の操作にも承認を要しますか。** ①承認なしのまま（推奨。作品の内容は変わらない） ②承認を要する。
3. **承認の仕組みはどちらにしますか（画面のカードは同じです）。** ①作者の出来事の承認（AWA/1）と同じ main の仕組み（推奨） ②Mastra 組込みの承認（Stop の後に止まりきらない点が未解決）。②の場合だけ W12 の改訂を確認します。
4. **承認を待つ時間はどちらにしますか。** ①30 分で取り消す（推奨。`ask_user` と同じ） ②Stop まで待つ。

## 8. 採らなかった案

- LLM 応答時に `mutate`／`destructive` Capability を先に発行し、後から承認で守る：承認前にも main が認める token が存在し、ADR 008 §4 と合わない。
- Mastra `requireApproval` を製品認可そのものにする：Mastra の承認情報は authority ではなく、main の one-shot Capability を置き換えない。
- Gate A で Task Grant の永続化・範囲編集を行う：Roadmap の Gate C／Release B の範囲を越える。
- Gate A が Release A の A3 の Interaction を重複して永続化する：Release A の A3 が durable waiting state を持ち、Gate A は交換 authority に限る。

## 9. 未確認

- 承認要求から Release A の A3 Interaction への `interaction_id` の結び方と、再開時に承認状態・base version・policy を交換時に再検証する具体的 API。
- 承認待ち 30 分の間に main turn と書込み行列が枠を保持する影響、および Stop／workspace 切替時の終端証拠。
- Mastra suspend／resume の Stop 後の有限終端と snapshot 破棄。Q3 の選択肢②を採る場合だけ採用可否を決める。
- 15 tool の A1 最終分類、Roadmap の A3／A4 の別レーン完了証跡、base version を要求作成時に固定する読み取り経路。
