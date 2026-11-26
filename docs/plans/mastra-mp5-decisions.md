# Mastra 移行 MP-5 の判断記録（main から画面への問い合わせと UI 系の tool）

- 状態：**確認済み（2026-11-26、第 7 節の Q1〜Q4 にユーザーが回答）**。コードは変えていない。実装は第 5 節の 5a から。
- 基点：`origin/master` ada7d3527（2026-11-26。起案は 129e1b6cc。#1131・#1139 の後の事実を第 2 節で確かめ直した）。
- 前提の正本：[移行計画](mastra-migration-plan.md) の MP-5、[MP-4 の判断記録](mastra-mp4-decisions.md)、[脅威モデル](mastra-migration-threat-model.md)（確定文書。この文書では変えず、5a の PR で W12 を足す。第 6 節）。

## 1. 範囲

main の agent loop が実行の最中に画面（renderer）へ問い合わせ、UI 系の tool を main の tool として持つ。旗 L は閉じたままで、製品の挙動は変えない。

この案で接続するのは 7 本：`ask_user`、`run_app_command`、`apply_layout_preset`、`propose_setting_change`、`get_ui_state`、`get_app_help_index`、`get_app_help`。
計画の 8 本目 `propose_scene_body` は MP-6 に回す（第 7 節の Q4、承認済み）。本文の提案は main が発行する一回限りの認可が要り、その仕組みは MP-6 の write tool と同じだから。

決定済みで変えないもの：実行の最中に問い合わせる方式で、画面が閉じたら有限の時間で終える（U-8）。確認の前倒しはしない（U-9）。chat IR は閉じたまま。

## 2. 確かめた事実

- tool は 1 件ずつ実行される（`AGENT_CALL_OPTIONS.toolCallConcurrency: 1`）。
- 今の経路の `ask_user` に回答待ちの時間の上限は無い。質問の 8 回は停止のしきい値で、同じ応答の tool を全部実行した後に判定するので、超えることがある。
- Mastra の経路の start は turn が終わるまで書き込み用の待ち行列の枠を持つ。枠は 4 本で、読み取り系が 3 本動いていると、同じ行列に回答を載せると詰まる。
- main の Stop は次の send と tool を抑止する（#1131 で停止後の tool を固定結果に、`agentToolAdapter.ts:83-87`）が、進行中の Mastra の send と待ちは解かない。#1139 の `backend.abortChatStream` は legacy の agent の送信だけに接続され、Mastra の経路には未接続（4c-2 の項目）。強制中断（profile の制限、workspace の切替、quit、画面の喪失）の通知は画面に届かない。
- workspace の切替は、画面側が先に実行中の処理の終了を期限なしで待ち、main の強制中断はその後にしか届かない（DR-MP4-29）。質問の回答待ちの turn があると、切替が進まない。#1139 の終了前の確認（`src/application/lifecycle/chatStopConfirm.ts`）は終了の経路だけで、切替には接続されていない。
- 今の経路は、tool を実行する前に handler の外で turn の権限を確かめる（`chatTurnStoreActions.ts:490` の `shouldAbortTurn`・`:499` の `assertTurnAuthority`。停止、quiescence、workspace・project・session、scope・anchor・thread・scene、agent の権限と route、chat の方針、license）。`createGuardedExecuteTool`（`chatAgentToolHandlers.ts:419-439`）が呼ぶので、handler だけを呼ぶと抜ける。`apply_layout_preset` は保存を予約する（`layoutStore.ts:1600-1618`）。
- chat のパネルは別の窓にできる。今の経路は、別の窓では `run_app_command` と `apply_layout_preset` を「何も変えずに失敗」にする（主画面の配置の保存を上書きしないため）。
- `@mastra/core` 1.83.0 の組込み `ask_user`・`submit_plan` は、モデルが引数に `resumeData` を書くと、人の操作なしで回答・承認として扱う（再現した）。`requireApproval` の承認の後も、モデルの引数の値が優先する。今の main の経路はこれらを使っていない。
- 脅威モデルには、main から画面に実行させる向きの項目は無い。ただし指示文による tool の誤実行は T9、renderer の不信頼は第 1 節が覆う。新しい authority は無く（回答を認可に使わない）、新しいのは待ちの lifecycle（W9 の切替 30 秒の前提が崩れる）。
- MP-4 の「契約の変更は 2 回」は MP-4 の中の話で、MP-5 の問い合わせは含まない。

## 3. 判断（案）

- **DR-MP5-1 問い合わせの経路。** main から画面への専用の event `mastra:agent-turn-question` を 1 本足す。進捗の event は数値と識別子だけを運ぶと決めた（W2）ので、tool の引数を混ぜない。回答は新しい main 専用の command `mastra_agent_turn_answer` で返す。
- **DR-MP5-2 束縛。** 問い合わせは `turnId`・`requestId`・`toolCallId`・開始した窓（`webContents`）に束ねる。回答は一度だけ受け、別の窓、知らない ID、閉じた後の回答は拒む。
- **DR-MP5-3 持ち主。** 保留中の問い合わせは main の turn の持ち主（owner）が持つ。画面は表示と実行だけを担う。
- **DR-MP5-4 回答の通り道。** 回答と cancel は、書き込み用の待ち行列の枠（4 本）の空きを待たない経路を持つ。直接の IPC には逃がさず、切替の前の待ち合わせ（quiescence の drain）が追跡する対象に残す。枠が埋まっているときと drain の最中の挙動は 5c の試験で固定する。drain の対象を変える必要が出たら、止めてユーザーに確認する（MP-4 の C-17 と同じ条件）。
- **DR-MP5-5 待ちの終わり方。**
  - 画面が人を待たない 6 本は、main の保留に期限を掛ける（画面側の caller の時間切れは、画面への問い合わせの待ちを終わらせないため）。値は既存の `IPC_TIMEOUT_MS`（10 秒）を使い、時間切れは tool の失敗にする。
  - `ask_user` は人を待つ。期限は 30 分（Q3、承認済み）。時間切れは turn の中断（tool の失敗ではない）。期限のほかに、回答、Skip、Stop、強制中断（画面の喪失、quit、profile の制限、main に届いた workspace の切替）で終わる。
  - workspace の切替は main の強制中断では解けない（第 2 節）。4c-2 の lease の通知による cancel（DR-MP4-29）が、製品に届く前の必須の前提になる。
  - Stop と強制中断は、保留中の問い合わせを閉じてから turn を終える。閉じた後の回答は捨てる。
- **DR-MP5-6 直列化。** 1 turn の tool は 1 件ずつ実行される。同じ窓で保留できる質問は 1 件にし、2 件目は tool の失敗にする（画面の質問の枠は 1 つ）。
- **DR-MP5-7 回答の根拠。** 回答と結果は `mastra_agent_turn_answer` からだけ取る。tool の引数や実行 context の `resumeData`・`approved` は読まない。組込みの `ask_user`・`submit_plan`、`requireApproval`、suspend／resume は使わない。静的な試験と実行の試験で固定する。
- **DR-MP5-8 権限の確認。** main は問い合わせを出す前と回答を受けた後に、停止・強制中断・AI の chat の方針・workspace の identity を確かめる（4c-1 の send の前の確認と同じ読み方）。project・会話の対象・thread・route・license の変化は main から見えないので、4c-2 の watcher の cancel（DR-MP4-26、Q5 で受容済み）が保留も閉じる。
- **DR-MP5-9 定義と実装の再利用。** 7 本の定義は chat IR を含まない共有の module に置く（DR-MP4-30 と同じ形）。画面側は今の handler を遅延読み込みで呼び、起動時の JS には入れない。UI 操作の 1 turn あたりの回数の上限と、質問の回数の数え方は今の経路と同じにする。
- **DR-MP5-10 結果。** 結果の形（`content`・`summary`・`tokensUsed` ほか）と、モデルに返すのが `content` であることは今の経路と同じ。設定は提案のカードのままで、直接は変えない。
- **DR-MP5-12 応答側の権限の確認。** 画面の応答側は、handler を呼ぶ直前に、その turn の `assertTurnAuthority` と同じ確認を通す（今の経路の `createGuardedExecuteTool` と同じ位置）。失効していたら handler を呼ばず、拒否を回答として返す。main の確認（DR-MP5-8）だけでは、project・scope・license の変化と保存されるレイアウトの変更の間の窓が残るため（advisor の指摘、2026-11-26）。closure を応答側へ渡せない場合だけ、小さな境界を切り出す。
- **DR-MP5-11 記録を増やさない。** 問い合わせや回答の本文を新しく保存しない。監査の記録は provider への送信の単位のまま。問い合わせが終わったことは main の保留の解決と、窓の破棄などの事象で確かめる。再起動の後に復元しない。

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 場面                                               | 持ち主                                                                     | 受付を閉じる点                                                | 取り消し                         | 待ちの上限                                    | 終わった証拠         |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------- | --------------------------------------------- | -------------------- |
| 問い合わせの発行                                   | main の owner                                                              | turn が終端に入ったら出さない                                 | 送れなければ即時に閉じる         | なし（送出は同期）                            | 保留の登録と解放     |
| 保留（画面の実行）                                 | main の owner                                                              | 回答は 1 回                                                   | Stop、強制中断                   | 6 本は main の期限 10 秒。`ask_user` は 30 分 | 保留の解決           |
| 回答の受理                                         | main の owner                                                              | 受理の前に消費済みにする                                      | 誤った窓・ID・二重は拒否         | 即時                                          | 受理か拒否の戻り値   |
| Stop                                               | main の owner                                                              | 追加の tool と send を閉じる                                  | 保留を閉じる。画面の表示も閉じる | 即時                                          | start の結果が返る   |
| 強制中断（profile の制限、workspace の切替、quit） | main の owner                                                              | 新しい問い合わせを出さない                                    | 保留を閉じ、遅い回答を捨てる     | 既存の上限（切替 30 秒、quit 5 秒）           | 既存の強制中断の記録 |
| 画面の喪失（close、reload、crash、遷移）           | main の owner（窓の事象）                                                  | 同上                                                          | 同上                             | 即時                                          | 窓の事象             |
| 再入（同じ窓の同じ会話の二重の start）             | main の owner（既存）                                                      | busy で拒む。別の窓からの同じ会話は拒まない（今の経路と同じ） | なし                             | なし                                          | 拒否の戻り値         |
| 複数の窓                                           | main の owner                                                              | 回答は開始した窓だけ                                          | 他の窓に影響しない               | 同上                                          | 窓ごと               |
| license の制限、project・会話の対象の変化          | 4c-2 の watcher（DR-MP4-26）                                               | watcher の cancel                                             | 保留を閉じ、遅い回答を拒む       | Q5 の窓（受容済み）                           | cancel の戻り値      |
| workspace の切替の前の lease、audit の書き出し     | 4c-2 の持ち物（DR-MP4-29・31）。別の窓の turn を数える点も 4c-2 に申し送る | この案では変えない                                            | watcher の cancel が保留も閉じる | 4c-2 で決める                                 | 4c-2                 |

画面側の native の処理（今の 7 本には無い）が後から終わる場合は、MP-6 で扱う。

別の窓では、画面を操作する 2 本は今の経路と同じく失敗にする。

## 5. 影響と PR の分け方

| 経路               | 変える場所                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| wire と IPC の契約 | `mastraAgentTurnWire.ts`、`ipcContract.ts`（event と command を 1 つずつ、start の `tools` の拡張）                          |
| main               | `mastraAgentTurnGate.ts`、`ipc.ts`、`mastraTurnOwner.ts`、`agentRuntime.ts`（許可集合）、`agentToolAdapter.ts`、event の送出 |
| 共有の定義         | 7 本の定義の module（chat IR を import しない）                                                                              |
| 画面               | `src/lib/mastraAgentTurn.ts`、遅延読み込みの応答側、今の chat の handler、待ち行列の分類                                     |
| 試験               | parser、owner、wiring の静的試験、起動の閉包の試験、journey                                                                  |

`electron/shared/mastraRead/ports.ts` は触らない。

順序（どれも呼び手なしで積む。製品に届くのは 4c-2 と残りの tool が揃った後）：

1. **5a** 定義と wire：event・command・parser。脅威モデルの確定文書に W12 と改訂の記録を足す（第 6 節）。受入れ：知らない名前、余分な欄、大きすぎる値、別の窓を拒む。
2. **5b** main の保留：束縛、一回限り、Stop と強制中断、窓ごとの質問 1 件、権限の確認、回数の上限。受入れ：競合、二重と遅い回答、偽の `resumeData`・`approved`。
3. **5c** 画面の応答側：今の handler の遅延呼び出し、handler の前の権限の確認（DR-MP5-12）、回答の通り道。受入れ：行列が埋まっていても回答と Stop が通る、権限が失効した turn では handler を呼ばない（レイアウトの保存が予約されない）、起動時の JS が増えない。
4. **5d** main の tool への接続：許可集合に 7 本を足す。受入れ：journey、窓を閉じると保留中の `ask_user` の turn が有限の時間で終わる。

## 6. 脅威モデルへの反映（Q2、2026-11-26 に承認）

ユーザーの依頼で read-only の advisor に要否を諮り、その最小の形を採った。T と D は足さない（指示文による tool の誤実行は T9、renderer の不信頼は第 1 節が覆い、新しい authority は無い）。

- 確定文書の第 4 節に **W12 main→画面の保留中の問い合わせ** を足す（5a の PR）。中身：持ち主は main の turn の owner。回答は認可に使わない。Mastra の組込みの承認・suspend／resume・`resumeData` は使わない。`ask_user` は 30 分、他の 6 本は 10 秒。Stop・強制中断・画面の喪失で閉じ、遅い回答は捨てる。再起動の後に復元しない。待ちの間は turn が main と書き込み行列の枠を持ち、workspace の切替が進まない（W9 の 30 秒の前提が崩れる）。
- 4.3 の待ち時間の値と第 5 節の残るリスクに 1 行ずつ、冒頭に改訂の記録。
- 旗 L を開ける条件に、4c-2 の lease の通知による cancel（DR-MP4-29）を加える。
- `resumeData` の抜け道は脅威の項目にせず、Mastra の版を上げるたびの回帰試験（DR-MP5-7 の静的試験と実行の試験）で守る。
- 記録だけの残るリスク（今の経路と同じ、または DR-MP5-12 で塞ぐ）：パネルとレイアウトは確認なしで変わる（レイアウトは保存される）。同じ窓のコードは回答を偽れる（回答は認可に使わない）。license や対象の変化は main から見えない（DR-MP5-12 と 4c-2 の watcher）。provider への送信に時間の上限が無い。
- ユーザーに示した残るリスク：回答を待つ間（最大 30 分）、turn は枠を持ち続け、workspace の切替が進まない。

## 7. ユーザーに確認する点

回答（2026-11-26）：Q1 してよい。Q2 advisor の最小の形（第 6 節）。Q3 30 分。Q4 回す。

| ID  | 問い                                                                                                                                                                                 | 推奨     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Q1  | 新しい契約として、問い合わせの event 1 本、回答の command 1 本、start の `tools` への UI 系の追加をしてよいか                                                                        | してよい |
| Q2  | 第 6 節の内容を脅威モデルの確定文書に足してよいか（5a の PR で反映）                                                                                                                 | 足す     |
| Q3  | `ask_user` の回答がないまま何分で turn を中断するか。今の経路は上限なしだが、待ちを有限にする規則（GDX-PRECHECK-001）と、Mastra の経路では待ちが main と行列の枠を持ち続ける点が違う | 30 分    |
| Q4  | `propose_scene_body` を MP-6 に回し、MP-5 は 7 本にしてよいか（承認なら移行計画の件数を直し、問い合わせと終了の扱いは MP-6 で適用を決める）                                          | 回す     |

## 8. 採らなかった案と、残る不確かさ

- 進捗の event に問い合わせを混ぜる：契約の数は減るが、本文を含まないという進捗の約束が崩れる。
- turn の終わりを新しい監査の記録に残す、全部の窓の audit の書き出しを main で止める：保存と仕組みが増え、後者は 4c-2 の範囲。
- 全部の待ちに短い絶対の期限を置く（質問 5 分など）：考えながら答える質問を打ち切る。
- 未確認：実機での画面の喪失の挙動、待ち行列の分類を変えるときの drain への影響（5c の最初の試験で確かめる）。
