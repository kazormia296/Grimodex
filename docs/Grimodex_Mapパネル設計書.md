# Grimodex Mapパネル設計書

## 概要

Map パネルはプロジェクトの**マインドマップ用ボード**。**未確定のアイデアを発散して、価値あるものを構造化する**ための作業場であり、確定したカード並べ（Grid）や時間軸俯瞰（Timeline）とは役割が違う。

Map は**全エンティティを自動でぶちまけない**。空のボードから始まり、ユーザーが必要に応じて Sticky（Map 専用付箋）を撒く・既存の Codex/Scene/Note を**手動で呼び寄せる**ことで、その時点で考えたい関係だけが盤に乗る。1 プロジェクトに**複数ボード**を持てるため、「人物関係図」「Part 1 のプロット盤」「世界の地理」のように目的別に切り分ける。

Map のコア体験は「**Sticky で発散 → Frame でまとめる → 価値あるものを Codex/Scene/Note へ昇格**」というフロー。これは Grimodex のコア思想（Chat から知識を抽出して構造化する）の Map 版に当たる。

デフォルト位置: Bottom Dock（非表示）。大画面ではフローティングウィンドウや Center スプリットで運用するのが理想。

設計思想: **Map は探索の盤。既存エンティティの整理だけでなく、未構造の思考を撒いて育てて、価値が見えたら構造化する。**

### 他パネルとの役割分担

| パネル | 扱うもの | 主用途 |
|--------|---------|--------|
| Scenes | ツリー構造（1次元・reading-order） | 構造管理・読者順の編集 |
| Grid | Chapter 列 × Scene カード（密な情報） | 確定したカードの並べ・章単位の俯瞰 |
| Timeline | 時間軸（1次元・story / reading / write） | 時系列俯瞰・story-time 編集 |
| Matrix | Scene × Codex のクロス表 | 登場分布の監査 |
| **Map** | **任意のノードを 2D 空間に置く** | **発散 → 関係描き → 構造化** |

Grid との違いは決定的に重要：**Grid は確定したシーンを密に俯瞰する盤**（Beat / POV / Codex / Label / Foreshadow を全部出す）。**Map は思考の枝を生やす盤**で、ノードは軽量・関係描画とグルーピングが主役。Map 上のシーンノードは Grid のサブセットでも上位互換でもなく、**意図的に簡素**にしてある。

---

## パネル構造

```
┌───────────────────────────────────────────────────────────────┐
│ A. ヘッダー                                                    │
│ Map  [Board: 人物関係図 ▼ +] [Free ▼] [🔍] [⋮]                │
├───────────────────────────────────────────────────────────────┤
│ B. モードバー                                                   │
│ Mode: [Free] [Theme]                                          │
│ Show: ☑Scenes ☑Codex ☑Snippets ☑Notes ☑Stickies ☑Frames      │
│       ☑Derived edges ☐User edges                              │
├───────────────────────────────────────────────────────────────┤
│ C. キャンバスビューポート（無限・スクロール・ズーム可能）          │
│                                                                │
│  ┌─ Frame: 主要キャラ ────────────────┐                       │
│  │   ◯ Elara ─── ◯ Marcus            │                       │
│  │     │ 師匠/弟子   │                │                       │
│  │   📌 「魔術の才能をどこで知る？」   │  ← Sticky（黄）         │
│  └────────────────────────────────────┘                       │
│                                                                │
│  📌 「序盤に伏線」  📌 封じ文の起源は？                         │
│                                                                │
│  ✦ AI Branch: Elara の動機（5 件の種）                         │
│   └─ 📌 復讐  📌 探索  📌 義務  📌 偶然  📌 逃避               │
│                                                                │
│  ┌─ Palette ──────────────────────────────┐  [Zoom: 100%]     │
│  │ [+Sticky] [+Frame] [⌥Connect] │ ▾Add… │                   │
│  └─────────────────────────────────────────┘                  │
└───────────────────────────────────────────────────────────────┘
```

---

## レイアウトモード

5 モード（旧設計）から **2 モード**に絞る。Time / POV / Place は Timeline・Codex 章別フィルタとの責務重複が大きく、Map の本質から外れるため削除。

| モード | 座標決定 | 用途 |
|--------|---------|------|
| **Free** | ユーザー手動ドラッグ（デフォルト） | プロッティング・関係描き・ブレインストーミング |
| **Theme** | Force-directed（共有タグ・User edge で引力） | テーマ・モチーフのクラスタ可視化 |

### Hybrid 挙動（Theme モード時）

- Theme モード時、ノード右クリック → 「Pin position」で個別ピン留め
- ピン留めされたノードは Free モードで設定した `(x, y)` を保持
- 残りのノードは force layout で自動配置
- 「これが骨格」と思うノードだけ固定し、残りは重力場に任せる使い方

### モード切替の振る舞い

- モード切替時はトランジションアニメーション（300ms）
- Theme モードへの切替は 2 段階: ① Web Worker で force layout 計算 → ② 300ms トランジションで最終座標へ
- Free モードに戻ると、最後に手動配置した位置に復元

---

## A. ヘッダー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Map」。左寄せ |
| **ボード切替ドロップダウン** | 現在のボード名を表示。クリックで全ボード一覧 + `+ New board` + 各ボードのリネーム/複製/削除メニュー |
| モードドロップダウン | 現在のレイアウトモード（モードバーと同期、狭小画面用の冗長表示） |
| [🔍] 検索ボタン | インクリメンタルノード検索、ヒットノードにビューポート自動センタリング |
| [⋮] パネルメニュー | Display / Export / Reset layout / Help |

### パネルメニュー

```
Display
  ☑ Scenes
  ☑ Codex
  ☑ Snippets
  ☑ Notes
  ☑ Stickies
  ☑ AI Branch
  ☑ Derived edges（Codex親子・Scene言及・Snippet出処）
  ☐ User edges（ユーザー描画）
  ☑ Frames
  ☐ ミニマップ
  ☑ グリッドスナップ
  ---
  Color by         ▶ None / Status / Sticky color / POV / Tag (v2)
  Visual theme     ▶ Default / Corkboard feel / Constellation (v2)

Layout
  Auto-arrange     ▶ Grid by reading-order
                     Force-directed compact
  ---
  Reset Free positions（ピン留め以外を原点近傍に戻す）
  Fit to viewport

Export
  SVG / PNG として保存
  JSONとしてエクスポート（他ツール連携用）
  ✨ Starchart として保存（Constellation スキン強制、v2）
```

### Auto-arrange アクション

旧設計では 4 つあったが、Time/POV モード削除に伴い 2 つに縮小。実行すると `pinned=false` のノードのみ位置が一括更新され、以降は Free モードで調整可能。

| アクション | 動作 |
|----------|------|
| **Grid by reading-order** | Scene ノードのみ reading-order 順でグリッド配置（N 列、左から右・上から下） |
| **Force-directed compact** | Theme モードの force layout を実行し、結果を Free の座標として固定 |

実行前に確認ダイアログ:

```
この操作は Free モードのノード位置を上書きします
（ピン留めされたノードの座標は変更されません）。

                  [キャンセル]  [実行]
```

---

## B. モードバー

### Mode セグメント

`[Free]` と `[Theme]` の 2 ボタンのみ。

### Show チェックボックス

表示するノード種別・エッジ種別を制御。チェックOFFのノードは**完全に隠す**（Map は散らかりやすいため、Timeline と異なり opacity 半透明ではなく非表示）。

| チェック | 対象 |
|---------|------|
| Scenes | Scene ノード（手動でこのボードに追加されたもの） |
| Codex | Codex エントリノード（手動でこのボードに追加されたもの） |
| Snippets | Snippet ノード（手動でこのボードに追加されたもの） |
| Notes | Note ノード（手動でこのボードに追加されたもの） |
| **Stickies** | **Sticky ノード（このボード固有の付箋）** |
| **AI Branch** | **AI Branch ノード（種を撒いた跡） + 派生 Sticky** |
| Derived edges | 既存リレーションから導出されるエッジ |
| User edges | `map_edges` に保存されたユーザー描画エッジ |
| Frames | `map_frames` に保存されたフレーム（Free モード時のみ有効） |

### Color by ドロップダウン

ノードのボーダー色で意味付けする軸を選択。

```
Color by: [None ▾]
  ● None
  Status            （Scene のみ。ステータス色）
  Sticky color      （Sticky のみ。本人カラー）
  POV character     （v2、tree_nodes.pov_character_id 追加後）
  Tag               （v2）
```

---

## C. キャンバスビューポート

### 無限キャンバス

- 論理座標空間: 無限（X/Y 共に Int32 の範囲）
- ズーム範囲: 10% 〜 400%
- 初期ビュー: 全ノードが収まる Fit to viewport（空ボードの場合は原点中央）

### 背景

- ドットグリッド背景（`Ctrl+G` で ON/OFF）
- グリッド間隔: ズームレベルに応じて適応的（16px / 32px / 64px）
- スナップ: 設定 ON 時のみ、ドラッグ終了時にグリッドに吸着

### 空白エリアのインタラクション

| 操作 | 動作 |
|------|------|
| **空白ダブルクリック** | **クリック位置に Sticky を即時追加**（タイトル input にフォーカス入った状態） |
| 空白シングルクリック | 選択解除 |
| 空白ドラッグ | ラバーバンド選択（矩形内の全ノードを選択） |
| 空白右クリック | コンテキストメニュー: `Add Sticky here` / `Add Frame here` / `Add Scene…` / `Add Codex…` / `Add Note here` / `Paste` |
| Space + ドラッグ | パン |

空白ダブルクリックでの Sticky 即時追加は Map の最重要 UX。発想の流れを止めずに付箋を撒けることが、マインドマップとしての成立条件。

---

## ノードタイプ

Map に表示されるノードは 5 種類。**Sticky と AI Branch が Map のために新設**、Scene/Codex/Note は手動で呼び寄せる仕様に変更。

### Sticky ノード（Map 専用・新規）

Map のために新設する**軽量メモ**。`tree_nodes` に乗らず Scenes パネルにも出ないため、ツリー汚染ゼロ。発想を止めずに撒ける。**body は ProseMirror JSON で保持**し、TipTap の minimal インスタンスでインライン編集する（Codex ハイライト・authorship・AI 生成図表に対応するため）。

```
┌──────────────────────┐
│ 封じ文の起源は？      │   ← title（任意、空も許容）
│ ──────────────────── │
│ 帝国時代の儀式に源流？│   ← body（ProseMirror、Codex ハイライト適用）
│                       │
│ | 候補 | 出典 |       │   ← table も可（AI 生成図表対応）
│ |---|---|             │
│ | 西方教団 | 序章 |    │
│         ✦  💬         │   ← 帰属バッジ + Chat由来バッジ
└──────────────────────┘
```

| プロパティ | 詳細 |
|----------|------|
| 参照 | なし（Map 専用エンティティ） |
| 保存先 | `map_stickies` テーブル |
| 表示 | カラー付き付箋（パレット 8 色から選択、デフォルト黄）+ TipTap read-only ビュー |
| サイズ | **幅: 固定 240px / 高さ: auto**（最小 80px、最大 600px。超過は内部スクロール） |
| タイトル | 任意（空も可、plain text） |
| 本文 | **ProseMirror JSON**。改行・段落・H3・list・table・code 対応 |
| 編集 | ダブルクリックで TipTap 編集モード、floating toolbar |

#### TipTap minimal インスタンス仕様

Sticky body は専用の TipTap プリセットで編集する。Editor / Snippet / Codex で使う TipTap とは別プリセットだが、authorship / Codex highlight などの mark は共有する。

**含める extension**:

| カテゴリ | Extension | 理由 |
|---------|----------|------|
| 基本 | StarterKit（Document/Paragraph/Text/Bold/Italic/Heading/BulletList/OrderedList/CodeBlock/History） | 軽量編集 |
| 表 | `@tiptap/extension-table`（Table/TableRow/TableCell/TableHeader） | AI 図表対応 |
| 画像 | `@tiptap/extension-image` | v2、貼り付け対応 |
| Mark（既存共有） | **CodexHighlightMark** | Codex 名の自動ハイライト |
| Mark（既存共有） | **AuthorshipMark** | 帰属追跡 |
| 装飾 | Placeholder | 空 Sticky に「思いついたことを書く…」表示 |

**含めない**: リンク・引用・水平線・タスクリスト等。Sticky の軽量性を守るため。リッチに書きたいなら Note/Snippet に昇格する。

**編集 UI**:

- シングルクリック: ノード選択
- **ダブルクリック / `Enter`**: TipTap 編集モード起動。title input と body エディタの両方が編集可能になる
- 編集モード時にノード下に **floating toolbar**（B / I / H / list / table / code）
- markdown ショートカット（`**bold**` / `#` / `-` / 三連バッククォート / `|table|` 等）有効
- Codex ハイライトは編集中もリアルタイム適用
- `Esc` / 外側クリックで離脱、自動保存
- 編集中はカード D&D を無効化（誤ドラッグ防止）

**非編集時の描画**:

- TipTap を **read-only モード**で常時マウント
- Codex ハイライト・Authorship 色付けは常時表示
- Sticky 数が多い場合のパフォーマンスは未解決事項参照（ズームアウト時の static HTML 切替を Phase A で実測判断）

#### Authorship 連携

Sticky body は他の ProseMirror ベース document（Codex content / Snippet content / Scene 本文）と同じく **`authorship_spans` テーブルで帰属を range 単位で track** する。

**初期 authorship**:

| 作成経路 | 初期 authorship |
|---------|---------------|
| 空白ダブルクリック / `S` キー / `[+Sticky]` ボタン | 全範囲 `human` |
| AI Branch から生成 | 全範囲 `ai` |
| Chat → Map の `As Sticky` | 元 Chat メッセージの authorship を継承（AI 応答なら `ai`、ユーザー発言なら `human`、選択範囲の span をそのまま転記） |
| Sticky → Snippet 昇格時 | Sticky の authorship を新 Snippet にコピー |
| 編集 | 編集範囲のみ `human` で上書き（既存の TipTap authorship パイプラインに乗る） |

**帰属バッジ（ノード右下）**:

| バッジ | 条件 |
|------|------|
| なし | 全 human（最も多いケースは UI を汚さない） |
| **`✦`** スパークル（AI 色） | 全 ai または ai 主体（ai 文字数 > 50%） |
| **`◐`** 半円 | 混在（ai と human が両方 1 文字以上） |

バッジクリックで Attribution パネルへ遷移。

**Chat 由来バッジ（💬）**:

`map_stickies.source_chat_message_id` が non-null の場合、ノード右下に小さな `💬` を表示。クリックで Chat の該当メッセージへジャンプ。

#### 作成方法

- **空白ダブルクリック**（最速）
- パレットの `[+Sticky]` ボタン
- 空白右クリック → `Add Sticky here`
- 既存 Sticky の右クリック → `Branch from this`（隣に Sticky を生やす、エッジで自動接続）
- `S` キー（フォーカス時、現在ビューポート中央に追加）
- **Chat メッセージの `Map に追加 ▸ As Sticky`**（後述「Chat との連携」）
- AI Branch ノード生成時（種からの派生）

#### 昇格動線（Sticky → 構造化）

Sticky の右クリック → `Promote to ▸` サブメニューで、Map 限定のメモを正式エンティティに変換できる。すべて ProseMirror ベースなので **content をそのままコピー**できる（authorship / Codex highlight も継承）。

| 昇格先 | 変換ルール |
|--------|----------|
| **Scene** | `tree_nodes` に新規 Scene 行作成。title = Sticky title（空なら「Untitled scene」）、synopsis = body 先頭段落の plain text、本文 = body 全体の ProseMirror JSON。配置先 chapter は確認ダイアログ。Sticky 削除、新 Scene の Map ノードに置き換え |
| **Codex** | `codex_entries` に新規行作成。type 選択ダイアログ（character / location / item / lore）→ name = title（空なら「Untitled」）、content = body の ProseMirror JSON をそのままコピー。Sticky 削除、新 Codex の Map ノードに置き換え |
| **Snippet** | `snippets` に新規行作成。content = body の ProseMirror JSON をそのままコピー（title があれば先頭に H3 として挿入）。`scene_id` は NULL、`source_chat_message_id` は Sticky から継承。Sticky 削除、新 Snippet の Map ノードに置き換え |
| **Note** | `tree_nodes` に新規 Note 行作成。title = title（空なら「Untitled note」）、本文 = body の ProseMirror JSON。配置先フォルダは確認ダイアログ。Sticky 削除、新 Note の Map ノードに置き換え |

昇格後、元 Sticky に接続していた User edge は新ノードに引き継がれる（`map_edges.from_position_id` / `to_position_id` を新 `map_node_positions.id` に張り替え）。authorship_spans も `sticky_id` から新エンティティの ID 列に張り替え。

#### Frame ごと Codex に昇格

Frame の右クリック → `Promote frame to Codex` で、内包 Sticky 群を 1 Codex エントリに集約できる。

- Frame title → Codex name
- 内包 Sticky の body を ProseMirror JSON として連結 → Codex content に流し込む（Sticky に title がある場合は H3 見出しとして挿入し、その下に body を配置）
- 各 Sticky の authorship_spans は新 Codex の content にオフセット調整して移植
- type は確認ダイアログでユーザーが選択（character / location / item / lore）
- 内包 Sticky は削除、Frame 自体は Codex ノード 1 つに置き換わる

### Scene ノード

旧設計の **Card / Image バリアントは廃止**。Compact 一本化。Grid との情報量差別化が主目的。

```
┌─────────────────────┐
│●Ch.1 廃社            │   ← Status色ドット + 章番号 + タイトル
└─────────────────────┘
```

| プロパティ | 詳細 |
|----------|------|
| 参照 | `tree_nodes.id`（node_type = 'scene'） |
| 表示 | Status 色ドット + 章番号 + タイトル + Label 色ドット 1 個（Label が複数ある場合は最初の 1 色 + `+N`） |
| サイズ | 固定（200×40px、Compact のみ） |
| 詳細表示 | ホバーでツールチップ（title + synopsis 抜粋 + status + POV）。常時カードに出さない |
| ダブルクリック | Editor で固定タブ起動（既存挙動） |
| シングルクリック | 選択 |

**Map に出てくるのは「ユーザーが手動でこのボードに追加した Scene のみ」**。プロジェクトの全 Scene が自動で並ぶことはない。追加経路は後述「手動キュレーション」。

### Codex ノード

```
┌─────────────────────┐
│ ◯ Elara             │   ← typeアイコン + name
│ character           │   ← typeラベル
└─────────────────────┘
```

| プロパティ | 詳細 |
|----------|------|
| 参照 | `codex_entries.id` |
| 表示 | type アイコン + name + type ラベル |
| サイズ | 固定（200×60px） |
| アイコン画像あり | 左端に 28×28px |
| ダブルクリック | Codex パネルで該当エントリを開く |

旧設計の summary 先頭 40 文字表示は削除（ホバーツールチップに退避）。Map では「誰がいるか」が見えれば十分で、概要は Codex パネルに任せる。

### Snippet ノード

```
┌──────────────────────┐
│ ✂ 「封じ文の文面…」   │   ← scissorsアイコン + content先頭40文字
└──────────────────────┘
```

| プロパティ | 詳細 |
|----------|------|
| 参照 | `snippets.id` |
| 表示 | scissors アイコン + content から抽出した先頭 40 文字（ProseMirror JSON の最初の text ノード） |
| サイズ | 固定（200×40px） |
| ダブルクリック | Snippets パネルで該当 Snippet を開く |
| Derived edge | `snippets.scene_id` が指す Scene が同じボードにいれば、薄い点線で接続 |

`snippets` テーブルは title カラムを持たない（content のみ）ため、Map ノードの表示は **content の先頭 40 文字を自動抽出**する。長文の場合は末尾 `…` で省略、ホバーで本文先頭 200 文字をツールチップ表示。

### Note ノード

```
┌─────────────────────┐
│ 📝 取材メモ          │
└─────────────────────┘
```

| プロパティ | 詳細 |
|----------|------|
| 参照 | `tree_nodes.id`（node_type = 'note'） |
| 表示 | アイコン + タイトル |
| サイズ | 固定（180×40px） |
| ダブルクリック | Editor でノートを開く |

**Note と Sticky の境界線**:

| 軸 | Note | Sticky |
|----|------|--------|
| 永続性 | Scenes パネルツリーに常駐 | Map のボード限定 |
| エディタ | フル TipTap（リンク・引用・タスクリスト等すべて） | minimal TipTap（B/I/H/list/table/code のみ、リンク等なし） |
| 編集面積 | 本文をフルエディタで書く | 高さ可変だが 400px 超で昇格を促される |
| 用途 | 取材メモ・設定資料・脚本断片 | 落書き・思いつき・問い・AI 図表の受け皿 |
| 寿命 | 長期保管 | 短期、昇格 or 削除されるのが前提 |

### AI Branch ノード

AI を**「種を撒く道具」**として使うノード。Map から既存ノードを種にして AI に派生アイデアを生成させ、結果を Sticky 群として撒く。「生成された応答 1 つを保持する」ではなく「種から多数の Sticky を派生させる」点がポイント。

```
✦ AI Branch
「Elara の動機の候補」
   ├─ 📌 復讐
   ├─ 📌 探索
   ├─ 📌 義務
   ├─ 📌 偶然
   └─ 📌 逃避
```

| プロパティ | 詳細 |
|----------|------|
| 参照 | なし（Map 専用、`map_ai_branches` テーブル） |
| 動作 | 選択ノードを「種」として AI に渡し、派生アイデアを N 個（デフォルト 5）の **Sticky として撒く** |
| 永続化 | プロンプト + 生成された Sticky の ID リスト + session_id |
| 結果ではなく種 | 生成された Sticky は通常の Sticky と同じく編集・昇格・削除可能 |

#### 作成方法

- ノード右クリック → `AI Branch from this`
- 選択ノード（複数可）右クリック → `AI Branch from selection`
- パレット `[+AI Branch]`（コンテキストノード未選択時はキャンバス全体を文脈に）

#### 動作

1. AI Branch ダイアログ: プロンプト入力（種ノードの内容は自動で添付、ユーザーは追加指示を書く）+ 生成数（3/5/8 から選択）
2. AI への内部プロンプト規約: **「結果は markdown で。各アイデアは独立した Sticky 1 個に対応。表が必要なら markdown table、リストが必要なら箇条書き、コードが必要なら code block を使用。」** これにより応答内の図表が Sticky body の TipTap JSON に変換できる
3. AI 応答（markdown）→ 既存の markdown→ProseMirror JSON 変換パイプライン（Chat → Snippet 抽出と共通）で N 個に分割
4. それぞれを Sticky として種ノード周囲に配置。各 Sticky の authorship は全範囲 `ai` で初期化
5. AI Branch ノード自体は中央に置かれ、各 Sticky と細い破線エッジで接続（種ノード→AI Branch→生成 Sticky）
6. ユーザーは生成 Sticky を編集・削除・他の Sticky と接続・昇格できる。編集した範囲は自動的に `human` authorship に切り替わる

#### Chat 連携

- AI Branch は内部的に Chat セッションを 1 つ作る（`map_ai_branches.session_id`）
- ノードダブルクリックで Chat パネルに飛び、続けて掘り下げ可能

#### ワンクリック削除（× ボタン）

AI Branch ノードはホバー時に右上に **`×` バッジ**が表示される。これは「気軽に何度でも撒き直せる」マインドマップ体験のため：種があまり良くなければ即捨てて、別のプロンプトで撒き直す、というフローを高速化する。

- `×` クリックで **確認ダイアログなしで即削除**（永続価値の低いエンティティのため）
- **派生 Sticky は残る**（`map_stickies.ai_branch_id` の `ON DELETE SET NULL` で由来情報のみ失われる）。ユーザーが Sticky の中で残したいものがあれば手動で残せる
- 派生 Sticky も一括で消したい場合は、ノード右クリック → `Delete with all derived stickies`（こちらは件数を表示する確認ダイアログ）

`×` バッジは AI Branch ノード固有の UI。Sticky や Scene/Codex/Note には付かない（誤削除リスクが高いため）。

### 永続化されないこと

Map では**全ノード が `map_node_positions` に行を持つ**。これはどのボードにどの座標で配置されているかの台帳。Scene/Codex/Note の Map への出現は手動キュレーションなので、追加されない限り行は作られない。

---

## エッジ

### Derived edges（自動生成）

既存のリレーションから自動的に描画されるエッジ。**ただし両端のノードが両方このボードに配置されている場合のみ描画**（手動キュレーション原則の徹底）。

| 出典 | 表示スタイル | 意味 |
|------|------------|------|
| `codex_entries.parent_id` | 実線・両端丸 | Codex 親子関係 |
| Scene → Codex 言及 | 点線・矢印なし | シーン本文に Codex 名が出現 |
| `codex_entry_phases.anchor_node_id` | 波線 | Phase アンカーが Scene 側 |
| `snippets.scene_id` | 薄い点線 | Snippet の出処シーン |

- デフォルトは **Codex 親子のみ ON**、シーン言及・Phase は設定で追加
- Derived edges は編集不可（ソースを変更しないと変わらない）
- ノード数 200 を超えたら Derived edges を自動 OFF（旧設計から踏襲）

### User edges（ユーザー描画）

ユーザーが明示的に引いたエッジ。`map_edges` テーブルに保存。**双方向ラベルと多重ラベル**を v1 から対応。

| プロパティ | 詳細 |
|----------|------|
| from_position_id / to_position_id | `map_node_positions.id` 参照 |
| **forward_label** | A→B 方向のラベル（例: 「師匠」） |
| **backward_label** | B→A 方向のラベル（例: 「弟子」）。空ならラベル片方向のみ |
| **labels** | 補助ラベル配列（例: `["師匠", "父"]`、JSON 配列文字列）。1 関係に複数の意味を持たせる |
| style | 線種（solid / dashed / dotted） |
| color | 色（hex） |
| direction | `none` / `forward` / `bidirectional` |

#### 描画方法

- ノードのエッジ（端）をドラッグ → 別ノードにドロップ
- または `Alt/⌥` 押しながらノード→ノード
- 描画中は半透明プレビュー線
- ドロップ時にラベル入力インライン（forward / backward 2 行）

#### 編集

- エッジクリック → 選択（太線ハイライト）
- ダブルクリック → ラベル編集ポップオーバー（forward / backward / 補助ラベル配列を一括編集）
- 右クリック → コンテキストメニュー（線種変更・色変更・**Codex Relation に昇格**（v2）・削除）

#### Codex Relation への昇格（v2）

両端が Codex ノードである User edge は、`Promote to Codex relation` で正式 Relation に昇格できる（`codex_relations` テーブル新設前提、v2）。Map で発見した関係を構造化する経路。

```
A: Elara ──「師匠」──> B: Marcus      （User edge）
        ↓ Promote to Codex relation
codex_relations: { from: Elara, to: Marcus, type: "mentor", label: "師匠" }
```

昇格後の User edge は Derived edge として描画される（自動生成扱い）。

---

## フレーム

ノードをグループ化する矩形領域。Miro / FigJam の Frame と同じ概念。

### 構造・作成・操作

旧設計から大きく変えない。

- タイトル + 背景色 + ボーダー色
- パレット `[+Frame]` または `F` キーで矩形描画
- ヘッダドラッグで内包ノード一括移動
- ボーダードラッグでリサイズ
- 入れ子不可（v1）

### 新規アクション: Promote frame to Codex

Frame の右クリック → `Promote to Codex` で、Frame と内包 Sticky 群を 1 Codex エントリに変換できる（前述「Sticky → Codex 昇格」セクション参照）。Sticky 群でブレストした結果を 1 つの正式 Codex に集約する動線。

### 制限

- Free モード以外では非表示（旧設計踏襲）
- 重力場モードでは内包ノード一括移動も無効

---

## 手動キュレーション

Map の最大の方針転換。**Scene / Codex / Note は自動で並ばず、ユーザーが明示的にこのボードへ追加したものだけが現れる**。

### 追加経路

| 経路 | 動作 |
|------|------|
| **Scenes パネル右クリック** | `Add to Map ▸ <ボード名>` でツリー上の Scene/Note を現在のボードに追加（座標は新規ノード初回配置ロジックに従う） |
| **Codex パネル右クリック** | `Add to Map ▸ <ボード名>` で Codex エントリを追加 |
| **Snippets パネル右クリック** | `Add to Map ▸ <ボード名>` で Snippet を追加 |
| **Map パレット `▾Add…`** | `Add Scene…` / `Add Codex…` / `Add Snippet…` / `Add Note…` で検索ダイアログを開き、既存エンティティを選んで追加 |
| **Map 空白右クリック** | `Add Scene…` / `Add Codex…` / `Add Snippet…` / `Add Note here` で同上 |
| **Map 上で新規作成** | パレット `[+New Scene]` 等は v2 検討。v1 は既存エンティティの追加のみ（新規作成は Scenes/Codex パネルで） |

### 削除経路

Map ノードの右クリック → `Remove from this board` で `map_node_positions` の行を削除（参照先エンティティは無傷）。旧設計の `hidden = 1` 方式は廃止（ハードデリートの方が手動キュレーション原則に合致）。

エンティティそのものを削除したい場合は、ダブルクリックで対応パネルへ飛んでそちらから削除する（Map から直接エンティティ削除は混乱を招くため不可）。

### Sticky と AI Branch は別扱い

Sticky / AI Branch は Map 専用エンティティなので、Map で削除すれば本当に消える（昇格しない限り保存されない）。

---

## 複数ボード（v1 から対応）

旧設計の v2 計画を **v1 に前倒し**。1 プロジェクト = 1 ボードでは目的別の整理ができないため。

### ボード操作

- ヘッダーのボード切替ドロップダウン → 全ボード一覧
- `+ New board` → 名前入力 → 空ボード作成
- 各ボード横に `⋯` メニュー → リネーム / 複製（位置情報含む）/ 削除
- ボードごとに独立した Node positions / Edges / Frames / Stickies / AI Branches
- 同一の Codex/Scene/Note を複数ボードに配置可能（参照は共通、座標はボードごと）

### ボード名のサジェスト

新規ボード作成時、テンプレ候補を提示（任意、ユーザーが自由名でも OK）:

- 「人物関係図」
- 「Part 1 のプロット盤」
- 「世界の地理」
- 「ブレインストーミング」

### 削除確認

ボード削除時は `map_node_positions` / `map_edges` / `map_frames` / `map_stickies` / `map_ai_branches` が CASCADE で消える。Sticky / AI Branch のように Map 専用エンティティが付随する場合、それらの行数を表示してダブル確認:

```
このボードを削除すると、以下も削除されます:
- 12 個の Sticky
- 2 個の AI Branch
- 8 本の User edge
- 3 個の Frame

参照されている Scene / Codex / Note は削除されません。

  [キャンセル]  [削除する]
```

---

## ノードインタラクション

### クリック / ダブルクリック

| 操作 | 動作 |
|------|------|
| シングルクリック（ノード） | 選択 |
| ダブルクリック（Scene/Codex/Note） | 対応パネルでエンティティを開く |
| ダブルクリック（Sticky） | インライン編集 |
| ダブルクリック（AI Branch） | Chat パネルに飛んで該当セッションを開く |
| **ダブルクリック（空白）** | **クリック位置に Sticky を即時追加** |
| `Ctrl+クリック` | 個別トグル選択 |
| `Shift+クリック` | 範囲選択（最後の選択ノードからの矩形範囲） |
| 空白ドラッグ | ラバーバンド選択 |

### ドラッグ

| 操作 | 動作 |
|------|------|
| Free モードでドラッグ | 座標更新 → `map_node_positions` に保存 |
| Theme モード + ピンなしドラッグ | 自動的にピン留め + 座標保存（Hybrid 化） |
| Theme モード + ピン済みドラッグ | 座標更新のみ |
| Shift + ドラッグ | 複数選択ノードを一緒に移動 |

### コンテキストメニュー

#### Scene / Codex / Note ノード

| メニュー項目 | 動作 |
|-------------|------|
| Open | 対応パネルで開く |
| Open in side group | 新しい Editor Group で開く |
| --- | |
| Pin position | 現在座標にピン留め（Theme モードで Hybrid 化） |
| Unpin | ピン解除 |
| --- | |
| Connect to… | 次にクリックしたノードと User edge 作成 |
| **AI Branch from this** | このノードを種に AI で派生アイデアを Sticky として撒く |
| --- | |
| Bring to front / Send to back | z-index 変更 |
| **Remove from this board** | `map_node_positions` 削除（エンティティは無傷） |
| --- | |
| Focus | 選択ノード + 1 次接続のみ表示、他は opacity 0.15 |

#### Sticky ノード

| メニュー項目 | 動作 |
|-------------|------|
| Edit | インライン編集モード |
| Change color ▶ | 8 色パレットから選択 |
| --- | |
| Connect to… | User edge 作成 |
| Branch from this | 隣に新規 Sticky を生やしてエッジで接続 |
| AI Branch from this | この Sticky を種に AI 派生 |
| --- | |
| **Promote to ▶** | **Scene / Codex / Note への昇格サブメニュー**（前述） |
| --- | |
| Bring to front / Send to back | z-index |
| Delete | 削除（確認ダイアログなし、即削除） |

#### Frame

| メニュー項目 | 動作 |
|-------------|------|
| Rename | タイトル編集 |
| Change color ▶ | 背景色 |
| **Promote to Codex** | Frame と内包 Sticky を 1 Codex に集約（前述） |
| Delete | 削除（内包ノードは残る） |

### ホバー

- ホバー 500ms でツールチップ
- Scene/Codex/Note: title + synopsis/summary 抜粋 + type/status + POV
- Sticky: 全文（編集はせず参照のみ）
- 接続エッジがハイライト、接続先ノードも軽く強調

---

## パレット

キャンバス下部に固定配置。

```
┌─────────────────────────────────────────────────────────┐
│ [+Sticky] [+Frame] [+AI Branch] [⌥Connect] │ [▾Add…]    │
└─────────────────────────────────────────────────────────┘
```

| ボタン | 動作 |
|------|------|
| `[+Sticky]` | クリック後、キャンバスクリックで Sticky 配置 |
| `[+Frame]` | ドラッグで矩形描画 |
| `[+AI Branch]` | AI Branch ダイアログ（コンテキスト未選択時はボード全体を文脈に） |
| `[⌥Connect]` | エッジ描画モード |
| `[▾Add…]` | ドロップダウン: `Add Scene…` / `Add Codex…` / `Add Note…`（既存エンティティを検索して追加） |

### フェーズ別提供状況

| ボタン | 実装フェーズ |
|--------|------------|
| `[+Sticky]` `[▾Add…]` `[+Frame]` `[⌥Connect]` | Phase A |
| `[+AI Branch]` | Phase C |

旧設計にあった `[+Scene]` `[+Codex]` `[+Note]` の「Map 上で新規エンティティ作成」は v1 では削除（`[▾Add…]` で既存追加のみ）。新規作成は Scenes / Codex パネルで行うのが一貫したフロー。

---

## ズーム・パン

| 操作 | 動作 |
|------|------|
| `Ctrl+ホイール` / ピンチ | ズーム（10%〜400%） |
| Space + ドラッグ | パン |
| 中クリック + ドラッグ | パン |
| `Ctrl+0` | Fit to viewport |
| `Ctrl++` / `Ctrl+-` | 段階的ズーム |
| `Ctrl+1` | 100% |
| ミニマップ（右下） | 全体俯瞰、クリックでビューポート移動 |

### ミニマップ

`⋮` メニューで ON/OFF。キャンバス右下に固定（120×80px）。

- 全ノードの縮小表示
- 現在のビューポートを矩形枠で表示
- クリック/ドラッグでビューポート移動

---

## 検索

`🔍` ボタンまたは `Ctrl+F` で検索バー展開。

- 検索対象（現在のボードのみ、全ボード横断は v2）:
  - **Sticky**: title + body
  - **Scene**: title + synopsis
  - **Codex**: name + content + tag 名
  - **Snippet**: content + tag 名
  - **Note**: title + 本文先頭テキスト
  - **AI Branch**: prompt
- ヒットノードはキャンバス上で黄色ハイライト
- `Enter` でヒットノードにビューポート移動 + 選択
- `↑↓` で複数ヒット間の移動

---

## 状態管理

### Zustand ストア: `mapStore`

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `activeBoardId` | `string` | 現在のボード ID（v1 から複数ボード） |
| `mode` | `'free' \| 'theme'` | 現在のレイアウトモード |
| `viewport` | `{ x, y, zoom }` | ボードごとのビューポート状態 |
| `selectedNodeIds` | `string[]` | 選択中のノード ID（配列、Set ではない） |
| `selectedEdgeIds` | `string[]` | 選択中のエッジ ID |
| `show` | `{ scenes, codex, snippets, notes, stickies, aiBranch, derivedEdges, userEdges, frames }` | 表示チェックボックス状態 |
| `gridSnap` | `boolean` | グリッドスナップ ON/OFF |
| `minimapVisible` | `boolean` | ミニマップ表示。初期値 `false` |
| `colorBy` | `'none' \| 'status' \| 'stickyColor' \| 'pov' \| 'tag'` | カラーコーディング軸。v1 は `none / status / stickyColor` のみ |
| `visualTheme` | `'default' \| 'corkboard' \| 'constellation'` | ビジュアルスキン（Constellation は v2） |

### 派生データ

- `visibleNodes(show, viewport)`: ビューポート内 + 表示設定でフィルタ後のノード
- `computedPositions(mode, pinnedPositions)`: 現在のモードでの各ノード位置
- `derivedEdges`: 既存リレーションから導出 + 両端がボードに配置されているもののみ

### 永続化

- ボードごとの状態（`viewport`, `mode`, `show` など）はプロジェクト DB の `map_boards` に持つ
- グローバル UI 設定（`gridSnap`, `minimapVisible`, `visualTheme`）は `global-settings.json` の `map` セクション

---

## DB スキーマ

DB スキーマの正規版は統合 DB スキーマ設計書（`Grimodex_統合DBスキーマ.md`）を参照。本設計書で追加が必要なテーブルを以下に記載。

### map_boards（v1 から複数ボード）

```sql
CREATE TABLE map_boards (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Main',
  sort_order  REAL NOT NULL DEFAULT 0.0,
  -- ボード固有設定
  mode        TEXT NOT NULL DEFAULT 'free' CHECK(mode IN ('free', 'theme')),
  viewport_x  REAL NOT NULL DEFAULT 0,
  viewport_y  REAL NOT NULL DEFAULT 0,
  viewport_zoom REAL NOT NULL DEFAULT 1.0,
  show_config TEXT NOT NULL DEFAULT '{}',  -- JSON: 表示チェックボックス状態
  color_by    TEXT NOT NULL DEFAULT 'none',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_boards_project ON map_boards(project_id);
```

新規プロジェクト作成時に `title = 'Main'` のボードを 1 行自動作成。以降ユーザーが任意に追加。

### map_node_positions

ノードのボード上での位置情報。ポリモーフィック参照（Scene / Codex / Note / Sticky / AI Branch）。

```sql
CREATE TABLE map_node_positions (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  node_ref_type   TEXT NOT NULL
                    CHECK(node_ref_type IN ('scene', 'codex', 'snippet', 'note', 'sticky', 'ai_branch')),
  tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
  snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
  sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,
  ai_branch_id    TEXT REFERENCES map_ai_branches(id) ON DELETE CASCADE,
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  z_index         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (CASE WHEN tree_node_id   IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN sticky_id      IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN ai_branch_id   IS NOT NULL THEN 1 ELSE 0 END) = 1
  ),
  CHECK (
    (node_ref_type IN ('scene', 'note') AND tree_node_id   IS NOT NULL) OR
    (node_ref_type = 'codex'            AND codex_entry_id IS NOT NULL) OR
    (node_ref_type = 'snippet'          AND snippet_id     IS NOT NULL) OR
    (node_ref_type = 'sticky'           AND sticky_id      IS NOT NULL) OR
    (node_ref_type = 'ai_branch'        AND ai_branch_id   IS NOT NULL)
  )
);

CREATE INDEX idx_map_pos_board ON map_node_positions(board_id);
CREATE UNIQUE INDEX idx_map_pos_uniq_scene ON map_node_positions(board_id, tree_node_id)
  WHERE tree_node_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_codex ON map_node_positions(board_id, codex_entry_id)
  WHERE codex_entry_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_snippet ON map_node_positions(board_id, snippet_id)
  WHERE snippet_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_sticky ON map_node_positions(board_id, sticky_id)
  WHERE sticky_id IS NOT NULL;
CREATE UNIQUE INDEX idx_map_pos_uniq_ai ON map_node_positions(board_id, ai_branch_id)
  WHERE ai_branch_id IS NOT NULL;
```

旧設計の `hidden` カラムは削除（手動キュレーション化に伴い、削除はハードデリート）。

### map_stickies（新規）

```sql
CREATE TABLE map_stickies (
  id          TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  title       TEXT,                                                    -- plain text, nullable
  body        TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',     -- ProseMirror JSON
  preview_text TEXT,                                                    -- body 先頭40文字キャッシュ（保存時に抽出、ノード上の縮小表示用）
  color       TEXT NOT NULL DEFAULT 'yellow'
                CHECK(color IN ('yellow', 'orange', 'pink', 'green', 'blue', 'purple', 'gray', 'white')),
  ai_branch_id TEXT REFERENCES map_ai_branches(id) ON DELETE SET NULL,  -- AI生成由来の Sticky
  source_chat_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,  -- Chat由来の Sticky
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_stickies_board ON map_stickies(board_id);
CREATE INDEX idx_map_stickies_ai_branch ON map_stickies(ai_branch_id);
CREATE INDEX idx_map_stickies_chat_msg ON map_stickies(source_chat_message_id)
  WHERE source_chat_message_id IS NOT NULL;
```

| カラム | 説明 |
|--------|------|
| `body` | **ProseMirror JSON 文字列**。TipTap minimal インスタンスで編集される（前述「TipTap minimal インスタンス仕様」参照）。空 Sticky のデフォルトは空 doc |
| `preview_text` | body 先頭の text を 40 文字で抽出したキャッシュ。保存時にフロント側で計算して同梱（Beat 設計書の `unplaced_beat_preview` と同じ lazy パターン）。ノード縮小描画 / 検索ヒット表示で使用 |
| `ai_branch_id` | AI Branch 生成時にリンク。AI Branch を消しても Sticky は残るが由来情報は失う（`ON DELETE SET NULL`） |
| `source_chat_message_id` | Chat → Map で `As Sticky` 抽出した場合の元メッセージ。non-null なら Map ノード上に `💬` バッジ表示。元 Chat メッセージ削除時は SET NULL（Sticky 自体は残る） |

### authorship_spans への sticky_id 追加

既存の `authorship_spans` テーブルに `sticky_id` カラムを追加し、polymorphic CHECK 制約も更新する。詳細は **統合 DB スキーマ設計書**側で正規化定義（本設計書では追加カラムのみ提示）。

```sql
ALTER TABLE authorship_spans ADD COLUMN sticky_id TEXT
  REFERENCES map_stickies(id) ON DELETE CASCADE;

-- 既存の "exactly-one-non-null" CHECK 制約に sticky_id を追加（統合DBスキーマ設計書側で再定義）

CREATE INDEX idx_authorship_spans_sticky ON authorship_spans(sticky_id)
  WHERE sticky_id IS NOT NULL;
```

これにより Sticky body の各文字 range について `(start, end, source: 'human' | 'ai' | 'unknown')` が記録され、編集時に既存の TipTap authorship パイプラインが自動更新する。

### map_ai_branches

```sql
CREATE TABLE map_ai_branches (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  prompt        TEXT NOT NULL,
  seed_node_ids TEXT NOT NULL DEFAULT '[]',  -- 種ノードの ID 配列（JSON）
  session_id    TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  model         TEXT,
  token_usage   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_map_ai_branches_board ON map_ai_branches(board_id);
```

AI 応答はノード自体ではなく**派生 Sticky 群として外部化**される（`map_stickies.ai_branch_id` でリンク）。AI Branch ノード自体はプロンプトと session_id だけを保持する。

### map_edges（双方向ラベル + 多重ラベル対応）

```sql
CREATE TABLE map_edges (
  id                  TEXT PRIMARY KEY,
  board_id            TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
  from_position_id    TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  to_position_id      TEXT NOT NULL REFERENCES map_node_positions(id) ON DELETE CASCADE,
  forward_label       TEXT,                          -- A→B 方向
  backward_label      TEXT,                          -- B→A 方向
  labels              TEXT NOT NULL DEFAULT '[]',    -- 補助ラベル配列（JSON）
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

旧 `label` カラムは `forward_label` にリネーム（マイグレーションで値を移送）。`backward_label` / `labels` を新規追加。

### map_frames（変更なし）

旧設計から変更なし。ただし `Promote frame to Codex` の動作はアプリ層で実装。

---

## 他パネルとの連携

### → Editor

- Scene/Note ノードをダブルクリック → Editor で固定タブとして開く
- Codex ノードをダブルクリック → Codex パネルで該当エントリ（Editor 側ではなく）

### → Codex

- Codex ノードをダブルクリック → Codex パネルの詳細画面
- Codex エントリの type 変更 / 削除 → Map 上のノード表示が即時更新
- Codex Phase の anchor_node_id 設定 → Derived edge として描画（両端がボードにいれば）
- **Sticky / Frame からの昇格動線**で新規 Codex を作成可能

### → Scenes

- Map で選択した Scene ノードは Scenes パネルのツリーでも選択状態で連動（`activeSceneSync`）
- **Scenes パネル右クリック → `Add to Map ▸ <ボード名>`** でツリー上の Scene/Note を追加
- **Sticky → Scene 昇格**で新規 Scene を作成（配置 chapter は確認ダイアログ）

### → Snippets

- Snippets パネル右クリック → `Add to Map ▸ <ボード名>` で既存 Snippet を追加
- **Sticky → Snippet 昇格**で新規 Snippet を作成（`scene_id` は NULL）
- Snippet ノードのダブルクリックで Snippets パネルを開く
- `snippets.scene_id` が指す Scene が同じボードにいれば Derived edge として薄い点線で接続

### → Grid

- Map と Grid は**役割が違う**ため別パネル（概要セクション参照）
- Sticky → Scene 昇格で作った Scene は Grid の該当 Chapter 列に即時反映
- Map から Grid へのクロスナビゲーション（Show in Grid）は v2 検討

### → Timeline

- Map 上の Scene が `story_time_order` を持っていても Map では使わない（旧 Time モード削除）
- Timeline で `story_time_order` を変更しても Map の配置は変わらない

### → Chat（Map → Chat）

- AI Branch ノードのダブルクリック → Chat パネルで該当セッションを開いて掘り下げ
- AI Branch 生成時のプロンプトと応答は Chat の通常セッションとして保存される

### ← Chat（Chat → Map: 議論を Map に還元）

Chat で AI と議論した内容を Map に持ち込む経路。**新ノードタイプは追加せず**、既存の Sticky / Snippet / AI Branch / Codex のいずれかに変換する。Chat パネル側に「Map に追加 ▸」サブメニューを設ける。詳細仕様は Chat パネル設計書側で扱う。

#### メッセージ単位の動線

Chat メッセージの `⋯` メニュー → `Map に追加 ▸` で 4 形式から選択：

| 形式 | 用途 | 変換ルール |
|------|------|----------|
| **As Sticky** | 短文・1 アイデアをその場で付箋化 | メッセージ本文（または選択範囲）を Sticky body にコピー。`source_chat_message_id` を保存。authorship は元メッセージから継承（AI 応答なら `ai`、ユーザー発言なら `human`） |
| **As Snippet** | 応答の塊を再利用テキストとして保存 | `snippets` に新規行作成。`source_chat_message_id` を保存。authorship 継承 |
| **As AI Branch** | 議論の流れ全体を Map に置き、応答を Sticky 群に分解 | `map_ai_branches` に新規行作成（prompt = 元の質問、session_id = 元 Chat セッション）。**応答テキストを再度 AI に投げて N 個の Sticky に分解**してから配置（既存 AI Branch の「種から撒く」動作の入力源を Chat メッセージに変えただけ） |
| **As Codex…** | 応答に出てきた人物・場所を構造化 | 既存の Chat → Codex 抽出フロー（`extractedCodex` メタデータ）に乗せる。Codex 作成後、Map に Codex ノードとして配置 |

配置先ボードは確認ダイアログで選択（複数ボードがあるため）。

#### テキスト選択範囲の動線

Chat メッセージ内のテキストを選択して右クリック → `Map に追加 ▸ As Sticky / As Snippet`（範囲が短いのでこの 2 つのみ）。選択範囲の authorship span をそのまま転記する。

#### As AI Branch の特殊動作

AI Branch ノードは元々「Map から AI に種を投げて Sticky を撒く」設計だったが、Chat → Map では入力源が「既存の AI 応答」になる。動作は：

1. ユーザーが応答メッセージで `As AI Branch` を選択
2. Map ボード選択ダイアログ + 分解する Sticky 数（3/5/8）選択
3. 内部的に「この応答からアイデアを N 個に分解して。各アイデアは独立した Sticky 1 個になるように。」と AI に再投する（Chat の同じ session_id を継続）
4. 分解結果を Sticky として配置、AI Branch ノードは元質問をプロンプトとして保存
5. ノードダブルクリックで Chat に戻ると、元の議論 + 分解再投の両方が見える

#### Sticky / Snippet の Chat 由来追跡

- Sticky: `map_stickies.source_chat_message_id` カラム（後述 DB スキーマ参照）。non-null なら `💬` バッジ表示、クリックで Chat 該当メッセージへ
- Snippet: 既存の `snippets.source_chat_message_id` を活用

---

## キーボードショートカット

### アプリレベル

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+M` | Map パネルのフォーカス/トグル |

### Map パネルフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `1` / `2` | モード切替（Free / Theme） |
| `Ctrl+F` | 検索バー |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | ズーム |
| `Ctrl+1` | ズーム 100% |
| Space + ドラッグ | パン |
| **`S`** | **現在ビューポート中央に Sticky を即時追加** |
| `F` | Frame 作成モード |
| `Alt/⌥` 押下 / `E` | Connect モード |
| `Del` / `Backspace` | 選択中のノード/エッジ/フレーム削除 |
| `Ctrl+A` | 全ノード選択 |
| `Ctrl+D` | 選択ノード Duplicate（Sticky のみ。Scene/Codex/Note は参照ノードのため複製不可） |
| `Ctrl+G` | グリッドスナップ ON/OFF |
| `F2` | 選択ノードの名前/タイトルをインライン編集 |
| `Enter` | Sticky: インライン編集 / その他: 対応パネルで開く |
| `Ctrl+P` | 選択ノードのピン留めトグル |
| `Escape` | 編集離脱 / 選択解除 / モードキャンセル / Focus 解除 |

### ノード削除の挙動

- **Sticky / AI Branch / User edge / Frame**: 即削除（Map 専用エンティティ）
- **Scene / Codex / Note**: `Remove from this board` と同じ挙動（`map_node_positions` 削除のみ、参照先エンティティは無傷）。エンティティそのものを削除したい場合は対応パネルから

複数選択での Delete は、選択セット内の各種別に上記ルールを適用。確認ダイアログは Sticky / AI Branch を含まず Scene/Codex/Note のみの場合は不要（Map から外すだけだから）、含む場合は Sticky 件数を表示して確認。

---

## レスポンシブ動作

### 幅に応じたモードバーの折りたたみ

| パネル幅 | モードバー | ヘッダーモードドロップダウン |
|---------|-----------|--------------------------|
| ≥ 600px | 表示（Free / Theme） | 非表示 |
| < 600px | 非表示 | 表示 |

### 高さ ≥ 500px

全機能フルセット。

### 高さ 300〜499px

- パレットはコンパクト（アイコンのみ）
- ミニマップは初期 OFF

### 高さ < 300px

- 「Map は小さい画面ではあまり使えません」ヒント + 「フローティングで開く」ボタン

---

## 実装ライブラリ候補

### キャンバス描画

| 候補 | 判定 | 理由 |
|------|------|------|
| **React Flow** | **第一候補** | ノード・エッジ・ズーム・パン・ミニマップ・D&D を網羅、React ネイティブ |
| tldraw | 第二候補 | 高機能だが大きすぎる |
| 自前実装 | 不採用 | 実装コスト過大 |
| **D3** | 部分採用 | `d3-force` を Theme モードで使用 |

React Flow を採用し、独自ノードタイプ（SceneNode / CodexNode / NoteNode / **StickyNode / AIBranchNode**）を実装。

### Force-directed レイアウト

- `d3-force` を Web Worker で実行
- Theme モードで使用
- 100 ノード以内は即時、それ以上はプログレス表示

---

## 実装状況（2026-05-16 時点）

設計書と実コード（`src/features/map/` 配下、`src-tauri/src/database/migrate.rs`、関連他パネル）の差分を Phase 別に整理する。凡例: ✅ 実装済 / 🟡 部分（差分あり）/ ⬜ 未実装。

### サマリ

| Phase | 達成 | 主な未達 |
|-------|------|---------|
| Phase A 基盤 | 8/11 完, 3 部分 | Sticky の Codex highlight・帰属バッジ・パフォーマンス閾値 / 空白右クリックメニュー / ホバーツールチップ |
| Phase B 関係性・昇格 | 4/8 完, 4 部分 | User edge 多重ラベル UI / 検索の body・content 走査 / Snippet 出処エッジの接続先 / Corkboard 演出 |
| Phase C AI と Theme | 3/4 完, 1 部分 | AI Branch の `session_id` 配線（Map ↔ Chat 双方向ジャンプが未通電）|
| Phase D 高度な機能 | 4/4 完 | — |
| Phase E v2 | 0/6 | 想定通り未着手 |

横断的な未達（Phase に跨る）:

- **Chat → Map 連携（`As Sticky` / `As Snippet` / `As AI Branch` / `As Codex…`）が完全未実装**。DB の `map_stickies.source_chat_message_id` カラムと `snippets.source_chat_message_id` は揃っているが、Chat メッセージのメニューに「Map に追加 ▸」が無く、書き込み経路も無い。
- `Ctrl+D` Duplicate / `F2` rename inline / `Enter` open ショートカット未実装。
- AI Branch 生成時に `sessionId` を `createAiBranch` へ渡しておらず（`MapCanvas.tsx:1046-1052`）、`map_ai_branches.session_id` が常に null。結果として AI Branch ノードダブルクリック → Chat への遷移が事実上死んでいる（`useMapNodes.ts:441-445` の分岐に入らない）。

### Phase A 詳細

- ✅ `map_boards` / `map_node_positions` / `map_stickies` テーブル — `src-tauri/src/database/migrate.rs:543-650`。新規プロジェクト作成時に `Main` ボードを自動 seed する trigger あり（`migrate.rs:750-754`）。
- ✅ 複数ボード対応（一覧・追加・削除・リネーム・複製）— `mapApi.ts:40-259`、`MapHeader.tsx:159-286`。削除確認ダイアログは `countBoardEntities`（`mapApi.ts:131-147`）を持つが、`MapHeader.tsx:550-591` の `BoardDeleteConfirm` では件数表示に未使用（設計書 615-625 行のダブル確認はテキストのみ）。
- ✅ Free モード — `src/features/map/layouts/free.ts`
- 🟡 Sticky ノード — TipTap 編集・色変更・削除・空白ダブルクリック生成・`S` キー・パレット `[+Sticky]` は揃う。以下が未達:
  - **`CodexHighlightMark` が `getStickyEditorExtensions` に含まれていない**（`src/features/editor/extensions.ts:213-224`、`AuthorshipMark` のみ）。設計書 257 行で必須とされた Codex 名のリアルタイムハイライトが Sticky 編集中に効かない。
  - **読み取り専用時は `preview_text`（plain text）描画**（`StickyNode.tsx:262-278`）。設計書 1229-1234 行の「Codex highlight・authorship 色付けを事前計算で描画」が未達。
  - **50 個閾値での static HTML フォールバック未実装**（設計書 1226-1238 行の Phase A 必達要件）。現状は編集中のみ TipTap、それ以外は単純な plain text。
  - **タイトル input が無い**（`StickyNode.tsx` は body のみレンダリングし、`title` プロパティが UI から編集できない）。
  - **帰属バッジ `✦` / `◐` / Chat 由来バッジ `💬` 未実装**（設計書 293-305 行）。
  - サイズは幅 200px（設計書 240px）、`maxHeight` 編集時 480px / 非編集時 280px（設計書 600px 内部スクロール）。
- ✅ ノードドラッグ・座標保存 — `useMapPositionPersistence.ts`
- ✅ ズーム・パン — React Flow 標準
- 🟡 既存 Codex/Scene/Snippet/Note の手動追加 — パネル右クリック「Add to Map ▸」とパレット `[▾Add…]` は完（`TreeContextMenu.tsx:303-329` / `EntryContextMenu.tsx:196-210` / `SnippetContextMenu.tsx:221-235` / `MapPalette.tsx:82-136` / `AddToMapPickerDialog.tsx`）。**Map 空白右クリックメニュー（`Add Scene…` 等）は未実装**（`MapCanvas.tsx:1160` で `onPaneContextMenu={(e) => e.preventDefault()}` のみ）。
- 🟡 Scene / Codex / Snippet / Note ノード — Compact 表示完。ただし:
  - **Codex ノードに summary 先頭 40 文字が常時表示**（`CodexNode.tsx:80-89`）。設計書 378 行はホバーツールチップへ退避する規定。
  - **Snippet ノードの先頭 40 文字抽出が ProseMirror JSON の生文字列 `s.content.slice(0, 40)` で行われている**（`SnippetNode.tsx:16`）。設計書 391・1310-1316 行が求めた「JSON 走査で最初の text ノード」抽出が未達。
  - **ホバーツールチップは未実装**（HTML `title` 属性のみ）。
- ✅ Derived edges: Codex 親子 — `useMapEdges.ts:82-92`
- ✅ ダブルクリックで Editor / Codex / Snippets 連携 — `useMapCallbacks.ts`
- ✅ `Remove from this board` — `useMapContextMenu.ts:93-139`、`NodeContextMenu.tsx:229-234`

### Phase B 詳細

- 🟡 User edges — forward/backward ラベル・style・color・direction・floating endpoint 計算（`UserEdge.tsx`、`edges/floatingEdge.ts`、`EdgeContextMenu.tsx`、`mapApi.ts:945-1004`）はすべて動作。ただし **補助ラベル配列 `labels` は DB カラムのみで UI が無い**（`mapApi.ts:774,971` で常に `"[]"`）。**ドロップ時のラベル即時インライン入力**（設計書 516 行）も未実装で、描画後にダブルクリックして編集する流れ。
- ✅ Frames 作成・移動・リサイズ — `nodes/FrameNode.tsx`、`hooks/useFrameDrawing.ts`、`hooks/useFrameGroupDrag.ts`、`mapApi.ts:1006-1066`。`useMapNodes.ts:157-210` で `show.frames && mode === "free"` のときのみ表示。
- 🟡 検索バー・ミニマップ — 両方実装あり（`MapSearch.tsx`、`MapCanvas.tsx:1180-1182`）。ただし:
  - **検索対象が `title`/`synopsis` 限定**（`MapSearch.tsx:38-39`）。Sticky body / Codex content / Snippet content / AI Branch prompt は引っかからない（設計書 762-768 行の網羅範囲未達）。
  - **ヒット時のキャンバス上ハイライト（黄色）未実装**（ビューポート移動 + 選択のみ）。
- ✅ Sticky → Scene/Codex/Snippet/Note 昇格 — `mapApi.ts:540-641`、`NodeContextMenu.tsx:195-225`。authorship_spans の `sticky_id` → 新エンティティ ID への張り替えあり。
- ✅ Frame → Codex 昇格 — `mapApi.ts:1075-1185`、`MapCanvas.tsx:463-489`、`NodeContextMenu.tsx:102-126`。内包 Sticky body を ProseMirror JSON として連結し、`title` を H3 として挿入。authorship_spans を offset 調整して新 Codex に移植、Frame 中心に新 Codex ノード position を作成。設計書 332-338 行に一致。
- 🟡 Derived edges 全種 — Codex 親子 / Scene 言及 / Phase アンカーは設計通り（`useMapEdges.ts:82-141`）。**Snippet 出処エッジ（設計書 491 行）は接続先が異なる**: 設計書では Snippet ノード ↔ 出処 Scene の薄い点線だが、実装は `useMapEdges.ts:143-170` で Snippet が言及する Codex への edge を `snippet-origin:` プレフィックスで描画。両端ノードが両方ボードにいる時のみ描画する原則は維持。200 ノード閾値での自動 OFF は機能（`useMapEdges.ts:81` で条件分岐）。
- ✅ Color by (None / Status / Sticky color) — `mapStore.ts:18,68,82`、`MapHeader.tsx:381-396`、`types.ts:10`
- 🟡 Visual theme: Default / Corkboard feel — `mapStore.ts:19,69,83`、`MapHeader.tsx:397-411`。Corkboard は `useMapNodes.ts:216,239` でカード微傾き（`±0.5deg`）+ `MapCanvas.tsx:1120,1140,1176` の背景処理あり。スキューモーフィックな質感の詰めは余地あり。

### Phase C 詳細

- 🟡 AI Branch ノード — 種からの Sticky 撒き（`mapApi.ts:653-805`、放射状配置、各 Sticky に `ai` authorship span を自動付与、branch→sticky の dashed エッジ生成）、`AINodeDialog.tsx` のプロンプト + 生成数（3/5/8）選択 UI、`×` ワンクリック削除（`AIBranchNode.tsx:33-62`、確認ダイアログなし即削除）、`ON DELETE SET NULL` による派生 Sticky の orphan 保持はすべて動作。**フルスナップショット undo/redo**（`mapApi.ts:811-943` の `getAiBranchSnapshot` / `restoreAiBranchSnapshot` / `eraseAiBranchSnapshot`）は branch row + position + 派生 sticky + position + dashed edges + authorship spans まで一括復元できる設計超えの実装。
  - **未達**: `MapCanvas.tsx:1046-1052` で `createAiBranch` 呼び出し時に `sessionId` を渡していない。`mapAiApi.ts:86-92` の `send_chat_message` 呼び出しも session を発行・返却しないため `map_ai_branches.session_id` は恒常的に null。結果、`useMapNodes.ts:441-445` のダブルクリック → Chat ジャンプ条件に入らない。
  - **未達**: `Delete with all derived stickies` サブメニュー（設計書 470 行）。
- ✅ Theme モード（d3-force + Web Worker）— `layouts/theme.ts`、`layouts/forceEngine.ts`、`layouts/forceLayout.worker.ts`、`layouts/index.ts:28-38`
- ✅ Hybrid（Pin/Unpin）— `layouts/index.ts:6-20` の `applyPinnedOverrides`、`mapApi.ts:404-409` の `setNodePinned`、`NodeContextMenu.tsx:136-138`、`Ctrl+P`（`useMapKeyboard.ts:158-163`）
- ✅ Auto-arrange: Force-directed compact — `layouts/autoArrange.ts:63-86`

### Phase D 詳細

- ✅ Focus モード（選択 + 1 次接続のみ表示 / 他は opacity 0.15）— `hooks/focusNeighbors.ts`、`useMapCallbacks.ts` の `nodesWithFocus`
- ✅ SVG / PNG / JSON エクスポート — `mapExport.ts`（`buildMapSVG` / `svgToPngBlob` / `buildMapJSON`）、`hooks/useMapExport.ts`、`MapHeader.tsx:433-441`
- ✅ Sticky Branch（隣に新規 Sticky を生やしてエッジ自動接続）— `MapCanvas.tsx:917-1000`、`NodeContextMenu.tsx:186-193`
- ✅ Auto-arrange: Grid by reading-order — `layouts/autoArrange.ts:44-60`、`hooks/useMapAutoArrange.ts`

### Phase E（v2 想定 / 未着手）

- ⬜ Codex Relation テーブル新設 + User edge → Relation 昇格
- ⬜ Constellation visual theme（`visualTheme === "constellation"` の値だけ受け付け実体未実装）
- ⬜ POV / Tag による Color by（`tree_nodes.pov_character_id` 列の追加が前提）
- ⬜ World map overlay
- ⬜ 全ボード横断検索
- ⬜ Map から Grid / Matrix へのクロスナビゲーション

### DB スキーマ差分

- **`map_stickies.color`（8 色 enum）→ `palette_id` + `color_slot` の 2 カラム構成に置換**（`migrate.rs:1068-1120` の one-shot migration）。`src/lib/stickyPalettes.ts` ベースの任意パレット選択方式に拡張されている。設計書 894-895 行の 8 色固定 enum 制約は実装で緩和済。設計書スキーマ定義（894-906 行）を実装に合わせて更新する余地あり。
- ✅ `authorship_spans.sticky_id` カラム・polymorphic CHECK 制約 — `migrate.rs:881` で実装済
- ✅ `map_edges.forward_label` / `backward_label` / `labels` / `style` / `color` / `direction` — すべて設計通り
- ✅ `map_node_positions.pinned` / `z_index` — 設計通り

### 設計書外の追加実装

- **Trash Bin 連携** — Sticky 削除時にゴミ箱へ転送するフロー（`MapCanvas.tsx:20-22,317-323,1125-1134` の `useDropTarget` / `captureMapStickyDeletion`）。設計書には未記載だがアプリ全体のゴミ箱機能と整合させるため追加されている。
- **AI Branch full-snapshot undo/redo** — 上記 Phase C 詳細参照。設計書要求を超える堅牢性。
- **グローバル統合 Undo スタック採用** — Map ローカル Undo は持たず、`useGlobalHistoryStore` に `kind: "map"` で push する統合スタックを使用。設計書 1305-1307 行の「他パネル独立スタック」とは異なる設計判断。

### デッドコード / 整理候補

- `src/features/map/nodes/AINode.tsx` — 旧 AI ノード（response 表示型）。`MapCanvas.tsx:113` は `AIBranchNode` を登録しており本ファイルは未参照。整理候補。

---

## 実装フェーズ

### Phase A: マインドマップ基盤（最小動作）

- `map_boards` / `map_node_positions` / `map_stickies` テーブル追加
- 複数ボード対応（一覧・追加・削除・リネーム・複製）
- Free モード
- **Sticky ノード**（空白ダブルクリック / `S` キー / パレットで追加、インライン編集、色変更、削除）
- ノードドラッグ・座標保存
- ズーム・パン
- 既存 Codex/Scene/Snippet/Note の手動追加（各パネル右クリック「Add to Map ▸」+ Map パレット `[▾Add…]`）
- Scene/Codex/Snippet/Note ノード（Compact のみ、ホバーツールチップで詳細）
- Derived edges: Codex 親子のみ
- ダブルクリックで Editor / Codex / Snippets 連携
- `Remove from this board` メニュー

### Phase B: 関係性と昇格

- User edges 描画・編集・削除（**双方向ラベル + 多重ラベル**対応）
- Frames 作成・移動・リサイズ
- 検索バー・ミニマップ
- **Sticky → Scene/Codex/Snippet/Note の昇格動線**
- **Frame → Codex の昇格動線**（内包 Sticky body を Codex content に集約）
- Derived edges 全種（Scene 言及・Phase アンカー・Snippet 出処）
- Color by (None / Status / Sticky color)
- Visual theme: Default / Corkboard feel

### Phase C: AI と Theme

- **AI Branch ノード**（種から Sticky を撒く、Chat セッション連携、`×` ワンクリック削除）
- Theme モード（d3-force + Web Worker）
- Hybrid 挙動（Pin/Unpin）
- Auto-arrange: Force-directed compact

### Phase D: 高度な機能

- Focus モード（選択 + 1 次接続のみ表示）
- SVG / PNG エクスポート
- Sticky Branch（隣に新規 Sticky を生やしてエッジ自動接続）
- Auto-arrange: Grid by reading-order

### Phase E: v2 拡張

- **Codex Relation テーブル新設 + User edge → Relation 昇格動線**
- Constellation visual theme（Starchart エクスポート）
- POV / Tag による Color by（`tree_nodes.pov_character_id` 追加が前提）
- World map overlay
- 全ボード横断検索
- Map から Grid / Matrix へのクロスナビゲーション

---

## Visual Theme: Constellation スキン（v2 拡張）

旧設計から大きくは変えない（Sticky / AI Branch のメタファー対応を追加）。

**Constellation スキンでのメタファー対応（追加分）**:

| Map の概念 | Constellation 表現 |
|----------|------------------|
| Sticky ノード | 流星跡（短い光の筋、色は本人カラーを低彩度化） |
| AI Branch ノード | 超新星（中心の輝点 + 放射状の細光線、各 Sticky への接続線が光線として描画される） |

その他のメタファー（Scene = 星、Codex character = 恒星 など）と enable 条件・アニメーション・Starchart エクスポートは旧設計から踏襲。

---

## 未解決の検討事項

### 1. Sticky body のサイズ制約

旧設計の plain text 500 文字上限は撤廃（ProseMirror 化に伴い文字数定義が曖昧になるため）。代わりに**高さベースの制約**で運用：

- ノード高さ 400px を超えたら「Sticky が長くなっています。Note / Snippet への昇格を検討」のヒント表示
- 600px で内部スクロール開始（カード自体はそれ以上伸びない）
- 強制切り詰めはしない、判断はユーザーに委ねる

### 1b. TipTap minimal インスタンスのマウント数とパフォーマンス（Phase A 実装ガード）

Sticky を 100 個マウントすると TipTap インスタンス 100 個になり、メモリ・初期化コストが Map 全体の動作可否を左右する。React Flow の virtualization（ビューポート外は unmount）に頼るだけでは、ボード全体ズームアウト時に全 Sticky が同時マウントされるため不十分。

**Phase A での実装ガード（必須）**:

1. ビューポート内の Sticky 数を計測し、**50 個を超えたら static HTML フォールバック**に自動切替
2. static HTML 側でも Codex highlight・authorship 色付けは事前計算で描画（情報量を落とさない）
3. ノードを選択 / ダブルクリックした瞬間にそのノードだけ TipTap インスタンスをマウント（編集モード起動）
4. 50 個閾値はフィーチャーフラグで調整可能にし、Phase A 実測でチューニング

**未編集 / 編集経験ありの区別**: 編集セッション中だけ TipTap を保持し、離脱時に static HTML に戻す案も検討余地あり。実測で判断。

この実装ガードは Phase A の必達要件として位置づける（性能未検証のまま Sticky 体験を損なわないため）。

### 1c. Sticky body の `preview_text` 再生成

`preview_text` は保存時にフロントが抽出してキャッシュ。マイグレーション後の既存 Sticky（v1 テーブル新設のため発生しないが、他経路で migrate した場合）は NULL から始まる。次回保存で自然に埋まる lazy パターン。

- Codex / character の rename で Codex ハイライトが変わっても `preview_text` の text 内容は不変なので影響なし
- body の table / image しか含まない Sticky は `preview_text` が `(table)` `(image)` 等のフォールバック文字列になる

### 2. AI Branch の生成数とコスト

5 個生成がデフォルト。多すぎると盤が散らかり、少なすぎると役に立たない。

- 3/5/8 から選択可能（v1）
- ユーザーがどれを使うか観察してデフォルトを再評価
- 「気軽に削除して撒き直す」前提のため、`×` ワンクリック削除 UX とセットで運用する想定

### 3. AI Branch の文脈サイズ

種ノード + 周辺ノード（接続エッジで繋がるもの 1 次まで）を文脈として渡す。多すぎるとトークン超過。

- 文脈ノード数の上限を 20 に固定（v1）
- ユーザーが「文脈に含めるノード」を明示的に指定できる UI（v2）

### 4. Sticky の色とパレットの共有

8 色固定パレットは Label（Grid）の色パレットと重複させるべきか。

- 案 A: 独立（Sticky は手書き感のある暖色系中心、Label は分類用の彩度高め）
- 案 B: 共有（一貫性）

**暫定**: 案 A。Sticky は「付箋」のメタファーで暖色系（黄/オレンジ/ピンク）が中心。Label は「分類タグ」で彩度高めの 12 色。

### 5. ボード間の Sticky 移動

ボード A の Sticky をボード B に移したい場合、現状は手動コピペ相当の操作しかない。

- 案: コンテキストメニュー `Move to board ▸` で `board_id` を更新。座標は新ボード中央にリセット
- v2 検討

### 6. User edge → Codex Relation 昇格の双方向性

Map で引いた User edge を Codex Relation に昇格できるが、逆（Codex で作った Relation を Map に Derived edge として降ろす）は自動。一貫性は取れるが、Map で引いた User edge と Codex 由来の Derived edge が同じ関係を二重描画する可能性。

- 昇格時に元 User edge を削除し、以降は Derived edge として描画する（前述）
- ただし Codex 側で Relation を削除した場合、Map の Derived edge も消えるが「元々ユーザーが引いたエッジ」の情報は失われる
- v2 で Codex Relation の削除時に「Map の元 User edge を復元するか」確認ダイアログを出す案

### 7. As AI Branch の Chat セッション共有のトレードオフ

Chat → Map の `As AI Branch` は元の Chat session_id を継続して分解再投する仕様（Chat 側にも分解再投メッセージが残る）。これは「議論の流れ全体を Chat に保ち、Map では分解結果だけ見る」という相互参照のための意図的なトレードオフ。

- メリット: 元の議論 + 分解結果の両方が 1 セッションに連続して残る、Map ノードからのジャンプで全体が見える
- デメリット: ユーザーの Chat 履歴に「この応答を N 個に分解して」という system-like な再投プロンプトが混在する
- 代替案（v2 検討）: 分解再投を hidden subsession に隔離し、Chat 履歴上は表示しない。AI Branch ノードからは両方見える
- v1 は同 session 共有のまま運用し、ユーザー反応次第で v2 で hidden subsession 化を検討

### 8. ノード密度のスケーラビリティ

複数ボード化により 1 ボードあたりのノード数は減る想定だが、それでも長編で 1 ボードに 100 Sticky が散ることはあり得る。

- React Flow の仮想化（ビューポート外ノードは描画スキップ）に依存
- 1 ボード 200 ノードを警告閾値、500 を上限として推奨（強制はしない）

### 9. Sticky の Undo/Redo

空白ダブルクリックで Sticky が量産される性質上、誤クリックでの Sticky 量産が起きる。

- `Ctrl+Z` で直近の Sticky 追加を取り消し
- Map 操作の Undo スタックは 50 件、Sticky 追加・削除・座標移動・編集・色変更を含む
- 他パネルの Undo（Scenes ツリー操作など）とは独立スタック

### 10. Snippet ノードの先頭テキスト抽出

`snippets` テーブルは title カラムを持たず content のみ（ProseMirror JSON）。Map ノード上での 40 文字表示は ProseMirror 走査で先頭の text ノードを取得する。

- 画像・テーブルなどテキスト以外の要素から始まる Snippet は「(media-only snippet)」表示にフォールバック
- content の先頭 200 文字程度をフロント側でキャッシュするか毎回パースするかは性能次第で判断（v1 は毎回パース、ノード数 100 程度までなら問題ない想定）
- Snippet 数が多くなる場合、`snippets.preview_text` カラムを追加して保存時に抽出する案も v2 で検討

### 11. Frame 内の Sticky をフレーム外に出す挙動

Sticky を Frame 外にドラッグした場合、内包判定（中心位置）から外れる。

- Frame の内包判定は表示時の動的計算（DB 保存しない、旧設計踏襲）
- ドラッグで外に出れば自動的に内包から外れる
- `Promote frame to Codex` 実行時の内包判定はその時点のスナップショット

---

## Matrix パネル連携

Matrix パネル（[設計書](./Grimodex_Matrixパネル設計書.md)）は Map と同じ「2 次元」だが用途が異なる：

- **Map**: 連続座標、関係の発見・**探索的**・思考の枝を生やす
- **Matrix**: 離散カテゴリのクロス表、登場分布の**監査的**

両者は別パネルとして共存する。

### 言及スキャン結果のキャッシュ共有

Matrix Phase A で新規追加される `scene_codex_mentions` キャッシュテーブルは、Codex 名/alias 変更時のキャッシュ再構築を Map と Matrix で共通化できる。Map 側は v1 では現行のメモリ計算のままで、キャッシュテーブルの利用は v2 以降の最適化として検討する。

### Matrix への Show in Matrix 動線（v2）

Map のシーンノード右クリック → 「Show in Matrix」で、Matrix が該当シーン行にスクロールする動線を v2 で追加検討。
