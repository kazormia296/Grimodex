# 自動メンテナンス transient 失敗の正常解放 — owner/lifecycle マトリクス

GDX-PRECHECK-001（async lifecycle 変更）に基づく有限マトリクス。行番号は特記がない限り
基点 `13e3f6c6`（origin/master）のもの。実装後の位置は末尾「実装後の参照」に記す。

- `lib.rs` = `electron/native/grimodex-node/src/lib.rs`
- `wl.rs` = `src-tauri/crates/grimodex-db/src/workspace_lifecycle.rs`
- `lb.rs` = `src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs`
- `rr.rs` = `src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs`
- `mr.rs` = `src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs`
- `nm.ts` = `electron/main/narrativeMaintenance.ts`

## 1. 目的と判断規則

現状、自動経路の supervisor は Join 後に worker が `Err` を返すと、証拠に関係なく
`mark_joined → retire_authority_for_recovery → transfer_to_recovery_diagnosed` を行い
（lib.rs:8326-8372）、workspace 全体を `RecoveryRequired` にする（wl.rs:3347-3352 で
`state = RecoveryRequired` と `revision + 1`）。手動経路（lib.rs:3569-3618）と
foreground 経路（lib.rs:4382-4467）は「接続が再利用可能かつ Run ownership なし」の場合に
通常解放している。

自動経路の正常解放条件（すべて必須。どれかが欠ければ従来どおり transfer）:

| # | 条件 | 根拠となる証拠 |
|---|------|----------------|
| a | `failure_class == FailureClass::Error` | catch_unwind で Panic（lib.rs:8236-8240）、JoinError で Panic/Join（lib.rs:8296-8306）。Panic/Join は無条件 transfer |
| b | `permit.has_run_ownership() == false`（Join 後、post-commit hook 実行後） | wl.rs:3008-3015。Run の durable terminalization は `mark_run_terminalized`（wl.rs:2971-3006）でのみ ownership slot が消える。照会失敗は ownership ありとみなす |
| c | 同一 attempt の cleanup receipt が clean、かつ `connection_reusable()` | attempt guard の Drop/finalize が `settle` receipt（`cleanup.status == "clean"` と `connection_reusable`）から計算する `cleanup_reusable`（lib.rs:6159-6187, 6245-6301）を worker outcome に運ぶ。supervisor はさらに pinned authority の `connection_reusable()` を Join 後に再確認する。ただし receipt の `connection_reusable` も同じ `connection_health` から導出されるため、独立した二重確認は Join 後の再読だけである（受入レビュー P3-2）。attempt を持たない cycle は receipt がないため transfer |

正常解放時は `operation_result` を `Err` のまま保ち、delivery 端末記録は既存の
`maintenance-native-error`（lib.rs:8380-8400）、main には reject として届く。

## 2. Owner / lifecycle マトリクス（自動 supervisor）

| 区分 | 経路・所有者 | 証拠 (file:line) | 変更 |
|------|--------------|------------------|------|
| entry | `run_narrative_maintenance_cycle`（N-API）。main の scheduler cycle（nm.ts:3315-3335）から呼ばれる | lib.rs:7213 | なし |
| 事前 recovery | admission 前に既存 descriptor を解決（delivery 非依存） | lib.rs:7222-7233, 3093 | なし |
| workspace operation | `begin_workspace_operation` guard | lib.rs:7235-7237 | なし |
| admission / pending-start | `begin_maintenance` で permit を spawn 前に予約。NotAdmitted は `not-admitted`/`lifecycle-no-workspace` で返す | lib.rs:7243-7264 | なし |
| pending-start の permit 所有 | `permit_return_slot` → `MaintenancePermitLease`。worker 消失時は Drop で slot に戻し、supervisor が JoinError 経路で回収 | lib.rs:7265-7266, 6091-6136, 8296-8300 | なし |
| delivery admission | `admit_delivery_at`。Replay/Full/SealedAbsent 等は Ok で早期 return（lifecycle 未開始なので release） | lib.rs:7334-7382 | なし |
| attempt 所有 | `narrative_maintenance_attempts.start` で attempt owner を原子的に admit。guard が Drop で interrupted settle、cleanup clean のときだけ recovery gate を release | lib.rs:7383-7412, 6245-6301 | Drop/finalize の `cleanup_reusable` を共有 slot に記録し outcome へ運ぶ |
| start 境界 | `permit.start()`。失敗時は `cancel_before_start_in_place` で admission を除去し permit を捨てる。成功で `lifecycle_work_started = true`、`arm_scope_finalizer` | lib.rs:7485-7506 | なし |
| reentrant / 重複 | 同一 attemptId の重複 cycle は `start` が拒否（原 owner を変更しない）。maintenance admission は 1 つだけ（`ActiveOperation`） | lib.rs:7396-7405, wl.rs テスト 5846-5853 | なし |
| retry（Rust 側） | 失敗 Run の再発見時に durable `next_attempt_at` を尊重。期限前は `has_more` で noop | mr.rs:3169-3215, 4782-4788 | なし |
| retry（main 側） | 汎用失敗分岐で `retryCount <= NARRATIVE_MAINTENANCE_MAX_RETRIES(3)` なら requeue、超過で `persistDeliveryFailure` | nm.ts:287, 4040-4170 | §4 参照 |
| active handle 所有 | worker の `lifecycle_permit`（lease）、`worker_authority`（pinned DB）、attempt guard | lib.rs:7284-7294, 7427-7430 | なし |
| Run ownership 付与 | `attach_run`/`reserve_run`/`mark_run_creation_*` を `MaintenanceCycleControl` で注入 | lib.rs:7919-8021 | `mark_run_terminalized: Some` を追加（現状 None, lib.rs:8022） |
| cancellation | `should_stop`: lifecycle stop（transition の drain）→ `NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED`、attempt stop → `NEX_MAINTENANCE_ATTEMPT_CANCELLED` | lib.rs:7828-7852; `cancel_narrative_maintenance_attempt` lib.rs:7145 | なし（下表で処理だけ変わる） |
| preemption | `is_narrative_maintenance_preemption` を `Ok({accepted, hasMore, preempted})` に変換 | lib.rs:8243-8253, 312 | 変更しない |
| bounded wait | supervisor は worker の Join を待つ（`worker_join.await`）。worker 内の DB 待機は maintenance no-wait scope（`enter_maintenance_connection_no_wait`）。transition/shutdown は permit 解放か descriptor 移管まで完了しない | lib.rs:8275, 7520-7521, wl.rs:1747 | なし |
| 終了証拠 (Join) | `worker_join.await` の結果（Ok/Ok(Err)/JoinError）で `mark_joined` | lib.rs:8275-8321, 8334-8336 / 8374-8377 | なし |
| 終了証拠 (close) | `retire_authority_for_recovery_with_status` が接続を close し、成功時のみ `mark_connection_retired` | lib.rs:2522-2581, 8337-8345 | なし |
| 終了証拠 (terminal receipt) | attempt receipt（`settle`）と delivery 端末記録（`mark_delivery_terminal_with_result`） | state.rs:2035-2088, lib.rs:8380-8400 | なし |
| error/timeout 所有 | Join 後の `Err` は supervisor が解放か transfer を決める唯一の owner。transfer 失敗は `NEX_MAINTENANCE_LIFECYCLE_RECOVERY_TRANSFER_FAILED` | lib.rs:8323-8379 | 判断規則を §1 に変更 |
| delivery の main 側 owner | reject 後に `resolveNarrativeMaintenanceDelivery` → OutOfOrder なら exact delivery を replay 対象として保持 | nm.ts:3573-3670 | §4 参照 |
| persisted restart state | durable Run/Task/Attempt 行（failed/running）、delivery failure receipt と durable wake（`record_narrative_maintenance_delivery_failure`）、再起動時の interrupted Run 終端化 | lib.rs:8446; mr.rs:4509-4740 | なし |

## 3. 障害クラス表

「Join 時の証拠」→「処理」→「証明するテスト」。テスト名は実装時に追加・確認するもの。

| 障害クラス | Join 時の証拠 | 処理 | 証明するテスト |
|------------|----------------|------|----------------|
| CI 注入 transient-io | 注入 tx が Run を作成し同一 tx で failed（lb.rs:308-445）。permit に attach されない → ownership なし。guard Drop は clean receipt | 正常解放。Err を main に返し bounded retry。Rust 側は backoff 後に新 Run（mr.rs:3169-3215） | node: transient-io 注入の正常解放テスト（新規 1）。journey `c2-5b-transient-bounded-retry` |
| 実 transient（locked/busy/IOERR）: Run 作成前 | ownership なし（または作成 tx rollback で `CreationNotCommitted` が残る） | ownership なしなら解放。`CreationNotCommitted` も `run.is_some()` なので transfer（wl.rs:3014） | 新規 1 と同一判定（関数単体テスト） |
| 実 transient: Run 作成後、Backfill transform 失敗 | finalize tx が `fail_maintenance_run_in_tx` を COMMIT（lb.rs:765-836, 1026-1037）→ COMMIT 後に hook → ownership 除去 | 正常解放 | node: transform 失敗 → failed 行 COMMIT → hook → 解放（新規 2）。db: hook が COMMIT 後のみ呼ばれる（新規 8） |
| 実 transient: Rebuild/Verify 失敗 | 既存 `record_*_failure_controlled` が COMMIT 後に hook（rr.rs:4366-4391, 4401-4423） | 自動経路でも hook を配線したので正常解放 | 既存 rr.rs のテスト＋新規 2 の判定 |
| lease timeout / epoch 変更 | Backfill 成功 finalize 内で `NEX_BACKFILL_STALE_EPOCH` → tx rollback（lb.rs:789-795）。Run は running のまま、ownership 残存 | transfer（期待どおり） | 新規 6 と同じ判定（ownership 残存 → transfer） |
| 終端化 tx 失敗（SQLITE_FULL 等） | finalize tx が rollback → hook 未実行 → ownership 残存 | transfer。descriptor が Run を保持 | node: 終端化 tx 失敗で transfer（新規 6）。db: rollback では hook 不呼出（新規 8） |
| preemption | `NEX_MAINTENANCE_CONNECTION_PREEMPTED` 等は Ok に変換（lib.rs:8243-8253）。Run は cancel 後 hook、または pending owner に defer | 変更なし（Ok → release、main は interrupted requeue） | 既存 `native_cycle_budget_requeues_unstarted_followups_without_workspace_recovery`（lib.rs:16865）と新規 7 |
| ATTEMPT_CANCELLED / LIFECYCLE_STOP_REQUESTED（Join 後） | 作成前なら ownership なし。controlled termination で Run を cancel COMMIT 後なら hook で除去（rr.rs:4303-4329）。完了済み Run が attach されたままなら ownership 残存 | ownership なし＋clean なら解放（transition の drain が RecoveryRequired を経ずに進む）。残存なら transfer | 判定関数テスト（新規 1 系）。main 側は `isControlledMaintenanceInterruption` の interrupted 分岐（nm.ts:3901-3960）。`NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED` は当初この判定に含まれず汎用失敗分岐で retry 予算を消費していたため、受入レビュー P2 を受けて判定に追加した |
| Panic / JoinError | `failure_class` が Panic/Join | 無条件 transfer | node: Panic/Join は ownership なし・clean でも transfer（新規 5） |
| connection quarantine | guard の receipt が failed、または Join 後に `connection_reusable() == false` | transfer（retire + `connection_retired` receipt） | node: quarantine で transfer（新規 4） |
| CreationUnknown | `RunCreationState::CreationUnknown` の ownership 残存 | transfer。descriptor に Run、retire 成功で `connection_retired` | node: CreationUnknown で transfer（新規 3） |
| corruption / contract（Run 非所有） | 例: 重複 foreground marker（lib.rs:19774-19832 の既存テスト）。attempt なし cycle は receipt がなく transfer のまま | attempt ありで ownership なし・clean なら解放し、main の bounded retry → `persistDeliveryFailure`。Run を所有する contract failure は Run を failed COMMIT し Inbox 投影（lb.rs:1026-1037）後に解放 | 既存 `napi_duplicate_terminal_and_running_markers_fail_closed` が transfer を維持することを確認 |

## 4. main 側の扱い

- `isCanonicalTransientFailure`（nm.ts:1027-1033）はログ文言の分類だけに使われる
  （nm.ts:4156-4159）。requeue と `retryCounts` 消費は汎用失敗分岐（nm.ts:4040-4100）で
  エラー種別に依存しないため、SQLite の生エラーを Rust で正規化する必要はない。
- ただし、Native が reject した cycle の delivery は「曖昧な admission」とみなされ、
  `resolve` が OutOfOrder を返すと exact delivery を replay 対象に保持する（nm.ts:3640-3670）。
  汎用失敗分岐は requeue 時に delivery を retire しない（nm.ts:4138-4149）。replay で Native が
  返すのは端末 placeholder `maintenance-native-error`（workspace-unavailable）であり、replay 中は
  attempt receipt がないため「unresolved workspace completion」として park され続ける
  （nm.ts:3750-3800, 3955-3990）。従来は Join 後 Err がすべて recovery 移管（Ok 応答）だったため
  顕在化しなかったが、正常解放を導入すると transient retry が止まる。
- 最小修正: 同一 attempt の terminal receipt が `interrupted` かつ `stopReason == null` で
  採用済み（`terminalReceiptAllowsDeliveryRetirement()`）なら、requeue 後に delivery を retire する。
  Native の ACK は terminal 記録しか retire しない（wl.rs:4513-4533）ため、未終端の記録を
  誤って退役させることはない。requeue された work は新しい delivery sequence と新しい attempt で
  実行され、`retryCounts` を 1 消費する（`MAX_RETRIES` 超過時の `persistDeliveryFailure` は従来どおり）。
- 証明: main テスト `retries a normally released Native transient error as a fresh supervised execution`
  （修正前は replay ループで 2 回目の fresh 実行が起きず失敗）。
- transition の drain（`NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED`）は、正常解放後に main へ reject として
  届く。従来は Native が recovery 移管して `Ok(maintenance-recovery-required)` を返していたため汎用分岐に
  落ちなかったが、正常解放の導入で汎用分岐に落ち、同じ work が成功を挟まず 3 回 drain されると
  `persistDeliveryFailure` が「retry exhausted」を偽って永続化する。`isControlledMaintenanceInterruption`
  に同コードを加え、interrupted 分岐（retry 予算を消費しない）で扱う。
- 証明: main テスト `treats a released lifecycle stop request as a controlled interruption without spending retries`
  （修正前は 4 回目で打ち切られ失敗、修正後は予算を超える回数の drain でも失敗 receipt を残さない）。

## 6. 受入レビューの記録

- 独立受入レビュー（read-only、候補 fingerprint 不変を確認）: 初回 REJECT（P2 1 件）。P2 は上記の
  main 側修正と対応表訂正で解消した。
- 工程の逸脱（P3-3）: main 側の修正とテストは、本マトリクス作成より前に編集された。Rust 側の変更は
  すべてマトリクス作成後。マトリクスは事後に作成し、main 側の記述はコードと照合済み。
- 残す P3（本変更では対応しない）:
  - P3-1: 同一 cycle 内で Backfill 成功後に Rebuild/Verify が続き、後続が失敗した場合、成功 Run が
    attach されたままなので解放されず transfer する（保守的、回帰なし）。成功 finalize の COMMIT 後にも
    `mark_run_terminalized` を呼ぶ follow-up と「成功→失敗」同一 cycle のテストが候補。
  - P3-4: Run を持たない corruption/contract エラーも解放され、bounded retry と
    `persistDeliveryFailure` に委ねられる（option B の意図どおり）。将来 CORRUPT/NOTADB を scope cleanup で
    quarantine することを検討する。

## 5. 範囲外

- RecoveryRequired の renderer 配信、recovery 後の launcher 挙動、renderer の quiescence 変更。
- preemption 処理の変更。
- 成功完了した Run の hook 呼び出し（成功は Ok で解放されるため不要。完了後の
  ATTEMPT_CANCELLED は保守的に transfer のまま）。

## 実装後の参照

作業ツリー上の行番号（未 commit）。

| 項目 | 位置 |
|------|------|
| 正常解放条件（a/b/c） | lib.rs:6074-6086 `automatic_maintenance_error_releases_normally` |
| Join 後 finalizer（解放／transfer） | lib.rs:6094-6164 `finalize_automatic_maintenance_permit`、判定呼び出し lib.rs:6110 |
| supervisor からの呼び出し | lib.rs:8473 |
| guard の cleanup proof 公開 | フィールド lib.rs:6187、`with_cleanup_proof` lib.rs:6267、Drop で store lib.rs:6428 |
| worker → outcome への受け渡し | slot 生成 lib.rs:7422、guard へ注入 lib.rs:7536、Join 前に load lib.rs:8397、outcome フィールド lib.rs:6201 |
| 自動経路の `mark_run_terminalized` 配線 | lib.rs:8136-8145、`Some(&mark_run_terminalized)` lib.rs:8163 |
| Backfill の COMMIT 後 hook | lb.rs:838-852（finalize tx が Ok を返した後、transform 失敗時のみ） |
| main の delivery 退役条件 | nm.ts:4138-4160 |

追加テスト:

| # | テスト | 修正前 |
|---|--------|--------|
| 1 | lib.rs `automatic_error_without_run_ownership_and_clean_cleanup_releases_normally`、`napi_injected_transient_error_after_join_releases_without_workspace_recovery` | 失敗（判定を無効化して確認） |
| 2 | lib.rs `automatic_error_after_committed_run_terminalization_releases_normally`、`napi_backfill_failure_committed_before_hook_releases_normally` | 失敗（後者は hook 配線を外しても失敗） |
| 3 | lib.rs `automatic_error_with_creation_unknown_run_transfers_with_retired_connection` | 成功（従来も transfer） |
| 4 | lib.rs `automatic_error_with_quarantined_cleanup_transfers_without_run_ownership` | 成功（従来も transfer） |
| 5 | lib.rs `automatic_panic_or_join_failure_transfers_unconditionally` | 成功（従来も transfer） |
| 6 | lib.rs `napi_backfill_terminalization_rollback_keeps_run_for_recovery` | 成功（従来も transfer） |
| 7 | 既存 `native_cycle_budget_requeues_unstarted_followups_without_workspace_recovery`（preemption → Ok/requeue） | 成功（変更なし） |
| 8 | lb.rs `controlled_backfill_failure_invokes_terminalization_hook_after_commit`（hook 時点で autocommit かつ failed）、`controlled_backfill_terminalization_rollback_does_not_invoke_hook` | 前者は hook 除去で失敗、後者は成功 |
| main | narrativeMaintenance.test.ts `retries a normally released Native transient error as a fresh supervised execution` | 失敗（replay ループで 2 回目の実行なし） |
