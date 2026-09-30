---
name: add-electron-command
description: >
  Grimodex に新しい Electron IPC コマンドを追加し、共有契約、main／N-API 実装、
  preload 境界とテストを揃える。既存コマンドの不具合修正は debug-issue を使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [command-name-and-description]
disable-model-invocation: true
---

Electron IPC コマンド「$1」を追加する。次の境界を漏れなく更新すること。

1. **コマンド契約** (`electron/shared/ipcContract.ts`)
   - renderer から受け取る引数を検証し、camelCase から native 引数への写像を明示する
   - Rust N-API コマンドは `NapiBackendLike` と `NAPI_COMMANDS` に登録する
   - main TypeScript コマンドは `ShellCommandHandlers` / `SHELL_COMMAND_NAMES` に登録する
   - エラーは `Envelope` に正規化し、allowlist 外の任意 IPC は許可しない

2. **実装**
   - DB・検索・重い純ロジックは共有 Rust crate と
     `electron/native/grimodex-node/src/` の N-API adapter に置く
   - OS / Electron API は `electron/main/` の manager または shell handler に置く
   - renderer へ Node API、秘密情報、任意ファイルアクセスを露出しない

3. **preload / renderer**
   - 既存の `grim:invoke` ルーターを使い、コマンド専用の無制限チャネルを増やさない
   - 必要な場合だけ `src/lib/tauri.ts` 互換 facade または feature wrapper を型安全に更新する
   - main→renderer event を追加する場合は `EVENT_CHANNEL_ALLOWLIST` に完全一致で登録する

4. **テストと生成物**
   - `electron/shared/ipcContract.test.ts` で正常系・不正引数・backend 不在を検証する
   - main manager / Rust crate / N-API adapter の単体テストを追加する
   - N-API API を変えた場合は正規の build script で `index.d.ts` を再生成する

5. **検証**
   - `pnpm test:electron --run`
   - `pnpm exec tsc -p electron/tsconfig.json --noEmit`
   - renderer を変更した場合は `pnpm test:node --run` と `pnpm exec tsc --noEmit`
   - Rust を変更した場合は対象 crate の `cargo test` / `cargo clippy`

Tauri の `generate_handler!` や capabilities は更新しない。既存 Tauri v1 コードは
凍結した移行元であり、新機能の実装先ではない。
