# B-ROUTE decisions（GDX-PRECHECK-001：B whole-project build の maintenance 配線。製品の起動は PUB-G まで閉）

- base：worktree `claude-nir1-broute`、branch `claude/nir1-broute`、HEAD `a153743b`（origin/master と同じ）。この文書を書いた時点でコードは変更していない。行番号はすべて HEAD `a153743b` のもの。
- 委任：U3（worker／owner／終了処理／lifecycle の技術判断）。計画 `610-pr-c-query-nir-valiant-thunder.md` Wave 2 の B-ROUTE 行（:251）。TASK は `scratchpad/ralph/tasks/B-ROUTE.md`。発見の経緯は SPIKE S1 §5。
- 契約：
  - l6-l9 proposal/5 `graph-limited-binding`：Delta（L69:147）、finalization（:154）、no-wait（:156）、cleanup（:158）、full-set validation（:159）、B build owner/lifecycle 表（:162-171）、lifecycle case 表（:185-191）、semantic gate 表（:194-211）。
  - B-close の数値（BC:19-39）、typed failure（BC:41-50）、COMMIT の予約（BC:52-62）。
  - proposal/6 の2行（`graph-limited-binding`、`nir1-defensive-resource-limits`）は確認済み。integrator の記録 `scratchpad/confirmations/K1.md`（draft SHA-256 `5528f4e0…`）に依拠する。B の whole-set は B-close の数値のまま（P6:72、:110）。
- 起草：Builder。requested／effective model は `claude-opus-5-5`、effort は unavailable。advisor の結論は Advise 段階で §10 に追記する。

略記（すべて `src-tauri/crates/grimodex-db/src/` からの相対。Native と main は別記）：

| 略記 | ファイル |
|---|---|
| MR | `narrative_extraction/maintenance_runtime.rs` |
| RR | `narrative_extraction/maintenance_route_registry.rs` |
| ML | `narrative_extraction/maintenance_lifecycle.rs` |
| SE | `narrative_extraction/maintenance_skip_evidence.rs` |
| MC | `narrative_extraction/maintenance_contracts.rs` |
| IDX | `narrative_extraction/nir1_entity_relation_index.rs` |
| CAP | `narrative_extraction/nir1_capacity.rs` |
| RB | `narrative_extraction/restore_rebuild.rs` |
| VC | `narrative_extraction/verify_coverage.rs` |
| RT／INV | `narrative_extraction/nir1_chronicle_index/runtime.rs`／`…/invalidate.rs` |
| TL | `narrative_extraction/task_leases.rs` |
| CONN | `narrative_maintenance_connection.rs` |
| DBLIB／STATE／MIG | `lib.rs`／`state.rs`／`migrate.rs` |
| N-lib／N-state | `electron/native/grimodex-node/src/lib.rs`／`…/state.rs` |
| M-nm／M-ci | `electron/main/narrativeMaintenance.ts`／`electron/main/narrativeMaintenanceCiSeam.ts` |
| POL-RK／VAL-RK／T-RR | `policies/narrative/narrative-run-kind-policy.json`／`scripts/quality/validate-run-kind-policy.mjs`／`src-tauri/crates/grimodex-db/tests/narrative_maintenance_route_registry.rs` |
| POL-SC／POL-CC | `policies/narrative/semantic-core-authorities.json`／`policies/narrative/narrative-consumer-contract.json` |
| L69／BC／P6 | `docs/plans/nir1-l6-l9-execution-plan.md`／`docs/plans/nir1-b-close-completion-2026-09-22.md`／proposal/6 draft（`ba7ceb46`） |

## 0. 結論と停止条件の判定

結論：
- **配置**：(b) の変形を採る。新しい route（**gated、PUB-G までは production route の集合に入れない**）と、**Run を作らない（ledgerless）** 新しい work kind `nir1-graph-index-build` を置く。既存 route（a）には載せない。比較は §2。
- **起動 gate**：既存の journey seam（`NarrativeMaintenanceCiConfig.trigger`）に `nir1-graph-index-build` を1つ足す。開けられるのは、Rust の試験と、検証済みの seam（未 package、`CI=true`、owner token）だけ。製品の既定では閉じている。詳細は §3.2。
- **schema**：不要。Run を作らないので、`narrative_extraction_runs.run_kind` の CHECK（MIG:6611-6615）に新しい値は入らない。Run 付きの代替 (b-R) を選ぶ場合だけ migration が要る（§5）。
- **HOLD**：当たらない（下表）。

| 条件 | 判定 | 根拠 |
|---|---|---|
| schema の変更が要る | 当たらない（推奨案） | Run を作らない。新しい table と列もない。B の publish が書くのは既存の Graph surface（D1、V1、metadata、Freshness）だけ（IDX:2410-2526）。(b-R) を選ぶ場合だけ要る（§5） |
| B の product activation が要る | 当たらない | gate は製品の既定で閉。production route の集合（RR:44-72、POL-RK、parity 試験 T-RR:178-190）は3本のまま。route を production registry に登録し、policy に行を足すのは PUB-G の activation（integrator） |
| 閾値を緩める | 当たらない | B-close の数値（CAP:5-12）、per-Revision の上限（IDX:57-58）、query の固定値には触れない。既存の enforcement をそのまま通る（§1.1） |
| 委任外の6項目 | 当たらない | 新しい送信先：なし（DB 内の処理だけ）。保存範囲の拡大：なし（製品は何も書かない。試験と journey で書くのは proposal/5 が定める Graph surface だけ）。閾値の緩和：なし。製品公開：なし（`nir1_graph_query` は N-lib:11673-11676 のまま閉）。認可の削除：なし。新しい authority・契約：なし（trusted actor「Native／DB builder」（L69:148）が既存の登録済み producer（MC:66-72）を呼ぶ。POL-SC:178 は Graph の declared binding を `rebuildable-not-query-usable` としている） |
| 禁止ファイル | 触れない | policies、docs/plans、evals、lock、package.json、capacity fixtures、schema／migration、main の TS。route を production registry に入れないので、T-RR の parity を変えずに済む |

## 1. 現状の根拠（コードの事実）

### 1.1 B の build と publish

- `prepare_graph_index_build`（IDX:2169-2178）は ForegroundValidationControl の adapter である。maintenance が使う `_with_control`（IDX:2180-2189）は、既に production で `pub(crate)`。
  - 本体（IDX:2191-2235）は read transaction を要求する（:2199-2202）。current Semantic Epoch（:2203-2205）と runtime の admission（:2206-2207）を取ってから roster を作る（:2209-2216）。
  - prior binding が Reserved なら `NIR1_GRAPH_BINDING_RESERVED`（:2220）を返す。
  - roster は keyset page（64件、:802-829）で全候補を列挙する。各 page・row・A2 で runtime epoch を確かめる（`GraphReadAdmission`、:231-249、:668-691）。
- 公開 writer の `publish_nir1_entity_relation_index_in_tx`（IDX:2335-2344）は、ForegroundValidationControl と busy 0（`with_graph_no_wait`、:732-750）で動く。maintenance の control を受ける `_with_control`（:2346-2354）は `cfg(any(test, feature = "nir1-material-diagnostics"))` なので、製品からは呼べない。
- publish 本体（IDX:2372-2529）は caller の1つの write transaction の中で動く。順序は次のとおり。失敗すれば caller の rollback で何も残らない。
  1. seal を検査する（:2388-2389）。
  2. snapshot が current か確かめる（:2390-2393。違えば `NIR1_GRAPH_SNAPSHOT_STALE`）。
  3. D1（:2410）、V1 の置換（:2427-2440）、metadata（dirty=1、:2442-2461）を書く。
  4. roster・Source・runtime epoch を再読取する（:2466-2483。`…CHANGED_DURING_PUBLISH`）。
  5. edge を評価する（:2484-2499。`…SOURCE_CHANGED_DURING_PUBLISH`）。
  6. Freshness を書く（:2502-2511）。
  7. dirty=0 にする（:2512-2517）。
  8. 最終読取（:2518-2527）。
- 呼出し元は試験と診断 feature だけである（S1 §5）。例：CAP:1084-1135、`nir1_graph/tests.rs:150-156`、`nir1_capacity_diagnostics.rs`。製品の maintenance（MR、RB）からは呼ばれない。
- 容量の enforcement は、既に prepare と publish の中にある。B-ROUTE はこれを変えない。

  | 項目 | 場所 |
  |---|---|
  | 候補 | IDX:852-857 |
  | Revision と material | IDX:957-968 |
  | roster | IDX:969、:1502-1551 |
  | Source bytes | IDX:1150-1157、:1378-1445、:1491-1500 |
  | 保存 edge と D1 | IDX:1629-1681 |
  | SQL と期限 | CAP:24-95、:510-605 |
  | COMMIT の予約 | CAP:389-437 |

  超過は `validation_terminated(CapacityExceeded, "NIR1_GRAPH_CAPACITY_EXCEEDED: …")`（IDX:1477-1489）になる。
- 予算は attempt ごとに1つである。
  - `nir1_capacity::with_attempt`（CAP:647-651）が thread-local の予算を張る。
  - prepare は `with_capacity_scope(conn, None, …)` でその予算を引き継ぎ、snapshot に `capacity` として持たせる（IDX:2186-2188、:2231）。
  - publish は同じ予算を使う（IDX:2378-2379）。試験 CAP:1084-1135 がこれを保証している。

### 1.2 maintenance の仕組み

- 入口は Native の `run_narrative_maintenance_cycle`（N-lib:7340）。
  - lifecycle permit を spawn_blocking の前に予約する。
  - `should_stop`（N-lib:7956-7978）は、permit の stop と attempt の cancel を見る。
  - `MaintenanceCycleControl`（N-lib:8145-8163）を組み、`run_system_work_cycle_…_with_control(authority.db(), …)`（N-lib:8166-8177）を呼ぶ。ここの `authority` は `Arc<WorkspaceAuthority>`（STATE:167）。
- cycle（MR:2863-3487）の流れ：
  - wire の work を検証し、wake 用に discovery する（MR:2873-2893）。
  - work を登録してから queue に入れる（:2898-2918、:2986-2995）。
  - dequeue の上限は MR:3003。recovery（:3121）→ StartFresh／Retry（:3184）→ dispatch（:3362-3386）。
  - foreground の no-wait 負けは deferred（:3371-3383）。
  - 次の phase を discovery し（:3400-3424）、`mark_completed`（:3425）。
  - 最後に has_more を rediscovery する（:3454-3474）。同じ cycle で halted になった key は has_more にしない（:3467-3470）。
- 状態機械の判定は `discover_durable_maintenance_work_in_tx_with_control`（MR:2298-2551）。
  - Verify が clean で、Rebuild も不要なら `Ok(None)`（:2489）。
  - incomplete だけなら `Ok(None)`（:2491-2498）。
  - cycle の中からは `discover_cycle_work`（MR:2232-2262）経由で呼ばれる。
  - main 向けの `discover_all`（`electron/native/grimodex-node/src/narrative_maintenance.rs:81-147`）は uncontrolled な `discover_durable_maintenance_work_with_coordinates`（MR:2166-2185）を使う。
- dispatch は閉じた registry を通る：`validate_dispatch_contract`（MR:3625-3651）→ `dispatch_enabled_work`（MR:3653-3667）→ RR:103-119。
- phase の owner は `run_maintenance_graph_phase`（RB:3842-3889）。
  - phase の前に finalization grant を消す（:3851）。
  - no-wait で接続を取る（`try_lock_narrative_maintenance`、CONN:622-641）。
  - busy timeout は `Duration::ZERO`、progress hook は 1,000 steps ごと（RB:3838、:3862-3866）。
  - control は `MaintenanceCycleGraphControl`（MR:1422-1488。cycle の `should_stop` を先に見る）と `NarrativeMaintenanceGraphControl`（CONN:425-529。latch、closed、stop、generation、deadline、foreground waiter）を重ねたもの。
  - 予算は `with_current_attempt`（CAP:660-672）で引き継ぐ。
- outer scope（CONN:837-1069）の後始末：hook を外す（:978）→ rollback して autocommit を確かめる（:994-1013）→ busy timeout を戻す → receipt を作る（`connection_reusable`、:1048-1052）。不合格なら `db.quarantine_connection`（:715-724）。interrupt は latch で typed な終了に変える（`map_interrupted_error`、:1077-1088）。
- 最終 transaction の型（Rebuild の RB:1394-1440、Verify の RB:4633-4670）：
  1. `FinalizationGrantScope`（MR:1493-1511）
  2. `graph.check(ResultAssembly)`
  3. `db.try_reserve_maintenance_finalization()`（DBLIB:546-575。foreground waiter がいれば None）
  4. `(control.grant_finalize)(work_key)`（Native の `grant_work_finalize`、N-state:1737-1775。cancel が先なら false）
  5. durable な書込み → `with_immediate_transaction` の COMMIT（TL:503-551 → CAP:389-437）
- Native の完了には2種類ある。
  - `mark_work_succeeded`（N-state:1861-1883）は grant を要求する。
  - `mark_work_completed`（N-state:1890-）は「durable な terminal transaction を持たない実行」用で、grant を持たない。

### 1.3 既存 route の契約（policy、validator、試験）

- Backfill：`automatic-once-after-schema-upgrade`、`reuse-running-and-completed`（POL-RK:10-12）。完了済みは再実行しない。
- Verify：`writes: diagnostics-only`（POL-RK:90）、`forbidSideEffectRepair: true`（:119）。
- Rebuild-Derived：
  - 目的は「Never touches Domain state or Durable Dependency declarations」（POL-RK:134）、`writes: rebuildable-state-only`（:158）。
  - code の doc も「`narrative_dependency_edges` は読むだけ」（RB:1082-1090）。
  - validator は「semantic-index が reserved の間、rebuildableTargets に `semantic-index-generation-cache` を入れてはならない」（VAL-RK:70-71、:701-707）。
  - Rebuild は reserved な semantic-index consumer を飛ばす（RB:1260-1263）。
- semantic-index は `reserved`（POL-CC:65-66、POL-SC:94「rebuildTarget: forbidden」）。`reserved-to-declared-activation` は未承認の決定（POL-SC:119）。
  - 一方、declared binding（Graph）は `recognizedUnavailable: rebuildable-not-query-usable`（POL-SC:178）。
  - 再構築するのは producer であって、Rebuild-Derived ではない。
- 閉じた registry と policy の parity：T-RR:52-191 は、policy の runtimeRoute の集合と `route_descriptors()` が完全一致し、どちらも3本であることを要求する（:178、:184、:190）。RR 内の試験（RR:264-295）も3本を固定している。

### 1.4 Graph の失効と、Verify／Rebuild での扱い

- writer は同じ transaction の中で Graph（と Chronicle）を dirty にする（`suspend_project_in_tx`、INV:12-34）。
  - 呼出し元：change feed への追記（`change_feed.rs:2841`）、Epoch の作成（`semantic_epoch.rs:45`）、決定（`repository.rs:5031`、:5537、:5687）、A2（`nir1_entity_relation.rs:1504`）、proposal-revision の Freshness と edge の変化（INV:85-114、`publish_runtime.rs:214`、:326）。
  - 例外：restore の Epoch（`create_restore_epoch_in_tx`、RB:162-195）は dirty にしない。ただし Freshness の epoch が current でなくなるので、`is_complete_registered` は false になる（IDX:2014-2052。epoch の比較は :2042）。
- B の publish 自身は Graph を dirty にしない。invalidation hook は proposal-revision の consumer にしか反応しない（INV:36-54、:56-83、:85-114）。
- Verify の semantic-index 検査（VC:438-559）は、`is_complete_registered_with_control` が真なら Graph の footprint を差し引く（:509-531）。偽なら incomplete になり（:543-556）、discovery は `Ok(None)`（MR:2491-2498）で待つ。Inbox にはしない。
- `graph_state_digest` は、全 edge と semantic index metadata（dirty を含む）を入れる（RB:2516、edge は :2544、metadata は :3042-3062）。そのため B の publish の後は、Verify の skip 証跡が一致せず、Verify が再実行される。

### 1.5 runtime の所在

- `NirChronicleIndexRuntime` は `WorkspaceAuthority` にあり（STATE:26-32、:46-62、:123-127）、製品での生成元は authority だけ（RT:105-123 の注記）。
  - B の admission は `admit_native_build`（RT:152-157）、publish 時の再検証は `native_build_is_current`（RT:162-169）、callback 用は `native_build_cancellation_epoch`（RT:176-178）。
  - 製品で runtime epoch が回るのは、embedding generation の bind（RT:194-212、`related_scenes.rs:104`）。
- maintenance の cycle は `&Database` しか受け取らない（MR:2863-2870）。そのため、B を動かすには runtime を cycle に渡す必要がある。

### 1.6 schema

- `narrative_extraction_runs.run_kind` には CHECK がある（v24：MIG:6518-6680、CHECK は :6611-6615）。値は `interpretation`、`freshness-evaluation`、`semantic-index-rebuild`、`manual-rebuild`、`backfill`、`dependency-verify`、`dependency-repair`。新しい Run Kind 値には table を作り直す migration が要る。
- lifecycle は Run Kind ごとに、task kind、work key、canonical spec を固定している（ML:436-471）。未知の kind は `NEX_MAINTENANCE_RUN_KIND_INVALID` で拒否する。
- `narrative_extraction_tasks.task_kind` に CHECK はない（MIG:2713）。

### 1.7 main と Native の閉じた集合

- main の TS は Run Kind を3つに閉じている（M-nm:23-26、:532-536）。terminal receipt の canonical key を構造的に解析し（M-nm:674-705）、未知の kind なら全 batch を retry に回す（M-nm:730-787）。
- journey seam の trigger は TS 側で列挙している（M-ci:68-74）。Rust 側は MR:293-305。`validate()`（MR:334-360）は、未 package、`ci == "true"`、owner token を要求する。
  - Native の `configure_narrative_maintenance_ci_seam`（N-lib:7033-7045、`#[napi]`）は main 専用で、renderer の IPC router には無い。one-shot で、再検証もする（N-state:447-460）。
- Native の manual maintenance は、`AutomaticRunKind` を網羅する `match` を持つ（N-lib:3207-3213、:3261-3277）。

## 2. 配置の比較

| 観点 | (a-1) Backfill の中 | (a-2) Verify の中 | (a-3) Rebuild-Derived の中 | (b-R) 新 route＋Run 付き Run Kind | **(b-L) 新 route（gated）＋ledgerless の work kind（推奨）** |
|---|---|---|---|---|---|
| route の契約 | 一度きりで完了を再利用（POL-RK:10-12）。B の再構築と合わない | diagnostics-only、副作用の修復は禁止（POL-RK:90、:119）。違反 | 「Durable Dependency declarations に触れない」（POL-RK:134、RB:1082-1090）に違反（B は D1 と V1 を書く）。validator は reserved の間 semantic-index の cache を target にすることを禁止（VAL-RK:701-707）。変えるには `reserved-to-declared-activation`（POL-SC:119、未承認）が要る。activation 相当 | 既存3本の契約は変えない。policy の新しい行が要る（integrator） | 既存3本の契約は変えない。production route 集合（policy と T-RR）も PUB-G まで変えない |
| finalization（L69:154） | ― | ― | Graph の publish は Rebuild の途中の commit になり、work の grant（最終 transaction）と合わない。合わせると、Verify snapshot、Graph publish、Run 完了が1つの巨大な write transaction になる | publish と Run 完了を同じ transaction にし、grant を COMMIT 直前に取る | publish の transaction が work の最終 transaction になる。grant を COMMIT 直前に取る（§4.3） |
| 起動の契機 | ― | ― | Rebuild は epoch 回転や派生状態の不整合でしか起きない。Graph の dirty で全 consumer の Rebuild を起こすことになる | 自分の判定で起動する | 自分の判定で起動する（§3.3） |
| 失敗の隔離 | ― | ― | Graph の容量超過が Rebuild を失敗（manual、Inbox）させ、中核の maintenance を止める。止めないなら再発のループになる | 失敗は B の Run だけ。ただし容量超過は manual になり、WorkKey が epoch 単位なので、データを減らしても epoch が回るまで止まる | 失敗は B の work だけ。typed refusal で旧 sealed を残す。process-local な記録で、入力が変わるまで再試行しない（§3.5） |
| schema | 不要 | 不要 | 不要 | **要る**（CHECK の拡張。§5）。確認済み契約の「新しい schema を加えない」（L69:147、:159、P6:12）と衝突しうる | 不要 |
| 永続する再開状態（L69:185-191） | ― | ― | ― | Run の ledger が残る（build の再開状態ではない） | なし。publish は atomic で、成功時の generation だけが残る |
| main と Native への影響 | ― | ― | ― | main の TS（Run Kind の union、receipt）、lifecycle の task／spec／work key、discovery の arm、failure policy、Native の match、migration、policy、validator | Native の呼出し1か所と match の arm 1つ。main の TS は CP-4 で journey を開くときに要る |
| 先例 | ― | ― | ― | 自動 maintenance はすべて Run 付き | semantic-index の producer（Chronicle）は Run を作らない（Related Scenes の Native owner。`publish_complete_runless_freshness_in_tx` を使う）。Graph の publish も runless な Freshness を使う（IDX:2503） |

判断：**(b-L)** を採る。理由は次のとおり。

1. (a) はどれも、policy で検証済みの route の契約を変える。(a-3) では、それが未承認の `reserved-to-declared-activation` に当たる。停止条件の「product activation」に近い。
2. (b-R) は schema を要し、確認済みの `graph-limited-binding` の「新しい schema を加えない」と衝突しうる。schema が要る場合は停止条件にも当たる。
3. (b-L) は proposal/5 の lifecycle（永続する再開状態なし、atomic publish、publish の commit で FinalizeGranted）に最も素直に合う。既存の primitive（cycle、phase、no-wait、hook、capacity、grant、quarantine）だけで組めて、新しい framework を作らない。
4. 「製品での自動実行は PUB-G まで閉じる。試験と journey 用の起動経路だけを置く」（計画 :251）。PUB-G より前の B は production route ではない。production registry への登録、policy の行、main の TS、Inbox などの UX は、activation（PUB-G）で integrator が決める。

代償（受け入れるもの）：
- durable な失敗台帳が無い。Inbox にもならない（Graph は unavailable のまま、R+IR に戻る）。
- 再試行の抑止は process-local（§3.5）。
- gated な route が、production registry の外に1つ増える。RR に別表として置き、`route_descriptors()` には出さない。

## 3. 設計（推奨案 b-L）

### 3.1 変更点（許可ファイルごと）

| ファイル | 変更 |
|---|---|
| 新規 `narrative_extraction/nir1_graph_index_maintenance.rs`（＋試験） | gate 型、Graph の hint の読取、判定、owned route の adapter（V／P／U）、process-local の記録（§3.5） |
| `narrative_extraction/mod.rs` | `mod nir1_graph_index_maintenance;` の1行だけ（新しい module の登録） |
| MR | (1) `AutomaticRunKind::Nir1GraphIndexBuild`（serde `"nir1-graph-index-build"`）。`all()` には入れない（永続する3種のまま、MR:113-115）。`as_str()` の doc に「永続しない」と書く。(2) `NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild`（`"nir1-graph-index-build"`）。`effective_maintenance_coordinates`（MR:401-426）の arm を足すが、どの coordinate も変えない。(3) `normalized_work`（MR:1365-1418）で、wire から来たこの kind を `NEX_MAINTENANCE_INVALID_REQUEST`（Rust-internal）で拒否する。(4) `validate_dispatch_contract`（MR:3625-3651）の arm：work key は `nir1-graph-index-build`、epoch は必須。(5) `decide_execution`（MR:3946-3958）は `Deferred{reason:"nir1-graph-index-build-cycle-internal"}`。(6) `MaintenanceDispatchOutcome`（MR:89-92）に `CompletedWithoutFinalization` を足す。cycle では `mark_noop_completed`、`handled_non_coalesced=true`、`terminal_halted_work` への追加を行い、即時の rediscovery はしない。(7) `discover_cycle_work`（MR:2232-2262）に Graph の context を渡し、durable な連鎖が None を返したときだけ B を判定する（§3.3）。(8) 新しい入口 `run_system_work_cycle_with_nir1_graph_runtime(…, control, runtime: Option<&NirChronicleIndexRuntime>)`。既存の `…_with_control`（MR:2863）は runtime=None で委譲する（挙動は今と同じ） |
| RR | production の `ROUTE_REGISTRY`（RR:59-72）とは別に、`GATED_PREACTIVATION_ROUTE`（1件）を置く。`route_descriptors()`（RR:75-77）と `route_descriptor_*` には出さない。`dispatch_enabled_work`（RR:103-119）に Graph の context を足す。この kind は gate を再検査してから gated adapter に渡し、それ以外は従来の表を使う。`route_id()`（MR:106-109）は、production 表に無ければ gated 表を見る（試験だけが使う）。試験：production の3本は不変、gated route は descriptor に出ない、gate が閉じていれば SQL の前に拒否 |
| SE | skip 証跡の型を、既存の `CompletedRunSkipDecision`／`Reason`（SE:113-142）と同じ形（serde は kebab-case、fail-closed）で足す。`Nir1GraphIndexBuildDecision::{Build{mode, reason}, Skip{reason}}`。reason は §3.3 の表 |
| IDX | `publish_nir1_entity_relation_index_in_tx_with_control`（:2346-2354）の `cfg` を外し、production の `pub(crate)` にする。producer の追跡検査は、関数名が公開 writer と同じ場合だけ委譲を数える（MC:430-452）ので、影響しない。prepare と publish の中身は変えない |
| CAP | `#[cfg(test)] pub(crate)` の補助だけ（予算を予め消費した attempt の下で op を走らせる。既存の `AttemptScope` は private、CAP:640-645）。数値は変えない |
| RB | production の変更なし。restore の試験を足す（または新 module 側に置く） |
| ML、MC | 変更なし（B は Run を作らない） |
| N-lib | 製品の呼出し（N-lib:8166-8177）を新しい入口に変え、`Some(authority.nir_chronicle_index_runtime())` を渡す。manual の `match`（N-lib:3261-3277）に、この kind を拒否する arm を足す（:3207-3213 の ensure で既に到達しない） |

### 3.2 起動 gate

- 型：`Nir1GraphIndexBuildGate { open: bool }`。field は private。生成の経路は次の3つだけ。
  - `closed()`：既定。
  - `from_journey_seam(ci: Option<&NarrativeMaintenanceCiConfig>)`：`ci` が `validate()`（MR:334-360）に通り、かつ `trigger == Some(Nir1GraphIndexBuild)` の場合だけ open。
  - `#[cfg(test)] open_for_test()`：新 module の単体試験用。
- gate を見る場所（多重の防御）：
  1. 判定（§3.3）で最初に見る。閉じていれば DB を一切読まずに `Skip{GateClosed}` を返す。製品の既定では、SQL、lock、時間のいずれも変わらない。
  2. dispatch（RR の gated 分岐）で再検査する。閉じていれば SQL の前に `CompletedWithoutFinalization`（Refused：GateClosed）を返す。
  3. wire（main から来る work）はこの kind を常に拒否する（§3.1(3)）。main は B を起動できない。
- 開けられないもの：
  - renderer、preload、IPC：seam の N-API は main 専用で、IPC router に無い（N-lib:7030-7045）。
  - packaged の起動：`validate()` が拒否する。
  - DB の内容（設定 table、runtime policy、import や restore で入る行）：参照しない。untrusted（L69:149）なので gate の根拠にしない。
- 製品の既定：Native は `state.narrative_maintenance_ci_seam.config()` を渡す。通常の起動では None なので閉じている。
- 試験：cycle の試験は、検証済みの seam（未 package、`ci="true"`、owner token、trigger）を組んで開ける。MR:6564 の `ci_config()` と同じ形。新 module の単体試験は `open_for_test()` を使う。
- journey（CP-4）：Rust と Native の側は、この PR で揃う。main の TS で trigger の定数（M-ci:68-74）と env の対応を足すのは CP-4（許可ファイル外）。
- trigger は1起動に1つ。そのため Graph の journey は、他の trigger（foreground-workspace-wake など）と同時には使えない。

### 3.3 desired-work の判定（Graph の hint）と skip の証跡

場所：`discover_cycle_work`（cycle の内部だけ）。durable な連鎖（Backfill→Verify→Rebuild→Verify）が None を返した後に判定する。main 向けの `discover_all` は変えない。B を main に返すことはない。

順序（どれかで決まったら終わり）：

| # | 条件 | 結果 |
|---|---|---|
| 1 | context（runtime）が無い、または control が無い（uncontrolled な cycle） | `Skip{RuntimeUnavailable}`／`Skip{NoCycleOwner}`（SQL なし） |
| 2 | gate が閉 | `Skip{GateClosed}`（SQL なし） |
| 3 | reason が `before-cutover`／`before-cutover-follow-up` | `Skip{BeforeCutoverFlow}`（C2-ZC の流れに触れない。SQL なし） |
| 4 | 以下は no-wait の判定 phase（`run_maintenance_graph_phase` と read transaction）。scan staging（MR:2264） | `Skip{ScanStaging}` |
| 5 | current Epoch が無い | `Skip{NoEpoch}` |
| 6 | `runtime.admit_native_build(conn)` が None | `Skip{RuntimeUnavailable}` |
| 7 | hint を読む：metadata（INDEX_KEY の PK 行）、consumer Freshness（`semantic-index`／INDEX_KEY）、D1 head の version、feed head（`MAX(canonical_sequence)`。`idx_narrative_change_events_project_sequence`、MIG:3641）、候補の存在（IDX:802-822 と同じ述語、LIMIT 1） | ― |
| 8 | metadata が無いのに、Freshness、D1、edge の残骸がある。または producer／version が違う | `Skip{BindingIncoherent}`（POL-SC：manual-terminal。prepare も拒否する、IDX:2220） |
| 9 | metadata が無く、候補も無い | `Skip{NoCandidates}`（空の binding は作らない） |
| 10 | metadata が無く、候補がある | `Build{Rebuild, BindingMissing}` |
| 11 | dirty=1 | `Build{Rebuild, BindingDirty}` |
| 12 | Freshness が無い、または (fresh, none) でない、または Freshness の epoch が current でない（restore を含む）、または dependency digest が metadata と違う | `Build{Rebuild, NotCurrent}` |
| 13 | 構造上 current で、この process にこの (key, tuple) の Validated／Published の記録がある | `Skip{BindingCurrent}` |
| 14 | 構造上 current だが、記録が無い（cold reopen、新しい authority） | `Build{ValidateThenRebuild, ColdReopenValidation}` |
| 15 | 10〜12 の場合で、同じ (key, tuple) に Refused の記録がある | `Skip{RefusedUnchanged{code}}`（§3.5） |

- Build になったら、`DesiredWork{kind: Nir1GraphIndexBuild, work_key: "nir1-graph-index-build", epoch: current}` を作る。既存の `enqueue_discovered`（MR:2986-2995）で、登録してから queue に入れる。canonical key は `narrative-maintenance:v1/nir1-graph-index-build/{project}/nir1-graph-index-build/epoch/{epoch}`。
- recovery は `decide_run_recovery_for_epoch`（MR:4413-4494）を通る。この kind の Run は存在しえない（CHECK）ので、常に StartFresh になる。Native の recovery gate は文字列の key を扱うだけなので、変更は要らない。
- skip の証跡：SE の型で、判定ごとに `Nir1GraphIndexBuildDecision` を返す。
  - 試験は判定関数を直接呼んで検査する。運用では `tracing::debug!`（本文や ID の値は出さず、reason code だけ）。
  - durable には書かない。製品の既定（gate 閉）では DB を読まず、書きもしない。
  - durable に残すには、Run（schema）か、Verify／Rebuild の outcome 契約の変更が要る。§9 で確認する。
- 起動頻度についての注意：writer は Freshness の publisher が変わるだけでも Graph を dirty にする（INV:85-114）。そのため、gate が開いた環境では、maintenance の wake のたびに B が再構築されうる（generation が増える）。製品の頻度と wake 源は PUB-G で決める（§9）。

### 3.4 owned route（adapter）の phase 構成

前提：cycle の worker thread で、`MaintenanceCycleControl` の下で動く。Run は作らないので、`run_maintenance_graph_phase_for_run` ではなく `run_maintenance_graph_phase`（RB:3842）を使う。

| phase | transaction | 中身 | 予算 |
|---|---|---|---|
| G（gate） | なし | gate を再検査し、item（kind、work key、epoch）を検証する。閉なら Refused（SQL なし） | ― |
| V（`ValidateThenRebuild` のときだけ） | read（`unchecked_transaction` → 明示的に rollback） | hint の tuple を読み、`is_complete_registered_with_control(conn, project, INDEX_KEY, graph)`（IDX:1942-1954）を実行する。真なら Validated を記録し、`CompletedWithoutFinalization`。偽なら P へ進む | 独立した `with_attempt`。B-close の「別の attempt」（BC:317-323） |
| P（prepare） | read（同上） | hint の tuple を読み、`graph.check(Page)`、current epoch == item の epoch を確かめてから、`prepare_graph_index_build_with_control(conn, runtime, project, graph)` を呼ぶ。snapshot を返し、transaction は phase の中で閉じる（L69:156「mutex だけを放して transaction を開いたままにしない」） | P と U で1つの `with_attempt`。600,000,000／180 s を共有する（BC:19-39） |
| U（publish＋finalize） | `with_immediate_transaction`（TL:503-551） | `let mut reservation=None; let _scope=FinalizationGrantScope::new(control);` の内側で、`graph.check(Publish)` → `publish_…_with_control(conn, runtime, snapshot, graph)`（取り消せる。旧 sealed は未 commit） → 同じ transaction で publish 後の hint の tuple を読む（Published の記録用） → `graph.check(ResultAssembly)` → `reservation = try_reserve_maintenance_finalization()`（None なら PREEMPTED） → `grant_finalize(work_key)`（cancel が先なら `NEX_MAINTENANCE_ATTEMPT_CANCELLED`） → COMMIT（CAP:389-437 の予約。容量で拒否されたら rollback が確定する）。成功したら Published を記録し、`Completed`（→ `mark_work_succeeded`） | P と同じ |

結果の分類（adapter の出口）：

| 事象 | 扱い |
|---|---|
| typed stop（`is_controlled_maintenance_termination`、RB:4334-4339。cancel、closed、generation、foreground、cleanup、attempt stop） | `Err` をそのまま返す（記録しない）。foreground の負けは cycle が deferred にする（MR:3371-3383）。それ以外は cycle の Err で、Native の receipt は interrupted になる |
| grant の前の容量超過（`is_validation_capacity_exceeded`） | Refused（code）を記録する。旧 sealed は残る。`CompletedWithoutFinalization` |
| grant の前の Graph の契約／drift（`NIR1_GRAPH_SNAPSHOT_STALE`、`…CHANGED_DURING_PUBLISH`、`…SOURCE_CHANGED_DURING_PUBLISH`、`…BINDING_RESERVED`、`…ROSTER_*`、`…RUNTIME_UNAVAILABLE`、`…CURRENT_EPOCH_UNAVAILABLE`、`…PUBLISHED_BINDING_INCOHERENT`） | 同上（tuple を鍵にする。入力が変われば次の wake で再試行する） |
| 未知のエラー | `classify_failure`（MR:3992-4052）が retryable なら `Err`（既存の delivery の retry に乗る）。そうでなければ Refused（Unclassified） |
| grant の後のエラー（COMMIT の失敗） | `Err`（Verify／Rebuild の最終 transaction と同じ扱い。結果不明なら `NEX_DB_TRANSACTION_CLEANUP_UNPROVEN` から quarantine） |

### 3.5 refusal と process-local の記録

- 目的：入力が変わらない間、full-set の拒否（最悪 180 s／600,000,000）を wake のたびに繰り返さない。同じ cycle の中では、既存の `terminal_halted_work`（MR:2950、:3028、:3467-3470）で足りる。記録は cycle をまたぐ分だけを担う。
- 置き場所：新 module の process-local な map。
  - 鍵：(runtime owner、connection epoch（`temp.grimodex_connection_meta`、DBLIB:166-180）、project)。
  - 値：{runtime epoch、hint の tuple、outcome（Validated／Published／Refused(code)）}。
  - tuple の中身：current Epoch、metadata の (generation、dirty、built_at、source_digest、dependency_set_digest)、Freshness の (freshness、action、epoch、digest、updated_at)、D1 head の version、feed head、候補の有無。
- 上限：新しい数値は置かない。新しい owner を入れるときに、owner が小さい entry を捨てる（authority の identity は単調、STATE:44-62）。試験は owner=1 を共有するが、connection epoch で分かれるので、並列の試験が干渉しない。
- 消える条件：成功（Published）、tuple の変化、runtime epoch の変化、process の再起動。
- 限界：Freshness だけが変わり、feed head が進まない場合は解除されない。これは可用性の制限で、安全側に倒れる（Graph は unavailable のまま、R+IR）。PUB-G で wake 源と合わせて見直す（§9）。

### 3.6 restore と cold reopen

- restore：`ensure_restore_epochs_for_workspace`（RB:376-431）が新しい Epoch を作る。
  - Graph の Freshness の epoch が current でなくなり、`is_complete_registered` は false になる（IDX:2014-2052）。C-query の reader は登録で失敗する（`nir1_graph.rs:530` → `registration-required`）。Verify は incomplete で待つ（VC:543-556、MR:2491-2498）。
  - gate が閉じていれば、unavailable のまま（fail-closed）。gate が開いていれば、hint の 12（NotCurrent）で再構築し、新しい Epoch で publish する。
  - restore の Epoch が dirty を立てないこと（RB:162-195）は変えない（T-series の証跡がある箇所）。hint が epoch を比べるので、漏れはない。
- cold reopen（同じ file を新しい authority と接続で開く）：
  - binding は残っているが、process の記録は無い。hint が構造上 current なら、14 で V を一度だけ走らせる。これは proposal/5「restore／cold reopen verification を owned validation attempt で行う」（L69:179）に当たる。
  - V が真なら、publish せずに Validated。偽なら（外部編集などで、dirty なしに入力が変わった場合）、P と U で再構築する。どちらの場合も、reader は自分の登録時に full validation をする（`nir1_graph.rs:510-536`）。B の判定を待たずに unavailable になる。
- process の crash：publish は1つの transaction なので、WAL の rollback で、旧 sealed（または無し）か新しい generation の全体のどちらかしか残らない。B が持つ永続状態は無い。再起動後は、14 か 10〜12 から新しく始める。

### 3.7 A-1 と製品の既定

- 新しい `#[napi]` と IPC は無い。製品の Graph 入口 `nir1_graph_query`（N-lib:11673-11676）は閉じたまま。
- 製品の既定（seam 無し）では、判定は 2 で止まり、DB を読まない。dispatch は 0 回。Graph の surface への書込みも 0。
- production route の集合、policy、main の TS は不変。

## 4. 有限 owner/lifecycle matrix

### 4.1 phase ごとの owner

| phase | runtime owner | 持つ handle | 取消と hook | 後始末 |
|---|---|---|---|---|
| 判定 J | cycle の worker（Native の permit の下） | phase の接続 guard、read transaction、hint の小さな struct | outer の hook（1,000 steps、RB:3838）と Rust 境界（`MaintenanceCycleGraphControl`） | outer scope の receipt（CONN:978-1052）。失敗は quarantine |
| 検証 V | 同上 | 同上、加えて `is_complete_registered` の作業領域（scratch は既存の経路） | 同上。nested reader は hook を継承し、上書きしない（CAP:298-381、IDX:668-691 の注記） | 同上。attempt の予算は scope の終わりで外れる（CAP:576-605） |
| prepare P | 同上 | 接続 guard、read transaction、keyset の statement（page ごとに drop、IDX:894-895）、compact roster、snapshot（`Arc<CapacityBudget>` を含む） | 同上、加えて `GraphReadAdmission`（runtime の owner／epoch、page／row／A2 ごと） | 同上。snapshot は P と U の間だけメモリに置く（B-close の roster は 4 MiB まで） |
| publish U | 同上 | 接続 guard、IMMEDIATE transaction、finalization の予約（guard）、grant の mask（`FinalizationGrantScope`） | 同上。grant の後は stop の集合を mask する。SQL の上限は mask しない（CAP:47-63、BC:52-62） | `with_immediate_transaction` が rollback と autocommit を確かめる（TL:503-551）。COMMIT の hook を外したか確かめる（CAP:423-436）。outer の receipt |

### 4.2 lifecycle の項目

| 項目 | B-ROUTE での扱い | 根拠（既存の primitive） |
|---|---|---|
| entry | Native の `run_narrative_maintenance_cycle` だけ（main 専用 N-API、既存）。B は cycle の内部の判定でだけ生まれる。wire からは拒否（§3.1(3)） | N-lib:7340、MR:1365-1418 |
| start | `register_work`（queue に入れる前）→ dequeue → `work_started` → recovery（StartFresh）→ `check_stop` → dispatch → G → V／P → U | MR:2986-2995、:3001-3021、:3121、:3363 |
| retry | 同じ attempt の中では retry しない（page の途中も含む）。失敗や取消のたびに、snapshot、cursor、transaction を全部捨てる。次の wake で新しい attempt（新しい予算と handle）として、sealed generation から最初から作る。Refused は §3.5 の記録で、入力が変わるまで抑える | L69:168（retry 行）、P6 の規則4（自動で再送しない） |
| reentrant | 新しい attempt に入れるのは、前の phase の outer scope が後始末を終えて接続を返した後だけ（no-wait の lock と guard の Drop）。後始末が失敗すると接続は quarantine され、以後どの maintenance も入れない（workspace の reopen へ） | CONN:622-641、:715-724、L69:158 |
| admission closure | cancel、closed、generation、foreground、期限で、以後の phase を開始しない（各 phase の頭で `clear_finalization_grant` → no-wait → `check(Page)`、phase の間で `should_stop`）。runtime epoch が変われば、prepare の中でも `NIR1_GRAPH_ROSTER_CANCELLED` | RB:3851-3866、IDX:238-249、MR:1436-1452 |
| pending start | Native が permit を spawn_blocking の前に予約する。止まると、登録済みで未開始の B は receipt で `not-started`。止まった後は、B の statement を一切開始しない（dispatch の前の `check_stop`） | N-lib:7365-7396、MR:3363 |
| active owner | cycle の worker thread。接続 guard、statement、transaction、予算、予約、grant の mask はすべて scope の中で RAII。process-local の記録は handle ではない | §4.1 |
| cancel | attempt の stop_signal → hook（1,000 steps で interrupt し、latch が理由を保つ）。`should_stop` は Rust 境界と JSON（4 KiB ごと、CAP:182-225）で見る。cancel と grant の線形化は Native（`grant_work_finalize` が false → cancel の勝ち） | CONN:883-958、:1077-1088、N-state:1737-1775 |
| 有限待機 | 接続は no-wait（try_lock と foreground waiter の確認）。busy timeout は 0。sleep や condvar での待ちは無い。SQL は 600,000,000 counts と 180 s の協調期限（grant の後は SQL だけが残る）。cleanup と OS の停止には絶対の上限が無い（BC:41-50）。main の観測予算は独立している（T32） | CONN:622-641、RB:3862、CAP:24-95 |
| 実際の終了証拠 | (1) statement：SQLite が interrupt を返す（latch で typed になる）か、正常に完了し、statement と rows が drop される。(2) transaction：rollback、または COMMIT の後の `is_autocommit()`。(3) hook：解除の成功（`progress_handler_cleared`）。(4) busy timeout の復元。(5) capacity scope の再設置と commit hook の解除の成功。(6) Native の receipt（work の状態）と permit の Join。kill、error、Promise の reject だけでは終了とみなさない | CONN:978-1052、TL:503-551、CAP:423-436、:576-605 |
| error | §3.4 の分類表。typed stop と cleanup の失敗は `Err`。容量と Graph の契約は Refused（旧 sealed を維持し、partial は無い）。retryable な未知エラーは `Err` | RB:4334-4339、MR:3669-3688、:3992-4052 |
| timeout | (1) 協調期限 180 s：`CapacityExceeded`（Refused）。(2) main の観測予算：cancel として扱う（stop_signal）。どちらも grant の前なら rollback する | CAP:47-63、BC:19-39 |
| onClosed | workspace の切替、終了、shutdown：permit の `stop_requested` → `should_stop` が `NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED` → typed stop → rollback。authority は pin されているので、DB が下から閉じることはない。新しい authority では runtime owner が変わり、古い snapshot は publish できない（IDX:2287-2320） | N-lib:7956-7978、STATE:167 |
| restart 時の状態 | B 固有の永続状態は無い。DB には旧 sealed（または無し）か、完全な新しい generation のどちらかしか無い。process の記録は消える。Run が無いので、Native の StartupRecovery は StartFresh になる | §3.6 |

### 4.3 barrier での順序（U の transaction の中）

1. `graph.check(Publish)`：closed → cancel（stop）→ participant → generation → deadline → foreground の順で検査する（CONN:425-505）。その前に cycle の `should_stop`（permit の stop と attempt の cancel、MR:1436-1452）。
2. publish の本体（取り消せる。全段で同じ check）。
3. `graph.check(ResultAssembly)`：最後の controlled な境界。
4. `try_reserve_maintenance_finalization()`：foreground waiter がいれば PREEMPTED（予約の前後で waiter を見る、DBLIB:552-575）。
5. `grant_finalize(work_key)`：attempt が StopRequested なら false で cancel の勝ち。true なら `finalization_granted_signal` が立ち、hook と check が stop の集合（期限を含む）を mask する。
6. COMMIT：commit hook が SQL の予算から1 count を予約する。超過なら rollback が確定し、typed refusal になる。grant があっても SQL の上限は免除しない。
7. `FinalizationGrantScope` の Drop と `clear_finalization_grant` で mask を外す → `mark_work_succeeded`。遅れて来た cancel は成功を書き換えない（L69:154）。

## 5. schema の要否

- 推奨案（b-L）：**不要**。Run を作らない。CHECK（MIG:6611-6615）は、この kind の Run が生まれないことを DB 側でも保証する。誤って作ろうとしても、ML:436-471 と CHECK の二重で失敗する。
- (b-R)（Run 付き）を選ぶ場合の最小案。番号は integrator が決める（v42 は CR-1 が使用中なので、v43 以降）：
  1. `migrate_run_kind_v{N}`：v24 の型（MIG:6518-6680）に倣う。存在を確かめる → compact SQL で済みか判定する → 未知の値は fail-closed → autocommit を要求する → `narrative_extraction_runs_v{N}` を作り、CHECK に `'nir1-graph-index-build'` を足す → 行を写す → drop と rename → 行数と FK を確かめる。Task と Attempt は変えない。
  2. 同じ PR で、`SCHEMA_VERSION`、schema の契約と版の assert、restore の allowlist、seed の parity、protected writers を更新する（計画 :325）。
  3. それに加えて：ML の task kind、work key、canonical spec、MR の discovery の arm と `durable_run_work`、failure の分類（容量超過を manual にするか）、POL-RK の行、VAL-RK の定数、T-RR の数、main の TS の union。
  - この案は、確認済みの「新しい schema を加えない」（L69:147、:159、P6:12）との整合を、integrator（必要ならユーザー）に確認する必要がある。HOLD に当たる。

## 6. 試験計画

共通の確認：typed な結果、generation・source digest・D1 head の version が変わらない（旧 sealed の維持）、partial な行が無い（metadata、D1、V1、Freshness の件数）、接続は再利用できる（C6 を除く）、次の cycle は最初から始まる。

**A. gate と A-1**
- A1 `graph_build_gate_opens_only_for_validated_journey_seam`：None、packaged、`ci!="true"`、token 違い、別の trigger はすべて閉。正しい seam と trigger だけが開。
- A2 `product_default_cycle_never_registers_or_dispatches_graph_build`：control 付きの cycle で、qualified な E/R material と、dirty または欠けた Graph を用意し、seam は None。register された key に `/nir1-graph-index-build/` が無いこと、Graph の surface が 0 件のこと、durable な連鎖の Run の行が runtime 無しの基準と同じであることを確かめる。
- A3 `wire_request_cannot_carry_graph_build_work`：wire にこの kind を入れると、gate が開いていても閉じていても `NEX_MAINTENANCE_INVALID_REQUEST`。
- A4 `forged_graph_work_with_closed_gate_is_refused_before_sql`：試験が接続を保持したまま、gate 閉で dispatch する。Refused（GateClosed）であり、PREEMPTED ではないこと（SQL を試みていない）。
- A5 `graph_build_kind_is_ledgerless`：`AutomaticRunKind::all()` は3のまま（MR:5744-5757 は不変）。`route_descriptors()` にも出ない。この run_kind の Run 行を直接 INSERT すると CHECK で失敗する。lifecycle での作成は `NEX_MAINTENANCE_RUN_KIND_INVALID`。
- A6 既存の T-RR（parity）と RR:264-295 が変更なしで通る。Native の `nir1_graph_query` は `NIR1_GRAPH_NOT_ACTIVATED`（既存の Native 試験）。

**B. 正例**（file-backed の `WorkspaceAuthority::from_database_for_test`。seeding は `nir1_graph/tests.rs:77-156` の Fixture と同じ `request`／`approve_typed_revision`。reader の登録 owner は同ファイル :85-96 の `RegistrationOwner` と同じ形を新 module の試験に置く）
- B1 `open_gate_cycle_builds_publishes_and_reader_is_available`：wake の cycle で、連鎖が静止した後に B を dispatch する。確かめること：`BindingRead::Registered{generation:1, dirty:false}`、`is_complete_registered` が真、`Nir1GraphReader::register_with_control` が真、seed の query が available で、path と Evidence が期待どおり。
- B2 `second_cycle_skips_current_binding`：`Skip{BindingCurrent}`。generation は変わらず、B は登録されない。
- B3 `decision_change_rebuilds_next_generation`：A2 の変更で dirty になり、generation 2 になる。reader が新しい roster を返し、generation が混ざらない。
- B4 `verify_reruns_after_publish_and_counts_graph_as_declared`：publish の後に Verify が再実行される（digest の CAS）。semantic-index の footprint は全 0（VC:509-531）で、clean。
- B5 `cold_reopen_validates_once_without_rebuild`：同じ file を新しい authority で開くと V が走り、Validated になる。generation は不変。次の cycle は `Skip{BindingCurrent}`。

**C. 失敗の経路**
- C1 prepare 中の取消：Page／Row／A2／Material で stop_signal を立てる。`cancel_next_native_prepare_after_first_roster_row_for_test`（IDX:164-173）も使う。typed な Cancelled か `NIR1_GRAPH_ROSTER_CANCELLED` で、書込みは無い。receipt は interrupted。
- C2 publish 中、grant の前の取消（Publish／D1／Edge の段）：rollback され、prior binding はそのまま。
- C3 grant の順序：(i) cancel が先なら `NEX_MAINTENANCE_ATTEMPT_CANCELLED` で rollback。(ii) grant が先なら、その後に stop を立てても COMMIT は進み、成功が残る。`work_completed` はちょうど1回。
- C4 foreground preemption：P の中と、U の予約の前に waiter を置く。PREEMPTED になり、cycle は accepted(has_more) で work は deferred。書込みは無い。予約が None の経路も含める。
- C5 timeout：期限切れの予算（CAP の試験用補助）で `CapacityExceeded` の Refused になり、旧 sealed は残る。main 側の timeout は C1 と同じ（cancel）。
- C6 cleanup の失敗：failpoint（Rollback／ProgressReset／BusyTimeoutRestore／AutocommitCheck、CONN:1494-1536）を B の phase で起こす。`NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED` になり、接続は quarantine される（以後 `ensure_connection_reusable` が失敗する）。B も他の maintenance もその接続では走らない。binding は不変。
- C7 容量の N+1（数値は変えない。capacity fixtures には触れない）：SQL の 600,000,001（予め消費した予算）、候補の 2,065（合成の proposal）、保存 edge の 8,194 行（合成）、Source の 16 MiB+1。どれも route を通して Refused になり、partial は無く、旧 sealed が残る。次の cycle は `Skip{RefusedUnchanged}`。feed が進むと再試行する。成分 6 MiB 以下での whole-set 超過（P6:81）は、CR-1(d) の試験が入っていれば流用する。
- C8 workspace の切替：P と U の間、および U の grant の前で `should_stop` が lifecycle stop を返し、typed stop になる。P と U の間で runtime epoch を回す（`pause()` または `bind_embedding_generation`）と `NIR1_GRAPH_SNAPSHOT_STALE`／`…ROSTER_CANCELLED` で Refused。prior はそのまま。
- C9 barrier での drift：P と U の間に、別の WAL writer で A2 の決定、Source、Scope、D1 を変える（BC の P2 と同じ手法）。`…STALE`／`…CHANGED_DURING_PUBLISH` で Refused。次の cycle で再構築する（tuple が変わっている）。

**D. restore と cold reopen**
- D1 restore：sealed binding がある状態で `ensure_restore_epochs_for_workspace` を呼ぶ。`is_complete_registered` は偽、reader の登録も偽になる。gate 閉では `Skip{GateClosed}` で unavailable のまま。gate 開では NotCurrent から再構築し、available になる。
- D2 cold reopen と外部編集：invalidation を通らない SQL で入力を変えて開き直す。reader は unavailable。V が検出して再構築し、available になる。
- D3 publish 中の失敗（U の中、D1 を書いた後に試験用の注入でエラーを起こす）：rollback される。開き直すと、旧 sealed か無しのどちらか。hint が stale と判定して再構築する。

**E. 受入れのコマンド**（すべて `CARGO_BUILD_JOBS=4`）
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib <filter>`：filter は maintenance、nir1_entity_relation_index、nir1_capacity、restore、nir1_graph_index_maintenance。
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --test narrative_maintenance_contracts --test narrative_maintenance_route_registry --test narrative_maintenance_runtime --test narrative_maintenance_lifecycle_runtime`
- `cargo clippy --manifest-path src-tauri/Cargo.toml -p grimodex-db --all-targets -- -D warnings`。IDX の cfg を変えるので、`--features nir1-material-diagnostics` でも実行する。
- Native：`cargo test --manifest-path electron/native/grimodex-node/Cargo.toml narrative_maintenance` と `nir1_graph_activation`。clippy は `--all-targets -- -D warnings`。

## 7. 信頼境界と委任範囲

- trusted：Native／DB builder（cycle の worker）、既存の producer と registry、A1／A2 の authority、sealed D1 head（L69:148）。
- untrusted：
  - DB の内容（restore、import、外部編集）：gate の根拠にしない。binding は毎回検証する。
  - renderer：経路が無い。
  - main：seam は検証する。wire の B は拒否する。
- 保存：製品は何も新しく書かない。試験と journey は、proposal/5 の Graph surface だけを書く。
- 送信：無い。
- 委任の判断：U3 の「owner／終了処理／lifecycle」の範囲で配置を (b-L) に決めた。ただし、TASK の候補 (b) が想定した「永続する Run Kind」ではない。そのため §9 の 1 で integrator に確認する。

## 8. 変えないもの

- B-close の数値、per-Revision の上限、query の固定値、capacity fixtures。
- 既存3 route の挙動と契約。policy、validator、T-RR、ML、MC は変えない。
- schema と migration。docs/plans、policies、evals、lock、package.json、依存。main の TS。
- `nir1_graph_query` などの製品の Graph 入口。新しい `#[napi]` と IPC。
- restore の Epoch 作成（RB:162-195）と、Rebuild が semantic-index を飛ばす処理（RB:1260-1263）。

## 9. 未決事項（integrator への確認）

1. **配置の承認**：(b-L)（gated で production registry と policy の外、ledgerless）でよいか。Run の ledger を求めるなら (b-R) になり、§5 の schema のため HOLD。advisor の結論は §10。
2. **skip の証跡**：durable には書かず、型付きの判定と debug log だけにする（gate 閉では DB を読まない）。TASK の「maintenance_skip_evidence の形」をこの解釈でよいか。durable に残すなら、Run（schema）か Verify／Rebuild の outcome 契約の変更が要る。
3. **CP-4 で要るもの**（B-ROUTE の外）：
   - main の TS に trigger `nir1-graph-index-build` を足す（M-ci:68-74）。
   - receipt の解析で、未知の Run Kind は全 batch の retry に退避する（M-nm:730-787）。gate 開で B が interrupted になったときに起きる。
   - 静止した project で B だけを起こす wake は無い。journey は既存の wake（workspace-opened、restore、epoch 回転）でサイクルを起こす。
4. **PUB-G で決めること**：
   - production registry への登録と policy の行（ledgerless という概念の表し方を含む）。
   - wake 源と再構築の頻度（Freshness の publisher が変わるだけでも dirty になる、INV:85-114）。
   - source digest が変わらないときの再封印の省略。
   - refusal の UX（Inbox）と、§3.5 の解除条件の見直し。
   - stale な Graph があると、Verify は incomplete で待ち続ける（Chronicle と同じ既存の挙動）。
5. **共有の runtime epoch**：embedding generation の bind で、進行中の B は stale になって拒否される。次の wake で再試行する。これを許容してよいか。

## 10. advisor の結論

- 出典：workflow `wf_5241a95d-291` の `advise:broute`（model fable、effort high）。verdict は **proceed**、required は空。
- 確認された点：barrier の順序（Rebuild／Verify の最終 transaction と同じ型）、partial generation の不可視化と旧 sealed の維持、cleanup 失敗の quarantine、gate の閉じ方（seam は main 専用・one-shot、`validate()` が未 package・CI・owner token を要求）、判定と skip 証跡の形、restore と cold reopen、schema 不要（ledgerless）、委任外6項目に当たらないこと。
- 非ブロッキングの指摘（a〜h）。実装での扱いは §11 に書く。
  - a. 網羅 `match` の波及（`as_str`、`validate_dispatch_contract`、`decide_execution`、`durable_run_work`、Native の manual、試験 helper）と、`route_id()` の gated 表への fallback。
  - b. durable 連鎖が manual 修復待ちで止まっている project では B を飛ばす（`Skip{DurableChainHalted}`）。
  - c. V が偽なら同じ work で P＋U に進まず、ValidationFailed を記録して次の判定で Rebuild にする（1 dispatched work＝1 attempt）。
  - d. V では `GraphWorkStage::ColdReopen` を先に検査する（診断経路と同じ）。
  - e. 記録の鍵は runtime の owner と connection epoch。
  - f. §3.3 の 15（Refused の記録）は 10〜12 より先に評価する。
  - g. CP-4 の留意（main の TS、trigger 一覧の3か所）。
  - h. gated adapter は gate の値なしでは呼べないことを型で担保し、`route_descriptors()` が3本のままであることを RR の試験で固定する。
- integrator への確認事項（§9）は advisor も同意：§9.1 (b-L)、§9.2 型付き判定＋debug log、§9.5 runtime epoch による stale 拒否→次の wake で再試行、restore の Epoch が dirty を立てない現状維持。

## 11. 実装時の判断（Build 段階で追記。設計からの差分と理由）

1. **advisor c を採る（設計 §3.4 の V→P＋U を変える）**。V（cold reopen の検証）が偽なら、その dispatched work は `CompletedWithoutFinalization{rediscover:true}` で終え、process-local 記録に `ValidationFailed`（hint の tuple つき）を残す。cycle はすぐに再判定し、判定は `Build{Rebuild, ValidationFailed}` を返すので、同じ cycle の次の work（新しい attempt）が P＋U を行う。理由：1 work の上限を 1 attempt（180 s）にし、V と P の間に Native の work 境界（noop 完了→再登録→`work_started` と `should_stop`）を入れる。V が真、Refused、gate 閉、判定が Skip のときは `rediscover:false` で、同じ cycle の中ではその key を `terminal_halted_work` に入れる（設計 §3.1(6) のまま）。
2. **dispatch 時に判定をやり直す**。discovery の判定（Build の mode）は DesiredWork に載せない。adapter の phase 1（read transaction）で hint を読み直して判定し、その結果に従って V か P を同じ read transaction の中で行う。理由：discovery と dispatch の間の変化に追従し、wire や reason から mode を受け取らない。
3. **phase 構成**：adapter は全体を1つの `with_attempt` で包む。phase 1＝read transaction（判定＋V または P）、phase 2＝IMMEDIATE transaction（U）。V と P が1つの work で両方起きることはない。
4. **hint の構成**（安価な PK・EXISTS・MAX(rowid) の読取だけ）：current Epoch、metadata（generation、source digest、dependency digest、dirty、producer、version、built_at）、Graph の Freshness（freshness、action、epoch、digest、updated_at）、D1 head の version、残骸の有無、feed head（`MAX(canonical_sequence)`）、A2 の watermark（proposal、revision、decision の `MAX(rowid)`、全 project 共通）、候補の有無、`user_version`。Freshness の digest を metadata の digest と比べる条件（設計 §3.3 の 12 の最後）は外す。Freshness は V1 の digest、metadata は D1 の digest で、同じ値にならないため。digest の照合は V（cold reopen）と reader の登録時の full validation が行う。
5. **記録の照合は2種類**。Published／Validated は binding の identity（Epoch、metadata、Freshness、D1 head）が同じなら `BindingCurrent`。Refused／ValidationFailed は hint 全体が同じときだけ効く。A2 の watermark は binding が無いとき（suspend が dirty を立てられないとき）の入力変化を拾うために入れた。全 project 共通なので、他の project の変化でも再試行する（安全側）。
6. **advisor b は採らない**。B の publish は入力が変わったとき（dirty、欠落、not-current）にしか起きない。publish の後の Verify は1回だけ再実行され、修復待ちの Finding は report digest ごとに冪等。修復待ちの project で generation が増え続けることはない。修復待ちを判定に入れるには durable 連鎖の戻り値か Finding の読取を変える必要があり、範囲が広がる。
7. **advisor d を採る**。V は既存の `cold_reopen_graph_index_with_control`（IDX、`ColdReopen` の検査＋`is_complete_registered_with_control`）を使う。この関数と `GraphWorkStage::ColdReopen` の `cfg` を外す（どちらも `pub(crate)` のまま、呼出し元は gated adapter と診断だけ）。
8. **advisor e を採る**。記録の鍵は（runtime owner＝authority identity、connection epoch、project）。connection epoch は runtime と同じ `read_sqlite_source_revision` で読む（runtime の field は private で、runtime.rs は許可ファイル外）。`admit_native_build` が通っていれば、runtime の connection epoch と一致している。追い出しは設計どおり「新しい owner を入れるときに owner が小さい entry を捨てる」。並列の試験が互いの記録を消さないよう、B の試験は module の lock で直列にする。
9. **advisor f を採る**。判定は「need（欠落・dirty・not-current）があるときは、同じ hint の Refused 記録を先に見る」。構造上 current のときは記録の種類で分ける。
10. **advisor h を採る**。gated adapter は `Nir1GraphCycleContext`（gate を含む）を引数に取り、RR の分岐でも gate を再検査する。`route_descriptors()` が3本のままであることを RR の試験に足す。
11. **判定の順序**：§3.2 に合わせ、gate を最初に見る（設計 §3.3 の表は runtime と control が先だったが、どちらも SQL の前なので、変わるのは返す reason だけ）。製品の既定（gate 閉）は常に `Skip{GateClosed}`。
12. **typed stop の範囲を広げる**。`NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED`（Native の permit の stop）と `NEX_DB_TRANSACTION_CLEANUP_UNPROVEN` も typed stop（`Err`、記録しない）に入れる。既存の `is_maintenance_control_or_cleanup_error` は lifecycle stop を含まないため、B 用の分類を新 module に置く。
13. **C6（cleanup の失敗）の注入方法**。CONN の failpoint（`set_maintenance_cleanup_failpoints_for_test`）は private で、CONN は許可ファイル外。B の phase の中で、`with_capacity_scope` が hook の復元に失敗したときと同じ `NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: capacity hook restore` を試験用の注入点から返す。outer scope（CONN:1015-1023）がこれを検出し、`connection_reusable=false` から quarantine に進む実経路を通す。
14. **試験の置き場所**：新 module の試験は `nir1_graph_index_maintenance_tests.rs`（`#[path]`）に置く。`validate-native-writer-ownership` は path に `tests.rs` を含むファイルを走査しない（試験は fixture の行を直接書く）。
15. **既存の統合試験の網羅 match**：`tests/narrative_maintenance_runtime.rs` と `tests/narrative_maintenance_lifecycle_runtime.rs` の `AutomaticRunKind` の網羅 `match` に、到達しない arm を足す（maintenance 系の試験。挙動と assert は変えない）。
16. **判定の順序を変える（設計 §3.3「durable な連鎖が None を返した後に判定」からの逸脱）**。実装中に、設計 §1.4 の前提「Graph が complete registered でなければ Verify は incomplete で待つ」が事実と違うことを確かめた（試験 `zz_debug_verify_after_dirty` で確認、HEAD `a153743b` のコード）。
   - Verify（RB:5296-5370）は reserved な semantic-index consumer について、binding が complete registered でなければ、その V1 edge を全部 `edge_ids_with_unresolvable_consumer_scope` に入れる。これは consistency issue なので、report は clean でも incomplete-only でもなく、manual 修復の分岐（MR:2500-2529）に入る。
   - その分岐の `terminal_failure::project_graph_repair_required_in_tx`（terminal_failure.rs:947）は、uncontrolled な `durable_graph_state_digest` を計算し、Graph の whole-project eligibility Source を解決しようとして `NEX_VALIDATION_TERMINATED:context-unavailable` で失敗する（source_revision.rs:244）。discovery が Err になり、cycle が Err で終わる。
   - 製品では Graph binding を作る経路が無いので、この経路には到達しない。B-ROUTE で gate を開いた環境では、publish 後に A2 などが変わって binding が dirty になると、Verify が先に走って cycle が毎回 Err になり、B に届かない（再構築が起きない）。
   - 対処（範囲内、lifecycle の順序だけ）：`discover_cycle_work` は先に B を判定し、**既存の binding が stale（BindingDirty、NotCurrent、ValidationFailed、ColdReopenValidation）なら、durable な連鎖より先に B の work を返す**。binding が無い場合（BindingMissing）は従来どおり durable な連鎖の後。gate 閉では判定が SQL なしで GateClosed を返すので、製品の既定の順序と挙動は変わらない。判定は discovery 1回につき1回だけ。
   - Verify の分類（RB）と Finding の projection（terminal_failure.rs）は変えない。前者を変えると、未承認の決定 `dirty-pending-semantics`（POL-SC の unapprovedDecisions）を実装で決めることになり、委任外（新しい契約）。後者は許可ファイル外。
   - 残る制限（PUB-G と integrator に引き継ぐ）：stale な binding の再構築が Refused（容量超過など）で抑止されている間は、Verify が stale な Graph を manual と判定し、projection が context-unavailable で失敗して、gate を開いた環境の cycle が Err を返し続ける。main の `discover_all`（uncontrolled）も同じ分岐で失敗しうる。Chronicle の binding が dirty になった場合も同じ projection の経路に入る（既存）。
17. **refusal の記録に超過した上限名を持たせる**。容量の refusal は `Refused{code:"NIR1_GRAPH_CAPACITY_EXCEEDED", limit}` とし、`limit` は admission の field（`candidate-rows`、`input-bytes`、`stored-edge-rows` など、IDX の `admit_capacity` のメッセージから取る）か、attempt の予算（`sql-progress`、`deadline`、`commit-reservation`）。数値は変えない。試験はどの B-close 上限で拒否されたかを確かめる。debug log には code と limit だけを出す（利用者のデータを含まない）。
18. **試験計画（§6）からの調整**（実装時の事実に合わせた。弱めてはいない）。
   - C7 の候補 2,065 件と、保存 edge 8,194 行、Source 16 MiB+1、SQL 600,000,001：adapter（`dispatch_graph_index_build`）と cycle の planner（`plan_graph_index_build`）で試す。B-close の契約で、Verify も同じ full-set 上限を共有する（`is_complete_registered` が roster を読む）。Graph binding がある容量超過の project では、Verify 自身が容量で失敗するので、full cycle では B に届く前に既存の route が止まる。抑止（RefusedUnchanged）と、A2 の変化での再試行は planner と judge で確かめる。
   - C5（期限）と C7 の SQL：判定の hint を読んだ後で予算を尽きさせる（hook で期限を越えるまで待つ、または `set_used_steps_for_test` で 600,000,000 を消費済みにする）。hint を読む前に予算が尽きると、入力が記録されず抑止を確かめられないため。
   - D1（restore）：restore の Epoch の下で再構築した generation は complete registered で、reader は available だが、qualified material は 0 件（node と edge が空）。l6-l9 の契約「rollback／restore は Revision を自動で qualify しない」のとおり。restore 前の roster は返らない。gate 閉の部分は、判定と planner（SQL なし）で確かめる。stale な binding は試験が gate を開いて作ったものなので、gate 閉の full cycle は §11.16 の既存の失敗経路に入る（製品には binding が無いので到達しない）。
   - D2（cold reopen と外部編集）：invalidation を通らない SQL で Graph の edge state を stale にする（binding は構造上 current のまま）。V が偽→ValidationFailed→同じ cycle の次の work が再構築する。
   - 順序の試験：B1 は binding 欠落の B が durable な連鎖（Verify）の後に来ること、B3 は stale な binding の B が durable な連鎖より先に来ることを確かめる（§11.16）。
   - 試験の注入点：`#[cfg(test)]` の thread-local な hook（`BeforeValidation`、`BeforePrepare`、`BetweenPhases`、`AfterPublish`、`BeforeFinalizationReservation`）。製品の build には入らない。

## 12. 再開時の検証と結果（Builder 再開、2026-10-13）

- 前の担当の途中変更を git status と diff で確認した。二重の適用はしていない。ソースの最終変更は試験ファイル（09:06）で、以後の mutation 検査（gate 再検査の除去、grant の除去、refusal 記録の除去）は `.orig` の退避から復元し、sha256 が退避時の値と一致することを確かめた。
- 試験の対応（§6 と §11 の調整）：A1〜A6、B1〜B5（B4 の確認 Verify は open-gate の試験内で検査、B1 と B3 の順序は §11.16 を検査）、C1〜C9（C7 は候補、保存 edge、Source、SQL の4上限と期限）、D1〜D3。新規の試験は追加していない。設計からの逸脱は無く、§11 の判断は変えていない。
- 受入れ（この worktree で再実行。前の担当のログは試験ファイル更新より前のものがあったため採らない）：
  - `cargo test -p grimodex-db --lib`（既定の feature）：1833 passed、0 failed、32 ignored。
  - `cargo test -p grimodex-db --test narrative_maintenance_contracts --test narrative_maintenance_route_registry --test narrative_maintenance_runtime --test narrative_maintenance_lifecycle_runtime`：4、1、30、9 件すべて成功。
  - `cargo clippy -p grimodex-db --all-targets -- -D warnings`：成功。
  - Native（`electron/native/grimodex-node`）の `cargo test narrative_maintenance`：59 件成功。`nir1_graph_activation`：1 件成功。Native の `cargo clippy --all-targets -- -D warnings`：成功。
  - `--features nir1-material-diagnostics`：`nir1_graph_index_maintenance` 22 件、`nir1_capacity` 31 件成功。
  - 同 feature の `cargo clippy --all-targets -- -D warnings`：失敗（lib 10 件、lib test 7 件）。指摘の場所は base `a153743b` と同じ 10 か所で、行番号も一致する。本差分に起因しない既存の指摘で、今回は直していない。
- 品質スクリプト：`scripts/quality/validate-native-writer-ownership.mjs` は ok（active=78, scanned=265）、`validate-change-feed-writers.mjs` は ok、`narrative-maintenance-boundary-rule.mjs` は exit 0。`validate-run-kind-policy.mjs` は worktree に `ajv` が無く、`validate-narrative-writers.mjs` は `typescript` が無いため実行できなかった。どちらも policy JSON と TS の writer を変更していないため、結果は変わらないと見ている。ただし未実行である。
- rustfmt：新規の2ファイルは `rustfmt --check` が通る。既存の変更ファイルの未整形箇所は HEAD から残るもので、追加行とは重ならない（行番号で照合）。
- `git diff --check` は tracked の変更でも新規ファイルでも問題なし。
- root checkout（`/home/grimodex/Grimodex`）は変更していない。`git diff` の sha256 が前回記録と一致する。

## 13. PUB-G の前提 #5（B の製品経路）の判断（2026-11-16。DR-PUBG-5-1〜12）

- 位置づけ：§9.4 の 5 点（registry、wake と頻度、再封印の省略、refusal の UX、stale な Graph と Verify）と、関係する残りの点の技術判断を残す。この節は判断の記録だけで、コード・policy・定数は変えない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 委任：NIR-1 の C-product レーン（worker／owner／lifecycle の技術判断、委任の内の技術的な threat model の改訂）。続行計画の「B の製品 activation は PUB-G の承認（Session C-1）で扱う」は変えない。
- 基点：origin/master `cea3988b`。上の §1〜§12 の行番号は B-ROUTE の base `a153743b` のもの。この節の「確認済み」は `cea3988b` で読み直したもの。「broute 引用」は §11 の記述をそのまま引いたもので、今のコードと照らし直していない。
- GDX-PRECHECK-001：長期・高リスク、background／async-lifecycle、subprocess（間接）、security-sensitive の threat model（委任の内の改訂）に当たる。external-egress には当たらない。編集の前に、ユーザーへ 4 点（Q1、Q2a、Q2b、Q3）を伺い、3 点の回答を得た（DR-PUBG-5-11）。
- 材料：`/home/grimodex/fusion-eval-data/pubg-a/05-precheck.md`（contracts の外）。

### DR-PUBG-5-1：#5 が「済み」になる条件

- この節の判断（DR-PUBG-5-1〜12）を decisions に残し、作業記録に索引する。
- そのうえで、閉じた gate の内側の実装を merge する（PR-1：Rust と Native、PR-2：main と Native。段取りは下の「実装の段取り」）。
- 製品の registry への登録、policy の行の実体、定数の切替、開示の文案は、PUB-G の PR（Session C-1 の承認の後）に置く。#5 の範囲ではない（DR-PUBG-5-12）。
- 実装の merge は、次の S4（9 回目）の PR の merge の後（ユーザーの回答。DR-PUBG-5-11）。正式 run の候補には入れない。

### DR-PUBG-5-2：production registry の形（R1：2 段）

- #5 の段：B の route は別表の gated route のまま。gate を「journey seam か product gate」の 2 経路にするだけで、registry の集合は変えない。production の `ROUTE_REGISTRY` は 3 本のまま。
- PUB-G の段：gated route を production の `ROUTE_REGISTRY` へ移す（4 本）。policy の行と parity 試験（`tests/narrative_maintenance_route_registry.rs`）も 4 本にする。これは委任の外で、PUB-G の PR で確認する。
- ledgerless（Run を作らない）：`run_kind` の CHECK（v24）に値を入れず、schema は変えない（§5 の方針を保つ）。表し方は policy の行の側で決める（DR-PUBG-5-3）。
- 採らない案：R2（別表を恒久化。policy の形の変更なので委任の外）、R3（今 4 本目に入れる。parity が policy の行を要するので委任の外）。

### DR-PUBG-5-3：policy の行（P1：文案だけ今、実体は PUB-G）

- 文案（PUB-G の PR で `wired` として入れる）：
  - `runKind: "nir1-graph-index-build"`
  - `existingRunKindColumnValue: null` に、新しい field `durableRun: false` を足す（null の意味は未確認なので、null だけで ledgerless を表さない）
  - `trigger: "automatic-when-derived-state-absent-or-invalid"`（既存の値）
  - `epochBound: true`、`periodic: false`
  - `writes`：B は D1・V1・metadata・Freshness を書く。既存の 3 値のどれにも正確には当たらないので、新しい値 `declared-index-binding` が要る
  - `autoRetryableFailureClasses` と `manualOnlyFailureClasses` を書く。容量の拒否は manual にせず、process-local で抑止する（DR-PUBG-5-6）
  - `runtimeRoute`：PUB-G で付ける
- schema の enum・件数・新しい field の変更、validator（`scripts/quality/validate-run-kind-policy.mjs`）、parity 試験の変更は、policy が動作契約なので PUB-G の PR で品質の gate を通す。新しい語彙が「新しい契約」に当たるかは、その束で確認する（DR-PUBG-5-12）。
- `periodic: const false` があるので、周期の wake は採らない（DR-PUBG-5-4）。
- 採らない案：P2（今 `unwired-blocked` で入れる。PUB-G の前に契約の形を変える）、P3（policy に書かない。validator の原則に反する）。

### DR-PUBG-5-4：wake の源（W1＋W2。W3 は測ってから）

- 前提（確認済み）：main の wake の理由は 4 つ（`workspace-opened`、`restore-completed`、`semantic-epoch-rotated`、`before-cutover`。`narrativeMaintenanceTriggers.ts:10-14`）。discovery が B の wake を返すのは seam の下だけ（`maintenance_runtime.rs:2291-2300`、:2326-2350）。Graph を dirty にする経路は X1-5 の後に絞られている（`nir1_chronicle_index/invalidate.rs`）。§9.4 の「Freshness の publisher が変わるだけで dirty」は X1-5 より前の記述で、今は「Graph 側の入力が変わったとき」と読む。
- 採る：
  - W1：既存の wake（open／restore／epoch）の discovery で、product gate の下でも `GraphIndexBuildWake` を返す（seam と同じ規則）。
  - W2：需要からの wake。Related Scenes の seed 付き begin が、binding が current でないために Graph unavailable になったら、その project の maintenance の wake を 1 つ要求する。根拠は l6-l9 :508（reopen／query の行）と :516（後続の query だけが current sealed binding を使う）。1 回目の query は unavailable（R＋IR）で、作り直しの後の query から Graph を使う。
  - W2 の実装の形は 2 案で、実装時に選ぶ。(a) Native の Graph owner が持つ「満たされなかった需要」の集合（`MAX_UNSERVED_PROJECTS = 8`、`nir1_graph_product.rs:72-74`）を discovery の判定に渡し、既存の Native→main の通知の経路で wake を起こす。(b) main の begin の handler で理由を見る。main が begin の応答から Graph の理由を読んでいるかは未確認。どちらでも、renderer 向けの新しい IPC・`#[napi]` の入口は足さない。足さずに済まない場合は、main 専用の入口として decisions に追記する。
- 採らない：
  - W3（Graph 側の入力の commit の後の debounce した wake）：DR-BSEAM-3 が実機の結果を見てからとした案。W2 の後に、B の build の回数・DB の取り合い・registration の窓（DR-GRW）を測ってから別の判断にする。決定・A2 が続くたびに build（最悪 180 s）が走りうる。
  - W4（定期の timer）：`periodic: const false` と衝突する。委任の外。
  - W5（dirty の源を絞る）：`KNOWN_NON_GRAPH_REVISION_KINDS` に組を足す変更は、コードのコメントが新しい確認済み契約を要すると明記している。委任の外。
- 頻度の防御（委任の内。`nir1-defensive-resource-limits` の規則 1〜8 の下）：
  - 1 project につき同時に 1 つ。
  - 拒否されたら、入力（hint の tuple）が変わるまで再試行しない（§3.5 のまま）。
  - 需要からの wake の最短間隔は、Graph owner の backoff と同じ 2 s から 60 s（CP2a-D14）にそろえる初期案。値は実測で決めて記録する。
- 受け入れる：共有の runtime epoch の回転（embedding generation の bind）で、進行中の B が stale で拒否され、次の wake で再試行する（§9.5）。W2 の下では、次の需要が再試行を起こす。
- (a′)（refused を drift と incomplete に分け、drift では Suspended にしない）との関係：W2 があると、registration の拒否が続いたときも、B の publish と CP2a-D47 の hook（`cp2a-decisions.md:231`、:260）で Suspended が解ける。(a′) が要るかは W2 の後に測り直す。(a′) 自体は契約の変更として保留のまま（`graph-registration-window-decisions.md:85`）で、#5 では触れない。hook が製品で B の publish の後に届くことの試験は、PR-2 に置く。

### DR-PUBG-5-5：再封印の省略は #5 でしない

- 毎回、新しい generation を publish する（今のまま）。
- 省略するには、generation を進めずに dirty を 0 に戻す新しい publish の経路が要る。これは POL-SC の metadata binding（generation は active sealed D1 head の generation と等しい）と、CP2a-D7（ReadyPublished で worker を退役させる）の読みに関わる難しい判断で、B の build の回数もまだ測っていない。
- 進め方：W2 の後に、build の回数と worker の退役の費用を測る。要るなら read-only の advisor に諮る別の判断にする。契約の読みが割れれば `[precheck]` に戻す。

### DR-PUBG-5-6：refusal の UX（U1）と解除条件

- U1：画面は変えない。拒否は process-local の記録と debug log に残す（code と limit だけ。本文・ID は出さない。§11.17）。Graph は今の理由（`registration-unavailable` など）で unavailable になり、R＋IR に戻る。新しい理由・文言・保存は無い。
- 採らない：U2（Related Scenes に「Graph を作れない」行を出す。閉じた理由の集合への追加と新しい文言。K6 の分類器への影響は未確認）、U3（Inbox の durable な Finding。保存範囲の拡大）。どちらも委任の外。ユーザーの回答でも、画面では知らせず開示だけにする（DR-PUBG-5-11）。
- 解除条件の見直し（委任の内）：今の条件は、成功、tuple の変化（A2 の watermark を含む）、runtime epoch の変化、process の再起動の 4 つ（§3.5、§11.5）。W2 を足すので、需要からの wake では、判定の SQL（PK・EXISTS・MAX(rowid) の読み）だけで `RefusedUnchanged` を返し、重い prepare に入らないことを試験で固定する。
- process-local の記録の上限：今は owner の単調性で古い entry を捨てている。複数の project を開き直す使い方で増えるなら、防御の上限を置く。実装時に、数値と根拠を追記する。

### DR-PUBG-5-7：stale な Graph と Verify、残る制限（f・g・h）

- 訂正（f）：§9.4 の 5「stale な Graph があると Verify は incomplete で待ち続ける」は、§11.16 が事実と違うと訂正している。`cea3988b` で確かめたのは次の 3 点（確認済み）。
  - Verify（`restore_rebuild.rs:5476-5490`）は、reserved な semantic-index consumer の binding が `is_complete_registered_with_control` でなければ、その edge を全部 `edge_ids_with_unresolvable_consumer_scope` に入れる。
  - discovery の manual 修復の分岐（`maintenance_runtime.rs:2635-2665`）は `project_graph_repair_required_in_tx` を呼び、durable な Finding（semantic-graph-requires-repair）を projection してから `Ok(None)` を返す。コードの注記は「Automatic maintenance halts here on every wake」。
  - projection は `durable_graph_state_digest` を計算する（`terminal_failure.rs:922-960`）。
  - よって (f) は「待つ」ではなく、「manual の分岐に入り、その project の自動 maintenance が止まる」と読む。
- Q1（stale な binding の再構築が拒否されたとき）：ユーザーには、V0 の調査の後に伺う（DR-PUBG-5-11）。選択肢は (i) 今の挙動のまま開示する、(ii) Verify が stale な Graph binding を manual としない読み（`dirty-pending-semantics`）を新しい契約として起案する、(iii) 拒否のときに binding を退かせる案を起案する（l6-l9 :506「成功時だけ sealed head を更新する」の読みの変更）。(ii)(iii) は委任の外。
- V0（委任の内。read-only の調査と Rust の試験）：stale＋Refused の project で、(1) 止まる maintenance の範囲、(2) 利用者に見える Finding、(3) projection が Err になるか（§11.16）、(4) Verify 自身が容量で落ちる経路（§11.18）、(5) Err や停止が wake の回数に縛られること、を確かめる。結果は `/home/grimodex/fusion-eval-data/pubg-a/05-v0.md`（contracts の外）に書き、Q1 の問いに添える。
- V4（h の対処、PR-1）：product gate の下でも、制御なしの discovery が `context-unavailable` のときに wake を返す（DR-BSEAM-2 と同じ規則を product gate に広げる）。
- 注（h）：DR-BSEAM-5 が報告した「Chronicle の sealed binding で、製品の Main の discovery が失敗しうる」件は、#5 の前から製品にある（`maintenance_runtime.rs:2310-2324` の注記が同じ失敗を述べている。製品で起きた回数は未確認）。V4 は B の gate が開いたときだけ効くので Chronicle の件は直らない。#5 では直さず、新しい項目の候補として報告する。

### DR-PUBG-5-8：product gate の結び方

1. B の product gate は `PRODUCT_GRAPH_PUBLISHED`（const）だけから作る。`publication_open()` には結ばない。`publication_open()` は「const → `nir1-graph-eval` の flag → cfg(test)」の順で開く（`nir1_graph_product.rs:576-592`、確認済み）。これに結ぶと、CP-4 の評価 build で製品の wake が開き、seam の下の測定の挙動が変わる。
2. PUB-G で一緒に切り替える一覧（一覧 #2）に、独立の switch を増やさない。B の gate は同じ const に従う。
3. pin 済みの `scripts/quality/nir1-graph-eval/native-architecture.mjs` を変えない。この検査は `publication_open` の本体（`FIXED_BODIES`）と、`lib.rs`・`nir1_graph_product.rs` での eval feature の使い方を固定している（確認済み）。token は、`publication_open` にも eval の cfg にも触れずに const から作る。「B の gate は const からしか作れない」の検査は、pin されていない場所（Rust の型と試験、または新しい検査 script）に置く。`native-architecture.mjs` の期待を変えるのは PUB-G の PR でだけ行う（一覧 #1）。
4. gate の型は field を private にしたまま保つ（§3.2）。生成の経路は `closed()`、`from_journey_seam(..)`、`from_product_publication(token)`（token は Native の const からしか作れない型）、`open_for_test()` の 4 つだけ。
5. gate が閉じている間は、判定は SQL を読まずに `Skip{GateClosed}` を返し、discovery は wake を返さない。A2 の試験を product gate でも持つ。

### DR-PUBG-5-9：owner／lifecycle matrix（新しく足す wake の源。B の attempt の内側は §4 のまま）

| 項目 | 扱い |
|---|---|
| entry | (W1) 既存の wake の discovery。(W2) 需要の記録（Native の Graph owner の begin が、binding の未登録で unavailable）から、main の scheduler へ wake を要求する。renderer は B を名指しできない（wire の B は `normalized_work` が拒否、§3.1(3)） |
| start | product gate が開いているときだけ、scheduler が (binding, project) の wake を登録する。cycle は既存の permit と spawn_blocking |
| retry | 自動の再試行は無い。次の需要か次の既存の wake で、最短間隔（DR-PUBG-5-4）と `RefusedUnchanged` の抑止を通ってから |
| reentrant | (binding, project) ごとに pending は 1 つ。既に pending か実行中なら合流し、新しい timer を作らない |
| admission closure | product gate が閉じていれば要求を受けない（timer を作らない）。workspace binding が違えば捨てる。shutdown の開始の後は受けない（既存の scheduler の dispose） |
| pending start | 最短間隔の timer は scheduler が持つ。workspace の切替と shutdown で clear し、dispose の記録で確かめる。未開始の wake は永続しない |
| active handle | cycle の worker（既存の permit）。B の attempt の handle は §4.1 のまま |
| cancel | 既存の permit の stop と attempt の cancel（§4.2） |
| 有限待機 | 待ちは無い（no-wait の接続、busy 0）。timer の上限は最短間隔の上限（初期案 60 s） |
| 終了の証拠 | timer の clear と scheduler の dispose の receipt。cycle は既存の receipt と permit の Join。kill・error・Promise の reject だけでは終了とみなさない |
| error／timeout／onClosed | wake の cycle の失敗は、既存の `persistDeliveryFailure`（scope `wake`。DR-BSEAM-6 (4)）に乗る。DR-PUBG-5-7 の Err が続く場合、この receipt の書込みは wake の回数だけ増える。新しい保存範囲ではないが、回数は V0 で測る |
| 子 process | B の publish は ReadyPublished で C-query worker を退役させる（CP2a-D7）。spawn の回数は publish の回数に比例する。worker の lifecycle は変えない |
| 再起動時の状態 | 永続する状態は無い。process-local の記録は消え、cold reopen では `ColdReopenValidation` を 1 回行う（§3.6） |

### DR-PUBG-5-10：threat model の差分（委任の内の技術的な改訂）

確認済みの actor・防御・受信先・受入れは変えない。
- 新しい攻撃：
  - untrusted な renderer が seed 付きの begin を繰り返し、B の build を誘発して、CPU・IO・DB の接続を消費する（自分の機械の上の資源の枯渇）。
  - W2 と DR-PUBG-5-7 の状態（stale＋Refused）が重なると、renderer は cycle の停止や Err と、既存の delivery failure の receipt の DB への書込みも誘発できる。回数は最短間隔で有界。
- 防御：(binding, project) ごとの coalesce と最短間隔、`RefusedUnchanged` の抑止、B の attempt の上限（600,000,000 counts、180 s。B-close の数値は変えない）、前景の preempt（no-wait、foreground waiter）、renderer は B を名指しできない。
- 受信先・保存：どちらも増えない。debug log は code と limit だけ。delivery failure の receipt は既存の書き先と形のまま。
- 受入れ：製品の既定（const false）では、wake 0、B の判定の SQL 0、Graph の surface への書込み 0。
- 委任の外に当たるもの（上記の判断で避けたもの）：policy の固定値の変更、runtime activation、閉じた理由の集合への追加、durable な行の追加、POL-SC の `unapprovedDecisions` を実装で決めること、「成功時だけ sealed head を更新する」に反する書込み、Graph を dirty にする入力を絞ること。

### DR-PUBG-5-11：ユーザーの回答（2026-11-16、precheck への 3 問）

記録：contracts `4bc41c28` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-16-pubg-5-precheck.md`。
1. 判断の docs は今 merge し、実装は S4（9 回目）の PR の merge の後に merge する（Q2a）。正式 run の候補には入れない。
2. 製品の wake（需要からの wake など）の下での B の挙動は、CP-4 の評価の経路（別の seam）では測らず、開示に回す（Q2b）。S2 と harness は変えない。効果は PUB-G の前の dev の journey（凍結の外）で確かめて記録する。
3. 容量の拒否は、画面では知らせず、開示だけにする（Q3。DR-PUBG-5-6 の U1）。
4. Q1 は未回答。V0 の調査の後に、結果を添えて伺う（DR-PUBG-5-7）。

### DR-PUBG-5-12：PUB-G の PR（C-1）へ持ち越す確認（#5 の作業は止めない）

- gated route を production の `ROUTE_REGISTRY` に移すこと（DR-PUBG-5-2 の 2 段目）。
- policy の行を `wired` で入れること。schema の件数・enum、新しい語彙（`durableRun`、`writes` の `declared-index-binding`）、validator、parity 試験を変える（DR-PUBG-5-3）。
- `PRODUCT_GRAPH_PUBLISHED` の切替。B の product gate も同じ const で開く（DR-PUBG-5-8）。`native-architecture.mjs` の期待の変更も、この PR で行う。
- main 側の独立した拒否が外れたことの確認（DR-PUBG-5-14 の判断 4。点検 R5）：bootstrap は全 launch で `acceptGraphIndexBuildWakes: true` を渡すので、seam の B の launch 以外で `wakeProjectIds` を載せた応答を main が拒否する防御（DR-BSEAM-1）は無い。定数が false の間は Native が wake も event も出さないので不活性。切替の PR では、定数以外の原因で `wakeProjectIds` が出ないことを Native 側の gate（token・discovery の判定・cycle の dispatch の再検査）で確かめる。DR-PUBG-5-8 の 2 により、独立の switch は増やさない。
- 開示の文案の候補：容量の拒否（U1）、Q1 の答え、Q2b の答え（製品の wake の下の B の挙動は測っていないこと）、DR-BSEAM-5。
- 一覧の新しい項目の候補：DR-BSEAM-5（Chronicle の sealed binding で、製品の Main の discovery が失敗しうる）。

### DR-PUBG-5-13：PR-1（Rust と Native、閉じた gate）の実装判断（2026-11-17）

- 位置づけ：上の「実装の段取り」の PR-1 に入る前の判断と信頼境界の記録。この判断を残す commit ではコード・policy・定数を変えない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 委任と停止点：NIR-1 の C-product（worker／owner／lifecycle の技術判断、委任の内の技術的な threat model の改訂）。枝 `claude/pubg-5-pr1`（基点は PR #922 の head `87937140`）に push するが、PR は作らず merge しない。merge は次の S4（9 回目）の PR の merge の後（DR-PUBG-5-11 の 1）。
- ユーザーの回答（DR-PUBG-5-11 の 4 の更新）：contracts `ed90f78b`（`docs/plans/nir1-pubg-records/user-confirmation-2026-11-17-pubg-5-q1.md`）。Q1 は「(iii) を起案する」。(iii)（拒否のときに binding を退かせる）は新しい契約の起案で、確認の後に実装する。PR-1 には入れない。それまで PR-1 は (i)（今の挙動のまま開示）の前提で進める。`discover_all` の Err の封じ込めは、委任の範囲の技術判断として別に扱う（同じ回答）。統合者は、封じ込めをこの PR から外して別の PR・DR に切り出した（判断 7）。
- 材料：V0 の調査 `/home/grimodex/fusion-eval-data/pubg-a/05-v0.md`（contracts の外）。dev 枝 `claude/pubg-5-v0-dev` の `9b510f50`（push しない）の probe を、assert のある試験に直して使う。
- 範囲：DR-PUBG-5-8（product gate の結び方）、-4（W1）、-6（解除条件）、-7（V0・V4）の実装と、V0 の試験（`discover_all` の封じ込めは入れない。判断 7）。W2（需要からの wake）と main の TS は PR-2。registry の production 表、policy の行の実体、定数の切替、文言は入れない（PUB-G の PR）。画面での知らせは無い（process-local の記録と code だけの log のまま）。

**判断 1：product gate の型は const generic の token にする**
- `grimodex-db` に `Nir1GraphProductPublication`（`pub`、field は private、zero-sized）を置く。生成は `from_const::<const PUBLISHED: bool>() -> Option<Self>` だけで、`PUBLISHED` が true のときだけ `Some`。const generic の引数は compile 時の定数でなければならないので、runtime の値・DB の内容・IPC の値・環境変数からは作れない。
- gate（`Nir1GraphIndexBuildGate`）の生成経路は DR-PUBG-5-8 の 4 つのまま（`closed`、`from_journey_seam`、`from_product_publication(token)`、`open_for_test`）。cycle と discovery に渡す値は、seam と product の少なくとも一方が開いているときに開く合成 `for_launch(config, product)` で作る。これは新しい生成経路ではなく、2 経路の OR である。invalid な seam は今までどおり gate の前の `effective_maintenance_coordinates` で拒否される。
- Native の `nir1_graph_product.rs` に `maintenance_product_publication()` を 1 つだけ置く（本体は `from_const::<{ PRODUCT_GRAPH_PUBLISHED }>()`）。`publication_open()` にも eval feature の cfg にも結ばない。`cfg(feature)` の impl の外の自由関数にし、pin 済みの `FIXED_BODIES` と `PRODUCT_GRAPH_PUBLISHED` の検査に触れない。
- 型は「const からしか作れない」を crate をまたいで強制できない（`from_const::<true>()` と書けば作れる）。そのため、検査を pin されていない場所に置く（DR-PUBG-5-8 の 3）。Native の Rust 試験で次を確かめる。
  - 構築箇所が `nir1_graph_product.rs` の `maintenance_product_publication` の 1 か所で、引数が `{ PRODUCT_GRAPH_PUBLISHED }` であること（src の走査）。
  - `publication_open_for_test` を開いても token が `None` のままであること。
  - eval feature の build でも `None` であること（`cargo check --features nir1-graph-eval`）。
- 変えない：`native-architecture.mjs`、`scripts/quality/nir1-graph-eval/`、`scripts/quality/nir1-graph/`。

**判断 2：公開 API は足すだけにする**
- 既存の `nir1_graph_index_build_wakes_main_discovery`、`discover_maintenance_project_for_main`、`run_system_work_cycle_with_nir1_graph_runtime` は無変更で残し、`_with_product(.., Option<Nir1GraphProductPublication>)` の変種を足す。旧関数は product なし（`None`）の変種に委譲する。Native の `discover_all` も同じ形（4 引数形は `cfg(test)` の wrapper）。
- 理由：既存の B-ROUTE／BSEAM の試験を無変更で通す（DR-PUBG-5-1 の検証条件）。
- 増やさない：skip reason、`MaintenanceProjectDiscovery` の variant、wire の field、理由の code。閉じた集合への追加は委任の外（DR-PUBG-5-10）。

**判断 3：discovery の wake（W1・V4）**
- product gate が開いているとき、seam と同じ規則で `GraphIndexBuildWake` を返す。
  - durable な連鎖が idle なら wake（W1）。
  - 制御なしの discovery が typed な `context-unavailable` で失敗したら wake（V4）。
  - BeforeCutover と follow-up は wake しない。
- product の token が `None`（今の製品）のとき、挙動は今のまま（判定の SQL 0、wake 0）。

**判断 4：cycle の gate**
- `Nir1GraphCycleContext` の gate を `for_launch(ci_config, product)` で作る。gated route の dispatch の再検査（`dispatch_enabled_work`）は変えない。gate が閉じていれば、接続を取る前に拒否する。

**判断 5：解除条件は変えず、試験で固定する。記録の上限は置かない**
- 解除条件（成功、tuple の変化〔A2 の watermark を含む〕、runtime epoch の変化、process の再起動）は変えない。
- 試験で固定するもの：同じ入力の拒否は、判定の SQL（PK・EXISTS・MAX の読み）だけで `RefusedUnchanged` を返し、prepare に入らない（test hook の `BeforePrepare` が発火しない。SQL の予算を最小にしても判定が通る）。product gate でも同じ。
- process-local の記録の上限（DR-PUBG-5-6 が実装時に決めるとしたもの）：新しい数値は置かない。
  - 根拠：key は (owner, project) で、新しい owner の store は古い owner の記録を全て捨てる（既存）。よって記録は live な authority の project 数で有界で、project は利用者データ（SQLite の行）として既に有界。
  - 上限を置いて古い記録を捨てると、拒否の記憶を失って最悪 180 s の build を繰り返す側に倒れる。そのほうが悪い。
  - renderer が誘発できる頻度の上限は、W2 の最短間隔で置く（PR-2）。

**判断 6：V0 を試験に固定する（(i) の前提）**
- 形：binding を 1 つ publish した project に、(a) 保存 edge 8,194 行か、(b) 候補 2,065 件を足して binding を dirty にし、B を 1 回 dispatch して Refused にする。対照は binding なしで候補 2,065 件。行は SQL で直接足した合成データ。
- 固定する現状：
  - (a) Verify 自身が容量で落ち（`capacity-exceeded`）、再試行不可（Contract）で、durable な Finding（`narrative-maintenance-failure:dependency-verify:…`）が 1 件出る。以後の wake では新しい Run が作られない。
  - (b) 制御なしの discovery は `context-unavailable` の Err を返し続ける（gate が閉じているとき）。Run も Finding も増えない。
  - 対照：binding がなければ Idle で、Err も Finding も無い。
- gate の開き方は seam と product（token）の両方で走らせ、同じ結果になることを確かめる（V0 が未確認とした点）。
- (iii) を実装するときに、この試験は意図して変わる。変更はその契約の確認の後に行う。

**判断 7：`discover_all` の project ごとの Err の封じ込めは、別の PR・DR に切り出した（統合者の判断、2026-11-17）**
- 経緯：実装者の最初の案（`d5785dc8`）は、`discover_all` の project ごとの Err を allowlist（`ContextUnavailable` と `CapacityExceeded`）で封じ込めていた。read-only の点検（`05-impl-check.md` の M1）が、これは gate の外で今の製品の既定の挙動を変えると指摘した。
- 理由：定数が false の間、PR-1 と PR-2 は「既定の挙動と等価」でなければならない。封じ込めはエラーの扱いと wake outbox の ACK という今の製品の挙動を変える。
  - (a) 複数 project の workspace で 1 つが `ContextUnavailable`（DR-BSEAM-5）で失敗するとき、以前は discovery 全体が Err（main は warn、最大 3 回の再 discovery、wake outbox は ACK されない）。封じ込めると成功扱いで他の project の work が返り、wake outbox が ACK されて、失敗した project の wake が消費される。
  - (b) 「成功した project が 0 のときだけ Err」の規則は Idle の project を成功に数える。`default-project` を残す・足す形で実質 2 project 以上の workspace は普通にあり、そのとき失敗する project が 1 つでも Err が消える。「単一 project の挙動は今のまま」は project が本当に 1 つのときだけ成り立つ。
  - (c) 失敗は `tracing::warn`（code のみ）にしか残らず、main には見えない。
- 切り出し先：枝 `claude/pubg-5-containment`（PR-2 の上の 1 commit。push せず、PR も作らない）。記録は同枝の DR-PUBG-5-15。そこで、点検の R1（discovery の段で観測していない `CapacityExceeded` の腕を外す）と R6（実際の multi-project DB で、sealed binding による `ContextUnavailable` が allowlist に当たることを固定する試験）も直す。
- PR-1 から外したもの：Native の `discover_projects`（project ごとの discovery を差し替える分割）と `contained_failure_code`、db の `is_project_local_discovery_failure` とその公開、それらの試験。`discover_all_with_product` は、product が `None` なら従来の `discover_all` と同じ挙動で、project ごとの Err は今までどおり `?` で伝播する。
- V0 の観測の程度（実装の後の訂正。この記録は残す）：main の（制御なしの）discovery の段で実際に観測した Err は `ContextUnavailable` だけ（V0 の (b)、gate が閉じているとき。DR-BSEAM-5 の Chronicle も同じ型）。`CapacityExceeded` は cycle の Verify の Err として観測したもので、discovery の段では観測していない。`05-v0.md` が (a) で「1 回目の discovery が Err」とした記述は、probe（`9b510f50` の `v0_wakes`）が discovery と cycle の Err を同じ「ERR」で出していたための読み違いと見る（呼び出し列に出た `verify_dependency_graph_snapshot` も Verify の Run の経路）。
- 封じ込めを入れるかどうかは、その枝を PR にするときに統合者が決める。PR-1・PR-2 の merge の条件ではない。

**信頼境界と threat model の差分（PR-1）**
- 変わらない：actor、防御、受信先、保存、受入れ。renderer は B を名指しできず、新しい IPC・`#[napi]` の入口は無い。token は const false から `None` なので、製品の既定では wake 0、B の判定の SQL 0、Graph の surface への書込み 0。
- 新しい攻撃：無い。product gate は const だけから作られ、renderer・DB の内容・環境からは開かない。renderer が seed 付きの begin で B の build を誘発する経路（DR-PUBG-5-10）は PR-2（W2）で足す。
- 封じ込めは入れない（判断 7）ので、discovery の fail-closed の範囲は今のまま。

**要レビュー（レビューで見てほしい点）**
1. 判断 1 の検査が src の走査であること（型で const に縛れない代わり）。
2. 判断 5 で記録の上限を置かない根拠。

**実装の結果（PR-1、2026-11-17。枝 `claude/pubg-5-pr1`。PR は作らず、merge は次の S4（9 回目）の後）**
- commit：`6376de4d`（この DR）、`8d8dd908`（db：token・gate・wake・V0 と解除条件の試験）、`d5785dc8`（Native：token・封じ込め・試験。封じ込めは、点検の後の commit『封じ込めを外す』で外した）。
- 公開した名前：db に `Nir1GraphProductPublication`、`nir1_graph_index_build_wakes_main_discovery_with_product`、`discover_maintenance_project_for_main_with_product`、`run_system_work_cycle_with_nir1_graph_runtime_and_product`。Native に `maintenance_product_publication()`（`nir1_graph_product.rs`）と `discover_all_with_product`。既存の関数は無変更。
- 判断との差：
  - 判断 1 の検査 (c) は、`--features nir1-graph-eval` で Native の試験を走らせて確かめた（token は `None` のまま）。
  - 判断 5 の試験は、同じ入力の拒否が試験 hook の `BeforePrepare`・`BeforeValidation` に届かず、SQL の使用量が拒否した試行の 1/10 以下であることで固定した（測った値：拒否した試行は約 26 万 step、同じ入力の判定は約 280 step。拒否した試行が 1 万 step 以上であることも assert して、比較が空振りしないようにした）。seam と token の両方の gate で走らせた。
- V0 の観測との差：`05-v0.md` は (a)（保存 edge 超過）の 1 回目の discovery が Err だったとしたが、この試験では 1 回目の wake は「discovery が Verify の work を返し、cycle の Verify が `capacity-exceeded` で失敗する」。dev probe の `v0_wakes` は discovery と cycle の Err を区別せずに出していたので、05-v0.md の記述は cycle の Err を discovery の Err と読んだものと見る。`complete_registered` を前後に読む、`judge` を先に呼ぶ、discovery だけを先に呼ぶ形でも discovery の Err は再現しなかった。固定した試験は、どちらの形でも成り立つ不変条件にした（失敗が capacity-exceeded であること、Verify の Run が 1 件 failed、Finding が 1 件、その後は新しい Run が無いこと、discovery が Err のときは project 単位の失敗であること）。
- 検証（すべて `CARGO_BUILD_JOBS=4`、node は 22）：
  - `grimodex-db --lib` の `nir1_graph_index_maintenance`（41 件）と `maintenance`・`nir1_entity_relation_index`・`nir1_capacity`・`restore`（440 件）。`--test narrative_maintenance_contracts`・`narrative_maintenance_route_registry`・`narrative_maintenance_runtime`・`narrative_maintenance_lifecycle_runtime`（4＋1＋30＋9 件）。すべて成功。
  - Native `--lib` 全件（816 件成功、7 件 ignore）。`--features nir1-graph-eval` で `narrative_maintenance::tests` と token の 2 試験（16 件成功）。
  - `cargo clippy --all-targets -- -D warnings`：`grimodex-db`（既定 feature）と Native は成功。`--features nir1-material-diagnostics` は、PR-1 が触れない file（`nir1_graph.rs`、`nir1_graph/input.rs`、`nir1_graph_memory_diagnostics.rs`）の指摘 11 件（lib。lib test は 7 件）で失敗する。base（`87937140`）で同じ command を回して同じ件数・同じ file であることを確かめた（PR-1 の変更の指摘は無い）。
  - pin 済みの `native-architecture.mjs` を変えず、`runArchitectureChecks` を作業 tree に対して実行して違反 0。
  - 検証の追補（点検の後。封じ込めを外した head。node は 22、`CARGO_BUILD_JOBS=4`）：上の件数は封じ込めを外す前の値で、外した後は次の値に替わる。`grimodex-db --lib` の `nir1_graph_index_maintenance` は 40 件成功（allowlist の単体試験 1 件を外した）。Native `--lib` 全件は 812 件成功・7 件 ignore（封じ込めの試験 4 件を外した）。`--features nir1-graph-eval` の `narrative_maintenance`・token の 2 試験は 72 件成功。clippy（`--all-targets -- -D warnings`）は Native と db で成功。db の試験 file の未使用 import は clippy が見つけたので直した。
- PR-2 と PUB-G への引き継ぎ：
  - 定数を切り替えると discovery の応答に `wakeProjectIds` が載る。main は `acceptGraphIndexBuildWakes` が無いとその応答を拒否する（`normalizeDiscoveryResponse` の `allowedKeys`）。PR-1 だけで定数を切り替えてはならない。main が product の gate でも `wakeProjectIds` を受ける変更は PR-2（W2 と同じ範囲）で行う。
  - (iii)（拒否のときに binding を退かせる）の契約の起案は、この PR とは別。実装されると V0 の試験の期待が意図して変わる。
- 点検（read-only、`05-impl-check.md`）の反映：
  - M1：判断 7 の封じ込めを、この PR から外して別の枝に切り出した（判断 7）。外した後の Native `--lib` と db の試験は、下の「検証」の追補に記す。
  - R7（既知のずれ）：凍結した S2（`observation-prep.v1.json`）の prose にある `nir1_graph_product.rs:78` の行番号の参照（`docs/plans/nir1-final-request-eval-proposal-4-draft.md` の 79 行にも同じ参照がある）と、`scripts/quality/nir1-graph-eval/constants.mjs:53` のコメントの `nir1_graph_product.rs:94` は、この PR の `nir1_graph_product.rs` の追加（挿入 12 行、削除 1 行で、純増 11 行。64 行目付近）で実際の位置から 11 行ずれる（`:78` は `:89`、`:94` は `:105` になる）。S2 は凍結されていて変えられないので直さない。これらの行番号を検査する script は見つからなかった。ずれても pin の検査には影響しない。
- レビュー（Opus、read-only、`05-impl-review-opus.md`）の反映（2026-11-17）：
  - M-1（必須）：token の構築箇所の走査が、最初の `#[cfg(test)]\nmod ` で file を切るため、Native の `lib.rs` は 17 行目より後ろ（token を gate へ渡す 2 か所を含む）を見ていなかった。走査を、行頭の `#[cfg(test)]`（後ろに他の attribute が続いてもよい）の次が `mod <名前> {` の module だけを、同じ indent の `}` まで除く形に直した。`mod <名前>;` の宣言は何も除かない。`lib.rs` のように試験 module の後ろに production code が続く file も走査できる。その他の `#[cfg(test)]` の item は走査に残す（過剰に報告する側）。
  - 走査の本体を helper（`without_inline_test_modules`、`token_construction_lines`）にして、`lib.rs` の形を模した文字列を同じ関数に通す試験（`the_token_scan_sees_production_code_after_test_modules`）を足した。外部 file の試験 module の宣言、inline の試験 module とその後ろの production、入れ子の試験 module、コメント行、定義行（`pub struct`・`impl`）を含む。
  - 注入の確認：`lib.rs` の `discover_all_with_product` の呼出し（旧 8677 行）の引数を一時的に `from_const::<true>()` に書き換えて走査の試験が落ちる（その行が左辺に出る）ことを確かめ、戻した。直す前の走査は、同じ注入を検出しない（レビューの replica）。
  - m-2：走査の対象に、`{ _private: () }` の 1 行の struct literal、型名と同じ行の `zeroed`／`transmute`／`assume_init`／`MaybeUninit`／`Default` を足した。型の定義行（`pub struct`・`struct`・`impl`）は除く。許す構築箇所は、Native の `nir1_graph_product.rs` の 1 か所に、型自身の constructor（`grimodex-db` の `from_const` の中の `Some(Self { _private: () })`）を足した 2 か所になった。複数行の struct literal と、型名を別の行に置く `zeroed` は字句の走査では見えない（`syn` による parse が要る。field が private なので、書けるのは `grimodex-db` の同じ module の中だけ）。
  - m-3：解除条件の試験の確認（`judge`）が `open_for_test` の gate で回っていたので、launch ごとの gate（seam と product token）で回す helper（`judge_with_gate`）に替えた。結論は変わらない（gate は開いているかどうかの bool だけ）。
  - R-C（取り込み後の compile・試験・clippy の記録）：master を取り込んだ後の、この反映の head で走らせた（検証の追補 2）。
- 検証の追補 2（レビューの反映の後の head。node は 22、`CARGO_BUILD_JOBS=4`）：
  - Native `--lib` 全件：812 件成功、7 件 ignore（exit 0）。token の走査の 2 試験（新しい `the_token_scan_sees_production_code_after_test_modules` を含む）はこの中で成功。
  - 走査の効き：`lib.rs` の `discover_all_with_product` の呼出しの引数を一時的に `from_const::<true>()` にすると、`the_product_token_has_one_production_construction_site` が落ち、`lib.rs` のその行が左辺に出る（戻した）。
  - db `--lib` の `nir1_graph_index_maintenance`：40 件成功（exit 0）。
  - clippy（`--all-targets -- -D warnings`）：db（既定 feature）と Native で成功（exit 0）。
  - `verify:quality`（node 22）：成功（exit 0）。
- 未確認：
  - 1 回目の wake の cycle が `capacity-exceeded` の Err を返す（V0 の (a)、(b) の open gate）。複数 project の work を載せた 1 つの request が、1 つの project の Verify の失敗で一緒に落ちるかは見ていない。`discover_all` の範囲の外。
  - Native の試験が mac／Win の CI で走るかは確かめていない。token の構築箇所の走査は、root と path と改行を正規化してあるが、Linux 以外では走らせていない。

### DR-PUBG-5-14：PR-2（main と Native、閉じた gate）の実装判断（2026-11-17）

- 位置づけ：PR-2 に入る前の判断と信頼境界の記録。この判断を残す commit ではコード・policy・定数を変えない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 委任と停止点：DR-PUBG-5-13 と同じ（C-product の worker／owner／lifecycle の技術判断、委任の内の技術的な threat model の改訂）。枝 `claude/pubg-5-pr2`（基点は PR-1 の head `d8f06dad`）に push するが、PR は作らず merge しない。merge は次の S4（9 回目）の後（DR-PUBG-5-11 の 1）。
- 範囲：W2（需要からの wake）、coalesce・最短間隔・dispose、main が product でも `wakeProjectIds` を受ける変更（PR-1 の引き継ぎ）、CP2a-D47 の hook が B の publish の後に届くことの試験（(j)）。入れないもの：registry の production 表、policy の行の実体、定数の切替、文言、(iii)、W3、定期の timer、画面での知らせ。
- 材料：PR-1 の引き継ぎ（DR-PUBG-5-13 の末尾）、precheck §3.3・§4・§5、`ipc.ts` と `nir1_graph_product.rs` の読み（下の「読んで確かめたこと」）。

**読んで確かめたこと（`d8f06dad`）**
- main は `related_scenes_begin` の応答から `ir`（pending の ticket）だけを読み、`graph` の理由は読まない（`ipc.ts` の ticket 追跡）。`related_scenes_graph_continue` の応答は main が読まず、project ID も持たない。
- `registration-unavailable` は owner thread の prepare の失敗（worker が canonical registration を `Ok(false)` で拒否し、`CQueryFailure::StartupRegistrationRefused` に分類される）で生まれる。Related Scenes は `begin_deferred` を通り、最初の begin は `Pending`（または `warming`）を返す。begin が理由を即答するのは、5 回失敗して Suspended になった後だけ。
- B の publish は `Completed` を返し、cycle が `work_completed` を呼ぶ（`maintenance_runtime.rs` の `mark_completed`）。refused・validated・skip は `CompletedWithoutFinalization` で `work_noop_completed` に落ち、hook は呼ばれない。hook は `lib.rs` の `work_completed` の先頭の文（source の試験で固定済み）。

**判断 1：需要は Native の owner で観測する。対象は `RegistrationUnavailable` だけ**
- begin の応答（main の `ipc.ts`）では観測しない。理由は上のとおり、最初の begin は理由を返さず、main は読まず、project ID も持たない。renderer が受ける応答の読みに依存しない。
- 出す場所は 3 か所で、いずれも理由が `RegistrationUnavailable` のときだけ。
  1. `build_worker` の prepare の失敗（効果が `Count` のもの）。
  2. `demand` の Suspended の枝。
  3. `demand_deferred` の Suspended の枝。
- epoch の照合（点検 R2 の反映）：event に binding は載せない（payload は project ID だけ）ので、workspace の切替の後に終わった旧 workspace の refusal が、新しい workspace の同名の project（`default-project` など）の wake にならないよう、Native の側で通知の前に epoch を照合する。`build_worker` の prepare 失敗の枝は、`edge_or_closed(&shared, epoch)` が真なら通知しない（試験：lifecycle edge の後に終わる refusal は通知 0、edge なしの対照は 1 回）。`demand`・`demand_deferred` の Suspended の枝は、lock の下で `ready_generation` の一致を見てから通知するので、この問題の外。残る隙は、照合と emit の間に edge が入る場合で、main が受信時の live binding に束縛するため、害は B の判定 1 回（`RefusedUnchanged` なら SQL だけ）に有界。
- 2 と 3 を落とすと、5 回失敗して Suspended になった slot は、B の publish が唯一の出口なのに B を起こす源が無くなる（(j)・(k) の「W2 が Suspended を解く」が成り立たない）。
- 名指す project（レビュー R-A の反映）：Suspended の slot は project を持たない。そこで、slot が Suspended になったときの refused project（`build_worker` の key の project）を `Phase::Suspended` に記録し、2 と 3 は「需要した側」ではなく、その refused project を名指す。同じ workspace の別の project の begin が Suspended の slot に当たっても、B が直せるのは refusal を起こした project なので、そちらを起こす。需要した側の project は名指さない（その project の B は、この refusal と関係が無い）。記録が無い（test が組んだ phase）ときだけ、需要した側へ戻す。単一 project の挙動は変わらない。
- 広げない：`Stale`・`Warming`・`Busy`・`Timeout`・`Failed`・`WorkerUnavailable` は出さない。頻度が桁で変わる（`Warming`・`Busy` は編集と query のたびに出る）。要レビュー。
- 読みの注記（要確認）：`StartupRegistrationRefused`（worker の registration が `Ok(false)`）を「B の binding が current でない」の代理として扱う。`Ok(false)` になる全原因は追跡していない。B が skip した（current だった）場合、wake の費用は B の判定の SQL（PK・EXISTS・MAX の読み）だけで、最短間隔（判断 5）で有界。
- owner の `unserved` 集合は重複抑止に使わない。`unserved` は READY まで再通知されないので、「次の需要が再試行を起こす」が壊れる。抑止の正本は main の 1 か所（判断 5）。

**判断 2：gate は const の token だけに結ぶ**
- 通知の入口（owner の `request_index_build`）の先頭で、token（`maintenance_product_publication()`）が `None` なら何もしない。`publication_open()` にも seam にも結ばない（DR-PUBG-5-8 の 1）。CP-4 の eval build や unit test が `publication_open()` を開いても、B の wake は開かない（Q2b の回答）。
- const が false の間：event 0、main の timer 0、wake 0。
- 試験で固定する：owner の test gate を開いても通知 0、`--features nir1-graph-eval` でも通知 0。開いた token は試験 module（`*_tests.rs`）が `cfg(test)` の field に注入する。production の構築箇所は 1 つのまま（PR-1 の走査の試験が固定。`from_const` は production code に増やさない）。

**判断 3：通知は observer-only の event。新しい `#[napi]` も renderer 向けの入口も足さない**
- channel は `narrative-maintenance:graph-index-demand`、payload は `{"projectId": …}` だけ。Native は既存の `EventQueue` に emit する。
- `epoch-rotated` と同じ扱い：main の `handleBackendEvent` は observer にだけ渡し、renderer へ broadcast しない。renderer 向けの allowlist（`ipcContract.ts`）にも入れない。
- main は payload を厳格に検証する：Record で、key は `projectId` だけ、文字列、空でなく、前後に空白がなく、NUL を含まず、長さは上限以下。違えば warn（固定文言。ID は出さない）して捨てる。
- 閉じた理由の集合（Native の 14 個、renderer の allowlist）は変えない。

**判断 4：main の bootstrap は常に `acceptGraphIndexBuildWakes: true` を渡す（要レビュー）**
- main が product の gate を知る経路は、main 側の定数（独立の switch で DR-PUBG-5-8 の 2 に反する）か、新しい `#[napi]` の getter（「足さずに済まない場合」に当たらない）のどちらかになる。どちらも採らない。
- const が false の間、Native は discovery の応答に `wakeProjectIds` を載せず（PR-1 の試験）、判断 3 の event も出さない。よって製品の挙動は変わらない。
- 外れるもの：「seam の B の launch 以外では、`wakeProjectIds` を載せた応答を main が拒否する」独立の防御（DR-BSEAM-1）。残る防御は Native 側の gate（discovery の wake の判定、cycle の dispatch の再検査、token）。
- coordinator の option `acceptGraphIndexBuildWakes` と、option が無いときの拒否の試験は残す（coordinator 単体の契約）。bootstrap の既存の試験の期待（seam の B 以外は第 3 引数なし）は、意図して変える。

**判断 5：main の需要 wake は、discovery の chain の timer・世代・理由・ACK に乗らない小さな状態にする（rediscovery の budget は chain と共有する）**
- 既存の discovery の chain の timer・世代・wake reason・outbox の ACK（`armTimer`、`chainGeneration`、`lastWakeReason`）には乗せず、触れない。ただし rediscovery の budget は chain と共有する（次の項）。5 つ目の wake reason は足さない。`scheduler.requestGraphIndexBuildWakesWithBinding` を直接呼ぶ。
- ただし 1 点だけ chain とつながる（実装の後の訂正。レビューの前に確かめた）：bootstrap の `onCycleAccepted` は、受理された cycle のたびに `coordinator.requestRediscovery()` を呼ぶ。需要の wake の cycle も受理されれば同じで、chain が生きている間は rediscovery を 1 回（上限 3 回のうち 1 回）消費する。chain が終わっていれば（`lastWakeReason` が null）no-op。W1（discovery の `wakeProjectIds`）と、seam の B の wake も同じ既存の配線。この配線は変えない（変えるなら、wake だけの cycle では rediscovery を呼ばない、などの別の判断になり、cutover の準備の chain の既存の挙動に触れる）。試験で今の挙動を固定した（要レビュー）。
- 状態は (binding, project) ごとに `{ timer, lastFiredAtMs, firedInRun }`。
- 受信：未 dispose、option が true、payload が妥当、current binding が取れる、のときだけ。binding は受信時に束縛し、key の一部にする。
- 合流：key に pending の timer があれば何もしない。最短間隔の内側の需要は捨てずに、`lastFiredAt + interval` の 1 つの timer に畳む（末尾の 1 回に合流）。捨てると、直後の需要が受けられず liveness を失う。両端（間隔の内側で合流する、間隔の後で新しく発火する）を試験する。
- 間隔：発火から数えて `interval(k) = min(2 s × 2^(k-1), 60 s)`（k は直前の発火から 60 s 以内に続けて発火した数）。静止が 60 s を越えたら k を 0 に戻す。初回は遅延 0。数値は Graph owner の backoff（CP2a-D14）にそろえた初期案で、実測で決めて記録する。時計が戻ったら elapsed を 0 とみなして再 anchor する（DR-MPS-2 と同じ）。
- 上限：追跡する key は最大 8（owner の `MAX_UNSERVED_PROJECTS` と同数）。満杯なら新しい key の要求を捨てる。古いものを追い出す形にしない（追い出すと、renderer が project ID を回して最短間隔を迂回できる）。pending が無く、最後の発火から 60 s の静止を過ぎた key は、次の受信のときに lazy に捨てる（timer は足さない）。
- 発火：timer の callback で、未 dispose と、live な binding が key の binding と同じことを確かめてから呼ぶ。不一致・例外は捨てる（自動の再試行は無い、永続しない）。
- lifecycle：dispose と `workspace:opened`（restore を含む）で、全 timer を clear して全 key を捨てる。dispose の後は受けない。
- 観測：timer の arm・clear・発火で `noteMutation()` する。`getQuiescenceState` と `onDiscoverySettled` の `timerScheduled` に含める。
- DR-PUBG-5-9 の matrix との差：matrix は「最短間隔の timer は scheduler が持つ」だったが、実装は coordinator が持つ。scheduler の queue は work の identity と delivery の記録、preempt の backoff の state を持つので、需要の間隔制御を持ち込むと干渉する。coordinator は binding の検証と dispose の lifecycle を既に持つ。scheduler の `requestGraphIndexBuildWakesWithBinding` は (project, binding) の Map で既に coalesce するので、その手前に一段の間隔制御を足すだけになる。

**判断 6：(j) の試験**
- db：開いた gate（token）の下の実 cycle で、B の publish が `work_completed` を B の item で 1 回呼ぶこと。refused・validated・skip・閉じた gate では `work_completed` を呼ばず、`work_noop_completed` に落ちること（hook が呼ばれないこと）。
- Native：Suspended の理由が `RegistrationUnavailable` のとき、B の item で hook を呼ぶと Empty に戻り、再試行が 1 回になる（CP2a-D49）こと。
- 全 process の journey（実際の Electron で B が publish されて Suspended が解けること）は PUB-G の前の dev の journey で確かめる。この PR では確かめていない。

**信頼境界と threat model の差分（PR-2）**
- 変わらない：actor、受信先、保存、受入れ。renderer は B を名指しできず、新しい IPC・`#[napi]` の入口は無い。event は main 専用で、payload は project ID だけ。
- 新しい攻撃（DR-PUBG-5-10 の具体化）：untrusted な renderer が seed 付きの begin を繰り返すと、owner の prepare の失敗と Suspended の begin が event になり、main の B の wake（B の判定または build と、その project の `durable-wake` discovery 全体）を誘発できる。renderer が選べる project は、workspace に実在するものに限られる（begin は `read_retrieval_scene_source` が project と scene の組を読めなければ失敗し、owner に届かない。読んで確かめた）。実在しない ID で表を埋める攻撃は成り立たない。
- 受理された wake の cycle は、chain が生きている間、rediscovery の budget を 1 回消費する（判断 5）。renderer が需要を続けると、before-cutover の chain の budget（3 回）が早く尽き、Freshness の NOT_READY による再開（5 s から 60 s の cooldown）まで cutover の準備が遅れうる。失敗や永続の変化ではなく遅れで、間隔（判断 5）で有界。この結合は PUB-G の切替の前に決める項目として残す（下の「切替の前に決める項目」）。
- 防御：
  1. owner の既存の rebuild window・backoff・Suspended。
  2. main の key ごとの pending 1 つ、最短間隔 2 s から 60 s、key の上限 8、満杯なら捨てる。頻度は実装の列（0、+2、+6、+14、+30 s の 5 回、次は +62 s）で、最初の 60 s は key あたり 5 回。需要が持続する間の定常は key あたり 1 回／分。静止が 60 s を越えると run が 2 s から新しく始まるので、5 回の後に 60 s 止めて再開する形（5 回／90 s）が最悪で、約 3.3 回／分／key、8 key で最大約 27 回／分。reset の条件は変えない。B は single-flight と `RefusedUnchanged` で有界なので害は小さく、数値は PUB-G の前の dev の journey の実測で決める。
  3. B の attempt の上限（600,000,000 counts、180 s）と `RefusedUnchanged` の抑止。
  4. renderer は B を名指しできない。
  5. const が false の間は event 0。
- 受信先・保存：増えない。wake の cycle の失敗が既存の `persistDeliveryFailure`（scope `wake`）に乗る場合の書込みの回数は、最短間隔で有界（DR-PUBG-5-9 の error の行のまま）。
- 受入れ：製品の既定（const false）では、event 0、main の timer 0、wake 0、B の判定の SQL 0。

**切替の前に決める項目（PUB-G の PR の前。挙動は PR-2 では変えない）**
- **（DR-PUBG-5-17 で解決）** - 需要の wake の cycle が before-cutover の chain の rediscovery の budget を消費する結合（判断 5 の訂正）。PR-1 は BeforeCutover を fail-closed に保ったのに対し、需要の wake が chain の budget を減らせるのは不釣り合い。決め方の例：需要の wake の cycle では `requestRediscovery` を呼ばない（bootstrap の `onCycleAccepted` の配線の変更になり、cutover の準備の chain の既存の挙動に触れるので、別の判断）。
- wake の頻度の数値（間隔 2 s から 60 s、key の上限 8、reset の 60 s）は、dev の journey の実測で決める（R3）。
- Suspended の出口（R-A の残り。設計の変更が要る）：refused project の B が skip する（current）か `RefusedUnchanged` で publish が無いと、slot は Suspended のままで、出口は lifecycle の edge と再起動だけになる。これは単一 project でも同じ（DR の「`Ok(false)` の代理が外れる」場合）。直すなら、Suspended を project ごとにする、または需要の key が違えば Suspended を見ずに rebuild へ回す（owner の契約の変更）。別の project の B の publish が Suspended を解く挙動（逆向き）は、1 回の再試行（CP2a-D49）が空振りして Suspended に戻るので自己修復し、害は小さい。PR-2 では変えない。
- 旧 workspace の需要の event が新 workspace の binding で束縛される隙（R-B）：窓は、読みによる限り実質無い。理由と、確かめていない部分は下の「レビューの反映」に記す。残る極小の窓（owner thread が epoch の確認と emit の間で切替の全期間止まる場合）を閉じるなら、payload に owner の世代を載せて main で照合する（判断 3 の payload の変更）。PR-2 では変えない。

**要レビュー（レビューで見てほしい点）**
1. 判断 1：対象を `RegistrationUnavailable` だけにしたこと（`Stale` などへ広げない）と、その読み（`Ok(false)` を「binding が current でない」の代理にしたこと）。
2. 判断 4：main の独立した拒否が外れること（const が false の間は挙動が変わらない）。
3. 判断 5：key の上限 8 と「満杯なら捨てる」、末尾の 1 回への合流、timer を coordinator が持つこと（DR-PUBG-5-9 との差）。
4. 判断 2：`cfg(test)` の token の注入が、PR-1 の「構築箇所は 1 つ」の走査と矛盾しないこと。
5. 判断 5 の訂正：需要の wake の cycle が、bootstrap の `onCycleAccepted` を通して、生きている chain の rediscovery の budget を消費すること（既存の配線。変えていない）。cutover の準備の chain を、renderer の需要が間隔の範囲で早く尽きさせうる。

**実装の結果（PR-2、2026-11-17。枝 `claude/pubg-5-pr2`。PR は作らず、merge は次の S4（9 回目）の後）**
- commit：`05754538`（この DR）、`71cdf9bf`（main：event の観測・coordinator の需要 wake・bootstrap・試験）、`086a228d`（Native：owner の通知・event・試験、db：(j) の試験）。
- 公開した名前：Native に `GRAPH_INDEX_DEMAND_EVENT`、`GraphIndexDemandNotice`、`set_graph_index_demand_notifier`（`nir1_graph_product.rs`）、`graph_index_demand_notifier`（`state.rs`）。main に `NARRATIVE_MAINTENANCE_GRAPH_INDEX_DEMAND_EVENT`（`events.ts`）、`NARRATIVE_MAINTENANCE_GRAPH_DEMAND_*` の 4 定数と `narrativeMaintenanceGraphDemandIntervalMs`（`narrativeMaintenanceTriggers.ts`）。新しい `#[napi]` の入口・IPC の channel・wire の field・閉じた理由は足していない。`native-architecture.mjs` と `scripts/quality/nir1-graph-eval*/` は無変更。
- 判断との差：
  - 判断 2 の「`--features nir1-graph-eval` でも通知 0」：eval feature の cfg を使う試験は置けない（pin 済みの `native-architecture.mjs` の `eval-feature-allowlist` が、allowlist 外の file の eval の cfg と `_for_eval` を違反にする。置いた試験で確かめて外した）。代わりに、owner の gate が開いていて token が `None` の試験（`a_refused_registration_raises_nothing_while_the_product_token_is_closed`）を、同じ試験ごと eval feature の build でも走らせた（下の検証）。eval の flag で owner を開く形そのものは試験していない。
  - 判断 6 の db 試験：seam の gate では、B の publish が `work_completed` に 1 回届き no-op に落ちないことが既存の試験（`open_gate_cycle_builds_publishes_and_reader_is_available`）で固定されていた。足したのは、product の token の下で同じことと、validation・typed refusal・current な binding・閉じた gate では届かないこと。
  - 判断 5 の数値の動き（試験で固定）：持続する需要の下で、1 つの key の wake は 0、+2、+6、+14、+30、+62、+122 s（以後 60 s 間隔）。60 s の静止の後は直ちに発火し、run は 2 s から始まり直す。key の上限は 8、満杯なら新しい key は捨てる（60 s の静止の後は受ける）。時計が戻った場合も、発火済みの pair の掃除を再 anchor するので、表が埋まったままにならない（レビューの指摘で直した。試験あり）。
  - 判断 5 の chain との接続：production の bootstrap と実 scheduler の試験で、chain の最初の discovery が実行中のとき、需要の wake の受理が rediscovery を 1 回足す（discovery 1 回が 2 回）ことを固定した。chain が終わっていれば足さない（`narrativeMaintenance.electronRoute.test.ts`）。
- 検証（node 22、`CARGO_BUILD_JOBS=4`）：
  - Native `--lib` 全件：823 件成功、7 件 ignore（PR-1 の 816 に、新しい 7 件）。`--features nir1-graph-eval`：`narrative_maintenance::tests`・新しい 7 件・token の 2 試験の計 23 件成功。
  - 試験の効き（変異）：token の確認を外す、`build_worker` と `demand` の理由の絞りを外す、`demand_deferred` の絞りを外す、の 3 通りで、対応する試験がそれぞれ落ちることを確かめて戻した。
  - db `--lib` の `nir1_graph_index_maintenance`：42 件成功。
  - clippy（`--all-targets -- -D warnings`）：Native と db（既定 feature）で成功。
  - electron の vitest（`vitest.electron.config.ts`、`electron/main` と `electron/shared`）：103 files・2,434 件成功。`tsc -p electron/tsconfig.json` も成功（vitest は型を見ないので別に回した）。新しい coordinator の試験は 16 件、bootstrap の試験は意図して直した（全 launch で受ける）、end-to-end の経路（production の bootstrap、event bus、coordinator、scheduler）に 3 件。eslint は変えた file で base と同じ件数（base が持つ prettier・no-useless-assignment の指摘は直していない）。
  - pin 済みの `native-architecture.mjs`（`node scripts/quality/nir1-graph-eval/native-architecture.mjs`）：作業 tree で ok。
  - `verify:quality`（node 22）：成功。
- 点検（read-only、`05-impl-check.md`）の反映と検証の追補（点検の反映の後の head。node は 22、`CARGO_BUILD_JOBS=4`）：
  - M1：PR-1 から封じ込めを外した（DR-PUBG-5-13 の判断 7）ので、PR-1 の head（`251d811a`）を取り込んだ。R2：`build_worker` の prepare 失敗の枝で epoch を照合した（判断 1）。R3・R4・R5：DR を直した（防御の頻度の数字、切替の前に決める項目、DR-PUBG-5-12 の確認の 1 行）。`narrativeMaintenanceTriggers.ts` のコメントも直した（挙動は無変更）。
  - R7（既知のずれ）：この PR の `nir1_graph_product.rs` の追加（91 行）で、凍結した S2 の prose や `constants.mjs:53` のコメントの `nir1_graph_product.rs:NN` の行番号は、さらに実際の位置からずれる。S2 は凍結されていて変えられないので直さない（DR-PUBG-5-13 の実装の結果に同じ記述）。
  - Native `--lib` 全件：820 件成功、7 件 ignore（封じ込めの試験 4 件を外し〔812〕、PR-2 の新しい 7 件と R2 の試験 1 件を足した）。`--features nir1-graph-eval` の `narrative_maintenance`・token の 2 試験・`index_demand`：80 件成功。db `--lib` の `nir1_graph_index_maintenance`：41 件成功。
  - R2 の試験の効き：`edge_or_closed` の照合を外すと `a_refusal_that_ends_after_a_lifecycle_edge_asks_for_nothing` が落ちる（通知 1 件、期待 0 件）ことを確かめて戻した。
  - clippy（`--all-targets -- -D warnings`）：Native と db で成功。electron の vitest（`electron/main`・`electron/shared`）は 103 files・2,434 件成功、`tsc -p electron/tsconfig.json` は成功。
- レビュー（Opus、read-only、`05-impl-review-opus.md`）の反映（2026-11-17）：
  - R-A（推奨）：局所的に直した。上の判断 1 の「名指す project」のとおり、`Phase::Suspended` に `refused_project` を足し、Suspended の枝の 2 か所（`demand`・`demand_deferred`）が、需要した側ではなくその project を名指す。試験：`a_suspended_begin_of_another_project_names_the_refused_project`（project A の refusal で Suspended にした後、project B の `begin` と `begin_deferred` の event が A を名指し、B を含まない）。refused project の B が publish しない場合の出口は設計の変更なので、「切替の前に決める項目」に書いた。
  - R-B（推奨）：窓は、読んだ範囲では実質無いと見た。コードは変えず、試験も足していない（既存の `workspace:opened` で需要が消える試験が、同じ drain の順序を固定している）。根拠（読みによる。実行して確かめたものではない）：
    - 需要の event（E1）と `workspace:opened`（E2）は、同じ `EventQueue`（TSFN は 1 本、`max_queue_size = 0`）を通るので、E1 が先に emit されていれば main は E1 を先に処理する。E1 を emit する側は、`build_worker` では `edge_or_closed` の確認の直後、`demand`・`demand_deferred` では workspace operation の下にあり、切替が新しい authority を公開してから E2 を emit するまでの間に E1 を emit する経路は見つからなかった。
    - 切替で E2 が emit されるのは Native の open の中（`lib.rs` の `state.events.emit("workspace:opened", …)`）で、lifecycle が ready に戻る（`publish_workspace_lifecycle_from_workspace_off_runtime`）より前。binding の getter は、遷移の間は `None` か `WORKSPACE_SWITCHING` で捨てる。E1 と E2 が両方 queue に溜まっていれば、TSFN は 1 回の drain で順に処理し、E1 が作る `setTimeout(0)` は、同じ drain の中の E2（`clearGraphDemands`）より先には走れない。
    - 残る窓は、owner thread が `edge_or_closed` の確認から emit までの数命令の間で、切替の全期間（数百 ms 以上）止まる場合だけ。実用上は無いと見るが、止まらないことを保証する仕組みは無い。
    - 確かめていない：切替の経路が上のとおりであること（`open` と restore の 2 経路と、`discover` の経路までは追っていない）、TSFN の drain の挙動（Node の実装の読みであり、実測していない）、存在しない project の wake が cycle の FK で落ちた後に、retry と `persistDeliveryFailure` がどう終わるか。害の上限は、同名の project が新 workspace にあれば B の判定 1 回（`RefusedUnchanged` なら SQL だけ）という DR の記述のまま。存在しない project のときの終わり方は未確認。
  - R-C：PR-1 の新しい head（`f4dff667`）を取り込んだ、この反映の head で走らせた（検証の追補 2）。
  - m-1（直さない）：需要の event ごとに、合流の判定の前に同期の binding の getter（lifecycle の snapshot と workspace operation の lease を取り、失敗すると throw）を呼ぶ費用は、DR の「O(8) の lazy な掃除と map の参照」より重い。直さない理由：pending の timer がある key の判定を binding の読みより前にすると、binding が変わった後の需要（key が別になる）を落とす。頻度は Suspended の slot への begin（renderer の query の頻度）で、lease は短く、warn は固定文言で ID を出さない。測っていない（上の未確認のとおり）。
  - m-3：PR-1 の DR-PUBG-5-13 で、launch の gate で判定する helper にした（試験は PR-1 の側）。
- 検証の追補 2（レビューの反映の後。PR-1 の head `f4dff667` を取り込んだ head。node は 22、`CARGO_BUILD_JOBS=4`）：
  - Native `--lib` 全件：821 件成功、7 件 ignore（exit 0。820 に R-A の新しい 1 件）。`--features nir1-graph-eval` の `narrative_maintenance::tests`・`index_demand`・token：26 件成功。
  - R-A の試験の効き：`demand` の Suspended の枝を需要した側の project に戻すと、`a_suspended_begin_of_another_project_names_the_refused_project` が落ちる（戻した）。
  - db `--lib` の `nir1_graph_index_maintenance`：41 件成功。clippy（`--all-targets -- -D warnings`）：Native と db で成功。
  - electron の vitest（`electron/main`・`electron/shared`）：103 files・2,434 件成功。`tsc -p electron/tsconfig.json --noEmit`：成功。
  - `verify:quality`（node 22）：成功（exit 0。この追補を足す前の head `9d7d499e` で走らせた。この追補だけを足した commit では再実行していない）。
- 未確認：
  - 全 process の journey（実際の Electron で、registration が拒否された Graph の demand → event → B の wake → publish → Suspended が解ける、が一続きで起きること）。この PR は部品ごとに確かめた（owner の event、coordinator の wake、cycle の `work_completed`、owner の hook）。PUB-G の前の dev の journey で確かめる（DR-PUBG-5-11 の 2）。
  - worker の registration が `Ok(false)` になる全原因。「binding が current でない」の代理が外れるのは、B が skip しても registration が拒否される場合で、そのときの wake の費用は B の判定の SQL だけ（間隔で有界）。
  - 間隔の数値（2 s から 60 s、key の上限 8）の実測。初期案のまま。
  - Suspended の slot への begin のたびに event が出る頻度（renderer の query の頻度）。main の合流で wake は有界だが、event の受信と payload の検証は query ごとに走る（O(8) の lazy な掃除と map の参照）。
  - wake の cycle が失敗するとき、既存の `persistDeliveryFailure` への書込みの回数（V0 の (a) の状態では wake のたびに Verify の失敗が出る）。最短間隔で有界とした根拠は読みで、測っていない。
  - Native の試験と eval feature の試験が mac／Win の CI で走るか。
- PUB-G への引き継ぎ：定数を切り替えると、Native は discovery の応答に `wakeProjectIds` を載せ（PR-1）、registration が拒否された需要の event を出し（PR-2）、main は受ける（PR-2）。#5 の閉じた実装は、PR-1 と PR-2 で完了した。残るのは registry の production 表、policy の行の実体、定数の切替、文言、(iii)（Q1 の回答で起案）、W3（測ってから）で、すべて PUB-G の PR か別の lane。切替の前に、dev の journey で上の全 process の流れと、wake の頻度（B の build の回数、DB の取り合い、registration の窓）を測って記録する。

### DR-PUBG-5-15：`discover_all` の project ごとの Err の封じ込め（DR-PUBG-5-13 の判断 7 から切り出し。2026-11-17）

- 位置づけ：PR-1 の点検（`05-impl-check.md` の M1）で、封じ込めは gate の外で今の製品の既定の挙動を変えると指摘された。定数が false の間、PR-1 と PR-2 は既定の挙動と等価でなければならないので、統合者が封じ込めを PR-1 から外してこの枝に切り出した。枝 `claude/pubg-5-containment`（PR-2 の head の上の 1 commit。push せず、PR も作らない）。これは「既定を変える変更」なので、PR にして merge するには、統合者が差を明示して受け入れ、PR 本文と S4 の候補の開示に載せる必要がある（PR-1・PR-2 の merge の条件ではない）。
- 委任と停止点：DR-PUBG-5-13 と同じ（C-product の技術判断）。コード・policy・定数の変更は、封じ込めと、その試験だけ。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 規則（DR-PUBG-5-13 の判断 7 の元の案から、R1 で allowlist を狭めたもの）：
  - 対象は、BeforeCutover でない wake（open・restore・epoch）の project ごとの discovery だけ。BeforeCutover は fail-closed のまま `?` で返す（失敗した project を「work なし」にすると cutover が進みうる）。
  - 封じ込めるのは、typed な `ValidationTerminated` の `ContextUnavailable` だけ（project の状態で決まり、再試行しても変わらない。V0 の (b)、DR-BSEAM-5）。判定は `grimodex-db` の `is_project_local_discovery_failure`（`is_context_unavailable_termination` に委譲）。
    - 追記（GDV/1、DR-PUBG-5-16。5-15 の判断は変えない）：GDV/1 の後は current な sealed binding の形（DR-PUBG-5-16 §3）。V0 (b) の形では discovery は失敗しない。
  - 他は全て今までどおり伝播する。preempt、cancel、timeout、closed、workspace-generation-changed、busy・locked などの retryable、未知の SQL 失敗、`CapacityExceeded`。
  - 封じ込めた project は「work なし」として返す。1 つも成功した project がなければ（全て封じ込め）、最初の Err を返す。log は code だけ（`context-unavailable`。本文・project ID・path は出さない）。
- R1（点検の反映）：`CapacityExceeded` の腕を外した。main の discovery で `CapacityExceeded` が Err になる経路は、読んだ範囲で無い（`validate_discovered_verify_outcome` の capacity は `is_maintenance_control_or_cleanup_error` から外れていて `Err(_) => verify_work` になる。candidate の超過はその前に ContextUnavailable で止まる）。観測より広く fail-closed を緩めていた腕を外した。追いきれていない `?`（`evaluate_completed_run_skip_with_control` など）が `CapacityExceeded` を Err で返す経路は、全部は追っていない。見つかったら、その段で観測してから allowlist に足す。
- R6（点検の反映）：db の試験を 1 本足した（`a_real_sealed_binding_failure_is_project_local_and_the_other_project_still_discovers`）。project が 2 つの実際の DB で、V0 (b) の状態（binding を publish した project に候補 2,065 件を足して dirty にした）の project の discovery が、実際の sealed binding による `context-unavailable` で失敗し、それが allowlist に当たることと、もう 1 つの project の discovery が成功する（その project の work が返る）ことを固定する。Native の `discover_all` を通した試験ではない（Native の試験は、project ごとの discovery を差し替えて規則を固定している）。
  - 追記（GDV/1、DR-PUBG-5-16。5-15 の判断は変えない）：GDV/1 の後は current な sealed binding の形（DR-PUBG-5-16 §3）。V0 (b) の形（dirty な sealed binding に候補を足した形）では discovery は失敗しない。この試験は current な sealed binding の形に書き換えた。
- R7 の 1 点目：log の code は、allowlist が 1 種になったので固定の `context-unavailable`（chain の最初の `ValidationTerminated` を見る `contained_failure_code` は外した）。
- 今の製品に効く差（要レビュー。DR-PUBG-5-13 の判断 7 の理由と同じ）：
  - (a) 複数 project の workspace で 1 つが `ContextUnavailable`（DR-BSEAM-5）で失敗するとき、以前は discovery 全体が Err（main は warn、最大 3 回の再 discovery、wake outbox は ACK されない）。封じ込めると成功扱いで他の project の work が返り、wake outbox が ACK されて、失敗した project の wake が消費される。
  - (b) 「成功した project が 0 のときだけ Err」の規則は Idle の project を成功に数える。`default-project` を残す・足す形で実質 2 project 以上の workspace は普通にあり、失敗する project が 1 つでも Err が消える。「単一 project の workspace の挙動は今のまま」は、project が本当に 1 つのときだけ成り立つ。project 数で挙動が非単調になる。
  - (c) 失敗は `tracing::warn`（code のみ）にしか残らず、main には見えない。見せるなら wire の field と main の変更、契約が要る（採らない）。
- 採らない：wire への `failedProjectIds` 的な field、全ての Err の封じ込め（fail-closed の過剰な緩和）。
- 検証（node は 22、`CARGO_BUILD_JOBS=4`。PR-2 の head `185ef194` の上）：`grimodex-db --lib` の `nir1_graph_index_maintenance` は 43 件成功（PR-2 の 41 件に、allowlist の単体試験と R6 の試験の 2 件）。Native `--lib` 全件は 824 件成功・7 件 ignore（PR-2 の 820 件に、封じ込めの試験 4 件）。clippy（`--all-targets -- -D warnings`）は Native と db で成功。`verify:quality` は commit 後の head で走らせた。

### 実装の段取り（閉じた gate の内側まで。merge は S4（9 回目）の PR の merge の後）

| PR | 中身 | 検証 |
|---|---|---|
| PR-1（Rust と Native） | product gate の型（DR-PUBG-5-8）、discovery の wake を product gate にも広げる（W1・V4）、解除条件の試験（DR-PUBG-5-6）、V0 の試験。`native-architecture.mjs` は変えない | §6 E の cargo test と clippy。pin 済みの `native-architecture.mjs` を変えずに通る。gate が閉じていれば SQL 0・wake 0。seam の下の挙動が変わらない（既存の B-ROUTE／BSEAM の試験が無変更で通る） |
| PR-2（main と Native） | 需要からの wake（W2）、coalesce、最短間隔、dispose。CP2a-D47 の hook が B の publish の後に Suspended を解く試験 | vitest（`narrativeMaintenanceTriggers*.test.ts` に lifecycle の試験）、Native の `cargo test`、Quick |

- PR-1 と PR-2 は分ける。PR-2 は PR-1 の product gate に依存する。W3 は PR-2 に入れない。
- 役割：integrator が判断の記録と統合、実装者は Sonnet、途中のレビューは Opus、候補に触れない独立の受入れは Fable high。難しい判断（DR-PUBG-5-5 の再封印の省略、W3 の採否）は read-only の advisor に諮ってから決める。
- 未確認：s7r2 の trace での B の build の回数、main が begin の応答から Graph の理由を読めるか、9 回目の S4 の pin の一覧、閉じた理由の集合を変えたときの K6 の分類器への影響、`existingRunKindColumnValue: null` の意味。

### DR-PUBG-5-16：GDV/1 の実装判断と案 C（2026-11-17。契約 `nir1-graph-dirty-binding-verify-proposal/1#graph-limited-binding`、改訂 6）

契約の本文（`fusion-eval-data/pubg-a/05-iii-contract-draft.md`、SHA-256 `b1fa766b…660a`）は確認済みで、この DR は編集しない。この DR は、契約が実装の細部として委任に残した判断（案 C の形、判定 helper の置き場所と名前、試験の形）と、実装で測った数を残す。契約の文（§3・§5・§6）と食い違う結果は出なかった。

#### 1. 実装した形と信頼境界

- **K-2 (b)**：`VERIFY_CONTRACT_VERSION`（`"9"`）、`REBUILD_CONTRACT_VERSION`（`"1"`）、3 つの契約の digest（graph・rule・producer generation set）は変えない。report の新しい欄 `consumers_excluded_not_current`（JSON は `consumersExcludedNotCurrent`）は `#[serde(default, skip_serializing_if = "Vec::is_empty")]`。座標と、binding なし・current・Chronicle だけの project の report の形が前と同じことは、基点と本枝の両方で通る独立の試験で確かめた（`gdv1_unchanged_behaviour_tests`、`gdv1_chronicle_unchanged_tests`）。 byte 同一の確認は、下の 4 のとおり、基点の build が封じた DB の写しを開く製品の試験（`gdv1_k2_byte_compat_tests`、`gdv1_k2_stored_shape_tests`）にした（digest は run ごとに変わる fixture では前後を比べられないため）。
- **判定 helper**：`nir1_entity_relation_index::classify_graph_binding_with_control`（`pub(crate)`）。値は `Absent`／`Incoherent`／`Current`／`NoCurrentEpoch`／`RecognizedNotCurrent`。1 段目は reader と同じ `read_internal(conn, project, true, true, …)`、2 段目は今の epoch → Freshness の行・dirty の順。full eligibility はどの制御の下でも読まない。呼出しは S-1〜S-5 の関数の内側（K-4）。結果は、その関数の connection・transaction の中で取り直し、持ち越さない。
- **信頼境界**：判定は canonical な値（metadata、D1 の set・head、V1 の edge、canonical Freshness、Semantic Epoch）だけを使い、process-local の B の記録や reader の登録の状態は使わない（K-3）。新しい書込み・保存先・送信先・owner・timer・永続状態は無い。(x) の 2 か所（Repair の seal、C2Z の Verify gate）は sealed な report の対象外の欄を読むだけで、Graph を読み直さない。
- **S-4 の印**：`RECOGNIZED_UNAVAILABLE_SOURCE_STATUS`（`"recognized-unavailable"`）を定数にした。印は今の計算が作る 5 つの status（`error`・`missing`・`stale`・`usable`・`unsupported`）と重ならず、そのことを単体試験で固定した。この印が (x) の片側（digest の不一致）を支えるので、外す変更は (x) を壊す（契約 §3.2 の不変条件）。current で封じた後に dirty になった report と、binding なしで封じた report は、`NEX_VERIFY_GRAPH_STATE_CHANGED`（Repair の seal、C2Z の Verify gate の reason）で拒まれることを試験した。
- **名前**：Repair の拒否 code `NEX_REPAIR_VERIFY_GRAPH_RECOGNIZED_UNAVAILABLE`、C2Z の reason `verify-graph-recognized-unavailable`、shadow の diagnostics の code `NEX_V2_SHADOW_REBUILD_RECOGNIZED_UNAVAILABLE`（契約 §0 の「足す名前」のとおり）。

#### 2. 案 C：C-2 を採る（C-1 でも C-3 でもない）

- **判断**：main が cycle に渡した work のうち、**Verify の item がある project を 1 回だけ**、その item の直前で `plan_graph_index_build` を判定する（preempt なら Graph の build をその直前に足す）。RebuildDerived の前では判定しない。reasons のどれかが `before-cutover`／`before-cutover-follow-up` の project は判定しない（契約 §7 の拘束）。gate が閉じていれば SQL を読まずに返る（製品の既定は変わらない）。
- **測った数**（同じ試験、案 C の block だけを差し替えた 3 つの build。全部の wake は 6 回、1 つの fixture）：

| 形 | 案 | 最初の cycle の起動順 | 最初の cycle の後の generation | 全部の wake の後の generation | graph-build の起動の総数 |
|---|---|---|---|---|---|
| (a) main が Verify を渡す | C-1 | `[graph-build, verify, verify]` | 2 | 2 | 1 |
| (a) | **C-2（採用）** | `[graph-build, verify, verify]` | 2 | 2 | 1 |
| (a) | C-3（案 C なし） | `[verify, graph-build, verify]` | 2 | 2 | 1 |
| (b) main が RebuildDerived を渡す | C-1 | `[graph-build, rebuild, verify, graph-build, graph-build, verify]` | 3 | 3 | 3 |
| (b) | **C-2（採用）** | `[rebuild, graph-build, verify]` | 2 | 2 | 1 |
| (b) | C-3 | `[rebuild, graph-build, verify]` | 2 | 2 | 1 |

  試作 r5 の記録（C-1 の (b) が 3／3／3、C-3 が 2／2／1）を、製品の枝で再現した。C-2 で (b) の余分な publish が消えたので C-3（やめる）にはしない。(a) では B が Verify より先に立つ順が保たれる。C-2 の数は製品の試験（`case_c2_*`）が assert する。
- **代替案**：C-1（試作の形。(b) で publish が 1 回、graph-build の起動が 2 回多く残る）、C-3（やめる。B-ROUTE の「stale な binding は durable な連鎖より先に producer が直す」が main 由来の work に当たらないまま残る。今も当たっていない）。main の discovery を変える案は、`maintenance_runtime.rs` の discovery の契約と DR-BSEAM-1〜6 を広く変えるので採らない。
- **判定の Err の範囲**（契約 §7 が DR に残した論点。改訂 2：再レビューの反映）：`plan_graph_index_build` が返す Err は、typed な validation の終了（cancel・timeout・closed など）に限られない。`judge_graph_index_build`（`nir1_graph_index_maintenance.rs`）は、読みの SQL の失敗と、no-wait の maintenance 接続を取れないときの `NEX_MAINTENANCE_CONNECTION_PREEMPTED`（typed ではない素の Err）も返し、cycle の `should_stop` が返す cancel／lifecycle stop も typed でない素の文字列である。初版は `?` で cycle 全体を落としたので、ある project の判定の SQL 失敗や接続の拒否が、その project の Verify と、同じ request のほかの project の work まで止めた。これは案 C が新しく足した失敗の形で、`discover_cycle_work`（wake 側の既存の判定）の `?` とは別である。
  - **C-2 が握るのは、Verify の前の 1 回の判定だけ**（`is_graph_judgement_local_failure`）。局所と数えるのは、(i) 読みの SQL の失敗（Err の chain に `rusqlite::Error` がある）のうち **SQLITE_BUSY／SQLITE_LOCKED（拡張 code を含む）と素の SQLite の中断（`OperationInterrupted`）を除くもの**、(ii) no-wait 接続の拒否（`NEX_MAINTENANCE_CONNECTION_PREEMPTED`）。局所のとき、その project では Verify の前に B を足さず、Verify を続ける。
  - **局所に含めず、今どおり伝えるもの**：BUSY／LOCKED（DR-PUBG-5-15 の「retryable な busy／lock は Err のまま」と揃える。接続の取り合いで、この read の事実ではない）、素の SQLite の中断（接続 scope は latch が理由を持つときだけ typed に変換するので、持たない中断は素のまま出る。progress hook による stop の一種）、typed な termination（どの reason でも。`NEX_VALIDATION_TERMINATED:` の文字列を含むものも。typed な foreground-preempted は伝わる）、`NEX_MAINTENANCE_ATTEMPT_CANCELLED`、lifecycle stop、接続の cleanup failure。**接続を取れない素の `NEX_MAINTENANCE_CONNECTION_PREEMPTED` は握り、dispatch 側が譲る**（typed の foreground-preempted とは別。旧い注の「foreground preemption は伝わる」はこの区別を欠いていた）。握った直後に `should_stop` と cycle の stop signal を確かめ、その間に来た stop は必ず勝つ。
  - **CORRUPT／IOERR／FULL／CANTOPEN など BUSY・LOCKED 以外の SQLite の失敗は局所として握る**（その read 1 本の失敗で、cycle の終了ではない）。ただし握るときの log は `tracing::warn`（target `narrative.nir1_graph_index_build`、`NIR1_GRAPH_INDEX_BUILD_JUDGEMENT_FAILED_LOCAL`、SQLite の code 名だけ。message・project ID・path は出さない）にする。接続の拒否は `debug` のまま。DB の破損や容量不足が debug に埋もれないようにするため。
  - **判定の Err が続く形（統合者の判断：既存の挙動を変えない）**：C-2 が握るのは Verify の前の 1 回の判定だけである。Verify の後の再 discovery（`maintenance_runtime.rs` の `discover_cycle_work` 経由）は既存どおり Err を伝える。失敗が続けば、Verify の後に cycle が Err で終わり、同じ request の残りは走らない（基点と同じ）。基点の cycle も、完了した item の後の再 discovery の Err を同じ分岐（`mark_completed` して Err を返す）で伝える。本枝は `discover_cycle_work` とその呼び出し側のコードを変えていない（変えたのは doc comment と C-2 の block だけ。`git diff 2b792178..HEAD` で確認。基点での実行はしていない。コードの読みで比べた）。
  - **一度きりの失敗のとき**：C-2 は Verify の前には B を足さない。Verify の後の再 discovery の判定が成功すれば、同じ cycle の後ろで B が立つ。起動順は決定的に `[verify, graph-build, verify]`（試験が assert する。SQL の失敗・CORRUPT・IOERR・FULL・接続の拒否の 5 形）。
  - 試験（`gdv1_graph_binding_tests.rs`）：`a_failed_graph_judgement_does_not_end_the_cycle`（上の 5 形で Accepted、判定は Verify の前、`[verify, graph-build, verify]`）、`a_judgement_that_keeps_failing_ends_the_cycle_after_the_verify`（hook を常に失敗させる。判定は前の 1 回（握る）と再 discovery の 1 回（伝わる）、Verify は 1 回走って完了が記録され、その後 cycle が Err、Err の chain に注入した SQL のエラーが含まれ、graph-build は起動しない）、`a_failed_judgement_of_one_project_does_not_stop_the_other_project`（2 project の request で片方の判定だけ一度失敗させ、両方の判定が最初の item の前に走り、もう片方の work も、失敗した project の Verify も処理される）、`a_stop_that_arrives_with_a_local_judgement_failure_ends_the_cycle`（局所の失敗と同時に stop が立つと、`should_stop` 経由の形と stop signal だけの形の両方で Err、何も起動しない）、`a_graph_judgement_failure_that_ends_the_cycle_still_ends_it`（7 つの終了の形が伝わり、返った Err の chain が注入した code／reason を含み、何も起動しない）、`graph_judgement_local_failure_classification_table`（分類の表。BUSY・BUSY_SNAPSHOT・LOCKED・LOCKED_SHAREDCACHE は伝える、ERROR・CORRUPT・IOERR・FULL・CANTOPEN は局所、中断・typed・plain の stop・cleanup は伝える）。許可の判定を外す・BUSY を局所に戻すと表の試験が、握る腕を `?` に戻すと最初の試験が落ちる。注：判定の失敗は `TestStage::BeforeJudgement`（`#[cfg(test)]` の hook）で判定の transaction の中から起こした。接続の拒否は、その Err の文を同じ場所から返す形（実際の拒否は、接続を取れない状態を作ると cycle 全体が止まるので作れない）。
- **reasons が混ざった item の最後の rediscovery**：RebuildDerived の item の `[workspace-opened, before-cutover]` では、C-2 は先頭で判定せず、cycle の最後の rediscovery が先頭の reason（`workspace-opened`）で B を判定して graph-build が起動する（`[rebuild, graph-build, verify]`）。これは案 C の無い build でも起きる既存の挙動で、GDV/1 も案 C も変えない（試験は記録として assert）。reasons が混ざった item で先頭が before-cutover でないときに B を判定することが、「gated route は BeforeCutover の流れを判定しない」（`maintenance_runtime.rs:2291-2297`）に当たるかは、この DR では扱わない（残す）。

#### 3. 契約 §8 に対して基点が動いた分（本文との食い違いではない）

- 契約 §8 の「書き換える既存の試験 3 件」に加えて、基点 `79077a3d`（#926 まで）が足した 2 件が、dirty な Graph の旧い扱い（制御なしの discovery が `context-unavailable`、動機の形で Verify が `capacity-exceeded` で止まる）を assert していて落ちた。契約の GDV-R3・動機そのものが予告する変化で、§3・§5 と食い違わないので、同じ種類の書き換えとして直した：`product_gate_turns_context_unavailable_into_a_wake_that_rebuilds`（current の binding の `context-unavailable` の assert は残し、dirty の形は `Work(Verify)` と closed gate の保持を assert）、`v0_candidate_overflow_stops_verify_for_a_bound_project`（改名 `v0_candidate_overflow_does_not_stop_verify_for_a_bound_project`。動機の形が止まらないことを 3 つの launch で assert）。ほかの assert は弱めていない。
- master（`2b792178`、#930 まで）を取り込んだ。#929（DR-PUBG-5-15）が足した `a_real_sealed_binding_failure_is_project_local_and_the_other_project_still_discovers` は、動機の形（dirty な sealed binding）では GDV/1 の後に discovery が失敗しなくなるので、current な sealed binding の形（今も `context-unavailable` で、allowlist に当たる）に書き換えた。ほかの assert は弱めていない。同じ #929 の `v0_candidate_overflow_…` は、本枝の「どの launch でも wake が失敗しない」の形を採り、#929 が足した `is_project_local_discovery_failure` の assert は、残る形（current な binding）の試験で保った。
- 全件の run は基点の変更の後で 2,776 passed、5 failed（上の 3＋2）、63 ignored だった（直した後は 5 件とも通る）。**これは master（`2b792178`）の取り込み前の値**で、最終 head の値は末尾の「最終 head の検証」にある。契約が書いた「2,783 passed、3 failed」は試作 r5 の head の値で、基点が違う。

#### 4. 試験の置き場と「変更の前の build との比較」

- 製品の試験：`nir1_graph_index_maintenance_tests/gdv1_graph_binding_tests.rs`（契約 §8 の Positive／Negative／(x)／案 C）。拒否の試験は code か reason まで assert し、対の対照は **binding なしの同じ workspace**（seal が `Ok`、gate が `Passed`、cutover が成功）にした。欄だけを空にした同じ report は digest が封じられているので作れない（契約の「または検査を外した対照」は、(y) の build を別に作らず、この対照で代えた）。
- 基点と本枝の両方で通る試験：`gdv1_unchanged_behaviour_tests.rs`（同じ build の中で作る形。`EXPECTED` は件数・variant・error code の prefix で、id と digest は run ごとに変わるので比べない。基点で取った値）と、`gdv1_k2_byte_compat_tests.rs`（下の 4 の写し）。`gdv1_unchanged_behaviour_tests` には、current と分類されて full validation が false になる形として形 22（eligibility の今の Source との source digest のずれ）と形 23（edge と Source の不一致）を足した（基点で同じ値）。契約の座標、incoherent・current で full validation が false の形・current・binding なし・Chronicle だけの形の report・discovery・cycle・Finding・Repair の seal・C2Z gate・foreground の完了・V2 shadow の要約が、基点と同じであることをこれで確かめる。
- 試験の実行は、基点と本枝で **cargo の target を分ける**（`/home/grimodex/cargo-targets/gdv1-base` と `gdv1-impl`）。同じ target を 2 つの worktree で使うと、cargo の fingerprint が古い worktree の依存情報を見て再 compile せず、古い binary を走らせる。
- **前の build が封じた DB の写しとの比較（製品の試験。契約 §8 の K-2 (b)）**：基点 `79077a3d` の build が、Verify を封じた状態（完了した clean な Verify の Run と skip の証跡）で `VACUUM INTO` した DB の写し 3 つ（binding なし、current な Graph の binding、Chronicle の binding だけ）を `tests/support/gdv1-k2-{none,current,chronicle}.db.gz` に置いた（既存の `nir1-*-cold.db.gz` と同じ形。fixture は本枝の build では作り直さない）。`gdv1_k2_byte_compat_tests` は、写しごとに、reader ごとの新しい解凍コピーで、次の値を**全文**で基点の値と比べる：Verify の report（`serde_json::to_value` の文字列）、保存された report と新しく作った report が同じ文字列であること、完了証跡の digest（制御なし・foreground）、main の discovery、制御なし・cycle の制御つき（`MaintenanceCycleControl` を通した `discover_durable_maintenance_work_with_coordinates_and_control`。`ForegroundValidationControl` の代用ではない）の skip 判定、Repair の seal（plan の `Debug` 全体）、C2Z の readiness（`Debug` 全体）、Verify の item を渡した cycle（status と Run・Finding の数の前後）。`EXPECTED_*` は基点で別 process に取り、基点で 2 回読んで同じことを確かめた（temp path や壁時計は入らない）。結果：binding なしは 5 つとも中身のある結果で一致（discovery `Idle`、skip 2 つ `None`、seal `Ok`、gate `Passed`）。current と Chronicle は、制御なしの 4 つ（discovery・skip・digest・seal）が前後とも `context-unavailable`、C2Z の readiness が `Blocked`、cycle の制御つきの skip が `Ok(None)` で、契約の改訂 5 の断りどおり（GDV/1 の前からの挙動）。Chronicle の binding だけの写しは、基点の build で Chronicle の index を publish し、cycle で Verify を封じた clean な outcome で、4 の「未実施」だった「今の契約の clean な outcome」に当たる。`gdv1_k2_stored_shape_tests` は、GDV/1 の前の形（`consumersExcludedNotCurrent` 欄なし）の保存値が読めて、書き戻すと保存値と byte 同一になること、欄が空でない report はその欄を書いて読み戻すこと（欄なしが「書かない」ではなく「空」であること）、写し `gdv1-k2-failed-verify.db.gz`（基点で動機の形を作り、seam の wake で Verify が容量で failed、Finding 1 件）が、本枝で開いても同じ Semantic Epoch の間は戻らないこと（discovery は毎回 `Work(Verify)`、cycle は Accepted で新しい Run も Finding も作らない。契約 §5・T-9 (ii)）を固定する。

- **写しの sha256 と生成の手順**（再現のための記録。generator は commit しない）：
  - sha256：`gdv1-k2-none.db.gz` `83b6cf308913076a5bb5ba3372481587493ecdf54c75a3fcaffec7d7e0982dd2`、`gdv1-k2-current.db.gz` `5a5b3a7b35e8fe20dbf401a2422c7820cf2236dd7676e8d767bfd9aff5d03d40`、`gdv1-k2-chronicle.db.gz` `3c7bd789b62b45fbc1638a856b8d1fc8259422accab9e49586d78ca5db8c27d4`、`gdv1-k2-failed-verify.db.gz` `d7c563d8c0f21b7ebf2d635d835b3c540a890c66ac74dbee6cbb0d288d2b21b9`（`tests/support/`）。
  - 生成：基点 `79077a3d`（#926）の worktree（`gdv1-base`）の未追跡の試験 file `gdv1_k2_generate.rs`（`#[ignore]` の 4 本。環境変数 `GDV1_K2_OUT` の directory に `gdv1-k2-<名前>.raw.db` を `VACUUM INTO` で書く）を `cargo test -- --ignored` で 1 本ずつ走らせ、出た `.raw.db` を gzip して置いた（圧縮の level は記録していない。中身の DB を開いた値が前後で同じことを `EXPECTED_*` が固定するので、gzip の byte は比較の対象ではない）。この generator は基点の API だけを使い、本枝には入れない。
    - `none`：B-ROUTE の fixture `Fixture::new()` を作り、`drain_durable_chain` で durable な連鎖（Backfill → Verify → 条件つきの Rebuild → Verify）を最後まで流す。制御つきの discovery が `None`（Verify が封じられ skip される）で、`narrative_semantic_index_metadata` が 0 行（Graph の binding なし）であることを assert してから `VACUUM INTO`。
    - `current`：`Fixture::published()`（Graph の index を B で publish した current な binding）の current epoch で、Verify の item を渡した cycle（`run_cycle_on`、seam なし）を最大 3 回回し、各回の後に制御つきの discovery が `None` になったら止める。最後に discovery が `None`、`dirty_cache_flag=0` の metadata が 1 行であることを assert してから `VACUUM INTO`。
    - `chronicle`：Chronicle の test fixture（`nir1_chronicle_index::test_support::Fixture`）で index を `publish_chronicle_index_build` で publish し（Graph の binding なし）、その project の current epoch で Verify の item を渡した cycle を最大 3 回、各回の後の discovery が `None` になったら止める。discovery が `None` であることを assert してから `VACUUM INTO`。
    - `failed-verify`：`Fixture::published()` に `overflow_candidates`（候補を 2,065 件にして B の close の bound を 1 つ超える。V0 (b)）を足し、`dispatch` で B が `candidate-rows` の容量で拒否されたことを確かめ、seam の wake（`wake_step(.., Launch::Seam)`）を 6 回回す。run の台帳の最後が `dependency-verify` の `failed`、Finding が 1 件であることを assert してから `VACUUM INTO`。
  - 圧縮した 4 つの写しは、読み手の試験が毎回、reader ごとの新しい解凍コピーで開く。本枝の build では作り直していない。

#### 5. 未実施と代替（契約 §8。結果が本文と食い違ったものではない）

- **Chronicle だけの project の、今の契約の clean な outcome**：実施した（上の 4。写し `gdv1-k2-chronicle.db.gz` と 5 つの読み手）。
- **制御つきの skip 判定を cycle の制御で通す形**：実施した（上の 4。`read_skip_in_cycle_control`。`MaintenanceCycleControl` を作る試験の補助 `with_control` を通す）。
- **「eligibility の今の Source との source digest のずれ」と「edge と Source の不一致」の 2 形**：作った（形 22・23。`current_but_false_forms_stay_manual`）。どちらも reader の構造の読みでは `Current`、`is_complete_registered` は `Ok(false)`（容量の Err ではない）、B の hint は `Skip{BindingCurrent}`、Verify は Graph の 4 edge を unresolvable に残し何も対象外にしない（manual）。形 22 は stored の source digest と今の Source の digest が違い、形 23 は digest が同じで edge の read set だけが Source と違う。Verify の cycle と discovery の結果は基点と同じ（`gdv1_unchanged_behaviour_tests`）。形 21（候補ではない proposal の行を足す形）は current で full validation が true、Verify は clean で、契約 §5 の「残る止まり」の形ではない（§5 の列挙は Edge State の 2 形と、この 2 形だけ）。形 21 は Source digest のずれを作ろうとして Source を変えなかった形で、本文と食い違わない。
- **T-9 (ii)（改訂の前に Verify が容量で failed になった DB を、改訂の後に開く）**：実施した（上の 4。`a_verify_that_failed_for_capacity_before_gdv1_does_not_come_back_by_itself`）。契約 §5 のとおり、同じ Semantic Epoch の間は自動では戻らない。
- **(y) の build（検査を外した対照）**：別の build を作らず、binding なしの同じ workspace の対照（seal `Ok`・gate `Passed`・cutover 成功）で代えた。
- **foreground の完了（current）**：契約が推測した `maintenance_runtime.rs:1118` の release の拒否ではなく、Verify の run 自体が `context-unavailable` で落ちる（基点も同じ。`foreground_verify_completion_seals_for_a_not_current_graph_only` と `gdv1_unchanged_behaviour_tests` の `readers current`）。
- **Backfill の後の `dirty_cache_flag`**：epoch を Backfill の実 run で作ると、開始が dirty=0・1 のどちらでも 1 になった（epoch の作成が binding を dirty にする。契約 §3.1 の推測どおり）。
- **保存の超過（V0 (a)）**：既存の `v0_stored_edge_overflow_stops_verify_for_a_bound_project` が無変更で通ることを根拠にした（この PR で書き換えていない）。

- **incremental Freshness の feed と Graph の consumer**：Scene の編集（tree node の patch の feed）は、Graph の edge（`codex:`、`codex-relation:`、project の eligibility）の source には当たらず、Graph の consumer に届かない（届くのは、その Scene を読む consumer。試験の fixture では Proposal Revision）。Graph の edge を選ぶのは、全 Graph の評価を要る event（epoch reset、component schema change）だけで、編集の feed ではなく、公開の API では作れなかったので試験していない。試験（`incremental_freshness_after_a_scene_edit_does_not_resolve_the_eligibility`）は、候補 2,065 件では eligibility の読みが容量の Err になることを前提として示し、編集の feed の後の cycle が成功すること、Graph の surface（metadata・Freshness・Edge State）が変わらないこと、feed が届いた consumer に Graph が含まれないことを assert する。**実測**：incremental の reserved consumer の guard（`incremental_freshness.rs` の `continue`）を外しても、この試験は通った（変異を 1 回回した）。Scene の編集の feed が Graph の edge を選ばないことの実測であり、この試験には外すと落ちる guard が無い。guard が効くのは、全 Graph の評価の event（epoch reset、component schema change）が edge を全部選ぶときだけで、そこは試験していない。外すと落ちることを確かめたのは、S-5 の skip（`restore_rebuild.rs` の Graph head の飛ばし）と、案 C-2 の判定の Err の許可（外すと `a_failed_graph_judgement_does_not_end_the_cycle` が落ちる）である。

#### 6. 最終 head の検証（2026-11-17。`60adc950` の code の値。§7 の直しの前なので、最終 head の値は §8）

- **最後の code commit の head：`60adc950`**。その後の docs だけの commit（`ab89d5ff`、`727814a3`。後者がこの節を足す。以後の master 取り込みの commit を除く）は `docs/plans/nir1-lane-decisions/broute-decisions.md` だけで、code・試験・fixture を変えない。検証は `60adc950` の code に対して実施し、`verify:quality` と C2-ZC の receipt は `ab89d5ff`（clean な tree）で取った（master `2b792178`〔#930 まで〕を取り込み済みの枝）。
- Node の版：22.23.3（`fnm exec --using=22`）。cargo の target：`/home/grimodex/cargo-targets/gdv1-impl`。
- `cargo test -p grimodex-db --lib`（全件）：**2,822 passed、0 failed、63 ignored**（取り込み前の 2,776 passed から、取り込みと再レビューの試験で増えた）。
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib --features licensing,legacy-keyring-migration`：**838 passed、0 failed、7 ignored**。
- `cargo clippy -p grimodex-db --all-targets -- -D warnings`：成功。Native の clippy（同 features、`--all-targets -- -D warnings`）：成功。
- rustfmt（`--edition 2021 --check`）：本枝が所有する `gdv1_graph_binding_tests.rs`（今回、全体を整形）と `gdv1_k2_byte_compat_tests.rs` は差分なし。`maintenance_runtime.rs` には 18 か所の既存の差分が残る（`2b792178` の時点でも同じ 18 か所で、本枝が足した部分は整形済み）。`nir1_graph_index_maintenance_tests.rs` は今回触った部分に差分なし（mod 経由では、この枝の前の commit 由来の未整形が `gdv1_k2_stored_shape_tests.rs`・`gdv1_unchanged_behaviour_tests.rs` などに残る。rustfmt は CI で強制されない）。
- `validate-semantic-core-boundary.mjs`：PASS（132 operations、schema 46）。`validate-native-writer-ownership.mjs`：ok（active=79、scanned=435）。
- `fnm exec --using=22 pnpm -s verify:quality`：成功（exit 0）。
- C2-ZC の receipt（`--base 2b79217879f90ebe098d7e68312a82da9ef7e893`、clean tree、`resolvedHeadSha` は `ab89d5ff`）：`sha256:7ed253623a09288c448d94dd9e4692854f4527130775a8f988253b526624dfd6`。

#### 7. 容量の境界での判定（2026-11-17。PR #932 の Quick quick-2 の失敗の後）

- **失敗**：`nir1_entity_relation_index::capacity_boundaries::rebuild_rechecks_graph_growth_after_the_d1_snapshot`（`--features nir1-material-diagnostics`）が、`nir1_capacity_boundary_tests.rs:284` の assert（「all D1 reads use snapshots; no Graph Edge materialization」）で落ちた。読みは `[(true,false),(false,false),(true,false)]`。master（`1dcc7b88`）では通る。
- **原因（backtrace で確定。推定ではなく測った）**：`(false,false)` は `find_edges_by_consumer` の Graph の edge の全件の読みで、呼出しは S-5 の `verify_v2_shadow_for_rebuild_in_tx_with_control` の `classify_graph_binding_with_control` → `read_internal` → `read_internal_bounded` だった。1 段目の構造の読みは edge の read set と D1 の entry の全件が要るので、clean で current な binding でも、Rebuild の中で Graph の edge を materialize していた。同じ transaction の preflight（`preflight_stored_graph_capacity`）の後なので、その snapshot の中では bounded だが、この試験（と `rebuild_entry_refuses_oversize_graph_before_d1_or_edge_materialization`）が固める「Rebuild は、D1 の snapshot の後の再検査より前に Graph の edge を読まない」を、基点が持っていなかった読みで破っていた。
- **判断**：S-1〜S-5 の呼出し元は、判定が返す 5 つの値のうち `RecognizedNotCurrent` だけで分岐する（他は全部「今のまま」。契約 §3.1 の 3 分類）。そこで、**構造の読みは、`RecognizedNotCurrent` がありうるときだけ行う**。`is_graph_binding_recognized_not_current_with_control`（`pub(crate)`）が、行を 1 本ずつ読む前段（今の epoch があるか、metadata の `dirty_cache_flag`、Freshness の `fresh`／`none`／今の epoch）で、`RecognizedNotCurrent` ではありえない形を先に返す。epoch が無い、metadata が無い、dirty が 0 で Freshness が current、のどれかなら `false`。残る形（dirty か Freshness が current でない）でだけ、`classify_graph_binding_with_control` を呼んで `== RecognizedNotCurrent` を返す。前段の Freshness の判定は `classify` と同じ関数（`graph_freshness_is_current`）で、2 つは食い違わない。4 か所の呼出し（S-1・S-3・S-4・S-5 に 1 つずつ）をこの helper に替えた（`classify` 自体は残し、5 値のまま試験が使う）。
- **同値（契約の分類は変えない）**：helper は、すべての binding の形で `classify(..) == RecognizedNotCurrent` と同じ Ok の値を返す。試験が、21 形（`binding_shapes()`）の全部で一致を assert する。変わるのは Err の形だけで、clean で current（または今の epoch が無い、metadata が無い）の binding の構造の読みが Err になる形は、helper が `false` を返し、今のまま full validation に渡る（基点と同じ挙動。そこで容量を見るのは、判定を求めた段階の admission と、full validation 自身）。
- **容量を超える Graph に当たったとき（fail-closed）**：構造の読みが走るのは、dirty か Freshness が current でない binding だけで、そのとき読みは必ず同じ transaction の `preflight_stored_graph_capacity` の admission の後に edge を読む。超えていれば admission の Err（`stored-edge-bytes` など）を**そのまま返す**。`RecognizedNotCurrent` と決めつけて skip しない。edge の件数・digest は構造の読みに要る edge の中身（read set の正規形、tuple の一致）と切り離せないので、COUNT などの行を作らない読みには替えない（替えれば判定の意味が変わる）。
- **他の呼出し元の確認（手順 4）**：`classify` の呼出しは S-1（`verify_narrative_dependency_graph_for_project_with_control_within_capacity`）、S-3（`verify_semantic_index_checks_with_control`）、S-4（`durable_graph_state_digest_with_control_within_capacity`）、S-5 の 4 つだけで、全部この helper に替えた。S-1・S-3・S-4 は、判定の後にその関数自身が Graph の edge を全件読む（容量の admission の中）ので、判定が先に読んでも境界は越えていなかったが、current な Graph では 2 回読んでいた分が無くなった。`maintenance_runtime.rs` の C-2（`plan_graph_index_build` の判定）、discovery、`nir1_graph_index_maintenance.rs`、`repair.rs`、`c2z_preparation.rs` の基点との差分に、`find_edges_by_consumer`・`read`・`is_registered`・`is_complete_registered`・`read_eligibility_source` を新しく呼ぶ行は無い（差分の追加行を grep した）。C-2 の判定は GDV/1 の前から B の planner が持つ読みで、本 DR の helper は呼ばない。
- **試験**（`gdv1_graph_binding_tests.rs`）：`the_decision_does_not_read_graph_edges_past_the_capacity_admission`（clean で current な binding は edge を 0 回 materialize して `false`。同じ binding の edge が byte の上限を超えても `false` で 0 回。dirty にして上限を超えると `classify` も helper も `stored-edge-bytes` の容量の Err を返し、edge は 0 回。`if false` で前段を無効にする変異で、1 回になって落ちることを確かめた）と `the_decision_equals_the_classification_for_every_binding_shape`（21 形で `classify == RecognizedNotCurrent` と一致）。落ちた試験 `rebuild_rechecks_graph_growth_after_the_d1_snapshot` は変えずに通る。
- **動かさないもの**：閾値（`INPUT_BYTES`、`STORED_COLLECTION_LIMIT` など）、契約の本文、5 値の分類、report と digest の形、K-2 (b) の byte 互換、(x) の gate。新しい書込み・保存先・送信先・owner・永続状態は無い。

#### 8. 最終 head の検証（2026-11-17。§7 の直しの後）

- **最後の code commit：`996efe59`**。その後の docs だけの commit（この節を足す。`broute-decisions.md` だけで、code・試験・fixture を変えない）以後は、検証を `996efe59` の code に対して実施した値とする。基点は `1dcc7b88`。Node は 22（`fnm exec --using=22`）、cargo の target は `/home/grimodex/cargo-targets/gdv1-impl`。
- `cargo test -p grimodex-db --features nir1-material-diagnostics --lib`（CI の impact の形、全件）：**2,889 passed、0 failed、63 ignored**。Quick で落ちた `rebuild_rechecks_graph_growth_after_the_d1_snapshot` を含め、変えずに通る。
- `cargo test -p grimodex-db --lib`（全件）：**2,846 passed、0 failed、63 ignored**（§6 の 2,822 に、基点 `1dcc7b88` の取り込みと §7 の 2 本で増えた）。
- `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --test nir1_capacity_boundaries`：成功（0 件。この test target は feature が要る試験を持たず、本体の試験は上の lib に入っている）。
- Native `cargo test --lib --features licensing,legacy-keyring-migration`：**838 passed、0 failed、7 ignored**。
- clippy：`-p grimodex-db --all-targets -- -D warnings` は成功。`--features nir1-material-diagnostics` は 11 件（lib）・7 件（lib test）の既存の指摘（`nir1_graph.rs`、`nir1_graph/input.rs`、`nir1_graph_memory_diagnostics.rs`。`too many arguments`、`never used` など）で失敗し、本枝が触った file には 1 件も無い（この 3 file は基点との差分が無い）。Native の clippy（同 features、`--all-targets -- -D warnings`）：成功。
- `fnm exec --using=22 pnpm -s verify:quality`：成功（exit 0）。
- C2-ZC の receipt（`--base 1dcc7b88437b4720350d7e537811d595a716c055`、clean tree、`resolvedHeadSha` は `996efe597faaf42585fc14150b4173df64495294`）：`sha256:2acfeb15653e531dad6bd1ea22bf4acca5d32dc82ceb7dc53265e6dbb0fb26db`。
- **省いたもの**：CI の `ci:local:quick --part 2` の impact の選択の手元の再現は、重いので実施していない。落ちた試験は、その選択が使う形（`--features nir1-material-diagnostics --lib`）の全件で通った。

### DR-PUBG-5-17：需要の wake の cycle が rediscovery の budget を消費する結合を切る（2026-11-19。DR-PUBG-5-14 の「切替の前に決める項目」の 1 つ目）

- 位置づけ：mutation の前の判断と信頼境界の記録（この commit は docs だけ。コード・定数・policy は変えない）。計画は `fusion-eval-data/design-notes/cp4-final-freeze-prep-2026-11-19/q5-graph-index-pre-switch-plan.md` の §4（課題 #5 の点 (2)）。枝 `claude/pubg5-demand-wake-rediscovery`（基点は origin/master `65deca68`）。
- 委任と停止点：DR-PUBG-5-13・-14 と同じ（C-product の worker／owner／lifecycle の技術判断、委任の内の技術的な threat model の改訂）。push・PR・merge は統合者が後でレビューしてから行う。`PRODUCT_GRAPH_PUBLISHED` は false のまま。切替の本体（const・registry 3→4 本・policy の `wired` の行）は入れない。`native-architecture.mjs` の `FIXED_BODIES` と `SOURCE_PINS` の対象 file には触れない（main の TS だけの変更）。

**読んで確かめたこと（`65deca68`）**
- `onCycleAccepted` は scheduler が `cycleResult.status === "accepted"` のときだけ、cycle の応答の直後に引数なしで呼ぶ（`narrativeMaintenance.ts` の cycle 本体。`coalesced`・失敗・`deferred`・`not-admitted`・`workspace-unavailable` では呼ばない）。呼出し元は bootstrap の 1 か所だけで、`coordinator.requestRediscovery()` と `drainWakeOutbox()` を呼ぶ。repo 全体の grep でも、`onCycleAccepted`・`requestGraphIndexBuildWakesWithBinding`・`durableWakeProjects` は `electron/main/narrativeMaintenance*.ts` と、その試験・DR 文書にしか無い（`scripts/`、`evals/`、`policies/`、`native-architecture.mjs` の pin、`observation-prep.v1.json` には無い）。
- 1 cycle が送る wake は、work の batch が空のときだけ（`sendingWakeEntries` は `backendBatch.length === 0` の枝でしか非空にならない）。再送（`deliveryRetry`）は、元の cycle の `work` と `wakeEntries` をそのまま写すので、work と wake が同じ cycle に載ることは無い。したがって「混ざった cycle」は、(i) 由来が異なる wake（需要の project と discovery の project）が同じ cycle に載る場合と、(ii) work の cycle を指す。(ii) は wake が空なので、今のまま rediscovery を呼ぶ。`backendBatch`・`wireBatch`・`sendingWakeEntries` は cycle の途中で再代入されない。
- wake の entry（`durableWakeProjects`）を書く場所は 11 か所：入口（`requestGraphIndexBuildWakesWithBinding`）、rebind（binding の付け替え）、completion proof の復元（`completionWakeProjects`）、`retainCycleContinuation`（hasMore）、preempt・deferred・workspace mismatch・not-admitted・workspace-unavailable・失敗の requeue（retry count と delivery failure の受理の失敗の戻し）。再送用の `RetryableDelivery.wakeEntries` は entry を spread で写す。
- `requestRediscovery` は `lastWakeReason === null`（chain 終了）なら no-op、budget 3（`NARRATIVE_MAINTENANCE_MAX_REDISCOVERY_ATTEMPTS`）、遅延 250 ms。尽きると `markExhausted`。fingerprint の変化で 0 に戻る。

**判断 1：由来（origin）は entry に持たせる。既定は必ず `"discovery"`（今の挙動の側）**
- `NarrativeMaintenanceWakeOrigin = "demand" | "discovery"`。`requestGraphIndexBuildWakesWithBinding(projectIds, binding, origin = "discovery")`。需要の timer の発火（`fireGraphDemand`）だけが `"demand"` を渡す。discovery の W1（`wakeProjectIds`）、seam の B の wake、origin を知らない呼出し・復元は、すべて `"discovery"`（今のまま）。
- 新しい IPC・`#[napi]`・wire の項目は無い。origin は main の process-local な記録で、Native へも永続にも出ない（再起動で wake ごと消える。需要の wake は元から永続しない）。

**判断 2：同じ key では discovery が勝つ（降格しない）。書込みは 1 つの関数に集める**
- 不変条件：**需要は、需要が無かった場合に呼ばれたはずの rediscovery を 1 回も減らさない**。需要の cycle の in-flight の間に同じ key へ discovery の wake が入り、その後 cycle が失敗して requeue するとき、requeue が `"demand"` で上書きすると、discovery の wake が降格し、需要が rediscovery を抑止できてしまう（新しい害）。これを防ぐため、`durableWakeProjects` への書込みを 1 つの関数にし、既存の entry が `"discovery"` なら `"discovery"` を保つ。入口・rebind・全 requeue がこれを通る。
- 逆向き（discovery の requeue が、新しく来た demand に上書きされる）は、同じ規則で discovery が残る。

**判断 3：`demandOnly` は「実際に送ったもの」で計算する**
- `demandOnly = (wireBatch が空) && (sendingWakeEntries が 1 件以上) && (その全件が demand)`。`onCycleAccepted({ demandOnly })` として渡す。再送（`deliveryRetry`）でも、写した `wakeEntries` の origin で同じ式になる。
- bootstrap：`demandOnly` のときは `requestRediscovery()` を呼ばない。`drainWakeOutbox()` は今のまま必ず呼ぶ（wake outbox の drain は chain と別。Epoch rotation の live event の取りこぼしの回収点）。`onWorkspaceBindingMismatch`・`onCompletionRecoveryAcknowledged` の rediscovery は変えない。

**判断 4：hasMore の継続（`retainCycleContinuation`）と復元の origin**
- work の cycle の継続は discovery（work の project は由来を持たない。既存の hasMore の試験と stall の試験が依存する）。wake だけの cycle の継続は、project ごとに entry の origin を引き継ぐ。引き継がないと、需要 → hasMore の経路で budget の消費が残り、不変条件の目的が欠ける。
- completion proof の復元（`completionWakeProjects`。`string[]`）は origin を落とすので、並行して `completionWakeOrigins`（project → origin）を持ち、復元時にそれを使う。無ければ `"discovery"`（不明は今の挙動）。
- delivery failure の persist（`persistDeliveryFailure` の scope `wake`）は永続の recovery wake で、再起動後は discovery の wakeProjectIds として戻る（origin は `"discovery"`）。変えない。

**判断 5：変えないもの**：budget（3）、遅延（250 ms）、cooldown（5〜60 s）、需要の wake の数値（間隔 2〜60 s、key 8、reset 60 s）、W1・seam・work の cycle の rediscovery、`coalesced` の扱い、Native、IPC、schema。数値は 1 つも緩めない（消費を減らす側だが、budget 自体は変えない）。

**範囲外として記録だけするもの（残る結合）**
- 需要の cycle が workspace binding の不一致や `maintenance-workspace-changed-during-cycle` に当たると、`onWorkspaceBindingMismatch` → `requestRediscovery()` が budget を消費する経路が残る。これは binding の不一致という別の原因の回復で、需要 wake の受理とは別の結合。今回は変えない。
- before-cutover の chain は、需要で急かされなくなる。chain が止まって見える場合の再開は、今までどおり Freshness の NOT_READY の cooldown が担う（変えない）。

**owner／lifecycle matrix（background／async-lifecycle。DR-PUBG-5-9 の項目に沿う。新しい源・timer・handle は足さない）**

| 項目 | 扱い |
|---|---|
| entry | 既存の 2 経路に origin の印を足すだけ。(W1) discovery の `wakeProjectIds`、seam の B の wake → `"discovery"`。(W2) 需要の timer の発火（`fireGraphDemand`）→ `"demand"`。新しい入口・event・IPC は無い |
| start | 変わらない。scheduler の timer と cycle の admission は今のまま。origin は cycle の開始条件に入らない |
| retry | requeue は origin を保つ（判断 2 の merge）。retry count・backoff・`persistDeliveryFailure` は変わらない。再送（`deliveryRetry`）は `wakeEntries` ごと origin を写す |
| reentrant | (binding, project) ごとに pending は 1 つ（変わらない）。同じ key に両方が来たら `"discovery"`。降格は無い |
| 混ざった cycle | work の cycle は wake が空なので `demandOnly=false`。由来が異なる wake を同じ cycle に載せたときは `demandOnly=false`（今のまま rediscovery を呼ぶ）。需要の project だけの wake の cycle だけが `true` |
| hasMore の継続 | work の継続は discovery。wake だけの継続は project ごとの origin を引き継ぐ（判断 4） |
| completion の復元 | `completionWakeOrigins` で復元。無ければ `"discovery"` |
| origin 不明時の既定 | 常に `"discovery"`（今の挙動） |
| admission closure | 変わらない。dispose・quiesce・workspace 切替で `durableWakeProjects` ごと消える（origin も一緒に消える） |
| pending start | 新しい timer は無い。`onCycleAccepted` の中で `requestRediscovery` を呼ばないだけで、coordinator の timer（250 ms の rediscovery）を 1 つ減らす側 |
| active handle | 変わらない（cycle の permit と attempt。origin は handle を持たない） |
| cancel | 変わらない。origin は cancel の経路に関与しない |
| 有限待機 | 待ちを足さない。`demandOnly` は cycle の完了時の同期の計算 |
| 終了の証拠 | 変わらない。timer の clear と dispose の記録、cycle の terminal receipt |
| error／timeout／onClosed | 失敗の requeue は origin を保つ（判断 2）。callback の例外は今までどおり warn で握る |
| 再起動時の状態 | 永続する状態は無い。origin は process-local。再起動後は discovery の wake として戻る |

**threat model の差分（委任の内の技術的な改訂。actor・防御・受信先・受入れは変えない）**
- 新しい攻撃：untrusted な renderer が seed 付きの begin を繰り返し、需要の wake を起こして before-cutover の chain の budget を尽きさせる経路が、**閉じる**（DR-PUBG-5-14 の判断 5 の残余リスクの解消）。新しく開く経路は無い。
- 新しく生まれうる害（防ぐもの）：需要の origin が discovery の wake を降格し、rediscovery を抑止する。判断 2 の merge と、競合（需要の cycle の in-flight → 同じ key に discovery → cycle の失敗 → 次の cycle）の試験で防ぐ。
- 受信先・保存：増えない。新しい書込み・保存先・送信先・durable な行・IPC は無い。
- 受入れ：const が false の間は挙動不変（event 0、timer 0、wake 0、B の SQL 0）。W1・seam・work の cycle の rediscovery は今まで通りの回数。
- 委任の外に当たるもの（避けたもの）：budget・遅延・cooldown・需要の間隔・key の上限の変更、新しい契約・authority、Native の変更。

**試験計画**：scheduler の単体（`onCycleAccepted` の引数。需要だけ → true、discovery だけ・work の cycle・由来が異なる wake（順序 2 通り）→ false、requeue 後の保持、降格の競合、hasMore の継続、再送）、bootstrap（`drainWakeOutbox` は常に呼ぶ）、production の bootstrap と実 scheduler（`narrativeMaintenance.electronRoute.test.ts` の「需要の受理が rediscovery を 1 回足す」を意図して 0 回に書き換え、discovery 由来の対照を足す）、budget の回数（需要の cycle を budget の 3 を超えて受理させても尽きず、その後 discovery 由来の cycle が 3 回消費できる）、変異 2 種（判定を外す、混ざった cycle を demand と数える）。

**追補 1（2026-11-19。独立レビュー〔Opus〕の指摘 3 件への対応。既存の文は消さず、この追補で範囲と定義を訂正する）**

- 位置づけ：判断 2・判断 3・matrix の retry 行・threat model の「降格を防ぐ」の範囲を、実際のコードと試験に合わせる。budget・遅延・cooldown・需要の間隔・key 上限は変えない。新しい源・timer・IPC・永続状態は足さない（main の TS だけ）。

**追補 1-A：origin の snapshot は await をまたぐ。discovery の昇格は delete の直前に行う（判断 2 の穴）**
- 原因：cycle の origin と `demandOnlyCycle` は `durableWakeProjects` の snapshot（cycle の頭）で決まるが、その entry を消す `durableWakeProjects.delete(entry.wakeKey)` は、await（descriptor recovery の `reconcileRecovery`、delivery ACK の `retryPendingDeliveryAcks`）の後にある。待機中に同じ key へ discovery の wake が入ると、map の entry は discovery に上がるが snapshot は demand のまま、delete が discovery の wake を吸収し、`demandOnly=true` で rediscovery が呼ばれない（基点では呼ばれていた）。容量で再送待ちの cycle（`deliveryRetry`）でも、待ちの間に入った discovery が同じ形で吸収される。
- 直し：delete の直前に、各 entry の生きている origin（`durableWakeProjects.get(wakeKey)?.origin`）を読み、discovery なら `sendingWakeEntries` の origin を discovery に昇格して、`sendingWakeOrigins` と `demandOnlyCycle` を計算し直す。昇格した値は、後段の `RetryableDelivery.wakeEntries`、`completionWakeOrigins`、全 requeue の `sendingWakeOriginOf` にそのまま流れる。昇格は demand → discovery の一方向だけ（逆は無い。判断 2 の不変条件と同じ向き）。delete の後に入る wake は新しい entry になり、次の cycle の対象なので窓は残らない。
- 試験（`narrativeMaintenance.wakeOrigin.test.ts`、レビューアの再現を筋書き A・B として正規化）：A＝demand の cycle が recovery の preflight の await で止まっている間に discovery が同じ key へ入る、B＝容量で再送待ちの demand の cycle の間に discovery が同じ key へ入る。どちらも `demandOnly=false`（昇格を外すと両方が落ちる）。

**追補 1-B：試験で実際に固定したものと、判断 2 の「降格を防ぐ」の範囲（判断 2・matrix の訂正）**
- 判断 2 の「入口・rebind・全 requeue がこれを通る」は書込みの経路の説明で、origin の保持を試験で固定した範囲は次のとおり。discovery を demand へ、demand を discovery へ動かす変異のうち、落ちたものと落ちないものを分ける。
  - 落ちる（試験が固定）：入口の merge（両方の順序）、rebind（`entry.origin` の引き継ぎ。demand 固定・discovery 固定の両方）、`RetryableDelivery.wakeEntries`（容量の再送。demand 固定で、discovery 由来の再送が `demandOnly=true` になる）、requeue の 7 か所すべて（preempt〔interrupted〕・deferred・workspace binding の mismatch・not-admitted・workspace-unavailable・失敗の retry〔budget 内と、budget 超過で failure receipt を残せない場合〕。各 2 方向）、hasMore の継続（2 方向）、追補 1-A の昇格。mismatch の requeue は、park された wake を次の需要の wake が解く筋書きで固定した（`completionWakeOrigins` の復元を通らない入口〔Native が `maintenance-workspace-binding-mismatch` を返す経路〕がある。当初の「等価な変異」は誤りで、取り下げる）。
  - 落ちない（等価な変異・1 件。コードの読みによる）：`RetryableDelivery.wakeEntries` のうち「uncertain」（配送結果が不明で、同じ request を再生する）側の origin を demand に固定する変異（capacity 側は試験が落とす）。uncertain の再生は、main 側の ledger が同じ sequence／fingerprint を duplicate として持つので `replayingDelivery` が真になり、`lifecycleEnabled`（`!replayingDelivery && …`）が偽、`cycleAttemptId` が null になる。receipt を採る代入（`nativeTerminalReceipt = …`）は、受理の経路では `cycleAttemptId` の内側にしか無いので、再生が受理されても receipt は null で、`demandOnly` は `wakeEntries` の origin に関わらず false になる（追補 1-C の receipt の条件が決める）。したがって、この変異は観測できる差を生まない。ただし、再生の経路そのものを試験で再現してはいない（`resolveNarrativeMaintenanceDelivery` が out-of-order を返す筋書きは、遅れて同じ cycle を再生する経路でなく、interrupted の receipt による通常の requeue になる。receipt を返さない筋書きは terminal receipt の不明で止まる）。receipt の条件を外す・緩める変更を将来入れるときは、この経路の origin を試験で固定する必要がある。
- matrix の retry 行（「再送は `wakeEntries` ごと origin を写す」）と rebind の保持は、上の試験で固定された（以前は変異が生き残っていた）。
- したがって「降格を防ぐ」は、(1) requeue が cycle の origin を保つ、(2) 書込みの merge で discovery が勝つ、(3) 追補 1-A の昇格、の 3 層。(3) が無いと、(1)(2) を通らない delete が discovery を吸収できた。

**追補 1-C：判断 3 の厳密化（`demandOnly` に Native の terminal receipt の条件を足す）**
- 問題：「work が無い cycle」は main の wire の話で、Native の話ではない。`maintenance_runtime.rs` の wire の work が空の wake cycle は、wake project ごとに `discover_cycle_work(.., "durable-wake", ..)` で durable な work を積んで走らせる。【推測】discovery が in-flight の間に、需要の cycle が durable な work を進め、in-flight の（古い空の）結果が返ると、基点では受理の `queueRetry`（`narrativeMaintenanceTriggers.ts` の注記）で chain が生きたが、この PR では受理が rediscovery を呼ばず chain が終わる。
- 判断：実装した（統合者の指示で、レビューの文言どおりの狭い形）。`demandOnly = (wire の work が空) && (送った wake が 1 件以上) && (その全件が demand) && (Native の terminal receipt があり、その works が空か、全件が Graph Index build)`。Graph Index build 以外の work を 1 つでも走らせた cycle は、status が failed でも `demandOnly=false`（基点と同じく rediscovery を呼ぶ）。理由は、基点より回復が遅れる場合を増やさないため。失敗した durable work を拾い直すのが、次の wake か discovery まで遅れる形を作らない。receipt は `onCycleAccepted` の前（cycle の応答の直後の cancel／adopt）に、既に `nativeTerminalReceipt` として手に入る。`works` は `{ workKey, status }` の配列で、Graph Index build の key は `narrative-maintenance:v1/nir1-graph-index-build/…`（Rust の `canonical_work_key`、`nir1_graph_index_maintenance.rs` の定数のコメントと試験の key）。`parseCanonicalMaintenanceWorkKey` は main が dispatch できる run kind だけを知るので、key の prefix で判定する。
- （取り下げた案）「succeeded でない work も skip する」案は、一度実装したが、上の理由で採らない。
- 信頼境界：receipt を読むだけで、main が build を dispatch・指名することは無い（`narrativeMaintenanceCiSeam.ts` の「Main never names B itself」は dispatch の話で変わらない）。新しい送信先・保存・契約は無い。
- 倒す向きと、閉じる範囲の訂正：receipt が無い場合（attempt の lifecycle を持たない adapter、再生された delivery）は `false`（基点と同じく rediscovery を呼ぶ）。実 Native の backend は `beginNarrativeMaintenanceAttempt`／`cancelNarrativeMaintenanceAttempt` を持つので `lifecycleEnabled` になり receipt が付く。skip する側を狭める変更だけで、budget を消費する側に倒れる（閾値の緩和ではない。不変条件「需要は、需要が無ければ呼ばれたはずの rediscovery を減らさない」は強まる）。**threat model の「経路が閉じる」の範囲の訂正**：閉じるのは、Native が何も走らせない、または Graph Index build だけを走らせた需要の cycle の budget の消費。需要の cycle が durable な chain の work（Verify・Backfill・Rebuild）を走らせた場合は、成功でも失敗でも rediscovery を呼び、budget を消費する（基点と同じ挙動）。
- 残余（budget）：失敗した work が続く回（planner が同じ結果を返し、需要の cycle のたびに同じ durable work が走って失敗する）では、需要の cycle が rediscovery の budget を使う。成功する work なら planner の fingerprint が動いて budget が戻ると読むが、実 Native では未測定。`electronRoute.test.ts` の budget の試験は、failed／succeeded の Verify を毎回載せる模擬（非現実の形）で rediscoveries が baseline より増えることを残余の特徴づけとして固定している。dev の測定（S-E。P1 の前後の、需要 wake あたりの rediscovery の消費数）で数字が出たら、この条件を見直す。
- 残る未確認：実 Native が wake-only cycle の receipt に載せる Graph build の key は、Rust の定数と試験の key からの読みで、実 Native の receipt では観測していない（外れていれば skip が働かず基点の挙動に戻るだけで、安全側）。
- 試験：`wakeOrigin.test.ts` の receipt の表（receipt なし→false、空→true、Graph build だけ→true、Verify が succeeded→false、Verify が failed→false、build＋Verify→false）。`electronRoute.test.ts` は実 bootstrap と実 scheduler の経路で、Verify を載せた demand の cycle は rediscovery を 1 回足し（discoveries 2）、build だけの cycle は足さない（discoveries 1）。budget の試験は、failed／succeeded の work を毎回載せる需要の cycle が rediscovery を使うことを残余として固定する。既存の demand 向け試験は、production の backend と同じ attempt lifecycle と receipt を持つ backend に変えた。

**追補 2（2026-11-19。F-1〔DR-PUBG-5-19、#954〕を取り込んだ後の組合せの確認）**

- 位置づけ：F-1 は `persistDeliveryFailure` の戻り（"accepted" | "project-missing" | "retained"）と、work・wake の retry の catch の分岐（project-missing なら retry count を消して trigger を捨てる）を変えた。本 DR の origin の保持・昇格・requeue と同じ catch に載るので、取り込み後の意味を読みと試験で確かめた。判断・数値・契約は変えない。
- 読み：wake は cycle の開始時（native 呼出しの前）に `durableWakeProjects` から delete されており、catch の retry 分岐と "retained" 分岐だけが `setDurableWake(…, sendingWakeOriginOf(projectId))` で戻す。"project-missing" の分岐は戻さないので、捨てた wake の origin は `durableWakeProjects` に残らない。捨てた cycle は失敗なので `onCycleAccepted` を呼ばず、rediscovery の判定には関わらない。cycle の途中に同じ key へ入った別の wake は生きている entry として残り、その origin で扱う。この「途中に入った wake は生きている entry として残る」は、試験「a %s wake dropped as PROJECT_MISSING keeps the live %s wake that entered the same key during the cycle, under its own origin」（discovery を捨てて demand が入る・demand を捨てて discovery が入る、の 2 組）で固定した。
- 試験（`wakeOrigin.test.ts`）：(1) discovery を捨てた後の同じ project への demand は `demandOnly=true`、demand を捨てた後の discovery は false（lingering な origin が merge に効かない）。捨てる間に `onCycleAccepted` は 0 回、queueIdle。(2) 同じ cycle で、捨てる wake と "retained" になる別 project の wake を載せ、後者が残った origin のまま単独で受理される（捨てた側の origin が影響しない。両方の組合せ）。project-missing の分岐で wake を requeue する変異で落ちることを確かめた。生きている entry を delete する変異（2 件が落ちる）と、捨てた側の origin を setDurableWake で漏らす変異（discovery を捨てて demand が入る組が落ちる）も、この試験で落ちることを確かめた。

### DR-PUBG-5-19：存在しない project の maintenance の wake が終わらない（F-1）の直し（2026-11-19）

- 位置づけ：PUB-G の前提 #5 の途中で見つかった別件の不具合 F-1。DR-PUBG-5-18（別の枝）が expected-fail の試験で記録したものを、直った状態を正で assert する試験に替える。この commit（最初の commit）は判断と信頼境界の記録で、コード・policy・定数は変えない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 委任と停止点：NIR-1 の C-product（worker／lifecycle の技術判断、委任の内の技術的な threat model の改訂）。枝 `claude/pubg5-missing-project-wake`（基点は origin/master `65deca68`）。push も PR も作らない。新しい送信先・保存範囲・閾値の緩和・契約・authority は足さない（下の threat model の差分）。
- 凍結の対象との関係：触れる file は `maintenance_runtime.rs`、`narrativeMaintenance.ts`、試験だけ。`native-architecture.mjs` の `FIXED_BODIES`（`nir1_graph_product.rs` の 4 関数の本体）と `PATHS` の対象 file、CP-4 の `SOURCE_PINS` の対象 file（harness の file）には触れない。

#### 1. 事実（再現。検証の節に結果を追記する）

- Native：wake の cycle は、project が workspace に無いと、launch が Closed・Seam・Product のどれでも `FOREIGN KEY constraint failed`（787）で失敗する。gate が閉なら `judge_graph_index_build` は DB に触れず skip する（`nir1_graph_index_maintenance.rs` の冒頭）ので、FK は通常の durable discovery から出る。discovery（`discover_durable_maintenance_work_in_tx_with_control`）は、project に current epoch が無く、wake の reason が `is_backfill_wake`（`durable-wake` を含む）なら、project の存在を見ずに Backfill の work を作る。その Backfill の run／epoch の行の insert が `projects` への FK で落ちる。
- N-API：delivery failure の receipt（`record_maintenance_delivery_failure_wake`）は project が無ければ `Err(NEX_MAINTENANCE_DELIVERY_FAILURE_PROJECT_MISSING)`。この Err は、audit の JSONL の追記（durable な receipt）の後、outbox の書込みの前に出る。
- main：scheduler は wake の cycle の失敗を `NARRATIVE_MAINTENANCE_MAX_RETRIES`（3）まで retry し、尽きたら `persistDeliveryFailure` を呼ぶ。receipt が reject されると `accepted === false` で trigger を保持し、再び queue に戻す（`workspace-binding-mismatch` などの typed non-ACK と同じ扱い）。PROJECT_MISSING の reject もここに落ちるので、約 1 秒ごとの cycle が止まらない。work のとき（`scope: "work"`）も同じ。1 時間の fake time で 4,270 cycle（DR-PUBG-5-18 の測定）。
- 今の製品の経路で届くか：main の scheduler は wake の発生源（Graph の需要、hasMore の継続、completion の wake）を区別しない。hasMore の継続と completion の wake、そして work の item は、Graph の const が false でも使われる。したがって、backlog の継続を持つ project をユーザーが削除すると、今の製品でも届く。

#### 2. 判断

**判断 1：直しは Native と main の両方に入れる（(a) と (b)）**
- (a) Native：discovery の Backfill を作る枝（current epoch が無く `is_backfill_wake`）で、同じ immediate transaction の中で `projects` の行の存在を読み、無ければ `Ok(None)`（no work）にする。wake の cycle は Accepted・`has_more` false で終わり、main は accepted の cycle として wake を消費する。これが wake の出所で終わらせる直しで、retry の log も JSONL の追記も増えない。FK 制約が有効なので、project が無ければ epoch・run の行も cascade で無く、他の枝（current epoch あり）には影響しない。
- (b) main：`persistDeliveryFailure` が、receipt の reject の message が code `NEX_MAINTENANCE_DELIVERY_FAILURE_PROJECT_MISSING` で始まる（既存の `hasExactFailureCode` の形）ときだけ、「project が無いので trigger を捨てる」終端として扱う（`work` と `wake` の両方）。retry の数（3）・遅延（1,000 ms）は変えない。(a) だけでは、work の item（その project の cycle が FK で失敗する）や、(a) の判定の後に project が消えた競合（判定は通り、実行で FK）を止められないので、(b) を足す。receipt を拒否したのは live な authority の同じ DB（binding が一致した後）の読みなので、renderer が偽造できる値ではなく、binding が違う・workspace が無いときは今までどおり typed non-ACK で保持する。
- (a) だけ、(b) だけにしない理由：(b) だけだと wake のたびに最大 3 回 retry して JSONL に 1 行足すまで終わらない（約 5 s）。(a) だけだと work の item と競合が残る。

**判断 2：project の存在の判定が変わる競合（実装の後に、コードを読んで訂正した 2026-11-19）**
- 判定は Native の immediate transaction の 1 snapshot。project の行は 1 つの transaction で commit されるので、commit 前の project はこの判定から見えない（見えないことは、存在しないとして no-work になることを意味する）。
- commit の前に wake が来ることがあるか：wake と work の project id の出所を読んだ。(1) workspace の列挙（`discover_projects` は `projects` の commit 済みの行を読む）、(2) wake outbox（`narrative_maintenance_wake_outbox.project_id` は `projects(id)` への FK で `ON DELETE CASCADE`。行があれば project がある）、(3) hasMore の継続と completion の wake（直前の cycle が処理した project の id）、(4) Graph の需要（owner が観測した project）。どれも commit 済みの行か、commit 済みの project に対する直前の結果から来る。commit 前の id を出す経路は、この範囲では見つからなかった。renderer の作成経路（独立レビュー、2026-11-19）は次の 4 つの根拠で閉じる：(i) `electron/main/index.ts` の注記（trigger の発見は main process が持ち、renderer は project の scope を渡さない）と、production で `scheduler.request(` を呼ぶ箇所が 0 件であること（test だけ）。renderer の SQL が project を作っても、maintenance の work を直接 main に渡す入口が無い。(ii) coordinator の wake の発生源は、Native の discovery（`discover_projects`）が commit 済みの `projects` の行から作るものである。(iii) wake outbox の `project_id` は `projects(id)` への FK で `ON DELETE CASCADE`（`migrate.rs`）。(iv) project の作成の書込みの進行中は、discovery の `BEGIN IMMEDIATE` は busy になり（no-wait の接続は `BUSY` の typed な失敗として main に返り、retry の対象）、「project が無い」とは判定されない。判定されるのは、作成の commit の前に snapshot を取れたときの「まだ無い」だけで、その id を持つ wake は上の (1)〜(4) のとおり commit の前には出ない。以前の挙動も同じ project に対し FK で 3 回（約 3 s）失敗するだけで、その後は receipt が PROJECT_MISSING で拒否されて回復しなかった。変更後に失いうるのは、その 3 s の窓の中の 1 回の wake だけで、新しい project の backfill は workspace-opened と project 自身の trigger が起こす。
- project の id：renderer が作る project の id は新規の id で、migration が seed する固定の `default-project` だけは同じ id が残る。同じ binding の中で削除の後に同じ id で再作成されても、古い wake が no-op の spurious な wake として 1 回 Accepted で消えるだけで、再作成された project の discovery は壊れない（Backfill は、その project の epoch が無ければ次の workspace-opened・wake で作られる）。
- scan の staging の project は行が既にあり、既存の判定（staging なら no-work）のまま。今回の変更に影響しない。
- (a) の後に project が消える競合は (b) で終わる（work・wake とも、尽きた後の receipt が PROJECT_MISSING）。

**判断 3：一時的な失敗は今のまま**
- busy・容量・`NEX_MAINTENANCE_TRANSIENT`・SQLite の lock・receipt の他の失敗（`INVALID`、typed non-ACK、message が exact な code でないもの）は、変えない。retry の上限・遅延・budget の数値は変えない（緩めない）。

#### 3. owner／lifecycle matrix（GDX-PRECHECK-001。新しい非同期・process・timer は足さない）

| 項目 | 扱い |
|---|---|
| entry | 既存の wake の cycle と delivery failure の receipt。新しい entry・IPC・`#[napi]` は無い |
| start | 変更なし。(a) は discovery の SELECT 1 本（Backfill を作る枝だけ）、(b) は既存の catch の分岐 |
| retry | 変更なし（3 回、1,000 ms）。PROJECT_MISSING の receipt の後だけ、その trigger は retry の対象から外れる |
| reentrant | 変更なし。捨てるのは (workspace binding, project) の key の entry 1 つだけで、他の key・他の project は独立 |
| admission closure | 変更なし。binding の不一致・workspace 無しの typed non-ACK は今までどおり保持 |
| pending start | 新しい timer は無い。捨てた trigger の retry の timer は、既存の経路（requeuedCount が 0 なら再 schedule しない）で作られない |
| active handle | 無い（同期の SELECT と、既存の await の中の分岐） |
| cancel | 変更なし（既存の permit の stop・attempt の cancel） |
| 有限待機 | 無い。wake 1 件は最大 retry 3 回＋receipt 1 回で終わる（以前は無限） |
| 終了の証拠 | cycle の Accepted の receipt（(a)）、または `persistDeliveryFailure` の終端の結果と retry count の削除（(b)）。quiescence の `queueIdle` が true になることを試験で確かめる。reject や kill だけを終了とみなさない |
| error／timeout／onClosed | cycle の FK 以外の失敗は今までどおり。receipt の PROJECT_MISSING だけが終端。warn の log に project id と code を出す（本文は出さない） |
| 再起動時の状態 | 新しい永続状態は無い。捨てた wake に対応する durable な行（outbox 等）は、FK の ON DELETE CASCADE で project と一緒に無い |

#### 4. threat model の差分（委任の内の技術的な改訂）

確認済みの actor・防御・受信先・受入れは変えない。
- 新しい攻撃：無い。偽の PROJECT_MISSING で正当な trigger を捨てさせる攻撃は、reject を作るのが Native の同じ authority の DB の読みで、renderer が値を注入できないので成立しない（main の backend は信頼境界の内側）。renderer が存在しない project の id を wake に載せられても（需要の経路）、今まで資源を消費し続けたのに対し、有限になる。
- 防御：変更前に無かった上限（wake 1 件につき cycle の数）が入る。receipt の JSONL への追記は、変更前は 1 周ごとに 1 行ずつ無限に増えた（保存範囲の拡大ではなく、バグによる増加）が、変更後は終端の 1 回。
- 受信先・保存：どちらも増えない。audit の JSONL は既存の書き先と形のまま。
- 受入れ：製品の既定（const false）の挙動は、存在する project の wake と work では変わらない。存在しない project だけが、無限の retry から終端に変わる。
- 委任の外に当たるもの（避けたもの）：retry の上限・遅延の変更、新しい receipt の status・契約、保存範囲の拡大、policy・定数の変更。

#### 5. 実装と検証の結果（2026-11-19。最後の code commit `a409415e`。§1 の「検証の節に結果を追記する」の分）

- **再現**：直す前に、(1) vitest（mock の backend。cycle は FK、receipt は PROJECT_MISSING の reject）で、wake（Graph の需要）・hasMore の継続・work の 3 つとも、fake time 600 s で 600〜601 cycle（上限は 5）。(2) Rust（実 DB）で、存在しない id と削除済みの id（`DELETE FROM projects` の cascade）の wake の cycle が、Closed・Seam・Product の 3 launch とも `FOREIGN KEY constraint failed: Error code 787`。main の discovery（workspace-opened）も、その project の Backfill の work を返していた。原因は、discovery が project の存在を見ずに Backfill を作ること。再現は層ごとで通しではない（main は mock、Native は実 DB）。
- **直した後**：同じ試験が通る（cycle は Accepted・`has_more` なし・registered／started／completed／grants が空、main は終端で `queueIdle`）。存在する project は Backfill を今まで通り作る（`a_wake_for_a_project_the_workspace_has_still_discovers_its_backfill`）。Native の試験で、receipt の message が JavaScript 側で `NEX_MAINTENANCE_DELIVERY_FAILURE_PROJECT_MISSING:` から始まり、wake の行は書かれないことを確かめた（main の先頭一致が製品の文字列で効く前提）。
- **変異**：Rust の存在確認を外す→3 本が落ちる。main の catch の分岐を外す→wake・hasMore・work の 3 本が落ちる。wake の枝だけ外す→wake と hasMore の 2 本。work の枝だけ外す→work の 1 本。どの reject も終端にする、先頭一致を部分一致にする→「PROJECT_MISSING 以外の reject は retry が続く」の 1 本が落ちる。いずれも戻して通ることを確かめた。
- **全件**：grimodex-db `--lib` 2,872 passed・0 failed・63 ignored。Native `--lib --features licensing,legacy-keyring-migration` 917 passed・7 ignored。clippy `-D warnings`（grimodex-db `--all-targets`、Native は同 features）成功。vitest（`vitest.electron.config.ts`、electron 全体）2,863 passed（cargo の build と同時に走らせた 1 回目は 3 件落ち、同じ commit の再実行 2 回で全件成功。負荷のときの揺れと見ているが、原因は特定していない）。tsc（`electron/tsconfig.json`・root）成功。`validate:architecture` 成功。
- **残る既知の挙動**：receipt は、JSONL の追記の後に project の存在を確かめて拒否する既存の順序のまま。終端になったので追記は 1 回。
- **追補（独立レビューの指摘、すべて低。2026-11-19）**：(1) 終端でない reject（busy、INVALID、先頭一致でない message、typed non-ACK）の保持の試験を、work と wake の両方で回す。wake の枝を `persisted !== "accepted"` で捨てる変異と、work の枝の同じ変異のそれぞれで赤になることを確かめた。(2) work と hasMore の試験の backend に `getNarrativeMaintenanceWorkspaceBinding` を足し、receipt の引数（scope、projectId、null でない workspaceBinding）を `toHaveBeenCalledWith` で固定した。(3) 上限は wake と work が 4 回（初回＋retry 3）、hasMore が 5 回（accepted の 1 回＋4）と正確にした。Rust の `missing_project_wake_problems` は、Closed の launch では main の discovery が `Idle` だけを許す。(4) project-missing の 2 つの枝の warn に、code と project id を出す（matrix の error の行と一致）。(5) 判断 2 の renderer の作成経路の「未確認」は、上の 4 つの根拠で閉じた。(6) 名指しの work が project の無い DB でどう終わるかを、Native（db の cycle）の試験で固定した（`a_named_work_item_for_a_project_the_workspace_does_not_have_ends_or_fails_on_the_foreign_key`）：Verify と Rebuild は Accepted・`has_more` なしで終わる（stale な item）、Backfill は `FOREIGN KEY constraint failed` で失敗する。この Backfill の失敗が、main 側の (b)（retry の後の PROJECT_MISSING の receipt を終端にする）が要る理由の 1 つ。
### DR-PUBG-5-18：旧 workspace の需要 event の隙（R-B）の読みの確認（2026-11-19。計画 `q5-graph-index-pre-switch-plan.md` §6 の (4)）

- 位置づけ：DR-PUBG-5-14 の R-B（旧 workspace の需要 event が新 workspace の binding で束縛される隙）が「読みによる限り実質無い」とした判断を、DR が「確かめていない」とした 3 点まで読み直した記録。この DR を残す commit ではコード・試験・policy・定数を変えない。`PRODUCT_GRAPH_PUBLISHED` は false のまま。
- 委任と停止点：DR-PUBG-5-13・5-14 と同じ（C-product の worker／owner／lifecycle の技術判断）。枝 `claude/pubg5-old-workspace-event-gap`（基点 origin/master `65deca68`）。push・PR・merge は統合者が後で行う。新しい送信先・保存範囲の拡大・閾値の緩和・新しい契約・authority は無い。
- 判定の基準（計画 §6.2）：hook で止める試験は判定に使わない。「E1（需要）を切替の途中で emit する経路が見つかる」または「hook なしの通常の経路で stale な通知が届く」なら binding を載せる。どちらも無ければコードは変えず、窓が無いことを固定する試験だけを足す。Electron を起動する観測（S-G）は行わない。

**読んで確かめたこと（`65deca68`。実行して確かめたものと、読みだけのものを分ける）**

1. 切替の経路（読み）。production で Core が別の workspace の `Ready(binding)` に入る経路は 2 つで、どちらも E2（`workspace:opened`）の emit が lifecycle の Ready 公開より前にある。
   - `open_workspace`：`finish_workspace_open_success`（`lib.rs`）が blocking の closure の中で E2 を emit し、closure が join した後に `publish_workspace_lifecycle_from_workspace_off_runtime` が Ready を公開する。
   - `restore_backup`：blocking の closure の末尾で E2（`reason: "restore"`）を emit し、join の後に同じ publisher が Ready を公開する。
   - E2 を出さない経路：`restore_recovery_candidate` は authority が公開されている間は拒否し（`restore_safe_mode_candidate`）、復元の後も authority を持たない（renderer が `open_workspace` を再実行する）ので、Ready に着かない。maintenance の recovery の reconcile（同じ authority が Ready に戻る）と `ensure_authority_ready`（互換・試験の installed authority）は、別の workspace への切替ではない。
   - 計画が 3 つ目に挙げる `discover`：`lib.rs` の discovery は event を出さず、binding と snapshot を取り直して、食い違えば `workspace-unavailable` で閉じる（fail-closed）。
2. main の binding getter（読み）。`getNarrativeMaintenanceWorkspaceBinding` は、Core が `Ready(binding)` のときだけ binding を返す（`resolve_workspace_snapshot`。`compatibility_switching` か `Transition` は `WorkspaceSwitching`、`RecoveryRequired`／`Closed` は fail-closed の Err）。したがって新しい binding が見えるのは Ready 公開の後で、E2 の emit はそれより前。E1 を main が受けた時点で getter が新 binding を返すなら、E2 は既に queue にある。
3. Suspended の 2 つの枝の emit（読み）。lock の外で emit するが、呼出し元はどちらも workspace participant を持つ。
   - Related Scenes（`begin_deferred`）：`begin_admitted` が participant を取り、`begin_blocking` の間持つ。
   - D-final（`begin`）：`request_graph` に渡す `ActiveWorkspaceSnapshot` が `_participant` を持つ。
   - `acquire_physical_exclusive` は `workspace_participants == 0` を要求する（`workspace_lifecycle.rs`）。DB の入れ替えと E2 の emit は physical exclusive の後なので、2 つの枝の E1 は E2 より前に queue へ入る（emit は `EventQueue` の mutex の下で `tsfn.call` するので、queue の順＝emit の順）。
   - 訂正：DR-PUBG-5-14 は「`demand`・`demand_deferred` は workspace operation の下」と書いたが、`begin_workspace_operation` は shutdown の計数で切替を止めない。切替を止めるのは participant。
   - 切替の後、Suspended の slot は Ready 公開で `ready_generation` が進むので、Suspended から答えず、新しい session を始める。
4. `build_worker` の枝（読み）。prepare の失敗の後、`retire_current`（worker の participant を放す）→ `edge_or_closed` の確認 → emit の順。`TransitionAdmitted` の edge は admission で epoch を進める（participants の drain の前）ので、確認を通れば切替はまだ admission の前。E2 より後に E1 が届く形は、owner thread が確認から emit までの間（participant を持たない）で切替の全期間止まる場合だけ。これが唯一残る窓。
5. TSFN の drain（一部だけ確認）。確認済み：emit の直列化（上の 3）。未確認：Node の TSFN が 1 回の callback で処理する件数の上限（手元の source で確かめられない）。ただし判定はこれに依らない。E1 が新 binding で処理される（＝ Ready 公開の後）とき E2 は既に queue にあるので、E1 の `setTimeout(0)` が E2 の `clearGraphDemands` より先に走るのは、queue が drain の上限を越えて分割される場合だけ。

**判断：窓なし。コードは変えない。**

- 根拠：2 と 3 で、E1 を切替の途中で（E2 の後に）emit する経路は、4 の「確認と emit の間の停止」を除いて見つからない。hook なしの通常の経路で stale な通知が届く形は無い。
- 残る極小の窓：4 の `build_worker` の枝だけ。閉じる案（記録のみ。この枝では入れない。`nir1_graph_product.rs` の行が動き S2 の行番号の注記がずれるため）：emit を `retire_current` の前へ移せば、worker が participant を持つ間に emit するので、E2 の前になる順序が因果で決まる（payload に binding を載せずに済む）。
- 載せる binding（計画 §6.3）は採らない。採る場合の設計（owner の binding の変換の置き場所、main の受信時と発火時の照合）は計画 §6.3 のとおりで、新しい `#[napi]` は足さない。

**害の上限（T-RB3。測った）— 別件 F-1：存在しない project の wake は終わらない**

- Native（`grimodex-db`、実行）：存在しない project の `wakeProjectIds` を持つ cycle（`run_system_work_cycle_with_nir1_graph_runtime_and_product`）は、launch が閉・seam・product のどれでも `Err(FOREIGN KEY constraint failed, code 787)` で終わる。
- main（vitest、scheduler。**最小の mock**〔attempt・ACK・terminal receipt の method を持たない〕。cycle は上の Err、`recordNarrativeMaintenanceDeliveryFailure` は `NEX_MAINTENANCE_DELIVERY_FAILURE_PROJECT_MISSING` で reject する mock。後者は `record_maintenance_delivery_failure_wake` の `ensure!`〔`restore_rebuild.rs`〕の読みで、Native の実呼出しは未実行）：cycle は 10 秒で 10 回、60 秒で 70 回、600 秒で 670 回、3600 秒で 4270 回。約 1 回／秒で止まらず、`queueIdle` は false のまま。`retryCount` が上限（3）を越えると `persistDeliveryFailure` が false を返し、wake が再 queue される（`narrativeMaintenance.ts` の wake の retry）。
- 到達：stale な event に限らない。需要の timer は最大 60 秒待つので、その間に同じ workspace で project が消えても同じ形になる。需要 event の経路は、const が false の間は Native が event を出さないので不活性。他の wake 源（hasMore の継続など、`durableWakeProjects` を作る経路）で今の製品に到達しうるかは未確認（Rust の probe は gate が閉でも FK で落ちた）。
- 扱い：この枝では直さない（(4) の範囲外で、retry の終端の意味を変える）。切替の前に直す候補として統合者へ報告する。直し方の候補：Native の wake が存在しない project を no-work の accepted で受ける、または main が `PROJECT_MISSING` の receipt の失敗を終端として扱う。試験は「望ましい形」を expected-fail で置き（vitest の `it.fails`、Rust の `should_panic`）、直ると赤になって印を外す形にする。
- 同名の project が新 workspace にある場合の害は、DR-PUBG-5-14 のとおり B の判定 1 回（`RefusedUnchanged` なら SQL だけ）で、需要の最短間隔（2 秒から 60 秒）で有界。

**委任の内外と GDX-PRECHECK-001**

- 内。Native→main の observer-only の内部 event の読みの確認と、試験だけの追加。新しい IPC・権限・保存先・送信先・閾値の緩和を含まない。
- owner／lifecycle matrix の差分：無し（コードを変えない）。threat model の差分：無し。F-1 は新しい攻撃面ではなく、既存の retry の終端の欠け（可用性）で、需要 event の経路では const が false の間は不活性（他の wake 源は未確認）。
- 試験（既存 file に足す。新しい file は作らない）：main の vitest（E1 と E2 を同じ tick で渡す／getter が throw の間／E2 の後の E1 は新 binding の 1 回）、Native の実 `open_workspace` による順序（旧 workspace の demand はすべて `workspace:opened` より前、切替の後の Suspended の slot は答えない）、D-final と同じ形で保持した participant の下では `workspace:opened` が queue に入らず open も終わらないこと（判定の 3 の要）、F-1 の expected-fail 2 本。hook で止める試験（T-RB1）は、窓が見つかって binding を載せた後の回帰試験なので、この枝には入れない。

**未確認**
- Node の TSFN の drain の件数上限、E1 と E2 が別 callback になる条件（実測していない。S-G は行わない）。
- F-1 の Native 側の receipt の失敗（`PROJECT_MISSING`）の実呼出し。
- 全 process の journey での stale な通知の件数（S-G。計画の測定は別）。

**実装の結果と検証（追補。2026-11-19。head は試験の commit `823176aa`。node は 22、`/home/grimodex/worktrees/Grimodex/pubg5-rb-gap` の cargo の target）**
- 製品のコード・policy・定数の変更：無し。`nir1_graph_product.rs`・`native-architecture.mjs` の `FIXED_BODIES`／`SOURCE_PINS` の対象 file には触れていない。`#[napi]` の doc コメントも変えていない（`pnpm napi:build` と `index.d.ts` の更新は不要）。
- 試験の効き（変異。戻した）：`workspace:opened` の `clearGraphDemands` を外すと、新しい vitest 1 本（E1 と E2 を同じ tick で渡す形）と既存の「a new workspace … clears」が落ちる。`ReadyPublished` の `ready_generation` の更新を外すと、実 switch の Native 試験が「stale な Suspended の slot が `registration-unavailable` を答えた」で落ちる。
- `vitest run --config vitest.electron.config.ts electron/main/narrativeMaintenance*`：17 file、348 件成功、1 件 expected fail（F-1）。
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib`（全件）：904 passed、0 failed、7 ignored。
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib nir1_graph_index_maintenance`：82 passed、0 failed（F-1 の `should_panic` を含む）。grimodex-db の全件は実行していない（変えたのは試験 file だけ）。
- `tsc --noEmit`：成功。`pnpm -s validate:architecture`：成功。`fnm exec --using=22 pnpm -s verify:quality`：成功（exit 0）。
- 実行していないもの：Electron を起動する観測（S-G）、Node の TSFN の drain の実測、F-1 の Native 側の receipt の実呼出し、clippy・`--features licensing,legacy-keyring-migration` の cargo test・hosted CI（Quick／Full）。

**レビューの反映（追補 2。2026-11-19）**
- 経路の列挙の根拠（上の 1）：Core が `Ready` を代入するのは `set_ready`・`activate`・`complete_unchanged`・`abandon_background_recovery` の 4 関数で、test 以外の呼出しは Native の adapter（`workspace_lifecycle_view.rs` の `ensure_authority_ready`・`complete_transition_from_workspace`・`abandon_background_recovery`）経由だけ。adapter の production の呼出し元（`lib.rs`、head なしで全件）：maintenance recovery の reconcile（`:3995`）、background recovery の失敗で同じ binding へ戻す枝（`:4118`）、`ensure_authority_ready`（`:4270`・`:9183`。互換）、`open_workspace`（`:11802`）、`restore_backup`（`:12285`）、`restore_recovery_candidate`（`:12437`）。別の workspace の authority が `Ready` に入るのは `open_workspace` と `restore_backup` だけで、どちらも E2 は Ready 公開の前。ほかは同じ authority（または authority を持たない）で、別の workspace への切替ではない。
- 判定の 3 の要（participant が E2 を止める）：`open_workspace_supervised`（`lib.rs:11664`）、`restore_backup`（`:12141`）、`restore_recovery_candidate`（`:12433`）は、blocking の closure の先頭で `acquire_transition_physical_exclusive` を取り、その後に入れ替えと E2 の emit が来る。試験 `a_held_workspace_participant_keeps_workspace_opened_out_of_the_queue` で、D-final と同じ形の participant を保持している間は、open が admit されても終わらず `workspace:opened` も queue に無く、drop の後に完了して E2 が入ることを固定した（保持しない変異で落ちる。戻した）。この試験は participant を保持する側の事実を固定するだけで、呼出し元（`begin_admitted`、D-final の `ActiveWorkspaceSnapshot`）が emit の間 participant を持ち続けることは読みのまま。
- 訂正（上の 2）：getter が binding を返すのは「Core が `Ready(binding)` のときだけ」ではない。`resolve_workspace_snapshot` には、Core が NoWorkspace で authority が入っている互換の枝（Tauri shell と legacy の startup 用）があり、Ok を返す。Electron の切替は Transition を通るので、切替の経路の判定は変わらない。
- 訂正（上の 4）：「emit を `retire_current` の前へ移す」案は、拒否された worker がその時点で participant を持つかを読んでいない。未確認の案として残す。
- F-1 の確認の範囲：N-API の実呼出し（`backend_with_workspace`、uncommitted の probe で実行し破棄）で、存在しない project の delivery-failure receipt は `Err(NEX_MAINTENANCE_DELIVERY_FAILURE_PROJECT_MISSING)`、attempt 付きの cycle は `Err(FOREIGN KEY constraint failed)`（`reconcile_narrative_maintenance_recovery` の後の 2 回目も同じ）で reject されることを確かめた。これは上の mock の応答と同じ形。scheduler の loop 自体は最小 mock で測ったもので、実 backend 全体（attempt の begin／cancel、terminal receipt を含む）での loop は未実行。
- 判定と F-1 の関係：「窓なし」の受入れは、F-1 が切替の前に直ることを前提にする。F-1 が開いている間、受け入れた残余（`build_worker` の枝の停止）の最悪は、同名の project が無い workspace で「B の判定 1 回」ではなく終わらない retry になる。
- F-1 の expected-fail 2 本（vitest の `it.fails`、Rust の `should_panic`）は (4) の範囲外の追加で、R-B の試験と独立に外せる（試験の commit `823176aa` の該当 2 hunk）。
- commit の trailer：task の指定（`Claude Opus 5.5`）に従った。この session に渡された attribution の指示は `Claude Sonnet 5.5` で食い違う。統合者が決める。

**最終の検証（追補 3。2026-11-19。head は追補 2 の commit `7cc33cff`。その後の commit はこの節だけを足す docs の commit。node は 22）**
- `fnm exec --using=22 pnpm -s verify:quality`：成功（exit 0。`7cc33cff` で実行）。`tsc --noEmit`・`pnpm -s validate:architecture`：成功。
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib`（全件）：905 passed、0 failed、7 ignored（participant の試験を足した後）。新しい Native の試験 2 本（実 switch の順序、participant の保持）を、`--test-threads=2` で 20 回続けて実行し、20 回とも成功。
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib nir1_graph_index_maintenance`：82 passed、0 failed（追補 1 の値。その後 grimodex-db は変えていない）。grimodex-db の全件は未実行。
- `vitest run --config vitest.electron.config.ts electron/main/narrativeMaintenance*`：17 file、348 件成功、1 件 expected fail（整形の後に再実行）。
- clippy：`cargo clippy -p grimodex-db --all-targets -- -D warnings` と、`cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings` が成功。
- eslint：変えた 2 file のうち `narrativeMaintenanceTriggers.graphDemand.test.ts` は 0 件。`narrativeMaintenance.test.ts` は基点にも 543 件の prettier の指摘が既にあり、足した部分は 0 件（足した部分だけを prettier で整形した。file 全体は整形していない）。
- 実行していないもの：`--features licensing,legacy-keyring-migration` の cargo test、grimodex-db の全件、Electron を起動する観測（S-G）、Node の TSFN の drain の実測、実 backend 全体での F-1 の loop、hosted CI（Quick／Full）。
