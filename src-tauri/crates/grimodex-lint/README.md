# grimodex-lint

Grimodex の決定論的テキスト Linter コア。Tauri 本体と `grimodex-mcp`
バイナリから共有される。詳細な設計は `docs/Grimodex_Linter設計書.md`。

## Phase 2: UniDic 辞書（ビルド前提）

`lindera-unidic`（`embed-unidic` feature）は UniDic 辞書を `include_bytes!`
で**コンパイル時に埋め込む**。辞書が無いと `cargo check` の段階で
`lindera-unidic` のコンパイルに失敗する。

`src-tauri/.cargo/config.toml` が `LINDERA_DICTIONARIES_PATH` をリポジトリ
直下の `lindera-cache/` に向けている。`build.rs` は
`lindera-cache/<lindera-unidic のバージョン>/` を辞書置き場として使い、
`unidic-mecab-2.1.2.tar.gz` がそこに在ればそれを展開し、無ければ
`https://Lindera.dev/unidic-mecab-2.1.2.tar.gz`（~140MB）を DL する。

バージョンは `src-tauri/Cargo.lock` の `lindera-unidic` を参照（現在 `3.0.7`）。
`lindera-cache/` は `.gitignore` 済み（~140MB）でリポジトリには含めない。

### CI

`Lindera.dev` は到達性が不安定なため、build.rs の自動 DL には頼らない。
`.github/workflows/ci.yml` の Rust ジョブが `lindera-cache/` を
`actions/cache` で保持し、キャッシュミス時のみ tarball を取得（MD5 検証
付き）する。一度成功すれば以後はキャッシュ再利用で外部 DL に依存しない。

### ローカル（ネットワーク制限環境・開発コンテナ等）

辞書 tarball を手動で配置すれば DL は走らない。`.cargo/config.toml` が
既に `lindera-cache/` を指しているので env を渡す必要はない：

```bash
# 別環境で辞書を取得（MD5: f4502a563e1da44747f61dcd2b269e35）
curl -L -o unidic-mecab-2.1.2.tar.gz \
     https://Lindera.dev/unidic-mecab-2.1.2.tar.gz

# Cargo.lock の lindera-unidic バージョンに合わせて配置
#   Layout: lindera-cache/<lindera-unidic_VERSION>/unidic-mecab-2.1.2.tar.gz
mkdir -p lindera-cache/3.0.7
mv unidic-mecab-2.1.2.tar.gz lindera-cache/3.0.7/

cargo check -p grimodex-lint   # 以降、辞書はキャッシュから再利用
```

別の場所に辞書を置きたい場合は `LINDERA_DICTIONARIES_PATH` を明示指定
すればよい（`.cargo/config.toml` は `force` を付けていないので、コマンド
側で渡した env が優先される）。廃止予定の `LINDERA_CACHE` も使えるが
cargo の警告が出る。
