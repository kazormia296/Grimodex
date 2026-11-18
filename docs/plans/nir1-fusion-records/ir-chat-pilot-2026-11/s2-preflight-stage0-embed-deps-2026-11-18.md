# chat IR の S2 予備測定・段 0（埋め込みの依存の install と受入れ）の記録（2026-11-18）

- 根拠：`user-confirmation-2026-11-17-s2-gold-and-embed-deps.md`（Q10：npm の registry に接続し、版を固定し、`--ignore-scripts` で、repo の外の固定の場所〔/tmp 以外〕に入れる。統合者が直接実行する）。
- 手順の正本：`fusion-eval-data/ir-chat-pilot-2026-11/s2-preflight-2026-11-18/plan.md` の §2・§9 の 1〜7。
- 実行者：統合者（Claude Code の統合者セッション）。日時：2026-11-18 03:10〜03:14Z。
- **API の呼び出しはしていない。** 段 1（count_tokens）・段 2 は未実施（順序の条件は plan §3.2・§4）。
- 送信先・閾値・保存範囲・総額は変えていない。本文は記録に入れていない。

## 1 GDX-PRECHECK-001：external-egress の行

| 項目 | 内容 |
|---|---|
| 接続先 | `registry.npmjs.org` だけ（metadata の `npm view` と tarball の取得）。lock の resolved は全件 `registry.npmjs.org`（`registryHostOnly: true`） |
| 送ったもの | package 名と版の問い合わせだけ。`--no-audit`・`--no-fund`・`--update-notifier=false`、user／global の npmrc は空 |
| install script | 走らせていない（`--ignore-scripts`）。`onnxruntime-node@1.24.3` の postinstall（`node ./script/install`。script の中に github.com の参照あり）と `protobufjs@7.6.6` の postinstall は未実行。Linux x64 の native binary（`libonnxruntime.so.1`、`onnxruntime_binding.node`）は tarball に含まれていて、postinstall なしで動いた |
| 置き場 | `/home/grimodex/fusion-eval-data/ir-chat-pilot-2026-11/embed-deps/`（repo の外、/tmp 以外） |

## 2 版と integrity

| package | 版 | integrity（registry の metadata と lock が一致） |
|---|---|---|
| `@huggingface/transformers` | 4.3.2 | `sha512-V3+dqf3iWlRYJ9I9GreM3zGQd0lAXnnoPeddmkOQYWAEE4l/+Fi6p7tx/qVUJlKQgLXGim2W76rTOzz+eC0i7g==` |
| `onnxruntime-node` | 1.24.3（1 個だけ） | `sha512-JH7+czbc8ALA819vlTgcV+Q214/+VjGeBHDjX81+ZCD0PCVCIFGFNtT0V4sXG/1JXypKPgScQcB3ij/hk3YnTg==` |

- package 数 76。`package.json` sha256 `7ccf13fa…36ee8`、`package-lock.json` sha256 `c63f34c9…3d2cb4`、`INSTALL-RECORD.json` sha256 `0bfaeb1d…127ca`。

## 3 計画からの差（統合者の判断）

1. **onnxruntime-node を overrides で 1 個に寄せた。**
   - transformers 4.3.2 は onnxruntime-node 1.30.0 を pin している。1 回目の install では 2 個（top-level の 1.24.3、nested の 1.30.0）入り、受入れで落ちた（`libonnxruntime.so.1: version 'VERS_1.30.0' not found`。同じ soname の library を 2 つの binding が共有するため）。
   - `package.json` の `overrides: {"onnxruntime-node": "1.24.3"}` で入れ直した。**版を増やしていない**（承認の対象の 1.24.3 だけ。1.30.0 は入っていない）。transformers は tokenizer にだけ使う。
   - 1 回目の dir は `embed-deps-two-copies-failed/` に残した（使わない）。
2. **npm の設定の引数**：`--globalconfig=/dev/null` は、npm が user と global に同じ path を受けず起動しなかった。global は空の file（`embed-deps/empty-globalrc`）に替えた。接続先は変わらない。
3. **tokenizer**：model の dir に `tokenizer_config.json` が無く、初期化で落ちた（plan §3.3 の想定どおり）。`stage-embed-model.mjs` で staging（model sha `946ae837…10bcf`、`tokenizer.json` sha `0a94ac9a…1d062`。tokenizer 一式は origin/master の `src-tauri/resources/semantic/ruri-v3-30m`）を作り、`EMBED_MODEL_DIR` で渡した。code は変えていない。

## 4 受入れ（数値の golden。network なし）

- 第 6 版 g-ja-1 の DB の event 先頭 30 件を、harness と同じ経路で埋め込み直し、保存済みの vector と比べた。
- **cosine の最小値 0.99896、平均 0.99984（基準 0.998 以上）→ pass。** dim 256、statement_digest の不一致 0。Node v24.18.0。
- 1.24.3 では 1.0 に近いと見込んでいた（plan §0 の 3）が、最小値は 0.9990 だった。保存済みの vector（製品の Rust ort 1.24.2）との差は小さいが、完全一致ではない。原因は切り分けていない（tokenizer の経路の差などがありうる）。基準は満たすので、段 0 は完了とする。
- 記録：`s2-preflight-2026-11-18/records/embed-smoke-20261118T031402Z.json`（sha256 `ceefed41…70189`）。

## 5 次

- 段 1（count_tokens の prefix だけ）の順序の条件の (a)「9 回目の S4 の PR の merge」は満たされている（S4b `70a07561` は origin/master の祖先。PR #923 で merge）。(b)「CP-4 の run が無いとき」は、実行の直前に guard が確かめる。
- origin/master は `5d09b3c4`（#936・#937 の後）に進んだ。段 1 の前に、plan §3.2 の製品 file の検査（snapshot の基点との差）を取り直す。
- 段 1 は実送信（場面 p の本文と Gold の質問）を伴う。plan §10 の 1（6 問の選び方の食い違い）は未決。
