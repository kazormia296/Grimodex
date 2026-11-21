# MP-3（loop の骨格：tool 0・memory 0）の判断の記録

- 状態：3a の実装と同時に置いた記録。**3b（閉じた入口）の細部は第 5 節、3c（owner・runtime・lifecycle）の実装の事実と判断は第 6 節**に追記した。
  判断を変える場合は、その PR でこの文書を改訂する。
- 親の文書：[Mastra 移行の実装計画](mastra-migration-plan.md)の第 6 節 MP-3、[脅威モデル](mastra-migration-threat-model.md)。
- ID：`DR-MP3-n`（通し番号。節ごとにまとめて並べるので、番号は節の中で前後する）。PR 本文にも同じ ID と信頼境界を載せる。
- 区別：**決定**（ユーザー、2026-11-19）、**技術判断**（この lane の判断。根拠つき）、**読み替え**（計画書の範囲の変更）、**申し送り**。
- 委任の範囲：AGENTS.md の NIR-1 の事前委任は Mastra の lane に及ばない。技術判断は、ここに残し、新しい送信先・保存範囲・閾値の緩和・
  製品の公開・製品認可の削除・新しい契約や authority を含めない。含む場合はその項目で「確認要」と書く。
- 記録しないもの：Mastra の ee の license の条文の引用と読解、spike の実行の記録（U-2）。

## 0. 信頼境界の要約（MP-3 全体）

- 旗 L（closed gate）が閉じている launch の既定では、Mastra を load せず、main の経路は変わらない。変わるのは env の配線だけ（DR-MP3-9）。
- renderer は新しい権限を得ない。新しい IPC は start と cancel の 2 本で、gate が閉じていれば typed refusal を返すだけ（3b）。
- LLM 送信は引き続き Rust（`send_agent_message`）。Mastra は main の TS で loop を回し、送信は adapter が既存の N-API を呼ぶ。
- 送信先は利用者が選んだ provider のまま。新しい送信先・保存範囲・閾値の変更は無い。
- 製品の bundle（main.cjs・preload.cjs）には `@mastra/*` を入れない。`@mastra/*` は 3 つ目の bundle `mastra-agent.cjs` にだけ入り、
  ee の stub を通る（DR-MP3-18、19）。

## 1. 分割と範囲

### DR-MP3-1 MP-3 を 3a／3b／3c の 3 PR に分ける（決定）

- 決定（2026-11-19）：MP-3 は 3a → 3b → 3c の順の 3 PR。独立に merge でき、独立に戻せ、閉じたときの不変性を区切りごとに別の試験で言える。
- 3a（土台）：build・製品 bundle の ee 検査・asar・env の配線・この判断の記録。Mastra を呼ぶ main の経路は 0。変わるのは env の配線だけ。
- 3b（閉じた入口）：契約（`ipcContract`）、wire、audit の共有 module と sink、Main の gate L、journey の seam、profileEgress の台帳。
  start は typed refusal を返すだけ。Native の entry・新 N-API は足さない（DR-MP3-2）。
- 3c（owner・runtime）：turn owner、lifecycle（participant、quit、workspace 切替）、agentRuntime の本実装、lazy load、静的検査の拡張、journey。
  gate が閉なら Mastra を load しない。変わるのは seam で開けたときだけ。
- 3a の中身は、最小の `electron/main/mastra/agentRuntime.ts`（Agent を import して型と factory の雛形を export するだけ。製品のどこからも require しない）、
  3 つ目の bundle、ee 検査の差し替え、asar 検査の切り出し、env の許可リストと配線（大きさは記録だけ。DR-MP3-21）。

### DR-MP3-2 計画の読み替え（範囲の変更。決定）

- renderer の engine 分岐は **MP-4 へ移す**。理由：agent mode の turn は常に tool が非空（manifest の 44 本）なので、tool 0 の turn は製品でも journey でも作れない。
  MP-3 の renderer の分岐は journey のための新しい test hook（新しい authority になりうる）を要する。製品の挙動は MP-4 まで変わらないので、閉の保証が強い。
- packaged での load・通信 0・asar 内の `require` は **MP-13 の受入れ**にする。packaged の seam は閉で、load する入口を新設しない。
  MP-3 は、閉状態（Mastra を load しない）の確認、非 packaged の seam journey、ee・asar の検査で受け入れる。
- 旗 L は **Main の gate と journey の seam だけ**にする。Native の `PrePublicationEntry`（L）と新しい Main 専用 N-API は **足さない**（計画書の第 4.1 節の型は踏襲しない）。
  Native の closure は、既存の `send_agent_message` が renderer から常に届くため、旗 L では何も閉じない。旗 M（memory の書込み）で Native の entry を足す。
- 影響：3b の範囲は Native・Rust を含まない。`electron/native/grimodex-node/src/main_grant.rs` と `index.d.ts` は MP-3 で変えない。
- 記録先：この文書、計画書の第 6 節 MP-3 と第 7.1 節（リンクと 1〜2 行）。

### DR-MP3-3 移す範囲（決定）

- 移すのは **main chat だけ**。`run_research` の子 agent、Context Creator、live harness は移さない（MP-4 以降で扱いを決める）。
- chat IR S1（`chat_agent_ir_select`）は **閉じたまま**。受け手が main の loop に移る再確認は、IR を開ける lane で行う。
- `browser-mock.ts` の loop と legacy の経路は **残す**。
- 文脈の組立（`refreshContextLayers`、`contextBuilder`）は **renderer に残す**。IPC で system（segment と tail）・履歴・route を渡す案（3b の wire）。agent 経路は非 stream のまま。
- adapter は text 以外（画像・URL・attachment・tool 結果の非 text）を **拒否**する（X11、X12）。添付つきの turn は legacy に落とす（renderer 側。MP-4）。

## 2. IPC・identity・abort・lifecycle（3b・3c の判断）

### DR-MP3-4 IPC の形（決定＋技術判断）

- 決定：IPC は **開始と取消の 2 本**。progress event は MP-4／5。Stop は **今と同じ強さ**（step 間で止める。送信中の provider 呼出しの途中で切らない）。
- 技術判断：
  - handler は shell 経路（`SHELL_COMMAND_NAMES`）。`ipc.ts` の変更は gate 閉の 1 行と workspace の hook だけ、と書いたが、実装はこれより広い（第 5 節 5-6 に実際の差分）。
  - gate が閉なら `ok:true` の typed refusal（`gate-closed`）を返す。refusal の閉集合は `gate-closed`／`restricted`／`unsupported`／`busy`／`sender-refused`／`invalid`。
  - turnId は renderer が採番（UUID）。同じ session の再入は `(senderId, chatSessionId)` の一意で `busy` として拒否。引数名は `chatSessionId`（`identity.sessionId` との取り違えを避ける）。
    上限は sender あたり 4、全体 8 程度（3c で定数にする）。
  - `chatSessionId` は renderer の `sessionIdForPersist ?? activeSessionId` で、未確定の場合がありうる。wire は必須にし、無い turn は `invalid` の typed refusal で legacy に落とす（意図した挙動）。
  - start・cancel とも mutation として扱い、timeout を付けない。
- 信頼境界：renderer は wire（exact key、UUID、`messages` は text だけ、上限、route の provider 必須、tools は空だけ、`capability`・`auditContext`・`pathId`・`executionId`・`callerIdentity` の持込み拒否）しか渡せない。main が再検証する。

### DR-MP3-5 identity と capability（決定＋技術判断）

- 決定：**capability は MP-3 で発行しない**。**sender 無しの `callerIdentity` は発行しない**。
- 技術判断：turn の identity は開始時に束ね、各 step の send 直前に `isIssuedCallerIdentity(turn.identity)` と closed の検査を行う。
  Native には `callerIdentity` を載せない（legacy の permit。Native は identity を使わない見込み。napi が非 enumerable の値を落とすかは 3c の前に確かめる）。
- 信頼境界：turn は sender・window・identity の三つ組に束縛され、どれかが失われたら次の send は起きない。

### DR-MP3-6 abort の 2 種、原因別の終了の規則、closed の向き（技術判断）

- abort は `user-stop`（step 間。DR-MP3-4）と `forced`（restricted、workspace 切替、quit、sender 消失）の 2 種。closed は一方向で、stage 2 以降は process の再起動まで開けない。
- **forced の共通の規則**（DR-MP3-10、11、12 はこの規則の原因別の適用）：
  1. owner が admission を閉じる（新しい step と新しい turn を拒否）。
  2. owner が turn の promise と abort を競わせる（turn 単位の切り離し）。invoke と quiesce は Native の send の完了を**待たず**、ここで先に settle する。
     Native の send 自体は止めない（新しい取消しの契約を足さない。決定）。
  3. owner が**ambiguous の terminal 行（DR-MP3-10）を、その turn の `executionId` に 1 回だけ**書く。sink は `executionId` ごとに terminal の書込みを 1 回に制限する。
  4. 遅れて返る Native の send の完了・失敗は**捨てる**：result を renderer に返さず、adapter は 2 つ目の terminal を書かない。
  5. 4 の後に Native 側の observer が同じ execution へ行を足す可能性（post-terminal）は**未確認**。D11 の受入れ条件に入れ、3c の pipeline spec（実 addon）で確かめる。
     足されて ledger の検証が壊れるなら、この規則を改訂する（その場合は新しい契約の確認が要る）。
- 原因別の表（誰が abort するか／何をどの枠で待つか／terminal の書き手と時機と形／遅れた Native の settle）：

| 原因 | abort する者 | 待つもの（枠） | terminal の書き手・時機・形 | 遅れた Native の settle |
|---|---|---|---|---|
| user-stop（renderer の cancel） | owner（`user-stop`）。次の step を始めない | turn の自然な終端（枠なし。送信中の呼出しは切らない＝今の Stop と同じ強さ） | adapter が通常の complete／fail。取消しだけなら `execution.cancelled` | 捨てるものは無い（通常の終端） |
| restricted（profile の切替） | owner が participant の quiesce の中で admission を閉じ、reserved 中に `forced` | owner 自身の settle と terminal の書込み（30 秒の枠。Native の send は待たない） | owner が quiesce の中で ambiguous の terminal。quiesce（stage 3）は Native の commit（stage 4〜5）より前なので、この時点ではまだ restricted ではなく append は通る（restricted になった後も `ai_audit_append_batch` が通ることは `profileEgress.ts` の `INTERNAL_COMMANDS` で別に成り立つ）。書けなければ quiesce は unavailable を返す（既存の経路） | 捨てる。Native の cancel（stage 5）で send は速やかに reject し、permit も落ちる |
| workspace 切替 | owner の lease（`ipc.ts` の lease 列）。切替の分岐の先頭で同期 abort | lease の取得に main 側の時間 bound。Native の open の**前**に terminal を書き終える | owner が**旧 workspace に** ambiguous の terminal（切替後は旧 workspace へ書けないので前に書く） | 捨てる。send は旧 workspace の pin に束縛され、新 workspace へ書かない |
| quit | finalizer（dispose と complete の両方の `shutdown()`） | `T_quit`＝5 秒（暫定。30 秒の予算の内側）。有界・冪等・非 reject | owner が bound 内で ambiguous の terminal。書けなければ start-only のまま残る（**回収なし**。DR-MP3-10） | 捨てる（process が終わる） |
| sender 消失（`destroyed`・`render-process-gone`・main frame の遷移・window の `closed`） | per-turn listener（DR-MP3-7） | 待たない（renderer は居ない） | owner が現在の workspace に ambiguous の terminal | 捨てる（返す先が無い） |

### DR-MP3-7 sender 消失の検知と listener（技術判断）

- listener は per-turn（mainGrant 型）。`destroyed`・`render-process-gone`・main frame の `did-start-navigation`・`closed` を見て abort する（reload を見るため）。
- 後始末は turn の終端で必ず行い、listener を残さない。複数 window は turn ごとに分離する。

### DR-MP3-10 ambiguous の定義（技術判断）

- 新しい event type は足さない。**terminal 行**（`execution.failed`。取消しだけなら `execution.cancelled`）に payload
  `remoteOutcome:"unknown"`、`conservative:true`、`captureState:"partial"`、`responseObserved:false` を付けたものを「ambiguous の audit 行」と定義する（NIR-1 local generation と同形）。
- **start-only**（`execution.started` があり terminal が 0 件）は「閉じていない異常」として区別する。報告書の `ambiguousExecutionCount` は start-only を数える既存の定義のまま。
- 届かない仕事は、audit の start を書いた後、必ず terminal を上の形で書く（D11、X21、X22 の受入れ条件）。書く前に終了した場合の回収は**ない**：`InterruptedUnknown` と Drop／起動時 sweep は `nir1_generation*.rs` と `nir1_local_transport.rs`（NIR-1 の local generation）だけにあり、`ai_audit` と `grimodex-ai` に回収は無い。
  `chat_agent_main` の start-only は残り、`reportCoverage.ts` が `ambiguousExecutionCount` として数えるだけ（脅威モデル D11 の「終了証跡」は、terminal を書けた場合に限って満たされる）。
  回収が要るなら、3c で新しい契約として確認する（3a・3b では足さない）。
- 脅威モデルの「ambiguous の audit 行」の語は、この定義（payload の `remoteOutcome:"unknown"`）を指す。MP-11 の件数は payload で数える reader を足す（読出しだけの追加）。
  この文書は脅威モデルの文言を変えない。
- 新 authority・閾値・送信先・保存範囲には触れない。

### DR-MP3-11 restricted（決定＋技術判断）

- 決定：restricted は **拒否**。新しい IPC は **denied に分類**（start は `old-external-ai`）。cancel は `ALLOWED_STOP` と `INTERNAL` の両方（`abort_chat_stream` 型）。profile の切替で in-flight を止める。
- 技術判断：turn owner を egress participant に登録する。quiesce の中で ①admission を閉じる ②（reserved 中の）abort ③自分の settle と terminal を **30 秒の枠**で待つ。
  Native の cancel は commit の stage 5 にあり、main の quiesce（stage 3）はその前に終わるので、terminal の担保は owner 自身の await でしか取れない。
  「自分の settle」は owner 側の turn の promise（DR-MP3-6 の規則 2 で abort に競わせて先に settle する）で、Native の send の完了ではない。
  quiesce が Native の send を待つと 30 秒の participant-timeout になるので、待たない。原因別の表は DR-MP3-6。

### DR-MP3-12 workspace 切替（ユーザー決定 2026-11-19。W9 の読み替え）

- `ipc.ts` の lease 列に turn owner の lease を足す。受付を閉じ、**旧 workspace に ambiguous の terminal 行を書いてから** Native の open に進む。
  切替の分岐の先頭で同期 abort する。第 2 段の hook は `workspace:opened` だけでは不足（置換の Ready を publish しない path がある）なので、
  `workspace:lifecycle-state` の変化も見る。実効の防御は send 直前の identity 検査（DR-MP3-5）。
- Native の送信は **止めない**。脅威モデル W9 の「cancel して terminal を待つ」を「ambiguous で閉じる」に読み替える（ユーザー決定。Native に新しい取消しの契約を足さない）。
- 切替後は旧 workspace へ書けないので、terminal は切替前（lease 段）に書く。遅れて返る send の完了は捨て、terminal を二重に書かない（DR-MP3-6 の規則 3、4）。

### DR-MP3-13 send の経路・result・audit の検証・T_quit（技術判断）

- main は既存の `send_agent_message`（backend の N-API）を呼ぶ。settings と key は `resolveRequiredAiKeyAndSettings` を **export して共有**する（再実装しない。settings は 1 回だけ読む規則）。3c では**turn の開始で 1 回**（runtime の load の後、Agent を回す前、audit の begin の前）に解決し、解決した値を send に渡す。送れないと分かっている run（key 無し・settings が読めない）は始めず、audit の行も書かず、log も出さずに `ok:false` で返す（利用者の通常の状態であって Main の失敗ではない）。
- start の result は、adapter の send が受けた **生の応答**（`AgentWireResponse`）と **main 採番の `executionId`**。Mastra の `result.text`（全 step の連結）は使わない
  （thinking・signature・stopReason が失われる）。
- audit の append は `ipcContract` の検証関数（`requireNativeAiAuditContext` ほか）を通す。
- `T_quit` は **5 秒（暫定）**。quit は finalizer の dispose と complete の両方に `shutdown()` を置き、有界・冪等・非 reject。実 provider の遅延を測ってから改めて伺う（P11）。

### DR-MP3-23 audit の書き手（決定＋技術判断）

- 決定：audit は **main が既存の `ai_audit_append_batch` で書く**。新しい owner は `main-agent`。
- 技術判断：`pathId` は `chat_agent_main` を維持し、`AiPathEntry` に追加の owner 欄を足す（新しい pathId や予約 namespace は作らない。capability の発行条件・modelRouting・journey の SQL が pathId に依存する）。
  sink は begin を 2 batch（started＋prepared、次に dispatched。各 await）、complete／fail、`executionId` は main が採番、parent は null（tool 0）、origin をほどいて共有の sanitize を通し、capability を持たない。
  純粋部分（event の組立と検証）は `electron/shared` の共有 module に抽出し、renderer の `api.ts` は再 export にする（抽出は移動だけの commit）。
  usage の台帳は renderer が書く（main に書き手を作らない。1 turn = 1 行）。冪等再送は同じ eventId で、provider 再送ではない。
  新しい start command は `aiPathRegistry.test.ts` の `AI_TRANSPORT_COMMANDS` の走査に載せる（載せないと新しい AI 経路が完全性検査をすり抜ける）。
  `chat_agent_main` の `transport` 表記（今は `send_agent_message`）は、engine 経路でも Native の呼出しが `send_agent_message` のままなので変えず、owner 欄で区別する（3b）。

## 3. 3a の判断（env・build・検査）

### DR-MP3-8 env の許可リスト（決定）

- 決定：除去規則（先頭・末尾・明示名）のうち、Grimodex 自身の owner token 5 名だけを **実名の許可リスト**で除かない。`GRIMODEX_` 始まり全体の除外にはしない。比較は既存の fold（Windows の大小）を通す。
  5 名：`GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN`、`GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN`、`GRIMODEX_PROFILE_ACTIVATION_CI_OWNER_TOKEN`、
  `GRIMODEX_NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN`、`GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN`。
- 根拠（実測、2026-11-19）：除去規則に当たる Grimodex 自身の env はこの 5 名だけ（末尾 `_TOKEN`）。読み手は main の seam、Rust（`std::env::var` の呼出し時読み）、preload で、いずれも CI／unpackaged の seam の鍵。
  Rust の製品 code が読む名前は `GRIMODEX_`／`NIR1_` 始まりか `SystemRoot` で、API key は読まない。`@mastra/*` の dist に GRIMODEX の名前は無い（静的 grep）。
- 実装：`mastraEnv.ts` の `MASTRA_ALLOWED_ENV_NAMES`。`isMastraRemovedEnvName` が除去規則より先に当てる。新しい名前は既定で除去される（安全側）。
  試験：5 名が残る、`GRIMODEX_FOO_TOKEN` は除去、許可名が `MASTRA_`／`OM_`／`AI_GATEWAY_`／`VERCEL_` 始まりや固定名と交わらない、`@mastra` の dist が許可名と GRIMODEX の名前を読まない（読むようになったら落ちる）。
- 脅威モデル D1 への反映：文書は変えない。D1 の「API key 系を除去」は、Grimodex 自身の owner token を含まない（この判断が根拠）。
- 未確認：Mastra の動的な `process.env[変数]` に渡る名前の網羅と、loop の `...process.env` の実使用。MP-3c の観測（X19 と同じ）で閉じる。Mastra の版を上げるとき同じ grep を取り直す。
- 信頼境界：許可リストは「秘密を子や Mastra に渡す」方向の変更ではない。owner token は CI の seam の鍵で、製品の packaged には存在しない。

### DR-MP3-9 `originalEnv()` の配線（決定＋技術判断）

- 決定：env の固定は load の時だけ（`apply()`。MP-3c）。子 process には固定前の env の写しを渡す。
- 配線（3a）：`cliAi.ts` の `mergedEnv` と opencode の `{env:NAME}` の読出し、`createCliAiManager` の検出、`codexAppServer/process.ts`（`buildCliEnvironment` 経由と detect）、
  `vivliostyle.ts`、`backend.ts` の 2 つの既定引数、`ipc.ts` の NIR-1 local generation の launch の env、`mcpSidecar.ts` の override の読出し。
  `mcpSidecar` は main に spawn が無く（sidecar は外部の MCP client が spawn する）、spawn の env は無い。読出しだけ配線した。
- 技術判断：
  - pin は process に 1 つ（`mastraEnv.ts` の内部）。製品の code が使う入口は `mastraOriginalEnv()`（写し）と `mastraOriginalEnvValue(name)`（名前引き）だけで、`apply()` に届く入口は 3a では export しない。
    静的試験が「`mastraEnv.ts` の外が `createMastraEnvPin` を使わない・`apply` に届かない」を固定する。MP-3c が `apply()` を呼ぶ入口を追加する。
  - 写しは使う時点で取る（構築時に 1 回撮ると、後の `process.env` の変更が見えなくなる）。
    例外は `ipc.ts` の NIR-1 local generation の launch の env で、`registerIpcRouter` の登録時に 1 回だけ読む構造（`parseNir1LocalGenerationCiSeam` を 1 回呼ぶ）なので、
    登録時の写しは live の参照と同値。packaged は env を読まない（`isPackaged !== false` の分岐では `mastraOriginalEnv()` を呼ばない）。`apply()` の前は live の `process.env` の写しと同値で、gate 閉の挙動は変わらない（試験で固定）。
  - Windows の `process.env` は名前の大文字小文字を区別しない。plain な写しは `Path` を `PATH` で引けなくなるので、win32 の写しは大文字小文字を区別しない Proxy で包み、名前引きも fold を通す。
- 未配線のまま残した読出し：`index.ts`（153、180、809、822 の env と seam の読出し）、`userData.ts`、`linuxGraphics.ts`、`isolatedHome.ts`、`externalMountFs.ts`、`devRendererUrl.ts`、
  `productJourneyAi.ts`（110、132）、`narrativeMaintenanceCiSeam.ts`（292）、`ipc.ts`（1727 の `GRIMODEX_WORKSPACE_OPEN_TRACE`）、`backend.ts` の `GRIMODEX_NODE_PATH`、`preload/index.ts`。
  これらが読む名前は除去規則に当たらない（owner token は許可リストで残る）ので、実害はない。`preload/index.ts` は別 process（sandbox の preload）の env で、main の `apply()` の影響を受けない。

### DR-MP3-14 workspace を有効にしない（決定＋技術判断）

- 決定：picomatch の例外を続けるので、**Mastra の workspace を有効にしない**検査を入れる。
- 3 層（技術判断）：
  1. 静的検査（3a、`electron/main/mastra/mastraWorkspaceDisabled.static.test.ts`）：`@mastra/` の import は `electron/main/mastra/` の下だけ。
     `electron/` の製品 code に `addWorkspace`・`__setWorkspace`・`new Workspace(`・`new Mastra(`・`@mastra/core/workspace` が無い。
     `@mastra/` を import する file の設定に `workspace`・`skills`・`memory`・`mcp`・`browser` の欄を渡さない。陰性対照つき。
  2. 実行時の tool 名の許可リスト（3c）：許可 tool の snapshot は main の定数（MP-3 では空）。skills は tool 名では捕まらないので、1 の config の静的検査が必須。
  3. bundle の picomatch の importer の pin（3a、DR-MP3-15）。
- Agent は workspace・skills・memory・mcp・browser を受け取らない型にする（`agentRuntime.ts` の設定型）。

### DR-MP3-15 picomatch の例外（決定）

- 決定（2026-11-19）：GHSA-fc5q の期限つき例外（`scripts/pnpm-audit.mjs`。期限 2026-12-18）を **続ける**。workspace を有効にしない検査（DR-MP3-14）で picomatch への到達を防ぐ。
- 実測（2026-11-19、`@mastra/core` 1.83.0）：mastra-agent.cjs の metafile で、picomatch（4.0.7）を import する picomatch の外の file は `@mastra/core/dist/workspace-skills-<hash>.js` だけ。
  main.cjs・preload.cjs に picomatch は入らない。
- 固定：`mastra-ee-check.mjs --dist` が importer を workspace-skills の chunk に pin する。`@mastra/core` を上げて importer が増えたら落ちる（設計）。
- 延長は別の確認（期限 12/18 は変えない。fixed の picomatch が出たら上げて例外を外す）。
- 信頼境界：picomatch に届く入力は、workspace の skills の glob と、workspace の file 操作（`workspace-*.js` の `createGlobMatcher`）の glob。利用者の入力は Mastra の workspace に渡さない。
- 補足：workspace-skills の chunk は `evented-execution` が BM25（tokenize）のために常に import する。chunk は load されるが、workspace を使わなければ picomatch の呼出しは無い。
  だから importer の pin は「到達しない」の証明ではなく、「importer が増えたら気づく」ための検査で、到達を防ぐのは DR-MP3-14 の静的検査。

### DR-MP3-16 再試行なし・telemetry・env の固定（決定）

- 決定：provider の失敗で Mastra が再送しない（`AGENT_NO_RETRY_CONFIG`・`AGENT_CALL_OPTIONS`。GDX-POLICY-001）。telemetry は停止する（`MASTRA_TELEMETRY_DISABLED` は厳密に `"1"`）。
  env の固定は load の時だけ、子 process には元の env の写し（DR-MP3-8、9）。
- 3a は固定の module と配線だけ。Agent 生成時の再試行なしの適用と「provider 失敗で `doGenerate` 1 回・audit の fail 1 回」の試験は 3c（実 Agent の bundle 経由）。

### DR-MP3-17 lazy load と gate L の seam（技術判断。3c）

- lazy load は 3 つ目の bundle を `require(変数)` で読む（同梱の動的 import は parse が main に残る）。single-flight、失敗はキャッシュせず、再試行なし。
  `.map` は作らない。load の前に env を固定し、固定後の load の時間と宛先 0 は MP-3c の journey と MP-13 で測る。
- gate L の seam は専用（NIR-1 local の seam と共有しない）。packaged は env を読まない、`CI=true`、owner token、UUIDv4 nonce、journey 専用 userData で default userData と不一致。
  wire 文字列・owner token の定数と env 名・nonce の env 名は L 専用。journey 専用の userData の env（`GRIMODEX_USER_DATA_DIR`）はアプリ本体と他の seam が共有する名前で、L 専用にできない
  （「default userData と不一致」の検査は既存の `defaultUserDataDirectoriesForApp` を使う）。journey の seam 以外で開かない。
- gate 閉の応答は `ok:true` の typed refusal。start は old-external-ai の DENIED、cancel は INTERNAL＋ALLOWED_STOP。

### DR-MP3-18 3 つ目の bundle（技術判断）

- `electron/scripts/build.mjs` の `bundleConfigs` に 3 つ目 `dist-electron/mastra-agent.cjs`（entry は `electron/main/mastra/agentRuntime.ts`）を足す。
  `@mastra/core` の `Agent` を import して型と factory の雛形を export するだけ。**製品のどこからも require しない**（MP-3c が遅延 load する）。`.map` は作らない（`sourcemap:false`）。
- ee の stub plugin を **全 bundle の config** に当てる。`bundleConfigs[0]` は main に保つ（`mastra-ee-check.mjs` が esbuild の共通設定をここから取る）。
  `dev.mjs` が config の `plugins` を上書きして stub を落としていたので、`composePlugins(config, extra)` で合成する（関数は `build.mjs` に置いて試験する）。
- 実測（esbuild 0.28.1）：mastra-agent.cjs 13,739,712 bytes。main.cjs 3,070,561 bytes（3a の前は 3,066,375。env の配線による増分 4,186）、preload.cjs 20,934 bytes（変化なし）。
- `electron-builder.yml` の `files` は `dist-electron/**` で、3 つ目の bundle は変更なしで asar に入る。`@mastra/*` の node_modules は asar に載らない（`beforeBuild` が false）。

### DR-MP3-19 製品 bundle の ee 検査（技術判断）

- `node electron/scripts/mastra-ee-check.mjs --dist`（build の後）：
  - main.cjs・preload.cjs（と `.map` の `sources`）に `@mastra` が 0。`.map` は `sources` の path だけを見る（`sourcesContent` には自分の source の comment が入る）。
  - mastra-agent.cjs は stub の目印（`__EE_STUB__`）が 1 件以上、ee 固有の文字列が 0、`.map` が無い。全 bundle の config に stub plugin がある。
  - 陰性対照：mastra-agent の config から stub を外した build は ee の input と文字列を検出して落ちる（`.cjs` の require 経路の検査用 entry も走る）。
  - picomatch の importer の pin（DR-MP3-15）。大きさは `bytes` に記録するだけ（DR-MP3-21）。
- CI：`ci.yml` の electron job の production build の後に `--dist` の step を足した。local CI は新しい task id を作らず（`registryDigest` と workload allocation の terms が要る）、
  registry の `electron.build`（`pnpm ci:build:desktop`）の中で走らせる（`package.json` の `ci:build:desktop` に足し、`local-ci-full-workload-allocation.json` の `package.json` の sha256 を同期した）。
  `pnpm electron:build`（NIR の標準 build の固定 command）は変えない。

### DR-MP3-20 asar の検査を release の 3 OS でも呼ぶ（技術判断）

- asar の検査（harness・probe・ee の file と文字列、mastra-agent.cjs が有り `.map` が無い）を `electron/scripts/packaged-smoke/package-check.mjs` から切り出し、
  harness の外の `electron/scripts/mastra-ee-asar-check.mjs` に置いた（`packaged-smoke.yml` の paths の glob `mastra-ee-*.mjs` に乗る）。package-check は再 export する。
- `release.yml` の build job（3 OS）が、packaging の後・upload の前に `node electron/scripts/mastra-ee-asar-check.mjs release/electron` を走らせる。
  `<os>-unpacked/resources/app.asar`（macOS は `Contents/Resources/app.asar`）を全部検査し、1 つも無ければ失敗する。worker の検証は呼ばない（`electron:native:release` に既にあり、重複させない）。
- `packaged-smoke.yml` の PR の paths に `electron/scripts/build.mjs` と `electron/main/mastra/**` を足した。

### DR-MP3-21 bundle の大きさは記録だけ（予算の gate を置かない。技術判断）

- main.cjs・preload.cjs に byte の予算（ratchet）を**置かない**。余裕（現在値＋数十 KB）は main.cjs の自然な増加で数日で尽き、無関係な PR を赤にする。
  また新しい閾値は、ユーザーの確認が要る新しい gate になる。
- main／preload に Mastra が入ることは、別の検査が捕まえる：`mastra-ee-check.mjs --dist` の `@mastra` の文字列検査（`.cjs` と `.map` の `sources`）と、in-memory build の metafile の `@mastra/*` の input（0 件）。
  大きさでしか見えない混入は無い（Mastra は MB 単位で、必ず `@mastra` の文字列と input を伴う）。
- 大きさは `--dist` の出力（`bytes`）に記録として出すだけで、失敗にしない（3a の実測は DR-MP3-18）。mastra-agent.cjs の load 時間は MP-3c で測る。
- 既存の閾値（`perf:budget`、起動時間、`coldStartMs`）は緩めない。`perf:budget` は renderer の bundle だけを見る。3a は renderer の source を変えないので、値は変わらない。

### DR-MP3-22 NIR の標準 build の receipt の外（技術判断）

- 3 つ目の bundle は NIR の標準 build の receipt の外。`scripts/quality/nir1-retrieval/standard-build-receipt.mjs` の `REQUIRED_ARTIFACTS`（main・preload・index.html・native）は変えない（凍結済みの形）。
- CP-4 の凍結の build は公開の直前の 1 回で取り直す（凍結のやり直しをしない方針）。`electron/scripts/build.mjs` の変更が main.cjs の bytes に影響しないことは、
  main の config が stub plugin を足しただけ（main の入力に ee は無い）で、env の配線以外の増分が無いことで確認した。

## 4. その他の技術判断（3b・3c）

### DR-MP3-24 request の形と renderer の分岐（技術判断。MP-4 へ送る）

- start の request は legacy の引数と同形（先頭の `role:system`、segments／tail）から `auditContext` 等を除いたもの。main が `pathId`・`executionId`・`auditContext`・identity を足す。
- renderer の engine 分岐は MP-4（DR-MP3-2）。分岐の時は `sendToLLM` の「送る」だけを差し替え、前処理は動かさない。tools 非空は `unsupported` の typed refusal で legacy に落とす。
  bytes 同一の保証は MP-2 の特性試験（`mastraAdapterCharacterization.test.ts`）を流用する。

### DR-MP3-25 通信の捕捉（技術判断）

- 閉状態（Mastra を load しない）の宛先 0 は自明で、それだけを示す。load 状態の捕捉は非 packaged の seam journey で、Node 側は `NODE_OPTIONS`／`ELECTRON_RUN_AS_NODE` の guard
  （unit の NetworkGuard を流用）、Chromium は既存の net log。packaged の load は MP-13。guard が packaged で使えるかは未確認で、3c の最初に試す。

### DR-MP3-26 申し送り（記録のみ）

- capability の token が現行の renderer 経路で durable な audit に残りうる（response は Rust の走査対象外で、`chatApi` が応答全体を complete に渡す）。MP-3 の対象外の既存の穴。別 lane へ。
- MP-3 の旗を開けても、実 turn は tool なし経路だけ（journey 専用）。製品の挙動は MP-4 まで変わらない。
- Mastra の版は上げない（計画書の第 11 節）。clock を増やさない（Graph／IR の失効の閾値は不変）。
- `evals/quality-manifest.yaml`・`impact-map.yaml`・`docs/AI経路検証.md` の編集は品質規則（動作契約）にあたる。3b・3c で触る前に、`verify:quality` だけで足りるか、
  `grimodex-impact-gate` の対象かを確かめる（3a は触らない）。
- `electron/scripts/performance-benchmark.mjs` は `dist-electron` の全 file を build の識別（path・size・sha256）に集めるので、3 つ目の bundle も入る。
  size の閾値は無く、`pnpm test:electron-perf` は緑（3a で確認）。起動時間（`coldStartMs` など）は Electron が要るので 3a では未測定（閉のとき mastra-agent.cjs は load されない）。
- 3b の前に確かめる未確認：napi が非 enumerable の `callerIdentity` を落とすか、Native の shutdown が in-flight の send を待つか、workspace 切替後の send の pin／audit の挙動。
  3c の前に確かめる未確認：packaged の asar 内の `require(変数)`、Electron main での load 時間。

## 5. 3b の細部（3b の実装の事実。3c の前提）

### 5-1 command・上限・lane

- command 名は `mastra_agent_turn_start`／`mastra_agent_turn_cancel`（`electron/shared/mastraAgentTurnWire.ts`）。refusal の閉集合は DR-MP3-4 のとおり 6 種（`gate-closed`／`restricted`／`unsupported`／`busy`／`sender-refused`／`invalid`）で、3c は理由を足さない。
- wire の上限（暫定。引き上げるときは wire と試験を 1 commit で変える）：messages 2048 件、1 件 2,000,000 字・合計 8,000,000 字（UTF-16）、cache segment 64 件、ID 200 字、route の文字列 2,000 字、route の JSON は深さ 6・節 512。
- owner の上限は **sender あたり 4、全体 8**（3c で `MASTRA_TURN_PER_SENDER_MAX`／`MASTRA_TURN_TOTAL_MAX` の定数にした）。
- lane：start は D2a の `old-external-ai` で DENIED（restricted では typed ではなく `D2A_EGRESS_DENIED` の error。renderer は legacy に落ちる）。cancel は `ALLOWED_STOP` と `INTERNAL` の両方（`abort_chat_stream` 型）。
  renderer の wrapper（`src/lib/mastraAgentTurn.ts`）は start を timeout なしの mutation、cancel を start の後ろに並ばない lane に置く。

### 5-2 audit の owner と書き手

- 行そのものに owner の label は付けない。main が書いた行と renderer が書いた行は `dispatchBoundary`（`before_electron_main_native_send`）と `transportTarget`（`electron-main-native`）で区別でき、registry 側の `AiPathEntry` の owner 欄（`main-agent`）で経路を区別する。`pathId` は `chat_agent_main` のまま。
- sink（`electron/main/mastra/agentAuditSink.ts`）の `stop` と terminal の意味：
  - どの terminal の呼出し（complete／fail／ambiguous／cancel）も、その execution の「停止の要求」として**永久に覚える**。以後 `dispatched` は投げる（`AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN`）。terminal の append が失敗しても、dispatch に進まない。
  - terminal は execution ごとに 1 回。先の呼出しが append 中なら待ち、書けていれば何も書かず、書けなかったら待っていた呼出しが自分の terminal を書く（start-only を作らない）。
  - ambiguous は新しい event type ではなく、`execution.failed`（取消しだけなら `execution.cancelled`）に `remoteOutcome:"unknown"`・`conservative:true`・`captureState:"partial"`・`responseObserved:false`（DR-MP3-10）。
- 持込みの拒否は 2 段：router が renderer の enumerable key に Main の key（`capability`・`auditContext`・`pathId`・`executionId`・`callerIdentity`）があれば、identity を差し替える前に typed `invalid`（`hasMastraAgentTurnForbiddenKey`）。wire の parser も同じ key を `forbidden-key` で拒む。
- cancel の対象は、開始した sender と window が同じ turn だけ（3c）。他の sender の cancel は `found:false`。

### 5-3 DR-MP3-4 の `ipc.ts` の実装との差

DR-MP3-4 は「`ipc.ts` の変更は gate 閉の 1 行と workspace の hook だけ」と書いたが、実装は次のとおり広い。

- gate 閉の応答（router の先頭）、route の生成（seam の launch 事実は NIR-1 local と同じ 1 回の読み）、sender・window・identity の `admit`、持込み key の拒否、shell handler の結合。
- 3c：handler を invoke ごとに `handlersFor({sender, win, callerIdentity})` にし、WORKSPACE_SWITCH の lease 列の先頭に owner の lease を足した。末尾の任意引数に owner を足した。

## 6. 3c の判断と実装の事実

信頼境界（3c）：renderer は新しい権限を得ない。製品の renderer は新しい IPC を呼ばない（MP-4）。gate L は閉のまま（journey の seam だけが開ける）。
閉の launch では Mastra を load せず、owner は turn も runtime も持たず、quiesce・lease・shutdown は即 return する。Native への新しい入口・新しい送信先・保存範囲・event type・pathId・capability は 0。

### DR-MP3-27 owner の構造（技術判断）

- `electron/main/mastraTurnOwner.ts`。turn は (sender, window, 発行された callerIdentity) に束ねる。再入は (senderId, chatSessionId) で 1 つ、同じ turnId も `busy`。
  slot は turn の間と、forced で切り離した後も**その turn の Native の send が settle するまで**持つ（切り離しの繰返しで Native の送信が無制限に溜まらない）。
- 事前検査（rows を書く前）：gate 開・admission・profile が閉じていない・sender の identity が発行済み・上限。`messages` は「先頭に system が 1 件、残りは user／assistant、最後が user」だけを通す。
  それ以外は黙って組み替えず `unsupported`（MP-2 の特性試験の写像に乗る形だけを通す）。
- audit の入力：`expectedWorkspacePath` は **identity の `workspaceId`**（profile gate が Native の `workspace:opened` で束ねた、main が信頼する現在の path）。`projectId` は **null**（wire に project が無いので workspace chain に書く）。
  **確認要（MP-4 の前）**：renderer の `chat_agent_main` の行は project の chain に書かれるので、engine 経路の行が別の chain に入る。wire に `projectId` を足すのは新しい契約になる。
  **解消（2026-11-21 のユーザー決定、MP-4a）**：wire に `projectId`・`currentSceneId`・`chatMessageId` の 3 欄を足し、owner は `projectId` を audit sink と send に渡して legacy と同じ `project:<id>` の chain に書く（MP-3 の行は workspace chain のまま、移行しない）。
  詳細は `docs/plans/mastra-mp4-decisions.md` の DR-MP4-1、2、23（別の枝にある草稿。merge 後はそちらを参照）。
  path が identity に無い turn は `unsupported`。
- 各 step の send の直前（と begin の前）に、`isIssuedCallerIdentity(turn.identity)`・profile が closed でない・sender が破棄されていない、を検査する。外れたら forced（原因は restricted／sender-gone／workspace-switch）。Native には callerIdentity を載せない。
- 結果の写像（renderer から見える形）：

| 終わり方 | start の結果 | audit の terminal |
|---|---|---|
| 成功 | `{status:"completed", turnId, executionId, response}`（response は adapter の send が受けた生の応答。Mastra の text は使わない） | complete（`execution.succeeded`） |
| provider・adapter の失敗 | `ok:false`（原因の message。adapter の固定文ではなく origin の message。legacy の失敗と同じ見え方） | fail（`execution.failed`。adapter の error は kind を `agentErrorKind` に残す） |
| user-stop（Native の send の前。dispatch の行の前でも後でもよい） | `ok:false` `MASTRA_AGENT_TURN_CANCELLED` | `execution.cancelled`（ambiguous の印なし。Native に送っていないので結果は既知。dispatch の行が既にある場合もある） |
| user-stop（Native の send の後） | 通常の完了（送信中の呼出しは切らない＝今の Stop と同じ強さ） | complete |
| forced（restricted／workspace-switch／quit／sender-gone） | `ok:false` `MASTRA_AGENT_TURN_ABORTED: <原因>`（Native の settle を待たず先に返す） | ambiguous の `execution.failed`（1 回） |
| runtime の load の失敗 | `ok:false`（load の error の message）。行は 0、次の start は新しい load | なし |
| 拒否 | typed refusal（`ok:true`） | なし |

- user-stop は「次の step を始めない」。この経路は tool 0・`maxSteps: 1` の 1 step なので、Native の send の前（begin・dispatch の行の書込み中や設定の解決中を含む）なら cancelled、後なら完了になる。
- forced と complete が競合したとき：complete の行が先に書かれても、start は `ABORTED` を返す（行は `execution.succeeded`、renderer には失敗。保守的な側。応答を捨てるだけで、二重の terminal は書かない）。

### DR-MP3-28 runtime と bundle の境界（技術判断）

- `agentRuntime.ts`（3 つ目の bundle の entry）に入れるのは Agent・adapter・方針だけ。audit の sink と Native への send は main 側の owner が作って**注入**する（`ipcContract` を 3 つ目の bundle に持ち込まない）。
  main は runtime の型だけを import する（静的試験が `agentLanguageModel` を main が読まないこと、`agentRuntime`・`agentWire` は `import type` だけであることを固定する）。
- class は境界をまたいで `instanceof` で見ない：sink は main.cjs、adapter は mastra-agent.cjs にあり、同じ source の `AgentModelError` が 2 つの copy になる。`isAgentModelError`（名前・`kind`・`origin`・`isRetryable:false` の形）を使う。bundle 経由の試験が `agentErrorKind` の保持を固定する。
- Agent には workspace・skills・memory・mcp・browser を渡さない。再試行なしは `AGENT_NO_RETRY_CONFIG` を**明示の key で**渡し（`new` の引数に spread を使わない静的検査のため）、`AGENT_CALL_OPTIONS` ＋ `maxSteps: 1` を generate に渡す。
  実行時の tool 名の許可リスト（`MASTRA_AGENT_TOOL_ALLOWLIST`、MP-3 は空）を、Agent の `listTools()` の key と照合する（外れたら turn を始める前に投げる）。
- logger：Agent に注入する（`__setLogger`。`@mastra/core/logger` の import は許可リストの拡張になるので避け、型は `Parameters<Agent["__setLogger"]>[0]`）。Mastra が出す警告の**引数（元の error・request）は捨て**、先頭の文字列だけを owner の `log` に渡す。
- 実測（bundle 経由の試験）：provider の失敗（message が `ECONNRESET` で `isRetryable:true`）でも send は 1 回・fail の row は 1 件。console と注入 logger に原因の文字列は出ない。

### DR-MP3-29 lazy loader（技術判断）

- `electron/main/mastraAgentLoader.ts`：`createRequire(__filename)(変数)`（literal の `require` は esbuild が main.cjs に bundle してしまう）。`mastra-agent` の文字列を持つ製品 file はこの 1 file だけで、そこでも定数の初期値だけ（3a の静的試験を意図して改訂した。陰性対照は残す）。
- gate が閉なら load しない（env にも file にも触れず `gate-closed`）。load の直前に `applyMastraEnvPin()`（`mastraEnv.ts` に足した、共有 pin への**唯一の入口**。loader だけが import でき、静的試験が固定する）。
- single-flight（1 回 yield してから読むので、同じ turn に来た呼出しは 1 つの load を共有する）、成功は process の間保持、失敗は保持せず、loader の中で再試行しない（次の呼出しが新しい load）。
- 未確認（MP-13）：packaged の asar 内で `createRequire` が通るか、Electron main での load 時間、固定後の load の宛先 0。

### DR-MP3-30 lifecycle（技術判断。W9 の読み替えは DR-MP3-12 のとおり）

- **restricted**：owner は egress participant `mastra-turn-owner`（index.ts。既存 3 件の隣）。quiesce で ①admission を（一方向に）閉じる ②forced の abort ③Native の stop の要求（下）④各 turn の ambiguous terminal を待つ（gate の 30 秒の枠。書けなければ quiesce が reject → `participant-failed` → unavailable、枠を超えたら gate が `participant-timeout` と forceStop）。
  turn が 0 件なら何もしない（Native の stop も呼ばない＝閉の launch で、製品の abort が stage 5 から stage 3 へ前倒しにならない）。
  **gate の API を最小に拡張**：`registerMainEgressParticipant` の quiesce が `{ abortNativeInFlight() }` を受ける（reserved の間だけ有効な既存の `abortInFlight` の貸出し。stage 3 が終わると gate が無効にし、後から呼んでも何もしない（試験で固定）。既存の participant は引数を無視する。全 participant に渡す）。
  Native の send 自体を止めるのは Native の側（stage 5 の cancel、または貸出しの stop）で、owner は Native の完了を待たない。
- **workspace 切替**：`ipc.ts` の lease 列の**先頭**に owner の lease。`quiesceForWorkspaceSwitch()` は admission を `busy` にし、全 turn を forced abort し、各 turn の ambiguous terminal を**旧 workspace に**書き終えてから返す（30 秒の bound。超えたら警告して先へ進む。ユーザーの切替を止めない）。
  `resume()`（成功でも失敗でも）で admission を戻す（複数の切替は counter）。lease の前に path の検査があるので、不正な path では turn を止めない。
  第 2 段の hook（index.ts の event bus の observer）：`workspace:opened` と `workspace:lifecycle-state` で、identity が**もう発行されていない** turn だけを abort する（lifecycle の通知ごとに全 abort しない）。profile gate が先に観測するので identity の失効が見える。実効の防御は send 直前の検査。
- **quit**：`shutdown()` を dispose（`shutdownWorkspaceLifecycle` を待たせる `Promise.all` の中。外に置くと workspace が先に閉じて start-only になる）と complete の両方に置く。`T_quit`＝5 秒（暫定、`MASTRA_TURN_QUIT_BOUND_MS`）。有界・冪等（同じ promise）・非 reject。書けなければ start-only が残る（回収なし。報告書が数える）。
- **sender 消失**：per-turn の listener（`destroyed`・`render-process-gone`・main frame の `did-start-navigation`・window の `closed`）。subframe と same-document の遷移では止めない。turn の終端で必ず外す（試験が listener 0 を固定）。
- forced で切り離した turn の遅れた Native の settle は捨てる（result は返さず、2 つ目の terminal も書かない）。forced の ambiguous は begin が進行中なら**その完了を待ってから**書く（handle が要るため）。begin の前なら row は 0。
- **切り離した turn の terminal も待つ**：forced の abort で呼出し側の promise は数 microtask で settle し turn 表から外れるが、ambiguous の append はまだ進行中。
  そのため owner は「terminal の書込み中の切り離した turn」と「Native にまだいる切り離した turn」を別の集合で持ち、restricted の quiesce・workspace 切替の lease・quit の 3 つの待ち（と restricted の Native の stop の要否）は、attached に加えてこの集合も対象にする（bound は変えない）。
  窓の closed（sender-gone）の直後の quit・reload 直後の切替・restricted でも、terminal が書き終わる前に先へ進まない（試験 3 件）。

### DR-MP3-31 検証（3c）と未確認

- 実装した試験：owner の lifecycle（sender 破棄・window close・reload・identity の入替・restricted の実 `beginProfileActivation`・workspace 切替の lease・quit の有界・hook・busy・上限）、loader、bundle 経由の runtime（再試行なし・kind の保持・logger）、静的配線、gate の route（owner との接続、lease の順序）、sink の cancel、`isAgentModelError`。
- 未確認（D11 の受入れ条件）：forced の ambiguous の**後**に Native 側の observer が同じ execution へ行を足さないか（post-terminal）は、実 provider への送信が要るので実 addon の pipeline spec では確かめていない（reqwest は Node の guard の外）。
  足されて ledger の検証が壊れるなら DR-MP3-6 の規則 4 を改訂する（新しい契約の確認が要る）。
- 未確認：packaged の asar の `require`・load 時間（MP-13）。Native の `shutdownWorkspaceLifecycle` が in-flight の send を待つかは、**MP-11／MP-13 の実 provider の測定で確かめる**（journey は送信せず、fake AI が `sendAgentMessage` を置き換えるので確かめられない）。

### DR-MP3-32 journey（3c。技術判断）

- journey `mastra-agent-turn-gate-load-audit`（`electron/scripts/mastra-agent-turn-product-journey.mjs`、shard 3、catalog 36→37）。gate L の seam（`CI=true`、owner token、起動ごとの nonce、journey 専用 userData）を**起動の間だけ** `process.env` に置いて開け、main の IPC を `harness.invokeOk` で直接叩く（renderer の分岐は MP-4）。
- 確かめること：(1) refusal（invalid／持込み key／unsupported）と未知の cancel は audit の行を 0 件書く、(2) admitted の start で runtime が lazy load される（owner は load の後に key を解決するので、key の欠落を名指す error は load の成功後にしか出ない）、(3) key が無いので `ok:false`、Agent は回らず audit の行は 0 件（start-only 0、送信 0）、(4) harness が main の stderr の error 系の行で落とすので、静かに通ることが「失敗として記録していない」証拠。
- key を与えない理由：headless の journey では `safeStorage` が basic_text で、`keyStore` は fail-closed のため `save_api_key` も使えない。key を与える seam や harness の許可は足さない（新しい契約・閾値の緩和になる）。
- **dispatch の 3 行と terminal は journey では見ない**：実 addon の pipeline spec（`mastraAgentAudit.pipeline.spec.ts`）と owner の単体試験（実の sink）が持つ。実 provider での dispatch は MP-13 の受入れ。
- 前提：D-Bus の keyring が見える host では、起動時の legacy keyring の移行（`migrateLegacyKeyringToSafeStorage`）が journey の userData に key を入れることがあり、(3) の検査は落ちうる（漏れではない）。marker（`LEGACY_KEYRING_MIGRATION_MARKER`）で移行を飛ばせるが、TS の定数と形の複製になるので使っていない。
- 未実施：load 状態の通信 0 の観測（`NODE_OPTIONS` の guard が Electron main で使えるかは未確認。DR-MP3-25）。
- Full の資源の見積もり：新しい journey の inventory 2 件は `agent-stream-workspace-switch` と同じ値を新しい id で足した（新しい閾値は作らない）。
