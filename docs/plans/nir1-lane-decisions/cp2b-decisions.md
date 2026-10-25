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

（実装の後に足す）
