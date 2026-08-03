# Grimodex 統合DBスキーマ

## 概要

全設計書に散在するDBスキーマ定義を説明用に統合した資料。**実行時の物理スキーマの正本は
`src-tauri/crates/grimodex-db` の migration** であり、この文書は schema contract から
生成・更新される概要資料として扱う。個別設計書のSQLは参考であり、実行時の正本ではない。

物理スキーマの構造契約は [`src/db/generated/schema-contract.json`](../src/db/generated/schema-contract.json)
に出力する。更新コマンドは `pnpm generate:db-contract`、authority の詳細は
[`ADR 003`](adr/003-db-authority-and-schema-contract.md) を参照する。

データベース: SQLite（WALモード有効）
ORM: Drizzle ORM（sqlite-proxy）
ファイル: `grimodex.db`

---

## テーブル一覧

| テーブル | 種別 | 定義元 | 説明 |
|---------|------|--------|------|
| `projects` | 通常 | Settings | プロジェクトのメタ情報 |
| `tree_nodes` | 通常 | Scenes | Folder/Scene/Note の統一ツリー |
| `codex_types` | 通常 | Codex | Codexエントリタイプ定義（ビルトイン+カスタム） |
| `codex_entries` | 通常 | Codex | 世界設定エントリ |
| `codex_dismissed_relations` | 通常 | Codex | リレーション提案のDismiss記録 |
| `codex_tags` | 通常 | Codex | 構造化タグ定義（タイプ関連付け付き） |
| `codex_entry_tags` | 通常 | Codex | エントリ↔タグの多対多リレーション |
| `codex_detail_definitions` | 通常 | Codex | カスタムディテール定義（タイプごと） |
| `codex_detail_values` | 通常 | Codex | カスタムディテール値（エントリごと） |
| `codex_entry_phases` | 通常 | Codex | Codexエントリの経時的変化（フェーズ） |
| `codex_phase_detail_overrides` | 通常 | Codex | フェーズごとのカスタムディテールオーバーライド |
| `codex_quick_pins` | 通常 | Codex | クイックピン永続化 |
| `labels` | 通常 | Scenes | プロジェクトスコープのカラーラベル定義 |
| `tree_node_labels` | 通常 | Scenes | ツリーノード↔ラベルの多対多リレーション |
| `snippets` | 通常 | Snippets | 再利用テキスト断片 |
| `snippet_entry_tags` | 通常 | Snippets | Snippet↔タグの多対多リレーション |
| `chat_sessions` | 通常 | Chat | チャットセッション（シーン or プロジェクトスコープ） |
| `chat_session_pinned_codex` | 通常 | Chat | セッションごとのピン留め Codex/Snippet |
| `chat_messages` | 通常 | Chat | チャットメッセージ |
| `chat_summaries` | 通常 | Chat | プログレッシブ要約 |
| `chat_summary_messages` | 通常 | Chat | 要約のソースメッセージ集合 |
| `content_versions` | 通常 | Editor | コンテンツのリビジョン履歴 |
| `project_snapshots` | 通常 | Editor | プロジェクト全体のプロジェクトスナップショット |
| `project_snapshot_entries` | 通常 | Editor | プロジェクトスナップショットとリビジョンの紐付け |
| `authorship_spans` | 通常 | Editor | AI帰属追跡スパン |
| `app_settings` | 通常 | Settings | アプリ全体のKey-Value設定ストア |
| `project_settings` | 通常 | Settings | プロジェクトごとのKey-Value設定ストア（将来拡張用） |
| `codex_fts` | FTS5仮想 | Codex | Codexエントリの全文検索 |
| `snippets_fts` | FTS5仮想 | Snippets | Snippetの全文検索 |
| `chat_messages_fts` | FTS5仮想 | Chat History | チャットメッセージの全文検索 |
| `tree_nodes_fts` | FTS5仮想 | Scenes | ツリーノードの全文検索 |
| `map_boards` | 通常 | Map | Mapボード（v1は単一ボード固定） |
| `map_stickies` | 通常 | Map | Mapの付箋ノード（ProseMirror本文付き） |
| `map_ai_branches` | 通常 | Map | Map AI生成ブランチ（プロンプト+シードノード） |
| `map_node_positions` | 通常 | Map | ノードのボード上位置情報（Scene/Codex/Snippet/Note/Sticky/AI BranchのポリモーフィックFK） |
| `map_edges` | 通常 | Map | ユーザー描画エッジ（双方向ラベル対応） |
| `map_frames` | 通常 | Map | フレーム（グループ化矩形） |
| `lint_ignored_diagnostics` | 通常 | Lint | Lint診断の永続的無視リスト |
| `lint_term_dictionary` | 通常 | Lint | プロジェクトスコープの用語辞書（表記ゆれ検出） |
| `lint_action_log` | 通常 | Lint | Lintアクション履歴（自己チューニング用イベントログ） |
| `foreshadows` | 通常 | Foreshadow | 伏線レジスタ（payoff-anchored） |
| `foreshadow_setups` | 通常 | Foreshadow | 伏線の撒きアンカー |
| `foreshadow_codex_links` | 通常 | Foreshadow | 伏線↔Codexエントリのリレーション |
| `plot_threads` | 通常 | Timeline | 名前付きプロットスレッド（Plottr 型・レーン見出し）。`threads` ビューモードのレーン |
| `plot_thread_scene_links` | 通常 | Timeline | プロットスレッド × シーンの段階マーカー（`phase_type` CHECK enum: introduce/develop/turn/climax/resolve） |
| `scene_codex_pins` | 通常 | Matrix / Grid | シーン × Codex の明示的リレーション（Pin to scene の保存先） |
| `scene_codex_mentions` | 通常 | Matrix | シーン × Codex の言及スキャンキャッシュ（source 別: body/beat/relation、role: mentioned/actor/target） |
| `scene_beat_pov_cache` | 通常 | Matrix / Beat | Beat レベル POV キャラクターの集約キャッシュ |
| `post_effect_runs` | 通常 | PostEffects | AI ポストエフェクトの実行単位（review / pseudo_comment / meta_structure / consistency / intra_scene_consistency / typo_detection / intent_drift / timeline_consistency / impact_review） |
| `post_effect_annotations` | 通常 | PostEffects | ポストエフェクトの注釈成果物（シーン範囲・カテゴリ・親子スレッド対応） |
| `post_effect_annotation_relations` | 通常 | PostEffects | 注釈間の関係（contradiction / foreshadowing / theme_echo） |
| `post_effect_annotations_fts` | FTS5仮想 | PostEffects | 注釈 content の全文検索 |
| `scene_lens_data` | 通常 | PostEffects | シーン単位のレンズ計測結果（plot_structure / pacing / character_arc / pov） |
| `trash_items` | 通常 | Trash | 物理ゴミ箱（削除されたテキスト断片および構造アイテム） |
| `impact_review_baselines` | 通常 | PostEffects | impact-review（Codex変更→本文矛盾の逆引き）の差分基準スナップショット（1エントリ1行） |
| `codex_relations` | 通常 | Map / Codex | Codex 同士の型付き関係（Map の User edge を昇格した格納先） |
| `scene_chunks` | 通常 | セマンティック検索 | 本文シーンを分割した埋め込みチャンク（ベクトル総当たり検索用） |
| `codex_chunks` | 通常（Rust専用） | セマンティック検索 | Codex エントリの埋め込み（1エントリ1ベクトル・hybrid 検索 / impact-review 用） |
| `chat_message_chunks` | 通常（Rust専用） | セマンティック検索 / Chat History | チャットメッセージのエピソード記憶埋め込み（1メッセージ1ベクトル・過去の対話を recall / hybrid 検索用） |
| `change_events` | 通常 | 執筆タイムラプス | 変更イベントの append-only ログ（sha256 prev_hash→hash チェーン） |
| `state_snapshots` | 通常 | 執筆タイムラプス | リプレイ起点アンカー（v1 は未配線で常に空＝latent） |
| `undo_journal` | 通常（Rust専用） | AI書き込み基盤 | tracked write の before/after ジャーナル（楽観ロック undo 用） |
| `prose_staging` | 通常 | AI書き込み基盤 | AI 提案本文の staged 中間テーブル（diff UI で accept/reject） |
| `ai_usage` | 通常 | AI使用量 | 横断トークン使用量台帳（N4・全生成サーフェスを追記専用で記録） |
| `generation_logs` | 通常 | Attribution | inline-ai / beat 生成の出自ログ（プロンプト全文・trace_id） |
| `chat_message_prompts` | 通常 | Chat | 送信時の最終システムプロンプトのスナップショット（後から確認用） |
| `prompt_templates` | 通常 | Chat / Prompt Library | ユーザー保存のプロンプトテンプレート。title/content/usage_count を保持し、チャット入力時の再利用を可能にする |
| `ab_comparisons` | 通常 | AI運用 | A/B 比較履歴（モデル/プロンプト選択）。surface/prompt/model_a/model_b/prompt_variant_a/prompt_variant_b/response_a/response_b/chosen を保持 |
| `project_snapshot_tree_nodes` | 通常 | Editor / Revision | プロジェクトスナップショットの tree_nodes 構造ミラー |
| `project_snapshot_codex_entries` | 通常 | Editor / Revision | プロジェクトスナップショットの Codex 構造ミラー |
| `project_snapshot_snippets` | 通常 | Editor / Revision | プロジェクトスナップショットの Snippet 構造ミラー |
| `project_snapshot_aux` | 通常 | Editor / Revision | スナップショット付帯データ（map/foreshadow/labels/lint 等を JSON で生コピー） |

---

## ER図（リレーション概要）

```
projects (1)
 ├──< tree_nodes (*)          project_id
 ├──< codex_types (*)         project_id
 ├──< codex_entries (*)       project_id
 ├──< codex_tags (*)          project_id
 ├──< codex_detail_definitions (*) project_id
 ├──< snippets (*)            project_id
 ├──< chat_sessions (*)       project_id
 ├──< project_snapshots (*)   project_id
 ├──< project_settings (*)    project_id
 ├──< labels (*)              project_id
 ├──< foreshadows (*)         project_id
 ├──< map_boards (*)          project_id
 ├──< post_effect_runs (*)    project_id
 ├──< post_effect_annotations (*) project_id
 ├──< post_effect_annotation_relations (*) project_id
 ├──< scene_lens_data (*)     project_id
 └──< trash_items (*)         project_id

tree_nodes (1)
 ├──< tree_nodes (*)          parent_id (自己参照、ツリー構造)
 ├──< chat_sessions (*)       node_id
 ├──< snippets (*)            scene_id
 ├──< codex_entry_phases (*)  anchor_node_id (nullable)
 ├──< authorship_spans (*)    node_id (nullable)
 ├──< tree_node_labels (*)    node_id
 ├──< scene_codex_pins (*)    scene_id
 ├──< scene_codex_mentions (*) scene_id
 ├──< scene_beat_pov_cache (*) scene_id
 ├──< foreshadows (?)         payoff_scene_id (nullable)
 ├──< foreshadow_setups (*)   scene_id
 ├──< lint_ignored_diagnostics (*) scene_id
 ├──> codex_entries (?)       pov_character_id (nullable)
 └──> codex_entries (?)       location_id (nullable)

codex_types (1)
 └──< codex_detail_definitions (*) type_slug (複合FK: project_id + type_slug)

codex_entries (1)
 ├──< codex_entries (*)       parent_id (自己参照、リレーション)
 ├──< codex_dismissed_relations (*) entry_id, dismissed_id
 ├──< codex_entry_tags (*)    entry_id
 ├──< codex_detail_values (*) entry_id
 ├──< codex_entry_phases (*)  entry_id
 ├──< codex_quick_pins (*)    entry_id
 ├──< authorship_spans (*)    codex_entry_id (nullable)
 ├──< scene_codex_pins (*)    entry_id
 ├──< scene_codex_mentions (*) codex_entry_id
 ├──< scene_beat_pov_cache (*) pov_character_id
 └──< foreshadow_codex_links (*) codex_entry_id

codex_entry_phases (1)
 ├──< codex_phase_detail_overrides (*) phase_id
 └──< authorship_spans (*)    phase_id (nullable)

snippets (1)
 ├──< snippet_entry_tags (*)  snippet_id
 ├──< authorship_spans (*)    snippet_id (nullable)
 └──< map_node_positions (*)  snippet_id (nullable)

codex_tags (1)
 ├──< codex_entry_tags (*)    tag_id
 └──< snippet_entry_tags (*)  tag_id

labels (1)
 └──< tree_node_labels (*)    label_id

codex_detail_definitions (1)
 ├──< codex_detail_values (*) definition_id
 └──< codex_phase_detail_overrides (*) definition_id

codex_detail_values (1)
 └──< authorship_spans (*)    detail_value_id (nullable)

map_stickies (1)
 ├──< authorship_spans (*)    sticky_id (nullable)
 └──< map_node_positions (*)  sticky_id (nullable)

chat_sessions (1)
 ├──< chat_messages (*)              session_id (ON DELETE CASCADE)
 ├──< chat_summaries (*)             session_id (ON DELETE CASCADE)
 ├──< chat_session_pinned_codex (*)  session_id (ON DELETE CASCADE)
 └──< map_ai_branches (*)            session_id (nullable, ON DELETE SET NULL)

chat_summaries (1)
 └──< chat_summary_messages (*) summary_id (ON DELETE CASCADE)

chat_messages (1)
 ├──< codex_entries (*)          source_chat_message_id
 ├──< snippets (*)               source_chat_message_id
 ├──< map_stickies (*)           source_chat_message_id (nullable)
 └──< chat_summary_messages (*)  message_id (ON DELETE CASCADE)

map_boards (1)
 ├──< map_stickies (*)        board_id
 ├──< map_ai_branches (*)     board_id
 ├──< map_node_positions (*)  board_id
 ├──< map_edges (*)           board_id
 └──< map_frames (*)          board_id

map_ai_branches (1)
 ├──< map_stickies (*)        ai_branch_id (nullable)
 └──< map_node_positions (*)  ai_branch_id (nullable)

map_node_positions (1)
 └──< map_edges (*)           from_position_id / to_position_id

foreshadows (1)
 ├──< foreshadow_setups (*)      foreshadow_id
 └──< foreshadow_codex_links (*) foreshadow_id

post_effect_runs (1)
 ├──< post_effect_annotations (*)          run_id (nullable, ON DELETE SET NULL)
 ├──< post_effect_annotation_relations (*) run_id (nullable, ON DELETE SET NULL)
 └──< scene_lens_data (*)                  run_id (ON DELETE CASCADE)

post_effect_annotations (1)
 ├──< post_effect_annotations (*)          parent_id (自己参照、スレッド構造)
 └──< post_effect_annotation_relations (*) annotation_a_id / annotation_b_id

tree_nodes (1)
 ├──< post_effect_runs (*)         scope_target_id (nullable)
 ├──< post_effect_annotations (*)  scene_id (nullable)
 ├──< scene_lens_data (*)          target_id (nullable)
 └──< trash_items (*)              origin_scene_id (nullable)

codex_entries (1)
 └──< trash_items (*)              origin_codex_id (nullable)

# ── 2026-06 追加分 ──────────────────────────────

projects (1)                       （上記 projects ブロックへの追加）
 ├──< ai_usage (*)                 project_id (ON DELETE CASCADE)
 ├──< generation_logs (*)          project_id (ON DELETE CASCADE)
 ├──< change_events (*)            project_id (ON DELETE CASCADE)
 ├──< state_snapshots (*)          project_id (ON DELETE CASCADE)
 ├──< codex_relations (*)          project_id (ON DELETE CASCADE)
 ├──< impact_review_baselines (*)  project_id (ON DELETE CASCADE)
 ├──< undo_journal (*)             project_id (ON DELETE CASCADE)
 └──< prose_staging (*)            project_id (ON DELETE CASCADE)

tree_nodes (1)                     （上記 tree_nodes ブロックへの追加）
 ├──< scene_chunks (*)             scene_id (ON DELETE CASCADE)
 ├──< prose_staging (*)            scene_id (ON DELETE CASCADE)
 ├──< change_events (*)            scene_id (nullable, ON DELETE SET NULL)
 ├──< ai_usage (*)                 scene_node_id (nullable, ON DELETE SET NULL)
 └──< generation_logs (*)          scene_node_id (nullable, ON DELETE CASCADE)

codex_entries (1)
 ├──< codex_relations (*)          from_codex_id / to_codex_id (ON DELETE CASCADE)
 ├──< codex_chunks (?)             entry_id (PK=FK, 1エントリ1ベクトル, ON DELETE CASCADE)
 └──< impact_review_baselines (?)  entry_id (PK=FK, 1エントリ1行, ON DELETE CASCADE)

chat_sessions (1)                  （新スコープアンカー）
 ├──> codex_entries (?)            codex_anchor_id (nullable, ON DELETE SET NULL)
 └──> snippets (?)                 snippet_anchor_id (nullable, ON DELETE SET NULL)

chat_messages (1)
 ├──< chat_message_prompts (?)     message_id (PK=FK, ON DELETE CASCADE)
 └──< chat_message_chunks (?)      message_id (PK=FK, 1メッセージ1ベクトル, ON DELETE CASCADE)

project_snapshots (1)
 ├──< project_snapshot_tree_nodes (*)    snapshot_id (ON DELETE CASCADE)
 ├──< project_snapshot_codex_entries (*) snapshot_id (ON DELETE CASCADE)
 ├──< project_snapshot_snippets (*)      snapshot_id (ON DELETE CASCADE)
 └──< project_snapshot_aux (*)           snapshot_id (ON DELETE CASCADE)

content_versions (1)               （スナップショットからの本文ポインタ）
 ├──< project_snapshot_tree_nodes (?)    body_version_id (ON DELETE RESTRICT)
 ├──< project_snapshot_codex_entries (?) body_version_id (ON DELETE RESTRICT)
 └──< project_snapshot_snippets (?)      body_version_id (ON DELETE RESTRICT)

change_events ⇄ state_snapshots    （anchor_sequence で対応。FK ではなく sequence 一致）

# ── 2026-06-22 追加分（プロットスレッド・タイムライン）─────────

projects (1)
 └──< plot_threads (*)             project_id (ON DELETE CASCADE)

plot_threads (1)
 └──< plot_thread_scene_links (*)  thread_id (ON DELETE CASCADE)

tree_nodes (1)
 └──< plot_thread_scene_links (*)  node_id (ON DELETE CASCADE, シーン削除でマーカー消滅)
```

---

## テーブル定義

### projects

プロジェクトのメタ情報。Chatのコンテキスト注入Layer 1の基礎データ。

```sql
CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL DEFAULT 'Untitled Project',
  genre                 TEXT,                    -- 'Fantasy'|'Sci-Fi'|'Mystery'|... or custom
  pov                   TEXT,                    -- 'First person'|'Third person limited'|...
  tense                 TEXT,                    -- 'Past tense'|'Present tense'
  language              TEXT NOT NULL DEFAULT 'ja',  -- 作品の執筆言語
  style_guide           TEXT,                    -- 文体ガイド（最大2,000文字）
  ai_instructions       TEXT,                    -- グローバルAI指示（最大4,000文字）
  outline               TEXT,                    -- Phase 4: 物語全体の outline（free text）。著者が手書きする意図・テーマ・到達点。AI コンテキスト L2 に常時注入。空欄可
  ai_policy             TEXT NOT NULL DEFAULT
    '{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":false,"knowledgeWrite":false}}',
                                                 -- プロジェクト単位の AI 使用方針。chat/bodyWrite/analysis/structureWrite/knowledgeWrite の5トグル。
                                                 -- 既定は構造書き込み・知識書き込みを無効にした安全側（structureWrite/knowledgeWrite=false, preset='custom'）
  is_sample             INTEGER NOT NULL DEFAULT 0,
                                                 -- 1: サンプルワークスペースのプロジェクト（初回オープン時に SampleTour を起動）
  phase_resolution_mode TEXT NOT NULL DEFAULT 'reading'
    CHECK(phase_resolution_mode IN ('auto', 'reading', 'story')),
                                                 -- Phase解決に使う時間軸。'auto'=story_time_orderがあれば作中時間、なければ読者順 / 'reading'=常に読者順 / 'story'=作中時間（未設定Sceneは直前の値を継承）
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`outline` の運用方針**:
- 著者が手書きする「物語全体のアウトライン」を保持する自由テキストカラム。長さ制限は DB レベルでは設けない（UI 側でガイドラインを提示）。
- AI コンテキスト L2 に常時注入される（`ai_policy` の `bodyWrite` / `analysis` トグルがオフでも投入される）。
- 対称概念として `tree_nodes.synopsis`（フォルダ用）が chapter outline を担う。フォルダ階層の `synopsis` と組み合わせて階層的に注入される。

**`ai_policy` の構造**:
- JSON 文字列で `{ preset: string, toggles: { chat, bodyWrite, analysis, structureWrite, knowledgeWrite: bool } }` 形式。
- `preset` は UI のプリセット名（`'full'` / `'chat-only'` / `'analysis-only'` / `'custom'` 等）。`toggles` が実際の挙動を決める。
- **既定値（2026-06 時点）は `preset='custom'` ＋ `chat/bodyWrite/analysis=true`・`structureWrite/knowledgeWrite=false`** の安全側。構造書き込み（案B tree 書き込み）と知識書き込み（Codex/伏線への AI 書き込み）は、明示的に有効化しない限り走らない（security F-6 の安全既定）。
- `structureWrite` は 2026-06-03、`knowledgeWrite` は AI 書き込み基盤の導入に伴って追加されたトグル。旧 DB は `add_column_if_missing` 経由でこの既定 JSON が入る。
- アプリ層は機能ごとに該当 toggle を参照し、`false` のときは AI 呼び出しをスキップする（Chat / Body Write / 分析 / 構造書き込み / 知識書き込みパスは独立判定）。

**`is_sample` の用途**:
- サンプルワークスペース（チュートリアル用テンプレートから生成されたプロジェクト）かどうかを区別するフラグ。
- `EditorScreen` 初回オープン時に `SampleTour` を発火するトリガーとして使用される。通常プロジェクトは常に 0。

**`phase_resolution_mode` のデフォルト方針**:
- **SQLデフォルト = `'reading'`**: 既存プロジェクトを再オープンした際に従来の挙動（読者順）が保たれるよう、後方互換を優先。マイグレーション適用時はすべての既存プロジェクトがこの値になる。
- **アプリ層デフォルト = `'auto'`**: 新規プロジェクト作成時は `'auto'` を明示的に書き込む。作中時間を設定した瞬間から自動で story-time 解決に切り替わる、最もユーザーの直感に近い挙動。
- **write-order は選択肢に含めない**: 執筆順（`created_at`順）は Phase 解決の軸として意味を持たない（後から書き足したシーンが過去のPhaseを書き換えてしまう）。`'reading'` / `'story'` の二択のみを軸として提供し、`'auto'` はその切り替えポリシー。
- 詳細は [Timeline パネル設計書](./Grimodex_Timelineパネル設計書.md) および [Codex パネル設計書](./Grimodex_Codexパネル設計書.md) の Phase 解決アルゴリズム節を参照。

### tree_nodes

Folder/Scene/Noteの統一ツリー。文字列 fractional indexing（`sort_order TEXT`）で挿入時の再ソートを回避。

```sql
CREATE TABLE tree_nodes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,    -- NULL = Project直下。フォルダ削除で配下ノードも連鎖削除
  node_type         TEXT NOT NULL CHECK(node_type IN ('folder','scene','note')),
  title             TEXT NOT NULL DEFAULT 'Untitled',
  synopsis          TEXT,                  -- Sceneのみ: シーン要約（プレーンテキスト）。storySoFarコンテキスト注入に使用
  sort_order        TEXT NOT NULL,        -- 文字列 fractional indexing キー（reading-order = ツリーDFS順）
  status            TEXT DEFAULT 'outline' -- Sceneのみ
                      CHECK(status IS NULL OR status IN ('outline','draft','complete','revision','final')),
  content           TEXT NOT NULL DEFAULT '{}',  -- Scene/Note本文（ProseMirror JSON）
  story_time_order  TEXT,                  -- Sceneのみ: 文字列 fractional indexing キー（作中時間順、辞書順比較）。NULL = 未設定
  story_time_label  TEXT,                   -- Sceneのみ: 表示用ラベル（例: '帝国暦1024年3月', 'Day 3 morning'）。NULL = 未設定
  pov_character_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                                            -- Sceneのみ: POVキャラクター（codex_entries.type='character'）。型整合性はアプリ層で保証
  location_id       TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
                                            -- Sceneのみ: 主要ロケーション（codex_entries.type='location'）。型整合性はアプリ層で保証
  unplaced_beats_doc TEXT NOT NULL DEFAULT '[]',
                                            -- Sceneのみ: Unplaced beat の保存先（ProseMirror JSON 配列）。
                                            -- 各要素は { id, beatType, pov, collapsed, content } 形式。
                                            -- 本文 (content カラム) とは独立した別データとして扱う（Beat 設計書参照）
  unplaced_beat_preview TEXT,               -- Sceneのみ: unplaced_beats_doc から抽出した
                                            -- 先頭3 beat の冒頭40文字を JSON 配列で保持。
                                            -- Grid パネルカード描画に使用。シーン保存時にフロントが値を同梱
  placed_beat_preview TEXT,                 -- Sceneのみ: content (本文) 内の placed beat 冒頭テキストの JSON 配列キャッシュ。
                                            -- シーン保存時にフロントが content から抽出して同梱
  char_count        INTEGER NOT NULL DEFAULT 0,
                                            -- Sceneのみ: 本文 (content カラム) の文字数キャッシュ。
                                            -- シーン保存時にフロントが CharacterCount 拡張の値を同梱。
                                            -- Grid パネルのステータスバー集計に使用
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tree_parent ON tree_nodes(project_id, parent_id, sort_order);
CREATE INDEX idx_tree_story_time ON tree_nodes(project_id, story_time_order)
  WHERE story_time_order IS NOT NULL;
CREATE INDEX idx_tree_pov ON tree_nodes(project_id, pov_character_id)
  WHERE pov_character_id IS NOT NULL;
CREATE INDEX idx_tree_location ON tree_nodes(project_id, location_id)
  WHERE location_id IS NOT NULL;
```

Scene/Noteの本文は `content` カラムに直接格納する。

**時間軸カラムの設計意図**:
- `sort_order` は**reading-order（読者順）**を表現する。文字列 fractional indexing（npm `fractional-indexing` 互換、base62 ASCII 文字列）で D&D 挿入時の再ソートを回避。SQLite の `COLLATE BINARY`（デフォルト）で辞書順ソートが効く
- `story_time_order` は**story-time（作中時間）**を表現する。`sort_order` と同じ文字列 fractional indexing 方式。order キーは opaque な文字列で UI には露出させず、表示は `story_time_label` が担う
- `story_time_label` は表示用で `story_time_order` から独立。同じ order でもラベルだけ自由に変更できるし、label だけ先に決めて order は後で設定する運用も可能
- Folder/Note ノードでは `story_time_order` / `story_time_label` は未使用（Timeline パネルが葉 Scene のみ扱う）
- `write-order（執筆順）`は `created_at` で表現される（専用カラムは不要）
- `pov_character_id` / `location_id` は実装済み。SQLite の `codex_entries.type` が `'character'` / `'location'` であることはアプリ層で保証（FK の CHECK 制約は SQLite で cross-table 検証不可のため）
- 詳細は Timeline パネル設計書（`Grimodex_Timelineパネル設計書.md`）と Codex パネル設計書のフェーズシステム節を参照

### codex_types

Codexエントリのタイプ定義。ビルトイン4タイプ（character/location/item/lore）に加え、プロジェクト単位でカスタムタイプを追加可能。プロジェクト作成時にビルトイン4行をシードする。

```sql
CREATE TABLE codex_types (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,            -- 'character', 'faction', 'magic_system' etc.
  label         TEXT NOT NULL,            -- '勢力', '魔法体系' etc.（表示用）
  color         TEXT NOT NULL DEFAULT '#888888',  -- カテゴリドット色（hex）
  palette_index INTEGER,                 -- カラーパレット自動割り当て用インデックス
  icon          TEXT,                     -- lucide icon名（optional）
  is_builtin    INTEGER NOT NULL DEFAULT 0,  -- 1: ビルトイン（削除・slug変更不可）
  sort_order    REAL NOT NULL DEFAULT 0.0,   -- フィルタタブの表示順
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, slug)
);

CREATE INDEX idx_codex_types_project ON codex_types(project_id);
```

ビルトインタイプのシード値:

| slug | label | color | palette_index | sort_order |
|------|-------|-------|---------------|------------|
| `character` | キャラクター | `#534AB7` | 0 | 0.0 |
| `location` | 場所 | `#0F6E56` | 1 | 1.0 |
| `item` | アイテム | `#BA7517` | 2 | 2.0 |
| `lore` | 伝承 | `#993C1D` | 3 | 3.0 |

slug命名規則: `/^[a-z][a-z0-9_]{0,31}$/`。

### codex_entries

世界設定エントリ。content本文は `content` カラムに直接格納。アイコン画像は `icon` TEXTカラムにbase64 data URL形式で格納（128×128px WebP）。

`type` カラムは `codex_types.slug` を参照（論理参照、FKなし）。`context_mode` でAIコンテキスト注入の振る舞いを制御。`tags_cache` はFTS5用の非正規化キャッシュ（正規データは `codex_entry_tags` テーブル）。

```sql
CREATE TABLE codex_entries (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id               TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,   -- リレーション（親エントリ）
  type                    TEXT NOT NULL DEFAULT 'character',   -- codex_types.slug を参照
  name                    TEXT NOT NULL DEFAULT 'Untitled',
  aliases                 TEXT,            -- JSON array: ["エララ", "the apprentice"]
  excluded_aliases        TEXT,            -- JSON array: ["青い", "青の", "青く"]
  summary                 TEXT,            -- 短い要約（1-2文）
  content                 TEXT NOT NULL DEFAULT '{}',  -- 本文（ProseMirror JSON）
  icon                    TEXT,            -- アイコン画像（128×128 WebP、base64 data URL、nullable）
  tags_cache              TEXT,            -- FTS5用非正規化キャッシュ（JSON array）
  context_mode            TEXT NOT NULL DEFAULT 'mentioned'
                            CHECK(context_mode IN ('always', 'mentioned', 'suppress', 'hidden')),
  children_budget         TEXT NOT NULL DEFAULT 'compact'       -- サブツリートークン予算プリセット
                            CHECK(children_budget IN ('none', 'compact', 'standard', 'generous')),
  source_chat_message_id  TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,   -- 抽出元チャット（nullable）
  notes                   TEXT,            -- プライベートメモ（ProseMirror JSON）。AIコンテキストには注入されない
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  -- 複合FK: (project_id, type) は codex_types(project_id, slug) を参照
  FOREIGN KEY (project_id, type) REFERENCES codex_types(project_id, slug)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX idx_codex_project ON codex_entries(project_id, type);
CREATE INDEX idx_codex_name    ON codex_entries(project_id, name);
CREATE INDEX idx_codex_parent  ON codex_entries(parent_id);
CREATE INDEX idx_codex_entries_src_msg ON codex_entries(source_chat_message_id)
  WHERE source_chat_message_id IS NOT NULL;
```

> **`type` カラムの参照整合性:** 複合FK `(project_id, type) → codex_types(project_id, slug)` により、存在しない slug への参照は SQL レベルで拒否される。`codex_types` のスラッグ変更は `ON UPDATE CASCADE` で子テーブルに伝播し、参照中のタイプ削除は `RESTRICT` で防止される（アプリ層のビルトイン保護とは独立に DB が整合性を守る）。

context_mode の動作:

| モード | 動作 | ピン留め |
|--------|------|---------|
| `always` | シーン内の言及有無に関わらず常に注入 | 可（ピン時はcontent全文） |
| `mentioned`（デフォルト） | シーン内で検出された場合に注入 | 可 |
| `suppress` | 自動検出では注入しない。ピン留めで上書き可 | 可（ピンが明示的意思） |
| `hidden` | AIコンテキストに一切含めない | 不可 |

children_budget の動作:
- 親エントリが注入対象になった場合、子孫エントリのsummaryをサブツリートークン予算の範囲内でBFS（幅優先）順に自動注入する
- プリセット値はLayer 4予算に対する比率として定義。モデルのコンテキスト上限に応じて実トークン数が自動スケールする:
  | プリセット | Layer 4比率 | 200kモデル時の実効値 | 1Mモデル時の実効値 |
  |-----------|-----------|-------------------|------------------|
  | `none` | 0% | 0 | 0 |
  | `compact`（デフォルト） | 15% | ~6,000 tok | ~30,000 tok |
  | `standard` | 30% | ~12,000 tok | ~60,000 tok |
  | `generous` | 50% | ~20,000 tok | ~100,000 tok |
- 手動ピン（Pin with children）は予算を無視する
- 詳細はCodexパネル設計書「サブツリートークン予算」セクション参照

### codex_dismissed_relations

Codex Content内の言及からのリレーション提案をDismissした記録。

```sql
CREATE TABLE codex_dismissed_relations (
  entry_id     TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  dismissed_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, dismissed_id)
);
```

### codex_tags

構造化タグ定義。タグごとにオプションで適用可能なCodexタイプを制限できる。

```sql
CREATE TABLE codex_tags (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,              -- hex e.g. '#ff6b6b'（nullable）
  type_filter TEXT,              -- JSON string[] of allowed type slugs, NULL = 全タイプ
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);

CREATE INDEX idx_codex_tags_project ON codex_tags(project_id);
```

### codex_entry_tags

エントリ↔タグの多対多リレーション。変更時はアプリ層で `codex_entries.tags_cache` を同期更新すること（FTS5トリガーの発火に必要）。

```sql
CREATE TABLE codex_entry_tags (
  entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE INDEX idx_codex_entry_tags_tag ON codex_entry_tags(tag_id);
```

### codex_detail_definitions

タイプごとのカスタムフィールド定義。各フィールドはAIコンテキスト注入の有無を個別制御可能。

```sql
CREATE TABLE codex_detail_definitions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type_slug         TEXT NOT NULL,         -- 適用対象の codex_types.slug
  name              TEXT NOT NULL,         -- フィールド名 e.g. '種族', '所属勢力'
  field_type        TEXT NOT NULL DEFAULT 'text',
                                           -- 'text' | 'dropdown' | 'codex_reference'
  field_config      TEXT,                  -- JSON（field_typeごとに構造が異なる、後述）
  sort_order        REAL NOT NULL DEFAULT 0.0,
  include_in_context INTEGER NOT NULL DEFAULT 0,  -- 1: AIコンテキストに含める
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, type_slug, name),
  -- 複合FK: (project_id, type_slug) は codex_types(project_id, slug) を参照
  FOREIGN KEY (project_id, type_slug) REFERENCES codex_types(project_id, slug)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX idx_codex_detail_defs
  ON codex_detail_definitions(project_id, type_slug, sort_order);
```

field_config のJSON構造:

| field_type | field_config | 例 |
|-----------|-------------|-----|
| `text` | `{}` | `{}` |
| `dropdown` | `{ "options": string[] }` | `{ "options": ["人間", "エルフ", "ドワーフ"] }` |
| `codex_reference` | `{ "allowedTypes": string[] \| null }` | `{ "allowedTypes": ["faction"] }` |

### codex_detail_values

エントリごとのカスタムフィールド値。

```sql
CREATE TABLE codex_detail_values (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
  value         TEXT,   -- text: ProseMirror JSON, dropdown: 選択肢文字列, codex_reference: エントリID
  UNIQUE(entry_id, definition_id)
);

CREATE INDEX idx_codex_detail_values_entry ON codex_detail_values(entry_id);
CREATE INDEX idx_codex_detail_values_def   ON codex_detail_values(definition_id);
```

### snippets

再利用可能なテキスト断片。content本文は `content` カラムにProseMirror JSON形式で格納する。タグは `snippet_entry_tags` テーブルで `codex_tags` と共有プールを使用し、`tags_cache` に非正規化キャッシュを保持する。

```sql
CREATE TABLE snippets (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL DEFAULT 'Untitled',
  content                 TEXT NOT NULL DEFAULT '{}',  -- ProseMirror JSON
  tags_cache              TEXT,            -- 非正規化キャッシュ: JSON {name, color}[] from snippet_entry_tags
  scene_id                TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,      -- 作成元シーン（nullable）
  source_chat_message_id  TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,   -- 抽出元チャット（nullable）
  usage_count             INTEGER NOT NULL DEFAULT 0,
  content_source          TEXT CHECK(content_source IS NULL OR content_source IN ('human','ai')),  -- テキストの帰属ソース
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snippets_project ON snippets(project_id, created_at DESC);
CREATE INDEX idx_snippets_scene   ON snippets(scene_id) WHERE scene_id IS NOT NULL;
CREATE INDEX idx_snippets_src_msg ON snippets(source_chat_message_id) WHERE source_chat_message_id IS NOT NULL;
```

> **`tags` カラムの廃止:** 初期設計ではSnippetのタグを `TEXT` JSON配列で保持していたが、Codexと共通のタグプール（`codex_tags`）を使う要件が発生したため、`snippet_entry_tags` リレーションテーブルに移行。`tags_cache` はFTS5トリガー用の非正規化キャッシュとして残す。

### chat_sessions

チャットセッション。node_id NULLはプロジェクトスコープ。

```sql
CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id       TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,   -- NULLの場合はプロジェクトスコープ。シーン削除後もセッション履歴は残す
  title         TEXT NOT NULL DEFAULT 'New session',
  title_manual  INTEGER NOT NULL DEFAULT 0,        -- 1: 手動リネーム済み、自動再生成を抑制
  model         TEXT NOT NULL DEFAULT 'openrouter/anthropic/claude-sonnet-4.6',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_sessions_node ON chat_sessions(project_id, node_id);
```

### chat_session_pinned_codex

セッションごとのピン留めされたCodexエントリ・Snippet。旧 `chat_sessions.pinned_codex` JSON カラムの正規化版で、FK により削除時の整合性を保証。並び順はピン追加時刻（`created_at` ASC）。

```sql
CREATE TABLE chat_session_pinned_codex (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  codex_entry_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  snippet_id     TEXT REFERENCES snippets(id) ON DELETE CASCADE,
  with_children  INTEGER NOT NULL DEFAULT 0,
  pin_source     TEXT NOT NULL DEFAULT 'manual'
                   CHECK(pin_source IN ('manual','chat_mention')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- codex_entry_id と snippet_id のいずれか1つのみNOT NULL
  CHECK (
    (CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE INDEX idx_chat_pin_session ON chat_session_pinned_codex(session_id, created_at);
CREATE UNIQUE INDEX uq_chat_pin_codex ON chat_session_pinned_codex(session_id, codex_entry_id)
  WHERE codex_entry_id IS NOT NULL;
CREATE UNIQUE INDEX uq_chat_pin_snippet ON chat_session_pinned_codex(session_id, snippet_id)
  WHERE snippet_id IS NOT NULL;
```

`pin_source`:
- `'manual'` — 「+」ボタン、ピルプレビューのPin等のユーザー明示操作
- `'chat_mention'` — 旧バージョン互換用。現在の @ メンションはターン内候補としてのみ扱い、新規行を永続化しない。既存行もコンテキスト計画では明示ピンとして扱わない

### chat_messages

チャットメッセージ。セッション削除時にCASCADE削除。

```sql
CREATE TABLE chat_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content       TEXT NOT NULL,
  model         TEXT,               -- assistantメッセージのみ: 使用モデル名
  tokens_in     INTEGER,            -- 入力トークン数
  tokens_out    INTEGER,            -- 出力トークン数
  duration_ms   INTEGER,            -- 生成時間（ミリ秒）
  metadata      TEXT,               -- JSON: { extractedCodex: [...], extractedSnippets: [...], insertedToEditor: bool }
  is_starred    INTEGER NOT NULL DEFAULT 0,   -- DEPRECATED: ⭐スター機能は廃止。
                                              -- 後方互換のためカラムは残置するが新規書き込みは常に 0。
                                              -- 要約時の保護は Tier ベース自動判定に置換
                                              -- (Chatパネル設計書 §Layer 5 参照)。
                                              -- 次回メジャー migration で DROP 予定
  is_summarized INTEGER NOT NULL DEFAULT 0,   -- 1: プログレッシブ要約済み
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
```

`chat_messages.metadata` の JSON 構造:

```json
{
  "extractedCodex": ["codex-entry-id-1"],
  "extractedSnippets": ["snippet-id-1", "snippet-id-2"],
  "insertedToEditor": true
}
```

各フィールド:

- `extractedCodex` (string[]): このメッセージから抽出されて作られた Codex エントリの ID
- `extractedSnippets` (string[]): このメッセージから保存された Snippet の ID
- `insertedToEditor` (boolean): このメッセージのテキストが Editor に挿入されたか。
  Insert ボタン押下時に Editor 側で `true` に更新する (Editor パネル設計書参照)

これらは Layer 5 の Tier ベース自動保護で **Tier 2 アンカー** 判定に使用される
(Chat パネル設計書 §Layer 5 参照)。

### authorship_spans

AI帰属追跡。エディタの自動保存時にTipTap AuthorshipMarkから同期。
対象ドキュメントの種別に応じて `node_id`、`codex_entry_id`、`snippet_id`、`detail_value_id`、`sticky_id` のいずれか1つのみを設定する。`phase_id` はCodexエントリのフェーズ `contentOverride` 編集時の帰属追跡に使用。

```sql
CREATE TABLE authorship_spans (
  id              TEXT PRIMARY KEY,
  node_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,       -- Scene/Note の場合
  codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,     -- Codex content の場合
  snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,          -- Snippet content の場合
  detail_value_id TEXT REFERENCES codex_detail_values(id) ON DELETE CASCADE, -- Codex カスタムディテール text フィールドの場合
  sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,      -- Map Sticky body の場合
  from_pos        INTEGER NOT NULL,
  to_pos          INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK(source IN ('human', 'ai', 'unknown')),
  model           TEXT,                -- AI生成時のモデル名
  timestamp       TEXT,                -- ISO 8601
  chat_msg_id     TEXT,                -- 抽出元チャットメッセージID（nullable）
  phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,  -- フェーズcontentOverride帰属追跡用（nullable）
  -- node_id, codex_entry_id, snippet_id, detail_value_id, sticky_id のいずれか1つのみNOT NULL（所有文書）
  CHECK (
    (CASE WHEN node_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN sticky_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  -- phase_id（フェーズ contentOverride 編集時）は codex_entry_id とセットで必須
  CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL)
);

CREATE INDEX idx_authorship_node ON authorship_spans(node_id, source);
CREATE INDEX idx_authorship_codex ON authorship_spans(codex_entry_id, source);
CREATE INDEX idx_authorship_snippet ON authorship_spans(snippet_id, source);
CREATE INDEX idx_authorship_detail ON authorship_spans(detail_value_id);
CREATE INDEX idx_authorship_sticky ON authorship_spans(sticky_id, source) WHERE sticky_id IS NOT NULL;
CREATE INDEX idx_authorship_phase ON authorship_spans(phase_id) WHERE phase_id IS NOT NULL;
```

### codex_quick_pins

Codexエントリのクイックピン永続化。サイドバーに常時表示するエントリを記録する。

```sql
CREATE TABLE codex_quick_pins (
  entry_id   TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_quick_pins_created ON codex_quick_pins(created_at);
```

`created_at` により `listPinnedCodexIds` の並び順がピン追加時刻の昇順で安定化される。

### chat_summaries

プログレッシブ要約。長いチャット会話をコンテキストウィンドウに収めるため、古いメッセージ群を要約して圧縮する。要約済みメッセージは `chat_messages.is_summarized = 1` でマークされる。

```sql
CREATE TABLE chat_summaries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,          -- runSummarization が生成した会話要約本文
  token_count     INTEGER NOT NULL,       -- 要約本文の推定トークン数 (Layer 5 予算計算用)
  generation      INTEGER NOT NULL DEFAULT 1,  -- 何世代目の要約か。3 超で多段要約警告
  source_msg_count INTEGER NOT NULL,      -- このサマリが取り込んだメッセージ数
  last_msg_id     TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
                                          -- 取り込んだ最後のメッセージ ID (整合性チェック用)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_summaries_session ON chat_summaries(session_id, created_at);
CREATE INDEX idx_chat_summaries_generation ON chat_summaries(session_id, generation);
```

**migration 戦略:**

- `generation` / `source_msg_count` / `last_msg_id` カラム追加 (`ALTER TABLE ADD COLUMN`)
- 既存レコードは `generation = 1`, `source_msg_count = 0`, `last_msg_id = NULL` で
  バックフィル (情報がないため正確な値は復元しない)

### chat_summary_messages

プログレッシブ要約のソースメッセージ集合。旧 `chat_summaries.source_message_ids` JSON 配列の正規化版。FK により `chat_messages` 削除時にリンクも自動削除される。

```sql
CREATE TABLE chat_summary_messages (
  summary_id TEXT NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, message_id)
);

CREATE INDEX idx_chat_summary_messages_msg ON chat_summary_messages(message_id);
```

### snippet_entry_tags

Snippet↔タグの多対多リレーション。Codexと共通の `codex_tags` タグプールを使用する。変更時はアプリ層で `snippets.tags_cache` を同期更新すること（FTS5トリガーの発火に必要）。

```sql
CREATE TABLE snippet_entry_tags (
  snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES codex_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (snippet_id, tag_id)
);

CREATE INDEX idx_snippet_entry_tags_tag_id ON snippet_entry_tags(tag_id);
```

### codex_entry_phases

Codexエントリの経時的変化（フェーズ）。物語の進行に伴うキャラクターの状態変化や設定の変遷を、ツリーノード（シーン/フォルダ）にアンカーして管理する。`anchor_node_id` 以降のシーンでは、対応するフィールドのオーバーライド値がベースエントリの値に代わって使用される。

```sql
CREATE TABLE codex_entry_phases (
  id                    TEXT PRIMARY KEY,
  entry_id              TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  anchor_node_id        TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,  -- フェーズ発動起点ノード
  label                 TEXT NOT NULL DEFAULT '',      -- フェーズ名（表示用）
  summary_override      TEXT,            -- ベースsummaryのオーバーライド
  content_override      TEXT,            -- ベースcontentのオーバーライド（ProseMirror JSON）
  context_mode_override TEXT            -- ベースcontext_modeのオーバーライド
                          CHECK(context_mode_override IS NULL OR
                                context_mode_override IN ('always','mentioned','suppress','hidden')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_codex_phases_entry ON codex_entry_phases(entry_id);
CREATE INDEX idx_codex_phases_anchor ON codex_entry_phases(anchor_node_id);
```

### codex_phase_detail_overrides

フェーズごとのカスタムディテール値オーバーライド。ベースの `codex_detail_values` に対して、特定フェーズで異なる値を設定する場合に使用する。

```sql
CREATE TABLE codex_phase_detail_overrides (
  phase_id      TEXT NOT NULL REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL REFERENCES codex_detail_definitions(id) ON DELETE CASCADE,
  value         TEXT,
  PRIMARY KEY (phase_id, definition_id)
);

CREATE INDEX idx_phase_detail_overrides_phase ON codex_phase_detail_overrides(phase_id);
```

> **PKの設計判断:** サロゲートキー `id` は不要。`(phase_id, definition_id)` の複合主キーが自然キーであり、このテーブルを参照する外部キーは存在しない。

### app_settings

アプリ全体のKey-Valueストア（プロジェクト跨ぎで共有）。エディタの表示設定、キーバインド、バックアップ設定、AIモデル選択など、ユーザー単位のプリファレンスを保存する。

```sql
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,       -- ドット区切り: 'editor.fontSize', 'display.theme'
  value TEXT NOT NULL            -- JSON value
);
```

### project_settings

プロジェクトごとのKey-Valueストア。将来的な per-project オーバーライドの受け皿として予約されており、現時点ではアプリから書き込まれていない。プロジェクト削除時に CASCADE で連鎖削除される。

```sql
CREATE TABLE project_settings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
```

> **使い分け:** 現在 `DEFAULT_SETTINGS` 内のキーはすべてユーザー単位のプリファレンス（表示・機能オプション）なので `app_settings` に格納される。プロジェクト固有のメタデータ（ジャンル、POV、スタイルガイド等）は既に `projects` テーブルのカラムとして持つため、`project_settings` はまだ empty-ready 状態。将来 `tree.numberingScope` など「プロジェクトごとに変わりうる設定」が出てきたらこちらに移す。

---

## FTS5 仮想テーブル

全てtrigramトークナイザーを使用（日本語対応）。

### codex_fts

Codexエントリの検索用。name + aliases + summary + tags_cache + content を対象。tags_cacheは `codex_entry_tags` の非正規化キャッシュ。`content`（Codex 本文 = ProseMirror JSON）は **2026-06-18（PR #109）に 5 番目のインデックス列として追加**され、`search_codex` がメタデータだけでなく本文にもマッチするようになった（[セマンティック検索設計書](./Grimodex_セマンティック検索設計書.md) の「Codex 本文の index 化」）。

```sql
CREATE VIRTUAL TABLE codex_fts USING fts5(
  name,
  aliases,
  summary,
  tags_cache,
  content,                  -- 2026-06-18 追加: Codex 本文（ProseMirror JSON）。本文検索を有効化
  content=codex_entries,    -- ※ fts5 の external-content オプション（同名だが直上の content 列とは別物）
  content_rowid=rowid,
  tokenize='trigram'
);
```

> 既に構築済みの（レガシー）DB には `migrate_codex_fts_add_content`（`migrate.rs`）が `content` 列付きで `codex_fts` とトリガー（`codex_fts_ai/ad/au`）を **DROP → 再作成**し、`INSERT INTO codex_fts(codex_fts) VALUES('rebuild')` で全行を再インデックスする。`codex_fts` に `content` 列が既に在れば no-op（冪等）。

### snippets_fts

Snippetの検索用。title + content + tags_cache を対象。

```sql
CREATE VIRTUAL TABLE snippets_fts USING fts5(
  title,
  content,
  tags_cache,
  content='snippets',
  content_rowid=rowid,
  tokenize='trigram'
);
```

### chat_messages_fts

チャットメッセージの横断検索用。content を対象。

```sql
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
  content,
  content=chat_messages,
  content_rowid=rowid,
  tokenize='trigram'
);
```

### tree_nodes_fts

ツリーノード（シーン/ノート）の検索用。title + content を対象。

```sql
CREATE VIRTUAL TABLE tree_nodes_fts USING fts5(
  title,
  content,
  content=tree_nodes,
  content_rowid=rowid,
  tokenize='trigram'
);
```

---

## FTS5 同期トリガー

各FTS5仮想テーブルをソーステーブルと自動同期するトリガー。

全てのUPDATEトリガーにはWHENガードを設定し、FTS対象カラムが変更された場合のみFTSインデックスを更新する（`updated_at` のみの更新でFTS再インデックスが走るのを防止）。

### codex_fts トリガー

```sql
CREATE TRIGGER codex_fts_ai AFTER INSERT ON codex_entries BEGIN
  INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache, content)
    VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''),
            COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''), COALESCE(new.content, ''));
END;

CREATE TRIGGER codex_fts_ad AFTER DELETE ON codex_entries BEGIN
  INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache, content)
    VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''),
            COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''), COALESCE(old.content, ''));
END;

CREATE TRIGGER codex_fts_au AFTER UPDATE ON codex_entries
  WHEN old.name IS NOT new.name OR old.aliases IS NOT new.aliases
    OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache
    OR old.content IS NOT new.content
BEGIN
  INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache, content)
    VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''),
            COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''), COALESCE(old.content, ''));
  INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache, content)
    VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''),
            COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''), COALESCE(new.content, ''));
END;
```

### snippets_fts トリガー

```sql
CREATE TRIGGER snippets_fts_ai AFTER INSERT ON snippets BEGIN
  INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache, ''));
END;

CREATE TRIGGER snippets_fts_ad AFTER DELETE ON snippets BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache, ''));
END;

CREATE TRIGGER snippets_fts_au AFTER UPDATE ON snippets
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content
    OR old.tags_cache IS NOT new.tags_cache
BEGIN
  INSERT INTO snippets_fts(snippets_fts, rowid, title, content, tags_cache)
    VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags_cache, ''));
  INSERT INTO snippets_fts(rowid, title, content, tags_cache)
    VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache, ''));
END;
```

### chat_messages_fts トリガー

```sql
CREATE TRIGGER chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;

CREATE TRIGGER chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages
  WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO chat_messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;
```

### tree_nodes_fts トリガー

```sql
CREATE TRIGGER tree_nodes_fts_ai AFTER INSERT ON tree_nodes BEGIN
  INSERT INTO tree_nodes_fts(rowid, title, content)
    VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
END;

CREATE TRIGGER tree_nodes_fts_ad AFTER DELETE ON tree_nodes BEGIN
  INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
END;

CREATE TRIGGER tree_nodes_fts_au AFTER UPDATE ON tree_nodes
  WHEN old.title IS NOT new.title OR old.content IS NOT new.content
BEGIN
  INSERT INTO tree_nodes_fts(tree_nodes_fts, rowid, title, content)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.content, ''));
  INSERT INTO tree_nodes_fts(rowid, title, content)
    VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.content, ''));
END;
```

---

## データベース初期化

```sql
-- WALモード有効化（接続ごとに1回）
PRAGMA journal_mode = WAL;

-- 外部キー制約有効化（接続ごとに1回）
PRAGMA foreign_keys = ON;
```

---

## content_versions

コンテンツのリビジョン履歴。自動リビジョン（前回から最低間隔経過時、デフォルト5分）と手動リビジョン（`Ctrl+S`）を保存。エンティティごとに保持上限（デフォルト50件）を超えた場合、auto優先で古いものからFIFO削除する。詳細は [`Grimodex_リビジョン履歴設計書.md`](Grimodex_リビジョン履歴設計書.md) を参照。

```sql
CREATE TABLE content_versions (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type    TEXT NOT NULL CHECK(entity_type IN ('scene', 'note', 'codex_entry', 'snippet')),
  entity_id      TEXT NOT NULL,    -- tree_nodes.id / codex_entries.id / snippets.id
  content        TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  snapshot_type  TEXT NOT NULL DEFAULT 'auto' CHECK(snapshot_type IN ('auto', 'manual')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id, version_number)
);

CREATE INDEX idx_cv_entity ON content_versions(entity_type, entity_id, version_number DESC);
```

### project_snapshots

プロジェクト全体のプロジェクトスナップショット。各エンティティの `content_versions` へのポインタを `project_snapshot_entries` で保持する軽量方式。詳細は [`Grimodex_リビジョン履歴設計書.md`](Grimodex_リビジョン履歴設計書.md) を参照。

```sql
CREATE TABLE project_snapshots (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);

CREATE INDEX idx_project_snapshots ON project_snapshots(project_id, created_at DESC);
```

### project_snapshot_entries

プロジェクトスナップショットと各エンティティのリビジョンの紐付け。参照先の `content_versions` レコードはプルーニングから保護される。

```sql
CREATE TABLE project_snapshot_entries (
  snapshot_id TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: プルーニングはスナップショット参照中のバージョンを削除できない
  version_id  TEXT NOT NULL REFERENCES content_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (snapshot_id, version_id)
);
```

---

## ファイルシステム構成

コンテンツは全てDBに格納。ファイルシステムにはバックアップとマイグレーションのみ保存。

```
{workspace}/
├── grimodex.db                         ← SQLiteデータベース（全コンテンツ含む）
├── .grimodex/
│   └── workspace.json                  ← ワークスペースID + 作成日時
├── backups/                            ← 自動バックアップ（.db / .db.gz）
│   └── ...
└── migrations/                         ← DBマイグレーションファイル
```

---

## JSON カラム仕様

SQLiteにはネイティブJSON型がないため、TEXT カラムにJSON文字列を保存する。

| テーブル.カラム | JSON構造 | 例 |
|---------------|---------|-----|
| `codex_entries.aliases` | `string[]` | `["エララ", "the apprentice"]` |
| `codex_entries.excluded_aliases` | `string[]` | `["青い", "青の", "青く"]` |
| `codex_entries.tags_cache` | `string[]` | `["protagonist", "mage"]`（FTS5用非正規化キャッシュ） |
| `codex_tags.type_filter` | `string[] \| null` | `["character", "lore"]` または `null`（全タイプ） |
| `codex_detail_definitions.field_config` | `object` | `{"multiline":true}`, `{"options":["人間","エルフ"]}`, `{"allowedTypes":["faction"]}` |
| `snippets.tags_cache` | `{name: string, color: string}[]` | `[{"name":"dialogue","color":"#ff6b6b"}]`（snippet_entry_tagsの非正規化キャッシュ） |
| `chat_messages.metadata` | `object` | `{"extractedCodex":["id1"],"extractedSnippets":["id2"],"insertedToEditor":true}` |
| `app_settings.value` | `any` | `"16"`, `"system"`, `"true"` |
| `project_settings.value` | `any` | `"16"`, `"system"`, `"true"` |
| `map_boards.show_config` | `object` | `{"scene":true,"codex":false}` ノードタイプ別の表示ON/OFF |
| `map_ai_branches.seed_node_ids` | `string[]` | `["pos-id-1","pos-id-2"]` 生成の参照元 map_node_positions.id 一覧 |
| `map_edges.labels` | `string[]` | `["好敵手","師弟"]` 追加ラベル配列 |
| `lint_term_dictionary.variants` | `string[]` | `["あなた","貴方","貴女"]` ゆれ表記一覧 |
| `tree_nodes.unplaced_beats_doc` | `object[]` | `[{"id":"u1","beatType":"free","pov":null,"collapsed":false,"content":[...]}]` |
| `tree_nodes.unplaced_beat_preview` | `string[]` | `["雨の夜、廃社の前で","祭壇に置かれた朱紐"]` 先頭3 beatの冒頭40文字 |
| `tree_nodes.placed_beat_preview` | `string[]` | 本文内 placed beat 冒頭テキスト |

SQLite 3.38+の `json()` / `json_extract()` 関数でクエリ内でのJSON操作が可能。ただしDrizzle ORM経由のアプリケーション層でのパース/シリアライズを基本とする。

---

## マイグレーション方針

- スキーマ定義（DDL）は Rust 側の `src-tauri/crates/grimodex-db/src/migrate.rs` `Database::migrate()` メソッドで一元管理
- TypeScript 側の `src/db/schema.ts` は Drizzle ORM のクエリビルダー用スキーマ定義のみ（DDL生成なし）
- `drizzle-kit` によるマイグレーションファイル生成は使用しない（sqlite-proxy構成のため）
- アプリ起動時（ワークスペースオープン時）に `Database::migrate()` が自動実行される
- FTS5仮想テーブル・トリガー・シードデータは全て `migrate()` 内で定義
- スキーマ変更時は `database.rs` と `schema.ts` と本設計書の3箇所を同期更新すること

---

## 統合時に発見した不整合と解決

以下の不整合を発見し、本ドキュメントおよび各個別設計書の両方で修正済み。

### 1. codex_entries の定義が設計書間で分散

Codex設計書のCREATE TABLEに `aliases` と `excluded_aliases` が含まれていたが、同じ設計書の後のセクションでALTER TABLEとして再定義。さらに `parent_id` もALTER TABLEで追加されていた。

**解決**: CREATE TABLEに全カラム（`parent_id`、`aliases`、`excluded_aliases` 含む）を統合。Codex設計書のALTER TABLE記述を削除し、「DBスキーマ」セクションへの参照に置き換え。

### 2. FTS5トリガーの命名規則

各設計書で `codex_ai`、`snippets_ai`、`chat_messages_ai` のような短い名前だったが、同じ `_ai` サフィックスが複数テーブルで重複。

**解決**: `{table}_fts_{operation}` 形式に統一（例: `codex_fts_ai`、`snippets_fts_au`、`chat_messages_fts_ad`）。Codex・Snippets・Chat History各設計書のトリガー名を修正済み。

### 3. authorship_spans の参照先

Editor設計書では `chat_msg_id TEXT` と定義されていたが、外部キー制約が未定義で、インデックスも未定義だった。

**解決**: chat_messagesへの外部キー制約は意図的に付けない（chat_messages削除時にattribution統計が壊れるのを防ぐため）。方針をSQLコメントで明文化。`idx_authorship_node` インデックスをEditor設計書のCREATE TABLE直後に追加。Attribution設計書の重複インデックス定義はEditor設計書への参照に置き換え。

### 4. authorship_spans のCodex/Snippet対応

Codex/SnippetのcontentがEditorタブとして開けるようになったため、`node_id` を必須からnullableに変更し、`codex_entry_id`、`snippet_id` を追加。CHECK制約で3つのうちいずれか1つのみNOT NULLを保証。Editor設計書のCREATE TABLEは本スキーマへの参照に置き換え済み。

---

## スキーマリセット（2026-04-13）

v1〜v7のインクリメンタルマイグレーションを全て統合し、クリーンな初期スキーマとして再構成。以下の変更を含む:

### 統合された変更

| 元バージョン | 変更内容 |
|------------|---------|
| v1 | `snippets.content_source`、`codex_entries.children_budget`、`codex_entries.notes`、`codex_types.palette_index` の追加 |
| v2 | FTS5 UPDATE トリガーの WHEN ガード追加 |
| v3 | `tree_nodes.node_type` のレガシー値（'part'/'chapter'）を 'folder' に統合 |
| v4 | `codex_quick_pins` テーブル追加 |
| v5 | `chat_messages.is_starred`/`is_summarized`、`chat_summaries` テーブル追加 |
| v6 | `snippet_entry_tags` テーブル、`snippets.tags_cache` 追加 |
| v7 | `codex_entry_phases`、`codex_phase_detail_overrides` テーブル、`authorship_spans.phase_id` 追加 |

### リセット時の追加修正

- `codex_entries.icon`: BLOB → TEXT（base64 data URL形式）に変更
- `snippets.tags`: レガシーカラム削除（`snippet_entry_tags` + `tags_cache` で代替）
- `snippets_fts`: インデックス対象を `tags` → `tags_cache` に変更
- `tree_nodes_fts`: 仮想テーブル+トリガーを設計書に追記
- `codex_phase_detail_overrides`: サロゲートキー `id` 削除、複合PK `(phase_id, definition_id)` に変更
- `authorship_spans.detail_value_id`: 設計書記載だが未実装だったカラムをスキーマに追加（エディタ連携は別タスク）
- 全テーブルの ON DELETE アクション（CASCADE/SET NULL）を明示化

---

## Timelineパネル導入に伴う追加（2026-04-21）

Timelineパネル設計書の策定に伴い、Phase解決で使う時間軸を「読者順」と「作中時間」に分離。既存スキーマに以下を追加。

### 追加カラム / インデックス

| テーブル | カラム | 型 | 用途 |
|---------|-------|----|----|
| `projects` | `phase_resolution_mode` | `TEXT NOT NULL DEFAULT 'reading' CHECK(... IN ('auto','reading','story'))` | Phase解決の軸を決めるプロジェクト単位の設定 |
| `tree_nodes` | `story_time_order` | `TEXT` | Scene の作中時間順序キー（文字列 fractional indexing、辞書順比較、NULL=未設定） |
| `tree_nodes` | `story_time_label` | `TEXT` | Scene の作中時間表示用ラベル（順序とは独立） |
| `tree_nodes` | `idx_tree_story_time` | 部分インデックス | `(project_id, story_time_order) WHERE story_time_order IS NOT NULL` |

### 設計上の不変条件

- **Phase の anchor は `scene_id` のまま**。時間軸の違いは「同じアンカーを異なる順序で並べ替える」ことで表現する。アンカー自体の意味は変えない。
- **write-order（`created_at`順）は Phase 解決に一切使わない**。後から書いたシーンが過去の Phase を書き換える挙動は意図と合わないため、明示的に禁止。
- **`story_time_order` は文字列辞書順比較のみ**。`sort_order` と同じ文字列 fractional indexing 方式（npm `fractional-indexing` 互換）。年月日・暦・相対時刻などはアプリ層が `story_time_label` にマッピング。DBは順序関係のみを保証する。
- **`sort_order` も `story_time_order` も `tree_nodes` 内では同じ方式**。順序キーは UI に露出させず、ユーザーから見える編集経路は「Scenes/Timeline ビューポート上のドラッグ」と「`story_time_label` などの表示用フィールドの編集」のみとする。
- **`story_time_order` が NULL のシーン**は、`resolveCodexState` 側で「直前の story_time_order を継承」または「reading-order にフォールバック」する（モードにより挙動が異なる）。詳細は Codex パネル設計書を参照。

### マイグレーション方針

- SQLデフォルト `'reading'` により既存プロジェクトは従来通り読者順で解決される（後方互換）。
- 新規プロジェクト作成時のアプリ層デフォルトは `'auto'` とし、作中時間を入力した瞬間から自動で story-time 解決に切り替わるようにする。
- `story_time_order` / `story_time_label` は NULL 許容で追加するのみ。既存シーンへの一括設定は不要。

### `tree_nodes.sort_order` の REAL → TEXT 移行

旧仕様では `sort_order` は REAL（浮動小数点 `(A+B)/2` 方式）だったが、Timeline パネル導入に合わせて文字列 fractional indexing に統一する。既存DBへのマイグレーション手順:

1. `tree_nodes` を `(project_id, parent_id, sort_order)` で取り出して**現在の並び順を確定**させる
2. 各兄弟グループに対して `generateNKeysBetween(null, null, n)` で新しい文字列キーを発番（`["a0","a1",...]`）
3. SQLite は `ALTER TABLE ... ALTER COLUMN` をサポートしないため、**新カラム `sort_order_new TEXT` を追加 → 値書き戻し → 旧 `sort_order` を `DROP` → リネーム** の手順を取る
4. 旧インデックス `idx_tree_parent` を再作成（型変更後）
5. アプリ起動時に一度だけ実行し、完了フラグを `meta` テーブル等で記録

**他テーブルの `sort_order` は据え置き**: `codex_types.sort_order` / `codex_detail_definitions.sort_order` は引き続き REAL 型を使う。これらは中間挿入頻度が低く（管理者が時々並べ替えるだけ）、精度劣化リスクは実害が薄いため、移行コストに見合わない。

---

## 設計レビュー反映（2026-04-24）

未リリース段階の設計レビューで検出された整合性問題を解消。`database.rs` / `schema.ts` / 本設計書を同期。

### ON DELETE アクション明示（整合性系）

| テーブル | カラム | 変更前 | 変更後 | 理由 |
|---------|-------|-------|-------|-----|
| `tree_nodes` | `parent_id` | SET NULL | **CASCADE** | フォルダ削除時に配下シーンが root に浮上する挙動を禁止 |
| `codex_entries` | `source_chat_message_id` | 未指定 | **SET NULL** | FK で履行、従来のトリガーは削除 |
| `snippets` | `source_chat_message_id` | 未指定 | **SET NULL** | 同上 |
| `project_snapshot_entries` | `version_id` | 未指定 | **RESTRICT** | スナップショット参照中のバージョンをプルーニングが削除できないよう明示 |
| `authorship_spans` | `detail_value_id` | 未指定 | **CASCADE** | 他の所有カラムと揃える |

### CHECK 制約追加（値の型安全性）

| テーブル | カラム | 許容値 |
|---------|-------|-------|
| `tree_nodes` | `node_type` | `'folder' \| 'scene' \| 'note'` |
| `tree_nodes` | `status` | `NULL \| 'outline' \| 'draft' \| 'complete' \| 'revision' \| 'final'` |
| `snippets` | `content_source` | `NULL \| 'human' \| 'ai'` |
| `codex_entry_phases` | `context_mode_override` | `NULL \| 'always' \| 'mentioned' \| 'suppress' \| 'hidden'` |

### `authorship_spans` CHECK 修正

- 所有カラム排他 CHECK に `detail_value_id` を追加して **4-way 排他**に統一（従来は 3-way）
- `phase_id` は `codex_entry_id` がセットされているときのみ許容する CHECK を追加

### UNIQUE 制約追加

- `project_snapshots(project_id, name)` — 同名スナップショットを禁止

### インデックス追加（FK 逆引き用）

- `idx_codex_entries_src_msg` on `codex_entries(source_chat_message_id)` ※部分
- `idx_snippets_scene` on `snippets(scene_id)` ※部分
- `idx_snippets_src_msg` on `snippets(source_chat_message_id)` ※部分
- `idx_authorship_phase` on `authorship_spans(phase_id)` ※部分

### トリガー削除

`source_chat_message_id` / `scene_id` の nullify-on-delete を実現していた以下トリガーは、FK の `ON DELETE SET NULL` で代替できるため削除:

- `nullify_codex_source_on_msg_delete`
- `nullify_snippet_source_on_msg_delete`
- `nullify_snippet_scene_on_node_delete`

### 並び順関連（部分対応）

| テーブル | 対応 | 理由 |
|---------|------|------|
| `codex_quick_pins` | `created_at` カラム追加、`listPinnedCodexIds` を昇順 ORDER BY | ピン順序の未定義問題を解決 |
| `codex_entries` | **据え置き** | `parent_id` は構造的ツリーではなく「リレーション」。UI 側で名前/更新日時/カテゴリ等のソートオプションで扱うため、DB 側 `sort_order` は不要 |
| `codex_entry_phases` | **据え置き** | 既に `created_at` で ORDER BY しているため安定 |

### テーブル命名のリネーム

- `codex_relation_dismissed` → `codex_dismissed_relations`（他テーブルの複数形・形容詞＋名詞の命名規則に合わせる）

### JSON カラムの正規化

旧 JSON 埋め込みカラムをリレーションテーブルに分離し、FK による整合性を担保:

| 旧カラム | 新テーブル | 効果 |
|---------|----------|------|
| `chat_sessions.pinned_codex` | `chat_session_pinned_codex` | codex/snippet 削除時にピンも自動削除、重複ピンは UNIQUE で防止 |
| `chat_summaries.source_message_ids` | `chat_summary_messages` | message 削除時にリンクも自動削除、要約→メッセージの逆引きが SQL で可能 |

### settings テーブル分離

旧 `settings` テーブルを `app_settings` / `project_settings` の2テーブルに分離:

| 旧 | 新 | スコープ |
|----|-----|---------|
| `settings` | `app_settings` | アプリ全体（既存キーはすべてここに移行） |
| — | `project_settings(project_id, key, value)` | プロジェクト別（現時点では未使用、将来拡張用） |

現状のキー（editor/display/ai/keys/data/revision/tree/export）はすべてユーザープリファレンスで app-level のため `app_settings` 行き。プロジェクト固有メタデータは既に `projects` テーブルの専用カラム（genre、style_guide 等）で管理されているため、`project_settings` は「empty-ready」状態で用意。

### 複合 FK による Codex タイプ参照整合性

従来「論理 FK（アプリ層検証）」としていた以下2箇所に複合 FK を追加し、DB レベルで整合性を保証:

| テーブル | カラム | 参照先 | 挙動 |
|---------|-------|-------|------|
| `codex_entries` | `(project_id, type)` | `codex_types(project_id, slug)` | `ON UPDATE CASCADE` / `ON DELETE RESTRICT` |
| `codex_detail_definitions` | `(project_id, type_slug)` | `codex_types(project_id, slug)` | `ON UPDATE CASCADE` / `ON DELETE RESTRICT` |

- 存在しないスラッグへの参照を SQL が拒否
- タイプのスラッグ変更時は子テーブルに伝播
- タイプ削除は参照がある場合 RESTRICT で防止（builtin 保護とは独立）
- アプリコードは変更なし（`type` / `type_slug` カラム名・型ともに据え置き）

---

## Mapパネル導入に伴う追加（2026-04-21）

Mapパネル設計書の策定に伴い、以下の5テーブルを追加。詳細は [Mapパネル設計書](./Grimodex_Mapパネル設計書.md) を参照。

### map_boards

プロジェクトごとのMapボード。v1では単一ボード（`title = 'Main'`）を自動作成し、追加は禁止。

```sql
CREATE TABLE map_boards (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'Main',
  sort_order    REAL NOT NULL DEFAULT 0.0,
  mode          TEXT NOT NULL DEFAULT 'free' CHECK(mode IN ('free', 'theme')),
  viewport_x    REAL NOT NULL DEFAULT 0,      -- ビューポート左端X（保存・復元用）
  viewport_y    REAL NOT NULL DEFAULT 0,      -- ビューポート上端Y
  viewport_zoom REAL NOT NULL DEFAULT 1.0,   -- ズーム倍率
  show_config   TEXT NOT NULL DEFAULT '{}',  -- ノードタイプ別表示ON/OFF JSON
  color_by      TEXT NOT NULL DEFAULT 'none', -- ノード彩色基準（'none' | 'type' | ...）
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_boards_project ON map_boards(project_id);
```

### map_node_positions

ノードのボード上位置情報。ポリモーフィック参照（Scene/Note → `tree_node_id`、Codex → `codex_entry_id`、Snippet → `snippet_id`、Sticky → `sticky_id`、AI Branch → `ai_branch_id`）。

```sql
CREATE TABLE map_node_positions (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  node_ref_type   TEXT NOT NULL
                    CHECK(node_ref_type IN ('scene','codex','snippet','note','sticky','ai_branch')),
  tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
  sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,
  ai_branch_id    TEXT REFERENCES map_ai_branches(id) ON DELETE CASCADE,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,  -- 1 if pinned in gravity modes
  z_index         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1段目: 5つのFKのうちちょうど1つが non-null
  CHECK (
    (CASE WHEN tree_node_id   IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN sticky_id      IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN ai_branch_id   IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  -- 2段目: node_ref_type と non-null FK カラムの対応を保証
  CHECK (
    (node_ref_type IN ('scene','note') AND tree_node_id   IS NOT NULL) OR
    (node_ref_type = 'codex'           AND codex_entry_id IS NOT NULL) OR
    (node_ref_type = 'snippet'         AND snippet_id     IS NOT NULL) OR
    (node_ref_type = 'sticky'          AND sticky_id      IS NOT NULL) OR
    (node_ref_type = 'ai_branch'       AND ai_branch_id   IS NOT NULL)
  )
);

CREATE INDEX idx_map_pos_board ON map_node_positions(board_id);
-- SQLite の NULL 意味論: NULLを含む複合UNIQUE INDEXでは一意性が保証されないため、タイプ別部分インデックスで分割
CREATE UNIQUE INDEX idx_map_pos_uniq_scene   ON map_node_positions(board_id, tree_node_id)
  WHERE tree_node_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_codex   ON map_node_positions(board_id, codex_entry_id)
  WHERE codex_entry_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_snippet ON map_node_positions(board_id, snippet_id)
  WHERE snippet_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_sticky  ON map_node_positions(board_id, sticky_id)
  WHERE sticky_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_ai      ON map_node_positions(board_id, ai_branch_id)
  WHERE ai_branch_id IS NOT NULL;
```

**設計判断**:
- `node_ref_type` と FK カラムの対応は2段CHECKで検証。`node_ref_type='scene'` のとき `tree_nodes.node_type='scene'`（note行でない）であることは SQL では検証不可のため**アプリ層で担保する**
- UNIQUE制約はタイプ別部分インデックスで実現（SQLite NULL 意味論対応）
- `hidden` カラムは廃止。非表示はアプリ層のビューポートフィルタで制御

### map_edges

ユーザー描画エッジ。参照先は `map_node_positions.id`（ボード跨ぎエッジを禁止）。双方向ラベルと複数ラベルに対応。

```sql
CREATE TABLE map_edges (
  id                  TEXT PRIMARY KEY,
  board_id            TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  from_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  to_position_id      TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  forward_label       TEXT,                       -- from→to 方向のラベル
  backward_label      TEXT,                       -- to→from 方向のラベル（双方向エッジ用）
  labels              TEXT NOT NULL DEFAULT '[]', -- JSON string[]: 追加ラベル配列
  style               TEXT NOT NULL DEFAULT 'solid'
                        CHECK(style IN ('solid', 'dashed', 'dotted')),
  color               TEXT NOT NULL DEFAULT '#000000',
  direction           TEXT NOT NULL DEFAULT 'none'
                        CHECK(direction IN ('none', 'forward', 'bidirectional')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_edges_board ON map_edges(board_id);
CREATE INDEX idx_map_edges_from  ON map_edges(from_position_id);
CREATE INDEX idx_map_edges_to    ON map_edges(to_position_id);
```

### map_frames

フレーム（グループ化矩形）。ノードとの親子関係はDBに持たず、位置の重なりで判定。

```sql
CREATE TABLE map_frames (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'Frame',
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  width         REAL NOT NULL,
  height        REAL NOT NULL,
  background    TEXT NOT NULL DEFAULT '#f5f5f5',
  border_color  TEXT NOT NULL DEFAULT '#cccccc',
  z_index       INTEGER NOT NULL DEFAULT -1,  -- デフォルトでノードの下
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_frames_board ON map_frames(board_id);
```

### map_stickies

Map専用の付箋ノード。本文は ProseMirror JSON。カラーは `(palette_id, color_slot)` で参照し、パレット定義はコード側（`src/lib/stickyPalettes.ts`）に置く。`ai_branch_id` が非 NULL の場合は AI 生成付箋。

```sql
CREATE TABLE map_stickies (
  id                     TEXT PRIMARY KEY,
  board_id               TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  title                  TEXT,
  body                   TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',
  preview_text           TEXT,           -- プレーンテキストキャッシュ（検索・ツールチップ用）
  palette_id             TEXT NOT NULL DEFAULT 'post-it-playful',
  color_slot             INTEGER NOT NULL DEFAULT 0 CHECK(color_slot >= 0),
  ai_branch_id           TEXT REFERENCES map_ai_branches(id) ON DELETE SET NULL,
  source_chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_stickies_board     ON map_stickies(board_id);
CREATE INDEX idx_map_stickies_ai_branch ON map_stickies(ai_branch_id);
CREATE INDEX idx_map_stickies_chat_msg  ON map_stickies(source_chat_message_id)
  WHERE source_chat_message_id IS NOT NULL;
```

### map_ai_branches

Map AI生成ブランチ。プロンプトとシードノードを保持し、生成結果は `map_stickies` の行として作成される。`session_id` は削除時 SET NULL（セッション削除後もブランチは残るが再実行は無効化される）。

```sql
CREATE TABLE map_ai_branches (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL,
  seed_node_ids TEXT NOT NULL DEFAULT '[]',  -- JSON string[]: 生成の参照元ノードID一覧
  session_id    TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  model         TEXT,
  token_usage   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_ai_branches_board ON map_ai_branches(board_id);
```

### 初期化・マイグレーション方針

- プロジェクト作成時に `map_boards` へ `title = 'Main'` の行を1行シードする
- v1 では追加ボードの作成を禁止（UIに追加ボタンを出さない）
- v2 で複数ボード対応時に `map_boards` の `sort_order` インデックスと UI を追加

---

## Matrix / Grid パネル導入に伴う追加（2026-04-30）

Matrix（シーン × Codex のクロス表）と Grid（Chapter 単位のカード列ビュー）の Phase A 実装に伴い、以下のテーブル / カラムを追加する。詳細は [Matrix パネル設計書](./Grimodex_Matrixパネル設計書.md) と [Grid パネル設計書](./Grimodex_Gridパネル設計書.md) を参照。

### scene_codex_pins

シーン × Codex の**明示的リレーション**。Matrix の「Pin to scene」「Add scene to chapter (with this codex)」、Grid のカード Codex チップの保存先。Codex Quick の project-wide pin（既存 `codex_quick_pins`）とは別物。

```sql
CREATE TABLE scene_codex_pins (
  scene_id   TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  entry_id   TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scene_id, entry_id)
);

CREATE INDEX idx_scene_codex_pins_scene ON scene_codex_pins(scene_id);
CREATE INDEX idx_scene_codex_pins_entry ON scene_codex_pins(entry_id);
```

このテーブルは下記 `scene_codex_mentions` キャッシュの `source = 'relation'` 行の一次ソースになる（同期更新）。

### scene_codex_mentions

シーン × Codex の**言及スキャンキャッシュ**。Matrix が表示時に毎回全走査するのを避けるための永続化キャッシュ。`source` カラムで根拠を区別し、`role` カラムで Beat メンション役割（Phase B 以降で値を埋める）を保持する。

```sql
CREATE TABLE scene_codex_mentions (
  scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,                      -- 'body' | 'beat' | 'relation'
  role            TEXT NOT NULL DEFAULT 'mentioned',  -- 'mentioned' | 'actor' | 'target'
  PRIMARY KEY (scene_id, codex_entry_id, source)
);

CREATE INDEX idx_scm_codex ON scene_codex_mentions(codex_entry_id);
CREATE INDEX idx_scm_scene  ON scene_codex_mentions(scene_id);
```

更新タイミング：

- **シーン保存時**: 該当シーン行を全 Codex に対して再計算（既存の保存パイプラインに hook）
- **Codex エントリ追加 / rename / alias 変更**: **該当 Codex 1件のパターンだけ**を対象として全シーンを非同期スキャン。他 Codex の行は触らない
- **Codex エントリ削除**: `ON DELETE CASCADE` で自動削除
- **scene_codex_pins 変更**: 該当ペアの `source = 'relation'` 行を同期更新

部分再スキャンの理論的限界（rename 後パターンが他 Codex と最長一致で衝突する稀なケース）は、Settings → Data → "Codex 言及キャッシュを再構築" ボタン（Phase A から提供）で全 Codex × 全シーンの完全再スキャンを手動実行できる。詳細は Matrix 設計書参照。

`role` カラムの値域は `'mentioned' | 'actor' | 'target'`（POV は含めない）。`source='body'` / `'relation'` の行は常に `'mentioned'` 固定で、`source='beat'` の行のみ Phase B で actor/target が入る（同一シーン × 同一 Codex の複数 beat に役割が分かれる場合は優先順位 actor > target > mentioned で最強値を保持）。POV はこのテーブルには含めず、シーン POV は `tree_nodes.pov_character_id` を直接参照、Beat POV（Phase B+）は本文 docJson から導出する。

### tree_nodes.unplaced_beats_doc（カラム追加）

Unplaced beat の保存先。本文 (`tree_nodes.content`) とは独立した別カラムとして扱う。ProseMirror JSON 配列形式：

```sql
ALTER TABLE tree_nodes ADD COLUMN unplaced_beats_doc TEXT NOT NULL DEFAULT '[]';
-- 値の形式: [
--   { "id": "u1", "beatType": "free", "pov": null, "collapsed": false, "content": [/* PM inline */] },
--   { "id": "u2", "beatType": "setting", "pov": null, "collapsed": false, "content": [...] }
-- ]
```

設計判断は Beat 設計書「Placed beat は TipTap ノード、Unplaced beat は別カラム」セクション参照。要点：

- Unplaced は本文中の位置を持たないため、本文 PM ドキュメント内に置く必然性が無い
- ProseMirror で「ドキュメント内に存在するが Editor キャンバスから描画除外」を実現すると selection / D&D / Undo の挙動が複雑化するため、カラム分離して独立 TipTap editor で素直に書く
- 同じ `tree_nodes` 行内のカラムなので、本文と Unplaced の保存単位は変わらない（既存の保存パイプラインを1フィールド拡張するだけ）

### tree_nodes.unplaced_beat_preview（カラム追加）

Grid のカードに表示する Unplaced beat 冒頭3件のキャッシュ。シーン保存時にフロント側が `unplaced_beats_doc` から抽出して値を同梱し、バックエンドはそのまま保存する（中身を解釈しない）。値が NULL のシーンはカードの beat 行を描画しない。

```sql
ALTER TABLE tree_nodes ADD COLUMN unplaced_beat_preview TEXT;
-- 値の形式: '["雨の夜、廃社の前で立ち止まる朱音","祭壇に置かれた朱紐","..."]'
-- NULL or '[]' なら Grid カードに beat 行は描画しない
```

抽出責任をフロント側に置く理由は Grid 設計書参照（schema drift 防止 / 単一フロント前提 / 整合性破綻が致命的でない）。lazy 再計算は v1 では実装しない（次回保存時に自然に埋まる）。

### tree_nodes.char_count（カラム追加）

Grid のステータスバー集計（合計文字数）に使うキャッシュ。シーン保存時にフロント側が CharacterCount 拡張の値を同梱する：

```sql
ALTER TABLE tree_nodes ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;
```

ライブ表示は `Σ persisted_char_count - persisted[active_scene] + live_count(active_editor)` で組む（アクティブシーン以外は保存時の値で十分）。

### Beat システム設計書との関係

Placed beat は **TipTap ProseMirror JSON 内のカスタムノード**（`sceneBeat` / `generatedProseBlock`）として `tree_nodes.content` に保存される。Unplaced beat は **`tree_nodes.unplaced_beats_doc` カラム**に保存される（上記）。**専用テーブルは作らない**。生成統計（プロンプトトークン数、モデル名）の永続化が必要になった場合のみ、将来 `scene_beats` テーブルを別途追加する余地を残す（v1 では実装しない、Beat システム設計書 Phase E 参照）。

`generatedProseBlock` ノードは生成 prose を beat ID（`beatId` attr）と紐付けてラップする block-level node。AuthorshipMark（inline mark）と直交するレイヤーで動作するため干渉しない。詳細は Beat 設計書「AuthorshipMark との関係」参照。

### Subplot のスキーマ変更は不要

Subplot は Codex の `lore` タイプ + `#subplot` タグで運用するため、新規テーブル / カラムは不要。`codex_tags` / `codex_entry_tags` の既存仕組みをそのまま使う。Settings の `subplotTagName`（global-settings.json）でタグ名のカスタマイズに対応する。

### 初期化・マイグレーション方針

- 既存プロジェクトには `unplaced_beats_doc` を `'[]'`、`unplaced_beat_preview`/`placed_beat_preview` を `NULL`、`char_count` を `0` で追加（`add_column_if_missing` による追加的マイグレーション）
- `unplaced_beats_doc` / `unplaced_beat_preview` / `placed_beat_preview` / `char_count` は次回シーン保存時にフロントが正しい値を同梱して埋める
- `scene_codex_pins` / `scene_codex_mentions` は空のテーブルとして作成（既存データ移行は不要）
- Matrix を最初に開いたとき、未スキャンシーンを検出すると進捗バナーを出してバックグラウンドスキャンする

---

## ラベルシステム（2026-05-07 追加）

ツリーノード（Scene/Note/Folder）にカラーラベルを付ける M:N リレーション。Codex タグとは独立したプロジェクトスコープのカラーシステム。

### labels

```sql
CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,         -- パレットスロット名 (例: 'red', 'blue')
  sort_order  REAL NOT NULL DEFAULT 0.0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);

CREATE INDEX idx_labels_project ON labels(project_id);
```

### tree_node_labels

```sql
CREATE TABLE tree_node_labels (
  node_id  TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, label_id)
);

CREATE INDEX idx_tree_node_labels_label ON tree_node_labels(label_id);
```

---

## Lint機能（2026-05-07 追加）

Lintパネルの永続化データ。診断エンジン（Rust）・フロント（React）とのやり取りに使用。

### lint_ignored_diagnostics

特定のルール×テキスト断片を永続的に無視するリスト（Phase 2+）。`text_snippet` + `context_before`/`context_after` で出現箇所をフィンガープリントする。

```sql
CREATE TABLE lint_ignored_diagnostics (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT NOT NULL,
  scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  text_snippet    TEXT NOT NULL,
  context_before  TEXT NOT NULL,
  context_after   TEXT NOT NULL,
  note            TEXT,
  created_at      INTEGER NOT NULL   -- Unix timestamp (ms)
);

CREATE INDEX idx_lint_ignored_scene ON lint_ignored_diagnostics(scene_id);
CREATE INDEX idx_lint_ignored_rule  ON lint_ignored_diagnostics(rule_id);
```

### lint_term_dictionary

プロジェクトスコープの用語辞書。`variants` は JSON string[] で、CRUD 層が重複排除・エスケープ処理を行う。`severity` は `'warning' | 'info'`（DB 制約なし、アプリ層で検証）。

```sql
CREATE TABLE lint_term_dictionary (
  id         TEXT PRIMARY KEY,
  preferred  TEXT NOT NULL,          -- 正規表記
  variants   TEXT NOT NULL,          -- JSON string[]: ゆれ表記一覧
  severity   TEXT NOT NULL DEFAULT 'warning',
  note       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,  -- 0: 無効化（削除せず保持）
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,       -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_lint_term_dict_preferred ON lint_term_dictionary(preferred);
CREATE INDEX idx_lint_term_dict_sort      ON lint_term_dictionary(sort_order);
```

### lint_action_log

Lint アクション履歴（Phase 2-3）。自己チューニング統計（「この診断を 80% の確率で無視している」など）に使用する追記専用ログ。シーン削除時は `scene_id` が NULL になるが履歴レコード自体は保持される（ON DELETE SET NULL）。

```sql
CREATE TABLE lint_action_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL,
  action      TEXT NOT NULL,   -- 'detected'|'fixed'|'ignored_once'|'ignored_persistent_set'|
                               --  'ignored_persistent_unset'|'disabled_inline'
  scene_id    TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
  occurred_at INTEGER NOT NULL  -- Unix timestamp (ms)
);

CREATE INDEX idx_lint_action_log_rule     ON lint_action_log(rule_id);
CREATE INDEX idx_lint_action_log_occurred ON lint_action_log(occurred_at);
```

---

## 伏線レジスタ（2026-05-07 追加）

payoff-anchored アーキテクチャで伏線と回収を管理。Phase 1〜5 実装済み、Phase 6（`load_bearing`）は検討中。詳細は [伏線レジスタ設計書](./Grimodex_伏線レジスタ設計書.md) 参照。

### foreshadows

伏線エントリ。payoff のアンカーはインライン（1:1）で `payoff_scene_id` + `payoff_from_pos`/`payoff_to_pos` に直接格納。

```sql
CREATE TABLE foreshadows (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  intent           TEXT,             -- 作者の意図メモ
  notes            TEXT,             -- 自由メモ
  payoff_scene_id  TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
  payoff_from_pos  INTEGER,
  payoff_to_pos    INTEGER,
  payoff_confirmed INTEGER NOT NULL DEFAULT 0,  -- 1: 回収確定
  abandoned        INTEGER NOT NULL DEFAULT 0,  -- 1: 放棄済み
  secret           INTEGER NOT NULL DEFAULT 1,  -- 1: 読者に明かさない伏線（既定）。新規 CREATE は 1、ALTER で追加された既存行は 0 にフォールバック
  load_bearing     TEXT,    -- Phase 6: 'critical'|'supporting'|'optional'|NULL
  created_at       INTEGER NOT NULL,  -- Unix timestamp (ms)
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_foreshadows_project     ON foreshadows(project_id);
CREATE INDEX idx_foreshadows_payoff_scene ON foreshadows(payoff_scene_id);
```

`secret` カラムは Phase 5 で追加された軸。新規 CREATE TABLE のデフォルトは `1`（秘匿あり）だが、後発の `add_column_if_missing` で既存 DB に追加された場合は `0` がフォールバック値となる（既存伏線の互換性確保のため）。アプリ層は新規作成時に明示的に値を書き込む。

### foreshadow_setups

伏線の撒きアンカー。1 つの伏線に複数の撒き箇所を持てる（1:多）。`is_orphan` は撒きテキストがシーン本文から消えたことを示す。

```sql
CREATE TABLE foreshadow_setups (
  id                 TEXT PRIMARY KEY,
  foreshadow_id      TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
  scene_id           TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  from_pos           INTEGER NOT NULL,
  to_pos             INTEGER NOT NULL,
  kind               TEXT NOT NULL,   -- 'designated_existing'|'inserted_new'|'rewritten'
  strength           TEXT,            -- 'subtle'|'moderate'|'overt'|NULL（ユーザー評価）
  ai_strength        TEXT,            -- AI評価
  ai_reasoning       TEXT,
  attribution        TEXT NOT NULL DEFAULT 'human',
  ai_rationale       TEXT,
  last_evaluated_at  INTEGER,         -- Unix timestamp (ms)
  is_orphan          INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX idx_fs_setup_fid    ON foreshadow_setups(foreshadow_id);
CREATE INDEX idx_fs_setup_scene  ON foreshadow_setups(scene_id);
CREATE INDEX idx_fs_setup_orphan ON foreshadow_setups(is_orphan);
```

### foreshadow_codex_links

伏線と関連 Codex エントリの多対多リレーション。

```sql
CREATE TABLE foreshadow_codex_links (
  foreshadow_id   TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
  codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (foreshadow_id, codex_entry_id)
);

CREATE INDEX idx_fs_codex_codex ON foreshadow_codex_links(codex_entry_id);
```

---

## Beat / Matrix 関連キャッシュ（2026-05-07 追加）

### scene_beat_pov_cache

Beat レベル POV キャラクターの集約キャッシュ。Beat の POV 指定を beat ノードの `pov` 属性から導出し、Matrix の ★ 表示に使用する。`tree_nodes.pov_character_id`（シーン全体 POV）とは独立。

```sql
CREATE TABLE scene_beat_pov_cache (
  scene_id          TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  pov_character_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (scene_id, pov_character_id)
);

CREATE INDEX idx_scene_beat_pov_scene ON scene_beat_pov_cache(scene_id);
```

---

## スキーマ更新履歴（2026-05-07）

現状コードベース（`src/db/schema.ts` + `src-tauri/crates/grimodex-db/`）と設計書の乖離を解消。

### 追加テーブル（設計書に未記載だったもの）

| テーブル | 追加理由 |
|---------|---------|
| `labels` / `tree_node_labels` | ツリーノードラベルシステム実装済みだが設計書に記載なし |
| `lint_ignored_diagnostics` | Lint Phase 2 実装済みだが設計書に記載なし |
| `lint_term_dictionary` | 用語辞書実装済みだが設計書に記載なし |
| `lint_action_log` | Lint イベントログ実装済みだが設計書に記載なし |
| `foreshadows` / `foreshadow_setups` / `foreshadow_codex_links` | 伏線レジスタ実装済みだが設計書に記載なし |
| `scene_beat_pov_cache` | Beat POV キャッシュ実装済みだが設計書に記載なし |
| `map_stickies` | Map付箋機能実装済みだが設計書に記載なし |
| `map_ai_branches` | `map_ai_nodes` を置き換える形で実装 |

### 変更されたテーブル定義

| テーブル | 変更内容 |
|---------|---------|
| `tree_nodes` | `placed_beat_preview TEXT` カラム追加（設計書未記載） |
| `tree_nodes` | `pov_character_id`/`location_id` の "Phase C-2 で追加" 注釈を削除（実装済み） |
| `map_boards` | `mode`/`viewport_x`/`viewport_y`/`viewport_zoom`/`show_config`/`color_by` カラム追加 |
| `map_node_positions` | `node_ref_type` を `('scene','codex','snippet','note','sticky','ai_branch')` に拡張；`ai_node_id` → `snippet_id`+`sticky_id`+`ai_branch_id` に分離；`hidden` カラム削除；UNIQUE インデックス対応追加 |
| `map_edges` | `label` → `forward_label`+`backward_label`+`labels` に変更（双方向ラベル対応） |
| `map_ai_nodes` | `map_ai_branches` に改名。`response` カラム削除、`seed_node_ids` 追加 |
| `scene_codex_pins` | `codex_entry_id` → `entry_id` に修正；インデックス名を `by_scene/by_codex` → `scene/entry` に統一 |
| `scene_codex_mentions` | `mention_count`/`last_scanned_at` カラム削除（実装では不使用）；インデックス名修正 |

---

## PostEffects テーブル群（2026-05-16 追記）

「書き換えずに注釈を重ねる」AI パスの実行単位と成果物。詳細は [PostEffects 設計書](./Grimodex_PostEffects設計書.md)。すべての CHECK 制約と FTS5 仮想テーブル / トリガーは Rust 側 `migrate.rs` に直書きされる（Drizzle では表現できないため）。

### post_effect_runs

ポストエフェクトの実行単位。`scope_type` で対象範囲（scene / folder / project）を、`effect_type` でレビュー種別を区別する。同一 `(project_id, effect_type, scope_type, scope_target_id)` で `running` が同時 2 本走るのを部分 UNIQUE で禁止。

```sql
CREATE TABLE post_effect_runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  effect_type     TEXT NOT NULL
                    CHECK(effect_type IN ('review','pseudo_comment','meta_structure','consistency','intra_scene_consistency',
                                          'typo_detection','intent_drift','timeline_consistency','impact_review')),
                                          -- 2026-05-26〜06-18 に typo_detection / intent_drift / timeline_consistency / impact_review を追加。
                                          -- 既存DBは migrate_post_effect_*_categories が CHECK 文字列を置換して遅延拡張（置換不能なら no-op + warn）
  scope_type      TEXT NOT NULL CHECK(scope_type IN ('scene','folder','project')),
  scope_target_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,  -- project スコープでは NULL
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  input_hash      TEXT,                -- 入力スナップショットのハッシュ（同入力の重複検出用）
  status          TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
  summary         TEXT,
  error_message   TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX idx_runs_project_effect
  ON post_effect_runs(project_id, effect_type, started_at DESC);

-- 同じスコープで running が複数走らないように制御する部分 UNIQUE。
-- SQLite は NULL を distinct 扱いするため COALESCE で空文字へ正規化して
-- project 全体スコープ（scope_target_id IS NULL）も単一性を保つ。
CREATE UNIQUE INDEX idx_runs_running_scope
  ON post_effect_runs(project_id, effect_type, scope_type, COALESCE(scope_target_id, ''))
  WHERE status = 'running';
```

**クラッシュリカバリ**: アプリ起動時に `running` のまま残っている run を `failed` へ遷移させる UPDATE が `migrate()` の末尾で走る（次回起動が UNIQUE 制約でブロックされるのを防ぐ）。

### post_effect_annotations

ポストエフェクトの注釈成果物。シーン上の範囲（PM 位置 / バイトオフセット）にアンカーされる注釈で、`parent_id` で親子スレッドを構成できる（pseudo_comment のリプライ等）。

```sql
CREATE TABLE post_effect_annotations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id         TEXT REFERENCES post_effect_runs(id) ON DELETE SET NULL,  -- NULL = ユーザー手動メモ用枠（MVP は AI 生成のみ）
  anchor_type    TEXT NOT NULL DEFAULT 'scene_range'
                   CHECK(anchor_type IN ('scene_range','codex_entry','synopsis')),
  scene_id       TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  range_start    INTEGER,   -- ソース次第で PM position or 正規化プレーンテキストへの byte offset
  range_end      INTEGER,
  text_snapshot  TEXT,      -- アンカー時点のテキスト（表示時に PM 位置を再解決する基準）
  category       TEXT NOT NULL
                   CHECK(category IN ('review','pseudo_comment','consistency_anchor','foreshadow_anchor','theme_anchor',
                                      'typo_anchor','intent_anchor','timeline_anchor','impact_review_anchor')),
                                      -- effect_type の拡張に対応して typo_anchor / intent_anchor / timeline_anchor / impact_review_anchor を追加
  persona        TEXT,
  severity       TEXT CHECK(severity IS NULL OR severity IN ('info','suggestion','warning','error')),
  content        TEXT NOT NULL,
  author_role    TEXT NOT NULL DEFAULT 'ai' CHECK(author_role IN ('ai','user','system')),
  parent_id      TEXT REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
  metadata       TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pea_scene  ON post_effect_annotations(project_id, scene_id, status);
CREATE INDEX idx_pea_run    ON post_effect_annotations(run_id);
CREATE INDEX idx_pea_parent ON post_effect_annotations(parent_id);
```

**`range_start` / `range_end` の意味論はソースによってブレる**:
- Rust の consistency runner (`post_effect.rs::find_text_position`) は **正規化済みプレーンテキストへの byte offset** を書き込む。
- JS の `saveAnnotationAnchors` (`syncAnnotations.ts`) は **PM position** を書き込む。
- 表示時は `text_snapshot` から PM 位置を再解決する（`post-effect/resolveAnnotationRange.ts`）。`range_*` は曖昧マッチ時の近傍ヒントのみ。

### post_effect_annotations_fts

注釈 `content` の横断検索用 FTS5 仮想テーブル。trigram トークナイザー。

```sql
CREATE VIRTUAL TABLE post_effect_annotations_fts USING fts5(
  content,
  content=post_effect_annotations, content_rowid=rowid,
  tokenize='trigram'
);

CREATE TRIGGER post_effect_annotations_fts_ai AFTER INSERT ON post_effect_annotations BEGIN
  INSERT INTO post_effect_annotations_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER post_effect_annotations_fts_ad AFTER DELETE ON post_effect_annotations BEGIN
  INSERT INTO post_effect_annotations_fts(post_effect_annotations_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER post_effect_annotations_fts_au AFTER UPDATE ON post_effect_annotations
  WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO post_effect_annotations_fts(post_effect_annotations_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO post_effect_annotations_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

### post_effect_annotation_relations

注釈間の関係。`relation_type` で `contradiction`（矛盾）/ `foreshadowing`（伏線設置 ↔ 回収）/ `theme_echo`（テーマの呼応）を区別。`foreshadowing` は `direction = 'a_to_b'` 固定で `a` を setup、`b` を payoff として扱う。

```sql
CREATE TABLE post_effect_annotation_relations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id           TEXT REFERENCES post_effect_runs(id) ON DELETE SET NULL,
  annotation_a_id  TEXT NOT NULL REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
  annotation_b_id  TEXT NOT NULL REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
  relation_type    TEXT NOT NULL CHECK(relation_type IN ('contradiction','foreshadowing','theme_echo')),
  direction        TEXT NOT NULL DEFAULT 'bidirectional'
                     CHECK(direction IN ('bidirectional','a_to_b')),
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
  metadata         TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pear_a ON post_effect_annotation_relations(annotation_a_id);
CREATE INDEX idx_pear_b ON post_effect_annotation_relations(annotation_b_id);
```

### scene_lens_data

シーン単位のレンズ計測結果。`lens_type` ごとに `metrics`（数値 JSON）と `finding`（自然言語のサマリ）を持つ。

```sql
CREATE TABLE scene_lens_data (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES post_effect_runs(id) ON DELETE CASCADE,
  target_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  lens_type   TEXT NOT NULL CHECK(lens_type IN ('plot_structure','pacing','character_arc','pov')),
  metrics     TEXT NOT NULL DEFAULT '{}',         -- JSON: lens 固有の計測値
  finding     TEXT,                                -- 自然言語のまとめ（nullable）
  severity    TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','suggestion','warning','error')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_lens_run_target   ON scene_lens_data(run_id, target_id);
CREATE INDEX idx_lens_target_type  ON scene_lens_data(target_id, lens_type);
```

---

## Trash bin（2026-05-16 追記）

削除されたコンテンツを保持する物理ゴミ箱。Phase 1 は文字屑（テキスト断片）のみ書き込まれる。Phase 4-5 で構造アイテム（scene / codex-entry 等）にも拡張される予定。

### trash_items

```sql
CREATE TABLE trash_items (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,        -- 'text-fragment' | 'structure-item'
  sub_kind        TEXT NOT NULL,        -- 'text-fragment' / 'scene' / 'codex-entry' / ...
  origin_scene_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  origin_codex_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  preview_text    TEXT NOT NULL,        -- 一覧表示用の冒頭テキスト
  preview_meta    TEXT,                 -- JSON: 追加プレビュー情報（フォントカラー等）
  payload         TEXT NOT NULL,        -- JSON: 復元用の完全データ（ProseMirror JSON 等）
  char_count      INTEGER NOT NULL,
  is_interesting  INTEGER NOT NULL DEFAULT 0,  -- 1: 「気になる」フラグ（自動退避から保護）
  deleted_at      TEXT NOT NULL                -- 削除時刻（ISO 8601）
);

CREATE INDEX idx_trash_project_deleted
  ON trash_items(project_id, deleted_at DESC);
CREATE INDEX idx_trash_project_kind_deleted
  ON trash_items(project_id, kind, deleted_at DESC);
```

`payload` / `preview_meta` は素の TEXT で JSON 文字列を保持（`aiReasoning` と同じ流儀）。`origin_scene_id` / `origin_codex_id` は ON DELETE CASCADE なので、シーン本体や Codex エントリが削除されるとゴミ箱からも消える。シーン全体を消した瞬間にゴミ箱が空になるのは仕様（孤立した断片を残しても復元先がないため）。

---

## 自動シード / ポリモーフィック削除トリガー（2026-05-16 追記）

設計書では「プロジェクト作成時にビルトインタイプとデフォルト Map ボードをシード」と要件のみ書かれていたが、実装は SQL トリガーで実現している。これらは `migrate()` 内で永続的に登録される。

### seed_builtin_codex_types

新規 `projects` 行に対してビルトイン Codex タイプ 4 件（character / location / item / lore）をシードするトリガー。`is_builtin = 1` で削除不可。

```sql
CREATE TRIGGER seed_builtin_codex_types
AFTER INSERT ON projects BEGIN
    INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
      VALUES (new.id || '-character', new.id, 'character', 'キャラクター', '#534AB7', 0, 1, 0.0, datetime('now'));
    INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
      VALUES (new.id || '-location',  new.id, 'location',  '場所',         '#0F6E56', 1, 1, 1.0, datetime('now'));
    INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
      VALUES (new.id || '-item',      new.id, 'item',      'アイテム',     '#BA7517', 2, 1, 2.0, datetime('now'));
    INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, color, palette_index, is_builtin, sort_order, created_at)
      VALUES (new.id || '-lore',      new.id, 'lore',      '伝承',         '#993C1D', 3, 1, 3.0, datetime('now'));
END;
```

### seed_default_map_board

新規 `projects` 行に対して `title = 'Main'` の Map ボードを 1 件シードする。v1 は単一ボード固定（追加 UI を出さない）。

```sql
CREATE TRIGGER seed_default_map_board
AFTER INSERT ON projects BEGIN
    INSERT OR IGNORE INTO map_boards (id, project_id, title, sort_order, mode, viewport_x, viewport_y, viewport_zoom, show_config, color_by, created_at, updated_at)
      VALUES (new.id || '-main-board', new.id, 'Main', 0.0, 'free', 0, 0, 1.0, '{}', 'none', datetime('now'), datetime('now'));
END;
```

### delete_cv_on_*：content_versions のポリモーフィック連鎖削除

`content_versions` は `(entity_type, entity_id)` のポリモーフィックキーで複数エンティティを参照するため SQL FK が貼れない。そこで各所有テーブルの DELETE に AFTER トリガーを仕掛けて、対応するリビジョン履歴を連鎖削除する。

```sql
CREATE TRIGGER delete_cv_on_tree_node_delete
AFTER DELETE ON tree_nodes BEGIN
    DELETE FROM content_versions
      WHERE entity_type IN ('scene', 'note') AND entity_id = old.id;
END;

CREATE TRIGGER delete_cv_on_codex_entry_delete
AFTER DELETE ON codex_entries BEGIN
    DELETE FROM content_versions
      WHERE entity_type = 'codex_entry' AND entity_id = old.id;
END;

CREATE TRIGGER delete_cv_on_snippet_delete
AFTER DELETE ON snippets BEGIN
    DELETE FROM content_versions
      WHERE entity_type = 'snippet' AND entity_id = old.id;
END;
```

`project_snapshot_entries.version_id` は `ON DELETE RESTRICT` なので、スナップショットに参照されているリビジョンを所有エンティティ削除で連鎖的に消そうとすると（トリガー経由でも）SQLite が DELETE をブロックする。スナップショット運用上はこれが正しい挙動。

---

## スキーマ更新履歴（2026-05-16）

PostEffects パネル・Trash bin・projects テーブル拡張など、実装が先行していた領域を設計書に反映。

### 追加テーブル（設計書に未記載だったもの）

| テーブル | 追加理由 |
|---------|---------|
| `post_effect_runs` / `post_effect_annotations` / `post_effect_annotation_relations` / `scene_lens_data` | PostEffects パネル実装済みだが設計書に記載なし |
| `post_effect_annotations_fts` | 注釈 content の FTS5 検索インデックスを追加 |
| `trash_items` | 物理ゴミ箱（Phase 1）実装済みだが設計書に記載なし |

### 追加カラム（設計書に未記載だったもの）

| テーブル | カラム | 用途 |
|---------|-------|------|
| `projects` | `outline` | Phase 4: 物語全体の手書きアウトライン。AI コンテキスト L2 に常時注入 |
| `projects` | `ai_policy` | プロジェクト単位の AI 使用方針トグル（導入時は chat / bodyWrite / analysis の3トグル・既定 Full）。※その後 `structureWrite` / `knowledgeWrite` が追加され、既定も安全側の `preset='custom'`（structureWrite/knowledgeWrite=false）へ変更。最新は `projects` の DDL（`ai_policy` 節）を参照 |
| `projects` | `is_sample` | サンプルワークスペース判定フラグ。`EditorScreen` 初回オープン時の `SampleTour` 発火に使用 |
| `foreshadows` | `secret` | 読者に明かさない伏線フラグ。新規 CREATE は 1、`add_column_if_missing` 経由の既存行は 0 |

### 文書化されていなかったトリガー / 制約

| 項目 | 内容 |
|------|------|
| `seed_builtin_codex_types` | プロジェクト作成時にビルトイン Codex タイプ 4 件を自動投入する `AFTER INSERT ON projects` トリガー |
| `seed_default_map_board` | プロジェクト作成時にデフォルト Map ボード（title=Main）を 1 件投入するトリガー |
| `delete_cv_on_tree_node_delete` / `delete_cv_on_codex_entry_delete` / `delete_cv_on_snippet_delete` | `content_versions` のポリモーフィック連鎖削除（SQL FK では表現不能なので AFTER DELETE トリガーで代替） |
| `idx_runs_running_scope` | `post_effect_runs` の `running` ステータス同時 1 本制約（部分 UNIQUE + COALESCE で NULL を正規化） |
| 起動時の `running → failed` リカバリ | プロセス強制終了等で残った run を `migrate()` 末尾の UPDATE が `failed` に遷移させる |

### 文書上の調整

| 箇所 | 変更 |
|------|------|
| `tree_nodes` の DDL | `idx_tree_pov` / `idx_tree_location` から "Phase C-2 マイグレーションで追加" の注釈を削除（既に基本 migrate に統合済み） |
| `projects.language` | DEFAULT のみだったところを `NOT NULL DEFAULT 'ja'` に修正（実装に追従） |

---

## セマンティック検索 / RAG ベクトルインデックス（2026-06-18 追記）

本文・Codex・チャット履歴のセマンティック検索（RAG）用に、埋め込みベクトルを保持するテーブル群。いずれも ONNX で生成した L2 正規化済み埋め込みを BLOB で保持し、コサイン総当たりで検索する。詳細は [セマンティック検索設計書](./Grimodex_セマンティック検索設計書.md) / [閾値とモデル特性](./Grimodex_セマンティック検索の閾値とモデル特性.md)。Codex 本文の FTS index 化（`codex_fts.content`）は上の [codex_fts](#codex_fts) 節を参照。

### scene_chunks

本文（prose）シーンを分割した埋め込みチャンク。`chunk_index` 単位で本文を区切り、char 範囲・会話文比率（`dialogue_ratio`）・モデル/ハッシュ/チャンカーバージョンを保持する。Drizzle（`src/db/schema.ts`）と完全一致させる正本。

```sql
CREATE TABLE IF NOT EXISTS scene_chunks (
  id               TEXT PRIMARY KEY,
  scene_id         TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  chunk_index      INTEGER NOT NULL,
  text             TEXT NOT NULL,
  char_start       INTEGER NOT NULL,        -- 正規化プレーンテキスト内の開始 Unicode スカラー位置
  char_end         INTEGER NOT NULL,
  dialogue_ratio   REAL NOT NULL DEFAULT 0, -- 会話文の文字比率（0.0〜1.0）。description_mode 減点に使用
  embedding        BLOB NOT NULL,           -- f32 配列（little-endian）・L2 正規化済み
  embedding_dim    INTEGER NOT NULL,
  model_id         TEXT NOT NULL,           -- 例: cl-nagoya/ruri-v3-30m@<rev>/model_int8.onnx/prefix-v1
  content_hash     TEXT NOT NULL,           -- 本文から安定算出。非同期 job race の回避用
  chunker_version  TEXT NOT NULL,           -- 例: semantic-prose-chunker-v1。仕様変更で stale 判定
  created_at       INTEGER NOT NULL,        -- ms-since-epoch（Drizzle mode:'timestamp_ms'）
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scene_chunks_scene ON scene_chunks(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_chunks_model ON scene_chunks(model_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_scene_chunks_scene_index ON scene_chunks(scene_id, chunk_index);
```

### codex_chunks

Codex エントリのセマンティック検索（RAG）用ベクトル。Codex 本文は短いためチャンク分割せず **「1 エントリ = 1 埋め込み行」**（`PRIMARY KEY = entry_id`）。dense 埋め込みと sparse（FTS5/bm25）を RRF 融合する Codex hybrid 検索（`fuseCodexHybrid`）と、impact-review の embeddings 絞り込みに使う。**Rust 専用テーブル**（`scene_chunks` 等と同じく Drizzle には定義されない）。

```sql
CREATE TABLE IF NOT EXISTS codex_chunks (
  entry_id         TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
  entry_name       TEXT NOT NULL,           -- 検索結果表示用に非正規化保持
  entry_type       TEXT NOT NULL,           -- フィルタ/表示用に非正規化保持
  text             TEXT NOT NULL,           -- 埋め込み生成に使ったソース本文
  embedding        BLOB NOT NULL,
  embedding_dim    INTEGER NOT NULL,
  model_id         TEXT NOT NULL,           -- 再生成判定・索引フィルタ用
  content_hash     TEXT NOT NULL,           -- 内容変化検知（再埋め込み要否）
  chunker_version  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_chunks_model ON codex_chunks(model_id);
```

### chat_message_chunks

チャット履歴のエピソード記憶（過去の対話）を scene/codex と同じ意味検索経路で recall するための埋め込み表。チャットメッセージは短いためチャンク分割せず **「1 メッセージ = 1 埋め込み行」**（`PRIMARY KEY = message_id`・`INSERT OR REPLACE`）。`chat_messages` には `project_id` が無いので、検索スコープ（grimodex.db 単位）を効かせるため `project_id` / `session_id` を index 時に**非正規化**して持つ（`chat_sessions` JOIN を読み出し時に省く）。`inserted_to_editor` / `extracted_count` は「実際に効いた発話」を recall で重み付けするための信号（`chat_messages.metadata` から非正規化）で、signal が変わると `content_hash` も変わるよう upsert 側で hash 入力に含め、再 index で列が更新される。**Rust 専用テーブル**（`codex_chunks` 等と同じく Drizzle には定義されない）。hybrid 検索（dense + sparse）は新規 FTS 表を作らず既存の [`chat_messages_fts`](#chat_messages_fts) を再利用する（PR #135 / `c37e6212`, 2026-06-20）。

```sql
CREATE TABLE IF NOT EXISTS chat_message_chunks (
  message_id         TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,           -- index 時に非正規化（読み出しで chat_sessions JOIN を省く）
  project_id         TEXT NOT NULL,           -- 検索スコープ（grimodex.db 単位）。XPROJ 防止のため非正規化保持
  role               TEXT NOT NULL,           -- user / assistant 等（recall の順序・表示用）
  text               TEXT NOT NULL,           -- 埋め込み生成に使ったソース発話
  inserted_to_editor INTEGER NOT NULL DEFAULT 0, -- 「実際に効いた発話」信号（metadata から非正規化）
  extracted_count    INTEGER NOT NULL DEFAULT 0, -- 抽出された回数の信号（同上）
  embedding          BLOB NOT NULL,           -- f32 配列（little-endian）・L2 正規化済み
  embedding_dim      INTEGER NOT NULL,
  model_id           TEXT NOT NULL,           -- 再生成判定・索引フィルタ用
  content_hash       TEXT NOT NULL,           -- 本文 + signal 列から算出。signal 変化で再 index される（stale-weight 回避）
  chunker_version    TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_message_chunks_project ON chat_message_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_chunks_model   ON chat_message_chunks(model_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_chunks_session ON chat_message_chunks(session_id);
```

---

## 執筆タイムラプス / レコーダー（2026-05-29 実装 / 2026-06-18 追記）

執筆過程を append-only で記録し、後から再生（タイムラプス）するための変更イベントログとリプレイアンカー。詳細は [執筆タイムラプス設計書](./Grimodex_執筆タイムラプス設計書.md)。採番・ハッシュチェーンは Rust 権威化（`change_events.rs::append_change_events_in_tx`）、書き込みウィンドウは `src/features/timelapse/recorder.ts`。

### change_events

各ドメイン（editor/codex/snippet/grid/map/synopsis/intent/beat/chat/layout/prose 等）の操作を、`(project_id, sequence)` で単調増加させつつ sha256 の `prev_hash → hash` チェーンで改ざん検知可能に記録する正本ログ。`state_snapshots` とペアで動作する。

```sql
CREATE TABLE IF NOT EXISTS change_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid    TEXT,                  -- イベント冪等キー。UNIQUE(project_id, event_uid)。レガシーDBは後付けで全 NULL
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id     TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
  domain       TEXT NOT NULL,         -- 変更ドメイン
  op_type      TEXT NOT NULL,         -- 操作種別（挿入/更新/削除など）
  entity_type  TEXT,
  entity_id    TEXT,
  payload      TEXT NOT NULL,         -- 変更内容の JSON ペイロード
  session_id   TEXT NOT NULL,         -- 連続実行（セッション）識別。再生スナップショットのヒューリスティクス用
  sequence     INTEGER NOT NULL,      -- project 内で単調増加。Rust 側で採番（権威化）
  timestamp    INTEGER NOT NULL,
  prev_hash    TEXT NOT NULL,         -- 直前イベントの sha256（hex TEXT）
  hash         TEXT NOT NULL          -- 当該イベントの sha256（hex TEXT）
);

CREATE INDEX IF NOT EXISTS idx_change_events_project_ts ON change_events(project_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_change_events_scene_ts   ON change_events(scene_id, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_events_project_seq ON change_events(project_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_events_project_uid ON change_events(project_id, event_uid);
```

> `event_uid` は CREATE 本体に含まれるが、導入前のレガシー DB 救済のため CREATE 直後に `add_column_if_missing` で冪等に後付けされる。`uq_change_events_project_uid` は列追加の **後** に別バッチで作る必要がある（レガシー DB では in-batch だと「no such column」で失敗。`IF NOT EXISTS` は列解決エラーを抑止しない）。`prev_hash`/`hash` は drizzle sqlite-proxy が BLOB をラウンドトリップできないため hex TEXT で保持。

### state_snapshots

リプレイ起点アンカー。`change_events` の forward 適用だけでは過去 doc を逆算できないため、「`anchor_sequence` 以下のイベントを適用した後の状態」を `payload`（PM-JSON 等）として保存し、replay の seek 起点に使う。**v1 では production caller が存在せず常に空（latent）**で、baseline 焼き込み配線は今後の課題。

```sql
CREATE TABLE IF NOT EXISTS state_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain            TEXT NOT NULL,
  entity_type       TEXT,
  entity_id         TEXT,
  anchor_sequence   INTEGER NOT NULL,  -- sequence<=この値の change_event 適用後の状態
  anchor_timestamp  INTEGER NOT NULL,
  payload           TEXT NOT NULL,     -- 直列化スナップショット（v1 は PM-JSON 文字列。BLOB を避け TEXT 格納）
  encoding          TEXT NOT NULL DEFAULT 'json',  -- 既定 'json'（将来 gzip/zstd 分岐を想定）
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_snap_project_seq ON state_snapshots(project_id, anchor_sequence);
CREATE INDEX IF NOT EXISTS idx_state_snap_domain_seq  ON state_snapshots(project_id, domain, anchor_sequence);
```

---

## AI 書き込み基盤（tracked write）（2026-06-06 実装 / 2026-06-18 追記）

AI / エージェントによる「追跡付き書き込み（tracked write）」の取り消し・段階適用を支える基盤。`migrate_ai_write_infrastructure` で一括作成される。詳細は [AI による書き込み横断検討](./Grimodex_AIによる書き込み横断検討.md) / [AI エージェント設計書](./Grimodex_AIエージェント設計書.md)。

### undo_journal

1 書き込み操作ごとに、対象エンティティの `before_json` / `after_json` と `base_version → result_version`、対応する `change_event_uid` を記録し、後から逆操作で巻き戻せるようにする前後状態ジャーナル。**Rust 専用テーブル**（挿入は `undo_journal.rs::insert_undo_journal_in_tx`）。

```sql
CREATE TABLE IF NOT EXISTS undo_journal (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface             TEXT NOT NULL,      -- 書き込み発生サーフェス（in-app Agent / MCP 等）
  entity_kind         TEXT NOT NULL,      -- codex / foreshadow / snippet など
  entity_id           TEXT NOT NULL,
  op_kind             TEXT NOT NULL,      -- create / update / delete 等
  before_json         TEXT,               -- 操作前スナップショット（undo に使用）
  after_json          TEXT,
  base_version        INTEGER NOT NULL,   -- 操作開始時のバージョン（楽観ロック基点）
  result_version      INTEGER NOT NULL,
  change_event_uid    TEXT,               -- 対応する change_event の UID
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_undo_journal_project_entity ON undo_journal(project_id, entity_kind, entity_id);
```

### prose_staging

AI（Agent / MCP / inline）が生成した本文 prose を「提案（staged）」として一旦溜め、人間が diff UI で accept/reject するための二相書き込みの中間テーブル。`propose_scene_body` 等は本文へ直接書かず本テーブルに積み、accept で `tree_nodes` 本文へ反映、discard で破棄（AI 書き込み Phase 5）。

```sql
CREATE TABLE IF NOT EXISTS prose_staging (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id            TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  proposed_content    TEXT NOT NULL,
  base_version        INTEGER NOT NULL,   -- 提案が基づいた本文バージョン（競合検出用）
  status              TEXT NOT NULL DEFAULT 'proposed'
                        CHECK(status IN ('proposed','accepted','discarded')),
  source_surface      TEXT NOT NULL,      -- Agent / MCP / inline 等
  source_session_id   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prose_staging_project_scene ON prose_staging(project_id, scene_id, status);
```

### codex_entries / snippets / tree_nodes.version（カラム追加）

AI 書き込みの楽観ロック用にバージョンカウンタを追加（`undo_journal.base_version` / `result_version` の基準）。**いずれも Rust（`migrate.rs`）のみで管理し、Drizzle `schema.ts` には未反映**。

```sql
ALTER TABLE tree_nodes    ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE codex_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snippets      ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
```

---

## AI 使用量・生成出自ログ（2026-06-18 追記）

### ai_usage

N4「横断トークン使用量台帳」。全 AI 生成サーフェス（chat / agent / map_branch / tree_scaffold / beat / foreshadow / inline_ai / synopsis / session_title / summarization / context_creator）を横断し、1 回の LLM 生成につき 1 行を追記専用で記録する。usage 非対応のストリーミングや中断でも呼び出し回数を数えるため、トークン/コスト列は null 許容。`recordAiUsage`（fail-open）が書き込み、Settings → Usage タブで累計・推定コスト・サーフェス別内訳を可視化。詳細は [AI による書き込み横断検討](./Grimodex_AIによる書き込み横断検討.md)（N4）。

```sql
CREATE TABLE IF NOT EXISTS ai_usage (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface       TEXT NOT NULL,          -- 生成サーフェス識別子（AiUsageSurface）
  scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,  -- シーン削除時は支出履歴を残す
  model         TEXT,
  provider      TEXT,                   -- OpenRouter / OpenAI 互換 / Ollama 等
  tokens_in     INTEGER,                -- usage 未取得時は null
  tokens_out    INTEGER,
  cache_read_tokens  INTEGER,           -- ↓ migrate_ai_usage_cache_tokens で後追い追加（既存行は null=0 扱い）
  cache_write_tokens INTEGER,
  cost_usd      REAL,                   -- null なら UI がトークンから推定
  duration_ms   INTEGER,
  trace_id      TEXT,
  ref_id        TEXT,
  metadata      TEXT,                   -- 追加メタデータ（JSON）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_project_created ON ai_usage(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_project_surface ON ai_usage(project_id, surface);
```

> `cache_read_tokens` / `cache_write_tokens` は後追いマイグレーションで追加。`add_column_if_missing` は **CREATE TABLE の直後**に呼ぶ必要がある（前だと fresh DB で「no such table: ai_usage」で migrate() ごと落ちる。回帰テストで固定）。

### generation_logs

スラッシュ（`inline-ai`）／ Beat 生成の AI 出自（プロンプト全文・命令・モデル・`trace_id`）を前方キャプチャする append-only ログ。制作過程開示（出自レポート）エクスポートのデータ源。Chat は別途 `chat_message_prompts` を持つため、本テーブルは inline-ai/beat 経路のみ。詳細は [Attribution パネル設計書](./Grimodex_Attributionパネル設計書.md)。

```sql
CREATE TABLE IF NOT EXISTS generation_logs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK(kind IN ('inline-ai','beat')),
  command_id    TEXT,
  instruction   TEXT,                   -- ユーザー指示文
  prompt_full   TEXT,                   -- 実送信プロンプト全文（system+user）。旧レコードは NULL
  model         TEXT,
  trace_id      TEXT NOT NULL UNIQUE,   -- authorship_spans 等との突合キー
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_generation_logs_project_trace ON generation_logs(project_id, trace_id);
CREATE INDEX IF NOT EXISTS idx_generation_logs_scene ON generation_logs(scene_node_id);
```

### chat_message_prompts

チャットの各ターンで実際に送信された最終システムプロンプトのスナップショットを、トリガーとなったユーザーメッセージ（`message_id`）に紐づけて保存。RAG が非決定的かつ codex/scene 状態が送信後に変化するため再構築では復元不可能で、送信時にキャプチャして「過去メッセージの送信プロンプトを後から確認」機能で表示する。重いプロンプト本文を `chat_messages` 本体から切り出した side-table。詳細は [Chat パネル設計書](./Grimodex_Chatパネル設計書.md)。

```sql
CREATE TABLE IF NOT EXISTS chat_message_prompts (
  message_id    TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  system_prompt TEXT NOT NULL,          -- 送信された最終システムプロンプト本文（再構築不可）
  layers        TEXT,                   -- レイヤー内訳（LayerBreakdown[] の JSON）
  total_tokens  INTEGER,
  model         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## プロジェクトスナップショット構造拡張（2026-05-19 実装 / 2026-06-18 追記）

`project_snapshots` を「構造込み・スコープ選択式」に拡張した際に追加された 4 テーブル。スナップショット時点の各エンティティの構造メタを行単位でミラーし、削除エンティティの再生成や構造巻き戻し（リストア）を可能にする。本文は二重保存せず `body_version_id` で `content_versions` を指す軽量ポインタ方式で、参照中のリビジョンは **ON DELETE RESTRICT** でプルーニングから保護される。コアエンティティ（tree_nodes / codex_entries / snippets）は専用 strict テーブル、それ以外（map/foreshadow/labels/lint 等）は `project_snapshot_aux` に JSON 生コピーで格納。詳細は [リビジョン履歴設計書](./Grimodex_リビジョン履歴設計書.md)。

### project_snapshot_tree_nodes

```sql
CREATE TABLE IF NOT EXISTS project_snapshot_tree_nodes (
  snapshot_id        TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  node_id            TEXT NOT NULL,
  parent_id          TEXT,
  node_type          TEXT NOT NULL,
  title              TEXT NOT NULL,
  synopsis           TEXT,
  intent             TEXT,               -- migrate_tree_nodes_intent で後付け。シーンの「狙い」
  sort_order         TEXT NOT NULL,
  story_time_order   TEXT,
  story_time_label   TEXT,
  pov_character_id   TEXT,
  location_id        TEXT,
  status             TEXT,
  body_version_id    TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
  unplaced_beats_doc TEXT NOT NULL DEFAULT '[]',
  char_count         INTEGER NOT NULL DEFAULT 0,
  -- 元エンティティの作成/更新日時を保存（リストアで復元時刻でなく実際の日時を復元する）
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_id, node_id)
);
```

### project_snapshot_codex_entries

```sql
CREATE TABLE IF NOT EXISTS project_snapshot_codex_entries (
  snapshot_id            TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  entry_id               TEXT NOT NULL,
  type                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  parent_id              TEXT,
  aliases                TEXT,
  excluded_aliases       TEXT,
  summary                TEXT,
  icon                   TEXT,
  context_mode           TEXT NOT NULL,
  children_budget        TEXT NOT NULL,
  notes                  TEXT,
  body_version_id        TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_id, entry_id)
);
```

### project_snapshot_snippets

```sql
CREATE TABLE IF NOT EXISTS project_snapshot_snippets (
  snapshot_id            TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  snippet_id             TEXT NOT NULL,
  title                  TEXT NOT NULL,
  scene_id               TEXT,
  source_chat_message_id TEXT,
  body_version_id        TEXT REFERENCES content_versions(id) ON DELETE RESTRICT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_id, snippet_id)
);
```

### project_snapshot_aux

```sql
CREATE TABLE IF NOT EXISTS project_snapshot_aux (
  snapshot_id  TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,            -- map / foreshadow / labels / lint 等（1スコープ1行）
  payload_json TEXT NOT NULL,            -- { rows: RawRow[] } 形式の生行コピー（schema は projectSnapshotScopes.ts）
  PRIMARY KEY (snapshot_id, scope)
);
```

> **`content_versions` のプルーニング保護**: `body_version_id`（RESTRICT）に加え、`delete_cv_on_tree_node_delete` / `_codex_entry_delete` / `_snippet_delete` の 3 トリガーが `migrate_cv_triggers_protect_snapshot_versions` で **スナップショット参照中のバージョンを削除しない** snapshot-aware 版へ DROP→再作成される。エンティティ削除時の content_versions 連鎖削除が、スナップショットがまだ参照しているリビジョンを巻き込まないようにするため。

---

## Codex Relation（型付き関係）（2026-05-26 実装 / 2026-06-18 追記）

Codex エントリ同士の「正式な型付き関係」を保持する。Map パネルでユーザーが描いた User edge（両端が Codex ノード）を「Codex Relation へ昇格」して構造化する経路の格納先で、AI コンテキスト注入（Chat）の Codex Relation 経路でも参照される。`codex_dismissed_relations`（提案 Dismiss 記録）とは別物。詳細は [Map パネル設計書](./Grimodex_Mapパネル設計書.md)「Codex Relation への昇格」。

### codex_relations

```sql
CREATE TABLE IF NOT EXISTS codex_relations (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  relation_type       TEXT NOT NULL DEFAULT 'custom',   -- 例: mentor。既定 custom
  label               TEXT,                             -- 表示ラベル（例: 師匠）
  depth_hint          INTEGER,                          -- 関係注入/展開時の深さヒント
  source_map_edge_id  TEXT,                             -- 昇格元の Map User edge ID（FK は持たない＝edge 削除後も追跡可）
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_codex_relations_project ON codex_relations(project_id);
CREATE INDEX IF NOT EXISTS idx_codex_relations_from    ON codex_relations(from_codex_id);
CREATE INDEX IF NOT EXISTS idx_codex_relations_to      ON codex_relations(to_codex_id);
```

> `source_map_edge_id` は FK を持たない純粋な TEXT（昇格元エッジ削除後も ID を追跡できるように）。FK が残っている旧 dev DB を検出した場合のみ、`migrate_codex_relations_source_map_edge_id` が `codex_relations_new` への退避→DROP→RENAME でテーブルを再構築して FK を撤去する（再構築版は `created_at`/`updated_at` の DEFAULT を省く）。

---

## 影響度レビュー（impact-review）（2026-06-18 追記）

### impact_review_baselines

impact-review（Codex 変更 → 本文矛盾の逆引き検出）の差分基準テーブル。Codex エントリ単位で「前回 impact-review 実行時点の状態スナップショット」を 1 行保持し、手動トリガ時に現在状態と diff して「前回チェック以降の変更」を求める。baseline が無い初回は全文を変更扱い。詳細は [impact-review 実装計画](./Grimodex_impact-review実装計画.md)。

```sql
CREATE TABLE IF NOT EXISTS impact_review_baselines (
  entry_id      TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,          -- { name, aliases, summary, content_plain, details:[{name,value}] }
  content_hash  TEXT NOT NULL,          -- 差分有無の高速判定用
  reviewed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_impact_baselines_project ON impact_review_baselines(project_id);
```

> impact-review は `post_effect_runs.effect_type = 'impact_review'` / `post_effect_annotations.category = 'impact_review_anchor'` として PostEffects 群に統合される（[post_effect_runs](#post_effect_runs) の CHECK 拡張参照）。

---

## 既存テーブルへのカラム追加（2026-06-18 追記）

`## テーブル定義` の各テーブルへ、2026-05-24〜06-12 に追加されたカラム。新規 DB は CREATE 時点で列を含み、既存 DB は `add_column_if_missing` で冪等に後付けされる。

### tree_nodes（Note コンテキスト + 外部 MD マウント + 楽観ロック）

```sql
-- Note ノードの AI コンテキスト注入（2026-05-26, Chat コンテキスト拡張）
ALTER TABLE tree_nodes ADD COLUMN context_mode     TEXT;                       -- 非 note 行は NULL、既存 note は 'mentioned' へ backfill
ALTER TABLE tree_nodes ADD COLUMN aliases          TEXT NOT NULL DEFAULT '[]'; -- Note の別名 JSON 配列（本文内 Note 検出）
ALTER TABLE tree_nodes ADD COLUMN excluded_aliases TEXT NOT NULL DEFAULT '[]'; -- 言及マッチから外す表記
-- 外部 MD マウント（file-backed シーン, 2026-05-24）
ALTER TABLE tree_nodes ADD COLUMN source_uri   TEXT;   -- 元ファイル URI（双方向同期のリンク先）
ALTER TABLE tree_nodes ADD COLUMN source_mtime TEXT;   -- 元ファイル mtime（外部変更検知）
ALTER TABLE tree_nodes ADD COLUMN archived_at  TEXT;   -- アーカイブ日時。NULL = 非アーカイブ
-- シーン別の「狙い」（2026-06-05, intent_drift 診断の基準）
ALTER TABLE tree_nodes ADD COLUMN intent  TEXT;
-- AI 書き込みの楽観ロック（2026-06-06）
ALTER TABLE tree_nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
```

### chat_sessions（Codex / Snippet スコープアンカー）

Chat スコープに Codex（2026-06-10）と Snippet（2026-06-12）を追加。蓄積知識（Codex エントリ）や Snippet を起点に対話するためのアンカーで、`node_id` は NULL のまま。

```sql
ALTER TABLE chat_sessions ADD COLUMN codex_anchor_id   TEXT REFERENCES codex_entries(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN snippet_anchor_id TEXT REFERENCES snippets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_codex_anchor   ON chat_sessions(project_id, codex_anchor_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_snippet_anchor ON chat_sessions(project_id, snippet_anchor_id);
```

### lint_term_dictionary（project スコープ化）

用語辞書を project スコープ化（2026-06-03）。旧 DB は WS 共有→最古プロジェクトへ backfill、孤児行は削除。ALTER では nullable、新規 DB は CREATE 側で `NOT NULL` + FK。

```sql
ALTER TABLE lint_term_dictionary ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_lint_term_dict_project ON lint_term_dictionary(project_id);
```

### post_effect_runs.effect_type / post_effect_annotations.category（CHECK 拡張）

カラム追加ではなく **CHECK 列挙の拡張**。`effect_type` に `typo_detection`（2026-05-26）/ `intent_drift`・`timeline_consistency`（2026-06-05）/ `impact_review`（2026-06-18）を、`category` に対応する `*_anchor` を追加（上の [post_effect_runs](#post_effect_runs) / [post_effect_annotations](#post_effect_annotations) の DDL を参照）。既存 DB は `migrate_post_effect_*_categories` が CHECK 文字列を置換して遅延拡張する。

---

## スキーマ更新履歴（2026-06-18）

セマンティック検索 / RAG・執筆タイムラプス・AI 書き込み基盤・AI 使用量台帳・スナップショット構造拡張・impact-review など、2026-05-19〜06-18 に実装が先行していた領域を設計書へ反映。前回の追従基準日は 2026-05-16。本更新は live スキーマ（`migrate.rs`）を正本に Drizzle（`schema.ts`）と突合して作成し、各テーブルの DDL・導入日は git で裏取りした。

### 追加テーブル（設計書に未記載だったもの）

| テーブル | 追加理由 | 実装日 |
|---------|---------|--------|
| `scene_chunks` | 本文セマンティック検索の埋め込みチャンク | 2026-05-19 |
| `codex_chunks`（Rust専用） | Codex hybrid 検索の埋め込み（1エントリ1ベクトル） | 2026-06-18 |
| `change_events` / `state_snapshots` | 執筆タイムラプスの変更ログ + リプレイアンカー | 2026-05-29 |
| `undo_journal`（Rust専用） / `prose_staging` | AI 書き込み基盤（tracked write / staged prose） | 2026-06-06 |
| `ai_usage` | N4 横断トークン使用量台帳 | 2026-06-05 |
| `generation_logs` | inline-ai/beat 生成の出自ログ | 2026-05-31 |
| `chat_message_prompts` | 送信プロンプトのスナップショット | 2026-06-13 |
| `project_snapshot_tree_nodes` / `_codex_entries` / `_snippets` / `_aux` | スナップショットの構造込み拡張 | 2026-05-19 |
| `codex_relations` | Codex 同士の型付き関係（Map edge 昇格） | 2026-05-26 |
| `impact_review_baselines` | impact-review の差分基準 | 2026-06-18 |

### 追加カラム（既存テーブル）

| テーブル | カラム | 用途 | 実装日 |
|---------|-------|------|--------|
| `tree_nodes` | `context_mode` / `aliases` / `excluded_aliases` | Note の AI コンテキスト注入・言及検出 | 2026-05-26 |
| `tree_nodes` | `source_uri` / `source_mtime` / `archived_at` | 外部 MD マウント（file-backed） | 2026-05-24 |
| `tree_nodes` | `intent` | シーン別の「狙い」（intent_drift 基準） | 2026-06-05 |
| `tree_nodes` / `codex_entries` / `snippets` | `version` | AI 書き込みの楽観ロック（Rust のみ） | 2026-06-06 |
| `chat_sessions` | `codex_anchor_id` / `snippet_anchor_id` | Codex / Snippet スコープのチャット | 2026-06-10 / 06-12 |
| `lint_term_dictionary` | `project_id` | 用語辞書の project スコープ化 | 2026-06-03 |
| `ai_usage` | `cache_read_tokens` / `cache_write_tokens` | prompt cache トークン計測（後追い） | 2026-06-05 |

### トリガー / FTS / CHECK の変更

| 項目 | 内容 |
|------|------|
| `codex_fts` に `content` 列追加 | Codex 本文（PM JSON）を 5 番目の列としてインデックス。`search_codex` が本文にマッチ。`codex_fts_ai/ad/au` も `content` 同期。レガシー DB は `migrate_codex_fts_add_content` が DROP→再作成→rebuild（PR #109, 2026-06-18） |
| `delete_cv_on_*_delete` の snapshot-aware 化 | `migrate_cv_triggers_protect_snapshot_versions` が 3 トリガーを再作成し、スナップショット参照中の `content_versions` を連鎖削除から保護 |
| `post_effect_runs.effect_type` CHECK 拡張 | 5→9（`typo_detection` / `intent_drift` / `timeline_consistency` / `impact_review` を追加） |
| `post_effect_annotations.category` CHECK 拡張 | 5→9（`typo_anchor` / `intent_anchor` / `timeline_anchor` / `impact_review_anchor` を追加） |

### Drizzle ↔ Rust スキーマの projection 差分

`src-tauri/crates/grimodex-db/src/migrate.rs`（実 DB の正本）と `src/db/schema.ts`
（アプリ層 projection）の差分。正確な table / column / index / FK の現状は
`schema-contract.json` と parity test を参照する。この表は、Drizzle に投影しない
Rust 専用領域と互換上の注意点だけを説明する。

| 項目 | 状態 |
|------|------|
| `chat_message_chunks` / `event_chunks` / `fts_meta` / `undo_journal` | Rust のみ。native の索引・監査・Undo 用で Drizzle には定義しない（意図的） |
| FTS5 仮想テーブル | Rust migration のみで管理し、Drizzle/browser projection には定義しない（意図的） |
| `tree_nodes.version` / `codex_entries.version` / `snippets.version` | 楽観ロック列。Drizzle にも宣言し、contract test で存在を固定する |
| `projects.is_sample` | Rust のみ。Drizzle 未反映 |
| FTS5 / CHECK 制約 / 部分・UNIQUE インデックス / seed・cascade トリガー | `migrate.rs` のみに存在する物理制約。Drizzle は列と基本 FK の projection を担う |

### マイグレーション方針について

2026-05 以降に追加されたテーブル / カラムは、番号付きマイグレーション（旧 v1〜v7）ではなく **`CREATE TABLE IF NOT EXISTS` + `add_column_if_missing` による冪等適用**で導入されている。`ai_usage` の cache 列や `change_events.event_uid` のように、後付け列に依存する UNIQUE インデックスは「列追加の **後**」に別バッチで作る必要がある点に注意（`IF NOT EXISTS` は列解決エラーを抑止しないため）。

---

## AI 運用ツール群（2026-06-19 実装 / 2026-06-20 追記）

「AI 運用ツール群」（PR #124）で追加された 2 テーブル。ユーザーが保存して再利用するプロンプトテンプレート（Prompt Library）と、モデル/プロンプトの 2 構成を同一プロンプトに対して走らせた A/B 比較履歴を保持する。いずれも `project_id` を持ちプロジェクト削除で `ON DELETE CASCADE`。`migrate()` 内の `CREATE TABLE IF NOT EXISTS` で冪等に導入され、Drizzle の `promptTemplates` / `abComparisons`（`src/db/schema.ts`）とミラーする。

### prompt_templates

ユーザーが保存する再利用可能なプロンプトテンプレート（per-project）。`snippets` とは別概念で、チャット入力時に呼び出して再利用する。v1 はパラメータ置換なしのプレーンテキスト。`usage_count` で利用回数を記録し、よく使うテンプレートの並べ替えに利用する。

```sql
CREATE TABLE IF NOT EXISTS prompt_templates (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'Untitled',  -- テンプレートの表示名
    content     TEXT NOT NULL DEFAULT '',          -- プロンプト本文（v1 は置換なしプレーンテキスト）
    usage_count INTEGER NOT NULL DEFAULT 0,         -- 利用回数（再利用頻度の並べ替え用）
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_project
    ON prompt_templates(project_id, created_at);
```

### ab_comparisons

モデル/プロンプトの 2 構成（A / B）を同一プロンプトに対して走らせ、どちらを採用したかを記録する履歴（per-project）。`surface` は実行面（`"chat"` | `"inline"` 等）、`model_a` / `model_b` と `prompt_variant_a` / `prompt_variant_b` が比較した 2 構成、`response_a` / `response_b` が各応答本文。`chosen` は採用したカラム（`'a'` | `'b'`）で、未採用なら NULL。

```sql
CREATE TABLE IF NOT EXISTS ab_comparisons (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    surface           TEXT NOT NULL,   -- 実行面（"chat" | "inline" 等）
    prompt            TEXT NOT NULL,   -- 比較に用いた共通プロンプト
    model_a           TEXT,            -- A 構成のモデル
    model_b           TEXT,            -- B 構成のモデル
    prompt_variant_a  TEXT,            -- A 構成のプロンプト変種
    prompt_variant_b  TEXT,            -- B 構成のプロンプト変種
    response_a        TEXT NOT NULL,   -- A 構成の応答本文
    response_b        TEXT NOT NULL,   -- B 構成の応答本文
    chosen            TEXT,            -- 採用カラム（'a' | 'b'）。未採用なら NULL
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ab_comparisons_project_created
    ON ab_comparisons(project_id, created_at);
```

---

## スキーマ更新履歴（2026-06-20）

「AI 運用ツール群」（PR #124, 2026-06-19）でユーザー保存のプロンプトテンプレートとモデル/プロンプトの A/B 比較履歴が、「チャット履歴 RAG（エピソード記憶）」（PR #135, `c37e6212`, 2026-06-20）で過去の対話を recall するための埋め込み表が追加された分を設計書へ反映。前回の追従基準日は 2026-06-18。live スキーマ（`migrate.rs`）を正本に Drizzle（`schema.ts`）と突合した。

### 追加テーブル（設計書に未記載だったもの）

| テーブル | 追加理由 | 実装日 |
|---------|---------|--------|
| `prompt_templates` | ユーザー保存のプロンプトテンプレート（Prompt Library）。`title` / `content` / `usage_count` を保持し、チャット入力時の再利用を可能にする | 2026-06-19 |
| `ab_comparisons` | モデル/プロンプトの A/B 比較履歴。`surface` / `prompt` / `model_a` / `model_b` / `prompt_variant_a` / `prompt_variant_b` / `response_a` / `response_b` / `chosen` を保持。`chosen` は採用カラム（`'a'` \| `'b'`）、未採用は NULL | 2026-06-19 |
| `chat_message_chunks`（Rust専用） | チャット履歴 RAG（エピソード記憶）の埋め込み（1メッセージ1ベクトル）。過去の対話を scene/codex と同じ意味検索経路で recall。`project_id` / `session_id` を非正規化保持し、hybrid 検索は既存 `chat_messages_fts` を再利用（PR #135） | 2026-06-20 |

`prompt_templates` / `ab_comparisons` は `project_id` を持ち、プロジェクト削除時に `ON DELETE CASCADE`。Drizzle の `promptTemplates` / `abComparisons`（`src/db/schema.ts`）とミラー。`chat_message_chunks` は `codex_chunks` と同じく **Rust 専用**（Drizzle mirror 不要）で、`message_id` を `PRIMARY KEY` とし `chat_messages` 削除時に `ON DELETE CASCADE`。定義の詳細は [セマンティック検索 / RAG ベクトルインデックス](#セマンティック検索--rag-ベクトルインデックス2026-06-18-追記) 節の `chat_message_chunks` を参照。いずれも `migrate()` 内の `CREATE TABLE IF NOT EXISTS` で冪等に導入される。

---

## プロットスレッド・タイムライン（2026-06-22 実装 / 追記）

「プロットスレッド（Plottr 型）を Timeline にレーン表示」（PR #168 / commit `d72468c9`）で追加された 2 テーブル。**名前付きプロットスレッド** が複数シーンを貫いて走り、各シーンに `introduce / develop / turn / climax / resolve` の段階マーカーを置ける。Timeline パネルの `threads` ビューモードで N 本のスイムレーンとして描画される（新 PanelId は追加しない）。既存 `codex_entry_phases`（Codex エントリのフェーズアーク）とは意味論的に分離するためユーザーが専用テーブルを選択した経緯がある。詳細は [Timeline パネル設計書](./Grimodex_Timelineパネル設計書.md)「プロットスレッド表示（threads ビューモード）」および設計 spec `docs/superpowers/specs/2026-06-22-plot-thread-timeline-design.md`。`migrate()` 内の `CREATE TABLE IF NOT EXISTS` で冪等に導入され、Drizzle の `plotThreads` / `plotThreadSceneLinks`（`src/db/schema.ts`）とミラーする。

### plot_threads

プロットスレッド = レーン。1 行 = 1 本の名前付きトラック。`sort_order` はレーン縦順の base62 fractional-index（`@/features/tree/fractionalIndex`、辞書順比較）。`color` はマーカー基調色（任意・null 可、UI からの編集は v1 未提供で既定 `var(--primary)`）。

```sql
CREATE TABLE IF NOT EXISTS plot_threads (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL DEFAULT '',                    -- スレッド名（レーン見出し）
    color       TEXT,                                        -- レーン/マーカー基調色（任意・null 可）
    description TEXT,                                         -- スレッドのメモ（任意）
    sort_order  TEXT NOT NULL DEFAULT 'a0',                  -- レーン縦順の fractional-index（辞書順）
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plot_threads_project
    ON plot_threads(project_id);
```

### plot_thread_scene_links

スレッドが特定シーンで踏む段階マーカー = レーン上の点。1 行 = 1 マーカー。`phase_type` は **CHECK enum**（後から値を増やすと writable_schema rebuild になるため初版で確定）。`node_id` 経由でシーンに紐づき、**シーン削除でマーカーも CASCADE 削除**される。UNIQUE 制約は付けない（同一シーン × 同一スレッドで複数回 develop する等を意図的に許容）。`sort_order` は同一シーン × スレッドに複数マーカーが付く場合の順序（任意・null 可）。

```sql
CREATE TABLE IF NOT EXISTS plot_thread_scene_links (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    phase_type  TEXT NOT NULL
                  CHECK(phase_type IN ('introduce','develop','turn','climax','resolve')),
    note        TEXT,                                        -- マーカー個別メモ（任意）
    sort_order  TEXT,                                        -- 同一シーン×スレッドの複数マーカー順序（任意）
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plot_thread_links_thread
    ON plot_thread_scene_links(thread_id);
CREATE INDEX IF NOT EXISTS idx_plot_thread_links_node
    ON plot_thread_scene_links(node_id);
```

> **XPROJ ガード**: `plot_thread_link_create`（Rust `src-tauri/src/commands/plot_threads.rs`）は INSERT 前に `thread_id` の所属 project と `node_id` の所属 project が一致することを強制する（不一致は拒否）。スキーマ上は FK だけでクロスプロジェクト紐付けを防げないため、コマンド層で防御する（過去の XPROJ 穴 PR #116 と同型）。

---

## スキーマ更新履歴（2026-06-22）

「プロットスレッド（Plottr 型）を Timeline にレーン表示」（PR #168, `d72468c9`, 2026-06-22）で追加された 2 テーブルを設計書へ反映。前回の追従基準日は 2026-06-20。live スキーマ（`migrate.rs`）を正本に Drizzle（`schema.ts`）と突合した。

### 追加テーブル（設計書に未記載だったもの）

| テーブル | 追加理由 | 実装日 |
|---------|---------|--------|
| `plot_threads` | 名前付きプロットスレッド（Plottr 型）。`name` / `color` / `description` / `sort_order`（レーン縦順 fractional-index）を保持。Timeline `threads` ビューモードのレーン見出し | 2026-06-22 |
| `plot_thread_scene_links` | プロットスレッド × シーンの段階マーカー。`phase_type` は CHECK enum（`introduce` \| `develop` \| `turn` \| `climax` \| `resolve`）。`note` / `sort_order` は任意。`thread_id` / `node_id` いずれも `ON DELETE CASCADE` | 2026-06-22 |

`plot_threads` は `project_id` を持ちプロジェクト削除で `ON DELETE CASCADE`。`plot_thread_scene_links` は `thread_id`（スレッド削除）/ `node_id`（シーン削除）の双方で `ON DELETE CASCADE`。クロスプロジェクト紐付けは `plot_thread_link_create` コマンドの XPROJ ガードで防止する。Drizzle の `plotThreads` / `plotThreadSceneLinks`（`src/db/schema.ts`）とミラー。`PLOT_PHASE_TYPES`（`src/db/schema.ts`）が enum の正準順を保持し、SQL 側 CHECK と一致させる。
