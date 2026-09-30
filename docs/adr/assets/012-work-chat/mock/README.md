# ADR 012 — Work Layer HTML mock

ADR 012の検討に使用したDesign Component形式のHTMLモック。
旧プロトタイプの参照資料であり、最終UI仕様やruntime実装の証拠ではない。

## 開き方

- `prototype.dc.html`: 操作可能なWork Layerプロトタイプ。
- `ui-study.dc.html`: 各状態を並べたUI検討キャンバス。
- `WorkLayerFrame.dc.html`: 共通Frameコンポーネント単体。

上記HTMLはブラウザで直接開ける。Reactは`support.js`がCDNから取得するため、初回表示には
ネットワーク接続が必要。モック本体と画像はリポジトリ内に保持する。

## `file://`対応

元の書き出しでは、`support.js`が起動中のHTMLと`WorkLayerFrame.dc.html`を`fetch()`していた。
ブラウザは個々の`file:` URLを別のopaque originとして扱うため、ローカルで直接開くとCORSで失敗した。

この保存版では次の変更だけを加えている。

- `resources.js`が`WorkLayerFrame.dc.html`をBlob resourceとして事前登録する。
- `window.__resources`を初期化し、runtimeによる起動HTMLの不要な再fetchを抑止する。
- UI・状態遷移・表示文言は変更しない。

`resources.js`は`WorkLayerFrame.dc.html`から生成した同梱物である。Frameを編集した場合は、
resource bundleも同じ内容へ更新すること。

## ファイル

- `support.js`: Design Component runtime。
- `resources.js`: `file://`向けの同梱Frame resource。
- `source-notes.md`: 元モックに含まれていた参照元メモ。
- `uploads/`: 元モックに同梱されていた参照画像。

