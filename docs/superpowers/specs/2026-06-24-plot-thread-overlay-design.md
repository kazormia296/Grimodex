# プロットスレッド オーバーレイ化 + 線描画（収束・分岐）設計書

- 日付: 2026-06-24
- 対象: Timeline パネルのプロットスレッド機能（`threads` ビューモード）
- 関連: [Grimodex_Timelineパネル設計書](../../Grimodex_Timelineパネル設計書.md)「プロットスレッド表示」節、PR #168（初版）

## 背景・動機

現状のプロットスレッドは以下の課題がある（ユーザー指摘 2026-06-24）:

1. **シーンの目盛りが無い** — `threads` モードはレーン（ドット）だけ描き、シーン列を貫く縦グリッド/ティックが無い。マーカーがどのシーンに紐づくか目で追えない（`TimelineViewport.tsx:654`）。
2. **収束・分岐が表現できない** — スレッドは独立した横レーンで、特定シーンへの収束や別スレッドへの分岐という構造を持てない。
3. **色分け UI が無い** — `plot_threads.color` は存在し描画にも使われる（`fill={lane.thread.color ?? "var(--primary)"}`）が、色を設定する UI が無く実質すべて同色。
4. **別モードではなくオーバーレイであるべき** — x 軸（シーン列）は scenes/threads 両モードで共通、マーカーはシーン拘束なのに、トグルで別ビューに割っているため「同じ土台の上にいる」ことが隠れている。
5. **スレッドは reading-order 依存** — プロットスレッドはナラティブ装置で、reading-order でこそ素直に読める。

## 確定した設計判断（ブレスト 2026-06-24）

| # | 判断 |
|---|------|
| スコープ | フル（Phase 1+2+3、線描画で収束・分岐まで） |
| (a) 線の範囲 | スレッド線＝**最初のマーカー〜最後のマーカー**。独立した開始/終了シーンは持たせない |
| (b) 分岐/合流 | **新テーブルで明示**（視覚的収束に加え、意味的な親子/合流を持つ） |
| (c) コネクタ描画 | **レーン固定＋列内の橋渡し**（git グラフ風のレーン再配置はしない） |
| (d) モードトグル | 廃止し「**スレッド表示 ON/OFF**」のオーバーレイに置換 |
| (e) 軸切替時 | **線・分岐は reading-order 専用 / マーカーは全軸**。story-time / write では線・コネクタを引かずマーカーのみ（未配置シーンは Unscheduled ゾーン） |

## 概念モデル

**「シーン＝列、スレッド＝その列を縫って走る色付きの線」** という路線図 / git グラフ型。

```
        S1   S2   S3   S4   S5   S6        ← シーン列（縦グリッド＋ティック / reading-order 既定）
  ─────┼────┼────┼────┼────┼────┼─────
シーン行 ●    ●    ●    ●    ●    ●         ← 既存 scenes 行（選択/プレビュー/ドラッグ不変）
  ─────┼────┼────┼────┼────┼────┼─────
復讐 ●━━━━━●━━━━━━━━━━━●                   ← スレッド = 色付き線。● = 段階マーカー
            ╲
恋愛         ●━━━━━●━━━╱━━━●               ← S3 で復讐→恋愛へ分岐
                        ╲
陰謀    ●━━━━━━━━━━●━━━━╱                  ← S5 で陰謀→恋愛へ合流
```

## レンダリングモデル

### シーン列の可視化（Phase 1）

- 全レーンを縦に貫く**グリッドライン**（淡い縦線）と**ティック/ラベル**を描く。
- ラベルは既存 `computeAxisLabels(scenes, axisMode, zoom)` を流用し、ズームに応じて間引く。
- マーカー/ドットへのホバーで該当シーン名を出す（既存 `<title>` 拡張）。
- 既存の `xOf(index)` 座標系をそのまま使う（座標系変更なし）。

### スレッド線（Phase 3, reading-order のみ）

- スレッド線 = そのスレッドの**マーカーのうち最小 x 〜 最大 x** を結ぶポリライン（判断 a）。
- 線の色 = `thread.color ?? var(--primary)`。線上に段階マーカー ● を重ねる。
- reading-order 以外（story-time / write）では**線を引かずマーカーのみ**（判断 e）。

### 収束（視覚・新データ不要）

- 複数スレッドが同じシーン列にマーカーを持つと、その列で ● が縦に揃う＝自然に集まって見える。
- 追加で「**2 本以上が通る列を淡くハイライト**」する縦バンドを描く（収束の視認性向上）。

### 分岐 / 合流（Phase 3, 新データ + コネクタ）

- 新テーブル `plot_thread_branches`（後述）の各エッジを、`at_node_id` のシーン列で**2 レーン間を短い曲線コネクタ**で繋ぐ。
- **レーンは sort_order 固定**のまま、列内でレーン間を橋渡しするだけ（判断 c）。git グラフのレーン再割り当て・経路最適化はやらない（複雑さ回避）。
- `kind = 'branch'`: `from_thread` から `to_thread` へ枝分かれ（`to_thread` がそのシーンから始まる構図）。
- `kind = 'merge'`: `from_thread` が `to_thread` へ収束（`from_thread` がそのシーンで終わる構図）。
- reading-order のみ描画（判断 e）。

## データモデル変更

### 新テーブル `plot_thread_branches`

```
plot_thread_branches(
  id              TEXT PK,
  project_id      TEXT NOT NULL → projects(id) ON DELETE CASCADE,  -- XPROJ ガード用に非正規化保持
  from_thread_id  TEXT NOT NULL → plot_threads(id) ON DELETE CASCADE,
  to_thread_id    TEXT NOT NULL → plot_threads(id) ON DELETE CASCADE,
  at_node_id      TEXT NOT NULL → tree_nodes(id) ON DELETE CASCADE,  -- 分岐/合流が起きるシーン
  kind            TEXT NOT NULL,  -- 'branch' | 'merge'（CHECK は SQL 側）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
)
index idx_plot_thread_branches_project (project_id)
index idx_plot_thread_branches_from    (from_thread_id)
index idx_plot_thread_branches_to      (to_thread_id)
```

- `project_id` を非正規化保持するのは、既存 `chat_message_chunks` / post-effect の XPROJ ガード方針に合わせるため（by-id 操作を project スコープで検証可能にする）。
- `from`/`to` どちらかのスレッド、または `at` シーンが消えれば cascade で自動削除（孤児防止）。
- 色は `from_thread` 側を採用（コネクタ＝分岐元の色）。

### `color` 編集 UI（Phase 1・実装済み）

- パレットは **Codex タイプと同じ**（ユーザー決定 2026-06-24）。`activeCodexPaletteSlots(colorTheme, isDark)`（`resolveCodexColors.ts` に追加）でアクティブテーマ×モードの `PaletteSlot[]`（全 `PALETTE_SIZE` 個）を取得し、`PlotMarkerInspector` のスレッド編集部にスウォッチ＋クリアとして表示。
- 選択時はスロットの `fg`（彩度のある前景色）を **hex として既存 `plot_threads.color` に保存**（`setThreadColor(id, fg|null)`）。スキーマ変更なし・描画（`fill={thread.color ?? var(--primary)}`）も既存流用。
- `isDark` は `document.documentElement.classList`（App.tsx と同じ）で判定（`matchMedia` 非依存でテスト安全）。
- **保留**: 完全なテーマ追従（テーマ切替でスレッド色も再解決）は Codex タイプのように `palette_index` を持たせる必要があり、Phase 3 のスキーマ作業に折り込む候補。Phase 1 は hex スナップショット（テーマ切替で色は固定）。

## 軸切替時の挙動（判断 e の詳細）

| 軸 | マーカー | 線 | 分岐/合流コネクタ | 収束ハイライト |
|----|---------|----|------------------|---------------|
| reading-order | 表示 | 表示 | 表示 | 表示 |
| story-time | 表示（未配置は Unscheduled ゾーン） | 非表示 | 非表示 | 表示（任意） |
| write-order | 表示 | 非表示 | 非表示 | 表示（任意） |

- reading-order 以外では、線が意味を失い（作者が時系列を崩す）かつ未配置シーンが時系列上に置けないため、**線・コネクタを抑止**してマーカーのみにする。
- story-time / write 時は「線表示は reading-order のみ」と小さく注記する。

## シーンドラッグ時のスレッド追従

シーンのドラッグ移動は **story-time モードの `story_time_order` 編集のみ**（reading-order の並び順は Scenes ツリー側で変更し、データ変更で線は再導出されるため in-drag 追従は不要）。よって追従を考えるのは story-time、対象は**マーカー（●）のみ**（判断 e により story-time では線・コネクタを描かない）。

現状の課題: マーカー x は `xOf(sceneX.get(nodeId))`（**確定**インデックス）で算出されるため、ドラッグ中はシーンドット（`drag.currentX` で楽観移動）だけ動き、そのシーンに紐づくスレッドマーカーが付いてこず、確定後に飛ぶ。

対応:

- **ドラッグ中（楽観）**: ドラッグ中のシーン `nodeId` に紐づく**全レーンのマーカー**を、シーンドットと同じ楽観オフセットでずらして一緒に動かす（`drag?.nodeId === mk.nodeId ? xOf(mk.x) + dragDeltaX : xOf(mk.x)`）。`TimelineViewport` の既存 `drag` state を参照するだけ。
- **確定後（onPointerUp）**: committed な `story_time_order` → `sceneX` 再導出でマーカー位置が整合（特別処理不要）。
- **Unscheduled への移動**（`AXIS_LOCK_THRESHOLD` 跨ぎ）: 確定後そのシーンの `story_time_order=null` により、マーカーは Unscheduled ゾーン列へ移動する。lane model / 描画が**未配置シーンのマーカー配置**（ゾーン側の x）を扱う必要がある（判断 e の未配置処理と同根）。
- **reading-order**: そもそも timeline 上でのシーンドラッグが無いので、線の in-drag 追従は発生しない（データ変更時に線が再導出されるのみ）。

## ライブラリ判断（描画）

**結論: 追加ライブラリは入れない（hand-rolled SVG を継続）。**

- 描画プリミティブ（線 = `<path>`、分岐/合流コネクタ = cubic bezier の `<path>`、収束バンド = `<rect>`、ティック = `<line>`/`<text>`）は素の SVG で各数行。**複雑さは「描画」ではなく「レイアウト計算」**（シーン拘束 x ＋ 固定レーン ＋ reading-order 限定線 ＋ 収束/分岐判定）にあり、これはドメイン固有なので純関数 `buildPlotLaneModel` に集約するのが最善。汎用ライブラリでは表現できない。
- `react-flow`(@xyflow) / `vis-timeline` 等のグラフ・タイムライン lib は **x をシーン列に固定できない**（自由ノード配置前提）うえ、独自のパン/ズーム/キャンバスが既存の `xOf`/スクロール/ドラッグと競合し、バンドルも重い → **不適合**。
- `d3-shape`（曲線パス生成）のみ候補だが、必要な曲線は bezier 1 行程度。設計書本体 L813「`react-zoom-pan-pinch` は過剰」の既定方針と既存 hand-rolled 路線に合わせ、**既定は自前**。コネクタ曲線の見栄えが詰まった場合のみ、`d3-shape` の path 生成（tree-shake 可）採用を後追い検討。
- 規模: 小説スケール（数十〜数百シーン × 数スレッド × 数マーカー）では SVG 要素数は問題なし。仮想化は不要。

## UI / 操作

- ヘッダーの `[シーン | スレッド]` トグルを廃止 → 「**スレッド表示**」ON/OFF（`showThreads` 的フラグ）に置換（判断 d）。store の `viewMode` 廃止に伴い `validateLayoutState` / 永続化スキーマの移行に注意。
- スレッド ON 時のみ「+ スレッドを追加」ボタンを表示（現行踏襲）。
- マーカー作成: 現行どおりレーン背景クリックで最寄りシーンに `develop` マーカー追加。
- 分岐/合流作成: スレッド端マーカー選択時にインスペクタから「[thread] へ分岐 / [thread] へ合流」を選ぶ（最小 UI）。
- 色設定: インスペクタのスレッド編集部の色ピッカー。
- 縦の高さ対策: シーン行＋スレッド領域を縦積み。スレッド多数時はスレッド領域をスクロール（既存 overflow 対応流用）＋スレッド畳み。

## 出荷の刻み（各 Phase 単体で常時 green / shippable）

- **Phase 1（実装済み）**: シーン縦グリッド（`scene-gridline`）＋ Codex パレット色ピッカー。データ変更なし。
- **Phase 2（実装済み）**: scenes/threads の**オーバーレイ統合**。`viewMode`→`showThreads`（後方互換 `loadFromSettings`）、シーン行常時＋レーンは `laneTop=threadsTop` で下にオーバーレイ、インスペクタは選択ベースのルーティング。
- **Phase 3（実装済み）**: スレッド**線描画**（`plot-thread-line-*`, reading-order・markers>=2）＋収束ハイライト（`thread-convergence`）＋**分岐/合流**（新テーブル `plot_thread_branches`＝migrate.rs の冪等 init に追加・**専用 Rust コマンドは作らず db_execute 経由 Drizzle で CRUD**＋`PlotConnector`＋`PlotBranchEditor`、コネクタは reading-order のみ）。

> 検証: tsc / JS 152 tests / Rust(plot_thread 6 tests + clippy -D warnings) / eslint 0 errors すべて green。ブラウザ幾何テストと実機 GUI は CI / 実機 QA 待ち（サンドボックス実行不可）。

## 影響範囲（ファイル）

- スキーマ/移行: `src/db/schema.ts`（新テーブル）、Rust migrations。
- Rust: `plot_thread_branch_{create,update,delete,list}` コマンド（既存 `plot_thread_link_*` をミラー、`/add-tauri-command` 手順）。
- JS データ層: `src/features/plot-threads/api.ts`（invoke + Drizzle フォールバック + `normalizeBranch`）、`plotThreadStore.ts`。
- 描画モデル: `src/features/plot-threads/plotThreadLaneModel.ts`（マーカー集合 → 線ポリライン + ブランチエッジへ拡張、純関数のまま単体 test gate）。
- ビューポート: `src/features/timeline/TimelineViewport.tsx`（グリッド/ティック、線、コネクタ、収束バンド、reading-order 限定描画）。
- パネル/ヘッダー: `TimelinePanel.tsx`, `TimelineHeader.tsx`（モード→オーバーレイ ON/OFF）。
- store: `timelineStore.ts`（`viewMode` → `showThreads` 移行）。
- インスペクタ: `PlotMarkerInspector.tsx`（色ピッカー、分岐/合流編集）。
- i18n: ja/en に新キー。

## テスト戦略

- **純関数（最優先・happy-dom 不要）**: `buildPlotLaneModel` を線ポリライン + ブランチエッジ生成へ拡張し、単体 test で gate（SVG 明示座標のため幾何は決定的）。収束判定（同一シーン列に複数スレッド）、線範囲（最小〜最大 x）、reading-order 限定描画フラグなどを純関数で固める。
- **幾何 invariant（browser test）**: グリッドラインとシーン列の整列、線がマーカーを通る、コネクタが 2 レーン間を繋ぐ等を `*.browser.test.tsx` で gate（CLAUDE.md レイアウト方針）。**注意: 本サンドボックスは Chromium 未導入 + egress ブロックで browser test はローカル実行不可 → CI gate 前提**。
- **データ層**: 新コマンドの XPROJ スコープ（by-id 操作が project を跨がない）を test。Rust test は `--no-default-features`。
- **軸切替**: reading では線あり / story では線なし・マーカーあり、を happy-dom か純関数フラグで gate。
- **ドラッグ追従**: ドラッグオフセット適用後のマーカー x を純関数ヘルパに切り出して unit test（`drag.nodeId` のマーカーのみオフセットが乗る／他は不変）。Unscheduled へ移動後のマーカー配置も lane model の test で gate。

## リスク・留意

- **`viewMode` 廃止の移行**（Phase 2）: 永続化レイアウト・`validateLayoutState`・既存 test が `viewMode` を参照。後方互換（旧 `viewMode==="threads"` を `showThreads=true` に読み替え）を用意。
- **コネクタの視覚的衝突**: レーン固定方針のため、離れたレーン間のコネクタが他レーンを横切る。淡色・曲線・z 順で緩和。完全な経路最適化はやらない（YAGNI）。
- **縦スペース**: スレッド多数時の高さ。スクロール＋畳みで対応。
- **新 provider/新テーブル横断**: 検索・エクスポート・整合チェック等への波及は本スコープ外（マーカーは既存どおり）。

## 敵対的レビュー結果（2026-06-24・多エージェント）

確定 10 件（critical 0 / important 3 / minor 7）。**8 件を修正、2 件をフォローアップに繰り延べ。**

修正済み:
- **(important) story-time レーンクリックの誤シーン紐づけ**: `nearestSceneIndex` を scheduled 範囲に限定。未配置シーンの `xOf` が scheduled 列へ折り重なる衝突を、lane model に `scheduledCount` を渡して未配置マーカー/収束/コネクタを除外＋グリッドも scheduled のみに。
- **(important) PlotBranchEditor の stale targetId / 自己参照**: `key={thread:atNode}` で選択替え時に remount＋onClick で `from===to` と重複(from,to,atNode,kind)を弾く。
- **(minor) スレッド非表示時にプロット用インスペクタが残る**: ルーティングを `showThreads && (plotLink||plotThread)` にゲート。
- **(minor) プロジェクト切替で timeline 選択が残留**: `reloadProjectData` で `useTimelineStore.clearSelection()`。
- **(minor) レーンヒット矩形がシーン領域へ 20px 食い込む**: `threadsTop` のギャップを `LANE_HEIGHT/2` に。
- **(minor) branch CRUD/normalizeBranch 未検証**: `normalizeBranch` の単体 test 追加。
- 収束/マーカー/コネクタの未配置除外は lane model 単体 test で gate。

**繰り延べ（フォローアップ）:**
- **(important) スナップショット復元(body スコープ)でプロットのマーカー/分岐が CASCADE 消失**: `plot_thread_scene_links` は **PR#168 からの既存欠陥**で、`plot_thread_branches` も同じ消失面に乗る（`tree_nodes` 削除→CASCADE、かつ snapshot scope 未登録で再挿入されない）。本質的には `projectSnapshotScopes.ts` に plot 系 3 テーブルを aux scope として登録し、wipe 不変条件（capture 集合＝restore wipe 集合）と FK 順序を満たす必要がある。**復元という destructive 操作（実行前に置換警告あり）かつ plot 使用時のみ**で、復元経路を実機検証できない本環境で盲改修すると復元破損リスクが上回るため別 PR に分離。既存 scene_links の損失も同時に解消する。
- **(minor) marker/thread 系アクションの stale ガード非対称**: `addMarker`/`updateMarker`/`deleteMarker`/`renameThread`/`setThreadColor`/`deleteThread` に project 切替ガードが無い（`load`/`addThread`/`addBranch` にはある）。**PR#168 からの既存パターン**でシグネチャ変更を要するため繰り延べ。

## Phase 4: マーカー操作の拡充（2026-06-24・ユーザー要望）

1. **ダブルクリックで追加** — レーン背景の `onClick`→`onDoubleClick`。最寄り scheduled シーンにマーカー追加（シングルクリックは選択のみ）。
2. **マーカーの DnD（ドロップ先で自動判定・ユーザー決定）** — マーカーを掴んでドラッグし、ドロップ先で動作を決める:
   - 同レーン内 → 最寄りシーンへ**移動**（`nodeId` 変更）。
   - 別レーンの空き → その**スレッドへ移動**（`threadId` 変更＋最寄りシーン）。
   - 別レーンの既存マーカー上 → **分岐/合流エッジ作成**（下のレーンへ=branch / 上のレーンへ=merge、at=対象マーカーのシーン）。
   - drop 解決は純関数 `resolveMarkerDrop`（`plotThreadDnd.ts`）に切り出し単体 test。クリック/ドラッグは移動量しきい値で判別（小=選択, 大=ドラッグ）。
   - `updatePlotThreadLink`/`updateMarker` に **`threadId`** を更新可能フィールドとして追加（スレッド間移動用）。
3. **スレッド追加時の自動カラー** — `activeCodexPaletteSlots()` の `threads.length % PALETTE_SIZE` 番目の `fg` を順番に付与（ヘッダーが解決し `addThread(projectId, name, color)` に渡す）。
4. **マーカーのコンテキストメニュー** — 右クリックで `PlotMarkerContextMenu`（既存 `TimelineContextMenu` と同じ portal パターン）: 段階変更／メモ編集（選択＋インスペクタ）／マーカー削除。

判断: DnD は「ドロップ先で自動判定」（接続ハンドル/修飾キー無し）。既存のシーン story-time ドラッグ(`drag`/`commitDrop`)とは別系統の `markerDrag` を新設し衝突させない。

### Phase 4 敵対的レビュー（2026-06-24）

確定 9 件（critical 0 / important 1 / minor 8）。**7 件修正・2 件繰り延べ。**

修正済み:
- **(important) scheduledCount===0（story-time で全シーン未配置）の不可視オーフェン**: `nearestSceneIndex` を −1（該当なし）返しにし、ダブルクリック追加・ドロップ移動の双方で scene 未解決ならバイパス。
- **(minor) StrictMode 二重発火**: `onUp` で `commitMarkerDrop` を setState updater の外で実行（scene drag と同型）。重複 `addBranch`/`updateMarker` 防止。
- **(minor×3) DnD branch の dedup / 自己参照 / XPROJ**: `store.addBranch` に集約（`from===to` 弾き・現在ロード中スレッドのみ許可・`(from,to,atNode,kind)` 重複弾き）。DnD/手動の両経路を一括防御。branch は Rust コマンド非経由のため store が不変条件の番人。
- **(minor) ダブルクリックの発見性**: レーンヒット矩形に `<title>`（`plotThread.laneHint`）。

繰り延べ:
- **(minor) move でマーカーを移すと旧シーンの branch が残る**: branch はシーン拘束エンティティ（by design）。マーカーが去ると当該シーンに marker が無く `PlotBranchEditor` から編集不可になる UX 制約のみ。コネクタ右クリック削除等は別途。
- **(minor) 自動色の hex 凍結（テーマ非追従）**: Codex タイプ(`palette_index` 再解決)との非対称だが、スレッド色はスナップショットで十分という Phase 1 判断を踏襲（spec 既述）。

## Phase 5: 選択マーカー / 縦スクロール / 両点branch DnD / 太いバンド+段階チップ（2026-06-24）

1. **選択中マーカー** — `selectedPlotLinkId === linkId` のチップに選択リング（`var(--foreground)`）。シーンの選択マーカーと同趣旨。
2. **スレッドエリア縦スクロール** — スクロールコンテナを `overflow-y-auto` に（スレッド多数でも縦スクロール）。
3. **別スレッドへドロップ = 両スレッドに点＋分岐/合流** — `resolveMarkerDrop` を「同レーン=move-scene / 別レーン=branch（at=最寄り scheduled シーン, 下=branch/上=merge）」に簡素化（move-thread 廃止）。`commitMarkerDrop` の branch は ①source を atNode へ移動 ②target に点が無ければ作成（phase は source 踏襲）③`addBranch`。
4. **太いバンド＋段階チップ** — スレッド線を `BAND_HEIGHT=20`/opacity0.45 のバンド化。マーカーを円→チップ（`g>rect+text`、段階ラベルを内側表示）。文字色は背景輝度から `contrastTextColor` で出し分け。

### Phase 5 敵対的レビュー（2026-06-24）

確定 5 件（critical 0 / important 2 / minor 3）。**3 件修正・2 件繰り延べ。**

修正済み:
- **(important) 両点branch の非アトミック性** — 既存と同一エッジになるドロップは `commitMarkerDrop` 冒頭の dup チェックで丸ごとスキップ（source だけ黙って動く不整合を防止）。
- **(important) チップ段階テキストのコントラスト崩壊** — `#fff` 固定をやめ `contrastTextColor(背景)` で濃/白を出し分け（ダークテーマの明色スレッドでも可読）。
- **(minor) addMarker/updateMarker/deleteMarker の XPROJ stale ガード欠落** — 3 メソッドに `getCurrentProjectId()` ガードを追加（DnD で増えた addMarker 経路の混入防止）。

繰り延べ:
- **(minor) 同一(thread,scene) の重複リンク** — 1スレッド×1シーンに複数段階を置けるのは**既存仕様**（チップ重なりは double-click でも従来発生）。データ違反ではないため据え置き。
- **(minor) マウスホイール縦回転がズームに奪われ縦ホイールスクロール不可** — ホイール=ズームは**前段でのユーザー明示決定**。縦スクロールはスクロールバーで提供。両立のためホイール挙動は変えない（必要ならホイール割当の再検討を別途）。

## Phase 6: チップ縮退 / 線セグメント化（並列＋連続性モデル確定・2026-06-24）

1. **段階チップの縮退** — `STEP(=STEP_BASE*zoom) >= CHIP_MIN_STEP(72)` のとき段階テキストのチップ、未満では円に縮退（ラベルは title ツールチップ）。拡大時のみテキスト表示。
2. **連続性モデルの確定（#3 相談の結論）** — スレッドは**統合せず並列のまま**（現状どおり）。branch/merge は**継続性の表現として維持**。スレッド線は単一スパンをやめ**連続セグメント**化（`PlotLane.lineSegments`）:
   - 隣接マーカー i→i+1 の線は「i が merge 点」または「i+1 が branch 点」なら引かない。
   - → B が A に合流→再度分岐したとき、合流点と分岐点が線で繋がらず gap になる（#2 解消）。
   - **並走 / branch せず特定シーンで完了**は本モデルで自然に表現: 並列レーン＋線は最初〜最後のビートまで（最後のビート＝完了。merge/branch が無ければ全ビート1本連結）。
   - merge = 線がそこで終わる / branch = 線がそこから始まる、という継ぎ目の意味づけ。
3. **終端キャップ（完結マーカー）** — 自走で終わるスレッド（最後のビートが merge でない）の線端に塗りノブ（`PlotLane.terminusX`、`r=BAND_HEIGHT/2`、reading-order のみ）。merge で畳まれた終端には付けず（コネクタで表現）、単独マーカー/線なしは null。「並走して特定シーンで完結」を視覚的に明示。

## Phase 7: branch/merge は片側のみマーカー（2026-06-24・相談の結論）

Phase 5 の「両スレッドに点を打つ」を見直し、**構造的に意味のある側だけにマーカー**を置く（ユーザー相談で対称ルールに決定）:
- **branch（下へドロップ）**: 先(to)に起点マーカー。元(from=親トランク)には作らない。ドラッグした点を **先スレッドへ移動**（`updateMarker({threadId:to, nodeId})`）。
- **merge（上へドロップ）**: 元(from=畳まれる側)に終端マーカー。先(to=畳まれ先)には作らない。ドラッグした点は **元に残す**（`updateMarker({nodeId})`）。
- いずれも `addMarker`（第2の点）は呼ばない。コネクタが両レーン間の関係を表現するので、もう片方の点は不要。
- lane model の branchIn(on to)/mergeOut(on from) 方向と一致し、線セグメント/終端キャップの意味づけ（branch=線が始まる/merge=線が終わる）とも整合。

> 既知（minor・by-design）: branch で先(to)が既にそのシーンに点を持つ場合、移動で同一(thread,scene)の点が2つになりうる。これは「1スレッド×1シーンに複数 phase 可」の既存許容（move-scene も同様）と同種で、収束カウントは thread 単位で1回・データ破損なし。今は据え置き。

## Phase 8: subway ランプコネクタ ＋ エッジのドラッグ追従/付け替え（2026-06-24）

1. **subway 風ランプコネクタ（#1・ランプ方式採用）** — merge/branch のコネクタを短い縦ブリッジから**斜めのランプ**へ。branch=親レーンから子レーンへ枝分かれ、merge=畳まれる線が対象レーンへ合流（`CONNECTOR_RAMP`）。レーンは固定・ラベルそのまま・マーカー衝突なし。フル動的レーン共有は、合流後ビート無しで見た目はランプと同等＋ラベル衝突/行非固定の副作用があるため不採用（相談で決定）。
2. **エッジのドラッグ追従/付け替え（#2）** — branch/merge の**構造側マーカー**（branch=to / merge=from、at=そのシーン）をドラッグすると、その点が持つエッジが追従:
   - 同レーン内移動 → エッジの `at_node` を新シーンへ（`updateBranch`）。
   - 別スレッドへドロップ → エッジの構造側（branch=to / merge=from）を新スレッドへ**付け替え**＋`at_node` 追従（マーカーも移動）。新規エッジは作らない。付け替えが自己参照になる場合はエッジ削除。
   - `updatePlotThreadBranch`（Drizzle・Rust 不要）＋ store `updateBranch` を追加。`markerDrag` に `nodeId` を保持してアンカー判定。
   - 既にエッジを持たないマーカーの別スレッドドロップは従来どおり新規 branch/merge 作成。

### Phase 8 敵対的レビュー（2026-06-24）

- **(important・修正済) アンカー追従/付け替えが重複エッジを生む** — `commitMarkerDrop` のアンカー rebind 経路が、`addBranch`/非アンカー新規経路と違って `(from,to,at,kind)` の重複チェックを迂回していた。例: `A→B@s1` と `A→B@s2` が併存し、B レーンの s1 アンカーを s2 へドラッグすると `A→B@s2` が重複。`plot_thread_branches` に UNIQUE が無いため重複行が永続化し、同一コネクタが二重描画される。**修正**: rebind 前に付け替え後タプルが他エッジと一致するか検査し、一致（or 自己参照）なら rebind せずエッジを削除（自己参照削除と同方針）。回帰テスト追加（`TimelineViewport.test.tsx`「付け替えで既存エッジと重複するなら rebind せず削除する」）。
- **(minor・据え置き by-design) 同一(thread,scene)に複数 phase マーカーがあるとアンカー追従で取り残し** — エッジは特定マーカー(linkId)ではなく `(from,to,at,kind)` 座標で識別される（schema 上 marker を指す列が無い）。同一シーンに introduce＋develop の2点があり片方をドラッグすると、その点とエッジは追従するが他方は残り、どの点がアンカーか曖昧になる。「1スレッド×1シーンに複数 phase 可」の既存許容（Phase 5 の minor と同種）に由来。クラッシュ/データ破損なし。エッジを座標識別から marker 識別へ移すのは schema 変更を伴うため将来課題。

## 非対象（将来拡張）

- インスペクタの Characters / Location 行、`index #N/M`、`Open in Editor` ボタン、Status ドロップダウン編集、ポップオーバー化（既存設計書の未実装項目のまま）。
- スレッドの自動レイアウト最適化（レーン再割り当て）。
- story-time での線描画（意味が薄く未配置問題があるため恒久的に非対象の想定）。
