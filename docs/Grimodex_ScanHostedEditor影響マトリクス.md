# Grimodex Scan / Hosted Editor 影響マトリクス

## 目的

Scan の結果から開く編集画面を簡易 TipTap ではなく Grimodex 本体の
Editor へ切り替え、`/editor` から単体でも起動できるようにする。同時に、
Web の DB 永続化、Hosted AI / BYOK の実経路、AI 送信前の版付き開示と
明示同意、Scan / Editor の分離配信を一つの契約として固定する。

## 変更契約

### 保持する振る舞い

- Desktop Electron は従来どおり typed preload IPC、N-API、OS の secure secret
  store を使う。Web 向け実装を Desktop の fallback にしない。
- Editor の表示と保存は `App -> LayoutShell -> EditorPane` の本体経路を使う。
- Scan seed は `@grimodex/scan-contract` で検証し、既存の staged import plan を使う。
- AI のプロジェクト機能許可 (`AiPolicy`) と、外部送信への同意証跡は
  別契約とする。

### 変更する振る舞い

- Scan Pages は Scan だけ、Hosted Editor Pages は本体 Editor だけを配信する。
- Scan CTA は one-time seed token を URL fragment で Editor へ渡し、Editor が fragment
  を即時消去した後に Authorization header で一度だけ consume する。
- BrowserMock は新規 DB bytes と復元 DB bytes の両方から初期化でき、commit
  完了後だけ dirty を通知する。
- AI は Hosted / BYOK の型付き transport を通し、chat / agent / inline / codex
  の契約、cancel、error を保存する。
- Scan upload 前と AI 初回送信前に、実際の経路から解決した開示文を
  表示する。provider、policy version、送信範囲、処理/保存先、保持期間、
  学習利用、削除方法のいずれかが未確定な場合は fail closed とする。

### 禁止動作

- 未同意、古い同意版、または別 provider への同意で upload / AI 送信しない。
- scan token を URL query、localStorage、永続 workspace に保存しない。Editor には
  Editor AI だけを許可する scope token を渡す。
- Hosted secret を client bundle へ含めない。BYOK key を未同意で保存しない。
- Authorization 付き request、seed endpoint、AI endpoint、private report を
  Service Worker / Cache API に保存しない。
- Browser で native-only コマンドを利用可能と表示しない。

## 実行経路マトリクス

| ID            | 入口 / producer               | 変換・検証・権限境界                                       | consumer / sink           | 不変条件                                      | fallback / migration              | 検証                                |
| ------------- | ----------------------------- | ---------------------------------------------------------- | ------------------------- | --------------------------------------------- | --------------------------------- | ----------------------------------- |
| WEB-EDITOR-01 | `GET /editor`                 | browser runtime を App mount 前に復元                      | 本体 `App` / `EditorPane` | Scan 不要、簡易 editor 不可                   | 保存なしは新規 workspace          | route + DOM identity test           |
| WEB-EDITOR-02 | IndexedDB snapshot v3         | revision / checksum / schema version                       | SQL.js BrowserMock        | bytes は commit 後だけ保存                    | v2 seed snapshot を staged import | round-trip / reload / conflict test |
| WEB-EDITOR-03 | Scan CTA                      | one-time token 発行、fragment 除去、atomic consume         | Editor import bootstrap   | token はログ・query・SW cache に残さない      | 期限/replayは report へ戻す       | token + E2E test                    |
| WEB-DB-01     | `createBrowserMock(options)`  | DDL は新規時のみ、renderer schema parity                   | SQL.js                    | restore bytes を seed で汚さない              | screenshot seed は新規時のみ      | schema / bytes tests                |
| WEB-DB-02     | DB `run` / batch / timelapse  | transaction 成功後に dirty を1回                           | persistence controller    | SELECT / rollback は dirty にしない           | export 中再 dirty は次 flush      | mutation tests                      |
| AI-CONSENT-01 | Scan upload intent            | Workerが版付き disclosure と同意証跡を検証                 | R2 upload / Scan workflow | 同意前は原稿 bytes 送信ゼロ                   | policy 更新時は再同意             | client + router + repository tests  |
| AI-CONSENT-02 | Hosted Editor AI              | editor scope token + server consent record                 | Scan Worker AI provider   | scan delete/publication 権限は付与しない      | 失効後は再認証または BYOK         | scope / consent / denial tests      |
| AI-CONSENT-03 | Standalone BYOK               | route + provider + policy version をローカル同意証跡と照合 | 選択 provider API         | 未同意は fetch ゼロ、key は Hosted へ送らない | 非安全な永続保存は選択させない    | transport spy / revision test       |
| AI-ROUTE-01   | chat / agent / inline / codex | typed web AI adapter、request id、AbortSignal              | Hosted Worker または BYOK | UI の event payload 契約を維持                | Hosted 無効時は明示 error         | stream / cancel / error tests       |
| AI-ROUTE-02   | Hosted Worker                 | provider 設定と開示 metadata を同じ env から解決           | Workers AI / ZDR provider | 学習/保持を推測で表示しない                   | metadata 不足は 503               | policy endpoint + provider tests    |
| DEPLOY-01     | Scan build                    | `apps/scan-web/dist` だけを Scan project へ                | `grimodex-scan[-staging]` | Editor project を上書きしない                 | 既存 Scan SW は Scan origin のみ  | deploy plan test                    |
| DEPLOY-02     | root Editor build             | `dist` + Editor Pages config                               | `grimodex-try[-staging]`  | `/editor` SPA fallback、Scan asset なし       | deploy 前 local verify            | deploy / SW tests                   |
| CORS-01       | Scan / Editor origins         | route-aware exact allowlist                                | Scan Worker               | wildcard 不可、credentials/header 最小化      | dev origins は別 env              | preflight / denial tests            |
| UI-01         | Scan upload / report          | 本体 token、font、logo、surface に同期                     | Scan Pages                | 本体と同一ブランド、Scan固有導線は保持        | reduced motion / 390px            | visual / a11y tests                 |

## AI 開示の出力契約

Worker または provider registry が返す開示は、少なくとも次を含む。

```ts
interface AiDataDisclosure {
  policyVersion: string;
  route: "scan" | "hosted-editor" | "byok";
  providerId: string;
  providerName: string;
  sentData: string[];
  processors: string[];
  processingLocations: string[];
  appStorage: Array<{ location: string; retention: string }>;
  providerRetention: string;
  trainingUse: "no" | "yes" | "depends";
  deletion: string;
  policyUrls: string[];
}
```

UI はこの全項目を表示し、`policyVersion + route + providerId`
への同意を保存する。開示が取得できない、または必須値が空の場合は
`[precheck]` として upload / AI request を発行しない。

## 品質追跡

- 新規 requirement: `GDX-AI-CONSENT-001`
- 関連 Iron Laws: `GDX-PRECHECK-001`, `GDX-POLICY-001`, `GDX-ROUTE-001`,
  `GDX-TRACE-001`
- Light: consent contract、AI routing、Scan Worker router/repository、BrowserMock DB、deploy plan、SW
- Heavy: 実 Hosted provider、Scan -> Editor -> reload、Hosted/BYOK stream/cancel
- Hosted の資格情報と隔離された test account がない環境で Heavy を passed にしない。
