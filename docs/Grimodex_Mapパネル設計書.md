# Grimodex Mapパネル設計書

## 概要

Mapパネルはプロジェクトのシーン・Codexエントリを**2D空間に配置して可視化・構造化**するパネル。Scenesパネルがツリー構造（1次元・reading-order）、Timelineパネルが時間軸（1次元・story-time / reading / write）を担うのに対し、Mapは**関係性のトポロジー**と**空間的クラスタリング**を扱う。

プロッティング・取材・俯瞰のフェーズで威力を発揮する。執筆そのものには向かないため、Editorとの連携（シーンを開く）と役割分担を明確にする。

Sceneノードは Compact / Card / Image の3バリアントを持ち、Cardバリアント + Free モードでは **Scrivener 風のコルクボード体験**（インデックスカード・Synopsisインライン編集・ステータススタンプ）を提供する。モード連動デフォルトにより、「Freeに切り替えた瞬間にカードになる」自然な切り替えが起きる。

デフォルト位置: Bottom Dock（非表示）。大画面ではフローティングウィンドウやCenterスプリットで運用するのが理想。

設計思想: **Mapは座標をもつビュー。座標の決め方（手動・重力場・ハイブリッド）を切り替えることで、同じデータの別の見方を提供する。**

---

## パネル構造

```
┌───────────────────────────────────────────────────────────────┐
│ A. ヘッダー                                                    │
│ Map                 [Free ▼] [Board: Main ▼] [🔍] [⋮]         │
├───────────────────────────────────────────────────────────────┤
│ B. モードバー                                                   │
│ Mode:  [Free] [Time] [Theme] [POV] [Place]                   │
│ Show:  ☑Scenes  ☑Codex  ☑Derived edges  ☐User edges  ☑Frames │
├───────────────────────────────────────────────────────────────┤
│ C. キャンバスビューポート（無限・スクロール・ズーム可能）          │
│                                                                │
│  ┌─ Frame: Part I plot ──────────────────┐                    │
│  │   ● Ch.1        ● Ch.2                │                    │
│  │   廃社           封じ文                │                    │
│  │     ＼         ／                     │                    │
│  │       ● Elara                         │                    │
│  │         │                             │                    │
│  │       ◯ Marcus                        │                    │
│  └───────────────────────────────────────┘                    │
│                                                                │
│  ┌─ Frame: Codex anchors ────────────────┐                    │
│  │   □ Tower    □ Forest    ◆ Amulet     │                    │
│  └───────────────────────────────────────┘                    │
│                                                                │
│  ✦ AI: 封じ文の差出人？                                         │
│                                                                │
│  ┌─ Palette ──────────────────────┐           [Zoom: 100%]     │
│  │ [+Scene] [+Codex] [+Note] [+Frame] [⌥Connect] │           │
│  └────────────────────────────────┘                           │
└───────────────────────────────────────────────────────────────┘
```

---

## レイアウトモード

5つのモードを提供する。内部的には**1つのNodesコレクション + 1つのEdgesコレクション**に対して、異なる座標決定関数を適用しているだけ。

| モード | 座標決定 | 用途 |
|--------|---------|------|
| **Free** | ユーザー手動ドラッグ | プロッティング・取材・ブレインストーミング |
| **Time** | X軸=story_time_order、Y軸=POVレーン | 時系列+視点の俯瞰 |
| **Theme** | Force-directed（共有タグで引力） | テーマ・モチーフの可視化 |
| **POV** | クラスタリング（POVキャラごとに塊） | 視点構造の俯瞰 |
| **Place** | クラスタリング（locationごとに塊） | 舞台地理の俯瞰 |

### Hybrid 挙動

Free以外の全モードで、**ピン留めされたノード**はユーザー座標を優先し、それ以外のノードを重力場で自動配置する。

- ノード右クリック → 「Pin position」で個別ピン留め
- ピン留めされたノードは Free モードで設定した `(x, y)` を保持
- 重力モード切替時もピンは維持される
- 「これが物語の骨格」と思う重要ノードだけピン留めし、残りは重力場の自動配置に任せる使い方

### モード切替の振る舞い

- モード切替時はトランジションアニメーション（300ms）で座標が移動
- **Theme モードへの切替は2段階**: ①Web Worker で force layout を計算（プログレス表示あり、数ノードなら即時・100ノード超は数秒）→ ②計算完了後に 300ms トランジションで各ノードを最終座標へ移動。他モード間の切替では計算フェーズはなく 300ms トランジションのみ
- Free モードで設定した位置は保持され、モード切替時に失われない
- Free モードに戻ると、最後に手動配置した位置に復元される

---

## A. ヘッダー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Map」。左寄せ |
| モードドロップダウン | 現在のレイアウトモード表示（モードバーと同期、狭小画面用の冗長表示） |
| ボード切替ドロップダウン | 複数ボード対応時のボード選択（後述、v2拡張） |
| [🔍] 検索ボタン | 展開でインクリメンタルノード検索、ヒットノードにビューポート自動センタリング |
| [⋮] パネルメニュー | Display / Export / Reset layout / Help |

### パネルメニュー

```
Display
  ☑ シーン
  ☑ Codex
  ☑ ノート
  ☑ AIノード（手動追加のみ）
  ☑ Derived edges（Codex親子・シーン言及）
  ☐ User edges（ユーザー描画）
  ☑ Frames
  ☐ ミニマップ
  ☑ グリッドスナップ
  ☐ 非表示ノードを表示（グレー表示）  ← このボードで隠したノードを再表示可能にする
  ---
  Scene display     ▶ Compact / Card / Image / Auto
  Color by          ▶ None / Status / POV / Tag / Label
  ☐ Corkboard feel  （カードに微回転 + テクスチャ背景）

Layout
  Auto-arrange      ▶ Grid by reading-order
                      Grid by story-time
                      Grid by POV
                      Force-directed compact
  ---
  Reset Free positions
  Fit to viewport

Export
  SVG / PNG として保存
  JSONとしてエクスポート（他ツール連携用）
```

### Auto-arrange アクション

レイアウトモードとは独立した、**ワンショットの整列アクション**。実行すると選択モード（または全ノード）の位置が一括で更新され、その後は Free モードで自由に調整可能。

| アクション | 動作 |
|----------|------|
| **Grid by reading-order** | Reading-order 順でグリッド配置（N列、左から右・上から下） |
| **Grid by story-time** | `story_time_order` 順でグリッド配置。未設定シーンは末尾 |
| **Grid by POV** | POVごとの行 × reading-order の列。POV未設定は下段 |
| **Force-directed compact** | Themeモードのforce layoutを実行し、結果を Free の座標として固定 |

**重要**: これらはモードではなく**アクション**。実行後は Free モードで、ユーザーが手でノードを動かした瞬間から手動配置として保存される。Scrivenerの "Linear / Freeform" 切替とは異なり、整列は一度きり・以降はFreeで編集する、という分業。

実行前に確認ダイアログ:
```
この操作はFreeモードのノード位置を上書きします
（ピン留めされたノードの座標は変更されません）。

                  [キャンセル]  [実行]
```

**Auto-arrangeとピン留めの関係**:
- ピン留め済みノードの `(x, y)` はAuto-arrangeで**上書きされない**。ピン留めフラグ自体も変わらない
- ピン留めされていないノードの `(x, y)` のみ新座標に上書きされる
- Auto-arrange実行後は全ノードが Free モードの座標として扱われ、以降はユーザーが自由に調整できる

---

## B. モードバー

### Mode セグメント

5モードをボタンで切替。

| モード | Axisラベル |
|--------|----------|
| Free | （なし） |
| Time | X: story-time / Y: POV |
| Theme | Force-directed |
| POV | Cluster by POV |
| Place | Cluster by location |

### Show チェックボックス

表示するノード種別・エッジ種別を制御。全チェックでない場合、非表示ノードは**完全に隠す**（Timeline と異なり opacity 0.25 ではない）。Mapは散らかりやすいため、明示的に隠す方が実用的。

| チェック | 対象 |
|---------|------|
| Scenes | Sceneノード（`tree_nodes.node_type = 'scene'`） |
| Codex | Codexエントリノード（`codex_entries`） |
| Notes | Noteノード（`tree_nodes.node_type = 'note'`） |
| Derived edges | Codex親子・シーン言及から導出されるエッジ |
| User edges | `map_edges` に保存されたユーザー描画エッジ |
| Frames | `map_frames` に保存されたフレーム（Free モード時のみ有効。他モードでは常に非表示） |

### Scene display ドロップダウン

Sceneノードのバリアント（Compact / Card / Image）をボード全体（全シーン一括）で切り替える。個別ノード単位での切り替えは不可。詳細は「Scene ノード」および「Scene カード表示の詳細」セクション参照。

```
Scene display: [Card ▾]
  Compact
  ● Card
  Image (v2)
  ---
  Auto (follow mode)   ← モード連動デフォルトに戻す
```

- 初期値は「Auto (follow mode)」。現在のレイアウトモードに応じた既定バリアント（Free=Card、その他=Compact）が適用される
- ユーザーが明示的に選択すると、そのモードでの選択が記憶される
- 「Auto」に戻すとモード連動デフォルトに戻る

### Color by ドロップダウン

Sceneノードのボーダー色で意味付けする軸を選択。詳細は「Scene カード表示の詳細 > カラーコーディング」セクション参照。

```
Color by: [Status ▾]
  None
  ● Status
  POV character (v2)
  Tag (v2)
  Label (v2)
```

---

## C. キャンバスビューポート

### 無限キャンバス

- 論理座標空間: 無限（X/Y共にInt32の範囲）
- ズーム範囲: 10% 〜 400%
- 初期ビュー: 全ノードが収まる Fit to viewport

### 背景

- ドットグリッド背景（`Ctrl+G` でON/OFF）
- グリッド間隔: ズームレベルに応じて適応的（16px / 32px / 64px）
- スナップ: 設定 ON 時のみ、ドラッグ終了時にグリッドに吸着

---

## ノードタイプ

Mapに表示されるノードは4種類。それぞれ参照先のエンティティが異なる。

### Scene ノード

Sceneノードは3つの表示バリアントを持ち、ボード単位（全シーン一括）で切り替える。個別ノード単位ではない（Scrivenerのコルクボードと同じ思想）。

| バリアント | サイズ | 表示内容 | 主な用途 |
|----------|-------|---------|---------|
| **Compact** | 180×72 | ステータスドット・章番号・タイトル・文字数 | 重力場モード・高密度ビュー |
| **Card** | 260×180 | タイトル・章番号・ステータススタンプ・Synopsis・文字数 | Freeモード・コルクボード用途 |
| **Image** | 260×240 | Card + 上部画像エリア | v2拡張（シーンに画像紐付け機能が入ってから） |

#### Compact バリアント

```
┌─────────────────┐
│ ● Ch.1          │
│ 廃社            │
│ 1,120 chars     │
└─────────────────┘
```

#### Card バリアント

```
┌──────────────────────────────┐
│ 朝の市場           Ch.1 ●DR │  ← タイトル / 章番号 / ステータススタンプ
├──────────────────────────────┤
│                              │
│ エララが塔の麓に到着する。    │  ← Synopsis（カードの主役）
│ 門番が姿を消しており、不審に │    serif フォント、2サイズ大
│ 思いながらも中へ進む。        │
│                              │
├──────────────────────────────┤
│                    1,120字  │  ← 文字数フッター
└──────────────────────────────┘
```

詳細は「Scene カード表示の詳細」セクション参照。

#### モード連動のデフォルト

ボードのバリアント選択は「ボードの表示設定」だが、初期値は**現在のレイアウトモードに応じて自動選択**される。

| モード | デフォルトバリアント | 理由 |
|--------|------------------|------|
| Free | **Card** | コルクボード用途の主戦場。Synopsisが主役 |
| Time | Compact | 高密度の1Dタイムライン向き |
| Theme | Compact | Force-directed で大量ノードが散る |
| POV | Compact | クラスタ表示で密度が高い |
| Place | Compact | 同上 |

ユーザーが明示的にバリアントを切り替えた場合、その選択はモードごとに記憶される（`mapStore.sceneDisplayByMode: { free: 'card', time: 'compact', ... }`）。リセットは `⋮` メニューから可能。

#### 共通の動作

- 参照: `tree_nodes.id`（node_type = 'scene'）
- ダブルクリック（カード本体）: Editorで該当シーンを開く
- Card/Image バリアントではインライン編集が可能（後述）

### Codex ノード

```
┌─────────────────┐
│ ◯ Elara         │
│ character       │
│ 主人公、魔術師見  │
│ 習い             │
└─────────────────┘
```

- 参照: `codex_entries.id`
- 表示: タイプアイコン・name・タイプラベル・summary先頭40文字
- ダブルクリック: Codexパネルで該当エントリを開く
- サイズ: 固定（200×90px）
- アイコン画像あり: 左端に28×28pxで表示
- タイプ別の色: `codex_types.color` を左ボーダーに適用

### Note ノード

```
┌─────────────────┐
│ 📝 執筆メモ      │
│ ここで朱音の...  │
└─────────────────┘
```

- 参照: `tree_nodes.id`（node_type = 'note'）
- 表示: アイコン・タイトル・本文先頭40文字
- ダブルクリック: Editorで該当ノートを開く
- サイズ: 固定（180×72px）

### AI ノード（手動追加のみ）

```
┌─────────────────┐
│ ✨ AI           │
│ 封じ文の差出人   │
│ は誰か？候補3件  │
└─────────────────┘
```

- 参照: なし（Map専用の独立エンティティ）
- 表示: ✨アイコン・プロンプト要約・AI応答要約
- 保存先: `map_ai_nodes` テーブル（Map専用）
- ダブルクリック: Chatパネルに遷移し、該当セッションを開く（`session_id` 紐付け）。`session_id` が NULL（チャットセッション削除後）の場合はダブルクリック操作を無効化し、ツールチップで「チャットセッションが削除されました」と表示
- サイズ: 可変（内容に応じて120〜240px幅）
- 黄色ハイライト背景で視覚的に区別

**作成方法**:
- パレットの [+AI] ボタン → ダイアログでプロンプト入力 → AI応答生成（現在のMapの文脈＝表示中ノードをコンテキストとして注入）→ ノード化
- v1では手動作成のみ。自動提案は v2以降

---

## Scene カード表示の詳細

Card / Image バリアントでの追加仕様。Compact バリアントには適用されない。

### カード本体の構造

```
┌────────────────────────────────┐
│ タイトル             Ch.X ●ST │  ← ヘッダー行
├────────────────────────────────┤
│                                │
│ Synopsis本文（serif）           │  ← Synopsis領域
│ 最大4行、それ以降は省略         │
│                                │
├────────────────────────────────┤
│ N,NNN字 · [⏱1]         [Open↗]│  ← フッター
└────────────────────────────────┘
```

| 領域 | 内容 |
|------|------|
| ヘッダー | タイトル（インライン編集可）・章番号・ステータススタンプ |
| Synopsis領域 | `tree_nodes.synopsis` の内容。4行を超えると末尾 `…` で省略。ホバーでフル表示ツールチップ |
| フッター | 文字数・Phaseアンカー数（`⏱N`、あれば）・Open ボタン |

### ステータススタンプ

ステータスを視覚的に強調する2文字コード + ドット。Scenesパネルの左端ドットよりインパクトある表現（コルクボードの「スタンプ」感）。

| ステータス | コード | 色 |
|----------|------|-----|
| Outline | `OU` | `#888780`（グレー） |
| Draft | `DR` | `#EF9F27`（アンバー） |
| Complete | `CP` | `#1D9E75`（グリーン） |
| Revision | `RV` | `#7F77DD`（パープル） |
| Final | `FN` | `#22a06b` + `✓` アイコン |

コード + 色付きドットを右上に表示。クリックでステータス変更ポップオーバー（Scenesパネルのコンテキストメニューと同じ5択）。

### Synopsisが空の場合

プレースホルダーを薄いグレー斜体で表示：
```
What happens in this scene?
```

文言はScenesパネル / Editorヘッダー のSynopsis編集欄と統一。

### インライン編集

Card / Image バリアント時のみ有効。編集境界を明確にするため、領域ごとに操作を分ける。

| 領域 | シングルクリック | ダブルクリック |
|------|-------------|------------|
| ヘッダーのタイトル | ノード選択 | タイトル編集モード |
| Synopsis領域 | ノード選択 | Synopsis編集モード |
| フッターの文字数 | ノード選択 | （無反応） |
| フッターの `Open↗` | Editorで開く | — |
| カード外周（ヘッダー・フッター以外の縁） | ノード選択 | Editorで該当シーンを開く（現状のノードダブルクリック動作） |

#### Synopsis編集モード

Synopsis領域がインライン textarea に切り替わる。

- serif フォント維持（視覚的ジャンプを防ぐ）
- カード外クリック or `Escape` で確定離脱
- `Ctrl+Enter` で即時保存 + 離脱
- `Tab` でタイトル編集モードに遷移（`Shift+Tab` で逆順：タイトル→Synopsis）
- 保存はデバウンス2秒（Scenesパネル・Editorヘッダーと同じ挙動）
- 4行を超えても textarea 内ではスクロール可能（カードのサイズは伸びない、Card バリアントの固定サイズを維持）

#### タイトル編集モード

ヘッダーのタイトル部が inline input に切り替わる。`F2` ショートカットでも起動。

- `Enter` / フォーカス外しで確定
- `Escape` で取消
- `Tab` で Synopsis 編集モードに遷移（`Shift+Tab` で逆順）
- 空文字は許容せず、元のタイトルに戻る

### ホバーインジケーター

カードに hover すると、編集可能な箇所の脇に薄い鉛筆アイコン（`✎`）がフェードインする（500ms 遅延）。ユーザーが「どこを触ると編集できるか」を学習する手がかり。Scrivenerにはない補助だが、我々のUIは境界判定が多層なので明示する価値がある。

### コルクボード的な装飾（オプション）

`⋮` メニュー → Display → `☐ Corkboard feel` チェックを有効にすると：

- カードに微弱なランダム回転（`±0.5°`、シーンIDから決定的に計算）
- 背景にコルクボードテクスチャ（薄いベージュ、SVGパターン）

デフォルトはOFF。ビジュアル装飾であり機能には影響しない。Scrivener経験者のノスタルジア向けの遊び要素。

### カラーコーディング

カード（および Compact）のボーダー色を意味付きで変更できる。ボード単位で1つの軸を選択。

```
Color by: [None ▾]
  None
  Status
  POV character            ← v2
  Tag                       ← v2
  Label (manual)            ← v2
```

| 選択 | v1 | 動作 |
|------|-----|------|
| **None** | ✓ | ボーダー黒、背景白 |
| **Status** | ✓ | ボーダー色 = ステータス色（スタンプと冗長だが、Compactでもステータスが色で分かる） |
| **POV character** | v2 | `tree_nodes.pov_character_id` から自動生成色。キャラ変更で色が変わる |
| **Tag** | v2 | 先頭タグの色（タグにカラー属性がある場合のみ） |
| **Label (manual)** | v2 | プロジェクト定義のラベル（Scrivener流、`scene_labels` テーブル別途追加） |

v2 で追加される POV / Tag / Label には、それぞれ前提となるDBカラム・テーブル追加が必要。v1 では **None / Status** のみ。Label機能は重いので v2 中でも後半に回す。

---

## エッジ

### Derived edges（自動生成）

既存のリレーションから自動的に描画されるエッジ。ユーザーが明示的に作成するものではない。

| 出典 | 表示スタイル | 意味 |
|------|------------|------|
| `codex_entries.parent_id` | 実線・両端丸 | Codex親子関係 |
| シーン→Codex言及 | 点線・矢印なし | シーン本文にCodex名が出現 |
| `codex_entry_phases.anchor_node_id` | 波線 | PhaseアンカーがScene側 |
| `snippets.scene_id` | 薄い点線 | Snippetの元シーン |

- 大量に表示すると可読性が崩壊するため、デフォルトは **Derived edges ON**, **ただし親子関係のみ** の表示。詳細なエッジは設定で追加可能
- Derived edges は編集不可（ソースを変更しないと変わらない）

### User edges（ユーザー描画）

ユーザーが明示的に引いたエッジ。`map_edges` テーブルに保存。

| プロパティ | 詳細 |
|----------|------|
| from_node | 起点ノードの参照（polymorphic: scene / codex / note / ai） |
| to_node | 終点ノード |
| label | ラベル文字列（optional、例: 「師匠」「恋人」「影響」） |
| style | 線種（solid / dashed / dotted） |
| color | 色（hex） |
| direction | 方向（`none` / `forward` / `bidirectional`） |

**描画方法**:
- ノードのエッジ（端）をドラッグ → 別ノードにドロップ
- または `Alt/⌥` 押しながらノード→ノード
- 描画中は半透明プレビュー線を表示
- ドロップ時にラベル入力インライン（Escでキャンセル、空でラベルなし）

**編集**:
- エッジクリック → 選択状態（太線ハイライト）
- ダブルクリック → ラベル編集
- 右クリック → コンテキストメニュー（線種変更・色変更・削除）

---

## フレーム

フレームはノードをグループ化する矩形領域。Miro / FigJam の Frame と同じ概念。

### 構造

```
┌─ Part I plot ─────────────────────┐
│                                    │
│   ● Ch.1    ● Ch.2    ● Ch.3      │
│                                    │
│   ◯ Elara       ◯ Marcus          │
│                                    │
└────────────────────────────────────┘
```

- タイトル（上部ヘッダ）
- 背景色（薄いティント）
- ボーダー色
- ノードを含むかどうかは**位置の重なり**で判定（親子関係DBに持たない）

### 作成

- パレットの [+Frame] クリック → キャンバス上でドラッグして矩形を描画
- または空白エリアで `F` キー → ドラッグで矩形作成
- 作成後、タイトル入力インライン

### 操作

- ヘッダをドラッグ → フレーム本体 + **内包されるノード全て**が一緒に移動
- ボーダードラッグ → リサイズ（内包ノードは動かない、内包判定が再計算される）
- 右クリック → ラベル変更・色変更・削除（内包ノードは削除されない）

### 階層

v1では**入れ子不可**。フレーム同士の重なりは禁止（新規作成時にバリデーション）。

### 制限

- Derived edges はフレームを無視して直線で描画（フレームは純粋にビジュアルなグループ化）
- 重力場モードでは**Framesは無視される**（ノード配置は重力関数が決め、フレームは追従できない）
- 重力場モードではフレームのヘッダドラッグによる内包ノードの一括移動も**無効**（ノード座標は重力関数が管理するため）
- そのため**Framesが活きるのは Free モード**のみ。他モードでは**完全に非表示**になる。Free モードに戻ると位置・タイトル・内包ノードがそのまま復元される

---

## レイアウトモード詳細

### Free モード（手動配置）

- 各ノードは `map_node_positions.x, y` に保存された座標に配置
- ドラッグで自由に移動、位置はデバウンス500msで自動保存
- Undo/Redo対応（最大50件）
- グリッドスナップON時は16px単位に吸着

このモードだけが**フレーム・エッジ描画の意味を持つ**。

### Time モード

2D タイムライン:

| 軸 | 値 |
|----|---|
| X軸 | Scene: `story_time_order`（未設定時は `sort_order` によるDFS reading-order順）。Codex: アンカーされたPhaseの平均時間、またはX軸中央 |
| Y軸 | Scene: POVキャラクターごとの水平レーン。Codex: タイプ別のレーン（character / location / item / lore） |

- POVレーンが2つ以上のシーンで使われる場合のみ有効（単一POVの作品では Time モード = Timeline パネル相当）
- `tree_nodes.pov_character_id`（Phase C-2 で追加するカラム）が未実装の段階では、Y軸は全シーンで同一（1Dライン）

**story_time_order 未設定シーンの扱い**:
- `story_time_order=NULL` のシーンは X 軸右端に「Unscheduled」エリアとして分離して配置（Timeline パネルと同じ方針）
- Unscheduled エリアは X 軸の最大値より右にオフセットし、破線で区切って表示
- Codex は `story_time_order=NULL` でも影響なし（X軸中央に配置）

**Timelineパネルとの差異**: Timeline は単一レーン（純粋1D）、Map の Time モードは POV レーン分かれ（2D）。視点構造を持つ作品では Map の Time モードが有用。

### Theme モード

Force-directed レイアウト:

- **引力**: 共有タグが多い Scene-Scene / Scene-Codex / Codex-Codex ペアほど強く引き寄せ合う
- **斥力**: 全ノード間に弱い斥力（重なりを防ぐ）
- **中心引力**: 全ノードを中心に寄せる弱い力
- アルゴリズム: D3-force または Fruchterman-Reingold

**ユースケース**: 「このタグを持つノードがどこにクラスタしているか」を可視化。記憶テーマと喪失テーマが重なる部分が見える、など。

**制約**: 安定化までに数秒の計算時間がかかる可能性。ノード数100以上だと重くなるため、Webワーカーで計算しプログレス表示。

### POV モード

クラスタリングレイアウト:

- POVキャラクター（`tree_nodes.pov_character_id`）ごとに円形クラスタを配置
- クラスタ中心に該当Codexエントリノード、周囲にそのPOVのシーン群
- クラスタ同士の位置関係は、キャラクター間の共演頻度に基づき配置（共演多いキャラは近く）
- POV未設定のシーンは「Unassigned」クラスタに集約

**制約**: `pov_character_id` が未追加の段階（Phase C-2 前）では無効化（Grayout）。

### Place モード

同上、`location_id` ベースのクラスタリング:

- ロケーション（`tree_nodes.location_id`）ごとにクラスタ
- クラスタ中心にLocation Codexノード、周囲にそのロケーションのシーン

**将来拡張**: ユーザーが画像をアップロードして地図として背景に表示できる機能（「world map overlay」）。画像の上にLocation Codexをピン留めし、シーンが該当地理に配置される。地図背景は `projects.world_map_image` （v3以降）。

---

## ノードインタラクション

### クリック / ダブルクリック

| 操作 | 動作 |
|------|------|
| シングルクリック | 選択状態 |
| ダブルクリック（ノード外周） | 対応するエンティティを該当パネルで開く（Scene→Editor、Codex→Codex、Note→Editor、AI→Chat） |
| ダブルクリック（Sceneノード Card バリアントのSynopsis領域） | Synopsisインライン編集モード |
| ダブルクリック（Sceneノード Card バリアントのタイトル） | タイトルインライン編集モード |
| `Ctrl+クリック` | 個別トグル選択 |
| `Shift+クリック` | 選択セットへの追加/除外（トグル） |
| 空白ドラッグ | ラバーバンド選択（矩形内の全ノードを選択） |

Sceneノード内でのインライン編集の詳細は「Scene カード表示の詳細 > インライン編集」セクション参照。

### ドラッグ

| 操作 | 動作 |
|------|------|
| Free モードでドラッグ | 座標更新 → `map_node_positions` に保存 |
| 重力モード + ピンなしノードをドラッグ | 自動的にピン留めされる + 座標保存（Hybrid化） |
| 重力モード + ピン済みノードをドラッグ | 座標更新のみ |
| Shift+ドラッグ | 複数選択ノードを一緒に移動 |

### コンテキストメニュー

ノード右クリック:

| メニュー項目 | 動作 |
|-------------|------|
| Open | 対応するエンティティを開く |
| Open in side group | 新しいEditor Groupで開く |
| --- | |
| Pin position | 現在座標にピン留め（Hybrid化） |
| Unpin | ピン解除（重力場に戻る） |
| --- | |
| Connect to... | 次にクリックしたノードとUser edgeを作成 |
| Bring to front / Send to back | z-index変更。`Bring to front` は現在の最大 `z_index + 1`、`Send to back` は最小 `z_index - 1`（ただし `-1` 未満にはしない。`map_frames.z_index` のデフォルト `-1` と区別するため、ノードの最小は `0` を下限とする） |
| --- | |
| Hide on this board | このボードでのみ非表示化（`map_node_positions.hidden = 1`）。そのノードに接続する User edge はアプリ層でフィルタし非表示にする（CASCADE は発火しないため）。再表示は「Show on this board」で `hidden = 0` に戻り、エッジも再表示される |
| --- | |
| Focus | 選択ノード + 1次接続ノードのみ表示、他はopacity 0.15で非表示。1次接続 = User edge または Derived edge（Show設定の有無に関わらず）で直接繋がるノード。`Escape` またはコンテキストメニューの「Exit Focus」で解除 |

### ホバー

- ホバー500msでツールチップ表示（タイトル/name + synopsis/summary + type）
- 接続されているエッジがハイライト
- 接続先ノードも軽く強調

---

## パレット

キャンバス下部に固定配置される操作パレット。

```
┌─────────────────────────────────────────────────┐
│ [+Scene] [+Codex] [+Note] [+AI] [+Frame] │ [⌥Connect] │
└─────────────────────────────────────────────────┘
```

### [+Scene / +Codex / +Note]

クリック後、キャンバス上でクリックした位置に新規エンティティが作成される。

- Scene: 新規シーン作成ダイアログ（title入力のみ、後で編集）
- Codex: 新規Codex作成ダイアログ（name + type選択）
- Note: 新規ノート作成ダイアログ

作成されたエンティティは対応するDBテーブル（`tree_nodes` / `codex_entries`）に保存され、Map上に配置される。

### [+AI]

AIノード作成モードに入る。キャンバスクリックで位置確定 → プロンプト入力ダイアログ → AI応答生成 → ノード配置。**Phase D で実装**（それ以前はボタンが非活性表示）。

### [+Frame]

フレーム作成モード。ドラッグで矩形描画。

### [Alt/⌥Connect]

エッジ描画モード（`Alt/⌥` 押下でも同じ）。ノード→ノードで User edge 作成。

### パレットのフェーズ別提供状況

| ボタン | 実装フェーズ |
|--------|------------|
| [+Scene] [+Codex] | Phase A |
| [+Frame] [Alt/⌥Connect] | Phase B |
| [+Note] | Phase D |
| [+AI] | Phase D |

---

## ズーム・パン

| 操作 | 動作 |
|------|------|
| `Ctrl+ホイール` / ピンチ | ズーム（10%〜400%） |
| スペース+ドラッグ | パン |
| 中クリック+ドラッグ | パン |
| `Ctrl+0` | Fit to viewport |
| `Ctrl++` / `Ctrl+-` | 段階的ズーム |
| `Ctrl+1` | 100% |
| ミニマップ（右下） | 全体俯瞰、クリックでビューポート移動 |

### ミニマップ

`⋮` メニューでON/OFF。キャンバス右下に固定配置（120×80px）。

- 全ノードの縮小表示
- 現在のビューポートを矩形枠で表示
- クリック/ドラッグでビューポート移動

---

## 複数ボード対応（v2）

v1では**1プロジェクト = 1 Map ボード**に制限。v2で複数ボードに拡張予定。

### v2の構想

- `map_boards` テーブル: プロジェクトごとに複数ボードを持てる
- 各ボードで独立した Node positions / Edges / Frames
- ユースケース:
  - 「キャラクター関係図」ボード（Codexのみ表示）
  - 「地理マップ」ボード（Placeモード固定）
  - 「プロット全景」ボード（Scenesのみ表示）
- ヘッダーのボード切替ドロップダウンで切り替え
- ボードは複製・削除・名前変更可能

v1ではヘッダーに「Board: Main」と固定表示のみ。将来拡張の余地を残す。

---

## 検索

`🔍` ボタンまたは `Ctrl+F` で検索バーを展開。

- ノード種別ごとに以下を対象としてインクリメンタル検索:
  - **Sceneノード**: `title`（タイトル）+ `synopsis`（シーン要約）
  - **Codexノード**: `name`（エントリ名）+ `summary`（概要）+ タグ名
  - **Noteノード**: `title` + 本文先頭テキスト
  - **AIノード**: `prompt`（プロンプト要約）
- ヒットノードはキャンバス上で黄色ハイライト
- `Enter` でヒットノードにビューポート移動 + 選択
- `↑↓` で複数ヒット間の移動

---

## 状態管理

### Zustand ストア: `mapStore`

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `activeBoardId` | `string` | 現在のボードID（v1では固定値） |
| `mode` | `'free' \| 'time' \| 'theme' \| 'pov' \| 'place'` | 現在のレイアウトモード |
| `viewport` | `{ x, y, zoom }` | ビューポート状態 |
| `selectedNodeIds` | `Set<string>` | 選択中のノードID |
| `selectedEdgeIds` | `Set<string>` | 選択中のエッジID |
| `show` | `{ scenes, codex, notes, ai, derivedEdges, userEdges, frames }` | 表示チェックボックス状態 |
| `gridSnap` | `boolean` | グリッドスナップON/OFF |
| `minimapVisible` | `boolean` | ミニマップ表示。初期値 `false`（`⋮` メニューで明示的にONにするまで非表示） |
| `sceneDisplayByMode` | `Record<Mode, 'compact' \| 'card' \| 'image' \| 'auto'>` | モードごとのSceneバリアント選択。`'auto'` はモード連動デフォルトに従う。v1は単一ボードのためグローバル設定として保存。v2では `map_boards` テーブルに移行予定 |
| `colorBy` | `'none' \| 'status' \| 'pov' \| 'tag' \| 'label'` | カラーコーディング軸。v1 は `'none'` / `'status'` のみ |
| `corkboardFeel` | `boolean` | コルクボード装飾（微回転 + テクスチャ）ON/OFF。**v2 で `visualTheme: 'default' \| 'corkboard' \| 'constellation'` に昇格**（Constellationスキン追加時）。マイグレーション時は `true→'corkboard'` / `false→'default'` |

### 派生データ

- `visibleNodes(show, viewport)`: ビューポート内 + 表示設定でフィルタ後のノード
- `computedPositions(mode, pinnedPositions)`: 現在のモードでの各ノード位置（Freeは保存値、重力場は計算値）
- `derivedEdges`: 既存リレーションから導出されるエッジのメモ化
- `effectiveSceneVariant(mode)`: 現在のモードで実際に使われるSceneバリアント。`sceneDisplayByMode[mode]` が `'auto'` の場合は Free=`'card'` / その他=`'compact'` を返す

### 永続化

以下を `global-settings.json` の `map` セクションに保存:

- `mode`, `viewport`, `show`, `gridSnap`, `minimapVisible`
- `sceneDisplayByMode`, `colorBy`, `corkboardFeel`

**v1の設計判断**: `sceneDisplayByMode` / `colorBy` / `corkboardFeel` はボードの見た目設定だが、v1はボードが1つしかないため、クロスプロジェクト的なUI設定として `global-settings.json` に保存する。v2で複数ボードを導入する際には `map_boards` テーブルへの移行が必要。

`map_node_positions` / `map_edges` / `map_frames` はプロジェクトDBに保存（後述）。

---

## DBスキーマの追加

DBスキーマの正規版は統合DBスキーマ設計書（`Grimodex_統合DBスキーマ.md`）を参照。本設計書で追加が必要なテーブルを以下に記載。

### map_boards（v2準備、v1では単一行を自動作成）

```sql
CREATE TABLE map_boards (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Main',
  sort_order  REAL NOT NULL DEFAULT 0.0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_boards_project ON map_boards(project_id);
```

v1ではプロジェクト作成時に `title = 'Main'` のボードを1行自動作成し、以降追加させない。

### map_node_positions

ノードのボード上での位置情報。ポリモーフィック参照（Scene / Codex / Note / AI）。

```sql
CREATE TABLE map_node_positions (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  node_ref_type   TEXT NOT NULL
                    CHECK(node_ref_type IN ('scene', 'codex', 'note', 'ai')),
  tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  ai_node_id      TEXT REFERENCES map_ai_nodes(id) ON DELETE CASCADE,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,  -- 1 if pinned in gravity modes
  hidden          INTEGER NOT NULL DEFAULT 0,  -- 1 if hidden on this board
  z_index         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1段目: 3つのFKのうちちょうど1つが non-null
  CHECK (
    (CASE WHEN tree_node_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN ai_node_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  -- 2段目: node_ref_type と non-null FK カラムの対応を保証
  -- (scene/note → tree_node_id、codex → codex_entry_id、ai → ai_node_id)
  CHECK (
    (node_ref_type IN ('scene', 'note') AND tree_node_id   IS NOT NULL AND codex_entry_id IS NULL     AND ai_node_id IS NULL) OR
    (node_ref_type = 'codex'            AND codex_entry_id IS NOT NULL AND tree_node_id   IS NULL     AND ai_node_id IS NULL) OR
    (node_ref_type = 'ai'               AND ai_node_id     IS NOT NULL AND tree_node_id   IS NULL AND codex_entry_id IS NULL)
  )
);

CREATE INDEX idx_map_pos_board ON map_node_positions(board_id);
CREATE INDEX idx_map_pos_tree ON map_node_positions(tree_node_id);
CREATE INDEX idx_map_pos_codex ON map_node_positions(codex_entry_id);
-- SQLite の NULL 意味論: NULLを含む複合UNIQUE INDEXでは一意性が保証されないため、
-- ノードタイプ別に部分インデックスで分割する
CREATE UNIQUE INDEX idx_map_pos_uniq_scene ON map_node_positions(board_id, tree_node_id)
  WHERE tree_node_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_codex ON map_node_positions(board_id, codex_entry_id)
  WHERE codex_entry_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_ai    ON map_node_positions(board_id, ai_node_id)
  WHERE ai_node_id IS NOT NULL;
```

**設計判断**:
- ポリモーフィック参照を採用。3つのFKカラムのうち1つのみnon-null（CHECK制約）
- インデックスはそれぞれの参照先で張る（逆引き対応）
- `node_ref_type` を冗長に持つのは、フィルタクエリの簡略化のため
- UNIQUE制約はノードタイプ別の**部分インデックス**で実現（SQLiteのNULL=NULLではない意味論のため、NULLを含む複合UNIQUE INDEXでは一意性が保証されない）
- CHECK制約は2段構え: ①exactly-one-non-null検証 + ②`node_ref_type`とFK列の対応検証
- ただし `node_ref_type` が `'scene'` または `'note'` のとき `tree_node_id` が指す `tree_nodes.node_type` の整合性（scene行かnote行か）は SQLite CHECK では検証不可能なため、**アプリ層のバリデーションで担保する**

### map_edges

ユーザー描画エッジ。

```sql
CREATE TABLE map_edges (
  id                  TEXT PRIMARY KEY,
  board_id            TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  from_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  to_position_id      TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  label               TEXT,
  style               TEXT NOT NULL DEFAULT 'solid'
                        CHECK(style IN ('solid', 'dashed', 'dotted')),
  color               TEXT NOT NULL DEFAULT '#000000',
  direction           TEXT NOT NULL DEFAULT 'none'
                        CHECK(direction IN ('none', 'forward', 'bidirectional')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_edges_board ON map_edges(board_id);
CREATE INDEX idx_map_edges_from ON map_edges(from_position_id);
CREATE INDEX idx_map_edges_to ON map_edges(to_position_id);
```

**設計判断**:
- エッジの参照先は `map_node_positions.id`（ノード直接参照ではなく位置レコード経由）。ボードを跨いだエッジを禁止するため
- ノードが非表示・削除された場合にエッジも自動削除（CASCADE）

### map_frames

フレーム。

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

- ノードの内包判定は**位置の重なり**のみ。DB上の親子関係は持たない
- フレームのヘッダドラッグ時、内包判定されているノードが一緒に移動する動作はアプリ層で実装

### map_ai_nodes

Map専用のAIノード。

```sql
CREATE TABLE map_ai_nodes (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL,
  response      TEXT,
  session_id    TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  model         TEXT,
  token_usage   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_ai_board ON map_ai_nodes(board_id);
```

- `session_id` が付与される場合は Chatパネルのセッションとリンク
- `response` は要約版。フル会話は Chatパネルで参照

---

## 他パネルとの連携

### → Editor

- Sceneノード / Noteノードをダブルクリック → Editorで固定タブとして開く
- Codexノードをダブルクリック → Codexパネルで該当エントリを表示（Editor側ではなくCodex側）
- Map上で新規Scene作成 → 作成直後にEditorで開く動線をオプションで提供（設定）

### → Codex

- Codexノードをダブルクリック → Codexパネルの詳細画面
- Codexエントリのtype変更 / 削除 → Map上のノード表示が即時更新
- Codex Phase の anchor_node_id が設定 → Derived edge として Scene と Codex を繋ぐ波線が追加

### → Scenes

- Mapで選択したSceneノードは、Scenesパネルのツリーでも選択状態で連動（`activeSceneSync`）
- Scenesパネルでのツリー D&D → reading-order 変更 → Map の Time モード（reading-order フォールバック）で位置更新

### → Timeline

- Map の Time モードは、Timeline パネルの2D拡張版に相当
- Timeline で story_time_order を編集 → Map の Time モードの X軸が再計算
- Map から「Open in Timeline」リンク（ボード単位のビューポートを Timeline に展開）

### → Chat

- AIノードのダブルクリック → Chatパネルで該当セッションを開く
- Chat の「Attach context」で現在のMapボードを添付可能（v2）

### ← Chat / Codex （Derived edges として）

Codex parent-child、Scene-Codex言及、Phase anchor、Snippet origin などが自動的に Derived edges として描画される。Codex / Chat / Scenes 側でこれらを変更すると、Map の Derived edges がリアクティブに更新される。

---

## キーボードショートカット

### アプリレベル

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+M` | Mapパネルのフォーカス/トグル |

### Mapパネルフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `1` / `2` / `3` / `4` / `5` | モード切替（Free / Time / Theme / POV / Place） |
| `Ctrl+F` | 検索バーにフォーカス |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | ズームイン / アウト / Fit |
| `Ctrl+1` | ズーム 100% |
| `Space+ドラッグ` | パン |
| `F` | Frameを作成モード |
| `Alt/⌥` 押下 / `E` | Connectモード（エッジ描画） |
| `Del` / `Backspace` | 選択中のノード / エッジ / フレームを削除 |
| `Ctrl+A` | 全ノード選択 |
| `Ctrl+D` | 選択ノードをDuplicate。**参照先エンティティをDBレベルで複製**（新規 Scene / Codex / Note として作成）し、複製ノードをビューポート内にオフセット配置する。複製後の行は Scenes / Codex パネルにも反映される。AIノードは複製不可 |
| `Ctrl+G` | グリッドスナップ ON/OFF |
| `F2` | 選択ノードの名前をインライン編集（参照先エンティティの名前変更） |
| `Enter` | Sceneノード Card バリアント時: Synopsisインライン編集モード。それ以外: Editorで開く |
| `Ctrl+P` | 選択ノードをピン留めトグル |
| `Escape` | インライン編集離脱 / 選択解除 / モードキャンセル / Focusモード解除（優先順で最初に該当するものを実行） |

### ノード削除の挙動

Mapでノードを削除すると:
- **Scene/Note/Codex ノード**: 確認ダイアログ「Mapから隠す」「エンティティごと削除」の2択
  - 「隠す」: `map_node_positions.hidden = 1` にする（エンティティは残る）。再表示は `⋮` メニュー → Display → 「☑ 非表示ノードを表示」でグレー表示 → 右クリック → 「Show on this board」
  - 「削除」: 参照先エンティティをDB削除（Scenes/Codex側と同じフロー）
- **AI ノード**: 即削除（Map専用エンティティなので）
- **User edge**: 即削除
- **Frame**: 即削除（内包ノードは残る）

**複数選択での Delete 挙動**:
- 選択ノードにScene/Note/Codexが含まれる場合、1つの確認ダイアログをまとめて表示（「N件を隠す」「N件を削除」）。種別が混在していても一括で同じ操作を適用する
- AI ノード・User edge・Frame が混在する場合は、種別ごとにグループ分けして処理順（Frame・edge → AI → Scene/Note/Codex の順）を保つ
- 選択セット全体が AI / edge / Frame のみの場合は確認ダイアログなし即削除

---

## レスポンシブ動作

### 幅に応じたモードバーの折りたたみ

| パネル幅 | モードバー | ヘッダーモードドロップダウン |
|---------|-----------|--------------------------|
| ≥ 600px | 表示（5ボタン全部） | 非表示（冗長なため） |
| < 600px | 非表示 | 表示（現在モードをドロップダウンで選択） |

ヘッダーのモードドロップダウンはモードバーが表示されているときも同期しているが、幅 ≥ 600px では `display: none` にして重複表示を避ける。

### 高さ ≥ 500px（フローティング・Centerスプリット）

全機能フルセット。パレット・ミニマップ・インスペクター全て表示可能。

### 高さ 300〜499px（通常のBottom Dock）

- パレットはコンパクトモード（アイコンのみ）
- ミニマップは初期OFF
- インスペクターは別パネルとして表示するか、ポップオーバー化

### 高さ < 300px

- 「Map は小さい画面ではあまり使えません」ヒント表示 + 「フローティングで開く」ボタン
- 操作は最低限可能だが、快適とは言えない

---

## 実装ライブラリ候補

### キャンバス描画

| 候補 | 判定 | 理由 |
|------|------|------|
| **React Flow** | **第一候補** | ノード・エッジ・ズーム・パン・ミニマップ・D&Dを網羅、Reactネイティブ |
| **tldraw** | 第二候補 | より高機能（フリーハンド描画・付箋・図形）だが大きすぎる |
| 自前実装（SVG + Canvas） | 不採用 | パン/ズーム/エッジルーティングの実装コストが高い |
| **D3** | 部分採用 | Force-directedレイアウトのみ `d3-force` を利用 |

**React Flow** を採用し、独自ノードタイプ（SceneNode / CodexNode / NoteNode / AINode）とフレームカスタムコンポーネントを実装する方針。

### Force-directed レイアウト

- `d3-force` を Web Worker で実行（メインスレッドをブロックしない）
- Theme モードで使用
- 100ノード以内は即時収束、それ以上はプログレス表示

### ドラッグ

- React Flow 内蔵のドラッグハンドラを使用
- Scenesパネルで使用中の `@dnd-kit` とは独立（キャンバスドラッグは座標系が異なるため）

---

## 実装フェーズ

### Phase A: 最小動作

- `map_boards` / `map_node_positions` テーブル追加（単一ボード固定）
- Free モードのみ実装
- Scene / Codex ノード表示（Note / AIは後回し）
- **Sceneノード Compact バリアントのみ**
- ノードドラッグ・座標保存
- ズーム・パン
- Derived edges: Codex parent-child のみ
- パレット（+Scene / +Codex のみ）
- ダブルクリックで Editor / Codex 連携

### Phase B: 関係性の可視化 + Cardバリアント

- Derived edges 全種（シーン言及 / Phase anchor / Snippet origin）
- User edges の描画・編集・削除
- Frames の作成・移動・リサイズ
- 検索バー
- ミニマップ
- **Sceneノード Card バリアント + インライン Synopsis / タイトル編集**
- **Color by (None / Status)**
- **Corkboard feel 装飾**
- **Scene display ドロップダウン（モード連動 Auto 挙動）**
- **Show チェックボックスの全項目をUIに追加**（Notes / AI チェックボックスは Phase D までグレーアウト表示し、ホバーで「Phase D で対応予定」ツールチップを出す。チェックボックス自体は操作不可にし、誤解を防ぐ）

### Phase C-1: Time モード + Hybrid 挙動

**前提条件**: なし（`story_time_order` は既存カラム）

- Time モード（X軸=`story_time_order`、Y軸=暫定1Dライン）
- Unscheduled エリア（`story_time_order=NULL` シーンを右端に分離）
- Hybrid 挙動（Pin/Unpin）
- モード切替時の 300ms トランジション
- Auto-arrange アクション: **Grid by reading-order** / **Grid by story-time**

### Phase C-2: Theme モード + POV/Place モード

**前提条件（DB マイグレーション）**:

`tree_nodes` に以下の2カラムを追加するマイグレーションを先行適用すること:

```sql
ALTER TABLE tree_nodes ADD COLUMN
  pov_character_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL;
  -- Sceneのみ使用。codex_entries.type='character' であることはアプリ層で保証

ALTER TABLE tree_nodes ADD COLUMN
  location_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL;
  -- Sceneのみ使用。codex_entries.type='location' であることはアプリ層で保証

CREATE INDEX idx_tree_pov ON tree_nodes(project_id, pov_character_id)
  WHERE pov_character_id IS NOT NULL;
CREATE INDEX idx_tree_location ON tree_nodes(project_id, location_id)
  WHERE location_id IS NOT NULL;
```

統合DBスキーマ（`Grimodex_統合DBスキーマ.md`）への反映も同時に行う。

- Theme モード（d3-force + Web Worker）
- POV モード（`pov_character_id` ベースのクラスタリング）
- Place モード（`location_id` ベースのクラスタリング）
- Time モードのY軸をPOVレーン化（`pov_character_id` が使えるようになってから）
- Auto-arrange アクション: **Grid by POV** / **Force-directed compact**

### Phase D: 高度な機能

- Note ノード表示
- AI ノード（手動追加 + Chat連携）
- Focusモード（選択ノード + 1次接続のみ表示）
- SVG / PNG エクスポート

### Phase E: 拡張（v2以降）

- 複数ボード対応
- ボード間ノード参照（1つのCodexエントリが複数ボードに配置）
- World map overlay（画像背景）
- **Constellation visual theme（星図スキン、後述「Visual Theme: Constellation スキン」セクション参照）**
- 共同編集（マルチユーザー、将来の大きな拡張）

---

## Visual Theme: Constellation スキン（v2拡張）

Mapパネルのビジュアルを「夜空の星図」に置き換える代替スキン。**機能・DBスキーマ・操作体系には一切手を入れず、レンダリング層だけを差し替える。** Themeモード・POVモードの重力場クラスタが既に「星座」のような配置を作るため、別パネル化する代わりに Map のスキンとして統合する方針。

### 目的

- **執筆者のモチベーション補助**: プロジェクトの全景を"機能的なダイアグラム"ではなく"詩的な地図"として見せ、長期プロジェクトでの俯瞰感・愛着を育てる
- **エクスポート素材としての魅力**: SVG / PNG 出力時にポスター品質の「物語の星図（Starchart）」が得られる。SNS 投稿・作家の自己モチベーション・表紙原案などに転用可能
- **既存機能を壊さない**: 表示スキンであり、DB追加なし・状態管理は既存ストアを流用

### 有効化

`⋮` メニュー → Display → **Visual theme** の3択に統合する（v1 の `Corkboard feel` チェックボックスを置き換え）:

```
Visual theme
  ● Default           （通常）
  ○ Corkboard feel    （微回転 + テクスチャ背景）
  ○ Constellation     （星図）
```

既存の `mapStore.corkboardFeel: boolean` を **`mapStore.visualTheme: 'default' | 'corkboard' | 'constellation'`** の enum に置き換える（v2 マイグレーション：`corkboardFeel === true` → `'corkboard'`、`false` → `'default'`）。3つは排他。

### メタファー対応表

| Mapの概念 | Constellation表現 |
|----------|------------------|
| 背景 | 濃紺〜黒のグラデーション + 微細なスターフィールドノイズ（Canvas層でプロシージャル生成） |
| Sceneノード | ★ 星（ステータスに応じて輝度変化） |
| Codex character | ◎ 恒星。名前に小さくギリシャ文字ラベル（例：「Elara β」） |
| Codex location | ● 惑星（塗りの大きめ円、type色を低彩度化） |
| Codex item | ✦ 小さな輝点 |
| Codex lore | 星雲（ソフトなグロー、塗りなし輪郭なし） |
| Noteノード | ◌ 微弱な点（0.35 opacity） |
| AIノード | 💫 彗星（尾を引くSVG gradient、常時緩やかにドリフト） |
| Derived edge | 細い破線（白、opacity 0.2〜0.3）— 星座の補助線 |
| User edge | 連星線（太め・白に近い色・両端にドット） |
| Frame | 星雲状領域（ソフトグラデ境界、タイトルは筆記体フォント） |
| ホバー | 該当の星が一瞬きらめく（opacity 0.7→1.0 の pulse） |
| 選択 | Halo リング（放射状の淡い光） |
| Focusモード | 非Focusノードは 0.08 opacity まで落とす（Default スキンの 0.15 より暗く、夜空感を強める） |

### ステータス → 輝度マッピング

| status | 表現 |
|--------|-----|
| Outline | 小さく淡い星（opacity 0.4、サイズ 0.8x） |
| Draft | 中輝度（opacity 0.7） |
| Complete | 明るく、淡い放射グロー |
| Revision | パープル tint で脈動（5秒周期） |
| Final | 最大輝度 + 放射状のグロー + 微小なレンズフレア風のキラキラ |

### アニメーション

- **Twinkle**: 全Sceneノードに独立した `@keyframes` で opacity を 0.7→1.0 に 3〜5秒周期で揺らす。遅延はノードIDのハッシュ値から決定的に計算（ボードを開き直しても配置が同じに見える）
- **Comet drift**: AIノードは常時 ±2px の範囲で 10秒周期のゆるやかな parallax ドリフト。尾は進行方向と逆向きにSVG linear-gradient で描画
- **Selection halo**: 選択時にノード周囲 80px まで広がる淡い光、2秒周期で 0.6→0.9 opacity 揺らぎ
- `prefers-reduced-motion: reduce` 検出時は全アニメーションを停止し、すべて静止した状態で描画

### スキン適用時の制約

| 項目 | 挙動 |
|------|------|
| **Scene display = Card / Image** | Constellation適用時はCompactに強制切替。Scene display ドロップダウンはグレーアウトし、ホバーで「Constellation skin uses Compact nodes」ツールチップ表示。スキン解除で元の選択に復帰 |
| **Corkboard feel** | `visualTheme` enum で排他。UIでは3択ラジオのため、選択不能状態は自然に表現される |
| **Color by = Status** | 有効のまま動作するが、"輝度 = ステータス"の表現と重なる。Constellationスキン適用時のデフォルトは `None` に自動切替（ユーザーが明示的にStatus等を選んだ場合はそれを尊重） |
| **Color by = POV / Tag / Label**（v2） | 彩度を一段下げて、夜空のコントラストを保つ |
| **グリッドスナップ** | 表示はOFFになる（グリッドドットを描画しない）。機能としては有効で、スナップ挙動は維持 |
| **ミニマップ** | 同じスキンが適用される（夜空の小型俯瞰図） |

### エクスポート: Starchart プリセット

`⋮` メニュー → Export に専用プリセットを追加:

```
Export
  SVG / PNG として保存
  JSONとしてエクスポート
  ---
  ✨ Starchart として保存
     （Constellationスキン強制 / 解像度選択 / 透明背景オプション）
```

- 現在の `visualTheme` が何であれ、**エクスポート時のみ一時的に Constellation を適用**してレンダリング → 保存後に元スキンに戻す
- 解像度オプション: **1x / 2x / 4x**（PNGのみ、SVGは解像度非依存）
- **透明背景オプション**: 夜空の背景を透過にして、ユーザーが別の背景（本の表紙画像など）に重ねられるようにする
- フレーム・タイトルラベルをエクスポートに含めるかのトグル（星図単体で書き出したい場合の配慮）

### 実装アプローチ

- ライブラリ追加なし（既存の React Flow + `d3-force` + SVG で完結）
- **代替ノードコンポーネント**: `ConstellationSceneNode` / `ConstellationCodexNode` / `ConstellationAINode` などを React Flow に登録し、`visualTheme` に応じて `nodeTypes` プロパティを切り替える
- **背景の星空**: React Flow の pane 背後に `<canvas>` レイヤーを重ね、プロシージャル生成の恒星（ノード数に依存しない純粋な装飾）を描画。パン/ズームに合わせて parallax スクロール
- **エッジのスタイル**: React Flow の `edgeTypes` で Constellation 用のカスタム edge を差し込み、CSS filter で glow を適用
- **CSS テーマレイヤー**: `data-visual-theme="constellation"` を Map ルートに付与し、CSS変数（`--node-bg`, `--edge-color`, etc.）を一括で上書き

### 実装フェーズ

**Phase E**（v2以降の拡張）扱い。コア機能（Phase A〜D）が安定してから着手する。優先度は「複数ボード対応」「World map overlay」より低く、novelty / ブランディング要素として位置づける。

### なぜラディカル案02の「独立パネル化」を取り下げたか

当初のラディカルUI案02「Constellation」は、Mapとは別の独立パネルとして構想されていた。しかし、Map パネルの重力場モード（特に Theme / POV）が既に「クラスタ状に配置されたノード群」を表示できるため、**別パネル化するより Map のビジュアルスキンに統合する方が**:

- 実装コストが低い（DB追加なし、状態管理共有、操作体系の再発明なし）
- ユーザーの学習コストが低い（新パネルの操作を覚える必要がない）
- エクスポート時に好きなスキンを選べるため、用途が広がる（Default で構造把握 → Constellation でポスター出力、の往復が自然）

従って、ラディカル案02は**独立パネル化を取り下げ、`mapStore.visualTheme = 'constellation'` として Map に統合**する。

---

## 未解決の検討事項

### 1. Derived edges の可読性問題

500シーン × 20Codex = 万単位のDerived edgeが描画される可能性。対策案:

- **Edge bundling**: 近い経路のエッジを束ねて描画（d3-hierarchy の edge bundling）
- **距離ベース非表示**: ビューポート外のエッジは描画しない
- **種別フィルタ**: Derived edges を種類別（親子のみ / 言及のみ / Phase のみ）でさらに細分化
- **閾値制限**: ノード数が 200 を超えたら Derived edges は自動OFF

MVPでは**種別フィルタ + 閾値制限**の組み合わせで対応。

### 2. 位置情報の肥大化

全シーン + 全Codex × ボード数の `map_node_positions` 行が発生。500 + 300 = 800 ノード × 5ボード（v2）= 4,000行。SQLiteのサイズには影響ないが、ビュー切替時の全読み込みは速度に注意。

対策: ビューポート可視範囲のみ LAZY LOAD、モード切替時は差分更新。

### 3. ノードの「初回配置」問題

新規Scene / Codex を追加した時、Map 上のどこに配置するか？

- 案A: 原点 (0, 0) 固定 → 重なり問題
- 案B: ビューポート中央 + ランダムオフセット → 現状の Map を見ていなくても追加される
- 案C: 直近の兄弟ノードの隣 → ツリー構造の近いものを参照
- 案D: 重力場モードで自動計算した位置 → 一度モード切替する必要あり

**採用（フェーズ別の二段構え）**:

- **Phase A〜B（Theme モード未実装）**: 案Bを採用。新規ノードは「現在のビューポート中央 + `(index * 24px, index * 24px)` のオフセット」（`index` = その操作で追加された順番、リセットはビューポート移動後）で配置し、`pinned=false` として保存。重なりを完全には防げないが許容範囲とし、ユーザーがドラッグで調整できる。
- **Phase C-2以降（Theme モード実装後）**: ユーザーが初めて Theme モードに切り替えたとき、`pinned=false` の全ノードに対して force layout を一括計算し、その結果を `x, y` に書き戻す。以降の新規追加ノードは「既存ノードと重ならない位置にスポーン（force simulation を1ステップだけ実行）」してから `pinned=false` で保存する。

### 4. フレームの内包判定のエッジケース

フレームが**部分的に**ノードと重なっている場合、内包扱いするか？

- 案A: ノードの中心がフレーム内 → 内包
- 案B: ノードの全矩形がフレーム内 → 内包
- 案C: ユーザー明示（D&Dでフレーム内にドロップ）

**採用**: 案A（中心判定）。ユーザーの直感に最も近い。

### 5. 大きな作品での性能

1000ノード級の作品で React Flow がどこまでスムーズに動くか未検証。

- React Flow は仮想化（virtualization）対応あり、ビューポート外ノードは描画しない
- ただし Derived edges の計算は全ノード対象のため、こちらがボトルネック
- ベンチマーク実装後に判断、必要なら Canvas（raw）ベースに切替

### 6. 重力モードでの「ノードが散らばる」問題

Theme モードで共有タグがないノードは中心引力だけで引き寄せられるため、中心部に団子になる。対策:

- 孤立ノード（共有タグなし）を外周にレイアウト
- 「Gravity strength」スライダーで引力/斥力のバランスをユーザーが調整

v1 では固定値、v2 で調整UI追加。

### 7. Map と Outline / Constellation（ラディカル案）の関係

ラディカルUI案02「Constellation」は当初独立パネルとして構想されていたが、Map パネルの重力場モードと機能的に重複するため、**Mapのビジュアルスキンとして統合**する方針に変更した。詳細仕様は「Visual Theme: Constellation スキン（v2拡張）」セクション参照。

### 8. Card バリアントと重力場モードの相性

重力モードではノード座標が関数で決まるため、Cardの大きなサイズ（260×180）は密度を下げる。対策:

- モード連動デフォルトで Free=Card / その他=Compact を採用済み（B案）
- ユーザーが明示的に「重力モードでもCardを使いたい」と切り替えた場合、force layout のパラメータ（ノード間距離・斥力）を Card サイズに合わせて自動調整
- それでもPOV/Theme モードで数百ノードをCardで表示するとスクロール量が膨大になる。高密度ビューが必要なユーザーには Compact への切替を提案するヒントを表示

### 9. ラベル（Label）機能の導入タイミング

Scrivener のラベル機能（プロジェクト固有のカラーラベルをSceneに付与）は v2 で導入予定だが、Codex Tags との重複が懸念。

- 案A: 専用の `scene_labels` テーブルを追加（Scrivener互換）
- 案B: `codex_tags` を流用（タグにカラーを持たせ、Sceneに直接タグ付与可能にする）
- 案C: 既存の `codex_entries`（`character` や `lore` タイプのエントリ）をラベル代替として使う

案Bが一番データモデルを汚さない。Snippetsが既に `codex_tags` を共有しているので、Sceneも同じ仕組みに乗せるのは筋が良い。v2 で検討する際はタグ側の設計から詰める。

### 10. コルクボード装飾の国際化問題

`Corkboard feel` の微回転装飾は、長い日本語タイトルでは視認性が落ちる可能性。回転角の上限を言語に応じて調整するか、日本語環境ではデフォルトOFFにするか、v1 実装時にユーザーテストで判断。

---

## Matrix パネル連携

Matrix パネル（[設計書](./Grimodex_Matrixパネル設計書.md)）は Map と同じ「2次元」だが用途が異なる：

- **Map**: 連続座標、関係の発見・クラスタリング、**探索的**
- **Matrix**: 離散カテゴリのクロス表、登場分布の可視化、**監査的**

両者は別パネルとして共存する。

### 言及スキャン結果のキャッシュ共有

Matrix Phase A で新規追加される `scene_codex_mentions` キャッシュテーブルは、Codex 名/alias 変更時のキャッシュ再構築を Map と Matrix で共通化できる。Map 側は v1 では現行のメモリ計算のままで、キャッシュテーブルの利用は v2 以降の最適化として検討する（必要性が確認されてから）。それまでは「同じ Rust Aho-Corasick マッチャーを呼ぶ」という共通点だけを保ち、データ層の共有は強制しない。

### Matrix への Show in Matrix 動線（v2）

Map のシーンノード右クリック → 「Show in Matrix」で、Matrix が該当シーン行にスクロールする動線を v2 で追加検討。フィルタ状態は v1 では独立管理（Map と Matrix のフィルタ「同期」トグルは v2 で検討）。
