# 共有 Rust バックエンド規約

## ディレクトリの位置づけ

- `src-tauri/crates/` は Electron の N-API backend と standalone MCP が使う現役の共有実装
- `electron/native/grimodex-node/` は共有 crates を Node/Electron main process へ公開する現行 binding
- `src-tauri` 直下 package（Tauri app shell、command 登録、capabilities）は Tauri v1 互換・移行確認用の frozen legacy
- 新機能は共有 crate + N-API + Electron IPC に実装し、root Tauri shell へ新しい command を追加しない
- legacy shell は削除済みではない。互換性・移行・セキュリティ修正に必要な最小変更だけを行う

## エラーハンドリング

- ライブラリコードで unwrap() 禁止、? でエラー伝播
- thiserror でドメインエラー定義、anyhow はアプリ層のみ
- 共有 crate は Electron / MCP / legacy shell のどれにも依存しないドメインエラーを返す
- N-API 境界では `AppError` を `napi::Error` の安定した文字列契約へ写像する

## N-API / Electron パターン

- Node へ公開する API は `electron/native/grimodex-node/` の `#[napi]` 境界に置く
- I/O、DB、推論などの重い処理は async API + `spawn_blocking` とし、Electron main thread を塞がない
- ペイロードは serde `Serialize` / `Deserialize` を実装し、camelCase ↔ Rust DTO の写像を明示する
- N-API method の追加だけで終えず、`electron/shared/ipcContract.ts`、main dispatch、preload 型、境界テストを同時に更新する
- API キーなどの秘密情報は renderer 引数から受けず、Electron main の `safeStorage` から解決して N-API へ渡す
- root の `#[tauri::command]` / `generate_handler![]` / capabilities は frozen legacy。新規 command の登録先にしない

## 所有権・ライフタイム

- 単純な .clone() で逃げる前に Arc<T> / Rc<T> を検討する
- 共有状態は `Arc<T>` で管理し、グローバル変数は禁止
- async N-API method と `spawn_blocking` closure の `Send + Sync + 'static` 制約に注意

## SQLite (rusqlite)

- DB 実装の正本は `src-tauri/crates/grimodex-db/`
- WALモード必須（並行読み込み性能）
- schema/migration は `grimodex-db` で管理し、Electron と MCP で同じ実装を使う
- renderer の通常 DB 操作は Drizzle が生成した SQL を typed IPC 経由で渡す
