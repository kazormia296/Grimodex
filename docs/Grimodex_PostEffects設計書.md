# Grimodex ポストエフェクト機能 設計書

## 概要

ポストエフェクト（Post-Effect）とは、既に書かれた本文に対して**書き換えずに注釈を重ねる AI パス**の総称。本体の執筆フローとは別軸で走り、書き手のセルフレビュー・推敲支援を担う。

本書が対象とする5機能:

| 機能        | 概要                           | 単位           |
| --------- | ---------------------------- | ------------ |
| レビュー      | 編集者視点の診断レポート（構造化所見リスト）       | span         |
| 疑似コメント    | 読者ペルソナによる本文横の吹き出し、スレッド可      | span         |
| メタ構造レビュー  | プロット構造・ペーシングなどの俯瞰診断          | scene/folder |
| 整合性チェック   | 本文と Codex の事実矛盾を検出（Codex 基準） | span         |
| 自己整合性チェック | 本文内の自己矛盾を検出（Codex 不使用）       | span ペア      |

整合性チェックは「`consistency` (Codex 基準)」と「`intra_scene_consistency` (Codex 不使用)」の対の `effect_type` として実装する。詳細は §整合性チェック詳細設計 を参照。

Linter 系（形式的ルールベース）は対象外。本書は「非決定的・LLM ベースの事後分析」のみを扱う。

関連: [`Grimodex_Scenesパネル設計書.md`](Grimodex_Scenesパネル設計書.md) の `tree_nodes` を前提とする。

---

## 設計原則

1. **基盤は統一、表層は分離** — `span-annotation` / `relation` / `scene-lens` の3層をデータモデルで共有し、機能ごとのUIと運用は分ける。
2. **本文を書き換えない** — すべての成果物は本文へのオーバーレイ。「提案」としての edit は別途 apply を経て、既存の帰属追跡に載る。
3. **作者の構造を尊重** — プロット構造は固定ラベル（3幕・起承転結）を押し付けず、`tree_nodes` のフォルダ階層をそのまま構造モデルとして扱う。
4. **実行単位 = `post_effect_runs` を扇の要に** — 破棄・比較・再実行・スナップショット運用を run ID 経由で統一する。
5. **既存基盤に便乗する** — 帰属追跡（`authorship_spans` + `AuthorshipMark` + `saveAuthorshipSpans`）と同じマーク×DBハイブリッド・同じ同期パイプライン・同じストリームイベントパターンを踏襲する。新しい抽象を作らない。

---

## Linter との境界とクロスリファレンス

決定論ベースの検出は [`Grimodex_Linter設計書.md`](Grimodex_Linter設計書.md) が担う。同一の本文上で両者が並走するため境界整理が必要だが、**両者の境界の正本は Linter 設計書「PostEffects との境界とクロスリファレンス」セクション**。本書では PostEffects 側の受け取り方のみ要点化する。

### 責務の線引き

- PostEffects は **LLM ベースの意味的検出**（事実の矛盾、伏線、テーマ、読者反応、構造診断）
- 決定論的な表記・文体ルールは Linter 側。本書では扱わない
- 同じ Codex エントリが両機能で別角度から検出されるのは許容（表記ゆれは Linter、事実矛盾は PostEffect）

### AnnotationMark と Linter 装飾の共存

- Decoration クラス名 `pe-annotation-*`（本書 §既存基盤の再利用）と Linter squiggly は名前空間が独立
- 描画レイヤ・ホバー統合・クリック優先度は Linter 設計書の「装飾の重なり規則」に従う

### 位置追跡の共有

- 本書 §方針決定事項 3（ライブ Mark が真実、DB はフォールバック）は Linter 側の UTF-16 位置マップ実装と整合する前提
- 位置オフセット変換ユーティリティ（`src/features/editor/offsetMap.ts` 仮）は Linter と共有。PostEffects 単独では再実装しない

### Fix による Annotation の消失通知

- Linter Fix によって AnnotationMark が完全消滅した場合、Linter パネルに消失通知が表示される（詳細は Linter 設計書「Fix 適用と PostEffect annotation の相互作用」）
- PostEffect 側の `post_effect_annotations.range_start/end` と `text_snapshot` は scene 保存時に `savePostEffectAnnotations` で自動再同期される
- PostEffects 側の UI では消失を追加通知しない（Linter パネルで一元化）

### エクスポート時の挙動

- 本文エクスポート時は **`AnnotationMark` を除去**（Linter の `lintDisable` と同じ除去パスで処理）
- エクスポーター実装時の必須テストケース: 「PostEffect annotation 入りシーン → 出力に annotation span が含まれない」
- 「本文を書き換えない」設計原則（本書 §設計原則 2）はエディタ内の話。エクスポート後のテキストファイルには annotation を残さない

### 状態管理の独立性

- PostEffects の `status`（open / resolved / dismissed）と Linter の `lint_ignored_diagnostics` は現状独立
- 将来の統合可否は Phase 4 以降で判断（Linter 設計書側と歩調を合わせる）

---

## データモデル

### 全体構造

```
post_effect_runs                          ← 実行単位（扇の要）
  ├── post_effect_annotations             ← span 注釈（レビュー、疑似コメント、関係の錨）
  │     └── (parent_id で self-ref)       ← スレッド
  ├── post_effect_annotation_relations    ← 注釈ペア（整合性、伏線、テーマ）
  └── scene_lens_data                     ← scene/folder 単位の俯瞰（メタ構造）
```

### テーブル: `post_effect_runs`

全成果物が所属する実行単位。

```sql
CREATE TABLE post_effect_runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  effect_type     TEXT NOT NULL,          -- 'review' | 'pseudo_comment' | 'meta_structure' | 'consistency' | 'intra_scene_consistency'
  scope_type      TEXT NOT NULL,          -- 'scene' | 'folder' | 'project'
  scope_target_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,  -- NULL=プロジェクト全体
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,          -- コード内の semver 定数（例: 'review_v1.0'）
  input_hash      TEXT,                   -- 入力スナップショットのhash（再実行判定、nullable）
  status          TEXT NOT NULL,          -- 'running' | 'completed' | 'failed' | 'cancelled'
  summary         TEXT,                   -- 任意の総評テキスト
  error_message   TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE INDEX idx_runs_project_effect ON post_effect_runs(project_id, effect_type, started_at DESC);
-- 同じ scope で複数同時実行を禁じる（running のみ対象）
CREATE UNIQUE INDEX idx_runs_running_scope
  ON post_effect_runs(project_id, effect_type, scope_type, scope_target_id)
  WHERE status = 'running';
```

`scope_type='selection'` は **MVP では扱わない**（サブ範囲の保存場所をスキーマに持たせる必要があり、MVP 価値に対してコストが合わないため）。

### テーブル: `post_effect_annotations`

span 単位の注釈。レビュー、疑似コメント、および relation の両端の錨。

```sql
CREATE TABLE post_effect_annotations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id         TEXT REFERENCES post_effect_runs(id) ON DELETE SET NULL,
                  -- NULL = 将来的なユーザー手動メモ用の枠（MVPでは AI 生成のみ）
  -- アンカー（MVP は scene_range のみ）
  anchor_type    TEXT NOT NULL DEFAULT 'scene_range',  -- 将来: 'codex_entry' | 'synopsis'
  scene_id       TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  range_start    INTEGER,
  range_end      INTEGER,
  text_snapshot  TEXT,                   -- 作成時の本文。range 失効時のフォールバック
  -- 内容
  category       TEXT NOT NULL,          -- 'review' | 'pseudo_comment'
                                          -- | 'consistency_anchor' | 'foreshadow_anchor' | 'theme_anchor'
  persona        TEXT,                   -- 疑似コメントのペルソナ名
  severity       TEXT,                   -- 'info' | 'suggestion' | 'warning' | 'error'
  content        TEXT NOT NULL,
  -- スレッド
  author_role    TEXT NOT NULL DEFAULT 'ai',  -- 'ai' | 'user' | 'system'
  parent_id      TEXT REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
  -- ライフサイクル
  status         TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved' | 'dismissed'
  metadata       TEXT NOT NULL DEFAULT '{}',    -- JSON: codex_ref, suggested_diff, ほか
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pea_scene  ON post_effect_annotations(project_id, scene_id, status);
CREATE INDEX idx_pea_run    ON post_effect_annotations(run_id);
CREATE INDEX idx_pea_parent ON post_effect_annotations(parent_id);
```

**FTS5（初期から組み込む）:**

```sql
CREATE VIRTUAL TABLE post_effect_annotations_fts USING fts5(
  content,
  content='post_effect_annotations',
  content_rowid='rowid',
  tokenize='trigram'
);
-- 既存 codex_fts / tree_nodes_fts と同じトリガ方式で同期
```

理由: 「整合性チェックで指摘された台詞を横断検索」「『ペースが重い』所見が付いた箇所一覧」などのユースケースが必ず発生する。後から FTS を足すと re-index が重いので最初から組み込む。

### テーブル: `post_effect_annotation_relations`

注釈ペア。整合性・伏線・テーマ。

```sql
CREATE TABLE post_effect_annotation_relations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id           TEXT REFERENCES post_effect_runs(id) ON DELETE SET NULL,
  annotation_a_id  TEXT NOT NULL REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
  annotation_b_id  TEXT NOT NULL REFERENCES post_effect_annotations(id) ON DELETE CASCADE,
  relation_type    TEXT NOT NULL,                         -- 'contradiction' | 'foreshadowing' | 'theme_echo'
  direction        TEXT NOT NULL DEFAULT 'bidirectional', -- 'bidirectional' | 'a_to_b'
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  metadata         TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pear_a ON post_effect_annotation_relations(annotation_a_id);
CREATE INDEX idx_pear_b ON post_effect_annotation_relations(annotation_b_id);
```

**Codex を絡めた整合性の扱い:** `effect_type='consistency'` の Codex 基点ケース（例: Codex「目=青」 vs 本文「緑」）は relation 行を作らず、**scene 側に単独 annotation** を作り `metadata.codex_ref` に codex_entry_id を格納する。`effect_type='intra_scene_consistency'` は逆に Codex を使わず、本文内の二箇所が矛盾する pair を 2 つの annotation + `relation_type='contradiction'` で表現する（詳細は §整合性チェック詳細設計）。Codex をアンカーにした対等な pair relation（`anchor_type='codex_entry'`）は post-MVP。

**A/B の意味論:**

| `relation_type` | `direction` | A の意味 | B の意味 |
|---|---|---|---|
| `contradiction` | `bidirectional` | 対称（順序に意味なし） | 対称（順序に意味なし） |
| `foreshadowing` | `a_to_b` | **伏線（setup）** | **回収（payoff）** |
| `theme_echo` | `bidirectional` | 対称（順序に意味なし） | 対称（順序に意味なし） |

実装時に A/B が逆転しないよう、`foreshadowing` は必ず A=setup / B=payoff で格納する。

### テーブル: `scene_lens_data`

メタ構造レビューの俯瞰レイヤ。

```sql
CREATE TABLE scene_lens_data (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES post_effect_runs(id) ON DELETE CASCADE,
  target_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,  -- scene or folder; NULL=プロジェクト全体
  lens_type   TEXT NOT NULL,              -- 'plot_structure' | 'pacing' | 'character_arc' | 'pov'
  metrics     TEXT NOT NULL DEFAULT '{}', -- JSON: lens 固有指標
  finding     TEXT,                        -- 自然文の所見（省略可）
  severity    TEXT NOT NULL DEFAULT 'info',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_lens_run_target ON scene_lens_data(run_id, target_id);
CREATE INDEX idx_lens_target_type ON scene_lens_data(target_id, lens_type);
```

`target_id` は `tree_nodes` を参照するので、scene と folder を統一的に扱える。「第2部のペースが中盤で停滞」のような folder 単位所見も同じテーブルに入る。

### 機能 × テーブルのマッピング

| 機能 | `post_effect_annotations` | `...relations` | `scene_lens_data` |
|------|---|---|---|
| レビュー | ✓ (`category=review`) | — | — |
| 疑似コメント | ✓ (`category=pseudo_comment` + threading) | — | — |
| メタ構造レビュー | △（シーン内の個別指摘があれば） | — | ✓ (主) |
| 整合性チェック (`consistency`) | ✓ (`category=consistency_anchor`、単独 annotation + `metadata.codex_ref`) | — | — |
| 自己整合性チェック (`intra_scene_consistency`) | ✓ (両端: `category=consistency_anchor`) | ✓ (`relation_type=contradiction`, `bidirectional`) | — |
| 伏線・回収 | ✓ (`foreshadow_anchor`) | ✓ (`foreshadowing`, `direction=a_to_b`) | — |
| テーマ一貫性 | ✓ (`theme_anchor`) | ✓ (`theme_echo`) | — |

---

## 方針決定事項

### 1. 再実行時の前回所見の扱い（全 `effect_type` 共通）

**方針:** 新しい run が同一 `(project, effect_type, scope)` に対して完了した時点で、**`status='open'` の前回所見を自動的に `dismissed` にする（`run_id` は元のまま保持、`metadata.dismiss_source='run_completed'` を付与）**。`status='resolved'` は履歴として残す。

- ユーザーが前 run 中に resolve した項目は「取り組んだ実績」として残る
- 未対応の `open` は新 run に置き換わる（重複列挙を避ける）
- 削除ではなく dismiss なので、必要なら監査可能
- 整合性チェックの `dismiss_source='manual'` 継承（§整合性チェック詳細設計 §dismiss 永続化）はここで付与される `'run_completed'` と明確に区別される

### 2. Relation と端点 annotation の status 連動

**方針:** relation を `resolved` / `dismissed` にしたとき、**両端の annotation を同じ status に伝播する**。逆方向（片端 annotation の dismiss）は relation には波及させない（片端だけでは意味のある事実関係が壊れるため、relation は生存させてUIで警告表示する）。

### 3. 位置追跡の権威性

**方針: 開いているドキュメント内ではライブのマーク位置が唯一の真実。DB の `range_start/end` は hydration（初回ロード）・range 失効時の復旧・エディタを開いていないクロスシーンクエリにのみ使う。**

- doc → DB 同期: scene 保存時に `saveAuthorshipSpans` と同一トランザクション内で、マークから range を抽出して `post_effect_annotations.range_start/end` を更新する（`text_snapshot` も同時に更新）。
- DB → doc 復元: 初回ロード時に `applyInitialMarks` と同じ `programmaticInsert` meta 付きでマークを貼る。
- 絶対にやらないこと: 開いているドキュメントに対してDBの `range_start/end` を直接描画する。off-by-N のドリフトを呼ぶ。

**現状の実装で注意すべき range の意味論の差**: `range_start/end` の単位はソースによってブレる。
- Rust の consistency runner (`src-tauri/src/commands/post_effect.rs` の `find_text_position`) は **正規化済みプレーンテキストへの byte offset** を書き込む。
- JS の `saveAnnotationAnchors` (`src/features/post-effect/syncAnnotations.ts`) は **PM position** を書き込む。

このため hydration 時は `range_*` をヒントとしてのみ扱い、`text_snapshot` から真の PM 位置を再解決する。実装は `src/features/post-effect/resolveAnnotationRange.ts`（`applyAnnotationsToEditor` から呼ばれる）。同一 snapshot が複数箇所にマッチする場合は `range_start` を近傍ヒントとして最寄りの出現を選ぶ。

### 4. スレッド返信の run_id

**方針:** 疑似コメントへの返信（ユーザー→AI 応答など）は**親の `run_id` を継承する**。返信ごとに新 run を作らない。

- 「この run の所見を一括破棄」がスレッド内で一貫する
- スレッドは会話単位で1つの生成物として扱う
- モデルやプロンプトの差異は annotation 行の `metadata` に記録する

### 5. `scope_type='selection'` は MVP から除外

選択範囲を scope にするユースケースは後回し。`scope_type` は `'scene' | 'folder' | 'project'` の3種のみ。

### 6. 同時実行制御

**方針:** 同じ `(project_id, effect_type, scope_type, scope_target_id)` で `status='running'` の run を**同時に1つまで**に制限する（`idx_runs_running_scope` UNIQUE）。2本目の起動はUIで抑止しつつ、DB レベルでも担保する。

### 7. 古い run の保持ポリシー

**方針:** 無期限保持 + 手動 purge。将来「プロジェクトごとに N 件保持」のオプトインを足す余地を残す。

### 8. プロンプトバージョン

**方針:** コード内の semver 定数（例: `REVIEW_PROMPT_VERSION = 'review_v1.0'`）で管理し、プロンプトに本質的な変更を入れたら minor/major を上げる。git SHA には紐付けない（プロンプト改版と無関係なコミットでも SHA が変わってしまうため）。

**現状の実装**: `src/features/post-effect/consistencyPayloadBuilder.ts` に `CONSISTENCY_PROMPT_VERSION = 'consistency_v1.1'` / `INTRA_CONSISTENCY_PROMPT_VERSION = 'intra_scene_consistency_v1.0'` を定義済み。レビュー・疑似コメント・メタ構造レビューは未実装のためバージョン定数も未追加。

### 9. Outline オーバーレイの鮮度表示

**方針:** メタ構造レビューの run 完了後に `tree_nodes.content` が変更された scene については、Outline ビュー上の lens 表示を「stale」扱い（薄いグレー + ツールチップ「このシーンは run 以降に編集されています」）。判定は `tree_nodes.updated_at > run.completed_at` で行う。

### 10. `input_hash` の扱い

**方針:** MVP 必須（整合性チェックで同一入力 run の再利用に使う）。スキーマ上は nullable のままだが、`consistency` / `intra_scene_consistency` の run では必ず生成して書き込む。レビュー・疑似コメント・メタ構造レビューでは MVP では生成しなくてもよい（将来必要になれば足す）。生成アルゴリズムは §整合性チェック詳細設計 §input_hash 参照。

### 11. `category` の種別混在について

`category` は「ユーザー可視の種類」（`review`, `pseudo_comment`）と「構造的役割」（`consistency_anchor` 他）が混在する。これは意図的で、分割しない。UI 側のレンダラで:
- `*_anchor` の単体 Resolve ボタンの出し方は **relation の有無**で分岐する:
  - `consistency_anchor` で `relation` が紐付かないもの（`effect_type='consistency'` の単独 annotation）→ 単体 Resolve ボタンを出す
  - `relation` 経由のもの（`intra_scene_consistency` / 伏線・テーマ）→ Resolve は relation 側で行い、annotation 単体には出さない
- threading UI は `category='pseudo_comment'` でのみ露出する

---

## 既存基盤の再利用

投資せず借りる。以下は既存で確立しているパターン:

| やりたいこと | 借りる既存物 | 新規追加物 |
|---|---|---|
| TipTap マーク定義 | `src/features/attribution/AuthorshipMark.ts` のパターン | `src/features/post-effect/AnnotationMark.ts` |
| 装飾の可視性切替 | `AttributionPlugin.ts` の `filterSource` Zustand 購読パターン | `AnnotationPlugin.ts` |
| doc → DB 同期 | `src/features/attribution/api.ts::saveAuthorshipSpans` の descendants 走査パターン | `savePostEffectAnnotations` |
| DB → doc 復元 | `src/features/attribution/applyInitialMarks.ts`（`programmaticInsert` meta） | `applyInitialPostEffectAnnotations` |
| 保存フック | `EditorPane.tsx:256`（`saveSceneContent` 直後） | 同位置に注釈保存フックを追加 |
| LLM ストリーミング | `src-tauri/src/lib.rs::send_chat_message_stream` + `listen("chat:stream-*")` | `run_post_effect` + `post_effect:progress` / `:partial` / `:done` / `:error` イベント |
| 中断 | `StreamAbortFlag` (AtomicBool tauri state) | `PostEffectAbortFlag` を run ごとに用意 |
| Tauri コマンド命名 | snake_case（例: `send_chat_message`） | `start_post_effect_run` / `abort_post_effect_run` / `list_post_effect_runs` / `resolve_annotation` / `dismiss_annotation` |
| 整合性チェック本体（非ストリーミング構造化 JSON）| （新規） | `src-tauri/src/ai.rs::call_post_effect_api`（プロンプトキャッシュ対応、AiNovelist 非対応）|
| 整合性チェックの Codex payload 構築 | `src/features/chat/contextBuilder.ts` の選定ロジック（pinned/auto-detected/always-mode）と `codex_match_text` の言及検出 | `src/features/post-effect/consistencyPayloadBuilder.ts`（chat builder と別実装、全エントリで full content + DetailValues） |
| `input_hash` と prompt cache 用の正規化 | （新規） | `src/features/post-effect/canonicalize.ts`（`stableStringify` + `normalize` ヘルパー、~20 行）|

**スキーマ定義は二重メンテになる点に注意:**

- **Drizzle 側** (`src/db/schema.ts`) — TypeScript 型・クエリビルダー用。CLAUDE.md 規約により DB アクセスは Drizzle 経由のみ。
- **Rust 側** (`src-tauri/src/database.rs::migrate()`) — 実際の `CREATE TABLE` を append で追記。FTS 仮想テーブル、トリガ、CHECK 制約はここでしか書けない。

**enum カラムには CHECK 制約を付ける（`authorship_spans` 先例に倣う）:** Drizzle は CHECK を表現できないため、Rust 側マイグレーションに直書きする。対象: `effect_type`, `scope_type`, `runs.status`, `anchor_type`, `category`, `severity`, `author_role`, `annotations.status`, `relation_type`, `direction`, `relations.status`, `lens_type`。これを怠ると不正値が静かに混入する。

**Decoration のクラス名規約（`AttributionPlugin` 踏襲）:**

- `pe-annotation-review`
- `pe-annotation-pseudo-comment`
- `pe-annotation-consistency`
- `pe-annotation-foreshadow`
- `pe-annotation-theme`

---

## run のステータス遷移

```
           ┌─────────┐
start →    │ running │ ──completed──▶ completed (terminal)
           │         │ ──fail──────▶ failed   (terminal, error_message 必須)
           │         │ ──abort─────▶ cancelled (terminal)
           └─────────┘
```

- プロセスクラッシュ等で `completed_at` が埋まらないまま `running` で取り残された run は、アプリ起動時に **`failed` + `error_message='Process terminated unexpectedly'`** でリカバリする（`database.rs` の migrate 直後に実行）。
- `cancelled` はユーザー明示操作のみ。進捗イベントの購読解除で自動 cancel しない（バックグラウンド継続のため）。
- UI は「最近の5件」を `post_effect_runs` から `effect_type` と `status` で絞って表示できる。

---

## MVP スコープ

### MVP に含める

- `post_effect_runs` テーブル（5つの `effect_type` 全てのガワ）
- `post_effect_annotations` テーブル（`scene_range` アンカーのみ）
- `post_effect_annotation_relations` テーブル（`relation_type='contradiction'` のみ運用）
- `scene_lens_data` テーブル（`lens_type='plot_structure'` と `'pacing'` のみ生成）
- 機能: **レビュー** / **疑似コメント** / **メタ構造レビュー（plot_structure + pacing）** / **整合性チェック（`consistency`, Codex 基準）** / **自己整合性チェック（`intra_scene_consistency`, Codex 不使用）**
- FTS5 インデックス
- TipTap マーク / Decoration / 同期パイプライン
- run ステータス遷移 + クラッシュリカバリ
- Outline ビューへのオーバーレイ表示
- `input_hash` 生成と同一入力 run の再利用（整合性チェックで必須）

### ポスト MVP

- 機能: **伏線・回収** / **テーマ一貫性**
- `relation_type='foreshadowing' | 'theme_echo'`
- `anchor_type='codex_entry'` 導入（Codex 基点の対等な relation）
- `lens_type='character_arc' / 'pov'`
- `scope_type='selection'`
- ビート粒度の分析
- run 保持件数制限の設定
- 整合性チェックの自動実行（シーン保存後 debounce、設定で opt-in）
- 整合性チェックの Scene chunking（Codex + Scene が context window を超える場合、Phase 1 実測後に判断）
- SemanticLink 統合（payload builder の選定にエディタ上の明示リンクを追加）

**この順序の理由:** `consistency` は Codex を絶対視する Grimodex 思想の中核機能で MVP に必須。`intra_scene_consistency` は同じ relation 基盤＋プロンプト経路で実装できるため抱き合わせで MVP 入り。伏線・テーマは relation の用途が異なり（`a_to_b` 方向性、`theme_echo` の bidirectional）プロンプト設計も別軸になるため post-MVP に分離。

---

## 整合性チェック詳細設計

`consistency` と `intra_scene_consistency` は対の関係で動く 2 つの `effect_type`。両者は同じ AI パス（PostEffect 基盤）に乗りつつ、Codex を ground truth とするか否かで役割を分担する。

| `effect_type` | 検出対象 | Codex 利用 | annotation 構造 |
|---|---|---|---|
| `consistency` | 本文と Codex の事実矛盾 | あり（ground truth） | 単独 annotation + `metadata.codex_ref` |
| `intra_scene_consistency` | 本文内の自己矛盾 | なし | 2 annotation + relation (`contradiction`, `bidirectional`) |

### 思想

**Codex は absolute authority**。Codex に書いた事実（`notes` 以外）は AI への契約として扱い、本文がこれに反する場合は違反として検出する。Lock のような可変的な保護レイヤーは導入しない。「Codex に書く＝決定、書かない＝未定」というシンプルな運用に揃える。

`codexEntries` の 4 層構造とその扱い:

| レイヤー | 役割 | AI 注入 | 整合性検査対象 |
|---|---|---|---|
| `summary` | 要約 | ✓ | ✓ (ground truth) |
| `content` | 詳細な確定記述 | ✓ | ✓ (ground truth) |
| `detailValues` | ユーザ定義のカスタム属性 (`includeInContext=1`) | ✓ | ✓ (ground truth) |
| `notes` | 草稿・揺らぎ・思考メモ | ✗（schema コメントで明記） | ✗ |
| tags / メタ | 分類用 | ✗ | ✗ |

### consistency (Codex 基準)

#### Codex payload

選定: `Pinned + Always-mode + codex_match_text にヒットしたエントリ全件`。
内容: 各エントリの **Summary + Content (PM→plain text) + DetailValues（`includeInContext=1` のもののみ）**。
除外: **Notes**（schema コメント参照、コンテキスト未注入と一貫）、`includeInContext=0` の DetailValues、tags、内部メタ。
Phase 解決: `resolveCodexState(scene_id)` 適用後の値を送る。Phase ID は payload に別途含めない。

`src/features/chat/contextBuilder.ts` とは別実装。chat の auto-detected は summary のみだが、整合性チェックは全エントリで full content + DetailValues が必要。

#### プロンプト固定句（Codex-only ロック）

```
SCENE TEXT のうち CODEX と矛盾する箇所のみ報告せよ。
SCENE 内部の二箇所間の矛盾は報告するな (それは intra_scene_consistency の役割)。
ある span が Codex のどのエントリとも矛盾していないなら、報告するな。
```

最後の括弧書きは別 effect_type の存在を明示することで境界を deliberate にする。

#### LLM 出力スキーマ

```json
{
  "violations": [
    {
      "entry_id": "string",
      "source_field": "summary" | "content" | "detail",
      "source_excerpt": "string?",
      "detail_definition_id": "string?",
      "expected_value": "string",
      "found_text": "string",
      "found_context": "string",
      "confidence": "high" | "medium" | "low",
      "reason": "string"
    }
  ]
}
```

- `source_excerpt`: `source_field='summary'|'content'` のときに Codex 側の根拠スニペット
- `found_context`: `found_text` の前後 ~30 文字（apply 時の anchor 用）
- Zod でバリデーション、不正な violation は skip-and-log（チャンク全体は失敗にしない）

#### Annotation の `content` と `metadata.codex_ref`

`consistency_anchor` 単独 annotation の `content`（`NOT NULL`、FTS5 対象）には **「{entry_name}.{detail_name or source_field} と矛盾: {found_text}」** 形式の短い記述を入れる。これにより Codex 違反を Codex 参照名で横断検索できる。`llm_reason` は `metadata.codex_ref.llm_reason` 側のみに置く（重複させない）。

```ts
metadata.codex_ref = {
  entry_id: string
  entry_name: string                 // デノルム (エントリ削除後も読めるよう)
  source_field: 'summary' | 'content' | 'detail'
  source_excerpt?: string
  detail_definition_id?: string
  detail_name?: string                // デノルム
  expected_value: string
  found_value: string
  found_text: string
  found_context: string
  resolved_via?: string                // phase override 経由なら phaseId
  confidence: 'high' | 'medium' | 'low'
  llm_reason: string
  dismiss_key: string
  dismiss_source?: 'manual' | 'run_completed' | 'cascade'
  detected_by_model?: string           // 検出 run の model 識別子（モデル切替時に UI で "by X" バッジ表示）
}
```

`IntraAnnotationMeta` 側も `detected_by_model?: string` を持つ（`src/features/post-effect/types.ts`）。

### intra_scene_consistency (Codex 不使用)

#### Payload

Codex を一切渡さない。シーン本文のみ。Codex prefix が無いため Anthropic prompt cache の効果は薄いが、入力が小さいので問題にならない。

#### プロンプト固定句

```
SCENE TEXT 内部の自己矛盾を検出せよ (例: 同じ人物の状態・行動・属性が前後で矛盾する)。
Codex は与えられていない。本文同士のみで判断せよ。
矛盾していない箇所は報告するな。
```

#### LLM 出力スキーマ

```json
{
  "pairs": [
    {
      "a": { "found_text": "string", "found_context": "string" },
      "b": { "found_text": "string", "found_context": "string" },
      "confidence": "high" | "medium" | "low",
      "reason": "string"
    }
  ]
}
```

#### Annotation / relation 構造

各 pair に対して:

- 2 件の `post_effect_annotations`: `category='consistency_anchor'`, `anchor_type='scene_range'`, `content=llm_reason`（FTS 用、端点ごとの説明）, `metadata={ confidence, llm_reason, found_context, found_text, dismiss_key }`
- 1 件の `post_effect_annotation_relations`: `relation_type='contradiction'`, `direction='bidirectional'`, `annotation_a_id`, `annotation_b_id`, `description=llm_reason`（pair 全体の説明）

両端 annotation の status 連動は §2「Relation と端点 annotation の status 連動」に従う。

### 適用ロジック（両モード共通）

LLM の文字オフセットは信用しない。`found_text` + `found_context` で text-search する。

1. `found_context` をシーンで loose match（空白・句読点差は許容）
2. その match window 内で `found_text` を locate
3. anchor 一致した位置 = annotation 1 件（同一 violation が複数箇所にあれば各出現が個別 annotation）
4. anchor 不一致 = `metadata.orphaned=true` でマーク

§3「ライブ Mark が真実」と整合。`found_context` を要求する理由は、同じ `found_text`（例: 「金色の髪の女性」）が複数箇所に出るとき、Codex 違反する出現のみを特定するため。

### Dedupe

**consistency**:

key = `(entry_id, source_field, detail_definition_id ?? null, normalize(source_excerpt) ?? null, normalize(found_text))`

複数チャンクで同一違反を merge する際の conflict 解決:
- `confidence`: `max(high>medium>low)`
- `llm_reason`: first-wins

dedupe → text-search で全出現位置抽出 → 各出現が個別 annotation。

**intra_scene_consistency**:

key = `(scene_id, sorted([normalize(a.found_text), normalize(b.found_text)]))`

順序非依存（bidirectional のため sorted で正規化）。`scene_id` を含むのは異シーンで同じ pair text が偶然一致しても dedupe しないため。

### severity マッピング

| LLM confidence | severity |
|---|---|
| high | `error` |
| medium | `warning` |
| low | `suggestion` |

`info` は不使用（整合性違反は気にすべき所のみ報告される前提）。

### dismiss 永続化（誤検知の判断継承）

annotation 作成時に `metadata.dismiss_key` を計算する:

| effect_type | dismiss_key の構成 |
|---|---|
| `consistency` | `hash(entry_id + (detail_definition_id?) + normalize(found_text))` |
| `intra_scene_consistency` | `hash(scene_id + sorted([normalize(a.found_text), normalize(b.found_text)]))` 両端 annotation に同一の key を格納（pair として dismiss を共有） |

新 run の生成時、過去 annotation に同じ `dismiss_key` かつ **`dismiss_source='manual'`** のものがあれば、新 annotation を初期 `status='dismissed'` + `metadata.dismissed_from_prior_run=true` で作成。`intra_scene_consistency` の場合、pair の両端を同時に dismiss する（片方だけ復活させない）。

`dismiss_source` の区別（重要）:

| `dismiss_source` | 意味 | 継承対象 |
|---|---|---|
| `manual` | ユーザ明示の dismiss（比喩なので無視等） | ✓ |
| `run_completed` | §1 の新 run 完了時の自動掃除 | ✗ |
| `cascade` | §2 の relation→endpoint 伝播 | ✗ |

これを区別しないと、ユーザが一度も見ていない違反が §1 で自動 dismiss → 新 run で `dismiss_key` 一致 → silent dismiss という事故が起きる。

### scope と iteration

| scope | 動作 |
|---|---|
| `scene` | 1 シーンの本文に対し検査 |
| `folder` | 配下シーンを iterate、各シーンに scene-scope を実行、全 violations を 1 `run_id` に集約 |
| `project` | 同上、プロジェクト全体に iterate |

各シーンで Phase 状態を `resolveCodexState` で独立解決。`input_hash` は配下シーン入力の集合に対して計算。`idx_runs_running_scope` UNIQUE が同時実行を既に防いでいる。

### Token budget と Scene chunking（Phase 分割）

上限: `contextWindow * 0.6`（tokenizer drift + reasoning 予約バッファ）。

**Codex first 原則:** Codex は authority なので縮退も分割もしない。Scene の方を分割する。

```
if size(Codex) + size(Scene) <= budget:
  → 単一コール  (Phase 1)
elif size(Codex) <= budget / 2:
  → Scene を段落/heading 境界で chunk 分割
    各 chunk = Codex full + Scene chunk (overlap 200 token, doc 順)  (Phase 2)
else:
  → Codex 単独で half 超 = fallback
    must_include = Pinned + Always + mention 上位 K
    切り捨てを run.metadata.skipped_entries[] に記録、UI で「Pin/Always が多すぎます」hint
```

**Scene 単独が budget 超 = プロダクト側からの構造的警告**として UI に明示（「このシーン異常に長いです」）。

### input_hash

```
input_hash = sha256(stableStringify(canonicalize({
  prompt_version, model, codex, scene, scope, effect_type
})))
```

`canonicalize`:
- Codex entries は id ソート、`aliases` / `details` も内部ソート
- PM JSON は plain text 化
- 改行・空白を normalize（CRLF→LF, 連続空白→単一, 行末空白除去, trim）
- Phase ID は入力に含めない（解決後の値が payload に既に反映）
- `prompt_version`, `model`, `effect_type` は入力に含む

同 `input_hash` の `completed` run があれば新 run を作らず既存結果を再利用（cost 0）。

`prompt_version` は `effect_type` ごとに独立（例: `consistency_v1.0`, `intra_scene_consistency_v1.0`）。プロンプトの本質的変更で minor/major を上げる。

### Cache stability（Phase 2 の Scene chunking 前提）

```ts
const CONSISTENCY_SYSTEM_PROMPT = `...`  // 凍結文字列定数

messages = [
  { role: 'system', content: CONSISTENCY_SYSTEM_PROMPT },
  { role: 'user', content: [
    { type: 'text', text: `[Codex]\n${codexJson}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `[Scene]\n${sceneChunk}` },
  ]},
]
```

実装規律:
- (a) system プロンプトは `const` 文字列定数（template literal で chunk 間に動的注入しない）
- (b) `codexJson` は `input_hash` と同じ `stableStringify` で序列化
- (c) `cache_control: { type: 'ephemeral' }` は Codex prefix と Scene chunk の境界に正確に挿入

失敗モードは silent cost inflation（cache miss でもエラー出ず full 請求）なのでコードコメントで監査ポイントを明記する。

### Provider

MVP は Anthropic 系を前提（直接 or OpenRouter→Anthropic）。OpenRouter 経由でも Anthropic モデル選択時は `cache_control` を pass-through する。

非 Anthropic モデル選択時は UI で「cache 非対応のため Phase 2 以降は chunk 数分のコストがかかります」と警告（Phase 1 は単一コールなので警告不要）。

### Trigger

MVP: 明示ボタンのみ。`[整合性チェック]` と `[自己整合性チェック]` の 2 ボタン。

自動実行（シーン保存後 debounce）は post-MVP、設定で opt-in。

**現状の実装**: 校閲（Kouetsu）パネルの `Issues` タブ配下に統合済み。エントリポイントは `src/features/kouetsu/views/CurrentSceneAnnotationsView.tsx`（現在シーン）と `ProjectAnnotationsView.tsx`（全シーン一括 = folder/project scope 用）。`DismissedAnnotationsView.tsx` で dismissed の一覧／復帰も可能。各 view で `consistency` / `intra` / `both` の 3 モード起動が選べる（ドロップダウン）。エディタツールバーには `consistencyMarks` トグル（`Cs` ボタン）があり、`useAnnotationStore.showAnnotations` を切り替えて `AnnotationPlugin` の Decoration を一括 ON/OFF できる。

### 異常系

- **Codex 単独で budget/2 超**: fallback（mention 上位 K）、`run.metadata.skipped_entries[]` 記録、UI で「Pin/Always が多すぎます」hint
- **単一 Codex entry が単独で `budget * 0.3` 超**: drop + `skipped_entries[]` 記録、UI で「エントリ X が大きすぎてスキップ」hint（閾値の目安は実測で調整）
- **Scene 単独が `budget` 超**: 「このシーン異常に長いです」プロダクト側からの構造的警告として UI 表示。**run 行を作らずに拒否**（`post_effect_runs` に `failed` 行を残さない、UI のヒントだけ表示）
- **API コール失敗（Phase 2 の chunk 単位）**: 1 回リトライ（指数バックオフ 1s）後 `partial_chunks[]` 記録、run 全体は `completed` 確定、UI で再実行ボタン（失敗チャンクのみ）
- **Output schema validation 不一致**: violation 単位で Zod skip-and-log（チャンク全体は失敗にしない）

### 既知の限界（UI 非表示）

- **名前/alias 未一致の semantic 参照**（代名詞・比喩等）は `codex_match_text` で拾えない → SemanticLink で将来カバー。limitation を UI に表示しない（リリースですぐ消えるため）。payload builder に「SemanticLink span 統合点」のコメント TODO を置く
- **シーン内 cross-reference で X と Y が異 chunk に分かれた場合の部分的見逃し**（overlap 200 token で緩和、Phase 2 以降の課題）
- **異シーン間の矛盾検出**は post-MVP（`scope='folder' | 'project'` でも各シーン単独でしか検査しない）

### Phase 分割（実装順）

| Phase | 内容 |
|---|---|
| 1 | migration + payload builder + 単一コール path（Codex+Scene が budget 内のみ対応）+ `found_context` 含む metadata + プロンプト + dedupe + UI 統合（両 effect_type 同時） |
| 2 | Scene chunking（Phase 1 で実測コストを見てから判断） |
| 3 | folder/project scope の per-scene iteration ランナー |
| Future | 自動実行 opt-in / SemanticLink 統合 / 伏線・テーマ feature 解禁 |

---

## 未決事項（実装着手時に決める）

- Outline ビュー上の lens オーバーレイの具体的な視覚表現（バッジ色、テンション曲線の描画手段）
- レビュー/疑似コメントの **1 scene 内の件数上限**（多すぎると本文が埋もれる）
- 疑似コメント生成の**バックグラウンド自動実行**を MVP に入れるか、手動トリガのみか
- `post_effect_annotations.metadata` に入れる JSON のスキーマ（`suggested_diff` の形式など）
- run 一覧を出す専用パネルを新設するか、各エフェクトのエントリポイントから辿らせるか

---

## Tauri コマンド（想定）

エフェクトごとに約5本 × 5種 = 25本前後。命名は snake_case。

| コマンド | 引数 | 返り値 | 実装状況 |
|---|---|---|---|
| `start_post_effect_run` | `{ project_id, effect_type, scope_type, scope_target_id?, model, prompt_version, input_hash, codex_payload_json, scene_text }` | `{ run_id, from_cache }` | ✓ (`consistency` / `intra_scene_consistency` のみ) |
| `start_post_effect_run_multi` | `{ ..., scenes: [{ scene_id, codex_payload_json, scene_text }] }` | `{ run_id, from_cache }` | ✓ (folder / project scope の per-scene iteration ランナー) |
| `abort_post_effect_run` | `{ run_id }` | `()` | ✓ |
| `list_post_effect_runs` | `{ project_id, effect_type?, limit?, offset? }` | `Run[]` | ✓ |
| `get_post_effect_run` | `{ run_id }` | `Run & { annotations, lens_data, relations }` | ✓ |
| `list_annotations_for_scene` | `{ project_id, scene_id, status? }` | `{ annotations: Annotation[], relations: Relation[] }`（`relations` は両端の少なくとも一方が `annotations` に含まれるもの。intra_scene_consistency / 伏線・テーマの hydration に必須）| ✓ |
| `list_annotations_for_project` | `{ project_id, status? }` | `{ annotations: Annotation[] }`（全シーン横断ビュー用）| ✓ |
| `update_annotation_status` | `{ annotation_id, status }` | `Annotation`（relation 経由なら端点もまとめて更新）| ✓ |
| `update_relation_status` | `{ relation_id, status }` | `Relation`（両端 annotation にカスケード）| ✓ |
| `reply_to_annotation` | `{ parent_id, content, author_role }` | 新 `Annotation` | ※ 現状未実装（疑似コメント機能と一緒に post-MVP） |
| `save_post_effect_annotations` | `{ scene_id, annotations[] }` | scene 保存時の同期用（`saveAuthorshipSpans` と同タイミングで呼ぶ）| ✓ |

**キャッシュ短絡（`from_cache`）:** §10「`input_hash` の扱い」に基づき、同 `input_hash` の `completed` run があれば `start_post_effect_run` / `start_post_effect_run_multi` は新 run を起動せず既存 `run_id` を `from_cache: true` で即返す。フロント (`runPostEffect` in `src/features/post-effect/api.ts`) は実 `post_effect:done` が届かないため合成 `onDone` を発火して spinner を確実に解除する。

**ストリームイベント:**

- `post_effect:progress` — `{ run_id, stage, progress: 0..1, message? }`
- `post_effect:partial` — `{ run_id, annotation_id }`（逐次保存された annotation の ID。実装は `annotation` / `lens_data` の完全 payload ではなく ID のみを emit する）
- `post_effect:done` — `{ run_id, annotation_count, summary?, from_cache? }`
- `post_effect:error` — `{ run_id, error }`
