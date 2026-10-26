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
