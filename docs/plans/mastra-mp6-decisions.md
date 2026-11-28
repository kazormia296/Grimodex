# Mastra 移行 MP-6 の判断記録（起案）

- 状態：**起案（draft）**。技術判断の案を記録する。第 7 節の確認が要る項目は回答前に確定しない。
- 基点：`origin/master` `2db49f806`（依頼時指定）。コードは変更しない。
- 前提の正本：[移行計画](mastra-migration-plan.md) MP-6、[MP-4 の判断](mastra-mp4-decisions.md)、[MP-5 の判断](mastra-mp5-decisions.md)、[脅威モデル](mastra-migration-threat-model.md)。

## 1. 範囲

15 本の write tool を main の per-turn binding に移す。`propose_scene_body` は MP-5 から MP-6 に回した（2026-11-26、[mastra-mp5-decisions.md:108](mastra-mp5-decisions.md)）。capability の発行・消費と束縛、既存 writer、write 後処理、renderer store への完了通知、`chatMessageId` と予約行の整合を含める。旗 L は閉じたままにする（[mastra-migration-plan.md:407-414](mastra-migration-plan.md)）。

対象は `create_codex_entry`、`update_codex_entry`、`create_foreshadow`、`update_foreshadow`、`create_snippet`、`apply_ai_tree_plan`、`propose_scene_body`、`create_event`、`update_event`、`delete_event`、`stamp_scene_event`、`unstamp_scene_event`、`set_event_participants`、`add_event_relation`、`remove_event_relation`（`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:1`）。破壊的 tool は `delete_event` と `remove_event_relation`。

## 2. 確かめた事実

- 現行 executor は `agent-writes` から typed IPC／Native writer を呼ぶ。scene body は staging store に enqueue する（`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:1,5`）。
- capability は sender ごとに発行し、消費時に検証して一度限りで使う。sender・project・入力 digest 等の束縛を維持する案が計画にある（`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:3`、[mastra-migration-plan.md:407-419](mastra-migration-plan.md)）。
- main 側で write が完了するなら renderer store 反映用の完了 event が要る（`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:5`）。
- `chatMessageId` は renderer の自己申告。audit 行には載せず、legacy と同形の send args に保つ判断が MP-4 にある（[mastra-mp4-decisions.md:679-682](mastra-mp4-decisions.md)）。
- `propose_scene_body` を MP-6 に移す決定と、`requiresUserConfirmation` を前倒ししない決定は既にある（[mastra-mp5-decisions.md:12-14,101-108](mastra-mp5-decisions.md)、[mastra-mp4-decisions.md:1881](mastra-mp4-decisions.md)）。
- survey は全 Native command の対応名を未確認としている（`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:11`）。

## 3. 判断（案）

- **DR-MP6-1 capability を維持する。** 発行は既存の `issueAgentAuthorityCapabilitiesForSender`、消費・検証は既存の `consumeAgentAuthorityCapability` を使う。同じ束縛（one-shot、`senderId`・projectId・入力 digest）を保ち、tool 実行直前に消費する。削除・緩和は案に含めない（[mastra-migration-plan.md:407-415](mastra-migration-plan.md)、[mastra-migration-threat-model.md:296](mastra-migration-threat-model.md)）。
- **DR-MP6-2 write binding は main owner に持たせる。** 既存 Native writer と入力検査を呼ぶ。tool 結果は既存の形を保ち、write→read と undoId の順序を維持する（[mastra-migration-plan.md:410-419](mastra-migration-plan.md)）。
- **DR-MP6-3 write 後処理を既存の責務単位で移す。** store 再読込、undo、timelapse、index 予約を main の完了に合わせる。画面の store 更新には完了 event を用いる。新しい保存先は設けない（[mastra-migration-plan.md:411](mastra-migration-plan.md)、`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:5`）。
- **DR-MP6-4 MP-5 の問い合わせ経路を再利用する。** `propose_scene_body` の画面側処理が必要なら、DR-MP5-1〜12 の専用 event／answer command、owner、束縛、一回限りの回答、有限待ち、権限確認を適用する。別経路を増やさない（[mastra-mp5-decisions.md:31-46](mastra-mp5-decisions.md)）。
- **DR-MP6-5 `requiresUserConfirmation` は今の位置を保つ。** 確認を前倒ししない（[mastra-mp4-decisions.md:1881](mastra-mp4-decisions.md)、[mastra-migration-plan.md:422](mastra-migration-plan.md)）。
- **DR-MP6-6 検証。** capability 無し・再利用・別 project・別 digest の拒否、write→read 順序、undoId、`agentAuthorityCapabilities` の維持、全 write tool journey を固定する（[mastra-migration-plan.md:414-419](mastra-migration-plan.md)）。

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 経路・owner（entry／start／retry／再入）                                                                                                              | admission closure／pending-start                                           | active handle／cancel                                                                                                          | bounded wait／termination evidence                                                               | error・timeout・窓喪失／restart                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| tool binding の entry は main turn owner。turn ごとに開始し、同一 turn の再入は既存の直列実行を前提に拒否。retry は Mastra の tool 再呼出しとして扱う | turn 終端または authority 失効後は新規受付を閉じ、未開始は破棄             | capability と Native write は main binding が所有。dispatch 前の cancel は開始しない。dispatch 後の Native cancel 可否は未確認 | turn の既存上限。Native の終端証拠は command ごとに未確認。Promise settle だけを終端証拠としない | error は binding が tool error にする。timeout 後の副作用は曖昧として盲目的に再試行しない。窓喪失・再起動後に復元しない |
| 完了 event は main が送信し renderer が反映。重複 event の扱い・再送は未確定                                                                          | turn 終端または窓喪失で受付を閉じ、未送信 event は破棄                     | event 送信の active handle は main owner。renderer の受領・反映確認は新契約の問い（Q1）                                        | 既存 IPC 上限を使えるか未確認。event 送信結果は renderer の適用証明ではない                      | 失敗後に write を再実行しない。窓喪失・再起動後の復旧契約は設けない案                                                   |
| `propose_scene_body` の画面側処理は main owner が問い合わせを所有。DR-MP5-1〜12 の一回答・既存直列・有限待ちを再利用                                  | turn 終端・回答・Stop・中断・期限で保留を閉じ、未開始 handler は起動しない | 保留は main owner が所有し、cancel は MP-5 規則による                                                                          | MP-5 の既存上限を使う。保留解決と tool 結果を終端証拠にする                                      | handler error／timeout／窓喪失を MP-5 の規則に従い main owner が閉じる。永続 restart state は持たない案                 |

Native command の対応名、dispatch 後の取消し、終端 receipt、IPC event の受領確認、上限値は未確認であり、表はこれらを確定事実としていない。再入を拒否できない、または新しい期限・契約が必要なら、第 7 節で確認する。

## 5. 影響と PR の分け方

計画どおり、共有 write port／契約、codex・foreshadow・snippet、tree・scene body と後処理 event、chronicle write、全 tool journey・負試験の順を案とする（`/home/grimodex/fusion-eval-data/.codex-jobs/mp6-survey.out.md:7`）。各 PR は判断 ID と trust boundary を本文に記す。新しい contract は第 7 節の回答後に固める。

## 6. 脅威モデルへの影響

- T11／D13 の capability を MP-6 で実装し、one-shot と束縛を静的・実行試験で固定する。IR の脅威モデル再確認は延期決定どおり、IR を開ける lane まで行わない（[mastra-migration-threat-model.md:269,296](mastra-migration-threat-model.md)、[mastra-mp4-decisions.md:1688-1689](mastra-mp4-decisions.md)）。
- T9（指示文による tool 誤実行）に対し、capability の検証を tool 実行直前に残す（[mastra-migration-threat-model.md:267,296](mastra-migration-threat-model.md)）。
- `chatMessageId` が renderer の自己申告である残余リスクを記録する。audit 行や新しい args へ追加せず、既存の形を保つ（[mastra-mp4-decisions.md:679-682](mastra-mp4-decisions.md)）。
- workspace／quit 等の lifecycle は既存 owner の終了規則に接続する。終了の証拠と曖昧な副作用の扱いは W9・W10 の考え方と照合する（[mastra-migration-threat-model.md:415-436](mastra-migration-threat-model.md)）。新しい永続化・送信先は提案しない。

## 7. ユーザーに確認する点

回答（2026-11-26）：完了の通知（main→画面の event 1 本、対象の ID と undo の ID だけ、本文なし）は**足してよい**。Mastra の承認（requireApproval）は**候補**で、mock の結果（`.codex-jobs/mp6-mock.out.md`：承認は偽装できない、承認の後に resumeData はモデルの値になる、承認待ちの Abort で suspended のまま）を添えて、W12・DR-MP5-7 の改訂と一緒に、採る前に伺う。loop の tool 回数の上限の撤廃は利用者の希望（SessionTasks 経由、advisor の条件つき）で、この段の後に置く。
追記（2026-11-28）：承認の仕組みは、Gate A の判断記録の第 7 節の問 3（2026-11-27、利用者）で AWA/1 と同じ main の仕組みに決まった。Mastra の承認（`requireApproval`）は採らない。W12 は変えない。

| ID  | 問い                                                                                                                               | 推奨                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Q1  | renderer store の反映に使う完了 event の wire 契約を追加してよいか。                                                               | 必要最小の結果・識別子だけを持つ typed event を追加。既存の保存先・送信先は増やさない。 |
| Q2  | main からの完了通知が届かない場合の表示・再読込の契約を追加してよいか。                                                            | write を再実行せず、既存の画面更新経路で再読込する。別の永続記録は作らない。            |
| Q3  | 既存定数から上限を導けない Native write または完了 event に、新しい有限 timeout 値が必要になった場合、その値を別途確認してよいか。 | 既存の値を共有し、新しい閾値を暗黙に決めない。                                          |
| Q4  | `propose_scene_body` の画面側処理を MP-5 の既存問い合わせ契約で扱えるか。                                                          | DR-MP5-1〜12 を再利用し、新規 authority・保存を設けない。                               |

新しい authority、保存範囲、送信先、契約、閾値をこれ以外に要する発見があれば、実装前に問いを追加する。

## 8. 採らなかった案

- capability を削除・緩和する：製品認可の変更で、委任外。採らない。
- `requiresUserConfirmation` を前倒しする：U-9 の決定に反する。採らない。
- `propose_scene_body` 専用の問い合わせ・回答経路を作る：MP-5 の契約を再利用できるため採らない。
- tool 結果や `chatMessageId` を新たに永続化する：要件がなく、保存範囲を増やすため採らない。
