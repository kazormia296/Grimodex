# G-01 setup addendum v3 の独立コードレビューの記録（2026-11-03。integrator の要旨）

5 回目の S4（DR-CP4-S4-8。N2／N4 の封印待ちの修正）の G-01 setup addendum v3 の、凍結の前の独立コードレビュー。これは**独立コードレビュー**（実装と文書の差分の正しさ・緩和・迂回路を見るレビュー）で、S3 の独立レビューでも、fixture の独立期待値レビューでも、ユーザーの確認でもない。reviewer は Opus の subagent（read-only。Graph の runtime を実行せず、測定の受領書を読んでいない）。報告の本文は同じ directory の次の 2 file。

| file | SHA-256 | 内容 |
|---|---|---|
| `review-v3.md` | `89c738f24d0c9457fc0a8bce7cfc0e46f25c2a622a543ef72bd09e8dc73c016e` | 本レビュー（HEAD `0d456ee2` の worktree。v3 は `54b69bc2…` の版）。判定 (b) 修正してから受入れ可。P1 なし、P2×4、P3×8 |
| `review-v3-recheck.md` | `ba3224525eb6adb6055ffa4d41a42d2d17555e5a1f93a6e70e98eb32b1fe9522` | 修正差分の再確認（HEAD `7b128636`。v3 は `5578c526…` の版）。判定 (a) 受入れ可。任意の P3×3 |

## 経緯

1. v3 の草案 `e112d2dc`（`evals/nir1-g01/setup-addendum.v3.json`。v2 の写しで、mutation の後の B の封印の規則を述べる葉だけを変えた）と、path の向け直し `ee43c197` を、失効の commit `0d456ee2`（S4b'''〔`60bf9dc4`〕の freeze record を消し、S2 を `179139b4` の bytes に戻した）の後で review に出した。
2. 本レビュー（`review-v3.md`）：判定 (b)。P1 なし。P2：(1) DR-CP4-S4-8 (8) の開示の 5 つ目が `limits` に無い、(2) `measurementPointDefinition` の鍵が実装（Chronicle の build の後の再判定）と辺縁で食い違う、(3) `afterMutationReadings.status` が DR の変更を書いていない、(4) `limits (i)` の「入力の同一性」が範囲を広く読ませる。
3. integrator が P2 4 件と P3 のうち 6 件を直した（`7b128636`。v3 は `5578c526…`）。規則の本体（`sealPoints` の地点・`passes`・`unchangedRequires`・restore の地点）は変えていない。
4. 再確認（`review-v3-recheck.md`）：修正差分だけを見直し、判定 (a)。P2-1〜P2-4 は指摘どおり過不足なく直っている。任意の P3 が 3 件（(vii) の引用元と評価の語、(i) の括弧、静止の上限・間隔の値の形）。
5. integrator が任意の P3 3 件を直した（`38b464ea`。v3 は `cd1358cc44d1105c46e2368e49f4022134ff113529bde5fc539e2bdcccc5cc5a`）。変えた葉：`limits[0]`（括弧の位置）、`limits[6]`〔(vii)〕（引用元を a7027915 の「確認の範囲（integrator の読み）」の 1 と書き、評価の語を外す）、`sealPoints.bodyOnlySave.freshnessSettle` の `limit`／`interval`（名前だけにし、`limitMs: 60000`、`intervalMs: 250` を足す）。**この 3 件の直しを reviewer は見直していない**（再確認の文書が「直す場合は葉の目視と v2 への読み戻しで足り、再レビューは要らない」としたことに従った）。integrator が、v2 への読み戻しの一致（`true`）、`7b128636` の版からの変更が上の葉だけであること、値が `frozen-setup-driver.mjs:167-168` と一致することを確かめた。

## 凍結の後の v3

凍結は、v3 の `status` を `frozen-after-independent-review` にし、`review` の欄にこの記録（contracts の commit と上の SHA-256）を束縛する commit で行う。reviewer が読んだ bytes（`54b69bc2…`、`5578c526…`）と凍結する bytes は、`status`・`review`・上の 3 件の直しの葉で異なる。

## S2 追補 #12 の作業一覧に足したもの（本レビューの §6・§8 から）

- 3 file の pin の移し替え：`g01-negatives.mjs`・`g01-negative-preview.mjs`（`s5b-diagnostics-wiring` から）、`g01-negative-run.mjs`（`sp-p4-ir-timeout` から。paths が空になり ancestor）、`frozen-k64-admission.mjs`（`g4-b2b1-addendum-v2-paths` から）。移し忘れは S2 の試験では見つからず、正式の run の admission（`assertSourcePins`）で `[precheck]` になるので、3 file すべてが新しい pin にあることを試験で固定する。
- `observation-prep.mjs`：`OBSERVATION_PREP_FILES.setupAddendum`（:43）、header のコメント（:3）、`SETUP_ADDENDUM_ID`（:146）、`G01_RESEAL`（:1132-1138 と error 文 :1770-1772）、v1 の写しの連鎖（`SETUP_ADDENDUM_V1`、`SETUP_V1_COPY.readBack`、`supersededSetupAddendum`、`supersededReferences`）に v2 を束縛する定数と v3→v2 の readBack（**`reviewPlan` も戻す**）を足す。
- `observation-prep.v1.json`（S2）：`d1.addenda`、`diagnosticRuns[*].source`、`boundFiles`、`runnerHandoff`、`placeholders` の `S4:setup-addendum-commit` の `fill`（**本レビューが見つけた見落とし**）。
- `observation-prep.test.mjs`：`/3` を拒む試験を逆にする、v2 の写しの試験を履歴として残すか v3 版にするかの判断。
- `quality-manifest.yaml` に v3 の行。
- S4b'''' の freeze record の `boundFiles` が v3 の path を束縛すること。作者の宣言（S4a''''）に DR-CP4-S4-8 (8) の開示と、この読みの変更の revisions を書く。
