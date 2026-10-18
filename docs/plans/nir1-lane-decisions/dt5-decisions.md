# DT-5 の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

lane：DT-5（K5/3 `docs/plans/nir1-d2b-local-send-proposal-3-draft.md`。2026-10-17 の Session B1 で `nir1-local-product-send` と `caller-profile-egress`〔B-1〜B-4〕の 2 文が確認済み）。base は origin/master 01238cfc。
製品入口（PUB-L、Graph の PUB-G）は閉じたまま。新しい IPC・preload・N-API・schema・依存は足さない。T0（この文書）→ T1（前提の修正と owner への入口）→ T2（純粋な wire 層）→ T3（client・thread・取消・quarantine）→ T4（受入れの網羅・実測・数値の確定）の順に、この表へ追記する。
GDX-PRECHECK-001 により、owner／lifecycle matrix と threat model をこの文書で、.rs／.ts を変更する前の commit として追跡する。

## owner／lifecycle matrix（GDX-PRECHECK-001。K5/3「DT-5 の owner/lifecycle matrix が満たす条件」と DT-2 の matrix〔DSN §1.10〕・DT-4 の差分への DT-5 の差分）

| 区分 | DT-5 の条件 |
|---|---|
| entry | 送信を始めるのは、DT-2 の `claim_for_transport` が `Start` を返した `Nir1TransportOwner` を渡された `start_local_generation`（Native 内の `pub(crate)`。N-API／IPC なし）だけ。renderer の値からは始めない。接続の前に target／payload／purpose の束縛を照合する |
| start | 送信の開始（接続と最初の byte の書込み）は、(1) 監査の start の 3 件が durable、(2) policy を lock の外で DB から直前に読む、(3) 接続の直前と最初の byte の直前の 2 回、取消と共有する phase mutex の下で policy の結果・取消の flag・permit・witness だけを判定、の後にだけ起こる。lock の中では DB を読まず、lease を取らず、socket に触れない。I/O thread は supervisor の GO の後にだけ最初の byte を書く |
| retry | 自動の再送・再接続・別 address への切替なし。新しい attempt は利用者の新しい操作からだけ（DD-1 が同じ capture の 2 回目の start を Native で拒否する） |
| reentrant | 同じ attempt の送信は最大 1 回（owner は消費型。DG-2）。in-flight は chat session ごとに 1 件（DT-2 の registry。追跡 16） |
| admission closure | seam の edge、D2a の失効、route の変更、sender の destroyed で閉じる。開始の前なら送信 0、開始の後なら取消。transport は lease を持たないので gate の閉鎖が DT-1 の drain を待たせない。supervisor は取消の flag、witness の `is_current()`、permit で失効を観測する |
| pending start | DT-2 の開始判断の前の閉鎖・取消は DT-2 が送信 0 の終端を書く。開始判断の後で最初の byte の前の閉鎖・取消・policy 不許可・照合の失敗・監査の start の失敗は、DT-5 が `finish_pretransport_attempt_bounded(ClaimedAt)` で同じ種類（失敗＝`DispatchFailure`、取消＝`Cancelled`）の送信 0 の終端を 1 回だけ書く。`Skipped` は使わない |
| active handle | socket・受信 buffer・parser は I/O thread だけが持つ。thread は解釈した観測を上限のある channel で supervisor に渡し、`OutputObserver` と配信用の差分は supervisor が持つ。取消のための socket の clone は supervisor が持ち、Core の mutex の中では使わない。`Nir1TransportOwner` は participant・permit・registry の slot・witness を終端まで持ち、終端を書いた後に放す。DT-1 の startup lease は transport と終端の書込みの間に持たず取り直さない |
| cancellation | 取消は `Nir1OwnerCancel::cancel()`（stop flag と phase mutex だけ。DB を待たない）で flag を立て、supervisor が flag／witness／permit を観測して socket を shutdown し I/O thread を join する。取消と終端の決定は owner の lock で直列化し、先に決まった方を 1 回だけ書く。取消から join までが上限を超えたら、それまでに channel で受けた観測から取消の終端を 1 回だけ書き、join を待たずに thread を切り離し、gate を quarantine する（同じ Ready entry では開け直さない）。切り離した thread の以後の観測と socket は捨て、二度目の終端も監査の event も書かない |
| bounded wait | 接続、書込み、最初の byte、event の間隔、全体、`[DONE]` の後の body の終わり、取消から join までにそれぞれ期限（K1b。値は DR-DT5-9 で T4 に確定）。HTTP を待つ間は DB mutex・profile／lifecycle の lock・DT-1 の lease を持たない。送信の前の待ちは、DT-2 の最大 7 操作（1,750 ms）＋ policy の読取（最大 250 ms）＋ start の書込み（最大 250 ms）＋ 接続の期限。取消から終端の書込みまでの時間は workspace の transition の physical exclusive を待たせる時間になる（取消の観測の間隔 + 取消から join まで + 終端の書込み〔Pinned、最大 250 ms の操作〕）。値と transition との関係は DR-DT5-9 に書く |
| 終了の証拠 | socket の close、thread の join、終端の行が durable（`finish` が書けなければ DT-2 の規則に従い `recover`〔InterruptedUnknown〕を 1 回試し、それも失敗したら slot を Unresolved にして次の Ready entry の sweep に委ねる。gate はこの失敗だけでは quarantine しない）、owner が持つ participant・permit・slot の解放（Drop）。join 超過のときは、終端の行と gate の quarantine が終了の証拠で、切り離した thread の終わりは待たない（相手が処理を止めた証拠とはみなさない） |
| error／timeout／onClosed | 送信の前の失敗は送信 0 の終端、送信の後の失敗は `failed + invalid + required`。sender の destroyed と window の close は取消に結ぶ（結線は DD-1）。thread の panic は channel の切断で観測する。Drop の recover は owner を持つ blocking thread の上で行い、unwind 中の書込みは二重の panic にしない |
| restart | 送信中の状態は永続化しない。再起動の後は sweep が保守的な終端と監査の終端を同じ DB に書き（DT-4）、再送しない |

## threat model（K5/3 の確認済みの actor・防御・受信先・受入れの範囲内。新しい actor・防御・受信先を足さない）

| 攻撃・actor（K5/3 の In-scope） | DT-5 での防御 | 試験 |
|---|---|---|
| host 名・名前解決・別 address への送信、`127.0.0.1` 以外の表記 | target は IP literal 2 種だけ。`SocketAddr` に直接つなぎ、名前解決しない。peer 照合 | N6、C5 |
| proxy の環境変数、redirect、自動の再送、credential の送出 | std の `TcpStream` は proxy を読まない。3xx を追わない。再送なし。header allowlist（`Authorization` などを型として出せない） | C6、C7、N5 |
| 壊れた応答・悪意ある応答（巨大な header・event・body、遅い送出、終わらない stream、不正な UTF-8／JSON、終端の偽装・重複・欠落、終端の後の data、`tool_calls` の混入、複数 choice、圧縮、framing の曖昧さ、200 以外、non-stream への fallback） | 厳格な parser、allocation の前の検査、各期限、終端の規則、fallback なし | N1〜N4、C8、L6 |
| 同じ attempt の二重の送信・crash の後の再送、取消と送信の開始の競合 | owner の消費型、phase mutex、GO の handshake、recover は再送しない | C10、L3、L7 |
| 送信中の workspace の切替・shutdown・D2a の失効・route の変更 | witness／permit の観測で取消、participant を終端まで保持 | L5 |
| HTTP を待つ間の lock の保持、lease の保持による drain と begin_recovery の timeout | lock と lease を持たない設計 | C4、L5 |
| 監査の start のない送信、credential を含む監査、終端の別 DB への記録 | start が durable でなければ接続しない。`credentialsExcluded`。pinned な DB だけ | C1、C2、A1 |
| policy の迂回（送信の直前の変更、cache、renderer の値） | 送信の直前に毎回 DB から読む。renderer／Main の値を使わない | C3、C4 |
| 生成出力のほかの窓への配信 | 起動した run の handle からだけ取り出せる。event を出さない | L8 |
| text と thinking の混同 | parser で分け、allowlist 外の field を入れない | W4 |
| Out-of-scope（防がず開示で扱う） | listener の置換、待ち受けのプログラムによる外部への中継・処理、画面が読める自分のデータの送信、送った bytes を取り戻すこと。これらを防ぐと主張する試験・コメント・文言を書かない | C11（範囲の固定のみ） |

## 判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DT5-1 | 2026-10-18 | DT-5／T0 | 範囲の確定。K5/3 を通読した結果、K5/3 が DT-5 に置いた IPC／N-API／gate の作業はない。「IPC の command」の表（`nir1_local_generation_start`／`_continue`／`_cancel`、`nir1_local_conversation_create`／`_list`／`_read`）、A-1 の二重 gate、journey seam、`capture` の前後の検査の置き方、同じ capture の 2 回目の start の記録、会話の印、開示は DD-1 の範囲で、DT-4 も入口を置かなかった。したがって DT-5 は IPC／preload／N-API の新しい入口、Main／Native の gate、journey seam、会話の作成・一覧・読取、PUB-L の同意を足さず、DD-1 が呼ぶ Native 内の `pub(crate)` の API（`start_local_generation` と `Nir1LocalRun`）までを作る。policy の読取は DT-4 の `read_before_send`（送信の直前）を transport の中で呼ぶ結線だけを DT-5 が行い、`check_before_attempt`（attempt の作成の前）の結線は DD-1。integrator が DT-5 に command の実体を含める意図なら範囲の拡大なので TASK を作り直す（DD-1 の先取りには A-1 の Native の gate も要る） | renderer からは何も到達しない（入口がない）。信頼境界は変わらない | command の実体まで DT-5 に含める（K5/3 が DD-1 に割り当てており、確認の範囲外の入口を足すことになるので不採用） | 不要 | 該当なし | entry の行のとおり（`pub(crate)` の 1 入口。N-API／IPC なし） | 記録済み（実装前） |
| DR-DT5-2 | 2026-10-18 | DT-5／T0 | std のみ・依存なし・Cargo 変更なし。client は std の `TcpStream`（`connect_timeout`、読み書きの timeout）と最小の HTTP/1.1 を使い、1 attempt に 1 本の専用 thread と blocking I/O で動かす。tokio の task や `.await` をまたいで socket を持たない。既存の provider client（`reqwest::Client::new()`、429 の再送、読めない event の読み飛ばし）は使わない。`Cargo.toml`／`Cargo.lock`／`package.json` と migration は変更しないので `scripts/local-ci-full-workload-allocation.json` の sha256 の更新は不要。依存や feature が必要になったら委任の外として止める | std の `TcpStream` は proxy の環境変数を読まず、redirect も圧縮も TLS もない。依存を増やさないので新しい攻撃面がない | `reqwest` の blocking client（proxy の環境変数を読み、redirect・再送・圧縮が既定で働くので、無効化の設定漏れが防御の穴になる。依存の追加でもある）。hyper 等の低水準 client（依存の追加） | 不要 | 該当なし | active handle の行（socket は I/O thread だけが持つ） | 記録済み（実装前） |
| DR-DT5-3 | 2026-10-18 | DT-5／T0 | thread の構成は 2 本。supervisor thread は owner を生涯持つ blocking thread で、DB を触るのはここだけ（監査 start、policy の読取、送信の判定、終端の書込み、quarantine、owner の drop）。I/O thread は `TcpStream` と parser と上限のある channel の送り側だけを持ち、DB も owner も lease も持たない。取消のための socket の clone は接続の後に I/O thread が `try_clone` を channel で supervisor に渡し、supervisor が持つ。I/O thread が最初の byte を書くのは、supervisor が最終の判定（接続の直前、最初の byte の直前の 2 回）を通して「GO」を返した後だけ。GO を出していなければ送信 0 と断言でき、出した後は送信ありとして扱い、監査の `remoteOutcome` を `not-sent` にしない。std には時限つき join がないので、I/O thread の終了は完了の signal（channel）と `is_finished()` で判定し、上限を超えたら終端を 1 回だけ書いて thread を切り離す。切り離した thread は socket の読み書きの timeout で終わるように作り、以後の観測と socket は捨てる | owner と DB は supervisor だけ。I/O thread は応答の bytes を解釈して値を渡すだけで、権限を持たない | 1 本の thread が owner を持ち I/O も行う（blocking read に時限つきの join を付けられず、取消の終端を I/O thread が詰まったまま書けない。DB の書込みの上限が socket の timeout と干渉する）。tokio の task で socket を扱う（`.await` をまたいで socket を持たない方針と、DT-2 の blocking thread で drop する構造に反する） | 不要 | 該当なし | active handle、cancellation、bounded wait の行 | 記録済み（実装前） |
| DR-DT5-4 | 2026-10-18 | DT-5／T0 | module の置き場。純粋な wire 層（HTTP/1.1 の応答の head と framing、SSE の解釈、request の head の組立て、終端の写像、限界値の検査。I/O なし）は grimodex-core の新 module `nir1_local_wire`（`nir1_local_wire.rs`＋`nir1_local_wire/{http,sse,limits,tests}.rs`）。理由：`OutputObserver` と同じ crate なので写像を書きやすく、src-tauri workspace の軽い試験で回せ、3 OS の CI に載せやすい。`evals/impact-map.yaml` の既存の glob（core の `nir1_*.rs`／`nir1_*/**`）に当たるので分類は済む。client・supervisor・I/O thread・`Nir1LocalRun` は node の新 module `nir1_local_transport.rs`＋`nir1_local_transport_tests.rs`。DT-2 の owner への入口は `nir1_generation_owner.rs`（T1）、target の型 `LoopbackChatEndpoint` は `nir1_prepared_request.rs` を `pub(crate)` にする最小の変更 | 純粋な層は I/O も権限も持たない。socket と DB の境界は node の supervisor／I/O thread に閉じる | wire 層を node crate に置く（3 OS で軽く回せなくなる。置く場合は理由を DR に書く） | 不要 | 該当なし | 不要（新しい owner を作らない） | 記録済み（実装前） |

## 引継ぎ（他 lane。DT-5 では試験できない／しない）

- DD-1：`nir1_local_generation_start` ほかの command の実体と二重の gate（A-1）、`capture` の前に置く検査の一覧と同じ capture の 2 回目の start の記録、attempt の作成の前の policy 検査（`check_before_attempt`）の結線と attempt 0 の経路試験、会話の作成・一覧・読取と印、sender への出力の束縛と `continue` の間隔・差分の上限、journey seam と recorder、開示、sender の destroyed／window の close を `Nir1OwnerCancel` に結ぶこと、`Nir1LocalRun` の受け皿の使い方。
- PUB-L：規約・プライバシー通知・ガイド・開発者メッセージ、実測の報告を使った承認（Session C-2）。
- integrator：DSN §1.10 の追随と作業記録への索引、`claim_for_transport` の手順 1〜2 の分岐の試験の担当決定（DI-1c の前）。この lane は `docs/plans/nir1-continuation-2026-10.md` と DSN を編集しない。
