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
