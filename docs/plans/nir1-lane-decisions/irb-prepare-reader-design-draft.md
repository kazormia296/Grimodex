# IRB-READER の設計草稿（関連場面の IR の index build の prepare を専用の読取接続へ）

**草稿・未実装・計測の後に確定する。** この文書の判断（DR-IRB-3〜5）は仮の番号で、コードも計測も済んでいない。
**2026-11-06 の追記。** §2.2 の判断待ちの 3 行（K・E8・E13）はユーザーが決めた（§2.1 の 6、E8、E13。AskUserQuestion、1 回で）。E6・E7 は測定待ちのまま。DR-IRB-3 が要ることの根拠は DR-IRB-6（#810）の計測の第 2 回：第 6 版の g-ja-1 の最終の DB（候補 884）では DR-IRB-6 の後でも prepare が 10.0〜10.3 s で、renderer の read の IPC の期限（10 s）に余裕が無い（`irb-decisions.md` §4）。別セッション（grimodex-4a）の read-only の調査（`design-notes/research-2026-11-06/perf/`、repo の外。未確認）からの指摘は E7・E14 に注記した。
**番号の注意。** DR-IRB-2 は別の判断として既に存在する（snapshot の読込み失敗の付け替え。§2 の表と §9）。
審査（`irb-b-design.json`）は DR-IRB-2 を「計測」、DR-IRB-3 を「prepare の専用 reader」、DR-IRB-4 を「仕事を減らす」と呼んだ。
この草稿の番号：**prepare の専用 reader＝DR-IRB-3、仕事を減らす＝DR-IRB-4、publish の短縮＝DR-IRB-5**（2026-11-05 にユーザーへ示し、方向の承認を受けた番号）。計測は製品を変えない dev 用の作業なので DR の番号を持たない（審査の「DR-IRB-2＝計測」は、実装済みの DR-IRB-2 と衝突するので使わない）。
審査・advisor の文書を読むときは、この対応で読み替えること。
実装の前に §7 の計測を行い、その結果で §2 の採否を決め直す。読む側は、数値の「推測」を事実として扱わないこと。

出所は、PD 評価の本測定 第 5 版（`fusion-eval-data/pd-2026-11`、m-ja-2、117 Scene、2026-11-05）で見つかった、
IR の index build が native の単一の接続を長く握る件。DR-IRB-1（stage の receipt の audit の `COUNT` を scope の index で引く。
PR #805、commit `a40bb2a0`。`master` の `d45fa7e8` には未 merge）の記録は branch `claude/irb-audit-scope-index` の
`docs/plans/nir1-lane-decisions/irb-decisions.md` にある。この草稿の基点は `master` の `d45fa7e8`、
branch は `claude/irb-prepare-reader-design`。

材料は 3 案の審査（`scratchpad/irb-b-design.json` の `judged` と `designs`）。審査の主張はコードで読み直した。
結果は §1.5 に書く。評価 run を止めないため、cargo・pnpm・測定は実行していない。

**根拠と委任。** IRB は、`AGENTS.md` と `policies/quality/iron-laws.md` が U3 の委任の対象に挙げる残レーン
（C-resource、C-body、C-product、D-final 追補、D-transport、D-dispatch、H-store／H-current、DI-1、E）に含まれるとは確かめられていない。
「委任は NIR-1 の残レーンの外には適用しない」ので、IRB の判断は U3 を根拠にしない（DR-IRB-1・DR-IRB-2 の記録も 2026-11-05 にそう訂正した）。
DR-IRB-3（reader）と DR-IRB-4（仕事を減らす）は、**2026-11-05 にユーザーが方向を承認した**（「その方向で進めてよい」。実装は計測の後、
信頼境界は判断の記録に残す、audit 連鎖の検証範囲を変える案は数字の後に別に聞く、という条件つき）。
reader は background／async lifecycle の変更なので、**実装の前に GDX-PRECHECK-001 を通し**、有限の owner／lifecycle 行列（§2.2）を
mutation の前に置く。行列の未決の行が残る間は `[precheck]` で止める。
§8 では、委任の外になりうるものを分けて書く。

## 1. 事実（停止の構造）

略記：`NB`＝`electron/native/grimodex-node/src/related_scenes/build.rs`、
`NMC`＝`src-tauri/crates/grimodex-db/src/narrative_maintenance_connection.rs`、
`LIB`＝`src-tauri/crates/grimodex-db/src/lib.rs`、
`CI`＝`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index`。

### 1.1. 接続の握り方

| 事実                                                                                                                                                                                                                        | 確認した場所                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| native の DB の接続は `Mutex<Connection>` が 1 本。`Database` は path を持たず、`conn` は mutex の中                                                                                                                        | `LIB:279-292`、`LIB:313-376`                                                     |
| `build_once` は 3 つの段を、それぞれ `with_participant_read_transaction` で実行する。`rebuild_requested`（`NB:157-163`）、prepare（`NB:165-173`）、`read_reusable_chronicle_embeddings`（`NB:189-197`）                     | `NB`                                                                             |
| `with_participant_read_transaction` は `with_participant_sql_scope_fenced` に入り、`lock_conn_with_check` で mutex を取り、`BEGIN DEFERRED` の tx（`unchecked_transaction`）で operation を走らせる                         | `NMC:1226-1282`、`NMC:1470-1530`（mutex は `NMC:1512`）                          |
| progress hook に渡す `foreground_waiters` が `None`。前景の待ちを SQLite の途中で見ない。だから prepare は前景が待っていても mutex を手放さない                                                                             | `NMC:1527`（`None`）、`NMC:1046-1051`（`Some` のときだけ `ForegroundPreempted`） |
| IR の build の取得は前景扱い。取得の待ちでは `foreground_connection_waiters` を数え、保守に先を譲らせる。一度取った後は誰も preempt しない                                                                                  | `LIB:461-500`                                                                    |
| renderer の read は 10 s（`IPC_TIMEOUT_MS`）で caller だけが timeout する。mutex の待ちは期限なし                                                                                                                           | `src/lib/tauri.ts:19`                                                            |
| build の loop は、`Ready`／`Retry`／`Idle` で 250 ms 眠って繰り返す。`Err`・`Stopped`・join の失敗は全部 `_ => break` で、予約（`builds.reserve`）を解く。**reader の open 失敗を `Err` で返すと、再 build の予約が消える** | `NB:21`、`NB:45-57`（`_ => break` は `NB:54`）                                   |
| `Idle`（`rebuild_requested` が `Some(false)`）の周期は、短い 1 tx だけ。prepare には入らない                                                                                                                                | `NB:157-163`                                                                     |

### 1.2. prepare の中身と計算量

`prepare_chronicle_index_build_with_control`（`CI/build.rs:65-109`）→ `read_snapshot_with_control`（`CI/build.rs:116-`）。

| 段                                                              | 計算量（N＝reviewed revision の数、A＝audit の行数、R＝receipt の数）                                                                                                                               | 場所                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| epoch と `AlreadyUsable` の判定（`current_proof_with_control`） | proof が無ければ即 `None`。dirty なら binding の比較で早く `None`。完全な検査（roster と全 edge の再評価）に落ちるのは、binding が clean で `validated_read` が外れた稀な場合だけ（推測。計測する） | `CI/build.rs:84`、`CI/query.rs:217-234`、`CI/canonical.rs:56-`              |
| 前の pool の edge の `pending::read`（prior がある場合だけ）    | edge 数と Feed の page 数。prior がある場合の「早い PendingChange」はここ                                                                                                                           | `CI/build.rs:141-148`                                                       |
| roster の読み（`read_eligibility_source_with_control`）         | O(roster)                                                                                                                                                                                           | `CI/source.rs`                                                              |
| 候補ごとの `preflight_build_candidate`                          | O(N × 候補あたりの membership・root material・receipt の replay)。receipt ごとに `ai_audit_events` を引く                                                                                           | `CI/build.rs:174-182`、`stage_provenance.rs:922`、`stage_provenance.rs:960` |
| scope の preload                                                | 1 回                                                                                                                                                                                                | `CI/build.rs:191-205`                                                       |
| 候補ごとの `finalize_build_candidate_with_control`              | O(N)。候補ごとに単一の edge の評価（batch 版は使っていない）                                                                                                                                        | `CI/build.rs:206-218`                                                       |
| `pending::read`（新しい edge）                                  | page 数                                                                                                                                                                                             | `CI/build.rs:220-223`                                                       |
| `input_guard::read`                                             | **18 本**の query の全行の全 byte を SHA-256 に流す。artifact の `payload_json` を含む。O(関連 table の byte 数)                                                                                    | `CI/input_guard.rs:10-30`、`CI/build.rs:224`                                |

DR-IRB-1 の前は、`stage_provenance.rs:922`・`:960` の `COUNT(*)` が `ai_audit_events` の全件走査（写しの DB で 1 回 約 11.5 ms）。
receipt ごとに引くので、積は N に対して二次になる。DR-IRB-1 はこの二次の項を消す。
残る線形の項（候補あたり 約 20〜40 ms）は推測で、未計測（§1.5）。

### 1.3. publish の中身と計算量

`publish_chronicle_index_build_scoped`（`CI/publish.rs:80-104`）は、`db.with_participant_sql_scope` の中の
**IMMEDIATE tx**で動く。prepare と同じ mutex を握り、write lock も握る。

| 段                                                                                                                                                                                                               | 計算量                                              | 場所                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| epoch の照合                                                                                                                                                                                                     | 定数                                                | `CI/publish.rs:82`                        |
| `snapshot_current_with_control`：binding、semantic epoch、roster の再読、**`input_guard` の再計算（全 byte の SHA-256）**、language、`pending::read`、**全 edge の再評価**                                       | O(roster) ＋ O(関連 table の byte 数) ＋ O(edge 数) | `CI/publish.rs:85`、`CI/build.rs:240-292` |
| `verify_outcomes` → `verify_ai_audit_chain_for_scope(conn, Some(project), None)`：**project の scope の audit chain を sequence 1 から tail まで全件**検証する。1 行ごとに payload を検証・canonical 化・SHA-256 | O(A)。append-only で、減らない                      | `CI/audit.rs:25`、`ai_audit.rs:1896-1990` |
| 候補ごとの `verify_execution`                                                                                                                                                                                    | O(N)                                                | `CI/audit.rs:65-`                         |
| declaration の書込み、edge の削除と再記録                                                                                                                                                                        | O(edge 数)                                          | `CI/publish.rs:156-182`                   |
| **edge をもう一度全部評価**（`evaluate_owned_edges_from_db_in_tx_with_control`）                                                                                                                                 | O(edge 数)。`snapshot_current` と合わせて 2 回      | `CI/publish.rs:196-212`                   |
| ベクトルの DELETE と N 件の INSERT、候補ごとの `read_verified_evidence`（artifact の parse と digest）                                                                                                           | O(N)                                                | `CI/publish.rs:222-266`                   |

審査が挙げた 3 項目（`snapshot_current`、audit chain、`read_verified_evidence`）に、**edge の 2 回目の評価**と
**ベクトルの INSERT** を足す。時間は `NB:285-287` の `publication_ms` が debug tracing で出す。prepare より小さい保証は無い。

### 1.4. 写しの DB の規模（読み取りだけ。`m-ja-2-final.db`）

| 項目                             | 値                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ai_audit_events`                | scope は `project:fusion-ir` の 1 つで 26,381 行（最大 sequence も 26,381）。payload の合計 44.0 MB                          |
| stage の receipt                 | 1,452 件                                                                                                                     |
| `narrative_extraction_artifacts` | 1,166 件。`payload_json` の合計 15.1 MB（`input_guard` の 9 番目の query が全行を SHA-256 する。prepare と publish で 2 回） |
| `narrative_proposal_revisions`   | 982 件（reviewed revision の 483 件より多い）                                                                                |
| `narrative_dependency_edges`     | proposal-revision 2,455 件、semantic-index 307 件                                                                            |
| 異なる `run_id`（artifact 側）   | 106（483 ÷ 106 ≒ 4.6。審査の「run 単位の memo の上限は約 4 倍」と整合する。run の数え方が revision 側と同じかは未確認）      |

audit chain の検証は project の scope 全体なので、この写しでは table 全体と同じ規模になる。

### 1.5. 審査の主張の確認結果

確かめて、同じと分かったもの。

- prepare が mutex を握り続け、前景に譲らない（`NMC:1527`、`NMC:1046-1051`）。
- `NB:54` の `_ => break` が `Err` で予約を捨てる。
- publish が同じ mutex の IMMEDIATE tx で、audit chain の全件検証を含む（§1.3）。
- 案 2 の CAS（`snapshot_current_with_control`）は、DB の値の比較で、接続の identity に依存しない。
- `rebuild_requested` を reader の接続で呼ぶと、`current_epoch` が失敗側に倒れる（`CI/runtime.rs:68-75`、`CI/runtime.rs:131-140`）。
  runtime の `connection_epoch` は authority が作った `temp.grimodex_connection_meta` の値で、reader は別の接続だから一致しない。
  **ただし倒れ方は reader の作り方で変わる。** reader が `temp.grimodex_connection_meta` を作れば `Ok(Err(ConnectionChanged))` となり、
  `rebuild_requested` は `None` → `Stopped` → `NB:54` で loop が終わる。作らなければ `read_sqlite_source_revision`（`LIB:167-175`）が
  `no such table` の `Err` を返し、`current_epoch` は `?` で伝播して、`build_once` が `Err` → `NB:54` の `break` で予約が消える。
  どちらでも `rebuild_requested` は reader で呼ばない（§2.1 の 1・3）。
- D9 の理由は論理 ledger の一時見積りで、「2 本目の接続が危険」という判断ではない（`docs/plans/nir1-c-query-acceptance-2026-10.md:613`）。
- 本文だけの保存で Chronicle の index が dirty になる（`docs/plans/nir1-cp4-lapse-lane-design-draft.md:256` の「緩和の候補」の記述が、dirty にする現状を前提にしている）。

**確かめて直したもの。**

1. **「製品初の in-process の 2 本目の接続」は不正確。** workspace を開いた後、`open.rs:689-` の保守 thread が `Database::new_for_workspace_maintenance`（`open.rs:718`、`LIB:309`）で
   同じ process に**書込み可能な 2 本目**を開く（busy_timeout 0）。cross-process の共有 lease（`open.rs:705-707`）を持つ。
   `open.rs:725-750` のコメントは、2 本目の writer の commit が前景の deferred tx を `SQLITE_BUSY_SNAPSHOT` で落とした実例を残している。
   正しくは「NIR1 の runtime と participant に参加する in-process の 2 本目は初」「読取専用の 2 本目は初」。
   この前例は、reader を READ_ONLY かつ `query_only` に固定する理由にそのまま使える（§4）。
2. **`input_guard` の query は 17 本ではなく 18 本**（`CI/input_guard.rs:10-30`）。
3. **D の定数の置き場は確認済み。** `src/features/related-scenes/relatedScenesConfig.ts:13`（`RELATED_SCENES_IR_EXTRA_WAIT_MS = 40`）。
4. **二次式のフィットの精度。** 審査は「5 点とも ±15%」と書いたが、a＝20 ms／候補、b＝0.115 ms／候補／N で計算し直すと、
   N＝249 で 12.1 s（実測 10.3 s、+17.6%）。他の 4 点は −4.3%〜+6.0%。フィットは目安で、外挿
   （N＝3000 で 60〜120 s）は推測の域を出ない。
5. **「publish の中身」は審査より重い。** edge の 2 回目の全評価とベクトルの INSERT が加わる（§1.3）。
6. **審査も task 文も落としていた点。** `read_reusable_chronicle_embeddings` は `runtime.current_epoch(conn)` を呼ぶ（`CI/cache.rs:23`）。
   reader の接続に移すと、reader が `temp.grimodex_connection_meta` を持つ場合は `ConnectionChanged` が `Ok(Vec::new())` に畳まれ
   （`CI/cache.rs:23-26`）、**エラーにならずに全件を再 embedding する**。持たない場合は `current_epoch` の `Err` が伝播し、
   `build_once` が `Err` → `NB:54` で予約が消える。どちらの倒れ方も §2.1 の 4 で避ける。
   試験で気づきにくいので、§2 と §6 で明示する。
7. **`AlreadyUsable` を authority に残す費用。** 「キャッシュ命中なら ms 級」ではなく、§1.2 の表のとおり
   proof 無しなら即 `None`、dirty なら binding の比較で早く `None`。

**確かめられなかったもの。**

- 候補あたり約 20 ms の線形の項、`publication_ms` の絶対値と内訳、DR-IRB-1 の後の prepare の残り（いずれも未計測）。
- 候補ごとに `is_generic_freshness_canonical`（`field_authority.rs:254` から呼ばれる）や `get_current_epoch` を何回引くか。
- finalize の単一 edge の評価が、edge ごとに scope と authority を読み直すか。
- READ_ONLY の接続で、`project_scope_authority.rs:300` の `SAVEPOINT`／`RELEASE`、`pending::read`、`input_guard`、finalize が通ること。
  prepare の経路に書込みの SQL が無いことは grep で確かめた（`pending::read` の `INSERT`／`UPDATE` は試験の中だけ）が、実行はしていない。
- reader の open 費用、`cache_size` の最適値、prepare 中の `-wal` の大きさ。
- 審査の「`DR-IRB-2`」の中身。**当初の草稿は「docs と全 branch を grep して見つからなかった」と書いたが、誤り。**
  DR-IRB-2 は branch `claude/irb-snapshot-read-diagnostic`（origin にもある。`223f8c4c`、`3c46ff97`）の
  `docs/plans/nir1-lane-decisions/irb-decisions.md:27` にある別の判断で、「`projectSnapshotAdapter.ts` の catch で、読込み・転送の失敗と
  確かに分かる例外だけを `SNAPSHOT_SOURCE_READ_FAILED` にする」。計測ではない。審査の「DR-IRB-2＝計測」は番号の取り違えとみなし、
  計測は DR の番号を持たない。branch `claude/irb-prepare-timing`（計測用の dev commit `558e9b23` だけ。merge しない）は別にある。

## 2. 段階の計画

DR-IRB-3 以降の番号は草稿の仮番号。DR-IRB-1 と DR-IRB-2 は実装済み（PR 待ち。DR-IRB-2 は branch `claude/irb-snapshot-read-diagnostic`）。

| ID                 | 日付       | 判断                                                                                                                                                                                                                                                                                                                                                                                                   | 信頼境界                                                                                      | 代替案                                                                                                                                           | 状態                                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| DR-IRB-2           | 2026-11-05 | **（既存・この草稿の対象外）** `projectSnapshotAdapter.ts` の catch で、読込み・転送の失敗と確かに分かる例外だけを `SNAPSHOT_SOURCE_READ_FAILED` にする。fail-closed は保つ                                                                                                                                                                                                                            | renderer の例外の分類のみ。native・DB・IPC は変えない                                         | 付け替えを残す                                                                                                                                   | 実装済み（PR 待ち）。記録は `claude/irb-snapshot-read-diagnostic` の `irb-decisions.md:27` |
| （計測、番号なし） | 2026-11-05 | **計測だけ（挙動不変）。** 評価 run の終了後に、写しの DB で、publish の段別の時間と規模を測る。`NB:285-287` の tracing に段を足す。採否の分岐は §7                                                                                                                                                                                                                                                    | なし（tracing のみ）                                                                          | 計測せずに実装する（publish が支配的なら効果が薄いので避ける）                                                                                   | 草稿                                                                                       |
| DR-IRB-3           | 2026-11-05 | **prepare を専用の READ_ONLY 接続で行う（案 2a）。** 仕様は §2.1                                                                                                                                                                                                                                                                                                                                       | §4。READ_ONLY・`query_only`・proof を作らない・書かない・publish と install は authority だけ | (a) 前景に譲る slice 化（案 1。cursor の epoch 管理が要り、最大のリスク面）、(b) 版の列を足す（案 2b。migration を伴う新しい契約なので採らない） | 草稿（計測の後）                                                                           |
| DR-IRB-4           | 2026-11-05 | **仕事を減らす（案 3a）。** (i) 低リスクの持ち上げ：project 定数（`is_generic_freshness_canonical`、`get_current_epoch`）の候補ごとの再読を 1 回にする。`COUNT` の `EXISTS` 化。(ii) 計測で効けば：run 単位の memo、finalize の batch 化。memo は `read_snapshot_with_control` のスタックに閉じ、`BuildSnapshot` に入れない。成功の結果だけを入れ、ヒット時も 1 候補ごとに `control.check(Row)` を呼ぶ | native の読取の SQL と Rust の形だけ。検証の意味・fail-closed は変えない                      | CAS の定義を変える案（3b。委任の外になりうる）、debounce（3c。Q の値が IR の体験を変える。§8）                                                   | 草稿。DR-IRB-3 と並行できる（触る file が別）                                              |
| DR-IRB-5           | 2026-11-05 | **publish の短縮。** 計測で `publication_ms` が秒級のときだけ、独立の lane にする。(a) `read_verified_evidence` を reader 側へ移す（CAS が覆う入力だけを使えるか、`archived` が scene token に含まれるかの確認が要る）。(b) audit chain の検証範囲の変更（§8。**委任の外の可能性が高い**）。(c) edge の評価の重複の削減（`snapshot_current` と tx 内の評価の統合）                                     | (b) は信頼境界の変更                                                                          | 何もしない（publish が小さければ不要）                                                                                                           | 草稿                                                                                       |

### 2.1. DR-IRB-3 の仕様

次の形が最小で、境界が分かりやすい（実装前に §7 の結果で見直す）。

1. **authority の短い tx（既存の `rebuild_requested` の tx に同居させる）。** `rebuild_requested` が `Some(true)` のとき、
   同じ tx で (i) `admit_native_build(conn)`（`CI/runtime.rs:166-173`）で `(owner, runtime_epoch)` を取り、
   (ii) **tx の接続から** `SELECT file FROM pragma_database_list WHERE name='main'` で main database の path を読み、その path から
   file identity を計算し（`sqlite_database_path_in_tx`／`sqlite_database_file_identity_in_tx` は `maintenance_lifecycle.rs:589`・`:611-` にあるが
   crate 内限り。conn 引数版を `NMC` か `grimodex-db` の公開面に足すか、同じ SQL をこの tx に書く）、(iii) 現在の proof の判定（`AlreadyUsable`）を行う。
   `Some(false)` は `Idle`、`None` は `Stopped` のまま。**この 3 つは authority の接続に残す。**
   - **`WorkspaceAuthority::main_database_file_identity`（`state.rs:86-100`）は呼ばない。** 中で `self.db.with_conn` を呼んで Database の `Mutex` を取り直す
     （`LIB:810-814` の `with_conn` は `lock_conn`）。この tx の closure は同じ mutex を握っているので、std の `Mutex` は再入できず自己 deadlock する
     （`NMC:1243` の注釈も「mutex を握る callback から呼ばない」）。**訂正（§2.2.4）：** `build_once` の `request.database()` は `PinnedWorkspaceDb`＝`Arc<WorkspaceAuthority>`（`state.rs:167`）で、
     `path()`・`lease()`・`identity()` は見える。見えないのは `Database`（path を持たない。§1.1）の側。これらを使う reader の入口は `WorkspaceAuthority` 側に置く案も取れる。
   - **reader を開く path は、この tx から得た値だけを使う。** 別に組み立てた path や設定の path は使わない（`nir1_graph.rs:498` は `authority.path().join("grimodex.db")` だが、ここでは authority の実際に開いた file と同じものを使う）。
   - **`:memory:`**（関連場面の既存試験の fixture にある）は reader で開けない。path が `:memory:` か空のときの扱いは未決：
     (a) その試験の fixture を file の DB に直す（既定。製品の workspace は常に file）、(b) その場合だけ従来の authority の prepare を使う（製品に 2 本の経路が残る）。
     どちらでも `Stopped` で黙って落とさない。
2. **reader を `build_once` ごとに開閉する。** 長命にしない。置き場は `NMC` に `Database::with_participant_chronicle_reader` を足す案。
   - 開き方：`OPEN_READ_ONLY`。**順序は先行例（`nir1_graph.rs:498-507`、`nir1-c-query-worker.rs:207-216`）と同じ：**
     `busy_timeout` と pragma の後、`CREATE TEMP TABLE grimodex_connection_meta` と `INSERT` を行い、**そのあとに** `PRAGMA query_only=ON`。
     `query_only` の後では temp table の作成が拒否される見込み（推測。SQLite の文書は CREATE／INSERT を `SQLITE_READONLY` とする）で、先行例も前に行っているので、順序を逆にしない。
     temp meta を作る理由：作らないと `read_sqlite_source_revision` を呼ぶ共有コードが `no such table` の `Err` を返し、`build_once` の `Err` で予約が消える（§1.5）。
     作った場合も、その `connection_epoch` は runtime のものと一致しない（意図どおり。reader は `current_epoch` を通らない。§2.1 の 3）。
     `query_only=ON`。`DEFENSIVE`・`TRUSTED_SCHEMA=false`・`DQS_*` は authority（`LIB:313-335`）と同じ値にする（SQL の解釈を揃えるため）。
   - `busy_timeout` は 0 にする（`nir1-c-query-worker.rs:207-228` と同じ）。待たずに型付きの Retry にする。
   - `temp_store=MEMORY`、`mmap_size=0`、`cache_size` は未決（worker の `-128` は数千件の replay には小さい。`-16000` を出発点に計測する）。
   - 開いたあと、reader の file の identity が手順 1 の identity と一致することを確かめる。**不一致は `Stopped`**（authority が差し替わった）。
   - `Database::from_connection(reader)` で包めば、`with_participant_read_transaction` の hook・latch・cleanup をそのまま使える。
     `foreground_connection_waiters` と `connection_health` が authority と別になる。cleanup が失敗したら quarantine や retire ではなく、接続を捨てて `Retry` にする。
   - progress hook は participant の stop、deadline、runtime の `cancellation_epoch`（`CI/runtime.rs:190`。`nir1_entity_relation_index.rs:711` に前例）を見る。`foreground_waiters` は渡さない（`None`）。
3. **prepare の別入口を足す。** `prepare_chronicle_index_build_on_reader(conn, plan_epoch, ...)`。
   - `current_epoch(conn)` と `current_proof_with_control` を**通らない**。epoch は手順 1 の値を `plan.runtime_epoch` に入れる。
   - **reader では proof も `validated_read` も触らない。** `proof_current_observed`（`CI/canonical.rs:56-`）は proof に `ReadIdentity`（connection_epoch・total_changes・data_version）を書く。reader の値が入ると取り違えが起きる。
   - 入口は、手順 1 の opaque な値（owner と epoch の組）を引数に取る形にし、authority の admission を経ないと呼べないようにする。
4. **`read_reusable_chronicle_embeddings` は authority に残す**（既定）。reader に移すと §1.5 の 6 のとおり、temp meta がある reader では黙って空になり、無い reader では `Err` で予約が消える。
   候補ごとの index 付きの点検索で、N が大きいと mutex を握る時間が O(N) になる。費用は §7 の計測項目に入れる。
   重ければ、reader 用の別入口（`current_epoch` の代わりに手順 1 の epoch を使う）を足す。
5. **publish と `install` は変えない。** authority の IMMEDIATE tx で CAS（`snapshot_current_with_control`）を行う。
6. **エラーの型付き写像。** `NirIndexUnavailableReason` に reader 用の理由を足し（他の `match` への影響を確認する）、
   `NB:174-182` で `Retry` に写す。

   | reader の事象                                                                                              | 写像                                                                              | 理由                       |
   | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
   | open の失敗（file の不在・権限・IO）、`SQLITE_BUSY`／`LOCKED`（busy_timeout 0）                            | `Retry`。連続 K 回で `Stopped`（K は未決）と log                                  | 一時的。予約を残す         |
   | 手順 1 と reader の file identity の不一致、schema の不一致                                                | `Stopped`                                                                         | authority が差し替わった   |
   | participant の stop、generation の変更、runtime の epoch の変更で hook が止めた（`validation_terminated`） | `Err` → `Stopped`（epoch 変更は従来は `Stale`→`Retry`。製品では等価。§2.2 の E3） | 失効。予約を解くのが正しい |
   | reason の無い `SQLITE_INTERRUPT`                                                                           | `Retry`                                                                           | 想定外。予約を残して再試行 |

7. **reader は `build_once` の戻りまでに必ず drop する。** `PinnedWorkspaceDb` を持つ間（authority と共有 lease が生きている間）に閉じる。plan・proof・thread-local に接続を残さない。
8. **observability。** `NB:285-287` の tracing に、`reader_open_ms`、`stale_streak`、`prepare_ms` の段別、`outcome` を足す（§5）。

### 2.2. owner／lifecycle 行列（案。mutation の前に GDX-PRECHECK-001 で確定する）

reader は background／async lifecycle に新しい handle を持ち込むので、`policies/quality/iron-laws.md:90-95` が求める有限の行列を置く。
「終了の証跡」は kill 要求や error event ではなく、接続が実際に閉じたこと（`sqlite3_close` の成功。§2.2.2 の E5）。
**この行列はコードと lifecycle の読みから埋めた案で、試験はまだ無い。** 状態が「判断待ち」「測定待ち」の行が残る間は `[precheck]` で止める。
外部送信・subprocess・onClosed は reader に無い（§2.2.3）。

略記：`WL`＝`src-tauri/crates/grimodex-db/src/workspace_lifecycle.rs`、`ST`＝`src-tauri/crates/grimodex-db/src/state.rs`、
`WLV`＝`electron/native/grimodex-node/src/workspace_lifecycle_view.rs`、`LN`＝`electron/native/grimodex-node/src/lib.rs`、
`RS`＝`electron/native/grimodex-node/src/related_scenes.rs`、`REG`＝`electron/native/grimodex-node/src/related_scenes_build_registry.rs`、
`BEG`＝`electron/native/grimodex-node/src/related_scenes/begin.rs`、`RT`＝`CI/runtime.rs`、`PUB`＝`CI/publish.rs`、
`IG`＝`CI/input_guard.rs`、`RB`＝`src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/build.rs`
（`NB`・`NMC`・`LIB`・`CI` は §1 の略記）。

#### 2.2.1. 状態の一覧

| 行  | 事象                                                        | 状態                                               |
| --- | ----------------------------------------------------------- | -------------------------------------------------- |
| E1  | 入口・開始・pending-start、admission の閉鎖（開く前の条件） | 案あり                                             |
| E2  | retry／再入（loop、generation の回転）                      | 確認済み（草稿の前提を訂正。許容を明記する）       |
| E3  | stop・epoch・shutdown による取消しの伝わり方                | 案あり（epoch の写像は製品の呼び手が無いので等価） |
| E4  | open 中に stop が入る                                       | 案あり                                             |
| E5  | 生きている handle の所有、実際の終了の証拠                  | 案あり（証拠の取り方を `close()` の成功へ変更）    |
| E6  | cancellation の粒度                                         | **測定済み（2026-11-06）：1 候補の preflight の最大は約 40 ms → (a) を採る（コード変更なし）** |
| E7  | bounded wait（transition・shutdown が待つ時間）             | 候補あり（待つ側に 2 s。停止遅延の見積り 100 ms 台の 10 倍以上、main の 30 s より十分短い。段 2 の試験 (p) で確定） |
| E8  | cleanup 失敗・close 失敗                                    | **決定（2026-11-06 ユーザー）：(a) その authority の reader を二度と開かない（fail-closed）** |
| E9  | panic                                                       | 確認済み（草稿の「guard の Drop に頼る」を訂正）   |
| E10 | `build_once` の戻りの全経路                                 | 案あり（構造で保証する）                           |
| E11 | error／timeout の所有と写像                                 | 判断待ち（K）                                      |
| E12 | 永続する restart の状態                                     | 確認済み                                           |
| E13 | reader の同時数（新設）                                     | **決定（2026-11-06 ユーザー）：authority あたり 1 本の slot** |
| E14 | authority の健全性・共有 lease との関係（新設）             | 案あり                                             |

#### 2.2.2. 行ごとの案

owner の連鎖（読んで確かめた事実）：

- `begin` が participant を取り（`BEG:46-50`）、`schedule` がそれを loop の task へ move し（`NB:11`、`NB:39`）、task は **loop 全体と 250 ms の眠りの間も**保持する（`NB:32-58`）。
  count は `WL:1735` で増え、`WL:912-917` の Drop（`WL:1760-1763`）で減る。
- 待つ側：transition の physical exclusive は participant が 0 であることを要求する（`WL:3741`）。native の待ちは **2 ms 刻みで上限が無く**（`WLV:378-386`）、
  open／restore／recovery-restore の 3 入口が使う（`LN:11173-11175`、`LN:11649-11652`、`LN:11941-11944`）。shutdown も 10 ms 刻みで上限が無い（`LN:3790-3798`。コメントのとおり main の 30 秒の観測枠は native の fence を解かない）。
  **reader の停止遅延は open／restore／shutdown の遅延にそのまま乗り、止まらない reader は hang になる。**
- `request.database()` は `PinnedWorkspaceDb`＝`Arc<WorkspaceAuthority>`（`ST:167`、`src-tauri/crates/grimodex-semantic/src/runtime.rs:185` の `SemanticRequest::database`）。`WorkspaceAuthority` は `path()`（`ST:68`）と共有 lease（`ST:72`）を持つ。
  build の task は `request` をこの Arc ごと loop の間保持するので、**reader が開いている間は authority と共有 lease が必ず生きている**（reader 専用の lease は要らない）。

##### E1 入口・開始・pending-start・admission の閉鎖

- **決め方。** 入口は 2 つだけ（grep 済み）：`BEG:294-296`（`snapshot.supported_profile && current_request`）と `RS:378-396`（`reconcile`。napi は `LN:12950`）。どちらも `build::schedule`（`NB:8-66`）に集まる。
  開始の順は `current_request`（`NB:14`）→ `reserve`（`NB:17-24`）→ `tokio::spawn`（`NB:28`）で、reserve と spawn の間に失敗しうる処理は無い（予約の取り残しが無い）。
  **pending-start（予約〜blocking pool で `build_once` が走り出すまで）は participant と予約だけを持ち、reader を持たない。** reader を開くのは `build_once` の中だけ（`NB:146`）。
- **開く前の条件（admission の閉鎖）は 3 段。** (1) `NB:153` の `current_request`：transition 中は `active_database` が `begin_workspace_participant` の `ActiveOperations`（`WL:1721-1733`、`ST:419-435`）を受けて `false` になり、`Stopped`。
  (2) 手順 1 の authority tx：入口の `check_participant`（`NMC:1488`）が stop を `Err` にする。(3) 手順 1 が `Some(true)` を返したときだけ reader を開く。
  `Idle` と `AlreadyUsable` は reader を開かない（reader の open は `Some(true)` かつ proof が無い場合だけ）。
- **試験案。** (d) に「stop 済みの participant では reader を開かない（open 数 0）」を足す。`current_request` が `false` になる transition 中の `build_once` が `Stopped` を返し、open が 0。
- **未決。** なし。

##### E2 retry／再入

- **決め方。** 反復ごとに reader を開き、`build_once` の戻りまでに閉じる（反復をまたいで保持しない）。loop は `Ready`／`Retry`／`Idle` の後に 250 ms 眠る（`NB:44-57`）。眠っている間は reader を持たず、participant と予約だけを持つ。
- **草稿の前提の訂正。** 草稿の E2 は「同じ project の同時の `build_once` が無い」を実装時の確認としたが、**成り立たない場合がある。** 予約は `(authority の identity, project)` と generation で管理され、
  新しい generation が来ると `keys` を消して取り直せる（`REG:26-30`。`REG:5-6` のコメントのとおり、置き換えられた旧 job は後から終わる）。旧 generation の `build_once` は、`NB:116` の generation 比較か hook で止まるまで reader を持つ。
  つまり **同じ project で旧と新の 2 本の reader が一時的に共存しうる**。どちらも読むだけで、書込みの競合は無い。
- **許容するか上限を置くか。** E13 の「authority あたり 1 本」を採れば共存しない（新が `Retry` で待つ）。採らないなら、共存を許容と明記し、試験 (q) で上限（`CAPACITY`＝128 ×2 generation、`RS:35`）を確かめる。
- **試験案。** (q)：generation を回転させ、旧の `build_once` が走行中のまま新の `schedule` を呼ぶ。open 数の最大値と、両方が戻った後の 0 を確かめる。
- **未決。** E13。

##### E3 取消しの伝わり方（stop・epoch・shutdown）

- **stop の集合。** `WorkspaceParticipant::stop_requested`（`WL:622-637`）は shutdown_requested、compatibility_switching、Transition、RecoveryRequired、Closed のどれかで true。
  transition の admission が `stop_for_workspace_transition` を呼ぶ（`LN:2660`）。shutdown は `request_shutdown`（`LN:11371`、`WL:1937-1960`）の後に `finish_workspace_shutdown`（`LN:11377`）を走らせる。
  **したがって shutdown の前に `shutdown_requested` が立つ。** hook の `participant_termination`（`NMC:1026-1032`）→ `SQLITE_INTERRUPT` → `map_interrupted_error`（`NMC:1192-`）で `validation_terminated` になる。
- **runtime の epoch。** `cancellation_epoch` は `bind_embedding_generation`（`RT:211`）と `pause`／`resume`／`stop`（`RT:245`）が回す。hook 側の受け口は既にある：
  `NarrativeMaintenanceGraphControlConfig.workspace_generation: Option<(Arc<AtomicU64>, u64)>`（`NMC:250`、比較は `NMC:1033-1040`）に `(runtime.native_build_cancellation_epoch(), admitted_epoch)` を渡せる。
  新しい field は要らない。ただし `with_participant_read_transaction` の既定の config はこの slot を使わない（`NMC:1244-1258` は `ParticipantSqlControl`（`NMC:278-281`）の stop と deadline だけ）ので、reader の入口（`with_participant_chronicle_reader`）が config を組む。
- **epoch 変更の写像は、製品では等価。** 今の動きは「epoch が変わっても prepare は最後まで走り、publish が `Stale`（`PUB:82-84`）→ `Retry`」。reader が hook で早く止めると `Err` → `NB:54` の `break` に変わる。
  差を見る：製品で Chronicle runtime の `pause`／`resume`／`stop` を呼ぶ箇所は **grep で見つからない**（`nir1_entity_relation_index.rs:1017` と `nir1_entity_relation.rs:11242-12327` は試験）。
  製品で epoch が回るのは `bind_embedding_generation` だけで、これは generation の回転でもあり、`current_request` が `false`（`NB:153`）になるので、`Retry` でも次の反復で `Stopped` になる。**どちらでも loop は止まる。**
  この等価は「製品の呼び手が無い」という grep の結果に依存する。呼び手が増えたら `Retry` へ写す（reader の写像表の 3 行目を `Retry` にする）。回帰の防ぎ方は試験 (i)。
- **publish 側の再照合。** 草稿が引いた `native_build_is_current` ではなく、publish は `PUB:75-77`（owner）と `PUB:82-84`（`current_epoch(conn)` が plan の epoch と一致するか）で再照合する。reader の結果は authority の IMMEDIATE tx でしか効力を持たない。
- **試験案。** (i)：手順 1 の後に generation を回す／participant を stop する。publish が `Stale` か `Stopped` で、proof が install されない。(d)：hook が `SQLITE_INTERRUPT` で止め、reader が閉じる。
- **未決。** なし（等価の前提を PR 本文に残す）。

##### E4 open 中の stop

- **決め方。** open は短い同期処理（file を開き pragma と temp meta を作るだけ）。open 後に `with_participant_sql_scope_fenced` の入口が `check_participant`（`NMC:1488`）を再度行うので、
  open の間に入った stop はここで `Err` になり、reader は呼び出し側の scope の終わりで閉じる。**open 直後に別の stop 確認を足す必要は無い**（草稿の「open の前後で `stop_requested` を見る」のうち後ろは scope が担う）。前の確認だけ、無駄な open を避けるために置く。
- **注意。** `Database::from_connection`（`LIB:285-293`）は pragma も temp meta も作らない。open 側で自前の設定（§2.1 の 2）を行う。
- **試験案。** (d)：open 直後（scope に入る前）に stop を立てる hook（試験用の failpoint）で、`Stopped` と open 数 0。
- **未決。** なし。

##### E5 生きている handle の所有と終了の証拠

- **所有者。** reader は **`with_participant_chronicle_reader` の関数の中の局所**にする（closure 形式。guard を返さない）。`build_once` の他の段（embedding、publish）は reader を見ない。
  drop の順は Rust の規則で、reader → `build_once` の戻り → `spawn_blocking` の closure が持つ clone（`NB:36-39`）→ task が持つ `request`・`participant`、の順に必ず外側が後になる。
  plan・proof・thread-local・`Arc` に接続を渡さない（`BuildSnapshot` は値だけ）。
- **終了の証拠。** rusqlite 0.40.1 の `Drop for InnerConnection` は `close()` の結果を捨てる（`inner_connection.rs:400-406`）。つまり **drop は終了の証拠にならず、失敗すれば handle と file が残る。**
  証拠は「`sqlite3_close` が成功したこと」にする。reader を包んだ `Database` に対し、scope の後で `retire_connection_for_recovery()`（`NMC:1602-`）を明示的に呼ぶ。`Ok(())` が close の証拠、
  `Err`（`NEX_MAINTENANCE_CONNECTION_RETIREMENT_CLOSE_FAILED`）と `retirement_close_pending()`（`NMC:1641`）が未証明を表す。
  生きている reader の数は、runtime の `AtomicUsize`（E13 の slot と同じ）に持ち、**close の証拠を得た後にだけ**減らす。
- **観測の窓口。** `foreground_connection_waiter_count`（`NMC:1689`）と同じ `#[doc(hidden)] pub` で、cross-crate の試験が読める。
- **試験案。** (d)：戻り値別（`Ready`／`Stale`／`PendingChange`／`Idle`／`Stopped`／`Retry`／`Err`）に open 数 0。
  (r)：OS の証跡。Linux は `/proc/self/fd` で `grimodex.db` を指す fd の数が build 前と同じ（authority の分）に戻る。Windows は build 後に DB file の rename が通る（hosted の 3 OS で）。
  順序の証跡：participant 数を先に読み、0 のときに reader 数を読むと必ず 0（participant の admission は transition 中に閉じているので reader は増えない）。これを transition の試験の中で繰り返し検査する。
- **決定（2026-11-06 ユーザー）。** E8 は (a)。permit は close の証拠の後にだけ戻す。

##### E6 cancellation の粒度

- **確認した事実。** hook の間隔は 1,000 VM step（`NMC:1524`）。**ただし SQLite の progress handler は 1 つの statement の通算 step で数える**（推測。SQLite の `vdbe.c` の実装による。試験 (p) で確かめる）ので、短い statement は hook が一度も呼ばれない。
  Rust 側の `control.check` は `read_snapshot_with_control` の段境界、候補の loop（`CI/build.rs:175-179` と `:206-218`）、`input_guard` の行ごと・8 KiB ごと（`IG:44`、`IG:51`、`IG:68`、`IG:76`）にある。
  **一方、`preflight_build_candidate`（`RB:70-75`）は `control` を受け取らない**（`RB` の control の出現は `finalize_build_candidate_with_control` 側。`material_membership_root.rs` と `stage_provenance.rs` の replay も 0 件）。
  よって **取消しが効くまでの最長の区間は「1 候補の preflight」**（root_material の hydrate と receipt の replay。平均は 10.2 s／491 候補＝約 21 ms。最大は未測定）。
- **決め方。** 次のどちらか。(a) 1 候補の preflight の最大値を測り、その値を E7 の導く値として受け入れる（コード変更なし）。(b) `preflight_build_candidate` に `control` を渡し、候補内の replay の境界で確認する（grimodex-db の読取経路のシグネチャ変更。意味は変えない）。
  **推奨は (a)** で、最大値が大きければ (b)。
- **試験案。** (p)：preflight の途中で stop を立て、reader の close までを測る（写し 2 つ。最大の 1 候補の preflight の ms も同時に測る）。dev 枝 `claude/irb-prepare-timing` の計測の仕掛けを使える。
- **測定済み（2026-11-06、第 6 版の run の後。計測用 worktree の `preflight.one` の `max_ms`〔1 候補の最大〕、REPS=2、release、写しの DB）。** 1 候補の preflight の最大は、g-ja-1 第 6 版（候補 884）28.4〜28.5 ms、m-ja-2 第 6 版（551）20.4〜27.6 ms、m-en-1 第 5 版（roster 509）35.0〜40.3 ms。`snapshot.input_guard` は 1 回 125〜172 ms だが、行ごと・8 KiB ごとに `control.check` がある。**(a) を採る**：取消しが効くまでの最長の区間は約 40 ms で、コードは変えない。最大値は E7 の停止遅延の見積りに使う。

##### E7 bounded wait

- **待つ側に上限が無い**（上の連鎖）。したがって上限は待つ側で決めず、**reader の停止遅延として導く**：
  `max(hook の間隔に相当する SQL の時間, 1 候補の preflight の最大, input_guard の 8 KiB 区間)` ＋ cleanup（`NMC:1093-1140` の progress 解除と rollback、`retire_connection_for_recovery` の close）。
- reader は participant の内側で開閉する（E5）ので、上の遅延が過ぎれば participant が外れ、physical exclusive が通る。Windows の restore で file が掴まれたままにならないのは、この順序による。
- **試験案。** (p) の測定値を記録する。**値の上限は測定の後に決める（今は書かない）。** main の 30 秒の観測枠（`LN:3787-3788`）よりずっと小さいことを確かめる。
- **候補（2026-11-06）。** 上限は待つ側（transition の physical exclusive の待ち、shutdown）に置く。reader の停止遅延の見積り＝max(1 候補の preflight の最大 約 40 ms〔E6〕, `input_guard` の 8 KiB 区間, hook の間隔分の単一 statement)＋cleanup ≒ 100 ms 台（推測。cleanup と最長の statement は未測定）。待つ側の上限の候補は **2 s**（見積りの 10 倍以上、main の 30 s の観測枠より十分短い）。超えたら待つ側が先に進む（強制）。値は段 2 の試験 (p)（stop から reader の close まで）で実測して確定する。
- **別セッションの調査の指摘（2026-11-06、`design-notes/research-2026-11-06/perf/irb3-reader-prior-art.md`、未確認）。** 一般の慣行は、待つ側に上限を置き、外側の猶予（main の 30 秒の観測枠）より短くし、超えたら強制する（k8s 30 s、Docker 10 s、systemd 90 s）。上の「reader の停止遅延として導く」は向きが逆で、測定の後は待つ側の上限として置き直す。E6 については、SQLite の命令数の progress は時間の保証にならない（COUNT で 100 tick の確認まで 25 s の例）ので、Rust 側の候補 loop の最大値に、最長の単一 statement の時間を加える。

##### E8 cleanup 失敗・close 失敗

- **既存の動き。** `Database::from_connection(reader)` を `with_participant_*` に通すと、cleanup（rollback・progress 解除・busy_timeout の復元）の失敗は **reader 側の `Database`** に `quarantine_connection`（`NMC:1549-1560`）と
  `retire_connection_for_recovery`（`NMC:1564`）を走らせる。authority の `connection_health` は別のインスタンスなので触らない。草稿の「quarantine や retire にせず」は「**reader 自身の health にだけ**」と書き直す。
  この自動の retire は reader の close そのものなので、むしろ E5 の証拠に使える。
- **判断が要る点。** close の証拠が取れない（`retire_connection_for_recovery` が `Err`）とき、handle は `retired_connections` に残るだけで、drop しても閉じない（E5）。選択肢：
  (a) その authority の reader を二度と開かない（slot の permit を戻さず、`Retry`→K 回で `Stopped`。error を log に 1 回）。authority を開き直す（workspace の再 open）まで Chronicle の build は止まる。fail-closed。
  (b) 閉じるまで同じ reader を保持して再試行する。participant を持ち続けることになり、transition を止めるので採らない。
  **推奨は (a)。** C-query の process 寿命の fence（`WL:546-554` の `WorkspaceQuarantineFence`）と同じ考え方（cleanup を証明できなければ解放しない）。
- **試験案。** (e) に「cleanup の failpoint（`MaintenanceCleanupFailpoint`、`NMC` の試験用）で reader が使えなくなり、authority は `connection_reusable()`＝true のまま」を足す。
- **決定（2026-11-06 ユーザー）。** (a) を採る（fail-closed。permit を戻さず `Retry`→K 回で `Stopped`、error を 1 回 log。workspace の再 open まで Chronicle の build は止まる）。

##### E9 panic

- **訂正。** 草稿の「guard の `Drop` で閉じる（`catch_unwind` に頼らない）」は不正確。(1) drop は閉じた証拠にならない（E5）。(2) 既存の scope が 2 段の `catch_unwind` を持つ：
  内側（`NMC:1067`）が cleanup を済ませて `resume_unwind`（`NMC:1179`）、外側（`NMC:1520`）が reader 側の `Database` を `quarantine`＋`retire`（`NMC:1539-1543`）してから `resume_unwind`（`NMC:1546`）する。
  よって operation 内の panic では **scope が reader を explicit に close してから unwind する**。
- **戻りの扱い。** panic は `spawn_blocking` の `JoinError` になり、`NB:54` の `_ => break` で loop が終わり予約が解ける（`NB:59-63`）。**この経路は authority の `connection_health` を変えない**（今の authority の prepare で panic すると authority が quarantine＋retire されるのと違い、reader 版は影響が reader に閉じる。利点）。
- **前提の確認。** `Cargo.toml` に `panic =` の指定は無い（grep 済み）ので既定の unwind。`.cargo/` には `audit.toml` だけ。
- **試験案。** (s)：operation 内で panic を起こす（試験用の hook）。reader 数 0、`retirement_close_pending()==false`、authority の `connection_reusable()==true`、`builds` の予約が解ける。
- **未決。** なし。

##### E10 `build_once` の戻りの全経路

- **決め方。** E5 の構造（reader が関数の局所）で、`Ready`／`Stale`（`Retry`）／`PendingChange`（`Retry`）／`Idle`／`Stopped`／`Retry`／`Err`／panic のどの戻りでも、reader は `build_once` の次の段（embedding、publish）より前に閉じ済み。
  `NB:157-173` の authority tx と reader の呼び出しは別の呼び出しで、reader の呼び出しの戻りが先に来る。
- **試験案。** (d)（E5 と共通）。**`build_once` には現状で直接の試験が無い**（grep 済み）。fixture は `nir1_generation_owner_tests.rs` の `AppState` の組み立てが前例。試験の費用が大きいので、(d)(e)(i)(q)(s) を 1 つの harness にまとめる。
- **未決。** harness の置き場（`related_scenes/build.rs` の `#[cfg(test)]` か、別 file）。

##### E11 error／timeout の所有と写像

- **分類点は `NB:173` の `?`。** 今は wrapper の `Err` が全部 `?` で `NB:54` に落ちる。reader 版は wrapper の戻りを分ける：
  `ValidationTerminated`（`source_revision.rs:152-157` の型。`downcast_ref` で判別）→ 従来どおり `Err`（`Stopped`）、
  それ以外の open 失敗・`SQLITE_BUSY`／`LOCKED`（busy_timeout 0）・cleanup 失敗→ `Retry`。§2.1 の 6 の表のとおり。
- **transition 中に `Retry` で空回りしない理由。** 手順 1 の authority tx が `NMC:1488` の `check_participant` で先に `Err` になり、reader の分類に届かない。
- **timeout。** reader には wall-clock の deadline を置かない（`ParticipantSqlControl::default()` は deadline 無し、`NMC:283-289`）。prepare は O(N) の仕事で、今の authority の prepare も deadline を持たない。新しい上限を足すと挙動が変わる（閾値の追加）ので足さない。
- **K（連続して `Retry` が続く回数の上限）。** **K＝40（2026-11-06 ユーザー）**：250 ms × 40 ≒ 10 秒で、renderer の read の IPC の期限と同じ長さ（永続する失敗を 10 秒以上繰り返さず、一時的な BUSY は 10 秒まで待つ）。永続する open 失敗（権限・file の不在）を `Retry` で 250 ms ごとに繰り返さないための上限。超えたら `Stopped`（予約を解く。次の `begin` で再開）と error を 1 回 log。
  **選択肢：** (a) K 回で `Stopped`、(b) 無期限に `Retry` するが §5 の対策 2 の backoff で間隔を延ばす。推奨は (a)。K は open の費用の測定（§7）の後に、ユーザーかレビューが決める。
- **試験案。** (e)：BUSY と open 失敗が `Retry` になり予約が残る。K 回で `Stopped`。`ValidationTerminated` は `Err` のまま。
- **決定（2026-11-06 ユーザー）。** (a)、K＝40。別セッションの調査の指摘（未確認）：OTP・systemd は回数と窓の両方で上限を置く。BUSY と永続する失敗を別に数える案は実装時に検討。

##### E12 永続する restart の状態

- **なし。** reader は table・列・proof・cache を書かない（`OPEN_READ_ONLY`＋`query_only`）。書くのは `temp.grimodex_connection_meta` だけ（TEMP。connection とともに消える）。
  `builds` の予約、E11 の連続回数、E13 の slot は **process-local** で、永続しない。再起動後は従来どおり `rebuild_requested` から始まる。
- **process が落ちた場合。** read-only の接続は write lock を持たない。WAL の読み取り印（read mark）は OS の lock なので process 終了で解ける。DB に回復の仕事は残らない。
- **試験案。** (c)：schema の差分が無い。reader が書込みを試みると error。
- **未決。** なし（`SAVEPOINT`／`RELEASE` が `query_only` で通ることは (c) で確かめる。推測）。

##### E13 reader の同時数（新設）

- **事象。** reader の open が無制限だと、同時に走る build の数だけ接続とメモリ（`cache_size`）が増える。予約の上限は `CAPACITY`＝128（`RS:35`、`RS:51`）で、E2 のとおり generation の回転で 2 倍になりうる。
- **案。** `NirChronicleIndexRuntime` に **authority あたり 1 本の slot**（`AtomicUsize` ＋ RAII の permit）を置く。`build_once` の最初（`current_request` の後、authority tx の前）で try-acquire し、取れなければ `Retry`（DB を触らない）。
  permit は E5 の close の証拠の後にだけ戻す（証拠が取れなければ戻さない。E8 (a)）。今も prepare は authority の mutex で直列なので、直列化という意味は変わらない。
- **判断が要る点。** 1 本という上限は新しい並行度の規則。複数 project の build が reader を待つ（今は mutex を待つ）。E2 の共存を許容する案を採るなら slot は要らない。
- **試験案。** (q)：2 本目が `Retry`、1 本目が戻った後に取れる。panic・`Err`・close 失敗でも permit の扱いが E5／E8 のとおり。
- **決定（2026-11-06 ユーザー）。** 採る（authority あたり 1 本。2 本目は DB を触らず `Retry`。permit は close の証拠の後にだけ戻す）。

##### E14 authority の健全性・共有 lease との関係（新設）

- **共有 lease。** reader は `request` が持つ `PinnedWorkspaceDb`（E5 の連鎖）の内側にあり、lease は reader より長生きする。cross-process の restore／migration は shared lease が生きている間は file を置換できない（`src-tauri/crates/grimodex-db/src/open.rs:705-707` の保守 thread と同じ考え方）。
  reader 専用の lease は取らない。
- **authority が quarantine／retire されたとき。** `ensure_connection_reusable`（`LIB:424-` の `lock_conn_with_check`）が手順 1 の authority tx を `Err` にする。reader は開かない。
  手順 1 の後に authority が retire される場合（recovery の transition）は participant の stop が先に立つので E3 で止まる。publish は authority の IMMEDIATE tx で `Err`（fail-closed）。
- **file identity。** 手順 1 の identity と reader の identity が一致しなければ `Stopped`（§2.1 の 2）。比較は path 基準で、外部 process による差し替えは脅威モデルの外（workspace の共有 lease が置換を拒む）と明記する。
  `sqlite_database_file_identity`（`maintenance_lifecycle.rs:623`）は `pub(crate)` で使える。`sqlite_database_path_in_tx`（`:589`）は module 内の `fn` なので、使うなら可視性を `pub(crate)` に上げる（grimodex-db の内側の変更）。
- **試験案。** (t)：authority を quarantine した状態で `build_once` が reader を開かず `Err`（`Stopped`）。(j)：identity の不一致。
- **別セッションの調査の指摘（2026-11-06、`design-notes/research-2026-11-06/perf/sqlite-connection-hold-structure.md`、未確認）。** runtime の epoch は接続ごとの TEMP の epoch に縛られている（`runtime.rs:149-153`）ので、今のまま 2 本目の接続で prepare すると `ConnectionChanged` で失敗する。reader の実装では epoch の読み方を authority の値に合わせる（§2.1 の手順の見直し）。また握るのは prepare だけでなく publish の書込み tx（roster・input_guard・Feed・edge の読み直し）と 250 ms 周期の再試行もある。reader の cache は接続ごとに私有なので `cache_size` を明示する。
- **未決。** epoch の扱い（実装時に確かめる）。

#### 2.2.3. 適用しない項目

- **外部送信・subprocess。** reader は同じ process 内の SQLite 接続で、送信も子 process も無い。embedding の推論（`embed_nir1_documents_with_control`）は既存のままで、この変更の対象外。
- **`onClosed`／error event／rejected promise。** reader に非同期の通知は無い。終了は同期の `close()` の戻りで決まる（E5）。task の側の終了は `JoinError` と `NB:54` が所有する（既存）。
- **既存のままの点（この変更の対象外）。** `schedule` の task が panic すると予約の解放（`NB:59-63`）が飛ぶ。generation の回転で次の予約が keys を消す（`REG:26-30`）ので、取り残しは次の generation までに限られる。

#### 2.2.4. 草稿の他の節で訂正が要る点（この行列を読んで見つかったもの）

1. §2.1 の 1：「`build_once` が持つのは `request.database()` だけで `WorkspaceAuthority` は見えない」は誤り。`request.database()` は `PinnedWorkspaceDb`＝`Arc<WorkspaceAuthority>` で、`path()`・`lease()`・`identity()` が見える。
   `main_database_file_identity` を tx の中で呼べない理由（同じ mutex の再入）は変わらない。
2. §2.1 の 6 の表の 3 行目の「従来どおり」：epoch 変更は従来は `Stale`→`Retry` で、reader が hook で止めると `Stopped` になる。製品では等価（E3）。
3. §2.1 の 2 の「progress hook は … `cancellation_epoch` を見る」：既定の config では見ない。reader の入口が `workspace_generation` に渡す（E3）。
4. §3 の「lifecycle の epoch」の行：publish の再照合は `native_build_is_current` ではなく `PUB:75-77` と `PUB:82-84`。
5. §2.1 の 1 の「crate 内限り」：`sqlite_database_path_in_tx` は module 内の `fn`。`sqlite_database_file_identity` は `pub(crate)`（E14）。

## 3. 守る不変条件と、それを破りうる箇所

| 不変条件                                   | reader 案での扱い                                                                                                                                                                                  | 破りうる箇所と対策                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| snapshot の一貫性                          | reader の 1 つの `BEGIN DEFERRED` tx。WAL の read snapshot は commit 済みの状態だけを見る。prepare の内部は今と同じ                                                                                | `rebuild_requested`・prepare・embedding の読みは今も別 tx。tx の間に入力が動けば、publish の CAS が `Stale` で拾う。**prepare から publish までの窓は今も embedding の区間で存在する。reader は窓の種類を増やさず、長さを prepare の分だけ伸ばす**                   |
| publish の CAS と `input_guard`            | DB の値の比較で、接続に依存しない（`CI/build.rs:240-292`）。authority の IMMEDIATE tx のまま                                                                                                       | prepare が読んで CAS が覆わない入力があれば、窓が長くなって露出する。**scope authority・language・evidence の読みが CAS の対象かを、実装前に一覧で確かめる**（今は窓が短いので気づかれにくい）。DR-IRB-5 (a) の `archived` の確認と同じ種類                          |
| lifecycle の epoch                         | epoch は authority の tx で取り、publish が再照合する（`publish.rs:75-77`、`:82-84`）。reader の hook は、入口が `workspace_generation` に渡したときだけ `cancellation_epoch` を見る（§2.2 の E3） | 取得（手順 1）と reader の snapshot の間に pause／resume／stop が入る → publish の照合で `Stale`（fail-closed）。`native_reader_epoch()` は contention でも `None` を返す（`CI/runtime.rs:196-203`）ので、build には**使わない**（`None` を `Stopped` と取り違える） |
| fail-closed                                | READ_ONLY かつ `query_only`。reader の失敗は `Retry` か `Stopped` で、publish を通らない                                                                                                           | `Err` を返すと予約が消える（`NB:54`）。型付き写像（§2.1 の 6）で防ぐ                                                                                                                                                                                                 |
| 関連場面の IR の窓 D＝40 ms と index-ready | 前景の mutex 待ちが prepare の分だけ消える。build の時間は D 自体を変えない。変わるのは、IR が D の窓に収まる回数と、index-ready が来る時刻                                                        | 連続編集で `Stale` が続くと index-ready が遅れる（§5）。D の定数は `relatedScenesConfig.ts:13`                                                                                                                                                                       |
| 保守・Freshness・cutover                   | reader は何も書かない。Freshness の複数 tx の途中を読んでも、publish の `pending::read` との比較が拾う。cutover は authority の epoch 側で変わらない                                               | IR の build が前景扱いの取得をしなくなる。保守が先に進み、Freshness の ack が早く進む方向（推測）。**保守の mutex の時間が伸びて、前景の read が止まる別の経路にならないか**は、計測の後に再確認する                                                                 |
| Windows の restore の file 置換            | reader は participant と共有 lease の内側で開閉する。transition と shutdown は participant の解放を待つ（`workspace_lifecycle.rs:1697-1700`、`NB:28-30`）                                          | reader の cleanup 失敗や panic で接続が残ると、file が掴まれたままになる。**`build_once` の戻りまでに必ず drop**（panic でも drop される形にする）。長命にしない                                                                                                     |
| WAL の checkpoint                          | authority は `wal_autocheckpoint=1000`（PASSIVE）と `journal_size_limit`（64 MiB、`LIB:337-344`）                                                                                                  | 長い read snapshot は checkpoint を止め、`-wal` が伸びる。書込みの量が少なければ小さい（推測）。N が数千のときに測る（§7）                                                                                                                                           |
| schema と file の同一性                    | reader は authority の後に開く                                                                                                                                                                     | migration や差し替え中の読みを防ぐため、file identity と schema の照合を open の直後に行う（§2.1 の 2）                                                                                                                                                              |

## 4. 信頼境界

reader は **NIR1 の runtime と participant に参加する in-process の 2 本目の接続で、読取専用としては初**。
（in-process の 2 本目そのものは、保守 thread の書込み接続が先にある。§1.5 の 1。）

- **書かない。** `OPEN_READ_ONLY` と `PRAGMA query_only=ON` の二重。書込みの SQL が混ざれば error になる（試験 c）。
- **proof を作らない・触らない。** `IndexProof`、`validated_read`、`validated_query_contexts` に reader の identity を入れない。`install` は呼ばない。
- **能力は authority の admission から来る。** reader の入口は opaque な (owner, epoch) を要し、これは authority の tx でしか作れない。
- **publish と `install` は authority だけ。** CAS は常に authority の IMMEDIATE tx。reader の結果は「候補」であって、権限ではない。
- **送信先・保存・IPC・契約・閾値は変えない。** 新しい table や列も足さない。`NirIndexUnavailableReason` の 1 variant は internal の値で、wire に出ないことを実装時に確認する。
- **D9 との関係。** D9（`docs/plans/nir1-c-query-acceptance-2026-10.md:613`）は、**Graph の ordinary reader** を製品の経路から外した。理由は、論理 ledger の一時見積りが worker より厳しいこと。
  接続の安全性の判断ではない。この reader は Graph の query や論理 ledger を通らない（Chronicle の prepare は ledger を使わない）。したがって D9 に反しない。
  ただし、D9 が外した `Nir1GraphReader::open`（`cfg(any(test, feature = "nir1-material-diagnostics"))` の中）を製品に戻さない。
  この lane は別の入口（`NMC` の reader）を足す。接続の開き方（`READ_ONLY`、`busy_timeout(0)`、`query_only`）は `nir1_graph.rs:498-507` と worker（`nir1-c-query-worker.rs:207-228`）の前例に揃える。
- **前例の限界。** worker は別 process で、自分の runtime を持つ。in-process で 1 つの runtime を 2 接続で共有する配線は新しい。この判断を DR と PR 本文に残す。

## 5. liveness の懸念と、その観測・対策

**懸念。** 今は prepare の間、authority の `Mutex` を通る書き手（Scene の保存、extraction の commit、Freshness の commit など。どの書き手がどの接続を通るかは未確認）が締め出される。
prepare から publish への窓のうち、書込みが入りうるのは embedding の区間だけ。
reader 案では、書込みが入りうる窓が prepare の全体（今の大きな作品で数秒〜数十秒）に広がる。

- **Stale の原因は material の Scene だけではない。** publish の CAS は `input_guard` の 18 本の query（`CI/input_guard.rs:10-30`）を再計算して比べる。
  対象は project の proposal の 5 表、extraction の runs／tasks／attempts／artifacts、`stage_receipts`、`model_bindings`、receipt に紐づく `ai_audit_events`、
  依存の declaration の head／set／entries、`narrative_dependency_edges`、`edge_states`、`narrative_consumer_freshness`。
  このどれか 1 行でも prepare の最中に commit されると、prepare 全体がやり直しになる。
  特に Scene の編集ごとに後から走る Freshness の commit（edge_states・consumer_freshness）と、進行中の extraction の書込み（runs・tasks・attempts・artifacts・receipts・audit）が入る。
- 本文の保存は Chronicle の index を dirty にする。material になっている Scene の revision token は `v{version}@{updated_at}`（`retrieval_admission/scene_source.rs:50`）で、
  edge の読み（`CI/build.rs:240-292`）と `pending::read` に入る。material の Scene を連続して autosave すると、publish が `Stale` → `Retry`（`NB:293`）を繰り返し、
  index-ready が無期限に遅れうる（推測）。
- 今も、Scene の編集後は Freshness が Feed を acknowledge するまで `PendingChange` になる（`CI/build.rs:141-148`、`NB:177-179`）。prior が無い最初の build は、この判定が prepare の最後に来るので、全 prepare をやり直す。
  つまり「編集が続くと build が進まない」性質は今もある。**ただし今の窓は embedding の区間だけで、reader 案は窓を 10〜37 s に広げる。**
  「新しい種類の問題ではない」とは言い切れない。**新しい点：extraction の実行中や Freshness の連続 commit が、そのたびに prepare を無効にしうる。** 頻度は未計測（推測では、extraction 中は高い）。
- 一方、今は prepare が前景を止めるので、`Stale` の繰り返しは前景の停止の繰り返しだった。reader 案ではそれが CPU の消費（reader は 1 core を使う）に変わる。

**観測。** 計測と同時に、tracing へ次を足す：`outcome`（`Ready`／`Stale`／`PendingChange`／reader の `Retry`）、`stale_streak`、`prepare_ms`、
`publication_ms`、**`Stale` の原因別の計数（`input_guard` の 18 本のどれが変わったか。`input_guard::read` を query ごとの digest に分けて、前回の prepare との差を記録する計装を dev 専用で）**、
material の Scene の変更の頻度（Feed の event の間隔）、**extraction の commit と Freshness の commit の頻度（prepare の 10〜37 s の窓の中に何回入るか）**。
Scene の変更頻度だけを測らない。

**対策。** 1・3 は計測の後に採否を決める。**2 と 4（`stale_streak` への対策）は、計測の後に回さず、DR-IRB-3 を採用する条件に入れる**（下の「採用条件」）。

1. prepare 自体を短くする（DR-IRB-4）。これが本筋。
2. `stale_streak` が 2 以上になったら、loop の待ちを 250 ms から段階的に延ばす（上限は未決）。CPU の空回りを減らす。index-ready の遅れの許容は §8。
3. `pending::read` の事前確認の維持（`CI/build.rs:141-148`）。prior が無い場合に安く早く止める方法は、意味が変わるので別に分析する。
4. 上限付きで authority の接続へ戻す（`stale_streak` が K を超えたら、従来の prepare を 1 回だけ使う）。前景の停止が戻るので、採るなら §8 の判断が先。

**DR-IRB-3 の採用条件（`stale_streak` について）。** 次のいずれかが決まるまで、reader 案を既定にしない：
(i) 計測で、通常の編集・extraction の頻度では `Stale` が連続しない（`stale_streak` の上限と頻度の目安を記録する）、
(ii) 2（段階的な待ち。上限つき）を DR-IRB-3 に含める、
(iii) 4（上限つきの authority への復帰）を採る（§8 の判断を先に取る）。
どれも無いまま入れると、連続編集・extraction 中に index-ready が無期限に遅れ、かつ前景の停止の代わりに CPU を食い続ける。

## 6. 試験の計画

審査の (a)〜(f) を確かめた。(a)〜(f) は決定的に書ける。`GraphWorkControl` が注入できるので、prepare の途中で止める hook を作れる。
(b) は、その hook の中で別 thread が authority の `lock` を取れるかで確かめる。

| 試験 | 内容                                                                                                                                                                                                      | 補足                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| (a)  | reader の prepare の途中で authority が commit すると、publish が `Stale` を返す                                                                                                                          | Scene の本文・revision・Feed の 3 種で                                                                                                     |
| (b)  | reader の prepare 中に、authority の lock が取れる。`foreground_connection_waiter_count()` が増えない                                                                                                     | `NMC:1689` の `foreground_connection_waiter_count()`（cross-crate の競合試験用の観測）。既存の「prepare 中は取れない」試験があれば反転する |
| (c)  | reader への書込みは失敗する。**`SAVEPOINT`／`RELEASE`（`project_scope_authority.rs:300`）、`unchecked_transaction`、`pending::read`、`input_guard`、finalize が READ_ONLY＋`query_only` で通る**          | §1.5 で確かめられなかった点を、ここで確かめる                                                                                              |
| (d)  | stop・generation の変更で、reader が止まり、接続が閉じる。`build_once` の戻りの後に reader が残らない（open 数の gauge か、drop 計数の test 用の仕掛け）                                                  | 戻りの経路を、正常・`Err`・panic の 3 通りで                                                                                               |
| (e)  | BUSY が `Retry` になり、`builds` の予約が残る。open の失敗も `Retry`。K 回を超えると `Stopped`                                                                                                            | `schedule` の loop の水準で。`NB:54` の経路を通すこと                                                                                      |
| (f)  | 同じ fixture で、authority で作った `BuildSnapshot` と reader で作った `BuildSnapshot` が一致する（`input_guard`、`prior`、`semantic_epoch`、`language`、`roster_digest`、`candidates`、`edges`、`feed`） | 型が `PartialEq` でなければ、試験用の比較を足す                                                                                            |
| (g)  | **reader 化しても `reused_count` が落ちない**（§1.5 の 6）                                                                                                                                                | 2 回目の build で、既存のベクトルが再利用されること                                                                                        |
| (h)  | reader の epoch の取り違えが起きない：`validated_read` と `validated_query_contexts` が reader の prepare で変わらない                                                                                    | 審査の確認 1                                                                                                                               |
| (i)  | 手順 1 の後に pause／resume／stop が入ると、publish が `Stale` か `Stopped` になり、proof を install しない                                                                                               | epoch の窓                                                                                                                                 |
| (j)  | file identity の不一致で `Stopped` になる                                                                                                                                                                 | 別の file に差し替えた fixture                                                                                                             |
| (k)  | DR-IRB-1 の実行計画の試験（`stage_provenance::audit_count_plan_tests`）が、reader の接続でも同じ計画になる                                                                                                | 計画が変わると prepare が再び全件走査になる                                                                                                |
| (l)  | 既存の IR の build・hydration・material roster の golden が、authority 版と reader 版の両方で通る                                                                                                         | 同値性                                                                                                                                     |
| (m)  | reader の open の順序：temp meta の作成が `query_only` の前。reader 上で `current_epoch` を直接呼ぶ試験（temp meta ありは `ConnectionChanged`、なしは `Err`）で §1.5 の 2 通りの倒れ方を固定する          | 誤って reader で呼んだときに黙って空にならないこと                                                                                         |
| (n)  | 手順 1 が `Database` の `Mutex` を握ったまま `main_database_file_identity` を呼ばない（deadlock 回帰）。`:memory:` の扱い                                                                                 | §2.1 の 1                                                                                                                                  |
| (o)  | owner／lifecycle 行列（§2.2）の E1〜E14 の証跡                                                                                                                                                            | 行ごとに 1 つ以上の試験。`build_once` には直接の試験が無いので、(d)(e)(i)(q)(s) を 1 つの harness にまとめる（E10）                        |
| (p)  | 取消し→reader の close までの時間を測る：prepare の途中（preflight の区間）で stop を立てる。1 候補の preflight の最大の ms も記録する。短い statement で progress hook が呼ばれるかを確かめる            | E6／E7。写し 2 つ（m-ja-2、m-en-1）で。上限の値は測定の後に決める                                                                          |
| (q)  | reader の同時数：generation を回転して旧の `build_once` が走行中のまま新を `schedule` する。slot を採るなら 2 本目が `Retry`、採らないなら open 数の最大値を記録する                                      | E2／E13                                                                                                                                    |
| (r)  | OS の終了の証跡：Linux は `/proc/self/fd` の `grimodex.db` の fd 数が build 前に戻る。Windows は build 後に DB file の rename が通る。participant 数が 0 のとき reader 数も 0                             | E5／E7／E10。hosted の 3 OS で                                                                                                             |
| (s)  | operation 内の panic：reader 数 0、`retirement_close_pending()==false`、authority の `connection_reusable()==true`、`builds` の予約が解ける                                                               | E9                                                                                                                                         |
| (t)  | authority を quarantine した状態の `build_once` は reader を開かず `Err`（`Stopped`）。cleanup の failpoint で reader が使えなくなっても authority は `connection_reusable()==true`                       | E8／E14                                                                                                                                    |

## 7. 計測で決める分岐

計測は評価 run の終了後、写しの DB で行う。N＝250、500、1000、3000 で測る（合成が要る場合は fixture の生成を先に決める）。

| 計測                                                                                                                                                                                             | 結果                                                    | 採る・見送る                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `publication_ms` の絶対値と内訳（`snapshot_current`〈roster・`input_guard`・edge〉、`verify_outcomes`〈audit chain を別掲〉、`read_verified_evidence`、ベクトルの INSERT、edge の 2 回目の評価） | N＝500 で数百 ms 以下                                   | DR-IRB-3 だけで目標（前景の停止が秒単位にならない）に届く。DR-IRB-5 は見送る                                                        |
| 同上                                                                                                                                                                                             | 秒級で、audit chain が支配的                            | DR-IRB-3 を入れても publish 中の停止が秒単位で残る。DR-IRB-5 (b)（§8 の判断が先）を設計する。DR-IRB-3 の価値は prepare 分に限られる |
| 同上                                                                                                                                                                                             | 秒級で、`input_guard` や edge の評価が支配的            | DR-IRB-5 (c)（評価の重複の削減）を先に。信頼境界は変わらない見込み                                                                  |
| 同上                                                                                                                                                                                             | 秒級で、evidence や INSERT が支配的                     | DR-IRB-5 (a)（reader 側へ移す）。CAS が覆う入力だけを使えるかを確かめる                                                             |
| prepare の段別の時間（roster・preflight・scope・finalize・`input_guard`・pending）、候補あたりの値（DR-IRB-1 の前後）                                                                            | 線形の項が候補あたり 20 ms 未満、N＝3000 でも 60 s 未満 | DR-IRB-3 の効果が大きい。DR-IRB-4 (i) は低リスクなので先に入れてよい                                                                |
| 同上                                                                                                                                                                                             | 線形の項が大きい                                        | DR-IRB-4 (ii)（memo・batch）を採る。run あたりの revision の数が効き目の上限（写しで 約 4.6 倍）                                    |
| 候補ごとの `is_generic_freshness_canonical`・`get_current_epoch` の呼出し回数、finalize の edge の評価の読み直し                                                                                 | 候補ごとに複数回                                        | DR-IRB-4 (i) を採る。1 回なら見送る                                                                                                 |
| `stale_streak` の分布（reader 案の事前の見積り：prepare 中に material の Scene が変わる頻度、autosave の間隔、material の Scene の割合）                                                         | 連続編集で数回以上                                      | §5 の対策 2 を採る。4 は §8 の判断後                                                                                                |
| reader の open 費用と `cache_size` の選択、prepare 中の `-wal` の大きさ                                                                                                                          | open が数十 ms 以下、`-wal` が数 MB                     | 採る。大きければ `cache_size` や build の頻度を見直す                                                                               |
| `read_reusable_chronicle_embeddings` の時間                                                                                                                                                      | N＝3000 で数十 ms 以下                                  | authority に残す。重ければ reader 用の別入口                                                                                        |
| `rebuild_requested` の周期（`Idle` の 250 ms ごと）の 1 回の時間                                                                                                                                 | 1 ms 未満                                               | 触らない。大きければ周期を延ばす案を別に                                                                                            |
| 承認の burst の間隔の分布                                                                                                                                                                        | burst が多い                                            | debounce（3c）の要否を判断（§8）                                                                                                    |
| 評価 run への影響（reader の CPU の競合）                                                                                                                                                        | PD 評価の時間条件に影響                                 | 評価と衝突しない時期に入れる（§8）                                                                                                  |

### 7.1 計測の結果（2026-11-05、run の後。dev 枝 `claude/irb-prepare-timing` の `c840ddb3`、REPS=3、run の DB の写し）

|                          | m-ja-2（候補 491、receipt 1,452、audit 26,381 行）                                                    | m-en-1（roster 509・候補 318、receipt 1,546、audit 29,928 行）                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| prepare（DR-IRB-1 の前） | 39.6 s（audit の COUNT 29.5 s＝74.5％）                                                               | 86.0 s（audit の COUNT 74.3 s＝86％）                                                 |
| prepare（DR-IRB-1 の後） | **10.2 s**（audit の COUNT 0.56 s）                                                                   | **12.3 s**（1.38 s）                                                                  |
| 前景の probe の最大      | prepare の全体（ずっと塞がる）                                                                        | 同じ                                                                                  |
| 後の残りの内訳           | root_material 5.1 s（うち receipt の hydrate 1.3 s）、finalize.freshness 3.0 s、membership の他 1.7 s | root_material 8.4 s（hydrate 2.6 s）、finalize.freshness 1.5 s、membership の他 2.0 s |
| receipt の検証の回数     | 6,934（receipt の 4.8 倍）                                                                            | 14,291（9.2 倍）                                                                      |
| publish の読む段         | 約 1.1 s（audit の連鎖の全件検証 0.55 s、snapshot_current 0.25 s、evidence 0.30 s）                   | 約 0.9 s（0.55 s、0.18 s、0.16 s）                                                    |

分岐の結論：

- **DR-IRB-5（publish の短縮）は今は採らない。** publish の読む段は約 1 s で、audit の連鎖の全件検証は 0.55 s。§8 の 1 の脅威モデルは確定済みだが、「計測で重いと分かった場合だけ実装する」条件に当たらない。
- **DR-IRB-4 を先にする。** root_material（同じ run の receipt と artifact を候補ごとに再生）が最大で、検証が receipt の 4.8〜9.2 倍繰り返されている。prepare の read tx の中だけの run ごとの memo で、root_material の大半（推定 4〜7 s）を消せる見込み。finalize.freshness の batch 化は次。
- **DR-IRB-3（reader）はなお要る。** DR-IRB-4 の後も prepare は O(N) で、数千件の作品では前景を秒単位で塞ぐ。
- 別件：m-en-1 は roster 509 のうち preflight を通るのが 318（m-ja-2 は 491／491）。m-en-1 の「IR の admitted 0 件」の手掛かり。未調査。

## 8. ユーザーの判断が要るもの

**前提：IRB は U3 の対象レーンに入っていない**（冒頭）。以下の「worker の技術判断で進めてよいもの」は、**U3 の委任がこの lane に及ぶと確認できた場合に限る**。
確認が無い間は、reader（DR-IRB-3）以降の mutation の前に GDX-PRECHECK-001 を通し、`[precheck]` でユーザーまたは integrator の確認を取る。
DR-IRB-1（数える行を変えない）と計測（挙動不変、dev 用）は、この前提の対象外。DR-IRB-2 は別の branch で記録済み。

委任が及ぶ場合に worker の技術判断で進めてよいもの（DR-IRB-3 の reader の仕様、DR-IRB-4 (i)(ii) の memo の範囲）と、そうでないものを分ける。

1. **audit chain の検証範囲（DR-IRB-5 (b)）。2026-11-05 にユーザーが脅威モデルを確定した。** Merkle 木などの構造の変更はせず、当面は小さい変更で進める（ユーザー「当面は小さい変更で進めてください」）。
   変更の中身：全件の検証は残し、読取の snapshot（prepare の側）で行う。publish の書込みの tx では、検証済みの位置（高水位）より後ろの行と、高水位の行の hash の一致だけを確かめ、合わなければ publish しない。
   確定した脅威モデル（GDX-PRECHECK-001 の 4 点。ユーザーの回答「この内容で確定してよい」）：
   - 信頼するもの：native の audit の書き手（`append_ai_audit_events_in_transaction` の追記だけ）と、renderer の SQL から `ai_audit_events` への変更の拒否（`execute.rs` の authorizer）。信頼しないもの：renderer の引数、モデルの出力（今と同じ）。
   - 範囲内の攻撃は今と同じ。範囲外は、外からのローカルの DB の改ざん（OS・管理者・別の process）。関連場面の確認済みの脅威モデル（`nir1-related-scenes-precheck.md` の Out of scope）と、Attribution の設計書（chain の検証は自己申告の整合性診断で、管理者への耐性はない）どおり。
   - 必須の防御：全件の検証、tx の中の高水位より後ろの検証と高水位の hash の一致、不一致なら fail-closed。
   - 受け入れる影響：読取の検証と publish の間に、範囲外の手段で高水位より前の行の中身だけが書き換えられたときは、その publish では検出しない（次の build の全件の検証で検出される）。
     実装は、計測で audit chain の検証が publish を重くしていると分かった場合だけ行う。脅威モデルを変える変更（actor・範囲・防御・受入れのどれか）が要る場合は、もう一度確認を取る。
2. **前景の read の lock 待ちの期限と D＝40 ms の関係。** 期限を付けるなら値の選び方が要る。irb-decisions.md の §3 の保留と同じ。案を並べて聞く。
3. **事前登録の新しい版。** build の挙動が変わるので、PD 評価の取り直しには事前登録の新しい版が要る。いつ入れるかは評価の進行との相談。
4. **index-ready の遅れの許容。** 連続編集中に index-ready が遅れうること（§5）を許容するか。審査は、`docs`・`policies`・`evals`・`scripts` の grep で、index-ready を時間条件にした gate を見つけなかった（確認台帳での最終確認は別）。
5. **debounce の Q（3c を採る場合）。** Q の値は IR の体験を変える。
6. **評価 run との衝突を避ける時期。** reader は別の CPU を使う。PD 評価の時間条件への影響を、いつ測るか。
7. **version 列（案 2b）。** migration を伴う新しい契約。採らない推奨。
8. **`NirIndexUnavailableReason` の variant の追加。** internal の値だけなら技術判断。wire や IPC に出るなら新しい契約。
9. **U3 の委任が IRB に及ぶか。** 及ばない場合、reader の追加は新しい owner／lifecycle を持つので、ユーザーの確認が要る。及ぶ場合も、§2.2 の行列の確定と GDX-PRECHECK-001 は省けない。
10. **§2.2 の行列で残った判断（ユーザーかレビューが決める）。**
    - E11：reader の `Retry` の連続回数の上限 K と、(a) K 回で `Stopped`／(b) 無期限に `Retry`＋backoff の選択（推奨は (a)）。
    - E8：close の証拠（`retire_connection_for_recovery` の成功）が取れないとき、その authority の reader を二度と開かず fail-closed にするか（推奨は開かない）。
    - E13：reader を authority あたり 1 本に制限する新しい並行度の規則を採るか。採らないなら E2 の「generation 回転時の 2 本の共存」を許容と明記する。
    - E6：1 候補の preflight の最大値を測り、(a) 受け入れるか (b) `preflight_build_candidate` に `control` を渡すか（grimodex-db の読取経路のシグネチャ変更。意味は変えない）。
    - E7：取消し→close の遅延の上限の値は測定の後に決める（今は書かない）。
    - E3：epoch 変更の写像が「製品では等価」なのは、Chronicle runtime の `pause`／`resume`／`stop` に製品の呼び手が無いという grep の結果に依存する。この前提を PR 本文に残すか。

## 9. 変えないもの・まだ決めていないもの

- 変えない：publish の CAS と `input_guard`、`install`、audit の検証の意味、fail-closed、threshold、送信先、保存、IPC、契約。
- 変えない：IR の窓 D（40 ms）、W_f（100 ms）、Graph の lease、IR の floor と順位付け。
- 実装済み（PR 待ち）：`projectSnapshotAdapter.ts` の catch が読込みの例外を `SNAPSHOT_SOURCE_CHANGED` に付け替える件は **DR-IRB-2**
  （branch `claude/irb-snapshot-read-diagnostic`）で直した。pending mutation の reject などは保守的に `SNAPSHOT_SOURCE_CHANGED` のまま残る。この草稿の対象外。
- 未決：K（reader の `Retry` の上限）、`cache_size`、`stale_streak` の待ちの上限、N の合成 fixture。

## 10. 検証（この草稿について）

- 文書だけ。コード・試験・測定は実行していない。
- `prettier --check` を、この file に対して実行する。§2.2 の行列を足した後に `prettier --write` と `--check` を実行し、合格した（表の桁そろえで他の節の表の空白も変わった）。cargo・測定・試験は実行していない。
- 写しの DB の読み取り（`mode=ro`）は、§1.4 の集計だけ。本文・題名は読んでいない。

## 11. 先行実装と文献（2026-11-05 の調べ。抜粋が主で、採用の前に一次資料で確かめる）

- **読取専用の接続を分けるのは標準の形。** GRDB.swift の `DatabasePool`（書込み 1＋読取の pool、WAL）、Android Room の `ConnectionPool`（読取側は `PRAGMA query_only = 1`）、Mozilla mozStorage の非同期接続、Signal Desktop の SQL の worker。Zed の議論 #64530 は、単一の Mutex の接続という同じ症状に、読取接続の分離と背景の書込み queue を提案している。DR-IRB-3 はこの形で、rusqlite の `OpenFlags::SQLITE_OPEN_READ_ONLY` と `query_only` で足り、依存は増えない。
- **長い読取は WAL の checkpoint を止める**（SQLite の `wal.html` の checkpoint starvation、GRDB の文書）。prepare を 1 つの長い読取 tx で行うと `-wal` が伸びる。計測で prepare 中の `-wal` の大きさを見る。DR-IRB-4 で prepare を短くするか、chunk の間で読取を手放す。
- **読取の接続を分けても、重い書込みの tx は前景の書込みを待たせる。** publish（audit 連鎖の全件検証、edge の再評価、vector の INSERT）を短くする DR-IRB-5 は、DR-IRB-3 と別に要る。
- **仕事を減らす（DR-IRB-4）の参考。** rust-analyzer の Salsa（revision と依存の記録、出力が同じなら下流を止める early cutoff、新しい編集で古い計算を取り消す）と durability（変わりにくい入力の検証を飛ばす）、SQLite FTS5 と Tantivy の segment の追加と背景の統合。前回の候補の再利用は publish の CAS（`input_guard`、roster digest）の定義を変えうるので、委任の外になりうる。
- **audit 連鎖の増分の検証（§8 のユーザーの判断の材料）。** RFC 9162 の consistency proof、Crosby & Wallach（USENIX Security 2009）の history tree は O(log n) で検証する。線形の鎖で「検証済みの高水位から後ろだけ」を検証すると、高水位より前の行の payload だけを書き換える改ざんは publish の時点では検出できなくなる（保証が変わる）。高水位を DB の外（keyring など）に置く案は保存範囲の拡大で委任の外。Rust の crate では `ct-merkle`（RFC 6962、README に監査は未実施と明記）がある。
- **採らないもの。** Turso／libSQL の MVCC（beta、ファイルの形式が変わる）、SQLite の `BEGIN CONCURRENT`（実験の branch）、Electron の worker_threads で native addon を読むこと（Electron の文書が非推奨）。Electron の `utilityProcess` に DB を移すのは確実だが変更が大きく、今回は in-process の読取接続から始める（C-query worker の別 process の前例はある）。
- 全文と出典：integrator の scratchpad の `exa-results/local-first-sqlite-background-index-2026-11-05.md`（repo の外）。
- **NIR の先行研究の調査からの補足**（`/home/grimodex/fusion-eval-data/design-notes/nir-prior-art-2026-11-05.md`、2026-11-05 に Fable と相談して反映）：
  - 変更の伝播だけでは再計算より速くならず、memo と組み合わせて速くなる（Acar 2009 [照合済]、Adapton [抜粋]）。DR-IRB-4（run ごとの memo）を DR-IRB-3 より先にする順序と合う。
  - §8 の 2（前景の read の lock 待ちに期限を付ける案）を検討するとき、SQLite の progress handler は VM の命令の数で呼ばれ、時間の上限にならない（[抜粋]、forum の報告）。期限は壁時計の側で持つ必要がある。
  - 同じ文書 §5 の 8（WHERE の無い `COUNT(*)` は 1 つの命令で全件を数え、命令の数の上限では止まらない、[推測]）は、IRB ではなく Graph の worker の query の確認項目。DR-IRB-1 の COUNT は WHERE つきで、走査自体を index に置き換えた。
