# DD-1c の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

lane：DD-1c（DD-1 の renderer。K5/3 `docs/plans/nir1-d2b-local-send-proposal-3-draft.md` の「IPC の command」「AI 使用ポリシー」「開示」、K4/3 の取消の結束、DSN `docs/plans/nir1-dsn-2026-10.md` §6.2・§6.3）。base は master `58023306`（DD-1a #727、DD-1b #731、DA-2b の PUB-G 前の必須 5 #733 を含む）。
製品入口（PUB-L）は閉じたまま。この文書は GDX-PRECHECK-001 により、コードを変える前の commit として、影響マトリクス、renderer の状態機械の owner／lifecycle matrix、threat model、判断を記録する。Main／IPC（DD-1b）、Native（DD-1a）、実 Electron の journey（DD-1d）、評価 harness（DD-1e 以降）はこの lane では行わない。`electron/` は編集しない（contract の不足は integrator に戻す）。

## 範囲（DD-1c が作るもの）

- 定数 `NIR1_LOCAL_GENERATION_UI_ENABLED = false as const`（`src/features/chat/nir1/nir1LocalGenerationAvailability.ts`）。true にするのは PUB-L（Session C-2）で、DD-1c は行わない。
- typed な invoke の wrapper（`src/features/chat/nir1/nir1LocalGenerationApi.ts`）。DD-1b の 6 command の形だけを送り、応答を閉じた形として parse する。
- 状態機械（`src/application/chat/nir1LocalGenerationTurn.ts`）。capture 受理の後の start → continue の polling → 終端。取消は `nir1_local_generation_cancel` の 1 本。
- 閉じた UI（定数の後ろの lazy chunk）：生成の画面（開示の置き場 3、会話の create／list／read、生成中の表示と取消、typed な拒否理由）、開示の置き場 1・2・5、AI 使用ポリシーの hide／disable。
- 開示の項目 1〜9 の構造化した一覧と、日英の文言案（lazy な翻訳 module。`src/locales/*.json` に足さない）。
- しないこと：`electron/`、`contextBuilder.ts`（0 行）、`chatTurnStoreActions.ts`（増やさない）、`chatTurnLifecycle.ts`、`src/lib/tauri.ts`、`src/locales/*.json`、NC-1／Y-1 の file、`AGENTS.md`、`.agents/skills`、`policies/quality/iron-laws.md`、製品の gate や UI 定数を true にすること。

## 指示書との照合（master `58023306` で確かめた事実）

| 指示書の記述 | master の事実 | 扱い |
|---|---|---|
| reason は `NIR1_LOCAL_REFUSAL_REASONS` を共有（二重定義しない） | `electron/shared/ipcContract.ts:7587` に値として export。renderer の製品コードは `electron/shared` の小さな module（`codexAppProtocol`、`relatedScenesSearchWire`）を `@/../electron/shared/…` で import しているが、`ipcContract.ts` を値で import する製品コードは無い（試験だけ） | lazy chunk の wrapper だけが値で import する。起動時の graph に入らないこと、lazy chunk の大きさを build で実測する（DR-DD1C-3） |
| 置き場 5 は `ProfileEgressStatusIndicator.tsx` | `PROFILE_ACTIVATION_UI_ENABLED` の後ろの lazy chunk（`ProfileEgressStatusSlot.tsx`）。restricted で常に描かれる | その中に、さらに `NIR1_LOCAL_GENERATION_UI_ENABLED` の後ろの lazy な部品を置く（両方の定数が true のときだけ描く） |
| 置き場 1（OpenAI 互換の接続先の入力の近く）と 2（`AiProjectSettings.tsx`） | どちらも `SettingsDialog` の lazy chunk の中（`EditorWorkspaceDialogs.tsx:13` の `lazy`）。`OpenaiCompatibleEndpointsManager.tsx` と `AiProjectSettings.tsx` は廃止済みの hosted editor（`WebEditorAiCategory.tsx`）からも import される | mount はそれぞれの file に 1 つ。Web Editor の側は追わない（廃止済み） |
| 生成の画面 | `ChatPanel.tsx` は lazy chunk（perf の lazy 境界 `ChatPanel-*.js`、上限 240,000）。DA-2b の probe と同じ置き方ができる | `ChatPanel.tsx` に lazy な `Nir1LocalGenerationPanel` を 1 つ置く |
| capture 受理の後の dispatch | 送信の受理は `sendMessage` の `_onAccepted`（`ChatPanel.tsx:989`）で ChatPanel に届く。capture-only の経路では `notifyAccepted` が capture の受理の後に呼ばれる（`chatTurnLifecycle.ts:417`）。receipt そのものは ChatPanel に渡らない | ChatPanel の `_onAccepted` から、送信の時点で写した（会話 ID、Scene ID）を lazy な panel が登録した受け口に渡す（DR-DD1C-7）。`chatTurnStoreActions.ts`／`chatTurnLifecycle.ts` は変えない |
| 起動時 JS の余裕 27 byte | build して実測：raw 4,250,973、gzip 1,343,340（上限 raw 4,251,000）。この worktree の base build | 定数の後ろの動的 import だけ。mount はすべて既存の lazy chunk の中なので、起動時の graph に入る経路は無い見込み（build で実測） |
| `policy` を読めない project で開始の操作を hide／disable（DR-DD1B-12） | renderer の `parseAiPolicy` は不正を full に倒す（`src/features/ai-policy/parse.ts`）。Native の判定は `grimodex-core/src/nir1_local_send_policy.rs` の `decide`（不正はすべて拒否）で、判定ベクトル `decision_vectors.json` がある | renderer に `decide` の写し（表示のためだけ）を置き、同じ判定ベクトルで突き合わせる（DR-DD1C-8） |

## 影響マトリクス（refactor-cross-boundaries。renderer → IPC。実装前）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | 6 command の呼出し | `nir1LocalGenerationApi.ts` | `invoke(command, args)`（`@/lib/tauri`）。args は DR-DD1B-2 の exact key だけ（start `{purpose, conversationId, sceneId}`、continue／cancel `{handle}`、create `{purpose, sceneId}`、list `{}`、read `{conversationId, offset, limit}`）。送る前に renderer でも形を確かめ、外れれば IPC を出さずに typed な `invalid-request` | preload `grim:invoke` → Main（DD-1b）→ Native（DD-1a） | renderer は route、endpoint、messages、ポリシーの判定、key の判定、同意に見える値を渡さない | 既存の command は不変 | wrapper の単体（送る args の exact key、外れの IPC 0） | planned |
| C2 | 応答の parse | 同上 | command ごとの閉じた status。未知の status は typed な `unknown`、`NIR1_LOCAL_REFUSAL_REASONS` の外の reason は `unknown`。continue の差分は各 64 KiB 以下、create の ID は印の形で purpose が一致、read の rows は limit 以下で既知の field だけ。投げられた error は `egress-denied`／`invalid-result`／`invalid-request`／`failed` に分類し、文は画面に出さない | 状態機械、UI | 平文を受けるのは continue と read だけ（K5/3:578）。Main の検査（DD-1b）の手前の多層の検査 | — | wrapper の単体（形の parse、未知の応答、境界の値） | planned |
| C3 | reason の一覧 | `electron/shared/ipcContract.ts`（DD-1b） | 値の import（lazy chunk だけ）。renderer に写しを置かない | wrapper、表示の文言 | 文言は reason ごとに日英がそろう（試験） | Native に reason が足されると DD-1b の試験が落ち、DD-1c の文言の完全性の試験も落ちる | 文言の完全性の試験 | planned |
| C4 | 状態機械 | `nir1LocalGenerationTurn.ts` | ports（start／continue／cancel、timer）を注入。1 つの生成に handle は 1 つ。start は 1 回だけ。continue は 1 本ずつ。取消は cancel の 1 本 | 生成の store、UI | renderer は capture の取消を呼ばない（K4/3:445-451）。終端の後の応答を適用しない | — | 状態機械の単体（下の lifecycle matrix の全セル） | planned |
| C5 | 生成の store | `src/features/chat/nir1/nir1LocalGenerationStore.ts`（Zustand、lazy chunk） | 会話ごとに最新の生成の snapshot。文書の寿命の中だけ（永続化しない） | panel | handle を storage／log に出さない | — | store の単体 | planned |
| C6 | 送信の受理 → start | `ChatPanel.tsx` の `_onAccepted` → panel の受け口 | 送信の時点の（`activeSessionId`、`activeSceneId`）。会話 ID が印の形（`nir1-local-(writing|review)-<uuid>`）のときだけ。purpose は ID から取る（renderer が作らない） | 状態機械 | 定数が false の間、受け口は登録されず呼ばれない（分岐ごと消える） | — | panel の単体、ChatPanel の静的試験 | planned |
| C7 | AI 使用ポリシーの hide／disable | `nir1LocalPolicyGate.ts` | Writing は `chat`・`bodyWrite`、Review は `chat`・`analysis`。既存の `evaluateAiCapability`／`deriveAiGate` で項目ごとに評価し、切った項目があれば hide。Native の `decide` の写しで読めない値なら disable と `NIR1_LOCAL_POLICY_UNREADABLE` の理由。start の直前にも同じ判定で IPC を出さない（`blockIfPolicyOff` と同じ防御の層） | panel | renderer の判定は防御に数えない（Native の `check_before_attempt` が権威） | 既存の `parseAiPolicy` と fixture は変えない | 判定ベクトルの突き合わせ、panel の hide／disable | planned |
| C8 | 開示の項目と置き場 | `nir1LocalDisclosureItems.ts`、`nir1LocalGenerationTranslations.ts`、`Nir1LocalDisclosure.tsx` | 項目 1〜9 は型で固定。置き場 1＝全部、2＝3・4・9、3＝2・3（全項目への導線つき）、5＝3・4・6。文言は案（日英）で Session C-2 で承認 | 置き場 1〜3、5 | 確認や同意を取らない。「確認済み」「同意済み」と読める表示を出さない。既読などの永続状態を持たない | — | 完全性の試験（日英で 1〜9、置き場ごとの項目、禁止語、置き場 5 の範囲） | planned |
| C9 | 送信先と model の表示 | `nir1LocalRoutePreview.ts` | AI 設定（`useAiSettingsStore`）から、provider が OpenAI 互換、接続先が `127.0.0.1`／`[::1]` の IP literal と port と `/v1`、model の名前の規則（Native の `model_name_is_valid` の写し）を見る。合わなければ使えない理由（`localhost` や host 名を含む）を示す | 置き場 1、3 | 表示だけ。実際の送信先は Native が開始の時に決める | — | 単体（IP literal だけ、`localhost`／host 名の理由） | planned |
| C10 | 会話の create／list／read | panel | create は利用者の操作で 1 回。会話 ID は create の応答と list の値だけを使う。read は offset／limit（1〜64）でページを読み、返った行を全部表示する（履歴として不適格になった行を含む。K5/3:262） | panel | renderer は会話 ID を作らない | — | panel の単体 | planned |
| C11 | Main／Native／preload／`tauri.ts`／`chatTurnLifecycle.ts`／`chatTurnStoreActions.ts`／`contextBuilder.ts` | — | — | — | — | — | 差分 0 を diff で確かめる | out of scope |

## renderer の owner／lifecycle matrix（GDX-PRECHECK-001。phase × event。各セルは「結果／終端の書き手」）

phase：R0 定数 false、R1 受理の待ち（送信の後、`_onAccepted` の前）、R2 start の応答待ち、R3 handle あり（continue の polling）、R4 取消の要求後（cancel の応答待ち、または cancel の受理の後の drained 待ち）、R5 終端。

| phase ＼ event | panel の unmount | 会話の切替 | scene の切替 | 再読込／renderer の crash | 利用者の取消 | 遅れた応答（continue／start／cancel） | AI 使用ポリシーの変更 | caller の交代（workspace の切替、activation） |
|---|---|---|---|---|---|---|---|---|
| R0 | 何も mount しない | — | — | — | — | — | — | — |
| R1 | 受け口が外れ、受理は捨てられる（start しない。capture は current のまま残り、新しい送信で上書きされる）／書き手なし | 受理は送信の時点の会話に結ぶ（切替の後でも、送信した会話に対して start する） | 同左（送信の時点の Scene） | 文書ごと消える。start しない | 対象外（handle も start もない） | — | 次の受理から反映（start の直前に判定） | Main が拒否する |
| R2 | 生成は store に残り、start の応答を受ける（unmount で取消さない） | store に残る。panel は今の会話の生成だけを描く | 同左 | handle は JS の heap と一緒に消える。Native の生成は終端まで走り保存される。drain されない出力は次の start か window の close まで process 内に残る（DR-DD1B-19）。新しい文書は handle を知らないので読めない | 取消の要求を覚え、handle が返ったら直ちに cancel を 1 回呼ぶ。unavailable なら終端（refused） | start の応答は 1 回だけ適用。終端の後（dispose の後）に handle が返ったら cancel を 1 回呼ぶ（誰も polling しないので） | 進行中は取消さない（K5/3 Recovery） | Main が caller の交代で sender の生成を止める → 応答は unavailable か、handle の後の continue が `CALLER_REVOKED`／`HANDLE_NOT_FOUND` |
| R3 | polling は store の生成が続ける（unmount で止めない。終端で handle を捨てる） | 同左 | 同左 | R2 と同じ | cancel を 1 本だけ呼ぶ。in flight の continue は待たない | continue は 1 本ずつ。終端の後に返った continue は捨てる（差分も state も適用しない） | 同上 | continue が `CALLER_REVOKED`／`HANDLE_NOT_FOUND`／`SENDER_REFUSED` → 終端（handle を捨てる） |
| R4 | 同上 | 同上 | 同上 | 同上 | 2 回目の取消は無視（cancel の応答待ちの間）。`NIR1_LOCAL_CANCEL_CAPTURE_FAILED` のときだけ再び押せる（DR-DD1B-10、DR-DD1A-15） | cancel の受理の後に返った `running` の continue は phase を戻さない（単調）。drained で終端 | 同上 | 同上 |
| R5 | handle は既に捨てた。store の snapshot だけが残る | — | — | — | 押せない | すべて捨てる | — | — |

行ごとの補足（iron-laws の列）：

| 行 | entry／admission closure／pending start／active handle／bounded wait／終了の証拠／error・timeout・onClosed／restart |
|---|---|
| R1 | entry は ChatPanel の `_onAccepted`（送信 1 回につき 1 回）。closure は定数、会話 ID の印の形、AI 使用ポリシーの判定。pending なし |
| R2 | pending start は 1 つの生成に 1 本。start は同じ生成で 2 回呼ばない（押し直しの UI を出さない）。invoke には caller の timeout が無い（`callerTimeoutForCommand` が null、ipcQueue の mutation の枠） |
| R3 | active handle は 1 つの生成に 1 つ。store の外に出さない（永続化・log しない）。polling の待ちは差分なしで 250 ms、差分ありか final で drained でないときは 0 ms。IPC の失敗が 3 回続いたら終端（`lost`）にし、cancel を 1 回だけ試す。Native の生成は Native の上限（transport の timeout、K1b）で必ず終端する |
| R4 | 取消の後も drained まで continue を読む（Native の entry を外すのは drained の continue。DR-DD1B-10） |
| R5 | 終端の書き手は Native（DT-2／DT-5）。renderer は表示の終端だけを持ち、会話の read で保存された行を読み直す |

## threat model（K5/3:238-260 の確認済みの範囲。新しい actor・受信先・保存先を足さない）

| 攻撃・actor | DD-1c での扱い | 試験 |
|---|---|---|
| renderer が PUB-L の前にこの route を使う | 定数 false で UI・IPC が 0。Main と Native の gate（DD-1a／b）が権威 | 定数 false の DOM と IPC 0、静的な試験 |
| renderer の値で束縛を作る（route、endpoint、key、messages、purpose の偽造、ポリシーや同意に見える値） | wrapper は exact key の args だけを組む。purpose は会話 ID の印から取る。handle は start の応答だけ、会話 ID は create／list の応答だけ。束縛は Main の sender と Native の caller（DD-1b） | wrapper の単体 |
| 出力の別の窓・文書への配信 | handle を store の外（storage、log、event）に出さない。再読込の後の文書は読めない（DR-DD1B-19） | 静的な試験（handle を storage に書かない） |
| 未知の応答の表示（Native の変更で平文の面が無言で広がる） | 閉じた parse。未知の status と reason は typed な `unknown`。error の文を出さない | wrapper の単体、panel の単体 |
| 侵害された renderer | Out-of-scope（K5/3。残余は開示の項目 4）。renderer の UI の無効化は防御に数えない | — |

受信先・保存先：DD-1c は新しい受信先、保存の範囲、外向きの通信、永続状態（既読など）を足さない。

## 判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DD1C-1 | 2026-10-26 | DD-1c | 定数の名前と置き場：`NIR1_LOCAL_GENERATION_UI_ENABLED = false as const` を `src/features/chat/nir1/nir1LocalGenerationAvailability.ts` に 1 行だけ置く（`profileActivationAvailability.ts` と同じ型）。mount point は定数そのものを条件で読み、`/* @__PURE__ */ lazy` の後ろに置く。静的な試験（`nir1LocalGenerationMountPoints.static.test.ts`）で、定数の module の形、読む file の一覧、lazy の pure、mount が定数の直下にあること、lazy chunk の静的 import が無いことを固定する | 表示だけ | 既存の `PROFILE_ACTIVATION_UI_ENABLED` を使う（PUB-G と PUB-L は別の承認） | 不要 | 該当なし | R0 | 記録済み（実装前） |
| DR-DD1C-2 | 2026-10-26 | DD-1c | mount point は 4 つで、どれも既存の lazy chunk の中：`ChatPanel.tsx`（生成の画面＝置き場 3、会話、生成の表示と取消）、`OpenaiCompatibleEndpointsManager.tsx`（置き場 1）、`AiProjectSettings.tsx`（置き場 2）、`ProfileEgressStatusIndicator.tsx`（置き場 5、restricted のときだけ）。定数の分岐が minify で消えなくても、起動時の graph には届かない（二重の守り）。実測は build で行う | 表示だけ | 起動時の chunk に mount を置く（余裕 27 byte） | 不要 | 該当なし | R0 | 記録済み（実装前） |
| DR-DD1C-3 | 2026-10-26 | DD-1c | wrapper の形。args は DR-DD1B-2 の exact key だけ。送る前に renderer でも形（purpose の enum、ID の規則、handle の 32 桁の 16 進、offset 0〜u32、limit 1〜64）を確かめ、外れれば IPC を出さずに `{status:"error", error:"invalid-request"}`。応答は command ごとの閉じた形として parse し、未知の status は `{status:"unknown"}`、一覧の外の reason は `"unknown"`。continue の終端の語（`reason`）は Main と同じ正規表現で確かめ、表示には使わず data 属性だけに置く。投げられた error は文を見ずに分類だけを返す（`D2A_EGRESS_DENIED` で始まる→`egress-denied`、`invalid result`→`invalid-result`、`invalid args`／`IPC_INVALID`→`invalid-request`、他→`failed`）。reason の一覧は `ipcContract.ts` の値を import する（lazy chunk だけ） | 平文の面は continue と read だけ | renderer に reason の写しを置く（二重定義。指示書が禁止）。応答を検査しない（Main が検査済み。多層にならない） | 不要 | 該当なし | — | 記録済み（実装前） |
| DR-DD1C-4 | 2026-10-26 | DD-1c | 状態機械の owner：文書の中の Zustand store（lazy chunk）が会話ごとに最新の生成を持ち、panel の unmount、会話の切替、scene の切替では取消さず、polling を終端まで続ける（利用者が取消せなくなる窓を作らない。生成は利用者の明示の操作）。再読込と crash は取消に結ばない（DR-DD1B-6、-19 と同じ）。workspace の切替などの caller の交代は Main が止め、continue の `CALLER_REVOKED`／`HANDLE_NOT_FOUND` で終端にする。同じ会話に新しい受理が来たら新しい生成を作り、古い生成は終端まで polling を続ける（Native が `SESSION_BUSY` を返すなら新しい側が typed な終端になる） | handle は文書の heap だけ | unmount で取消す（保存されるはずの成功を失い、K5/3 が挙げる事象でない）。unmount で polling だけ止める（取消の手段を失い、drain されない出力が残る） | 不要 | 該当なし | R1〜R5 | 記録済み（実装前） |
| DR-DD1C-5 | 2026-10-26 | DD-1c | 終端の分類：continue の drained で state が `succeeded`／`failed`／`cancelled` ならその終端、それ以外の state で drained なら `unknown`。start の unavailable、continue／cancel の refused（`HANDLE_NOT_FOUND`、`CALLER_REVOKED`、`SENDER_REFUSED`、`GATE_CLOSED` ほか）は handle を捨てて終端（start は `refused`、ほかは `lost`）。cancel の `NIR1_LOCAL_CANCEL_CAPTURE_FAILED` だけは終端にせず、理由を示して取消を再び押せる（DR-DD1B-10）。IPC の失敗は 3 回続いたら `lost`（cancel を 1 回だけ試す）。終端は単調で、終端の後の応答は捨てる | — | IPC の失敗 1 回で終端（一時的な詰まりで取消の手段を失う）。無制限に再試行（renderer の待ちが有界でなくなる） | 不要 | 該当なし | R3〜R5 | 記録済み（実装前） |
| DR-DD1C-6 | 2026-10-26 | DD-1c | 二重 start の防止：start は 1 つの生成で 1 回だけ（機械の中で冪等）。start の失敗（unavailable、IPC の失敗）の後に押し直しの UI を出さない。再試行は新しい送信（新しい capture）で行う（K4/3:249）。同じ受理を 2 回渡されても 2 本目の生成を作らない（受理ごとの token で 1 回に限る） | Native の start の記録が権威 | 押し直しの button（Native が `ALREADY_STARTED` で拒否するだけの操作を見せる） | 不要 | 該当なし | R2 | 記録済み（実装前） |
| DR-DD1C-7 | 2026-10-26 | DD-1c | 送信の受理と start の結線：ChatPanel の `handleSend` で、定数が true のときだけ送信の時点の（`activeSessionId`、`activeSceneId`）を写し、`_onAccepted` で lazy な panel が登録した受け口（ref）に渡す。panel は会話 ID が印の形のときだけ start する。`chatTurnStoreActions.ts`／`chatTurnLifecycle.ts` は変えない（DSN §6.2）。`_onAccepted` は capture-only の経路では capture の受理の後に呼ばれる。transport の経路（capture の外）で呼ばれた場合は、Native が current な capture なしとして typed に拒否する（capture の前の拒否なので押し直し扱いにならない） | 受理の通知は renderer の内部。Native が capture の current を確かめる | capture の receipt を `chatTurnLifecycle` から返す（DSN §6.2 の範囲で行が増える）。panel に専用の入力欄を置く（入力の capture の経路が 2 つになる） | 不要 | 該当なし | R1 | 記録済み（実装前） |
| DR-DD1C-8 | 2026-10-26 | DD-1c | AI 使用ポリシーの表示：purpose ごとに要る 2 項目を既存の `evaluateAiCapability`（readiness は `ready` を渡し、ポリシーの項目だけを見る）と `deriveAiGate` で評価し、どちらかが hidden なら開始の操作（その purpose の会話の作成）を hide、生成の画面ではその会話の開始が止まることを typed な理由（`NIR1_LOCAL_POLICY_DENIED`）で示す。Native の `decide` の写し（`decideNir1LocalSendPolicy`）が読めない値と判定したら、操作を disable して `NIR1_LOCAL_POLICY_UNREADABLE` を示す（DR-DD1B-12）。start の直前にも同じ判定で IPC を出さない（`blockIfPolicyOff` と同じ防御の層。toast でなく生成の画面の typed な理由）。写しは `decision_vectors.json` の全 vector で Native と突き合わせる | 表示と手前の拒否だけ。権威は Native | `parseAiPolicy` だけで判定する（読めない値が full になり、Native が capture の後に拒否する。押し直せない） | 不要 | 該当なし | R1 | 記録済み（実装前） |
| DR-DD1C-9 | 2026-10-26 | DD-1c | 開示の構造：項目は `1`〜`9` の型で固定し、置き場ごとの項目の集合を定数で持つ（1＝全部、2＝3・4・9、3＝2・3 と全項目への導線、5＝3・4・6）。文言は `nir1LocalGenerationTranslations.ts`（lazy、`nir1Local` の key）に日英で置き、Session C-2 で承認する案とする。置き場 3 と 1 は送信先と model の表示（C9）を添える。既読などの永続状態を持たず、送信の判定に使わない | 表示だけ | `src/locales/*.json` に置く（起動時の graph と eval:impact の Fallback が増える。DR-DA2B-R7 の前例） | 不要 | 該当なし | — | 記録済み（実装前） |
| DR-DD1C-10 | 2026-10-26 | DD-1c | read の表示：返った行を全部、返った順に描く（renderer は行を選ばない。履歴として不適格になった行も表示に残す）。`unavailable` の行は内容なしの typed な表示（閉じた語は data 属性）。`thinking` は検証済みの配列だが形を renderer が決めないので、件数だけを示す（内容の描画は DD-1d／C-2 に回す）。ページは offset と limit 64 で「続きを読む」 | 平文は read の応答だけ | thinking の内容を JSON で描く（形が契約にない） | 不要 | 該当なし | — | 記録済み（実装前） |
| DR-DD1C-11 | 2026-10-26 | DD-1c | 生成の表示と保存の関係：生成中の差分は panel だけが描き、ChatStore のメッセージ一覧には書かない（Native が終端で保存し、panel は終端の後に read で読み直す）。チャットのメッセージ一覧への反映（既存の port 経由の再読込）は、実 Electron で確かめられる DD-1d の範囲に回す | 表示だけ | ChatStore に差分を書く（chatTurnStoreActions の port を増やすか、別の書き手を作る） | 不要 | 該当なし | R3〜R5 | 記録済み（実装前） |

## 確かめられなかったこと（実装前の時点）

- 実 Electron（定数 false では UI が見えない。DD-1d の入口条件）、Windows／macOS、実 local server／model。
- 送信先と model の表示が Native の解決した route と一致すること（renderer は設定から読むだけ。Native の解決は開始の時。DD-1d で比べる）。

## 実装後の追記（2026-10-26。上の行は実装前の記録のまま残し、変えた点と分かったことはここに足す）

| ID | 判断・訂正・観察 | 状態 |
|---|---|---|
| DR-DD1C-12 | （DR-DD1C-2 の訂正）mount の置き方。開示の 3 か所（`OpenaiCompatibleEndpointsManager.tsx`、`AiProjectSettings.tsx`、`ProfileEgressStatusIndicator.tsx`）は、DA-2b と同じく host の file に局所の `/* @__PURE__ */ lazy` を置く。最初は共有の slot module（`Nir1LocalDisclosureSlot.tsx`）を置いたが、定数の分岐が minify で消える前に module の取り込みが決まるため、slot が SettingsDialog と状態の表示の共有 chunk になり、起動時の `index` の preload の表に載った（実測 +49 byte で上限を超えた）。生成の画面は `Nir1LocalGenerationSlot.tsx`（importer は ChatPanel だけで ChatPanel の lazy chunk に入る）を残す：`profileActivationMountPoints.static.test.ts` が ChatPanel の pure な `lazy(` を 1 つに固定しているため、ChatPanel に局所の lazy を足すと DA-2b の試験を変えることになる | 実装・実測済み |
| DR-DD1C-13 | 開始の直前の防御は `policyGuard.ts` の `isAiFeatureBlockedByPolicy`（`blockIfPolicyOff` と同じ層）で項目を見る（`currentNir1LocalPurposeGate`）。lazy chunk が `evaluateAiCapability` だけに届くと、起動時の `policyGuard` chunk から `evaluateAiCapability` が分かれた（実測 +393 byte、chunk が 1 つ増える。DR-DA2B-R8 と同じ現象）。`policyGuard` にも届かせると分かれない | 実装・実測済み |
| DR-DD1C-14 | （DR-DD1C-8 の補足）Native の `decide` の写しは、空白の判定を Rust の `char::is_whitespace`（Unicode White_Space）の code point の集合で行い（JS の `trim` は U+FEFF も外す）、toggle の有無は own property だけを見る。Native の判定ベクトル 152 件の全件で、Writing と Review の両方の結果（allow／source／code／item）が一致する | 試験済み |
| DR-DD1C-15 | 試験が実装の不具合を見つけた（commit 前）：continue の state が非終端のとき、`terminalPhaseOf` が `unknown`（終端）を返すため「final で drained でない」と誤判定し、差分なしでも 0 ms で continue を続けていた。終端の state だけを final とする判定（`isFinalState`）に直した | 修正・試験済み |
| DR-DD1C-16 | 変異 M4a（終端で `handle = null` を外すだけ）は等価：終端の後の continue／cancel は `terminal()` の確認で止まり、handle を読む経路が無い。終端の確認も一緒に外す M4b は落ちる | 記録 |

### 試験と変異

追加した試験（vitest 310 件、実 Chromium 12 件）：`nir1LocalGenerationApi.test.ts`（40。Main の本物の validator〔`dispatchInvoke`〕を通した 6 command の args と応答、IPC を出さない要求の拒否、閉じた parse、error の分類）、`nir1LocalGenerationTurn.test.ts`（19。lifecycle matrix の R2〜R5）、`nir1LocalPolicyGate.test.ts`（166。Native の判定ベクトルの全件と hide／disable）、`nir1LocalRoutePreview.test.ts`（29）、`nir1LocalDisclosure.test.ts`（16。日英の項目 1〜9、置き場、禁止語、開示の試験 (4)・(6) の範囲）、`Nir1LocalDisclosure.test.tsx`（8）、`Nir1LocalGenerationPanel.test.tsx`（12）、`nir1LocalGenerationHosts.test.tsx`（3。定数 false で要素と lazy の要求 0）、`nir1LocalGenerationMountPoints.static.test.ts`（13）、`ChatPanel.nir1Local.test.tsx`（4）、`Nir1LocalDisclosure.browser.test.tsx`（12。幅 320／768／1280、日英）。

| 変異（commit の後、原本の copy から戻す） | 落ちた試験 |
|---|---|
| M1 定数を true にする | 静的（定数の module の形） |
| M2 policy の hide を外す | policy gate、panel |
| M3 読めない policy の disable を外す | policy gate、panel |
| M4a 終端で handle を捨てない（単独） | 通る（等価。DR-DD1C-16） |
| M4b 終端で handle を捨てず、取消の終端の確認も外す | 状態機械（4 件） |
| M5 取消を 2 本に分ける（capture の取消も呼ぶ） | 静的、panel |
| M6 未知の reason を通す | wrapper、panel |
| M7 遅れた continue を適用する | 状態機械 |
| M8 取消の受理の後の running で phase を戻す | 状態機械 |
| M9 start を 2 回送れる | 状態機械 |
| M10 同じ受理で 2 本の生成 | panel |
| M11 `CANCEL_CAPTURE_FAILED` を終端にする | 状態機械 |
| M12 IPC の失敗の上限を外す | 状態機械 |
| M13 受理を定数なしで渡す | 静的、ChatPanel |
| M14 置き場 2 の mount を定数の外に出す | 静的、host |
| M15 lazy の pure の印を外す | 静的 |
| M16 start に route を足して送る | wrapper（Main の validator が拒否） |
| M17 continue の差分の上限を外す | wrapper |
| M18 unmount で生成を取消す | panel |
| M19 read で unavailable の行を捨てる | wrapper、panel |
| M20 renderer が会話 ID を作る | panel |
| M21 置き場 5 から項目 6 を外す | 開示（2 file） |
| M22 reason の文言を 1 つ消す | 開示 |
| M23 IPC の error の文を画面に出す | wrapper、panel |
| M24 policy の写しで toggle の型を見ない | policy gate（判定ベクトル） |
| M25 開始の直前の policy の防御を外す | panel |

実行した検証：`pnpm exec tsc --noEmit`（0 件）、変更 file の eslint／prettier（0 件）、`npx vitest run src`（1,586 file、15,744 件 pass、skip 38）、`pnpm test:browser`（`Nir1LocalDisclosure.browser`、`ProfileEgressStatusIndicator.browser`、`ChatPanel.virtualization.browser`、`layoutInvariants.browser` の 4 file、38 件）、`pnpm validate:architecture`（23 件 pass、ratchet 不変）、`node --test scripts/quality/impact-map.test.mjs`（37 件）、`node scripts/quality/impact-map.mjs --base origin/master`（Fallback: no。分類 file を変えたので全 suite の選択）、`pnpm eval:fixtures`（32 件 pass）、`pnpm build` と `pnpm perf:budget`（下の表）。Quick／Full は走らせていない。

### 起動時 JS graph の実測（`pnpm build` → `pnpm perf:budget`。この worktree）

| build | 起動時 raw／gzip／chunk 数 | lazy chunk |
|---|---|---|
| base（master `58023306`） | 4,250,973／1,343,340／150 | ChatPanel 181,538、SettingsDialog 203,740 |
| DD-1c、定数 false | 4,250,973／1,343,232／150（起動時の各 chunk の大きさは base と同じ） | ChatPanel 181,630（+92）、SettingsDialog 203,746（+6）。`Nir1LocalGenerationPanel` と `Nir1LocalDisclosure` の chunk は dist に出るが、どの chunk からも参照されない |
| DD-1c、定数 true（commit しない変異の build） | 4,250,973／1,343,373／150 | ChatPanel 183,541（+2,003）、SettingsDialog 205,447（+1,707）、`Nir1LocalDisclosure` 27,723（gzip 9,601）、`Nir1LocalGenerationPanel` 19,360（gzip 6,459） |

上限の緩和は要らなかった。build の出力の検査（DR-DA2B-R14 と同じ方法、repo には足さない）：定数 false の build で、起動時の 150 chunk はどれも DD-1c の chunk の file 名、`nir1_local_generation_start`、`nir1_local_conversation_list`、`NIR1_LOCAL_POLICY_UNREADABLE`、`nir1Local` を含まない。

### 確かめられなかったこと（実装後）

- 実 Electron（定数 false では UI が見えない）。DD-1d の入口条件：実 Main／Native を通した create → 送信（capture）→ `_onAccepted` → start → continue → cancel → cold reopen → list／read、送信先と model の表示と Native が解決した route の一致、chat の会話の一覧での local の会話の見え方。
- `_onAccepted` は capture の receipt を渡さないので、受理の時点の（会話、Scene）は ChatPanel の store の値を写したもの。capture の Scene（`effectiveSceneId`）と食い違う場合や transport の経路で受理された場合は、Native が `SCENE_MISMATCH`／`CAPTURE_NOT_CURRENT` で typed に拒否する（capture の前の拒否は押し直し扱いにならない）。実際に食い違う経路があるかは DD-1d で確かめる。
- 生成の出力の chat のメッセージ一覧への反映（DR-DD1C-11）、thinking の内容の表示（DR-DD1C-10）。
- Windows／macOS、実 local server／model。Quick／Full は走らせていない。read-only の独立レビューと Fable の受入れは integrator に委ねる。

### integrator に戻す事項

1. contract：不足で止まるものは無い。任意：`NIR1_LOCAL_REFUSAL_REASONS` は 1 万行超の `ipcContract.ts` から値で import している（tree-shake で配列だけになり、lazy chunk でだけ実測。DR-DD1C-3）。小さな共有 module に移すかは DD-1b の持ち主の判断。
2. ipcQueue：6 command は caller の timeout を持たないので `mutation` の枠に入る。continue の polling（差分なしで 250 ms ごと）は lifecycle の barrier の間は待たされ、mutation の枠を短く使う。`src/lib/tauri.ts` は起動時の chunk なので DD-1c では変えていない。
3. Session C-2 に回す文言：`src/features/chat/nir1/nir1LocalGenerationTranslations.ts` の全部（開示の項目 1〜9 と要旨、置き場の導入文、送信先の表示と使えない理由、生成の画面、35 個の reason と unknown、IPC の失敗の分類）。置き場 4（規約・プライバシー通知・ガイド・開発者メッセージの改訂）は PUB-L の PR。

## 独立レビュー（契約・安全性、lifecycle）の修正の追記（2026-10-26）

P1 はなし。P2 の 6 件と P3 の小さな指摘を直し、直さないものはここに記録する。上の行は当時の記録のまま残す。

| ID | 判断・訂正 | 状態 |
|---|---|---|
| DR-DD1C-17 | （P2 指摘 1。DR-DD1C-4 の訂正）会話の生成が終端でない間に同じ会話の新しい送信が受理されても、新しい機械を作らない。受理は typed な通知（policy の拒否はその理由、ほかは Native が 2 本目に返すのと同じ `NIR1_LOCAL_SESSION_BUSY`）として、走っている生成の横に出す。走っている生成の表示と取消はそのまま残る。それまでは新しい機械が `latest` を置き換え、`SESSION_BUSY` で終わると古い生成の表示と取消が消えていた（policy の拒否の `latest.delete` も同じ）。その受理の capture は保存されたまま start されない。もう一度生成するには新しく送る（Native の規則と同じ）。終端でない機械を全部持って表示と取消を向ける案は採らない：Native が同じ会話の 2 本目を拒否するので、並ぶのは拒否された 1 本だけで、表示が増えるだけになる | 実装・試験済み |
| DR-DD1C-18 | （P2 指摘 2）監査の書出しの間に ipcQueue が Main の前で mutation を拒否する `IPC_MUTATION_CANCELLED` は、typed な `held` に分類し、失敗の回数（3 回）に数えない。start・continue・cancel を、それぞれ backoff（250 ms から倍にして 2 s まで）で送り直す。上限は回数でなく壁時計の 60 s で、超えたら `lost` にして、最後に best-effort の cancel を 1 回だけ送る。start の送り直しは Main に届いていない呼出しのやり直しなので、二重 start には当たらない（DR-DD1C-6 の「start は 1 回」は Main に届いた start の数）。ports に `now()` を足した | 実装・試験済み |
| DR-DD1C-19 | （P2 指摘 3）会話の一覧と作成の `mounted` を effect の setup で true に戻す（StrictMode の二重 effect で結果が捨てられ、`creating` が固まっていた） | 実装・試験済み |
| DR-DD1C-20 | （P2 指摘 6）continue が in flight の間に cancel が refused なら、終端を決めずにその continue の結果を待つ。drained ならその終端、そうでなければ差分を足してから `lost` にする。`NIR1_LOCAL_CANCEL_CAPTURE_FAILED` の理由は、取消を送り直す時と終端で消す。指示の「後の ok の continue で消す」は採らない：次の continue は 250 ms 後なので、取消をもう一度押す必要があるという理由が見えなくなる。`ipcError` は今までどおり ok の continue で消す。この修正の後、continue が in flight の間に終端になる経路は無いので、変異 M7（遅れた continue を適用する）は等価になった（`onContinue` の終端の確認は防御として残す） | 実装・試験済み |
| DR-DD1C-21 | （P3）Native の `decide` の写しに、`JSON.parse` は読むが serde_json は拒否するはずの値を足し、`not-json` とした。対象は、f64 の範囲の外の数（`1e400`）、escape した単独の surrogate（値と key の両方）、深さ 128 の入れ子（serde_json の recursion limit 128 を「128 段目で失敗」と読んだ）。Rust を実行して確かめてはいないので、TS の試験だけに足し、Native の判定ベクトルには足していない。境界の読み違いがあっても、UI が Native より厳しく disable する向きにだけずれる | 実装・試験済み（Rust 未確認） |
| DR-DD1C-22 | （P3）section を sr-only の題名に `aria-labelledby` で結ぶ。取消を押したら、focus を状態の行（`tabIndex -1`）へ移す。開示の区切りの文字は表示の言語のものにする。作成日時は i18n の言語の書式で出す。実 Chromium の試験は、置き場 3 で「すべて表示」が無いとき・置き場 1 で有るときに落ちる形に直した | 実装・試験済み |
| DR-DD1C-23 | （P2 指摘 5）開示の置き場 3 に purpose（Writing／Review）を常設で示す（K5/3:438）。指摘 4 として、項目 4 に K5/3:448 の 2 文、項目 9 に「検証の結果の表示」（:452）を日英で足した。文言は案のまま | 実装・試験済み |

### 直さず記録する（コードは変えない）

| ID | 内容 | 次の lane／入口条件 |
|---|---|---|
| DR-DD1C-24 | **chat の capture-only の turn と local 生成の lifecycle が結ばれていない**（lifecycle P2-3。推測を含む）。(1) capture-only の間、`chatTurnStoreActions.ts:2693` は `isStreaming` を true のまま残し、control も解放しない。そのため local 生成が終端しても、composer は送信中のまま固まりうる。(2) chat の停止は、`chatTurnLifecycle.ts:212-240` で capture の取消を別に呼び、local 生成は止めない。これは K4/3:445-451 の「取消は 1 本」に実質で反する。(3) `ChatPanel.nir1Local.test.tsx` は `sendMessage` を mock しているので、この結線の欠けを捉えられない。本 lane は両 file を触らない（DSN §6.2）。下の lifecycle matrix の列を足し、次の lane の入口条件にする | **DD-1c-2**：chat の停止・capture-only の turn の解放を local 生成に結ぶ（port が要る）。DD-1d の入口条件 |
| DR-DD1C-25 | （DR-DD1C-11 の補足）`ChatPanel` の `selectSession(localId)` で local の会話を開く。own-data-read が開いているので、その会話の `chat_messages` の行は ChatStore と通常のメッセージ一覧にも載る。そこには K5/3 の「行の段」の外の行（失効した行など）も出うる。read の panel が出すのは Native が照合した行だけ | DD-1c-2／DD-1d の入口条件（一覧の行の範囲を read の範囲にそろえるか、local の会話では一覧を隠す） |
| DR-DD1C-26 | 置き場 5 は状態の表示の info の popover の中にある。K5/3 の「restricted の利用者が常に見られる表示」に当たるかは、Session C-2 で決める | Session C-2 |
| DR-DD1C-27 | reason `NIR1_LOCAL_PREPARATION_FAILED` の文「送信はしていません」の根拠は、DR-DD1B-12（準備の失敗は送信 0）。C-2 で文を確かめる | Session C-2 |
| DR-DD1C-28 | lazy の panel の chunk を読み込む前、または読込みに失敗した後は、受け口が null になる。その間に受理された送信は、何も示さずに start されない（`Nir1LocalGenerationSlot.tsx`。定数 false の間は無害） | DD-1c-2 の入口（受理を chunk の読込みまで保留するか、読込みの失敗を示す） |
| DR-DD1C-29 | polling の壁時計の上限は、`held` の待ち（DR-DD1C-18）にだけ入れた。通常の running の polling には上限を置かない（Native の transport の上限と K1b で必ず終端する） | 記録 |
| DR-DD1C-30 | Tailwind の任意値の class（`max-w-[calc(100vw-1.5rem)]`、`z-[95]`、`max-h-[70vh]` など）は、定数に関係なく起動時の CSS に入る。実測は起動時 CSS raw 220,859／上限 240,000（base は 220,783） | 記録 |
| DR-DD1C-31 | M4a（終端で handle を捨てない、単独）は等価（lifecycle レビューが確認した）。handle を読むのは `poll`、`cancel`、`loseWithStop` だけで、どれも `terminal()` で止まるか `finish` の前に読む。実装は終端で handle を捨てている。内部の値を出さずに M4a を落とす試験は足していない（turn が `latest` に残るので、変異の下では handle が heap に残るという衛生上の差はある） | 記録 |

### lifecycle matrix に足す列（DR-DD1C-24。現状の記録）

| phase ＼ chat store（capture-only の turn） | `isStreaming` と control | chat の停止 |
|---|---|---|
| R1 受理の待ち | 既存の turn が持つ | capture の取消（既存）。local 生成はまだ無い |
| R2 start の応答待ち | `isStreaming` は true のまま、control は解放されない（推測） | capture の取消を別に呼ぶ。local 生成は止めない（Native の start の記録は残る） |
| R3／R4 polling | 同上 | 同上（local 生成は止まらない。取消は panel の 1 本だけ） |
| R5 終端 | local 生成の終端では解放されない（推測。composer が送信中のまま固まりうる） | — |

### レビューの修正の後の検証

- `pnpm exec tsc --noEmit`：0 件。
- 変更 file の eslint と prettier：0 件。
- `npx vitest run src`：1,587 file、15,763 件 pass（skip 38）。その後に試験 1 件（終端の後の同じ受理）を足し、その file を回して 17 件 pass。
- `pnpm test:browser`：`Nir1LocalDisclosure`、`ProfileEgressStatusIndicator`、`ChatPanel.virtualization`、`layoutInvariants` の 4 file、38 件 pass。
- `pnpm validate:architecture`：23 件 pass、ratchet 不変。
- `impact-map.test.mjs`：37 件 pass。`eval:impact`：Fallback no。`eval:fixtures`：32 件 pass。
- 定数 false の `pnpm build` の後の `pnpm perf:budget`：起動時 JS raw 4,250,973（base と同じ）、gzip 1,343,232、150 chunk。起動時の chunk は DD-1c の chunk・command・文言を参照しない。lazy の chunk は開示 28,680、panel 21,279、ChatPanel 181,630、SettingsDialog 203,746。worktree の `dist/` は、この定数 false の build に置き換えた。

### 変異の再実行（commit の後、原本の copy から戻す）

| 変異 | 結果 |
|---|---|
| 前回の 25 件 | 23 件が落ちた。M4a は等価（DR-DD1C-31）、M7 は修正 6 の後は等価（DR-DD1C-20）。M10 は修正 1 で隠れたので、終端の後の同じ受理の試験を足して落ちるようにした。M25 は store の書き換えに合わせて変異の文を直して落ちた |
| N1 `latest` の置換を戻す | 落ちた（store、panel） |
| N2a 分類を failed に戻す、N2b held を failed と同じに数える、N2c 壁時計の上限を外す、N2d held の cancel を送り直さない、N2e held の start を送り直さない | すべて落ちた |
| N3 setup の `mounted.current = true` を外す | 落ちた |
| N4 項目 4 の文を落とす、N4b 項目 9 の検証の結果の表示を落とす | 落ちた |
| N5 置き場 3 の purpose を外す | 落ちた |
| N6 in flight の continue を待たない | 落ちた |
| N7 serde_json の拒否の写しを外す | 落ちた |
| N8 取消の後の focus の移動を外す | 落ちた |

## 再レビュー（`034904f4..d0d4cd25`）の修正の追記（2026-10-26）

P1 はなし。修正で入った退行 P2 を 1 件と、P3 を直した。

| ID | 判断・訂正 | 状態 |
|---|---|---|
| DR-DD1C-32 | （P2。DR-DD1C-18 の訂正）held の start の送り直しを待つ間に、利用者が取消を押すと、何も送らずに直ちに `cancelled` で終える（timer も消す）。start が in flight の間に押され、応答が held で返った場合も、送り直さずにその場で `cancelled` にする。送り直しの timer の中でも `cancelRequested` を確かめる（防御。前の 2 つが timer を必ず消すので到達しない＝変異 R2 は等価）。それまでは取消が `cancelRequested` を立てるだけで、timer が start を送り直していた。barrier が外れていれば Native の start が通り、request の全体が loopback に書かれてから cancel が飛んでいた（開示の項目 8 に照らした退行）。<br>**送り直しの全数の確認**：(a) start の送り直しは上のとおり直した。(b) continue の送り直しは差分を読むだけで、loopback への送信も capture の記録も増やさない。取消を押した後も、drained まで読む必要がある（DR-DD1B-10）。(c) cancel の送り直しは止める操作だけを送り、`cancelling`（受理済み）と終端では送らない。(d) start の応答が `started` で、in flight の間に取消が押されていた場合の cancel は、start が押される前に Main に届いていたので避けられない（従来どおり） | 実装・試験済み |
| DR-DD1C-33 | （P3）走っていた生成が終端になったら、その会話の通知も消す。held の判定は、invoke が付ける code だけで行う（文の部分一致はやめた。本物の invoke と ipcQueue の barrier を通す試験で、code の経路で held になることを確かめた）。policy の写しの深さの境界（全体で 127 段は許可、128 段は拒否）を試験で固定した。新しい 3 種（`1e400`、単独の surrogate、深さ 128）は、Native の判定ベクトル（`grimodex-core/.../decision_vectors.json`）に足すと lane の外（Rust 側）に触れるので足していない。Rust の側で同じ値の拒否を確かめるのは次の Native の lane に回す。項目 9 の和文の理由の節の重なりを直した。項目 4 には、K5/3:448 の「待ち受けが読めば」、request の骨格と入力の関係、データの範囲の条件を日英で写した。範囲の条件は「編集中・ほかの Scene の原稿。外部送信を制限した状態で画面が読める範囲によっては、会話の履歴、AI audit の記録、版の過去の本文、伏線とプロットの記録なども」とし、K3 の O-2 は利用者向けの語に置き換えた。置き場 5 の要旨は (d) より狭くしない規則（K5/3:441）に従い、条件を付けずに残した | 実装・試験済み |
| DR-DD1C-34 | （記録）`loseWithStop` の best-effort の cancel は、hold が続くと held で捨てられる。Native には「poll されない handle を止める」処理が見当たらず、生成が最後まで走りうる（推測。修正前より悪くはなっていない）。hold が解けた後に停止を一度だけ送り直す案を DD-1c-2 の候補とする。また、continue が返らない場合、DR-DD1C-17 と重なって、その会話は reload まで BUSY のまま残りうる（低確率） | DD-1c-2 の候補 |

### 再レビューの修正の後の検証

- `pnpm exec tsc --noEmit`：0 件。変更 file の eslint／prettier：0 件。
- `npx vitest run src`：1,588 file、15,770 件 pass（skip 38）。
- `pnpm test:browser`：`Nir1LocalDisclosure.browser` 12 件 pass（文言が延びたため取り直した）。
- `pnpm validate:architecture`：23 件 pass、ratchet 不変。`impact-map.test.mjs`：37 件 pass。`eval:impact`：Fallback no。`eval:fixtures`：32 件 pass。
- 定数 false の `pnpm build` の後の `pnpm perf:budget`：起動時 JS raw 4,250,973（base と同じ）、起動時 CSS raw 220,859。起動時の chunk は DD-1c の chunk・command・文言を参照しない。lazy の chunk は開示 29,313、panel 21,425。
- 変異（commit の後、原本の copy から）：
  - R1（待機中の取消で終えない）と R3（held の分岐で取消を見ない）は、単独では最初落ちなかった（後ろの確認が補うため）。「その場で cancelled」の試験を足して落ちた。
  - R2（timer の中の確認を外す）は等価（DR-DD1C-32）。
  - R4（3 か所すべてを外す）、R5（終端で通知を消さない）、R6（held を文の部分一致に戻す）は落ちた。
