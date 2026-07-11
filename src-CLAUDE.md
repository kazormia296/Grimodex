# src フロントエンド規約

## React コンポーネント

- 関数コンポーネント + hooks のみ、class component 禁止
- 1ファイル1コンポーネント、200行超えたら分割
- props の型は同ファイル内で interface 定義

## 状態管理

- グローバル状態: Zustand（features/[name]/stores/）
- 局所UI状態: Jotai atom（シーン開閉、フォーカス位置等）
- ネイティブ状態（DB）: Electron preload IPC → Zustand で保持

## TipTap エディタ

- カスタムノード/マークは features/editor/extensions/ に配置
- Pure Decorations でハイライト（文書構造を汚さない）
- シーンごとに独立インスタンス、巨大単一ドキュメント禁止

## Electron IPC 呼び出し

- renderer から `electron`、Node API、N-API モジュールを直接 import しない
- コマンドは `src/lib/tauri.ts` の `invoke()` 互換 facade を使う（ファイル名は legacy 互換。Electron では `window.grimodex` に委譲）
- dialog / fs / window 操作は各 `src/lib/` wrapper を使い、`window.grimodex` を feature から直接触らない
- preload 公開型は `src/types/grimodex-bridge.d.ts`、IPC 契約の正本は `electron/shared/ipcContract.ts`
- 新しいコマンドは main の allowlist・入力検証・N-API 写像まで一組で追加し、renderer 任意チャネルを許可しない
- エラーは try-catch で捕捉し、ユーザー向けトーストで表示する
- `@tauri-apps/api/*` を新規利用しない。既存分岐は凍結した Tauri v1 互換経路としてのみ扱う
