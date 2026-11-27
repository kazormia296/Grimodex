# Mastra 移行の脅威モデルと owner／lifecycle の表（2026-11-19 確定）

- 状態：**確定（U-1、2026-11-19 にユーザーが「このまま確定」と回答）**。変更は新しい確認を要する。
- 改訂の記録（2026-11-27、ユーザー確認済み、4c-2）：Q5 の停止通知までの窓と、会話・表示対象・model／接続先・scene の変更中も開始時の値で継続する条件を追記。
- 改訂の記録（2026-11-27、4c-2）：2026-11-24 に Q5 として受容済みの (a)〜(f) を明示し、DB の古さ、scene 本文 barrier なし、batch 中の tree 再計算なし、年表 cache の窓、および K-17 の policy 永続窓を記載。
- 改訂の記録（2026-11-21、ユーザー確認済み）：[MP-4 の判断](mastra-mp4-decisions.md)の決定 3 と回答 3 により、T13・D16・W11 と残るリスクの 1 行を足し、chat IR の文言を「IR を開ける lane まで閉（MP-4 を含む）」に揃えた。
- 改訂の記録（2026-11-26、ユーザー確認済み）：[MP-5 の判断](mastra-mp5-decisions.md)の Q2 により、W12 を足した。
- 同時の回答：
  - 残るリスクのうち、次の 3 つを、旗を開ける前の受入れの条件に上げる。
    - P5(c)：tool の本文を observer と題名から絞る。
    - X10：message の削除で、由来する OM の部分を消す。
    - X13：実 key で、token 数の POST が起きないことを測る。実在の provider へ送る測定で、U-18 として承認された。
  - 選ばれなかった残るリスクは、開示して受け入れる。
  - 旗 L・M の新しい `PrePublicationEntry`（closed gate。開けられるのは journey の seam だけ）は、U-3 の承認に含める。
    確認が未了なら、MP-1 以降の最初の変更の前に `[precheck]` で止まる（[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)）。
- 位置づけ：この文書は**ユーザーの確認ではない**。NIR-1 の事前委任（AGENTS.md の作業範囲）は、この移行に及ばない。
- 親文書：[`mastra-migration-plan.md`](mastra-migration-plan.md)（MP の割当て、U-n、P1〜P18 の回答）。
- 範囲：移行後に生じる、送信・保存・subprocess・背景処理・非同期 lifecycle の棚卸し（X）、脅威（T）、必須の防御（D）、
  残るリスク、owner／lifecycle の表（W）。
- 根拠の略記は計画書の第 0 節。`R-n` は計画書の第 9 節、`U-n` は第 7 節、`MP-n` は第 6 節。`S-Mn`、`S2`〜`S6`、`M`、`Q`、`設計 §n` は local の spike 枝（`claude/mastra-spike`）にあり、master に無い。
  この文書は、必要な事実だけを ID 付きで要約した。
- 区別：**実行**（spike で走らせた）、**読解**（dist や docs を読んだ）、**未確認**。根拠が無い欄は「未確認」と書き、推測で埋めない。
- ee については決定だけを書く（D8）。license の条文の引用と読解は入れない（U-2）。
- **spike の限界（全行に共通）**：実行は fake の model・embedder・storage・Rust と、素の Node（`ELECTRON_RUN_AS_NODE` の Node を含む）だけ。
  本物の Rust（N-API）、実 ONNX、packaged の Electron main は通していない。
  したがって「実行」は Mastra 側の挙動の確認で、Grimodex の本番経路の確認ではない。
- 欄の「owner」「開示」「設定」は**設計の案**（未実装）。行の追加・削除・列の変更は、設計の確定時に行う。

## 1. actor と信頼境界

- **信頼する**：利用者（author）、Electron main、Rust の Native、利用者が選んだ AI provider（送信先として）。
- **信頼しない**：
  - renderer（既存の isolation の前提）。
  - Mastra のライブラリが引く第三者コード（直接通信を持つ。X11〜X17）。
  - 利用者の shell の env（API key が継承されうる）。
  - 会話・tool 結果に混ざる指示文（prompt injection）。

## 2. 棚卸し X1〜X23

背景の LLM 呼出し（A、X1〜X10）の送信先は、**利用者が選んだ provider を Rust の adapter 経由**で呼ぶ（決定 2026-11-18、設計 Q3）。
Mastra の既定の送信先（google／gemini、同 provider の低価格 model、model router）は採らない。

### 2.1 一覧

| X   | 仕事                                             | 送信先                                          | 保存先                              | 関わる T        |
| --- | ------------------------------------------------ | ----------------------------------------------- | ----------------------------------- | --------------- |
| X1  | OM observer（同期、turn 内）                     | 利用者の provider（Rust 経由）                  | `mastra_observational_memory`（新） | T2、T4、T9、T12 |
| X2  | OM の async／idle buffering（背景）              | 同上                                            | 同上                                | T2、T5          |
| X3  | OM reflector                                     | 同上                                            | 同上                                | T2              |
| X4  | 題名の自動生成                                   | 同上                                            | `chat_sessions.title`（既存列）     | T2、T5          |
| X5  | working memory の更新（`updateWorkingMemory`）   | loop の LLM 呼出し                              | `mastra_resources`（新）            | T4、T7、T9      |
| X6  | semantic recall の embedding                     | ローカル ONNX（端末の外へ出ない案）             | X7                                  | T2、T5          |
| X7  | semantic recall の索引（vector の保存）          | 無し                                            | `mastra_memory_vectors`（新）       | T4、T7、T12     |
| X8  | observer への attachment（画像・PDF）            | 利用者の provider                               | 同上（X1）                          | T12             |
| X9  | 既存 session への OM の初回投入                  | 利用者の provider                               | `mastra_observational_memory`       | T2              |
| X10 | message 削除後の OM・WM・索引の消去／再構築      | 利用者の provider（再構築する場合）             | OM、WM、vector                      | T2、T7          |
| X11 | 画像 URL の直接 GET（`probe-image-size`）        | 画像 URL のホスト（第三者）                     | 無し                                | T1              |
| X12 | core の asset download（`fetch`）                | 画像 URL のホスト                               | 無し                                | T1              |
| X13 | provider 3 社への attachment の token 数の POST  | `api.openai.com` ほか 2 社                      | 無し                                | T1、T10         |
| X14 | model 文字列 id による model router／gateway     | `ai-gateway.vercel.sh`、`gateway-api.mastra.ai` | 無し                                | T1              |
| X15 | telemetry（posthog）と、その subprocess          | `us.posthog.com`                                | `~/.mastra/usage-telemetry.json`    | T1              |
| X16 | license 検証と ee の telemetry bridge            | `license.mastra.ai`                             | 無し                                | T1、T8          |
| X17 | provider registry の更新                         | `models.dev`                                    | 無し                                | T1              |
| X18 | ファイル書込み（cwd・home）                      | 端末内                                          | cwd（packaged の main では不定）    | T1、T10         |
| X19 | Mastra bundle 内の subprocess 一般               | 未確認                                          | 未確認                              | T1              |
| X20 | 観測の限界（捕捉できていない経路）               | -                                               | -                                   | T1              |
| X21 | AbortSignal が届かない仕事                       | -                                               | -                                   | T5              |
| X22 | `memory.settled()` と quit／workspace 切替の証跡 | -                                               | `isBuffering*` の flag              | T5              |
| X23 | adapter の storage 往復（N-API）                 | -                                               | `chat_*` と新表                     | T6              |

### 2.2 A. 背景の LLM 呼出し（X1〜X10）

**X1 OM observer（同期、turn 内）**

- 起動・取消し：未観測 message の token が閾値（既定 30,000）を超えたとき、turn の loop が待つ（M9）。
  signal は observer の LLM 呼出しに届く。同期中に abort すると `generate()` は reject せず `finishReason:"other"` で 5 ms 以内に返り、OM への追加書込みは無い（実行。S-M6）。
- データ：未観測 message 全部。**tool 結果の本文を既定で含む**（実行。S-M7 V0）。
  adapter で保存前に digest 化すれば次 turn の観測には入らないが、同 turn の step 間で観測が走る設定では本文が入る（実行。S-M7 V5、V5b）。
- 止め方：OM を有効にしない。`supportsObservationalMemory` を宣言しないと、**読みも保存も 0 回で memory 全体が止まる**（実行。S-M1）。
  機能ごとの on／off の設定は未実装。
- 決定・防御：新 route `memory_observer`（P7）。失敗時は縮退して UI に出す（P12。ただし縮退の実行の裏付けは**未確認**）。
- 根拠：S-M1、S-M6、S-M7、M9。

**X2 OM の async／idle buffering（背景）**

- 起動・取消し：Mastra の**既定で on**（`bufferTokens: .2`。M21）。
  user の `abortSignal.abort()` は背景 observer の signal に届かない。generate が 31 ms で返った後も 600 ms 走り、`settled()` が 613 ms で待って解決した（実行。S-M6。fake の遅延）。
- 失敗時：process が死ぬと `isBufferingObservation` が true のまま残るが、再起動後に buffering を再開して false に戻る。未完の chunk は失われ再実行されない（実行。S-M5）。
- 止め方：`bufferTokens:false` を明示する（同期経路は実行で確認。S-M5）。`bufferOnIdle` の off の形は**未確認**。
- 根拠：S-M5、S-M6、M21。

**X3 OM reflector**

- 起動・取消し：observation log が 40,000 token を超えたとき（M9）。signal は reflector の LLM 呼出しに届く（実行。S-M6）。**背景経路の reflector の abort は未実施**。
- 失敗時：再試行・flag の扱いは**未確認**。
- 止め方：OM を切る以外の個別 off は**未確認**。
- 根拠：S-M6、M9。

**X4 題名の自動生成**

- 起動・取消し：応答後、`thread.title` が空のとき。**`generate()` と `memory.settled()` の完了の後に走る**（実行。S-M4）。
  非空の title（`title_manual=1` 相当）では LLM 呼出し 0。題名生成の LLM 呼出しに **`abortSignal` が届かない**（実行。S-M6）。
- データ：thread の message。**tool 結果の本文が prompt に入る**（adapter で digest 化しても入る。実行。S-M7 V5b）。model は agent 自身が既定（M10）。
- 止め方：`generateTitle` の既定は false（M10）。
- 根拠：S-M4、S-M6、S-M7、M10。

**X5 working memory の更新（`updateWorkingMemory` tool）**

- 起動・取消し：agent が tool を呼んだ turn（loop の中）。manifest に無い tool（GDX-TOOL-001）。turn の abort に連動（loop 側）。
- データ：WM の全文（template）または patch（schema）。保存先 `mastra_resources`。resource＝project 全体に効き、**message を削除しても残る**（実行。S-M12）。
- 止め方・決定：`workingMemory.agentManaged:false`（P15。**実行での確認は未実施**）。`readOnly` は OM と保存も止めるので使えない（実行。S-M10）。
- 根拠：S-M2、S-M10、S-M12、M8。

**X6 semantic recall の embedding**

- 起動・取消し：応答の前（query）と後（新規 message）。embedder の呼出しに **`abortSignal` が届かない**（実行。S-M6）。
  embedding は process 全体の LRU で cache される（実行。S-M7）。
- データ：message 本文（text part のみ。tool 結果は入らない。実行。S-M7）。ローカル ONNX（実 ONNX は**未実施**）。ホスト型は利用者が選んだときだけで、新しい送信先として別に同意する。
- 失敗時：次元の不一致は保存失敗（`embeddingDimension` 768 対 384。実行。S-M9）。それ以外は**未確認**。
- 止め方：semantic recall を切れば起動しない（個別の実行は**未確認**）。model・embedder は object のみ（D2）。
- 根拠：S-M6、S-M7、S-M9。

**X7 semantic recall の索引（vector の保存）**

- データ：**message 本文（chunk）が vector の metadata `content` に入る**（実行。S-M9）。
- 削除：`deleteVectors({filter:{message_id:{$in:[…]}}})` は呼ばれたが、対応する vector が無く検証できなかった（実行。S-M12）。
  **assistant の vector の message_id が storage の統合行の id と食い違い、hit が orphan になりうる**（実行。S-M9 追補。原因の確定は未了）。
- 決定：metadata に本文が入ることを許し、削除・export・backup の範囲に含める（2026-11-18）。削除の保証は message_id の対応づけが前提（R-15、U-13）。
- 根拠：S-M9、S-M12。

**X8 observer への attachment（画像・PDF）**

- 起動：X1 の中。既定 `observeAttachments: ["image/*","application/pdf"]` で、**既定で画像が observer の prompt に入る**（実行。S-M7）。
- 止め方・決定：`observeAttachments:false` で image part が入らなくなった（実行。S-M7。**PDF は未確認**）。P6：送らない（PDF の確認を受入れ条件に）。
- 根拠：S-M7、M21。

**X9 既存 session への OM の初回投入**

- 起動：既存 thread に OM record が無いと、最初の generate で**全履歴が 1 回の observer 呼出しに入る**（実行。S-M5）。
- 止め方：`commitActiveObservations({observedMessageIds:[全 id]})` で record を seed すると observer 呼出しは 0 回（実行。S-M5）。seed の実装は未。
- 根拠：S-M5。

**X10 message 削除後の OM・WM・索引の消去／再構築**

- 事実：`deleteMessages` 後も OM の `activeObservations`・`observedMessageIds`・WM が残り、adapter に OM／WM の無効化は届かない。
  `deleteThread` では OM record は消え、WM（resource）は残る（実行。S-M12）。
- 決定：由来する OM の部分だけ消し、再構築しない（P4）。project 削除では WM と OM を必ず消す（P3）。
  部分削除の方式と、WM の扱いは**未設計**（R-16、U-13）。再構築の起動・取消し・終了証跡も未設計。
- 根拠：S-M12、設計 §13。

### 2.3 B. 直接通信（Rust を経由しない）と、止める手当て（X11〜X20）

**X11 画像 URL の直接 GET（`probe-image-size`）**

- owner なし（Mastra memory の内部で、adapter の外）。
- 起動：image part の URL（http／https）に寸法が無いとき。`https.request` ×5 を記録した（実行。S-M8）。provider 名を 3 社にしても同じ。
- 止め方：**env を消しても、provider 名を変えても止まらない**（実行。S-M8）。止められるのは、attachment（画像 URL）を memory の message に通さないことだけ。
  provider 名が 3 社以外の分岐は、むしろこの GET に流れる（読解。M13）。したがって D3（provider 名の中立）だけでは足りず、D4 と対で要件にする。
- 決定：memory の message に画像 URL を通さず、この直接の GET を起こさない（2026-11-18）。
- 根拠：S-M8、M13(c)。

**X12 core の asset download（`fetch`）**

- 起動：URL 画像を渡す agent 呼出し自体（memory とは別の系統）。`fetch` ×12。`supportedUrls` を足しても ×6（実行。S-M8）。base64 画像は `data:` URL で、通信ではない。
- 決定：asset download も起こさない。memory だけでなく **agent への入力全体に URL 画像を通さない**（計画書 MP-3、R-10）。
- 根拠：S-M8。

**X13 provider 3 社への attachment の token 数の POST**

- 起動：adapter の `provider` が `openai`／`google`／`anthropic` の model object で、attachment があり、key があるとき（読解。M13(a)）。
  実行では key なしで記録 0。**key ありの確認は未実施**。
- 送信先・データ：`api.openai.com`、`api.anthropic.com`、`generativelanguage.googleapis.com`。attachment の内容（読解）。
- 止め方・決定：provider 名を中立にし、attachment を memory に通さない。P2：実測なしで、止める条件を要件にする。
  **U-6 で 3 provider を最初から対象にするので、provider 名の中立は必須の防御（D3）**。
- 根拠：M13(a)、S-M8。

**X14 model 文字列 id による model router／gateway**

- 起動：model／embedder を文字列 id で渡したとき（読解。M13(b)）。spike は object で渡した。
  `gateway-api.mastra.ai`（`MASTRA_GATEWAY_URL` の既定）は `MASTRA_GATEWAY_API_KEY` があるときだけ有効（読解。S3 訂正 3）。**走行していない**。
- 送信先・データ：`ai-gateway.vercel.sh`、`gateway-api.mastra.ai`。データは**未確認**。
- 止め方：object だけを許し、文字列 id を禁止する（D2）。
- 根拠：M13(b)、S3 訂正 3。

**X15 telemetry（posthog）と、その subprocess**

- 起動：通常の Agent／Mastra の経路では出ない（実行。S3 の D／E で 0）。
  `trackFeatureUsage` 系を直接呼ぶと `fetch https://us.posthog.com/batch/` と **`child_process.execFile git remote get-url origin`（subprocess）** が出る（実行。S3 の F）。
  `MASTRA_TELEMETRY_DISABLED=1` で 0（実行。S3 の G）。
- 未観測：15 分間隔の usage telemetry（observability が構成されたときだけ動くと読解。S3 訂正 4）。旧 `syncUsageTelemetry` の cursor は `~/.mastra/usage-telemetry.json`（読解のみ）。
- 止め方：`MASTRA_TELEMETRY_DISABLED` を**厳密に `"1"`**（`0`、`disabled`、空文字は有効のまま。S3 訂正 5）。
  P1：env の固定と、packaged main での通信観測を受入れ条件にする。
- 根拠：S3 の A〜G、訂正 4、5。

**X16 license 検証（`license.mastra.ai`）と ee の telemetry bridge**

- 起動：`MASTRA_LICENSE_KEY`／`MASTRA_EE_LICENSE` が設定されたときだけ `POST {MASTRA_LICENSE_URL}/validate`（実行。S3 の L）。未設定なら 0。
- bridge：ee の telemetry は `globalThis[Symbol.for("mastra.eeTelemetryBridge")]` の bridge を呼ぶ形だが、bridge を置く側が core 内に見つからない（読解。S3 訂正 6）。
- 止め方：license key の env を設定しない。stub 版の bundle にも `LicenseClient` は残る（実行。S2-ee）。ee の扱いは D8。
- 根拠：S3 の L、S2-ee、S3 訂正 6。

**X17 provider registry の更新（`models.dev`）**

- 起動：`MASTRA_DEV=true`（または `MASTRA_AUTO_REFRESH_PROVIDERS=true`）のとき、起動時に fetch（実行。S3 の H／I）。`MASTRA_OFFLINE=1|true` で止まる（実行。S3 の C、K）。
  失敗時は静的 registry に fallback して続行する。
- 止め方：`MASTRA_DEV` を設定しない。`MASTRA_OFFLINE=true` を固定する（D1）。
- 根拠：S3 の H／I／K。

**X18 ファイル書込み（cwd・home）**

- 起動：`OM_DEBUG` を設定すると `process.cwd()/om-debug.log` に追記、`OM_REPRO_CAPTURE=1` で `OM_REPRO_CAPTURE_DIR`（既定 `.mastra-om-repro`）に会話の再現 file を書く（読解。M14。実行していない）。
  `import.meta` が空になるため `getPackageRoot` が cwd に落ち、書込み先が `<cwd>/dist/...` になる経路がある（読解）。通常走行（`MASTRA_DEV` なし）では HOME・cwd の差分は 0（実行。S2）。
- データ：会話の再現 file は本文を含むと推測されるが**未確認**。
- 止め方：これらの env を除去する（D1。実行での確認は MP-1）。
- 根拠：M14、S2。

**X19 Mastra bundle 内の subprocess 一般**

- S3 の走行で記録された subprocess は F の `git remote get-url origin` だけ（`child_process` は記録のみの hook）。**bundle 内の `child_process` の全 call site は未確認**。
- 根拠：S3（観測の範囲のみ）。

**X20 観測の限界（捕捉できていない経路）**

- hook が捕捉しない経路：hook の前に参照を握った `fetch`（undici）、bundle 外の `require("undici")`（bundle 内の `createRequire` が 5 箇所）、
  global `WebSocket`、`dgram`、`dns.Resolver`、Worker 内の通信。Electron 本物の main の `net`／`session` は対象外（実行。S-M8 の自己試験、S3 訂正 2）。
- したがって言えるのは「hook が捕まえる経路では 0」まで。「通信が無かった」とは言えない。D12 で OS 側の捕捉を足す。
- 根拠：S-M8、S3 訂正 2。

### 2.4 C. 非同期 lifecycle の穴（X21〜X23）

**X21 AbortSignal が届かない仕事（題名・embedder・背景 observer）**

- 事実：題名生成と embedder は signal が来ない。背景 observer は user の signal とは別で、user の abort で止まらない（実行。S-M6）。
  取消しで止められるのは、main・同期 observer・reflector の呼出しと、admission closure による**新規起動の拒否**だけ。起動済みの題名・embedding・背景 observer を止める手段は**未確認**。
- 決定：AbortSignal が届かない仕事は、ambiguous の audit 行で閉じる（2026-11-18）。quit の遅れの上限 `T_quit` は暫定 5 秒（P11。実 provider の遅延を測ってから改めて伺う）。
- 根拠：S-M6、設計 §5.1 の W1・W9・W10。

**X22 `memory.settled()` と quit／workspace 切替の終了証跡**

- 事実：`settled()` は背景 observer を待つ（613 ms で解決。実行。S-M6）が、**題名生成を待たない**（settled の後に走る。実行。S-M4）。
  したがって `settled()` の resolve は終了証跡にならない（GDX-PRECHECK-001：error event・reject・resolve だけは証跡ではない）。
- 必要な証跡：inflight 計数 0、audit の terminal 行、Native の terminal receipt。題名生成の handle を計数に含める手当ては**未解決**。
- 決定：届かない仕事は ambiguous の audit 行で閉じる（X21）。
- 根拠：S-M4、S-M5、S-M6。

**X23 adapter の storage 往復（N-API）**

- 事実：1 turn で `getThreadById`×17、`saveMessages`×5、`getObservationalMemory`×11、`updateThread`×2 など（実行。S-M2）。
  tool 往復を含む turn で OM が同 turn に観測すると、`saveMessages` は 1〜8 回、assistant は 1〜2 行（実行。S-M3）。
- 書込み規則：upsert は必ず `ON CONFLICT DO UPDATE`。`INSERT OR REPLACE` は、全 schema では capture のある行で FK エラー、capture の無い行で**子行の黙った削除と FTS の破損**になる（実行。S-M14）。
- 取消し：**未確認**（短い transaction の想定）。
- 根拠：S-M2、S-M3、S-M10、S-M14。

## 3. 脅威 T、範囲、必須の防御 D

**T の ID は、この文書で振った**（spike の草稿には T の番号が無い）。「出所」の列で、どれが spike 枝の設計草稿の脅威モデル（§5.3）に由来し、どれがこの文書で足したかを示す。

### 3.1 範囲内の脅威

| T   | 脅威                                                                                                                                                                                    | 関わる X                  | 出所                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| T1  | Rust を経由しない本文・key の送信（直接通信、telemetry、license、registry、file 書込み）                                                                                                | X11〜X20                  | 設計 §5.3 (1)                                      |
| T2  | 背景の LLM 呼出しと embedding が、audit の begin 行と egress gate を迂回する                                                                                                            | X1〜X6、X9、X10           | 設計 §5.3 (5)                                      |
| T3  | restricted profile、`nir1-local-*`、CLI／codex-app-server、非 agent chat での memory の読み書き                                                                                         | X1〜X10（対象外 session） | 設計 §5.3 (2)、Q2                                  |
| T4  | 会話由来の永続データ（WM・OM・vector）の、project 間・thread 間の混入と、場面の phase の先の情報の漏れ（spoiler）                                                                       | X1、X5、X7                | 設計 §5.3 (3)(4)                                   |
| T5  | 取りこぼしの終了（quit・workspace 切替で、起動済みの背景仕事が残る）                                                                                                                    | X2、X4、X6、X21、X22      | 設計 §5.3 (6)                                      |
| T6  | NIR-1 の確認済み脅威モデルへの影響（main の adapter が `chat_messages` の second inserter になる、差し込みで capture が superseded になる、`REPLACE`、role=signal、write clock の増加） | X23                       | 設計 Q10、P9（§5.3 の注）                          |
| T7  | 削除の意味が保たれない（削除した message の内容が OM・WM・vector に残る）                                                                                                               | X5、X7、X10               | 設計 §13、P3、P4（**この文書で脅威に**）           |
| T8  | 配布物に、入れないと決めたコード（ee 由来）が混入する                                                                                                                                   | X16                       | P10、決定 2026-11-18（**この文書で足した**）       |
| T9  | 会話・tool 結果に混ざる指示文が、tool の誤実行や、WM・OM を通じた永続化に使われる                                                                                                       | X1、X5                    | 設計 §5.3 の「信頼しない」、M20                    |
| T10 | 利用者の shell の env（API key、`OM_DEBUG` など）が継承され、Mastra に使われる                                                                                                          | X13、X18                  | 設計 §5.3 の「信頼しない」                         |
| T11 | loop が main に移ることで、製品認可（capability）と、確認済みの chat IR S1 の脅威モデルの前提が落ちる（chat IR S1 は **IR を開ける lane まで閉（MP-4 を含む）**。再確認はその lane で行う。2026-11-21 のユーザー決定） | -（loop 側。MP-3〜MP-6）  | 計画書 R-5、R-25（**この文書で足した**）           |
| T12 | 保存・送信の範囲の拡大が、開示と consent なしに起きる                                                                                                                                   | X1〜X8                    | P7、P8、GDX-AI-CONSENT-001（**この文書で足した**） |
| T13 | main の agent loop が read tool のために `dbExecute` と typed read を直接呼ぶ。JS の profile gate を通らず、unrestricted では Native に read-only の強制も workspace の pin も無い。read が書込みや IR の表・他の表に触れる、workspace の切替をまたいで読む | -（loop 側。MP-4） | [MP-4 の判断](mastra-mp4-decisions.md)の決定 3、回答 3（**2026-11-21 に足した**） |

### 3.2 範囲外

- provider 自身の漏えい。provider 側の保管・学習は、開示の項目（GDX-AI-CONSENT-001）で扱い、防御の対象にしない。
- OS の侵害。
- Mastra Gateway（`msk_` key）の利用。使わない（D2）。
- Web Editor の handoff。廃止済みなので考慮しない。

### 3.3 必須の防御（D1〜D16）

| D   | 防御                                                                                                                                                                                                                                                                                           | 効く T  | MP                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------- |
| D1  | env の固定（load の時だけ。U-5）：`MASTRA_TELEMETRY_DISABLED="1"`、`MASTRA_OFFLINE=true`。`MASTRA_DEV`・`MASTRA_AUTO_REFRESH_PROVIDERS` を未設定に。`OM_DEBUG`・`OM_REPRO_CAPTURE`・`OM_REPRO_CAPTURE_DIR`、API key 系、`MASTRA_*`、`VERCEL_OIDC_TOKEN` を除去。子 process には元の env の写し | T1、T10 | 1、3、10                   |
| D2  | model・embedder は object のみ。文字列 id は型と実行時の両方で禁止（model router／gateway を使わない）                                                                                                                                                                                         | T1      | 10                         |
| D3  | Mastra に渡す provider 名と model id を中立にする（`openai`／`google`／`anthropic` にしない）。X13 の POST と、provider 依存の tool schema の書換え（S5）を避ける。**3 provider 対応で必須**。ただし provider 名が 3 社以外の分岐は X11 の GET に流れるので、D4 と対で要件にする               | T1      | 2                          |
| D4  | attachment（画像・PDF）を memory の message に通さない。URL 画像を agent の入力に通さない                                                                                                                                                                                                      | T1、T12 | 3、10                      |
| D5  | 背景呼出しは Rust の adapter 経由。新 route 4 本（`memory_observer`、`memory_reflector`、`memory_title`、`memory_embedding`）。audit の begin 行が無ければ Native が拒否する。executable contract test                                                                                         | T2      | 10                         |
| D6  | restricted、`nir1-local-*`、CLI／codex-app-server、非 agent chat は memory の対象外（読まない・書かない）。restricted の loop は拒否                                                                                                                                                           | T3      | 3、8、9                    |
| D7  | resource＝project。WM は嗜好・文体の template だけ。recall と OM は thread scope（P13）。OM の `retrieval` は off 固定。`workingMemory.agentManaged:false`（P15）                                                                                                                              | T4、T9  | 10                         |
| D8  | ee：`@mastra/core` の ee 由来のコードは、stub と build の検査で配布物に入れない。version を上げるたびに検査する（P10）                                                                                                                                                                         | T8      | 1、3、13、計画書の第 11 節 |
| D9  | adapter の書込み規則（P9）：`ON CONFLICT DO UPDATE`。`REPLACE` 禁止。role='signal' を除外。差し込みを user で INSERT しない（system／`context` で渡す）。`parts_json` だけ更新。別 session の id 衝突は失敗。typed refusal。新表の台帳登録（P18＝`closed`）                                    | T6      | 7、8                       |
| D10 | 削除：message 削除で由来する OM の部分を消す（P4）。project 削除で WM・OM を必ず消す（P3）。vector は削除・export・backup の範囲                                                                                                                                                               | T7      | 11、12                     |
| D11 | lifecycle：admission closure、inflight 計数、audit の terminal と Native の terminal receipt を終了証跡にする。`settled()` は証跡にしない。届かない仕事は ambiguous の audit 行で閉じる（X21、X22）                                                                                            | T5      | 3、11                      |
| D12 | 通信の観測：packaged の main で、起動から終了まで OS 側の捕捉（P1(b)）。hook の自己試験を毎回付ける。15 分間隔の telemetry を含む長さと、終了時                                                                                                                                                | T1      | 1、3、10、13               |
| D13 | capability の維持（one-shot、`senderId`・projectId・入力 digest の束縛）。chat IR S1 の確認済み脅威モデルの再確認（U-4(f)）は、**IR を開ける lane まで閉（MP-4 を含む）**。再確認はその lane で行い、MP-4 は静的試験で閉を固定する（2026-11-21 のユーザー決定）                                                     | T11     | 3、6                       |
| D14 | 開示と consent（policy version・route・provider・実際の接続先に束縛）。機能ごとの on／off、`memoryModel`、WM の閲覧・編集・消去、観測の消去（P8）                                                                                                                                              | T12     | 12                         |
| D15 | Mastra の storage は memory の domain だけ。observability・workflows・agents ほか全 domain を `false`（traces を保存しない）                                                                                                                                                                   | T4      | 8                          |
| D16 | main の read の防御（MP-4。回答 3）：(1) 送信前の SELECT 検査（先頭が SELECT、method は `all`／`values`、params は配列。外れたら Native を呼ばない）、(2) 返りの marker が `'read'` でなければ事後に fail-closed、(3) core が参照する表の allowlist と、IR を参照しないことの静的試験、(4) read の開始の直前と await の後に `assertLive`（`profileClosed()` の 3 状態を含む）、(5) caller の timeout（legacy と同じ既存の定数を共有 module に出す。`db_execute`・`fts_search` は 10 秒、semantic 2 本は 5 分。`foreshadow_list_open_for_context` は legacy も timeout が無く、MP-4 の判断で扱う）、(6) in-flight の計数と待ち（W11） | T13 | 4（4b） |

## 4. owner／lifecycle の表 W1〜W11

要件の正本は GDX-PRECHECK-001。表は、全 entry／start／retry／reentrant、admission closure、pending-start、active handle の所有、取消し、有限の待ち、
実際の終了証跡、error／timeout／onClosed の所有、永続 restart state を覆う。
「kill 要求・error event・reject された promise は終了証跡ではない」ので、証跡の欄は receipt と計数だけを書く。
待ち時間の値は記号のまま（4.3 節）。

**spike の結果で、元の下書き（設計 §5.1）から変えた点**：W3（保存は 1〜8 回。S-M3）、W4・W7（signal が届かない。S-M6）、W5・W6（flag と背景 observer。S-M5、S-M6）、W10（`T_quit` は暫定 5 秒。P11）。

### 4.1 表

**W1 MemoryRuntime（`Memory`＋adapter）の生成・破棄**

- owner：main の `MemoryRuntimeOwner`（workspace の切替と対で 1 つ）。
- entry・再入：workspace の open・switch。再入は generation 番号で拒否（古い generation の start は捨てる）。
- admission closure：switch／close／restricted 切替／quit の開始で closed。以降の `start*` は `MEMORY_ADMISSION_CLOSED`。
- pending-start：closed になった時点で、「開始済み・未送信」の仕事は captured→cancel。監査の start だけ残った行は `ambiguous` として閉じる（既存の規則）。
- active handle：owner が `inflight` の集合（W2〜W7 の handle）を持つ。
- 取消し：AbortController を run ごとに持つ。
- 有限の待ち：`T_settle`。`memory.settled()` を `T_settle` と race。
- 終了の証跡：inflight 計数 0、各 audit 実行の terminal 行、Native の terminal receipt。`settled()` の resolve は補助。
- error／timeout／onClosed：owner が rejected／timeout を `memory-settle-timeout` として記録し、残りを cancel。
- 永続 restart state：無し（runtime は process 内）。

**W2 turn の memory 読み（history・WM・observation・semantic recall の注入）**

- owner：agent loop（main）の turn owner。
- entry・再入：send の開始。同じ session の二重 send は既存の turn coordinator が拒否（再入不可）。
- admission closure：W1 に従う。pending-start：無し（読みだけ）。
- active handle：N-API 呼出しの Promise と、query の embedding 呼出し（X6）。
- 取消し：turn の abort。query の embedding には signal が届かない（S-M6）。
- 有限の待ち：turn の既存の上限（loop 側）。
- 終了の証跡：turn の terminal。
- error／timeout／onClosed：loop が所有。**読みの失敗は縮退して UI に出す。保存の失敗は turn の失敗**（P12）。
- 永続 restart state：無し。

**W3 turn の保存（`saveMessages` 等）**

- owner：adapter（turn の buffer を持つ）。
- entry・再入：turn の terminal receipt をトリガに 1 transaction。
  **spike で更新**：Mastra は 1 turn で 1〜8 回保存し、assistant は 1〜2 行になる（S-M3）。束ね方は MP-8 で決める（R-2）。
  #940 の予約行と `chatMessageId` の整合は**未解決**（S-M11、R-38）。
- admission closure：turn の終端後は新規保存を受けない。
- pending-start：terminal 前の buffer は、終端で commit、または abort で破棄。
- active handle：Native の transaction（Rust が所有。N-API 呼出しの完了で解放）。
- 取消し：破棄（今と同じく中途の turn は残らない）。
- 有限の待ち：Rust 側の busy の上限（既存の `busy_timeout`）。
- 終了の証跡：commit の戻り値（行数）と audit の terminal。
- error／timeout／onClosed：adapter が typed refusal（`CHAT_WRITE_REFUSED:*` と同形）を返す。
  再試行は同じ message id で冪等（upsert は D9）。副作用を盲目的に再試行しない（GDX-POLICY-001）。
- 永続 restart state：未 commit の turn は無い（途中で落ちたら無かった扱い）。

**W4 題名生成**

- owner：adapter と memory の背景 task。
- entry・再入：応答後、`title` が空のとき。同じ thread の再入は 1 本に畳む（in-flight なら新規を起こさない）。
- admission closure：W1 に従う。pending-start：closure 後は起動しない。
- active handle：LLM 呼出しの handle（Rust adapter 経由、audit 行あり）。
- 取消し：**signal が届かない**（実行。S-M6）。止められるのは新規起動の拒否だけ。起動済みは ambiguous の audit 行で閉じる（X21）。
- 有限の待ち：`T_title`（`T_quit` の内側）。
- 終了の証跡：audit の terminal 行（ambiguous を含む）。**`settled()` は題名を待たない**（S-M4）ので証跡にしない。
- error／timeout／onClosed：失敗は題名を空のまま残すだけ（副作用なし）。`title_manual=1` は adapter が拒否。
- 永続 restart state：題名が空のまま（次の turn で再試行）。

**W5 OM observer／reflector の同期呼出し**

- owner：turn の loop が待つ。
- entry・再入：message token が閾値を超えたとき（turn 内）。
- admission closure：W1 に従う。pending-start：無し。active handle：同上。
- 取消し：turn の abort と連動（signal が届く。abort しても `generate()` は reject せず `finishReason:"other"` で返る。S-M6）。
- 有限の待ち：turn の上限に従う（`blockAfter` を Mastra の既定のままにするかは MP-10 で明示）。
- 終了の証跡：audit の terminal と、`isObserving` flag の解除。
- error／timeout／onClosed：adapter が flag を必ず解除する（finally）。解除に失敗したら stale 回復（M12）に任せる。
  同期経路では Mastra がこれらの flag を書かない（実行。S-M5）ので、解除の対象が実在するかは MP-8 で確かめる。
- 永続 restart state：`isObserving`／`isReflecting` の flag（自己回復。M12）。

**W6 OM の背景 buffering・idle buffering・reflection**

- owner：memory の背景 task（Mastra 側が持つ）。
- entry・再入：step の buffer、`bufferOnIdle`、threshold。再入は Mastra の flag（`isBuffering*`）で抑止。
- admission closure：W1。加えて **`bufferTokens:false` を明示して開始点を減らす**（Mastra の既定は `.2` で on。M21）。`bufferOnIdle` の off の形は**未確認**。
- pending-start：closure の時点で未起動の buffering は起動しない。
- active handle：LLM 呼出しの handle と flag。
- 取消し：**user の abort は背景 observer の signal に届かない**（実行。S-M6）。止めるのは、closure による新規起動の拒否と、`settled()` を待つ有限の待ち。
- 有限の待ち：`T_settle`。
- 終了の証跡：audit の terminal、adapter の inflight 計数 0、`isBuffering*` の解除。**`memory.settled()` だけでは証跡にならない**。
- error／timeout／onClosed：adapter が flag 解除と `mastra_observational_memory` への書込みを 1 transaction で行う。
- 永続 restart state：`isBuffering*` の flag、`lastBufferedAtTokens`、`bufferedObservations`。
  再起動後、有効なら activate、無効なら破棄。flag が true のまま死んだ場合、再起動で buffering を再開して false に戻る。未完の chunk は失われ再実行されない（実行。S-M5）。

**W7 semantic recall の embedding と vector upsert**

- owner：memory の背景 task と adapter。
- entry・再入：応答後（新規 message）。再入は message id の hash で冪等（chunk id は message id から決まる）。
- admission closure：W1。pending-start：起動前の分は closure で破棄（次回の走査で拾う）。
- active handle：embedding 呼出し（ローカル ONNX は Rust の job、audit の embedding 行）。
- 取消し：**embedder に `abortSignal` が届かない**（実行。S-M6）。新規起動の拒否と、ambiguous の audit 行（X21）。
- 有限の待ち：`T_embed`。
- 終了の証跡：embedding の terminal 行と、vector の commit。
- error／timeout／onClosed：失敗は vector を作らない（次回の走査で再試行）。同一 hash の upsert は冪等。
- 永続 restart state：vector の欠落（`chat_index` と同型の hash 走査で回復）。vector の message_id の食い違い（X7）は MP-8 で対処する。

**W8 storage の接続（adapter が使う N-API handle）**

- owner：Rust（`Database` の接続）。adapter は呼出しの in-flight 数を数える。
- entry・再入：adapter の各メソッド（abstract 10〔`dangerouslyClearAll` を含む〕、OM 19、resource 4、vector 9）。
- admission closure：W1 の closure で adapter が `ADAPTER_CLOSED` を返す。pending-start：無し。
- active handle：N-API 呼出しの Promise（adapter が計数）。
- 取消し：呼出し中の cancel は無い（短い transaction）。
- 有限の待ち：Rust 側の既存の上限（`busy_timeout`）。
- 終了の証跡：inflight 計数 0。Native の quit finalizer の terminal receipt。
- error／timeout／onClosed：adapter が Rust の error を typed に写して伝える。
- 永続 restart state：WAL（Rust が所有）。

**W9 workspace の切替・project の close・restore・restricted 切替**

- owner：main の workspace 切替の owner（既存の `SwitchingGuard` と egress participant）。
- entry・再入：切替の開始。memory runtime を participant として登録する（`registerMainEgressParticipant`。`electron/main/index.ts:593-603` と同型。quiesce と forceStop）。
- admission closure：切替の最初に W1 を closed にする。pending-start：切替で開始済みの背景仕事は cancel→terminal を待つ。
- active handle：各 W の handle。取消し：W2〜W8 の abort を一括。
- 有限の待ち：`T_switch`（既存の egress participant の上限 30 秒〔`PROFILE_EGRESS_PARTICIPANT_BOUND_MS`。`electron/main/profileEgress.ts:80`〕と整合させる）。
- 終了の証跡：W1 の証跡がそろってから、新しい workspace の runtime を作る。
- error／timeout／onClosed：切替の owner。
- 永続 restart state：restore なら OM・WM・vector は DB の巻戻しと一緒に戻る（C-1 の利点）。

**W10 app の終了**

- owner：main の quit finalizer（`electron/main/index.ts:678` で作る `createNarrativeMaintenanceQuitFinalizer`。`will-quit` は `:782`）。
- entry・再入：`will-quit`。再入は既存の finalizer が同じ promise を返す。
- admission closure：**最初に W1 を closed**。pending-start：破棄。
- active handle：W1 の inflight 集合。取消し：全 abort。
- 有限の待ち：`T_quit`。**暫定 5 秒**（P11。案 C。実 provider の遅延を測ってから改めて伺う）。既存の 30 秒の予算（`electron/main/narrativeMaintenanceShutdown.ts:59`）の内側に収める。
- 終了の証跡と順序：①admission を閉じる、②abort、③有限の settle（`settled()`、inflight 計数 0、audit の terminal を race）、④storage を閉じる（Rust の既存の shutdown に任せる）、⑤Native の terminal receipt。
  receipt が出る前に process を終えない。
- error／timeout／onClosed：finalizer が `quit-memory-timeout` を記録して先へ進む。残った仕事は ambiguous の audit 行として閉じる（X21）。
- 永続 restart state：W6 の flag が残りうる。次回起動で stale 回復（M12）。

**W11 main の read tool の呼出し（`dbExecute`・typed read。MP-4。2026-11-21 に足した）**

- owner：main の turn owner（Turn が所有する）。
- entry・再入：read tool の execute。1 turn の tool は直列（`toolCallConcurrency: 1` を固定。`electron/main/mastra/agentModelPolicy.ts:30-34`）。
- admission closure：`profileClosed()`（restricted／unavailable／activating）、workspace の切替、quit、forced で closed。開始の直前に同期で `assertLive` を通す。
- pending-start：無し（検査を通れば即呼ぶ）。
- active handle：N-API 呼出しの Promise。owner が send とは別の counter で数える。
- 取消し：呼出しは止められない。await の後に `forcedCause` と `assertLive` を再確認し、外れていれば結果を捨てて turn の abort に合流する。
- 有限の待ち：D16 の (5) の対象（`db_execute`・`fts_search`・semantic 2 本）は caller の timeout。`foreshadow_list_open_for_context` は legacy も caller timeout が無いので付けず、abort との race と下の上限だけ。slot の解放と quiesce の待ちは、既存の forced の上限（`MASTRA_TURN_FORCED_BOUND_MS`＝30 秒）と quit の上限（`MASTRA_TURN_QUIT_BOUND_MS`＝5 秒。暫定。`electron/main/mastraTurnOwner.ts:68-71`）に乗せ、新しい値を置かない。
- 終了の証跡：呼出しの返り（settle）。**slot の計数だけに使う**。永続化の終了証跡ではない（D11 の「`settled()` は証跡にしない」と区別する。read は何も永続しない）。
- error／timeout／onClosed：owner が所有する。失敗と timeout は turn の失敗。caller の timeout は Native を止めないので、計数は settle まで残す。
- 永続 restart state：無し（read だけ）。

**W12 main→画面の保留中の問い合わせ（MP-5、Q2、2026-11-26）**：owner は main の turn owner。回答は認可に使わず、MP-5 の問い合わせ（UI 系 7 本）では Mastra 組込みの承認・suspend／resume・`resumeData` を使わない（MP-6 の write の承認は MP-6 で決める）。`ask_user` は 30 分、他の 6 本は 10 秒。Stop・強制中断（profile の制限・workspace の切替・quit）・画面の喪失で閉じ、遅い回答は捨て、再起動後に復元しない。待ちの間 turn は main と書込み行列の枠を持ち続け、workspace の切替が進まず、W9 の 30 秒上限の前提が崩れる。

### 4.2 GDX-PRECHECK-001 の項目ごとの、spike で確かめたことと未確認

| 項目                              | spike で確かめたこと                                                                                                                                                                     | 未確認・未解決                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 全 entry／start／retry／reentrant | 題名は 1 回だけ（title が入った後の 2 回目の turn では再生成しない。S-M4）。背景 buffering は Mastra の flag で再入を抑える（読解 M12）。再入の抑止は process 内の op 登録に依る（読解） | 同じ thread の再入・並行 turn は流していない。背景 LLM の再試行を Mastra が持つか |
| admission closure                 | `supportsObservationalMemory=false` で OM を有効にすると読み書きとも 0 回（S-M1）。closure を adapter 側で返す設計（`ADAPTER_CLOSED`）の実行は未実施                                     | quit・workspace 切替での closure と、起動済みの Mastra 内の背景仕事との関係       |
| pending-start work                | 設計の記述のみ                                                                                                                                                                           | 「開始済み・未送信」の仕事を Mastra から取り出せるか                              |
| active handle の所有              | 背景 observer は `settled()` が待つ（S-M6）。題名・embedder は待たない                                                                                                                   | 題名・embedder の handle を `MemoryRuntimeOwner` が計数できるか                   |
| cancellation                      | main・同期 observer・reflector は signal が届く。題名・embedder は届かない。背景 observer は user の signal と別（S-M6）                                                                 | 背景経路の reflector、quit 時の `settled()` の timeout                            |
| bounded wait                      | `settled()` は 613 ms で解決した例のみ（fake）                                                                                                                                           | `T_settle`、`T_title`、`T_embed` などは未導出（記号のまま）                       |
| 実際の終了証跡                    | `settled()` は証跡にならない（X22）。inflight 計数・audit の terminal・Native の terminal receipt が必要                                                                                 | 実 Rust での terminal receipt との結合（spike は fake backend）                   |
| error／timeout／onClosed の所有   | 同期 observer の abort は reject せず `finishReason:"other"`（S-M6）。flag の解除は adapter の finally（設計）                                                                           | observer・reflector・題名の失敗時の Mastra の挙動（再試行・伝播）                 |
| 永続 restart state                | process 死亡後の flag は再起動で回復し、未完の buffering の結果は失われる（S-M5）                                                                                                        | 削除後の再構築（X10）の途中で落ちた場合の state（未設計）                         |

### 4.3 待ち時間の値

- `T_settle`、`T_title`、`T_embed`、`T_switch`、`T_quit` は記号のまま。workload とリスクから導く。固定値を先に置かない。
- `T_quit` は暫定 5 秒（P11）。選んだ理由は、quit の遅れが利用者に見える範囲に収まること、既存の 30 秒の予算に余地を残すこと、の 2 点だけで、値そのものの根拠ではない。
  実 provider の observer・題名・embedding の遅延（P50／P95）を測ってから決め直し、そのときに改めて伺う。受入れ時に、ambiguous の件数を audit から数える。
- `T_switch` は、既存の egress participant の上限 30 秒と整合させる。未測定のまま値は決めない。
- ambiguous の audit 行は「request が provider に届いたかもしれない」状態を表し、再試行しない（GDX-POLICY-001）。

## 5. 残るリスク

記録済みの未確認と、決定が残した点だけを挙げる（新しい脅威は作らない）。受入れ条件に上げたものは冒頭の「同時の回答」のとおり（2026-11-19）。

- **main の read は Native の read-only の強制に頼れない**（T13、D16）：unrestricted では Native の `db_execute` に read-only の強制も workspace の pin も無い（pin があるのは semantic 系だけ）。補いは JS の防御（D16）で、各層は read-only の証明ではない。2026-11-21 のユーザー確認（回答 3）で受け入れた。
- **通信の観測の限界**（X19、X20、R-8）：hook の盲点。packaged の OS 側の捕捉（D12）で補うが、15 分間隔の telemetry、gateway、ee の bridge、`child_process` の全 call site は未確認。
- **key ありの token 数の POST**（X13、R-9）：実測なし。止める条件を要件にしただけ。ダミー key の対照は MP-1、実 key は U-18。
- **tool 結果の本文が、題名と同 turn の step 間の observer に入る**（X1、X4、P5(c)、R-13）：暫定で開示して許容。絞る手当てを確かめたら要件に昇格する。
- **vector の削除の保証**（X7、R-15）：message_id の食い違いの原因は未確定。成り立たなければ U-13。
- **OM の部分削除の方式と、WM の扱い**（X10、R-16）：未設計。決まるまで、message 削除後も OM・WM に内容が残りうる。
- **背景仕事の取りこぼし**（X21、X22、R-17）：AbortSignal が届かない仕事は、quit で ambiguous の audit 行になりうる。件数は MP-11 で audit から数える。`T_quit` は暫定。
- **4c-2 renderer turn の Q5 受容窓**（2026-11-27）：(a) 場面切替後も開始時の scene に固定する、(b) `resolutionMode`・tree の並びなど DB が古い間は画面より多くを解除する向きにずれうる、(c) scene 本文 read に barrier がなく DB に到着した本文だけを読む、(d) batch 中の tree 変更を再計算しない、(e) workspace・project・chat authority・policy・license の変化から cancel が届くまで送信または tool 呼出しがもう 1 回進みうる（AI policy の store 変更が DB に永続化されるまでの K-17 の窓を含む）、(f) events・scene-events・Codex 名の年表 cache は turn 中 `clear()` まで変更を見ない。license の変更は画面の watcher のみが検知する。
- **4c-2 開始時 context の継続**（2026-11-27）：会話・表示対象・model／接続先・scene の変更では停止せず、開始時の会話・model・scene で処理を続け、応答は開始時の会話へ保存する。送信の後に、より前の scene へ移ると、その scene の位置では出さない情報を含む応答が見える可能性がある（開示は送信時点の scene で計算する。閲覧者は作者本人）。
- **背景仕事の失敗時の挙動**（X1、X3、X5、X6、X9、R-35）：未確認。縮退の実行の裏付けが無い（P12）。
- **clock の増加と Graph／IR の失効**（T6、R-3）：1 turn で clock は +10（chat と NIR-1 だけなら +6）。模型の通しの値で、実 Mastra の保存回数で増える。失効への影響は未測定。閾値は緩めない。
- **adapter が模型であること**（T6、P9）：全 schema の試験は模型の adapter。製品の adapter で、MP-7・MP-8 でやり直す。
- **並行性**（R-4）：別接続の書込み、WAL、busy、背景と前景の重なりは未測定。
- **file 書込み**（X18、R-36）：読解のみ。実行での確認は MP-1。
- **stub が `undefined` を返す名前の呼び手**（R-11）：版ごとに変わりうる。version を上げるたびの検査（D8、計画書の第 11 節）で見る。
- **provider ごとの usage の会計**（R-21）：OpenAI・OpenRouter は未確認。誤ると費用の記録が狂う。MP-2 で確かめる。

## 6. U-1 で確かめる点

1. P1〜P18 の回答が、この脅威モデルの確認を兼ねるか。兼ねないなら、この文書の確認。
2. actor（信頼する／しない）と、範囲外（第 1 節、第 3.2 節）。
3. T1〜T12 に過不足がないか。**T7、T8、T11、T12 は、spike の脅威モデルに無く、この文書で足した**（第 3.1 節の「出所」）。T6 は設計 Q10 に由来する。
4. 必須の防御 D1〜D15 を要件にすること。特に、D3（provider 名の中立。3 provider 対応で必須）、D4（URL 画像と attachment を通さない）、D11（届かない仕事は ambiguous で閉じる）。
5. 残るリスク（第 5 節）のうち、受け入れるものと、MP の受入れ条件に昇格させるもの。特に、P5(c)（tool 本文が observer と題名に入る）、X13 の key あり、X10 の部分削除。
6. W 表を spike の結果で変えた点（W3 の保存の束ね方、W4・W6・W7 の取消し、W10 の `T_quit`）が、決定済み（P11、X21）の範囲に収まるか。
7. 付随して残る点：新しい `PrePublicationEntry`（旗 L・M）が新しい authority に当たるか（計画書の第 7.1 節 U-3）。
   chat IR S1 の確認済み脅威モデルの再確認（U-4(f)）は、**IR を開ける lane まで閉（MP-4 を含む）**（2026-11-21 のユーザー決定）。再確認はその lane で行う。

## 7. この文書が確認していないこと

- 本物の Rust・N-API・ONNX、packaged の Electron main、Chromium 側の通信。
- 製品の build への stub の導入（spike の枝のみ）。
- 欄の「owner」「開示」「設定」は未実装。
- T の ID と、D の番号は、この文書で振った。T13・D16・W11 は MP-4 の判断で足した（2026-11-21）。
