# chat の agent が承認済み Chronicle IR を引く経路（chat IR の S1）— 判断の記録（DR-CHATIR-S1）

この文書は、chat IR の S1（閉じたまま実装する段）の最初の mutation（S1-A0）の前に、技術判断と信頼境界を残す（S1-0）。
契約と脅威モデルの確認ではない。確認は下の「出所」のとおりユーザーが行った。この文書は確認済みの脅威モデルの文書を書き換えない。

## 出所

| 項目 | 内容 |
| ---- | ---- |
| この lane の位置 | **NIR-1 の残レーンの事前委任の外**。AGENTS の事前委任は chat IR に適用されない。契約（★1）・脅威モデル（★2）・audit の置き換え（★3(b)）・送るデータの範囲（★4）は、ユーザーが 2026-11-09 に個別に確認した。下の DR は、確認済みの脅威モデルの「確認が不要な技術判断」（★1・★2 の承認の後の、その設計の範囲内の可逆な実装の詳細）の範囲の判断である |
| 確認済みの脅威モデル | contracts の commit `357a87b7424e353de5b385ad5bc7eeec36309ab8`（枝 `claude/nir1-contracts`）の `docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/contract-confirmation-2026-11-09/consumer-contract-threat-model-draft.md`（git blob `de0343de327f47e421633b4a4f667891096dbc54`、SHA-256 `08f26f789501e6149852900e2fd537844843fbd9e1aad062ae33d52698a43db3`、72,170 byte） |
| 回答の逐語 | 同じ folder の `user-confirmation-2026-11-09-chat-ir-contract.md`（SHA-256 `1e5c48570edd69fdcbd26badf3219b2177e27e9f92304daaa3edd1ef0d383da8`）と `user-decisions-2026-11-09.md`（SHA-256 `2d9296ba78fd7e41e432b37ac2c2541d04a063d185cae507ee3081ba9552d7b2`）。★1「§3 のとおり承認する (推奨)」、★2「draft のとおり確認する。前提は S1 の前に実物で確かめる (推奨)」、★3「audit で IR の本文を置き換える (推奨)」、★4「承認の文言どおり要約と quote に限る (推奨)」（2026-11-09 07:52 JST） |
| 確認済みの回答（S1-A0 の audit の終端） | contracts の commit `dc533a4edb4dd464a657bd3bcf602c2ac7d3d5ac`（枝 `claude/nir1-contracts`）の `docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/user-confirmation-2026-11-17-s1-a0-audit-terminal.md`（git blob `933db2f02a0464a0f07946534cd970a99a8523e4`、SHA-256 `2a742c3feed51909492f01aa4bdf53651ba7606ccd8faa2ad8f84aeb4366d34b`）。回答：「終端を書けなければ IR を返さない (Recommended)」（2026-11-17）。確認済みの脅威モデルの文は変えない |
| 設計の正本 | repo の外の `fusion-eval-data/design-notes/chat-ir-2026-11-08/s1-design-draft.md`（改訂 3、SHA-256 `152bddd319b49f1b60ff427971e34a85d5fe82ace460c4d9984bd15d32bb6812`）。§16 が G3 の未確定のセルの決定、§15 が批評の 11 点の反映 |
| 批評者の判定 | 独立の批評者の判定（workflow の journal）の要点を、統合者が指示に写したもの。この文書の作業では journal そのものは読んでいない。要点：G1 は通過、G2 は条件つきで通過、G3 は未達。設計の 4 つの条件（★2 の前提、★3 の条件、CI seam、訂正・却下の store）はどれも崩れていない。S1-0 は着手してよい。S1-A は G3 を閉じるまで着手しない |
| 基点 | `origin/master` `27d71179` |

## 信頼境界

| 境界・actor | 扱い |
| ---- | ---- |
| 乗っ取られた renderer | 信頼しない。**範囲外**（確認済みの脅威モデル §4.1・§4.4）。G1 で、unrestricted の既定の起動の renderer が、`related_scenes_begin` → `continue` と review bundle（artifacts）と generic SQL（envelope の列）で、承認済みの IR の要約と quote に既に届くことを実物で確かめた。範囲外の結論を支える |
| model が `get_scene` で後の Scene を読むこと | 範囲外のまま（契約 §4.4） |
| 呼び出しの順 | renderer → typed preload IPC → Main（引数の再検証、sender の束縛、restricted の拒否、closed gate）→ N-API（Native の gate、同時実行の上限、期限）→ 共有 Rust。renderer は Node／Electron／N-API を直接 import しない。renderer は鮮度・読み順・承認・scope を渡さない |
| 閉じ方 | renderer の定数 false、Main の closed gate（CI seam を作らない）、Native の `PrePublicationEntry`。restricted では `plaintext-publication` で拒否 |
| 送信先 | 新しい宛先を作らない。S1 の間は IR を送らない。S3 の宛先の読みは S3 の前に伺う（D2） |
| 保存 | `usedIds` は承認 2 の内。発行の記録は process 内だけで本文を持たず、disk に書かない。audit は W1・W2 の `request.prepared` の IR の item を置き換える（★3(b)）。訂正・却下の store と migration は S1 で作らない（J1） |
| 閾値 | 現行の policy（ja の floor 0.813、en の 0.66、`irMaxScenes` 8）のまま。緩める変更はしない |
| T12（IR の query が接続を握り、chat が止まる） | 確認済みの必須の防御「期限、one-shot、同時に走る数の上限。期限を過ぎたら IR なしで返す」を、DR-CHATIR-S1-1・2・4 で弱めずに満たす |
| T16（置き換えの印の悪用） | Native が発行した item と完全に一致する部分だけを置き換える。重複 key の guard を要件にする（DR-CHATIR-S1-8） |

## 判断

| ID | 判断 | 理由と信頼境界 |
| -- | ---- | -------------- |
| DR-CHATIR-S1-1 | **G3-U1 期限の方式**：期限は新しく実装する。1 回の呼び出しに 1 つの期限（初期値 10 s）を、(1) 接続の取得と SQL、(2) 埋め込みの待ち、(3) scoring の 3 区間で見る。one-shot は埋め込みの model の load を起こさない（resident でなければ status `embedder-cold` で IR なし）。止められないのは推論 1 回分だけで、終了の上限は「期限＋推論 1 回分」 | 現行の read 経路には期限が無く、埋め込みの待ちは無期限（`runtime_embedder_admission.rs` の foreground）。load は途中で止められず、上限が実質無くなる。T12 の「期限」を 3 区間すべてで実際に効かせる |
| DR-CHATIR-S1-2 | **G3-U2 waiter を名乗らず、maintenance の cycle の間は取らない取得**：S1-A0 で grimodex-db に、waiter を名乗らない試み（`try_lock_conn_with_check`）を期限の内で短い間隔で繰り返し、取れたら同じ期限の下で SQL を走らせる公開の API を足す。**waiter を名乗らないだけでは maintenance を譲らせないことにならない**（cycle の継ぎ目で取ると次の取得が `NEX_MAINTENANCE_CONNECTION_PREEMPTED` になる。レビューで実測）ので、maintenance の no-wait guard が生きている間は、接続が空いていても取らず busy として期限まで待つ（DR-CHATIR-S1-12）。期限までに取れなければ `connection-busy` で IR なし | 公開の `with_participant_read_transaction` と `pub(crate)` の bounded 版は、接続を待つ間 foreground waiter を名乗り、maintenance に譲らせる。公開の `try_with_participant_read_transaction` は期限を持たない。私的な `participant_read_transaction_control_mode` が try と期限の両方を受けるので、それを包む |
| DR-CHATIR-S1-3 | **G3-U3 lane と caller timeout**：read lane。command を `src/lib/tauri.ts` の `READ_ONLY_COMMAND_TIMEOUTS` に登録する（S1-A。試験で固定）。caller timeout の初期値は 20 s（終了の上限より長い）。derived lane は採らない | 登録し忘れると mutation lane・timeout なしになり、workspace の切替・close の静止を握る。caller timeout で chat は止まらない |
| DR-CHATIR-S1-4 | **G3-U4 Native 側の同時実行数**：置く。process 全体で in-flight 2（初期値）。permit は `spawn_blocking` の task の中で取り、task が実際に戻るまで持つ（Promise の settle で離さない）。超えた呼び出しは待たずに `busy` で IR なし | 確認済みの防御「同時に走る数の上限」を Native が持つ。renderer の read lane（window ごとに 3 枠。caller timeout は枠を返さない）だけに頼らない。上限を 3 より小さくし、止まらない one-shot が残っても既存の read-only SQL の枠が残る |
| DR-CHATIR-S1-5 | **G3-U6 発行の記録の寿命・上限・破棄**：TTL を持たない。**押し出さない**。件数の上限（仮 4,096）に達したら新しい発行を拒む（`ledger-full`、IR なし）。破棄は workspace の DB の identity の変化と process の終了だけ。semantic の epoch は契機にしない。記録は使っても消さない。同じ digest は 1 件に数える。型・発行・満杯の拒否・破棄は S1-A、照合は S1-C | G2 の要件「進行中の turn の entry は押し出さない」と G3 の推奨「古い順に押し出す」の矛盾を、Native が turn を知らずに解く。押し出すと生きている turn の entry に当たり、unmatched（本文が audit に残る）か collision（turn が落ちる）になる。拒む側は IR を送らないだけ。`ask_user` は turn を無期限に開くので時間では切れない。epoch は同じ authority のまま turn の途中で回りうる。限界：長く動く process では枯渇しうる（値は S1-A で測り、S3 の前に見直す） |
| DR-CHATIR-S1-6 | **G3-U5、U7〜U13**：U5 sub-agent は Native を呼ぶ前に落とす。U7 Stop で wrapper を即 reject しない。U8 IR の失敗は閉じた status（`timeout`・`connection-busy`・`embedder-cold`・`busy`・`ledger-full`・`index-unavailable`・`unsupported` など）を別の欄に置き、年表は返し、「0 件の成功」と分ける。U9 Main は sender id と expectedWorkspacePath の組を検査し、状態を持たない。U10 participant だけを取り、app の終了・close の振る舞いを S1-A の試験で確かめる（待たれない形なら operation guard も取る）。U11 年表 → IR の直列。U12 G2 で解消（channel を狭めない）。U13 G2 で解消（path を絞らない。E1 の置き換えは接続を取る前） | 設計の改訂 3 §16.2。どれも送信先・保存範囲・閾値・契約・authority を動かさない |
| DR-CHATIR-S1-7 | **J1〜J8**（下の表） | 設計の改訂 3 §8.3 |
| DR-CHATIR-S1-8 | **audit の置き換えの要件と quote の正本**：quote の正本は revision の envelope の `effectiveMaterialBasis.evidenceSet[]`。`evidence.resolved@1` の artifact は照合の相手。G2 の要件 6 つを S1-A・S1-C の要件にする：(1) 送った文字列 1 つにつき 1 件の redaction の entry で、`originalSha256`・`originalByteLength` は置き換えの前の送った文字列そのもの、item の digest は `chatIrItems[]`。(2) canonical の規則（key は辞書順、数値は整数値なら整数・それ以外は f64 の最短表現、文字列は serde の escape。digest は napi に渡す `Value` から）。(3) executor は item を不透明に運ぶ。cap は `guardedExecuteTool` から渡し、`agentLoop.ts` は変えない。(4) 記録の寿命（DR-CHATIR-S1-5）。(5) 権限は `RedactedBatch` を受ける専用の入口で持つ。(6) 範囲の bytes が parse した値の再直列化と一致するときだけ照合する重複 key の guard。前提の `preserve_order`・`float_roundtrip` は S1-C の試験で CI に固定する。失敗は append の失敗＝送信しない（fail-closed） | ★3 の「送った文字列そのものの digest」を文字どおり満たす。重複 key の guard が無いと、本物と同じ canonical に別の本文を同居させて隠せた（G2 §2-5。T16 の穴）。通常の流れの unmatched 0 は S1-23 で固定する |
| DR-CHATIR-S1-9 | **PR の分け方と順**：S1-0（この文書。merge で G3 を閉じる）→ **S1-A0**（共有 crate の新しい取得の API と等価性・性質の試験だけ。napi・gate・IPC・製品の呼び手・既存の API の変更・migration は含めない）→ **S1-A**（S1-A0 の API を使う Native の one-shot と台帳。期限、同時実行の上限、発行の記録、要約の射影、canonical の関数、閉じた status、Main の gate と検証、restricted の拒否、`READ_ONLY_COMMAND_TIMEOUTS` の登録と lane の試験。renderer の wrapper・executor は含めない）→ S1-B → S1-C → S1-D | 新しい取得は共有 crate に要る（DR-CHATIR-S1-1・2）。既存の経路を動かさずに等価性を先に固める。S1-A0 も candidate ledger の対象にする |
| DR-CHATIR-S1-10 | **generic SQL の非対称（事実の記録。別の lane で扱う）**：unrestricted では、renderer の generic SQL で `narrative_proposal_revisions.reconciliation_envelope_json` が読め、IR の statement と quote に届く（G1 §4 の観測）。`execute.rs:299-316` の guard は `payload_json` の列だけを拒否する。確認済みの脅威モデルの「正本は generic SQL で読めない」は `payload_json` には当たるが、この列には当たらない。既存の製品の非対称で、S1 では guard を変えない | ★3 の推奨 (b) の理由 2 の前提は、今の製品では弱い。**結論 (b) は理由 1（ユーザーが (c) で訂正した向き「本文は残さない」）で残る**。範囲外の結論はむしろ支える。ユーザーへの事実の報告は統合者が済ませた。確認済みの防御を弱める決め方ではないので「要確認」には当たらない |
| DR-CHATIR-S1-11 | **S1-A0 の範囲の拡大（API が 4 つ＋期限つきの audit の append）**。(A) 統合者の技術判断：grimodex-db に 4 つ目の公開 primitive を足す。期限つき・waiter を名乗らない接続の取得（`try_with_conn_until`／`try_with_conn_mut_until`。try を期限の内で繰り返し、取れなければ `None`＝connection-busy。write にも使える）。chat IR の経路の audit の append は、これを使う appender（`try_append_ai_audit_events_for_scope_until`。busy の待ちを切る。DR-CHATIR-S1-12 で min(残り期限, 1 s)）で行う。既存の appender と経路は無変更。(D) 統合者の技術判断：chat IR の経路では project の spec を呼び手が渡し、prepare と scoring の**両方**の引数にする。prepare・scoring の中で DB を読まない（`strict_project_spec` の 5 回を消す）。渡された spec に対して既存と同じ検査（loaded の identity が spec と一致、query の identity が spec と一致、epoch の generation と cache の `Arc::ptr_eq`）を毎回行う。chat IR の query は `AuditedSemanticQuery` と別の型にし、DB を読む既存の API に渡せない。(B) ユーザーの回答（下の ref）：推論の前の記録（start／prepared／dispatched）が期限の内に書けなければ、推論せず IR を返さない。推論の後の終端の記録が期限の内に書けなければ、推論の結果は使わず IR なしで返し（fail-closed）、終端の記録は期限の外で書き足す。**書き足しの持ち主**：結果を受け取った呼び手。型は `PendingTerminalAudit`（`#[must_use]`、同じ event_id・payload のまま）で、`flush_with_budget`（waiter を名乗らない try の繰り返し、初期値 30 s）で書く。同じ event_id の再 append は既存の append が冪等に扱う。**書き足しが失敗したとき**：pending は呼び手の手元に残る（再試行できる）。捨てられるときは `tracing::error` で execution_id を残す。dispatched のまま終端の無い execution が残るが、その結果は IR として使われない（`ChatIrQuery` は終端の append が成功した後でだけ作られる）。終端の無い execution を audit の読み手が crash と同じに扱うことは既存の挙動 | 範囲の拡大は T12 の確認済みの防御を**強める**側（既存の取得は期限なしで foreground waiter を名乗り、project の spec の確認と audit の append で maintenance を譲らせる）。**信頼境界**：(1) spec の出所と鮮度は呼び手（S1-A の Native）の責任。呼び手は spec を同じ read transaction の中の project の language から導く。prepare と scoring で毎回渡すので、既存の「毎回読み直す」より弱くならないのは呼び手が毎回導く場合だけ。(2) 新しい宛先・保存範囲・閾値・契約・authority は無い。埋め込みは local の ONNX で、audit は既存の `ai_audit_events` に既存の形で書く（metadata の `sharedConsumers` と `consumer` が `chat-ir`）。(3) 期限の 3 区間に、audit の append の区間が加わる。append の SQL そのもの（BEGIN IMMEDIATE の後の 1 回の短い書き込み）は途中で止められないので、終了の上限は「期限＋推論 1 回分＋append の書き込み 1 回分」。busy の待ちと接続の取得は期限で打ち切る。(4) 埋め込みの admission は foreground の waiter を名乗る（設計の §3.3 の決定。DB の接続とは別。background の文書 batch は文書の間で譲る）。chat IR は admission を握ったまま、接続を最長で残り期限まで待つので、その間 live の foreground の埋め込みが後ろで待つ。S1-A0 には呼び手が無いので動かない。**未解決として S1-A と統合者の判断に渡す**。(5) 書き足しをどの task・thread で動かすか（応答の後の第 2 の task なら新しい background lifecycle）は S1-A の owner／lifecycle matrix の項目。S1-A0 は型と flush だけで、thread を作らない。S1-A0 の範囲は、設計の §16.3 の「API 3 つ」から「API 4 つ＋期限つきの audit の append」に広がる（napi・gate・IPC・製品の呼び手・既存 API の変更・migration は含めない） |
| DR-CHATIR-S1-12 | **統合者の判断（S1-A0 のレビューの指摘の修正）**。(1) **maintenance の Run を chat IR のせいで cancel させない**：`connection_deadline.rs` の `try_lock_conn_until_with_check` の各試行で、`maintenance_no_wait_guard_alive()` が真なら、接続が空いていても取らず busy として扱い、期限まで待って `None`（connection-busy）にする。判定は試行の前と、mutex を取った後（`try_lock_conn_with_check` が check を前後で呼ぶ。背景の先払いと同じ形）の両方。chat IR の読みと終端の書き足し（flush）の両方に効く。T12 を強める向き（IR の可用性を下げる）で、既存の maintenance の取得・既存の API の挙動は変えない。**可用性への影響**：maintenance の cycle が生きている間は IR が返らない（`connection-busy`）。cycle の長さと頻度は S1-A／S2 で測る事項。**効かない範囲**：chat IR の呼び出しがすでに接続を握っている間に cycle が始まると、maintenance の最初の取得は held に当たる。これは他の foreground の holder と同じ既存の挙動で、握る時間は呼び手の期限で bounded。呼び出しの thread 自身が maintenance の guard を持つ場合は想定外の呼び手（常に busy になる）。(2) audit の append の busy 待ちを min(残り期限, 1 s) に切る（`BOUNDED_APPEND_MAX_BUSY_WAIT`）。接続を握ったまま他の writer を待つので短くする。足りなければ、推論の前は `ConnectionBusy`（推論しない）、終端は defer（書き足し）。SQLite の busy／locked の error はこの appender で「期限の内に durable にならなかった」として扱う（grimodex-db の API は error のまま）。(3) 終端の append が書けなかった理由は `Timeout` に含める（`ChatIrUnavailable::Timeout` の doc に「Timeout は期限切れか、終端の audit が書けなかったこと」と明記）。reason を分けない（推論の前の `ConnectionBusy` と、推論の失敗の `InferenceFailed` は別のまま）。(4) 試験：no-wait guard の下で継ぎ目を繰り返す maintenance 役に chat 側が期限まで polling しても PREEMPTED にならない（guard の判定を外す変異で落ちる）。participant の read の operation 内の `busy_timeout` が残り期限以下、bounded append の前後で接続の `busy_timeout` が既定に戻る、busy の error は busy／locked、embedder admission の `foreground_until`（期限内の解放で走る／待つ間は waiter 1 で background が入らない／期限で取り下げたら waiter 0 で background が入る）。(5) **S1-A への持ち越し**（コードは変えない）：下の箇条 | S1-A0 のレビューで、waiter を名乗らなくても cycle の継ぎ目で取ると maintenance の次の取得が preempt され Run が cancelled になることを実測で再現した。「maintenance を譲らせない」は waiter を名乗らないことだけでは成り立たず、cycle の間は取らないことが要る。確認済みの防御（T12）を弱めず、閾値・送信先・保存範囲・契約・authority は動かさない（可用性を下げる向き）。1 s の clip は、接続を握ったまま他の writer を待つ時間を短くする向きで、足りなければ既存の deferral の規則に落ちる |

### J1〜J8（DR-CHATIR-S1-7）

| J | 判断 | 理由 |
| -- | ---- | ---- |
| J1 | 訂正・却下の store と migration を S1 に入れない。S3 の準備に回し、範囲の縮小として PR 本文に書く | 閉じていても migration は出荷され、`user_version` が新しい workspace は前の版で開けなくなる。データは開けるまで生まれず、S2 も使わない |
| J2 | 選択の純関数を `scoring::run` と共有するか、可視性を広げるかは、S1-A の最初に決める。共有するなら等価性の試験を足す | Related Scenes（live）の回帰の危険と、S2 との照合の楽さの比較 |
| J3 | chat 用の policy を Related Scenes の policy と分ける。S1 は同じ値で始める | 値の変更が Related Scenes に効かないようにする。緩める向きは委任の外 |
| J4 | 今の Scene は turn の開始時に捕まえて executor が保持する | T3 の固定 |
| J5 | 期限の初期値 10 s、終了の上限は「期限＋推論 1 回分」、read lane、caller timeout の初期値 20 s、エラーは閉じた集合 | DR-CHATIR-S1-1・3・6 |
| J6 | Hermes の channel でも IR を返す（縮小は要らない） | G2 で Hermes を含む 4 形すべてで置き換えが成り立った |
| J7 | 既存の secret の filter の基準の Scene は、定数 false の間は実行時の `activeSceneId`（今のまま）。true で turn の開始時の Scene に揃える | 定数の外の既存の挙動を変えない |
| J8 | S1-C は event 単位の `captureState: "redacted"`。path の `captureLevel` を `partial-observable` にする変更は S3 で行い、その前に伺う（D4） | S1 の間は IR の event が生まれないので、path の宣言を変えると記録が事実と違う |

## 「要確認」になる決め方（採っていない）

次の決め方は確認済みの防御を弱めるので、採る場合はユーザーへの確認が要る。この文書の判断はどれも採っていない。

- renderer の read lane だけに頼り、Native の同時実行数の上限を置かない。
- 期限を無期限にする（model の load を上限なしで期限に含めるのも、実質これに当たる）。
- foreground waiter を名乗って maintenance を譲らせる取得を使う。

## gate の記録の場所

いずれも repo の外の `fusion-eval-data/design-notes/chat-ir-2026-11-08/`。

| gate | 記録 | SHA-256 | 結果 |
| ---- | ---- | ------- | ---- |
| G0 | contracts `357a87b7`（上の「出所」） | — | 済み |
| G1（S1-17 と review bundle の実物の確認） | `s1-gate-g1.md`（証拠は `s1-g1-evidence/`。応答の実物は外へ出さない） | `730499ed975836417b6dcbe3a3caa46ff7dec704e0bc4374a4d591db974f1d51` | 通過。C1 は発火しない |
| G2（★3 の条件の spike） | `s1-gate-g2.md`（dev 枝 `claude/dev-chat-ir-g2-spike` は捨てる。push しない） | `eb269fd50c5729e43ced0fa0ec74df5ad186c266f41072a6d0602ff34060cf1d` | 条件つきで通過。C2 は発火しない。残り（実物の行での組み立て直し、要約の射影関数、BPE の実 tokenizer）は設計の §8.1 の G2-残 |
| G3（owner／lifecycle matrix） | `s1-gate-g3-matrix.md` | `26ef980ac74dd69d08e75324e61cd0266d6f5084b22f0e6119b8ca070954d73f` | matrix は作成済み。未確定のセルの決定はこの文書（DR-CHATIR-S1-1〜6）。**この文書の merge で G3 を閉じる** |

## 範囲外

- 経路の開放（S3）、τ・上限の確定値（S2）、PUB-G。
- generic SQL の envelope の列の guard（DR-CHATIR-S1-10。別の lane）。
- 確認済みの脅威モデルの文書の改訂。契約 §3.8 の matrix の文面は書き換えず、この文書と設計の改訂 3 で直す。

## S1-A0 の実装の記録（2026-11-17）

S1-A0（共有 crate の新しい取得の API と等価性・性質の試験）の実装結果。判断は DR-CHATIR-S1-1・2・8・9・11。製品の呼び手・napi・gate・IPC・migration は含めない。既存の API の挙動は変えていない（既存 source の変更は private な関数の引数の置き換えと、private な部分の関数への切り出しだけ。下の「既存 file の変更」）。

### 足した公開 API

| crate | API | 役割 |
| ----- | --- | ---- |
| grimodex-db | `Database::try_with_participant_read_transaction_until`（`narrative_maintenance_connection.rs`） | API 1。waiter を名乗らず、try を期限の内で繰り返し、取れたら SQL（progress hook）と busy の待ちも同じ期限の下で走らせる participant の read。取れなければ `Ok(None)`（connection-busy）、取れた後の期限切れは typed な `TimedOut` |
| grimodex-db | `Database::try_with_conn_until`／`try_with_conn_mut_until`（新 file `connection_deadline.rs`） | API 4（DR-CHATIR-S1-11 の (A)）。期限つき・waiter を名乗らない接続の取得。write にも使える |
| grimodex-db | `Database::try_append_ai_audit_events_for_scope_until`（`ai_audit.rs`） | API 4 の上の audit の append。busy の待ちを min(残り期限, 1 s) に切る（DR-CHATIR-S1-12）（既存の append は 5 s 固定）。検証・行・順序は既存と同じ |
| grimodex-semantic | `SemanticRuntime::prepare_chat_ir_query`（新 file `runtime_chat_ir.rs`） | API 2。期限つき・resident だけの埋め込みの取得と chat IR 用の query の準備。model の load を起こさない（`EmbedderCold`）。spec は呼び手が渡し DB を読まない（D）。audit は chat IR の consumer 名で、期限つき・waiter を名乗らない appender（B） |
| grimodex-semantic | `SemanticRuntime::score_chat_ir_documents_until`／`validate_chat_ir_query_current` | API 3。期限を候補ごとに見る scoring。同じ検査を渡された spec に対して行う |
| grimodex-semantic | `ChatIrQuery`、`ChatIrPrepareOutcome`、`ChatIrUnavailable`、`ChatIrScoreOutcome`、`PendingTerminalAudit`、`TERMINAL_BACKFILL_BUDGET` | `ChatIrQuery` は `AuditedSemanticQuery` と別の型（DB を読む既存の API に渡せない）。`Query` の variant は pending の記録を持てない（終端の無い結果は型の上で使えない） |

### 既存 file の変更（挙動不変）

- `narrative_maintenance_connection.rs`：private な `try_only: bool` を private な `ConnectionAcquisition`（`Blocking`／`TryOnce`／`TryUntil`）に置き換え、既存の 2 つの呼び手は `Blocking`／`TryOnce` と `None` の busy で呼ぶ（前と同じ）。
- `ai_audit.rs`：`append_ai_audit_events_with_durability` の本体を、busy の待ちを引数にする private な関数に切り出し、元の関数は `BUSY_TIMEOUT` で呼ぶ（前と同じ）。
- `runtime.rs`：`start_embedding_audit` の本体を、appender を引数にする private な関数に切り出し、元の関数は `request.database()` で呼ぶ（前と同じ）。`mod`／`pub use` の追加。
- `runtime_embedder_admission.rs`：`foreground_until` と `acquire_foreground_until` の追加だけ（既存の関数は無変更）。
- `lib.rs`：`mod connection_deadline;` の 1 行。

### T12 に対する期限の 4 区間と、止められない区間

1. 接続の取得：try の繰り返しを期限で打ち切る（`None`）。foreground waiter を名乗らず、並んだ foreground や finalization を追い越さない。maintenance の cycle（no-wait guard）が生きている間は、空いていても取らない（DR-CHATIR-S1-12。waiter を名乗らないだけでは cycle の継ぎ目で取って preempt する）。
2. SQL：participant の read は progress hook と busy の待ちが期限で止まる。
3. 埋め込みの待ち：admission の待ちと embedder の map の try-lock が期限で止まり、waiter の数を戻す。model は load しない。
4. audit の append と scoring：append の接続の取得が期限で止まり、busy の待ちは min(残り期限, 1 s) で止まる（DR-CHATIR-S1-12）。scoring は候補ごとに期限を見る。

止められない区間は、推論 1 回分（`embed_query`）と、接続を取った後の append の書き込み 1 回分（短い 1 transaction）。終了の上限は「期限＋推論 1 回分＋append の書き込み 1 回分」。

**統合者の受入れが要る差分**：設計の §16 の G3-U1 と DR-CHATIR-S1-1 の終了の上限は「期限＋推論 1 回分」。実装では audit の append の書き込み 1 回分が加わる。audit の append は DR-11 の (B) で期限の内の記録になり、書き込みそのもの（BEGIN IMMEDIATE の後の短い 1 transaction）に progress hook を掛けていないため。採らなかった代案：append の transaction に progress handler を掛けて期限で中断する（hook の登録は `hook_registration` に集約する規則に触れ、S1-A0 の範囲が広がるため。中断しても append は原子的に何も書かれず、pre-inference は `ConnectionBusy`、terminal は defer に倒れるので、T12 を強める向きの追加の実装として S1-A で選べる）。DR-CHATIR-S1-1 の U の決定は変えていない。

### 終端の書き足し（B）の決定

- 推論の前の記録は 1 batch（start／prepared／dispatched）で原子的。期限の内に書けなければ何も書かれず、推論せず `ConnectionBusy`。
- 推論の後の終端（`response.completed`＋`execution.succeeded`、`execution.failed`、`execution.cancelled`）が期限の内に書けなければ、結果は使わず（`Query` を作らない）、event を元の id・時刻のまま `PendingTerminalAudit` に入れて返す。順序を保つため、一度 defer したら後の append も後ろに積む。
- 持ち主は呼び手（S1-A の Native）。`flush_with_budget`（waiter を名乗らない try の繰り返し、初期値 30 s。同じ event は既存の append が冪等に扱う）。失敗（busy のまま・エラー）なら pending は手元に残り、再試行できる。捨てられるときは `tracing::error`（execution_id つき）。
- 終端が期限の内に書けず defer した場合だけでなく、書けたが**期限を過ぎてから**だった場合も IR は返さない（`Timeout`、pending なし。終端は既に durable）。「期限の内に書けなければ結果は使わない」を、書き込みの成否ではなく、書き終えた時刻で判定する。
- 終端の無い execution が残っても、その結果は IR として使われない。
- どの task で flush を動かすか（応答の後の第 2 の task なら新しい background lifecycle）は S1-A の owner／lifecycle matrix に渡す。

### 未解決（S1-A と統合者の判断に渡す）

- chat IR は embedder の admission を握ったまま、接続を最長で残り期限まで待つ。その間、live の foreground の埋め込み（Related Scenes など）が admission の後ろで待つ。S1-A0 には呼び手が無いので動かないが、S1-A で期限の初期値（10 s）と合わせて決める。
- `PendingTerminalAudit` を flush する task の持ち主（上）。
- prepare と scoring の spec は呼び手が毎回導く前提（DR-CHATIR-S1-11 の信頼境界 (1)）。S1-A で同じ read transaction の中の project の language から導く形を試験で固定する。

## DR-CHATIR-S1-12 の S1-A への持ち越し（コードは変えていない）

- **admission を握ったまま接続を待つ件**：chat IR は埋め込みの admission を握ったまま接続（と audit の append）を最長で残り期限まで待つ。その間 live の foreground の埋め込みが後ろで待つ。pre-inference の append を admission の外に出す案（admission の前に start の記録を書き、取れたら admission を取る）を S1-A で比べる。
- **query の byte 長の上限**：chat IR の query（embedding の入力）の byte 長に上限が無い。S1-A の Native の入口で上限を置き、超えたら IR なしにする。
- **`PendingTerminalAudit` の flush**：flush の持ち主（task・thread）、同時に持てる件数の上限、workspace の close 時の lease（close の静止を握らない形で、未 flush を捨てるのか待つのか）を S1-A の owner／lifecycle matrix で決める。
- **scoring の spec**：spec は同じ read transaction の中の `projects.language` から導く。project 行が無いとき（欠落）の確認と、その場合の status（IR なし）を S1-A の試験で固定する。
- **`score_accepted_documents` の包み**：既存の `score_accepted_documents` を `score_vectors_until` の包みにして、既存の経路と chat IR の経路で同じ scoring の本体にする（等価性の試験は S1-A0 にある）。Related Scenes の回帰の危険と比べて S1-A で決める。
