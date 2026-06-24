# Grimodex Timelineパネル設計書

## 概要

Timelineパネルはプロジェクトのシーン群を**時間軸上に配置して可視化・編集**するパネル。Scenesパネルがツリー構造（読者順）でシーンを管理するのに対し、Timelineは**story-time（作中時間）/ reading-order（読者順）/ write-order（執筆順）**の3つの時間軸を切り替えて俯瞰する。

Codexのフェーズ（経時的変化）はTimeline上にピンとして表示され、物語の進行と状態変化が一覧で把握できる。story-time軸ではシーンのドラッグで作中時間を調整でき、回想・並行ストーリー・非線形構造を扱う作品で威力を発揮する。

デフォルト位置: Bottom Dock（非表示）。オプトイン機能であり、線形物語では必須ではない。

設計思想: **Timelineはビュー兼story-timeの唯一の編集点。Scenesパネルが reading-order の編集、Timelineが story-time の編集、という責務分離。**

**表示モード（viewMode）**: Timeline は 2 つの表示モードを持つ（2026-06-22 出荷, PR #168 / `d72468c9`）。`scenes`（シーン年表＝本文書 A〜D 章の主対象）と、`threads`（名前付きプロットスレッドのスイムレーン＝Plottr 型）。x 軸（シーンの並び）と軸モード・ズームは両モードで共通。`threads` モードの詳細は後述「プロットスレッド表示（threads ビューモード）」節を参照。

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

パネルの高さが十分ある場合のマルチレーン表示は、`threads` ビューモード（名前付きプロットスレッドのスイムレーン、2026-06-22 出荷。後述「プロットスレッド表示（threads ビューモード）」節）で部分的に実現済み。POV キャラクターごとのレーン分割は引き続き将来拡張。`scenes` モードのMVPは単一レーンの水平軸。

---

## A. ヘッダー

### 表示要素

| 要素 | 詳細 |
|------|------|
| パネルタイトル | 「Timeline」。左寄せ |
| viewMode トグル | `[シーン｜スレッド]` のセグメント。タイトル直後に常時表示。`scenes`（シーン年表）/ `threads`（プロットスレッド）を切替。永続化される（後述「プロットスレッド表示」節）。2026-06-22 追加 |
| 「+ スレッドを追加」ボタン | **`threads` モードのときのみ** ヘッダー右側に表示。クリックで「新しいスレッド」を末尾レーンとして追加。2026-06-22 追加 |
| 軸モードドロップダウン | 現在の時間軸を表示・切替。「Story-time」「Reading-order」「Write-order」 |
| カバレッジインジケーター | `📍 {story_time設定済み}/{総シーン数}`。軸モード=story時のみ表示。他軸モードでは `{N} scenes`（シーン総数）を表示 |
| [🔍] 検索ボタン | 展開するとノード名インクリメンタル検索バーが表示される ※ 現状未実装 |
| [⋮] パネルメニュー | View / Display / Export / Help ※ 現状はインライン Display トグル（タイトル `T` / Phaseピン `⏱`）とインスペクター開閉ボタン `⋮` のみ。Panel メニューとしては未実装 |

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

> **現状の実装**: ドロップダウン形式のパネルメニューは未実装。`TimelineHeader` の右端にインラインの Display トグル（`showTitles` / `showPhasePins`）とインスペクター開閉ボタンが並ぶ。`showChapterNumbers` は store と永続化スキーマには存在するが、ヘッダー UI からは切り替え不可（描画ロジックは反映済み）。グリッドライン・感情曲線・Export・View（レーン）切替は MVP 範囲外。

---

## B. モードバー

### 軸モード選択

セグメント選択で時間軸を切り替える。選択状態によってビューポートのレイアウトが変わる。

| モード | ノード位置の決定元 | 編集可否 |
|--------|------------------|---------|
| **Story-time** | `tree_nodes.story_time_order`。未設定シーンはフォールバック（後述） | ドラッグで編集可 |
| **Reading-order** | ツリーのDFS順序（Scenesパネルと同じグローバル順序）。`computeGlobalSceneOrder`（`src/features/codex/phaseResolver.ts`）で Part / Chapter / Scene の入れ子を線形化して生成 | 編集不可（Scenesパネルで編集） |
| **Write-order** | `tree_nodes.created_at` 昇順 | 編集不可（創造時刻） |

> Reading-order の線形化は `phaseResolver.ts` が提供する `computeGlobalSceneOrder` を Timeline / Map / Codex Phase 解決で共有利用する（命名上 `treeStore` 配下にあるわけではない点に注意）。Timeline が独自に DFS を再実装しないことで、Scenes パネルと完全に同じ順序が保証される。

### スペーシングモード

| モード | 動作 |
|--------|------|
| **Proportional** | ノード間の距離が時間差に比例（story-time/write-orderで有用） |
| **Uniform** | ノードが等間隔に配置される（reading-orderのデフォルト） |

- Reading-orderでは常にUniform（意味がないため）
- Story-time/Write-orderではProportionalがデフォルト、手動でUniform切替可能

#### 軸別 Proportional の計算元

| 軸 | Proportional の距離基準 |
|----|----------------------|
| Story | scheduled 件数に対する均等配分（`story_time_order` キー間隔の実距離ではなく、配置済みノード数で按分） |
| Write | `tree_nodes.created_at` の時間差に比例して配置 |
| Reading | 適用されない（常に Uniform） |

#### 軸モード変更時のスペーシング自動切替

軸モードを変更したタイミングで `spacingMode` が以下のように自動的に切り替わる:

| 新しい軸 | 自動セットされる spacing |
|---------|----------------------|
| Reading | `uniform` |
| Story | `proportional` |
| Write | `proportional` |

ユーザーが軸モード変更後に手動で切り替えた場合は、その選択がその軸で保持される（再度軸を切り替えると再び自動初期化が走る）。

### フィルタ

| フィルタ | データソース | 動作 |
|---------|------------|------|
| **POV** | `tree_nodes.pov_character_id` | 選択したキャラクターが視点のシーンのみ表示 |
| **Location** | `tree_nodes.location_id` | 選択した場所のシーンのみ表示 |
| **Has phases only** | `codex_entry_phases.anchor_node_id` | Phaseがアンカーされているシーンのみ表示 |
| **Status** | `tree_nodes.status` | 指定ステータスのシーンのみ表示 |

フィルタ適用中は非マッチシーンを薄いスタイル（opacity 0.25）で表示。完全に隠すのではなく「そこにシーンがある」という構造感を維持する。

> **現状の実装**: フィルタ機能は未実装。`tree_nodes.pov_character_id` / `location_id` のカラム自体は schema・`treeStore` ともに導入済み（`povCharacterId` / `locationId`、Matrix / Map で利用中）だが、Timeline 側にフィルタ state（`timelineStore.filter`）や UI（フィルタドロップダウン）は存在しない。Has phases / Status を含め、フィルタ全種が将来拡張扱い。

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

story-timeモードでは `story_time_order = NULL` のシーンが存在するかに関わらず、**Unscheduled レーンは常時表示**される。scheduled 件数が 0 でも、全シーンが scheduled であってもレーン自体は描画し続けることで、ドロップ先としての発見性と一貫性を確保する。

- 未設定シーンは reading-order に従って左から並ぶ
- ドラッグでメイン軸上に持っていくと、ドロップ位置の story_time_order が自動割り当てされ、Unscheduledから抜ける
- 件数が多い場合はレーンが横スクロール可能

#### ドラッグ中のハイライト

ドラッグ中は Unscheduled レーンがドロップ候補としてビジュアルフィードバックされる:

- レーン全体の `fillOpacity` を `0.05` まで上げて薄く塗る
- メイン軸と Unscheduled レーンを分ける separator を強調表示する

これによりメイン軸 ↔ Unscheduled の往復ドラッグが視覚的に明瞭になる。

#### 軸吸着ヒューリスティック（`AXIS_LOCK_THRESHOLD`）

ドラッグ中のポインタ Y 座標が**メイン軸から 28px 以内**にある間は「軸上ドラッグ」としてロックされ、Unscheduled レーンへは落ちない。この 28px を超えて下方向へ外れた瞬間に Unscheduled レーンへの移動候補として扱う。

- 定数名: `AXIS_LOCK_THRESHOLD`（px）
- ロック中はメイン軸の再配置プレビューのみが動き、Unscheduled レーンのハイライトは出ない
- しきい値を跨いだ時点でプレビューが Unscheduled 側に切り替わる

これにより「軸上の並び替えのつもりが誤って Unscheduled に落ちる」事故を抑止する。

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

#### 集約表示のツールチップ

同一シーンに複数 Phase がアンカーされている場合は、個別ピンを並べずに **`⏱×N`** のバッジ 1 つに集約する。ホバー時は SVG の `<title>` 要素を使い、全 Phase を改行区切りのテキストで列挙する（`{エントリ名}: {フェーズラベル}` を Phase 件数分）。よりリッチな UI が必要になれば後続のポップオーバー実装に差し替える余地を残しつつ、MVP では `<title>` ベースで必要十分とする。

### 時間軸ラベル

軸モードに応じて表示が変わる。

| モード | ラベル内容 |
|--------|----------|
| Story-time | `story_time_label`（設定されていれば）or `T{N}`（story-time順での通し番号、1始まり） |
| Reading-order | `Ch.{N}`（シーン読み順での通し番号、1始まり）。※ 現状の実装（`timelineLabels.ts`）は配列インデックスベースの通し番号のみで、章フォルダー名・章階層からの算出は行わない |
| Write-order | 作成日（相対「2週間前」または絶対「2026/3/15」） |

ラベル間引き: ノード密度が高い場合は5〜10ノードおきに表示。ズームで増減。

#### ラベル間引きの刻み切替

実装は `timelineLabels.ts` にまとめる。**ノード密度 × zoom** から、軸ラベルの表示刻みを以下の中から選択する:

| 密度バンド | 刻み |
|-----------|------|
| 低密度 / 高ズーム | 1（全ノードにラベル） |
| 中密度 | 3 |
| 高密度 | 5 |
| 超高密度 / 低ズーム | 10 |

密度と zoom のしきい値は `timelineLabels.ts` 内で調整する。story/reading/write いずれの軸でも同じロジックを使い、軸ごとのラベルソース（`story_time_label` / `Ch.N` / `created_at` フォーマット）を渡す形で共通化する。

### 空状態 UI

シーン数が 0、または軸上 scheduled 件数が 0 のときの表示:

| 状態 | 表示 |
|------|------|
| プロジェクトにシーンが 0 件 | ビューポート中央に「シーンがありません」プレースホルダーを表示 |
| 軸上（メイン軸）に配置されているシーンが 0 件（story モードで全シーンが unscheduled など） | 軸上に「↑ シーンをここにドラッグして story-time を設定」というヒントを表示 |

どちらもドロップターゲットとしての機能は維持し、Unscheduled レーンからのドラッグでそのまま scheduled 状態に移行できる。

### 感情曲線（実験的）

ビューポートの背景に薄いSVGパスとして、各シーンの `emotion_score` を補間した曲線を描画する（設定でOFF可）。

- `emotion_score` は 0〜1 の値、未計算シーンは線を途切れさせる
- 算出はAI（Settings指定の軽量モデル）。シーン本文の感情強度を推定
- 明示的に「Generate emotion scores」ボタンを押した時に一括計算（自動計算しない）
- 未計算が多いプロジェクトでは曲線は表示しない

> MVPでは実装しない（v2以降の検討事項）。

---

## D. インスペクター（optional）

ビューポート右側にスプリット可能な詳細ペイン。`⋮` ボタンで開閉し（`inspectorOpen`）、**開いている間は常に枠を表示する**。シーンを選択していればその詳細を、未選択なら「シーンを選択すると詳細が表示されます」というプレースホルダーを出す（threads モードの `PlotMarkerInspector` と同じ「開いていれば常に表示・未選択はプレースホルダー」挙動に揃える）。シーンのシングルクリックは選択＋プレビュータブを開くのみで、インスペクタは自動オープンしない（明示的に `⋮` で開く）。

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
│  index: #45 / 132   │
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

- `label` のみインライン編集可能（変更は即保存）
- 並び順の変更（`story_time_order` の更新）は**Timeline ビューポート上のドラッグが唯一の手段**。order キー自体は文字列 fractional indexing による opaque な値（後述）なので、数値での直接入力 UI は提供しない
- 表示している `index: #45 / 132` は「story-time順での何番目か」を示す参考表示で編集不可
- Anchored phases リストからCodex/Phase編集ダイアログへ遷移
- パネル幅が狭い場合（Bottom Dockの高さ制約下）、インスペクターは畳まれてノード選択時にポップオーバーで表示

> **現状の実装** (`TimelineInspector.tsx`): タイトル / Status（読み取り専用テキスト） / Story-time label（インライン編集、story-time モード時のみ） / 配置済み・Unscheduled 表示 / Synopsis / Anchored phases / Created at を表示する。**`inspectorOpen` の間は `selectedNode` が無くても枠を描画し、未選択時はプレースホルダー（`timeline.inspector.empty`）を出す**（`node: TreeNodeData | null` を受け取り、`TimelinePanel` 側も `selectedNode &&` ガードを外して常時描画）。**root は `min-h-0 overflow-y-auto` で、内容が縦に溢れる場合はインスペクタ内をスクロールできる**（高さ固定の親 row 内でクリップされない）。Characters・Location 行、`index: #N / M` の参考表示、`[Open in Editor ↗]` ボタン、Status のドロップダウン編集、ポップオーバー化はいずれも未実装（将来拡張）。なお `viewMode === "threads"` のときはインスペクター枠が `TimelineInspector` から `PlotMarkerInspector`（プロットスレッド/マーカー編集）へ差し替わる（後述「プロットスレッド表示」節）。

#### Story-time ラベルのインライン編集

Inspector 上の `story_time_label` フィールドは、クリックで `<input>` に変わるインライン編集 UI を提供する:

- `Enter` キー押下 または blur（フォーカスアウト）で確定 → `tree_nodes.story_time_label` を更新
- ラベルをすべて消して確定した場合は `story_time_label` を `NULL` に戻す（`""` ではなく `NULL` で保存）
- `Escape` で編集キャンセル（元の値に戻る）
- 編集中に軸モードやフィルタが変わっても編集状態は維持する

---

## プロットスレッド表示（threads ビューモード / Plottr 型）

> **2026-06-22 出荷（PR #168 / commit `d72468c9`）**。Reddit ユーザー要望「Plottr 型＝名前付きプロットスレッドがシーンを貫いて走り、各シーンに導入/展開/回収のような段階マーカーを置ける」を実装。詳細設計 spec は `docs/superpowers/specs/2026-06-22-plot-thread-timeline-design.md`、DB 定義は [統合DBスキーマ設計書](./Grimodex_統合DBスキーマ.md)「プロットスレッド・タイムライン」節。

### 位置づけ

ヘッダーの viewMode トグルで Timeline の表示が 2 モード（`scenes` / `threads`）に切り替わる。

| viewMode     | 内容                                                        | y 軸の意味                            |
| ------------ | --------------------------------------------------------- | --------------------------------- |
| `scenes`（既定） | これまでのシーン年表。本文書 A〜D 章で説明したシーンノードの時間軸表示                     | scheduled / unscheduled の 2 レーン固定 |
| `threads`    | **名前付きプロットスレッドのスイムレーン表示**。各スレッドが横一本のレーンを持ち、シーン上に段階マーカーを置く | スレッドごとに 1 レーン（N レーン）              |

x 軸（シーンの並び）は両モードで共通で、ヘッダーの軸モード（Reading / Story / Write）とズームをそのまま流用する。`threads` モードでもシーンの x 位置は `scenes` モードと同一に保たれる。

**設計判断**: 専用 `PanelId` は追加しない（`validateLayoutState` ゲート回避）。`TimelineViewport` の `yOf`（`scenes` モードの 2 レーン固定）を、`plotThreadLaneModel.laneY(index) = LANE_TOP(60) + index * LANE_HEIGHT(56)` の N レーンへ一般化することで実現する。Codex の Phase ピン（キャラ/場所アーク）とは別テーブル・別レーンモードで意味論衝突しない（ユーザーが専用テーブルを選択した恩恵）。

### レーンとマーカーの描画モデル

`buildPlotLaneModel({ threads, links, sceneX })`（純関数 `src/features/plot-threads/plotThreadLaneModel.ts`）がレーン描画モデルを生成する。幾何は純関数で単体テスト gate（SVG 明示座標のため browser test は不要）。

- **レーン縦順**: `plot_threads.sort_order`（base62 fractional-index）昇順。同値は `id` で決定化
- **レーン見出し**: 左端固定のテキスト（スレッド名、空なら「（無名）」）。クリックでそのスレッドを選択しインスペクタを開く
- **レーン背景**: 薄い水平線 + レーン全幅の透明クリック領域（`cursor: copy`）
- **マーカー**: `plot_thread_scene_links` 1 行 = 1 マーカー。アンカーシーンの x（`xOf`）× レーンの y（`laneY`）に円で配置。色は `thread.color ?? var(--primary)`。`<title>` で `{スレッド名}: {phase_type}` をツールチップ表示。存在しないシーンを参照するマーカーは描画しない
- マーカーのソートは x 昇順 → phase 正準順（`introduce < develop < turn < climax < resolve`）→ `linkId` で決定化

### 操作

| 操作 | 動作 |
|------|------|
| ヘッダー `[スレッド]` を選択 | `threads` モードに切替（永続化） |
| ヘッダー「+ スレッドを追加」 | 「新しいスレッド」を末尾レーンとして追加（`sort_order` は実最大キーの後ろ） |
| **レーン背景をクリック** | クリック x に**最も近いシーン**（`nearestSceneIndex`）に段階 `develop`（展開）のマーカーを 1 つ追加 |
| マーカー（円）をクリック | そのマーカーを選択し、インスペクタ（`PlotMarkerInspector`）を自動で開く |
| レーン見出し（スレッド名）をクリック | そのスレッドを選択し、インスペクタを自動で開く |

### インスペクタ（`PlotMarkerInspector`）

`threads` モードでは、インスペクター枠が `TimelineInspector`（scenes 用）から **`PlotMarkerInspector` に差し替わる**。マーカー選択時はその親スレッドも同時に上部へ表示され、スレッド編集とマーカー編集が縦に並ぶ。

| 選択対象 | 編集できる項目 |
|----------|---------------|
| レーン見出し（スレッド） | 名前（`onBlur` でコミット・空文字は無視）／スレッド削除 |
| マーカー | 段階（5 値 select）／メモ（複数行・`onBlur` コミット・空文字は `NULL`）／マーカー削除 |

### 段階（phase_type）enum

初版固定の 5 値（CHECK 制約・後から広げると table rebuild）。正準順は下記の並び（`PLOT_PHASE_TYPES` / `src/db/schema.ts`）。マーカー追加時の既定は `develop`。

| 値 | 日本語ラベル（i18n `plotThread.phaseType.*`） |
|----|-----------------------------------------------|
| `introduce` | 導入 |
| `develop` | 展開 |
| `turn` | 転 |
| `climax` | クライマックス |
| `resolve` | 回収 |

### データフロー・状態

- 永続化: `plot_threads`（スレッド）+ `plot_thread_scene_links`（マーカー）の 2 テーブル。Tauri CRUD（全 project スコープ、`plot_thread_link_create` は thread と node が同一 project かを XPROJ ガードで強制）。非 Tauri（テスト/ブラウザ）は Drizzle 直 query
- `plotThreadStore`（Zustand）が `threads` / `links` を保持。`TimelinePanel` は `currentProjectId` 変化で `load(projectId)` を呼ぶ。`load` は開始時に即クリア（切替で前プロジェクトの残骸を見せない）し、非同期取得後に `getCurrentProjectId() !== projectId` なら破棄する stale ガードを持つ（Grimodex 頻出のストア汚染対策）
- カスケード: シーン削除 → そのシーンを参照するマーカーが CASCADE 削除／スレッド削除 → そのスレッドのマーカーが CASCADE 削除（store でもローカル即時反映）

### v1 の制限（スコープ外）

実装済みは「スレッド CRUD ＋ レーンクリックでマーカー追加 ＋ インスペクタでマーカー/スレッド編集」まで。以下は v1 未実装:

- **マーカー / レーンのドラッグ操作**: 横ドラッグでの別シーン再アンカー、縦ドラッグでの別レーン移動、レーン見出しドラッグでのスレッド並べ替えは未実装（spec §4.2 に将来案として記載）。並べ替えは「追加順（`sort_order` 末尾追加）」のみ
- **スレッド色の編集 UI**: `setThreadColor` store アクションと `color` カラムは存在するが UI からは設定不可（既定 `var(--primary)`）
- スレッドの階層ネスト / アーカイブ非表示トグル / マーカー間の因果 DAG / 伏線レーダーからのスレッド候補提案 / CSV エクスポート

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

#### fractional indexing を使ったドラッグ編集フロー

1. `onPointerDown` で対象ノードを掴み、ドラッグ中は楽観的に位置を更新
2. `AXIS_LOCK_THRESHOLD`（28px）でメイン軸 / Unscheduled を判定
3. `onPointerUp` で前後ノードの `story_time_order` キー（`prevKey`, `nextKey`）を確定
4. `fractional-indexing` の `generateKeyBetween(prevKey, nextKey)` で新しい order キーを生成
   - 先頭ドロップ: `generateKeyBetween(null, firstKey)`
   - 末尾ドロップ: `generateKeyBetween(lastKey, null)`
   - Unscheduled ドロップ: キー生成をスキップし `NULL` を書き込む
5. `treeStore.updateStoryTime(nodeId, { order, label })` に委譲（DB 書き込み・再レイアウト・`SceneTimeIndex` 再構築・Phase 再解決は store 側で一本化）

複数選択ノードの一括ドラッグ（将来拡張）では、選択内の相対順序を維持したまま、最初のノードから順に `generateKeyBetween` を連続呼び出しして**連続した中間キー**を発行する。

#### order の自動算出ルール

ドロップ位置で前後のノードを検出し、**文字列 fractional indexing**（npm `fractional-indexing` 互換アルゴリズム）で前後の間に入る新しいキーを生成する:

```
前ノード order = "a0",  後ノード order = "a1"
→ 新 order = generateKeyBetween("a0", "a1")  // 例: "a0V" — 辞書順で "a0" < "a0V" < "a1"
```

- 先頭にドロップ: `generateKeyBetween(null, firstKey)` （先頭側の新キーが返る）
- 末尾にドロップ: `generateKeyBetween(lastKey, null)`
- Unscheduled→軸: ドロップ位置の前後キーから生成
- 軸→Unscheduled: `story_time_order` を `NULL` にクリア。`story_time_label` は保持

キーの具体的な文字セット・生成規則は `fractional-indexing` ライブラリに委譲する（Scenes パネルの `sort_order` と同一方式）。キーは opaque であり、上記の `"a0V"` はあくまで「辞書順で中間に入る何らかのキー」の説明用。

文字列 fractional indexing の特性:

- キーは ASCII 文字列で **辞書順比較**（SQLite のデフォルト `COLLATE BINARY` でソート可能）
- 中央キー生成は理論上**無限に**可能で、隣接差が縮んでも精度劣化しない
- そのため**全件再整列は原則不要**（Scenes パネルの sort_order と同方式）
- Phase resolution は `anchor_node_id` 経由でシーンを引いて文字列比較するだけなので、整数/REAL と同じ計算量で動く

> 内部キーは opaque な文字列（例: `"a0"`, `"aMV"`, `"Zz"`）であり、ユーザー UI には表示しない。並び順を直接編集したいユーザーには、Timeline 上のドラッグまたは `story_time_label` の編集 + 周辺シーンのドラッグで対応してもらう。

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
| Set status | 5 ステータス（Outline / Draft / Complete / Revision / Final）を直接選択 |
| Clear story-time | order と label を NULL に（story-timeモード時のみ表示） |
| --- | |
| Show in Scenes | Scenesパネルで該当ノードを展開・選択 |
| --- | |
| 削除 | Scenesパネルと同じ削除フロー |

> **現状の実装** (`TimelineContextMenu.tsx`): 上記のうち「Editorで開く」「サイドで開く」「Set status」「Clear story-time」（story-timeモード時のみ）「Show in Scenes」「削除」を実装する。「Set story-time label...」はコンテキストメニューには無く、`F2` キー（story-timeモード時）または Inspector 上のインライン編集から行う。「Add phase here...」（Phase 作成ダイアログ起動）も未実装で、Phase 作成は Codex パネル側の動線に依存する（将来拡張）。

### ズーム・スクロール

| 操作 | 動作 |
|------|------|
| `ホイール`（縦回転） | ズームイン/アウト（軸のpx/unit比が変わる） |
| `Shift+ホイール` / トラックパッド横スワイプ / スクロールバー | 水平スクロール（タイムライン上の移動） |
| `Ctrl+0` | Fit to viewport（全シーンが見える倍率に） |
| `Ctrl++` / `Ctrl+-` | 段階的ズーム |

> ホイール単体でズームする（旧仕様の `Ctrl+ホイール` 必須は廃止）。横優位の入力（`Shift+ホイール` / トラックパッドの横スワイプ = `|deltaX| > |deltaY|`）はズームせずブラウザ既定の水平スクロールに委ねる。

ズームレベルは Timeline パネルごとに独立して永続化（`global-settings.json`）。

#### ズーム範囲クランプ

`timelineStore` 側で **zoom 値は `0.25` 〜 `4.0` の範囲にクランプ**する。以下の全入力経路で共通のクランプを通す:

- `Ctrl+0`（Fit）: Fit 計算後の倍率をクランプしてから適用
- `Ctrl++` / `Ctrl+-`: 段階的ズーム後にクランプ
- `ホイール`（縦回転）: wheel delta を zoom に反映後にクランプ

範囲外への入力は端でサチュレートする（エラー表示はしない）。

#### スクロール位置の復元と save-back 抑止

`TimelineViewport` はマウント時に `timelineStore` に保存されている `scrollOffset` を読み、ビューポートをその位置にスクロールさせる。復元フロー中に走る `scroll` イベントが store へエコーバックされないよう、`isRestoringRef`（`useRef<boolean>`）で抑止する:

1. マウント時に `isRestoringRef.current = true`
2. `scrollLeft = scrollOffset` をセット
3. 次フレーム（または `scroll` イベントが落ち着いたあと）で `isRestoringRef.current = false`
4. `onScroll` ハンドラは `isRestoringRef.current === true` の間は `scrollOffset` を更新しない

これで「復元 → onScroll → 保存」という無限ループ・位置ズレを防ぐ。

#### `containerEl` ベースの wheel listener 再登録

シーンが遅延ロードされるとビューポートのコンテナ DOM がアンマウント／再マウントされることがあり、`useEffect(() => ..., [])` の一度きり登録ではホイールズームが効かなくなる。これを避けるため、コンテナ要素は `ref` ではなく **`useState<HTMLElement | null>` で保持（`containerEl`）** し、`containerEl` を依存に持つ effect で wheel listener を再登録する:

```ts
const [containerEl, setContainerEl] = useState<HTMLElement | null>(null);
// <div ref={setContainerEl} />
useEffect(() => {
  if (!containerEl) return;
  containerEl.addEventListener('wheel', handleWheel, { passive: false });
  return () => containerEl.removeEventListener('wheel', handleWheel);
}, [containerEl, handleWheel]);
```

これにより、シーンの遅延ロード後に再マウントされた新しいコンテナへも自動的に listener が貼り直される。

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

Timelineでstory-timeを編集すると、Phase resolution（特に `auto` / `story` モード時）の結果が変わる可能性がある。再解決の実体は Codex パネル設計書「シーン順序の解決」節の `SceneTimeIndex` + `resolveCodexState` パイプラインで、Timeline のドラッグは以下のように波及する:

1. `story_time_order` 変更 → `SceneTimeIndex.storyTimeOrder` / `storyTimeInherited` を再構築（`readingOrder` は不変）
2. 再構築された Index に基づき、`phase_resolution_mode` が `auto` / `story` の場合のみ、Phaseを持つエントリ単位で `resolveCodexState` を再実行（`reading` モードでは実質ノーオペ）
3. 再解決結果が Chat コンテキスト / Codex パネル表示 / Editor のホバーカードに即時反映

`mode = 'reading'` 時は再解決がスキップされるため、Timeline のドラッグは描画更新のみで完結する。

#### 再解決のタイミング

ドラッグ中は連続的に order が変動するため、毎フレーム再解決するとフレームレートが落ちる。以下の戦略を取る:

| トリガー元 | 再解決タイミング |
|----------|----------------|
| ノードのドラッグ | `onPointerUp`（ドラッグ確定）時のみ。ドラッグ中はビューポート上の位置のみ楽観的に更新 |
| インスペクターの order インライン編集 | フォーカスアウトまたは `Enter` 確定時のみ。タイプ中の中間値では再解決しない |
| 軸モード切替 | 即時（再解決ではなく描画再計算のみ） |
| `phase_resolution_mode` 設定変更 | 即時（Settings 経由のため低頻度） |
| Codex Phase の追加/削除/再アンカー | 即時 |

ドラッグ確定時の再解決でも複数 Codex エントリの解決計算が走るため、ワーカースレッドへのオフロード余地がある（Phase B以降で計測の上判断）。

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

> **現状の実装**: `Add phase here...` コンテキストメニュー項目は未実装（`TimelineContextMenu.tsx` に該当 item が無い）。当面 Phase 作成は Codex パネル側の動線に依存する（将来拡張）。

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
| `Space` | 選択ノードをEditorでプレビュータブとして開く ※ 現状未実装（Scenesパネルでは実装済みだが Timeline のキーハンドラには `Space` ケースがない。固定タブを開く `Enter` のみ対応） |
| `Ctrl+Enter` | 選択ノードを新しいEditor Groupで開く |
| `1` / `2` / `3` | Axisモード切替（Story / Reading / Write） |
| `Ctrl+F` | 検索バーにフォーカス ※ 現状未実装（検索バー自体が未実装。Ctrl+F ケースもキーハンドラにない） |
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
| `viewMode` | `'scenes' \| 'threads'` | 表示モード。`scenes`=シーン年表（既定）/ `threads`=プロットスレッドのレーン表示。永続化される |
| `spacingMode` | `'proportional' \| 'uniform'` | スペーシング。軸モード変更時に Reading→`uniform` / Story・Write→`proportional` で自動初期化 |
| `zoom` | `number` | ズーム倍率（1.0 が Fit）。`0.25` 〜 `4.0` にクランプ |
| `scrollOffset` | `number` | 水平スクロール位置（px）。復元中は `isRestoringRef` で save-back を抑止 |
| `selectedNodeIds` | `string[]` | 選択中のノードID（配列。`Set<string>` ではない） |
| `filter` | `{ povId?: string, locationId?: string, hasPhases: boolean, status?: SceneStatus[] }` | フィルタ状態。※ 現状未実装（store に `filter` フィールドは存在しない） |
| `inspectorOpen` | `boolean` | インスペクター開閉 |
| `display` | `{ showTitles: boolean, showChapterNumbers: boolean, showPhasePins: boolean }` | 表示設定（フラットキー） |
| `pendingEditNodeId` | `string \| null` | F2 によるラベル編集ターゲット。Inspector がこの値を読んで該当 input にフォーカスし、消費後に `null` に戻す |
| `selectedPlotLinkId` | `string \| null` | `threads` モードで選択中のマーカー（`plot_thread_scene_links.id`）。マーカークリックで設定。永続化しない |
| `selectedPlotThreadId` | `string \| null` | `threads` モードで選択中のスレッド（`plot_threads.id`）。レーン見出しクリックで設定。永続化しない |

永続化: `axisMode` / `viewMode` / `spacingMode` / `zoom` / `scrollOffset` / `display` は `global-settings.json` の `timeline` セクションに保存。`selectedNodeIds` / `filter` / `pendingEditNodeId` / `selectedPlotLinkId` / `selectedPlotThreadId` は永続化しない（セッション限定）。保存は store subscribe での 500ms デバウンス、初期復元時の save-back を抑止する専用ヘルパとして `loadAndSyncTimelineSettings` を提供する。

#### store 型に関する注記

- `selectedNodeIds` は **`string[]`** で保持する（初期設計では `Set<string>` だったが、React の再レンダー契約と Zustand の浅い比較との相性のため配列に確定）。重複排除・包含判定は配列ユーティリティで行う
- `display` は **フラットキー**（`showTitles` / `showChapterNumbers` / `showPhasePins`）で、階層構造（`display.titles` のようなネスト）は取らない
- `display.grid` / `display.emotion` はパネルメニューの項目として設計上存在するが、**MVP 範囲外**のため `display` 型には含めない。パネルメニューの対応項目はプレースホルダー扱い

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
ALTER TABLE tree_nodes ADD COLUMN story_time_order TEXT;
ALTER TABLE tree_nodes ADD COLUMN story_time_label TEXT;

-- 通常インデックスのみ（部分インデックスは使わない）
CREATE INDEX idx_tree_story_time ON tree_nodes(project_id, story_time_order);
```

> **インデックス方針**: `story_time_order IS NULL` を除外する部分インデックスは**採用しない**。NULL を含む通常インデックスで十分な selectivity が得られ、Unscheduled レーン表示のための「project 内の `story_time_order = NULL` 件数」クエリもこのインデックスで賄える。Drizzle でのマイグレーション定義もシンプルになるため、通常インデックス 1 本に統一する。

| カラム | 型 | 説明 |
|--------|-----|------|
| `story_time_order` | TEXT NULL | 作中時間の順序キー。**文字列 fractional indexing** によるソートキーで、辞書順比較のみ意味を持つ。Sceneノードのみ意味を持つ（Folder/Noteでは未使用） |
| `story_time_label` | TEXT NULL | 表示用ラベル（例: `"帝国暦1024年3月"`, `"Day 3 morning"`）。order とは独立して編集可能 |

**設計判断**:

- **文字列 fractional indexing を採用**: Scenes パネルの `sort_order` と同じ方式に統一。理論上無限に中間挿入可能で、隣接差の精度劣化による全件再整列が不要。Timeline はドラッグ編集の頻度が高いため、再整列のリスクを排除する
- SQLite の `COLLATE BINARY`（デフォルト）で辞書順ソートが効くため、特別なインデックス設定は不要
- label と order を分離している理由: 同じ order でも表示は柔軟に変えたい。また label だけ設定して order は後で決める、というワークフローを許容
- Sceneでのみ有効だが、カラム自体は `tree_nodes` に追加（テーブル分離するほどでもない）
- ライブラリは npm `fractional-indexing`（または互換実装）を使用。Rust 側で生成する場面は当面なく、生成は TypeScript 側のドラッグハンドラで完結する

### projects への追加カラム

```sql
ALTER TABLE projects ADD COLUMN phase_resolution_mode TEXT NOT NULL DEFAULT 'reading'
  CHECK(phase_resolution_mode IN ('auto', 'reading', 'story'));
```

| カラム | 型 | 説明 |
|--------|-----|------|
| `phase_resolution_mode` | TEXT | Codex Phase の resolution で使う時間軸。新規プロジェクトは `auto` を推奨、既存プロジェクトは `reading` で後方互換 |

> **現状の実装（SQL 既定値 と ORM 既定値の差異に注意）**: 実 DB の DDL（Rust `src-tauri/src/database/migrate.rs` および `browser-mock.ts`）は本設計書の通り `DEFAULT 'reading'` を採用し、既存プロジェクトの後方互換を保証する。一方、Drizzle スキーマ（`src/db/schema.ts:30-34`）は `.default("auto")` を宣言しており、`createProject`（`src/features/project/api.ts`）が `phaseResolutionMode` を明示指定しないため、Drizzle 経由で作成される新規プロジェクトには **ORM 既定値の `auto` が INSERT 時に注入される**（SQL 既定値の `reading` ではなく `auto` で着地する）。結果として「新規プロジェクト = `auto` / 既存プロジェクト = `reading`」という設計意図は満たされるが、SQL レベル（`reading`）と ORM レベル（`auto`）で既定値が二重化している点は将来的に統一を要検討（どちらか一方に揃え、必要なら `createProject` で明示設定する）。

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
-- 感情曲線（v2以降）
ALTER TABLE tree_nodes ADD COLUMN emotion_score REAL;
```

これらは Timeline パネル単体では必須ではない。

> **現状の実装**: POV / Location 連携カラム（`pov_character_id` / `location_id`、いずれも `codex_entries(id) ON DELETE SET NULL`）は**既に schema・`treeStore` に追加済み**で、Matrix / Map / Inspector などから利用されている。インデックスは `idx_tree_pov` / `idx_tree_location` の**部分インデックス**（`WHERE ... IS NOT NULL`）で作成されており、`story_time_order` 用の通常インデックス方針とは扱いが異なる。Timeline 側でこれらを参照するフィルタ UI は未実装。

---

## 実装ライブラリ候補

### タイムライン描画

- **自前SVG描画**: ノード数がせいぜい数百なので、D3やライブラリに頼らず直接SVGで描画。フルコントロールでき、ドラッグも React の onPointerDown で簡潔に実装できる
- 代替案: `vis-timeline` / `@nivo/line` — 機能は豊富だが過剰。小説ツール用途には不要

### ドラッグ

- 既存の `@dnd-kit/core` を流用（Scenesパネルで使用中）
- カスタム sensor で水平ドラッグのみ許可、ドロップ判定は自前

### ズーム・パン

- `react-zoom-pan-pinch` は過剰。スクロール + ホイールズームのイベントハンドリングで十分

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

具体的な登録先は **`src/features/layout/panelRegions.ts`** で、`timeline` を `center-bottom` リージョンに登録する。パネルトグル用ショートカット `Ctrl+Alt+L` は同ファイルのトグル定義から参照される。

### Scenesパネル設計書

- Reading-orderの編集責務は Scenesパネルに残る（ツリーのD&D）
- Timelineは story-time の編集責務を持つ（ドラッグで story_time_order 更新）
- アクティブシーン同期（`activeSceneSync`）は両パネル間で連動

### Codexパネル設計書

- CodexパネルのPhaseタブのミニタイムラインは、本パネルの圧縮版として振る舞う
- 「Open in Timeline panel ↗」ボタンで遷移
- Phase作成/編集/削除がTimelineに即時反映
- Timeline の軸順変更（`story_time_order` のドラッグ編集）は、Codex Phase の解決インデックスに波及する
  - `projects.phase_resolution_mode = 'reading'` のとき: Codex 側は Scenes ツリーの読み順（`computeGlobalSceneOrder`）を参照するため、Timeline のドラッグは描画のみで Codex には影響しない
  - `'story'` / `'auto'` のとき: `story_time_order` の変化が `SceneTimeIndex` を介して Codex Phase 解決に反映される
- この関係は Codex Phase 設計書「シーン順序の解決」節と同一の契約であり、Timeline と Codex の双方が `SceneTimeIndex` を唯一のソース・オブ・トゥルースとして共有する

### Editorパネル設計書

- Editorのシーンヘッダーに story_time_label を表示する欄を追加（折りたたみ可能、既存のSynopsis表示エリアに並べる）
- Editor内での story-time 編集は不可（Timelineまたはインスペクターが唯一の編集点）

### 統合DBスキーマ

上記「DBスキーマの追加・変更」セクションを統合DBスキーマ設計書の `tree_nodes` / `projects` 定義に反映する必要がある。

### Scenesパネル（参照関係の整理）

- Scenes ツリーの線形化関数 `computeGlobalSceneOrder`（実体は `src/features/codex/phaseResolver.ts`、Phase 解決と共有）を Timeline の Reading-order 軸が再利用する
- Timeline が独自順序を実装しないことで、Scenes と Timeline の表示が常に一致する
- Scenes 側で Part/Chapter のツリーを再構成した場合は `computeGlobalSceneOrder` の返り値が変わり、Timeline の Reading 軸に自動的に反映される

### Map パネル

- Map は時間軸を扱わない（旧設計の Time モードは Map 設計書改訂で削除済み）。`story_time_order` の編集は Timeline が唯一の編集点
- Map で配置された Scene ノードは `story_time_order` の有無に関わらず手動座標で配置される
- POV / Location 情報（`tree_nodes.pov_character_id` / `location_id`、Phase C-2 以降）は Timeline のフィルタと Map の Color by で共通参照する想定

### i18n の注記

- Header の **axis ラベル**（Story-time / Reading-order / Write-order）と **spacing ラベル**（Proportional / Uniform）は、現時点で英語ハードコード
- その他のラベル（パネルメニュー項目、コンテキストメニュー項目、空状態プレースホルダー等）は `t(...)` 経由で翻訳リソースを参照する
- このハードコード / `t(...)` のギャップは、**将来の i18n 整理フェーズでまとめて翻訳キー化**して揃える方針
- 当面は日本語 UI 上でも axis / spacing ラベルのみ英語が残ることを許容する

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

- order 自体は文字列 fractional indexing キーで直接入力 UI を提供しないため、ユーザーから見える編集経路は「Timelineビューポート上のドラッグ」と「`story_time_label` の編集」の二つのみ
- 大量シーンの一括並び替え（例: 既存シーンを年代順に再ソート）にドラッグだけで対応するのは現実的か。一括ソート補助コマンド（「label の自然順でソート」「reading-order と同じ並びにリセット」など）が必要かどうかは v2 で再検討
- プロジェクトカレンダー機能（例: 帝国暦定義 → ラベルから order 自動生成）は v3 以降の検討

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

### Undo / Redo の粒度

- ドラッグによる `story_time_order` 変更は、Scenes パネルの並び替えと同じ history スタックに載せるか、Timeline 独自のスタックを持つかを要決定
- 単一の Undo で「order 変更 + 再解決の結果に依存する派生表示」を巻き戻す必要がある。order だけ戻して再解決タイミングがズレると Editor 上の Codex ホバー表示が一瞬古い状態になる
- MVP では **Scenes と共通の history に統合**し、`SceneTimeIndex` 再計算 + 再解決を Undo/Redo のコミットフックとして走らせる案が有力。Phase B で実装方針を確定する

### 大規模プロジェクトでのスケーラビリティ

- MVP想定は数百シーン規模の自前 SVG 描画。長編（1000+ シーン）や POV レーン展開時のパフォーマンス戦略は未検討
- 想定される対策:
  - 画面外ノードのカリング（スクロール範囲 + バッファのみレンダリング）
  - ドラッグ時のヒットテストを sweep line / bucket 方式に
  - 再解決計算を Web Worker にオフロード（Codex エントリ数 × Phase 数が大きい場合）
- Phase B で実測し、閾値（例: 500シーン超でカリング有効化）を数値で定める

### キーボードナビゲーションと Unscheduled レーン

- story-time 軸表示中に主軸とUnscheduledレーンの両方がある場合、`←`/`→` で両レーンを跨ぐかは未定義
- 候補: `↓`/`↑` でレーン切替、`Tab` で次レーン先頭へジャンプ、または `←`/`→` を主軸内のみに制限し Unscheduled は独立選択にする
- 実装時にアクセシビリティ（スクリーンリーダー向けの `aria-activedescendant` ハンドリング）と合わせて確定

### アクセシビリティ（SVG 描画）

- 自前 SVG で描画する都合上、screen reader 対応は別途設計が必要
- 最低限: シーンノードに `role="button"` + `aria-label="{章番号} {タイトル} {ステータス}"`, 軸全体に `role="listbox"` 相当のラベル、Phaseピンに `aria-label="{エントリ名}: {フェーズラベル}"` を付与
- キーボード操作時のフォーカスリング描画（SVG outline）も標準ブラウザ挙動から外れるため明示的に実装する必要あり

---

## Matrix パネル連携

[Matrix パネル](./Grimodex_Matrixパネル設計書.md) の Sort モード「Story-time order」は、Timeline の `tree_nodes.story_time_order`（文字列 fractional indexing キー）をそのまま参照する。Timeline で時系列を編集すると Matrix の Sort 順も即座に反映される（同じカラムを参照するため別途同期処理は不要）。

Timeline と Matrix は「story-time order」の管理元を Timeline に集約し、Matrix は読み取り専用で利用する。Matrix 上から story-time の編集はできない（Timeline / Map で編集する）。
