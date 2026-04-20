# Grimodex Timelineパネル設計書

## 概要

Timelineパネルはプロジェクトのシーン群を**時間軸上に配置して可視化・編集**するパネル。Scenesパネルがツリー構造（読者順）でシーンを管理するのに対し、Timelineは**story-time（作中時間）/ reading-order（読者順）/ write-order（執筆順）**の3つの時間軸を切り替えて俯瞰する。

Codexのフェーズ（経時的変化）はTimeline上にピンとして表示され、物語の進行と状態変化が一覧で把握できる。story-time軸ではシーンのドラッグで作中時間を調整でき、回想・並行ストーリー・非線形構造を扱う作品で威力を発揮する。

デフォルト位置: Bottom Dock（非表示）。オプトイン機能であり、線形物語では必須ではない。

設計思想: **Timelineはビュー兼story-timeの唯一の編集点。Scenesパネルが reading-order の編集、Timelineが story-time の編集、という責務分離。**

---

## パネル構造

```
┌────────────────────────────────────────────────────────────────┐
│ A. ヘッダー                                                     │
│ Timeline          [Story-time ▼] [📍12/48] [🔍] [⋮]            │
├────────────────────────────────────────────────────────────────┤
│ B. モードバー                                                    │
│ Axis: (●)Story ( )Reading ( )Write    Spacing:[Proportional▼]  │
│ Filter: [All POV ▼] [All locations ▼] [☐ Has phases only]      │
├────────────────────────────────────────────────────────────────┤
│ C. タイムラインビューポート                                       │
│                                                                │
│  T1       T50      T100          T200     T500   T800          │
│  ●────●────●────────◉──●──●─────────●──────●─────●             │
│  │    │    │        │  │  │         │      │     │              │
│  Ch1  Ch2  Ch3     Ch8 Ch9 Ch10   Ch15   Ch20   Ep             │
│  廃社 封じ 幕間    追放 夜  ...    反乱   覚醒   結             │
│                    ⏱        ⏱             ⏱                  │
│                   Elara:    Elara:       Elara:                │
│                   追放      反乱参加      覚醒                  │
│                                                                │
│  ─── Unscheduled ─────────────────────────────────────         │
│  ◌ メモ1   ◌ メモ2   (story_time未設定のシーン群)               │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ D. インスペクター（optional、右端）                              │
│ 選択中ノードの詳細・リンク                                       │
└────────────────────────────────────────────────────────────────┘
```

パネルの高さが十分ある場合は、将来的にマルチレーン表示（POVキャラクターごとのレーン）に拡張可能。MVPは単一レーンの水平軸。

---

## A. ヘッダー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Timeline」。左寄せ |
| 軸モードドロップダウン | 現在の時間軸を表示・切替。「Story-time」「Reading-order」「Write-order」 |
| カバレッジインジケーター | `📍 {story_time設定済み}/{総シーン数}`。軸モード=story時のみ表示 |
| [🔍] 検索ボタン | 展開するとノード名インクリメンタル検索バーが表示される |
| [⋮] パネルメニュー | View / Display / Export / Help |

### パネルメニュー

```
Display
  ☑ シーンタイトル
  ☑ 章番号
  ☐ Phaseピン
  ☐ 感情曲線（実験的）
  ☐ グリッドライン

View
  ● 単一レーン
  ○ POVレーン（将来拡張）

Export
  タイムライン画像として保存（SVG / PNG）
```

---

## B. モードバー

### 軸モード選択

セグメント選択で時間軸を切り替える。選択状態によってビューポートのレイアウトが変わる。

| モード | ノード位置の決定元 | 編集可否 |
|--------|------------------|---------|
| **Story-time** | `tree_nodes.story_time_order`。未設定シーンはフォールバック（後述） | ドラッグで編集可 |
| **Reading-order** | ツリーのDFS順序（Scenesパネルと同じグローバル順序） | 編集不可（Scenesパネルで編集） |
| **Write-order** | `tree_nodes.created_at` 昇順 | 編集不可（創造時刻） |

### スペーシングモード

| モード | 動作 |
|--------|------|
| **Proportional** | ノード間の距離が時間差に比例（story-time/write-orderで有用） |
| **Uniform** | ノードが等間隔に配置される（reading-orderのデフォルト） |

- Reading-orderでは常にUniform（意味がないため）
- Story-time/Write-orderではProportionalがデフォルト、手動でUniform切替可能

### フィルタ

| フィルタ | データソース | 動作 |
|---------|------------|------|
| **POV** | `tree_nodes.pov_character_id`（将来追加） | 選択したキャラクターが視点のシーンのみ表示 |
| **Location** | `tree_nodes.location_id`（将来追加） | 選択した場所のシーンのみ表示 |
| **Has phases only** | `codex_entry_phases.anchor_node_id` | Phaseがアンカーされているシーンのみ表示 |
| **Status** | `tree_nodes.status` | 指定ステータスのシーンのみ表示 |

フィルタ適用中は非マッチシーンを薄いスタイル（opacity 0.25）で表示。完全に隠すのではなく「そこにシーンがある」という構造感を維持する。

> MVP では POV / Location フィルタは無効化（該当カラムが未実装のため）。Has phases / Status のみ実装。

---

## C. タイムラインビューポート

### 座標系

水平軸が時間、垂直位置はシーンの**タイプ**や**ステータス**で微調整される。

```
縦方向レイアウト（上から）:
  ┌ 時間軸ラベル行（T1, T50, T100... / Ch.1, Ch.2... / 2026/3/1, 2026/3/5...）
  ├ 章ヘッダ行（折りたたみトリガー、reading-orderモードのみ）
  ├ メイン軸（水平線、シーンノードがここに乗る）
  ├ Phaseピン行（メイン軸の直下）
  └ Unscheduledレーン（story-timeモードで未設定シーンがある場合のみ）
```

### シーンノード

```
     ●
     │
   Ch.1
   廃社
  (1,120)
```

| 要素 | 詳細 |
|------|------|
| ドット | ステータスに応じた色（Outline=グレー、Draft=アンバー、Complete=グリーン、Revision=パープル、Final=チェック）。Scenesパネルと同一配色 |
| 章番号 | Reading-order上の階層から自動算出（「Ch.1 Sc.2」形式） |
| タイトル | シーンタイトル（Noteノードは含まない、Sceneのみ） |
| 文字数 | 設定でON/OFF可 |

**Noteノード**: Sceneと区別するため小さな◆マーカーで表示。Timelineの主役はSceneだが、Noteも参考情報として描画する（フィルタで非表示化可能）。

**Folderノード**: 描画しない（Timelineは葉ノードのみ扱う）。

### Unscheduledレーン

story-timeモードで `story_time_order = NULL` のシーンが存在する場合、ビューポート下部に区切り線付きで「Unscheduled」レーンが表示される。

- 未設定シーンは reading-order に従って左から並ぶ
- ドラッグでメイン軸上に持っていくと、ドロップ位置の story_time_order が自動割り当てされ、Unscheduledから抜ける
- 件数が多い場合はレーンが横スクロール可能

### Phaseピン

Codex Phaseのアンカーシーンに対して、シーンノードの直下に表示されるバッジ。

```
     ◉       ← 現在のアクティブシーン（ハイライト）
     │
   Ch.8
   追放
    ⏱      ← Phaseピン（小さなバッジ）
```

| ピンの状態 | 表示 |
|----------|------|
| 通常 | `⏱` アイコン + Codexエントリ名 + フェーズラベル |
| 複数Phase同一シーン | `⏱×N` まとめ表示。ホバーで全件ポップオーバー |
| シーン削除済み（anchor_node_id=NULL） | 軸外の「Orphaned phases」セクションに集約表示 |

- ホバー: `{エントリ名}: {フェーズラベル}` ツールチップ
- クリック: Codexパネルを開き、該当エントリのTimelineタブに遷移
- 1つのシーンに大量のPhaseがアンカーされる場合はピンを積み重ねず、まとめ表示（`⏱×12`）に

### 時間軸ラベル

軸モードに応じて表示が変わる。

| モード | ラベル内容 |
|--------|----------|
| Story-time | `story_time_label`（設定されていれば）or `T{story_time_order}`（数値） |
| Reading-order | `Ch.{番号}` または章フォルダー名 |
| Write-order | 作成日（相対「2週間前」または絶対「2026/3/15」） |

ラベル間引き: ノード密度が高い場合は5〜10ノードおきに表示。ズームで増減。

### 感情曲線（実験的）

ビューポートの背景に薄いSVGパスとして、各シーンの `emotion_score` を補間した曲線を描画する（設定でOFF可）。

- `emotion_score` は 0〜1 の値、未計算シーンは線を途切れさせる
- 算出はAI（Settings指定の軽量モデル）。シーン本文の感情強度を推定
- 明示的に「Generate emotion scores」ボタンを押した時に一括計算（自動計算しない）
- 未計算が多いプロジェクトでは曲線は表示しない

> MVPでは実装しない（v2以降の検討事項）。

---

## D. インスペクター（optional）

ビューポート右側にスプリット可能な詳細ペイン。ノード選択時に詳細を表示する。

```
┌─────────────────────┐
│ ● Ch.8 Sc.3         │
│ 追放される日         │
├─────────────────────┤
│ Status    [draft ▾] │
│ Characters          │
│   ● Elara (POV)     │
│   ● Marcus          │
│ Location            │
│   ◻ 塔 大広間        │
│                     │
│ Story-time          │
│  label: [T101     ] │
│  order: 101         │
│                     │
│ Created  2026/3/15  │
│                     │
│ Phases anchored (2) │
│   ⏱ Elara: 追放     │
│   ⏱ Marcus: 離反    │
│                     │
│ Synopsis            │
│ エララが塔を追われ… │
│                     │
│ [Open in Editor ↗]  │
└─────────────────────┘
```

- story-time ラベル・order をインライン編集可能（label変更は即保存、order変更はタイムライン再描画トリガー）
- Anchored phases リストからCodex/Phase編集ダイアログへ遷移
- パネル幅が狭い場合（Bottom Dockの高さ制約下）、インスペクターは畳まれてノード選択時にポップオーバーで表示

---

## インタラクション

### ノードのクリック / ダブルクリック

Scenesパネルと同じプレビュー/固定モデルに従う:

| 操作 | 動作 |
|------|------|
| シングルクリック | 選択 + Editorにプレビュータブで開く |
| ダブルクリック | 固定タブに昇格 |
| `Ctrl+Enter` / 右クリック「サイドで開く」 | 新しいEditor Groupにスプリットして開く |

Editorがすでに該当シーンを固定タブで開いている場合は、そのタブをアクティブ化する。

### ノードのドラッグ（story-timeモードのみ）

水平方向にドラッグすると `story_time_order` が更新される。

| 動作 | 結果 |
|------|------|
| ノードを右にドラッグ | story_time_order が増加（後の時間へ） |
| ノードを左にドラッグ | story_time_order が減少（前の時間へ） |
| Unscheduledレーンからメイン軸にドラッグ | ドロップ位置に応じた order を自動割り当て |
| メイン軸からUnscheduledレーンにドラッグ | order を NULL にクリア（ラベルは保持、後述） |

#### order の自動算出ルール

ドロップ位置で前後のノードを検出し、その中央値を割り当てる:

```
前ノード order = 100, 後ノード order = 200
→ 新 order = 150
```

- 先頭にドロップ: 先頭ノードの order - 10
- 末尾にドロップ: 末尾ノードの order + 10
- 前後が同じ order: 前 + 1
- 隣接差が小さくなりすぎた場合（差 < 2）、全ノードの order を 10刻みに再整列（トースト通知）

> 内部的には Fractional Indexing ではなく整数を使用。Phase resolution が整数比較で動くため、精度トラブルを避けて整数で管理。

### 範囲選択

| 操作 | 動作 |
|------|------|
| `Shift+クリック` | 前回選択ノードから今回ノードまでの範囲選択（表示順） |
| `Ctrl+クリック` | 個別トグル選択 |
| ビューポート空白をドラッグ | ラバーバンド選択（範囲内の全ノード選択） |

複数選択中の操作:
- 一括ステータス変更（右クリック → Set status）
- 一括削除（確認ダイアログ）
- 一括 story_time_order 再割り当て（選択内の相対順序を保持したまま、指定範囲に均等配分）

### ホバー

| 対象 | 動作 |
|------|------|
| シーンノード | ツールチップ: タイトル + Synopsis + status + story-timeラベル |
| Phaseピン | ツールチップ: `{エントリ名}: {フェーズラベル}` |
| 軸ラベル | なし |

### コンテキストメニュー

シーンノード右クリック:

| メニュー項目 | 動作 |
|-------------|------|
| Editorで開く | 固定タブで開く |
| サイドで開く | 新しいEditor Groupで開く |
| --- | |
| Set status | サブメニュー |
| Set story-time label... | インライン編集 |
| Clear story-time | order と label を NULL に |
| --- | |
| Add phase here... | このシーンをアンカーとしてPhase作成ダイアログを開く |
| --- | |
| Show in Scenes | Scenesパネルで該当ノードを展開・選択 |
| --- | |
| 削除 | Scenesパネルと同じ削除フロー |

### ズーム・スクロール

| 操作 | 動作 |
|------|------|
| 水平スクロール | タイムライン上の移動 |
| `Ctrl+スクロール` | ズームイン/アウト（軸のpx/unit比が変わる） |
| `Ctrl+0` | Fit to viewport（全シーンが見える倍率に） |
| `Ctrl++` / `Ctrl+-` | 段階的ズーム |

ズームレベルは Timeline パネルごとに独立して永続化（`global-settings.json`）。

---

## Phase との連携

### Phase resolution mode とTimeline modeの関係

**重要**: TimelineパネルのAxisモード（表示）と、Phase resolution（状態解決）は**独立**している。

- Axis = Story-time: ノードの**描画位置**が story-time 順
- Axis = Reading-order: ノードの**描画位置**が reading-order 順
- Axis = Write-order: ノードの**描画位置**が write-order 順

一方 Phase resolution は `projects.phase_resolution_mode` に従う:

- `reading`: 常にreading-orderでPhase適用（既存挙動）
- `story`: story-time で適用（未設定シーンはreading-order フォールバック）
- `auto`: シーンに story_time_order があれば story、なければ reading

Timelineでstory-timeを編集すると、Phase resolution（特に `auto` モード時）の結果が変わる可能性があるため、**`story_time_order` 変更時は全Codex状態の再解決がトリガーされる**。Chat/Codex/Editorの表示に即時反映。

### Phaseピンの位置

Phaseは `anchor_node_id` でシーンに紐づく。Timelineパネル上では:

- Axisがどのモードでも、Phaseピンは**アンカーシーンに貼り付く**
- シーンがTimeline上で移動すれば、Phaseピンも一緒に移動
- 「Phaseの位置」ではなく「Phaseを持つシーンの位置」として振る舞う

これにより、Axis切替時の挙動が直感的になる（シーンとPhaseが乖離しない）。

### Phase作成/編集のショートカット動線

- シーンノード右クリック → `Add phase here...` で Codex Phase 作成ダイアログを開く
- ダイアログの `Anchor scene` は当該シーンでプリフィル
- `Codex entry` は別途選択（エントリ一覧から）
- 保存後、Timelineにピンが即時追加される

---

## 他パネルとの連携

### → Editor

- シーンノードクリック → Editorで該当シーンを開く（プレビュー/固定はScenesパネル設計書の動線と同一）
- ドラッグで story_time_order を更新 → Editorのシーンヘッダーに story-time ラベルが即時反映
- Phase resolution mode = `auto` or `story` で story_time_order が変わる → Editor上のCodexハイライトのホバーカードで表示される状態が更新される

### → Scenes

- Timelineで選択中のシーンは、Scenesパネルのツリーでも選択状態で連動する（既存の `activeSceneSync` と同じ仕組み）
- コンテキストメニュー「Show in Scenes」で明示的にジャンプ（折りたたまれたツリーを展開して可視化）

### → Codex

- Phaseピンクリック → Codexパネルを開き、該当エントリのTimelineタブを表示
- コンテキストメニュー「Add phase here...」→ Codex Phase作成ダイアログを開く
- Codex側でPhaseが追加/削除/再アンカー → Timelineのピンがリアクティブに更新

### ← Codex

- CodexパネルのTimelineタブのミニタイムラインは、このフルTimelineパネルの**圧縮版**として振る舞う
- 「Open in Timeline panel ↗」ボタンでCodex Timelineタブから本パネルへ遷移（該当エントリをハイライト状態でフィルタ適用）

### ← Attribution

- AttributionパネルでAI帰属率の高いシーンをクリック → Timelineで該当シーンを強調表示
- Timelineパネル側にAI帰属率ヒートマップオーバーレイ（将来拡張、Display設定でON/OFF）

### ← Chat

- ChatのAI応答で「Jump to scene Ch.8」のようなリンクが生成された場合、Timelineで該当シーン位置にスクロール + 強調表示

---

## キーボードショートカット

### アプリレベル

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+L` | Timelineパネルのフォーカス/トグル |

### Timelineパネルフォーカス時

| ショートカット | 動作 |
|-------------|------|
| `←` / `→` | 前/次のシーンノードに選択移動（表示順） |
| `Shift+←` / `Shift+→` | 選択範囲を拡張 |
| `Enter` | 選択ノードをEditorで固定タブとして開く |
| `Space` | 選択ノードをEditorでプレビュータブとして開く |
| `Ctrl+Enter` | 選択ノードを新しいEditor Groupで開く |
| `1` / `2` / `3` | Axisモード切替（Story / Reading / Write） |
| `Ctrl+F` | 検索バーにフォーカス |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | ズームイン / アウト / Fit |
| `F2` | 選択ノードの story_time_label をインライン編集（story-timeモード時） |
| `Del` | 選択ノードを削除（確認ダイアログ） |
| `Escape` | 選択解除 / 検索クリア |

---

## 状態管理

### Zustand ストア: `timelineStore`

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `axisMode` | `'story' \| 'reading' \| 'write'` | 現在の軸モード |
| `spacingMode` | `'proportional' \| 'uniform'` | スペーシング |
| `zoom` | `number` | ズーム倍率（1.0 が Fit） |
| `scrollOffset` | `number` | 水平スクロール位置（px） |
| `selectedNodeIds` | `Set<string>` | 選択中のノードID |
| `filter` | `{ povId?: string, locationId?: string, hasPhases: boolean, status?: SceneStatus[] }` | フィルタ状態 |
| `inspectorOpen` | `boolean` | インスペクター開閉 |
| `display` | `{ titles: boolean, chapterNumbers: boolean, phasePins: boolean, emotion: boolean, grid: boolean }` | 表示設定 |

永続化: `axisMode` / `spacingMode` / `zoom` / `scrollOffset` / `display` は `global-settings.json` の `timeline` セクションに保存。`selectedNodeIds` / `filter` は永続化しない（セッション限定）。

### 派生データ

- `sceneOrderByAxis(axisMode)`: 軸モードに応じたシーン順序マップ（メモ化）
- `phasesByAnchor`: `anchor_node_id → Phase[]` のマップ（Codexストアから派生）
- `visibleNodes(filter, viewport)`: フィルタ適用後 + ビューポート範囲内のノードリスト

### リアクティブ更新

以下の変更時にTimelineを再描画:

| 変更元 | トリガー |
|--------|---------|
| `tree_nodes.story_time_order` 変更 | story軸の再レイアウト + Phase resolutionの再計算 |
| `tree_nodes` 追加/削除/移動 | 全軸の再レイアウト |
| `codex_entry_phases` 変更 | Phaseピンの再描画 |
| `projects.phase_resolution_mode` 変更 | Phase resolutionの再計算（表示自体は変わらないがCodex連動） |

---

## DBスキーマの追加・変更

DBスキーマの正規版は統合DBスキーマ設計書（`Grimodex_統合DBスキーマ.md`）を参照。本設計書で追加が必要なカラムを以下に記載。

### tree_nodes への追加カラム

```sql
ALTER TABLE tree_nodes ADD COLUMN story_time_order INTEGER;
ALTER TABLE tree_nodes ADD COLUMN story_time_label TEXT;

CREATE INDEX idx_tree_story_time ON tree_nodes(project_id, story_time_order)
  WHERE story_time_order IS NOT NULL;
```

| カラム | 型 | 説明 |
|--------|-----|------|
| `story_time_order` | INTEGER NULL | 作中時間の順序比較用整数。大小関係のみ意味を持つ。Sceneノードのみ意味を持つ（Folder/Noteでは未使用） |
| `story_time_label` | TEXT NULL | 表示用ラベル（例: `"帝国暦1024年3月"`, `"Day 3 morning"`）。order とは独立して編集可能 |

**設計判断**:

- 整数にしている理由: 架空世界の暦・相対時間・SFの年号など何でも入れられる柔軟性。比較が高速
- label と order を分離している理由: 同じ order でも表示は柔軟に変えたい。また label だけ設定して order は後で決める、というワークフローを許容
- Sceneでのみ有効だが、カラム自体は `tree_nodes` に追加（テーブル分離するほどでもない）

### projects への追加カラム

```sql
ALTER TABLE projects ADD COLUMN phase_resolution_mode TEXT NOT NULL DEFAULT 'reading'
  CHECK(phase_resolution_mode IN ('auto', 'reading', 'story'));
```

| カラム | 型 | 説明 |
|--------|-----|------|
| `phase_resolution_mode` | TEXT | Codex Phase の resolution で使う時間軸。新規プロジェクトは `auto` を推奨、既存プロジェクトは `reading` で後方互換 |

**モードの挙動**:

- `reading`: 常にreading-order（`tree_nodes` のDFS順序）で Phase を適用
- `story`: `story_time_order` 優先。設定されていないシーンは reading-order にフォールバック
- `auto`: シーンごとに「story_time_order があれば story、なければ reading」

Settings パネルの Project カテゴリに選択UIを追加:

```
Phase resolution
  ○ Reading-order only (simplest, default for linear stories)
  ● Auto (use story-time when set, fall back to reading-order)
  ○ Story-time only (explicit, requires manual story-time on all scenes)
```

### 将来拡張用（MVPでは不要）

```sql
-- POV/Location 連携（Constellationパネル / Timelineフィルタで使用予定）
ALTER TABLE tree_nodes ADD COLUMN pov_character_id TEXT
  REFERENCES codex_entries(id) ON DELETE SET NULL;
ALTER TABLE tree_nodes ADD COLUMN location_id TEXT
  REFERENCES codex_entries(id) ON DELETE SET NULL;

-- 感情曲線（v2以降）
ALTER TABLE tree_nodes ADD COLUMN emotion_score REAL;
```

これらは Timeline パネル単体では必須ではない。Constellationパネル等の後続機能で本格導入する。

---

## 実装ライブラリ候補

### タイムライン描画

- **自前SVG描画**: ノード数がせいぜい数百なので、D3やライブラリに頼らず直接SVGで描画。フルコントロールでき、ドラッグも React の onPointerDown で簡潔に実装できる
- 代替案: `vis-timeline` / `@nivo/line` — 機能は豊富だが過剰。小説ツール用途には不要

### ドラッグ

- 既存の `@dnd-kit/core` を流用（Scenesパネルで使用中）
- カスタム sensor で水平ドラッグのみ許可、ドロップ判定は自前

### ズーム・パン

- `react-zoom-pan-pinch` は過剰。スクロール + `Ctrl+wheel` のイベントハンドリングで十分

---

## レスポンシブ動作

### 高さ ≥ 300px（通常のBottom Dock高）

- 軸ラベル行 + メイン軸 + Phaseピン行 + Unscheduledレーン の全てを表示
- インスペクターは別パネルとして表示可能

### 高さ 150〜299px（狭いBottom Dock）

- メイン軸 + Phaseピンのみ。軸ラベルは間引き、Unscheduledレーンは下スクロールで
- インスペクターは閉じる or ポップオーバー化

### 高さ < 150px

- メイン軸1行のみ。ノードのタイトル省略、ドットのみ
- パネルメニューに「Timelineを拡大」ボタンを表示（Bottom Dockの高さを一時的に広げる）

### フローティングウィンドウ

- 大画面で運用すると最も活きる。マルチレーンや感情曲線も快適
- 縦方向の余白で「POVレーン」表示が意味を持つ（将来拡張）

---

## 既存設計書との整合

### レイアウト設計書

Timelineパネルのデフォルト位置はBottom Dock（非表示）。`Ctrl+Alt+L` でフォーカス/トグル。`TOGGLEABLE_PANELS` に `timeline` を追加。`PANEL_REGION_MAP` で `"center-bottom"` に配置。

### Scenesパネル設計書

- Reading-orderの編集責務は Scenesパネルに残る（ツリーのD&D）
- Timelineは story-time の編集責務を持つ（ドラッグで story_time_order 更新）
- アクティブシーン同期（`activeSceneSync`）は両パネル間で連動

### Codexパネル設計書

- CodexパネルのPhaseタブのミニタイムラインは、本パネルの圧縮版として振る舞う
- 「Open in Timeline panel ↗」ボタンで遷移
- Phase作成/編集/削除がTimelineに即時反映

### Editorパネル設計書

- Editorのシーンヘッダーに story_time_label を表示する欄を追加（折りたたみ可能、既存のSynopsis表示エリアに並べる）
- Editor内での story-time 編集は不可（Timelineまたはインスペクターが唯一の編集点）

### 統合DBスキーマ

上記「DBスキーマの追加・変更」セクションを統合DBスキーマ設計書の `tree_nodes` / `projects` 定義に反映する必要がある。

---

## 実装フェーズ

### Phase A: 最小動作

- `tree_nodes.story_time_order` / `story_time_label` カラム追加
- `projects.phase_resolution_mode` カラム追加（デフォルト `reading` で既存挙動維持）
- Timelineパネル基本レイアウト（ヘッダー・モードバー・ビューポート）
- Reading-orderモードのみ実装（story / write は将来）
- シーンノードの表示・クリック・ホバー
- Phaseピン表示（非インタラクティブ）

### Phase B: 時間軸の編集

- Story-timeモード実装、story_time_order のドラッグ編集
- Write-orderモード実装
- Unscheduledレーン
- `phase_resolution_mode = 'auto'` / `'story'` でのPhase resolution 拡張
- Settingsパネルに resolution mode 選択UI追加

### Phase C: 高度な操作

- インスペクターパネル
- 範囲選択・ラバーバンド
- 一括操作（ステータス変更、story-time再割り当て）
- コンテキストメニュー全項目
- キーボードショートカット全対応

### Phase D: 拡張（v2以降）

- POV/Locationフィルタ（`tree_nodes.pov_character_id` / `location_id` 追加）
- POVレーン（マルチレーン表示）
- 感情曲線（`emotion_score` 追加、AI計算）
- タイムライン画像エクスポート

---

## 未解決の検討事項

### story_time_order の入力UX

- 整数直接入力は著者にとって煩雑。「次のシーンは前の+10」のような相対入力は現実的か
- プロジェクトカレンダー機能（例: 帝国暦定義 → ラベルからorder自動生成）は v3 以降の検討

### 並行ストーリーの表現

- 同時刻に別視点のシーンが並ぶ場合、横に並べて配置（同じ order）するのが素直
- ただし読者は「どちらを先に読む」という情報を失う。Reading-order軸では自動的に reading 順に並ぶが、Story-timeだと重なって見にくい
- 解決案: 同 order のノードを微小にy方向オフセットして表示、または POV別レーン（v2）

### `phase_resolution_mode = 'auto'` の混在警告

- 一部シーンだけ story_time_order が設定されていて他が未設定だと、Phase resolutionの結果が直感に反する可能性
- Codex Phaseタブや Timeline ヘッダーで「story-time設定カバレッジ: {N}%」を表示して喚起
- Chat コンテキスト注入の挙動も影響を受けるため、ChatパネルのContext barにも警告ピルを出すか検討

### Phase の「逆行」対応

- 例: Ch.20 (reading-order) の回想シーンに story-time T5 を設定し、そこで「幼少期の出来事」Phaseをアンカー
- 結果: reading-order上はCh.20 で起きる変化が、story-time T5 以降の全シーン（Ch.1含む）に適用される
- これは意味論的には正しいが、著者が「回想で触れただけの設定」をPhase化すると想定外の変化が起きる
- Phase作成ダイアログで「このPhaseは story-time 上で N 個前のシーンから適用されます」のプレビューを出すと親切

### タイムラインのエクスポート

- SVG/PNG として画像エクスポート（プロット資料・打ち合わせ用）
- エクスポート時の情報密度（タイトルのみ / フルSynopsis / Phaseピン含む）を選択可能に
- v2以降の検討
