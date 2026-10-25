# DD-1a の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

lane：DD-1a（DD-1 の Native 入口。K5/3 `docs/plans/nir1-d2b-local-send-proposal-3-draft.md` の `nir1-local-product-send` と `caller-profile-egress`〔B-1〜B-4〕、K4/3 `nir1-d2b-history-mapping-proposal-3-draft.md` の取消の結束。いずれも 2026-10-17 の Session B1 で確認済み）。base は origin/master `0f63fc03`。
製品入口（PUB-L）は閉じたまま。この文書は GDX-PRECHECK-001 により、`.rs` を変える前の commit として、影響マトリクス、owner／lifecycle matrix、threat model、判断を記録する。DD-1b 以降（Main／IPC、renderer、実 Electron の journey、評価 harness、版 3 の fixture、診断の run）はこの lane では行わない。

## 範囲（DD-1a が作るもの）

- Native（`electron/native/grimodex-node`）：6 つの `#[napi]` command（`nir1_local_generation_start`／`_continue`／`_cancel`、`nir1_local_conversation_create`／`_list`／`_read`）、Native の gate の新しい種類、start の結線（`Nir1LocalAttempt::capture` → `check_before_attempt` → `run` → `start_local_generation`）、同じ capture の 2 回目の start の記録、continue の差分の上限と caller の確認、取消の結束、会話の create／list／read、Main 専用の sender 取消の入口。
- 共有 Rust（`src-tauri/crates/grimodex-db`）：会話の印の書込み（create の transaction）と、session の段・行の段の reader、会話の current な capture の読取（既存 schema の中。migration なし）。
- しないこと：`electron/shared/ipcContract.ts`、`NAPI_COMMANDS`、Main の gate、journey seam、renderer、`AI_TRANSPORT_COMMANDS` の変更（DD-1b／c）。新しい schema、依存、Cargo の変更。gate を開ける操作。

## 影響マトリクス（refactor-cross-boundaries。実装前）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Native gate（6 command 共通） | `main_grant::PrePublicationGate` の新しい種類 `LocalGeneration`（wire `nir1-local-generation`） | 各 command の最初に `is_open` を見る。閉じていれば typed `NIR1_LOCAL_GATE_CLOSED` で、引数の DB 照会・owner・送信をしない。開けるのは既存の `main_open_pre_publication_gate` だけ | Main（DD-1b の seam）、試験 | 既定で閉。永続しない。他の種類と独立 | 既存 2 種類の wire と挙動は不変 | gate 閉で 6 command がすべて拒否、DB と recorder が 0（E1）。変異：既定で開く | planned |
| P2 | 会話の作成 | Native `nir1_local_entry::conversation_create` → db `create_local_conversation_bounded` | caller は restricted・登録済み（`with_authorized_preparation`）。Scene は live（`node_type='scene'`、`archived_at IS NULL`）。ID は Native が決める `nir1-local-{writing,review}-<uuid>`（印と purpose）。strict INSERT。title・model は既定値（内容を入れない） | `chat_sessions` | 印は ID だけ。CW の列（title、title_manual、updated_at）と renderer が変えうる列に置かない | 既存の chat 画面は任意の文字列 ID を扱う。import は新しい UUID を振る | 印の parse と GLOB の一致、改名で判定が不変、unrestricted で拒否（E2） | planned |
| P3 | 会話の一覧 | Native → db `list_local_conversations_bounded` | 同上の caller。印の厳密な GLOB と同じ規則の parse。上限 256＋超過の flag | renderer（DD-1c） | 表示名は印の purpose と Native が解釈できた作成時刻だけ | — | 他の会話・偽の接頭辞を返さない、上限（E3） | planned |
| P4 | 会話の読取 | Native → db `read_local_conversation_bounded` | session の段（印）と行の段（(a) capture の受理した入力、(b) この route の attempt の成功の出力）。version が失効しておらず digest が一致するものだけ。範囲と bytes の上限 | renderer（DD-1c） | 監査、capture のない行、他 route、system、title を返さない | — | S20 の (1)〜(6) の fixture（E4） | planned |
| P5 | 生成の開始 | Native `generation_start` | capture の前の検査（下の一覧）→ start の記録 → DT-2 `capture` → `check_before_attempt` → handle の登録 → starter thread で `run`（prepare、create、再観測、claim）→ `start_local_generation` | DT-2 owner、DT-5 transport | 1 capture に 1 回。attempt 0 の拒否は typed | DI-1c の `run` の形は保つ（target を返す変種を足す） | 2 回目の start の拒否（各終わり方）、policy の attempt 0（E5、E6） | planned |
| P6 | 出力の取得 | Native `generation_continue` | handle と caller の完全一致、登録の再確認、差分の上限 | renderer（起動した sender だけ） | event で配らない。途中は未確定 | — | 別 sender・別 epoch の拒否、上限（E7） | planned |
| P7 | 取消 | Native `generation_cancel` | handle と caller の一致 → owner の `cancel()` → 既存の capture の writer（`cancel_current_chat_input` と同じ） | DT-2 owner、`nir1_chat_input_captures` | 1 command で両方。writer の失敗は成功を返さない | — | K4/3 の時機ごとの試験（E8） | planned |
| P8 | sender の取消（Main 専用） | Native `main_nir1_local_generation_cancel_sender` | sender の handle の owner に `cancel()` だけ（取り下げでない停止。capture を変えない） | DT-2 owner | renderer から呼べない（`NAPI_COMMANDS` に載せない） | — | capture が current のまま、送信の取消（E9） | planned |
| P9 | coordinator | `nir1_local_attempt.rs` | `run` は不変。target（`LoopbackChatEndpoint`）を返す `run_for_dispatch` を足す。試験の probe を `Send` にする | P5 | DI-1c の再観測と claim の順を変えない | 既存の試験は probe の型だけ追随 | DI-1c の試験が通る | planned |
| P10 | owner の policy 用の入口 | `nir1_generation_owner.rs` | `policy_read_scope()`：owner の workspace、project、witness で fence した admission budget を返す（lease を持たない） | P5 | owner の lock 順と `cancel()` の DB 非依存を変えない | DT-4 の source 検査（owner に `check_before_attempt` が無い）を保つ | t1 の DT-4 試験 | planned |
| P11 | 会話の current な capture の読取 | `nir1_prepared_request.rs`＋db | caller から D-final と同じ規則で作る capture owner と、session の current な capture の owner が一致するものだけ | P5 | historical な version ID を受けない | — | 別 caller・superseded・Scene の不一致（E5） | planned |
| P12 | `index.d.ts` | napi | 7 つの method の型 | Main（DD-1b） | 既存の宣言を変えない | — | 差分の目視 | planned |
| P13 | `aiPathRegistry` の完全性試験 | renderer の試験 | src に invoke が無いので走査の対象外のまま | — | 登録は DT-4 のまま | — | vitest の該当試験 | verified unchanged（実装後に確かめる） |
| P14 | IPC／Main／preload／renderer | — | — | — | — | — | — | out of scope: DD-1b／c |

lifecycle note（P5〜P8。iron-laws の項目）：entry は 6 command と Main 専用の 1 入口だけ。start は capture の前の検査の後に記録を置いてから DT-2 の `capture`。retry は自動にしない（同じ capture は拒否）。reentrant は session ごとに 1 件（DT-2）と handle の上限。admission closure は Native gate、D2a、DT-1 の gate、shutdown。pending-start は starter thread が owner を持つ間（DI-1c の寿命 60 s が上限）。active handle は handle registry の entry（caller、accepted submission、owner の cancel handle、run）。cancellation は owner の `cancel()`（DB を待たない）と capture の writer。bounded wait は DI-1c／DT-5 の期限と participant の予算。終了の証拠は attempt の終端の行（または attempt 0 の typed な結果）と run の final state。error／timeout／onClosed は下の matrix。restart は永続状態なし（記録と handle は process 内。attempt は sweep）。

## capture の前に置く検査の一覧（K5/3:600-601。押し直せる範囲）

`nir1_local_generation_start` は次の順に確かめ、どれかで拒否した start は記録に数えない（同じ入力で押し直せる）。

1. Native gate が開いている（P1）。
2. 引数の形（strict な serde。purpose は `writing`／`review`、ID は既存の上限）と Main の key 判定の形。
3. profile が restricted で in-flight の停止が確認済み、caller が登録済みで pinned な workspace のもの（`with_authorized_preparation`）。
4. Main の key 判定が `absent`（`present`／`check-failed` は typed）。
5. workspace が Ready で、DT-1 の startup gate がその binding で Open（lease を取ってすぐ放す。K5/3:601 の `GateClosed` の例を押し直せる形にする）。
6. 会話が印を持つ（session の段）、印の purpose が intent の purpose と同じ、会話の Scene（`node_id`）が intent の Scene と同じで live な Scene。
7. 会話の current な capture があり、その owner が caller から D-final の規則で作る owner と同じで、capture の Scene が intent の Scene と同じ。
8. handle registry に空きがある（予約。start の終わりまで持つ）。
9. start の記録に空きがある。

この後に start の記録（その capture の ID）を置き、DT-2 の `capture` を呼ぶ。以後の終わり方（`capture` の段の拒否、AI 使用ポリシーの不許可、D-final の失敗、create の前の拒否、create の失敗、再観測の abandon、claim の不開始、送信の後のどれでも）は押し直せない。AI 使用ポリシーの検査（`check_before_attempt`）は TASK の指定どおり `capture` と `run` の間に置き、capture の後の検査とする（理由は DR-DD1A-5）。

## owner／lifecycle matrix（GDX-PRECHECK-001。phase × event。各セルは「結果／終端の書き手」）

| phase ＼ event | 利用者の取消（`_cancel`） | sender destroyed／window close／epoch 変化（Main 専用入口、continue の登録確認） | route 変更・D2a 失効・workspace 切替・shutdown | policy の変更 | DB の busy／期限 | crash |
|---|---|---|---|---|---|---|
| P1 Main の受付（DD-1b） | handle がないので対象外 | 拒否（DD-1b） | 拒否（DD-1b） | 次の開始から | — | 状態なし |
| P2 capture の前の検査（上の 1〜9） | handle がないので対象外。拒否は記録に数えない | 3 で拒否（押し直せる） | 1・3・5 で拒否（押し直せる） | 対象外（policy は P4） | typed 拒否（押し直せる）／書き手なし | 状態なし |
| P3 start の記録 → DT-2 `capture` | handle がない。拒否は typed で、押し直しは記録で拒否 | `capture` が `ProfileRevoked` 等／書き手なし（attempt 0） | `GateClosed`／`RouteChanged`／`WorkspaceNotReady`／書き手なし | — | typed／書き手なし | 記録は消える。再起動の後は capture の受理（o13）と owner の不一致で拒否 |
| P4 `check_before_attempt` | handle がない（同期の区間）。不許可なら owner を放す | 同左 | budget の probe（witness と permit）で読取を止め、不許可と同じ | 不許可・読めない値で attempt 0・監査 0・送信 0／書き手なし | 読取の失敗は不許可と同じ（送信 0）／書き手なし | attempt なし |
| P5 starter thread の `run`（prepare→create→再観測→claim） | `cancel()`（phase mutex だけ）。create の前は attempt 0、create の後は DT-2 が送信 0 の `Cancelled`／DT-2。capture は writer が cancelled | 同左の `cancel()`。capture は変えない（取り下げでない停止。K4/3:447） | create／claim の拒否、再観測の abandon で送信 0／DT-2・DI-1c | create の後は送信の直前に DT-5 が再読取 | DT-2 の規則（再読取、quarantine、Unresolved）／DT-2 | 未終端の attempt は sweep／sweep |
| P6 transport（DT-5） | flag と socket の shutdown、join の上限超過で終端 1 回・quarantine／DT-5 supervisor。capture は writer が cancelled | `cancel()`／DT-5 supervisor。capture は変えない | witness／permit の失効で取消／DT-5 | 進行中は取消さない（K5/3:264） | 終端の失敗は recover 1 回→Unresolved／DT-5 | 再送しない、sweep |
| P7 continue | 取消の後は終端の状態と残りの差分だけ | 登録の再確認に失敗したら `cancel()`（capture は変えない）して entry を外す | 状態は transport の終端に従う | — | DB を読まない（run の buffer だけ） | — |
| P8 終端の後（entry の保持） | run が final なら何も変えない（capture も変えない）で成功 | entry を外すだけ | — | — | — | entry は process 内で消える |

行ごとの補足（iron-laws の列）：

| 行 | entry／admission closure／pending start／active handle／bounded wait／終了の証拠／error・timeout・onClosed／restart |
|---|---|
| P2 | entry は start だけ。closure は gate・D2a・DT-1 の gate。pending start なし。handle の予約だけを持つ（Drop で返す）。待ちは participant の予算（20 s、busy 100 ms）の 2 回の短い読取。終了の証拠は typed な応答。restart で消えるものはない |
| P3 | 記録は start の記録 map に入れる（lock は map の操作の間だけ）。DT-2 の `capture` は DT-2 の短い lock を 1 つずつ。拒否で owner は作られず、slot も permit も残らない |
| P4 | 読取は owner の workspace と witness で fence した admission budget（lease を持たない）。owner の phase mutex の外。不許可で `Nir1LocalAttempt` を drop（slot と permit を返し、attempt 行なし） |
| P5 | starter thread（`nir1-local-starter`、plain thread）が owner を持つ。寿命は DI-1c の 60 s と participant の予算が上限。thread を作れなければ、その場で owner を drop（attempt 0）して run を Failed（reason `starter-spawn-failed`）にする。owner の Drop は plain thread の上で同期に書く（DT-5 の DR-DT5-7） |
| P6 | DT-5 の matrix のまま（DR-DT5-16〜21）。DD-1a は supervisor に触れない |
| P7 | continue は handle registry の lock（map の clone の間だけ）と run の buffer の mutex だけ。DB、owner の phase mutex、lease に触れない。上限は 1 回 64 KiB ずつ（text と thinking） |
| P8 | final な entry は 60 s 後の次の start か、空の差分を返した continue で外す。entry の数は 16 が上限（DT-2 の追跡 session の上限と同じ） |

DT-2 の `SessionUnresolved` の liveness（dt2-decisions §9）：入口では変えない。zero-send を上限まで書けなかった session は、次の Ready entry か restart まで typed な `session-unresolved` を返す（capture の段の拒否なので押し直せない。利用者は新しい送信も同じ session では待つ）。次の capture で settle し直す方式は採らない（DT-2 の owner の性質を変えるため。PUB-L の前の観察事項として残す）。

## threat model（K5/3:238-260 の確認済みの actor・防御・受信先・受入れの範囲内。新しい actor・受信先を足さない）

| 攻撃・actor（K5/3 の In-scope） | DD-1a での防御 | 試験 |
|---|---|---|
| renderer が PUB-L の前にこの route を使う | Native gate（既定で閉、Main 専用の N-API だけが開ける、永続しない）。6 command の先頭で拒否 | E1、変異 M1 |
| renderer による route・endpoint・messages・purpose の偽造 | start の入力は purpose（enum）、会話の ID、Scene の ID だけ。route は Native が設定から解決し、messages は D-final が組む。purpose は印の purpose と一致が要る | E5 |
| この route の会話でない会話を使わせる（restricted になる前の会話、ほかの chat の会話に capture を作ってから start／read） | session の段は印（Native が作成時に決める ID）だけで決める。attempt・capture の有無、title、node_id を判定に使わない | E2、E4、E5 |
| CW の改名で判定を変える | 印は `id` にあり、CW の書く列（title、title_manual、updated_at）にない | E2（改名の後も一覧・読取・start が同じ） |
| 会話の ID の指定で他の会話・他 workspace・監査を読む | read は印のある会話だけ、pinned な workspace の DB だけ、行の段の行だけ（監査・capture のない行・他 route の出力・失効した version・digest の不一致を返さない） | E4 |
| 同じ attempt の二重の送信、同じ capture の押し直し | start の記録（DT-2 の `capture` の前）と DT-2 の決定的な attempt ID | E6、変異 M4 |
| AI 使用ポリシーの迂回 | attempt の前に `check_before_attempt`、送信の直前に DT-5 の再読取。renderer／Main の値を使わない | E6b、変異 M5 |
| 生成出力のほかの窓への配信 | continue は handle と caller（sender、epoch を含む）の完全一致と登録の再確認。event を出さない | E7、変異 M7 |
| 取消と送信の開始の競合、取り消した Human の再利用 | 取消は owner の `cancel()` を先に、続けて既存の capture の writer。1 command | E8、変異 M6 |
| handle の推測 | handle は 128 bit の乱数で、さらに caller の一致が要る（handle は認可ではない） | E7 |
| 印の偽造（unrestricted の間の汎用 SQL） | 防がない（K5/3 の Out-of-scope）。偽造された会話でも read が返すのは行の段の行だけ | 範囲の固定のみ |
| 侵害された renderer の可用性の妨害（開始・取消の連打、handle の枯渇） | 上限で typed に拒否（Out-of-scope の可用性） | E7 の上限 |

受信先は設定の loopback の IP literal の port だけ（DT-5）。DD-1a は新しい受信先、保存の範囲、外向きの通信を足さない。試験の通信は loopback の script server だけ。

## 判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DD1A-1 | 2026-10-26 | DD-1a | module の置き場。Native の command の実体は新 module `nir1_local_entry.rs`＋`nir1_local_entry_tests.rs`（`pub(crate)`）、`lib.rs` は `#[napi]` の薄い wrapper だけ。共有 Rust は grimodex-db の新 module `nir1_generation/local_conversation.rs`（feature `native-current-human-capture`）。impact-map の既存の glob（node の `src/nir1_*.rs`、db の `src/nir1_*/**`）に当たる | Native の外へ出す値は応答の JSON だけ | lib.rs に直接書く（21k 行の file にさらに足す。試験が分けにくい） | 不要 | 該当なし | P2〜P8 | 記録済み（実装前） |
| DR-DD1A-2 | 2026-10-26 | DD-1a | Native gate の種類は `PrePublicationEntry::LocalGeneration`（wire `nir1-local-generation`）。6 command は最初にこれを見て、閉じていれば `NIR1_LOCAL_GATE_CLOSED`。開けるのは既存の `main_open_pre_publication_gate` だけで、製品の起動は開けない（Main の seam は DD-1b）。試験は `state.main_grant.gate.open` で開ける（K5/3 必須防御 16 が認める形） | gate は Native の process 内の AtomicBool。renderer は種類を選べない（`main_open_pre_publication_gate` は `NAPI_COMMANDS` にない） | gate を command ごとに分ける（seam は表の command をまとめて開けるので 1 つで足りる）。wire を `local-send` にする（既存の試験が「未知の値」の例に使っている） | 不要 | 該当なし | P1 | 記録済み（実装前） |
| DR-DD1A-3 | 2026-10-26 | DD-1a | 会話の印と purpose は `chat_sessions.id` に置く：`nir1-local-writing-<uuid>` と `nir1-local-review-<uuid>`（uuid は小文字 16 進の 8-4-4-4-12。Native が `Uuid::new_v4` で決める）。判定は厳密な parse（接頭辞と 36 文字の形）で、SQL の GLOB はその parse と同じ規則から作る（limit の後に再絞り込みしない）。既存 schema の中で、作成の後に変わらない値（主キー。CW は ID を変えず行を挿入しない。restricted では renderer の汎用 SQL が届かない）。title・model は既定値のまま（内容を入れない）。created_at は Native の時刻（RFC3339、ms、Z）。既存の chat 画面との共存：ID は任意の文字列として扱われ（IPC の検証は 256 文字以下の trim 済み文字列）、import（Novelcrafter）は新しい UUID を振り、通常の会話の作成は `crypto.randomUUID()` なので、どちらも印を作らない（DD-1a で確かめた）。印の偽造は unrestricted の間の汎用 SQL でだけ起き、K5/3 の Out-of-scope | 印の書き手は Native の create だけ。偽造されても行の段で平文の範囲は広がらない | title や model の列に置く（CW の書く列、または renderer が変えうる列）。新しい列・表（schema の変更で `[precheck]`）。attempt や capture の有無で判定（K5/3 が禁じる） | 不要（K5/3 が例に挙げた形） | 該当なし（既存 schema の中。[precheck] に当たらない） | P2〜P4 | 記録済み（実装前） |
| DR-DD1A-4 | 2026-10-26 | DD-1a | 同じ capture の 2 回目の start の記録。process 内の map で、key は（Ready の binding、project、chat session）、値はその session で最後に start を記録した capture の ID。start は session の current な capture しか使わず、capture の状態は current から戻らない（trigger が遷移を一方向に守る）ので、session ごとに最後の 1 件で足りる。上限 4096 session。挿入のときに今の binding と違う entry を外し、それでも満ちていれば typed `NIR1_LOCAL_START_RECORD_FULL` で拒否（capture の前なので押し直せる。再起動で空になる）。記録は DT-2 の `capture` の直前に置き、外さない（どこで終わっても押し直しを拒否） | 記録は Native の process 内だけ。renderer からは消せない | 記録を submission ID の集合にする（上限で古いものを捨てると、捨てた capture を押し直せてしまう）。記録を DB に置く（新しい schema） | 不要 | 該当なし | P3 | 記録済み（実装前） |
| DR-DD1A-5 | 2026-10-26 | DD-1a | AI 使用ポリシーの検査は `Nir1LocalAttempt::capture` と `run` の間（TASK と DI-1c の申し送り (e)）。owner に `policy_read_scope()` を足し、owner の workspace、project、witness と permit で fence した admission budget を返す（lease を取ってすぐ放し、読取の間は持たない）。`check_before_attempt` を呼ぶのは entry module で、owner の file には書かない（DT-4 の source 検査を保つ）。不許可・読めない値・project の行なし・読取の失敗はどれも attempt 0 で、typed（`NIR1_LOCAL_POLICY_DENIED`／`NIR1_LOCAL_POLICY_UNREADABLE`）。許可の basis を transport の入力に渡す。capture の後の検査なので押し直せない（renderer は DD-1c で policy を見て hide／disable する） | policy は毎回 DB から読む。renderer と Main の値を使わない | capture の前に置く（押し直せるが、TASK の結線の順と違う。capture の前と後の 2 回読む案も、同じ判定を 2 か所に置くので採らない） | 不要 | 該当なし | P4 | 記録済み（実装前） |
| DR-DD1A-6 | 2026-10-26 | DD-1a | start の同期の区間と starter thread。start は、capture の前の検査、記録、DT-2 の `capture`、policy の検査、handle の登録までを同期に行い、handle か typed な unavailable を返す（K5/3 の表が start の応答に挙げる unavailable：会話、purpose、Scene、capture、policy、key はすべてこの区間）。続く `run`（D-final の準備、create、再観測、claim）と `start_local_generation` は plain thread `nir1-local-starter` で行う。D-final の失敗、abandon、claim の不開始は run の final state（typed な reason）として continue が返す。理由：handle が prepare の前にあるので、K4/3 の取消の時機（create の前、create と claim の間、claim の後、送信の後）のすべてで `nir1_local_generation_cancel` が届く。command は増えず、段階を分ける command も置かない（K5/3:579 の「1 つの command の中」は、1 つの command が始めた仕事として満たす） | starter thread は owner を持つが DB の lock も lease も持ち越さない（DI-1c の各段の bounded な操作のまま） | start を run の終わりまで同期にする（prepare の間に handle がなく、取消は `cancel_current_chat_input` からだけ。K4/3 の時機の試験を製品の入口で通せない）。start を記録の直後に非同期にする（policy の拒否を start の応答で返せない） | 不要 | 該当なし | P5 | 記録済み（実装前） |
| DR-DD1A-7 | 2026-10-26 | DD-1a | handle。値は `Uuid::new_v4` の 32 桁の 16 進で、lookup の key にすぎず認可ではない。continue と cancel は、handle の entry の caller（profile、caller ID、epoch、sender、workspace、caller session）と要求の caller の完全一致を要する。continue はさらに登録を再確認し（`with_authorized_preparation`）、失敗なら owner の `cancel()` を呼んで（取り下げでない停止。capture は変えない）entry を外し、typed `NIR1_LOCAL_CALLER_REVOKED`。entry の上限 16（DT-2 の追跡 session の上限と同じ）。final になった entry は、空の差分を返した continue か、final から 60 s 後の次の start で外す。Main 専用の `main_nir1_local_generation_cancel_sender(sender_id)` は、その sender の entry の owner に `cancel()` を呼んで外す（DD-1b が sender の destroyed／window の close に結ぶ。renderer から呼べない） | handle を知っても別の sender・別の epoch は読めず止められない | handle だけで引く（handle の漏洩で他の窓が出力を読める）。sender の取消を Native に置かず Main だけで持つ（Native の run を止める手段がない） | 不要 | 該当なし | P6〜P8 | 記録済み（実装前） |
| DR-DD1A-8 | 2026-10-26 | DD-1a | continue の差分の上限と間隔（K1b）。1 回の continue が返すのは text と thinking それぞれ最大 64 KiB（`Nir1LocalRun::take_delta` の文字境界の規則）と state（`starting`／`running`／`succeeded`／`failed`／`cancelled`）、final のときの閉じた reason。Native は待たない（非 blocking）。取りに来る間隔は renderer（DD-1c）が決める（推奨は 100 ms 以上）。全体の bytes は wire の text／thinking の各 2 MiB で抑えられる。stop と `[DONE]` がそろって本文が空の成功は、そのまま `succeeded`（空の text）で返す（契約にない条件を足さない。DR-DT5-23 (4)） | 平文は起動した sender にだけ返る | long-poll（blocking pool を待たせる）。上限なし（1 回の応答が 4 MiB になりうる） | 不要 | 該当なし | P7 | 記録済み（実装前） |
| DR-DD1A-9 | 2026-10-26 | DD-1a | 取消の結束（K4/3:445-451、:477）。`nir1_local_generation_cancel(handle)` は、caller の一致を確かめた後、(1) entry の owner の cancel handle で `cancel()`（phase mutex だけ。DB を待たない）、(2) 既存の `cancel_current_chat_input` と同じ関数（registry の `cancel_owner_for` と、`cancel_current_human_chat_input_by_submission` の writer）を、受理した submission の識別子で呼ぶ。writer の結果（cancelled／not-current／not-found）になってから成功を返す（応答は空）。writer が error なら typed `NIR1_LOCAL_CANCEL_CAPTURE_FAILED` を返し成功にしない。再実行は (1)(2) をやり直す。run がすでに final（成功を含む）なら何も変えずに成功を返す（K4/3:449 が DD-1 に委ねた選択。終わった生成は取り消せないので、利用者の取消を capture に及ぼさない）。取り下げでない停止（sender、continue の登録の失敗）は (1) だけ。renderer から owner だけを止める command はない（6 command のうち取消は 1 つ） | capture の writer の認可は既存のまま | 終端の後も capture を cancelled にする（完了した返答を、古い画面の取消で履歴から外しうる）。`cancel_current_chat_submission`（handle の入口）を使う（superseded を error で返し、not-current と区別できない） | 不要 | 該当なし | P5〜P8 の取消の列 | 記録済み（実装前） |
| DR-DD1A-10 | 2026-10-26 | DD-1a | 会話の読取の範囲と上限。range は `{offset, limit}`（limit は 1〜64）。行の候補は (a) その会話の `nir1_chat_input_captures` の行（状態を問わない）の message version、(b) その会話の attempt のうち binding の provider が `openai-compatible`、api が `chat-completions`（この route の D-final が書く値）で、成功の終端と `output_version_id` を持つものの生成の version。候補は最大 4096 件で、超えたら typed `NIR1_LOCAL_CONVERSATION_ROW_LIMIT`（切り詰めない）。順は version の `created_at_ms`、次に version ID。範囲の行だけ本文を読み、合計 4 MiB（本文と thinking）を超える行の手前で止めて `truncated` を返す。各行は既存の reader（`read_message_version_in_tx`：失効しておらず role・本文・thinking・作成時刻の digest が一致）で確かめ、確かめられない行は ID と閉じた reason だけ。返す thinking は確かめた行の `thinking_blocks` だけ。入力の行には、その capture の attempt の終端の状態（平文なし）を添える | 平文は行の段の行だけ。監査、title、capture のない行、他 route、system、`chat_message_prompts`、`chat_summaries` を読まない | 本文まで全件読んでから切る（bytes の上限が効かない）。cursor（行の ID）で引く（offset で足りる。行は増えるだけで、候補の順は決定的） | 不要 | 該当なし | 不要（DB の読取だけ） | 記録済み（実装前） |
| DR-DD1A-11 | 2026-10-26 | DD-1a | 一覧と作成の応答。作成は `{conversationId, displayName:{purpose, createdAt}}`、一覧は `{conversations:[…同じ形…], truncated}`（上限 256、`created_at` の降順、次に ID）。表示名は印の purpose と、Native が RFC3339 として解釈できた `created_at`（解釈できなければ null）だけ。title などの文字列の列は返さない。一覧と読取を呼べるのは、restricted の下で pinned な workspace に登録された caller なら誰でもよい（作った caller と違ってよい。K5/3:591） | 内容と利用者の入力を含まない | title を返す（CW や unrestricted の汎用 SQL が書いた文字列が平文の面に出る） | 不要 | 該当なし | 不要 | 記録済み（実装前） |
| DR-DD1A-12 | 2026-10-26 | DD-1a | 監査と registry。監査の start の 3 件と終端は DT-4／DT-5 の実装のまま（DD-1a は呼ぶだけ）。`aiPathRegistry` の `AI_TRANSPORT_COMMANDS` の走査は src の `invoke("…")` を見るので、src に呼出しを足さない DD-1a では対象外のままで、試験は変わらず通る（DD-1c が invoke を足すと登録済みの route に当たる） | — | DD-1a で renderer の wrapper を足す（DD-1c の範囲） | 不要 | 該当なし | 不要 | 記録済み（実装前） |

## 確かめられなかったこと（実装前の時点）

- 実 local server／model の応答（DT-5 の DR-DT5-27 のまま未実測。U-1）。試験は loopback の script server だけ。
- Windows／macOS での取消の join（DR-DT5-24）。DD-1a は Linux の cargo の試験だけ。
- Main の gate、seam、sender の束縛、key の判定、`NIR1_RESTRICTED_ONLY_COMMANDS`（DD-1b）。

## 実装後の追記（2026-10-26。上の行は実装前の記録のまま残し、変えた点はここに足す）

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DD1A-13 | 2026-10-26 | DD-1a | 会話の current な capture の読取（P11）。`nir1_prepared_request::current_submission_for_session` が、caller から capture の writer と同じ `capture_owner`（今の route の revocation generation を含む）を作り、grimodex-db の `read_current_capture_for_session_bounded` で、その session の state が current の capture のうち owner_json と Scene が一致するものだけを、既存の current-capture の reader（`read_current_chat_input_capture_in_tx`）で確かめてから `NativeAcceptedChatSubmission` にする。historical な version ID は受けず、別の caller・epoch・workspace の incarnation・route の世代の capture は None（typed `NIR1_LOCAL_CAPTURE_NOT_CURRENT`）。DT-2 の create と claim がさらに読み直す | capture の能力を作れるのは、その session の今の capture をその owner が持つときだけ | capture の N-API が受理した能力を process 内に保存して start で引く（capture の入口の挙動を変える。K5/3:586 は capture の入口を変えないとする） | 不要 | 該当なし | P2 の 7 | 実装・試験済み（E5） |
| DR-DD1A-14 | 2026-10-26 | DD-1a | 読取の行の順（DR-DD1A-10 の変更）。version の `created_at_ms` ではなく、version 行の rowid（書いた順）で並べる。Human の行の時刻は renderer の値（capture の `createdAt`）で、Native の時刻の出力と比べると順が入れ替わる（試験で入れ替わった）。表示には `createdAtMs` をそのまま返す | 並びは表示の順だけで、範囲（どの行を返すか）は変わらない | created_at の順のまま（renderer が順を決められる） | 不要 | 該当なし | 不要 | 実装・試験済み（E4） |
| DR-DD1A-15 | 2026-10-26 | DD-1a | 取消の再実行（DR-DD1A-9 の補足）。entry に「取り下げた」（`withdrawn`）と「writer が終端の結果に達した」（`capture_settled`）を持つ。run が final でも、取り下げ済みで writer が未了なら、再実行は owner の `cancel()` と writer をやり直す（K4/3：同じ command の再実行で続けられる）。continue は、取り下げの writer が未了の handle を空の差分でも外さない（final から 60 s の保持の後は start の掃除が外す。その後は既存の `cancel_current_chat_input` が同じ writer を持つ） | 再実行も同じ caller の一致を要する | 終端の後は常に何もしない（writer の失敗の後に capture を cancelled にできなくなる） | 不要 | 該当なし | P8 の行 | 実装・試験済み（E8b、E8d） |
| DR-DD1A-16 | 2026-10-26 | DD-1a | 分類と型。`evals/quality-manifest.yaml` の GDX-POLICY-001 に `nir1_local_entry.rs`（attempt の前の policy の検査を結線する場所）を `implementedBy` に、`nir1_local_entry_tests.rs`（E6、E6b）を `lightTests` に足した。impact-map は既存の glob で分類済み（変更なし）。`index.d.ts` に 7 つの method を、napi の生成と同じ形で手で足した（napi build は走らせていない）。`NAPI_COMMANDS`、`NapiBackendLike`、`AI_TRANSPORT_COMMANDS` は変えていない（DD-1b／c） | 分類だけ | manifest を変えない（policy の検査の結線の場所が分類に出ない） | 不要 | 該当なし | 不要 | 実装済み |

### 試験（`electron/native/grimodex-node/src/nir1_local_entry_tests.rs`、19 件）と変異

E1（gate 閉で 6 command が引数・caller identity を読む前に拒否、DB と recorder は不変、開けると同じ start が通る）、E1b（製品のコードが gate を開けない、entry が event を出さない）、E2（印は ID だけ、title と model は既定値、CW の改名で一覧・start・read が不変、live でない Scene・未登録の caller・形の違いを拒否）、E3（一覧は印のある会話だけ、偽の接頭辞と通常の session を返さない、表示名は purpose と作成時刻だけ）、E4（read は capture の入力とこの route の成功の出力だけ、capture のない user 行・他の provider の出力・改変した行の内容を返さない、印のない session は拒否、別の caller も読める、範囲と limit）、E5（capture の前の検査の各拒否で attempt・監査・接続・記録が 0、key を外して押し直すと 1 回送る）、E5b（DT-1 の gate が開く前の start は押し直せる）、E6（policy の拒否・create の清潔な失敗〔VetoCommit〕・成功の後の押し直しを記録で拒否）、E6a（進行中の 2 件目は `SessionBusy`、接続 1 のまま、押し直しは記録で拒否）、E6b（Writing の bodyWrite／Review の analysis が false、読めない値で attempt・監査・接続・owner が 0）、E7（別 sender・別 epoch・別 caller session・未知の handle は同じ拒否、1 回 64 KiB、drained の後は消える）、E7b（登録の外れた caller は CALLER_REVOKED で run が止まり capture は current）、E8（create の前・create と claim の間・claim の COMMIT の後・開始判断の前・送信の後の取消で、capture は cancelled、開始判断の前は送信 0〔create の前は attempt 0、その後は Cancelled の終端 1 件〕、送信の後は socket が閉じる）、E8b（writer の失敗は成功にならず、再実行で cancelled）、E8c（終端の後の取消は何も変えない）、E8d（writer の入口が拒否されても owner が先に止まる）、E9（sender の取消は capture を変えない）、E9b（transport の間に startup lease が 0、他が DB の接続を持つ間も continue と `cancel()` が 250 ms の内に戻る）、E10（Writing と Review が recorder に 1 回、body の digest が attempt の payload digest と一致、監査の 5 件の順、別の AppState で同じ DB を開き直した後も一覧と読取が会話を返す）。grimodex-db の `the_mark_parser_and_the_glob_agree`（parse と GLOB が同じ ID を選ぶ）。

| 変異（commit しない） | 落ちた試験 |
|---|---|
| M1 Native gate を既定で開く | E1 |
| M2 `check_before_attempt` を飛ばす（不許可でも既定の basis で進む） | E6、E6b |
| M3 start の記録を DT-2 の `capture` の後に置く | E6a |
| M4 start の記録で拒否しない | E6、E6a |
| M5 cancel から capture の writer を外す | E8、E8b |
| M6 cancel から entry の owner の `cancel()` を外す（registry 経由の cancel は残る） | E8d |
| M7 印を title に置き、一覧を title で引く | E2 |
| M8 continue／cancel が caller を照合しない | E7 |
| M9 read が digest の照合に落ちた行の本文を返す | E4 |
| M10 continue が登録を再確認しない | E7b |
| M11 どの ID もこの route の会話とみなす | E2、E4、E5、E6b、E10 |
| M12 owner の `cancel()` を writer の後に呼ぶ | E8d |

実行：grimodex-node `--lib`（688 件通過、7 件 ignored。E8d を足す前の実行）、`--lib nir1_local_entry`（19 件通過）、grimodex-db `--features native-current-human-capture --lib local_conversation`（1 件）。`cargo +1.99.0 clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings` は警告 0。grimodex-db を `native-current-human-capture` つきで 1.99.0 の clippy にかけると、master の既存の 5 件（`nir1_packing.rs:1488`、`nir1_generation.rs` の型の複雑さ 3 件、`nir1_packing_tests.rs:1223`）が出る（CI はこの feature で db を lint しない。DD-1a の file の指摘は 0 にした）。`node --test` の architecture（37）、impact-map（37）、quality-workflow（23）、certify-gate-b2-bindings（13）、freeze-gate-b2-candidate（1）、`eval-fixtures.mjs` と `impact-map.mjs`、vitest の `aiPathRegistry.test.ts`（71）と electron の 6 file（288）が通過。

### capture の前に置いた検査の一覧（PR 本文に写す）

1 Native gate → 2 引数の形と Main の key 判定の形 → 3 restricted・in-flight 停止済み・登録済みの caller → 4 key 判定 `absent` → 5 DT-1 の startup gate が Open → 6 会話の印・purpose・Scene（live） → 7 この caller の current な capture → 8 handle の空き → 9 start の記録の空き。以後（DT-2 の `capture` の段の拒否、AI 使用ポリシー、D-final、create、再観測、claim、送信）は押し直せない。

### TASK §8 のうち確かめたこと

- 6（印の置き場と既存の画面の共存）：import（Novelcrafter の chat）は session に新しい UUID を振り、通常の会話の作成は `crypto.randomUUID()`、IPC は chat の ID を 256 文字以下の trim 済み文字列として扱う。どれも印を作らず、印のある ID を拒否しない（コードで確認。E3 が偽の接頭辞を除くこと、E2 が既定の title のままであることを固定）。
- 7（本文が空の成功）：continue は `succeeded` と空の text をそのまま返す（判断のみ。専用の試験はない）。
- 12（heavy cargo の排他）：repo の外のローカルの道具（scratchpad の `heavy.sh`、flock の 3 slot）で、repo には無い。
- ほか（1〜5、8〜11）は DD-1b 以降か評価の範囲で、DD-1a では確かめていない。

### DD-1b への申し送り

- N-API の形：`nir1LocalGenerationStart(intent, mainVerdict, callerIdentity)`（intent は `{purpose: "writing"|"review", conversationId, sceneId}`、mainVerdict は `{endpointId, keyVerdict: "absent"|"present"|"check-failed"}`）、`nir1LocalGenerationContinue({handle}, …)`、`nir1LocalGenerationCancel({handle}, …)`、`nir1LocalConversationCreate({purpose, sceneId}, …)`、`nir1LocalConversationList(callerIdentity)`、`nir1LocalConversationRead({conversationId, offset, limit 1〜64}, …)`。どれも JSON 文字列で `status` を持ち、拒否は `{status, reason}`（typed）。ID は 256 bytes 以下の trim 済み文字列。
- Main 専用：`mainOpenPrePublicationGate("nir1-local-generation")`（seam だけ）、`mainNir1LocalGenerationCancelSender(senderId)`（sender の destroyed／window の close）。どちらも `NAPI_COMMANDS` に載せない。epoch の変化は Native の continue が登録の再確認で止めるが、Main からも sender の取消を呼ぶ。
- key 判定は endpoint の id ごと（`default` は旧 account を含む）に Main が行い、`endpointId` は Native が解決した route の endpoint と一致しないと D-final が拒否する（`NIR1_PREPARED_ENDPOINT_ID_MISMATCH`。start の後の段で、押し直せない）。
- renderer（DD-1c）：continue の間隔は 100 ms 以上を推奨、state は `starting`／`running`／終端の 3 種、`drained` で handle が消える。押し直せる拒否は上の一覧の 1〜9 の理由だけ。

### 確かめられなかったこと（実装後）

- 受入れ試験は実装と同じ commit で書いた。「修正前に落ちる」ことは、実装前の実行ではなく、上の変異 M1〜M12 で各試験が落ちることで確かめた。
- `electron/native/grimodex-node/test/*.test.mjs`（node の addon の試験）は、この worktree に build した `.node` がなく実行していない。napi build も走らせていない（`index.d.ts` は手で追随）。
- 実 Electron、Windows／macOS、実 local server／model、IPv6（`[::1]`）の route での入口の試験（transport の `[::1]` は DT-5 の C1c）。
- cold reopen は、同じ DB の file を新しい AppState で開き直す形で確かめた。process の再起動で start の記録と handle が消えることは構造（process 内の値）による。
- 高リスクの判断（印の置き場、capture の前の検査の配置、starter thread）について read-only の advisor の意見は取れていない（この builder に手段がない）。独立のレビュー（lifecycle とセキュリティの 2 名）と Fable の受入れは integrator に委ねる。
- Quick／Full は走らせていない（integrator）。
