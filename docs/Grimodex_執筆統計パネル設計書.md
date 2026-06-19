# Grimodex 執筆統計パネル設計書

## 概要

執筆統計パネル（Writing Stats Panel）は、プロジェクトの執筆活動を可視化するダッシュボード。日次の執筆量・連続執筆日数（streak）・GitHub 風ヒートマップ・一日の目標文字数（daily-goal）・完走ペースメーカーをまとめて表示し、「今日どれだけ書いたか」「習慣が続いているか」「いつ完走できそうか」を俯瞰させる。人間／AI／不明の文字数内訳と AI 使用量の要約も併記する。

デフォルト位置: Center-Bottom Dock（非表示）。Snippets / Attribution など他のステータスパネルとタブ切り替えで共存する。

データソース:

- **執筆量・ヒートマップ・streak**: `change_events` テーブル（`domain = 'editor'`）。各イベントの `payload`（ProseMirror steps の JSON）から挿入文字数を best-effort で復元する。
- **現在の原稿総文字数（ペースメーカーの分子）**: `treeStore` の `charCounts`（シーンごとの net 文字数キャッシュ）の合計。
- **文字数の帰属内訳（人間／AI／不明）**: Attribution パネルと同じ `authorship_spans`（シーン本文集計）。[[Grimodex_Attributionパネル設計書]] を参照。
- **AI 使用量の要約**: `ai_usage` テーブル（生成回数・概算コスト）。

統計の計算はすべて `now`（unix ms）を注入する純関数として切り出されており、タイムゾーンや「今日」に依存するロジックを決定的にテストできる。日付の丸めは UTC ではなくローカルタイムゾーン基準で行う。

---

## パネル構造

縦 1 カラムのスクロール可能なダッシュボード。上から「サマリーカード群」「本日の目標」「完走ペースメーカー」「ヒートマップ」「文字数の内訳」「AI 使用量」の順に並ぶ。Center-Bottom Dock の横長レイアウトに収まるよう、サマリーカードは 2 カラムグリッドで配置する。

```
┌─────────────────────────────────────────────────────────────┐
│ A. Header                                                   │
│ 執筆統計                                          [↻ Refresh]│
├─────────────────────────────────────────────────────────────┤
│ B. Summary cards (2-col grid)                               │
│ ┌────────────┐ ┌────────────┐                              │
│ │ 連続執筆   │ │ 今日       │                              │
│ │ 5 日       │ │ 1,240 字   │                              │
│ └────────────┘ └────────────┘                              │
│ ┌────────────┐ ┌────────────┐                              │
│ │ 直近7日    │ │ 直近30日   │                              │
│ │ 8,420 字   │ │ 31,900 字  │                              │
│ └────────────┘ └────────────┘                              │
│ ┌────────────┐ ┌────────────┐                              │
│ │ 最長連続   │ │ 執筆日数   │                              │
│ │ 12 日      │ │ 47 日      │                              │
│ └────────────┘ └────────────┘                              │
├─────────────────────────────────────────────────────────────┤
│ C. 本日の目標                                       [✎]     │
│ 1,240 / 2,000 字                       あと 760 字          │
│ [██████████████░░░░░░░░░]                                   │
├─────────────────────────────────────────────────────────────┤
│ D. 完走ペースメーカー                               [✎]     │
│ 31,900 / 100,000 字                  あと 68,100 字         │
│ [███████░░░░░░░░░░░░░░░░░]                                   │
│ 直近ペース 1,063 字/日                                       │
│ 完走予定 2026-09-12（あと 84 日）                            │
│ ───────────────────────────                                 │
│ 締切 2026-08-31 まで：1 日 968 字 必要                       │
│ 現ペースで間に合います                                       │
├─────────────────────────────────────────────────────────────┤
│ E. 執筆ヒートマップ（直近53週）                             │
│      Jan      Feb      Mar  ...                              │
│ 月 □□■■□□□■■■□□...                                         │
│ 水 □■□□■■□□■□□□...                                         │
│ 金 □□□■■□■■□□■□...                                         │
│                              少 □▫▪■■ 多                    │
│ 濃いほど多く書いた日（挿入文字数ベースのおおよその目安）     │
├─────────────────────────────────────────────────────────────┤
│ F. 文字数の内訳                                             │
│ [████████████████░░░░░░▒▒▒▒]                               │
│  ■ 人間 67%  ■ AI 22%  ■ 不明 11%                          │
├─────────────────────────────────────────────────────────────┤
│ G. AI 使用量                          生成 18 回 · ≈$0.42   │
└─────────────────────────────────────────────────────────────┘
```

実装は `WritingStatsPanel.tsx` がデータロードと統計計算を担い、`StatCard` / `DailyGoalProgress` / `FinishLinePacemaker` / `Heatmap` / `BreakdownBar`（Attribution と共有）の各サブコンポーネントを束ねる。

データが無い（`totalEvents === 0`）場合は「まだ執筆記録がありません。本文を書くとここに統計が表示されます。」のプレースホルダーのみを表示する。

---

## A. ヘッダー

- **パネルタイトル**: 「執筆統計」
- **再読み込み（↻）ボタン**: `reloadToken` をインクリメントして `change_events` の再集計をトリガーする。ロード中はアイコンが回転（`animate-spin`）する。

---

## B. サマリーカード

`StatCard`（ラベル + 値）を 2 カラムグリッドで 6 枚並べる。値はすべて `tabular-nums`。

| カード | 値 | 備考 |
|--------|-----|------|
| 連続執筆（streak） | `currentStreak` 日 | アクセント色（`text-primary`）。今日または昨日から遡った連続執筆日数 |
| 今日 | 本日の挿入文字数 | 字数復元が不能なら「操作回数」へフォールバック |
| 直近7日 | 過去 7 日合計 | 同上 |
| 直近30日 | 過去 30 日合計 | 同上 |
| 最長連続 | `longestStreak` 日 | ウィンドウ内の最長連続執筆日数 |
| 執筆日数 | `activeDays` 日 | 何らかの編集があった日の総数（`byDay.size`） |

### 単位フォールバック（字 / 回）

`change_events.payload` から挿入文字数を復元できなかった場合（後述「文字数復元」参照）、`hasCharData` が `false` になり、字数系の指標は「操作回数（編集トランザクション数）」表示に切り替わる。単位ラベルも「字」→「回」へ切り替わる。

---

## C. 本日の目標（daily-goal）

`DailyGoalProgress` コンポーネント。本日の執筆量を「一日の目標文字数」に対する進捗バーで表示する。

### 二段構成（プロジェクト固有 + グローバル既定）

目標値は二段で解決する。

| 設定キー | スコープ | 役割 |
|----------|----------|------|
| `goal.dailyChars` | project | このプロジェクト固有の一日の目標文字数 |
| `goal.dailyDefaultChars` | global | 全プロジェクト共通の既定値 |

解決ロジック（`DailyGoalProgress.tsx`）:

```
effectiveGoal = projectGoal > 0 ? projectGoal : defaultGoal
usingDefault  = projectGoal <= 0 && defaultGoal > 0
```

プロジェクト固有値が 0（未設定）のときグローバル既定にフォールバックする。グローバル既定も使われている場合は「既定の目標を使用中」のヒントを表示する。両方 0 のときは進捗カードの代わりに「一日の目標を設定」ボタン（破線枠）を表示する。

### インライン編集

鉛筆アイコン（✎）でインライン編集モードに入る。編集できるのは**プロジェクト固有値（`goal.dailyChars`）のみ**で、グローバル既定は変更しない。空欄で保存すると 0 が書き込まれ、グローバル既定へ戻る（「空欄にすると既定値を使用します」）。`Enter` で確定、`Escape` でキャンセル。入力欄には現在のグローバル既定値がプレースホルダーとして表示される。

### 進捗計算

`computeGoalProgress(current, goal)`（純関数）が次を返す。

| フィールド | 内容 |
|------------|------|
| `hasGoal` | `goal > 0` か |
| `goal` | 有効目標 |
| `current` | 本日の実績（負値は 0 にクランプ） |
| `remaining` | `max(0, goal - current)` |
| `pct` | `min(100, round(current / goal * 100))` |
| `reached` | `current >= goal` |

達成時は「目標達成！🎉」、進捗バーは満タンのアクセント色（`bg-primary`）になる。

> **AI 生成分の扱い**: 本日の実績 `current` は `change_events` 由来の挿入文字数で、AI 生成・インライン AI・ビート展開による挿入も含む。執筆統計の recorder は `programmaticInsert`（AI ステップ共有）を bail しない方針で、AI 分を含めるのはユーザー決定による。

`hasCharData = false`（字数復元失敗）のときは「本日の字数データがありません（0 と表示）」の注記を出す。

---

## D. 完走ペースメーカー（finish-line pacemaker）

`FinishLinePacemaker` コンポーネント。原稿全体の目標総文字数と現在総量・直近ペースから、完走予定日と（締切があれば）必要ペース・間に合うかを示す。`computeGoalProgress`（本日の目標）の累積版にあたる。

### 入力

| 入力 | 取得元 |
|------|--------|
| 目標総文字数 `target` | 設定 `goal.manuscriptTargetChars`（project スコープ、0 = 未設定） |
| 締切 `deadlineKey` | 設定 `goal.manuscriptDeadline`（project スコープ、`"YYYY-MM-DD"` のローカル日付、空 = 未設定） |
| 現在総量 `current` | シーン `charCount`（net）の合計（`charCounts` マップ） |
| 直近ペース `pace` | `last30Chars / 30`（直近 30 日の挿入文字数の暦日平均、概算） |

目標・現在・残量は scene の `charCount`（net）由来で常に正確。一方ペースと完走予定は編集イベント由来の概算（挿入のみ、削除を差し引かない）なので、`hasCharData = false` のときは予測を伏せる。

### インライン編集

鉛筆アイコン（✎）で目標文字数と締切（`type="date"`）を同時に編集する。どちらもプロジェクト固有値。`Enter` で確定、`Escape` でキャンセル。目標未設定時は「完走目標を設定」ボタン（破線枠）を表示する。

### 計算（`computeFinishLineProgress`）

純関数 `computeFinishLineProgress(input)` が以下を返す（`target <= 0` のときは `hasTarget = false` を返し、締切の残り日数だけは設定されていれば返す）。

| フィールド | 内容 |
|------------|------|
| `hasTarget` | `target > 0` か |
| `target` / `current` / `remaining` | 目標・現在総量（0 クランプ）・残り（`max(0, target - current)`） |
| `pct` / `reached` | 達成率（0..100）・達成フラグ（`current >= target`） |
| `pace` | 直近の暦日平均ペース（0 クランプ） |
| `daysToFinish` | 現ペースで完走に要する残り日数 `ceil(remaining / pace)`。達成済みは 0、ペース 0 等で算出不能なら `null` |
| `projectedFinishKey` | 完走予定日 `shiftDayKey(today, daysToFinish)`。達成済み / 算出不能は `null` |
| `hasDeadline` | 締切が設定されているか |
| `daysUntilDeadline` | 締切まで残り日数（今日基準、過ぎていれば負）。締切なしは `null` |
| `requiredPace` | 締切に間に合わせるのに必要な 1 日字数 `ceil(remaining / daysUntilDeadline)`。締切が今日 / 過去なら残り全部を即日。締切なし / 達成済みは `null` |
| `deltaDays` | 完走予定が締切に対し何日 遅れる(正)/早い(負) か（`daysToFinish - daysUntilDeadline`）。算出不能は `null` |
| `onTrack` | 現ペースで締切に間に合うか（`deltaDays <= 0`）。ペース 0 で残量ありなら `false` |

日数差はミリ秒単純割りではなく**ローカル正午アンカー**（`new Date(y, m-1, d, 12, 0, 0, 0)`）で丸めて算出し、DST の ±1h を吸収して日数がずれないようにする。

### 表示

- 進捗バー + 「{current} / {target} 字」「あと {remaining} 字」
- `hasCharData` かつ未達なら「直近ペース {pace} 字/日」
- 完走予定日「完走予定 {date}（あと {days} 日）」。ペース 0 等で算出不能なら「直近に執筆がないため完走予定を出せません」
- `hasCharData = false` のときは「字数データが不足しているためペースを概算できません」（予測は伏せる）
- 締切がある場合は区切り線の下に「締切 {date} まで：1 日 {pace} 字 必要」と、間に合うかの判定行（`onTrack` ならアクセント色で「現ペースで間に合います」、遅れなら破壊色で「現ペースだと {days} 日遅れ」、ペース 0 なら「現ペースでは間に合いません」）

達成時は「完走！🎉」を表示する。

---

## E. ヒートマップ

`Heatmap` コンポーネント。GitHub のコントリビューショングラフ風グリッド。

### グリッド構造

- 直近 **53 週**（列）× **7 日**（行、日曜=0 .. 土曜=6）
- 最終列が今日を含み、グリッド末尾は今日を含む週の土曜まで埋める（列が必ず 7 セルになる）
- データウィンドウは ~371 日（53 × 7）。先頭週の startKey より前と今日より後（未来日）の埋めセルは `inRange = false`（透明、無着色、`aria-hidden`）
- 曜日ラベルは月 / 水 / 金のみ表示。月ラベルは各列の先頭日の月が変わる最初の列に置く（ロケール短縮月名）
- 各セルは `title` 属性に `"{日付} — {値}{単位}"` のツールチップ
- 下部に「少 □▫▪■■ 多」の 5 段階凡例

### 強度バンド（絶対量・相対最大ではない）

セルの濃さ（0..4 のレベル）は `intensityLevel(value, metric)` で決める。**ウィンドウ内最大値に対する相対比ではなく、固定の絶対バンド**を使う。

| metric | バンド境界（以上） | レベル割り当て |
|--------|--------------------|----------------|
| `chars` | `[100, 400, 1200]` | 1..99→1 / 100..399→2 / 400..1199→3 / 1200+→4 |
| `events` | `[3, 10, 30]` | 1..2→1 / 3..9→2 / 10..29→3 / 30+→4 |

値 0 以下は level 0（無着色）。

> **設計上の経緯（重要）**: 旧実装は「ウィンドウ内最大値」への相対比でレベルを決めていた。これだと閑散期は 1 回のちょっとした編集が最大値＝最濃（level 4）になり、ほとんど書いていない日まで真っ黒に塗られて見えた（既定 light テーマの `--primary` が near-black なため特に顕著）。GitHub と同様、絶対量のバンドでレベルを決め、些細な日は淡色（level 1）に留める。相対最大方式への復帰は禁止。

レベルの CSS クラスは `bg-muted` / `bg-primary/20` / `bg-primary/40` / `bg-primary/65` / `bg-primary/90` の静的配列で持つ（Tailwind JIT が動的組み立てを purge するため）。

### metric の切り替え

`hasCharData = true` なら `chars`（挿入文字数）、`false` なら `events`（doc 変更トランザクション数）を強度の元に使う。`Heatmap.max`（ピーク日の値）は参考値として返すだけで、level 計算には使わない。

---

## F. 文字数の内訳（帰属）

`data.attribution.total > 0` のとき、人間 / AI / 不明の文字数を `BreakdownBar`（Attribution パネルと共有のスタック棒）と凡例（色付きスウォッチ + ラベル + %）で表示する。

- データソースは Attribution と同じ `authorship_spans`（シーン本文集計、`loadProjectAttributionStats(sceneIds)`）。集計仕様は [[Grimodex_Attributionパネル設計書]] を正とする。
- 色は `attributionColors.ts` の正本トークン `ATTRIBUTION_COLOR_VARS`（`var(--attribution-human/ai/unknown)`）を使う。
- 凡例の % は `round(value / total * 100)`。

> **AI 生成分の扱い**: ここでの「AI」は AuthorshipMark の `source: 'ai'` 文字数。Detail / Phase 由来のスパンや Map Sticky の AI 文字数は本文集計に含まれない（[[Grimodex_Attributionパネル設計書]]「対象エンティティ」参照）。

---

## G. AI 使用量（要約）

`data.usage.totalCount > 0` のとき、フッターに AI 生成の要約を 1 行で表示する。

- データソースは `ai_usage` テーブルの `getProjectUsageSummary(projectId)`（`ProjectUsageSummary`）。
- 「生成 {totalCount} 回」を表示し、`totalCostUsd > 0` なら「· {≈}{コスト}」を併記する。`anyCostEstimated` が立っているとき（料金表に無いモデル等で概算した場合）は先頭に「≈」を付ける。
- 取得に失敗しても `null` にフォールバックしてパネル全体は壊さない。

---

## データロードと計算

### ロード（`loadWritingStatsData`）

`WritingStatsPanel` の `useEffect` が、パネルがアクティブ（`isActive`）かつ `projectId` がある間だけ `loadWritingStatsData(projectId, sceneIds, now)` を呼ぶ。hidden の間は集計クエリ（payload の JSON parse を含む）を bail し、再アクティブ化や deps 変化で読み直す。3 つのクエリを並列実行する（すべて Drizzle 経由、生 SQL 禁止）:

1. `change_events`（`domain = 'editor'`、直近 `WINDOW_DAYS = 371` 日）の `timestamp` / `payload`
2. `loadProjectAttributionStats(sceneIds)`（帰属内訳）
3. `getProjectUsageSummary(projectId)`（AI 使用量、失敗時 `null`）

再集計のトリガーは `[isActive, projectId, sceneIdsKey, reloadToken]`。`sceneIdsKey`（`sceneIds.join(",")`）でシーンの追加・削除に追従する。`change_events` 自動保存完了時の自動再フェッチはせず、シーン構成変化と明示的な Refresh ボタンで読み直す。

### ウィンドウ（~53 週）

ヒートマップ幅に合わせ直近 371 日に絞る。古い payload を全件 JSON.parse するのを避け、クエリも `idx_change_events_project_ts` インデックスに素直に乗せる。全期間の正確な字数が必要になれば別途 Rust 集計 / 日次スナップショットへ（Phase 2、未実装）。

### 文字数復元（`insertedCharsFromPayload`）

`change_events.payload` は `{ steps: ProseMirrorStepJSON[] }`。net 増減は保存されていないため、`step.slice.content` ツリーを再帰的に辿り、`type === 'text'` ノードの `text.length` を合算して**挿入文字数を best-effort で概算**する（削除は差し引かない）。形が想定外 / parse 失敗なら 0 を返す（その結果 `hasCharData = false` となり UI は「操作回数」表示にフォールバックする）。

### 日次集計（`computeWritingStats`）

`WritingEvent[]`（`{ timestamp, chars }`）を `localDayKey`（ローカルタイムゾーンの `"YYYY-MM-DD"`）でバケットし、日ごとの `chars` / `events` を `byDay` マップに集計する。`today` / `last7` / `last30` のウィンドウ和は `shiftDayKey`（`Date` のフィールド正規化で前後移動、DST 対応）で N 日遡って合算する。

### streak 計算

- `computeCurrentStreak`: 起点を今日（未執筆なら昨日）に取り、連続する執筆日を遡って数える。「今日まだ書いていない」だけで streak が消えないよう昨日起点を許容する。今日も昨日も未執筆なら 0。
- `computeLongestStreak`: `byDay` のキーをソートし、連続する run の最大長を返す。

### ヒートマップ構築（`buildHeatmap`）

前述 E のグリッド構造を組む。`stats.hasCharData` で metric を選び、各セルに `intensityLevel` で 0..4 のレベルを付与する。

---

## 状態管理

| 状態 | 所在 | 内容 |
|------|------|------|
| `data` | `WritingStatsPanel`（`useState`） | `WritingStatsData`（events / attribution / usage） |
| `now` | `WritingStatsPanel`（`useState`） | 集計のスナップショット時刻（ロード成功時に固定） |
| `loading` / `reloadToken` | `WritingStatsPanel`（`useState`） | ロード中フラグ / 再集計トークン |
| `currentChars` | `useMemo` | シーン `charCounts` の合計（ペースメーカーの分子） |
| `stats` / `heatmap` | `useMemo` | `computeWritingStats` / `buildHeatmap` の結果 |
| `goal.dailyChars` / `goal.dailyDefaultChars` | `DailyGoalProgress`（`useSettingNumber`） | 本日の目標（project + global） |
| `goal.manuscriptTargetChars` / `goal.manuscriptDeadline` | `FinishLinePacemaker`（`useSettingNumber` / `useSettingControl`） | ペースメーカー目標・締切（project） |
| `editing` / `draft` 系 | 各コンポーネント（`useState`） | インライン編集の一時状態 |

プロジェクト横断のツリー状態（`projectId` / `nodes` / `charCounts`）は Zustand の `useTreeStore` から購読する。

---

## 設定キー

| キー | スコープ | 既定値 | 役割 |
|------|----------|--------|------|
| `goal.dailyDefaultChars` | global | `"0"` | 一日の目標文字数の全プロジェクト共通既定 |
| `goal.dailyChars` | project | `"0"` | 一日の目標文字数のプロジェクト固有値（0 で既定へフォールバック） |
| `goal.manuscriptTargetChars` | project | `"0"` | 原稿全体の目標総文字数（0 = 未設定） |
| `goal.manuscriptDeadline` | project | `""` | 完走締切（`"YYYY-MM-DD"` ローカル日付、空 = 未設定） |

スコープ定義は `src/features/settings/types.ts` の `KEY_SCOPE` / `DEFAULT_SETTINGS`。global は global-settings.json の userPreferences、project は `project_settings` テーブルに格納される。

---

## レイアウト統合

- パネル ID: `writing-stats`（`panelIds.ts` / `layoutStore` の `PanelId`）
- リージョン: **Center-Bottom**（`panelRegions.ts` の `PANEL_REGION_MAP`）
- トグル対象パネル一覧（`TOGGLEABLE_PANELS`）に登録済み
- 新規 tool-window パネルの追加要件として、全レイアウトプリセット（`layoutPresets.ts`）への登録と `validateLayoutState` を満たす（既存パネル追加時の規約）

---

## キーボードショートカット

| ショートカット | 動作 |
|----------------|------|
| `Ctrl+Alt+W`（macOS: `⌘+Alt+W`） | 執筆統計パネルにフォーカス / トグル |

`keybindings.ts` の `focusWritingStats` コマンド（`defaultBinding: "Mod+Alt+W"`、`panel: "writing-stats"`）と `panelRegions.ts` の `KEYBOARD_SHORTCUT_MAP` で定義。`Mod` は `matchesMod` により macOS で `⌘`、その他で `Ctrl` に解決される。

---

## データモデル

執筆統計が直接読むテーブルは `change_events`。執筆量・ヒートマップ・streak のすべてがこの編集イベントログに依存する。

```sql
CREATE TABLE change_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid   TEXT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id    TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
  domain      TEXT NOT NULL,   -- 'editor'|'codex'|'snippet'|'grid'|'map'|'synopsis'|'intent'|'beat'|'chat'|'layout'|'prose'
  op_type     TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  payload     TEXT NOT NULL,   -- { steps: ProseMirrorStepJSON[] } 形式の JSON
  session_id  TEXT NOT NULL,
  sequence    INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL, -- unix ms
  prev_hash   TEXT NOT NULL,    -- sha256 hex（drizzle sqlite-proxy が BLOB を往復できないため hex TEXT）
  hash        TEXT NOT NULL
);

CREATE INDEX        idx_change_events_project_ts  ON change_events(project_id, timestamp);
CREATE INDEX        idx_change_events_scene_ts    ON change_events(scene_id, timestamp);
CREATE UNIQUE INDEX uq_change_events_project_seq  ON change_events(project_id, sequence);
CREATE UNIQUE INDEX uq_change_events_project_uid  ON change_events(project_id, event_uid);
```

執筆統計は `domain = 'editor'` のイベントのみを `idx_change_events_project_ts` 経由で `(project_id, timestamp >= cutoff)` で絞り込む。テーブル定義・DDL・関連テーブル（`state_snapshots` 等）の正本は [[Grimodex_統合DBスキーマ]] の `change_events` 節を参照。

帰属内訳が読む `authorship_spans`、AI 使用量が読む `ai_usage` の定義も [[Grimodex_統合DBスキーマ]] を正とする。

---

## AI 生成分の扱い（まとめ）

執筆統計における AI 生成テキストの扱いは指標ごとに分かれる。

| 指標 | AI 生成分の扱い |
|------|------------------|
| 今日 / 直近7日 / 直近30日 / ヒートマップ / streak | **含める**。`change_events`（`domain='editor'`）由来で、AI / インライン AI / ビート展開による挿入も執筆量として計上する。recorder は `programmaticInsert` を bail しない（ユーザー決定）。 |
| 本日の目標進捗 / 完走ペースメーカーの分子 | **含める**。前者は本日の挿入文字数、後者はシーン `charCount`（net）合計で、いずれも AI 分を区別しない。 |
| 文字数の内訳（F） | **区別する**。`authorship_spans` の `source` で人間 / AI / 不明を分離表示する。 |
| AI 使用量（G） | AI 生成のメタ情報（回数・コスト）を `ai_usage` から別途集計する。 |

つまり「どれだけ書いたか」系の量的指標は AI 分込み、「誰が書いたか」系の質的内訳は帰属で分離する、という二本立てになっている。

---

## 実装ファイル配置

| ファイル | 役割 |
|----------|------|
| `src/features/writing-stats/WritingStatsPanel.tsx` | ルートパネル。データロード・統計計算・サブコンポーネントの配置 |
| `src/features/writing-stats/deriveStats.ts` | 日次集計・streak・ヒートマップ構築・絶対バンド強度・本日の目標進捗の純関数群 |
| `src/features/writing-stats/finishLine.ts` | 完走ペースメーカーの純関数（`computeFinishLineProgress`） |
| `src/features/writing-stats/writingStatsQuery.ts` | DB ロード（`change_events` / 帰属 / AI 使用量）と payload からの文字数復元 |
| `src/features/writing-stats/DailyGoalProgress.tsx` | 本日の目標（二段解決・インライン編集・進捗バー） |
| `src/features/writing-stats/FinishLinePacemaker.tsx` | 完走ペースメーカー UI（目標・締切のインライン編集・予測・締切判定） |
| `src/features/writing-stats/Heatmap.tsx` | GitHub 風ヒートマップの描画 |
| `src/features/layout/panelRegions.ts` | `writing-stats` → center-bottom、`Ctrl+Alt+W` |
| `src/features/settings/keybindings.ts` | `focusWritingStats` コマンド（`Mod+Alt+W`） |
| `src/features/settings/types.ts` | `goal.*` 設定キーのスコープ・既定値 |
| `src/locales/{ja,en}.json` | `writingStats.*` の UI 文言 |

テストは各 `*.test.ts(x)`（`deriveStats` / `finishLine` / `writingStatsQuery` / `DailyGoalProgress` / `FinishLinePacemaker` / `WritingStatsPanel`）に同階層で配置。純関数は `now` 注入で決定的にテストする。

---

## 既存設計書との整合

### [[Grimodex_Attributionパネル設計書]]

文字数の内訳（F）のデータソース（`authorship_spans`）・集計（`loadProjectAttributionStats`）・色トークン（`ATTRIBUTION_COLOR_VARS`）・`BreakdownBar` コンポーネントは Attribution 設計書を正とする。執筆統計は本文（シーン）集計のみを再利用し、Detail / Phase / Map Sticky レーンは含めない。

### [[Grimodex_統合DBスキーマ]]

`change_events` / `authorship_spans` / `ai_usage` / `state_snapshots` のテーブル定義・DDL・インデックスは統合 DB スキーマ設計書を正とする。

### レイアウト設計書

パネル配置（Center-Bottom Dock、非表示既定）・`Ctrl+Alt+W` でのフォーカス / トグル・全プリセット登録要件はレイアウト設計書の配置ルールに従う。

---

## 未実装 / 今後の整備

- 全期間の正確な字数集計（Rust 集計 / 日次スナップショット = Phase 2）。現状はヒートマップ幅に合わせ直近 371 日のみ集計する。
- `change_events` の payload は net 増減を保存しないため、字数は「挿入のみの概算」（削除を差し引かない）。
- `change_events` 自動保存完了時の自動再フェッチは未配線（シーン構成変化と明示的 Refresh で更新）。
- 絶対バンドのしきい値（`CHAR_BANDS` / `EVENT_BANDS`）はチューニング可能な定数として固定値で出荷。

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-06-20 | 新規作成（出荷済み機能の追従文書化）。日次文字数・ヒートマップ（絶対バンド強度）・連続日数（streak）・一日の目標文字数（daily-goal: global + project 二段）・完走ペースメーカー（残量 ÷ 直近ペース → 完走予定日 / 締切必要ペース）・AI 生成分の扱いを記載。実装（`src/features/writing-stats/`）に準拠。 |
