# NoveLoom — Claude Code 日常リファレンス

## セッション開始時

```
/context          # コンテキスト使用率を確認
/model sonnet     # デフォルトモデル確認
```

## タスク中

```
/compact          # 使用率50%で実行
/context          # こまめに確認
Shift+Tab×2       # Planモードへ切替（設計時）
Shift+Tab         # Normalモードへ戻す（実装時）
Esc               # 即停止
Esc×2             # チェックポイントに巻き戻し
```

## タスク完了時

```
/clear            # 必ずリセットしてから次のタスクへ
```

## モデル切替

```
/model sonnet     # 通常タスク
/model opus       # アーキテクチャ判断、難しいデバッグ
```

## 思考レベル

```
/effort low       # typo修正、設定変更
/effort medium    # 通常の実装（デフォルト）
/effort high      # 複雑なロジック、TipTap拡張
/effort max       # 原因不明のバグ、設計判断
```

## プロンプトテンプレート

### 通常の実装タスク
```
[何を作るか — 1文で]

技術要件:
- [具体的な制約1]
- [具体的な制約2]

受け入れ条件:
- [テストで確認できる条件1]
- [テストで確認できる条件2]

変更後、以下を順に実行:
1. npm test（全テスト通過）
2. npx tsc --noEmit（型エラーなし）
3. npm run lint:fix
```

### デバッグ
```
以下のエラーを修正して:
[エラー出力をそのまま貼り付け]
```

### 長いタスクの継続（Document & Clear後）
```
active/[task-name]/[task-name]-tasks.md を読んで続行して。
```

## コスト意識チェック

```
/cost             # API利用時: トークン消費確認
/status           # サブスク利用時: 残量確認
```
