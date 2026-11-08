# DB 接続の改善の判断の記録（DR-DBC。A：WAL checkpoint を本体の接続の外へ）

出所は DB 接続の根本改善の調査（read-only の設計の比較 `design-comparison-v2.md`。計測は `runs/summary.md` の「commit の内訳」と「publish の tx の内訳」。置き場は `fusion-eval-data/design-notes/db-connection-2026-11-07/`）。基点は `origin/master` の `a2309b95`、branch は `claude/db-bg-checkpoint`。

## 0. 承認と範囲

これは DB 接続の lane で、NIR-1 の残レーンへの事前委任（AGENTS.md）の外にある。委任には頼らず、ユーザーの個別の承認に基づく。

- 2026-11-07：DB 接続の根本改善の方針（根は 1 本の接続が排他と鮮度の物差しを兼ねること。計測は今、実装は CP-4 の後・PUB-G の前、実装の前に確認に戻る）。
- **2026-11-08：ユーザーが「A を CP-4 の前に入れる」と決定**（`design-inputs.md` 末尾の Q1〜Q4。A と B だけを CP-4 の前に入れる）。この文書は A だけを扱う。B（監査の chain の検証を tx の外へ）は別の枝・別の PR。
- 変えない：閾値・送信先・保存範囲・契約・脅威モデル。新しい IPC・preload・N-API・schema・依存は足さない。

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
| DR-DBC-1 | 2026-11-08 | **公開した workspace の本体の接続（`WorkspaceAuthority::new` が受け取る `Database`）の autocheckpoint を、wal hook に置き換え、WAL の page 数が閾値（`WAL_CHECKPOINT_PAGES`＝1000。既定の autocheckpoint と同じ値で、変えない）以上のとき背景のスレッドへ知らせるだけにする。** 背景のスレッド（`grimodex-wal-checkpoint`）は、1 回ごとに checkpoint 専用の接続（`READ_WRITE`、作成なし、busy_timeout 250 ms）を開き、`PRAGMA wal_checkpoint(PASSIVE)` を回して閉じる。TEMP 表・ReadIdentity・stamp には関わらず、何も commit しない。背景が使えない間（止めた後・失敗が 3 回続いた後）は、hook が SQLite の既定と同じ同期の PASSIVE checkpoint に戻る（スレッドが作れないときは hook を入れず autocheckpoint のまま）。**背景が追いつかないとき（commit が続く burst、読み手が止めている間）の上限は、閾値の 4 倍（`MAX_WAL_PAGES_BEFORE_SYNC`＝4000 page、4 KiB page で約 16 MB）**：それ以上では hook が、背景の run が終わるのを最大 5 s 待ってから、同期の PASSIVE checkpoint を行う（レビュー指摘 major-2）。理由：PASSIVE は開始時点の末尾までしか書き戻さず、WAL の先頭へ戻すのは「書き手が始まる時に全部書き戻し済み」のときだけなので、書込みが速い burst では背景の 1 回の run が追いつく前に WAL が伸び続ける（試験で、150 page を 1 ms で 300 回書くと、背景だけでは 46000 frame まで伸びた）。また PASSIVE は checkpoint の lock を持つ別の接続（背景）がいると何もせず BUSY で戻るので、同期の checkpoint は背景の run と重ならないよう待ち、その間は背景が新しい run を始めない。4000 page は、既定の autocheckpoint の実測の最大（3622 page、約 15 MB）と同じ程度で、WAL の最大を今と変えない。この待ちは前景への back-pressure で、上限を超えたときだけ起こる。待ちが 5 s を過ぎる（背景が止まらない異常）ときは同期の checkpoint を試すだけで、WAL の上限は保証しない。実装は `grimodex-db/src/background_checkpoint.rs` | 信頼する：Electron main の native（`WorkspaceAuthority` の所有者）。信頼しない：renderer（SQL は従来どおり authorizer の下の本体の接続。checkpoint の接続は renderer から到達できず SQL を受けない）、他の process（standalone MCP は別の接続で、従来どおり自分の autocheckpoint）。受信先・送信先・保存範囲は変わらない（同じ file への checkpoint だけ）。防御：PASSIVE だけ（RESTART／TRUNCATE は使わない）なので書き手・読み手を待たせず、WAL の先頭へ戻すのは次の書き手 | (a) `wal_autocheckpoint=0` のまま背景だけ（背景が止まると WAL が無限に伸びる。却下）(b) polling（commit の知らせが無く、idle で起き続ける。却下）(c) 専用接続を常駐（file handle が restore・Windows の置換の邪魔になる。却下。1 回ごとに開閉する）(d) RESTART／TRUNCATE（読み手・書き手を待つ。却下） | 実装済み（Draft PR） |
| DR-DBC-1a | 2026-11-08 | **open の WAL 準備（`open_wal.rs`）の「`wal_autocheckpoint` が正」の検査の意図を確かめ、単位の出所を直す。** 意図：`prepare_wal_for_open` は、前の process が残した WAL が閾値の 3/4 以上なら RESTART で畳み、閾値を超えていたら同期の checkpoint の仕事量が大きすぎるので畳まず（`DeferredWorkLimit`）、公開前の checkpoint の仕事を「設定された autocheckpoint の 1 周期」以下に抑える。検査は、その 1 周期（page 数）が正であることを求める。つまり安全の検査というより、仕事量の単位が実際に誰かが守る正の上限であることの検査（0＝何も上限が無いなら、単位が無い）。背景が上限を守る形では pragma が 0 になる（wal hook を置くと `PRAGMA wal_autocheckpoint` は 0 を返す）。そこで、単位を `wal_cycle_pages(pragma, background)` で決める：pragma が正ならそれ、0 で背景の checkpointer が動いているならその閾値、どちらも無ければ今までどおり `OPEN_WAL_AUTOCHECKPOINT_MUST_BE_POSITIVE` で拒否する。背景の閾値を単位にしてよいのは、wal hook が実際に背景のものであると確かめられたときだけ（レビュー指摘 minor-2）：`background_checkpoint_bound` が `sqlite3_wal_hook` を同じ callback と引数で入れ直し、戻り値（直前の引数）が背景の `Shared` と一致するかを見る。一致しなければ（hook が別のものに置き換わっている）入れ直した上で上限なしとして拒否する。pragma の値は準備の前後で変えない（`verify_connection_settings` は生の値を比べる）。公開の経路では、準備は背景を始める前（`WorkspaceAuthority::new` の前）に走るので、単位は今までどおり pragma の 1000 になり、振る舞いは変わらない | 検査を外す案ではなく、上限の保証を「autocheckpoint か背景」のどちらかが必ず持つ形にした。fail-closed は保つ | (a) 検査を削除（上限が無い接続を黙って通す。却下）(b) 準備の前に背景を始める（準備の RESTART が背景の接続と競合しうる。却下） | 実装済み |

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
- 停止：冪等、停止後は同期の checkpoint に戻って WAL が畳まれる、始め直せる。**実行中の大きい checkpoint（約 80 MB の WAL）の最中に止めても、実行中であることを観測した上で、上限の中に終了の証拠が取れ、file が壊れない。**
- **`TimedOut`（注入点で run を止める）**：スレッドと JoinHandle が残り、次の stop が同じスレッドを待て、停止の要求は失敗に数えられない。restore は中止して元の authority を戻し（live は未変更）、背景が止まれば同じ restore が通る。retire は `Err` で何も変えず（接続は reusable のまま）、止まれば成功する。
- 専用の接続は最後の接続として閉じても `-wal` を消さない（対照：普通の接続は消す）。停止の要求の後の run は接続を開かない。
- 上限：背景が止まっていても、書き手が連続しても（`wait_idle` を挟まない 300 commit）、WAL は `MAX_WAL_PAGES_BEFORE_SYNC`＋最後の 1 tx 以内。
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
- B（監査の chain の検証を tx の外へ）は別の枝。同じ crate を触るが、この PR は `Database` の field・`WorkspaceAuthority::new`・open_wal・restore の 1 行・retire の 1 行だけで、監査の tx とは重ならない見込み。
