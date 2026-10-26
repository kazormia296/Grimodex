# CP-2b の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

出所は integrator の TASK（`cp2b-task.md`、2026-10-25、基点 `origin/master` `bdc892d7`）、CP-2a の記録（[cp2a-decisions.md](cp2a-decisions.md) の CP2a-D3、D13、D15、§4 の 5）、NC-1 の記録（[nc1-decisions.md](nc1-decisions.md) の DR-NC1-40）である。この文書は製品コードの mutation の前に書き、実装後の事実は末尾の「実装後の追記」に足す（前の本文は直さない）。

この文書の P1 の節は、CP-2b の PR 列（TASK §7.1）の **P1（worker の build と同梱、Main の path 解決、N-API constructor、`configure_worker_path`、契約試験）** だけを扱う。P2〜P4（packaged smoke の harness と workflow、H1、G-pub の記録）と Z（zip）は別の担当・別の PR で、ここでは決めない。TASK が名前で予告する DR-CP2B-1（「Y-1 を各 OS で」の読み）、DR-CP2B-2（zip との関係）、DR-CP2B-3（env 名の数の確認の読み）は、それぞれの担当が足す番号として空けておき、P1 の判断は `DR-CP2B-P1-n` と番号を分ける。

## 1. 範囲と、範囲の外（P1）

- 範囲: (a) C-query の worker（`src-tauri/crates/grimodex-db/src/bin/nir1-c-query-worker.rs`）を seam の feature なしで release build する script と、その検査、(b) `electron-builder.yml` の `extraResources`（既存の `src-tauri/target/release` → `bin` の block）に worker を足す、(c) Main の `initBackend` で、resource root と同じ形で worker の絶対 path を解決して Backend constructor に渡す、(d) N-API の Backend constructor の 4 番目の引数と、Native の `configure_worker_path` の呼出し、(e) 契約試験。
- 範囲の外: `PRODUCT_GRAPH_PUBLISHED` の切替、gate を開けること、worker を spawn する経路を開けること、`release.yml`、署名・公証・publish の設定、version・tag・release notes、`electron/main/index.ts`／`windows.ts`／`rendererContainment*`、Y-1 の道具、`state.rs` の AppState の構築、renderer。

## 2. 影響マトリクス（refactor-cross-boundaries。実装前）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| P1 | packaged の起動（3 OS） | Main `initBackend`（`electron/main/backend.ts`）。`index.ts` の呼出し順は変えない | 新しい `resolveGraphWorkerPath()`：`<process.resourcesPath>/bin/nir1-c-query-worker`（Windows は `.exe`）。env・argv・renderer・IPC・設定を読まない。path の文字列を constructor の 4 番目の引数で渡す | Native の Backend constructor → `Nir1GraphProductOwner::configure_worker_path` → `ProcessGraphWorkerFactory::from_path`（絶対 path、通常 file、file 名の一致、親が絶対） | gate は閉じたまま（begin は `not-activated`）。worker は起動しない | 検証の失敗は constructor を失敗させず、warn の log（閉じた code だけ。path を出さない）を残して worker を未設定にする。begin の拒否の順序は `not-activated`（gate）→ `profile-not-restricted`（D2a）→ `worker-unavailable`（`nir1_graph_product.rs` の `admit_and_route`）で、gate 閉の間は常に `not-activated`（レビュー修正 P3-4 で順序を実際に合わせた） | vitest（packaged の path、引数の受渡し）、Rust（不正な path でも Backend が作れ、worker が未設定） | planned |
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
| path の検証の強さ（レビュー修正 P3-1） | `from_path` は `std::fs::metadata` を使うので symlink を辿って受理し、実行権は見ない（file 名、絶対 path、通常 file、親が絶対だけ）。path は Main が `resources` の固定の場所から組み立てるだけで、そこを書き換えられる者は app 本体（app.asar、`.node`）も書き換えられるので、symlink の受理は新しい脆弱性ではない。`symlink_metadata` に変えるかは DR-CP2B-P1-6 |
| cancellation | 対象なし（子が無い）。既存の ticket の cancel は不変 |
| bounded wait | constructor に新しい待ちは無い（stat だけ）。`begin` は wait 0 のまま |
| 実終了の証拠 | 子を作らないことの証拠: 試験で、実行されると marker file を書く実行可能 file を worker の path として constructor に渡し、すべての製品の入口を叩いた後に marker が無いこと、`prepares_started` が 0、slot が Empty であることを確かめる（kill 要求や error では代えない）。marker の file を直接実行すると marker が書かれる正の対照を同じ試験に置く。**unix だけ**: unix 以外では worker が空の file で、検出器も正の対照も無いので marker 0 の主張は空になる（Windows では counter と slot の検査だけが意味を持つ。レビュー修正 P3-5） |
| error／timeout／onClosed の owner | path の検証失敗の owner は Native の constructor（warn の log と未設定）。Main の `initBackend` の fail-soft（dialog）と `failFast` の規則は不変で、path の失敗では発火しない |
| persisted restart state | なし。path は保存せず、起動ごとに Main が解決し直す |
| shutdown／Restore／Open | 不変（`close_for_shutdown` 等。子が無いので終わらせるものも無い） |

## 4. 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP2B-P1-1 | 2026-10-25 | CP-2b P1 | worker の path の出所は Main の `resolveGraphWorkerPath()` だけ。packaged は `process.resourcesPath/bin/<名>`、dev は `<repo>/src-tauri/target/release/<名>`。env の override（`GRIMODEX_MCP_PATH` の類）、argv、renderer、IPC、設定 file を読まない | actor は Main。path は Main から Native の constructor へ 1 回だけ渡る。renderer は到達できない。受信先は増えない | (1) env の override を置く案: smoke に便利だが、実行する binary を env で差し替える入口になる（CP2a-D3「env から path を受け取らない」）。(2) dev で debug も探す案（MCP の形）: 2 つの置き場から mtime で選ぶ規則が増え、seam 付きの debug build を拾いうる。ただし release だけにしても、dev では lane の script（`nir1-c-query-worker-ci.sh`）が同じ `src-tauri/target/release` に作った seam 付きの build があれば、それを拾いうる（レビュー修正 P3-3）。害が無い理由: gate が閉じていて起動しない。PUB-G の後でも、子は `env_clear()` の後に起動する（CP2a-D13）ので、親の env にある `NIR1_C_QUERY_TEST_*` は worker に届かず、seam は動かない。package は release 段で作り直して検査した binary だけを同梱する（DR-CP2B-P1-4） | なし（TASK の範囲の読み） | 該当なし（公開・送信先・保存・閾値・外向きの操作のどれでもない） | §3 | 記録済み（実装前） |
| DR-CP2B-P1-2 | 2026-10-25 | 同 | 検証は Native の `from_path` の 1 か所だけ。Main は path を組み立てるだけで存在を確かめない。検証に落ちたら constructor は成功させ、warn の log（閉じた code。path は出さない）を残して worker を未設定にする。begin の拒否は `not-activated`（gate）→ `profile-not-restricted`（D2a）→ `worker-unavailable` の順で、gate 閉の間は常に `not-activated`（レビュー修正 P3-4 で順序を実際に合わせた） | 起動を壊さない（Graph は付加機能）。log に path を出さない（利用者の home を含みうる） | (1) 失敗で constructor を失敗させる案: Graph のために DB を伴う全機能が止まる。(2) Main でも `existsSync` を見る案: 検証が 2 か所になり食い違いうる | なし | 該当なし | §3 | 記録済み（実装前） |
| DR-CP2B-P1-3 | 2026-10-25 | 同 | N-API の constructor は 4 引数（`graphWorkerPath?: string \| null`）。Rust 側は napi の constructor を `new_from_main` とし、従来の 3 引数の `Backend::new` は worker を設定しない Rust 専用の入口（試験・評価 harness）として残す | constructor は Main だけが呼ぶ（renderer は `.node` を読めない）。3 引数の入口は JS に出ない | 18 か所の Rust の呼出しに `None` を足す案: 試験 file 11 本に機械的な差分が出て、CP-4 の branch と衝突しやすい（TASK §8） | なし | 該当なし | §3 | 記録済み（実装前） |
| DR-CP2B-P1-4 | 2026-10-25 | 同 | release の native 段に `worker:build:release`（`--locked --release -p grimodex-db --bin nir1-c-query-worker`、feature なし）と `worker:verify:release`（`electron/scripts/verify-release-graph-worker.mjs`。存在、通常 file、POSIX の実行可能、`NIR1_C_QUERY_TEST_` の byte 列が無いこと）を足す。検査 script は path を引数で受け、P2 が package の中の binary に当てられる形にする | 同梱する binary に seam が入らないことを build の段で止める（TASK §3 の 3）。lane の script（`nir1-c-query-worker-ci.sh`）は同じ `src-tauri/target/release` に seam 付きを作るので、release 段で必ず作り直して検査する | (1) electron-builder の `afterPack` で検査する案: packaging の hook を足すことになり、署名の前後の順序に触れる。(2) 検査を P2 だけに置く案: ローカルの `electron:package*` で seam 付きを同梱しうる | なし | 該当なし | §3 | 記録済み（実装前） |
| DR-CP2B-P1-5 | 2026-10-25 | 同 | `electron-builder.yml` は既存の `src-tauri/target/release` → `bin` の block の filter に 2 名を足すだけ。`files`、`asarUnpack`、`mac`（`hardenedRuntime`）、`win`、`publish` は変えない。macOS の署名は electron-builder が bundle の中の Mach-O を署名する既存の挙動（`grimodex-mcp` と同じ）に任せ、確かめるのは P2 の B 案 | release の出力は変わる（不活性の binary が増える）が、TASK §6 の「当たらない」 | 新しい block を足す案: 置き場が 2 つになる | なし | 該当なし（TASK §6 が「当たらない」と定める） | §3 | 記録済み（実装前） |
| DR-CP2B-P1-6 | 2026-10-25 | 同（レビュー修正 P3-1） | `from_path` の `metadata`（symlink を辿る）と、実行権を見ないことは変えない。`symlink_metadata` に直さない | path は Main が resources の固定の場所から組み立てる。そこを書き換えられる者は app 本体も書き換えられるので、symlink の拒否は防御にならない。実行権の欠如は prepare の起動の失敗として扱われる見込み（推定。理由の写像は CP2a-D8 の分類による） | `symlink_metadata` で symlink を拒否する案: deb／rpm／AppImage の配置や利用者の package 管理で symlink が挟まる場合（推定）に Graph が使えなくなり、CP-2a が受け入れた検証の挙動を変える。得るものが無い | なし | 該当なし | §3 | 記録済み（レビュー修正） |

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

## 7. 独立レビューの修正の追記（2026-10-25）

レビューの結論は「PR にしてよい、P0／P1 なし」。直した点と申し送り。

- P2-1（2 つ目の設定口の検出）: 静的試験 `only_the_main_constructor_configures_the_worker_path` を、lib.rs だけでなく `src/**/*.rs` のうち `*tests.rs` を除き `#[cfg(test)]` の item を取り除いた製品の source 全体の走査にした。数えるのは `configure_worker_path` の使用（定義を除く。method 呼出しと path 呼出しの両方）、`ProcessGraphWorkerFactory::from_path(` の呼出し、`.worker.set(`（空白を除いて）で、それぞれ lib.rs／`nir1_graph_product.rs` の 1 件だけであること。`#[cfg(test)]` の取り除きは別の試験 `cfg_test_items_are_stripped_from_the_product_scan`（合成の入力と、実 file で試験用の seam が消え setter が残ること）で確かめる。変異: lib.rs の外（`related_scenes/graph.rs`）に method 呼出し／path 呼出しで設定口を足すと赤、同じものを `#[cfg(test)]` にした対照は緑。
- P2-2（申し送り。製品コードの変更なし）: `electron:native:release` を呼ぶ job は ci.yml に無い。macOS／Windows で feature なしの worker を build して `worker:verify:release` を通すのは、このままだと tag の release run が初めてになる。release job の所要時間（timeout 150 分）の増分も未測定（Linux のローカルの cold build は約 2 分 17 秒。hosted は未測定）。**merge の後、tag の前に、`release.yml` の `publish=false` の debug run を 1 回通すか、P2 の packaged-smoke の workflow で 3 OS の `electron:native:release` を確かめる**。PR 本文にも同じことを書く。
- P3-1: §3 の matrix に path の検証の強さの行を足し、判断を DR-CP2B-P1-6 に記録した（直さない）。
- P3-2（PUB-G への申し送り）: 検証（`from_path`）は constructor の時点の 1 回だけで、spawn は PUB-G の後の需要の時点になる。その間に file が差し替えられても再検証しない（TOCTOU）。spawn の直前に path を再検証するか（file 名と通常 file の再確認、あるいは spawn の失敗を `worker-unavailable` に写すだけで足りるか）を PUB-G で決める。resources を書き換えられる者は app 本体も書き換えられるので、P3-1 と同じく脅威の大きさは小さい（推定）。
- P3-3: DR-CP2B-P1-1 に、dev で lane の seam 付き build を拾いうることと、それが無害な理由を書き足した。
- P3-4: §2 の P1 の行と DR-CP2B-P1-2 の拒否の順序を、実際（`not-activated` → `profile-not-restricted` → `worker-unavailable`）に直した。
- P3-5: unix 以外では no-spawn 試験の marker の主張が空になることを、試験の comment と §3 の行に書いた。
- P3-6: `backend.test.ts` の「Main は存在を確かめない」の試験は、vitest で `__dirname` が `electron/main` になり、既定の解決が `electron/src-tauri/target/release/…`（常に無い）になるので成り立つ。本物の dev の path は純関数の試験だけが固定していることを comment に書いた。

## 8. P2（packaged smoke の harness と `packaged-smoke.yml`、判定の単体試験、Linux の記録）。mutation の前の記録

2026-10-26、branch `claude/cp2b-p2-packaged-smoke`（基点 master `8e93bb31`。P1 は #721 で入っている）。この節は P2 の実装の前に書き、実装後の事実は §9 に足す（この節の本文は直さない）。P2 の判断は `DR-CP2B-P2-n` と番号を分ける。TASK が名前で予告する DR-CP2B-1（「Y-1 を各 OS で」の読み）と DR-CP2B-3（env 名の数の確認の読み）のうち P2 に関わる読みは、DR-CP2B-P2-2 と DR-CP2B-P2-8 に書く（番号 DR-CP2B-1〜3 そのものは空けたまま）。条件の正本は K3/3 のゲート表（`nir1-d2a-activation-proposal-3-draft.md` の「ゲート表」節。G-pub = Negative (34)）、合否の述語は同じ文書の NL と RJ の節で、この記録は再定義しない。

### 8.1 範囲と、範囲の外（P2）

- 範囲: (a) OS 非依存の packaged smoke の harness（新規 `electron/scripts/packaged-smoke/`）、(b) (34) の判定を組み立てる純関数と、その単体試験（合成の記録で赤になる変異）、(c) 新規 `.github/workflows/packaged-smoke.yml`、(d) `scripts/release-workflows.test.mjs` への workflow の契約試験（action の 40 桁 SHA 固定の対象への追加を含む）、(e) Linux のローカルでの最初の記録（試運転。G-pub の証跡ではない）。
- 範囲の外: gate を開けること、`PRODUCT_GRAPH_PUBLISHED`、NC-1／Y-1 の file（`electron/main/rendererContainment*`、`electron/scripts/webrtc-block-probe*`、`electron/scripts/renderer-isolation-probe*`、`electron/main/windows.ts`、`electron/main/index.ts`）の編集、`release.yml`、version・release notes・tag・GitHub Release・`publish=true` の run、製品の code・設定・fuse・test seam、RS-1 への host の追加、(34) の合格基準・行・許容集合の緩和、H1（P3）、G-pub の記録（P4。`cp2b-g-pub/`）、harness の CI 化（H3。条件の gate にしない）。

### 8.2 master `8e93bb31` で確かめ直した事実（TASK は `bdc892d7` 時点の起案）

- TASK の行番号は古いものがある（例: `release-workflows.test.mjs` の action 固定の試験は 605-620 ではなく 611-625、`release.yml` の Windows の `CSC_IDENTITY_AUTO_DISCOVERY` は 444-449 ではなく 440-447 付近、`webrtc-block-probe.mjs` の canary は 112-195 ではなく 125-185）。内容は一致した。以下の記述は master の内容で書く。
- `electron/scripts/webrtc-block-probe.mjs` は import した時点で `main()` を走らせる（guard がない）ので、canary・mDNS・DoH の受け口の関数を import して使えない。`webrtc-block-probe-verdict.mjs`（`judgeRecord`、`classify`）、`webrtc-block-probe-nc1.mjs`（`judgeNl`、`judgeNlPositiveControl`、`judgeLocalRule`）は純関数で import できる。攻撃 JS（`webrtc-block-probe-renderer.js`）は `globalThis.__probe` を読んで結果の配列の Promise を返す式で、CDP の `Runtime.evaluate`（`awaitPromise`）でそのまま評価できる形である。probe の main（`webrtc-block-probe-main.mjs`）は env（`PROBE_CM`、`PROBE_CFG`、`PROBE_RENDERER_SCRIPT`）だけで動き、Linux 専用の部分（`process.kill`、`LD_PRELOAD`）は runner 側にある。
- 製品の `setWindowOpenHandler`（`electron/main/security.ts`）は deny の前に、http/https の URL を `shell.openExternal` で OS に渡す（unrestricted の既定）。攻撃 JS の `dns.form-submit` の行（`target=_blank` の form を `https://form-<n>.dnsprobe.test/x` へ送る）は、packaged では OS の既定の browser を起こす。probe の main は `setWindowOpenHandler(() => ({ action: "deny" }))` だけで openExternal を呼ばない（G-open の (23) の行列はこの環境で採った）。K3/3 の影響表 8 は `openExternal` を「OS。Main 側の通信」として閉じ込めの外に置く。→ DR-CP2B-P2-5。
- Linux の実機（Electron 43.8.3、probe の main に製品の NC-1 の orchestrator、`--log-net-log --net-log-capture-mode=Everything`、quick の行列 56 行）で、net log の `PROXY_CONFIG_CHANGED` の `new_config.single_proxy` が `[socks5://127.0.0.1:<port>]`（bypass は `<-loopback>`）で LS-1 の port を示し、`TCP_CONNECT`（PHASE_BEGIN、`address_list` に `127.0.0.1:<port>`）が 41 件で、Main の listener が数えた接続 41 件と行ごとの件数が全行で一致した（時刻の差は最大 6 ms、中央値 1 ms。wall clock は `constants.timeTickOffset + time`）。別の session（更新の partition）の `PROXY_CONFIG_CHANGED` は `from_system`。自己確認の `resolveHost` は `NETWORK_SERVICE_HOST_RESOLVER` の `HOST_RESOLVER_MANAGER_REQUEST`（`127.0.0.1:0`、`~NOTFOUND:0` ×2）として出るが、`resolveProxy` は net log に出ない。辞書の要求（`redirector.gvt1.com`）は `PROXY_CONFIG_CHANGED` と同じ ms に始まった（H9 の材料。記録だけ）。Windows／macOS では未確認。
- 既存の G-open の記録（`nc1-g-open/nc1-doh-baseline.json`）は DoH の canary と net log を同じ構成で併用し、net log の nonce を含む生の host が 72 件だった（DoH の secure mode でも host resolver の event は生の host を残す）。
- worker の env 名の数は、grimodex-db の通常の試験（`c_query_worker.rs` の `configure_worker_process` を確かめる試験。unix は 0、Windows は `SystemRoot` の 1 つ）が `Command` の構成の段で固定している。packaged の worker は gate が閉じているので製品の経路で spawn できず、worker に env 名を出す seam を足すことは worker（C-resource の受入れの対象）の変更になる。→ DR-CP2B-P2-8。
- release の build は semantic recall の reranker を外部（Hugging Face 等）から bootstrap してから package する（`release.yml`）。`electron-builder.yml` の `extraResources` は置き場が無ければ写さない。→ DR-CP2B-P2-7。
- hosted の `ubuntu-24.04` は unprivileged user namespace を AppArmor で制限するので、SUID でない `chrome-sandbox` の `--dir` の出力は既定の sandbox で起動できない見込み（推定。既存の journey は `ELECTRON_DISABLE_SANDBOX=1` で `--no-sandbox` にしている）。→ DR-CP2B-P2-7。

### 8.3 影響マトリクス（refactor-cross-boundaries の形。実装前）

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| S1 | packaged の起動（3 OS。`--dir` の出力） | harness（`packaged-smoke/run.mjs`） | 実行体に与えるのは一時の `GRIMODEX_USER_DATA_DIR`、一時の `HOME`／`XDG_*`（Linux）／`TMPDIR`、Chromium の switch `--remote-debugging-port=<harness が選んだ port>`、`--log-net-log=<file>`、`--net-log-capture-mode=Everything` だけ。製品は読まない | 製品の Main（NC-1 は `index.ts` の順序のまま） | 製品の code・設定・fuse・build env に何も足さない（TASK §3 の 1〜4）。閉じ込めを止める入口を使わない（存在しない） | 起動・CDP・net log のどれかが取れなければ、その OS は「観測の道具なし」で (34) 不通過（合格にしない） | 合成の記録の試験、Linux の実機、hosted | planned |
| S2 | 攻撃 JS の注入 | harness の CDP client（Node の global `WebSocket`） | `/json/list` を poll して `app://bundle/` の `page` target を待ち、`Runtime.evaluate` で `globalThis.__probe=…` と `webrtc-block-probe-renderer.js` の本文を評価（`awaitPromise`、`returnByValue`）。攻撃 JS は read-only で読む | 製品の renderer の main world | 攻撃 JS の行列と行 id は G-open と同じ（file を変えない） | 取れなければ S1 と同じ | Linux の実機、hosted | planned |
| S3 | 名前の観測 | harness の net log の解析（`netlog.mjs`） | `HOST_RESOLVER_MANAGER_REQUEST`／`JOB` の host を NL の正規化（probe と同じ）で集め、`judgeNl` に渡す。URL 要求の event の host は数えない | (34)(ii) の判定 | 許容集合 A は `webrtc-block-probe-nc1.mjs` の定数をそのまま使う（足さない） | net log が無い・壊れている → 道具なし | 合成の net log の単体試験、実機 | planned |
| S4 | LS-1 への接続数 | 同上 | LS-1 の port = `PROXY_CONFIG_CHANGED` の `socks5://127.0.0.1:<port>` が 1 つだけ。接続 = `TCP_CONNECT` の begin で `address_list` に `127.0.0.1:<port>`。時刻 = `timeTickOffset + time`。行の時間窓に入る件数を `proxied` にする | RJ の TCP の行 | 帰属の規則は probe と同じ（行の `startedAt`〜`endedAt`） | port が 0 個／2 個以上 → 道具なし。対照（S6）で Main の listener の実数と一致しなければ道具なし | 単体試験、S6 の照合、実機 | planned |
| S5 | 到達の観測 | harness の受け口（`observers.mjs`） | canary（`127.0.0.1` ×2、`127.0.0.2`、`[::1]`、LAN の IPv4。TCP と UDP）、UDP 5353 の multicast の受信 socket、DoH の canary（`openssl` の一時の自己署名）。bind できない canary は記録して行を落とさない | RJ、`.local` の規則 | 受け口の形は probe と同じ。bind できない宛先の行は対照の観測で区分が決まる（RJ） | — | 単体試験、実機 | planned |
| S6 | 正の対照と道具の照合（同じ OS、非 packaged） | harness が probe の main を esbuild で束ねて node_modules の Electron で起動 | baseline: 閉じ込めなし（`cm` に `nc1` を書かない）、DoH の canary（名前の試みの観測）、net log、mDNS。toolcheck: 製品の NC-1 の orchestrator（`cm.nc1 = {}`）、net log。toolcheck は Main の listener の実数と net log の数を行ごとに照合する | (34) の正の対照、S4 の道具の検証 | probe の main と攻撃 JS は変えない（read-only） | 対照が取れない OS は (34) 不通過 | 実機、hosted | planned |
| S7 | package の検査 | harness（`package-check.mjs`） | worker の存在・通常 file・POSIX の実行可能・seam の文字列なし（`verify-release-graph-worker.mjs` の `verifyReleaseGraphWorker` を使う）、Windows の PE subsystem の記録、macOS の `codesign --verify` の記録（A 案では合否にしない）、`app.asar` の file 一覧に harness・canary・攻撃 JS・dnslog が無いこと | 記録と workflow の合否 | 製品の build を汚さない保証（TASK §3 の 1、3） | — | 単体試験（合成の asar）、実機 | planned |
| S8 | workflow（hosted） | `.github/workflows/packaged-smoke.yml` | `pull_request`（paths は workflow と harness だけ）と `workflow_dispatch`（`candidate_ref` 40 桁、`os`）。`permissions: contents: read`、secrets なし、`pull_request_target` なし、action は 40 桁 SHA。artifact は harness の出力（記録）だけで 7 日。packaged の binary と raw の net log は上げない | GitHub の hosted runner | release の artifact と混ざらない。release.yml を変えない | — | `release-workflows.test.mjs` の契約試験 | planned |
| S9 | 製品・renderer・IPC・preload・N-API・Rust・MCP | — | 変えない | — | 起動時 JS graph の予算に触れない | — | `git diff` が `electron/scripts/packaged-smoke/`、workflow、試験、文書だけ | out of scope: 製品を変えない |

### 8.4 owner／lifecycle matrix（GDX-PRECHECK-001。mutation の前）

harness が作る子 process は (1) packaged の実行体（Linux は `scripts/local-ci-xvfb.mjs` 経由。その下に Xvfb と Chromium の子）、(2) probe の main を載せた node_modules の Electron（Linux は同じ wrapper 経由）、(3) 一回限りの補助の command（`openssl`、Windows の `taskkill`／`powershell`、macOS の `ps`／`codesign`）、(4) harness 自身の socket（canary、DoH、mDNS、CDP の WebSocket）。

| 項目 | 内容 |
|---|---|
| entry／start | (1)(2) は `launchApp()` の 1 か所だけが `spawn` する。構成（baseline → toolcheck → packaged）は直列で、前の構成の終了の証拠が取れるまで次を起動しない。(3) は `execFileSync`／`spawnSync`（有限の timeout つき）だけ |
| admission closure | 前の構成の終了の証拠が取れなければ、以後の構成を起動せず、harness は失敗で終わる（残った process を記録） |
| retry／reentrant | harness の中で再試行しない。flake の再走は TASK §2.2 のとおり新しい dispatch（同じ候補で最大 2 回）で、workflow の中で自動の rerun をしない |
| pending-start | spawn の後、CDP の target か結果 file を待つ間も、child の handle は `launchApp()` の owner が持つ。待ちには上限がある（下の bounded wait） |
| active handle の owner | `launchApp()` が返す owner（`child`、POSIX の process group id、Windows の root pid、実行体の dir）。terminate はこの owner だけが行う |
| cancellation | harness が SIGINT／SIGTERM を受けたら、起動中の owner を terminate してから非 0 で終わる |
| bounded wait | CDP の target の出現 120 秒、攻撃 JS の評価 15 分、probe の main の結果 15 分、terminate の graceful 15 秒＋強制 10 秒、補助 command 30 秒。workflow の job の timeout 90 分 |
| 実終了の証拠 | kill の要求や `close` の event だけを証拠にしない。POSIX: 直接の子の `close`（exit code／signal を記録）に加えて、process group が消えたこと（`kill(-pgid, 0)` が `ESRCH`）と、実行体の dir の下の実行ファイルを持つ process が 0（Linux は `/proc/*/exe`、macOS は `ps -axo pid=,comm=`）。Windows: 直接の子の `close` に加えて、`Get-CimInstance Win32_Process` で実行体の dir の下の `ExecutablePath` を持つ process が 0。手順は graceful（POSIX は wrapper／app の pid に SIGTERM、Windows は `taskkill /PID <pid> /T`）→ 期限で強制（POSIX は process group に SIGKILL、Windows は `taskkill /PID <pid> /T /F`）→ 証拠の確認。証拠が取れなければ記録に `lifecycle.residual` を残して harness を失敗にする |
| error／timeout／onClosed の owner | 子の `error`／早期終了（CDP の target が出る前の終了など）は `launchApp()` の owner が受けて記録し、terminate の手順（証拠の確認を含む）を通してから構成を失敗にする |
| persisted restart state | なし。各構成の userData・HOME・TMPDIR・net log は一時 dir で、終了の証拠の後に消す（`--keep` のときだけ残す） |
| shutdown | harness の終わりに、受け口の socket をすべて close し（`close` の callback を待つ）、一時 dir を消す |

### 8.5 判断の表（P2）

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP2B-P2-1 | 2026-10-26 | CP-2b P2 | harness は新規 `electron/scripts/packaged-smoke/*.mjs`（OS 非依存）。判定の述語は `webrtc-block-probe-verdict.mjs`／`webrtc-block-probe-nc1.mjs` を import し、攻撃 JS と probe の main は read-only で読む／束ねる（DR-NC1-40 (a)）。受け口（canary、mDNS、DoH）は `webrtc-block-probe.mjs` が import できないので同じ形で書き直し、記録の JSON の形（`rows[]`、`totals`、`netLog.hostResolver`、`mdns`、`dohAll`）を probe の出力にそろえて、既存の判定にそのまま渡す | harness は利用者の data を読まない。受け口は loopback と LAN の IPv4 の ephemeral port だけ。記録は LAN の IPv4 と hostname を probe と同じ表記（`<lan>`、`<host>`）で伏せる | (1) probe の runner を直して import できるようにする案: Y-1 の file の編集で G-open の記録が無効になる（`nc1-g-open/README.md`）。(2) Playwright の `_electron.launch`: TASK §3 のとおり採らない | なし | 該当なし | §8.4 | 記録済み（実装前） |
| DR-CP2B-P2-2 | 同 | 同 | 1 つの OS で 3 構成を直列に走らせる: baseline（probe の main、閉じ込めなし、DoH の canary、net log、mDNS。Linux は任意で `LD_PRELOAD` の記録層を併用）、toolcheck（probe の main に製品の NC-1 の orchestrator、net log。Main の listener の実数と net log の数を照合する道具の対照）、packaged（`--dir` の出力に CDP と net log）。行列は 3 構成で同じで、攻撃 JS の flag は `dns`、`localhost`、`rs1`、`local`（既定の `name`／`allowed`／`allowedp`／`ext`／`lo4`／`lo4b`／`lo6`／`lan` × 6 proto、IP literal の remote candidate、iframe／`window.open`／worker の realm は flag なしで常に入る）。これで K3/3 の (34) の部分集合（TURN／TURNS／STUN × 名前、RS-1 の名前、loopback・LAN・UDP の IP literal、remote candidate、iframe、DNS だけの行、`.local`）を覆う。**「Y-1 を各 OS で」（TASK §1.3、DR-CP2B-1 の役）の P2 の読み**: (34) の packaged の行列と、同じ OS の probe の main の閉じ込めなしの正の対照、とする（推測を含む読み。PR 本文に書く） | 同じ OS・同じ runner・同じ名前解決の環境（実 DNS。対照の名前の試みは DoH の canary で観測）で対照を取る（RJ の「判定する構成と同じ名前解決の環境」）。DoH の canary は NXDOMAIN を返し、`*.probe.test` の実 DNS（NXDOMAIN）と同じ結果になる | (1) FQDN の remote candidate・link-local・sentinel 名・`sx` の行も足す案: (34) の列挙に無く（FQDN は net log で覆えない。K3/3）、1 構成の時間が伸びる。足すことは緩和ではないので、P4 で必要なら flag を足すだけで済む形にする。(2) toolcheck を置かない案: Windows／macOS で net log の数え方が Main の listener と一致するかを確かめる対照がなくなる | なし | 該当なし | §8.4 | 記録済み（実装前） |
| DR-CP2B-P2-3 | 同 | 同 | 観測の方式: CDP は harness が空き port を選んで `--remote-debugging-port` に渡し、`/json/list` を poll（stderr を読まない。H10 の趣旨）。net log は S3／S4 のとおり。到達は canary。bind できない canary（例: macOS の `127.0.0.2`）は記録に `bound=false` を残し、その宛先の行は対照の観測で区分が決まる（RJ。canary を置けない宛先の行か不活性の行）。判定の出力に bind できなかった canary と、その宛先の行の区分を列挙する（H11 の趣旨。行を黙って落とさない） | CDP の port は loopback にだけ bind される Chromium の既定。harness の外から接続されうる時間は起動から終了までで、hosted runner と自分の機に限る | (1) `--remote-debugging-port=0` と `DevToolsActivePort` の file: 置き場が OS と Electron の版で違いうる。(2) canary の bind の失敗で run を止める（probe の形）: macOS で `127.0.0.2` が無いと全体が止まり、他の行も観測できない | なし | 該当なし | §8.4 | 記録済み（実装前） |
| DR-CP2B-P2-4 | 同 | 同 | (34) の OS ごとの判定（`verdict.mjs` の `judgeOs`）は次の全部を満たすときだけ合格。1 つでも欠ければ不合格で、道具の欠落は「観測の道具なし」と区別して出す（その OS は (34) 不通過。解除は新しい draftRef）: (a) 道具: 3 構成の起動と終了の証拠、CDP の注入（packaged の行が 1 行以上）、net log の解析、LS-1 の port が 1 つ、(b) 道具の対照: toolcheck で TCP の行ごとの「net log の接続 ≥1」と「Main の listener の接続 ≥1」が一致し、port が Main の報告と一致、(c) 正の対照: baseline の `main.turn-tcp.lo4`／`main.stun.lo4` が canary に届く、`judgeNlPositiveControl(baseline, "netLog")`（nonce を含む生の host > 0）、`judgeNlPositiveControl(baseline, "doh", stun／turn-udp／turn-tcp／turns／dns-prefetch)`、(d) 行列: packaged の renderer の行 id の集合が baseline と一致（欠けた行・増えた行は不合格）、(e) RJ: `judgeRecord(packaged, { baseline })` の不合格 0 と記録全体の不合格 0（不活性の行は列挙）、(f) NL: `judgeNl(packaged)` が合格、(g) `.local`: `judgeLocalRule(packaged, baseline)` が `fail` でない（`unverified` は K3/3 の `.local` の規則どおり記録に残し、合否に含めない）。記録するが合否にしないもの: NC-1 の所要の推定、辞書・更新の要求、H9 の順序、OS の確認ダイアログ（headless の runner では観測できない旨） | 判定は記録の JSON を読むだけの純関数。合格の根拠に集計値を使わない（RJ） | (1) (d) を置かない案: packaged で行が欠けても RJ（`judgeRecord`）は通る（対照にある行が最終構成に無いことを見ない）。(2) `.local` の `unverified` で不合格にする案: K3/3 の `.local` の規則を変える（重要な変更 (3)） | なし | 該当なし（緩和ではなく、行列の一致と道具の対照を足す） | — | 記録済み（実装前） |
| DR-CP2B-P2-5 | 同 | 同 | packaged の構成でだけ、攻撃 JS の前に page へ 1 つの shim を CDP で評価する: `HTMLFormElement.prototype.submit` を、`target` が空でも `_self` でもないとき何もしない（送らない）形に替える。理由: 製品の window open の handler は http/https を `shell.openExternal` で OS に渡すので、`dns.form-submit` の行が hosted runner と自分の機で OS の browser を起こす（利用者に見える副作用、harness の process tree の外の process、OS の DNS への nonce 名の問合せ）。probe の main の handler（deny だけ）と同じ結果（何も送らない）にそろえるので、行は判定に残り（G-open と同じく対照でも 0 の DNS だけの行。NC-1 の効果の根拠にしない行）、判定の規則は変えない。記録に `pageShims` として残し、判定の出力にも出す。`openExternal` の経路（OS の browser）は K3/3 の影響表 8 のとおり閉じ込めの外で、(34) の対象ではない（開示: PR 本文） | 攻撃 JS の他の行の環境は変えない（shim は form の `submit` だけ）。製品は変えない | (1) 行を packaged だけ外す案: 行列の一致（DR-CP2B-P2-4 (d)）が崩れ、「行を判定から外す」（重要な変更 (3)）に当たる。(2) OS の側で browser を止める案（Linux の `BROWSER`）: Windows／macOS では ShellExecute／NSWorkspace が harness の外の process として browser を起こし、止められない。(3) shim なし: 上の副作用 | なし（integrator の判断を求める開示事項） | 該当なし（行と述語は不変。開示する） | §8.4 | 記録済み（実装前） |
| DR-CP2B-P2-6 | 同 | 同 | 子 process の終了は §8.4 の手順と証拠。Linux の packaged と probe の main は `scripts/local-ci-xvfb.mjs` を host の namespace で使い（`unshare` を使わない）、`WAYLAND_DISPLAY`／`WAYLAND_SOCKET`／`XDG_SESSION_TYPE`／`DBUS_SESSION_BUS_ADDRESS`／env の proxy を除く。一時の `HOME`／`XDG_CONFIG_HOME`／`XDG_DATA_HOME`／`XDG_CACHE_HOME`／`TMPDIR`（短い path）を全 OS で与える（Windows は `USERPROFILE`／`APPDATA`／`LOCALAPPDATA` を変えない: 変えると Electron の既定の path と OS の登録が runner の外の場所を指しうるため。userData は `GRIMODEX_USER_DATA_DIR` で一時 dir） | 利用者の desktop の設定、X0 の socket、利用者の Grimodex の single instance の lock に触れない（userData が別なので lock も別） | `process.kill(-pid)` だけの probe の形: Windows に process group が無い。kill の要求だけを証拠にしない（GDX-PRECHECK-001） | なし | 該当なし | §8.4 | 記録済み（実装前） |
| DR-CP2B-P2-7 | 同 | 同 | workflow: 新規 `packaged-smoke.yml`。job は `unit`（ubuntu、harness の単体試験と workflow の契約試験）と `smoke`（matrix: `ubuntu-24.04`／`macos-15`／`windows-latest`）。build は `pnpm electron:native:release && pnpm electron:build && pnpm exec electron-builder --dir --publish never`（release と同じ script と `electron-builder.yml`、build の env を足さない）。Windows と macOS は `CSC_IDENTITY_AUTO_DISCOVERY=false`（secrets なし。macOS は無署名の `--dir`。A 案）。reranker の bootstrap はしない（外部の取得を足さず、smoke は Semantic Recall を使わない。release の package との差として記録に残す）。Linux は `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` で Chromium の namespace sandbox を使える状態にし（`--no-sandbox` を渡さない。runner の設定で製品ではない）、Xvfb は `scripts/local-ci-xvfb.mjs`。artifact は harness の出力 dir だけ（記録の JSON、判定の出力、stderr の末尾）、7 日。**raw の net log は上げない**（`capture-mode Everything` は socket の bytes を含み、public repo の artifact は誰でも読める。記録には raw の SHA-256 と派生の要約だけを残す。TASK §2.2 からの変更）。job の timeout は 90 分。初回は `pull_request` で走る形（default branch に無い workflow を dispatch できない可能性。推測）。`os` の入力は `all`／`linux`／`windows`／`mac` | `permissions: contents: read`、secrets なし、`pull_request_target` なし、action は 40 桁 SHA（既存の固定値を再利用）。送信先は GitHub の hosted runner と、packaged の製品の既存の通信（更新の確認など）だけで、harness は外部へ接続しない | (1) `release.yml` の debug run を使う案（B 案）: P4 の最終候補で推奨（TASK §2.3）。P2 では A 案。(2) Linux で `--no-sandbox`: 観測する packaged の構成が配布物と変わる | なし | 該当なし（TASK §6 の「当たらない」） | §8.4 | 記録済み（実装前） |
| DR-CP2B-P2-8 | 同 | 同 | package の検査（S7）は worker の存在・通常 file・POSIX の実行可能・seam の文字列なし・`app.asar` に harness の file が無いことを合否に、Windows の PE subsystem と macOS の `codesign --verify` を記録だけにする。**env 名の数と Windows の console window（TASK §1.4、DR-CP2B-3 の役）の P2 の読み**: packaged の worker は gate が閉じた製品の経路で spawn できず、env 名を出す seam は worker の変更になるので、P2 では観測しない。既存の grimodex-db の試験（`configure_worker_process` の env 0／`SystemRoot` 1、`CREATE_NO_WINDOW`）が構成の段を固定していることを記録し、それで足りるかは integrator が決める（TASK §11） | worker を spawn しない（gate 閉）。worker を変えない | worker に seam を足す案: C-resource の受入れの対象の変更 | なし（integrator の判断） | 該当なし | — | 記録済み（実装前） |
| DR-CP2B-P2-9 | 同 | 同 | P2 の Linux の記録は、ローカルの試運転として `docs/plans/nir1-lane-decisions/cp2b-p2-linux-trial/` に置く（`linux/` の下に構成ごとの記録 JSON、`package-check.json`、`verdict.json`、`verdict.txt`、全 file の `SHA256SUMS`、`README.md`）。G-pub の証跡ではない（候補の head でも hosted でもない）。harness の出力の形（`<out>/<os>/…` と `SHA256SUMS`）は P4 の `cp2b-g-pub/` がそのまま写せる形にする。記録を読んで判定の結果を固定する試験を足す（判定の規則の回帰を実データで見る） | 記録は LAN の IPv4 と hostname を伏せる。raw の net log は置かない | 記録を git に置かない案: レビューで判定を再現できない | なし | 該当なし | — | 記録済み（実装前） |

## 9. P2 の実装後の追記

2026-10-26、branch `claude/cp2b-p2-packaged-smoke`。§8 の本文は直さず、実装で分かったことと追加の判断をここに書く。

### 9.1 マトリクスの最終状態

§8.3 の S1〜S8 は `implemented`、S9 は `out of scope`（製品・renderer・IPC・N-API・Rust・MCP は変えていない。差分は `electron/scripts/packaged-smoke/`、`.github/workflows/packaged-smoke.yml`、`scripts/release-workflows.test.mjs`、この文書、試運転の記録だけ）。§8.4 の lifecycle matrix は実装と一致する（起動は `launchOwned()`、終了の証拠は `terminationProven()` で close・process group の消滅・実行体の dir の下の process 0 の合成。path で見つけた process は kill しない）。**レビュー修正で訂正（§10）**: この時点の実装は cancellation の行（signal を受けたら起動中の owner を terminate して非 0 で終わる）を満たしておらず、flag を立てて構成の間でだけ見ていた。Linux の残存の走査も `/proc/<pid>/exe` を読めない process を飛ばしていた。どちらも §10 で直した。

### 9.2 追加の判断

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP2B-P2-10 | 2026-10-26 | CP-2b P2 | packaged の一時 userData に、旧版の keyring の移行の完了 marker（`legacy-keyring-migration-v1.json`、`version: 1`、`imported: 0`）だけを置いてから起動する。理由: 空の userData の packaged は起動時に OS の keyring を読み、Linux の D-Bus を外した環境では失敗して、窓の作成の前に modal の dialog（`index.ts` の移行の失敗の分岐）で止まった（実測。CDP の target が 120 秒出ない）。marker の名前と形は `credentialMigration.ts` が書くものと同じで、試験（`run.test.mjs`）が source から名前と version を読んで一致を固定する。「移行を済ませた利用者」の状態で、閉じ込めの経路は通る（NC-1 は `index.ts` で移行より前）。利用者の keyring を読まない副作用がある | 製品の code・設定・env の入口は変えない（userData の初期の file は製品自身が書く状態）。閉じ込めを止める入口ではない | (1) private な D-Bus の session bus を立てる案: Secret Service が無ければ移行は同じく失敗しうる。Windows／macOS の Credential Manager／Keychain の prompt を避けられない。(2) dialog を X の入力で閉じる案: Linux だけで、OS ごとに道具が要る | なし（開示事項） | 該当なし | §8.4 | 実装済み |
| DR-CP2B-P2-11 | 2026-10-26 | 同 | 有限の待ちの timer は解決した時点で止める（`settlesWithin`）。試運転の 1 回目で、probe の main の 20 分の上限の timer が残り、判定の出力の後も harness が終わらなかった（PID 指定で止めた）。試験で解決後に `Timeout` が残らないことを固定した | — | — | なし | 該当なし | §8.4 の bounded wait | 実装済み |

### 9.3 試験

| 試験 | 件数・結果 |
|---|---|
| `node --test electron/scripts/packaged-smoke/*.test.mjs`（net log の解析、判定、package の検査、process の終了の証拠、harness の純関数、試運転の記録） | 61 件 passed（Linux、Node 24.18.0） |
| `node --test scripts/release-workflows.test.mjs`（`packaged-smoke.yml` の契約 7 件と、action の 40 桁 SHA の固定の対象への追加を含む） | 29 件 passed |

変異（どれも元に戻して再確認した）: 判定は 15 種（行列の一致・toolcheck の食い違い・正の対照・NL・`.local`・CDP・終了の証拠・flag・記録全体の必要条件・package・toolcheck の空の照合を外す、net log の LS-1 の宛先の照合・begin の限定・port の一意・JOB の host を外す）がすべて赤。harness は 9 種（asar の禁止・空の asar・`GRIMODEX_` と env の proxy の除去・form の shim の条件・未帰属の数え方・marker の version・group の残存での強制）が赤、`ok` の合成から group の消滅を外す変異が当初は緑だったので `terminationProven` の試験を足して赤にした。workflow は 12 種（`contents: write`、`pull_request_target`、action の tag 化、artifact の path を `release/`、保持 90 日、`secrets.`、`--publish always`、`--no-sandbox`、SHA の検査の緩和、`persist-credentials` の削除、`unit` への依存の削除、単体試験の削除）がすべて赤。

### 9.4 Linux の実機（ローカル。試運転の記録 `cp2b-p2-linux-trial/`）

- head `db76aef0`、3 構成 752 秒。判定は **pass**: RJ は 134 行（判定 118: TCP 57、UDP 45、DNS だけ 16。対象外 16。区分は活性 43、canary 不可 59、不活性 2〔`rs1.turn-tcp.localhost`、`rs1.turns.localhost`。G-open の `nc1-nl-final` と同じ 2 行〕）で不合格 0、記録全体の不合格 0。NL は net log の host 6 種がすべて許容集合 A の内側（`127.0.0.1`、RS-1 の 4 名、`~notfound`）。`.local` は対照で問合せ 3 件、packaged で 0（pass）。行列は 134 行で欠け・余り 0。toolcheck は TCP の 59 行で listener と net log の接続の有無が全行一致し、総数も 174 件で一致（G-open の記録とは別の run。§8.2 の quick の照合に続く 2 回目）。正の対照は net log の nonce を含む生の host 69 件、DoH の canary で STUN／TURN-UDP／TURN-TCP／TURNS／dns-prefetch の名前を観測。package は worker（91,502,160 bytes、seam なし、実行可能）、`app.asar` の 797 file に harness・probe の file なし。
- 記録だけ: NC-1 の network の段の下限 1 ms（setProxy から自己確認の resolve 3 件まで。listener の起動と `resolveProxy` を含まない）、起動から CDP の target まで 507 ms（同じ機の別の負荷の回では 4,096 ms。Xvfb の起動を含む上限側の値で、5 秒の期限〔H7〕と直接は比べられない）。辞書の要求は 1 件で setProxy の 0 ms 後（H9）。OS の確認ダイアログは観測しない（headless）。
- 終了: baseline／toolcheck は probe の main が自分で終了（close の code 0）、group 消滅、残り 0。packaged は wrapper への SIGTERM で wrapper が 143 で閉じた後も group に Chromium の子が残り（Xvfb の停止の後の X の接続の error）、group への SIGKILL で消えた（`forced: true`。証拠はそろった）。利用者の X0／X1 の socket は残った。一時 dir は消した。利用者に見える副作用はなかった（DR-CP2B-P2-5 の shim で OS の browser は起きない）。

### 9.5 確かめていないこと（hosted で初めて分かること。PR 本文にも書く）

- Windows／macOS の packaged で `--remote-debugging-port` と `--log-net-log` が効くか、CDP の `Runtime.evaluate` が製品の CSP の下で評価できるか（Linux では効いた）。
- Windows／macOS の net log の `PROXY_CONFIG_CHANGED` と `TCP_CONNECT` の形で LS-1 の port と接続数が取れるか（toolcheck が照合する）。
- macOS の `127.0.0.2`、Windows／macOS の UDP 5353 の bind、`[::1]`、LAN の IPv4 の canary（bind できない canary は記録して区分で扱う）。
- macOS の無署名の `--dir` の出力が arm64 の runner で起動するか、Windows の `taskkill /T` と CIM の走査で終了の証拠が取れるか、macOS の `ps -axww -o args=` の走査。
- DoH の canary の自己署名の証明書（Windows は Git の openssl、macOS は LibreSSL の代替の分岐）、hosted Linux の `kernel.apparmor_restrict_unprivileged_userns=0` での Chromium の sandbox。
- 新しい workflow を default branch の外から `workflow_dispatch` できるか（推測では不可。初回は `pull_request`）。
- 1 OS の所要（build を含む）と 90 分の timeout の余裕、flake の頻度（TCP の行の時間窓の帰属）。

### 9.6 申し送り（判断は integrator）

- DR-CP2B-P2-5（form の shim）と DR-CP2B-P2-10（移行の marker）は、(34) の行と述語を変えないが、packaged の環境を probe の main の環境（deny だけの handler）と「移行済みの利用者」にそろえる harness 側の手当てで、開示する。`dns.form-submit` の行は G-open と同じく対照でも 0 の DNS だけの行。製品の `window.open`／`target=_blank` の http(s) が `shell.openExternal` に渡る経路は K3/3 の影響表 8 のとおり閉じ込めの外で (34) の対象ではないが、乗っ取られた renderer が unrestricted で OS の browser を開ける事実として、PUB-G の開示（C-1）で扱うかを integrator が決める。
- DR-CP2B-P2-8: env 名の数と Windows の console window は P2 では観測しない（既存の `configure_worker_process` の試験が構成の段を固定）。足りるかは integrator が決める。
- packaged の終了は Linux で毎回 group への SIGKILL に進んだ（9.4）。close の後に group の消滅を数秒待ってから強制にすれば graceful に終わる見込み（推定）。記録の head を変えるので P2 では直していない。P4 の前に直すかは integrator が決める。
- P4 は merge 後の master の SHA で `packaged-smoke.yml` を dispatch し、artifact の `<os>/` を `cp2b-g-pub/` に写して `README.md` を足す（この試運転の記録の形）。PUB-G の最終候補では B 案（署名・公証済みの配布物）で採り直す（TASK §2.3）。

## 10. 独立レビュー（lifecycle、security）の修正の追記（2026-10-26）

どちらも P1 なし。lifecycle は P2 4 件、security は P2 1 件。直した点（どれも変異で赤になることを commit の後に確かめた）。

| 指摘 | 直し | 試験（赤になる変異） |
|---|---|---|
| lifecycle P2-1: signal で子を止めない | `installInterruptHandler`: SIGINT／SIGTERM で起動中の owner（`createTracker` が登録。終了の証拠が取れた owner だけ外す）を `terminateOwned` で終わらせ、証拠を得てから記録を書かずに 130／143 で終わる。2 回目の signal は同じ処理を待つだけ。構成の直列を `runConfigsInOrder` にし、中断の後は記録を書かない。実機（Linux）で SIGINT を 2 回送り、終了コード 130、記録の file 0、`linux-unpacked` の下の process 0、利用者の X0／X1 は残った | handler の登録の削除、terminate せずに exit、admission の `break` の削除 |
| lifecycle P2-2: non-dumpable な子の見落とし | `/proc/<pid>/exe` が EACCES のときは `/proc/<pid>/cmdline` の argv[0] で照合する（ENOENT は終わった process として飛ばす。cmdline も読めない pid は判断せず、group の消滅の確認が担う）。走査の失敗は null（観測できない）で `[]` にしない | EACCES を飛ばす、走査の失敗を `[]` にする |
| lifecycle P2-3: kill しないことの固定 | node の copy を一時 dir に置いて exeDir にし、owner でない process（同じ copy から別 group）が残存として報告され、`ok: false` で、生きていることを assert する。`process.execPath` の dir を exeDir にする試験は無くした。`terminateOwned` の観測と kill を `deps` で差し替えられる形にし、group の残存・走査の失敗・残存の pid に kill を送らないことを固定した | 残存に SIGKILL、group の消滅を常に true |
| lifecycle P2-4: concurrency に OS がない | `concurrency.group` に `inputs.os`（PR は `all`）を足し、契約試験で固定した | OS を group から外す |
| lifecycle P3-5〜10 | 受け口の起動の途中の失敗で開いたものを上限つきで閉じてから throw、`listen` の error を reject、close は上限 10 秒、DoH の http2 の server は session と socket を持って close で壊す。一時 dir の削除に `maxRetries`／`retryDelay`。CDP は閉じた socket への send を即 reject、close の 2 秒の timer を close で止める、`/json/version` に 5 秒の timeout。Windows は exit を見た後に pid へ `taskkill` を送らない。macOS の走査の記述を実装（`ps -axww -o pid=,args=`）にそろえた（§8.4 の「`ps -axo pid=,comm=`」はこの記述で置き換える） | canary の close の no-op、起動失敗で閉じない、DoH の session を壊さない、閉じた後の send、close の timer。Windows の `else if (!isClosed)` を外す変異は緑（強制の分岐に入るのが `!isClosed` のときだけなので同値の変異）。**訂正（§10.3）**: `isClosed` は `close` が基準で、`exit` の後・`close` の前の窓では pid に `/F` を送っていた。記述（exit の後は送らない）と実装が食い違っていたので、§10.3 で実装を記述に合わせた |
| security P2 A: canary を置けない宛先の行の不合格 | 判定は変えず、合成（`main.turns-tcp.{lo4b,lo6,lan}` の proxied 0）と実データ（試運転の `main.turn-tcp.lan`）で不合格になることを固定した | `.lo4b`／`.lo6`／`.lan` の不合格を捨てる |
| security B | NL の許容集合 A（`webrtc-block-probe-nc1.mjs` の定数。read-only の import）と `MATRIX_FLAGS` を deepEqual で固定した | （Y-1 の file を一時でも書き換えないので、変異は回していない） |
| security C | 記録の伏せ字に repo・一時 dir・`os.tmpdir()`・home の絶対 path（Windows の区切りの両形）を足し、key と値を再帰で伏せる。子の出力の末尾・失敗の文・CDP の error だけは利用者名も伏せる（key の `runner` などを壊さないため全体には当てない）。package の検査の記録も伏せる | path を伏せない、利用者名を伏せない |
| security D | この workflow は cache を使わない（`setup-node` の `cache: pnpm` と `rust-cache` を外した）。契約試験で固定。所要は伸びる（未測定） | cache を戻す |
| security E | 注入の前に `port-owner.mjs` で CDP の port を listen している pid を引き（Linux `ss`、macOS `lsof`、Windows `Get-NetTCPConnection`）、owner の process group／owner の pid／実行体の dir に属することを確かめる。確かめられなければ注入しない（道具なし） | 別の pgid でも owned にする。`runPackaged` がこの確認を呼ぶことは単体試験ではなく実機（試運転の `cdp.portOwner`）でだけ確かめた |
| security F | 判定は変えず、shim の影響を受けた行（`dns.form-submit`）を `recorded.shimmedRows` と判定の出力に行単位で明示する | 出力から外す |
| security G | `app.asar` の中身（bytes）も harness・probe の固有の文字列（`dnsprobe.test` など）で走査する（chunk の境界をまたぐ一致も見る）。実 package では 0 件 | 中身の走査を外す |
| security H | 契約試験で `run:` に `${{` を含まないことを固定した | `run:` に式を埋め込む |

あわせて、workflow の単体試験は `--test-force-exit` で走らせる（開いた handle が残る回帰で job が止まらない）。試運転の記録は、伏せ字（C）の後の head で採り直した（§10.1）。

### 10.1 試運転の記録の採り直し

（採り直しの結果は、記録と同じ commit でこの節の後ろに足す。）

- head `de86d6e6`（clean）、3 構成 751 秒。判定は **pass** で、数は §9.4 と同じ（RJ 134 行・判定 118・不合格 0、不活性 2、NL・`.local` 合格、行列の欠け・余り 0、toolcheck の TCP の 59 行で食い違い 0）。新しく出力に `dns.form-submit` が shim 済みの行として出る。`cdp.portOwner` は owned（listen している pid が owner の process group）。packaged の終了は §9.4 と同じく group への SIGKILL に進んだ（証拠はそろった）。記録に repo・home・一時 dir の絶対 path、hostname、利用者名が無いことを確かめた。途中の 1 回（head `5a02b23f`）は文書の編集中で `trackedDirty: true` だったので使わず、文書を commit してから採り直した。

### 10.2 security の再レビューの修正（2026-10-26）

P1 なし、P2 1 件、P3 2 件。どれも commit の後に、保存した原本の copy からの変異で赤になることを確かめた。

| 指摘 | 直し | 赤になる変異 |
|---|---|---|
| P2: port の owner の確認を呼ぶ側が試験されていない | 注入を `injectAttack`（export）に切り出し、target の待ち・owner の確認・接続・評価を差し替えられる形にした。`owned` が `true` でなければ（`false`・欠落とも）接続も `Runtime.evaluate` もしないことを試験で固定した | 確認の `throw` を外す（n4）、`owned === false` のときだけ止める |
| P3: Linux の ss は別の利用者の socket に pid を出さない | pid の無い listen の行が 1 つでもあれば owned にしない（fail-safe）。macOS は `lsof -F pn` の socket の数が `netstat -an -p tcp` の listen の数より少なければ owned にしない | pid の無い行を無視する、macOS の照合を外す |
| P3: hostname が許容集合 A の名前と同じ機 | hostname が A の名前（と `~notfound`）と一致するときは伏せず、警告を出す（NL の host を `<host>` に変えて原因の分かりにくい不合格にしない） | 常に伏せる |

実機（Linux）で、`ss` による owner の確認が自分の子の listen を owned、別の pgid を owned でないと判定することを確かめた。試運転の記録（head `de86d6e6`）は採り直していない。その後の harness の変更（この節）で head の束縛は古くなったが、記録はもともと G-pub の証跡ではない（README）。

### 10.3 lifecycle の再レビューの修正（2026-10-26）

P1・P2 なし。P3 を直した。どれも commit の後に、保存した原本の copy からの変異で赤になることを確かめた。

| 指摘 | 直し | 赤になる変異 |
|---|---|---|
| P3-3: Windows の taskkill の記述と実装の食い違い | `launchOwned` が `exit`（`close` より先）を別に記録し（`hasExited`）、root が exit した後は graceful・強制とも、その pid に signal も `taskkill` も送らない（残存は CIM の走査、POSIX は group の消滅で確かめる）。§10 の「同値の変異」の説明を訂正した | exit の記録を外す（exit の後・close の前の窓の試験で赤）、強制の分岐を close 基準に戻す、graceful を exit で止めない |
| P3-1: 中断の対象の登録が試験で守られていない | `runPackaged`／`runProbeMain` を export し、launch／terminate／inject／Electron の場所を差し替えられる形にした。launch した owner が terminate の時点で登録されていること、終了の証拠が取れなければ登録が残り、中断の処理が terminate することを固定した | packaged／probe の `track` を外す（M12）、release を常に外す |
| P3-2: 所属を確かめられないときの fail-closed | `/proc/<pid>/stat` を読めない、`ps` が失敗する場合に owned にならないことを固定した | catch を owned にする |
| P3-5: `closeAllWithin` の結果 | 受け口の close が上限を超えたら記録に `observersClosed: false` を残し、判定の `recorded.observersNotClosed` と出力の警告に出す（判定には使わない。ある時だけ field を出す） | 警告を出さない。記録に残す側（`runConfig`）は export しておらず、変異を回していない |
| P3-4: `--test-force-exit` | 外しても `node --test electron/scripts/packaged-smoke/*.test.mjs` は約 4 秒で終わった（89 件）。workflow から外した（handle の漏れを隠さない） | — |

試運転の記録（head `de86d6e6`）は採り直していない（README のとおり G-pub の証跡ではなく、head 束縛は古い）。

## P3（H1）

この節は CP-2b の PR 列（TASK §7.1）の **P3（H1: 更新経路の定期 CI `update-route-watch.yml` と、RS-1 起因の更新の失敗が updater の error として surface される試験）** だけを扱う。出所は TASK §4、§6、§7.2、§1.5、§11 と K3/3（`docs/plans/nir1-d2a-activation-proposal-3-draft.md`）の :380（H1）、:356（`github-releases.githubusercontent.com`）、:170（更新の失敗の影響）。branch `claude/cp2b-p3-update-route-watch`（基点 master `8e93bb31`）。mutation の前に書き、実装後の事実は「P3.5 実装後の追記」に足す（前の本文は直さない）。

### P3.1 範囲と、範囲の外

- 範囲: (a) `scripts/update-route-redirect-check.mjs`（検知の script）、(b) `.github/workflows/update-route-watch.yml`（週 1 回＋手動）、(c) 契約試験と script の単体試験（`scripts/release-workflows.test.mjs` の独立した describe と、SHA 固定の試験の対象への 1 行）、(d) `electron/main/updater.test.ts` への `net::ERR_NAME_NOT_RESOLVED` の試験、(e) 実 Electron の新規 harness（`electron/scripts/update-route-name-probe*.mjs`。ローカルで走らせる道具で、CI には載せない〔H3 は非目標〕）。
- 範囲の外: RS-1・許容集合への host の追加（検知した場合の対応も含む。重要な変更 (2)）、`electron/main/rendererContainment*`・`windows.ts`・`index.ts`・`webrtc-block-probe*`・`renderer-isolation-probe*` の編集、製品コード（`updater.ts` を含む）の変更、`release.yml`、`ci.yml`、`scripts/local-ci-registry.json`、version・release notes・tag・GitHub Release。

### P3.2 threat model（GDX-PRECHECK-001。何が・どこへ・どの頻度で）

| 項目 | 内容 |
|---|---|
| 何が | GitHub の hosted runner（`ubuntu-24.04`）の 1 job。`permissions: contents: read`、secrets を参照しない、`actions/checkout` は `persist-credentials: false`、`pull_request`／`pull_request_target` の trigger なし（fork の code を走らせない）。製品の通信ではなく、製品の挙動も変えない |
| どこへ（検知の要求） | 起点は `https://github.com/electron/electron/releases/download/v<package.json の electron の exact 版>/SHASUMS256.txt`（現行 43.8.3）。`redirect: "manual"` で 1 hop ずつ受け、`Location` の host が RS-1 の GitHub 3 host（`RS1_GITHUB_HOSTS`）に含まれる場合だけ次へ進む。含まれない host には要求を出さない（検査は要求の前）。現行の観測では `github.com` → `release-assets.githubusercontent.com` の 1 hop |
| どこへ（道具の取得） | `actions/checkout`・`pnpm/action-setup`・`actions/setup-node`（40 桁 SHA 固定。github.com と GitHub の配布先）、`pnpm install --frozen-lockfile --ignore-scripts`（npm registry。lockfile の integrity で固定、lifecycle script を走らせない）。どれも既存の CI と同じ受け手で、新しい受け手ではない |
| どの頻度で | `schedule` の週 1 回（月曜 03:17 UTC）＋`workflow_dispatch`。1 run の要求は最大 11 回（起点＋redirect の上限 10。electron-updater の `maxRedirects` と同じ）で、各 30 秒の timeout、job 全体 10 分 |
| 運ぶもの | 利用者のデータは無い。要求に認証情報・cookie を付けない（Node の `fetch` の既定の header だけ）。asset の本文は最後の 200 の header を見たら読まずに捨てる |
| 出力 | log は hop ごとの status と host だけ。署名付きの `Location` の query は出さない（公開物の一時 URL だが、log に残す理由がない） |
| 失敗の意味 | job が失敗する（GitHub の workflow 失敗の通知が検知になる）。host の追加・RS-1 の変更・issue の作成はしない（`issues: write` を持たない）。GitHub の障害でも失敗するが、誤検知は手で読み分ける（検知の取りこぼしより安全側） |
| subprocess（実 Electron の harness） | ローカル専用。Electron の子は独立の process group、上限の timeout、終了は子の PID（group）指定の kill と `close` の観測で確かめる。一時の `HOME`／`XDG_*`／TMPDIR（短い path）を使い、終われば消す。Xvfb は `scripts/local-ci-xvfb.mjs` を host namespace で使う。要求先は loopback の模擬 server だけで、名前は NC-1 の規則で解決されない（外部の DNS へ問い合わせない設計。ただし Chromium の他の通信〔辞書など〕は起きうるので「外部網なし」は主張しない） |

重要な変更の線引き（TASK §6）: 週 1 回 GitHub の公開 asset（RS-1 の既知の host）へ要求することは (2) に当たらない（新しい受け手が無い）。GitHub 以外の host を検知の対象や許容に足すことは (2) で、ここではしない。

### P3.3 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP2B-P3-1 | 2026-10-26 | CP-2b P3 | workflow は `schedule`（`17 3 * * 1`）＋`workflow_dispatch`、`ubuntu-24.04`、`permissions: contents: read`（top level。job で広げない）、`timeout-minutes: 10`、`concurrency`（同じ group で重ねない）、secrets なし、checkout は `persist-credentials: false`。action は 40 桁 SHA 固定で、既存の固定の試験の対象表に 1 行足す。契約（trigger、権限、secrets の不使用、timeout、実行する command）は `scripts/release-workflows.test.mjs` の独立した describe で固定する | actor は GitHub の scheduler と手動の dispatch をする repo の書込み権者だけ。fork の PR から走らない | (1) `pull_request` でも走らせる案: PR ごとに外部へ要求が増え、TASK の形（週 1＋手動）から外れる。(2) 失敗で issue を作る案: `issues: write` が要る | なし | 該当なし（新しい受け手が無い。TASK §6 が「当たらない」と定める） | P3.2 | 記録済み（実装前） |
| DR-CP2B-P3-2 | 2026-10-26 | 同 | 検知の対象は `electron/electron` の現行版の `SHASUMS256.txt`（K3/3:380）。版は実行時に `package.json` の `devDependencies.electron`（exact の `x.y.z` だけを受け、それ以外は失敗）から読むので、Electron の版上げに自動で付いていく。`GrimodexReleases` の公開後の付け替えは別の判断で行う（GitHub の公開 repo の asset への付け替えは (2) に当たらないが、記録して報告する） | 公開 asset だけ。Grimodex 固有の release の構成は見えない（K3/3:380 の限界をそのまま持つ） | 版を workflow に書く案: 版上げのたびに忘れうる | なし | 該当なし | P3.2 | 記録済み（実装前） |
| DR-CP2B-P3-3 | 2026-10-26 | 同 | 判定: hop ごとに `fetch(url, { redirect: "manual" })`。3xx は `Location` を今の URL に対して解決し（`new URL`）、正規化（小文字化は URL の仕様、末尾の `.` を外す）した上で、`https:` であること、userinfo が無いこと、port が既定であること、host が `RS1_GITHUB_HOSTS` に exact で含まれることを確かめ、どれかに反すれば要求を出さずに失敗。`Location` の欠落、redirect の上限（10）超え、最後の status が 200 でないこと、通信の失敗・timeout も失敗。起点の host も同じ検査に通す | 要求は RS-1 の host にだけ出る（検査が要求の前）。suffix 一致・wildcard にしない（`objects.githubusercontent.com.example` を通さない） | (1) `redirect: "follow"` で最後の URL だけ見る案: 途中の host が RS-1 外でも見えず、RS-1 外の host へ要求を出してしまう。(2) 最初の hop だけ見る案: 2 段目の変化を見落とす | なし | 該当なし | P3.2 | 記録済み（実装前） |
| DR-CP2B-P3-4 | 2026-10-26 | 同 | `RS1_GITHUB_HOSTS` は `electron/main/rendererContainment.ts` を esbuild の `transform`（memory の上だけ。file を書かない）で JS にして `data:` URL で import し、その export を読む（read-only。file は変えない）。値が 3 件の空でない文字列の配列でなければ失敗。workflow は esbuild のために `pnpm install --frozen-lockfile --ignore-scripts` をする | 正本は製品の定数 1 つ（写しを作らない）。lockfile の integrity で道具を固定 | (1) 定数を script に写す案: 正本と食い違いうる。(2) 正規表現で TS を読む案: 書式の変更で黙って壊れうる。(3) Node の type stripping 案: runner の Node の版に依存する（Node 22 の既定化は 22.18 以降） | なし | 該当なし | P3.2 | 記録済み（実装前） |
| DR-CP2B-P3-5 | 2026-10-26 | 同 | 試験 (a): `electron/main/updater.test.ts` に、check と download の進行中に `error` event（`net::ERR_NAME_NOT_RESOLVED`）が来ると操作（＝renderer が `invoke` する IPC handler）が `Update <action> failed: net::ERR_NAME_NOT_RESOLVED` で reject し、次の操作が汚れないこと、`checkForUpdates` 自体がその error で reject する場合も同じ文言になること、操作の外の error は `warn` に出て crash しないことを足す（既存 `:268-281` の形）。製品コードは変えない | renderer への通知は IPC の reject（`src/lib/updater.ts` の `invoke` が受ける）で、error の broadcast の channel は無い（事実の確認）。自動確認の失敗が利用者に見えないこと（K3/3:170）は変えない | renderer 側の試験も足す案: renderer の wrapper は reject を素通しするだけで、既存の試験の範囲 | なし | 該当なし | — | 記録済み（実装前） |
| DR-CP2B-P3-6 | 2026-10-26 | 同 | 試験 (b): 新規 `electron/scripts/update-route-name-probe.mjs`（runner）と `update-route-name-probe-main.mjs`（Electron の main。esbuild で束ねる）。main は製品の `createRendererContainment()`（既定の deps）の起動手順 (0) `appendResolverSwitch()`、(1) `registerWebContentsPolicy()`、ready の後の (2)〜(4) `start()` をそのまま通し、更新の要求は electron-updater 本体の `ElectronHttpExecutor`（partition `electron-updater` の session の `net.request`、`redirect: "manual"` で作り直す方式）で出す。loopback の模擬 server が `302` で `http://github-releases.githubusercontent.com:<port>/…` へ向けると `net::ERR_NAME_NOT_RESOLVED` で reject すること、同じ server の loopback への `302` は 200 に届くこと（redirect の経路が働く対照）を確かめる。規則が原因であることの対照は別の起動で、`buildHostResolverRules(["MAP github-releases.githubusercontent.com 127.0.0.1"])`（`prefixRules` は試験用の既存の引数）を当てると同じ要求が 200 に届くこと | 製品の NC-1 の module を import するだけで、NC-1 の file も既存の probe も変えない。製品に seam を足さない。要求先は loopback だけ | (1) 既存の `webrtc-block-probe` に行を足す案: G-open の記録の道具を変えることになる（禁止）。(2) `net.request` を手で書く案: electron-updater の redirect の作り直しを写すことになり、本体と食い違いうる | なし | 該当なし | P3.2 | 記録済み（実装前） |

### P3.4 TASK と master の食い違い（調べた結果）

- `RS1_GITHUB_HOSTS` は `rendererContainment.ts:16-20`（TASK は :16-19。宣言の閉じ括弧まで含めた差だけで内容は同じ 3 host）。
- Electron は `package.json` で `43.8.3`（TASK の記述と一致）。`electron-updater` は `6.8.9`、`builder-util-runtime` は `9.7.0`（`maxRedirects = 10`）。
- `updater.test.ts:268-281` の既存の形（`surfaces method/error-event failures without poisoning a retry`）は master でも同じ行にある。
- TASK §11 の「electron-updater が専用 partition を使うか」は P1 の §5 で確かめ済み（partition `electron-updater`、`cache: false`）。(b) はそれに合わせる。
- `GrimodexReleases` の公開状態はこの lane では確かめ直していない（TASK の記述のまま。対象にしない）。
- 新しい workflow を default branch に入れる前に `workflow_dispatch` できないこと（TASK §11 の推測）は確かめていない。PR の段階では workflow は走らず、merge 後の初回の手動 dispatch か最初の schedule が最初の実行になる。

### P3.5 実装後の追記（2026-10-26）

branch `claude/cp2b-p3-update-route-watch`（基点 `8e93bb31`）。commit: `54a2f810`（この節の P3.1〜P3.4）、`01fd6fb1`（script）、`d540a60e`（workflow）、`e828faf3`（契約・単体試験）、`019d484b`（updater の試験）、`4674527f`（実 Electron の harness）。

実装の要点と、設計（P3.3）からの差:

- 試験の置き場: script の単体試験と workflow の契約は `scripts/release-workflows.test.mjs` の独立した describe「update route watch (CP-2b P3, H1)」に置き、SHA 固定の試験の対象表には `update-route-watch.yml` を 1 行足した。別の試験 file にすると `ci.yml` と `scripts/local-ci-registry.json` の一覧に足すことになり、registry の sha（`scripts/local-ci-full-workload-allocation.json`）も変わるので避けた（既存の CI の段「Release workflow and manifest contract tests」でそのまま走る）。
- 要求は正規化の検査を通った URL をそのまま使う（末尾の `.` 付きの FQDN は同じ名前として要求する）。検査は `.` を外した host で行う。
- (b) の harness は、electron-updater の確認の形（`HttpExecutor.request`。net の既定の redirect の追従）と取得の形（`ElectronHttpExecutor.download`。`redirect: "manual"` で作り直す）の両方を通す。どちらも `net::ERR_NAME_NOT_RESOLVED` で reject した。Electron は `--no-sandbox` で起動する（webContents を作らない。既存の probe と同じ扱い）。判定の純関数の試験 `electron/scripts/update-route-name-probe.test.mjs` は CI の一覧に載せていない（ローカルの道具。`webrtc-block-probe-verdict.test.mjs` と同じ扱い）。

試験と変異（どれも元に戻して再確認した）:

| 実行 | 結果 |
|---|---|
| `node --test scripts/release-workflows.test.mjs` | 27 passed（P3 の 5 件と、対象を足した SHA 固定の試験を含む） |
| 変異（script）: `*.githubusercontent.com` の wildcard 化、redirect 先の検査の除去、userinfo／port の検査の除去、末尾の `.` の処理の除去、`redirect: "follow"`、redirect の上限の除去、4xx の終端の受理 | 各 1〜2 件が赤 |
| 変異（workflow）: `pull_request` の追加、`contents: write`、timeout 30 分、action の tag 指定、`persist-credentials: true` | 各 1〜2 件が赤 |
| `pnpm exec vitest run --config vitest.electron.config.ts electron/main/updater.test.ts` | 21 passed（P3 の 4 件を含む） |
| 変異（`updater.ts`。製品は元に戻した）: error event を進行中の操作へ渡さない、reject の文言から原因を落とす、操作の外の error を投げ直す | それぞれ 2、3、1 件が赤 |
| `node --test electron/scripts/update-route-name-probe.test.mjs` | 3 passed（合成の記録 13 通りの変異が赤） |
| `TMPDIR=/tmp/claude-1000/h1 node electron/scripts/update-route-name-probe.mjs`（Linux、Electron 43.8.3、2 回） | `H1(b) PASS`。product: containment の `start()` が true、loopback への 302 は 200、RS-1 外の名前への 302 は確認・取得とも `net::ERR_NAME_NOT_RESOLVED`、その名前は server に届かず、partition `electron-updater` の `resolveHost` も失敗。mapped-control: 同じ要求が 200 で、server が `github-releases.githubusercontent.com:<port>` の Host で受けた。両方の起動で exit 0、group の残りの process 0 |
| 変異（実 Electron）: product の起動で RS-1 外の名前を loopback へ写す（RS-1 に足したのと同じ状態） | `H1(b) FAIL`（4 項目） |
| `node scripts/update-route-redirect-check.mjs`（ローカルから 1 回。公開 asset への要求） | `github.com` 302 → `release-assets.githubusercontent.com` 200、exit 0（2026-10-26） |
| `pnpm exec tsc -p electron/tsconfig.json --noEmit`、`pnpm validate:architecture` | 成功 |

確かめていないこと・開示:

- hosted の runner での workflow の実行（default branch に入る前は schedule も dispatch も走らない。TASK §11 の推測のまま）。`pnpm install --ignore-scripts` の後に esbuild が postinstall なしで動くこと（esbuild の JS API は platform の package の binary を直接使う。推定）。
- GitHub の schedule が 60 日の無活動で止まること、schedule の失敗の通知が cron を最後に変えた利用者へ行くこと（どちらも一般的な挙動の推測）。止まったことの検知は続行計画の期限の表で扱う（TASK §4）。
- `GrimodexReleases` の公開後の対象の付け替え（DR-CP2B-P3-2）。
- 利用者に見える副作用: worktree の `node_modules` に Electron 43.8.3 の binary を利用者の cache（`~/.cache/electron`）の zip から展開した。Xvfb は `scripts/local-ci-xvfb.mjs` を host の namespace で使い、利用者の `/tmp/.X11-unix/X0`〜`X2` は実行の前後で残っている。一時 dir は消した。ローカルの検知の 1 回は github.com と release-assets.githubusercontent.com へ要求した。Chromium の他の通信（辞書など）は起きうるので「外部網なし」は主張しない。
- Quick／Full はローカルで走らせていない。

### P3.6 独立 security レビューの修正の追記（2026-10-26）

レビューの結論は P1 なし、P2 が 1 件。直した点（commit `d4221d64`、`ffba278b`、`3a7083e5`）:

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP2B-P3-7 | 2026-10-26 | CP-2b P3（レビュー修正） | 末尾ドットは検知側で拒否し、製品との差を作らない。host の末尾が `.`（URL が `.` へ写す全角の句点 `。` を含む）なら `trailing-dot` で失敗する（P3.5 の「`.` を外して照合し、付いたまま要求する」を改めた） | 製品の `EXCLUDE <host>` が末尾ドット付きの名前に当たるかは確かめていない（推測）。当たらない場合、検知が通っても製品は `~NOTFOUND` になりうる | `.` を外したまま照合を続ける案: 上の差が残る | なし | 該当なし | P3.2 | 記録済み（レビュー修正） |

- P2（suffix 一致の変異が検出されない）: 「fails before contacting a redirect host outside RS-1」の表に RS-1 の host の subdomain 3 件（`evil.github.com`、`x.objects.githubusercontent.com`、`a.release-assets.githubusercontent.com`）を足した。`host === h || host.endsWith("." + h)` の変異で赤になった。DR-CP2B-P3-3 の「suffix 一致にしない」を固定する。
- 末尾ドット（DR-CP2B-P3-7）: ASCII の `.` は表で、全角の句点は `admitUrl` を直接呼んで試す（合成の `Response` の header に非 ASCII を載せられないため）。末尾ドットを許す変異と、`.` を外して照合する変異のどちらでも赤になった。
- error 文の回帰: 拒否の error 文に Location の path・query（`sig=`）が出ないことを表の各行で確かめる。error 文に Location を足す変異で赤になった。
- workflow の契約の追加: concurrency（`update-route-watch`、`cancel-in-progress: false`）、`pnpm/action-setup` の版と `package.json` の `packageManager` の一致、`setup-node` の版と `release.yml` の pnpm を使う job の版（22。job の間で 1 つ）の一致、3 つの action の SHA が `release.yml` の pin と同じ値であること、step の一覧（3 action と 2 run。step の key は `name`／`uses`／`run`／`with` だけ）を固定した。変異 9 種（concurrency の除去、`cancel-in-progress: true`、pnpm の版、Node 24、3 つの action の SHA の差替え、step の追加、step への `env`）でそれぞれ赤になった。
- harness の signal の片付け: runner が SIGINT／SIGTERM を受けると、まず次の起動を止める印を立て、実行中の子の process group（`-child.pid`）に SIGTERM を送り（wrapper が Xvfb を片付ける）、`close` を最大 5 秒待ってから SIGKILL を送り（待つ間に入れ替わった子にも）、一時 dir を消して 130／143 で終了する。単体試験 3 件（`createSignalCleanup` を偽の kill／remove／exit で試す）を足し、変異 5 種（SIGTERM を省く、SIGKILL を省く、一時 dir を消さない、止める印を立てない、入れ替わった子を止めない）で赤になった。手動の確認: Electron の実行中（group に 3 process）に runner へ SIGTERM を送ると、exit 143、group の残り 0、一時 dir 0、h1b の process 0、利用者の `/tmp/.X11-unix/X0`〜`X2` は残った（同時に動いていた別 lane〔P2〕の Xvfb には触れていない）。最初の手動の確認で、片付けの待ちの間に次の起動（mapped-control）が始まる競合が見つかったので、止める印を足した。
- 判定の弱い変異 2 件: 判定の試験に、余分な case を持つ product の記録と、対照の server 到達が 1 回だけの記録を足した。case の集合の検査を外す変異と、`< 2` を `< 1` にする変異で赤になった。
- 取り込まなかったもの: 5xx・通信の失敗の即失敗は安全側の設計として維持した。`error.cause.code` は log に出していない（host 名と status 以外を出さない原則を優先した）。
- 再確認: `node --test scripts/release-workflows.test.mjs` 28 passed、`node --test electron/scripts/update-route-name-probe.test.mjs` 6 passed、実 Electron の harness `H1(b) PASS`、検知の script を公開 asset に 1 回（`github.com` → `release-assets.githubusercontent.com`、exit 0）。
