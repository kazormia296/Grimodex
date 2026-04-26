# Grimodex ポストエフェクト機能 設計書

## 概要

ポストエフェクト（Post-Effect）とは、既に書かれた本文に対して**書き換えずに注釈を重ねる AI パス**の総称。本体の執筆フローとは別軸で走り、書き手のセルフレビュー・推敲支援を担う。

本書が対象とする4機能:

| 機能 | 概要 | 単位 |
|------|------|------|
| レビュー | 編集者視点の診断レポート（構造化所見リスト） | span |
| 疑似コメント | 読者ペルソナによる本文横の吹き出し、スレッド可 | span |
| メタ構造レビュー | プロット構造・ペーシングなどの俯瞰診断 | scene/folder |
| 整合性チェック | 事実の矛盾・伏線回収・テーマ一貫性の照合 | span ペア |

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
  effect_type     TEXT NOT NULL,          -- 'review' | 'pseudo_comment' | 'meta_structure' | 'consistency'
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

**Codex を絡めた整合性の扱い（MVP簡略化）:** Codex 基点のケース（例: Codex「目=青」 vs 本文「緑」）は relation 行を作らず、**scene 側に単独 annotation** を作り `metadata.codex_ref` に codex_entry_id を格納する。Codex をアンカーにした対等な pair relation は post-MVP（`anchor_type='codex_entry'` 導入時に対応）。

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
| 整合性チェック | ✓ (両端の錨: `consistency_anchor`) | ✓ (`relation_type=contradiction`) | — |
| 伏線・回収 | ✓ (`foreshadow_anchor`) | ✓ (`foreshadowing`, `direction=a_to_b`) | — |
| テーマ一貫性 | ✓ (`theme_anchor`) | ✓ (`theme_echo`) | — |

---

## 方針決定事項

### 1. レビュー再実行時の前回所見の扱い

**方針:** 新しい run が同一 `(project, effect_type='review', scope)` に対して完了した時点で、**`status='open'` の前回所見を自動的に `dismissed` にする（`run_id` は元のまま保持）**。`status='resolved'` は履歴として残す。

- ユーザーが前回のレビュー中に resolve した項目は「取り組んだ実績」として残る
- 未対応の `open` は新レビューに置き換わる（重複列挙を避ける）
- 削除ではなく dismiss なので、必要なら監査可能

### 2. Relation と端点 annotation の status 連動

**方針:** relation を `resolved` / `dismissed` にしたとき、**両端の annotation を同じ status に伝播する**。逆方向（片端 annotation の dismiss）は relation には波及させない（片端だけでは意味のある事実関係が壊れるため、relation は生存させてUIで警告表示する）。

### 3. 位置追跡の権威性

**方針: 開いているドキュメント内ではライブのマーク位置が唯一の真実。DB の `range_start/end` は hydration（初回ロード）・range 失効時の復旧・エディタを開いていないクロスシーンクエリにのみ使う。**

- doc → DB 同期: scene 保存時に `saveAuthorshipSpans` と同一トランザクション内で、マークから range を抽出して `post_effect_annotations.range_start/end` を更新する（`text_snapshot` も同時に更新）。
- DB → doc 復元: 初回ロード時に `applyInitialMarks` と同じ `programmaticInsert` meta 付きでマークを貼る。
- 絶対にやらないこと: 開いているドキュメントに対してDBの `range_start/end` を直接描画する。off-by-N のドリフトを呼ぶ。

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

### 9. Outline オーバーレイの鮮度表示

**方針:** メタ構造レビューの run 完了後に `tree_nodes.content` が変更された scene については、Outline ビュー上の lens 表示を「stale」扱い（薄いグレー + ツールチップ「このシーンは run 以降に編集されています」）。判定は `tree_nodes.updated_at > run.completed_at` で行う。

### 10. `input_hash` の扱い

**方針:** MVP では nullable のまま実装し、生成アルゴリズムは未定義。再実行スキップの最適化はポスト MVP。

### 11. `category` の種別混在について

`category` は「ユーザー可視の種類」（`review`, `pseudo_comment`）と「構造的役割」（`consistency_anchor` 他）が混在する。これは意図的で、分割しない。UI 側のレンダラで:
- `*_anchor` には単体の「Resolve」ボタンを出さない（relation 側で resolve する）
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
| LLM ストリーミング | `src-tauri/src/lib.rs::send_chat_message_stream` + `listen("chat:stream-*")` | `run_post_effect` + `post_effect:progress` / `:done` / `:error` イベント |
| 中断 | `StreamAbortFlag` (AtomicBool tauri state) | `PostEffectAbortFlag` を run ごとに用意 |
| Tauri コマンド命名 | snake_case（例: `send_chat_message`） | `start_post_effect_run` / `abort_post_effect_run` / `list_post_effect_runs` / `resolve_annotation` / `dismiss_annotation` |

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

- `post_effect_runs` テーブル（4つの `effect_type` 全てのガワ）
- `post_effect_annotations` テーブル（`scene_range` アンカーのみ）
- `scene_lens_data` テーブル（`lens_type='plot_structure'` と `'pacing'` のみ生成）
- 機能: **レビュー** と **疑似コメント** と **メタ構造レビュー（plot_structure + pacing）**
- FTS5 インデックス
- TipTap マーク / Decoration / 同期パイプライン
- run ステータス遷移 + クラッシュリカバリ
- Outline ビューへのオーバーレイ表示

### ポスト MVP

- `post_effect_annotation_relations` テーブル（relations を使う機能一式）
- 機能: **整合性チェック** / **伏線・回収** / **テーマ一貫性**
- `anchor_type='codex_entry'` 導入（Codex 基点の対等な relation）
- `lens_type='character_arc' / 'pov'`
- `scope_type='selection'`
- `input_hash` による再実行スキップ
- ビート粒度の分析
- run 保持件数制限の設定

**この順序の理由:** relation と Codex アンカーは設計複雑度が他より一段高い。一方でレビュー・疑似コメント・メタ構造レビューはユーザー価値が独立して出せるので先行投入し、実使用から relation 側の要件を磨く。

---

## 未決事項（実装着手時に決める）

- Outline ビュー上の lens オーバーレイの具体的な視覚表現（バッジ色、テンション曲線の描画手段）
- レビュー/疑似コメントの **1 scene 内の件数上限**（多すぎると本文が埋もれる）
- 疑似コメント生成の**バックグラウンド自動実行**を MVP に入れるか、手動トリガのみか
- `post_effect_annotations.metadata` に入れる JSON のスキーマ（`suggested_diff` の形式など）
- run 一覧を出す専用パネルを新設するか、各エフェクトのエントリポイントから辿らせるか

---

## Tauri コマンド（想定）

エフェクトごとに約5本 × 4種 = 20本前後。命名は snake_case。

| コマンド | 引数 | 返り値 |
|---|---|---|
| `start_post_effect_run` | `{ project_id, effect_type, scope_type, scope_target_id?, model, prompt_version }` | `run_id` |
| `abort_post_effect_run` | `{ run_id }` | `()` |
| `list_post_effect_runs` | `{ project_id, effect_type?, limit?, offset? }` | `Run[]` |
| `get_post_effect_run` | `{ run_id }` | `Run & { annotations, lens_data, relations }` |
| `list_annotations_for_scene` | `{ project_id, scene_id, status? }` | `Annotation[]` |
| `update_annotation_status` | `{ annotation_id, status }` | `Annotation`（relation 経由なら端点もまとめて更新）|
| `update_relation_status` | `{ relation_id, status }` | `Relation`（両端 annotation にカスケード）|
| `reply_to_annotation` | `{ parent_id, content, author_role }` | 新 `Annotation` |
| `save_post_effect_annotations` | `{ scene_id, annotations[] }` | scene 保存時の同期用（`saveAuthorshipSpans` と同タイミングで呼ぶ）|

**ストリームイベント:**

- `post_effect:progress` — `{ run_id, stage, progress: 0..1, message? }`
- `post_effect:partial` — `{ run_id, annotation | lens_data }`（逐次結果）
- `post_effect:done` — `{ run_id, summary }`
- `post_effect:error` — `{ run_id, error }`
