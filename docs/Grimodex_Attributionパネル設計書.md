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
│ claude-sonnet-4.6   ████████████████  7,230 chars (55.2%)       │
│ gpt-4o              ████████          3,840 chars (29.3%)       │
│ claude-haiku-4.5    ████              2,030 chars (15.5%)       │
└─────────────────────────────────────────────────────────────────┘
```

Bottom Dockの横長レイアウトを活かし、サマリーカード・ブレークダウンバー・テーブルを縦に並べる。

---

## A. ヘッダー

- **パネルタイトル**: 「Attribution」
- **Scopeセレクター**: 統計の集計範囲を切り替えるトグルボタン（2段階）

| Scope | 集計範囲 |
|-------|---------|
| シーン（デフォルト） | アクティブなシーンの統計をリアルタイム表示 |
| プロジェクト | 全シーンをチャプター別にグルーピングして表示（DBから集計） |

> **実装メモ**: Part / Chapter 単位の独立スコープは未実装。プロジェクトスコープの
> チャプターグルーピング（折りたたみ可能）で代替する。

Scopeを切り替えると、B〜Eの全セクションが即座に再計算される。

Editorのアクティブシーンが変わったとき:
- Scopeが「シーン」の場合 → アクティブシーンに自動追従（editor.state.doc から即時再計算）
- Scopeが「プロジェクト」の場合 → 変更なし（DBから集計するため手動リフレッシュまで維持）

---

## B. サマリーカード

4枚のメトリックカードを横並びで表示。

| カード | 値 | 色 |
|--------|-----|-----|
| Total | 合計文字数 | グレー |
| Human | Human文字数 + 割合 | グレー（デフォルト、マーカーなし） |
| AI | AI文字数 + 割合 | パープル (#7F77DD) |
| Unknown | Unknown文字数 + 割合 | アンバー (#BA7517) |

各カードはクリック可能。クリックするとそのsourceのテキストだけをEditorのAttributionHighlight上で強調表示する（他のsourceを薄くする）。再クリックで解除。

---

## C. ブレークダウンバー

水平のスタック棒グラフ。3色で割合を視覚的に表示。

```
[████████████████████████░░░░░░░░░░░░▒▒▒▒▒▒]
 Human (グレー)          AI (パープル)  Unknown (アンバー)
```

- 各セグメントにホバーで割合と文字数のツールチップ
- セグメントをクリック → サマリーカードのクリックと同じフィルタ動作
- バーの高さ: 24px。角丸。各セグメントの最小幅は2px（0%でない場合は可視化保証）

---

## D. シーン別テーブル

### テーブル構造

| カラム | 内容 |
|--------|------|
| Scene | シーン名（ブレッドクラム形式: Ch1 / The tower） |
| Total | 合計文字数 |
| Human | Human文字数 |
| AI | AI文字数 |
| Unknown | Unknown文字数 |
| AI% | AI / Total * 100。ミニプログレスバー付き |

### 表示ルール

- Scopeに応じてテーブルの行が変わる:
  - プロジェクト → 全シーンをチャプター別グルーピングで表示
  - シーン → テーブル非表示（単一シーンのためサマリーカードのみ表示）
- デフォルトソート: ツリー順（Part > Chapter > Scene）
- カラムヘッダークリックでソート切り替え（Total、AI%等で降順/昇順）

### 行のインタラクション

| 操作 | 動作 |
|------|------|
| 行クリック | ScopeをそのSceneに切り替え + Editorでそのシーンを開く |
| 行ホバー | 軽いハイライト |
| AI%カラムのミニバー | ブレークダウンバーと同じ3色スタックの縮小版 |

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

各モデルを水平棒グラフ + 文字数 + 割合で表示。

```
claude-sonnet-4.6   ████████████████  7,230 chars (55.2%)
gpt-4o              ████████          3,840 chars (29.3%)
claude-haiku-4.5    ████              2,030 chars (15.5%)
```

- AuthorshipMarkの `model` フィールドから集計
- `model` がNULLの場合（手動でai markを付けた場合等）は「Unknown model」として表示
- バーはパープル系の濃淡で区別
- モデルが1種類のみの場合はこのセクションを折りたたみ表示

---

## データ集計

### 集計ロジック

```typescript
interface AttributionStats {
  totalChars: number;
  humanChars: number;
  aiChars: number;
  unknownChars: number;
  modelBreakdown: Record<string, number>;  // model名 → 文字数（source: 'ai' のみ対象）
}

function computeAttribution(sceneIds: string[]): AttributionStats {
  // 方法A: TipTapドキュメントがメモリ上にある場合
  //   → AuthorshipMarkをドキュメントから直接集計（最速）
  // 方法B: TipTapドキュメントが未ロードの場合
  //   → authorship_spans テーブルからSQLで集計

  // 方法Aを優先し、未ロードのシーンのみ方法Bで補完する
}
```

### 集計タイミング

- Attributionパネルが表示されている場合: エディタの自動保存完了後に再計算（デバウンス3秒）
- Attributionパネルが非表示の場合: 再計算しない（パネル表示時に初回計算）
- Scope変更時: 即座に再計算

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

| 属性 | 型 | 用途 |
|------|----|------|
| `source` | `'human' \| 'ai' \| 'unknown'` | 帰属種別 |
| `timestamp` | ISO8601 文字列 | マーク付与時刻 |
| `model` | string \| null | 生成モデル名（AI のみ） |
| `chatMessageId` | string \| null | 生成元チャットメッセージ |
| `traceId` | string \| null | Agent Trace v0.1.0 連携用のトレース ID |
| `toolName` | string \| null | エージェント経由書き込み時のツール名 |
| `toolVersion` | string \| null | 同ツールのバージョン |
| `manualOverride` | boolean | `AttributionOverrideMenu` による手動変更フラグ |
| `originalLength` | number \| null | 原文文字数（AI 編集後の差分追跡用） |

> **命名規約**: DB カラムは `chat_msg_id` のようにスネークケースで保持するが、Mark 属性名はキャメルケース（`chatMessageId`）を使用する。相互変換は API レイヤの責務とする。

### `authorship_spans` の対象エンティティ

`authorship_spans` は `node_id`（シーン ProseMirror ノード ID）に加え、以下の参照カラムを持ち、シーン本文以外の編集対象にも帰属を記録できる。

- `codex_entry_id`: Codex エントリ本文
- `snippet_id`: Snippet 本文
- `detail_value_id`: カスタムディテール値
- `phase_id`: フェーズ固有本文
- `sticky_id`: Map Sticky body（Map パネル設計書で追加）

いずれの参照カラムも NULL 許容で、1 レコードにつき排他的に 1 つだけが非 NULL となる。Attribution パネルの集計は、スコープに応じてこれら参照カラムも対象に含める。

**プロジェクト全体の集計に Map Sticky を含める**: Sticky body は ProseMirror JSON で保持され、AI Branch 由来は初期 `ai`、ユーザーが編集すると `human` に切り替わる。Attribution パネルの「プロジェクト」スコープでは Sticky の文字数も AI 比率に算入する。サマリーカード上で「Map Stickies: N 件、AI X%」のように内訳を 1 行表示する（v2 で UI 拡張）。

### AiEditedPlugin

AI / Unknown スパン内にユーザーが文字を挿入した場合、挿入されたテキスト部分のマークを剥がし自動的に human 化する ProseMirror プラグイン。

- 対象はあくまで「新規挿入されたテキストレンジ」のみで、前後の既存 AI マークは保持する
- `programmaticInsert` meta を立てたトランザクション（貼り付け復元、Snippet 挿入、履歴リストア等）には作用しない
- 手動オーバーライド（`manualOverride: true`）が付与されたマークは剥がさない

### AttributionOverrideMenu

エディタ上で選択範囲を右クリックして表示されるコンテキストメニュー。選択範囲の `source` を手動で `human` / `ai` / `unknown` のいずれかに書き換える。

- オーバーライド後のマークには `manualOverride: true` が付与され、後続の `AiEditedPlugin` や自動判定ロジックでは上書きされない
- 既存の timestamp / model / chatMessageId は維持（ただし source が human に変更された場合は model を NULL に置き換える）

### Codex / Snippet エディタでの初期マーク付与

Codex / Snippet のミニエディタで AI 由来コンテンツを開いた際、保存済みの `authorship_spans`（`codex_entry_id` / `snippet_id` 参照）から `applyInitialMarks` が一括でマークを復元する。ミニエディタ上でも通常エディタと同等の AttributionHighlight・Attribution 集計が機能する。

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

| Source | Characters | Percentage |
|--------|-----------|-----------|
| Human | 28,420 | 67.1% |
| AI | 9,230 | 21.8% |
| Unknown | 4,700 | 11.1% |
| **Total** | **42,350** | **100%** |

## By Chapter

### Chapter 1: Awakening
...

## By Model

| Model | Characters | Percentage |
|-------|-----------|-----------|
| claude-sonnet-4.6 | 7,230 | 55.2% |
| gpt-4o | 3,840 | 29.3% |
...
```

**CSV形式**: シーン別テーブルをCSVで出力。BIツールやスプレッドシートでの分析用。

**Agent Trace v0.1.0 形式**: MIME タイプ `application/vnd.agent-trace.record+json` で AI 由来スパンを機械可読なトレースレコードとして書き出す。各レコードには `traceId` / `toolName` / `toolVersion` / `model` / `chatMessageId` の他、原文・現在本文の SHA-256 を表す `contentHash` を含め、外部監査ツールや AI 利用開示パイプラインへ入力できる。MD / CSV レポートと並列のエクスポート手段として提供。

エクスポートはTauriのファイルダイアログで保存先を選択。

---

## キーボードショートカット

| ショートカット | 動作 |
|-------------|------|
| `Ctrl+Alt+A` | Attributionパネルにフォーカス/トグル（レイアウト設計書で定義済み） |

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
- シーン本文の自動保存完了時、および Attribution パネルの再集計完了時にバッジのキャッシュを無効化する

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
