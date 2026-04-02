# ADR-001: 文字単位の帰属追跡システム

## ステータス

採用済み (2026-04-02)、旧ADR-001（Agent Trace準拠）を置換

## コンテキスト

Grimodexの帰属追跡システムは当初、SPEC.md セクション3.2の3値分類（`human` / `ai` / `ai-edited`）で設計されていた。その後Cursor Agent Trace仕様（v0.1.0）への準拠を検討し（旧ADR-001）、4値分類（human/ai/mixed/unknown）への移行と編集率ベースの `ai` → `mixed` 遷移ロジックを計画した。

しかし設計を深めた結果、以下の理由でAgent Trace準拠から離れ、Grimodex独自の文字単位帰属追跡を採用した。

### Agent Traceとの相違点

| 項目 | Agent Trace v0.1.0 | Grimodex |
|------|-------------------|----------|
| 追跡粒度 | **行単位** | **文字単位**（TipTapのMark機構） |
| 分類値 | human / ai / mixed / unknown | human / ai / unknown |
| `mixed` の扱い | AIと人間の混合範囲 | **不採用**（後述） |
| 遷移ロジック | 編集率閾値で ai → mixed | **遷移なし** — AI生成テキストは編集されてもaiのまま |

### `mixed` を不採用とした理由

Agent Traceの `mixed` は行単位の追跡で、「この行はAIが書いて人間が手を入れた」を示す。Grimodexは文字単位の追跡であり、1つの段落内でも「AIが書いた範囲」と「人間が書いた範囲」が明確に区別される。そのため `mixed` という曖昧な分類が不要になった。

ブロック（段落・シーン）ごとのhuman/ai比率に基づく自動遷移ロジック（例: AI率が50%以下になったらmixedに変更）も検討したが、以下の理由で不採用とした:

- **恣意的な閾値**: 何%でmixedとするかの基準にユーザーが納得できる根拠がない
- **ソフト側での判定の不適切さ**: テキストの帰属をソフトウェアが自動的に変更することは、正確性より利便性を優先する判断であり、AI使用率の開示という帰属追跡の目的に反する
- **文字単位の粒度で解決済み**: 各文字のsourceが正確に記録されているため、統計集計時にhuman/ai比率を正確に算出できる。表示レイヤーで「このシーンはAI 24.9%」と示す方が、個々の範囲をmixedとラベル付けするより有用

### AI生成テキストの編集でsourceが変わらない理由

`ai` マーク付きテキストを人間が編集しても `ai` のまま維持する設計を採用した。理由:

- AIが生成した文章の一部を修正しても、文章の骨格・構造・表現の大部分はAI由来であり、帰属としてはaiが正確
- 人間の編集（誤字修正、語尾調整等）は新たなテキスト入力として `human` マークが付与される。AIテキストの「上から書き換えた」部分は自然にhumanになる
- 文字単位の追跡により、「AIが書いた文の中で人間が修正した箇所」は正確に記録される
- **AI文章の切り貼りによる構成**: ユーザーが複数のAI生成テキストを切り貼りして文章を組み立てた場合（新聞切り抜きの脅迫文のように断片を再構成するケース）、各断片は `ai` マークを維持する。文章全体の構成・順序は人間が決定しているが、テキスト自体はAIが生成したものであり、帰属としては `ai` が正確である。構成行為を `human` に変更すると、AI使用率が実態より低く報告される。構成の創造性は帰属統計ではなく、作品のクレジット等で別途表現すべきものである

## 決定事項

### 1. 3値分類の採用

| 値 | 意味 | 付与タイミング |
|----|------|-------------|
| `human` | ユーザーがキーボードで直接入力 | キーボード入力時 |
| `ai` | AIが生成したテキスト | Chat挿入、インラインAI Accept時。人間の編集後も維持 |
| `unknown` | 出自が追跡できないテキスト | 外部ペースト（Authorship情報なし）、インポート、マイグレーション前データ |

### 2. AuthorshipMarkの属性

```typescript
Mark.create({
  name: 'authorship',
  addAttributes() {
    return {
      source: { default: 'unknown' },    // 'human' | 'ai' | 'unknown'
      model: { default: null },            // 'claude-sonnet-4.6' etc.
      timestamp: { default: null },        // ISO 8601
      chatMessageId: { default: null },    // 抽出元チャットメッセージへの参照
    }
  },
})
```

`model` はAI生成テキストの生成モデルを記録し、Attributionパネルのモデル使用状況セクションで集計に使用する。

### 3. 永続化

`authorship_spans` テーブルに文字位置ベースで保存。対象ドキュメントの種別に応じて `node_id`（Scene/Note）、`codex_entry_id`（Codex content）、`snippet_id`（Snippet content）のいずれか1つを設定する。

正規スキーマは統合DBスキーマ設計書（`Grimodex_統合DBスキーマ.md`）を参照。

### 4. クリップボードによるAuthorship伝搬

アプリ内コピー時にカスタムMIMEタイプ `application/x-grimodex-authorship` でAuthorshipMarkのJSONを付与し、ペースト先で復元する。外部ペースト（MIME情報なし）は `unknown` にフォールバック。

詳細はEditorパネル設計書の「クリップボードのAuthorship伝搬」セクションを参照。

### 5. C2PA概念をスキップした理由

C2PA（Coalition for Content Provenance and Authenticity）の暗号署名アプローチは:

- 単一ユーザーアプリでの暗号署名は信頼チェーンが成立しない
- 署名検証の意味がない（自分自身を検証することになる）
- 実装コストに対してユーザー価値がない

### 6. エクスポート

Markdownエクスポート時にはAuthorshipMarkを除外し、クリーンなMarkdownを出力する。将来的にAuthorship情報を含むエクスポート形式が必要になった場合は、Grimodex独自のJSON形式を定義する（Agent Trace JSONとの互換性は追求しない）。

## 関連設計書

- **Editorパネル設計書**: AuthorshipMark定義、付与ルール、クリップボード伝搬
- **Attributionパネル設計書**: 統計集計・可視化（Human/AI/Unknown の3値）
- **Codexパネル設計書**: Codex contentのAttribution追跡
- **Snippetsパネル設計書**: Snippet contentのAttribution追跡
- **統合DBスキーマ**: `authorship_spans` テーブル定義
