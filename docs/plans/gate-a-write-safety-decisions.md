# Write-Safety Gate A（A1・A2）の判断記録（起案）

- 状態：**起案（draft）**。authority の変更を含むため、第 7 節の回答まで確定しない。
- 基点：依頼時の `origin/master`。変更はこの判断記録だけ。実装・脅威モデル本文は変更しない。
- 前提：Write-Safety Roadmap Gate A、SessionTasks DR-ST-4・6、Mastra MP-6、Mastra 脅威モデル。
- 利用者の決定（2026-11-27）：Gate A は Release B（SessionTasks）の前提。Mastra の担当が MP-6 の後に続けて持つ。authority の変更は設計後に利用者へ確認する。

## 1. 範囲

Gate A の A1（tool の効果と承認方式の分類）・A2（main の承認検証と Capability 発行時点）を設計する。Gate A の invariant「Auto Turn で `mutate` が承認なしに実行されない」を executor と main の両方で試験する。

Gate C の Task Grant の永続化・編集 UI・範囲定義、Gate B の Agent Auto 化、製品公開は含めない。Gate A では `task-scope` の型と強制点を用意し、Task Grant が未導入の間はその承認を個別確認に倒す案とする。

## 2. 確かめた事実

- Roadmap は A1 に `effect: read | stage | mutate | destructive` と `approvalMode: none | task-scope | always` を置き、`propose_scene_body` を `stage`、`delete_event`・`remove_event_relation` を `destructive / always`、現行の確認不要の変更系 11 本を `mutate / task-scope` とする。`apply_ai_tree_plan` は `mutate` 以上。loader と Rust build check の整合性検証、旧 `requiresUserConfirmation` の廃止も範囲（[roadmap:85-94](agent-auto-write-safety-roadmap.md)）。
- A2 は LLM 応答受信時の `mutate`・`destructive` Capability 発行を止め、ApprovalRequest を置き、承認確定時に main が digest・Project・OCC・policy・未使用性を再検証して one-shot Capability に交換する案。Gate A exit criteria は無承認拒否、destructive の毎回承認、stage の非変更、再利用と不一致拒否を含む（[roadmap:96-123](agent-auto-write-safety-roadmap.md)）。
- 今の `issueAgentAuthorityCapabilitiesForSender` は応答の tool_use を見て、policy と入力 digest を検査して発行し、sender・project・toolCall・execution・message に束縛する（[ipc.ts:1636-1697](../../electron/main/ipc.ts)）。`consumeAgentAuthorityCapability` は一度消費してから sender・command・project・request・toolCall・message・execution・digest を照合する（[ipc.ts:1685-1775](../../electron/main/ipc.ts)）。Mastra owner は応答直後に grant を保持し、write binding で取り出して main の Native payload に束縛する（[mastraTurnOwner.ts:952-966](../../electron/main/mastraTurnOwner.ts)、[mastraTurnOwner.ts:1535-1634](../../electron/main/mastraTurnOwner.ts)）。
- 現 manifest は `capability` と `requiresUserConfirmation` を持ち、roadmap の `effect`／`approvalMode` ではない。たとえば `propose_scene_body` は `write` かつ確認あり、削除 2 本は `destructive` かつ確認あり（[toolManifest.ts:1-15](../../src/features/chat/agent/toolManifest.ts)、[agent-tool-manifest.json:28-47](../../agent-tool-manifest.json)）。
- DR-ST-4 は `mutate / task-scope` の承認済み Task Grant 範囲内の連続実行、範囲外の個別承認、`destructive / always` の毎回確認を ADR 008 の正本に置く。Gate A が境界を作り、Task Grant 自体は Gate C／Release B（[session-tasks-decisions-2026-11.md:44-56](session-tasks-decisions-2026-11.md)）。DR-ST-6 は Gate A を Release B の前提に変更済み（[session-tasks-decisions-2026-11.md:79-85](session-tasks-decisions-2026-11.md)）。
- MP-6 は Capability の main 発行・消費、one-shot と sender／project／入力 digest の束縛を維持し、write owner を main に置く案（[mastra-mp6-decisions-2026-11.md:22-29](mastra-mp6-decisions-2026-11.md)）。
- `@mastra/core@1.83.0` mock の観測：①モデルの `approved:true`／`resumeData` では承認待ちを解除せず、`execute` 前に停止。②承認後の context `resumeData` と tool 引数はモデル由来で、HOST 値より優先される。③`approvalDecision` は `workflowResumeData` 由来。④storage 省略でも prompt 本文を含む snapshot がプロセス内にでき、新 instance から読めない。⑤同じ応答の write 承認待ち中は read も実行されず、decline は `tool-output-denied` と理由を返す。⑥Abort 後も run status は `suspended` で、abort 終端 chunk／snapshot 取消しは観測されない（[/home/grimodex/fusion-eval-data/.codex-jobs/mp6-mock.out.md:1-12](/home/grimodex/fusion-eval-data/.codex-jobs/mp6-mock.out.md)）。
- W12 は MP-5 の UI 問い合わせで組込み承認・suspend／resume・`resumeData` を使わず、MP-6 write 承認は別途決めると記録。DR-MP5-7 は MP-5 の問い合わせ回答に `resumeData` 等を使わない決定（[threat model:452](mastra-migration-threat-model.md)、[MP-5: DR-MP5-7](mastra-mp5-decisions.md)）。

## 3. 判断（案）

- **DR-GA-1 Gate と owner。** Gate A を Release B の前提として扱う。Mastra lane が MP-6 の後に連続して設計・実装を持つ。判断と変更はこの記録に残し、実装 PR は A1（manifest・loader・Rust build check）と A2（main issuer／ApprovalRequest／executor）の責務で分ける案。各 PR の本文に該当 DR と信頼境界を書く。
- **DR-GA-2 A1 の分類。** Roadmap の分類表と例を採る。`read/none` と `stage/none` は自動実行可。ただし `stage` は提案の作成までで、正規状態への適用は別承認。`mutate/task-scope` は Task Grant が存在しない間は毎回個別承認。grant がある場合も、範囲内だけ連続実行。`destructive/always` は grant に関わらず毎回個別承認。分類不整合・未知値は fail-closed。`requiresUserConfirmation` は全 tool の移行と試験が揃うまで削除しない。
- **DR-GA-3 A2 の発行時点と Task Grant。** `mutate`／`destructive` の LLM 応答時に実行可能 Capability を発行しない。main が承認要求を作り、承認確定後に request の固定 digest、project、OCC、policy と未使用状態を再検証し、成功したときだけ one-shot Capability に交換する。既存の sender・project・toolCall・execution・message・input digest の束縛と消費時照合を維持する。task-scope の承認記録も同じ main owner が持つ。Gate A は Grant の保存・範囲編集を実装せず、Gate C までは個別確認に倒す。Gate C 以後も Grant は `mutate/task-scope` の範囲内だけに効き、範囲外と `destructive/always` は個別確認を維持する。
- **DR-GA-4 Mastra 承認の候補。** `requireApproval`／`beforeApproval`／approve・decline は「停止して人の操作を受ける」候補に限り、製品認可や Capability と同一視しない。実行直前の引数を承認時 digest と照合し、`resumeData`・モデルの `approved` は認可にも承認の根拠にも使わない。mock の⑥で Abort 後に suspended が残るため、owner が保留・snapshot を安全に閉じる有限 lifecycle を実証するまで採用を確定しない。snapshot はメモリ内でも prompt 本文を含む。永続 storage は追加しない。停止中に read も止まること、decline の結果形も試験する。
- **DR-GA-5 invariant の検証。** manifest 全件を列挙し、Auto Turn の承認なしに `mutate` が executor と main の双方で拒否されることを試験する。加えて承認前 Capability 不在、承認後の固定 digest・project／OCC／policy 再検証、二重消費拒否、Grant 範囲内外、destructive の個別確認、stage が正規状態を変えないことを固定する。`read` の既存挙動も回帰確認する（[roadmap:230-235](agent-auto-write-safety-roadmap.md)）。

## 4. owner／lifecycle（GDX-PRECHECK-001）

| 経路 | owner／開始 | 停止・失効 | error／再起動・終端 |
| --- | --- | --- | --- |
| turn／tool 応答 | main turn owner。応答時は承認要求だけを登録し、mutate 用 grant は発行しない | turn の停止・権限失効で未承認要求を閉じ、新規 dispatch を拒む | 再起動後に要求を復元しない案。終端証拠と Mastra snapshot の破棄方法は要確認 |
| 承認・Capability 交換 | main owner が sender／turn／toolCall と固定 digest を束縛。承認確定時に再検証し発行 | 承認前の引数変更、project／OCC／policy 変更、二重回答を拒否。Capability は一度だけ消費 | issuer の失敗は fail-closed。Native dispatch 後の cancellation／終端 receipt は MP-6 の確認対象 |
| `requireApproval` suspend／resume | Mastra runtime が停止・再開を扱い、main owner が認可・保留の外側を所有する案 | Abort・Stop で suspend を閉じる条件は mock 未確認。単に signal を送るだけでは終端とみなさない | memory snapshot を残さず閉じられるか、有限待ちの証跡が未確認。満たせない場合は採用しない |

## 5. 影響と PR の分け方

| レーン | 主な到達先 |
| --- | --- |
| A1 | `agent-tool-manifest.json`、`src/features/chat/agent/toolManifest.ts` と executor、Rust `grimodex-ai/build.rs`、既存 manifest parity／build 試験 |
| A2 | `electron/main/ipc.ts` issuer／consumer、`electron/main/mastraTurnOwner.ts`、承認要求を返す executor／UI、main と executor の負試験 |
| MP-6 接続 | Mastra write definitions／turn owner、approve・decline・suspend lifecycle と mock 条件。PR は Gate A DR を参照 |

A1 の分類と A2 の main enforcement を分離し、途中の状態で `mutate` が無承認実行できないようにする。PR を製品に届かせる順・flag L の扱いは MP-6 の受入れと合わせて決める。製品公開は含めない。

## 6. 脅威モデルへの影響（案）

- W12 は現在 MP-5 の問い合わせに限り組込み承認を使わない。DR-GA-4 を採る場合、MP-6 write では `requireApproval` を停止・再開のみに使い、main の承認検証と Capability が authority を持つ例外を明記する改訂が必要。
- DR-MP5-7 は MP-5 の回答経路を対象とする。文言は維持し、MP-6 の write 承認について「`resumeData` とモデル入力を信頼せず、引数 digest を承認時に固定する」別記を追加する案。GDX-PRECHECK-001 により、脅威モデル確定文書の変更は利用者の明示確認後に行う。
- 新しい信頼先・保存先は提案しない。Mastra in-memory snapshot に prompt 本文がある点、Abort 後に suspended のまま残る点は残余リスク候補で、採用条件を満たすまで authority の有効化を止める。

## 7. 利用者に確認する点

以下の推奨は草稿であり、回答までは確定しない。

| ID | 問い | 選択肢 | 推奨 |
| --- | --- | --- | --- |
| Q1 | Gate A を Release B の前提とし、Mastra lane が MP-6 の後に続けて持つ。A1・A2 は本書 DR-GA-2・3 の分類と「main が承認確定後に再検証して Capability を発行する」境界で設計してよいか | ①この案で設計する ②分類を直してから設計する ③A2 の authority 境界を保留する | ① |
| Q2 | `mutate/task-scope` の Task Grant を Gate C／Release B に残し、導入までは個別確認とするか。Grant 導入後も `destructive/always` を毎回個別確認とするか | ①Roadmap どおり Gate C、導入までは個別確認 ②Task Grant を Gate A に前倒し ③Grant を使わず個別確認を続ける | ① |
| Q3 | MP-6 write の停止・再開に Mastra `requireApproval` を候補として続け、Abort 後の suspended／snapshot を有限・非永続で閉じる試験が通ることを採用条件にするか。採用時は W12 を改訂し、MP-5 の `resumeData` 禁止と区別した追記を許可するか | ①条件付きで候補を続ける ②main の独自承認経路を設計する ③組込み承認を使わない | ① |

## 8. 採らなかった案

- LLM 応答時に `mutate`／`destructive` Capability を先に発行し、後から承認で守る：承認前にも main が認める token が存在し、Gate A の境界を満たさない。
- Mastra `requireApproval` を製品認可そのものにする：mock で `resumeData` と実行引数がモデル由来のまま再開し、既存 main Capability を置換できない。DR-ST-4 も認可の削除を委任範囲外としている。
- Gate A に Task Grant の永続化・範囲編集まで含める：Roadmap の Gate C／Release B と DR-ST-4・6 の段階を越える。
- Abort signal 送信を停止完了と見なす：mock では status が `suspended` のままで、終了証拠にならない。

## 9. 未確認

- MP-6 の現在候補で、approval request と固定 digest を既存 main owner のどこに置けるか。OCC／policy の承認時再検証 API と race の扱い。
- `requireApproval` の承認・decline 後に tool 引数を main が固定値へ結び直せるか、Abort 時に snapshot を破棄して runtime を有限に閉じられるか。
- `destructive` 対象以外を含む15 write tool の分類最終表、stage の正規状態非変更、manifest を共有する Rust build check の現状。
- mock は `@mastra/core@1.83.0` の指定条件のみ。別版、別 concurrency、snapshot を完全無効化する方法は未確認。
