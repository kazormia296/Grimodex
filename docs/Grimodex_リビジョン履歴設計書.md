# Grimodex — リビジョン履歴設計書

> 最終更新: 2026-04-02
> ステータス: 設計中
> 依存: Grimodex_統合DBスキーマ.md（content_versions テーブル）、Grimodex_Editorパネル設計書.md、Grimodex_Codexパネル設計書.md、Grimodex_Snippetsパネル設計書.md

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

プレビューカラムの上部に **「Show changes」トグル** を配置する。ON にすると、選択中リビジョンとその1つ前のリビジョン間の差分をインラインハイライトで表示する。

**実装方式:**
- ProseMirror JSON から両バージョンのプレーンテキストを抽出（`Node.textContent`）
- テキストレベルの diff を `diff-match-patch`（Google製、軽量）で算出
- 差分結果を TipTap Decorations としてレンダリング:
  - 追加テキスト: `background: rgba(0, 180, 0, 0.2)`（緑ハイライト）
  - 削除テキスト: `background: rgba(255, 0, 0, 0.2); text-decoration: line-through`（赤取り消し線）

**「Current version」選択時の diff:**
- 現在の content と最新リビジョンの差分を表示（未保存の変更が可視化される）

**制約:**
- テキストレベルの diff のため、書式変更（太字の追加等）は検出しない。テキストの追加・削除・変更のみ表示

---

## マスタースナップショット（プロジェクト全体）

個別エンティティのリビジョンとは別に、プロジェクト全体の状態を一括で記録・復元する機能。

### 概念

マスタースナップショットは**軽量ポインタ**である。全エンティティの「その時点の content_version ID」を記録するだけで、content を二重に保存しない。

### DBスキーマ

> 正規版は [`Grimodex_統合DBスキーマ.md`](Grimodex_統合DBスキーマ.md) を参照。

```sql
CREATE TABLE project_snapshots (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,              -- ユーザーが付ける名前（例: "第3章完成", "提出前"）
  description TEXT,                       -- 任意のメモ
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_snapshots ON project_snapshots(project_id, created_at DESC);

-- マスタースナップショットと各エンティティの content_version の紐付け
CREATE TABLE project_snapshot_entries (
  snapshot_id    TEXT NOT NULL REFERENCES project_snapshots(id) ON DELETE CASCADE,
  version_id     TEXT NOT NULL REFERENCES content_versions(id),
  PRIMARY KEY (snapshot_id, version_id)
);
```

### プルーニング保護

マスタースナップショットが参照している `content_versions` レコードは、個別エンティティのプルーニング対象から**除外**する。これにより、マスタースナップショットの整合性が保証される。

```sql
-- プルーニング時の除外条件
DELETE FROM content_versions
WHERE id NOT IN (SELECT version_id FROM project_snapshot_entries)
  AND entity_type = ? AND entity_id = ?
  AND ...;
```

### 作成フロー

```
1. メニュー「Project → Create Snapshot...」または Ctrl+Alt+S
2. ダイアログ: 名前（必須）+ 説明（任意）を入力
3. 作成処理:
   a. project_snapshots レコードを作成
   b. 全エンティティ（Scene/Note/Codex/Snippet）の現在の content で
      手動リビジョンを一括作成（既に最新リビジョンと同一なら作成スキップ）
   c. 作成されたリビジョン ID を project_snapshot_entries に記録
4. トースト: "Project snapshot '{name}' created ({N} entities)"
```

### 復元フロー

```
1. メニュー「Project → Snapshots...」でスナップショット一覧を表示
2. 復元対象を選択し「Restore」クリック
3. 確認ダイアログ: "Restore project to '{name}'? All current content will be saved as snapshots first."
4. 確認後:
   a. 現在の全エンティティの状態を自動マスタースナップショットとして保存（セーフティネット、名前: "Before restore to '{name}'"）
   b. project_snapshot_entries の各 version_id から content を取得
   c. 対応する各テーブルの content カラムを一括上書き
   d. 開いているエディタの TipTap インスタンスを更新
5. トースト: "Restored to snapshot '{name}'"
```

### スナップショット一覧 UI

メニュー「Project → Snapshots...」でモーダルを表示:

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

- マスタースナップショットはデフォルト上限なし（手動作成のため頻度が低い）
- 削除は手動のみ。削除時は `project_snapshot_entries` もCASCADE削除
- 参照されなくなった `content_versions` は次回プルーニング時に通常通り削除対象になる

### Tauri コマンド

```typescript
// マスタースナップショット作成
invoke('create_project_snapshot', {
  projectId: string,
  name: string,
  description?: string
}): Promise<{ id: string; entryCount: number }>

// マスタースナップショット一覧
invoke('list_project_snapshots', {
  projectId: string
}): Promise<{ id: string; name: string; description: string | null; entryCount: number; createdAt: string }[]>

// マスタースナップショット復元
invoke('restore_project_snapshot', {
  snapshotId: string
}): Promise<{ restoredCount: number; safetySnapshotId: string }>

// マスタースナップショット削除
invoke('delete_project_snapshot', {
  snapshotId: string
}): Promise<void>
```

### キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+S` | マスタースナップショット作成ダイアログを開く |

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

- 自動リビジョン最低間隔（デフォルト: 5分、範囲: 1分〜60分）
- リビジョン保持上限（デフォルト: 50、範囲: 10〜200）

---

## Tauri コマンド

```typescript
// リビジョン一覧取得（メタデータのみ、contentは含まない）
invoke('list_content_versions', {
  entityType: string,   // 'scene' | 'note' | 'codex_entry' | 'snippet'
  entityId: string,
  limit: number,        // default: 20
  offset: number        // default: 0
}): Promise<{ id: string; versionNumber: number; snapshotType: 'auto' | 'manual'; createdAt: string }[]>

// 特定リビジョンのcontent取得
invoke('get_content_version', {
  versionId: string
}): Promise<{ id: string; content: string; versionNumber: number; snapshotType: string; createdAt: string }>

// 手動スナップショット作成
invoke('create_content_snapshot', {
  entityType: string,
  entityId: string,
  content: string       // 現在のProseMirror JSON
}): Promise<{ id: string; versionNumber: number }>

// リビジョン復元
invoke('restore_content_version', {
  versionId: string
}): Promise<{ restoredContent: string; safetySnapshotId: string }>

// プルーニング（アプリ起動時 or スナップショット作成時に自動呼び出し）
invoke('prune_content_versions', {
  entityType: string,
  entityId: string,
  maxVersions: number   // Settingsから取得
}): Promise<number>     // 削除された件数
```

---

## Zustand ストア

```typescript
interface RevisionHistoryState {
  // モーダル状態
  isOpen: boolean;
  entityType: EntityType | null;
  entityId: string | null;

  // リビジョンデータ
  revisions: RevisionMeta[];
  selectedRevisionId: string | null;
  selectedContent: string | null;   // 選択中リビジョンのProseMirror JSON
  hasMore: boolean;

  // アクション
  open: (entityType: EntityType, entityId: string) => Promise<void>;
  close: () => void;
  selectRevision: (revisionId: string) => Promise<void>;
  loadMore: () => Promise<void>;
  restore: (revisionId: string) => Promise<void>;
}
```

---

## 正とする設計書

| 仕様 | 正とする文書 |
|------|------------|
| `content_versions` テーブル定義 | Grimodex_統合DBスキーマ.md |
| `project_snapshots` / `project_snapshot_entries` テーブル定義 | Grimodex_統合DBスキーマ.md |
| Settings のリビジョン設定項目 | Grimodex_Settingsパネル設計書.md |
| Editor フッターバーの配置 | Grimodex_Editorパネル設計書.md |
| 本機能の UI・フロー・ポリシー | **本設計書** |
