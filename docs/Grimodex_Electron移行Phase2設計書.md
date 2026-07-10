# Grimodex Electron移行 Phase 2 設計書 — Electron シェル構築

- 日付: 2026-07-10
- ステータス: 実装計画（Phase 1 完了・Phase 0 全GO を前提とする）
- 正本: `docs/Grimodex_Electron移行検討.md`（移行判断・全体フェーズ計画。本書はその Phase 2 を詳細化する）
- 積み先: ブランチ `feat/electron-shell`（Phase 1 の5コミットの直上に積む。Phase 1 と同一PRで出す — 2026-07-10 ユーザー決定）

## 0. スコープ（TL;DR）

Phase 2 は「**Electron シェルで Grimodex が起動し、実 SQLite ワークスペースを開いて執筆・保存・ウィンドウ操作ができる垂直スライス**」を作る。全 145 コマンドの移植はしない。**napi 経由で通すのは db_execute / db_execute_batch + 代表 5 コマンドのみ**とし、残りは安定マーカー付きの明示エラーで落とす。Tauri シェルは無傷で並走し続ける（`pnpm tauri dev` / CI / リリースは一切変えない）。

**やること**
1. Rust クレート再編: DB 層を `crates/grimodex-db` へ抽出し、Tauri コマンド層と napi 層の両方から呼べるようにする（Tauri 版の挙動は不変の純リファクタ）
2. napi ネイティブモジュール `grimodex-node`（Backend クラス + async 垂直スライス）
3. Electron main / preload / typed IPC ブリッジ（contextIsolation + sandbox、envelope 方式）
4. `src/lib/` ラッパー群の 3 分岐化（isTauri / isElectron / browser-mock）
5. ウィンドウクローム（frameless + transparent + drag region + close veto + パネル別窓 + window-state + vibrancy）
6. イベントバス（renderer 間 broadcast + napi ThreadsafeFunction 配線の実証）
7. 本番ロード（`app://` プロトコル + CSP）と Playwright スモーク

**やらないこと（Phase 3 以降）**: AI ストリーミング / post_effect / semantic / lint / vivliostyle / external_mount / license 実体 / updater / electron-builder 全ターゲット / データ移行。§11 に明示。

## 1. 受け入れ条件（Phase 2 完了の定義）

| # | 条件 | 検証方法 |
|---|---|---|
| A1 | `pnpm electron:dev` で frameless + transparent の窓が起動し、ヘッダドラッグ・最小化/最大化/閉じるが動く | 手動 + スモークスクリプト |
| A2 | フォルダピッカ → `open_workspace`（migrate + VACUUM INTO バックアップ）→ シーンツリー表示 → エディタで執筆 → オートセーブ（db_execute_batch）→ **アプリ再起動後も内容が残る** | `pnpm electron:smoke`（Playwright `_electron`） |
| A3 | Electron で書いた workspace を **Tauri ビルドで開ける**（同一スキーマ・同一 migrate 経路の相互運用） | 手動: 同じフォルダを `pnpm tauri dev` で開く |
| A4 | close veto: 未確定 inline-AI diff 相当のガードが立っている間、closeで窓が閉じない（veto 解除で閉じる） | 単体テスト + dev console からのガード注入で手動確認 |
| A5 | パネル別窓: Codex パネルを別 BrowserWindow で開き、`codex:data-changed` が窓間同期する | 手動 + イベントバス単体テスト |
| A6 | 未実装コマンドは `IPC_UNIMPLEMENTED:` マーカー付き reject になり、**起動フローと編集フローはそれで壊れない**（fail-soft 監査済み） | S5 の監査チェックリスト |
| A7 | 既存テスト 8,636 件・`tsc --noEmit`・`pnpm lint`・`cargo check/clippy/test --workspace` すべてグリーン。**既存テストの変更ゼロ**（追加のみ） | CI |
| A8 | `pnpm tauri dev` / `pnpm dev`（browser-mock）が従来どおり動く | 手動スモーク |
| A9 | `pnpm electron:start`（vite build 成果物を `app://` でロード）で A1〜A2 相当が通る | スモーク |

## 2. 全体アーキテクチャ

```
┌────────────────────────── Electron main (dist-electron/main.cjs) ──────────────────────────┐
│ windows.ts   : BrowserWindow レジストリ (label→win)。main / panel-* 生成、window-state 復元  │
│ ipc.ts       : ipcMain.handle("grim:invoke") ルーター                                        │
│                 ├─ TS ハンドラ (set_window_vibrancy / get_license_state stub / dialog / fs) │
│                 ├─ napi Backend (db_execute / db_execute_batch / open_workspace / ...)      │
│                 └─ 未知コマンド → {ok:false, error:"IPC_UNIMPLEMENTED: <cmd>"}              │
│ events.ts    : EventBus。broadcast(channel,payload) → 全窓 webContents.send("grim:event")   │
│                 ├─ renderer 発 emit (ipcMain.on)  ← codex:* 窓間同期                        │
│                 └─ napi ThreadsafeFunction 発 (backend.onEvent) ← Phase 3 で 19ch 実配線    │
│ backend.ts   : grimodex-node(.node) のロードと Backend インスタンス管理                       │
│ security.ts  : will-navigate 拒否 / setWindowOpenHandler / CSP / permission handler          │
│ protocol.ts  : 本番 app:// スキーム (dist/ 配信)                                             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        │ contextBridge ("grimodex")                     │ require()
┌───────▼───────────────────────────┐    ┌───────────────▼──────────────────────────────────┐
│ preload (sandbox:true)             │    │ electron/native/grimodex-node (napi-rs, cdylib)  │
│ invoke/listen/emit/windowControls/ │    │ #[napi] class Backend {                          │
│ dialog/fs/openExternal/getVersion/ │    │   AppState { WorkspaceState, SettingsPaths }     │
│ setZoom/panelWindow                │    │ }  … async fn + spawn_blocking                   │
└───────▲───────────────────────────┘    │ 依存: grimodex-db + grimodex-core (path)          │
        │ window.grimodex                 └───────────────▲──────────────────────────────────┘
┌───────┴──────────────────────────────────────┐         │ path 依存
│ renderer = 既存 src/ (無傷)                    │  ┌──────┴───────────────────────────────────┐
│ src/lib/tauri.ts ほか 10 ラッパーが 3 分岐:     │  │ src-tauri/crates/grimodex-db (新設)       │
│  isTauri() → @tauri-apps/* (従来どおり)        │  │ database.rs + migrate/execute/fts/…       │
│  isElectron() → window.grimodex               │  │ + WorkspaceState/with_db_state/AppError   │
│  それ以外 → browser-mock (従来どおり)          │  │ ← src-tauri 本体からも従来どおり利用       │
└──────────────────────────────────────────────┘  └──────────────────────────────────────────┘
```

## 3. 論点1: 移行期の共存構成

### 3.1 ディレクトリ構成（新設はすべて `electron/` 配下に隔離）

```
electron/
├── main/
│   ├── index.ts          # エントリ: app ライフサイクル、単一インスタンスロック
│   ├── windows.ts        # 窓ファクトリ + label レジストリ + close veto プロトコル
│   ├── windowState.ts    # label 別 bounds/maximized 永続化（自前 ~80 行）
│   ├── ipc.ts            # invoke ルーター（envelope）
│   ├── events.ts         # EventBus（emit broadcast / napi イベント sink）
│   ├── backend.ts        # .node ロード + Backend 初期化（失敗時はエラーダイアログ）
│   ├── shellCommands.ts  # TS 実装コマンド（vibrancy / license stub / dialog / fs / opener / version / zoom）
│   ├── security.ts       # navigation ガード / CSP / permissions
│   └── protocol.ts       # app:// スキーム（本番）
├── preload/
│   └── index.ts          # contextBridge.exposeInMainWorld("grimodex", …)
├── shared/
│   └── ipcContract.ts    # コマンド表（実装先 backend 区分）+ イベントチャネル allowlist + 型
├── native/
│   └── grimodex-node/    # napi-rs クレート（§4）。空 [workspace] で src-tauri workspace 非吸収
│       ├── Cargo.toml / build.rs / package.json / src/lib.rs / src/state.rs / …
├── scripts/
│   ├── dev.mjs           # vite(1430) + esbuild --watch + electron 起動のオーケストレータ
│   ├── build.mjs         # esbuild bundle（main/preload → dist-electron/）
│   └── smoke.mjs         # Playwright _electron スモーク（A2 シナリオ）
└── tsconfig.json         # module NodeNext / types: node,electron（root tsconfig は include:["src"] のため不干渉）
```

### 3.2 ビルド: electron-vite ではなく「既存 vite + esbuild の手組み」

**決定: 手組み**。理由:
- リポジトリは Vite 8.0.16。electron-vite のメジャー追随ラグを踏むリスクを避ける（Tauri と renderer 設定を共有する以上、renderer の Vite を electron-vite の対応版に**下げる**選択肢はない）。
- electron-vite は `src/main / src/preload / src/renderer` のディレクトリ規約を持ち、feature-based の既存 `src/` と衝突する。
- 「`vite.config.ts` と `tauri.conf.json` に 1 行も触らない」ことが A8 の最強の保証になる。main/preload は数百行の Node コードで、esbuild（`platform: "node"`, `format: "cjs"`, `external: ["electron", "*.node"]`, 出力 `dist-electron/`）で十分。HMR は renderer 側（既存 vite）が担い、main 変更時は dev.mjs が electron を再起動する。

### 3.3 pnpm スクリプト体系（既存スクリプトは無変更）

| スクリプト | 内容 |
|---|---|
| `electron:dev` | `node electron/scripts/dev.mjs` — ①`vite --port 1430 --strictPort`（**1420 は tauri dev 専有のまま**。CLI フラグ上書きなので vite.config.ts 無改修）②esbuild watch ③`ELECTRON_RENDERER_URL=http://localhost:1430` で electron 起動 |
| `electron:build` | `tsc -p electron/tsconfig.json --noEmit && node electron/scripts/build.mjs && pnpm build` |
| `electron:start` | ビルド済み `dist/` + `dist-electron/` を `app://` でロードして起動（本番経路の検証） |
| `electron:smoke` | `node electron/scripts/smoke.mjs`（A2 自動化） |
| `napi:build` | `pnpm --dir electron/native/grimodex-node build`（`napi build --release`） |

devDependencies 追加: `electron`（**43.1.0 に exact pin** — Phase 0 スパイク実証版）、`@napi-rs/cli`（^2.18.4、スパイク同版）、`esbuild`（既に overrides あり、明示 devDep 化）。`.gitignore` に `dist-electron/`, `electron/native/**/target/`, `*.node` を追加。

### 3.4 `src/lib/` ラッパーの実行時 3 分岐

判定は **isTauri → isElectron → browser-mock の順**（Tauri 窓に `window.grimodex` は存在しないので順序は安全側の作法）。`src/lib/tauri.ts` に追加:

```ts
export function isElectron(): boolean {
  return typeof window !== "undefined" && "grimodex" in window;
}
```

| ファイル | Electron 分岐の実装 |
|---|---|
| `tauri.ts` invoke | `enqueueIpc(cmd, () => bridge.invoke(cmd, args) → envelope 解封, ms)` — **ipcQueue（同時4本）と SLOW_COMMANDS（300s 表）をそのまま共用**（§5.3） |
| `tauri.ts` listen/emit | `bridge.listen` / `bridge.emit`（§7） |
| `dialog.ts` | `bridge.dialog.openFolder()`。**併せてローカル isTauri コピーを @/lib/tauri import に統一** |
| `importFile.ts` / `fs.ts` | ファイル選択は `bridge.dialog.openFile(filters)` + `bridge.fs.readTextFile`。readDir も bridge 経由 |
| `windowControls.ts` | `bridge.windowControls.*`（§6.3） |
| `webviewWindows.ts` | `bridge.panelWindow.*`（§6.5） |
| `uiScale.ts` | `bridge.setZoomFactor(f)`（main 側 `webContents.setZoomFactor`。sandbox preload の webFrame 制約を踏まないよう main 経由に統一） |
| `appInfo.ts` | `bridge.getVersion()`（`app.getVersion()`） |
| `opener.ts` | `bridge.openExternal(url)`（main で scheme allowlist 再検証 = safeUrl.ts と二重防御） |
| `updater.ts` | Phase 2 は **check() → null / relaunch() → no-op**（非 Tauri と同挙動。実装は Phase 4） |
| `notification.ts` | **変更不要**。既存の Web Notification フォールバックが Electron renderer でそのまま動く |

**feature 層の 6 ファイル**（`foreshadow/api.ts` / `saveAnchors.ts` / `codex/candidateExtractor.ts` / `rustMatcher.ts` / `trash-bin/api.ts` ほか）のローカル `__TAURI_INTERNALS__` 判定は **Phase 2 では意図的に Tauri 判定のまま残す**。これらの非 Tauri フォールバックは drizzle（= `db_execute`）か純 JS 実装であり、Electron では db_execute が実 DB に着弾するため**フォールバック側が正しく動く**。専用コマンド（`codex_rebuild_matcher` 等）が napi に載る Phase 3 で、`hasNativeCommands()`（新設ヘルパ）へ 1 ファイルずつ切り替える。

## 4. 論点2: Rust 側のクレート再編

### 4.1 抽出戦略 — 新クレート `src-tauri/crates/grimodex-db`

grep 実測で `src-tauri/src/database.rs` + `database/{execute,migrate,fts,integrity,change_events,undo_journal,tests,seed_schema_parity}.rs` および `src/workspace.rs` は **tauri:: 参照 0**。これを機械移動する:

- **移動**: 上記全ファイル → `crates/grimodex-db/src/`。依存は rusqlite(bundled)/serde/serde_json/sha2/flate2/tracing/anyhow/chrono/uuid + grimodex-core。
- **同時移動（state と契約型）**: `commands/mod.rs` の `WorkspaceState` / `ActiveWorkspace` / `with_db_state` / `AppError` / `AppResult` / `QueryResult`（すべて tauri 非依存）→ `grimodex-db::state` / `grimodex-db::error`。`AppError` の**文字列ワイヤ契約**（`WORKSPACE_SWITCHING` / `No workspace is open` マーカー、object 化禁止）は既存テストごと移動して gate を維持する。
- **互換シム**: `src-tauri/src/lib.rs` に `pub(crate) mod database { pub use grimodex_db::*; }`、`commands/mod.rs` に `pub(crate) use grimodex_db::{AppError, AppResult, QueryResult, WorkspaceState, ActiveWorkspace, with_db_state};` を置き、**145 コマンドファイルと `tauri::State<WorkspaceState>` 118 箇所は 1 行も変えない**。`with_db`（`tauri::State` を剥がすだけの 3 行ラッパー）のみ commands/mod.rs に残す。
- **open_workspace の共通化**: `commands/workspace.rs` のコマンド本体（backup → migrate → swap → RAII SwitchingGuard）を `grimodex_db::open::open_workspace_sync(&WorkspaceState, &OpenDeps, path) -> OpenWorkspaceResult` へ抽出。semantic キャッシュのクリア等 Tauri 側にしか無い後処理は `on_swapped: &mut dyn FnMut()` フックで注入（napi 側は no-op）。`reject_unsafe_workspace_path`（PIO-1 ガード）と `GlobalSettingsPath` 相当も同クレートへ。
- **イベント下地**: `grimodex_db::events::EventSink`（`fn emit(&self, channel: &str, payload: serde_json::Value)`）trait を定義。Phase 2 で使うのは napi 側の 1 箇所だが、Phase 3 で ai/post_effect を抽出する際の emit 差し替え点になる（Tauri 実装は `AppHandle::emit`、napi 実装は ThreadsafeFunction）。

### 4.2 napi クレート `electron/native/grimodex-node`

スパイク（`scratchpad/napi-spike`）の学びを本実装へ反映:

```toml
[package] name = "grimodex-node"
[workspace]                     # 空: src-tauri workspace へ吸収させない（スパイク実証）
[lib] crate-type = ["cdylib"]
[dependencies]
napi = { version = "2", default-features = false, features = ["napi8", "async"] }  # async = tokio_rt
napi-derive = "2"
grimodex-core = { path = "../../../src-tauri/crates/grimodex-core" }
grimodex-db   = { path = "../../../src-tauri/crates/grimodex-db" }
serde_json = "1"
anyhow = "1"
[build-dependencies] napi-build = "2"
```

- **rusqlite / libsqlite3-sys は grimodex-db 経由でのみ引く**（napi クレート直依存にしない）ことで「バージョン一致必須」問題を構造的に消す。Cargo.lock は 2 本になるため、`rusqlite` のバージョン文字列を src-tauri と一致させる（乖離検知スクリプトは Phase 3 の CI 整備で追加）。
- **State の持ち方: `#[napi]` クラス**（スパイク結論の二択から選定）。OnceCell 案よりテスト分離と明示的ライフサイクルで優る:

```rust
#[napi]
pub struct Backend { state: Arc<AppState> }   // AppState = { ws: WorkspaceState, gs: GlobalSettingsPath, .. }

#[napi]
impl Backend {
  #[napi(constructor)]
  pub fn new(app_data_dir: String) -> Result<Backend> { … }   // パスは main から明示注入（dirs:: を napi 内で解決しない）

  #[napi]
  pub async fn db_execute(&self, sql: String, params: serde_json::Value, method: String) -> Result<String> {
    let st = Arc::clone(&self.state);
    tokio::task::spawn_blocking(move || { with_db_state(&st.ws, |db| db.execute(..)) … }).await …
  }
  // db_execute_batch / open_workspace / validate_workspace_path /
  // get_global_settings / save_global_settings / timelapse_append_batch も同型
  #[napi]
  pub fn on_event(&self, cb: ThreadsafeFunction<(String, String)>) { … }  // §7
}
```

- **全公開関数を async にする**（純関数の validate 除く）。同期 `#[napi]` は Node main thread = Electron main プロセス全体をブロックする（スパイク実証）。busy_timeout 5s を踏んだ db_execute が全窓の IPC を止める事故を構造的に防ぐ。tauri 側の「db コマンドは `#[tauri::command(async)]`、長時間系は spawn_blocking」という M3 方針の写像。
- 返り値は当面 JSON 文字列（rows の二重シリアライズは Phase 3 の最適化候補として記録）。

### 4.3 垂直スライスの境界（Phase 2 で通すコマンド）

| コマンド | 実装先 | 根拠 |
|---|---|---|
| `db_execute` / `db_execute_batch` | napi | 全 Drizzle SQL の唯一の通り道（`src/db/client.ts`）。これだけで CRUD の 9 割が生きる |
| `open_workspace` / `validate_workspace_path` | napi | ワークスペースを開けないと何も始まらない。migrate + バックアップ含む |
| `get_global_settings` / `save_global_settings` | napi | 起動時に必ず呼ばれる（workspace/store.ts:152） |
| `timelapse_append_batch` | napi | 編集ループ常連の軽量 DB 書き込み（監査チェーン append）。コマンド本体 17 行 |
| `set_window_vibrancy` | main-TS | ウィンドウ API。App.tsx が catch 済みだが macOS パリティに必要 |
| `get_license_state` | main-TS スタブ | 起動時呼び出しを fail-soft にしない。**licensing 無効ビルドと同一形状**（`licensing_enabled:false`）を返す。Phase 3 で napi（grimodex-core の状態機械）へ差し替え |
| 上記以外の 137 コマンド | `{ok:false, error:"IPC_UNIMPLEMENTED: <cmd>"}` | Phase 3。マーカーは debugLog で集計可能にし、Phase 3 の優先順位付けの実測データにする |

## 5. 論点3: preload / typed IPC ブリッジ

### 5.1 セキュリティ前提

`contextIsolation: true` / `sandbox: true` / `nodeIntegration: false`。preload は `contextBridge.exposeInMainWorld("grimodex", …)` のみ。追加ガード: `will-navigate` 全拒否（dev URL の同一 origin リロードのみ許可 — `dragDropEnabled:false` 相当のファイルドロップ航行防止を兼ねる）、`setWindowOpenHandler` は deny（http/https は main の scheme 検証後 `shell.openExternal`）、`session.setPermissionRequestHandler` は notification のみ許可。

### 5.2 invoke 写像と「エラー文字列契約」

Tauri の invoke は **reject 値が生文字列**（`AppError` は文字列 serialize。FE 126 箇所が `String(err)` / `err.message` の部分一致で `WORKSPACE_SWITCHING` 等を判定）。一方 Electron の `ipcMain.handle` の throw は `"Error invoking remote method …"` という**プレフィックスでワイヤを汚す**。これを避けるため **envelope 方式**にする:

- main: ハンドラは決して throw せず `{ ok: true, value } | { ok: false, error: string }` を resolve する。napi の `napi::Error`（`{e:#}` 整形済み anyhow 文字列）は `error` にそのまま載せる。
- preload: `invoke(cmd, args)` は envelope をそのまま返す。
- `src/lib/tauri.ts` の Electron 分岐: `if (!res.ok) throw res.error;`（**生文字列 reject** = Tauri と同一ワイヤ）。

コマンド引数は Tauri の camelCase→snake_case 自動変換に依存している（例: `timelapse_append_batch` の `projectId`）。Electron 側は `electron/shared/ipcContract.ts` のコマンド表に**引数アダプタを明記**し、main ルーターがコマンドごとに napi シグネチャへ写像する。Phase 2 は 7 コマンドの手書きで済むが、この表を Phase 3 の 145 コマンド一括対応の正本に育てる。

### 5.3 ipcQueue / SLOW_COMMANDS の扱い

**renderer 側で完結しているのでそのまま共用する**。`enqueueIpc`（同時 4 本 + タイムアウト）と `SLOW_COMMANDS`（300s 表）は「invoke callable」をラップする構造なので、callable が `tauriInvoke` から `bridge.invoke` に変わるだけで運用（真のハング検出、多重実行防止）は不変。Electron の `ipcRenderer.invoke` に組み込みタイムアウトはないため、この層の意義はむしろ増す。timeout 後に main/napi 側の処理が走り続ける点も Tauri と同じ挙動（abort は Phase 3 の AtomicBool 相当写像で扱う）。

### 5.4 preload が公開する `window.grimodex`（契約）

```ts
interface GrimodexBridge {
  shell: "electron";
  invoke(cmd: string, args?: Record<string, unknown>): Promise<Envelope>;
  listen(channel: string, cb: (payload: unknown) => void): () => void;   // 同期 unlisten 返し。wrapper 側で Promise 化
  emit(channel: string, payload?: unknown): Promise<void>;
  windowControls: {
    minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onResized(cb: () => void): () => void;
    onCloseRequested(cb: () => boolean): () => void;   // true = veto（§6.4）
  };
  dialog: { openFolder(): Promise<string | null>;
            openFile(f: {name: string; extensions: string[]}): Promise<string | null> };
  fs: { readTextFile(p: string): Promise<string>; readDir(p: string): Promise<DirEntry[]> };
  openExternal(url: string): Promise<void>;
  getVersion(): Promise<string>;
  setZoomFactor(factor: number): Promise<void>;
  panelWindow: { open(label: string, opts: {width; height; title}): Promise<void>;
                 focusByLabel(label: string): Promise<boolean> };
}
```

型は `src/types/grimodex-bridge.d.ts`（renderer 参照用 declare global）と `electron/shared/ipcContract.ts`（実体）に置く。イベントチャネルは allowlist 制（19 の Rust チャネル + `codex:*` 3 + `external-mount://*` 4。前方一致ではなく列挙）。`listen`/`emit` とも allowlist 外は main が拒否する。

## 6. 論点4: ウィンドウ

### 6.1 メイン窓の生成パリティ表

| tauri.conf.json | Electron BrowserWindow |
|---|---|
| width 800 / height 600 / min 600×400 | 同値（window-state 復元が優先） |
| `decorations: false` | `frame: false`（win/linux）。**macOS は `titleBarStyle: "hidden"` + trafficLightPosition** — 現行 Tauri mac は WindowControls 非表示かつ decorations:false で操作系が空白のため、ネイティブ信号機を残す方が改善。実機確認を S6 検証に含め、NG なら `frame:false` へ後退 |
| `transparent: true` | `transparent: true` + `backgroundColor: "#00000000"` |
| `dragDropEnabled: false` | `will-navigate` 拒否で航行だけ防ぐ（HTML5 DnD はそのまま生きる） |
| `zoomHotkeysEnabled: false` | メニューに zoom ロールを載せない。macOS のみ `editMenu`/`windowMenu` ロールの最小メニュー（Cmd+C/V が死ぬため必須）。win/linux は `Menu.setApplicationMenu(null)` |
| `macOSPrivateApi` (vibrancy) | `vibrancy: "under-window"` 相当（§6.6） |
| tauri-plugin-window-state | `electron/main/windowState.ts`（§6.7） |

### 6.2 drag region — `data-tauri-drag-region` → app-region CSS

JSX 無変更で `src/index.css` に追加（**Electron シェル時のみ有効化**。renderer 起動時 `main.tsx` で `document.documentElement.dataset.shell = "electron"` を立てる）:

```css
html[data-shell="electron"] [data-tauri-drag-region] { -webkit-app-region: drag; }
html[data-shell="electron"] [data-tauri-drag-region] :where(button, a, input, select, textarea,
  [role="button"], [role="menuitem"], [data-tauri-drag-region="false"]) { -webkit-app-region: no-drag; }
html[data-shell="electron"] [data-tauri-drag-region="false"] { -webkit-app-region: no-drag; }
```

セマンティクス差に注意: Tauri の属性は「その要素自身への mousedown」だけでドラッグするが、CSS app-region は**子孫まで drag 化**する。2 行目の子孫 no-drag がその差分吸収で、`PanelToggleDropdown` / `CommandCenterBar` 等の既存 `="false"` 明示箇所は 3 行目が拾う。ダブルクリック最大化は Chromium が OS 規約どおり処理する（Tauri 属性と同挙動）。S6 でヘッダ上の全インタラクティブ要素を実クリック検証する。

### 6.3 WindowControls / onResized

`src/lib/windowControls.ts` の Electron 分岐が `bridge.windowControls` を呼ぶ。main は `win.on("maximize"/"unmaximize"/"resize")` → `webContents.send("grim:window-resized")` で通知し、既存の「onResized → isMaximized 再取得」ロジック（WindowControls.tsx）は無改修で動く。

### 6.4 close veto（onCloseRequested 契約の再現）

Tauri は renderer 内で `event.preventDefault()` する同期 veto。Electron の `close` は main 側イベントなので、**非同期問い合わせプロトコル**に写像する:

1. main `win.on("close")`: `forceClose[label]` フラグが立っていなければ常に `e.preventDefault()` → `webContents.send("grim:close-requested")` → 1,500ms タイマ開始
2. preload: 登録済みハンドラ（renderer の `guardInlineAiPending()` は同期関数）を実行し、`ipcRenderer.send("grim:close-reply", { veto })`
3. main: `veto=false` またはタイマ満了（renderer ハング時の閉じ損ね防止）→ `forceClose=true` にして `win.close()` 再発行
4. ハンドラ未登録の窓（起動直後など）は即 close

`src/lib/windowControls.ts` の `onWindowCloseRequested` は preload の `onCloseRequested(cb)` に接続し、`WindowCloseRequestedEvent.preventDefault()` 呼び出しを `veto=true` に翻訳する。**App.tsx / WindowControls.tsx は無改修**。beforeunload フォールバックも Electron で害なく併存する。

### 6.5 パネル別窓（WebviewWindow → BrowserWindow）

- main の `windows.ts` が `Map<label, BrowserWindow>` を保持。`panelWindow.open(label, opts)` は label を `/^panel-[a-z0-9-]+$/` で検証し、**URL は main が label から組み立てる**（dev: `${ELECTRON_RENDERER_URL}/?window=panel&panel=<id>`、prod: `app://bundle/index.html?window=panel&panel=<id>`）。renderer 供給 URL は受け取らない — Tauri capability（windows scope `panel-*`）の代替となる侵害時ガード。
- 窓オプション: transparent / frame:false / 480×900 / label 別 window-state 復元。親子関係は付けない（現行はフローティング独立窓）。メイン窓 `closed` で全パネル窓を閉じ、`window-all-closed` で `app.quit()`（macOS 含む — 単一アプリ窓の現行挙動に合わせる）。
- `src/lib/webviewWindows.ts` の Electron 分岐: `getWebviewWindowByLabel` → `focusByLabel` の存在確認、`createWebviewWindow` → `panelWindow.open`。`panelWindow.ts`（feature 層）は無改修。**【最終レビューで改訂】** 無改修のままだと feature 層の `isTauri()` ゲート 4 箇所（panelWindow.ts×2 / PanelChromeMenu.tsx / ToolWindowIcon.tsx）により Electron では UI から別窓へ到達不能で A5 と両立しない（confirmed 指摘）。例外として `supportsPanelWindows()`（= isTauri ‖ isElectron、正本は panelWindow.ts）を新設し、4 ゲートをこれに差し替えた。
- 既知の意味差として記録: Tauri の「生成失敗は `tauri://error` に流れ reject しない」契約は「open が reject しうる」に変わるが、呼び出し元 `openPanelWindow` は既に await + 無通知許容なので影響なし。

### 6.6 vibrancy

`set_window_vibrancy` コマンドを main-TS で実装: macOS のみ `win.setVibrancy(enabled ? "under-window" : null)`、他 OS は no-op（Rust 実装と同じ分岐構造）。窓生成時は付けず、renderer の glass 設定 effect（App.tsx:400 付近、catch 済み）からの invoke に任せる — 現行と同じ制御フロー。

### 6.7 window-state 永続化

`electron/main/windowState.ts`（自前 ~80 行、依存追加なし）: `userData/window-state.json` に `label → { bounds, maximized }`。resize/move を 500ms debounce で保存、復元時は `screen.getAllDisplays()` との交差判定で画面外復元を防ぐ。tauri-plugin-window-state と同じく JS からの参照ゼロの main 内完結。

### 6.8 userData

Phase 2 は `app.setName("GrimodexElectronDev")` として **既存 Tauri の app_data_dir（com.miyakey.grimodex）に触らない**。napi `Backend::new(appDataDir)` には `app.getPath("userData")` を渡す。本番 identifier 統一とデータ移行は Phase 4（正本ドキュメント §4 の確定事項）。

## 7. 論点5: イベント

### 7.1 Phase 2 の到達点

Rust emit 55 箇所の**実配線はしない**（発火元サブシステムが napi に居ないため物理的に不可能）。Phase 2 で作るのは:

1. **汎用イベントバス**: renderer `emit(ch, payload)` → `ipcRenderer.send("grim:emit")` → main が allowlist 検証 → **全窓に broadcast（送信元窓を含む）**。Tauri v2 の emit 契約（全窓配信 + 自己配信）と一致させる — `codexWindowSync.ts` のロック収束と `external_mount` 契約（tauri.ts:108 のコメント）が依存する性質。
2. **renderer 発チャネルの実運用**: `codex:data-changed` / `codex:lock-event` / `codex:select-entry` はこのバスだけで完結するため、パネル別窓（§6.5）と組で **Phase 2 の受け入れ対象**。
3. **napi → webContents.send 配線の実証**: `Backend.on_event(tsfn)` を main 起動時に 1 回登録し、Rust 側は `EventSink` trait（§4.1）の napi 実装（`ThreadsafeFunction<(String, String)>`、NonBlocking）経由で emit する。Phase 2 では `Backend::new` 完了時の `backend:ready` と `open_workspace` 完了時の `workspace:opened`（新設、FE 購読者なしのデバッグチャネル）で end-to-end を証明し、**Phase 3 で 19 チャネルをこの配線に載せるだけ**の状態にする。

### 7.2 意味差の記録（Phase 3 での再検証項目）

- ブラウザ fallback の CustomEvent は同期配信、Electron バスは main 経由の非同期配信。`codexEditLock` は純レデューサで決定的収束する設計のため許容と判断するが、S7 で二窓ロック取り合いを実測する。
- `listen` の解除は preload 内 Map からの削除（`ipcRenderer.on` は "grim:event" 1 本に集約し、チャネル多重化は preload で行う）。リスナリークは preload 側で `unlisten` 呼び忘れ検出カウンタを dev ログに出す。

## 8. 実装ステップ

各ステップは独立に commit し、**毎ステップで `npx tsc --noEmit` + `pnpm lint` + 影響スイートの `pnpm test --run` を通す**。Rust に触れたステップは `cd src-tauri && cargo check && cargo clippy --all-targets && cargo test --no-default-features` も走らせる。

### S1: Rust クレート再編（grimodex-db 抽出）— 純リファクタ、Tauri のまま出荷可能

- 内容: §4.1 の機械移動 + 互換シム + `open_workspace_sync` 抽出 + `EventSink` trait。
- 変更: `src-tauri/Cargo.toml`（members に grimodex-db 追加、依存差し替え）、`src-tauri/src/lib.rs`、`src-tauri/src/commands/mod.rs`、`src-tauri/src/commands/workspace.rs`、`src-tauri/src/commands/db.rs`（import のみ）
- 新規: `src-tauri/crates/grimodex-db/`（Cargo.toml + 移動ファイル群 ~10 ファイル）
- 削除（移動元）: `src-tauri/src/database.rs`、`src-tauri/src/database/`、`src-tauri/src/workspace.rs`
- 検証: `cargo test --workspace`（migrate/execute/change_events の全既存テストが新クレートで走ること）、`cargo clippy --workspace --all-targets -- -D warnings`、`pnpm tauri dev` 手動スモーク（WS open → 編集 → 保存 → バックアップ生成）。FE 変更ゼロなので 8,636 件は definitionally 無傷だが全走させる。

### S2: napi クレート grimodex-node

- 内容: §4.2 の Backend クラス + 垂直スライス 6 関数 + `on_event`。
- 新規: `electron/native/grimodex-node/{Cargo.toml, build.rs, package.json, src/lib.rs, src/state.rs, src/convert.rs, test/smoke.test.mjs}`
- 検証: `pnpm napi:build` → `node --test electron/native/grimodex-node/test/`（node:test で: 一時 dir に openWorkspace → migrate 済み user_version 確認 → dbExecute INSERT/SELECT roundtrip → dbExecuteBatch のトランザクション性（途中失敗で全 rollback）→ WORKSPACE_SWITCHING / No workspace マーカー文字列の透過 → onEvent で backend:ready 受信）。`cargo test`（クレート内 Rust 単体）。**Tauri で作った既存 workspace を openWorkspace で開けること**（A3 の前倒し確認）。

### S3: Electron スキャフォールド

- 内容: §3.1 の electron/ 骨格（ipc ルーターは未接続の空）、dev.mjs / build.mjs、tsconfig、依存追加、.gitignore。
- 新規: `electron/main/{index,windows,security}.ts`、`electron/preload/index.ts`（`shell:"electron"` のみ公開）、`electron/scripts/{dev,build}.mjs`、`electron/tsconfig.json`
- 変更: `package.json`（scripts + devDeps）、`.gitignore`
- 検証: `pnpm electron:dev` で窓が出て、renderer は **browser-mock モードで従来どおり動く**（isElectron 分岐が未実装のため sql.js に落ちる = pnpm dev と同一挙動の確認）。並行して別ターミナルの `pnpm tauri dev` が影響を受けないこと（ポート 1430/1420 分離の確認）。

### S4: invoke ルーター + ブリッジ実体

- 内容: envelope ルーター、`ipcContract.ts`（コマンド表 + イベント allowlist + 引数アダプタ）、shellCommands.ts（vibrancy / license stub / getVersion / openExternal / dialog / fs / zoom）、backend.ts（.node ロード）、preload のフル API。
- 新規: `electron/main/{ipc,events,backend,shellCommands,windowState}.ts`、`electron/shared/ipcContract.ts`、`src/types/grimodex-bridge.d.ts`
- 検証: main 単体は vitest 追加スイート（`electron/**/*.test.ts` を **新設の `vitest.electron.config.ts`（environment: node）** で。既存 config は不変）で純関数部（allowlist / envelope / 引数アダプタ / windowState の bounds 補正）をテスト。dev 起動して devtools console から `window.grimodex.invoke("db_execute", …)` の手動疎通。

### S5: src/lib ラッパー 3 分岐 + fail-soft 監査

- 内容: §3.4 の表どおり。`isElectron()` 追加、dialog.ts のローカル isTauri を統一。
- 変更: `src/lib/tauri.ts`、`src/lib/{dialog,importFile,fs,windowControls,webviewWindows,uiScale,appInfo,opener,updater}.ts`、`src/main.tsx`（`data-shell` 属性）
- 新規テスト: `src/lib/tauri.electron.test.ts` ほか（`window.grimodex` を happy-dom にモックし、①3 分岐のディスパッチ順 ②envelope 解封が**生文字列 reject** になること ③SLOW_COMMANDS のタイムアウト値選択が electron 分岐でも効くこと）
- **fail-soft 監査（A6 の実体）**: `pnpm electron:dev` で起動〜WS open〜編集の全フローを踏み、`IPC_UNIMPLEMENTED` reject を debugLog で収集。起動を壊す呼び出し（現時点の想定: `lint_text`→lintStore catch 済 / `codex_rebuild_matcher`→フォールバック / `list_system_fonts`→設定パネルのみ / `fts_optimize`→catch 済 / `foreshadow_load_anchors_for_scene`→Tauri ゲートで未到達）を一つずつ確認し、壊れるものがあればスタブ追加 or ガード修正。結果を本書 §11 の表に追記する。
- 検証: `pnpm test --run`（既存 79 ファイルの `@/lib/tauri` mock テストが**無変更で**通ること = ラッパー署名不変の証明）、A2 の手動版。

### S6: ウィンドウクローム

- 内容: §6 一式（drag CSS、close veto プロトコル、maximize 通知、vibrancy、メニュー、window-state 接続、macOS titleBarStyle）。
- 変更: `src/index.css`（+~8 行）、`electron/main/windows.ts`、`electron/preload/index.ts`
- 検証: 手動チェックリスト（ドラッグ移動 / ダブルクリック最大化 / ヘッダ内の全ボタン・ドロップダウンがクリック可能 / min・max・close / veto: devtools から inline-AI pending 状態を作って close→残留→解除→close 成功 / 再起動で位置サイズ復元 / Linux 実機。macOS/Windows は入手可能な範囲で、不可なら §11 の未決へ）。veto プロトコルは `electron/main` の単体テスト（タイマ満了パス含む）。

### S7: イベントバス + パネル別窓

- 内容: §7 のバス、§6.5 の panelWindow。`backend:ready`/`workspace:opened` の TSFn 配線。
- 変更: `electron/main/{events,windows,ipc}.ts`、`electron/preload/index.ts`
- 検証: 単体（allowlist 拒否 / 全窓 broadcast / 自己配信）。手動: Codex パネル別窓を開き、メイン窓でエントリ編集 → 別窓へ `codex:data-changed` が届き再 hydrate、二窓での編集ロック取り合いが収束すること。`workspace:opened` が devtools に届くこと（TSFn 実証）。

### S8: 本番ロード + スモーク自動化

- 内容: `app://` プロトコル（`protocol.handle`、dist/ 配信、Content-Security-Policy ヘッダ: 現行 CSP から `ipc: http://ipc.localhost` を除去した版）、`electron:start`、`electron/scripts/smoke.mjs`（Playwright `_electron`: 起動 → tmp workspace 作成 → シーン作成・本文入力 → 再起動 → 本文残存 assert → 終了コード）。
- 新規: `electron/main/protocol.ts`、`electron/scripts/smoke.mjs`
- 検証: `pnpm electron:build && pnpm electron:start` で A1/A2、`pnpm electron:smoke` グリーン。**リスク先行検証（任意）**: `electron-builder --dir` の最小設定で .node が asarUnpack 経由でロードできるかだけ確認し、結果を Phase 3 計画へメモ（Phase 2 の受け入れ条件には含めない）。

### S9: 受け入れ・回帰・ドキュメント

- 内容: A1〜A9 の総点検、`docs/Grimodex_Electron移行Phase2設計書.md`（本書）の commit、`docs/DEVELOPMENT_SETUP.md` へ electron:dev 手順追記、必要なら CI に **非 required** の `electron-smoke`（ubuntu-24.04: napi:build → electron:build → xvfb-run electron:smoke）ジョブ追加。
- 検証: フルスイート（`pnpm test --run` / `test:browser` / `tsc` / `lint` / cargo 一式）+ `pnpm tauri dev` 最終スモーク + /review-code 敵対レビュー。

## 9. 変更 / 新規ファイル一覧（総括）

**新規（electron/ 配下 ~20 ファイル + crate）**: §3.1 のツリー全部、`src-tauri/crates/grimodex-db/`（移動 10 ファイル + Cargo.toml）、`src/types/grimodex-bridge.d.ts`、`vitest.electron.config.ts`、`src/lib/tauri.electron.test.ts` ほかテスト数本。

**変更（既存）**:

| ファイル | 変更内容 | 規模 |
|---|---|---|
| `src/lib/tauri.ts` | isElectron + invoke/listen/emit の electron 分岐 | ~50 行 |
| `src/lib/{dialog,importFile,fs,windowControls,webviewWindows,uiScale,appInfo,opener,updater}.ts` | electron 分岐追加（各 5〜20 行） | ~100 行 |
| `src/main.tsx` | `data-shell="electron"` 属性 | ~3 行 |
| `src/index.css` | app-region マッピング | ~8 行 |
| `src-tauri/src/lib.rs` / `commands/mod.rs` / `commands/workspace.rs` / `commands/db.rs` | grimodex-db への委譲シム | ~-9,000/+150 行（移動） |
| `src-tauri/Cargo.toml` | workspace member 追加 | ~5 行 |
| `package.json` / `.gitignore` | scripts / devDeps / ignore | ~20 行 |

**触らないことを保証するファイル**: `vite.config.ts`、`tauri.conf.json`、`vitest.config.ts`、`.github/workflows/ci.yml` の required ジョブ、既存テスト全ファイル、`src/features/**`（feature 層は 1 行も変えない — Phase 1 の抽象層集約が効いている。**例外**: 最終レビュー confirmed 指摘により、パネル別窓の実行シェルゲート 4 箇所のみ `supportsPanelWindows()` へ差し替え — §6.5 の改訂注記を参照。既存テストは変更ゼロのまま、Electron 側の検証は新規テスト 3 ファイルで追加）。

## 10. テスト戦略

- **既存 8,636 件は変更ゼロで通す**（A7）。ラッパー署名（invoke/listen/emit/isTauri）不変がその機構的保証で、79 ファイルの `@/lib/tauri` vi.mock は分岐追加の影響を受けない。
- 新規: (a) ラッパー 3 分岐の happy-dom 単体、(b) electron/main 純関数の node 環境単体（allowlist / envelope / veto タイマ / windowState）、(c) napi の node:test スモーク + cargo test、(d) Playwright `_electron` の E2E スモーク（A2）。
- 手動: `docs/MANUAL_TEST_CHECKLIST.md` への追記は Phase 3 でシェル二本立てが恒常化した時点で行う（Phase 2 は S6/S7 のチェックリストを PR 説明に残す）。

## 11. リスクと未決事項（Phase 3 以降へ送る項目）

| 項目 | 分類 | 送り先 / 備考 |
|---|---|---|
| 残り 137 コマンドの napi 化（ai 9.9k / post_effect 6.4k / semantic / foreshadow / agent_writes …）と `State<T>` 残余（abort フラグ、caches、matcher）の AppState 拡張 | 計画済み | Phase 3。`IPC_UNIMPLEMENTED` の実測ログを優先順位付けに使う |
| 19 イベントチャネルの実配線（TSFn 経路は Phase 2 で実証済み） | 計画済み | Phase 3。各サブシステムの napi 化と同時 |
| ort 系（semantic）の glibc 隔離 — 別 .node かサイドカー | 方針確定・実装未 | Phase 3。第一候補 Rust 温存、純 Node（onnxruntime-node 1.24.3 固定）はフォールバック（正本 §追記） |
| lindera 同梱（+200〜250MB）の .node サイズ/起動時間影響 | リスク | Phase 3 で実測。初回コールドロードは SLOW_COMMANDS 対応済み |
| chokidar / safeStorage / queryLocalFonts / vivliostyle 子プロセス / CLI AI / export ダイアログ / MCP extraResources | 計画済み | Phase 3（main-TS or 子プロセス。napi 不要group） |
| electron-builder 全ターゲット / asarUnpack / electron-updater / ブリッジ最終 Tauri リリース / userData・keyring 移行 | 計画済み | Phase 4（S8 の `--dir` 先行実験結果を入力にする） |
| Cargo.lock 二重化による rusqlite/libsqlite3-sys 乖離 | リスク | Phase 3 CI にバージョン一致チェックを追加。Phase 2 はレビューで人力担保 |
| macOS 実機パリティ（titleBarStyle / vibrancy / 信号機位置）と Windows での napi ビルド | 未決 | 開発機が Linux のため。Phase 3 の 3OS CI で確定。S6 で可能な範囲のみ確認 |
| emit の非同期化による codexEditLock 収束タイミング差 | 低リスク | S7 で実測。問題があれば heartbeat 間隔で吸収 |
| Tauri と Electron で同一 workspace を**同時に**開く運用 | 注意事項 | busy_timeout で共存はするが非推奨。ドキュメントに明記のみ |
| `Grimodex mcp` CLI 互換（ユーザー `.mcp.json` の絶対パス固定） | 計画済み | Phase 3/4。`grimodex-mcp` スタンドアロンバイナリ同梱 + 起動契約検討（正本 §3） |
| get_license_state スタブと実 license.json の乖離（トライアル表示等） | 意図的 | Phase 3 で grimodex-core 状態機械を napi 経由に。Phase 2 は licensing 無効ビルド相当の表示になるだけ |

---

### Critical Files for Implementation

- /home/grimodex/Grimodex/.claude/worktrees/agent-a80043424221004cb/src/lib/tauri.ts — 3 分岐化の中心（invoke/listen/emit/isTauri/SLOW_COMMANDS）
- /home/grimodex/Grimodex/.claude/worktrees/agent-a80043424221004cb/src-tauri/src/commands/mod.rs — 抽出対象の state 定義（WorkspaceState/with_db_state/AppError の文字列ワイヤ契約）
- /home/grimodex/Grimodex/.claude/worktrees/agent-a80043424221004cb/src-tauri/src/commands/workspace.rs — open_workspace 本体の共通化（open_workspace_sync 抽出元）
- /home/grimodex/Grimodex/.claude/worktrees/agent-a80043424221004cb/src-tauri/src/database.rs — grimodex-db クレートへの移動起点（+ database/ 配下一式）
- /tmp/claude-1000/-home-grimodex-Grimodex/a0f7badf-e8ac-4719-895d-e3d2bd1325bd/scratchpad/napi-spike/src/lib.rs — napi 実装の実証済み雛形（db_execute の JSON 変換含む）
