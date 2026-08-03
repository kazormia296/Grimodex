# Grimodex Attributionパネル設計書

## 概要

Attributionパネルはプロジェクト内のAI帰属統計を可視化するダッシュボード。エディタ本文中の「誰が書いたか」（Human / AI / Unknown）の割合をシーン・チャプター・プロジェクト単位で集計し、AI活用度の把握や公開時のAI使用率開示に使う。

デフォルト位置: Right Panel の "stats" タブ、もしくは Bottom Dock（レイアウト設計書依存）。いずれの配置でも同一の集計・表示仕様を共有し、Snippets や他ステータスパネルとタブ切り替えで共存する。

データソース: Editorパネル設計書で定義されたAuthorshipMark（TipTapカスタムMark）および `authorship_spans` テーブル。シーン本文に限らず、Codex 本文・Snippet 本文・カスタムディテール値・フェーズ固有本文といった ProseMirror で編集される全コンテンツを対象とする。

---

## パネル構造

```
┌─────────────────────────────────────────────────────────────────┐
│ A. Header                                                       │
│ Attribution                    Scope: [シーン | プロジェクト]    │
├─────────────────────────────────────────────────────────────────┤
│ B. Summary cards                                                │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│ │ Total    │ │ Human    │ │ AI       │ │ Unknown  │           │
│ │ 42,350   │ │ 28,420   │ │ 9,230    │ │ 4,700    │           │
│ │          │ │ 67.1%    │ │ 21.8%    │ │ 11.1%    │           │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
├─────────────────────────────────────────────────────────────────┤
│ C. Breakdown bar (stacked)                                      │
│ [████████████████████████░░░░░░░░░░░░▒▒▒▒▒▒]                   │
│  Human 67.1%              AI 21.8%    Unknown 11.1%              │
├─────────────────────────────────────────────────────────────────┤
│ D. Per-scene table                                              │
│ Scene                  Total  Human    AI  Unknown  AI%        │
│ ─────────────────────────────────────────────────────           │
│ Ch1 / The tower        1,247    834    310      103  24.9%      │
│ Ch1 / First spell      2,103  1,892    156       55   7.4%      │
│ Ch1 / The stranger       892    892      0        0   0.0%      │
│ Ch2 / Underground      1,534    980    412      142  26.9%      │
│ ...                                                             │
├─────────────────────────────────────────────────────────────────┤
│ E. Model usage                                                  │
│ claude-sonnet-4.6   7,230 chars (55.2%)                         │
│ gpt-4o              3,840 chars (29.3%)                         │
│ claude-haiku-4.5    2,030 chars (15.5%)                         │
└─────────────────────────────────────────────────────────────────┘
```

Bottom Dockの横長レイアウトを活かし、サマリーカード・ブレークダウンバー・テーブルを縦に並べる。

---

## A. ヘッダー

- **パネルタイトル**: 「Attribution」
- **Scopeセレクター**: 統計の集計範囲を切り替えるトグルボタン（2段階）

| Scope                | 集計範囲                                                   |
| -------------------- | ---------------------------------------------------------- |
| シーン（デフォルト） | アクティブなシーンの統計をリアルタイム表示                 |
| プロジェクト         | 全シーンをチャプター別にグルーピングして表示（DBから集計） |

> **実装メモ**: Part / Chapter 単位の独立スコープは未実装。プロジェクトスコープの
> チャプターグルーピング（折りたたみ可能）で代替する。

Scopeを切り替えると、B〜Eの全セクションが即座に再計算される。

Editorのアクティブシーンが変わったとき:

- Scopeが「シーン」の場合 → アクティブシーンに自動追従（editor.state.doc から即時再計算）
- Scopeが「プロジェクト」の場合 → 変更なし（DBから集計するため手動リフレッシュまで維持）

---

## B. サマリーカード

4枚のメトリックカードを横並びで表示。

| カード  | 値                   | 色                                             |
| ------- | -------------------- | ---------------------------------------------- |
| Total   | 合計文字数           | ニュートラル（`--muted-foreground`）           |
| Human   | Human文字数 + 割合   | `--attribution-human`（青系 / 色相 220°）      |
| AI      | AI文字数 + 割合      | `--attribution-ai`（ティール / 色相 165°）     |
| Unknown | Unknown文字数 + 割合 | `--attribution-unknown`（アンバー / 色相 30°） |

各カードはクリック可能。クリックするとそのsourceのテキストだけをEditorのAttributionHighlight上で強調表示する（他のsourceを薄くする）。再クリックで解除。

> **現状の実装**: 4枚カードではなく、`AttributionReport.tsx` の `StatBar`（ラベル + 横棒 + 文字数/割合）を Human / AI / Unknown の 3 行で縦に並べる構成。Total はフッターに表示。クリックでフィルタ on/off を切り替える挙動は仕様通り。色は `attributionColors.ts` の正本トークン（`ATTRIBUTION_COLOR_VARS` = `var(--attribution-*)`）を参照する。トークンは**色相を固定（human=220° / ai=165° / unknown=30°）したまま**、カラーテーマ × light/dark ごとに明度・彩度のみ調整される（`colorThemes.ts` の `THEME_CSS_VARS`、`applyTheme()` 適用）。旧記載のパープル `#7F77DD` / アンバー `#BA7517` / 「Human=グレー」は廃止。

---

## C. ブレークダウンバー

水平のスタック棒グラフ。3色で割合を視覚的に表示。

```
[████████████████████████░░░░░░░░░░░░▒▒▒▒▒▒]
 Human (青系)            AI (ティール)  Unknown (アンバー)
```

- 各セグメントにホバーで割合と文字数のツールチップ（`title` 属性 `{key}: {value} chars ({pct}%)`）
- セグメントをクリック → サマリーカードのクリックと同じフィルタ動作（※ 未実装。`BreakdownBar.tsx` のセグメント要素は `data-segment` 属性のみで `onClick` を持たない）
- バーの高さ: 24px（`height` prop で上書き可能。シーン別テーブルのミニバーは 6px）。角丸。各セグメントの最小幅は2px（0%でない場合は可視化保証）
- セグメント色は `ATTRIBUTION_COLOR_VARS`（`var(--attribution-*)`）の単色トークンを「色キー」として使う。値 0 のセグメントは描画しない（`value > 0` でフィルタ）

---

## D. シーン別テーブル

### テーブル構造

| カラム  | 内容                                            |
| ------- | ----------------------------------------------- |
| Scene   | シーン名（ブレッドクラム形式: Ch1 / The tower） |
| Total   | 合計文字数                                      |
| Human   | Human文字数                                     |
| AI      | AI文字数                                        |
| Unknown | Unknown文字数                                   |
| AI%     | AI / Total \* 100。ミニプログレスバー付き       |

### 表示ルール

- Scopeに応じてテーブルの行が変わる:
  - プロジェクト → 全シーンをチャプター別グルーピングで表示
  - シーン → テーブル非表示（単一シーンのためサマリーカードのみ表示）
- デフォルトソート: ツリー順（Part > Chapter > Scene）
- カラムヘッダークリックでソート切り替え（Total、AI%等で降順/昇順）

> **現状の実装**: `AttributionProjectView.tsx` ではチャプターをツリー順で並べたまま、各チャプター内のシーン行のみソートする（チャプター行自体は並び替わらない）。`Scene` カラム以外のヘッダーをクリックすると初期方向は降順、再クリックで昇順/降順をトグルする。

### 行のインタラクション

| 操作                | 動作                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| 行クリック          | ScopeをそのSceneに切り替え + Editorでそのシーンを開く                                  |
| 行ホバー            | 軽いハイライト                                                                         |
| AI%カラムのミニバー | ブレークダウンバーと同じ3色スタックの縮小版（`BreakdownBar` を `height={6}` で再利用） |

### チャプターグルーピング

Scope = プロジェクト の場合、シーンをChapter単位でグルーピングし、Chapterの小計行を表示。各チャプターは折りたたみ可能。

```
▼ Ch 1: Awakening                4,242  3,618   466    158  11.0%
    The tower                    1,247    834   310    103  24.9%
    First spell                  2,103  1,892   156     55   7.4%
    The stranger                   892    892     0      0   0.0%

▼ Ch 2: Descent                  1,534    980   412    142  26.9%
    Underground                  1,534    980   412    142  26.9%
```

Chapterの行は折りたたみ可能（▼/▶）。

---

## E. モデル使用状況

AI生成テキスト（`source: 'ai'`）を生成モデル別に集計するセクション。

### 表示

各モデルを文字数 + 割合のテキスト表示で表示。

```
claude-sonnet-4.6   7,230 chars (55.2%)
gpt-4o              3,840 chars (29.3%)
claude-haiku-4.5    2,030 chars (15.5%)
```

- AuthorshipMarkの `model` フィールドから集計
- `model` がNULLの場合（手動でai markを付けた場合等）は「Unknown model」として表示
- モデルが1種類のみの場合はこのセクションを折りたたみ表示（未実装）

> **現状の実装**: `AttributionReport.tsx` の AI Model Breakdown はモデル名と文字数 / 割合のみのテキスト表示で、横棒グラフは未実装。`AttributionStats.modelBreakdown` に集計済み（`__unknown_model__` キーが Unknown model に対応）。モデル数による折りたたみも未実装。

---

## データ集計

### 集計ロジック

```typescript
interface AttributionStats {
  totalChars: number;
  humanChars: number;
  aiChars: number;
  unknownChars: number;
  modelBreakdown: Record<string, number>; // model名 → 文字数（source: 'ai' のみ対象）
}

function computeAttribution(sceneIds: string[]): AttributionStats {
  // 方法A: TipTapドキュメントがメモリ上にある場合
  //   → AuthorshipMarkをドキュメントから直接集計（最速）
  // 方法B: TipTapドキュメントが未ロードの場合
  //   → authorship_spans テーブルからSQLで集計
  // 方法Aを優先し、未ロードのシーンのみ方法Bで補完する
}
```

> **現状の実装**:
>
> - フィールド名は `human` / `ai` / `unknown` / `total` / `modelBreakdown` に加え `unmarked` を内部的に持つ（`src/features/attribution/attributionStats.ts` の `AttributionStats`）。
> - Scope = シーン: `computeAttributionStats(doc)` で TipTap ドキュメントから即時集計（方法 A）。
> - Scope = プロジェクト: `loadProjectAttributionStats(sceneIds)` が `authorship_spans` を一括 SELECT して JS 側で集計（方法 B）。アクティブシーンのメモリ上ドキュメントとの併用（ハイブリッド）は未実装。

### 集計タイミング

- Attributionパネルが表示されている場合: エディタの自動保存完了後に再計算（デバウンス3秒）
- Attributionパネルが非表示の場合: 再計算しない（パネル表示時に初回計算）
- Scope変更時: 即座に再計算

> **現状の実装**: Scope = シーン の場合は `editor.state.doc` を `useMemo` 依存に含めて毎トランザクションで再計算する（デバウンスなし）。Scope = プロジェクトでは `useEffect` でツリーロード時に 1 回ロードし、明示的な `Refresh` ボタンで再ロードする。自動保存完了後の自動再フェッチは未実装。

### パフォーマンス

方法B（SQL集計）の場合:

```sql
SELECT
  node_id,
  source,
  model,
  SUM(to_pos - from_pos) AS char_count
FROM authorship_spans
WHERE node_id IN (/* sceneIds */)
GROUP BY node_id, source, model;
```

`authorship_spans` テーブルの `idx_authorship_node` インデックス（Editor設計書で定義済み）により高速に集計可能。

500シーン x 平均20スパン/シーン = 10,000行。GROUP BYクエリは数ms以内。

### AuthorshipMark 属性

Attribution 集計の前提となる AuthorshipMark は以下の属性を持つ。基本 4 属性（`source` / `timestamp` / `model` / `chatMessageId`）に加え、エージェント連携・ユーザー操作の追跡用拡張属性を含む。

| 属性             | 型                             | 用途                                           |
| ---------------- | ------------------------------ | ---------------------------------------------- |
| `source`         | `'human' \| 'ai' \| 'unknown'` | 帰属種別                                       |
| `timestamp`      | ISO8601 文字列                 | マーク付与時刻                                 |
| `model`          | string \| null                 | 生成モデル名（AI のみ）                        |
| `chatMessageId`  | string \| null                 | 生成元チャットメッセージ                       |
| `traceId`        | string \| null                 | Agent Trace v0.1.0 連携用のトレース ID         |
| `toolName`       | string \| null                 | エージェント経由書き込み時のツール名           |
| `toolVersion`    | string \| null                 | 同ツールのバージョン                           |
| `manualOverride` | boolean                        | `AttributionOverrideMenu` による手動変更フラグ |
| `originalLength` | number \| null                 | 原文文字数（AI 編集後の差分追跡用）            |

> **命名規約**: DB カラムは `chat_msg_id` のようにスネークケースで保持するが、Mark 属性名はキャメルケース（`chatMessageId`）を使用する。相互変換は API レイヤの責務とする。

### `authorship_spans` の対象エンティティ

`authorship_spans` は `node_id`（シーン ProseMirror ノード ID）に加え、以下の参照カラムを持ち、シーン本文以外の編集対象にも帰属を記録できる。

- `codex_entry_id`: Codex エントリ本文
- `snippet_id`: Snippet 本文
- `detail_value_id`: カスタムディテール値
- `phase_id`: フェーズ固有本文（`codex_entry_id` と直交し、フェーズレーンの帰属を記録）
- `sticky_id`: Map Sticky body（Map パネル設計書で追加）

いずれの参照カラムも NULL 許容で、`node_id`/`codex_entry_id`/`snippet_id`/`detail_value_id`/`sticky_id` のうち排他的に 1 つだけが非 NULL となる（`phase_id` は直交。SQL CHECK 制約で強制）。テーブル定義・DDL・インデックスの正本は [統合DBスキーマ設計書](./Grimodex_統合DBスキーマ.md) の `authorship_spans` 節を参照。

> **現状の実装（2026-06-18）**: 集計レーンはコンテンツ種別で分離している。
>
> - **本文（シーン）集計** = `projectStats.ts` の `loadProjectAttributionStats(sceneIds)`。`node_id` のみで `WHERE` を組み立て、`treeNodes.charCount` を分母に AI / Unknown / Human を算出する。シーン別テーブルと「プロジェクト」スコープの行はこれを使う。**Detail / Phase 由来のスパンは集計に含まれない**（`detail_value_id` / `phase_id` のレーンは書き込み配線済みだがプロジェクト集計の対象外）。
> - **Codex / Snippet レーン** = `loadKnowledgeAttributionStats(projectId)`。`codex_entry_id` / `snippet_id` 由来のスパンを per-entity に集計し（cross-project は codex の projectId join で除外）、`AttributionProjectView` のヘッダーに「ナレッジ由来 AI 文字数」の合計を 1 行で表示する（per-scene 集計の分母には混ぜない）。
> - **Map Sticky レーン** = AI 由来の Sticky は本文集計に算入せず**独立レーン**として扱う（後述「制作過程開示エクスポート」の `MapProvenance`）。Sticky の authorship スパンは `trace_id` / `chat_msg_id` を持たず由来を分類できないため、本文の「AI 比率」分母に混ぜると汚染する。旧記載「プロジェクトスコープで Sticky を AI 比率に算入」は誤りなので撤回。

### AiEditedPlugin

AI / Unknown スパン内にユーザーが文字を挿入した場合、挿入されたテキスト部分のマークを剥がし自動的に human 化する ProseMirror プラグイン。

- 対象はあくまで「新規挿入されたテキストレンジ」のみで、前後の既存 AI マークは保持する
- `programmaticInsert` meta を立てたトランザクション（貼り付け復元、Snippet 挿入、履歴リストア等）には作用しない
- 手動オーバーライド（`manualOverride: true`）が付与されたマークは剥がさない

### AttributionOverrideMenu

エディタ上で選択範囲を右クリックして表示されるコンテキストメニュー。選択範囲の `source` を手動で `human` / `ai` / `unknown` のいずれかに書き換える。

- オーバーライド後のマークには `manualOverride: true` が付与され、後続の `AiEditedPlugin` や自動判定ロジックでは上書きされない
- 既存の timestamp / model / chatMessageId は維持（ただし source が human に変更された場合は model を NULL に置き換える）

> **現状の実装**: 専用コンポーネントではなく `src/features/editor/EditorContextMenu.tsx` 内の `handleAttributionOverride` として実装（`data-testid="attribution-override-menu"`）。表示条件は「Attribution 表示が ON、かつ選択範囲に authorship マークが存在し、選択テキストが空でない」。`tr.addMark` で既存マークを上書きするため、既存属性（timestamp / model / chatMessageId）の保持・置換ロジックは未実装で、新しい `timestamp` で塗り直される。

### Codex / Snippet エディタでの初期マーク付与

Codex / Snippet のミニエディタで AI 由来コンテンツを開いた際、保存済みの `authorship_spans`（`codex_entry_id` / `snippet_id` 参照）からマークを復元する。ミニエディタ上でも通常エディタと同等の AttributionHighlight・Attribution 集計が機能する。

> **現状の実装**: 保存済みの `authorship_spans` から ProseMirror JSON marks を復元する仕組みは、`seedAuthorshipMarks`（`src/features/attribution/seedAuthorshipMarks.ts` の `addAuthorshipMarks`）で実装されている。この関数はドキュメント全体の全テキストノードに `authorship` mark を一括付与し、既に mark を持つノードは idempotent に保持する（再スタンプしない）。検査対象は ProseMirror JSON の mark type（`m.type === 'authorship'`）であり、HTML の `data-authorship` 属性ではない。

### `unmarked` テキストの扱い

AuthorshipStats は内部的に `human` / `ai` / `unknown` に加え `unmarked`（マーク無し = 旧データ / マイグレーション前のテキスト）を区別する。UI 表示上は `unmarked` を `human` にマージして扱う（Summary カード・ブレークダウンバー・Per-scene テーブルの全てで Human に加算）。内部区別はデバッグ表示や将来的な再マイグレーション処理で利用する。

---

## エディタとの連動

### ステータスバー → Attributionパネル

Editorステータスバーの「AI: {割合}%」をクリックすると、Attributionパネルを開く（または既に開いている場合はフォーカス）。Scopeはアクティブシーンに設定される。

### Attributionパネル → エディタ

- テーブルの行クリック → Editorでそのシーンを開く
- サマリーカードクリック → Editorの全てのAttributionHighlight表示を、そのsourceだけ強調する「フィルタモード」に切り替え

### フィルタモード

サマリーカードの「AI」をクリックした場合:

- Editorの `source: 'ai'` のテキスト → 通常表示
- Editorの `source: 'human'` のテキスト → `opacity: 0.15` で薄く表示
- Editorの `source: 'unknown'` のテキスト → `opacity: 0.15` で薄く表示
- Attributionパネル上の「AI」カードにアクティブインジケーター表示
- 再度「AI」をクリック、または「All」ボタンでフィルタ解除

フィルタモードはAttr表示トグル（Editorツールバー）がONの場合のみ有効。OFFの場合はフィルタモードを開始するとAttr表示も自動的にONにする。

---

## エクスポート

### Attribution レポートのエクスポート

パネルヘッダーのオーバーフローメニュー（⋮）→ 「Export report...」で、帰属統計をファイルとして書き出す。

**Markdown形式**:

```markdown
# Attribution Report: My Novel

Generated: 2026-04-01

## Summary

| Source    | Characters | Percentage |
| --------- | ---------- | ---------- |
| Human     | 28,420     | 67.1%      |
| AI        | 9,230      | 21.8%      |
| Unknown   | 4,700      | 11.1%      |
| **Total** | **42,350** | **100%**   |

## By Chapter

### Chapter 1: Awakening

...

## By Model

| Model             | Characters | Percentage |
| ----------------- | ---------- | ---------- |
| claude-sonnet-4.6 | 7,230      | 55.2%      |
| gpt-4o            | 3,840      | 29.3%      |

...
```

**CSV形式**: シーン別テーブルをCSVで出力。BIツールやスプレッドシートでの分析用。

**Agent Trace v0.1.0 形式**: MIME タイプ `application/vnd.agent-trace.record+json` で AI 由来スパンを機械可読なトレースレコードとして書き出す。各レコードには `traceId` / `toolName` / `toolVersion` / `model` / `chatMessageId` の他、原文・現在本文の SHA-256 を表す `contentHash` を含め、外部監査ツールや AI 利用開示パイプラインへ入力できる。MD / CSV レポートと並列のエクスポート手段として提供。

エクスポートはTauriのファイルダイアログで保存先を選択。

### 制作過程開示エクスポート（2026-06-18 追記）

メインのエクスポートダイアログ（`ExportDialog.tsx`、本文出力 / **AI 使用開示** / タイムラプス動画の 3 モード）の「AI 使用開示」モードが、コンテスト等で要求される制作過程開示用のレポートを生成する。データソースは `provenance.ts` の `buildProvenanceBreakdown(projectId, options)` で、返り値は `ProvenanceDisclosureReport`。

集計スコープは `scope: "body-text-only"`（シーン本文のみ）。AI 由来スパンを由来種別ごとに分類した `breakdown` を持つ:

| 由来          | 説明                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| `chat`        | チャットメッセージ由来（`chat_msg_id` から解決）                       |
| `inline-ai`   | スラッシュコマンド系のインライン生成（`trace_id` → `generation_logs`） |
| `beat`        | ビート展開生成（同上）                                                 |
| `orphan-chat` | 元チャットが見つからない AI スパン                                     |
| `unknownAi`   | trace も chat も無い AI スパン（旧データ等）                           |

ダイアログのトグルで開示の粒度を段階的に上げる:

- **抜粋を含める**（`includePassageExcerpts`）: 各 AI 使用箇所に本文抜粋を付ける。
- **入力＋出力を含める**（`includePrompts`）: 各箇所に `disclosure`（`PassageDisclosure`）を添付する。`userPrompt`（chat = 直前のユーザー発話 / inline-ai・beat = 指示文）と `output`（その箇所になった AI 出力の全文）を記録する。
- **送信プロンプト全文を含める**（`includeFullSystemPrompt`、上の子トグル）: `sentSystemPrompt` を追加する。chat は `chat_message_prompts` のスナップショット（直前ユーザーメッセージ ID をキーに取得）と `layers`（コンテキスト層別トークン内訳）、inline-ai・beat は `generation_logs.prompt_full`。capture 配線前に生成された旧レコードでは NULL（`promptRecorded: false`）。送信全文は他シーンの文脈を含み得るため警告を表示する。

`generation_logs`（`prompt_full` / `trace_id` 等）のテーブル定義は [統合DBスキーマ設計書](./Grimodex_統合DBスキーマ.md) の `generation_logs` 節を参照。

**Map AI コンテンツの独立レーン**: `report.map`（`MapProvenance`）は本文の `totals` / `breakdown` から完全に分離して報告される。`buildMapProvenance(projectId)` が board → stickies → `sticky_id` 帰属スパンを辿り、AI 文字数を Sticky 単位で集計する（`stickyCount` / `totalAiChars` / `stickies[]`）。本文の AI 比率分母には決して混ぜない（前述「対象エンティティ」の理由）。

出力形式は `exportReport.ts` の `exportProvenanceDisclosureMarkdown` / `…Html` / `…Json`（および `…Csv`）。いずれも Map レーンを別セクション（"Map AI Content"）として描画する。

### AI使用監査ZIP（2026-08-03 追記）

プロジェクト表示の「AI使用証拠監査ZIP」は、賞レース等の事後監査に備え、従来の「現在本文に残るAI寄与」、監査導入後のforward実行ledger、DBに残存する旧形式証拠のうちAI由来の構造的根拠を持つ選択済み証拠を別セクションとして同梱する。「記録済みの全実行」や「監査導入前の完全な履歴」とは主張せず、削除済み・未記録の証拠や外部client内だけにあるpromptは回収不能であることをmanifestとREADMEで明示する。既存の帰属JSON/HTMLエクスポートの形式・挙動は変更しない。

ZIPの主な内容:

| ファイル                             | 内容                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports/authorship-report.json`     | エクスポート時点で本文に残る Human / AI / Unknown 帰属スナップショット                                                                                                              |
| `reports/provenance-disclosure.json` | `includePassageExcerpts` / `includePrompts` / `includeFullSystemPrompt` をすべて有効にした既存の本文出所開示。旧データの orphan / unknown や回収可能な部分証拠も保持                |
| `reports/execution-summary.json`     | 実行状態、request準備・application→selected transport dispatch、観測可能なtransport試行、capture状態、経路レジストリとの照合、整合性警告を人が読める形で集約                        |
| `ledger/project-events.jsonl`        | 監査導入後に対象プロジェクトで観測・記録されたforwardイベント。対話、レビュー、コメント、synopsis、抽出、rerank等の非本文・非対話処理、未採用出力を含む                             |
| `ledger/workspace-events.jsonl`      | プロジェクト選択前の実モデル接続確認等。対象プロジェクトへの寄与とは断定せず別chainで開示                                                                                           |
| `legacy-evidence/*.jsonl`            | 対象プロジェクトのDBに現存し、構造的なAI根拠を持つものとして選択した旧形式・並行保存の行証拠。source tableごとに決定的順序のJSONLで出力し、欠損内容からsynthetic ledgerを生成しない |
| `manifest.json` / `README.md`        | schema/capture/app/recorder版、固定high-water、ファイルhash、coverage、限界と共有前の注意                                                                                           |

provider / local modelへdispatchされる実行は、`execution.started` → dispatch前の `request.prepared` → `request.dispatched` → 観測できたresponse / transportイベント → terminalイベントの順で記録する。responseを観測する前に失敗またはcancelされる場合もあるため、responseイベント自体を必須とはしない。`execution.skipped` / `execution.cache_hit` はdispatchを伴わないterminal分岐であり、provider setup、監査永続化、dispatch前cancel、unwindによる `execution.failed` / `execution.cancelled` も明示的なno-dispatch分岐として許可する。dispatch後の追加 `request.prepared` は、providerへ渡した最終bodyのreceiptである `payload.effectiveRequestReceipt=true` の場合だけ許可する。transport attempt、response、retry / fallback、`execution.succeeded` は先行するdurableな `request.dispatched` を必要とし、`execution.succeeded` はさらに先行する `response.completed` を必要とする。`request.dispatched` はapplicationからruntimeで選択されたtransport（Electron native IPC / Web BrowserMock等）へのdispatchであり、HTTP送信試行やprovider receiptではない。rendererが別のapplication executionとして行うretry/fallbackは元executionをfailedで閉じ、親子executionとoperation IDで関係を残す。一方、instrument済みのnative HTTP 429 retry helperは同じapplication execution内のtransport attemptとして、`transport.attempt.started` をHTTP send呼び出し直前の永続化済みpre-send観測、`transport.attempt.finished` をsend呼び出しが応答またはtransport errorを返した後の観測として追加記録し、再試行決定を `execution.retrying` で残す。native 429 retryごとに元executionをterminalizeしたり子executionを作ったりはしない。startedだけではプロセスが実HTTP send呼び出しまで生存したことを証明しない。terminalは `execution.succeeded` / `failed` / `cancelled` / `skipped` / `cache_hit` のいずれか1つで、cache hitの後にsucceededを重ねない。cleanup時の `transportAbortRequested` は選択transportへの中止要求、`abortCommandAcknowledged` はローカルのElectron / BrowserMock / CLI / Codex command境界がcleanup commandをacknowledgeしたことだけを示し、providerの中止receiptではないため `providerAbortReceiptObserved` はfalseのままとする。相関したresponseとtransport-attempt証拠はsingle terminalより前にすべて永続化し、terminal後のevent追加は拒否する。exportでpost-terminal件数が0でなければ正常なin-flight証拠ではなく、legacyまたは不整合dataとして調査が必要なanomalyである。dispatch前にstartedと、モデルに実際に渡す正規化済みrequest（messages/body/context/tools/options）を永続化する。

`captureState` はイベントごとに `complete` / `partial` / `redacted` / `truncated` / `legacy_missing` / `unobservable_provider` を持つ。「モデル可視内容を完全保存」の主張は `complete` かつ宣言済みのGrimodex観測境界内に限定する。renderer chat/streamでは正規化済みのmodel-visible request引数と、アプリが観測したparsed block/deltaを正確に記録し、providerのraw HTTP envelope/header保存とは主張しない。native post-effectは別途 `raw_response` を保持できる。summaryは「application dispatch済みなのに `request.prepared` が無い」実行、application dispatch event/execution数、no-application-dispatchのskipped/cache hit、曖昧な未終端実行を分けて表示し、意図的no-dispatchをmissingへ混ぜない。transport helperについてはstarted/finished、対応不一致、429、`willRetry`、`retryExhausted`、`execution.retrying`を別集計する。送信直前に永続化されたリトライ開始回数は、整数 `attemptNumber > 1` の `transport.attempt.started` 件数と定義し、`willRetry`（次回試行の決定）とは分ける。started件数は実HTTP send回数とは主張しない。このhelperを通らないproviderのHTTP送信は観測できないため、全providerのHTTP送信総数とは主張しない。forward ledgerへ監査導入前の履歴を推測でbackfillせず、最初のイベントより前にAI利用が無かったとは主張しない。

#### 選択した現存旧形式証拠

`legacy-evidence/` は新ledgerを合成するbackfillではなく、選択プロジェクトに属してDBへ現存する行から、明示的なAI field、正準owner join、構造化authorship mark、assistant message link、tracked-write surface、semantic index ownerのいずれかを根拠に選んだ証拠をsource table別に開示する。一般のproject content tableを無差別にdumpしない。31 sourceは従来のchat / prompt / summary / generation / usage / A-B / post-effect / scene lens / Map AI / foreshadow AI / prose staging / change eventに加え、次を含む。

- `authorship_spans` は `source='ai'` のtree node / Codex / Snippet / detail / Stickyの5 owner laneだけを、各ownerの正準project joinで収録する。phaseはCodex laneに直交するrefinementとしてentry一致も確認する。
- `tree_nodes`（note・archivedを含む）/ `codex_entries` / `codex_detail_values` / `codex_entry_phases` / `snippets` / `map_stickies` は、対応AI span、ProseMirror JSONの `authorship` mark `source='ai'`、`snippets.content_source='ai'`、または同一projectのassistant message source link等の構造的根拠があるowner rowだけを収録する。user-role messageへのlinkはAI根拠にしない。AI起点後のhuman編集はあり得るため、dispatchやprovider receiptの証明ではない。
- `map_stickies` は上記に加えて、同一boardで検証できるAI branchと `ai_derived=1` を根拠にできる。採用後にbranch idがnullでも、残るspan / mark / flag / assistant linkを見落とさない。
- `undo_journal` は `surface IN ('in-app-agent','mcp')` の現存行だけを収録する。成功したtool mutationのbefore/after証拠であり、model dispatch/provider receiptではない。`mcp` は外部tool invocationだけを示し外部client promptは観測不能で、workspace compactionにより行がpruneされ得る。
- `scene_chunks` / `codex_chunks` / `event_chunks` / `chat_message_chunks` は正準owner joinでproject scopeを検証し、永続化済みsource/chunk text、model ID、content hash、dimension、chunker version、timestamps等を収録する。chatは非正規化 `project_id` だけを信頼せずmessage→session一致も確認する。実際のONNX入力で加わるdocument prefix、tokenizer special token、truncation後の内容は永続化されておらず正確に復元できない。renderer proxyでraw embedding BLOBを安全に取得できず、独立したvector SHAもないため `partial` とし、両方のlimitationを明示する。
- `trash_items` はpayloadを安全にparseし、text fragmentの `spans[].source='ai'`、Snippetの `contentSource='ai'`、scene/Codex/Map/Snippet bodyの構造化ProseMirror AI markを確認できるrowだけを収録する。parse不能rowはAI由来判定不能として除外し、artifact diagnosticsに件数を記録する。60日prune、clear、capture無効、短片非保存により完全ではない。

`content_versions`、named project snapshot（`project_snapshots` / `project_snapshot_*`）、`state_snapshots`、`impact_review_baselines`、`chat_session_pinned_codex`、その他のgeneric output/cache/state tableは、AI起源を一意に判定できないhistorical containerとして今回は収録しない。この明示的な非収録を含め、forward ledger導入前の完全性は主張しない。

直接 `project_id` を持つtableはその値を、chat・map等の子tableはproject所有parentへのjoinを使い、異なるprojectのrowを混入させない。`chat_summary_messages` はsummary側とmessage側の両parent、post-effect relationはrun/両annotation、scene lensはrun、Map AIはboard/branch整合性、`foreshadow_setups` は所有 `foreshadows.project_id` を確認する。各artifactはsource table、schema、row count、`full` / `partial` のcapture class、個別limitationをmanifestへ持ち、固定source順・canonical key順・決定的row順のJSONLとする。空tableもrow count 0のartifactとして列挙し、各artifactをfile hash対象に含める。

workspace pathは各queryの直前・直後とstage間で検証する。ただし31 sourceはtransactionで一括snapshotせず順番に読むため、これはatomicなmulti-table snapshotではなく、並行writeによるtable間の時刻ずれがあり得る。selected surviving legacy evidenceが示すのは現存する選択済み行だけで、削除済み・元から未記録のprompt/output/terminal、外部clientの実行は復元できない。forward ledgerと同じ実行の証拠が重複する場合もある。

ZIPは現在in-memoryで組み立てる。非常に大規模な監査履歴ではmemory不足等によりexport全体が失敗し得るが、その場合にpartial ZIPは生成しない。streaming exportは別課題とする。

forward ledgerでは通信層のAPI key、Authorization/Cookie header、process environment等のtransport credentialsを記録対象外とする。一方、モデル可視のprompt、他シーンを含むcontext、tool schema/input/result、response内に同名文字列がある場合は作品データとして保持する。legacyでは `ai_usage.metadata`、`post_effect_runs.error_message`、JSONとして分類できた失敗A/B slotのresponse診断だけをcredential sanitizerへ通す。A/Bの成功response / prompt variant、chat content/prompt、generation prompt、annotation content、`foreshadow_setups` のAI評価・提案列、`prose_staging.proposed_content` は完全一致を優先し、credentialらしい文字列も保持する。`change_events.payload` もmixed-origin operational evidenceとしてraw exactを保ち、内容からAI起源やdiagnosticを推測してsanitizeしない。parse不能なA/B slotsは診断箇所を推測せずrawを保持し、limitationを付ける。診断文からcredentialを除く場合は、`category` / `ruleId` / `path` / 元値のSHA-256とbyte長 / placeholder / `reversible:false` を持つ非可逆redaction記録を残す。したがってモデル可視内容や運用payloadへ入力された秘密情報を含み得るため、共有前に全内容を確認する。

`project:<projectId>` chainと`workspace` chainはsequence/hashを混ぜず、それぞれ固定high-waterで最大1000件ずつページ取得し、別々に検証・出力する。既知の `AI_PATHS` はcapture level別に、完全観測の `full-observable`、宣言済みlimitationを持つ `partial-observable`、実行制御だけを残す `control-event`、LLM生成ではない `not-applicable` に分ける。監査必須集合は `full-observable` と `partial-observable` の和集合とし、各分類は別リストでも保持する。missing比較はこの監査必須集合に対して observed / audit-required-but-unobserved を算出し、observed-unregisteredは全観測経路に対して示す。audit-required-but-unobservedはそのexport snapshotにイベントが無いことを示すだけで、未実装や未使用の証明ではない。renderer recorderは実際のElectron package versionを記録し、安全に取得できないnative recorderはcrate versionで代用せず `unknown` として件数を開示する。

`AI_PATHS` の論理path missing比較と、`AI_RUNTIME_ROUTES` のデプロイ済みruntime経路contractは別表示とする。runtime routeは論理model roleや独立ledger path IDを追加しないため、logical pathの audit-required-but-unobserved へ混ぜない。runtime route欄は登録、指定監査contract、同意contractの静的coverageであり、そのruntime経路が対象export内で実際に使用されたことを証明しない。Web/BYOK runtime routeではBrowserMockが指定optionを正規化または落とし得るが、browser-aiの最終builderが生成して実際の`fetch`へ渡す`bodyJson`文字列をparseした完全なJSON値を、BrowserMockが同じexecutionのcredential-free `request.prepared` effective-request receiptとして追記する。そのdurable journal ACKが完了するまで`fetch`を開始しないため、宣言済みのGrimodex観測境界内では `full-observable` とする。receiptはprovider bodyのJSON semanticsと実効routeを保持する一方、serialization whitespace、object key order、serialized bytes、HTTP headers、API key、Cookie、process environment等のtransport credentialを保持しない。個別executionにreceiptが存在することと、runtime route registryの静的contract coverageは区別し、後者だけから対象export内での実使用を推論しない。`list_ai_models`内のselected Ollama cold-runner preload（`/api/generate {model, stream:false}`）はweights loadやrunner allocationを行い得るが、promptを供給せずtoken generation/model outputを要求しないcontrol-plane activityであるため、Desktop/Webともgenerative/inference ledgerには含めない。Webではこの外部control requestにもroute consentを適用する。

chain検証は軽量なローカル自己申告の整合性診断であり、証明書、管理者耐性、第三者公証ではない。読出し可能でscope/sequence/pagination契約を満たす固定pinned snapshotについては、hash検証失敗やtail/high-water不一致でも生JSONLのエクスポートは止めず、`verificationFailed` をmanifest、README、UIに目立たせる。読出し不能、scope/sequence不整合、pagination契約違反は誤導的な部分ledgerを出力せずエクスポートを失敗させる。完全バックアップの復元でledgerも過去へ巻き戻り得るため、tail切断を外部に示すには以前のhigh-water sequence/hashを別途保管する必要がある。`change_events` はforward AI ledgerとは別の既存hash chainのfieldを保持するが、このZIP生成処理はその別chainを検証せず、legacy evidence全体が1つのhash chainであるとも主張しない。

Grimodexがmodel dispatchを行わない外部AI client、standalone MCP client側のsystem/user prompt、provider非公開reasoning/chain-of-thought、import/pasteされたAI本文の元promptは自動観測できない。OpenRouter Fusionの既定panel modelをproviderが選ぶ場合、そのmodel identityは明示設定されるか観測境界から返却・記録されない限り観測不能である。custom panel/judgeの明示設定を記録できても、providerが報告しない既定panel modelまで観測したとは主張しない。既存authorship spanは本文レポートに含める。対象projectの `change_events` 全行は、人間・AI・system・外部toolが混在する運用証拠としてpartial artifactへ収録する。MCP由来のtool/change evidenceが含まれ得るが、各payloadの意味はdomain/opType依存であり、AI prompt logとは主張しない。外部promptを捏造・復元したとは扱わず、`provenance-disclosure.json` とexecution summaryのorphan/unknownをledgerに無い既存証拠として区別して読む。

---

## キーボードショートカット

| ショートカット | 動作                                                               |
| -------------- | ------------------------------------------------------------------ |
| `Ctrl+Alt+A`   | Attributionパネルにフォーカス/トグル（レイアウト設計書で定義済み） |

パネル内のキーボード操作は最小限（テーブルのスクロールとScope切り替え程度）。主にマウス操作のダッシュボードUI。

---

## 他パネルとの連携

### ← Editor

- AuthorshipMarkのデータがAttributionの唯一のデータソース
- Editorの自動保存完了後に `authorship_spans` テーブルが更新され、Attributionパネルが再集計
- ステータスバーの「AI: {割合}%」クリック → Attributionパネルを開く

### → Editor

- テーブルの行クリック → Editorでそのシーンを開く
- サマリーカードクリック → Editorのフィルタモード（特定sourceのテキストだけを強調）

### ← Scenes

- プロジェクトスコープのチャプターグルーピングはScenesパネルのツリー構造（Part / Chapter / Scene）を反映
- ツリー構造が変更された場合、プロジェクトビューも動的に更新

### → Scenes（AI 比率バッジ）

- Scenes パネルの各シーンノードに、そのシーンの AI 帰属割合を小さなピルバッジで表示する
- バッジのデータソースは Attribution と同じ `authorship_spans` テーブルで、バッチ API `loadBatchAiRatio(sceneIds: string[])` により全シーンを 1 リクエストで取得する（N+1 を避けパフォーマンスを確保）
- シーン本文の自動保存完了時にバッジのキャッシュを無効化する。Attribution パネルの再集計完了時は未実装。

> **現状の実装**: `loadBatchAiRatio` は `src/features/attribution/api.ts` に実装され、`src/features/tree/treeStore.ts` の `loadTree` で全シーン分を初回ロードする。シーン本文の自動保存完了時は `treeStore.refreshAiRatio(nodeId)` が単一シーンの比率のみ再計算する（`EditorPane.tsx` / `LinearSceneBlock.tsx` から呼び出し）。バッジ表示は `TreeNodeItem.tsx` の `useTreeStore((s) => s.aiRatios[node.id])`。Attribution パネルの再集計完了時の無効化は連携していない。

### → Chat History（間接的）

- AIテキストにはchatMessageIdが記録されているため、将来的にはAttributionパネルからAIテキストの生成元チャットセッションに逆引きナビゲートする機能を追加可能（MVP後）

---

## 既存設計書との整合

### Editorパネル設計書

AuthorshipMark（source: human/ai/unknown, model, timestamp, chatMessageId）の定義、AttributionHighlight（背景色ハイライト）、`authorship_spans` テーブルのスキーマはEditor設計書を正とする。ステータスバーの「AI: {割合}%」クリック動作はEditor設計書で定義済み。

### レイアウト設計書

Attributionパネルの配置は Right Panel の "stats" タブをデフォルトとし、Bottom Dock 配置も許容する（レイアウト設計書の配置ルールを正とする）。`Ctrl+Alt+A` でフォーカス/トグル。

### Scenesパネル設計書

Sceneノードの「AI比率バッジ」（ツリー上のピル表示）はScenesパネルのUI要素だが、そのデータソースはAttributionの集計と同じ `authorship_spans` テーブル。取得 API は `loadBatchAiRatio` を共用し、集計ロジック・キャッシュ無効化タイミングも Attribution パネルと統一する。
