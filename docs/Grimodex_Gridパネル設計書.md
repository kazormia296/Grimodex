# Grimodex Gridパネル設計書

## 概要

Grid パネルはプロジェクト内の **Chapter ごとの Scene カード列**を一覧する作業ビュー。Novelcrafter の Grid（Plan セクションの3ビューのうちの1つ）に相当する。Scenes パネル（ツリー構造）、Timeline（時間軸）、Map（2D空間）、Matrix（クロス表）と並ぶ第5のマクロビュー。

各 Chapter（`tree_nodes.node_type = 'folder'`）が縦の列になり、その配下の Scene が**インデックスカード**として縦に積まれる。1枚のカードに Synopsis・Unplaced beat の冒頭・Codex チップ・Label が見えるため、章単位で「何が起きているか」を一望できる。

```
Scenes:    ツリー1行       — 構造管理（読み順・名前変更・移動）
Timeline:  1次元・時間軸   — story-time の俯瞰
Map:       2D・手動配置    — 探索（Sticky で発散 → 構造化）
Matrix:    クロス表        — シーン × Codex の登場分布
Grid:      Chapter 列      — 章単位の Scene 構成・編集（本パネル）
```

デフォルト位置: Bottom Dock（非表示）。Center スプリット運用に向く（カードを1〜2列見ながら Editor 編集）。

設計思想: **既存の `tree_nodes` ツリーを「親フォルダの直接の子フォルダ」を列、「孫の Scene」をカードとして描き直すビュー。新規データモデルは持たない。**

### Map との役割分担

Grid と Map はどちらも「Scene を 2 次元で見る」点で似ているが、**情報密度と用途が真逆**：

| 観点 | Grid | Map |
|------|------|-----|
| 表示するシーン | 選択 container 直下の全シーン（自動） | 手動で追加したシーンのみ |
| 1 ノードの情報量 | 詳細（Beat / POV / Codex / Label / Foreshadow） | 軽量（タイトル + Status 色のみ） |
| 主用途 | 確定したカードの並べ・章俯瞰 | 未確定のアイデア発散・関係描き |
| 配置 | Chapter 列に自動整列 | ユーザー手動 |

**Grid = 確定したカードを密に俯瞰する盤、Map = 思考の枝を生やす盤**。Map のシーンノードは Grid のサブセットでも上位互換でもなく、意図的に簡素化されている。詳細は Map パネル設計書「他パネルとの役割分担」参照。

---

## 目標 / 非目標

### 目標

- Chapter 単位で Scene の構成（順序・追加・削除・移動）を視覚的に編集できる
- 1枚のカードで Scene の概要（Synopsis / 主要 beat / Codex / Label）を把握できる
- D&D で Scene の並べ替え・別 Chapter への移動が直感的にできる
- 「この Chapter にあと1シーン足したい」「このシーンは別章に移したい」をすぐ実行できる
- Scenes パネルがツリー構造の管理を担うのに対し、Grid は「カード並べ作業」に特化する

### 非目標

- Scene 本文の直接編集（インライン Synopsis 編集を除く。本文編集は Editor で行う）
- 複数階層の同時表示（1ビュー = 1階層深さに固定。深いネストは container 選択で潜る）
- AI による Scene 自動生成（Phase B 以降の検討、Matrix と共通の AI 経路を再利用）

---

## 背景・設計判断

### なぜ Scenes パネルと別パネルにするか

Scenes パネルは**ツリー1行表示**で、構造管理（rename / delete / move / 階層変更）に最適化されている。一方 Grid は**1 Scene = 1カード**で情報密度が異なる：

| 観点 | Scenes | Grid |
|------|--------|------|
| 1 Scene の表示面積 | 1行（数十 px） | カード（数百 px²） |
| 主用途 | 構造管理 | 内容把握＋カード並べ |
| 同時表示数 | 100〜500 シーン | 数十シーン（章単位） |
| D&D 主目的 | 階層変更・順序 | 順序・章間移動 |

Scenes に「カードビュー切替」を追加する案も検討したが、ツリー操作とカード操作は UI 慣性が異なる（クリックでツリー展開 vs クリックでカード詳細）ため、パネルとして分離する。

### なぜ Matrix とも別パネルにするか

Matrix は「シーン × Codex のクロス表」で**1セル = 1 ビット（●）**の情報密度。Grid は「Chapter 列 × Scene カード」で**1セル = 1カード（数百 px²）**の情報密度。両者は同じ「2次元」だが、扱える scene 数も用途も違う：

| 観点 | Matrix | Grid |
|------|--------|------|
| 扱える規模 | 数百シーン × 数十 Codex | 数十 Scene（1〜2 章ぶん） |
| 1セルの情報量 | 1 bit | カード全体 |
| 用途 | 登場分布の俯瞰・監査 | 章単位の Scene 構成・編集 |

Novelcrafter は Matrix セルに Scene カードを埋める設計だが、**500シーン規模では情報過多**で実用に耐えない。Grimodex は Matrix（俯瞰）と Grid（作業）を分離する。

### なぜ「親フォルダの直接の子」を列にするか

Grimodex のツリーは任意深さ（Part > Chapter > Sub-chapter > Scene 等）を許容する。Grid は1ビュー = 1階層深さに固定し、選択した container（親 folder）の**直接の子フォルダ**だけを列にする。理由：

- 階層を跨ぐと UI 複雑度が指数的に増える
- 「Part 1 を見る → Part 1 配下の Chapter が列」という単純なメンタルモデルを維持
- 深い階層を見たい場合は container 選択で潜る（breadcrumb で戻れる）

選択 container 直下に Scene が直接ぶら下がっている場合（章なしフラット構造）は、それらを単一の仮想列「`Scenes`」にまとめて表示する。

---

## パネル構造

```
┌───────────────────────────────────────────────────────────────────┐
│ A. ヘッダー                                                        │
│ Grid / 🏠 ▸ Part 1 ▸ Act 1 ▾    3 章    🔍  ⇕  [表示・フィルタ▾] ⋮│
│ (任意) Container Outline バー — dive-in 中の folder.synopsis を表示│
├───────────────────────────────────────────────────────────────────┤
│ B. カード列                                                        │
│ ┌─導入部 (平穏な日常)─┐  ┌─転機 (インサイティング)─┐  ┌─新たな状況─┐│
│ │ Scene 1         ✏ ⋮│  │ Scene 1            ✏ ⋮│  │ Scene 1 ✏⋮ ││
│ │ • 義妹との日常を見る│  │ • 門兵部隊が宿舎を襲撃 │  │ • 無人兵器を││
│ │ • ライカに目覚まされ│  │ • 宿舎で無人兵器を拘束 │  │   撃退するも││
│ │                    │  │                       │  │ • 旧市街教会││
│ │ [エノス×][スネジン..│  │ [門兵部隊][宿舎][無人..│  │ [教会][宿舎]││
│ │ + Codex   🏷 Label │  │ + Codex   🏷 Label    │  │ + Codex 🏷 ││
│ ├────────────────────┤  ├───────────────────────┤  ├────────────┤│
│ │ Scene 2         ✏ ⋮│  │ + New Scene           │  │ + New Scene││
│ │ ほげ                │  │                       │  │            ││
│ │ [ストレルカ ×]     │  │                       │  │            ││
│ │ + Codex   🏷 Label │  │                       │  │            ││
│ ├────────────────────┤  └───────────────────────┘  └────────────┘│
│ │ + New Scene        │                                            │
│ └────────────────────┘                                            │
├───────────────────────────────────────────────────────────────────┤
│ C. ステータスバー                                                  │
│ 3 chapters · 6 scenes · 12,400 chars · Last edited Scene 2        │
└───────────────────────────────────────────────────────────────────┘
```

---

## A. ヘッダー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Grid」 |
| Container セレクタ | 表示対象の親フォルダ。Home (🏠) アイコン + breadcrumb 表示（`🏠 / Part 1 / Act 1`、各セグメント直接クリック可能）+ ChevronDown ボタンでツリー型 Popover を開いて任意 folder を選択。Default はプロジェクトルート（`null`） |
| Chapter 数表示 | `{count} 章`（直下フォルダ数） |
| 🔍 検索 | クリックで展開する inline input。カード内テキスト（Scene 名 / Synopsis / placed + unplaced beat / Codex 名）でインクリメンタル絞り込み。マッチしないカードは `opacity-40` で半透明（フィルタ通過なら表示は残す） |
| ⇕ 全展開／全折りたたみ | `ChevronsUpDown` / `ChevronsDownUp` トグル。表示中の nested folder を一括展開／折りたたみ（dive-in しなくても章配下の章カードを開閉できる）。nested folder が無いとき非表示 |
| `[表示・フィルタ▾]` | 折りたたみツールバー（Display + Filter + カードタブ）の開閉。状態は `global-settings.json` の `toolbarOpen` に保存（pressed 時 accent 背景） |
| `[⋮]` アクションメニュー | ドロップダウン: Apply structure template ▸ / Manage labels... / Help (disabled) |
| `+ 章を追加` | 列群の末尾に縦書きの細いボタンとして表示（ヘッダーには出さない）。クリックで現 container 直下に新規 folder を作成し、すぐ列ヘッダがインライン編集状態になる |

### Container セレクタの動作

- クリックでツリー型ドロップダウン表示
- 選択した folder が新しい container になる
- 同 folder に階層が深い場合、breadcrumb が長くなる（`Project / Part 1 / Act 1` 等）
- 「←」ボタンで親 container に戻る
- 選択 container は **プロジェクトスコープ**で永続化（プロジェクト切り替えで別プロジェクトの ID を引きずらないため、プロジェクト ID をキーに含めて保存）
- 起動時に保存された ID が現プロジェクト内に存在しない場合（削除済み・別プロジェクト由来）はプロジェクトルートにフォールバック

### `[表示・フィルタ▾]` 折りたたみツールバー（ビュー状態のクイック切替）

`[⋮]` ドロップダウンとは役割を分離し、**頻繁に切り替える表示状態**だけをこのツールバーに集約する。ボタン押下で開閉、状態は `global-settings.json` に保存（プロジェクト横断）。

```
表示: ☑Synopsis ☑Beat ☑Codex ☑Status ☑Label ☑伏線 ☐Compact   カードタブ: [Auto|Beat|Synopsis]
フィルタ: [🔴 ラベル1] [🔵 ラベル2] ...   Codex: [All ▾]    ☐空のみ ☐完成を非表示  [クリア]
```

| グループ | 項目 | 既定 |
|---------|------|------|
| Display | Synopsis 表示 | ON |
| Display | Beat 表示 | ON |
| Display | Codex チップ表示 | ON |
| Display | Status ラベル文字表示（既存 `showStatusLabel`、旧 `showLabel`） | ON |
| Display | Label カラーバー表示（新規 `showLabelBar`） | ON |
| Display | Foreshadow indicator 表示 (`showForeshadow`) | ON |
| Display | コンパクト表示 (`compactCards`) | OFF |
| カードタブ | 全カードのタブを同期するモード (`cardTabMode`: `auto` / `beat` / `synopsis` の segmented control) | `auto` |
| Filter | Label フィルタ（複数選択 OR、各ラベル色で塗られた Pill 行） | `[]` |
| Filter | 特定 Codex を含む Scene のみ（Select ドロップダウン） | `null` |
| Filter | 空の Scene のみ | OFF |
| Filter | 完成済み Scene を非表示 | OFF |

> **設計との差異**: Label フィルタは当初 Backlog で「Label 選択ドロップダウン」と書いていたが、ラベルが色情報を持つため Pill 行（`TagFilterBar` 準拠）に変更済み。色視認性と複数選択 OR の操作性を優先。

### `[⋮]` アクションメニュー（ドロップダウン）

`[⌃]` ツールバーが**ビュー状態**を扱うのに対し、こちらは**操作・遷移を伴うアクション**を集める。`MoreVertical` アイコン押下で popover 形式のドロップダウンを表示。

```
Apply structure template  ▸  ─┐ 構造テンプレート（Chapter/Scene 骨格を一括生成）
─────────────
Manage labels...               ─ ラベル管理
─────────────
Grid の使い方                    （Help）
```

`Apply structure template ▸` のサブメニューは構造テンプレート節（後述）を参照。

---

## B. カード列

### 列（Chapter）

- 1列 = 1 Chapter（`tree_nodes.node_type = 'folder'`）
- 列ヘッダ: **`GripVertical` ドラッグハンドル**（hover で fade-in） + Chapter 名（double-click でインライン rename）+ シーン件数バッジ。ヘッダ全域に drag listener を貼っていた初期実装はタイトルクリックと drag の意図が衝突したためハンドル単独へ移行
- 列ヘッダ直下に Chapter の Outline (`folder.synopsis`) を 2行 line-clamp 表示 + double-click でインライン編集（**実装済み, Phase 4 後続**）— このテキストは chat の chapter outline 注入経路にも乗る
- 列内のカードは `tree_nodes.sort_order` 昇順で縦に並び、scene カードと**ネストされた子 folder カード**が混在表示される（下記「フォルダカード／dive-in」参照）
- 列末尾に `+ シーンを追加` ボタン
- 列幅は Compact OFF で 320px (`w-80`)、Compact ON で 224px (`w-56`)。横スクロールで複数列を見る
- ドラッグハンドル D&D で Chapter の並び替え（同 container 内）
- **右クリック → コンテキストメニュー (`GridChapterColumnContextMenu`)**: 「中を表示（dive-in）/ シーンを追加 / リネーム / 削除」。**リネームはインライン edit に切替**（`useTreeStore.setPendingRenameId(folderId)` を呼んでヘッダ title を input にスワップ。Dialog は使わない — タイトル double-click と同じ即時編集体験に揃える）。削除のみ Radix Dialog で確認（章配下の scenes も巻き添えで消えるため）。Chapter 列にはヘッダの kebab は持たせず（rename/delete は新規追加機能で、ヘッダの混雑を避けるため context menu のみで提供）

### `+ 章を追加`（カラム末尾の縦書きボタン）

設計書当初はヘッダーに `[+ New Chapter]` ボタンを置く想定だったが、実装では **列群の末尾に縦書きの細いボタン**（`writing-mode: vertical-rl`、幅 14px、`＋ 章を追加`）として配置済み。理由 — ヘッダーは breadcrumb + 検索 + 表示・フィルタ切替 + アクション `[⋮]` で混雑するため、列追加は「列の続きに足す」物理メタファに寄せたほうが直感的。

列が0件のときはこのボタンを出さず、代わりに**中央に大きな Structure Template Picker ボタン**を表示（最初の Chapter を作る前の空状態で「テンプレートから始めるか手で作るか」を提示）。

### フォルダカード／dive-in（実装済み, Phase 4 後続）

任意深さのツリー (Part > Chapter > Sub-chapter > Scene 等) を Grid で扱うため、chapter 列の中に**ネストされた子 folder を `GridFolderCard` として表示**する設計を導入済み。当初設計の「1ビュー = 1階層深さに固定」を緩和し、**「直下の scene + 子フォルダ + 孫の scene (展開時)」を 1列の中に depth indent で並べる**形になった。

**フォルダカード (`GridFolderCard`)**:

- 点線ボーダー + folder アイコン + フォルダ名。**folder アイコン／タイトル領域のクリックで dive-in**（containerId をそのフォルダに切替）
- 先頭の `▸ / ▾` ChevronRight でカード内の **展開／折りたたみ**を切替（既定: 展開）。折りたたみ時はカード下に `{n} シーン · {n} フォルダ` の件数を表示
- chevron と folder アイコンの間に **`GripVertical` ドラッグハンドル**を独立配置。hover で fade-in、ハンドルのみが drag listener を持つので、タイトル領域は純粋に dive-in 起動用となる（drag と click の責務分離。当初は title 全体に drag listener を兼用させていたが、click vs drag の意図が曖昧でユーザーが「どこから掴めるか」分からなかったため分離）
- カード本体に `folder.synopsis`（Outline）を 2行 line-clamp + double-click でインライン編集
- depth に応じてカード左に `12px × depth` の indent を入れる（`GridDescendant.depth`）
- 空 folder は ChevronRight を disabled（折りたたみ意味なし）
- **右クリック → コンテキストメニュー (`GridFolderCardContextMenu`)**: 「中を表示 / 折りたたみ・展開 / リネーム / 削除」。**リネームはインライン edit**（`useTreeStore.setPendingRenameId(folderId)` 経由でカード title を input にスワップ。フォルダカードも `pendingRenameId === folder.id` を effect で監視して edit に入る）。削除のみ Radix Dialog で確認

**展開状態の管理**:

- `collapsedFolderIds: Set<string>` を `gridStore` の session-only state として保持（永続化しない、デフォルト全展開）
- カード単位の `▸ / ▾` トグル → `toggleFolderCollapsed`
- ヘッダの `ChevronsDownUp / ChevronsUpDown` トグル → 表示中の全 nested folder を一括展開／折りたたみ (`expandAllFolders` / `collapseAllFolders`)

**dive-in / dive-out**:

- フォルダカードをクリック → `setContainerId(projectId, folder.id)`。breadcrumb の Home / 親リンクで dive-out
- dive-in 中はその folder 自身が **container 列** (`GridContainerSceneColumn`) として実線で描画され、folder.title + folder アイコンがヘッダに出る
- container folder の synopsis (outline) は列群の上に **`GridContainerOutline` バー**として横長に表示（folder 自身は dive-in 時に列／カードのいずれにもならないため、Outline がどこにも表示されないのを防ぐ）

### Scene 直接子（Loose / Container 直下シーン）

直下にぶら下がる scene の表現は、container が project root か folder かで分かれる:

| パターン | container | 列の種類 | 列の見た目 |
|---------|----------|---------|------------|
| Project root の orphan scene | `null` | `GridLooseColumn` | 点線、`未分類シーン` タイトル |
| Folder へ dive-in 中の直下 scene | folder id | `GridContainerSceneColumn` | 実線、folder アイコン + folder.title |

両方とも sortOrder で chapter 列と混ぜて並べる（`orderedColumns`、Scenes パネル順と一致）。

- 個別 Scene を D&D で別 Chapter 列にドロップして移動できる
- 仮想列の `+ シーンを追加` は container 直下に Scene を追加する（loose のまま / container 直下のまま）
- 仮想列ごと既存 Chapter にまとめる（`consolidateLooseIntoChapter`）／ Loose 列のみ新規 Chapter folder に変換（`convertLooseToChapter`）の一括操作は仮想列ヘッダの `[⋮]` メニューから利用可能
- Container 列では `新規章フォルダに変換` は意味的に noisy（dive-in 中の直下シーンを wrap し直すのは主要操作でない）ため、`既存の章にまとめる` のみ提示する
- **右クリック → コンテキストメニュー (`GridLooseColumnContextMenu`)**: kebab と同じ項目を提供（`変種=loose` → addScene / 既存の章にまとめる ▸ / 新規章フォルダに変換、`変種=container` → addScene / 既存の章にまとめる ▸）。これらの列は折りたたみ/dive-in が無く drag-and-drop されないため**ドラッグハンドルは持たせない**。kebab は既存 UI として残し、context menu と両立させる（scene card と同じ「両方残す」方針）

### カード（Scene）

各カードに表示する内容：

| 領域 | 内容 | データソース |
|------|------|--------|
| ヘッダ | Scene 名 (double-click でインライン rename) + Editor 起動ボタン + `[⋮]` メニュー | `tree_nodes.title` |
| ヘッダ直下 | POV chip 行（最大3人 + `+N more`） | `scene_beat_pov_cache` ∪ `tree_nodes.povCharacterId`（後述「POV chip」参照） |
| 本体（タブ切替） | Beat 箇条書き ⇄ Synopsis（タブで切替、後述「Beat / Synopsis タブ」参照） | `tree_nodes.unplaced_beat_preview` / `tree_nodes.placed_beat_preview` / `tree_nodes.synopsis` |
| 本体（中段） | Codex チップ（最大5件、Compact 時 3件） | `scene_codex_pins` |
| フッタ | Status バッジ + Foreshadow indicator + 文字数 | `tree_nodes.status` / `foreshadowStore` / `tree_nodes.char_count` |
| 左端 | Label カラーバー（縦） | `tree_node_labels` (M:N) → `labels` |

Codex チップは Phase B で editable 化済み (`+` → `PinEntryDialog`、`×` で削除）。Label カラーバーは設計通り左端の縦バー、`[⋮]` メニューに `Label を付ける ▸` チェックボックスサブメニュー。

#### Beat / Synopsis タブ（実装済み, Phase 4 後続）

設計書当初の「Beat 主表示・Synopsis 折りたたみ」案は、**Beat / Synopsis の 2タブ切替 UI** へ進化済み。Beat と Synopsis を**同時表示せず、タブで切り替えて見る**ことで、カード高さを安定させつつ両者の役割分担（Beat = 構造的計画、Synopsis = 叙述的要約）を保つ。

**UI**:

- Display トグルで Beat / Synopsis のいずれか一方しか有効化していない場合はタブ列を出さず、その body をそのまま表示
- 両方有効なら 2タブを表示し、各カードのデフォルトは「Beat に内容があれば Beat、なければ Synopsis」（per-card local state）
- Beat タブ tab label は `Beat · {count}` 形式、Synopsis タブは `Synopsis`。中身が空のタブはタブ自身を dim 表示
- 両方 Display オフ → 「空のシーン」プレースホルダー

**カードタブ同期モード**（`cardTabMode: "auto" | "beat" | "synopsis"`、`global-settings.json` に永続化）:

- `auto`（既定）: 各カードが独立してタブを記憶（local state）
- `beat` / `synopsis`: **全カードを一斉にそのタブへ固定**。クリック時のタブ切替も全カードへ broadcast
- 切替 UI は `[⌃]` ツールバーの Display 行末尾に 3-state segmented control として配置

**Beat タブの中身**:

- `placed_beat_preview`（本文に置かれた Beat の冒頭）と `unplaced_beat_preview`（Unplaced beats）を**両方 bullet 表示**
- 先頭 prefix で kind を識別: `placed` は `┃`、`unplaced` は `01`/`02`/... の番号
- 表示件数は最初 **3件** まで（`BEAT_VISIBLE_LIMIT = 3`）。超過分は `▾ 他 N 件` トグルで展開、`▴ 折りたたむ` で戻す（双方向）
- Beat 0件のときは「＋ Beat を追加」プロンプトのみ
- `unplaced` beat のテキストは double-click で**インライン編集**（`editUnplacedBeatFromGrid`、編集中は textarea を auto-resize、Enter 確定 / Shift+Enter 改行 / Esc 取消）。`placed` beat はカードからは編集不可（本文編集は Editor 側）
- bullet 一覧の下に `＋ Beat` 小ボタンで新規 Unplaced beat を追加（カード下部の textarea にフォーカス、`addUnplacedBeatFromGrid`）

**Synopsis タブの中身**:

- `<InlineSynopsisEditor>` を `triggerOn="doubleClick"` で配置。空のときは「＋ シノプシスを追加」プロンプト

> **設計との差異**: 当初設計は「Beat を主、Synopsis を折りたたみ副」の縦並びだったが、tab UI に変更した。理由 — (1) カード高さの安定（折りたたみは可変高で隣の列とずれる）、(2) 「Beat も Synopsis も覗ける」操作を 1クリックに統一できる、(3) 全カード同期モードで「今は Synopsis だけ俯瞰したい」のような視点切替が可能になる。

#### POV chip

ヘッダ直下に独立した行として、そのシーンの **effective POVs**（scene POV ＋ Beat 内 POV オーバーライド）を chip で並べる。Codex character chip との視覚混同を避けるため、Codex 行とは分離して描画する。

**データソース**:

- 第1ソース: `scene_beat_pov_cache (scene_id, pov_character_id)` — `extractBeatPovOverrides` が Beat ノードの明示 `pov` 属性のみを抽出してキャッシュ（属性なしで scene POV を継承する Beat はキャッシュに入らない）
- フォールバック: cache が空かつ `tree_nodes.povCharacterId` が set されている場合は scene POV のみ表示
- 両方 null（POV 未設定）の場合は POV chip 行ごと描画しない（領域も詰める）
- character 名は `codexEntries` を join して取得

**Effective POVs の構築ルール**:

- `effective = unique(scene POV + cache の POVs)`
- **scene POV を先頭固定**、後続は **character 名昇順**（locale-aware）
- cache に scene POV と一致する ID が含まれている場合は dedupe（重複 chip を出さない）
- Beat 設計書 `pendingBeatsContext.ts:69` の Beat ラベル省略ロジックと同じ思想

> **設計判断**: 「Beat 出現順」を採用しなかった理由 — `scene_beat_pov_cache` は `(scene_id, pov_character_id)` の M:N で**順序情報を持たない** PRIMARY KEY 構成。出現順を再現するには (a) cache に `first_seen_index` 列を追加して保存時に埋める / (b) 描画時に doc 再パース のいずれかが必要だが、(a) はマイグレーションコスト、(b) は cache の意義を損なう。Grid カードの POV 表示はあくまで「誰が登場するか」の俯瞰目的で、出現順の表現は Editor 側に任せるのが妥当と判断。

**スタイル（chip の見分け）**:

| 種類 | 見た目 | tooltip |
|------|--------|---------|
| scene POV | **塗り chip**（character タイプ色、文字白） | "Scene POV" |
| Beat 由来のみ | **アウトライン chip**（character 色を border、背景透明、文字 muted） | "POV used in beats only" |

**上限と多 POV の扱い**:

- chip 表示は最大3人。超過分は `+N more` バッジで省略
- バッジクリックでポップオーバーを開き、effective POVs の全員を一覧表示

**クリック挙動**:

- chip クリックで character codex 詳細パネルを開く（既存 Codex チップと同じ）
- POV の編集自体は Editor の SynopsisHeader で行う（Grid からの編集は提供しない）

**Cache 更新タイミング**（既存挙動の確認）:

- `EditorPane.tsx:472` / `LinearSceneBlock.tsx:102` のシーン保存時に `upsertSceneBeatPovOverrides` で完全置換（insert + 不在 ID の delete）
- character codex 削除時は schema の `onDelete: cascade` で cache 行も自動削除
- マイグレーション後に未編集の既存シーンは cache 空のまま。fallback で scene POV のみ表示され、次回保存で自然解消（`unplaced_beat_preview` と同じ lazy パターン）

#### Codex チップ

- `scene_codex_pins` のリレーションを表示（明示的に紐付けたもの）
- 言及スキャンによる暗黙の Codex は表示しない（チップ過多を防ぐ）
- チップ色は Codex タイプ別（character/location/item/lore）
- チップクリックで Codex 詳細パネルを開く

**Phase A**: 表示専用。`+ Codex` / `×` ボタンは表示しない（Codex 紐付けは Editor 経由）。

**Phase B**: `+ Codex` クリックで **Chat パネルの「📌ピン留め追加ポップオーバー」（Codex/Snippet タブ式検索 UI、Chat パネル設計書「コンテキストバー」「手動ピン留め」セクション参照）と同じコンポーネント**を再利用。選択した Codex を `scene_codex_pins` に追加。`×` クリックでリレーション削除（`scene_codex_pins` から行削除）。

#### Label カラーバー

ユーザー定義の色付きタグ。Scrivener corkboard 流の左端カラーバー方式で、カードの**横幅を一切食わずに**プロット線・テーマ・サブプロットを視覚的に追跡できるようにする。Codex chip（個別エンティティ参照）や Status バッジ（システム規定の進行状態）とは役割が異なる**ユーザー任意の分類軸**。

**設計方針サマリ**:

| 軸 | 採用 |
|----|------|
| カーディナリティ | 多対多（1 シーンに複数ラベル可） |
| 適用対象 | `tree_nodes` 全般（Scene + Folder。子伝搬なし） |
| 色 | 固定パレット 10〜12色（パレット slot 名で永続化） |
| デフォルト | 空スタート（テンプレート適用は opt-in） |
| Grid 表現 | 左端の縦カラーバー（複数は積む）+ ホバーで名前ポップオーバー |

**データモデル（新規）**:

```sql
CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,           -- パレット slot 名（'red'|'blue'|... 等）
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_labels_project_name ON labels(project_id, name);

CREATE TABLE tree_node_labels (
  node_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, label_id)
);
CREATE INDEX idx_tree_node_labels_node ON tree_node_labels(node_id);
```

**カラーパレット**: 固定 10〜12色を `src/lib/labelPalette.ts` に定数定義。dark/light 両モードで読みやすい彩度に調整。Status バッジで使う色とは別パレット（混同防止）。

**Grid カードでの表現**:

- カード**左端の縦カラーバー**（幅 4-6px、カード全高）
- 複数ラベルは縦方向に等分（2色なら半々、3色なら 1/3 ずつ）
- **4色以上の場合**: 最初の3色 + バー下端に小さな `+N` バッジ（直径 ~10px、背景 muted、文字白）を被せる。バッジクリック or バー全体ホバーでポップオーバーに全ラベル名一覧
- ラベル0件のシーンはバー領域そのものを描かない（カード幅は変えない、左 padding で吸収）

**列ヘッダ（Folder = Chapter）でのラベル表現**:

Label の適用対象は `tree_nodes` 全般のため、Chapter にもラベルを付与できる（「Act 1 = blue」のユースケース）。Grid 列ヘッダでの表現は：

- 列ヘッダ上端に**水平カラーバー**（高さ 4-6px、列幅いっぱい）
- 複数ラベル時は水平方向に等分（縦カラーバーの逆）
- 4色以上は最初の3色 + 右端 `+N` バッジ（縦バーと同じ規則）
- ホバーでポップオーバー、編集は列ヘッダ `[⋮]` メニューの `Add label ▸` から

**カード `[⋮]` メニューからの編集**:

- `Add label ▸` サブメニュー: 既存ラベル一覧から選択（複数選択可）
- `Manage labels...` リンク: パネル `[⋮]` の `Manage labels...` と同じモーダルへ

**Manage labels モーダル**（プロジェクトスコープ）:

- ラベル CRUD（追加・rename・色変更・削除）
- ドラッグで並べ替え（`sort_order` 更新）
- 削除時は使用中シーン数を表示して確認ダイアログ（「N シーンから外されます」）

**他パネルへの波及**:

| パネル | 表示 |
|--------|------|
| Grid カード | 左端カラーバー（プライマリ表現） |
| Scenes パネル | タイトル右に小色ドット |
| Editor SynopsisHeader | （Phase 後半）任意の小チップ |
| Filter UI | 各パネルで「ラベルでフィルタ」共通ドロップダウン |

#### Foreshadow indicator

伏線レジスタ（Phase 1〜5 実装済み）の情報をカードフッタに**健全性ドット + setup/payoff counter**として露出する。シーンごとの「仕込み×回収」の分布と、関連伏線の異常状態を一目で把握できるようにする。

**カードフッタの全体構成**（Label dots はフッタに置かず左端カラーバーに集約、フッタは3要素のみ）:

```
通常時:   [Status]  🟢 📌2 ✓1                    1,200 chars
Compact:  [Status]  🟢                            1,200 chars
0件時:    [Status]                                 1,200 chars
```

| 要素 | 意味 |
|------|------|
| 健全性ドット（✨/🟢/🟡/🔴/⚪） | このシーンに紐づく全伏線の derivedLabel から算出される状態 |
| 📌 N | このシーンが setup を持つ伏線の数（`foreshadow_setups.scene_id = sceneId`） |
| ✓ N | このシーンが payoff になっている伏線の数（`foreshadows.payoff_scene_id = sceneId`） |

**健全性ドットの色判定**（優先順位は上から）:

- 🔴 赤: 関連伏線に `needs_strengthening` / `critical_weak` / `orphan_payoff` が1つでもある
- 🟡 黄: 上記なしだが `planned`（setup ゼロ）が混在
- ✨ 黄金: 上記2つに該当せず、payoff 件数 > 0（このシーンで何らかの伏線が回収されている達成シーン）
- 🟢 緑: 上記いずれにも該当せず、関連伏線がすべて `seeded` or `paid`（setup 済みで進行中）
- ⚪ グレー: 関連伏線が `abandoned` のみ
- 0件シーン: ドット・counter 群すべて非表示（フッタに余白を残さず詰める）

**Compact モード時の縮退規則**:

- counter `📌N ✓N` を非表示にし、健全性ドット **1個のみ**に縮退
- ホバー時のポップオーバーは通常時と同じ内容を表示（情報損失なし）
- 縮退判定は `display.compactCards` フラグで切替

**ホバー挙動**:

ポップオーバーで関連伏線一覧を表示。setup と payoff を視覚的に分けて2セクション化：

```
Sets up:
  🌱 ○○の指輪
  ⚠ 隠された血脈
Pays off:
  ✓ 旧友の正体
```

各行は **derivedLabel アイコン + 伏線 title**。アイコンは `ForeshadowPanel` 既存のラベルスタイルを共有。

**クリック挙動**:

`ForeshadowPanel` を起動し、**このシーンに関連する伏線にフィルタ**して表示する。`foreshadowNavStore` 既存のフィルタ機構と連携（要確認、未対応なら拡張）。

**データ取得**:

新規 Tauri command は追加せず、既存 `foreshadowStore` の selector から派生：

- 前提: `foreshadowStore` がプロジェクト全 foreshadow + setups を保持している（要確認、lazy load 設計なら Grid マウント時に明示 load を呼ぶ）
- selector: `selectSceneForeshadowSummary(sceneId)` が `{ setupCount, payoffCount, derivedHealth, foreshadows[] }` を返す
- 伏線編集（追加・削除・state 変更）は store 経由で反映されるため、Grid カードは自動再描画

**Display トグル**:

`[⌃]` ツールバーの Display グループに `☑ Foreshadow indicator 表示`（既定 ON）。伏線管理を使わないユーザーは OFF にできる。

**実装場所**: `src/features/grid/GridCardForeshadowIndicator.tsx`（新規）。selector は `src/features/foreshadow/foreshadowStore.ts` に追加。

#### 構造テンプレート（シーン/フォルダ骨格生成）

著名なプロット構造を opt-in で適用できるテンプレートを Grid `[⋮]` ドロップダウンの `Apply structure template ▸` から提供する。テンプレートは **Chapter folder と placeholder Scene の骨格を一括生成**する（ラベルは生成しない。色付き分類軸が必要な場合は別途 Manage labels で作成する）。

**収録テンプレート**:

| テンプレート | 生成構造 | 想定用途 |
|------|---------|---------|
| 3幕構成 | 3 folders（Act 1/2/3）+ 各幕に placeholder scene 1件 | 全ジャンル汎用、初心者にも分かりやすい |
| 起承転結 | 4 folders + 各 placeholder scene 1件 | 日本語圏の伝統構造、短編・中編向け |
| Freytag's Pyramid（5幕） | 5 folders + 各 placeholder scene 1件 | 古典文学・戯曲風 |
| Save the Cat | 3 act folders + 計 15 placeholder scenes（各段階1件、Act 配下に分配） | ハリウッド型、ジャンル小説向け詳細構造 |
| 英雄の旅 | 3 act folders + 計 12 placeholder scenes | 神話・冒険ファンタジー向け |
| Story Circle（Harmon） | 8 placeholder scenes（フラット） | 短編・連作・キャラクター変化重視 |
| 24章構成（Derek Murphy） | 24 folders + 各 placeholder scene 1件 | 長編商業ノベル（80,000-100,000字級）向け |

**i18n（意訳ベース）**: 各テンプレート・段階名は ja/en の対訳辞書を持つ。**transliteration（音訳）ではなく意訳**を採用：

- 起承転結 → "Setup / Development / Twist / Conclusion"（英語版）
- Save the Cat の "Theme Stated" → 「テーマ提示」（日本語版）
- 24 chapters → ja は「導入フック / 状況設定 / プロットポイント1 / ピンチ1 / 中間点 / …」を意訳した日本語版

**適用挙動**（実装済み、Phase 4 後続で挙動変更）:

- **現在の container 直下に template の `rootChildren` を直置きで展開**する（**ラッパー folder は作らない**）。既存構造とは衝突しない／既存シーンを破壊しない。新規ノードは siblings 末尾に追加
- 各テンプレートは複数の folder ノード（例: `act1` / `act2` / `act3`）をルートに展開するため、container 直下にいきなり Chapter folder 群が並ぶ
- **各段階の "stage 説明文" は folder.synopsis に書き込む**（Save the Cat の "Theme Stated" → 「主人公が最終的に学ぶべき真実を、別キャラが何気なく提示する」のテキストはその stage の **folder** の synopsis として保存される）。理由 — chat の chapter outline 注入経路 (`folder.synopsis`) に乗せるため。**scene.synopsis は空のまま** placeholder として残し、ユーザーが具体的な出来事を書く場所として残す
- placeholder scene の名前は `grid.structureTemplates.placeholderScene`（既定「シーン」/「Scene」）。各 stage の "scene として直接書き出す段階"（例: 3幕構成の各 act 直下の1シーン）は stage の名前を使う
- 同じテンプレートを複数回適用してもよい（毎回 rootChildren が container 末尾に追加される）
- 結果はトーストで報告（「N folders / M scenes 追加」）

**実装場所**: `src/features/grid/structureTemplates.ts`（テンプレート定義、純データ + i18n キー）、`src/features/grid/applyStructureTemplate.ts`（適用処理）、`StructureTemplatePicker.tsx`（空 Grid 時に出る大ボタン）と `GridActionsMenu` の `Apply structure template ▸` サブメニュー（常時アクセス）の 2経路で起動。

> **設計との差異**: 当初設計は「ラッパー folder を 1つ作る」「scene.synopsis に stage 説明を埋める」だったが、Phase 4 後続で **ラッパー不要 + folder.synopsis 経路に統一**へ変更。理由 — (1) ラッパーがあると `Part 1 / 3幕構成 - 1 / Act 1` のような冗長な階層になり Grid 上の breadcrumb が伸びる、(2) stage 説明文を chat への章 outline 注入経路に乗せるには folder.synopsis である必要がある（scene.synopsis では章 outline として扱われない）。

**用語の使い分け**（"Beat" 衝突回避）:

Grimodex には既に **Beat システム**（TipTap `sceneBeat` ノード、Unplaced beats 等）があり、ユーザーは「Beat = シーン内部の構成単位」として認識している。Save the Cat の "Beat sheet" や英雄の旅の各段階を「ビート」と呼ぶと **シーン内 Beat と混同**する。テンプレート関連の用語は以下で統一：

| 文脈 | 日本語 | 英語 |
|------|--------|------|
| シーン内構成単位（既存） | ビート / Beat | Beat |
| プロット構造の段階（テンプレート） | **段階** | **Stage**（"Beat" を避ける） |
| Save the Cat の元来の "Beat" 用語 | 「Save the Cat の段階」と表記 | "Save the Cat Stage" と表記 |

i18n 辞書を作る際は、テンプレートの段階名・紹介文・Apply 結果トーストすべてでこの規約を守る。

### カードの操作

| 操作 | 結果 |
|------|------|
| **タイトル double-click** | インライン rename |
| **タイトル横の ExternalLink ボタン**（hover で出現） | Editor で Scene を開く |
| **カード本体クリック（単独）** | シーン選択（`selectOnly`）に加え、`useTreeStore.setActiveScene(sceneId)` を呼び **AI Chat パネル・Timeline の active scene** を Grid のフォーカスに追随させる（Editor は開かない／ピン留めもしない、ソフトフォーカス）。Cmd/Ctrl+Click と Shift+Click では active scene を動かさない（複数選択の意図と矛盾するため。後述「複数選択」参照） |
| **Synopsis タブ double-click** | InlineSynopsisEditor 起動 |
| **長い Synopsis の `もっと見る / 折りたたむ`** | 140 文字超の Synopsis は既定で `line-clamp-4`。トグルで全文展開／再クランプ。展開状態は `gridStore.expandedSynopsisIds: Set<sceneId>` に session-only で保持（永続化しない、ページ再読込で全カード再クランプ） |
| **Beat タブ unplaced beat double-click** | 該当 beat をインライン編集（textarea、Enter で確定） |
| **Beat タブ `＋ Beat` ボタン** | カード下部に Beat 追加用 textarea を出す |
| **ヘッダ左の `GripVertical` ドラッグハンドル**（hover で出現） | カードのドラッグ起点。当初は不可視の `absolute top-0 h-4` 帯でカード上端全域を drag 領域にしていたが、ExternalLink / kebab ボタンと重なって cursor が `grab` ⇄ `pointer` に高速点滅する問題があったため、独立した小ボタンに変更（drag listener はハンドルのみ）。編集中（synopsis/beat/title）はハンドル含めて drag は無効 |
| **`[⋮]` メニュー** | シーン一覧で表示 / Label を付ける ▸ (チェックボックス式マルチ選択) / 削除 |
| **右クリック → コンテキストメニュー (`GridSceneCardContextMenu`)** | エディタで開く / シーン一覧で表示 / Beat を追加 / Label を付ける ▸ / 削除。kebab と共存（kebab = ホバー discoverability、context menu = power-user 速度。両者は同一ソースの責務 + ラベルに揃える） |
| **削除確認モーダル** | 本文または synopsis を持つシーンの削除時はパネル中央に確認モーダルを出す（複数選択削除でも 1つでも内容を持てば確認）。空シーンは確認なしで即削除 |
| **D&D（同列内）** | `tree_nodes.sort_order` 更新のみ |
| **D&D（別列）** | `tree_nodes.parent_id` と `sort_order` 更新のみ。関連テーブル（`scene_codex_pins` / `povCharacterId` / `locationId` / TipTap docJson）は touch しない — Scene エンティティの ID は変わらないため、リレーションは自動的に保持される |
| **D&D（複数選択時）** | 選択全体を `flatOrder` 順で同一 chapter にまとめて移動 (`moveScenesToChapter`) |

> **設計との差異**: メニューから Rename / Duplicate / Move to chapter… を削除済み。Rename はタイトル double-click、Move to chapter は D&D（または複数選択ツールバーの `章に移動…`）で代替する方針。Duplicate は実装ニーズが立たず Backlog 入り。Open in Editor はヘッダの ExternalLink ボタンに昇格。

> **設計判断: なぜカードクリックで Editor を開かないか**: Grid は俯瞰／構造編集ビューで、シーンを 1つずつ "開く" 操作とは別の責務。クリック = 「ここに集中したいシーン」のソフトフォーカスとし、Editor 起動は明示的に ExternalLink ボタン or context menu からのみ。一方で AI Chat と Timeline は Grid のフォーカスに追随した方が「俯瞰しながら 1シーンを掘り下げる」ワークフローに合うため、`setActiveScene` で連動させる。

### 章列の D&D — 3-zone (before / nest / after)

章列ドラッグ時のドロップは pointer の X 位置で 3-zone に分岐:

- 列の **左 40%** に drop → `before`（targetの直前へ並べ替え）
- 列の **右 40%** に drop → `after`（targetの直後へ並べ替え）
- 列の **中央 20%** に drop → `nest`（target の**子フォルダになる**）

`nest` を実装した目的は、Part > Chapter > Sub-chapter のような階層構造を D&D で再構築するため。`computeColumnDropIndicator` / `computeColumnDropTarget` が以下を担保する:

- **Cycle prevention**: target が active の自身または子孫の場合は drop を無効化（無限ループ防止）
- **No-op detection**: 隣接 sibling への "before/after" で active が同じ位置に戻る drop は **null を返してドロップ無効**（隣の neighbor と swap したいときは neighbor の反対側 40% に drop する）
- **Loose 領域への bubble 抑止**: container 直下の orphan area への drop は親 container へ抜けないようガード

`GridFolderCard` 自身も nest droppable（`column-nest-{folderId}`）として登録され、フォルダカード単体への drop でその直下に append される。

### 複数選択と一括操作

- **シングル選択**: 単純クリックでそのシーンのみ選択（`selectOnly`）
- **トグル選択**: Cmd/Ctrl+Click で選択／解除（`toggleSelection`）
- **範囲選択**: Shift+Click で anchor から target まで `flatOrder` を基準に範囲選択 (`rangeSelect`)
- **全選択**: Cmd/Ctrl+A（パネルにフォーカス時のみ）で表示中シーンを全選択 (`selectAll`)
- **選択解除**: Esc（編集中以外）、または panel 背景クリック、または選択ツールバーの `×` 押下

2件以上選択中は `GridSelectionToolbar`（パネル下部）が出現:

- `{N} 件選択中` ラベル
- `章に移動…` ポップオーバー（`GridChapterPickerContent`、章ツリーをドリルダウン選択）
- `削除` ボタン（内容を持つシーンが含まれる場合は確認モーダル）
- `×` で選択クリア

### Synopsis 共有編集コンポーネント

Synopsis は **Scenes パネル（Outline モード）／ Editor 上部の Synopsis セクション ／ Grid のカード**の3箇所でインライン編集可能。同一の `tree_nodes.synopsis` カラムに保存されるためデータ整合は問題ないが、UI 挙動の不一致を防ぐため**3箇所は同一の `<InlineSynopsisEditor>` コンポーネントを共有する**。

挙動仕様（共有コンポーネントが提供する単一の振る舞い）：

- textarea ベースのインライン編集
- `Enter` で確定（保存）、`Shift+Enter` で改行、`Esc` でキャンセル
- フォーカスを失う（外側クリック）と確定保存
- 保存失敗時はトースト通知し、編集状態を維持
- IME 入力中の `Enter` は確定しない（`compositionend` 後に有効化）
- 編集中はホストカードの D&D を無効化（drag handle を編集中は disable する）。Grid 側の責務として、`isEditing` 状態を購読してドラッグ可否を切り替える

実装場所: `src/features/editor/InlineSynopsisEditor.tsx`（既存 Editor 配下に新規追加し、3パネルから import）。

### `+ New Scene` の動作

- 該当 Chapter folder 直下の末尾に新規 Scene を追加
- Scene 名は自動採番（`Scene N`）
- 作成直後は Synopsis インライン編集モードで開く（即入力できる）
- 入力なしで Esc / Blur すると Synopsis は空のまま保存される

### `+ New Chapter` の動作

- 現在の container 直下の末尾に新規 folder を追加
- Chapter 名は自動採番（`Chapter N` または container 階層に応じたプレフィックス、Scenes パネル設計書のロジック流用）
- 作成直後は列ヘッダの名前部分がインライン編集状態
- 確定後は `+ New Scene` を1回押した状態と同等になる（最初の Scene を入れやすくする）

---

## C. ステータスバー

```
3 章 · 6 シーン · 12,400 chars
```

| 要素 | 表示 |
|------|------|
| Chapter 数 | 現 container 直下の folder 数（`totalChapters`） |
| Scene 数 | container 配下の**全 Scene 数（chapter folder の再帰的子孫を含む）** + Loose / Container 直下シーン |
| 合計文字数 | 表示中の Scene 本文文字数の合計（`tree_nodes.char_count` キャッシュと `useTreeStore.charCounts` ライブ値の max） |

> **設計との差異**: 「Last edited Scene」の表示は未実装（追跡コスト割に立たずに見送り）。総 Scene 数は当初「再帰的にカウントしない」と書いていたが、実装は **章配下の全子孫シーンを再帰的にカウント**するように変更（dive-in しなくても章全体の規模が見える方が役立つ）。

---

## 既存システムとの接続

### Scenes パネルとの接続

- 同じ `tree_nodes` テーブルを共有。Grid 上の操作（Scene 追加・削除・移動・順序変更）は Scenes パネルに即座に反映される
- Grid のカード `[⋮] → Show in Scenes panel` で Scenes パネルにフォーカス
- Scenes パネル側で Scene を rename / delete すると Grid のカードも更新

### Editor との接続

- カードタイトルクリックで Editor が起動（既存のタブモデルに従う）
- Editor で Synopsis を変更すると Grid のカードも更新（同じ `tree_nodes.synopsis` を参照）
- 逆に Grid でインライン編集した Synopsis は Editor の Synopsis セクションに即座に反映

### Matrix との接続

- Grid と Matrix は**役割が違う**ため別パネル（背景・設計判断参照）
- Matrix のセル → 「Show in Grid」コンテキストメニュー（v2 検討）で該当 Scene のカードへスクロール
- 同じ `scene_codex_pins` を読み取るため、Codex チップの編集は両パネルで整合する

### Codex パネルとの接続

- カードの Codex チップは Codex リレーション（`scene_codex_pins`）の表現
- Codex エントリの rename / delete は Grid のチップに即座に反映
- チップクリックで Codex 詳細パネルを開く

### Beat システムとの接続

- カード本体の bullet 表示は Unplaced beat の冒頭文を読み出している（`tree_nodes.unplaced_beat_preview` キャッシュ、シーン保存時にフロントが `unplaced_beats_doc` から事前抽出）
- Beat の追加・編集・削除は Editor で行う（Grid 上では表示のみ）
- カードの `[⋮]` メニューに「Add unplaced beat...」を追加済み（**Phase B で実装済み**）。Editor 起動なしで Unplaced beat を追加でき、カードに即時反映される。

> **Phase B 実装済み**: Beat 箇条書きをカードの主表示に昇格（Synopsis は `▸ Show synopsis` トグルで折りたたみ既定）。`unplaced_beat_preview` の最大 beat 数を 3→8、1 beat あたり文字数を 40→60 に拡張。Synopsis 副表示の折りたたみは決定事項。

### Timeline / Map との接続

- Grid は Timeline / Map とは独立。同じ Scene を参照するが、ビューの軸が違うため共有データなし

---

## データモデル

Grid は新規テーブルを持たない。表示内容はすべて既存テーブルから導出される：

| 表示要素 | データソース |
|---------|------|
| Chapter 列 | `tree_nodes` の folder ノード（current container の直接の子） |
| Scene カード | `tree_nodes` の scene ノード（folder 列の子、または Loose） |
| Folder カード (nested) | `tree_nodes` の folder ノード（chapter 列内に depth indent で混在） |
| Chapter Outline | `tree_nodes.synopsis`（folder ノードの synopsis = 列ヘッダ直下に line-clamp 表示 + chat の chapter outline 経路） |
| Container Outline バー | dive-in 中の container folder の `tree_nodes.synopsis`（列群の上に横長バー表示） |
| Scene Synopsis | `tree_nodes.synopsis`（Synopsis タブで表示） |
| Beat（placed + unplaced） | `tree_nodes.placed_beat_preview` と `tree_nodes.unplaced_beat_preview` の 2系統キャッシュ（後述「Beat 冒頭の取得戦略」参照） |
| POV chip | `scene_beat_pov_cache` ∪ `tree_nodes.povCharacterId`（dedupe、scene POV 先頭、character 名は `codexEntries` を join） |
| Codex チップ | `scene_codex_pins` |
| Label カラーバー | `tree_node_labels` (M:N) → `labels` (project スコープ、固定パレット色)。Phase B 新規テーブル |
| Foreshadow indicator | `foreshadowStore` から派生: `foreshadow_setups.scene_id = sceneId` で setup 件数、`foreshadows.payoff_scene_id = sceneId` で payoff 件数。健全性ドットは関連伏線の `deriveLabel` 出力から算出 |
| Status | `tree_nodes.status`（Scenes パネル設計書既定） |
| 文字数 | `tree_nodes.char_count` キャッシュカラム（Beat 設計書 Phase A で追加、シーン保存時にフロントが値を同梱） |

### Beat 冒頭の取得戦略

Grid は**最大数十シーン分**を同時に表示するため、カード描画のたびに各 Scene の `unplaced_beats_doc` / 本文 doc 全体をパースして先頭 beat を取り出すのも避けたい（数十シーン × 数 KB の JSON パース）。**保存時にフロント側がプレビュー文字列を計算して同梱**するシンプルな方針を採る：

**`tree_nodes.unplaced_beat_preview` / `tree_nodes.placed_beat_preview` キャッシュカラム**

シーン保存時、フロントが (a) Unplaced beats doc から `extractUnplacedBeatPreview`、(b) 本文 docJson から `extractPlacedBeatPreviewFromString` を使って 2系統のプレビュー JSON 配列を生成し、保存ペイロードに `unplacedBeatPreview` / `placedBeatPreview` フィールドとして同梱する。バックエンドは値を opaque TEXT として保存・返却するだけ（中身は解釈しない）：

```sql
ALTER TABLE tree_nodes ADD COLUMN unplaced_beat_preview TEXT;
ALTER TABLE tree_nodes ADD COLUMN placed_beat_preview TEXT;
-- 値の形式: '["雨の夜、廃社の前で立ち止まる朱音","祭壇に置かれた朱紐を見つける","触れた瞬間に流れ込む見知らぬ記憶"]'
-- 値が NULL or '[]' なら表示しない
```

Grid カードはこの 2系統を**両方読み出し**、`┃` 接頭辞 (placed) と `01` / `02` 番号 (unplaced) でリストに混在表示する（Beat タブ）。検索 (`useGridCardVisibility`) も両方の preview を結合して照合する。

**フォーマット契約（フロント↔バックエンド共通の I/F）:**

- 値は JSON 配列文字列、要素は plain text（`unplaced_beats_doc` から抽出した冒頭文）
- 要素数の上限はフロント側でバリデーション（Phase A: 最大3件、Phase B Beat 主表示化時に拡張予定）
- 1要素あたりの文字数上限もフロント側で切り詰め（Phase A: 40文字、超過は `…` 付与なしで切る）
- 改行・タブはフロント抽出時に半角スペースに正規化
- バックエンドは値を opaque な TEXT として保存・返却するのみ。中身を解釈・検証しない

**読み出し側のエラーハンドリング:**

- JSON.parse 失敗・配列以外・要素が文字列以外 → すべて NULL と同等に扱う（カードの beat 領域を非表示）
- カードコンポーネントは parse 失敗で例外を投げないこと（描画ループ全体を巻き込むため）

**Phase B（Beat 主表示化）への拡張:**

Beat 箇条書きをカード主表示に昇格する際、プレビュー件数・1件あたり文字数を引き上げる予定（暫定: 8件 × 60文字）。`unplaced_beat_preview` カラムの形式は同じ JSON 配列のまま、抽出側のパラメータだけを変更する。

**抽出責任をフロント側に置く理由:**

- `unplaced_beats_doc` の構造（ProseMirror JSON fragment）を定義しているのは TipTap 側（フロント）。schema 変更があれば必ずフロントから始まるので、バックエンドに同じ JSON 構造の知識を二重に持たせると drift が起きる
- 保存パイプラインは既に `tree_nodes.content` をフロントが投げているので、フィールドを1つ増やすだけ
- プレビューは表示用で、整合性が崩れても Grid のカード表示が最大40文字×3件ズレるだけ（データ破損にはならない）

**マイグレーション後の挙動:**

`unplaced_beat_preview` は Phase A 時点で `NULL` から始まる。次回そのシーンが保存されたタイミングで自然に埋まる。**ユーザーが触らないシーンはずっと NULL のまま**だが、そのシーンは Beat も持たないことが多く、プレビュー表示が空なのは正解（カード描画は問題なく動く）。lazy 再計算は v1 では不要、必要になれば v2 で検討。

### ユーザー設定の永続化

Grid のビュー状態は**スコープを分けて**保存する：

- **プロジェクトスコープ**（プロジェクトメタに保存）: `containerId` — プロジェクト固有の `tree_nodes.id` を参照するため、`global-settings.json` には置かない
- **グローバルスコープ**（`global-settings.json`）: 表示・フィルタ設定（プロジェクト横断で一貫していてよいユーザー嗜好）

```json
// global-settings.json（実装済みの形）
{
  "grid": {
    "display": {
      "showSynopsis": true,
      "showBeats": true,
      "showCodex": true,
      "showStatusLabel": true,   // 旧 showLabel — 後方互換で読み込み時にリネーム
      "showLabelBar": true,
      "showForeshadow": true,
      "compactCards": false
    },
    "filter": {
      "emptyOnly": false,
      "hideCompleted": false,
      "codexFilter": null,
      "labelFilter": []
    },
    "toolbarOpen": false,
    "cardTabMode": "auto"        // "auto" | "beat" | "synopsis" の全カード同期モード
  }
}
```

```json
// プロジェクトメタ（per-project）
{
  "grid": {
    "containerId": "node-act1"  // 起動時に存在チェックし、無効ならルートにフォールバック
  }
}
```

---

## 実装フェーズ

### 実装済み

**Phase A: Grid MVP**（全項目完了）

依存: Scenes パネル、Codex リレーション、Editor の Synopsis 機構、Beat システム設計書 Phase A の `unplaced_beats_doc` カラム（読み出しのみ）と `unplaced_beat_preview` キャッシュ

- [x] `tree_nodes.unplaced_beat_preview` カラム追加（Drizzle migration）
- [x] プレビュー再計算トリガーの保存経路特定と同梱
- [x] シーン保存時にフロント側が `unplaced_beats_doc` から抽出して保存ペイロード同梱
- [x] `<InlineSynopsisEditor>` 共有コンポーネント（Scenes Outline / Editor Synopsis / Grid カードで共通）
- [x] 新規パネル `GridPanel` の実装（`src/features/grid/`）
- [x] Container セレクタ（breadcrumb + ツリー型ドロップダウン、無効 ID のルートフォールバック含む）
- [x] Chapter 列の描画（`tree_nodes` の folder ノード）
- [x] Scene カード描画（Synopsis / Beat 冒頭 / Codex チップ / Status）
- [x] Codex チップは表示専用（タイプ別色分け、チップクリックで Codex 詳細パネル起動）
- [x] `+ New Scene` / `+ New Chapter`（自動採番、追加後インライン編集）
- [x] カードタイトルクリック → Editor 起動
- [x] Synopsis インライン編集（編集中はカード D&D 無効）
- [x] D&D: Scene 並べ替え（同列・別列）、Chapter 列並び替え
- [x] カード `[⋮]` メニュー（Open / Rename / Duplicate / Delete / Move to chapter… / Show in Scenes）
- [x] Loose Scenes 仮想列対応
- [x] レイアウト: Bottom Dock デフォルト非表示
- [x] Container 選択のプロジェクトスコープ永続化（無効 ID はルートにフォールバック）
- [x] 文字数表示は `tree_nodes.char_count` キャッシュ値（保存時点の値、編集中は更新されない）

**Phase B: 完了済みの機能拡張**

- [x] **Beat 主表示化**: Beat 箇条書きを主表示に昇格、Synopsis は折りたたみ副表示。`unplaced_beat_preview` を 8件 × 60文字に拡張
- [x] カード `[⋮] → Add unplaced beat...`（Editor 起動なしで beat 追加）
- [x] Loose Scenes 仮想列の一括操作（既存 Chapter にまとめる／新規 Chapter folder に変換）
- [x] Synopsis トグル双方向化（`▸ Show synopsis` / `▾ Hide synopsis`）
- [x] 選択チェックマーク削除（リング枠で十分）
- [x] **ヘッダ UI 再構成**: `[⌃]` 折りたたみ `GridDisplayToolbar` + `[⋮]` `GridActionsMenu` に分離。`display.showLabel` → `showStatusLabel` リネーム、`showLabelBar` / `showForeshadow` / `toolbarOpen` 追加。開閉状態は `global-settings.json` に永続化
- [x] **Compact カード幅モード**: `display.compactCards` トグル（ツールバーから切替）
- [x] **Label 機能**（手法非依存の色タグ）— `labels` テーブル + `tree_node_labels` 中間テーブル新規追加（Rust マイグレーション + Drizzle schema）
  - `src/lib/labelPalette.ts`（固定 12色、dark/light 両モード対応 CSS 変数）
  - `src/features/labels/labelApi.ts` — Drizzle 直叩き（Tauri command 化なし。codex_tags と同方針）
  - `src/features/labels/labelStore.ts`（Zustand、GridPanel mount 時に load）
  - `GridCardLabelBar.tsx`（カード左端縦バー、最大3色 + `+N` バッジ、ホバーポップオーバー）
  - `GridColumnLabelBar.tsx`（列ヘッダ水平バー）
  - カード `[⋮]` メニューに `Label を付ける ▸` サブメニュー追加
  - `Manage labels...` モーダル（`ManageLabelsDialog.tsx`、CRUD + DnD 並べ替え + 削除時シーン数確認）
  - `LabelDots.tsx`（Scenes パネルのタイトル右に小色ドット。`showLabelDots` トグルで制御）
  - Filter UI へのラベルフィルタ Pill 行（Phase C で実装済み。詳細は下記）
- [x] ~~**ラベルテンプレート**~~ → **構造テンプレートに置き換え済み**（下記 Phase D 参照）。`labelTemplates.ts` / `applyLabelTemplate.ts` / `[⋮] → Apply label template ▸` は削除済み
- [x] **POV chip 行**（`GridCardPovChips.tsx`）— ヘッダ直下に effective POVs を chip 表示
  - データソース: `scene_beat_pov_cache` (`listSceneBeatPovOverrides`)、`tree_nodes.povCharacterId` を先頭に dedupe
  - スタイル: scene POV は塗り chip、Beat 由来のみはアウトライン chip
  - **実装の差異**: 色は character タイプ色ではなく **character ID のハッシュで 12色パレットから決定**（per-character で視覚的に区別可能）
  - 上限: 3人 + `+N more`。クリックで `requestSelectEntry` + Codex パネルを開く
- [x] **Foreshadow indicator**（`GridCardForeshadowIndicator.tsx`）— カードフッタに健全性ドット + `📌N ✓N` counter
  - データ取得: `getSceneForeshadowInfo(sceneId)` で setup/payoff ID を取得、`useForeshadowStore.items` でラベル解決
  - GridPanel mount 時に `useForeshadowStore.load(projectId)` を eager 実行（ForeshadowPanel 未起動でも動作）
  - Compact 時はドットのみに縮退。`display.showForeshadow` トグルで表示制御
  - クリックで ForeshadowPanel を起動。**シーンフィルターは pill ではなく amber バナー形式**で表示（`foreshadowNavStore.requestSceneFilter` + `ForeshadowPanel` 内 `consumeSceneFilter` で連携）

### Phase C: 完了済みの連携機能

- [x] **🔍 検索**（インクリメンタル、ヒット外カードグレーアウト）— `useGridCardVisibility` で title / synopsis / beat / codex 名の OR 検索。ヒット外は `dimmed` で半透明（`opacity-40`）、フィルタ外は完全非表示
- [x] **ラベルでフィルタ**（複数選択 OR）— `labelFilter: string[]` を `gridStore.filter` に追加、`GridDisplayToolbar` の Filter セクションに色付き Pill 行を追加（クリックで OR トグル、選択中は塗り、未選択は枠のみ）。ラベル削除 / プロジェクト切替時の dangling ID は `useEffect` で自動除去。永続化は `global-settings.json`。
  - **設計との差異**: 当初 Backlog では「Label 選択ドロップダウン」と記載していたが、ラベルが色情報を持つため Pill 形式（`TagFilterBar` 準拠）に変更。色視認性と複数選択 OR の操作性を優先した。
- [x] **Codex チップの直接編集** — `GridCardChips.tsx` の editable mode（`+` で `PinEntryDialog`、`×` で削除）
- [x] **文字数リアルタイム更新** — `GridSceneCard.tsx:49-51` で `useTreeStore.charCounts` map を購読。Editor 編集サイクルに同期
- [x] **Matrix → Grid クロスナビゲーション** — `requestRevealScene + showPanel("grid")`。Grid パネル前面化 + scrollIntoView + 一時 amber ring（`revealedSceneId`）
- [x] **複数選択 + 一括操作** — Click / Shift+Click / Cmd+Click、`GridSelectionToolbar` + `bulkSceneOps.ts` で章移動・一括削除

**Phase D: 構造テンプレート（ラベルテンプレート置き換え、完了済み）**

- [x] `src/features/grid/structureTemplates.ts` 定義（7 テンプレート、純データ）
- [x] `[⋮] → Apply structure template ▸` メニューに置換（`LayoutTemplate` アイコン）
- [x] 適用処理 `applyStructureTemplate`: 現 container 直下に rootChildren を**直置きで展開**（ラッパー folder は作らない、Phase 4 後続で挙動変更）。`treeApi.createNode` を反復呼び出し
- [x] **段階説明文は `folder.synopsis` に書き込む**（scene.synopsis は空、chat の chapter outline 経路に乗せるため）
- [x] 旧 `labelTemplates.ts` / `applyLabelTemplate.ts` / 関連 i18n エントリ削除
- [x] ja/en 対訳辞書追加（`grid.structureTemplates.{key}.name` / `stages.{stageKey}.{name|synopsis}`）。各段階の synopsis は意訳ベースで物書きに役立つ叩き台として記述
- [x] トースト通知（「N folders / M scenes 追加」）
- [x] 空 Grid 時に中央に `StructureTemplatePicker` 大ボタンを表示（最初の Chapter を作る前の onboarding）

### Phase 4 後続: dive-in / folder card モデル（完了済み）

任意深さのツリー（Part > Chapter > Sub-chapter > Scene 等）を Grid 上で扱うために、当初設計の「1ビュー = 1階層深さに固定」を緩和した一群の変更。

- [x] **`GridFolderCard`** — chapter 列内に nested folder をカードとして表示。点線ボーダー + folder アイコン、クリックで dive-in、ChevronRight で展開／折りたたみ、`folder.synopsis` を line-clamp 表示 + double-click でインライン編集
- [x] **`collapsedFolderIds`** — session-only Set で folder ごとの折りたたみ状態を管理（永続化しない、既定全展開）
- [x] **ヘッダーの全展開／全折りたたみボタン** (`ChevronsUpDown` / `ChevronsDownUp`)
- [x] **`useGridDerivedData` の `flattenSubtree`** — chapter 列の `descendants` に scene と nested folder を depth 別 indent で混在格納
- [x] **`GridContainerSceneColumn`** — dive-in 中 container folder の直下シーンを実線・folder アイコン付き列で描画（loose 列とは見た目で区別）
- [x] **`GridContainerOutline`** — dive-in 中 container folder の synopsis を列群の上の横長バーで表示（folder 自身が列・カードどちらにもならないため）
- [x] **章列の D&D 3-zone** (`computeColumnDropIndicator`) — 左 40% before / 右 40% after / 中央 20% nest。`column-nest-{folderId}` droppable を `GridFolderCard` 自身にも装着して、フォルダカードへの直接 nest drop に対応
- [x] **Cycle prevention / No-op detection** — 自身の子孫への nest を拒否、隣接 sibling 同方向 drop は null を返してフィードバック停止
- [x] **`ColumnDropIndicator`** — drop 先列に left/right padding gap または nest ring（amber-tinted）を出してプレビュー
- [x] **章列ヘッダの Chapter Outline** — `InlineSynopsisEditor` を列ヘッダ直下に配置（folder.synopsis を 2行 clamp、double-click 編集）
- [x] **placed_beat_preview カラム** — 本文 docJson から `extractPlacedBeatPreviewFromString` で抽出した placed beat プレビューを `tree_nodes.placed_beat_preview` に保存。Grid は unplaced と placed を統合して bullet 表示
- [x] **Beat / Synopsis タブ UI** — Beat 主表示 + Synopsis 折りたたみの当初案からタブ切替に進化。`cardTabMode: "auto" | "beat" | "synopsis"` 全カード同期モード（`[⌃]` ツールバーの 3-state segmented control）
- [x] **Beat のインライン編集** (`editUnplacedBeatFromGrid`) — double-click で textarea 編集、auto-resize、Enter 確定 / Shift+Enter 改行 / Esc 取消。`loadBeatTextByIndex` で fresh text を取得して race を避ける
- [x] **Beat の overflow トグル** — `BEAT_VISIBLE_LIMIT = 3` を超える件数は `▾ 他 N 件` 展開 / `▴ 折りたたむ` 双方向
- [x] **キーボード操作** — Esc で選択解除、Cmd/Ctrl+A で表示中シーン全選択（パネルにフォーカス時）
- [x] **複数選択 D&D** — 選択中シーンを 1枚ドラッグすると `flatOrder` 順で選択全体が target chapter に移動 (`moveScenesToChapter`)
- [x] **+ 章を追加 の縦書きボタン化** — ヘッダーから列末尾の細い縦書きボタンに移設（writing-mode: vertical-rl）

### Backlog

**Phase E: AI 連携（v2+）**

- [ ] カード `[⋮] → Generate scene from chapter outline`（章のサマリーから Scene 提案）
- [ ] 空カード / `+ シーンを追加` の AI ドラフト生成
- [ ] カード `[⋮] → Duplicate` の復活（needs があれば）

---

## Phase 着手前にユーザー確認が必要な決定事項

### Container セレクタのデフォルト位置

- **暫定方針**: プロジェクトルート（最上位 folder 群を列として表示）
- 代替案: 最後にユーザーが Editor で開いていた Scene の親 chapter
- **判断ポイント**: 起動時に「全体俯瞰」が欲しいか「直近作業の続き」が欲しいか

### Loose Scenes の扱い（実装で確定済み）

- **採用方針**: project root では「未分類シーン」点線列 (`GridLooseColumn`)、folder へ dive-in 中はその folder 自身の実線列 (`GridContainerSceneColumn`) として表現。`orderedColumns` で chapter 列と sortOrder マージ
- 既存 Chapter にまとめる／新規 Chapter folder に変換の一括操作はヘッダ `[⋮]` メニューから

### 編集ロックの粒度

複数ユーザーや複数ウィンドウで同 Scene を同時編集した場合の挙動：

- **暫定方針**: ロックなし（最後の保存が勝ち）。Grimodex はローカル単独運用前提のため
- v2 で WAL ベースの楽観ロックを検討

### Beat 表示件数と文字数制限（実装で確定済み）

カード本体に表示する Beat の件数とプレビュー文字数：

- **採用方針**: カードの Beat タブで初期 3件（`BEAT_VISIBLE_LIMIT = 3`）表示、超過は `▾ 他 N 件` で展開。preview の文字数上限は `extractUnplacedBeatPreview` / `extractPlacedBeatPreviewFromString` 側のロジックに委ねる（preview JSON 配列に格納された文字列をそのまま表示。clamp は CSS `line-clamp-1`（Compact）/ `line-clamp-2`（通常）で対応）

### カード幅とレイアウト（実装で確定済み）

- **採用方針**: Compact OFF で `w-80` (320px)、Compact ON で `w-56` (224px) の固定幅 + 横スクロール。`compactCards` トグルで切替

---

## 既存設計書への影響

本設計書の確定に伴い、以下の既存設計書への追記が必要（別タスク）：

| 設計書 | 追記内容 |
|--------|----------|
| `Grimodex_レイアウトシステム設計書.md` | パネル一覧に Grid を追加、デフォルト位置 Bottom Dock |
| `Grimodex_Scenesパネル設計書.md` | Grid との関係（同じ `tree_nodes` を共有、ツリー操作とカード操作の分担） |
| `Grimodex_Matrixパネル設計書.md` | Grid との関係（俯瞰 vs 作業の分担、クロスナビゲーション v2） |
| `Grimodex_Editorパネル設計書.md` | Grid からのカードタイトルクリックで Editor 起動する経路 |

---

## 参考資料

- Novelcrafter Plan Grid（スクリーンショット参照）
- Beat システム設計書: `Grimodex_Beatシステム設計書.md`
- Matrix パネル設計書: `Grimodex_Matrixパネル設計書.md`
- Scenes パネル設計書: `Grimodex_Scenesパネル設計書.md`
