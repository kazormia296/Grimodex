# DB 接続の改善の判断の記録（DR-DBC。A：WAL checkpoint を本体の接続の外へ、B′：監査の検証の計算を速く）

出所は DB 接続の根本改善の調査（read-only の設計の比較 `design-comparison-v2.md`。計測は `runs/summary.md` の「commit の内訳」と「publish の tx の内訳」。置き場は `fusion-eval-data/design-notes/db-connection-2026-11-07/`）。基点は `origin/master` の `a2309b95`、branch は `claude/db-bg-checkpoint`。

B′（DR-DBC-2）の基点は `origin/master` の `5344067d`、branch は `claude/audit-verify-fast`。B′ の出所は、同じ置き場の `audit-verify-prior-art.md`（先行事例）と `audit-verify-bench.md`（試作の計測）。

## 0. 承認と範囲

これは DB 接続の lane で、NIR-1 の残レーンへの事前委任（AGENTS.md）の外にある。委任には頼らず、ユーザーの個別の承認に基づく。

- 2026-11-07：DB 接続の根本改善の方針（根は 1 本の接続が排他と鮮度の物差しを兼ねること。計測は今、実装は CP-4 の後・PUB-G の前、実装の前に確認に戻る）。
- **2026-11-08：ユーザーが「A を CP-4 の前に入れる」と決定**（`design-inputs.md` 末尾の Q1〜Q4。A と B だけを CP-4 の前に入れる）。この文書は A（DR-DBC-1・1a）と B′（DR-DBC-2）を扱う。A は PR #829、B′ は PR #830。
- 変えない：閾値・送信先・保存範囲・契約・脅威モデル。新しい IPC・preload・N-API・schema・依存は足さない。
- **2026-11-08：ユーザーが B を「(b) 検証の計算そのものを速くする。強さは同じ」と決定した。** 当初の B は「監査の chain の検証を publish の tx の外へ出す」案だった。これは検証と publish の間に別の writer が入る窓を作り、「検証した chain」と「publish が束縛する chain」の同一性の証明が要る（threat model の改訂に当たる）ので止め、計算を速くする方へ切り替えた。
- Merkle tree・差分の検証（前回の検証済みの位置からの続きだけを調べる案）は、前に保存した digest を DB の外の信頼できる場所に置く前提を要し、DB を書き換えられる攻撃者に対する強さが変わる。**1b の後の Q4 で決める**。この PR では扱わない。
- 変えない：検証の強さ・判定の順序・報告する結果（ok・verified_through_sequence・broken_at_sequence・reason・tail_hash）・error の種類と文面、閾値・送信先・保存範囲・契約・脅威モデル。新しい IPC・preload・N-API・schema・依存は足さない（rayon などは使わず、std の `thread::scope` だけ）。

## 1. 事実（根拠の計測。同じ W1、dev 枝の計装）

| 事実 | 値 |
|---|---|
| IR の publish の commit（`commit_or_rollback`） | p50 1.67 s、p99 2.0 s。ほぼ全部が autocheckpoint（p50 1.666 s）。COMMIT の本体は p50 6 ms。publish の 20 tx すべてで、commit の中に checkpoint が走った |
| publish の tx の外 | 保存・設定などの write の commit で 367 回、p50 0 ms、p99 943 ms、最大 1.10 s。checkpoint 時の WAL は 1000〜3622 page |
| 前景の待ちとの重なり | 待ち時間の合計の 39.0% が checkpoint の区間と重なる。100 ms 以上の待ち 237 件のうち 80 件が重なる |
| autocheckpoint を切った比較 | publish の tx は p50 4.38 s → 2.79 s。前景 `db_execute` の lock_wait は p99 885 ms → 368 ms、待ち時間の合計 297 s → 194 s（-35%）。COMMIT は p50 8.5 ms |
| 比較の代償 | WAL は最大 278 MB まで伸びた（既定の run は最大 15 MB）。**背景の checkpoint で今と同じ程度に抑えることが必須** |

原因：SQLite の既定の autocheckpoint は commit の中で、commit した接続の上で同期に走る。本体の接続は `Mutex<Connection>` を握ったままなので、前景が待たされる。

## 2. 判断の表

| ID | 日付 | 判断 | 信頼境界 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-DBC-1 | 2026-11-08 | **公開した workspace の本体の接続（`WorkspaceAuthority::new` が受け取る `Database`）の autocheckpoint を、wal hook に置き換え、WAL の page 数が閾値（`WAL_CHECKPOINT_PAGES`＝1000。既定の autocheckpoint と同じ値で、変えない）以上のとき背景のスレッドへ知らせるだけにする。** 背景のスレッド（`grimodex-wal-checkpoint`）は、1 回ごとに checkpoint 専用の接続（`READ_WRITE`、作成なし、busy_timeout 250 ms）を開き、`PRAGMA wal_checkpoint(PASSIVE)` を回して閉じる。TEMP 表・ReadIdentity・stamp には関わらず、専用の接続は何も commit しない（**2026-11-15 に DR-DBC-6 が改訂**：PASSIVE が WAL を全部書き戻した run の直後だけ、背景のスレッドが**本体の接続の上で**、同値の `application_id` を 1 回 commit して WAL の restart を先払いする。専用の接続の性質は変わらない）。背景が使えない間（止めた後・失敗が 3 回続いた後）は、hook が SQLite の既定と同じ同期の PASSIVE checkpoint に戻る（スレッドが作れないときは hook を入れず autocheckpoint のまま）。**背景が追いつかないとき（commit が続く burst、読み手が止めている間）の上限は、閾値の 4 倍（`MAX_WAL_PAGES_BEFORE_SYNC`＝4000 page、4 KiB page で約 16 MB）**：それ以上では hook が、背景の run が終わるのを最大 5 s 待ってから、同期の PASSIVE checkpoint を行う（レビュー指摘 major-2）。理由：PASSIVE は開始時点の末尾までしか書き戻さず、WAL の先頭へ戻すのは「書き手が始まる時に全部書き戻し済み」のときだけなので、書込みが速い burst では背景の 1 回の run が追いつく前に WAL が伸び続ける（試験で、150 page を 1 ms で 300 回書くと、背景だけでは 46000 frame まで伸びた）。また PASSIVE は checkpoint の lock を持つ別の接続（背景）がいると何もせず BUSY で戻るので、同期の checkpoint は背景の run と重ならないよう待ち、その間は背景が新しい run を始めない。4000 page は、既定の autocheckpoint の実測の最大（3622 page、約 15 MB）と同じ程度で、WAL の最大を今と変えない。この待ちは前景への back-pressure で、上限を超えたときだけ起こる。待ちが 5 s を過ぎる（背景の run が止まらない異常）ときは、その run には**二度と待たず**（run に世代番号を持たせ、待ちを諦めた世代を覚える。止まった run に上限を超えた commit が毎回、本体の Mutex を握ったまま 5 s 払うのを避ける）、同期の PASSIVE を試すだけにする。止まった run が checkpoint の lock を持つ（専用の接続を開いた後で止まる）と PASSIVE は BUSY で進まず、WAL の上限は保証しない。実装は `grimodex-db/src/background_checkpoint.rs` | 信頼する：Electron main の native（`WorkspaceAuthority` の所有者）。信頼しない：renderer（SQL は従来どおり authorizer の下の本体の接続。checkpoint の接続は renderer から到達できず SQL を受けない）、他の process（standalone MCP は別の接続で、従来どおり自分の autocheckpoint）。受信先・送信先・保存範囲は変わらない（同じ file への checkpoint だけ）。防御：PASSIVE だけ（RESTART／TRUNCATE は使わない）なので書き手・読み手を待たせず、WAL の先頭へ戻すのは次の書き手 | (a) `wal_autocheckpoint=0` のまま背景だけ（背景が止まると WAL が無限に伸びる。却下）(b) polling（commit の知らせが無く、idle で起き続ける。却下）(c) 専用接続を常駐（file handle が restore・Windows の置換の邪魔になる。却下。1 回ごとに開閉する）(d) RESTART／TRUNCATE（読み手・書き手を待つ。却下） | 実装済み（Draft PR） |
| DR-DBC-1a | 2026-11-08 | **open の WAL 準備（`open_wal.rs`）の「`wal_autocheckpoint` が正」の検査の意図を確かめ、単位の出所を直す。** 意図：`prepare_wal_for_open` は、前の process が残した WAL が閾値の 3/4 以上なら RESTART で畳み、閾値を超えていたら同期の checkpoint の仕事量が大きすぎるので畳まず（`DeferredWorkLimit`）、公開前の checkpoint の仕事を「設定された autocheckpoint の 1 周期」以下に抑える。検査は、その 1 周期（page 数）が正であることを求める。つまり安全の検査というより、仕事量の単位が実際に誰かが守る正の上限であることの検査（0＝何も上限が無いなら、単位が無い）。背景が上限を守る形では pragma が 0 になる（wal hook を置くと `PRAGMA wal_autocheckpoint` は 0 を返す）。そこで、単位を `wal_cycle_pages(pragma, background)` で決める：pragma が正ならそれ、0 で背景の checkpointer が動いているならその閾値、どちらも無ければ今までどおり `OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE` で拒否する。背景の閾値を単位にしてよいのは、wal hook が実際に背景のものであると確かめられたときだけ（レビュー指摘 minor-2）：`background_checkpoint_bound` が `sqlite3_wal_hook` を同じ callback と引数で入れ直し、戻り値（直前の引数）が背景の `Shared` と一致するかを見る。一致しなければ（hook が別のものに置き換わっている）入れ直した上で上限なしとして拒否する。pragma の値は準備の前後で変えない（`verify_connection_settings` は生の値を比べる）。公開の経路では、準備は背景を始める前（`WorkspaceAuthority::new` の前）に走るので、単位は今までどおり pragma の 1000 になり、振る舞いは変わらない | 検査を外す案ではなく、上限の保証を「autocheckpoint か背景」のどちらかが必ず持つ形にした。fail-closed は保つ | (a) 検査を削除（上限が無い接続を黙って通す。却下）(b) 準備の前に背景を始める（準備の RESTART が背景の接続と競合しうる。却下） | 実装済み |
| DR-DBC-2 | 2026-11-08 | **監査の hash chain の検証を、結果を変えずに速くする。(1) S1：payload を `Value` に parse した後、全 object の key が昇順なら `canonical_json_value` の clone と整列を省き、そのまま直列化した bytes の sha256 を取る（昇順でなければ従来の経路）。(2) 上限つきの並列：行ごとの計算（parse・契約の検証・payload の sha256・`compute_hash`）を、最大 4 thread（`min(4, 論理 CPU 数 / 2)`、最低 1）の `std::thread::scope` で並列に行い、連番と `prev_hash` の連結の判定は行の順に呼び出し側の thread で行う。行は「1,024 行、または payload の合計 4 MiB」の先に当たる方で batch に切って読み、次の batch の読み出しを今の batch の計算と重ねる（memory は batch の大きさに比例し、行数にも payload の大きさの偏りにも比例しない）。行数が 1,024 行以下なら逐次。thread を作れないとき（OS の資源の枯渇）は panic せず、その chunk を呼び出し側の thread で逐次に計算する。payload 以外の列を読む順は従来と同じ（payload を先に読んで parse し、他の列の error はその後）。** 実装は `grimodex-db/src/ai_audit.rs`（`verify_stored_chain` ほか）、試験は `ai_audit/verify_tests.rs` | 信頼する：Electron main の native が持つ本体の接続（読むのは今と同じ行・同じ列）。信頼しない：保存された監査の行（DB を書き換えられる攻撃者が作りうる。今と同じく全行を検証する）。thread は `thread::scope` の中だけで、戻る前に必ず join する（常駐・detach・新しい受信先・送信先は無い）。`Connection` は呼び出し側の thread から出ない（worker は読み出し済みの文字列だけを見る） | (a) 検証を publish の tx の外へ（窓ができ、同一性の証明が要る。却下。ユーザーの選択）(b) 生 bytes の sha256 が一致すれば正規化を省く（正規形でない生 bytes に合わせて `payload_sha256` と chain を計算し直した改ざんを通す。強さが変わる。却下）(c) 生 bytes の sha256 一致かつ生 bytes が正規形のときだけ通す（同値だが、S1 より約 4% 速いだけで論証と試験が増える。採らない）(d) 契約の 4 項目だけ読む parse（範囲外の数値で error の有無が変わる。却下）(e) rayon（製品の依存を増やさない）(f) Merkle・差分の検証（Q4 で決める） | 実装済み（Draft PR） |

## 3. owner／lifecycle matrix（GDX-PRECHECK-001。background work なので mutation の前に置く）

owner は `Database` が 1 つだけ持つ `BackgroundCheckpointer`（スレッドの JoinHandle と共有状態 `Shared`）。スレッドは `Arc<Database>` や authority を持たず、path と `Shared` だけを持つので、`wait_for_sole_owner` の数に入らない。（**DR-DBC-6 の改訂**：先払いのため、スレッドは `Weak<ConnectionCore>`〔主接続・waiter・reservation・health だけの core。`Database` でも authority でもない〕を持つ。`Weak` は数に入らず、先払いの間だけ upgrade し、run の中で必ず放す。）

| 区分 | 条件 |
|---|---|
| entry（開始） | `WorkspaceAuthority::new` だけ（open の公開、restore の公開 `publish_active_workspace`、restore 失敗後の `reactivate_workspace`、Native の descriptor recovery の authority が通る。全部この 1 点）。`Database::start_background_checkpoint` は、file の WAL 接続で、読取専用でないときだけ開始する。memory・読取専用（c-query worker の reader）・WAL 以外は何もしない。失敗は warn で、open は失敗させない（autocheckpoint のまま） |
| start | スレッドを作ってから hook を入れる。スレッドが作れなければ hook は入れない（autocheckpoint のまま）。hook を入れる前の commit は従来の autocheckpoint |
| retry／reentrant | 同じ `Database` で 2 回目の start は `AlreadyRunning`（何もしない）。止めた後に始め直せる。hook は I/O も待ちも行わず、`pending` を立てて通知するだけ。run は 1 本ずつ（スレッドは 1 本）。連続 2 回の run は 100 ms 以上あける。PASSIVE が終わらない（読み手が止めた）ときは 500 ms で最大 10 回再試行し、新しい知らせで回数が戻る |
| admission closure | 停止で `mode=Stopped` にし、以後の hook は知らせず同期の checkpoint に戻る（上限は保つ）。新しい run は始まらない |
| pending start | スレッドが hook を入れる前に止まることはない（start は slot の lock の下で、スレッド生成→hook の順）。start の途中の停止は slot の lock で直列化される |
| active handle ownership | checkpoint 専用の接続は run の間だけ存在し、run の終わりに閉じる（常駐しない）。実行中は `InterruptHandle` を共有状態に置き、停止が `sqlite3_interrupt` で中断する（`walCheckpoint` は frame の copy ごとに中断を見る）。本体の接続は従来どおり `Database` の `Mutex<Connection>` |
| cancellation | 停止の要求（`stop` flag）と interrupt。run の開始の直前に stop を再確認する（interrupt の登録と同じ lock の下） |
| bounded wait | 停止の待ちは `STOP_WAIT`＝5 s が上限。待ちの間、実行中の checkpoint へ `sqlite3_interrupt` を 50 ms ごとに打ち直す（handle の登録から step の開始までの間に届いた interrupt は step の開始で消えるため）。超えたら `TimedOut` を返し、JoinHandle は残す（次の stop が同じスレッドをもう一度待てる）。**`TimedOut` のまま先へ進まない**：restore は元の authority を戻して中止し（`RESTORE_BACKGROUND_CHECKPOINT_STOP_TIMEOUT`、live には触れていない）、recovery の retire は何も変えずに `Err`（`…RETIREMENT_BACKGROUND_CHECKPOINT_STOP_TIMEOUT`）を返す（fail-closed。GDX-PRECHECK-001 の actual termination evidence）。`Database` の drop だけは待ちの後に進む（drop 後に置換する経路は restore／open で、restore は上の明示の停止で止まる）が、その場合も専用の接続は次の 2 つで害を作らない。本体の接続の Mutex は取らない（前景の保持者を待たない） |
| detached の害の遮断 | 専用の接続は `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` で開く（最後の接続として閉じても close 時の checkpoint と `-wal`／`-shm` の path での削除をしない。置換の後の新しい file の WAL を消さない）。停止の要求の後は、専用の接続を新しく開かない（run の先頭で確かめる。置換の後に新しい file を開く窓を作らない） |
| termination evidence | スレッドの終了は `ExitGuard`（`exited` を立てて通知）。`stop` は `exited` を待って join し、`StopOutcome::Joined`／`TimedOut`／`AlreadyStopped` を返す。error や interrupt だけを終了の証拠にしない。panic・失敗は `mode=Failed` にして同期の checkpoint に戻す |
| error／timeout／onClosed | run の失敗は warn と `failures` の計数。3 回続いたら背景をやめて `Failed`（hook は同期に戻る）。stop 中の失敗は計数しない。接続を閉じる失敗は SQLite 側の close に任せる（checkpoint 専用の接続は更新しないので失う状態が無い） |
| persisted restart state | なし。checkpoint は WAL を DB file へ書き戻すだけの運用操作で、状態を持たない。次の open は WAL を再検査する（`prepare_wal_for_open`） |

lifecycle の各場面：

| 場面 | 止める・作り直す点 |
|---|---|
| 開く | `WorkspaceAuthority::new`（公開の直前）で開始。open の WAL 準備は開始の前に走る |
| 閉じる・workspace の切替え | authority の最後の参照が落ちると `Database` が drop され、`Drop for Database` が **本体の接続を閉じる前に** 背景を止める（最後の接続の close が WAL を畳めるよう、checkpoint 専用の接続を残さない）。同じ path の再 open は `QuiescedSamePath` が旧 authority を落としてから新しい authority を作る |
| backup（`VACUUM INTO`） | 背景は動いたまま。PASSIVE は読み手が持つ snapshot を越えて進まないので、複製の一貫性に影響しない（試験で確かめる） |
| restore | `wait_for_sole_owner` の後、安全複製・live seal・atomic replace の前に `stop_background_checkpoint` を **明示的に**呼ぶ（drop の順序に依存しない）。`TimedOut` なら `old` を戻して中止する。`drop(old)` でも止まる。新しい authority を公開するときに新しい背景が始まる。失敗の経路（`abort_install`・`reactivate_workspace`）も同じ `WorkspaceAuthority::new` を通る |
| maintenance の retire・recovery | `retire_connection_for_recovery` が、接続を差し替える前に背景を止める（接続の Mutex は取らない）。`TimedOut` なら何も変えずに `Err`。以後は同期の checkpoint |
| 失敗 | 背景の失敗は本体を壊さない（本体の接続は触れない）。hook は同期に戻る |
| 上限を超えた burst | hook が背景の run の終了を待ってから同期の PASSIVE（上の判断の表）。待っている間、背景は新しい run を始めない（`sync_active`） |
| process の終了 | 本体の接続と背景のスレッドは process とともに消える。WAL は次の open の準備が扱う |

## 4. 変えるもの・変えないもの

変える：

- 公開した authority の接続の checkpoint の実行場所（commit の中・前景のスレッド → 背景のスレッド・別の接続）。
- open の WAL 準備の単位の出所（DR-DBC-1a）。

変えない：

- **閾値は 1000 page のまま**（`PRAGMA wal_autocheckpoint=1000` と同じ値。`Database::new` の既定は変えない。試験で同じ値を固定）。`journal_size_limit`（64 MiB）、`synchronous=NORMAL`、WAL mode。
- `Database::new` の既定、migration・recovery・backup の staged DB、maintenance の別接続（`new_for_workspace_maintenance`。前景の Mutex を握らない背景の接続なので、その autocheckpoint は残す）、c-query worker の読取専用の接続は autocheckpoint のまま。
- ReadIdentity・stamp・data_version・Freshness の判定（checkpoint はこれらを動かさない。試験で確かめる）。PASSIVE は wal-index の header（mxFrame・salt）を変えないので `data_version` は動かず、WAL を先頭へ戻すのは次の書き手。
  - **DR-DBC-6 の改訂**：PASSIVE（専用の接続）自体は変わらない。その後の先払いの commit は、本体の接続の `data_version`・`total_changes`・schema_version・user_version・ReadIdentity を動かさない（試験で確かめる）が、**別の接続から見た `data_version` は 1 回につき動く**。
- IPC・preload・N-API・schema・依存・契約・送信先・保存範囲。
- MCP（standalone の別 process）。

## 5. MCP の確認

`grimodex-mcp` は別 process で、`db.rs` の `open_db` が `Connection::open` ＋ `journal_mode=WAL`・`busy_timeout=5000` で自分の接続を作り、`Database::from_connection` で包むだけ（`WorkspaceAuthority` を通らない）。したがって背景の checkpointer は始まらず、SQLite の既定の autocheckpoint（1000 page）が従来どおり MCP の commit の中で走る。MCP の書き手は本体の Mutex と無関係で、前景を待たせない。**変更不要。**

同じ DB を Electron と MCP が開いているとき、MCP の commit の autocheckpoint と背景の PASSIVE は同じ checkpoint lock を取り合うが、どちらも PASSIVE（待たない）で、取れなければ次の機会に回る。WAL の先頭へ戻すのは書き手なので、背景の checkpoint が MCP の書き込みを待たせることはない。

## 6. 試験（`background_checkpoint_tests.rs`、`backup_restore.rs`、`open.rs`、`open_wal.rs`）

- 閾値が既定の autocheckpoint と同じ 1000 であること。
- 開始：autocheckpoint が hook に置き換わる、2 回目は `AlreadyRunning`、memory・読取専用は対象外（autocheckpoint のまま）。
- WAL が上限の近くに保たれる：対照（autocheckpoint も背景も無い）は閾値の 4 倍を超えて伸び、背景があると「閾値＋最後の 1 tx」以内（対照の 1/3 未満）、integrity_check が ok。
- checkpoint が data_version・total_changes・schema_version・ReadIdentity を動かさない（実行中・終了後・別の接続の PASSIVE・読み手の snapshot の中）。対照として、別の接続の commit では data_version が進む。（DR-DBC-6 の後は、先払いの commit についても本体の接続の値が動かないことを `a_prepay_changes_no_value_and_no_counter_of_the_main_connection` が確かめる。）
- 停止：冪等、停止後は同期の checkpoint に戻って WAL が畳まれる、始め直せる。**専用の接続を開いて interrupt の handle を登録した後（run の最中。注入点）に止めても、その状態にいることを観測した上で、上限の中に終了の証拠が取れ、file が壊れない。上限未満の大きい WAL（3500 page）の直後に止めても同じ。**
- **`TimedOut`（注入点で run を止める）**：スレッドと JoinHandle が残り、次の stop が同じスレッドを待て、停止の要求は失敗に数えられない。restore は中止して元の authority を戻し（live は未変更）、背景が止まれば同じ restore が通る。retire は `Err` で何も変えず（接続は reusable のまま）、止まれば成功する。
- 専用の接続は最後の接続として閉じても `-wal` を消さない（対照：普通の接続は消す）。停止の要求の後の run は接続を開かない。
- 上限：背景が止まっていても、書き手が連続しても（`wait_idle` を挟まない 100 commit）、WAL は `MAX_WAL_PAGES_BEFORE_SYNC`＋最後の 1 tx 以内。
- 止まった run には、上限を超えた commit が一度しか待たない（2 回目以降は待たずに進む）。
- 試験の一時領域は、1 KiB page の fixture で小さくする（この環境の /tmp には約 300 MB の容量制限がある）。
- open の WAL 準備：hook が背景のものでなくなる（pragma 0 が hook を消す）と、背景の閾値を単位にせず拒否する。
- 失敗：checkpoint 専用の接続が開けなくなると 3 回で背景をやめ、同期の checkpoint に戻り、本体は使い続けられる。
- drop：スレッドが終わり、checkpoint 専用の接続が残らず、最後の接続の close が WAL を消す。上限（5 s）を超えない。
- close との競合：大きい commit の直後に閉じる 15 回で、file の integrity と行数が保たれる。
- backup：背景の checkpoint と書き込みが走る間の `VACUUM INTO` の複製が一貫している。
- restore：実行前に背景の thread が止まっている、拒否された restore は authority と背景を変えない、restore 後の authority は新しい背景を持つ。
- recovery の retire：背景が止まる。
- open の WAL 準備：pragma が 0 でも背景の閾値を単位にする。背景も無ければ今までどおり拒否する。

## 7. 未決

- 本番の負荷（IR の publish と前景の書込みの同時）での効果の再測定は、PR の後に dev 枝の計装で行う（設計の比較の完了条件：commit_or_rollback の p99 が 100 ms 未満、`-wal` が 64 MiB 以下）。この PR の試験は機構（上限・lifecycle・識別）を確かめるもので、前景の待ちの短縮は計測で確かめる。
- B（監査の chain の検証）は B′（DR-DBC-2、PR #830。検証の計算を速くする。tx の外へ出す案は止めた）として別の枝。同じ crate を触るが、この PR は `Database` の field・`WorkspaceAuthority::new`・open_wal・restore の 1 行・retire の 1 行だけで、監査の tx とは重ならない見込み。

## 8. B′ の事実（根拠の計測）

IR の publish の tx の中で、監査の hash chain の検証（`verify_ai_audit_chain_for_scope`）が p50 0.82 s かかっていた（約 3.3 万行）。写しの DB（`ir-admission-perf/base-g-ja-1`、31,092 行、payload 67.8 MB）で、release build・warm の内訳（逐次、合計 668 ms）：

| 段 | 時間 |
|---|---|
| SQLite の読み出し | 80 ms |
| payload の parse（Value） | 190 ms |
| Value の drop | 35 ms |
| 契約の検証 | 4 ms |
| `canonical_stored_payload`（clone + BTreeMap 整列 + 再直列化） | 277 ms（41%） |
| payload の sha256 | 41 ms |
| `compute_hash` | 44 ms |

SHA-NI は使われている（約 1.9〜2.0 GB/s）。sha256 は合計でも約 85 ms で、支配的なのは DOM の parse・解放と、正規化の clone・整列・再直列化だった。parse は元から 1 回で、候補「parse を 1 回にする」は効果が無い。

## 9. 強さが同じであることの論証

- 今の検証が各行について確かめるのは、連番の連続、`prev_hash` が前の行の `hash` と一致すること、契約（`validate_stored_capture_contract`）、`sha256(canonical(parse(payload))) == payload_sha256`、`compute_hash(行の列) == hash`。この順に最初に見つかった不整合を報告する。
- **S1**：`canonical_json_value` は、各 object の key を `BTreeMap` で整列し直し、他は clone する。全 object の key が既に昇順（byte 順。`BTreeMap<String, _>` の順と同じ）なら、結果は元の Value と同じで、`to_string` の出力も同じ bytes になる。S1 は、その場合だけ clone を省いて同じ Value を直列化し、sha256 を取る。昇順でない場合（正規形でない保存）は従来の経路をそのまま通る。したがって、`canonical_stored_payload` の sha256 と常に一致する。非 object の payload は従来と同じ error。
- **並列**：行ごとの計算は、その行の列だけで決まり（`prev_hash` は保存された値を使う）、他の行に依存せず、副作用も無い。連番と `prev_hash` の連結の判定は、行の順に呼び出し側の thread で行い、各行の判定の順（payload の読み取り → 連番 → `prev_hash` → 契約 → payload の sha256 → hash）を保つ。最初に壊れた行を行の順で報告するので、複数の改ざんがあっても逐次と同じ位置・reason になる。「payload が JSON として読めない」error は、今は行を読む時の error（同じ行の連番の判定より先）なので、同じ順にした。読み出しの error は、それまでの行の判定の後に返す。
- 読み出しは 1 本の接続で、並列にするのは行ごとの計算だけ。pin した high-water より後の行は読まない（SQL は同じ）。

## 10. 同値性の試験

`ai_audit/verify_tests.rs`。**高速化の前の実装（origin/master `5344067d` の関数）をそのまま oracle として写し**、合成の fixture（400 行。key の順・入れ子・小数・非 ASCII・エスケープを含む payload）の DB を transaction の中で改ざんして、oracle と 8 つの計画（既定、thread 1・2・3・4・8、batch 1〜1,024、単一 batch、末尾が 1 行の batch）で、結果の全項目（ok・verified_through_sequence・broken_at_sequence・reason・tail_hash、error の文面）が一致することを確かめる。最後に ROLLBACK する。写しの DB の本文は試験に入れていない。

- 正常な chain、pin した high-water（pin より後の改ざんは見ない）、空の scope
- payload・hash・`prev_hash`・`payload_sha256` の改ざん（途中、先頭、最終行）、契約の違反（recorder）、payload が配列
- 連番の欠け（途中、最終行の削除は検出されない仕様のまま、pin した行の削除は error）
- JSON として読めない payload（壊れた JSON、末尾の余分な文字、範囲外の数値）：error。先の行の壊れが先に報告されること、同じ行の連番の欠けより先に error になること
- 複数の改ざん：最初の行を報告。同じ行の複数の違反は判定の順
- 重複 key（最後が勝つ。今と同じ結果）
- 正規形でない payload（key の逆順。top-level だけ・入れ子も）：`payload_sha256` が正規形の sha256 のままなら通る。`payload_sha256` を生の text の sha256 にして以降の chain を計算し直した自己整合の改ざんは、今と同じく payloadSha256 mismatch で止まる
- 境界：非先頭の batch の先頭行での連結の判定、batch の末尾の行の hash、batch の途中で payload 以外の列が読めない場合（payload の parse の error との重なり、blob の payload、先の行の壊れ、同じ行の連番の欠けとの重なりを含め、error の文面まで oracle と同じ）、thread を作れない場合（1 回、2 回、全部失敗。結果は oracle と同じ）、行数が閾値を超えて既定の計画が並列の経路を通る場合（公開の関数が oracle と同じ）、batch の bytes の上限による batch の分割
- 補助：整列済みの直接直列化の sha256 が、正規形の sha256 と一致すること、計画（1,024 行以下は逐次、上限 4 thread、batch は 1,024 行・4 MiB で固定）

## 11. 並列の上限と CPU の取り合い

試作の計測（`audit-verify-bench.md`、12 コアの機）：

| 計算 | wall | 総 CPU |
|---|---|---|
| 今（逐次） | 668 ms | 665 ms |
| S1 逐次 | 468 ms | 465 ms |
| S1 ＋ 4 thread | 約 190 ms | 約 470 ms（平均 約 2.5 コア） |
| S1 ＋ 8 thread | 150 ms | 約 550 ms |
| S1 ＋ 12 thread | 144 ms | 約 670 ms |

- 上限は 4 thread：8 thread 以上は wall が 190 → 150 → 141 ms で頭打ち（読み出しの 80 ms が逐次のまま残る）なのに、総 CPU が +17%（8）・+40%（12）増える。4 thread なら総 CPU は今（665 ms）より小さい（約 470 ms）まま wall が約 1/3.5 になる。
- 前景の操作と取り合うのは、約 0.2 秒の間に平均 約 2.5 コア（最大 4 thread。読み出しを行う呼び出し側の thread を含めると同時に最大 5 本）だけ。論理 CPU が少ない機では `min(4, 論理 CPU 数 / 2)`（最低 1）にして、前景の分を残す（2 コアなら逐次）。
- 下限：1,024 行（1 batch。約 15 ms の計算）以下は逐次。読みと計算を重ねる利益が無く、thread の起動（数十〜百 µs）の費用の比が大きいので。
- memory：全行を持たず、batch ごとに読む。batch は「1,024 行、または payload の合計（と行ごとの概算 512 bytes）が 4 MiB」の先に当たる方で閉じる。通常の payload（約 2 KB）では 1,024 行（約 2 MB）が先に当たる。payload の大きさに上限は無く（観測した最大は約 51 KB）、行数だけで切ると 1,024 行で 50 MB を超えうるので、bytes の上限を足した（4〜8 MB を候補にし、4 MiB にした。通常の batch の大きさ約 2 MB の 2 倍で、大きい payload が続いても 1 batch が 4 MiB と最後の 1 行〔観測では約 51 KB〕を超えない）。最悪の memory は、今の batch と先読みの batch の 2 つ分（約 8 MiB と最後の行）に、worker の DOM（1 行ずつ作って捨てる）を足した程度で、行数に比例しない。今の関数は行を 1 つずつ処理して捨てるので、memory は今も行数に比例しない。process の peak RSS（VmHWM）の増加は、前の実装が +20 MB（SQLite の page cache 16 MB を含む）、後が +29 MB（batch 2 つ分の文字列と、worker の DOM・stack で +9 MB）。31,092 行（通常の payload）で測った値で、batch の大きさが上限で固定されるので行数が増えても増えない。

## 12. 前後の時間（製品の関数、写しの DB、release、warm）

同じ写しの DB（`ir-admission-perf/base-g-ja-1`、31,092 行、payload 67.8 MB）と同じ test binary（release）で、高速化の前の実装（oracle の写し）と製品の関数を、別 process で 3 回ずつ交互に測った（各 process は 1 回目と、warm の 7 回の中央値）。12 コアの機で、計測の前に他の cargo・rustc・vitest が無いことを待った。

| | 1 回目 | warm の中央値（7 回）の 3 process | 最小〜最大 |
|---|---|---|---|
| 前（oracle） | 685・689・685 ms | 673・668・672 ms | 661〜680 ms |
| 後（製品の関数。4 thread） | 159・185・158 ms | 145・146・145 ms | 143〜154 ms |

約 4.6 倍速い（669 → 145 ms）。IR の publish の tx の中の検証は、0.82 s の約 1/4.6 になる見込み。

## 13. owner／lifecycle matrix（GDX-PRECHECK-001。background work に当たるかの確認）

新しい常駐・background work は無い。thread は `verify_ai_audit_chain_for_scope` の呼び出しの中の `std::thread::scope` だけで、関数が戻る前に必ず join する。

| 区分 | 条件 |
|---|---|
| owner | 呼び出し側（`with_conn` の中の native の thread）。worker の thread は関数のローカル（scope）で、Database・接続・authority・channel を持たない |
| entry | `verify_ai_audit_chain_for_scope` の呼び出しのたびに、行数が 1,024 行を超えるときだけ batch ごとに最大 4 thread を起動する（読み出しを行う呼び出し側を含め同時に最大 5 本） |
| retry／reentrant | 無し（関数は副作用が無く、同じ接続を再入しない） |
| cancellation／termination evidence | scope の join が終了の証拠。worker は読み出し済みの文字列だけを見るので、キャンセルの経路は不要（壊れた行が見つかったら、次の batch を読まずに戻る） |
| error／timeout／panic | **thread を作れなければ panic せず**（`Builder::spawn_scoped` の Err）、その chunk を呼び出し側の thread で逐次に計算する（`with_conn` の Mutex と publish の tx の中で動くので、panic で Mutex を poison しない）。worker の panic は join で呼び出し側に伝わる（`resume_unwind`）。逐次の panic と同じ扱い。timeout は無い（CPU のみ） |
| persisted state | 無し（読み取りだけ） |
| 前景との干渉 | publish の tx の中の検証が約 0.67 s から約 0.2 s になり、tx の保持が短くなる。CPU は平均 約 2.5 コアを約 0.2 秒 |

## 14. 脅威モデルに変更が無いことの根拠

- 監査の検証は「保存された監査の行が改ざんされていないか」を全行について確かめる防御で、DB を書き換えられる攻撃者を想定している。この PR は、検証の判定（どの入力でどの結果か）を変えない：判定の式は S1 で同じ値を安く求めるだけ、並列は行ごとの純粋な計算の順序を変えるだけで、報告の順序は逐次と同じ（§9、§10 の試験）。
- 検出する不整合の集合・最初の位置・reason・tail_hash・error の種類は同じ。強さを変える候補（生 bytes の sha256 だけで通す案、契約の 4 項目だけ読む parse）は、反例を実験で確認して却下した。
- 新しい actor・信頼境界・受信先・送信先・保存範囲・閾値・契約・authority は無い。renderer・IPC・N-API の契約は変えない。

## DR-DBC-3 段 1 の PR-1：commit の連番（clock）と lineage を DB の中に置く（物差しは変えない。2026-11-10）

経緯：DB 接続の根本改善の段 1（設計 rev1 `design-notes/db-connection-2026-11-07/stage1-design-rev1.md` と改訂注記）。PR-1 は「連番の表・TRIGGER・lineage を作り、物差しは変えない」段で、**連番を読む側は作らない**（読む側は PR-2）。
ユーザーの承認：2026-11-08 に C1（版 46・TRIGGER 約 440 本・rollback なし）、C2（連番と lineage を DB と backup に残してよい）、C3-b、C6 (a)。2026-11-09 に C4（脅威モデル。MCP は「常駐する MCP 全般」として読む）、C8（gate を 2 段に分け、未達は止まって再相談。書込みの上乗せは PR-1 の必須）、C5 は (a)（PR-2 の前提）。2026-11-10 に PR-1 の着手（「朝の『正式 run』は s7r1 を指す。PR-1 から着手」）。
この lane は NIR-1 の委任の外にあり、個別の承認に基づく。順序：PR-1・PR-2 を先に入れ、PR-3（stamp の削除）は S4 の再凍結と束ねる（C7 は PR-3 の前に改めて伺う）。

### 判断

1. 版は `grimodex-core/src/lib.rs` の `SCHEMA_VERSION`・`PREVIOUS_COMPATIBLE_SCHEMA_VERSION`・`PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION` を 45／44／45 から 46／45／46 に上げる。
2. 表を 2 つ足す：`grimodex_write_clock`（`name` TEXT PRIMARY KEY、`seq` INTEGER、桁あふれは `CHECK(typeof(seq)='integer')` で書込みを止める。rev1 §1.4）と `grimodex_db_lineage`（`id` の `CHECK(length(id)=32)`）。形は rev1 §1.1。
3. 対象表（`pragma_table_list` の schema＝main、type＝table）それぞれに、AFTER INSERT／UPDATE／DELETE の TRIGGER を 1 本ずつ足す（表 147 本×3＝441 本の見込み）。除くもの：`sqlite_%`、clock の 2 表、virtual、shadow、view。**TRIGGER の本体は NEW／OLD を参照しない**（D2a で closed の表の Read 拒否に当たり、renderer の書込みが止まるため）。**【追記 2 で改訂】本体は `UPDATE grimodex_write_clock SET seq = seq + 1 WHERE name = '*';` の 1 文だけ。表ごとの行（rev1 §1.1 の `INSERT … ON CONFLICT`）は廃止し、表ごとの鍵は 1b／1c まで見送る（後で TRIGGER の本体を差し替える migration で足せる）。理由は gate G1 の実測：保存 p50 が Rust 水準で +15%（約 +1.0 ms／保存。1 回の保存で clock の TRIGGER が約 15 回発火、約 67 µs／発火）。保存の経路は `prepare_cached` を使わず文のたびに TRIGGER の本体を compile するので、本体の文数がそのまま上乗せになる。例外は `ai_audit_events` の AFTER UPDATE／DELETE だけで、監査の差分検証（PR-2 以降）のため `'*'` の UPDATE の後に `ai_audit_events!mutate` の行を `'*'` の値に揃える 2 文目を残す（この 2 本だけ 2 文）。TRIGGER 名と表名は常に引用符で囲む（追記 2 の I-2）。**
4. 生成関数と不変条件は **grimodex-core** に置く（不変条件 `has_current_schema_checkpoint_invariants` が core の `workspace_schema.rs` にあり、MCP の `schema_allows_writes` が core を使うため）。install（冪等。差分がある時だけ DROP＋CREATE し、余分な `grimodex_clock_%` を消す）と lineage の作り直しは grimodex-db。
5. **`'*'` の行の自己修復**（rev1 の TRIGGER の形では `'*'` が消えると UPDATE が 0 行で直らない）：clock 表に `BEFORE DELETE WHEN OLD.name='*' RAISE(ABORT)` を置く（書込みの hot path には乗らない）。migration の修復で `'*'` が欠けていたら、`MAX(seq)+1`（他の行が無ければ 0）で作り直し、同時に lineage も作り直す（ABA の防止）。**rev1 にない防御の追加**（強める方向）。**【追記 2 で補足】TRIGGER の本体が 1 文の UPDATE になったので、`'*'` が欠けると UPDATE は何もせず、連番が止まる（書込みは失敗しない）。これを守るのは guard の TRIGGER（`'*'` の DELETE を拒否）と、install／`has_v46_write_clock`（`'*'` の行を要求し、欠ければ MCP は readonly、migration は作り直す）の 2 つ。**
6. lineage は uuid v4（32 hex）。作り直す場所：restore の staged（`backup_restore.rs`）、shadow migration の staged（`migration_supervisor.rs`）、新規作成（migrate の install が無ければ作る）、**Web Editor の handoff の取り込み**（`web_editor_handoff.rs`。取り込む DB は信頼しないので持ち越させない。rev1 にない場所。Web Editor は廃止済みだが、コードに残る経路なので閉じる）。snapshot へ戻す rollback は snapshot の値のまま残す。**【追記 2 で補足】取り込みでは lineage の作り直しの後に clock の全ての行の seq を 0 に戻す（信頼しない画像の seq を持ち込ませない。lineage が新しいので ABA は起きない）。restore は利用者自身の backup なので seq を保つ。**
7. renderer の authorizer（`execute.rs` の `renderer_sql_rejection`。registry の判定より前）：clock 表への DML は、accessor が生成した trigger 名の集合に**完全一致**するときだけ通す。lineage 表への DML は常に拒否する。`sqlite_sequence` への renderer の直接の DML も拒否する（製品に使用箇所が無く、clock を進めない書込みの穴を閉じる。rev1 にない防御の追加）。**【追記 2 で改訂】起案は「読みは通す」（rev1 の「常に拒否」を DML の拒否と読んだ）としたが、レビューの指摘で rev1 §1.2 の文面どおりに戻す：clock と lineage の top-level の Read も拒否する（D2a で closed の表の書込みの時刻と回数が renderer に見えないように）。clock の trigger が行う Read（trigger 名が集合に完全一致する accessor。本体が `seq` を読む）は通す。lineage は accessor に関わらず読みも拒否する。PR-1 には読む側が無く、PR-2 で型つきの accessor で開ける。`sqlite_sequence` の読みは判定しない。**
8. D2a の台帳：2 表を `execute.rs` の `D2A_UNLISTED_SCHEMA_TABLES` に足す（unlisted に固定）。
9. **物差しは変えない**：ReadIdentity、TEMP epoch、stamp、data_version、publish の CAS、LP-GATE、IPC、preload、N-API、MCP のコード、閾値は PR-1 では変えない。連番を読む側は作らない。BrowserMock は clock の TRIGGER を作らない（RUST_ONLY の除外を揃える）。「mock が clock を返す」は読む側が無いので PR-2。

### 信頼境界と変えないもの

- C4 で承認された rev1 §6 の範囲内。actor・権限・送信先は増えない。MCP は「常駐する MCP 全般」として読み（承認済み）、v46 の MCP の書込みも TRIGGER で進む。v45 の MCP は user_version が合わず readonly になる。TRIGGER が欠けた DB も readonly。
- 判断 5（`'*'` の保護）、判断 6 の handoff、判断 7 の `sqlite_sequence` は §6 の文面にない防御の追加（いずれも強める方向）。判断 7 の clock・lineage の Read 拒否は rev1 §1.2 の文面どおりに戻したもの（追記 2）。
- **scope-storage-authority との整合**（C2 で「実装の前に確かめる」とされた点）：clock は失効の合図で authority ではない。AFTER TRIGGER は行の列（`updated_at` など）を書き換えない。restore と import で lineage を作り直す。
- 閾値：変えない（G3 の project 削除の線は実測の後に決める。新しい閾値なので、決めるときにユーザーに伺う）。

### owner／lifecycle matrix（新しい thread・subprocess・背景の処理はない）

| 場面 | owner と扱い |
|---|---|
| 既存の物差し | 変わらない。ただし `total_changes` は TRIGGER の行も数える。`read_identity.rs` と `source_revision.rs` は等値で比べるだけなので判定は同じ【推測。試験で固定する】 |
| clock の行 | 同じ tx の中の main schema の TRIGGER が書く（通常は `'*'` の 1 行だけ。audit の UPDATE／DELETE は mutate の鍵も）。rollback で消える。Native が直接書くのは install・修復・Web Editor の取り込みでの seq の 0 戻しだけ |
| lineage | Native（migration、restore、supervisor、handoff）が持つ |
| migration の失敗 | install は c2zb の savepoint の中（stamp の直前）で走るので、失敗すれば stamp と一緒に戻る。shadow 経路は `safe_mode_after_snapshot` へ進み、live は置き換えない |
| MCP の別 process | v46 の MCP の書込みも TRIGGER で進む。常駐する MCP の shared lease は `acquire_exclusive_for_migration` の 10 s で open を失敗させる（どの版上げでも shadow 経路を通るので、v46 で新しく生まれる問題ではない）。利用者向けの文言を足す |
| backup | VACUUM INTO で clock・lineage・TRIGGER も複製される |
| restore | staged の段階で lineage を作り直す |
| project 削除 | CASCADE の行ごとに TRIGGER が走る（追記 2 で 1 文に。gate G3 は 2 文版で +17.5%、1 文版は未測定） |
| 試験の template | Backup API で複製するので、試験 DB どうしで lineage が同じになる。PR-1 では読まないので害はない（PR-2 の判断 C） |
| Tauri の legacy shell | 同じ crate なので同じ migration になる |

### 代替案

update_hook／commit_hook（接続ごとに要り MCP を覆えない）、TEMP 表（C1 で覆した）、protected-writers.json への登録（narrative の writer の validator を巻き込む）、3 文の TRIGGER で `'*'` が欠けたら RAISE（書込みのたびに 1 文増える）、restore の seed から決まる lineage（同じ backup を 2 回戻すと同じ値）は採らない。

### 起案時の rev1 とコードの食い違い（コードの事実を優先）

不変条件の関数は core の `workspace_schema.rs`（rev1 は crate を書かず行がずれる）。finalize が v45 の dead-letter の release を呼んでいる件は rev1 に記述がなく、**PR-1 で外す**（`migrate.rs` の finalize）。台帳の変更先は `execute.rs`（rev1 の `profile_egress_policy.rs` は変更不要）。ensure 系の行番号は core の試験 module の fixture。execute.rs の行番号は補正（例外の前例、DDL の拒否、VM step の予算）。

### 検証の計画（静かな machine で、評価の run と同時に走らせない）

- **G1 保存 IPC の p50（+5% 以内）**：dev 枝 `claude/db-conn-measure` の driver（`scripts/dev/db-trace-{run.mjs,renderer.ts,renderer.html,launch.sh}`）を base と PR-1 の head の両方に載せ、W0（`--trace off --saves 100 --pause-ms 600`）を各 arm 5 run 交互に回す。DB は run ごとに写しを作る（`ir-timing/base/ir/grimodex.db` と `ir-chat-pilot-2026-11/db/g-ja-1.full.db`）。最初の 1 run を除き `save_scene_body_bundle` の ms の p50 を結合して比べる。
- **G2 publish の tx の上乗せ（1% 以内）**：行数×Δµs/行÷tx 全体。行数は publish の前後の `'*'` の差。Δµs/行は DR-DBC-2 §12 と同じ形（g-ja-1 の写しの IR の表に、TRIGGER の有無を release の ignored 試験で比べ、3 process×warm 7 回の中央値）。分母の publish_tx の p50 は #829 の後に測り直す。
- **G3 project 削除**：`domain_writes.rs` の経路で、g-ja-1 の写し 5 個ずつ、base と PR-1 で比べる（ms と倍率。WHERE の無い DELETE が約 14 倍だった件の線は実測の後に案を出し、ユーザーに伺う）。
- **記録だけ**：45→46 の shadow migration の時間、open の増分、試験 DB の作成の増分、BrowserMock の起動、大きい batch の VM step。hold の p90 と WITH の件数は PR-2 の基準値として記録する。

### 未確認

lease の timeout の案内文を出す画面の場所、SQLite が TRIGGER 本体の表を作成時に解決しないこと（mock が落ちる理由の確認）、AUTOINCREMENT の内部の更新が authorizer を通らないこと、rusqlite での実際の費用、G2 の分母を取るための `lock_trace.rs` の載せ直しの衝突、Tauri の legacy shell が今も配布されているか。いずれも build・試験・起動をしていないため（起案は read-only）。

### 実装中の追記 1（2026-11-10。起案の記述の訂正と、実測・実装で分かったこと）

- **backup の設計と `Backup::new`**：起案は「backup は VACUUM INTO の設計で、`Backup::new` は test-support の外に無い」としていたが、製品側に 1 件ある（`grimodex-db/src/bin/support/private_fixture.rs` の fixture bin の補助。required-features 付きで lib・napi には入らない。READ_ONLY の複製元を新しい file へ写すだけで既存 DB には書かない）。grep 試験（`tests/write_clock_forbidden_patterns.rs`）の許可リストに理由と件数つきで入れた。
- **`writable_schema`**：起案は「OFF」としていたが、過去の版の CHECK widening migration 4 本（`migrate.rs`。`verify_post_effect_category_migration` を呼ぶもの）が `pragma_update(None,"writable_schema",true)` で `post_effect_runs`／`post_effect_annotations` の `sqlite_master.sql` の CHECK 文字列だけを書き換え、すぐ false に戻す。trigger には触らず、clock の install は stamp の直前に表の実態から作り直すので、clock を迂回しない。許可リストに件数一致で固定した。
- **trigger の本数**：生成した contract で表 157→159、trigger 63→505（clock の 441 本＋guard 1 本＝442 本の増加。clock 以外の増減なし）。起案の 441 本＋guard の見込みと一致。
- **Web Editor の取り込みは SQLite の画像（base64）を受け取って開く**（起案は JSON だけの可能性を残していた）。lineage を持ち込める経路なので `database.migrate()` の直後に作り直す。取り込みの `rebuild_trusted_schema_objects` は全 trigger を DROP して contract の trigger だけ作り直すので、contract に clock の trigger を入れる再生成が必須（再生成済み）。
- **authorizer の集合**：clock 表への DML は、authorizer の trigger 名の引数が「実表から `expected_clock_triggers` と同じ規則で作った名前の集合」に完全一致するときだけ通す（名前の規則だけだと、取り込んだ DB に紛れた `grimodex_clock_evil_ai` が通るため）。集合は書込みになり得る文のときだけ authorizer を付ける前に作り、作れなければ空（fail-closed）。**1 回あたりの費用は未測定→gate G1 に含める。重ければ接続ごとの cache にする**。限界：`grimodex_clock_<実表>_ai` と同じ名前で本体を差し替えた trigger は authorizer では見分けられず、`has_v46_write_clock` の SQL 完全一致の領分。
- **finalize**：`try_finalize_previous_schema_without_wait` が v45 の release を無条件で呼んでいた（PREVIOUS=45 になって 45→46 のたびに走る状態）。外した。≤44→46 の full migration では `current<45` で一度は走る。45→46 は clock が無い限り full migration（shadow 経路）になる。
- **版の ratify**：`validate-semantic-core-boundary.mjs` の `EXPECTED_SCHEMA_VERSION` を 46 にしたのは「concern matrix は変わらない」の ratify（42〜45 と同じ扱い。clock と lineage は意味解釈を持たず、renderer の authorizer が書込みを拒否する）。
- **利用者向けの文言**：lease の timeout（常駐する MCP が migration を妨げる）の案内は出ていなかったので、`workspaceOpenErrorText` が `WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT` を含むエラーに「MCP を使う client を終了してから開き直す」案内を足す（ja／en の 1 文字列。新しい画面は作らない）。実機で届くかは未確認。
- **Tauri の legacy shell**：`cargo check -p grimodex` は 24 件で落ちるが、foreshadow・plot_threads・grimodex-ai の API 変更による既存の壊れで、この PR の差分に `src-tauri/src` は無い。`README` は「frozen legacy」、`ci.yml` は `--workspace --exclude grimodex`、`release.yml` に shell の build は無い。build も配布もされていない。

### 実装中の追記 2（2026-11-10。gate の実測と独立レビューの指摘への対処）

**gate の実測**（候補 `8165b60f`＝TRIGGER が 2 文の版。生データ・集計 script は `~/.claude/projects/-home-grimodex-Grimodex/handoff/db-stage1-pr1-gates/` の `results.md` と `raw-*.jsonl`。repo には置かない）。測定は dev の worktree で、同一の test binary・同一の v46 の DB の写しを on（TRIGGER あり）と off（442 本を DROP）で ABBA に交互に回した。判定は書かない。

- **G1 保存**（Rust 水準。`save_scene_body_bundle` を直接。IPC・authorizer は通らない）：p50 は DB A（18 scene）+14.8%、DB C（g-ja-1 の写し、117 scene）+15.1%。約 +1.0〜1.1 ms／保存で、1 回の保存で clock が 15 回進む（約 67〜70 µs／発火）。IPC 水準の粗い換算は約 +10%（未測定）。gate は +5% 以内。p95 は WAL の checkpoint のスパイクで比較に使えない。
- **G2 publish**（g-ja-1 の写し、884 revision、clock が 3367 回進む）：publish 全体の p50 は on 3487 ms／off 3507 ms で**検出できない**（−0.6%。run 間のばらつき 3406〜3996 ms）。micro の Δµs/行は INSERT +1.5、UPDATE −1.6（noise）、DELETE（WHERE 付き）+3.3、DELETE（WHERE なし）+5.6。ただし毎回 prepare する単文は on で 1 文あたり +225〜454 µs。
- **G3 project 削除**（clock が 63,640 回進む）：p50 が on 2978 ms／off 2534 ms で +17.5%（約 +444 ms、約 7 µs／発火。平均では +11.4%）。「WHERE の無い DELETE が約 14 倍」は project 削除の経路では現れず倍率は 1.1〜1.2 倍。**この線の扱いは別途案を出してユーザーに伺う**（新しい閾値は決めない）。
- **authorizer の集合の構築**：1 回 442 µs（`pragma_table_list` の走査 258 µs、名前と SQL の生成 156 µs）。renderer の書込み 1 回（約 0.65 ms）の約 68%。on−off の差（発火＋名前の照合）は単文 +37 µs。
- 記録だけ：45→46 の migration は 202〜511 ms、DB file の増分は約 0.2 MB、open の増分は +2.8 ms。

**cache の費用（release の micro `clock_accessor_cache_cost`、`#[ignore]`）**：hit は約 0.35 µs（`PRAGMA main.schema_version` の読みだけ）、再構築（名前だけ）は約 337 µs（旧 442 µs のうち SQL の生成 156 µs が消え、`pragma_table_list` の走査が残る）。renderer の書込み 1 回の約 68% を占めていた集合の構築は、schema が変わらない限り µs 未満になる。

**設計の変更（上の測定が理由）**：判断 3 の TRIGGER の本体を 1 文にした（表ごとの行を廃止）。**1 文化の効果は測り直していない**（次の gate の項目）。上乗せの主因は「文のたびに TRIGGER の本体を compile する」側と見ており、1 文化で減るのはその一部だけと見込まれる。

**レビューの指摘と対処**

| ID | 指摘 | 対処 |
|---|---|---|
| I-1 | authorizer の集合を書込みのたびに作る（442 µs）。`EXPLAIN QUERY PLAN UPDATE` が空集合のため clock の拒否で失敗する | (a) core に `expected_clock_trigger_names`（SQL を作らず名前だけ。名前の規則を `expected_clock_triggers` と共有し、同じ名前・順序を試験で固定）。(b) `Database` の field に接続ごとの cache（鍵は `PRAGMA main.schema_version`。`Database` は接続を 1 本だけ持ち一生入れ替えない。TEMP の guard trigger は temp schema だけを変えるので hit し続ける）。(c) 文の種類に依らず常に集合を渡す（`EXPLAIN` の DML も通る）。(d) 作れなければ空集合（fail-closed。cache しない） |
| I-2 | 表名が `[a-z0-9_]+` から外れると `clock_target_tables` が bail し、open が失敗する | bail を廃止。TRIGGER 名と表名を常に `"` で囲む（内部の `"` は `""`）。新しい本体は表名を文字列リテラルに入れないので `'` のエスケープは不要。名前は生のまま集合に入れる（authorizer も `sqlite_master.name` も生の名前）。`Notes`・`weird name`・`a"b`・`o'clock`・日本語名の表で、install・書込み・不変条件・authorizer の通過を試験で固定 |
| m-a | 読みの拒否が DML だけに読み替えられていた | 判断 7 のとおり、clock・lineage の top-level の Read も拒否（clock の trigger の Read は通す） |
| m-b | Web Editor の取り込みが信頼しない画像の seq を持ち込める（`i64::MAX` で `INSERT OR IGNORE` の clock を止める筋） | 判断 6 のとおり、lineage の作り直しの後に全ての seq を 0 に戻す。restore は seq を保つ（試験で固定） |
| m-c | 外側の `OR IGNORE` が TRIGGER の本体にも及び、`'*'` が `i64::MAX` だと clock だけが止まる | **直さない。既知の限界**として core の `write_clock.rs` の doc に書き、現象を試験で固定。seq は 0 から始まり到達不能で、取り込みは m-b で 0 に戻す |
| m-d | 禁止パターンの grep 試験 | `recursive_triggers` の規則を削除（OFF は既定値で、入れ子の TRIGGER は発火する。理由が誤り）。`ignore_check_constraints` の ON と、`Connection::backup`／`restore`（`nir1-material-diagnostics` が `rusqlite/backup` を有効にする）を禁止に追加（既存の使用は 0 件）。`any(test, feature = X)` を test 専用とみなすのは X が `TEST_ONLY_FEATURES`（`test-support`・`workspace-maintenance-test-support`・`ai-audit-commit-test-probe`）のときだけにし、`nir1-material-diagnostics`・`nir1-graph-eval` などは製品として走査（新たな hit は 0 件）。`all(test, ..)` は `test` が必須なので test 専用 |
| m-e | 試験の穴 | (i) authorizer と `ON DELETE CASCADE`（renderer の DELETE で行ごとに進む）、(ii) D2a の UPDATE／DELETE の経路、(iii) TRIGGER の有無で `ReadIdentity` の判定が変わらないこと、を試験で固定 |
| m-f | lease の案内文が restore や新規作成の場面に合わない | 場面に依らない文言に変更（「…処理を始められませんでした」／"…the operation could not start"） |

**P-1：clock が進む範囲（rev1 §1.1 の記述の訂正）**：`'*'` は「どの行が変わっても」ではなく、「対象表（`clock_target_tables`＝main の実表。virtual・shadow・`sqlite_%`・clock の 2 表を除く）の行が変わると」進む。**FTS だけを書く処理（`fts.rs` の optimize／rebuild／`_en` の作り直し、restore の `rebuild_fts_if_stale`）と preflight の `PRAGMA optimize` では `'*'` が進まない**（virtual 表と shadow 表には TRIGGER が無く、`PRAGMA optimize` は `sqlite_stat1` のような `sqlite_%` の表を書くだけ）。したがって PR-2 で検索結果の cache を `'*'` で失効させる設計には、FTS の再構築を別の合図（別の鍵や、FTS の epoch）で扱う判断が要る。

**既知の限界（追記 2 の時点）**

- `'*'` が `i64::MAX` のとき `INSERT OR IGNORE` の中で clock だけが止まる（m-c）。
- `has_v46_write_clock` の SQL 比較は `compact_sql` が引用符の中の空白と大文字小文字も潰すので、`weird name` と `weirdname` の TRIGGER は区別できない。
- `grimodex_clock_<実表>_ai` と同じ名前で本体を差し替えた TRIGGER は authorizer では見分けられず、`has_v46_write_clock` の SQL 完全一致の領分（追記 1 のとおり）。
- 製品の Cargo に `rusqlite/backup` の feature が入る crate（`grimodex-semantic`・`grimodex-post-effect`・`nir1-material-diagnostics`）の manifest は、grep 試験の source の規則とは別で、今回は規則にしていない。
- 保存の経路（`scene_body.rs` など）の `prepare_cached` 化は PR-1 では行わない。文ごとの TRIGGER の compile は残るので、1 文化の後の G1 の測り直しの結果で次の判断をする。

### 実装中の追記 3（2026-11-10。U7 の後の再測定と、gate の現状）

候補：U7 の HEAD `c8c6ebe4`（TRIGGER の本体が 1 文、集合を cache）。生データ・集計は `~/.claude/projects/-home-grimodex-Grimodex/handoff/db-stage1-pr1-gates/` の `results-u7.md`（Rust 水準）と `results-u7-ipc.md`（IPC 水準）、`raw-u7-*.jsonl`、`raw-u7-ipc-runs/`。repo には置かない。DB は版 43（ir-timing）と 44（ir-admission-perf の g-ja-1）で、45 ではない。

| 項目 | U7 の前（追記 2） | **U7 の後** |
|---|---|---|
| G1 保存の p50（Rust 水準。製品の関数を直接。on／off、100 回×3 process） | +14.8%／+15.1%（約 +1.0 ms） | **+6.1%（ir）／+5.3%（g-ja-1）**（約 +0.4 ms） |
| **G1 保存の IPC の p50（W0、base `bc0b06c1` 対 head `d7af3a71`、各 DB 5 run 交互、先頭を捨てる）** | 未測定 | **+9.1%（ir：9.9→10.8 ms）／+7.8%（g-ja-1：10.2→11.0 ms）**（約 +0.8〜0.9 ms）。run ごとの p50 は ir で重なり、g-ja-1 では重ならない |
| G2 publish（実 publish 6 回、884 revision、3,367 発火） | −0.6%（検出できない） | −1.0%（検出できない）。行数×Δµs/行で 0.05〜0.8% |
| G3 project 削除（63,640 発火） | +17.5% | p50 −1.0%（平均 +2.6%。off が前回より約 0.9 s 遅く、絶対値は前回と比べられない） |
| authorizer の集合（renderer の書込み 1 文に占める割合） | 約 68%（442 µs） | cache hit 2.3 µs で約 1.6%、miss（DDL 直後）356 µs |
| 記録だけ | 移行 202〜511 ms、open +2.8 ms、DB +0.21 MB、trigger の SQL 152 KB | 移行 181〜447 ms、open +1.3 ms、DB +0.13 MB、trigger の SQL 76 KB |

**gate の現状**：**G1 は IPC 水準で +5% を超える**（+7.8〜9.1%、絶対で約 +0.8〜0.9 ms／保存、10 ms 台前半の保存が 1 ms 弱延びる）。G2 は 1% 以内。G3 の線は未決。C8 の取り決め（gate を 2 段に分け、**未達は止まって再相談。線の緩和は必ずユーザーに確認**）に従い、**この PR は Draft のまま、G1 の扱いをユーザーに伺う**。

**前の所見の訂正**：U7 の前の測定で「主因は文のたびに TRIGGER の本体を compile する費用」としたが、根拠が足りなかった。同じ文を 100 回流す micro では on−off が +6〜12 µs／文、1000 回では約 +220〜280 µs／文になり、prepare と `prepare_cached` で同じ値になる。compile の費用ではなく、**commit ごとに clock のページが 1 つ余計に書かれ、WAL の autocheckpoint が早まる**側の可能性があるが、特定していない。`prepare_cached` 化で減るのは 1 文あたり約 3〜6 µs（15 文で 0.6〜2%）と見積もれ、それだけでは足りない。IPC の上乗せが Rust 水準（+0.4 ms）より大きい理由（+0.8〜0.9 ms）も未調査。保存 1 回の書込み文 24 のうち clock が発火する文は 15（`narrative_field_authority` の INSERT が 7、`tree_nodes` の UPDATE、`change_events`、`narrative_change_transactions`／`events`／`object_heads`、`narrative_semantic_index_metadata`、`state_snapshots`、`idempotency_requests`）。

**上乗せを下げる選択肢（いずれも設計の判断）**：(1) 保存の経路の `prepare_cached` 化（効果は 1〜2%。製品の保存コードに触れる）。(2) 保存と必ず一緒に書かれる派生・帳簿の表（例：`narrative_field_authority`、`idempotency_requests`）を trigger の対象から外す（発火が減る。**1c の「除外の表」で、脅威モデルの改訂と C6 (b) が前提**）。(3) gate の線を実測に合わせて決め直す（ユーザーの確認が要る）。(4) PR-1 を止めて別の機構を検討する。

### 実装中の追記 4（2026-11-10。ユーザーの決定、CI の失敗 3 件の原因と対処、no-op の書込みの意味）

**ユーザーの決定（2026-11-10、AskUserQuestion の回答）**：(a) **G1 の線を「保存 IPC の p50 が +12% 以内、かつ +1.5 ms 以内」に決め直した**（追記 3 の実測は +7.8〜9.1%、約 +0.8〜0.9 ms。当初の +5% は IPC 水準では満たせない）。**G3 の線を「project 削除の p50 が +10% 以内」**とした（実測 −1.0%〜+2.6%）。(b) **表ごとの鍵を 1b／1c まで見送る設計の変更（判断 3）を了承した**。ただし**監査の鍵（INSERT 用の `ai_audit_events` と UPDATE／DELETE 用の `ai_audit_events!mutate`）は残す**（rev1 C3-b：PR-2 で `AUDIT_ONLY_STATES`＝「追記だけだった」の判定を連番の上に移植するため）。

**監査の鍵の復元**：追記 1〜3 の時点では、`ai_audit_events` の AFTER INSERT は `'*'` の 1 文だけで、鍵は UPDATE／DELETE 用の `!mutate` だけだった。これでは追記と変更を連番から区別できない。AFTER INSERT も 2 文にし、`'*'` の UPDATE の後に `ai_audit_events` の行を `'*'` の値に揃える（`ON CONFLICT(name) DO UPDATE`）。AFTER UPDATE／DELETE は従来どおり `ai_audit_events!mutate`。保存の経路は `ai_audit_events` を書かないので、G1 の測定には影響しない。core の定数 `CLOCK_KEY_AUDIT_APPEND` を足し、contract を再生成した。

**PR #847 の CI の失敗 3 件（grimodex-db の lib 試験。他は通っていた）の原因と対処**：
1. `audit_only_tests` の 2 件（`nir1_premise_every_audit_append_shape_writes_only_audit_rows`、`nir1_premise_generic_audit_append_writes_only_audit_rows`）：監査の追記が INSERT trigger で `grimodex_write_clock` を書くので、「追記は `ai_audit_events` だけを書く」という authorizer の集合の比較が落ちた。**比較から `grimodex_write_clock` と `grimodex_db_lineage` を除いた**（clock は commit 自身の帳簿で、追記が書くドメインの表ではない）。ほかの assert は変えない。「追記で動くのは `'*'` と `ai_audit_events` の鍵だけ」は `clock_audit_append_advances_only_the_global_and_append_keys` で確かめる。PR-2 でこの前提（追記だけの commit の判定）を連番の上に移す。
2. `open::tests::cold_open_defers_oversized_residual_wal_without_synchronous_checkpoint`：当初は「open の経路の値が変わらない UPDATE／UPSERT が、trigger で clock の行を変えて WAL にフレームを足す」と仮説したが、**否定された**。実測は before が `log_frames=1361, checkpointed=0`、after が `log_frames=0`（**増えず、reset された**）。原因は試験の fixture：`oversized_open_wal_fixture` を migration の外で作り、clock の trigger を付けていなかったので、次の open の検査（`has_current_schema_checkpoint_invariants` が `has_v46_write_clock` を含む）が「新しい表に trigger が無い」で不一致と判断し、repair の経路（open の trace に `migrate` の span が 2 つ。`migrations/` の snapshot は作られず、seal の TRUNCATE ではない）に入って、open の中で WAL が reset された（`log_frames` が 0 になる）。reset の機構（新しい接続の `wal_autocheckpoint=1000` による commit 時の checkpoint か）までは特定していない。**収束した image の cold open は WAL に 1 フレームも足さない**（fixture に `install_write_clock_in_tx` を足すと before と after が完全に一致〔`log_frames=1366`〕し、assert は元のまま通る）。製品の挙動は正しく（trigger の欠けは repair する設計）、試験の assert は変えず、fixture が image を収束させるようにした。**open の経路に不要な書込みは見つからなかった**。

**no-op の書込みの意味（PR-2 の前提）**：SQLite は同一内容の書込みをページに書かない。基点では、値が変わらない UPDATE／UPSERT は WAL に何も足さず、`data_version` も動かさない。一方、clock の trigger は行が一致する限り発火するので、**値が変わらない UPDATE でも `'*'` が進み、commit が実際に書かれる**。PR-2 で clock を鮮度の物差しにすると、基点の `data_version`／`total_changes` より「変わった」と判定する場面が増えうる（周期的な no-op の書込みがあれば失効が増える）。**この PR の範囲では、open の経路にそのような書込みは見つからなかった**（上の 2 の実測。収束した open は WAL を変えない）。ほかの経路（背景の処理、heartbeat、周期の更新など）の洗い出しは行っていない。PR-2 の設計で、周期的な no-op の書込みの洗い出しと対処（書込み側で no-op を避ける、など）を扱う。

## DR-DBC-5 段 1 の PR-2：鮮度の物差しを接続ごとの値から DbClock に切り替える（2026-11-12）

**番号について**：`origin/master`（a067f7f7）の最大は DR-DBC-3。rusqlite の lane が同じ文書に別の DR（DR-DBC-4 の想定）を足すので、衝突を避けて「既存の最大＋2」の 5 を使う。
経緯：段 1 の設計 rev1／rev2 草稿（`design-notes/db-connection-2026-11-07/stage1-design-rev1.md`、`stage1-design-rev2-draft.md`）。PR-1（DR-DBC-3、#847）で clock と lineage を置いた。PR-2 は「連番を読む側を作り、物差しを一括で替える」段。基点は `origin/master` の `a067f7f7`、枝は `claude/db-stage1-pr2`。
ユーザーの承認（2026-11-08〜11-10。逐語は `user-decisions-2026-11-09.md` と DR-DBC-3 の経緯）：C3-b（監査の例外は V-6 の範囲のまま連番の上へ移植）、C4（脅威モデル。MCP は「常駐する MCP 全般」）、C5（`connection_generation` は作らず authority の同一性だけ、#3 は (i)＝authority の経路で `query_only==0`・`!is_readonly(MAIN)` を assert、liveness／cutover は N-API の revalidate に任せ db crate は lineage だけ、#7 renderer の guard は workspace の開き直しをまたいで有効で可）、C6 (a)（旧い定義で測り続ける）、C8（hold の p90 と WITH の件数は PR-2 の gate。未達は止まって再相談）、2026-11-10「PR-1 から着手」。この lane は NIR-1 の事前委任の外で、**範囲を広げる判断は残る**。(a′)（drift では Suspended にしない）は PR-2 に含めない（rev2 草稿 ①）。

### 判断

1. **DbClock＝（lineage、main の `schema_version`、`user_version`、`'*'` の seq）**。`read_db_clock(conn)`（lineage と seq だけ。post-effect の guard 用）。repair の CAS は `read_db_clock_with_versions`（lineage・seq・main の `schema_version`・`user_version`。旧い比較と同じ強さ）を `grimodex-db` の lib に置く。読みは 1 文：`SELECT (SELECT id FROM main.grimodex_db_lineage WHERE singleton=1), (SELECT seq FROM main.grimodex_write_clock WHERE name='*'), (SELECT schema_version FROM pragma_schema_version), (SELECT user_version FROM pragma_user_version)`（`pragma_*` の表値関数が 1 文に入ることは確認済み）。行が無い・型が違う場合は error（fail-closed。黙って 0 にしない）。
2. **`ReadIdentity` の中身だけを DbClock に替える**（型名・規則は残す）。保存してよいのは Read の tx か autocommit で読んだ値だけ（旧 `read_identity.rs` の規則を引き継ぐ。write tx の中の値は同じ tx の中の比較と V-6 の移植だけ）。`read_unpinned` の前後 2 回読みは、旧い値が「別々の pragma 文」で、1 つの状態の読みである保証が無かったためのもの。新しい読みは 1 文で 1 つの snapshot なので、**前後 2 回読みを 1 回にする**（atomic。`Option` を返す形は残すが、`read_unpinned` は読めなければ **`Err`**（黙って `None` にしない）で、今は常に `Some` を返す。`None` を返すのは write tx の中で読む `ReadIdentity::read` だけ）。`temp_schema` と `total_changes`／`data_version`／TEMP の epoch は読まない。
3. **P-1（clock が進む範囲）の扱い＝受け入れる**。`'*'` は `clock_target_tables` の実表の行が変わると進み、FTS だけの書込み（`fts.rs` の optimize／rebuild、`rebuild_fts_if_stale`）と `PRAGMA optimize` では進まない（DR-DBC-3 追記 2）。DbClock を読む側（IR の proof と query context、Graph の登録／query、C-query の stamp、impact-review の snapshot と guard、repair の CAS、V-6）が読む表は、`narrative_*`・`codex_*`・`tree_nodes`・`projects`・`post_effect_*`・`impact_review_baselines` などの実表で、**FTS の仮想表・shadow 表・`sqlite_stat*` を読まない**（grep で確認。FTS の仮想表は検索の機能だけが読む）。FTS は実表の trigger で更新されるので、内容の変化は実表の書込み（clock が進む）に伴う。したがって FTS だけの書込みで「これらの読みが古くなる」ことは無く、失効の定義（「covered な表の commit」）は今と同じ。**ただしこの論拠は FTS が実表と一致していることが前提**：FTS が実表より古い状態で手動の `fts_rebuild`／`rebuild_en_fts` が走ると、seq は動かずに impact-review の候補（`narrowing.ts` の `fts_search`）が変わる。その候補は guard の対象の Codex snapshot の外で、結果は再構築で直る方向（古い索引→実表と一致）なので受け入れる限界として記録する。試験：別接続の `data_version` が動いても seq が動かないこと、no-op の UPDATE で seq が進むこと、`PRAGMA optimize` で進まないこと（観測）。
4. **no-op の書込みの向き**（2026-11-12 の独立レビューで訂正）：基点 `a067f7f7` には PR-1 の clock の trigger が既にある（`migrate.rs` の `install_write_clock_in_tx`）ので、**値の変わらない UPDATE は基点でも clock の行を書き、別接続の `data_version` を動かしていた**。旧い比較（`data_version`）が no-op で動かないという前提は成り立たない。base と head で比べると、**偽の「変わった」は head の方が厳密に少ない**（FTS だけの書込み、`sqlite_stat*`、temp schema、rollback で失効しなくなった。逆に増える書込みは無い）。authority 接続でも、旧 `total_changes` は no-op の UPDATE で動いていたので、新しい clock が動くことは増加ではない。閉じた経路（収束した open は WAL を変えない〔DR-DBC-3 追記 4〕、idle の Freshness cycle は seq を進めない。陽性の対照＝仕事のある cycle は seq を進める、を `incremental_freshness::tests::a_freshness_cycle_with_work_advances_the_write_clock` で固定）を試験で固定し、残りは gate の測定で見る。結果は「実装中の追記」と報告の open_issues に書く。
5. **epoch だけを使う箇所**（`connection_epoch`）：
   - IR の runtime（`NirChronicleIndexRuntime`）：`connection_epoch: Option<String>` を `lineage: Option<String>` に替え、`current_epoch(conn)` は (i) の assert（`query_only==0`、`!is_readonly(MAIN)`。満たさなければ **error**＝黙って通さない）と lineage の一致を見る。一致しなければ `NirIndexUnavailableReason::DatabaseLineageChanged`（旧 `ConnectionChanged` は改名。`Scene` の incarnation と紛れない名前）。reader の接続（`query_only=1`）で呼ぶと error。別の primary（診断 fixture、restore 後の新 authority）は assert では弾けず、lineage の一致と owner の束縛に任せる（C5 #3 の残り）。`current_epoch` の呼び出し連鎖は下の表。
   - Freshness の liveness（`SuccessfulIncrementalFreshnessCycle`）と cutover の receipt：`connection_epoch: String` を lineage に替える。db crate は lineage だけを持ち、同じ file の再 open の拒否は N-API の revalidate（`node/lib.rs`）が担う（承認済み）。#10 の隙間（`c_query_freshness.rs` の health 検査と `try_lock` の間）は、lock の後に `ensure_connection_reusable` をもう一度呼ぶ 1 行で閉じる。
   - Graph の index 保守の `RecordKey`／`RecordScope`：owner が authority の identity なので、`connection_epoch` を外す（owner だけ）。
   - repair の backup の前後の CAS：`read_db_clock_with_versions`（lineage、`'*'` の seq、main の `schema_version`・`user_version`）。clock の trigger が付かない DDL は seq を進めないので、seq だけでは旧い比較より弱くなる。比較は `ensure_source_unchanged_since_backup` に切り出し、試験 `repair::tests::the_repair_cas_sees_a_ddl_only_change_that_leaves_the_sequence` で DDL だけの変更が拒否されることを固定する（backup の前後に割り込む継ぎ目は無いので、比較の関数を試験する。経路全体の試験ではない）。
6. **V-6（`AUDIT_ONLY_STATES`）の鍵**：旧は `connection_epoch` で list を分けていた。新は **（main DB の file path、lineage）**。記録側（`append_ai_audit_events_with_durability`）は `&Connection` しか持たないので authority の identity は渡せない。`conn.path()` は同じ file なら同じで、フォルダを複製した別 workspace は path が違う（lineage が同じでも別の list になる）。**同じ path の file を外から古い写しに戻した場合**（アプリを閉じずに workspace を離れ、`grimodex.db` を同じ DB の古い backup で手で置き換え、同じ process で開き直す。`fts.rs` の comment は手動のバックアップ昇格を想定経路に挙げる）は path も lineage も同じで、新しい履歴の書込みが古い list と同じ seq の並びに達すると偽の「変わっていない」になりうる（旧は接続ごとの epoch で、`Database` を開き直すと別の list だった）。したがって **`WorkspaceAuthority::new` がその file の list を全部捨てる**（`forget_audit_only_states`。list は process memory だけなので、落ちても full check が増えるだけ）。試験：`nir1_audit_only_lists_are_not_inherited_by_a_reopened_workspace_authority`（陽性の対照つき）、`nir1_audit_only_states_forget_one_file_only`。`:memory:` の試験 DB は path が空なので、**test の fixture の複製の後に lineage を作り直す**（判断 9）ことで別の鍵にする。仕組みと V-6 の範囲（IR の proof の fast path と汎用の追記だけ）は変えない。
7. **renderer の guard（impact-review）**：kind を `sqlite_write_clock_v1` に替え、項目は `expected_lineage`（32 桁の小文字 hex）と `expected_seq`（canonical な u64 decimal 文字列）。**2 つの kind を受ける期間は作らない**（Rust の `ensure_guarded_post_effect_run`、`ipcContract.ts` の検証、`post-effect/types.ts`、`snapshot.ts`、`baseline.ts`、`browser-mock.ts`、node の test を同時に替える）。renderer が 1 文の中で比較できるよう、**接続ごとの TEMP view `grimodex_clock_read(lineage, seq)`** を、clock の 2 表がある接続で最初の renderer の文の前に 1 回だけ作る（`Database::new` では作らない：存在しない表を参照する TEMP view が残ると `ALTER TABLE` が `error in view …: no such table` で壊れることを試験で確認した。`ClockAccessorCache::ensure_read_view`。`(SELECT id FROM main.grimodex_db_lineage WHERE singleton=1)` と `(SELECT seq FROM main.grimodex_write_clock WHERE name='*')` の 2 列。TEMP なので schema contract・backup・migration に触れない。SCHEMA_VERSION は上げない。新しい IPC command は足さない）。renderer の authorizer（`clock_surface_rejection`）は、clock／lineage の **Read** を、accessor（最内の view 名）が `grimodex_clock_read` のときだけ通す（DML は従来どおり trigger 名の完全一致のみ。lineage の DML は常に拒否）。view の Read 自体は TEMP の名前なので `renderer_sql_rejection` と D2a が通すかを試験で確かめる。renderer の DDL は拒否される（`CREATE TEMP VIEW` で偽装できないことを試験で固定）。**既知の限界**：SQLite は CTE や別名の subquery の名前も accessor として渡すので、`WITH grimodex_clock_read AS (SELECT * FROM grimodex_write_clock) …` は clock の読みを通す（PR-1 の trigger 名の集合と同じ穴。読みだけで、書込みは通らない）。読めるのは `'*'` と監査の鍵の seq と lineage で、lineage と `'*'` の seq はこの guard が正に renderer に渡す値、旧 guard も `total_changes()`／`data_version`／epoch を渡していたので、限界で新しく読めるのは lineage（guard が正に渡す値）と、監査の鍵の seq だけ。試験でこの限界を固定する。accessor の判定は **名前だけ**なので、同じ名前の CTE・別名の subquery に加え、main 側に同名の view があればそこからも読める（renderer の DDL は拒否されるので main に view は作れない。`execute.rs` の `clock_surface_rejection` に comment）。**lineage の形**：guard の `expected_lineage` は小文字 32 hex だけ（`ipcContract.ts`、post-effect）。`install_write_clock_in_tx` と core の `has_v46_write_clock` も小文字だけを受けるようにそろえた（以前は大文字も可）。大文字の lineage は不正として install が小文字の新しい id に作り直す（実在しうるのは手編集か外部の画像だけで、作り直しは proof・登録を失効させる fail-closed。試験 `an_uppercase_lineage_is_invalid_and_is_rotated_to_lowercase`）。
8. **試験の fixture（判断 C）**：`test-support/current_schema.rs` は Backup で複製するので lineage が同じになる。複製の後に `rotate_db_lineage` を呼び、TEMP epoch の assert を lineage の assert に替える。
9. **削除**：`SqliteSourceRevision`、`read_sqlite_source_revision`、TEMP 表 `grimodex_connection_meta`（`lib.rs`、`narrative_maintenance_connection.rs`、`nir1_capacity_diagnostics.rs`、`nir1_graph.rs` の test／診断 reader、worker の bin、graph の試験の補助）、`ConnectionChanged`、`sqlite_revision_v1`。renderer の `renderer_pragma_allowed` の `data_version` は guard が使わなくなるので、許可の削除は行わない（削る理由が無く、他の読みに使われうる）。
10. **触れないもの**：pin 済みの harness（`stamp1`・`eval_notes.stamp` の行と形。`CQueryFreshnessStamp` は不透明な型で、等値の比較だけ）、`nir1_pinned_snapshot.rs` の `FCNTL_DATA_VERSION`、`source_revision.rs` の `total_changes` の guard（同じ接続の tx の中）、閾値、契約、schema、PR-3（stamp の削除）、(a′)。

### 変わる点・変わらない点（失敗の方向）

- 失効の定義は「covered な表の commit」。変わる 3 点（rev1 §0）：(1) rollback した書込みでは失効しない（旧 `total_changes` は rollback で戻らず、誤って失効していた。**安全側の誤りが減る**）。(2) temp schema の変化では失効しない（H-e）。(3) 別接続どうしで値を比べられる。
- 向きの分析：clock が進まない書込み（FTS だけ、`sqlite_stat*`、virtual／shadow）は、旧 `data_version` では「変わった」になっていた。これらを読む covered な読みは無い（判断 3）ので、**失効しない向きの変化は、読み手の結果に影響しない**。clock が進む no-op は、基点でも trigger が clock の行を書いていたので、base と head で別接続の観測者に対する向きは変わらない（判断 4。偽の「変わった」は head の方が少ない）。**失敗の方向は fail-closed（余計に失効して full check／retry になる）で、古いものを新しいと誤る方向には動かない**。
- 変わらない：書込みの接続は 1 本、LP-GATE、DR-JF-9、publish の CAS、閾値の値（`MAX_GRAPH_QUERY_RECORDS`・2 MiB・600M steps・180 s・START_TIMEOUT 30 s・QUERY_DEADLINE 100 ms・Q 16 MiB・S 64 MiB・85% ほか）。

### 信頼境界（C4 の範囲内。新しい actor・権限・送信先・保存範囲・契約・authority は無い）

- renderer：信頼しない。clock への直接の書込みと lineage への DML・Read は拒否のまま。clock の Read は view 経由だけ（上の限界を除く）。guard の値は renderer が持つが、**ただの比較値で authority ではない**（改ざんすれば guard が外れて保存が拒否されるだけで、書込みを広げる権限は無い）。
- Native：信頼する。MCP（別 process）：v46 の書込みは trigger で seq が進む。旧い MCP は readonly。
- **既知の限界（2026-11-12 の独立レビュー、起こる条件は狭い）**：impact-review の guard（`grimodex-post-effect/src/lib.rs` の `ensure_guarded_post_effect_run`）は lineage と seq だけを比べ、DB の path を持たない。フォルダを複製した別 workspace へ切り替えると lineage は同じで、seq が同じ値に達していれば guard が通りうる。複製後は書込みで seq が分かれるのが普通で、guard は保存の拒否を足すだけの比較値（上）であり、書込みを広げる権限ではない。path を guard に足すと renderer の契約が変わる（新しい契約は委任の外）ので、今回は足さず、限界として残す。
- 連番は失効の合図で、scope・registry・宣言の authority ではない（rev1 §6）。

### owner／lifecycle matrix（GDX-PRECHECK-001。新しい thread・subprocess・背景の処理・送信先は無い）

| 場面 | owner と扱い |
|---|---|
| clock／lineage の行 | PR-1 のとおり（trigger と Native が書く）。PR-2 は読むだけ |
| TEMP view `grimodex_clock_read` | 最初の renderer の文の前に、clock の 2 表がある接続にだけ作る（`ensure_read_view`。接続と一緒に消える。migration 前の DB には作らない）。維持修復の `mem::replace` で差し替わる接続（TEMP 表の無い空の in-memory 接続）には作らない：終端の操作で、その接続は renderer SQL を受けない |
| IR の runtime の lineage | `WorkspaceAuthority::new` が作るとき 1 回読む。restore／shadow migration／handoff は lineage を作り直すので、旧 runtime の proof は `DatabaseLineageChanged` で拒否 |
| `current_epoch` の呼び出し連鎖 | `admit_native_build`（build の admission、`chronicle_reader_admission` の authority 側）、`proof_current_observed`（query の検証）、`publish` の再確認、index 保守の hint の admission。どれも authority の接続で呼ばれる。reader の接続からは呼ばない（呼べば assert で error） |
| C-query の worker（別 process） | worker の read-only 接続は TEMP 表を作らず、DbClock を SQL で読む。登録の identity は authority と同じ値になる。worker の停止・再起動・cutover の手順は変えない |
| liveness／cutover | lineage だけ。N-API の revalidate が再 open を拒否する（承認済み） |
| restore／shadow migration／handoff | lineage を作り直す（PR-1）。旧い proof・登録・receipt は lineage の不一致で拒否される |
| V-6 の list | process memory のみ（durable でない）。鍵は（path、lineage）。`WorkspaceAuthority::new` がその file の list を全部捨てる（古い写しに戻された同じ path・同じ lineage の file を引き継がない。接続を取れず捨てられなかったときは warn を出して open を続ける＝list が残りうる。その失敗は未確認の稀な経路）。落ちても full check が増えるだけ |
| 維持修復の `retire_connection_for_recovery` | 変更なし（差し替え先は TEMP を持たない） |

### 検証と gate

- 決定的な gate（この段で測る）：`WITH … SELECT` で identity が変わる件数 0（旧 W1 では 2,560 件。試験 `execute::tests::renderer_statements_do_not_move_the_read_identity` で断言する。同じ試験で、temp schema の cookie が動くこと〔旧い物差しの再現〕も assert する）。監査の追記の後の full check 0（`audit_only_tests`）。
- 時間の gate（この段では測らない。手順は報告の timing_plan）：qualify の hold の p90（旧 360 ms、目安 20 ms 未満。#843 より前の値で、基点 a067f7f7 の側で測り直す）、保存 IPC の p50。C8 のとおり未達は止まって再相談で、数値の線はここでは変えない。
- 未確認：worker の窓の間の周期的な no-op の書込みの全数、`pragma_*` を含む 1 文の読みの実際の費用（rusqlite の bundled）、renderer の guard の実機での動作。

### 実装中の追記 1（2026-11-12。実装で分かったこと、試験、決定的な gate の実測）

- **TEMP view は migration の前に作れない**：`Database::new` で `CREATE TEMP VIEW grimodex_clock_read` を作ると、新しい DB の migration の `ALTER TABLE` が全 view を解決しようとして `error in view grimodex_clock_read: no such table: main.grimodex_db_lineage` で失敗する（lib の試験 2,682 件中 1,893 件が落ちて分かった）。clock の 2 表がある接続で最初の renderer の文の前に作る方式（`ClockAccessorCache::ensure_read_view`、判断 7 を訂正済み）に改めた。2 表が無い間は作らず、作れなければ view は無いまま（renderer の guard の読みが失敗するだけ。fail-closed）。
- **D2a（restricted の profile-egress）では view も読めない**：`temp` database の読みは restricted で拒否される（`D2A_EGRESS_DENIED`。新しい試験で確認）。旧い `temp.grimodex_connection_meta` の読みも同じく拒否されていたと **`renderer_profile_egress_sql_rejection` のコードを読んで判断した（base では走らせていない）**。だから**新しい egress の経路は増えず、impact-review の guard が restricted で使えない点も今と同じ（未確認のまま報告の open_issues に載せる）**。D2a の台帳は変えない（変えるなら新しい authority で、委任の外）。試験で固定。
- **前提 P-1 の試験**（`write_clock::tests::p1_the_clock_ignores_fts_only_writes_and_optimize_but_not_noop_updates`）：FTS の `rebuild`／`optimize` と `fts_optimize()` では seq が動かず、**別接続の `data_version` は動く**（FTS の書込みが実際のページ変更であることを確認）。`PRAGMA optimize` でも動かない。値の変わらない UPDATE では 1 つ進み、行に当たらない UPDATE と rollback では進まない。
- **決定的な gate**：renderer の文（`SELECT 1`、`WITH … SELECT` 3 種、`EXPLAIN`、view の読み）で identity が変わる件数は **0／6**（`execute::tests::renderer_statements_do_not_move_the_read_identity`）。**同じ試験で、これらの文が temp schema の cookie を動かすことを観測した（`true`）**ので、旧い物差しでは同じ文が「変わった」になっていたことの再現でもある。実書込みでは identity が動く。W1 pooled（2,560 件）の取り直しは時間の測定と一緒に行う（報告の timing_plan）。
- **レビューで見つかった DR と実物の食い違い（直した）**：
  - **#10 の隙間**：判断 5 に書いた「lock の後にもう一度 health を見る 1 行」が実装されていなかった。`try_read_c_query_freshness_stamp` が `try_lock` の後に `ensure_connection_reusable` をもう一度呼ぶ（mutex は要らない）。
  - **view の作成は autocommit のときだけ**：`ensure_read_view` は `is_autocommit()` を見る。untrusted の入口は `reject_stale_untrusted_transaction` の後（BEGIN の前）に入るので通常は常に満たす。最初の batch が rollback されても view が残ることを試験で固定（`the_read_view_survives_a_rolled_back_first_batch`）。
  - **`SqliteSourceRevisionGuard`／`Kind` の型名は残した**：中身（kind と項目）だけが替わり、「source revision の guard」という役割は同じ。rev1 §2 の grep の 5 語の残りは、否定の assert と comment だけ（製品のコードは 0 件）。
- **C5 #3（`current_epoch` の連鎖）の呼び出し元**：12 か所（`query.rs` 492・638、`canonical.rs` 67・77・88・223、`publish.rs` 82、`cache.rs` 23、`build.rs` 86、`runtime.rs` 189・297・312）はすべて、`WorkspaceAuthority` の `Database` の `with_read_transaction`／`with_participant_read_transaction`／`with_conn` の接続で呼ばれる。N-API の呼び出し元（`related_scenes/begin.rs`・`scoring.rs`・`build.rs`）も `db`＝authority の `Database` と `db.nir_chronicle_index_runtime()` を渡す。reader（`prepare_chronicle_index_build_on_reader`、`with_chronicle_reader`）は `current_epoch` を呼ばない（admission の authority 側で済む）。**同じ file を開いた別の書込み可能な接続が製品の経路で runtime に届く場所は見つからなかった**（`new_for_workspace_maintenance` は open 時の optimize／FTS の再構築だけで runtime を持たず、MCP は `WorkspaceAuthority` も runtime も持たない。試験が作る追加の `Database` だけ）。旧は TEMP epoch で `ConnectionChanged` になっていた別 `Database` が、新は lineage が同じなので通る。これは承認済みの意味の変更（C5 #5/#6）で、届く製品の経路が無いことを確認した範囲で挙動は変わらない。
- **N-API の revalidate（基点 `a067f7f7` の現物）**：`revalidate_narrative_workspace_after_cycle`（`electron/native/grimodex-node/src/lib.rs` の 6790 付近。呼び出しは 6998・9744 付近ほか）が `current_authority.identity() != completed_authority_identity || &current_binding != expected_binding` なら `Ok(None)` で結果を捨てる。C5 の前提（再 open の拒否は authority の identity が担う）は今もある。DR の旧い行番号（6797・6830）は基点 `3f333a83` のもの。
- **P-1 の grep の範囲（実行した）**：`narrative_extraction/` の全体（IR の `nir1_chronicle_index/`、Graph の `nir1_graph/`・`nir1_graph.rs`、`nir1_entity_relation*`、`retrieval_admission/`、`repair.rs`、`incremental_freshness.rs`、`c2zc_canonical_cutover.rs`、index 保守、scene scope）で `_fts`・`fts5`・`MATCH`・`sqlite_stat`・`bm25(` を大文字小文字を区別して探して、**識別子を読む consumer は 0 件**（`nir1_capacity.rs` に自前の `capacity_fts` を作る診断があるが、identity の consumer ではない）。impact-review の TS では `narrowing.ts` が `fts_search`（候補の絞り込み。sparse arm）を呼ぶが、これは guard の対象の Codex snapshot（`buildCodexSnapshot`）の外で、FTS の rebuild／optimize は同じ内容から同じ索引を作る。post-effect の guard の経路に FTS の読みは無い。
- **周期的な no-op の書込み（判断 4）**：idle の Freshness cycle を 3 回回して落ち着かせた後の 5 回で seq が進まないことを試験で固定した（`write_clock::tests::idle_freshness_cycles_do_not_advance_the_clock`、通った）。収束した open は WAL を変えない（DR-DBC-3 追記 4）。maintenance・index 保守・heartbeat など、ほかの背景の書き手の全数は洗い出していない（未確認）。worker の窓の間の drift の件数は、時間の測定と一緒に見る。
- **identity の意味が変わった試験**（旧い物差しの性質を主張していたもの。主張を新しい意味に替えた。落ちたものを通すための緩和ではない）：
  - rolled-back な書込み：旧は `total_changes` が戻らず identity が動いた（安全側の過剰）。新は seq が戻り identity は動かない（committed な状態は同じなので、verdict の再利用は正しい）。write tx の中で読んだ seq が rollback の後に別の commit で再利用されること（ABA）の試験を足し、write tx では identity を観測しない規則（`ReadIdentity::read` が `None`）を固定した。
  - TEMP schema の変化：旧は identity が動いた（H-e）。新は動かない。audit-only の list も TEMP の変化をまたいで継承される。
  - 別の `Database`（同じ file）：旧は connection epoch が違い、proof も query context も別。新は同じ状態を同じ identity で読む（クロス接続。承認済みの意味の変更）。runtime の lineage の束縛（`DatabaseLineageChanged`）と、reader の接続で `current_epoch` を呼ぶと error になること（`NIR1_RUNTIME_REQUIRES_THE_AUTHORITY_CONNECTION`）は残した。
  - 試験が migration の後に作る ad-hoc の表（`inv_unrelated_rows`、`freshness_probe`、checkpoint の `payload`）は clock の trigger を持たないので、その表への書込みは identity を動かさない。`write_clock::cover_adhoc_tables_for_test`（`install_write_clock_in_tx` を tx で呼ぶ）で trigger を付けた。実表は migration の不変条件が付ける。
  - `read_identity_judgement_is_unchanged_by_clock_triggers`：identity が trigger に依存するようになったので、「trigger を外すと動かなくなる。その状態は `has_v46_write_clock` が偽になる（MCP は readonly、migration は作り直す）」を断言する試験に替えた。
- **検証**（この段で実行。時間の測定は無し）：
  - `cargo test -p grimodex-db --lib` 全件 2,682 件通過（変更の後に、`execute::tests`・`write_clock`・`c_query_freshness`・`nir1_chronicle_index` の 225 件を再実行して通過）。`cargo test -p grimodex-db --test '*'`（integration 79 binary）通過。`cargo test -p grimodex-post-effect --lib` 132 件通過。node crate は `cargo check --all-targets` と、stamp・related_scenes・post_effect を含む lib の 150 件が通過。
  - `cargo clippy -p grimodex-db -p grimodex-post-effect --all-targets -- -D warnings` 通過。feature（`nir1-material-diagnostics`、`nir1-graph-eval`、`test-failpoints` ほか）の clippy は、触っていない既存のコードの lint（`as_ref` の dead code、引数の数ほか）で落ちるので、feature を全部足した `cargo check --all-targets` が通ることだけを確認した（既存の lint を直す範囲ではない）。
  - C-query に触れたので `scripts/nir1-c-query-worker-ci.sh lifecycle` を通過。
  - 実 N-API の経路：debug の `.node` を `napi build` で作り、`electron/native/grimodex-node/test/post-effect-run.test.mjs`（9 件。guard の一致・stale を `backend.dbExecute` の renderer SQL で読む形）が通過。renderer の SQL が `execute_renderer_with_result` の authorizer を通り、TEMP view の guard が実際に使えることの確認。
  - vitest（`src/features/impact-review`、`src/lib`）、`--config vitest.electron.config.ts electron/shared/ipcContract.test.ts`（488 件）、`tsc --noEmit` 通過。`fnm exec --using=22 pnpm -s verify:quality` は、origin/master が基点の `a067f7f7` だった時に通過した。その後 origin/master が `9014e642` に進み、`scripts/quality/nir1-graph/observation-prep.test.mjs` を単独で回すと 101 件中 1 件（「origin/master が HEAD の祖先」の検査。基点が古いだけで、変更の欠陥ではない）が落ちる。**PR の前に master を取り込んで取り直す**（既知：ci-quality-needs-master-ancestor）。pin 済みの harness の bytes の pin の検査はほかの 100 件に含まれて通過しており、harness の file には触れていない。
  - 未実行：node crate の Rust 試験の残り（上の 150 件以外）、`pnpm test:browser`（レイアウトは触らない）、hosted CI。時間の gate（hold の p90、drift の件数、保存 IPC の p50）。

### 実装中の追記 2（2026-11-12。独立レビュー〔Opus、read-only、P1 0 件〕の指摘への対応）

- **P2-1**：`WorkspaceAuthority::new` が、その file の V-6 の list を全部捨てる（判断 6）。試験 `nir1_audit_only_lists_are_not_inherited_by_a_reopened_workspace_authority`（開き直しなしでは引き継ぐ陽性の対照つき）と `nir1_audit_only_states_forget_one_file_only`。
- **P2-2**：判断 4、「変わる点・変わらない点」、「時間の対照」、`timing-pr2-2026-11-12/results.md` を、「identity は stale_snapshot の原因ではない。基点にも trigger があり、偽の『変わった』は head の方が少ない」に直した。
- **P3 の対応**：(1) guard に path が無い限界を信頼境界に明記。(2) lineage は小文字 32 hex だけ（install と core の `has_v46_write_clock`。大文字は不正として作り直す。試験 `an_uppercase_lineage_is_invalid_and_is_rotated_to_lowercase`。大文字の lineage を作る製品の経路は無く、リテラルを持つ試験も無い〔grep〕）。(3) FTS が実表と一致している前提を判断 3 に明記。(4) repair の CAS を `read_db_clock_with_versions` に（比較は `ensure_source_unchanged_since_backup`、試験 `repair::tests::the_repair_cas_sees_a_ddl_only_change_that_leaves_the_sequence`。**backup の前後に割り込む継ぎ目は無いので、経路全体の試験は足せていない。比較の関数の試験**）。(5) 試験の質：temp schema の cookie が動くこと、ANALYZE で `schema_version`・`user_version` が動かない（`sqlite_stat1` は既にある）ことを assert にし、idle の Freshness cycle の陽性の対照（`incremental_freshness::tests::a_freshness_cycle_with_work_advances_the_write_clock`）を足した。(6) DR の試験名、判断 2 の `None`、判断 7 の「新しく開く情報」、`nir1_graph.rs` の comment、`execute.rs` の accessor の名前だけの判定の限界（main の同名 view）を直した。(7) TEMP view がある接続で clock の 2 表を作り直す migration の注意を `write_clock.rs` の `CLOCK_READ_VIEW` の doc comment に書いた。
- **検証**（rebase 後の head〔origin/master `2efb9ec2` の上〕）：`cargo clippy -p grimodex-core -p grimodex-db -p grimodex-post-effect --all-targets -- -D warnings` 通過。`cargo test -p grimodex-db --lib` 全件 2,711 件通過（指摘の修正の前の run。その後に触れた `repair`・`write_clock`・`audit_only` の 93 件を再実行して通過）。`cargo test -p grimodex-core --lib` 210 件通過。`scripts/nir1-c-query-worker-ci.sh lifecycle` 通過（rc=0）。node crate の `cargo check --all-targets` 通過。未実行：post-effect の lib の再実行（この追記で触れていない）、実 N-API の試験の再実行、hosted CI。`fnm exec --using=22 pnpm -s verify:quality` は通過（rc=0、cargo と並走させず、rebase 後の head で実行）。

### 時間の対照（2026-11-12。dev 専用の測定、製品コードは変えていない）

記録：`/home/grimodex/fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/timing-pr2-2026-11-12/results.md`（raw・集計・計装の差分・binary の sha256 を同じ dir に置いた）。base＝`a067f7f7`、head＝`d8b96398`。各腕 W1 5 run＋W0 5 run を ABAB、最初の 1 run を捨てて pooled。IPC は実 Electron（製品の main、g-ja-1 の写し）。

- **ir.qualify の lock hold の p90（W1 pooled、約 2,400 件）：base 364.0 ms → head 5.54 ms**（run ごとの範囲は重ならない。目安 20 ms 未満に届いた。C8 の「止まって再相談」には当たらない）。**p99 は 481 → 433 ms、max は 1014 → 935 ms でほぼ同じ**で、長い hold（50 ms 以上、full check の推定。直接の計数は trace に無い）の割合が 13.0% → 6.4% に減って p90 が山を外れた。p90 は構成比で跳ぶ指標なので、割合・p99・max を併記する。
- **WITH…SELECT の文で identity が変わる件数：base 3,796／3,796、head 0／4,050**（temp schema cookie は head でも全件動いた）。write 文は head で seq が +1 進む（陽性の対照）。
- **保存 IPC（W0）の p50：base 11.1 → head 11.2 ms（+0.9%）**。p90 は 21.2 → 26.5 ms で head が高く見える（run の範囲が重なる／重ならないの境）。保存の経路で足したのは `ensure_read_view` の atomic の読み 1 回と authorizer の文字列比較 1 回だけなので、**lock の競合か負荷（load1 > 13 の run があった）と見る**。分離はしていない。
- micro：`read_unpinned` 21.1 → 11.6 µs（2 回読み → 1 文）、`current_epoch` 7.1 → 7.0 µs。
- 時間切れ（rebuild 待ち 5 分）は両腕 0／100 cycle。rebuild 待ちの median は 34.1 → 35.0 s（約 +3%）。publish の stale_snapshot は 47 → 57（80 published は同じ）。**この 2 点は head が悪い方向に見えるが、identity は原因ではない**（publish の Stale は identity で決まらない。判断 4 の訂正）。候補は時期の変化（qualify が速くなり、build の試行が保存の Freshness の予約と重なる回数が変わった）で、比べるなら試行 1 回あたりの Stale の率。分けてはいない。
- **未測定**：(3) 登録の drift 件数・Suspended 件数（W1 は C-query worker の登録を通らず観測の経路が無い。worker 内の時間も同じ）、(4) cold DB の dependency-verify の Verify 完了時間。
- **限界**：腕ごとに build が別。run の最中に他の lane の cargo が重なり load1 の最大が 13 を超えた run がある（開始時は全 run で 1.6〜2.1）。計装は master に後から入った関数に合わせて両腕で同じ形に直した（`try_lock_conn_with_check`）。閾値・線は変えていない。

## DR-DBC-4 rusqlite 0.41（libsqlite3-sys 0.39、同梱 SQLite 3.54.1）への更新と、hook 登録の `&mut Connection` 化（2026-11-12）

経緯：`cargo audit` の期限付き例外 RUSTSEC-2026-0459（libsqlite3-sys 0.38 に同梱の SQLite 3.53.2 < 3.54.0。WAL の page size が db と違う sibling `-wal` を開くと、未初期化の page cache を読みうる）を外すため。修正は rusqlite >= 0.41（libsqlite3-sys >= 0.39）で、`.cargo/audit.toml` の注記どおり単なる依存の更新ではない。0.41 は接続の hook（authorizer、progress、commit、rollback、update、wal、busy、trace）の登録がすべて `&mut self` になり、grimodex-db は guard と scope の仕組みで `&Connection` を渡している。GDX-PRECHECK-001 の security-sensitive な境界の lane である。**記録の順序についての訂正（実際の経過）**：依存の bump・`cargo check`・hook の連鎖の probe（`&mut` 化の書き換え）・SQLite と rusqlite の source 差分の調査を、この文書より先に未 commit で行い、その書き換えがそのまま実装になった。read-only の advisor への相談（方針・監査の見落とし）は書き換えの前に行ったが、この DR の文書は実装と検証の後に書いた。つまり「mutation の前に判断と信頼境界を残す」順序は、この lane では守れていない（判断の内容は書き換えの前に固めた：`&mut` を型で通す、`unsafe` の shim・`RefCell`・opcode ごとの lock は採らない、衝突が構造的なら design-only で返す）。
基点は `origin/master` の `a067f7f7`、branch は `claude/rusqlite-041`。この lane は NIR-1 の事前委任の外の、依頼された依存更新の lane である。

### 変えないもの

閾値の値（`MAX_GRAPH_QUERY_RECORDS` 2,048、bytes の 2 MiB、600M steps、180 s、START_TIMEOUT 30 s、QUERY_DEADLINE 100 ms、Q 16 MiB、S 64 MiB、85% など）、送信先、保存範囲、契約、脅威モデル、IPC・preload・N-API の契約、schema、新しい authority。hook の登録・解除の期間、接続、thread は今と同じ。新しい thread・subprocess・背景の処理は無い。

### 事実（0.40.1 → 0.41.1、libsqlite3-sys 0.38.1 → 0.39.1。crate のソースの差分で確かめた）

| 項目 | 0.40.1 | 0.41.1 | この lane への影響 |
|---|---|---|---|
| 登録の API | `commit_hook`／`rollback_hook`／`update_hook`／`progress_handler`／`authorizer` は `&self`。`busy_handler`／`wal_hook`／`trace_v2` は `fn` ポインタだけ | すべて `&mut self`、closure は `FnMut + Send + 'static`、`Result` を返す | 登録する側が接続の排他的な借用を持つ必要がある。これが本体 |
| closure の保持 | `InnerConnection` の field に `Box`。置換で古い closure は代入時に drop | `sqlite3_set_clientdata`（hook ごとに別の名前）に `Box::into_raw`。置換は「新しい hook を SQLite に登録 → clientdata の置換で古い closure を destructor が free」、解除は「hook を外す → destructor が closure を free」、接続を閉じると SQLite が destructor を走らせる | 置換・解除・close の各時点で closure が生きている期間は 0.40 と同じ。**登録は 2 段で、失敗の形が 0.40 と違う**（2026-11-13 訂正。当初の「`preset` が失敗したとき古い hook が残る」は事実と違った）：① `preset` が closure の生 pointer を SQLite に登録し（`sqlite3_commit_hook(db, x, ptr)` など）、② `sqlite3_set_clientdata(db, 名前, ptr, destructor)` が記録する（`inner_connection.rs:340-370`）。② は **その名前の entry がまだ無いときだけ `sqlite3_malloc64` し**、失敗すると destructor で closure を free して `SQLITE_NOMEM` を返すが、① の登録は残る。**hook は free 済みの closure を指したまま残り**、次にその hook が呼ばれる文（COMMIT、prepare、progress の tick）で use after free になる（3.54.1 の `sqlite3_set_clientdata` と rusqlite のソースで確認し、`tests/hook_registration_nomem.rs` が `sqlite3_hard_heap_limit64` で実際に再現する）。① が失敗した場合（`sqlite3_set_authorizer` の MISUSE）だけが、closure が free され古い hook は残る形。entry の置換と解除（`None`）は malloc しない。→ 判断 12。`progress_handler` の `num_ops`・`None` の扱いは同じ |
| 借用の検査 | `check_owned()`（hooks の登録の入口）が、**所有していない接続**（`Connection::from_handle` の wrapper）への登録を `SQLITE_MISUSE`〔"Connection is not owned"〕で拒否する | 型が `&mut Connection` を要求する。`check_owned` は無くなり、**所有の検査も無い**：試験専用の `test_support::same_handle_writer`（`from_handle` の非所有の wrapper。判断 8a）でも、同じ `sqlite3*` に hook を登録できる | 型で「登録中は他の借用が無い」を保証する（hook の中から自分自身を登録できない、statement の途中に登録できない）。所有の検査が無くなった影響は **試験だけ**（`same_handle_writer` は読みの最中の書込み・観測にだけ使い、hook は登録しない。本番のコードは 2 つ目の wrapper を作らない） |
| `Transaction`／`Savepoint` | `Deref<Target = Connection>` | 同じ（**`DerefMut` は無い**） | transaction の下では hook を登録できない。`unchecked_transaction()` の下で capacity scope（progress の入れ替え）や commit hook を使う経路は、`ScopedTransaction`（下の判断 3）に替える |
| `busy_timeout` | 設定のみ | 成功すると busy handler の clientdata も消す | busy handler は使っていない（登録箇所なし）。`busy_timeout` は `&self` のまま |
| `Statement::column_names()`／`columns()` | `Vec` | `impl DoubleEndedIterator + ExactSizeIterator` | `execute.rs`・`project_snapshots.rs` の 2 か所の `.iter()` を外した |
| `Connection::backup` の進捗引数 | 推論できた | 型注釈が要る | 試験 2 か所（`nir1_capacity.rs`、`nir1_capacity_boundary_tests.rs`）に `None::<fn(rusqlite::backup::Progress)>` を足した |
| bundled のビルド | `-DSQLITE_ENABLE_MEMORY_MANAGEMENT` あり | **無し**（`libsqlite3-sys-0.39.1/build.rs`。ほかの compile flag の差は無い） | `sqlite3_release_memory`／`soft_heap_limit`／`PRAGMA shrink_memory` は無効になるが、この repo はどれも呼ばない（`rg` で 0 件）。`sqlite3_memory_used`／`sqlite3_memory_highwater` は常に有効で、診断（feature）が使うのはこの 2 つだけ **時間への影響あり**：in-process の W（R1022／D2064）で約 +4〜5%（下の「W の遅れの残りの切り分け」）。**2026-11-13：`.cargo/config.toml` の `[env] LIBSQLITE3_FLAGS` で戻した**（下の「独立レビューへの対応」の 2）。 |
| 同梱の SQLite | 3.53.2、source ID `2026-06-03 19:12:13 d6e03d8c…1a24` | 3.54.1、`2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76` | 下の「監査」 |

### 監査（`AUDITED_SQLITE_SOURCE_ID` の更新の根拠）

`with_capacity_scope` は `sqlite3_sourceid()` が `AUDITED_SQLITE_SOURCE_ID` と一致しないと `NIR1_GRAPH_CAPACITY_SQLITE_SOURCE_UNAUDITED` で止まる。3.54.1 では必ず止まるので、定数の更新は監査のやり直しである。`nir1-b-close-completion-2026-09-22.md` の監査の前提は 3 つ：(1) `nVmStep` は opcode ごとに進み、`vdbe_return` が cadence 1 の残りの callback を払い出す、(2) literal COMMIT の program は `Init → Goto → AutoCommit`（`Goto` が最初の 2 回の progress を払い出し、`AutoCommit` が `sqlite3VdbeHalt`〔commit hook・FTS `xSync`〕を最後の 1 回の前に走らせる）、(3) FTS の `xCommit` は no-op。

| 確かめた対象 | 方法 | 結果 |
|---|---|---|
| `sqlite3VdbeExec` の dispatch loop（`nVmStep`、`nProgressLimit`、`check_for_interrupt`、`jump_to_p2_and_check_for_interrupt`、`vdbe_return`、`OP_Goto`、`OP_Init`、`OP_Halt`、`OP_AutoCommit`） | 3.53.2 と 3.54.1 の `sqlite3.c` から `sqlite3VdbeExec` 全体を切り出して diff（413 行）。hunk は `OP_Int64`／`OP_Real`／`OP_ColumnsUsed`／`OP_IfNotOpen`（削除）／`OP_NullRow`／`OP_IdxDelete`／`OP_ParseSchema`／`OP_CursorHint`／`OP_Column`／`OP_MakeRecord` などの個別の opcode の本体だけ | progress の判定・払い出し・`OP_Goto`・`OP_Halt`・`OP_AutoCommit` に変更なし |
| `vdbeCommit`〜`sqlite3VdbeHalt`（commit hook と `xSync`） | 両版の 883 行を diff | 変更なし |
| COMMIT の codegen（`sqlite3EndTransaction`）、`sqlite3FinishCoding` の先頭の `OP_Init` | diff | `sqlite3EndTransaction` は同一。`sqlite3FinishCoding` の差は autoincrement の判定 1 行（`pAinc` → `usesAinc`）だけで COMMIT に無関係 |
| FTS3／FTS5 の `xSync`／`xCommit` | diff（先頭 60 行） | 変更なし |
| 実測（試験 `audited_sqlite_commit_program_and_callback_order`、`nir1_capacity.rs`） | `EXPLAIN COMMIT` の opcode 列、cadence 1 の progress の件数、commit hook が走った時点の件数 | COMMIT の progress は 3 件、commit hook は 2 件目の後（試験が固定する） |

結論：過少課金の方向の変化は無い。`AUDITED_SQLITE_SOURCE_ID` と `scripts/nir1-material-capacity-probe.mjs`（とその試験）の source ID を 3.54.1 の値に更新する（**閾値の値ではない**）。以前の 3.53.2 の基準値は引き続き「監査済み」ではなくなるので、定数を差し替える（併記しない）。

### 判断

1. **依存**：workspace の `rusqlite` と、grimodex-core・grimodex-db（本体と dev）・grimodex-semantic・grimodex-post-effect・grimodex-mcp の `rusqlite` を `0.40` → `0.41`。`src-tauri/Cargo.lock` と `electron/native/grimodex-node/Cargo.lock` は `cargo update -p rusqlite --offline` で `rusqlite` 0.41.1・`libsqlite3-sys` 0.39.1 の 2 package（と checksum）だけが変わる。grimodex-node は rusqlite を直に依存せず、grimodex-db 経由でだけ引く（Cargo.toml の注記のとおり）。standalone MCP は `src-tauri` の workspace member なので lock は `src-tauri/Cargo.lock` の 1 本。
2. **hook は `&mut Connection` を型で通す**。`unsafe` で hook の登録を `&Connection` に戻す shim（`sqlite3_progress_handler` などを自前の trampoline で直接呼ぶ）、`RefCell`、registry の opcode ごとの lock は採らない（shim は upstream が型で閉じた再入の穴〔hook の実行中・statement の途中の登録〕を開け直す。per-opcode の lock は課金の cadence と性能の gate を動かす）。登録・解除をする関数と、それを guard として持つ型（`BudgetScope`、`CommitScope`、`ProgressOwnerRestore` の復元、`ValidationContext`、`ScopedTransaction`）が `&mut Connection` を持つ。その間、本体へは `&mut *guard.conn` の再借用で貸す。
3. **`ScopedTransaction`**（`src/scoped_tx.rs`、`grimodex_db::ScopedTransaction`）：`BEGIN DEFERRED`／`COMMIT`／drop で開いていれば `ROLLBACK`（失敗は無視）。rusqlite の `Transaction`（既定の `DropBehavior::Rollback`）と同じ意味で、`Deref`＋`DerefMut` を持つ。`unchecked_transaction()` が `&Transaction` を渡していた、hook を使う経路（Graph・Chronicle の読み、`with_participant_read_transaction*`、`with_read_transaction`）だけを替える。hook を使わない箇所の `unchecked_transaction()` は残す。
4. **statement を `&mut` の呼出しの前に閉じる**：`conn.prepare` した statement を持ったまま、capacity scope などの `&mut Connection` の呼出しをしていた箇所は、statement の寿命を block に閉じる、または行を先に集める。**行を先に集める形は採らない**（2026-11-13 訂正。当初は `verify_coverage.rs` の application の行だけ先に集めていて、DR に「以前は行ごとに別の query」と書いたが、**事実と違った**：application の行の loop の本体は接続を使わず、旧コードは `query_map` の iterator を行ごとに `check_control` を挟んで読むだけだった。接続を使う `resolve_source_revision_with_control`〔`&mut`〕は後続の別の loop にあり、statement が scope の終わりまで残っていたのが衝突の原因）。statement と `query_map` を block に閉じ、その中で行ごとに `check_control` を挟んで読む形に戻した。SQL・順序・VM steps・行に比例するメモリ（先集めの `Vec` 無し）・`check_control` の挟まり方が旧と同じ。ほかの箇所（`nir1_chronicle_index/canonical.rs`、`publish_runtime.rs`、`revision_eligibility/freshness.rs`、`restore_rebuild.rs`、`verify_coverage.rs` の basis の statement）は、すでに `collect` していた、または statement が最後の使用の後も scope の終わりまで残っていただけなので、statement を block に閉じる／`drop` するだけで、挙動は同じ。
5. **`with_conn` は `&Connection` のまま**にし、hook を登録・解除する closure のための `Database::with_conn_mut`（`&mut Connection`）を足す。`with_conn` は `with_conn_mut` の薄い wrapper で、`attempt_active` の経路（`with_capacity_connection`）の差は無い。`with_participant_sql_scope`／`with_participant_read_transaction*`／`with_chronicle_reader`／`with_immediate_transaction*`／`with_graph_no_wait` と maintenance scope の operation は `FnOnce(&mut Connection)` に変える。
6. **`ValidationContext`** は `&Connection` ではなく `&mut Connection` を持ち、`connection()`（`&mut`）と、接続と stop owner を同時に借りる `parts()` を持つ。`ensure_connection`（context の作成に使った接続と同じ接続かの pointer 比較）は、`&mut` を context が持つので自明（同じ接続しか持てない）になり、2 か所の呼出しと一緒に削除する。
7. **`with_pinned_snapshot`** は guard 版の `pinned_snapshot_scope(conn)` を足す（Graph の読みの 2 か所〔registration と query〕が使う）。guard は pin（値）だけを持ち接続を借りないので、scope の間も `&mut Connection` を使える。scope は guard の寿命（unwind でも）で終わり、`finish_read` の ROLLBACK の前に閉じる順序は変わらない。closure 版は試験用（`#[cfg(test)]`）に残す。
7a. **`GenerationHistorySnapshotReader`**（native の chat の履歴の読み。feature `native-current-human-capture`＝grimodex-node が常に有効にする）は `&mut Connection` を持つ。history run の read-only authorizer の guard `ReadOnlyRun` は reader を排他的に借り（`Deref`／`DerefMut` で reader を貸す）、run は guard を通して続く。`drop` で authorizer を外す。`authority_connection()`（requalifier に貸す `&Connection`）は reader の借用に結びつく。
8. **試験の hook**（約 100 か所）は `Database::with_conn_mut` から `&mut` を取る。hook の登録・解除を `with_conn` の closure の中で行っていた試験は、期間が同じ（登録 → 対象の呼出し → 解除）まま `with_conn_mut` に変わる。
8a. **同じ接続での「読みの最中の書込み・観測」を使う試験 4 件**（`freshness_share_tests.rs` の `Observed`、`query_context_reuse_tests.rs` の `WriteDuringCheck`、`nir1_history_budget_tests.rs` の read-only 検査の probe、`registration_statements.rs` の `LiveProbe`）は、読みが `&mut Connection` を持つので、読み自身の参照では書けない・観測できない。試験専用の `test_support::same_handle_writer`（`Connection::from_handle` の非所有の wrapper。同じ `sqlite3*` を指す別の Rust object）を使う。Rust の参照は重ならず、SQLite が同じ thread での同じ handle の使用を直列化する。authorizer は handle に付くので、read-only 検査の試験は同じ結果（拒否）になる。本番のコードは 2 つ目の wrapper を作らない。
9. **`AUDITED_SQLITE_SOURCE_ID` の更新**（上の監査）。
10. **grimodex-node**：`with_conn` → `with_conn_mut` を、cutover の 2 か所（`cut_over_workspace_freshness` 等）と評価 harness の `update_hook` に、関連場面の build の `|conn: &mut _|` を 2 か所、試験 2 件に。`ScopedTransaction` は `grimodex_db::ScopedTransaction` として公開する（node の試験と、grimodex-db の integration 試験と example が使う）。公開関数のうち `&mut Connection` を取る形に変わったのは、`narrative_extraction` の cutover・skip evidence・Chronicle の build と query・Graph の build／publish・repair・verify・retrieval／revision eligibility の読み（約 30 個。`git diff` の `pub fn`）。

11. **`ReusedStatement`（`nir1_entity_relation_index.rs`）の `sqlite3_clear_bindings` を NULL の bind に替える**。SQLite 3.54 の planner は、index に使われない `x = ?` の項の parameter を「bind し直すと reprepare」として登録する（`sqlite3ExprIsInteger(…, pParse, 1)`。整数 0／1 への・からの変化でだけ失効）。`sqlite3_clear_bindings` は登録のある statement を必ず失効させるので、Graph の registration が 5 つの statement を Revision ごとに持ち回す最適化（prepare は 1 回、DR-GRW-3）が、使うたびの再 prepare（`RePrepare` が 2〜3）に戻っていた（試験 4 件の失敗で見つかった）。bind の解放の目的（長い Revision id の copy を SQLite が次の bind まで持たない）は、全 parameter に NULL を bind すれば同じに果たせ、登録のある parameter でも text → NULL → text は失効しない。意味（答え・保持する memory）は同じで、試験（`registration_statements` の prepares／reprepares／mem_used）が固定する。rusqlite の `prepare_cached` も返却時に `clear_bindings` を呼ぶので、同じ条件の cached statement は 3.54 で使うたびに再 prepare されうる（この lane では変えない。capacity scope の steps への課金は**実測した**：下の「独立レビューへの対応」の 3）。

### owner／lifecycle matrix（GDX-PRECHECK-001。新しい thread・subprocess・背景の処理は無い。hook ごとの登録・解除の owner）

| hook | 登録する owner（本番） | 解除・復元の owner と期間 | 接続・thread | 変わる点 |
|---|---|---|---|---|
| progress | 保守の outer scope（`run_outer_scope`）：`set_sqlite_progress_handler` で登録、operation の後・rollback の前に `0`／`None` で解除 | 同じ関数。operation の panic は `catch_unwind` → 解除 → `resume_unwind` | 接続の mutex の guard を持つ thread。nested の scope は hook に触れない | 引数が `&mut`（`with_narrative_maintenance_connection_scope*` の operation が `FnOnce(&mut Connection)`）。期間は同じ |
| progress | capacity scope（`with_capacity_scope`）：budget を足して `install`、終了で budget を外して `install` し直す。`BudgetScope` の `Drop` が panic の unwind でも再 install | `BudgetScope`（`&mut Connection` を持つ）。operation には `scope.conn` の再借用を渡す | 同じ | operation が接続を引数で受け取る形（`|conn, budget, control|`）になった。panic 時の `Drop` の再 install は残る |
| progress | Graph query の owner（`push_progress_owner`／`ProgressOwnerRestore::{clear_for_cleanup, restore}`） | `finish_read` が `clear_for_cleanup` → ROLLBACK → `restore` | 同じ | 引数が `&mut`。順序は同じ |
| progress | renderer SQL の policy（`execute.rs` の `with_untrusted_sql_policy`）：authorizer＋progress＋limit＋db_config を設定し、終了で `restore_renderer_sql_policy` | 同じ関数。cleanup は `keep_first_cleanup_error` で最初の失敗を保つ | 接続の mutex の guard | 引数が `&mut`。期間・順序は同じ |
| progress | 診断（`nir1-material-diagnostics`、`set_measured_progress_handler`） | capacity の `install` と同じ | 同じ | 引数が `&mut` |
| authorizer | renderer SQL の policy（上）、`ReadOnlyRun`（generation history の読み。`Drop` で解除） | policy の cleanup／`ReadOnlyRun::drop` | 同じ | `ReadOnlyRun` は `&mut Connection` を持ち、`Deref` で読みに貸す。drop の解除は同じ |
| commit | capacity の `commit_transaction`（`CommitScope`。literal COMMIT の間だけ。`Drop` で外す） | `CommitScope`（`&mut Connection` を持つ） | 同じ | `scope.conn` 経由で COMMIT と解除を行う。期間は同じ |
| update／rollback／busy（`busy_handler`）／preupdate | 本番では rusqlite で登録しない（`rg` で 0 件）。`update_hook` は `grimodex-node` の評価 harness の `CaseWorkspace::open` だけ。`busy_timeout` は `sqlite3_busy_timeout` の後に `busy_handler` の clientdata を `None` で消すだけ（entry が無ければ malloc しない）なので P3-1 の対象外 | harness の接続の寿命 | `with_conn_mut` | 登録の API が `with_conn_mut` になっただけ |
| wal／trace_v2 | **本番でも登録している**が、rusqlite を通さない生の FFI：`background_checkpoint.rs`（`sqlite3_wal_hook`〔749・798行〕。自前の callback と引数）、診断 feature の `nir1_capacity_diagnostics.rs`（`sqlite3_trace_v2`〔608行〕と、open 時の meter の `sqlite3_progress_handler`）。2026-11-13 訂正：当初は「wal／trace は本番で 0 件」と書いたが誤り | それぞれの接続の寿命（診断の meter は `disable_progress_handler` が entry の有無にかかわらず外す） | 同じ | rusqlite 0.41 の clientdata を使わないので **0.41 の影響は無い**。P3-1 の dangling も起きない（entry を作らない） |

### 信頼境界

actor・防御・受信先・保存範囲・脅威モデルは変えない。この lane が閉じるのは RUSTSEC-2026-0459 の穴（sibling `-wal` の page size の不一致）で、Grimodex は自分の workspace の DB と、`PRAGMA quick_check` を通した workspace 内の backup だけを開く。他人から受け取った workspace を開く問題は、この更新の後も同じ未決（この lane の範囲外）。型の変更は、hook の登録と statement／transaction／guard の借用が重ならないことをコンパイラが保証する方向（強める）だけである。

### 代替案

- 登録を `unsafe` の shim で `&Connection` のまま行う：上のとおり、upstream が閉じた再入の穴を開け直すので採らない。
- `RefCell`／`Mutex` で接続を包み、実行時に借用を検査する：statement が生きている間の登録が panic／deadlock になるので採らない。
- 0.40 に留めて例外を延ばす：期限（2026-12-10）があり、他人の workspace を開く案（open question）の前提になるので採らない。
- 全 `&Connection` を一括で `&mut` にする：hook に到達しない読みの関数まで巻き込むので、hook に至る呼出しの連鎖だけを（コンパイラに従って）替える。

### 試験・基準値の変化（SQLite 3.53.2 → 3.54.1。閾値の値は変えていない。基準値が閾値を超える方向に動いたものは無い）

| 試験・値 | 3.53.2 | 3.54.1 | 扱い |
|---|---|---|---|
| `fixed_graph_sql_budget_admits_600000_steps_and_refuses_600001`（`nir1_capacity.rs`。`QUERY_SQL_STEPS` 600,000 の「ちょうど」の workload） | 26,082 行＋padding 23 文で 600,000 steps | 同じ workload が **599,999** | 閾値は変えず、workload を 26,081 行＋padding 29 文（23×26,081＋4×29＋21＝600,000）に較正し直した（1 step 少ない原因が固定部分か padding かは切り分けていない推定。較正後の workload で 600,000 になり、N+1 で拒否する 2 つ目の表明は同じ）。**過少課金ではない**（2026-11-13 の独立レビューへの回答）：課金は VM の opcode 単位（cadence 1 の progress は opcode ごとに 1 回）で、同じ workload が 1 step 少なくなる＝同じ SQL の program が 1 opcode 短くなったということ。監査の `sqlite3VdbeExec` の diff（413 行）に `OP_IfNotOpen` の本体の削除があり、codegen の差（3.54 が同形の文で opcode を 1 つ減らした）が候補だが、**どの opcode かは切り分けていない**。課金が減る向き（拒否が緩む向き）の変化ではなく、閾値の値は変えていない。上限ちょうどの workload の較正を取り直しただけで、各 statement の opcode 数の差が閾値の判定を緩めるわけではない（実際の SQL の steps は SQLite の program が決め、閾値は「その program を何 step まで許すか」のまま）。 |
| COMMIT の progress（新しい試験 `audited_sqlite_commit_program_and_callback_order`） | （監査の文書の記述） | `EXPLAIN COMMIT` は Init／AutoCommit／Halt／Goto（実行順は Init → Goto → AutoCommit）、cadence 1 の progress は 3 件、commit hook は 2 件目の後 | 前提どおり。過少課金の変化は無い。**ただしこの試験は in-memory・FTS 無し・WAL 無し**で、監査の前提 (3)（FTS の `xSync`／`xCommit` の順序）の根拠は **3.53.2 と 3.54.1 の source の diff だけ**だった（2026-11-13 の独立レビュー）。FTS5 と WAL の形を足した（下の行） |
| COMMIT の progress（FTS5＋WAL。新しい試験 `audited_commit_callback_order_holds_with_fts5_and_wal`、2026-11-13） | — | WAL の db で `fts5` の table に INSERT した transaction の COMMIT：commit hook の前に **83 件**（Init／Goto の 2 件＋FTS5 の `xSync` が内部の SQL を走らせて足す 81 件）、hook の後に**ちょうど 1 件**（合計 84 件） | `commit_transaction` が前提にする「hook は FTS の sync の後、最後の 1 件は hook の後」が、実際の FTS5 の write と WAL でも成り立つ。件数そのものは固定せず、`hook 時点 ≥ 2` と `合計 = hook 時点 + 1` を表明する |
| registration の statement の `RePrepare`（`registration_statements`、`nir1_entity_relation::tests::registration_reads_each_revision_in_the_scratch_scope_and_checks_outside_it`。4 件） | 0 | 2〜3（`clear_bindings` による失効） | 判断 11 で 0 に戻した |
| 表明のある VM steps の基準値・Q／S の高水位・capacity fixture の期待値（全件の lib 試験、`--all-features` の capacity／history の試験、`nir1-c-query-worker-ci.sh lifecycle` の実 worker 26 件） | — | 上の 1 件以外は変化なし（pass） | 表明のある値は不変 |
| ignored の測定（`measure_*`、`cq_avail` の記録など、値を表明せず記録だけする試験） | — | **未再測定** | この lane では走らせていない。次に測る lane が 3.54.1 の値として取り直す |

### 検証（2026-11-12。同じ候補・環境）

- 型：`cargo check --workspace --exclude grimodex --exclude grimodex-semantic --all-targets`、`cargo check -p grimodex-db --all-targets --all-features`（`native-current-human-capture`・`nir1-material-diagnostics`・`workspace-maintenance-test-support`・`test-failpoints`・`nir1-final-request-eval`・`nir1-graph-eval` を含む）、`electron/native/grimodex-node` の `cargo check --all-targets`（既定と `nir1-final-request-eval nir1-graph-eval test-lifecycle`）。`grimodex`（frozen legacy の Tauri shell）の lib と `grimodex-semantic` の integration 試験 `reranker_shadow` は、この lane の前から別の理由で build できない（`tauri::test`・`grimodex_semantic::reranker`。rusqlite とは無関係）。
- `cargo clippy -p grimodex-db --all-targets -- -D warnings`（既定の feature）は警告なし。feature を足した clippy は、この lane の前から別の警告（`nir1_packing.rs`、`open.rs`、dead code など）が残っており、この lane では触れない。
- `cargo test -p grimodex-db --lib`：2,672 件 pass、0 件 fail（58 件は ignored のまま）。全 integration 試験（`--test '*'`）79 binary pass。`grimodex-core`・`grimodex-mcp`・`grimodex-post-effect` と `grimodex-semantic --lib` pass。`scripts/nir1-c-query-worker-ci.sh lifecycle` は exit 0（実 worker の lifecycle 26 件）。`grimodex-node` の `cargo test`：全件を流した最初の 2 回は、出力が途中で切れて 17／19 件が FAILED（panic の文は残らない。`/tmp` の quota 枯渇の最中）、`TMPDIR` を別の volume にした 3 回目が 805 件 pass・1 件 fail で、その 1 件は時間の制約が負荷で超えた（`recovery_join_slot_survives_restore_reentry_and_shutdown_with_zero_counters`、`bounded shutdown observation: Elapsed`）もので、単独の再実行 3 回で pass。feature 付き（CI が使う `licensing,legacy-keyring-migration` の node の試験）は走らせていない。`cargo test -p grimodex-db --lib --all-features -- <触った module>`（nir1_history_budget／nir1_generation_history／nir1_generation::tests／scene_disclosure／nir1_capacity*／nir1_graph_memory）は 337 件 pass。
- 環境の注記：全件を流した時に別の lane の leak で `/tmp` の quota（EDQUOT）が尽き、`disk I/O error` で `narrative_c2zc_canonical_cutover` の 2 件と node の数件が 1 回落ちた。単独・`TMPDIR` を別の volume にして再実行すると pass。SQLite 3.54.1 の挙動ではなく環境の問題として扱った。
- `scripts/release-workflows.test.mjs`・`scripts/nir1-material-capacity-probe.test.mjs`：pass（59 件）。`pnpm -s verify:quality`（Node 22）：**617 pass・3 fail で、成功ではない**。3 件（`ci-pause.test.mjs` の 61・64・79）は `/tmp` の quota（`EDQUOT`、`-122`）で fixture を書けず落ちたもので、コードの失敗ではない（`src-tauri/Cargo.toml` などの sizing の digest は `scripts/local-ci-full-workload-allocation.json` で取り直した〔digest だけ。#845 と同じ扱い〕）。quota が空いた環境で再実行が要る。`THIRD_PARTY_LICENSES.md`（root と `public/`）は `pnpm generate:licenses` で `rusqlite` 0.41.1／`libsqlite3-sys` 0.39.1 の 2 行だけが変わった。
- grimodex-node の `cargo clippy --all-targets -- -D warnings`：`src/nir1_local_entry_tests.rs:136` の 1 件（この lane の前から。diff に入っていない）。grimodex-db の feature 付き clippy の指摘も、確かめた行（`nir1_packing`・`nir1_generation`・`nir1_graph`・`open` など 16 行）は diff の外。
- Linux 以外の `cfg`（`windows`・`not(unix)`・`not(target_os = "linux")`）の block は、`with_conn`・transaction・hook・変わった公開関数を使うものが無いことを grep で確かめた。3 OS の hosted CI は走らせていない。
- 未実行：`cargo audit`（網が要る。`cargo install cargo-audit` と advisory DB の取得）。`grimodex-node` の release の `.node` の build と Electron の journey。時間の測定（下）。

### 時間の測定（計画。2026-11-12 時点では未実施。**その後に実施した**：registration の W は下の「時間の対照」「W の遅れの原因と対処」「W の遅れの残りの切り分け」と「独立レビューへの対応」の 2・4、`prepare_cached` の steps は 3）

task の「時間の測定は不要」の例外（DB の書込み・読みの性能の gate に当たる変化が疑われる）に当たる変化を 2 つ見つけたので、`needs_timing = true`。値は実測する前に「影響なし」とは書かない。

1. **判断 11（`clear_bindings`）**：registration の statement の持ち回し（DR-GRW-3）を左右する。base（`origin/master` `a067f7f7`）と head（この枝）の worktree を別に作り、それぞれ release で `nir1-c-query-worker`（実 worker）を build する。DR-GRW-3 の W p50 の測定と同じ case（R4・R16・R1022・D2064）を、base と head を**交互**に各腕 7 本以上。head の W p50 が base 以下か、R1022／D2064 の改善（−29%／−52%）が残っているかを見る。裏付けの決定的な値として、`registration_statements` の `RePrepare` が 0 のままであること（試験が固定する）。
2. **`prepare_cached` を使う書込み・読みの経路**：rusqlite の `prepare_cached` は statement を cache に返すとき `sqlite3_clear_bindings` を呼ぶので、3.54 で「index に使われない `x = ?`」を持つ statement は使うたびに再 prepare される。対象は `source_revision.rs` の 2 か所、`contribution_target_state.rs` の 2 か所、`nir1_generation/local_audit_writer.rs` の 1 か所（ほか `runtime_performance_seed.rs` は seed 用）。DR-DBC-3 の gate と同じ手順で、dev 枝 `claude/db-conn-measure` の driver を base と head の両方に載せ、**G1**（保存 IPC の p50、W0 `--trace off --saves 100 --pause-ms 600`、各腕 5 run 交互、DB は run ごとに写し）と **G3**（project 削除、g-ja-1 の写し 5 個ずつ、base と head で ms と倍率）を測る。
3. SQLite の更新そのもの（3.53.2 → 3.54.1）の差は、上の測定に含まれる。静かな machine で、評価の run や他の lane の cargo と同時に走らせない。

### 時間の対照（2026-11-12、dev 専用・release・別 worktree の base／head を交互。生データと全文は `fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/timing-rusqlite-2026-11-12/results.md`）

- **registration の W p50 は head の方が遅い**（in-process の DR-GRW-3 の harness、lookaside 0、各 case 7 run×20 回）：Q2044/R4 304.3 → 516.7 ms（+69.8%）、Q8176/R16 1241.6 → 2078.9 ms（+67.4%）、Q2044/R1022 1247.0 → 1336.6 ms（+7.2%）、D2064/report-heavy 1041.2 → 1137.1 ms（+9.2%）。head の W p50 が base 以下という期待は 4 case とも満たされず、R1022 −29%／D2064 −52% の改善は ReusedStatement の持ち回しが変わった結果ではなく、base 側の値に対して +7〜9% の遅れが残る（R4／R16 は +67〜70%）。
- **増加の主因は 1 文**：R4 の statement trace（各腕 1 rep）で、増加分 +238 ms は SourceIndex の `SOURCE_INDEX_DUPLICATE_SQL`（`GROUP BY edge.consumer_key, edge.source_object_identity HAVING COUNT(*)<>1`）の 1 回が 3.8 ms → 241.8 ms になったことで説明できる。ほかの文の差は最大 +7.9 ms。原因（3.54 の plan の変化か、json の評価位置か）は未確認。
- G1（Rust 水準の保存 p50、g-ja-1 の写し、5 run）：base 7188 µs／head 7170 µs。G3（project 削除、5 個ずつ）：p50 3159／3231 ms（+2.3%、範囲は重なる）。`prepare_cached` の 5 か所の影響は、この 2 つでは見えない（分けては測っていない）。
- 未測定：実 worker の W・時間切れの本数、G1 の IPC 水準（disk の残りで Electron の build を 2 腕分置けない）、DUPLICATE 文の `EXPLAIN QUERY PLAN`。W の 1 run は開始時の負荷が 10.21（quiet でない）。他の lane の cargo と完全には分離できていない。
- 判断：「影響なし」とは書けない。W の悪化は DR-GRW-1〜4 の窓を縮める効果を打ち消す方向で、DUPLICATE 文の plan を 3.53.2 と 3.54.1 で比べ、書き直し（または `CROSS JOIN` の順・`MATERIALIZED` の扱いの固定）で戻せるかを次に調べる。この lane の変更（hook の `&mut Connection`、`ReusedStatement` の NULL bind）が主因でないことは、statement 単位の差（1 文に集中）から言えるが、SQLite の更新との切り分けは未実施。

### W の遅れの原因と対処（2026-11-13。dev 専用の測定、記録は `fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/plan-rusqlite-2026-11-13/`）

**原因（確定）**：SQLite 3.54 の `json_valid` は、1 引数の text に対しても解析結果を次の呼び出しへ残さない（amalgamation の `jsonValidFunc` が `jsonParseFuncArg(.., JSON_KEEPERROR|JSON_NOCACHE)` を渡す。3.53.2 は `JSON_KEEPERROR` だけで、同じ行の後続の呼び出しが解析を使い回していた）。`json_extract` は 3.54 でも cache される。`SOURCE_INDEX_DUPLICATE_SQL`（`candidates.rs`）は `qualifying q → narrative_dependency_edges edge → narrative_proposal_revisions r` の順で、`r` だけを見る 6 個の JSON 条件（`json_valid(r.payload_json)=1` ほか）を **Edge の行ごと** に評価していた。3.53.2 では cache が効いて Revision ごと 1 回の解析と同じ費用だったが、3.54 では Edge ごとに payload 全体（R4 の fixture で 1 つ約 178 KB）を解析し直す。lane の変更（hook の `&mut Connection`、`ReusedStatement` の NULL bind）ではない。

切り分け（rusqlite を通さない C の再現で、libsqlite3-sys 0.38.2＝3.53.2 と 0.39.1＝3.54.1 の amalgamation を同じ flag で build。R4 の fixture の DB、lookaside 0。`c/` に source と結果）：
- `EXPLAIN QUERY PLAN` と `EXPLAIN`（opcode）は両版で同一。VM steps も同一（55,351）。plan の変化ではない。
- DUPLICATE 文の CPU 時間：3.53.2 は 4.98 ms、3.54.1 は 254 ms（R4）。`json_valid(r.payload_json)=1` だけを Edge ごとに評価する最小の文で 2.3 ms → 290 ms、`json_extract` だけでは差なし。
- 文を `q → r → edge` の順に変えると、3.54.1 で 254 → 2.96 ms（R4）、VM steps は 55,351 → 28,938。

**対処**：`SOURCE_INDEX_DUPLICATE_SQL` の `CROSS JOIN` の順を `q → r → edge` にした（述語・束縛・`GROUP BY … HAVING COUNT(*)<>1` は同じ）。`r` を先に読むので、`r` だけの 6 条件は Revision ごと 1 回評価される。**同じ結果**の根拠は 3 つ：(1) 述語と読む行が同じ。違うのは、Edge の無い qualifying Revision の payload も読むことだけで、DUPLICATE は MALFORMED が false を返した後にだけ実行される（`verify_complete_source_index`）。MALFORMED が同じ payload を全部読んで有効と確かめた後なので、新たな読みでエラーは起きない。(2) 旧文を `SOURCE_INDEX_DUPLICATE_EDGES_FIRST_ORACLE_SQL`（試験の oracle）に残し、既存の 36 通りの damage × 実 schema／UNIQUE 無しの 2 通りに、「Edge の無い Revision の payload が invalid／空／null／数値／配列／BOM 付き／BLOB／形が違う」の 20 通りを足して、**文単独の結果（値またはエラー文）が一致**することを固定した（空・healthy・Edge 無しの形も）。(3) `json_valid` の評価回数（healthy で 6 回 → 2 回）と plan の順（`SEARCH r` が `SEARCH edge` より前）を試験で固定した。UNEXPECTED は DR-GRW-1 の `valid` CTE で Revision ごとに 1 回なので変更しない。

**CPU 時間（C の再現、各文 7 回の中央、lookaside 0、`c/bench-out.txt`。3.53.2 → 3.54.1、ms）**：

    fixture   DUPLICATE（旧文）    DUPLICATE（新文）   MALFORMED（変更なし）
    R4        5.0 → 254.3          3.2 → 3.0           11.9 → 20.9
    R16       17.3 → 1040.3        11.2 → 10.9         43.5 → 68.9
    R1022     9.4 → 11.1           11.0 → 10.8         19.5 → 34.3
    D2064     13.8 → 15.2          13.4 → 15.4         29.5 → 49.1

R1022／D2064 は Revision が小さい（約 1 KB）ので、旧文でも遅れは小さい（+1.7／+1.5 ms）。遅くなる範囲は「Revision の payload の大きさ × その Edge の数」で、R の小さい（1 Revision が大きい）形、つまり Q²/R の大きい形で効く。製品で当たるのは Revision あたりの Entity が多い取込み（Q2044/R4 は 1 Revision が約 178 KB・約 250 Edge）。

**W の取り直し**（in-process、DR-GRW-3 と同じ harness、lookaside 0、各 run 20 回、腕は交互。base は master `a067f7f7`、head2 はこの枝に DUPLICATE の変更だけを当てた build。binary の sha256：base `77e10e08…`、head（前の測定）`098891bc…`、head2 `def28c78…`）。開始時の loadavg が 3 未満（quiet）だった run だけで集計する。他の lane の cargo で最初の run は 8〜20 だった（`loadW.txt`、`analysisQ.txt`）：

    case                 base      head（前）   head2     head2/base（quiet のみ）
    Q2044/R4             303.1     516.7        316.5     +4.4%（前は +69.8%）
    Q8176/R16            1224.8    2078.9       1279.9    +4.5%（前は +67.4%）
    Q2044/R1022          1225.7    1336.6       1307.4    +6.7%
    D2064/report-heavy   1035.3    1137.1       1115.2    +7.7%

quiet の run 数は R4 が各腕 3、R16 は base 3／head2 5、R1022・D2064 は各腕 3（各 20 回）。各 run の p50 の範囲は 4 case とも base と head2 で重ならない（R1022：base 1197〜1229、head2 1301〜1321）。quiet でない run（R4 の 6 本、R16 の 4 本）は集計から外した（荷重で base も 437 ms などに遅くなる）。

**残る遅れ**：4〜8%（R4 +13 ms、R16 +55 ms、R1022 +82 ms、D2064 +80 ms）は直っていない。切り分けの結果：
- MALFORMED（`CASE WHEN json_valid(..)` を条件ごとに繰り返すので 3.54 では Revision ごとに約 8 回解析する）が C の再現で +9／+25／+15／+20 ms（R4／R16／R1022／D2064）。R4 の +13 ms の大半はこれで、R16 は約半分。
- R1022／D2064 の statement trace（各腕 16 回、`trace-*`、`analyzeT.mjs`）では、残りは 1 文に集まらず、小さい文の loop（`… WHERE id = ?1`、`… ORDER BY ordinal ASC` など）が 3〜15% ずつ遅い。同じ文を C で回すと両版で同じ（1022 回で 3.1 ms）ので、SQLite の statement の費用ではない。Cargo.lock の差は rusqlite／libsqlite3-sys だけなので、rusqlite 0.41 側の呼び出しの費用（`prepare_cached` の `clear_bindings` 後の再 prepare を含む判断 11 の影響）かこの lane の変更が候補だが、**未特定**。
- 次の手：MALFORMED の `json_valid` を Revision ごと 1 回にする書き直し（見込み +10〜25 ms の回収。結果が同じことの試験は今回の oracle の方式で足りる）。R1022／D2064 の diffuse な遅れは、statement 単位の CPU 時間を rusqlite 0.40 と 0.41 で比べる測定が要る。

**製品で当たる経路**：registration は実 worker では 30 s の START_TIMEOUT 内で行う。今回の in-process の W は最大 R16 で約 1.3 s（修正前 2.1 s）で、30 s に対する余裕は 23 倍以上ある。ただし W は Q8176/R16 の fixture の値で、これより Revision が大きい取込みでは Edge ごとの再解析の費用が payload の大きさ × Edge の数で増えるので、修正前は 3.54 で窓が広がる向きだった。窓の縮小（DR-GRW-1〜4）の効果は DUPLICATE の修正で回復し、残りの 4〜8% は上の通り。実 worker での W は未測定（変更していない）。

3.54 では `json_valid` を行ごとに評価する文が全て同じ遅れ方をする。`candidates.rs` 以外（`nir1_graph/input.rs`、`scene_scope.rs`、`nir1_entity_relation_index.rs` など）の `json_valid` が per-row の loop に入っていないかは、今回は調べていない（W の statement trace では DUPLICATE のほかに 1 文だけの大きな増加は無かった）。

### W の遅れの残りの切り分け（2026-11-13。dev 専用の測定、記録は `fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/plan-rusqlite-2026-11-13/` と `…-13-b/`）

**(a) MALFORMED を `json_valid` が Revision ごと 1 回の形にした**（`candidates.rs` の `SOURCE_INDEX_MALFORMED_SQL`、commit `a464d99f`）。旧文は `json_valid(r.payload_json)` を条件ごとの `CASE` で繰り返し、健全な Revision で 8 回（`=0` の 1 回、`$.schemaVersion`／`kind`／`producer`／`projectId`／`revisionId` の 5 回、`json_type` の 1 回、`json_each` の引数の 1 回）payload を解析し直す。新文は `QUALIFYING_REVISIONS` の後ろに materialized CTE `parsed(id, project_id, ok)`（`qualifying` から始め、`r` を主キーで引き、`ok = json_valid(r.payload_json)` を 1 回）を足し、各条件は `v.ok` を読む。`ok` は元の呼び出しと同じ値（0／1／NULL）で、`json_extract`・`json_type`（3.54 でも cache される）と Entity ごとの小さい値への検査は変えていない。

- **同じ結果の根拠**：(1) 述語と読む行が同じ（payload を読むのは `qualifying` の Revision だけ。`parsed` も `qualifying` から始まる）。(2) 旧文を試験の oracle `SOURCE_INDEX_MALFORMED_REPEATED_VALID_ORACLE_SQL` に残し、`malformed_with_one_validity_check_agrees_with_the_repeated_one_on_every_damage` で、既存の damage 36 通りと、payload の形 14 種（不正 JSON・途中で切れた・空・`null`・数値・文字列・配列・JSON5・BOM 付き・BLOB・JSON でない BLOB・`schemaVersion` が文字列・`bundle` が配列・Entity が `{}`／`null`）を Edge の残る Revision 0／1・Edge の無い Revision 1・両方の 4 通りに当てた 56 通りを足し、実 schema（UNIQUE あり）と UNIQUE 無しの 2 通り（合計 184 件）で、文単独の結果（値またはエラー文）と `verify_complete_source_index` の判定が一致することを固定した（結果は `Ok(true)`／`Ok(false)` の 2 種だけで、エラーは 0）。空・健全・Edge 無し・別 project の Set は `…_agrees_on_the_empty_and_the_healthy_project`。(3) `json_valid` の評価回数（payload に対して 16 回 → 2 回。Entity の値への 12 回は同じ）と plan の順（`MATERIALIZE parsed` → `qualifying` → `SCAN q` → `SCAN v`、`SCAN r` は集合を選ぶ 1 回、`SEARCH r … (id=?)` が 2 回）を `…_tests_each_payload_once_not_once_per_condition`、payload を読むのが subject の Revision だけであることを `…_parses_the_payload_of_nothing_but_its_subject` で固定した。
- **残る差（結果は変わらない）**：旧文は最初の malformed な Revision で止まり、残りの payload を解析しなかった。新文は `parsed` を全 Revision で作ってから判定する。差が出るのは答えが true の場合だけで、そのとき proof はそこで終わる（W に入る健全な経路では両方とも全 Revision を読む）。`r` を `parsed` の中と本体の 2 回主キーで引くので、C の再現では旧文（3.53.2）より 1〜4 ms 遅いまま。

C の再現（`c/` の amalgamation、同じ flag、lookaside 0、各文 7 回の中央の CPU 時間、ms。この session の別の再測定で、他の lane の負荷は 2 前後）：

    fixture   旧文（3.53.2）  旧文（3.54.1）  新文（3.54.1）
    R4            7.5            12.7             8.6
    R16          29.7            50.2            33.5
    R1022        14.2            23.1            15.3
    D2064        18.3            31.0            20.6

**(b) 小さい文の loop の遅れの切り分け**（W の遅れの残り。base＝master の `a067f7f7`〔rusqlite 0.40.1、SQLite 3.53.2、`MEMORY_MANAGEMENT` あり〕、F＝この枝の `a464d99f`〔0.41.1、3.54.1、flag なし〕）。

1. **rusqlite の呼出しの費用ではない**：独立の Rust bench（0.40.1 と 0.41.1 を別 crate で build、release、r1022 の fixture、1,022 id を 20 回、`prepare_cached`／持ち回しの `query_row`／index に使われない `AND origin_kind = ?2` の項／4 行の `query`／`String` の取得／毎回 `Connection::prepare`／progress handler〔cadence 1 と 1000〕の有無）。**0.41.1＋3.54.1 の方が 5〜8% 速い**（例：`prepare_cached` の PK 検索 1,499〜1,518 → 1,414〜1,437 ns、持ち回し 1,324〜1,339 → 1,241〜1,253 ns、cadence 1 の handler 付きでも同じ）。index に使われない項の文の差（`prepare_cached` と持ち回しの差）は両版とも約 115 ns で、`clear_bindings` による再 prepare の費用は見えない（`RePrepare` の回数は bench では数えていない。registration の statement が `RePrepare` 0 であることは `registration_statements` の試験が固定している）。毎回 prepare する文は、PK 検索で 3.75 → 3.70 µs、`COUNT_SQL`（長い文）で 54.8 → 57.1 µs。この文は持ち回しでは 14.9 → 17.0 µs（+14%）で、これは下の `json_valid` の繰り返し。
2. **SQLite 3.54 の本体でもない**：W を 3 腕で測った（R1022、各腕 3 run×10 回、すべて quiet、交互）。base 1217.4 ms、F 1307.4 ms（+7.4%）、**X 1297.4 ms（+6.6%）**。X は F と同じ source に libsqlite3-sys 0.39.1 の amalgamation だけを 3.53.2 のものに替えた build（`SQLITE_SOURCE_ID` の文字列は製品の監査〔`AUDITED_SQLITE_SOURCE_ID`〕を通すために 3.54.1 のものにした。dev 専用）。X が F と同じ遅さなので、残りは SQLite のバージョンでは説明できない。
3. **有力な原因は、bundled のビルド flag の差**：libsqlite3-sys 0.39.1 の `build.rs` は `-DSQLITE_ENABLE_MEMORY_MANAGEMENT` を渡さない（0.38.x は渡す。上の表）。この flag は pcache の mode を変える（あり：全接続で 1 つの cache を共有〔`pcache1.separateCache = 0`〕、無し：接続ごとの cache）。F と同じ source に環境変数 `LIBSQLITE3_FLAGS=-DSQLITE_ENABLE_MEMORY_MANAGEMENT` を足して build した **F3** は、R1022 で 1,245.6 ms（70 回）と、**F の 1,303〜1,311 ms から約 60 ms 戻る**（base 比 +1.5〜2.2%）。ほかの case は下の表。**ただし仕組みは特定していない**：C で同じ flag の差（3.54.1、同じ amalgamation、lookaside 0）を、同じ文の loop・接続を毎 round 開き直す形で測っても差は出ない（無しの方がわずかに速い）。差が出るのは製品の経路をそのまま回す in-process の harness だけで、**実 worker（固定 allocator）での W は未測定**なので、実 worker で同じ効果があるかは分からない。
4. **この lane の変更（hook の `&mut`、`ScopedTransaction`、`ReusedStatement` の NULL bind）の影響**：F3 が base の +1〜3% に収まる（残りは次の 5 と、小さい文の誤差）ので、この lane のコードによる遅れは大きくても 2〜3% 以下。個別の寄与の分離はしていない。
5. **`json_valid` の繰り返しが残る per-Revision の文**：`nir1_graph/input.rs` の `COUNT_SQL`（4 回）と `nir1_entity_relation_index.rs` の `input_counts`（同形、4 回）は Revision ごとに実行される。C の再現（3.53.2 → 3.54.1、1 回あたり）で `COUNT_SQL` が R1022 17.5 → 20.5 µs・D2064 19.1 → 22.6 µs、`input_counts` が 23.4 → 28.2 µs・25.2 → 31.0 µs。1 回の registration で R1022 は約 +8 ms、D2064 は約 +19 ms（W の 0.7〜1.8%）。`scene_scope.rs` ほかにも同じ形の文があるが、Revision の payload より小さい binding の JSON なので別に数えていない。**書き直しはしていない**：`WHERE revision.id = ?1` の 1 行を `json_valid` の評価回数だけのために CTE にすると、「admission の前に JSON の演算をしない」「payload を読むのは subject の Revision だけ」の 2 つの既存の約束を文ごとに確かめ直す必要があり、見込みの回収が W の 1〜2% に届かないため。

**W の取り直し**（in-process の DR-GRW-3 と同じ harness、lookaside 0、各 run 20 回、base と head を case ごとに交互、各 run の開始時に loadavg の 1 分値が 3 未満になるまで最大 20 分待つ〔今回は待ちが生じず、51 run すべて quiet〕。base は master `a067f7f7`、head は `a464d99f`〔DUPLICATE と MALFORMED の書き直しを含む〕。F3 は head に `LIBSQLITE3_FLAGS` を足した参考腕。binary の sha256：base `77e10e08…`、head `92662007…`、F3 `76a7bf67…`、X `1897cdbf…`。run は新しい directory に記録）：

    case                 base      head      head/base     head＋MM（F3）  F3/base   quiet run（base／head／F3）
    Q2044/R4             303.2     308.7     +1.8%（前は +4.4%）   305.8    +0.9%     5／5／3
    Q8176/R16            1228.7    1255.2    +2.2%（前は +4.5%）   1246.3   +1.4%     5／5／3
    Q2044/R1022          1226.6    1311.3    +6.9%（前は +6.7%）   1245.6   +1.5%     5／5／5（F3 は 70 回）
    D2064/report-heavy   1032.7    1110.7    +7.6%（前は +7.7%）   1066.3   +3.3%     5／5／3

各 run の p50 の範囲は、R4 と R16 では base と head が一部重なる（R4：base 299〜309、head 304〜310。R16：base 1217〜1243、head 1249〜1261）。R1022 と D2064 は重ならない（R1022：base 1220〜1237、head 1301〜1319。D2064：base 1021〜1050、head 1105〜1120）。

**結論と残る問題**：R4／R16 の遅れは +4.4／+4.5% から +1.8／+2.2% になった（MALFORMED の書き直しと DUPLICATE の分）。R1022／D2064 の +7% は MALFORMED の書き直しでは動かず、**4〜5 ポイントは libsqlite3-sys 0.39 が `SQLITE_ENABLE_MEMORY_MANAGEMENT` を外したこと**に当たる見込み。戻すなら `LIBSQLITE3_FLAGS=-DSQLITE_ENABLE_MEMORY_MANAGEMENT`（repo の `.cargo/config.toml` の `[env]`、ほか CI・Electron の native の build の環境）だが、**この lane では適用していない**：build 設定と CI・release・native build に広く効くこと、仕組みを特定していないこと、実 worker で効くかを確かめていないことが理由で、別の判断（と実 worker での W の測定）に残す。W の絶対値は最大 R1022 で約 1.3 s で、30 s の START_TIMEOUT に対する余裕（23 倍以上）には影響しない。

### 独立レビュー（Opus、read-only、範囲 `a067f7f7..fc5d276f`）への対応（2026-11-13〜14）

P1 は 0 件。直したものと判断は次のとおり。

1. **P3-1（メモリ安全。hook の登録の失敗で解放済みの closure を指す hook が残る）**：直した（`c59df9d1`、補足 `22770e03`）。
   - `hook_registration` の wrapper（authorizer／progress／commit）を通す形にした。production の登録は、すべてこの wrapper を通す。
   - 登録の前に、hook を入れない preset で clientdata の entry を先に作る。以後の登録は既存 entry の置換だけになり、malloc しない。
   - 登録が Err のときは、同じ種類の hook を外してから返す。
   - progress は、None で外さずに interval 0 の no-op にして、entry を残す。entry が無いとき（生の FFI で入れた診断の meter）は、生の `sqlite3_progress_handler(db, 0, None, null)` で外す。
   - 試験：`tests/hook_registration_nomem.rs` が `sqlite3_hard_heap_limit64` で割当てを拒否し、次を確かめる。
     - rusqlite 単体では、3 種とも Err の後に hook が残ること（前提）。
     - wrapper では残らないこと。
     - 生の FFI の handler も外れること。
   - `hook_registration_sources_tests` は、production のコードが wrapper の外で hook を登録しないことを source で縛る。
2. **P2-1（3.54 の reprepare-on-bind が steps を余分に課金する）**：測った（`f5795d10` の `reprepare_cost_tests`）。
   - capacity scope の下で動く 2 文（`resolve_scene_body`、snapshot の run）は、unique key の lookup で planner を通らない。そのため reprepare は 0 step で、stat4 があってもなくても同じだった。
   - 毎回作り直して約 11 step を払うのは `matching_field_paths` だけで、これは capacity の attempt の外（Application の contribution の reader）にある。
   - **判断**：上限への影響は無いので、受け入れる。`prepare_cached` の使い方は変えない。
3. **P2-2（残る時間の遅れ）**：
   - MEMORY_MANAGEMENT の flag を戻した（`172e0ca7`、上の「W の遅れの残りの切り分け」の F3 の build と同じ設定）。
   - その後の W は、base 比で次のとおり（in-process、quiet の run、各腕 3〜5）。
     - R4：+0.9%
     - R16：+1.4%
     - R1022：+1.5%
     - D2064：+3.3%
   - **判断**：受け入れて merge する。理由は 3 つ。
     - 遅れは最大 +3.3%（D2064 で約 34 ms）。
     - registration の START_TIMEOUT 30 s に対して、in-process の W は最大約 1.3 s で、余裕が 23 倍以上ある。
     - 残りは SQLite 3.54 への更新（セキュリティの修正）に伴うもので、取り除く手が見つかっていない。
   - 実 worker（固定 allocator）での W は測っていない。
4. **P3-2〜8**：
   - `verify_coverage` は、statement を block に閉じて行ごとに `check_control` を挟む旧の形に戻した（先集めをやめた）。
   - wal／trace_v2 の記述、`check_owned()` の説明、README と continuation の記述を、事実に合わせた。
   - 600,000 steps の較正の 1 step の差は、opcode 単位の課金なので過少課金ではない。
   - FTS5＋WAL の COMMIT の順の試験（`audited_commit_callback_order_holds_with_fts5_and_wal`）を足した。
   - NULL の bind が、上書きされる値が整数 0／1 のときに失効させる点をコメントにした。
5. **P3-9（commit の trailer）**：枝の commit の trailer を Opus 5.5 にそろえた（Sonnet 5.5 は 0 件）。

`cargo audit`：
- 例外を外した両方の lock で、RUSTSEC-2026-0459 は解消している（libsqlite3-sys 0.39.1）。
- 別に出た RUSTSEC-2026-0538（quinn-udp）は、master への別の PR（#883）で直す。

### harness の接続の検査（2026-11-14、ユーザー決定）

- 0.41 で `workspace.rs` の audit hook の登録が `with_conn_mut` になり、`scripts/quality/nir1-packing/final-request/architecture.mjs` の「`with_conn` は 1 回だけ」の検査がそれを数えなくなった（数は 0）。
- 検査器を直すと CP-4 の S4 の bytes pin（`dp-h-unknown-scope`）が外れ、pin の表は凍結済みの `evals/nir1-graph/observation-prep.v1.json` と一致する必要があるため、直すには S4 の再凍結が要る。
- ユーザーの選択で、検査器は今は変えず、`architecture.test.mjs` の「2 回以上」の確認を `with_conn` 2 つの追加で行う形にした。**次の S4 まで、harness が `with_conn_mut` を 2 回以上使っても検査は気づかない**（品質規則の一時的な緩和）。検査器の直し（`/\.with_conn(?:_mut)?\(/`）は次の S4 の枝で入れる。

## DR-DBC-6 WAL の restart の先払いを背景のスレッドが本体の接続の上で行う（DR-DBC-1 の改訂。2026-11-15）

枝 `claude/wal-restart-prepay`（基点 `origin/master` の `14cc0b68`）。設計の草案と dev の測定は `fusion-eval-data/cp4-dev-latency-ratio-2026-11-15/`（`prepay-design.md`、`prepay-review-opus.md`、`prepay-ab/`）。この節は、その草案を実装の結果に合わせて書き直したもの（草案の B.4・B.6 の誤りは「草案からの訂正」に挙げた）。

**番号について**：`origin/master` の最大は DR-DBC-5。docs 全体の grep で DR-DBC-6 の既存の使用は無い（2026-11-15 確認）。

### 承認と範囲

- ユーザーが 2026-11-15 に DR-DBC-1 の改訂を承認した（AskUserQuestion「認める。形は任せる」）。改訂の中身：「背景の checkpoint は何も commit しない」→「背景は PASSIVE が全部書き戻した後、**主接続で**同値の `application_id` を 1 回 commit して、次の前景の commit が払っていた WAL header の fsync を先に払う」。形（所有・取得・試験）は実装に任された。この lane は NIR-1 の事前委任の外の DB 接続の lane で、事前委任を根拠にしない。
- 根拠：CP-4 の Graph arm の p95 の外れ値（75 ms 以上、1 run 約 2 件）の調査。回転 HDD で、背景の PASSIVE が WAL を全部書き戻した後の最初の書き手の commit が、WAL を先頭から書き直し（restart）、WAL header の書込みと fsync（約 45 ms）を払う。dev の A/B（HDD、各 3 run）で、p95 の外れ値の件数は 2.00 件/run → 0 件/run、graph の p95 は 78.0 → 52.8 ms だった（`prepay-ab/results.txt`。**dev の一時 DB。製品の gate の測定ではない**）。
- 範囲：`grimodex-db` の `background_checkpoint.rs`、主接続の所有（`Database.conn` ほかを `ConnectionCore` へ）、`with_busy_timeout` の分離。renderer・IPC・preload・N-API・MCP・schema・migration は変えない。`SCHEMA_VERSION` は上げない。
- **信頼境界は変えない**：actor（Electron main の native が信頼、renderer・他の process は信頼しない）、受信先・送信先、保存範囲（新しい情報を保存しない。`application_id` は既存の header の欄に同じ値を書き直すだけで、一時的に WAL に 1 frame が増え、次の checkpoint で消える）、secret、閾値（`WAL_CHECKPOINT_PAGES`＝1000、`MAX_WAL_PAGES_BEFORE_SYNC`＝4000）は不変。変わるのは「背景のスレッドが、先払いの間だけ主接続を書込みに使う」点だけで、その書込みは renderer から到達できず、SQL を受けない固定の文字列（`BEGIN IMMEDIATE; PRAGMA application_id=<現在値>; COMMIT`）。耐久性の防御（WAL header の fsync、`synchronous=NORMAL`）は弱めない（先払いがそれを払う）。

### 判断

1. **先払い**：背景のスレッドは、run の PASSIVE が `busy==0 && checkpointed==log && log>0` で終わったときだけ、**`running=false` にした後**で、主接続の上で `BEGIN IMMEDIATE; PRAGMA application_id=<現在値>; COMMIT` を 1 回行う（run につき最大 1 回。`running=false` の後なので、先払いの commit が呼ぶ wal hook が `enter_sync` で自分の run を待つことは構造的に起きない）。同値でも `PRAGMA application_id` は page 1 を dirty にし、1 frame の commit になる（SQLite 3.54.1 の `OP_SetCookie`）。`application_id` は repo のどこも読まない（grep 済み）。`user_version` は migration と `ReadIdentity` が読む authority なので使わない。
2. **取得は既存の関数だけ**：`ConnectionCore` の `try_lock_conn_with_check`（DR-MPS-15 の waiter なしの 1 回の取得。health・poison・foreground の waiter・finalization の予約・maintenance の no-wait を既存の規則で見る）を再実装せず使う。待つ `lock()` は使わない（hook の `enter_sync` との相互待ちと、前景を待たせる経路を作らない）。取れなければ何もしない（現状と同じく次の書き手が払う）。`check` に「停止の要求・`mode≠Running`・maintenance の no-wait guard の生存・foreground の waiter」を入れ、Mutex の取得の前後の両方で確かめる（判断 9）。
3. **`busy_timeout` は 0**：別 process の書き手を Mutex の下で待たない。設定と復元は、`with_busy_timeout` を「取得済みの接続を受け取る内側の関数 `with_busy_timeout_on`」と薄い wrapper に分け、先払いは内側を使う（`with_busy_timeout` は `lock_conn()`＝待つ lock と waiter の announce をするので、そのままは使えない）。**復元の失敗は既存の規則（接続の quarantine）に従う**。
4. **所有**：主接続・foreground の待ち・finalization の予約・健全性（`ConnectionHealth`）・退役した接続を `Arc<ConnectionCore>` にまとめた。`Database` は `core` を持ち、`Deref<Target=ConnectionCore>` で見せる（`db.conn`・`db.lock_conn()` などの呼び出しは変わらない）。取得関数（`lock_conn`・`lock_conn_with_check`・`try_lock_conn_with_check`）・`ensure_connection_reusable`・`quarantine_connection`・`with_busy_timeout_on` は core の method。背景のスレッドは `Weak<ConnectionCore>` だけを持ち、先払いの間だけ upgrade し、Mutex の guard と `Arc` は run の中で必ず放す。`Database` は持たない（`wait_for_sole_owner` の数に入らない）。`from_connection`（standalone MCP）は背景を始めず、挙動は変わらない。
5. **Drop・stop（Opus の必須 1）**：`Database::drop` は、背景を止めた後（slot の guard を放してから）、`stop` が `TimedOut` であっても、Mutex の下で `mem::replace` により実接続を取り出して**自分で close する**（`retire_connection_for_recovery` と同じ形）。スレッドが upgrade した `Arc` を持ったまま残っても、drop が戻った時点で主接続の close と `-wal`／`-shm` の削除が済む（open の quiesce・restore が drop の後に同じ file を扱う前提を保つ）。差し替えた後に先払いが Mutex を取れても、停止の要求を**取得の後**に確かめるので書かない（念のため drop は接続を quarantine する）。先払いは Mutex を `try_lock` でだけ取るので、drop の `lock()` と互いに待つことは無い（先払いが fsync の最中なら、その 1 回が終わるまで drop が待つ）。背景を始めていない接続には何もしない。
6. **wal hook の再入（Opus の他）**：先払いの commit も wal hook を呼ぶ。thread-local の旗（RAII の `PrepayScope`。この thread が先払いの commit の中にいる間だけ）で、hook は page 数を記録するだけにする（`request()`・`enter_sync`・同期の checkpoint をしない）。別の thread の commit には影響しない。読み手が WAL の先頭へ戻るのを止めていると、先払いは restart せず frame を 1 つ足す（page 数 N+1 が閾値以上になりうる）が、それで run が連鎖せず、4000 page 超でも自分の run や Mutex を待たない。
7. **成否を数える**：stats に `prepay_restarted`（commit 後の WAL が 1 frame）・`prepay_not_restarted`（commit したが、commit 後の WAL が 1 frame でなかった。読み手が restart を止めていた場合のほか、PASSIVE の後に前景の書き手が先に commit して restart を払った場合も含む。commit 後の page 数だけでは 2 つを確実には区別できないので区別しない）・`prepay_skipped`（条件を満たさない・取れない・停止の途中・先払いの無効化）・`prepay_failed`（commit の失敗）。**失敗・飛ばしは `consecutive_failures` に数えない**（先払いは最善努力で、無くても現状に戻るだけ。背景を止めて同期の checkpoint に戻す理由にしない）。panic は、主接続を quarantine する（maintenance の panic と同じ規則）。`running=false` の後、`Control::prepaying` を run の結果の集計が終わるまで立て、`wait_idle` が先払いの前に戻らないようにする（`runs` は先払いの集計の後に進む）。
8. **別の接続・`synchronous=OFF` では先払いしない**：別の接続の commit は、前景の deferred transaction（`BEGIN; SELECT; INSERT`。`domain_writes.rs`・`agent_writes.rs` ほか多数）を、commit の窓の中でどの開始時刻でも 0.1〜0.8 ms で `SQLITE_BUSY_SNAPSHOT` により失敗させた（dev の micro `prepay3`）。`synchronous=OFF` は WAL header の fsync を飛ばす（`syncHeader`＝restart の後の順序外の書込みによる破損への防御）ので、耐久性の防御の弱化として却下。
9. **maintenance に譲る（Opus の受入れレビューの必須 1。2026-11-15）**：maintenance の cycle は `enter_maintenance_connection_no_wait` の guard で cycle 全体を覆う（`grimodex-node` の `lib.rs` の maintenance cycle）。先払いが握っている間にその cycle の取得が当たると、cycle の途中で `NEX_MAINTENANCE_CONNECTION_PREEMPTED`、Run は cancelled で DR-MP-8 の backoff に積まれる。窓が来るのは 1000 page 超の commit の後の run の直後で、そのような commit の主は maintenance 自身（IR の publish・backfill）。そこで `ConnectionCore::maintenance_no_wait_guards`（`Arc<AtomicUsize>`）に、生きている guard の数を持つ。guard の生成で増え、drop で減る（RAII。guard の thread-local とは別に、thread をまたいで数える。先払いは別の thread なので thread-local は見えない）。先払いは、upgrade の後の入口と、`try_lock_conn_with_check` の check（Mutex の取得の前後）で数が 0 でないことを確かめ、0 でなければ `Skipped`（理由 `maintenance-active`）で飛ばす。他の no-wait／try の scope の扱い：(a) `with_background_connection_priority`（semantic runtime・freshness の bulk）は待つ取得で、foreground の waiter に譲るだけなので、先払いに当たっても 1 回ぶん待って成功する。失敗しないので対象外。(b) cycle の外の短い no-wait（nir1 store の `ConnectionBusy`・C-query の freshness の stamp `None`・`try_lock_narrative_maintenance` の `Ok(None)`）は cycle を覆わず、当たっても既存の busy の経路で fail-closed なので対象外。(c) finalization の予約（`maintenance_finalization_reserved`）は `try_lock_conn_with_check` が既に見る。残る窓は、guard が入る直前に先払いが取得を終えていた場合（guard の無い瞬間に先払いが握った場合。判断 2 の check の後の確認で、取得の後に入った guard には譲る）だけで、その間は no-wait の取得が従来どおり PREEMPTED を返す（試験 `callers_that_do_not_wait_yield_while_a_prepay_holds_the_connection`）。

### 契約の改訂（DR-DBC-1 の記述）

- 旧：背景は何も commit しない。本体の `data_version`・`total_changes`・schema_version は動かない。
- 新：専用の checkpoint 接続は何も commit しない。PASSIVE が全部書き戻した run の直後に、背景のスレッドが本体の接続の上で同値の `application_id` を 1 回 commit する。**本体の接続の `PRAGMA data_version`・`total_changes`・schema_version・user_version・clock の seq（trigger が無い）・`ReadIdentity`（lineage・seq・schema_version・user_version）は動かない**（`a_prepay_changes_no_value_and_no_counter_of_the_main_connection`）。**別の接続（Graph worker の reader・probe・MCP・harness の観測者）から見た `PRAGMA data_version` は 1 回につき 1 つ動く**（陽性の対照も同じ試験）。`SQLITE_FCNTL_DATA_VERSION`（`nir1_pinned_snapshot` の pin の鍵）は、**自分の commit でも動く**。pin は、その接続が read snapshot を持つ間（read transaction の中）だけ答える（`current_pin`）。先払いは主接続が autocommit のときしか commit しないので、本体の接続の read snapshot の最中には書かない。別の接続の値は read transaction の中では動かない（SQLite の性質）。pin を開く呼び手（Graph の registration／query の scope。`nir1_graph.rs`）を全数は確かめていないが、どの接続の上で開いても上の 2 点が成り立つので、結論は呼び手に依らない。

### 草案からの訂正

- 草案 B.6「`InterruptHandle` は先払いの間も登録したまま」は誤り：run の `InterruptHandle` は PASSIVE の後に外す。**interrupt は主接続に届かない**。主接続の commit（fsync）は中断できず、停止の上限は `STOP_WAIT`（5 s）のまま。
- 草案 B.6「`TimedOut` のとき、スレッドが最後の `Arc` を落として接続を閉じる」は、drop の後に主接続の close が遅れる問題を持つ（Opus の必須 1）。判断 5 で、drop が自分で閉じる形に変えた。
- 草案 B.4「`nir1_pinned_snapshot` は主接続の自分の commit では動かない」は誤り（上記）。
- 草案の状態「確認待ち」は、2026-11-15 のユーザーの承認で解消した。

### owner／lifecycle matrix の差分（GDX-PRECHECK-001。DR-DBC-1 の §3 に対する差分）

| 区分 | 変更 |
|---|---|
| entry／start | 変更なし。スレッドが `Weak<ConnectionCore>` を受け取る（`from_connection` では背景は始まらない） |
| pending start | 変更なし。先払いは `pending` を立ても消しもしない（run の間に hook が立てた `pending` は、先払いの後に次の run を起こす） |
| retry／reentrant | 先払いは run の最後の 1 回。連続 2 回の run は 100 ms 以上あくので先払いも同じ。先払いの commit の hook は記録だけで run を起こさない（試験で固定） |
| admission closure | 停止の要求の後は先払いを始めず、Mutex を取った後にもう一度確かめる。`mode≠Running` も同じ |
| active handle ownership | 先払いの間だけ、スレッドが主接続の Mutex の guard と upgrade した `Arc` を持つ。run の中で必ず放す。drop は `TimedOut` でも主接続を自分で close する |
| cancellation | 専用の接続の interrupt は先払いに届かない。先払いの前後と Mutex の取得の後に停止を確かめる。fsync は中断できない |
| bounded wait | 先払いは待たない（`try_lock`）。停止・drop は先払いの commit（fsync）1 回ぶん待ちうる（回転 HDD で約 45 ms、SSD で約 1 ms。待ちの上限 `STOP_WAIT`＝5 s は変えない）。over-limit の hook の `enter_sync`（5 s）は先払いの間は入らない |
| termination evidence | 変更なし（`exited`＋join） |
| error／timeout | 先払いの失敗は `consecutive_failures` に数えない。`busy_timeout` の復元の失敗・commit 後に autocommit に戻らない・panic は接続を quarantine する |
| persisted restart state | なし。`application_id` は同値 |
| PASSIVE と先払いの間の停止 | 先払いを飛ばして run を終える（WAL は restart 保留のまま。現状どおり）。停止の確認は、upgrade の後・Mutex の取得の前後で行う。入口の確認は `a_stop_that_arrives_before_the_prepay_takes_the_connection_skips_it`、取得の後の確認は注入点 `PREPAY_HOLD_AFTER_LOCK` で `a_stop_that_arrives_after_the_prepay_took_the_connection_skips_it` が別に固定する（取得の後の確認を外すと落ちることを変異で確かめた） |
| maintenance の cycle との順序 | maintenance の no-wait guard が生きている間は、先払いは取得の前後で確かめて飛ばす（判断 9。`a_prepay_yields_while_a_maintenance_no_wait_guard_is_alive`、`a_maintenance_guard_that_enters_after_the_prepay_took_the_connection_makes_it_yield`） |
| 同期の fallback との順序 | 背景が使えない間・over-limit の hook の同期の PASSIVE は、前景の commit の中（主接続の Mutex を握ったまま）で走る。そのとき先払いの `try_lock` は失敗して飛ばす。同期の PASSIVE の間は `sync_active` で背景の run が始まらない。先払いは行わず、次の書き手が払う（現状どおり） |

### 危険（残るもの）と対処

| 危険 | 内容 | 対処・状態 |
|---|---|---|
| 前景が窓に当たる | 先払いの窓（HDD で約 45 ms。SSD は約 1 ms）に到着した前景の操作（読みも）が Mutex で待つ。現状は書き手の最初の 1 回が必ず払う | `try_lock`（前景が先ならやらない）。**製品の gate の A/B（`lock_conn` の待ち分布）は未測定**。dev の A/B では前景の fetch が窓に重なった例は 0 件、次の fetch は窓の約 1 s 後だった |
| 窓の中の no-wait の呼び手（Opus の必須 3。判断 9 で guard の生きている間は先払いが譲る） | **guard の無い瞬間に先払いが握った場合に限り**、窓の中で no-wait の取得が当たると、呼び手ごとに結果が違う。(1) `lock_conn` の no-wait mode（maintenance の phase の取得・discovery）は `NEX_MAINTENANCE_CONNECTION_PREEMPTED` を返す。Run は**失敗でなく cancelled**（`cancel_maintenance_run_for_preemption_in_tx`。crash の retry 予算を消費せず、同じ WorkKey が次の durable wake で新しい Run として requeue される）。discovery の 2 か所（`maintenance_runtime.rs`）は PREEMPTED で bail する。(2) `try_lock_narrative_maintenance` の入口は `Ok(None)`（Deferred）で、Run を cancel しない。(3) nir1 store は `ConnectionBusy`、(4) C-query の freshness stamp（`try_read_c_query_freshness_stamp`）は `None`。いずれも既存の「busy」の経路で、失敗の方向は fail-closed（古いものを新しいと誤らない） | 試験 `callers_that_do_not_wait_yield_while_a_prepay_holds_the_connection`（(1) の PREEMPTED・waiter なしの取得が busy・blocking の呼び手が待って成功）。**窓は無作為に来ない**：1000 page 以上の commit の後の run の直後に来る。大きい commit を続けるのは maintenance 自身（IR の publish・backfill）なので、cycle の間の no-wait 取得と重なりやすい相関があった。**判断 9 で、cycle 全体を覆う guard が生きている間は先払いが走らない**ので、その相関による PREEMPTED は構造的に出ない。残る窓は guard の無い瞬間（cycle の外）だけ。dev の A/B（g06）は maintenance を走らせていないので、**製品の経路での PREEMPTED の件数と DR-MP-8 の backoff への影響は未測定**（guard の外の窓の頻度は低いと言える根拠は無い）。dev の A/B に maintenance を走らせる条件を入れる |
| 読み手が restart を止める | 最新の frame を slot 1 以上で持つ読み手がいると、先払いは restart せず frame を 1 つ足す。前景の commit も append になるので払いは増えない | 判断 6。`not_restarted` として数える。連鎖しない・4000 page 超でも待たない（試験 2 本） |
| disk が止まる | fsync が止まると先払いの間 Mutex を握る（現状は前景の書き手自身が止まる）。読みも止まる。drop も 1 回ぶん待ちうる | `STOP_WAIT` は変えない。異常のときの測定は未実施 |
| 契約の逆戻り | 「背景は何も commit しない」を前提にした将来の変更 | この節・DR-DBC-1 の記述・module の doc・試験を同時に直した |
| 他の OS・FS | 測ったのは Linux ext4 の回転 HDD と tmpfs だけ。macOS／Windows の sync の実装での時間は未測定 | 挙動（restart を先に済ませる）は同じ。時間の効果は未確認 |
| 失われる性質 | `data_version` を「別の接続が commit したときだけ動く」物差しとして使う harness の記録（`scripts/quality/nir1-graph-eval/` の `sampleCommitRate`・`commitBetweenReadyAndQuery` ほか）に、checkpoint の後の 1 回／run の commit が「あった」と数えられる | 記録（disclosure）だけで gate は無い。**CP-4 の判定（contracts 側）がこの旗を読むかは、凍結物を読まないので未確認**。8 回目の S4 の候補に入れるときに確かめる |

### 試験

`background_checkpoint_tests.rs`（grimodex-db の lib）：

- 書き換え：`a_large_commit_is_written_back_and_restarted_by_the_background_thread`（`-wal` の header の通番と salt で、restart を背景が済ませたことを決定的に確認。WAL は 1 frame・書戻し 0）、`checkpoint_does_not_move_the_write_clock_or_read_identity`（既存。本体の接続が Mutex を握ったまま run を待つ箇所は、先払いが `try_lock` で飛ばすので通る）。
- 新規：`the_next_foreground_commit_does_not_restart_the_wal_after_a_prepay`（前景の commit は header を書き直さない。先払いを止めた対照では書き直す）、`a_prepay_changes_no_value_and_no_counter_of_the_main_connection`（不変条件と、別の接続の `data_version` が動く陽性の対照）、`a_prepay_never_fails_a_foreground_deferred_transaction`（先払いが何度も走る間、前景の `BEGIN; SELECT; INSERT; COMMIT` が 400 回 0 件失敗）、`a_prepay_is_skipped_unless_it_can_be_made_without_waiting`（explicit transaction・Mutex を前景が握っている・foreground の waiter・古い snapshot の読み手・先払いの無効化）、`a_failed_prepay_is_not_a_checkpoint_failure_and_restores_the_busy_timeout`（別の接続が書込みの lock を持つ間、5 回失敗しても背景は Running、`busy_timeout` は元の値）、`a_prepay_that_cannot_restart_does_not_chain_runs`、`a_prepay_over_the_hard_limit_never_waits_while_holding_the_connection`、`callers_that_do_not_wait_yield_while_a_prepay_holds_the_connection`、`a_stop_that_arrives_before_the_prepay_takes_the_connection_skips_it`、`drop_closes_the_main_connection_even_when_the_stop_times_out`（drop が戻った時点で `-wal` が消え、スレッドは生きたまま、解放後は何も書かない）、`an_adopted_connection_has_no_background_and_no_prepay`。Opus の受入れレビューの後に追加：`a_prepay_yields_while_a_maintenance_no_wait_guard_is_alive`（guard の生きている間は先払いが飛ばし〔入れ子の guard は 1 つ drop しただけでは譲り続ける〕、全部 drop した後に先払いが行われる）、`a_maintenance_guard_that_enters_after_the_prepay_took_the_connection_makes_it_yield`（Mutex を取った後に guard が入っても、取得の後の確認で譲り、何も commit せず Mutex を放す）、`a_stop_that_arrives_after_the_prepay_took_the_connection_skips_it`（取得の後の停止の確認。入口の確認では捕まらない位置）。`a_prepay_never_fails_a_foreground_deferred_transaction` は、writer の join の後に `run_and_settle` を 1 回足し、先払いが 1 回起きたことの判定を決定的にした（writer の間に先払いが起きたかは確率的だった）。
- 変異の確認：drop の close と hook の thread-local の旗を無効にすると、drop の試験・連鎖の試験・over-limit の試験が落ちる（この試験が検出できることを確かめた）。取得の後の確認（`PREPAY_HOLD_AFTER_LOCK` の位置の check の中身）を外すと、`a_stop_that_arrives_after_…` と `a_maintenance_guard_that_enters_after_…` が落ち、guard の生存の判定を常に偽にすると、`a_prepay_yields_while_a_maintenance_no_wait_guard_is_alive` と後者が落ちる（2026-11-15、変異は戻した）。
- 実装で分かったこと：4000 page 超の試験は、「全部書き戻された後に始まる読み手は slot 0 を使い、restart を止めない」ため、古い snapshot の読み手 A を挟んで同期の checkpoint が全部を書き戻せないようにし、その後に最新の読み手 B を始めて A を放す形にした。

### Opus の受入れレビュー（f90d0215..d48df07a。2026-11-15、read-only）の要点と対処

結論：条件付きで merge 可。正しさの破綻（データ・lifecycle・lock 順）は無し。記録は `fusion-eval-data/cp4-dev-latency-ratio-2026-11-15/prepay-impl-review-opus.md`。

| 指摘 | 対処 |
|---|---|
| 中〜高（merge 前）：先払いが maintenance の no-wait guard の cycle に譲らず、cycle の途中で PREEMPTED、Run cancelled、DR-MP-8 の backoff に積まれる | 判断 9：guard の生きている数を `ConnectionCore` に持ち、0 でない間は先払いを飛ばす（理由 `maintenance-active`）。試験 2 本を追加し、既存の窓の試験は「guard が無い瞬間に握った場合」に限る形に直した |
| 低：`prepay_not_restarted` が「前景が先に restart を払った」場合も数える | page 数だけでは確実に区別できないので、stats・module doc・判断 7 の説明を正確に直した（区別しない） |
| 低：取得の後の停止確認を固定する試験が無い（`BEFORE_LOCK` の試験は入口の確認に捕まる）。doc と matrix の記述が過大 | 注入点 `PREPAY_HOLD_AFTER_LOCK` を足し、取得の後の確認を別の試験で固定した（変異で確かめた）。matrix の記述を実際に合わせた |
| 低（flake）：`a_prepay_never_fails_a_foreground_deferred_transaction` の最後の判定が確率的 | writer の join の後に `run_and_settle` を 1 回足した |
| 低（doc）：「停止の上限…約 45 ms」が `STOP_WAIT`＝5 s と紛らわしい。判断 2 の method の所属 | 「停止は先払いの 1 回〔HDD で約 45 ms〕が終わるまで待ちうる。待ちの上限は `STOP_WAIT` のまま」に直した。判断 2 は `ConnectionCore` の method に直した |
| 情報：別 process の書き手は前景の commit から既に同じ `BUSY_SNAPSHOT` を受ける | 下の「逆向きの危険」に記した |
| 情報：drop で `open_in_memory` が失敗したときの後退、panic で ROLLBACK しない、`catch_unwind` の外の panic で poison | 記録のみ（挙動は変えない。panic は接続を quarantine する規則のまま） |

### 逆向きの危険：別 process の書き手

先払いを「別の接続で行うと前景の deferred transaction が `SQLITE_BUSY_SNAPSHOT` で失敗する」ことを判断 8 の根拠にしたが、逆に、**別の process の書き手（standalone MCP など）は、前景の commit から既に同じ `BUSY_SNAPSHOT` を受けうる**。先払いは本体の接続の上の commit なので、別 process から見れば前景の commit と同じ種類の書込みで、その回数を 1 回／run だけ増やす（新しい失敗の種類は作らない。別 process の deferred transaction が失敗する窓が増えるだけ）。先払いは `busy_timeout` 0 で、別 process が書込みの lock を持つ間は失敗して飛ばす（`prepay_failed`、`consecutive_failures` に数えない）。この頻度の増加は測っていない。

### dev の A/B の結果（g06。dev の一時 DB。製品の gate の測定ではない）

- 置き場：`fusion-eval-data/cp4-dev-latency-ratio-2026-11-15/prepay-impl-ab/results.txt`。M＝master `14cc0b68`（計装のみ）、P＝本枝 `d48df07a`（計装＋先払いの log）、回転 HDD、同じ cold setup、順序 p1 m1 p2 m2 p3。
- 結果（graph arm、g06 の base k64）：p95 の外れ値（75 ms 以上）の命中 5/60 → 0/90、graph の p95 84.0 → 54.1 ms（p99 88.2 → 61.7 ms）、unavailable 0 対 0、failed 0。先払いは 18 回（restarted 10、not_restarted 7、skipped 1〔connection-busy〕）、Mutex を握った窓は約 42 ms（1 回だけ 64 ms）で、前景の fetch が窓に重なった例は 0 件。
- 制約：**この測定 session には maintenance が無かった**（g06）。したがって、判断 9 の対象（maintenance の cycle との重なり）は測っていない。g03（setup に maintenance を含む）の `measure-DB runs` には両 arm とも PREEMPTED があるが、PREEMPTED の件数を M と P で比べる設計ではなく、先払いの効果と読めない。判断 9 の後の本枝の実装での A/B は、次の測定（maintenance を走らせる条件を入れる）。

### 未確認・未実施

- 製品の gate の A/B（`lock_conn` の待ち分布、製品の経路での PREEMPTED の件数、DR-MP-8 の backoff への影響、前景の読みの p99）。dev の A/B に maintenance を走らせる条件（g06 は無し）を入れた測定。
- CP-4 の判定が `commitBetweenReadyAndQuery` などの旗を読むか。8 回目の S4 の候補に先払いを入れるか、候補の凍結の後に PR にするかの順序。
- macOS／Windows での時間。disk が止まる異常のときの測定。
- 先払いの retry（`try_lock` が失敗したときに数回再試行）は入れていない。`prepay_skipped` の割合を dev の A/B で見て決める。

## DR-DBC-7 段 1 の PR-3：Native の Graph owner の鮮度 stamp（S0／S1）と stamp0 を削除し、鮮度の最終判定を worker の drift 検査だけにする（2026-11-15）

状態：**K6/7 の確認済み（contracts `b9559a22`。凍結の commit。SHA-256 `7b8f81c71a2d…`。2026-11-15T14:08Z ごろの回答「承認する」）、実装中**。起案は改訂 4（選択〔contracts `5bbd6ebb`、その 1 の問い直し `f628efb2`〕、Opus の独立レビュー 1・2、(ii-b) の dev 試作〔`proto/README.md`〕を反映。mutation の前）で、起案時の「K6/7 のユーザー確認が済むまで `[precheck]` で停止する」は確認で解けた（下の「GDX-PRECHECK-001 の該当」）。基点は `origin/master` の `3948eeb2`（#909＝DR-DBC-6 を含む）。枝は S4 の枝（次の S4＝9 回目の凍結のやり直し。製品と pin 済み harness を同じ枝で変えるため、単独の merge は master を赤にする。#826 の前例）。
記法：【事実】＝その行を読んだもの（file:line。`origin/master` `3948eeb2`）、【推測】＝読みからの推論（試験・build・実機では未確認）。調査は 4 本（製品・harness・契約・検出。`fusion-eval-data/db-stage1-pr3-2026-11-15/survey-*.md`）。契約の改訂案は同じ directory の `k67-draft.md`、実装計画は `impl-plan.md`。

**番号について**：`origin/master` `3948eeb2` の docs の grep で `DR-DBC-7` の既存の使用は無い（2026-11-15 確認。DR-DBC-6 が最大）。

### 承認と範囲

- 設計の草稿：`fusion-eval-data/db-stage1-pr3-draft-2026-11-15.md`（master `14cc0b68` で読んだもの）。段 1 の設計は `design-notes/db-connection-2026-11-07/stage1-design-rev1.md`・`rev2-draft.md`。PR-1（DR-DBC-3、#847）で clock と lineage、PR-2（DR-DBC-5）で鮮度の物差しを DbClock に切り替えた。PR-3 は「親の鮮度 stamp と stamp0 を消す」段で、2026-11-07 の方針（根は 1 本の接続が排他と鮮度の物差しを兼ねること。stamp は概念ごと無くす）の実行。
- ユーザーの決定（2026-11-15。要旨は起案の指示に書かれたもの。逐語は `nir1-decisions-2026-11-15.md` と、別途記録する確認の記録に置く）：(1)「PR-3行きましょう」。(2) K6/7 は「数え方だけを統一する」（新しい閾値は置かず、全 sample を ② の項目で判定）。(3) 診断 JSON の stamp の key は消す。(4) (ii-b)〔② の結果を評価の記録に出す〕は FR-3 の書き換えと同時に行う。(5) 次の S4（9 回目）にまとめる 3 項目の 1 つとして PR-3 を扱う（凍結はそのまま、8 回目＝s7r2 は既に済み）。(6) **選択の段（2026-11-15。contracts `5bbd6ebb` の `user-confirmation-2026-11-15-k67-choices.md`。K6/7 の確認ではない）**：窓外の query の区分は、理由で決め、主な理由を過半数で決めた後で「鮮度」を「その他」と読み替える（その 1 は問い直して置き換えた。contracts `f628efb2`。緩む面なし。ただし K6/6 の畳みとの比べ方で動きうる組が 1 つ。K6/7 の開示 7 の (c)）、緩和 R-8・R-9・R-12 を承認、R-10（製品の挙動の変更）・**DR-CQD-8 の窓を「registration の preflight 以降」に狭める改訂**・FR-8 の `stale` の検査の削除を承認、(ii-b) は ②-1 と ②-2 の両方（評価 feature の Native の変更を許可）、record の `freshnessStamp` は丸ごと消す（代わりの時刻は残さない）、確認の前の dev の試作を認める（push・merge せず、判定に使わず、凍結した fixture を使わない）。
- **この lane（DB 段 1）は NIR-1 の事前委任の外**（AGENTS.md の委任は C-resource ほかのレーンに限る。DB 段 1・CP-4 は含まれない）。委任に含まれないもの：閾値の緩和（確認台帳の現行閾値と Gold の緩和・黙示変更）、新しい契約。次の 2 点は**ユーザーの個別の確認が要る**：(a) K6/7 の最終確認（合格基準の緩和 R-8・R-9・R-10・R-12 と (ii-b) の Native の変更を含む。個別の項目は (6) の選択の段で承認いただいたが、**最終確認は未了**。「PR-3行きましょう」と (2) の決定は、緩和を示した上での確認ではない）、(b) 次の S4（9 回目）の失効と新しい S4b だけを許可する手順と、R5 の照合の記録を前回のものの再利用でよいか（K6/7 の Q9。7 回目は閉包の変更ごとに個別に確認した）。技術判断（削除の順序、試験の設計、`GraphBusyCause` の整理、probe の代替）は統合者が決めてよい。
- 範囲：`grimodex-db` の `c_query_freshness.rs` の削除と `nir1_graph.rs:14` の 1 行、`electron/native/grimodex-node` の `nir1_graph_product.rs`・`nir1_graph_eval/mod.rs`・`nir1_graph_dfinal.rs` と試験 5 file、(ii-b) の ②-2 の hook のための `related_scenes/graph.rs`（feature `nir1-graph-eval` の cfg 付きの文と fn だけ。判断 10）、評価 harness（`SOURCE_PINS` に載る 21 file／8 role〔stamp を触る 10 file／7 role と、`head.k67` を足す 11 file を合わせた数〕と、pin の無い 3 file〔`quality-verdict-cli.mjs`・`test-support.mjs`・`observation-prep.mjs`〕。`impl-plan.md` §3）、契約（K6/7）、S2・作者の宣言。**変えない**：worker（別 process の read-only 接続）の drift 検査、DbClock、`ReadIdentity`、LP-GATE、DR-JF-9、`failures_before_suspend`＝5 ほか閾値、renderer・IPC・preload・N-API・MCP・schema・migration（`SCHEMA_VERSION` は上げない）、`lib.rs`・`connection_core.rs`・`background_checkpoint.rs`（#909 の所有の形。【事実】PR-3 はこの 3 file を触らず衝突しない）、`try_lock_conn_with_check`・`foreground_connection_waiters`・`maintenance_finalization_reserved`（他の消費者が使い続ける）、(a′)（drift で Suspended にしない。別 lane）。
- **信頼境界は変えない**（下の「信頼境界」）。
- **確認の結果（2026-11-15。実装の段で追記）**：K6/7（`nir1-final-request-eval-proposal-7-draft.md` 改訂 5）の最終確認はユーザーが済ませた。contracts `b9559a22`（`docs/plans/nir1-cp4-records/user-confirmation-2026-11-15-k67-graph-eval-procedure.md`、凍結の commit）。回答「承認する (Recommended)」（2026-11-15T14:08Z ごろ、AskUserQuestion）。緩和 R-8・R-9・R-10・R-12・R-13 と FR-8 の stale の検査の削除を示した上の確認。bytes の SHA-256 は `7b8f81c71a2d7edca9dbef8bdfb7c81120d3873346289b156fc92fdc1d40424d`。上の (a) の「最終確認は未了」は起案時の記述で、これにより解けた。確認の質問文（記録の「質問」）は、緩和を **5 つ**（R-8・R-9・R-10・R-12・R-13。起案の本文にある 4 つに R-13 が加わった）と検査の削除（FR-8 の stale）を示している。(ii-b)（質問の 5。評価 feature 限定の hook を `related_scenes/graph.rs` と `nir1_graph_product.rs` に入れ、許可リストに足す許可を含む）も同じ確認に含まれる。記録が「範囲に含まれないもの」と書くもの：製品の公開（`PRODUCT_GRAPH_PUBLISHED` は false のまま）と PUB-G の承認、次の S4（9 回目）の失効と再凍結の手順（Q5）、R5 の記録の再利用か取り直しか（Q9）、not-evaluable の受領書の拡張の保存範囲（Q6）、PUB-G #15（Q7）。これらは個別の確認が要る。s6r1・s7r1・s7r2 は判定に使わない。値（閾値・Gold・pool・D・T_late）は変えない。

### 判断

1. **stamp を全部消す**：admit の S0（`try_read_c_query_freshness_stamp`）、query 直前の S1（`read_stamp_for_query`）、比較（`before != after` → `Stale` で worker を retire）、診断の 4 counter（`stamp0_missing`・`stamp_fresh`・`stamp_stale`・`stamp_unavailable`）、`CQueryFreshnessStamp` の型と `c_query_freshness.rs` 全体。【事実】`CQueryFreshnessStamp`・`try_read_c_query_freshness_stamp` の外部の参照者は node crate の 3 file（`nir1_graph_product.rs:35`、`nir1_graph_eval/mod.rs:43`、`nir1_graph_dfinal_tests.rs:20`）だけ。renderer・IPC・preload・他の crate（standalone MCP を含む）は 0 件。stamp の診断が外へ出る経路は feature `nir1-graph-eval` の N-API だけで、製品の `.node` に入らない。
2. **鮮度の最終判定は worker の drift 検査だけ**（変わらない。stamp は元々「authority でない安い事前判定」〔`c_query_freshness.rs:1-2`〕）。親の stamp と worker の identity は同じ型（`ReadIdentity`＝DbClock＋main schema＋user_version）で、検出できる変更の種類は同一。
3. **(S0, registration の preflight] の commit の outcome は `Stale`→`Available` に変わる**（隠さない。検出の節の ①）。stamp が読めていた場合に、今は S1 で不一致→`Stale`（worker は query されず retire→再構築）。削除後は worker の registration が commit を取り込み `Available`。これは過剰棄却が消える方向の変更（commit の後の状態の Graph が返るので、古い Graph を返すことにはならない）。**ただし契約の文言に触れる**：【事実】held query の流れは release → LP-GATE の窓 → admit（S0）→ worker の生成 → registration → query で、LP-GATE の窓は「before the S0 stamp」（`nir1_graph_product.rs:2337-2349`）。DR-CQD-3 は release の後に owner が prepare する形。したがって ① は **release より後**で、DR-CQD-8（`cq-deferred-decisions.md:35`）「F10 は残す。release から query の終わりまでに他の commit があれば、従来どおり `stale`（stamp の不一致または worker の `registration-drift`）／`registration-unavailable` になる。D′ はそれを隠さない（試験 N1）」（備考「鮮度の判定は変えない」）の**窓の内側**にある（DR-CQD-7 も「release の後に起きる registration の拒否は F10」と書く）。PR-3 は DR-CQD-8 を次のように**狭める改訂**になる：release の後の commit のうち、registration の preflight より前（①）は `Available`（変わる）、registration 中（②）は `registration-unavailable`（変わらない）、registration の後・query の終わりまで（③）は `stale`（変わらない。worker の `registration-drift`）。「stamp の不一致」で `stale` になる経路は無くなる。試験 N1（`deferred_tests.rs:336` `n1_a_commit_after_the_release_is_still_stale`。コメント「S0 is read before the worker is created, so the edit lands after it」）と P1-1 (b)（`cq-deferred-decisions.md:184`「保留つき query 自身の stale（F10）」。試験 `p4_the_held_querys_own_stale_answer_is_not_announced` `deferred_tests.rs:253`）は、stand-in worker では prepare の間の commit が stamp で `Stale` になることに依存していた（real worker ではこの commit は ① か ② になる）。両試験は ③（registration 後・query 前の commit。`DriftWorker`）に作り直す（試験の節）。【事実】要件の本文を読んだ（`origin/master` `3948eeb2`、`docs/plans/nir1-lane-decisions/cq-deferred-decisions.md`）：DR-CQD-8（:35）の N1 は「release の後の他の commit があれば `stale`」を固定する**試験**で、P1-1（:184）は通知側の規則「保留つき query 自身の stale（F10）は通知の一覧に入れない」であり、stale が起きることを要求していない（要求は通知から除くこと）。したがって N1 は ③ に作り直し（① が `Available` になる分、窓が狭まる）、P1-1 は「stale になった保留つき query は通知しない」を ③ で保つ。:197 の既知の制約（同じ project を 2 つの表示が待ち、編集の自動保存が prepare の窓に入り続ける間、保留された側が stale になり続けて通知→再 query が往復する）は、prepare の窓の commit が ①（`Available`）になる側なので、往復の起点は減る方向（【推測】。往復の回数は未測定）。**この改訂は新しい契約・閾値ではなく、「worker の drift 検査が final authority」という既存の契約の範囲に収まる**と読むが、DR-CQD-8 の文言の変更なので、この DR で明示して supersede し、PR 本文に書く。**この改訂（DR-CQD-8 の窓を「registration の preflight 以降」に狭める）は、2026-11-15 の選択の段（contracts `5bbd6ebb` の「その 3」）でユーザーが承認済みで、この判断に含める（DR-CQD-8 の該当部分を supersede する）**。最終確認の質問文にも R-10 の一部として書く。
4. **診断 JSON の stamp の key は消す**（ユーザーの決定。(α)）。eval の JSON の `stampFresh`・`stampStale`・`stampUnavailable`・`stamp0Missing` を出さない。record の `freshnessStamp`（`ticket_fields` `eval/mod.rs:556`）は、製品が stamp を持たないので作られなくなる（**製品側の削除の帰結であって、決定の文にある範囲ではない**。全体を消すことは、選択の段〔その 5〕で「丸ごと消す」を選んでいただいた）。0 固定で残す案（β）は、「stamp が無い」ことを 0 で偽装する記録になり読み手が誤解するので採らない。harness の key の一覧の 3 file（`followup.mjs:81`・`k64-record.mjs:66`・`trace-record.mjs:71`）は同時に変える（K6/7 の変える点 5）。`attemptedAtNs` の代わりの時刻は残さない（選択済み。診断の分布 `handOverToStampMs` も無くなる）。
5. **`GraphBusyCause::StampUnreadable` を削除し、`SlotInUse` の 1 変種で残す**。【事実】使い手は `nir1_graph_dfinal.rs` と試験、reach の `outcome_label`（`reach_tests.rs:189-193`。match が exhaustive なので変種を消すと必須の直し）だけ。`StampUnreadable` は「owner の stamp counter が request の間に動いた」という**推定**で、DD-1 は元々これを reach の理由の証拠にしないと決めている（DR-DI1A-8・DR-DI1A-21、`di1a-decisions.md:33,98,106`。実測は stamp の失敗 0 件、:98）。eval の `busyCause` の語彙（`in-use`・`worker-capacity` ほか。`product.rs:1732-2071,2902`、`eval/mod.rs:553`）に stamp 由来の値は無い。enum ごと消して `busy_cause` を無くす案は、`busy_cause: None` 7 箇所と `Some(SlotInUse)` 1 箇所の書き換えが増えるので採らない。`busy_cause_of`・`stamp_misses`（`dfinal.rs:406-425`）は 2 関数削除。
6. **D-final の「主接続を握らない」試験の probe の代替（決定。実装の段の確認は置き場だけ）**。【事実】`dfinal_tests.rs:688-751` の `a5_the_main_connection_stays_free_during_the_whole_wait` と `:20,254-255,610,646,674,929` は、wait-0 の probe を `try_read_c_query_freshness_stamp(..).is_some()` で実装している。`try_lock_conn_with_check` は `pub(crate)`〔`lib.rs:565`〕、`conn` は `pub(crate)`〔`connection_core.rs:20`〕で、node crate から等価な probe は使えない。
   - **採る案：(a)**。`grimodex-db` に test 用の wait-0 probe（`try_lock_conn_with_check` を使う 1 関数。製品の呼び出し元は無い。N-API・IPC には出ない）を足す。**置き場は feature 限定にする**（既存の test 用 feature〔`workspace-maintenance-test-support`・`nir1-c-query-test-seam`。`Cargo.toml:38-42`〕のどちらかに載せ、新しい feature は足さず、製品の `.node`〔feature 無し〕に新しい public な関数を出さない）。試験の趣旨（D-final の待ちの間、主接続を握らない）を保つ。(b) `with_conn` を別 thread で呼び経過時間で見る案は、待つ型で foreground の waiter を announce するので probe が観測対象を変える。採らない。
   - **fallback：(c)**。(a) の feature 限定の置き方が node crate の試験の build に合わない場合に限り、この 1 本を「D-final が lock を握らない」構造の別の確認に置き換える。**(c) に落とす場合は、PR 本文と DR-DBC-7 に追記してから mutation する**（黙って落とさない）。
   - **証拠は 2 つある**（`di1a-decisions.md:62`「main 接続が空いていること」の行）：(1) `a5_the_main_connection_stays_free_during_the_whole_wait`（(a) の probe で保つ）、(2) 実 worker の cold／stale の到達の試験が見る「stamp と S0 の失敗 0」（`reach_tests.rs:496,537,561` の `stampMiss == false`・`s0Misses`・`stampUnavailable`）。**(2) は stamp を消すと観測対象ごと無くなり、受入れの証拠が減る**。したがって、**(a) の probe を reach の lane（実 worker の cold／stale の待ちの間）にも当てる**ことを採る（reach の試験が主接続の handle を取れない場合は、(1) だけで足りるとする理由を DR-DBC-7 に追記し、実 worker の待ちの間の「主接続を握らない」証拠が `a5` の stand-in だけになることを PR 本文に書く）。DR-DI1A-8 の受入れ証拠の変更なので、この判断を mutation の前の DR の記録として置く。
7. **stand-in worker に drift の模擬を足す**（統合者の技術判断として決定。【事実】stand-in worker は DB を読まず drift を検出しない。commit から `Stale` を作る試験が stamp に依存していた：`product_tests.rs:486`・`:1848`・`:2237`、`deferred_tests.rs:254`・`:338`、`dfinal_tests.rs:628`。`DriftWorker` だけが `drifted` を数える〔`deferred_tests.rs:804-876`〕）。**採る案：(a)** `QueryMode::Unavailable(RegistrationDrift)`（`product_tests.rs:526` が既に使う）と `DriftWorker`／`DriftFactory`（`deferred_tests.rs:795-892,948-961`）の形で「worker の drift → `Stale`→作り直し」に書き換える。dfinal の `FakeWorker` には「index 0 の worker は query が `RegistrationDrift` を返す」印を足す。(b) 試験を削除する。被覆が失われる。採らない。試験の規模は下書きより増える（【推測】）。
8. **削除の順序と不可分の単位**：node crate は試験込みで 1 commit（`GraphOwnerDiagnostics` の 4 field を消すと eval／dfinal／reach／試験 5 file が連鎖で compile error になる）。`c_query_freshness.rs` の削除は node の参照が 0 になった後。`native-architecture.mjs:260` の原文一致 snippet は製品の `serve_query` の該当行（`product.rs:2839-2843`）と**同時に**消す（「ちょうど n 回」の検査〔`native-architecture.mjs:349-355`〕と `native-architecture.test.mjs:360-365` の mutation も同時）。(ii-b) の許可リストの追加（新しい path の `SNIPPETS`・`BLOCKS` と製品の path の `SNIPPETS`。判断 10）も Rust の hook と同時。key の一覧 3 file は同時。全体は S4 の枝で `gh pr merge --merge`。
9. **docs は追記型**：CP2a-D4（`cp2a-decisions.md:21`。stamp S0／S1 の仕様）・D21（:38。counter 名）、DR-DI1A-8（`di1a-decisions.md:33,98,106`）と、同じ表の DR-DI1A-21（:36。`busy_cause` の推定）・DR-DI1A-27（:42。A-8 の記録の field）・DR-DI1A-28（:43、:79 の「stamp／S0 の失敗」列。到達率の結果）、DR-CP4-S1C1-8（`cp4-decisions.md:231`。`matched` が無くなるので (a)・規則 4 の両方）、DR-CQD-8（`cq-deferred-decisions.md:35`）、`cq-deferred-decisions.md:19,413` を、この DR が supersede する。既存の DR の本文は直さない。cp4-records（過去の run の受領書・集計・確認書。約 100 file が stamp の語を持つ）は不変の履歴で編集しない。
10. **(ii-b) の記録（評価 feature の Native の変更。選択の段〔その 4〕で ②-1・②-2 の両方を承認済み）の置き場と許可リスト**【事実。dev の試作で確かめた。`proto/README.md`・`proto/iib.diff`・`proto/native-arch-without-keys.log`・`proto/cargo-checks.log`】：記録は `nir1GraphEvalSamples` の `ticket` に `workerDrift`・`requalification` の 2 key を常に出す（未到達は null でなく `not-reached`。形は K6/7 の変える点 5）。hook は feature `nir1-graph-eval` の cfg 付きで、製品の `.node`（feature 無し）には入らない（feature 無しの `cargo check -p grimodex-node` 成功と `--lib nir1_graph_product` 113 passed・1 ignored〔`cargo-checks.log`〕）。②-1 は `nir1_graph_product.rs` の `serve_query` の `worker.query` の直後の 1 文、②-2 は owner の外の `related_scenes/graph.rs` の `await_request` の内側の 3 文（結果の確定点。`graph_response.rs` は変えない）。**`native-architecture.mjs` の許可リストに追加が要る**：新しい path `related_scenes/graph.rs` に `SNIPPETS` 3 文と `BLOCKS` の fn 3 つ、製品の path `nir1_graph_product.rs` に `SNIPPETS` 1 文（既存の accessor の block は許可済み）。許可リストの追加は Rust の hook と**同時**（追加前の許可リストに試作をかけると違反：`native-arch-without-keys.log`）。②-2 の理由は `GraphUnavailable` の粒度まで。drop の内訳まで求めるなら `graph_response.rs` にも hook が要り許可リストの新しい path が 2 つになるが、K6/7 の数え方に使わない（FR-3 の ②-2 は `passed` かどうかだけ。内訳は診断の開示で、閾値・合否に効かない）ので**今回は求めない**。信頼境界は変わらない（新しい actor・送信先・保存先は無く、記録は評価 build の JSON だけ）。製品の挙動は不変（hook は記録するだけで分岐しない。README の記載。feature 込みの全体の試験は未実行）。

### 契約の改訂

- 旧：親の Native の Graph owner は、admit と query 直前に主接続で wait-0 に鮮度の印を読み、読めて不一致なら query を投げず `Stale` を返す（CP2a-D4）。読めない場合は事前判定を省き worker に任せる。
- 新：親に鮮度の事前判定は無い。**worker の registration（preflight・pinned・postflight）と query（pinned・post-rollback）の drift 検査だけが判定する**。親の outcome（`GraphUnavailable::Stale`）と session の遷移（retire→Rebuild、quarantine なら Exit）は、drift を検出した場合は同じ（`product.rs:2898-2910,2965-2967,160-164`、`worker_frame.rs:614`）。違いは、(S0, registration の preflight] の commit で `Stale` でなく `Available` になること（判断 3）。
- 評価（CP-4）の側の契約の改訂は K6/7（`k67-draft.md`）。評価 build の JSON から stamp の key が無くなる。

### 信頼境界（新しい actor・送信先・保存範囲・閾値・契約・authority は無い）

- **actor**：変わらない（Electron main の native が信頼、renderer・他の process は信頼しない）。stamp は元々 authority でなく、削除は検査を 1 つ減らす方向で、早期の棄却だけが減る。
- **受信先・送信先**：新しい送信先・受信先は無い。secret に触れない。
- **保存範囲**：新しい情報を保存しない。stamp は永続化していない（診断 counter と評価 JSON だけ）。(ii-b) の記録は評価 build の JSON で、製品の `.node` に入らない。
- **閾値**：変えない（`failures_before_suspend`＝5 ほか）。K6/7 でも新しい閾値を置かない。
- **IPC・renderer**：`src`・`electron/shared`・`electron/main`・`electron/preload` に stamp の語は 0 件（【事実】）。変更は Native の内側と評価 build に閉じる。
- **防御**：耐久性・鮮度の防御は弱めない（worker の drift 検査が final authority。下の「検出が弱まらない根拠」）。親の wait-0 `try_lock` が 1 箇所減り、前景・maintenance との競合は減る方向。
- 委任外の点は上の「承認と範囲」のとおり（K6/7 の確認）。

### owner／lifecycle matrix の差分（GDX-PRECHECK-001。新しい thread・subprocess・背景の処理は無い）

| 区分 | 変更 |
|---|---|
| entry／start | 変更なし。`build_and_serve` が `Built::Ready` の stamp の受け渡しを持たなくなる（引数の削除。`product.rs:2289,2301-2302,2316`） |
| pending start | 変更なし |
| retry／reentrant | 変更なし。親の早期 `Stale`（unqueried retire）が無くなり、drift は worker の query 後の `Stale`（`retire_current` は `take` して `retire`〔`product.rs:2872-2874`〕）に一本化される。再構築の回数の規則（`failures_before_suspend`）は変えない |
| admission closure | `admit` が stamp を取らなくなる（戻り値の 3 要素目と `try_read…`＋`stamp0_missing` の bump の 4 行の削除。`product.rs:2650-2691`）。`edge_or_closed`・`ready_binding`・identity 比較（:2675-2678）は残る。LP-GATE の `admit_hook_for_test` は stamp の前（`:2661-2667`）なので残り、LP-GATE の試験は動く（【事実】）。【推測】LP-GATE の窓が admission の前に開く事実は変わらない |
| active handle ownership | 親が主接続の Mutex を握る箇所が 1 つ減る（stamp の `db.conn.try_lock()`。wait-0 で即放す）。worker の child・registration slot の所有は変わらない |
| cancellation | stamp の後の cancel の確認（`product.rs:2858` 以降）は無変更で繋がる。unqueried retire の quarantine の分岐（`:2850`）は消え、query 後の `quarantined()`／`retirement_quarantined`（`:2873-2875,2915`）に統合される（【事実】。この 2 つが別々の要件として検査されていたかは未確認） |
| bounded wait | worker の query が 1 回余計に走るのは、今 stamp が `Stale` を返していた場合（S0・S1 が読めて不一致）だけ。drift は q_pin の identity 読みで早期に出る（`nir1_graph.rs:1040-1043`）。親は新しく待たない |
| termination evidence | 変更なし |
| error／timeout | `StampUnreadable` を削除（推定の分類。DD-1 は元々証拠にしない）。stamp の `None` は元々 Busy にしない（DR-DI1A-8）ので利用者に見える結果は同じ |
| persisted restart state | なし |
| query 直前の identity の比較 | `read_stamp_for_query` 内の `db.identity() != binding.authority_instance`（`:2932`）が 1 つ減る。【事実】この比較は不一致のとき `None` を返すだけで `Stale` にはしない（`:2929-2936`。`None` は `stamp_unavailable` で、query はそのまま進む〔`:2844-2857`〕）。したがって**防御が減るのではなく、結果に効かない読みが 1 つ減る**。`serve_query` 冒頭の `edge_or_closed(shared, epoch)`（`:2825`）と `admit` の `ready_binding`／identity 比較（`:2675-2678`）は残る。【推測】workspace の入れ替えは epoch で捉えられる読み。**差分として明記する** |

### GDX-PRECHECK-001 の該当

- **async-lifecycle に該当**：owner の serve loop の引数（`serve_until_retired`・`serve_query`・`admit`・`Built::Ready`）と、drift の処理経路（親の早期 `Stale`→worker の query 後の `Stale`）が変わる。
- external-egress：なし。subprocess：なし（worker の subprocess は既存で、起動・停止・cutover は不変）。background：なし。security-sensitive threat model：新しい actor・攻撃面は無い（信頼境界の節）。
- **必要なユーザー確認は済んだ（2026-11-15。contracts `b9559a22`）**。起案時の記述（原文）：K6/7（`k67-draft.md`）の**最終確認**。合格基準の緩和 R-8・R-9・R-10・R-12 と (ii-b) の Native の変更の許可、窓外の query の区分の形（理由で決め、主な理由の「鮮度」を決めた後に「その他」と読み替える）を含む（個別の項目は選択の段〔contracts `5bbd6ebb`〕で承認済みだが、最終確認は未了）。次の S4 の R5 の記録の扱い（Q9）も個別の確認。AGENTS.md の GDX-PRECHECK-001 に従い、この DR と PR 本文を書いた後、**K6/7 の確認が済むまで製品・harness・契約・S2 の mutation は `[precheck]` で止める**。確認前に許されるのは、dev 専用の枝（push・merge・判定なし）での (ii-b) の試作（選択の段の「その 6」で許可済み）と、この DR・K6/7・計画の起案・独立レビューだけ。 → 確認後の扱い：K6/7 の最終確認は上のとおり済み（緩和は R-13 を加えた 5 つ。上の原文は 4 つの時点の記述）。K6/7 の範囲の実装（製品・評価 harness・(ii-b)）の mutation は進めてよいと読む。確認の記録に「mutation を許す」旨の文言は無く、範囲の正本は K6/7 の「確認の扱い」と「変える点」1〜8。契約（contracts）への書込みはこの枝ではしない。S2・S4 の失効と再凍結（Q5）、Q6・Q7・Q9 は記録の「範囲に含まれないもの」で、個別に伺う。
- 判断の ID と記録先を、確認の後に（実装の段で載せた） [作業記録](../nir1-continuation-2026-10.md) に載せる（DR-DBC-7、この節。PR 本文にも置く）。

### 検出が弱まらない根拠（4 本目の調査〔検出〕の結論。区間と file:line は同調査 §1〜§4）

時系列：S0（admit の stamp。worker の生成の前。`product.rs:2681`）→ create（`:2356`）→ t_a（worker の registration の preflight identity。`nir1_graph.rs:601`）→ t_b（`BEGIN DEFERRED`。:634）→ t_c（pinned identity の確認。:636-639）→ t_p（postflight。:700、比較 :703-705）→ READY → S1（query 直前の stamp。`product.rs:2841`）→ q_pin（query の pinned identity。`nir1_graph.rs:1039-1043`）→ q_post（post-rollback の identity。:1109-1120、比較 :1148）。

- 親の stamp が覆うのは (S0, S1]。worker の検査は (t_a, q_post] を隙間なく覆う（registration の pinned／postflight と query の pinned／post-rollback）。S1 < q_pin < q_post なので、**(S0, S1] のうち worker が覆わないのは (S0, t_a] だけ**。t_a > S0 は構造的に成り立つ（S0→create→prepare→t_a の順。`product.rs:2349-2371`）。
- (S0, t_a] の commit は registration が取り込む（t_a の identity が commit の後の状態を含み、registration は t_a 以降の全 table の読みと seal の読み〔:644-683〕を snapshot で行う）。【推測】古い authority を使うことにはならない。graph に関わる commit は通常 edge で session ごと Invalidated になる（stamp と無関係。【未確認】経路の網羅。`edge_epoch` を動かさない commit は ① で Available になり、fresh な Graph が返るので結果は正しい）。
- 結果が変わる場合は 1 つだけ：

| 場合 | 削除前 | 削除後 | 弱まるか |
|---|---|---|---|
| ① (S0, t_a] の commit（admit〜registration の preflight の前） | stamp が読めていれば S1 で不一致→`Stale`（query なし、worker retire→Rebuild）。読めなければ `Available` | registration が commit を取り込み `Available`（`stamp_stale`・`drift_at_query` とも増えない） | **弱まらないが outcome が変わる**（過剰な `Stale` が消える）。PR 本文に明記 |
| ② registration の preflight と BEGIN／pinned 読みの間、または BEGIN の後〜postflight の commit | registration が失敗し `Built::Exit`（stamp まで進まない） | 同じ（stamp はこの経路で読まれない） | 変わらない。outcome は `Stale` でなく `RegistrationUnavailable`（postflight、`Ok(false)` 経路）か `WorkerUnavailable`（pinned、`Err` 経路）で `consecutive_failures` に数える。① が `Available` になる側なので、この失敗の頻度は増えない（【推測】） |
| ③ query 直前の commit（(a) registration 完了〜S1、(b) S1〜q_pin、(c) q_pin〜q_post） | (a) stamp が読めれば S1 で `Stale`。(b)(c) は worker の `RegistrationDrift`→`Stale` | すべて worker が `Stale`（`drift_at_query`） | 弱まらない。(a) の費用が worker の query 1 回分だけ増える |

- 実運用で stamp が効いていた割合は低い：【事実】Gold の stamp0-missing は `gold-s5r3-1` で 329/330（fresh 1）、`gold-s5r4-1` で 330/330（contracts の `README.md:25`）。s6r1 267/3、s7r1 269/1、s7r2 266/4。【事実】stamp が読めなければ今も `Available` で、worker だけが判定していた。※下書きの「330 件中 327 件、s6r1、N-16」は今回の調査で確認できなかったので使わない。
- 結論：検出の弱まりは見つからなかった。ただし試験で固定するまで未検証（下の「試験」）。
- Opus の独立レビュー 1（read-only。コードの読み）も同じ結論：stamp は `ReadIdentity` そのもの（`c_query_freshness.rs:8`）、registration は preflight の identity を基準に pinned と postflight を比べ（`nir1_graph.rs:601,636-639,700-705`）、query は registration の identity と q_pin・post-rollback を比べ（`:1040-1043,1148`）、待機中の READY の間の commit も q_pin で捉える。覆われない区間は (S0, t_a] だけで、registration がその commit の後の状態を取り込む。`read_stamp_for_query` は identity が一致しないとき `None` を返すだけで `Stale` にはしない（`product.rs:2929-2936`）。stale を返す経路は見つからなかった（実機と試験は未実行）。

### 代替案

| 案 | 採否 | 理由 |
|---|---|---|
| stamp を残し、診断 JSON を 0 固定にする（β） | 不採用 | 「stamp が無い」ことを 0 で偽装する記録。後の読み手が誤解する。key の一覧の pin の変更も避けられない（FR-3 が変わる） |
| S0 だけ／S1 だけ残す | 不採用 | 概念が半端に残り、`StampUnreadable` の推定も残る。早期棄却の価値は実測でほぼ無い（上の 329/330） |
| stamp の機構を worker 側に移す | 不採用 | worker の drift 検査が既に同じ型・同じ読みで担っている。重複 |
| 製品で stamp を確実に取る（K6/6 の案 (iv)） | 不採用 | 逆向き。主接続の Mutex・waiter・finalization の予約への依存を増やす。先払い（DR-DBC-6）と競合 |
| K6/6 の R-7 のまま stamp の key だけ消す | 不可 | R-7 は「stamp の記録が無い（null）親は数えない」ので、全 sample が窓外になり first-render が 1 件も数えられない（K6/7 の開示 1） |
| 親の `try_lock` を `try_lock_conn_with_check` に替えて残す | 不採用 | 保たれるのは「wait-0 の事前判定」だけで、drift の最終判定は worker。残す意義が無い |

### 試験（実行は実装の段で。今回は走らせていない。命名・行番号は調査時点の `origin/master`）

**書き換え（stamp 由来の `Stale` を worker 側の drift に作り直す）**：
- `product_tests.rs:485-520`（`stale_stamp_retires_without_query_and_rebuilds`）→ `a_worker_drift_retires_the_queried_worker_and_rebuilds`：`QueryMode::Unavailable(RegistrationDrift)`、`queries == 1`・`drift_at_query == 1`、retire→再構築→2 回目 `Available`。`:522-550` は blocker thread（`with_conn` の sleep）を削除し、`drift_at_query == 1`＋`Stale` に統合。`:1847-1875` は `retire_quarantines` を維持し、query 後の retire が quarantine なら `Stale` を返しつつ `Quarantined`（`:2915-2918`）へ。`:2236-2254` は `:2256-2265` と同一になるので削除。
- `deferred_tests.rs:253-272`（p4）→ `DriftWorker`＋`query_gate_closed` で registration 後・query 前に commit→`Stale`、通知なしと cache 0 を維持。`:336-359`（n1）→ `queries == 1`・`drift_at_query == 1`・`plan.drifted == 1`。`:1045-1050`（control 2）→ `drift_at_query == 1`（`DriftWorker` が `data_version` で drift を出す。1 行）。`:1053-1088`（`i_a_without_s0_…`）→ 削除後の標準形（stamp の 2 assert と `with_read_transaction` を削除し改名）。`:692-722` は件数の assert を削除。`:1001-1007`・`:1279-1282` は `stamp_stale` の行を削除。【未確認】`:1281` の fixture が drift を検出するか。
- `dfinal_tests.rs:627-649`（`a5_a_stale_graph_waits_for_the_rebuild_and_asks_again`）→ `FakeWorker` に drift の印（判断 7）。`queries == 2`（drift した 1 回＋再構築後 1 回）、`drift_at_query == 1`、`prepares >= 2`。`:1308-1313`（`a12_busy_names_its_cause`）は削除。probe（`:20,84,254-255,610,646,658-685,688-751,929`）は判断 6。
- `reach_tests.rs`：`:189-193` の腕（必須）、`:226-231,368-383,476-517,536-539,551-567` の key・変数（試験名は `a7_a_cold_process_with_a_fake_worker_reaches_the_graph` に。`reached`・`outcome==used`・`fakeQueries==1` の assert は残す）、`:933-938,964-987` の文言。`eval/tests.rs:303-312,324,785` の `freshnessStamp` の主張を削除。(ii-b) の記録の形の試験を新設（試作で 3 本：`ii_b_a_ticket_always_names_both_steps`、`ii_b_a_worker_drift_is_recorded_as_drift_and_any_other_failure_as_not_evaluated`、`ii_b_a_requalification_drop_is_recorded_while_the_ticket_stays_available`。②-2 は accessor を直接呼ぶので、`await_request` 経由の試験は本実装で足す）。
- `c_query_freshness.rs` の試験 1 本（`stamp_tracks_commits_and_is_absent_while_the_connection_is_busy`。:34-99）は file ごと消える。「busy のとき wait-0 の read が None」の被覆は `lib.rs` 側の `try_lock_conn_with_check` に残る。

**新設（変更前後の差を固定する）**：
1. (S0, t_a] の commit は `Available`：`DriftPlan` に create の時点で commit を 1 回行う注入（`DriftFactory::create`〔`deferred_tests.rs:828-838`〕。`admit_hook_for_test` は S0 の前なので使えない）を足し、`Available`・`queries == 1`・`drifted == 0`・`refused == 0`・`drift_at_query == 0`・`prepare_failures == 0` を確認する。【推測】削除前は同じ構成で `Stale`（`stamp_stale == 1`）になる（ただし S0 が読める前提。実装時に**削除前の checkout で実測して確かめる**。【未確認】）。
2. registration 中の commit は `Stale` でなく prepare 失敗：`i_a_a_…` の control 1（`:1012-1028`）が既に固定する。変更不要。
3. registration 後・query 前の commit は worker が `Stale`：control 2（上）。
4. quarantine 経路（`PR:2915`）：上の `:1847-1875`。
5. 診断の field 削除の compile：`cargo check --all-targets`（feature `nir1-graph-eval`・`test-failpoints` 込み。【未確認】`-D warnings` の有無。unused import の `active_database`〔`product.rs:45`〕を外す）。
6. 具体名の grep が 0 件：`CQueryFreshnessStamp`、`try_read_c_query_freshness_stamp`、`read_stamp_for_query`、`stamp0_missing`／`stamp_fresh`／`stamp_stale`／`stamp_unavailable`、`StampUnreadable`、`eval_stamp_attempted_at`、`freshnessStamp`、`c_query_freshness`、`stamp-unreadable`、`stampMiss`、`stampReadFailures`、`trialsWithAStampMiss`、`s0Misses`、`stamp_misses`、`busy_cause_of`、camelCase の JSON key `stampFresh`・`stampStale`・`stampUnavailable`・`stamp0Missing`、文字列 `stamp0-missing`・`freshness-stamp-`、`StampNote`・`stamp_json`、`attemptedAtNs`・`handOverToStamp`、`RETIRED_FRESHNESS_STAMP_BUSY`・`STAMP_WITHOUT_COMPARISON`・`stampWithoutComparison`・`stampResults`・`stampMismatch`・`STAMP_MATCH`・`freshnessStampFromNative`、`stamp0`／`stamp1` の引数名、Rust のコメントの `S0 stamp`（`nir1_graph_commit_gate.rs:4`、`nir1_graph_gate_tests.rs:3,54,93`、`nir1_graph/tests/cq_avail.rs:2847` ほか）（単語 `stamp` だけの grep は worker の `post_stamp` と timestamp に当たるので使わない）。**grep の対象外（0 件にしない）**：歴史の記述として残すもの＝S2（`observation-prep.v1.json:78,84,402`）・作者の宣言（`:584,592,702,703`）、`K66_LIMIT_WORDS` の `"stamp0-missing"`（`observation-prep.mjs:4313`。K6/6 の limits を残す限り要る）、凍結済みの trace の file の `a3.note`（`trace-*.v1.json:171/177`。bytes 束縛）、docs（追記型。判断 9）。
7. real worker：`scripts/nir1-c-query-worker-ci.sh lifecycle`（worker の停止・再起動・cutover が不変）。opt-in の `i_b_…`（real worker。`--ignored`。【未確認】CI の対象でない）に「create の前の commit」の control を足すか、dev の run の `drift_at_query` で確かめる。
8. harness：`followup.k66.test.mjs`（試験名 N3a〜N3e・N4・N8・N12a・P1 の書き換え。**`N3d`・`N3e` は harness の試験名で、K6/6 の契約の負例ではない**〔契約の負例は N3a〜N3c〕）、`availability.test.mjs`、`native-sample.test.mjs`、`k64-record.test.mjs`、`trace-record.test.mjs`、`native-architecture.test.mjs`（`:360-365` の mutation を busy の hook に差し替え）、`observation-prep.test.mjs`（bytes pin、`S4_PROCEDURE_WORDS`、`K66_LIMIT_WORDS`）。
9. `fnm exec --using=22 pnpm -s verify:quality`（Node 22）、`cargo test -p grimodex-db --lib`（nir1_graph）と node crate。レイアウトには触れない。

### 試験の追補（実装の後のコードレビュー。2026-11-16）

**消した試験と代わりの試験**：
- 削除：`cancel_before_the_freshness_read_never_queries`（`origin/master` `3948eeb2` の `nir1_graph_product_tests.rs:1447`）。workspace slot を握って owner を S1 の読み（query の前）で止め、その間の cancel が query に届かないことを見る試験で、S1 の読みが無くなったので前提ごと消えた。
- 代わり：`cancel_before_the_owner_receives_the_query_never_queries`（同 file）。止める場所を READY の notifier に移した。`notify_ready` は owner thread で同期に呼ばれ（`nir1_graph_product.rs:690-697`）、READY の公開の後・`serve_until_retired` の recv の前（`:2316-2326`）に当たる。手順は、Warming の begin で未応答の印を付ける → notifier に入るのを待つ → 2 回目の begin（Pending、slot は InUse）→ `finish(Cancelled)` → notifier を放す。確認は、放す前に `queries == 0`、放した後に READY へ戻り、outcome が Cancelled、`queries == 0`・`retires == 0`・`retired_idle == 0`。`serve_query` の cancel の検査を外す mutation で `queries` が 1 になって落ちることを確かめた（一時的な変更で、戻した）。
- 同じ範囲の被覆は 2 本で分ける。この試験は「owner が query を見る前の cancel」、残した `cancelled_ticket_never_publishes_or_caches` は「worker が query の中にいる間の cancel」。

**`cancelled_ticket_never_publishes_or_caches` は偽陽性の形だった**（直した）：旧版は begin の直後に `finish(Cancelled)` し、`retires == 1` を待っていた。`finish(Cancelled)` は ticket の outcome をその場で Cancelled にするので outcome の assert は owner の動きを見ない。owner が cancel の旗を先に見ると query は 0 回で、worker は 300 ms の idle 退役で retire され、`retires == 1` はそれでも満たされる。40 回の実測で、`queries=0・retired_idle=1`（先に見た）が 28 回、`queries=1・retired_idle=0`（query の中）が 12 回で、どちらの順でも通っていた。直しは `queries == 1` を待ってから `finish(Cancelled)` し、`queries == 1`・`retired_idle == 0` を assert すること。

**`i_a_a_commit_after_the_release_and_before_the_registration_is_taken_in` の強化**：create の commit の行数（1）、別接続（観測用）の `data_version` が commit の前後で動くこと、worker の registration が commit の後の状態（scene の title が commit した値）で取られたこと、`prepares == 1` を assert する。`registered`（`PRAGMA data_version` の値）そのものは比べない：`data_version` は接続ごとの値で、別の接続（観測用・worker）の値とは比べられないため、worker の接続が registration の開始時に読んだ title で「commit の後の状態」を見た。【未確認のまま】削除前の checkout で同じ構成が `Stale` になることは実測していない。この区間（S0 の後・registration の前の commit）で、削除後は stale を返さないことの根拠は、registration が commit の後の状態で取られることをこの試験が固定している点と、コードの読み（worker の drift の検査は registration の読みと query の読みの比較だけ）であり、削除前の動作との比較は読みだけに依る。

**reach の sampler**：`mainConnectionSamples` が 0 のまま通る形だった（fake の lane は prepare が即時で、sampler の周期 2 ms より待ちが短く、実測で 0 だった）。fake の worker の prepare に 60 ms を入れて（registration の stand-in）sample を取り、fake の a7 に record ごとの `mainConnectionSamples > 0`、real の a7／a8 に合計の `> 0` を足した。

**未知の主な理由**：`availability.mjs` の `readMainReason` と規則 6 は、未設定・未知・（規則 6 では）null の主な理由を `[artifact]` で止める。以前は規則 6 の最後の枝（`condition-met-confirmation-required`）に落ちた。負例は `availability.test.mjs` の N-h7。

**持ち越し**（PR 本文に書く）：
1. `await_request` を通る (ii-b) ②-2 の試験が無い。②-2 は accessor を直接呼ぶ試験（`ii_b_*` 3 本）だけで固定している。
2. HEAD の評価 build での dev run（dev-shape の g06 を、base と head の対で）は未実施。`drift_at_query`・Stale・late・W の gate（上の gate の節）はこの run の後に判断する。
   **→ 2026-11-16 に実施した**（dev の gate を 3 回、real worker の R-10 を 1 回。結果と読みは下の「gate の結果」の節）。**registration の窓 W と begin→query の時間は未測のまま**で、ユーザーの回答（「悪化なしとして進める」）により、数値の gate でなく開示として持ち越す。
3. `scripts/nir1-c-query-worker-ci.sh lifecycle` は実行していない。省いた理由は見込みで、測っていない：script は `src-tauri/target/release` 固定（`CARGO_TARGET_DIR` を外した cold の release build）で、この worktree に release の成果物は無く、debug の `grimodex-db --lib` 全件だけで 1291 秒かかったため、release build と 8 case の逐次実行が 15 分に収まるとは見込めない。この PR は grimodex-db の `c_query_freshness.rs`（と mod 行）の削除と probe（`main_connection_is_free_for_test`）の追加を含み、worker の process の停止・再起動・cutover の code には触れないが、lifecycle の lane はその削除の後の grimodex-db では走らせていない。PR の前に CI 側（または時間のある実行）で確かめる。
4. opt-in の real worker 試験は debug の worker（`NIR1_C_QUERY_WORKER_BIN`）で 2026-11-16 に実行した：`i_b_the_real_worker_…`、`a7_…real_worker`（`mainConnectionSamples` は small 25・two-revisions 31）、`a8_supplement_…`（10/10 reached、samples 4831）、`a8_the_reach_…`（30/30 reached、samples 791、held 0）はすべて成功。
5. R-10 の real worker での確認（dev、head `Available`・base `Stale` が各 1 回）は dev 枝（`claude/dev-s4-9-r10`、`claude/dev-s4-9-r10-base`）にあり、push していない。`create` の中の commit だけで、②（preflight〜postflight の間）の commit は試していない（上の「gate の結果」）。
6. 1 回目の `g03h2` の late 2 件の `requalification=error(cancelled)` は、原因を確かめていない（上の「gate の結果」）。3 回目の `hd-g03h2`（head）の ownerReady の診断の `driftAtQuery` 1 は、2026-11-16 に調べた（ユーザーの再回答 contracts `7361041f`）：重なった commit は maintenance の依存検証の再試行の開始の commit が有力、drift の枝は Graph を返さない（コードで確定。worker が見落としたときの requalify は読んでいない。下の「drift_at_query の調査」）。未了は worker 内部の時刻。setup が maintenance の静止を待たない件は 9 回目の S4 で直した（下の「setup の静止」。DR-CP4-L-27）。

### gate（測るもの。数値の線は置かない）

- 動作の同等：dev の A/B（凍結外の fixture。base＝PR-3 の無い master、head＝PR-3。DR-DBC-6 の A/B と同じく交互に各 3 run 以上。回転 HDD と tmpfs の両方。測定環境が結果に効く）で、**`Stale`（base は `stamp_stale + drift_at_query`、head は `drift_at_query`）、late（`graph-late`）、`drift_at_query`、begin→query の時間、registration の窓 W が悪化しない**こと。**新しい閾値は置かない**。悪化の判断は、base の run 間の幅を記録し、head がその幅の外で悪い方へ出たら止まって報告する（C8 のとおり、未達は止まって再相談）。線は「悪化しない」の記録で、置く場合はユーザーに確認する。
- 削除した検査が実害を出さないこと：dev の run で `drift_at_query` の件数が、base の `stamp_stale + drift_at_query` の和と同程度であること。(S0, registration の preflight] の commit が `Available` になること（base では `Stale`、または stamp が読めず `Available`）を、real worker で 1 回確かめる。
- maintenance を走らせる条件を入れる（DR-DBC-6 の g06 は maintenance が無かった）。ただし PR-3 は親の `try_lock` を減らすだけなので、maintenance との重なりは減る方向（【推測】）。

### gate の結果（dev、2026-11-16。実施した事実と読み。記録は `fusion-eval-data/db-stage1-pr3-2026-11-15/` の `dev-gate/`・`probe-gc/`・`dev-gate2/`・`dev-gate3/`・`r10-real-worker.md`）

すべて dev 専用・非判定（凍結の fixture・受領書・Gold は使わず、dev-shape の `dev-shape-g06.v1.json`・`dev-shape-g03.v1.json` だけ）。base は `origin/master` `3948eeb2`、head は `977d30be`（評価 build は両側とも clean、`eval-build.json` の `resolvedHeadSha` と一致）。**base→head の差は PR-3 だけではない**（項目 B・C、(ii-b) の hook、判定 file を含む 19 commit）ので、時間の差が出ても PR-3 単独には帰せない。新しい閾値は置いていない。判断は上の gate の節のとおり「base の run 間の幅を記録し、head が幅の外で悪い方へ出たら止まって報告する」で、ユーザーに伺いながら 3 回取った。

1. **1 回目（`dev-gate/`、各 shape で base 2 run・head 2 run）**：g03/base で head の裾が base の幅の外に出た（head の late 2/60、base 0/60。p95 は head 52.2・71.0、base 46.3・48.7。最大は head 222.7・83.4、base 46.9・52.1）。止まって報告し、ユーザーは「本数を足して真因も採る」を選んだ。
   - head の遅い sample は 4 run のうち 3 run で rep22 にあった（base は 0）。2 run では偶然かどうか判断できなかった。
   - **項目 C の probe は原因ではない**（`probe-gc/`。probe の evidence 計算を on／off した 4 run で、off でも同じ遅れが出た。計算は 1 sample あたり 0.0〜0.2 ms、longtask は 0 件。n=4）。遅れは native 側（`nativeWorkerMs`）も約 120 ms 延びていて、renderer だけの停止ではない。本当の原因は未特定（推測）。
2. **2 回目（`dev-gate2/`、32 run）**：HDD→tmpfs、各媒体で g06→g03、各 shape で base 4 run・head 4 run。**約 100 s の遅れは再現しなかった**。head が base の run 間の幅の外に悪い方へ出た run が HDD に 2 本（`hd-g06h1`、`hd-g03h3`）あり、いずれも別 session の負荷（CPU 圧、ext4 journal の書き込み待ち〔`hd-g03h3`：main の tokio-rt-worker が `do_get_write_access` で約 150 ms 止まり、その間 sda が連続 busy〕）が同居していた。stall は HDD が base 0・head 1、tmpfs が base 2・head 3。**head ≥ base の非対称は隠さない**（70 ms 超を含む run は base 1/16、head 4/16。測定 tree 自身の CPU は同じ）が、本数が少なく悪化を示すものではない。「別 session が原因」は有力だが process は未記録。PR-3 のコードの差は、データから示せない。ユーザーは「静かな時間帯に取り直す」を選んだ（HDD だけ、base・head 各 4 run、ps の確認、load 待ちが時間切れなら打ち切る）。
3. **3 回目（`dev-gate3/`、静かな時間帯・HDD だけ。16 run、各 shape で base 4 run・head 4 run）**：stall は base 0・head 0。head が base の run 間の幅の外に悪い方へ出たのは **3 件**（`hd-g03h2` の g03/base の最大 59.5>53.5＝+6.0 ms、`hd-g06h3` の g06/base の p50 46.6>46.4＝+0.2 ms、`hd-g06h4` の g06/base の p95 51.7>50.8＝+0.9 ms）。**逆向きの外れもあった**（base 側の `hd-g03b3` の frontier-exceeded の最大 84.2、`hd-g06b4` の g06/base の最大 63.6）。late は g03/base・g06/base とも head 0 件（base は g06b4 の 1 件）。Stale は pooled の `stampStale`・`driftAtQuery`（dPrime の最大値）が全群で 0。**ただし head の `hd-g03h2`（g03/base。最大 59.5 ms の run）の受領書に、`drift_at_query` が 1 の記録が 1 件ある**（`checks.process.ownerReady.diagnostics.driftAtQuery`。採取は `k64-runner.mjs:670-704` の ownerReady の loop で、`preparesReady` が 1 になるまで `k64.sample` の probe を繰り返した後に `nir1GraphEvalDiagnostics` を読む＝測定の前の累積値。同じ run の measured の sample の dPrime counter〔`driftAtQuery`〕は 30 件とも 0）。3 回の gate と probe-gc の全 receipt（dev-gate 12、probe-gc 8、dev-gate2 49、dev-gate3 24）を走査して、`ownerReady` の `driftAtQuery`・`stampStale` が 0 でないのはこの 1 件だけ（base は 0）。**3 回目の「悪化なしとして進める」の質問は、この 1 件を示さずに伺っていた**。示した上でのユーザーの回答（2026-11-16T08:59Z ごろ。contracts `7361041f`）は「判断は変えず、重なった commit だけ調べる」（受領書と DB を読んで重なった commit を特定し、ここに書く。新しい測定はしない。**古い Graph を返す経路が見つかったら止まって伺う**）。調べた結果は下の「drift_at_query の調査」。この run の最大 59.5 ms との関係は確かめていない。

**「4 run の最大」の規則の読み**：「head の run 別の値が base の run 別の最大を超えたか」は、base と head が同じ分布でも、各 4 run なら 8 個のうち最大が head 側にある確率が 1/2 なので、約半分の確率で何か 1 つの指標が超える。幅の外に出たことだけで悪化と読めず、出なかったことも悪化なしの証明にならない。数値の線を置いていないので、この規則は止まる合図として使い、判断は差の大きさと原因で行った。

**ユーザーの回答**：3 回目の結果を報告し、ユーザーは 2026-11-16 に「**悪化なしとして進める**」と回答した（新しい閾値の設定でも、悪化の否定の保証でもなく、上の事実を示した上での進行の判断。結果は 3 回とも `fusion-eval-data` に残る）。

**R-10 の real worker での確認**（`r10-real-worker.md`。dev 枝 `claude/dev-s4-9-r10` `615fea68`〔head 側。`977d30be` から〕、`claude/dev-s4-9-r10-base` `72518d39`〔base 側。`3948eeb2` から〕。どちらも push していない）：製品の `ProcessGraphWorkerFactory`（real worker `nir1-c-query-worker` の process）を包む factory の `create`（admit の後・worker の registration の前）で、製品の接続から audit の commit を 1 回行う。**head（PR-3）では ticket が `Available`（`prepares_ready` 1、`drift_at_query` 0）、base では `Stale`（`stamp_stale` 1。parent の stamp の不一致で、worker の drift ではない）**だった。commit なしの対照は両側とも `Available`。各側・各条件 1 回。限界：commit は audit の append 1 回（edit の save や別接続の commit ではない）、`create` の中（S0 の後・worker の process の起動の前）で、worker の preflight の直前・直後や ②（preflight〜postflight の間）の commit は試していない。worker は debug build で、時間は比較に使えない。

**未測として開示するもの**（ユーザーの回答により、数値の gate ではなく開示とする）：
- **registration の窓 W と begin→query の時間は測っていない**。receipt に query 単独の時刻が無く、`registeredAtNs` が 1 つあるだけで W を導けない。dev の gate は fetch→return と ticket→settled の p50／p95／max で見た。
- 「消した検査が実害を出さない」の dev での実証は、base でも `stampStale` が 0 だったため得られていない（base でも stamp は stale にならなかった）。実 worker での確認は R-10 の 1 回だけ。

**drift_at_query の調査**（`hd-g03h2` の head。2026-11-16。read-only。記録は `fusion-eval-data/db-stage1-pr3-2026-11-15/drift-ownerready.md`。新しい測定・build・DB への書込みはしていない。DB は scratchpad に cp した写しを `sqlite3 -readonly` で読んだ。コードは `55885c62`〔製品のコードは `977d30be` と同一〕）：

| # | 結論 | 確度 |
|---|---|---|
| 1 | 重なった commit は、**maintenance の依存検証（dependency-verify）の再試行に伴う commit**。有力なのはその run B の開始 commit（`narrative_extraction_runs`／`tasks`／`attempts` の INSERT。`created_at` 04:05:14.061Z）。worker の生存区間は「14.031 に無く、14.056 に有り、14.081 に無い」としか分からず、そこに入りうる commit を、「begin は Raw の後」という順序の推論と registration の成功（postflight の後で query の検査の前）から B の開始に絞った | **有力**（消去法。worker 内部の時刻は未取得） |
| 1b | その maintenance が probe の時点で走っていたのは、**setup が dependency-verify の running 行を残したまま DB の写しを取った**ため。起動時の復旧が残りの run を `NEX_MAINTENANCE_INTERRUPTED` で閉じ（12.871）、`next_attempt_at`（＝12.871＋1.000 s、retryable）を残し、同じ `work_key` の run A（13.876）が始まった。A は probe 自身の Raw の audit に preempt され（14.036）、B が約 25 ms 後に再試行した。24 個の測定 DB（g03 16＋g06 8）で INTERRUPTED があるのはこの 1 個だけ | **確定**（DB の値で連鎖を確認）。原因は setup の静止の弱さ 3 つの重なり（下の「setup の静止」。9 回目の S4 で直した）。どれが当たったかは受領書が無く未確認 |
| 2 | worker は `RegistrationDrift`（`Stale` に分類）を返し、ticket は `Unavailable(Stale)` で settle する。**retire して再構築も cache 利用もしていない**（held query の session は答えた後に終わり、slot は empty）。`unavailable.stale` が 0 なのは、この counter が begin 時の拒否にしか使われないため（設計どおり。base の `stamp_stale` も同じ作り） | **確定**（コード）。ticket の実 outcome は受領書に無く、コードからの推論 |
| 3 | **drift の枝は Graph を返さない**。drift の枝は projection を作らず、返るのは `{"unavailable":"stale"}` だけ（最終防御として projection は返す直前に live DB で requalify される）。**worker が drift を見落としたときの requalify が拾うかは読んでいない**（S3 の再確認の推奨 3 で結論の文の範囲を絞った） | **確定**（コード。drift の枝について）。renderer 側の実応答は probe に記録が無い。古い Graph を返す経路は**見つかっていない**ので、**止まる条件には当たらない** |
| 4 | base で同じ形が起きれば、`driftAtQuery` 1（`stamp0Missing` 1、`stampUnavailable` 1）として記録された可能性が高い（`stamp_stale` になるのは S0・S1 が両方取れたときだけ。base の ownerReady は 12/12 で S0 が欠落）。base の受領書に出ていないのは「stamp が吸収した」からではなく、窓に commit が重ならなかったためと読める | 受領書 12 件の値の範囲で**確定**。重ならなかった理由は推測 |

PR-3 の安全性への含意：この fixture では base でも親の stamp は実質働いていない（graph sample でも `stamp0Missing` が 35/35〜34/35）。freshness の最終判定が worker の drift 検査だけであることは base と head で同じで、head で drift が出たのは**環境側の条件（setup が残した maintenance）が probe に重なったこと**で、stamp の削除による劣化の証拠ではない。ownerReady の drift は head 1/12 対 base 0/12（Fisher の正確検定 p=1.0。1 件の事象）で、差は有意でない。

**setup が maintenance の実行中に DB を写しうること（1b）の開示**：正式 run の setup でも起こりうる。起これば、worker が検出して `Stale` になる側（drift の枝は Graph を返さない。コードで確定。worker が見落としたときの requalify は読んでいない）。この連鎖は leftover が無くても、maintenance が走っている間の probe の Raw の audit が maintenance を preempt し、maintenance が即再試行して worker の窓に入る形で起こりうる（preempt の backoff 周りの挙動）。**setup の側は 9 回目の S4 で直した**（ユーザーの回答 contracts `337ff239`。下の「setup の静止」。DR-CP4-L-27）。preempt の連鎖そのもの（A′、DR-MP-8）は setup の静止では消えず、別の lane の課題として残る（測定の `freshnessSettle` は freshness consumer しか見ないので、測定側の残りは検出しない）。S2 の `k67Readings.limits` (n) に同じ開示がある。

**未確認（調査）**：B の commit の実時刻と worker の `before` 読みの時刻（worker 側の時刻は記録していない。sampler は 25 ms 周期）、setup の終了処理が maintenance の静止を待たない理由は、9 回目の S4 で `frozen-setup-driver.mjs` を読んで 3 つの弱さに分けた（下の「setup の静止」。hd-g03h2 で当たったものは受領書が無く未確認）、probe の ticket outcome と renderer の応答（受領書に無い）、`requalify` が worker の見落としを実際に拾うか（今回は至っていない）、同じ事象の再発率（再現の実験はしていない）。

**所見：`ticket available` と `requalification=error(cancelled)` の late 2 件**（1 回目の `g03h2` の rep12・rep22。`dev-gate/README.md` 3 節）：ticket は `available`・`disposition=unused` で、(ii-b) の `requalification` が `{result: error, reason: cancelled, returned: false}`。`related_scenes/graph.rs` の `eval_note_requalification` は `graph_response::assemble` が `Err` を返した場合を `error` と `classify(err)` で記録する作りで、ここでは `classify` が `cancelled` になっている。**「renderer が窓の後に unused と宣言して lease が cancel された」という読みは推定で、cancel の発生順は run で確かめていない**。proto README が予告した競合（宣言が先で記録が `not-reached` のまま）とは別の形。FR-3 の ②-2 の `[artifact]`（`followup.mjs:602-608` の `iiB.requalification.result !== "passed"`・`returned !== true`）は、`firstRenderOf` が `if (!join.inWindow) return`（同 :532）の後に置いたもので、`classifyJoin` は `graph.joined` が false の sample を `inWindow: false` にする（`join.mjs:60-62`。`inWindow` は合流した sample だけ）。**この 2 件は合流しない late なので、②-2 の `[artifact]` には届かない**（コードの読み。実 run の受領書に `firstRenderOf` を当てては確かめていない）。実 run で `error(cancelled)` が出うることは K6/7 の確かめられなかったこと 11・13（`await_request` 経由で `unavailable`・`error` を出す試験が無い）の隣にある所見として、S3 に渡す。

### 危険（残るもの）と対処

| 危険 | 内容 | 対処・状態 |
|---|---|---|
| ① の outcome の変更 | (S0, registration の preflight] の commit が `Stale`→`Available`。評価の数え方（K6/6 の R-7・FR-3・FR-8）に載る sample の分類が変わる | K6/7（R-10）で開示し確認を取る。製品としては fresh な Graph が返る方向 |
| DR-CQD-8・N1・P1-1 (b) の文言 | DR-CQD-8 は「release から query の終わりまでの commit は `stale`（stamp の不一致または drift）」と書く。① は release の後・registration の前なので、この DR は DR-CQD-8 の窓を「registration の preflight 以降」に狭める | 判断 3。supersede を明記し PR 本文に書く。N1・P1-1 の本文は判断 3 のとおり読んだ（N1＝試験、P1-1＝通知側の規則）。K6/7 の最終確認の質問文にも R-10 の一部として書く。ユーザーは選択の段〔その 3〕で承認済み（判断 3 に含める） |
| worker の query が 1 回増える | 今 `stamp_stale` で query を省いていた場合の費用（child の往復。drift は q_pin で早期に出る） | gate で `drift_at_query` と begin→query の時間を見る |
| 検査が 1 つ減った harness | FR-8 の `stale` で合流の検査が消える（`followup.mjs:541-544`） | K6/7 に開示。**代替は無い**（stamp が無く検出する対象が無い）。残る検出は `driftAtQuery`・`prepareFailures` の検査（`followup.mjs:545-548`）と、(ii-b) の drift の記録が「検出」の記録の `[artifact]`（N4′）。ticket が `available` でない親の FR-3 での不算入は合流した親では起きない空の検査で、代替と書かない |
| 窓外の query の区分（stamp の句の消去） | 【事実】評価 harness の K6/2 の規則 4（`availability.mjs:604-609`）と K6/4 の `followUpFailureCategory`（`followup.mjs:1099`）は、stamp が `unavailable`／`stamp0-missing` の窓外の query を過半数の前に「その他」へ畳んでいた。stamp が無いので、/7 は K6/2 の理由の区分（stamp の句を外した形）を使い、主な理由を過半数で決めた後で、主な理由が「鮮度」なら「その他」と読み替える（選択の段の「その 1」の問い直し。`f628efb2`）。K6/2 の字義と規則 6 に対して緩む面は無く、締まるだけ（規則 6 の最後の枝に届かない。stamp の結果が無い query で失敗した段の失効と setup-defect が戻る）。K6/6 の畳みとの比べでは、主な理由が「なし」だった trace が「その他」になる組が理論上 1 つあり、過去 12 本の受領書（24 件の読み）で 0 件（K6/7 の開示 7 の (c)。この版は緩和の番号を足さず、開示と質問文で伺う。K6/7 の「決めた点」1） | K6/7 の変える点 7。製品の挙動には効かない。区分は harness 側の規則で、harness の実装と検出力の記録は最終確認の後 |
| 試験の書き換えの規模 | stamp 由来の `Stale` に依存する試験 6 本は stand-in worker に drift が無いと成り立たない | 判断 7。変更前後の差を新設の試験で固定 |
| harness の pin 済み file と検出力の記録 | 【事実】`SOURCE_PINS` に載る 21 file／8 role（stamp を触る 10 file／7 role、`head.k67` を足す 11 file）が動く。pin の無い 3 file（`quality-verdict-cli.mjs`・`test-support.mjs`・`observation-prep.mjs`）は pin の移動に当たらず、検出力の記録・S2 の束縛だけ。単独の merge は master を赤にする（`observation-prep.test.mjs:4353-4363`）。SP-N・K6/4・K6/5・C7・K6/6（と K6/7）の検出力の記録が無効になる | S4 の枝で `--merge`、⑤⑥ で取り直し（`impl-plan.md`） |
| 先払い（DR-DBC-6）との整合 | 先払いが主接続の Mutex を握る間（約 45 ms）、stamp の `try_lock` は `None`→`unavailable` になりうる（s7r2 README:132。未測定の懸念） | PR-3 で概念ごと消える。【事実】s7r2 の候補は #909 の merge commit で `unavailable` は 0（一度の測定） |
| (ii-b) の Native の実装 | **dev の試作で実装できた**（②-1・②-2。判断 10）。残る：run 上の `drift`・`unavailable`・`error` の実証（run では 0 件。Rust の試験だけ）、競合で `not-reached` が写る頻度（未測定）、`await_request` 経由の試験、harness の本実装（`ticketOf`・`graphRecord`・FR-3） | 許可リストの追加（新しい path `related_scenes/graph.rs` の `SNIPPETS`・`BLOCKS` と製品の path の `SNIPPETS`）は Rust の hook と同時。確認の後の本実装で食い違えば /8（`k67-draft.md` の「dev の予行」の 5） |

### 未確認

- feature 込みの `cargo check --all-targets` の結果、`-D warnings` の有無（実行していない）。
- （N1／P1-1／F10 の要件の本文は判断 3 で読んだ。:197 の往復の頻度の変化は未測定。）`WorkerCause::category` が `Stale` を返す他の経路。
- `deferred_tests.rs:1281` の fixture が drift を検出するか。S0 が `drift_fixture` で読めること（削除前の checkout で実測）。`edge_epoch` が動かない commit の網羅。`DriftWorker` は REFUSED 経路だけを模す（pinned 読みの `Err` 経路〔`WorkerUnavailable`〕は fake では固定されない。real worker か reader 単体試験の領分。`registration_pinned.rs:633` 周辺が両方固定しているかは未確認）。
- dfinal の probe（判断 6）を feature 限定で置いたとき、node crate の試験（と reach の lane）がその feature を有効にして build できること。
- 製品の gate の A/B（`lock_conn` の待ち分布は PR-3 では対象外だが、base／head の `Stale`・late・`drift_at_query` は未測定）。
- (ii-b)：run 上の `drift`・`requalification` の `unavailable`・`error`（dev の試作では 0 件。Rust の試験だけ）、競合で `requalification` が `not-reached` のまま写る頻度、`await_request` 経由で `unavailable` を出す試験（K6/7 の確かめられなかったこと 11・13）。
- macOS／Windows での挙動（親の `try_lock` の削除は OS に依らない。【推測】）。

### 項目 C（品質判定 v3 の 4 項目）の実装の読みの開示（2026-11-16。独立レビューの推奨 9）

v3（`quality-verdict-prereg-v3.md`、contracts `160f5fa5`、SHA-256 `b6166ed2…`）の定義は変えていない。実装で字義から決まらず読みを置いた点のうち、**観測の後に読みを変えた 1 点**を開示する（実装の読みの一覧は PR 本文の項目 C の節）。

- **`raw-excerpt-unchanged` の「比べられる sample」（v3 §2.3）**：最初の実装（`d1b21a16`）は、親と子の世代の関係を「子の `queryGeneration` ＝ 親 ＋ 1」と読んだ。**contracts の過去の Gold（s7r2 の G-02、follow-up 2 件）を read-only で見たところ、実際の子の世代は親の ＋2** だった（loading の effect が挟まる）。そのため `22e2fc29` で「子の世代 ＞ 親の世代」に直した。
  - **観測の後の変更である**：＋1 の読みでは、観測した G-02 の follow-up 2 件が「比べられない」（`hold`）になり、実際の世代の関係では `pass` になる経路が無かった。読みを直したことで `pass` になりうる側へ動いたため、**緩和に当たりうる**ものとして開示する。
  - **何が緩むか**：親と子の `sceneId`・`seed` が同じで、親の IR が `ir-ready`、子の `origin` が `graph-ready` という他の条件は変えていない。世代の差が 2 以上でも「同じ query の取り直し」とみなす。差が大きい（途中に別の query が挟まる）場合の取り違えは、`sceneId`・`seed` の一致で防ぐ（別の query なら一致しない）。
  - **v3 の定義の側の事実**：§2.3 の field 名は S2 に回されており、世代の差の字義は定義に無い。直すなら v4（確認を要する変更）。この読みは実装の読みで、v3 の本文は不変。
  - **判定への影響**：first-render の sample は、この項目を `hold` にする読み（字義どおり）を変えていない。子が混じる variant（G-02・G-05・G-07）だけがこの読みの影響を受ける。
- **観測の後に変えた読みは上の 1 点だけ**（`22e2fc29`）。次の fail→hold の 2 点は、コードレビューと S3（10 回目）の指摘によるもので、観測の後の変更ではない（S2 追補 #18 の宣言は「2 点」と書いていた。S2 追補 #19 で 1 点＋コードレビュー由来 1 点＋S3 由来 1 点に直した）。
- **v3 の判定 file を直した独立レビューの修正（2026-11-16）**：`quality-evidence-items.mjs` は、page が返さなかった値（null の hash・範囲・ID）を `fail` でなく `hold` に、path の終端の判定を edge の並びに依存させず、`settings.seed.runtime` が無い受領書を `hold` にした。いずれも v3 の定義（§2.0 の `hold` の条件）の内側の実装の修正で、定義は変えていない。
  - **`fail` を `hold` に動かす読み（読めない行）**：`utf16-range`（v3 §2.1）の (iii)「各端点に (i) を満たす行が 1 件以上ある」は、その edge の Evidence 行に読めない行（hash・範囲が null）が混じるとき判定しない（その行が端点を満たしていたかが分からない）。その edge では (iii) の `fail` を出さず、読めない行の `hold` を残す。他の行が (i) に反すれば（`evidence-id-not-in-revision`、`evidence-row-matches-no-endpoint-text`）従来どおり `fail`。**根拠は字義にある**（S3 10 回目の確認）：読み取り側の行の範囲・hash が null なのは v3:98「対応する typed Revision の行が読めない」と v3:96 の `fail` の前提「行が読めていて」、表示側の行の hash・ID が null なのは v3:204「新 field が欠けた受領書は…判定側が `hold`」と v3:222「欠けは `hold`」、(iii) の「端点に (i) を満たす行が 1 件以上」は、読めない行がその端点を満たしていたかが分からないので v3:61 の E8 の一般則「観測が取れていなければ `hold`」に当たる（E8 の例外 3 点ではない）。**page が quote・範囲を返さなければ null になる**（`evidence-fields.mjs` の `hashOf` は文字列でなければ null、範囲は `orNull` で null を通す）。製品が quote・範囲を必ず返すかは確かめていない。`pass` にはならない。
  - **`fail` を `hold` に動かしていたもう 1 つの読み（path 単位の hold。S3 10 回目の B1-2。開示が無かった）**：`typed-revision-not-read` は、path の Revision のどれかが読めないと、その path の全 edge を `hold` にしていた（読めた Revision の行の (i) 違反も `hold`）。v3 §2.1 の `fail` は「読み取り済みの Revision の行が読めていて、(i)〜(iii) のどれかが成り立たない」（v3:96）、`hold` は「**対応する** typed Revision の行が読めない」（v3:98）で、対応は v2 C2 の edge 単位（v3:87）。**一度 `11d5e430` で『表示した行の `evidenceId` で行を引く』形に直したが、字義に合っていなかった**（S3 10 回目の再確認の必須 1。下の「S3 10 回目の再確認と edge 単位への直し」）。**`1dd6fb35` で edge 単位の対応に直した**（dev gate の後の修正だが、gate の値によらない。閾値・定義は変えていない）。fixture の relation の端点（`relationEndpoints`）を判定の入力に足し、edge の向きつきの端点で path の `pairs` の relation を 1 つ引いて、その Revision の行だけで判定する。読めない Revision の edge は判定せず（`typed-revision-not-read` の `hold` が残る）、読めた Revision の行に ID が無ければ `fail`、行が違えば `fail`。引けない edge は `hold`（`edge-revision-unresolved`）。試験は ID が Revision をまたいで重なる受領書で (i) 後の Revision の行だけが違う→`fail`、(ii) 自分の Revision が読めて ID が無く別が読めない→`fail`、(iii) 自分の Revision が読めず別の行と違う→`hold`、向きの違い→`hold`、既存の (a)〜(d)（読めない Revision・行の組合せ）は edge 単位でも成り立つ。
  - **v3 §0 の順序の入れ替わり（S3 10 回目の B3-7）**：§0 は ⑤ S2 の追補 → ⑥ dev の予行。実際は、この DR の dev gate（head `977d30be`）が S2 追補 #18 の前に v3 の新 field を持つ受領書を作った。判定 3 file は gate の前の `db7c1234` から gate の後まで不変で、v3:39「⑥ で見た値で定義を変えない」は守られた。上の path 単位の修正（`11d5e430`）と edge 単位への直し（`1dd6fb35`）は gate の後に判定 file を変えたが、gate の値によらない。
  - `K67_QUALITY_VERDICT_V3.implementationCommit` は `db7c1234` → `11d5e430` → `1dd6fb35` に取り直した（判定 3 file を最後に変えた commit。別の commit で定数を取り直す）。

### S3 10 回目の再確認と edge 単位への直し（2026-11-16。DR-CP4-P-11／S4-11 の追記 2）

S3 の再確認（Opus の agent、read-only。head `140bdda2`。記録は `fusion-eval-data/db-stage1-pr3-2026-11-15/s3-review-10-recheck.md`。agent の報告でユーザーの確認ではない）は **changes-required**（必須 1・推奨 7）を返した。B1・B2 は B2-4・B2-5 の残りを除いて閉じていた。

- **必須 1（既存の性質。`db7c1234` から。この再確認の事実で表に出た）**：製品の Evidence ID は Entity 単位（`nir1_entity_relation.rs:4523` `format!("nir1:evidence:codex:{entity_id}")`）で、2 hop の中間の Entity の ID が複数の Revision に出る（dev gate の受領書 `hd-g03h2` の `typedRevisions` は 5 行に ID 4 つ）。判定は path の Revision の行を ID の先勝ちに合成していたので、字義（v2 C2・v3:87 の edge 単位）から見て 3 つの差があった：(i) 全部読めたとき、後に並ぶ Revision の edge が先の Revision の行で判定される（`fail`→`pass`）、(ii) 自分の Revision が読めて ID が無いのに別の Revision が読めないと `hold`（`fail`→`hold`）、(iii) 読めない Revision の edge が別の Revision の行で判定される（`hold`→`fail`）。(i) は開示が無かった。
- **統合者の決定（案 A。字義に寄せる直しなので、ユーザーの確認は要らない）**：fixture の relation を判定の入力に足し、edge ごとに Revision を引く（上の `1dd6fb35`）。(i)〜(iii) をすべて無くした。引けない edge の `hold`（`edge-revision-unresolved`）は新しい code で、v3 は code を列挙せず（条件は v3:98 と E8 の一般則）、S2 の限界 (h) と作者の宣言に開示した。
- **試験の形**：既存の合成の受領書は ID が edge ごとに別で Revision も edge ごとだったので、ID を Entity 単位（`nir1:evidence:codex:{entity}`）に差し替え、G-03/base の中間の Entity `ivy` が 2 つの Revision に出る変種を足した。負例は (i)(ii)(iii) と向きの違いに 1 対 1 で対応し、**直す前の実装（`11d5e430`）では 4 つとも期待と食い違うことを、`git show 11d5e430:<file>` を当てて確かめた**。
- **v3 §10 の 3 の独立のコードレビュー（推奨 7）**：**この再確認が、`11d5e430` の差分を読んだ独立のレビューにあたる**（前例 `db7c1234` と同じ扱い。`11d5e430` の差分そのものを読んだ独立のレビューは、push の後のこの再確認だけ）。**今回の新しい実装 commit（`1dd6fb35`）は、次の S3 の確認で見る。**
- **推奨 6（既存。開示）**：実受領書で、表示側の hash が material の quote と食い違う edge は、C2 の推定で解決しない（`resolveEdge` は hash 2 本の一致を要求する）ので `pairs` が null になり、`utf16-range` は `revision-of-path-unresolved` の `hold` になる。v3:96 の第 2 文（端点の text 由来でない行を含む edge は (i) で `fail`）も、行が 3 本になれば解決せず `hold` に回る。条件 4 の結果は変わらない（同じ edge は edge の束縛が `fail` にする。`unresolved-edges`）。S2 の限界 (h) に 1 行足した。

### setup の静止（DR-CP4-L-27。9 回目の S4。2026-11-16）

- **ユーザーの回答**：contracts `337ff239`（`docs/plans/nir1-cp4-records/user-confirmation-2026-11-16-setup-quiesce-and-pubg-a.md`、SHA-256 `ad89ebfb4d04d324d2b022526f4c7aaa83bb8c12c4f0e8a88de6ecc4083803d1`。bytes から再計算して一致を確かめた）。問 1「今回の S4 に入れる」。範囲は dev での効果の確認 1 回と、DR-CP4-L-27 の「記録だけ」を「止める」に変えること。閾値の緩和ではなく、止まる場合が増える向き。問 2（PUB-G の (A) 8 件への着手）は別の作業で、この変更の範囲外。
- **設計**：`setup-quiesce-design.md`（read-only。`fusion-eval-data/db-stage1-pr3-2026-11-15/`。「次の S4（8 回目）」は誤記で、正しくは 9 回目）。案 B（静止を待ち、足りなければ開き直す）を主、最後の枝を案 A の stop、測定側の入口に案 C。設計が退けた 2 案（測定の待ちに `readActivity` を足す、`maintenanceEnabled=false` を書く）は入れていない。
- **弱さ 3 つ（`frozen-setup-driver.mjs`／`workspace-db.mjs` の読み）**：(a) session-end の待ちは maintenance の静止を求めても、足りなくても進む（`settled` は Freshness だけ）。(b) 静止の定義が retry の予定を見ない（`running` の数・run の数・最新 `created_at` だけ。1 s の隙は静止と読まれる）。(c) 写す側が `running` の行を見ず、写した後の読み返しは記録だけだった。
- **実装（`39b89bc3`）**：`readMaintenanceActivity` が `retryPending`（失敗した retryable の Attempt の `next_attempt_at` が now−5 s より先で、同じ `work_key` の後の run が無いもの）を数え、`maintenanceQuiet` は retry の予定を静止と読まない。最後の session を閉じた後、running 0・retry の予定 0・最後の stop が `app.close()`（signal でない）でなければ、step の無い quiesce の session（workspace を開き直し、製品の起動時の復旧が INTERRUPTED を閉じ、retry が完走するのを待つ）を最大 2 回（`MAINTENANCE_QUIESCE_REOPENS`）開く。待ちは各 60 s。尽きたら `[precheck] maintenance-quiesce` で止め、cold DB を作らない。開き直しが Index metadata を動かしたら止める。cold の読み返しの running／retryPending が 0 でなければ止める（従来は記録だけ）。測定の入口（`assertCompleteSetupReceipt`）は `readBack.maintenance` が 0 でない受領書も、読み返しの無い受領書も `[precheck]` で弾く。
- **pin**：`frozen-setup-driver.mjs`・`workspace-db.mjs`・`setup-receipt.mjs`（いずれも `HARNESS_FILES` の pin 対象）が変わった。いずれも `140bdda2` では pin の bytes と一致していたが、今は一致しない（S4b の前の pin の取り直しに入る）。
- **試験**：running の行が残った DB は setup で止まる（開き直し 2 回の後）、静止の待ちが尽きたら開き直して復旧すれば封印される、signal で終わった最後の session は静止と読まず開き直す（最後まで signal なら cold DB を作らない）、retry の予定がある状態は静止として読まない（実 schema の列で作った SQLite と `waitFreshnessSettled` の `requireQuiet`）、測定の入口が running／retryPending／読み返しの無い受領書を弾く。従来の「Verify が上限までに終わらなければ先へ進む」試験は、止まる試験に置き換えた。
- **dev の確認 1 回**（`fusion-eval-data/db-stage1-pr3-2026-11-15/setup-quiesce-dev.md`。dev-shape の g03、setup→k64、非判定）：setup は 2 variant で約 1 分 45 秒、quiesce の開き直しは 0 回、静止の待ち（session-end）の最長は 1.1 s、cold と測定 DB に `running` の行は無い。**開き直しの経路は実機では通っていない**（running の行が残る状況が起きなかった。fake の試験でだけ確かめた）。retry の予定の読みが製品の起動時の復旧の行の実物と合うかは見ていない（推測）。

### S3 10 回目の 3 回目の確認と setup の読みの整合（2026-11-16。DR-CP4-P-11／S4-11 の追記 3）

S3 の 3 回目の確認（記録は `fusion-eval-data/db-stage1-pr3-2026-11-15/s3-review-10-recheck2.md`。agent の報告でユーザーの確認ではない）は **changes-required**（必須 1・推奨 5）を返した。前回の必須 1（edge 単位）は閉じた。

- **独立のコードレビューの位置づけ**：**この確認が、`1dd6fb35` の差分を読んだ独立のレビューにあたる**（v3 §10 の 3）。**ただし依頼文に builder の結論が入っていたので完全な盲検ではない**（v3 §10 の 3 の「起案者の結論は渡さない」との差）。次の確認は結論を渡さない形にする。
- **必須 1（setup の静止の読みの整合）**：S2 の `setupReadings`（`reopen`、`freshnessSettle.setup`、`receiptFields`）・validator の定数・DR-CP4-L-24・T-5 の行が、`39b89bc3` の後の挙動と食い違っていた（限界 (n) は新しい挙動、`setupReadings` は古い読み）。向きは止まる側で、ユーザーの回答 `337ff239` の範囲内。静止の枠は L-24 の閉じた集合の外の別枠（`reopen.quiesce`。blocked の名前にも契機にも足さない）として写し、`maintenanceStillWhen` に retry の予定を足し、cold の running／retryPending を「止める」に、`readBack.maintenance` に `retryPending`、`receiptFields.quiesce` を足した。
- **推奨 2（前回の推奨 6 の記録の訂正）**：上の「S3 10 回目の再確認と edge 単位への直し」の「S2 の限界 (h) に 1 行足した」は、実物には無かった。今回 (h) に書いた（表示側の hash が食い違う、または edge の Evidence の行が 2 本でない edge は `resolveEdge` で解決せず `revision-of-path-unresolved` の `hold`。edge の束縛では `unresolved-edges` で `fail`）。
- **推奨 5（fail→hold の数え方）**：今の `fail`→`hold` は 2 点：(1) `db7c1234` の読めない行の `hold`、(2) `edge-revision-unresolved`（`1dd6fb35`。凍結の fixture に整合した受領書では到達しない）。上の「path 単位の hold」（`11d5e430`）は `1dd6fb35` で無くなった。上の「観測の後に変えた読みは上の 1 点だけ」の段落の「S3 由来 1 点」は、今は (2) を指す。
- **開き直しの経路の実機での確認（推奨 1。dev 専用・非判定）**：枝 `claude/dev-s4-9-quiesce`（`67cf9453` から、commit `11c12fb9`、push しない）の dev-shape の g03 で setup だけを 2 回。最後の session（seal）の session-end の待ちを飛ばし、`running` の run が現れた時点で harness の `stopElectron` に SIGKILL だけを渡して止める仕組み（dev 専用の env）を足した。
  - `qzo1`（frontier-exceeded）：running の dependency-verify が 1 行残った。quiesce の開き直し 1 回（`quiesce-1`、`app.close()` で閉じた）、静止の待ち 1.9 s（8 poll）、setup 全体 28 s。製品の起動時の復旧がその run を `failed／NEX_MAINTENANCE_INTERRUPTED` に閉じ、Attempt は `retryable`・`next_attempt_at` が失敗の 1.000 s 後で、同じ `work_key` の run が完走した（retry の予定の読みが合う行の実物）。cold の `running` は 0、`retryPending` は 0。
  - `qzo2`（base）：running の行は現れず（30 s 見た）、signal だけで開き直し 1 回、待ち 0.3 s で静止。cold の running は 0。
  - Index metadata は 2 回とも開き直しの前後で同じ（b・chronicle とも generation 1、dirty なし、digest も同じ）で、`maintenance-quiesce` では止まらなかった。
  - **限界**：running の行が残った例は 1 回で、dev-shape の preview の fixture。凍結の G-03/frontier-exceeded では走らせていない。開き直しの session の中で Verify が完走しない場合に使い切って止まる経路と、will-quit の障壁を通る終わり方で running が残るかは実機で見ていない。記録は `setup-quiesce-dev.md`（dev の受領書は `assertCompleteSetupReceipt` を通らない、という前回の記述の誤りも訂正した）。上の「dev の確認 1 回」の「開き直しの経路は実機では通っていない」は、この確認の前の記述。
- **試験**：開き直しが Index の metadata を動かしたとき `[precheck] S1i maintenance-quiesce` で止まり cold DB を作らない試験（推奨 3）と、S2 の新しい読みの変異の試験を足した。
