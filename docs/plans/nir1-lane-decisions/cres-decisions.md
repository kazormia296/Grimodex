# CR-1 decisions

## D1 — lifecycle lane の形（confidence 85）
- 新 mode `lifecycle`（script）／profile `c-query-lifecycle`（ci.yml）。Linux 以外は `[precheck]` で exit 2（practical と同じ形）。
  13 件は全部 `#[cfg(target_os = "linux")]` か Linux でしか意味を持たない（subreaper、/proc、SIGSTOP）。
- 1 試験 = 1 test process。理由: 6 件は process-global な worker 容量／owner を test-process 終了まで意図的に
  quarantine する。同一 process でまとめると後続試験が容量 busy で偽失敗する。
- `--exact` は full path（`narrative_extraction::nir1_graph::tests::<name>`）。改名や cfg 除外で 0 件実行のまま
  green になるのを防ぐため、log を tee して `test result: ok. 1 passed; 0 failed;` を grep する。
- per-case `timeout --kill-after=30s 600s`。GNU timeout は自分の process group にシグナルを送るので、cargo と
  test binary（owner-death の helper と worker を含む）がまとめて止まる。compile は事前の `--no-run` に寄せ、
  timeout は実行時間だけに掛かる。job 全体は既存の `timeout-minutes: 45`。
- worker binary: owner-death と registry33 は ignore 理由どおり normal build。他の 10 件は seam build
  （seam は env が来た時だけ動くので、seam 無しの case にも害はない）。production 100 ms は worker を使わない
  in-process reader なので最初に走らせる。
- registry33 fixture: `Q512/R1/E12/registry33` を qualifiedMaterials 24／revisions 1／ineligible 0 で作る
  （試験が entity 12 × 2 material、relation 0 を assert）。manifest は lifecycle mode の中だけで別ファイルに書き、
  既存 mode の入力 bytes は変えない。
- 入力は case ごとの fresh copy。canonical-512 runner は read-only 検査で source に sidecar を残し得るため
  （practical mode の既存コメント）。source の cksum と sidecar 無しを case ごとに再確認する。

### owner/lifecycle matrix（CI script 側。製品の worker 意味論は変えていない）
| 主体 | 起動 | 終了・回収 | 失敗時 |
|---|---|---|---|
| cargo test（case ごと） | script | 正常終了 / timeout が group に TERM→30 s 後 KILL | set -e + pipefail で script 失敗 |
| worker child | 試験内 owner | 試験の既存の reap/quarantine 処理 | quarantine は test process 終了で解放 |
| owner-death helper | 試験（process_group 0） | 試験が SIGKILL・waitpid | 試験が group 空を確認 |
| fixture dir | mktemp | 既存の EXIT trap で rm | trap が失敗を status に反映 |
信頼境界: 外部送信なし、新しい送信先なし、hosted runner 上の一時ディレクトリだけ。閾値（512/100,000/100 ms/6 MiB）
と frame wire は変えていない。代替案（1 process に --test-threads=1 でまとめる）は quarantine の相互干渉で却下。

## D2 — ci.yml の範囲（confidence 80）
「nir1-c-query-worker job の profile 追加だけ」に加えて、`canonical_profile` の description と canonical job の
除外リスト（169 行）にも 1 語ずつ足した。足さないと `c-query-lifecycle` が canonical job にも admit され、
ci-pause.test.mjs の「worker job だけが admit される」契約に反する。既存 profile と同じ 3 箇所の扱い。

## D3 — CQ-2 は HOLD（confidence 90）
- 事実: `narrative_proposal_decisions` に PK(id) 以外の index が無い。A2 LENGTH_SQL、A3 global rows[7]、
  A3 global bytes[7] が `SCAN d`。無関係な decided Revision 6,000 件で seed の A2+A3 だけで 91,410 steps
  （baseline 7,411、query 上限 100,000）。admission 件数は不変。未 decided なら steps も不変。
  `disclosure_policy.rs:228`（proposal_id で最新 Decision、ORDER BY）も同じく index 無し。
- 直すには `narrative_proposal_decisions(revision_id, proposal_id)`（と proposal_id, created_at）の index migration
  が要る。migrate.rs・schema-contract.json（Full dataset の source でもある）は許可ファイル外。SQL の書き換えでは
  index 無しの lookup を O(1) にできない。
- 取った形: EXPLAIN 試験は厳格にし、3 文だけを名前付きの既知 gap として「ちょうど `SCAN d` 1 行」で固定
  （index が入ると落ちるので、gap の削除を強制する）。増量試験は admission 不変と、未 decided での steps 不変を
  通常 CI で assert。decided での steps 不変は `#[ignore = "CQ-2 HOLD: ..."]` の受入れ試験として残す（現状は失敗）。
- 試験を弱めたのではなく、受入れ条件を満たせないことを試験で示している。build.ready は出さない。

## D4 — U6 fixture（confidence 85）
- 実 writer で 1 Revision を作って sealed generation を publish し、その後同じ proposal set に raw insert した
  候補 1 件（payload・envelope ともちょうど 6 MiB、JSON は不要、scalar length gate が先に走る）を足す。
  12 MiB では prepare が通ることを control で確認し、同じ Revision に 5 MiB の Decision を足して合計だけを
  16 MiB 超にする。typed `CapacityExceeded`、`input-bytes exceeds 16777216`、成分ガード
  （PERSISTED_REVISION_INPUT_LIMIT）ではないこと、binding と保存済み Graph 面 7 table が byte 一致で
  registered のままであることを assert。
- nir1_capacity_fixtures.rs には触れていない。

## D5 — worker build の割り当てと core dump（confidence 85）
- 1 回目のローカル実行で `native_worker_quarantines_when_cleanup_proof_is_unobserved` が seam worker で決定的に失敗
  （`NIR1_GRAPH_TEST_CHILD_EXIT_FAILURE`）。seam build は commit の後で必ず exit 23 する（bin の末尾。post-commit nonzero 用）。
  一方 CleanupUnproved 系の 3 件（proof unobserved／W1 Restore／file identity）は seam hook を使わず、正常 exit を要求する。
  単独で再現: normal worker 2/2 pass、seam worker 2/2 fail。worker のバグではなく lane の割り当ての誤りなので、3 件を
  normal worker のグループに移した。c_query_worker.rs／bin は変えていない。
- `native_worker_retires_after_real_child_rust_oom` は、このホスト（core_pattern = systemd-coredump、ulimit -c unlimited）で
  SIGABRT の代わりに SIGKILL を観測して失敗した。core dump の pipe が child の終了を cleanup deadline より遅らせ、owner が
  kill する。`ulimit -c 0` では pass。lifecycle mode の中だけで `ulimit -c 0` を設定する。試験はこれまでどおり
  SIGABRT の観測を要求するので弱めていない。hosted ubuntu の既定（core 無効）にも揃う。

# CR-1b decisions

## D6 — schema v42 の Decision lookup index（confidence 85）
- 計測（before、HEAD 65008dc1）: decided の無関係 Revision 0／600／6,000 件で、seed の A2+A3 は 7,410／15,810／91,410 steps
  （A3 は 1,341 → 61,341）。admission は不変。原因は `narrative_proposal_decisions` に PK 以外の index が無く、
  A2 `LENGTH_SQL`、A3 global rows[7]／bytes[7] の 3 文が `SCAN d` になること。
- index は 2 本。どちらも非 unique・非 partial。column、table、保存行は増やさない。
  1. `idx_narrative_decisions_revision_proposal (revision_id, proposal_id)`
     - A2/A3 の 3 文の Decision 読みを、seed Revision への seek にする（rows[7] は covering）。
     - revision_id を先頭にしたのは、`revision_id=?` だけの読み（capacity diagnostics の latest-by-revision、
       各所の COUNT）も seek にするため。(proposal_id, revision_id) だと、それらは SCAN のまま残る。
  2. `idx_narrative_decisions_proposal_created_id (proposal_id, created_at, id)`
     - `disclosure_policy.rs:228` の「Proposal の最新 Decision」
       （`WHERE proposal_id=? ORDER BY created_at DESC, id DESC LIMIT 1`）を、TEMP B-TREE 無しの seek にする。
     - 同じ形の読み（retrieval_admission/current.rs、nir1_chronicle_index/source.rs・revision_bindings.rs、
       repository.rs:4593）にも効く。
  - 最小の組と判断した理由: 1 本では、どちらかの読みが SCAN か TEMP B-TREE に残る。
    - (proposal_id, created_at, id) だけの場合: A2/A3 は seed Proposal の全 Decision を読んでから revision_id で絞る。
      `revision_id=?` だけの読みは SCAN になる。
    - (revision_id, proposal_id) だけの場合: 最新 Decision の読みが SCAN + TEMP B-TREE になる。
    - migrate.rs の試験 `schema_42_decision_indexes_each_serve_a_lookup_the_other_cannot` で、片方を落とすと
      対応する読みが SCAN に戻ることを固定した。
  - 採らなかった案: (revision_id, proposal_id, created_at, id) への拡幅。Revision 内で ORDER BY created_at する読み
    （nir1_entity_relation.rs:1670 など）の小さな sort は消せるが、対象の SQL には不要で、その sort は
    1 Revision の Decision に閉じている。
- migration の形:
  - 定義は core の `NARRATIVE_DECISION_LOOKUP_INDEXES` の 1 か所だけに置く。checkpoint と migrate.rs が同じ定義を読む。
    - checkpoint 側は `has_plain_query_indexes`。既存の `has_current_query_indexes` の loop を共有化のために切り出した。
      判定（非 unique、非 partial、列順の一致）は変えていない。
    - migrate.rs 側は既存の `repair_query_indexes`。
  - 呼ぶ位置は `repair_nir1_extraction_query_indexes` の直後で、checkpoint と user_version の stamp
    （SCHEMA 32 savepoint）より前にした。narrative_proposal_decisions は base DDL の CREATE TABLE IF NOT EXISTS と
    ADD COLUMN だけで、rebuild されない。そのため、作った index が後段で捨てられる経路は無い。
  - 非昇格:
    - 2 本は 1 つの savepoint で作る。片方の CREATE が失敗すると 2 本とも戻る。checkpoint が false のままなので、
      user_version は 41 のまま残る。
    - v41 marker の fast path（`is_previous_workspace_schema_write_compatible`）も checkpoint を要求する。
      index の無い v41 を、marker の書き換えだけで 42 にすることはない。
    - 次の open が full migration で再試行する。authorizer で 2 本目を Deny する試験で確認した。
  - 修復: marker が 42 で、片方が欠落または形違い（列順、UNIQUE、partial）のとき、checkpoint が false になる。
    full migration は該当する index だけを作り直す。もう片方の rootpage は変わらない。
  - restore と staged の経路:
    - restore（`migrate_for_restore_preflight`）と staged（supervisor の shadow migrate）は、同じ `migrate_impl` を通る。
    - v41 workspace の staged 41→42 を、supervisor の試験に追加した。
    - backup_restore の lib 試験（23 件）、failpoint 付きの supervisor／crash 試験も通過した。
    - backup_restore.rs と restore 経路のコードには、index 名や trigger 名の allowlist は見当たらなかった（grep で確認）。
      restore と staged が v42 で通ることは、上の試験の通過で確かめた。
- 帰結:
  - v41 workspace は、初回の open で shadow migration（snapshot＋staged）を通る。
  - index の作成は、既存の Decision 行数に比例する 1 回限りの書込み。Decision の書込みは、index 2 本分だけ重くなる。

## D7 — CQ-2 受入れ試験の形（confidence 80）
- index を入れた後の計測: decided 0／600／6,000 件で A2 は 6,085／6,086／6,086、A3 は 1,340／1,342／1,342。
  admission は全点で不変。
- 0→600 の +1／+2 は件数に比例する増分ではなく、B-tree の末端で生じる差である。
  - 非 unique index の seek は、後続の key があると、OP_Next で 1 回戻ってから終端を判定する。末端（EOF）で
    止まる場合より、progress callback が 1 回多い。
  - seed の Revision id は UUID で、無関係の id（`graph-unrelated-revision-*`）は必ずその後ろに並ぶ。そのため、
    0 件のときだけ seed の key が index の末尾になる。
  - Python の sqlite3（3.53.4）で同じ形の 2 文を測った:
    - 後続 key が無い状態から有る状態に変わると、各文で +1。その後の 1／600／6,000 件は同値。
    - 無関係の id を seed より前に並ぶ prefix にすると、この差は消える。
  - fixture ごとの基準値も ±1 揺れる（undecided の A2 は 6,086、decided 0 件は 6,085）。乱数 UUID の並びで、
    別の seek（source basis など）の末端の判定が変わるためで、同じ fixture の中では一定。
- 受入れ試験は次の形にした。閾値、admission、Gold は変えていない。
  - admission は全点で一致する。
  - 600 件と 6,000 件では、steps を含めて完全に一致する。
  - 0→600 件の差は、Decision seek 1 本につき最大 1（A2 は 1 本、A3 は 2 本）とする。
  - 件数に比例する回帰（scan なら 600 件で数千 steps）は確実に検出し、末端の差だけを許す。
  - test 名は integrator が指定したまま残した。
- plan 試験の変更:
  - 3 文が `SEARCH d USING ... INDEX idx_narrative_decisions_revision_proposal (revision_id=?...)` を、
    ちょうど 1 行持つことを要求する。
  - negative control を 2 つに分けた:
    - index の無い列（decision）での Decision 読みは、`SCAN d` として検出する。
    - 3 文のラベルで Proposal index 経由の読みをした場合は、`Revision index Decision seeks: 0` として検出する。

## D8 — 許可ファイル外の版 assert 2 か所（confidence 70）
- SCHEMA_VERSION=42 に連動して落ちる版の assert が、許可リストの外に 2 か所あった。Outcome の
  「schema 版を assert している試験（… など）」に当たると判断し、最小の変更にとどめた。
  - `src-tauri/crates/grimodex-db/src/execute.rs`: 試験 `renderer_parent_deletes_cleanup_captures_through_native_triggers`
    の `assert_eq!(schema_version, 41)` を、`grimodex_core::SCHEMA_VERSION` との比較に変えた（1 行）。
  - `scripts/quality/validate-semantic-core-boundary.mjs`:
    - `EXPECTED_SCHEMA_VERSION` を 41 から 42 にした。
    - 「index だけで、table、column、row、writer、authority の変更は無い」という ratification コメントを付けた。
    - 同じ test.mjs の `schemaVersion` の assert も 42 にした。
    - 上げないと、`test:quality` と `test:narrative:semantic-contract` が「schema drifted」で落ちる。
- migrate.rs の既存試験 2 件（schema_41_*）は、migration 後の marker を、41 の literal から
  `grimodex_core::SCHEMA_VERSION` との比較に変えた（migrate.rs は許可ファイル）。
- integrator が別の扱いを選んで上記 2 か所を戻す場合は、版 bump と矛盾して試験が落ちる点に注意。
