# chat IR の S2 予備測定・段 0（埋め込みの依存の install と受入れ）と段 1（count_tokens の prefix）の記録（2026-11-18）

- 根拠：`user-confirmation-2026-11-17-s2-gold-and-embed-deps.md`（Q10：npm の registry に接続し、版を固定し、`--ignore-scripts` で、repo の外の固定の場所〔/tmp 以外〕に入れる。統合者が直接実行する）。
- 手順の正本：`fusion-eval-data/ir-chat-pilot-2026-11/s2-preflight-2026-11-18/plan.md` の §2・§9 の 1〜7。
- 実行者：統合者（Claude Code の統合者セッション）。日時：2026-11-18 03:10〜03:14Z。
- 段 0 では API の呼び出しはしていない。段 1（count_tokens、課金なし）は §6。段 2 は未実施（順序の条件は plan §4）。
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
- **cosine の最小値 0.99896、平均 0.99984（基準 0.998 以上）→ 先頭 30 件では pass。**（全件では基準を割った。§7） dim 256、statement_digest の不一致 0。Node v24.18.0。
- 1.24.3 では 1.0 に近いと見込んでいた（plan §0 の 3）が、最小値は 0.9990 だった。保存済みの vector（製品の Rust ort 1.24.2）との差は小さいが、完全一致ではない。原因は切り分けていない（tokenizer の経路の差などがありうる）。基準は満たすので、段 0 は完了とする。
- 記録：`s2-preflight-2026-11-18/records/embed-smoke-20261118T031402Z.json`（sha256 `ceefed41…70189`）。

## 5 次

- 段 1（count_tokens の prefix だけ）の順序の条件の (a)「9 回目の S4 の PR の merge」は満たされている（S4b `70a07561` は origin/master の祖先。PR #923 で merge）。(b)「CP-4 の run が無いとき」は、実行の直前に guard が確かめる。
- origin/master は `5d09b3c4`（#936・#937 の後）に進んだ。段 1 の前に、plan §3.2 の製品 file の検査（snapshot の基点との差）を取り直す。
- 段 1 は実送信（場面 p の本文と Gold の質問）を伴う。plan §10 の 1（6 問の選び方の食い違い）は未決。

## 6 段 1（count_tokens の prefix だけ。2026-11-18 03:17Z。課金 $0）

- 6 問はユーザー決定（`user-confirmation-2026-11-18-s2-preflight-question-selection.md`）の `per-point-EMN`。model は `claude-sonnet-5-5`、送信先は `api.anthropic.com` の `messages/count_tokens` だけ。key は製品の keyring（safeStorage）から取り、値は記録していない。
- 送ったもの：製品の tools の定義（T813 の arm）、system の cacheSegments（場面 p の本文を含む）、Gold の 6 問の質問文。volatile tail は dry-run の stub（97 字）で、測っていない。
- 材料：dry-run の snapshot（head `97f89fb1`）。製品 file（toolDefinitions／toolManifest／agentSettingCatalog／uiOperationTools／agent-tool-manifest.json／contextBuilder／src/prompts）は origin/master `5d09b3c4` まで差分なし。
- CP-4 の run の guard（`pgrep -f "[c]p4-"`）は、1 回目に統合者の bash の command line（electron の path の文字列）に自己一致して止まった。実際の run は無かった。path を symlink 経由にして回した。guard は弱めていない。

| 質問 | P＝noTail−bare | tools | cacheSegments |
|---|---|---|---|
| p050-E1・M1・N1 | 15,483 | 11,931 | 3,552 |
| p100-E1・M1・N1 | 15,966 | 11,931 | 4,035 |

- **P の中央値は 15,724.5 token。** q1 §3.1 の見積り（12K、幅 9〜20K）の幅の中で、中央より高い側。tools が約 76％を占める。
- 質問の型による差は、user の message の長さ（73〜99 token）だけ。P は point で決まる。
- 記録：`s2-preflight-2026-11-18/records/20261118T031754Z-count/count.json`（sha256 `ce959f19…1922ba7a`、本文なし）。
- 段 2（Haiku の反復・volatile tail・往復数 N）は、抽出・段 E・段 F の後。今は材料が無い。

## 7 訂正：全件では受入れの基準を割る（2026-11-18 03:43Z。network なし）

- §4 の受入れは**先頭 30 件だけ**で、全 884 件では確かめていなかった。点検（Fable）の指摘で、全件を同じ経路で埋め込み直した（`05-score-fidelity.mjs`）。
- **cosine の最小 0.99769。0.998 未満が 3 件、0.999 未満が 66 件**（中央値 0.9999996、平均 0.99973）。§4 の「pass」は先頭 30 件の範囲に限る。**全件では基準を満たさない。**
- 長さとの相関は −0.06 で、切り詰めとは関係しない見込み（statement の字数は最大 242）。原因は切り分けていない。
- **score への効き**（製品の query の vector は保存されていないので、document の対 390,286 組で代理に測った）：
  - 片側だけ Node（harness は query だけを Node で作る形）：差の p99 0.0050、p99.9 0.0082、**最大 0.0138**。
  - 両側とも Node：p99 0.0064、最大 0.0172。
- **τ の候補の間隔は 0.01。0.998 の基準は、この間隔に対しては検証されていなかった。** 大半の対の差は 0.005 未満だが、最大は間隔を超える。境目の近くの hit の出入りが製品と違いうる。
- 扱い：**S2 の第 1 段の凍結の前に決める事項**に入れる（原因の切り分け、または限界 L9 への明記。決めるまで段 0 は「先頭 30 件で受入れ、全件では基準未満」とする）。
- 記録：`s2-preflight-2026-11-18/records/score-fidelity-20261118T034345Z.json`（sha256 `3825e9fc…f1938184`、本文なし）。
