# journey flake（`nir1-scene-scope-projection-acceptance`）の判断記録

対象は PR CI の `Electron product journeys (shard 6/7)` で、最初の journey
`nir1-scene-scope-projection-acceptance`（`electron/scripts/nir1-scene-scope-projection-product-journey.mjs`）が
落ち、同じ shard の残り 6 本が fail-fast でスキップされる flake。調査は 2026-10-28。
証跡は読むだけで、製品 code は変えていない。

## DR-JF-1 `WORKSPACE_SWITCHING` の失敗は製品の欠陥（[precheck] で停止）

- 観測（#747 の run 40519368093、artifact の `operations.jsonl`・`main-diagnostics.json`・DB 断面）:
  - 失敗は `reopen-anchor-move` の matrix の `story-time-order-roundtrip-stays-invalid` の途中。
    `temporal_scene_patch`（storyOn）の後、2 回目の `temporal_scene_patch`（storyOff、
    14:36:10.968〜10.996Z）と、背景の Incremental Freshness の cycle（run `c8f3e018…`、attempt の
    started 10.981Z）が重なった。
  - DB 断面の `narrative_extraction_attempts` に、その attempt の
    `NEX_INCREMENTAL_FRESHNESS_TYPED_SOURCE_CHANGED: 'project:scene-scope-projection:x14-q1-…' changed after evaluation`
    （`failure_code = NEX_INCREMENTAL_FRESHNESS_RETRYABLE`、`retry_disposition = retryable`）が残る。
    評価は storyOff の前の Scope token を読み、publish の transaction で storyOff の後の token と食い違った。
  - 直後（11.005Z）の Main の stderr に
    `[workspace-lifecycle-diag] {"producer":"freshness","cause":"E","boundary":"handoff","state":"recovery-required","owner":"Maintenance",…}`。
  - journey の次の `db_execute`（11.000〜11.020Z）が `WORKSPACE_SWITCHING` で拒否された。
    次の freshness tick が recovery を reconcile し、12.068Z に新しい run、12.112Z に cursor が 137 まで進んだ
    （拒否の窓はおよそ 1.1 秒）。
  - #749 の run 40503140508 の log も同じ位置（`anchor-archive-roundtrip-stays-invalid` の直後）で同じ
    `workspace-lifecycle-diag`（freshness／E／handoff／recovery-required）を出している。
- 仕組み:
  - `grimodex-db` の `run_serialized_cycle_with_control` は、publish の optimistic guard
    （`NEX_INCREMENTAL_FRESHNESS_SOURCE_CHANGED`／`…_TYPED_SOURCE_CHANGED`／`NEX_SEMANTIC_EPOCH_CHANGED`）
    の食い違いを `requeue_after_failure` で retryable として durable に記録し、そのうえで `Err` を返す。
  - Native の `run_narrative_freshness_cycle_supervised`（`electron/native/grimodex-node/src/lib.rs`）は
    worker の `Err` をすべて「予期しない失敗」として扱い、authority を retire し、permit を recovery へ移す
    （`transfer_to_recovery_diagnosed`）。lifecycle は `RecoveryRequired` になり、
    `resolve_workspace_snapshot` は通常の DB command をすべて `WORKSPACE_SWITCHING` で拒否する。
- 判断: 前景の Scope 系の書込み（temporal／tree／scope の patch）と背景の freshness の publish が数十 ms の窓で
  重なるだけで、接続の retire と workspace 全体の約 1 秒の拒否が起きる。利用者の連続した編集でも起こり得るので、
  journey の待ちの不足ではなく製品の欠陥と判断する。master の Full が通るのは窓に当たらない時間配分のため。
- この依頼の範囲では製品 code（`electron/native`、Rust）を変えないため、ここで [precheck] として止める。

### 選択肢

- A（推奨）: 製品の修正。publish の optimistic guard の食い違いを、crate が retryable として requeue 済みの
  型付きの結果（例えば `IncrementalFreshnessCycleOutcome` の新しい variant、または型付きの error）で返し、
  Native はそれを recovery へ移さず permit を通常どおり release する。文字列の照合で分類しない。
  NIR-1 の lifecycle／owner の判断の委任の範囲内だが、Rust の build と Native の試験が要る。
- B: harness だけの対処。`db_execute` などの helper で `WORKSPACE_SWITCHING` を上限つきで再試行する。
  拒否の窓では全 DB command が落ちるので、`invokeOk` の書込みにも再試行が要り、他の journey の
  switching の検査を覆う恐れがある。欠陥を隠すので単独では勧めない。
- C: journey 側で前景の書込みを freshness の settle の後に限る（storyOff の前に `settleFeed`）。
  CI は安定しやすいが、利用者の欠陥は残り、matrix の他の連続書込みでも同じ窓は開く。A までの暫定に限る。

## DR-JF-2 #748 の `the rejection writes nothing` は別の仕組み（harness の待ちの不足）

- 観測（#748 の run 40501474529 の attempt 1、job 122184506775 の log）: 差分は `runsAll: 90 → 91` だけで、
  `runs`（`default-project`）と `runsForeign` は変わらない。増えた 1 行は 2 つ目の project
  （`createSecondProject` と `treeCreate(second, …)` で作った project）の `narrative_extraction_runs`。
- 仕組み: `runSnapshotChecks` は 2 つ目の project を作った直後に `countRejectionTables` を取る。その project の
  Change Feed を背景の freshness が処理して `freshness-evaluation` の run を作るのが、before と after の間に入った。
  拒否された prepare の書込みではない。workspace の switching とは無関係で、同じ背景 consumer との競合の別の現れ。
- 判断（提案。未実装）: 検査の意味（全 project・全表の件数が変わらない）は保ち、before を取る前に背景の
  consumer を静止させる。2 つの project の `settleFeed`（cursor が head に追いつく）に加え、2 つ目の project の
  現行 epoch の `freshness-evaluation` run がある（idle checkpoint が後から作られない）ことを待つ。
  件数の対象から背景の run を除く案は検査を弱めるので採らない。実 Electron での確認が要るため、
  DR-JF-1 の選択と一緒に進める。
