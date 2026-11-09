# (f2) 周期処理を「維持を取り消さない」形にする（dev 実験・未 commit）

worktree：`/home/grimodex/worktrees/Grimodex/claude-s7r1-chain-f2`（枝 `7bb60e83` の上）。patch：`f2.patch`（4 file、+68/-7）。

## 変更（事実）
1. `src-tauri/crates/grimodex-db/src/lib.rs`（`enter_maintenance_connection_no_wait` の直前）：**新 API** `Database::connection_busy_probe(&self) -> bool`。`self.conn.try_lock()` が `WouldBlock` のときだけ true。`ForegroundConnectionWaiter` を作らない。Poisoned は false（通常の取得にエラーを出させる）。
2. `src-tauri/crates/grimodex-db/src/dev_trace.rs`：counter `PERIODIC_SKIPS`、`note_periodic_skip()`、`agg` 行に `periodicSkips`。
3. `electron/native/grimodex-node/src/related_scenes/build.rs`：`schedule()` の**本番用 closure だけ**（`schedule_with` ではない＝test の BuildStep は不変）。`current_request` が真で probe が busy なら `note_periodic_skip` して `BuildOutcome::Retry` を返す。それ以外は従来どおり `build_once`。
4. `electron/native/grimodex-node/src/related_scenes.rs`：`current_operation` を `current_operation_with(state, lease, skip_if_busy) -> Result<Option<bool>>` に分け、`current_operation` は `skip_if_busy=false` の薄い wrapper（`unwrap_or(false)`）。`skip_if_busy` で probe が busy のときだけ、DB の read transaction の直前で `None` を返す。`reconcile` だけが `true` で呼ぶ。

既存の機構：維持側の no-wait／`lock_conn_with_check` は「維持が譲る」側の仕組みで、「foreground が waiter を立てずに見る」API は無かったので probe は最小の新 API。

## 飛ばした tick の扱い
- build：`Retry`＝`RETRY_DELAY`（250 ms）後に再試行。`Retry` は reader の連続 retry streak（K=40）を 0 に戻す種類で、Stopped にはならない（`next_reader_retry_streak` は ReaderRetry だけ数える）。
- reconcile：`None` は `active += 1; continue`。ticket は消さず、invalidate も build の schedule もしない。次の tick（250 ms 後）で再評価。

## stale と誤判定しない根拠（コードの読み）
- 飛ばすのは「期限切れ・workspace 変更・snapshot 不適格・query の無効」の判定（DB を使わない前半）の**後**、DB read の直前だけ。前半は従来どおり毎 tick 評価され、偽なら従来どおり invalidate される。
- `None` は `Ok(Some(false))` と別値で、reconcile の `Ok(Some(false)) | Err(_)` 以外は invalidate に到達しない。
- build の skip は `current_request` が真のときだけ。偽なら `build_once` に入り従来どおり Stopped になる。

## ユーザー操作の経路は不変（根拠）
`current_operation` の呼び出し元（`continue_query`、`qualify_evidence`、他）は `skip_if_busy=false` の wrapper を使い、挙動は従来と同一（queue して foreground 優先）。`begin`・`qualify_evidence`・`graph_*`・drift 検査・READY 条件・維持側の backoff は未変更。build の polling は元々ユーザー操作ではなく周期 task（`begin` が `schedule` を呼ぶ時の最初の 1 tick も周期 task 内の同じ closure を通る＝最初の tick も busy なら 250 ms 遅れる）。

## 副作用の懸念（推測）
- Related Scenes の index 構築・失効検出は、維持が接続を持つ間は遅れる。上限は「probe が空きを見つけるまで」＝理論上は無制限（維持が mutex を持ち続け probe が常に busy なら飢餓）。実際は維持は slice ごとに手放す（commit 約 100 ms ごと）ので、tick が空きに当たる確率次第。飢餓の有無は A/B の `periodicSkips` で見る。
- 失効の検出が遅れる間に古い結果が返る可能性：返却時の `continue_query` の current_operation は従来どおり（skip しない）ので、結果の gate は不変。
- probe は racy：probe が空→直後に維持が取得→build が waiter を立てる、は残る（preempt が 0 にはならず減る見込み）。
- build_once 内部の複数の取得（admission 後の read・publish）は probe の対象外。a2 は admission で Idle になる想定だが、未確認。
- build が最初の `begin` 直後の tick で busy だと Chronicle の準備が最大 250 ms 以上遅れる（DR-IRB-7 の 400 ms の見積りとは別。維持が走っていない通常時は probe が空なので影響なし、の推測）。

## 検証
- `heavy.sh cargo check --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib`：終了 0。
- `cd electron/native/grimodex-node && heavy.sh cargo check --lib --features nir1-graph-eval`：終了 0。
- `node scripts/quality/nir1-graph-eval/native-architecture.mjs`：終了 0（ok）。
- `heavy.sh cargo test --lib --features nir1-graph-eval related_scenes`：終了 0、99 passed／0 failed（filter `related_scenes`、約 46 s＋build）。

## 確かめられなかったこと
- 実際の A/B（V-10 率、Verify 完了、preempt 数、飢餓）。standard／eval build は未実行。
- 新 API・skip 経路の専用 unit test は書いていない（既存 test は skip 経路を通らない：build test は schedule_with の scripted step、reconcile の busy 経路は未検査）。
- `begin` が最初の build を即時 spawn するか周期 task かの詳細、通常運用での polling 頻度は未確認。
