---
name: add-tauri-command
description: >
  Tauriコマンド（IPC）を追加する。フロントエンドからRustバックエンドを
  呼び出す機能が必要なとき、invoke()の型定義・Rust側のコマンド定義・
  generate_handler登録・capabilities権限設定を一括で行う。
  「Tauriコマンド追加」「invoke追加」「Rust連携」で発火。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [command-name-and-description]
disable-model-invocation: true
---

Tauriコマンド「$1」を追加してください。以下の4箇所を漏れなく更新すること。

1. **Rust側コマンド定義** (`src-tauri/src/commands/`)
   - `#[tauri::command]` 関数を定義
   - 引数・戻り値に serde Serialize/Deserialize を実装
   - エラーは Result<T, String> で返す
   - unwrap() 禁止、? でエラー伝播

2. **handler登録** (`src-tauri/src/lib.rs`)
   - `generate_handler![]` に新コマンドを追加

3. **capabilities設定** (`src-tauri/capabilities/default.json`)
   - 新コマンドを許可リストに追加

4. **フロントエンド型定義・呼び出し** (`src/lib/tauri-commands.ts`)
   - invoke() のラッパー関数を型安全に定義
   - エラーハンドリングを含める

5. **テスト**
   - Rust側: `cargo test` で単体テスト
   - フロント側: invoke呼び出しのモックテスト

各ステップ完了後に確認を報告すること。
