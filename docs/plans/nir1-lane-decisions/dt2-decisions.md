# DT-2 decisions（GDX-PRECHECK-001：attempt の bounded create／claim／finish と lease fence）

base: branch `claude/nir1-dt2` = 3688a063（DT-1。PR #634 は未 merge）。行番号は特記がない限り、この作業ツリーの現行コードのもの。
DT-1 の判断 D1〜D6（`claude-nir1-dt1/.ralph/agent/decisions.md`）を前提にする。変える点は §7 に書く。
U3 委任の範囲（worker／owner／終了処理／lifecycle の技術判断）だけで決める。製品入口は作らない（A-1：`#[napi]` と IPC は追加しない）。
schema、migration、AttemptBinding の形は変えない。WIP の凍結コピー（#609 基点）は参考資料に限り、移植する部分は新しい候補として作り直して再試験する。
advisor の指摘5件と補足（2026-10-13、照合 HEAD 3688a063）は本文に反映済み。判断と反映先の一覧は §12。

略記：
- N-gen `electron/native/grimodex-node/src/nir1_generation.rs`、N-gate `…/nir1_startup_barrier.rs`、N-view `…/workspace_lifecycle_view.rs`、
  N-lib `…/lib.rs`、N-state `…/state.rs`、N-prof `…/profile_egress.rs`、N-prep `…/nir1_prepared_request.rs`
- D-gen `src-tauri/crates/grimodex-db/src/nir1_generation.rs`、D-conn `…/narrative_maintenance_connection.rs`、D-wl `…/workspace_lifecycle.rs`、
  D-state `…/state.rs`、D-lib `…/lib.rs`、D-tl `…/narrative_extraction/task_leases.rs`、D-mig `…/migrate.rs`

## 1. 現状の根拠（撤去・置換するもの）

1. **無制限な create**：`persist_final_request`（N-gen:1087-1137）は `storage::create_attempt`（D-gen:875-909）を呼ぶ。
   - `db.with_conn`（D-lib:806-815）は `lock_conn()`（D-lib:416-418）で DB mutex を無期限に待つ。busy_timeout は接続既定の 5 s（D-lib:301）で、per-op の上限はない。
   - attempt ID は transaction の中で `Uuid::new_v4()`（D-gen:885）を振る。そのため COMMIT の結果が不明なとき、exact ID で照合できない。
2. **guard を保持した COMMIT**：`consume_claim`（N-gen:1213-1251）の構造は次のとおり。
   - `with_prepared_claim`（D-gen:1842-1891）が DB mutex を無期限に取り、IMMEDIATE transaction を開く。
   - その中で owner の cancellation mutex（N-gen:1232-1236）、`with_authorized_dispatch`（N-prof:404-437、profile mutex を operation の間保持）、`with_current_binding`（D-wl:553-575、Core mutex を operation の間保持）を順に取り、最内で `prepared.commit`（D-gen:1823-1835）を実行する。
   - つまり COMMIT は DB・owner・profile・Core の4つを保持したまま走る。
   - D-gen:1849-1853 が participant SQL scope を拒否しているのはこのためである。progress hook（D-conn:357-375 → D-wl:580-597）は Core を取るので、保持中の Core に再入して自己 deadlock になる。結果として claim は progress handler の interrupt も per-op の上限も持たない。
3. **pairing の読取が別 transaction**：`read_exact_finalized_attempt`（N-gen:1144-1160）は無制限の `read_attempt`（D-gen:1237）を使う。claim とは別の snapshot になる。
4. **terminal と recovery も無制限**：`persist_terminal`／`recover_terminal`（N-gen:1180-1209）は `finish_attempt`／`recover_attempt`（D-gen:3286-3306）を呼び、どちらも `with_conn` を使う。
5. **cancel と transport 開始の線形化**：cancel は mutex 上の bool（N-gen:1022-1048）。transport 開始との線形化は test-only の `begin_test_transport`（:1054-1069）にしかない。
6. **idempotency と in-flight の管理がない**：create は UUID なので、同じ submission から何件でも attempt ができる。
7. **P3(a)**：Open（N-lib:10054）、Restore（:10531）、Safe Mode restore（:10683）の各 async 本体は tokio worker の上にある。ここから `publish_workspace_lifecycle_from_workspace`（N-lib:2208-2216）を同期で呼ぶ。
   - 経路：N-view:676-681 → N-view:786-791 の `drain_before_ready`（N-gate:165-179、Condvar で最大 250 ms 待つ）。
   - `publish_workspace_lifecycle_recovery_after_join`（N-lib:10052、:10371、:10529）は RecoveryRequired を要求する分岐（N-view:750-785）を通るので、drain に入らない。
8. **P3(b)**：exact revision の比較が5か所ある。
   - hook（N-gen:812-815）、worker start（:599-617）、capture（:312-316、:333-338）、sweep の各 checkpoint（:451-459）、Join 後の open（:758-761）。
   - gate の entry も (binding, revision) の完全一致で判定する（N-gate:82-86、`try_lease` :245-264）。
   - 一方、Core は Ready のまま revision だけを上げる経路を持つ。
     - C-query quarantine の set（D-wl:1716-1778、:1772）と release（:1780-1791。seam を通らない直接 lock）
     - `complete_background_recovery`（:2121-2160）
     - Ready 中の `abandon_background_recovery`（:2057-2119）
   - seam はこれらを edge にしない（D-wl:222-224、:264-268。DT-1 の D1）。
   - その結果、次の liveness 制限が生じる。
     - Ready と Join の間にこれらが入ると、sweep が `NIR1_GENERATION_RECOVERY_BINDING_CHANGED` で Incomplete になり、gate は Consumed になる（N-gate:359-375）。
     - Open の後に入ると、claimant が Core の現在の revision を提示するかぎり、lease は永久に拒否される。
9. **P3(c)**：`open_after_joined_sweep(binding, revision)`（N-gate:222-241）は、`Recovering{entry, swept:true}` であれば誰でも開けられる。
   - worker の記録（N-gen:728-736）と supervisor の open（:884-894 → :742-767）は、ledger の状態でしか結ばれていない。
   - JoinHandle の出力は `()`（:464-468）である。

## 2. 信頼境界

- **入口**：Native 内部の Rust 呼出しだけ。
  - 追加する型と関数は Native では `pub(crate)`。DB 側の `pub` 関数は crate 外の Rust に出るが、N-API の型ではない。
  - wire 型と serde の入力型は持たない。renderer の値（submission_id、route、digest、時刻）は、どれも owner の認可にならない。
- **caller**：main が発行し、profile egress に登録した `CallerIdentity`。
  - capture 時に一度、`begin_dispatch`（N-prof:299-334）と `with_authorized_dispatch`（:404-437）で検証する。
  - 以後は permit の atomic（`ensure_open`、:685-695）で失効を見る。
  - submission の中の caller と workspace_binding（N-prep:193-199 の private field）は、owner からは照合できない（残余）。N-prep は許可ファイルの外にあり、accessor もないため。次の2点で代替する。
    - caller：owner が受け取る `CallerIdentity` を profile の登録で検証し、legacy の形のまま `caller.session_id == capture.chat_session_id` を要求する（§11-6）。
    - workspace：create の transaction で、owner の pin した DB の capture 行が exact に一致し、`state='current'` であることを確かめる（§5.1）。
  - profile 側の権限の変化は、必ず `revoke_permits`（:593-595）か `admissions_open=false` を伴う。対象は登録の置換（:251-269）、`begin_startup_barrier`（:231-247）、`invalidate_callers`（:336-340）、`bind_workspace`（:346-351）、route 更新（:570-584）。したがって atomic だけで漏れなく観測できる。
- **submission**：冪等鍵の出所は、capture writer が mint した `NativeAcceptedChatSubmission`（N-prep:193-213）の Deref 先 `AcceptedChatInputCapture`（D-gen:551-596）だけにする。
  - `AcceptedChatInputCapture` の field は private で、DB crate の外からは作れない。
  - 鍵には、DB の capture 行（D-mig:4174-4199）と submission key 行（D-mig:4206-4216）に既にある値だけを使う。
- **workspace**：Core の `Ready(LiveBinding)` と gate の exact Ready entry。renderer の binding token は使わない。
- **durable と process-local**：attempt の claim と terminal の正本は、DB の条件付き UPDATE（D-gen:1928-1932、:3256-3269）。
  - registry と gate は process-local で、永続化しない。restart 後は空・Closed から始まる（§8）。
- **時刻**：上限と deadline は monotonic な `Instant`。wall clock は、durable な created／claimed／completed の時刻と expiry の判定だけに使う（既存どおり）。
- **試験専用のもの**：recorder、failpoint、probe。
  - `cfg(test)` か、`workspace-maintenance-test-support` feature（Native の dev-dependency だけが有効にする。Native Cargo.toml:78）の中にだけ置く。
  - 製品 build と renderer からは到達できない。

## 3. 有限 owner/lifecycle matrix

| 項目 | owner | 有限性・終了の証拠 |
|---|---|---|
| entry | Native 内部の呼出しだけ（DI-1c が将来つなぐ）。入力は、main 発行の `CallerIdentity`、capture writer の `NativeAcceptedChatSubmission`、coordinator の `FinalDispatchRequest`（N-gen:66-83。wire 型ではない） | `Nir1GenerationOwner::capture` は permit → Core snapshot → gate lease → participant → registry の順に、短い lock を1つずつ取る（入れ子にしない） |
| start | `capture` が registry の slot を予約する（allocation の前に上限を検査）。続く `create` が lease の下で bounded create を行う | 予約は RAII。create の前に drop すれば durable な効果は残らない |
| retry | COMMIT 前の typed error（ConnectionBusy／SqliteBusy／TimedOut／Fenced）は、呼出し側が同じ submission で新しい owner を作って再試行できる。ID は決定的なので二重の create にはならない。terminal の後に同じ submission が来たら `SubmissionAlreadyAttempted`（新しい attempt は作らない）。zero-send terminal の書込みだけは、owner の中で最大3回まで繰り返す。繰り返すのは一時的な失敗（ConnectionBusy／SqliteBusy／TimedOut／ConnectionUnavailable、COMMIT の結果不明）だけ。既存 terminal との衝突と claim の不一致は繰り返さない（§5.4 の settle） | 内部の再試行は回数で有限（1回あたり ≤250 ms、zero-send は合計 ≤750 ms） |
| reentrant | 同じ submission の2つ目の capture は `SameSubmissionInFlight{attempt_id}`。同じ session の別 submission は `SessionBusy`。owner は消費型（typestate）なので、同じ値で create や claim を二度は呼べない | registry の mutex は短い。typestate の制約はコンパイル時に効く |
| admission closure | gate（DT-1）は lifecycle edge ごとに閉じ、epoch+1 する。lease の currency は epoch の atomic mirror で、lock なしに読める。participant は Transition／RecoveryRequired／Closed／shutdown／compat switching で stop になり（D-wl:577-597）、quarantine 中は新しい participant を拒否する（D-wl:1681-1691）。Admission の SQL は、participant の stop に加えて、lease の失効（epoch mirror）と permit の失効を fence probe で観測する（§5.1）。このため participant の stop を伴わない gate の閉鎖でも止まる。該当するのは、他の owner の `quarantine_entry`、gate の poison、Transition を伴わない Ready の再公開（現行の Core では participant の保持中に起きない。E15） | edge は Core の lock 内で同期的に処理される。owner は次の checkpoint で観測する（progress hook は 1000 VM step ごと、mutex の取得 loop は 1 ms ごと、op の境界）。SQLite の busy 待ちの間は progress hook が呼ばれないので、観測は busy の上限（100 ms）まで遅れうる |
| pending start | capture 済みで create がまだ COMMIT していない owner。slot は InFlight（attempt なし） | create の bounded op（≤250 ms）か、owner の drop で終わる |
| active lease ownership | `Nir1StartupLease` は `create` と `claim_for_transport` の、それぞれの呼出しの局所値。COMMIT、post-commit の再検証、開始判断の間だけ保持する。zero-send terminal を書く前と transport を開始する前に drop する。lease を保持している間の Admission op は、lease 自身の失効と permit の失効を fence probe で観測する。gate がどの edge で閉じても `Fenced` で止まる | 1回の呼出しは、bounded op 1回と短い検査だけ。lease の保持中に await しない（同期関数の局所値で、owner は blocking thread で動く）。gate が閉じてから lease を drop するまでにかかるのは、op の停止（mutex 待ちは 1 ms、SQL は 1000 VM step、busy 待ちは ≤100 ms）と短い検査だけ。drain と begin_recovery の 250 ms に、edge の種類によらず収まる |
| participant／authority | owner は `ActiveWorkspaceSnapshot`（authority、participant、exact binding。D-state:230-262）を生涯保持する。transport 中も保持する | transition の physical exclusive は participant が 0 になるのを待つ（D-wl:3684-3696）。owner は stop を観測して bounded に settle し、drop で返す。DT-5 は transport の cancel（close→join）を有限にする |
| cancel | `Nir1OwnerCancel::cancel()` は stop flag を立てる。flag を渡すのは Admission の budget（create と claim）だけで、その SQL を interrupt する。Pinned の writer（zero-send、exact reread、transport 後の terminal と recover）は flag を受け取らない型にする（§5.1）。owner の phase mutex で開始判断と線形化する。DB は待たない | 開始判断の前の cancel：exact owner が zero-send Cancelled を1回書く。Pinned は cancel で interrupt されないので、cancel の後でもこの terminal を書ける。開始後の cancel：DT-5 が扱う |
| 有限待機 | DB mutex 100 ms。SQLite busy 100 ms（per-op の残り時間で clip）。per-op 250 ms（開始から数え、mutex 待ちを含む。progress handler の interrupt と checkpoint で守る）。drain 250 ms（N-gate:25）。begin_recovery 250 ms。sweep 5 s（N-gen:131）。zero-send の書込み 3回。registry 16 slot | 上限を超えたら typed error を返す。IMMEDIATE transaction を rollback するので部分書込みは残らない。接続は scope の cleanup（D-conn:971-1052）で、progress handler 解除 → ROLLBACK → autocommit 確認 → busy_timeout 復元の順に戻す。cleanup が失敗したら quarantine と retire（D-conn:1321-1356） |
| 実際の終了証拠 | durable：attempt 行の `claimed_at_ms`／`terminal_json`（DB の CAS）。process-local：owner の typestate の消費、registry slot の release、lease の Drop（gate の count）、participant の Drop（Core の count） | timeout は終了とみなさない。slot と participant は owner が drop するまで残り、gate の lease count も DT-1 どおり残る |
| error | COMMIT 前の失敗（NotCommitted）：attempt がまだなければ refusal を返す。attempt があれば zero-send terminal を書く。COMMIT の結果不明（Unknown）：pinned の exact reread で照合する。自分の claim と照合できれば続行するか zero-send を書く。別の claimer の claim なら terminal を書かない（ClaimLost）。照合できなければ gate を quarantine し、slot を Unresolved にし、owner は participant を返す。zero-send の書込みが上限の3回まで失敗したとき（Conflict など、再試行しても変わらない失敗で終わったときも同じ。§5.4）も、slot を Unresolved にする。ただし gate は quarantine しない。COMMIT の状態は既知で送信も始まっておらず、次の Ready entry の sweep が InterruptedUnknown で終端化するため | reread も bounded（≤250 ms）。zero-send は ≤3×250 ms |
| timeout | per-op の timeout は、COMMIT 前なら NotCommitted、COMMIT の最中か後なら Unknown に分類する | 同上 |
| onClosed（shutdown／Unavailable） | participant の stop で、admission 側の SQL は Fenced になる。owner は pinned で zero-send を書き、participant を返す。shutdown の後、gate は永久に Closed | `finish_workspace_shutdown`（N-lib:3123-）は participant が 0 になるのを待つ。owner の settle は bounded |
| transport 開始後 | `Nir1TransportOwner` が participant、permit、slot を持つ。terminal は `finish`（pinned、bounded）で書く。finish せずに drop したら、pinned の recover（InterruptedUnknown、§5.1 の `recover_claimed_attempt_bounded`）を1回書く。それも失敗したら slot を Unresolved にする。gate は quarantine しない（理由は error 行と同じ） | transport の実体と、edge による cancel は DT-5 が作る |
| restart | gate は Closed、registry は空から始まる（永続化しない）。durable な pending attempt は、次の Ready entry の sweep（#610）が InterruptedUnknown で終端化してから gate を開く。前の process の submission は capture owner が変わるので digest が一致せず、再受理されない（D-gen:2532-2546、:2348-2362） | sweep は exact entry ごとに 5 s 以内 |

## 4. lock 順

- **L0**：「外側 → 内側」は、外側を保持したまま内側を待ってよい向きを表す。
- **L1**：owner phase → Core → gate → {profile, registry}。
  - DB 接続の mutex は、これらのどれを保持していても取得も保持もしない。
  - COMMIT は Core／gate／profile／registry／owner phase のどれも保持せずに走る。これで TASK の「Core → gate → profile／participant → DB mutex」の向きを守る。
- **L2**：DB mutex を保持している間に取ってよいのは、leaf の短い読取だけ。
  - 該当するのは participant progress hook による Core の読取（既存。D-conn:357-375。#610 の sweep と #611 の capture と同じ）。
  - gate は atomic mirror で、profile は permit の atomic（N-prof:685-695）で読み、mutex を取らない。
  - Admission の fence probe（§5.1）もこの読取だけで作る。読むのは、lease の epoch mirror と poison mirror、permit の2つの atomic。owner の cancel は budget の stop flag として別に読む。
- **L3**：既存の順序はそのまま。ledger → Core → gate（N-gen:741-767）、Core → gate（observer、D-wl:332-351）。
- **L4**：Condvar の待機（drain／begin_recovery）は gate の mutex 以外を保持しない。registry と owner phase は Condvar を持たない。
  - registry は gate の epoch を lock の外で読んでから自分の mutex を取る（入れ子にしない）。
- **L5**：await をまたいで mutex も lease も持たない。owner の API は同期関数で、blocking thread から呼ぶ。
  - lease を保持している間の Admission op は、gate の閉鎖を fence probe で観測して止まる（§3 の active lease ownership）。
  - lease の保持時間は、edge が participant の stop を伴うかどうかに依存しない。drain と begin_recovery の上限（250 ms）に対する余裕は、op の停止の遅れ（≤100 ms）と短い検査だけで決まる。
- **deadlock がないことの論拠**
  - DB を待つ者は、他の mutex を持たない（L1）。
  - DB を持つ者が取る Core は leaf で（L2）、Core の保持者は DB を待たない。その唯一の例外だった `consume_claim` は DT-2 で撤去する。
  - gate／profile／registry の保持者は、どれも他の lock を待たない。

## 5. API の型

### 5.1 DB（grimodex-db `nir1_generation.rs`。数値はここ1か所に置く）

```rust
pub const NIR1_GENERATION_DB_MUTEX_WAIT_LIMIT: Duration = Duration::from_millis(100);
pub const NIR1_GENERATION_SQLITE_BUSY_LIMIT: Duration = Duration::from_millis(100);
pub const NIR1_GENERATION_OPERATION_LIMIT: Duration = Duration::from_millis(250); // 開始から。mutex 待ちを含む

/// admission の内側にいる間だけ true を返す。lock を取らない atomic の読取だけで作る（L2）
pub type Nir1AdmissionProbe = Arc<dyn Fn() -> bool + Send + Sync>;

/// create と claim 用。owner の cancel、participant の stop、probe の失効で止まる
#[derive(Clone)]
pub struct Nir1AdmissionSqlBudget { /* cancel: Arc<AtomicBool>, probe, 上限3つ, test-support の failpoint */ }
impl Nir1AdmissionSqlBudget {
    pub fn new(cancel: Arc<AtomicBool>, probe: Nir1AdmissionProbe) -> Self; // 計画の既定値
}
/// zero-send、transport 後の terminal と recover、exact reread 用。stop も probe も持たず、上限3つだけで有限
#[derive(Clone, Debug)]
pub struct Nir1PinnedSqlBudget { /* 上限3つ, test-support の failpoint */ }
impl Nir1PinnedSqlBudget {
    pub fn new() -> Self; // 計画の既定値（`Default` も同じ値にする）
}
// 両方の budget に、試験用の次の2つを置く（cfg(any(test, feature = "workspace-maintenance-test-support"))）
//   fn tightened(self, mutex: Duration, busy: Duration, operation: Duration) -> Self; // 既定以下だけ（assert）
//   fn with_failpoint(self, failpoint: Nir1GenerationFailpoint) -> Self;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1CommitState { NotCommitted, Unknown }
#[derive(Clone, Copy, Debug, Eq, PartialEq)] #[non_exhaustive]
pub enum Nir1StoreFailure {
    ConnectionBusy, SqliteBusy, TimedOut, Fenced, Cancelled, ConnectionUnavailable, SqlOwnerActive,
    AlreadyExists, Conflict, TerminalConflict, ClaimMismatch, Expired, NotCurrent, Missing, Invalid,
}
#[derive(Debug)]
pub struct Nir1GenerationStoreError { /* failure, commit, claim_written_at_ms: Option<i64>, source: anyhow::Error */ } // Display はコードだけ
impl Nir1GenerationStoreError {
    pub fn failure(&self) -> Nir1StoreFailure;
    pub fn commit(&self) -> Nir1CommitState;
    pub fn claim_written_at_ms(&self) -> Option<i64>; // claim の Unknown のときだけ Some。transaction の中で UPDATE に使った時刻
}
/// claim／terminal の writer が、自分の transaction の中で照合する不変の field
#[derive(Clone, Debug)]
pub struct Nir1ExpectedAttempt {
    pub id: String, pub binding: AttemptBinding, pub payload_digest: String, pub input_digest: String,
    pub inputs: Vec<InputReference>, pub qualifications: Vec<QualificationReference>, pub read_budget: ReadBudget,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1ClaimOutcome { Claimed { claimed_at_ms: i64 }, AlreadyClaimed { claimed_at_ms: i64 }, AlreadyTerminal }
/// zero-send の writer が同じ transaction で照合する claim の状態
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1ExpectedClaim { Unclaimed, ClaimedAt(i64) }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1ZeroSendCompletion { Cancelled, DispatchFailure }

#[cfg(feature = "native-current-human-capture")]
pub fn attempt_id_for_capture(capture: &AcceptedChatInputCapture) -> Result<String>;
#[cfg(feature = "native-current-human-capture")]
pub fn create_attempt_for_capture_bounded(
    workspace: &ActiveWorkspaceSnapshot, capture: &AcceptedChatInputCapture, request: NewAttempt,
    budget: &Nir1AdmissionSqlBudget, pre_commit: &mut dyn FnMut() -> anyhow::Result<()>,
) -> Result<StoredAttempt, Nir1GenerationStoreError>;                    // Admission fence
pub fn claim_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot, expected: &Nir1ExpectedAttempt,
    budget: &Nir1AdmissionSqlBudget, pre_commit: &mut dyn FnMut() -> anyhow::Result<()>,
) -> Result<Nir1ClaimOutcome, Nir1GenerationStoreError>;                 // Admission fence
pub fn finish_pretransport_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot, expected: &Nir1ExpectedAttempt, claim: Nir1ExpectedClaim,
    completion: Nir1ZeroSendCompletion, budget: &Nir1PinnedSqlBudget,
) -> Result<StoredTerminal, Nir1GenerationStoreError>;                   // Pinned fence。本文は受け取らない
pub fn finish_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot, expected: &Nir1ExpectedAttempt, observation: &TerminalObservation,
    body: Option<NewMessageBody>, now_ms: i64, budget: &Nir1PinnedSqlBudget,
) -> Result<StoredTerminal, Nir1GenerationStoreError>;                   // Pinned fence。transport の後（DT-5）
pub fn recover_claimed_attempt_bounded(
    workspace: &ActiveWorkspaceSnapshot, expected: &Nir1ExpectedAttempt, budget: &Nir1PinnedSqlBudget,
) -> Result<StoredTerminal, Nir1GenerationStoreError>;                   // Pinned fence。transport 開始後に finish せず drop したとき
pub fn read_attempt_exact_bounded(
    workspace: &ActiveWorkspaceSnapshot, id: &str, read_budget: ReadBudget, budget: &Nir1PinnedSqlBudget,
) -> Result<Option<StoredAttempt>, Nir1GenerationStoreError>;            // Pinned、read transaction。None は確認済みの不在
pub fn ensure_attempt_workspace_current(workspace: &ActiveWorkspaceSnapshot) -> Result<(), Nir1GenerationStoreError>;
// ↑ D-state:251-258 の check_current_binding の wrapper：exact Ready binding であり、quarantine 中でも switching 中でもないこと
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub enum Nir1GenerationFailpoint { ErrorAfterCommit, VetoCommit, ProbeDuringCommit(Arc<dyn Fn() + Send + Sync>) }
```

- **budget の型を分ける**：Pinned の関数は `Nir1PinnedSqlBudget` しか受け取らない。owner の cancel や probe を Pinned の writer に渡す取り違えは、コンパイル時に拒否される（§3 の cancel 行、E3）。
  - 1本の budget を共有すると、cancel の後の Cancelled terminal 自体が interrupt される。scope は op の境界（`check_participant_sql_control`、D-conn:377-389）と progress hook の両方で stop を読むからである。
- **Admission の fence probe**：probe は、mutex の取得 loop の check（1 ms ごと）、op の境界の check、progress hook（1000 VM step ごと）のすべてで読む（§5.2）。偽になったら op は止まる。
  - Native は probe を `lease.witness().is_current() && permit.ensure_open().is_ok()` で作る。どちらも atomic だけを読む（§5.3、N-prof:685-695）。owner は permit を `Arc<ProfileDispatchPermit>` で持ち、probe の closure に clone を渡す。
  - budget は呼出しごとの局所値にする（lease と同じ寿命）。closure は、scope の cleanup で progress handler と一緒に外れる。
  - SQLite の busy 待ちの間は progress hook が呼ばれないので、その間の観測は busy の上限（100 ms）まで遅れる。
- **Fenced と Cancelled の分類**：scope の中では、participant の stop も budget の stop（owner の cancel）も `ValidationTerminationReason::Cancelled` になる（D-conn:357-363）。probe の失効は `Closed` にする（§5.2）。
  - D-gen は op が終わった後で owner の cancel flag を読み直す。立っていれば `Cancelled`、立っていなければ、participant の stop と probe の失効を `Fenced` にする。終わった後に読み直すのは `preserve_participant_stop`（D-conn:321-337）と同じ作法。
- **入れ子の SQL owner の前置き検査**：この節の bounded 関数はすべて、participant scope に入る前（DB mutex を取る前）に `nir1_capacity::attempt_active()` と `any_sql_owner_scope_active()` を検査する。どちらかが真なら `SqlOwnerActive`（NotCommitted）で返す。
  - transaction の中では判定できない。bounded 関数は、自分が scope に入った時点で `SCOPE_CONNECTIONS` に積まれる（`enter_scope`、D-conn:148-158）。そのため `any_sql_owner_scope_active()` は常に真になる。
  - D-conn:159-163 の doc も「DB lock の前に検査する」と書いている。既存の `with_prepared_claim` も DB lock の前で検査している（D-gen:1849-1853）。
  - 拒否する理由は従来どおり。nested scope は自分の上限を持たない（D-conn:806-822）。
- **create の芯**：`pub(crate) fn create_attempt_with_id_bounded(workspace, id, request, budget, pre_commit)` は capture に依存しない。`create_attempt_for_capture_bounded` は capture の検査と ID の導出をしてから、これを呼ぶ。
- **create の transaction**（前置き検査の後、1つの IMMEDIATE transaction で行う）
  1. request の binding が capture と一致することを確かめる。
     - `project_id == capture.project_id`
     - `session_id == capture.chat_session_id`（legacy の形のまま。分離は DT-3）
     - inputs に User の `Message{version_id == capture.message_version_id, parent: None}` がある
  2. capture 行が exact に一致し、`state='current'` であることを確かめる。
  3. 決定的 ID の行が既にあれば `AlreadyExists` を返す。
  4. `require_session`、`validate_refs`（ReadBudget で上限を検査）、INSERT（attempt と refs）を行う。
  5. `pre_commit()` を呼んでから COMMIT する。
- **claim の transaction**
  1. 不変の field（binding、digest、inputs、qualifications）を同じ transaction の中で照合する（不一致は `Conflict`）。
  2. terminal があれば `AlreadyTerminal`、claimed があれば `AlreadyClaimed`。
  3. 時刻を transaction の中で取り、expiry を検査する。この時刻を UPDATE に使い、op closure の外の cell にも記録する。
  4. `validate_refs`、条件付き UPDATE、`pre_commit()` の後に COMMIT し、`Claimed{claimed_at_ms}` を返す。
  - ReadyToCommit の marker の後で Err になったら（Unknown）、cell の時刻を error の `claim_written_at_ms` に載せる。marker は UPDATE より後なので、claim の Unknown は必ず時刻を持つ。owner は reread のとき、この時刻で自分の claim かどうかを照合する（§5.4 手順4）。
- **zero-send の writer**（`finish_pretransport_attempt_bounded`）：observation は `OutputObserver::new().finish(Cancelled|DispatchFailure)` を DB の中で作る（外から受け取らない）。1つの IMMEDIATE transaction で次の順に行う。
  1. 不変の field を照合する（不一致は `Conflict`）。
  2. claim の状態を `Nir1ExpectedClaim`（未 claim、または自分の `claimed_at_ms`）と照合する。違えば `ClaimMismatch` を返して書かない。
     - 目的は、別の claimer が transport している attempt に terminal を書かないこと。reread から zero-send までの間の TOCTOU も、DB の中で閉じる。
     - terminal の比較より先に行う。別の claimer の transport が自分と同じ terminal（DispatchFailure）で終わっていても、自分の冪等な再書込みと取り違えない。zero-send は claim の状態を変えないので、自分の前回の書込みはこの検査を必ず通る。
  3. 既存の terminal があれば書かない。自分が書く terminal と observation・failure_classification の両方が同じなら、既存を返す（冪等。前回の自分の書込みが Unknown だった場合にあたる）。違えば `TerminalConflict` を返す。
     - observation だけでは比べない。sweep の InterruptedUnknown は DispatchFailure と同じ observation を持つ（`recover_attempt_in_tx`、D-gen:3308-3314）。既存の比較（D-gen:3161-3178）のままでは、sweep の terminal を自分の zero-send と取り違える。
  4. terminal を書く（failure_classification は E12 の写像）。
- **Pinned の recover**（`recover_claimed_attempt_bounded`）：不変の field を照合してから、`recover_attempt_in_tx`（D-gen:3308-3314）と同じ InterruptedUnknown を書く。既存の terminal があれば、それを返す。
- **commit の分類**：op closure の最後で phase を `ReadyToCommit` にする。
  - その後に Err になったら `Unknown`（COMMIT の失敗、または post-commit の fence と区別できないため）。それより前の Err は `NotCommitted`。
  - D-tl:553-597 の `RunCreationTransactionOutcome` と同じ考え方を使う。
- **pre_commit**：atomic だけを読む。panic したら op の中で catch して rollback し、scope を抜けてから resume する（D-gen:1855-1890 の既存の作法）。こうすれば接続は再利用できる状態のまま残る。
- **撤去**：`PreparedClaim`、`with_prepared_claim`、`claim_attempt_in_tx`。
- **test-support に限定**：`create_attempt`、`claim_attempt`、`finish_attempt`、`recover_attempt`、`read_attempt`、`read_terminal`、`pending_attempt_ids`。
  - `#[cfg(any(test, feature = "workspace-maintenance-test-support"))]` で囲み、製品 build から無制限な generation writer を構造的になくす。
- **recover（sweep）**：`recover_attempt_bounded`（D-gen:3319-3332）は sweep の意味（admission fence、lifecycle の変化で止まる）を保つ。上限は上の定数を参照し、mutex 100 ms の上限を足す。owner の Pinned の recover とは別の関数のままにする。
- **module doc**：D-gen:1-6 の「caller が claim と認可を serialize する」という記述を、新しい分担（§6 E1）に書き換える。

### 5.2 DB（`narrative_maintenance_connection.rs`。bounded な接続取得のための最小の変更）

```rust
impl ParticipantSqlOperationBudget {
    pub fn with_connection_lock_timeout(self, timeout: Duration) -> Self; // DB mutex の待機だけを別に上限化する
}
pub(crate) enum ParticipantSqlFence {
    /// participant の stop、budget の stop、probe（lock なしの predicate）を観測する
    Admission { probe: Option<Arc<dyn Fn() -> bool + Send + Sync>> },
    /// participant は数えたまま。stop も probe も観測せず、deadline／busy／mutex の上限だけを守る
    Pinned,
}
impl Database {
    pub(crate) fn with_participant_immediate_transaction_bounded_in<T, F>(&self, participant: &WorkspaceParticipant,
        fence: ParticipantSqlFence, budget: ParticipantSqlOperationBudget, operation: F) -> Result<T>;
    pub(crate) fn with_participant_read_transaction_bounded_in<T, F>(/* 同上 */) -> Result<T>;
}
```

- 既存の `with_participant_*_bounded`（D-conn:1170、:1207）は、`fence=Admission{probe:None}` の薄い wrapper として残す。#610 の sweep と #611 の capture の挙動は変えない。
- fence は2つの `_in` 関数だけでなく、private の scope 関数 `with_participant_sql_scope_config_with_stop_and_timeout`（D-conn:1280-1357）まで通す。`_in` 関数を足すだけでは Pinned にならない。
  - この関数は、入口で無条件に `check_participant` を呼ぶ（:1291）。hook に participant を渡し（:1292）、mutex の取得 loop（:1295-1297）と op の前後（:1314、:1316）で `check_participant_sql_control` を呼ぶ。
  - `_in` 関数の中の `budget.check(participant)` と `preserve_participant_stop`（D-conn:1190-1197、:1227-1238 にあたる箇所）も fence に従わせる。
  - Pinned：入口の `check_participant` をしない。`config.participant=None` にする。取得 loop と op の前後の検査は deadline だけにする。budget の stop の代わりに、常に false の flag を渡す。
  - Admission：既存の検査に probe を足す。probe は、取得 loop の check、op の前後の check、progress hook のすべてで読む。偽なら `ValidationTerminationReason::Closed` で止める。`NarrativeMaintenanceGraphControlConfig` に probe の field を1つ足し、hook は既存の `closed` と同じ位置で読む。
- `Pinned` の意味：participant は数えたまま（authority の差し替えは physical exclusive が待つ）にする。ただし participant の stop も、owner の cancel も、probe も観測しない。
  - deadline、busy、mutex の上限は保つ。
  - 使うのは owner 自身の cleanup（zero-send、transport 後の terminal と recover、exact reread）だけ。
- mutex 上限を超えたときは、専用の marker（`NIR1_SQL_CONNECTION_LOCK_TIMEOUT`）で返す。これで `ConnectionBusy` を、op の deadline 超過（`TimedOut`）と区別できる。
- 参考：WIP の `connection_lock_timeout`（凍結コピー tracked.diff:3437-3672）と同じ形。新しい候補として作り直し、試験し直す。

### 5.3 Native gate（`nir1_startup_barrier.rs`）

```rust
pub(crate) struct Nir1SweepProof { /* shared, epoch, entry。Clone しない */ }  // 未使用で Drop したら Closed＋Consumed
impl Nir1StartupRecovery { pub(crate) fn record_complete_sweep(self) -> Option<Nir1SweepProof>; }
impl Nir1StartupAdmissionGate {
    pub(crate) fn open_after_joined_sweep(&self, proof: Nir1SweepProof) -> bool;            // P3(c)
    pub(crate) fn try_lease_for_binding(&self, binding: &LiveBinding) -> Option<Nir1StartupLease>; // P3(b)
    pub(crate) fn try_lease_for_witness(&self, witness: &Nir1EntryWitness) -> Option<Nir1StartupLease>; // 同じ epoch・entry の Open のときだけ（§5.4 手順4）
    pub(crate) fn current_ready_entry(&self) -> Option<(LiveBinding, StateRevision)>;      // 最新 closure の Ready entry
    pub(crate) fn is_current_ready_entry(&self, binding: &LiveBinding, revision: StateRevision) -> bool;
    pub(crate) fn open_entry_epoch(&self) -> Option<u64>;                                   // registry の Unresolved の解除用
    pub(crate) fn quarantine_entry(&self, witness: &Nir1EntryWitness) -> bool;              // 同じ entry なら Closed＋Consumed、epoch+1
}
impl Nir1StartupLease {
    pub(crate) fn is_current(&self) -> bool;      // lock を取らない（epoch と poisoned の atomic mirror）
    pub(crate) fn binding(&self) -> &LiveBinding;
    pub(crate) fn entry_revision(&self) -> StateRevision;
    pub(crate) fn witness(&self) -> Nir1EntryWitness;
}
#[derive(Clone)] pub(crate) struct Nir1EntryWitness { /* shared, epoch, entry。数えない参照 */ }
impl Nir1EntryWitness {
    pub(crate) fn is_current(&self) -> bool;      // lease と同じ判定を lock なしで行う（fence probe と should_stop 用）
}
```

- `Shared` に `epoch_mirror: AtomicU64` と `closed_mirror: AtomicBool` を足す。どちらも gate の mutex の中で Release で更新する。
  - lease は Open(entry)@e でしか発行されない。Open から出るには、epoch+1（close、quarantine、shutdown）か poison しかない。
  - したがって「mirror の epoch == e かつ poison でない」は、mutex で見た `is_current` と同値になる。witness の `is_current` も同じ判定で、Admission の fence probe はこれを読む（§5.1）。
- `try_lease_for_witness` は、gate が witness と同じ epoch で、同じ entry（`Arc::ptr_eq`）の Open のときだけ lease を出す。
  - 使うのは、claim の Unknown を reread で照合した後に、開始判断のための lease を取り直すときだけ（§5.4 手順4）。
  - 別の entry では出さない。その entry の sweep が、claim 済みの attempt を既に InterruptedUnknown にしている可能性があるため。同じ entry は Open の後に sweep を走らせないので、取り直しても安全。
- `Nir1SweepProof` の Drop は、`Nir1StartupRecovery::drop`（N-gate:359-375）と同じ照合をする。
  - epoch が同じで、phase が同じ entry（`Arc::ptr_eq`）の `Recovering{swept:true}` のときだけ、Closed＋Consumed にする。
  - 新しい closure の後で古い proof を drop しても、新しい entry には触れない。`open_after_joined_sweep(proof)` も同じ epoch と `Arc::ptr_eq` で照合し、一致しなければ false を返す。
- 既存の `try_lease(binding, revision)` は、exact entry 用の API として残す。

### 5.4 Native owner（新規 `nir1_generation_owner.rs`。製品の利用者はまだないので `cfg_attr(not(test), allow(dead_code))`）

```rust
pub(crate) const NIR1_GENERATION_MAX_TRACKED_SESSIONS: usize = 16;
pub(crate) const NIR1_ZERO_SEND_TERMINAL_ATTEMPTS: usize = 3;

pub(crate) struct Nir1GenerationOwner { /* state, workspace: ActiveWorkspaceSnapshot, _operation: WorkspaceOperationGuard,
    permit: Arc<ProfileDispatchPermit> /* fence probe に clone を渡す */, caller, live_binding, workspace_digest, route_revision,
    capture: AcceptedChatInputCapture, attempt_id, slot: Nir1SessionSlotGuard, control: Arc<Nir1OwnerControl> */ }
impl Nir1GenerationOwner {
    pub(crate) fn capture(state: Arc<AppState>, caller: CallerIdentity,
        submission: &NativeAcceptedChatSubmission) -> Result<Self, Nir1GenerationRefusal>;
    pub(crate) fn cancel_handle(&self) -> Nir1OwnerCancel;
    pub(crate) fn create(self, request: FinalDispatchRequest) -> Result<Nir1PreparedAttempt, Nir1GenerationRefusal>;
}
pub(crate) struct Nir1PreparedAttempt { /* owner の field と FinalizedAttempt */ }  // Drop: 未消費なら abandon と同じ settle（下記）
impl Nir1PreparedAttempt {
    pub(crate) fn claim_for_transport(self) -> Nir1TransportDecision;
    pub(crate) fn abandon(self) -> Nir1Settlement;   // cancel 済みなら Cancelled、それ以外は DispatchFailure
}
pub(crate) enum Nir1TransportDecision { Start(Nir1TransportOwner), NotStarted(Nir1Settlement) }
pub(crate) struct Nir1TransportOwner { /* Clone しない1回限りの capability */ }  // Drop: finish 前なら pinned recover を1回
impl Nir1TransportOwner {
    pub(crate) fn canonical_payload(&self) -> &str;
    pub(crate) fn attempt_id(&self) -> &str;
    pub(crate) fn should_stop(&self) -> bool;        // cancel か、entry witness の失効
    pub(crate) fn finish(self, observation: &TerminalObservation, body: Option<NewMessageBody>)
        -> Result<StoredTerminal, Nir1GenerationRefusal>;
}
#[derive(Clone)] pub(crate) struct Nir1OwnerCancel { /* Arc<Nir1OwnerControl> */ }
impl Nir1OwnerCancel { pub(crate) fn cancel(&self); }   // stop flag と phase mutex だけを触る。DB は待たない
pub(crate) enum Nir1Settlement {
    ZeroSend(StoredTerminal),   // 自分の zero-send terminal が durable（冪等な返却を含む）
    AlreadySettled,             // 既に別の terminal がある（claim が AlreadyTerminal、または zero-send が TerminalConflict）
    ClaimLost,                  // 別の claimer の claim（AlreadyClaimed、reread の時刻の不一致、ClaimMismatch）。terminal は書かない
    Unresolved { attempt_id: String, gate_quarantined: bool },
    // ↑ slot を Unresolved にした。gate_quarantined が true になるのは、COMMIT の結果不明を照合できなかったときだけ。
    //   zero-send が上限回数で失敗したときは false（COMMIT の状態は既知で送信もない。次の Ready entry の sweep が終端化する）
}
#[non_exhaustive] pub(crate) enum Nir1GenerationRefusal {
    WorkspaceNotReady, WorkspaceUnavailable, GateClosed, ProfileRevoked, RouteChanged, Cancelled,
    SubmissionMismatch, SubmissionNotCurrent, SameSubmissionInFlight { attempt_id: String }, SessionBusy,
    SessionUnresolved { attempt_id: String }, SubmissionAlreadyAttempted { attempt_id: String, settled: bool },
    InFlightCapacity, RegistryUnavailable, Store(Nir1StoreFailure), Unresolved { attempt_id: String },
}
```

`create` の要点：lease を取り、`Nir1AdmissionSqlBudget` で `create_attempt_for_capture_bounded` を呼ぶ。Unknown なら、lease を drop してから Pinned の `read_attempt_exact_bounded` で照合する（lease の保持は bounded op 1回に限る）。
- 行があれば `Nir1PreparedAttempt` を返す。確認済みの不在なら refusal を返す。
- reread も失敗したら、`quarantine_entry` で gate を閉じ、slot を Unresolved にして、refusal の `Unresolved` を返す。

`claim_for_transport` の手順（zero-send はどれも下記の settle で書く。claim の状態は、その時点で owner が知っているもの）：
1. `try_lease_for_binding`。lease が取れなければ zero-send（DispatchFailure、`Unclaimed`）。
2. BEGIN の前の検査：`permit.ensure_open`、route revision の再計算と一致、cancel。
3. `claim_attempt_bounded`。budget は `Nir1AdmissionSqlBudget::new(cancel, probe)` で、probe は `lease.witness().is_current() && permit.ensure_open().is_ok()`。pre_commit では cancel、`lease.is_current()`、`permit.ensure_open()` だけを atomic で読む。
   - `Claimed{t}`：手順5へ。
   - `AlreadyClaimed{..}`：この owner はまだ claim していないので、別の claimer の claim である。`NotStarted(ClaimLost)` を返し、terminal は書かない。
   - `AlreadyTerminal`：`NotStarted(AlreadySettled)`。
   - NotCommitted の失敗：zero-send（`Unclaimed`）。cancel 済みなら Cancelled、それ以外は DispatchFailure。
4. Unknown なら、lease を drop して `read_attempt_exact_bounded`（pinned）で照合する。自分の claim 時刻 t は、error の `claim_written_at_ms` から取る。
   - terminal があれば `NotStarted(AlreadySettled)`。
   - `claimed_at_ms == t` なら自分の claim。witness と同じ entry の lease を取り直す（`try_lease_for_witness`、§5.3）。取れれば手順5へ進み、取れなければ zero-send（`ClaimedAt(t)`）。
   - claim 済みで `claimed_at_ms != t` なら、別の claimer の claim である。`NotStarted(ClaimLost)` を返し、terminal は書かない。
   - claim されていなければ、自分の claim は COMMIT されていない。zero-send（`Unclaimed`）。
   - reread も失敗したら `gate.quarantine_entry(&witness)` で gate を閉じ、slot を Unresolved にして、`NotStarted(Unresolved{gate_quarantined:true})` を返す。
5. post-commit の再検証（DB mutex は解放済み、lease は保持したまま）。
   - `with_authorized_dispatch(…, || Ok(()))`（profile mutex だけを取る）
   - route revision の再計算
   - `ensure_attempt_workspace_current`
   - Core の binding が lease の binding と一致すること
   - `lease.is_current()`
6. owner の phase mutex の中で、cancel、`permit.ensure_open`、`lease.is_current` をもう一度読む。すべて通れば phase を `Started` にして Start を返す。通らなければ zero-send（`ClaimedAt(t)`）の経路へ進む。
7. どちらの経路でも、lease は返す前に drop する。zero-send の書込みは lease を持たずに pinned で行う。

zero-send の settle（`abandon`、`claim_for_transport` の zero-send、`Nir1PreparedAttempt` の Drop で共通）：
1. `Nir1PinnedSqlBudget` で `finish_pretransport_attempt_bounded` を呼ぶ。completion は、cancel 済みなら Cancelled、それ以外は DispatchFailure（E12）。lease は持たない。
2. 結果を次のように写す。試行は合計3回まで。
   - 成功：`ZeroSend(terminal)`。
   - `TerminalConflict`：既に別の terminal がある（sweep の InterruptedUnknown など）。再試行せず `AlreadySettled`。
   - `ClaimMismatch`：別の claimer の claim。再試行せず `ClaimLost`。
   - 一時的な失敗（ConnectionBusy／SqliteBusy／TimedOut／ConnectionUnavailable、または commit が Unknown）：再試行する。writer は冪等（§5.1）なので、前回の書込みが durable でも二重にはならない。
   - それ以外（Conflict／Missing／Invalid／SqlOwnerActive）：再試行しても結果は変わらないので、再試行せず手順3へ。
3. 一時的な失敗が3回続いたか、手順2の「それ以外」で終わったら、slot を Unresolved にして `Unresolved{gate_quarantined:false}` を返す。gate は quarantine しない。
   - COMMIT の状態は既知で、送信は始まっていない。durable に残るのは「terminal のない attempt」か「自分の terminal」のどちらか。前者は次の Ready entry の sweep が InterruptedUnknown で終端化する。
   - 同じ session は `SessionUnresolved` で止まり、同じ attempt を作り直さない。別の session は通る。解除は §5.5 の規則（次の entry の Open）による。
- `Nir1PreparedAttempt` の Drop は、未消費のときだけ同じ settle を行う。Drop は結果を返せないので、Unresolved なら slot に記録するだけ。
- `Nir1TransportOwner` の Drop は、`recover_claimed_attempt_bounded`（Pinned）を1回呼ぶ。既存の terminal があれば、それを返すだけで書かない（§5.1）。失敗したら slot を Unresolved にする（gate は quarantine しない）。

### 5.5 registry（AppState の field。N-state に `nir1_generation_registry` を追加する）

```rust
pub(crate) struct Nir1GenerationRegistry { /* Mutex<{ slots: Vec<(Nir1SessionKey, Nir1SessionSlot)>, poisoned, next_token }> */ }
pub(crate) struct Nir1SessionKey { binding: LiveBinding, project_id: String, chat_session_id: String }
enum Nir1SessionSlot {
    InFlight { capture_id: String, submission_id: String, attempt_id: String, token: u64 },
    Unresolved { attempt_id: String, marked_epoch: u64 },
}
pub(crate) struct Nir1SessionSlotGuard { /* Drop で自分の token の InFlight を除去。mark_unresolved(self, epoch) は消費型 */ }
```

- `reserve` は、まず `Unresolved{marked_epoch < open_entry_epoch}` を除去する。
  - 新しい entry が sweep を完了して Open になったことで、未解決の attempt は durable に終端化済みだからである。
  - その後、同じ key の slot、上限（16）、poison の順に検査してから挿入する。
- `mark_unresolved(self, epoch)` の epoch には、mark の直前に lock の外で読んだ gate の epoch を渡す。
  - gate を quarantine した場合（COMMIT の結果不明）も、しない場合（zero-send の失敗）も、同じ規則で解除する。gate が Open のまま mark した場合、marked_epoch はその Open の epoch と等しいので、次の entry が Open になるまで解除されない。
  - epoch を lock の外で読む TOCTOU は、解除を早める向きには倒れない。古い epoch を読んだ場合、mark の後の edge で始まる sweep は、mark より前に確定した durable な状態を見る。新しい epoch を読んだ場合は、解除が1 entry 遅れるだけ。
- poison した場合は、新しい予約をすべて拒否する（fail-closed）。release は `into_inner` で続ける。

### 5.6 Native lib.rs（数行）

- `mod nir1_generation_owner;` を1行追加する。
- `publish_workspace_lifecycle_from_workspace_off_runtime(&Arc<AppState>)` を追加する。中身は `spawn_blocking` で既存の publisher を呼び、JoinError を `AppError` に写す。
- N-lib:10054、:10531、:10683 をこの関数に置き換える。順序は変えない（worker の Join → publish → hook）。

## 6. 判断と代替案

- **E1（信頼度 85）：guard を外した COMMIT**
  - 採る案：lease を持ち、atomic の pre_commit 検査をしてから COMMIT する。COMMIT の後で再検証し、transport の開始は owner の phase mutex で cancel と線形化する。
    - 「claim」は一回限りの権利の durable な消費にとどまり、送信の認可は開始判断の時点で確定させる（post-B §9.2「DB 条件付き更新だけで DB 外の profile/caller 状態まで原子化したとみなさない」）。
    - fence は二重になる。COMMIT と再検証の間に lifecycle が進んでも、gate が閉じ（lease が失効し）、participant の stop で SQL が止まる。
  - 代替案 (a) guard は残し、上限だけ付ける：採らない。COMMIT が Core の observer と publisher を止める。progress hook の自己 deadlock のため participant scope も使えない（§1-2）。
  - 代替案 (b) CB-2 型の Core 所有の final-commit reservation：採らない。D-wl は許可ファイルの外で、gate、lease、drain で足りる（TASK の前提）。
- **E2（80）：DB API の作り**
  - 採る案：上限3つを1か所に置き、typed error を返し、commit の状態（NotCommitted／Unknown）を分類する。rollback と再利用は既存の scope cleanup に任せる。
  - 代替案：単一の deadline だけの `ParticipantSqlOperationBudget` をそのまま使う。採らない。mutex 100 ms の上限を独立に持てない。
  - 代替案：nir1_generation.rs の中に scope を新しく作る。採らない。cleanup（D-conn:971-1052）を複製すると取りこぼしの危険がある。
- **E3（80）：fence を Admission と Pinned の2種にする**
  - 採る案：create と claim は Admission にする（owner の cancel、participant の stop、fence probe で interrupt する）。zero-send、transport 後の terminal と recover、exact reread は Pinned にする（participant は数えるが、owner の cancel も participant の stop も probe も見ない）。
    - budget の型を `Nir1AdmissionSqlBudget` と `Nir1PinnedSqlBudget` に分ける。Pinned の関数は Pinned の budget しか受け取らないので、取り違えはコンパイル時に拒否される。
    - cancel を Pinned の writer に渡すと、cancel の後の Cancelled terminal 自体が Cancelled で失敗し、exactly-once（O5）が成り立たない。scope は op の境界（D-conn:377-389）と progress hook の両方で stop を読む。
    - Pinned の stop は常に false にする（process shutdown でも止めない）。shutdown の間も、owner が terminal を書いて participant を返せる必要があるため（§3 の onClosed 行）。有限性は上限3つで保つ。
  - 理由：lease の失効の大半は Transition／Unavailable／Shutdown の edge で、participant の stop と同時に起きる。stop を観測する writer では zero-send を書けない。
    - post-B §4.3 と §9.3 の「新規受付を閉じた後も既存 owner の終端保存・cleanup を完了できる限定経路」にあたる。
  - 代替案：WIP の participant 検査つきの terminal。採らない。lease の失効の受入れ（DG-3）を満たせない。
  - 代替案：participant を持たずに authority だけを保持して書く。採らない。Restore の物理置換と WAL の path が競合しうる。physical exclusive は participant だけを待つ（D-wl:3684-3696）。
  - 代替案：budget を1本にして、Pinned のときだけ実行時に stop を無視する。採らない。無視するかどうかが実行時の分岐になり、取り違えを型で防げない。
- **E4（75）：participant を owner の生涯保持し、lease は呼出しの中だけにする**
  - 理由：transition が physical exclusive で owner を待つので、terminal の書込みは置換と競合しない。lease は各呼出し（≤250 ms と短い検査）に閉じるので、drain 250 ms が呼出し側の進み方に左右されない。
  - 代替案：transport の開始時に participant を手放す。採らない。後の terminal は新しい participant が必要になり、admission が閉じた後は拒否される。
  - 代替案：transport の間も lease を保持する。採らない。生成中の Open がすべて drain timeout → RecoveryRequired になる。
  - 制約：owner は1つの blocking task の局所値で、AppState や async task に保存しない。DT-5 は transport の cancel を有限にする。
- **E5（70）：idempotency の方式**
  - 採る案：決定的な attempt ID と、process-local の in-flight registry。
    - ID は `canonical_json_digest({"domain":"nir1-generation-attempt-id@1", captureId, submissionId, submissionDigest})`。DB の中で `AcceptedChatInputCapture` から導く。
    - 得られる性質：「1 submission に1 attempt」が durable になる。create の結果不明を exact ID で照合できる。schema は変えない。
  - 代替案 (a) registry だけで ID は UUID：採らない。slot が退役した後の再送を防ぐには tombstone と追い出しの方針が要り、上限との両立が難しい。
  - 代替案 (b) 新しい表や列：schema の変更になるので HOLD にあたる。
  - 代替案 (c) capture の state を `closed` にする：採らない。#611 の capture の意味を変え、`closed` の意味は未定義（D-mig:4192、workspace_schema.rs:98-115）。
  - 代替案 (d) input_refs から message version を走査する：採らない。index がなく有限にならない（D-mig:4143-4148）。
  - 帰結：同じ submission での retry（再生成）はできない。retry 鍵（例：前の attempt ID を親にした Native 由来の鍵）は DD-1 で決める（§11）。
- **E6（75）：registry の key と上限**
  - 採る案：key は (exact LiveBinding, project_id, chat_session_id)。chat_session_id は capture 時に DB で検証済み。上限は 16 slot（InFlight と Unresolved の合計。資源契約 /6 に従い、allocation の前に検査し、超えたら拒否）。
  - 代替案：`CallerIdentity.session_id` を key にする。採らない。DB で検証されておらず、DT-3 で分離される。
- **E7（80）：COMMIT の結果不明（Unknown）**
  - 採る案：pinned で exact reread する。照合できなければ、gate の entry を quarantine し（Closed＋Consumed。次の Ready entry の sweep まで開かない）、slot を Unresolved にする。owner は participant を返して transition と sweep を進めさせる。durable な pending marker は作らない（K2 の方針と同じ）。
    - claim の照合は、error が持つ自分の claim 時刻（`claim_written_at_ms`）と reread の `claimed_at_ms` で行う。claim 済みで時刻が違えば別の claimer の claim なので、`ClaimLost` にして terminal を書かない。
    - 自分の claim と照合できたら、同じ entry（witness の epoch）の lease を取り直してから開始判断に進む。別の entry の lease では始めない。新しい entry の sweep が、その attempt を既に InterruptedUnknown にしている可能性があるため（§5.3）。
    - zero-send が上限回数で失敗した場合とは区別する。そちらは gate を quarantine しない（E16）。
  - 代替案：解決するまで owner が待ち続ける。採らない。有限にならない。
  - 代替案：restart まで quarantine する。採らない。TASK は「次の Ready entry まで」で、その sweep が durable に解決する。
- **E8（85）：P3(a)** は §7(a)。
- **E9（75）：P3(b)** は §7(b)。
- **E10（85）：P3(c)** は §7(c)。
- **E11（80）：legacy の撤去範囲**
  - 採る案：Native の `GenerationClaimOwner` を丸ごと撤去する（persist_final_request、consume_claim、consume_finalized_claim、persist_terminal、recover_terminal）。DB の `with_prepared_claim`／`PreparedClaim`／`claim_attempt_in_tx` も撤去し、無制限な関数は test-support に限る。
  - `FinalDispatchRequest`、`FinalizedAttempt`、digest の helper、`route_revision` は新しい owner で使い続ける。
  - 代替案：deprecated として残す。採らない。「guard を保持した COMMIT がない」を構造で示せなくなる。
- **E12（80）：zero-send の observation の写像**
  - 開始判断より前の cancel：`Cancelled`／`not-attempted`（Cancelled）。
  - lease の失効、profile の失効、route の変更、binding の変化、quarantine、claim が COMMIT されなかった：`Failed`／`not-attempted`（DispatchUnavailable）。
  - 既存の matrix（post-B §9.4）の中に収まり、新しい行は作らない。DB の writer は、この2つ以外と本文を拒否する。
  - 冪等の比較は、observation と failure_classification の両方で行う。sweep の InterruptedUnknown は DispatchFailure と同じ observation を持つ（D-gen:3308-3314）ので、observation だけでは自分の zero-send と区別できない。
  - 既存の terminal と違えば、writer は `TerminalConflict` を返す。owner は再試行せず `AlreadySettled` にする。claim の状態が違えば writer は `ClaimMismatch` を返し、owner は `ClaimLost` にする。どちらも terminal を書かない。
- **E13（70）：lease の currency を lock なしで読む**
  - DB mutex の下で gate の mutex を取らないため。
  - 代替案：DB の下で gate の mutex を leaf として取る。採らない。TASK の lock の向きに字面上も合わせる。
- **E14（80）：定数の置き場所**
  - DB の上限3つは D-gen、drain は N-gate:25、sweep は N-gen:131 に置く。
  - Native の recovery の per-op／busy（N-gen:132-133）は D-gen の定数を参照する。
  - 試験では既定以下に締める constructor だけを許す。緩めることはしない。
- **E15（80）：Admission の fence に、lease と permit の失効を含める**
  - 採る案：Admission の budget に lock なしの probe（lease の epoch mirror と poison mirror、permit の atomic）を持たせる。読む場所は、mutex の取得 loop、op の境界、progress hook（§5.1、§5.2）。
  - 理由：gate の閉鎖と participant の stop は、いつも同じ edge で起きるとは限らない。
    - participant の stop を伴わない閉鎖：他の owner の `quarantine_entry`（DT-2 で足す）、gate の poison や epoch 枯渇、将来の edge や observer。
    - probe がないと、lease の保持者は op の上限（250 ms）まで走り続けうる。pre_commit で COMMIT は防げるが、直後の begin_recovery の drain（同じ 250 ms。N-gen:723-727）が timeout して `gate_recovery=None` になると、その entry は sweep しても Open にならない。
    - lease の fence と drain の整合を、edge の種類に依存させない。
  - 確認した事実：現行の Core で Transition を伴わない ReadyPublished を出すのは、compat の `set_ready` だけ。これは `workspace_participants == 0` を要求する（`set_ready` は D-wl:1793-1838、participant の検査は :1825）。owner は participant を生涯保持するので、advisor が例に挙げた経路（compat の set_ready、Ready→Ready の再公開）は、現状では lease の保持中に起きない。Ready の再公開は Transition を経由し、その間は participant の stop が立つ。それでも上の閉鎖と将来の edge のために採る。
  - 停止の遅れ：mutex 待ちは 1 ms、SQL は 1000 VM step。SQLite の busy 待ちの間は progress hook が呼ばれないので、busy の上限（100 ms）まで遅れうる。いずれも drain の 250 ms より短い。
  - 代替案：gate が lease ごとに AtomicBool を持ち、close で立てる。採らない。gate の状態が lease の数に比例して増え、DT-1 の epoch 別の数え方と二重になる。
  - 代替案：pre_commit の検査だけに頼る（反映前の設計）。採らない。COMMIT は防げても、lease の保持時間が drain／begin_recovery と同じ 250 ms まで伸びる。
- **E16（80）：zero-send が上限回数で失敗したときの終端**
  - 採る案：§5.4 の settle。3回とも失敗したら slot を Unresolved にし、gate は quarantine しない。`Nir1PreparedAttempt` の Drop も同じ規則にする。
  - 理由：COMMIT の結果不明（E7）とは違い、durable な状態は既知で、送信も始まっていない。残る「terminal のない attempt」は、次の Ready entry の sweep が終端化する。gate を閉じると、無関係な session まで止まる。
  - 代替案：slot を解放する（反映前の記述）。採らない。claim 済みで terminal のない attempt を残したまま、同じ session の次の submission を受理してしまう。
  - 代替案：gate も quarantine する。採らない。理由は上と同じ。
  - 代替案：次の capture のときに、同じ session の Unresolved を settle し直す。DT-2 では採らない。registry に `Nir1ExpectedAttempt`、claim の状態、completion を持たせる必要があり、slot が大きくなる。sweep が durable に解決するので、安全性には足りる。liveness の改善は §11-9 に回す。

## 7. DT-1 から引き継いだ P3 の扱い

- **(a) drain を tokio worker の上で同期待ちしない**
  - 3つの async publisher（Open、Restore、Safe Mode restore）を `spawn_blocking` に移す（§5.6）。recovery の publisher は drain を通らない（§1-7）ので対象外。
  - `publish_workspace_lifecycle_from_workspace` の呼出しは4か所ある（N-lib:2950、:10054、:10531、:10683）。2950 も対象外にする。
    - 2950 は `reconcile_maintenance_recovery_descriptor`（N-lib:2602-）の中にあり、製品の呼出し元はどれも `run_blocking` の closure の中だから（:3108 は `reconcile_maintenance_recovery_with_open_lock` 経由で :6703 と :7354、ほかに :6976、:7230）。tokio worker の上では drain しない。
    - :5997 の呼出しは `cfg(test)`。
  - 加えて、lease の保持者は同期関数の局所値で blocking thread 上にあり、await しない（L5）。このため drain が runtime の進行に依存しない。
  - 代替案：drain を async（Notify）にする。採らない。drain は同期 adapter の `publish_from_workspace` の中にあり、maintenance recovery（open_lock の下の同期呼出し）とも共有している。
- **(b) revision だけの変化による liveness の制限**
  - 規則：Ready entry の同一性は (exact binding, gate の epoch) とし、Core の数値 revision では判定しない。
  - claimant は Core の現在の revision を提示しない。gate が Open の exact entry と同じ binding を提示し、lease が entry の revision を保持する。
  - sweep の currency（N-gen の5か所）は `same_ready_entry(binding, entry_revision)` に置き換える。
    - 定義：Core が `Ready(binding)` かつ revision ≥ entry、かつ `gate.is_current_ready_entry(binding, entry_revision)`。
    - gate が entry を確認できないとき（poison や未登録）は、従来の exact revision の一致に戻す（#610 の挙動を保つ。その場合 gate は Closed のまま）。
  - hook は gate から entry の revision Re を引き、`Re ≤ view revision ≤ Core revision` のときだけ Re で schedule する。view が entry より古ければ stale として拒否する。
  - fail-closed を崩さないこと：revision だけの変化は binding も authority も変えない。edge は gate が必ず閉じる。
    - quarantine は participant の取得（D-wl:1681-1691）と、transport 開始前の `ensure_attempt_workspace_current` で拒否する。
    - background recovery の完了と放棄は、別 workspace（W1）の descriptor の話で、W2 の DB は変わらない。
  - 代替案：revision だけが変わったら sweep をやり直す。採らない。seam はその edge を出さない（D1）。D-wl は許可ファイルの外。この間に新しい pending は生じない。
- **(c) open を一回限りの token で束縛する**
  - `record_complete_sweep(self) -> Option<Nir1SweepProof>` にする。worker の closure は `Option<Nir1SweepProof>` を返し、`JoinHandle<Option<Nir1SweepProof>>` を経て supervisor が受け取る。supervisor は Join に成功し、ledger が Complete で、Core が同じ entry のときだけ `open_after_joined_sweep(proof)` を呼ぶ。
  - proof は Clone できず、private field と epoch、entry の `Arc::ptr_eq` を照合する。未使用のまま drop すれば Closed＋Consumed になる。
  - proof の Drop と `open_after_joined_sweep` は、`Nir1StartupRecovery::drop`（N-gate:359-375）と同じく、epoch と `Arc::ptr_eq` が一致するときだけ gate を変える（§5.3）。JoinHandle を経る間に新しい closure が来ても、古い proof は新しい entry を開けず、閉じもしない。
  - 代替案：u64 の token を比べる。採らない。複製でき、crate の中で偽造できる。

## 8. process-local の登録表と restart 後の sweep の分担

| 事実 | 担い手 | 根拠 |
|---|---|---|
| 1 submission に1 attempt | durable：決定的 ID と PK（DB） | restart をまたいでも成り立つ。再送は `AlreadyExists` |
| session ごとに in-flight は1件 | process-local：registry の InFlight | 生きている owner の間だけ意味を持つ。restart で owner は消える |
| 結果不明・未終端の間の拒否 | process-local：slot Unresolved。COMMIT の結果不明を照合できないときだけ gate も quarantine する（zero-send の失敗では quarantine しない。E16） | 次の Ready entry の sweep が durable に解決するまで |
| 未終端の attempt の終端化 | durable：#610 の sweep（Ready entry ごと、gate の Open の前） | owner が消えた attempt、claim 済みで送信の有無が不明な attempt は、InterruptedUnknown にして再送しない |
| restart 後の同じ submission | durable：capture owner の digest（D-gen:2348-2362） | 新しい process では owner が変わるので、`NIR1_CHAT_CAPTURE_IDEMPOTENCY_CONFLICT` になり、DT-2 には届かない |
| 送信の確定点 | process-local：owner の phase の `Started` | それより前の失効はすべて zero-send。後の失効は DT-5 の cancel |

## 9. 試験計画

対応する受入れ ID を【 】に書く。競合は固定の sleep ではなく、owner の probe（cfg(test)。`BeforePreCommit`／`DuringCommit`／`AfterCommit`／`BeforeDecision`／`BeforeZeroSend`）と、DB の failpoint で同期点を作って再現する。

**DB（`nir1_generation/tests.rs` と D-conn の tests）**

capture の API は DB の既定 feature に入っていない（DB Cargo.toml:27-30 の `native-current-human-capture`）。そこで D1〜D3 は、capture に依存しない crate 内部の create の芯（`create_attempt_with_id_bounded`、`pub(crate)`）を既定 feature のまま試験する。D9 と、capture を通す create の試験は `--features native-current-human-capture` を付けて回す。

- **D1**：mutex を 300 ms 保持すると、create は 100〜250 ms で `ConnectionBusy`／NotCommitted になる。行は書かれない。解放後は同じ create が成功する【bounded】
- **D2**：別の `Database` が BEGIN IMMEDIATE を保持すると、約 100 ms で `SqliteBusy`。busy_timeout は元の 5 s に戻っている（pragma で確認）。再利用できる【bounded】
- **D3**：TEMP table の cross join を TEMP trigger から走らせ、250 ms を超えさせる。`TimedOut` になり、attempt 行も refs 行も残らない。progress handler は解除され、再利用できる【bounded／部分書込みなし】
- **D4**：pre_commit が拒否した場合も panic した場合も rollback し、接続は再利用できる。panic は呼出し側へ戻る（旧 `prepared_claim_rolls_back_…` の置換）
- **D5**：claim は Claimed（時刻つき）→ AlreadyClaimed → finish の後に AlreadyTerminal になる。同じ transaction で pairing（digest、refs）が変わっていれば `Conflict`
- **D6**：`VetoCommit`（commit_hook で COMMIT を失敗させる）は Unknown になり、reread で claim されていないと分かる。`ErrorAfterCommit` は Unknown になり、error の `claim_written_at_ms` と reread の claimed_at が一致する。claim の Unknown は必ず時刻を持つ【結果不明】
  - commit_hook は、grimodex-db で既に有効な rusqlite の "hooks" feature（DB Cargo.toml:10）で使える。依存の追加は要らない
- **D7**：lifecycle を Transition または shutdown にすると、admission の create と claim は `Fenced`。owner の cancel flag を立てると `Cancelled`（両方なら `Cancelled`）。どちらの状態でも（stop=true のまま）、pinned の zero-send は成功する。同じ (observation, failure_classification) なら冪等で、違えば `TerminalConflict`【Pinned は cancel で止まらない】
- **D8**：pretransport の writer は、本文や、Cancelled／DispatchFailure 以外の observation を拒否する
- **D9**：同じ capture の create を2回行うと `AlreadyExists{id}` になり、行は増えない。capture がない、superseded、不一致、または User の入力がない場合は拒否する
- **D10**：COMMIT の間（commit_hook の probe）に、別の thread が Core の snapshot を取り、participant を begin／drop できる【guard なしの COMMIT】
- **D11**：participant scope の op の中と capacity attempt の中から、§5.1 の bounded 関数（create、claim、zero-send、finish、recover_claimed、read_exact）を呼ぶ。どれも DB mutex を取る前に `SqlOwnerActive`（NotCommitted）で返る。別の thread が mutex を保持していても待たない（前置き検査であることの確認）。scope の外からは通る【入れ子の owner】
- **D12**：zero-send の writer の照合【exactly once】
  - test-support の `recover_attempt` で InterruptedUnknown にした attempt に DispatchFailure の zero-send を書くと、`TerminalConflict` になる（observation が同じでも冪等にしない）
  - test-support の `claim_attempt` で別の時刻に claim した attempt に、`Unclaimed` または別の `ClaimedAt` で書くと `ClaimMismatch` になり、terminal は書かれない
  - 別の時刻の claim と DispatchFailure の terminal を test-support で先に書いた attempt に、DispatchFailure の zero-send を書くと、冪等の返却ではなく `ClaimMismatch` になる（claim の照合が terminal の比較より先）
- **N1**：mutex 上限のある scope と pinned の scope は、deadline と busy を守り、rollback と復元を行う
  - Pinned は入口の `check_participant` をせず、participant の stop も budget の stop も probe も読まない
  - Admission の probe は、取得 loop、op の境界、progress hook のどこで偽になっても `Closed` で止まる

**Native gate（`nir1_startup_barrier.rs`。既存の11件は proof API に合わせて更新する）**

- **G1**：lease は revision だけの変化の後も binding で取れる。edge では閉じる
- **G2**：proof は一回限りで、自分の exact entry だけを開く。古い epoch の proof は開けない。未使用の drop で Consumed
- **G3**：quarantine は Open の entry を閉じる。次の Ready entry の sweep まで開かない
- **G4**：lock なしの currency が、close／poison／quarantine／shutdown の下で、mutex で見た状態と一致する
  - Transition を伴わない閉鎖でも、lease を保持した Admission op が `Fenced` で止まる。閉鎖は、observer への ReadyPublished の直接注入、`quarantine_entry`、poison で作る。op は DB mutex の待機中と長い SQL（D3 の trigger）の実行中の両方で試す
  - 現行の Core では participant を持ったまま Transition なしの ReadyPublished を起こせないので（E15）、edge は gate の observer に直接渡して作る
- **G5**：`try_lease_for_witness` は、witness と同じ epoch・entry の Open でだけ lease を出す。close の後、同じ binding で新しい entry が Open になっても出さない

**Native recovery（`nir1_generation.rs`。#630 の対象試験には触らない）**

- **R1**：worker probe で sweep を止め、その間に quarantine の set／release と `complete_background_recovery` を入れる。解放すると gate は exact entry で Open になる【P3(b)】
- **R2**：Open の後に quarantine を set すると、新しい participant は拒否され、release の後は同じ entry で lease が取れる【P3(b)】
- **R3**：hook に後の view revision を渡しても、gate の entry を引いて schedule する。古い view は拒否する【P3(b)】
- **R4**：current_thread の runtime で lease を持つ task を動かしたまま、`…_off_runtime` の publish が 250 ms 未満で Ready になる。同期呼出しのままなら drain timeout になる【P3(a)】
- **R5**：worker を record の後で止めて新しい entry を publish する。古い proof は開けず、pending の entry が Join の後に開く【P3(c)】

**Native owner（`nir1_generation_owner.rs`）**

- **O1**：claim の COMMIT 中（DuringCommit）に、別の thread から次がすべて 1 s 以内に終わる【guard なしの COMMIT】
  - Core の snapshot
  - `profile_egress.status()` と `with_authorized_dispatch`
  - `gate.try_lease_for_binding` と drop
  - `begin_workspace_participant` と drop
  - owner の `cancel()`
- **O2**：同じ submission の owner を2 thread で同時に作ると、片方は Start、もう片方は `SameSubmissionInFlight`。recorder は1回【DG-2】
  - test-support の `claim_attempt` で「別 process」の claim を先行させると ClaimLost で、recorder は0回
  - `VetoCommit` で自分の claim を Unknown（実際は COMMIT されていない）にし、reread の前（AfterCommit の probe）に test-support の `claim_attempt` で別の時刻の claim を入れる。`ClaimLost` で terminal は書かれず、recorder は0回
- **O3**：同じ session の2件目は `SessionBusy`。別の session は通る【in-flight】
- **O4**：terminal の後に同じ submission を送ると `SubmissionAlreadyAttempted{settled:true}` で、行は増えない【idempotent】
- **O5**：cancel を BeforePreCommit／AfterCommit／BeforeDecision のそれぞれで入れる。recorder は0回、Cancelled の terminal はちょうど1件。その後の claim は AlreadyTerminal【DG-3／exactly once】
  - cancel の後の Cancelled terminal が書けることを確かめる。cancel flag は立ったままで、Admission の SQL は `Cancelled` で止まり、Pinned の zero-send は cancel を見ずに成功する
- **O6**：COMMIT の後で次のいずれかを起こす。recorder は0回、DispatchUnavailable の terminal は1件、slot は解放される【DG-3／再検証】
  - `invalidate_callers`
  - `with_route_update`
  - 登録の置換
  - quarantine の set
  - Core の binding の変化
- **O7**：TransitionAdmitted／Unavailable／Shutdown の edge で lease を失わせる。zero-send は1件。transition の physical exclusive は owner の settle の後に進み、drain は 0 件で、Ready が出る（RecoveryRequired にならない）【DG-3／lease の失効】
  - Transition を伴わない ReadyPublished（observer への注入。G4）で、lease を保持中の owner の op を止める。op は `Fenced` になり、zero-send は1件。同じ entry の `begin_recovery` は drain を timeout せずに Recovering になる（`gate_recovery` が None にならない）
- **O8**：`ErrorAfterCommit` の後、reread で照合して Start になる。recorder は1回【結果不明・照合できる】
  - 開始判断の前に、同じ entry の lease を `try_lease_for_witness` で取り直していること
- **O8b**：`ErrorAfterCommit` の後、reread の間に edge を入れ、同じ binding の新しい entry にする。同じ entry の lease は取り直せないので Start しない。新しい entry の sweep が先に終端化していれば `AlreadySettled`、そうでなければ zero-send が1件。recorder は0回【結果不明・別 entry】
- **O9**：`ErrorAfterCommit` の後、reread の間に DB mutex を保持して `ConnectionBusy` にする【結果不明・照合できない】
  - gate は Closed。同じ session は `SessionUnresolved`、別の session は `GateClosed`。recorder は0回
  - 新しい Ready entry と sweep の後は、attempt が InterruptedUnknown、gate が Open、session が受け付けられる
- **O9b**：claim の後の再検証を失敗させ（`invalidate_callers`）、`BeforeZeroSend` の probe で DB mutex を保持して、zero-send の書込みを3回とも `ConnectionBusy` にする【zero-send の失敗】
  - 結果は `Unresolved{gate_quarantined:false}` で、gate は Open のまま。同じ session は `SessionUnresolved`、別の session は通る。recorder は0回
  - 新しい Ready entry と sweep の後は、attempt が InterruptedUnknown になり、同じ session が受け付けられる
  - Prepared を消費せずに drop した場合も同じ結果になる
- **O10**：owner の op が `ConnectionBusy`／`TimedOut` を typed で返し、その後は再利用できる【bounded】
- **O11**：#628 の transient release（permit の start → join → release）を owner の途中に入れても、lease、gate、slot は変わらず、owner は完走する【#628】
  - 逆向きも確かめる。owner の Admission op は `lock_conn_with_check` の foreground waiter になる（D-lib:460 からの loop、waiter の登録は :472）。走っている maintenance cycle は transient な `NEX_MAINTENANCE_CONNECTION_PREEMPTED` で退き、workspace は Ready のまま（RecoveryRequired にならない）
- **O12**：Prepared を claim せずに drop すると zero-send が1件。TransportOwner を finish せずに drop すると InterruptedUnknown が1件で、再送しない
- **O13**：create と claim の後に AppState を作り直し（restart）、Open して sweep する。InterruptedUnknown になる。同じ submission は capture の段階で拒否され、新しい attempt は作られない【restart】
- **O14**：loopback 試験4件を新しい owner に移す（exact body が1回、invalid UTF-8、EOF、開始後の cancel）
- **A-1**：`git diff` に `#[napi]` の追加がない。ipcContract／main／preload／schema／AttemptBinding は変更しない

検証コマンド（すべて `CARGO_BUILD_JOBS=4`）：
- `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib nir1_generation`
- `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib --features native-current-human-capture nir1_generation`
- `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib workspace_lifecycle`
- `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib narrative_maintenance_connection`
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib -- --test-threads=1`（全件）
- 両 crate で `cargo clippy --all-targets -- -D warnings`

`recovery_is_pinned_to_the_reopened_workspace_database` は、DT-1 で負荷による flake（250 ms の per-op）が記録されている。失敗したら単独で再実行し、負荷とともに記録する。

## 10. 停止条件（HOLD）の確認

HOLD には当たらない。

- schema、migration、AttemptBinding は変えない。決定的 ID は既存の PK の列に入る。
- 委任外の6項目に当たらない。
  - 新しい送信先：ない（transport は作らない）。
  - 保存範囲の拡大：ない。ID は既存の識別子の digest で、capture との対応は input_refs → message version → capture として既に保存されている。
  - 閾値の緩和：ない。計画の既定値を使い、新しい上限は締める側。
  - 製品公開：ない（A-1）。
  - 認可の削除：ない。COMMIT から外した検査は、atomic の pre_commit と、送信前の再検証に移す。
  - 新しい契約や authority：ない。registry、quarantine、proof は内部の fail-closed 機構。idempotency の方式は計画上 U3 の委任判断で、Session B で通知する。
- advisor の指摘の反映（§12）も HOLD に当たらない。
  - 上限は変えない（zero-send は3回、1回あたり 250 ms）。
  - 足した型と関数（budget の2型、`Nir1ExpectedClaim`、`Nir1StoreFailure` の variant、`claim_written_at_ms`、`recover_claimed_attempt_bounded`、`try_lease_for_witness`）は Rust の crate の中だけで使い、N-API にも schema にも出ない。
  - 認可は減らさない。Admission の fence に probe を足すのは締める側。

## 11. 未解決・引き継ぎ

1. 新しい防御上限は integrator が PR に記録する：registry 16（`NIR1_GENERATION_MAX_TRACKED_SESSIONS`）、zero-send の書込み 3回、sweep の recover の `ConnectionBusy` の試行 1件あたり 3回（回と回の間 0 ms、sweep の 5 s と deadline の範囲。§14-5）。締めるのは自由で、緩めるには再確認が要る。
2. idempotency の方式（決定的 ID）は、Session B の委任判断一覧に載せる。同じ submission の retry 鍵は DD-1 で決める。
3. D4 は変えない（sweep を起動するのは Open／Restore の hook だけ）。quarantine の後に生成を再開できるのは、次に hook のある Ready entry（再 Open、Restore）か restart の後になる。
4. capture の currentness は create でだけ検査する。dispatch 直前の再確認は DI-1c の責務。
5. D-wl:546-552 の `with_current_binding` の doc は「COMMIT を closure に含める」と書いており、DT-2 の後は古くなる。D-wl は許可ファイルの外なので、doc の修正を integrator に渡す。
6. session の分離は DT-3：DT-2 は legacy の形のまま `caller.session_id == capture.chat_session_id` を要求する（fail-closed）。
7. DT-5 は transport の cancel（close→join）を有限にする。owner は transport 中も participant を持つので、transition はそれを待つ。
8. DT-1 からの残余リスク：observer 登録表の mutex が poison すると edge を取りこぼす（D-wl:341-346）。DT-2 は participant の stop と Core の binding の検査で補うが、gate だけに頼る判定は残る。
   - Admission の fence probe も gate の epoch を読むので、取りこぼした edge は probe でも観測できない。participant の stop は Core から直接読むので、Transition 系の edge は引き続き止まる。
9. zero-send が上限回数で失敗した session は、次に hook のある Ready entry（再 Open、Restore）か restart まで `SessionUnresolved` のままになる（3 と同じ liveness の制限）。次の capture で settle し直す方式（E16 の代替案）は、DI-1c／DD-1 で製品入口を作るときに再検討する。
10. claim の同一性は、`claimed_at_ms`（ms）の一致で見る。schema を変えないため、claim token はない。
    - 同じ ms に claim した別の claimer は区別できない（残余）。
    - ただし同じ attempt の claimer は1つに限られる。process の中では registry と決定的 ID が、process をまたぐと capture owner の digest が、別の owner を作らせない（§3 の restart 行）。同じ attempt の別 claimer は、test-support の claim でしか作れない。
11. advisor が指摘2で例に挙げた経路（compat の set_ready、Ready→Ready の再公開）は、現行の Core では lease の保持中に起きない（E15）。そのため G4／O7 は edge の注入で試験する。DT-1 の seam に Transition を伴わない Ready edge を足す変更が来たら、注入試験を実経路の試験に置き換える。

## 12. advisor の指摘の反映（2026-10-13）

照合した根拠は advisor と同じ（claude-nir1-dt2 の HEAD 3688a063、tracked の差分なし）。主な行番号は、この作業ツリーで照合し直した。5件すべてを採り、反映しない指摘はない。

| # | 指摘 | 判断 | 反映先 |
|---|---|---|---|
| 1 | Pinned の writer が owner の cancel の stop flag を共有するので、cancel の後の Cancelled terminal 自体が interrupt される | 採る。budget を `Nir1AdmissionSqlBudget` と `Nir1PinnedSqlBudget` の2型に分け、Pinned の関数は Pinned の budget だけを受け取る。Pinned の stop は常に false | §3 の cancel 行、§5.1、§5.2、E3、D7、O5 |
| 2 | Admission の fence が participant の stop だけで、gate の閉鎖そのものを含まない | 採る。lease と permit の失効を probe にし、mutex の取得 loop、op の境界、progress hook で読む。例に挙がった経路は現行の Core では起きないと確認した（E15）。それでも、他の owner の quarantine や poison のように participant の stop を伴わない閉鎖があるので、edge の種類への依存をなくす | §3 の admission closure 行と active lease ownership 行、§4 の L2 と L5、§5.1〜§5.3、E15、G4、O7 |
| 3 | pre-transport の zero-send が3回とも失敗したときの終端が未定義 | 採る。slot を Unresolved にし、gate は quarantine しない。Prepared の Drop も同じ規則 | §3 の retry 行と error 行、§5.4 の settle と `Nir1Settlement`、§5.5、E16、O9b |
| 4 | 入れ子の SQL owner の検査が、transaction（scope）の中に置かれている | 採る。scope に入る前（DB mutex を取る前）に置き、§5.1 の bounded 関数すべてに適用する | §5.1、D11 |
| 5 | Unknown の reread に「時刻が一致しない claim 済み」の分岐がない。zero-send の Conflict の扱いが未定義 | 採る。時刻が一致しない claim は `ClaimLost` で、terminal を書かない。既存の terminal との衝突は `TerminalConflict` とし、再試行せず `AlreadySettled` にする | §5.1 の zero-send の writer、§5.4 の手順3・4と settle、E7、E12、D12、O2 |

補足の反映：
- Pinned は2つの `_in` 関数だけでなく、private の scope 関数（D-conn:1280-1357）まで fence を通す（§5.2）。
- §2 に、submission の caller と workspace_binding を owner が照合できないこと（残余）と、その代替を書いた。
- proof の Drop と open は、`Nir1StartupRecovery::drop` と同じく epoch と `Arc::ptr_eq` で照合する（§5.3、§7(c)）。
- P3(a) の4か所目（N-lib:2950）が対象外である理由を §7(a) に書いた。
- O11 に、owner の op が maintenance cycle を transient に退かせ、workspace が Ready のままであることを足した。
- D6 に、commit_hook は既存の "hooks" feature で使えることを書いた。

反映の途中で見つけた不整合と、その補強（どれも指摘の範囲で必要になったもの）：
1. claim の結果が Unknown のとき、owner が自分の claim 時刻を知る手段がなく、手順4の照合が成り立たなかった。error に `claim_written_at_ms` を載せる（§5.1）。
2. §5.4 の手順4（lease を drop して reread）と手順5（lease を保持したまま再検証）が矛盾していた。同じ entry の lease を取り直す `try_lease_for_witness` を足し、別の entry の lease では始めない（§5.3、E7、G5、O8b）。
3. zero-send の冪等を observation だけで比べると、sweep の InterruptedUnknown（同じ observation）と区別できない。failure_classification も比べる（§5.1、E12、D12）。
4. transport の後の Drop が使う Pinned の recover が、§5.1 の API になかった。`recover_claimed_attempt_bounded` を足す。
5. reread から zero-send までの間に別の claimer が claim する TOCTOU は、zero-send の writer の claim 照合（`ClaimMismatch`）で DB の中で閉じる。claim の照合は terminal の比較より先に行い、別の claimer の同じ内容の terminal を自分の冪等な再書込みと取り違えない（§5.1、D12）。
6. 停止の遅れの上限を精密にした。advisor は「1 ms／1000 VM step 以内」としていたが、SQLite の busy 待ちの間は progress hook が呼ばれないので、busy の上限（100 ms）まで遅れうる。いずれも drain の 250 ms より短い（§3、E15）。

## 13. 実装時の補足（builder、2026-10-13）

設計の型・lock 順・上限は変えていない。実装で細部を決めた点と、設計に足した点を記録する。どれも HOLD に当たらない（schema、AttemptBinding、`#[napi]`、IPC は変えない。上限は締める側だけ）。

1. **capture 形の create の照合を足した**（§2 の残余を DB 側で縮める）
   - `create_attempt_for_capture_bounded` は、§5.1 の手順1に加えて、binding の `profile_id`／`caller_id`／`caller_epoch` が capture の owner と一致すること、capture の owner の `workspace_locator`／`workspace_authority_instance` が pin した workspace と一致することを、transaction の前に確かめる（不一致は `Conflict`／`NotCurrent`、NotCommitted）。
   - 理由：`AcceptedChatInputCapture::owner()` は DB crate の中からは読める。Native からは照合できない残余（§2）のうち、caller と workspace の取り違えを fail-closed にできる。締める側の追加で、正規の経路（同じ caller が capture して create する）は通る。
2. **create の芯**：capture 形は private の `create_attempt_with_id_bounded_checked` を呼ぶ。`create_attempt_with_id_bounded`（`pub(crate)`）は同じ芯の薄い入口で、既定 feature の試験（D1〜D3）からだけ使うので `#[cfg(test)]` にした。製品 build に未使用の関数を残さないため。
3. **commit の分類**：op が `Ok` を返した時点（failpoint の hook を入れた後）で `ReadyToCommit` にする。D-conn が COMMIT 前に行う fence の再検査で失敗した場合も `Unknown` になる（実際は rollback 済み）。設計どおり保守側に倒し、owner は reread で照合する。
4. **panic**：bounded writer は op（pre_commit を含む）の panic を op の中で捕まえて通常の error にし、scope の rollback と復元の後で `resume_unwind` する（D4）。接続は quarantine されず再利用できる。
5. **failure の分類順**：mutex 上限 → 終了理由（`ValidationTerminated`）→ scope の cleanup 判定（`NIR1_MAINTENANCE_CONNECTION_UNUSABLE`／`…_CLEANUP_FAILED`／retirement）→ SQLite busy → domain → 既存 marker の順。
   - `NEX_DB_TRANSACTION_CLEANUP_UNPROVEN` は接続不能に数えない。interrupt で SQLite が transaction を自動 rollback した後の「rollback 不要」の注記で、接続の健全性は scope の cleanup 判定が正本だから（D3 で確認）。
6. **failpoint の後始末**：`VetoCommit`／`ProbeDuringCommit` は op の最後に一回限りの commit hook を入れる。D-conn の `_in` の immediate 関数は、test-support の build でだけ、transaction の後に commit hook を必ず外す。製品の挙動は変えない。
7. **試験専用の quarantine**：Native の試験（R1、R2、O6）が C-query 型の quarantine（revision だけの変化）を作れるよう、D-gen に test-support 限定の `quarantine_workspace_for_test`／`Nir1WorkspaceQuarantineForTest` を置いた。`detach_c_query_quarantine`（crate 内）を包むだけで、製品 build には入らない。
8. **gate の補助 API**：fallback（§7(b)）の判定に `observes_lifecycle()`（poison でも初期 closure のままでもない）を足した。lock なしの epoch 読取に `current_epoch()` を足した（registry の mark 用）。`try_lease` は既存試験用に残し、製品は `try_lease_for_binding` を使う。
   - lock なしの currency は、epoch と poison の mirror に加えて `Mutex::is_poisoned()`（lock を取らない）も読む。保持者の panic で mutex が poison した直後でも、mutex で見た状態と一致させるため（G4）。
9. **P3(b) の実装**：`same_ready_entry(state, binding, Re)`（Core が `Ready(binding)` で revision ≥ Re、かつ gate の最新 closure がこの entry）を、sweep の各 checkpoint、worker start、coordinator の capture、Join 後の open で使う。hook は `ready_entry_for_view` で `Re ≤ view ≤ Core` のときだけ Re を schedule する。gate が entry を識別できないときは exact revision に戻す。
10. **P3(c)**：`run_generation_recovery_after_ready` は `Option<Nir1SweepProof>` を返し、`spawn_blocking` の JoinHandle を経て supervisor が ledger の下で `open_after_joined_sweep(proof)` に渡す。swept でなければ proof はその場で drop され、自分の entry だけを Consumed にする。
11. **sweep の mutex 上限**：§5.1 どおり `recover_attempt_bounded` にだけ 100 ms の mutex 上限を足した（page 読取は従来どおり per-op 250 ms で有限）。Native の recovery の per-op／busy の定数は D-gen の定数を参照する（E14）。
12. **owner の試験 probe**：`AfterCommit` は、claim が `Claimed` のときは lease を保持したまま、結果不明のときは lease を drop した後（reread の直前）に呼ぶ。O8b／O9 は lease を持たない状態で edge や DB mutex の保持を入れる必要があるため。
13. **試験ファイル**：owner の試験は `nir1_generation_owner_tests.rs`（`#[path]` の子 module）に置いた。旧 `GenerationClaimOwner` の loopback fixture はここへ移した（O14）。owner の同期版 sweep 試験 helper `sweep_and_open_ready_entry_for_test`（`cfg(test)`）を N-gen に置いた。supervisor と同じく ledger の下で proof を使って gate を開ける。
14. **capture の refusal の写し方**：profile の認可失敗は `ProfileRevoked`、route 設定の読取失敗は `RouteChanged`、create の NotCommitted は `AlreadyExists`→`SubmissionAlreadyAttempted`、`NotCurrent`→`SubmissionNotCurrent`、`Cancelled`→`Cancelled`、それ以外は `Store(failure)`。

## 14. 独立受入れの P3 への対応（builder、2026-10-13）

4観点の独立受入れ（accept、P2 以上は 0）の P3 のうち、指示された5件を直した。§1〜§13 の型、lock 順、上限は変えていない。判断を変えたのは次の2点で、どちらも HOLD に当たらない（schema、AttemptBinding、`#[napi]`、IPC は変えない。既存の上限の値も変えない）。
- create の COMMIT の結果不明を、reread が確認済みの不在で解決した場合の refusal（14-3。§13-14 の写像を広げる）
- sweep の `ConnectionBusy` の有限な再試行（14-5。§5.1 の recover の項と §13-11 に足す）

1. **registry の上限（16）の試験**【O15】
   - registry 単体（`o15_registry_checks_the_session_bound_before_allocation`）
     - 16 件を予約した後、別 session の 17 件目は `InFlightCapacity`。slot も token も増えない。上限の検査が push と token の採番より前にあることを示す。
     - 同じ key の拒否（`SameSubmissionInFlight`、`SessionBusy`）は、上限より先に決まる。
     - Unresolved の slot も上限に数える。後の Open entry の epoch で prune されてから、17 件目が入る。in-flight の slot を返せば次の session が入る。
   - owner（`o15_the_seventeenth_session_capture_is_refused_and_keeps_nothing`）
     - 17 の chat session と caller で capture する。17 件目は `InFlightCapacity`。
     - 拒否された capture は、slot、participant、workspace operation、gate の lease を残さない。1件を drop すると入る。
   - 変異で確かめた：`>=` を `>` にする、または検査を push の後に移すと、O15 の2件が落ちる。

2. **§13-1 の照合の試験**【D13、O16】
   - D13（DB、`native-current-human-capture`）
     - binding の profile、caller、caller epoch のどれかが capture の owner と違えば `Conflict`（NotCommitted、`NIR1_GENERATION_CAPTURE_BINDING_MISMATCH`）。
     - 同じ path を新しい authority instance で開き直した workspace は `NotCurrent`（`NIR1_GENERATION_CAPTURE_WORKSPACE_MISMATCH`）。同じ instance で別の locator を持つ owner も同じ。どれも行を書かない。正規の caller と workspace では作れる。
     - 開き直しの場合、transaction の中の capture 行の照合は通ってしまう（行も owner も変わらないため）。古い incarnation の capture から新しい incarnation に attempt を作ることを拒むのは、この前置きの検査だけである。
     - 変異で確かめた：caller の比較、authority instance の比較、locator の比較を1つずつ外すと、それぞれ D13 が落ちる。
   - O16（Native）
     - 別 session の caller の capture は `SubmissionMismatch`。slot、participant、lease を残さない。
     - 別 project の request は create で `SubmissionMismatch`。
     - 同じ chat session の2人目の登録済み caller は capture を通る。しかし create は DB の owner 照合で `Store(Conflict)` になり、attempt を作らない。capture した caller 自身は作れる。

3. **create の結果不明と確認済みの不在**【O17】
   - 写像を `create_refusal(failure)` の1か所にまとめた。`Cancelled` は `Cancelled`、`NotCurrent` は `SubmissionNotCurrent`、それ以外は `Store(failure)`。
   - 使う場所は2つ。NotCommitted（`AlreadyExists` は従来どおり先に `SubmissionAlreadyAttempted` にする）と、Unknown を pinned の exact reread が確認済みの不在（`Ok(None)`）で解決した場合。
   - 理由：どちらも「この create の attempt は durable でない」ことが確定している。同じ failure を経路によって別の refusal にしない（security-failclosed の P3）。fail-closed は変わらない（attempt なし、slot は解放）。
   - 試験
     - 試験用の probe 点 `AfterPreCommit`（`cfg(test)`）を足した。create の pre_commit の検査が通った直後に呼ぶ。ここで cancel を立てると、D-conn が COMMIT の前に行う fence の再検査で止まり、Unknown で確認済みの不在になる（§13-3）。
     - refusal は `Cancelled` になる。reread が走ったこと（`AfterCommit` の probe）、行が残らないこと、slot が解放されることも確かめる。同じ submission の create は、その後もできる。
     - `NotCurrent` は、現行では op の後に生じない。そのため共有の写像を直接固定する。
   - 変異で確かめた：`Ok(None)` の写像を `Store(failure)` に戻すと O17 が落ちる。

4. **pairing の照合の試験**【D14】（撤去した legacy 試験 `same_binding_attempt_swap_is_rejected_for_claim_and_terminal_paths` の網羅を戻す）
   - payload だけが違う same-binding の attempt を2つ作り、片方の expected に他方の ID を入れる。
   - claim、zero-send、post-transport の finish、Pinned の recover は、相手が未 claim のときも claim 済みのときも `Conflict`（`NIR1_GENERATION_ATTEMPT_CONFLICT`）になる。相手に claim も terminal も書かない。接続は再利用できる。正しい expected なら finish できる。
   - 変異で確かめた：finish、recover_claimed、zero-send の `read_expected_attempt_in_tx` を、それぞれ照合しない読取に替えると D14 が落ちる。

5. **sweep の `ConnectionBusy` の有限な再試行**【D15、R6】
   - 問題：DT-2 は `recover_attempt_bounded` に DB mutex 100 ms の上限を足した。sweep は、その `ConnectionBusy` を1回で sweep 全体の Err にしていた。
     - Err の sweep では、その entry の gate は開かない（Consumed）。次の Ready entry（再 Open、Restore）か restart まで生成できない。
     - DT-1 では、mutex の待ちは per-op 250 ms まで許されていた。
   - 採る案：N-gen の `recover_pending_attempt` が、1件の pending attempt の recover を最大 `MAX_RECOVERY_CONNECTION_BUSY_ATTEMPTS = 3` 回試す（再試行は最大2回。定数は N-gen の sweep の上限の隣に置く。E14）。
     - 再試行するのは、DB の `is_recovery_connection_busy`（error chain に `NIR1_SQL_CONNECTION_LOCK_TIMEOUT` がある）が真のときだけ。この場合は mutex を取れずに返っており、SQL は走っていない。recover 自体も冪等である。
     - 次の回の前に、sweep の checkpoint（shutdown、同じ Ready entry、sweep の deadline）を通す。各回の op の deadline は `budget.operation()` で sweep の deadline に clip される。
     - それ以外の error と3回目の timeout は、従来どおり Incomplete。3回目には `NIR1_GENERATION_RECOVERY_CONNECTION_BUSY_LIMIT` の context を付け、理由を typed にする。
     - 再試行は item の数（2048）に数えない。1件あたり3回で有限で、全体は sweep の 5 s で有限である。
   - `nir1-defensive-resource-limits`（proposal/6。確認済み）の規則への適合
     - 規則1（有限）：1件あたり3回。1回の mutex の待ちは 100 ms なので、1件の合計は 300 ms 以下。sweep の 5 s と item の 2048 は変えない。
     - 規則2（取消できる）：待つのは mutex の取得 loop の中だけで、1 ms ごとに participant の stop（Transition、shutdown）と op の deadline を読む。回と回の間は checkpoint を通す。sleep は入れない。
     - 規則3（先に検査）：次の回を始める前に、回数と checkpoint を検査する。
     - 規則4（fail-safe）：上限に達したら Incomplete。その entry の gate は開かない（Closed＋Consumed）。その場では、これ以上再試行しない。次の Ready entry の sweep が最初からやり直す。
     - 規則5（数値の記録）：値と実測を下に書く。integrator は §11-1 の防御上限に加えて PR に記録する。
     - 規則6・7：締めるのは自由。merge の後に回数を増やす、または回と回の間に待ちを入れて延ばすには、再確認が要る。
     - 規則8：回数と時間の論理的な会計だけで強制する。
   - 値
     - 回数 3：1件の mutex 待ちの許容が 3×100 ms＝300 ms になる。DT-1 の1 op の許容（250 ms）を下回らない最小の回数である。owner の zero-send の書込み（`NIR1_ZERO_SEND_TERMINAL_ATTEMPTS`＝3）と同じ値で、DT-2 の一時的な失敗の試行回数をそろえる。mutex が保持され続ける場合は、回数を増やしても Incomplete が遅れるだけで、gate の結果は変わらない。
     - 間隔 0 ms（回と回の間に sleep を入れない）：待ちそのものが、100 ms の窓の中で 1 ms ごとに取得と停止を確かめている。sleep を足すと、取得も取消の観測もしない時間ができ（規則2）、5 s の中で待てる時間が減るだけになる。timeout した回は接続を取っていないので、SQLite にも保持者にも負荷を足さない。
   - 実測（2026-10-13。この worktree、Linux 7.2.9、12 CPU、debug の試験 build、`--test-threads=1`、ほかの cargo build なし。R6 に一時的な計測出力を足して5回走らせ、計測の後で外した）
     - 1回目の間だけ mutex を保持：2回で完了して gate が開く。102.1〜102.9 ms。
     - ずっと保持：3回で Incomplete（`…_CONNECTION_BUSY_LIMIT`）。302.2〜303.2 ms。
     - sweep の時間を 150 ms に縮める：2回。150.2〜151.2 ms。2回目は、sweep の deadline に clip された op の deadline で止まる（busy ではない）。
     - 2回目の前に shutdown：2回。101.0〜101.4 ms。2回目は最初の検査で止まる。
     - 製品の負荷（renderer の初期読込が DB mutex を続けて持つ場合）の分布は測っていない。integrator は実測から回数を締めてよい（規則5・6）。
   - 代替案
     - recover だけ mutex の上限を外す、または 250 ms に戻す：採らない。§5.1 の上限（1か所の定数）と、`ConnectionBusy` を op の deadline 超過と分ける typed な分類が崩れる。
     - sweep の deadline まで回数の上限なしで再試行する：採らない。規則1（回数の上限）に反する。mutex が保持され続ければ、5 s 待っても同じ Incomplete になる。
     - `SqliteBusy` も再試行する：採らない。busy の上限は DT-1 と同じ 100 ms のままで、劣化していない。指摘の対象は mutex の待ちだけである。
   - 試験
     - D15：mutex の保持中の `recover_attempt_bounded` は、100 ms 以上待って `is_recovery_connection_busy` が真になる。mutex の上限より短い deadline の失敗は偽。解放の後は InterruptedUnknown で回復する。
     - R6（3件）
       - 1回目の間だけ mutex を保持すると、2回目で回復する。sweep は完了し、gate は exact entry で開く。
       - 保持し続けると、ちょうど3回で `…_CONNECTION_BUSY_LIMIT` の Incomplete になる（300 ms 以上 5 s 未満、terminal は書かない）。sweep の時間が 150 ms なら3回目に届かない。解放の後、新しい owner が回復する。
       - 2回目の前の shutdown で止まり、busy の理由にはならない。
     - 試験用の probe：`AppState::nir1_generation_recovery_try_probe`（`cfg(test)`）を、各回の前に回の番号で呼ぶ。
     - 変異で確かめた：回数を1にすると R6 の3件が落ちる。
   - lock 順と HOLD
     - 回と回の間は DB mutex を持たない。checkpoint が読む Core と gate は短い leaf である（L1、L2）。
     - 既存の上限の値（DB mutex 100 ms、busy 100 ms、per-op 250 ms、sweep 5 s、item 2048）は変えない。
     - 1件あたりの待ちの許容は、DT-2 の候補の 100 ms から 300 ms に増える。DT-2 は未 merge で、新しい防御上限は proposal/6 の規則に従って integrator が記録する。そのため緩和の HOLD には当たらない。

6. **§11-1 への追加**：新しい防御上限に「sweep の `ConnectionBusy` の試行は1件あたり3回、間隔 0 ms」を加える。

7. **範囲外（引き継ぎ）**：受入れが挙げた次の P3 は、この修正では扱っていない。
   - lifecycle-liveness：`mark_unresolved` が gate の epoch を lock の外で読むため、slot の解除がユーザー操作1回分遅れうる（§5.5 の「1 entry 遅れるだけ」の実際の重さ）。
   - lifecycle-locks：`Nir1PreparedAttempt`／`Nir1TransportOwner` の Drop が同期の DB 書込みをする（unwinding 中の二重 panic、tokio worker の上での停止）。`finish` が Unknown で失敗したとき、durable な terminal を caller に返せない（DT-5）。
   - security-failclosed：`claim_for_transport` の手順1〜2（BEGIN の前の lease の失敗、route の不一致、permit の失効から zero-send へ）の分岐の試験。
