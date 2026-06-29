# Grimodex Chronicleパネル設計書

## 概要

Chronicle パネル（作中年表）は、物語の **作中時間（fabula＝出来事が世界の中で「いつ」起きたか）** を軸に出来事（Event）を並べて俯瞰・整合検査するビュー。Timeline パネルが扱う **reading-order（読む順＝plot-thread / scene index）** とは別概念の時間軸を持ち、両者は意図的に完全分離されている。

- Timeline の x 軸 = reading-order の scene index（不変）。
- Chronicle の x 軸 = 作中時間連続 ordinal を `chronicleTimeScale` で px へ直接射影。

コア体験「TALK → EXTRACT → RECALL」のうち **構造化（EXTRACT）と整合（一貫性検査）** を担う。年表の原子単位は **「出来事(Event)」で、シーンに紐づかない独立エンティティ**である。Event はシーン参照 0（オフページ＝本編に書かれていない背景）でも成立し、Scene との関係は many-to-many の `scene_events` ブリッジで表現する。この「非 scene-anchored」設計が、本パネルを Timeline（scene 主軸）から分けている最大の根拠であり、Timeline 本体（モノリス）は本機能で一切改変していない（pull/stamp による明示的な片方向リンクのみ）。

レーンの主軸は **人物（任意 Codex エントリ）**。1 人物 = 1 レーン、`primaryCodexId` が主レーンを決め、`primaryCodexId = null` は `__unassigned` レーン（点線背景）に落ちる。

本書は **Chronicle パネルのパネルレベル統合設計書**であり、全体像（UI・データモデル・5 テーブル・本格暦・整合チェック・AI 注入・秘匿・Scene 日付共有・RAG・MCP）を俯瞰する。個々の深掘り設計は `docs/superpowers/specs/` の 5 本（後述「既存設計書との整合」）に分散しており、本書から深掘りリンクとして参照する。**本書＝パネル統合 / specs＝個別深掘り**という役割分担。

### 出荷履歴（マイルストーン）

| フェーズ | PR | 内容 | 日付 |
|---|---|---|---|
| **P0 → P4g（暦ライト）** | **#188 → #199**（全 12 PR） | events 系 5 テーブル・人物レーン・作中時間軸・precision・point/interval/オフページマーカー・整合チェック 4 種・因果エッジ・AI 抽出ウィザード・タイ線複合ビュー。暦は `daysPerYear` ＋季節境界のみの「暦ライト」として意図的に最小実装 | 2026-06-26 前後（個別 PR 日付は未確認） |
| **敵対レビュー hardening** | **#200**（d2614cfd） | 全機能の敵対的レビュー 36 件修正 | 2026-06-27 |
| **AI 文脈注入** | **#210**（21e1f3ff）/ **#211**（377af6b9） | 静的スナップショット注入・read 4／write 8 ツール・MCP parity・gate／人物スコープ／tracked 化／RAG／live eval | 2026-06-28 / 2026-06-29 |
| **本格暦化** | **#214**（a72102cd） | 月／曜日／開始年・時刻分・粒度・確度注入・Scene 日付共有（schema/migrate/UI/parity/MCP） | 2026-06-29 |
| **イベント AI 秘匿** | **#216**（ab571fbd） | `secret` ＋ `reveal_scene_id`（reveal アンカー方式） | 2026-06-29 |

> 暦ライトが「P0〜P4g・全 12 PR master merged」であることは `docs/superpowers/specs/2026-06-28-chronicle-context-injection-design.md` 冒頭・`docs/superpowers/specs/2026-06-28-chronicle-full-calendar-design.md`「背景」に記録。

デフォルト位置: **Center-Bottom Dock（非表示）**。Timeline / Snippets / Attribution など他のステータスパネルとタブ切り替えで共存する（`panelRegions.ts:19` で `center-bottom`、`toolWindowDefaults.ts:51` で初期スロット `"BL"`）。

---

## パネル構造

縦方向に「ヘッダー → ツールバー → SVG ビューポート（人物／場所レーン＋因果エッジ）→（任意）タイ線複合ビュー → 下部インスペクタ」を積む。暦エディタと AI 抽出はモーダル／ダイアログ。

```
┌─────────────────────────────────────────────────────────────┐
│ A. PanelHeader  作中年表  [CalendarRange]        (Ctrl+Alt+K) │
├─────────────────────────────────────────────────────────────┤
│ B. ToolBar                                                   │
│  [+ 新規] [抽出] [暦] [↔ タイ線] [⚠ conflicts] [⚙]   [- z +] │
├─────────────────────────────────────────────────────────────┤
│ C. ChronicleViewport (SVG · h≈900 × contentW)               │
│   ┄ causal-edges layer（原因→結果・破線 / 矛盾=赤実線）      │
│  Alice │───●────────▭▭▭───────────◌──────────────  (y=30)    │
│        │  gutter label                 ⚠warning ring        │
│  Bob   │──────●──────────●───────────────────────  (y=74)    │
│  ……    │                                                    │
│  __未割当│····●·······●·············(primaryCodexId=null)···· │
├─────────────────────────────────────────────────────────────┤
│ D. ChronicleTieView（任意タブ · tieMode）                    │
│   Scene track（読む順 top）  S1   S2   S3                     │
│                              │   ╲│  ╱│   ← tie lines        │
│   Event track（作中時間 bot）E1   E2  E3                      │
├─────────────────────────────────────────────────────────────┤
│ E. ChronicleInspector（下部 · h≈400px）                      │
│  ┌ title 入力 ───────────────────────────────────────────┐  │
│  │ ⚠ conflicts（季節 / 年齢 / 因果 / 2か所同時）          │  │
│  │ EventDateEditor（start/end · minute · granularity）    │  │
│  │ precision ▼  primaryCodex ▼  location ▼  kind ▼        │  │
│  │ ☑ AI に秘匿     開示シーン ▼（reveal_scene_id）        │  │
│  │ 原因(causes) リスト  [+ add ▼]                         │  │
│  │ [stamp] [pull]（linkedSceneCount>0）          [delete] │  │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

   （モーダル）F. ChronicleCalendarEditor
   ┌ 暦 ──────────────────────────────────┐
   │ 開始年: [   0 ]   1年の日数: [ 360 ]  │
   │ 季節境界: 春0 / 夏90 / 秋180 / 冬270  │
   │ 月: [name|days] 行エディタ            │
   │ 曜日名: [日,月,火,…] 行エディタ        │
   └───────────────────────────────────────┘
```

実装は `ChroniclePanel.tsx` がデータロード・状態・CRUD ハンドラを束ね、`ChronicleViewport`（SVG 描画）/ `ChronicleInspector`（選択 Event 編集）/ `ChronicleTieView`（タイ線）/ `ChronicleCalendarEditor`（暦）/ `ChronicleExtractDialog`（AI 抽出）の各サブコンポーネントを配置する。

---

## A. ヘッダー / ツールバー

- **PanelHeader**: タイトル「作中年表」、アイコン `CalendarRange`（`panelIcons.ts:38`）。最大化・メニューは `data-panel-header` 標準（[[Grimodex_パネルヘッダー設計書]]）。
- **ツールバー操作**（`ChroniclePanel.tsx`）:
  - `[+ 新規]`: `createEvent` を採番（`nextEventOrdinal` で既存 ordinal の max の次）して空 Event を追加。
  - `[抽出]`: `ChronicleExtractDialog` を開く（AI 抽出ウィザード、後述 I）。
  - `[暦]`: `ChronicleCalendarEditor` を開く（後述 F）。
  - `[↔ タイ線]`: `tieMode` をトグルして `ChronicleTieView` を表示（後述 D）。
  - `[⚠ conflicts]`: 整合チェックで検出した issue 件数バッジ。
  - `[- z +]`: ズーム。`chronicleStore` の `zoom` を増減し、`chronicleTimeScale` の px/ordinal 射影を伸縮。
- **状態の正本**は `chronicleStore.ts`（Zustand）の `zoom` / `scrollOffset` / `showOffpage` / `selectedEventId` / `revisionCounter`。`calendar` は `useSeasonConflicts` フック、`tieMode` は `ChroniclePanel` のローカル `useState` が保持する。CRUD・暦更新・stamp/unstamp・participants・relations の各成功時に `revisionCounter` を bump して、AI プロンプトの鮮度契約（後述）を満たす。

---

## B. ChronicleViewport（人物 / 場所レーン）

`ChronicleViewport.tsx` が SVG（高さ ~900 × 幅 `contentW`）を描画する。

- **レーンモデル**: `buildChronicleLaneModel`（`chronicleLaneModel.ts`）が人物 codex ごとに 1 レーンを割り当てる。`primaryCodexId` がレーンを決め、`null` は `__unassigned` レーン（点線背景・`unassignedY`）。各レーンは背景グリッド線＋左 gutter のラベル（人物名）＋ EventMarker 群で構成。
- **x 座標**: `chronicleTimeScale.ts` の `scaleEvents` が ordinal を px へ連続射影する。全 Event に `startTime` が揃っているか（`haveAllTimes`）で「作中時間の実距離（日数）でレイアウト」か「ordinal 等間隔」かを分岐する。
- **副参加（participants）**: `event_participants` の副参加者は将来「淡いタイ線」でレーン接続予定（未実装、後述）。
- **警告リング**: 整合チェック統合の `issueIds`（後述）に含まれる Event には amber-500・r=9 の警告リングを重畳する（`ChroniclePanel.tsx:188` で集約 → Viewport へ props）。

---

## C. EventMarker（point / interval / オフページ）

`EventMarker.tsx` が 1 Event を SVG マーカーとして描く。形状は `startTime` / `endTime` / scene リンク有無で決まる:

- **point**（`endTime = null`）: 点（●）。
- **interval**（`endTime != null`）: 矩形帯（▭）。幅は作中時間の長さ。
- **オフページ**（scene リンク 0）: 中空（◌）で「本編未記述の背景」を示す。

`precision`（`EVENT_PRECISIONS`）でスタイルを変える:

| precision | 意味 | スタイル |
|---|---|---|
| `exact` | 確定日 | 実線マーカー |
| `approx` | 概推日 | ぼかし帯・opacity≈0.6 |
| `unknown` | 不確定日 | 破線・opacity≈0.4・浮遊括弧 |

---

## D. 因果エッジ（event_relations）と ChronicleTieView

### 因果エッジ（C のレイヤとして重畳）

`chronicleEdges.ts` が `event_relations`（cause→effect）と `eventPositions`（eventId→{x,y}）から `CausalEdgeGeom[] = {causeId, effectId, x1,y1,x2,y2, conflict}` を生成し、`ChronicleViewport.tsx:99` で SVG パスとして描く。

- 矛盾なし（`conflict=false`）: 破線 `stroke-muted-foreground/40 width=1 dasharray="4 3"`。
- 矛盾あり（`conflict=true`、effectTime < causeTime）: 実線赤 `stroke-red-500 width=1.5`。
- 描画順は `(causeId, effectId)` 昇順で決定的。

### タイ線複合ビュー（任意タブ）

`ChronicleTieView.tsx` は「読む順では前なのに作中では後」のズレを線の交差として可視化する任意ビュー。`tieView.ts` の `buildTieView({scenes, events, links, width, padX, topY, bottomY})` が `TieViewModel = {sceneDots, eventDots, ties, topY, bottomY}` を返す。

- 上部 line（`topY`）= reading-order baseline。scene dot は `scene_events` でリンクされたシーン群を読む順ソートした x。
- 下部 line（`bottomY`）= 作中時間 baseline。event dot は ordinal 由来の x。
- tie line（`x1=scene, x2=event`・`stroke-primary/40`）が交差すると「読む順と作中時間の食い違い」が一目で分かる。

---

## E. ChronicleInspector（選択 Event 編集）

`ChronicleInspector.tsx`（選択 Event の編集パネル）。フィールド:

- **title** 入力 / **note**（メモ）。
- **conflicts 警告**: 当該 Event が `issueIds` に入っていれば季節 / 年齢 / 因果 / 2か所同時の警告を表示。
- **EventDateEditor**: `startTime`/`startMinute`/`startGranularity` ＋ `endTime`/`endMinute`/`endGranularity`（後述 G）。
- **precision** select（exact/approx/unknown）。
- **primaryCodex picker** / **location picker**: `CodexEntryPicker`（type フィルタ対応）。
- **kind** ドロップダウン（generic/birth/death・`EVENT_KINDS`）。
- **AI 秘匿**: `secret` チェックボックス ＋ 開示シーン select（`reveal_scene_id`、空＝自動導出、後述「イベント AI 秘匿」）。
- **原因(causes)**: `event_relations` の cause リスト＋add select。
- **[stamp] / [pull]**: `linkedSceneCount > 0` のとき表示。Timeline 連動の明示片方向操作（後述）。
- **[delete]**: Event 削除（cascade で participants / scene_events / relations も）。

---

## F. EventDateEditor / CodexEntryPicker

- **EventDateEditor.tsx**: 日付・時刻・粒度を暦駆動で入力。`startGranularity` の select（`EVENT_GRANULARITIES`）に応じて入力欄（年／月／日／HH:MM）を出し分け、`chronicleTime` の `dateToDayNumber` で `startTime`（紀元からの日数）へ、`startMinute`（0..1439）へ変換する。Scene 日付共有でも再利用される（後述）。
- **CodexEntryPicker.tsx**: 人物／場所の codex select。`type` フィルタ（character / location 等）対応で、primaryCodex には人物、location には場所をしぼる。

---

## G. ChronicleCalendarEditor（本格暦エンジン・#214）

暦ライト（`daysPerYear` ＋季節境界のみ）から **本格暦**（月／曜日／開始年／時刻分）へ #214 で進化。`ChronicleCalendarEditor.tsx` が `project_calendar` を編集する。

### 暦モデル（`chronicleTime.ts:17` `ChronicleCalendar`）

```typescript
interface ChronicleCalendar {
  daysPerYear: number;
  seasonBoundaries: SeasonBoundary[];  // [{name, startDayOfYear}]
  startYear?: number;                   // 暦の開始年ラベル（day番号0 の年）
  months?: MonthDef[];                  // [{name, days}]・空=月概念なし
  weekdayNames?: string[];              // 曜日名配列・空=曜日概念なし（週長=配列長）
}
```

### 粒度 `EVENT_GRANULARITIES`（`schema.ts:1363`）

`none`（時刻未指定）/ `season`（季節のみ）/ `year`（年）/ `month`（年月）/ `day`（年月日）/ `time`（年月日＋時分）。**確度(precision) とは独立**（粒度＝どこまで判明しているか、確度＝確からしさ）。

### 暦エンジン関数（`chronicleTime.ts`・純関数・テスト gate）

| 関数 | 行 | 役割 |
|---|---|---|
| `calendarDaysPerYear` | 59 | 実効 1 年日数（months の Σ days vs stored `daysPerYear`） |
| `weekdayOf` | 71 | 日番号 → 曜日インデックス（週長 = `weekdayNames.length`、未定義は null） |
| `dayNumberToDate` | 85 | 日番号 → `ChronicleDate{year, monthIndex, dayOfMonth, dayOfYear, weekdayIndex}` |
| `dateToDayNumber` | 130 | 年月日 → 日番号（逆変換） |
| `formatTimeOfDay` | 155 | 分 → "HH:MM"（24h、null は null） |
| `formatChronicleDate` | 168 | 粒度別表示整形（例「1247年5月12日 14:30」） |
| `seasonOf` | 230 | 日番号 → 季節名（循環区間・年末→年初 wrap） |
| `nextEventOrdinal` | 253 | ordinal 採番（既存 max の次・fractional-index） |

`ChronicleDate`（`chronicleTime.ts:35`）の `monthIndex` / `dayOfMonth` / `weekdayIndex` は対応概念が暦に無ければ null。デフォルト暦は `startYear=0`・`daysPerYear=360`・春夏秋冬 4 季（`DEFAULT_SEASON_BOUNDARIES` `chronicleTime.ts:217`、春0/夏90/秋180/冬270）・`months`/`weekdayNames` 未定義。

---

## H. 整合チェック 4 種（純関数 → issueIds → 警告リング）

4 つの独立した純関数が conflict 集合を返し、`ChroniclePanel.tsx:189` の `issueIds = new Set([...季節, ...年齢, ...因果, ...2か所同時])` で統合され、`ChronicleViewport` の警告リングに供給される。

| # | チェック | 入力 | 判定 | 出力 / Set 関数 | ファイル |
|---|---|---|---|---|---|
| 1 | **季節** | `events[startTime]`・calendar・`scene_events`・シーン本文 | `seasonOf(startTime)` vs シーン本文の季節語の矛盾 | `SeasonConflict[]` → `conflictingEventIds` | `seasonCheck.ts:29`・`seasonDetect.ts` |
| 2 | **年齢** | `events[primaryCodexId, startTime]`・`codex_entry_phases` | `age = eventTime - birthTime` vs 本文の年齢語（赤ん坊/子供/大人/老人…） | `AgeConflict[]` → `ageConflictIds`（`DEFAULT_AGE_WORDS`・大人 の送り仮名ガード） | `ageCheck.ts:95` |
| 3 | **因果** | `events[startTime]`・`event_relations` | `effectTime < causeTime`（結果が原因より前） | `CausalConflict[]` → `causalIssueEventIds`（cause/effect 双方） | `eventCausality.ts:20` |
| 4 | **2か所同時** | `events[primaryCodexId, startTime, endTime, locationCodexId]`（interval 必須） | 同一人物が同時刻に別場所（重複・strict: max(start) < min(end)） | `TwoPlacesConflict[]` → `twoPlacesEventIds` | `twoPlaces.ts:23` |

全て純関数なので `now` / fixture 注入で決定的にテストできる。

---

## I. ChronicleExtractDialog（AI 抽出ウィザード）

`ChronicleExtractDialog.tsx`。本文 → Event 候補への **一方向**抽出（年表側から本文は書き換えない）。

1. **選択**: フォルダ（章／シーン入れ子）選択 → `[解析]`。
2. **抽出**: 配下シーン本文（DFS pre-order）を LLM に渡し `EventProposal[] = {title, note?, evidenceSceneIds[]}` を生成。
3. **確認**: 候補リスト → `[取り込む]`。

API（`extractEventsApi.ts`）:

- `proposeEvents({scenes:[{sceneId,title,bodyText,orderIndex}], existingTitles})` → `EventProposal[]`。`existingTitles` を LLM に注入して既存出来事との重複を排除。
- `importExtractedEvents(projectId, candidates)` → number。**1 トランザクションに纏めて insert**（ordinal 採番競合防止＋composite undo）。`importPlotThreads` パターンの流用。

---

## 本格暦・粒度・時刻のデータ反映

Event の時刻系は次の対で持つ（`schema.ts:1394-1406`）:

- `startTime`/`endTime` = 紀元からの日数（INTEGER・null=ordinal のみ）。季節／年齢／因果／interval 計算の正本。
- `startMinute`/`endMinute` = 24h 時計の分（0..1439・null=時刻未指定）。
- `startGranularity`/`endGranularity` = 粒度（`EVENT_GRANULARITIES`・default `'none'`）。
- `precision` = 確度（`EVENT_PRECISIONS`・default `'exact'`）。
- `kind` = 種別（`EVENT_KINDS`・default `'generic'`、birth/death は年齢計算の基準点）。

暦本体（`project_calendar`）の `start_year` / `months` / `weekday_names` が #214 で追加された。

---

## AIコンテキスト注入（#210 / #211）

年表データ（events 系 5 表）を **AI（執筆チャット / アプリ内エージェント / 外部 MCP）に食わせる注入レイヤ**。先行例 plot-thread phase3（「派生メタの静的注入＋オンデマンド・ツール」）を踏襲。**3 配信チャネル**で構成する。

### ① 静的スナップショット注入（≤600 トークン・段階縮約）

- **derive 正本**: `chronicleSnapshot.ts` の `deriveChronicleSnapshot(input)` が `ChronicleSnapshot` を組み、`renderChronicleSnapshot(snapshot, lang)` が LLM 文字列化する。
- **derive 関数群**（純関数）: `deriveCharacterStateAt`（startTime→生死/年齢/status）、`deriveLastKnownLocation`（anchor+participants→最後に判明する場所）、`deriveRecentEvents`（ordinal ≤ anchor の直近 K=8 generic）、`deriveUnresolvedCausal`（ordinal 軸の未回収因果）、`deriveOffpageEvents`（未 stamp・最大 3）、`pickSnapshotCharacters`（@mention / sceneCodexIds / Spotlight＝注目人物で人物スコープ）。
- **アンカー解決**: `resolveSceneAnchor.ts` が「scene-own（`tree_nodes.chronicleStartTime`）→ 読む順前方 proxy → none」の 3 段階で現在シーンの作中時刻を決める。
- **出力セクション（削減優先度順）**: 作中時刻 → 登場人物（status/age/location）→ 直近イベント → 未回収因果 → オフページ背景。トークン超過時はこの逆順で段階縮約。
- **配線**: `contextBuilder.ts` が `chronicle_snapshot` タグ（`PROMPT_DATA_TAGS.chronicle`）として L3 cache segment に同梱し、trim では `CHRONICLE` を独立 key で扱う（trim 順 EPISODIC → RAG → PLOT_THREAD → CHRONICLE → …）。`chatStore.ts` が scene 文脈で `buildChronicleSnapshotTextForScene()` を呼び、`revisionCounter` を `contextPromptKey` に join して鮮度を確保する。
- **トグル**: Project Settings → AI Prompt →「年表を AI に渡す」（`aiPrompt.chronicle.enabled`・既定 true）。OFF で derive 自体をスキップ、タグごと消失。

### ② アプリ内 Agent Tools（read 5 / write 8）

- **read 5**: `list_events` / `get_event_detail` / `get_character_timeline` / `get_chronicle_state` / `search_events`（`chronicleReadTools.ts`・`toolDefinitions.ts`）。現在シーンは `useTreeStore.activeSceneId` で解決し、秘匿フィルタを各ツール冒頭で適用。
- **write 8**: `create_event` / `update_event` / `delete_event` / `stamp_scene_event` / `unstamp_scene_event` / `set_event_participants` / `add_event_relation` / `remove_event_relation`（`chronicleWriteTools.ts`）。全て tracked-write（後述）。`MUTATING_TOOL_NAMES` 登録で Hermes body channel の write をブロック。
- **RAG**: `search_events` のみ dense 索引（後述）。

### ③ 外部 MCP parity（fixture CI gate）

- `grimodex-mcp/src/tools/chronicle.rs` が read 4 / write 8 を同一 schema で再実装。read は外部から現在シーン不明のため **fail-closed**（`secret=true` は読み取り除外・reveal 判定なし）。
- Rust derive（`grimodex-mcp/src/chronicle_snapshot.rs`）は TS derive と **同一 JSON schema**。`src/features/chronicle/fixtures/chronicle-snapshot/*.json` で TS↔Rust deep-equal の drift gate（CI）。

注入経路マトリクス:

| 経路 | derive | anchor | secret ゲート | tracked-write | RAG |
|---|---|---|---|---|---|
| ① 静的注入 | ✓ | ✓ | ✓ | — | — |
| ② in-app read | ✓ | — | ✓ | — | search_events のみ |
| ③ MCP read | ✓(Rust) | — | ✓ fail-closed | — | — |
| ② in-app write | — | — | ✓ oracle 対策 | ✓ | schedule index |
| ③ MCP write | — | — | ✓ oracle 対策 | ✓ surface=mcp | schedule index |

深掘り: `docs/superpowers/specs/2026-06-28-chronicle-context-injection-design.md`。

---

## イベントAI秘匿（#216・reveal アンカー方式）

伏線（foreshadows.secret）と同 idiom で、出来事を **オプトインで AI から隠す**。default は表示（年表注入の存在意義＝AI に背景を渡すこと）。

### データ（2 列）

- `events.secret`（boolean・default false・`schema.ts:1409`）。
- `events.reveal_scene_id`（→ `tree_nodes.id` ON DELETE SET NULL・`schema.ts:1412`）= 読む順の開示アンカー（明示上書き専用、null=自動導出 or 恒久秘匿）。

### 2 軸の分離（最重要）

- `ordinal`（＝ fabula・いつ起きたか）→ `atOrBefore(ordinal)` で past/future 判定。
- `readingOrder`（＝どこまで読んだか）→ `readingPos(current) < readingPos(reveal)` で隠蔽判定。

両者を混同しないことが事故開示防止の核心。

### 秘匿ゲート（TS 単一正本・`chronicleSecrecy.ts`）

- `isEventHiddenFromAi`: `secret ∧ (reveal == null ∨ readingPos(current) < readingPos(reveal))`。order 外（Infinity）比較で誤って開示しないよう注意。
- `effectiveRevealSceneId`: 明示上書き > 読む順最小スタンプシーン > null（恒久秘匿）。
- `projectVisibleChronicle`: events/sceneEvents/participants/relations を可視射影。
- 読む順は `computeGlobalSceneOrder`（TS 唯一正本）。

### 全経路の強制点 と MCP fail-closed

| 経路 | 現在シーン解決 | ゲート |
|---|---|---|
| 静的注入 | `buildSceneCtx` 引数 | `projectVisibleChronicle()` 前処理 |
| in-app read | `activeSceneId` | 各ツール冒頭 |
| MCP read | **無**（現在位置不明） | fail-closed＝secret 全非表示 |
| write-by-id | — | hidden への write は generic not found（oracle 対策） |

**UI 手動編集は秘匿対象外**: 作者には ChronicleInspector で常に見える（秘匿は AI 経路のみ）。深掘り: `docs/superpowers/specs/2026-06-29-chronicle-event-secrecy-design.md`。

---

## Scene 日付共有（#214 T3・4 層 mirror）

Event とは統合せず、**同じ `chronicleTime` 日付モデルをシーンにも共有**する（読む順 `sortOrder` とは独立した作中時間軸）。`tree_nodes` に 7 列（`schema.ts:84-104`）:

`chronicle_start_time` / `chronicle_start_minute` / `chronicle_start_granularity`（default 'none'）/ `chronicle_end_time` / `chronicle_end_minute` / `chronicle_end_granularity`（default 'none'）/ `chronicle_precision`（default 'exact'）。

- **編集 UI**: `SceneDateEditor.tsx` が `EventDateEditor` を再利用し `tree_nodes` 列へマップ。`SceneMetaPanel` と `TimelineInspector.tsx`（`-mx-3` 埋め込み）の両方から開く。
- **store**: `treeStore.ts` の `updateChronicleDate(id, patch)` が DB 永続化。
- **resolveSceneAnchor v2**: scene-own（`tree_nodes.chronicleStartTime != null`）を第一源とし、無ければ読む順前方 proxy、なお無ければ none。
- **4 層 mirror**: `schema.ts`（TS type + Drizzle DDL）/ `migrate.rs`（CREATE + `add_column_if_missing`）/ `browser-mock.ts`（test DDL）/ `projectSnapshotApi`（export→restore round-trip 不変）。

---

## tracked-write / undo

全 write（アプリ内 8・MCP 8）は **tracked-write** を通る。

- **TS 層**（`agent-writes/event.ts`）: `trackedEventWrite(command, payload, historyLabelKey)`。AI policy gate（`knowledgeWrite`）→ Rust 呼び出し → `globalHistoryStore.push({kind:"chronicle", undo/redo closure})` → `chronicleStore.bumpRevision()`（`revisionCounter` を bump）→ `scheduleEventIndex`（RAG）。
- **Rust 層**（`agent_writes.rs`）: `BEGIN IMMEDIATE` TX で mutation → snapshot → `undo_journal`（forward + revert）→ `change_events` append（`domain='event'`、surface = manual / in-app-agent / mcp）→ COMMIT/ROLLBACK。`importExtractedEvents` は複数 event + links を **1 journal entry**（composite undo）。

---

## RAG 索引（event_chunks・dense のみ）

- **索引**（`events_index.rs`）: `event_chunks`（PK=event_id・1 出来事 1 ベクトル）。`build_event_embed_text(title, note, primary_name, location_name, participants)` を埋め込み、`content_hash` は title/kind/note/名前ベース（id ではない）で決定的。TX 内 re-SELECT・再 hash で race 対策。参加者／場所 codex のリネームは当該 Event が次に mutate されるまで反映されない（cross-entity eventual consistency）。
- **検索**（`events_search.rs`）: `run_events_search()` は **dense のみ**（FTS hybrid なし）。秘匿は over-fetch（limit×3）→ hidden filter → slice(limit) で title を漏らさない。
- **制約**: indexer はアプリ内（Tauri）限定。**MCP は embedder 非搭載のため RAG parity なし**（read/write の parity のみ）。

---

## Timeline 連動（明示・片方向）

- Chronicle は Timeline の `selectedNodeIds` を購読し、選択シーンにリンクされた Event をハイライトできるが、**Timeline 本体（モノリス）は本機能で無改変**。
- Event ⇄ Scene のリンクは ChronicleInspector の `[stamp]`（scene → event リンク）/ `[pull]`（event ← scene 取り込み）による **明示的な片方向操作**のみ。自動同期はしない（reading-order と作中時間を分離し続けるための設計判断）。

---

## データモデル / DBスキーマ

正本は **`src-tauri/src/database/migrate.rs`**（`CREATE TABLE` ＋ `add_column_if_missing`、CHECK 制約は SQL 側のみ）。`src/db/schema.ts` の Drizzle 定義はこれを CHECK 抜きでミラーする。値集合 `EVENT_PRECISIONS` / `EVENT_KINDS` / `EVENT_GRANULARITIES` は `schema.ts:1351-1371`。

### events（`migrate.rs:1766-1794` 正本 / `schema.ts:1373`）

```sql
CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT '',
  note              TEXT,
  ordinal           TEXT NOT NULL DEFAULT 'a0',                 -- fractional-index(base62・辞書順)
  primary_codex_id  TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,  -- ホームレーン人物
  location_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,  -- 2か所同時の基準
  start_time        INTEGER,                                   -- 紀元からの日数(null=ordinalのみ)
  end_time          INTEGER,                                   -- interval終端(null=point)
  start_minute      INTEGER,                                   -- 0..1439(24h・null=時刻未指定)
  end_minute        INTEGER,
  start_granularity TEXT NOT NULL DEFAULT 'none'
                       CHECK(start_granularity IN ('none','season','year','month','day','time')),
  end_granularity   TEXT NOT NULL DEFAULT 'none'
                       CHECK(end_granularity IN ('none','season','year','month','day','time')),
  precision         TEXT NOT NULL DEFAULT 'exact'
                       CHECK(precision IN ('exact','approx','unknown')),
  kind              TEXT NOT NULL DEFAULT 'generic'
                       CHECK(kind IN ('generic','birth','death')),  -- birth/death=年齢計算基準
  secret            INTEGER NOT NULL DEFAULT 0,                 -- AI秘匿(オプトイン)
  reveal_scene_id   TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,  -- 開示アンカー
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_project ON events(project_id);
CREATE INDEX idx_events_ordinal ON events(project_id, ordinal);
```

### event_participants（`schema.ts:1429`）

```sql
CREATE TABLE event_participants (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  codex_entry_id  TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
  role            TEXT,                                        -- 任意(actor/mentioned等)
  PRIMARY KEY (event_id, codex_entry_id)
);
CREATE INDEX idx_event_participants_codex ON event_participants(codex_entry_id);
```

### scene_events（`schema.ts:1447`）

```sql
CREATE TABLE scene_events (        -- scene↔event 0..N 橋(0=オフページ)・両側CASCADE
  scene_id  TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (scene_id, event_id)
);
CREATE INDEX idx_scene_events_event ON scene_events(event_id);
```

### project_calendar（`schema.ts:1464`・1 プロジェクト 1 暦）

```sql
CREATE TABLE project_calendar (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  days_per_year     INTEGER NOT NULL DEFAULT 360,
  season_boundaries TEXT NOT NULL DEFAULT '[]',  -- JSON SeasonBoundary[]
  start_year        INTEGER NOT NULL DEFAULT 0,  -- 暦開始年(#214)
  months            TEXT NOT NULL DEFAULT '[]',  -- JSON MonthDef[]=[{name,days}]・'[]'=月概念なし
  weekday_names     TEXT NOT NULL DEFAULT '[]',  -- JSON string[]・'[]'=曜日概念なし(週長=配列長)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

### event_relations（`schema.ts:1492`・因果エッジ）

```sql
CREATE TABLE event_relations (     -- cause→effect・effect<cause で因果矛盾
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cause_event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  effect_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (cause_event_id, effect_event_id)
);
CREATE INDEX idx_event_relations_project ON event_relations(project_id);
CREATE INDEX idx_event_relations_effect  ON event_relations(effect_event_id);
```

### event_chunks（`migrate.rs:1397-1411`・Rust 専用・Drizzle 非定義）

```sql
CREATE TABLE event_chunks (        -- RAG dense索引・PK=event_id(1出来事1ベクトル)
  event_id         TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  event_title      TEXT NOT NULL,
  event_kind       TEXT NOT NULL,
  text             TEXT NOT NULL,
  embedding        BLOB NOT NULL,
  embedding_dim    INTEGER NOT NULL,
  model_id         TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  chunker_version  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_event_chunks_model ON event_chunks(model_id);
```

### tree_nodes（Chronicle 7 列・Scene 日付共有・`schema.ts:84-104` / `migrate.rs:39`）

`chronicle_start_time` INTEGER / `chronicle_start_minute` INTEGER / `chronicle_start_granularity` TEXT NOT NULL DEFAULT 'none' / `chronicle_end_time` INTEGER / `chronicle_end_minute` INTEGER / `chronicle_end_granularity` TEXT NOT NULL DEFAULT 'none' / `chronicle_precision` TEXT NOT NULL DEFAULT 'exact'。

> テーブル定義・DDL・インデックスの正本は `migrate.rs` ＋ [[Grimodex_統合DBスキーマ]]。`tree_nodes` 本体・`codex_entries` 等の定義は同設計書を正とする。

---

## レイアウト統合

新規 tool-window パネルの登録要件（panelId / component / icon / region / 初期スロット / 全プリセット / keybinding / command）をすべて満たす。

| 登録サイト | ファイル:行 | 値 |
|---|---|---|
| panelIds | `src/features/layout/panelIds.ts:12` | `"chronicle"`（`PanelId` union） |
| panelComponents | `src/features/layout/panelComponents.tsx:39` | `chronicle: ChroniclePanel`（import :11） |
| panelIcons | `src/features/layout/panelIcons.ts:38` | `chronicle: CalendarRange`（import :11） |
| panelRegions | `src/features/layout/panelRegions.ts:19` | `chronicle: "center-bottom"` |
| KEYBOARD_SHORTCUT_MAP | `src/features/layout/panelRegions.ts:39` | `chronicle: "Ctrl+Alt+K"` |
| TOGGLEABLE_PANELS | `src/features/layout/panelRegions.ts:64` | `"chronicle"`（center-bottom 群） |
| toolWindowDefaults | `src/features/layout/toolWindowDefaults.ts:51` | `chronicle: "BL"`（初期スロット 左下） |
| layoutPresets | `src/features/layout/layoutPresets.ts:152, 217, 326, 418, 509` | 各プリセットへ登録。新規パネルは curated プリセットへ自動補充（同 :522 コメント） |
| keybindings（command） | `src/features/settings/keybindings.ts:83-87` | `id:"focusChronicle"` / `defaultBinding:"Mod+Alt+K"` / `panel:"chronicle"` |
| commandProvider | `src/features/commandCenter/providers/commandProvider.ts` | keybindings の `panel` 付きコマンド（focusChronicle）をコマンドパレットへ surface |

`Mod` は `matchesMod` で macOS=`⌘`、その他=`Ctrl` に解決される。

---

## キーボードショートカット

| ショートカット | 動作 |
|---|---|
| `Ctrl+Alt+K`（macOS: `⌘+Alt+K`） | Chronicle パネルにフォーカス / トグル |

`keybindings.ts:83` の `focusChronicle`（`defaultBinding:"Mod+Alt+K"`・`panel:"chronicle"`）と `panelRegions.ts:39` の `KEYBOARD_SHORTCUT_MAP` で定義。

---

## 実装ファイル配置

| ファイル | 役割 |
|---|---|
| `src/features/chronicle/ChroniclePanel.tsx` | パネルトップ。状態・データロード・CRUD・`issueIds` 集約（:189） |
| `src/features/chronicle/ChronicleViewport.tsx` | SVG レーン・マーカー・因果エッジ（:99）・警告リング |
| `src/features/chronicle/ChronicleInspector.tsx` | 選択 Event 編集・conflicts・causes・stamp/pull/delete |
| `src/features/chronicle/ChronicleCalendarEditor.tsx` | 暦エディタ（months/weekday/startYear 行エディタ） |
| `src/features/chronicle/ChronicleExtractDialog.tsx` | AI 抽出ウィザード（フォルダ選択→解析→確認→取込） |
| `src/features/chronicle/ChronicleTieView.tsx` | タイ線複合ビュー SVG（読む順×作中時間） |
| `src/features/chronicle/EventMarker.tsx` | point/interval/オフページ マーカー（precision style） |
| `src/features/chronicle/EventDateEditor.tsx` | 日付・時刻・粒度入力（暦駆動） |
| `src/features/chronicle/CodexEntryPicker.tsx` | 人物/場所 select（type フィルタ） |
| `src/features/chronicle/SceneDateEditor.tsx` | Scene 日付エディタ（`tree_nodes.chronicle*` へマップ） |
| `src/features/chronicle/chronicleStore.ts` | Zustand（zoom/scrollOffset/showOffpage/selectedEventId/revisionCounter・`bumpRevision()`）。calendar=`useSeasonConflicts` フック・tieMode/calendarEditorOpen/extractOpen=ChroniclePanel ローカル `useState` |
| `src/features/chronicle/chronicleTime.ts` | 暦エンジン（`dayNumberToDate`/`dateToDayNumber`/`formatChronicleDate`/`seasonOf`/`nextEventOrdinal` 他） |
| `src/features/chronicle/chronicleTimeScale.ts` | `scaleEvents`（ordinal→px・`haveAllTimes` 分岐） |
| `src/features/chronicle/chronicleLaneModel.ts` | `buildChronicleLaneModel`（人物レーン・`__unassigned`） |
| `src/features/chronicle/chronicleEdges.ts` | `eventPositions`・因果エッジ幾何 |
| `src/features/chronicle/seasonCheck.ts`（:29）/ `seasonDetect.ts` | 季節整合チェック |
| `src/features/chronicle/ageCheck.ts`（:95） | 年齢整合チェック（`DEFAULT_AGE_WORDS`） |
| `src/features/chronicle/eventCausality.ts`（:20） | 因果整合チェック |
| `src/features/chronicle/twoPlaces.ts`（:23） | 2か所同時チェック |
| `src/features/chronicle/tieView.ts` | `buildTieView` |
| `src/features/chronicle/api.ts` | CRUD（`normalizeEvent`/`listEvents`/`createEvent`/`updateEvent`・snake_case↔camelCase） |
| `src/features/chronicle/extractEventsApi.ts` | `proposeEvents`/`importExtractedEvents`（LLM 抽出） |
| `src/features/chronicle/chronicleSnapshot.ts` | 静的注入 derive 正本・`renderChronicleSnapshot` |
| `src/features/chronicle/resolveSceneAnchor.ts` | アンカー解決（scene-own / proxy / none） |
| `src/features/chronicle/chronicleSecrecy.ts` | 秘匿 TS 正本（`isEventHiddenFromAi`/`effectiveRevealSceneId`/`projectVisibleChronicle`） |
| `src/features/chat/contextBuilder.ts` | L3 cache segment 配線（`chronicle_snapshot` タグ・trim 独立 key） |
| `src/features/chat/chatStore.ts` | scene snapshot 構築・`chronicleRevision` join |
| `src/features/chat/agent/chronicleReadTools.ts` / `chronicleWriteTools.ts` / `toolDefinitions.ts` | agent tools（read5/write8） |
| `src/features/agent-writes/event.ts` | `trackedEventWrite`（policy gate・globalHistory・index schedule） |
| `src/features/tree/treeStore.ts` | `updateChronicleDate`（Scene 日付永続化） |
| `src/features/timeline/TimelineInspector.tsx` | `SceneDateEditor` 埋め込み |
| `src/db/schema.ts:84-104, 1351-1512` | events/tree_nodes/値集合 Drizzle 定義 |
| `src-tauri/src/database/migrate.rs:39, 1397, 1766` | DDL 正本（events/event_chunks/tree_nodes chronicle 列） |
| `src/lib/browser-mock.ts` / `src/features/project/projectSnapshotApi.ts` | test DDL / round-trip |
| `src-tauri/src/commands/agent_writes.rs` | tracked-write TX（`domain='event'`・surface） |
| `src-tauri/src/semantic/events_index.rs` / `events_search.rs` | RAG 索引 / 検索 |
| `src-tauri/crates/grimodex-mcp/src/tools/chronicle.rs` / `db.rs` / `chronicle_snapshot.rs` | MCP read4/write8・SQL 再実装・Rust derive parity |
| `src/features/layout/{panelIds,panelComponents,panelIcons,panelRegions,toolWindowDefaults,layoutPresets}.ts(x)` | レイアウト登録 |
| `src/features/settings/keybindings.ts:83` | `focusChronicle` コマンド |

テストは各 `*.test.ts(x)` / `*.browser.test.tsx`（純関数は `now`/fixture 注入で決定的、MCP parity は fixture deep-equal で gate）。

---

## 既存設計書との整合

### [[Grimodex_Timelineパネル設計書]]

Chronicle（作中時間軸）と Timeline（reading-order 軸）は**別概念で意図的に分離**。Timeline モノリスは本機能で無改変、Event⇄Scene のリンクは ChronicleInspector の stamp/pull による明示片方向のみ。x 軸の定義（reading-order index vs ordinal）の正本は両設計書を各々の軸について正とする。

### [[Grimodex_統合DBスキーマ]]

`events` / `event_participants` / `scene_events` / `project_calendar` / `event_relations` / `event_chunks` および `tree_nodes` の DDL・インデックス・FK は `migrate.rs` ＋統合 DB スキーマ設計書を正とする。

### [[Grimodex_パネルヘッダー設計書]]

PanelHeader（`data-panel-header`・最大化・メニュー）は同設計書の標準に従う。

### [[Grimodex_セマンティック検索設計書]]

`event_chunks` の dense 索引・`search_events` は同設計書のセマンティック検索基盤を共有する（FTS hybrid なし・MCP parity なし）。

### superpowers/specs（個別深掘り）

| spec | 役割 |
|---|---|
| `docs/superpowers/specs/2026-06-26-chronicle-timeline-design.md` | 年表ビュー本体（P0〜P4g）の設計確定書。レーン・時間軸・マーカー・整合チェック・タイ線の深掘り |
| `docs/superpowers/specs/2026-06-28-chronicle-full-calendar-design.md` | 本格暦化（月/曜日/開始年・時刻分・粒度・Scene 日付共有）の深掘り |
| `docs/superpowers/specs/2026-06-28-chronicle-context-injection-design.md` | AI 文脈注入（静的 snapshot・read/write tools・MCP parity・fixture gate）の深掘り |
| `docs/superpowers/specs/2026-06-29-chronicle-event-secrecy-design.md` | イベント AI 秘匿（reveal アンカー方式・2 軸分離・fail-closed）の深掘り |
| `docs/superpowers/specs/2026-06-22-plot-thread-timeline-design.md` | 先行する plot-thread タイムライン（reading-order 軸）。Chronicle が分離した相手側の設計 |

本書＝パネル統合の全体像、specs＝各サブシステムの個別深掘り、という役割分担。

---

## 未実装 / 今後

- **副参加者の淡いタイ線接続**: `event_participants`（primaryCodexId 以外）をレーンへ淡い線で結ぶ表示は未実装。
- **実機 GUI QA**: Viewport ズーム・interval 帯・警告リング・タイ線交差の実描画は browser test 一部のみで、実機 GUI の網羅 QA は残作業。
- **ライブ LLM QA**: `chronicleInjectionEval.live.test.ts`（off / secretHidden / pastReveal・`leaks_secret=0` 要求）はモック中心。実プロバイダでの注入・秘匿の最終確認は残作業。
- **MCP の RAG parity 無し**: MCP は embedder 非搭載のため `search_events`（dense）相当を提供できない（read/write parity のみ）。
- **cross-entity eventual consistency**: 参加者／場所 codex のリネームは当該 Event を mutate するまで `event_chunks` に反映されない（許容済みの既知挙動）。
- **暦ライト → 本格暦の移行**: 既存 DB は `add_column_if_missing`（CHECK 無し素 ALTER）で後方互換。CHECK 制約は新規作成 DB のみ。
- **P0〜P4g の個別 PR 日付**: #188〜#199 の各 PR 単位の出荷日は本書 findings 範囲では未確認（#200 以降は確認済み）。

---

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-06-29 | 新規作成（パネルレベル統合設計書）。Chronicle=作中時間(fabula)軸・Event=非 scene-anchored 独立エンティティ・5 テーブル＋event_chunks＋tree_nodes 7 列・本格暦エンジン(#214)・整合チェック 4 種・因果エッジ・AI 抽出ウィザード・タイ線複合ビュー・AI 文脈注入(#210/#211)・イベント秘匿(#216)・Scene 日付共有・tracked-write・RAG・MCP parity・レイアウト統合を記載。詳細は specs 5 本へ深掘りリンク。実装（`src/features/chronicle/` 他）に準拠。 |
