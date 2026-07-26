# Codex App Server統合 影響マトリクス

添付の「Codex App Server統合 実装計画」に対する実装時の正本。既存の
`codex exec`、Claude Code、OpenCode、HTTP provider、Grimodex Agent Loopは
互換経路として保持する。

| ID | 実行経路 | 正本／producer | 境界・変換・検証 | consumer／sink | 保持する不変条件 | 互換・fallback | 検証 | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | Codex App Server protocol spike | `electron/shared/codexAppProtocol.ts` | JSON-RPC 2.0、JSONL、UTF-8、サイズ制限 | spike／unit tests | 改行・日本語・未知通知を安全に扱う | 実Codexはsmoke時だけ | protocol tests | implemented |
| P1 | App Server process／RPC | `electron/main/codexAppServer/` | main-only spawn、canonical path、環境allowlist、RPC相関 | manager | rendererに生RPC・cwd・実行ファイルを渡さない | pre-turnだけexec fallback | Electron unit／fake server | implemented |
| P2 | Thread binding persistence | `grimodex-db::runtime_threads` | project/session所有確認、runtime unique、revision保存 | App Server manager | session/projectを跨ぐbindingを許可しない | 不一致はarchive後new thread | Rust migration／N-API tests | implemented |
| P3 | Chat read-only transport | `resolveChatTurnRoute` + `codexAppApi` | Context Packet、Turn correlation、event allowlist | ChatStore | Claude/OpenCode/exec/HTTPの既存挙動を変えない | app-server開始前だけexec | renderer／Electron tests | implemented |
| P4 | Session consistency | `historyRevision` + manager | resume、late event隔離、title/archive | ChatStore／DB | 現在のsession authority以外のイベントを破棄 | revision divergenceはnew thread | route／manager／migration tests | implemented |
| P5 | Rich item／usage | normalized event metadata | item種別・status・usageの上限検証 | chat UI／chat_messages.metadata | 本文streamとitem metadataを混在させない | unknown itemはwarning | renderer tests | implemented |
| P6 | Grimodex MCP read-only | MCP sidecar config／allowlist | workspace path、tool名、timeout、出力量制限 | App Server thread | global configを直接書き換えない | MCP unavailableでもContext Packet | MCP／security tests | implemented |
| P7 | Approval／staged write | manager pending registry + Agent Write | requestId、workspace内path、AI Policy、OCC、Undo | approval UI／DB | 既定は全拒否、opt-in承認のみ、直接DB書込み禁止 | 未知requestは明示reject | security／Rust／renderer tests | implemented |
| R1 | Claude Code／OpenCode | 既存`cli-exec` | 既存`cli:*`イベント・payloadを維持 | ChatStore | CLI種別切替でCodex設定を漏らさない | 変更なし | regression tests | verified unchanged |
| R2 | HTTP／Agent | 既存chatApi／Agent Loop | route追加はprovider非CLIへ影響させない | ChatStore | Agent LoopとCodex runtimeを二重起動しない | 変更なし | frontend／targeted tests | verified unchanged |

## P7 の書き込み境界

App Server に渡す Grimodex MCP は常に `--readonly` とし、MCP からの直接 DB 書込みは
許可しない。構造化データの変更は既存の Agent Write 経路（AI Policy、project scope、
OCC、authorship、change event、Undo Journal、Revision）を出口にする。本文 prose は
`propose_scene_body` → `prose_staging` → Diff／承認 → `autoApplyProse` の既存 staged
経路を使い、stale `baseVersion` や file-backed scene は自動適用せず手動レビューへ戻す。

一方、App Server のコマンド／ファイル変更要求は `codexAllowApprovals` の永続 opt-in
がある場合だけ `workspace-write`／`on-request` とし、main が workspace 内 path と
pending request ID を再検証した承認カードへ渡す。未知 request、workspace 外 path、
接続終了・Turn 終了時の未解決 request は明示的に拒否／解放する。

## 実装順

P0→P1→P2→P3→P4をread-only初期統合とし、P5→P6→P7を同じ manager／IPC 境界へ
積み上げた。既存の exec／HTTP／Claude／OpenCode／Agent 経路は変更せず、互換設定の
既定値は `exec` のまま保持している。
