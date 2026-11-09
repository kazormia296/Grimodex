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
