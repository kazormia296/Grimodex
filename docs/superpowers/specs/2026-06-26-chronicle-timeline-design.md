# Chronicle（作中年表）ビュー 設計書

- 日付: 2026-06-26
- 状態: 設計確定（実装計画 待ち）
- 関連: Timeline（plot-thread overlay）, Codex entity, phase_resolution（reading/story/auto）, backlog「作中暦・時刻整合」

## 1. 背景・動機

現行 Timeline の「プロットスレッド」は **reading-order（語りの順 / syuzhet）** に基づくプロット上の through-line であり、**作中の時間経過（fabula）ではない**。回想・並行時系列・伏線のために、同じスレッドのシーンは作中時間では散らばる（confetti 化）。段階ラベル（introduce / develop / turn / climax / resolve）は語り順の劇作上の位置であり、作中時刻には意味を持たない。

そこで **作中時間（story-time）を表す別概念** を導入する。ただし設計上の核心判断として、これは **Scene-anchored にしない**。理由:

- **解像度**: 作中時間は scene 未満の粒度を要求する（1シーン＝三日、1シーンに複数の出来事）。
- **ミッシングリンク**: どのシーンも描かない出来事（オフページの戦争、20年前の出生、時間跳躍）は scene-anchored では原理的に表現不能。

→ 年表の atom は **Event（出来事）** という独立エンティティとし、scene は event を参照する（many-to-many、参照0＝オフページ）。これは Aeon Timeline / Plottr の timeline モードが採る形に一致する。

## 2. 確定した設計判断（前提・変更不可）

| 項目 | 決定 |
|---|---|
| atom | **Event（出来事）**。Scene-anchored ではない独立エンティティ。point / interval 両対応 |
| 時間モデル | **B「暦ライト」**: `ordinal`（必須・storyTimeOrder と同型 fractional-index）＋ 数値時刻 `time`（任意）＋ `project_calendar{daysPerYear, seasonBoundaries}`。`precision`(exact/approx/unknown) を第一級。フル暦エンジンは作らない |
| レーン主軸 | **人物**（Codex entity）。場所/勢力は後続。participants は多対多だがビュー既定は主レーン1本＋副参加は淡いタイ |
| scene↔event | **0..N 参照**（0＝オフページ＝中空マーカー）。既存 `scene.storyTimeOrder` とは **独立（非破壊）**。片方向の任意同期アクションのみ許容 |
| 先行整合チェック | **季節（冬に蝉）** 1本のみ: event 時刻→季節 vs シーン記述の矛盾 |
| 統合方式 | **独立 `chronicle` パネル新設（案B）**。Timeline の `xOf`/`sceneX`/`scenes` 座標契約には一切触れない |
| パネル配置 | center-bottom に Timeline と **別タブ同居・排他切替**。アイコン CalendarRange、ショートカット Ctrl+Alt+K |
| レイアウト移行 | **自動注入**（既存保存レイアウト/カスタムプリセットの BL slot へ `chronicle` を注入。配置保持・既定表示） |
| plot-thread | Timeline に温存（subway / 段階 / reading 順）。Chronicle には描かない（別概念） |

### 統合方式を案Bにした根拠（コード調査に基づく）

- `TimelineViewport.tsx` は2014行のモノリスで、`xOf(i)=padLeft+i*STEP` という **「scene index 駆動」の単一座標系** が SVG 全体を支配する。連続的な作中時刻軸ではない。
- レーン帯・コネクタ・終端・gap は `axisMode==='reading'` ハードゲート（TimelineViewport.tsx:1595/1626/1644/1664）。別軸では黙って点に縮退する。
- 単一 `xOf`/`sceneX`/`scenes` 支配のため、reading 順スレッドと作中時刻軸は **同一 SVG に共存不可**。
- 合意した Event モデル（非scene-anchored・連続 ordinal・オフページ参照0）は index 空間と **根本的に非互換**: index 空間にはオフページ event を置く座標が存在しない。
- 3レンズ採点（概念明瞭さ / 工学 / 拡張性）で **別パネル案が 8/8/8 全レンズ首位**。同一パネル内モード切替・既存キャンバス並べ替えは前提違反で失格。上下分割案は工学的に「別キャンバス必須」に収束する。

## 3. 概念モデル

- **Event**: 作中世界の離散的な出来事。`point`（end なし）or `interval`（start/end）。0..N シーンが描く（0＝オフページ）。0..N 人物が participate（主レーン1＋副参加）。
- **時間軸**: `ordinal`（常に存在・順序駆動）を主、`time`（数値・任意）で連続間隔と季節/年齢を解錠。`precision` で曖昧さを表現（exact＝実線、approx＝ぼかし帯、unknown＝括弧付き浮遊）。
- **レーン**: 人物 Codex entity。1人物＝1レーン。event は主 participant のレーンに実線で乗り、副 participant のレーンへは淡いタイで接続。
- **オフページ**: scene 参照0の event＝中空マーカー。「本文に無いが年表にはある」を表現。

## 4. データモデル（新規・Drizzle）

CRUD は `plot_thread_branches` 同様 **db_execute Drizzle 直書き**（新 Rust コマンド不要）。すべて net-new（既存 schema に event 系テーブルは無い）。`src/db/schema.ts` と `src-tauri` migrate.rs をミラー。

```text
events
  id                text  PK
  project_id        text  NOT NULL  FK projects(id) ON DELETE cascade
  title             text  NOT NULL  DEFAULT ''
  note              text
  ordinal           text  NOT NULL              -- fractional-index, cmpKeys 辞書順（storyTimeOrder と同型）
  primary_codex_id  text  FK codex_entries(id) ON DELETE set null   -- ホームレーン（人物）。null=未割当
  start_time        integer                     -- 暦ライト数値時刻（紀元からの日数）。null=ordinal のみ
  end_time          integer                     -- interval 終端。null=point
  precision         text  NOT NULL  DEFAULT 'exact'   -- 'exact'|'approx'|'unknown'（CHECK は SQL 側）
  created_at        text  NOT NULL
  updated_at        text  NOT NULL
  INDEX idx_events_project (project_id)
  INDEX idx_events_ordinal (project_id, ordinal)

event_participants
  event_id          text  NOT NULL  FK events(id) ON DELETE cascade
  codex_entry_id    text  NOT NULL  FK codex_entries(id) ON DELETE cascade
  role              text                        -- 任意（actor/mentioned 等）。null 可
  PK (event_id, codex_entry_id)
  INDEX idx_event_participants_codex (codex_entry_id)

scene_events                                    -- scene↔event 0..N 橋
  scene_id          text  NOT NULL  FK tree_nodes(id) ON DELETE cascade
  event_id          text  NOT NULL  FK events(id) ON DELETE cascade
  PK (scene_id, event_id)
  INDEX idx_scene_events_event (event_id)

project_calendar                                -- 1プロジェクト1暦（任意・未設定=季節チェック無効）
  project_id          text  PK  FK projects(id) ON DELETE cascade
  days_per_year       integer  NOT NULL  DEFAULT 360
  season_boundaries   text     NOT NULL          -- JSON: [{name, startDayOfYear}] 4季想定
  created_at          text  NOT NULL
  updated_at          text  NOT NULL
```

補足:
- `primary_codex_id` はホームレーンの決定性のため。participants には主も含める。
- 季節の算出: `season(time) = seasonBoundaries` のうち `(time mod days_per_year)` が属するレンジ。
- `tree_nodes.storyTimeLabel`（自由テキスト「帝国暦1000年」）は **表示専用に据え置き**。機械可読な時刻は `project_calendar` + `events.start_time` が担う。

## 5. 統合・配置・連動

### 5.1 パネル登録（6点セット + プリセット + 移行）

- `panelIds.ts`: ユニオンに `'chronicle'` 追加（現18→19）
- `panelComponents.tsx` `PANEL_COMPONENT_MAP`: `chronicle: ChroniclePanel`
- `panelRegions.ts` `PANEL_REGION_MAP`: `chronicle: 'center-bottom'`、`KEYBOARD_SHORTCUT_MAP`: Ctrl+Alt+K
- `panelIcons.ts` `PANEL_ICON_MAP`: `chronicle: CalendarRange`（Timeline の CalendarClock と区別）
- `toolWindowDefaults.ts` `DEFAULT_SLOT_MAP`: `chronicle: 'BL'`（→ `TOOL_WINDOW_PANEL_IDS` に自動波及）
- `layoutPresets.ts` `PRESET_DEFINITIONS`: **builtin 5プリセット全ての slots に `chronicle` を登録**（1つ漏れるとそのプリセットが invalid）
- **移行**: `ensureLayoutStateV3`（または v3→v3.1）で、`chronicle` を含まない既存保存レイアウト/カスタムプリセットの BL slot へ `chronicle` を **自動注入**（無いと load 時 `validateLayoutState` 失敗→builtin:default リセットで配置喪失）
- テスト波及: `layoutStore.test` / `layoutPresets.test` / `sanitizeUnknownPanel.test` / `layoutInvariants.browser`

### 5.2 軸の扱い（2つの異なる x 軸を物理分離）

- Timeline の x 軸 = reading-order scene index（`xOf=padLeft+i*STEP`）は **不変**。
- Chronicle の x 軸 = 作中時間の連続 ordinal を、新規純関数 `chronicleTimeScale(events, calendar, viewport)` で **ordinal→px へ直接連続射影**（index-step ではない。story proportional の `visibleForWidth*STEP*2` マジック式は流用せず greenfield で正しく書く）。
- `precision`: exact＝実線マーカー / approx＝ぼかし帯 / unknown＝括弧付き浮遊。

### 5.3 Timeline との連動（軸は混ぜない）

- **共有 selection**: Timeline で scene 選択 → Chronicle で参照 event をハイライト（逆も）。
- **片方向の任意アクションのみ**（既定オフ・undo 対応）: 「参照シーンの storyTimeOrder を event ordinal へ引く（pull）」「event ordinal を `scene.storyTimeOrder` へ刻む（stamp）」。既存 `treeStore.updateStoryTime` 経由。
- C 案（reading 順↔作中時間のタイ線可視化＝回想/伏線のズレ）は **Phase3 で B の上に opt-in 増築**。

## 6. 再利用する既存資産

- `computeSceneTimeIndex(nodes, mode)`（phaseResolver.ts）＋ `phaseStore.resolutionMode/globalSceneOrder` — reading/story/auto に相乗り（**新トグルを再発明しない**）
- `scene_codex_mentions` + `idx_scm_codex` — 1エンティティの全登場シーンを drizzle で逆引き（`PlotThreadCharacterArc.tsx` のロードパターンを反転）
- `threadCharacterArc.computeThreadCharacterArc` / `deriveCells.deriveCellMap` — 「糸の所属シーン集合」→「任意シーン集合」へ一般化して entity×scene 行列を再集約
- `cooccurrence.transposeToSceneSets` — 各時間スロットにどの entity が居るか
- `codex_types`(slug/label/color/icon/paletteIndex) + `useEnsureCodexTypeColors` — レーン色/アイコン/ラベル（人物判定は slug 文字列でなく **`isBuiltin`** で識別）
- `buildPlotLaneModel` / `computeThreadRuns` / `plotThreadOrder` — レーン合成の純関数（`sceneX` に時刻順 Map を注入すれば流用可）
- `timelineStore` の toState/fromSettings + `loadAndSyncTimelineSettings` 永続化パターン（`chronicleStore` に踏襲）
- `codex_entry_phases`(anchorNodeId 時点別状態) — レーン上の状態変化マーカー源（後段）

## 7. 新規コンポーネント

- `ChroniclePanel.tsx` — 外枠（TimelinePanel と同型。nodes/events/calendar を組んで Viewport へ注入）
- `ChronicleViewport.tsx` — event-native の新 SVG レンダラ。**200行規約順守** で `ChronicleAxis` / `EntityLane` / `EventMarker`(point/interval/中空) / `SeasonGutter` にサブ分割。**TimelineViewport の2014行モノリスは複製しない**
- `chronicleStore.ts` — Zustand（時間モード/zoom/scrollOffset/selection/precision 表示・global_settings 永続化）
- `chronicleTimeScale.ts` — ordinal→px 連続射影 + precision レンダリング規則の純関数（幾何 invariant の大半をここで happy-dom 単体 test 化）
- events API + schema（§4）
- `seasonCheck.ts` — 唯一の整合チェック（event 時刻→季節 vs シーン記述の矛盾）。純関数。既存 post-effect/検査サーフェスに結果表示
- `ChronicleInspector.tsx`（event 編集）／ AI 抽出ウィザード（後段・`importPlotThreads` パターン流用）

## 8. 季節整合チェック（先行 1 本）

- 入力: event の `start_time` と `project_calendar`、参照シーンの本文記述（季節語）。
- 判定: `season(start_time)` と本文から抽出した季節語が矛盾するなら警告。
- 抽出方式は実装計画で決める（候補: 季節語辞書マッチ / AI 抽出）。`project_calendar` 未設定時はチェック無効。
- 出力先: 既存の検査エンジン / post-effect サーフェスに相乗り（feature-idea-backlog「作中暦・時刻整合」の出口）。

## 9. 段階（フェーズ）

- **P0 基盤**: `events` / `event_participants` / `scene_events` / `project_calendar`（§4）。CRUD は Drizzle 直書き。net-new。
- **P1 MVP**: `chronicle` パネル新設（6点登録 + 既存レイアウト自動注入移行）。人物主軸レーン。連続 ordinal 軸（`chronicleTimeScale`）+ precision 表示。point/interval。オフページ中空マーカー。手動 event CRUD + Inspector。phaseStore の reading/story/auto に相乗り。
- **P2 整合チェック1本**: 季節（`seasonCheck.ts`）。
- **P3 Timeline 連動（C の価値回収）**: 共有 selection ハイライト + 片方向同期（pull/stamp）。reading 順↔作中時間のタイ線可視化を opt-in 複合ビューとして増築。
- **P4 拡張**: 場所/勢力レーン（participants type フィルタ・isBuiltin 識別）、年齢（ordinal/time 差分）、2か所同時（同一時刻に複数レーン跨ぐ interval）、因果チェック、AI 抽出ウィザード（importPlotThreads→events）。

## 10. リスクと緩和

- **既存レイアウトのリセット罠**: `chronicle` 未登録の保存レイアウトが load 時 `validateLayoutState` 失敗→builtin:default リセット（配置喪失）。→ `ensureLayoutStateV3` で BL slot へ自動注入する移行コードを書き、検証を通す。`layoutStateUtils`/`sanitizeUnknownPanel` に test 追加。
- **6点 + 5プリセット登録漏れ**: `Record<PanelId>` exhaustive の型ゲートが CI で弾く（機械的・決定論的）。`layoutPresets.test`/`layoutInvariants.browser` の期待値を同 PR で更新。
- **人物判定の slug 仮定**: ユーザーが type slug を改名/翻訳した project で破綻。→ `'character'` 文字列でなく `codex_types.isBuiltin` で識別。
- **scene_codex_mentions の stale**: 本文/beat/relation 由来の派生キャッシュ。→ `matrixDataVersion` を購読し bump で再ロード（`PlotThreadCharacterArc` 前例）。
- **幾何/レイアウト回帰**: happy-dom で測れず browser test 必須・sandbox に Chromium 無で初回赤になりやすい。→ chronicle 整列 invariant を `*.browser.test.tsx` で gate、座標数学は `chronicleTimeScale` 純関数に閉じ込め大半を happy-dom 単体 test 化、初回 CI 較正1巡を見込む。
- **モノリス複製の誘惑**: `TimelineViewport`(2014行) を fork しない。純関数層（lane model/runs/palette）を共有し、`ChronicleViewport` は greenfield で 200行規約準拠サブ分割。
- **構造化暦が現状無い**: `storyTimeLabel` は自由テキスト。→ `project_calendar` + `start_time` の net-new 構造化で担保。`storyTimeLabel` は表示専用据え置き。
- **C へのスコープクリープ**: Phase3+ へ厳格に後置。MVP は Chronicle 単軸を守る。

## 11. テスト方針

- 座標数学（ordinal→px、precision レンダリング規則、季節判定）は `chronicleTimeScale` / `seasonCheck` の **純関数 happy-dom 単体 test** に閉じ込める。
- レーン整列・幾何 invariant は **`*.browser.test.tsx`** で gate（CLAUDE.md のレイアウト方針）。sandbox では実行不可のため初回 CI で較正1巡を見込む。
- レイアウト登録/移行（自動注入）は `layoutStore.test` / `layoutPresets.test` / `sanitizeUnknownPanel.test` に追加。

## 12. 未決事項（実装計画で詰める）

- 季節語の抽出方式（辞書マッチ / AI）。
- 共有 selection の正本ストア（既存 selection 機構の所在確認）。
- `chronicle` のタブ表示順・空状態オンボーディング文言。
- event の手動 CRUD UI 詳細（Inspector のフィールド構成）。
