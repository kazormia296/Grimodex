# chat の agent が承認済み Chronicle IR を引く経路（chat IR の S1）— 判断の記録（DR-CHATIR-S1）

この文書は、chat IR の S1（閉じたまま実装する段）の最初の mutation（S1-A0）の前に、技術判断と信頼境界を残す（S1-0）。
契約と脅威モデルの確認ではない。確認は下の「出所」のとおりユーザーが行った。この文書は確認済みの脅威モデルの文書を書き換えない。

## 出所

| 項目 | 内容 |
| ---- | ---- |
| この lane の位置 | **NIR-1 の残レーンの事前委任の外**。AGENTS の事前委任は chat IR に適用されない。契約（★1）・脅威モデル（★2）・audit の置き換え（★3(b)）・送るデータの範囲（★4）は、ユーザーが 2026-11-09 に個別に確認した。下の DR は、確認済みの脅威モデルの「確認が不要な技術判断」（★1・★2 の承認の後の、その設計の範囲内の可逆な実装の詳細）の範囲の判断である |
| 確認済みの脅威モデル | contracts の commit `357a87b7424e353de5b385ad5bc7eeec36309ab8`（枝 `claude/nir1-contracts`）の `docs/plans/nir1-fusion-records/ir-chat-pilot-2026-11/contract-confirmation-2026-11-09/consumer-contract-threat-model-draft.md`（git blob `de0343de327f47e421633b4a4f667891096dbc54`、SHA-256 `08f26f789501e6149852900e2fd537844843fbd9e1aad062ae33d52698a43db3`、72,170 byte） |
| 回答の逐語 | 同じ folder の `user-confirmation-2026-11-09-chat-ir-contract.md`（SHA-256 `1e5c48570edd69fdcbd26badf3219b2177e27e9f92304daaa3edd1ef0d383da8`）と `user-decisions-2026-11-09.md`（SHA-256 `2d9296ba78fd7e41e432b37ac2c2541d04a063d185cae507ee3081ba9552d7b2`）。★1「§3 のとおり承認する (推奨)」、★2「draft のとおり確認する。前提は S1 の前に実物で確かめる (推奨)」、★3「audit で IR の本文を置き換える (推奨)」、★4「承認の文言どおり要約と quote に限る (推奨)」（2026-11-09 07:52 JST） |
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
| DR-CHATIR-S1-2 | **G3-U2 maintenance を譲らせない取得**：S1-A0 で grimodex-db に、waiter を名乗らない試み（`try_lock_conn_with_check`）を期限の内で短い間隔で繰り返し、取れたら同じ期限の下で SQL を走らせる公開の API を足す。期限までに取れなければ `connection-busy` で IR なし | 公開の `with_participant_read_transaction` と `pub(crate)` の bounded 版は、接続を待つ間 foreground waiter を名乗り、maintenance に譲らせる。公開の `try_with_participant_read_transaction` は期限を持たない。私的な `participant_read_transaction_control_mode` が try と期限の両方を受けるので、それを包む |
| DR-CHATIR-S1-3 | **G3-U3 lane と caller timeout**：read lane。command を `src/lib/tauri.ts` の `READ_ONLY_COMMAND_TIMEOUTS` に登録する（S1-A。試験で固定）。caller timeout の初期値は 20 s（終了の上限より長い）。derived lane は採らない | 登録し忘れると mutation lane・timeout なしになり、workspace の切替・close の静止を握る。caller timeout で chat は止まらない |
| DR-CHATIR-S1-4 | **G3-U4 Native 側の同時実行数**：置く。process 全体で in-flight 2（初期値）。permit は `spawn_blocking` の task の中で取り、task が実際に戻るまで持つ（Promise の settle で離さない）。超えた呼び出しは待たずに `busy` で IR なし | 確認済みの防御「同時に走る数の上限」を Native が持つ。renderer の read lane（window ごとに 3 枠。caller timeout は枠を返さない）だけに頼らない。上限を 3 より小さくし、止まらない one-shot が残っても既存の read-only SQL の枠が残る |
| DR-CHATIR-S1-5 | **G3-U6 発行の記録の寿命・上限・破棄**：TTL を持たない。**押し出さない**。件数の上限（仮 4,096）に達したら新しい発行を拒む（`ledger-full`、IR なし）。破棄は workspace の DB の identity の変化と process の終了だけ。semantic の epoch は契機にしない。記録は使っても消さない。同じ digest は 1 件に数える。型・発行・満杯の拒否・破棄は S1-A、照合は S1-C | G2 の要件「進行中の turn の entry は押し出さない」と G3 の推奨「古い順に押し出す」の矛盾を、Native が turn を知らずに解く。押し出すと生きている turn の entry に当たり、unmatched（本文が audit に残る）か collision（turn が落ちる）になる。拒む側は IR を送らないだけ。`ask_user` は turn を無期限に開くので時間では切れない。epoch は同じ authority のまま turn の途中で回りうる。限界：長く動く process では枯渇しうる（値は S1-A で測り、S3 の前に見直す） |
| DR-CHATIR-S1-6 | **G3-U5、U7〜U13**：U5 sub-agent は Native を呼ぶ前に落とす。U7 Stop で wrapper を即 reject しない。U8 IR の失敗は閉じた status（`timeout`・`connection-busy`・`embedder-cold`・`busy`・`ledger-full`・`index-unavailable`・`unsupported` など）を別の欄に置き、年表は返し、「0 件の成功」と分ける。U9 Main は sender id と expectedWorkspacePath の組を検査し、状態を持たない。U10 participant だけを取り、app の終了・close の振る舞いを S1-A の試験で確かめる（待たれない形なら operation guard も取る）。U11 年表 → IR の直列。U12 G2 で解消（channel を狭めない）。U13 G2 で解消（path を絞らない。E1 の置き換えは接続を取る前） | 設計の改訂 3 §16.2。どれも送信先・保存範囲・閾値・契約・authority を動かさない |
| DR-CHATIR-S1-7 | **J1〜J8**（下の表） | 設計の改訂 3 §8.3 |
| DR-CHATIR-S1-8 | **audit の置き換えの要件と quote の正本**：quote の正本は revision の envelope の `effectiveMaterialBasis.evidenceSet[]`。`evidence.resolved@1` の artifact は照合の相手。G2 の要件 6 つを S1-A・S1-C の要件にする：(1) 送った文字列 1 つにつき 1 件の redaction の entry で、`originalSha256`・`originalByteLength` は置き換えの前の送った文字列そのもの、item の digest は `chatIrItems[]`。(2) canonical の規則（key は辞書順、数値は整数値なら整数・それ以外は f64 の最短表現、文字列は serde の escape。digest は napi に渡す `Value` から）。(3) executor は item を不透明に運ぶ。cap は `guardedExecuteTool` から渡し、`agentLoop.ts` は変えない。(4) 記録の寿命（DR-CHATIR-S1-5）。(5) 権限は `RedactedBatch` を受ける専用の入口で持つ。(6) 範囲の bytes が parse した値の再直列化と一致するときだけ照合する重複 key の guard。前提の `preserve_order`・`float_roundtrip` は S1-C の試験で CI に固定する。失敗は append の失敗＝送信しない（fail-closed） | ★3 の「送った文字列そのものの digest」を文字どおり満たす。重複 key の guard が無いと、本物と同じ canonical に別の本文を同居させて隠せた（G2 §2-5。T16 の穴）。通常の流れの unmatched 0 は S1-23 で固定する |
| DR-CHATIR-S1-9 | **PR の分け方と順**：S1-0（この文書。merge で G3 を閉じる）→ **S1-A0**（共有 crate の新しい取得の API と等価性・性質の試験だけ。napi・gate・IPC・製品の呼び手・既存の API の変更・migration は含めない）→ **S1-A**（S1-A0 の API を使う Native の one-shot と台帳。期限、同時実行の上限、発行の記録、要約の射影、canonical の関数、閉じた status、Main の gate と検証、restricted の拒否、`READ_ONLY_COMMAND_TIMEOUTS` の登録と lane の試験。renderer の wrapper・executor は含めない）→ S1-B → S1-C → S1-D | 新しい取得は共有 crate に要る（DR-CHATIR-S1-1・2）。既存の経路を動かさずに等価性を先に固める。S1-A0 も candidate ledger の対象にする |
| DR-CHATIR-S1-10 | **generic SQL の非対称（事実の記録。別の lane で扱う）**：unrestricted では、renderer の generic SQL で `narrative_proposal_revisions.reconciliation_envelope_json` が読め、IR の statement と quote に届く（G1 §4 の観測）。`execute.rs:299-316` の guard は `payload_json` の列だけを拒否する。確認済みの脅威モデルの「正本は generic SQL で読めない」は `payload_json` には当たるが、この列には当たらない。既存の製品の非対称で、S1 では guard を変えない | ★3 の推奨 (b) の理由 2 の前提は、今の製品では弱い。**結論 (b) は理由 1（ユーザーが (c) で訂正した向き「本文は残さない」）で残る**。範囲外の結論はむしろ支える。ユーザーへの事実の報告は統合者が済ませた。確認済みの防御を弱める決め方ではないので「要確認」には当たらない |

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
