# Grimodex レイアウトシステム設計書

## 設計思想

すべてのコンポーネント（パネル）はdockとfloatが可能。ユーザーは自由にパネルを配置・分割・タブ化・フローティングでき、レイアウトは永続化される。ヘッダー右側のレイアウトプリセットドロップダウンでレイアウト構成を一括切替でき、パネルトグルドロップダウンで個別パネルの開閉を制御する。

採用モデル: **VS Code式**
- パネルのdock/float/tab/split → VS Code式
- Editorのマルチタブ + スプリット → VS Code Editor Group式

---

## ドックゾーン構成

アプリウィンドウは以下の領域で構成される。Left/Right DockはそれぞれTop/Bottomに縦分割（ゾーン内スプリット）できる。

```
┌──────────────────────────────────────────────┐
│  [メニュー] Title Bar  [レイアウト▼] [パネル▼] [⚙] │
├───────┬──────────────────┬────────────────────┤
│  L    │                  │  R                 │
│  T    │     Center       │  T                 │
│  o    │  (Editor Groups) │  o                 │
│  p    │                  │  p                 │
├───────┤                  ├────────────────────┤
│  L    ├──────────────────┤  R                 │
│  B    │     Bottom       │  B                 │
│  o    │     Dock         │  o                 │
│  t    │                  │  t                 │
└───────┴──────────────────┴────────────────────┘
```

### 各ゾーンの性質

| ゾーン | 位置 | サイズ挙動 | 特記事項 |
|--------|------|-----------|---------|
| Left Top | 左端・上部 | 幅リサイズ可能（初期~18%） | デフォルトはScenesパネル |
| Left Bottom | 左端・下部 | Left Topとの比率リサイズ可能 | デフォルトはCodex Quickパネル |
| Center | 中央 | flex（残り領域を埋める） | Editor Group専用 |
| Right Top | 右端・上部 | 幅リサイズ可能（初期~30%） | デフォルトはChat + Chat Historyタブ |
| Right Bottom | 右端・下部 | Right Topとの比率リサイズ可能 | デフォルトは空（パネル追加時に生成） |
| Bottom Dock | Centerの下 | 高さリサイズ可能（初期非表示） | パネル0個で非表示→Centerが拡張 |

Left/Right DockはTop/Bottom間で縦分割（ゾーン内スプリット）が可能。

---

## パネル一覧

| パネル | 説明 |
|--------|------|
| Scenes | Part/Chapter/Sceneツリー + Folder/Note |
| Codex Quick | 現在アクティブなシーンに関連するCodexエントリを自動表示。手動ピン留め対応 |
| Codex | 世界設定DB（Character/Location/Item/Lore）。リスト+詳細のマスター/ディテールUI |
| Editor | TipTapエディタ |
| Chat | BYOK AIチャット。シーンコンテキスト自動注入、Codex/Snippet抽出、エディタ挿入 |
| Chat History | 全シーン横断のチャットセッション検索・閲覧 |
| Snippets | 再利用可能なテキスト断片。Chat/Editorから保存、D&Dでエディタに挿入 |
| Attribution | AI帰属統計ダッシュボード。シーン/チャプター/プロジェクト単位の集計、モデル別使用状況 |
| Map | マインドマップ用ボード（複数ボード対応）。Sticky で発散し、Codex/Scene/Note/Snippet を手動キュレーションで配置。Free / Theme の 2 モード。AI Branch で種からアイデアを撒く |
| Matrix | シーン × Codex のクロス表。登場分布の俯瞰、不在検出、Beat 追加プロッティング起点。デフォルトBottom Dock（非表示） |
| Grid | Chapter ごとに Scene カードを縦に積む作業ビュー。Synopsis インライン編集、D&Dで章間移動。デフォルトBottom Dock（非表示） |
| Timeline | プロジェクト全体の時系列ビュー。デフォルトBottom Dock（非表示） |
| Kouetsu（校閲） | 校閲モード（Issues / Editorial / Comments タブ） |
| Foreshadow（伏線） | 伏線の張り・回収トラッキング |
| Trash Bin | ソフト削除されたノードのゴミ箱 |
| Settings | プロジェクト/AI/エディタ/表示/キーバインド/データ管理 |

**現状の実装**: `PanelId`（`layoutStore.ts`）には `editor` を除く 14 個のトグル可能パネルが定義されている（`TOGGLEABLE_PANELS` in `panelRegions.ts`）。Settings は dockview パネルではなく、モーダルダイアログ（`SettingsDialog`）として実装されている。各プリセットでの配置は `layoutPresets.ts` のビルダー関数を参照。

※ 現状未実装: Settings 専用のフローティングウィンドウ化（モーダルダイアログで代替）。

---

## パネルの4状態と遷移

```
                    Click icon
         ┌──────────────────────────┐
         │                          ▼
     ┌────────┐   Close tab   ┌─────────┐   Drag out   ┌───────────┐
     │ Closed │◄──────────────│ Docked  │─────────────►│ Floating  │
     └────────┘               └─────────┘               └───────────┘
         ▲                     │      ▲                       │
         │                     │      │                       │
         │              Toggle │      │ Click icon            │ Minimize
         │              icon   │      │                       │
         │                     ▼      │                       │
         │               ┌───────────┐│         Drop on zone  │
         │               │ Collapsed │◄───────────────────────┘
         │               └───────────┘
         │                     │
         └─────────────────────┘
                Close tab
```

### 各状態の定義

**Closed（閉じている）**
- どのドックゾーンにも所属しておらず、フローティングウィンドウとしても存在しない。
- ドロップダウンのチェックボックスがオフ。
- ドロップダウンからクリックするとデフォルト位置にDocked状態で復元される。

**Docked（ドックされている）**
- いずれかのドックゾーン（Left/Right/Bottom/Center）にタブとして存在。
- ドロップダウンのチェックボックスがオン。
- タブをゾーン外にドラッグ → Floating へ遷移。
- タブの×ボタン → Closed へ遷移。
- ドロップダウンから再クリック → Closed へ遷移（アクティブタブの場合）。

**Collapsed（折りたたまれている）**
- ドックゾーンに所属しているが、ゾーン自体が折りたたまれている状態。
- ドロップダウンのチェックボックスがオン（薄いスタイルで区別可能）。
- ドロップダウンからクリック → Docked へ遷移（ゾーンを展開し、そのタブをアクティブにする）。

**Floating（フローティング）**
- アプリウィンドウ上に独立したウィンドウとして浮遊。
- リサイズ・移動可能。
- タイトルバーをドックゾーンのエッジにドロップ → Docked へ遷移。
- 最小化 → Collapsed へ遷移。
- ×ボタン → Closed へ遷移。

---

## パネルトグルドロップダウン

### 位置と構造

ヘッダーバー右側に配置されたマルチセレクトドロップダウン。パネルの開閉ランチャーとして機能する。

```
ヘッダー: [メニュー] [タイトル] ... [レイアウト▼] [パネル▼] [⚙設定]

ドロップダウン展開時（現状の実装。表示は左→右→下部の順、各リージョン毎にセパレータ）:
┌──────────────────────────────┐
│ 左                           │
│ [✓] シーン        Ctrl+Alt+S │
│ [✓] Codex         Ctrl+Alt+X │
│ [✓] Codex Quick   Ctrl+Alt+Q │
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

ショートカット表記の正本は `KEYBOARD_SHORTCUT_MAP`（`panelRegions.ts`）。実装での発火は `App.tsx` の `handleKeyDown` 内 keyMap を参照（一部のショートカットはまだキーマップに未接続）。

### クリック挙動

- チェックオフ（Closed）→ クリックでデフォルト位置にDocked状態で復元。
- チェックオン（Docked/アクティブ）→ クリックでClosed。
- ドロップダウンはクリックしても閉じない（マルチセレクト）。click-outside / Escape で閉じる。

### ドラッグによる追加（現状の実装）

非表示パネル行はドラッグ可能で、`PANEL_DRAG_TYPE`（`application/grimodex-panel-id`）の dataTransfer 経由で dockview の任意の位置にドロップできる。`App.tsx` の `onUnhandledDragOverEvent` でドラッグを受理し、`onDidDrop` で `addPanel` を呼ぶ。

### レイアウトロック（現状の実装）

ドロップダウン末尾のロックトグル（`toggleLayoutLock`）で全グループに `group.locked = true` を適用し、`api.updateOptions({ disableDnd: true })` でD&Dを無効化する。ロック中は新規追加グループにも自動でロックが伝播する（`onDidAddGroup`）。

### ホバーハイライト

ドロップダウン項目にホバーすると、対象パネルの表示領域をハイライトする（`PanelHighlightOverlay.tsx`）。
- 表示中のパネル: パネルグループの実位置を実線ボーダー＋グロー（GSAP の pulsing）で囲う。
- 非表示のパネル: `estimateRegionRect` でリージョン推定位置を破線ボーダーで示す。Codex Quick は scenes パネル位置を起点に推定する専用ヒューリスティクスを持つ。
- Reduced Motion 設定時はパルスアニメーションを停止。

---

## レイアウトプリセットドロップダウン

### 位置と構造

ヘッダーバー右側、パネルトグルドロップダウンの**左**に配置。現在のレイアウト構成を名前付きプリセットとして保存・切替できるドロップダウン。

```
ドロップダウン展開時:
┌──────────────────────────────┐
│ プリセット                    │
│ (●) デフォルト                │
│ ( ) チャットメイン             │
│ ( ) Codexメイン               │
├──────────────────────────────┤
│ カスタム                      │
│ ( ) 執筆集中モード       [🗑]  │
│ ( ) レビュー用           [🗑]  │
├──────────────────────────────┤
│ [💾] 現在のレイアウトを保存    │
└──────────────────────────────┘
```

### ビルトインプリセット

**現状の実装**: `getBuiltinPresets()`（`layoutPresets.ts`）が 5 つのビルトインプリセットを返す。いずれも削除・名前変更不可。

| プリセット ID | 表示名（i18n キー） | 概要 |
|------------|------------------|------|
| `builtin:default` | Write（`layout.preset.default`） | 標準の執筆レイアウト。Scenes + Codex Quick / Editor / Chat + Chat History、Codex タブに Snippets。Left ~18%、Right ~33% |
| `builtin:plan` | Plan（`layout.preset.plan`） | プロット構築用。Grid + Map / Timeline と Chat + Chat History / Codex + Snippets + Foreshadow + Matrix の 2 列構成 |
| `builtin:chat-main` | Chat（`layout.preset.chatMain`） | チャット主体。Chat + Chat History / Codex + Snippets + Matrix の 2 列構成 |
| `builtin:review` | Proofread（`layout.preset.review`） | 校閲用。Scenes / Editor / Kouetsu / Codex の 4 列、Scenes 下に Attribution |
| `builtin:codex-main` | Condense（`layout.preset.codexMain`） | 世界観参照用。Codex（Snippets/Matrix/Map をタブ）/ Chat（Chat History）の 2 列、Codex 内 wide mode で list+Editor+detail 3 カラム発動 |

ビルトインプリセットは画面幅・高さに対する相対比率（`api.width * 0.xx`）で構築されるため、異なるウィンドウサイズでも適切な比率が維持される。

※ 設計書旧版で記載していた「デフォルト / チャットメイン / Codexメイン」3 プリセット構成は、現行ではプリセット数・名称・パネル構成ともに刷新されている。詳細な panel 追加順は `layoutPresets.ts` の各 `build*` 関数を参照。

### カスタムプリセット

ユーザーは現在のレイアウトに名前を付けて保存できる。

- **保存**: 「現在のレイアウトを保存」をクリック → 名前入力 → Enter/✓で確定。`DockviewApi.toJSON()` でシリアライズしたレイアウトJSON全体を保存する。
- **適用**: プリセット名をクリック → `DockviewApi.fromJSON()` で即座に復元。
- **削除**: カスタムプリセット行のゴミ箱アイコンをクリック。ビルトインプリセットには削除ボタンは表示されない。

### クリック挙動

- プリセットをクリックすると即座にレイアウトが切り替わり、ドロップダウンが閉じる。
- アクティブなプリセットにはチェックインジケータ（●＋✓）が表示される（`LayoutPresetDropdown.tsx`）。
- 保存モード中はEscapeで保存をキャンセルできる。
- click-outside / Escape でドロップダウンが閉じる。
- 末尾の「デフォルトに戻す」（`resetToDefaultLayout`）はビルトイン `builtin:default` を再構築し、保存済みレイアウトを `clearSavedLayout()` で消去する。プリセット選択経由のリセットとは別経路。

### ボタン表示

アクティブなプリセットがある場合、ボタンにプリセット名が表示される。プリセットが選択されていない場合は「レイアウト」と表示される。

---

## Center Dock（Editor Groups）

### Editor Groupモデル

CenterドックはVS Codeの「Editor Group」モデルを採用する。

- Centerは1つ以上のEditor Groupに分割できる。
- 各Editor Groupは独立したタブバーを持ち、複数のシーンタブを開ける。
- Group間はリサイズハンドルで比率調整可能。

```
┌─────────────────────────────────┐
│ [Scene 1] [Scene 3]  │ [Scene 2]│
├─────────────────────────────────┤
│                       │          │
│   Editor Group 1      │ Editor   │
│   (Scene 1 active)    │ Group 2  │
│                       │          │
│                       │          │
└─────────────────────────────────┘
```

### スプリット操作

Editor Groupの分割は以下の3つの方法で行える。

1. **タブのドラッグ**: シーンタブをCenter内の左/右/上/下エッジにドラッグすると、新しいEditor Groupが生まれる。
2. **スプリットボタン**: エディタツールバーのスプリットアイコン（アクティブシーンを右に分割）。
3. **キーボードショートカット**: `Ctrl+\`（垂直分割）、`Ctrl+Shift+\`（水平分割）。分割先のGroupに同じシーンが表示され、同期編集が可能。

### タブ操作

- タブをGroup内でドラッグ → 順序変更。
- タブを別のGroupのタブバーにドラッグ → そのGroupに移動。
- タブをGroupのエッジにドラッグ → 新しいGroupとしてスプリット。
- タブをCenter外にドラッグ → フローティングエディタウィンドウ。

### 同一シーンの複数ビュー（同期編集）

同一シーンを複数のEditor Groupで同時に開くことが可能。両方のビューは同一のTipTapドキュメントインスタンスを共有し、一方での編集が即座にもう一方に反映される。

実装方針:
- シーンIDごとに単一のTipTapドキュメントインスタンスを管理する（シーンストアで管理）。
- 各Editor Groupのビューは同一インスタンスに対する `EditorView` を生成する。ProseMirrorの `EditorState` を共有し、`dispatchTransaction` で全ビューに変更を伝播する。
- タブのタイトルにバッジ（例: 小さなドット）を表示し、同じシーンが他のGroupでも開かれていることを視覚的に示す。
- ビューごとにスクロール位置とカーソル位置は独立（同じシーンの異なる箇所を参照しながら執筆するユースケースを想定）。

---

## ドックゾーン内の操作

Left/Right/Bottom Dockはすべて同じ操作モデルを共有する。

### タブ追加

パネルをドックゾーンのタブバーにドロップすると、既存パネルと並んでタブになる。

```
┌─────────────────┐         ┌──────────────────────┐
│ [Scenes]        │   →     │ [Scenes] [Codex]     │
│                 │         │                      │
│  Scene tree     │         │  Codex list          │
└─────────────────┘         └──────────────────────┘
```

### ゾーン内スプリット

パネルをドックゾーンの上下左右のエッジにドロップすると、そのゾーンが分割される。

```
┌─────────────────┐         ┌──────────────────────┐
│ [Scenes]        │   →     │ [Scenes]             │
│                 │         │  Scene tree          │
│  Scene tree     │         ├──────────────────────┤
│                 │         │ [Codex]              │
│                 │         │  Codex list          │
└─────────────────┘         └──────────────────────┘
```

スプリット比率はリサイズハンドルで調整可能。

### ゾーンの折りたたみ

ゾーン内の全パネルが非アクティブ（Collapsed）になると、ゾーン自体がゼロ幅/ゼロ高さに折りたたまれ、隣接するCenterゾーンが拡張する。ドロップダウンから再度オンにすることで即座に復帰。

---

## フローティングウィンドウ

### 振る舞い

- アプリウィンドウの範囲内で自由に配置・リサイズ可能。
- タイトルバー: パネル名 + 最小化ボタン + ×ボタン。
- タイトルバーをダブルクリック → 前回のDock位置に復帰（記憶している場合）。
- 複数のフローティングウィンドウをスタック（タブ化）することはMVPでは非対応。

### ドロップヒント

フローティングウィンドウのタイトルバーをドラッグ中にドックゾーンのエッジに近づくと、ドロップ先を示すハイライト領域を表示する。

- ゾーンの中央 → そのゾーンにタブとして追加。
- ゾーンの上/下/左/右 → そのゾーン内でスプリット。

※ 現状未実装: フローティングウィンドウへの分離操作（`addFloatingGroup` 等）は呼び出していない。dockview ライブラリ側の機能としては利用可能だが、現行 UI からはトリガーされず、Floating 状態への遷移は無効。Settings はモーダルダイアログで代替。

---

## レイアウトの永続化

### 保存対象

- 各パネルの状態（Closed / Docked / Collapsed / Floating）
- 各パネルの所属ゾーンとタブ順序
- ゾーン内のスプリット構造と比率
- Editor Groupの分割構造と各Groupで開いているタブ（Scene、Note、Codex content、Snippet content）。各タブはタブ種別と対象ID（node_id、codex_entry_id、snippet_id）で識別する。**注記:** エディタタブの開閉状態はレイアウトとは別にワークスペースDB（`editor.tabState`）に永続化される。詳細はEditorパネル設計書「タブ状態の永続化」を参照
- フローティングウィンドウの位置・サイズ
- 各ゾーンの幅/高さ

### 保存先

OS AppDataディレクトリ内の `global-settings.json` に保存する。レイアウトはプロジェクト横断のUI状態であり、プロジェクトDBには含めない。アプリ起動時に読み込み、レイアウト変更のたびにデバウンス（500ms）で自動保存する。

`global-settings.json` に保存されるレイアウト関連フィールド:

| フィールド | 型 | 説明 |
|-----------|---|------|
| `layout` | `SerializedDockview \| null` | 現在のdockviewレイアウトJSON（自動保存） |
| `layoutPresets` | `Array<{id, name, layout}> \| null` | ユーザー保存のカスタムプリセット一覧 |
| `activeLayoutPresetId` | `string \| null` | 最後に適用したプリセットのID |

### 起動時の復元

1. `buildDefaultLayout()` で即座にデフォルトレイアウトを表示（ブランク画面を防ぐ）
2. `global-settings.json` から `layout` を非同期で読み込み、存在すれば `fromJSON()` で上書き復元
3. `layoutPresets` と `activeLayoutPresetId` をストアにロード（ドロップダウンのUI表示用）

これにより、起動時には最後に保存されたレイアウト（プリセット適用後にユーザーが手動調整した状態を含む）が復元される。

**現状の実装（`App.tsx` の `handleReady`）**:
復元処理は以下の三段階バリデーションを通る（`layoutValidation.ts`）。
1. `validateSerializedLayout(saved)` — JSON 構造を事前検証（grid 形状・leaf 数・panel 数）。失敗時は trash → デフォルトのまま。
2. `api.fromJSON(saved)` — 失敗（互換性のないシリアライズ形式など）したら例外を捕捉し、デフォルトレイアウトを再構築。
3. `validateRuntimeLayout(api)` — 復元後の実レイアウトを検証（グループ数・単一グループ支配率）。失敗時はデフォルトに戻して保存済みレイアウトを消去。

`saveLayout` は `onDidLayoutChange` から 500ms デバウンスで自動起動し、保存前にも `validateSerializedLayout` を通して退行レイアウトの保存を防ぐ。

### リセット

レイアウトプリセットドロップダウンから「デフォルト」プリセットを選択することで初期配置に復帰する。コマンドパレット（`Ctrl+Shift+P`）からの「レイアウトをデフォルトに戻す」操作も同等。

---

## キーボードショートカット

### 設計原則

小説執筆アプリであるため、テキスト編集のショートカット（`Ctrl+B` = Bold、`Ctrl+K` = リンク挿入、`Ctrl+I` = Italic 等）を絶対に上書きしない。レイアウト操作には `Ctrl+Alt` プレフィックスを使い、エディタ操作と完全に分離する。

### テキスト編集（TipTapデフォルト — 予約済み、上書き禁止）

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+B` | 太字 |
| `Ctrl+I` | 斜体 |
| `Ctrl+U` | 下線 |
| `Ctrl+K` | リンク挿入 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+A` | 全選択 |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+X` | コピー / ペースト / カット |
| `Ctrl+1` / `2` / `3` | 見出しH1 / H2 / H3（TipTap設定による） |

### レイアウト操作（`Ctrl+Alt` プレフィックス）

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+B` | Left Dockの表示/非表示トグル |
| `Ctrl+Alt+J` | Bottom Dockの表示/非表示トグル |
| `Ctrl+Alt+R` | Right Dockの表示/非表示トグル |
| `Ctrl+\` | アクティブエディタを右にスプリット |
| `Ctrl+Shift+\` | アクティブエディタを下にスプリット |
| `Alt+1` / `2` / `3` | Editor Group 1 / 2 / 3 にフォーカス |

### タブ・ウィンドウ操作

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+W` | アクティブタブを閉じる |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 同一Group内の次/前のタブ |
| `Ctrl+Shift+P` | コマンドパレットを開く |
| `Ctrl+Shift+N` | 新しいウィンドウ（将来的に） |

### パネル直接アクセス（`Ctrl+Alt` + パネル頭文字）

**現状の実装**: 表示ヒント（ドロップダウンの `kbd`）は `KEYBOARD_SHORTCUT_MAP`（`panelRegions.ts`）、実際の発火は `App.tsx` の `handleKeyDown` 内 `keyMap` を参照。両者の対応は順次拡張中。

| ショートカット | 動作 | 接続状況 |
|-------------|------|---------|
| `Ctrl+Alt+S` | Scenesパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+Q` | Codex Quickパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+C` | Chatパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+H` | Chat Historyパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+X` | Codexパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+N` | Snippetsパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+A` | Attributionパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+L` | Timelineパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+M` | Mapパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+T` | Kouetsu（校閲）パネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+F` | Foreshadow（伏線）パネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+B` | Trash Binパネルにフォーカス/トグル | 有効 |
| `Ctrl+Alt+G` | Gridパネルにフォーカス/トグル | ※ keyMap 未接続（表示ヒントのみ） |
| `Ctrl+Alt+R` | Matrixパネルにフォーカス/トグル | ※ keyMap 未接続（表示ヒントのみ） |
| `Ctrl+Alt+,` | Settings ダイアログを開く | 有効 |
| `Ctrl+Shift+E` | エクスポートダイアログ | 有効 |
| `Ctrl+Shift+F` | 全文検索ダイアログ | 有効 |
| `Ctrl+Shift+P` | コマンドパレット | 有効 |

### ショートカットのカスタマイズ

すべてのショートカットはSettings内のキーバインド設定画面で変更可能とする。コマンドパレット（`Ctrl+Shift+P`）からもキーバインドの検索・変更が可能。

---

## dockingライブラリへの要件

上記設計を実現するために、dockingライブラリに求める要件を整理する。

### 必須要件

- タブ化（同一ゾーン内で複数パネルをタブ切替）
- 4方向ドック（Left / Right / Bottom / Center）
- フローティングウィンドウ（ドラッグで分離、リサイズ・移動可能）
- ドラッグ&ドロップによるパネル移動（ゾーン間、タブ↔フローティング）
- ゾーン内スプリット（上下/左右に分割）
- レイアウトのシリアライズ/デシリアライズ（JSON形式）
- 同一コンテンツの複数パネルへの表示（同一シーンの同期編集のため）
- React対応
- TypeScript型定義

### あると嬉しい要件

- Editor Groupモデルのネイティブサポート（Center内の複数スプリット）
- ドロップヒントのカスタマイズ（ハイライト領域のスタイル変更）
- ゾーンの折りたたみ/展開アニメーション
- ゾーンの最小幅/最大幅の設定
- 軽量（バンドルサイズがTauriの軽量思想に合うこと）

### 採用ライブラリ

**`dockview-react` v5.2.0** を採用。

#### 選定理由

上記必須要件（タブ化、4方向ドック、フローティング、D&D、ゾーン内スプリット、レイアウトシリアライズ、React/TypeScript対応）をすべて単一ライブラリで満たす唯一の候補であった。

| 候補                             | 判定     | 理由                                                                                   |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------ |
| `dockview`                     | **採用** | 必須要件をすべて充足。VS Code風のEditor Groupモデルにネイティブ対応。`toJSON()`/`fromJSON()` によるレイアウト永続化が組み込み |
| `FlexLayout`                   | 不採用    | フローティングウィンドウ非対応                                                                      |
| `react-mosaic`                 | 不採用    | タイル型のみ、フローティング非対応                                                                    |
| `rc-dock`                      | 不採用    | TypeScript型定義が不十分、ドキュメントが乏しい                                                         |
| 自前実装（`react-resizable-panels`） | 不採用    | タブ化・D&D・フローティング・シリアライズを自前実装するコストが大きい                                                 |

#### 実装構成

- `DockviewReact` コンポーネントが全ドックゾーンのレイアウトを管理（`App.tsx`）
- 各パネル（Scenes, Codex, Chat等）はdockviewのコンポーネントマップに登録
- `DockviewApi` の参照をZustand store（`layoutStore`）に保持し、ヘッダードロップダウンやキーボードショートカットから操作
- レイアウト永続化: `api.toJSON()` でシリアライズし、`global-settings.json` に保存
- プリセット管理: ビルトインプリセットは `layoutPresets.ts` にビルダー関数として定義。カスタムプリセットはシリアライズ済みJSONとして `global-settings.json` に保存。`layoutStore` がプリセットのCRUD操作を提供
- リージョン分類: `panelRegions.ts` で各パネルを `left` / `right` / `center-bottom` の 3 リージョンに分類し、トグルドロップダウンの区切りと `PanelHighlightOverlay` の推定位置に使用
- 挿入位置の自動解決: `resolveInsertPosition()`（`layoutStore.ts`）が各パネルの優先アンカー（`PANEL_INSERT_REGISTRY`）を順に評価し、既存パネルに対する `within` / `left` / `right` / `above` / `below` の挿入位置を返す
- 全パネルが閉じられた状態: `DockviewWatermark` コンポーネント（`watermarkComponent` prop）が主要パネルのショートカット一覧を表示
- テーマ: `dockview-theme-dark` クラスを適用し、`--dv-*` CSS変数をプロジェクトのデザイントークンで上書き

#### デフォルトレイアウト

```
┌──────────────────────────────────────────────────────────┐
│ [メニュー] Grimodex  [レイアウト▼] [パネル▼] [⚙]          │  ← ヘッダー
├──────────────┬──────────────────┬────────────────────────┤
│ [シーン]      │                  │ [チャット][履歴]        │
│              │   [エディタ]      │                        │
│  Left Top    │   Center         │  Right Top             │
│  (~18%)      │   (~52%)         │  (~30%)                │
├──────────────┤                  │                        │
│ [Codex Quick]│                  │                        │
│              │                  │                        │
│  Left Bottom │                  │                        │
└──────────────┴──────────────────┴────────────────────────┘
```

- 履歴タブはチャットと同グループで非アクティブ（初期非表示）
- Snippets・Attributionパネルは初期状態では非表示。ヘッダードロップダウンから追加するとEditor下部にグループとして配置される。

> **注記**: `react-resizable-panels` はCodexManagementPanelおよびSnippetPanelのマスター/ディテール内部分割に引き続き使用している。アプリレベルのドックレイアウトのみdockviewに移行済み。

---

## 今後の検討事項

- **ドロップヒントのUXデザイン**: ハイライトの色・アニメーション・形状
- **レスポンシブ対応**: ウィンドウが狭い場合のゾーン自動折りたたみルール
