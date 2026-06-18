# Grimodex — リビジョン履歴設計書

> 最終更新: 2026-06-18
> ステータス: 実装済み（プロジェクトスナップショットは構造込み・スコープ選択式に拡張済み。Diff 表示はテキストブロック単位、Tauri 化は未着手）
> 依存: Grimodex_統合DBスキーマ.md（content_versions / project_snapshot_* テーブル）、Grimodex_Editorパネル設計書.md、Grimodex_Codexパネル設計書.md、Grimodex_Snippetsパネル設計書.md

実装ディレクトリ: `src/features/revision/`（`api.ts`, `revisionStore.ts`, `RevisionHistoryModal.tsx`, `projectSnapshotApi.ts`, `ProjectSnapshotModal.tsx`, `projectSnapshotScopes.ts`）。

---

## 概要

すべてのコンテンツ（Scene、Note、Codex エントリ、Snippet）に対してリビジョン履歴を提供する。ユーザーは任意の過去リビジョンの内容をプレビューし、復元できる。

Novelcrafter の Revision History を参考にしたUIを採用する。

---

## 対象エンティティ

| エンティティ | テーブル | content カラム | entity_type 値 |
|-------------|---------|---------------|----------------|
| Scene | `tree_nodes` | `content` | `scene` |
| Note | `tree_nodes` | `content` | `note` |
| Codex エントリ | `codex_entries` | `content` | `codex_entry` |
| Snippet | `snippets` | `content` | `snippet` |

---

## 保存とリビジョンの関係

### 自動保存（content 上書き）

- **トリガー**: 編集停止から2秒後（デバウンス）
- **動作**: 対象テーブルの `content` カラムを現在の ProseMirror JSON で上書き
- **目的**: クラッシュ時のデータ損失防止。リビジョンは作成しない

### 自動リビジョン

- **トリガー**: 自動保存のタイミングで、前回リビジョンから最低間隔（デフォルト: 5分）が経過している場合
- **条件**: 前回リビジョンの content と現在の content が異なる場合のみ作成（無変更スキップ）
- **snapshot_type**: `'auto'`

### 手動リビジョン

- **トリガー**: `Ctrl+S`（明示的保存）
- **動作**: 自動保存 + リビジョン作成（最低間隔を無視して即座に作成）
- **条件**: 前回リビジョンと content が異なる場合のみ（同一内容の重複防止）
- **snapshot_type**: `'manual'`

### 保持上限とプルーニング

- エンティティごとにデフォルト50件
- 上限超過時、`auto` リビジョンを古い順に削除
- `manual` リビジョンは上限計算には含めるが、削除優先度は低い（autoが全て削除された後にmanualを削除）
- Settings で上限数を変更可能（10〜200）

---

## DBスキーマ

> 正規版は [`Grimodex_統合DBスキーマ.md`](Grimodex_統合DBスキーマ.md) の `content_versions` テーブルを参照。

```sql
CREATE TABLE content_versions (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type    TEXT NOT NULL CHECK(entity_type IN ('scene', 'note', 'codex_entry', 'snippet')),
  entity_id      TEXT NOT NULL,
  content        TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  snapshot_type  TEXT NOT NULL DEFAULT 'auto' CHECK(snapshot_type IN ('auto', 'manual')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id, version_number)
);

CREATE INDEX idx_cv_entity ON content_versions(entity_type, entity_id, version_number DESC);
```

---

## UI設計

### 起動方法

エディタフッターバーに **「History」** ボタンを配置（アイコン: `Clock`）。

```
┌─────────────────────────────────────────────────────────┐
│  本文エディタ                                              │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  179 words  ·  2,847 chars    ⏱ History    📋 Copy     │
└─────────────────────────────────────────────────────────┘
```

対象:
- Scene / Note タブ → フッターに History ボタン
- Codex タブ → フッターに History ボタン（content フィールド対象）
- Snippet タブ → フッターに History ボタン

### リビジョン履歴パネル

History ボタンクリックで **モーダルオーバーレイ** を表示する。左右2カラム構成:

```
┌──────────────────────────────────────────────────────────────────┐
│  Revision History                                     × Close   │
├─────────────────────────────────────┬────────────────────────────┤
│  ☐ Show changes                     │  ● Apr 2, 8:43 AM        │
│                                     │    current version  [now] │
│  （選択中リビジョンの                  │                          │
│    コンテンツプレビュー               │  ○ Mar 19, 7:46 PM       │
│    — diff ON時は差分ハイライト）       │    auto                   │
│                                     │                          │
│  栗毛の腰まで届く長いストレート。       │  ○ Mar 19, 7:44 PM       │
│  女性。                              │    manual ★               │
│                                     │                          │
│  元パン屋の店員。帝国の有事            │  ○ Mar 15, 8:00 PM       │
│  により召集、門兵部隊に配属            │    auto                   │
│  された。5等級国民。                   │                          │
│  身長157cm。...                      │  ○ Mar 13, 9:11 PM       │
│                                     │    auto                   │
│                                     │                          │
│                                     │       Load more           │
│                                     │                          │
├─────────────────────────────────────┴────────────────────────────┤
│  [Close]                                          [Restore]     │
└──────────────────────────────────────────────────────────────────┘
```

### 左カラム: コンテンツプレビュー

- 選択中リビジョンの content を **読み取り専用の TipTap インスタンス** でレンダリング
- ProseMirror JSON をそのままパースして表示するため、書式・Codex ハイライト等も再現
- 最新（現在の content）を選択した場合は「Current version」ラベルを表示
- **Diff トグル** で差分表示モードに切り替え可能（後述）

### 右カラム: リビジョン一覧

- 最新のリビジョンが上、古いものが下（降順）
- 各エントリの表示:
  - タイムスタンプ（ローカルタイムゾーン、`Apr 2, 8:43 AM` 形式）
  - サブラベル: `auto snapshot` / `manual snapshot`
  - 手動スナップショットには `●` マーカーで視覚的に区別
- **先頭行は常に「Current version」**（DB ではなく現在の content カラムの値を表示）
- 選択中リビジョンはハイライト背景
- ページネーション: 初回20件ロード、「Load more」で20件ずつ追加読み込み

### フッターアクション

| ボタン | 動作 |
|--------|------|
| Close | モーダルを閉じる |
| Restore | 選択中リビジョンの content を現在の content に上書きし、復元前の状態を `manual` スナップショットとして自動保存。「Current version」選択時は無効化 |

---

## 復元フロー

```
1. ユーザーが過去リビジョンを選択し「Restore」クリック
2. 確認ダイアログ: "Restore to revision from {timestamp}? Current content will be saved as a snapshot."
3. 確認後:
   a. 現在の content を manual スナップショットとして保存（復元前のセーフティネット）
   b. 選択リビジョンの content を対象テーブルの content カラムに上書き
   c. エディタの TipTap インスタンスに新しい content をセット
   d. AuthorshipMark: 復元されたコンテンツの authorship_spans は復元時点のものを維持
      （content_versions には ProseMirror JSON が保存されており、AuthorshipMark も含まれる）
   e. モーダルを閉じる
   f. トースト: "Restored to revision from {timestamp}"
```

**現状の実装**（`RevisionHistoryModal.handleRestoreConfirm`）:
- ステップ a は `createRevision({ snapshotType: 'manual' })` を発行
- ステップ b/c は `mainEditor.commands.setContent(json)` で TipTap を更新したのち、`entityType === 'scene'` の場合のみ `saveSceneContent` で DB に永続化する
- Note / Codex / Snippet の復元時に対象テーブルへ書き戻す処理は **未実装**（エディタ側の自動保存に依存）（※ 現状未実装）

---

## キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+S` | 手動リビジョン作成（自動保存 + リビジョン即座作成） |
| `Ctrl+Shift+H` | History モーダルを開く |
| `Escape` | History モーダルを閉じる |
| `↑` / `↓` | リビジョン一覧内でフォーカス移動 |
| `Enter` | フォーカス中のリビジョンを選択（プレビュー切り替え） |

---

## パフォーマンス考慮

### ストレージ

- ProseMirror JSON は Markdown より冗長（約2〜3倍）。1シーン平均10KB、50リビジョンで約500KB/シーン
- 100シーンのプロジェクトで最大50MBのバージョンデータ。SQLite WAL モードなら問題ない範囲
- プルーニングにより上限を超えない

### クエリ最適化

- リビジョン一覧取得時は `content` カラムを除外し、メタデータのみ取得:
  ```sql
  SELECT id, version_number, snapshot_type, created_at
  FROM content_versions
  WHERE entity_type = ? AND entity_id = ?
  ORDER BY version_number DESC
  LIMIT 20 OFFSET ?;
  ```
- プレビュー時のみ選択リビジョンの `content` を個別取得

### Diff 表示

プレビューカラムの上部に **「Show changes」トグル** を配置する。ON にすると、選択中リビジョンとその1つ前のリビジョン間の差分を表示する。

**現状の実装**（`RevisionHistoryModal.tsx` の `PreviewPanel` / `computeBlockDiff`）:
- ProseMirror JSON のトップレベルブロックごとにプレーンテキストを抽出
- ブロック列を LCS（最長共通部分列）で照合し、未マッチのブロックを変更扱いにする
- プレビューは **左右 2 カラムの並列ビュー**（左: 直前リビジョン、右: 選択リビジョン）
- 変更ブロックには CSS クラス `diff-block-remove` / `diff-block-add` を付与してハイライト

**「Current version」選択時の diff:**
- 現在の content と最新リビジョンの差分を表示（未保存の変更が可視化される）

**制約:**
- ブロック単位の diff のため、同一ブロック内のテキスト差分はハイライトされない。書式変更（太字の追加等）も検出しない
- 将来拡張: `diff-match-patch` 等を用いた文字単位の inline diff、TipTap Decorations による単一カラム表示は未実装

---

## プロジェクトスナップショット（プロジェクト全体）

個別エンティティのリビジョンとは別に、プロジェクト全体の状態を一括で記録・復元する機能。

### 概念

プロジェクトスナップショットは**構造込みスナップショット**である（2026-05-19 に「軽量ポインタ」方式から拡張、`a280ea33`）。スナップショット時点の全エンティティの構造メタ（タイトル / 親 / 並び順 / ステータス / POV / 場所 / 字数 …）を行単位でミラーし、削除されたエンティティの再生成や構造の巻き戻し（リストア）を可能にする。本文（content）は二重保存せず、`body_version_id` で `content_versions` を指すポインタ方式を維持する（参照中のリビジョンは **ON DELETE RESTRICT** でプルーニングから保護）。

格納先は2系統:
- **コアエンティティ**（tree_nodes / codex_entries / snippets）→ 専用 strict テーブル（`project_snapshot_tree_nodes` / `project_snapshot_codex_entries` / `project_snapshot_snippets`）
- **それ以外**（map / foreshadow / labels / lint / authorship / generation_logs / post-effect 注釈 など 30+ テーブル）→ `project_snapshot_aux(scope, payload_json)` に **スコープ別の JSON 生コピー**（1 スコープ 1 行）

旧形式（軽量ポインタのみ）のスナップショットも `project_snapshot_entries` の content ポインタとして引き続き読め、リストア時に legacy フォールバック（後述）で扱う。

### DBスキーマ

> `project_snapshots` / `project_snapshot_entries` / `project_snapshot_tree_nodes` / `project_snapshot_codex_entries` / `project_snapshot_snippets` / `project_snapshot_aux` の DDL・FK・プルーニング保護トリガーの正規版は [`Grimodex_統合DBスキーマ.md`](Grimodex_統合DBスキーマ.md) を参照。aux ペイロード（`{ rows: RawRow[] }`）の形は `src/features/revision/projectSnapshotScopes.ts` が正本。

### プルーニング保護

プロジェクトスナップショットが参照している `content_versions` レコードは、個別エンティティのプルーニング対象から**除外**する。これにより、プロジェクトスナップショットの整合性が保証される。参照判定は legacy の `project_snapshot_entries.version_id` だけでなく、構造込みテーブル 3 種（`project_snapshot_tree_nodes` / `_codex_entries` / `_snippets`）の `body_version_id` も含む（JS 側 `pruneRevisions` は前者のみ除外するが、DB 側は後者にも **ON DELETE RESTRICT** を張りトリガーで全 4 経路を保護する）。除外条件の正規版は [`Grimodex_統合DBスキーマ.md`](Grimodex_統合DBスキーマ.md) を参照。

### 作成フロー

スナップショット作成は**常に全スコープを丸ごと**キャプチャする（スコープ選択はリストア時のみ・後述）。本文だけでなく構造メタ・付帯データもまとめて記録する。

```
1. ダイアログ「新しいスナップショット」: 名前（必須）+ 説明（任意）を入力
2. 作成処理:
   a. project_snapshots レコードを作成（UNIQUE(project_id, name)）
   b. Scene/Note → project_snapshot_tree_nodes へ構造メタ（title/parent/
      sort_order/status/pov_character_id/location_id/synopsis/intent/字数 …）
      を行単位でミラー。本文を持つノードは getOrCreateRevisionId で手動
      リビジョンを採番し body_version_id で参照（既に最新と同一なら既存
      リビジョンを再利用。フォルダは空 content なのでスキップ）
   c. Codex → project_snapshot_codex_entries（type/name/parent/aliases/
      summary/icon/context_mode/notes …）、Snippet → project_snapshot_snippets
      も同様に構造ミラー + body_version_id
   d. 旧クライアント互換のため body_version_id 群を project_snapshot_entries
      にもミラー（entryCount もここから算出）
   e. 付帯スコープ（map / foreshadow / labels / lint / authorship_spans /
      generation_logs / post_effect_annotations / scene_codex_* など）を
      各テーブルの現プロジェクト行をそのまま JSON 化し project_snapshot_aux
      にスコープ別 1 行で記録（テーブルが存在しない環境では空ペイロード）
3. トースト: "スナップショット「{name}」を作成しました（{N} エンティティ）"
```

> 作成は厳密にはトランザクションではない。途中失敗で content_versions に残る孤児リビジョンは無害でプルーニング対象になる（リストア側は後述のとおりトランザクショナル）。

### 復元フロー

復元は**スコープ選択式**（後述）で、構造込みスナップショットは「選択スコープを丸ごと wipe → スナップショット行から再構築」する。

```
1. スナップショット一覧で復元対象を選択し「この時点に復元」クリック
2. 確認ダイアログ: スコープ選択チェックボックス（構造込みのみ）+ 警告
3. 確認後:
   a. 現在の全状態をセーフティネットとして自動スナップショット保存
      （名前: "Before restore to '{name}' ({ISO timestamp})"。常に全スコープ。
        timestamp 接尾辞で UNIQUE(project_id, name) を回避）
   b. 形式検出: project_snapshot_aux に行があれば structural、無ければ legacy
   c-structural. 単一トランザクションのバッチで:
      ① PRAGMA defer_foreign_keys = ON（FK チェックを COMMIT 時に遅延）
      ② wipe されるスコープを跨ぐ CASCADE FK を事前 NULL 化
         （例: body を wipe するが map 非選択のとき map_node_positions.tree_node_id）
      ③ 選択スコープの最上位テーブルを project_id で DELETE（子は CASCADE）
      ④ スナップショット行を INSERT で再構築。除外スコープへの FK は
         NULL 化または skip（後述）
      ⑤ COMMIT
   c-legacy. project_snapshot_entries の version_id から content を取得し、
      現存する同一 ID のエンティティの content カラムのみ UPDATE
      （スコープ選択は無視）
   d. window.location.reload() でエディタを再初期化
4. トースト: "スナップショット「{name}」に復元しました（{N} エンティティ）"
   + スキップが発生した場合は件数を info トーストで補足
```

### 復元スコープと依存・スキップ（2026-05-19 追記）

構造込みスナップショットの復元時、確認ダイアログに**スコープ選択チェックボックス**を表示する（`ProjectSnapshotModal.tsx`、`projectSnapshotScopes.ts` の `RESTORE_SCOPES` を列挙）。既定は全選択。旧形式スナップショットでは「本文のみが復元されます」の注記を出し、チェックボックスは表示しない。

| スコープ (`RestoreScope`) | ラベル | 対象 | 依存 |
|---------------------------|--------|------|------|
| `body` | 本文・章立て | tree_nodes（構造＋本文）・authorship_spans・post-effect 注釈・scene_codex_*・generation_logs | — |
| `codex` | コーデックス | codex_entries・types・tags・detail・phases・relations 等 | — |
| `snippet` | スニペット | snippets・snippet_entry_tags | — |
| `map` | マップ・付箋 | map_boards 配下（位置・付箋・繋ぎ線・AI 分岐・フレーム） | — |
| `foreshadow` | 伏線 | foreshadows・setups・codex_links | — |
| `labels` | ラベル | labels・tree_node_labels | `body`（tree_node_labels.node_id は NOT NULL） |
| `lint` | 校閲設定 | lint_ignored_diagnostics・lint_term_dictionary | `body`（scene_id は NOT NULL） |

**依存スコープ未選択時の FK 処理**（除外スコープへの参照をどう扱うか。`AUX_BODY_DEPENDENCY` / `AUX_CODEX_DEPENDENCY`）:
- **skip**: NOT NULL FK で参照先が live DB に存在しない行は丸ごと捨てる（tree_node_labels / lint_ignored_diagnostics / foreshadow_setups / foreshadow_codex_links / scene_codex_pins・mentions / scene_beat_pov_cache 等）
- **NULL 化**: NULL 可の FK 列だけを NULL にして行は復元する（foreshadows.payoff_scene_id / map_node_positions.tree_node_id・codex_entry_id / tree_nodes.pov_character_id・location_id）

skip / NULL 化した件数は復元結果 `RestoreResult.skipped`（`SkipReport`）で返り、0 でなければ「{count} 件のアイテムは依存するデータ範囲が選択されていないため復元をスキップしました」の info トーストで通知する。`body` を OFF にすると伏線・マップ・校閲・ラベルなどの一部が復元されない旨をダイアログ内でも注意喚起する。

### スナップショット一覧 UI

「Project → Snapshots...」でモーダルを表示する（作成フォーム・一覧・フッターの Delete / Close / Restore を1画面に統合。Restore クリックで上記スコープ選択ダイアログへ）:

```
┌──────────────────────────────────────────────────────────────┐
│  Project Snapshots                                 × Close   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ★ 第3章完成                              Apr 2, 2026 8:30 PM │
│    提出前の最終チェック済み版                  42 entities     │
│                                                              │
│  ★ キャラ設定FIX                          Mar 28, 2026 3:15 PM│
│    全キャラの設定を確定                       38 entities     │
│                                                              │
│  ★ Before restore to '第3章完成'          Apr 2, 2026 9:00 PM │
│    (auto)                                    42 entities     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  [Delete]              [Close]              [Restore]        │
└──────────────────────────────────────────────────────────────┘
```

### 保持上限

- プロジェクトスナップショットはデフォルト上限なし（手動作成のため頻度が低い）
- 削除は手動のみ。削除時は `project_snapshot_entries` / `project_snapshot_tree_nodes` / `_codex_entries` / `_snippets` / `_aux` がすべて ON DELETE CASCADE で削除される
- 参照されなくなった `content_versions`（`version_id` / `body_version_id` のいずれからも参照されなくなったもの）は次回プルーニング時に通常通り削除対象になる

### データアクセス API

**現状の実装**: `src/features/revision/projectSnapshotApi.ts`。プロジェクト ID は `getCurrentProjectId()` から取得する（旧版の内部定数 `"default-project"` 固定は撤廃）。作成・一覧・legacy 復元は Drizzle ORM を使うが、構造込み復元は **生 SQL**（`db_execute` / `db_execute_batch` の Tauri コマンド）を多用する大規模実装に拡大した。aux ペイロードを drizzle のモデル型（Date/boolean）に通すと SQLite の素の格納形（INTEGER/TEXT）とずれるため、aux スコープは読み書きとも drizzle をバイパスして生の行（string/number/null）で扱う。

```typescript
createProjectSnapshot(params: {
  name: string;
  description?: string;
}): Promise<{ id: string; entryCount: number }>

listProjectSnapshots(): Promise<ProjectSnapshotMeta[]>  // isStructural を含む

interface RestoreOptions {
  scopes?: ReadonlySet<RestoreScope>;   // 既定: 全スコープ。legacy では無視
}

interface RestoreResult {
  restoredCount: number;
  safetySnapshotId: string;
  format: "structural" | "legacy";      // 形式検出の結果
  skipped: SkipReport;                  // skip / NULL 化した行数
}

restoreProjectSnapshot(
  snapshotId: string,
  snapshotName: string,                 // safety スナップショット名生成のため UI から渡す
  options?: RestoreOptions,
): Promise<RestoreResult>

deleteProjectSnapshot(snapshotId: string): Promise<void>
```

構造込み復元は選択スコープを wipe → スナップショット行から再構築する単一トランザクション（`PRAGMA defer_foreign_keys`）で実行する。legacy 復元は現存エンティティの `content` を直接 UPDATE するのみ。いずれの後も `ProjectSnapshotModal` 側で `window.location.reload()` を呼んでエディタを再初期化する（※ TipTap インスタンスを個別に更新する設計は未実装）。

**将来拡張**: Rust 側に同等の Tauri コマンドを切り出す案は未実装（生 SQL は `db_execute` 経由で Rust に渡るが、復元ロジック自体はフロント側）（※ 現状未実装）。


---

## 他パネルとの連携

### Editor

- フッターバーに History ボタンを追加
- `Ctrl+S` で手動リビジョン作成
- 自動保存のタイミングで自動リビジョンの経過時間判定

### Codex

- Codex エントリの詳細画面フッターに History ボタンを追加
- 対象は `codex_entries.content` カラム

### Snippets

- Snippet 編集画面フッターに History ボタンを追加
- 対象は `snippets.content` カラム

### Settings

- 自動リビジョン最低間隔: 設定キー `revision.autoInterval`（単位: 分、デフォルト 5、範囲: 1〜60）
- リビジョン保持上限: 設定キー `revision.keepCount`（デフォルト 50、範囲: 10〜200）
- いずれも global スコープ。UI は `src/features/settings/categories/DataCategory.tsx` で提供

---

## データアクセス API

**現状の実装**: Tauri コマンドではなく、フロントエンドから Drizzle ORM 経由で SQLite を直接操作する（`src/features/revision/api.ts`）。

```typescript
// リビジョン一覧取得（メタデータのみ、content は空文字で返す）
listRevisions(
  entityType: EntityType,
  entityId: string,
  limit = 20,
  offset = 0,
): Promise<RevisionMeta[]>

// 特定リビジョンの取得（content を含む）
getRevision(id: string): Promise<ContentVersion | undefined>

// リビジョン作成（前回と同一 content ならスキップして null を返す）
// version_number は INSERT 内のサブクエリ
// `(select coalesce(max(version_number),0)+1 ...)` で**原子的に採番**する
// （fa8b0b45）。JS 側で max+1 を先読みすると、並走する saveFn（flush 二重
//  発火等）が同じ番号を計算して UNIQUE(entity_type, entity_id, version_number)
//  衝突を起こし、auto-revision が全滅する不具合があったため。
createRevision(params: {
  entityType: EntityType;
  entityId: string;
  content: string;
  snapshotType: 'auto' | 'manual';
}): Promise<ContentVersion | null>

// 最新リビジョンの content 取得
getLatestRevisionContent(
  entityType: EntityType,
  entityId: string,
): Promise<string | null>

// プルーニング（auto を古い順に削除、project_snapshot_entries 参照ぶんは保護）
pruneRevisions(
  entityType: EntityType,
  entityId: string,
  keepCount = 50,
): Promise<void>
```

呼び出し箇所:
- 自動リビジョン: `src/features/editor/EditorPane.tsx`（scene 用 `saveFn`）、`CodexDetailContent.tsx`、`SnippetDetailContent.tsx`
- 手動リビジョン（`Ctrl+S`）: 同上の `handleManualSave` 系
- プルーニングは `createRevision` 成功時に `revision.keepCount` を読み出して非同期実行

**将来拡張**: Rust 側に `list_content_versions` / `get_content_version` / `create_content_snapshot` / `restore_content_version` / `prune_content_versions` を Tauri コマンドとして切り出す案は未実装（※ 現状未実装）。

---

## Zustand ストア

**現状の実装**（`src/features/revision/revisionStore.ts`）:

```typescript
interface RevisionHistoryState {
  // モーダル状態
  isOpen: boolean;
  entityType: EntityType | null;
  entityId: string | null;
  currentContent: string | null;   // 「Current version」表示用の現在の content

  // リビジョンデータ
  revisions: RevisionMeta[];
  selectedRevisionId: string | null;  // null = 「Current version」
  selectedContent: string | null;     // 選択中リビジョンの ProseMirror JSON
  isLoadingContent: boolean;
  page: number;
  hasMore: boolean;

  // 自動リビジョンの間隔判定（エンティティ別の最終リビジョン時刻）
  lastAutoRevisionAt: Record<string, number>;

  // アクション
  openHistory: (entityType: EntityType, entityId: string, currentContent: string) => void;
  closeHistory: () => void;
  loadRevisions: () => Promise<void>;
  loadMore: () => Promise<void>;
  selectRevision: (id: string | null) => Promise<void>;
  recordAutoRevision: (entityId: string) => void;
  shouldAutoRevision: (entityId: string, intervalMs?: number) => boolean;
}
```

- `PAGE_SIZE = 20`（モジュール定数）
- ヘルパー `getEntityType(nodeType)` で TreeNode の `nodeType` → `EntityType` 変換を提供
- 復元処理（`restore`）はストアではなく `RevisionHistoryModal` の `handleRestoreConfirm` 内に実装されている（※ 設計とは配置が異なる）

---

## 正とする設計書

| 仕様 | 正とする文書 |
|------|------------|
| `content_versions` テーブル定義 | Grimodex_統合DBスキーマ.md |
| `project_snapshots` / `project_snapshot_entries` / `project_snapshot_tree_nodes` / `_codex_entries` / `_snippets` / `_aux` テーブル定義 | Grimodex_統合DBスキーマ.md |
| 復元スコープ定義・aux ペイロード形 | `src/features/revision/projectSnapshotScopes.ts`（コード正本） |
| Settings のリビジョン設定項目 | Grimodex_Settingsパネル設計書.md |
| Editor フッターバーの配置 | Grimodex_Editorパネル設計書.md |
| 本機能の UI・フロー・ポリシー | **本設計書** |
