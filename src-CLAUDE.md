# src フロントエンド規約

## React コンポーネント
- 関数コンポーネント + hooks のみ、class component 禁止
- 1ファイル1コンポーネント、200行超えたら分割
- props の型は同ファイル内で interface 定義

## 状態管理
- グローバル状態: Zustand（features/[name]/stores/）
- 局所UI状態: Jotai atom（シーン開閉、フォーカス位置等）
- サーバー状態（DB）: Tauri Command invoke → Zustand で保持

## TipTap エディタ
- カスタムノード/マークは features/editor/extensions/ に配置
- Pure Decorations でハイライト（文書構造を汚さない）
- シーンごとに独立インスタンス、巨大単一ドキュメント禁止

## Tauri IPC 呼び出し
- invoke() は @tauri-apps/api/core 経由、型安全に
- 戻り値の型は src/lib/tauri-types.ts で一元管理
- エラーは try-catch で捕捉、ユーザー向けトーストで表示
