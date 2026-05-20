# Grimodex レイアウトシステム設計書

## 設計思想

採用モデル: **IntelliJ 式ツールウィンドウ Stripe + VS Code (Dockview) 式 Dock の hybrid**

- **予測可能性**: 各 panel は preferred slot (= 配置先 region) を持ち、stripe アイコンや
  キーボードショートカットから開いたときは常にその region に配置される。「どこに開くか
  分からない」問題を排除する。
- **カスタマイズ性**: ユーザーは Dockview の自由 D&D で panel を任意位置に移動可能。
  自由ドラッグで動かすと slot が actual region に追従するため、閉じて再オープンしても
  最後にいた region に戻る。
- **二系統 UI の併存**: クイックアクセスは stripe アイコン (常駐)、全パネル管理は
  ヘッダーの `PanelToggleDropdown` (旧来通り)。両方残す。

過去経緯: `react-resizable-panels` ベースの固定 LeftDock/RightDock/BottomDock を
Dockview に全面移行 (commit `58c4f30`, 2026-04-03) して自由 D&D を獲得した一方で、
「panel をトグルしたときどこに開くか不明」という問題が残った。Phase 1 (本書時点) で
IntelliJ 式 stripe を Dockview の上に被せて両者を両立する。

---

## 全体構造

```
┌──────────────────────────────────────────────────────────────┐
│ [Menu] Grimodex … [Search/Command Bar] [Layout▼] [Panels▼] [⚙]│  ← Header
├────┬──────────────────────────────────────────────────────┬──┤
│    │                                                      │  │
│ L  │                                                      │ R│
│ S  │            DockviewReact (中央 content cell)         │ S│
│ T  │   ┌─────────────┬───────────────┬──────────────┐     │ T│
│ R  │   │             │               │              │     │ R│
│ I  │   │  L Panels   │   Editor      │  R Panels    │     │ I│
│ P  │   │             │               │              │     │ P│
│ E  │   │             ├───────────────┤              │     │ E│
│    │   │             │  Bottom Panel │              │     │  │
│    │   └─────────────┴───────────────┴──────────────┘     │  │
├────┤                                                      ├──┤
│ L  ├───────────── Bottom Stripe ─────────────────────────┤R │
│ ST │                                                      │ST│
└────┴──────────────────────────────────────────────────────┴──┘
```

`ToolWindowShell` が CSS Grid で stripe と Dockview を配置:

```css
grid-template-columns: ${left}px 1fr ${right}px;
grid-template-rows: 1fr ${bottom}px;
grid-template-areas:
  "left content right"
  "left bottom  right";
```

- 左右 stripe は 2 行を span (常に container 全高)
- 下 stripe は中央列のみ (Dockview の真下)
- bottom stripe の表示/非表示で左右 stripe の高さが変動しない (Phase 2 で LT/LB を
  上下分割しても上下にぶれない)

---

## ツールウィンドウ Stripe

### Stripe の出現条件

各 region の stripe は **「stripePanelIds に該当 region の panel が 1 つ以上ある」** ときに表示される。0 件なら grid セル幅 0 で完全に折り畳まれる。

- `stripePanelIds: Set<PanelId>` は `onDidAddPanel` で自動登録される
- 一度でも開かれた panel は閉じても stripePanelIds に残る → 再オープン経路を確保
- 明示的に外す API は `removePanelFromStripe(panelId)` (Phase 2 の右クリックメニュー用)

### Slot 構成

6 slot (IntelliJ 互換): `LT` / `LB` (= 左 stripe top/bottom), `RT` / `RB` (= 右), `BL` / `BR` (= 下 left/right)。

| Slot | Stripe | Phase 1 表示 | Phase 2 表示 |
|------|--------|-------------|-------------|
| LT | 左 | 左 stripe 上半分 | LT 専用グループ |
| LB | 左 | 左 stripe (混在) | LB 専用グループ (divider で分離) |
| RT | 右 | 同上 | RT |
| RB | 右 | 同上 | RB (divider) |
| BL | 下 | 下 stripe (混在) | BL (左半分) |
| BR | 下 | 同上 | BR (右半分、divider) |

Phase 1 では region 単位 (left/right/bottom の 3 つ) でのみ処理し、stripe 内の上下分割は
Phase 2 で導入する。

### アイコンの 3 状態

| 状態 | 条件 | スタイル | data-state |
|------|------|---------|------------|
| shown | active tab として表示中 (or Undock overlay) | 濃い accent + 左に primary 色の縦バー | `shown` |
| background | Dockview にあるが裏 tab | 中間 accent (`bg-accent/30`) | `background` |
| closed | Dockview に居ない (placed 履歴のみ残存) | 薄い text、hover で反応 | `closed` |

ARIA: `aria-pressed` = active. `data-stripe-icon="{panelId}"` で外部から特定可能。

### クリック挙動

すべて `togglePanel(panelId)` に集約:

- **shown** クリック → `removePanel` で閉じる (icon は inactive 化、stripe からは消えない)
- **background** クリック → そのタブを `setActive`
- **closed** クリック → preferred slot で `openPanelAtSlot` 経由で再オープン

右クリックメニュー / DnD は Phase 2。

### Panel アイコン割当 (Lucide React)

`src/features/layout/panelIcons.ts:PANEL_ICON_MAP`。

| Panel | Lucide icon |
|-------|-------------|
| scenes | `FolderTree` |
| codex | `BookOpen` |
| codex-quick | `Zap` |
| command-center-results | `Search` |
| chat | `MessageSquare` |
| chat-history | `MessagesSquare` |
| snippets | `TextQuote` |
| attribution | `Highlighter` |
| timeline | `CalendarRange` |
| map | `Map` |
| kouetsu | `SpellCheck` |
| foreshadow | `Sparkles` |
| grid | `Grid2x2` |
| matrix | `Table2` |
| trash-bin | `Trash2` |

### DEFAULT_SLOT_MAP (初期 slot 割当)

`src/features/layout/toolWindowDefaults.ts`。「ユーザーが override していない panel を
最初に開く位置」を定義する。

| Panel | Slot | Stripe |
|-------|------|--------|
| scenes | LT | 左 |
| codex | LB | 左 |
| codex-quick | LB | 左 |
| command-center-results | LB | 左 |
| chat | RT | 右 |
| chat-history | RT | 右 |
| attribution | RB | 右 |
| timeline | BL | 下 |
| map | BL | 下 |
| grid | BL | 下 |
| matrix | BL | 下 |
| snippets | BR | 下 |
| kouetsu | BR | 下 |
| foreshadow | BR | 下 |
| trash-bin | BR | 下 |

---

## パネル一覧

| パネル | 説明 |
|--------|------|
| Scenes | Part/Chapter/Sceneツリー + Folder/Note |
| Codex Quick | 現在アクティブなシーンに関連するCodexエントリを自動表示。手動ピン留め対応 |
| Codex | 世界設定DB (Character/Location/Item/Lore)。リスト+詳細のマスター/ディテールUI |
| Editor | TipTapエディタ。Center Dock の Editor Group 内に常駐 (stripe 対象外) |
| Chat | BYOK AIチャット。シーンコンテキスト自動注入、Codex/Snippet抽出、エディタ挿入 |
| Chat History | 全シーン横断のチャットセッション検索・閲覧 |
| Command Center Results | ヘッダーの検索バーから開く全文検索結果パネル |
| Snippets | 再利用可能なテキスト断片。Chat/Editorから保存、D&Dでエディタに挿入 |
| Attribution | AI帰属統計ダッシュボード |
| Map | マインドマップ用ボード (複数ボード対応) |
| Matrix | シーン × Codex のクロス表 |
| Grid | Chapter × Scene カード一覧の作業ビュー |
| Timeline | プロジェクト全体の時系列ビュー |
| Kouetsu (校閲) | 校閲モード (Issues / Editorial / Comments タブ) |
| Foreshadow (伏線) | 伏線の張り・回収トラッキング |
| Trash Bin | ソフト削除されたノードのゴミ箱 |
| Settings | プロジェクト/AI/エディタ/表示/キーバインド/データ管理 (モーダルダイアログ、stripe 対象外) |

**現状の実装**: `PanelId` (`layoutStore.ts`) には `editor` を除く 15 個のトグル可能パネルが
定義され、`TOGGLEABLE_PANELS` (`panelRegions.ts`) と `DEFAULT_SLOT_MAP`
(`toolWindowDefaults.ts`) でメタデータ管理されている。

---

## パネルの状態モデル

ある panel は以下の 3 つの直交する状態を持つ:

```
placed  = stripePanelIds.has(id)
visible = api.getPanel(id) !== undefined
active  = panel.group?.activePanel === panel
```

組合せ別の意味:

| placed | visible | active | 意味 | UI |
|--------|---------|--------|------|----|
| ✗ | ✗ | ✗ | 一度も開かれていない | stripe に icon なし、dropdown でのみアクセス可 |
| ✓ | ✗ | ✗ | placed 履歴あり、現在は閉じている | stripe に **closed** icon |
| ✓ | ✓ | ✗ | tab group の裏 tab | stripe に **background** icon |
| ✓ | ✓ | ✓ | 内容が画面に出ている | stripe に **shown** icon |
| ✓ | (special) | ✓ | Undock overlay (Phase 3) | stripe に shown icon (visible は false でも active=true) |

### 状態遷移

```
                ┌────────────────────────────────────────┐
                │                                        │
                ▼                                        │
            ┌─────────┐  dropdown click /            ┌───┴─────┐
   open ──► │ Visible │  keyboard shortcut /         │  Closed │ ◄─── add panel
            │ Active  │  stripe icon click           │  (placed │
            └─┬─┬─────┘                              │  history)│
              │ │                                    └───┬──────┘
              │ │  free drag to another tab group        │
              │ ▼                                        │
              │  ┌──────────┐  tab switch                │
              │  │ Visible  │ ◄──────────────────┐       │
              │  │ Background│                  │       │
              │  └────┬─────┘                   │       │
              │       │ click background icon   │       │
              │       └─────────────────────────┘       │
              │                                          │
              │  panel removed (close button / stripe click on active)
              └─────────────────────────────────────────►┘
```

「placed 履歴」自体は `stripePanelIds` に蓄積され、明示的に
`removePanelFromStripe` を呼ばない限り消えない (再起動を跨いで永続化される)。

---

## パネル配置の統一入口

`openPanelAtSlot(panelId, opts?)` (`layoutStore.ts`) を **唯一の panel 配置入口** にする:

- `togglePanel(panelId)` — 既存 active なら remove、それ以外は openPanelAtSlot
- `showPanel(panelId)` — openPanelAtSlot を `focus: true` で
- `handlePanelDrop(event)` — canvas drop なら openPanelAtSlot、明示的 group drop は within
- `App.tsx:handleKeyDown` — `togglePanel(panel)` 経由

これによりキーボード・dropdown・stripe・DnD すべてが同じロジックを通る。

### `openPanelAtSlot` の責務

1. 既存 panel があれば `setActive` してリターン
2. Undock 中なら overlay 層に委譲 (Phase 3 用、現在は no-op)
3. `editor` は legacy fallback (`direction: "right"`, `minimumWidth: 320`)
4. それ以外は `toolWindows[id]?.slot ?? DEFAULT_SLOT_MAP[id]` で region 確定
5. `resolveInsertPositionForRegion(api, region, toolWindows)` で具体 position を解決
6. `api.addPanel({ id, component: id, title, position })`

### `resolveInsertPositionForRegion`

```ts
for (const id of TOOL_WINDOW_PANEL_IDS) {
  const slot = toolWindows?.[id]?.slot ?? DEFAULT_SLOT_MAP[id];
  if (SLOT_TO_REGION[slot] !== region) continue;
  if (api.getPanel(id)) return { referencePanel: id, direction: "within" };
}
// fallback: region 方向に新 group
return { direction: region === "bottom" ? "below" : region };
```

ポイント: **effective slot** (= override > default) で region を判定する。これがないと、
ユーザーが panel X を別 region に動かした場合に X が旧 region の anchor に残ってしまい、
復元時に icon stripe と異なる region に panel が配置される。

`editor` を anchor 候補にしないことで editor group の split を回避する不変条件を守る。

---

## 自由ドラッグと slot 自動同期

### 自由ドラッグ

Dockview のネイティブ D&D は常に許可。タブの並び替え・ゾーン移動・別グループへの drop
すべて Dockview に委ねる。Stripe は「お気に入りの場所」を覚えるだけで、runtime 強制は
しない。

### `syncSlotsToActualRegions`

`api.onDidLayoutChange` のたびに走り、`stripePanelIds` の各 panel について「現在の
actual region」を DOM から検出し、slot.region と異なれば slot を上書きする。

```ts
for (const id of get().stripePanelIds) {
  if (id === "editor") continue;
  const region = detectActualRegion(api, id);
  if (!region) continue;
  const currentRegion = SLOT_TO_REGION[toolWindows[id]?.slot ?? DEFAULT_SLOT_MAP[id]];
  if (region === currentRegion) continue;
  // 新 region の代表 slot に上書き (Phase 1 は LT/RT/BL)
  updates[id] = { slot: pickDefaultSlotForRegion(region), viewMode: "docked-pinned" };
}
```

これで:
- 自由ドラッグで panel を別 region に動かす → slot 追従 → icon が新 stripe に移動
- 閉じて再オープン → 最後にいた region で開く
- 起動時の saved layout 復元後にも一度走り、saved layout の位置に slot を揃える

### Region 検出ロジック (`detectRegionFromRects`)

editor group の矩形に対して panel group の矩形を相対比較する pure 関数:

| 条件 | 判定 |
|------|------|
| `panel.top ≥ editor.bottom` **かつ** editor と水平方向に重なる | `bottom` |
| `panel.right ≤ editor.left` (= editor の完全に左) | `left` |
| `panel.left ≥ editor.right` (= editor の完全に右) | `right` |
| いずれにも当たらない (重なり・editor 上方など) | `null` (= slot にフォールバック) |

**水平方向の重なりを bottom 判定に要求する** のが重要。これがないと、editor 列に下方向の
panel が入って editor.bottom が中央付近に上がったとき、左列の下半分にいる panel まで
bottom 扱いになる (Write preset 状態で chat を中央下に drop した際に発生した不具合)。

4px の tolerance で resize 中の sub-pixel ゆらぎを吸収する。同じ tab group に editor が
いる panel (= 中央 area の tab) と editor 不在時は null を返し、slot 由来の region に
フォールバックする。

---

## PanelToggleDropdown (全パネル管理 UI)

ヘッダーバー右側の「パネル▼」ボタンから開くマルチセレクトドロップダウン。stripe アイコンが
出ていない panel (= 未 placed) を開く主たる経路。

```
┌──────────────────────────────┐
│ 左                           │
│ [✓] シーン        Ctrl+Alt+S │
│ [✓] Codex         Ctrl+Alt+X │
│ [ ] Codex Quick   Ctrl+Alt+Q │
│ [ ] 検索          Ctrl+Alt+K │
├──────────────────────────────┤
│ 右                           │
│ [✓] チャット      Ctrl+Alt+C │
│ [ ] チャット履歴   Ctrl+Alt+H │
├──────────────────────────────┤
│ 下部                         │
│ [ ] Snippets      Ctrl+Alt+N │
│ [ ] 帰属          Ctrl+Alt+A │
│ [ ] タイムライン   Ctrl+Alt+L │
│ [ ] マップ        Ctrl+Alt+M │
│ [ ] 校閲          Ctrl+Alt+T │
│ [ ] 伏線          Ctrl+Alt+F │
│ [ ] グリッド      Ctrl+Alt+G │
│ [ ] マトリクス     Ctrl+Alt+R │
│ [ ] ゴミ箱        Ctrl+Alt+B │
├──────────────────────────────┤
│ [🔒] レイアウトをロック        │
└──────────────────────────────┘
```

`TOGGLEABLE_PANELS` / `PANEL_REGION_MAP` / `KEYBOARD_SHORTCUT_MAP`
(`panelRegions.ts`) が region 別グルーピングとショートカット表示の正本。実発火は
`App.tsx:handleKeyDown` 内 `keyMap` を参照。

### クリック挙動

- チェックオフ → `togglePanel` → `openPanelAtSlot` → preferred slot で開く
- チェックオン (アクティブ) → `togglePanel` → 閉じる (stripe icon は残る)

### ドラッグによる追加

非表示 panel 行はドラッグ可能。`PANEL_DRAG_TYPE`
(`"application/grimodex-panel-id"`) の dataTransfer で Dockview の任意位置に drop できる。
`App.tsx:onUnhandledDragOverEvent` で受理、`onDidDrop` ハンドラが canvas drop なら
`openPanelAtSlot` 経由、明示的な group drop ならその group に `within` 追加する。

### レイアウトロック

末尾のロックトグルで全 group に `group.locked = true` を適用、
`api.updateOptions({ disableDnd: true })` で D&D を無効化。新規追加 group にもロックが
伝播する (`onDidAddGroup`)。Stripe アイコンの click トグルはロック中も許可される
(lock は移動禁止のみ)。

### ホバーハイライト

`PanelHighlightOverlay.tsx` がドロップダウン項目 hover 時にパネル予定位置を破線で示す。
表示中の panel は実 group 位置を実線 + GSAP pulsing で囲う。Reduced Motion 設定時は
pulsing を停止。

---

## LayoutPresetDropdown (プリセット管理)

ヘッダーバー右、`PanelToggleDropdown` の左に配置。

### ビルトインプリセット (5 種)

`getBuiltinPresets()` (`layoutPresets.ts`)。削除・改名不可。

| ID | 表示名 | 概要 |
|----|--------|------|
| `builtin:default` | Write | 執筆標準。Scenes + Codex Quick / Editor / Chat + Chat History、Codex タブに Snippets。Left ~18%、Right ~33% |
| `builtin:plan` | Plan | プロット用。Grid + Map / Timeline と Chat + Chat History / Codex + Snippets + Foreshadow + Matrix の 2 列 |
| `builtin:chat-main` | Chat | チャット主体。Chat + Chat History / Codex + Snippets + Matrix |
| `builtin:review` | Proofread | 校閲用。Scenes / Editor / Kouetsu / Codex の 4 列、Scenes 下に Attribution |
| `builtin:codex-main` | Condense | 世界観参照用。Codex (Snippets/Matrix/Map タブ) / Chat (Chat History) |

ウィンドウ幅に対する比率 (`api.width * 0.xx`) で構築されるため、異なるサイズでも適切な比率が保たれる。

### カスタムプリセット

- **保存**: 「現在のレイアウトを保存」→ 名前入力 → `DockviewApi.toJSON()` で全体を JSON 化
- **適用**: 行クリック → `fromJSON()` で復元
- **削除**: 行のゴミ箱アイコン (ビルトインには出ない)

保存されるのは Dockview の layout JSON のみ。**`stripePanelIds` / `toolWindows` (slot
設定) はプリセットに含めず、ユーザー設定として独立して永続化される**。これにより、
プリセット切替で stripe アイコンの配置が崩れない (= ユーザーの slot カスタマイズが保護される)。

### リセット

「デフォルトに戻す」(`resetToDefaultLayout`) はビルトイン `builtin:default` を再構築し、
保存済みレイアウトを `clearSavedLayout()` で消去する。`stripePanelIds` 等は維持される。

---

## Center Dock (Editor Groups)

`editor` panel は stripe 対象外で、常に Dockview の中央 area に存在する Editor Group の中で
管理される (VS Code 式)。

### Editor Group モデル

- Center は 1 つ以上の Editor Group に分割可能
- 各 Group は独立したタブバーを持ち、複数のシーンタブを開ける
- Group 間はリサイズハンドルで比率調整可能

```
┌─────────────────────────────────┐
│ [Scene 1] [Scene 3]  │ [Scene 2]│
├──────────────────────┼──────────┤
│                      │          │
│   Editor Group 1     │ Editor   │
│   (Scene 1 active)   │ Group 2  │
│                      │          │
└──────────────────────┴──────────┘
```

### スプリット操作

1. タブを Center 内の上下左右エッジにドラッグ → 新 Group
2. エディタツールバーのスプリットアイコン (アクティブシーンを右に分割)
3. `Ctrl+\` (垂直)、`Ctrl+Shift+\` (水平)

### 同一シーンの複数ビュー

同一シーン ID を複数 Group で同時に開ける。両ビューは同一 TipTap ドキュメントインスタンスを
共有し、`dispatchTransaction` で変更が伝播する。スクロール・カーソル位置は独立。

---

## ドックゾーン内の操作 (Dockview ネイティブ)

Stripe の有無に関係なく、Dockview の自由 D&D は常時有効。タブをエッジに drop してスプリット、
別 group のタブバーに drop してタブ化、Center 外にドラッグで Floating (フローティングウィンドウ)。

スプリット比率はリサイズハンドルで自由に調整可能。

---

## フローティングウィンドウ

`addFloatingGroup` 等 dockview の API は提供されているが、現在の Grimodex UI からは
明示的にトリガーされていない。Settings はモーダルダイアログ (`SettingsDialog`) で代替。

将来的に Phase 3 で stripe の Undock view mode (overlay 表示) を導入予定。OS-level の独立
ウィンドウ (Float / Window mode) は Tauri 制約により対象外。

---

## レイアウトの永続化

### 保存先

OS AppData ディレクトリ内の `global-settings.json`。プロジェクト横断の UI 状態。

### 保存フィールド

| フィールド | 型 | 説明 |
|-----------|---|------|
| `layout` | `SerializedDockview \| null` | Dockview レイアウトの JSON (自動保存) |
| `layoutPresets` | `Array<{id, name, layout}>` | ユーザー保存のカスタムプリセット |
| `activeLayoutPresetId` | `string \| null` | 最後に適用したプリセット ID |
| `toolWindows` | `Partial<Record<PanelId, ToolWindowState>>` | per-panel の slot / viewMode / undockSize override |
| `stripePanelIds` | `string[]` | stripe icon を出している panel ID リスト |
| `stripeSizes` | `Record<StripeRegion, number>` | stripe ごとの幅 (px) |
| `stripeVisibility` | `Record<StripeRegion, boolean>` | stripe 全体の表示/非表示 (Phase 4 で UI 提供) |

### scheduleSave (統一 coordinator)

すべて単一の debounce 500ms save にまとめて競合を防ぐ:

```ts
function scheduleSave(get) {
  setTimeout(async () => {
    const layout = api.toJSON();
    if (!validateSerializedLayout(layout).valid) return;
    const current = await invoke("get_global_settings");
    await invoke("save_global_settings", {
      settings: {
        ...current,
        layout,
        toolWindows: get().toolWindows,
        stripePanelIds: Array.from(get().stripePanelIds),
        stripeSizes: get().stripeSizes,
        stripeVisibility: get().stripeVisibility,
      },
    });
  }, 500);
}
```

トリガー: `onDidLayoutChange`、`setToolWindowSlot`、`setViewMode`、
`removePanelFromStripe`、`setStripeSize`、`setStripeVisibility`、`saveLayout()` 手動呼出。

### 起動時の復元

1. `buildDefaultLayout(api)` でデフォルトレイアウトを同期表示 (ブランク画面回避)
2. `loadLayout()` で `global-settings.json` から layout を非同期取得し、3 段バリデーション通過後 `fromJSON` で復元
   - `validateSerializedLayout(saved)` (grid 形状・leaf 数・panel 数)
   - `api.fromJSON(saved)` 例外時はデフォルト再構築
   - `validateRuntimeLayout(api)` (グループ数・単一グループ支配率)
3. `loadPresets()` でカスタムプリセット一覧と active ID を取得
4. `loadToolWindowSettings()` で `toolWindows` / `stripePanelIds` / `stripeSizes` / `stripeVisibility` を merge (layout 復元時の `onDidAddPanel` で既に populate されている `stripePanelIds` と merge する)

**起動時の優先順位**: saved layout > preferred slot。saved layout に panel があればその位置を尊重し、slot は表示用に裏で同期される。

### リセット

`resetToDefaultLayout` で `builtin:default` を再構築し、`clearSavedLayout` で saved layout を消去する。`stripePanelIds` などのユーザー設定は維持。

---

## キーボードショートカット

### 設計原則

小説執筆アプリのため、TipTap デフォルトのテキスト編集ショートカット (`Ctrl+B` 太字、
`Ctrl+I` 斜体、`Ctrl+K` リンク、`Ctrl+Z`/`Ctrl+Shift+Z` Undo/Redo 等) は絶対に
上書きしない。レイアウト操作は `Ctrl+Alt` プレフィックス。

### グローバルショートカット

| ショートカット | 動作 |
|---|---|
| `Ctrl+Shift+E` | エクスポートダイアログ |
| `Ctrl+Shift+F` | Command Center バーにフォーカス (全文検索 / コマンド) |
| `Ctrl+Shift+P` | コマンドパレット |
| `Ctrl+Shift+D` | デバッグログビューア |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 同一 Editor Group 内のタブ切替 |

### パネル直接アクセス (`Ctrl+Alt` + 頭文字)

`KEYBOARD_SHORTCUT_MAP` (`panelRegions.ts`) と `App.tsx:handleKeyDown` の `keyMap` が
正本。両者が一致している必要がある。

| ショートカット | パネル |
|---|---|
| `Ctrl+Alt+S` | Scenes |
| `Ctrl+Alt+X` | Codex |
| `Ctrl+Alt+Q` | Codex Quick |
| `Ctrl+Alt+K` | Command Center Results (検索) |
| `Ctrl+Alt+C` | Chat |
| `Ctrl+Alt+H` | Chat History |
| `Ctrl+Alt+N` | Snippets |
| `Ctrl+Alt+A` | Attribution |
| `Ctrl+Alt+L` | Timeline |
| `Ctrl+Alt+M` | Map |
| `Ctrl+Alt+T` | Kouetsu (校閲) |
| `Ctrl+Alt+F` | Foreshadow (伏線) |
| `Ctrl+Alt+G` | Grid (※ 現状 keyMap 未接続) |
| `Ctrl+Alt+R` | Matrix (※ 現状 keyMap 未接続) |
| `Ctrl+Alt+B` | Trash Bin |
| `Ctrl+Alt+,` | Settings ダイアログ |

### Editor

| ショートカット | 動作 |
|---|---|
| `Ctrl+\` | アクティブエディタを右にスプリット |
| `Ctrl+Shift+\` | アクティブエディタを下にスプリット |
| `Alt+1` / `2` / `3` | Editor Group 1 / 2 / 3 にフォーカス |

### カスタマイズ

将来的に Settings 内のキーバインド設定画面で全ショートカットを変更可能とする。
コマンドパレット (`Ctrl+Shift+P`) からもキーバインドを検索・変更できる予定。

---

## 実装ファイル構成

`src/features/layout/`:

| ファイル | 役割 |
|----------|------|
| `layoutStore.ts` | Zustand store。`dockviewApi` 保持 / `togglePanel` / `showPanel` / `openPanelAtSlot` / 全 slot/stripe 関連 action / preset CRUD / layout lock / 永続化 (`scheduleSave`, `loadToolWindowSettings`, `clearSavedLayout`) |
| `toolWindowDefaults.ts` | 型 (`ToolWindowSlot` / `ViewMode` / `StripeRegion` / `ToolWindowState`) + 定数 (`DEFAULT_SLOT_MAP` / `SLOT_TO_REGION` / `DEFAULT_STRIPE_SIZES` / `DEFAULT_STRIPE_VISIBILITY` / `TOOL_WINDOW_PANEL_IDS`) |
| `panelRegions.ts` | `PANEL_REGION_MAP` (3 region) / `KEYBOARD_SHORTCUT_MAP` / `TOGGLEABLE_PANELS` |
| `panelIcons.ts` | `PANEL_ICON_MAP: Record<PanelId, LucideIcon>` |
| `panelComponents.tsx` | `PANEL_COMPONENT_MAP` (素の React) + `DOCKVIEW_PANEL_COMPONENTS` (Dockview wrap)。Dockview と将来の Undock overlay 層が共有 |
| `stripeRegionDetection.ts` | `detectRegionFromRects` (pure) / `detectActualRegion` (DOM 経由) / `pickDefaultSlotForRegion` |
| `useStripePanelsByRegion.ts` | shell が使う hook。stripePanelIds を slot.region 別に分類して `Array<{id, visible, active}>` を返す |
| `ToolWindowShell.tsx` | grid wrapper。3 stripe + Dockview を CSS Grid 配置 |
| `ToolWindowStripe.tsx` | 1 stripe (region + orientation) |
| `ToolWindowIcon.tsx` | 1 icon。`active` / `visible` で 3 状態描画 |
| `PanelToggleDropdown.tsx` | 全パネル管理 UI (region 別) |
| `LayoutPresetDropdown.tsx` | プリセット UI |
| `PanelHighlightOverlay.tsx` | hover 時の panel 領域ハイライト |
| `DockviewWatermark.tsx` | 全パネル閉時の watermark |
| `layoutPresets.ts` | 5 ビルトイン preset builder + クリアロジック |
| `layoutValidation.ts` | layout JSON / runtime 検証 |

`App.tsx` (抜粋):
- `ToolWindowShell` で `DockviewReact` をラップ
- `components` prop に `DOCKVIEW_PANEL_COMPONENTS` を渡す
- `handleReady` で `setDockviewApi` → `loadLayout` → `loadPresets` + `loadToolWindowSettings`
- `handlePanelDrop` は canvas drop なら `openPanelAtSlot`、明示 group drop は `within`

---

## デフォルトレイアウト (Write preset 起動直後)

```
┌──────────────────────────────────────────────────────────────────┐
│ [Menu] Grimodex … [Search bar] [Layout▼] [Panels▼] [⚙]           │  ← Header
├────┬───────────────────────────────────────────────────────┬─────┤
│ 📁 │                                                       │ 💬  │
│    │                                                       │     │
│    │  ┌──────────────┬───────────────┬────────────────┐   │     │
│    │  │ [Scenes]     │               │ [Chat] [Hist.] │   │     │
│    │  │              │ [Editor]      │                │   │     │
│    │  │              │               │                │   │     │
│    │  │              │               │                │   │     │
│    │  │              │               │                │   │     │
│    │  ├──────────────┤               │                │   │     │
│    │  │ [Codex Quick]│               │                │   │     │
│    │  │              │               │                │   │     │
│    │  └──────────────┴───────────────┴────────────────┘   │     │
│    │                                                       │     │
├────┤                                                       ├─────┤
│ (bottom stripe は panel が 0 のとき非表示)                          │
└────┴───────────────────────────────────────────────────────┴─────┘
```

- 左 stripe: 📁 Scenes (active) + ⚡ Codex Quick (active)
- 右 stripe: 💬 Chat (active) + 🗨 Chat History (background tab)
- 下 stripe: 非表示 (placed panel 0)
- Snippets / Attribution / Map / Matrix / Grid / Timeline / Kouetsu / Foreshadow /
  Trash Bin / Search は未 placed → stripe に icon なし。dropdown または shortcut で
  最初に開いた瞬間に stripePanelIds 登録 + icon 出現

---

## Phase 2 以降のロードマップ

### Phase 2: 6 slot 細分化 + Stripe DnD + 右クリックメニュー

- ToolWindowStripe 内に divider を入れて LT/LB (左)、RT/RB (右)、BL/BR (下) を分離
- `resolveInsertPositionForSlot(api, slot)` (6 slot 単位の解決) を追加
- Stripe icon 間の DnD で slot 再割当 (新 MIME `application/grimodex-toolwindow-reassign`)
- 右クリックメニュー: "Move To" (6 slot から選択) / "Remove from sidebar" (`removePanelFromStripe`)

### Phase 3a: Dock Unpinned (auto-hide) prototype

- `useAutoHidePanel(panelId)` hook で focus 境界外クリックを検知
- 除外 selector を整備 (`data-radix-portal` / `data-popover-root` / `data-modal-root` 等を modal/popover 側に付与する横断変更)
- panel ヘッダ / 右クリックメニューに View Mode 切替 UI (Pinned ↔ Unpinned)

### Phase 3b: Undock (overlay)

- `UndockedOverlayLayer` / `UndockedOverlay` — Dockview 外で absolute-positioned overlay 描画
- View Mode に `undocked` を追加。Dockview ↔ overlay の移行ロジック
- `panelComponents.tsx` の `PANEL_COMPONENT_MAP` を overlay 側でも mount
- `resultsPanelStore.mounted` 等の派生 state を `dockviewApi.getPanel(id) || undockedPanels.has(id)` で導出するよう更新
- 再起動時 bootstrap (viewMode === "undocked" の panel を overlay として復元)

### Phase 4: 仕上げ

- Stripe visibility トグル UI (Settings or PanelToggleDropdown 拡張)
- Stripe 幅の resize handle (`stripeSizes`)
- Onboarding tour に stripe 紹介を追加
- Layout lock との連携最終確認

### Phase 5 (将来候補)

- Dockview → stripe へのドラッグ (panel を stripe icon 化)
- Stripe 内アイコン並び順カスタマイズ
- Stripe collapse (全アイコン非表示にして縦/横の細線だけ残す)

---

## docking ライブラリ採用: dockview-react

`dockview-react` v5.x を採用。VS Code 風の Editor Group、自由 D&D、float、レイアウト
シリアライズ (`toJSON`/`fromJSON`)、React/TypeScript 対応を満たす唯一の候補。

| 候補 | 判定 | 理由 |
|------|------|------|
| `dockview` | **採用** | 必須要件をすべて満たす |
| `FlexLayout` | 不採用 | フローティング非対応 |
| `react-mosaic` | 不採用 | タイル型のみ |
| `rc-dock` | 不採用 | TypeScript 型不十分、ドキュメント不足 |
| 自前 (`react-resizable-panels`) | 不採用 | タブ化・D&D・float 自前実装のコスト大 |

### Grimodex での組合せ方

- アプリレベルのドックレイアウト → dockview
- 個別パネル内のマスター/ディテール分割 (`CodexManagementPanel` / `SnippetPanel`) →
  `react-resizable-panels` (引き続き使用)
- ステータス確認: `dockview-theme-dark` クラスを適用、`--dv-*` CSS 変数を
  プロジェクトのデザイントークンで上書き

---

## 今後の検討事項

- ドロップヒントの UX (ハイライト色・アニメーション)
- レスポンシブ対応 (ウィンドウが狭い場合の stripe 自動折り畳みルール)
- Phase 2 の sub-slot 内 position 記憶 (LT/LB 内で「上から N 番目」を保持するか)
- Phase 3 の Undock pinning (Pinned overlay は IntelliJ 互換性のため別途検討)
