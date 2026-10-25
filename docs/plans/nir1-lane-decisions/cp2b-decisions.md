# CP-2b の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

出所は integrator の TASK（`cp2b-task.md`、2026-10-25、基点 `origin/master` `bdc892d7`）、CP-2a の記録（[cp2a-decisions.md](cp2a-decisions.md) の CP2a-D3、D13、D15、§4 の 5）、NC-1 の記録（[nc1-decisions.md](nc1-decisions.md) の DR-NC1-40）である。この文書は製品コードの mutation の前に書き、実装後の事実は末尾の「実装後の追記」に足す（前の本文は直さない）。

この文書の P1 の節は、CP-2b の PR 列（TASK §7.1）の **P1（worker の build と同梱、Main の path 解決、N-API constructor、`configure_worker_path`、契約試験）** だけを扱う。P2〜P4（packaged smoke の harness と workflow、H1、G-pub の記録）と Z（zip）は別の担当・別の PR で、ここでは決めない。TASK が名前で予告する DR-CP2B-1（「Y-1 を各 OS で」の読み）、DR-CP2B-2（zip との関係）、DR-CP2B-3（env 名の数の確認の読み）は、それぞれの担当が足す番号として空けておき、P1 の判断は `DR-CP2B-P1-n` と番号を分ける。

## 1. 範囲と、範囲の外（P1）

- 範囲: (a) C-query の worker（`src-tauri/crates/grimodex-db/src/bin/nir1-c-query-worker.rs`）を seam の feature なしで release build する script と、その検査、(b) `electron-builder.yml` の `extraResources`（既存の `src-tauri/target/release` → `bin` の block）に worker を足す、(c) Main の `initBackend` で、resource root と同じ形で worker の絶対 path を解決して Backend constructor に渡す、(d) N-API の Backend constructor の 4 番目の引数と、Native の `configure_worker_path` の呼出し、(e) 契約試験。
- 範囲の外: `PRODUCT_GRAPH_PUBLISHED` の切替、gate を開けること、worker を spawn する経路を開けること、`release.yml`、署名・公証・publish の設定、version・tag・release notes、`electron/main/index.ts`／`windows.ts`／`rendererContainment*`、Y-1 の道具、`state.rs` の AppState の構築、renderer。

## 2. 影響マトリクス（refactor-cross-boundaries。実装前）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| P1 | packaged の起動（3 OS） | Main `initBackend`（`electron/main/backend.ts`）。`index.ts` の呼出し順は変えない | 新しい `resolveGraphWorkerPath()`：`<process.resourcesPath>/bin/nir1-c-query-worker`（Windows は `.exe`）。env・argv・renderer・IPC・設定を読まない。path の文字列を constructor の 4 番目の引数で渡す | Native の Backend constructor → `Nir1GraphProductOwner::configure_worker_path` → `ProcessGraphWorkerFactory::from_path`（絶対 path、通常 file、file 名の一致、親が絶対） | gate は閉じたまま（begin は `not-activated`）。worker は起動しない | 検証の失敗は constructor を失敗させず、warn の log（閉じた code だけ。path を出さない）を残して worker を未設定にする。Graph は `worker-unavailable`（gate 閉の間はその手前の `not-activated`） | vitest（packaged の path、引数の受渡し）、Rust（不正な path でも Backend が作れ、worker が未設定） | planned |
| P2 | dev の起動（非 packaged） | 同上 | `<mainDir>/../src-tauri/target/release/nir1-c-query-worker[.exe]`（`extraResources` の `from` と同じ置き場。debug は見ない） | 同上 | 同上 | build していなければ file が無く、P1 と同じ fail-soft | vitest（dev の path） | planned |
| P3 | file が無い／不正（P1・P2 の失敗） | Native | `from_path` が `NIR1_GRAPH_WORKER_PATH` で拒否 | warn の log。Backend は使える | 起動を壊さない。renderer へ出ない | — | Rust（相対、不在、directory、別名、二度目の設定の拒否）。vitest（Main は検証しないので `initBackend` が成功する） | planned |
| P4 | 既存の constructor の呼出し（3 引数以下。`verify-release-native.mjs`、smoke、Rust の試験 18 か所） | 各呼出し側 | 4 番目は optional（`null`／省略）。Rust の `Backend::new`（3 引数）は試験・評価 harness 用の入口として残し、worker を設定しない | — | 既存の挙動は不変 | 互換 | 既存の試験 | planned |
| P5 | release build の native 段（`pnpm electron:native:release`。release.yml とローカルの `electron:package*` が呼ぶ） | `package.json` | `worker:build:release`＝`cargo build --locked --release --manifest-path src-tauri/Cargo.toml -p grimodex-db --bin nir1-c-query-worker`（feature を足さない。`default = []`）、続けて `worker:verify:release`（file の存在、POSIX の実行可能、`NIR1_C_QUERY_TEST_` の byte 列が無い） | `electron-builder` の `extraResources` → package の `resources/bin/` | seam を含む worker を同梱しない（同じ target dir に seam 付きの build が残っていても、release 段で必ず作り直して検査する） | release.yml は変えない。release の出力に worker が増える（不活性） | 契約試験（package.json の script の連鎖と feature の不在）、検査 script の単体試験 | planned |
| P6 | package の内容 | `electron-builder.yml` | `extraResources` の既存の `bin` block の filter に `nir1-c-query-worker`、`nir1-c-query-worker.exe` を足す。`files`（app.asar）には足さない | 3 OS の package | 署名・公証・publish・`asarUnpack`・`mac.hardenedRuntime` は不変 | — | 契約試験（filter、`files` に `src-tauri/target` が無い、署名の key が不変） | planned |
| P7 | CI の Windows NSIS compile job（`ci.yml` の placeholder） | ci.yml | worker の placeholder は作らない。filter が一致しなければ electron-builder は何も写さない | — | job の目的（makensis の 2 pass）は不変 | — | out of scope: ci.yml を変えない。hosted CI で確かめる | out of scope: ci.yml を変えない |
| P8 | renderer、preload、IPC | — | 経路を足さない。worker の path は IPC の contract に現れない | — | 起動時 JS graph の予算 | — | 静的試験（`electron/shared`、`electron/preload`、`src` に worker 名・引数名が無い）、`check-performance-budgets.mjs` の実測 | planned |
| P9 | MCP（standalone） | — | 変えない | — | — | — | — | out of scope: MCP は worker を使わない |
| P10 | Graph の製品の入口（`begin`、`begin_deferred`、`nir1_graph_query`、D-final、Related Scenes） | Native | 変えない。gate 閉で `not-activated` を返し、worker の factory を読む前に止まる | — | spawn 0 | — | Rust（有効な実行可能 file を設定した Backend で、全入口を叩いても実行の痕跡が 0） | planned |

lifecycle note（P1、P3、P5、P10 が subprocess に関わる。下の §3 の matrix で全項目を埋める）。

## 3. owner／lifecycle matrix（GDX-PRECHECK-001。mutation の前）

| 項目 | 内容（P1 の後の状態） |
|---|---|
| entry／start | worker の子 process の start は、owner thread の `context.factory.create`（`nir1_graph_product.rs` の `build_and_serve` の中）→ `CQueryWorkerOwner` の prepare だけ。owner thread は `admit_and_route` を通った需要（`begin`／`begin_deferred`）でだけ作られる。P1 は start の経路を足さない |
| admission closure | `admit_and_route` は `publication_open()`（`PRODUCT_GRAPH_PUBLISHED=false`、compile-time の assert。試験の override は `#[cfg(test)]` だけ）の検査で `not-activated` を返し、その後ろにある factory の読取（`shared.worker.get()`）に届かない。P1 で factory が設定されても、この順序は変えない |
| retry／reentrant | 作り直し・rekey・backoff は owner thread の中だけで、owner thread は gate 閉の間は存在しない。`configure_worker_path` の再入は `OnceLock` で拒否（`NIR1_GRAPH_WORKER_ALREADY_CONFIGURED`）。製品の呼出しは constructor の 1 回だけで、constructor は `initBackend` の 1 回だけ |
| pending-start | なし。constructor は `std::fs::metadata` の stat を 1 回するだけで、thread も子 process も作らない |
| active handle の owner | `ProcessGraphWorkerFactory`（path だけを持つ）は `Shared::worker`（`OnceLock<Arc<dyn GraphWorkerFactory>>`）が持つ。子 process の handle は作られない |
| cancellation | 対象なし（子が無い）。既存の ticket の cancel は不変 |
| bounded wait | constructor に新しい待ちは無い（stat だけ）。`begin` は wait 0 のまま |
| 実終了の証拠 | 子を作らないことの証拠: 試験で、実行されると marker file を書く実行可能 file を worker の path として constructor に渡し、すべての製品の入口を叩いた後に marker が無いこと、`prepares_started` が 0、slot が Empty であることを確かめる（kill 要求や error では代えない）。marker の file を直接実行すると marker が書かれる正の対照を同じ試験に置く |
| error／timeout／onClosed の owner | path の検証失敗の owner は Native の constructor（warn の log と未設定）。Main の `initBackend` の fail-soft（dialog）と `failFast` の規則は不変で、path の失敗では発火しない |
| persisted restart state | なし。path は保存せず、起動ごとに Main が解決し直す |
| shutdown／Restore／Open | 不変（`close_for_shutdown` 等。子が無いので終わらせるものも無い） |

## 4. 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP2B-P1-1 | 2026-10-25 | CP-2b P1 | worker の path の出所は Main の `resolveGraphWorkerPath()` だけ。packaged は `process.resourcesPath/bin/<名>`、dev は `<repo>/src-tauri/target/release/<名>`。env の override（`GRIMODEX_MCP_PATH` の類）、argv、renderer、IPC、設定 file を読まない | actor は Main。path は Main から Native の constructor へ 1 回だけ渡る。renderer は到達できない。受信先は増えない | (1) env の override を置く案: smoke に便利だが、実行する binary を env で差し替える入口になる（CP2a-D3「env から path を受け取らない」）。(2) dev で debug も探す案（MCP の形）: 2 つの置き場から mtime で選ぶ規則が増え、seam 付きの debug build を拾いうる | なし（TASK の範囲の読み） | 該当なし（公開・送信先・保存・閾値・外向きの操作のどれでもない） | §3 | 記録済み（実装前） |
| DR-CP2B-P1-2 | 2026-10-25 | 同 | 検証は Native の `from_path` の 1 か所だけ。Main は path を組み立てるだけで存在を確かめない。検証に落ちたら constructor は成功させ、warn の log（閉じた code。path は出さない）を残して worker を未設定にする（Graph は `worker-unavailable`。gate 閉の間はその手前の `not-activated`） | 起動を壊さない（Graph は付加機能）。log に path を出さない（利用者の home を含みうる） | (1) 失敗で constructor を失敗させる案: Graph のために DB を伴う全機能が止まる。(2) Main でも `existsSync` を見る案: 検証が 2 か所になり食い違いうる | なし | 該当なし | §3 | 記録済み（実装前） |
| DR-CP2B-P1-3 | 2026-10-25 | 同 | N-API の constructor は 4 引数（`graphWorkerPath?: string \| null`）。Rust 側は napi の constructor を `new_from_main` とし、従来の 3 引数の `Backend::new` は worker を設定しない Rust 専用の入口（試験・評価 harness）として残す | constructor は Main だけが呼ぶ（renderer は `.node` を読めない）。3 引数の入口は JS に出ない | 18 か所の Rust の呼出しに `None` を足す案: 試験 file 11 本に機械的な差分が出て、CP-4 の branch と衝突しやすい（TASK §8） | なし | 該当なし | §3 | 記録済み（実装前） |
| DR-CP2B-P1-4 | 2026-10-25 | 同 | release の native 段に `worker:build:release`（`--locked --release -p grimodex-db --bin nir1-c-query-worker`、feature なし）と `worker:verify:release`（`electron/scripts/verify-release-graph-worker.mjs`。存在、通常 file、POSIX の実行可能、`NIR1_C_QUERY_TEST_` の byte 列が無いこと）を足す。検査 script は path を引数で受け、P2 が package の中の binary に当てられる形にする | 同梱する binary に seam が入らないことを build の段で止める（TASK §3 の 3）。lane の script（`nir1-c-query-worker-ci.sh`）は同じ `src-tauri/target/release` に seam 付きを作るので、release 段で必ず作り直して検査する | (1) electron-builder の `afterPack` で検査する案: packaging の hook を足すことになり、署名の前後の順序に触れる。(2) 検査を P2 だけに置く案: ローカルの `electron:package*` で seam 付きを同梱しうる | なし | 該当なし | §3 | 記録済み（実装前） |
| DR-CP2B-P1-5 | 2026-10-25 | 同 | `electron-builder.yml` は既存の `src-tauri/target/release` → `bin` の block の filter に 2 名を足すだけ。`files`、`asarUnpack`、`mac`（`hardenedRuntime`）、`win`、`publish` は変えない。macOS の署名は electron-builder が bundle の中の Mach-O を署名する既存の挙動（`grimodex-mcp` と同じ）に任せ、確かめるのは P2 の B 案 | release の出力は変わる（不活性の binary が増える）が、TASK §6 の「当たらない」 | 新しい block を足す案: 置き場が 2 つになる | なし | 該当なし（TASK §6 が「当たらない」と定める） | §3 | 記録済み（実装前） |

## 5. TASK の「確かめられなかったこと」のうち P1 に関わるもの（調べた結果）

- electron-updater の session（TASK §11）: 手元の `electron-updater@6.8.9` の `out/electronHttpExecutor.js` で、`getNetSession()` は `session.fromPartition("electron-updater", { cache: false })`（`persist:` の無い partition なので memory の session）を作り、executor ごとに 1 回 cache して `net.request({ ...options, session })` に渡す。redirect は `redirect: "manual"` で受けて request を作り直す。よって H1 (b) の試験は default session でなく partition `electron-updater` の session で `net.request` を作れば updater 方式と同じになる（K3/3 の「更新の通信は default session でなく partition `electron-updater`」と一致）。P1 は updater に触れない。
- worker の 3 OS の packaged 確認（存在、実行可能、macOS の署名、seam、env 名の数、Windows の console window）は P2 の workflow で行う。P1 では Linux のローカルの release build で seam の文字列が無いことだけを確かめる（実装後の追記に記録）。

## 6. 実装後の追記

2026-10-25、branch `claude/cp2b-p1`（基点 `bdc892d7`）。

### 6.1 マトリクスの最終状態

P1〜P6、P8、P10 は `implemented`（P4 は `verified unchanged`：既存の 3 引数以下の呼出しは変えていない）。P7、P9 は `out of scope`（記録のとおり）。§3 の lifecycle matrix の各項目は実装と一致する（start の経路を足していない。constructor が足したのは stat 1 回と `OnceLock` への設定だけ）。

### 6.2 実装の要点

- Main: `resolveGraphWorkerPath()`（`electron/main/backend.ts`）。引数は `isPackaged`、`resourcesPath`、`mainDir`、`platform` だけで env を受け取らない。`initBackend` は既存の resource root の解決の隣で解決し、constructor の 4 番目に渡す。`index.ts` の呼出し順は変えていない。
- Native: napi の constructor は `Backend::new_from_main`（4 引数）。3 引数の `Backend::new` は Rust 専用の別 `impl` に置き、`None` で `new_from_main` を呼ぶ。constructor は `AppState` の構築の後で `configure_worker_path` を 1 回呼び、`Err` は `tracing::warn!(code = %error, …)`（閉じた code だけ）にして構築を続ける。`state.rs` は変えていない。
- 補足（実装で分かったこと）: grimodex-node は tracing の subscriber を入れていないので、この warn は製品では表に出ない（既存の warn と同じ）。path の受理・拒否は Rust の試験で確かめ、packaged では file の存在と検査 script で確かめる。P2 で受理を観測したくなっても、N-API の観測口は足さない（新しい surface になる）。
- release 段: `worker:build:release`／`worker:verify:release`（`electron/scripts/verify-release-graph-worker.mjs`）を `electron:native:release` の末尾に足した。`electron-builder.yml` は `bin` の filter の 2 名だけ。
- `index.d.ts` は手で直した後、`pnpm napi:build:release` の再生成が同じ内容になることを確かめた。
- `scripts/local-ci-full-workload-allocation.json` の `package.json` の sha256 を更新した（`registryDigest` は registry の digest で変わらない）。

### 6.3 試験

| 試験 | 件数・結果 |
|---|---|
| `electron/main/backend.test.ts`（packaged 3 OS と dev の path、絶対 path、env を読まない〔stub と関数本体の静的検査〕、renderer・preload・`electron/shared` に worker 名が無く Main で解決するのは backend.ts だけ、`initBackend` が 4 番目に解決値を渡し存在を確かめない） | 新規 6 件。file 全体 17 passed |
| `electron/main/packagingConfig.test.ts`（既存の packaging の契約。native release の連鎖、worker の build／verify の script、`extraResources`） | 期待値を更新。`pnpm test:electron --run` 全体 96 files／2259 passed |
| `scripts/release-workflows.test.mjs`（`bin` の filter、他の block と app.asar の `files` に worker・target が無い、packaging の hook が無い、seam の feature なしの build と検査の連鎖、worker の bin に required-features が無い、検査 script が不在・別名・directory・相対・非実行・chunk の境界をまたぐ seam の文字列を拒否） | 新規 4 件。22 passed |
| Rust `nir1_graph_activation_tests`（不正な path 7 通りで Backend が作れ worker が未設定、正しい path で設定、3 引数の入口は設定しない／実行されると marker を書く worker を設定し、`begin`・`begin_deferred`・`nir1_graph_query` を 8 回ずつ叩いても marker 0、`prepares_started` 0、`pending` 0、slot Empty、drop の後も marker 0。marker の正の対照つき／lib.rs の `.configure_worker_path(` は napi constructor の中の 1 か所だけ、env からの読取りが無い） | 新規 3 件。`cargo test --lib`（grimodex-node）669 passed／7 ignored |
| `cargo +1.99.0 clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings` | 警告 0 |
| `node --test --test-name-pattern="workload\|sizing\|allocation" scripts/ci-pause.test.mjs scripts/local-ci.test.mjs` | 8 passed（sizing digest の更新の確認） |

変異（どれも元に戻して再確認した）: Main が env から path を読む／4 番目を渡さない／Main が存在を確かめて投げる／dev で debug を指す → vitest が赤。filter を消す／build に seam の feature を足す／verify を連鎖から外す／検査 script の seam の検査を外す／chunk 境界の持越しを外す／app.asar の `files` に worker を足す → release 契約試験が赤。constructor が worker を直接実行する／不正な path で constructor を失敗させる／`from_path` の検証を外す／試験用の gate を既定で開ける／napi method で 2 つ目の設定口を足す → Rust の試験が赤（それぞれ該当の 1 件）。

### 6.4 実機・package で確かめたこと（Linux、ローカル）

- `cargo build --locked --release -p grimodex-db --bin nir1-c-query-worker`（この worktree の `src-tauri/target`）の binary に `NIR1_C_QUERY_TEST_` の byte 列は無い（検査 script と `strings`）。
- `pnpm napi:build:release`、`pnpm napi:verify:release`、`pnpm mcp:build:release`、`pnpm worker:build:release`、`pnpm worker:verify:release`、`pnpm electron:build`、`electron-builder --dir --linux --publish never`: `linux-unpacked/resources/bin/nir1-c-query-worker` は build 物と byte 同一、mode 755、検査 script を通る。`app.asar`（805 entries）に worker、`src-tauri`、harness の file は無い。electron-builder は Electron の zip を取得した（既存の build の挙動）。
- packaged の起動（`scripts/local-ci-xvfb.mjs` を host の namespace で使い、`WAYLAND_DISPLAY`／`WAYLAND_SOCKET`／`XDG_SESSION_TYPE`／`DBUS_SESSION_BUS_ADDRESS` と env の proxy を除去、一時の `HOME`／`XDG_CONFIG_HOME`／`XDG_DATA_HOME`／`XDG_CACHE_HOME`／`GRIMODEX_USER_DATA_DIR`）: `napi backend loaded` が出て（4 引数の constructor で Backend が作れた）、15 秒の間 100 ms ごとに `/proc/*/exe` を見て（136 回）worker の process は 0。app の process group に SIGTERM を送り、`close` の exit code 0、残りの process 0 を終了の証拠とした。利用者の `/tmp/.X11-unix/X0`、`X1` は残っている。一時 dir は消した。外部網なしは主張しない（辞書・更新の確認など既存の通信は起きうる）。

### 6.5 確かめていないこと（P2 以降）

- Windows／macOS の package（存在、実行可能、macOS の署名と公証〔`grimodex-mcp` と同じく electron-builder が bundle の中の Mach-O を署名する見込み。推定〕、Windows の console window、env 名の数）。P2 の workflow と B 案。
- 申し送り（判断は integrator）: worker の binary は約 91.5 MB で、うち約 84 MB が `.data` の `WORKER_ALLOCATOR`（`c_query_fixed_allocator` の固定の arena。`Heap::new(Manual)` が 0 でない初期値を持つので、0 の `backing` も含めて `.bss` でなく `.data` に入る）。gzip で約 3.2 MB、xz で約 2.4 MB なので installer と更新の zip の増分は数 MB だが、展開後（install 後の disk、AppImage の mount、deb／rpm）は約 90 MB 増える。arena を別の 0 初期化の static に分ければ `.bss` に移せる見込み（推定）だが、worker は C-resource の受入れの対象なので P1 では変えていない。
