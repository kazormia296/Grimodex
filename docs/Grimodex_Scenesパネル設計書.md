# Grimodex Scenesパネル設計書

## 概要

Scenesパネルはプロジェクトの構造を管理するツリービューパネル。執筆本文（Scene）・メモ類（Note）・それらを束ねるコンテナ（Folder）の3種類のノードで構成される。階層制約なく自由に配置できる。

デフォルト位置: Left Dock（表示状態）

---

## ツリー階層モデル

### ノードタイプ一覧

| ノードタイプ | 種別 | TipTapドキュメント | 子ノードを持てるか | エクスポート対象 |
|-------------|------|-------------------|-------------------|----------------|
| Folder | コンテナ | なし | Yes（制限なし） | No |
| Scene | リーフ | **あり** | No | **Yes**（本文） |
| Note | リーフ | **あり** | No | No |

### 階層ルール

制約は**なし**。Folderはどこにでもネストでき、Scene/NoteはFolderの中でも外（ルート直下）でも置ける。

```
（例）
Folder: 第一部
  Folder: 第1章
    Scene: 塔の麓          [export]
    Scene: 最初の呪文       [export]
    Note: 執筆メモ          [no-export]
  Scene: 幕間              [export]   ← Folderを介さずに配置も可
Folder: 資料
  Note: 世界観メモ          [no-export]
  Folder: キャラクター設定
    Note: エララ設定        [no-export]
Scene: エピローグ           [export]   ← ルート直下も可
```

### エクスポート区別

Scene と Note はノード**作成時**に種別を選択する。作成後の変更は不可。

| ノード | エクスポート | ステータス管理 | Synopsis |
|--------|------------|--------------|---------|
| Scene  | あり | あり | あり |
| Note   | なし | なし | なし |

---

## ノードの表示情報

### Sceneノード

```
● Scene title                      [34%] 1,247
↑                                   ↑     ↑
ステータスドット                    AI%   文字数
```

| 要素 | 表示条件 | 詳細 |
|------|---------|------|
| ステータスドット | 常時 | 色でシーン状態を示す（後述） |
| タイトル | 常時 | インライン編集可能（F2 / ダブルクリック遅延） |
| AI帰属バッジ | Settings `display.showAiBadge` が ON の時のみ | AI生成テキストの割合（%）。ピル型バッジ |
| 文字数 | 常時（パネルメニューでOFF可） | 右寄せ。0の場合はグレーアウト |

アクティブシーン（Editorで開いているシーン）は左ボーダー + 背景ハイライトで強調。

#### AI 帰属バッジの取得

各 Scene ノードの AI 帰属比率は、ツリー描画時に `loadBatchAiRatio`（全シーン一括取得）で一度にロードし、`treeStore` にキャッシュする。シーンごとに Tauri コマンドを個別に呼び出さず、プロジェクト切替時と帰属情報の更新通知時にバッチで再計算する。`display.showAiBadge` が OFF のときはバッチ計算自体をスキップする。詳細は [`Grimodex_Attributionパネル設計書.md`](Grimodex_Attributionパネル設計書.md) を参照。

### Folderノード

```
[▼] 📁 Folder title                 12,340
```

| 要素 | 表示条件 | 詳細 |
|------|---------|------|
| 折りたたみシェブロン | 常時 | ▶（折りたたみ）/ ▼（展開） |
| アイコン | 常時 | 📁 teal系フォルダアイコン |
| タイトル | 常時 | インライン編集可能 |
| 合計文字数 | 常時 | 配下の全Scene + Noteの文字数合計。右寄せ |

### Noteノード

```
    📝 Note title                      832
```

| 要素 | 表示条件 | 詳細 |
|------|---------|------|
| アイコン | 常時 | 📝 teal系ノートアイコン |
| タイトル | 常時 | インライン編集可能 |
| 文字数 | 常時（パネルメニューでOFF可） | 右寄せ |

---

## Synopsis（シーン要約）

各Sceneノードは `synopsis` フィールドを持つ。「このシーンで何が起こるか」を1-3文で記述する要約文。Noteには不要のため持たない。

### 目的

- **プロッティング**: 執筆前にシーンの概要を計画する。Outlineビューモード（後述）で全シーンの流れを俯瞰
- **コンテキスト注入**: storySoFar（後述）として、現在位置より前の全シーンのSynopsisをAIのシステムプロンプトに注入し、物語の文脈を維持する
- **ナビゲーション**: ツリーのシーンホバー時にツールチップで表示。大量のシーンから目的のシーンを素早く見つけられる

### 編集方法

- Scenesパネルでシーンを選択 → Codex Quickセクションの上に表示されるSynopsisエリアで編集（プレーンテキスト、リッチテキスト不要）
- Editorパネルのシーンヘッダー部にもSynopsis表示・編集エリアを配置（折りたたみ可能）
- 空の場合はプレースホルダー「What happens in this scene?」を表示

### AI生成

Synopsis編集エリアの右上に「✦ Generate」ボタンを配置。シーン本文が存在する場合のみ有効化。

- クリック → 安価なモデル（Settings の AI設定で指定されたサマリー用モデル）でシーン本文から1-3文の要約を生成
- 既存のSynopsisがある場合は上書き確認ダイアログを表示（「Replace」/「Cancel」）
- 生成中はボタンがスピナーに変化、キャンセル可能
- 生成結果はSynopsisフィールドに直接書き込み（ユーザーが即座に編集可能）

### 自動生成の提案（オプトアウト方式）

シーンのステータスが **Complete / Revision / Final** に遷移した時点で、synopsisが未記入の場合にAI生成を自動提案する。

- ステータス遷移時にトースト通知: 「Synopsis is empty. Generate now?」 + [Generate] [Dismiss] ボタン
- トーストの状態は `synopsisSuggestion`（Zustand 上のトースト用スライス）で管理する。同時に表示されるのは 1 件まで（新しい提案は既存を置き換える）
- [Generate] → 上記のAI生成フローを実行（上書き確認なし、空のため）
- [Dismiss] → 何もしない。同じシーンで再度ステータスが変わった場合は再提案する
- Settingsの「Editor > Auto-suggest synopsis」トグル（デフォルト: ON）でオフにできる

### storySoFar のSynopsisカバレッジ警告

Chatパネルのコンテキストバーに、storySoFar（Layer 2）のSynopsisカバレッジ状態を表示する。

- 現在シーンより前のシーン群のうち、synopsisが記入済みの割合を計算
- カバレッジが50%未満の場合、コンテキストバーの「Project info」ピルの隣に警告ピルを表示:
  ```
  [⚠ storySoFar: 3/12 scenes]
  ```
- クリックでポップオーバー: 「12 scenes before current position, but only 3 have synopses. AI will have limited story context. Generate missing synopses?」 + [Generate all] ボタン
- [Generate all] → synopsis未記入かつシーン本文が存在する全シーンに対して順次AI生成を実行（プログレスバー表示）
- カバレッジが100%の場合は警告ピルを非表示

### 表示

| 場所 | 表示内容 |
|------|---------|
| ツリー（通常モード） | ホバー時にツールチップで先頭100文字 |
| ツリー（Outlineビュー） | タイトル直下にSynopsis全文をインライン表示 |
| Scenesパネル下部 | 選択中シーンのSynopsis編集エリア |
| Editorヘッダー | 折りたたみ可能な編集エリア |

---

## シーンのステータス

### ステータス定義

| ステータス | ドット色 | 意味 | 典型的な使い方 |
|----------|---------|------|--------------|
| Outline | グレー (#888780) | プロットメモのみ、本文未着手 | アウトライン作成フェーズ |
| Draft | アンバー (#EF9F27) | 執筆中、初稿未完 | 初稿執筆フェーズ |
| Complete | グリーン (#1D9E75) | 初稿完了 | 一通り書き終わった |
| Revision | パープル (#7F77DD) | 推敲・改稿中 | 赤入れ・リライト中 |
| Final | チェックマーク (✓) | 完成稿 | これ以上手を入れない |

### ステータスの変更方法

- ステータスドットをクリック → ポップオーバーで5つの選択肢を表示
- コンテキストメニュー →「Set status」サブメニュー
- コマンドパレット（`Ctrl+Shift+P`）→「Set scene status」

### ステータスの自動遷移

- **Outline → Draft**: ステータスが `outline` のシーンで本文の編集が開始された時点で自動的に `draft` に昇格する。判定ロジックは `shouldAutoDraftTransition`（本文が空→非空に変化した最初の編集イベントで true を返す）
  - 現仕様では**常時有効**（Settings トグルは未定義）。将来的に on/off 切替を追加する余地はあるが、現時点では明示的なユーザー操作のみを尊重するポリシーを `outline → draft` の1段階に限定して例外化している
- その他のステータス遷移（Draft → Complete 等）の自動化はなし。ユーザーの明示的な操作による

---

## パネルツールバー

```
┌──────────────────────────────────────────────┐
│ Scenes             [↩] [↪] [+] [⊞] [⋮] │
│ [🔍 Filter...                             ] │
└──────────────────────────────────────────────┘
```

### ボタン一覧

**[↩] Undoボタン**
直前のSceneパネル操作を元に戻す。操作履歴がない場合は非活性（透明度低下）。

**[↪] Redoボタン**
元に戻した操作をやり直す。Redo履歴がない場合は非活性。

**[+] 新規作成ボタン**
クリックでドロップダウンメニューを表示:
- New scene — 選択中のノードの親フォルダ内（または直下）に挿入
- New note — 同上
- ---（セパレーター）
- New folder — 選択中のフォルダ内（またはルート直下）に挿入

挿入位置のルール:
- ノード未選択時はツリー末尾に追加
- Scene/Note選択時 → その直下の兄弟として挿入
- Folder選択時 → そのFolderの末尾子要素として挿入（New scene/note/folder共通）

**[⊞] 展開/折りたたみトグル**
- 全展開 → 全折りたたみ → 全展開 のトグル

**[⋮] パネルメニュー**
- View: Tree (default) / Outline
- Sort by: Manual (default) / Title (A→Z) / Word count / Status
- Show: Word counts ✓ / AI attribution ✓ / Status dots ✓ / アクティブを自動表示 ✓
- Filter by status: All ✓ / Outline / Draft / Complete / Revision / Final
- ---
- Expand all
- Collapse all

### フィルター入力欄

- 入力開始でインクリメンタル検索（タイトルの部分一致）
- マッチしたノードと、ルートまでの祖先パスを表示（非マッチの兄弟は非表示）
- フィルタ中はノードの折りたたみ状態を無視して全マッチを展開表示
- `Esc` でフィルタクリア
- `Ctrl+F`（Scenesパネルにフォーカス時）でフィルタ入力欄にフォーカス

---

## ビューモード

パネルメニューの「View」で切り替え。

### Tree（デフォルト）

現行のツリー表示。Folder > Scene/Note の階層をインデント付きで表示する。SynopsisはSceneノードのホバー時にツールチップで先頭100文字を表示。

### Outline

プロッティング向けのシンプルな一覧表示。ツリー構造は維持しつつ、各SceneのSynopsis全文をタイトル直下にインライン表示する。

```
▼ 📁 第一部: 旅立ち
  ▼ 📁 第1章: 始まり
    ● Scene 1: 朝の市場
      エララが市場で謎の商人からアミュレットを受け取る。
      商人は「満月の夜に塔へ行け」と告げて姿を消す。
    ● Scene 2: 師匠の警告
      師匠ガレンがアミュレットの危険性を警告。エララは
      聞き入れず、塔への旅を決意する。
    📝 執筆メモ
  ▼ 📁 第2章: 黒曜石の塔
    ● Scene 3: 塔の入口
      ...
```

- Synopsisが空のSceneはタイトルのみ表示（プレースホルダーなし）
- ステータスドット・文字数は通常通り表示
- D&Dによる並べ替えも通常通り動作
- フィルター・ソートも通常通り適用
- **Synopsis のインライン編集**: Outline モードではタイトル直下の Synopsis 領域を直接クリックしてインライン編集できる（プレーンテキスト、複数行可）。Enter で確定、Shift+Enter で改行、Esc でキャンセル。編集結果は `tree_nodes.synopsis` に保存され、Tree モードのツールチップにも即座に反映される
- Tree モードではインライン編集 UI は出さず、Synopsis はホバー時のツールチップで先頭 100 文字プレビューに留める

---

## コンテキストメニュー

### Sceneノードの右クリック

| メニュー項目 | ショートカット | 動作 |
|-------------|-------------|------|
| Editorで開く | `Enter` | Editorに固定タブとして開く |
| サイドで開く | `Ctrl+Enter` | 新しいEditor Groupにスプリットして開く |
| --- | | |
| Set status | ▶ | サブメニュー: Outline / Draft / Complete / Revision / Final |
| --- | | |
| 名前を変更 | `F2` | タイトルをインライン編集モードにする |
| --- | | |
| 下にシーンを追加 | | 同じ親の直後に新規Scene |
| 下にノートを追加 | | 同じ親の直後に新規Note |
| 下にフォルダーを追加 | | 同じ親の直後に新規Folder |
| --- | | |
| 削除 | `Del` | 右クリックメニュー経由の Delete は**確認ダイアログを経由せず即削除**する（※キーボード `Del` / ツールバー経由の削除は `initiateDelete` を通り、本文または synopsis を持つノードが含まれる場合に確認ダイアログを出す。右クリックメニュー経由は明示的な操作として確認をスキップする） |

### Noteノードの右クリック

| メニュー項目 | ショートカット | 動作 |
|-------------|-------------|------|
| Editorで開く | `Enter` | Editorにタブとして開く |
| サイドで開く | `Ctrl+Enter` | 新しいEditor Groupにスプリットして開く |
| --- | | |
| 名前を変更 | `F2` | タイトルをインライン編集モードにする |
| --- | | |
| 下にシーンを追加 | | 同じ親の直後に新規Scene |
| 下にノートを追加 | | 同じ親の直後に新規Note |
| 下にフォルダーを追加 | | 同じ親の直後に新規Folder |
| --- | | |
| 削除 | `Del` | 右クリックメニュー経由の Delete は確認ダイアログを経由せず即削除する（キーボード `Del` / ツールバー経由は上記 Scene と同じく `initiateDelete` を通る） |

### Folderノードの右クリック

| メニュー項目 | ショートカット | 動作 |
|-------------|-------------|------|
| 名前を変更 | `F2` | タイトルをインライン編集モードにする |
| --- | | |
| シーンを追加 | | このFolderの末尾に新規Scene |
| ノートを追加 | | このFolderの末尾に新規Note |
| フォルダーを追加 | | このFolderの末尾に新規Folder |
| --- | | |
| 削除 | `Del` | 右クリックメニュー経由の Delete は確認ダイアログを経由せず即削除する（キーボード `Del` / ツールバー経由は `initiateDelete` を通り、配下に本文または synopsis を持つ Scene/Note が 1 件以上ある場合に確認ダイアログを表示） |

### マルチセレクト時のメニュー挙動と削除確認

右クリックされたノードが選択集合（`selectedIds`）に含まれる場合、メニュー項目（Set status、Delete 等）は選択全件に一括適用される。このときも右クリックメニュー経由の Delete は確認ダイアログを経由しない。

一方、キーボード `Del` / ツールバーの削除ボタン経由は `initiateDelete` を通り、**選択集合のいずれかに本文または synopsis を持つノード（または配下にそれを持つ Folder）が含まれる場合**に確認ダイアログを表示する。ダイアログには対象件数と「空でないノードが含まれる」旨のメッセージを出す。

---

## ドラッグ & ドロップ

### ライブラリ

`@dnd-kit/core` を使用。

### D&Dルール

- **どのノードでも**任意の位置に移動可能（ノードタイプによる制限なし）
- ただし **Folderにのみ「中に入れる」が可能**。Scene/Noteへのドロップは「前/後に並べ替え」のみ

| ドラッグ元 | Folderへのドロップ | Scene/NoteへのドロップドロップOn | 空エリア |
|----------|------------------|----------------------|--------|
| Folder | 中に入れる / 前後に並べ替え | 前後に並べ替えのみ | ルート末尾 |
| Scene | 中に入れる / 前後に並べ替え | 前後に並べ替えのみ | ルート末尾 |
| Note | 中に入れる / 前後に並べ替え | 前後に並べ替えのみ | ルート末尾 |

### ドロップインジケーター

- **ノード間の青い水平線** → 「この位置に挿入（前後）」
- **ノード上の背景ハイライト** → 「このFolderの中に入れる」（Folderにホバー中かつ中央25〜75%の位置）
- ドロップ先ノードの上端25%以内 → before、下端25%以内 → after、中央50% → inside（Folderのみ）

### BottomDropZone

ツリーの末尾には仮想的なドロップゾーン（`BottomDropZone`）を配置する。通常のノード間インジケーターだけでは「一番下の要素の直下（ルート末尾）」に正確にドロップしづらいため、ツリー全体の下部に不可視〜半透明のドロップターゲットを設ける。

- ツリー末尾にホバー時は薄いハイライトを表示
- ドロップすると、ドラッグ中ノードをルート末尾に移動（`parent_id = NULL`、`sort_order` は末尾キー）
- 単一ノードだけでなくマルチセレクションの一括移動にも対応

### マルチセレクション

ツリーは複数ノードの同時選択に対応する。

- **Shift + クリック**: アンカーノードとクリックしたノード間の**表示順での範囲選択**
- **Ctrl / Cmd + クリック**: クリックしたノードの選択状態をトグル（加算／減算）
- 単純クリック時は従来通り単一選択に戻る
- 選択中のノードは `treeStore` の `selectedIds`（`Set<string>`）に保持
- 操作の一括適用:
  - **D&D**: 選択ノードをまとめてドラッグし、同一ドロップ先にまとめて移動（元の相対順序を維持）
  - **Delete**: 選択ノード全てに対して削除フローを実行
  - **右クリックメニュー**: メニュー起動時、右クリックされたノードが選択集合に含まれていればメニュー項目（削除・ステータス変更等）は選択全件に適用。含まれていなければ選択を破棄してそのノードのみを対象にする

---

## ノードの自動命名ルール

新規ノード作成時のタイトルは、Settings > Project の「ネーミングルール」設定に基づいて自動生成される。

### シーン・ノートの採番

- **プレフィックス**: Settings で設定（デフォルト: `シーン` / `ノート`）
- **番号のギャップ補完**: 挿入位置の前後のノードを参照し、空き番号を補完する
  - 例: `シーン1`, `シーン3` の間に挿入 → `シーン2`（ギャップ補完）
  - 例: `シーン1`, `シーン3` の後に追加 → `シーン4`（末尾追加、ギャップ非補完）
- **採番スコープ**: `プロジェクト全体`（デフォルト）または `フォルダーごと`

### フォルダーの命名

`auto`モード（デフォルト）: 配置される**深さ**に応じてプレフィックスを変え、兄弟フォルダーとの整合を取る。

| 深さ | 生成タイトル例 |
|------|--------------|
| ルート直下（深さ0） | `Part.1`, `Part.2`, … |
| 1階層目の中（深さ1） | `Chapter 1`, `Chapter 2`, … |
| 2階層目以深 | `フォルダー`（番号なし） |

- **深さ別プレフィックス**: 同一深さの兄弟フォルダーを走査し、同じプレフィックス（Part / Chapter 等）で採番する。深さが変わると別プレフィックスに切り替わる
- **ギャップ優先補完**: 既存兄弟フォルダーの採番（例 `Part.1`, `Part.3`）に欠番があれば、末尾追加より先に**空き番号を優先して埋める**（→ `Part.2`）。空きが無い場合のみ末尾採番に回る
- シーン・ノートの採番（ギャップ補完）と同じ発想だが、フォルダーは深さごとにプレフィックスが切り替わる点が異なる

`none`モード: 常に `フォルダー` を使用。

### Folderホバー時のクイック追加

Folderノードにホバーすると、タイトル右側に2つのクイック追加ボタンが表示される:
- 📄 → そのFolder内末尾に新規Scene追加
- 📁 → そのFolder内末尾に新規Folder追加

---

## Editorとの連携

### シーンを開く操作

| 操作 | Editorでの振る舞い | タブの扱い |
|------|-------------------|----------|
| シングルクリック | プレビューモードで開く | タブタイトルが *斜体*。別ノードをクリックすると上書きされる |
| ダブルクリック | 固定タブとして開く | タブタイトルが通常表示。明示的に閉じるまで残る |
| Enter | 固定タブとして開く | ダブルクリックと同じ |
| Ctrl+Enter | 新しいEditor Groupに開く | 固定タブ。スプリット先にフォーカス移動 |

SceneとNoteの両方がEditorで開ける。

### プレビューモード

VS Codeの「Preview Editor」と同じ概念。

- ツリーを↑↓キーで素早くブラウズする際に、各シーンの内容をチラ見できる
- プレビュータブは1つのEditor Groupにつき最大1つ
- プレビュー中のタブをダブルクリック、または内容の編集を開始すると、固定タブに昇格する
- 別のシーンをシングルクリックまたは↑↓キーで移動すると、既存のプレビュータブが上書きされる
- 既存の固定タブをシングルクリックした場合はそのタブを活性化（固定のまま）し、他のプレビュータブは閉じる
- 新規作成したシーン・ノートは固定タブとして開く（即時編集できるよう）

### NoteをEditorで開く

NoteノードもSceneと同じくTipTapドキュメントを持つため、Editorタブで開ける。Attribution追跡・Codexハイライトも適用される。ただし以下の点が異なる:

- Editorのタブタイトルに「📝」アイコンを付けてSceneと区別
- エクスポート対象外であることを示す薄いバナーをエディタ上部に表示
- 文字数目標・シーンステータスは不可

### アクティブシーンの同期

Editorでアクティブなタブが変わると、Scenesパネルが連動する:

- アクティブシーンのノードが自動的にツリー内で選択状態になる
- 必要に応じて親ノードが自動展開され、アクティブシーンが見える位置にスクロール
- Codex Quickセクションが新しいシーンの関連エントリに更新される
- この自動追従はパネルメニューの「アクティブを自動表示」でon/off可能

---

## Codex Quickパネル

Codex QuickはScenesパネルとは独立した専用dockviewパネル。詳細仕様は [`Grimodex_CodexQuickパネル設計書.md`](Grimodex_CodexQuickパネル設計書.md) を参照。

---

## キーボードナビゲーション

Scenesパネルにフォーカスがある時のキーバインド:

| キー | 動作 |
|------|------|
| `↑` / `↓` | 前/次のノードに移動（折りたたまれた子はスキップ） |
| `←` | 展開されたFolder → 折りたたむ。リーフまたは折りたたみ済み → 親ノードに移動 |
| `→` | 折りたたまれたFolder → 展開する |
| `Enter` | Scene/Noteの場合: 固定タブとして開く。Folderの場合: 展開/折りたたみトグル |
| `Space` | Scene/Noteの場合: プレビューモードで開く |
| `F2` | 選択中のノードの名前をインライン編集 |
| `Del` / `Backspace` | 選択中のノードを削除。複数選択時は全件対象。本文またはsynopsisがある場合は確認ダイアログを表示。空のシーンは即削除 |
| `Ctrl+F` | フィルタ入力欄にフォーカス |
| `Escape` | フィルタ入力欄からフォーカスを外す / フィルタクリア |
| `Ctrl+Enter` | Scene/Noteの場合: 新しいEditor Groupに開く |
| `Ctrl+Z` | 直前のSceneパネル操作を元に戻す |
| `Ctrl+Shift+Z` | 元に戻した操作をやり直す |

---

## 操作履歴（Undo / Redo）

### 概要

Scenesパネルでの構造変更操作はすべて履歴スタックに積まれ、`Ctrl+Z` で元に戻し、`Ctrl+Shift+Z` でやり直しができる。最大50件を保持する。

### 対象操作

| 操作 | Undoの内容 |
|------|-----------|
| ノード作成（Scene / Note / Folder） | 作成したノードを削除 |
| ノード削除 | 削除前の状態を復元（Sceneの場合は本文ファイルも含む） |
| タイトル変更 | 変更前のタイトルに戻す |
| Synopsis変更 | 変更前の内容に戻す |
| ステータス変更 | 変更前のステータスに戻す |
| ドラッグ & ドロップによる移動 | 移動前の親・並び順に戻す |

### スコープ

キーボードショートカット（`Ctrl+Z` / `Ctrl+Shift+Z`）はSceneパネルのツリー部分にフォーカスがある時のみ動作する。テキスト入力中（タイトル編集・フィルター入力・Editorへの入力）はそれぞれのUndoが優先されSceneパネルの履歴には作用しない。

### 実装

- `treeHistoryStore`（Zustand）が `past` / `future` の2スタックを管理
- 各操作の実行後にコマンドオブジェクト `{ undo, redo }` をスタックに Push
- Undo/Redo実行中は `isReplaying` フラグを立て、再帰的なスタック蓄積を防ぐ
- ノード削除のUndoはDBへの再挿入 + Sceneの場合はmarkdownファイルの復元を行う

---

## DBスキーマ

### テーブル定義

```sql
CREATE TABLE tree_nodes (
  id                TEXT PRIMARY KEY,     -- UUID
  project_id        TEXT NOT NULL REFERENCES projects(id),
  parent_id         TEXT REFERENCES tree_nodes(id), -- NULL = ルート直下
  node_type         TEXT NOT NULL,        -- 'folder' | 'scene' | 'note'
  title             TEXT NOT NULL DEFAULT 'Untitled',
  synopsis          TEXT,                 -- Sceneのみ: シーン要約（プレーンテキスト）
  sort_order        TEXT NOT NULL,        -- 文字列 fractional indexing キー（辞書順比較）
  status            TEXT DEFAULT 'outline', -- Sceneのみ: 'outline'|'draft'|'complete'|'revision'|'final'
  content           TEXT NOT NULL DEFAULT '{}', -- Scene/Note本文（ProseMirror JSON）
  story_time_order  TEXT,                 -- 物語内時間の並び順（fractional index、Timeline パネル用）
  story_time_label  TEXT,                 -- 物語内時間ラベル（例 "三ヶ月前"、Timeline パネル用）
  pov_character_id  TEXT REFERENCES codex_entries(id), -- POV キャラ参照（Map / Timeline パネル用）
  location_id       TEXT REFERENCES codex_entries(id), -- 場所参照（Map / Timeline パネル用）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tree_parent ON tree_nodes(project_id, parent_id, sort_order);
CREATE INDEX idx_tree_story_time ON tree_nodes(project_id, story_time_order);
```

### Timeline / Map 連携カラム

`story_time_order` / `story_time_label` / `pov_character_id` / `location_id` は Scenes パネルの読み順（`sort_order`）とは独立した軸を提供する。

| カラム | 用途 | 主な編集箇所 |
|--------|------|------------|
| `story_time_order` | 物語内時間での並び順。`sort_order` と同じ文字列 fractional indexing で保持 | Timeline パネル（D&Dで並べ替え） |
| `story_time_label` | 物語内時間の表示ラベル（"三ヶ月前" など、自由入力） | Timeline パネル |
| `pov_character_id` | シーンの POV キャラ。`codex_entries.id` を参照 | Timeline / Map パネル |
| `location_id` | シーンの主な舞台。`codex_entries.id` を参照 | Map パネル |

**Scenes パネル UI からは直接編集しない**。Scenes パネルは読み順（`sort_order`）だけを管理する。Timeline パネル / Map パネルから編集し、DB 上は同じ `tree_nodes` 行を更新する。削除は Scenes パネル側の削除操作がマスターで、対応する Timeline / Map 上の項目も同じ行として消える。

### sort_order の戦略

**文字列 fractional indexing**（npm `fractional-indexing` 互換アルゴリズム）を採用。SQLite の `COLLATE BINARY`（デフォルト）で辞書順ソートが効く。

- キーは ASCII 文字列（base62）。例: `"a0"`, `"aV"`, `"a0V"`
- 初期ノード: `generateNKeysBetween(null, null, n)` で `["a0", "a1", "a2", ...]` を生成
- ノードAとBの間に挿入: `generateKeyBetween(A.sort_order, B.sort_order)`
- 先頭に挿入: `generateKeyBetween(null, firstKey)`
- 末尾に挿入: `generateKeyBetween(lastKey, null)`
- 中央キー生成は理論上**無限**に可能で、隣接差の精度劣化が原理的に発生しない

**再整列は原則不要**: 浮動小数点方式と異なり、精度劣化による全件リバランスは走らない。Drag & Drop 後は単一行 UPDATE で完結する。

> 旧仕様（REAL `(A+B)/2` 方式）は精度劣化のリスクを抱えていたため、文字列方式に変更した。Timeline パネルの `story_time_order` も同方式に揃える。

### 階層制約の検証

DB側ではなく、アプリケーション層（Zustandストアの操作関数）でバリデーションする。

```typescript
/** フォルダのみ子ノードを持てる */
function canHaveChildren(type: NodeType): boolean {
  return type === "folder";
}
```

D&Dドロップ時および `createNode` 時に検証する。

### codex_quick_pins テーブル

Codex Quick パネルに表示される Scene × Codex Entry のピン情報は `codex_quick_pins` テーブルに永続化される。

```sql
CREATE TABLE codex_quick_pins (
  scene_id    TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  sort_order  TEXT NOT NULL, -- 文字列 fractional indexing
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scene_id, entry_id)
);
```

- Scene の切替時に `scene_id = ?` で読み出し、Codex Quick パネルに反映する
- ピン追加・解除・並べ替えは Codex Quick パネル側の UI で行うが、**Scenes パネル（`treeStore`）も `syncCodexQuickPins` を介して再読み込みをトリガー**する（シーン名変更・シーン削除時等、Scene 側のイベントで Codex Quick の表示を更新する必要があるため）
- Scenes パネル自体には Codex ピン用の直接 UI はない

---

## Phase Store との連携

Scenes パネルのシーン順（`sort_order`）は Codex の **Phase**（「第X章以降に登場」等の条件）解決に利用される。Phase は「このシーンの位置でエントリが有効か」を判定するため、**読み順の絶対インデックス**を必要とする。

- Scenes パネルは `usePhaseStore.recomputeSceneOrder` を次のタイミングで呼び出す:
  - シーン新規作成
  - シーンのドラッグ & ドロップ（並べ替え・親変更）
  - BottomDropZone 経由の移動
  - マルチセレクト D&D による一括移動
  - シーン削除
  - ツリー初期ロード後
- `recomputeSceneOrder` はツリー全体を深さ優先で辿り、Scene ノードの絶対インデックスを算出して `phaseStore` にキャッシュする
- Note / Folder は Phase 解決の対象外（`node_type === 'scene'` のみカウント）
- シーン順が変わっても本文や Synopsis が変わらない場合は Phase 再計算のみで済み、エディタの再描画は発生しない

---

## storySoFar カバレッジ警告（データソース）

Chat パネルのコンテキストバーには「storySoFar カバレッジピル」が表示される（詳細は Chat パネル設計書）。Scenes パネルはこのピルの UI を持たないが、**算出のためのデータソース**として機能する。

- 読み順: `tree_nodes.sort_order` の深さ優先巡回（Scenes パネルのツリー表示順と一致）
- Codex Phase の解決結果: `usePhaseStore` 経由
- 現在シーンより前の Scene ノード群のうち、`synopsis` が空でないシーンの比率を Chat パネルが計算する
- Scenes パネル側で対応するのは、上記「Phase Store との連携」に記載のシーン順再計算のトリガーと、Synopsis 編集時の `tree_nodes.synopsis` の更新のみ

---

## 既存設計書との整合

Scenes パネルは Grimodex のデータ骨格（`tree_nodes`）を管理するため、周辺パネルと広く連携する。

| 連携先 | 関係 | 参照 |
|--------|------|------|
| **Timeline パネル** | `tree_nodes.story_time_order` / `story_time_label` を共有。並び順は独立するが、行自体は同一 | [`Grimodex_Timelineパネル設計書.md`] |
| **Map パネル** | `tree_nodes.pov_character_id` / `location_id` を共有。Map 上から編集する | [`Grimodex_Mapパネル設計書.md`] |
| **Codex Quick パネル** | `codex_quick_pins` テーブルを共有。Scenes パネルは `syncCodexQuickPins` で再読み込みをトリガー | [`Grimodex_CodexQuickパネル設計書.md`] |
| **Codex パネル（Phase）** | Scenes の読み順を `usePhaseStore.recomputeSceneOrder` 経由で供給 | [`Grimodex_Codexパネル設計書.md`] |
| **Attribution パネル** | Scene ノードに表示する AI 比率バッジは `loadBatchAiRatio` 経由で取得し、`display.showAiBadge` で切替 | [`Grimodex_Attributionパネル設計書.md`] |
| **Chat パネル** | storySoFar カバレッジピルのデータソース（読み順 + Synopsis 充填率）を提供。Synopsis 自動提案トーストもステータス遷移イベント経由で連携 | [`Grimodex_Chatパネル設計書.md`] |
| **Editor パネル** | アクティブシーン同期、プレビュー／固定タブ、`outline → draft` 自動遷移の起点 | [`Grimodex_Editorパネル設計書.md`] |
| **Grid パネル** | 同じ `tree_nodes` を共有。Scenes は**ツリー構造の管理**、Grid は**カード並べ作業**で役割分担 | [`Grimodex_Gridパネル設計書.md`] |
| **Matrix パネル** | 同じ `tree_nodes` を共有。Matrix の行は Scenes ツリーの階層を再描画したもの | [`Grimodex_Matrixパネル設計書.md`] |

---

## Beat / Matrix / Grid 連携で導入される変更

### scene_codex_pins テーブル

Phase A で **`scene_codex_pins` テーブル**（シーン × Codex の明示的リレーション）が新規追加される。Matrix の「Pin to scene」「Add scene to chapter (with this codex)」、Grid のカード Codex チップの保存先。詳細は [統合DBスキーマ](./Grimodex_統合DBスキーマ.md) と [Matrix パネル設計書](./Grimodex_Matrixパネル設計書.md)。

Scenes パネル側からの直接編集 UI はないが、Scene 削除時に `ON DELETE CASCADE` で自動的に紐付き行も削除される。

### tree_nodes の新規カラム

Phase A で同じ migration ファイルに以下の3カラムが追加される：

- **`tree_nodes.unplaced_beats_doc TEXT NOT NULL DEFAULT '[]'`**: Unplaced beat の保存先（ProseMirror JSON 配列、Beat 設計書参照）。本文 (`content` カラム) とは独立した別データ
- **`tree_nodes.unplaced_beat_preview TEXT`**: `unplaced_beats_doc` から抽出した先頭3件 × 40文字のプレビューキャッシュ。Grid パネルのカード描画で利用
- **`tree_nodes.char_count INTEGER NOT NULL DEFAULT 0`**: 本文文字数キャッシュ。Grid パネルのステータスバー集計で利用

シーン保存時、フロント側が `unplaced_beat_preview` と `char_count` の値を保存ペイロードに同梱する（バックエンドは保存するだけ、中身を解釈しない）。Scenes パネルではこれらのカラムを編集対象としない（読み取りもしない）。

### Outline モードの Synopsis インライン編集

既存の Outline モードの Synopsis インライン編集（Tree モードのツールチップ反映含む）は、Beat / Grid 設計書で導入される **`<InlineSynopsisEditor>` 共有コンポーネント**（`src/features/editor/InlineSynopsisEditor.tsx`）に置換する。Scenes / Editor / Grid の3パネルで挙動が統一される：

- `Enter` で確定、`Shift+Enter` で改行、`Esc` でキャンセル
- フォーカス喪失で確定保存
- IME 入力中の `Enter` は確定しない
- 保存失敗時はトースト通知し、編集状態を維持

既存実装の置換は Grid パネル Phase A で実施する（同等機能のため UX 後退なし）。
