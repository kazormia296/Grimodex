# ④ SP-P4 の診断（IR の経路の短縮を入れた新しい候補での試行 1、run `sp-p4-s5r3-1`）の記録

2026-10-31（UTC）に integrator が実行した、CP-4 の ④ SP-P4。候補は、IR の経路の短縮（DR-CP4-V-1、#768）を入れた master の `0b1984dd`。ユーザーが「製品側で IR の経路を短くする」を確認した（`user-confirmation-2026-10-31-sp-p4-retake.md` の追記、`69603d64`）。**Graph の arm は動かしていない**。

## 結果

- **status: passed**（`summary.id` SP-P4、`stop: null`、`problems: []`）。比べた 8 variant（G-01/v1、G-02/base、G-03/base、G-04/base、G-05/base、G-06/base、G-07/base、G-08/base-usable）はすべて `same: true`、差異 0。
- 比較の規則・上限・warm-up・measured は前の 2 回と同じ（`ir-complete-pairs`、側ごとの上限 6、組の上限 6、warm-up 5、measured 30、`attemptLimit` 2、`d2aMode` restricted、`compareBy` logical-id）。S2・S4b'・harness・上限・D は変えていない。
- **IR の期限切れは measured 480 件（8 variant × 2 側 × 30）のうち 0 件**（すべての側で 0/30）。IR が ready でなかった measured sample も 0 件。warm-up では G-06/base の with 側に 1 件（1/5）だけ not-ready があった（warm-up は比べない）。
- 受領書 `sp-p4-receipt.json` の sha256 `b0a0e3d2c6e31e85ce9371a0bf7ab6941f278fabcede0771a3186a3cda75b1a4`。

## 台帳と実行

- 台帳 `attempts/sp-p4-s5r3-1.json`: key `sp-p4:9f52e7da37b84603424d0b7e6ecee8e019d1c7c9:0b1984dd68ec132aea394664e2ba61759e1e2830`、`attempt: 1`、status `completed`。開始時の sha256 `f6889306223e110d5d9ad14bb03d0c88acf0fcee1081c59576d7346dacc5e17b`（contracts の `770ec4aa`）、終了後 `79f36ef5d24eb1d5a3251d0057e7053bd2ba9fc2a0c671990dc6bfd770c7e99a`。
- **この試行は、新しい候補（key が別）の試行 1**。前の 2 回（`sp-p4-s5r-1`、候補 `94bb9b83`／`sp-p4-s5r2-1`、候補 `ed8e3fb9`）はどちらも C2 で停止し、開示に残してある。この読み（候補が変わったので新しい試行 1）は DR-CP4-V-1 と上のユーザー確認の追記に記録済みで、前の候補で 3 回目を取ったのではない。
- 実行: command 開始 2026-10-31T11:06:34Z、台帳の開始 11:14:43Z（分岐の setup の後）、終了 11:16:41Z。

## 候補

- 候補: `0b1984dd68ec132aea394664e2ba61759e1e2830`（master の squash 〔#768〕。tree `900ba98bd43b38fb668df1f557276b789d3ed13b`、clean）。master の Full（run `41189853205`、headSha 一致）は success（全 8 job）。
- 前回の候補 `ed8e3fb9` との差は 4 つの PR：#768（IR の経路の短縮。`nir1_chronicle_index/{canonical,publish,query,read_identity,runtime,test_support}.rs`、`query_context_reuse_tests.rs`、`related_scenes/begin.rs`、`nir1_graph_deferred_tests.rs`、`cp4-decisions.md`）、#765（`grimodex-db/src/migrate.rs`、`WorkspaceViewHost.tsx`、`recovery/RecoveryShell.tsx`、`en.json`／`ja.json`）、#766（`ZenMultipassCanvas`）、#767（`EditorWorkspaceHeader.tsx`、`WorkspaceMenu.tsx`）。`git diff --stat ed8e3fb9 0b1984dd` は 21 file。S2 の bytes の pin に製品 file は無いので、S4b' `9f52e7da` の admission は同じ記録で通る（`verify-admit.mjs`：admits OK、旧 S4b `b7d74950` は拒否）。
- 標準 build の受領書 sha256 `c181aab2d758b461e9929184e07b7c40667f70c764ec1935f119d0996056e0fd`、評価 build の `eval-build.json` の sha256 `0066c8df0f26ec3e293a52984fab67518258facf816cdc93985f92162ab7a09a`（`sourceUnchanged: true`、tree は候補と同じ）。13 の完全な setup（run 名 `s5r3-*`、2026-10-31T09:52:19Z〜10:00:58Z）は 13/13 `setup-complete`。受領書の sha256 は `setup-receipts.sha256`。

## IR の期限切れ（4 つの run の比較）

measured 30 件のうち、IR が期限切れで外れた数。`-` は without 側、`+` は with 側。`sp-p4-1`、`sp-p4-s5r-1`、`sp-p4-s5r2-1` の行は `sp-p4-s5r2-1/README.md` から写した。

| run | G-01 | G-02 | G-03 | G-04 | G-05 | G-06 | G-07 | G-08 usable |
|---|---|---|---|---|---|---|---|---|
| `sp-p4-1`（旧 S4b、候補 `5ce12211`、passed） | 0, 1 | 0, 1 | 1, 2 | **5**, 0 | 0, 0 | 0, **5** | 0, 0 | 0, 0 |
| `sp-p4-s5r-1`（試行 1、`94bb9b83`、停止） | 1, 0 | 1, 1 | **7**, 未測定 | 未測定 | 未測定 | 未測定 | 未測定 | 未測定 |
| `sp-p4-s5r2-1`（試行 2、`ed8e3fb9`、停止） | 0, 0 | 1, 0 | 1, 2 | 2, 2 | 1, 0 | **6, 7** | 未測定 | 未測定 |
| **`sp-p4-s5r3-1`（新候補の試行 1、`0b1984dd`、passed）** | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 |

- 旧候補の 3 回では measured 990 件のうち 47 件（4.7%）、新候補では 480 件のうち 0 件。調査での dev の交互測定（DEV-SHAPE-G06 base、期限切れ 60/174 → 1/280、IR の到着 中央値／p90 10.90／11.40 ms → 6.50／7.20 ms）と向きが合う。
- **この 1 回だけでは、対策の効果の確定にはならない**。この run は、機械が静かな状況（開始前の `wait-quiet.sh` が 3 回連続の静けさを確認、load average 0.06、ユーザーはブラウザを開いていない）で取った。旧 passed（`sp-p4-1`）も静かな時間帯だった。対策の根拠は dev の before/after の交互測定（DR-CP4-V-1）で、この run は「静かな状況で C2 に触れなかった」ことを示す。忙しい時間帯の率は測っていない。
- R の membership と順位、denseHits、sparse は、全 variant の全 sample で比べて一致した。**seed の pin の段の影響は観測されていない**。
- 測定の間の他の process：この run は窓の sampler を持たず、測定中に他の process が起動したかの記録は無い。開始前の静けさの検査は通っている。他の Claude の session が `gh run watch`（待機だけ）を持っていた。
- 後始末：run の後に `/tmp/.X11-unix` は X0・X1 のみ、Xvfb と electron の残りは無い。

## 次

- ⑤ Graph arm：parity（完了した 1 回だけ）→ Gold（13 variant、`--keep-test-worktree` 必須、`--sp-p4-receipt` にこの受領書）→ negative（K24-G01-N2／N3／N4）→ trace。運用条件：正式の run は `--prep-commit 9f52e7da…` と `294ee35f` を祖先に持つ候補だけ。
- 未測定の製品側のリスク（DR-CP4-V-1 の注記）：seed 付き request（Graph）の `stamp0_missing` と K6/4 の前後、cold で大きい project。Graph arm の観測で確かめる。
