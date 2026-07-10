# Grimodex Electron移行 Phase 3 設計書 — ネイティブ再結線

- 日付: 2026-07-10
- ステータス: 実装中（バッチ1〜2・バッチ3a 完了。バッチ3b〜5 は計画）
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
結果が `phase3-inventory.json`（145 コマンド）と `phase3-優先順位表.md`。

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
**ThreadsafeFunction ベースの emit ブリッジ確立**（chat 3ch → inline-ai 3ch →
cli 3ch → post_effect 4ch の順）。abort フラグ 3 種 + PostEffectAbortRegistry を
addon グローバル（OnceLock）に集約し「開始側と中止側が同一インスタンスを見る」構造を
最初に固める。**API キー平文を renderer に返さない**契約維持（`has_api_key` の bool）。
Electron 側のキー保管基盤を keyring から safeStorage へ切り替える。既存 Tauri keyring
資格情報の自動インポートは Phase 4 の userData 移行に残し、3a 単体では再入力が必要。

大きさゆえ 3a〜3e に分割する（3a = 基盤 + chat）:

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

**残り 3b〜3e**: 3b（inline-ai stream + abort + send_agent_message + 設定/接続系
save_ai_settings/list_ai_models/test_ai_connection）/ 3c（cli_ai
main-TS + child_process + NDJSON）/ 3d（post_effect run 系 + PostEffectAbortRegistry）/
3e（license network + 6h 検証ループ + before-quit ライフサイクル）。

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
before-quit のライフサイクル（vivliostyle kill_all・cleanup_temp_root・license 検証
ループ）を Electron に移植。

## 3. イベント実配線の優先順位（24ch）

優先順位表 (d) のとおり。critical（無いと機能沈黙）を先に配線する:

1. `chat:stream-*`（3）— チャット応答の唯一経路
2. `inline-ai:stream-*`（3）— インライン AI / Beat 生成
3. `external-mount://*`（4）— 外部マウント同期。全窓 broadcast 契約
4. `post_effect:done|error` — 校閲 runner の Promise 終端
5. `cli:stream-*`（3）— CLI プロバイダ（1-2 と同型）
6. `vivliostyle:done|error` — ビルド終端
7. `license:state_changed` — 稼働中の制限発動/解除
8. `semantic:model_download_progress` — **done 受信で back-index 自動再開**（機能フック）
9. progress 系（`post_effect:progress` / `semantic:reindex_progress` / `vivliostyle:log|preview-exited`）
10. `post_effect:partial` — FE 未購読、最下位

Phase 2 で `Backend.on_event(tsfn)` の end-to-end は実証済み（`backend:ready` /
`workspace:opened`）。各バッチで対応サブシステムを napi 化する際に、そのチャネルを
この TSFn 経路へ載せる。

## 4. 横断的な設計制約（バッチ共通）

優先順位表 (e) のリスクを実装制約として明文化する:

1. **共有ミュータブル状態の一体移植**: abort フラグ 3 + PostEffectAbortRegistry +
   CodexMatcherState（バッチ1c で実装済み）+ ExternalMountState + VivliostyleState +
   SemanticEmbedderState + 4 検索キャッシュ + write_lock 群。**開始側と中止側
   （read/write）が同一 AppState インスタンスを見る**ことが正しさの条件。別プロセス化・
   二重初期化は「abort が効かない」「lost update」を再発させる。
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
