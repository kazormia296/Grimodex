# K6/6 の合成の検出の道具（K6/6 の harness の実装。2026-11-08）

`hook.mjs`、`register.mjs`、`run.mjs` は `../../k65-detection-2026-11-07/tools/` と同じ bytes（`hook.mjs` `e5732d01…`、`register.mjs` `5f651fff…`、`run.mjs`）。変異の当て方は同じで、変異の一覧・対象の試験・陽性の対照を引数にする。

- `mutations-k66.json`：K6/6 の first-render の下位条件ごとの変異 54 件。`followup.mjs` の `firstRenderOf` の検査を 1 か所ずつ外す（FR-1、R-6 の (a)(b)(c)、FR-3〜FR-7、N-d の `[artifact]`）、品質の FAIL の条件（変える点 6）の 4 条件と FAIL の分岐、見出しの窓外率（変える点 5）、`head.k66` の照合（receipt、admission。K6/6-N9）、品質判定 v2 D3 (d) の Revision の解決。`equivalent: true` の 2 件（`K66-FR3-revalidation`、`K66-6-contributed-joined`）は、置換しても判定が変わらない等価の変異で、試験が落ちないことが期待（理由は各行の `equivalentReason`）。
- `positive-k66.json`：陽性の対照（K6/6-P1〜P5、品質 v2 D2・D3 の pass、D3 (d)、K6/6 の集計。baseline で ok であること）。
- `count-n.mjs`：全体の TAP から K6/6-P1〜P5、K6/6-N1〜N13 の試験を、下位条件の記号（N2c、N5a …）ごとに数える。

使い方：

```
node run.mjs <候補の worktree> --mutations mutations-k66.json --targets followup.k66.test.mjs,outcome.test.mjs,receipt.test.mjs,admission.test.mjs,quality-verdict.test.mjs --positive positive-k66.json
node count-n.mjs <baseline-all.tap> <候補の worktree> --out counts.json
```

候補の file は書き換えない。変異は hook が読込み時に 1 か所だけ置換し（当たった数が 1 でなければ読込みを失敗させる）、その変異の試験 file だけを走らせる。

**期待の決め方（開示）**：`mutations-k66.json` の `expected`（落ちるべき試験の file・行・題の先頭）は、変異を当てる前に決めたものではない。K6/5 の前例と同じく、最初の run（`expected` が空）で落ちた試験を見て、各変異と落ちた試験の題が対応する（例：`K66-FR4-cacheHits` は「K6/6-N5a〜N5d」）ことを確かめた上で `expected` に写した。最初の run（候補 `1fdeed6f`）で、試験が落ちない変異が 6 件あった。対応は次のとおりで、取り直した run（候補 `dda975bc`）が記録の本体：
- `K66-FR3-not-joined`、`K66-FR3-edge-count`：FR-3 の合流・edgeCount の項目を単独で当てる試験（K6/6-N3d、N3e）を足した。
- `K66-6-contributed-outcome`、`K66-6-contributed-used`、`K66-6-contributed-edgeCount`：変異の試験 file の指定が `followup.k66.test.mjs` だったのを、品質の FAIL を見る `outcome.test.mjs` に直した。そのうえで「宣言が used でない」「outcome が graph-ready でない」を単独で破る試験を `outcome.test.mjs` に足した（edgeCount は既存の試験で落ちる）。
- `K66-FR3-revalidation`、`K66-6-contributed-joined`：試験を足さず等価の変異とした（`classifyJoin` が先に止める、`inWindow` が joined を含むため）。等価性は読みによる。

## 追補（レビュー指摘への対応。候補 `720509a7`）

- `mutations-k66-addendum.json`：N2c〜N2f（値ごと）、N5（block × key）、N8、N12c、(c) の区切り、品質判定 v2 の D3・D4 の変異 28 件（`run.mjs` の引数は `--mutations mutations-k66-addendum.json --targets followup.k66.test.mjs,quality-verdict.test.mjs`）。`expected` は最初の run（候補 `6342a02d`）の結果から写した（変異の前に決めていない）。等価の 1 件は `equivalentReason` に理由。
- `reasons-k66.json`：上の 54 件の変異が外した検査の理由 code。記録の「上の 54 件の変異の理由 code」の表の元。

## 追補 2（品質判定 v2 のコードレビュー指摘への対応。候補 `57c13dc5`）

- `mutations-k66-qv3.json`：品質判定 v2 の確定版の C1・C4〜C8、D2・D3（(1)〜(6)、(a)(b)）、D8 (b)、§0 の CLI（D7）の変異 35 件（`run.mjs` の引数は `--mutations mutations-k66-qv3.json --targets followup.k66.test.mjs,quality-verdict.test.mjs,quality-verdict-first-run.test.mjs --positive positive-k66-qv3.json`）。`expected` は結果から写した（変異の前に決めていない）。等価の 1 件は `equivalentReason`。
- `positive-k66-qv3.json`：追補 2 の陽性の対照（試験の行は候補 `57c13dc5` のもの）。

## 追補 3（再レビュー指摘への対応。候補 `99699dda`）

`mutations-k66-qv3.json` を 48 件にした（追補 2 の 35 件 + 再レビューの 13 件）。`--targets` に `pubg16-e2e-run.test.mjs` を足す（`followup.k66.test.mjs,quality-verdict.test.mjs,quality-verdict-first-run.test.mjs,pubg16-e2e-run.test.mjs`）。`positive-k66-qv3.json` は候補 `99699dda` の行に更新した。

## 7 回目の取り直し（候補 `f7e1fec1`。S3 の 9 回目の B1-3）

- 本体・追補・追補 2・3 の 3 組を同じ候補で取り直した（`results-k66-f7e1fec1.json`、`results-k66-addendum-f7e1fec1.json`、`results-k66-qv3-f7e1fec1.json`）。`run.mjs` の引数は上のとおり（追補は `--positive positive-k66-addendum.json` を渡した）。
- `mutations-k66.json` は 55 件：`K66-D3d-refused-skipped` の `find` を今の code に当て直し（prepare 以外の拒否も飛ばす変異）、旧意図（prepare の拒否の skip の除去）を `K66-D3d-prepare-skip-removed` として足した。`mutations-k66-addendum.json` は `K66-D3b-record-only-when-edges` の `find` を当て直した。`reasons-k66.json` に `K66-D3d-prepare-skip-removed` を足した。
- `expected` の書き換えは、行番号のずれ・後で足された試験が追加で落とす分・上の 2 件の `find` の当て直しの結果の写しだけで、題（`titlePrefix`）は変えていない。`positive-k66.json` の行は題で引いて直し、`positive-k66-addendum.json`（8 件）を足した。詳細は `../k66-synthetic-detection-record.md` の「7 回目の取り直しで変えたこと」。
