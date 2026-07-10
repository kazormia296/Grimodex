# Grimodex Matrixパネル設計書

## 概要

Matrix パネルはプロジェクト内のシーン × Codex エントリのクロス表を表示し、ストーリー全体の**登場分布・網羅性・整合性**を点検する俯瞰系パネル。Excel/スプレッドシート的な操作感を提供する。

Scenes（階層構造・1次元）、Timeline（時間軸・1次元）、Map（2D空間・連続座標）と並ぶ第4のマクロビュー。Map と同じ「2次元」だが本質的に異なる：

| パネル | 軸 | 答える問い |
|--------|----|----|
| Scenes | 階層構造 | 読む順は？ |
| Timeline | 時間軸 | いつ起きた？ |
| Map | 連続座標 | どう関係している？ |
| **Matrix** | **離散カテゴリのクロス表** | **どこに何が登場する？** |

セルが埋まれば「そのシーンにその Codex が登場する」ことを示す存在マップで、subplot がどの章で扱われているか、特定キャラがどの範囲に出てくるかを一覧できる。連続座標の Map では同じ表現がしにくい。空白セルは単に登場しないことを示すが、登場範囲の端を確認する目印として機能する。

デフォルト位置: Bottom Dock（非表示）。Map と並んで「俯瞰系」のパネル。

設計思想: **Matrix はクロス表をもつビュー。行（シーン）と列（Codex / POV / Label / Subplot）の組み合わせを切り替えることで、同じデータの別の見方を提供する。**

---

## 目標 / 非目標

### 目標

- シーン × Codex の登場分布を可視化する（登場範囲・集中度・抜け）
- subplot の進行密度・収束を俯瞰する
- POV 配分・Label 配分の俯瞰
- Editor を開かずに「このシーンに Beat を追加する」プロッティング起点を提供する
- 既存の言及スキャン（Aho-Corasick）結果を Map と共有して計算コストを抑える

### 非目標

- セル内での本文編集（クリックで Editor に飛ぶ動線のみ）
- リアルタイム協調編集（v1 ではローカル単独）
- Map との完全なフィルタ同期（パネル間独立を優先、v2 で同期トグル検討）
- AI による登場漏れの自動検出（v2 以降の整合性チェック機能で扱う）

---

## 背景・設計判断

### なぜ専用パネルにするか（Map と統合しない）

Map と Matrix は同じ「2次元」だが目的が異なる：

- Map: 連続座標、関係の発見・クラスタリング、**探索的**
- Matrix: 離散カテゴリ、登場分布の可視化、**監査的**

Map のキャンバス上で Matrix を表現することは可能だが、**スプレッドシート的な操作感**（行/列ヘッダ固定、列折りたたみ、セルクリックでスクロール）は専用 UI でないと実現できない。Map のパフォーマンス特性（force layout の計算コスト）とも要件が異なる。

### なぜ Subplot 専用タイプを作らないか

Subplot は Codex の `lore` タイプ + `#subplot` タグで運用する。理由は Beat システム設計書に記載。Matrix の Subplot モードはこのタグでフィルタした `lore` エントリを列に表示する実装になる。

### セル粒度: 言及スキャン + リレーション + Beat メンションの和集合

「セルに ● が立つ」をどう判定するか。3つのソースがある：

1. **言及スキャン**: 本文中に Codex 名/alias が出現する（既存の Aho-Corasick）
2. **Codex リレーション**: シーンと Codex が明示的に紐付けられている
3. **Beat 内メンション**: Beat に `@codex_name` で記載されている

これらの**和集合**を ● とする。違いを区別したい場合はセルカラーで濃淡を表現する（本文言及 = 濃い色、リレーションのみ = 薄い色、Beat メンションのみ = 中間色）。

### フィルタは Map と独立

Matrix と Map のフィルタは独立管理する（v1 では「同期」機能を提供しない）。

理由：

- ユーザーが Map で見ているクラスタリングと Matrix で見ているクロス表は、しばしば別の問いに対する別の視点
- 同期トグルを v2 で検討する余地は残す（判断3案C）

---

## パネル構造

```
┌───────────────────────────────────────────────────────────────┐
│ A. ヘッダー                                                    │
│ Matrix      [Show: Codex ▼] [Sort: Reading ▼] [🔍] [⋮]        │
├───────────────────────────────────────────────────────────────┤
│ B. 表本体                                                      │
│         │ 太郎 │ 花子 │ 桐野 │ 廃社 │ 朱紐 │ 都  │ subplot A │
│ ────────┼──────┼──────┼──────┼──────┼──────┼─────┼──────────│
│ 一章:廃社│  ●  │      │  ●  │  ●  │  ●  │     │    ●     │
│ 二章:封じ│  ●  │  ●  │     │      │  ●  │     │    ●     │
│ 三章:都夜│  ●  │      │     │      │     │  ● │          │
│ 回想    │      │  ●  │     │  ●  │     │     │          │
│  ...                                                          │
├───────────────────────────────────────────────────────────────┤
│ C. ステータスバー                                              │
│ 12 scenes × 16 codex entries  •  47 cells filled  •  Saved   │
└───────────────────────────────────────────────────────────────┘
```

---

## A. ヘッダー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Matrix」。左寄せ |
| Show ドロップダウン | 何を列に表示するか（後述） |
| Tag フィルタ | Show モードで選ばれた候補列を Codex タグで絞り込む。**全モード共通で常時表示**（後述） |
| Sort ドロップダウン | 行の並び順 |
| 🔍 検索 | シーン名・Chapter 名・Codex 名で行/列を絞り込み（Chapter 名ヒット時は配下シーンを全表示、Scene 名ヒット時は親 Chapter を自動展開して表示） |
| [⋮] パネルメニュー | Display / Filter / Export / Help |

### Tag フィルタ

Show モードで選ばれた列候補に対し、Codex タグで二段目の絞り込みを常時かける。例：

- `Codex (characters)` + `#main` → 主要キャラのみ
- `Codex (lore)` + `#magic` → 魔法体系の lore のみ
- `Codex (all)` + `#track` → 著者が「Matrix で追跡したい」とマークしたものだけ

挙動：

- フィルタ未指定時は Show モードの全候補を表示
- 複数タグ指定時は **AND**（すべてのタグを持つエントリのみ）
- タグはオートコンプリート入力。Codex タグの既存集合から選択
- フィルタ状態は `global-settings.json` の `matrix.tagFilter[showMode]` に Show モードごとに保存（モードを切り替えると別のフィルタに切り替わる）
- **Custom モードでは Tag フィルタは無効**（Custom は手動選択のため、後述）

### Show モード

`tree_nodes` テーブルの実装に合わせ、シーン側のメタデータは `povCharacterId`（単一 FK）/ `locationId`（単一 FK）/ `storyTimeLabel`（plain text 単一値）の3つに限定される。Matrix の Show モードはこれを前提に設計する。

| モード | 列の内容 | セルの意味 |
|--------|------|------|
| `Codex (all)` | 全 Codex エントリ（タイプ別グループ化） | シーンに該当 Codex が言及/関連しているか |
| `Codex (characters)` | character タイプのみ | 同上 |
| `Codex (locations)` | location タイプのみ | 同上 |
| `Codex (items)` | item タイプのみ | 同上 |
| `Codex (lore)` | lore タイプのみ | 同上 |
| `POV` | character タイプの Codex エントリ | シーンの `tree_nodes.pov_character_id` を直接 JOIN（1行につき1セルだけ ●、未設定なら空行）。Beat レベル POV オーバーライド（`sceneBeat.attrs.pov` がシーン POV と異なる場合に該当キャラ列へ ★ を追加）は実装済み — `scene_beat_pov_cache` の `Set<"sceneId::characterId">` を読み込み、`MatrixCell` の `pov` kind で `isBeatOverride` 分岐 |
| `Location` | location タイプの Codex エントリ | シーンの `locationId`（同上） |
| `Subplot` | `#subplot` タグ付きの `lore` エントリ | subplot の進行密度（言及スキャン結果ベース） |
| `Custom` | **ユーザーが手動で追加した任意 Codex エントリの集合**（タイプ・タグ問わず） | 言及/関連の有無 |

> **Custom モードの仕様**: 任意の Codex エントリを手動で集めて列にする「ピン留め型」モード。Tag フィルタを使わず、列ヘッダの `+` ボタンまたは Codex パネルからの「Add to Matrix Custom」操作で1エントリずつ追加・削除する。複数の Custom セット（保存済みプリセット）を `global-settings.json` に保持し、ドロップダウンで切り替え可能（例: 「主要登場人物セット」「subplot A 関連セット」）。Tag フィルタによる動的集合では拾いきれない、ad-hoc な「この章で追跡したい組み合わせ」を表現する用途。

> **Note**:（2026-06-20 追記）シーンに対する多値ラベル（`labels`）の概念は**スキーマで実装済み**（`labels` テーブル＋`tree_node_labels` 結合テーブルによる `tree_nodes` ↔ `labels` の M:N 関係。`src/db/schema.ts`）だが、現行 Matrix 設計では列軸として利用していない。`storyTimeLabel` は単一テキストで Timeline 用途のため Matrix の列軸には不向き。ラベルを Matrix の列軸に採用する場合は既存の `labels` / `tree_node_labels` を JOIN する Show モードを追加すればよく、新規スキーマ追加は不要だが、本設計書では**範囲外**とする。

### Sort モード

| モード | 並び順 |
|--------|------|
| `Reading order` | Scenes ツリーの sortOrder（default） |
| `Story-time order` | Timeline の story-time order |
| `Word count` | シーンの本文文字数（降順） |
| `Last edited` | 最終編集時刻（降順） |

### パネルメニュー（[⋮]）

```
Display
  ☑ セルを ● で表示（dot, default）
  ☐ セルを言及回数（数値）で表示（count, Phase B）
  ☐ セルを濃淡（heatmap）で表示（Phase B）
  ☐ POV 色で表示（Phase B）
  ☐ Role-aware 表示（actor 太枠 / target 細枠 / POV ★、Phase B）
  ☑ Codex をタイプ別にグループ化

Filter
  ☐ 空セルを非表示
  ☐ 未編集シーンのみ表示
  ☐ Codex の Phase mismatch のみ表示（v2）

Export
  CSV をダウンロード
  PNG をダウンロード（v2）

Help
  Matrix の使い方
```

---

## B. 表本体

### 行: シーン（Scene 行と Chapter 行）

`tree_nodes` のツリー構造をそのまま行に展開する。

| 行種別 | `node_type` | 表示 | 操作 |
|--------|--------|------|------|
| **Scene 行** | `'scene'` | 通常行 | セルクリックで Editor 起動、右クリックで Beat 追加等 |
| **Chapter 行**（folder） | `'folder'` | ヘッダ行（背景暗・フォント太） | 折りたたみ可。クリックで配下 Scene 表示／非表示。**右クリックで Scene 追加（後述）** |

- Scenes ツリーの階層構造を維持（Part > Chapter > Scene の入れ子）
- Chapter 行を折りたたむと配下のシーン行が隠れる（行数を減らせる）
- シーン行・Chapter 行ともにカーソルホバーで行全体がハイライト

### 列: Show モードに応じた Codex エントリ集合

- Codex モード時はタイプ別グループ化（character / location / item / lore のセクション、各セクション折りたたみ可）
- Tag フィルタが指定されていれば、列候補はそのタグでさらに絞り込まれる
- Custom モード時は手動で追加したエントリのみが順序固定で並び、`+` ボタンで追加・列ヘッダの `×` で削除
- 列ヘッダ右クリックで「列を非表示」「ピン留め（左端固定）」「タイプセクションごと折りたたむ」（Custom モードでは「セットから削除」も追加）。実装は `ColumnHeaderMenu.tsx`
- 列幅は固定（`MatrixTable.tsx` の `COL_WIDTH = 80`）。**ドラッグによる列幅変更・列の D&D 並べ替えは未実装**。列の並び順は default で Codex の `sortOrder`

### セル

セルの挙動は行種別で分岐する。

#### Scene 行のセル

- **クリック**: 該当シーンの Editor を開く（**現状**: 該当 Codex の最初の言及位置への自動スクロールは未実装、シーンの先頭を開くのみ）
- **右クリック**:
  - **Open scene**: Editor で開く
  - **Show in Grid**: Grid パネルで該当シーンを reveal（実装拡張、`useGridStore.requestRevealScene`）
  - **Pin to scene**: Codex リレーションを明示的に作成（`source !== 'relation'` のときのみ表示）
  - **Remove association**: Codex リレーションを削除（言及ベースの ● は残る、`source === 'relation'` のときのみ表示）
  - **Add beat to this scene**: Unplaced beat を追加（列の Codex を `@mention` として自動挿入、後述「セルからの Beat 追加」）
  - **Show source**: ● の根拠を表示（言及／リレーション／Beat メンションのどれか）。**将来拡張**: 詳細モーダルでの全根拠リスト表示（現状はメニュー文言で最強 source のみ表示）

#### Chapter 行のセル

Chapter 行のセル自体には ● は描画されない（folder ノードはドキュメントを持たないため言及スキャン対象外）。代わりに、**hover 時に明示的な `+` ボタンを表示**し、ボタンクリックでのみ新 Scene を作成する：

- **空セル（hover していない）**: 何も表示しない、クリックは無反応（誤タップで Scene が増えるのを防ぐ）
- **空セル（hover）**: セル中央に薄い `+` ボタンを表示（hover 状態は CSS の `:hover` でセル単位に絞る、行全体 hover で全セルに `+` を出さない）
- **`+` ボタンクリック**: その Chapter folder 直下に新 Scene を作成。**列が紐付け対象を持つモードでは、列要素を新 Scene に自動付与**（後述「Show モード別の新 Scene 作成セマンティクス」参照）
- **右クリック（セルのどこでも）**:
  - **Add scene to this chapter (with @{列名})**: `+` ボタンと同じ動作（列要素を自動付与）
  - **Add scene to this chapter (no association)**: 列要素の自動付与なしで新 Scene
  - **Open chapter folder in Scenes panel**: Scenes パネルで該当 folder を選択

##### Show モード別の新 Scene 作成セマンティクス

| Show モード | 列の意味 | 自動付与される値 | 反映先 |
|------------|----------|--------------------|--------|
| `Codex (*)` / `Subplot` / `Custom` | Codex エントリ | 列の Codex を `scene_codex_pins` に INSERT（`source='relation'` 行も同期更新） | `scene_codex_pins` |
| `POV` | character Codex | 新 Scene の `tree_nodes.pov_character_id` をその character に設定 | `tree_nodes.pov_character_id` |
| `Location` | location Codex | 新 Scene の `tree_nodes.location_id` をその location に設定 | `tree_nodes.location_id` |

POV / Location モードでは `scene_codex_pins` には書かない（メタデータカラムとリレーションテーブルの二重持ちを避ける）。Codex モードで紐付けた列が同時に POV キャラだった場合でも、POV カラムは触らず `scene_codex_pins` のみ更新する（POV 設定はユーザーの明示操作に任せる）。

新 Scene の挿入位置：

- Chapter folder の**末尾子要素**として挿入
- Scene 名はデフォルトで `Scene N`（同 Chapter 内の連番、Scenes パネル設計書の自動採番ロジックを流用）
- 作成後は Editor を開かず Matrix にとどまる（連続追加を妨げない）。新 Scene 行が Matrix 内に即座に追加され、列 Codex セルに ◯（リレーションのみ、本文未登場）が点く

新 Scene 作成直後の即時入力 UX：

- 行ヘッダ位置に小さなインライン入力ポップオーバーを開く（Beat 追加ポップオーバーと同じ実装パターン）
- Synopsis の textarea + 「Add another scene」ボタンを表示
- Synopsis 入力 → Enter で確定、`tree_nodes.synopsis` に保存
- 「Add another scene」を押すと同 Chapter の次行に再度ポップオーバーが開き、連続入力できる（Matrix 上で章構成を一気に書き出す用途）
- Esc または外側クリックでポップオーバーを閉じる（Synopsis は空のまま、Scene 行だけ残る）

### Scene 行ヘッダーの右クリック

- **Open scene**: Editor で開く
- **Add beat to this scene**: Codex 自動挿入なしで Unplaced beat を追加
- **Rename scene**: シーン名を変更
- **Show in Scenes panel**: Scenes パネルで該当ノードを選択

### Chapter 行ヘッダーの右クリック

- **Add scene to this chapter**: Codex 紐付けなしで新 Scene を folder 末尾に追加
- **Rename chapter**: Chapter 名を変更
- **Show in Scenes panel**: Scenes パネルで該当 folder を選択
- **Collapse / Expand**: 配下シーン行の表示切替

### セルの表示モード

| モード | 表示 | 用途 | 導入 Phase |
|--------|------|------|--------|
| `dot` | ● / 空欄（default） | 言及の有無のみ | Phase A |
| `count` | 根拠の種類数（数値） | どの根拠で濃く埋まっているか | Phase B |
| `heatmap` | 根拠別の背景色濃淡 | 集中・分散の俯瞰 | Phase B |
| `pov-color` | （現状 `dot` と同等表示） | 視点配分の俯瞰（将来） | Phase B（部分） |
| `role-aware` | actor / target / mentioned / POV を視覚分離 | 誰が能動側／受動側／視点かを区別する | Phase B |

Display モードのドロップダウン（`MatrixHeader.tsx` の `getDisplayModes()`）は上記 5 つを選択可能（`dot` / `count` / `heatmap` / `pov-color` / `role-aware`）。

> **（2026-06-18 追記）現状の実装**:
>
> - `count` は `scene_codex_mentions` の `mention_count` 未実装のため、**根拠の種類数 `cellInfo.sources.size`（最大 3＝body/beat/relation）** を表示する簡易実装（`deriveCellDisplay()` / `deriveCellRender.ts`）。正確な言及回数表示は `mention_count` カラム追加後に切り替える。
> - `heatmap` は最強根拠（`topSource`）を 3 段（relation=1 / beat=2 / body=3）にマップした背景色濃淡（`HEATMAP_INTENSITY`）。
> - **`pov-color` はドロップダウンに存在するが `deriveCellDisplay()` に専用 case が無く `default` で `dot` 表示にフォールスルーする**（POV キャラ色の塗り分けは未実装）。POV 配分の俯瞰には Show モード `POV`（後述 ★ オーバーライド付き）を使う。
> - `beat-list` モード（Beat 箇条書き表示）は設計案のみで**未実装**（`DisplayMode` 型・ヘッダーいずれにもトグルが無い）。Beat の計画ビューは Grid パネルが担う。

`dot` モードでもセル背景のカラーで根拠を区別する：

- 濃色（実線 ●）: 本文言及あり
- 中間色: Beat メンションのみ
- 薄色（輪郭のみ ◯）: Codex リレーションのみ（本文未登場）

### Role-aware モードの仕様（Phase B）

Beat システム設計書の Phase B で導入された Codex メンション role 修飾子（`actor` / `target` / `mentioned`）と、`sceneBeat.attrs.pov` を利用して、セル内に役割記号を描画する。

| 表示記号 | 意味 |
|--------|------|
| **太枠 ●** | このシーンのいずれかの beat で `@codex:actor` として登場 |
| **細枠 ◯** | このシーンのいずれかの beat で `@codex:target` として登場 |
| **薄 ●** | `mentioned`（role 未指定） |
| **★** | beat の `pov` または シーンの `povCharacterId` がこの Codex |
| **複合表示** | 1セルに複数役割が成立する場合は記号を併記（例: `★●`＝この beat の POV かつ actor） |

ソース判定の優先順位（複数該当時は強い側を採用）：

1. POV（最強、★ 必ず表示）
2. actor（太枠）
3. target（細枠）
4. mentioned（薄）

> **現状の実装**: Role-aware モードは UI 上で常時選択可能（Phase A 時点での disabled 表示は採用していない）。`source='beat'` 行が無いシーンでは role が `'mentioned'` フォールバックとなり、`·` を表示する（`MatrixCell.tsx`）。記号と背景色の具体配色は実装側の決定。

---

## セルからの Beat 追加

Matrix の最大の付加価値のひとつ。Editor を開かずにプロッティングできる。

### フロー

1. Matrix のセルを右クリック → 「Add beat to this scene」を選ぶ
2. 小さなインライン入力ポップオーバーが表示される（Beat instructions を入力）
3. 列の Codex エントリ（キャラ・場所等）が**自動的に `@mention` として挿入**される（初期テキスト）
4. ユーザーが内容を編集して確定
5. 該当シーンの Unplaced beat として保存される

例: `太郎` 列 × `三章:都夜` 行のセルを右クリックすると、初期テキストが `@太郎 ` の状態でポップオーバーが開く。

### シーン行ヘッダーからの Beat 追加

シーン行のヘッダー（左端）右クリックでも「Add beat to this scene」が使えるが、Codex 自動挿入はない（どの Codex に紐づけるか不明なため）。

### 保存先

追加された beat は該当シーンの `tree_nodes.unplaced_beats_doc` 配列の末尾に push される。詳細は Beat システム設計書参照。

### 連続入力モード（v2）

「Add beat」ダイアログを開きっぱなしにして、次のセルクリックで対象シーンが切り替わる連続入力モード。Matrix を見ながら複数シーンに連続で Beat を追加するワークフロー向け。v2 で検討。

---

## C. ステータスバー

```
// Phase A（MVP）
12 scenes × 16 codex entries  •  47 cells filled  •  Settings: Saved

// v2（整合性チェック投入後）
12 scenes × 16 codex entries  •  47 cells filled  •  Settings: Saved  •  ⚠ 2 warnings
```

| 要素 | 表示 | 導入 Phase |
|------|------|-----------|
| 表サイズ | `{シーン数} × {Codex数}` | Phase A |
| 埋まっているセル数 | `{count} cells filled` | Phase A |
| 設定保存状態 | `Settings: Saved` / `Settings: Saving...`（Matrix 自身のフィルタ・ソート設定の永続化状態。表データ自体は他パネルに依存し、ここでは保存状態を扱わない） | Phase A |
| キャッシュ状態 | `Scanning... 12/500` キャッシュ再構築中のみ表示（後述「キャッシュ戦略」参照） | Phase A |
| 整合性警告 | `⚠ N warnings` クリックで詳細表示 | v2 |

---

## 整合性チェック機能（v2）

Matrix の付加価値として、以下の警告を表示する。MVP では出さず、v2 以降。

| 警告 | 検出条件 | 例 |
|------|--------|-----|
| **Phase mismatch** | Codex フェーズが「死亡後」のキャラがシーンに登場 | 桐野（死亡フェーズ）が四章に言及されている |
| **Location mismatch** | 排他的な世界観タグの矛盾 | 妖精界限定のキャラが人界シーンに |
| **Subplot orphan** | 第 N 部以降に出てこない subplot | subplot A が第3部から消えている |
| **POV mismatch** | シーンに POV が設定されていない | 一章:廃社 の POV が空 |
| **Codex unused** | プロジェクトに登録されているが一度も言及されない | Codex `朱紐` がどのシーンにも出てこない |

これらは**設定情報**（Codex のフェーズ、リレーション、タグ）から自動判定する。誤検出を許容するため、各警告は「Dismiss」「Investigate（該当セル/シーンへスクロール）」のアクションを持つ。

---

## データモデル

### Matrix の表示データは導出可能

Matrix の表示内容は以下から計算される：

- **Codex 言及スキャン結果**（後述キャッシュテーブル `scene_codex_mentions` に永続化）
- **Codex リレーション**（既存テーブル）
- **TipTap ドキュメント内の `sceneBeat` ノードの `@mention`**（Beat システム設計書参照、シーン保存時にキャッシュへ反映）
- **シーンの `povCharacterId` / `locationId`**（`tree_nodes` 既存カラム）

新規追加するのは `scene_codex_mentions` キャッシュテーブルのみ。データの一次ソースは既存テーブル / TipTap ドキュメントで、Matrix 専用の永続化データは持たない。

### ユーザー設定の永続化

Matrix のフィルタ・ソート設定は `global-settings.json` に保存。

```json
{
  "matrix": {
    "showMode": "codex-all",
    "sortMode": "reading",
    "displayMode": "dot",
    "groupCodexByType": true,
    "hiddenColumnIds": [],
    "pinnedColumnIds": [],
    "collapsedTypeSections": [],
    "subplotTagName": "subplot",
    "tagFilter": {
      "codex-all": [],
      "codex-characters": ["main"],
      "codex-locations": [],
      "codex-items": [],
      "codex-lore": [],
      "pov": [],
      "location": [],
      "subplot": []
    },
    "customSets": [
      {
        "id": "set-1",
        "name": "主要登場人物セット",
        "codexEntryIds": ["entry-taro", "entry-hanako", "entry-kirino"]
      }
    ],
    "activeCustomSetId": "set-1"
  }
}
```

`subplotTagName` は Subplot モードで列に表示する Codex タグの名前。default は `subplot`。

**`subplotTagName` と `tagFilter.subplot` の関係**: `subplotTagName` は Subplot モードの**列候補生成のための基底タグ**（lore 中で `#subplot` を持つエントリを列にする）。`tagFilter.subplot` はその上にかかる**追加 AND フィルタ**（例: `#main_arc` を AND 指定すれば「`#subplot` かつ `#main_arc` の lore のみ」）。二段階で役割が異なる。

---

## 言及スキャン結果のキャッシュ戦略

シーン × Codex のクロス表は計算量が大きい（500シーン × 100Codex = 50,000セル）。

### 現状の実装

現状、Codex 言及スキャンは `findMentionedEntriesAsync()`（`src/features/codex/rustMatcher.ts`）が Rust 側 Aho-Corasick マッチャーを介して実行する。**結果は永続化されておらず、メモリ上で都度計算**される。Codex Quick / Editor のハイライト用途では「現在開いているシーン1つ」しか走査しないため、これで十分高速。

しかし Matrix は**全シーン × 全 Codex の結果**を要求するため、現状のメモリ計算では Matrix を開くたびに全シーン分のスキャンが走り、初回ロードが遅くなる（500シーンで数秒〜十数秒）。

### Phase A で導入する2つの新規テーブル

Phase A で **2つの新規テーブル**を追加する。1つは明示的リレーション、もう1つはキャッシュ：

#### 1. `scene_codex_pins`（明示的リレーション）

シーン単位で Codex エントリを明示的に紐付けるテーブル。「Pin to scene」「Add scene to chapter (with this codex)」操作の保存先。Codex Quick の project-wide pin（既存 `codex_quick_pins`）とは別物（あちらはプロジェクト全体ピン、scene 単位ではない）。

**現状の実装**（`src/db/schema.ts` / `src-tauri/crates/grimodex-db/src/migrate.rs`）:

```sql
CREATE TABLE scene_codex_pins (
  scene_id   TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  entry_id   TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scene_id, entry_id)
);
CREATE INDEX idx_scene_codex_pins_scene ON scene_codex_pins(scene_id);
CREATE INDEX idx_scene_codex_pins_entry ON scene_codex_pins(entry_id);
```

`created_at` は SQL の `DEFAULT (datetime('now'))` ではなく、アプリ側（`upsertScenePin`）で ISO8601 文字列を埋める。カラム名は設計書上の `codex_entry_id` ではなく **`entry_id`** で確定済み（Grid パネル先行実装の都合、改名はしない）。

このテーブルが下記キャッシュの `source = 'relation'` 行の一次ソースになる（同期更新）。Grid のカードで表示する Codex チップもこのテーブルを参照する。

#### 2. `scene_codex_mentions`（言及スキャンキャッシュ）

下記の永続化キャッシュテーブル：

**現状の実装**（`src/db/schema.ts` / `src-tauri/crates/grimodex-db/src/migrate.rs`）:

```sql
CREATE TABLE scene_codex_mentions (
  scene_id        TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,                          -- 'body' | 'beat' | 'relation'
  role            TEXT NOT NULL DEFAULT 'mentioned',      -- 'mentioned' | 'actor' | 'target'
  PRIMARY KEY (scene_id, codex_entry_id, source)
);
CREATE INDEX idx_scm_codex ON scene_codex_mentions(codex_entry_id);
CREATE INDEX idx_scm_scene ON scene_codex_mentions(scene_id);
```

`source` はセル背景色の根拠区別（本文言及 / Beat メンション / Codex リレーション）に使う。1シーン × 1 Codex でも、根拠ごとに最大3行（`source='body'/'beat'/'relation'`）まで持てる。

> **※ 現状未実装**: `mention_count` カラムと `last_scanned_at` カラムは Phase A 時点では未追加。Phase B で `count` / `heatmap` Display モードを正式運用する際に additive 追加する想定。現状の `count` モードは便宜的に `cellInfo.sources.size`（根拠の種類数、最大3）を表示するに留まる（`src/features/matrix/lib/deriveCellRender.ts`）。

`role` は Codex メンション role 修飾子（Beat 設計書参照）を保持し、`source='beat'` の行のみ意味を持つ：

- `source='body'`: 本文テキストは actor/target を語らないので常に `'mentioned'`
- `source='relation'`: 明示リレーションは役割を持たないので常に `'mentioned'`
- `source='beat'`: 1シーン内の複数 beat に同じ Codex が異なる role で登場した場合、優先順位 `actor > target > mentioned` の **最強値**を1行に保持（Matrix の Role-aware 表示は1行参照で完結する）

**現状の実装**: `role` カラムは DDL に含まれており、`upsertSceneBeatMentions()`（`src/features/editor/beat/mentionApi.ts`）が `source='beat'` 行に actor/target/mentioned の値を書き込み済み。Phase B の Role-aware Display モードは UI 上で選択可能（`MatrixHeader.tsx`）。

**POV はこのテーブルに含めない**。POV は「言及」ではなくメタデータのため `scene_codex_mentions` の責務範囲外：

- シーン POV: `tree_nodes.pov_character_id` を Matrix 描画時に直接 JOIN
- Beat POV（`sceneBeat.attrs.pov`）: `scene_beat_pov_cache` テーブル（`beatPovCacheApi.ts` 経由で保存時に upsert）に永続化済み。Matrix 描画時は同テーブルを `Set<"sceneId::characterId">` 形式で読み込み、★ オーバーライド表示に利用する（`MatrixPanel.tsx` の `beatPovCache`）。詳細は後述「Phase B POV オーバーライドの走査戦略」参照

### 更新タイミング

- **シーン保存時**: 該当シーン行を全 Codex に対して再計算（既存の保存パイプラインに hook）。本文 docJson から `source='body'` 行を、`unplaced_beats_doc` および本文中の `sceneBeat` ノードから `source='beat'` 行をそれぞれ算出して upsert する（同一トランザクションで両 source を同時更新）
- **Codex エントリ追加・rename・alias 変更**: 同じ部分再スキャン経路を共通利用 — **該当 Codex 1件のパターンだけ**を対象として全シーンを非同期スキャン（バックグラウンドジョブ、キュー実装）。その Codex 列の `source='body'` / `source='beat'` 行のみ更新し、他 Codex の行は触らない
- **Codex エントリ削除**: キャッシュから該当列を `ON DELETE CASCADE` で自動削除
- **Codex リレーション変更**（`scene_codex_pins` の INSERT/DELETE）: 該当ペアの `source='relation'` 行を**同一トランザクション内で**同時更新（後述「リレーション同期の実装規約」）

#### `source='beat'` 行の算出ロジック

`source='beat'` 行が表すのは「シーン内の Beat（unplaced + placed の両方）に該当 Codex の `@mention` が含まれるか」。Phase A での仕様：

- スキャン対象: `tree_nodes.unplaced_beats_doc`（ProseMirror JSON）と本文 docJson 内の `sceneBeat` ノードを連結し、その中の `mention` ノードを列挙
- `mention_count`: シーン内の Beat 全体での `@codex` 言及回数の合計
- `role`: Phase A は常に `'mentioned'`（Beat 設計書 Phase B で role 修飾子が入った時点で actor/target/mentioned の最強値に切り替え。スキーマ変更不要）
- 行が0件になる場合は DELETE（`mention_count=0` の行を残さない）

#### リレーション同期の実装規約

`scene_codex_pins` の INSERT/DELETE は **必ず専用関数 `upsertScenePin()` / `deleteScenePin()` 経由**（`src/features/codex/sceneCodexPinsApi.ts`）で行う。これらの関数の内部で `scene_codex_mentions` の `source='relation'` 行を同期 upsert / delete する。

- DB トリガーは使わない（Drizzle ORM 経路の透明性を優先）
- `scene_codex_pins` への直接 INSERT/DELETE クエリを書かない（コードレビューで弾く規約）
- Scene / Codex の CASCADE 削除は `scene_codex_mentions` 側にも `ON DELETE CASCADE` が効くため、`scene_codex_pins` 経由の二重削除は不要

> **現状の実装**: sqlite-proxy がトランザクション API を露出していないため、**同一トランザクションでの atomic 同期ではなく** insert-first / prune-after の順序で fail-safe を担保している（同様の規約は `upsertSceneBodyMentions` / `upsertSceneBeatMentions` でも共通、`bodyMentionApi.ts` / `mentionApi.ts` 参照）。書き込み後は `bumpMatrixDataVersion()` で Matrix の再読み込みをトリガする。

### `mention_count` の Phase A 役割

> **※ 現状未実装**: `scene_codex_mentions.mention_count` カラムは Phase A 時点では追加されていない（DDL から省略済み）。`upsertSceneBodyMentions()` / `upsertSceneBeatMentions()` は「シーン × Codex × source の存在」のみを upsert し、回数は保持しない。Phase B で `count` / `heatmap` モードを正式運用する際は、`mention_count INTEGER NOT NULL DEFAULT 0` の additive migration と、保存パイプライン側の集計コードを同時投入する。

`dot` モードでは `mention_count` は表示に使わないが、Phase B で**正確な count を保存する**設計とする：

- Aho-Corasick マッチャーの戻り値を集計するだけのため、保存時の追加コストは無視できる
- Phase B で `count` / `heatmap` モードを投入する際に**全シーン再スキャンが不要**になる（Settings の手動再構築依存を回避）
- `source='beat'` 行の count はシーン内 Beat 全体での `@mention` 回数

#### 部分再スキャンの理論的限界と逃げ道

「該当 Codex 列のみ再スキャン」は Aho-Corasick の最長一致挙動により、稀に他 Codex のマッチを巻き込む可能性がある（rename 後の新パターンが他 Codex の名前と接頭/接尾で衝突する場合など）。実用上の頻度は低いが、整合性が疑われたときの逃げ道として **Settings → Data → "Codex 言及キャッシュを再構築"** ボタンを Phase A から提供し、全 Codex × 全シーンの完全再スキャンをユーザーが手動で叩けるようにする（進捗バー付き）。

### Phase B POV オーバーライドの走査戦略

Beat レベル POV オーバーライド（`sceneBeat.attrs.pov`）を Matrix の POV モードに反映する際、**走査タイミングは「シーン保存時のキャッシュ」一択**とする：

- **採用**: 保存時に本文 docJson 内の `sceneBeat` ノードを走査し、シーン POV と異なる Beat POV を `scene_beat_pov_cache` テーブルに永続化。Matrix 描画時はこのキャッシュを JOIN するだけで済む
- **不採用**: Matrix 描画のたびに全シーンの docJson を走査するアプローチ（500シーン分の docJson パースは Matrix の俯瞰用途と相反する）

**現状の実装**（`src/db/schema.ts` / `src-tauri/crates/grimodex-db/src/migrate.rs`）:

```sql
CREATE TABLE scene_beat_pov_cache (
  scene_id          TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  pov_character_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (scene_id, pov_character_id)
);
CREATE INDEX idx_scene_beat_pov_scene ON scene_beat_pov_cache(scene_id);
```

`extractBeatPovOverrides()` → `upsertSceneBeatPovOverrides()`（`src/features/editor/beat/`）の経路でシーン保存時に upsert される。Matrix 側は `MatrixPanel.tsx` の `beatPovCache: Set<string>` として全行を読み込み、POV モードのセルで ★ を描画する（`MatrixCell.tsx` の `pov` kind 分岐）。

「シーン POV と異なる Beat POV のみ」を行として持つ（差分のみ保存）。シーン POV と一致する Beat POV は記録しない（行を 1 シーンあたり数行に抑える）。

### 不採用の戦略

- **Matrix を開いた時だけスキャン**（旧案）: 500シーン × 100Codex で数秒、UX が悪い
- **バックグラウンド継続スキャン**: CPU 消費が大きく、バッテリー駆動で問題
- **既存メモリ実装の流用**（旧案）: 永続化されないため Matrix 起動のたびに全走査が必要

### 進捗表示

バックグラウンドスキャン中はステータスバーに `Scanning... 12/500` の形で表示。スキャン中もキャッシュの古い値で表は描画される（表示が空白にならない）。

### 既存実装との整合

`findMentionedEntriesAsync()` は現状通り Editor / Codex Quick で使用継続。Matrix のキャッシュ更新は同じ Rust マッチャーを呼ぶラッパーから入る（重複コードを避ける）。

---

## 既存システムとの接続

### Map との接続

- 言及スキャン結果のバックエンド（`scene_codex_mentions` キャッシュ）を共有
- フィルタ状態は別管理（v1）
- 将来: Matrix のセルクリック → Map で該当シーン・Codex をハイライトする「Show in Map」コンテキストメニュー（v2）

### Timeline との接続

- Sort モードに `Story-time order` を含める。Timeline の story-time order と同じ並び順を使用
- Timeline で時系列を編集すると Matrix の Sort 順も即座に反映される

### Scenes との接続

- 行は Scenes ツリーの階層構造（Part / Chapter / Scene）を維持
- シーン行ヘッダー右クリック「Show in Scenes panel」で Scenes パネルにフォーカス

### Editor との接続

- セルクリック → Editor で該当シーンを開き、該当 Codex の最初の言及位置にスクロール
- セルが空欄でクリックされた場合は単にシーンを開く
- Editor 側で本文が変更されると Matrix のセルも非同期に更新

### Codex との接続

- 列は Codex エントリの一覧から生成
- Codex タイプ別グループ化はデフォルト ON
- Subplot モードは `#subplot` タグ付きの `lore` エントリを列に表示

### Beat システムとの接続

- セル右クリック → 「Add beat to this scene」で Unplaced beat を追加
- 列の Codex エントリは `@mention` として自動挿入
- Beat 内 `@mention` も Matrix のセル ● の根拠のひとつ（中間色で区別）

---

## 実装フェーズ

### Phase A: Matrix MVP

依存: Codex 言及スキャナ、Scenes ツリー、Timeline の story-time order、Beat システム設計書 Phase A の Unplaced beat 機構

- [x] **`scene_codex_pins` テーブルの新規追加**（Drizzle migration）— 明示リレーションの一次ソース。Grid のカード Codex チップもこれを参照（カラム名は `entry_id`）
- [x] **`scene_codex_mentions` キャッシュテーブルの新規追加**（Drizzle migration、PK は `(scene_id, codex_entry_id, source)`、`role` カラムは現在 `source='beat'` 行のみが actor/target/mentioned 値を持つ）
- [x] シーン保存時のキャッシュ更新フック（`upsertSceneBodyMentions` / `upsertSceneBeatMentions` で本文 + Beat の両 source を insert-then-prune で upsert。トランザクション API が無いため fail-safe 順序で代替）
  - ※ `mention_count` は **未実装**（Phase B で additive 追加）
- [x] Codex 追加・rename・alias 変更時のキャッシュ部分再構築バックグラウンドジョブ（`mentionRescanQueue.ts`、該当 Codex 列のみ対象スキャン）
- [x] **`scene_codex_pins` 操作の専用関数化**（`upsertScenePin()` / `deleteScenePin()` を `sceneCodexPinsApi.ts` に実装、内部で `scene_codex_mentions` の `source='relation'` 行を insert-then-prune 順で同期。直接 INSERT/DELETE は禁止規約）
- [x] **Settings → Data → "Codex 言及キャッシュを再構築" ボタン**（`src/features/settings/categories/DataCategory.tsx`、`enqueueRescan(null)` を呼び全 Codex × 全シーン再スキャン、進捗は `useRescanStore` 経由でステータスバーに表示）
- [x] 新規パネル `MatrixPanel` の実装（`src/features/matrix/`）
- [x] Codex モード（default）
- [x] 行: シーン階層、列: Codex（タイプ別グループ）
- [x] セル表示（`scene_codex_mentions` キャッシュを参照、根拠別に背景色を変える）
- [x] **Tag フィルタ UI**（オートコンプリート、AND 条件、Show モードごとに別状態を保持）
- [x] Sort: Reading order / Story-time order
- [x] 🔍 検索（行/列の絞り込み、Chapter 名ヒット時は配下シーンを全表示、Scene 名ヒット時は親 Chapter を自動展開）
- [x] セルクリックで Editor を開く
- [x] **Scene 行のセル右クリック → 「Add beat to this scene」**（列の Codex を `@mention` として自動挿入。実装は `addUnplacedBeatFromGrid` の共通経路）
- [x] **Scene 行ヘッダー右クリック → 「Add beat to this scene」**（Codex 自動挿入なし）
- [x] **Scene 行のセル右クリック → 「Show in Grid」**（Grid パネルで該当シーンを reveal、設計書本文には未記載の実装拡張）
- [x] **Chapter 行のセルは hover 時のみ `+` ボタンを表示**（誤クリック防止のため、空セル全面ホットエリアにはしない）
- [x] **`+` ボタンクリック / セル右クリック → 「Add scene to this chapter」**（folder 末尾に挿入、`treeStore.createNode` 経由）
  - ※ **現状未実装**: POV/Location モード時の新 Scene への `pov_character_id` / `location_id` 自動付与は未対応。現状は showMode 種別にかかわらず `upsertScenePin` で `scene_codex_pins` に登録する（`MatrixPanel.tsx::handleAddScene`）
- [x] **Chapter 行ヘッダー右クリック → 「Add scene to this chapter」**（列要素の自動付与なし）
- [x] **新 Scene 作成直後のインライン入力ポップオーバー**（`ScenePopover` で Synopsis 即入力、「Add another scene」で連続追加）
- [x] レイアウト: `panelRegions.ts` の `matrix: "center-bottom"`（Bottom Dock 相当）デフォルト非表示
- [x] 設定の永続化（`global-settings.json` の `matrix.*`、`matrixStore.ts` の 600ms debounce）
- [x] **TanStack `useVirtualizer`** による行・列両方の仮想スクロール（設計時の想定は react-window、実装では同等の `@tanstack/react-virtual` を採用）

### Phase B: Matrix 拡張

- [x] Show モード切替（`POV` / `Location` / `Subplot` / `Custom`）— `MatrixHeader.tsx` の `SHOW_MODES` に列挙、`deriveColumns` で分岐
- [x] Custom モード: ヘッダの `+` ボタンでセット作成、`ColumnHeaderMenu` の「セットから削除」、Codex パネルからの「Add to Matrix Custom」
- [x] Custom モード: 複数プリセットの保存・切替・rename・削除（`matrixStore.ts` の `customSets` / `activeCustomSetId`）
- [x] Display モード: `count` / `heatmap` / `role-aware`（`deriveCellRender.ts`）
  - ※ `count` は現状 `cellInfo.sources.size`（根拠の種類数、最大3）を返す簡易実装。正確な mention 回数は `mention_count` カラム追加後に切り替え
  - ※ `pov-color` はドロップダウンに列挙されるが `deriveCellDisplay()` に case が無く `dot` 表示にフォールスルー（**未実装**）
- [x] **Display モード `role-aware`**（actor `●` / target `◯` / mentioned `·` / POV `★`、`MatrixCell.tsx`）
- [x] `scene_codex_mentions` の `role` カラム（`source='beat'` 行）に actor/target/mentioned の最強値を書き込む実装（`upsertSceneBeatMentions`）
- [x] **`scene_beat_pov_cache` テーブルの新規追加**（Drizzle migration 済み、`beatPovCacheApi.ts`）
- [x] **POV モードに Beat レベル POV オーバーライドを反映**（保存時に `extractBeatPovOverrides` → `upsertSceneBeatPovOverrides`、Matrix 側は `Set<"sceneId::characterId">` として一括読み込み）
- [x] フィルタ・絞り込み（空セル非表示、未編集のみ）— Phase A から `hideEmptyRows` / `onlyUneditedRows` として実装済み
- [x] Codex 列の折りたたみ・ピン留め・非表示（`pinnedColumnIds` / `hiddenColumnIds` / `collapsedTypeSections`、`ColumnHeaderMenu.tsx`）
  - ※ 列の D&D 並べ替え・列幅ドラッグ変更は**未実装**（列幅は `COL_WIDTH=80` 固定）
- [x] CSV エクスポート（`buildCsvString` / `exportCsv.ts`、現行フォーマットは `source` をコード文字列で集約）
- [x] Custom モードのプリセット切替時のスクロール位置リセット（`MatrixTable.tsx` で `activeCustomSetId` 変更時に `containerRef.scrollTo(0, 0)`）
  - ※ 設計時に挙げた「列幅は保持」は対象外（列幅変更 D&D 自体が未実装のため）
- [x] Sort: Word count / Last edited

### Phase C: 整合性チェック（v2+）

- [ ] Matrix のステータスバーに警告表示
- [ ] Phase mismatch 検出（Codex フェーズ vs シーン）
- [ ] Location mismatch 検出
- [ ] Subplot orphan 検出
- [ ] POV mismatch 検出
- [ ] Codex unused 検出
- [ ] 警告クリックで該当セル/シーンへスクロール

### Phase D: 連携機能（v2+）

- [ ] Matrix → Map のクロスナビゲーション（「Show in Map」）
- [ ] Map との同期フィルタトグル
- [ ] 連続 Beat 追加モード
- [ ] PNG エクスポート

---

## Phase 着手前にユーザー確認が必要な決定事項

本設計書の本文では各事項について暫定方針を採用しているが、UX に直結するため Phase 着手前にユーザー判断を得る。本セクションはサインオフ用のチェックリストとして機能する。

### Map と Matrix のフィルタ共有

- **暫定方針（MVP）**: 完全独立（各パネル独自のフィルタ）
- **v2 で検討**: 「同期」トグル（Map で適用したフィルタを Matrix にも適用）

### Custom tags モードの UI

ユーザー定義タグ集合をどう指定するか：

- 案A: パネル内のドロップダウンで複数タグを選択
- 案B: Settings に「Matrix の Custom tags 設定」を追加して保存

**暫定方針**: 案B（Settings に永続化、複数プリセット保存可）。Phase B で確定。

### セル ● の根拠の優先順位

セルが「言及あり + リレーションあり + Beat メンションあり」の場合、どの色で表示するか。

- **暫定方針**: 本文言及 > Beat メンション > リレーション の優先順位で最も濃い色を採用。`Show source` メニューで全根拠を確認できる。

### subplot タグ名のカスタマイズ範囲

- **暫定方針**: Settings の `matrix.subplotTagName` で1つのタグ名のみ指定可。複数タグ集合の OR 検索は Custom tags モードで代替。

### 大規模プロジェクトでのパフォーマンス

500シーン × 100Codex = 50,000 セルの仮想スクロール（react-window 等）が必要。

- **暫定方針**: Phase A で react-window を導入。行・列両方の仮想スクロールを実装。1000シーン × 200Codex でもスクロールが滑らかに動くことを目標。

---

## 既存設計書への影響

本設計書の確定に伴い、以下の既存設計書への追記が必要（別タスク）：

| 設計書 | 追記内容 |
|--------|----------|
| `Grimodex_レイアウトシステム設計書.md` | パネル一覧に Matrix を追加、デフォルト位置 Bottom Dock |
| `Grimodex_Codexパネル設計書.md` | Codex Quick の言及スキャン結果を Matrix と共有する記述、`#subplot` タグ運用 |
| `Grimodex_Mapパネル設計書.md` | Matrix との関係（言及スキャン結果の共有、クロスナビゲーション） |
| `Grimodex_Timelineパネル設計書.md` | Matrix の Sort で story-time order を共有する記述 |
| `Grimodex_Settingsパネル設計書.md` | `matrix.*` 設定項目の追加、Data カテゴリに "Rebuild Codex mention cache" ボタン追加 |
| `Grimodex_統合DBスキーマ.md` | `scene_codex_mentions` キャッシュテーブルを新規追加（既存スキーマには存在しないことを確認済み） |

---

## 参考資料

- Novelcrafter Plan Matrix: https://www.novelcrafter.com/help/docs/plan/planning-with-the-matrix
- Beat システム設計書: `Grimodex_Beatシステム設計書.md`
