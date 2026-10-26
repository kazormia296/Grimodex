# DD-1b の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

lane：DD-1b（DD-1 の Main／IPC の入口。K5/3 `docs/plans/nir1-d2b-local-send-proposal-3-draft.md` の `nir1-local-product-send` と `caller-profile-egress`〔B-1〜B-4〕、K4/3 `nir1-d2b-history-mapping-proposal-3-draft.md` の取消の結束。いずれも Session B1 で確認済み）。base は master `e0eecca7`（DD-1a #727 を含む）。
製品入口（PUB-L）は閉じたまま。この文書は GDX-PRECHECK-001 により、コードを変える前の commit として、影響マトリクス、Main の受付の検査の一覧、owner／lifecycle matrix、threat model、判断を記録する。renderer（DD-1c）、実 Electron の journey（DD-1d）、評価 harness（DD-1e 以降）はこの lane では行わない。

## 範囲（DD-1b が作るもの）

- `electron/shared/ipcContract.ts`：6 command（`nir1_local_generation_start`／`_continue`／`_cancel`、`nir1_local_conversation_create`／`_list`／`_read`）の `NAPI_COMMANDS` の項目、引数の形と上限の Main での再検証、Native の応答の形の検査、Main だけが付ける key 判定の sidecar、`NapiBackendLike` の 7 method（`mainNir1LocalGenerationCancelSender` は Main 専用で `NAPI_COMMANDS` に載せない）。
- `electron/main/profileEgress.ts`：`NIR1_RESTRICTED_ONLY_COMMANDS` に 6 command を置く。
- `electron/main/nir1LocalGeneration.ts`（新）：Main の gate、journey seam（env の parse と Native gate の開放）、sender・window・caller の確認と束縛、sender の destroyed／window の close／caller の交代を `mainNir1LocalGenerationCancelSender` に結ぶこと、handle の起動 sender への束縛、key の判定。
- `electron/main/ipc.ts`：上の module の結線（`registerIpcRouter` の中だけ）。
- 試験：単体（vitest、mock の backend）と、実 router・実 profile gate・実 Native addon を通す pipeline spec（`*.pipeline.spec.ts`）。
- しないこと：`electron/main/index.ts`、`windows.ts`、`rendererContainment*`、NC-1／Y-1 の probe、preload、renderer（`src/`）、Native（`.rs`）、gate の既定値、`PRODUCT_GRAPH_PUBLISHED`／`PROFILE_ACTIVATION_UI_ENABLED`／`NIR1_GRAPH_UI_ENABLED`、Cargo／lock／`package.json`。

## TASK との照合（master `e0eecca7` で確かめ直した事実）

TASK（`dd1-task.md`）は base `bdc892d7` の起案で、行番号は古い。食い違いと確かめたことを記録する。

| TASK の記述 | master の事実 | 扱い |
|---|---|---|
| `profileEgress.ts:252-253` の台帳は空 | 同じ行で空（`[] as const satisfies …`）。`d2aRouteClasses.test.ts:267-283` が空であることを固定している | この試験を 6 件に改める |
| preload は `grim:invoke` 1 本（`ipc.ts:4`） | `electron/preload/index.ts:150-151` の `invoke(cmd, args)` は command を選ばずに `IPC.invoke` へ渡す | preload の変更は要らない（確認済み。推測ではなくなった） |
| `main_open_pre_publication_gate` は `lib.rs:6878-6887` | `lib.rs:6910-6913`。種類 `nir1-local-generation` は DD-1a が足した（`main_grant.rs:179`、:205） | 行番号だけの違い |
| 既存の seam は `index.ts:40-56` で結線 | 同じ（`index.ts:766-800`）。`registerIpcRouter` は `index.ts:802-830` で 1 回だけ呼ばれ、`backend`・`keyStore`（`secrets`）・`profileEgress` を受け取る | seam は `registerIpcRouter` の中で `app` と `process.env` を読んで結線する（U-3 (a)）。`index.ts`／`windows.ts` は編集しない |
| 起動時 JS graph の raw の余裕は 31 byte | 依頼文では上限 4,251,000・現在 4,250,925（余裕 75 byte） | renderer を変えないので触れない |
| 「renderer の関数を実 router・gate・Native に通す spec」 | renderer の wrapper は DD-1c の範囲で、`src/` にはまだない（`aiPathRegistry.test.ts` の走査は `src/` の `invoke("…")` だけを見る） | spec は preload の `invoke` が渡す先と同じ `IPC.invoke` の handler を、renderer の呼出しと同じ引数で呼ぶ。renderer の関数そのものは DD-1c が足し、その spec は DD-1c／d で同じ rig を使う（逸脱として報告） |
| key の判定は endpoint の id ごと（`default` は旧 account を含む） | `aiKeyNaming.ts` の `keyringUserCandidates`／`hasApiKey`、`keyStore.ts` の `SecretsBridge.hasApiKey`。router の `secrets` の型 `SecretsResolver` は `hasApiKey` を持たない（実体の `keyStore` は持つ） | `SecretsResolver` に optional の `hasApiKey` を足す |
| endpoint の id | Native の route 解決（`nir1_prepared_request.rs:1528-1607`）は正規化した設定の `activeOpenaiCompatibleEndpointId` を使う。`getAiSettings`（`lib.rs:15376`）は `read_ai_settings` で同じ正規化をした設定を返す | Main は `getAiSettings()` の `activeOpenaiCompatibleEndpointId` で判定する。違えば Native の D-final が `NIR1_PREPARED_ENDPOINT_ID_MISMATCH` で拒否する（DD-1a の申し送り） |

## 影響マトリクス（refactor-cross-boundaries。実装前）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | 6 command の `NAPI_COMMANDS` | `ipcContract.ts` | 引数は exact key、ID は空でない trim 済み・UTF-8 で 256 bytes 以下・制御文字なし（Native の `wire_id` と同じ）、purpose は `writing`／`review`、handle は 32 桁の小文字 16 進、read の offset は u32、limit は 1〜64。caller identity（Main の sidecar）が無ければ拒否。Native の応答は閉じた status と形だけを通す | Native の 6 `#[napi]` | renderer は route、endpoint、messages、ポリシーの判定、key の判定を渡せない（exact key で拒否） | 既存の command は不変 | `ipcContract` の単体試験（形・上限・応答の検査） | planned |
| B2 | key の判定の sidecar | Main（`nir1LocalGeneration.ts`） | start の直前に Main が `{endpointId, keyVerdict}` を作り、symbol key の非列挙 property で付ける。spec はそれだけを Native の第 2 引数にする | Native の `mainVerdict` | renderer は symbol key を送れない（IPC の structured clone）。値は永続化も log もしない | — | 単体：renderer が同名の文字列 key を送っても使われない、sidecar 無しは拒否 | planned |
| B3 | route 区分 | `profileEgress.ts` | `NIR1_RESTRICTED_ONLY_COMMANDS` に 6 command。unrestricted は拒否、unavailable と activation の途中は拒否、restricted は Main が発行した identity のときだけ通す。完了時の照合（`assertPlaintextPublication` の既存の腕）を通る | router | 台帳は排他（`d2aRouteLedgersForTest`）。`mainNir1LocalGenerationCancelSender` は台帳にも `NAPI_COMMANDS` にも載らない | — | `d2aRouteClasses.test.ts` | planned |
| B4 | Main の gate | `nir1LocalGeneration.ts` | 6 command を、seam が有効で Native gate を開けられた起動でだけ通す。閉じていれば identity の発行・D2a・key store・Native の前に typed に拒否 | router | 既定で閉。開ける入口は起動時の seam だけで、renderer／IPC／設定から開かない | — | 単体と pipeline（seam なしで 6 command が Main と Native の両方で拒否、Native の呼出し 0） | planned |
| B5 | journey seam | `nir1LocalGeneration.ts` | 非 packaged（`isPackaged === false`。packaged なら env を読まない）、`CI=true`、owner token の完全一致、per-launch の UUIDv4 の nonce、`GRIMODEX_USER_DATA_DIR` が今の userData と一致し開発用・製品用の既定のどちらでもない。そのときだけ `mainOpenPrePublicationGate("nir1-local-generation")` を 1 回呼ぶ | Native gate | 置き換えるのは gate の開放だけ（送信先、transport、key の判定、route、AI 使用ポリシー、D2a、監査は変えない） | 他の seam（profile activation、body declaration、maintenance）と独立 | 単体（各条件の欠落で不活性、packaged では env を読まない）、pipeline | planned |
| B6 | sender・window・caller の確認 | `nir1LocalGeneration.ts` | sender が destroyed でない、window があり destroyed でなく、その window 自身の webContents が sender、caller identity が Main の発行したもので `senderId` が sender の id | router | profile activation の Main の検査 1（`profileActivation.ts:288-296`）と同じ型 | — | 単体 | planned |
| B7 | handle の起動 sender への束縛 | `nir1LocalGeneration.ts` | start の応答の handle を（sender の id、window の id、identity）に結び、continue／cancel はその組と一致するときだけ Native へ渡す。上限 64（超えたら古いものから外す）。drained、`HANDLE_NOT_FOUND`、`CALLER_REVOKED`、sender の取消で外す | router | Native の caller の完全一致（DR-DD1A-7）の手前の多層防御。存在を明かさない（Native と同じ `NIR1_LOCAL_HANDLE_NOT_FOUND`） | — | 単体 | planned |
| B8 | sender の destroyed／window の close／caller の交代 → 取消 | `nir1LocalGeneration.ts` | 最初に受け付けた sender に `destroyed`、その window に `closed` の listener を 1 回だけ置き、`mainNir1LocalGenerationCancelSender(senderId)` を呼ぶ。同じ sender の identity が前回と違えば、Native へ渡す前に同じ取消を呼ぶ。profile の状態の変化（`onStatusChange`）でも束縛した全 sender に呼ぶ | Native の `cancel_sender`（取り下げでない停止。capture は変えない） | listener は throw しない（activation の段 2 を失敗させない）。best effort の失敗は renderer へ出さない | — | 単体（fake の sender／window）と pipeline（destroyed で送信が止まる） | planned |
| B9 | 完了時の照合が start の結果を拒否した場合 | router | handle を renderer に返さず、その sender に `mainNir1LocalGenerationCancelSender` を呼ぶ | Native | 公開しない handle の生成を残さない（Related Scenes の解放 DR-DA1-25 と同じ考え方） | — | 単体 | planned |
| B10 | `NapiBackendLike` | `ipcContract.ts` | 7 method を optional で足す（`index.d.ts` と同じ形） | Main | Main 専用の名前は `NAPI_COMMANDS` の本体に現れない（R-2 の試験に足す） | — | `ipcContract.test.ts` | planned |
| B11 | preload／renderer／Native／`index.ts`／`windows.ts` | — | — | — | — | — | — | out of scope（preload は変更不要を確認。renderer は DD-1c） |

## Main の受付の検査の一覧（順。どれも DT-2 の `capture` の前で、拒否は記録に数えない＝押し直せる）

1. Main の gate（B4）。閉じていれば、identity の発行・D2a・key store・Native より前に `NIR1_LOCAL_GATE_CLOSED`。
2. 既存の router の手順：caller identity の発行、D2a の route 判定（`nir1-restricted-only`。unrestricted・unavailable・activation の途中・identity なしは `D2A_EGRESS_DENIED`）。
3. sender・window・caller（B6）。外れれば `NIR1_LOCAL_SENDER_REFUSED`。
4. caller の交代の検出（B8。前回と違う identity なら、その sender の生成を先に止める。拒否ではない）。
5. continue／cancel：handle の束縛（B7）。外れれば `NIR1_LOCAL_HANDLE_NOT_FOUND`。
6. start：key の判定（B2）。endpoint の id を決められなければ `NIR1_LOCAL_ENDPOINT_UNAVAILABLE`。key があれば `present`、key store を読めない・復号できない・判定の窓口がなければ `check-failed` を Native に渡す（Native が検査 4 で typed に拒否。押し直せる）。
7. 引数の形と上限（B1。`NAPI_COMMANDS` の spec）。外れれば `IPC_INVALID_REQUEST` 系の error。
8. 以後は Native（DD-1a の検査の一覧 1〜9 → 記録 → DT-2 の `capture` …）。

## owner／lifecycle matrix（GDX-PRECHECK-001。Main の部分。phase × event。各セルは「結果／終端の書き手」）

DD-1a の matrix（`dd1a-decisions.md` の P2〜P8）は変えない。DD-1b が持つのは Main の受付（DD-1a の P1 行）と、sender の寿命の結線、seam である。

| phase ＼ event | 利用者の取消 | sender destroyed／window close | caller の交代（epoch、workspace の切替、activation） | route 変更・D2a 失効・shutdown | key store の失敗 | crash／再起動 |
|---|---|---|---|---|---|---|
| M0 起動時の seam | — | — | — | — | — | seam は起動ごとに env を 1 回読む。永続しない（Native gate も process 内） |
| M1 Main の受付（上の 1〜7） | handle がないので対象外 | 3 で拒否（押し直せる）／書き手なし | 2 で拒否、または 4 で前の生成を止める | 2 で拒否 | 6 で `check-failed`（Native が拒否）／書き手なし | 状態なし |
| M2 Native の start の間（同期） | 対象外（handle はまだ返っていない） | listener が `cancel_sender`（start が返した後の entry にも、返す前に登録された entry にも届く）。返った handle は B9 で捨てる | 完了時の照合が拒否 → B9 | 同左 | — | Native の matrix（P3〜P5） |
| M3 handle の束縛の間（continue） | cancel は束縛の一致の後に Native へ | listener → `cancel_sender`、束縛を外す | 4 で `cancel_sender`、束縛を外す。Native の continue も登録の再確認で止める（DR-DD1A-7） | Native の transport が witness／permit で止める | — | 束縛は process 内で消える。Native の attempt は sweep |
| M4 終端の後 | Native の規則（DR-DD1A-9、-15） | 束縛を外す | 束縛を外す | — | — | — |

行ごとの補足（iron-laws の列）：

| 行 | entry／admission closure／pending start／active handle／bounded wait／終了の証拠／error・timeout・onClosed／restart |
|---|---|
| M0 | entry は `registerIpcRouter` の 1 回だけ。closure は packaged・env の不一致・Native gate の開放の失敗（そのとき Main の gate も閉じたまま）。pending なし。handle なし。待ちなし。終了の証拠は不要（同期の 1 呼出し）。restart で再評価 |
| M1 | entry は 6 command の invoke。closure は Main の gate、D2a、sender の検査。pending は key 判定の `getAiSettings()`（Native の file 読取 1 回）だけで、Main は lock を持たない。active handle なし。待ちは invoke の await だけ（Main は timer を置かない）。error は typed な値か error envelope で、throw しない |
| M2 | Main は Native の start を await するだけで、取消の手段は sender の listener と B9 の `cancel_sender`（同期の N-API。DB を待たない。DR-DD1A-7） |
| M3 | Main の束縛は Map（上限 64、FIFO で外す）。listener は sender ごとに 1 回、window ごとに 1 回（WeakSet で重複を防ぐ）。listener の中は同期の `cancel_sender` だけで、例外は握って warn する。Main の束縛が外れても Native の entry は Native の保持の規則（60 s）で外れる |
| M4 | Main は終端を書かない（書き手は Native の DT-2／DT-5） |

## threat model（K5/3:238-260 の確認済みの actor・防御・受信先・受入れの範囲内。新しい actor・受信先を足さない）

| 攻撃・actor（K5/3 の In-scope） | DD-1b での防御 | 試験 |
|---|---|---|
| renderer が PUB-L の前にこの route を使う | Main の gate（既定で閉、seam だけが開ける）と Native gate（DD-1a）の二重。Main の gate は D2a と Native より前 | B4 の単体と pipeline、変異 |
| seam の悪用（packaged での有効化、env の部分一致、renderer／IPC／設定からの有効化） | packaged は env を読まずに不活性。全条件の完全一致。seam の状態は `registerIpcRouter` の closure の中だけで、setter を export しない。env は起動時に 1 回読む | B5 の単体、変異（packaged の判定を外す） |
| seam が有効でも別の sender・window が出力を読む／止める | Main の handle の束縛（B7）と Native の caller の完全一致。sender の検査（B6） | B6／B7 の単体、pipeline |
| renderer による route・endpoint・key の判定・messages・purpose の偽造 | exact key の引数、purpose の enum、key の判定は Main の symbol sidecar だけ | B1／B2 の単体 |
| unrestricted の profile での利用 | `nir1-restricted-only` | B3 |
| 生成出力のほかの窓への配信 | event を足さない。continue の応答だけ。Main の束縛 | B7 |
| sender の消滅の後も送信が続く | destroyed／closed で `cancel_sender` | B8 の単体と pipeline |
| 侵害された renderer の可用性の妨害（連打、束縛の枯渇） | 束縛の上限（FIFO）。Native の上限（16）。Out-of-scope の可用性 | B7 の上限の単体 |
| 印の偽造、改名、会話の ID の指定で他の会話を読む | Native（DD-1a）。Main は ID の形だけを確かめる | DD-1a の E2〜E4 |

受信先は設定の loopback の IP literal の port だけ（DT-5）。DD-1b は新しい受信先、保存の範囲、外向きの通信を足さない。pipeline spec の通信は、試験の process の中の loopback の recorder だけ。

## 判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DD1B-1 | 2026-10-26 | DD-1b | module の置き場。Main の gate、seam、sender の束縛、key の判定は新 module `electron/main/nir1LocalGeneration.ts`。`ipc.ts` は `registerIpcRouter` の中で作って呼ぶだけ。seam の起動の値（`isPackaged`、userData、既定の userData、env）は `registerIpcRouter` の末尾の optional 引数で受け、省略時は `electron` の `app` と `process.env` を 1 回読む（読めなければ不活性＝閉）。製品は省略して呼ぶので `index.ts` を変えない（TASK §9 U-3 (a)） | seam の値は Main の起動時の値だけ | `index.ts` に結線（Y-1 の採り直し）。`ipc.ts` に直接書く（2.7k 行の file にさらに足す） | 不要 | 該当なし | M0〜M4 | 記録済み（実装前） |
| DR-DD1B-2 | 2026-10-26 | DD-1b | 引数の形と上限（K5/3 の委任）。start `{purpose, conversationId, sceneId}`、continue／cancel `{handle}`、create `{purpose, sceneId}`、list `{}`、read `{conversationId, offset, limit}`。どれも exact key。ID は Native の `wire_id` と同じ規則（空でない、trim 済み、UTF-8 で 256 bytes 以下、制御文字なし）。handle は `^[0-9a-f]{32}$`（Native の `Uuid::simple`）。offset は 0〜4,294,967,295（u32）、limit は 1〜64。Native の応答は status ごとの exact key と型を確かめ、reason は Native の閉じた code の一覧（`nir1_local_entry.rs` の `Nir1LocalRefusal::code`）か、終端の閉じた語（`^[a-z][a-z0-9-]{0,63}$`）だけを通す。continue の text と thinking は各 64 KiB 以下、create の ID は印の形（`nir1-local-(writing|review)-<uuid>`）で purpose が要求と一致、read の rows は limit 以下 | 平文の面は continue と read だけ（K5/3:578）。Main は形を確かめるだけで内容を変えない | 引数を `payload` で包む（DA-2b の型。renderer の呼出しが冗長になるだけ）。応答を検査しない（Native の変更で平文の面が無言で広がりうる） | 不要 | 該当なし | 不要（同期の検査） | 記録済み（実装前） |
| DR-DD1B-3 | 2026-10-26 | DD-1b | Main の gate の拒否の形。Native の拒否と同じ形の値（`{ok:true, value:{status:"unavailable"|"refused", reason}}`。start は `unavailable`、ほかは `refused`）で返す。reason は Native と同じ `NIR1_LOCAL_GATE_CLOSED`（renderer が層を区別する必要はない。seam は Native gate を開けられたときだけ Main の gate を開けるので、両者は食い違わない）。Main が足す reason は `NIR1_LOCAL_SENDER_REFUSED`（B6）と `NIR1_LOCAL_ENDPOINT_UNAVAILABLE`（key の判定の endpoint を決められない）だけ。D2a の拒否は既存の `D2A_EGRESS_DENIED` の error のまま | renderer に渡すのは閉じた code だけ | error envelope にする（renderer が 2 種類の拒否の形を扱う）。Main 専用の code `…_MAIN_GATE_CLOSED`（層の区別は試験が backend の呼出し数で確かめる） | 不要 | 該当なし | M1 | 記録済み（実装前） |
| DR-DD1B-4 | 2026-10-26 | DD-1b | journey seam の env（K5/3 の委任）。`CI=true`、`GRIMODEX_NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN`＝公開の定数 `dd1b-nir1-local-generation-owner-v1`、`GRIMODEX_NIR1_LOCAL_GENERATION_CI_NONCE`＝UUIDv4、`GRIMODEX_USER_DATA_DIR`＝今の userData（開発用・製品用の既定でない）。版 `NIR1_LOCAL_GENERATION_CI_SEAM_VERSION = 1`。条件は profile activation の seam（DR-DA2-10、R-3、P3-4）と同じ型。packaged の判定を最初に置き、packaged なら env を 1 つも読まない（K5/3 必須防御 17）。有効なら起動時に 1 回 `mainOpenPrePublicationGate("nir1-local-generation")` を呼び、成功したときだけ Main の gate を開ける（失敗は error を log して閉じたまま）。seam を使ったこと（版、env の名前）は DD-1d の journey の receipt に書くので、版と env の名前を export する（Main は log も file も書かない） | seam の runner（env を設定した者）は Trusted actor（K5/3:238）。token と nonce は秘密でない（K3/2 と同じ残余） | 既存の seam の env を共用する（seam ごとに開ける範囲が違うので分ける）。startup の log を出す（K6/3 の stderr の検査と干渉しうる） | 不要 | 該当なし（条件を緩めない） | M0 | 記録済み（実装前） |
| DR-DD1B-5 | 2026-10-26 | DD-1b | key の判定（K5/3 の key の行、DF+ DR-DFP-23）。start のたびに Main が `getAiSettings()` を読み、`activeOpenaiCompatibleEndpointId`（Native の `wire_id` の規則に合う文字列）を endpoint の id とする。無ければ `NIR1_LOCAL_ENDPOINT_UNAVAILABLE`（Native に渡さない。押し直せる）。`secrets.hasApiKey("openai-compatible", endpointId)`（`keyringUserCandidates`。`default` は旧 account の `grimodex-user` を含む）が true なら `present`、false なら `absent`、throw するか窓口が無ければ `check-failed`。結果は symbol key の非列挙 sidecar で spec に渡し、spec はそれだけを Native の `mainVerdict` にする。値は永続化・log しない。present と check-failed も Native に渡し、Native の検査 4 が typed に拒否する（Native を判定の権威に保つ。DD-1a の申し送り） | key の有無の判定は Main（key store を持つ）。endpoint の照合は Native（D-final） | Main で present を先に拒否する（判定が 2 か所に分かれる）。renderer の provider／endpoint の override を受ける（この route は override を持たない） | 不要 | 該当なし | M1 の 6 | 記録済み（実装前） |
| DR-DD1B-6 | 2026-10-26 | DD-1b | sender・window・caller の確認と束縛（K5/3:238「出力を起動した sender に束縛する」、:561、:644）。6 command で profile activation の Main の検査 1 と同じ確認（B6）。最初に受け付けた sender に `once("destroyed")`、その window に `once("closed")` を置き、`mainNir1LocalGenerationCancelSender(sender.id)` に結ぶ（WeakSet で重複を防ぐ）。sender ごとに前回の identity を覚え、違う identity（epoch、workspace の切替、activation による交代）で来たら、Native へ渡す前に同じ取消を呼ぶ。`profileEgress.onStatusChange` の通知でも束縛した全 sender に呼ぶ（listener は throw しない）。start が返した handle を（sender の id、window の id、identity）に結び、continue／cancel はその一致を要する（上限 64、FIFO で外す。drained、`HANDLE_NOT_FOUND`、`CALLER_REVOKED`、sender の取消で外す）。renderer の crash（`render-process-gone`）と再読込は取消に結ばない：K5/3 が挙げる事象でなく、生成は通常の終端で保存され、新しい文書は handle を知らないので出力を読めない（Native の保持 60 s で外れる。レビューの観点として渡す） | sender の同一性は Electron の実 WebContents。renderer の値で束縛を作れない | handle の束縛を Main に置かない（Native だけに頼る。K5/3:238 の Main の責務が空になる）。crash でも取消す（契約より広い停止で、保存されるはずの成功を失う） | 不要 | 該当なし | M1〜M4 | 記録済み（実装前） |
| DR-DD1B-7 | 2026-10-26 | DD-1b | 完了時の照合が start の結果を拒否したとき（D2a の失効や activation が start の間に起きた）、handle を返さず、その sender に `mainNir1LocalGenerationCancelSender` を呼ぶ（best effort）。取り下げでない停止なので capture は current のまま残り、start の記録が押し直しを拒否する（利用者は新しく送る。K5/3:600 の「capture の後に終わった start」に当たる） | 公開しない handle の生成を残さない | 何もしない（handle が誰にも届かず、生成が 60 s の保持まで残る） | 不要 | 該当なし | M2 | 記録済み（実装前） |
| DR-DD1B-8 | 2026-10-26 | DD-1b | 試験の置き場。Main の単体は `nir1LocalGeneration.test.ts`（mock の backend、fake の sender／window）。契約は `ipcContract.test.ts`、区分は `d2aRouteClasses.test.ts`。journey seam は `nir1LocalGeneration.pipeline.spec.ts`（`vitest.electron-native.config.ts` が拾う。実 addon が要る）：seam なしで 6 command が Main で拒否され Native gate も閉じていること、seam ありで restricted にして create→capture→start→continue→read が実 Native を通ること、unrestricted と別 sender の拒否、sender の destroyed で送信が止まること。recorder は試験の process の中の loopback の HTTP server（DD-1d の「製品の process の外」の recorder は実 Electron の journey の要件で、この spec は node の試験） | 試験だけ | spec を DD-1d に回す（DD-1b の行が求める seam の spec が無くなる） | 不要 | 該当なし | 不要 | 記録済み（実装前） |

## 確かめられなかったこと（実装前の時点）

- 実 Electron での seam の起動（DD-1d）、Windows／macOS、実 local server／model（U-1）。
- `BrowserWindow.fromWebContents` と `win.webContents === sender` の関係を実 Electron で確かめていない（製品は webview／BrowserView を使わない見込み。推測）。
