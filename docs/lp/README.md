# Grimodex Landing Page

GitHub Pages から配信される Grimodex の LP です。

## 公開設定

GitHub リポジトリの **Settings → Pages** で以下を設定：

- **Source**: `Deploy from a branch`
- **Branch**: `main`
- **Folder**: `/docs`

数十秒後に `https://<owner>.github.io/grimodex/` で公開されます。

## 独自ドメインを使う場合

1. このフォルダに `CNAME` ファイルを作って、1 行目にドメインを書く（例：`grimodex.app`）
2. ドメインの DNS で `CNAME` レコードを `<owner>.github.io.` に向ける（または A レコードを `185.199.108.153` など 4 つ）
3. Settings → Pages の Custom domain にドメインを入れて Enforce HTTPS にチェック

## ファイル構成

```
docs/
├── index.html            ← エントリポイント
├── lp-variants.jsx       ← 共通: COPY / Reveal / PanelMock
├── lp-clean.jsx          ← _Rev2 (intersection observer reveal)
└── lp-variant-h.jsx      ← H 案 (Swiss × Zine) 本体
```

## アクセントカラーの変更

`index.html` の `:root { --hz-hl: #fff200 }` を書き換えるだけで、ハイライト・ボタン・各種アクセントが全部変わります。

候補：

- `#fff200` ジン・イエロー（デフォルト）
- `#39ff14` アシッドグリーン（IDE 寄り）
- `#ff5f1f` バーントオレンジ（雑誌寄り）
- `#3b6cff` クライン・ブルー
- `#ff2d6f` ホットピンク

## ローカルプレビュー

```sh
cd docs
python3 -m http.server 8000
# → http://localhost:8000
```

## 将来の本番化メモ

現在は **Babel をブラウザで実行**しているので、初回ロードに 1-2 秒かかります。気になるようなら、

- Vite で React をプリビルド → `docs/assets/*.js` に出力
- または Astro に書き直す（SEO・OGP・サイトマップが整う）

のどちらかへ移行できます。
