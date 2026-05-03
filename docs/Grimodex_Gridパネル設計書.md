# Grimodex Gridパネル設計書

## 概要

Grid パネルはプロジェクト内の **Chapter ごとの Scene カード列**を一覧する作業ビュー。Novelcrafter の Grid（Plan セクションの3ビューのうちの1つ）に相当する。Scenes パネル（ツリー構造）、Timeline（時間軸）、Map（2D空間）、Matrix（クロス表）と並ぶ第5のマクロビュー。

各 Chapter（`tree_nodes.node_type = 'folder'`）が縦の列になり、その配下の Scene が**インデックスカード**として縦に積まれる。1枚のカードに Synopsis・Unplaced beat の冒頭・Codex チップ・Label が見えるため、章単位で「何が起きているか」を一望できる。

```
Scenes:    ツリー1行       — 構造管理（読み順・名前変更・移動）
Timeline:  1次元・時間軸   — story-time の俯瞰
Map:       2D・連続座標    — 関係トポロジー
Matrix:    クロス表        — シーン × Codex の登場分布
Grid:      Chapter 列      — 章単位の Scene 構成・編集（本パネル）
```

デフォルト位置: Bottom Dock（非表示）。Center スプリット運用に向く（カードを1〜2列見ながら Editor 編集）。

設計思想: **既存の `tree_nodes` ツリーを「親フォルダの直接の子フォルダ」を列、「孫の Scene」をカードとして描き直すビュー。新規データモデルは持たない。**

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
│ Grid   Part 1 / Act 1 ▾   3 chapters   [+ New Chapter]   [🔍] [⋮]│
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
| Container セレクタ | 表示対象の親フォルダ。breadcrumb 表示（`Part 1 / Act 1`）。クリックでドロップダウン展開、ツリー上の任意 folder を選択可。Default はプロジェクトルート |
| Chapter 数表示 | `{N} chapters`（直下フォルダ数。Scene 直接子は `+ {M} loose scenes` と併記） |
| `[+ New Chapter]` | 現在の container 直下に新規 folder を作成。名前は自動採番（Scenes パネル設計書の採番ロジックに従う） |
| 🔍 検索 | カード内テキスト（Scene 名 / Synopsis / beat 冒頭 / Codex 名）でインクリメンタル絞り込み。マッチしないカードはグレー表示。**Phase A では非表示または disabled（Phase B で実装）** |
| `[⋮]` パネルメニュー | Display / Filter / Help |

### Container セレクタの動作

- クリックでツリー型ドロップダウン表示
- 選択した folder が新しい container になる
- 同 folder に階層が深い場合、breadcrumb が長くなる（`Project / Part 1 / Act 1` 等）
- 「←」ボタンで親 container に戻る
- 選択 container は **プロジェクトスコープ**で永続化（プロジェクト切り替えで別プロジェクトの ID を引きずらないため、プロジェクト ID をキーに含めて保存）
- 起動時に保存された ID が現プロジェクト内に存在しない場合（削除済み・別プロジェクト由来）はプロジェクトルートにフォールバック

### `[⋮]` パネルメニュー

```
Display
  ☑ Synopsis を表示（あれば）
  ☑ Unplaced beat の冒頭を表示
  ☑ Codex チップを表示
  ☑ Label を表示（Phase B、Label 機能追加時のみ有効）
  ☐ カード幅をコンパクトにする

Filter
  ☐ 空の Scene（本文未着手）のみ
  ☐ 完成済み Scene を非表示
  ☐ 特定 Codex を含む Scene のみ（Codex セレクタ）

Help
  Grid の使い方
```

---

## B. カード列

### 列（Chapter）

- 1列 = 1 Chapter（`tree_nodes.node_type = 'folder'`）
- 列ヘッダ: Chapter 名 + 編集 ✏ + `[⋮]` メニュー（Rename / Delete / Move / Show in Scenes）
- 列内のカードは `tree_nodes.sort_order` 昇順で縦に並ぶ
- 列末尾に `+ New Scene` ボタン
- 列幅は固定（300〜400px）。横スクロールで複数列を見る
- 列ヘッダ D&D で Chapter の並び替え（同 container 内）

### Scene 直接子（Loose Scenes）

選択 container 直下に Scene が直接ぶら下がっている場合、仮想列「`Scenes`」（または「`(no chapter)`」）として最右に表示される：

- 個別 Scene を D&D で別 Chapter 列にドロップして移動できる（Phase A）
- この仮想列に `+ New Scene` を押した場合、container 直下に Scene が追加される（Loose のまま）
- 仮想列ごと既存 Chapter にまとめる／新規 Chapter folder に変換する一括操作は **Phase B で実装済み**（仮想列の `[⋮]` メニューから操作可能）

### カード（Scene）

各カードに表示する内容：

| 領域 | 内容 | データソース |
|------|------|--------|
| ヘッダ | Scene 名 + 編集 ✏ + `[⋮]` メニュー | `tree_nodes.title` |
| ヘッダ直下 | POV chip 行（最大3人 + `+N more`） | `scene_beat_pov_cache` ∪ `tree_nodes.povCharacterId`（後述「POV chip」参照） |
| 本体（上段） | Beat 箇条書き（主表示）／ Synopsis は折りたたみ | `tree_nodes.unplaced_beat_preview` / `tree_nodes.synopsis`（保存時にフロントが事前抽出したプレビュー、Beat 設計書 / 後述「Beat 冒頭の取得戦略」参照） |
| 本体（中段） | Codex チップ（最大5件） | `scene_codex_pins` |
| フッタ | Label / 文字数 / Status | （Label は Phase B、`tree_nodes.status` は Scenes パネル設計書既定、文字数は `tree_nodes.char_count`） |

> Phase A での Codex チップは**表示専用**（タイプ別色分け・クリックで Codex 詳細パネル起動）。`+ Codex` 追加・`×` 削除のインタラクションは Phase B（後述「実装フェーズ」参照）。

#### Beat 主表示と Synopsis 折りたたみ（実装済み）

**現行**: Beat 箇条書きを主表示、Synopsis は副表示として折りたたむ。Beat と Synopsis の役割分担（Beat = 構造的計画、Synopsis = 叙述的要約）を Grid 上でも視覚的に反映し、「Grid で Beat を計画 → Editor で D&D して生成」のフローを一貫させる。詳細は Beat システム設計書「Grid との接続」参照。

- **Beat あり**: Beat を bullet 表示（最大8件 × 60文字、`unplaced_beat_preview` キャッシュから読む）。Synopsis がある場合は下に `▸ Show synopsis` / `▾ Hide synopsis` トグルで展開可能（双方向）
- **Beat なし / Synopsis あり**: Synopsis を本体に直接表示
- **両方なし**: 灰色で「空のシーン」と表示

#### POV chip

ヘッダ直下に独立した行として、そのシーンの **effective POVs**（scene POV ＋ Beat 内 POV オーバーライド）を chip で並べる。Codex character chip との視覚混同を避けるため、Codex 行とは分離して描画する。

**データソース**:

- 第1ソース: `scene_beat_pov_cache (scene_id, pov_character_id)` — `extractBeatPovOverrides` が Beat ノードの明示 `pov` 属性のみを抽出してキャッシュ（属性なしで scene POV を継承する Beat はキャッシュに入らない）
- フォールバック: cache が空かつ `tree_nodes.povCharacterId` が set されている場合は scene POV のみ表示
- 両方 null（POV 未設定）の場合は POV chip 行ごと描画しない（領域も詰める）
- character 名は `codexEntries` を join して取得

**Effective POVs の構築ルール**:

- `effective = unique(scene POV + cache の POVs)`
- **scene POV を先頭固定**、後続は Beat 出現順
- cache に scene POV と一致する ID が含まれている場合は dedupe（重複 chip を出さない）
- Beat 設計書 `pendingBeatsContext.ts:69` の Beat ラベル省略ロジックと同じ思想

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

### カードの操作

| 操作 | 結果 |
|------|------|
| **タイトルクリック** | Editor で Scene を開く |
| **本体クリック** | 何もしない（D&D の起点として残す） |
| **Synopsis ダブルクリック** | インライン編集モード（後述「Synopsis 共有編集コンポーネント」参照） |
| **編集 ✏ クリック** | Synopsis をインライン編集モードに切替（ダブルクリックと同じ） |
| **`[⋮]` メニュー** | Open in Editor / Rename / Duplicate / Delete / Move to chapter… / Show in Scenes panel |
| **D&D（同列内）** | `tree_nodes.sort_order` 更新のみ |
| **D&D（別列）** | `tree_nodes.parent_id` と `sort_order` 更新のみ。関連テーブル（`scene_codex_pins` / `povCharacterId` / `locationId` / TipTap docJson）は touch しない — Scene エンティティの ID は変わらないため、リレーションは自動的に保持される |
| **右クリック** | `[⋮]` メニューと同じ |

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
3 chapters · 6 scenes · 12,400 chars · Last edited: Scene 2 (転機)
```

| 要素 | 表示 |
|------|------|
| Chapter 数 | 現 container 直下の folder 数 |
| Scene 数 | 表示中の全 Scene 数（Loose 含む、再帰的にカウントしない） |
| 合計文字数 | 表示中の Scene 本文文字数の合計（リアルタイム） |
| 最終編集 | 最後に編集された Scene 名 + 所属 chapter |

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
| Synopsis | `tree_nodes.synopsis` |
| Beat 冒頭 | `tree_nodes.unplaced_beat_preview` キャッシュ（後述「Beat 冒頭の取得戦略」参照） |
| POV chip | `scene_beat_pov_cache` ∪ `tree_nodes.povCharacterId`（dedupe、scene POV 先頭、character 名は `codexEntries` を join） |
| Codex チップ | `scene_codex_pins` |
| Label | （Phase B、Label 機能が追加されたら対応） |
| Status | `tree_nodes.status`（Scenes パネル設計書既定） |
| 文字数 | `tree_nodes.char_count` キャッシュカラム（Beat 設計書 Phase A で追加、シーン保存時にフロントが値を同梱） |

### Beat 冒頭の取得戦略

Grid は**最大数十シーン分**を同時に表示するため、カード描画のたびに各 Scene の `unplaced_beats_doc` 全体をパースして先頭 beat を取り出すのも避けたい（数十シーン × 数 KB の JSON パース）。**保存時にフロント側がプレビュー文字列を計算して同梱**するシンプルな方針を採る：

**`tree_nodes.unplaced_beat_preview` キャッシュカラム（Phase A）**

シーン保存時、フロントが `unplaced_beats_doc`（Beat 設計書参照）の先頭3 beat の冒頭40文字を抽出し、保存ペイロードに `unplacedBeatPreview` フィールドとして同梱する。バックエンドはその値を `tree_nodes.unplaced_beat_preview` に保存するだけ（中身は解釈しない）：

```sql
ALTER TABLE tree_nodes ADD COLUMN unplaced_beat_preview TEXT;
-- 値の形式: '["雨の夜、廃社の前で立ち止まる朱音","祭壇に置かれた朱紐を見つける","触れた瞬間に流れ込む見知らぬ記憶"]'
-- 値が NULL or '[]' なら表示しない
```

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
// global-settings.json
{
  "grid": {
    "compactCards": false,
    "showSynopsis": true,
    "showBeats": true,
    "showCodex": true,
    "showLabel": true,
    "filter": {
      "emptyOnly": false,
      "hideCompleted": false,
      "codexFilter": []
    }
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

### Phase A: Grid MVP

依存: Scenes パネル、Codex リレーション、Editor の Synopsis 機構、Beat システム設計書 Phase A の `unplaced_beats_doc` カラム（読み出しのみ）と `unplaced_beat_preview` キャッシュ

- [ ] **`tree_nodes.unplaced_beat_preview` カラムを追加**（Drizzle migration、Beat 設計書の `unplaced_beats_doc` / `char_count` と同 migration ファイルにまとめる）
- [ ] **プレビュー再計算トリガーの保存経路を特定**（既存の TipTap content 保存と `tree_nodes` メタ更新の経路を調査し、`unplaced_beats_doc` 変更時に `unplaced_beat_preview` を再計算・同梱する箇所を確定。debounce 保存・明示保存・Beat 編集確定など複数経路がある場合は1つに集約）
- [ ] シーン保存時にフロント側が `unplaced_beats_doc` から先頭3件×40文字を抽出して保存ペイロードに同梱（バックエンドは値を保存するだけ、解釈しない）
- [ ] **`<InlineSynopsisEditor>` 共有コンポーネントを新規作成**（`src/features/editor/InlineSynopsisEditor.tsx`）。Scenes Outline モードと Editor Synopsis セクションも同コンポーネントに切り替え（既存実装の置換）。`isEditing` を外部購読可能にし、ホスト側の D&D 無効化に利用
- [ ] 新規パネル `GridPanel` の実装（`src/features/grid/`）
- [ ] Container セレクタ（breadcrumb + ツリー型ドロップダウン、無効 ID のルートフォールバック含む）
- [ ] Chapter 列の描画（`tree_nodes` の folder ノード）
- [ ] Scene カードの描画（`tree_nodes` の scene ノード、Synopsis / beat 冒頭 / Codex チップ表示 / Status）
- [ ] Codex チップは**表示専用**（タイプ別色分け・チップクリックで Codex 詳細パネル起動）。`+ Codex` / `×` ボタンは出さない
- [ ] `+ New Scene` / `+ New Chapter`（自動採番、追加後インライン編集）
- [ ] カードタイトルクリック → Editor 起動
- [ ] Synopsis インライン編集（編集中はカード D&D 無効）
- [ ] D&D による Scene 並べ替え（同列内、`sort_order` 更新のみ）
- [ ] D&D による Scene の chapter 間移動（`parent_id` + `sort_order` 更新のみ、関連テーブル touch なし）
- [ ] D&D による Chapter 列の並べ替え
- [ ] カード `[⋮]` メニュー（Open / Rename / Duplicate / Delete / Move to chapter… / Show in Scenes）
- [ ] Loose Scenes 仮想列の対応（個別 Scene の D&D のみ。仮想列ごとの一括変換は Phase B+）
- [ ] レイアウト: Bottom Dock デフォルト非表示（レイアウトシステム設計書に追記）
- [ ] Container 選択の永続化（プロジェクトスコープ、無効 ID は起動時にルートへフォールバック）
- [ ] ヘッダーの 🔍 検索アイコンは Phase A では非表示または disabled で配置（Phase B で機能実装）
- [ ] 文字数表示は `tree_nodes.char_count` キャッシュ値をそのまま表示（**保存時点の値**であり、編集中はリアルタイム更新されない旨をツールチップ等で示唆）

### Phase B: 機能拡張

- [ ] 🔍 検索（インクリメンタル、ヒット外カードグレーアウト）
- [ ] フィルタ（空 Scene のみ / 完成済み非表示 / Codex フィルタ）
- [x] カード `[⋮] → Add unplaced beat...`（Editor 起動なしで beat 追加）
- [ ] Compact カード幅モード
- [ ] **Codex チップの直接編集**: `+ Codex` ポップオーバー（Chat パネル「📌ピン留め追加ポップオーバー」を共有可能コンポーネントとしてリファクタしたうえで再利用）、`×` で削除
- [x] Loose Scenes 仮想列の一括操作（既存 Chapter にまとめる／新規 Chapter folder に変換）
- [ ] カード本体の Status バッジ表示
- [ ] 文字数カード表示のリアルタイム更新（編集中も反映）
- [x] **Beat 主表示化**: カード本体上段の優先順位を Beat 箇条書き優先に切替、Synopsis を副表示（折りたたみ）に降格。`unplaced_beat_preview` の抽出パラメータを 8件 × 60文字に拡張
- [ ] **POV chip 行**: ヘッダ直下に effective POVs（scene POV ∪ Beat 内 POV オーバーライド）を chip 表示。詳細は「POV chip」節参照
  - データソース: `scene_beat_pov_cache` を SELECT、空なら `tree_nodes.povCharacterId` を fallback
  - 順序: scene POV を先頭固定、後続は Beat 出現順、scene POV と一致する cache POV は dedupe
  - スタイル: scene POV は塗り chip、Beat 由来のみはアウトライン chip（character タイプ色を共通使用）
  - 上限: 3人 + `+N more` バッジ。バッジクリックでポップオーバーで全員表示
  - クリック: character codex 詳細パネルを開く（編集自体は Editor 側で）
  - cache 更新は既存の `EditorPane.tsx:472` / `LinearSceneBlock.tsx:102` の保存経路にすでに組み込み済みなので追加実装不要
- [ ] **Label 機能**（手法非依存の色タグ。Scrivener corkboard 流）
  - `tree_nodes.label_id` カラム + 新規 `labels` テーブル + プロジェクト設定 UI が前提
  - Grid カード上は左端の細い縦カラーバーで表示（情報密度を上げない）
  - Scenes パネル / Editor などへの波及あり、独立タスクとして設計が必要
- [ ] **伏線リンク表示**: 伏線レジスタ（Phase 1〜5 実装済み）と接続し、カードフッタに「promise N · payoff M」counter を表示。ホバーで anchor 一覧ポップオーバー
  - データソース: `foreshadow_setups` / `foreshadows.payoff_scene_id` を scene_id で集計
  - 既存テーブルからの集計のみで新規データモデル不要

### Phase C: 連携機能

- [ ] Matrix → Grid のクロスナビゲーション（「Show in Grid」）
- [ ] Grid 上のカード複数選択 + 一括操作（一括移動、一括削除）
- [ ] Label 機能対応（Label 機能が別途追加されたら）

### Phase D: AI 連携（v2+）

- [ ] カード `[⋮] → Generate scene from chapter outline`（章のサマリーから Scene 提案）
- [ ] 空カード / `+ New Scene` の AI ドラフト生成

---

## Phase 着手前にユーザー確認が必要な決定事項

### Container セレクタのデフォルト位置

- **暫定方針**: プロジェクトルート（最上位 folder 群を列として表示）
- 代替案: 最後にユーザーが Editor で開いていた Scene の親 chapter
- **判断ポイント**: 起動時に「全体俯瞰」が欲しいか「直近作業の続き」が欲しいか

### Loose Scenes の扱い

container 直下に Scene が直接ぶら下がっている場合の仮想列の扱い：

- **暫定方針**: 「`Scenes`」という名前の仮想列として最右に表示
- 代替案: container 直下を単一列として扱い、「+ New Chapter」で初めて列が分裂する
- 代替案: Loose Scenes はカード列ではなく上部にバナー表示

### 編集ロックの粒度

複数ユーザーや複数ウィンドウで同 Scene を同時編集した場合の挙動：

- **暫定方針**: ロックなし（最後の保存が勝ち）。Grimodex はローカル単独運用前提のため
- v2 で WAL ベースの楽観ロックを検討

### Beat 冒頭の文字数制限

カード本体に表示する Unplaced beat の冒頭文の長さ：

- **暫定方針（Phase A）**: 各 beat 冒頭1行（最大40文字）、最大3 beat 表示。それ以上は「+N more」リンク
- **Phase B（Beat 主表示化）**: 暫定 8件 × 60文字に拡張（データモデル「Beat 冒頭の取得戦略」参照）
- 代替案: 全 beat を全文表示（カード高さ可変）

### カード幅とレイアウト

- **暫定方針**: 列幅固定 300〜400px、横スクロールで多列表示
- 代替案: ウィンドウ幅に応じた列数自動調整（列幅は可変）

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
