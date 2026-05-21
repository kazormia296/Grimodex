# grimodex-lint

Grimodex の決定論的テキスト Linter コア。Tauri 本体と `grimodex-mcp`
バイナリから共有される。詳細な設計は `docs/Grimodex_Linter設計書.md`。

## Phase 2: UniDic 辞書の取得（初回セットアップ）

`lindera-unidic` の `build.rs` は初回ビルド時に
`https://Lindera.dev/unidic-mecab-2.1.2.tar.gz` (~140MB) をダウンロード
する。**CI ランナーなど外部 net が通る環境では自動でダウンロード**される
ので何もしなくてよい。

**ネットワーク制限のあるローカル環境**（例: 開発コンテナ）では、
辞書を手動で配置してビルド時に `LINDERA_DICTIONARIES_PATH` を渡す：

```bash
# 1. 別環境で辞書を取得（MD5: f4502a563e1da44747f61dcd2b269e35）
curl -L -o unidic-mecab-2.1.2.tar.gz \
     https://Lindera.dev/unidic-mecab-2.1.2.tar.gz

# 2. プロジェクトルート相対でキャッシュ配置
#    Layout: <cache_root>/<lindera-unidic_VERSION>/unidic-mecab-2.1.2.tar.gz
mkdir -p lindera-cache/3.0.7
mv unidic-mecab-2.1.2.tar.gz lindera-cache/3.0.7/

# 3. ビルド時に env で指す（cargo は存在チェックだけで再 DL しない）
LINDERA_DICTIONARIES_PATH=/absolute/path/to/lindera-cache \
  cargo build -p grimodex-lint
```

`lindera-cache/` は `.gitignore` に入っており、リポジトリには含めない。

## 補足

- `LINDERA_DICTIONARIES_PATH` のルートを指定すると、`<root>/<version>/<file>`
  の階層を見に行く。バージョンは `lindera-unidic` crate 側で決まる（現在
  `3.0.7`、`src-tauri/Cargo.lock` を参照）。
- 廃止予定の `LINDERA_CACHE` も使えるが、cargo の警告が出る。
