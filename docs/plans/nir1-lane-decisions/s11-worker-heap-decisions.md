# §11 の残り：worker の固定 heap の縮小と config の可視性（DR-S11-1〜5）

作業記録 [§11](../nir1-continuation-2026-10.md#11-未解決事項) の 2 行を閉じる判断の記録。

- 基点は origin/master `2db49f806`、枝は `claude/nir1-s11-worker-heap`。
- 担当はユーザーの決定で新しいセッションに渡された。原文は contracts `30f4651da` の
  `docs/plans/nir1-pubg-records/user-confirmation-2026-11-26-integrator-s11-leftovers.md` の問 1。
- A は C-resource の受入れの対象なので、独立レビューを経る。
- 記録の時期：編集は記録より先に始めた（AGENTS.md の「mutation の前に記録」からずれた）。そのため、どの DR も「commit の前」に記録した、と書く。
- 経緯：最初の版（DR-S11-1 の代替案 (4)。arena だけを別の static にした形）を独立レビューに出し、そこで事実の誤りと、より良い形の指摘を受けた。DR-S11-1 はその指摘を受けて採り直した形である。

## 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-S11-1 | 2026-11-26 | C-resource（§11「worker の固定 heap の縮小」） | `c_query_fixed_allocator` の Q／S の `Region`（Talc の heap と arena。型と `new`・`claim`・`contains` は旧形のまま）を、allocator の static から外し、slot ごとの static にする。slot は ZST で、`QuerySlot`／`ScratchSlot`（`unsafe trait`）を実装する。macro `region_slot!` が impl の中に関数内の static を 1 つ作る。`WorkerAllocator<Q, S>` は `Once` 2 つと scope の状態と seam の receipt だけを持ち、region は型引数で引く。製品は `ProductAllocator = WorkerAllocator<ProductQuery, ProductScratch>`。試験は `TestQuery`／`TestScratch` の別の static を使う。`WorkerAllocator::new` は `const unsafe fn` にした。SAFETY の契約は「各 slot を使う allocator は 1 つ」。slot を共有する allocator を 2 つ作ると、同じ region を 2 回 claim するため（レビューの m1。「対ごとに 1 つ」では、片方の slot だけを共有する組を止められないので、再レビューの m-A で直した）。**理由**：旧形で allocator の static が `.data` に入っていたのは、`Once` の初期状態が 0 でないため（Linux の release の binary の観測。`WORKER_ALLOCATOR` の非 0 の byte は、2 つの `Once` の位置の `03 00 00 00` だけで、`Heap::new(Manual)` と spin lock は全 0。他の OS の初期値は未確認で、0 でなくても `.data` に残るだけで、正しさは変わらない）。region だけを分ければ全 0 の static になり、`.bss` に入る | 次のものは変えない。<br>・上限（`QUERY_BYTES` 16 MiB、`SCRATCH_BYTES` 64 MiB）<br>・K1 の Q／S の値<br>・Talc の版<br>・`Region` の配置（arena は region の offset 120）<br>・Talc に渡す byte 数<br>・Q と S の分離、origin による heap の選択、S の scope と seal の規則<br>region は今までどおり process の寿命の static である。実行時の確保（mmap／VirtualAlloc）も、新しい失敗の経路も足さない | (1) 実行時の確保に直す（作業記録の §11 の旧い記述）。3 OS の unsafe と、起動時の確保の失敗という経路が増える。`.bss` で足りるので採らない。<br>(2) `Region` に arena への pointer を足す。制御部が増え、`QUERY_DATA`／`SCRATCH_DATA` が縮む。<br>(3) `#[link_section]` で section を指定する。OS ごとに名前が違い、移植性がない。<br>(4) arena（`[u8; N]`）だけを 16 byte 揃えの別の static にする（最初の版）。arena の先頭を 32 で割った余りが 0／16 になる。Talc の chunk の端数で、試験の Q と、製品の worker の S の使える範囲が 32 byte 増えた（下の測定）。Talc に渡す byte 数は同じだったが、旧形と同じ範囲を保てる DR-S11-1 の形があるので採らない | 着手前に read-only の advisor に諮った（pointer を足さない、受入れの条件を数値で照合する、試験の arena を分ける）。最初の版の測定の後にも諮った。独立レビュー（Fable、read-only）が最初の版の誤りと、この形を示した | 該当なし（値・送信先・保存範囲・契約・authority を変えない） | worker の process の寿命の中の static の配置だけ。owner・終了処理の行は変えない | 記録済み（commit の前） |
| DR-S11-2 | 2026-11-26 | C-resource（DR-S11-1 の会計） | Q／S の会計の式は変えない。`QUERY_DATA`／`SCRATCH_DATA` は旧形と同じ式で、`size_of::<Region<0>>()` もそのまま使う。TLS の owner pointer は `*const ()` にした（大きさは同じ）。footprint の const assert は意味を保ったまま、region を allocator の外に数える形に書き直した。<br>・Q：allocator の状態＋TLS pointer＋Q の region ≤ 16 MiB<br>・S：S の region ≤ 64 MiB<br>Q の footprint の値は、feature なしで 16,777,160 → 16,777,152、seam で 16,777,192 → 16,777,192 になった（旧形以下）。差は allocator の struct の揃えによる。旧形は region を含むので 16 byte 揃えで、状態の 17 byte が 32 に切り上がった。新形は 8 byte 揃えで 24 になる。seam の 57 byte は、新旧とも 64 になる。macOS／Windows で const assert が落ちても `QUERY_DATA` を調整して通さない（落ちたら止めて伺う） | 数える対象を減らさない。region が別の static になっても、Q／S に数える | 制御部を数えない（会計の緩和になる） | 同上 | 該当なし | 不要 | 記録済み（commit の前） |
| DR-S11-3 | 2026-11-26 | C-resource（受入れの条件） | 受入れの条件は次の 5 つ。<br>(a) Talc に渡す byte 数（`QUERY_DATA`／`SCRATCH_DATA`）と S の footprint が、feature なしと seam の両方で、前後同じであること。<br>(b) 試験 `q_s_origins_no_fallback_failed_realloc_and_zero_live_seal` が出す SQLite の Q の payload `N`（N+1 は拒否）が、両方の build で前後同じであること。<br>(c) release の worker の `.data` が arena の分だけ減り、`.bss` が増えること。<br>(d) CI と同じ `scripts/nir1-c-query-worker-ci.sh`（引数なし、`practical-retention`、`lifecycle`）と、crate の試験の全件が通ること。<br>(e) packaged の build に同梱された worker が、検査 script を通り、build 物と byte 同一であること。<br>(a) か (b) が 1 byte でも変われば、止めてユーザーに伺う。N は Talc の chunk（`CHUNK_UNIT`＝32 byte、`talc-5.1.1/src/base/chunk.rs:28`。`claim` は `src/base/mod.rs:623,637` で両端を揃える）の端数で動く派生値である。旧形と同じ配置（arena の offset 120）を保つことで、同じ値になる | 測るのは Linux x86_64 のローカルだけ。macOS／Windows の byte と section は未取得。CI の C-query の mac／Win の job は master への push と夜間だけ走るので（`scripts/ci-cross-os-scope.json`）、merge の後の結果になる | 実行 file の byte だけを見る（容量が黙って変わっても見逃す） | 同上 | 該当なし | 不要 | 記録済み（commit の前）。下の測定 |
| DR-S11-4 | 2026-11-26 | D-transport（DT-5 の引き継ぎ (4)） | `Nir1LocalGenerationInput.config` を module-private にする。値を変えられるのは、`#[cfg(test)]` の `with_config_for_test` と子 module の試験だけ。`nir1_local_entry.rs` の `run_starter` の `config` 引数と import は、`#[cfg(test)]` のときだけ持つ。製品の経路は今までどおり `Nir1LocalTransportConfig::DEFAULT`（`new` が入れる値）で走る | 製品の挙動は変えない（非 test では、旧形の代入も `DEFAULT` を入れるだけだった）。crate の中の別の module が、製品の build で transport の期限・上限を書き換える口を無くす | (1) `pub(crate)` のまま残す（引き継ぎ (4) が残る）。<br>(2) config を `new` の引数にする（製品の呼出し側に値を選ばせることになり、口が広がる） | 不要（可視性を締めるだけ） | 該当なし | 不要 | 記録済み（commit の前） |
| DR-S11-5 | 2026-11-26 | C-resource（残る制限） | 2 つは直さずに残す。<br>(1) arena が `.data` に戻る退行を止める自動の検査は足さない。worker の byte や section の上限は新しい gate で、既存の閾値にもない。今回は測定を記録するだけにする。<br>(2) `nir1_graph_eval/mod.rs` の「worker は約 90 MB」の注記と、計測用の旧い patch（`proposal7-measurement/harness/measure-instrumentation.patch`。もともと master に当たらない履歴物）は更新しない | 正しさ・資源の契約は変えない | 退行の検査を足す（新しい gate になる。必要なら別に伺う） | 不要 | 該当なし | 不要 | 記録済み（commit の前） |

## 測定（DR-S11-3）

- 環境：Linux x86_64、ローカル。
- target dir は前後で同じ（2 台目の HDD の `s11-ab`）。build の前に source を touch した。
- 基準は origin/master `2db49f806` の detached worktree。容量の出力は、基準の tree にだけ一時的に入れた。

### release の worker

command は `cargo build --locked --release -p grimodex-db --bin nir1-c-query-worker`。

| 項目 | 前（2db49f806） | 後（DR-S11-1） | 参考：最初の版（代替案 (4)） |
|---|---|---|---|
| file の byte | 91,679,848 | 7,793,192 | 7,793,464 |
| md5 | `bdffef0a795e0e32dba7804551bb4e54` | `5489a9e1f5ca9015a39402cbc1937618` | `c6942b7b9badf3634ae17237f297719a` |
| `.data` | 83,904,312 | 18,360 | 18,616 |
| `.bss` | 1,480 | 83,887,400 | 83,887,176 |
| `.text` | 4,190,218 | 4,189,962 | 4,189,962 |
| `.rodata` | 328,536 | 328,536 | 328,536 |

後の binary の配置（`nm`）：

- `ProductQuery` の region は `0x5fbe50`。arena は region＋120 なので、先頭を 32 で割った余りは 8。
- `ProductScratch` の region は `0x15fbdf0`。arena の先頭の余りは 8。
- どちらも `.bss`（`b`）にある。`WORKER_ALLOCATOR` は `.data`（`d`）に残る。中身は `Once` などの状態だけ。

### 容量

試験 `q_s_origins_no_fallback_failed_realloc_and_zero_live_seal` の出力。表の値は試験の binary の `TEST_ALLOCATOR` のもの。

| build | `QUERY_DATA` | `SCRATCH_DATA` | S footprint | Q footprint | Q の先頭 mod 32 | N |
|---|---|---|---|---|---|---|
| 前、feature なし | 16,776,999 | 67,108,672 | 67,108,800 | 16,777,160 | 24 | 16,775,408 |
| 前、seam | 16,776,999 | 67,108,672 | 67,108,800 | 16,777,192 | 24 | 16,775,408 |
| 後、feature なし | 16,776,999 | 67,108,672 | 67,108,800 | 16,777,152 | 24 | 16,775,408 |
| 後、seam | 16,776,999 | 67,108,672 | 67,108,800 | 16,777,192 | 24（S も 24） | 16,775,408 |
| 参考：最初の版、feature なし | 16,776,999 | 67,108,672 | 67,108,800 | 16,777,176 | 16 | 16,775,408 |
| 参考：最初の版、seam | 16,776,999 | 67,108,672 | 67,108,800 | 16,777,208 | 0 | 16,775,440 |

- **後の形は (a) と (b) を満たす。** Talc に渡す byte 数、S の footprint、N が、両方の build で前と同じ。Q の footprint は前以下。
- **Q と S の使える範囲は、製品の worker を含めて旧形と同じ。** region は 16 byte 揃えで arena は offset 120 なので、arena の先頭の余りは 8 か 24 だけである。旧形も同じ集合だった。端数の損失は、どちらの余りでも Q が 39 byte、S が 32 byte で同じになる。最初の gap は Q が 16,775,424 byte、S が 67,107,104 byte。製品の worker の余りは 8 だった。根拠は、再レビューの計算と製品の binary の `nm` で、link の配置には依らない。
- **最初の版は、余りが 0／16 になり、範囲が 32 byte 増えた。** 試験の Q（seam）と、製品の worker の S（余り 0）の範囲が増えた。上限と、渡す byte 数は変えていない。それでも旧形と同じ形を保てるので、採り直した。
- macOS／Windows の byte と section は未取得。

### 検証

Linux x86_64 のローカル。cargo の出力先は 2 台目の HDD（`s11-ab`、`s11-node`）。

- 検証した版：commit `a3964ae88` の版（comment の直しの前）。
- 直しの中身：その後に入れたのは、`new` の SAFETY の文言と、試験の注記だけ（再レビューの m-A と nit）。code は変えていない。
- packaged の build：直しの後の版で作った。

| 検証 | 結果 |
|---|---|
| `rustfmt --check`（変更した file） | 通過 |
| `cargo check --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding` | 通過 |
| `cargo clippy --workspace --exclude grimodex --all-targets --features grimodex-semantic/semantic-embedding -- -D warnings` | 通過 |
| `cargo test --locked -p grimodex-db`（全件） | 4,172 pass、0 fail |
| `cargo test -p grimodex-db --features nir1-c-query-test-seam --bin nir1-c-query-worker` | 2 pass |
| `scripts/nir1-c-query-worker-ci.sh`（引数なし） | 11 pass |
| 同 `practical-retention` | 2 pass。worker の READY 時の RSS は約 14〜15 MB（記述のための観測で、閾値はない。前の値は取っていない） |
| 同 `lifecycle` | 26 pass。seam なしの release の worker で、Q の上限の近くの registration を含む実 worker の試験を回した |
| `cargo clippy`（node crate。`licensing,legacy-keyring-migration` と既定の両方）`-- -D warnings` | 通過 |
| `cargo test`（node crate、`licensing,legacy-keyring-migration`） | 956 pass、0 fail |
| `pnpm electron:native:release`（`worker:verify:release` を含む）、`pnpm electron:build`、`electron-builder --dir --linux --publish never` | 通過 |
| packaged の `linux-unpacked/resources/bin/nir1-c-query-worker` | 下の 4 点 |

packaged の worker の確認：

- release の build 物と byte 同一（7,793,208 byte、mode 755、`.data` 18,360、`.bss` 83,887,400）。
- 検査 script（`verify-release-graph-worker.mjs`）を通った。
- 引数なしで起動した結果と、空の workspace を与えて起動した結果は、変更前の binary と同じ。どちらも `NIR1_C_QUERY_STARTUP_SQLITE_CONFIG` を出して exit 1 になる。
- packaged の app を起動しての worker の spawn は確かめていない。spawn は需要の時点で起き、DR-CP2B の P1 の記録でも、app の起動中の worker の process は 0 だった。

既存の失敗（今回の変更の外。CI は回していない）：

- `cargo fmt --all --check` は、`grimodex-core/src/narrative_dependency.rs` と `grimodex-db/src/agent_writes.rs` の差分で落ちる。
- `cargo clippy -p grimodex-db --all-targets --features nir1-c-query-test-seam` は、`nir1_graph/c_query_worker.rs:3728` の `useless_vec` で落ちる。

未取得：

- macOS／Windows の build と、そこでの試験。
