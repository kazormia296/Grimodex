# ① R5 の照合の run の記録の取り直し（run `r5-1102`、2026-11-02）

2026-11-01T15:24:57Z〜15:26:23Z（JST 2026-11-02 00:24）に integrator が実行した、K6/4 の R5（G-case の seed の pin の照合）の取り直し。**Graph の arm、R／IR の query、評価の run、診断、trace、V-10 の probe は起動していない**（`r5Gate.exempt` の範囲。seed の pin の段と SP-P2 の記録まで）。この workspace は ④⑤ に使わない（捨てる）。前の記録は `../r5-check-r5-1027/`（`21ed9a9c`）。

## 取り直した理由

G-04 fixture v2（案 C）の導入（枝 `claude/g04-v2c-fixture`）で、G-04 の setup が変わった（`g04-lio-landing` の IR 行を外し、Lio の pin を 1 件にした）。さらに ① の閉包（`r5-check-runner.mjs` の静的な import、43 file）の `constants.mjs` と `nir1-graph/contract.mjs` が変わった。`verifyR5CheckRecord` は v2 の plan で SP-P2 を計算し直すので、v1 の受領書は通らない。13 variant すべてを、枝の最終の commit で取り直した（S4b の前の独立レビュー：`g04-v2c-s4pre-review-2026-11-02/`）。**K6/4 :317 の順（R5 は K6/4 の凍結 `5dea38af` より前）は満たさない**。順の逸脱は開示して進めた（理由と、ユーザーに事前に確認していないこと〔就寝中〕は S2 の limits (i)、DR-CP4-S4-7）。

## 結果

- status: **match**（gate: **match**）。13 variant すべてで setup は `setup-through-seed-pin`、SP-P1 は match（pin は 1 件、seed が予定どおり）、SP-P2 は ok・findings 空。
- 検証: `node scripts/quality/nir1-graph-eval/r5-check-runner.mjs --verify` → `verified: true`、記録の sha256 `fa04baa444163b89d76beae467120366c5da55ca8e77a827eb597b06ad601f90`（この commit の `r5-check-record.json` の file sha256 も同じ）、run ID `8fb525ed-be32-4df4-8f92-1bffba4ca24d`、候補の commit `179139b4926a6ef249da78b56e581c2fd7c083de`、tree `2dadf4f6d3001636fc388f12bd5db2751c1fb25e`、worktree は clean。

## 候補と build

- 候補: 枝 `claude/g04-v2c-fixture` の `179139b4`（origin/master `8187fbfc` の子孫。X1-5〔#773〕を含む）。clean な worktree（detach、`claude-g04-cand`）。S4b''' はこの候補の子で、S2・freeze record・作者の宣言・DR・manifest の行だけを変える。
- 製品の標準 build（`scripts/quality/nir1-retrieval/standard-build.mjs`。cargo の target は温めてあったので増分）。build の後の sha256 が受領書の `artifacts` と一致:
  - `electron/native/grimodex-node/grimodex-node.node` `10d620c179411059b42c3ff0be9b61bc658bdd29788e49d24210b491c209f232`
  - `dist-electron/main.cjs` `31023f585fcdd080afe530a1e3b19a26e6812c0aa2ec35f33bf2c886db528278`
  - `dist-electron/preload.cjs` `9c37d32af100699a97fbd8ce068fb273f5e9387d9155cc471173add03ca489a8`
  - `dist/index.html` `330535d2d9f7485e714f11f7df381421604ad0e77c9838eda41afa79aa435e78`
- 固定した model（manifest の sha256 と一致を `prepareEvalProfile` が確かめる）: ja `ruri-v3-30m/model_int8.onnx`、en `bge-small-en-v15/model_int8.onnx`。
- 製品の受領書の sha256 `5e379a2f6e40ab13578eae7f6eb8f219a0012f3e6597482f27ff5a6624113c1e`。評価用の launch は dry run の admission（graph arm は not-activated）。

## variant ごとの結果

| case | variant | setup | SP-P1 | cold DB sha256 | 受領書の sha256 |
|---|---|---|---|---|---|
| G-01 | v1 | setup-through-seed-pin | match | `5e2656b1bc7a5cfa…` | `1efb5fc213985be8…` |
| G-02 | base | setup-through-seed-pin | match | `5659ea69f84ea458…` | `c6a7c442c793e57d…` |
| G-03 | base | setup-through-seed-pin | match | `b3b758f4d76f7d65…` | `3f7ff8cb16bd9d4d…` |
| G-03 | frontier-exceeded | setup-through-seed-pin | match | `6a0b0f6862ffc215…` | `f5f1d29ab7e46b0e…` |
| G-04 | base | setup-through-seed-pin | match | `62650bf1978f050b…` | `98761afd71c5073e…` |
| G-05 | base | setup-through-seed-pin | match | `82be1d4c3f6ddc4a…` | `ba8072286434f131…` |
| G-06 | base | setup-through-seed-pin | match | `cb04300f29b95d3b…` | `09a60af2e669495d…` |
| G-07 | base | setup-through-seed-pin | match | `33cf4d45191e8cc8…` | `4d74cd3d28e68936…` |
| G-08 | base-usable | setup-through-seed-pin | match | `4d06342adf9aafd3…` | `4bad67e879c84bee…` |
| G-08 | graph-index-unusable | setup-through-seed-pin | match | `418f2a25acfc54aa…` | `b765860f29bd0172…` |
| G-08 | graph-recovered | setup-through-seed-pin | match | `4f0d7a0a83cb70ca…` | `8cfabcc146651425…` |
| G-08 | chronicle-index-unusable | setup-through-seed-pin | match | `ca75dd5c1e164372…` | `1832bbb30db1bfa4…` |
| G-08 | both-indexes-unusable | setup-through-seed-pin | match | `0fec782118e84986…` | `0ccf048f3987f607…` |

受領書の本体は `receipts/<case>__<variant>.setup-receipt.json`。cold DB（約 1.1 GB）は repo に置かず、integrator の worktree（`claude-g04-cand` の `.artifacts/cp4/r5-1102/`）に S4b''' の記録を push するまで残す（`workspace.retainUntil: k64-freeze-record-pushed`）。

## 実行環境と副作用

- `scripts/local-ci-xvfb.mjs` を host の namespace で実行。`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`、`DBUS_SESSION_BUS_ADDRESS`、`WAYLAND_SOCKET`、proxy 変数を除去。`ELECTRON_OZONE_PLATFORM_HINT=x11`、短い TMPDIR（`/tmp/gr5`）。
- 実行前に `quiet-check` で CP-4 の測定、cargo、vitest が動いていないことを確かめた（`quiet`）。利用者は就寝中でマシンは静か。
- 実行後: 新しい Xvfb／electron のプロセスは残っていない。`/tmp/.X11-unix` は X0、X1 のまま（実行前と同じ）。作業木は clean。
