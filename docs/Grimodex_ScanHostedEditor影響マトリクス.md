# Grimodex Web Editor only 影響マトリクス

## 目的

公開 Web 版を「Grimodex 本体エディターの試用」に限定する。Scan、原稿アップロード、
Hosted AI を撤去し、AI はユーザーが明示的に設定した Local LLM、OpenAI 互換 endpoint、
またはユーザー所有キーによる全 HTTP provider（OpenRouter / OpenAI / Anthropic /
Sakana / AI のべりすと）を利用できる契約にする。ユーザーが明示的に
選んだローカル原稿のインポートはブラウザー内で完結させ、クラウド送信とは分離する。

## 変更契約

### 保持する振る舞い

- Web Editor は `App -> LayoutShell -> EditorPane` の本体経路を使う。
- Web の原稿・ワークスペースはブラウザーの IndexedDB、UI・AI 設定は Local Storage、
  BYOK API key はページの実行メモリにだけ保存する。
- `.grimodex-handoff` によるローカル Grimodex への引き継ぎを提供する。
- Web Editor は既存のローカルインポート形式（Novelcrafter ZIP、カクヨム ZIP、
  Markdown / Markdown ZIP / Markdown フォルダー、`.novel`）をブラウザー内で処理する。
- BYOK の API key はページの実行メモリにだけ保持し、再読込後は再入力を求める。
- Desktop Electron の typed preload IPC、secure secret store、既存 AI provider 経路は変更しない。
- AI のプロジェクト機能許可 (`AiPolicy`) と外部送信への同意証跡は別契約とする。

### 変更する振る舞い

- 公開配信物は root の Web Editor だけとし、Scan Pages / Worker / R2 / D1 / Workflow
  および Scan 専用デプロイ経路を廃止する。
- Web Editor は Scan token、seed、Hosted AI session を読まず、ネットワーク bootstrap
  なしで IndexedDB workspace を復元する。
- Web の既定 AI 設定は未接続の Ollama とし、endpoint / model または BYOK key を
  ユーザーが明示設定するまで AI request を発行しない。
- Web の provider 選択肢は、CLI を除く HTTP provider
  （OpenRouter、OpenAI、Anthropic、Ollama、OpenAI 互換、Sakana、AI のべりすと）
  とする。固定 API はユーザー自身の key、Ollama／OpenAI 互換はユーザー指定 endpoint
  を使い、アプリ所有 key や管理型 provider は追加しない。
- 試用 UI と利用規約・プライバシー文書で、AI サブスクリプションや付属 AI ではなく
  Local LLM / BYOK が必要であることを明記する。
- Web のローカルファイルインポート能力を、desktop 専用のエクスポート／handoff import
  能力から分離する。Web の通常エクスポート制限は維持する。

### 禁止動作

- 原稿、Scan seed、AI key、AI session を Grimodex の Web backend へ送信・保存しない。
- Hosted credential、共用 OpenRouter key、provider access override を client bundle へ含めない。
- AI provider、送信範囲、保存・学習方針への版付き同意なしに AI request を発行しない。
- Browser で native-only command、Hosted AI、Scan upload を利用可能と表示しない。
- Web のインポート画面へ Scan bundle / Scan staging の入口や実装 chunk を含めない。
- ユーザーが選んだインポートファイルを Grimodex の Web backend へ送信しない。
- legacy Scan fragment や sessionStorage 値を復元・consume しない。

## 実行経路マトリクス

| ID             | 入口 / producer              | 変換・検証・権限境界                                              | consumer / sink                                          | 不変条件                                                              | fallback / migration                                                 | 検証                                                            | 状態                                      |
| -------------- | ---------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| WEB-EDITOR-01  | `GET /editor` / SPA fallback | App mount 前に IndexedDB を復元                                   | 本体 `App` / `EditorPane`                                | Scan 不要、簡易 editor 不可、network bootstrap なし                   | 保存なしは新規 workspace                                             | runtime + DOM identity test                                     | verified                                  |
| WEB-EDITOR-02  | IndexedDB snapshot           | revision / checksum / schema version                              | SQL.js BrowserMock                                       | commit 後だけ保存                                                     | 破損時は明示 recovery                                                | round-trip / reload / conflict test                             | verified                                  |
| WEB-HANDOFF-01 | 試用 Editor の CTA           | workspace bytes を handoff schema へ変換                          | local Grimodex import                                    | 原稿を app backend へ送らない                                         | ユーザーが明示 download                                              | handoff unit test                                               | verified                                  |
| WEB-IMPORT-01  | Project menu の Import       | Web 専用 source allowlist、入力 64/32 MiB、ZIP 展開量・深度 guard | BrowserMock / IndexedDB                                  | 選択ファイルをブラウザー内だけで処理、Scan 入口なし                   | 不正・未対応・過大入力は read / preview 前に拒否                     | capability / dialog / parser / File-to-persistence browser test | verified                                  |
| WEB-IMPORT-02  | Markdown folder picker       | browser `FileList`、1万件 / 64 MiB / 64階層、`webkitRelativePath` | BrowserMock / IndexedDB                                  | native path read なし、Web backend 通信なし                           | 非対応時は単一 Markdown または ZIP                                   | live browser UI / limit / no-transport artifact test            | verified                                  |
| WEB-AI-01      | Web Editor 起動              | 既定 Ollama、空 model、HTTP provider allowlist                    | request なし                                             | AI は付属・自動有効でない                                             | HTTP provider の role routing を保持し、native CLI だけ除去          | settings / role migration / session persistence test            | verified                                  |
| WEB-AI-02      | 固定 API の BYOK             | key は page-memory、版付き同意、typed transport                   | OpenRouter / OpenAI / Anthropic / Sakana / AI のべりすと | reload 後 key 消失、同意前 fetch ゼロ                                 | error を UI に明示                                                   | endpoint / auth / transport spy / revision test                 | verified (Sakana production は WEB-AI-05) |
| WEB-AI-03      | Local Ollama                 | user endpoint / model、版付き同意、origin / browser 権限案内      | user Local LLM endpoint                                  | Grimodex backend を経由せず、接続先変更時は再同意                     | 未接続は設定案内                                                     | route / consent / endpoint propagation test                     | verified                                  |
| WEB-AI-04      | OpenAI 互換 endpoint         | user base URL / optional page-memory key / model / 版付き同意     | user-configured endpoint                                 | 実際の base URL を同意 identity に含め、変更時は再同意                | CORS 非対応 endpoint は運用者側設定を案内                            | endpoint selection / keyless / consent test                     | verified                                  |
| WEB-AI-05      | Sakana BYOK                  | 開発時は Vite same-origin proxy、本番は公式 API へ direct         | `api.sakana.ai`                                          | Grimodex relay に原稿・key を送らない                                 | 公式 API が公開 origin の CORS preflight 非対応の間は本番 Heavy 未達 | endpoint contract + live OPTIONS確認                            | blocked-production-cors                   |
| DEPLOY-01      | root Vite build              | static Pages artifact のみ                                        | `grimodex-try[-staging]`                                 | Worker/API env 不要、Scan Pages / Worker artifact なし                | deploy 前 local verify                                               | web-only build + artifact validator                             | verified                                  |
| RETIRE-01      | 旧 Scan UI / API             | package・migrations・R2/D1/Workflow・deploy scripts を削除        | 既存リモートは未停止                                     | リポジトリから新規 upload/scan を配備できない                         | 公開停止またはデータを含む完全削除は別途明示選択                     | workspace/search audit + remote reachability check              | remote-pending                            |
| RETIRE-02      | legacy Scan URL / session    | 値を無視し、consume/fetch しない                                  | standalone workspace                                     | URL token を永続化しない                                              | 通常の試用 Editor 起動                                               | fetch spy / runtime test                                        | verified                                  |
| DESKTOP-01     | Electron                     | typed preload IPC / secure key store                              | native AI runtime                                        | Desktop provider・保存挙動を維持                                      | なし                                                                 | existing Electron / frontend tests                              | verified                                  |
| DESKTOP-02     | Electron Project Import      | 既存 TransferDialog、native picker、Web 専用入力上限は無効        | native workspace                                         | Scan を含む既存 desktop import の外部挙動を維持、過深 path は安全拒否 | なし                                                                 | existing import / transfer tests + desktop build                | verified                                  |

## AI 開示の出力契約

Web Editor の外部 AI 送信は `route: "byok"` に限定する。UI は少なくとも provider、
送信範囲、処理先、アプリ内保存、provider の保持・学習方針、削除方法、policy URL、
policy version を表示し、`policyVersion + route + providerId + actualDestination` への明示同意を保存する。
必須値が未確定の場合は `[precheck]` として request を発行しない。

Local Ollama と OpenAI 互換は表示されたユーザー設定 endpoint を利用すること、
OpenRouter / OpenAI / Anthropic / Sakana / AI のべりすとはユーザー自身の契約と key で
固定 API へ送信することを区別して表示する。ルーティング型 provider は選択される下流
processor がアカウント・モデル設定に依存することも開示する。

## 品質追跡

- 関連 requirement: `GDX-AI-CONSENT-001`, `GDX-PRECHECK-001`,
  `GDX-POLICY-001`, `GDX-ROUTE-001`, `GDX-TRACE-001`
- Light: browser runtime、BrowserMock AI allowlist・CLI role migration、BYOK consent、
  fresh Web session model、trial UI、Web import allowlist、AI path registry、Editor Pages deploy plan、
  workspace/build
- Web import: 4 source の実ダイアログ、busy 中の close/source/target lock、read 前の入力上限、
  予期しない部分失敗後の Close-only 状態と source/target/tab lock、Markdown ZIP / folder の深度上限、compiled artifact の
  Scan / import transport 除外、実 File → parser → import API → BrowserMock → 永続化・復元と通信 API 未使用
- Heavy: 実 BYOK provider / Local Ollama、Web Editor reload、Desktop 回帰
- 実 provider credential または隔離された Local LLM がない環境で Heavy を passed にしない。
- 旧 Scan staging の Pages / Worker は現時点で到達可能なため、公開停止またはデータを含む
  完全削除を明示的に選択して実行するまで `RETIRE-01` を完了扱いにしない。
