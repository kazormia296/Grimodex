# agent の非 stream の送信を「停止」で中断する（2026-11-26）

## 目的

利用者の判断（2026-11-26）：agent の出力上限を上げる前に、「停止」で実行中の応答を中断できるようにする。今は `send_agent_message` が返るまで画面は生成中のままで、provider への通信も続く。

## 判断

- 中断の鍵は監査の `executionId`（呼び出しごとの値で、既に args にある）。`send_agent_message` の引数と戻り値の型は変えない。
- agent の送信は専用の登録簿（`AppState.agent_sends`、型は stream と同じ `StreamAbortRegistry`）に持つ。D2a の停止の障壁（`request_abort_all` と件数）は変えない。agent の送信は今までどおり `until_cancelled` で障壁が取り消す。
- 中断の入口は既存の `abort_chat_stream` を使う（N-API は両方の登録簿に中断を伝える）。新しい IPC command と権限の台帳の変更は無い。
- 中断は Native の送信の future を落とす（`grimodex-ai` は変えない）。再試行の待ちと本文の読み取りも含めて止まる。
- 利用者の停止で終わった送信は、`AI_REQUEST_STOPPED_BY_USER` を含む error で返す。停止の障壁（D2a）が同時に働いていれば、その拒否を返す。renderer は停止の印のある失敗だけを `cancelled`（stopped）で閉じ、停止の後の別の失敗は `failed` で記録する。
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
| 失敗の持ち主 | 送信の error は今までどおり呼び手に返る。renderer は本文が停止の印だけの失敗を停止（監査は cancelled）、他は failed にする。中断の IPC の失敗は debug log に残し、送信は自然に終わる（今の挙動に戻る）。 |
| D2a の停止 | 変えない。障壁は `until_cancelled` で取り消し、その error（`legacy-request-stopped`）が返る。 |
| 再起動の後 | 持ち越す状態は無い（メモリの中だけ）。 |

## 終了と切替（利用者の判断 2026-11-26）

利用者の選択：アプリの終了、workspace の切替、project の切替の 3 つで、実行中の chat／agent があれば確認を出す。了承すれば「停止」と同じ扱いで中断して進み、断れば操作を取りやめる。

順番は「今ある拒否（inline AI の保留）→ 確認 → 停止（中断）→ 静止の lease → flush（自動保存ほか。#1021・#1079 の順は変えない）→ 閉じる／切り替える」。静止の段と lease の中身は変えず、lease の前に 1 段足す。信頼境界は変えない（送信先・送るデータ・権限は増えない。確認は利用者の操作を待つだけで、了承の無い中断はしない）。

| 項目 | 内容 |
| --- | --- |
| 入口 | 窓の終了（`closeQuiescenceController` の既定。panel の窓も同じ）、workspace を開く（`workspaceOpenLifecycle`）、利用者の project の切替（`ProjectMenu`）。取り込みの完了や `ensureProjectActive` などの内部の読み込み、同じ project の読み直しでは聞かない。3 つとも inline AI の保留の拒否を確認より先に置く（`ProjectMenu` は `loadProject` の中の拒否と別に入口でも断る。切り替えられないのに応答だけ止めないため）。 |
| 順番の理由 | 確認の画面を出したまま静止を始めないように確認を lease の前に置き、了承の直後に中断を始める。停止した turn の保存は静止の flush が待つ。 |
| 対象の判定 | その窓の chat の store が生成中（`isStreaming`）。chat の移動の制御（`chatNavigationComposition`）が lib の小さな登録口に「生成中か」と「停止」を登録する（切替の側は chat の store を直接読まない）。確認の画面は `ApplicationDialogs` に置く。 |
| 了承 | まだ生成中なら `stopGeneration`。停止した turn の確定と監査の終端は、今ある静止の段（`ai-executions`、`scoped-mutations`、`ipc-actual-tasks`）が待つ。agent の送信は上の中断で速く終わる。 |
| 取りやめ | 何も止めず、操作を中止する（終了は veto、切替は `blocked`／読み込まない）。 |
| 多重の要求 | 確認を出している間の同じ種類（終了、切替）の要求は、同じ確認の結果を待つ。違う種類の要求は取りやめる（出ている文面と違う操作に答えを流用しない）。確認中に応答が自然に終わっても、確認が閉じるまで同じ扱いにする。 |
| 待ちの上限 | 確認は利用者の操作まで待つ（時間切れなし）。終了の要求は同期で `preventDefault` するので、Electron の予備の時間切れは働かない。確認の画面を読み込めなければ「断る」と答える（固めない）。 |
| 再起動の後 | 持ち越す状態は無い。 |

### 切替の記録の順番（journey の確認）

停止は静止の lease より前に始まる。切替の記録（`lifecycleTrace`。journey の観測用で、製品の動きは変えない）は、進行中の記録が無いときの節目を捨てる。確認の了承から lease の取得までは IPC の往復を待たないので、欠ける節目は経路の構造で決まる。

- chat の応答：停止した応答の保存の開始（`old-stream-completed`）が lease より先になるので、この節目は載らない。保存の完了（`old-scope-persisted`）は IPC の往復の後なので載る。
- agent の応答：中断の IPC の往復の後に保存するので、2 段とも載る。
- timelapse の genesis が進行中なら lease の取得が IPC を待ち、欠け方が変わりうる（journey の場面では起きない）。
- 保存の完了は静止の flush が待つ。`chatStore.test.ts` の「keeps a switch waiting for the … turn stopped by its confirmation」の 2 本で、保存を止めている間は切替が進まないことと、上の記録の列を確かめる。
- journey の判断：chat の 2 本だけ `old-stream-completed` を任意にする。残りの 5 段（`old-scope-persisted` を含む）は要る。agent の 2 本は 6 段すべて要る。これで、保存が切替の確定の後になる回帰は実機でも落ちる。
- 局所の実機（2026-11-26、4 本）で、chat は 5 段、agent は 6 段の記録を確かめた。

## 範囲外（残る制限）

- 別窓の chat の応答は、その窓を閉じるときは確認するが、main の窓の workspace／project の切替では確認しない（今も静止の対象外）。main の窓を閉じると、先に main が閉じ、続いて chat の窓で確認が出る。
- 要約（`send_chat_message`）、Context Creator、抽出などの他の AI の処理は中断せず、今までどおり終わるのを待つ。
- バックアップの復元、データの削除、監査の書き出し、新しい project の作成と削除、取り込みの完了の切替など、他の操作は今までどおり待つ（取り込み中は確認を出さない）。
- 中断しても provider の側の生成と課金が止まる保証は無い（stream の停止と同じ）。
- 実行済みの道具の結果は残る。
- renderer の IPC の同時実行は 4 本なので、他の長い mutation が 4 本走っている間は、中断の命令もどれかの終了を待つ。
- 窓の終了の購読に失敗した異常な状態では、今までどおり `beforeunload` だけになり、生成中の応答は確認しない。
- 出力も道具の実行も無いまま中断した agent は、利用者の発言だけが残る（応答の行は作らない。確認の文の「途中までの応答」は空）。
