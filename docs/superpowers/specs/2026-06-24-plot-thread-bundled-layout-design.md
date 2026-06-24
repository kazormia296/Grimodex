# プロットスレッド 束ねレイアウトエンジン（subway / storyline 可視化）設計書

- 日付: 2026-06-24
- 対象: Timeline パネルのプロットスレッド `threads` オーバーレイのレイアウト/描画
- 前提: [プロットスレッド オーバーレイ化設計書](2026-06-24-plot-thread-overlay-design.md)、PR#168/#181
- 位置づけ: 固定レーン方式（同設計書 Phase 8 で一度「不採用」決定）を**ユーザー要望により覆し**、
  汎用 storyline / メトロマップ型の**束ね並走 + 動的レーン再配置**へ移行する。

## 背景（ユーザー相談 2026-06-24）

- 「同一区間を並走する別スレッドを **1本の物理トラックに束ねて** 見せたい」（収束/分岐の路線図）。
- 固定レーン（1スレッド=1行）では並走は「別々の行が同じ列を走る」までしか表現できない。
- これは **storyline 可視化**（Tanahashi & Ma 2012 / StoryFlow 2013 / xkcd narrative chart）の問題。
  ただし **x はシーン列に固定**（reading-order index、`sceneX`/`xOf`、scenes 行と共有・不動）なので、
  自由 2D ではなく **層化（Sugiyama）レイアウトの順序フェーズのみ**に縮約できる（x 配置/time-warp 不要）。

## 確定した設計判断（2026-06-24）

| # | 判断 |
|---|------|
| エンジン範囲 | 汎用レイアウトエンジン（固定レーン廃止・交差最小化・動的 Y 再配置） |
| 束ねの入力 | **分岐/合流エッジ（構造）＋ 共起（同一シーン列に複数スレッド）から導出**。新規グループテーブルは作らない |
| 共起の扱い | **連続 `MIN_BUNDLE_SPAN`(=3) シーン以上の共起は自動で 1 トラックに束ねる**（単発共起はハイライト＋並び順ヒントのみ） |
| 始端/終端 | **ユーザーが明示指定可能**にする（`plot_threads.start_node_id`/`end_node_id` を加算）。NULL=従来どおり最初/最後のマーカーから導出 |
| 永続スキーマ | 束ねレイアウト自体は **毎描画で導出**＝永続化しない（スナップショット/Undo への影響ゼロ）。追加列は start/end と任意の UNIQUE 索引のみ |
| 軸 | エンジンは **reading-order 限定**。story-time / write-order は従来どおりマーカーのみ |
| 既定値（推奨） | `MIN_BUNDLE_SPAN=3`／ラベル衝突は決定的押し下げ／ズーム縮退(STEP<72)＋N上限でバッジ化／**直線優先**（高さは副次） |

## 概念モデル

層化グラフ：**層 = シーン列（x 固定）**、**ノード = (スレッド, 列) の「生存セル」**、辺 = 連続列の同一スレッド。
唯一の自由変数は各セルの **Y スロット順 + 束ね**。現行 `buildPlotLaneModel` は「順序=固定 sortOrder、
1スレッド=不変1行、束ね無し」という退化特殊ケース。これを 3 段で一般化する。

## アルゴリズム（純関数・決定的）

`buildBundledLaneModel`（`plotThreadLaneModel.ts` の本体を置換、**シグネチャと `PlotLaneModel` の形は維持**）。

**PREP**: 入力を `(sortOrder→id)` で整列（Map/Set 反復順に依存しない）。`scheduledCount` 超過(x≥N)を除外（現行踏襲）。
セッション（束ね区間）を導出:
- 構造: `merge(from→to)@X` = from が X 以降 to の帯へ合流／`branch(from→to)@X` = to が X で from の帯から分岐。
- 共起: 同一列に ≥2 スレッドがマーカー（現行 `convergences`）。連続 `≥MIN_BUNDLE_SPAN` 列で持続したら束ねセッション化。
- セッション = あるスレッド集合が一緒に居る連続列の最大区間。union-find はソート配列に materialize してから判断（決定性）。

**Stage 1 — ORDERING（交差最小化・主コスト）**: 列ごとの縦順を決める。
- 初期順 = 先頭列を `(sortOrder,id)` で（乱数初期化の代わり＝再現性の要）。
- 固定 **8 パス** 左右交互スイープ。各列で各スレッドの仮位置 = 隣接（確定済）列での接続先 Y の **加重メディアン**。
  メディアンで整列、タイは `(sortOrder,id)`。**セッションは 1 単位として並べ**（グループの barycenter で位置決め→内部整列）、束ねが裂けないようにする。
- 各パス後に総交差数（隣接列ペアの反転数を BIT/merge-sort で O(k log k)、列ペア総和）を数え、**最小交差のスナップショットを保持**（最終パスが悪化しうるため argmin・最早パス優先）。

**Stage 2 — ALIGNMENT（直線化）**: 順序が決めた列内ランクの下で Y の自由度を使い、
同じ近傍が続く最長ランを共通 Y に寄せる（longest-stable-run / Brandes-Köpf 簡易版）。現行 `lineSegments` の継ぎ目分割を一般化（順序維持のため Y 変更が不可避な所でも分割）。

**Stage 3 — COMPACTION（スロット→px・高さ/wiggle 最小化）**: 列ごとにランク順で最小空きスロットへ。
**束ねは区間中 1 スロットを占有**（高さ削減）。`y = laneTop + slot*LANE_HEIGHT`（既存 `laneY` 流用）。
自由がある所は前列 Y に最も近いスロット（**最小移動・貪欲**＝wiggle 抑制、決定的）。

## 出力契約（`PlotLaneModel` の派生拡張）— 載っている屋台骨

- `PlotLineSegment`: `{x1,x2}` → `{x1,y1,x2,y2}`（px）。同スロット run は `y1===y2`（従来同等の水平帯）。スロット変化は短い斜めブリッジ（`y1!==y2`）。
- `PlotLaneMarker` に `y`（その列でのスレッド Y）を追加（もはや単一グローバル行が無い）。
- `PlotLane.y` = 最初の生存列の Y（左ガター・ラベル＋背景線アンカー用のみ。線形状はセグメント端点で駆動）。
  `PlotLane` に `slotByColumn: Map<number,number>` と `bundleId: string|null` を追加。
- `PlotConnector.fromY/toY` は `atNodeX` の **列ローカルスロットから毎回再計算**（グローバル行から読まない＝#5 の本丸）。
- 新 `bundles: {id, threadIds[], enterX, exitX, baseSlot, collapsed}[]`。MVP は collapsed 描画（帯スロットに重畳）、サブレーン fan-out は phase 2。
- `contentHeight = laneTop + (maxSlot+1)*LANE_HEIGHT`（束ねで縮む）。
- `convergences`/`scheduledCount`/`PHASE_ORDER`/terminus は維持。

### #5 / #7 の吸収
- **#5 マージがシーン後方にずれる**: コネクタ Y はランク由来になり、`atNodeX` の列でホスト帯に隣接して着地。
  ユーザー確定の「斜めランプ・S2 着地」を、ランプ端点を列スロットへ合わせて実現（旧 `[X..X+34]` の固定右オフセットを廃止）。
- **#7 マージ↔再分岐の空白**: 生存セルを **carry-forward（マーカー無し列も仮生存）** で埋め、線が直線で跨ぐ。
  継ぎ目はセグメント非生成、スロット変化は短い斜めブリッジ。round-cap の食い込みは butt + 明示終端ノブで解消。

## データモデル

- **束ねレイアウトに新規永続テーブルは不要**（毎描画導出）。スナップショット/Undo/XPROJ/CASCADE は不変。
- **追加（始端/終端の明示指定用・加算 nullable）**:
  `plot_threads.start_node_id TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL`、
  `plot_threads.end_node_id  TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL`。
  `add_column_if_missing` で migrate.rs / schema.ts ミラー。NULL=最初/最後のマーカーから導出（挙動不変）。
  生存スパン = `[start ?? firstMarkerX, end ?? terminus/lastMarkerX]`。SET NULL なのでシーン削除で override は解除（スレッドは消えない）。
  → スナップショット: plot_threads は A1 で既に raw-row 捕捉/復元するため、列追加は自動追従（SELECT *／buildInsert は列非依存）。
- **任意・分離可（推奨）**: branch 重複の DB 不変条件化
  `CREATE UNIQUE INDEX IF NOT EXISTS plot_thread_branches_coord_uq ON plot_thread_branches(from_thread_id,to_thread_id,at_node_id,kind);`
  （SQLite は ALTER ADD CONSTRAINT 不可→UNIQUE INDEX。既存行は JS dedup 済で適合。dedup DELETE→CREATE 順厳守）。
- **見送り（不要・要望が出たら加算）**: `plot_thread_bundles`（任意手動グループ。今回は「エッジ+共起で十分」決定で不要）、
  `anchor_link_id`（座標識別の多 phase 曖昧性解消。JS カスケードで #4 は機能的に解決済のため後回し）。

## 決定性（構造的に強制）

乱数/Date.now 禁止（この環境では throw）。初期順 = `(sortOrder,id)`。固定 8 パス（収束待ちにしない）。
加重メディアン。best-snapshot を argmin（最早パス優先）。全比較子に `(sortOrder→id)` 最終タイブレーク。
Map/Set 反復順に **順序判断を一切依存させない**。→ 同一入力で再描画/別マシンでも byte 一致。
**安定性（≠決定性）**: 1 マーカー編集での再配置を最小化（最小移動圧縮）。専用の安定性テストで別途検証（決定性ゲートだけでは不足）。

## DnD（必須移行・同 PR）

`resolveMarkerDrop`/`commitMarkerDrop` の branch/merge 方向判定を、**ドロップ列のライブスロット順**で行う
（固定 sortOrder の上下ではなく、再配置後の実 Y 上下）。テストもライブスロットに対して書き直す。
さもないと「テスト緑・アプリで方向反転」になる地雷。

## テスト戦略

- 純関数（最優先）: 決定性ゲート（同入力→同出力）／交差非増加ゲート／carry-forward(#7)／merge 着地(#5)／
  junction 隣接／セッション導出（エッジ＋連続共起 ≥3）／始端終端 override の生存スパン／安定性（1編集の最小移動）。
- 幾何 invariant（`*.browser.test.tsx`・CI gate）: 帯整列／コネクタ端点 = スロット Y／scenes 行との x 整列／束ね帯。
  ※サンドボックスは Chromium 未導入で browser test ローカル不可 → CI gate 前提。
- DnD: 方向判定がライブスロット順であること。

## MVP の刻み（最小で「束ね並走」を出す）

1. `buildPlotLaneModel` 本体を 5 段パイプラインに置換（PREP→セッション化〔エッジ＋連続共起≥3〕→8パスメディアン順序＋best-snapshot→簡易直線化→最小移動スロット→Y）。
2. 出力契約変更（上記）。`convergences`/`scheduledCount`/terminus 維持。
3. 束ね帯は collapsed 描画（メンバーは帯スロット共有・従来の太線）。
4. 描画: 端点 Y 別セグメント（水平＋斜めブリッジ）／コネクタはランク Y／マーカー `marker.y`／ラベル押し下げ。chip→circle 縮退は流用。
5. DnD 方向をライブスロット順へ移行。
6. テスト書き直し＋上記新規ゲート＋browser test。
7. reading-order 限定。UNIQUE 索引 DDL は同 PR でも別 PR でも可。

**MVP で見送り（加算・非ブロック）**: 帯内サブレーン fan-out（BUNDLE_GAP＋ズーム縮退）、junction ハード隣接制約（MVP は soft cohesion＋長ランプ fallback）、
full Brandes-Köpf/明示 wiggle エネルギー項、prior-order からの安定化シード、ラベルを各初出列に固定、`plot_thread_bundles`、`anchor_link_id`、
per-project 束ね閾値設定。

## 工数・リスク

- 規模: **中**。主: `plotThreadLaneModel.ts` 全面書換(~200-300行)＋テスト書換、`TimelineViewport.tsx` 約8描画箇所、
  `plotThreadDnd.ts`（ライブスロット移行・必須）、新 browser test、任意 migrate.rs/schema.ts（UNIQUE索引・自明）。Rust コマンド変更なし。
- リスク順: ①メディアン順序の正しさ＋決定性/交差非増加/安定性ゲートを全緑にする（本丸）②DnD 方向の沈黙反転③junction 非隣接の長ランプ（既知の軽い不格好）④browser test の CI 赤地雷（tauri mock export 罠）⑤対話的安定性は決定性と別途検証。
- StoryFlow に対し受容する不格好: wiggle 多め（簡易直線化）／merge が無い作では高さ削減が出ない（束ね前提）／時折非隣接 junction ランプ。交差最小化は NP 困難＝ヒューリスティック局所最適。

## 非対象（将来）

- story-time での線描画（恒久非対象）。レーン経路最適化の ILP 化。手動グループテーブル。anchor_link_id による座標識別曖昧性の根治。
