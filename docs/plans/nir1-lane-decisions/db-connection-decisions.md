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
| DR-DBC-1 | 2026-11-08 | **公開した workspace の本体の接続（`WorkspaceAuthority::new` が受け取る `Database`）の autocheckpoint を、wal hook に置き換え、WAL の page 数が閾値（`WAL_CHECKPOINT_PAGES`＝1000。既定の autocheckpoint と同じ値で、変えない）以上のとき背景のスレッドへ知らせるだけにする。** 背景のスレッド（`grimodex-wal-checkpoint`）は、1 回ごとに checkpoint 専用の接続（`READ_WRITE`、作成なし、busy_timeout 250 ms）を開き、`PRAGMA wal_checkpoint(PASSIVE)` を回して閉じる。TEMP 表・ReadIdentity・stamp には関わらず、何も commit しない。背景が使えない間（止めた後・失敗が 3 回続いた後）は、hook が SQLite の既定と同じ同期の PASSIVE checkpoint に戻る（スレッドが作れないときは hook を入れず autocheckpoint のまま）。**背景が追いつかないとき（commit が続く burst、読み手が止めている間）の上限は、閾値の 4 倍（`MAX_WAL_PAGES_BEFORE_SYNC`＝4000 page、4 KiB page で約 16 MB）**：それ以上では hook が、背景の run が終わるのを最大 5 s 待ってから、同期の PASSIVE checkpoint を行う（レビュー指摘 major-2）。理由：PASSIVE は開始時点の末尾までしか書き戻さず、WAL の先頭へ戻すのは「書き手が始まる時に全部書き戻し済み」のときだけなので、書込みが速い burst では背景の 1 回の run が追いつく前に WAL が伸び続ける（試験で、150 page を 1 ms で 300 回書くと、背景だけでは 46000 frame まで伸びた）。また PASSIVE は checkpoint の lock を持つ別の接続（背景）がいると何もせず BUSY で戻るので、同期の checkpoint は背景の run と重ならないよう待ち、その間は背景が新しい run を始めない。4000 page は、既定の autocheckpoint の実測の最大（3622 page、約 15 MB）と同じ程度で、WAL の最大を今と変えない。この待ちは前景への back-pressure で、上限を超えたときだけ起こる。待ちが 5 s を過ぎる（背景の run が止まらない異常）ときは、その run には**二度と待たず**（run に世代番号を持たせ、待ちを諦めた世代を覚える。止まった run に上限を超えた commit が毎回、本体の Mutex を握ったまま 5 s 払うのを避ける）、同期の PASSIVE を試すだけにする。止まった run が checkpoint の lock を持つ（専用の接続を開いた後で止まる）と PASSIVE は BUSY で進まず、WAL の上限は保証しない。実装は `grimodex-db/src/background_checkpoint.rs` | 信頼する：Electron main の native（`WorkspaceAuthority` の所有者）。信頼しない：renderer（SQL は従来どおり authorizer の下の本体の接続。checkpoint の接続は renderer から到達できず SQL を受けない）、他の process（standalone MCP は別の接続で、従来どおり自分の autocheckpoint）。受信先・送信先・保存範囲は変わらない（同じ file への checkpoint だけ）。防御：PASSIVE だけ（RESTART／TRUNCATE は使わない）なので書き手・読み手を待たせず、WAL の先頭へ戻すのは次の書き手 | (a) `wal_autocheckpoint=0` のまま背景だけ（背景が止まると WAL が無限に伸びる。却下）(b) polling（commit の知らせが無く、idle で起き続ける。却下）(c) 専用接続を常駐（file handle が restore・Windows の置換の邪魔になる。却下。1 回ごとに開閉する）(d) RESTART／TRUNCATE（読み手・書き手を待つ。却下） | 実装済み（Draft PR） |
| DR-DBC-1a | 2026-11-08 | **open の WAL 準備（`open_wal.rs`）の「`wal_autocheckpoint` が正」の検査の意図を確かめ、単位の出所を直す。** 意図：`prepare_wal_for_open` は、前の process が残した WAL が閾値の 3/4 以上なら RESTART で畳み、閾値を超えていたら同期の checkpoint の仕事量が大きすぎるので畳まず（`DeferredWorkLimit`）、公開前の checkpoint の仕事を「設定された autocheckpoint の 1 周期」以下に抑える。検査は、その 1 周期（page 数）が正であることを求める。つまり安全の検査というより、仕事量の単位が実際に誰かが守る正の上限であることの検査（0＝何も上限が無いなら、単位が無い）。背景が上限を守る形では pragma が 0 になる（wal hook を置くと `PRAGMA wal_autocheckpoint` は 0 を返す）。そこで、単位を `wal_cycle_pages(pragma, background)` で決める：pragma が正ならそれ、0 で背景の checkpointer が動いているならその閾値、どちらも無ければ今までどおり `OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE` で拒否する。背景の閾値を単位にしてよいのは、wal hook が実際に背景のものであると確かめられたときだけ（レビュー指摘 minor-2）：`background_checkpoint_bound` が `sqlite3_wal_hook` を同じ callback と引数で入れ直し、戻り値（直前の引数）が背景の `Shared` と一致するかを見る。一致しなければ（hook が別のものに置き換わっている）入れ直した上で上限なしとして拒否する。pragma の値は準備の前後で変えない（`verify_connection_settings` は生の値を比べる）。公開の経路では、準備は背景を始める前（`WorkspaceAuthority::new` の前）に走るので、単位は今までどおり pragma の 1000 になり、振る舞いは変わらない | 検査を外す案ではなく、上限の保証を「autocheckpoint か背景」のどちらかが必ず持つ形にした。fail-closed は保つ | (a) 検査を削除（上限が無い接続を黙って通す。却下）(b) 準備の前に背景を始める（準備の RESTART が背景の接続と競合しうる。却下） | 実装済み |
| DR-DBC-2 | 2026-11-08 | **監査の hash chain の検証を、結果を変えずに速くする。(1) S1：payload を `Value` に parse した後、全 object の key が昇順なら `canonical_json_value` の clone と整列を省き、そのまま直列化した bytes の sha256 を取る（昇順でなければ従来の経路）。(2) 上限つきの並列：行ごとの計算（parse・契約の検証・payload の sha256・`compute_hash`）を、最大 4 thread（`min(4, 論理 CPU 数 / 2)`、最低 1）の `std::thread::scope` で並列に行い、連番と `prev_hash` の連結の判定は行の順に呼び出し側の thread で行う。行は「1,024 行、または payload の合計 4 MiB」の先に当たる方で batch に切って読み、次の batch の読み出しを今の batch の計算と重ねる（memory は batch の大きさに比例し、行数にも payload の大きさの偏りにも比例しない）。行数が 1,024 行以下なら逐次。thread を作れないとき（OS の資源の枯渇）は panic せず、その chunk を呼び出し側の thread で逐次に計算する。payload 以外の列を読む順は従来と同じ（payload を先に読んで parse し、他の列の error はその後）。** 実装は `grimodex-db/src/ai_audit.rs`（`verify_stored_chain` ほか）、試験は `ai_audit/verify_tests.rs` | 信頼する：Electron main の native が持つ本体の接続（読むのは今と同じ行・同じ列）。信頼しない：保存された監査の行（DB を書き換えられる攻撃者が作りうる。今と同じく全行を検証する）。thread は `thread::scope` の中だけで、戻る前に必ず join する（常駐・detach・新しい受信先・送信先は無い）。`Connection` は呼び出し側の thread から出ない（worker は読み出し済みの文字列だけを見る） | (a) 検証を publish の tx の外へ（窓ができ、同一性の証明が要る。却下。ユーザーの選択）(b) 生 bytes の sha256 が一致すれば正規化を省く（正規形でない生 bytes に合わせて `payload_sha256` と chain を計算し直した改ざんを通す。強さが変わる。却下）(c) 生 bytes の sha256 一致かつ生 bytes が正規形のときだけ通す（同値だが、S1 より約 4% 速いだけで論証と試験が増える。採らない）(d) 契約の 4 項目だけ読む parse（範囲外の数値で error の有無が変わる。却下）(e) rayon（製品の依存を増やさない）(f) Merkle・差分の検証（Q4 で決める） | 実装済み（Draft PR） |

## 3. owner／lifecycle matrix（GDX-PRECHECK-001。background work なので mutation の前に置く）

owner は `Database` が 1 つだけ持つ `BackgroundCheckpointer`（スレッドの JoinHandle と共有状態 `Shared`）。スレッドは `Arc<Database>` や authority を持たず、path と `Shared` だけを持つので、`wait_for_sole_owner` の数に入らない。

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
- IPC・preload・N-API・schema・依存・契約・送信先・保存範囲。
- MCP（standalone の別 process）。

## 5. MCP の確認

`grimodex-mcp` は別 process で、`db.rs` の `open_db` が `Connection::open` ＋ `journal_mode=WAL`・`busy_timeout=5000` で自分の接続を作り、`Database::from_connection` で包むだけ（`WorkspaceAuthority` を通らない）。したがって背景の checkpointer は始まらず、SQLite の既定の autocheckpoint（1000 page）が従来どおり MCP の commit の中で走る。MCP の書き手は本体の Mutex と無関係で、前景を待たせない。**変更不要。**

同じ DB を Electron と MCP が開いているとき、MCP の commit の autocheckpoint と背景の PASSIVE は同じ checkpoint lock を取り合うが、どちらも PASSIVE（待たない）で、取れなければ次の機会に回る。WAL の先頭へ戻すのは書き手なので、背景の checkpoint が MCP の書き込みを待たせることはない。

## 6. 試験（`background_checkpoint_tests.rs`、`backup_restore.rs`、`open.rs`、`open_wal.rs`）

- 閾値が既定の autocheckpoint と同じ 1000 であること。
- 開始：autocheckpoint が hook に置き換わる、2 回目は `AlreadyRunning`、memory・読取専用は対象外（autocheckpoint のまま）。
- WAL が上限の近くに保たれる：対照（autocheckpoint も背景も無い）は閾値の 4 倍を超えて伸び、背景があると「閾値＋最後の 1 tx」以内（対照の 1/3 未満）、integrity_check が ok。
- checkpoint が data_version・total_changes・schema_version・ReadIdentity を動かさない（実行中・終了後・別の接続の PASSIVE・読み手の snapshot の中）。対照として、別の接続の commit では data_version が進む。
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
| closure の保持 | `InnerConnection` の field に `Box`。置換で古い closure は代入時に drop | `sqlite3_set_clientdata`（hook ごとに別の名前）に `Box::into_raw`。置換は「新しい hook を SQLite に登録 → clientdata の置換で古い closure を destructor が free」、解除は「hook を外す → destructor が closure を free」、接続を閉じると SQLite が destructor を走らせる | 置換・解除・close の各時点で closure が生きている期間は 0.40 と同じ。`install` が登録に失敗したときは新しい closure だけが free され、古い hook は残る（`set_clientdata` の `preset` が失敗したとき）。`progress_handler` の `num_ops`・`None` の扱いは同じ |
| 借用の検査 | `check_owned()` が接続の所有を実行時に確かめる | 型が `&mut Connection` を要求する。実行時の確認は無い | 実行時の確認の代わりに、型で「登録中は他の借用が無い」を保証する（hook の中から自分自身を登録できない、statement の途中に登録できない） |
| `Transaction`／`Savepoint` | `Deref<Target = Connection>` | 同じ（**`DerefMut` は無い**） | transaction の下では hook を登録できない。`unchecked_transaction()` の下で capacity scope（progress の入れ替え）や commit hook を使う経路は、`ScopedTransaction`（下の判断 3）に替える |
| `busy_timeout` | 設定のみ | 成功すると busy handler の clientdata も消す | busy handler は使っていない（登録箇所なし）。`busy_timeout` は `&self` のまま |
| `Statement::column_names()`／`columns()` | `Vec` | `impl DoubleEndedIterator + ExactSizeIterator` | `execute.rs`・`project_snapshots.rs` の 2 か所の `.iter()` を外した |
| `Connection::backup` の進捗引数 | 推論できた | 型注釈が要る | 試験 2 か所（`nir1_capacity.rs`、`nir1_capacity_boundary_tests.rs`）に `None::<fn(rusqlite::backup::Progress)>` を足した |
| bundled のビルド | `-DSQLITE_ENABLE_MEMORY_MANAGEMENT` あり | **無し**（`libsqlite3-sys-0.39.1/build.rs`。ほかの compile flag の差は無い） | `sqlite3_release_memory`／`soft_heap_limit`／`PRAGMA shrink_memory` は無効になるが、この repo はどれも呼ばない（`rg` で 0 件）。`sqlite3_memory_used`／`sqlite3_memory_highwater` は常に有効で、診断（feature）が使うのはこの 2 つだけ |
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
4. **statement を `&mut` の呼出しの前に閉じる**：`conn.prepare` した statement を持ったまま、capacity scope などの `&mut Connection` の呼出しをしていた箇所は、statement の寿命を block に閉じる、または行を先に集める。行を先に集めるのは `verify_coverage.rs` の application の行だけ（`narrative_proposal_applications` の join。1 行が 10 個の文字列の tuple で、件数は project の applied proposal 数のオーダー。以前は `query_map` の iterator のまま、行ごとに別の query を同じ接続で走らせていた）。同じ SQL・同じ順序・同じ総 VM steps で、`check_control` は行ごとに残す。差は、stop や deadline が行の読み出しの途中で効いたとき、typed の停止が `check_control` ではなく progress hook の SQLITE_INTERRUPT（`map_interrupted_error` が同じ typed の停止に直す）から来る点だけ。ほかの箇所（`nir1_chronicle_index/canonical.rs`、`publish_runtime.rs`、`revision_eligibility/freshness.rs`、`restore_rebuild.rs`、`verify_coverage.rs` の basis の statement）は、すでに `collect` していた、または statement が最後の使用の後も scope の終わりまで残っていただけなので、statement を block に閉じる／`drop` するだけで、挙動は同じ。
5. **`with_conn` は `&Connection` のまま**にし、hook を登録・解除する closure のための `Database::with_conn_mut`（`&mut Connection`）を足す。`with_conn` は `with_conn_mut` の薄い wrapper で、`attempt_active` の経路（`with_capacity_connection`）の差は無い。`with_participant_sql_scope`／`with_participant_read_transaction*`／`with_chronicle_reader`／`with_immediate_transaction*`／`with_graph_no_wait` と maintenance scope の operation は `FnOnce(&mut Connection)` に変える。
6. **`ValidationContext`** は `&Connection` ではなく `&mut Connection` を持ち、`connection()`（`&mut`）と、接続と stop owner を同時に借りる `parts()` を持つ。`ensure_connection`（context の作成に使った接続と同じ接続かの pointer 比較）は、`&mut` を context が持つので自明（同じ接続しか持てない）になり、2 か所の呼出しと一緒に削除する。
7. **`with_pinned_snapshot`** は guard 版の `pinned_snapshot_scope(conn)` を足す（Graph の読みの 2 か所〔registration と query〕が使う）。guard は pin（値）だけを持ち接続を借りないので、scope の間も `&mut Connection` を使える。scope は guard の寿命（unwind でも）で終わり、`finish_read` の ROLLBACK の前に閉じる順序は変わらない。closure 版は試験用（`#[cfg(test)]`）に残す。
7a. **`GenerationHistorySnapshotReader`**（native の chat の履歴の読み。feature `native-current-human-capture`＝grimodex-node が常に有効にする）は `&mut Connection` を持つ。history run の read-only authorizer の guard `ReadOnlyRun` は reader を排他的に借り（`Deref`／`DerefMut` で reader を貸す）、run は guard を通して続く。`drop` で authorizer を外す。`authority_connection()`（requalifier に貸す `&Connection`）は reader の借用に結びつく。
8. **試験の hook**（約 100 か所）は `Database::with_conn_mut` から `&mut` を取る。hook の登録・解除を `with_conn` の closure の中で行っていた試験は、期間が同じ（登録 → 対象の呼出し → 解除）まま `with_conn_mut` に変わる。
8a. **同じ接続での「読みの最中の書込み・観測」を使う試験 4 件**（`freshness_share_tests.rs` の `Observed`、`query_context_reuse_tests.rs` の `WriteDuringCheck`、`nir1_history_budget_tests.rs` の read-only 検査の probe、`registration_statements.rs` の `LiveProbe`）は、読みが `&mut Connection` を持つので、読み自身の参照では書けない・観測できない。試験専用の `test_support::same_handle_writer`（`Connection::from_handle` の非所有の wrapper。同じ `sqlite3*` を指す別の Rust object）を使う。Rust の参照は重ならず、SQLite が同じ thread での同じ handle の使用を直列化する。authorizer は handle に付くので、read-only 検査の試験は同じ結果（拒否）になる。本番のコードは 2 つ目の wrapper を作らない。
9. **`AUDITED_SQLITE_SOURCE_ID` の更新**（上の監査）。
10. **grimodex-node**：`with_conn` → `with_conn_mut` を、cutover の 2 か所（`cut_over_workspace_freshness` 等）と評価 harness の `update_hook` に、関連場面の build の `|conn: &mut _|` を 2 か所、試験 2 件に。`ScopedTransaction` は `grimodex_db::ScopedTransaction` として公開する（node の試験と、grimodex-db の integration 試験と example が使う）。公開関数のうち `&mut Connection` を取る形に変わったのは、`narrative_extraction` の cutover・skip evidence・Chronicle の build と query・Graph の build／publish・repair・verify・retrieval／revision eligibility の読み（約 30 個。`git diff` の `pub fn`）。

11. **`ReusedStatement`（`nir1_entity_relation_index.rs`）の `sqlite3_clear_bindings` を NULL の bind に替える**。SQLite 3.54 の planner は、index に使われない `x = ?` の項の parameter を「bind し直すと reprepare」として登録する（`sqlite3ExprIsInteger(…, pParse, 1)`。整数 0／1 への・からの変化でだけ失効）。`sqlite3_clear_bindings` は登録のある statement を必ず失効させるので、Graph の registration が 5 つの statement を Revision ごとに持ち回す最適化（prepare は 1 回、DR-GRW-3）が、使うたびの再 prepare（`RePrepare` が 2〜3）に戻っていた（試験 4 件の失敗で見つかった）。bind の解放の目的（長い Revision id の copy を SQLite が次の bind まで持たない）は、全 parameter に NULL を bind すれば同じに果たせ、登録のある parameter でも text → NULL → text は失効しない。意味（答え・保持する memory）は同じで、試験（`registration_statements` の prepares／reprepares／mem_used）が固定する。rusqlite の `prepare_cached` も返却時に `clear_bindings` を呼ぶので、同じ条件の cached statement は 3.54 で使うたびに再 prepare される（この lane では変えない。時間への影響は下の「時間の測定」）。

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
| update／rollback／wal／busy／trace | 本番では登録しない（`rg` で 0 件）。`update_hook` は `grimodex-node` の評価 harness の `CaseWorkspace::open` だけ | harness の接続の寿命 | `with_conn_mut` | 登録の API が `with_conn_mut` になっただけ |

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
| `fixed_graph_sql_budget_admits_600000_steps_and_refuses_600001`（`nir1_capacity.rs`。`QUERY_SQL_STEPS` 600,000 の「ちょうど」の workload） | 26,082 行＋padding 23 文で 600,000 steps | 同じ workload が **599,999** | 閾値は変えず、workload を 26,081 行＋padding 29 文（23×26,081＋4×29＋21＝600,000）に較正し直した（1 step 少ない原因が固定部分か padding かは切り分けていない推定。較正後の workload で 600,000 になり、N+1 で拒否する 2 つ目の表明は同じ）。 |
| COMMIT の progress（新しい試験 `audited_sqlite_commit_program_and_callback_order`） | （監査の文書の記述） | `EXPLAIN COMMIT` は Init／AutoCommit／Halt／Goto（実行順は Init → Goto → AutoCommit）、cadence 1 の progress は 3 件、commit hook は 2 件目の後 | 前提どおり。過少課金の変化は無い |
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

### 時間の測定（この lane では実施していない。要る）

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
