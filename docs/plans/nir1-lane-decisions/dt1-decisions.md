# DT-1 decisions（GDX-PRECHECK-001：startup claim barrier と lifecycle seam）

base: origin/master a153743b。WIP（#609 基点の nir1_startup_barrier.rs）は参考資料のみ。新しい候補として作り直し、再試験する。
U3 委任の範囲：worker／owner／終了処理／lifecycle の技術判断。新しい送信先、保存範囲、閾値、製品公開、製品認可、新しい外部契約には触れない。
N-API／IPC の入口は追加しない（A-1）。schema、AttemptBinding、DB 保存は変更しない。

## 1. 信頼境界

- gate と seam は process-local な Rust の状態だけを持つ。renderer、IPC、N-API からは到達できない（`pub(crate)`、wire 型なし）。
- gate を開く根拠は、Native が所有する #610 の recovery sweep の実際の Join と、Core の exact な Ready entry（binding、revision）だけ。
  renderer の値、時刻、カウンタ 0 は根拠にしない。
- process restart 後は gate を新しく作るので、必ず Closed から始まる。永続化しない。

## 2. lifecycle seam の API（grimodex-db `workspace_lifecycle.rs`、1か所）

```rust
#[non_exhaustive]
pub enum LifecycleEdge {
    TransitionAdmitted { operation_id: OperationId, kind: AdmissionKind, revision: StateRevision },
    ReadyPublished { binding: LiveBinding, revision: StateRevision },
    Unavailable { revision: StateRevision },          // Ready／Transition から RecoveryRequired・NoWorkspace・Closed・Finishing へ
    ShutdownRequested { revision: StateRevision },    // shutdown_requested が false→true になった時点（1回だけ）
}
pub trait WorkspaceLifecycleObserver: Send + Sync {
    fn on_lifecycle_edge(&self, edge: &LifecycleEdge);
}
impl WorkspaceLifecycleCore {
    pub fn register_observer(&self, observer: Arc<dyn WorkspaceLifecycleObserver>) -> Result<(), LifecycleError>;
}
pub const MAX_LIFECYCLE_OBSERVERS: usize = 4;
```

- 発火点は1か所：Core の `lock_state()` が返す guard の Drop。guard を取った時点の (state, shutdown_requested) と解放直前の値を比べ、
  edge を Core の mutex を持ったまま observer に渡す。個々の状態書込み箇所には手を入れないので、書込み経路の追加漏れが起きない。
- edge の分類（同じ lock 区間で1つだけ）：
  1. shutdown_requested が false→true：`ShutdownRequested`（最優先）。
  2. 後状態が `Ready(b)` で、前状態が同じ `Ready(b)` でない：`ReadyPublished`。
  3. 後状態が `Transition{op≠0}` で、前状態が同じ op の Transition でない、かつ admissions に op がある：`TransitionAdmitted`（kind は ticket から）。
  4. それ以外で状態が変わった（RecoveryRequired、NoWorkspace、Closed、Transition{0, Finishing}、admissions にない Transition）：`Unavailable`。
  - revision だけの変化（quarantine、background recovery の完了、stage 変更）は edge にしない。
- 契約：observer は Core の mutex の内側で呼ばれる。lock 順は Core→（observer 登録表）→observer 自身の短い mutex。
  observer は Core・Projection・DB を呼ばず、block せず、panic しない。登録は Core の lock を持たずに行う。
- 後続の利用者：CB-2 の final-commit reservation は TransitionAdmitted／Unavailable／ShutdownRequested で reservation epoch を閉じる。
  CP-2a の C-query 製品 owner は同じ edge で pre-warm／BUSY を退役させる。どちらも observer を1つ追加するだけで、Core の変更は要らない。

## 3. gate（Native `nir1_startup_barrier.rs`）

状態：`epoch: u64`、`phase: Closed | Recovering{entry, swept} | Open(entry)`、`closure: Initial | Transition(op) | Ready(entry) | Unavailable | Consumed`、
`leases: BTreeMap<epoch, count>`、永久フラグ `poisoned`（mutex poison または epoch 枯渇）と `shutdown`。

- 閉鎖：seam の edge ごとに epoch+1、phase=Closed、closure を edge 由来に更新し、Condvar を notify_all する。
- Recovering へ：`begin_recovery(binding, revision, max_wait)`。closure が exact な `Ready(binding, revision)` で、phase が Closed、
  かつこの epoch 以前の lease が 0 になった場合だけ（待機は有限）。
- Open へ：`open_after_joined_sweep(binding, revision)`。phase が `Recovering{exact entry, swept: true}` のときだけ。
  swept は sweep が全 page を尽くして Ok を返したときに worker が token で記録する。
- token を記録せずに drop したら（sweep の error、cutoff、cancel、panic）、phase は Closed に戻り closure は Consumed になる。
  同じ entry では再開しない。次の Ready entry で再試行する。
- lease：`try_lease(binding, ready_revision)` は phase が `Open(exact entry)` のときだけ発行する。epoch ごとに数え、Drop で減らして notify_all する。
  `is_current()` で再検証する。

## 4. 有限 owner／lifecycle matrix

| 項目 | owner | 有限性・終了の証拠 |
|---|---|---|
| entry | Core の edge（Open／Restore／Recover の admission、Ready、Unavailable、Shutdown）。renderer からの入口はない | edge は Core の mutex 内で同期的に処理される |
| start | Open／Restore の N-API 成功後に呼ぶ #610 の `start_generation_recovery_after_ready`。ledger の reservation が1件だけ | spawn_blocking の JoinHandle を supervisor が保持する |
| retry | 新しい Ready entry（revision が上がる）。ledger は Incomplete／Complete の古い revision を再 schedule する | 同じ entry の再開はしない（Consumed） |
| reentrant | worker_active 中の Ready は pending_ready_revision に合流し、Join 後に1回だけ起動する。gate は新しい Ready edge で既に閉じている | 古い worker は新しい entry と一致しないので開けない |
| admission closure | Core の edge で Core→Gate の順に即時閉鎖。lease の新規発行は Open のときだけ | Gate の mutex は短く、待機は Condvar の外側で計測する |
| pending start | ledger の Scheduled。Ready が変わったら Incomplete にする（#610 のまま） | gate は Closed のまま |
| active lease | `Nir1StartupLease` の所有者（DT-2 の claim。この TASK には製品の利用者はいない） | Drop が実退役の証拠。panic 中の Drop でも減る |
| cancel | sweep worker の Drop／error → token を drop → Closed＋Consumed | 開かない |
| drain 上限 | transition の Ready publish 前（adapter の `publish_from_workspace`）で 250 ms。begin_recovery 前にも同じ上限 | 超過したら Ready を出さず `require_recovery`（RecoveryRequired）。gate は Closed のまま |
| 終了の証拠 | lease の Drop（カウンタ）、sweep の Join 成功、ledger の Complete、Core が同じ revision の Ready であること | タイムアウトは退役とみなさない（カウントを残す） |
| error／timeout／onClosed | drain：TimedOut→RecoveryRequired。Stale（shutdown が割り込んだ）→既存の activate がそのまま拒否する。Poisoned→Ready は出すが gate は永久に Closed | shutdown の edge が Condvar で待機者を起こし、即 Stale を返す |
| shutdown | `request_shutdown` の edge と、`finish_workspace_shutdown` 冒頭の明示的な `close_for_shutdown`（Core が poison でも閉じる） | 永久に Closed |
| restart | 新しい AppState の gate は Closed。Open→Ready→sweep→Join の後で初めて Open になる | 永続状態なし |

## 5. 判断と代替案

- D1（信頼度 85）：seam は Core の lock guard の Drop で状態差分から edge を出す。
  代替案は「各書込み箇所で明示的に emit する」（約15か所あり、将来の追加で漏れやすい）と「Native adapter で通知する」（Core を直接呼ぶ経路、たとえば
  maintenance permit の transfer_to_recovery を取りこぼす）。どちらも採らない。
- D2（信頼度 80）：drain は Core の lock の外（adapter の Ready publish 直前）で行う。Core の lock を持ったまま 250 ms 待つと、
  lease の所有者が snapshot を読むときに詰まり、偽の timeout になるため。drain から activate までの間は gate が Closed なので、新しい lease は出ない。
- D3（信頼度 75）：background の descriptor recovery（W1 を回復中に W2 が Ready のまま）は W2 の Ready entry を変えないので、gate を閉じない。
  前景の maintenance Recover（Transition→activate）と Safe Mode の Recover は admission と Ready の edge で閉じる。
- D4（信頼度 70、制限）：gate を再び開く sweep の起動は、既存の Open／Restore 成功時の hook だけ。maintenance Recover の Ready、
  失敗した Restore の Unchanged Ready、compat の set_ready の後は、次に hook のある Ready entry まで Closed のまま（fail-closed）。
  失敗した Restore で hook を起動しないのは #610 の試験で固定された仕様なので変えない。DT-2 で製品入口を作るときに再検討する。
- D5（信頼度 80）：ledger の Complete は、より新しい revision の Ready（同じ workspace の Open で Unchanged になる場合）で再 schedule する。
  gate は exact な revision ごとに sweep を要求するため。sweep は pending attempt がなければ空の1 page で終わる。
- D6（信頼度 85）：gate の poison や epoch 枯渇は gate だけを永久に Closed にし、workspace は RecoveryRequired にしない。
  NIR-1 の transport だけを止め、原稿の操作は止めない。
