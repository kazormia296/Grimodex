# Grimodex ゴミ箱パネル設計書 v3

## 1. 概要

ゴミ箱パネル（内部名: Trash Bin、メタファ名: 文屑箱）は、エディタで削除された **文字屑** に加えて Scene / Codex エントリ / Snippet / Map Sticky / Foreshadow / Grid 専用構造などの **削除物全般** を物理的に「落下して溜まる」視覚で保持し、偶然の再発見と再利用を促すパネル。

> **現状の実装**: Pin の trash 連携は未着手 (`PinPayload` 型・`pinStore` フック・`pin-panel` drop target いずれも未実装)。本書中の Pin への言及は **将来拡張**として残している。 Scenes パネル設計書（`docs/Grimodex_Scenesパネル設計書.md`）からの link 関係はそのまま。

良い表現や付箋は光り輝き、ユーザーは **ドラッグ&ドロップ** で拾い出して、好きなパネル（本文エディタ・Scenes・Map など）に置き直す。執筆ツールならではの「削除＝物理的に捨てる」体験を視覚化する。

デフォルト位置: Bottom Dock（非表示）  
キーボードショートカット: `Ctrl+Alt+B`（Bin。`Ctrl+Alt+T` は linter が占有済み）

### v2 (文字屑限定) からの拡張ポイント

- データモデルを `kind: "text-fragment" | "structure-item"` の二系統に
- 構造アイテムキャプチャは各 feature の delete 経路内で `captureHooks.ts` の `capture*Deletion` を呼ぶ（実装は `trashBinStore.enqueuePending` を内部で叩く）
- 再挿入は **D&D 一本化**（Popover はプレビュー専用）。元の位置に戻すロジックは無し、ユーザーがドロップ先を選ぶ
- 各構造アイテムは subKind 固有の見た目（付箋・カード・ピン）で物理フィールドに混在
- Global Undo（Scenes/Codex/Snippets/Pins 統合済）と並走。短期 undo = Global Undo、60日保管 = ゴミ箱

---

## 2. パネル構造

縦長の「瓶」状コンテナ。削除物は上部から落下し、床と他 body に衝突しながら積もる。サイズは **subKind ごとに階層化**:

| 系統 | subKind | おおよその寸法 | 見た目 |
|---|---|---|---|
| 文字屑 | text-fragment | 80–240 × 24–48 | 細長い文字片 |
| 構造 | scene | 200 × 80 | ミニ GridSceneCard 風 |
| 構造 | codex-entry | 160 × 60 | 角丸ボックス + アイコン |
| 構造 | snippet | 140 × 100 | ペーパー風 |
| 構造 | map-sticky | 120 × 120 | 黄色付箋（傾きランダム） |
| 構造 | foreshadow | 120 × 40 | 赤糸モチーフ |
| 構造 | pin | 40 × 40 | ピンアイコン |
| 構造 | grid-chapter | 200 × 40 | 帯状ヘッダ |

```
┌──────────────────────────────────┐
│ A. Header                         │
│ ゴミ箱  18 屑    [🌀かき混ぜる][🗑]│
├──────────────────────────────────┤
│                                   │
│ B. 物理フィールド                  │
│                                   │
│  ┌Scene────┐                      │
│  │ #03 月夜の…│  "彼女は静かに微笑んだ"│
│  └─────────┘            ✨        │
│                                   │
│   📌  ┌付箋┐    "——"             │
│       │メモ│                      │
│       └─/─┘                       │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  [text片] [Codex] [text片✨] [付箋]│
│       [foreshadow] [grid-chapter] │
└──────────────────────────────────┘
         ▲ 床、bodyが積もる
```

aria-label: 「ゴミ箱。削除物 {n} 件」  
`prefers-reduced-motion: reduce` 時は物理を止めてリスト表示に切り替える（§11 参照）。

---

## 3. データモデル

### `trashItems` テーブル

| カラム          | 型                | 説明                                                                       |
|----------------|------------------|---------------------------------------------------------------------------|
| `id`           | TEXT PRIMARY KEY | `nanoid`                                                                   |
| `projectId`    | TEXT NOT NULL    | 外部キー                                                                   |
| `kind`         | TEXT NOT NULL    | `"text-fragment"` / `"structure-item"`                                     |
| `subKind`      | TEXT NOT NULL    | `"text-fragment"` / `"scene"` / `"codex-entry"` / `"snippet"` / `"map-sticky"` / `"foreshadow"` / `"grid-chapter"`（`"pin"` は将来拡張、※ 現状未実装） |
| `originSceneId`| TEXT             | 文字屑のとき、削除元 Scene の id（参照のみ。Scene 削除時は CASCADE） |
| `originCodexId`| TEXT             | 文字屑のとき、削除元 Codex の id                                            |
| `previewText`  | TEXT NOT NULL    | 物理 body のラベル表示用。500 文字で truncate                              |
| `previewMeta`  | TEXT             | JSON。subKind 固有のメタ（色・アイコン名など、§16 参照）                      |
| `payload`      | TEXT NOT NULL    | JSON。subKind ごとに異なる構造を保持（§16 の payload 表参照）                 |
| `charCount`    | INTEGER NOT NULL | 文字数（`[...previewText].length`）                                        |
| `isInteresting`| INTEGER (0/1)    | 光る判定（§3.3）                                                           |
| `deletedAt`    | TEXT NOT NULL    | ISO8601                                                                    |

**インデックス**: `(projectId, deletedAt DESC)`、`(projectId, kind, deletedAt DESC)`

> 確定 DDL・FK・他テーブルとの関係は [`docs/Grimodex_統合DBスキーマ.md`](./Grimodex_統合DBスキーマ.md) の `trash_items` 節を正本とする（本書では再掲しない）。

**CASCADE ON DELETE**:
- `projectId` → 親プロジェクト削除時に連動削除
- `originSceneId` / `originCodexId` → 親シーン/エントリ削除時に文字屑のみ連動削除（構造アイテム本体は親と独立）

### 3.1 文字屑 (`kind: "text-fragment"`) の payload

```typescript
interface TextFragmentPayload {
  text: string;
  spans: TrashSpan[];
}

interface TrashSpan {
  text: string;
  source: "human" | "ai" | "unknown";
  model: string | null;
  chatMessageId: string | null;
  traceId: string | null;
  timestamp: string | null;
}
```

- 削除範囲内の各テキストノードから authorship mark を位置順に抽出
- `traceId` も含めて authorship mark の属性を丸ごと取り込む（`TrashBinCapturePlugin.ts`）。mark 未付与は全属性 `null` + `source: "human"` として記録
- 再挿入時、各 span に `AuthorshipMark` を再付与（`AuthorshipMark.ts` の全属性が `default: null` を持つことを確認済み）

### 3.2 構造アイテム (`kind: "structure-item"`) の payload

subKind ごとの payload インターフェイス定義は本書末尾 §16 に集約。共通点:
- 復元時に **新 ID 発行**（元 ID は再利用しない、§6 参照）
- 元 Scene/Codex への外部参照（Pin の anchor、Foreshadow の sceneRef 等）は復元しない

### 3.3 Interestingness 判定

`src/features/trash-bin/interestingness.ts`:

文字屑:
1. spans に `source === "ai"` が 1 つでもあれば true
2. previewText が 5 文字以上 → true
3. 文学的記号（`——` `…` `!` `?` `「」` `『』`）を含む → true

構造アイテム:
- subKind = `"map-sticky"` で本文 5 文字以上 → true
- subKind = `"scene"` / `"codex-entry"` / `"snippet"` で previewText が 50 文字以上 → true
- subKind = `"foreshadow"` は常に true（伏線は本質的に重要）
- それ以外 → false

光る演出は §7 と §8 で subKind 別に色分け。

### 3.4 保持・容量ポリシー

| 種別 | 保持期間 | 件数上限（DB） | 物理表示上限 |
|---|---|---|---|
| 文字屑 | 60 日 | 10,000 件（セーフティバルブ） | 50 件 |
| 構造アイテム | 60 日 | 500 件（容量保護） | 50 件 |

理由:
- 文字屑は ~2KB/件、10,000 件で ~20MB
- 構造アイテムは Scene 1 件で 50KB+ 容易、500 件で ~25MB が上限目安
- DB 上限を超えたら古い順に prune（warning ログ出力）

物理表示は文字屑 50 件 + 構造アイテム 50 件 = 合計最大 100 body。それ以前は DB のみ残り、リスト fallback ビューで閲覧可。

**Prune タイミング**:
- アプリ起動時
- 1 時間おきのバックグラウンド（フォアグラウンド時のみ）
- `addItem` 時にセーフティバルブのみ即時チェック

### 3.5 プライバシー / オプトアウト

- **デフォルト ON**（全プロジェクトで記録開始）
- プロジェクト設定（`projectSettings` テーブル + `ProjectCategory.tsx`）に「ゴミ箱を有効化」トグル（key: `trashBin.enabled`）
- **現状の実装**: 保持期間の選択肢 UI（key: `trashBin.retentionDays`）も `ProjectCategory.tsx` に実装済み（無期限 sentinel = `-1` を含む）。`TrashBinPanel.tsx` がこの値を読んで `pruneTrashItems` に渡す
- **一時停止**: パネルの ● 記録インジケータから即座にトグル可
- **エクスポート時**: `ExportSettings.includeTrashBin: boolean`（デフォルト `false`）。`ExportDialog.tsx` にチェックボックス追加済み

### 3.6 Drizzle / Rust マイグレーション

- `src/db/schema.ts` に `trashItems` を追加。`payload` / `previewMeta` / `spans` 系の JSON は素の `text()` で持ち、アプリ層で `JSON.parse` / `JSON.stringify`（本リポは `mode: "json"` の前例なし、例: `aiReasoning`）
- `src-tauri/crates/grimodex-db/src/migrate.rs` に `CREATE TABLE IF NOT EXISTS trash_items ...` と上記インデックスを追加

---

## 4. キャプチャ経路

### 4-A. 文字屑経路（TipTap プラグイン）

`src/features/editor/TrashBinCapturePlugin.ts` に配置。`AiEditedPlugin` と同様に `appendTransaction` を用いるが、トランザクションは変更しない（`return null` 固定）。

#### 基本フロー

1. `transactions` を走査し、各 step が `ReplaceStep` か判定
2. `from !== to` の削除範囲について:
   - `tr.getMeta("programmaticDelete")` または `tr.getMeta("trashBin.skip")` があればスキップ
   - 挿入 step（`from === to`）は対象外
3. `oldState.doc.nodesBetween(from, to)` で走査し、各テキストノードから `authorship` mark を抽出して `TrashSpan[]` を構築
4. 即時書き込みはせず、後述のバッファに蓄積

メタ名空間は `trashBin.*` 系（origin / skip / paused）で統一。汎用な「プログラム由来削除」は既存 `programmaticInsert` と対称化した `programmaticDelete` を使う。

#### Backspace 連打バッファ

- バッファ: `{ fragments: TrashFragment[]; timerId: number | null; sceneId: string }`
- 新しい削除が来るたび:
  1. 前回から 500ms 以内かつ位置が隣接（前回 from ± 1）なら既存バッファに合体（Backspace は prepend、Delete は append）
  2. 非隣接 or 500ms 超 → 既存バッファをフラッシュして新バッファ開始
  3. タイマーリセット: 500ms 後にフラッシュ
- フラッシュ: 合体テキストが 2 文字以上なら `trashBinStore.getState().addItem()` に渡す
- 2 文字未満（1 文字タイポ即訂正など）はノイズとして破棄

#### 出自 (origin) の受け渡し

Codex / Scene / Snippet は同じ `EditorPane.tsx` の `useEditor()` インスタンスを共有する。`CodexContentEditor` は詳細ペインのミニエディタとして副次的に存在する。

- **EditorPane (主経路)**: タブ切替時の `useEffect` で `contentType` に応じて分岐
  - `"scene"` → `tr.setMeta("trashBin.origin", { kind: "scene", id: sceneId })`
  - `"codex"` → `tr.setMeta("trashBin.origin", { kind: "codex", id: codexEntryId })`
  - `"snippet"` → `tr.setMeta("trashBin.origin", null)`（前タブの origin 残留を防止）
- **CodexContentEditor (副次経路)**: `entryId` 変化時に `trashBin.origin` を dispatch

プラグイン側は plugin state として最新 `origin` を保持。`origin === null` のエディタ（Snippet・メタデータ入力等）ではキャプチャを skip。

#### プラグイン登録

静的 `extensions.ts` ではなく、`useAttribution.ts` 流の **`useTrashBinCapture(editor, origin)` フック + `editor.registerPlugin` 冪等パターン** で登録。

- 新規ファイル: `src/features/editor/useTrashBinCapture.ts`
- `EditorPane.tsx` の `useEditor()` 後で `useTrashBinCapture(editor, origin)` を呼ぶ
- `CodexContentEditor.tsx` でも同フックを呼ぶ
- フック内で plugin key を保持し再登録しない、unmount cleanup も担う

#### Codex プレビューモードの除外

`CodexContentEditor` の `externalContent` prop によるフェーズプレビュー（読み取り専用）中は大量の `ReplaceStep` が発火する。

- `isApplyingExternalUpdate.current === true` または `externalContent != null` の間は `tr.setMeta("trashBin.paused", true)` を dispatch
- プラグイン state が pause 中はキャプチャを完全 skip
- Scene 側の pause は当面不要（観測されたら追加）

#### 置換・IME

- `ReplaceStep` で `from !== to` かつ `slice.size > 0` は置換 → **キャプチャ対象外**（純粋な削除のみ）
- `view.composing === true` の間はキャプチャ保留
- IME 確定の `from !== to, slice.size > 0` は置換ルールで自動的に対象外

#### Undo との協調（時間窓ベース）

- Backspace バッファのフラッシュ時、即座に DB 書き込みせず `trashBinStore` 内の保留キューに置く
- 1500ms 内に同一エディタで undo トランザクション（`tr.getMeta("history$")`）が来たら該当アイテムを破棄
- 1500ms 経過 or 別の削除が飛んできたら DB 書き込み + UI 表示へ昇格

定数 `UNDO_ABSORB_WINDOW_MS = 1500` は β で調整可能。

### 4-B. 構造アイテム経路（store フック）

**現状の実装**: 各 feature の delete 経路で `src/features/trash-bin/captureHooks.ts` の `capture*Deletion` ヘルパを直接呼ぶ。ヘルパは内部で `useTrashBinStore.getState().enqueuePending(data, { tempId })` を呼ぶ。`tempId` は呼び出し側が生成し、Global Undo の undo callback 内で `cancelPending({ tempId })` を呼ぶことで 1500ms 以内 Ctrl+Z を吸収する（text-fragment と構造アイテムで undo 協調パスを統一）。

```typescript
// 実装例: treeStore.ts (Scene 削除経路)
captureSceneDeletion({
  projectId,
  node,
  content,
  beats,
  folderHintName,
  tempId,
});
```

ヘルパ側は「無題かつ本文が空」のキャプチャを `allBlank` で弾く（デフォルト名の Scene/Snippet がノイズとして大量に積まれないため）。

#### 対象 store と subKind マッピング

| 削除元（実装） | subKind | キャプチャ条件 |
|---|---|---|
| `treeStore.deleteNode`（nodeType=`scene`）→ `captureSceneDeletion` | `scene` | 本文が空でない |
| `codexStore.deleteEntry` → `captureCodexDeletion` | `codex-entry` | summary+本文のいずれかが空でない |
| `snippetStore.deleteSnippet` → `captureSnippetDeletion` | `snippet` | 本文が空でない |
| `MapCanvas` の sticky 削除 → `captureMapStickyDeletion` | `map-sticky` | 本文 or previewText が空でない |
| `foreshadowStore.remove` → `captureForeshadowDeletion` | `foreshadow` | intent+notes のいずれかが空でない |
| `treeStore.deleteNode`（nodeType=`folder`）→ `captureGridChapterDeletion` | `grid-chapter` | **ヘルパ／restorer／dispatch（`scenes-panel`）は実装済みだが、treeStore からの呼び出しが未配線**（※ Folder 削除は現状 trash に積まれない） |
| `pinStore.deletePin` → `capturePinDeletion` | `pin` | ※ 現状未実装（将来拡張） |

> **将来拡張 / 設計書との差分**: 元設計は「`sceneStore.deleteScene` で呼ぶ」想定だったが、現状の Grimodex は Scene/Grid chapter を `treeStore`（treeNodes テーブル）で一元管理しているため、Scene/Grid 両方の trash キャプチャは `treeStore.deleteNode` に集約されている。Map sticky のキャプチャは `mapStore` ではなく `MapCanvas.tsx` の削除ハンドラで呼ばれる（座標を `MapNodePosition` から渡すため、UI 層が起点になっている）。

#### 4-C. Grid ↔ Scene 表裏処理

Grid カード（`GridSceneCard`）のほとんどは Scene の表示上の表現に過ぎない。**同一 Scene の削除は trash に 1 件のみ入れる**。

- **現状の実装**: Scene / Grid chapter (= folder) はいずれも treeNodes 上のノードで、`treeStore.deleteNode` 内で `nodeType` を見て `captureSceneDeletion`（scene）か `captureGridChapterDeletion`（folder）に分岐する。一つの削除で一方しか呼ばれないため二重キャプチャは構造的に発生しない。
- 設計書段階で想定していた `gridStore.deleteChapter` は存在せず、Grid 側に独立した削除経路は無い。

#### Map のノード種別

`mapStore.deleteNode` は Sticky 以外（人物ノード・場所ノード等、Codex エントリ参照）も扱う。**Sticky のみ trash 対象**にする理由:
- 非 Sticky ノードは Codex エントリへのポインタ。削除しても Codex 本体は残るので「削除物」感が薄い
- Sticky は Map に閉じた独自テキストデータで、削除すると本当に失われる → 救済価値が高い

非 Sticky ノードの「削除」は今後 Global Undo 統合で十分（MEMORY: Map と Foreshadow は次 PR で Global Undo 統合予定）。

---

## 5. D&D 操作モデル

### 5-A. ドラッグ開始

- ゴミ箱内 body は draggable
- `pointerdown` から **5px 移動した時点でドラッグ開始**（クリック=Popover 開く、ドラッグ=拾い上げ、の排他）
- ドラッグ開始時に該当 body を物理から離脱（`detached = true`、重力・衝突対象外、マウス追従）
- ドラッグ終了でドロップが成立しなければ元位置に戻り `settled = false` で再落下

### 5-B. Drop Target Registry

共有 store `src/store/dropTargetRegistry.ts`:

```typescript
type DropTargetKind =
  | "scene-editor" | "codex-editor" | "snippet-editor"
  | "scenes-panel" | "codex-panel" | "map-panel"
  | "snippets-panel" | "foreshadow-panel"; // ※ "pin-panel" は現状未実装

interface DropTarget {
  id: string;                                  // 通常 kind と同値
  kind: DropTargetKind;
  rect: () => DOMRect | null;                  // null 可、動的取得（スクロール追従）
  accepts: (subKind: TrashSubKind) => boolean; // subKind 単位で判定
  onDrop: (item: TrashItemData, point: DropPoint) => Promise<void>;
  /** primary/secondary group ずれ対応で「ドロップされたペインのエディタ」を返す。
   *  pickupHandlers は target.getEditor を優先、無ければ focusedContentEditorStore に fallback。 */
  getEditor?: () => Editor | null;
}

interface DropTargetRegistry {
  targets: Map<string, DropTarget>;
  register(target: DropTarget): () => void;
  hitTest(clientPoint: DropPoint): DropTarget | null;
  /** キーボード代替用: ある subKind を受け入れる target を列挙 */
  findAccepting(subKind: TrashSubKind): DropTarget[];
}
```

実際のドロップ処理は `src/features/trash-bin/pickupHandlers.ts` の `dispatchDrop` / `pickupAndDispatch` / `acceptsMatrix` に集約され、§5-C のマトリクスを一箇所で表現する（個々の panel onDrop からこれを呼び、`useTrashBinStore.pickup(itemId, onRestore)` に流す）。パネル側は `src/features/trash-bin/useDropTarget.ts` の `useDropTarget(kind, options)` フックで簡潔に register/unregister できる。

- 各パネルが mount 時に `register` し、cleanup で unregister
- ドラッグ中は `hitTest` で現在のマウス位置からドロップ先を判定し、該当パネルをハイライト
- DockView の floating panel への cross-panel drag は **第一弾では対応外**（必要なら body の `position: fixed` で document root に移して対処、Phase 7 検討）

### 5-C. ドロップ先 × アイテム種別マトリクス

| ドロップ先 → / アイテム ↓ | エディタ本文（Scene/Codex/Snippet） | Scenes パネル | Codex パネル | Snippets パネル | Map ペイン | Foreshadow パネル |
|---|---|---|---|---|---|---|
| **text-fragment** | カーソル/ドロップ位置に挿入（authorship 復元） | ❌ | ❌ | ❌ | ❌ | ❌ |
| **scene** | タイトル + 本文をテキスト化して挿入 | Scene 復元（フォルダはドロップ先 or ルート） | ❌ | ❌ | ❌ | ❌ |
| **codex-entry** | 名前 + 本文をテキスト化して挿入 | ❌ | Codex 復元 | ❌ | ❌ | ❌ |
| **snippet** | 本文を挿入（authorship 保持） | ❌ | ❌ | Snippet 復元 | ❌ | ❌ |
| **map-sticky** | テキストとして挿入 | ❌ | ❌ | ❌ | Sticky 復元（ドロップ点 x,y） | ❌ |
| **foreshadow** | setup 文をテキスト化して挿入 | ❌ | ❌ | ❌ | ❌ | Foreshadow 復元 |
| **grid-chapter** | タイトルをテキスト化して挿入 | Grid chapter 復元（folder ノード） | ❌ | ❌ | ❌ | ❌ |

- ❌ ドロップは「拒否」、視覚的にカーソル変化なし＋ハプティック振動的な軽いフィードバック
- **現状の実装**: text-fragment → Snippet/Sticky 化の cross-kind 変換は **採用していない**（`pickupHandlers.ts` のコメント: 文脈の切れた孤児 snippet/sticky を勝手に作ると元の出所が辿れなくなるため）。text-fragment はエディタへの挿入専用、または Popover からのクリップボードコピーで取り出す。
- Pin の trash 連携が未実装のため Pin パネル列は表から除去している。実装時に再追加する。

### 5-D. キーボード代替アクセシビリティ

D&D に代わる経路として:
- パネルフォーカス時、`Tab` で各 body をフォーカス可能
- `Enter` で Popover を開く
- Popover 内に **「どこに復元？」セレクタ**（accepts を満たす drop target を列挙）+ 「拾い上げる」ボタン
- 物理配置時は DOM 順が視覚順と一致しないため `aria-describedby` で「ゴミ箱内 {N} 番目の {subKind}」を付与
- 物理無効時（reduced-motion）はリスト順で navigable

---

## 6. 復元ポリシー

### 6-A. ID

- **新 ID 発行**（元 ID は再利用しない）
- 理由: 元 ID を再利用すると、削除→他箇所での参照解除→復元、の間に同 ID で別オブジェクトが作られていた場合に衝突する
- 元 ID は payload に保持（参考情報、ユーザー UI 上は表示のみ）

### 6-B. 外部参照

- 元 Scene/Codex への参照（Pin の anchor、Foreshadow の sceneRef、Map ノードの codexRef 等）は **復元しない**
- 復元アイテムには「リンク切れ」状態を視覚化するインジケータ（例: ⚠️ アイコン）を表示
- ユーザーが手動で再リンクする UI（既存の各 feature の編集 UI）に誘導

### 6-C. 親コンテナ

- 元フォルダ・元 chapter 等の親が消えていれば **ルートに置く**
- payload の `payload.folderHintId` は参考のみ。存在しなければ無視

### 6-D. CASCADE 削除との関係

trash 内アイテムは独立コピー。元の Scene/Codex が trash に入った後にプロジェクトから完全削除されても、trash アイテムは生き残る（payload に全データを保持しているため）。文字屑のみ `originSceneId`/`originCodexId` の CASCADE で連動削除する（origin が無い文字屑は origin バッジが表示しようがないため）。

---

## 7. 物理シミュレーション

> **実装メモ（2026-06-20 追記）**: 物理エンジンは自前の AABB ソルバではなく
> **Matter.js バックエンド**で実装済み（`physics.ts:1-8`、`import Matter from "matter-js"`）。
> `TrashPhysicsEngine` クラスが Matter.js の `Engine`/`World` を内包する stateful
> ラッパーになっており、座標は外向き API では `top-left`、内部では Matter 標準の
> `center-of-mass` を扱う。以下は実装に追従した記述（旧・自前 `stepPhysics` 関数群の
> 記述を置き換え）。

### `physics.ts`

```typescript
export interface BodyState {
  id: string;
  x: number; // top-left
  y: number; // top-left
  width: number;
  height: number;
  rotation: number; // degrees
  isSleeping: boolean;
  isStatic: boolean;
}

export interface AddBodyOpts {
  id: string;
  subKind: TrashSubKind;
  size: { width: number; height: number };
  initial: "falling" | "settled-floor";
  containerWidth?: number;
  rng?: () => number; // seed 可能 PRNG（テスト用）
  x?: number;
  y?: number;
}

export class TrashPhysicsEngine {
  // Matter.js の Engine/World を内包する stateful ラッパー。
  // 座標は外向き API では top-left、内部では Matter 標準の center-of-mass を扱う。
}
```

### 公開 API メソッド

- `constructor()` — Matter.js Engine と World を初期化、重力 (`gravity.scale = 0.001`)・sleep 機能 (`enableSleeping`) 有効
- `setBounds(width, floorY)` — 容器サイズ設定。寸法が同じなら no-op、変わったら床と左右壁を再生成
- `addBody(opts)` — body を追加（`falling` または `settled-floor` 状態で開始）、`BodyState` を返す
- `removeBody(id)` — body を削除し、支えを失う上層 body を wake（重力で再落下させるため）
- `step(dtMs)` — 物理ステップを進める。dt は `1000/60`（≈16.67ms）でクランプ
- `shake(intensityX, intensityY, rng?)` — 全 body を wake・ランダムな上向きインパルスを与え、角速度も変更
- `beginDrag(id)` — ドラッグ開始で body を static に固定（手動位置制御）
- `dragTo(id, topLeftX, topLeftY)` — ドラッグ中の位置更新。投擲速度のため最近の位置/時刻を追跡
- `endDrag(id)` — ドラッグ終了で動的に戻し、投擲速度・角速度を反映
- `getState(id)` — body の現在状態を `BodyState`（top-left 座標）で取得
- `forEachState(callback)` — 全 body の状態をイテレーション
- `clampBodies()` — ResizeObserver から呼ぶ。動的 body を境界内へクランプ、wake な body が動けば true
- `placeFloorPreset(items, rng?)` — 起動時に既存アイテムを「床に積まれた」状態で決定論的に配置
- `hasUnsettled()` — いずれかの動的 body が起きているか判定（rAF 継続判定用）
- `hasBody(id)` — 指定 id の body が存在するか確認
- `isStatic(id)` — 指定 body が static か確認
- `ids()` — 全 body id を配列で取得
- `destroy()` — World/Engine をクリアして破棄

### 実装特性

- **Matter.js バックエンド**: 2D 剛体エンジン。AABB 衝突検出・反発・重力・sleep 機能を提供
- **Sleep 状態**: 静止した body は自動的に `isSleeping = true` になり、次の wake まで物理計算対象外
- **Density 統一**: 全 subKind で共通密度（`BODY_DENSITY = 0.001`）。重い body が軽い body に着地した瞬間の popcorn 化を避けるため、質量差はサイズで表現する（subKind 別の質量定数は持たない）
- **Drag トラッキング**: `beginDrag`/`endDrag` で body を static/dynamic に切り替え、手動位置制御に対応
- **rng パラメータ**: テスト用に seed 可能な PRNG を `addBody` / `shake` / `placeFloorPreset` に渡せる

### 物理定数

| 名前 | 値 |
|---|---|
| `STIR_IMPULSE` | 400 |
| `STIR_IMPULSE_MAX` | 1200 |
| `DRAG_THRESHOLD_PX` | 5 |
| `BODY_DENSITY` | 0.001 |
| `WALL_THICKNESS` | 200 |
| `FRICTION` | 0.4 |
| `FRICTION_AIR` | 0.01 |
| `RESTITUTION` | 0 |

テスト: `physics.test.ts` — `addBody` / `removeBody` / `step`（重力・床）/ `shake` / `beginDrag` / `dragTo` / `endDrag` / `placeFloorPreset` / `clampBodies` を単位テスト。

### Sleep 状態と静止接触

積み重なった body の永続微振動は Matter.js の sleep 機能で抑える。
- 静止した body は `isSleeping = true` になり、重力・衝突対象外（速度ゼロ固定）
- 新 body 接触や `removeBody`（支え消失）時は周囲の動的 body を wake して落下を進める
- `shake` で全 body 強制 wake

Matter.js を採用し、完全な物理シミュレーション（`TrashPhysicsEngine`）を実装済み。body の falling / settled-floor 状態管理、sleep 判定、drag 追跡、境界クランプ（`clampBodies`）により、安定したスタッキングを実現している。

### rAF ループ

`TrashBinPhysicsView.tsx` 内（パネル本体 `TrashBinPanel.tsx` ではなく物理ビュー側に配置）:
- `requestAnimationFrame` で `engine.step(dtMs)` → `forEachState(applyTransform)` を呼び回す。dt は `MAX_DT_MS = 33`（30fps 下限）でクランプ
- `IntersectionObserver` でパネル非表示 → ループ停止（**本リポ初の確立パターン**: `AsciiSplash.tsx` は停止ロジックなし、`LinearEditorView.tsx` は mount/unmount 検知のみ）
- `engine.hasUnsettled() === false` でループ終了（攪拌・ドラッグ・追加・クランプ等の起点で `startLoop()` 再起動）
- DOM 要素に `transform: translate3d(x, y, 0) rotate(deg)` で反映（React state 更新は使わず直接 DOM 操作）

rAF ↔ DOM 接続部の integration test は `TrashBinPhysicsView.test.tsx`。

### 初期ロード時の配置

`loadItems` 完了直後に最大 100 件が全部上から落下するのはドラマチックすぎる。
- 初期ロード時は各 body を **床に settled 状態で積まれた状態**から開始（`placeFloorPreset`: 決定論的レイアウト、`initial: "settled-floor"`、`isSleeping = true`、速度ゼロ）
- 以降の `addBody`（`initial: "falling"`）のみ y = -height から落下
- パネル再マウント時も同様

初期位置は `placeFloorPreset` に渡す `rng` で決定論にもでき、テスト都合で seed 可能。

### 攪拌インタラクション

#### 🌀 かき混ぜるボタン（`TrashBinStirButton.tsx`）
- ヘッダ右配置、Lucide `Tornado`
- 単発タップ: `shake` を 1 回（intensity = `STIR_IMPULSE` = 400）。方向ランダム + 上向きバイアス、各 body に乱数角速度
- 長押し: 300ms 間隔で連続インパルス、強度を 1.5 秒かけて線形に `STIR_IMPULSE_MAX`（1200）まで上げる

#### アイテム衝突の副産物
- 着地波紋: 新 body が落下して既存 body に当たると下が wake
- 攪拌後のカオス: 全 body 強制 wake で互いにぶつかる

---

## 8. 各構造アイテムの見た目

物理 body の DOM レンダリングは `TrashBinItem.tsx` 内で subKind 分岐。

### 8.1 共通

- `position: absolute`
- `transform: translate3d(x, y, 0) rotate(rotation deg)`
- `transform-origin: center`
- 影（subKind 別）
- `isInteresting === true` で `@keyframes trash-glow-{subKind}` 発光（amber / purple / red など subKind カラー）

### 8.2 subKind 別

| subKind | 構造 | スタイル |
|---|---|---|
| `text-fragment` | `<div>{text}</div>` | source 別カラー、フォント `font-mono` |
| `scene` | `<div class="scene-card-mini">` `<header>` `<body>` | ミニ GridSceneCard 風、200×80、紙白背景、薄い影 |
| `codex-entry` | アイコン + 名前 | 角丸 12px、緑系背景（Codex カラー）、160×60 |
| `snippet` | ペーパー風 | 上端に折れ表現、140×100 |
| `map-sticky` | 黄色付箋 | 角度 ±5° ランダム、120×120、ドロップシャドウ強め |
| `foreshadow` | 赤糸モチーフ | 細長い赤紐、120×40、両端にミニ結び目 |
| `pin` | ピンアイコン | 円形 40×40、Lucide `Pin`、影で立体感 |
| `grid-chapter` | 帯 | 200×40、Grid カラー（オレンジ系）、左に階層インデント風記号 |

### 8.3 リンク切れインジケータ

- 復元時に外部参照が切れる構造アイテム（pin/foreshadow など）は body 右上に小さな `⚠️` アイコン
- Popover で「リンク切れ。復元すると再リンクが必要です」と説明

### 8.4 origin バッジ（文字屑のみ）

- `📖 本文` / `📚 設定資料` のテキストラベル + 色（Scene=青系、Codex=緑系）
- 絵文字は装飾としてオプション、テキスト + 色で必ず区別可能

---

## 9. Global Undo との並走

`useGlobalHistoryStore`（Scenes / Codex / Snippets / Pins 統合済、Map / Foreshadow は次 PR 予定）と **並走**で動作。

### 9.1 役割分担

| | Global Undo | ゴミ箱 |
|---|---|---|
| 保持期間 | 短期（数操作前まで、stack 上限あり） | 60 日 |
| 操作粒度 | 任意の操作単位 | 削除イベント単位 |
| 戻し方 | `Ctrl+Z` 一発 | D&D で拾い上げ（ドロップ先選択） |
| 失われた構造アイテム本体 | stack 内のみ | DB に payload 保持 |

### 9.2 重複の扱い

削除イベントは Global Undo と trash の **両方**に同時に入る。

- **`Ctrl+Z` 1500ms 以内**: trash 側の保留キュー（§4-A の Undo 協調）が吸収して trash には残らない
  - 構造アイテム削除も同様に保留キューに入れる必要あり
  - `trashBinStore.addItem` 内部で `kind === "structure-item"` のときも保留キューを通す
- **1500ms 経過後の `Ctrl+Z`**: Global Undo は逆操作（復元）、trash には削除コピーが残ったまま
  - ユーザーは trash アイテムを「完全に削除」して整理 or 拾い直しで使う
  - 同一 ID のアイテムが復元と trash に並存する状態は容認（ID は新規発行されるので衝突しない）

### 9.3 Map / Foreshadow が Global Undo 未統合の間

- 現状は trash のみが復元手段
- Global Undo 統合後（次 PR）は他と同じ並走モードに自動移行
- 設計書としてはどちらの状態でも矛盾なく動作することを保証

### 9.4 trash 自身の操作は Global Undo 非統合

- `removeItem`（個別の完全削除）/ `clearAll` / 拾い上げ（D&D）は Global Undo に乗せない
- 理由: 拾い上げは「本文側の挿入」+「trash 側の削除」の二段で、本文側の Undo と二重発火する
- 代わりに `removeItem` / `clearAll` には**確認モーダル**を必須化
  - 「この屑を完全に削除します。取り消せません。」
  - Clear All は v2 同様の文言

---

## 10. アクセシビリティ / Reduced Motion

`src/lib/animation.ts` の `useReducedMotion` に従う。

### `prefers-reduced-motion: reduce` 時

- 物理シミュレーションは停止、rAF 起動しない
- 表示は **リスト fallback**（subKind ごとにグループ化）
- 「かき混ぜる」ボタンは残す。押下で `items` 配列を Fisher-Yates シャッフル + `DURATIONS.fast` でフェード。「偶然の再発見」の意図は保たれる
- D&D の代わりに各アイテムに「拾い上げる」ボタン → 復元先セレクタ（§5-D）

### キーボード操作

- `Tab` で body フォーカス、`Enter` で Popover
- Popover に復元先セレクタ + 「拾い上げる」「完全に削除」アクション
- 物理配置時は `aria-describedby` で「ゴミ箱内 {N} 番目の {subKind}」

---

## 11. `trashBinStore`（Zustand）

実装は `src/features/trash-bin/trashBinStore.ts` / 型は `types.ts`。

```typescript
interface TrashBinStore {
  items: Map<string, TrashItemData>;
  selectedItemId: string | null;
  isCapturing: boolean;
  isLoading: boolean;
  pendingQueue: PendingTrashItem[];

  loadItems(projectId: string): Promise<void>;
  /** 1500ms 以内に cancelPending が来なければ DB に書き込む保留キュー投入。
   *  text-fragment / 構造アイテムどちらも同じ経路を通る。 */
  enqueuePending(data: TrashItemInput, options: { tempId: string }): void;
  /** Undo 1500ms 内吸収。tempId / originSceneId / originCodexId のいずれかで filter。 */
  cancelPending(filter: {
    tempId?: string;
    originSceneId?: string | null;
    originCodexId?: string | null;
  }): void;
  removeItem(id: string): Promise<void>;
  clearAll(projectId: string): Promise<void>;
  setSelectedItem(id: string | null): void;
  setCapturing(value: boolean): void;
  /** 拾い上げ。restorer 呼び出しは onRestore に委譲し、成功時のみ trash から item を削除する。 */
  pickup(itemId: string, onRestore: () => Promise<PickupResult>): Promise<PickupResult>;
}

type PickupResult =
  | { ok: true; newId: string; brokenLinks: string[] }
  | {
      ok: false;
      reason: "rejected" | "no-target" | "internal-error" | "duplicate";
      message?: string;
    };
```

> **設計書からの差分**: 元の `addItem(raw)` は **採用していない**。文字屑と構造アイテムを問わず常に `enqueuePending` → 1500ms タイマー → `flushPending` で DB 書き込みする統一フローに変更した（§4-A の undo 協調を store レイヤに引き上げ、capture プラグイン側に保留キューを置かない設計）。`pickup` も `(itemId, onRestore)` に変わり、復元先の判定（drop target × subKind）は `pickupHandlers.dispatchDrop` 側の責務になっている（§5-B 末尾参照）。

### 設計判断

- store は永続データのみ。物理状態は `TrashBinPanel` 内の `useRef<Map<string, PhysicsBody>>` で別管理
- `Map<id, ...>` で O(1) アクセス
- **Zustand selector 注意**（`feedback_zustand_selector_new_ref.md`）: `Array.from(items.values())` のような派生配列を selector 内で生成しない。コンポーネント側で `useMemo` するか selector は `Map` 参照を返す
- `addItem` 内で interestingness 判定・charCount 算出（`[...previewText].length`）を完結
- `pickup` は drop target の `accepts` を呼び、ok なら subKind ごとの restorer に委譲して store / DB から item 削除

### `focusedContentEditorStore`（共有）

```typescript
interface FocusedContentEditor {
  kind: "scene" | "codex" | "snippet";
  id: string;
}

interface FocusedContentEditorStore {
  current: FocusedContentEditor | null;
  setCurrent(target: FocusedContentEditor | null): void;
}
```

- 場所: `src/store/focusedContentEditorStore.ts`
- D&D ドロップ先がエディタ本文だった場合に「現在カーソルがある側」を解決するために使う
- 既存 `editorStore.editor` は primary group の Scene 1 個のみ保持（Codex 越境不可）。本 store はその制約を解消
- 将来的に foreshadow `reinsertSetup` / pin / snippet の挿入経路にも展開可能

---

## 12. i18n

`src/locales/ja.json` / `en.json` に追加:

| キー                          | ja                          | en                              |
|------------------------------|-----------------------------|--------------------------------|
| `layout.panel.trash-bin`     | ゴミ箱                       | Trash Bin                       |
| `trashBin.title`             | ゴミ箱                       | Trash Bin                       |
| `trashBin.empty`             | ゴミ箱は空です                | Nothing discarded yet           |
| `trashBin.count`             | {{count}} 件                | {{count}} items                 |
| `trashBin.stir`              | かき混ぜる                   | Stir                            |
| `trashBin.clearAll`          | 全削除                       | Clear all                       |
| `trashBin.clearConfirm`      | ゴミ箱の中身をすべて完全に削除します。取り消せません。 | Permanently delete all items? This cannot be undone. |
| `trashBin.removeConfirm`     | この屑を完全に削除します。取り消せません。 | Permanently delete this item?   |
| `trashBin.pickup`            | 拾い上げる                   | Pick up                         |
| `trashBin.discard`           | 完全に削除                   | Delete permanently              |
| `trashBin.recording`         | 記録中                      | Recording                       |
| `trashBin.paused`            | 記録停止中                  | Paused                          |
| `trashBin.pauseToggle`       | 記録を一時停止/再開          | Pause / resume recording        |
| `trashBin.enableLabel`       | ゴミ箱を有効化               | Enable trash bin                |
| `trashBin.includeInExport`   | ゴミ箱の内容を含める         | Include trash bin contents      |
| `trashBin.brokenLinkWarning` | 復元しましたが一部のリンクが切れています | Restored, but some links are broken |
| `trashBin.kind.textFragment` | 文字屑                      | Text scrap                      |
| `trashBin.kind.scene`        | シーン                      | Scene                           |
| `trashBin.kind.codex`        | 設定資料                    | Codex                           |
| `trashBin.kind.snippet`      | スニペット                   | Snippet                         |
| `trashBin.kind.mapSticky`    | 付箋                        | Sticky                          |
| `trashBin.kind.foreshadow`   | 伏線                        | Foreshadow                      |
| `trashBin.kind.pin`          | ピン                        | Pin                             |
| `trashBin.kind.gridChapter`  | 章ヘッダ                    | Chapter                         |
| `trashBin.dropTarget.editor` | エディタに挿入               | Insert into editor              |
| `trashBin.dropTarget.scenes` | シーンとして復元             | Restore as scene                |
| `trashBin.dropTarget.codex`  | 設定資料として復元           | Restore as Codex entry          |
| `trashBin.dropTarget.snippets` | スニペットとして復元        | Restore as snippet              |
| `trashBin.dropTarget.map`    | 付箋として復元               | Restore as sticky               |

---

## 13. パネル登録（4 箇所）

### `src/features/layout/layoutStore.ts`
- `PanelId` union に `"trash-bin"` 追加
- `PANEL_INSERT_REGISTRY` に追加
- `addPanelWithDefaults` に case 追加（center-bottom）

### `src/features/layout/panelRegions.ts`
- `PANEL_REGION_MAP`: `"trash-bin": "center-bottom"`
- `KEYBOARD_SHORTCUT_MAP`: `"trash-bin": "Ctrl+Alt+B"`
- `TOGGLEABLE_PANELS` に追加

### `src/App.tsx`
- `TrashBinContent` を components map に登録

---

## 14. ファイル構成

### 新規

| ファイル | 内容 |
|---|---|
| `src/features/trash-bin/api.ts` | DB CRUD + `pruneTrashItems`（`trashItems` 一括対応） |
| `src/features/trash-bin/trashBinStore.ts` | Zustand ストア（enqueuePending + cancelPending + pickup） |
| `src/features/trash-bin/types.ts` | TrashItem 系の型・`UNDO_ABSORB_WINDOW_MS` 定数 |
| `src/features/trash-bin/TrashBinPanel.tsx` | パネル本体（header + prune + view 切替） |
| `src/features/trash-bin/TrashBinPhysicsView.tsx` | 物理ビュー（rAF ループ + drag/drop） |
| `src/features/trash-bin/TrashBinListView.tsx` | reduced-motion fallback リスト |
| `src/features/trash-bin/items/*.tsx` | 個別アイテム（subKind 別レンダリングを Scene/Codex/Snippet/MapSticky/Foreshadow/GridChapter ごとに分割） |
| `src/features/trash-bin/displayHelpers.ts` | body size 等の共通ヘルパ |
| `src/features/trash-bin/TrashBinPopover.tsx` | プレビュー Popover + 復元先セレクタ |
| `src/features/trash-bin/TrashBinStirButton.tsx` | かき混ぜるボタン |
| `src/features/trash-bin/ConfirmDialog.tsx` | clearAll/removeItem 用の確認モーダル |
| `src/features/trash-bin/physics.ts` / `physics.test.ts` | 物理エンジン |
| `src/features/trash-bin/interestingness.ts` / `interestingness.test.ts` | 光る判定 |
| `src/features/trash-bin/captureHooks.ts` | 各 feature から呼ぶ薄い API（`captureSceneDeletion` 等） |
| `src/features/trash-bin/pickupHandlers.ts` | drop target × subKind ディスパッチ（`acceptsMatrix` / `dispatchDrop` / `pickupAndDispatch`） |
| `src/features/trash-bin/editorInsert.ts` | text-fragment 等のエディタ挿入処理 |
| `src/features/trash-bin/useDropTarget.ts` | パネル側 register/unregister 用フック |
| `src/features/trash-bin/restorers/scene.ts` | Scene 復元ロジック |
| `src/features/trash-bin/restorers/codex.ts` | Codex 復元 |
| `src/features/trash-bin/restorers/snippet.ts` | Snippet 復元 |
| `src/features/trash-bin/restorers/mapSticky.ts` | Sticky 復元 |
| `src/features/trash-bin/restorers/foreshadow.ts` | Foreshadow 復元 |
| `src/features/trash-bin/restorers/gridChapter.ts` | Grid chapter 復元 |
| `src/features/trash-bin/restorers/pin.ts` | Pin 復元（※ 現状未実装） |
| `src/features/editor/TrashBinCapturePlugin.ts` / `.test.ts` | 削除キャプチャ PM プラグイン（文字屑） |
| `src/features/editor/useTrashBinCapture.ts` | プラグイン登録フック |
| `src/store/dropTargetRegistry.ts` | Drop target レジストリ |
| `src/store/focusedContentEditorStore.ts` | フォーカス中エディタ共有 store |
| `src/features/trash-bin/dragLayer.tsx` | ドラッグ中の body 描画レイヤ（※ 現状未実装、PhysicsView 内に detach 描画があるのみ） |

### 変更

| ファイル | 内容 |
|---|---|
| `src/db/schema.ts` | `trashItems` 追加（kind/subKind/payload 両系統対応） |
| `src-tauri/crates/grimodex-db/src/migrate.rs` | `CREATE TABLE IF NOT EXISTS trash_items` |
| `docs/Grimodex_統合DBスキーマ.md` | `trashItems` を追記 |
| `src/features/editor/EditorPane.tsx` | `useTrashBinCapture` 呼び出し + `trashBin.origin` meta + `focusedContentEditorStore.setCurrent` + Drop target register |
| `src/features/codex/components/CodexContentEditor.tsx` | 同上（副次経路）+ `trashBin.paused` |
| `src/features/tree/treeStore.ts` | `deleteNode` 内で nodeType=scene → `captureSceneDeletion`、nodeType=folder → `captureGridChapterDeletion`（Scene/Grid chapter 統合経路） |
| `src/features/codex/codexStore.ts` | `deleteEntry` 内で `captureCodexDeletion` 呼び出し |
| `src/features/snippets/snippetStore.ts` | `deleteSnippet` 内で `captureSnippetDeletion` 呼び出し |
| `src/features/map/MapCanvas.tsx` | sticky 削除ハンドラで `captureMapStickyDeletion` 呼び出し（座標を MapNodePosition から渡すため UI 起点） |
| `src/features/foreshadow/foreshadowStore.ts` | `remove` 内で `captureForeshadowDeletion` 呼び出し |
| `src/features/pins/pinStore.ts` | `deletePin` 内で `capturePinDeletion` 呼び出し（※ 現状未実装） |
| `src/features/tree/ScenesPanel.tsx` | Drop target register（`scenes-panel`） |
| `src/features/codex/CodexPanel.tsx` | 同上（`codex-panel`） |
| `src/features/snippets/SnippetPanel.tsx` | 同上 |
| `src/features/map/MapPanel.tsx` | 同上（`map-panel`） |
| `src/features/foreshadow/ForeshadowPanel.tsx` | 同上 |
| `src/features/pins/PinsPanel.tsx` | 同上（※ 現状未実装） |
| `src/features/layout/layoutStore.ts` | `PanelId` / `PANEL_INSERT_REGISTRY` / `addPanelWithDefaults` |
| `src/features/layout/panelRegions.ts` | region/shortcut（`Ctrl+Alt+B`）/toggle |
| `src/App.tsx` | `TrashBinContent` 登録 |
| `src/locales/ja.json` / `en.json` | 翻訳キー（subKind 別含む） |
| `src/index.css` | `@keyframes trash-glow-{subKind}` |
| `src/features/export/types.ts` | `ExportSettings.includeTrashBin: boolean` |
| `src/features/export/ExportDialog.tsx` | チェックボックス追加 |
| `src/features/settings/categories/ProjectCategory.tsx` | 「ゴミ箱を有効化」トグル |

---

## 15. フェーズ計画

### Phase 0: 方針確定（本設計書 v3）
IME、undo 協調、reduced-motion、保持ポリシー、Replace 扱い、メタ名空間（`trashBin.*`）、Global Undo 並走方針、ショートカット（`Ctrl+Alt+B`）、復元ポリシー（新 ID 発行・参照復元しない）、D&D 操作モデル、Grid×Scene 同一視を確定済み。Phase 1 着手前に確認:
- ✅ `AuthorshipMark` の null 許容（解決済み）
- `CodexContentEditor.externalContent` への `trashBin.paused` meta 経路（実装で確定）
- Snippet タブ切替時の `trashBin.origin = null` dispatch（実装で確定）

### Phase 1: DB + 文字屑キャプチャ
- 1-a: `trashItems` スキーマ（Drizzle + Rust、kind/subKind/payload 両対応設計だが Phase 1 では `kind = "text-fragment"` のみ書き込む）
- 1-b: API 層（CRUD + prune）+ `interestingness.ts`
- 1-c: `TrashBinCapturePlugin`（デバウンス合体 + IME ガード + undo 協調 + origin/skip/paused メタ）
- 1-d: `useTrashBinCapture` フック新設、EditorPane / CodexContentEditor 両方に登録、Snippet で origin null
- 1-e: `trashBinStore` + `focusedContentEditorStore` 新設

### Phase 2: パネル登録 + リスト fallback
- DockView 登録（4 箇所: `PanelId` / `PANEL_INSERT_REGISTRY` / `panelRegions` / `App.tsx`）
- i18n（ja / en、subKind 別含む）
- `TrashBinPanel` のリスト版（reduced-motion fallback としても使う）
- 全パイプラインを検証（Scene 削除 → DB → store → リスト）

### Phase 3: 物理シミュレーション + 文字屑表示
- `physics.ts`（Matter.js バックエンドの `TrashPhysicsEngine` クラス: AABB 衝突・sleep・drag 追跡・境界クランプ、`physics.test.ts`）
- rAF ループ統合（**新規パターン**: IntersectionObserver 停止）
- `TrashBinItem` の text-fragment 表現
- `ResizeObserver` / `IntersectionObserver`
- rAF ↔ DOM 接続部の integration test（jsdom + fake rAF）

### Phase 4: 構造アイテムキャプチャ（コンテンツ系）
- `captureHooks.ts` の Scene/Codex/Snippet 用 API
- `sceneStore.deleteScene` / `codexStore.deleteEntry` / `snippetStore.deleteSnippet` にフック追加
- subKind 別の `TrashBinItem` レンダリング（scene/codex-entry/snippet）
- restorers/scene.ts / codex.ts / snippet.ts

### Phase 5: 構造アイテムキャプチャ（拡張系）
- Map Sticky / Foreshadow / Pin / Grid chapter のフック追加
- subKind 別レンダリング（map-sticky/foreshadow/pin/grid-chapter）+ スキューモーフィズム
- restorers 残り 4 種
- Grid × Scene 表裏処理の検証（同一 Scene が 2 件入らないこと）

### Phase 6: D&D + 復元 + 攪拌 + 光る演出
- `dropTargetRegistry` 実装
- 各パネルに `register(target)` 追加（Scenes/Codex/Snippets/Map/Foreshadow/Pin）
- `dragLayer.tsx`（document root へ portal、cross-panel drag 対応）
- D&D 操作モデル（5px しきい値、detach、hit test、ドロップマトリクス）
- `pickup` API + restorers 統合
- リンク切れインジケータ
- `@keyframes trash-glow-{subKind}` + `TrashBinStirButton`
- reduced-motion 時のシャッフル fallback + 復元先セレクタ（D&D 代替）
- TrashBinPopover（プレビュー専用 + キーボード代替の復元先セレクタ）

### Phase 7: 仕上げ
- 容量上限（文字屑 10,000 / 構造 500）+ 60 日 prune（起動時 + 1 時間おき）+ 物理表示 50/50 件
- 500 文字 truncate
- Clear All / 個別 removeItem の確認モーダル
- プロジェクト設定「ゴミ箱を有効化」トグル
- パネル ● 記録インジケータの一時停止
- `ExportSettings.includeTrashBin` + ExportDialog
- DockView floating panel 越え D&D の検証 + 必要なら `dragLayer` 改修
- 検証: Scene/Codex/Snippet/Map/Foreshadow/Pin/Grid 全経路で正常動作

### Phase 8（将来検討）
- Pin の trash 統合（subKind `pin` / `PinPayload` / restorer / `pin-panel` drop target / `capturePinDeletion`）
- `useGlobalHistoryStore` への trash 操作統合（`pickup` を atomic に扱える設計が組めれば）
- ~~物理スタッキング本格化（matter.js 導入）~~ → **実装済み**（`physics.ts` の `TrashPhysicsEngine` が Matter.js バックエンド、§7 参照）
- ~~保持期間の設定 UI（7 / 30 / 60 / 90 / 無期限）~~ → **実装済み**（`ProjectCategory.tsx`、§3.5 参照）
- ChatInput 削除のキャプチャ（subKind = `chat-input` 拡張）
- `focusedContentEditorStore` を foreshadow / pin / snippet の挿入経路にも展開
- DockView floating panel 越え D&D が現状壁になる場合の代替策
- `dragLayer.tsx` の document root portal 化（現状は PhysicsView 内で完結）

---

## 16. subKind 別 payload 表

### 16.1 `text-fragment`

```typescript
type TextFragmentPayload = {
  text: string;
  spans: TrashSpan[];
};
```

復元: `pickup` が drop target に応じて
- エディタ本文 → spans を順に挿入し authorship mark 再付与
- Map ペイン → 新規 Sticky ノード作成、`text` を本文に
- Snippets パネル → 新規 Snippet 作成、`text` を本文に

### 16.2 `scene`

```typescript
type ScenePayload = {
  originalId: string;          // 参照のみ
  title: string;
  body: string;                // ProseMirror JSON シリアライズ
  beats: string;               // unplacedBeatsDoc (JSON 配列) を生のまま保持
  povCharacterId: string | null;
  folderHintId: string | null;
  folderHintName: string | null;
  metadata: {
    synopsis: string | null;
    status: string | null;
    nodeType: "scene" | "folder" | "note";
    locationId: string | null;
    sortOrder: string;
    storyTimeOrder: string | null;
    storyTimeLabel: string | null;
  };
  charCount: number;
};
```

### 16.3 `codex-entry`

```typescript
type CodexEntryPayload = {
  originalId: string;
  name: string;
  category: string;            // schema 上の type カラム（Codex 種別 slug）
  body: string;                // ProseMirror JSON
  summary: string | null;
  aliases: string | null;          // schema は JSON 文字列で保持
  excludedAliases: string | null;
  icon: string | null;
  notes: string | null;
  contextMode: string;
  childrenBudget: string;
  parentId: string | null;
  // fields/links/imageRefs は現 schema に存在しないため Phase 4 では取り扱わず、
  // 設計書互換のため常に空配列で存在させる。
  fields: never[];
  links: never[];
  imageRefs: never[];
};
```

### 16.4 `snippet`

```typescript
type SnippetPayload = {
  originalId: string;
  title: string;
  body: string;                // ProseMirror JSON（authorship 含む）
  tags: string | null;         // schema の tagsCache (JSON 文字列) を生で保持
  contentSource: string | null;
  sceneId: string | null;
};
```

### 16.5 `map-sticky`

```typescript
type MapStickyPayload = {
  originalId: string;
  boardId: string;             // 参考のみ
  title: string | null;
  body: string;                // ProseMirror JSON 本文
  previewText: string | null;
  paletteId: string;           // 色は paletteId + colorSlot の組で表現
  colorSlot: number;
  x: number;                   // ドロップ時の位置参考、強制復帰しない
  y: number;
  pinned: boolean;
  zIndex: number;
};
```

> 実 schema は `mapStickies`（`body` PM JSON + `previewText` + `paletteId`/`colorSlot`）と
> 座標を持つ `mapNodePositions` 別テーブルに分かれている。`x`/`y`/`pinned`/`zIndex`
> は position 行から取り込む（`captureMapStickyDeletion` が `MapNodePosition` を別引数で受け取る）。

### 16.6 `foreshadow`

```typescript
type ForeshadowPayload = {
  originalId: string;
  projectId: string;
  title: string;
  intent: string | null;
  notes: string | null;
  payoffSceneRef: string | null;  // 参考のみ
  payoffFromPos: number | null;
  payoffToPos: number | null;
  payoffConfirmed: boolean;
  abandoned: boolean;
  loadBearing: string | null;
};
```

> `foreshadowSetups` は親削除で CASCADE 消滅するため、本 payload は親 row のみ保持し
> setups は復元しない（`foreshadowStore.remove` と同方針。復元時は `brokenLinks` に
> `"setups"` を積む）。

### 16.7 `pin` (※ 現状未実装)

```typescript
type PinPayload = {
  originalId: string;
  label: string;
  anchorText: string | null;
  anchorSceneRef: string | null;  // 参考のみ
  color: string;
};
```

Pin の trash 連携は将来拡張。subKind / restorer / drop target / capture hook いずれも未実装。

### 16.8 `grid-chapter`

```typescript
type GridChapterPayload = {
  originalId: string;
  title: string;
  parentId: string | null;     // 親フォルダ（消えていればルート復元、§6-C）
  sortOrder: string;           // treeNodes の sortOrder（fractional index 文字列）
  metadata: Record<string, unknown>;
};
```

---

## 17. 検証方法

1. `pnpm electron:dev` で起動
2. **文字屑系**:
   - シーンでテキスト選択 → 削除 → ゴミ箱に文字片が落下
   - Backspace 連打 → 1 つに合体されてから落下
   - IME で日本語入力中の変換 → キャプチャされない
   - 削除直後に Ctrl+Z → 対応する文字片が消える
   - 光るアイテムをドラッグ → エディタにドロップ → authorship 完全復元
3. **構造アイテム系**:
   - Scene 削除 → ゴミ箱に Scene カードが落下、本文プレビュー見える
   - Codex エントリ削除 → 角丸ボックスとして落下
   - Map で Sticky 削除 → 黄色付箋がスキューモーフィズム維持で落下
   - Foreshadow / Pin / Snippet / Grid chapter も同様
   - Sticky をドラッグ → Map ペインにドロップ → ドロップ位置で復活
   - Scene カードをドラッグ → Scenes パネルにドロップ → ルート（or ドロップ先フォルダ）に復活
   - Scene カードをドラッグ → エディタにドロップ → タイトル+本文がテキスト化されて挿入
   - 構造アイテムを「拒否」される drop target にドロップ → 戻る
4. **Grid × Scene 表裏**: GridSceneCard を削除 → trash に scene として 1 件のみ（grid-chapter としては入らない）
5. **攪拌**: 「かき混ぜる」ボタン単発 → bodies が跳ねる。長押し → 連続攪拌
6. **物理スタッキング**: 100 件まで積む → settle 後に微振動しないこと
7. **保持**: アプリ再起動 → 全アイテム復元
8. **`prefers-reduced-motion: reduce`**: リスト fallback、復元先セレクタ、シャッフル
9. **テスト**: `pnpm test` / `npx tsc --noEmit` / `cargo test`

---

## 18. 運用中に調整予定の項目

設計として確定しているが、β 利用中の体感で調整する可能性がある項目。

### T-1: `isInteresting` 閾値
- 文字屑/構造アイテムの光る条件。光りすぎ/光らなすぎで閾値調整。

### T-2: Backspace 合体デバウンス
- 現状 500ms / 隣接位置 ± 1。タイピングテンポで調整。

### T-3: 保持期間 60 日
- 設定 UI で選択肢化（Phase 8 検討）

### T-4: 容量上限
- 文字屑 10,000 / 構造 500。プロジェクト規模で見直し。

### T-5: D&D の 5px しきい値
- 細かい body をクリック選択するときの誤発火と相談。

### T-6: 物理質量
- subKind 別の質量比。重量感が薄い/重すぎを β で調整。
