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

## 範囲外（残る制限）

- アプリの終了と workspace の切替は、実行中の turn が終わるまで待つ（今の静止の設計。stream の chat も同じ）。「停止」を押せば早く終わる。
- 要約（`send_chat_message`）と Context Creator の送信は中断しない。
- 中断しても provider の側の生成と課金が止まる保証は無い（stream の停止と同じ）。
- 実行済みの道具の結果は残る。
