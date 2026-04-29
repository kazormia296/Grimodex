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
| 🔍 検索 | シーン名・Codex 名で行/列を絞り込み |
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
| `POV` | character タイプの Codex エントリ | シーンの `povCharacterId`（1行につき1セルだけ ●、未設定なら空行）。**Phase A 時点ではシーン POV のみ。Phase B 以降は Beat の `pov` オーバーライドも反映**（シーン POV と異なる beat-pov があれば、そのキャラ列にも ★ を付与し、シーン POV キャラ列の ● は維持） |
| `Location` | location タイプの Codex エントリ | シーンの `locationId`（同上） |
| `Subplot` | `#subplot` タグ付きの `lore` エントリ | subplot の進行密度（言及スキャン結果ベース） |
| `Custom` | **ユーザーが手動で追加した任意 Codex エントリの集合**（タイプ・タグ問わず） | 言及/関連の有無 |

> **Custom モードの仕様**: 任意の Codex エントリを手動で集めて列にする「ピン留め型」モード。Tag フィルタを使わず、列ヘッダの `+` ボタンまたは Codex パネルからの「Add to Matrix Custom」操作で1エントリずつ追加・削除する。複数の Custom セット（保存済みプリセット）を `global-settings.json` に保持し、ドロップダウンで切り替え可能（例: 「主要登場人物セット」「subplot A 関連セット」）。Tag フィルタによる動的集合では拾いきれない、ad-hoc な「この章で追跡したい組み合わせ」を表現する用途。

> **Note**: シーンに対する多値ラベル（`labels`）の概念は現行スキーマに**存在しない**。`storyTimeLabel` は単一テキストで Timeline 用途のため Matrix の列軸には不向き。多値ラベルが必要になった場合は `tree_nodes` への新規カラム追加または `scene_labels` テーブル新規作成が必要となるが、本設計書では**範囲外**とする。

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
- 列ヘッダ右クリックで「列を非表示」「ピン留め（左端固定）」「タイプセクションごと折りたたむ」（Custom モードでは「セットから削除」も追加）
- 列幅はドラッグで変更可能
- 列の並び順は default で Codex の `sortOrder`、ユーザーが D&D で変更可

### セル

セルの挙動は行種別で分岐する。

#### Scene 行のセル

- **クリック**: 該当シーンの Editor を開き、該当 Codex の最初の言及位置にスクロール
- **右クリック**:
  - **Open scene**: Editor で開く
  - **Pin to scene**: Codex リレーションを明示的に作成
  - **Remove association**: Codex リレーションを削除（言及ベースの ● は残る）
  - **Add beat to this scene**: Unplaced beat を追加（列の Codex を `@mention` として自動挿入、後述「セルからの Beat 追加」）
  - **Show source**: ● の根拠を表示（言及／リレーション／Beat メンションのどれか）

#### Chapter 行のセル

Chapter 行のセル自体には ● は描画されない（folder ノードはドキュメントを持たないため言及スキャン対象外）。代わりに、空セル全面が `+ Add scene` のホットエリアになる：

- **クリック**: その Chapter folder 直下に新 Scene を作成。**列の Codex を `scene_codex_pins` に明示的に紐付ける**（リレーション ●、source = `relation`）
- **右クリック**:
  - **Add scene to this chapter (with @{Codex 名})**: 上記と同じ動作
  - **Add scene to this chapter (no codex)**: Codex 紐付けなしで新 Scene
  - **Open chapter folder in Scenes panel**: Scenes パネルで該当 folder を選択

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
| `count` | 言及回数の数値 | どこで濃く言及されているか | Phase B |
| `heatmap` | 言及回数を背景色の濃淡で | 集中・分散の俯瞰 | Phase B |
| `pov-color` | POV キャラの色で塗り分け | 視点配分の俯瞰 | Phase B |
| `role-aware` | actor / target / mentioned / POV を視覚分離 | 誰が能動側／受動側／視点かを区別する | Phase B |

`dot` モードでもセル背景のカラーで根拠を区別する：

- 濃色（実線 ●）: 本文言及あり
- 中間色: Beat メンションのみ
- 薄色（輪郭のみ ◯）: Codex リレーションのみ（本文未登場）

### Role-aware モードの仕様（Phase B）

Beat システム設計書の Phase B で導入される Codex メンション role 修飾子（`actor` / `target` / `mentioned`）と、`sceneBeat.attrs.pov` を利用して、セル内に役割記号を描画する。

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

Phase A では Beat に role 修飾子が無いため Role-aware モードは利用不可（UI 上で disabled 表示）。Phase B 完了後に有効化される。

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

追加された beat は該当シーンの TipTap ドキュメント内、`unplacedBeats` コンテナの末尾（`order` を最大値+1）に保存される。詳細は Beat システム設計書参照。

### 連続入力モード（v2）

「Add beat」ダイアログを開きっぱなしにして、次のセルクリックで対象シーンが切り替わる連続入力モード。Matrix を見ながら複数シーンに連続で Beat を追加するワークフロー向け。v2 で検討。

---

## C. ステータスバー

```
12 scenes × 16 codex entries  •  47 cells filled  •  Settings: Saved  •  ⚠ 2 warnings
```

| 要素 | 表示 |
|------|------|
| 表サイズ | `{シーン数} × {Codex数}` |
| 埋まっているセル数 | `{count} cells filled` |
| 設定保存状態 | `Settings: Saved` / `Settings: Saving...`（Matrix 自身のフィルタ・ソート設定の永続化状態。表データ自体は他パネルに依存し、ここでは保存状態を扱わない） |
| キャッシュ状態 | `Scanning... 12/500` キャッシュ再構築中のみ表示（後述「キャッシュ戦略」参照） |
| 整合性警告（v2） | `⚠ N warnings` クリックで詳細表示 |

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

```sql
CREATE TABLE scene_codex_pins (
  scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scene_id, codex_entry_id)
);
CREATE INDEX scene_codex_pins_by_scene ON scene_codex_pins(scene_id);
CREATE INDEX scene_codex_pins_by_codex ON scene_codex_pins(codex_entry_id);
```

このテーブルが下記キャッシュの `source = 'relation'` 行の一次ソースになる（同期更新）。Grid のカードで表示する Codex チップもこのテーブルを参照する。

#### 2. `scene_codex_mentions`（言及スキャンキャッシュ）

下記の永続化キャッシュテーブル：

```sql
CREATE TABLE scene_codex_mentions (
  scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  codex_entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  mention_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,                          -- 'body' | 'beat' | 'relation'
  role TEXT NOT NULL DEFAULT 'mentioned',        -- 'mentioned' | 'actor' | 'target' | 'pov'
  PRIMARY KEY (scene_id, codex_entry_id, source, role)
);
CREATE INDEX scene_codex_mentions_by_scene ON scene_codex_mentions(scene_id);
CREATE INDEX scene_codex_mentions_by_codex ON scene_codex_mentions(codex_entry_id);
```

`source` はセル背景色の根拠区別（本文言及 / Beat メンション / Codex リレーション）に使う。`role` は Phase B で導入する Codex メンション role 修飾子（Beat 設計書参照）と Beat POV オーバーライド (`pov`) を保持する。1シーン × 1 Codex でも、根拠 × 役割の組み合わせで複数行になる。

`role` カラムは **Phase A から DDL に含めて空（`mentioned`）のまま運用**する。Phase B で role 修飾子を導入するときに値を埋める実装を追加するだけで、追加マイグレーションは不要にする。

### 更新タイミング

- **シーン保存時**: 該当シーン行を全 Codex に対して再計算（既存の保存パイプラインに hook）
- **Codex エントリ追加**: 全シーンに対して該当列を非同期スキャン（バックグラウンドジョブ、キュー実装）
- **Codex エントリ削除**: キャッシュから該当列を `ON DELETE CASCADE` で自動削除
- **Codex 名/alias 変更**: 全シーンに対して再スキャン（バックグラウンドジョブ）
- **Codex リレーション変更**: 該当ペアの `source = 'relation'` 行を更新

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

- [ ] **`scene_codex_pins` テーブルの新規追加**（Drizzle migration）— 明示リレーションの一次ソース。Grid のカード Codex チップもこれを参照
- [ ] **`scene_codex_mentions` キャッシュテーブルの新規追加**（Drizzle migration）
- [ ] シーン保存時のキャッシュ更新フック（既存の保存パイプラインに統合）
- [ ] Codex 追加・削除・rename 時のキャッシュ再構築バックグラウンドジョブ
- [ ] 新規パネル `MatrixPanel` の実装（feature-based ディレクトリ `src/features/matrix/`）
- [ ] Codex モード（default）
- [ ] 行: シーン階層、列: Codex（タイプ別グループ）
- [ ] セル表示（`scene_codex_mentions` キャッシュを参照、根拠別に背景色を変える）
- [ ] **Tag フィルタ UI**（オートコンプリート、AND 条件、Show モードごとに別状態を保持）
- [ ] Sort: Reading order / Story-time order
- [ ] 🔍 検索（行/列の絞り込み）
- [ ] セルクリックで Editor を開く
- [ ] **Scene 行のセル右クリック → 「Add beat to this scene」**（列の Codex を `@mention` として自動挿入）
- [ ] **Scene 行ヘッダー右クリック → 「Add beat to this scene」**（Codex 自動挿入なし）
- [ ] **Chapter 行のセルクリック / 右クリック → 「Add scene to this chapter」**（列の Codex を `scene_codex_pins` に自動付与、folder 末尾に挿入、Scene 名は自動採番）
- [ ] **Chapter 行ヘッダー右クリック → 「Add scene to this chapter」**（Codex 紐付けなし）
- [ ] **新 Scene 作成直後のインライン入力ポップオーバー**（Synopsis 即入力、「Add another scene」で連続追加。Beat 追加ポップオーバーと同じパターン）
- [ ] レイアウト: Bottom Dock デフォルト非表示（レイアウトシステム設計書に追記）
- [ ] 設定の永続化（`global-settings.json`）
- [ ] react-window 等による行・列両方の仮想スクロール

### Phase B: Matrix 拡張

- [ ] Show モード切替（`POV` / `Location` / `Subplot` / `Custom`）
- [ ] Custom モード: 列ヘッダ `+` ボタン、Codex パネルからの「Add to Matrix Custom」
- [ ] Custom モード: 複数プリセットの保存・切替・rename・削除
- [ ] Display モード: `count` / `heatmap` / `pov-color`
- [ ] **Display モード `role-aware`**（Beat 設計書 Phase B の role 修飾子と連動、actor 太枠 / target 細枠 / mentioned 薄 ● / POV ★）
- [ ] **POV モードに Beat レベル POV オーバーライドを反映**（beat の `attrs.pov` がシーン POV と異なれば該当キャラ列に ★ を追加）
- [ ] `scene_codex_mentions` キャッシュへの role 情報の追加（Phase A スキーマに `role` カラムを最初から入れて空のまま運用、Phase B で値を埋める）
- [ ] Display モード（`dot` / `count` / `heatmap` / `pov-color`）
- [ ] フィルタ・絞り込み（空セル非表示、未編集のみ）
- [ ] Codex 列の折りたたみ・並べ替え・ピン留め
- [ ] CSV エクスポート
- [ ] Sort: Word count / Last edited

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
| `Grimodex_Settingsパネル設計書.md` | `matrix.*` 設定項目の追加 |
| `Grimodex_統合DBスキーマ.md` | `scene_codex_mentions` キャッシュテーブルを新規追加（既存スキーマには存在しないことを確認済み） |

---

## 参考資料

- Novelcrafter Plan Matrix: https://www.novelcrafter.com/help/docs/plan/planning-with-the-matrix
- Beat システム設計書: `Grimodex_Beatシステム設計書.md`
