# NIR-1 D2b local 生成の送信 proposal/2（draft）: 送信先・wire・監査・同意

Status: draft／未確認。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない

| 項目 | 値 |
| ---- | -- |
| draftRef | `nir1-d2b-local-send-proposal/2` |
| contractId | `nir1-local-product-send`（新規） |
| 起案日と基点 | 2026-10-12 に起案し、2026-10-13 に改訂した（K1 の確認と SPIKE S1 の報告を反映。下の「前提の更新」。あわせて、既存のコードの事実 S17〜S20 への防御、journey seam、IPC の command の識別子、recorder の置き場、dialog での model の名前の置き方、利用者の操作によらない同意の要求への防御、restricted 下でこの route の会話の平文を返す読取面の範囲と、その「この route の会話」の session と行の単位の定義を加え、監査の start を durable にする時点を「接続の前」にそろえた）。origin/master `a153743b`（Tree `023f6fbc`）。`l6-l9:N`、`post-B:N`、コードの行番号はこの commit のもの。`DSN §N` は同じ worktree にある未 commit の版（sha256 `3dfe1f03…`）の節 |
| 確認済み baseline | `nir1-l6-l9-contract-proposal/3` の `caller-profile-egress`、`native-generation-receipt`、`history-reauthorization`（l6-l9:98、101、102）。iron-laws の GDX-ROUTE-001、GDX-AI-AUDIT-001、GDX-AI-CONSENT-001 の現行の文言 |
| 前の版 | `nir1-d2b-local-send-proposal/1`（2026-09-25、contractId `nir1-d2b-local-product-send/1`）。台帳に記録がなく、U1 により文面も確認の記録も使わない（下の「/1 との関係」） |
| 確認を求めるもの | local 生成の送信先（`127.0.0.1`／`[::1]` の OpenAI 互換 `POST /v1/chat/completions`）、wire（SSE）と終端の規則、client の規則、purpose、監査（full-observable。renderer の汎用の append からこの route の path と ID を外すこと）、route の登録、同意（GDX-AI-CONSENT-001 の Electron への適用と policy の改訂。model を含む identity、dialog に出す model の名前の規則と置き方、利用者の操作によらない同意の要求への防御）、D-final の追補の範囲、transport の実装方針、生成出力の配信先、IPC の command の識別子と役割（K3 の D-dispatch 行）、PUB-L の前の journey seam。IPC の command には、restricted 下で renderer に平文を返す読取面を、この route の会話に限って加えることを含む（生成出力の差分を返す `nir1_local_generation_continue` と、会話の利用者の入力と生成出力を返す `nir1_local_conversation_read`。K3 が O-2 として別の draftRef に回した、restricted 下での非 NIR の自分のデータの表示とは別の面で、O-2 の確認の有無に依らない。「IPC の command」）。「この route の会話」の範囲は session と行の2段で定める。session は `nir1_local_conversation_create` が作った会話だけで、返す行は、その中の #611 の capture が受理した利用者の入力と、この route の attempt の成功の出力だけである。生成の開始も同じ定義を使う（「この route の会話の範囲」） |
| 関係する確認 | 数値の決め方は K1b（`nir1-defensive-resource-limits`）による。K1b は 2026-10-12 に確認済み（下の「前提の更新」）。restricted 下の区分は K3、履歴の入力は K4、最終 request の評価は K6 で、どれもこの行の確認では確認されない |
| 変えないもの | proposal/3 の各行（この行はその具体化）、5 行の terminal matrix、D2a の profile-wide gate、Packing の公開条件（l6-l9:432）、P と Gold、A-1（PUB-L まで製品入口は閉じたまま。非 packaged の build だけで働く journey seam は製品入口にあたらない。必須防御の 17）。外部 model、補助 AI、旧送信経路は停止のまま |

略記:

- `prep.rs` = `electron/native/grimodex-node/src/nir1_prepared_request.rs`（D-final）
- `gen.rs` = `electron/native/grimodex-node/src/nir1_generation.rs`、`gendb.rs` = `src-tauri/crates/grimodex-db/src/nir1_generation.rs`
- `receipt.rs` = `src-tauri/crates/grimodex-core/src/narrative_nir1_receipt.rs`、`audit.rs` = `src-tauri/crates/grimodex-db/src/ai_audit.rs`
- `pe.ts` = `electron/main/profileEgress.ts`、`pe.rs` = `electron/native/grimodex-node/src/profile_egress.rs`
- `ai.rs` = `src-tauri/crates/grimodex-ai/src/lib.rs`、`registry.ts` = `src/features/ai-verification/aiPathRegistry.ts`
- `iron-laws` = `policies/quality/iron-laws.md`、`AI経路検証` = `docs/AI経路検証.md`
- `l6-l9` = [L6〜L9 実行計画](nir1-l6-l9-execution-plan.md)、`post-B` = [残工程実装計画](nir1-post-b-execution-plan.md)、`DSN` = [DSN](nir1-dsn-2026-10.md)

この文書で「送信」は、HTTP の request の最初の byte を socket に書くことを指す。それより前に止まった場合を「送信 0」と呼ぶ。

## 要点

- 送信先は、利用者が設定した OpenAI 互換 server の `POST /v1/chat/completions` だけにする。base URL は `http://127.0.0.1:<port>/v1` か `http://[::1]:<port>/v1` に限り、host 名（`localhost` を含む）、`127.0.0.1` 以外の address、LAN、TLS、ほかの path や API は使わない。名前解決をせず、設定の IP literal と port に直接つなぐ。その port で待ち受けているプログラムが何かは確かめられないので、同意の開示で扱う。
- client は依存を追加しない std の HTTP/1.1 で作り、proxy、redirect、自動の再送、認証 header を使わない。endpoint に key が設定されていれば、その route は unavailable にする。
- wire は SSE（`stream: true`）を推奨する。成功は、`finish_reason` が `stop` の event を1回観測し、続いて `data: [DONE]` を1回観測し、その後に body が終わった場合だけとする。それ以外は失敗にし、non-stream の応答へも fallback しない。non-stream を選ぶなら DG-4 の受入れを変える必要があり、別の draftRef で確認し直す。Ollama の native API は後続に回す。
- purpose は、利用者の明示の操作で始める Writing と Review だけにする。
- 監査は GDX-AI-AUDIT-001 の full-observable とし、接続の前に `execution.started`、`request.prepared`、`request.dispatched` を同じ batch で durable に記録する。route は GDX-ROUTE-001 に登録する。renderer は restricted 下でも既存の汎用の append で監査に書けるので（S17）、この route の path と ID の namespace は Native の owner だけが書けるようにする。
- GDX-AI-CONSENT-001 を Electron のこの local socket route（loopback の TCP socket）にも適用し、policy を改訂する。同意は Main の dialog で取り、policy の版、route、provider、送信先の socket、model に束縛する。model を identity に入れるのは、同じ socket でも model によって外部で処理する server があり、renderer は restricted 下でも設定の model を書き換えられるためである。同じ socket で別のプログラムが待ち受ける（listener の置換）残余リスクは防げないので、開示する。dialog に出す model の名前は、1〜256 bytes の ASCII の印字可能な文字のうち、空白、引用符（`"`、`'`、バッククォート）、`\` を除いたものに限り、合わなければこの route を unavailable にする。dialog では、名前をラベルの付いた専用の行に、名前に使えない文字で区切って置く（S18）。renderer は利用者の操作なしに同意の要求を出せるので、dialog の既定のボタンは取消にし、承認には確認の checkbox を要する。読まずに承認されることは残余として受け入れる。
- この route の会話は restricted 下でも表示できるようにする。renderer に平文を返すのは、起動した sender への生成出力の差分と、この route の会話の読取だけで、ほかの会話と監査の記録の表示（K3 の draft の O-2 の範囲）は開かない。「この route の会話」は、`nir1_local_conversation_create` が作った会話（session）の中の、#611 の capture が受理した利用者の入力と、この route の attempt の成功の出力（行）に限る。restricted になる前の会話やほかの chat の会話は、後から capture や attempt を持っても、この route の会話にならず、そこでの生成の開始も拒否する。capture の入口は restricted 下でもそうした会話を受け付けるので（S20）、この区別は生成の開始と読取の側で行う。
- 数値の上限は、確認済みの K1b の規則に従って integrator が実測から決める。製品での公開は PUB-L（Session C-2）で別に承認を得る。
- PUB-L の前の実 Electron の journey は、非 packaged の build で exact な env があるときだけ有効な seam で通す。seam が置き換えるのは、この route の command の gate と、同意の dialog の応答だけである（K3 の draft の journey seam と同じ型）。

## 確認の扱い

- 確認は末尾の「確認文」の 1 文で行う（l6-l9:108）。確認されるのはこの contractId の行だけで、関係する K3、K4、K6 は確認されない。K1b はすでに確認されており（下の「前提の更新」）、この行はその規則を使うだけで変えない。
- 計画への同意、merge の指示、構造化質問への回答、「この提案でよい」のような包括的な返答は、確認として扱わない。
- この行を確認しても、製品での送信は始まらない。PUB-L の承認（Session C-2。同意の文言と listener の置換の開示を含む）と、Packing の公開条件（C + D1 + D2a + D2b-1 + D2b-2、l6-l9:432）が別に要る。`caller-profile-egress` の「D2b-2は別の明示確認があるまで新transportを公開しない」（l6-l9:124）のうち、この行が満たすのは threat model の確認だけで、公開の承認は PUB-L で行う。
- 確認文が確認するのは、この draft の推奨（SSE、Ollama は後続、model を含む同意の identity、model の名前の規則と dialog での置き方、監査の書込みの閉じ方、key の判定の窓の扱い、同意の確認の UI、利用者の操作によらない同意の要求への防御、この route の会話の読取面とその識別、journey seam の条件など。「選択肢と推奨」の表）である。推奨と違う選択肢（non-stream、Ollama の同時採用、model を identity から外すこと、非 ASCII の model の名前を許すこと、確認の checkbox を省くこと、会話の読取面を別の draftRef に回すこと、この route の会話の印を新しい schema に置くことなど）を採るときは、その内容で新しい draftRef を起案して確認する。
- 確認された行は、この draft の bytes の SHA-256 と確認文を台帳に記録する。本文は編集せず、内容を変えるときは新しい draftRef で起案する。

## 根拠: ユーザー決定（逐語）

2026-10-12 のセッションでの回答から、ユーザー自身の文言を写す。「論点」は問いの主題を起案者が要約したもの、「読み方」は起案者の解釈で、どちらもユーザーの発言ではない。

| ID | 論点 | 回答（逐語） | 読み方 |
| -- | ---- | ------------ | ------ |
| U1 | 2026-09-25/26 の承認と WIP | 「使わずに計画し直す」 | /1 の文面と、その確認の記録を使わない。a153743b を前提に起案し直し、/1 は論点の参照にとどめる |
| U3 | precheck の運用（「1」は #610 型の技術委任を NIR-1 の残レーン全体へ広げる案） | 「1でRalphを使ってやるかどうかは任せます。」 | 技術判断は委任で進めてよい。ただし新しい送信先、保存範囲の拡大、新しい authority（ここでは同意の適用）は委任の外（続行計画の「委任の記録」）なので、この draft で確認を求める |
| U4 | 到達点 | 「merge まで進める」 | 実装は merge まで進める。製品での公開（PUB-L）は、続行計画の停止点どおり Session C-2 で別に承認を得る |
| U6 | 資源契約（制限の理由の説明を受けた後） | 「防御用の上限だけに簡素化（推奨）」 | transport の期限と bytes の上限は、K1b の規則（有限、取消できる、allocation の前に検査、fail-safe）で決める。K1b はこの決定を具体化した行で、2026-10-12 に確認された |

## /1 との関係（U1）

- `nir1-d2b-local-send-proposal/1`（2026-09-25、sha256 `6294ff05…`）と、それを確認したとする記録は、Codex の worktree の未追跡 file にしかなく、台帳（l6-l9:95-102）に載っていない。U1 により、この draft は /1 の文面を引き継がず、/1 の確認を根拠にもしない。
- contractId を `nir1-local-product-send` に改めるのは、/1 の確認を引き継がないことを台帳の上で区別するためである。
- /1 から論点として参照し、判断を変えたもの:
  - Ollama の native API：/1 は OpenAI 互換と並べて対象にした。この draft は OpenAI 互換の SSE だけにし、Ollama は後続にする。
  - 送信先での保存や学習を確かめられない場合：/1 はそれを送信 0 の理由にした。この draft は、Web Editor の現行の開示（学習の扱いを `depends` とする。下の S10）と同じく「送信先の運用による」と開示し、それ自体を拒否の理由にはしない。処理者を示せない場合は拒否のまま。
  - 監査と route の登録：/1 は扱っていない。この draft は GDX-AI-AUDIT-001 の full-observable と GDX-ROUTE-001 の登録を必須にする。
  - #611 の D-final（/1 の後に merge）との食い違い（`localhost` の許可、`stream` のない payload、Writing だけ。下の S2〜S4）：この draft は D-final の追補（DF+-b）で直す範囲を定める。

## 前提の更新（2026-10-13）

- K1 の確認：2026-10-12T23:58 JST に、ユーザーが `nir1-l6-l9-contract-proposal/6` の2行（`graph-limited-binding` と `nir1-defensive-resource-limits`）を確認した。対象は branch `claude/nir1-contracts` の commit `ba7ceb46` にある [K1 の draft](nir1-l6-l9-contract-proposal-6-draft.md)（sha256 `5528f4e0…`）である。台帳への記録は integrator が行う（G0）。
  - この draft で K1b と呼ぶのは `nir1-defensive-resource-limits` である。この行で置く期限と bytes の上限（「数値」の節）は、K1b の規則 1〜8 と、K1b の対象の表の「local transport」と「barrier の待機」の行（どちらも D-transport）に従う。integrator が実測から選んで PR と作業記録に残し、数値ごとの確認は求めない。厳しくするのは、その lane の正例の受入れを保つ範囲で確認なしに行え、merge の後に緩めるには再確認を要する（K1b の規則 6、7）。
  - K1b が決めるのは「どれだけ読む・待つ・保持するか」だけで、送信先、同意、開示、保存範囲は決めない（K1 の draft の Delta）。それらはこの行で確認する。
- S1 の報告（SPIKE S1。G-01 の非 Graph 部分を実 runtime で確かめた診断。2026-10-13、integrator の作業記録）：AI provider への送信を伴わず（S1 の報告の K5 の項）、この行の判断を変える観測はない。関係するのは journey の provider の事実だけである。
  - 既存の決定論 Journey provider は、未 packaged の build で env の値が一致するときだけ、Main の provider edge を置き換える（`electron/main/productJourneyAi.ts:74-91`）。その NIR-1 の応答は、24 件の corpus の本文と一致する場面にしか返らない（`electron/main/productJourneyNir1Ai.ts:1`、:40-41）。S1 は G-01 の setup のために、build の時に対応表を差し替えた。
  - この route の journey は、この provider を使わず、loopback で待ち受ける HTTP の recorder を使う（必須防御の 16）。provider で transport を置き換えると、client、framing、終端の規則を試せないためである。既存の seam は provider の edge だけを置き換え、PUB-L の前の入口と同意の dialog は置き換えない（S19）ので、この行で journey seam を定める（必須防御の 17）。
  - ほかの観測（G-01 の IR が実 runtime では floor 未満で空だったこと、B の sealed binding を publish する製品の経路がないこと）は、この行の送信先、wire、監査、同意を変えない。開示の 1 の「承認済みの IR、Graph の Evidence」は送りうるものの種類で、Graph の Evidence が request に入るのは Graph の公開（PUB-G。B の publish の経路は B-ROUTE で置く）の後だけである。
  - S1 が見つけた別の外向きの通信（model の on-demand download と、Chromium の spellchecker の辞書の取得。どちらも原稿を含まない）は、この route の送信ではない。restricted 下での扱いは K3 で決め、この行の同意と開示の対象にしない。

## 現状（a153743b）

| # | 事実 | 根拠 |
| - | ---- | ---- |
| S1 | 製品の送信経路はない。transport は試験専用の framed loopback（127.0.0.1、HTTP なし）だけ | gen.rs:1-5、:1211-1218 |
| S2 | D-final の route は OpenAI 互換の active endpoint だけで、base URL は `http://<host>:<port>/v1`。host は `localhost`、127/8 全体、`::1` を許す。port は `u16` の解析なので `+1234` や `01234` も通り、`[0:0:0:0:0:0:0:1]` も通る（コードと Rust の解析の挙動からの推定。関数そのものの試験は未実行）。試験は `http://localhost:1234/v1` を許すと固定している | prep.rs:872-950、:960-1001、:6075-6094 |
| S3 | payload は `model`、`messages`（system と user）、`max_tokens` の3つで、`stream` がない。試験もキー数 3 を断言する。payload digest は canonical JSON に domain を付けた digest で、attempt に束縛される | prep.rs:1210-1217、:2125-2128、gen.rs:846-851 |
| S4 | purpose は Writing に固定。DB の型は Writing と Review を持つ | prep.rs:573、gendb.rs:117-120 |
| S5 | route revision は AI 設定全体の digest で、設定のどこが変わっても route の変更になる | prep.rs:938 |
| S6 | OpenAI 互換の key は Main の key store に endpoint ごとにある。key は endpoint 固有の account から引き、id が `default` の endpoint では旧 account の `grimodex-user` にも fallback する（有無の判定の `hasApiKey` も同じ）。既存の provider client は key があれば `Authorization` を付ける。D-final は key の有無を見ない | `electron/main/aiKeyNaming.ts:53`、:65-78、:132-138、ai.rs:3757-3764 |
| S7 | 既存の provider client は `reqwest::Client::new()`（proxy と redirect は既定のまま）、429 の再送の helper、読めない event を読み飛ばして `[DONE]` だけで終端とみなす SSE の処理を持つ | ai.rs:2728、:2363-2397、:5018-5027 |
| S8 | 出力の観測は OutputObserver（text と thinking を分けた digest）と 5 行の terminal matrix。NIR-1 の保存先は成功のときだけ本文を書き、text と thinking はそれぞれ 2 MiB まで | receipt.rs:78-91、:118-223、gendb.rs:40、:3123-3132 |
| S9 | 監査の台帳は workspace の DB の `ai_audit_events`（hash chain、append-only、Scene の削除や restore で消えない）。NIR-1 の local 生成の path は `AI_PATHS` にない。restricted 下では監査の読取が plaintext-publication として拒否される。書込みは拒否されない（S17） | audit.rs:1-6、:26-42、registry.ts:515、pe.ts:99-100 |
| S10 | GDX-AI-CONSENT-001 は Web Editor の Local LLM と BYOK だけが対象で、同意の route の型は `byok` だけ。Web Editor の OpenAI 互換と Ollama の開示は、学習の扱いを `depends` としている | iron-laws:127-138、`src/features/ai-policy/aiDataConsent.ts:1`、`src/features/ai-policy/browserAiDisclosure.ts:149-177`、:248-273 |
| S11 | D2a の restricted 下では旧送信経路と `chat:stream-*` の event を拒否する。D-final の準備は restricted かつ in-flight の停止済みを要する | pe.ts:70-72、:768-779、pe.rs:442-467 |
| S12 | renderer の capture の判定は `localhost` と 127/8 を loopback とみなす | `src/application/chat/chatTurnLifecycle.ts:103-120` |
| S13 | プライバシー通知は Electron 版の保存を SQLite とし、同意の記録は Web Editor の Local Storage だけを記す | `public/PRIVACY_ja.md:16-21`、:81-93 |
| S14 | `save_ai_settings`、`save_api_key`、`delete_api_key` は internal の command で、restricted 下でも renderer から呼べる。設定の書込みは Native の `with_route_update` の中で permit を revoke してから file を書く。key の保存と削除は Main だけの処理（safeStorage と `ai-keys.json`）で、Native の permit を revoke しない | pe.ts:155、:205、:334-335、:525、:700-711、`electron/native/grimodex-node/src/lib.rs:14643-14654`、pe.rs:567-585、`electron/main/keyStore.ts:367-392` |
| S15 | 監査の validator は、execution を `execution.started` から始めさせ、`request.dispatched` の前に `request.prepared` を、`response.partial`・`response.completed`・`execution.succeeded` の前に `request.dispatched` を、`execution.succeeded` の前に `response.completed` を求める。`execution.failed` と `execution.cancelled` には前提がなく、終端の後の event は拒否する。native の dispatch の前提は started、prepared、dispatched の3件がこの順にあること。`request.dispatched` は選んだ transport への dispatch の記録で、HTTP の送信の証拠ではない | audit.rs:1011-1099、:1132-1148、:1463-1514、`src/features/ai-audit/exportBundle.ts:815` |
| S16 | 監査の公開の append は、期限なしで DB の mutex を待つ `with_conn` を通り、その中で自前の `BEGIN IMMEDIATE` と 5 s の busy timeout を使う。transaction の中で append する関数は module の外から呼べない | audit.rs:20、:1101、:1202-1223、:1728-1734 |
| S17 | restricted 下でも、renderer は `ai_audit_append_batch`（internal）で `ai_audit_events` に書ける。Main の検証は event の型、payload の形、`request.prepared` の `credentialsExcluded` を確かめるが、pathId、eventId、executionId、operationId の値は制限しない。Native は workspace を確かめてから汎用の append を呼ぶ。append は、ID が空でないこと、event の型、payload の形と credential、eventId の衝突、同じ execution の path・operation・parent の一致、終端の後の拒否、順序を確かめるが、path ID と各 ID の値がどの owner のものかは確かめない。そのため renderer は、どの path ID の execution でも、Native が書く execution と同じ DB の同じ chain に書ける。Native の execution と同じ executionId・operationId・parentExecutionId・pathId を渡せば終端を差し込め、Native より先に同じ executionId や eventId を使えば Native の書込みを失敗させられる。raw SQL での `ai_audit_events` の変更は拒否される。既存の Native の writer（post-effect、semantic）と Main（Codex の監査）も同じ汎用の append を使う | pe.ts:183、:525、`electron/shared/ipcContract.ts:2772-2865`、:7773-7786、`electron/native/grimodex-node/src/lib.rs:10951-10968`、audit.rs:778-791、:1111-1148、:1202-1223、:1724-1734、`src-tauri/crates/grimodex-db/src/execute.rs:310-320`、`electron/main/index.ts:447-451`、`src-tauri/crates/grimodex-post-effect/src/audit.rs:19-22`、`src-tauri/crates/grimodex-semantic/src/audit.rs:135-142` |
| S18 | `AiSettings.model` は検証のない文字列である。`save_ai_settings` は Main でも Native でも値を検査せずに書き、renderer は restricted 下でもこれを呼べる（S14）。D-final は、空でなく前後に空白がないことだけを確かめる。内部の改行、制御文字、双方向の制御文字、長さには制限がない | ai.rs:348-350、:1185-1191、`electron/shared/ipcContract.ts:9922-9930`、`electron/native/grimodex-node/src/lib.rs:14643-14654`、prep.rs:893-897 |
| S19 | 既存の journey seam は、非 packaged の build で exact な env の値があるときだけ有効になり、Main の provider の edge だけを決定論の応答に置き換える。Main の確認の dialog は `dialog.showMessageBox` を直接呼び、それを置き換える seam はない。DSN §7 の grant にも seam はない | `electron/main/productJourneyAi.ts:74-91`、`electron/main/index.ts:251-254`、:311、:344、:459 |
| S20 | capture の入口 `capture_current_chat_input` は internal で、restricted 下でも renderer から呼べる（Native は restricted、in-flight の停止済み、登録済みの caller を要する）。capture の writer は、Scene に束縛された `chat_sessions` の行ならどれでも受け付け（restricted になる前からある通常の chat の会話を含む）、その会話に新しい user の行、human の message version、capture の行を作る。受理した capability は Native の中にとどまり、N-API の応答では捨てる。`chat_sessions` には、どの経路が作った会話かを示す列がない。`chat_sessions` と `chat_messages` は D2a の保護表で、restricted 下では renderer の汎用 SQL で読み書きできないが、unrestricted の間は書ける。一方、`nir1_chat_input_captures`、`nir1_generation_message_versions`、`nir1_generation_attempts` は protected writer の表で、renderer の汎用 SQL は profile の状態に依らず書けず、既存の chat の行は昇格も backfill もされない。message version の digest は role、本文、thinking、作成時刻を含み、reader は失効した version と digest の不一致を拒否する。成功の終端は、attempt の session に assistant の行と、その attempt を親とする generated の version を書く。`bind_human_message` は capture なしで user の行に human の version を付ける公開の関数で、a153743b では試験だけが呼ぶ | pe.ts:187、prep.rs:614-663、pe.rs:442-467、gendb.rs:2293-2338、:2524-2657、:2071-2112、:1935-2000、:3198-3217、:2235-2270、`src-tauri/crates/grimodex-db/src/migrate.rs:768-779`、:2260-2281、:4128-4140、:4171-4198、`src-tauri/crates/grimodex-db/src/profile_egress_policy.rs:19-104`、`src-tauri/crates/grimodex-db/src/execute.rs:205-284`、:409-454、:629-631、`policies/narrative/protected-writers.json:2-43` |

## nir1-local-product-send（新規）

- Baseline (approved; limited): 確認済みの `nir1-l6-l9-contract-proposal/3` の3行。`caller-profile-egress`（l6-l9:121-130）は、main が発行する caller、profile-wide の local-only gate、旧送信経路の停止を定め、新しい transport は別の明示確認まで公開しないとし（:124）、将来の local transport に exact な endpoint、proxy と redirect の禁止、独立した handle の確認を求める（:129）。`native-generation-receipt`（:215-224）は、handle、5 行の terminal matrix、text と thinking の digest、receipt に本文を重ねて保存しないこと、credential と raw URL を含まない endpoint identity を定める。`history-reauthorization`（:226-235）は、次の turn での再利用に毎 turn の再認可を求める。計画の前提として、post-B §9（送信の順序と terminal）と §11（対応済みの local HTTP の本文と review だけを公開し、`localhost` という文字列で local と認めない。post-B:328）を使う。iron-laws の GDX-ROUTE-001（:7-11）と GDX-AI-AUDIT-001（:13-55）は全 production route に適用され、GDX-AI-CONSENT-001（:127-138）は Web Editor の Local LLM と BYOK だけを対象にする。local 生成の送信先、wire、Electron での同意について確認済みの行はない。/1 は U1 により baseline に含めない。
- Delta (L6-L9 local send destination / wire / audit / consent; proposal/2 draft): NIR-1 の local 生成に送信先を1種類だけ加える。利用者が設定した OpenAI 互換 server の `POST /v1/chat/completions` で、送信先は `127.0.0.1` か `[::1]` の IP literal と有効な port に限る。wire は SSE で、終端の規則は厳格にする。client は依存を追加しない std の HTTP/1.1。purpose は manual の Writing と Review。監査は full-observable で、route を登録し、GDX-AI-CONSENT-001 を Electron のこの route に広げる（policy の改訂。同意は model を含む identity に束縛する）。同意の記録とその照合を新しく置く（GDX-AI-CONSENT-001 の適用で、それ以外の authority と schema は加えない）。D-final の追補（DF+-b）で、`localhost` の拒否、`stream: true`、Review、key の有無の確認、model の名前の規則を入れる。renderer の汎用の監査の append から、この route の path と ID の namespace を外す（S17）。DD-1 の IPC の command の識別子と役割を定める（K3 の D-dispatch 行。restricted 下で renderer にこの route の会話の平文を返す読取面を含む）。「この route の会話」を session（`nir1_local_conversation_create` が作った会話）と行（#611 の capture が受理した利用者の入力と、この route の attempt の成功の出力）の2段で定め、生成の開始と会話の読取に同じ定義を使う（S20。既存の capture の入口は変えない）。同意の dialog は、名前をラベルの付いた専用の行に区切って置き、既定のボタンを取消にし、承認に確認の checkbox を要する。PUB-L の前の journey 用に、非 packaged の build だけで働く journey seam を定める。数値の上限は確認済みの K1b に従う。製品の公開は PUB-L で別に承認を得る。proposal/3 の3行の保護はそのまま保ち、この行はその具体化と上の追加だけを行う。詳細は下の節のとおり。
- Trusted actors: Electron main（実 IPC sender から caller を発行し、typed な intent を検証する。key store を持ち、生成の開始の command を受けた時に route の endpoint に key があるかを判定して Native へ渡す。同意の dialog を出し、出力を起動した sender に束縛する）、Native（D2a の profile gate、route の解決、D-final、DT-1 の gate と lease、DT-2 の attempt と claim の owner、transport の owner と parser、監査と同意の writer）、grimodex-db の writer（attempt、終端、本文、`ai_audit_events`）、Main の dialog での利用者の明示の同意（journey seam が有効な非 packaged の起動では、その env を設定した journey の runner を、dialog を確定する利用者の代わりとみなす。必須防御の 17。packaged build にはない）。生成の開始と取消の要求は renderer の typed IPC から来るので、ここには含めない（In-scope attacks の「renderer が利用者の操作なしに生成を始めること」）。
- Untrusted actors: renderer（生成の開始と取消の要求、messages、route、endpoint、provider、model、purpose、flag、同意の主張と同意の要求（利用者の操作によるとは限らない）、会話の作成・一覧・読取の要求と会話の ID、生成の開始に渡す会話と `capture_current_chat_input` に渡す session（restricted になる前の会話やほかの chat の会話でありうる。S20）、recorder の選択、出力の受け取り先、監査の event（restricted 下でも汎用の append で書ける。S17））、socket で待ち受けているプログラムとその応答（status、header、framing、SSE の event と field、速さ、長さ、自称する provider と model）、同じ端末のほかのプロセス（同じ port で待ち受けうる）、環境変数と OS の proxy 設定、`ai-settings.json` の内容（利用者の設定として使うが、renderer も restricted 下で `save_ai_settings` によって書き換えられる（S14）。model の名前の文字と長さを含めて毎回検証し（S18）、同意の identity と照合し、設定だけでは送信を認めない）、model の出力、古い handle・permit・grant・同意の記録、再起動の時に残った未終端の attempt、unrestricted の間（activation の前と、K3 の draft の F-1 で戻った後）に renderer の汎用 SQL や旧経路が書いた `chat_sessions` と `chat_messages` の行（この route の会話の印の偽造を含む。S20）。
- In-scope attacks: host 名や名前解決（hosts file を含む）による別の address への送信、`127.0.0.1` 以外の 127/8・IPv4-mapped の IPv6・zone 付き・別表記の address、proxy の環境変数や OS の設定による迂回、redirect による別の host・port・path への送信、429・5xx・接続の切断・期限切れの後の自動の再送、`Authorization`・API key・cookie・URL の credential の送出、renderer による route・endpoint・messages・purpose・同意の偽造や試験用 recorder の選択、renderer が利用者の操作なしに生成を始めること（Main と Native は開始が利用者の操作によるかを確かめられないので、防ぐのは送り先と内容の範囲までとする。送り先は同意済みの loopback の socket と model、profile は restricted、purpose は Main が検証した typed な intent の Writing か Review、request は D-final が組んだものに限る。侵害された renderer がこの範囲で送らせることは、残余として受け入れる）、renderer が `save_ai_settings`（S14）で model・endpoint・provider を書き換えてから生成を始めること（例：同じ socket のまま、外部で処理される cloud の model に切り替える。model も同意の identity に入れるので、書き換えた時点で同意の記録が消え、Main の dialog で新しい同意を得るまで送信 0。model を identity に入れない対案では、この切替は防げない。「選択肢と推奨」）、同意のない送信と、socket・provider・model・route・policy の版が変わった後の古い同意での送信、renderer が描いた偽の同意画面、renderer が利用者の操作なしに同意の要求（`nir1_local_send_consent_request`）を繰り返して Main の dialog を出させ、読まずに承認させること（防ぐのは、dialog が同時に1件で、display が Native の項目だけで、既定のボタンが取消で、承認に確認の checkbox を要するところまでとする。利用者が読まずに checkbox と承認を選ぶことは残余として受け入れる。同意の後に renderer が利用者の操作なしに生成を始めることも上の残余なので、催促から送信までの連鎖も残余になり、送り先と内容の範囲は上と同じである）、model の名前を介した開示の注入と押し出し（renderer が `save_ai_settings` で、改行・制御文字・双方向の制御文字・区切りの文字（引用符など）を含む model の名前や巨大な名前を書き、Main の dialog で名前の外に見える偽の開示を出すことや、本物の開示を可視領域の外へ押し出すこと。名前の文字列そのものが誤解を招く語（例：`local-only`）を含むことは防がず、開示の 5 で扱う。S18）、処理者を実際と違うものとして示すこと（listener の置換を防げると示すことを含む）、壊れた応答や悪意ある応答（巨大な header・event・body、遅い送出、終わらない stream、不正な UTF-8 や JSON、終端の偽装・重複・欠落、終端の後の data、`tool_calls` などの混入、複数の choice、圧縮、framing の曖昧さ、200 以外の status、non-stream の応答への fallback）、text と thinking の混同、同じ attempt の二重の送信と crash の後の再送、取消と送信の開始の競合、送信中の workspace の切替・shutdown・D2a の失効・route の変更・同意の撤回、HTTP を待つ間の lock の保持による transition の停止、監査の start のない送信と credential を含む監査、終端の event の別 DB への記録、renderer による監査の偽造と妨害（restricted 下でも呼べる `ai_audit_append_batch` で、この route の path ID の execution を偽造すること、Native の execution に終端を差し込むこと、Native より先にその execution や event の ID を使って Native の書込みを失敗させること。S17）、生成出力のほかの窓への配信、会話の読取を使って、この route 以外の会話（ほかの chat の会話と restricted になる前の会話）・別の workspace の会話・監査の記録の平文を取ること（会話の ID の指定、未登録や古い epoch の caller、unrestricted での呼出しを含む）、この route の会話でない会話をこの route の会話として扱わせること（restricted になる前の会話やほかの chat の会話を `capture_current_chat_input` と `nir1_local_generation_start` に渡し、capture や attempt を持たせてから読取に渡すこと。S20）、この route の会話の中の、この route の行でない行（restricted になる前の行、unrestricted の間に足された行、`bind_human_message` で束縛しただけの行、ほかの route の出力、失効した行や digest の合わない行）を読取で返させること、unrestricted の間に印を偽造した会話を使って、restricted になる前の行を読取で返させることや request に入れさせること、purpose や Scene の違う会話での生成（Review の会話での Writing など）、途中の出力を確定した結果として扱うこと、この route が使えないときの旧経路や外部 model への fallback、Review と Writing の取り違え、journey seam の悪用（packaged build での有効化、exact でない env での有効化、grant を経ない同意の記録、sender・window・caller の束縛の省略、`LocalSendConsent` 以外の grant の承認、「IPC の command」の表にない入口の開放、seam による送信先・transport・key の判定・route の規則・監査の変更）。
- Out-of-scope attacks: 同じ socket での listener の置換を検出・防止すること（開示で扱い、利用者が引き受ける）、OS・Main・Native の侵害と、同じ OS ユーザーで動く悪意あるプロセスによる memory や file（監査の記録を含む）の読取、同じ OS ユーザーで動くプロセスによる同意の記録の偽造や書換え（`ai-settings.json`・`profile-egress.json` の書換えとの組合せや、backup からの書き戻しなど、アプリの外での変更を含む。OS や profile の侵害と同じ区分にする。偽造された同意でも送信先は route の規則で loopback の socket に限られ、そのプロセスは原稿の file をすでに直接読める。`ai-settings.json` だけの書換えは同意の identity と一致せず、送信 0 になる）、待ち受けているプログラムの保存・保持・ログ・学習・外部への転送（local の server が model によって外部の service を呼ぶ構成を含む。どの model に送るかは同意で示して束縛するが、その model がどこで処理されるかは確かめない）、送った bytes を取り戻すことと、取消の後に相手の処理が止まること、local の server が LAN に公開されていることによる第三者の利用、model の出力の品質と真偽、Ollama の native API とほかの API、物理メモリの上限とその証明（U6）、同じ OS ユーザーで動くプロセスが journey seam の env を与えて非 packaged の build を起動すること（packaged build には seam がない。K2、K3 の draft と同じ区分）、侵害された renderer による可用性の妨害（DB の競合で監査の書込みを上限の外へ追いやること、開始や取消の連打、生成を始めないこと。結果は送信 0、取消、gate の quarantine のどれかで、送り先と内容の範囲は変わらない）、この route 以外の path（既存の Native の post-effect と semantic を含む）の監査の event を renderer が偽造すること（S17。この行は、この route の path と ID の namespace だけを閉じる）、unrestricted の間（activation の前と、K3 の draft の F-1）に renderer が `chat_sessions` の行やこの route の会話の印を偽造・改変すること（印を、renderer がその間に書ける既存の保存に置く場合。防がない。偽造された会話でも、読取が返すのは「この route の会話の範囲」の 2 の行だけで、生成の request に入る履歴は、確認済みの `history-reauthorization`（来歴のない旧履歴を資格にしない。l6-l9:534）と K4 の規則（capture の lineage）によるので、平文の範囲は広がらない。S20）。
- Mandatory defenses: proposal/3 の3行の防御（main が発行する caller、profile-wide の deny、handle の再検証、5 行の terminal matrix、再送しない回復、毎 turn の再認可）は保持する。加えて次を必須にする。
  1. 送信先：「送信先と route の規則」に合う route だけを使う。合わなければ attempt も送信も 0 にし、理由を typed で返す。名前解決はしない。model の名前も同じ表の model の行で確かめ、合わなければ同意の preview も grant も作らない（S18）。
  2. 接続先：設定の literal から socket address（`SocketAddr`）を作って1回だけ接続する。host 名の文字列を受ける接続の API と名前解決は使わない。最初の byte を書く前に、接続した相手の address と port が設定と同じで loopback であることを確かめ、違えば書かずに閉じる（送信 0）。この照合は実装の drift（host 名の文字列で接続する変更など）に対する guard で、待ち受けているプログラムの正体は確かめない（listener の置換は開示で扱う）。
  3. client：「client の規則」のとおり。proxy、redirect、自動の再送、接続の再利用、圧縮、TLS、HTTP/2 を使わず、header は固定の allowlist だけにする。
  4. credential：送らない。endpoint に key があれば unavailable にする（判定は「送信先と route の規則」の key の行で、Main が生成の開始の時に行う）。URL の credential は拒否する。
  5. body：attempt に束縛した canonical payload の bytes を、digest を確かめてからそのまま送る。送信の直前に組み替えない。
  6. wire と終端：「wire と終端の規則」のとおり。成功は `stop` と `[DONE]` を1回ずつ観測した場合だけで、non-stream の応答へ fallback しない。
  7. text と thinking：parser で分けて OutputObserver に渡す。allowlist にない field の内容を text にも thinking にも入れない。thinking を後の model の入力に使わない。
  8. terminal：5 行の matrix に写し、attempt ごとに1回だけ書く。再送しない。
  9. 監査：接続の前に `execution.started`、`request.prepared`、`request.dispatched` をこの順に同じ batch で durable にし、書けなければ接続も送信もしない（GDX-AI-AUDIT-001 の `[precheck]`。既存の validator の順序。S15）。`request.dispatched` は transport への dispatch の記録で、送信の証拠にしない。終端の event は同じ DB に書き、成功は `response.completed` の後の `execution.succeeded` にする。crash の後の終端は sweep が同じ DB に書く。監査の書込みは K1b の上限の内側で行い、そのための bounded な append と、attempt の終端と同じ transaction で書く append を DT-4 で用意する（S16。既存のコードの変更）。この route の path ID（Writing と Review）と、この route の eventId・executionId・operationId の予約した namespace（接頭辞。名前は DT-4）には、Native の監査の owner と sweep だけが、N-API に出さない専用の append で書く。汎用の append（`Database::append_ai_audit_events_for_scope` と、それを呼ぶ N-API の `ai_audit_append_batch`）と Main の IPC の検証は、この route の path ID を持つ event か、eventId・executionId・operationId・parentExecutionId のどれかが予約した namespace に入る event を含む batch を、何も書かずに typed に拒否する（S17。既存のコードの変更で、DT-4 の受入れに含める）。詳細は「監査」の節。
  10. route の登録：`AI_PATHS` などに登録し、監査の契約試験を割り当てる。登録がなければ `[routing]` の失敗にする。
  11. 同意：「同意」の節のとおり。model を含む identity を、attempt の作成の前と、送信の開始の直前に照合し、なければ送信 0。route の設定の書込みで identity が変わるときは、設定を書く前に同意の記録を消し、消せなければ設定を書かない（「失効」）。dialog の display に入る設定由来の値は、送信先の socket と model の名前だけで、どちらも route の規則で形を固定したものに限る。model の名前は、開示の 2 の中の、固定のラベルの付いた専用の行に置き、その行にはラベルと区切りと名前のほかを置かない。区切りは名前に使えない文字（route の規則の model の行の外の文字）のうち、名前に使える文字と見た目の似ていないものにする（長い名前は決まった幅で折り返し、続きの行を字下げで示してよい）。dialog の既定のボタンと、Esc や閉じる操作の結果は取消にし、承認は承認のボタンと確認の checkbox がそろったときだけとする（「同意」の節の確認の流れ）。
  12. D2a：profile が restricted で、in-flight の停止が確認済みのときだけ準備する（pe.rs:442-467）。unrestricted なら新しい入口を拒否する。旧経路、ほかの provider、外部 model へ fallback しない。
  13. lifecycle：HTTP を待つ間に DB mutex、profile や lifecycle の lock を持たない。取消は socket の shutdown と thread の join で終える。join が上限の内に終わらなければ、終端を1回だけ書いて thread を切り離し、gate を quarantine する。DT-5 の owner/lifecycle matrix（「DT-5 の owner/lifecycle matrix が満たす条件」）を mutation の前に置く。
  14. 出力の配信と会話の範囲：生成出力は起動した sender だけに返し、event で broadcast しない。途中の出力を確定扱いにしない。「この route の会話」は「この route の会話の範囲」の節のとおり、session（`nir1_local_conversation_create` が作った会話だけ）と行（#611 の capture が受理した利用者の入力と、この route の attempt の成功の出力で、message version が失効しておらず digest が一致するものだけ）の2段で決める。`nir1_local_generation_start` は、この route の会話でない会話、purpose か Scene が会話と違う intent、その会話の current な capture でない入力を typed に拒否する（attempt 0、送信 0）。`nir1_local_conversation_read` は、この route の会話の、行の段に当たるものだけを返す。会話の作成と一覧の表示名には会話の内容と利用者の入力を入れない（「IPC の command」）。attempt や capture を持つことを、この route の会話の判定に使わない。
  15. 資源：期限と bytes の上限を K1b の規則で置く（「数値」の節）。
  16. A-1：PUB-L まで製品入口を閉じる。PUB-L の前は、Main が「IPC の command」の表の command を typed に拒否し、Native もこの route の N-API の入口（表の command に対応するもの。attempt の作成と同意の preview・writer を含む）を既定で拒否する（二重の gate。Native の gate は、この route の N-API の入口か同意の preview・writer を初めて置く PR（DT-4 か DD-1）で置く）。Native の gate を PUB-L の前に開けられるのは Main だけで、Main 専用の N-API（`NAPI_COMMANDS` に載せない。DSN §7.2）を使い、起動時に journey seam（17）が有効であることを確かめた process の間に限る。PUB-L で開く製品の gate は PUB-L の承認の範囲で作り、この行は開かない。単体と結合の試験（cargo test、node:test、vitest）は、dialog を mock し、試験の build の入口か、試験から直接呼ぶこの Main 専用の N-API で gate を開けてよい（renderer と通常の起動からは選べない）。試験用の transport は作らず、journey でも製品の client を使う。journey（DD-1、E-1）では、harness が loopback で待ち受ける HTTP の recorder を製品の process の外で起動し、製品の client が通常の設定（`127.0.0.1:<port>`）と Main の同意（grant）を通ってそこへ送る。recorder の code は製品の build（既定の feature 集合の N-API build、packaging、Main・preload・renderer の bundle）に入れず、K6 の draft の「評価専用の呼び出し口」の隔離（`cfg(test)` か評価専用の cargo feature。たとえばその feature を要する bin）に従って置く。renderer、IPC、環境変数、設定のどれにも、recorder や試験用の transport に切り替える値を置かない。設定で選ぶのは送信先の port だけで、これは route の規則と同意の対象であり、transport の差替えではない（製品の client は、その port で待ち受けている相手が recorder か実在の server かを区別しない）。既存の決定論 Journey provider（`electron/main/productJourneyAi.ts:74-91`）でこの route の transport を置き換えない（「前提の更新」）。
  17. journey seam：PUB-L の前に実 Electron の journey（DD-1）でこの route を通す方法は、次の seam だけとする。seam は、非 packaged の build で、journey の runner が所有する exact な env の値があるときだけ有効になる（既存の journey seam と同じ条件。S19。K3 の draft の journey seam と同じ型）。packaged build では有効にならず、env の値を読まない。seam が置き換えるのは2点だけである。(a) PUB-L の前の gate（16）を、「IPC の command」の表の command に限って開けること。(b) `LocalSendConsent` の dialog を OS に出さずに、seam の値が決める応答（checkbox を伴う承認、checkbox のない承認、取消、時間切れ）を返すこと。seam の値で (b) を使わずに実物の dialog を出すこともでき、3 OS の表示の確認に使う。PUB-L の後の journey（E-1）は (b) だけを使う。要求は journey の runner が開いた製品の window から、preload の同じ command で送る。Main は sender、window、caller を製品と同じに確かめ、Native の preview（display の生成を含む）、issue、consume、同意の writer、期限、同時1件を製品と同じ経路で通す。seam が承認するのは `LocalSendConsent` だけで、ほかの種類の grant は承認しない。seam は送信先、transport、key の判定、route の規則、D2a、監査を変えない。seam を使ったこと（seam の版、env の名前、承認した grant の数）を journey の receipt に残す。
  18. 再確認：「再確認が要る変更」に当たる変更は、新しい draftRef で確認を得てから行う。
- Acceptance implications:
  - Positive: restricted な profile、現在の同意、`127.0.0.1` の route、key なしの条件で、manual の Writing の request が設定の socket に1回だけ届く（recorder の接続は 1）。届いた body は attempt の payload digest と一致し、header は allowlist だけ。SSE の text と thinking が分かれ、`stop` と `[DONE]` を1回ずつ受けて `succeeded + parsed + required` になり、本文、version、receipt がそろって保存される。監査の start の3件（`execution.started`、`request.prepared`、`request.dispatched`）は接続（connect）より前に同じ batch で durable で、終端の event（`response.completed` と `execution.succeeded`）もそろい、既存の validator を通る。Review と `[::1]` の route でも同じ。`HTTP/1.0` の status line、choice の null や scalar の未知の key（`logprobs: null`、`stop_reason` など）、非終端の event に `finish_reason` の key がない応答、最後の text と `stop` が同じ event にある応答、`data:` の直後の空白の有無、複数行の `data`、stream の先頭の BOM、chunk の extension と trailer でも、同じく成功する。TCP の読取の分け方と SSE の event の分け方を変えても digest が同じ（DG-4）。取消で socket が閉じて thread が join し、終端が1回だけ書かれる。次の turn で再利用されるのは、H-current の再認可を通ったものだけ。`nir1_local_conversation_create` で作った会話で生成した後、cold reopen（再起動して開き直す）をしても、`nir1_local_conversation_list` がその会話を返し、`nir1_local_conversation_read` が、capture した利用者の入力とこの route の成功の出力を返す（履歴として不適格になった行も表示には残る。l6-l9:534）。PUB-L の前の実 Electron の journey（DD-1）は、journey seam（必須防御の 17）の起動で、Main の同意（grant の preview、issue、consume）を通して行う。
  - Negative: 次の各場合に、送信の前なら送信 0、送信の後なら失敗の終端になり、どちらも再送しない。unrestricted か D2a が unavailable。同意がない、socket・provider・model・route・policy の版が違う、撤回済み、記録が壊れている。renderer が `save_ai_settings` で model を書き換えた後（新しい同意まで）。`localhost`、host 名、`127.0.0.1` 以外の 127/8、`::ffff:127.0.0.1`、`[0:0:0:0:0:0:0:1]`、zone 付き、LAN、`https`、userinfo、query、fragment、ほかの path、port の 0・先頭の 0・符号・範囲外。endpoint に key がある（id が `default` の endpoint では旧 account の key を含む）、key の判定に失敗した、Main が判定した endpoint と Native が解決した route の endpoint が違う。proxy の環境変数がある（直接つなぎ、proxy 側の接続は 0）。監査の start の失敗。3xx（追わない）、401・429・5xx（再送しない）。`text/event-stream` 以外の content type と `Content-Type` の欠落（non-stream へ fallback しない）、圧縮、framing の曖昧さ（chunked と `Content-Length` の併存、`HTTP/1.0` の応答の `Transfer-Encoding`、framing に関わる header の重複）。`finish_reason` が `length`・`tool_calls`・未知の値、null 以外の `finish_reason` が2回以上、`[DONE]` までに null 以外の `finish_reason` を1回も観測しない。`[DONE]` の欠落・重複。`stop` と `[DONE]` の間や `[DONE]` の後の data。choice の数や index の違い、choice の未知の key の object や array の値、`event:` の field、`tool_calls` などの key、不正な UTF-8 や JSON。上限を超える header・event・body・text・thinking と、各期限の超過。同じ attempt の並行（recorder は1回か0回。DG-2）。renderer が渡した messages・endpoint・purpose・flag。restricted 下の旧経路と補助 AI。ほかの窓への出力の配信。加えて、次の各場合は typed に拒否され、attempt も送信も 0 になる。この route の会話でない会話（restricted になる前の会話とほかの chat の会話。`capture_current_chat_input` でその会話に capture を作った後を含む）を指定した `nir1_local_generation_start`、purpose か Scene が会話と違う intent、current な capture のない会話（recorder の接続は 0）。model の名前が規則に合わない（改行、CR、タブ、制御文字、空白、引用符（`"`、`'`、バッククォート）、`\`、非 ASCII（双方向の制御文字と全角の文字を含む）、257 bytes 以上。同意の preview も grant も作らず、dialog も出ない）。同意の dialog の取消、Esc や閉じる操作、checkbox のない承認、期限切れの後の承認（grant は発行されず、同意の記録は書かれない）。PUB-L の前の通常の起動（seam が無効）と packaged build での、「IPC の command」の表の command（Main の gate と Native の gate の両方で拒否し、dialog も出ない）。packaged build に seam の env を与えた起動（gate は開かず、dialog の置換もない）。seam が有効な起動での、別の sender や window の要求と、表にない command。seam は `LocalSendConsent` 以外の grant を承認しない。また、renderer が `ai_audit_append_batch` で、この route の path ID を持つ event（`execution.started` から `execution.succeeded` までの偽の chain を含む）か、予約した namespace の eventId・executionId・operationId・parentExecutionId を持つ event（Native の execution への終端の差込みと、Native より先の `execution.started` を含む）を送ると、batch ごと拒否されて何も書かれず、Native の start と終端の書込みは影響を受けない。
  - Recovery: 送信の前後での crash の後に再送せず、sweep が保守的な終端と監査の終端を同じ DB に書き、履歴の資格を与えない（DG-3）。commit の結果が不明なら DT-2 の規則（exact ID の再読取と quarantine）に従う。送信中の route の変更、同意の撤回、D2a の失効、workspace の transition、sender の destroyed では取消にし、結果に資格を与えない。取消の join が上限を超えたら、終端は1回だけで、gate は quarantine され、切り離した thread の観測は捨てられる。失効した同意は戻らず、新しい同意が要る。設定の書込みで同意の記録を消せなかったときは、設定も書かれず、同意と設定の組合せは書込みの前のまま残る。
  - Lane unlocked if confirmed: DF+-b、DT-4、DT-5a／b（DF+-b と DT-1〜3 の merge が前提。数値は確認済みの K1b の規則で、DT-5a の実測から選ぶ）、DD-1 の送信の部分、同意の dialog、この route の会話の表示、journey seam（K3、K6 とほかの依存が前提）。製品での公開には、PUB-L の承認（Session C-2）がさらに要る。
- 受入れへの影響（l6-l9:620）:
  - 送信先: 変更前は NIR-1 の送信先がない（試験用の framed loopback だけ）。変更後は、利用者が設定した `127.0.0.1`／`[::1]` の port で待ち受けるプログラムへ、PUB-L の後に送る。外部の送信先は加えない。
  - authority: 同意の記録とその照合を新しく置く（GDX-AI-CONSENT-001 の Electron への適用）。ほかの authority は加えない。
  - 保存範囲: 監査の記録に、この route の request（原稿の抜粋、利用者の入力、履歴、system prompt）と応答（text、公開された thinking、終端）を加える。GDX-AI-AUDIT-001 の既定のとおりで、ほかの chat の route と同じ扱い。receipt と attempt は digest と参照だけのまま（proposal/3）。この route の会話は既存の `chat_sessions` に置き、利用者の入力と生成出力は既存の capture と成功の本文の保存先（#611、gendb.rs:3198-3217）に置く。会話の行には、この route の印と purpose を加える（置き場は DD-1。新しい schema ではない）。同意の記録（同意の identity と時刻。identity は「同意」の節のとおりで model の名前を含む。内容と credential は含まない）を profile 側に置く。
  - data category: 同意の記録が新しい。原稿の data category は変えない。
  - profile-wide egress と履歴の lineage: 変えない。restricted のときだけ使え、旧経路は拒否のまま。次の turn の再利用は K4 と H-current による。
  - 品質閾値: DG-4 を SSE の wire で具体化する（TCP と SSE の分割、UTF-8 の分割、終端の重複と欠落、終端の後の data、text と thinking の交互の到着）。D-final の受入れでは、`localhost` を許す試験（prep.rs:6075-6094）を拒否に反転し、payload のキー数の断言（prep.rs:2125-2128）を 4 にし、DF-06 の payload digest を更新する。P、Gold、G-case、P-01〜P-12 の判定は変えない。
  - 信頼境界: 待ち受けているプログラムを、同意した送信先でありながら応答は信用しない相手として扱う。listener の置換は検出せず、開示で扱う。同意の確認の主体を Main の dialog にする（renderer は同意の要求を出せるが、承認は dialog の承認のボタンと確認の checkbox だけで成り立つ）。renderer の監査の append から、この route の path と ID の namespace を外す（S17）。restricted 下で renderer に平文を返す読取面を、この route の会話に限って加える（`nir1_local_generation_continue` の生成出力の差分と、`nir1_local_conversation_read` の利用者の入力と生成出力。「IPC の command」）。K3 は restricted 下での非 NIR の自分のデータの表示を O-2 として別の draftRef に回しており、この面はそれとは別に、この行の確認で開く。「この route の会話」は session と行の2段で決め、平文の境界は行の段（#611 の capture が受理した利用者の入力と、この route の attempt の成功の出力で、version が失効しておらず digest が一致するもの）で引く（「この route の会話の範囲」。S20）。この route 以外の会話（ほかの chat の会話と、restricted になる前の会話）、この route の会話の中の行の段に当たらない行、監査の記録の表示は開かず、O-2 の確認の有無はこの面の範囲を変えない。journey seam は非 packaged の build だけの試験の入口で、有効な起動では journey の runner を dialog を確定する利用者の代わりとみなす。packaged build にはないので、製品の authority は加えない。
  - 受入れに加えるもの:
    - 監査の契約試験。start の3件が接続（connect）より前に同じ batch で durable であること（recorder が接続を受け付けた時点で3件が durable で、start の書込みに失敗させたときは recorder の接続が 0 であることで確かめる）。credential を含まないこと。終端が同じ DB にあり、成功は `response.completed` の後の `execution.succeeded`、送信 0 と取消は `execution.failed` か `execution.cancelled` で閉じ、どれも既存の validator（audit.rs:1011-1099）を通ること。終端の後に event がないこと。`request.prepared` の body の値を D-final の規則で直列化すると、送った body の bytes と一致すること。監査の書込みが K1b の上限の内で終わること。start の書込みが上限を超えたら送信 0 になり、終端の書込みが超えたときは「監査」の節と DT-2 の matrix のとおりになること（attempt が未終端なら sweep に委ねて gate を quarantine し、attempt だけが終端していれば start-only の ambiguous として残る）。crash の後の sweep が同じ DB に `execution.failed` を書き、監査の start のない attempt には書かないこと。汎用の append（Main の IPC の検証と grimodex-db の両方）から、この route の path ID と予約した namespace の event を書けないこと（restricted の下で、renderer の関数を実 router、gate、Native に通す試験を含む）。既存の renderer と Main（Codex）の監査、既存の Native の writer（post-effect、semantic）の append は変わらないこと。加えて registry の完全性試験。
    - 同意の試験。送信 0 になる場合：同意がない、不一致、撤回、期限切れの grant、記録が壊れている、記録の版が分からない、形式は正しいが identity が現在の値と一致しない、model の変更（利用者による変更と、renderer の `save_ai_settings` による変更）の後。同意が保たれる場合（正例）：同意の identity に関わらない設定の変更（endpoint の出力の上限など）、workspace の切替・restore・import の後。戻らない場合：撤回や失効の後に、設定を元の値に戻しても、workspace の restore や import をしても、新しい同意がなければ送信 0。同意の記録の削除の失敗を注入すると、設定の書込みも typed に失敗し、`ai-settings.json` は変わらないこと。
    - dialog の試験。display が開示の 1〜8 をすべて含み、開示の内容の digest の元になる構造化した項目と同じ集合であること。項目が欠ければ preview も grant も作らないこと。display に入る設定由来の値が送信先の socket と model の名前だけであること。model の名前が、開示の 2 のラベルの付いた専用の行の区切りの内側だけに出て、その行にラベルと区切りと名前のほかがなく、区切りの文字が route の規則の model の行の外の文字で、名前に使える文字と見た目の似ていないものであること（DD-1 が選んだ区切りの文字を記録する）。Main が dialog に渡す既定のボタンと、Esc や閉じる操作の結果が取消のボタンで、確認の checkbox が未選択で出ること（vitest で dialog に渡す値を確かめる）。承認のボタンでも checkbox がなければ、取消と同じく grant が発行されないこと。3 OS で、model の名前が上限の 256 bytes で、規則が許す記号（`!#$%&()*+,-./:;<=>?@[]^_{|}~`）をすべて含むときも、display が切り詰められず、display と同じ文字列として（markup、escape、書式の指定、access key の印として解釈されずに）表示され、既定のボタンが取消であること。どれかが成り立たない OS では、「同意」の節の専用の window に替えて同じことを確かめる。これは seam の応答の置換では確かめられないので、journey seam の (a) だけを使って実物の dialog を出す起動で確かめ、OS ごとの screenshot を DD-1 の PR と作業記録に残す（手動の確認）。利用者が読んで承認するまでの時間が grant の期限に収まることは、開示の全文（model の名前が上限のとき）の文字数と、注意して読む速さの控えめな値（値と根拠は DD-1 が記録する）から見積もって確かめる（文量は OS に依らないので、OS ごとには見積もらない）。どちらも DD-1 で行い、PUB-L の承認（Session C-2）の資料に含める（「選択肢と推奨」の同意の確認の UI）。
    - model の名前の試験（DF+-b の 7）。規則に合わない名前（改行、CR、タブ、制御文字、空白、`"`、`'`、バッククォート、`\`、非 ASCII（双方向の制御文字と全角の文字を含む）、0 bytes、257 bytes）で、route が unavailable になり、attempt も同意の preview も grant も作られないこと。規則が許す文字だけの 256 bytes の名前（許す記号をすべて含むもの）は通ること。renderer の `save_ai_settings` で規則に合わない名前を書いた後も同じであること。
    - A-1 と journey seam の試験。PUB-L の前の通常の起動（seam が無効）と packaged build で、「IPC の command」の表の command が Main と Native の両方で typed に拒否され、dialog、attempt、送信が 0 であること。packaged build では seam の env を与えても seam が有効にならないこと。seam が有効でも、表にない command は開かず、`LocalSendConsent` 以外の grant は承認されず、別の sender や window の要求では同意の記録が書かれないこと。seam の応答（checkbox を伴う承認、checkbox のない承認、取消、時間切れ）が、製品と同じ preview、issue、consume の経路を通ること（checkbox のない承認と取消では issue されず、時間切れでは issue が拒否されること）。
    - key の判定の試験（DF+-b の 4）。key がある（endpoint 固有の account と、id が `default` の旧 account）、判定の失敗、Main が判定した endpoint と route の endpoint の不一致では attempt 0。開始の後に key を保存しても、その attempt の request に credential は付かず、次の開始は unavailable になること。加えて proxy の環境変数の試験、header の allowlist の試験。
    - 接続の試験。設定の literal から作った socket address だけに接続し、名前解決も host 名の文字列での接続もしないこと。
    - 取消の close と join の有界性の試験（3 OS）。join の上限の超過を注入すると、終端が1回だけ書かれ、gate が quarantine され、切り離した thread の観測が捨てられること。加えて出力の配信先の試験。
    - 会話の読取面と会話の範囲の試験（S20）。restricted の下で、`nir1_local_conversation_read` が、`nir1_local_conversation_create` で作った会話の、#611 の capture が受理した利用者の入力と、この route の attempt の成功の出力だけを、上限の内側で返すこと。次の fixture で確かめる。(1) restricted になる前に作った Scene の会話（利用者の行と外部 AI の出力を含む）：一覧に出ず、読取は typed に拒否され、`capture_current_chat_input` でその会話に capture を作った後も、`nir1_local_generation_start` は typed に拒否される（attempt 0、recorder の接続 0）。(2) この route の会話に、capture のない user の行、`bind_human_message` で束縛しただけの行、ほかの route の attempt を親に持つ出力、system の行、本文か thinking を書き換えて version が失効した行を置いたとき：読取はそれらの内容を返さず、thinking は検証した行のものだけを返す。(3) 印を、renderer が unrestricted の間に書ける置き場に置いた場合は、unrestricted の間に汎用 SQL で印を偽造した会話（restricted になる前の行を含む）：読取は restricted になる前の行を返さず、その会話で生成しても、request に restricted になる前の行が入らない。(4) purpose か Scene が会話と違う intent、current な capture のない会話、別の caller の capture：生成の開始が typed に拒否される。(5) cold reopen の後も、一覧と読取が同じ会話と行を返す。加えて、ほかの chat の会話、別の workspace の会話、監査の記録を返さないこと。会話の作成と一覧が返す表示名に、会話の内容と利用者の入力が入らないこと。unrestricted、未登録や古い epoch の caller、PUB-L の前の通常の起動では拒否されること（renderer の関数を実 router、gate、Native に通す試験を含む）。
  - 変えないもの: proposal/3 の3行、terminal matrix、A-1、Packing の公開条件、P と Gold。
  - 可用性: `localhost` を設定している利用者は、`127.0.0.1` に直すまでこの route を使えない。key が要る server、SSE の終端の形式が規則と違う server、OpenAI 互換でない server も使えない。空白、引用符（`"`、`'`、バッククォート）、`\`、非 ASCII の文字を含む model の名前と、257 bytes 以上の名前も使えない（server の側で規則に合う別名を付ければ使える）。model を変えると、Main の dialog で同意をやり直すまで使えない。どれもこの行で受け入れる制約で、緩めるには再確認を要する。

### 保存先

| 対象 | 保存先 | 内容 | 含めないもの |
| ---- | ------ | ---- | ------------ |
| attempt、claim、終端 | 既存の `nir1_generation_attempts` ほか（schema 37） | binding（project、session、caller、purpose、route revision、provider、model、api、endpoint identity の digest など。gendb.rs:122-143）、payload digest、終端（status、parse、digest） | payload の本文、raw URL、credential |
| 本文と version | 既存の message version と本文の保存先 | 成功したときの text と thinking（gendb.rs:3123-3126。失敗と取消では書かない） | — |
| 監査 | 既存の `ai_audit_events`（その workspace の DB、`project:<id>` の chain） | request（canonical payload の JSON 値）、route、provider、model、送信先の socket、purpose、attempt ID、payload digest、応答の text と thinking（途中で終わったときは観測した分）、usage（あれば）、終端 | credential（wire にもない） |
| この route の会話（session） | 既存の `chat_sessions`（その workspace の DB）。Native が作る行に、この route の印と purpose を置く（置き場と形は DD-1。「この route の会話の範囲」） | 会話の Scene、purpose、作成の時刻、印 | 会話の内容と利用者の入力（表示名と title にも入れない）、credential |
| 同意 | profile の設定 file と同じ場所にある、Native が所有する小さい file（`profile-egress.json` と同じ扱い。`electron/native/grimodex-node/src/state.rs:2760-2761`）。workspace の DB ではない | 同意の identity（「同意」の節）と同意の時刻 | 原稿、prompt、応答、credential |
| 一時的なもの | process の memory だけ | Main の grant（60 s）、Main が渡した key の判定の結果、受信の buffer、in-flight の登録 | — |

- 新しい schema は加えない。AttemptBinding の版を上げる場合は DT-3 の範囲で行う。
- 監査の記録は Scene の削除や restore では消えない（audit.rs:1-6）。restricted 下での監査の閲覧と export は D2a の区分に従う（現行は拒否。pe.ts:99-100）。区分を変えるかは K3 で決める。

### writer

| writer | 書くもの | 条件 |
| ------ | -------- | ---- |
| 同意の writer（Native） | 同意の記録 | Main の `LocalSendConsent` の grant（DSN §7）を消費したときだけ。renderer と Main は直接書けない。撤回は権限を減らすだけなので、grant なしで Main を経て行える。失効による記録の削除も権限を減らすだけで、Native が照合の時と route の設定の書込みの時に行う（「失効」） |
| 監査の writer（Native。新しい監査の owner） | `ai_audit_events` の、この route の path ID と予約した namespace の start と終端の event | 送信の owner が、K1b の上限の内側の書込みで行う（既存の公開の append は 5 s の busy timeout で自前の transaction を開くので、bounded な append を DT-4 で用意する。S16）。crash の後の終端は、sweep が attempt の保守的な終端と同じ transaction で書く（「監査」の節）。この path と namespace に書けるのは、この owner と sweep が使う、N-API に出さない専用の append だけである |
| attempt と終端の writer（既存の DB writer） | attempt、claim、終端、本文 | DT-2 の bounded な owner を通す |
| 会話の writer（Native。`nir1_local_conversation_create`） | この route の会話の `chat_sessions` の行と、その印と purpose | restricted の下で、登録済みの caller の要求のときだけ。Native が決めた新しい ID の行を strict に INSERT し、印と purpose を同じ transaction で書く。既存の行に印を付けない。restricted の下では renderer の汎用 SQL は `chat_sessions` に書けない（S20。unrestricted の間の偽造は Out-of-scope attacks）。利用者の入力の行は既存の capture の writer（#611）が、生成出力の行は attempt と終端の writer が書く |
| route の設定の writer（既存の `save_ai_settings`。`electron/native/grimodex-node/src/lib.rs:14643-14654`） | `ai-settings.json` | 既存どおり `with_route_update`（pe.rs:567-585）の中で permit を revoke してから書く。加えて、書き込む設定の route の identity、provider、model のどれかが同意の記録と違えば（この route の規則に合わない設定を含む）、同じ `with_route_update` の中で、まず同意の記録を消して削除を durable にし、成功したときだけ `ai-settings.json` を書く。削除に失敗したら設定の書込みも typed に失敗させる（fail-closed。permit は revoke 済みのまま）。削除の後で設定の書込みが失敗しても、消した同意は戻さない（安全側）。2つの file は原子的に書けないので、この順序で「設定だけが変わり、古い同意が残る」状態を作らない（「失効」）。ほかは変えない |
| renderer（既存の `ai_audit_append_batch`）と Main（Codex の監査） | `ai_audit_events` の、自分の path の event（既存どおり。restricted 下でも renderer は書ける。S17） | この route の path ID（Writing と Review）を持つ event と、eventId・executionId・operationId・parentExecutionId のどれかが予約した namespace に入る event は、汎用の append（grimodex-db）と Main の IPC の検証の両方で、batch ごと何も書かずに typed に拒否する（必須防御の 9。既存のコードの変更で、DT-4 の受入れに含める）。この route の同意の記録、attempt、claim、終端、本文には書けない |
| MCP | なし | この route の監査、同意の記録、attempt、本文、会話の印のどれにも書く経路がない |

### 失効

- 同意: policy の版、route、provider、送信先の socket（IP literal と port）、model、開示した purpose の集合、開示の内容の digest のどれかが変わったとき。利用者が撤回したとき。記録が壊れているか版が分からないとき（ないものとして扱う）。照合では、記録の identity を、現在の policy の版、設定から作った route の種類・送信先の socket・provider・model、現在の開示（purpose の集合と内容の digest）から毎回作り直した値と比べ、形式が正しくても一致しなければ同意はないものとする。
- 同意の失効の確定: 失効は Native が記録を消して確定させる。消すのは、route の設定の書込みで identity が変わるとき（設定を書く前に消し、消せなければ設定を書かない。writer の表）と、照合で不一致を観測したとき（policy の版や開示の更新など）である。設定の変更による失効はこの順序で確定するので、設定を元の値に戻しても、失効した同意は戻らない（undo しない）。照合の時の削除に失敗したときは、その process の中ではその記録を使わず（送信 0）、次の照合で削除を試み直す。消せないまま再起動し、その間に不一致の原因（アプリの版など）が元に戻って記録が再び一致することは、残余として受け入れる（アプリの外での file の変更と同じ区分）。identity に関わらない設定の変更、workspace の切替・restore・import では失効しない（「同意」の節）。
- attempt と handle: proposal/3 と DT-1〜3 のとおり（caller epoch、route revision、workspace の transition、D2a の失効、期限、取消）。
- 送信中の失効: route の変更、同意の失効や撤回、D2a の失効、workspace の transition、sender の destroyed で取消にし、結果に資格を与えない。送った bytes は戻らない。
- key: route の endpoint に key が設定されたら（判定は「送信先と route の規則」の key の行）、それ以後の attempt を作らない。判定は、Main が生成の開始の command を受けた時に、その時点の設定の active な endpoint について行い、endpoint の id と判定の結果を command に添えて Native へ渡す。Native は attempt を作る前にその値を確かめ（値は永続化しない）、key があるか判定に失敗していれば attempt を作らず、route の解決で得た endpoint の id と違えば unavailable にする。key store は Main だけが持ち、key の保存と削除は Native の permit を revoke しない（S14）。そのため Native は送信の直前に key を確かめ直さない。開始の後に保存された key はその attempt に影響せず（credential は送らないので、届くのは key のない request）、次の開始から unavailable になる。この窓は残余として受け入れる（推奨。対案は「選択肢と推奨」の表）。

### 送信先と route の規則

| 項目 | 規則 |
| ---- | ---- |
| provider と endpoint | `ai-settings.json` の provider が OpenAI 互換で、active な endpoint があり、`api_variant` がない。tool protocol は native で、payload に tools を入れない。context と output の上限が設定されている（現行の D-final の条件。prep.rs:872-950） |
| base URL | 正確に `http://127.0.0.1:<port>/v1` か `http://[::1]:<port>/v1`（末尾の `/` は1つまで可）。host は文字列としてこの2つだけを認める。別表記の IPv4、`[0:0:0:0:0:0:0:1]`、`::ffff:127.0.0.1`、zone、`0.0.0.0`、ほかの 127/8、LAN、host 名は拒否する |
| port | 10 進の数字だけで、先頭に 0 を付けず、1〜65535 |
| request の path | `/v1/chat/completions` に固定する |
| model の名前 | 1〜256 bytes で、各 byte が ASCII の印字可能な文字（0x21〜0x7E）のうち `"`（0x22）、`'`（0x27）、`\`（0x5C）、バッククォート（0x60）を除いたものであるものだけを認める。空白、改行、タブ、制御文字、非 ASCII の文字（双方向の制御文字を含む）も認めない。引用符とバッククォートを除くのは、dialog で名前を囲む区切りや、それと見た目の似た文字を、名前の中に作らせないためで（「同意」の節の確認の流れ）、`\` を除くのは、表示の経路で escape の印として読まれうるためである。合わなければ unavailable にし、attempt も同意の preview も grant も作らない。D-final の現行の検査（空でなく前後に空白がない。prep.rs:893-897）を強める。値は正規化せず、そのまま request、同意の identity、dialog の display、監査、attempt に使う（S18） |
| key | Main の key store で、route の endpoint の id について `keyringUserCandidates("openai-compatible", endpointId)` のどれかの account に key があれば unavailable。既存の `hasApiKey` と同じ判定で、id が `default` なら旧 account の `grimodex-user` も見る（`electron/main/aiKeyNaming.ts:65-78`、:132-138）。判定に失敗したとき（key store を読めない、復号できないなど。`electron/main/keyStore.ts:156-166`、:205-219）も unavailable。判定は Main が生成の開始の時に行い、結果を Native へ渡す（「失効」の key の行） |
| route の identity | route の種類、IP literal、port、path、wire（SSE）から作る。attempt の endpoint identity の digest もこれから作り、credential と raw URL を含めない |

### client の規則（HTTP/1.1）

- 1 attempt につき TCP の接続を1本だけ作る。接続の試行は1回で、別の address や port に切り替えない。
- request は HTTP/1.1 の `POST`。header は `Host`、`Content-Type: application/json`、`Content-Length`、`Accept: text/event-stream`、`Connection: close`、固定の `User-Agent` だけにする。`Authorization`、`X-API-Key`、`Cookie`、`Proxy-*`、`Expect`、`Transfer-Encoding` は送らない。
- proxy を使わない（環境変数と OS の設定を読まない）。redirect を追わない。自動の再送をしない（429、5xx、接続の切断、期限切れを含む）。接続を再利用しない。TLS、HTTP/2、upgrade を使わない。
- 応答の status line は `HTTP/1.1` か `HTTP/1.0` で、status は 200 だけを受け付ける（reason phrase は問わない）。`Content-Type` は `text/event-stream`（parameter は可）で、欠落は失敗にする。`Content-Encoding` は無しか identity。body の区切りは chunked、`Content-Length`、接続の close のどれか1つで、`Transfer-Encoding` は `chunked` だけを認める。chunked と `Content-Length` が両方ある、`HTTP/1.0` の応答に `Transfer-Encoding` がある（RFC 9112 §6.1 の不正な framing）、`Content-Length`・`Transfer-Encoding`・`Content-Type`・`Content-Encoding` のどれかが2つ以上ある、のどれかなら失敗にする。header の合計は上限の内側に限る。`Content-Length` は 10 進の数字だけで、上限を超えれば失敗にする。chunked では、chunk の大きさを 16 進の数字だけで読み（桁数と値に上限を置く）、chunk の extension は無視し、trailer は header の合計の上限に数えて読み捨てる。
- 期限と bytes の上限は K1b に従う（「数値」の節）。

### wire と終端の規則（SSE）

request の payload は、D-final が作る canonical JSON に `"stream": true` を足したものとする。この行で決める payload の変更はこれだけで、`stream_options`、tools、sampling の指定は加えない。

応答の解釈:

1. body は UTF-8 として読み、読めなければ失敗にする。stream の先頭の BOM（U+FEFF）は1つだけ除く。行の区切りは SSE の規格どおり（CRLF、LF、CR）とし、空行で event を区切る。
2. 行は最初の `:` で field 名と値に分け、値の先頭の空白（U+0020）は1つだけ除く（`data:{…}` と `data: {…}` を同じに読む。既存の parser は `data: ` の形だけを読む。ai.rs:5019）。`:` のない行は、行の全体を field 名とし、値を空とする。`:` で始まる行（comment）は無視するが、上限には数える。解釈する field は `data` だけで、`id` と `retry` は無視する。`event` とそれ以外の field があれば失敗にする。1つの event に `data` の行が複数あれば、規格どおり値を LF でつないで1つの値にする。`data` の値が空の event は、規格どおり event として扱わない（上限には数える）。
3. `data` の値は、全体が `[DONE]` と一致するもの（前後の空白を許さない）か、1つの JSON object。JSON として読めなければ失敗にする（読み飛ばさない）。top-level に `error` があれば失敗にする。
4. 各 object の `choices` は要素が1つで、`index` が 0。choice の key のうち解釈するのは `index`、`delta`、`finish_reason` だけとする。choice のほかの key（`logprobs`、vLLM の `stop_reason`、SGLang の `matched_stop` など）は、値が null か scalar（文字列、数値、真偽値）なら無視し、object か array なら失敗にする（`message` などの形で届く内容を黙って捨てないため）。`delta` は object で、ないときは内容のない event とする。`delta` の key は `role`（`assistant` か null）、`content`、thinking の allowlist（初期は `reasoning_content` と `reasoning`）に限り、ほかの key に null 以外の値があれば失敗にする（`tool_calls`、`function_call`、`refusal` を含む）。`content` と thinking の field の値は文字列か null で、null は値がないものとして扱う。top-level のほかの key（`id`、`model`、`usage` など）は内容として扱わない。
5. text は `delta.content` の文字列を、thinking は allowlist の field の文字列を、event の届いた順に OutputObserver に渡す。1つの event の中では、thinking、text、終端の順に渡す（JSON の key の順に依らない）。OutputObserver は終端の後の data を拒否するので（receipt.rs:147-155）、最後の text と `finish_reason` が同じ event にあっても、text を先に渡す。1つの delta で thinking の field が2つとも値を持ち、値が違えば失敗、同じなら1回だけ数える。
6. `finish_reason` は、終端の event までは null とする。非終端の event で choice に `finish_reason` の key がないことは、null と同じに扱う。null 以外の値を持つ event は1回だけで、`stop` なら provider の終端（`Complete`）、`length` なら `LengthLimit`、それ以外は `Ineligible` として OutputObserver に渡す。
7. 終端の event の後に来てよい `data` は `[DONE]` の1回だけ（間の comment は可）。`[DONE]` の後は body の終わりまで空行と comment だけとし、body の終わりを上限の時間の内側で観測する。
8. 成功は、1〜7 をすべて満たし、`finish_reason` が `stop` の場合だけとする。

終端の対応（proposal/3 の matrix と `FailureClassification` への写し方。gendb.rs:609-615、:3084-3112、:3221-3233）:

| 状況 | terminal | parse | response digest | 分類 |
| ---- | -------- | ----- | --------------- | ---- |
| 成功（上の 8） | succeeded | parsed | あり | — |
| 送信の後の失敗（status、content type、framing、parse、`length`、`Ineligible`、終端の欠落や重複、終端の後の data、上限や期限の超過、相手による切断） | failed | invalid | あり | InvalidOutput |
| 送信の前の失敗と閉鎖（送信の開始の直前の同意の照合、接続先の照合、接続の失敗、監査の start の失敗、D2a・route・同意の失効、gate の閉鎖など、attempt の作成の後で送信の前に見つかったもの。DT-2 の pending start を含む。key の判定と送信先の規則は attempt の作成の前に確かめるので、ここには来ない） | failed | not-attempted | なし | DispatchUnavailable |
| 取消（利用者の取消、sender の destroyed、window の close は送信の前でも後でも。送信の開始の後の失効も取消にする） | cancelled | not-attempted | なし | Cancelled |
| crash の後の sweep | failed | not-attempted | なし | InterruptedUnknown |

5 行のうち `skipped + not-attempted + null`（Skipped）は、この route では使わない。送信の前に閉じた attempt は、上の「送信の前の失敗と閉鎖」か「取消」に写す。DT-2 は、この route の attempt についてこの対応に従う（DSN §1.10 が DT-2 に委ねた「ほかの理由との対応」）。

`not-attempted` は相手が処理しなかった証拠にしない（post-B §9.4）。送信の後の取消は、送った bytes を取り戻したことを意味しない。

実在の server がこの終端の形式を出さないときは、その server では毎回失敗になる。DT-5a は主要な local server（llama.cpp の server、Ollama、LM Studio、vLLM、SGLang など）について、終端の形式、choice と `delta` の key、`finish_reason` の key の有無、SSE の行の書き方（`data:` の後の空白、複数行の `data`、BOM、comment）、status line の版、`Content-Type` と framing の header、model の名前の形（「送信先と route の規則」の model の行に合うか）を実測し、PUB-L の前（Session C-2）に報告する。たとえば `stop` と `[DONE]` の間に usage だけの event を送る server を受け入れるには、規則を緩める差分の確認が要る。

### 監査（GDX-AI-AUDIT-001）

- captureLevel は `full-observable`。auditOwner は Native の新しい監査の owner とする（名前は DT-4 で決める）。Writing と Review は別の path ID にする（AI経路検証:58-61）。
- start: 接続の前に、`execution.started`、`request.prepared`、`request.dispatched` をこの順に、同じ durable な batch（1つの transaction）で書く。既存の validator はこの順を求め（S15。audit.rs:1011-1099）、native の dispatch の前提もこの3件を求める（audit.rs:1463-1514。順序の説明は `docs/Grimodex_Attributionパネル設計書.md:408`）。AI経路検証:33-45 の「started と prepared を同じ durable batch で保存し、その成功後だけ送信する」に、`request.dispatched` を同じ batch で加える形である。
- `request.dispatched` は、application が選んだ transport（この route の transport の thread）へ request を渡した記録で、HTTP の送信や相手の受信の証拠ではない（`src/features/ai-audit/exportBundle.ts:815`）。3件が durable になった後に接続し、最初の byte を書く。接続の失敗や照合の失敗で送信 0 になった execution にも `request.dispatched` は残り、送信 0 は終端の event の分類（DispatchUnavailable と not-attempted）で示す。
- `request.prepared` の payload: request として canonical payload の JSON 値（system、user、履歴、context、model、`max_tokens`、`stream`）を入れ、route の identity、provider、送信先の socket、purpose、attempt ID、payload digest を添え、`credentialsExcluded: true` とする。この route の body は canonical JSON なので、`request.prepared` の payload の request の値を D-final の canonical JSON の規則で直列化すると、送った body の bytes と一致する（監査の保存は key の順を並べ替えるが、値は変えない。audit.rs:666-716）。この一致が言えるのは `request.prepared` の request の値だけで、ほかの event やほかの項目には当てはまらない。DT-4 はこれを試験で確かめ、route の note で宣言する（iron-laws:30-34 の明示の宣言）。
- この route は自動の再送も fallback もしないので、`transport.attempt.*`、`execution.retrying`、`execution.fallback` は書かない（`transport.attempt.*` は 429 の再送の helper のための event。exportBundle.ts:815）。
- 終端（validator の順序。audit.rs:1063-1095）:
  - 成功：`response.completed`（応答の text と公開された thinking、usage（あれば）、`finish_reason`）を書き、その後に `execution.succeeded` を書く。2件は同じ batch でよい（validator は同じ transaction の先の行を見る。audit.rs:1132、:1148）。
  - 送信の後の失敗と取消：それまでに観測した text と thinking があれば `response.partial` に書き、`execution.failed`（分類と status）か `execution.cancelled` で閉じる。200 以外の status では、上限の内側で読んだ body も失敗の event に残してよい。
  - start の batch の後で最初の byte の前の失敗・閉鎖・取消：`execution.failed` か `execution.cancelled` で閉じる（どちらも前提はない。audit.rs:1085-1088）。
  - 終端の event は execution ごとに1回で、その後には何も書かない（validator も終端の後の append を拒否する。audit.rs:1141-1146）。
- 書込みは K1b の上限の内側で行う（DT-2 と同じ扱い）。start を書けなければ接続も送信もしない。既存の `Database::append_ai_audit_events_for_scope`（audit.rs:1728-1734）は、期限なしで DB の mutex を待つ `with_conn` を通り、その中で自前の `BEGIN IMMEDIATE` と 5 s の busy timeout を使う（:20、:1202-1223）。transaction の中で append する関数（:1101）は module の外から呼べない（S16）。DT-4 は、DT-2 と同じ bounded な participant の transaction の中で append する関数を grimodex-db に用意し、owner と sweep はそれだけを使う（既存のコードの変更。DT-4 の受入れに含める）。
- 書き込む DB は、送信の owner が持つ pinned な workspace の DB だけとする。transition の後の新しい DB には書かない（start だけの記録は、policy どおり ambiguous として残る）。
- crash の後: sweep が attempt に保守的な終端（InterruptedUnknown）を書くときは、同じ transaction で、同じ DB にあるその attempt の execution に終端の event がなければ `execution.failed` を書く。start の batch は原子的なので、execution は3件がそろっているか、まったくないかのどちらかで、execution のない attempt には書かない。payload は、中断して相手の処理が分からないことと分類だけを示し、応答の内容は書かない（sweep は応答を観測していない）。既存の sweep は attempt の終端だけを書く（gendb.rs:3308-3314）ので、この追加は DT-4 で行う。
- attempt の終端が durable になった後で、監査の終端だけが書けなかった execution は、policy のとおり start-only の ambiguous として残る。sweep は attempt の終端から監査の終端を作り直さない。通常の終端も attempt の終端と同じ transaction で書けば、この状態は起きない（推奨。DT-4 で確定する）。
- execution ID は、この route の予約した namespace の接頭辞と attempt ID から一意に決める（形と接頭辞の名前は DT-4 で決める）。sweep が attempt から execution を exact に引けるようにするためである。operation ID と event ID も同じ namespace に置く。
- 書込みの所有（S17）: この route の path ID（Writing と Review）の event と、予約した namespace の ID を持つ event を書けるのは、Native の監査の owner と sweep だけとし、どちらも上の bounded な append（N-API に出さない専用のもの）で書く。汎用の append（`Database::append_ai_audit_events_for_scope` と、それを呼ぶ N-API の `ai_audit_append_batch`。renderer は restricted 下でもこれを呼べる）は、path ID がこの route のものか、eventId・executionId・operationId・parentExecutionId のどれかが予約した namespace に入る event を含む batch を、何も書かずに typed に拒否する。Main の IPC の検証（`requireAiAuditEvents`。`electron/shared/ipcContract.ts:2772-2865`）も、同じ規則で先に拒否する。これで、renderer がこの route の execution を偽造すること、Native の execution に終端を差し込むこと、Native より先にその ID を使って Native の書込みを失敗させることを防ぐ。既存の renderer と Main（Codex）の監査と、既存の Native の writer（post-effect、semantic）の path は変えない。この route 以外の path への renderer の書込みは、この行では閉じない（Out-of-scope attacks）。
- receipt は digest と参照だけのまま（proposal/3）。本文と応答を監査に残すのは GDX-AI-AUDIT-001 の既定で、ほかの chat の route と同じ扱いにする。同意の開示で、アプリ側の保存として示す。

### route の登録（GDX-ROUTE-001）

- `AI_PATHS`（registry.ts:515）に Writing と Review の2件を加える。verifier は `contract`（local の model の品質はこの試験で証明しない）、auditOwner は新しい Native の owner、captureLevel は `full-observable`、auditTestRef と auditTestName は path ごとの監査の契約試験とする。layer の値は DT-4 で決める。
- `AI_RUNTIME_ROUTES`（registry.ts:1563）に、同意の契約（consentRoute、consentTestRef、consentTestName）を持つ runtime route として加える。同意の route の型（`src/features/ai-policy/aiDataConsent.ts:1`。現行は `byok` だけ）に、Electron の local socket route を加える。
- 生成の開始の command（`nir1_local_generation_start`。「IPC の command」）は、それを作る PR（DD-1）で `AI_TRANSPORT_COMMANDS`（`src/features/ai-verification/aiPathRegistry.test.ts:103-130`）に加える。
- AI経路検証の「経路を追加したら」（:234-253）と同意の節（:142-168）を更新する。
- PUB-L までは製品から到達できないことを、note と A-1 の試験で示す。登録が欠けていれば `[routing]` の失敗にする。

### 同意（GDX-AI-CONSENT-001 の適用と改訂）

policy の改訂（意味の差分。iron-laws の英語の文言は DT-4 で決め、AI の品質規則の変更として grimodex-author と impact-gate を通す）:

| 項目 | 現行（iron-laws:127-138） | 改訂後 |
| ---- | ------------------------ | ------ |
| 対象 | Web Editor の Local LLM と BYOK | 加えて、Electron の NIR-1 local 生成の route（loopback の TCP socket）。Electron の既存の chat 経路には広げない（restricted 下では拒否のまま。unrestricted での扱いはこの行の範囲外） |
| 開示 | data の種類、すべての処理者と目的、保存と保持、学習の扱い、policy の link | 同じ。処理者は「この socket で今待ち受けているプログラム」とし、正体を確かめられないこと、listener の置換、相手が外部へ転送しうること、送った bytes を取り戻せないこと、取消で相手の処理が止まる保証がないことを加える |
| 束縛 | policy の版、route、provider、実際の接続先 | 同じ。接続先は IP literal と port。加えて model の名前、開示した purpose の集合、開示の内容の digest も束縛する |
| 拒否 | 同意がない、開示が不完全、処理者が不明なら、送信の前に止める | 同じ。待ち受けているプログラムの保存や学習を確かめられないことは、「送信先の運用による」と開示すれば不完全とはしない（S10 の Web Editor の扱いと同じ） |
| 記録 | 内容と credential を含めない | 同じ。Electron のこの route は credential を使わない |

開示する項目:

1. 送るもの：利用者の入力、対象の Scene の本文の抜粋、承認済みの IR、Graph の Evidence、再認可された会話の履歴、固定の system prompt。credential は送らない。
2. 送信先：`http://127.0.0.1:<port>`（または `[::1]`）の `/v1/chat/completions` と、request に書く model の名前（「送信先と route の規則」の model の行に合うものだけを、ラベルの付いた専用の行に、名前に使えない文字で区切って示す）。処理者は、この socket で今待ち受けているプログラムである。Grimodex はそれが何かを確かめられない。
3. listener の置換：意図した server が止まっている間や、OS の設定によっては動いている間にも、別のプログラムが同じ port で待ち受けられる。その場合はそのプログラムが受け取る。Grimodex は検出も防止もできない。
4. 目的：執筆（Writing）とレビュー（Review）の生成。Grimodex はこの送信を自動では始めず、利用者の操作から始める設計にしている。ただしアプリは、画面からの開始の要求（この確認の要求を含む）が実際に利用者の操作によるものかを確かめられない（画面の部分が侵害された場合など）。自分で操作していないのにこの確認が出たときは、取消を選ぶ。
5. 送信先での保存、保持、ログ、学習、外部への転送：待ち受けているプログラムとその設定による。選んだ model によって外部の service で処理する server もある（例：cloud の model を持つ local の server、model の名前で外部の provider へ振り分ける proxy）。Grimodex は model の名前からそれを確かめられない。model を変えると、同意をやり直す。
6. アプリ側の保存：送信のたびに、request と応答を、そのとき開いている workspace の監査の記録と会話に保存する。この同意は workspace ごとではなく、このアプリの設定（profile）で開くどの workspace からの送信にも使われる。監査の記録は Scene を消しても残る。
7. 送った bytes は取り戻せない。取消は Grimodex の接続を閉じるだけで、相手の処理が止まる保証はない。
8. policy の版と link。送信先、route、provider、model、policy の版が変わると、同意をやり直す。

確認の流れ:

- 同意は Main の dialog で取る。Main は DSN §7 の `LocalSendConsent` の grant（60 s、同時に1件、sender と window に束縛、preview の時の route revision の digest を OCC に使う）を発行し、Native の writer が消費して記録を書く。dialog の display は、Native が開示の内容の digest の元になる構造化した項目から作り、上の 1〜8 をすべて含める（digest に含む項目と同じ集合。policy の link は URL の文字列で示してよい）。項目が欠ければ Native は preview を作らず、grant も発行されない。display に入る設定由来の値は、送信先の socket と model の名前だけで、どちらも「送信先と route の規則」で形を固定したものに限る（model の名前は S18 への対処として、1〜256 bytes の ASCII の印字可能な文字のうち、引用符（`"`、`'`、バッククォート）と `\` を除いたものだけ）。model の名前は、開示の 2 の中の、固定のラベル（表示の言語での「model の名前」など）の付いた専用の行に置き、その行にはラベルと区切りと名前のほかを置かない。名前の前後の区切りは、名前に使えない文字（「送信先と route の規則」の model の行の外の文字）のうち、名前に使える文字と見た目の似ていないものにする（例：「」や “ ”。全角の［］や〈〉のように、名前に使える ASCII の記号と似たものは使わない）。名前には空白、改行、引用符、非 ASCII の文字を含められないので、区切りを閉じたり、行を変えたり、見た目の似た区切りを作ったりして、名前の外に見える文を作れない。空白のない長い名前を message box が折り返さない OS に備えて、Native は名前を決まった幅（DD-1 が決める）で折り返し、続きの行を字下げで示してよい（名前は空白を含まないので、字下げを作れない）。名前の文字列そのものが誤解を招く語を含むことは防がない（開示の 5 が、model の名前から処理の場所を確かめられないことを示す）。renderer の表示は補助で、確認の根拠にしない。
- renderer は利用者の操作なしに同意の要求を出せる（In-scope attacks）。dialog は、既存の Main の確認の dialog（`electron/main/index.ts:323-325`）と同じく、既定のボタンと、Esc や閉じる操作の結果を取消のボタンにする（DSN §7.2）。加えて確認の checkbox を未選択で置き（文言は固定で、設定と renderer の値を含めない）、承認のボタンと checkbox の両方がそろったときだけ承認とみなす（K3 の draft の activation の dialog と同じ型）。それ以外の閉じ方では grant を発行しない。dialog は同時に1件で（DSN §7.1）、取消の後の要求には新しい preview から dialog を出し直す。利用者が読まずに checkbox と承認を選ぶことは残余として受け入れる（開示の 4 が、自分で操作していないのにこの確認が出たら取消を選ぶよう示す）。
- dialog は DSN §7.2 のとおり `dialog.showMessageBox` を使う（推奨）。1〜8 の文量（model の名前が上限の 256 bytes のときを含む）を 3 OS で切り詰めずに出せるか、利用者が読んで承認するまでの時間が grant の期限（60 s）に収まるかは未確認なので、DD-1 で確かめる（方法は「受入れに加えるもの」の dialog の試験。表示は journey seam の (a) だけを使って実物の dialog を出す起動で確かめ、seam の応答の置換では確かめない）。切り詰めるか、表示が display と違う（文字が markup や escape として解釈されるなど）OS があれば、その OS では Main が所有する専用の window に替える。その window はアプリの画面（renderer）と process と session を分け、Native の display だけを固定の local の page に text として描き（HTML として解釈しない）、外への navigation を拒否する。既定が取消で、承認に確認の checkbox を要することも同じにする。承認は Main がその window からのものであることを確かめて受け取る（grant の流れは同じ）。期限が足りなければ、`LocalSendConsent` の期限だけを、その種類の grant を初めて使う PR（DT-4 か DD-1）の merge の前に、K1b の規則で選び直す（ほかの種類の grant は変えない）。対案は「選択肢と推奨」の表。
- 実 Electron の journey（DD-1、E-1）で journey seam（必須防御の 17）が同意について置き換えるのは、dialog の応答だけである。preview（display の生成を含む）、issue、consume、同意の writer、期限、同時1件、sender と window の束縛は製品と同じ経路を通るので、journey でも同意の記録は grant を経てだけ書かれる。
- 同意の identity は、policy の版、route の種類、provider、送信先の socket、model の名前、開示した purpose の集合（Writing と Review）、開示の内容の digest とする。開示の内容の digest は、表示の言語に依らない構造化した項目から作る（表示の言語を変えても失効しない）。
- route revision（設定全体の digest。prep.rs:938）は identity に入れない。ほかの設定を変えただけで同意をやり直させないためである。grant の OCC には使う。この区別に合わせて DSN §7.3 を改める。
- model の名前は identity に入れる（推奨。対案は「選択肢と推奨」の表）。同じ socket でも、model によって処理する場所が変わる server がある（例：cloud の model を持つ local の server、model の名前で振り分ける proxy）。また renderer は restricted 下でも `save_ai_settings` で model を書き換えられる（S14）。identity に入れると、利用者が変えた場合も renderer が書き換えた場合も、model の名前を示す Main の dialog を通るまで送信 0 になる。Web Editor の同意は model を束縛しないが、この route はそれより厳しくする（policy の改訂の表の束縛の行）。model の名前は、設定から D-final が解決した値（prep.rs:893-897、:941。「送信先と route の規則」の model の行に合うものだけ）をそのまま比べ、正規化しない。監査と attempt にも model を残す。
- 照合は attempt の作成の前と、送信の開始の直前（接続の前。監査の start の後）に行う。直前の照合は、取消と同じ短い lock で送信の開始と直列化する。撤回や失効が開始の前に見えれば送信 0、開始の後なら取消にする。
- 同意の記録は profile ごとに置き、workspace や project には束縛しない。送信先は端末の socket で、D2a も profile 全体にかかるためである。1回の同意は、その profile で開くどの workspace からの送信にも使われ、監査の記録と会話は、送信のたびにそのとき開いている workspace に保存される（送信の owner が持つ pinned な DB。「監査」の節）。開示の 6 はこのとおりに示す。

### 生成出力の配信

- 出力を受け取れるのは、生成を始めた sender（Main が束縛した caller と epoch）だけとする。event で全窓に broadcast しない（DSN §4.3）。restricted 下での `chat:stream-*` の遮断（pe.ts:768-779）は変えない。
- 推奨は、renderer が typed な `continue` で上限の内側の差分を取りに来る形（Related Scenes の begin／continue と同じ型）。Native は毎回、caller、epoch、permit、owner を確かめる。D2a の区分は K3 の restricted 専用の区分（DSN §4.2 の仮称 `nir1-restricted-only`）による。
- 途中の出力は未確定として表示し、`succeeded` の終端と本文・receipt の保存の後だけ確定にする。次の turn で使えるのは、H-current の再認可を通ったものだけ。
- sender の destroyed、window の close、caller epoch の変化で配信を止め、生成を取消にする。
- 具体の形（取りに来る間隔、差分の上限）は DD-1 で決める。command の識別子は「IPC の command」の表のとおり。

### IPC の command（K3 の D-dispatch 行）

[K3 の draft](nir1-d2a-activation-proposal-1-draft.md)（未確認）は、`nir1-restricted-only` に command を加えるのは確認済みの契約がその command を名指すときだけとし、D-dispatch の command は K5 が名指して K5 の確認で加えるとしている。この行は、DD-1 がこの区分に加えてよい command を、次の識別子で名指す（役割と識別子は1対1）。引数の形と上限は DD-1 で決める（委任）。

| 役割 | command | 入力 | 返すもの |
| ---- | ------- | ---- | -------- |
| 生成の開始 | `nir1_local_generation_start` | typed な intent（purpose、会話、対象の Scene）。Main が caller と key の判定を添える。会話は「この route の会話の範囲」の 1 に当たるものに限り、purpose と Scene は会話のものと一致し、使う入力はその会話の current な capture だけ（同じ節の 3） | opaque な handle か、typed な unavailable（会話、purpose、Scene、capture が合わないときも、attempt を作らずにこれを返す） |
| 出力の取得（`continue`） | `nir1_local_generation_continue` | handle | 上限の内側の差分（text と thinking を分けたもの）と状態 |
| 取消 | `nir1_local_generation_cancel` | handle | なし |
| 同意の要求 | `nir1_local_send_consent_request` | なし（Native が現在の route から作る）。Main が横取りして dialog を出す（DSN §7.2。既定は取消で、承認に確認の checkbox を要する。「同意」の節） | 結果だけ |
| 同意の撤回 | `nir1_local_send_consent_revoke` | なし | 結果だけ |
| 同意の状態の読取 | `nir1_local_send_consent_status` | なし | 同意の有無と、現在の route と一致するかだけ |
| この route の会話の作成 | `nir1_local_conversation_create` | purpose と対象の Scene（capture は Scene に束縛された会話でしか作れない。gendb.rs:2293-2338）。Native が新しい会話の行を作り、この route の印と purpose を同じ transaction で書く（「この route の会話の範囲」の 1） | 作った会話の ID と表示名だけ |
| この route の会話の一覧 | `nir1_local_conversation_list` | なし | pinned な workspace の DB にある、この route の会話（同じ節の 1）の ID と表示名だけ |
| この route の会話の読取 | `nir1_local_conversation_read` | 会話の ID と範囲 | その会話の、「この route の会話の範囲」の 2 に当たる行だけ（利用者の入力と生成の出力。text と thinking。上限の内側）。restricted 下で renderer に平文を返す。同じ節の 1 に当たらない会話は typed に拒否し、この route 以外の会話（ほかの chat の会話と、restricted になる前の会話）、この route の会話の中の 2 に当たらない行、監査の記録は返さない（それらの表示は、K3 が O-2 として別の draftRef に回した範囲） |

- どれも main が発行した caller を要し、結果は invoke への応答としてだけ返す（event で配信しない）。K3 の区分の条件を満たさなければ拒否する。
- restricted 下で renderer に平文を返すのは、`nir1_local_generation_continue`（起動した sender への生成出力の差分）と `nir1_local_conversation_read`（この route の会話の、「この route の会話の範囲」の 2 の行）の2つだけである。作成と一覧が返す表示名は、Native が形を確かめた平文でない値（印から読んだ purpose、時刻として解釈できた作成の時刻など）だけから作り、会話の内容と利用者の入力を含めない。`chat_sessions` の title などの文字列の列は、そのまま返さない。K3 の draft は、restricted 下で会話や AI の出力を返す command を閉じたうえで、local 生成の会話の表示を K5／DD-1 に委ねている。この2つは、その面をこの route の会話に限って、この行の確認で開くものである（K3 の draft の O-2 とは別で、O-2 の確認の有無に依らず、O-2 を確認してもこの表は広がらない）。この面を広げること（返す平文の範囲を増やすこと、表示名に会話の内容を入れること、「この route の会話の範囲」を広げることを含む）には、再確認を要する。
- PUB-L の前は、どれも Main と Native の gate で拒否する（必須防御の 16）。journey seam が有効な起動でだけ、この表の command に限って開ける（必須防御の 17）。
- `nir1_local_send_consent_request` は、DSN §7.2 の `GRANT_REQUIRED_COMMANDS` に `LocalSendConsent` として載せる。
- 新しい schema は加えない。この route の会話の範囲は次の節のとおりで、DD-1 はその 1 の印と purpose を既存の schema の中に置く。置けなければ `[precheck]` で止まり、attempt や capture の有無などの別の判定で代えない。
- 識別子を変えること、これ以外の command をこの区分に加えること、役割を増やすことには、再確認を要する（「再確認が要る変更」）。

### この route の会話の範囲（S20）

restricted 下で平文を返す読取面と、生成を始める入口は、同じ「この route の会話」の定義を使う。定義は session と行の2段で、平文の境界は行の段で引く。capture の入口（`capture_current_chat_input`）は restricted 下でも Scene に束縛されたどの会話も受け付け、`chat_sessions` にはどの経路が作った会話かを示す列がない（S20）。そのため、この区別は生成の開始と読取の側で行う。capture の入口とその区分（K3 の draft の D-final の行、DSN §4.3）は変えない。

1. session：`nir1_local_conversation_create` が restricted の下で作った `chat_sessions` の行だけを、この route の会話とする。
   - Native はこの command の中で、Native が決めた新しい ID の行を strict な INSERT で作り（既存の行を流用しない）、対象の Scene（live な Scene の node）に束縛し、purpose と、この command が作ったことを示す印を、同じ transaction で書く。印と purpose の置き場と形は、DD-1 が既存の schema の中で決め（たとえば、Native が決める ID の予約した接頭辞）、作業記録に残す。title など表示に使われうる列に、会話の内容と利用者の入力を入れない。
   - 印はこの command のほかでは書かず（import などのほかの writer も、印を持つ行を作らない）、既存の行に後から付けない。restricted になる前からある会話、ほかの chat の会話、ほかの経路が作った会話は、後から capture や attempt を持っても、この route の会話にならない。attempt や capture を持つこと、Scene に束縛されていること、title や model の列の値を、この route の会話の判定に使わない。
   - 一覧と読取は、pinned な workspace の DB にある、1 に当たる会話だけを扱う。一覧と読取を呼べるのは、その workspace の登録済みの caller で、会話を作った caller や window と違ってもよい（cold reopen の後は caller が変わるため。l6-l9:534、:555）。生成中の出力の差分（`nir1_local_generation_continue`）だけは、起動した sender に限る（「生成出力の配信」）。
   - `chat_sessions` は、restricted の下では renderer の汎用 SQL で読めず書けないが、unrestricted の間（activation の前と、K3 の draft の F-1 で戻った後）は書ける（S20）。印をその間に書ける置き場に置くと、印は偽造されうる。偽造された会話でも、読取が返すのは 2 の行だけで、生成の request に入る履歴は、確認済みの `history-reauthorization`（来歴のない旧履歴を資格にしない。l6-l9:534）と K4 の規則（capture の lineage）によるので、平文の範囲は広がらない。印の偽造そのものは防がない（Out-of-scope attacks）。平文の境界は 2 で引く。
2. 行：`nir1_local_conversation_read` が返すのは、1 の会話 S の中の `chat_messages` の行のうち、次の (a) か (b) に当たるものだけである。
   - (a) 利用者の入力：#611 の capture の writer（gendb.rs:2524-2657）が受理し、`nir1_chat_input_captures` に記録した行（その capture の session が S で、message がその行のもの）。capture の状態（current、superseded、cancelled、closed）は問わない。
   - (b) 生成出力：この route の attempt（session が S で、binding の provider と api が、この route の D-final が書く値のもの。現行は prep.rs:939-942）が、成功の終端で書いた行（その attempt を親とする generated の message version を持つもの。gendb.rs:3198-3217）。
   - どちらも、その行の message version が失効しておらず、既存の reader（gendb.rs:2071-2112）で role、本文、thinking、作成時刻の digest の一致を確かめたものに限る。返す thinking は、確かめた行の `thinking_blocks` だけとする。attempt の終端の状態（平文を含まない）は返してよい。
   - 次は内容を返さない：capture のない user の行（restricted になる前の行、unrestricted の間に足された行、`bind_human_message` で束縛しただけの行を含む）、この route 以外の attempt の出力、system の行、失効した version や digest の合わない行、`chat_message_prompts`、`chat_summaries`、`chat_sessions` の title、監査の記録、ほかの会話の行。(a) か (b) に当たる行で検証に失敗したものは、内容を含まない typed な理由と ID だけで示してよい（DD-1 が決める）。それ以外の行は、件数も返さない。
   - (a) と (b) の識別に使う表（`nir1_chat_input_captures`、`nir1_generation_message_versions`、`nir1_generation_attempts`）は protected writer の表で、renderer の汎用 SQL はどの profile の状態でも書けない。capture は restricted の下でだけ作られ、既存の chat の行を昇格させない（S20）。そのため 2 の行は、restricted の下で利用者がこの route の会話に入力したものと、この route の生成出力に限られる。
3. 生成の開始：`nir1_local_generation_start` は、指定された会話が 1 に当たり、intent の purpose が会話の purpose と同じで（Review は Writing と別の会話で行う。l6-l9:514）、対象の Scene が会話の Scene と同じときだけ受け付ける。使う入力は、その会話の current な capture（caller と owner が D-final の規則で一致し（prep.rs:469-494）、capture の session と Scene が会話と一致するもの）だけとする。どれかに合わなければ、attempt も送信も 0 にして typed に拒否する。renderer は `capture_current_chat_input` で、1 に当たらない会話にも capture を作れるが（既存の振る舞い）、その capture はこの route では使わない。
4. 既存の schema で 1 の印と purpose を置けない場合（既存の列の意味と衝突する、既存の chat の画面と共存できないなど）、DD-1 は `[precheck]` で止まる。attempt や capture の有無などの別の判定で代えない。新しい schema に置く案は、新しい draftRef の確認を要する（「選択肢と推奨」の会話の識別の行）。2 と 3 は、既存の保存（capture、message version、attempt）だけで作れる。

### D-final の追補（DF+-b）の範囲

1. route の検証を「送信先と route の規則」に合わせる。`localhost` と 127/8 全体を許す判定（prep.rs:998-999）と port の解析（prep.rs:993-997）を改め、試験（prep.rs:6075-6094）を反転し、負例（host 名、`127.0.0.2`、`[0:0:0:0:0:0:0:1]`、`::ffff:127.0.0.1`、`+1234`、`01234`、`0`、`65536`）を足す。
2. payload に `"stream": true` を加える（prep.rs:1210-1217）。キー数の断言（prep.rs:2125-2128）と DF-06 の payload digest を更新する。DF-06 の fixture の JSON（`test-fixtures/nir1-df06-plain-chat.json`）は token 数と escape の vector だけを持つので、変わらない見込み。
3. purpose に Review を加える（現行は Writing に固定。prep.rs:573）。purpose は Main が検証した typed な intent から取り、renderer の文字列からは取らない。Review は Writing と別の会話で行い、Review の出力を Writing の履歴へ移さない（l6-l9:514。会話の purpose との照合は生成の開始で行う。「この route の会話の範囲」の 3）。Review 用の固定の system prompt を足すなら、AI 指示の変更として grimodex-author と impact-gate を通し、template の ref と version を request の metadata に束縛する。
4. Main が生成の開始の時に判定した key の有無（「送信先と route の規則」の key の行）と、判定した endpoint の id を受け取り、attempt を作る前に確かめる（値は永続化しない）。key があるか判定に失敗していれば attempt を作らず、endpoint の id が route の解決の結果と違えば unavailable にする。送信の直前には確かめ直さない（「失効」の key の行）。負例に、endpoint 固有の account の key、id が `default` の endpoint で旧 account（`grimodex-user`）にだけある key、判定の失敗、endpoint の id の不一致を含める。
5. renderer の判定（`src/application/chat/chatTurnLifecycle.ts:103-120`）を、IP literal だけを認める形に合わせる（DSN §6.3）。
6. endpoint identity の digest を「route の identity」から作る（credential と raw URL を含めない）。
7. model の名前を「送信先と route の規則」の model の行で検査する（prep.rs:893-897 の検査を強める。S18）。負例に、改行、CR、タブ、制御文字、空白、`"`、`'`、バッククォート、`\`、非 ASCII（双方向の制御文字と全角の文字を含む）、257 bytes の名前を含め、規則が許す文字だけの 256 bytes の名前（許す記号をすべて含むもの）の正例を足す。

範囲の外: 履歴の入力（HC-1）、transport（DT-5）、Ollama、同意の UI（DD-1）。受入れには A-1（送信も attempt も作らない）を含める。

### transport の実装方針（DT-5a／b）

- 依存を加えない。std の `TcpStream` と HTTP/1.1 の最小の実装（request の書込み、status と header、chunked、`Content-Length`、close）で作る。`electron/native/grimodex-node/Cargo.toml` と `Cargo.lock` は dataset の source に含まれる（`scripts/local-ci-full-workload-allocation.json:58-65`、`scripts/ci-pause.test.mjs:1807`）。transport はこれらを変えないので、dataset の更新と、#618（reqwest の更新）との衝突を避けられる。recorder を評価専用の cargo feature の bin として置くときは Cargo.toml が変わる（依存は加えない）ので、その PR で dataset を更新する。
- 既存の provider の client は使わない。`reqwest::Client::new()` の既定（S7）、429 の再送の helper、読めない event を読み飛ばす SSE の処理は、この行の規則と合わない。
- 1 attempt に1本の専用 thread を使い、blocking の I/O と読み書きの timeout で待ちを区切る。tokio の task や `.await` をまたいで socket を持たない。
- 取消では、owner が持つ socket の clone で `shutdown` を呼んで受信を止め、thread を join する。seam の observer は通知だけを行い、socket の操作を Core の mutex の中でしない（DSN §1.10）。
- parser は bytes を受けて event と終端を返す純粋な関数にし、試験 vector（すべての byte 位置での分割を含む）で固定する（DT-5a）。
- HTTP の recorder は、製品の process の外で loopback の port で待ち受ける HTTP の server とし、置き場は必須防御の 16 のとおりにする（K6 の draft の「評価専用の呼び出し口」の隔離に従う。たとえば評価専用の cargo feature を要する bin）。試験用の transport の差替えは作らず、製品の client と transport は recorder を区別しない。
- 取消から close と join までが有界であることを 3 OS で試験する（shutdown の挙動が OS で違いうるため）。join の上限の超過も注入し、終端が1回だけで、gate が quarantine され、切り離した thread の観測が捨てられることを確かめる（「DT-5 の owner/lifecycle matrix が満たす条件」の cancellation）。

### DT-5 の owner/lifecycle matrix が満たす条件

DT-5 の matrix は、この行の確認の後に DT-5 の decisions で作る（DSN §1.10）。matrix は少なくとも次を満たす。

| 区分 | 条件 |
| ---- | ---- |
| entry | 送信を始めるのは、claim を commit した DT-2 の owner だけ。renderer の値からは始めない |
| start | 送信の開始（接続と、その後の最初の byte の書込み）は、取消と同じ owner の短い lock で直列化する。接続の前に、監査の start の3件が durable であることと、gate、lease、permit、route、同意を確かめ、どれかが欠ければ接続せずに送信 0 の終端にする |
| retry | 自動の再送、再接続、別の address への切替をしない。新しい attempt は利用者の新しい操作からだけ作る |
| reentrant | 同じ attempt の送信は最大1回（DG-2）。in-flight は capture submission identity ごとに1件（DT-2） |
| admission closure | seam の edge、D2a の失効、route の変更、同意の失効、sender の destroyed で閉じる。開始の前なら送信 0、開始の後なら取消 |
| pending start | claim の後で送信の開始の前に閉鎖を観測したら、送信 0 の終端を一度だけ書く（DT-2 の matrix と同じ） |
| active handle | socket、受信の buffer、parser は transport の thread だけが持つ。thread は解釈した観測（text と thinking の差分、終端）を上限のある channel で owner に渡し、OutputObserver と配信用の差分は owner の側で持つ（join が上限を超えても、owner が受け取った観測から終端を書けるようにするため）。取消のための socket の clone は owner が持ち、Core の mutex の中では使わない。participant と DT-1 の lease は owner が終端まで持ち、終端を書いた後に放す |
| cancellation | 取消は flag を立て、socket の shutdown で受信を止める。取消と終端の決定は owner の lock で直列化し、先に決まった方を一度だけ書く。取消から join までが上限（K1b）を超えたら、owner はそれまでに channel で受け取った観測から取消の終端を1回だけ書き、join を待たずに thread を切り離し、gate を quarantine する（DSN §1.10 の意味。同じ Ready entry では開け直さない）。切り離した thread の以後の観測と socket は捨て、二度目の終端も監査の event も書かない（監査は終端の後の append を拒否する。audit.rs:1141-1146）。thread は、切り離された後も socket の読み書きの timeout で終わるように作る |
| bounded wait | 接続、書込み、最初の byte、event の間隔、全体、`[DONE]` の後の body の終わり、取消から join までに、それぞれ期限を置く（K1b）。HTTP を待つ間は DB mutex、profile や lifecycle の lock を持たない |
| 終了の証拠 | socket の close、thread の join、終端の行が durable であること（書けなければ sweep に委ね、gate を quarantine する）。join が上限を超えたときは、終端の行と gate の quarantine を終了の証拠とし、切り離した thread の終わりは待たない。相手が処理を止めた証拠とはみなさない |
| error／timeout／onClosed | 送信の前の失敗は送信 0 の終端、送信の後の失敗は `failed + invalid + required`。sender の destroyed と window の close は取消に結ぶ |
| restart | 送信中の状態は永続化しない。再起動の後は sweep が保守的な終端と監査の終端を同じ DB に書き（「監査」の節）、再送しない |

### 数値（K1b）

| 上限 | 制約 |
| ---- | ---- |
| 接続の期限 | loopback なので短くてよい |
| request の書込みの期限 | payload は D-final の上限（16 MiB。prep.rs:47）の内側 |
| 最初の byte までの期限 | model の読み込みを含みうるので、ほかの期限と分ける |
| event の間隔の期限 | 止まった相手を見つけるため |
| 全体の期限 | `max_tokens` と遅い CPU 推論を考えて、実測から選ぶ |
| header、1 つの event、body 全体の bytes | allocation の前に検査する |
| text と thinking の bytes | それぞれ既存の保存の上限（2 MiB。gendb.rs:40、:3129-3130）以下にする。超えたら失敗 |
| thread から owner への channel | 件数と bytes の上限。満ちたら thread は socket の読取を止めて待つ（その間も取消と期限を観測する） |
| `[DONE]` の後に body の終わりを待つ時間 | 短くする |
| 取消から join までの時間 | owner は participant と DT-1 の lease を終端まで持つので、取消から終端の書込みまでの時間は workspace の transition を待たせる時間になる。DT-1 の drain の上限（250 ms）と合わせて選び、transition との関係を DT-5 の matrix に書く。超えたときは matrix の cancellation の行のとおり、終端を1回だけ書いて thread を切り離し、gate を quarantine する |
| 監査の書込み | DT-2 と同じ（DB mutex、busy、操作ごとの期限）。既存の append の期限なしの mutex の待ちと 5 s の busy timeout（S16）は使わない |

- 数値は DT-5a で主要な local server を実測して integrator が選び、値、単位、検査する位置、超えたときの結果、実測の条件を PR 本文と作業記録に残す（K1b の規則 5）。厳しくするのは、その lane の正例の受入れを保つ範囲で確認なしに行え、merge 後に緩めるには再確認を要する（K1b の規則 6、7）。
- K1b は確認済みなので（「前提の更新」）、これらの数値に個別の確認は要らない。既存のコードの上限（D-final の payload の 16 MiB、本文の保存の 2 MiB）は、この行では変えない。

### 委任で決めるものと再確認が要る変更

U3 の委任で決めてよいもの（この行の範囲の内側に限る）:

- parser と client の内部構造、thread の作り方、試験 vector の作り方。
- thinking の allowlist への field の追加（text と thinking の分離と、失敗の規則を保つ場合）。
- 監査の event の粒度（full-observable を保つ範囲。start の3件と終端の順は「監査」の節のとおりで、変えない）。
- route、owner、file の名前と、同意の file の形式（command の識別子と役割は「IPC の command」の表で固定する）。
- 監査の予約した namespace の接頭辞の名前と ID の形（拒否の規則は「監査」の節で固定する）。
- journey seam の env の名前と値、receipt の形（有効になる条件と置き換える範囲は必須防御の 17 で固定する）。
- 出力の配信の具体の形と、K1b に従う数値。
- 同意の dialog を、「同意」の節の条件で専用の window に替えること（DD-1 で message box の切り詰めか、表示が display と違うことが見つかった OS に限る）。
- dialog で model の名前を囲む区切りの文字と、ラベルと checkbox の文言（「同意」の節の条件を満たす範囲）。
- この route の会話の印と purpose の置き場と形（既存の schema の中で、「この route の会話の範囲」の 1 と 4 の条件を満たす範囲。選んだものを作業記録に残す）。行の段で検証に失敗した行を、内容を含まない typed な理由と ID で示すかどうか。

再確認が要る変更（新しい draftRef で確認を得てから行う）:

- 送信先を広げること（host 名、ほかの address、LAN、TLS、ほかの path や API、Ollama の native API）。
- credential を送ること。proxy、redirect、自動の再送を使うこと。
- 終端の規則を緩めること（`stop` と `[DONE]` の間の usage だけの event を許す、non-stream への切替や fallback など）。
- 監査を partial-observable にすること。renderer か Main の汎用の append に、この route の path ID か予約した namespace の event を書かせること。
- 同意を省くこと、同意の identity を弱めること（model を外すことを含む）。model の名前の規則と、dialog での名前の置き方の条件（ラベルの付いた専用の行と、名前に使えない文字の区切り）を緩めること。同意の dialog の既定のボタンを取消以外にすることと、確認の checkbox を省くこと。journey seam は dialog の応答だけを置き換え、grant と同意の記録を省かないので、「同意を省くこと」に当たらない。
- journey seam の条件を緩めること（packaged build に置くこと、exact でない env で有効にすること、dialog の応答のほかを置き換えること、`LocalSendConsent` 以外の grant を承認すること、表にない command を開けること）。
- purpose を増やすこと。自動の生成を入れること。出力を broadcast すること。IPC の command の識別子を変えること、役割を増やすこと、restricted 下で平文を返す面を広げること（「IPC の command」）。「この route の会話の範囲」を広げること（印のない会話をこの route の会話に含めること、attempt や capture の有無で会話を判定すること、行の段に当たらない行の内容を返すこと、生成の開始にこの route の会話でない会話を許すこと）と、印を新しい schema に置くこと。
- merge 後に K1b の数値を緩めること。

Required confirmation evidence is the exact statement: `I confirm draftRef nir1-d2b-local-send-proposal/2 for contractId nir1-local-product-send.`

## 選択肢と推奨

| 論点 | 推奨 | 対案 | 理由と対案の影響 |
| ---- | ---- | ---- | ---------------- |
| wire | SSE（`stream: true`）。終端の規則は厳格 | non-stream（`stream` なし、1つの JSON） | SSE は DG-4 を本番の wire でそのまま試せ、途中の表示と止まった相手の検出ができる。non-stream は parser が単純になるが、chunk の分割、終端の重複、終端の後の data、text と thinking の交互の到着が本番の wire では起きないので、DG-4 のその部分を N/A にする受入れの変更が要る。生成が終わるまで何も表示できない。payload の `stream` を変えないので、DF-06 の digest の更新は要らなくなる |
| Ollama の native API（`/api/chat`、NDJSON） | 後続（別の draftRef） | この行に含める | parser、route、同意、試験が1組増える。Ollama も OpenAI 互換の `/v1/chat/completions` を出すので、終端の形式が規則に合えば v1 でも使える（DT-5a で実測する） |
| 監査 | full-observable | partial-observable（digest だけを残し、省いた値を宣言する） | GDX-AI-AUDIT-001 の既定で、ほかの chat の route と同じ。partial にすると、帰属の report で原稿を含む request を確かめられない。保存が増える点は、同意の開示でアプリ側の保存として示す |
| 監査の書込みの閉じ方（S17） | 汎用の append と Main の IPC の検証で、この route の path ID か予約した namespace の ID を持つ event を拒否する。Native の owner と sweep は専用の append で書く | (a) 汎用の append を、registry で renderer か Main が所有すると登録した path だけに限る（allowlist）。(b) 閉じない（偽の記録と終端の差込みを残余として受け入れる） | 推奨は変更がこの route の範囲に収まり、既存の renderer、Main（Codex）、Native（post-effect、semantic）の監査を変えずに、この route の execution の偽造、終端の差込み、ID の先回りを防ぐ。この route 以外の path への renderer の書込みは残る（Out-of-scope attacks）。(a) はほかの path にも効くが、既存のすべての監査の経路に registry との照合が入り、変更と試験が既存の route に広がる（採るなら別の draftRef か、既存の欠陥の修正として扱う）。(b) では、帰属の report にこの route の偽の送信の記録が残りうる。終端の差込みで Native の終端の書込みが失敗し、attempt が未終端のまま gate が quarantine される。full-observable と「既存の validator を通る」の受入れの前提が成り立たない |
| 同意の記録の置き場 | profile 側の Native の file | workspace の DB／Main の設定 | 送信先は端末の socket で、workspace に属さない。D2a も profile 全体にかかる。workspace の DB に置くと restore や workspace の切替で同意が変わり、Main の設定に置くと Native が照合できない |
| 同意の粒度 | Writing と Review をまとめて開示し、1回の同意 | purpose ごとに同意 | 両方を開示すれば GDX-AI-CONSENT-001 を満たす。purpose ごとにすると確認の回数が増える。purpose を増やすときは開示が変わるので、同意をやり直す |
| model を同意の identity に入れるか | 入れる。model を変えると同意の記録が消え、model の名前を示す Main の dialog で同意し直すまで送信 0 | (a) 入れない（renderer による model の切替を残余として受け入れる）。(b) identity には入れず、同意の時の model を記録に残し、今の model と違えば unavailable にする（記録は消さない） | 同じ socket でも、model によって処理する場所が変わる server がある。たとえば sign in した Ollama で cloud の model を選ぶと、同じ `127.0.0.1:11434` の `/v1` で受けた request を Ollama の cloud（ollama.com）で処理する。LiteLLM のような local の proxy は、model の名前で外部の provider へ振り分ける。さらに renderer は restricted 下でも `save_ai_settings` で model を書き換えられる（S14）。推奨では、利用者の切替にも、侵害された renderer の無断の切替にも、Main の dialog での確認が挟まる。代わりに model を変えるたびに確認が1回増え、Web Editor の同意（model を束縛しない）より厳しくなる。(a) では、renderer が外部で処理される model に切り替えてから生成を始めると、確認なしに原稿が外部の service に届く。これは In-scope attacks の残余になり、開示の 5 だけで扱うことになる。(b) も切替を止めるが、元の model に戻すと確認なしで使え、失効の規則が2種類になる。確認の回数は推奨とほぼ変わらない |
| dialog に出す model の名前の規則（S18） | 1〜256 bytes で、ASCII の印字可能な文字（0x21〜0x7E）のうち `"`、`'`、バッククォート、`\` を除いたものだけ。合わなければ unavailable。dialog では、ラベルの付いた専用の行に、名前に使えない文字で区切って置く | (a) Unicode の1行（制御文字、書式の文字、行と段落の区切り、双方向の制御文字を除く）で、256 bytes まで。(b) 規則を置かず、dialog の側で escape と切り詰めをする。(c) 0x21〜0x7E をすべて許し（引用符と `\` を含む）、区切りだけを名前に使えない文字にする | 一般的な model の名前（Ollama の `llama3.1:8b` や `hf.co/<user>/<repo>:<tag>`、repo 形式の名前など）は、引用符と `\` を使わない ASCII の印字可能な文字で書ける見込みで、DT-5a で主要な server を実測して確かめる。名前は、ラベルの付いた専用の行の、名前に使えない文字の区切りの内側にだけ出る。改行・空白・制御文字・双方向の制御文字・引用符・非 ASCII の文字を含められないので、区切りを閉じたり、行を変えたり、見た目の似た区切りを作ったりして、名前の外に見える偽の開示を作れない。区切りの内側の文字列そのもの（誤解を招く語や、`l` と `1` のような紛らわしい文字）は防がず、開示の 5 で扱う。上限の 256 bytes で開示が切り詰められず、記号が解釈されずに表示されることは、3 OS の表示の確認で確かめる。代わりに、空白、引用符、`\`、非 ASCII の文字を含む名前は使えない（Windows の path の形の名前を含む。server の側で別名を付ければ使える）。(a) は非 ASCII の名前を使えるが、検査する文字の分類が増え、見た目の似た文字（区切りに似た文字を含む）が残る。(b) は OS の dialog ごとに escape と切り詰めの見え方が変わり、display と開示の digest の一致を試験で固定しにくく、長い名前による押し出しも残る。(c) は使える名前が少し増えるが、区切りに “ ” などを使う表示の言語では `"` が見た目の似た区切りになり、区切りの選び方に制約が残る |
| 利用者の操作によらない同意の要求 | 既定のボタンと、Esc や閉じる操作の結果を取消にし、承認には確認の checkbox を要する。繰り返しの要求で読まずに承認されることは残余として受け入れる | (a) 既定のボタンを取消にするだけで、checkbox を置かない（DSN §7.2 のまま）。(b) 同意を Main が所有する入口（application の menu など、renderer から起こせないもの）からだけ始め、renderer の要求では dialog を出さない。(c) 推奨に加えて、取消か時間切れの後の一定の間（DD-1 が決める）は、同じ sender の要求で dialog を出さずに拒否する | renderer は利用者の操作なしに同意の要求を出せ、Main は要求が利用者の操作によるかを確かめられない。推奨では、Enter や反射的な1回の click では承認にならず、2つの操作がそろって初めて承認になる。K3 の draft の activation の dialog と同じ型で、Electron の message box の checkbox で作れる。代わりに同意のたびに操作が1つ増える。(a) は操作が少ないが、反射的な1回の click で承認になる。(b) は renderer が dialog を出させる経路をなくせるが、生成の画面から同意に進めず、利用者は menu を探す必要がある。Main の入口と、その journey の操作が新しく要る。(c) は催促の回数を減らせるが、間をおいた催促は残り、誤って取消した利用者はその間を待つことになる |
| この route の会話の表示（restricted 下の平文の読取面） | この行で開く。`nir1_local_conversation_read` は、この route の会話の、#611 の capture が受理した利用者の入力と、この route の成功の出力の行だけ（「この route の会話の範囲」の 2）を、caller と K3 の区分の条件を満たすときに、invoke の応答で上限の内側に返す。作成と一覧は ID と、平文でない表示名だけを返す | (a) この行では開かず、O-2 か新しい draftRef で確認する（この行では生成中の出力の差分だけを返す）。(b) 表示名に会話の内容（最初の入力など）を使う | l6-l9:534 は不適格な履歴も UI の表示に残すことを求め、L9 の必須機能は適格な自会話履歴の継続を含む（l6-l9:555）。この route は restricted でしか使えないので、ここで会話を表示できなければ、reload や再起動の後に、利用者は過去の生成と、次の turn に使われうる履歴を見られない。restricted 下では外への経路が閉じており（K3）、この面の平文は renderer の表示に届くだけで、送れる先は同意した socket に限られる。返す行を行の段に限るので、同じ会話に restricted になる前の行や、ほかの経路が足した行があっても、それらは返らない。(a) では、その確認まで DD-1 の会話の表示と E-1 の cold reopen の journey が止まる。(b) は会話を見分けやすいが、一覧も平文の読取面になり、確認の範囲が広がる |
| この route の会話の識別（session の段。S20） | `nir1_local_conversation_create` が会話を作るときに、Native が既存の schema の中に置く印（置き場と形は DD-1。たとえば Native が決める ID の予約した接頭辞）で決める。平文の境界は行の段（「この route の会話の範囲」の 2）で引く。印を置けなければ DD-1 は `[precheck]` で止まる | (a) protected writer の新しい列か表に印を置く。(b) 印を置かず、すべての行が行の段に当たる会話を、この route の会話とみなす | 推奨は新しい schema を加えずに作れ、平文の範囲を行の段で閉じる。印は unrestricted の間（activation の前と、K3 の draft の F-1）に renderer が偽造しうるが、偽造しても読取が返すのは行の段の行だけで、生成の request に入る履歴は確認済みの `history-reauthorization` と K4 の規則によるので、平文の範囲は広がらない。(a) は偽造も防げるが、schema の変更（採番、restore の allowlist、protected writer の登録）が要り、この行の「新しい schema は加えない」を変えるので、新しい draftRef が要る（DD-1 に1〜2日。推定）。(b) は印が要らないが、restricted になる前の空の会話も含まれる。最初の生成の前は purpose を置く場所がなく、Review と Writing の分離を attempt の binding からしか確かめられない。判定の費用は会話の行の数に比例する。attempt や capture を持つ会話をこの route の会話とみなす案は採らない。capture の入口は restricted 下でも Scene の会話を受け付けるので（S20）、restricted になる前の外部 AI の会話が、capture を1つ足すだけでこの route の会話になる |
| 開始の後に保存された key | 残余として受け入れる。判定は Main が開始の時に1回だけ行い、その attempt には影響させない（「失効」の key の行） | openai-compatible の `save_api_key` と `delete_api_key` を Native の permit の revoke に結び、in-flight の attempt を取消にする | credential はどちらでも送らないので、窓の間に起きうるのは、key が要る server に key のない request が1回届くことだけである。対案は Main の key の経路（S14）に Native の呼出しを足す変更が要り、取消にしても届いた bytes は戻らない |
| 同意の確認の UI | Main の `dialog.showMessageBox`（DSN §7.2）。DD-1 で 3 OS の表示と読む時間を確かめ、切り詰めるか表示が display と違う OS では専用の window に替える（「同意」の節の条件） | 最初から専用の window にする／message box を2枚に分ける | message box は OS の部品で、renderer から偽装できず、DSN §7 の仕組みにそのまま乗る。ただし 8 項目を切り詰めずに出せるかは未確認である。専用の window は表示の自由が大きいが、新しい window と page の面が増える。2枚に分けると、grant の期限（60 s）の中で2回の操作が要る |
| PUB-L の前の journey の通し方 | journey seam（非 packaged の build で exact な env があるときだけ有効。この route の command の gate と、`LocalSendConsent` の dialog の応答だけを置き換える。K3 の draft の journey seam と同じ型）。3 OS の dialog の表示は、seam で gate だけを開けて実物の dialog を出す起動で、手動で確かめる | (a) K2 の draft の CI seam と同じ条件（加えて `CI=true`、runner の owner token、起動ごとの nonce、Main の receipt）にする。(b) seam を置かず、journey の受入れを手動の確認に置き換える | 推奨は既存の journey seam（S19）と K3 の draft の seam と同じ条件で、E-1 の journey の harness にそのまま乗る。packaged build には存在しない。(a) は有効にする条件が厳しくなり、同じ OS ユーザーの process が非 packaged の build を起動して承認させる余地を狭める。ただし harness に token と nonce の受け渡しが要り、K3 の seam と条件がそろわない。製品（packaged build）への影響は推奨と変わらない。(b) では、recorder の接続数、送った bytes と payload digest の一致、取消、失効を実 Electron で自動に確かめられず、E の独立受入れの証跡がそろわない |
| transport の実装 | 依存を加えない std の HTTP/1.1 | reqwest を proxy と redirect を切って使う／新しい crate | std には proxy、redirect、再送、接続の pool が構造上なく、接続先を `SocketAddr` に固定できて名前解決が入らず、lock file と dataset を変えない。reqwest は既定の振る舞いをすべて止める必要があり、依存の追加で lock が変わる。HTTP の解析を自前で書く危険は、試験 vector と小さい対象（loopback、1 接続、HTTP/1.1）で抑える |
| listener の正体 | 開示だけ（v1） | OS の API で待ち受けの process を調べ、実行 file に同意を束縛する | OS ごとに違い、調べた後に置き換わる余地が残り、暗号的な保証にもならない。新しい OS API と権限の面が増える。採るなら別の draftRef |
| 出力の配信 | renderer が `continue` で取りに来る | Main が起動した sender にだけ push する／終端の後にまとめて返す | 既存の typed IPC と D2a の区分の仕組みに乗り、event の allowlist を増やさない。push は sender ごとの channel が新しく要り、まとめて返すと途中の表示ができない |

## critical path への影響

- この行は local の鎖（K4・K5 → DF+ → DT-5／HC-1 → DI-1 → DD-1 → PUB-L）の上にある。Session B（D+3〜5）で推奨のまま確認されれば、DF+-b と DT-4 はすぐ始められ、DT-5a／b は DT-1〜3 の merge を待つだけになる（K1b は確認済みで、数値は DT-5a の実測から選ぶ）。続行計画の目安（PUB-L は D+30〜35）は変わらない。DT-4 には、監査の bounded な append と sweep の追加（S16。既存のコードの変更）が加わるが、DT-4 の中で吸収できる見込みである。
- 確認が遅れた日数だけ、DF+-b → DI-1c → DD-1 → PUB-L が後ろにずれる。DT-1〜3、DF+-a、HS-1、HC-1、DI-1a と、Graph の鎖（PUB-G）は止まらない。
- 確認されなければ、DF+-b、DT-4、DT-5、DD-1、PUB-L は `[precheck]` で止まる。local の本文生成は L9 の必須機能（l6-l9:555）なので、NIR-1 Complete に届かない。
- non-stream を選ぶ場合（推定）: 新しい draftRef の起案と確認で、確認の往復が1回増える。DT-5a の parser は少し軽くなるが、DG-4 の受入れを変える文書と試験の作り直しがあり、差はほぼ相殺される。利用者の待ち時間の表示も失う。
- Ollama を含める場合（推定）: 新しい draftRef の確認に加えて、DF+-b（payload と thinking の分離）、DT-5a（NDJSON の parser と試験 vector）、DD-1（同意と表示）にそれぞれ1〜2日（目安）を足す。その分 PUB-L も遅れる。
- 同意の identity の対案（model を入れない (a)、記録を消さない (b)）や、key の窓・同意の UI・同意の要求への防御の対案を選ぶ場合（推定）: どれも新しい draftRef の確認で往復が1回増える。実装の差は小さい（同意の要求の (b) では、Main の入口と journey の操作が DD-1 に加わる）。
- 会話の表示を別の draftRef に回す場合（会話の表示の (a)。推定）: その確認まで、DD-1 の会話の表示と E-1 の cold reopen の journey が止まる。送信の部分（DF+-b、DT-4、DT-5）は止まらない。
- この route の会話の範囲（S20）の判定と試験は DD-1 で作り、DD-1 の中で吸収できる見込みである（推定）。DD-1 が既存の schema に印を置けないと判断した場合は `[precheck]` で止まり、会話の識別の (a)（新しい schema）の draftRef の確認で往復が1回増え、DD-1 に1〜2日（推定）が加わる。その間も送信の部分（DF+-b、DT-4、DT-5）は止まらない。
- 同意の policy の改訂は AI の品質規則の変更なので、DT-4 で grimodex-author と impact-gate を通す時間が要る（DT-4 の中で吸収できる見込み）。
- 監査の書込みの閉鎖（S17）は DT-4 に、model の名前の規則（S18）は DF+-b に、既存のコードの変更として加わる。journey seam、二重の gate、同意の dialog の確認の checkbox、会話の読取面は DD-1 で作る。どれもそれぞれの PR の中で吸収できる見込みである（推定）。監査、model の名前、seam の対案を選ぶ場合は、新しい draftRef の確認で往復が1回増え、監査の (a) では DT-4 の変更と試験が既存の route に広がる（推定で1〜2日）。

## 確認後の記録（この draft の外で行う）

- 台帳（l6-l9:95-102）に `nir1-local-product-send` の行を加え、draftRef、confirmedRef（`nir1-d2b-local-send-proposal/2#nir1-local-product-send`）、この draft の SHA-256、確認文を記録する（LEDGER-1）。
- /1 は「不採用（U1）、参照のみ」と注記し、confirmedRef にしない。
- GDX-AI-CONSENT-001 の改訂、AI経路検証、registry、同意の route の型の変更は、DT-4 の PR で行う。iron-laws の変更は grimodex-author と impact-gate を通す。
- DSN §1.10（送信の前に閉じた attempt の分類。この route は `skipped` を使わない。sweep が監査の終端を書くこと。join の上限の超過の扱い）、§7.2 と §7.3（同意の identity と grant の OCC の区別、identity に model を含めること、表示の言語に依らない開示の内容の digest、dialog の display が開示の全項目を含むこと、display に入る model の名前の規則と置き方（ラベルの付いた専用の行と、名前に使えない文字の区切り）、`LocalSendConsent` の dialog の確認の checkbox（既定のボタンは §7.2 のとおり取消）、message box で切り詰めるか表示が display と違う OS での専用の window、`LocalSendConsent` の journey seam、PUB-L の前の Native の gate を開ける Main 専用の N-API）、§7.5（利用者の操作によらない同意の要求による催促と、その残余）と §9（生成出力の配信方式）、§4.3 の D-dispatch の行（この行の「IPC の command」の表と「この route の会話の範囲」。D-final の capture の行は変えない）を、この行に合わせて integrator が改める。
- K3 の draft の D-dispatch の行の「K5 で決める command」を、この行の「IPC の command」の表の識別子に置き換え、restricted 下の会話の表示の行もこの表に合わせる（K3 の確認の前なら K3 の draft で、後なら DA-1 の記録で）。K3 の draft の区分の規則（確認済みの契約が command を名指すこと）は、この表の識別子で満たされる。K3 の draft が restricted 下で閉じる会話や AI の出力の表示のうち、この route の会話の読取面（`nir1_local_generation_continue` と `nir1_local_conversation_read`）を開く根拠はこの行の確認で、O-2 の行には含めない。K3 の draft の「会話の履歴と chat の session」の行が K5／DD-1 に委ねた local 生成の会話の表示と保存は、この行の「この route の会話の範囲」で決まり、K3 の draft の D-final の行（capture の入口）は変えない。
- K6 の draft の DD-1 の手順で使う「対象 Scene に付けた新しい chat session」（K6 の draft の「setup の前提と history 枠」の 4 と、「評価専用の呼び出し口」の 7 と 10）は、`nir1_local_conversation_create` で作るこの route の会話とする。製品の経路で送る限り、この行の生成の開始はそれ以外の会話を拒否するためである（K6 の確認の前なら K6 の draft で、後なら DP-H／DD-1 の記録で）。
- この route 以外の path（既存の Native の post-effect、semantic と、renderer の path）に、restricted 下の renderer が監査の event を書ける点（S17）は、この行の範囲の外として、integrator が HOLD 表か issue に記録する。
- l6-l9:246 の D-final の現状と、残 HOLD 表（l6-l9:20-31）の D-transport と D-dispatch の行に、この行への参照を加える（G0 か LEDGER-1）。
- プライバシー通知（`public/PRIVACY_ja.md`、`public/PRIVACY_en.md`）の、Electron の local 生成の同意の記録（model を含む）と監査の記録の記述は、PUB-L で改訂し、Session C-2 で確認する。
- 確認されなかった場合は、HOLD 表に `[precheck]` として残す。

## 確認文

確認は次の 1 文で行う（l6-l9:108）。

- I confirm draftRef nir1-d2b-local-send-proposal/2 for contractId nir1-local-product-send.
