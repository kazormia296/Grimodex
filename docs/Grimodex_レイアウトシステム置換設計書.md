# Grimodex レイアウトシステム置換設計書

> 本書は Dockview ベースの現行レイアウト (`Grimodex_レイアウトシステム設計書.md`) を
> 自作 region システムへ全面置換するための設計書である。置換完了後、現行設計書は
> 本書に置き換えられる。

## 1. 背景と目的

### 1.1 現状の問題

現行レイアウトは Dockview (VS Code 式の対称ドッキングライブラリ) の上に IntelliJ 式
ツールウィンドウ stripe を被せている。この **モデルの不一致** が構造的な摩擦を生んでいる:

- Dockview の中核は対称な gridview ツリー (branch = 行/列、leaf = group の入れ子) で、
  「固定中央 (エディタ)」「名前付き region (左/右/下)」という概念を持たない。
- そのため region を **矩形の幾何計算** (`detectRegionFromRects`) で推測し、stripe の
  segment を **band クラスタリング** で再構成し、タブヘッダを**非表示ハック**で消し、
  エディタ位置を**相対参照**で扱う — すべて「Dockview のモデルを我々のモデルに翻訳する
  reconciliation 層」である。
- 決定的な症状: エディタは任意パネル扱いのため「中央に開く」保証がなく、不在の
  レイアウトに再オープンするとフォールバックで右端に固定される。

**現行の DOM 構造（置換で変わる点）:**

現行 `ToolWindowShell` は CSS Grid で **stripe だけ**を左右下セルに置き、中央 `content`
セルに **Dockview 一式**（左パネル・エディタ・右パネル・下パネルすべて）を載せている。
stripe はナビゲーション専用で、ツールウィンドウの**中身**は依然として Dockview 内にある。

本置換では、ツールウィンドウの**中身**を各 region セル (`RegionContent` / `SlotView`) に
移し、中央セルは **エディタ専用** (`EditorArea` → `SceneEditor`) とする。これは stripe の
差し替え以上の **グリッド構造の変更**であり、見積もり・テスト範囲に含めること。

### 1.2 目的

IntelliJ 式の **非対称レイアウト** (中央のエディタ領域は固定、ツールウィンドウは
左/右/下の region に dock) を、専用のデータモデルで素直に実装する。reconciliation 層を
全廃し、レイアウト要件の追加が「Dockview との戦い」にならない基盤にする。

### 1.3 現行 hybrid からの UX 変更（意図的）

| 項目 | 現行 | 本設計 |
|------|------|--------|
| stripe に出るアイコン | 一度でも開いた panel (`stripePanelIds`) | **全 15 tool window を常時表示** |
| パネル内の裏 tab | Dockview の background 状態 | **なし** (1 slot = 1 表示) |
| 「サイドバーから削除」 | stripe 登録を外す | **廃止**（§13 参照。全 panel 事前登録のため） |
| カスタムレイアウト保存 | `SerializedDockview` JSON | `LayoutState` スナップショット |

## 2. 設計方針

1. **エディタ = center band 内の固定 segment**。移動不可。`editorOpen` で列全体の表示/非表示を
   切替。開いている間は常に center 内の所定位置。
2. **すべて明示的データ**。region / slot / panel の所属は state に明示的に持つ。幾何計算で
   推測しない。divider 位置は slot 境界そのもの。
3. **IntelliJ 非対称モデル**。3 つの region、各 region は主軸方向に N 個の slot に分割。
   各 slot は 1 枚の tool window を表示。stripe アイコンが切替を担う。
4. **エディタは自前管理**。`EditorArea` に `SceneEditor` を 1 つ置く。`SceneEditor` は
   `tabStore` / `TabBar` / `splitDirection` で章/シーンの tab・分割を完全に自前管理して
   いるため、レイアウトシステムは中央の矩形を与えるだけでよい。
5. **floating / pin は後付け**。undock 用の overlay 層はスコープ外。`LayoutState` に
   `viewMode` 等を混ぜない（§13）。

## 3. 全体構造

```
┌──────────────────────────────────────────────────────────────┐
│ Header                                                        │
├──┬────────────────────────────────────────────────────┬──────┤
│  │───────────────── Center Stripe ────────────────────│      │
│L ├───────────┬────────────────────────────┬───────────┤ R    │
│  │ L Content │                            │ R Content │      │
│S │ ┌───────┐ │                            │ ┌───────┐ │ S    │
│T │ │ slot0 │ │       Editor Area          │ │ slot0 │ │ T    │
│R │ ├───────┤ │   (<SceneEditor/> を置く)   │ └───────┘ │ R    │
│I │ │ slot1 │ │                            │           │ I    │
│P │ └───────┘ │                            │           │ P    │
│E ├───────────┴────────────────────────────┴───────────┤ E    │
│  │ B Content                                          │      │
│  │ ┌──────────┬──────────┐                            │      │
│  │ │  slot0   │  slot1   │                            │      │
│  │ └──────────┴──────────┘                            │      │
│  ├────────────────── Bottom Stripe ───────────────────┤      │
└──┴────────────────────────────────────────────────────┴──────┘
```

CSS グリッド (`LayoutShell`):

```css
grid-template-columns: ${leftCell}px 1fr ${rightCell}px;
grid-template-rows: ${STRIPE_SIZE}px 1fr ${bottomCell}px;
grid-template-areas:
  "left cstripe right"
  "left content right"
  "left bottom  right";
```

- 左/右 region のセルは 3 行を span (常に全高)。
- 中央領域の最上段 = **Center Stripe**（固定 `STRIPE_SIZE`、**常時表示**。bottom 帯と
  上下対称の水平帯で、左右 region content の上にも被さる。詳細は §4「Center Workspace」）。
- 各 region グリッドセル = `RegionDock` = stripe (固定 32px) + content (`region.size`px、
  全 slot 折りたたみ時は content 0、stripe は 32px のまま)。
- `content` グリッドセル = エディタ領域 (`EditorArea`)。`editorOpen` で開閉し、閉じて
  center tool も無いときは幅 0 になり、side region が `1fr` filler で埋める（§6.5）。
- 現行 `ToolWindowShell` の `hidden` prop（screenshot モードで stripe を外す）は
  `LayoutShell` に同等の API を残す。

## 4. データモデル

```ts
/** 永続化スキーマ v3 */
const LAYOUT_SCHEMA_VERSION = 3;

type RegionId = "left" | "right" | "bottom";

interface PersistedLayout {
  layoutVersion: typeof LAYOUT_SCHEMA_VERSION;
  state: LayoutState;
  activePresetId?: string;
}

interface LayoutState {
  regions: Record<RegionId, RegionState>;
  center: CenterState;
}

interface CenterState {
  editorOpen: boolean;
  /** 左→右 segment。editor は 1 つのみ。tool segment は横並び。 */
  segments: CenterSegment[];
}

type CenterSegment =
  | { id: string; kind: "editor"; sizeRatio: number }
  | {
      id: string;
      kind: "tool";
      sizeRatio: number;
      panels: ToolWindowPanelId[];
      activePanel: ToolWindowPanelId | null;
    };

interface RegionState {
  /** content 領域のサイズ。left/right は px 幅、bottom は px 高さ。
   *  全 slot 折りたたみ時も「次に開いたときの幅」として保持する。 */
  size: number;
  /** region 主軸方向に並ぶ slot。
   *  left/right は上→下、bottom は左→右の順。 */
  slots: SlotState[];
}

interface SlotState {
  id: string;                   // 一意 ID
  /** region 主軸方向の比率。§6.2 参照。 */
  sizeRatio: number;
  /** この slot に登録された tool window (登録順 = stripe アイコン順)。 */
  panels: PanelId[];
  /** 表示中の 1 枚。null = この slot は折りたたまれている。 */
  activePanel: PanelId | null;
}
```

**v3 追加（Center Workspace）:**

- **Center Stripe（常設）:** 中央領域の最上段に bottom 帯と上下対称の **水平帯**
  （高さ `STRIPE_SIZE`）を**常時表示**する。左右 region content の上にも被さる全幅帯で、
  side stripe は従来どおり全高・四隅は stripe。editor の開閉や center tool の有無に
  関わらず消えない（「押すと消えるツールバー」を避け、同一コントロールで開閉する）。
- **Editor アイコン:** Center Stripe 内に editor の開閉トグルを置く。`editor` は
  `ToolWindowPanelId` ではなく移動・除去不可の固定 segment のため、`ToolWindowIcon`
  （draggable / "Move to" コンテキストメニュー付き）ではなく **専用の非ドラッグアイコン**
  とし、クリックで `setEditorOpen` をトグルする。閉じてもアイコンは Center Stripe に残り、
  同一コントロールで再オープンできる。
- **Editor open/close:** `center.editorOpen`。閉じると `editor` segment の content が
  0 幅に畳まれる。`editor` も center tool も無く center band の content 幅が 0 に
  なったときは、開いている side region の 1 つを `1fr` filler に切り替えてグリッド全幅を
  埋める（§6.5）。Center Stripe 自体は常に残る。
- **center content 幅の条件:** content 列（editor / center tool）が幅を持つ条件は
  `editorOpen || hasCenterTools`。Center Stripe の表示はこの条件に**依らない**（常設）。
- **Center tool slot:** Review 等で Editor の左右に tool を横並びにできる。tool アイコンは
  Center Stripe に並び、DnD による center への tool 追加先も常設の Center Stripe が担う
  （全幅帯のため tool アイコンと content 列は厳密には整列しない — center tool は低頻度の
  ため許容する）。
- **見た目:** Center Stripe は side/bottom stripe と同じ **レイアウト chrome**
  （`bg-background/40` ＋ border、`ToolWindowIcon` のアイコン語彙）で描画し、エディタ
  自身の chrome（breadcrumb / `TabBar` / ツールバー）とは視覚的に区別する。
- **マイグレーション:** v2 `LayoutState`（`regions` のみ）→ v3 は `center` デフォルト付与。

エディタは `center.segments` の `kind: "editor"` segment として表現する。内容 (`SceneEditor`)
は `tabStore` 側が状態を持つ。`editorOpen === false` のとき segment は DOM 上 `hidden` マウント。

`panelRegions.ts` の `PanelRegion` 型 `"center-bottom"` は UI グルーピング用の別名であり、
永続化の `RegionId` `"bottom"` にマッピングする（`PanelToggleDropdown` 等は Phase 3 で
`RegionId` に合わせてリネームまたは alias を残す）。

### 4.1 派生状態

- `regionOpen(region)` = `region.slots.some(s => s.activePanel !== null)`
- region content の実サイズ = open なら `region.size`、closed なら 0
- content 内では **`activePanel !== null` の slot だけ**が領域を占有。占有 slot 間は
  正規化済み `sizeRatio` で分割（折りたたみ slot は 0px、ratio は保持）
- stripe を出すか = region に登録パネルが 1 つ以上ある (`slots.some(s => s.panels.length > 0)`)
- stripe 上の segment = **slot 1 つにつき 1 segment**。segment 内にその slot の全 panel
  アイコンを縦/横に並べる。segment 間に divider。segment の `flex-grow` は対応 slot の
  `sizeRatio`（折りたたみ中でも stripe 上の境界は維持）

### 4.2 パネルの登録

全 15 個の tool window（`TOOL_WINDOW_PANEL_IDS`、`editor` 除く）は起動時に既定 region/slot
へ**事前登録**される（`DEFAULT_SLOT_MAP` → `DEFAULT_REGION_MAP` / `DEFAULT_INDEX_MAP`
から slot 構成を生成）。3 つの stripe は最初から全アイコンが並ぶ (IntelliJ 同様)。

**初回起動・マイグレーション直後の `LayoutState`:**

- 全 slot の `activePanel` は **null**（何も表示されていない）
- `region.size` は region ごとのデフォルト px

**レイアウトプリセット適用時**（Write / Plan 等）:

- プリセットデータが `activePanel` を明示的に設定してよい（§9）

現行の `stripePanelIds` ("一度でも開いた panel" の集合) は不要。登録は `slot.panels`
への所属そのもの。

### 4.3 アイコンの状態 (2 状態)

| 状態 | 条件 | 見た目 | ARIA |
|------|------|--------|------|
| shown | `panel === slot.activePanel` | ハイライト + アクティブバー | `aria-pressed="true"` |
| hidden | slot に登録されているが非アクティブ | 減光 | `aria-pressed="false"` |

`data-stripe-icon="{panelId}"` は現行どおり維持（ツアー・E2E 用）。

現行の 3 状態 (shown / background / closed) は不要。1 slot = 1 表示パネルのため
「裏 tab (background)」が存在しない。

### 4.4 検証 (`validateLayoutState`)

Phase 1 で実装。Dockview 専用の `layoutValidation.ts` に替わる軽量検証:

- 各 `PanelId`（editor 除く）は **高々 1 つの slot** にのみ所属
- `activePanel` は必ずその slot の `panels` に含まれる
- `sizeRatio` は正の有限数
- `region.size` は `MIN_REGION_SIZE`〜`MAX_REGION_SIZE` の範囲（§6.2）
- slot `id` は region 内で一意
- 失敗時は `resetToDefaultLayout()` にフォールバック

## 5. コンポーネント構成

```
<LayoutShell hidden?>             CSS グリッド（§3）。各要素を grid-area へ配置
├─ <LayoutDnDHighlightOverlay>    DnD 中のドロップ先ハイライト（portal）
├─ <LayoutPanelDragGhost>         pointer ドラッグ中のゴースト（portal）
├─ <SideRegionStripeColumn>       side stripe 列（left / right、全高・四隅 stripe）
│   └─ <RegionStripe>             slot ごとに <StripeGroup> → <ToolWindowIcon> × N
├─ <RegionContent>                side region content。展開中 slot のみ sizeRatio 比で分割
│   ├─ <SlotView> × N             slot.activePanel を描画（閉じた slot はアンマウント）
│   └─ <Splitter> × N             open slot 間
├─ <CenterStripe>                 cstripe 行。常設の横帯（§4）
│   ├─ <EditorToggleIcon>         editor 開閉専用アイコン（非ドラッグ）
│   └─ <RegionStripe>             center tool segment のアイコン（region="center"）
├─ <CenterContent>                content 行。editor / center tool segment を横並び
│   ├─ <EditorArea>               kind:"editor" segment → <SceneEditor/>
│   ├─ <SlotView> × N             kind:"tool" segment を描画
│   └─ <Splitter> × N             center segment 間
├─ <RegionDock region="bottom">   bottom content（横分割）+ 横 stripe
│   ├─ <RegionContent>            bottom region content
│   └─ <RegionStripe>             bottom stripe（横）
└─ <RegionResizeSplitter>         region ⇔ center 境界（left / right / bottom）
```

- `RegionStripe` は side / bottom / center 共通。slot（center は tool segment）ごとに
  `StripeGroup` を作り `ToolWindowIcon` を並べる。アイコンは 3 状態（active /
  open-inactive / collapsed）。
- `CenterStripe` は常設の横帯（§4）。`EditorToggleIcon`（editor 専用・非ドラッグ・
  `setEditorOpen` をトグル）と center tool アイコンを並べ、side / bottom stripe と同じ
  レイアウト chrome（`bg-background/40` ＋ border）で描く。
- `SlotView` は `PANEL_COMPONENT_MAP[panelId]` を描画。slot が閉じると DOM から
  アンマウントされる。
- `EditorArea` は `<SceneEditor/>` を 1 つ持ち、`registerEditorFocusHandler` 経由で
  `requestEditorFocus()`（`layoutStore`）を公開する。
- glass テーマ: `SlotView` / `EditorArea` は `glass-region-panel` クラスで描画する。

## 6. 振る舞い

### 6.1 トグル (stripe アイコンクリック / ショートカット)

対象パネルが属する slot に対し:

- `panel === slot.activePanel` → `activePanel = null` (slot を折りたたむ)
- それ以外 → `activePanel = panel` (表示。slot が折りたたみ中なら展開)

region 内の他 slot は影響を受けない (IntelliJ と同じく slot ごとに独立トグル)。

**`showPanel(panelId)`**（現行 store に存在）:

- 既に `activePanel === panel` なら no-op
- それ以外は §6.1 の「表示」側と同じ（トグルで閉じない）

`togglePanel` は stripe / ショートカット / `PanelToggleDropdown` から使用。
`showPanel` は CommandPalette 等「必ず開く」経路用。

### 6.2 リサイズ

**制約（定数、Phase 1 で `layoutConstants.ts` 等に定義）:**

| 定数 | 推奨初期値 | 用途 |
|------|-----------|------|
| `MIN_REGION_SIZE` | 120 | region content 最小幅/高さ |
| `MAX_REGION_SIZE` | ビューポートの 50% | 中央エディタが潰れない上限 |
| `MIN_EDITOR_SIZE` | 320 | 中央 `1fr` セルの実効最小幅（Splitter クランプで保証） |
| `STRIPE_SIZE` | 32 | stripe 固定幅/高さ |

- **region サイズ**: region content と editor の境界 `Splitter` → `setRegionSize(region, px)`
  （クランプ後に保存）
- **slot サイズ**: 展開中 slot **のみ**を対象に slot 間 `Splitter` をドラッグ

**`sizeRatio` アルゴリズム:**

1. **表示中 slot の集合** `openSlots = slots.filter(s => s.activePanel !== null)`
2. content 内の各 open slot のピクセルサイズ =
   `regionContentSize * (slot.sizeRatio / sum(openSlots.sizeRatio))`
3. **Splitter ドラッグ**: 隣接 2 open slot の境界を動かし、両者の px サイズから
   新 ratio を算出 → その 2 つだけ更新 → **open slot 間で ratio を再正規化**（合計は任意定数でよい、相対比のみ使用）
4. **折りたたみ slot**: content では 0px。`sizeRatio` は**保持**（再展開時に復元）
5. **新規 slot 生成**（DnD §7）: `sizeRatio = 1`。既存 open slot と合わせて正規化
6. **stripe segment**: 対応 slot の `sizeRatio` を `flex-grow` に使用（slot 折りたたみ中も
   divider 位置は維持）

### 6.3 折りたたみ

region 内の全 slot が `activePanel === null` になると content が 0 幅/高に折りたたまれ、
stripe だけが残る。`region.size` は保持され、次に slot を開いたとき復元される。

### 6.4 レイアウトロック

現行 `layoutLocked` を v2 store に**維持**。`true` のとき:

- region / slot の Splitter 無効
- stripe DnD 無効
- `movePanel*` 無効
- トグル（開閉）は**許可**（現行 `ToolWindowIcon` と同様）

### 6.5 エディタの開閉と center filler

- **トグル:** Center Stripe の Editor アイコン（または `PanelToggleDropdown` /
  ショートカット）→ `setEditorOpen(boolean)`。`editor` segment の content を開閉する。
  Center Stripe は常設のためトグルしても消えない。
- **center filler:** editor を閉じ center tool も無いと center band の content 幅が 0 に
  なる。このとき grid に伸縮列が 1 つも無くなり、固定 px 列だけではウィンドウ幅に追従
  できず右側に余白が出る。これを防ぐため、開いている side region の 1 つ（左右とも開いて
  いれば右、片方なら開いている側）を `1fr` filler に切り替え、その region の content 列を
  `1fr`・専用 Splitter を非表示にする。残りの side region は固定 px のまま Splitter で
  リサイズ可能。
- editor を再び開く（または center tool が入る）と content 列が幅を持ち、filler は解除
  される。`layoutLocked` 中もトグル（開閉）は許可（§6.4）。

## 7. DnD 設計

Dockview overlay に依存せず自作。`layoutLocked` 時は全 DnD 無効。

### 7.1 ドラッグソース

stripe アイコンは **pointer 統一**（`useStripeIconPointerDrag`）。`ToolWindowIcon` の
`onPointerDown` で session を開始する。

- **250ms 長押し** OR **6px 移動**（`PANEL_POINTER_DRAG_THRESHOLD_PX`）のどちらか先で
  drag session 開始 → `setDraggingPanel(panel, "pointer", offset)`
- session 開始後に **6px 未満の移動で pointerup** → `togglePanel`（誤 drop 防止）
- **6px 以上移動して drop** → `performToolWindowDrop`
- `PanelToggleDropdown` 行は従来通り pointer threshold のみ（長押しなし）

`layoutLocked` 時は session 開始不可。`panelDragOffset` でゴースト位置を保持する。

**TabBar / エディタ内 DnD**（`DRAG_DATA_KEY`）とは MIME 型で分離。中央 `EditorArea` では
ツールウィンドウ drop を受け付けない（シーン tab DnD のみ `SceneEditor` が処理）。

### 7.2 ドロップゾーンと挙動

| ドロップ先 | 挙動 |
|-----------|------|
| 同一 slot stripe（`stripe-reorder`） | `panels[]` 順序のみ変更。**`activePanel` は不変** |
| 既存 slot (stripe segment / `RegionContent` 内) | panel をその slot に移動、**必ず** `activePanel = panel` |
| slot 間境界 / region 端 | その index に **新規 slot** を挿入、panel を入れ、`activePanel = panel`、`sizeRatio = 1`、open slot 間で正規化 |
| 別 region の stripe（segment 上） | ドロップ先 segment の slot に移動。segment が無い領域は **末尾に新規 slot** |
| 別 region の空 content | **末尾に新規 slot** 1 つ |

cross-region 移動は許可。ドラッグ中の視覚フィードバック:

- **`LayoutDnDHighlightOverlay`**: `slot` / `new-slot` 向け（領域全体の dashed rect）
- **`StripeInsertIndicator`**: `stripe-reorder` 向け（アイコン間の 1–2px 線）。Highlight と**排他**
- **`LayoutPanelDragGhost`**: pointer drag 中のアイコン clone

stripe ヒット領域は `STRIPE_DRAG_DETECTION_PAD_PX`（24px）で stripe 外側を拡張。
insert index は `calculateStripeInsertIndex` の gap ヒステリシスで粘着する。

### 7.3 移動時の後処理

- 移動元 slot から panel を除去（`stripe-reorder` 以外）
- 移動元 slot が空 (`panels.length === 0`) → slot 削除
- 移動元の `activePanel` が移動 panel だった → `activePanel = null`（他 panel があっても
  自動で別 panel を active にしない。ユーザーが stripe で選択）
- **`stripe-reorder`**: `panels[]` の順序のみ更新。`activePanel` は変更しない（表示順と
  表示中 panel を分離）

### 7.4 コンテキストメニュー（`ToolWindowIcon`）

現行「Move to region」「Remove from sidebar」を置換:

- **Move to Left / Right / Bottom**: `movePanelToRegion`（末尾 slot へ合流、無ければ新規 slot）
- **Remove from sidebar**: **廃止**（§1.3）。将来「デフォルト slot に戻す」等に転用可

## 8. 状態管理 / store

`layoutStore` を全面的に書き直す (Dockview API への参照を撤廃)。

### 8.1 主なアクション

- `togglePanel` / `showPanel` — §6.1
- `movePanelToSlot` / `movePanelToRegion` / `movePanelToNewSlot` — §7
- `reorderPanelInSlot(panel, region, slotId, insertIndex)` — §7.2 stripe-reorder
- `setRegionSize` / `setSlotRatios` — §6.2
- `setDraggingPanel(panel, source?, offset?)` — §7.1
- `requestEditorFocus()` — §5（エディタ中央セルへフォーカス。`tabStore` 連携は呼び出し側）
- `layoutLocked` / `toggleLayoutLock` — §6.4
- `loadLayout` / `saveLayout`（debounce）/ `applyPreset` / `resetToDefaultLayout`
- `saveCustomPreset` / `deleteCustomPreset` / `renameCustomPreset` — §9

### 8.2 永続化

global settings:

```ts
{
  layoutVersion: 3,
  layout: LayoutState,
  activePresetId?: string,
  layoutPresets?: CustomLayoutPreset[],  // { id, name, state: LayoutState }
  // toolWindows (旧) は読み取りのみ・マイグレーション後は書かない
}
```

- Dockview `SerializedDockview` は廃止
- `SceneEditor` の `tabStore` は従来通り別管理
- 言語変更時: `getPanelTitle` は維持（パネル chrome 用 i18n）

## 9. プリセット

`layoutPresets.ts` の `buildWrite(api)` 等を **`LayoutState` リテラル**に置換。
slot 構成の単一ソースは `DEFAULT_SLOT_MAP`（`toolWindowDefaults.ts`）から生成するヘルパ
`buildDefaultLayoutState(): LayoutState` を用意し、プリセットもこれをベースに上書きする。

```ts
/** マイグレーション・「リセット」用。全 activePanel = null */
const EMPTY_LAYOUT: LayoutState = buildDefaultLayoutState({ allInactive: true });

/** Write プリセット例。適用時のみ panel を開く */
const PRESET_WRITE: LayoutState = {
  regions: {
    left: {
      size: 260,
      slots: [
        { id: "l0", sizeRatio: 1, panels: ["scenes"], activePanel: "scenes" },
        {
          id: "l1",
          sizeRatio: 1,
          panels: ["codex", "codex-quick", "command-center-results"],
          activePanel: "codex",
        },
      ],
    },
    right: {
      size: 340,
      slots: [
        {
          id: "r0",
          sizeRatio: 1,
          panels: ["chat", "chat-history"],
          activePanel: "chat",
        },
        { id: "r1", sizeRatio: 1, panels: ["attribution"], activePanel: null },
      ],
    },
    bottom: {
      size: 220,
      slots: [
        /* DEFAULT_SLOT_MAP から BL/BR 相当の slot を生成 */
      ],
    },
  },
};
```

`api.addPanel` の順序依存・サイズ調整が消え、プリセットは純粋なデータになる。

**カスタムプリセット:** `CustomLayoutPreset { id, name, state: LayoutState }`。
旧 `SerializedDockview` カスタムプリセットは **変換せず破棄**（§10）。

## 10. マイグレーション

big-bang 置換。**完全リセット方式**を採用する（best-effort 移行はしない — 旧 Dockview
状態と新 region/slot モデルは構造が根本的に異なり、`activePanel` 等を確実に対応付け
できないため。中途半端な復元はかえって予測不能になる）。

起動時 `loadLayout()`:

1. `layoutVersion === 3` かつ `validateLayoutState` OK → そのまま適用
2. `layoutVersion === 2` かつ `validateLayoutState` OK → `migrateLayoutStateV2toV3` で
   `center: { editorOpen: true, segments: [editor] }` を付与して適用
3. それ以外（旧 Dockview JSON / 旧 `toolWindows` / 破損 / 初回起動）→
   `buildDefaultLayoutState()`（新デフォルトレイアウト）を適用
4. 旧 `SerializedDockview` / `toolWindows` / `layoutPresets`（Dockview 形式）/
   `undockedPanels` / `viewMode` は **すべて読み捨て**
5. 成功後 `layoutVersion: 3` を書き込み

カスタムプリセット読み込み (`loadPresets`) でも v2 state には `migrateLayoutStateV2toV3` を適用する。

**ユーザー影響:** 初回アップデート後、レイアウト（パネル配置・開閉状態・カスタム
プリセット）はリセットされる。タブ・原稿データは不変。リリースノートに明記。

## 11. 削除されるもの / 新規に作るもの

### 削除

- `stripeRegionDetection.ts` (+ test)
- `useStripeSegmentsByRegion.ts` (+ test) / `useStripePanelsByRegion.ts` (+ test)
- `layoutValidation.ts` (+ test) — Dockview 専用
- `DockviewWatermark.tsx`
- `App.tsx` の Dockview 連携 (`DockviewReact`, `handleReady`, `handlePanelDrop`,
  `handleStripeIconDrop`, `onDidDrop`, `DOCKVIEW_PANEL_COMPONENTS` 等)
- `layoutStore` の Dockview / `groupRef` / `indexInRegion` / `PANEL_INSERT_REGISTRY` /
  `hideAllGroupHeaders` / `openPanelAtSlot` / `moveToGroup` / `stripePanelIds`
- `dockview-react` / `dockview-core` 依存、Dockview CSS import
- 旧 6 slot enum `ToolWindowSlot` および migration 用 `migrateToolWindowsRecord`（置換後）

### 新規

- `layoutConstants.ts` — min/max サイズ
- `layoutStateUtils.ts` — `validateLayoutState`, `normalizeSlotRatios`, `buildDefaultLayoutState`
- `LayoutShell` / `RegionDock` / `RegionContent` / `SlotView` / `Splitter` / `EditorArea`
- `splitter/SplitterHandle` / `splitter/SplitterChrome` — Splitter style/functional 分離
- 自作 DnD + drop highlight + `StripeInsertIndicator` + `LayoutPanelDragGhost`
- `useStripeIconPointerDrag` — stripe pointer drag（250ms 長押し / 6px threshold）
- `reorderPanelInSlot` / `reorderPanelInCenterSegment`（`layoutStateUtils` pure）
- `layoutStore` v2
- `layoutValidation` v2（上記 utils）

### 流用・改修

- `RegionStripe` ← `ToolWindowStripe`
- `ToolWindowIcon`, `panelIcons.ts`, `panelComponents.tsx`
- `LayoutPresetDropdown`, `PanelToggleDropdown`（store API 差し替え）
- `PanelHighlightOverlay`（DnD 用）
- `ToolWindowShell` → `LayoutShell` にリネームまたは置換

## 12. フェーズ計画

**方針:** 成果物として **Dockview と並存するフェーズは設けない**。
Phase 2 完了時点で `App.tsx` は `LayoutShell` + v2 のみを描画し、未実装機能（DnD 等）は
no-op または UI 無効化とする。Dockview パッケージは Phase 6 で dependencies から除去。

| Phase | 内容 | 主な成果物 | ゲート |
|-------|------|-----------|--------|
| 1 | データモデル + store v2 ロジック | 型、utils、store、**プロパティテスト**（toggle/move/ratio） | `pnpm test` layout 系 |
| 2 | 静的 UI + App 配線切替 | `LayoutShell` 系、`EditorArea`、`requestEditorFocus`、screenshot `hidden`、glass | Dockview **未使用**で起動可能 |
| 3 | トグル + リサイズ + 配線 | Splitter、`showPanel`、ショートカット、`PanelToggleDropdown`、`layoutLocked` | 手動 smoke |
| 4 | 自作 DnD | §7 実装、context menu、highlight | DnD 統合テスト |
| 5 | プリセット + マイグレーション | `PRESET_*`、`layoutVersion`、custom preset v2 | 旧 settings fixture で migration テスト |
| 6 | 掃除 | 削除リスト、deps 除去、旧設計書アーカイブ | 全テスト + `tsc` |

各 Phase で `pnpm test` / `npx tsc --noEmit` を通す。

## 13. 未解決事項・リスク

| 項目 | 対応時期 | メモ |
|------|---------|------|
| 非アクティブパネル DOM | Phase 2 | Grid 等の再マウントコストを計測。`hidden` 保持 vs アンマウント |
| undock / floating | スコープ外 | 将来 overlay 層。`LayoutState` を汚さない |
| pin / auto-hide | スコープ外 | 将来拡張 |
| Sample Tour / screenshot | Phase 2–3 | `data-stripe-icon`、panel 固有 capture の動作確認 |
| 重いパネル初回表示 | Phase 2+ | 必要なら `React.lazy` は `SlotView` 側 |

**解消済み（本書で決定）:** 初回 `activePanel` vs プリセット、custom preset 破棄、
`layoutLocked` 維持、`sizeRatio` アルゴリズム、エディタフォーカス API、stripe 常時全表示、
マイグレーション方式（完全リセット）、Center Stripe 常設化（editor 開閉トグルの常設動線）、
center filler（editor 非表示時のグリッド充填）、**DnD UX**（pointer 統一・stripe-reorder・
InsertIndicator / Highlight 排他・`STRIPE_DRAG_DETECTION_PAD_PX`）。
