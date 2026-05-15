# Grimodex Landing Page

GitHub Pages から配信される Grimodex の LP です。実体は **`docs/lp/`** 配下にあり、エントリは **`index.html`** → **`assets/lp-app.js`**（Vite でプリビルドした React バンドル）です。

## 公開設定

GitHub リポジトリの **Settings → Pages** で以下を設定：

- **Source**: `Deploy from a branch`
- **Branch**: `main`（または公開用ブランチ）
- **Folder**: `/docs`

**Document root が `docs/` のとき**、`docs/lp/index.html` は次のような URL になります。

- `https://<owner>.github.io/<repo>/lp/`
- `https://<owner>.github.io/<repo>/lp/index.html`

リポジトリルートだけで LP を出したい場合は、`docs/index.html` から `lp/` へリダイレクトするなど、ルート側の用意が別途必要です。

## 独自ドメインを使う場合

1. Pages の公開ルート（多くは `docs/` または `docs/lp/` に合わせた配置）に `CNAME` を置き、1 行目にドメインを書く（例：`grimodex.app`）
2. ドメインの DNS で `CNAME` レコードを `<owner>.github.io.` に向ける（または A レコードを `185.199.108.153` など 4 つ）
3. Settings → Pages の Custom domain にドメインを入れて Enforce HTTPS にチェック

## ファイル構成

```
docs/lp/
├── index.html           ← エントリ（`assets/lp-app.js` を読み込み）
├── build-lp.mjs         ← JSX を結合して Vite ビルド → assets/lp-app.js
├── serve-lp.mjs         ← ローカルプレビュー用の静的サーバー
├── assets/
│   ├── lp-app.js        ← ビルド出力（生成物）
│   └── grimodex-logo.svg
├── lp-variants.jsx      ← COPY / Reveal / PanelMock / PanelMiniMock など共通部
├── lp-clean.jsx         ← D〜F 案 + _Rev2
└── lp-variant-h.jsx     ← H 案（Swiss × Zine）本体（現行はこれをルートにマウント）
```

`build-lp.mjs` は `lp-variants.jsx` の先頭〜 Variant A 直前、`lp-clean.jsx` の先頭〜 D 案直前、`lp-variant-h.jsx` 全文を結合してエントリを生成しています。`lp-variants.jsx` には A 案などほかのバリアントのソースもあります。表示する画面は `build-lp.mjs` の `App` 内のコンポーネントを差し替えれば切り替えられます。

## アクセントカラーの変更

`index.html` の `:root { --hz-hl: #fff200 }` を書き換えるだけで、ハイライト・ボタン・各種アクセントが連動して変わります。

候補：

- `#fff200` ジン・イエロー（デフォルト）
- `#39ff14` アシッドグリーン（IDE 寄り）
- `#ff5f1f` バーントオレンジ（雑誌寄り）
- `#3b6cff` クライン・ブルー
- `#ff2d6f` ホットピンク

## ローカルプレビュー

`*.jsx` を編集したあとは、必ずビルドしてからプレビューしてください。

```sh
cd docs/lp
node build-lp.mjs
node serve-lp.mjs
```

ターミナルに表示される **`http://localhost:8765/index.html`** を開きます。ポートは `PORT` で変更できます（例: `PORT=3000 node serve-lp.mjs`）。

**別の HTTP サーバーでも可**（ビルド済みであること）:

```sh
cd docs/lp
python3 -m http.server 8000
# → http://localhost:8000/index.html
```

## 本番化メモ

- JSX を変更したら **`node build-lp.mjs` を実行**し、生成された `assets/lp-app.js` をコミットする運用です（ブラウザ上の Babel 実行には依存していません）。
- SEO・OGP・サイトマップを一箇所で整えたくなったら、Astro 等への移行も選択肢です。
