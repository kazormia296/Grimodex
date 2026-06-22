# プロットスレッド・タイムライン（プロットグリッド）設計書

- 日付: 2026-06-22
- ブランチ: `feat/plot-thread-timeline`
- ステータス: ドラフト（ユーザーレビュー待ち）

## 1. 背景と要望

Reddit の実ユーザーから「Plottr 型のプロットグリッドが欲しい＝**名前付きプロットスレッド** が
シーンを貫いて走り、各シーンで **導入 / 前進 / 回収** のような段階マーカーを置けるもの」という要望。
返信で "something like number 2"（= Plottr 型の名前付きスレッド行 × 各シーンに
introduce/develop/resolve マーカー）を確認済み。

### 1.1 既存機能との関係（監査結果）

- **MatrixPanel**（`src/features/matrix/`）= 行=シーン × 列=Codex要素 × セル=登場。
  `subplot` showMode で subplot タグ付き lore を列にでき「事実上のサブプロット×シーン グリッド」だが、
  セル（`CellInfo` = `deriveCells.ts:16-23` の `{sources, topSource, role}`）に
  **「導入/前進/回収」の段階を保持する場所が物理的に存在しない**（元データ `scene_codex_mentions` にも phase 列なし）。
  → 描画を足すだけでは要望の核心を満たせない（R教訓どおり「描画層だけ安い」が崩れる地点）。
- **Timeline**（`src/features/timeline/`）= シーンを時間軸に並べる年表。x 軸は reading/story/write の3モード、
  y 軸は scheduled/unscheduled の **2 レーン固定**。項目はシーンそのもの。
  **ただし既に `codexEntryPhases`（entry の phase アーク）を「シーン順に沿った phase pin」として描画済み**
  （`TimelineViewport.tsx` の `showPhasePins`）。
- **伏線レーダー**（`src/features/foreshadow/radar/`）= 読書順 x 軸に setup→payoff の弧を描く SVG。
  `xFor`/`ArcShape`/`buildChapterBands` は純関数で再利用可能。

**結論**: 要望は genuine gap。「シーンに段階をアンカーした名前付きトラック」を持つ機構が存在しない。
ただし **時間軸・順序計算・SVG 描画・ドラッグ操作の基盤は Timeline / 伏線レーダーに揃っている**。

## 2. 確定した設計判断（ユーザー選択）

| 論点 | 選択 | 含意 |
| --- | --- | --- |
| スレッドの実体 | **専用テーブル新設**（`plot_threads` + `plot_thread_scene_links`） | Codex とは意味論的に分離。クリーン。代償=migrate.rs + 新 store + Tauri command 群 + スレッド CRUD UI |
| 描画の設置面 | **TimelinePanel にレーンモード追加** | 現 2 レーン固定の viewport を「N 本の名前付きレーン」へ一般化。x軸/ズーム/ドラッグ/コンテキストメニュー流用。**パネル登録ゼロ** |
| マーカー粒度 | **拡張 4-5 値の固定 enum** | CHECK 制約で初版確定（後から広げると table rebuild）。要確認: 後述 §3.2 の具体 enum |

## 3. データモデル

### 3.1 `plot_threads`（スレッド = レーン）

`codexRelations`（`schema.ts:1132-1161`）の FK テンプレと migrate.rs の CREATE TABLE パターンに倣う。

| カラム | 型 | 備考 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `project_id` | TEXT NOT NULL → `projects(id)` ON DELETE CASCADE | project スコープ |
| `name` | TEXT NOT NULL DEFAULT '' | スレッド名（レーン見出し） |
| `color` | TEXT | レーン色（任意・null 可。phase マーカーの基調色） |
| `description` | TEXT | スレッドのメモ（任意） |
| `sort_order` | TEXT NOT NULL DEFAULT 'a0' | レーン縦順の fractional-index（`@/features/tree/fractionalIndex`、辞書順比較） |
| `created_at` / `updated_at` | TEXT NOT NULL DEFAULT (datetime('now')) | |

index: `idx_plot_threads_project`(project_id)。

### 3.2 `plot_thread_scene_links`（マーカー = レーン上の段階点）

| カラム | 型 | 備考 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `thread_id` | TEXT NOT NULL → `plot_threads(id)` ON DELETE CASCADE | どのスレッドか |
| `node_id` | TEXT NOT NULL → `tree_nodes(id)` ON DELETE CASCADE | どのシーンか（シーン削除でマーカーも消える） |
| `phase_type` | TEXT NOT NULL CHECK(...) | 段階。**enum は §下記で確定** |
| `note` | TEXT | マーカー個別メモ（任意） |
| `sort_order` | TEXT | 同一シーン×スレッドに複数マーカーが付く場合の順序（任意・null 可） |
| `created_at` / `updated_at` | TEXT NOT NULL DEFAULT (datetime('now')) | |

index: `idx_plot_thread_links_thread`(thread_id), `idx_plot_thread_links_node`(node_id)。
UNIQUE 制約は付けない（同一シーンで同一スレッドが複数回 develop する等を許容。重複は UI で整理）。

**phase_type enum（要確認・load-bearing）**: 提案＝5 値
`'introduce' | 'develop' | 'turn' | 'climax' | 'resolve'`
（Reddit の introduce/develop/resolve を内包しつつ turn/climax で物語構造を表現）。
CHECK 制約のため後から値を増やすと writable_schema rebuild（`postEffectAnnotations` 先例）になる。
**初版でこの 5 値で確定してよいか、ユーザーレビューで最終確認する。**

### 3.3 マイグレーション

`src-tauri/src/database/migrate.rs` に新規 `CREATE TABLE IF NOT EXISTS` ブロック 2 つを追加
（`codex_entry_phases`=`:335` / `codex_relations`=`:1096` と同形式の生 SQL、CHECK・`datetime('now')` デフォルト）。
schema.ts（Drizzle）にも対応定義と `$inferSelect`/`$inferInsert` 型を追加。
既存行への後方互換 ALTER は不要（新規テーブルのみ）。

## 4. コンポーネント構成（ユニット）

| ユニット | 役割 | 依存 |
| --- | --- | --- |
| `plot_threads` / `plot_thread_scene_links` テーブル | 永続化 | DB |
| Tauri command 群（`/add-tauri-command`） | CRUD（**全て project_id スコープ**） | DB |
| `plotThreadStore`（zustand, `foreshadowStore` パターン） | スレッド/リンクのロード・CRUD・プロジェクト切替処理 | Tauri command |
| `plotThreadLaneModel.ts`（純関数） | スレッド+リンク+順序 → レーン描画モデル（レーン縦位置・マーカー x 位置）。決定的ソート | `computeGlobalSceneOrder`/`computeSceneTimeIndex` |
| `TimelineViewport` 拡張 | 2 レーン固定 → N 名前付きレーン描画。スレッド表示モード | timelineStore, plotThreadStore, plotThreadLaneModel |
| `TimelineInspector` 拡張 | マーカー選択→phase_type/note/再割当 編集、スレッド選択→改名/色/並替/削除 | plotThreadStore |
| `TimelineContextMenu` 拡張 | シーン位置にマーカー追加・スレッド削除 等 | plotThreadStore |
| timelineStore 拡張 | 表示モード（scenes / threads）と表示設定の永続化（global-settings KV） | — |
| i18n（ja/en） | 新規 UI 文字列 | — |

### 4.1 座標とレーンの一般化

- 現 `yOf(i)` は `LANE_Y`/`UNSCHEDULED_Y` の 2 位置のみ（`TimelineViewport.tsx`）。
  → `laneY(laneIndex) = HEADER_Y + laneIndex * LANE_HEIGHT` へ一般化（純関数 `plotThreadLaneModel` に切り出し）。
- x 軸はシーン位置（`xOf`）を流用。マーカーは「そのシーンの x」×「そのスレッドのレーン y」に配置。
- **座標計算はすべて純関数に切り出して単体テスト**（伏線レーダー先例。happy-dom で実寸は測れないが、
  SVG は明示座標なので純関数テストで十分。flex/grid 実寸 invariant は無いので browser test は原則不要）。

### 4.2 操作（ドラッグ・編集）

- マーカーを横ドラッグ → 別シーンへ再アンカー（既存 story-time ドラッグの axis-lock を流用）。
- マーカーを縦ドラッグ → 別スレッドレーンへ移動。
- レーン見出しを縦ドラッグ → スレッド並べ替え（sort_order 更新）。
- 既存のシーン年表ドラッグ（story モードのみ有効）とはモードが別なので衝突しない。

## 5. データフロー

1. プロジェクトロード時 `plotThreadStore` が `list_plot_threads` + `list_plot_thread_links`（project スコープ）を取得。
2. `plotThreadLaneModel` が threads（sort_order 順）× links（phase_type）× 現在の軸モードの
   `computeSceneTimeIndex(nodes, resolutionMode)` を結合してレーン描画モデルを生成。
3. `TimelineViewport` が threads 表示モードのとき N レーンを描画。
4. 編集操作 → store action → Tauri command → DB → store 再ロード（または楽観更新）。

## 6. エラー処理・既知の罠

1. **パネル登録ゼロを死守**: TimelinePanel 内で完結させ、新 `PanelId` を追加しない
   （追加すると `validateLayoutState`＝`layoutStateUtils.ts:398-402` が全 `TOOL_WINDOW_PANEL_IDS` の
   全プリセット登録を強制し、`layoutPresets.test`/`layoutStore.test` が赤 gate）。
2. **プロジェクト切替の stale ガード**: `plotThreadStore` は async ロード後に `getCurrentProjectId` を
   再照合（Grimodex 頻出のストア汚染バグクラス。related-scenes/codex-candidates でも実バグだった）。
3. **順序軸は設定 1 本化**: x 軸はあくまで `phase_resolution_mode`/`axisMode` 追従。
   パネル独自の reading/story トグルを増やさない（related-scenes の R教訓・既存規約）。
   軸変更時に再取得するよう phaseStore を購読 or `computeSceneTimeIndex` を直接呼ぶ。
4. **CHECK enum は初版確定**: phase_type は後から広げると table rebuild。§3.2 で値を固定。
5. **timelineStore snapshot 同期**: 新表示設定は DEFAULT 追加＋既存の global-settings KV 永続化パターンに乗せる。
6. **カスケード**: scene 削除 → links CASCADE（マーカー消滅）／thread 削除 → links CASCADE。
   thread を「アーカイブ（非表示）」したい要求が出たら add_column で `archived` を後付け（v1 は YAGNI で省略）。
7. **Codex の phase pin と混同しない**: 既存 `codexEntryPhases` の phase pin（キャラ/場所アーク）は
   そのまま据置。プロットスレッドは別テーブル・別レーンモードなので意味論衝突なし
   （ユーザーが専用テーブルを選んだ恩恵）。

## 7. テスト方針

- **純関数**: `plotThreadLaneModel`（レーン縦位置・マーカー x 整列・決定的ソート）／phase_type 検証。
- **store**: CRUD・プロジェクト切替 stale ガード（db mock）。snake_case mock（`rowToEntry` 罠に注意）。
- **Rust**: `cargo test --no-default-features` で新テーブル作成と CHECK 制約。
- **i18n**: ja/en の locale parity。
- レイアウト/幾何は純関数テストで gate（SVG 明示座標。browser test は flex/grid 実寸が絡む場合のみ）。

## 8. スコープ外（YAGNI / 将来）

- スレッドの階層ネスト（act > subplot > thread）。v1 はフラット。
- スレッドのアーカイブ/非表示トグル。
- マーカー間の依存・因果（因果 DAG は別機能）。
- 伏線レーダーの弧からスレッド候補を自動提案（discovery 補助。将来）。
- CSV/エクスポート連携。
