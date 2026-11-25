# agent の非 stream の送信を「停止」で中断する（2026-11-26）

## 目的

利用者の判断（2026-11-26）：agent の出力上限を上げる前に、「停止」で実行中の応答を中断できるようにする。今は `send_agent_message` が返るまで画面は生成中のままで、provider への通信も続く。

## 判断

- 中断の鍵は監査の `executionId`（呼び出しごとの値で、既に args にある）。`send_agent_message` の引数と戻り値の型は変えない。
- agent の送信は専用の登録簿（`AppState.agent_sends`、型は stream と同じ `StreamAbortRegistry`）に持つ。D2a の停止の障壁（`request_abort_all` と件数）は変えない。agent の送信は今までどおり `until_cancelled` で障壁が取り消す。
- 中断の入口は既存の `abort_chat_stream` を使う（N-API は両方の登録簿に中断を伝える）。新しい IPC command と権限の台帳の変更は無い。
- 中断は Native の送信の future を落とす（`grimodex-ai` は変えない）。再試行の待ちと本文の読み取りも含めて止まる。
- 利用者の停止で終わった送信は、`AI_REQUEST_STOPPED_BY_USER` を含む error で返す。renderer は監査を `cancelled`（stopped）で閉じる。
- 落とした送信には `transport.attempt.finished` が残らない（D2a の取り消しと同じ扱い。監査の規則は許す）。

## 影響マトリクス

| 層 | 変える | 変えない |
| --- | --- | --- |
| Rust `grimodex-ai` | なし | 送信の組み立てと provider の分岐 |
| `grimodex-node` | `state.rs`（登録簿の追加、中断の通知）、`lib.rs`（`send_agent_message` の登録と select、`abort_chat_stream`） | 署名と doc コメント（d.ts は変わらない） |
| IPC／preload／main | なし | `ipcContract.ts`、`profileEgress.ts` の台帳 |
| renderer | turn の `AbortController`、`chatApi.sendAgentMessage` の `signal`、store の親と research の子 | Context Creator、要約、chat の stream |

## 持ち主と終わり方

| 項目 | 内容 |
| --- | --- |
| 入口 | 親 agent の loop（`chatTurnStoreActions` の `sendToLLM`）、research の子（`chatAgentToolHandlers`）。どちらも今の turn が持ち主。Context Creator は停止の操作が無いので中断しない。Mastra の main の closure は N-API を直接呼ぶ（今回は配線しない。`backend.abortChatStream(executionId)` で中断できる）。 |
| 再試行・再入 | loop は呼び出しごとに新しい `executionId`。停止の後、loop は次の送信を始めない（既存の `shouldAbort`）。 |
| 登録 | Native が dispatch の permit を取る前に `executionId` を登録する（stream と同じ順）。 |
| 登録前の中断 | 登録簿の pending（上限つきの tombstone）が受け、後から登録した送信は通信せずに停止の error を返す。 |
| 持ち主（handle） | 登録簿の `StreamCancellation`。送信の関数は、全ての出口で `complete` する。 |
| 中断の契機 | 利用者の「停止」と、停止を呼ぶ操作（scene の切替の reset など、`turnCoordinator.abort`）。 |
| 待ちの上限 | 中断は Notify で即時に起き、future を落として終わる。`abort_chat_stream` はその終了（`complete`）を待って返る。 |
| 終了の証拠 | `complete` の quiesced と、future の drop（接続が閉じる）。 |
| 失敗の持ち主 | 送信の error は今までどおり呼び手に返る。中断の IPC の失敗は debug log に残し、送信は自然に終わる（今の挙動に戻る）。 |
| D2a の停止 | 変えない。障壁は `until_cancelled` で取り消し、その error（`legacy-request-stopped`）が返る。 |
| 再起動の後 | 持ち越す状態は無い（メモリの中だけ）。 |

## 終了と切替（利用者の判断 2026-11-26）

利用者の選択：アプリの終了、workspace の切替、project の切替の 3 つで、実行中の chat／agent があれば確認を出す。了承すれば「停止」と同じ扱いで中断して進み、断れば操作を取りやめる。

| 項目 | 内容 |
| --- | --- |
| 入口 | 窓の終了（`closeQuiescenceController`、panel の窓も同じ）、workspace を開く（`workspaceOpenLifecycle`）、project の読み込み（`projectStore`。workspace を開く途中の読み込みでは重ねて聞かない）。 |
| 順番 | 今ある拒否（inline AI の保留）の後、静止の lease を取る前に聞く。lease を取った後は turn の保存が止まりうるため。 |
| 対象の判定 | その窓の chat の store が生成中（`isStreaming`）。chat の store が lib の小さな登録口に「生成中か」と「停止」を登録する（`projectStore` から chat の store を直接読まない）。 |
| 了承 | まだ生成中なら `stopGeneration`。停止した turn の確定と監査の終端は、今ある静止の段（`ai-executions`、`scoped-mutations`、`ipc-actual-tasks`）が待つ。agent の送信は上の中断で速く終わる。 |
| 取りやめ | 何も止めず、操作を中止する（終了は veto、切替は `blocked`／読み込まない）。 |
| 多重の要求 | 確認を出している間の次の要求は、同じ確認の結果を待つ。 |
| 待ちの上限 | 確認は利用者の操作まで待つ（時間切れなし）。終了の要求は同期で `preventDefault` するので、Electron の予備の時間切れは働かない。 |
| 再起動の後 | 持ち越す状態は無い。 |

## 範囲外（残る制限）

- 別窓の chat の応答は、その窓を閉じるときは確認するが、main の窓の workspace／project の切替では確認しない（今も静止の対象外）。main の窓を閉じると、先に main が閉じ、続いて chat の窓で確認が出る。
- 要約（`send_chat_message`）、Context Creator、抽出などの他の AI の処理は中断せず、今までどおり終わるのを待つ。
- バックアップの復元、データの削除、監査の書き出しなど、他の操作は今までどおり待つ。
- 中断しても provider の側の生成と課金が止まる保証は無い（stream の停止と同じ）。
- 実行済みの道具の結果は残る。
