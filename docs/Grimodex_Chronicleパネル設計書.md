# Grimodex Chronicleパネル設計書

## 概要

Chronicle パネル（作中年表）は、物語の **作中時間（fabula＝イベントが世界の中で「いつ」起きたか）** を軸にイベント（Event）を並べて俯瞰・整合検査するビュー。Timeline パネルが扱う **reading-order（読む順＝plot-thread / scene index）** とは別概念の時間軸を持ち、両者は意図的に完全分離されている。

- Timeline の x 軸 = reading-order の scene index（不変）。
- Chronicle の x 軸 = 各イベントの「実効日(effectiveDays)」を `pxPerDay` で px へ射影する連続 pan/zoom 軸（`chronicleAxis`）。全 event に `startTime` が揃えば実暦の日数距離、揃わなければ ordinal 序列（**sequence モード**）にフォールバックする。

コア体験「TALK → EXTRACT → RECALL」のうち **構造化（EXTRACT）と整合（一貫性検査）** を担う。年表の原子単位は **「イベント(Event)」で、シーンに紐づかない独立エンティティ**である。Event はシーン参照 0（オフページ＝本編に書かれていない背景）でも成立し、Scene との関係は many-to-many の `scene_events` ブリッジで表現する。この「非 scene-anchored」設計が、本パネルを Timeline（scene 主軸）から分けている最大の根拠であり、Timeline 本体（モノリス）は本機能で一切改変していない（pull/stamp による明示的な片方向リンクのみ）。

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
| **パネル UI 再設計（Design import）** | 本ブランチ（未 PR） | SVG・ordinal 等間隔ビューポート → **DOM ベースの暦スケール pan/zoom 水平タイムライン**へ全面再実装（左レーンガター／適応ルーラー／DOM マーカー／ベジェ因果エッジ／暦駆動の日付ピッカー popover／凡例・レーン密度・ラベルトグル）。幾何を純関数 5 モジュール＋`chronicleLayout` に分離。pan/zoom view を永続化。データ層・AI 注入・秘匿・MCP・RAG は無改変 | 2026-06-29 |

> 暦ライトが「P0〜P4g・全 12 PR master merged」であることは `docs/superpowers/specs/2026-06-28-chronicle-context-injection-design.md` 冒頭・`docs/superpowers/specs/2026-06-28-chronicle-full-calendar-design.md`「背景」に記録。

デフォルト位置: **Center-Bottom Dock（非表示）**。Timeline / Snippets / Attribution など他のステータスパネルとタブ切り替えで共存する（`panelRegions.ts:19` で `center-bottom`、`toolWindowDefaults.ts:51` で初期スロット `"BL"`）。

---

## パネル構造

縦方向に「ヘッダー → ツールバー →（任意）凡例 → DOM pan/zoom ビューポート（適応ルーラー＋左レーンガター＋トラック＋スクロールバー）→（任意）タイ線複合ビュー → 下部インスペクタ／無選択フッタ」を積む。暦エディタと AI 抽出はモーダル／ダイアログ、日付ピッカーは popover。

```
┌─────────────────────────────────────────────────────────────┐
│ A. PanelHeader  作中年表  [CalendarRange]        (Ctrl+Alt+K) │
├─────────────────────────────────────────────────────────────┤
│ B. ChronicleToolbar                                          │
│  [+新規][AI抽出] │[暦][↔タイ線]  …  [⚠整合n][因果][密度][ﾗﾍﾞﾙ][-z+][全体][凡例] │
│ （任意）凡例ストリップ: イベント/誕生/死亡/期間/オフページ/不確定/警告/因果矛盾 │
├─────────────────────────────────────────────────────────────┤
│ C. ChronicleViewport（DOM pan/zoom · 暦スケール）            │
│  作中時間│  ◀ 適応ルーラー（年/月/日/時/分 · major+minor） ▶ │
│  ┌gutter─┼──── track（drag=pan · wheel=zoom · grid lines）───┤
│  │(ｱﾊﾞﾀｰ)│   ╭─bezier 因果 (破線 / 矛盾=赤実線)─╮            │
│  │ アヤ ●│──[誕生▲ アヤ誕生]───[▭▭ 剣の修行]──◌(offpage)──   │
│  │ カイ ●│────────[● カイと出会う]──────[!警告]────────────  │
│  │ □王都 │  (場所レーン=角丸 · 未割当=点線)                  │
│  └───────┴───────────────[scrollbar thumb]──────────────────┘
├─────────────────────────────────────────────────────────────┤
│ D. ChronicleTieView（任意タブ · tieMode）  読む順×作中時間   │
├─────────────────────────────────────────────────────────────┤
│ E. ChronicleInspector（下部 · max-h≈348px）／無選択フッタ    │
│  ┌ ● title 入力 ──────────────────────────────────── [×] ┐  │
│  │ ⚠ conflicts（季節 / 年齢 / 因果 / 2か所同時）          │  │
│  │ レーン▼  場所▼  種別▼  日付の確度▼                     │  │
│  │ 開始 [粒度▼][📅 日時]   終了 [📅 日時 | 点/期間にする]  │  │
│  │ 原因(causes) リスト  [+ add ▼]                         │  │
│  │ ☑ AI に秘匿     開示シーン ▼（reveal_scene_id）        │  │
│  │ [↓刻む] [↑取込]（linkedSceneCount>0）         [🗑削除] │  │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

  （popover）ChronicleDatePicker … 年ナビ / 季節・月グリッド / 日グリッド(曜日見出し) / 時刻
  （モーダル）ChronicleCalendarEditor … 開始年・1年の日数・季節境界・月・曜日名
```

実装は `ChroniclePanel.tsx` がデータロード・状態（pan/zoom view・密度・ラベル・凡例・因果トグル）・CRUD ハンドラを束ね、`ChronicleViewport`（DOM タイムライン）/ `ChronicleRuler`（適応ルーラー）/ `ChronicleLaneGutter`（レーンガター）/ `EventMarker`（DOM マーカー）/ `ChronicleDatePicker`（暦 popover）/ `ChronicleToolbar`（ツールバー＋凡例）/ `ChronicleInspector`（選択 Event 編集）/ `ChronicleTieView`（タイ線）/ `ChronicleCalendarEditor`（暦）/ `ChronicleExtractDialog`（AI 抽出）を配置する。座標数学は純関数モジュール `chronicleAxis`（pan/zoom・実効日）/ `chronicleTicks`（適応ルーラー）/ `chronicleLanePack`（多段行詰め）/ `chronicleCausalBezier`（ベジェ因果）/ `laneColor`（安定 oklch）を `chronicleLayout` が束ねて供給する。

---

## A. ヘッダー / ツールバー

- **PanelHeader**: タイトル「作中年表」、アイコン `CalendarRange`（`panelIcons.ts:38`）。最大化・メニューは `data-panel-header` 標準（[[Grimodex_パネルヘッダー設計書]]）。
- **ツールバー操作**（`ChronicleToolbar.tsx` ← `ChroniclePanel.tsx` がハンドラを供給）:
  - `[+ 新規イベント]`: `uiCreateEvent`（tracked-write）を採番（`nextEventOrdinal` で既存 ordinal の max の次）して空 Event を追加。
  - `[AI 抽出]`: `ChronicleExtractDialog` を開く（AI 抽出ウィザード、後述 I）。
  - `[暦の設定]`: `ChronicleCalendarEditor` を開く（後述 G）。
  - `[↔ タイ線]`: `tieMode` をトグルして `ChronicleTieView` を表示（後述 D）。
  - `[⚠ 整合警告 n]`: 整合チェックで検出した issue 件数バッジ。クリックで先頭 issue を選択しビューを中央へ寄せる。
  - `[因果]`: 因果エッジ表示トグル。`[密度]`: レーン密度 compact/standard/roomy 循環。`[ラベル]`: マーカーラベル表示トグル。
  - `[- z +]` / `[全体]`: ズーム / 全体フィット。`chronicleAxis` の `zoomByCenter` / `fitAll` で `pxPerDay`・`viewStartDay` を更新。`[凡例]`: 凡例ストリップのトグル。
- **状態の正本**: pan/zoom view（`pxPerDay` / `viewStartDay`）・`selectedEventId` / `revisionCounter` ・`showOffpage` は `chronicleStore.ts`（Zustand）。pan/zoom は `setChronicleView` で global settings に永続化し、未設定なら初回計測時に全体フィット（ユーザー操作後は復元）。密度 / ラベル / 凡例 / 因果トグル / `tieMode` は `ChroniclePanel` のローカル `useState`、`calendar` は `useSeasonConflicts` フックが保持する。CRUD・暦更新・stamp/unstamp・participants・relations の各成功時に `revisionCounter` を bump して AI プロンプトの鮮度契約（後述）を満たす。

---

## B. ChronicleViewport（DOM pan/zoom タイムライン）

`ChronicleViewport.tsx` は **DOM ベースの暦スケール pan/zoom タイムライン**を描く（旧 SVG・ordinal 等間隔ビューポートを #本ブランチ で全面置換）。構成は「適応ルーラー（`ChronicleRuler`）＋（左レーンガター `ChronicleLaneGutter`＋トラック）＋スクロールバー」。トラックは `wheel`=ズーム / `drag`=パン / `ResizeObserver`=幅計測 を司り、座標は親が `buildChronicleLayout`（純関数）で算出した `layout` から描く。

- **x 座標（pan/zoom）**: `chronicleAxis.ts` が論理日番号 ↔ px を相互変換する。`effectiveDays` が各 Event に「実効日」を割り当て、全 Event に `startTime` が揃えば実暦の日数距離、揃わなければ ordinal 序列（**sequence モード**・ルーラーは「並び順」表示）にフォールバックする。`pxPerDay`・`viewStartDay` でパン/ズーム、`fitAll`/`zoomAt`/`panByPx`/`scrollGeom` を提供。
- **適応ルーラー**: `chronicleTicks.ts` の `adaptiveTicks` が、画面間隔が最小幅以上を保てる最も細かい暦刻み（年/月/日/時/分）を選び、各目盛りをプロジェクト暦（`dayNumberToDate`）で解決してラベル付けする。任意の月長・曜日長・季節境界に対応。major（粗グリッド）＋ minor を出す。
- **レーン**: `ChroniclePanel` が `primaryCodexId` ごとに 1 レーン（`null`/未知は `__unassigned` 点線）を組み、`chronicleLanePack.ts` の `packLanes` が横方向に重なるマーカーを多段の行へ詰める。左ガターは Codex アバター（人物=円 / 場所等=角丸 / 未割当=点線）＋名前＋件数。色は `laneColor.ts` の安定 oklch（id ハッシュ）。
- **警告**: 整合チェック統合の `issueIds`（後述）に含まれる Event のマーカーへ amber バッジ（`!`）を重畳する。
- **Timeline 連動**: `relatedIds`（Timeline 選択シーンに紐づく Event）は淡い accent リングで強調する。

---

## C. EventMarker（DOM トークン: point / interval / オフページ）

`EventMarker.tsx` が 1 Event を **DOM トークン**として描く（旧 SVG `<rect>`/`<circle>` を置換）。形状は `startTime` / `endTime` / scene リンク有無で決まる:

- **point**（`endTime = null`）: ピル。グリフは通常=塗り丸 / 誕生=三角 / 死亡=菱形 / オフページ=中空丸。
- **interval**（`endTime != null`）: 帯。幅は作中時間の長さ（`pxPerDay` × 日数）。
- **オフページ**（scene リンク 0）: 中空グリフ＋淡背景で「本編未記述の背景」を示す。
- 種別タグ（誕生/死亡）・秘匿タグ（`secret`）・警告バッジ（`!`）・選択/related リングを重畳。

`precision`（`EVENT_PRECISIONS`）でスタイルを変える: `exact`=実線 / `approx`=opacity≈0.94 / `unknown`=破線。色は lane（`primaryCodexId` 由来の安定 oklch）＋種別の意味色で、塗りは透明への `color-mix` で重ねダークモードでも破綻させない（accent=`var(--primary)`）。

---

## D. 因果エッジ（event_relations）と ChronicleTieView

### 因果エッジ（トラックの SVG オーバーレイ）

`chronicleCausalBezier.ts` の `buildCausalBezier` が `event_relations`（cause→effect）と `packLanes` の `centers`（eventId→{cx,cy}）から `BezierEdge[] = {causeId, effectId, d, arrowPoints, conflict}` を生成し、トラック上の SVG オーバーレイ（`pointer-events:none`）にベジェ曲線＋矢印として描く。

- 矛盾なし（`conflict=false`）: 破線 `stroke-muted-foreground/50 width=1.4 dasharray="4 3"`。
- 矛盾あり（`conflict=true`、effectTime < causeTime）: 実線赤 `stroke-red-500 width=2`。
- 描画順は `(causeId, effectId)` 昇順で決定的。

### タイ線複合ビュー（任意タブ）

`ChronicleTieView.tsx` は「読む順では前なのに作中では後」のズレを線の交差として可視化する任意ビュー（無改変）。`tieView.ts` の `buildTieView({scenes, events, links, width, padX, topY, bottomY})` が `TieViewModel = {sceneDots, eventDots, ties, topY, bottomY}` を返す。

- 上部 line（`topY`）= reading-order baseline。scene dot は `scene_events` でリンクされたシーン群を読む順ソートした x。
- 下部 line（`bottomY`）= 作中時間 baseline。event dot は ordinal 由来の x。
- tie line（`x1=scene, x2=event`・`stroke-primary/40`）が交差すると「読む順と作中時間の食い違い」が一目で分かる。

---

## E. ChronicleInspector（選択 Event 編集）

`ChronicleInspector.tsx`（選択 Event の下部編集パネル・`max-h≈348px`）。無選択時は件数・整合警告・新規ボタンのフッタを出す。フィールド:

- **title** 入力（先頭にレーン色ドット）＋ `[×]` 閉じる。
- **conflicts 警告バナー**: 当該 Event が `issueIds` に入っていれば季節 / 年齢 / 因果 / 2か所同時の警告を表示。
- **4 列グリッド**: レーン（主人物・任意 Codex の native select）/ 場所 / 種別（generic/birth/death）/ 日付の確度（exact/approx/unknown）。
- **開始 / 終了 日時**: 粒度 select（`EVENT_GRANULARITIES`）＋日時ボタン → `ChronicleDatePicker` popover を開く（後述 F）。終了は「点にする / 期間にする」で point ⇄ interval を切替。
- **AI 秘匿**: `secret` チェックボックス ＋ 開示シーン select（`reveal_scene_id`、空＝自動導出、後述「イベント AI 秘匿」）。
- **原因(causes)**: `event_relations` の cause チップ＋add select。
- **[↓ シーンへ刻む] / [↑ シーンから取込]**: `linkedSceneCount > 0` のとき表示。Timeline 連動の明示片方向操作（後述）。
- **[🗑 削除]**: Event 削除（cascade で participants / scene_events / relations も）。

---

## F. ChronicleDatePicker / EventDateEditor / CodexEntryPicker

- **ChronicleDatePicker.tsx**（新・popover）: インスペクタの日時ボタンから開く暦駆動の日付/時刻ピッカー。粒度に応じて年ナビ・季節グリッド・月グリッド・日グリッド（曜日見出し）・時刻グリッドを出し分け、`chronicleTime`（`dateToDayNumber`/`dayNumberToDate`/`formatChronicleDate`/`seasonOf`）で day 番号・分へ変換する。月長/曜日長/季節境界をプロジェクト暦から算出するため任意のファンタジー暦に対応し、月/年ナビ時は遷移先月長に日付をクランプする（桁あふれ防止）。
- **EventDateEditor.tsx**: インライン日付入力。Chronicle インスペクタは ChronicleDatePicker へ移行したが、本コンポーネントは **Scene 日付共有**（`SceneDateEditor` / `SceneMetaPanel` / `TimelineInspector`）で引き続き再利用される（後述）。
- **CodexEntryPicker.tsx**: 検索付きの codex select（`type` フィルタ対応）。本パネルでは現状未使用だが共有部品として残置。

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

- `proposeEvents({scenes:[{sceneId,title,bodyText,orderIndex}], existingTitles})` → `EventProposal[]`。`existingTitles` を LLM に注入して既存イベントとの重複を排除。
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

伏線（foreshadows.secret）と同 idiom で、イベントを **オプトインで AI から隠す**。default は表示（年表注入の存在意義＝AI に背景を渡すこと）。

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

- **索引**（`events_index.rs`）: `event_chunks`（PK=event_id・1 イベント 1 ベクトル）。`build_event_embed_text(title, note, primary_name, location_name, participants)` を埋め込み、`content_hash` は title/kind/note/名前ベース（id ではない）で決定的。TX 内 re-SELECT・再 hash で race 対策。参加者／場所 codex のリネームは当該 Event が次に mutate されるまで反映されない（cross-entity eventual consistency）。
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
CREATE TABLE event_chunks (        -- RAG dense索引・PK=event_id(1イベント1ベクトル)
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
| `src/features/chronicle/ChroniclePanel.tsx` | パネルトップ。状態（pan/zoom view・密度・ラベル・凡例・因果）・データロード・CRUD・`issueIds`/`relatedIds` 集約・各サブビュー配線 |
| `src/features/chronicle/ChronicleViewport.tsx` | DOM pan/zoom タイムライン（ルーラー＋ガター＋トラック＋スクロールバー・wheel/drag/ResizeObserver） |
| `src/features/chronicle/ChronicleRuler.tsx` | 適応ルーラー（major/minor 目盛り＋刻み幅ラベル） |
| `src/features/chronicle/ChronicleLaneGutter.tsx` | 左レーンガター（アバター＋名前＋件数） |
| `src/features/chronicle/ChronicleToolbar.tsx` | ツールバー＋凡例ストリップ |
| `src/features/chronicle/ChronicleInspector.tsx` | 選択 Event 編集・conflicts・日時ピッカー起動・causes・stamp/pull/delete・無選択フッタ |
| `src/features/chronicle/ChronicleDatePicker.tsx` | 暦駆動の日付/時刻ピッカー popover（年/季節/月/日/時刻・月長クランプ） |
| `src/features/chronicle/ChronicleCalendarEditor.tsx` | 暦エディタ（months/weekday/startYear 行エディタ） |
| `src/features/chronicle/ChronicleExtractDialog.tsx` | AI 抽出ウィザード（フォルダ選択→解析→確認→取込） |
| `src/features/chronicle/ChronicleTieView.tsx` | タイ線複合ビュー SVG（読む順×作中時間） |
| `src/features/chronicle/EventMarker.tsx` | DOM マーカートークン（point/interval/オフページ・種別/秘匿/警告タグ・precision style） |
| `src/features/chronicle/EventDateEditor.tsx` | インライン日付入力（暦駆動）。現在は Scene 日付共有で再利用 |
| `src/features/chronicle/CodexEntryPicker.tsx` | 人物/場所 select（type フィルタ・共有部品） |
| `src/features/chronicle/SceneDateEditor.tsx` | Scene 日付エディタ（`tree_nodes.chronicle*` へマップ） |
| `src/features/chronicle/chronicleStore.ts` | Zustand（pxPerDay/viewStartDay〔pan/zoom 永続〕・showOffpage・selectedEventId・revisionCounter・`setChronicleView`/`bumpRevision`・legacy zoom/scrollOffset）。calendar=`useSeasonConflicts`・密度/ラベル/凡例/因果/tieMode=ChroniclePanel ローカル `useState` |
| `src/features/chronicle/chronicleTime.ts` | 暦エンジン（`dayNumberToDate`/`dateToDayNumber`/`formatChronicleDate`/`seasonOf`/`nextEventOrdinal` 他） |
| `src/features/chronicle/chronicleAxis.ts` | pan/zoom 変換・`effectiveDays`（実暦軸 / sequence モード）・scrollbar 幾何（純関数・テスト gate） |
| `src/features/chronicle/chronicleTicks.ts` | `adaptiveTicks`（暦対応の適応ルーラー目盛り・任意暦対応） |
| `src/features/chronicle/chronicleLanePack.ts` | `packLanes`（レーン内の多段行詰め・marker/edge 中心算出） |
| `src/features/chronicle/chronicleCausalBezier.ts` | `buildCausalBezier`（因果エッジのベジェ＋矢印幾何） |
| `src/features/chronicle/laneColor.ts` | `laneColorFor`（codex id → 安定 oklch）・tint/ring ヘルパ |
| `src/features/chronicle/chronicleLayout.ts` | `buildChronicleLayout`（上記幾何モジュールを束ねる純オーケストレータ） |
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
| 2026-06-29 | **パネル UI 再設計に同期**（Claude Design import）。ビューポートを SVG・ordinal 等間隔から **DOM 暦スケール pan/zoom タイムライン**へ全面置換: 適応ルーラー / 左レーンガター / DOM マーカー / ベジェ因果エッジ / 暦ピッカー popover / 凡例・密度・ラベル。幾何を純関数 `chronicleAxis`/`chronicleTicks`/`chronicleLanePack`/`chronicleCausalBezier`/`laneColor` ＋ `chronicleLayout` に分離（旧 `chronicleTimeScale`/`chronicleLaneModel`/`chronicleEdges` は廃止）。pan/zoom view を `chronicleStore` で永続化。テーマは monochrome token（accent=`var(--primary)`）。データ層・AI 注入・秘匿・MCP・RAG・Scene 日付共有は無改変。 |
