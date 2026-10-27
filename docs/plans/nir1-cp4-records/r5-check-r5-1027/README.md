# ① R5 の照合の run の記録（run `r5-1027`）

2026-10-27 に integrator が実行した、K6/4 の R5（G-case の seed の pin の照合。K6/4 の凍結の前の前提）の記録。**Graph の arm、R／IR の query、評価の run、診断、trace、V-10 の probe は起動していない**（`r5Gate.exempt` の範囲。seed の pin の段と SP-P2 の記録まで）。この workspace は ④⑤ に使わない（捨てる）。

## 結果

- status: **match**（gate: **match**）。13 variant すべてで setup は `setup-through-seed-pin`、SP-P1 は match。
- 検証: `node scripts/quality/nir1-graph-eval/r5-check-runner.mjs --verify` → `verified: true`、記録の sha256 `4230ba3be42564087a65565c1504940a3922c55a3a28be0fccdb33e5314bd5ce`（検証器が返す値）、run ID `7ad99f81-fb68-48cb-9d57-7433db9b825b`、候補の commit `7a2669ead5262cc1a1126a7ab52bf808afeb98ff`、tree `003714c067e6f45091d73d6c7ce1dfecb3c23254`、worktree は clean。
- この commit の `r5-check-record.json` の file sha256: `4230ba3be42564087a65565c1504940a3922c55a3a28be0fccdb33e5314bd5ce`。

## 候補と build

- 候補: origin/master `7a2669ea`（#745 の squash。K6/4 の道具 P1〜P4 と #744 を含む）。clean な worktree（detach）。
- 製品の標準 build（`scripts/quality/nir1-retrieval/standard-build.mjs`）。build の後の sha256 が受領書の `artifacts` と一致:
  - `electron/native/grimodex-node/grimodex-node.node` `07a188878c082579e584aacceae8b47d8da007a449870afa17afa0aff8a3c9e2`
  - `dist-electron/main.cjs` `772b218009509fe34b040f6d32e2e737d2ec305b106cc12910a7718decc83761`
  - `dist-electron/preload.cjs` `9c37d32af100699a97fbd8ce068fb273f5e9387d9155cc471173add03ca489a8`
  - `dist/index.html` `c632018d50c59c285a73b9aa8782c9a981056f845162fdbfada8c6aa35c560aa`
- 固定した model（manifest の sha256 と一致を `prepareEvalProfile` が確かめる）: ja `ruri-v3-30m/model_int8.onnx`、en `bge-small-en-v15/model_int8.onnx`。

## 先に行った 1 variant の確認（別の run `r5pre`、G-02/base）

`setup-through-seed-pin`、`errors` 空、session の `problems` 空。実行後のプロセス（Xvfb、electron）と `/tmp/.X11-unix` は実行前と同じ。

## variant ごとの結果

| case | variant | setup | SP-P1 | cold DB sha256 | 受領書の sha256 |
|---|---|---|---|---|---|
| G-01 | v1 | setup-through-seed-pin | match | `dea84f6b332ebf4e…` | `b22f5c31ae5d0dba…` |
| G-02 | base | setup-through-seed-pin | match | `ce3dee197c9493e3…` | `61e92a4b21d5c916…` |
| G-03 | base | setup-through-seed-pin | match | `30b59c720ce3cccc…` | `0f6e24ab21890508…` |
| G-03 | frontier-exceeded | setup-through-seed-pin | match | `d6bb325380d5f216…` | `2149809186a9934a…` |
| G-04 | base | setup-through-seed-pin | match | `1ea3435add6c802f…` | `a3fb4b280d8bed8e…` |
| G-05 | base | setup-through-seed-pin | match | `6fc4e271cd80c561…` | `dc9821f9cf5f3530…` |
| G-06 | base | setup-through-seed-pin | match | `6012350fbac159e4…` | `d788ad3c476e9d18…` |
| G-07 | base | setup-through-seed-pin | match | `5dd0f10a92c9b73b…` | `117d5164ba633524…` |
| G-08 | base-usable | setup-through-seed-pin | match | `79e04f791a34e921…` | `bf1232b50650e95f…` |
| G-08 | graph-index-unusable | setup-through-seed-pin | match | `99d350aee4a9e6f9…` | `99303b2b158bcb77…` |
| G-08 | graph-recovered | setup-through-seed-pin | match | `277ce3cec23521b8…` | `2c0db4614c2d5f8f…` |
| G-08 | chronicle-index-unusable | setup-through-seed-pin | match | `aa97a2a3d4131c1b…` | `65838d0c6ac0c52d…` |
| G-08 | both-indexes-unusable | setup-through-seed-pin | match | `c4a0a26afa6e2248…` | `f5105de65afb4eec…` |

受領書の本体は `receipts/<case>__<variant>.setup-receipt.json`。cold DB（約 1.1 GB）は repo に置かず、integrator の worktree（`.artifacts/cp4/r5-1027/`）に K6/4 の凍結の記録を push するまで残す（`workspace.retainUntil: k64-freeze-record-pushed`）。

## 実行環境と副作用

- `scripts/local-ci-xvfb.mjs` を host の namespace で実行。`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`、`DBUS_SESSION_BUS_ADDRESS`、`WAYLAND_SOCKET`、proxy 変数を除去。短い TMPDIR（`/tmp/gr5`）。
- 実行前に CP-4 の測定、cargo、vitest が動いていないことを確かめた。残っていたのは利用者の Obsidian の Electron と IDE の `node --test` の待機プロセスだけ（CP-4 の測定ではない）。
- 実行後: 新しい Xvfb／electron のプロセスは残っていない。`/tmp/.X11-unix` は X0、X1 のまま（実行前と同じ）。`/tmp/gr5` は空。作業木は clean。
- Xvfb の起動で `_XSERVTransMakeAllCOTSServerListeners: server already running` が出た。既に使われている display 番号を避けて空き番号を取る通常の動作で、利用者の X0、X1 には触れていない。
