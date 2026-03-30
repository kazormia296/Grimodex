# src-tauri Rust バックエンド規約

## エラーハンドリング
- ライブラリコードで unwrap() 禁止、? でエラー伝播
- thiserror でドメインエラー定義、anyhow はアプリ層のみ
- #[tauri::command] の戻り値は Result<T, String> または Result<T, AppError>

## Tauri Command パターン
- invoke可能な関数は #[tauri::command] マクロ付与
- generate_handler![] への登録を忘れないこと
- capabilities/default.json で明示的にコマンドを許可
- ペイロードは serde Serialize/Deserialize を実装

## 所有権・ライフタイム
- 単純な .clone() で逃げる前に Arc<T> / Rc<T> を検討する
- State<'_, T> でアプリ状態を管理、グローバル変数禁止
- async command 内では Send + Sync 制約に注意

## SQLite (sqlx)
- WALモード必須（並行読み込み性能）
- マイグレーションは sqlx::migrate!() マクロで管理
- クエリは sqlx::query! / sqlx::query_as! で型安全に
