# ADR-001: Agent Trace v0.1.0 準拠の帰属追跡システム

## ステータス

採用済み (2026-03-31)

## コンテキスト

NoveLoomの帰属追跡システムは当初、3値分類（`human` / `ai` / `ai-edited`）で設計されていた（SPEC.md セクション3.2）。Cursor Agent Trace仕様（v0.1.0, 2026年1月公開）がテキスト帰属追跡の唯一のオープン標準として登場し、NoveLoomの帰属システムとの整合性を評価した結果、早期準拠が将来の互換性において有利と判断した。

### 課題

- 帰属分類が3値（human/ai/ai-edited）で、Agent Traceの4値（human/ai/mixed/unknown）と不整合
- `human` マークは型定義のみ存在し、実際には付与されない（マークなし = human の暗黙ルール）
- `model` 属性が未使用
- SQLite永続化が未実装
- エクスポート/インポート機能なし
- 手動上書きUI なし

## 決定事項

### 1. Agent Trace仕様への準拠を選択した理由

Agent Traceはコード向け仕様だが、テキスト帰属追跡の唯一のオープン標準である。NoveLoomが早期に準拠することで:

- 将来のテキスト領域への標準拡大時に先行者となれる
- エクスポートデータの相互運用性が確保される
- 帰属メタデータの構造化が標準に沿って行える

### 2. 分類値の変更

| 変更前 | 変更後 | 理由 |
|--------|--------|------|
| `ai-edited` | `mixed` | Agent Trace準拠。人間とAIの混合を意味的に正確に表現 |
| (なし) | `unknown` | インポート/ペースト時のデフォルト値として追加 |
| `snippet` | `snippet` (維持) | NoveLoom独自拡張として `dev.noveloom.*` 名前空間で維持 |

### 3. 意味的変化検出（Transformers.js）を保留した理由

調査の結果、Transformers.jsによる意味的変化検出は以下の理由で保留とした:

- 日本語モデルの品質が実用レベルに達していない
- エディタの同期的なトランザクション処理と非同期推論の不整合
- 現行の編集率ベースの閾値判定（10%/5文字）が実用上十分に合理的

### 4. C2PA概念をスキップした理由

C2PA（Coalition for Content Provenance and Authenticity）の暗号署名アプローチは:

- 単一ユーザーアプリでの暗号署名は信頼チェーンが成立しない
- 署名検証の意味がない（自分自身を検証することになる）
- 実装コストに対してユーザー価値がない

### 5. SPEC.md セクション3.2からの変更点

| 項目 | SPEC.md (旧) | Agent Trace準拠 (新) |
|------|-------------|---------------------|
| 分類値 | human/ai/ai-edited | human/ai/mixed/unknown/snippet |
| メタデータ | source, ai_message_id | + traceId, toolName, toolVersion, model (provider/model形式), manualOverride |
| 遷移ロジック | 即座にai→ai-edited | 編集率閾値（10%/5文字）で判定 |
| 手動上書き | なし | コンテキストメニューで帰属変更可能 |
| エクスポート | なし | Agent Trace JSON (.agent-trace.json) |
| SQLiteスキーマ | 基本6カラム | 拡張13カラム（Agent Trace属性含む） |

## 実装概要

- **Phase 1**: 分類値・メタデータ拡張（AuthorshipMark, AiEditedPlugin, 全テスト更新）
- **Phase 2**: 手動帰属上書きUI（AttributionOverrideMenu, manualOverrideガード）
- **Phase 3**: 編集率ベース閾値（EDIT_RATIO_THRESHOLD=0.1, EDIT_ABS_THRESHOLD=5）
- **Phase 4**: Agent Trace JSONエクスポート（agentTrace.ts, ExportAgentTraceButton）
- **Phase 5**: SQLite永続化（authorship_spansテーブル, 保存/復元フロー）

## 影響

- 既存の `ai-edited` を参照するコードは全て `mixed` にリネーム済み
- `attributionStats` のフィールド名が `aiEdited` → `mixed` に変更
- CSS クラス名が `attribution-ai-edited` → `attribution-mixed` に変更
- `insertFromChat` のシグネチャに `model?` パラメータが追加
