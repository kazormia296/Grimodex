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
