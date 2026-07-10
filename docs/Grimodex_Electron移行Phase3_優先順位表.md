# Grimodex Electron 移行 Phase 3 — コマンド優先順位表と実装バッチ提案

作成日: 2026-07-10 / 正本データ: `Grimodex_Electron移行Phase3_コマンド台帳.json`（同ディレクトリ、145 コマンドの静的棚卸し + FE コールサイト分析 = IPC_UNIMPLEMENTED 実測ログの代替）/ 進捗の現在地と本表の使い方は `Grimodex_Electron移行Phase3設計書.md` を参照

---

## (a) サマリー

- **総コマンド数: 145**（lib.rs 正式リスト基準。semantic 系 19 は `semantic-embedding` feature ゲート下）
- **napi/垂直スライスで実装済み (done): 13** — db_execute / db_execute_batch / timelapse_append_batch / trash_bin×5 / get_global_settings / save_global_settings / validate_workspace_path / open_workspace / get_license_state
- **done 除外後の残数: 132**
- **棚卸し漏れ (missing): 3** — `set_window_vibrancy`（lib.rs 直定義）、`codex_rebuild_matcher`、`codex_match_text`（codex_matching モジュール）。うち codex_matching の 2 つは**編集ループの P0** なので要追加棚卸し。

### 分類別集計（145 全体）

| 分類 | 件数 | 備考 |
| --- | ---: | --- |
| done | 13 | 実装済み |
| pure-db | 68 | WorkspaceState + rusqlite のみ。最大勢力 |
| network | 12 | ai 6 / license 3 / post_effect 2 / semantic DL 1 |
| ort | 12 | ONNX 埋め込み（semantic 系） |
| fs | 10 | ai 設定 2 / external_mount 6 / fonts / list_backups |
| child-process | 10 | cli_ai 5 / vivliostyle 5 |
| main-ts | 5 | export 2 / logs / mcp_config / vivliostyle_save_output |
| lindera | 3 | lint_text / segment_bunsetsu / extract_codex_candidates |
| keyring | 3 | save/has/delete_api_key |
| db+state | 3 | restore_backup / abort_post_effect_run / seed_sample_workspace |
| other | 3 | abort フラグ 2 / external_mount_list |
| unknown（missing） | 3 | 要追加棚卸し |

### 優先度別集計（done 13 を除く 132）

| 優先度 | 件数 |
| --- | ---: |
| P0（起動・workspace-open・編集ループ致命） | 11 |
| P1（主要パネル機能） | 61 |
| P2（明示操作系） | 44 |
| P3（設定・低頻度・未使用） | 16 |

---

## (b) 優先度順の表

### P0 — 起動 / workspace-open / 編集ループで呼ばれ壊れると致命的（11）

| コマンド | 分類 | trigger | State依存 | emits | napi 化メモ |
| --- | --- | --- | --- | --- | --- |
| codex_match_text | unknown(missing) | editing-loop（打鍵 150ms debounce） | CodexMatcherState | — | **棚卸し漏れ・要精読**。最高頻度級 IPC。matcher 状態を rebuild と同一インスタンス共有 |
| codex_rebuild_matcher | unknown(missing) | editing-loop（entries hash 変化時） | CodexMatcherState / WorkspaceState(推定) | — | **棚卸し漏れ・要精読**。Aho-Corasick 再構築。SLOW_COMMANDS 300s |
| foreshadow_save_anchors_for_scene | pure-db | editing-loop（オートセーブ毎、persistSceneBody チェーン内） | WorkspaceState | — | execute_batch_tx 1回のアトミック実行必須。doc_content_size<=2 の誤孤児化ガード保持 |
| foreshadow_load_anchors_for_scene | pure-db | editing-loop（シーンオープン毎） | WorkspaceState | — | TipTap マーク camelCase キー（markName/attrs/setupId）厳守。is_orphan=0・座標<=0 スキップ保持 |
| save_post_effect_annotations | pure-db | editing-loop（保存チェーン内の注釈位置同期） | WorkspaceState | — | 現実装は非 tx ループ UPDATE — napi 化時に 1tx 化推奨 |
| external_mount_register | fs→main-ts 推奨 | startup / workspace-open | ExternalMountState + ExternalMountWatchState | external-mount://×4（watcher 経由） | notify→chokidar 再実装が自然。overlap 検査 + watcher 起動失敗時 rollback の原子性 |
| external_mount_unregister | fs→main-ts 推奨 | startup（再登録前 cleanup）+ user-action | 同上 | — | watcher close と一体。register と分離不可 |
| external_mount_write_file | fs→main-ts 推奨 | editing-loop（file-backed シーンの write-back） | ExternalMountState | — | tmp+rename アトミック書込・fsync・LF 正規化。データロス直結 |
| external_mount_read_file | fs→main-ts 推奨 | watcher-event（外部変更検知時） | ExternalMountState | — | resolve_under_root のパス検査 + 32MiB 上限（RUST-DOS-01）必須移植 |
| external_mount_file_mtime | fs→main-ts 推奨 | watcher-event | ExternalMountState | — | fs.stat toISOString で等価 |
| external_mount_scan | fs→main-ts 推奨 | watcher-event（file-added） | ExternalMountState | — | 重い walk + content_hash。register 初回スキャンと実装一本化 |

### P1 — 主要パネル機能（61）

**AI チャット / インライン AI（ai.rs + cli_ai.rs、10）**

| コマンド | 分類 | trigger | State依存 | emits | napi 化メモ |
| --- | --- | --- | --- | --- | --- |
| send_chat_message | network | user-action（チャット送信・あらすじ・タイトル生成・map/tree AI） | AiSettingsPath | — | reqwest。副次 keyring+fs。ai.rs ~5700 行の provider 分岐ごと移植 |
| send_chat_message_stream | network | user-action | AiSettingsPath + StreamAbortFlag | chat:stream-{chunk,done,error} | emit→ThreadsafeFunction 化。abort フラグを addon グローバル共有 |
| abort_chat_stream | other | user-action | StreamAbortFlag | — | 純メモリ。InlineAiAbortFlag と別インスタンス維持 |
| send_inline_ai_stream | network | user-action（インライン AI・Beat 生成） | AiSettingsPath + InlineAiAbortFlag | inline-ai:stream-{chunk,done,error} | 専用 abort フラグ。apply_inline_provider_override 等 pure helper ごと移植 |
| abort_inline_ai_stream | other | user-action | InlineAiAbortFlag | — | 純メモリ。チャットと独立 |
| send_agent_message | network | user-action（エージェント LLM ループ） | AiSettingsPath | — | ツールプロトコル層（resolve_tool_protocol・低信頼プロバイダ遮断）込み |
| get_ai_settings | fs | panel-open（ChatPanel/設定/Export/onboarding） | AiSettingsPath | — | 同期 JSON 読取。global settings とは別ファイル・別型 |
| has_api_key | keyring | panel-open | — | — | 平文キーを renderer に返さない契約維持。legacy user フォールバック込み |
| send_cli_chat_stream | child-process | user-action（CLI プロバイダ送信） | CliStreamAbortFlag | cli:stream-{chunk,done,error} | main TS + child_process/readline 再実装が適切。adapter.rs の 3 系統 NDJSON 変換が主工数 |
| abort_cli_chat_stream | child-process | user-action | CliStreamAbortFlag | — | send と一体移行。stream_id 化検討（TODO あり） |

**エージェント書込（agent_writes.rs、18）** — すべて pure-db / WorkspaceState / emits 無し / user-action（AI ツール実行・Chronicle 手動 CRUD・undo/redo）

| コマンド | napi 化メモ |
| --- | --- |
| agent_apply_undo_journal | **最重量**（event 系復元 約400行 + grimodex-core 委譲）。undo/redo 基盤なので P1 先頭で |
| agent_codex_create / agent_codex_update | BEGIN IMMEDIATE 1tx。update は楽観ロック + レーン別 spans マージ。競合エラー文言維持 |
| agent_write_bundle | db_execute_batch と同機構再利用（done 隣接）。undo/change_event ヘルパー移植 |
| agent_snippet_create | spans 全置換 + core snapshot |
| agent_propose_scene_body / agent_accept_prose_stage / agent_discard_prose_stage | prose_staging 遷移。**'not in proposed status' 文言は FE ワイヤ契約** |
| agent_foreshadow_create / agent_foreshadow_update | grimodex-core tracked writer への薄いアダプタ — 移植容易 |
| agent_event_create / update / delete / set_participants | 複合スナップショット undo + XPROJ ガード。delete はスナップショット採取→CASCADE の順序厳守 |
| agent_scene_event_link / unlink、agent_event_relation_add / remove | 各ペアは共通実装 + bool 分岐で統合可 |

**伏線パネル（foreshadow.rs、14）** — すべて pure-db / WorkspaceState / emits 無し

| コマンド | trigger | napi 化メモ |
| --- | --- | --- |
| foreshadow_list_with_labels | panel-open（パネル refresh） | 単一ロック 2 クエリを 1 コマンドのまま維持 |
| foreshadow_list_open_for_context | panel-open（チャット送信 context） | secret=0 フィルタ（秘匿伏線の AI 漏洩防止）厳守 |
| foreshadow_get_scene_info / get_scene_context | panel-open / user-action（チャット送信） | camelCase 返却キー維持 |
| foreshadow_list_by_codex_entry | panel-open（codex ForeshadowTab） | 3 段クエリ単一ロック |
| foreshadow_get_chapter_stats | panel-open | 5 クエリ + scenes に全文 content 含む — ペイロード注意 |
| foreshadow_create / update / delete / get / get_setup | user-action | update は Option<Option<T>> 3値（undefined/null 区別） |
| foreshadow_setup_create_ai | user-action | 12 引数 → payload 1 個に畳む。ON CONFLICT 部分更新維持 |
| foreshadow_update_setup / foreshadow_resolve_orphan | user-action | resolve_orphan の reinsert は tx 必須 |

**校閲・post-effect（post_effect.rs、9）**

| コマンド | 分類 | trigger | State依存 | emits | napi 化メモ |
| --- | --- | --- | --- | --- | --- |
| start_post_effect_run | network | user-action | WorkspaceState + AiSettingsPath + PostEffectAbortRegistry | post_effect:×4 | fire-and-forget + 4ch ブリッジ。panic 時フォールバック error emit 再現 |
| start_post_effect_run_multi | network | user-action | 同上 | post_effect:×4 | abort ポーリング・部分失敗着地（DB failed / FE done の非対称）に注意 |
| abort_post_effect_run | db+state | user-action | PostEffectAbortRegistry + WorkspaceState | — | start 系と同一プロセスの共有 Map 必須 |
| list_post_effect_runs / list_scene_lens_for_project / list_annotations_for_scene / list_annotations_for_project | pure-db | panel-open / editing-loop | WorkspaceState | — | scene_lens は **SQL を一字一句移植**（MAX 汚染回帰ガード） |
| update_annotation_status / reply_to_annotation | pure-db | user-action | WorkspaceState | — | JSON1 (json_set) 前提。XPROJ fail-closed |

**タイムライン（plot_threads.rs、8）** — すべて pure-db / WorkspaceState

| コマンド | trigger | napi 化メモ |
| --- | --- | --- |
| plot_thread_list / plot_thread_list_links | workspace-open（reloadProjectData） | 読み取り専用。db_execute へ寄せられる |
| plot_thread_create / update / delete | user-action | update は Option<Option> 二段 null |
| plot_thread_link_create / link_update / link_delete | user-action | **XPROJ ガード + phase 5値検証をサーバサイドに保持**（db_execute 分解は TOCTOU） |

**検索・lint（2）**

| コマンド | 分類 | trigger | napi 化メモ |
| --- | --- | --- | --- |
| fts_search | pure-db | user-action（コマンドセンター・chat recall sparse 腕・impact-review） | to_fts_match が FE の toFtsMatchQuery と同期必須。'chat' スコープは 'all' 非含有 |
| lint_text | lindera | editing-loop（ライブ lint）+ user-action（一括スキャン） | **UniDic 埋め込みで .node +200〜250MB** — 辞書外部化の判断が必要。worker 実行必須 |

### P2 — 明示操作系（44）

| コマンド群 | 分類 | trigger | napi 化メモ |
| --- | --- | --- | --- |
| semantic 系 18（index/search/reindex/status/DL/chunk_context — debug_dump 除く） | ort 12 / pure-db 5 / network 1 | workspace-open の autoIndex（fail-soft）・editing-loop の scheduler・チャット recall | ort+tokenizers を napi crate に同梱。split-lock（読出し→embed→upsert）と embedder→workspace のロック順厳守。SemanticEmbedderState / ModelDownloadState / 4 キャッシュをプロセスグローバル化。全経路 FTS 縮退ありのため P2 |
| vivliostyle 6（detect/build/abort/save_output/preview_start/preview_stop） | child-process 5 / main-ts 1 | panel-open / user-action | main TS 再実装推奨。プロセスグループ kill・generation+epoch の race 対策・before-quit の kill_all 移植 |
| ai 設定系 5（save_ai_settings / save_api_key / delete_api_key / list_ai_models / test_ai_connection） | fs / keyring / network | settings | keyring 3 点セット（save/has/delete + legacy user 対称性）を揃えて移植 |
| cli_ai 3（detect_cli_binary / test_cli_connection / list_cli_models） | child-process | panel-open / settings | main TS + which/execFile で napi 不要 |
| foreshadow 4（link_codex / unlink_codex / list_linked_codex / set_setup_strength） | pure-db | user-action / panel-open | 1 文 SQL — db_execute 代替の最有力候補群 |
| export_save_text / export_save_bytes | main-ts | user-action | dialog.showSaveDialog + fs。**PIO-2: renderer にパスを渡させない** |
| list_backups / restore_backup | fs / db+state | settings | restore は RESTORE_SESSION_LOST マーカー契約。復旧導線なので P2 上位 |
| fts_optimize | pure-db | workspace-open（fire-and-forget） | grimodex-db 薄ラッパー |
| extract_codex_candidates | lindera | panel-open | 2 フェーズ構造（DB ロック→ロック外解析）維持。normalize_name は FE candidateKey と規則一致契約 |
| segment_bunsetsu | lindera | editing-loop（並べ替え操作時のみ） | 初回辞書コールドロード。失敗時は文粒度フォールバックあり |
| seed_sample_workspace | db+state | user-action（onboarding） | 任意パス新規 DB 経路。**GlobalSettingsPath write_lock を napi 実装済コマンドと共有必須**。サンプル JSON 同梱方式の決定 |

### P3 — 設定表示・低頻度・未使用・デバッグ（16）

| コマンド | 分類 | trigger | napi 化メモ |
| --- | --- | --- | --- |
| activate_license / revalidate_license / deactivate_license | network | settings | Node fetch 化可。validate_in_flight とバックグラウンド検証サイクル（license:state_changed）を main 側で共有実装 |
| fts_rebuild / fts_rebuild_en / integrity_check / repair_integrity | pure-db | settings | grimodex-db 委譲の薄ラッパー。check/repair はペア移植 |
| get_mcp_config | main-ts | settings | MCP サーバー起動形態の決定に依存 |
| open_log_dir | main-ts | user-action | shell.openPath |
| list_system_fonts | fs | settings | fontdb を napi 側に温存（名前解決互換） |
| foreshadow_list | pure-db | unknown | FE 呼び出し元なし — dead code 判定してから |
| external_mount_list | other | unknown | dead code 疑い。main-ts 化なら自然消滅 |
| get_post_effect_run / update_relation_status | pure-db | unknown | FE ラッパー未使用。契約だけ JSON に保存済み |
| semantic_debug_dump | pure-db | settings | 開発用ダンプ。最後でよい |
| set_window_vibrancy | unknown(missing) | workspace-open（fail-soft） | Electron の BrowserWindow vibrancy/backgroundMaterial で main-ts 再実装見込み |

---

## (c) 実装バッチ提案

原則順序「純DB → AI+abort+イベント → ort/lindera → main-TS」を、**P0 の前倒し**と**依存 State・クレート抽出**の観点で 5 バッチに再構成する。

### バッチ 1: 純DB系の量産（P0 2 + P1 大半、約 60 コマンド）
- **対象**: foreshadow 21（P0 の save/load_anchors を先頭に）、agent_writes 18（apply_undo_journal を最初に設計）、plot_threads 8、post_effect の非 run 系 10、integrity 6、fts_search
- **狙い**: 全て `WorkspaceState + spawn_blocking + camelCase serde` の同型パターン。napi 実装済の db_execute / db_execute_batch と同じ `crates/grimodex-db` の with_db_state / execute_batch_tx 基盤に載るため、雛形（AsyncTask ラッパー + AppError 変換 + wire 型）を 1 つ作れば横展開できる。
- **クレート観点**: grimodex-core（undo_journal / tracked writes）への依存を napi crate に追加するのはこのバッチ。1 文 SQL 系（foreshadow_delete / link 系 / plot_thread_delete 等）は db_execute へ FE 側で寄せる選択肢もあるが、XPROJ ガード持ち（plot_thread_link_*）は必ずサーバサイド維持。
- **完了条件**: エディタ編集ループ（オートセーブ・シーンオープン・undo/redo）が Electron 上で完結。

### バッチ 2: external_mount 一族 + codex_matching（P0 残り 9、main-TS/napi 混成）
- **対象**: external_mount 7（main TS + chokidar で再実装、napi 不要見込み）、codex_rebuild_matcher / codex_match_text（**要追加棚卸し** → CodexMatcherState をプロセスグローバル化して napi 化）
- **狙い**: イベントブリッジ（main → 全窓 broadcast）の最初の実戦投入。external-mount://×4 が critical チャネルの中で最も独立していて検証しやすい。resolve_under_root のセキュリティ検査・tmp+rename アトミック書込・overlap 検査を TS へ忠実移植。
- **注意**: バッチ 1 と並行可能（依存なし）。

### バッチ 3: AI 系 — HTTP + keyring + abort フラグ + ストリームイベント（約 25 コマンド）
- **対象**: ai.rs 13（送信 4 + abort 2 + 設定 2 + キー 3 + models/test 2）、cli_ai 5（main TS 化）、post_effect run 系 3（start / start_multi / abort）、license 4（get は done、network 3）
- **狙い**: ThreadsafeFunction ベースの emit ブリッジ確立（chat 3ch → inline-ai 3ch → cli 3ch → post_effect 4ch の順）。abort 系 3 フラグ + PostEffectAbortRegistry を addon グローバル（OnceLock）に集約し、「開始コマンドと abort コマンドが同一インスタンスを見る」構造を最初に固める。
- **クレート観点**: reqwest / keyring / ai.rs 本体の移植はここに集中。キーは Rust 内で解決し**平文を JS へ返さない**構造を維持。license のバックグラウンド検証ループ（6h 周期 + license:state_changed）も main 起動時に移植。

### バッチ 4: ort / lindera 重量級（semantic 19 + lint 3、P2 中心）
- **対象**: semantic 系 19（pure-db の status/chunk_context/debug_dump 含む — spec 定数・チャンカが Rust 側にあるため一括）、lint_text、segment_bunsetsu、extract_codex_candidates
- **狙い**: ort ランタイム同梱と **UniDic 埋め込みによる .node +200〜250MB 問題の意思決定**（embed 継続 or 辞書外部ファイル化）を先に済ませてから量産。split-lock 構造・ロック順・4 検索キャッシュの invalidate ライフサイクル（workspace open 時 clear は open_workspace 実装済フックに接続）を移植。
- **注意**: 全経路 fail-soft（FTS 縮退）なのでリリースブロッカーではない。semantic:×2 progress チャネルもここで配線（model_download_progress は back-index 再開の機能フックあり）。

### バッチ 5: main-TS 残り + 周辺（P2/P3 の落ち穂拾い）
- **対象**: vivliostyle 6、export 2、open_log_dir、get_mcp_config、list_system_fonts（napi/fontdb）、seed_sample_workspace、list_backups / restore_backup、fts_rebuild / fts_rebuild_en / integrity_check / repair_integrity、set_window_vibrancy、dead code 疑い 4 件の判定（foreshadow_list / external_mount_list / get_post_effect_run / update_relation_status）
- **狙い**: ダイアログユーティリティ（PIO-2 準拠）を export と vivliostyle_save_output で共通化。before-quit の vivliostyle kill_all と起動時 cleanup_temp_root もここで。

---

## (d) イベント実配線の優先順位（listen 購読データより。確認できた全 24ch）

| 順位 | チャネル | 重要度 | 理由 |
| --- | --- | --- | --- |
| 1 | chat:stream-chunk / done / error | critical | 無いとチャットが完全沈黙・スピナー永続。invoke fire-and-forget で代替経路なし |
| 2 | inline-ai:stream-chunk / done / error | critical | インライン AI / Beat 生成の唯一の経路 |
| 3 | external-mount://file-changed / added / removed / renamed | critical | 外部マウント同期の唯一の駆動源。**全窓 broadcast 契約** |
| 4 | post_effect:done / error | critical | 校閲 runner の Promise resolve 終端契約。無いと UI 固着 |
| 5 | cli:stream-chunk / done / error | critical | CLI プロバイダ利用時のみだが同型実装なので 1-2 と同時に配線可 |
| 6 | vivliostyle:done / error | critical | ビルド終端契約（バッチ 5 と同時でよい） |
| 7 | license:state_changed | critical（fail-soft 寄り） | 稼働中の制限発動/解除。バックグラウンド検証ループ移植とセット |
| 8 | semantic:model_download_progress | progress（**機能フックあり**） | done 受信で back-index 自動再開 — 純表示ではない点に注意 |
| 9 | post_effect:progress / semantic:reindex_progress / vivliostyle:log / vivliostyle:preview-exited | progress | 無くても機能は完走。各機能バッチに同梱 |
| 10 | post_effect:partial | debug | **現状 FE 未購読**（onPartial を渡す呼び出しゼロ）。配線最下位。ipcContract.ts allowlist には収録済み |

補足: 棚卸しでは「19ch」とされたが、listen 購読データからは上記 24ch を確認（emitter がコマンド外のもの: license:state_changed）。

---

## (e) リスク・特記事項

1. **バイナリサイズ**: lint 系の embed-unidic（include_bytes!）で .node が +200〜250MB。辞書の外部ファイル化 or resources 配布をバッチ 4 の前に決定する。onboarding のサンプル JSON（include_str!）、ort モデルの resource_dir 前提も同種の同梱方式決定が必要。
2. **セキュリティ契約の維持**: (a) API キー平文を renderer に返さない（has_api_key の bool 契約）、(b) 保存系はパスをダイアログ由来に限定（PIO-2）、(c) external_mount の resolve_under_root + 32MiB 上限、(d) XPROJ ガード（plot_thread_link / post_effect / agent_event 系）をサーバサイドに残す。db_execute への安易な分解はガード消失（TOCTOU）を招く。
3. **文字列ワイヤ契約**: 'not in proposed status'（prose stage）、RESTORE_SESSION_LOST（restore_backup）、SCENE_LENS_FOR_PROJECT_SQL（一字一句移植）、to_fts_match ⇔ FE toFtsMatchQuery、normalize_name ⇔ candidateKey。回帰テストを napi 側へ持ち込む。
4. **共有ミュータブル状態の一体移植**: abort フラグ 3 種 + PostEffectAbortRegistry + CodexMatcherState + ExternalMountState/WatchState + VivliostyleState + SemanticEmbedderState/ModelDownloadState + 4 検索キャッシュ + GlobalSettingsPath/LicensePath の write_lock。**開始側と中止側（または read/write）が同一インスタンスを見る**ことが正しさの条件で、別プロセス化・二重初期化すると「abort が効かない」「lost update」系の再発バグになる。
5. **undefined/null の 3 値セマンティクス**: foreshadow/plot_threads の patch 型は Option<Option<T>>。napi 境界（JSON シリアライズ）で undefined と null の区別が落ちない受け渡し方式を雛形段階で確立する。
6. **棚卸し漏れ 3 コマンド**: codex_rebuild_matcher / codex_match_text は編集ループ P0 なのに台帳未収載。Phase 3 着手前に src-tauri/src/codex_matching.rs の精読棚卸しを行うこと。set_window_vibrancy は main-ts 化見込みで低リスク。
7. **アプリライフサイクル**: Tauri setup 相当（状態初期化順・license 検証ループ・gc_stale_model_dirs・cleanup_temp_root）と ExitRequested 時の vivliostyle kill_all を Electron の app ready / before-quit に移植。emit の「全窓配信」契約（フローティングパネル窓）を main の broadcast ヘルパーで保証する。
8. **dead code 4 件**（foreshadow_list / external_mount_list / get_post_effect_run / update_relation_status）は移植前に削除判定するとポート対象を減らせる。
