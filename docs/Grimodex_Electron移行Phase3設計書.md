# Grimodex Electron移行 Phase 3 設計書 — ネイティブ再結線

- 日付: 2026-07-10（最終更新: 2026-07-11）
- ステータス: 実装中（バッチ1〜2・バッチ3a〜3e 完了。バッチ4〜5 は計画）
- 正本: `docs/Grimodex_Electron移行検討.md`（移行判断・全体フェーズ）/ `docs/Grimodex_Electron移行Phase2設計書.md`（シェル構築）
- データ正本: `docs/Grimodex_Electron移行Phase3_優先順位表.md`（バッチ提案・イベント配線順）と `docs/Grimodex_Electron移行Phase3_コマンド台帳.json`（全 145 コマンドの静的棚卸し + FE コールサイト分析）
- 積み先: ブランチ `feat/electron-phase3`

## 0. スコープ（TL;DR）

Phase 2 で「垂直スライス 13 コマンド + イベントバス実証」までできた。Phase 3 は
**残り約132コマンドの napi / main-TS 化とイベント 24ch の実配線**を、優先順位表の
バッチ計画に沿って段階的に進める。各バッチは独立コミットで、Tauri シェルは無傷で
並走し続ける（`pnpm tauri dev` / CI / リリースは一切変えない）。

**Phase 2 との違い**: Phase 2 は「未実装は `IPC_UNIMPLEMENTED` で fail-soft」だった。
Phase 3 はその実測ログ（＝どのコマンドが起動・編集フローで呼ばれるか）を優先順位に
使う設計だったが、開発機での完全な dev 実行が難しいため、**静的コールサイト分析**
（`src` 全体の invoke / listen 棚卸し + 起動シーケンス追跡）で実測ログを代替した。
結果が `Grimodex_Electron移行Phase3_コマンド台帳.json`（145 コマンド）と
`Grimodex_Electron移行Phase3_優先順位表.md`。

## 1. コマンド分類と優先順位（要約）

全 145 コマンドの内訳（詳細は台帳 JSON / 優先順位表を参照）:

| 分類 | 件数 | napi 化方針 |
|---|---:|---|
| done | 13 | 実装済み（Phase 2 垂直スライス） |
| pure-db | 68 | `WorkspaceState + spawn_blocking + camelCase serde` の同型量産。最大勢力 |
| network | 12 | ai 6 / license 3 / post_effect 2 / semantic DL 1。reqwest を napi へ |
| ort | 12 | semantic 系。ONNX ランタイム同梱 + glibc 隔離 |
| fs | 10 | ai 設定 / external_mount / fonts / list_backups |
| child-process | 10 | cli_ai 5 / vivliostyle 5。**main-TS + child_process 再実装が適切** |
| main-ts | 5 | export 2 / logs / mcp_config / vivliostyle_save_output |
| lindera | 3 | lint_text / segment_bunsetsu / extract_codex_candidates |
| keyring | 3 | save/has/delete_api_key。safeStorage 移行 |
| db+state | 3 | restore_backup / abort_post_effect_run / seed_sample_workspace |
| other | 3 | abort フラグ / external_mount_list |

優先度別（done 13 を除く 132）: **P0=11**（起動・workspace-open・編集ループ致命）/
P1=61（主要パネル）/ P2=44（明示操作）/ P3=16（設定・低頻度・dead code 疑い）。

### 1.1 優先順位表の訂正（実装で判明した誤り）

- **codex_rebuild_matcher / codex_match_text は P0「編集ループ最高頻度」ではない**。
  棚卸し漏れ由来の推定で、実際の FE コールサイトは `findMentionedEntriesAsync` の
  ワンショット呼び（打鍵ごとの高頻度 IPC ではない）。JS フォールバックでも機能的に
  正しく動くためリリースブロッカーではないが、大シーンの体感速度のためバッチ1c で
  Rust パスを有効化した（下記）。
- **イベントは 19ch ではなく 24ch**（listen 購読データ実測）。`post_effect:partial` は
  FE 実質未購読（配線最下位）。`license:state_changed` は emitter がコマンド外。

## 2. 実装バッチ（優先順位表 (c) を実装単位に再構成）

### バッチ 1: 純DB系 + 共用クレート抽出【完了】

Phase 2 で確立した「`with_db_state` + `run_blocking` + JSON 文字列返し」雛形を
横展開する。`grimodex-lint` / `grimodex-core` / 新設 `grimodex-fonts` への依存を
napi crate に足すのもこのバッチ。

**完了済み**:

| コミット | 内容 |
|---|---|
| バッチ1a | `integrity_check` / `repair_integrity` / `fts_optimize` / `fts_rebuild` / `fts_rebuild_en` / `fts_search`（grimodex-db 共用、コード移動なし）|
| バッチ1b | `lint_text` / `segment_bunsetsu`（grimodex-lint、UniDic 埋め込み）/ `list_system_fonts`（`grimodex-fonts` へ commands/fonts.rs を抽出）|
| バッチ1c | `codex_rebuild_matcher` / `codex_match_text`（`grimodex-core::codex_matching` へ codex_matching.rs のコアを抽出、AppState に matcher State 追加）|
| バッチ1d | plot_threads 8（`grimodex-db::plot_threads` へ抽出、XPROJ ガードを Electron 経路にも復活）|
| バッチ1e | foreshadow 20（`grimodex-db::foreshadow` へ抽出。`foreshadow_list` は FE 到達不能のため対象外）|
| バッチ1f | agent_writes 18 + post_effect pure-db 7（tracked write / XPROJ ガードをサーバー側に維持。dead 2件は対象外）|
| （前提）| fs ブリッジのダイアログ許可制スコープ化（`electron/main/fsScope.ts`）、`export_save_text` / `export_save_bytes` / `open_log_dir`（main-TS）|

`get_post_effect_run` / `update_relation_status` は FE 到達不能、post_effect の run/abort/AI
経路はバッチ3dへ送った。XPROJ ガード持ち（plot_thread_link_* / post_effect /
agent_event）は db_execute へ分解せず、共有 Rust 層に維持している。

### バッチ 2: external_mount 一族（P0 残り、main-TS + chokidar）【完了】

`external_mount_*` 7 コマンドは Rust の `notify` watcher に依存する。napi へ持ち込む
より **main-TS + chokidar で再実装**した（fs 監視は Node の領分）。`external-mount://`
×4 イベントは main → 全窓 broadcast（Phase 2 のイベントバスの最初の実戦投入）。
`resolve_under_root` のパス検査・tmp+rename アトミック書込・32MiB 上限（RUST-DOS-01）・
overlap 検査を TS へ忠実移植。バッチ1 と依存なしで並行可。

実装（ブランチ `feat/electron-phase3-batch2-external-mount`）:

- `electron/main/externalMountFs.ts`（純 Node）: io/path/scan/hash +
  `reject_unsafe_workspace_path`（PIO-1 / is_system_directory）を忠実移植。
  実 fs 単体テストで traversal・symlink escape・overlap 境界・32MiB 上限・
  depth/件数/バイト上限・CRLF 正規化を gate。
- `electron/main/externalMount.ts`（ステート機械）: registry + overlap + rollback +
  chokidar watcher + 500ms debounce + broadcast。`ExternalMountManager` を index.ts で
  1 個生成し、その shell ハンドラを invoke ルーターへ merge（`registerIpcRouter` の
  `extraShellHandlers`）。`will-quit` で `disposeAll`。
- **FE / preload 変更ゼロ**: `features/external-mount/api.ts` は `invoke` を無条件呼び
  （`isTauri()` ゲート無し）、event は allowlist 駆動の汎用バス経由で 4ch とも既登録。
- **dead code**: `external_mount_list` は FE 到達不能（`listRegisteredMounts` に live
  caller 無し）のため移植せず IPC_UNIMPLEMENTED に落とす（バッチ1f の dead-code 方針と一致）。

**chokidar 設定と notify との差分**（詳細は externalMount.ts 冒頭コメント）:

- `ignoreInitial: true` 必須（初期一覧は register が返す scan で渡す。無いと既存 .md 洪水化）。
- `followSymlinks: false`（Rust の symlink 非追従と一致）。
- `atomic: false` 必須（chokidar 既定 true をあえて無効化）。`atomic` は unlink を遅延させ
  rename で **add が unlink より先**に届く。FE の rename 再構成（`mountManager.ts` の
  content-hash + `recentDeletes`）は removed→added 順で初めて node identity を保つため、
  inotify 由来の unlink→add 順を素通しさせる。Grimodex 自身の atomic writeback は FE 側
  `isMuted` 済みなので畳む必要なし。
- **native `renamed` は main から emit しない**。unlink+add の時間ペアリングは content 照合
  なしでは無関係な delete+create を誤ペア化する data-integrity リスクのため不採用。FE の
  content-hash 照合が安全な担当層。既知差分 2 件（純粋 rename は差分なし）:
  ① dirty rename で `fileDeletedExternally` 警告トースト 1 回、
  ② 「外部編集 → 取り込み前に同ファイル rename」の競合で hash 不一致 → 新ノード作成 +
     旧ノード archive（本文は無事だが node identity リセット）。稀な編集直後 rename のみ。
- 実 chokidar 統合テスト（`externalMount.integration.test.ts`）で ignoreInitial・
  add/change/unlink 写像・rename の removed→added 順（厳密順序 assert は inotify=linux 限定、
  macOS fsevents / Windows は Phase 4 実機検証）を gate。

### バッチ 3: AI 系 — HTTP + keyring + abort + ストリームイベント

ai.rs 13 / cli_ai 5（main-TS 化）/ post_effect run 系 3 / license network 3。
ストリームイベントは chat / inline-ai / post_effect を napi の ThreadsafeFunction、CLI を
main 常駐 manager から既存の全窓 broadcast へ載せる。abort 状態は chat / inline-ai を
`Backend` AppState、CLI を main manager、post_effect を `PostEffectAbortRegistry` に保持し、
いずれも「開始側と中止側が同一インスタンスを見る」構造を固める。**API キー平文を
renderer に返さない**契約維持（`has_api_key` の bool）。
Electron 側のキー保管基盤を keyring から safeStorage へ切り替える。既存 Tauri keyring
資格情報の自動インポートは Phase 4 の userData 移行に残し、3a 単体では再入力が必要。

大きさゆえ 3a〜3e に分割する（3a = 基盤 + chat、3b = inline / agent +
設定・モデル・接続、3c = CLI AI）:

#### バッチ 3a: grimodex-ai 抽出 + emit 抽象化 + chat ストリーム【完了】

ブランチ `feat/electron-phase3-batch3a-ai-chat`。

- **クレート抽出**: `ai.rs`(6772) + `ai_responses.rs` + `ai_novelist.rs`（計9006行）を
  `crates/grimodex-ai` へ移設。**AI クラスタは高度に自己完結**（外部依存 reqwest/keyring/
  futures/serde/anyhow のみ、grimodex_db にも他 src-tauri にも非依存）。Tauri 結合点は
  `send_chat_stream`(lib.rs) と `ai_responses::send_stream` の emit だけ。
- **emit 抽象化**: `emit::StreamEmitter { fn emit(&self, channel: &str, payload: Value) }`
  trait（`Send + Sync`）。Tauri=`TauriEmitter(AppHandle)` アダプタ（src/ai.rs shim）/
  napi=`EventQueue`（既存 EventSink → TSFn → 全窓 broadcast にそのまま載る）。src-tauri は
  `src/ai.rs = pub use grimodex_ai::*;` の re-export shim で `crate::ai::*` パスを温存
  （`crate::ai_responses`/`crate::ai_novelist` は非参照になり mod 宣言ごと削除）。
- **keyring は cargo feature**: save/get/delete_api_key + keyring_user/candidates/service を
  `#[cfg(feature="keyring")]` でゲート。src-tauri は `features=["keyring"]`、grimodex-node は
  無効。**実測: .node に libsecret 依存なし**（safeStorage 方針の実効性を ldd で確認）。
- **純ヘルパー共用**: `apply_provider_override`（chat/inline/agent の override は同一と判明し
  1 関数に統一）/ `build_chat_params` / `build_ai_novelist_extra_body` / `should_retry_429` /
  `inline_effective_variant` を crate の `params` モジュールへ移し、Tauri コマンドと napi が同一
  ロジックを共有（テストも移設）。
- **napi**: Backend に `get_ai_settings` / `send_chat_message` / `send_chat_message_stream` /
  `abort_chat_stream`。**キーは注入**: main の safeStorage で解決した平文キーを第3引数
  （`args, settings, apiKey`）で渡す（napi は keyring を触らない）。AppState に
  `chat_abort`(Arc<AtomicBool>) と `ai_settings_path`。
- **キー保管 = safeStorage**（設計書当初案どおり、ユーザー判断 2026-07-11）: `aiKeyNaming.ts`
  （service/account 命名 + resolve 規則の純関数移植、Tauri と一致）+ `keyStore.ts`
  （safeStorage 暗号化 + `ai-keys.json` を tmp+rename で原子的に永続化）。has/save/delete は
  shell ハンドラ、チャットのキー解決は dispatchInvoke に `secrets` を注入し、送信直前に
  実効 provider/endpoint（`effectiveProviderEndpoint`）→ 平文を napi へ渡す。破損・復号失敗は
  fail-closed（既存ファイルを空扱いして上書きしない）、Linux の `basic_text` / `unknown`
  backend は拒否する。Tauri keyring からの自動移行は Phase 4 の出荷ゲート。
- **FE 変更ゼロ**（AI 系は `@/lib/tauri` の invoke/listen に委譲、プラットフォームゲートなし）。
  イベント allowlist も既登録。ipcContract のコマンド表追加のみ。
- 検証: cargo test 全通過（grimodex_lib 408 / grimodex_ai 203）、mjs 56pass + 1skip
  （新 chat.test.mjs で実 HTTP モックの非stream/Authorization注入/override/chunk/done/error/
  実abortを end-to-end gate）、electron 300pass、tsc通過、lint 0 errors
  （既存warning 42件）、FE 8710pass 回帰なし。

#### バッチ 3b: inline / agent + AI 設定・モデル・接続【完了】

ブランチ `feat/electron-phase3-batch3b-ai-inline-agent`。

- **napi 6 コマンド**: `send_inline_ai_stream` / `abort_inline_ai_stream` /
  `send_agent_message` / `save_ai_settings` / `list_ai_models` /
  `test_ai_connection`を Backend と IPC コマンド表に追加。`grimodex-ai` の
  provider / HTTP / SSE / Responses / AI のべりすと分岐を Tauri と共用する。
- **inline 専用 abort + 3ch**: AppState に chat と独立した
  `inline_ai_abort: Arc<AtomicBool>` を保持し、`inline-ai:stream-{chunk,done,error}` を
  EventQueue → ThreadsafeFunction → 全窓 broadcast へ接続。chat / inline の同時実行中に
  inline だけを中止でき、HTTP 失敗では `stream-error` emit と invoke reject の
  両経路を維持する。
- **Agent ワイヤ + 安全策**: camelCase の tool 定義・tool 履歴・`tool_result` /
  thinking / web search を `AgentMessage` / `AgentToolDef` へ復元し、
  `send_chat_with_tools` を共用。OpenAI 互換など低信頼 provider から返った
  mutating tool call を破棄し、read-only tool だけを通す既存の防御を保つ。
- **設定・モデル・接続**: `save_ai_settings` は 3a の
  `get_ai_settings` と同じ `<userData>/ai-settings.json` で round-trip。
  `list_ai_models` は OpenAI 互換 endpoint override と、空キー時に
  Authorization ヘッダを付けないローカル LLM 契約を維持。
  `test_ai_connection` は provider / endpoint / model / API variant の override と
  応答文字列を Tauri と同形で返す。
- **safeStorage キー注入の原子性**: main が AI 設定を1回だけ読み、
  同じ snapshot を safeStorage の実効 provider / endpoint キー解決と napi 呼び出しに
  渡す。inline / agent / connection test は必須キー解決、model list だけは
  Tauri の `get_api_key(...).unwrap_or_default()` と同じ optional 解決（未登録は
  空文字）。キーストア破損・復号失敗は fail-closed で伝播し、平文キーを
  renderer に返さない。
- **FE 変更ゼロ**: AI 機能は既存の `@/lib/tauri` invoke / listen 抽象と
  登録済み event allowlist をそのまま使う。Electron 固有分岐は追加しない。
- **検証（2026-07-11 時点）**: Electron は 15 files / 312 tests、FE は
  856 passed + 7 skipped files / 8710 passed + 34 skipped tests、native E2E は
  63 total / 62 pass / 1 skip、Rust node crate は 9 pass、Tauri 本体は 408 pass、
  `grimodex-ai` は 201 pass。Electron production build、両 TS typecheck、
  `cargo clippy --all-targets`、lint 0 errors（既存 warning 42件）も通過。

#### バッチ 3c: CLI AI main-TS + child process【完了】

- **main-TS 5 コマンド**: `detect_cli_binary` / `test_cli_connection` /
  `list_cli_models` / `send_cli_chat_stream` / `abort_cli_chat_stream` を
  `electron/main/cliAi.ts` の常駐 manager として実装し、shell command ルーターへ登録した。
  プロセス起動は `cross-spawn@7.0.6`、常時 `shell: false` とし、prompt / model は文字列連結
  せず独立 argv で渡す。
- **検出と実行ファイルの信頼境界**: CLI kind は `claude|codex|opencode` の固定 enum に限定。
  GUI 起動時に PATH を失うケースに備え、Unix の login shell / version manager / 既知配置と
  Windows の `where.exe` / PATH / 既知配置 / PowerShell を順に探索する。自動検出 path は
  main が `realpath` + regular file を検査して session 中だけ信頼する。手入力 path は kind と
  basename、絶対 path、regular file を検査し、canonical target を表示する native dialog で
  明示許可された場合だけ session allowlist へ入れる（既定 / cancel は拒否）。Windows の
  network / device path は slash を正規化して `realpath` の前後で拒否する。symlink は
  ユーザー設定用の requested path を FE へ返す一方、許可判定と spawn には canonical target
  を使う。自動検出中の current path と手動 grant は別管理し、refresh が null なら旧自動検出
  cache / trust を削除する。Windows の手動 grant も canonical path を lowercase せず完全一致で
  比較し、case-sensitive directory の大小文字を混同しない。並行 refresh は CLI kind ごとの
  generation / epoch で直列化し、refresh 開始時に auto cache を無効化する。detect / `realpath`
  の await 後も最新世代だけが cache を commit / delete でき、stale 世代はその時点の current
  result（無ければ null）を返して古い path を復活させない。
- **3系統 NDJSON adapter**: `electron/main/cliAdapters.ts` に Claude / Codex / OpenCode の
  累積 text 差分、thinking、usage / stop reason 変換を分離した。壊れた JSON / 未知 event は
  fail-soft で無視する。stream の raw stdout は 1 行 1MiB / 合計 64MiB / 10,000 行、
  renderer へ emit する delta は合計 8MiB、短時間 capture は合計 4MiB、stderr tail は
  64KiB に制限する。main 側 290 秒 deadline は send 受付時に開始し、PATH 検出 / `realpath` /
  native authorization の時間も含む絶対期限とした。pre-spawn で期限を越えた場合は child を
  起動しない。
- **single-flight + abort**: 同時に許可する CLI stream はアプリ全体で 1 本だけとし、2 本目は
  `CLI stream is already running` で明示拒否する。path 解決 / 許可待ち中の abort も保持し、
  child を spawn せず `stop_reason: stopped` へ着地する。通常 abort は active child を即
  `SIGTERM`、2 秒後も残れば `SIGKILL`。`will-quit` は TERM 直後に KILL し、capture / stream
  の全 child を追跡する runner も一括 dispose する。Unix は process group、Windows の終了時は
  同期 `taskkill.exe /T /F` で子孫を残さない。manager / runner は disposed latch を持ち、
  終了開始後は send だけでなく detect / test / list / abort を含む全 handler と run / start を
  fail-closed にして新しい child を作らない。
- **専用 3ch + 安全既定**: `cli:stream-{chunk,done,error}` を main から全窓 broadcast。
  Claude は tools 無効、Codex は read-only sandbox、OpenCode は全 permission deny とし、
  spawn / 非ゼロ終了 / 出力上限エラーは error event と invoke reject の両経路を維持する。
- **FE 契約**: 既存 invoke / listen 署名は維持し、CLI コメントの誤った `chat:stream-*` 記載を
  実イベント名へ訂正。browser mock と Electron shell command 表も 5 コマンドへ同期した。
  同じ失敗が `cli:stream-error` と invoke reject の両方から届いても `onError` は 1 回だけ呼ぶ。
  native authorization 待ちを含む `test_cli_connection` も FE の SLOW 300 秒枠に登録した。
- **敵対的レビュー**: 初回 7 回帰（無許可 path / spawn 前 abort / raw 総量・行数 /
  deadline / child 回収 / error dedupe）を赤固定して修正。続けて UNC 正規化・send 開始基準の
  absolute deadline・disposed manager / runner・FE slow timeout の 5 回帰を別コミットで固定し、
  Windows grant の case と auto-detect refresh cache の 2 回帰、並行 refresh race の 1 回帰も
  追加した（計 15）。
- **起動スモーク hardening**: transparent + `show:false` の窓で `ready-to-show` が来ない環境も
  `did-finish-load` を冪等 fallback にして確実に表示する。startup hydration 中だけ layout
  crossfade / region chrome / editor の enter animation を抑止して最終 opacity=1 を即時表示し、
  初期化後のユーザー操作では従来の motion が復帰することをテストで固定した。
- **検証（2026-07-11 時点）**: Electron は 17 files / 345 passed、FE node は
  861 passed + 8 skipped files / 8,809 passed + 35 skipped tests、browser は
  73 passed + 1 skipped files / 309 passed + 1 skipped tests。CLI manager 単体は 24 tests。
  Electron / root の両 TypeScript typecheck、変更 TS lint、full lint 0 errors
  （既存 warning 42件）も通過。
  repo 外の一時 `claude` を `tsx` harness から起動する**手動 CLI fixture smoke**で、
  `--version`=`claude-fixture 1.0.0`、chunk=`fixture-ok`、done=`end_turn`（input 2 /
  output 1）、abort done=`stopped` を再確認した（adapter smoke 自体は自動テスト未収録）。
  別途、Node の実 child（`process.execPath`）を起動し、stdout readiness に依存せず 100ms 後の
  `runner.disposeAll()` で回収する portable lifecycle テストは Electron suite に自動収録した。
  `pnpm electron:build` と `pnpm electron:smoke` も通過し、3 回の起動すべてで全 layout layer の
  opacity=1、シーン作成 → autosave → 再起動後の DB / UI 残存を確認した。

#### バッチ 3d: post-effect runner + abort + 4イベント【完了】

- **共有crate化**: parser / annotation / 各effect runner / AI client境界 / abort registryを
  `grimodex-post-effect` へ集約し、Tauri側を薄いadapterへ縮小した。Electronは
  `NodePostEffectRuntime` / `NodePostEffectAiClient` だけを持ち、同じ実行本体を呼ぶ。
- **3コマンド + 4ch**: `start_post_effect_run` / `start_post_effect_run_multi` /
  `abort_post_effect_run` と `post_effect:{progress,partial,done,error}` をN-APIの
  EventQueueへ接続。cache hitはAI・資格情報・イベントを再実行しない。
- **資格情報境界**: mainがAI設定を1 snapshotだけ読み、safeStorageのkey値またはlookup
  errorをnativeへ渡す。role系effectだけmodel/provider/endpoint overrideを使い、typo /
  intra / metaはdefault設定を維持する。平文keyはrendererへ返さない。
- **競合とproject境界**: target/sceneのXPROJ検査をINSERT/AIより前に実行する。開始時の
  `Arc<Database>`をworkerとabort registryへ固定し、workspace A→B切替後もAのrunだけを
  完走/中止する。abort要求とDB terminal CASを同じregistry lock内で線形化し、cancelledを
  completedで上書きしない。terminal永続化に失敗した場合は誤ったdoneを送らずerrorへ落とす。
- **検証**: 共有Rust 103 tests、native Rust 11 tests、実 `.node` のpost-effect E2E 5 testsを
  含むnative 70 pass + 1 skip。workspace切替、wrong-project abort、終端CAS、secret error、
  cache、role routingを回帰固定した。

#### バッチ 3e: license network + 6h検証ループ【完了】

- **共有crate化**: DTO / license.jsonのatomic read-modify-write / Polar client / single-flight /
  stale-response guardを `grimodex-license` に集約し、Tauriは53行のcommand adapterへ縮小。
  通常buildはfeature無効、v1/v2 releaseだけ `licensing` featureを明示的に有効化する。
- **常設IPC**: feature無効でも `get/activate/revalidate/deactivate` と内部
  `runLicenseValidateCycle` は常にexportする。getはexact disabled DTO、write 3件は同じ
  明示error、backgroundはnullを返し、いずれも `license.json` に触れない。
- **周期処理**: Electron mainで起動5秒後に初回、そのcycle完了から6時間後に次回を予約する。
  重複実行を防ぎ、DTOが返った場合だけ `license:state_changed` を全窓broadcastする。
  `will-quit`でdisposeし、in-flight完了後のemit/rescheduleも抑止する。
- **レビューhardening**: manual activate/revalidate/deactivateの成功DTOと、revalidate失敗後の
  current DTOも全窓へ同期する。Polar 3コマンドは外側IPCを300秒枠にしてnativeの15秒HTTP
  timeoutより先にUIだけ失敗しない。activateはsingle-flight化し、benefit不一致またはlocal
  persist失敗では作成済みremote activationを補償解除する（file lockはawait前に解放）。
- **検証**: 旧Polar/DTO 27 tests、licensing有効runtime/race 19 tests、無効build 1 test、
  Electron 18 files / 401 tests、実 `.node` native 70 pass + 1 skip。N-API release build、
  TypeScript typecheck、Rust check/clippy（feature有効/無効）も通過。

### バッチ 4: ort / lindera 重量級

semantic 19 + extract_codex_candidates。**embed-unidic による .node +200MB 問題の
意思決定**（辞書埋め込み継続 or 外部ファイル化）を先に済ませる。バッチ1b で
lint_text/segment_bunsetsu を入れた時点で `.node` は 4.2MB → 211MB に増えている
（実測）。ort ランタイム同梱・split-lock 構造・ロック順・4 検索キャッシュの
invalidate ライフサイクル（open_workspace の on_swapped フックに接続）を移植。
全経路 fail-soft（FTS 縮退）なのでリリースブロッカーではない。

### バッチ 5: main-TS 残り + 周辺

vivliostyle 6 / mcp_config / seed_sample_workspace / list_backups / restore_backup /
fts_rebuild 系 / set_window_vibrancy / dead code 疑い 4 件の判定。app ready /
before-quit の残りライフサイクル（vivliostyle kill_all・cleanup_temp_root）を Electron に移植。

## 3. イベント実配線の優先順位（24ch）

優先順位表 (d) のとおり。critical（無いと機能沈黙）を先に配線する:

1. `chat:stream-*`（3）— チャット応答の唯一経路（バッチ3aで配線済み）
2. `inline-ai:stream-*`（3）— インライン AI / Beat 生成（バッチ3bで配線済み）
3. `external-mount://*`（4）— 外部マウント同期。全窓 broadcast 契約（バッチ2で配線済み）
4. `post_effect:done|error` — 校閲 runner の Promise 終端（バッチ3dで配線済み）
5. `cli:stream-*`（3）— CLI プロバイダ（バッチ3cで main → 全窓 broadcast 配線済み）
6. `vivliostyle:done|error` — ビルド終端
7. `license:state_changed` — 稼働中の制限発動/解除（バッチ3eで配線済み）
8. `semantic:model_download_progress` — **done 受信で back-index 自動再開**（機能フック）
9. progress 系（`post_effect:progress` は3dで配線済み / `semantic:reindex_progress` /
   `vivliostyle:log|preview-exited`）
10. `post_effect:partial` — バッチ3dで配線済み（FEは現状未購読）

Phase 2 で `Backend.on_event(tsfn)` の end-to-end は実証済み（`backend:ready` /
`workspace:opened`）。napi 化するサブシステムはこの TSFn 経路へ載せ、main-TS 実装は
同じ `broadcastEvent` を直接呼ぶ（external_mount / CLI で実証済み）。

## 4. 横断的な設計制約（バッチ共通）

優先順位表 (e) のリスクを実装制約として明文化する:

1. **共有ミュータブル状態の一体移植**: chat / inline の abort フラグと CLI の single-flight
   active child manager（いずれも実装済み）+ PostEffectAbortRegistry +
   CodexMatcherState（バッチ1c で実装済み）+ ExternalMountState + VivliostyleState +
   SemanticEmbedderState + 4 検索キャッシュ + write_lock 群。**開始側と中止側
   （read/write）が同一 AppState または main manager インスタンスを見る**ことが正しさの
   条件。別プロセス化・二重初期化は「abort が効かない」「lost update」を再発させる。
2. **文字列/object ワイヤ契約**: `WORKSPACE_SWITCHING` / `No workspace is open`（文字列、
   convert.rs で保存済み）、`not in proposed status`（prose stage）、`RESTORE_SESSION_LOST`、
   `SCENE_LENS_FOR_PROJECT_SQL`（一字一句）、`to_fts_match` ⇔ FE `toFtsMatchQuery`、
   `normalize_name` ⇔ `candidateKey`。**lint_text の LintError は object（`{type,data}`）で
   reject する唯一のコマンド**で、envelope の `errorValue` 経由で復元する（バッチ1b で実装）。
   回帰テストを napi 側へ持ち込む。
3. **セキュリティ契約**: API キー平文を返さない / 保存系はパスをダイアログ由来に限定
   （PIO-2、export で実装済み）/ fs ブリッジはダイアログ許可スコープ（実装済み）/
   external_mount の resolve_under_root + 32MiB 上限 / XPROJ ガードをサーバサイドに残す。
4. **undefined/null の 3 値**: foreshadow / plot_threads の patch 型は `Option<Option<T>>`。
   napi 境界（JSON）で undefined と null の区別が落ちない受け渡しを雛形段階で確立する。
5. **バイナリサイズと同梱**: embed-unidic（+200MB）/ onboarding サンプル JSON / ort モデルの
   同梱方式をバッチ 4 前に決定。electron-builder の asarUnpack は Phase 4。
6. **FE 実行シェルゲート**: feature 層の `__TAURI_INTERNALS__` / `isTauri()` ローカル判定は、
   対応コマンドが napi に載ったバッチで `isTauri() || isElectron()` 形のヘルパ
   （`supportsPanelWindows` / `supportsTrashBin` / `supportsNativeExport` /
   `supportsNativeMatcher`）へ 1 ファイルずつ切り替える。

## 5. dead code 判定（移植前に削除でポート対象を減らす）

FE コールサイト無し 4 件: `foreshadow_list` / `external_mount_list` /
`get_post_effect_run` / `update_relation_status`。移植前に削除判定する。

## 6. Phase 4 への申し送り

electron-builder 全ターゲット（.node の asarUnpack）/ electron-updater + 署名 /
**ブリッジ最終 Tauri リリース**（既存ユーザーの自動移行、tauri 形式 latest.json の
永続同梱）/ userData・keyring→safeStorage 移行 / v2.0.0。詳細は正本 §Phase 4。
