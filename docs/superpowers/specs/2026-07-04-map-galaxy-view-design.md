# Map ギャラクシービュー（3D 全体グラフ）設計書

日付: 2026-07-04
ステータス: 承認済み（方向性 = A: プロジェクト・ギャラクシー / 3D / Map 内タブ / フィルタあり）

## 目的

プロジェクト全体（シーン・Codex エントリ・Chronicle 出来事・プロットスレッド）を
Obsidian グラフビュー風の 3D force-directed graph として眺められる「映える」ビューを
Map パネル内に追加する。厳密な分析ツールではなく、**書き進めるほど銀河が育つ**という
鑑賞体験＋軽いナビゲーション（ジャンプ）＋フィルタが目標。

既存の `visualTheme: "constellation"`（ボードの見た目スキン、v2 未実装）とは別物。
名前衝突を避けるため本ビューは「ギャラクシー / Galaxy」と呼ぶ。

## アーキテクチャ

### 置き場所とビュー切替

- `MapPanel.tsx` 内でビュー分岐: `viewKind: "board" | "galaxy"`。
  - `board` = 既存の `ReactFlowProvider + MapCanvas`（現状のまま）。
  - `galaxy` = 新規 `MapGalaxyView`（`React.lazy` + `Suspense` で遅延ロード。
    three 系を起動バンドルに含めない）。
- 切替 UI は `MapHeader` に配置（MODES ボタン群の並び、セグメントトグル）。
  ギャラクシー表示中はボード専用ツールバー（パレット・整列等）を隠し、
  ギャラクシー用の最小ヘッダ操作（更新・フィルタ開閉）だけ残す。
- `viewKind` は `MapPersistentState` に追加し、既存の global settings 永続化経路
  （600ms デバウンス → `save_global_settings` の `map` 節)に相乗りする。

### 3D 描画

- 依存追加: `react-force-graph-3d`（three + d3-force-3d 内蔵、MIT）と `three`（直接依存。
  UnrealBloomPass 等を `three` から直接 import するため、pnpm の strict node_modules 下では
  明示依存が必要。型は同梱/`@types/three`）。
- 演出:
  - 深宇宙背景（暗色固定。アプリテーマに依らずギャラクシーは常に dark 前提）
  - UnrealBloomPass によるグロー（`postProcessingComposer()` 経由）
  - hover: 対象＋隣接ノード/エッジをハイライト、非隣接を減光
  - click: ノードへカメラフォーカス（スムーズ移動）
  - double-click: シーン → エディタで開く / Codex エントリ → Codex パネルで開く
    （出来事・スレッドは v1 ではジャンプなし、フォーカスのみ）
  - 自動ゆっくり回転（ユーザー操作で停止）
- Reduced Motion: `prefers-reduced-motion` 時は自動回転なし・カメラ移動は即時。
  力学シミュレーション自体は「動きの演出」ではなくレイアウト手段なので実行する
  （warmup tick でほぼ収束させてから表示する）。
- カメラ姿勢は永続化しない（毎回オートフィット）。

### グラフデータ（純関数モジュール `galaxyGraph.ts`）

入力（すべて既存 API から取得、追加の Rust/DB 変更なし）:

| データ | 取得元 |
|---|---|
| シーン一覧（読み順） | `listNodes` + 既存 reading-order DFS（`layouts/autoArrange.ts` のロジックを流用） |
| シーン⇄Codex 言及 | `buildCrossReferenceReportForProject`（Rust matcher 経由、correlation board と同じ） |
| Codex⇄Codex 関係 | `listCodexRelations` |
| 出来事 | `listEvents` |
| シーン⇄出来事 | `listSceneEventsForProject` |
| 出来事⇄参加者 | `listEventParticipantsForProject` |
| スレッド | `listPlotThreads` + `listPlotThreadLinks` |

ノード種別: `scene` / `codex`（type slug 保持）/ `event` / `thread`。
エッジ種別:

1. `mention` — シーン⇄Codex（言及、存在ベース）
2. `relation` — Codex⇄Codex（authored、label 保持）
3. `sequence` — シーン⇄次シーン（読み順の背骨）
4. `eventLink` — シーン⇄出来事
5. `participant` — 出来事⇄Codex
6. `thread` — スレッド⇄シーン

`buildGalaxyGraph(inputs) → { nodes, links }` と
`applyGalaxyFilters(graph, filters) → { nodes, links }` を純関数として実装し、
unit test で gate する。次数（degree）はフィルタ適用後に再計算し、ノードサイズに使う。

### 彩色

- Codex ノード: `useEnsureCodexTypeColors()` で埋まる typeColorMap（slug→色）を再利用。
- シーン: 白〜青白の恒星色。出来事: 琥珀系。スレッド: `PlotThreadRow.color`。
- エッジ: 種別ごとに低彩度色＋ハイライト時に発光強調。

### フィルタ

フローティングパネル（ギャラクシー右上、Obsidian 風）:

- ノード種別トグル: シーン / Codex（タイプ別ではなくまとめて v1）/ 出来事 / スレッド
- エッジ種別トグル: 言及 / 関係 / シーン連結 / 出来事リンク / 参加者 / スレッド
- 孤立ノードを隠す（フィルタ適用後に次数 0 のノードを落とす）

フィルタ状態は `MapPersistentState.galaxy` として永続化（viewKind と同経路）。
ノード種別を OFF にすると、そのノードに接続するエッジも自動的に消える。

### データ更新

- ビュー表示時（マウント時）に一括取得・構築。
- ヘッダに手動「更新」ボタン。ライブ購読（codexRelationsChanged 等）は v1 では行わない。
- 言及スキャンは correlation board 同等のコスト（Rust matcher）。進捗はスピナーで十分。

## エラーハンドリング

- WebGL コンテキスト取得失敗時: グラフの代わりに i18n メッセージ
  （「この環境では 3D 表示を利用できません」）を表示。クラッシュさせない。
- データ取得失敗時: 既存のパネル慣行に合わせ toast + 空状態表示。
- 空プロジェクト（ノード 0）: 空状態メッセージ（「書き始めると銀河が生まれる」系の文言）。

## テスト

- `galaxyGraph.test.ts`: ノード/エッジ構築（各エッジ種別）、フィルタ適用、
  孤立ノード除去、次数計算、重複エッジ正規化。
- ビュー切替・永続化: mapStore の単体テスト拡張（viewKind/galaxy filters の hydrate/persist）。
- 3D 描画（WebGL）自体は自動テスト対象外（CI で WebGL 不安定のため）。
  実機確認は `pnpm tauri dev` で行う。
- レイアウト invariant への影響なし（パネル内部の差し替えのみ）→ browser test 追加不要。

## 実装外（v2 以降）

- 検索ハイライト、タイプ別 Codex フィルタ、時間軸アニメーション（執筆履歴 replay）
- Starchart エクスポート（既存 constellation スキン計画と統合検討）
- ライブ購読による自動更新

## 付帯作業

- i18n: `map.galaxy.*` を ja/en 両方に追加。
- 依存追加（three / react-force-graph-3d）に伴い `scripts/generate-licenses.ts` で
  THIRD_PARTY_LICENSES.md を再生成（root + public/、同一ブランチで実施）。
