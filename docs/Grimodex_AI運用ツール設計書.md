# Grimodex AI運用ツール設計書

## 概要

AI運用ツール群（#124）は、AI を「使って書く」ことに付随する運用面（コスト・再利用・比較・開示）を支える4つのサブツールを1本に束ねた機能群。執筆機能そのものではなく、AI 生成を**計測・管理・透明化する**ための補助レイヤーである。

| サブツール | 役割 | 配置 |
|-----------|------|------|
| ① トークン予算 ETA | 月予算と消費から枯渇を予測する（表示のみ・非ブロッキング） | Settings → Usage カテゴリ |
| ② プロンプト再利用ライブラリ | 再利用プロンプトを保存し、チャット入力から呼び出す | Settings → AI カテゴリ（project）＋チャット入力ピッカー |
| ③ モデル/プロンプト A/B 比較 | 同一プロンプトを2構成で並列生成し、見比べて採用する | Settings → AI カテゴリ（既定値）＋チャット/インライン両モーダル |
| ④ 生成出所分析 | どのモデル・どの生成種別が本文に寄与したかを集計 | Attribution（プロジェクトビュー）＋制作過程開示エクスポート |

データソースは横断トークン使用量台帳 `ai_usage`（N4）を中心に、`prompt_templates`・`ab_comparisons`・`generation_logs` の各テーブルと連携する。テーブル定義の正本は [統合DBスキーマ設計書](./Grimodex_統合DBスキーマ.md) を参照する。

### 設計原則

- **計測は fail-open**: `recordAiUsage` の記録失敗は生成本体を絶対に巻き込まない（best-effort）。台帳は分析用途であり、書けなくても機能を止めない。
- **予算はブロックしない**: トークン予算 ETA はあくまで表示・警告のみで、生成を遮断するハードリミットは持たない（未実装）。
- **ライブ ChatPanel 不可侵**: A/B 比較はライブチャットの単一ストリーム描画には一切触れず、専用の比較サーフェスで2構成を並列に走らせる。
- **既存レポートを再構築しない**: 生成出所分析は出荷済みの `provenance.ts` が解決した `ResolvedPassage[]` と `ai_usage` 行を入力に、純関数のロールアップだけを行う。

---

## ① トークン予算 ETA

月予算（USD）と当月の消費から、バーンレート・月末予測・予算到達までの残日数を算出して表示する。生成はブロックしない。

### UI 構造

`BudgetEtaSection`（`src/features/ai-usage/BudgetEtaSection.tsx`）を Settings → Usage カテゴリの先頭に配置する。

```
┌──────────────────────────────────────────────┐
│ Token Budget                                  │
│ 月予算 (Monthly budget)        [   60  ] USD  │
│                                                │
│ 消化率 (Consumed)                         72% │
│ [██████████████████░░░░░░░]                   │
│                                                │
│ 今月のコスト (Month cost)              ≈$43.2 │
│ 日次バーンレート (Daily rate, 経過14日)  $3.08│
│ 月末予測・平均ペース                    $95.6 │
│ 月末予測・直近7日ペース                 $88.1 │
│ 予算到達まで                            約6日 │
│                                                │
│ ⚠ 予算に接近しています（非ブロッキング）       │
└──────────────────────────────────────────────┘
```

### 算出エンジン（純関数）

`computeBudgetEta(input)`（`src/features/ai-usage/budgetEta.ts`）が副作用・I/O なしの純関数として全数値を算出する。テスト決定性のため `now: Date` を注入する。

**入力 `BudgetEtaInput`**:

| フィールド | 説明 |
|-----------|------|
| `points: CostPoint[]` | `ai_usage` から解決したコスト点列（`{ createdAt, costUsd }`）。当月で内部フィルタする |
| `budgetUsd: number` | 月予算（USD）。0 以下 = 未設定 |
| `now: Date` | 現在時刻（注入） |
| `recentWindowDays?: number` | 直近ペースを測る窓（既定7日） |

**出力 `BudgetEtaResult`（抜粋）**:

| フィールド | 算出 |
|-----------|------|
| `monthCostUsd` | 当月（ローカルカレンダー月）の累計コスト |
| `elapsedDays` | 月初から今日までの経過日数（今日を含む。最小1） |
| `remainingDays` | 今月末までの残り日数（今日を含まない。最小0） |
| `dailyRateUsd` | 平均日次バーンレート = `monthCost / elapsedDays` |
| `projectedMonthEndUsd` | 平均ペースでの月末予測 = `dailyRate × daysInMonth` |
| `recentDailyRateUsd` | 直近 N 日（既定7）の日次バーンレート |
| `recentProjectedMonthEndUsd` | 直近ペースでの月末予測 = `monthCost + recentRate × remainingDays` |
| `percentConsumed` | 消化率 %（予算未設定なら null） |
| `daysUntilBudget` | 予算到達までの残日数 = `(budget − monthCost) / dailyRate`。予算未設定 or レート0なら null、超過済みは0 |
| `overBudget` | 当月累計が予算を超えているか |
| `projectedOverBudget` | 平均ペースの月末予測が予算を超えるか |

### 境界の正規化

すべての境界を安全側に倒す。`safeNonNeg` で NaN / Infinity / 負値は0へ正規化し、出力は常に有限かつ非負になる。0除算（レート0）は `daysUntilBudget = null` に倒し、UI では「—」を表示する。「月」はローカルカレンダー月で切る（UI 表示と一致させるため）。

### 警告レベル（UI の責務）

数値の出し分けは純関数が担い、警告の色分けは UI 側の責務とする。`BudgetEtaSection` は消化率しきい値 `APPROACHING_PCT = 80%` で判定する:

| レベル | 条件 | 表示 |
|--------|------|------|
| `over` | `overBudget`（予算超過） | 赤（destructive）・`AlertTriangle` |
| `approaching` | 消化率 ≥ 80% または `projectedOverBudget` | 黄（amber）・`TrendingUp` |
| `none` | それ以外、または予算未設定 | 警告なし |

いずれも非ブロッキングであることを明示する文言（`tokenBudget.warnNonBlocking`）を併記する。

### データ取得

- 予算値は project setting `ai.costBudgetPerMonth` の往復（`useSettingNumber`）。0 = 未設定で、入力即時に再計算する。
- コスト点は `getProjectUsageInRange(projectId, sinceIso, untilIso)`（`usageQuery.ts`）で当月分（`monthRange(now)`）のみ取得する。`idx_ai_usage_project_created`（`project_id, created_at`）を活かし、`created_at`（ISO 8601 TEXT）の辞書順比較で範囲を絞る。
- `cost_usd` が null の行は `estimateTotalCost(model, tokensIn, tokensOut)`（`modelPricing`）で補完し、推定が混ざれば `anyCostEstimated` を立てて UI で「≈」を表示する。

---

## ② プロンプト再利用ライブラリ

ユーザーが再利用可能なプロンプトをプロジェクト単位で保存し、チャット入力から呼び出す。v1 はパラメータ置換なしのプレーンテキスト（後述「未実装」）。

### データモデル

`prompt_templates` テーブル（project スコープ）。`id` / `title` / `content` / `usage_count` / timestamps を持つ。Snippet とは別概念で、Snippet が「本文に挿入する再利用テキスト断片」であるのに対し、こちらは「AI へ送る指示文の再利用」である。

### 状態管理

`usePromptLibraryStore`（Zustand、`promptLibraryStore.ts`）がプロジェクト単位の CRUD を管理する。

| メソッド | 動作 |
|---------|------|
| `load()` | 現在のプロジェクトのテンプレートを読み込む |
| `ensureLoaded()` | 未ロード or プロジェクト切替時のみ読み込む（mount / picker open 用） |
| `create(title, content)` | 新規作成（タイトル/本文の空チェック後、楽観的に先頭へ差し込み） |
| `update(id, data)` | タイトル / 本文を更新 |
| `remove(id)` | 削除 |
| `incrementUsage(id)` | 使用回数を +1（楽観更新。失敗してもロールバックせず次回 load で整合） |

**クロスプロジェクト汚染防止**: `load()` は非同期中にプロジェクトが切り替わっていたら（`getCurrentProjectId() !== projectId`）stale 結果を破棄する。新プロジェクトの load が状態を所有する。

### 管理 UI

`PromptLibrarySection`（`PromptLibrarySection.tsx`）を Settings → AI カテゴリの project スコープ節に配置（`AiCategory.tsx` から1行設置）。一覧・追加・編集・削除を行う。

### チャット入力からの呼び出し

`PromptTemplatePicker`（`PromptTemplatePicker.tsx`）をチャット入力欄の下段ツール列（`ChatInput.tsx`）に置く。

- トリガーは `BookMarked` アイコン付きボタン。クリックで popover（`role="menu"`）を開く。
- `.glass-chat` の `backdrop-filter` stacking context を避けるため `useAnchoredPopover` で `document.body` へ portal する（`z-[100]`）。
- open 時に `ensureLoaded()` を呼び、Settings での追加を取りこぼさない。
- テンプレ選択で `onSelect(template)` を発火し、挿入は呼び出し側（ChatInput の `handleTemplateSelect`）が行う。選択時に `incrementUsage` が走る（楽観更新で件数バッジが即反映）。

---

## ③ モデル/プロンプト A/B 比較

同一の基底プロンプトに対し2構成（A / B）を並列に走らせ、結果を横並びで見比べて採用する。チャットとインライン/ビートの両経路から独立したモーダルで利用できる。

### A/B 軸（mode）

2種類の比較軸を1構造で表現する（`abConfig.ts` の `deriveAbConfigs`）。A 側は常に「現在の既定」（`configA = {}`）で、B 側のみを mode に応じて変える。

| mode | A | B |
|------|---|---|
| `model`（モデル A/B） | 既定モデル | 指定モデル（`promptVariant` は両方なし） |
| `prompt`（プロンプト A/B） | 既定モデル | 既定モデル + 追記指示（`model` は両方なし=既定） |

`isAbConfigMeaningful` で B が A と差分を持つか判定し、空入力での無意味な A/B を弾く（実行ボタンを `disabled`）。

### 実行エンジン（純粋なディスパッチ層）

`runAbComparison(request, configA, configB, dispatch, options)`（`abHarness.ts`）。surface ごとの実 LLM 呼び出しは `dispatch` コールバックで注入する設計で、分岐ロジック（promptVariant 合成・並列実行・結果整形）を単体テストできる。

- **promptVariant 合成**: `applyPromptVariant(messages, variant)` が追記指示を user ロールのメッセージとして末尾に足す。空なら無変更。**元配列は破壊しない**（A/B で同じ基底を共有するため `slice()` でコピー）。
- **並列制御**:
  - `parallel: true`（既定、chat）→ `Promise.all` で2構成を並走。非ストリーミングで応答が独立しているため安全。
  - `parallel: false`（inline）→ 逐次実行。inline-ai はグローバルな `inline-ai:stream-*` イベント / 共有 abort flag を使うため、2本同時だと chunk が混線する。A を完了してから B を走らせる。
- **片側失敗の隔離**: `safeDispatch` が dispatch の例外を `{ ok: false, error }` に正規化し、片側失敗が全体（`Promise.all`）を倒さない。

### surface 別アダプタ

`abDispatchers.ts` が2種類の `AbDispatcher` を提供する。いずれも生成本体を改変せず、各生成ごとに `recordAiUsage` を「呼ぶだけ」（メタデータ `{ abTest: true }`）。

| dispatcher | 経路 | 実装 |
|-----------|------|------|
| `createChatAbDispatcher` | chat | `sendChatMessageOnceAb`（非ストリーミング1ショット、model override 付き） |
| `createInlineAbDispatcher` | inline / beat | `streamInlineAiText`（model override・usage 記録 `surface: inline_ai` を内包） |

### orchestration フック

`useAbComparison({ surface, projectId, dispatch })`（`useAbComparison.ts`）。

- `run(request, configA, configB)`: 2構成を実行（inline は逐次・chat は並列）→ 結果を state へ → 履歴保存（best-effort）。
- `adopt(side)`: 採用列（'a' | 'b'）を記録し、その列のテキストを返す。失敗列の採用は null。挿入/送信は呼び出し側が行う。
- 最新 run の config / result は `lastRunRef` に保持し、adopt 時に参照する。
- 履歴保存の失敗は比較体験を止めない（`recordId` が null のままでも採用可能）。

### 履歴保存（ab_comparisons）

`createAbComparison`（`api.ts`、Drizzle）。**両側 success かつ projectId があるときだけ**履歴を残す（片側失敗は記録しない）。

- 記録列: `surface` / `prompt`（要旨）/ `modelA` / `modelB` / `promptVariantA` / `promptVariantB` / `responseA` / `responseB` / `chosen`（初期 null）。
- `prompt` 要旨は呼び出し側の `promptSummary`、未指定時は最後の user メッセージ先頭120字を `summarize` で生成。
- 採用は後から `setAbChosen(projectId, id, side)` で `chosen='a'|'b'` を更新する。
- `getAbComparison` / `setAbChosen` は `project_id` スコープで fail-closed（クロスプロジェクト読取/更新を防止）。

### UI（2つのモーダル）

| モーダル | 配置・トリガー | 採用後の動作 |
|---------|--------------|------------|
| `AbChatDialog` | チャット入力下段の A/B chip（`Columns2` アイコン、`ChatInput.tsx`）。現在の下書きを `basePrompt` として渡す。下書きが空 or ストリーミング中は無効 | 採用テキストをクリップボードへ書き出し（`abTest.adoptedToClipboard`） |
| `AbInlineDialog` | エディタのインライン/ビート経路（`EditorPane.tsx` の `abInline` state）。`messages`（system + user）を渡す | `onAdopt(text)` で本文へ挿入し、モーダルを閉じる |

両モーダルとも `AbConfigForm`（mode 切替・B 構成入力）と `AbComparePanel`（2列比較・採用ボタン）を共有する。B 構成の初期値は Settings の `abTest.defaultModelB` / `abTest.defaultPromptVariantB` から読む。

### 設定（既定値）

`AbTestSection`（`AbTestSection.tsx`）を Settings → AI カテゴリに配置。比較ダイアログを開いたときの初期値だけを保存する。

- `abTest.defaultModelB`: モデル A/B の相手モデル（`ModelPicker`）。
- `abTest.defaultPromptVariantB`: プロンプト A/B の相手追記指示（`SettingTextarea`、最大2000字）。

---

## ④ 生成出所分析

どのモデル・どの生成種別（chat / inline-ai / beat / orphan-chat / unknown）が本文に何文字寄与したか、概算でいくらかかったかを集計する。

### 入力と非再構築の原則

`provenanceAnalytics.ts` は出荷済みの出所/帰属レポートを**再構築しない**。入力は:

1. `buildProvenanceBreakdown`（`provenance.ts`）が解決した `ResolvedPassage[]`
2. `loadProjectUsageCostRows`（`aiUsageAnalytics.ts`）が読む `ai_usage` 行

これらを純関数のロールアップに流す（DB I/O は `loadProvenanceAnalytics` のみ）。

### 提供する3観点

**1. モデル別寄与（`rollupModelContribution`）**

passage を model 別に集約し `ModelContributionRow[]`（`model` / `chars` / `passages`）を返す。model は `passage.model || passage.provenance.model || UNKNOWN_MODEL`（`__unknown_model__`）の順で解決。chars 降順 → model 昇順で安定ソート。

**2. 生成種別の分布（`rollupKindDistribution`）**

passage を `provenance.kind` 別に bucket（`chars` / `passages`）集計し `KindDistribution` を返す。

| kind | バケット |
|------|---------|
| `chat` | チャットメッセージ由来 |
| `inline-ai` | スラッシュコマンド系のインライン生成 |
| `beat` | ビート展開生成 |
| `orphan-chat` | 元チャットが見つからない AI スパン |
| `unknown` | trace も chat も無い AI スパン（旧データ等） |

**3. コスト↔出所のクロスリンク（概算）（`rollupCostByKind` / `rollupCostByModel`）**

`ai_usage` 行を surface→出所種別へ寄せて種別別/モデル別の概算コストを出す。

- surface→kind マッピング（`surfaceToProvenanceKind`）: `chat` / `agent` → `chat`、`inline_ai` → `inline-ai`、`beat` → `beat`、それ以外（synopsis 等）→ null（`otherCostUsd` へ）。
- 1行のコスト解決（`resolveRowCost`）: プロバイダ実値（`costUsd`）優先、無ければ `estimateTotalCost` で推定（`estimated: true`）。

> **限界（ベストエフォート）**: `ai_usage.trace_id` には FK が無く疎なため、行を本文 passage に1対1で紐付けることはできない。代わりに surface を出所種別へ寄せた概算であり、UI / エクスポートでは「~$X」「≈」のように概算を明示する。

### 合成レポート

`buildProvenanceAnalytics(passages, usageRows)` が `ProvenanceAnalyticsReport`（`modelContribution` / `kindDistribution` / `costByModel` / `costByKind` / `hasUsageData`）を合成する。`loadProvenanceAnalytics(projectId)` が DB から組み立てる（`buildProvenanceBreakdown` を `includePassageExcerpts: true` で呼び、`loadProjectUsageCostRows` を project スコープで読む）。

### UI

`ProvenanceAnalyticsSection`（`ProvenanceAnalyticsSection.tsx`）が分析レポート（model / kind / cost 表）を描画し、`AttributionProjectView`（プロジェクトスコープの帰属ビュー）に組み込まれる。`hasUsageData` が false の場合はコスト欄を隠す。制作過程開示エクスポート（Attribution 設計書「制作過程開示エクスポート」）とはデータの観点を共有する。

---

## AI usage 台帳（recordAiUsage）

①予算 ETA と④コスト分析の共通データソース。全 AI 生成サーフェスから呼ぶ N4 台帳。

### 記録フロー

`recordAiUsage(input)`（`recordAiUsage.ts`）が `ai_usage` へ「1生成 = 1行」を追加する。

- **fail-open**: 記録失敗（`db.insert` の例外）は `console.warn` で握り潰し、生成本体を巻き込まない。
- **null 許容**: tokens / cost が null でも行は記録する。streaming で usage が来ない構成（include_usage 未対応プロバイダ・中断ストリーム）でも「呼び出し回数」を数えられるようにするため。
- **model / provider の補完**: 未指定なら記録時点の `useAiSettingsStore` の設定から補完する（one-shot 生成は直前にこのモデルで送られているため十分正確）。
- **projectId**: 省略時は tree store の `projectId` を使う。自前の projectId を持つサーフェス（チャット等）は明示的に渡す。

### surface 種別

1サーフェス = 1種類の生成エントリ点で、集計 UI のサーフェス別内訳キーになる（`AiUsageSurface`）:
`chat` / `agent` / `map_branch` / `tree_scaffold` / `beat` / `beat_role` / `foreshadow` / `inline_ai` / `synopsis` / `session_title` / `summarization` / `context_creator` / `codex_judgment`。新サーフェスを足したら `usageLabels.ts` のラベルも更新する。

### Usage カテゴリの集計表示

`UsageCategory`（`UsageCategory.tsx`）が `getProjectUsageSummary(projectId)` でプロジェクト単位の集計（総生成回数・入出力トークン・推定コスト・prompt cache 読込率・surface 別内訳）を表示する。`BudgetEtaSection` もこのカテゴリに同居する。読み取りの projectId 源は書き込み側（`recordAiUsage`）と同一の **tree store** に揃える（別アクセサと取り違えると台帳は埋まるのに UI が空になる silent failure を防ぐ）。

---

## データモデル

テーブル定義の正本は [統合DBスキーマ設計書](./Grimodex_統合DBスキーマ.md) を参照。以下は本機能群が用いる4テーブルの構造の要約。

### ai_usage（横断トークン使用量台帳・N4）

```sql
CREATE TABLE ai_usage (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface            TEXT NOT NULL,
  scene_node_id      TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
  model              TEXT,
  provider           TEXT,
  tokens_in          INTEGER,
  tokens_out         INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  duration_ms        INTEGER,
  trace_id           TEXT,
  ref_id             TEXT,
  metadata           TEXT,          -- JSON
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_usage_project_created ON ai_usage(project_id, created_at);
CREATE INDEX idx_ai_usage_project_surface ON ai_usage(project_id, surface);
```

- `scene_node_id` は SET NULL（シーン削除でも履歴コストを残す）。project 削除は台帳全体を CASCADE。
- `cache_read_tokens` / `cache_write_tokens` は prompt cache 計測列（N4 で ALTER 追加。Anthropic 系のみ）。

### prompt_templates（プロンプト再利用ライブラリ）

```sql
CREATE TABLE prompt_templates (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  content     TEXT NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_prompt_templates_project ON prompt_templates(project_id, created_at);
```

`src/db/schema.ts` の `promptTemplates` と手動同期。v1 はパラメータ置換なしのプレーンテキスト。

### ab_comparisons（A/B 比較履歴）

```sql
CREATE TABLE ab_comparisons (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface           TEXT NOT NULL,   -- "chat" | "inline"
  prompt            TEXT NOT NULL,   -- 基底プロンプト要旨
  model_a           TEXT,
  model_b           TEXT,
  prompt_variant_a  TEXT,
  prompt_variant_b  TEXT,
  response_a        TEXT NOT NULL,
  response_b        TEXT NOT NULL,
  chosen            TEXT,            -- 'a' | 'b' | NULL（未採用）
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ab_comparisons_project_created ON ab_comparisons(project_id, created_at);
```

`src/db/schema.ts` の `abComparisons` とミラー。project 削除で CASCADE。

### generation_logs（inline-ai / beat の出自ログ）

```sql
CREATE TABLE generation_logs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_node_id TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK(kind IN ('inline-ai','beat')),
  command_id    TEXT,
  instruction   TEXT,
  prompt_full   TEXT,
  model         TEXT,
  trace_id      TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_generation_logs_project_trace ON generation_logs(project_id, trace_id);
CREATE INDEX idx_generation_logs_scene ON generation_logs(scene_node_id);
```

生成出所分析（④）と制作過程開示エクスポートの inline-ai / beat 経路の出自解決に使う。`trace_id` を介して帰属スパンと結ぶ。

---

## 実装ファイル配置

| 領域 | ファイル | 役割 |
|------|---------|------|
| ① 算出 | `src/features/ai-usage/budgetEta.ts` | バーンレート / ETA 純関数 |
| ① UI | `src/features/ai-usage/BudgetEtaSection.tsx` | 月予算・消化率・警告表示 |
| ①④ クエリ | `src/features/ai-usage/usageQuery.ts` | `ai_usage` 集計・期間スライス |
| ①④ 記録 | `src/features/ai-usage/recordAiUsage.ts` | AI 生成ログ記録（fail-open） |
| ② Store | `src/features/prompt-library/promptLibraryStore.ts` | Zustand CRUD + usage increment |
| ② 管理 UI | `src/features/prompt-library/PromptLibrarySection.tsx` | Settings AI 内の管理画面 |
| ② ピッカー | `src/features/prompt-library/PromptTemplatePicker.tsx` | チャット入力下段ピッカー |
| ③ エンジン | `src/features/ab-test/abHarness.ts` | 並列/逐次制御・promptVariant 合成 |
| ③ アダプタ | `src/features/ab-test/abDispatchers.ts` | chat / inline surface 別 dispatch |
| ③ 軸確定 | `src/features/ab-test/abConfig.ts` | mode → 2構成の純関数 |
| ③ フック | `src/features/ab-test/useAbComparison.ts` | run / adopt orchestration |
| ③ CRUD | `src/features/ab-test/api.ts` | `ab_comparisons` Drizzle CRUD |
| ③ UI | `src/features/ab-test/AbChatDialog.tsx` / `AbInlineDialog.tsx` / `AbTestSection.tsx` | チャット/インラインモーダル・設定 |
| ④ 集計 | `src/features/attribution/provenanceAnalytics.ts` | model/kind/cost ロールアップ |
| ④ UI | `src/features/attribution/ProvenanceAnalyticsSection.tsx` | 出所分析レポート表示 |
| 統合 UI | `src/features/settings/categories/AiCategory.tsx` | ②③ 統合 |
| 統合 UI | `src/features/settings/categories/UsageCategory.tsx` | ① + 台帳集計 |
| DB | `src-tauri/src/database/migrate.rs` | 4テーブル定義 |

---

## 状態管理

| 名称 | 種別 | 保持内容 |
|------|------|---------|
| `usePromptLibraryStore` | Zustand | `templates[]` / `isLoading` / `loadedProjectId`。プロジェクト切替で自動破棄 |
| `useAbComparison` hook state | React state + ref | `running` / `resultA` / `resultB` / `chosen` / `recordId`。adopt 用に `lastRunRef` |
| `BudgetEtaSection` local | React state | `range`（当月コスト点列）/ `budgetUsd`（`useSettingNumber`）/ `eta`（`useMemo`） |

A/B の B 構成既定値・トークン予算・プロンプト追記カスタマイズは settings store（`abTest.*` / `ai.costBudgetPerMonth`）に永続化する。

---

## 他機能との連携

### ← AI 生成全経路（chat / inline / beat / agent ほか）

`recordAiUsage` が全サーフェスから呼ばれ、`ai_usage` 台帳を埋める。これが①予算 ETA と④コスト分析の唯一の計測ソース。

### → Attribution / 制作過程開示

④生成出所分析は Attribution の `provenance.ts`（`ResolvedPassage[]`）を入力に取り、`ProvenanceAnalyticsSection` として `AttributionProjectView` に組み込まれる。`generation_logs` の `prompt_full` / `trace_id` は制作過程開示エクスポート（Attribution 設計書）の inline-ai / beat 経路でも使う。

### → Chat（②③）

②プロンプトピッカーと③ A/B chip はチャット入力欄（`ChatInput.tsx`）の下段ツール列に同居する。③ A/B はライブチャットのストリーム描画には触れず、専用モーダルで非ストリーミング並列実行する。

### → Editor（③）

③ A/B のインライン/ビート経路は `EditorPane.tsx` の `abInline` state からモーダルを開き、採用本文を `onAdopt` で本文挿入する。

---

## 未実装 / 将来

- **トークン予算のハードリミット**: 予算到達時に生成をブロックする機能は未実装。現状は表示・非ブロッキング警告のみ。
- **プロンプト変種のパラメータ置換**: ②のプロンプトテンプレートは v1 ではプレーンテキストのみ。`{{変数}}` 等のパラメータ置換は未実装。
- **A/B 履歴の閲覧 UI**: `ab_comparisons` への保存・採用記録は実装済みだが、過去の A/B 履歴を一覧・参照する専用 UI は本設計時点では未確認（CRUD `listAbComparisons` は存在する）。
- **コストの passage 1対1紐付け**: `ai_usage.trace_id` に FK が無いため、④のコスト↔出所紐付けは surface ベースの概算にとどまる。

---

## 改訂履歴

| 日付 | 変更 |
|------|------|
| 2026-06-20 | 新規作成（出荷済機能の追従文書化）。AI運用ツール群（#124）の4サブツール（①トークン予算 ETA・②プロンプト再利用ライブラリ・③モデル/プロンプト A/B 比較・④生成出所分析）の役割・データモデル・配線をコード根拠に基づき1本にまとめた。 |
